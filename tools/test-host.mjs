import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keeps heavy tests and the desktop test app off a Mac someone is using. This file
// holds the SSH host of the Mac that runs them instead. Without it, they run here.
const hostFile = join(homedir(), '.config/blockwork/test-host');
const repository = resolve(fileURLToPath(import.meta.url), '../..');
// Relative to the SSH home. It is a copy because that Mac's own checkout may hold other work.
const copy = '.cache/blockwork-tests';
const excluded = ['/.git', '/node_modules', '/dist', '/artifacts'];

/**
 * Runs the calling script on the test host, if this Mac has one, and exits with its status.
 * Standard output stays the remote script's, because callers parse it as JSON.
 */
export function forwardToTestHost(script, { sync = false, collect } = {}) {
  // Set by a caller that must run here, such as one recording this Mac's screen.
  if (!existsSync(hostFile) || process.env.BLOCKWORK_TEST_HERE) {
    return;
  }

  const host = readFileSync(hostFile, 'utf8').trim();
  const step = (command, ...args) =>
    spawnSync(command, args, { cwd: repository, stdio: ['ignore', 2, 2] }).status === 0;

  if (sync) {
    const copied =
      step(
        'rsync',
        '-a',
        '--delete',
        ...[...excluded, ...locallyExcluded()].map((path) => `--exclude=${path}`),
        './',
        `${host}:${copy}/`,
      ) &&
      // The project's prepare script sets a Git hook path, so it needs a repository.
      step('ssh', host, `cd ${copy} && git init -q && pnpm install --frozen-lockfile`);

    if (!copied) {
      console.error(
        `Could not copy this checkout to ${host}, which ${hostFile} names as the Mac for tests. Check that it is awake and reachable over SSH, or remove that file to test on this Mac.`,
      );
      process.exit(1);
    }
  }

  const args = process.argv
    .slice(2)
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(' ');
  const { status } = spawnSync('ssh', [host, `cd ${copy} && node ${script} ${args}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (collect) {
    mkdirSync(join(repository, collect), { recursive: true });
    const moved = step(
      'rsync',
      '-a',
      '--remove-source-files',
      `${host}:${copy}/${collect}/`,
      `${collect}/`,
    );

    console.error(
      moved
        ? `Ran on ${host}. The results above are now in ${collect}/ on this Mac.`
        : `Ran on ${host}. Copying the results back failed, so they are still in ~/${copy}/${collect}/ on ${host}.`,
    );
  }

  process.exit(status ?? 1);
}

// The paths that this checkout's own Git exclude file hides, as Git resolves them,
// because rsync reads some gitignore patterns differently.
function locallyExcluded() {
  const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
  const file = git('rev-parse', '--path-format=absolute', '--git-path', 'info/exclude').trim();

  if (!existsSync(file)) {
    return [];
  }

  return git('ls-files', '-z', '--others', '--ignored', '--directory', `--exclude-from=${file}`)
    .split('\0')
    .filter(Boolean)
    .map((path) => `/${path}`);
}
