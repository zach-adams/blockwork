import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { Readable } from 'node:stream';

import { summarize } from './reporter.mjs';

import { forwardToTestHost } from '../../tools/test-host.mjs';

const repository = resolve(fileURLToPath(import.meta.url), '../../..');

export async function main(args = process.argv.slice(2), fixtureFiles) {
  const files = [];
  const findings = [];
  let pattern;
  let skipPattern;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--finding' || arg.startsWith('--finding=')) {
      const value = arg === '--finding' ? args[++i] : arg.slice(10);

      if (!value) throw new Error('--finding needs a comma-separated list of slugs');
      findings.push(...value.split(','));
    } else if (arg === '--test-name-pattern' || arg.startsWith('--test-name-pattern=')) {
      pattern = arg === '--test-name-pattern' ? args[++i] : arg.slice(20);

      if (pattern === undefined) throw new Error('--test-name-pattern needs a pattern');
      new RegExp(pattern);
    } else if (arg === '--test-skip-pattern' || arg.startsWith('--test-skip-pattern=')) {
      skipPattern = arg === '--test-skip-pattern' ? args[++i] : arg.slice(20);

      if (skipPattern === undefined) throw new Error('--test-skip-pattern needs a pattern');
      new RegExp(skipPattern);
    } else if (arg.endsWith('.test.mjs')) files.push(resolve(repository, arg));
    else throw new Error(`Unknown argument ${arg}`);
  }

  const all =
    fixtureFiles ??
    readdirSync(resolve(repository, 'tests/editing'))
      .filter((name) => name.endsWith('.test.mjs'))
      .map((name) => resolve(repository, 'tests/editing', name));
  const catalog = new Map();

  for (const file of all) {
    const child = spawnSync(
      process.execPath,
      [resolve(repository, 'tests/editing/collect.mjs'), file],
      { cwd: repository, encoding: 'utf8', env: { ...process.env, BLOCKWORK_COLLECT: '1' } },
    );

    if (child.status !== 0)
      throw new Error(`Collection failed for ${file}: ${child.stderr.slice(0, 2000)}`);
    catalog.set(file, JSON.parse(child.stdout));
  }

  const slugs = (entries) =>
    entries.flatMap((entry) => [
      ...(entry.findings || []),
      ...(String(entry.todo).startsWith('finding: ') ? [entry.todo.slice(9)] : []),
    ]);
  const known = [...new Set([...catalog.values()].flatMap(slugs))].sort();
  const unknown = findings.filter((slug) => !known.includes(slug));

  if (unknown.length)
    throw new Error(
      `Unknown findings: ${unknown.join(', ')}. Known findings: ${known.join(', ') || '(none)'}`,
    );
  let selected = files.length ? files : all;

  if (findings.length)
    selected = selected.filter(
      (file) =>
        catalog.has(file) && slugs(catalog.get(file)).some((slug) => findings.includes(slug)),
    );

  if (!selected.length) throw new Error('No files match the selection');

  const compile = fixtureFiles
    ? { status: 0 }
    : spawnSync(process.execPath, ['tools/compile.mjs'], { cwd: repository, stdio: 'inherit' });

  if (compile.status !== 0) process.exit(compile.status ?? 1);
  process.env.BLOCKWORK_FINDINGS = JSON.stringify(findings);

  if (pattern !== undefined) process.env.BLOCKWORK_PATTERN = pattern;

  if (skipPattern !== undefined) process.env.BLOCKWORK_SKIP_PATTERN = skipPattern;
  const children = new Set();
  const results = [];

  async function* report() {
    for await (const event of run({ files: selected, concurrency: 2, execArgv: [] })) {
      if (event.type === 'test:enqueue' && event.data.parentId)
        children.add(`${event.data.entryFile}:${event.data.parentId}`);

      if (event.type === 'test:pass' || event.type === 'test:fail') results.push(event);
      yield event;
    }
  }

  for await (const chunk of Readable.from(report()).compose(spec)) process.stdout.write(chunk);
  const { errors, count } = summarize(results, children, findings);

  console.log(`Executed cases: ${count}`);

  for (const error of errors) console.error(error);

  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  forwardToTestHost('tests/editing/run.mjs', { sync: true });
  await main();
}
