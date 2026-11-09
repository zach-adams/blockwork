import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { bundles } from '../../tools/bundle.mjs';
import { startFixture } from '../../tools/playground.mjs';

const { editor: source } = await bundles({ debug: true });

// Use WordPress's own apiFetch and wp-admin nonce setup, as the abilities suite does.
async function resourcePage(fixture) {
  const site = fixture.target.site_url;
  await fetch(`${site}/wp-login.php`);
  const login = await fetch(`${site}/wp-login.php`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'wordpress_test_cookie=WP%20Cookie%20check' },
    body: new URLSearchParams({ log: 'admin', pwd: fixture.password, testcookie: '1' }),
  });
  const cookie = login.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  assert.match(cookie, /wordpress_logged_in_/);
  const text = async (path) => (await fetch(`${site}${path}`, { headers: { cookie } })).text();
  const nonce_url = `${site}/wp-admin/admin-ajax.php?action=rest-nonce`;
  const nonce = await text('/wp-admin/admin-ajax.php?action=rest-nonce');
  const requests = [];
  const window = { URL, URLSearchParams, TextEncoder, Response, Headers, FormData, Blob, atob, crypto, AbortSignal,
    setTimeout, clearTimeout, Date, navigator: { onLine: true },
    location: new URL(`${site}/wp-admin/upload.php`), document: { visibilityState: 'visible', readyState: 'complete',
      body: { className: `version-${fixture.state.wordpress.replaceAll('.', '-')}` } } };
  window.window = window;
  window.fetch = async (url, options = {}) => {
    requests.push({ path: new URL(url).pathname, method: options.headers?.['X-HTTP-Method-Override'] ?? options.method ?? 'GET' });

    return fetch(url, { ...options, headers: { ...options.headers, cookie } });
  };

  const realm = createContext(window);

  for (const script of ['hooks', 'i18n', 'private-apis', 'url', 'api-fetch']) {
    runInContext(await text(`/wp-includes/js/dist/${script}.min.js`), realm);
  }

  runInContext(`
    wp.apiFetch.use(wp.apiFetch.createRootURLMiddleware(${JSON.stringify(`${site}/wp-json/`)}));
    wp.apiFetch.nonceMiddleware = wp.apiFetch.createNonceMiddleware(${JSON.stringify(nonce)});
    wp.apiFetch.use(wp.apiFetch.nonceMiddleware);
    wp.apiFetch.use(wp.apiFetch.mediaUploadMiddleware);
    wp.apiFetch.nonceEndpoint = ${JSON.stringify(nonce_url)};
  `, realm);
  window.engine = runInContext(source, realm);
  const target = { site_url: site, user_id: fixture.target.user_id };
  const call = async (request) => JSON.parse(JSON.stringify(await runInContext(`engine(${JSON.stringify({ ...request, target })})`, realm)));

  return { call, requests };
}

test('native attachment creation rewrites the title, then Blockwork corrects the same ID once', { timeout: 120000 }, async (t) => {
  const fixture = await startFixture(false, '7.1.4', true);

  try {
    const page = await resourcePage(fixture);
    const plan = await page.call({ operation: 'prepare_media',
      fields: { title: 'Blockwork Resource Hero', slug: 'blockwork-resource-hero', alt: 'Blockwork test image' },
      upload: { name: 'blockwork-resource-hero.png', mime_type: 'image/png',
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k4S8AAAAASUVORK5CYII=' },
    });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const saved = await page.call({ operation: 'save_resource', receipt: plan.receipt });
    const verified = await page.call({ operation: 'verify_resource', receipt: plan.receipt, resource_id: saved.resource_id });
    const next = await page.call({ operation: 'prepare_media', id: saved.resource_id,
      edit_token: verified.record?.edit_token, fields: { alt: 'Next Blockwork alt' } });
    assert.equal(saved?.ok, true, JSON.stringify(saved));
    assert.equal(saved.persistence, 'verified');
    assert.equal(saved.record.title.raw, 'Blockwork Resource Hero');
    assert.deepEqual(saved.corrective_update, { fields: ['title'], acknowledged: true });
    assert.equal(verified.resource_id, saved.resource_id);
    assert.equal(verified.persistence, 'verified');
    assert.deepEqual(verified.corrective_update, saved.corrective_update);
    assert.equal(next.ok, true, JSON.stringify(next));
    const native = await fixture.cli.playground.run({ code: `<?php
require '/wordpress/wp-load.php';
echo json_encode([
    'rewrites' => get_option('blockwork_fixture_resource_rewrites', []),
    'title' => get_post_field('post_title', ${saved.resource_id}),
    'attachments' => get_posts(['post_type' => 'attachment', 'post_status' => 'inherit', 'fields' => 'ids']),
]);` });
    assert.equal(native.exitCode, 0, native.errors);
    assert.deepEqual(native.json.rewrites, { [saved.resource_id]: 'blockwork resource hero' });
    assert.equal(native.json.title, 'Blockwork Resource Hero');
    assert.ok(native.json.attachments.includes(saved.resource_id));
    const writes = page.requests.filter(({ path, method }) => path.includes('/media') && method === 'POST');
    assert.deepEqual(writes, [
      { path: '/wp-json/wp/v2/media', method: 'POST' },
      { path: `/wp-json/wp/v2/media/${saved.resource_id}`, method: 'POST' },
    ]);
    t.diagnostic(`Verified and discarded attachment ${saved.resource_id}.`);
  } finally {
    await fixture.cli[Symbol.asyncDispose]();
  }
});
