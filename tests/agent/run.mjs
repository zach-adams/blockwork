import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

import {
  changedPaths,
  reopen,
  seedDocument,
  startEditingSite,
  storedDocument,
  storedTree,
} from '../editing/harness.mjs';
import { forwardToTestHost } from '../../tools/test-host.mjs';
import { tasks } from './tasks.mjs';

// Runs natural-language requests through the real desktop app against a disposable
// Playground site, then scores what the agent saved. It spends the signed-in
// account's usage, so it never runs from `pnpm check` or CI.

forwardToTestHost('tests/agent/run.mjs', { sync: true, collect: 'artifacts/agent-tasks' });

const execute = promisify(execFile);
const repository = resolve(fileURLToPath(import.meta.url), '../../..');
const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'gpt-6.1-terra' },
    effort: { type: 'string', default: 'medium' },
    only: { type: 'string' },
    level: { type: 'string' },
    out: { type: 'string' },
    timeout: { type: 'string', default: '600' },
    // Seeds each task and checks it opens clean, without the app or any model usage.
    dry: { type: 'boolean', default: false },
  },
});
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = values.out ?? join(repository, 'artifacts/agent-tasks', `${stamp}-${values.model}`);
const chosen = tasks.filter(
  (task) =>
    (!values.only || values.only.split(',').includes(task.id)) &&
    (!values.level || values.level.split(',').includes(task.level)),
);

const desktop = async (deadline, ...args) => {
  const { stdout } = await execute('node', ['tools/desktop-test.mjs', ...args], {
    cwd: repository,
    timeout: deadline * 1000,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error) => {
    const message = error.killed ? `did not finish within ${deadline} s.` : `failed: ${error.stderr}`;
    throw new Error(`tools/desktop-test.mjs ${args[0]} ${message}`, { cause: error });
  });

  return JSON.parse(stdout);
};

const preamble =
  "Use Blockwork in the in-app browser. Don't use WP-CLI, SSH, or the site's files on disk. I'm already signed in.";

if (chosen.length === 0) {
  throw new Error('No task matches --only or --level.');
}

await mkdir(out, { recursive: true });

const scratch = await mkdtemp(join(tmpdir(), 'blockwork-agent-'));
// Yoast SEO stays inactive until the seo-title task turns it on.
const site = await startEditingSite({ install: ['wordpress-seo'] });
const results = [];
let appStarted = false;

try {
  const cookies = join(scratch, 'cookies.json');
  await writeFile(cookies, JSON.stringify(await site.authCookies()), { mode: 0o600 });

  if (values.dry) {
    for (const task of chosen) {
      const prepared = await task.setup(site);
      const id = prepared.id ?? (await seedDocument(site, prepared));
      const seeded = await reopen(site, id);
      const stored = await storedDocument(site, id);
      const clean =
        (task.allowInvalid || seeded.invalid.length === 0) &&
        !seeded.dirty &&
        seeded.content === stored.content;

      process.exitCode ||= clean ? 0 : 1;
      console.log(
        `${clean ? 'CLEAN' : 'SEED PROBLEM'} ${task.id} ${JSON.stringify({ invalid: seeded.invalid, dirty: seeded.dirty, same: seeded.content === stored.content })}`,
      );
    }
  } else {
    await desktop(
      600,
      'start',
      '--blockwork',
      '--model',
      values.model,
      '--effort',
      values.effort,
      '--site',
      `${site.site}/`,
      '--cookies',
      cookies,
    ).catch((error) => { appStarted = Boolean(error.cause?.killed); throw error; });
    appStarted = true;
  }

  for (const task of values.dry ? [] : chosen) {
    const record = { id: task.id, level: task.level, source: task.source };
    const started = Date.now();
    let runKilled = false;

    try {
      const prepared = await task.setup(site);
      const id = prepared.id ?? (await seedDocument(site, prepared));
      const link = `${site.site}/?${prepared.type === 'post' ? 'p' : 'page_id'}=${id}`;
      const before = await storedDocument(site, id);
      const beforeTree = await storedTree(site, id);
      const prompt = `${task.prompt({ link, id, site: site.site, ...prepared })}\n\n${preamble}`;
      record.prompt = prompt;
      const run = await desktop(Number(values.timeout) + 120, 'run', '--timeout', values.timeout, prompt);
      record.run = {
        status: run.status,
        seconds: run.duration_seconds,
        tool_calls: run.tool_calls,
        tokens: run.tokens,
        final_message: run.final_message,
      };

      if (run.rollout) {
        await copyFile(run.rollout, join(out, `${task.id}.rollout.jsonl`));
      }

      const after = await storedDocument(site, id);
      const afterTree = await storedTree(site, id);
      const reopened = await reopen(site, id).catch((error) => ({ error: error.message }));
      const changed = changedPaths(beforeTree, afterTree);
      const failures = [];
      const declined = [];

      const expect = (ok, message) => {
        if (!ok) {
          failures.push(message);
        }
      };

      // What every request has to respect, whatever it asked for.
      expect(
        reopened.error === undefined && (task.allowInvalid || reopened.invalid.length === 0),
        `invalid blocks after reopening: ${JSON.stringify(reopened.invalid ?? reopened.error)}`,
      );
      expect(reopened.dirty === false, 'the saved document opens dirty');
      expect(
        reopened.content === after.content,
        'the editor does not reproduce the stored content',
      );
      expect(after.editor_mode !== 'text', 'the agent left the account in Code Mode');

      if (!task.allowStatusChange) {
        expect(
          after.status === before.status,
          `status changed from ${before.status} to ${after.status}`,
        );
      }

      for (const field of ['title', 'slug', 'excerpt', 'parent', 'menu_order', 'author', 'date']) {
        if (!task.allowFields?.includes(field)) {
          expect(
            after[field] === before[field],
            `${field} changed from ${before[field]} to ${after[field]}`,
          );
        }
      }

      for (const key of new Set([...Object.keys(before.meta), ...Object.keys(after.meta)])) {
        if (task.allowMeta !== true && !task.allowMeta?.includes(key)) {
          expect(
            JSON.stringify(before.meta[key]) === JSON.stringify(after.meta[key]),
            `meta ${key} changed`,
          );
        }
      }

      if (task.allowedPaths && !task.allowedPaths.some((pattern) => pattern === '*')) {
        const unexpected = changed.filter(
          (path) =>
            !task.allowedPaths.some(
              (pattern) => path === pattern || path.startsWith(`${pattern}.`),
            ),
        );
        expect(
          unexpected.length === 0,
          `blocks outside the request changed: ${unexpected.join(', ')}`,
        );
      }

      // A check calls decline when the agent honestly reported it couldn't do the request.
      const decline = (reason) => {
        expect(
          after.content === before.content,
          'a declined request must leave the page unchanged',
        );
        declined.push(reason);
      };

      await task.check({
        before,
        after,
        beforeTree,
        afterTree,
        changed,
        expect,
        decline,
        final: run.final_message ?? '',
        site,
        id,
        prepared,
      });
      record.changed = changed;
      record.failures = failures;
      record.declined = declined;
      record.passed = failures.length === 0 && run.status === 'completed';
      await writeFile(join(out, `${task.id}.after.html`), after.content);
    } catch (error) {
      runKilled = Boolean(error.cause?.killed);
      record.passed = false;
      record.harness_error = error.stack ?? String(error);
    }

    // Code Mode left on by one chat would otherwise fail the next one.
    await site.php("delete_user_meta(1, 'wp_persisted_preferences');");

    record.wall_seconds = Math.round((Date.now() - started) / 1000);
    results.push(record);
    await writeFile(join(out, `${task.id}.json`), JSON.stringify(record, null, 2));
    const verdict = record.passed ? (record.declined?.length ? 'DECLINED' : 'PASS') : 'FAIL';

    console.log(
      `${verdict} ${task.id} ${record.run?.seconds ?? '?'}s ${record.run?.tool_calls ?? '?'} calls ${[...(record.failures ?? []), ...(record.declined ?? [])].join(' | ') || record.harness_error || ''}`,
    );

    // That chat may still be saving, so the next task can't start beside it.
    if (runKilled || record.run?.status === 'running') {
      console.log(`${task.id} outlasted --timeout, so the run stops here.`);
      break;
    }
  }
} finally {
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));

  // Another run may own an app that was already running, so stop only this run's.
  if (appStarted) {
    await desktop(120, 'stop').catch((error) => console.error(error.message));
  }

  await site[Symbol.asyncDispose]();
  await rm(scratch, { recursive: true, force: true });
}

const passed = results.filter((record) => record.passed).length;
const honest = results.filter((record) => record.declined?.length).length;

process.exitCode ||= passed === results.length ? 0 : 1;
console.log(
  `${passed} of ${results.length} passed, ${honest} of them by honestly declining. Results: ${out}`,
);
