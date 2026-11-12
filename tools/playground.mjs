import { runCLI } from '@wp-playground/cli';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const blueprint = JSON.parse(
  await readFile(new URL('../tests/fixtures/minimal.blueprint.json', import.meta.url), 'utf8'),
);
const abilities = await readFile(
  new URL('../tests/fixtures/abilities.php', import.meta.url),
  'utf8',
);

const resources = await readFile(
  new URL('../tests/fixtures/resources.php', import.meta.url),
  'utf8',
);

// ACF Pro is licensed, so each Mac keeps its own copy outside the repository.
export const acfPlugin = join(
  homedir(),
  '.local/share/blockwork/plugins/advanced-custom-fields-pro',
);

export async function startFixture(
  login = false,
  version = '7.1.4',
  editor = false,
  muPlugins = {},
  plugins = [],
  steps = [],
) {
  const password = randomUUID();
  const configured = structuredClone(blueprint);
  configured.login = login;
  configured.preferredVersions.wp = version;
  configured.steps.push(
    { step: 'mkdir', path: '/wordpress/wp-content/mu-plugins' },
    {
      step: 'writeFile',
      path: '/wordpress/wp-content/mu-plugins/blockwork-abilities.php',
      data: abilities,
    },
    {
      step: 'writeFile',
      path: '/wordpress/wp-content/mu-plugins/blockwork-resources.php',
      data: resources,
    },
    ...Object.entries(muPlugins).map(([name, data]) => ({
      step: 'writeFile',
      path: `/wordpress/wp-content/mu-plugins/${name}`,
      data,
    })),
    ...plugins.map((path) => ({
      step: 'activatePlugin',
      pluginPath: `/wordpress/wp-content/plugins/${basename(path)}`,
    })),
    ...steps,
  );

  if (editor) {
    configured.steps[1] = {
      step: 'runPHP',
      code: `<?php define('BLOCKWORK_FIXTURE_PASSWORD', ${JSON.stringify(password)}); ?>${await readFile(new URL('../tests/fixtures/editor.php', import.meta.url), 'utf8')}`,
    };
  }

  const started = performance.now();
  const cli = await runCLI({
    command: 'server',
    blueprint: configured,
    wp: version,
    php: blueprint.preferredVersions.php,
    port: 0,
    mount: plugins.map((hostPath) => ({
      hostPath,
      vfsPath: `/wordpress/wp-content/plugins/${basename(hostPath)}`,
    })),
    // Concurrent native Heartbeat and editor requests use Playground's recommended pool.
    workers: editor ? 6 : 1,
    verbosity: 'quiet',
    redis: false,
    memcached: false,
  });
  const boot_ms = performance.now() - started;

  try {
    const response = await cli.playground.run({
      code: `<?php
require '/wordpress/wp-load.php';
$post = get_post((int) get_option('blockwork_fixture_page_id'));
echo json_encode([
    'wordpress' => get_bloginfo('version'),
    'php' => PHP_VERSION,
    'user_id' => get_user_by('login', 'admin')->ID,
    'post_id' => $post->ID,
    'post_type' => $post->post_type,
    'status' => $post->post_status,
    'content' => $post->post_content,
    'accounts' => get_option('blockwork_fixture_accounts', []),
    'documents' => get_option('blockwork_fixture_documents', []),
    'theme' => get_stylesheet(),
    'block_theme' => wp_is_block_theme(),
]);`,
    });

    if (response.exitCode !== 0) {
      throw new Error(response.errors);
    }

    const { user_id, post_id, post_type, ...state } = response.json;

    return {
      cli,
      target: { site_url: cli.serverUrl, user_id, post_id, post_type },
      state,
      password: editor ? password : undefined,
      timings: { boot_ms, ready_ms: performance.now() - started },
    };
  } catch (error) {
    await cli[Symbol.asyncDispose]();

    throw error;
  }
}

async function serve(args) {
  const acf = args.includes('--acf');

  if (acf && !existsSync(acfPlugin)) {
    console.error(`--acf needs ACF Pro at ${acfPlugin}. Copy the plugin folder there.`);
    process.exit(1);
  }

  // The editing suite loads the same field group from its fixture folder.
  const fieldGroup = new URL('../tests/fixtures/editing/acf.php', import.meta.url);
  const fixture = acf
    ? await startFixture(
        true,
        '7.1.4',
        false,
        { 'blockwork-acf.php': await readFile(fieldGroup, 'utf8') },
        [acfPlugin],
      )
    : await startFixture(true);
  const { site_url, post_id } = fixture.target;
  console.log(JSON.stringify({ target: fixture.target, ...fixture.state }, null, 2));
  console.log(`Editor: ${site_url}/wp-admin/post.php?post=${post_id}&action=edit`);
  console.log(`Ready in ${Math.round(fixture.timings.ready_ms)} ms. Ctrl-C discards the site.`);

  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await fixture.cli[Symbol.asyncDispose]();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serve(process.argv.slice(2));
}
