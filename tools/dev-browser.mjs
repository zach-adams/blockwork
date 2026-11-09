import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { connect, signIn } from './browser-session.mjs';

// Development-only stand-in for the desktop app's in-app browser. It runs the
// compiled Blockwork bootstrap against an agent-browser Chromium session over
// CDP so CLI agents can exercise workflows. It is never packaged. Desktop host
// behavior and final acceptance still require the Codex desktop app.

const root = resolve(fileURLToPath(import.meta.url), '../..');
const scripts = join(root, 'skills/blockwork/scripts');
// The name selects the agent-browser session and the state directory, so agents
// in separate checkouts can each run a browser at the same time.
const session = process.env.BLOCKWORK_DEV_SESSION ?? 'blockwork-dev';
const directory = join(tmpdir(), session);
// Outlives stop, so a sign-in made by hand in a --headed window carries over.
const profile = join(homedir(), '.local/share/blockwork/profiles', session);
const socketPath = join(directory, 'repl.sock');
const logPath = join(directory, 'server.log');
const execute = promisify(execFile);
const AsyncFunction = (async () => {}).constructor;

const usage = `Usage:
  node tools/dev-browser.mjs start <url> [--wp <wordpress_root>] [--user <login>] [--headed]
  node tools/dev-browser.mjs run [file]    Run an async snippet from a file or stdin
  node tools/dev-browser.mjs stop`;

const [command, ...args] = process.argv.slice(2);

// The directory holds a Unix socket, whose path length is limited.
if (!/^[a-z0-9-]{1,32}$/.test(session)) {
  fail('BLOCKWORK_DEV_SESSION takes 1 to 32 lowercase letters, digits, or hyphens.');
}

switch (command) {
  case 'start':
    await start(args);
    break;
  case 'serve':
    await serve(args[0]);
    break;
  case 'run':
    await runSnippet(args[0]);
    break;
  case 'stop':
    await stop();
    break;
  default:
    fail(usage);
}

async function start(args) {
  const url = args.find(
    (arg, index) => !arg.startsWith('--') && !['--wp', '--user'].includes(args[index - 1]),
  );
  const wordpress = option(args, '--wp');

  if (!url) {
    fail(usage);
  }

  if (await running()) {
    fail('The dev browser is already running. Run `node tools/dev-browser.mjs stop` first.');
  }

  await mkdir(directory, { recursive: true });
  await buildHash().catch((error) => fail(error.message));
  const { hostname } = new URL(url);

  // Chromium resolves .local names over multicast DNS, which can take over 30
  // seconds on macOS, so map them to the address the system resolver gives.
  if (hostname.endsWith('.local') && !process.env.AGENT_BROWSER_ARGS) {
    const { address } = await lookup(hostname, { family: 4 });
    process.env.AGENT_BROWSER_ARGS = `--host-resolver-rules=MAP *.local ${address}`;
  }

  await browser(
    ...(args.includes('--headed') ? ['--headed'] : []),
    '--profile',
    profile,
    'open',
    'about:blank',
  );
  const cdpUrl = await browser('get', 'cdp-url');

  if (wordpress) {
    const connection = await connect(cdpUrl);

    await signIn(
      await connection.attach(),
      url,
      wordpress,
      option(args, '--user') ?? 'admin',
    ).catch((error) => fail(error.message));
    connection.close();
  }

  await browser('open', url);
  const log = openSync(logPath, 'a');

  spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', cdpUrl], {
    detached: true,
    stdio: ['ignore', log, log],
  }).unref();

  for (let attempt = 0; attempt < 50 && !(await running()); attempt++) {
    await new Promise((settle) => setTimeout(settle, 200));
  }

  if (!(await running())) {
    fail(`The dev browser server did not start. Read ${logPath}.`);
  }

  console.log(
    JSON.stringify(
      {
        page: await browser('get', 'url'),
        agent_browser_session: session,
        profile,
        receipts: join(directory, 'receipts'),
        log: logPath,
      },
      null,
      2,
    ),
  );
}

// The server keeps one Blockwork caller and a `state` object between runs,
// like the desktop REPL keeps top-level bindings.
async function serve(cdpUrl) {
  const browserConnection = await connect(cdpUrl);
  let tab = await browserConnection.attach();
  let current = await load(tab);
  const state = {};

  async function selectTab(match) {
    tab = await browserConnection.attach((url) => url.includes(match));
    current = await load(tab);

    return current.blockwork;
  }

  async function evaluate(code) {
    const output = [];
    const nodeRepl = { write: (value) => output.push(value) };

    try {
      if ((await buildHash()) !== current.build) {
        current = await load(tab);
        output.push(`Reloaded Blockwork build ${current.build.slice(0, 12)}.`);
      }

      const snippet = new AsyncFunction(
        'blockwork',
        'cdp',
        'state',
        'nodeRepl',
        'selectTab',
        'saveImage',
        code,
      );
      const value = await snippet(
        current.blockwork,
        tab.cdp,
        state,
        nodeRepl,
        selectTab,
        saveImage,
      );

      if (value !== undefined) {
        output.push(value);
      }

      return { ok: true, output };
    } catch (error) {
      return { ok: false, output, error: error?.stack ?? String(error) };
    }
  }

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let code = '';

    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => (code += chunk));
    socket.on('end', async () => socket.end(serialize(await evaluate(code))));
  });

  // A snippet's floating rejection must not discard `state` and the caller.
  process.on('unhandledRejection', (error) => console.error(error));

  await rm(socketPath, { force: true });
  server.listen(socketPath);
  await browserConnection.closed;
  server.close();
  await rm(socketPath, { force: true });
  process.exit(0);
}

// Shots from view() and capture_page() print as file paths instead of bytes.
async function saveImage(bytes, name = `shot-${Date.now()}`) {
  const path = join(directory, 'images', `${name}.jpg`);
  await mkdir(join(directory, 'images'), { recursive: true });
  await writeFile(path, bytes);

  return path;
}

function serialize(result) {
  try {
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ ok: false, output: [], error: `Cannot print the result: ${error}` });
  }
}

async function runSnippet(file) {
  let code = '';

  if (file) {
    code = await readFile(file, 'utf8');
  } else {
    for await (const chunk of process.stdin) {
      code += chunk;
    }
  }

  if (!code.trim()) {
    fail('The snippet is empty.');
  }

  const response = await new Promise((settle, reject) => {
    const socket = createConnection(socketPath);
    let text = '';

    socket.setEncoding('utf8');
    socket.on('error', () =>
      reject(new Error('The dev browser is not running. Start it with `start <url>`.')),
    );
    socket.on('data', (chunk) => (text += chunk));
    socket.on('end', () => {
      try {
        settle(JSON.parse(text));
      } catch {
        reject(
          new Error(
            `The server ended without a result. Read ${logPath}. If the snippet could have changed the editor, verify with its stored receipt instead of rerunning it.`,
          ),
        );
      }
    });
    socket.end(code);
  }).catch((error) => fail(error.message));

  for (const entry of response.output) {
    console.log(JSON.stringify(entry, null, 2));
  }

  if (!response.ok) {
    fail(response.error);
  }
}

async function stop() {
  // Closing the browser ends the server's CDP connection, which stops the server.
  const closeError = await browser('close').then(
    () => '',
    (error) => error.stderr || error.message,
  );

  for (let attempt = 0; attempt < 25 && (await running()); attempt++) {
    await new Promise((settle) => setTimeout(settle, 200));
  }

  if (await running()) {
    fail(`The dev browser is still running. ${closeError}`);
  }

  await rm(socketPath, { force: true });
  console.log('Stopped.');
}

async function load(tab) {
  const build = await buildHash();
  const bootstrap = `${pathToFileURL(join(scripts, 'bootstrap.mjs')).href}?build=${build}`;
  const { createBlockwork } = await import(bootstrap);

  return {
    build,
    blockwork: await createBlockwork(tab, { receipt_directory: join(directory, 'receipts') }),
  };
}

async function buildHash() {
  const hash = createHash('sha256');

  for (const name of ['bootstrap.mjs', 'invoke.mjs', 'editor.js']) {
    const contents = await readFile(join(scripts, name)).catch(() => {
      throw new Error(`Missing skills/blockwork/scripts/${name}. Run \`pnpm compile\` first.`);
    });

    hash.update(contents);
  }

  return hash.digest('hex');
}

async function browser(...args) {
  const { stdout } = await execute('agent-browser', ['--session', session, ...args], {
    timeout: 120_000,
  });

  return stdout.trim();
}

async function running() {
  return new Promise((settle) => {
    const socket = createConnection(socketPath);

    socket.on('connect', () => {
      socket.destroy();
      settle(true);
    });
    socket.on('error', () => settle(false));
  });
}

function option(args, name) {
  const index = args.indexOf(name);

  return index === -1 ? undefined : args[index + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
