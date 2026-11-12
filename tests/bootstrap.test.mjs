import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createBlockwork } from '../skills/blockwork/scripts/bootstrap.mjs';

const target = { site_url: 'https://example.test', user_id: 5, post_id: 7, post_type: 'page' };
const connection = { target: { site_url: target.site_url, post_id: 7, post_type: 'page' }, workflow: 'attached' };

// The tab starts at 1280 by 720, takes each override's size, and on a clear
// returns to emulation.natural, the browser's own size, when a test sets one.
// Screenshots come from capture, which sees each Page.captureScreenshot's
// parameters. The tab's devicePixelRatio, browser zoom, and pinch scale are
// 1 unless a test sets emulation.devicePixelRatio, zoom, or pinch.
function capability(respond, requests, emulation, capture) {
  let request;
  let size = [1280, 720];

  return { async send(method, params) {
    if (method === 'Runtime.evaluate' && params.expression.startsWith('(() => { try { return !!document.querySelector(')) {
      return { result: { value: 'selectorCheck' in emulation ? emulation.selectorCheck : true } };
    }

    if (method === 'Runtime.evaluate' && params.expression.startsWith("(() => { for (const element of document.querySelectorAll('[data-blockwork-hidden-notice]')")) {
      return emulation.restoreNotices ? emulation.restoreNotices(params.expression) : {};
    }

    if (['DOM.enable', 'DOM.getDocument', 'DOM.querySelector', 'CSS.enable', 'CSS.forcePseudoState'].includes(method)) {
      emulation.stateCalls?.push([method, params]);

      if (emulation.stateFailure?.(method, params)) throw new Error('State command failed');

      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };

      if (method === 'DOM.querySelector') return { nodeId: 2 };

      return {};
    }

    if (method === 'Page.captureScreenshot') {
      return { data: Buffer.from(await capture(params)).toString('base64') };
    }

    if (method === 'Page.getLayoutMetrics') {
      return { cssVisualViewport: { zoom: emulation.zoom ?? 1, scale: emulation.pinch ?? 1 } };
    }

    if (method === 'Runtime.evaluate' && params.expression === 'devicePixelRatio') {
      return { result: { value: emulation.devicePixelRatio ?? 1 } };
    }

    if (method.startsWith('Emulation.')) {
      emulation.push(params?.width ? [method, params.width, params.height] : [method]);

      if (emulation.refuse?.(method)) {
        throw new Error('Emulation is unavailable');
      }

      size = params?.width ? [params.width, params.height] : (emulation.natural ?? [1280, 720]);

      return {};
    }

    // capture_page's own page check, which awaits its result directly.
    if (method === 'Runtime.evaluate' && params.awaitPromise) {
      if (emulation.page) {
        return emulation.page(params.expression);
      }

      const [, width, height] = emulation.findLast(([name]) => name === 'Emulation.setDeviceMetricsOverride') ?? [];
      const missing = params.expression.includes('"selector":".missing"');
      const shown = { ok: true, width, height, scroll_x: 0, scroll_y: 0, scroll_width: width, finished_animations: 0, hidden_notices: 0, selector_offset: 0, elements: [] };

      return { result: { value: missing ? { ok: false, error: 'selector_not_found', field: 'selector' } : shown } };
    }

    if (method === 'Runtime.evaluate' && params.expression === '[innerWidth, innerHeight]') {
      return { result: { value: emulation.unreadable?.() ? undefined : size } };
    }

    if (method === 'Runtime.evaluate' && params.expression.includes('const post_id = editor?.getCurrentPostId()')) {
      return { result: { value: await emulation.newEditor?.() } };
    }

    if (method === 'Runtime.evaluate') {
      request = JSON.parse(params.expression.slice(params.expression.lastIndexOf('\n(') + 2, -1));
      requests.push(request);

      return { result: { objectId: 'job' } };
    }

    if (method === 'Runtime.getProperties') return { internalProperties: [
      { name: '[[PromiseState]]', value: { value: 'fulfilled' } },
    ] };

    if (method === 'Runtime.awaitPromise') return { result: { value: await respond(request) } };

    return {};
  } };
}

async function hostFixture(t, respond) {
  const requests = [];
  const shots = [];
  const emulation = [];
  const f = { requests, shots, emulation };
  // Replace f.capture to see the page as each screenshot finds it.
  f.capture = async ({ clip: { x, y, width, height } }) => {
    shots.push({ x, y, width, height });

    return jpeg(width, height);
  };

  f.browser = capability(respond, requests, emulation, (params) => f.capture(params));
  f.navigations = [];
  // Replace f.goto to fail or delay a navigation.
  f.tab = {
    capabilities: { get: async (name) => (name === 'cdp' ? f.browser : undefined) },
    goto: async (url) => {
      f.navigations.push(url);

      return f.goto?.(url);
    },
  };
  f.host = await createBlockwork(f.tab);

  return f;
}

async function mediaCopyFixture(t, change) {
  const bytes = Buffer.from('synthetic attachment bytes');
  const download = {};
  const downloads = [];
  const site = 'https://source.example.test';
  const records = [1, 2].map(id => ({
    id, source_url: `${site}/uploads/synthetic-${id}.png`, mime_type: 'image/png',
    title: { raw: `Synthetic ${id}` }, caption: { raw: '' }, description: { raw: '' }, alt_text: 'Synthetic alt',
    media_details: { sizes: { thumbnail: { source_url: `${site}/uploads/synthetic-${id}-small.png` } } },
  }));
  const source = await hostFixture(t, request => {
    if (request.operation === 'resource_status') return { ok: true, busy: false };

    if (request.operation === 'download_media') {
      downloads.push(request);

      return download.result ?? { ok: true, upload: { name: `synthetic-${request.id}.png`, mime_type: 'image/png', base64: bytes.toString('base64') } };
    }

    return { ok: true, records: records.filter(record => request.ids.includes(record.id)) };
  });
  const native = { ok: true, busy: false, attempted: false };
  const receipts = [];
  const copies = new Map();
  const respond = async request => {
    if (request.operation === 'resource_status') return { ...native };

    if (request.operation === 'inspect_media') return { ok: true, records: [...copies.values()].filter(record => request.slugs.includes(record.slug)) };

    if (request.operation === 'prepare_media') {
      const receipt = { key: `receipt-${receipts.length}`, kind: 'media', action: 'create', desired: request.fields, target: request.target };
      receipts.push(receipt);
      Object.assign(native, { receipt, attempted: false, verified: false, resource_id: undefined });
      const prepared = { ok: true, persistence: 'not_attempted', receipt };

      return change ? change(request, prepared) : prepared;
    }

    const id = request.receipt.desired.title === 'Synthetic 1' ? 31 : 32;
    const record = { id, slug: request.receipt.desired.slug, source_url: `${target.site_url}/uploads/copied-${id}.png`, media_details: { sizes: {} } };

    if (request.operation === 'save_resource') {
      Object.assign(native, { attempted: true, resource_id: id });
      copies.set(id, record);
    }

    const result = { ok: true, persistence: 'verified', resource_id: id, record, receipt: request.receipt };
    const returned = change ? await change(request, result) : result;
    // Like the page, record whether its latest write verified.
    native.verified = returned?.persistence === 'verified';

    return returned;
  };

  const destination = await hostFixture(t, respond);
  const request = { source: source.host, source_target: { site_url: site, user_id: 1 }, target: { site_url: target.site_url, user_id: 5 }, ids: [1, 2], copy_id: 'synthetic-copy' };

  return { source, destination, request, receipts, bytes, records, downloads, download, copies, native };
}

test('copy_media keeps ordinary receipts, metadata and size mappings and resumes by exact slug', async t => {
  const f = await mediaCopyFixture(t);
  const copied = await f.destination.host.copy_media(f.request);
  assert.equal(copied.ok, true, JSON.stringify(copied));
  assert.equal(copied.complete, true);
  assert.equal(copied.persistence, 'verified');
  assert.deepEqual(copied.media_map.ids, { '1': 31, '2': 32 });
  assert.equal(copied.media_map.urls[f.records[0].media_details.sizes.thumbnail.source_url], `${target.site_url}/uploads/copied-31.png`);
  const prepares = f.destination.requests.filter(request => request.operation === 'prepare_media');
  assert.equal(prepares.length, 2);
  assert.equal(prepares[0].upload.base64, f.bytes.toString('base64'));
  assert.deepEqual(f.downloads.map(({ operation, target, id, timeout_ms }) => ({ operation, target, id, timeout_ms })), [1, 2].map(id => ({
    operation: 'download_media', target: f.request.source_target, id, timeout_ms: 12000,
  })));
  assert.equal(JSON.stringify(copied).includes(f.bytes.toString('base64')), false);
  assert.equal(prepares[0].fields.alt, 'Synthetic alt');
  assert.equal(prepares[0].fields.parent_id, 0);
  assert.match(prepares[0].fields.slug, /^bw-[a-f0-9]{16}-1$/);
  const sameCaller = await f.destination.host.copy_media(f.request);
  assert.equal(sameCaller.complete, true);
  assert.equal(f.destination.requests.filter(request => request.operation === 'verify_resource').length, 0);

  // A new caller can still find completed copies in WordPress.
  const rebound = await createBlockwork(f.destination.tab);
  const again = await rebound.copy_media(f.request);
  assert.equal(again.complete, true, JSON.stringify(again));
  assert.deepEqual(again.media_map, copied.media_map);
  assert.equal(f.destination.requests.filter(request => request.operation === 'save_resource').length, 2);
  assert.equal(f.downloads.length, 2);
});

test('copy_media verifies deferred or lost save responses without another upload', async t => {
  for (const mode of ['deferred', 'lost']) {
    let saves = 0;
    const f = await mediaCopyFixture(t, (request, result) => {
      if (request.operation !== 'save_resource') return result;
      saves++;

      if (mode === 'lost') throw new Error('browser is not available token=private');

      return { ok: false, error: 'verification_deferred', persistence: 'uncertain', resource_id: result.resource_id, receipt: request.receipt };
    });
    f.request.ids = [1];
    const interrupted = await f.destination.host.copy_media(f.request);
    assert.equal(interrupted.error, 'media_copy_needs_verification');
    assert.deepEqual(interrupted.media_map.ids, {});
    const rebound = await createBlockwork(f.destination.tab);
    assert.equal((await rebound.copy_media(f.request)).complete, true);
    assert.equal(saves, 1);
    assert.equal(f.downloads.length, 1);
    assert.equal(f.destination.requests.filter(request => request.operation === 'verify_resource').length, 1);
  }
});

test('an absent slug after request abortion permits only receipt verification, even in a fresh page', async t => {
  const f = await mediaCopyFixture(t, (request, result) => {
    if (request.operation === 'save_resource') {
      f.copies.clear();
      throw new Error('target closed');
    }

    if (request.operation === 'verify_resource') return { ok: false, persistence: 'uncertain', outcome: 'not_found', hint: 'Never replay' };

    return result;
  });
  f.request.ids = [1];
  await f.destination.host.copy_media(f.request);
  // A recreated caller adopts the page's receipt and keeps it after the page session ends.
  const rebound = await createBlockwork(f.destination.tab);
  assert.equal((await rebound.copy_media(f.request)).error, 'media_copy_needs_verification');
  delete f.native.receipt;
  delete f.native.resource_id;
  f.native.attempted = false;

  for (const caller of [f.destination.host, rebound]) {
    const waiting = await caller.copy_media(f.request);
    assert.equal(waiting.error, 'media_copy_needs_verification');
    assert.equal(waiting.persistence, 'uncertain');
    assert.equal(waiting.items[0].result.outcome, 'not_found');
  }

  assert.equal(f.destination.requests.filter(request => request.operation === 'save_resource').length, 1);
  assert.equal(f.downloads.length, 1);
});

test('copy_media starts two 25-second uploads within one batch', async t => {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const f = await mediaCopyFixture(t, (request, result) => {
    if (request.operation === 'save_resource') elapsed += 25000;

    return result;
  });
  const copied = await f.destination.host.copy_media(f.request);
  assert.equal(copied.complete, true, JSON.stringify(copied));
  assert.equal(f.destination.requests.filter(request => request.operation === 'save_resource').length, 2);
  assert.ok(copied.elapsed_ms >= 50000 && copied.elapsed_ms < 55000);
});

test('copy_media resumes a preparation after a deadline pause without fetching again', async t => {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const f = await mediaCopyFixture(t, (request, result) => {
    if (request.operation === 'prepare_media') elapsed += 51000;

    return result;
  });
  f.request.ids = [1];
  const first = await f.destination.host.copy_media(f.request);
  assert.equal(first.ok, true);
  assert.equal(first.complete, false);
  assert.equal(first.items[0].state, 'prepared');
  const second = await f.destination.host.copy_media(f.request);
  assert.equal(second.complete, true, JSON.stringify(second));
  assert.equal(f.downloads.length, 1);
  assert.equal(f.receipts.length, 1);
});

test('copy_media retains an earlier uncertain upload when verification cannot start', async t => {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  let expireVerification = false;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    const serialized = stringify(value, ...args);

    if (expireVerification && value?.operation === 'verify_resource') elapsed += 55000;

    return serialized;
  });
  const f = await mediaCopyFixture(t, (request, result) => {
    if (request.operation === 'save_resource') {
      f.copies.clear();
      throw new Error('target closed');
    }

    return result;
  });
  f.request.ids = [1];
  assert.equal((await f.destination.host.copy_media(f.request)).persistence, 'uncertain');
  expireVerification = true;
  const paused = await f.destination.host.copy_media(f.request);
  assert.equal(paused.error, 'media_copy_needs_verification');
  assert.equal(paused.items[0].state, 'attempted');
  assert.equal(paused.items[0].result.error, 'browser_deadline_exhausted');
  assert.equal(paused.items[0].result.operation_started, false);
  assert.equal(paused.items[0].result.persistence, 'not_attempted');
  assert.equal(paused.persistence, 'uncertain');
  assert.equal(f.destination.requests.filter(request => request.operation === 'verify_resource').length, 0);
  assert.equal(f.destination.requests.filter(request => request.operation === 'save_resource').length, 1);
  assert.equal(f.downloads.length, 1);
});

test('copy_media resumes an upload that exhausted its deadline before submission', async t => {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  let expireSave = true;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    const serialized = stringify(value, ...args);

    if (expireSave && value?.operation === 'save_resource') {
      elapsed += 55000;
      expireSave = false;
    }

    return serialized;
  });
  const f = await mediaCopyFixture(t);
  f.request.ids = [1];
  const paused = await f.destination.host.copy_media(f.request);
  assert.equal(paused.items[0].result.error, 'browser_deadline_exhausted');
  assert.equal(paused.items[0].state, 'prepared');
  assert.equal(paused.persistence, 'not_attempted');
  assert.equal(f.destination.requests.filter(request => request.operation === 'save_resource').length, 0);
  const resumed = await f.destination.host.copy_media(f.request);
  assert.equal(resumed.complete, true, JSON.stringify(resumed));
  assert.equal(resumed.persistence, 'verified');
  assert.equal(f.destination.requests.filter(request => request.operation === 'save_resource').length, 1);
  assert.equal(f.downloads.length, 1);
  assert.equal(f.receipts.length, 1);
});

test('copy_media waits for busy callers and busy page jobs without lookup or upload', async t => {
  const f = await mediaCopyFixture(t);
  f.native.busy = true;
  const waiting = await f.destination.host.copy_media(f.request);
  assert.equal(waiting.ok, true);
  assert.equal(waiting.complete, false);
  assert.equal(waiting.next, 'wait_for_media_copy');
  assert.deepEqual(f.destination.requests.map(request => request.operation), ['resource_status']);
  assert.equal(f.source.requests.length, 0);
  f.native.busy = false;
  const first = f.destination.host.copy_media(f.request);
  const overlap = await f.destination.host.copy_media(f.request);
  assert.equal(overlap.ok, true);
  assert.equal(overlap.next, 'wait_for_media_copy');
  assert.equal((await first).complete, true);
  assert.equal(f.destination.requests.filter(request => request.operation === 'resource_status').length, 2);
});

test('copy_media waits for a pending source download without reporting an uncertain upload', async t => {
  const f = await mediaCopyFixture(t);
  f.download.result = { ok: false, error: 'browser_operation_pending', persistence: 'uncertain' };
  const waiting = await f.destination.host.copy_media(f.request);
  assert.deepEqual([waiting.ok, waiting.complete, waiting.next, waiting.persistence], [true, false, 'wait_for_media_copy', 'not_attempted'], JSON.stringify(waiting));
  assert.equal(f.destination.requests.filter(request => request.operation === 'prepare_media').length, 0);
});

test('a WordPress-suffixed slug preserves the different outcome and never triggers another upload', async t => {
  const f = await mediaCopyFixture(t, (request, result) => {
    if (!['save_resource', 'verify_resource'].includes(request.operation)) return result;
    result.record.slug += '-2';
    f.copies.set(result.resource_id, result.record);

    return { ...result, ok: false, persistence: 'different', error: 'verification_mismatch', diagnostics: { fields: ['slug'], slug_made_unique: true } };
  });
  f.request.ids = [1];
  const first = await f.destination.host.copy_media(f.request);
  assert.equal(first.persistence, 'different');
  assert.equal(first.items[0].result.diagnostics.slug_made_unique, true);
  const again = await f.destination.host.copy_media(f.request);
  assert.equal(again.persistence, 'different');
  assert.equal(f.destination.requests.filter(request => request.operation === 'save_resource').length, 1);
});

test('copy_media validates before caller access and preserves a source download failure hint without preparing', async t => {
  const f = await mediaCopyFixture(t);

  for (const [field, value] of [['ids', [1, 1]], ['copy_id', '../../x'], ['deadline_ms', 60000], ['source', {}], ['target', { site_url: target.site_url }], ['parent_id', -1]]) {
    const failed = await f.destination.host.copy_media({ ...f.request, [field]: value });
    assert.equal(failed.error, 'invalid_media_copy');
    assert.equal(failed.issues[0].path, field);
  }

  assert.equal(f.source.requests.length + f.destination.requests.length, 0);
  f.request.ids = [1];

  f.download.result = { ok: false, error: 'media_download_unavailable', persistence: 'not_attempted', hint: 'Open the attachment URL in the source tab, then resume the same copy_id. This item was not uploaded.' };
  const failed = await f.destination.host.copy_media(f.request);
  assert.equal(failed.diagnostics.stage, 'fetch');
  assert.equal(failed.persistence, 'not_attempted');
  assert.equal(failed.items[0].result.error, 'media_download_unavailable');
  assert.equal(failed.hint, f.download.result.hint);

  assert.equal(f.destination.requests.some(request => request.operation === 'prepare_media'), false);

  const partial = await mediaCopyFixture(t);
  Object.defineProperty(partial.download, 'result', { get() {
    return partial.downloads.length === 2 ? f.download.result : undefined;
  } });
  const stopped = await partial.destination.host.copy_media(partial.request);
  assert.equal(stopped.persistence, 'partial');
  assert.deepEqual(stopped.media_map.ids, { '1': 31 });
  assert.equal(stopped.items[1].result.error, 'media_download_unavailable');
});

test('copy_media omits downloaded bytes when its deadline expires before preparation', async t => {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const f = await mediaCopyFixture(t);
  Object.defineProperty(f.download, 'result', { get() {
    elapsed += 51000;

    return { ok: true, upload: { name: 'synthetic.png', mime_type: 'image/png', base64: f.bytes.toString('base64') } };
  } });
  const paused = await f.destination.host.copy_media(f.request);
  assert.equal(paused.ok, true);
  assert.equal(paused.complete, false);
  assert.equal(paused.items[0].state, 'pending');
  assert.equal(JSON.stringify(paused).includes(f.bytes.toString('base64')), false);
  assert.equal(f.destination.requests.some(request => request.operation === 'prepare_media'), false);
});

test('connect binds the authenticated target for read, edit, measure and revert', async (t) => {
  const detail = { ok: true, changed: [{ client_id: 'a', preview: 'After' }] };
  const f = await hostFixture(t, async request => request.operation === 'connect' ? { ok: true, target } : detail);
  assert.equal((await f.host.edit({ edits: [] })).error, 'connect_required');
  assert.equal(f.requests.length, 0);
  await f.host.connect(connection);
  assert.deepEqual(f.requests[0], { ...connection, operation: 'connect' });
  assert.deepEqual(f.host.target, target);

  for (const [method, input] of [['read', { blocks: 'all' }], ['edit', { edits: [] }], ['measure', { blocks: ['a'] }], ['revert', undefined]]) {
    assert.deepEqual(await f.host[method](input), detail);
    const request = f.requests.at(-1);
    assert.equal(request.operation, method);
    assert.deepEqual(request.target, target);
    assert.ok(request.request_id);
  }

  assert.equal(new Set(f.requests.slice(1).map(request => request.request_id)).size, 4);

  const links = { operation: 'map_links', markup: '<!-- wp:paragraph --><p>Section</p><!-- /wp:paragraph -->', source_site_url: 'https://source.test' };
  await f.host.call(links);
  assert.deepEqual(f.requests.at(-1).target, target);
  assert.equal(f.requests.at(-1).operation, 'map_links');
  const explicit = { ...target, post_id: 11 };
  await f.host.call({ ...links, target: explicit });
  assert.deepEqual(f.requests.at(-1).target, explicit);
});

test('wait_for_save polls status until the user has saved', async (t) => {
  let checks = 0;
  const f = await hostFixture(t, async request => {
    if (request.operation === 'connect') return { ok: true, target };

    return { ok: true, busy: false, dirty: ++checks < 2 };
  });
  await f.host.connect(connection);
  assert.equal((await f.host.wait_for_save()).dirty, false);
  assert.equal(checks, 2);
});

test('wait_for_save says to keep waiting, then to ask the user after six calls', async (t) => {
  const f = await hostFixture(t, async request => request.operation === 'connect' ? { ok: true, target } : { ok: true, busy: false, dirty: true });
  await f.host.connect(connection);
  let now = Date.now();
  t.mock.method(Date, 'now', () => (now += 500));
  t.mock.method(globalThis, 'setTimeout', (resolve) => setImmediate(resolve));
  const nexts = [];

  for (let call = 0; call < 6; call++) {
    nexts.push((await f.host.wait_for_save()).next);
  }

  assert.deepEqual(nexts, [...Array(5).fill('wait_for_save'), 'ask_user']);
});

test('wait_for_sign_in waits through the login page and returns the signed-in user', async (t) => {
  let checks = 0;
  const site = { site_url: target.site_url };
  const f = await hostFixture(t, async () => (++checks < 3
    ? { ok: false, error: 'reauthorization_required', hint: 'Sign in', next: 'inspect_resource' }
    : { ok: true, target: { ...site, user_id: 5 }, user: { id: 5, name: 'Fixture' }, types: [] }));
  t.mock.method(globalThis, 'setTimeout', (resolve) => setImmediate(resolve));
  const result = await f.host.wait_for_sign_in(site);
  assert.deepEqual(result, { ok: true, operation: 'wait_for_sign_in', target: { ...site, user_id: 5 }, user: { id: 5, name: 'Fixture' } });
  assert.equal(checks, 3);
  assert.deepEqual(f.requests.map(({ operation, target }) => [operation, target]), Array(3).fill(['discover', site]));
});

test('wait_for_sign_in says to keep waiting, then to ask the user, and returns other failures at once', async (t) => {
  const f = await hostFixture(t, async () => ({ ok: false, error: 'target_mismatch', hint: 'Mismatch', next: 'inspect_resource' }));
  let now = Date.now();
  t.mock.method(Date, 'now', () => (now += 500));
  t.mock.method(globalThis, 'setTimeout', (resolve) => setImmediate(resolve));
  const nexts = [];

  for (let call = 0; call < 6; call++) {
    nexts.push((await f.host.wait_for_sign_in({ site_url: target.site_url })).next);
  }

  assert.deepEqual(nexts, [...Array(5).fill('wait_for_sign_in'), 'ask_user']);

  for (const refused of [
    { ok: false, error: 'invalid_resource_request', hint: 'Fix site_url', next: 'correct_request' },
    { ok: false, error: 'browser_command_failed', hint: 'Rebind', next: 'rebind_browser' },
  ]) {
    const other = await hostFixture(t, async () => refused);
    assert.deepEqual(await other.host.wait_for_sign_in({ site_url: target.site_url }), refused);
    assert.equal(other.requests.length, 1);
  }
});

test('release ends nothing on a caller that never connected, and still refuses after a failed connect', async (t) => {
  const f = await hostFixture(t, async () => ({ ok: false, error: 'user_mismatch', hint: 'User', next: 'correct_request' }));
  assert.deepEqual(await f.host.release(), { ok: true, operation: 'release', cleanup: 'not_connected', persistence: 'not_attempted', unsaved_changes: false });
  assert.equal(f.requests.length, 0);
  await f.host.connect(connection);
  assert.equal((await f.host.release()).error, 'connect_required');
});

test('create discovers a type and waits for its exact new identity before background connect', async (t) => {
  const site = { site_url: target.site_url, user_id: target.user_id };
  const newUrl = `${site.site_url}/wp-admin/post-new.php?post_type=page`;
  const f = await hostFixture(t, async request => request.operation === 'discover'
    ? { ok: true, new_editor_url: newUrl }
    : { ok: true, target, workflow: 'background', blocks: [] });
  const observations = [null, { post_id: 0, post_type: 'page' }, { post_id: 7, post_type: 'post' }, { post_id: 7, post_type: 'page' }];
  f.emulation.newEditor = () => observations.shift();
  const commands = [];
  const send = f.browser.send;
  f.browser.send = async (method, params, options) => {
    commands.push({ method, params, options });

    return send(method, params, options);
  };

  const result = await f.host.create({ target: site, post_type: 'page' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.document, { site_url: site.site_url, post_id: 7, post_type: 'page' });
  assert.deepEqual(result.target, target);
  assert.deepEqual(f.host.target, target);
  assert.deepEqual(f.requests, [
    { operation: 'discover', target: site, post_type: 'page', limit: 1 },
    { operation: 'connect', target: result.document, workflow: 'background' },
  ]);
  assert.deepEqual(f.navigations, [newUrl]);
  assert.equal(commands.filter(command => command.params?.expression?.includes('const post_id')).length, 4);
  assert.equal((await f.host.create({ target: site, post_type: 'page' })).error, 'create_requires_owned_tab');
  assert.deepEqual(f.navigations, [newUrl]);
});

test('create refuses malformed requests and failed discovery before navigation', async (t) => {
  const site = { site_url: target.site_url, user_id: 5 };

  for (const input of [undefined, { target: site }, { target: { ...site, post_id: 7 }, post_type: 'page' }, { target: site, post_type: 'page', workflow: 'background' }]) {
    const f = await hostFixture(t, async () => assert.fail('Invalid create must not run the engine'));
    const refused = await f.host.create(input);
    assert.equal(refused.error, 'invalid_create');
    assert.equal(refused.next, 'correct_request');
    assert.ok(refused.issues[0].expected);
    assert.ok(refused.hint.length > 20);
    assert.equal(f.requests.length, 0);
  }

  for (const discovery of [{ ok: false, error: 'user_mismatch', hint: 'Confirm the signed-in user', next: 'correct_request' }, { ok: false, error: 'unsupported_post_type', hint: 'Choose a discover.types name', next: 'discover' }]) {
    const f = await hostFixture(t, async () => discovery);
    const refused = await f.host.create({ target: site, post_type: 'page' });
    assert.equal(refused.error, discovery.error);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.navigations, []);
  }
});

test('create reports uncertain navigation and a refused connection without replay', async (t) => {
  const site = { site_url: target.site_url, user_id: 5 };

  for (const stage of ['navigation', 'identity', 'connect', 'login']) {
    const f = await hostFixture(t, async request => request.operation === 'discover'
      ? { ok: true, new_editor_url: `${site.site_url}/wp-admin/post-new.php?post_type=page` }
      : { ok: false, error: 'post_locked', hint: 'Wait for the native editor lock', next: 'correct_request' });
    f.emulation.newEditor = () => stage === 'login' ? { reauthorization_required: true } : { post_id: 7, post_type: 'page' };
    const send = f.browser.send;
    f.goto = async () => {
      if (stage === 'navigation') throw new Error('private transport secret');
    };

    f.browser.send = async (method, params) => {
      if (stage === 'identity' && params?.expression?.includes('const post_id')) throw new Error('private transport secret');

      return send(method, params);
    };

    const refused = await f.host.create({ target: site, post_type: 'page' });
    assert.equal(refused.error, stage === 'connect' ? 'post_locked' : stage === 'login' ? 'reauthorization_required' : 'create_browser_failed');
    assert.equal(JSON.stringify({ ...refused, debug: undefined }).includes('private transport'), false);
    assert.ok(refused.hint.length > 20);
    assert.ok(refused.next);
    assert.equal(f.host.target, undefined);

    if (stage === 'connect') assert.deepEqual(refused.document, { site_url: site.site_url, post_id: 7, post_type: 'page' });
    assert.equal(f.requests.filter(request => request.operation === 'connect').length, stage === 'connect' ? 1 : 0);
    const repeated = await f.host.create({ target: site, post_type: 'page' });
    assert.equal(repeated.error, 'create_already_attempted');
    assert.equal(repeated.operation_started, false);
    assert.equal(repeated.next, 'inspect_created_document');
    assert.match(repeated.hint, /Inspect.*tab.*document.*connect/);
    assert.equal(f.navigations.length, 1);
    // Recovering the first document must still reach the engine.
    assert.equal((await f.host.connect({ ...connection, workflow: 'background' })).error, 'post_locked');
    assert.equal(f.requests.at(-1).operation, 'connect');
  }
});

test('create bounds startup without connecting to a wrong post type', async (t) => {
  const f = await hostFixture(t, async () => ({ ok: true, new_editor_url: `${target.site_url}/wp-admin/post-new.php?post_type=page` }));
  f.emulation.newEditor = () => ({ post_id: 7, post_type: 'post' });
  const result = await f.host.create({ target: { site_url: target.site_url, user_id: 5 }, post_type: 'page' });
  assert.equal(result.error, 'create_editor_timeout');
  assert.deepEqual(result.diagnostics, { stage: 'new_editor', waited_ms: 10000 });
  assert.equal(result.operation_started, true);
  assert.match(result.hint, /Do not repeat create/);
  assert.deepEqual(f.requests.map(request => request.operation), ['discover']);
  const repeated = await f.host.create({ target: { site_url: target.site_url, user_id: 5 }, post_type: 'page' });
  assert.equal(repeated.error, 'create_already_attempted');
  assert.equal(repeated.operation_started, false);
  assert.match(repeated.hint, /Inspect.*tab.*document.*connect/);
  assert.equal(f.navigations.length, 1);
});

test('save keeps the preparation receipt before the second page call', async (t) => {
  const receipt = { token: 'prepared', target };
  let f;
  f = await hostFixture(t, async request => {
    if (request.operation === 'connect') return { ok: true, target };

    if (request.operation === 'prepare_save') return { ok: true, receipt };
    assert.equal(request.operation, 'save');
    assert.deepEqual(request.receipt, receipt);
    assert.equal(request.save_all_pending, true);
    assert.deepEqual(f.host.receipt, receipt);

    return { ok: true, persistence: 'verified', receipt };
  });
  await f.host.connect(connection);
  assert.equal((await f.host.save({ save_all_pending: true })).persistence, 'verified');
  assert.deepEqual(f.requests.map(request => request.operation), ['connect', 'prepare_save', 'save']);
});

test('save shares one 45-second budget and retains recovery when the write is pending', async t => {
  const receipt = { token: 'prepared', target };
  let now = Date.now();
  const f = await hostFixture(t, async request => {
    if (request.operation === 'connect') return { ok: true, target };

    now += 40000;

    return { ok: true, receipt };
  });
  await f.host.connect(connection);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', resolve => setImmediate(resolve));
  const started = now;
  const send = f.browser.send;
  const timeouts = [];
  f.browser.send = async (method, params, options) => {
    if (f.requests.at(-1)?.operation === 'save' && method === 'Runtime.getProperties') {
      timeouts.push(options.timeoutMs);
      now += 1000;

      return { internalProperties: [{ name: '[[PromiseState]]', value: { value: 'pending' } }] };
    }

    return send(method, params, options);
  };

  const result = await f.host.save();
  assert.equal(now - started, 45000);
  assert.deepEqual(timeouts, [5000, 4000, 3000, 2000, 1000]);
  assert.equal(result.error, 'browser_operation_pending');
  assert.equal(result.persistence, 'uncertain');
  assert.equal(result.next, 'check_status_do_not_replay');
  assert.match(result.hint, /receipt/);
  assert.match(result.hint, /Never replay an uncertain mutation/);
  assert.deepEqual(f.host.receipt, receipt);
  assert.deepEqual(f.requests.map(request => request.operation), ['connect', 'prepare_save', 'save']);
  assert.equal((await f.host.save()).error, 'status_required');
  assert.equal(f.requests.length, 3);
});

test('save never submits the write if preparation consumes the shared deadline', async t => {
  const receipt = { token: 'prepared', target };
  let now = Date.now();
  const f = await hostFixture(t, async request => {
    if (request.operation === 'connect') return { ok: true, target };

    if (request.operation === 'prepare_save') now += 45000;

    return { ok: true, receipt };
  });
  await f.host.connect(connection);
  t.mock.method(Date, 'now', () => now);
  const result = await f.host.save();
  assert.equal(result.error, 'browser_deadline_exhausted');
  assert.equal(result.operation, 'save');
  assert.equal(result.operation_started, false);
  assert.equal(result.persistence, 'not_attempted');
  assert.match(result.hint, /No browser operation started/);
  assert.deepEqual(f.host.receipt, receipt);
  assert.deepEqual(f.requests.map(request => request.operation), ['connect', 'prepare_save']);
});

test('save stops after unchanged or failed preparation', async (t) => {
  for (const prepared of [{ ok: true, persistence: 'unchanged' }, { ok: false, error: 'saved_record_changed', hint: 'Read current state' }]) {
    const f = await hostFixture(t, async request => request.operation === 'connect' ? { ok: true, target } : prepared);
    await f.host.connect(connection);
    assert.deepEqual(await f.host.save(), prepared);
    assert.deepEqual(f.requests.map(request => request.operation), ['connect', 'prepare_save']);
  }
});

test('the receipt getter holds the latest receipt a page call returned', async (t) => {
  const receipts = [{ token: 'first' }, { token: 'second' }];
  const f = await hostFixture(t, async request => ({ ok: true, receipt: receipts[request.index] }));
  assert.equal(f.host.receipt, undefined);

  for (const index of [0, 1, 0]) {
    await f.host.call({ operation: 'prepare_media', index });
    assert.deepEqual(f.host.receipt, receipts[index]);
  }

  await f.host.call({ operation: 'resource_status' });
  assert.deepEqual(f.host.receipt, receipts[0]);
});

test('mutation host failures require a successful idle status before another mutation', async (t) => {
  const f = await hostFixture(t, async request => request.operation === 'connect' ? { ok: true, target } : { ok: true });
  await f.host.connect(connection);
  const send = f.browser.send;
  f.browser.send = async (method, params) => {
    if (method === 'Runtime.getProperties') throw new Error('private transport details');

    return send(method, params);
  };

  const failure = await f.host.edit({ edits: [] });
  assert.equal(failure.next, 'check_status_do_not_replay');
  const count = f.requests.length;

  for (const method of ['edit', 'save', 'revert', 'release']) {
    assert.equal((await f.host[method]()).error, 'status_required');
  }

  assert.equal(f.requests.length, count);
  assert.equal((await f.host.status()).ok, false);
  assert.equal((await f.host.revert()).error, 'status_required');
  let idle = false;
  f.browser.send = capability(async request => request.operation === 'status' ? { ok: true, busy: !idle, last_request: { outcome: 'applied' } } : { ok: true }, f.requests).send;
  assert.equal((await f.host.read()).ok, true);
  await f.host.status();
  assert.equal((await f.host.edit()).error, 'status_required');
  idle = true;
  await f.host.status();
  assert.equal((await f.host.edit()).ok, true);
});

test('failed save preparation waits for idle status, then prepares again without sending a save', async (t) => {
  const f = await hostFixture(t, async request => request.operation === 'connect' ? { ok: true, target } : { ok: true });
  await f.host.connect(connection);
  const send = f.browser.send;
  f.browser.send = async (method, params) => {
    if (method === 'Runtime.getProperties') throw new Error('Target closed');

    return send(method, params);
  };

  const failed = await f.host.save();
  assert.equal(failed.operation, 'prepare_save');
  assert.equal(failed.next, 'retry');
  const blocked = await f.host.save();
  assert.equal(blocked.error, 'status_required');
  assert.match(blocked.hint, /before retrying the preparation/);
  assert.doesNotMatch(blocked.hint, /never repeat/);
  assert.deepEqual(f.requests.map(request => request.operation), ['connect', 'prepare_save']);
  f.browser.send = capability(async request => request.operation === 'status' ? { ok: true, busy: false } : { ok: true }, f.requests).send;
  await f.host.status();
  assert.equal((await f.host.save()).ok, true);
  assert.deepEqual(f.requests.map(request => request.operation), ['connect', 'prepare_save', 'status', 'prepare_save']);
});

test('overlapping calls refuse and release clears the bound target only on success', async (t) => {
  let settle;
  let releaseOk = false;
  const f = await hostFixture(t, async request => {
    if (request.operation === 'connect') return { ok: true, target };

    if (request.operation === 'edit') return new Promise(resolve => { settle = () => resolve({ ok: false, error: 'block_changed', diagnostics: { conflicts: [] } }); });

    return { ok: releaseOk };
  });
  await f.host.connect(connection);
  const pending = f.host.edit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.host.read()).error, 'host_operation_in_progress');
  settle();
  assert.equal((await pending).error, 'block_changed');
  assert.equal((await f.host.release()).ok, false);
  assert.deepEqual(f.host.target, target);
  releaseOk = true;
  await f.host.release();
  assert.equal(f.host.target, undefined);
  assert.equal((await f.host.read()).error, 'connect_required');
});

test('a released background caller points to a fresh tab, while an attached one can connect again', async (t) => {
  const background = await hostFixture(t, async (request) =>
    request.operation === 'connect' ? { ok: true, target, workflow: 'background' } : { ok: true });
  await background.host.connect({ ...connection, workflow: 'background' });
  await background.host.release();
  const count = background.requests.length;

  for (const refused of [await background.host.read(), await background.host.connect({ ...connection, workflow: 'background' })]) {
    assert.deepEqual([refused.error, refused.operation_started], ['document_released', false]);
    assert.match(refused.hint, /create a new caller/);
  }

  assert.equal(background.requests.length, count);

  const attached = await hostFixture(t, async (request) =>
    request.operation === 'connect' ? { ok: true, target, workflow: 'attached' } : { ok: true });
  await attached.host.connect(connection);
  await attached.host.release();
  const again = await attached.host.read();
  assert.equal(again.error, 'connect_required');
  assert.match(again.hint, /released its session/);
  assert.equal((await attached.host.connect(connection)).ok, true);
  assert.equal((await attached.host.read()).ok, true);
});

test('view captures each slice of a block per width and always restores the editor view', async (t) => {
  const placed = { ok: true, rendered: true, clip: { x: 1, y: 2, width: 3, height: 4 }, from: 0, to: 500, block_height: 900, canvas_width: 1090, width_source: 'user_editor', clipped: false };
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'attached' };

    if (request.operation === 'restore_view') return { ok: true };

    if (request.width === 'mobile') return { ok: true, rendered: false, canvas_width: 479, width_source: 'preset' };

    return request.offset ? { ...placed, from: 500, to: 900, next_offset: null } : { ...placed, next_offset: 500 };
  });
  await f.host.connect(connection);
  const viewed = await f.host.view({ client_id: 'a', widths: ['desktop', 'mobile'] });
  assert.equal(viewed.ok, true, JSON.stringify(viewed));
  assert.deepEqual(viewed.shots.map(({ width, rendered, from, to, canvas_width }) => [width, rendered, from, to, canvas_width]), [
    ['desktop', true, 0, 500, 1090], ['desktop', true, 500, 900, 1090], ['mobile', false, undefined, undefined, 479]]);
  assert.deepEqual(viewed.shots[1].image_size, { width: 3, height: 4 });
  assert.equal(viewed.shots[0].width_source, 'user_editor');
  assert.deepEqual(viewed.incomplete, []);
  assert.deepEqual(f.requests.slice(1).map(({ operation, width, offset }) => [operation, width, offset]), [
    ['view', 'desktop', 0], ['view', 'desktop', 500], ['view', 'mobile', 0], ['restore_view', undefined, undefined]]);
  assert.equal(f.shots.length, 2);
  // A user's editor is never resized.
  assert.deepEqual(f.emulation, []);
});

test('view stops at four slices and says where to look for the rest', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'attached' };

    if (request.operation === 'restore_view') return { ok: true };

    return { ok: true, rendered: true, clip: { x: 0, y: 0, width: 1, height: 1 }, from: request.offset, to: request.offset + 500, block_height: 5000, canvas_width: 1090, next_offset: request.offset + 500 };
  });
  await f.host.connect(connection);
  const viewed = await f.host.view({ client_id: 'a', widths: ['mobile'] });
  assert.equal(viewed.ok, true, JSON.stringify(viewed));
  assert.equal(viewed.shots.length, 4);
  assert.deepEqual(viewed.incomplete, ['mobile']);
  assert.match(viewed.hint, /children.*capture_page/);
});

test('view validates its request and holds the caller until the editor is restored', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target };

    if (request.operation === 'restore_view' || request.operation === 'edit') return { ok: true };

    return { ok: true, rendered: true, clip: { x: 0, y: 0, width: 1, height: 1 }, from: 0, to: 10, block_height: 10, canvas_width: 100, next_offset: null };
  });
  await f.host.connect(connection);

  for (const request of [{ widths: ['desktop'] }, { client_id: 'a', widths: null }, { client_id: 'a', widths: [] }, { client_id: 'a', widths: ['watch'] },
    { client_id: 'a', widths: ['mobile', 'mobile'] }, { client_id: 'a', widths: [1440.5] }, { client_id: 'a', widths: [3000] }, { client_id: 'a', devices: ['mobile'] }]) {
    assert.equal((await f.host.view(request)).error, 'invalid_view', JSON.stringify(request));
  }

  assert.equal(f.requests.length, 1);
  const viewing = f.host.view({ client_id: 'a' });
  assert.equal((await f.host.edit({ edits: [] })).error, 'host_operation_in_progress');
  assert.equal((await viewing).ok, true);
  assert.equal(f.requests.at(-1).operation, 'restore_view');
  assert.equal((await f.host.edit({ edits: [] })).ok, true);
});

test('a background view resizes only its own tab to each width and clears the override afterward', async (t) => {
  let window = 0;
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'background' };

    if (request.operation === 'restore_view') return { ok: true };

    // The canvas is the window less 350px of editor chrome; mobile is a preset.
    window = f.emulation.findLast(([method]) => method === 'Emulation.setDeviceMetricsOverride')[1];
    const canvas = request.width === 'mobile' ? 479 : window - 350;
    const wanted = { desktop: 1440, mobile: 479 }[request.width] ?? request.width;

    if (canvas !== wanted) return { ok: true, width: request.width, canvas_width: canvas, width_source: 'exact', resize: { width: request.width, canvas_width: canvas, target_width: wanted, window_width: window + wanted - canvas } };

    return { ok: true, width: request.width, canvas_width: canvas, width_source: request.width === 'mobile' ? 'preset' : 'exact', rendered: true, clipped: false,
      clip: { x: 0, y: 0, width: 100, height: 50 }, from: 0, to: 50, block_height: 50, next_offset: null };
  });
  await f.host.connect(connection);
  const viewed = await f.host.view({ client_id: 'a', widths: ['desktop', 'mobile', 1920] });
  assert.equal(viewed.ok, true, JSON.stringify(viewed));
  assert.deepEqual(viewed.shots.map(({ width, canvas_width, width_source }) => [width, canvas_width, width_source]), [
    ['desktop', 1440, 'exact'], ['mobile', 479, 'preset'], [1920, 1920, 'exact']]);
  assert.deepEqual(f.emulation, [
    ['Emulation.setDeviceMetricsOverride', 1600, 1080], ['Emulation.setDeviceMetricsOverride', 1790, 1080],
    ['Emulation.setDeviceMetricsOverride', 2270, 1080], ['Emulation.clearDeviceMetricsOverride']]);
  assert.equal(f.requests.at(-1).operation, 'restore_view');
});

test('a width the canvas never reaches refuses after one correction and still clears the override', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'background' };

    if (request.operation === 'restore_view') return { ok: true };

    return { ok: true, resize: { width: 'desktop', canvas_width: 1200, target_width: 1440, window_width: 1840 } };
  });
  await f.host.connect(connection);
  const viewed = await f.host.view({ client_id: 'a' });
  assert.equal(viewed.error, 'width_unavailable', JSON.stringify(viewed));
  assert.equal(viewed.diagnostics.target_width, 1440);
  assert.match(viewed.hint, /front end/);
  assert.equal(f.requests.filter(({ operation }) => operation === 'view').length, 3);
  assert.equal(f.shots.length, 0);
  assert.deepEqual(f.emulation.at(-1), ['Emulation.clearDeviceMetricsOverride']);
  assert.equal(f.requests.at(-1).operation, 'restore_view');
});

test('a background measure at a width resizes its tab, while one at the current width does not', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'background' };

    if (request.width === undefined || f.emulation.length > 1) return { ok: true, canvas_width: 1440, blocks: [] };

    return { ok: true, resize: { width: 'desktop', canvas_width: 1250, target_width: 1440, window_width: 1790 } };
  });
  await f.host.connect(connection);
  assert.equal((await f.host.measure({ blocks: ['a'] })).ok, true);
  assert.deepEqual(f.emulation, []);
  const measured = await f.host.measure({ blocks: ['a'], width: 'desktop' });
  assert.equal(measured.canvas_width, 1440, JSON.stringify(measured));
  assert.deepEqual(f.emulation.map(([method, width]) => width ?? method), [1600, 1790, 'Emulation.clearDeviceMetricsOverride']);
  assert.deepEqual(f.requests.slice(1).map(({ operation, width }) => [operation, width]), [
    ['measure', undefined], ['measure', 'desktop'], ['measure', 'desktop'], ['restore_view', undefined]]);
});

test('an attached measure at a width restores the editor and never resizes the tab', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'attached' };

    return request.operation === 'restore_view' ? { ok: true } : { ok: true, canvas_width: 479, width_source: 'preset', blocks: [] };
  });
  await f.host.connect(connection);
  assert.equal((await f.host.measure({ blocks: ['a'], width: 'mobile' })).width_source, 'preset');
  assert.deepEqual(f.requests.slice(1).map(({ operation }) => operation), ['measure', 'restore_view']);
  assert.deepEqual(f.emulation, []);
});

test('a failed tab size reset keeps the shots and is retried before the next call', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'background' };

    if (request.operation === 'view') return { ok: true, width: 'mobile', canvas_width: 479, width_source: 'preset', rendered: true, clipped: false,
      clip: { x: 0, y: 0, width: 10, height: 10 }, from: 0, to: 10, block_height: 10, next_offset: null };

    return { ok: true };
  });
  await f.host.connect(connection);
  let clears = 0;
  f.emulation.refuse = (method) => method === 'Emulation.clearDeviceMetricsOverride' && ++clears === 1;
  const viewed = await f.host.view({ client_id: 'a', widths: ['mobile'] });
  assert.equal(viewed.ok, true, JSON.stringify(viewed));
  assert.equal(viewed.shots.length, 1);
  assert.equal(viewed.tab_resize.error, 'tab_resize_failed');
  assert.match(viewed.tab_resize.hint, /next call/);
  assert.equal(f.requests.at(-1).operation, 'restore_view');
  const read = await f.host.read();
  assert.deepEqual(f.emulation.at(-1), ['Emulation.clearDeviceMetricsOverride']);
  assert.equal(read.tab_resize, undefined);
  const count = f.emulation.length;
  await f.host.read();
  assert.equal(f.emulation.length, count);
});

test('malformed view and measure requests never resize the tab', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'background' };

    return { ok: false, error: 'invalid_measure' };
  });
  await f.host.connect(connection);
  assert.equal((await f.host.view({ client_id: 123 })).error, 'invalid_view');
  assert.equal((await f.host.view({ client_id: 'x'.repeat(201) })).error, 'invalid_view');

  for (const request of [{ width: 'desktop' }, { blocks: [], width: 'desktop' }, { blocks: ['a'], properties: ['Bad Property'], width: 'desktop' }, { blocks: ['a'], device: 'mobile', width: 'desktop' }]) {
    assert.equal((await f.host.measure(request)).error, 'invalid_measure', JSON.stringify(request));
  }

  const unserializable = await f.host.measure({ blocks: ['a'], width: 'mobile', device: 1n });
  assert.deepEqual([unserializable.error, unserializable.operation_started], ['invalid_measure', false]);
  assert.deepEqual(f.emulation, []);
  assert.equal(f.requests.length, 1);
});

test('a measure the page would accept after JSON drops an undefined key still restores the editor', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'attached' };

    return request.operation === 'restore_view' ? { ok: true } : { ok: true, canvas_width: 479, width_source: 'preset', blocks: [] };
  });
  await f.host.connect(connection);
  assert.equal((await f.host.measure({ blocks: ['a'], width: 'mobile', device: undefined })).ok, true);
  assert.deepEqual(f.requests.slice(1).map(({ operation }) => operation), ['measure', 'restore_view']);
});

test('a failed editor restore keeps a failed tab size reset beside it', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'background' };

    if (request.operation === 'restore_view') return { ok: false, error: 'native_device_preview_unavailable' };

    return { ok: true, width: 'mobile', canvas_width: 479, width_source: 'preset', rendered: false };
  });
  await f.host.connect(connection);
  let clears = 0;
  f.emulation.refuse = (method) => method === 'Emulation.clearDeviceMetricsOverride' && ++clears === 1;
  const viewed = await f.host.view({ client_id: 'a', widths: ['mobile'] });
  assert.deepEqual([viewed.error, viewed.tab_resize?.error], ['native_device_preview_unavailable', 'tab_resize_failed'], JSON.stringify(viewed));
});

// The start-of-frame segment of a JPEG with this pixel size.
function jpeg(width, height) {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0]);
  const data = new DataView(bytes.buffer);
  data.setUint16(7, height);
  data.setUint16(9, width);

  return bytes;
}

// The first bytes of a PNG with this pixel size.
const png = (width, height) => {
  const bytes = new Uint8Array(24);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, 0x89504e47);
  data.setUint32(16, width);
  data.setUint32(20, height);

  return bytes;
};

test('a screenshot cropped to another shape than its region is refused', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'attached' };

    if (request.operation === 'restore_view') return { ok: true };

    return { ok: true, rendered: true, clip: { x: 0, y: 0, width: 1920, height: 900 }, from: 0, to: 900, block_height: 900, canvas_width: 1920, next_offset: null };
  });
  await f.host.connect(connection);
  // Scaled down whole, the image keeps the region's shape.
  f.capture = async () => png(960, 450);
  assert.equal((await f.host.view({ client_id: 'a' })).ok, true);
  f.capture = async () => png(1600, 900);
  const cropped = await f.host.view({ client_id: 'a' });
  assert.equal(cropped.error, 'screenshot_cropped', JSON.stringify(cropped));
  assert.deepEqual(cropped.diagnostics, { clip: { width: 1920, height: 900 }, image: { width: 1600, height: 900 } });
  f.capture = async () => png(0, 0);
  assert.equal((await f.host.view({ client_id: 'a' })).error, 'screenshot_failed');
});

test('a refused screenshot returns the browser error as debug in a development build', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target };

    if (request.operation === 'restore_view') return { ok: true };

    return { ok: true, rendered: true, clip: { x: 0, y: 0, width: 1, height: 1 }, from: 0, to: 10, block_height: 10, canvas_width: 100, next_offset: null };
  });
  f.capture = async () => { throw new Error('Capture is unavailable for a hidden tab'); };

  await f.host.connect(connection);
  const viewed = await f.host.view({ client_id: 'a' });
  assert.equal(f.host.build.debug, true);
  assert.equal(viewed.error, 'screenshot_failed');
  assert.equal(viewed.debug.message, 'Capture is unavailable for a hidden tab');
  assert.equal(f.requests.at(-1).operation, 'restore_view');
});

test('capture_page resizes the tab to each front-end width without connect and clears the override', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  const captured = await f.host.capture_page({ widths: ['desktop', 'mobile', 1920] });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.deepEqual(captured.shots.map(({ width, viewport_width, image_size }) => [width, viewport_width, image_size.height]), [
    ['desktop', 1440, 1080], ['mobile', 390, 844], [1920, 1920, 1080]]);
  assert.deepEqual(f.emulation, [['Emulation.setDeviceMetricsOverride', 1440, 1080], ['Emulation.setDeviceMetricsOverride', 390, 844],
    ['Emulation.setDeviceMetricsOverride', 1920, 1080], ['Emulation.clearDeviceMetricsOverride']]);
  assert.equal(f.requests.length, 0);
});

test('capture_page navigates a front-end caller before capture and refuses unsafe navigation', async (t) => {
  const f = await hostFixture(t, async request => request.operation === 'connect' ? { ok: true, target } : { ok: true });
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  f.goto = async () => assert.deepEqual(f.emulation, []);
  assert.equal((await f.host.capture_page({ url: 'https://example.test/page', widths: ['mobile'] })).ok, true);
  assert.deepEqual(f.navigations, ['https://example.test/page']);
  f.emulation.length = 0;

  for (const url of ['/page', 'javascript:alert(1)', 'https://example.test/' + 'a'.repeat(2048), 1]) {
    const result = await f.host.capture_page({ url });
    assert.deepEqual([result.error, result.issues[0].path], ['invalid_capture', 'url']);
  }

  assert.equal(f.navigations.length, 1);
  assert.deepEqual(f.emulation, []);
  f.goto = async () => { throw new Error('navigation failed'); };

  const failed = await f.host.capture_page({ url: 'https://example.test/other' });
  assert.equal(failed.error, 'navigation_failed');
  assert.match(failed.hint, /Inspect your front-end tab/);
  assert.deepEqual(f.emulation, []);
  await f.host.connect(connection);
  const connected = await f.host.capture_page({ url: 'https://example.test/page' });
  assert.equal(connected.error, 'capture_requires_front_end_tab');
  assert.match(connected.hint, /create a caller/);
  assert.equal(f.navigations.length, 2);
  assert.deepEqual(f.emulation, []);
});

test('capture_page forces CSS states for shots and clears them after success or failure', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  f.emulation.stateCalls = [];
  const states = { selector: '.button', pseudo: ['hover', 'focus-visible'] };
  f.capture = async ({ clip }) => {
    assert.deepEqual(f.emulation.stateCalls.at(-1), ['CSS.forcePseudoState', { nodeId: 2, forcedPseudoClasses: states.pseudo }]);

    return png(clip.width, clip.height);
  };

  assert.equal((await f.host.capture_page({ states, widths: ['mobile'] })).ok, true);
  assert.deepEqual(f.emulation.stateCalls.at(-1), ['CSS.forcePseudoState', { nodeId: 2, forcedPseudoClasses: [] }]);
  f.emulation.stateCalls.length = 0;
  const missing = await f.host.capture_page({ states, selector: '.missing', widths: ['mobile'] });
  assert.equal(missing.error, 'selector_not_found');
  assert.deepEqual(f.emulation.stateCalls.at(-1), ['CSS.forcePseudoState', { nodeId: 2, forcedPseudoClasses: [] }]);
  f.emulation.stateFailure = (method, params) => method === 'CSS.forcePseudoState' && params.forcedPseudoClasses.length > 0;
  assert.equal((await f.host.capture_page({ states })).error, 'pseudo_state_failed');
  assert.deepEqual(f.emulation.stateCalls.at(-1), ['CSS.forcePseudoState', { nodeId: 2, forcedPseudoClasses: [] }]);
  f.emulation.stateFailure = (method, params) => method === 'CSS.forcePseudoState' && !params.forcedPseudoClasses.length;
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  const uncleared = await f.host.capture_page({ states, widths: ['mobile'] });
  assert.equal(uncleared.state_cleanup.error, 'pseudo_state_clear_failed');
  assert.match(uncleared.state_cleanup.hint, /Close your front-end tab/);
  assert.equal(uncleared.shots.length, 1);
});

test('capture_page validates and locates the forced state selector before resizing', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));

  for (const [states, path] of [[{}, 'states.selector'], [{ selector: '.a', pseudo: [] }, 'states.pseudo'], [{ selector: '.a', pseudo: ['hover', 'hover'] }, 'states.pseudo.1'], [{ selector: '.a', pseudo: ['visited'] }, 'states.pseudo.0'], [{ selector: '.a', pseudo: ['hover'], extra: 1 }, 'states.extra']]) {
    const result = await f.host.capture_page({ url: 'https://example.test/', states });
    assert.deepEqual([result.error, result.issues[0].path], ['invalid_capture', path]);
  }

  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.emulation, []);

  for (const [checked, error] of [[null, 'invalid_selector'], [false, 'selector_not_found']]) {
    f.emulation.selectorCheck = checked;
    const result = await f.host.capture_page({ states: { selector: '.missing', pseudo: ['hover'] } });
    assert.deepEqual([result.error, result.diagnostics.field], [error, 'states.selector']);
  }

  assert.equal(f.emulation.length, 0);
});

test('screenshots go through CDP as JPEG at CSS-pixel size under browser zoom on a high-density screen', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  // A 2x screen at 150% browser zoom. CDP clips in device-independent pixels,
  // and Chromium's image is the clip times its scale times the screen's 2x.
  Object.assign(f.emulation, { devicePixelRatio: 3, zoom: 1.5 });
  const requested = [];
  f.capture = async (params) => {
    requested.push(params);
    const { width, height, scale } = params.clip;

    return jpeg(Math.round(width * scale * 2), Math.round(height * scale * 2));
  };

  const captured = await f.host.capture_page({ widths: ['mobile'] });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.deepEqual(requested, [{ format: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 585, height: 1266, scale: 1 / 3 } }]);
  assert.deepEqual(captured.shots[0].image_size, { width: 390, height: 844 });
});

test('a screenshot refuses a pinch-zoomed tab before capturing and fails on unreadable responses', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  let captures = 0;
  f.capture = async ({ clip }) => {
    captures++;

    return jpeg(clip.width, clip.height);
  };

  // Chromium would reset the user's zoom after the capture.
  f.emulation.pinch = 1.5;
  const zoomed = await f.host.capture_page({ widths: ['mobile'] });
  assert.equal(zoomed.error, 'tab_zoomed', JSON.stringify(zoomed));
  assert.equal(captures, 0);
  f.emulation.pinch = 1;
  f.emulation.devicePixelRatio = Number.NaN;
  assert.equal((await f.host.capture_page({ widths: ['mobile'] })).error, 'screenshot_failed');
  assert.equal(captures, 0);
  f.emulation.devicePixelRatio = 1;

  for (const bytes of [new Uint8Array(0), new Uint8Array([1, 2, 3]), Buffer.from('not an image')]) {
    f.capture = async () => bytes;
    assert.equal((await f.host.capture_page({ widths: ['mobile'] })).error, 'screenshot_failed', String(bytes));
  }
});

test('capture_page refuses a bad request before resizing and still clears the override after a missing selector', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));

  for (const request of [{ widths: [] }, { widths: ['phone'] }, { widths: [390], selector: '' }, { widths: [390], selector: 5 }, { width: 390 }]) {
    assert.equal((await f.host.capture_page(request)).error, 'invalid_capture', JSON.stringify(request));
  }

  assert.deepEqual(f.emulation, []);
  const missing = await f.host.capture_page({ widths: ['mobile'], selector: '.missing' });
  assert.equal(missing.error, 'selector_not_found', JSON.stringify(missing));
  assert.match(missing.hint, /omit it/);
  assert.deepEqual(f.emulation.at(-1), ['Emulation.clearDeviceMetricsOverride']);
  assert.equal(f.shots.length, 0);
});

// A page where a lazy loader swaps in a slow image a frame after it scrolls
// into view, and that starts scrolled down from an earlier capture.
function lazyPage(emulation) {
  const image = { complete: true, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
  const page = {
    image, scrollX: 0, scrollY: 1200, innerHeight: 844, innerWidth: 390,
    setTimeout, Promise, Date, Math, JSON, TextEncoder,
    requestAnimationFrame: (callback) => setTimeout(callback, 5),
    scrollTo({ top }) { page.scrollY = top; },
    document: {
      querySelectorAll: () => [],
      images: [image],
      fonts: { ready: Promise.resolve() },
      documentElement: { scrollWidth: 390 },
      querySelector: (selector) => (selector === '.cover' ? { contains: () => false, getBoundingClientRect: () => ({ top: 0, left: 0, right: 390 }), scrollIntoView() {
        page.scrollY = 1500;
        page.requestAnimationFrame(() => { image.complete = false; setTimeout(() => { image.complete = true; }, 60); });
      } } : null),
    },
  };
  emulation.page = async (expression) => ({ result: { value: await runInNewContext(expression, page) } });

  return page;
}

test('capture_page waits for images a lazy loader starts after scrolling, and captures the top without a selector', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  const page = lazyPage(f.emulation);
  const complete = [];
  const clips = [];
  f.capture = async ({ clip }) => {
    complete.push(page.image.complete);
    clips.push(clip.y);

    return png(clip.width, clip.height);
  };

  const top = await f.host.capture_page({ widths: ['mobile'] });
  assert.equal(top.ok, true, JSON.stringify(top));
  assert.equal(top.shots[0].scroll_y, 0);
  const section = await f.host.capture_page({ widths: ['mobile'], selector: '.cover' });
  assert.equal(section.ok, true, JSON.stringify(section));
  assert.deepEqual(complete, [true, true]);
  // The host's clip is in document pixels, so a scrolled capture starts there.
  assert.deepEqual([clips, section.shots[0].scroll_y], [[0, 1500], 1500]);
});

// A section below the fold with a fixed admin bar and a sticky header.
function headerPage(emulation) {
  const page = lazyPage(emulation);
  const overlay = (position, top, height, extra = {}) => ({
    style: { position, visibility: 'visible', display: 'block', opacity: '1', ...extra },
    contains: () => false,
    getBoundingClientRect: () => ({ top, bottom: top + height, left: 0, right: 390, width: 390, height }),
  });
  const admin = overlay('fixed', 0, 32);
  const header = overlay('sticky', 32, 80);
  const target = {
    contains: () => false,
    scrollIntoView() { page.scrollY = page.targetTop; },
    getBoundingClientRect: () => ({ top: page.targetTop - page.scrollY, left: 20, right: 370 }),
  };
  page.targetTop = 1500;
  page.overlays = [header, admin];
  page.overlay = overlay;
  page.getComputedStyle = (element) => element.style;
  page.document.querySelectorAll = () => page.overlays;
  page.document.querySelector = () => target;

  return page;
}

test('capture_page clears stacked fixed and sticky bars and reports the actual selector offset', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  const page = headerPage(f.emulation);
  // A hidden overlay, a lower floating bar, and a bar beside the section
  // must not increase the connected covering band.
  page.overlays.push(page.overlay('fixed', 0, 500, { visibility: 'hidden' }));
  page.overlays.push(page.overlay('fixed', 0, 600, { opacity: '0' }));
  page.overlays.push(page.overlay('fixed', 200, 80));
  const beside = page.overlay('fixed', 0, 700);
  beside.getBoundingClientRect = () => ({ top: 0, bottom: 700, left: 380, right: 390, width: 10, height: 700 });
  page.overlays.push(beside);
  const clips = [];
  f.capture = async ({ clip }) => {
    clips.push(clip.y);

    return png(clip.width, clip.height);
  };

  const result = await f.host.capture_page({ widths: ['mobile'], selector: '.cover' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.shots[0].selector_offset, result.shots[0].scroll_y, clips], [112, 1388, [1388]]);
  const top = await f.host.capture_page({ widths: ['mobile'] });
  assert.deepEqual([top.shots[0].selector_offset, top.shots[0].scroll_y], [0, 0]);
});

test('capture_page ignores a negative z-index background and still clears stacked bars', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  const page = headerPage(f.emulation);
  const bars = page.overlays;
  page.overlays = [page.overlay('fixed', 0, 400, { zIndex: '-1' })];
  const background = await f.host.capture_page({ widths: ['mobile'], selector: '.cover' });
  assert.equal(background.ok, true, JSON.stringify(background));
  assert.deepEqual([background.shots[0].selector_offset, background.shots[0].scroll_y], [0, 1500]);
  page.overlays.push(...bars);
  const stacked = await f.host.capture_page({ widths: ['mobile'], selector: '.cover' });
  assert.equal(stacked.ok, true, JSON.stringify(stacked));
  assert.deepEqual([stacked.shots[0].selector_offset, stacked.shots[0].scroll_y], [112, 1388]);
});

test('capture_page ignores tall overlays, caps stacked bars, and reports only the scroll the page can apply', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  const page = headerPage(f.emulation);
  const bars = page.overlays;
  // A full-screen backdrop is no bar, so the section stays at the top.
  page.overlays = [page.overlay('fixed', 0, 2000)];
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  const tall = await f.host.capture_page({ widths: ['mobile'], selector: '.cover' });
  assert.equal(tall.ok, true, JSON.stringify(tall));
  assert.deepEqual([tall.shots[0].selector_offset, page.targetTop - page.scrollY], [0, 0]);
  page.overlays = [page.overlay('fixed', 0, 300), page.overlay('sticky', 300, 300)];
  const stacked = await f.host.capture_page({ widths: ['mobile'], selector: '.cover' });
  assert.deepEqual([stacked.shots[0].selector_offset, page.targetTop - page.scrollY], [422, 422]);
  page.overlays = bars;
  page.targetTop = 40;
  const clamped = await f.host.capture_page({ widths: ['mobile'], selector: '.cover' });
  assert.deepEqual([clamped.shots[0].selector_offset, clamped.shots[0].scroll_y], [40, 0]);
  page.overlays = [];
  const clear = await f.host.capture_page({ widths: ['mobile'], selector: '.cover' });
  assert.deepEqual([clear.shots[0].selector_offset, clear.shots[0].scroll_y], [0, 40]);
});

// A page mid-entrance: a 4-second band animation whose end starts a reveal,
// an endless spinner, and a scroll-driven effect. ended runs when the band
// finishes, as an animationend handler would, and onScroll on each scroll to
// the hero, as a scroll handler would.
function animatedPage(emulation, ended = () => {}) {
  const timeline = {};
  const animation = (endTime, animationTimeline = timeline) => ({
    playState: 'running', timeline: animationTimeline, effect: { getComputedTiming: () => ({ endTime }) },
    finish() { this.playState = 'finished'; },
  });
  const band = animation(4000);
  const reveal = animation(1000);
  const spinner = animation(Infinity);
  const scrolled = animation(100, {});
  const animations = [band, spinner, scrolled];
  const motion = { band, reveal, spinner, scrolled, scrolls: 0, hero: undefined, animation, animations, onScroll: undefined };
  const page = {
    scrollX: 0, scrollY: 0, innerWidth: 390, innerHeight: 844, setTimeout, TextEncoder,
    requestAnimationFrame: (callback) => setTimeout(callback, 1),
    scrollTo() {},
    getComputedStyle: () => ({ getPropertyValue: (property) => (property === 'min-height' ? '454px' : '') }),
    document: {
      querySelectorAll: () => [],
      images: [], fonts: { ready: Promise.resolve() }, documentElement: { scrollWidth: 405 }, timeline,
      getAnimations: () => animations,
      querySelector(selector) {
        if (selector === 'a[') throw new SyntaxError('bad selector');

        return selector === '.hero' ? motion.hero : null;
      },
    },
  };
  motion.hero = { contains: () => false, tagName: 'DIV', scrollIntoView() { motion.scrolls++; motion.onScroll?.(); }, getBoundingClientRect: () => ({ x: 50, y: 59.04, width: 1325, height: 454 }) };
  motion.page = page;
  band.finish = () => {
    band.playState = 'finished';
    animations.push(reveal);
    ended(motion, page);
  };

  // returnByValue hands back JSON, as CDP does.
  emulation.page = async (expression) => ({ result: { value: JSON.parse(JSON.stringify(await runInNewContext(expression, page))) } });

  return motion;
}

test('capture_page ends entrance animations before the shot and measures elements by selector', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  const motion = animatedPage(f.emulation);
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  const captured = await f.host.capture_page({ widths: ['mobile'], measure: { selectors: ['.hero', '.absent'], properties: ['min_height'] } });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  const [shot] = captured.shots;
  assert.deepEqual([shot.finished_animations, shot.scroll_width], [2, 405]);
  assert.deepEqual([motion.band, motion.reveal, motion.spinner, motion.scrolled].map(({ playState }) => playState),
    ['finished', 'finished', 'running', 'running']);
  assert.deepEqual(shot.elements, [
    { selector: '.hero', found: true, tag: 'div', rect: { x: 50, y: 59, width: 1325, height: 454 }, styles: { 'min-height': '454px' } },
    { selector: '.absent', found: false },
  ]);
  const plain = await f.host.capture_page({ widths: ['mobile'] });
  assert.deepEqual([plain.shots[0].finished_animations, plain.shots[0].elements], [0, undefined]);
});

// A page with one consent notice and what must stay: a fixed header that sells
// cookies, a fixed account menu, a fixed chat button, and a policy in the page flow.
function noticePage(emulation) {
  const fixture = (position, text, control) => {
    const style = {
      display: '',
      priority: '',
      getPropertyValue: () => style.display,
      getPropertyPriority: () => style.priority,
      setProperty(_, value, priority) { style.display = value; style.priority = priority; },
    };
    const attributes = new Map();
    const element = {
      position, style, innerText: text,
      querySelectorAll: () => (control ? [{ innerText: control, getAttribute: () => null }] : []),
      closest: () => (attributes.size ? element : null),
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: (name) => attributes.get(name),
      removeAttribute: (name) => attributes.delete(name),
      hidden: () => attributes.size > 0,
    };

    return element;
  };

  const notice = fixture('fixed', 'We value your privacy. We use cookies to run this site.', 'Reject non-essential');
  const others = [
    fixture('fixed', 'Cookies Cakes Contact', 'Shop now'),
    fixture('fixed', 'Cookie policy Account management', 'Account management'),
    fixture('fixed', 'Cookie policy Page tool', 'OK'),
    fixture('fixed', 'Chat with us', 'Open chat'),
    fixture('static', 'Our cookie policy', 'Accept these terms'),
  ];
  const all = [notice, ...others];
  const page = {
    scrollX: 0, scrollY: 0, innerWidth: 390, innerHeight: 844, setTimeout, TextEncoder,
    requestAnimationFrame: (callback) => setTimeout(callback, 1),
    scrollTo() {},
    getComputedStyle: (element) => ({ position: element.position, display: element.style.display || 'block', visibility: 'visible' }),
    document: {
      querySelectorAll: (selector) => (selector === 'body *' ? all : all.filter((element) => element.hidden())),
      images: [], fonts: { ready: Promise.resolve() }, documentElement: { scrollWidth: 390 }, timeline: {},
      getAnimations: () => [],
    },
  };
  emulation.page = async (expression) => ({ result: { value: JSON.parse(JSON.stringify(await runInNewContext(expression, page))) } });
  emulation.restoreNotices = async (expression) => (runInNewContext(expression, page), {});

  return { notice, others };
}

test('capture_page hides a cookie notice for each shot and puts it back', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  const { notice, others } = noticePage(f.emulation);
  notice.style.display = 'block';
  const during = [];
  f.capture = async ({ clip }) => {
    during.push([notice.style.display, notice.style.priority, ...others.map(({ style }) => style.display)]);

    return png(clip.width, clip.height);
  };

  // The fake page stays 390 wide, and a width within a pixel of it passes.
  const captured = await f.host.capture_page({ widths: ['mobile', 391] });
  assert.deepEqual(captured.shots?.map(({ hidden_notices }) => hidden_notices), [1, 1], JSON.stringify(captured));
  assert.deepEqual(during.at(-1), ['none', 'important', '', '', '', '', '']);
  assert.deepEqual([notice.style.display, notice.style.priority, notice.hidden()], ['block', '', false]);
});

test('capture_page distinguishes consent answers from an unrelated OK page tool', async (t) => {
  for (const [text, label] of [['Cookie policy', 'Accept'], ['We use cookies to run this site.', 'OK']]) {
    const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
    const { notice } = noticePage(f.emulation);
    notice.innerText = text;
    notice.querySelectorAll = () => [{ innerText: label, getAttribute: () => null }];
    const result = await f.host.capture_page({ widths: ['mobile'] });
    assert.equal(result.ok, true);
    assert.equal(result.shots[0].hidden_notices, 1);
  }
});

test('capture_page keeps notices on request and reports one it could not put back', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  const { notice } = noticePage(f.emulation);
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  const kept = await f.host.capture_page({ widths: ['mobile'], keep_notices: true });
  assert.deepEqual([kept.shots[0].hidden_notices, notice.style.display], [0, '']);
  const invalid = await f.host.capture_page({ keep_notices: 'yes' });
  assert.deepEqual([invalid.error, invalid.issues[0].path], ['invalid_capture', 'keep_notices']);
  f.emulation.restoreNotices = async () => { throw new Error('Tab closed'); };

  const stuck = await f.host.capture_page({ widths: ['mobile'] });
  assert.deepEqual([stuck.ok, stuck.shots.length, stuck.notice_cleanup.error, stuck.notice_cleanup.next], [true, 1, 'notice_restore_failed', 'close_tab']);
  f.emulation.restoreNotices = async () => ({ exceptionDetails: { text: 'Uncaught' } });
  assert.equal((await f.host.capture_page({ widths: ['mobile'] })).notice_cleanup.error, 'notice_restore_failed');
});

test('capture_page scrolls and settles again after ending animations, and reports a selector they removed', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  // Ending the band brings a slow image into view.
  const image = { complete: true, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
  const loading = animatedPage(f.emulation, (motion, page) => {
    page.document.images.push(image);
    image.complete = false;
    setTimeout(() => { image.complete = true; }, 60);
  });
  const complete = [];
  f.capture = async ({ clip }) => {
    complete.push(image.complete);

    return png(clip.width, clip.height);
  };

  const settled = await f.host.capture_page({ widths: ['mobile'], selector: '.hero' });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  assert.deepEqual([complete, loading.scrolls], [[true], 2]);

  // Scrolling back to the hero after the band ends starts another entrance.
  const chained = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  let late;
  animatedPage(chained.emulation, (motion) => {
    motion.onScroll = () => {
      late = motion.animation(500);
      motion.animations.push(late);
      motion.onScroll = undefined;
    };
  });
  const lateStates = [];
  chained.capture = async ({ clip }) => {
    lateStates.push(late?.playState);

    return png(clip.width, clip.height);
  };

  const finishedLate = await chained.host.capture_page({ widths: ['mobile'], selector: '.hero' });
  assert.deepEqual([finishedLate.shots?.[0].finished_animations, lateStates], [3, ['finished']], JSON.stringify(finishedLate));

  const removing = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  animatedPage(removing.emulation, (motion) => { motion.hero = undefined; });
  removing.capture = async ({ clip }) => png(clip.width, clip.height);
  const removed = await removing.host.capture_page({ widths: ['mobile'], selector: '.hero' });
  assert.equal(removed.error, 'selector_not_found', JSON.stringify(removed));
  assert.deepEqual(removed.diagnostics, { field: 'selector', width: 'mobile' });
});

test('capture_page paints and settles a hidden tab three times so chained entrances end before the shot', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  const motion = animatedPage(f.emulation);
  motion.page.document.visibilityState = 'hidden';
  motion.page.requestAnimationFrame = () => assert.fail('A hidden tab runs no frame callbacks.');
  // A hidden tab runs handlers only in the frame a capture forces. There an
  // intersection handler swaps in a slow image, the band's end starts a
  // reveal, and the reveal's end starts another entrance.
  const handlers = [];
  const image = { complete: true, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
  let late;
  handlers.push(() => {
    motion.page.document.images.push(image);
    image.complete = false;
    setTimeout(() => { image.complete = true; }, 60);
  });
  motion.band.finish = () => {
    motion.band.playState = 'finished';
    handlers.push(() => motion.animations.push(motion.reveal));
  };

  motion.reveal.finish = () => {
    motion.reveal.playState = 'finished';
    handlers.push(() => {
      late = motion.animation(500);
      motion.animations.push(late);
    });
  };

  const painted = [];
  f.capture = async ({ clip }) => {
    for (const handler of handlers.splice(0)) handler();
    painted.push([image.complete, motion.reveal.playState, late?.playState]);

    return png(clip.width, clip.height);
  };

  const captured = await f.host.capture_page({ widths: ['mobile'] });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.deepEqual(painted, [[false, 'running', undefined], [true, 'finished', 'running'], [true, 'finished', 'finished'],
    [true, 'finished', 'finished']]);
  assert.equal(captured.shots.length, 1);
  assert.equal(captured.shots[0].finished_animations, 3);
});

test('capture_page keeps painting a hidden tab whose loaded image brings another into view', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  const motion = animatedPage(f.emulation);
  motion.animations.length = 0;
  motion.page.document.visibilityState = 'hidden';
  // An intersection handler swaps in a slow image; once it loads, its size
  // brings a second one into view, whose handler waits for the next frame.
  const handlers = [];
  const images = [0, 1].map(() => ({ complete: true, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) }));
  const load = (index) => () => {
    motion.page.document.images.push(images[index]);
    images[index].complete = false;
    setTimeout(() => {
      images[index].complete = true;

      if (index === 0) handlers.push(load(1));
    }, 30);
  };

  handlers.push(load(0));
  const painted = [];
  f.capture = async ({ clip }) => {
    for (const handler of handlers.splice(0)) handler();
    painted.push(images.map(({ complete }) => complete));

    return png(clip.width, clip.height);
  };

  const captured = await f.host.capture_page({ widths: ['mobile'] });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.deepEqual(painted, [[false, true], [true, false], [true, true], [true, true]]);
  assert.equal(captured.shots[0].finished_animations, 0);
});

test('capture_page refuses page measurements over 64 KiB in UTF-8 bytes and malformed elements', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  const selectors = Array.from({ length: 8 }, (_, index) => `.s${index}`);
  const properties = Array.from({ length: 32 }, (_, index) => `--p${index}`);
  // Under 64Ki UTF-16 code units, but three bytes per character.
  const wide = '漢'.repeat(200);
  const elements = selectors.map((selector) => ({
    selector, found: true, tag: 'div', rect: { x: 0, y: 0, width: 1, height: 1 },
    styles: Object.fromEntries(properties.map((property) => [property, wide])),
  }));
  const shown = (value) => ({ ok: true, width: 390, height: 844, scroll_x: 0, scroll_y: 0, scroll_width: 390, finished_animations: 0, hidden_notices: 0, selector_offset: 0, elements: value });
  f.emulation.page = async () => ({ result: { value: shown(elements) } });
  const oversized = await f.host.capture_page({ widths: ['mobile'], measure: { selectors, properties } });
  assert.equal(JSON.stringify(elements).length < 65536, true);
  assert.equal(oversized.error, 'measure_response_too_large', JSON.stringify(oversized).slice(0, 300));
  const element = { selector: '.s0', found: true, tag: 'div', rect: { x: -5, y: 0, width: 1, height: 1 }, styles: { color: 'red' } };
  const request = { widths: ['mobile'], measure: { selectors: ['.s0'], properties: ['color'] } };
  f.emulation.page = async () => ({ result: { value: shown([element]) } });
  // A negative x is a real position to the left of the viewport.
  assert.equal((await f.host.capture_page(request)).ok, true);

  for (const malformed of [
    shown([{ selector: '.other', found: false }]), shown([{ ...element, tag: '' }]),
    shown([{ ...element, rect: { ...element.rect, width: -100 } }]), shown([{ ...element, raw: 'page value' }]),
    shown([{ ...element, rect: { ...element.rect, z: 1 } }]), { ...shown([element]), scroll_width: -20 },
    { ...shown([element]), finished_animations: -1 }, { ...shown([element]), hidden_notices: -1 },
    { ...shown([element]), selector_offset: -1 }, { ...shown([element]), selector_offset: 423 },
    { ...shown([element]), selector_offset: '112' },
  ]) {
    f.emulation.page = async () => ({ result: { value: malformed } });
    assert.equal((await f.host.capture_page(request)).error, 'page_unavailable', JSON.stringify(malformed));
  }
});

test('capture_page refuses a malformed measure before resizing and names an invalid measure selector', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  animatedPage(f.emulation);

  for (const [measure, path] of [
    [{}, 'measure.selectors'], [[], 'measure'], [{ selectors: [] }, 'measure.selectors'],
    [{ selectors: ['.a'], extra: 1 }, 'measure.extra'], [{ selectors: ['.a'], properties: ['Bad Prop'] }, 'measure.properties.0'],
    [{ selectors: [''] }, 'measure.selectors.0'], [{ selectors: Object.assign([], { 1: '.a' }) }, 'measure.selectors.0'],
    [{ selectors: ['.a'], properties: Object.assign([], { 1: 'margin' }) }, 'measure.properties.0'],
  ]) {
    const refused = await f.host.capture_page({ widths: ['mobile'], measure });
    assert.deepEqual([refused.error, refused.validation_source, refused.issues?.[0]?.path], ['invalid_capture', 'request', path], JSON.stringify(measure));
    assert.match(refused.issues[0].hint, /Nothing was resized/);
  }

  assert.equal((await f.host.capture_page({ widths: ['mobile', 'mobile'] })).issues[0].path, 'widths.1');
  assert.deepEqual(f.emulation.filter(Array.isArray), []);
  const invalid = await f.host.capture_page({ widths: ['mobile'], measure: { selectors: ['.hero', 'a['] } });
  assert.equal(invalid.error, 'invalid_selector', JSON.stringify(invalid));
  assert.deepEqual(invalid.diagnostics, { field: 'measure.selectors.1', width: 'mobile' });
  assert.match(invalid.hint, /diagnostics\.field/);
  assert.deepEqual(f.emulation.at(-1), ['Emulation.clearDeviceMetricsOverride']);
});

test('a resized call puts back the size a hidden tab had when clearing gives it the browser size', async (t) => {
  const f = await hostFixture(t, async (request) => {
    if (request.operation === 'connect') return { ok: true, target, workflow: 'background' };

    if (request.operation === 'restore_view') return { ok: true };

    return { ok: true, width: 'mobile', canvas_width: 479, width_source: 'preset', rendered: false };
  });
  f.emulation.natural = [1648, 1674];
  await f.host.connect(connection);
  assert.equal((await f.host.view({ client_id: 'a', widths: ['mobile'] })).ok, true);
  assert.deepEqual(f.emulation.slice(-2), [['Emulation.clearDeviceMetricsOverride'], ['Emulation.setDeviceMetricsOverride', 1280, 720]]);
  // That size is the tab's own again, so the next call does not reset it.
  const count = f.emulation.length;
  await f.host.read();
  assert.equal(f.emulation.length, count);
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  assert.equal((await f.host.capture_page({ widths: ['mobile'] })).ok, true);
  assert.deepEqual(f.emulation.at(-1), ['Emulation.setDeviceMetricsOverride', 1280, 720]);
});

test('capture_page reports a failed reset beside its own failure and refuses malformed page results', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  let clears = 0;
  f.emulation.refuse = (method) => method === 'Emulation.clearDeviceMetricsOverride' && ++clears === 1;
  const missing = await f.host.capture_page({ widths: ['mobile'], selector: '.missing' });
  assert.deepEqual([missing.error, missing.tab_resize?.error], ['selector_not_found', 'tab_resize_failed'], JSON.stringify(missing));
  assert.match(missing.tab_resize.hint, /closing the tab/);
  f.emulation.page = async () => ({ result: { value: { ok: true } } });
  assert.equal((await f.host.capture_page({ widths: ['mobile'] })).error, 'page_unavailable');
  f.emulation.page = async () => ({ result: { value: { ok: false, error: 'made_up' } } });
  assert.equal((await f.host.capture_page({ widths: ['mobile'] })).error, 'page_unavailable');
  assert.equal((await f.host.capture_page({ widths: ['mobile'], selector: { toString: null } })).error, 'invalid_capture');
});

test('a size left by a failed reset never becomes the size the tab returns to', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  f.emulation.natural = [1648, 1674];
  let clears = 0;
  f.emulation.refuse = (method) => method === 'Emulation.clearDeviceMetricsOverride' && ++clears === 1;
  const phone = await f.host.capture_page({ widths: ['mobile'] });
  assert.deepEqual([phone.ok, phone.tab_resize?.error], [true, 'tab_resize_failed']);
  assert.equal((await f.host.capture_page({ widths: ['desktop'] })).ok, true);
  // The second call first put the tab back at 1280 by 720, then ended there.
  const sizes = f.emulation.filter(([method]) => method === 'Emulation.setDeviceMetricsOverride').map(([, width, height]) => [width, height]);
  assert.deepEqual(sizes, [[390, 844], [1280, 720], [1440, 1080], [1280, 720]]);
});

test('an unreadable tab size refuses to resize, and one unreadable after clearing is reported and checked again', async (t) => {
  const f = await hostFixture(t, async () => assert.fail('capture_page needs no page operation'));
  f.capture = async ({ clip }) => png(clip.width, clip.height);
  f.emulation.unreadable = () => true;
  const unread = await f.host.capture_page({ widths: ['mobile'] });
  assert.equal(unread.error, 'tab_size_unavailable', JSON.stringify(unread));
  assert.equal(f.emulation.length, 0);
  let reads = 0;
  // The size reads before resizing, then fails once after clearing.
  f.emulation.unreadable = () => ++reads === 2;
  const unverified = await f.host.capture_page({ widths: ['mobile'] });
  assert.deepEqual([unverified.ok, unverified.tab_resize?.error], [true, 'tab_resize_unverified'], JSON.stringify(unverified));
  assert.equal(unverified.shots.length, 1);
  const count = f.emulation.length;
  assert.equal((await f.host.capture_page({ widths: ['mobile'] })).tab_resize, undefined);
  assert.deepEqual(f.emulation[count], ['Emulation.clearDeviceMetricsOverride']);
});

test('site operations use the connected site and user unless a target is given', async (t) => {
  const f = await hostFixture(t, async request => request.operation === 'connect' ? { ok: true, target } : { ok: true });
  await f.host.call({ operation: 'inspect_media', search: 'hero' });
  assert.equal(f.requests[0].target, undefined);
  await f.host.connect(connection);
  await f.host.call({ operation: 'inspect_media', search: 'hero' });
  assert.deepEqual(f.requests.at(-1).target, { site_url: target.site_url, user_id: 5 });
  await f.host.call({ operation: 'run_ability', name: 'demo/read-info', effect: 'read' });
  assert.deepEqual(f.requests.at(-1).target, { site_url: target.site_url, user_id: 5 });
  const other = { site_url: 'https://other.test', user_id: 2 };
  await f.host.call({ operation: 'discover', target: other });
  assert.deepEqual(f.requests.at(-1).target, other);
  await f.host.call({ operation: 'inspect_entity' });
  assert.equal(f.requests.at(-1).target, undefined);
});

test('copy_media maps uploads with different stored bytes without replaying them', async t => {
  const f = await mediaCopyFixture(t, (request, result) => {
    if (request.operation === 'save_resource') return { ok: false, error: 'verification_deferred', persistence: 'uncertain', resource_id: result.resource_id, receipt: request.receipt };

    if (request.operation === 'verify_resource') return { ...result, ok: false, error: 'upload_bytes_different', outcome: 'upload_bytes_different', persistence: 'uncertain' };

    return result;
  });
  f.request.ids = [1];
  await f.destination.host.copy_media(f.request);
  const copied = await f.destination.host.copy_media(f.request);
  assert.equal(copied.complete, true);
  assert.equal(copied.persistence, 'uncertain');
  assert.equal(copied.items[0].state, 'upload_bytes_different');
  assert.equal(copied.items[0].result.error, 'upload_bytes_different');
  assert.deepEqual(copied.media_map.ids, { '1': 31 });
  assert.equal(copied.media_map.urls[f.records[0].source_url], `${target.site_url}/uploads/copied-31.png`);
  assert.equal((await f.destination.host.copy_media(f.request)).complete, true);
  assert.equal(f.destination.requests.filter(request => request.operation === 'save_resource').length, 1);
});

test('capture schema preserves authored first-field errors before browser work', async t => {
  const f = await hostFixture(t, () => assert.fail('invalid capture reached the engine'));
  const cases = [
    [{ extra: true, keep_notices: 'yes' }, 'extra', 'absent; use only url, widths, selector, states, measure, and keep_notices'],
    [{ keep_notices: 'yes', url: 'bad' }, 'keep_notices', 'true or false'],
    [{ widths: [null, ...Array(6).fill('mobile')] }, 'widths', 'a list of one to six widths'],
    [{ widths: ['mobile', 'mobile', null] }, 'widths.1', 'a distinct desktop, tablet, mobile, or whole number of CSS pixels from 320 to 2560'],
    [{ states: { extra: true } }, 'states.extra', 'absent; use only selector and pseudo'],
    [{ states: {} }, 'states.selector', 'a CSS selector string of 1 to 500 characters'],
    [{ states: { selector: '.hero' } }, 'states.pseudo', 'a list of 1 to 5 distinct pseudo-classes'],
    [{ measure: { selectors: [null, ...Array(20).fill('.hero')] } }, 'measure.selectors', 'a list of 1 to 20 CSS selectors'],
    [{ measure: { selectors: ['.hero'], properties: [null, ...Array(32).fill('color')] } }, 'measure.properties', 'a list of up to 32 CSS property names'],
    [{ measure: { selectors: ['.hero'], properties: ['Bad Prop'] } }, 'measure.properties.0', 'a lowercase CSS property name, such as margin-top, min_height, or --brand-gap'],
  ];

  for (const [request, path, expected] of cases) {
    const refused = await f.host.capture_page(request);
    assert.deepEqual([refused.error, refused.next, refused.validation_source], ['invalid_capture', 'correct_request', 'request']);
    assert.deepEqual(refused.issues, [{ path, expected, hint: `Correct ${path} and call capture_page again. Nothing was resized, navigated or captured.` }]);
  }

  assert.deepEqual([f.requests, f.emulation, f.navigations, f.shots], [[], [], [], []]);
});

test('create schema preserves missing fields and unknown-key precedence before discovery', async t => {
  const f = await hostFixture(t, () => assert.fail('invalid create reached discovery'));

  for (const [request, path, expected] of [
    [{ extra: true }, 'extra', 'absent; use only target and post_type'],
    [{ target: [] }, 'target', 'an object with site_url and user_id'],
    [{ target: { extra: true } }, 'target.extra', 'absent; use only site_url and user_id'],
    [{ target: {} }, 'post_type', 'a required REST-visible editor type such as page'],
  ]) {
    const refused = await f.host.create(request);
    assert.deepEqual([refused.error, refused.next, refused.operation_started], ['invalid_create', 'correct_request', false]);
    assert.deepEqual(refused.issues, [{ path, expected }]);
    assert.equal(refused.hint, `Correct ${path}: expected ${expected}. create takes only target: {site_url, user_id} and post_type.`);
  }

  assert.deepEqual([f.requests, f.navigations], [[], []]);
  assert.equal(f.host.read().error, 'connect_required');
});

test('copy schema preserves collapsed field errors and validates before acquiring either caller', async t => {
  const f = await mediaCopyFixture(t);

  for (const [fields, path, expected] of [
    [{ extra: true, source: null }, '', 'source, source_target, target, ids, copy_id, and optional deadline_ms and parent_id only'],
    [{ source_target: { ...f.request.source_target, extra: true } }, 'source_target', 'an exact http or https site_url and positive user_id'],
    [{ target: { ...f.request.target, site_url: 'https://user:pass@example.test' } }, 'target', 'an exact http or https site_url and positive user_id'],
    [{ ids: [1, 1] }, 'ids', '1 to 50 distinct positive attachment IDs'],
    [{ ids: Array(1) }, 'ids', '1 to 50 distinct positive attachment IDs'],
    [{ copy_id: 'Uppercase' }, 'copy_id', '1 to 80 lowercase letters, digits, underscores, or hyphens, starting with a letter or digit'],
    [{ deadline_ms: 44999 }, 'deadline_ms', 'an integer from 45000 to 55000 milliseconds'],
    [{ parent_id: Number.MAX_SAFE_INTEGER + 1 }, 'parent_id', 'a nonnegative target post ID'],
  ]) {
    const refused = await f.destination.host.copy_media({ ...f.request, ...fields });
    assert.deepEqual([refused.error, refused.next, refused.persistence], ['invalid_media_copy', 'correct_request', 'not_attempted']);
    assert.deepEqual(refused.issues, [{ path, expected }]);
    assert.equal(refused.hint, 'Correct the named field. No copy operation started.');
  }

  assert.deepEqual([f.source.requests, f.destination.requests, f.receipts], [[], [], []]);
  assert.equal((await f.destination.host.copy_media(f.request)).complete, true);
});

test('copy URL schemas keep malformed keys and the 2000-entry limit from attachment responses', async t => {
  for (const mode of ['invalid-url', 'too-many']) {
    const f = await mediaCopyFixture(t);
    f.request.ids = [1];

    if (mode === 'invalid-url') f.records[0].source_url = 'constructor';
    else f.records[0].media_details.sizes = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [String(index), { source_url: `https://source.example.test/uploads/size-${index}.png` }]));

    const failed = await f.destination.host.copy_media(f.request);
    assert.deepEqual([failed.error, failed.next], ['media_copy_map_limit', 'resume_media_copy']);
    assert.equal(failed.hint, 'The map requires at most 2000 absolute http or https URLs of at most 2048 characters. Keep receipts and split IDs into smaller requests with the same copy_id; existing copies will be read.');
    assert.equal(failed.items[0].receipt.key, f.receipts[0].key);
    assert.equal(f.destination.requests.filter(({ operation }) => operation === 'save_resource').length, 1);
  }
});
