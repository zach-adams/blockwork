import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { connect } from '../../tools/browser-session.mjs';
import { acfPlugin, startFixture } from '../../tools/playground.mjs';

const exec = promisify(execFile);
const execute = (file, args, options = {}) => exec(file, args, { timeout: 120_000, ...options });
const bootstrapUrl = new URL('../../skills/blockwork/scripts/bootstrap.mjs', import.meta.url);
const pluginsUrl = new URL('../fixtures/editing/', import.meta.url);

// Every file in tests/fixtures/editing is a must-use plugin on the test site.
async function fixturePlugins() {
  const names = (await readdir(pluginsUrl)).filter((name) => name.endsWith('.php'));

  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        `blockwork-editing-${name}`,
        await readFile(new URL(name, pluginsUrl), 'utf8'),
      ]),
    ),
  );
}

// The latest Gutenberg release from WordPress.org, with its Guidelines
// experiment on, so a renamed experiment fails its cases.
const gutenbergSteps = [
  { step: 'installPlugin', pluginData: { resource: 'wordpress.org/plugins', slug: 'gutenberg' } },
  { step: 'setSiteOptions', options: { 'gutenberg-experiments': { 'gutenberg-guidelines': 1 } } },
];

// Runs real Gutenberg in Chromium against a disposable Playground site. Each
// case seeds its own document, so a failure never leaks into the next case.
// With acf, the site also runs ACF Pro, which turns on the acf.php field group.
// With gutenberg, it runs the Gutenberg plugin instead of core's editor.
// install names WordPress.org plugins to install inactive, for a case to activate.
export async function startEditingSite({
  version = '7.1.4',
  acf = false,
  gutenberg = false,
  install = [],
} = {}) {
  const fixture = await startFixture(
    false,
    version,
    true,
    await fixturePlugins(),
    acf ? [acfPlugin] : [],
    [
      ...(gutenberg ? gutenbergSteps : []),
      ...install.map((slug) => ({
        step: 'installPlugin',
        pluginData: { resource: 'wordpress.org/plugins', slug },
        options: { activate: false },
      })),
    ],
  );
  const session = `blockwork-editing-${randomUUID().slice(0, 8)}`;
  const browserArgs = ['--session', session];
  const { createBlockwork } = await import(bootstrapUrl.href);
  const site = fixture.target.site_url;
  let browserConnection;
  const dispose = async () => {
    await execute('agent-browser', [...browserArgs, 'close']).catch(() => undefined);
    browserConnection?.close();
    await fixture.cli[Symbol.asyncDispose]();
  };

  // A failed startup never returns the disposer, and the browser would outlive this process.
  const failStartup = async (error) => {
    await dispose();
    throw error;
  };

  browserConnection = await (async () => {
    await execute('agent-browser', [...browserArgs, 'open', 'about:blank']);
    const { stdout } = await execute('agent-browser', [...browserArgs, 'get', 'cdp-url']);

    return connect(stdout.trim());
  })().catch(failStartup);
  const open = new Set();
  const state = { login: 'admin' };

  // Runs PHP on the site, bypassing the browser, and returns its JSON output.
  async function php(code) {
    const response = await fixture.cli.playground.run({
      code: `<?php require '/wordpress/wp-load.php'; ${code}`,
    });
    assert.equal(response.exitCode, 0, response.errors);

    return response.text.trim() ? response.json : undefined;
  }

  async function openTab(url) {
    const { targetId } = await browserConnection.send('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await browserConnection.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const cdp = {
      send: (method, params, options) =>
        browserConnection.send(method, params, sessionId, options?.timeoutMs),
    };
    await cdp.send('Page.enable');
    const tab = {
      url,
      cdp,
      sessionId,
      capabilities: { get: async (name) => (name === 'cdp' ? cdp : undefined) },
      goto: async (destination) => {
        tab.url = destination;
        await cdp.send('Page.navigate', { url: destination });
      },
      close: async () => {
        open.delete(tab);
        await browserConnection.send('Target.closeTarget', { targetId });
      },
    };
    open.add(tab);
    await tab.goto(url);

    return tab;
  }

  async function evaluate(tab, expression) {
    const { result, exceptionDetails } = await tab.cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      { timeoutMs: 45_000 },
    );
    assert.ok(!exceptionDetails, JSON.stringify(exceptionDetails));

    return result.value;
  }

  // Decides the fate of a tab's matching requests until the returned function
  // runs. `stage` is 'Response' to act after the server has handled the request,
  // which is how a save that committed but lost its response looks. `decide` gets
  // the paused event and returns 'pass', 'fail', or { status, body }.
  async function intercept(tab, { urlPattern, stage = 'Response', decide }) {
    const stop = browserConnection.listen(async ({ method, params, sessionId }) => {
      if (method !== 'Fetch.requestPaused' || sessionId !== tab.sessionId) {
        return;
      }

      const { requestId } = params;
      const decision = await decide(params);

      if (decision === 'fail') {
        await tab.cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionReset' });
      } else if (decision === 'pass') {
        await tab.cdp.send(
          params.responseStatusCode ? 'Fetch.continueResponse' : 'Fetch.continueRequest',
          { requestId },
        );
      } else {
        await tab.cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: decision.status,
          responseHeaders: [
            { name: 'Content-Type', value: decision.contentType ?? 'application/json' },
          ],
          body: Buffer.from(decision.body ?? '').toString('base64'),
        });
      }
    });

    await tab.cdp.send('Fetch.enable', { patterns: [{ urlPattern, requestStage: stage }] });

    return async () => {
      stop();
      await tab.cdp.send('Fetch.disable');
    };
  }

  // A real WordPress session for a fixture account, as browser cookies.
  async function authCookies(account = 'admin') {
    const login = account === 'admin' ? 'admin' : `blockwork_${account}`;
    const { cookies, expires } = await php(`
      $user = get_user_by('login', ${JSON.stringify(login)});
      $expires = time() + DAY_IN_SECONDS;
      $token = WP_Session_Tokens::get_instance($user->ID)->create($expires);
      $auth = wp_generate_auth_cookie($user->ID, $expires, 'auth', $token);
      $logged_in = wp_generate_auth_cookie($user->ID, $expires, 'logged_in', $token);
      $cookies = [];
      foreach (array_unique([ADMIN_COOKIE_PATH, PLUGINS_COOKIE_PATH]) as $path) {
        $cookies[] = ['name' => AUTH_COOKIE, 'value' => $auth, 'path' => $path];
      }
      foreach (array_unique([COOKIEPATH, SITECOOKIEPATH]) as $path) {
        $cookies[] = ['name' => LOGGED_IN_COOKIE, 'value' => $logged_in, 'path' => $path];
      }
      echo wp_json_encode(['cookies' => $cookies, 'expires' => $expires]);
    `);

    return cookies.map((cookie) => ({
      ...cookie,
      domain: new URL(site).hostname,
      httpOnly: true,
      expires,
    }));
  }

  // Switches this browser to a fixture account: admin, editor, author, or subscriber.
  async function signIn(account = 'admin') {
    await browserConnection.send('Storage.setCookies', { cookies: await authCookies(account) });
    state.login = account === 'admin' ? 'admin' : `blockwork_${account}`;
  }

  await signIn().catch(failStartup);

  return {
    site,
    fixture,
    version,
    php,
    evaluate,
    openTab,
    intercept,
    signIn,
    authCookies,
    get login() {
      return state.login;
    },
    createCaller: (tab) => createBlockwork(tab),
    [Symbol.asyncDispose]: dispose,
  };
}

const yoast = 'wordpress-seo/wp-seo.php';

// Turns on Yoast SEO from install. Its one-time redirect to a welcome page
// would otherwise replace the next wp-admin page a case or agent opens.
export async function setYoast(site, active) {
  await site.php(`
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    ${active ? `activate_plugin('${yoast}');` : `deactivate_plugins('${yoast}');`}
    $options = get_option('wpseo', []);
    $options['should_redirect_after_install_free'] = false;
    update_option('wpseo', $options);
  `);
}

export async function seedDocument(
  site,
  { content, title = 'Editing case', type = 'page', status = 'publish', meta = {}, extra = {} },
) {
  const args = {
    post_type: type,
    post_status: status,
    post_title: title,
    post_content: content,
    post_author: 1,
    ...extra,
  };
  const encoded = Buffer.from(JSON.stringify({ args, meta })).toString('base64');
  const { id } = await site.php(`
    $input = json_decode(base64_decode('${encoded}'), true);
    kses_remove_filters();
    $id = wp_insert_post(wp_slash($input['args']), true);
    if (is_wp_error($id)) { throw new Exception($id->get_error_message()); }
    foreach ($input['meta'] as $key => $value) { update_post_meta($id, $key, $value); }
    echo wp_json_encode(['id' => $id]);
  `);

  return id;
}

export const storedDocument = (site, id) =>
  site.php(`
    $post = get_post(${id});
    $meta = get_post_meta(${id});
    unset($meta['_edit_lock'], $meta['_edit_last']);
    // WordPress caches embed lookups for any URL it finds in the content.
    foreach (array_keys($meta) as $key) { if (str_starts_with($key, '_oembed_')) { unset($meta[$key]); } }
    echo wp_json_encode([
      'content' => $post->post_content,
      'status' => $post->post_status,
      'slug' => $post->post_name,
      'title' => $post->post_title,
      'date' => $post->post_date_gmt,
      'author' => (int) $post->post_author,
      'excerpt' => $post->post_excerpt,
      'parent' => (int) $post->post_parent,
      'menu_order' => (int) $post->menu_order,
      'meta' => $meta,
      'lock' => get_post_meta(${id}, '_edit_lock', true),
      'editor_mode' => get_user_meta(get_user_by('login', '${site.login}')->ID, 'wp_persisted_preferences', true)['core']['editorMode'] ?? null,
    ]);
  `);

const editorReady = `window.wp?.data?.select('core/editor')?.__unstableIsEditorReady?.()`;

// Everything a user sees when they next open the document in the editor.
export async function reopen(site, id) {
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);

  try {
    await waitFor(site, tab, editorReady);

    return await site.evaluate(
      tab,
      `(() => {
        const invalid = (blocks) => blocks.flatMap((block) => [
          ...(block.isValid ? [] : [block.name]),
          ...invalid(block.innerBlocks),
        ]);
        const missing = (blocks) => blocks.flatMap((block) => [
          ...(block.name === 'core/missing' ? [block.attributes.originalName] : []),
          ...missing(block.innerBlocks),
        ]);
        const blocks = wp.data.select('core/block-editor').getBlocks();
        return {
          invalid: invalid(blocks),
          missing: missing(blocks),
          dirty: wp.data.select('core/editor').isEditedPostDirty(),
          content: wp.data.select('core/editor').getEditedPostContent(),
          roundtrip: wp.blocks.serialize(blocks),
        };
      })()`,
    );
  } finally {
    await tab.close();
  }
}

export async function waitFor(site, tab, expression, timeout = 30_000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    const ready = await site
      .evaluate(tab, `(() => { try { return !!(${expression}); } catch { return false; } })()`)
      .catch(() => false);

    if (ready) {
      return;
    }

    await new Promise((settle) => setTimeout(settle, 100));
  }

  throw new Error(`Timed out waiting for ${expression}`);
}

// Opens a seeded document the way the skill does, then hands the case its caller.
export async function withDocument(
  site,
  seed,
  body,
  { workflow = 'background', connected = true } = {},
) {
  const id = await seedDocument(site, seed);
  const before = await storedDocument(site, id);
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);
  const blockwork = await site.createCaller(tab);
  const target = { site_url: site.site, post_id: id, post_type: seed.type ?? 'page' };
  const doc = await blockwork.connect({ target, workflow });

  try {
    // A case that expects connect to refuse sets connected: false and checks doc itself.
    if (connected) {
      assert.equal(doc.ok, true, JSON.stringify(doc));
    }

    return await body({ blockwork, doc, id, before, tab, target });
  } finally {
    await blockwork.release().catch(() => undefined);
    await tab.close().catch(() => undefined);
  }
}

const savedFields = [
  'status',
  'slug',
  'title',
  'date',
  'author',
  'excerpt',
  'parent',
  'menu_order',
  'meta',
  'editor_mode',
];

// A refusal has to explain itself and leave the stored document alone.
export async function assertRefused(site, id, before, result, { error, next, allow = [] } = {}) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.hint?.length > 10, `${result.error} has no usable hint`);
  assert.ok(result.next, `${result.error} has no next step`);

  if (error) {
    assert.equal(result.error, error, JSON.stringify(result));
  }

  if (next) {
    assert.equal(result.next, next);
  }

  const after = await storedDocument(site, id);

  for (const field of ['content', ...savedFields]) {
    if (!allow.includes(field)) {
      assert.deepEqual(after[field], before[field], `a refused change altered ${field}`);
    }
  }
}

// The stored block tree as WordPress's own parser reads it.
export const storedTree = (site, id) =>
  site.php(`echo wp_json_encode(parse_blocks(get_post(${id})->post_content));`);

// The paths of blocks that differ between two parse_blocks trees, by attributes,
// own HTML, or block name. A block added or removed counts at its own path.
export function changedPaths(before, after, prefix = []) {
  const changed = [];
  const named = (blocks) => blocks.filter((block) => block.blockName || block.innerHTML.trim());
  const left = named(before);
  const right = named(after);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const path = [...prefix, index];
    const a = left[index];
    const b = right[index];

    if (!a || !b) {
      changed.push(path.join('.'));
    } else {
      if (
        a.blockName !== b.blockName ||
        JSON.stringify(a.attrs) !== JSON.stringify(b.attrs) ||
        a.innerHTML !== b.innerHTML
      ) {
        changed.push(path.join('.'));
      }

      changed.push(...changedPaths(a.innerBlocks, b.innerBlocks, path));
    }
  }

  return changed;
}

// What a logged-out visitor gets for a document.
export async function frontEnd(site, id) {
  const response = await fetch(`${site.site}/?page_id=${id}`, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });

  return { status: response.status, html: await response.text() };
}

// What Gutenberg itself would store for an expression that builds blocks in the
// page, so seeds for intricate blocks stay authentic across WordPress releases.
export async function serializeNatively(site, expression) {
  const id = await seedDocument(site, { content: '', title: 'Serializer', status: 'draft' });
  const tab = await site.openTab(`${site.site}/wp-admin/post.php?post=${id}&action=edit`);

  try {
    await waitFor(site, tab, editorReady);

    return await site.evaluate(tab, `wp.blocks.serialize(${expression})`);
  } finally {
    await tab.close();
  }
}

// A real attachment with generated sizes, so media cases have true files.
export async function seedImage(
  site,
  { name = 'fixture', width = 1600, height = 1000, alt = '', caption = '', title } = {},
) {
  const encoded = Buffer.from(
    JSON.stringify({ name, width, height, alt, caption, title: title ?? name }),
  ).toString('base64');

  return site.php(`
    require_once ABSPATH . 'wp-admin/includes/image.php';
    $input = json_decode(base64_decode('${encoded}'), true);
    $image = imagecreatetruecolor($input['width'], $input['height']);
    imagefill($image, 0, 0, imagecolorallocate($image, crc32($input['name']) & 255, 90, 160));
    $upload = wp_upload_dir();
    $file = $upload['path'] . '/' . sanitize_file_name($input['name']) . '.png';
    imagepng($image, $file);
    $id = wp_insert_attachment(['post_mime_type' => 'image/png', 'post_title' => $input['title'], 'post_status' => 'inherit', 'post_excerpt' => $input['caption']], $file);
    wp_update_attachment_metadata($id, wp_generate_attachment_metadata($id, $file));
    update_post_meta($id, '_wp_attachment_image_alt', $input['alt']);
    echo wp_json_encode(['id' => $id, 'url' => wp_get_attachment_url($id), 'alt' => $input['alt'], 'sizes' => wp_get_attachment_metadata($id)['sizes'] ?? []]);
  `);
}

// The invariants every successful edit has to keep, whatever else the case checks.
export async function assertSavedCleanly(site, id, before, saved, { allow = [] } = {}) {
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  const after = await storedDocument(site, id);

  for (const field of savedFields) {
    if (!allow.includes(field)) {
      assert.deepEqual(after[field], before[field], `${field} changed`);
    }
  }

  const reopened = await reopen(site, id);
  assert.deepEqual(reopened.invalid, [], 'invalid blocks after reopening');
  assert.equal(reopened.dirty, false, 'the saved document opens dirty');
  assert.equal(reopened.content, after.content, 'the editor does not reproduce the stored content');

  return { after, reopened };
}

// One complete edit: seed, connect, change, save, reopen, then the exact result.
export async function editAndSave(site, seed, edits, expected, options = {}) {
  return withDocument(site, seed, async ({ blockwork, doc, id, before }) => {
    const result = await blockwork.edit({ edits: edits(doc) });
    assert.equal(result.ok, true, JSON.stringify(result));
    const saved = await blockwork.save();
    const { after } = await assertSavedCleanly(site, id, before, saved, options);

    if (expected !== undefined) {
      assert.equal(after.content, expected);
    }

    return { after, result, saved };
  });
}
