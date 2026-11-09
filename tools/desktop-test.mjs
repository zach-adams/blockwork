import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { connect, signIn } from './browser-session.mjs';
import { forwardToTestHost } from './test-host.mjs';

// Runs prompts in a separate, disposable copy of the ChatGPT desktop app, so an
// agent can test a plugin from a clean state without quitting the user's app or
// changing their settings and chats. It is never packaged.

const app = '/Applications/ChatGPT.app';
const cli = `${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
const repository = resolve(fileURLToPath(import.meta.url), '../..');
const support = join(homedir(), 'Library/Application Support');
const realHome = join(homedir(), '.codex');
// The browser plugin refuses a config path containing a symlink. The system temp
// folder on macOS has one, because /var links to /private/var.
const root = join(support, 'Codex Test');
// A separate HOME keeps everything the app finds from there out of the user's
// setup, such as personal skills, Chrome's native host manifests, and chat folders.
const user = join(root, 'user');
const home = join(user, '.codex');
const profile = join(root, 'user-data');
const mainWindow = 'app://-/index.html';
// A chat with a browser tab has more than one editor, and only one is shown.
const composer = `[...document.querySelectorAll('.ProseMirror')].find((element) => element.offsetWidth)`;
// The app keeps the chat at its end only while nothing above grows, and an image that
// loads late does, so a recorded chat scrolls there as a person would.
const scrollChatToEnd = `[...document.querySelectorAll('.thread-scroll-container')]
  .filter((element) => element.offsetWidth)
  .forEach((element) => element.scrollTo({ top: element.scrollHeight }))`;
// This Mac's window position and size for the copy, as JSON. Without it, the copy
// starts maximized.
// Recordings hide the account's avatar and usage meter, the personal details the
// window shows. They also hide the composer's blinking caret and the sheen that
// sweeps across status text such as "Thinking", so a frame changes only when the
// content does.
const recordingStyle = `
  button[aria-label="Open profile menu"], button[aria-label="Usage"] { visibility: hidden; }
  .ProseMirror { caret-color: transparent; }
  [class*="cadencedShimmerSweep"], [class*="cadencedShimmerHighlight"] { display: none !important; }
  [class*="cadencedShimmer-"] { color: var(--color-text-tertiary) !important; }
`;
const windowFile = join(homedir(), '.config/blockwork/test-window.json');
const exec = promisify(execFile);

function execute(file, args, options = {}) {
  return exec(file, args, { timeout: 120_000, ...options });
}

let stage = 'preparing';
let launched = false;
// When the recording started, and when a recorded prompt's attachment or first
// character went in.
let recordingStartedAt;
let inputAt;

const usage = `Usage:
  node tools/desktop-test.mjs start [--blockwork] [--model <id>] [--effort <level>] [--window <width>x<height>]
                                      [--site <url> (--wp <wordpress_root> --user <login> | --cookies <file>)]
  node tools/desktop-test.mjs run [--timeout <seconds>] [--follow-up [--open <url>]] [--attach <file>] [--record <file.mov>] <prompt>
  node tools/desktop-test.mjs stop`;

// The state the app saves once a user has finished its first-run screens and
// closed the announcements and tips it shows once.
const savedState = {
  'electron-persisted-atom-state': {
    'electron:onboarding-projectless-completed': true,
    'electron:onboarding-welcome-pending': false,
    'electron:onboarding-primary-runtime-install-requested': true,
    'electron:onboarding-primary-runtime-install-ready': true,
    'electron:onboarding-plugin-checklist-active': false,
    'browser-sidebar-comment-mode-coachmark-dismissed': true,
    'browser-tab-picker-tooltip-seen-v1': true,
    'has-seen-browser-profile-import-nux-v1': true,
    'has-seen-browser-profile-import-nux-modal-v1': true,
    'has-seen-fast-mode-announcement': true,
    'has-seen-fast-mode-home-banner': true,
    'has-seen-knowledge-work-announcement': true,
    'has-seen-gift-credits-home-banner': true,
    'has-seen-realtime-voice-nux-v1': true,
    'has-dismissed-priority-filter-coachmark-v1': true,
    'chatgpt-migration-announcement-completed-v1': true,
    'computer-history-weekly-insights-announcement-dismissed-v1': true,
    'imagegen-2-5-announcement-dismissed-v1': true,
    'presentation-annotations-cursor-onboarding-completed-v1': true,
    'safety-buffering-banner-dismissed-v1': true,
    'seen-model-upgrade-list': ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol'],
    // A suggested next message in the composer, from the conversation.
    'composer-predictions-enabled': false,
  },
};

const [command, ...args] = process.argv.slice(2);

forwardToTestHost('tools/desktop-test.mjs', { sync: command === 'start' });

try {
  switch (command) {
    case 'start':
      await start(args);
      break;
    case 'run':
      await run(args);
      break;
    case 'stop':
      stage = 'stopping the app';
      await stop();
      break;
    default:
      throw new Error(usage);
  }

  // A helper the app spawns can inherit a CDP socket, so a closed connection may never
  // finish closing, and that would keep this process alive after it printed.
  process.stdout.write('', () => process.exit(0));
} catch (error) {
  if (launched) {
    await stop().catch((failure) => console.error(failure.message));
  }

  console.error(`${command} failed while ${stage}: ${error.message}`);
  process.exit(1);
}

async function start(args) {
  const site = option(args, '--site');
  const wordpress = option(args, '--wp');
  const login = option(args, '--user');
  const cookies = option(args, '--cookies');

  if (site && !cookies && !(wordpress && login)) {
    throw new Error(
      '--site also needs --wp and --user, or --cookies, which sign the test browser in.',
    );
  }

  if (await appProcess()) {
    throw new Error('The test app is already running. Run `stop` first.');
  }

  const window = option(args, '--window');
  const [, width, height] = /^(\d+)x(\d+)$/.exec(window ?? '') ?? [];

  if (window && !width) {
    throw new Error(`--window takes a size in points, such as 1600x1000, not ${window}.`);
  }

  await removeTestFolder();
  const blockwork = args.includes('--blockwork');

  await writeProfile(
    option(args, '--model') ?? 'gpt-6.1-terra',
    option(args, '--effort') ?? 'medium',
    blockwork && site,
    width && { width: Number(width), height: Number(height) },
  );

  if (blockwork) {
    stage = 'installing Blockwork';
    await installBlockwork();
  }

  stage = 'launching the app';
  launched = true;
  await execute(
    '/usr/bin/open',
    [
      '-n',
      '-g',
      '--env',
      `HOME=${user}`,
      '--env',
      `CODEX_HOME=${home}`,
      '--env',
      `CODEX_ELECTRON_USER_DATA_PATH=${profile}`,
      // An update from here would replace the app under the user's running copy.
      '--env',
      'CODEX_SPARKLE_ENABLED=false',
      app,
      '--args',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
    ],
    // The app inherits this environment, which would otherwise hand a test chat
    // the caller's PATH, and with it tools a clean machine wouldn't have.
    { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } },
  );

  stage = 'waiting for the composer';
  await until(() => composerReady(), 60, 'The test app did not show a chat composer.');

  // One chat before any real one, because account plugins arrive after launch and
  // the in-app browser's cookie store can only be reached through a tab, which a
  // chat gets only after its first turn. The tab is opened by hand, because a
  // cheaper model may only reply instead of opening it.
  stage = 'waiting for the first chat';
  const warmUp = await send('Reply "done".');

  await until(
    async () => (await summarize(warmUp)).status !== 'running',
    120,
    'The first chat did not finish.',
  );

  if (site) {
    stage = 'opening the site';
    // No other tab is on the site yet, so any page there is this one, even after a
    // redirect or an added trailing slash.
    const { origin } = new URL(site);
    await openByHand(site, (target) => URL.parse(target)?.origin === origin);
    stage = 'signing in to the site';
    await signInToSite(site, wordpress, login, cookies);
  }

  stage = 'hiding account skills';
  await hideAccountSkills();
  print({ pid: (await appProcess()).pid, home, blockwork });
}

async function writeProfile(model, effort, allowedSite, size) {
  await mkdir(join(home, 'browser'), { recursive: true, mode: 0o700 });
  await mkdir(profile, { recursive: true, mode: 0o700 });

  // A link and not a copy, because a copy's refresh token would invalidate the
  // user's when either side renewed it.
  await symlink(join(realHome, 'auth.json'), join(home, 'auth.json'));

  // Without this, each start downloads about 2 GB in the background during the
  // first runs, which would skew their timings.
  const runtimes = join(homedir(), '.cache/codex-runtimes');

  if (existsSync(runtimes)) {
    await mkdir(join(user, '.cache'));
    await symlink(runtimes, join(user, '.cache/codex-runtimes'));
  }

  // macOS finds the login keychain through HOME, and a local site's certificate
  // authority may be trusted only there, as a new Herd install does.
  await mkdir(join(user, 'Library'));
  await symlink(join(homedir(), 'Library/Keychains'), join(user, 'Library/Keychains'));

  // A maximized window gives the in-app browser the room people give it.
  const saved = existsSync(windowFile)
    ? JSON.parse(await readFile(windowFile, 'utf8'))
    : { x: 0, y: 0, width: 1280, height: 820, isMaximized: true };
  const bounds = size ? { x: 0, y: 0, ...size } : saved;

  await writeFile(
    join(home, '.codex-global-state.json'),
    JSON.stringify({ ...savedState, 'electron-main-window-bounds': bounds }),
  );

  await writeFile(
    join(home, 'config.toml'),
    [
      `model = ${JSON.stringify(model)}`,
      `model_reasoning_effort = ${JSON.stringify(effort)}`,
      // The app's Fast mode.
      'service_tier = "priority"',
      // The sandbox keeps a test chat out of the user's files. Approvals stay off
      // because a chat that stops to ask would wait with nobody watching.
      'sandbox_mode = "workspace-write"',
      'approval_policy = "never"',
      '',
      '[features]',
      'apps = false',
      'memories = false',
      // Otherwise a chat can list the user's real Chrome tabs through the Codex
      // Chrome extension, which both apps share.
      'browser_use_external = false',
      '',
      // The separate HOME breaks its socket path, so every cua.getState would wait
      // out a 5 second connection timeout, and Blockwork tests don't use it.
      '[plugins."computer-use@openai-bundled"]',
      'enabled = false',
      '',
    ].join('\n'),
  );

  await writeFile(
    join(home, 'browser/config.toml'),
    [
      'approval_mode = "never_ask"',
      'download_approval_mode = "never_ask"',
      'full_cdp_access_enabled = true',
      'history_approval_mode = "never_ask"',
      'upload_approval_mode = "never_ask"',
      // What the app saves when a user allows Blockwork's page access for a site.
      ...(allowedSite
        ? ['', '[full_cdp]', `allowed = [${JSON.stringify(new URL(allowedSite).origin)}]`]
        : []),
      '',
    ].join('\n'),
  );
}

async function installBlockwork() {
  const environment = { env: { ...process.env, HOME: user, CODEX_HOME: home }, cwd: repository };

  await execute(process.execPath, ['tools/package.mjs', '--development'], { cwd: repository });
  await execute(cli, ['plugin', 'marketplace', 'add', '.'], environment);
  await execute(cli, ['plugin', 'add', 'blockwork@blockwork-local'], environment);
}

async function signInToSite(site, wordpress, login, cookies) {
  const { origin } = new URL(site);
  const connection = await connectToApp();

  try {
    const tab = await connection.attach((url) => url.startsWith(origin));

    if (cookies) {
      await tab.cdp.send('Network.setCookies', {
        cookies: JSON.parse(await readFile(cookies, 'utf8')),
      });
    } else {
      await signIn(tab, site, wordpress, login);
    }

    const { result, exceptionDetails } = await tab.cdp.send('Runtime.evaluate', {
      expression: `fetch('/wp-admin/', { redirect: 'manual' }).then((response) => response.status)`,
      awaitPromise: true,
      returnByValue: true,
    });

    if (exceptionDetails) {
      throw new Error(
        `Signing in to ${origin} failed, because /wp-admin/ could not be fetched (${exceptionDetails.exception?.description ?? exceptionDetails.text}).`,
      );
    }

    if (result.value !== 200) {
      throw new Error(
        `Signing in to ${origin} failed, because /wp-admin/ returned ${result.value}.`,
      );
    }
  } finally {
    connection.close();
  }
}

async function run(args) {
  const seconds = Number(option(args, '--timeout') ?? 900);
  const record = option(args, '--record');
  const page = option(args, '--open');
  const attachment = option(args, '--attach');
  const followUp = args.includes('--follow-up');
  const prompt = args.find(
    (arg, index) =>
      !arg.startsWith('--') &&
      !['--timeout', '--record', '--open', '--attach'].includes(args[index - 1]),
  );

  if (!prompt || !Number.isFinite(seconds)) {
    throw new Error(usage);
  }

  if (page && !followUp) {
    throw new Error(
      '--open needs --follow-up, because a chat gets a browser only after its first turn.',
    );
  }

  // Recording starts first, because a tab opened just before it can stay blank in the
  // first frames. A clip can start at recording.input_at instead.
  const stopRecording = record ? await startRecording(resolve(record)) : undefined;

  try {
    if (page) {
      stage = 'opening the page';
      await openByHand(page);
    }

    stage = 'sending the prompt';
    const rollout = await send(prompt, {
      followUp,
      typed: Boolean(record),
      attachment: attachment && resolve(attachment),
    });
    stage = 'waiting for the chat';

    // A chat that outlasts the wait is reported, not treated as a script failure.
    await until(async () => (await summarize(rollout)).status !== 'running', seconds).catch(
      () => undefined,
    );

    const summary = await summarize(rollout);

    if (stopRecording) {
      // A short hold, so the clip ends on the whole answer.
      const connection = await connectToApp();

      try {
        const tab = await connection.attach((url) => url === mainWindow);
        await tab.cdp.send('Runtime.evaluate', { expression: scrollChatToEnd });
      } finally {
        connection.close();
      }

      await new Promise((settle) => setTimeout(settle, 2000));
      await stopRecording();
      summary.recording = {
        file: resolve(record),
        started_at: recordingStartedAt,
        input_at: inputAt,
      };
    }

    print(summary);
  } finally {
    await stopRecording?.();
  }
}

// Opens a page in the chat's browser the way a person does. Browser Use has never
// touched the tab, which matters because it blocks the blob: frame that Gutenberg's
// canvas loads in. The tab is found by its exact URL unless `opened` says otherwise.
async function openByHand(url, opened = (target) => target === url) {
  const connection = await connectToApp();

  try {
    const tab = await connection.attach((target) => target === mainWindow);
    await tab.cdp.send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('button[aria-label="New tab"]')]
        .find((element) => element.offsetWidth)?.click()`,
    });
    // Typing goes wherever the focus is, which could be a live editor.
    await until(
      async () => {
        const { result } = await tab.cdp.send('Runtime.evaluate', {
          expression: `document.activeElement?.getAttribute('aria-label') === 'Search or enter a URL'`,
          returnByValue: true,
        });

        return result.value;
      },
      10,
      'The test app did not open a browser tab to type the URL into.',
    );
    await tab.cdp.send('Input.insertText', { text: url });

    for (const type of ['keyDown', 'keyUp']) {
      await tab.cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        ...(type === 'keyDown' && { text: '\r' }),
      });
    }

    const page = await until(
      () => connection.attach(opened).catch(() => undefined),
      30,
      `The browser tab did not open ${url}.`,
    );
    // Gutenberg draws its canvas after the page loads, and a recording would otherwise
    // start on a blank editor.
    await until(
      async () => {
        const { result } = await page.cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const canvas = document.querySelector('iframe[name="editor-canvas"]');
            return document.readyState === 'complete' &&
              (!canvas || canvas.contentDocument?.querySelector('.is-root-container')?.childElementCount > 0);
          })()`,
          returnByValue: true,
        });

        return result.value;
      },
      30,
      `${url} did not finish loading.`,
    );
  } finally {
    connection.close();
  }
}

// Records only the copy's main window, never the screen, with recordingStyle applied.
async function startRecording(file) {
  const connection = await connectToApp();

  try {
    const tab = await connection.attach((url) => url === mainWindow);
    await tab.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(recordingStyle)};
        document.head.append(style);
        // Banners about the account's plan and usage.
        document.querySelectorAll('button[aria-label^="Dismiss"]').forEach((button) => button.click());
      })()`,
    });
  } finally {
    connection.close();
  }

  stage = 'finding the app window';
  const { pid } = await appProcess();
  // The main window is the app's largest window at the normal level.
  const { stdout } = await execute('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import('CoreGraphics');
    function run([pid]) {
      const windows = ObjC.deepUnwrap(ObjC.castRefToObject(
        $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0),
      ));
      const area = ({ kCGWindowBounds: { Width, Height } }) => Width * Height;
      return windows
        .filter((window) => window.kCGWindowOwnerPID === Number(pid) && window.kCGWindowLayer === 0)
        .sort((a, b) => area(b) - area(a))[0]?.kCGWindowNumber ?? '';
    }`,
    String(pid),
  ]);

  if (!stdout.trim()) {
    throw new Error('The test app has no window to record.');
  }

  // The video's first frame comes from here. Its end can't be used instead, because
  // screencapture writes a frame only when the window changes.
  recordingStartedAt = new Date().toISOString();
  // -o leaves out the window's shadow.
  const capture = spawn('/usr/sbin/screencapture', ['-v', '-x', '-o', '-l', stdout.trim(), file], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = once(capture, 'exit');
  let stopped;

  // Without Screen Recording permission it exits at once, and the chat would be wasted.
  if (await Promise.race([exited, new Promise((settle) => setTimeout(settle, 1000))])) {
    throw new Error(
      'screencapture stopped before recording. Give the program running this script Screen Recording permission in System Settings, then run it again.',
    );
  }

  return () => {
    // Interrupting screencapture is how it finishes the file.
    stopped ??= (async () => {
      capture.kill('SIGINT');
      await exited;
    })();

    return stopped;
  };
}

async function stop() {
  const connection = await connectToApp().catch(() => undefined);

  if (connection) {
    // The connection drops as the app closes, so the call may never answer.
    await connection.send('Browser.close', {}, undefined, 1000).catch(() => undefined);
    connection.close();
    await until(async () => !(await appProcess()), 20).catch(() => undefined);
  }

  // Crash reporters outlive the app, and the app itself may not have closed.
  for (const { pid } of await profileProcesses()) {
    await execute('/bin/kill', [String(pid)]).catch(() => undefined);
  }

  await until(
    async () => !(await profileProcesses()).length,
    20,
    'The test app did not close, so its folder was kept. Run `stop` again.',
  );
  await removeTestFolder();
  print({ stopped: true });
}

// The app installs the plugins on the user's ChatGPT account whatever the config
// says, and removing one could reach the account, so a clean run switches their
// skills off here. They arrive after launch, so each chat checks again.
async function hideAccountSkills() {
  const cache = join(home, 'plugins/cache');
  const config = join(home, 'config.toml');
  const names = await readdir(cache, { recursive: true }).catch(() => []);
  const current = await readFile(config, 'utf8');
  const additions = names
    .filter((name) => /^[^/]+-remote\/[^/]+\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(name))
    .map((name) => JSON.stringify(join(cache, name)))
    .filter((path) => !current.includes(path))
    .map((path) => `\n[[skills.config]]\npath = ${path}\nenabled = false\n`);

  await appendFile(config, additions.join(''));
}

// A follow-up goes to the chat on screen, which is the one most recently written.
async function send(prompt, { followUp = false, typed = false, attachment } = {}) {
  await hideAccountSkills();

  const known = new Set(await rollouts());
  const current = followUp ? await latestRollout() : undefined;
  const turns = current && (await turnCount(current));
  const connection = await connectToApp();

  try {
    const tab = await connection.attach((url) => url === mainWindow);
    const evaluate = (expression) => tab.cdp.send('Runtime.evaluate', { expression });
    const click = (label) =>
      evaluate(`[...document.querySelectorAll('button, a, [role="button"]')]
        .find((element) => element.innerText.trim() === '${label}')?.click()`);

    if (!followUp) {
      await click('New chat');
      // This also gives the in-app browser more width. The button is only there while
      // the sidebar shows, so later chats leave it hidden.
      await evaluate(`[...document.querySelectorAll('button[aria-label="Hide sidebar"]')]
        .find((element) => element.offsetWidth)?.click()`);
    }

    await until(
      async () => {
        const { result } = await tab.cdp.send('Runtime.evaluate', {
          // A suggested next prompt shows as a widget in an empty composer.
          expression: `(() => {
            const copy = ${composer}?.cloneNode(true);
            copy?.querySelectorAll('.ProseMirror-widget').forEach((widget) => widget.remove());
            return copy?.textContent.trim() === '';
          })()`,
          returnByValue: true,
        });

        return result.value;
      },
      15,
      'The test app did not show an empty composer.',
    );

    // A new prompt stays in view only when the chat is at its end, so a follow-up goes
    // there before typing, and a recorded one again once the prompt and its attachment
    // have drawn.
    if (followUp) {
      await evaluate(scrollChatToEnd);
    }

    // A cheaper model opens a dialog offering a better one, which holds the focus,
    // so text would go nowhere and Enter would only close the dialog.
    await until(
      async () => {
        await click('Continue with current model');
        await evaluate(`${composer}?.focus()`);
        const { result } = await tab.cdp.send('Runtime.evaluate', {
          expression: `Boolean(document.activeElement.closest('.ProseMirror'))`,
          returnByValue: true,
        });

        return result.value;
      },
      15,
      'The test app did not focus its composer.',
    );

    if (typed) {
      // The window can show a page that just opened a few seconds after the page itself
      // reports drawing it, and the clip should start on the page as it looks.
      await new Promise((settle) => setTimeout(settle, 4000));
      inputAt = new Date().toISOString();
    }

    if (attachment) {
      await dropOnComposer(tab, attachment);
    }

    // A recording types at a person's pace, so viewers can read the prompt.
    for (const text of typed ? prompt : [prompt]) {
      await tab.cdp.send('Input.insertText', { text });

      if (typed) {
        await new Promise((settle) => setTimeout(settle, 30));
      }
    }

    // Enter would only choose from the list that a "$word" in the prompt opens.
    await until(
      async () => {
        const { result } = await tab.cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const button = [...document.querySelectorAll('button[aria-label="Send"]')]
              .find((element) => element.offsetWidth && !element.disabled);
            button?.click();
            return Boolean(button);
          })()`,
          returnByValue: true,
        });

        return result.value;
      },
      5,
      'The test app did not enable its send button.',
    );

    if (followUp && typed) {
      await new Promise((settle) => setTimeout(settle, 1500));
      await evaluate(scrollChatToEnd);
    }
  } finally {
    connection.close();
  }

  if (current) {
    return until(
      async () => (await turnCount(current)) > turns && current,
      30,
      'The test app did not start a turn from the follow-up.',
    );
  }

  return until(
    async () => (await rollouts()).find((path) => !known.has(path)),
    30,
    'The test app did not start a chat from the prompt.',
  );
}

// Drags the file from disk onto the composer, as a person would. The composer has
// no file input, and its button opens a native dialog.
async function dropOnComposer(tab, file) {
  const { result } = await tab.cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const { left, top, width, height } = ${composer}.getBoundingClientRect();
      return [left + width / 2, top + height / 2];
    })()`,
    returnByValue: true,
  });
  const [x, y] = result.value;

  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await tab.cdp.send('Input.dispatchDragEvent', {
      type,
      x,
      y,
      data: { items: [], files: [file], dragOperationsMask: 1 },
    });
  }

  await until(
    async () => {
      const { result: shown } = await tab.cdp.send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('[aria-label]')].some(
          (element) => element.getAttribute('aria-label') === ${JSON.stringify(`Remove ${basename(file)}`)},
        )`,
        returnByValue: true,
      });

      return shown.value;
    },
    10,
    `The test app did not attach ${file}.`,
  );
}

async function latestRollout() {
  const paths = await rollouts();
  const times = await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs));
  const latest = paths[times.indexOf(Math.max(...times))];

  if (!latest) {
    throw new Error('--follow-up needs an open chat. Run a prompt without it first.');
  }

  return latest;
}

async function turnCount(path) {
  return (await readEntries(path)).filter(
    (entry) => entry.type === 'event_msg' && entry.payload.type === 'task_started',
  ).length;
}

async function rollouts() {
  const sessions = join(home, 'sessions');
  const names = await readdir(sessions, { recursive: true }).catch(() => []);

  return names
    .filter((name) => /rollout-.*\.jsonl$/.test(name))
    .map((name) => join(sessions, name));
}

// Reads the chat's own transcript, so timings come from the app and not from
// how quickly this script noticed the result.
async function summarize(path) {
  const all = await readEntries(path);
  // Only the latest turn, which is the prompt's when it was a follow-up.
  const entries = all.slice(
    all.findLastIndex(
      (entry) => entry.type === 'event_msg' && entry.payload.type === 'task_started',
    ),
  );
  const payloads = (type) => entries.filter((entry) => entry.type === type);
  const events = (type) => payloads('event_msg').filter((entry) => entry.payload.type === type);
  const started = events('task_started')[0];
  const completed = events('task_complete').at(-1);
  const tokens = events('token_count').at(-1);
  const context = payloads('turn_context')[0]?.payload;
  const [latestTurnEvent] = payloads('event_msg')
    .filter(({ payload }) =>
      ['task_started', 'task_complete', 'turn_aborted'].includes(payload.type),
    )
    .slice(-1);
  const status =
    { task_complete: 'completed', turn_aborted: 'aborted' }[latestTurnEvent?.payload.type] ??
    'running';

  return {
    status,
    thread_id: all.find((entry) => entry.type === 'session_meta')?.payload.id,
    rollout: path,
    model: context?.model,
    effort: context?.effort,
    started_at: started?.timestamp,
    completed_at: completed?.timestamp,
    duration_seconds:
      status === 'completed'
        ? (Date.parse(completed.timestamp) - Date.parse(started.timestamp)) / 1000
        : undefined,
    tool_calls: payloads('response_item').filter(({ payload }) =>
      ['function_call', 'custom_tool_call'].includes(payload.type),
    ).length,
    tokens: tokens?.payload.info?.total_token_usage,
    final_message: status === 'completed' ? completed.payload.last_agent_message : undefined,
  };
}

// The app marks its generated runtime read-only, which stops a plain removal.
async function removeTestFolder() {
  await execute('/bin/chmod', ['-R', 'u+w', root]).catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

async function readEntries(path) {
  return (await readFile(path, 'utf8')).split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // The last line can be partly written.
    }
  });
}

async function connectToApp() {
  const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
  const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(5000),
  })
    .then((response) => response.json())
    .catch(() => {
      throw new Error(`The app's CDP endpoint on port ${port} did not answer.`);
    });

  return connect(webSocketDebuggerUrl);
}

async function composerReady() {
  const connection = await connectToApp().catch(() => undefined);

  if (!connection) {
    return false;
  }

  try {
    const tab = await connection.attach((url) => url === mainWindow);
    const { result } = await tab.cdp.send('Runtime.evaluate', {
      expression: `Boolean(document.querySelector('.ProseMirror'))`,
      returnByValue: true,
    });

    return result.value;
  } catch {
    return false; // The window has not opened yet.
  } finally {
    connection.close();
  }
}

// Every process of this copy names the test profile on its command line, which
// is what tells them apart from the user's app.
async function profileProcesses() {
  const { stdout } = await execute('/bin/ps', ['-axww', '-o', 'pid=,command=']);

  return stdout.split('\n').flatMap((line) => {
    const [, pid, processCommand] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];

    return processCommand?.startsWith(`${app}/`) && processCommand.includes(profile)
      ? [{ pid: Number(pid), command: processCommand }]
      : [];
  });
}

async function appProcess() {
  const executable = `${app}/Contents/MacOS/ChatGPT `;

  return (await profileProcesses()).find(({ command: line }) => line.startsWith(executable));
}

async function until(condition, seconds, message = 'Timed out.') {
  // Racing also fails a condition that never settles, not only one that keeps saying no.
  const expired = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), seconds * 1000).unref();
  });

  for (;;) {
    const value = await Promise.race([condition(), expired]);

    if (value) {
      return value;
    }

    await new Promise((settle) => setTimeout(settle, 500));
  }
}

function option(args, name) {
  const index = args.indexOf(name);

  return index === -1 ? undefined : args[index + 1];
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
