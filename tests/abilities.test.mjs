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
const collection = '/wp-abilities/v1/abilities';

// PHP-style nesting, as wp.url.addQueryArgs writes it for values it can carry.
function addQueryArgs(path, args) {
  const pairs = [];

  const walk = (key, value) => {
    if (Object(value) === value) {
      for (const [name, item] of Object.entries(value)) walk(`${key}[${name}]`, item);
    } else if (value !== undefined) {
      pairs.push(`${key}=${encodeURIComponent(String(value))}`);
    }
  };

  for (const [key, value] of Object.entries(args)) walk(key, value);

  return `${path}?${pairs.join('&')}`;
}

function fixture() {
  const f = { auth: true, requests: [], runs: [], abilities: {
    'demo/read-info': { label: 'Read info', description: `${'Reads a post. '.repeat(30)}DESCRIPTION-END`, category: 'demo-content',
      annotations: { readonly: true, destructive: false, idempotent: true },
      input_schema: { type: 'object', properties: { post_id: { type: 'integer' } }, marker: 'SCHEMA-MARKER' },
      output_schema: { type: 'object', marker: 'OUTPUT-MARKER' } },
    'demo/set-value': { label: 'Set value', description: 'Sets a value.', input_schema: { type: 'object' },
      annotations: { readonly: false, destructive: false, idempotent: false } },
    'demo/replace-meta': { label: 'Replace meta', description: 'Overwrites meta.', input_schema: { type: 'object' },
      annotations: { readonly: false, destructive: true, idempotent: true } },
    // Nested fields as ACF declares them, then rules a client must leave to WordPress.
    'demo/create-book': { label: 'Create book', description: 'Creates a book.',
      annotations: { readonly: false, destructive: false, idempotent: false },
      input_schema: { type: 'object', required: ['title'], additionalProperties: false, properties: {
        title: { type: 'string', maxLength: 5 },
        status: { type: 'string', enum: ['draft', 'publish'] },
        fields: { type: 'object', additionalProperties: false, properties: {
          rating: { type: 'integer', minimum: 0, maximum: 5 }, tags: { type: 'array', items: { type: 'string' } } } },
        code: { type: 'string', pattern: '^\\p{Lu}+$' },
        upload: { type: 'file' },
        choice: { oneOf: [{ type: 'string', pattern: '^a' }, { type: 'string', pattern: '^b' }] },
        labels: { type: 'object', additionalProperties: false, patternProperties: { '^x-': { type: 'string' } } },
        tagged: { type: 'object', additionalProperties: { type: 'integer' }, patternProperties: { '^x-': { type: 'string' } } },
        any: { type: 'integer', enum: [] },
        untyped: { minimum: 10 },
        rich: { type: 'rich-text', enum: [5] },
      } } },
    'demo/defaulted': { label: 'Defaulted', description: 'Fills an omitted input.',
      annotations: { readonly: false, destructive: false, idempotent: false },
      input_schema: { type: 'object', default: {}, properties: { limit: { type: 'integer' } } } },
    'demo/undeclared': { label: 'Undeclared', description: 'Declares nothing.',
      annotations: { readonly: null, destructive: null, idempotent: null } },
    // Values PHP's empty() and JavaScript's truthiness read differently.
    'demo/php-empty': { label: 'PHP empty', description: 'Declares loosely typed annotations.',
      annotations: { readonly: '0', destructive: [], idempotent: true } },
  } };

  const record = (name) => ({ name, ...f.abilities[name], annotations: undefined, meta: { annotations: f.abilities[name].annotations } });

  const answer = async ({ path, method = 'GET', data, parse }) => {
    f.requests.push({ path, method });

    if (!f.auth) throw { code: 'rest_cookie_invalid_nonce', data: { status: 403 } };

    if (path === '/?_fields=url') return { url: target.site_url };

    if (path.startsWith('/wp/v2/users/me')) return { id: 5, name: 'Fixture', slug: 'fixture' };

    if (f.noRoute) throw { code: 'rest_no_route', data: { status: 404 } };
    const [route] = path.split('?');
    assert.ok(route.startsWith(collection), path);

    if (route === collection) return Object.keys(f.abilities).map(record);
    const run = route.endsWith('/run');
    const name = route.slice(collection.length + 1, run ? -4 : undefined);

    if (!f.abilities[name]) throw { code: 'rest_ability_not_found', data: { status: 404 } };

    if (!run) {
      f.afterLookup?.();

      return record(name);
    }

    f.runs.push({ name, method, path, data, parse });

    return (await f.onRun?.(name)) ?? { done: name };
  };

  // What core's apiFetch does around a request: parsed, it throws the error
  // body and repeats the request once after refreshing an invalid nonce.
  // Unparsed, it returns the response, or throws it when it is an error.
  const apiFetch = async (options) => {
    try {
      const body = await answer(options);

      // A test may answer with a whole response, such as an error page.
      if (options.parse !== false || body instanceof Response) return body;

      return new Response(JSON.stringify(body));
    } catch (error) {
      const site = error?.code && !['fetch_error', 'offline_error'].includes(error.code);

      if (site && options.parse === false) throw new Response(JSON.stringify(error), { status: error.data?.status ?? 500 });

      if (error?.code === 'rest_cookie_invalid_nonce' && f.auth) return answer(options);

      throw error;
    }
  };

  f.window = { wp: { apiFetch, url: { addQueryArgs } } };

  // f.expire(ms) fires every request deadline of that length at once.
  const deadlines = [];
  f.expire = (ms) => {
    for (const deadline of deadlines) if (deadline.ms === ms) deadline.controller.abort(new DOMException('Timed out', 'TimeoutError'));
  };

  const signals = { timeout(ms) {
    const controller = new AbortController();
    deadlines.push({ ms, controller });

    return AbortSignal.any([AbortSignal.timeout(ms), controller.signal]);
  } };

  f.location = new URL('https://example.test/wp-admin/index.php');
  const invoke = runInNewContext(source, { window: f.window, location: f.location,
    URL, URLSearchParams, TextEncoder, Response, crypto, AbortSignal: signals, setTimeout, clearTimeout,
    document: { visibilityState: 'visible', body: { className: 'wp-admin branch-7-1 version-7-1-2' } },
    // elapsedMs moves the engine's clock, as a slow request would.
    Date: class extends Date { static now() { return Date.now() + (f.elapsedMs ?? 0); } } });

  f.call = (operation, extra = {}) => invoke({ operation, target, ...extra });
  f.run = (name, effect, input, extra = {}) => f.call('run_ability', { name, effect, input, ...extra });

  return f;
}

test('ability request validation names the field before any request', async () => {
  const f = fixture();

  for (const [operation, extra, path] of [
    ['run_ability', { name: 'Demo/Read', effect: 'read' }, 'name'],
    ['run_ability', { name: 'demo/read-info', effect: 'delete' }, 'effect'],
    ['run_ability', { name: 'demo/read-info' }, 'effect'],
    ['run_ability', { name: 'demo/read-info', effect: 'read', receipt: 'private-input' }, 'receipt'],
    ['run_ability', { name: 'demo/read-info', effect: 'read', skip_input_check: false }, 'skip_input_check'],
    ['inspect_abilities', { page: 0 }, 'page'],
  ]) {
    const result = await f.call(operation, extra);
    assert.deepEqual([result.error, result.operation, result.next, result.issues[0].path],
      ['invalid_ability_request', operation, 'correct_request', path], JSON.stringify(result));
    assert.match(result.hint, /inspect_abilities/);
    assert.ok(result.issues[0].hint.length > 20);
    assert.equal(JSON.stringify(result).includes('private-input'), false);
  }

  assert.equal(f.requests.length, 0);
});

test('inspect_abilities lists compact summaries and returns a schema for one named ability', async () => {
  const f = fixture();
  const list = await f.call('inspect_abilities');
  assert.deepEqual(list.abilities.map((ability) => [ability.name, ability.effect]), [
    ['demo/read-info', 'read'], ['demo/set-value', 'write'], ['demo/replace-meta', 'destructive'],
    ['demo/create-book', 'write'], ['demo/defaulted', 'write'],
    ['demo/undeclared', 'destructive'], ['demo/php-empty', 'destructive'],
  ]);
  assert.deepEqual([list.page, list.may_have_more], [1, false]);
  assert.deepEqual(Object.keys(list.abilities[0]), ['name', 'label', 'category', 'effect', 'description']);
  assert.deepEqual([list.abilities[0].category, list.abilities[1].category], ['demo-content', '']);
  assert.equal(list.abilities[0].description.length, 200);
  // The server keeps schemas, and a server that sent them anyway is not relayed.
  assert.equal(f.requests.at(-1).path, `${collection}?per_page=50&page=1&_fields=name%2Clabel%2Cdescription%2Ccategory%2Cmeta.annotations`);
  assert.equal(/SCHEMA-MARKER|OUTPUT-MARKER|DESCRIPTION-END/.test(JSON.stringify(list)), false);
  await f.call('inspect_abilities', { category: 'demo-content', namespace: 'demo', page: 2 });
  assert.match(f.requests.at(-1).path, /\?per_page=50&page=2&category=demo-content&namespace=demo&_fields=/);
  assert.equal((await f.call('inspect_abilities', { namespace: 'Demo/' })).error, 'invalid_ability_request');

  const one = await f.call('inspect_abilities', { name: 'demo/read-info' });
  assert.equal(one.ability.effect, 'read');
  assert.equal(one.ability.category, 'demo-content');
  assert.equal(one.ability.input_schema.marker, 'SCHEMA-MARKER');
  assert.equal(one.ability.output_schema.marker, 'OUTPUT-MARKER');
  assert.match(one.ability.description, /DESCRIPTION-END$/);
  assert.equal(f.runs.length, 0);
});

test('run_ability uses the method core requires and puts input where core reads it', async () => {
  const f = fixture();
  const read = await f.run('demo/read-info', 'read', { post_id: 5, fields: ['title'] });
  assert.equal(JSON.stringify(read), '{"ok":true,"effect":"read","output":{"done":"demo/read-info"}}');
  // JSON carries null and empty values that a query string cannot.
  await f.run('demo/set-value', 'write', { value: 'x', ids: [], note: null });
  await f.run('demo/replace-meta', 'destructive', { post_id: 5, noindex: false });
  const undeclared = await f.run('demo/undeclared', 'destructive', null);
  assert.equal(undeclared.effect, 'destructive');
  // PHP reads "0" and [] as unset, so core wants POST where truthiness would pick GET or DELETE.
  await f.run('demo/php-empty', 'destructive');

  assert.deepEqual(f.runs.map((run) => [run.method, run.path.slice(collection.length), JSON.stringify(run.data)]), [
    ['GET', '/demo/read-info/run?input[post_id]=5&input[fields][0]=title', undefined],
    ['POST', '/demo/set-value/run', '{"input":{"value":"x","ids":[],"note":null}}'],
    ['DELETE', '/demo/replace-meta/run?input[post_id]=5&input[noindex]=false', undefined],
    ['POST', '/demo/undeclared/run', undefined],
    ['POST', '/demo/php-empty/run', undefined],
  ]);
});

test('input that breaks the schema refuses before the run and names the value', async () => {
  const f = fixture();

  for (const [name, effect, input, path, constraint] of [
    ['demo/create-book', 'write', {}, 'input.title', 'required'],
    ['demo/create-book', 'write', { title: 5 }, 'input.title', 'type'],
    ['demo/create-book', 'write', { title: 'toolong' }, 'input.title', 'max_length'],
    ['demo/create-book', 'write', { title: 'ok', status: 'trash' }, 'input.status', 'enum'],
    ['demo/create-book', 'write', { title: 'ok', fields: { rating: 9 } }, 'input.fields.rating', 'maximum'],
    ['demo/create-book', 'write', { title: 'ok', fields: { tags: ['a', 2] } }, 'input.fields.tags.1', 'type'],
    ['demo/create-book', 'write', { title: 'ok', fields: { extra: 'private-input' } }, 'input.fields.extra', 'additional_properties'],
    ['demo/create-book', 'write', undefined, 'input', 'type'],
    ['demo/read-info', 'read', { post_id: 'five' }, 'input.post_id', 'type'],
  ]) {
    const result = await f.run(name, effect, input);
    assert.deepEqual([result.error, result.diagnostics.path, result.diagnostics.constraint, result.persistence, result.next],
      ['ability_input_rejected', path, constraint, 'not_attempted', 'correct_request'], JSON.stringify(result));
    assert.match(result.hint, /before sending/);
    assert.equal(JSON.stringify(result).includes('private-input'), false);
  }

  assert.equal(f.runs.length, 0);

  // The check is Blockwork's own. Skipping it hands the same input to WordPress.
  assert.equal((await f.run('demo/create-book', 'write', { title: 5 }, { skip_input_check: true })).ok, true);
  assert.equal(JSON.stringify(f.runs[0].data), '{"input":{"title":5}}');
});

test('rules WordPress may read differently are left to WordPress', async () => {
  const f = fixture();

  // Five characters in ten UTF-16 units, a PHP regex, a type WordPress does
  // not know, alternatives only a pattern tells apart, pattern-named keys with
  // and without a schema for the rest, an empty enum, and rules that WordPress
  // applies only for a type it knows.
  const inputs = [
    { title: '😀😀😀😀😀' },
    { title: 'ok', code: 'lower' },
    { title: 'ok', upload: { any: 'thing' } },
    { title: 'ok', choice: 'neither' },
    { title: 'ok', labels: { 'x-one': 'a' } },
    { title: 'ok', tagged: { 'x-name': 'hello' } },
    { title: 'ok', any: 5 },
    { title: 'ok', untyped: 5 },
    { title: 'ok', rich: 5 },
  ];

  for (const input of inputs) {
    const sent = await f.run('demo/create-book', 'write', input);
    assert.equal(sent.ok, true, JSON.stringify(sent));
  }

  // Core fills an omitted input from the schema's default, and a schema that
  // arrives empty may hold more on the server.
  assert.equal((await f.run('demo/defaulted', 'write')).ok, true);
  assert.equal((await f.run('demo/undeclared', 'destructive', { value: 'x' })).ok, true);
  assert.equal(f.runs.length, inputs.length + 2);
});

test('input a query string cannot carry refuses before the run', async () => {
  const f = fixture();

  for (const [input, path] of [
    [{ post_id: 5, ids: [] }, 'input.ids'],
    [{ post_id: 5, options: { keep: null } }, 'input.options.keep'],
    [{ ids: [1, {}] }, 'input.ids.1'],
    [{}, 'input'],
    // Keys wp.url or wp.apiFetch would rewrite on the way.
    [{ post_id: 5, constructor: 'x' }, 'input.constructor'],
    [{ meta: { prototype: 2 } }, 'input.meta.prototype'],
    [{ 'a[b]': 3 }, 'input.a[b]'],
    [{ '': 1 }, 'input.'],
  ]) {
    const result = await f.run('demo/replace-meta', 'destructive', input);
    assert.deepEqual([result.error, result.diagnostics.path, result.diagnostics.method, result.persistence, result.next],
      ['ability_query_input_unsupported', path, 'DELETE', 'not_attempted', 'correct_request'], JSON.stringify(result));
    assert.match(result.hint, /Leave that key out/);
  }

  assert.equal(f.runs.length, 0);
});

test('a stated effect that differs from the declared one refuses before the run', async () => {
  const f = fixture();

  for (const [name, stated, declared] of [
    ['demo/set-value', 'read', 'write'],
    ['demo/undeclared', 'write', 'destructive'],
    ['demo/read-info', 'write', 'read'],
    ['demo/php-empty', 'read', 'destructive'],
  ]) {
    const result = await f.run(name, stated, { value: 'x' });
    assert.deepEqual([result.error, result.diagnostics.declared_effect, result.persistence, result.next],
      ['ability_effect_mismatch', declared, 'not_attempted', 'correct_request'], JSON.stringify(result));
    assert.match(result.hint, /only when the user asked/);
  }

  assert.equal(f.runs.length, 0);
});

test('answers to a lookup or a read report that nothing changed', async () => {
  const f = fixture();
  const missing = await f.run('demo/hidden', 'write');
  assert.deepEqual([missing.error, missing.persistence, missing.next], ['ability_unavailable', 'not_attempted', 'inspect_abilities']);
  assert.match(missing.hint, /external-access setting/);
  assert.equal(f.runs.length, 0);

  for (const [code, status, error, next] of [
    ['rest_ability_cannot_execute', 403, 'ability_forbidden', 'inspect_abilities'],
    ['ability_invalid_input', 400, 'ability_input_rejected', 'correct_request'],
    ['rest_ability_invalid_method', 405, 'ability_failed', 'inspect_abilities'],
    // The controller's own 401 is a signed-out session; an ability's 401 is its own business.
    ['rest_ability_cannot_execute', 401, 'reauthorization_required', 'inspect_abilities'],
    ['remote_unauthorized', 401, 'ability_failed', 'inspect_abilities'],
    ['not a code: <b>private-input</b>', 500, 'ability_failed', 'inspect_abilities'],
  ]) {
    f.onRun = () => { throw { code, message: 'private-input', data: { status } }; };

    const answered = await f.run('demo/read-info', 'read', { post_id: 5 });
    assert.deepEqual([answered.error, answered.persistence, answered.next], [error, 'not_attempted', next], JSON.stringify(answered));
    assert.ok(answered.hint.length > 20);
    assert.equal(outsideDebug(answered).includes('private-input'), false);
    assert.equal(answered.debug.message, 'private-input');

    if (error === 'ability_failed') {
      assert.deepEqual([answered.diagnostics.ability_error, answered.diagnostics.status],
        [code.startsWith('not') ? 'unrecognized' : code, status]);
    }
  }

  f.noRoute = true;
  assert.equal((await f.call('inspect_abilities')).error, 'abilities_api_unavailable');
  assert.equal((await f.run('demo/set-value', 'write')).error, 'abilities_api_unavailable');
  delete f.window.wp.url;
  assert.equal((await f.call('inspect_abilities')).error, 'native_api_unavailable');
});

test('every error after a change was sent is uncertain, and the change is sent once', async () => {
  const f = fixture();

  // WordPress refuses the first three before an ability's own code runs, but
  // that code can pass on the same errors from an inner request, so none of
  // them shows that nothing changed. Core's parsed apiFetch would send the
  // run again after the nonce error, and core sends invalid output without a status.
  for (const [code, data] of [
    ['rest_ability_cannot_execute', { status: 403 }],
    ['ability_invalid_input', { status: 400 }],
    ['rest_cookie_invalid_nonce', { status: 403 }],
    ['ability_invalid_output', null],
    ['plugin_failed', { status: 500 }],
  ]) {
    const runs = f.runs.length;
    f.onRun = () => { throw { code, message: 'Ability "demo/set-value" failed: private-input', data }; };

    const result = await f.run('demo/set-value', 'write', { value: 'x' });
    assert.deepEqual([result.error, result.diagnostics.ability_error, result.diagnostics.status, result.persistence, result.next],
      ['ability_failed', code, data?.status ?? 500, 'uncertain', 'report_uncertain_do_not_replay'], JSON.stringify(result));
    assert.match(result.hint, /Never send the same run again/);
    assert.equal(outsideDebug(result).includes('private-input'), false);
    assert.match(JSON.stringify(result.debug), /private-input/);
    assert.equal(f.runs.length, runs + 1);
  }

  assert.equal(f.runs.every((run) => run.parse === false), true);

  // An unanswered request is no more certain.
  f.onRun = () => { throw { code: 'fetch_error', message: 'private-input' }; };

  const dropped = await f.run('demo/replace-meta', 'destructive', { post_id: 5 });
  assert.deepEqual([dropped.error, dropped.persistence, dropped.next], ['fetch_error', 'uncertain', 'report_uncertain_do_not_replay'], JSON.stringify(dropped));
});

test('a success that is not the ability output does not settle a change', async () => {
  const f = fixture();

  // A cache or firewall page, PHP warnings ahead of the JSON, and an empty answer.
  for (const body of ['<html>private-input</html>', 'Warning: private-input {"success":true}', '']) {
    f.onRun = () => new Response(body);

    const change = await f.run('demo/set-value', 'write', { value: 'x' });
    assert.deepEqual([change.error, change.diagnostics.status, change.persistence, change.next],
      ['ability_output_unreadable', 200, 'uncertain', 'report_uncertain_do_not_replay'], JSON.stringify(change));
    assert.match(change.hint, /never send the run again/);
    assert.equal(outsideDebug(change).includes('private-input'), false);

    const read = await f.run('demo/read-info', 'read', { post_id: 5 });
    assert.deepEqual([read.error, read.persistence], ['ability_output_unreadable', 'not_attempted'], JSON.stringify(read));
  }

  // WordPress's own empty success is 204, and JSON null is a real output.
  for (const response of [new Response(null, { status: 204 }), new Response('null')]) {
    f.onRun = () => response;

    assert.equal(JSON.stringify(await f.run('demo/set-value', 'write', { value: 'x' })), '{"ok":true,"effect":"write","output":null}');
  }
});

test('a run that outlasts its wait is uncertain for a change and retryable for a read', async () => {
  const f = fixture();
  f.onRun = () => new Promise(() => {});

  for (const [name, effect, persistence, next, method] of [
    ['demo/set-value', 'write', 'uncertain', 'report_uncertain_do_not_replay', 'POST'],
    ['demo/read-info', 'read', 'not_attempted', 'retry', 'GET'],
  ]) {
    const runs = f.runs.length;
    const running = f.run(name, effect, { post_id: 5 });

    while (f.runs.length === runs) await new Promise((resolve) => setTimeout(resolve, 1));
    f.expire(30000);
    const result = await running;
    assert.deepEqual([result.error, result.persistence, result.next, result.diagnostics.request],
      ['request_timeout', persistence, next, `${method} /wp-abilities/v1/abilities/:id`], JSON.stringify(result));
    assert.equal(f.runs.length, runs + 1);
  }

  // A site slow enough to leave a change no fair wait gets no change at all.
  const sent = f.runs.length;
  f.afterLookup = () => { f.elapsedMs = 30000; };

  const late = await f.run('demo/set-value', 'write', { value: 'x' });
  assert.deepEqual([late.error, late.persistence, late.next, late.diagnostics.operation_budget_spent],
    ['request_timeout', 'not_attempted', 'retry', true], JSON.stringify(late));
  assert.equal(f.runs.length, sent);
});

test('oversized ability output is omitted without failing the completed run', async () => {
  const f = fixture();
  f.onRun = () => ({ text: 'a'.repeat(70000) });

  const result = await f.run('demo/set-value', 'write', { value: 'x' });
  assert.deepEqual([result.ok, result.effect, result.output_omitted, 'output' in result], [true, 'write', 'too_large', false]);
  assert.ok(result.output_bytes > 70000);
});

test('ability calls stop at the login page and report an expired session', async () => {
  const f = fixture();
  f.location.pathname = '/wp-login.php';
  const loggedOut = await f.run('demo/set-value', 'write', { value: 'x' });
  assert.deepEqual([loggedOut.error, loggedOut.persistence], ['reauthorization_required', 'not_attempted']);
  assert.equal(f.requests.length, 0);

  f.location.pathname = '/wp-admin/index.php';
  f.auth = false;
  const expired = await f.call('inspect_abilities');
  assert.equal(expired.error, 'reauthorization_required');
  assert.match(expired.hint, /user to sign in.*wait_for_sign_in/);
  assert.equal(f.runs.length, 0);
});
