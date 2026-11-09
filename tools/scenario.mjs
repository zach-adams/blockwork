import { runCLI } from '@wp-playground/cli';
import { execFile } from 'node:child_process';
import { constants, rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Development-only scenario snapshots. `capture` trims a local WordPress site
// from ~/.config/blockwork/scenarios.json into artifacts/scenarios/<name>; `up` boots a
// disposable Playground copy. Snapshots hold site content: keep them out of
// Git and plugin packages. Capture runs WP-CLI on the source with plugins and
// themes skipped and never changes its content.

const root = resolve(fileURLToPath(import.meta.url), '../..');
const assets = join(root, 'tools/scenario');
const snapshots = join(root, 'artifacts/scenarios');
const execute = promisify(execFile);
const clone = { recursive: true, mode: constants.COPYFILE_FICLONE };
// Never needed to render or edit, or credentials. `.env*` files are skipped too.
// Theme entries are paths from the theme root.
const alwaysExclude = ['.git', 'node_modules', '.DS_Store', 'auth.json'];
const themeExclude = ['.github', '.agents', 'docs', 'tests'];
const mediaPostTypes = [
  'wp_block',
  'wp_global_styles',
  'wp_navigation',
  'wp_template',
  'wp_template_part',
  'custom_css',
];
const dropPostTypes = ['revision', 'customize_changeset', 'oembed_cache'];

// Row counts let the snapshot verify its import; these tables stay still while idle.
const siteInfo = `global $wpdb;
$content_tables = ['posts', 'postmeta', 'users', 'usermeta', 'terms', 'term_taxonomy', 'term_relationships'];
echo wp_json_encode([
  'wordpress' => get_bloginfo('version'),
  'php' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
  'multisite' => is_multisite(),
  'prefix' => $wpdb->prefix,
  'tables' => $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($wpdb->prefix) . '%')),
  'rows' => array_combine(
    array_map(fn ($table) => $wpdb->prefix . $table, $content_tables),
    array_map(fn ($table) => (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}$table"), $content_tables)
  ),
  'content_dir' => WP_CONTENT_DIR,
  'template' => get_option('template'),
  'stylesheet' => get_option('stylesheet'),
  'themes' => array_values(array_unique([get_template_directory(), get_stylesheet_directory()])),
  'plugins' => array_map(fn ($plugin) => WP_PLUGIN_DIR . '/' . (dirname($plugin) === '.' ? $plugin : dirname($plugin)), (array) get_option('active_plugins')),
  'uploads_dir' => wp_get_upload_dir()['basedir'],
  'uploads_url' => wp_get_upload_dir()['baseurl'],
]), "\\n";`;

const usage = `Usage:
  node tools/scenario.mjs list
  node tools/scenario.mjs capture <name>         Build artifacts/scenarios/<name> from ~/.config/blockwork/scenarios.json
  node tools/scenario.mjs up <name> [--port <n>]  Boot a disposable copy; Ctrl-C discards it`;

const [command, name, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'list':
      await list();
      break;
    case 'capture':
      await capture(await scenario(name));
      break;
    case 'up':
      await up(name, Number(option(args, '--port') ?? 0));
      break;
    default:
      throw new Error(usage);
  }
} catch (error) {
  console.error(error.message);
  // Playground workers can outlive a failed boot; exiting runs the cleanup handlers.
  process.exit(1);
}

async function list() {
  const rows = [];

  for (const entry of (await config()).scenarios) {
    const snapshot = await readSnapshot(entry.name).catch(() => undefined);

    rows.push({
      name: entry.name,
      source: entry.source.url,
      captured_at: snapshot?.captured_at ?? null,
      pages: snapshot?.pages ?? entry.pages,
    });
  }

  console.log(JSON.stringify(rows, null, 2));
}

async function capture(entry) {
  const started = performance.now();
  const work = await mkdtemp(join(tmpdir(), `blockwork-scenario-${entry.name}-`));
  const staging = join(snapshots, `.${entry.name}-staging`);
  const content = join(staging, 'wp-content');

  // The dump holds unscrubbed site data. Exit handlers also run on Ctrl-C and
  // after errors; on success the staging directory has already been renamed.
  process.once('exit', () => {
    rmSync(work, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  });
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  await rm(staging, { recursive: true, force: true });
  const site = lastJson(await wp(entry.source, ['eval', siteInfo]));

  // Playground installs with wp_ tables and serves uploads from wp-content/uploads.
  if (site.multisite || site.prefix !== 'wp_') {
    throw new Error('Capture supports single sites with the wp_ table prefix.');
  }

  if (
    site.uploads_dir !== join(site.content_dir, 'uploads') ||
    !site.uploads_url.endsWith('/wp-content/uploads')
  ) {
    throw new Error('Capture supports uploads in wp-content/uploads only.');
  }

  for (const theme of site.themes) {
    await copy(theme, join(content, 'themes', basename(theme)), [
      ...themeExclude,
      ...(entry.theme_exclude ?? []),
    ]);
  }

  for (const plugin of site.plugins) {
    await copy(plugin, join(content, 'plugins', basename(plugin)), []);
  }

  await copy(join(site.content_dir, 'fonts'), join(content, 'fonts'), []).catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
  await mkdir(join(content, 'mu-plugins'), { recursive: true });
  await cp(join(assets, 'mu-plugin.php'), join(content, 'mu-plugins/blockwork-scenario.php'));

  const media = lastJson(
    await wp(entry.source, ['eval-file', join(assets, 'media.php')], {
      BLOCKWORK_SCENARIO_MEDIA: JSON.stringify({
        pages: Object.values(entry.pages),
        post_types: [...mediaPostTypes, ...(entry.media_post_types ?? [])],
      }),
    }),
  );

  for (const file of media.files) {
    await mkdir(dirname(join(content, 'uploads', file)), { recursive: true });
    await cp(join(site.uploads_dir, file), join(content, 'uploads', file), {
      ...clone,
      dereference: true,
    });
  }

  // Relative upload URLs let one snapshot run on any Playground port.
  await wp(entry.source, [
    'search-replace',
    `${site.uploads_url}/`,
    '/wp-content/uploads/',
    '--all-tables-with-prefix',
    '--skip-columns=guid',
    `--export=${join(work, 'dump.sql')}`,
  ]);

  const report = await prepareDatabase(entry, site, content, work);

  await prune(content, site);
  const database = new DatabaseSync(join(content, 'database/.ht.sqlite'));

  database.exec('VACUUM');
  database.close();

  const snapshot = {
    name: entry.name,
    captured_at: new Date().toISOString(),
    source: entry.source,
    wordpress: site.wordpress,
    php: entry.php ?? site.php,
    user: entry.user,
    pages: { ...entry.pages, ...report.created_pages },
    media: { attachments: media.attachments, files: media.files.length },
    dropped_posts: report.dropped_posts,
    scrubbed: report.scrubbed,
  };

  await writeFile(join(staging, 'scenario.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await trash(join(snapshots, entry.name));
  await rename(staging, join(snapshots, entry.name));
  console.log(
    JSON.stringify({ ...snapshot, capture_ms: Math.round(performance.now() - started) }, null, 2),
  );
}

async function prepareDatabase(entry, site, content, work) {
  await writeFile(
    join(work, 'config.json'),
    JSON.stringify({
      user: entry.user,
      drop_post_types: [...dropPostTypes, ...(entry.drop_post_types ?? [])],
      empty_tables: entry.empty_tables ?? [],
      scrub_options: entry.scrub_options ?? [],
      create_pages: entry.create_pages ?? {},
      uploads_url: site.uploads_url,
      tables: site.tables,
      rows: site.rows,
      template: site.template,
      stylesheet: site.stylesheet,
    }),
  );

  const cli = await runCLI({
    command: 'run-blueprint',
    wp: site.wordpress,
    php: entry.php ?? site.php,
    verbosity: 'normal',
    'mount-before-install': [{ hostPath: content, vfsPath: '/wordpress/wp-content' }],
    mount: [{ hostPath: work, vfsPath: '/tmp/scenario' }],
    blueprint: {
      steps: [
        { step: 'runSql', sql: { resource: 'vfs', path: '/tmp/scenario/dump.sql' } },
        // Scrub before finish.php boots the captured plugins and theme.
        { step: 'runPHP', code: await readFile(join(assets, 'scrub.php'), 'utf8') },
        { step: 'runPHP', code: await readFile(join(assets, 'finish.php'), 'utf8') },
      ],
    },
  });

  await cli?.[Symbol.asyncDispose]?.();

  const [scrub, finish] = await Promise.all(
    ['scrub.json', 'finish.json'].map((file) =>
      readFile(join(work, file), 'utf8').then(JSON.parse, () => {
        throw new Error(
          `Snapshot preparation stopped before ${file}. Read the Playground output above.`,
        );
      }),
    ),
  );

  return { ...scrub, ...finish };
}

// The WordPress installer adds default themes and plugins; Acorn caches views.
async function prune(content, site) {
  const kept = {
    themes: new Set([...site.themes.map((path) => basename(path)), 'index.php']),
    plugins: new Set([...site.plugins.map((path) => basename(path)), 'index.php']),
  };

  for (const [directory, names] of Object.entries(kept)) {
    for (const entry of await readdir(join(content, directory))) {
      if (!names.has(entry)) {
        await rm(join(content, directory, entry), { recursive: true, force: true });
      }
    }
  }

  await rm(join(content, 'cache'), { recursive: true, force: true });
}

async function up(name, port) {
  const snapshot = await readSnapshot(name);
  const started = performance.now();
  const run = await mkdtemp(join(tmpdir(), `blockwork-scenario-${name}-run-`));
  const stopped = new Promise((settle) => {
    process.once('SIGINT', settle);
    process.once('SIGTERM', settle);
  });

  // Also runs when Ctrl-C arrives before Playground finishes booting.
  process.once('exit', () => rmSync(run, { recursive: true, force: true }));
  await cp(join(snapshots, name, 'wp-content'), join(run, 'wp-content'), clone);

  const cli = await Promise.race([
    runCLI({
      command: 'server',
      wp: snapshot.wordpress,
      php: snapshot.php,
      port,
      // Concurrent native Heartbeat and editor requests use Playground's recommended pool.
      workers: 6,
      verbosity: 'quiet',
      'mount-before-install': [
        { hostPath: join(run, 'wp-content'), vfsPath: '/wordpress/wp-content' },
      ],
      blueprint: { steps: [{ step: 'login', username: snapshot.user }] },
    }),
    stopped,
  ]);

  if (cli) {
    const site = cli.serverUrl;
    const pages = Object.fromEntries(
      Object.entries(snapshot.pages).map(([key, id]) => [
        key,
        { id, editor: `${site}/wp-admin/post.php?post=${id}&action=edit` },
      ]),
    );

    console.log(
      JSON.stringify(
        { site, user: snapshot.user, pages, ready_ms: Math.round(performance.now() - started) },
        null,
        2,
      ),
    );
    console.log('Ctrl-C discards this copy.');
    await stopped;
    await cli[Symbol.asyncDispose]().catch((error) => {
      console.error(`Playground did not shut down cleanly: ${error.message}`);
    });
  }

  process.exit();
}

async function copy(source, destination, rootExclude) {
  // Dereference symlinked checkouts; Playground cannot follow links out of a mount.
  await cp(source, destination, {
    ...clone,
    dereference: true,
    filter: (path) =>
      !alwaysExclude.includes(basename(path)) &&
      !basename(path).startsWith('.env') &&
      !rootExclude.includes(relative(source, path)),
  });
}

// Recapture keeps the previous snapshot recoverable instead of deleting it.
async function trash(path) {
  await rename(path, join(homedir(), '.Trash', `${basename(path)}-${Date.now()}`)).catch(
    (error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    },
  );
}

async function wp(source, args, env = {}) {
  const { stdout } = await execute(
    'wp',
    // Skipping plugins and themes keeps their bootstrap code from writing to the source.
    [
      `--path=${source.wordpress_root}`,
      `--url=${source.url}`,
      '--skip-plugins',
      '--skip-themes',
      ...args,
    ],
    { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
  ).catch((error) => {
    throw new Error(`WP-CLI ${args[0]} failed: ${error.stderr || error.message}`);
  });

  return stdout;
}

// WP-CLI can print PHP notices before the JSON line.
function lastJson(stdout) {
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function config() {
  return JSON.parse(await readFile(join(homedir(), '.config/blockwork/scenarios.json'), 'utf8'));
}

async function scenario(name) {
  const entry = (await config()).scenarios.find((item) => item.name === name);

  if (!entry) {
    throw new Error(
      `Unknown scenario "${name}". Run \`list\` or add it to ~/.config/blockwork/scenarios.json.`,
    );
  }

  return entry;
}

async function readSnapshot(name) {
  if (!name) {
    throw new Error(usage);
  }

  return readFile(join(snapshots, name, 'scenario.json'), 'utf8').then(JSON.parse, () => {
    throw new Error(`No "${name}" snapshot. Run \`capture ${name}\` first.`);
  });
}

function option(args, name) {
  const index = args.indexOf(name);

  return index === -1 ? undefined : args[index + 1];
}
