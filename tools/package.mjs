import { copyFile, cp, mkdir, readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundles } from './bundle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A release package by default. --development keeps failures' `debug` details
// for local installs; never send or upload that package.
const development = process.argv.includes('--development');
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));

if (manifest.name !== 'blockwork' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error('Invalid package identity');
}

if (manifest.extensions['com.openai'].interface.shortDescription.length > 30) {
  throw new Error('Subtitle exceeds 30 characters');
}

const files = [
  'plugin.json',
  'LICENSE',
  'skills/blockwork/SKILL.md',
  'skills/blockwork/references/invocation.md',
  'skills/blockwork/references/inspection.md',
  'skills/blockwork/references/edit.md',
  'skills/blockwork/references/saving.md',
  'skills/blockwork/references/documents.md',
  'skills/blockwork/references/media.md',
  'skills/blockwork/references/resource-writes.md',
  'skills/blockwork/references/shared-and-abilities.md',
  'skills/blockwork/references/active-editors.md',
  'skills/blockwork/references/styling.md',
  'skills/blockwork/references/recovery.md',
];
const scripts = 'skills/blockwork/scripts';

const temporary = execFileSync(
  'mktemp',
  ['-d', join(process.env.TMPDIR || '/tmp', 'blockwork-package-XXXXXX')],
  { encoding: 'utf8' },
).trim();

const output = join(
  root,
  'dist',
  `blockwork-${manifest.version}${development ? '-development' : ''}.tar.gz`,
);
const local = join(root, 'dist', 'blockwork');

try {
  for (const file of files) {
    const source = join(root, file);

    if (!(await lstat(source)).isFile()) {
      throw new Error(`Expected regular file: ${file}`);
    }

    const destination = join(temporary, 'blockwork', file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  // Bundled here rather than copied, so the mode cannot come from a stale compile.
  const { editor, invoker, bootstrap } = await bundles({ debug: development });
  await mkdir(join(temporary, 'blockwork', scripts), { recursive: true });
  await writeFile(join(temporary, 'blockwork', scripts, 'editor.js'), editor);
  await writeFile(join(temporary, 'blockwork', scripts, 'invoke.mjs'), invoker);
  await writeFile(join(temporary, 'blockwork', scripts, 'bootstrap.mjs'), bootstrap);

  await mkdir(dirname(output), { recursive: true });
  execFileSync('tar', ['-czf', output, '-C', temporary, 'blockwork'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });

  const entries = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((entry) => !entry.endsWith('/'));

  const expected = [
    ...files,
    `${scripts}/editor.js`,
    `${scripts}/invoke.mjs`,
    `${scripts}/bootstrap.mjs`,
  ]
    .map((file) => `blockwork/${file}`)
    .sort();

  if (JSON.stringify(entries.sort()) !== JSON.stringify(expected)) {
    throw new Error('Unexpected archive contents');
  }

  await rm(local, { recursive: true, force: true });
  await cp(join(temporary, 'blockwork'), local, { recursive: true });
  console.log(
    `${local}\n${output}\n${development ? 'Development' : 'Release'} build. ${entries.length} allowlisted files. No fixture, credentials, or development dependencies.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
