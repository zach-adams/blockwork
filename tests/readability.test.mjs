import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import config from '../oxlint.config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const oxlint = join(root, 'node_modules/oxlint/bin/oxlint');
const oxfmt = join(root, 'node_modules/oxfmt/bin/oxfmt');

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'blockwork-style-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'src'));
  const file = join(directory, 'src/fixture.ts');
  writeFileSync(file, source);
  const configPath = join(directory, '.oxlintrc.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      jsPlugins: config.jsPlugins.map((plugin) => ({
        ...plugin,
        specifier: resolve(root, plugin.specifier),
      })),
      overrides: config.overrides.map((override) => ({
        ...override,
        files: ['**/*.ts'],
      })),
    }),
  );

  return { directory, file, configPath };
}

function lint(input, fix = false) {
  const args = [oxlint, '--config', input.configPath, '--format', 'json', 'src/fixture.ts'];

  if (fix) {
    args.push('--fix');
  }

  const result = spawnSync(process.execPath, args, { cwd: input.directory, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);

  return JSON.parse(result.stdout).diagnostics;
}

test('named top-level functions require declarations while local closures remain valid', (t) => {
  const input = fixture(
    t,
    `
export const double = (value: number) => value * 2;
export const triple = function (value: number) { return value * 3; };
export function apply(values: number[]) {
  const increment = (value: number) => value + 1;

  return values.map(increment);
}
`,
  );

  const diagnostics = lint(input).filter(
    (entry) => entry.code === 'readability(top-level-functions)',
  );

  assert.equal(diagnostics.length, 2);
});

test('Google conventions apply to application modules', (t) => {
  const input = fixture(
    t,
    `
export type Entry = { title: string };
export interface bad_type { title: string; }
export const bad__name = 1;
export default function choose(value: any, flag: boolean) {
  if (flag) return value ? 'first' : flag ? 'second' : 'third';

  return value == null;
}
`,
  );

  const codes = new Set(lint(input).map((entry) => entry.code));

  for (const code of [
    'typescript(consistent-type-definitions)',
    'import(no-default-export)',
    'typescript(no-explicit-any)',
    'eslint(curly)',
    'eslint(no-nested-ternary)',
    'eslint(eqeqeq)',
    'eslint(id-match)',
    'readability(type-names)',
  ]) {
    assert.ok(codes.has(code), `Missing diagnostic ${code}`);
  }
});

test('spacing fixes group declarations, preserve comments, and agree with Oxfmt', (t) => {
  const input = fixture(
    t,
    `
export const path = [0];

// Keep this explanation.
export const name = 'core/paragraph';

export const targetBlock = {
  path,
  name,
};
export function selection() {
  const selected = targetBlock.path;
  return { start: 0, end: selected.length };
}
`,
  );

  assert.ok(lint(input).some((entry) => entry.code === 'readability(statement-spacing)'));
  const args = [oxfmt, '--config', join(root, '.oxfmtrc.json'), input.file];
  const formatted = spawnSync(process.execPath, args, { cwd: input.directory, encoding: 'utf8' });
  assert.equal(formatted.status, 0, formatted.stderr);
  assert.deepEqual(lint(input, true), []);
  assert.deepEqual(lint(input), []);
  const source = readFileSync(input.file, 'utf8');
  assert.ok(source.includes('// Keep this explanation.'));
  assert.ok(source.includes("export const name = 'core/paragraph';\nexport const targetBlock"), source);
  assert.ok(source.includes('export const targetBlock = { path, name };'));
  assert.ok(source.includes('export const targetBlock = { path, name };\n\nexport function'));
  assert.ok(source.includes('const selected = targetBlock.path;\n\n  return'));
  const repeated = spawnSync(process.execPath, args, { cwd: input.directory, encoding: 'utf8' });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(input.file, 'utf8'), source);
});

test('WordPress property names and destructured bindings keep their external spelling', (t) => {
  const input = fixture(
    t,
    `
export interface Entry {
  post_type: string;
}

export function post_type(entry: Entry) {
  const { post_type } = entry;

  return post_type;
}
`,
  );

  assert.deepEqual(lint(input), []);
});
