import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Shared by the development scripts that drive a browser over CDP.

const execute = promisify(execFile);

export async function connect(url, timeoutMs = 10_000) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Set();
  let lastId = 0;
  let timer;

  await new Promise((settle, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`WebSocket handshake with ${url} did not finish within ${timeoutMs} ms.`));
      socket.close();
    }, timeoutMs);
    socket.addEventListener('open', settle, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Cannot reach ${url}.`)), {
      once: true,
    });
  }).finally(() => clearTimeout(timer));

  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);

    if (!request) {
      for (const listener of listeners) {
        listener(message);
      }

      return;
    }

    pending.delete(message.id);
    clearTimeout(request.timer);

    if (message.error) {
      request.reject(new Error(`${request.method}: ${message.error.message}`));
    } else {
      request.settle(message.result);
    }
  });

  function send(method, params = {}, sessionId = undefined, timeoutMs = 30_000) {
    return new Promise((settle, reject) => {
      const id = ++lastId;

      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);

      pending.set(id, { method, settle, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  // Returns the same shape as the desktop tab's `cdp` capability. By default,
  // browser-internal pages such as Chrome's new tab are ignored.
  async function attach(matches = (url) => !/^(chrome|devtools):/.test(url)) {
    const { targetInfos } = await send('Target.getTargets');
    const pages = targetInfos.filter((target) => target.type === 'page' && matches(target.url));

    if (pages.length !== 1) {
      const urls = pages.map((page) => page.url).join(', ');

      throw new Error(`Expected one matching page, found ${pages.length}: ${urls}`);
    }

    const { sessionId } = await send('Target.attachToTarget', {
      targetId: pages[0].targetId,
      flatten: true,
    });

    const cdp = {
      url: pages[0].url,
      send: (method, params, options) => send(method, params, sessionId, options?.timeoutMs),
    };

    // The same shape as a desktop tab's cdp capability.
    return {
      url: pages[0].url,
      cdp,
      capabilities: { get: async (name) => (name === 'cdp' ? cdp : undefined) },
      goto: (url) => send('Page.navigate', { url }, sessionId),
    };
  }

  return {
    attach,
    send,
    // Calls back with every browser event, until the returned function runs.
    listen(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
    closed: new Promise((settle) => socket.addEventListener('close', settle, { once: true })),
  };
}

// Sets a WordPress login in the browser context of the given tab.
export async function signIn(tab, url, wordpress, user) {
  const site = new URL(url);
  const secure = site.protocol === 'https:';
  const code = `
$user = get_user_by('login', getenv('BLOCKWORK_DEV_USER'));
if (!$user) { WP_CLI::error('User not found. Pass --user <login>.'); }
$secure = getenv('BLOCKWORK_DEV_SECURE') === '1';
$expires = time() + 12 * HOUR_IN_SECONDS;
$token = WP_Session_Tokens::get_instance($user->ID)->create($expires);
$auth = wp_generate_auth_cookie($user->ID, $expires, $secure ? 'secure_auth' : 'auth', $token);
$logged_in = wp_generate_auth_cookie($user->ID, $expires, 'logged_in', $token);
$cookies = [];
foreach (array_unique([ADMIN_COOKIE_PATH, PLUGINS_COOKIE_PATH]) as $path) {
  $cookies[] = ['name' => $secure ? SECURE_AUTH_COOKIE : AUTH_COOKIE, 'value' => $auth, 'path' => $path];
}
foreach (array_unique([COOKIEPATH, SITECOOKIEPATH]) as $path) {
  $cookies[] = ['name' => LOGGED_IN_COOKIE, 'value' => $logged_in, 'path' => $path];
}
echo wp_json_encode(['cookies' => $cookies, 'expires' => $expires, 'domain' => COOKIE_DOMAIN ?: null]);
`;

  // Cookie values stay in memory; only WP-CLI and the browser see them.
  const { stdout } = await execute('wp', [`--path=${wordpress}`, `--url=${url}`, 'eval', code], {
    timeout: 60_000,
    env: { ...process.env, BLOCKWORK_DEV_USER: user, BLOCKWORK_DEV_SECURE: secure ? '1' : '0' },
  }).catch((error) => {
    throw new Error(`WP-CLI sign-in failed: ${error.stderr || error.message}`);
  });

  const login = JSON.parse(stdout.trim().split('\n').at(-1));

  const cookies = login.cookies.map((cookie) => ({
    ...cookie,
    domain: login.domain ?? site.hostname,
    secure,
    httpOnly: true,
    expires: login.expires,
  }));

  await tab.cdp.send('Network.setCookies', { cookies });
}
