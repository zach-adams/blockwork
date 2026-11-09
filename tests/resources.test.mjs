import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = await readFile(new URL('../skills/blockwork/scripts/editor.js', import.meta.url), 'utf8');

// Development builds put the underlying message in debug; nothing else may echo it.
function outsideDebug(result) {
  return JSON.stringify({ ...result, debug: undefined });
}

const target = { site_url: 'https://example.test', user_id: 5 };
const png = { name: 'fixture.png', mime_type: 'image/png', base64: 'iVBORw0KGgo=' };

test('resource_status observes busy resource and editor sessions without acquiring or requesting anything', async () => {
  const f = fixture();
  const plan = await f.call('prepare_media', { fields: { slug: 'status-fixture', title: 'Fixture' }, upload: png });
  assert.equal(plan.ok, true);
  const session = f.window.__blockwork_resources_v1;
  session.busy = true;
  const before = f.requests.length;
  const status = await f.call('resource_status');
  assert.equal(status.ok, true);
  assert.equal(status.busy, true);
  assert.equal(status.attempted, false);
  assert.equal(status.receipt.key, plan.receipt.key);
  assert.equal(f.requests.length, before);
  assert.equal(session.busy, true);
  session.busy = false;
  f.window.__blockwork_editor = { busy: true };
  assert.equal((await f.call('resource_status')).busy, true);
  assert.equal(f.requests.length, before);
});

test('resource_status validates its target before returning a receipt and leaves absent sessions absent', async () => {
  const f = fixture();
  const empty = await f.call('resource_status');
  assert.equal(empty.ok, true);
  assert.equal(empty.busy, false);
  assert.equal(f.window.__blockwork_resources_v1, undefined);
  assert.equal((await f.call('resource_status', { extra: true })).error, 'invalid_resource_request');
  assert.equal((await f.call('resource_status', { target: { ...target, site_url: 'https://other.test' } })).error, 'target_mismatch');
  assert.equal(f.requests.length, 0);
});

function fixture() {
  const f = { writes: 0, auth: true, nextId: 30, requests: [], downloads: [], files: new Map(), records: {
    '/wp/v2/media': [{ id: 20, title: { raw: 'Photo' }, caption: { raw: '' }, description: { raw: '' }, slug: 'photo', post: 0,
      alt_text: 'Original alt', media_type: 'image', mime_type: 'image/png', source_url: 'https://example.test/uploads/photo.png', media_details: {} }],
    '/custom/v1/topics': [{ id: 10, taxonomy: 'topic', name: 'Original', slug: 'original', description: '', parent: 0, count: 0, meta: { note: 'keep' } }],
  } };

  const tax = { slug: 'topic', rest_namespace: 'custom/v1', rest_base: 'topics', types: ['book'], hierarchical: true };

  const apiFetch = async (options) => {
    const { path, method = 'GET', data, body } = options;
    f.requests.push({ path, method, data: data && structuredClone(data), upload: Boolean(body) });

    if (!f.auth) throw { code: 'rest_cookie_invalid_nonce', data: { status: 401 } };

    if (f.denied) throw { code: 'rest_cannot_create', message: 'secret', data: { status: 403 } };

    if (path === '/?_fields=url') return { url: target.site_url };

    if (path.startsWith('/wp/v2/users/me')) return { id: f.userId ?? 5, name: 'Fixture', slug: 'fixture' };

    if (path.startsWith('/wp/v2/taxonomies/topic')) return tax;

    if (path.startsWith('/wp/v2/taxonomies')) return { topic: tax };

    if (path.startsWith('/?_fields=home')) return f.index;

    if (path.startsWith('/wp/v2/types')) return f.types ?? { book: { slug: 'book', rest_namespace: 'custom/v1', rest_base: 'books', supports: { editor: true } } };
    const url = new URL(path, target.site_url);
    const collection = Object.keys(f.records).find((item) => url.pathname === item || url.pathname.startsWith(`${item}/`));
    assert.ok(collection, path);
    const media = collection === '/wp/v2/media';
    const selected = Number(url.pathname.slice(collection.length + 1)) || undefined;
    const records = f.records[collection];

    if (method === 'OPTIONS') {
      const text = { type: 'object', properties: { raw: { type: 'string' }, rendered: { type: 'string', readonly: true } }, required: false };

      const properties = media ? { title: text, caption: text, description: text, slug: { type: 'string' }, post: { type: 'integer' }, alt_text: { type: 'string' },
        mime_type: { type: 'string', readonly: true }, source_url: { type: 'string', readonly: true }, media_details: { type: 'object', readonly: true } }
        : { name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string' }, parent: { type: 'integer' },
          meta: f.metaSchema ?? { type: 'object', properties: { note: { type: 'string' }, flags: { type: 'object', properties: { nested: { type: 'object' } }, additionalProperties: true } } }, count: { type: 'integer', readonly: true } };

      const args = media || selected ? properties : { ...properties, name: { ...properties.name, required: true } };

      return { schema: { properties }, endpoints: [{ methods: ['POST'], args }] };
    }

    if (method === 'GET') {
      // WordPress runs each slug through sanitize_title, which lowercases escapes.
      const slugs = url.searchParams.get('slug')?.toLowerCase().split(',');
      const include = url.searchParams.get('include')?.split(',').map(Number);

      if (!selected) return structuredClone(records.filter((record) => (!slugs || slugs.includes(record.slug))
        && (!include || include.includes(record.id))
        && (!url.searchParams.has('parent') || record.parent === Number(url.searchParams.get('parent')))));
      const record = records.find((item) => item.id === selected);

      if (!record) throw { code: media ? 'rest_post_invalid_id' : 'rest_term_invalid', data: { status: 404 } };

      return structuredClone(record);
    }

    f.beforeWrite?.();
    f.writes++;

    if (method === 'DELETE') {
      const index = records.findIndex((item) => item.id === selected);
      const [previous] = records.splice(index, 1);

      return { deleted: true, previous };
    }

    const fields = body ? Object.fromEntries([...body.entries()].filter(([key]) => key !== 'file')) : data;
    let record = records.find((item) => item.id === selected);

    if (!record) {
      record = media ? { id: f.nextId++, media_type: 'image', mime_type: body.get('file').type, source_url: 'https://example.test/uploads/new.png', media_details: {},
        title: { raw: '' }, caption: { raw: '' }, description: { raw: '' }, post: 0, alt_text: '' }
        : { id: f.nextId++, taxonomy: 'topic', name: '', slug: '', description: '', parent: 0, count: 0, meta: {} };
      records.push(record);
    }

    for (const [name, value] of Object.entries(fields)) record[name] = media && ['title', 'caption', 'description'].includes(name) ? { raw: value } : structuredClone(value);

    if (body) f.files.set(record.source_url, new Uint8Array(await body.get('file').arrayBuffer()));
    f.afterWrite?.(record, selected);

    if (f.interrupt) throw new Error('response-lost');

    return structuredClone(record);
  };

  f.window = { wp: { apiFetch } };

  const fetch = async (url, options) => {
    f.downloads.push({ url, ...options });

    if (f.downloadTimeout) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      f.expireLatest();
    });

    if (f.downloadError) throw new Error('download-unavailable');
    const bytes = f.files.get(url);

    return f.downloadResponse ?? new Response(bytes, { status: bytes ? 200 : 404 });
  };

  // f.expire(ms) fires every request deadline of that length at once.
  const deadlines = [];
  f.expire = (ms) => {
    for (const deadline of deadlines) if (deadline.ms === ms) deadline.controller.abort(new DOMException('Timed out', 'TimeoutError'));
  };

  // Fires the newest deadline now, as an event-loop timer can before Date.now() catches up.
  f.expireLatest = () => deadlines.at(-1)?.controller.abort(new DOMException('Timed out', 'TimeoutError'));

  const signals = { timeout(ms) {
    const controller = new AbortController();
    deadlines.push({ ms, controller });

    return AbortSignal.any([AbortSignal.timeout(ms), controller.signal]);
  } };

  f.document = { visibilityState: 'visible', readyState: 'complete', body: { className: 'wp-admin branch-7-1 version-7-1-2' } };
  f.waits = [];
  f.location = new URL('https://example.test/wp-admin/upload.php');
  const invoke = runInNewContext(source, { window: f.window, location: f.location,
    URL, URLSearchParams, TextEncoder, crypto, AbortSignal: signals, setTimeout: (callback, ms) => {
      f.waits.push(ms);
      f.onWait?.(ms);

      return setTimeout(callback, f.onWait ? 0 : ms);
    }, clearTimeout, atob, btoa, FormData, Blob, fetch,
    document: f.document,
    // elapsedMs moves the engine's clock, as a slow request would.
    Date: class extends Date { static now() { return Date.now() + (f.elapsedMs ?? 0); } } });

  f.call = (operation, extra = {}) => invoke({ operation, target, ...extra });

  return f;
}

test('resource and shared request validation returns actionable paths before acquiring sessions', async () => {
  const f = fixture();

  for (const [operation, extra, path, expected] of [
    ['inspect_media', { limit: 60 }, 'limit', '<=50'],
    ['download_media', { id: 20, url: 'https://example.test/file.png' }, 'url', 'never'],
    ['prepare_media', { fields: { alt: 5 } }, 'fields.alt', 'string'],
    ['prepare_term', { taxonomy: 'topic', action: 'create', workflow: 'private-input' }, 'workflow', 'never'],
    ['list_entities', { entity_type: 'wp_block', limit: 60 }, 'limit', '<=50'],
  ]) {
    const result = await f.call(operation, extra);
    assert.equal(result.ok, false);
    assert.equal(result.operation, operation);
    assert.equal(result.validation_source, 'request');
    assert.equal(result.next, 'correct_request');
    assert.equal(result.issues[0].path, path);
    assert.equal(result.issues[0].expected, expected);
    assert.ok(result.issues[0].hint.length > 20);
    assert.ok(result.hint.length > 20);
    assert.equal(JSON.stringify(result).includes('private-input'), false);
  }

  assert.equal(f.requests.length, 0);
  assert.equal(f.window.__blockwork_resources_v1, undefined);
  assert.equal(f.writes, 0);
});

test('download_media reads the attachment through the source tab and returns up to 5 MiB', async () => {
  const f = fixture();
  const url = f.records['/wp/v2/media'][0].source_url;
  const bytes = Buffer.alloc(5 * 1024 * 1024, 137);
  f.files.set(url, bytes);
  const downloaded = await f.call('download_media', { id: 20, timeout_ms: 3000 });
  assert.equal(downloaded.ok, true, JSON.stringify({ ...downloaded, upload: undefined }));
  assert.equal(downloaded.upload.name, 'photo.png');
  assert.equal(downloaded.upload.mime_type, 'image/png');
  assert.equal(downloaded.upload.base64, bytes.toString('base64'));
  assert.ok(f.requests.some(request => request.path === '/wp/v2/media/20?context=edit'));
  assert.equal(f.downloads[0].url, url);
  assert.equal(f.downloads[0].credentials, 'same-origin');
  assert.equal(f.downloads[0].redirect, 'error');
  assert.equal(f.downloads[0].cache, 'no-store');
  assert.equal(f.writes, 0);
});

test('download_media refuses unsafe, unavailable, empty and oversized files with safe repair hints', async () => {
  for (const mode of ['other_origin', 'url_credentials', 'missing', 'unauthorized', 'redirect', 'empty', 'oversized', 'timeout', 'record_timeout']) {
    const f = fixture();
    const record = f.records['/wp/v2/media'][0];
    f.files.set(record.source_url, Buffer.from('attachment'));
    const codes = {
      other_origin: 'media_download_source_unavailable', url_credentials: 'media_download_source_unavailable',
      missing: 'media_download_unavailable', unauthorized: 'media_download_authorization_required',
      redirect: 'media_download_unavailable', empty: 'media_download_empty',
      oversized: 'media_download_too_large', timeout: 'media_download_timeout', record_timeout: 'media_download_timeout',
    };

    if (mode === 'other_origin') record.source_url = 'https://cdn.example.test/photo.png';

    if (mode === 'url_credentials') record.source_url = 'https://user:password@example.test/photo.png';

    if (mode === 'missing') f.files.clear();

    if (mode === 'unauthorized') f.downloadResponse = new Response(null, { status: 401 });

    if (mode === 'redirect') f.downloadError = true;

    if (mode === 'empty') f.files.set(record.source_url, Buffer.alloc(0));

    if (mode === 'oversized') f.files.set(record.source_url, Buffer.alloc(5 * 1024 * 1024 + 1));

    if (mode === 'timeout') f.downloadTimeout = true;

    if (mode === 'record_timeout') {
      const apiFetch = f.window.wp.apiFetch;
      f.window.wp.apiFetch = async options => {
        const record = await apiFetch(options);

        if (options.path === '/wp/v2/media/20?context=edit') f.elapsedMs = 12000;

        return record;
      };
    }

    const result = await f.call('download_media', { id: 20, timeout_ms: 12000 });
    assert.equal(result.error, codes[mode], JSON.stringify(result));
    assert.equal(result.persistence, 'not_attempted');
    assert.match(result.hint, /This item was not uploaded/);
    assert.equal('upload' in result, false);
    assert.equal(f.writes, 0);

    if (['other_origin', 'url_credentials', 'record_timeout'].includes(mode)) assert.equal(f.downloads.length, 0);

    if (mode === 'redirect') assert.match(result.hint, /source tab.*same copy_id/);

    if (mode === 'timeout') assert.match(result.hint, /timed out/);
  }

  const signedOut = fixture();
  signedOut.auth = false;
  const result = await signedOut.call('download_media', { id: 20 });
  assert.equal(result.error, 'reauthorization_required');
  assert.match(result.hint, /source.*not signed in.*user.*sign in.*same copy_id/);
  assert.equal(signedOut.downloads.length, 0);
});

test('discovery without user_id reports the signed-in target, and a wrong user names the signed-in one', async () => {
  const f = fixture();
  const found = await f.call('discover', { target: { site_url: target.site_url } });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.deepEqual({ ...found.target }, target);
  assert.equal(found.user.id, 5);

  // The site-only discovery pinned the complete target for later calls.
  const media = await f.call('inspect_media', { id: 20 });
  assert.equal(media.ok, true, JSON.stringify(media));

  const other = fixture();
  const wrong = await other.call('discover', { target: { ...target, user_id: 21 } });
  assert.equal(wrong.error, 'user_mismatch');
  assert.deepEqual({ ...wrong.diagnostics }, { expected_user_id: 21, signed_in_user_id: 5 });
  assert.match(wrong.hint, /signed_in_user_id/);

});

test('discover with a url finds the one editable document at that permalink', async () => {
  const f = fixture();
  const editable = { supports: { editor: true }, viewable: true };
  f.types = {
    page: { slug: 'page', rest_namespace: 'wp/v2', rest_base: 'pages', ...editable },
    book: { slug: 'book', rest_namespace: 'custom/v1', rest_base: 'books', ...editable },
  };
  f.index = { home: target.site_url, show_on_front: 'page', page_on_front: 7 };
  const page = (id, slug, link, type = 'page') => ({ id, type, status: 'publish', title: { raw: slug }, slug, link });
  f.records['/wp/v2/pages'] = [
    page(7, 'home', `${target.site_url}/`),
    page(11, 'design', `${target.site_url}/other/design/`),
    page(12, 'design', `${target.site_url}/services/design/`),
    page(13, 'caf%c3%a9', `${target.site_url}/caf%c3%a9/`),
  ];
  f.records['/custom/v1/books'] = [page(14, 'design', `${target.site_url}/books/design/`, 'book')];
  const discover = (url) => f.call('discover', { target: { site_url: target.site_url }, url });
  const child = await discover(`${target.site_url}/services/design?ref=nav#top`);
  assert.equal(child.ok, true, JSON.stringify(child));
  assert.equal(child.record.id, 12);
  assert.equal(child.editor_url, `${target.site_url}/wp-admin/post.php?post=12&action=edit`);
  assert.equal((await discover(`${target.site_url}/books/design/`)).record.type, 'book');
  assert.equal((await discover(`${target.site_url}/café/`)).record.id, 13);
  assert.equal((await discover(`${target.site_url}/`)).record.id, 7);
  assert.equal((await discover(`${target.site_url}/?page_id=12&preview=true`)).record.id, 12);
  assert.equal((await discover(`${target.site_url}/?p=14`)).record.type, 'book');

  for (const [url, error, reason] of [
    [`${target.site_url}/?s=design`, 'document_not_found', 'no_front_page'],
    [`${target.site_url}/missing/`, 'document_not_found', 'missing'],
    ['https://other.test/services/design/', 'url_outside_site'],
  ]) {
    const refused = await discover(url);
    assert.equal(refused.error, error, url);
    assert.equal(refused.diagnostics?.reason, reason, url);
    assert.ok(refused.hint && refused.next, JSON.stringify(refused));
  }

  const writes = f.requests.filter(({ method }) => method !== 'GET');
  assert.equal(writes.length, 0);
});

test('resource inspections resolve site-only targets and refuse mismatched users', async () => {
  for (const [operation, args] of [['inspect_media', { id: 20 }], ['inspect_terms', { taxonomy: 'topic', id: 10 }]]) {
    const result = await fixture().call(operation, { ...args, target: { site_url: target.site_url } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual({ ...result.target }, target);
    assert.equal(result.user.id, 5);
    const wrong = await fixture().call(operation, { ...args, target: { ...target, user_id: 21 } });
    assert.equal(wrong.error, 'user_mismatch');
  }
});

test('reads reuse the identity this page verified, and a write confirms it again', async () => {
  const f = fixture();
  const identityChecks = () => f.requests.filter((request) => request.path.startsWith('/wp/v2/users/me')).length;
  await f.call('inspect_media', { id: 20 });
  await f.call('inspect_media', { id: 20 });
  await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });
  const plan = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'New', slug: 'new-topic' } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(identityChecks(), 1);

  // Someone else signed in after the verified reads: the write refuses.
  f.userId = 6;
  const refused = await f.call('save_resource', { receipt: plan.receipt });
  assert.equal(refused.error, 'user_mismatch', JSON.stringify(refused));
  assert.equal(refused.persistence, 'not_attempted');
  assert.equal(identityChecks(), 2);
  assert.equal(f.writes, 0);
});

test('unidentified runtime errors report an unavailable cause without blaming the request or echoing exceptions', async () => {
  const f = fixture();
  f.window.wp.apiFetch = async () => { throw new Error('private-input'); };

  const result = await f.call('discover');
  assert.equal(result.error, 'operation_failed');
  assert.match(result.hint, /cause is unavailable/);
  assert.equal(outsideDebug(result).includes('private-input'), false);
  assert.equal(result.debug.message, 'private-input');
  assert.equal(f.writes, 0);
});

test('resource API loading waits at most two seconds and never waits on a complete page', async () => {
  for (const mode of ['loading', 'interactive', 'complete', 'missing', 'finished']) {
    const f = fixture();
    const wp = f.window.wp;
    delete f.window.wp;
    f.document.readyState = mode === 'complete' ? 'complete' : 'loading';

    if (mode === 'interactive') f.document.readyState = 'interactive';
    f.onWait = (ms) => {
      f.elapsedMs = (f.elapsedMs ?? 0) + ms;

      if (['loading', 'interactive'].includes(mode) && f.waits.length === 2) f.window.wp = wp;

      if (mode === 'finished') f.document.readyState = 'complete';
    };

    const result = await f.call('inspect_media', { id: 20 });

    if (['loading', 'interactive'].includes(mode)) {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(f.waits.length, 2);
    } else {
      assert.equal(result.error, 'native_api_unavailable');
      assert.match(result.hint, /owned resource tab/);
      assert.match(result.hint, /Do not open a post editor/);
      assert.equal(f.waits.length === 0, mode === 'complete');
      assert.ok(f.waits.length <= 40);

      if (mode === 'finished') assert.equal(f.waits.length, 1);
      assert.equal(f.requests.length, 0);
      assert.equal(f.window.__blockwork_resources_v1, undefined);
    }

    assert.equal(f.writes, 0);
  }
});

test('native resource field errors identify the schema constraint and malformed responses', async () => {
  const f = fixture();
  const inspected = await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });
  const invalid = await f.call('prepare_term', {
    taxonomy: 'topic', action: 'update', id: 10, edit_token: inspected.record.edit_token,
    fields: { meta: { note: 123 } },
  });
  assert.equal(invalid.error, 'invalid_field_value');
  assert.equal(invalid.diagnostics.field, 'meta.note');
  assert.equal(invalid.diagnostics.expected_type, 'string');
  assert.equal(invalid.diagnostics.constraint, 'type');
  assert.match(invalid.hint, /schema/);

  // WordPress returns an empty object-typed meta value as PHP's `[]` and
  // accepts it back, so writing what was read must pass.
  const roundTrip = await f.call('prepare_term', {
    taxonomy: 'topic', action: 'update', id: 10, edit_token: inspected.record.edit_token,
    fields: { meta: { note: 'keep', flags: [] } },
  });
  assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip));
  const nested = await f.call('prepare_term', {
    taxonomy: 'topic', action: 'update', id: 10, edit_token: inspected.record.edit_token,
    fields: { meta: { note: 'keep', flags: { nested: [] } } },
  });
  assert.equal(nested.ok, true, JSON.stringify(nested));

  // Rules on the meta object itself still apply.
  const strict = fixture();
  strict.metaSchema = { type: 'object', required: ['note'], properties: { note: { type: 'string' }, flags: { type: 'object' } } };
  const strictInspected = await strict.call('inspect_terms', { taxonomy: 'topic', id: 10 });
  const missing = await strict.call('prepare_term', {
    taxonomy: 'topic', action: 'update', id: 10, edit_token: strictInspected.record.edit_token, fields: { meta: { flags: {} } },
  });
  assert.equal(missing.error, 'invalid_field_value', JSON.stringify(missing));
  assert.deepEqual([missing.diagnostics.field, missing.diagnostics.constraint], ['meta.note', 'required']);

  const malformed = fixture();
  malformed.window.wp.apiFetch = async () => ({ private_input: 'private-input' });
  const response = await malformed.call('discover');
  assert.equal(response.error, 'invalid_native_response');
  assert.equal(response.validation_source, 'native_response');
  assert.ok(response.issues.length > 0);
  assert.match(response.issues[0].hint, /path belongs to the native response/);
  assert.match(response.hint, /not request fields/);
  assert.equal(JSON.stringify(response).includes('private-input'), false);
  assert.equal(f.writes, 0);
});

test('media lookup by ids or exact slugs returns full records in one request and names what is missing', async () => {
  const f = fixture();
  await f.call('inspect_media', { id: 20 });
  const before = f.requests.length;
  const byIds = await f.call('inspect_media', { ids: [20, 99] });
  assert.equal(byIds.ok, true, JSON.stringify(byIds));
  assert.deepEqual([...byIds.records].map((record) => [record.id, record.title.raw, record.slug]), [[20, 'Photo', 'photo']]);
  assert.match(byIds.records[0].edit_token, /^[0-9a-f]{64}$/);
  assert.deepEqual([...byIds.missing], [99]);
  assert.equal(f.requests.length - before, 1);

  const bySlugs = await f.call('inspect_media', { slugs: ['photo', 'absent'] });
  assert.deepEqual([...bySlugs.records].map((record) => record.id), [20]);
  assert.deepEqual([...bySlugs.missing], ['absent']);

  const both = await f.call('inspect_media', { id: 20, ids: [20] });
  assert.equal(both.error, 'invalid_resource_request');
  assert.match(both.issues[0].hint, /at most|ids for up to 50/);

  const spaced = await f.call('inspect_media', { slugs: ['a,b'] });
  assert.equal(spaced.error, 'invalid_resource_request');
});

test('media search returns compact summaries with full-record tokens', async () => {
  const f = fixture();
  const record = f.records['/wp/v2/media'][0];
  record.caption.raw = 'Long caption';
  record.description.raw = 'Long description';
  record.meta = { private_note: 'Unrelated metadata' };
  record.media_details = { width: 1200, height: 800, image_meta: { camera: 'Camera' }, sizes: {
    medium: { source_url: 'https://example.test/uploads/photo-300.png', width: 300, height: 200, file: 'photo-300.png', mime_type: 'image/png' },
    full: { source_url: 'https://example.test/uploads/photo.png', width: 1200, height: 800, file: 'photo.png', mime_type: 'image/png' },
  } };
  const result = await f.call('inspect_media', { search: 'Photo', limit: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const summary = result.records[0];
  const full = await f.call('inspect_media', { id: 20 });
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    id: 20, title: { raw: 'Photo' }, alt_text: 'Original alt', media_type: 'image', mime_type: 'image/png',
    source_url: 'https://example.test/uploads/photo.png',
    width: 1200, height: 800, sizes: { medium: '300x200' },
    edit_token: full.record.edit_token,
  });
  assert.equal(full.record.description.raw, 'Long description');
  assert.equal(result.may_have_more, true);
  assert.equal(f.requests.some(({ path }) => path.includes('_fields=') && path.includes('/media')), false);
  const plan = await f.call('prepare_media', { id: 20, edit_token: summary.edit_token, fields: { alt: 'Requested alt' } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  record.meta.private_note = 'Changed metadata';
  const stale = await f.call('prepare_media', { id: 20, edit_token: summary.edit_token, fields: { alt: 'Requested alt' } });
  assert.equal(stale.error, 'stale_resource');
  assert.equal(f.writes, 0);
});

test('single attachment results retain writable fields and size URLs without native derived data', async () => {
  const f = fixture();
  const record = f.records['/wp/v2/media'][0];
  record.title.rendered = 'Photo';
  record.description.rendered = '<img srcset="' + 'photo.png '.repeat(1000) + '">';
  record.caption.rendered = '<p>Caption</p>';
  record.caption.raw = 'Caption';
  record.description.raw = 'Description';
  record.link = 'https://example.test/photo/';
  record.type = 'attachment';
  record.guid = { rendered: record.source_url };
  record.class_list = ['attachment'];
  record.meta = { plugin_key: 'metadata'.repeat(500) };
  record.media_details = { width: 1200, height: 800, image_meta: { camera: 'Camera' }, sizes: {
    medium: { source_url: 'https://example.test/uploads/photo-300.png', width: 300, height: 200, file: 'photo-300.png', filesize: 1234, mime_type: 'image/png' },
  } };
  const inspected = await f.call('inspect_media', { id: 20 });
  const compact = JSON.parse(JSON.stringify(inspected.record));
  assert.deepEqual(compact, {
    id: 20, title: { raw: 'Photo' }, caption: { raw: 'Caption' }, description: { raw: 'Description' },
    slug: 'photo', post: 0, alt_text: 'Original alt', media_type: 'image', mime_type: 'image/png',
    source_url: record.source_url, link: record.link, type: 'attachment',
    media_details: { width: 1200, height: 800, sizes: { medium: {
      source_url: 'https://example.test/uploads/photo-300.png', width: 300, height: 200,
    } } }, edit_token: compact.edit_token,
  });
  assert.ok(JSON.stringify(compact).length < JSON.stringify(record).length / 3);
  const plan = await f.call('prepare_media', { id: 20, edit_token: compact.edit_token, fields: { alt: 'New alt' } });
  const saved = await f.call('save_resource', { receipt: plan.receipt });
  const verified = await f.call('verify_resource', { receipt: plan.receipt });

  for (const result of [saved, verified]) {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.record.description.rendered, undefined);
    assert.equal(result.record.meta, undefined);
    assert.equal(result.record.media_details.sizes.medium.file, undefined);
    assert.equal(result.record.media_details.sizes.medium.source_url, compact.media_details.sizes.medium.source_url);
  }

  record.meta.plugin_key = 'another value';
  assert.equal((await f.call('prepare_media', { id: 20, edit_token: verified.record.edit_token, fields: { alt: 'Again' } })).error, 'stale_resource');
});

test('media updates preserve unrelated metadata and reject stale or replayed saves', async () => {
  const f = fixture();
  const inspected = await f.call('inspect_media', { id: 20 });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const plan = await f.call('prepare_media', { id: 20, edit_token: inspected.record.edit_token, fields: { alt: 'Requested alt' } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(f.writes, 0);
  const saved = await f.call('save_resource', { receipt: plan.receipt });
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.records['/wp/v2/media'][0].title.raw, 'Photo');
  assert.equal((await f.call('save_resource', { receipt: plan.receipt })).ok, false);
  assert.equal(f.writes, 1);
  const next = await f.call('inspect_media', { id: 20 });
  const stale = await f.call('prepare_media', { id: 20, edit_token: next.record.edit_token, fields: { alt: 'Next' } });
  f.records['/wp/v2/media'][0].alt_text = 'Another writer';
  assert.equal((await f.call('save_resource', { receipt: stale.receipt })).error, 'stale_resource');
  assert.equal(f.writes, 1);
});

test('native uploads verify their response and never retry an uncertain creation', async () => {
  const f = fixture();
  const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.receipt.upload.size, 8);
  f.interrupt = true;
  f.downloadError = true;
  const saved = await f.call('save_resource', { receipt: plan.receipt });
  assert.equal(saved.persistence, 'uncertain');
  const recovered = await f.call('verify_resource', { receipt: plan.receipt });
  assert.equal(recovered.outcome, 'upload_bytes_unavailable', JSON.stringify(recovered));
  assert.equal(recovered.persistence, 'uncertain');
  const changed = structuredClone(plan.receipt);
  delete changed.upload;
  assert.equal((await f.call('verify_resource', { receipt: changed })).error, 'receipt_mismatch');
  assert.equal(f.window.__blockwork_resources_v1.acknowledged, false);
  assert.equal(f.window.__blockwork_resources_v1.verified, false);
  assert.equal((await f.call('prepare_media', { fields: { slug: 'another' }, upload: png })).error, 'verify_do_not_replay');
  assert.equal(f.writes, 1);
});

test('resource recovery preserves an unresolved receipt before API or sign-in failure', async () => {
  for (const mode of ['api', 'sign-in', 'api-existing', 'sign-in-existing']) {
    const f = fixture();
    const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
    f.interrupt = true;
    await f.call('save_resource', { receipt: plan.receipt });
    delete f.window.__blockwork_resources_v1;

    if (mode.endsWith('-existing')) await f.call('inspect_media', { id: 20 });
    const sessionBefore = JSON.stringify(f.window.__blockwork_resources_v1);
    const wp = f.window.wp;

    if (mode.startsWith('api')) delete f.window.wp;
    else f.location.pathname = '/wp-login.php';
    const before = f.requests.length;
    const result = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 30 });
    assert.equal(result.persistence, 'uncertain');
    assert.equal(result.outcome, 'unavailable');
    assert.deepEqual(result.receipt, plan.receipt);
    assert.equal(f.requests.length, before);
    assert.equal(JSON.stringify(f.window.__blockwork_resources_v1), sessionBefore);
    f.window.wp = wp;
    f.location.pathname = '/wp-admin/upload.php';
    const verified = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 30 });
    assert.equal(verified.persistence, 'verified');
    assert.equal((await f.call('prepare_media', { id: 30, edit_token: verified.record.edit_token, fields: { alt: 'Next' } })).ok, true);
    assert.equal(f.writes, 1);
  }
});

test('an upload that leaves too little time defers its verification to verify_resource', async () => {
  const f = fixture();
  const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
  // The upload finishes 30 seconds into the call, leaving 8 of its 38.
  f.afterWrite = () => { f.elapsedMs = 30000; };

  const deferred = await f.call('save_resource', { receipt: plan.receipt });
  assert.deepEqual([deferred.error, deferred.persistence, deferred.resource_id, deferred.next],
    ['verification_deferred', 'uncertain', 30, 'verify_resource_do_not_replay'], JSON.stringify(deferred));
  assert.match(deferred.hint, /never save the receipt again/);
  assert.equal(f.downloads.length, 0);
  assert.equal((await f.call('prepare_media', { fields: { slug: 'another' }, upload: png })).error, 'verify_do_not_replay');
  f.afterWrite = undefined;
  const verified = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 30 });
  assert.equal(verified.persistence, 'verified', JSON.stringify(verified));
  assert.equal(f.writes, 1);
});

test('an upload past its limit holds the session until post-processing ends, so verification cannot run early', async () => {
  const f = fixture();
  const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
  const apiFetch = f.window.wp.apiFetch;
  let processing;
  // The file is stored, then apiFetch's post-processing runs on without the
  // signal and, when it fails, deletes the attachment.
  f.window.wp.apiFetch = (options) => (options.body
    ? apiFetch(options).then((record) => new Promise((resolve, reject) => {
      processing = { fail() {
        f.records['/wp/v2/media'] = f.records['/wp/v2/media'].filter((item) => item.id !== record.id);
        reject({ code: 'fetch_error', message: 'Could not get a valid response from the server.' });
      } };
    }))
    : apiFetch(options));
  const saving = f.call('save_resource', { receipt: plan.receipt });

  while (!processing) await new Promise((resolve) => setTimeout(resolve, 1));
  f.expire(30000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await f.call('verify_resource', { receipt: plan.receipt })).error, 'operation_in_progress');
  processing.fail();
  const saved = await saving;
  assert.deepEqual([saved.error, saved.persistence, saved.next, saved.diagnostics?.request],
    ['request_timeout', 'uncertain', 'verify_resource_do_not_replay', 'POST /wp/v2/media'], JSON.stringify(saved));
  // A tab that lands on the login page keeps the write uncertain and its receipt.
  f.location.pathname = '/wp-login.php';
  const requests = f.requests.length;
  const signedOut = await f.call('verify_resource', { receipt: plan.receipt });
  assert.deepEqual([signedOut.error, signedOut.persistence, signedOut.outcome, signedOut.next],
    ['reauthorization_required', 'uncertain', 'unavailable', 'verify_resource_do_not_replay'], JSON.stringify(signedOut));
  assert.deepEqual(signedOut.receipt, plan.receipt);
  assert.match(signedOut.hint, /user to sign in.*wait_for_sign_in/);
  assert.equal(f.requests.length, requests);
  f.location.pathname = '/wp-admin/upload.php';
  const verified = await f.call('verify_resource', { receipt: plan.receipt });
  assert.deepEqual([verified.persistence, verified.outcome], ['uncertain', 'not_found'], JSON.stringify(verified));
  assert.equal(f.writes, 1);
});

test('a wait cut to the operation budget reports it spent even when its timer fires early', async () => {
  const f = fixture();
  const apiFetch = f.window.wp.apiFetch;
  f.window.wp.apiFetch = (options) => {
    if (options.path.startsWith('/wp/v2/users/me')) f.elapsedMs = 37950;

    if (options.path.startsWith('/wp/v2/media?')) {
      setTimeout(() => f.expireLatest(), 0);

      return new Promise(() => {});
    }

    return apiFetch(options);
  };

  const timedOut = await f.call('inspect_media', { search: 'photo' });
  assert.equal(timedOut.error, 'request_timeout', JSON.stringify(timedOut));
  assert.equal(timedOut.diagnostics.operation_budget_spent, true);
});

test('a read that outlasts its time reports request_timeout and retry, however apiFetch words it', async () => {
  const f = fixture();
  const apiFetch = f.window.wp.apiFetch;
  f.window.wp.apiFetch = (options) => {
    // The sign-in check uses up the call's time but about 50ms.
    if (options.path.startsWith('/wp/v2/users/me')) f.elapsedMs = 37950;

    if (options.path.startsWith('/wp/v2/media?')) {
      // WordPress's apiFetch reports its own signal's abort as fetch_error.
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () =>
        reject({ code: 'fetch_error', message: 'Could not get a valid response from the server.' })));
    }

    return apiFetch(options);
  };

  const timedOut = await f.call('inspect_media', { search: 'photo' });
  assert.deepEqual([timedOut.error, timedOut.next, timedOut.diagnostics?.request, timedOut.diagnostics?.operation_budget_spent],
    ['request_timeout', 'retry', 'GET /wp/v2/media', true], JSON.stringify(timedOut));
  assert.ok(timedOut.diagnostics.waited_ms <= 50);
  // The native rejection from the same abort is kept for development debug.
  assert.equal(timedOut.debug?.cause?.code, 'fetch_error');
  assert.match(timedOut.hint, /wait a few seconds and call again/);

  // A preparation writes nothing, so a timed-out read there can also run again.
  const preparing = fixture();
  const preparingFetch = preparing.window.wp.apiFetch;
  preparing.window.wp.apiFetch = (options) => {
    if (options.path.startsWith('/wp/v2/users/me')) preparing.elapsedMs = 37950;

    return options.method === 'OPTIONS' ? new Promise(() => {}) : preparingFetch(options);
  };

  const prepared = await preparing.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
  assert.deepEqual([prepared.error, prepared.next, prepared.persistence], ['request_timeout', 'retry', 'not_attempted'], JSON.stringify(prepared));

  // A request that fails without running out of time is a reachability problem.
  const unreachable = fixture();
  const unreachableFetch = unreachable.window.wp.apiFetch;
  unreachable.window.wp.apiFetch = (options) => (options.path.startsWith('/wp/v2/media?')
    ? Promise.reject({ code: 'fetch_error', message: 'Could not get a valid response from the server.' })
    : unreachableFetch(options));
  const failed = await unreachable.call('inspect_media', { search: 'photo' });
  assert.deepEqual([failed.error, failed.next], ['fetch_error', 'retry'], JSON.stringify(failed));
  assert.match(failed.hint, /site is up/);
});

test('acknowledged upload has a verified native attachment and exact requested metadata', async () => {
  const f = fixture();
  const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload', alt: 'Fixture image' }, upload: png });
  const saved = await f.call('save_resource', { receipt: plan.receipt });
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(saved.record.alt_text, 'Fixture image');
  assert.equal(saved.resource_id, 30);
  assert.equal((await f.call('verify_resource', { receipt: plan.receipt, resource_id: 20 })).error, 'resource_id_mismatch');
});

test('acknowledged media creation corrects only mismatched metadata with one ID update', async () => {
  const f = fixture();
  f.afterWrite = (record, selected) => { if (!selected) record.title.raw = 'fan installation hero'; };

  const plan = await f.call('prepare_media', { fields: { title: 'Fan Installation hero', slug: 'fan-installation-hero', alt: 'Fan' }, upload: png });
  const saved = await f.call('save_resource', { receipt: plan.receipt });
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(saved.record.title.raw, 'Fan Installation hero');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.corrective_update)), { fields: ['title'], acknowledged: true });
  const writes = f.requests.filter(({ method }) => method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes.filter(({ upload }) => upload).length, 1);
  assert.equal(writes[1].path, '/wp/v2/media/30');
  assert.deepEqual(writes[1].data, { title: 'Fan Installation hero' });
  const verified = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 30 });
  assert.deepEqual(verified.corrective_update, saved.corrective_update);
  const next = await f.call('prepare_media', { id: 30, edit_token: saved.record.edit_token, fields: { alt: 'Next alt' } });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(f.writes, 2);
});

test('a slug made unique after upload sends no corrective request and settles for another preparation', async () => {
  const f = fixture();
  f.afterWrite = (record) => { record.slug = 'fixture-upload-2'; };

  const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
  const saved = await f.call('save_resource', { receipt: plan.receipt });
  assert.deepEqual([saved.error, saved.persistence, saved.outcome, saved.next], ['verification_mismatch', 'different', 'different', 'inspect_resource']);
  assert.deepEqual(Array.from(saved.diagnostics.fields), ['slug']);
  assert.equal(saved.diagnostics.slug_made_unique, true);
  assert.equal(JSON.stringify(saved.diagnostics).includes('fixture-upload'), false);
  assert.match(saved.hint, /WordPress found the requested slug in use.*keep the stored slug or prepare an update with a different one/);
  assert.equal(saved.corrective_update, undefined);
  assert.equal(saved.record.slug, 'fixture-upload-2');
  assert.equal(f.writes, 1);
  assert.equal(f.requests.filter(({ method }) => method === 'POST').length, 1);
  assert.equal(f.window.__blockwork_resources_v1.settled, true);
  const verified = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 30 });
  assert.equal(verified.diagnostics.slug_made_unique, true);
  assert.equal(verified.corrective_update, undefined);
  const next = await f.call('prepare_media', { id: 30, edit_token: verified.record.edit_token, fields: { slug: 'another-slug' } });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(f.writes, 1);
});

test('a slug made unique beside a rewritten title corrects only the title', async () => {
  const f = fixture();
  f.afterWrite = (record, selected) => {
    if (!selected) { record.slug = 'fixture-upload-23'; record.title.raw = 'Rewritten'; }
  };

  const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
  const saved = await f.call('save_resource', { receipt: plan.receipt });
  assert.deepEqual([saved.error, saved.persistence, saved.next], ['verification_mismatch', 'different', 'inspect_resource']);
  assert.deepEqual(Array.from(saved.diagnostics.fields), ['slug']);
  assert.equal(saved.diagnostics.slug_made_unique, true);
  assert.equal(saved.record.title.raw, 'Fixture');
  assert.equal(saved.record.slug, 'fixture-upload-23');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.corrective_update)), { fields: ['title'], acknowledged: true });
  const writes = f.requests.filter(({ method }) => method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[1].path, '/wp/v2/media/30');
  assert.deepEqual(writes[1].data, { title: 'Fixture' });
  assert.equal(f.window.__blockwork_resources_v1.settled, true);
});

test('a slug differing in another way still receives a corrective update', async () => {
  for (const storedSlug of ['unrelated-slug-2', 'fixture-upload-copy', 'fixture-upload-2-copy']) {
    const f = fixture();
    f.afterWrite = (record, selected) => { if (!selected) record.slug = storedSlug; };

    const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
    const saved = await f.call('save_resource', { receipt: plan.receipt });
    assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
    assert.equal(saved.record.slug, 'fixture-upload');
    assert.deepEqual(JSON.parse(JSON.stringify(saved.corrective_update)), { fields: ['slug'], acknowledged: true });
    const writes = f.requests.filter(({ method }) => method === 'POST');
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].data, { slug: 'fixture-upload' });
  }
});

test('persistent upload field rewrites report names and settle for a fresh same-ID repair', async () => {
  const f = fixture();
  f.afterWrite = (record) => { record.title.raw = 'private stored value'; };

  const plan = await f.call('prepare_media', { fields: { title: 'private desired value', slug: 'fixture-upload' }, upload: png });
  const saved = await f.call('save_resource', { receipt: plan.receipt });
  assert.deepEqual([saved.error, saved.persistence, saved.outcome, saved.next], ['verification_mismatch', 'different', 'different', 'inspect_resource']);
  assert.deepEqual(Array.from(saved.diagnostics.fields), ['title']);
  assert.equal(JSON.stringify(saved.diagnostics).includes('private'), false);
  assert.match(saved.hint, /fresh edit_token/);
  assert.equal(saved.corrective_update.acknowledged, true);
  assert.equal(f.window.__blockwork_resources_v1.verified, false);
  assert.equal(f.window.__blockwork_resources_v1.settled, true);
  const again = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 30 });
  assert.equal(again.error, 'verification_mismatch');
  const stale = await f.call('prepare_media', { id: 30, edit_token: '0'.repeat(64), fields: { title: 'private desired value' } });
  assert.equal(stale.error, 'stale_resource');
  assert.equal(stale.persistence, 'not_attempted');
  assert.equal(stale.next, 'inspect_resource');
  assert.equal(f.window.__blockwork_resources_v1.settled, true);
  const repair = await f.call('prepare_media', { id: 30, edit_token: again.record.edit_token, fields: { title: 'private desired value' } });
  assert.equal(repair.ok, true, JSON.stringify(repair));
  assert.equal(f.writes, 2);
});

test('uncertain corrective updates stay blocked until exact-ID verification, never reupload', async () => {
  for (const mode of ['lost', 'unconfirmed', 'deferred']) {
    const f = fixture();
    f.afterWrite = (record, selected) => {
      if (!selected) record.title.raw = 'rewritten';
      else if (mode === 'lost') f.interrupt = true;
      else if (mode === 'deferred') f.elapsedMs = 30000;
    };

    const native = f.window.wp.apiFetch;

    if (mode === 'unconfirmed') f.window.wp.apiFetch = async (options) => {
      const result = await native(options);

      return options.method === 'POST' && options.data ? { id: 99 } : result;
    };

    const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
    const result = await f.call('save_resource', { receipt: plan.receipt });
    assert.equal(result.persistence, 'uncertain', JSON.stringify(result));
    assert.equal(result.resource_id, 30);
    assert.equal(result.corrective_update.acknowledged, mode === 'deferred');
    assert.deepEqual(Array.from(result.corrective_update.fields), ['title']);
    const blocked = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'Next', slug: 'next' } });
    assert.equal(blocked.error, 'verify_do_not_replay');
    assert.match(blocked.hint, /verify_resource/);
    assert.equal(blocked.hint.includes('Call status'), false);
    const verified = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 30 });
    assert.equal(verified.persistence, 'verified', JSON.stringify(verified));
    assert.equal((await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'Next', slug: 'next' } })).ok, true);
    assert.equal(f.writes, 2);
    assert.equal(f.requests.filter(({ upload }) => upload).length, 1);
  }
});

test('acknowledgment cannot settle a missing attachment or unavailable bytes after a MIME change', async () => {
  for (const mode of ['missing', 'bytes']) {
    const f = fixture();
    f.afterWrite = (record) => {
      if (mode === 'missing') f.records['/wp/v2/media'].pop();
      else {
        record.title.raw = 'Rewritten';
        record.mime_type = 'application/octet-stream';
        f.downloadError = true;
      }
    };

    const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
    const result = await f.call('save_resource', { receipt: plan.receipt });
    assert.equal(result.persistence, 'uncertain', JSON.stringify(result));
    assert.equal(result.outcome, mode === 'missing' ? 'not_found' : 'upload_bytes_unavailable');
    assert.equal(f.window.__blockwork_resources_v1.acknowledged, true);
    assert.equal(f.window.__blockwork_resources_v1.settled, false);
    assert.equal(result.corrective_update, undefined);

    assert.equal((await f.call('prepare_media', { fields: { slug: 'another' }, upload: png })).error, 'verify_do_not_replay');
    assert.equal(f.writes, 1);
  }
});

test('only acknowledged field mismatches settle creates, and terms get no automatic correction', async () => {
  for (const kind of ['media', 'term']) {
    for (const acknowledged of [true, false]) {
      const f = fixture();
      f.afterWrite = (record) => { if (kind === 'media') record.title.raw = 'Rewritten'; else record.name = 'Rewritten'; };

      const plan = kind === 'media'
        ? await f.call('prepare_media', { fields: { title: 'Requested', slug: 'new-resource' }, upload: png })
        : await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'Requested', slug: 'new-resource' } });
      f.interrupt = !acknowledged;
      await f.call('save_resource', { receipt: plan.receipt });
      const result = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 30 });
      assert.equal(result.error, 'verification_mismatch', JSON.stringify(result));
      assert.equal(result.persistence, 'different');
      assert.equal(f.window.__blockwork_resources_v1.verified, false);
      assert.equal(f.window.__blockwork_resources_v1.settled, acknowledged);
      assert.equal(result.next, acknowledged ? 'inspect_resource' : 'verify_resource_do_not_replay');
      const next = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'Next', slug: 'next' } });
      assert.equal(next.ok, acknowledged, JSON.stringify(next));
      assert.equal(f.writes, kind === 'media' && acknowledged ? 2 : 1);

      if (kind === 'term') assert.equal(result.corrective_update, undefined);
    }
  }
});

test('term creation reconciles a lost response from a fresh authenticated document', async () => {
  const f = fixture();
  const plan = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'New topic', slug: 'new-topic' } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  f.interrupt = true;
  assert.equal((await f.call('save_resource', { receipt: plan.receipt })).persistence, 'uncertain');
  delete f.window.__blockwork_resources_v1;
  const recovered = await f.call('verify_resource', { receipt: plan.receipt });
  assert.equal(recovered.persistence, 'verified', JSON.stringify(recovered));
  assert.equal(f.writes, 1);
});

test('lost upload acknowledgments recover by exact original bytes after losing page state', async () => {
  const f = fixture();
  const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
  f.interrupt = true;
  assert.equal((await f.call('save_resource', { receipt: plan.receipt })).persistence, 'uncertain');
  delete f.window.__blockwork_resources_v1;
  const receipt = JSON.parse(JSON.stringify(plan.receipt));
  const recovered = await f.call('verify_resource', { receipt });

  assert.equal(recovered.persistence, 'verified', JSON.stringify(recovered));
  assert.equal(recovered.outcome, 'matched_desired');
  assert.equal(recovered.resource_id, 30);
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].credentials, 'same-origin');
  assert.equal(f.downloads[0].redirect, 'error');
  assert.equal((await f.call('save_resource', { receipt })).error, 'resource_not_prepared');
  const record = f.records['/wp/v2/media'].at(-1);
  record.title.raw = 'A later native edit';
  const changed = await f.call('verify_resource', { receipt, resource_id: 30 });
  assert.equal(changed.persistence, 'different');
  assert.equal(changed.next, 'inspect_resource');
  assert.equal(f.window.__blockwork_resources_v1.verified, false);
  assert.equal(f.window.__blockwork_resources_v1.settled, true);
  assert.equal((await f.call('prepare_media', { id: 30, edit_token: changed.record.edit_token, fields: { alt: 'Next' } })).ok, true);
  assert.equal(f.writes, 1);
});

test('scaled native media recover only against the preserved original file', async () => {
  const f = fixture();
  const plan = await f.call('prepare_media', { fields: { slug: 'scaled-fixture' }, upload: png });
  f.afterWrite = (record) => {
    record.source_url = 'https://example.test/uploads/new-scaled.png';
    record.media_details.original_image = 'new.png';
  };

  f.interrupt = true;
  await f.call('save_resource', { receipt: plan.receipt });
  delete f.window.__blockwork_resources_v1;
  const result = await f.call('verify_resource', { receipt: plan.receipt });

  assert.equal(result.persistence, 'verified', JSON.stringify(result));
  assert.equal(f.downloads[0].url, 'https://example.test/uploads/new.png');
  assert.equal(f.writes, 1);
});

test('matching upload metadata cannot prove different, inaccessible, or foreign source bytes', async () => {
  for (const mode of ['different', 'unavailable', 'foreign', 'invalid-original', 'redirect']) {
    const f = fixture();
    const plan = await f.call('prepare_media', { fields: { title: 'Fixture', slug: 'fixture-upload' }, upload: png });
    f.interrupt = true;
    await f.call('save_resource', { receipt: plan.receipt });
    delete f.window.__blockwork_resources_v1;
    const record = f.records['/wp/v2/media'].at(-1);

    if (mode === 'different') f.files.set(record.source_url, new Uint8Array(8));

    if (mode === 'unavailable' || mode === 'redirect') f.downloadError = true;

    if (mode === 'foreign') record.source_url = 'https://cdn.example.test/new.png';

    if (mode === 'invalid-original') record.media_details.original_image = '../new.png';
    const result = await f.call('verify_resource', { receipt: plan.receipt });

    assert.equal(result.persistence, 'uncertain', JSON.stringify(result));
    assert.equal(result.outcome, mode === 'different' ? 'upload_bytes_different' : 'upload_bytes_unavailable');
    assert.equal(f.downloads.length, ['foreign', 'invalid-original'].includes(mode) ? 0 : 1);
    record.title.raw = 'Rewritten';
    const mismatched = await f.call('verify_resource', { receipt: plan.receipt });
    assert.equal(mismatched.persistence, 'uncertain');
    assert.equal(mismatched.error, 'verification_mismatch');

    if (mode !== 'different') assert.equal((await f.call('prepare_media', { fields: { slug: 'another' }, upload: png })).error, 'verify_do_not_replay');

    assert.equal(f.writes, 1);
  }
});

test('a rewritten upload settles the session without claiming byte verification', async () => {
  const f = fixture();
  const plan = await f.call('prepare_media', { fields: { slug: 'fixture-upload' }, upload: png });
  f.interrupt = true;
  await f.call('save_resource', { receipt: plan.receipt });
  const record = f.records['/wp/v2/media'].at(-1);
  f.files.set(record.source_url, new Uint8Array(8));
  const result = await f.call('verify_resource', { receipt: plan.receipt });
  assert.equal(result.error, 'upload_bytes_different');
  assert.equal(result.persistence, 'uncertain');
  assert.equal(result.outcome, 'upload_bytes_different');
  assert.equal(result.next, 'inspect_resource');
  assert.equal(result.resource_id, record.id);
  assert.match(result.hint, /Do not upload again/);
  assert.equal(f.window.__blockwork_resources_v1.settled, true);
  assert.equal((await f.call('prepare_media', { fields: { slug: 'another' }, upload: png })).ok, true);
  assert.equal(f.writes, 1);
});

test('upload verification cancels the source stream at the receipt byte bound', async () => {
  const f = fixture();
  const plan = await f.call('prepare_media', { fields: { slug: 'fixture-upload' }, upload: png });
  f.interrupt = true;
  await f.call('save_resource', { receipt: plan.receipt });
  delete f.window.__blockwork_resources_v1;
  let canceled = false;
  f.downloadResponse = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); },
    cancel() { canceled = true; } }));

  const result = await f.call('verify_resource', { receipt: plan.receipt });

  assert.equal(result.persistence, 'uncertain');
  assert.equal(result.outcome, 'upload_bytes_unavailable');
  assert.equal(canceled, true);
  assert.equal(f.writes, 1);
});

test('failed fresh verification preserves its receipt without binding the unauthenticated tab', async () => {
  const original = fixture();
  const plan = await original.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'New', slug: 'new-topic' } });

  for (const mode of ['foreign', 'login', 'api', 'auth']) {
    const f = fixture();
    const site = mode === 'foreign' ? { ...target, site_url: 'https://other.test' } : target;
    f.location.href = `${site.site_url}/wp-admin/upload.php`;
    const apiFetch = f.window.wp.apiFetch;
    const signedIn = async options => options.path === '/?_fields=url' ? { url: site.site_url } : apiFetch(options);
    f.window.wp.apiFetch = signedIn;

    if (mode === 'login') f.location.pathname = '/wp-login.php';

    if (mode === 'api') delete f.window.wp.apiFetch;

    if (mode === 'auth') f.auth = false;
    const result = await f.call('verify_resource', { receipt: plan.receipt });
    assert.equal(result.error, { foreign: 'target_mismatch', login: 'reauthorization_required', api: 'native_api_unavailable', auth: 'reauthorization_required' }[mode]);
    assert.equal(JSON.stringify(result.receipt), JSON.stringify(plan.receipt));
    assert.equal(result.persistence, 'uncertain');
    assert.equal(result.next, 'verify_resource_do_not_replay');
    assert.equal(f.window.__blockwork_resources_v1, undefined);
    f.location.pathname = '/wp-admin/upload.php';
    f.window.wp.apiFetch = signedIn;
    f.auth = true;
    assert.equal((await f.call('inspect_terms', { target: site, taxonomy: 'topic', id: 10 })).ok, true);
    assert.equal((await f.call('prepare_term', { target: site, taxonomy: 'topic', action: 'create', fields: { name: 'Next', slug: 'next' } })).ok, true);
    assert.equal(f.writes, 0);
  }
});

test('a page without its body yet reports loading, not an unsupported version', async () => {
  const f = fixture();
  f.document.body = null;
  const result = await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });
  assert.equal(result.error, 'page_loading', JSON.stringify(result));
  assert.equal(f.requests.length, 0);
});

test('a missing capability is a permission error, not a sign-in request', async () => {
  const f = fixture();
  f.denied = true;
  const result = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'New', slug: 'new-topic' } });
  assert.deepEqual([result.error, result.diagnostics?.wordpress_error, result.persistence], ['permission_denied', 'rest_cannot_create', 'not_attempted'], JSON.stringify(result));
  assert.equal(JSON.stringify({ ...result, debug: undefined }).includes('secret'), false);
  assert.equal(f.writes, 0);
});

test('verification leaves an existing session unchanged when authentication fails', async () => {
  const original = fixture();
  const plan = await original.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'New', slug: 'new-topic' } });
  const f = fixture();
  await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });
  const session = f.window.__blockwork_resources_v1;
  const before = JSON.stringify(session);
  f.auth = false;
  const result = await f.call('verify_resource', { receipt: plan.receipt });
  assert.equal(result.error, 'reauthorization_required');
  assert.equal(JSON.stringify(result.receipt), JSON.stringify(plan.receipt));
  assert.equal(f.window.__blockwork_resources_v1, session);
  assert.equal(JSON.stringify(session), before);
  assert.equal(f.writes, 0);
});

test('fresh resource recovery rejects modified receipts and wrong candidate identities', async () => {
  const f = fixture();
  const plan = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'New topic', slug: 'new-topic' } });
  f.interrupt = true;
  await f.call('save_resource', { receipt: plan.receipt });
  delete f.window.__blockwork_resources_v1;

  for (const change of [{ desired: { name: 'Different', slug: 'new-topic' } }, { taxonomy: 'category' }, { action: 'delete', id: 10 }]) {
    const result = await f.call('verify_resource', { receipt: { ...plan.receipt, ...change } });

    assert.equal(result.error, 'receipt_mismatch', JSON.stringify(result));
  }

  assert.equal((await f.call('verify_resource', { receipt: plan.receipt, resource_id: 10 })).error, 'resource_id_mismatch');
  assert.equal(f.writes, 1);
});

test('fresh term update recovery distinguishes desired, original, different, and missing records', async () => {
  for (const mode of ['desired', 'original', 'different', 'missing']) {
    const f = fixture();
    const inspected = await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });

    const plan = await f.call('prepare_term', { taxonomy: 'topic', action: 'update', id: 10,
      edit_token: inspected.record.edit_token, fields: { name: 'Renamed' } });

    if (mode === 'original') f.beforeWrite = () => { throw new Error('connection-failed'); };

    f.interrupt = true;
    await f.call('save_resource', { receipt: plan.receipt });

    if (mode === 'different') f.records['/custom/v1/topics'][0].description = 'Another edit';

    if (mode === 'missing') f.records['/custom/v1/topics'] = [];
    delete f.window.__blockwork_resources_v1;
    const recovered = await f.call('verify_resource', { receipt: plan.receipt });

    assert.equal(recovered.outcome, { desired: 'matched_desired', original: 'matched_original', different: 'different', missing: 'not_found' }[mode], JSON.stringify(recovered));
    assert.equal(recovered.persistence, { desired: 'verified', original: 'original', different: 'different', missing: 'uncertain' }[mode]);
    assert.equal((await f.call('save_resource', { receipt: plan.receipt })).error, 'resource_not_prepared');
    const next = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'Next', slug: 'next' } });
    assert.equal(next.ok, mode !== 'missing', JSON.stringify(next));
    assert.equal(f.writes, mode === 'original' ? 0 : 1);
  }
});

test('fresh creation recovery refuses absent and duplicate candidates without permitting a replay', async () => {
  for (const kind of ['term', 'media']) {
    for (const mode of ['not_found', 'ambiguous']) {
      const f = fixture();

      const plan = kind === 'media'
        ? await f.call('prepare_media', { fields: { slug: 'new-resource' }, upload: png })
        : await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'New', slug: 'new-resource' } });

      f.interrupt = true;
      await f.call('save_resource', { receipt: plan.receipt });
      const path = kind === 'media' ? '/wp/v2/media' : '/custom/v1/topics';

      if (mode === 'not_found') f.records[path].pop();
      else f.records[path].push({ ...structuredClone(f.records[path].at(-1)), id: 99 });
      delete f.window.__blockwork_resources_v1;
      const result = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 30 });

      assert.equal(result.persistence, 'uncertain', JSON.stringify(result));
      assert.equal(result.outcome, mode);
      assert.equal((await f.call('save_resource', { receipt: plan.receipt })).error, 'resource_not_prepared');
      assert.equal((await f.call('prepare_media', { fields: { slug: 'another' }, upload: png })).error, 'verify_do_not_replay');
      assert.equal(f.downloads.length, 0);
      assert.equal(f.writes, 1);
    }
  }
});

test('fresh deletion recovery requires native absence of the receipt ID and authentication', async () => {
  for (const mode of ['deleted', 'original', 'different', 'unavailable']) {
    const f = fixture();
    const inspected = await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });

    const plan = await f.call('prepare_term', { taxonomy: 'topic', action: 'delete', id: 10,
      edit_token: inspected.record.edit_token, scope: 'all_relationships' });

    if (mode !== 'deleted') f.beforeWrite = () => { throw new Error('connection-failed'); };

    f.interrupt = true;
    await f.call('save_resource', { receipt: plan.receipt });

    if (mode === 'different') f.records['/custom/v1/topics'][0].name = 'Another edit';

    if (mode === 'unavailable') f.auth = false;
    delete f.window.__blockwork_resources_v1;
    const result = await f.call('verify_resource', { receipt: plan.receipt });

    assert.equal(result.outcome, { deleted: 'deleted', original: 'matched_original', different: 'different', unavailable: 'unavailable' }[mode], JSON.stringify(result));
    assert.equal(result.persistence, { deleted: 'verified', original: 'original', different: 'different', unavailable: 'uncertain' }[mode]);

    if (mode === 'unavailable') {
      assert.equal(result.error, 'reauthorization_required');
      assert.equal(f.window.__blockwork_resources_v1, undefined);
    }

    f.auth = true;
    const next = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'Next', slug: 'next' } });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(f.writes, mode === 'deleted' ? 1 : 0);
  }
});

test('term edits use the discovered namespace and enforce relationship scope before deletion', async () => {
  const f = fixture();
  const inspected = await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });
  const refused = await f.call('prepare_term', { taxonomy: 'topic', id: 10, action: 'delete', edit_token: inspected.record.edit_token });
  assert.equal(refused.error, 'term_deletion_scope_required');
  const plan = await f.call('prepare_term', { taxonomy: 'topic', id: 10, action: 'update', edit_token: inspected.record.edit_token, fields: { name: 'Renamed' } });
  assert.equal((await f.call('save_resource', { receipt: plan.receipt })).persistence, 'verified');
  assert.deepEqual(f.records['/custom/v1/topics'][0].meta, { note: 'keep' });
  const fresh = await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });
  const deletion = await f.call('prepare_term', { taxonomy: 'topic', id: 10, action: 'delete', edit_token: fresh.record.edit_token, scope: 'all_relationships' });
  assert.equal(deletion.ok, true, JSON.stringify(deletion));
  f.records['/custom/v1/topics'].push({ id: 11, parent: 10 });
  assert.equal((await f.call('save_resource', { receipt: deletion.receipt })).error, 'stale_term_impact');
  assert.equal(f.writes, 1);
});

test('term deletion verifies absence, while authentication failure cannot prove deletion', async () => {
  const f = fixture();
  const inspected = await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });
  const plan = await f.call('prepare_term', { taxonomy: 'topic', id: 10, action: 'delete', edit_token: inspected.record.edit_token, scope: 'all_relationships' });
  const saved = await f.call('save_resource', { receipt: plan.receipt });
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  f.auth = false;
  assert.equal((await f.call('verify_resource', { receipt: plan.receipt })).ok, false);
});

test('deletion recovery cannot substitute a missing ID for the intended term', async () => {
  const f = fixture();
  const inspected = await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });
  const plan = await f.call('prepare_term', { taxonomy: 'topic', id: 10, action: 'delete', edit_token: inspected.record.edit_token, scope: 'all_relationships' });
  f.beforeWrite = () => { throw new Error('connection-failed'); };

  assert.equal((await f.call('save_resource', { receipt: plan.receipt })).persistence, 'uncertain');
  const recovered = await f.call('verify_resource', { receipt: plan.receipt, resource_id: 999 });
  assert.equal(recovered.error, 'resource_id_mismatch');
  assert.equal(f.records['/custom/v1/topics'][0].id, 10);
  assert.equal(f.window.__blockwork_resources_v1.verified, false);
  assert.equal((await f.call('verify_resource', { receipt: plan.receipt })).outcome, 'matched_original');
  assert.equal(f.writes, 0);
});

test('upload validation accepts the 5 MiB boundary and refuses oversized or malformed bytes', async () => {
  const f = fixture();
  const fields = { slug: 'large-fixture' };
  const upload = { ...png, base64: Buffer.alloc(5 * 1024 * 1024).toString('base64') };
  const plan = await f.call('prepare_media', { fields, upload });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.receipt.upload.size, 5242880);
  upload.base64 = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  const oversized = await f.call('prepare_media', { fields, upload });
  assert.equal(oversized.error, 'upload_too_large');
  assert.equal(oversized.persistence, 'not_attempted');
  assert.match(oversized.hint, /5 MiB.*Resize or recompress/);
  assert.equal(f.writes, 0);

  const fresh = fixture();
  upload.base64 = Buffer.alloc(5 * 1024 * 1024 + 2).toString('base64');
  const rejected = await fresh.call('prepare_media', { fields, upload });
  assert.equal(rejected.error, 'invalid_resource_request');
  assert.equal(rejected.issues[0].path, 'upload.base64');
  assert.match(rejected.issues[0].hint, /5 MiB.*Resize or recompress/);
  assert.deepEqual(fresh.requests, []);
  assert.equal(fresh.window.__blockwork_resources_v1, undefined);

  const receipt = structuredClone(plan.receipt);
  receipt.upload.size = 5242881;
  const invalidReceipt = await fresh.call('verify_resource', { receipt });
  assert.equal(invalidReceipt.error, 'invalid_resource_request');
  assert.equal(invalidReceipt.issues[0].path, 'receipt.upload.size');
  assert.deepEqual(fresh.requests, []);

  for (const base64 of ['AA=A', 'AAAA=', 'A===', '%%%=', 'AAA']) {
    assert.equal((await f.call('prepare_media', { fields, upload: { ...png, base64 } })).ok, false, base64);
  }

  assert.equal(f.writes, 0);
});

test('resource currentness checks reject unrelated server changes after a successful response', async () => {
  const f = fixture();
  const inspected = await f.call('inspect_media', { id: 20 });
  const plan = await f.call('prepare_media', { id: 20, edit_token: inspected.record.edit_token, fields: { alt: 'Updated' } });
  f.afterWrite = (record) => { record.caption.raw = 'Intervening change'; };

  const result = await f.call('save_resource', { receipt: plan.receipt });
  assert.equal(result.persistence, 'different', JSON.stringify(result));
  assert.equal(f.writes, 1);
});

test('term parent changes cannot introduce a cycle between preparation and save', async () => {
  const f = fixture();
  const parent = { ...structuredClone(f.records['/custom/v1/topics'][0]), id: 11, slug: 'parent' };

  f.records['/custom/v1/topics'].push(parent);
  const inspected = await f.call('inspect_terms', { taxonomy: 'topic', id: 10 });

  const plan = await f.call('prepare_term', { taxonomy: 'topic', action: 'update', id: 10,
    edit_token: inspected.record.edit_token, fields: { parent_id: 11 } });

  assert.equal(plan.ok, true, JSON.stringify(plan));
  parent.parent = 10;
  assert.equal((await f.call('save_resource', { receipt: plan.receipt })).error, 'stale_resource_reference');
  assert.equal(f.writes, 0);
});

for (const [desired, actual, expected] of [
  ['R&D', 'R&amp;D', true],
  ['R&amp;D', 'R&amp;D', true],
  ['R&amp;D', 'R&amp;amp;D', false],
  ['R&amp;amp;D', 'R&amp;D', false],
  ['A & B &copy;', 'A &amp; B &copy;', true],
  ['A &#38; B', 'A &amp;#38; B', false],
  ['A &#x26; B', 'A &amp;#x26; B', false],
  ['A<b>B</b>', 'AB', false],
  ['R&D', 'R&amp;D changed', false],
]) {
  test(`term comparison preserves intent: ${desired} to ${actual}`, async () => {
    const f = fixture();
    f.afterWrite = (record) => { record.name = actual; record.description = actual; };

    const prepared = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: desired, description: desired, slug: 'edge-case' } });
    const saved = await f.call('save_resource', { receipt: prepared.receipt });
    assert.equal(saved.persistence === 'verified', expected, JSON.stringify(saved));
    assert.equal(f.writes, 1);
  });
}

test('term meta encoding remains an exact comparison', async () => {
  const f = fixture();
  f.afterWrite = (record) => { record.meta.note = 'R&amp;D'; };

  const prepared = await f.call('prepare_term', { taxonomy: 'topic', action: 'create', fields: { name: 'Test', slug: 'edge-case', meta: { note: 'R&D' } } });
  const saved = await f.call('save_resource', { receipt: prepared.receipt });
  assert.equal(saved.persistence, 'different', JSON.stringify(saved));
});

for (const [filename, allowed] of [
  ['日本語.png', true], ['café.png', true], ['cafe\u0301.png', true], ['🟦.png', true], ['name #1?.png', true],
  ['../escape.png', false], ['..', false], ['.', false], ['folder/file.png', false], ['folder\\file.png', false],
  ['%2e%2e%2fescape.png', false], ['bad\u0000.png', false], ['bad\u007f.png', false],
]) {
  test(`original filename uses one safe segment: ${JSON.stringify(filename)}`, async () => {
    const f = fixture();
    const prepared = await f.call('prepare_media', { fields: { slug: 'scaled-fixture' }, upload: { name: 'safe.png', mime_type: 'image/png', base64: 'iVBORw0KGgo=' } });

    f.afterWrite = (record) => { record.source_url = 'https://example.test/uploads/new-scaled.png'; record.media_details.original_image = filename; };

    f.interrupt = true;
    await f.call('save_resource', { receipt: prepared.receipt });
    f.files.set('https://example.test/uploads/' + encodeURIComponent(filename), f.files.get('https://example.test/uploads/new.png'));
    delete f.window.__blockwork_resources_v1;
    const recovered = await f.call('verify_resource', { receipt: prepared.receipt });
    assert.equal(recovered.persistence === 'verified', allowed, JSON.stringify(recovered));
    assert.equal(f.downloads.length, allowed ? 1 : 0);
    assert.equal(f.writes, 1);
  });
}
