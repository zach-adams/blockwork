import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { seedDocument, seedImage, startEditingSite } from '../tests/editing/harness.mjs';
import { landingPage } from '../tests/editing/pages.mjs';
import { connect } from './browser-session.mjs';

// Records a demo clip of Blockwork editing a page in the clean desktop test app,
// then cuts it into an MP4 and a GIF small enough for a GitHub README. It spends
// the signed-in account's usage, so it never runs from `pnpm check` or CI.

const exec = promisify(execFile);
const repository = resolve(fileURLToPath(import.meta.url), '../..');
const warmUp = 'Hi';
// Each step is one prompt in the same chat, recorded and cut on its own. The photo is
// Carol M. Highsmith's public-domain "Downtown Dallas at dusk" (Library of Congress, highsm.28644).
const steps = [
  {
    prompt:
      'Make the hero headline "Fund Your Next Move", center its content, and turn the overlay bright orange, then save.',
  },
  {
    prompt: 'Use this photo as the hero background and lighten the overlay so it shows, then save.',
    attach: join(repository, 'tools/demo/skyline.jpg'),
  },
  { prompt: 'On mobile, make the hero taller and the headline smaller, then save.', mobile: true },
];
const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'gpt-6.1-terra' },
    effort: { type: 'string', default: 'medium' },
    // Without it, the window fills the screen, as the app's own zoom button does.
    window: { type: 'string' },
    out: { type: 'string' },
    // Cuts an earlier recording again, from the folder that holds its raw-*.mov and run.json.
    cut: { type: 'string' },
  },
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(values.cut ?? values.out ?? join(repository, 'artifacts/demo', stamp));
// GitHub shows images up to 10 MB inline.
const gifLimit = 10_000_000;
const runs = values.cut
  ? JSON.parse(await readFile(join(out, 'run.json'), 'utf8'))
  : await record();
// A step that threw leaves run.json without it.
const stopped = runs.findIndex(({ status }) => status !== 'completed');

if (stopped !== -1 || runs.length < steps.length) {
  throw new Error(
    `Step ${(stopped === -1 ? runs.length : stopped) + 1} did not complete, so the clip was not cut. See ${out}/run.json.`,
  );
}

const segments = [];

for (const [index, run] of runs.entries()) {
  segments.push(join(out, `segment-${index + 1}.mp4`));
  await cut(run, join(out, basename(run.recording.file)), segments.at(-1));
}

await concatenate(segments, join(out, 'demo.mp4'));
const gif = await shrink(join(out, 'demo.mp4'), join(out, 'demo.gif'));
console.log(
  JSON.stringify({ out, seconds: runs.map((run) => run.duration_seconds), gif }, null, 2),
);

function execute(file, args, options = {}) {
  return exec(file, args, { timeout: 600_000, maxBuffer: 64 * 1024 * 1024, ...options });
}

async function desktop(...args) {
  // Longer than run's 600 second chat wait, so it can stop its recording itself.
  const { stdout } = await execute('node', ['tools/desktop-test.mjs', ...args], {
    cwd: repository,
    // The recording runs on this Mac, so the app must too.
    env: { ...process.env, BLOCKWORK_TEST_HERE: '1' },
    timeout: 900_000,
  }).catch((error) => {
    throw new Error(`tools/desktop-test.mjs ${args[0]} failed: ${error.stderr}`, { cause: error });
  });

  return JSON.parse(stdout);
}

async function record() {
  await mkdir(out, { recursive: true });

  const scratch = await mkdtemp(join(tmpdir(), 'blockwork-demo-'));
  const site = await startEditingSite();
  let appStarted = false;
  const runs = [];

  try {
    const heroImage = await seedImage(site, { name: 'hero-example', alt: 'A landscape' });
    const photo = await seedImage(site, { name: 'team-example', alt: 'A team' });
    const id = await seedDocument(site, {
      content: landingPage({ heroImage, photo }),
      title: 'Example landing page',
    });
    // The welcome guide would cover the page, and the settings sidebar narrows it.
    await site.php(
      `update_user_meta(1, 'wp_persisted_preferences', ['core' => ['isComplementaryAreaVisible' => false], 'core/edit-post' => ['welcomeGuide' => false], '_modified' => gmdate('c')]);`,
    );

    const cookies = join(scratch, 'cookies.json');
    await writeFile(cookies, JSON.stringify(await site.authCookies()), { mode: 0o600 });
    // Another run may own an app that was already running, so stop only this run's.
    await desktop(
      'start',
      '--blockwork',
      '--model',
      values.model,
      '--effort',
      values.effort,
      ...(values.window ? ['--window', values.window] : []),
      '--site',
      `${site.site}/`,
      '--cookies',
      cookies,
    ).catch((error) => {
      appStarted = Boolean(error.cause?.killed);
      throw error;
    });
    appStarted = true;

    // A chat gets a browser only after its first turn. The page then opens in it by
    // hand, as a person would, so the recorded prompt can point at the page on screen.
    await desktop('run', '--timeout', '120', warmUp);
    await renameChat('Landing page hero');
    await hideWarmUp();
    const editor = `${site.site}/wp-admin/post.php?post=${id}&action=edit`;

    for (const [index, step] of steps.entries()) {
      const args = ['--follow-up', '--record', join(out, `raw-${index + 1}.mov`)];

      if (index === 0) {
        args.push('--open', editor);
      }

      if (step.attach) {
        // A neutral path, in case the chat names where the file came from.
        const file = join(scratch, basename(step.attach));
        await copyFile(step.attach, file);
        args.push('--attach', file);
      }

      if (step.mobile) {
        await showMobilePreview(editor);
      }

      runs.push(await desktop('run', '--timeout', '600', ...args, step.prompt));
      await writeFile(join(out, 'run.json'), JSON.stringify(runs, null, 2));

      if (runs.at(-1).status !== 'completed') {
        break;
      }
    }

    return runs;
  } finally {
    // `stop` deletes the chat, which shows what the agent did in each step.
    if (runs[0]) {
      await copyFile(runs[0].rollout, join(out, 'chat.jsonl')).catch((error) =>
        console.error(error.message),
      );
    }

    if (appStarted) {
      await desktop('stop').catch((error) => console.error(error.message));
    }

    await site[Symbol.asyncDispose]();
    await rm(scratch, { recursive: true, force: true });
  }
}

// Real speed while the prompt is typed and the answer arrives, and a labeled
// speed-up of the work between, which is mostly waiting on the model.
async function cut({ started_at, completed_at, recording }, raw, file) {
  // Seconds into the video. screencapture takes a moment to start, so every boundary
  // lands that much late. The half second before the prompt covers a short delay.
  const at = (time) => (Date.parse(time) - Date.parse(recording.started_at)) / 1000;
  // The clip starts just before the prompt goes in, after the page has opened and drawn.
  const start = Math.max(0, at(recording.input_at) - 0.5);
  const fast = [at(started_at) + 2, at(completed_at) - 4];
  const speed = Math.min(20, Math.max(2, Math.round((fast[1] - fast[0]) / 10)));
  // macOS draws a recording badge in place of the window buttons, so a box in the
  // title bar's color covers it. Its place varies with the Mac, so the box covers the
  // union seen on both test Macs.
  const { stdout: pixel } = await execute(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      raw,
      '-frames:v',
      '1',
      '-vf',
      'format=rgb24,crop=1:1:200:6',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer' },
  );
  const badge = `drawbox=x=8:y=8:w=156:h=60:color=0x${pixel.toString('hex')}:t=fill`;
  const label = `drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='${speed}× speed':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=18:x=48:y=h-th-48`;
  const filter =
    fast[1] - fast[0] < 3
      ? `[0:v]${badge},trim=start=${start},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2,fps=30,format=yuv420p[out]`
      : [
          `[0:v]${badge},split=3[a][b][c]`,
          `[a]trim=${start}:${fast[0]},setpts=PTS-STARTPTS[p0]`,
          `[b]trim=${fast[0]}:${fast[1]},setpts=(PTS-STARTPTS)/${speed},${label}[p1]`,
          `[c]trim=${fast[1]},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2[p2]`,
          '[p0][p1][p2]concat=n=3:v=1:a=0,fps=30,format=yuv420p[out]',
        ].join(';');

  await execute('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    raw,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    file,
  ]);
}

// The person switches their editor to its mobile preview, so a change for phones
// shows in the clip.
async function showMobilePreview(url) {
  await inTab(url, (evaluate) =>
    evaluate(`wp.data.dispatch('core/editor').setDeviceType('Mobile')`),
  );
}

// The app names the chat after the warm-up "Hi", so the person renames it from the
// chat's menu, which opens only on a real pointer press.
async function renameChat(title) {
  await inTab('app://-/index.html', async (evaluate, cdp) => {
    const [x, y] = await evaluate(`(() => {
      const { left, top, width, height } = [...document.querySelectorAll('button[aria-label="Chat actions"]')]
        .find((element) => element.offsetWidth).getBoundingClientRect();
      return [left + width / 2, top + height / 2];
    })()`);

    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }

    await poll(
      () =>
        evaluate(`(() => {
          const item = [...document.querySelectorAll('[role=menuitem]')]
            .find((element) => element.innerText.startsWith('Rename'));
          item?.click();
          return Boolean(item);
        })()`),
      'The chat menu did not offer Rename.',
    );
    await poll(
      () =>
        evaluate(`(() => {
          const field = document.activeElement;
          field.select?.();
          return field.getAttribute('aria-label') === 'Chat title';
        })()`),
      'The Rename dialog did not focus its title field.',
    );
    await cdp.send('Input.insertText', { text: title });
    await evaluate(`[...document.querySelectorAll('[role=dialog] button')]
      .find((element) => element.innerText.trim() === 'Save').click()`);
    await poll(
      () => evaluate(`!document.querySelector('input[aria-label="Chat title"]')`),
      'The Rename dialog did not close.',
    );
  });
}

// The warm-up only gives the chat a browser, so the clip leaves its turn out. The
// app may draw a turn again at any time, so an observer hides it each time.
async function hideWarmUp() {
  await inTab('app://-/index.html', (evaluate) =>
    evaluate(`(() => {
      const hide = () => {
        for (const turn of document.querySelectorAll('[data-turn-key]')) {
          if (turn.querySelector('[data-user-message-bubble]')?.innerText.trim() === ${JSON.stringify(warmUp)}) {
            turn.style.visibility = 'hidden';
          }
        }
      };
      hide();
      new MutationObserver(hide).observe(document.body, { childList: true, subtree: true });
    })()`),
  );
}

// Runs code in one of the test app's pages, found by its exact URL.
async function inTab(url, use) {
  const profile = join(homedir(), 'Library/Application Support/Codex Test/user-data');
  const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
  const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${port}/json/version`).then(
    (response) => response.json(),
  );
  const connection = await connect(webSocketDebuggerUrl);

  try {
    const { cdp } = await connection.attach((target) => target === url);
    const evaluate = async (expression) =>
      (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

    return await use(evaluate, cdp);
  } finally {
    connection.close();
  }
}

async function poll(check, message) {
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    if (await check()) {
      return;
    }

    await new Promise((settle) => setTimeout(settle, 100));
  }

  throw new Error(message);
}

// The segments share one encoding, so they join without encoding again.
async function concatenate(segments, file) {
  const list = join(out, 'segments.txt');
  // ffmpeg reads names relative to the list, so the folder's own name needs no quoting.
  await writeFile(list, segments.map((segment) => `file '${basename(segment)}'\n`).join(''));
  await execute('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-c',
    'copy',
    file,
  ]);
  await rm(list);
}

// GitHub shows a README image at most about 900 px wide, so a wider GIF only adds
// download size. Width and frame rate step down until the file is under GitHub's limit.
// A frame that matches the one before it is dropped and the earlier one held, so a
// still screen costs little. One frame a second is kept, or the end hold would go.
async function shrink(video, file) {
  for (const [width, fps] of [
    [960, 10],
    [800, 8],
  ]) {
    await execute('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      video,
      '-vf',
      `fps=${fps},mpdecimate=max=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-fps_mode',
      'vfr',
      file,
    ]);
    const { size } = await stat(file);

    if (size <= gifLimit) {
      return { file, width, fps, bytes: size };
    }
  }

  throw new Error('Even an 800 px GIF is over 10 MB. Shorten the clip, such as with fewer steps.');
}
