import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function events(file, collect = false) {
  const script = `import { run } from 'node:test';
    process.execArgv = [];
    for await (const event of run({ files: [process.argv[2]], execArgv: [] })) console.log(JSON.stringify(event));`;
  const env = {
    ...process.env,
    BLOCKWORK_COLLECT: collect ? '1' : '',
    BLOCKWORK_FINDINGS: JSON.stringify(['computed']),
    BLOCKWORK_PATTERN: 'matrix wanted',
  };
  delete env.NODE_TEST_CONTEXT;
  const runner = join(file, '..', 'runner.mjs');
  writeFileSync(runner, script);
  const child = spawnSync(process.execPath, [runner, file], { encoding: 'utf8', env });
  assert.equal(child.status, 0, child.stderr);

  const result = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    result.filter((event) => event.type === 'test:fail' && !event.data.todo),
    [],
  );

  return result;
}

test('collects computed marks and runs only a selected generated leaf with cleanup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blockwork-selection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.mjs');
  const helper = pathToFileURL(join(process.cwd(), 'tests/editing/cases.mjs')).href;
  await writeFile(
    file,
    `
import { editingTests } from ${JSON.stringify(helper)};
const { before, after, describe, test, generated, run } = editingTests(import.meta.url);
before(() => console.log('SETUP'));
after(() => console.log('CLEANUP'));
describe('group', () => {
  generated('unmarked', () => { throw new Error('unselected group ran'); });
  for (const name of ['one', 'two']) test(name, { todo: name === 'two' ? 'finding: computed' : false }, () => console.log('OTHER'));
  generated('matrix', { findings: ['computed'] }, async (t) => {
    t.diagnostic('DISCOVERED');
    if (!t.selected('wanted', { todo: 'finding: computed' }) || t.selected('other', { todo: 'finding: computed' })) throw new Error('selection mismatch');
    const result = await t.test('wanted', { todo: 'finding: computed' }, () => { console.log('WANTED'); return 42; });
    if (!result.selected || !result.completed || result.value !== 42) throw new Error('wrong result');
    const skipped = await t.test('other', { todo: 'finding: computed' }, () => console.log('OTHER'));
    if (skipped.selected || skipped.completed) throw new Error('wrong skipped result');
  });
});
run();
`,
  );
  const collected = events(file);
  const output = collected
    .filter((event) => event.type === 'test:stdout')
    .map((event) => event.data.message)
    .join('');
  assert.match(output, /SETUP/);
  assert.match(output, /WANTED/);
  assert.match(output, /CLEANUP/);
  assert.ok(
    collected.some(
      (event) => event.type === 'test:diagnostic' && event.data.message === 'DISCOVERED',
    ),
  );
  assert.doesNotMatch(output, /OTHER/);
  assert.ok(
    collected.some(
      (event) => event.type === 'test:pass' && event.data.name === 'group matrix wanted',
    ),
  );
  const collection = events(file, true);
  const text = collection
    .filter((event) => event.type === 'test:stdout')
    .map((event) => event.data.message)
    .join('');
  const metadata = JSON.parse(text);
  assert.equal(metadata[2].todo, 'finding: computed');
  assert.deepEqual(metadata[3].findings, ['computed']);
  assert.doesNotMatch(text, /SETUP|CLEANUP|WANTED|OTHER/);
});

test('reports actual passing, failing, skipped and missing finding events', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blockwork-events-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.mjs');
  await writeFile(
    file,
    `
import { test } from 'node:test';
test('container', async (t) => {
  await t.test('stale', { todo: 'finding: stale' }, () => {});
  await t.test('expected', { todo: 'finding: expected' }, () => { throw new Error('expected'); });
  await t.test('skipped', { skip: true }, () => {});
});
`,
  );
  const output = events(file);
  const { summarize } = await import('./editing/reporter.mjs');
  const children = new Set(
    output
      .filter((event) => event.type === 'test:enqueue' && event.data.parentId)
      .map((event) => `${event.data.entryFile}:${event.data.parentId}`),
  );
  const results = output.filter(
    (event) => event.type === 'test:pass' || event.type === 'test:fail',
  );
  const { errors, count } = summarize(results, children, ['stale', 'expected', 'missing']);
  assert.equal(count, 2);
  assert.ok(errors.some((error) => error.includes('Stale finding passed: finding: stale')));
  assert.ok(errors.some((error) => error.includes('No test case produced finding: missing')));
  assert.ok(!errors.some((error) => error.includes('finding: expected')));
});

test('runner CLI selects and reports real fixture events', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blockwork-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = pathToFileURL(join(process.cwd(), 'tests/editing/cases.mjs')).href;
  const runner = pathToFileURL(join(process.cwd(), 'tests/editing/run.mjs')).href;
  const file = join(dir, 'fixture.test.mjs');
  const entry = join(dir, 'cli.mjs');
  await writeFile(
    entry,
    `import { main } from ${JSON.stringify(runner)}; await main(process.argv.slice(2), [${JSON.stringify(file)}]);`,
  );
  await writeFile(
    file,
    `
import { editingTests } from ${JSON.stringify(helper)};
const { before, after, test, run } = editingTests(import.meta.url);
before(() => { if (process.env.FAIL_SETUP) throw new Error('setup'); });
after(() => { console.log('CLEANUP_RAN'); if (process.env.FAIL_CLEANUP) throw new Error('cleanup'); });
test('ordinary', () => {});
test('skipped', { skip: true }, () => {});
test('stale name', { todo: 'finding: stale' }, () => {});
test('expected name', { todo: 'finding: expected' }, () => { throw new Error('expected'); });
run();
`,
  );

  function cli(args = [], env = {}) {
    const cleanEnv = { ...process.env, ...env };
    delete cleanEnv.NODE_TEST_CONTEXT;
    delete cleanEnv.BLOCKWORK_COLLECT;
    delete cleanEnv.BLOCKWORK_FINDINGS;
    delete cleanEnv.BLOCKWORK_PATTERN;
    delete cleanEnv.BLOCKWORK_SKIP_PATTERN;

    return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env: cleanEnv });
  }

  const noMatch = cli(['--test-name-pattern', 'absent']);
  assert.notEqual(noMatch.status, 0);
  assert.match(noMatch.stderr, /No test cases matched/);
  assert.match(noMatch.stdout, /Executed cases: 0/);
  const unknown = cli(['--finding', 'unknown']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Known findings: expected, stale/);

  for (const args of [[], ['--finding', 'stale'], ['--test-name-pattern', 'stale name']]) {
    const result = cli(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Stale finding passed: finding: stale \(stale name\)/);
  }

  const expected = cli(['--finding', 'expected']);
  assert.equal(expected.status, 0, expected.stderr);
  assert.match(expected.stdout, /Executed cases: 1/);
  const skippedByPattern = cli(['--test-skip-pattern', 'stale']);
  assert.equal(skippedByPattern.status, 0, skippedByPattern.stderr);
  assert.match(skippedByPattern.stdout, /Executed cases: 2/);
  const full = cli();
  assert.match(full.stdout, /Executed cases: 3/);

  for (const variable of ['FAIL_SETUP', 'FAIL_CLEANUP']) {
    const result = cli(['--test-name-pattern', 'ordinary'], { [variable]: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /CLEANUP_RAN/);
    assert.match(result.stderr, /setup or cleanup failed/);
  }
});

test('generated leaves filter shared work and report failures truthfully', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blockwork-generated-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const helper = pathToFileURL(join(process.cwd(), 'tests/editing/cases.mjs')).href;
  const runner = pathToFileURL(join(process.cwd(), 'tests/editing/run.mjs')).href;
  const file = join(dir, 'fixture.test.mjs');
  const entry = join(dir, 'cli.mjs');
  await writeFile(
    entry,
    `import { main } from ${JSON.stringify(runner)}; await main(process.argv.slice(2), [${JSON.stringify(file)}]);`,
  );
  await writeFile(
    file,
    `
import { editingTests } from ${JSON.stringify(helper)};
const { generated, run } = editingTests(import.meta.url);
generated('matrix', { findings: ['stale', 'expected'] }, async (t) => {
  const options = { todo: 'finding: stale' };
  if (!t.selected('pass', options) && !t.selected('fail', { todo: 'finding: expected' })) return;
  console.log('SHARED_SETUP');
  const passed = await t.test('pass', options, () => { console.log('PASS_BODY'); return 42; });
  if (passed.selected && (!passed.completed || passed.value !== 42)) throw new Error('bad passed result');
  const failed = await t.test('fail', { todo: 'finding: expected' }, () => { console.log('FAIL_BODY'); throw new Error('native leaf error'); });
  if (failed.selected && failed.completed) throw new Error('failed leaf completed');
  if (process.env.FAIL_PERSISTENCE) throw new Error('shared persistence failed');
});
run();
`,
  );

  function cli(args, extra = {}) {
    const env = { ...process.env, ...extra };
    delete env.NODE_TEST_CONTEXT;
    delete env.BLOCKWORK_COLLECT;
    delete env.BLOCKWORK_FINDINGS;
    delete env.BLOCKWORK_PATTERN;
    delete env.BLOCKWORK_SKIP_PATTERN;

    return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env });
  }

  const none = cli(['--test-name-pattern', 'absent']);
  assert.notEqual(none.status, 0);
  assert.doesNotMatch(none.stdout, /SHARED_SETUP/);
  const one = cli(['--finding', 'expected']);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /SHARED_SETUP/);
  assert.match(one.stdout, /FAIL_BODY/);
  assert.doesNotMatch(one.stdout, /PASS_BODY/);
  const failure = cli([], { FAIL_PERSISTENCE: '1' });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Stale finding passed: finding: stale/);
  assert.match(failure.stderr, /test or its setup or cleanup failed/);
});
