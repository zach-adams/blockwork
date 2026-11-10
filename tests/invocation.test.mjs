import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { callBlockwork, withDebug } from '../skills/blockwork/scripts/invoke.mjs';
import { bundles } from '../tools/bundle.mjs';

const { invoker: releaseInvoker } = await bundles({ debug: false });
const release = await import(`data:text/javascript;base64,${Buffer.from(releaseInvoker).toString('base64')}`);

// Development builds put the underlying message in debug; nothing else may echo it.
function outsideDebug(result) {
  return JSON.stringify({ ...result, debug: undefined });
}

const request = { operation: 'save', target: { post_id: 7 } };

function settledCapability(result, events) {
  return { async send(method) {
    events.push(method);

    if (method === 'Runtime.evaluate') return { result: { objectId: 'receipt-job' } };

    if (method === 'Runtime.getProperties') return { internalProperties: [
      { name: '[[PromiseState]]', value: { value: 'fulfilled' } },
    ] };

    if (method === 'Runtime.awaitPromise') return { result: { value: result } };

    return {};
  } };
}

test('a batch deadline bounds browser commands and retains uncertain mutation guidance', async () => {
  const commands = [];
  const deadline = Date.now() + 200;
  const result = await callBlockwork({ async send(method, params, options) {
    commands.push({ method, options });
    throw new Error('target closed');
  } }, 'source', { operation: 'save_resource', receipt: { key: 'synthetic' } }, { deadline });
  assert.equal(result.error, 'browser_command_failed');
  assert.equal(result.next, 'verify_resource_do_not_replay');
  assert.ok(commands[0].options.timeoutMs <= 200);
  assert.ok(result.diagnostics.budget_ms <= 200);
  assert.equal(commands.length, 1);
});

test('an expired batch never starts a browser operation', async (t) => {
  const deadline = 1000000;
  t.mock.method(Date, 'now', () => deadline);
  const events = [];
  const result = await callBlockwork(settledCapability({ ok: true }, events), 'source', {
    operation: 'save_resource', receipt: { key: 'synthetic' },
  }, { deadline });
  assert.deepEqual(events, []);
  assert.equal(result.error, 'browser_deadline_exhausted');
  assert.equal(result.operation_started, false);
  assert.equal(result.persistence, 'not_attempted');
  assert.equal(result.editor_result, 'not_attempted');
  assert.equal(result.next, 'retry');
  assert.equal(result.diagnostics.stage, 'before_invocation');
  assert.match(result.hint, /No browser operation started/);
});

test('invocation evaluates once, polls a long Promise, and releases the fulfilled result', async () => {
  const methods = [];
  let polls = 0;
  const capability = { async send(method, params) {
    methods.push(method);

    if (method === 'Runtime.evaluate') {
      assert.equal(params.awaitPromise, false);
      assert.equal(params.returnByValue, false);

      return { result: { objectId: 'job-1' } };
    }

    if (method === 'Runtime.getProperties') return { internalProperties: [
      { name: '[[PromiseState]]', value: { value: ++polls === 2 ? 'fulfilled' : 'pending' } },
    ] };

    if (method === 'Runtime.awaitPromise') return { result: { value: { ok: true, editor_result: 'verified' } } };

    return {};
  } };
  const result = await callBlockwork(capability, '(request) => Promise.resolve(request)', request);
  assert.equal(result.ok, true);
  assert.equal(methods.filter(m => m === 'Runtime.evaluate').length, 1);
  assert.equal(methods.at(-1), 'Runtime.releaseObject');
});

test('invocation retains an uncertain Promise and redacts browser exceptions', async () => {
  const methods = [];
  const result = await callBlockwork({ async send(method) {
    methods.push(method);

    if (method === 'Runtime.evaluate') return { result: { objectId: 'job-2' } };
    throw new Error('secret-nonce-or-request');
  } }, 'source', request);
  assert.equal(result.ok, false);
  assert.equal(result.next, 'check_status_do_not_replay');
  assert.equal(result.diagnostics.job_id, 'job-2');
  assert.equal(methods.includes('Runtime.releaseObject'), false);
  assert.equal(outsideDebug(result).includes('secret'), false);
});

test('invocation keeps a settled Promise when result retrieval fails', async () => {
  const methods = [];
  const result = await callBlockwork({ async send(method) {
    methods.push(method);

    if (method === 'Runtime.evaluate') return { result: { objectId: 'job-unread' } };

    if (method === 'Runtime.getProperties') return { internalProperties: [
      { name: '[[PromiseState]]', value: { value: 'fulfilled' } },
    ] };
    throw new Error('result_transport_failed');
  } }, 'source', request);
  assert.equal(result.diagnostics.job_id, 'job-unread');
  assert.equal(methods.includes('Runtime.releaseObject'), false);
});

test('invocation enforces forty-five seconds without replaying or releasing a pending operation', async () => {
  const compiled = await readFile(new URL('../skills/blockwork/scripts/invoke.mjs', import.meta.url), 'utf8');
  const expression = compiled.replace(/export \{[\s\S]*?\};?\s*$/, '') + '\ncallBlockwork';
  let elapsed = 0;
  const invoke = runInNewContext(expression, {
    Date: class extends Date { static now() { return elapsed; } },
    setTimeout: (callback, milliseconds) => { elapsed += milliseconds; callback(); },
  });

  for (const operation of ['save', 'prepare_save', 'prepare_media', 'prepare_term']) {
    elapsed = 0;
    let evaluations = 0;
    const result = await invoke({ async send(method) {
      if (method === 'Runtime.evaluate') { evaluations++;

        return { result: { objectId: 'job-3' } }; }

      assert.equal(method, 'Runtime.getProperties');

      return { internalProperties: [{ name: '[[PromiseState]]', value: { value: 'pending' } }] };
    } }, 'source', { ...request, operation });
    assert.equal(result.error, 'browser_operation_pending');
    assert.equal(result.diagnostics.elapsed_ms, 45000);
    assert.equal(result.next, operation === 'save' ? 'check_status_do_not_replay' : 'retry');

    if (operation === 'save') assert.equal(result.persistence, 'uncertain');

    if (operation !== 'save') assert.doesNotMatch(result.hint, /receipt|uncertain mutation|Never replay/);
    assert.equal(evaluations, 1);
  }
});

function failingStart(failures, result, methods) {
  let starts = 0;

  return { async send(method) {
    methods.push(method);

    if (method === 'Runtime.evaluate' && starts++ < failures) throw new Error('Target closed while sending secret-request-body');

    if (method === 'Runtime.evaluate') return { result: { objectId: 'job-read' } };

    if (method === 'Runtime.getProperties') return { internalProperties: [
      { name: '[[PromiseState]]', value: { value: 'fulfilled' } },
    ] };

    if (method === 'Runtime.awaitPromise') return { result: { value: result } };

    return {};
  } };
}

test('a read-only failure says to wait and call again and labels the host reason', async () => {
  const methods = [];
  const result = await callBlockwork(failingStart(1, {}, methods), 'source', { operation: 'read' });
  assert.equal(result.error, 'browser_command_failed');
  assert.equal(result.next, 'retry');
  assert.match(result.hint, /Wait a few seconds/);
  assert.deepEqual(result.diagnostics.failure, { source: 'host', error_name: 'Error', reason: 'tab_closed' });
  assert.equal(methods.filter(method => method === 'Runtime.evaluate').length, 1);
  assert.equal(outsideDebug(result).includes('secret'), false);
});

test('lost browser bindings give ordered repair guidance without replaying reads or changes', async () => {
  for (const [operation, next] of [
    ['read', 'rebind_browser'],
    ['inspect_media', 'rebind_browser'],
    ['inspect_terms', 'rebind_browser'],
    ['inspect_abilities', 'rebind_browser'],
    ['prepare_media', 'rebind_browser'],
    ['edit', 'check_status_do_not_replay'],
    ['save', 'check_status_do_not_replay'],
    ['save_resource', 'verify_resource_do_not_replay'],
    ['run_ability', 'report_uncertain_do_not_replay'],
  ]) {
    const methods = [];
    const result = await callBlockwork({ async send(method) {
      methods.push(method);
      throw new Error('Browser is not available: 4 secret-request-body');
    } }, 'source', { operation });
    assert.equal(result.error, 'browser_command_failed');
    assert.equal(result.next, next);
    assert.equal(result.diagnostics.failure.reason, 'browser_unavailable');
    assert.match(result.hint, /cua\.getState\(\).*cua\.getBrowser.*tabs\.get.*documentation\(\).*createBlockwork\(tab\).*reconnect.*status\(\)/);
    assert.match(result.hint, /same editor or admin tab/);
    assert.match(result.hint, /If this caller was connected to a document, reconnect with the original target and workflow, and call status\(\) before any change/);
    assert.match(result.hint, /If this caller was used only for site-targeted operations, resume.*same admin tab.*same site target.*verify_resource first/);
    assert.match(result.hint, /Do not reload or navigate/);
    assert.deepEqual(methods, ['Runtime.evaluate']);
    assert.equal(outsideDebug(result).includes('secret'), false);
    assert.equal(outsideDebug(result).includes('available: 4'), false);
    assert.equal(result.diagnostics.upload_bytes, undefined);
  }
});

test('a native pipe closed before response requires rebinding and preserves resource no-replay guidance', async () => {
  for (const [operation, next] of [
    ['prepare_media', 'rebind_browser'],
    ['save_resource', 'verify_resource_do_not_replay'],
  ]) {
    const methods = [];
    const result = await callBlockwork({ async send(method) {
      methods.push(method);
      throw new Error('native pipe closed before response');
    } }, 'source', { operation });
    assert.equal(result.diagnostics.failure.reason, 'browser_unavailable');
    assert.equal(result.next, next);
    assert.match(result.hint, /cua\.getState\(\).*cua\.getBrowser.*createBlockwork\(tab\)/);
    assert.deepEqual(methods, ['Runtime.evaluate']);

    if (operation === 'save_resource') assert.match(result.hint, /Never replay an uncertain mutation/);
  }
});

test('preparation failures allow a fresh plan without receipts or uncertain-mutation guidance', async () => {
  for (const operation of ['prepare_media', 'prepare_term', 'prepare_save']) {
    for (const stage of ['start', 'poll', 'result']) {
      const methods = [];
      const result = await callBlockwork({ async send(method) {
        methods.push(method);

        if (stage !== 'start' && method === 'Runtime.evaluate') return { result: { objectId: 'prepared-job' } };

        if (stage === 'result' && method === 'Runtime.getProperties') return { internalProperties: [
          { name: '[[PromiseState]]', value: { value: 'fulfilled' } },
        ] };
        throw new Error('Target closed');
      } }, 'source', { operation });
      assert.equal(result.next, 'retry');
      assert.equal(result.diagnostics.stage, stage);
      assert.match(result.hint, /writes no WordPress content/);
      assert.match(result.hint, /before saving; no save was invoked/);
      assert.doesNotMatch(result.hint, /receipt|uncertain mutation|Never replay/);

      if (operation === 'prepare_save') assert.match(result.hint, /status\(\) until busy is false/);
      assert.equal(methods.filter(method => method === 'Runtime.evaluate').length, 1);
      assert.equal(methods.includes('Runtime.releaseObject'), false);
    }
  }
});

test('lost upload preparation reports decoded bytes and observational guidance without exposing payloads', async () => {
  const sizes = [1, 2, 3, 5242880];

  for (const size of sizes) {
    const base64 = Buffer.alloc(size).toString('base64');
    const result = await callBlockwork({ async send() { throw new Error('Browser is not available: 3'); } }, 'source', {
      operation: 'prepare_media',
      upload: { base64, name: 'private-image-name.png', mime_type: 'image/png' },
    });
    assert.equal(result.next, 'rebind_browser');
    assert.equal(result.diagnostics.upload_bytes, size);
    assert.match(result.hint, /Large uploads have coincided.*cause is unknown/);
    assert.match(result.hint, /smaller or recompressed file/);
    assert.doesNotMatch(result.hint, /receipt|Never replay/);
    assert.equal(outsideDebug(result).includes('private-image-name'), false);
    assert.equal('upload' in result, false);
    assert.equal('base64' in result.diagnostics, false);
  }

  for (const upload of [null, {}, { base64: 42 }, { base64: 'invalid-secret' }, { base64: 'A===' }]) {
    const result = await callBlockwork({ async send() { throw new Error('Browser is not available: 5'); } }, 'source', { operation: 'prepare_media', upload });
    assert.equal(result.diagnostics.upload_bytes, undefined);
    assert.doesNotMatch(result.hint, /Large uploads/);
    assert.equal(outsideDebug(result).includes('invalid-secret'), false);
  }
});

test('upload size is checked before any browser command', async () => {
  for (const invoke of [callBlockwork, release.callBlockwork]) {
    const methods = [];
    const capability = settledCapability({ ok: true }, methods);
    const limit = 5242880;
    const upload = { base64: Buffer.alloc(limit).toString('base64') };
    assert.equal((await invoke(capability, 'source', { operation: 'prepare_media', upload })).ok, true);
    assert.equal(methods[0], 'Runtime.evaluate');
    methods.length = 0;

    for (const size of [limit + 1, limit + 2, 7500226]) {
      upload.base64 = Buffer.alloc(size).toString('base64');
      const result = await invoke(capability, 'source', { operation: 'prepare_media', upload });
      assert.equal(result.error, 'upload_too_large');
      assert.equal(result.operation_started, false);
      assert.equal(result.persistence, 'not_attempted');
      assert.equal(result.next, 'correct_request');
      assert.equal(result.diagnostics.path, 'upload.base64');
      assert.match(result.hint, /5 MiB.*Resize or recompress/);
      assert.deepEqual(methods, []);
      assert.equal('upload' in result, false);
    }
  }
});

test('download_media returns a 5 MiB attachment through the invoker unchanged', async () => {
  const upload = { name: 'fixture.png', mime_type: 'image/png', base64: Buffer.alloc(5 * 1024 * 1024, 137).toString('base64') };
  const events = [];
  const downloaded = await callBlockwork(settledCapability({ ok: true, upload }, events), 'source', { operation: 'download_media', target: { site_url: 'https://example.test', user_id: 5 }, id: 20 });
  assert.deepEqual(downloaded, { ok: true, upload });
  assert.equal(events.filter(event => event === 'Runtime.awaitPromise').length, 1);
  assert.equal(events.at(-1), 'Runtime.releaseObject');
});

test('development builds return the host message as debug and release builds omit it', async () => {
  const development = await callBlockwork(failingStart(1, {}, []), 'source', { operation: 'read' });
  assert.equal(development.debug.message, 'Target closed while sending secret-request-body');
  assert.match(development.debug.stack, /invocation\.test\.mjs/);

  const omitted = await release.callBlockwork(failingStart(1, {}, []), 'source', { operation: 'read' });
  assert.equal(release.debug, false);
  assert.equal('debug' in omitted, false);
  assert.deepEqual(omitted.diagnostics.failure, development.diagnostics.failure);
  assert.equal(JSON.stringify(omitted).includes('secret'), false);
  const unavailable = await release.callBlockwork({ async send() {
    throw new Error('Browser is not available: 6 private-browser-details');
  } }, 'source', { operation: 'prepare_media', upload: { base64: 'AAAA' } });
  assert.equal(unavailable.next, 'rebind_browser');
  assert.equal(unavailable.diagnostics.failure.reason, 'browser_unavailable');
  assert.equal(unavailable.diagnostics.upload_bytes, 3);
  assert.equal('debug' in unavailable, false);
  assert.equal(JSON.stringify(unavailable).includes('private-browser-details'), false);
});

test('a mutation that never started says to check status', async () => {
  const methods = [];
  const result = await callBlockwork(failingStart(1, { ok: true }, methods), 'source', { operation: 'edit' });
  assert.equal(result.next, 'check_status_do_not_replay');
  assert.equal(result.diagnostics.failure.reason, 'tab_closed');
  assert.equal(methods.filter(method => method === 'Runtime.evaluate').length, 1);
});

test('an ability run with no result is retryable only when it stated a read', async () => {
  const read = await callBlockwork(failingStart(1, {}, []), 'source', { operation: 'run_ability', effect: 'read' });
  assert.equal(read.next, 'retry');
  const write = await callBlockwork(failingStart(1, {}, []), 'source', { operation: 'run_ability', effect: 'write' });
  assert.equal(write.next, 'report_uncertain_do_not_replay');
  assert.match(write.hint, /outcome is unknown/);
});

test('an engine exception at start is reported as a page failure', async () => {
  const result = await callBlockwork({ async send() {
    return { result: {}, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } } };
  } }, 'source', request);
  assert.deepEqual(result.diagnostics.failure, { source: 'page', reason: 'engine_exception' });
  assert.equal(result.debug.message, 'TypeError: x is not a function');
});

test('a timed-out state check keeps polling the same job until it settles', async () => {
  const methods = [];
  let checks = 0;
  const result = await callBlockwork({ async send(method) {
    methods.push(method);

    if (method === 'Runtime.evaluate') return { result: { objectId: 'job-busy' } };

    if (method === 'Runtime.getProperties' && ++checks < 3) throw new Error('Browser Use CDP command timed out after 10000ms');

    if (method === 'Runtime.getProperties') return { internalProperties: [
      { name: '[[PromiseState]]', value: { value: 'fulfilled' } },
    ] };

    if (method === 'Runtime.awaitPromise' && checks++ === 3) throw new Error('Browser Use CDP command timed out after 10000ms');

    if (method === 'Runtime.awaitPromise') return { result: { value: { ok: true, editor_result: 'applied' } } };

    return {};
  } }, 'source', { operation: 'edit' });
  assert.deepEqual(result, { ok: true, editor_result: 'applied' });
  assert.equal(methods.filter(method => method === 'Runtime.evaluate').length, 1);
  assert.equal(methods.filter(method => method === 'Runtime.awaitPromise').length, 2);
  assert.equal(methods.at(-1), 'Runtime.releaseObject');
});

test('state checks that keep timing out end as pending at the overall limit', async () => {
  const compiled = await readFile(new URL('../skills/blockwork/scripts/invoke.mjs', import.meta.url), 'utf8');
  const expression = compiled.replace(/export \{[\s\S]*?\};?\s*$/, '') + '\ncallBlockwork';
  let elapsed = 0;
  const invoke = runInNewContext(expression, {
    Date: class extends Date { static now() { return elapsed; } },
    setTimeout: (callback, milliseconds) => { elapsed += milliseconds; callback(); },
  });
  const result = await invoke({ async send(method) {
    if (method === 'Runtime.evaluate') return { result: { objectId: 'job-frozen' } };

    elapsed += 10000;
    throw new Error('Browser Use CDP command timed out after 10000ms');
  } }, 'source', { operation: 'edit' });
  assert.equal(result.error, 'browser_operation_pending');
  assert.equal(result.next, 'check_status_do_not_replay');
  assert.equal(result.diagnostics.delayed_checks, 5);
  assert.equal(result.diagnostics.elapsed_ms, 50000);
  assert.equal(result.diagnostics.failure, undefined);
  assert.equal(result.debug.message, 'Browser Use CDP command timed out after 10000ms');
});

test('host failure labels come from known phrases and names only', async () => {
  const cases = [
    [new Error('Browser is not available: 5'), 'Error', 'browser_unavailable'],
    [{ name: 'request-content-secret', message: 'Target closed' }, 'other', 'tab_closed'],
    [new Error('Execution context was destroyed.'), 'Error', 'page_changed'],
    [new Error('Cannot serialize request context'), 'Error', 'unrecognized'],
    [new Error('Failed to read attachment response'), 'Error', 'unrecognized'],
    [new Error('Unable to retrieve original result'), 'Error', 'unrecognized'],
    [new Error('Debugger is not attached to the tab with id: 4'), 'Error', 'debugger_not_attached'],
    [new Error('Circular references are not allowed in JSON'), 'Error', 'unrecognized'],
    [new Error('Permission denied for this origin'), 'Error', 'not_permitted'],
    [new Error('Browser Use CDP command timed out after 10000ms'), 'Error', 'timeout'],
    [new Error('Raw CDP is unavailable while Browser Use is resolving a paused document response.'), 'Error', 'browser_refused'],
    [new Error('Browser Use could not complete this action because a browser security check was unavailable. Reason: blocked.'), 'Error', 'browser_refused'],
    [new Error('Full CDP access is disabled in browser config.'), 'Error', 'browser_refused'],
  ];

  for (const [thrown, name, reason] of cases) {
    const result = await callBlockwork({ async send() { throw thrown; } }, 'source', { operation: 'edit' });
    assert.deepEqual(result.diagnostics.failure, { source: 'host', error_name: name, reason }, thrown.message);
    assert.equal(outsideDebug(result).includes('secret'), false);
  }
});

test('unread host documentation refuses before the request reaches the page and names what to load', async () => {
  const gate = new Error('Required documentation has not been read: "capabilities/tab/cdp". Read the instructions with await agent.documentation.get("capabilities/tab/cdp").');
  const refused = await callBlockwork({ async send() { throw gate; } }, 'source', { operation: 'edit' });
  assert.equal(refused.error, 'documentation_unread');
  assert.equal(refused.operation_started, false);
  assert.equal(refused.next, 'read_documentation');
  assert.deepEqual([...refused.diagnostics.missing], ['cdp']);
  assert.match(refused.hint, /capabilities\.get\("cdp"\)\)\.documentation\(\)/);
  assert.doesNotMatch(refused.hint, /getBrowser/);
  assert.equal(refused.debug.message, gate.message);

  // A tab bound without cua's browser helpers also lacks the browser's own
  // documentation, which holds its confirmation rules.
  const browserGate = new Error('Required documentation has not been read: "confirmations". Read the instructions with await agent.documentation.get("confirmations").');
  const unloaded = await callBlockwork({ async send() { throw browserGate; } }, 'source', { operation: 'connect' });
  assert.deepEqual([...unloaded.diagnostics.missing], ['browser']);
  assert.match(unloaded.hint, /cua\.getBrowser\(\{ id: BROWSER_ID \}\)/);
  assert.doesNotMatch(unloaded.hint, /capabilities\.get/);

  // An unknown document's name stays out of ordinary fields.
  const unknownGate = new Error('Required documentation has not been read: "capabilities/tab/secret-name". Read the instructions with await agent.documentation.get("capabilities/tab/secret-name").');
  const unknown = await callBlockwork({ async send() { throw unknownGate; } }, 'source', { operation: 'connect' });
  assert.deepEqual([...unknown.diagnostics.missing], ['other']);
  assert.match(unknown.hint, /report the refusal/);
  assert.equal(outsideDebug(unknown).includes('secret-name'), false);

  // After the job started, the outcome is unknown like any other host failure.
  const started = await callBlockwork({ async send(method) {
    if (method === 'Runtime.evaluate') return { result: { objectId: 'job-gated' } };

    throw gate;
  } }, 'source', { operation: 'edit' });
  assert.equal(started.error, 'browser_command_failed');
  assert.equal(started.next, 'check_status_do_not_replay');
  assert.equal(started.diagnostics.failure.reason, 'documentation_unread');
});

test('a final browser refusal starts nothing and asks the user instead of retrying', async () => {
  const gate = new Error('Browser Use rejected this action due to browser security policy. Reason: The user declined permission for this action. The agent must not attempt to achieve the same outcome via workaround.');
  const refused = await callBlockwork({ async send() { throw gate; } }, 'source', { operation: 'discover' });
  assert.equal(refused.error, 'browser_access_denied');
  assert.equal(refused.operation_started, false);
  assert.equal(refused.next, 'ask_user');
  assert.match(refused.hint, /Retrying will not help/);
  assert.equal(outsideDebug(refused).includes('declined'), false);
  assert.equal(refused.debug.message, gate.message);
  // After the job started, the outcome is unknown like any other host failure.
  const started = await callBlockwork({ async send(method) {
    if (method === 'Runtime.evaluate') return { result: { objectId: 'job-denied' } };
    throw gate;
  } }, 'source', { operation: 'edit' });
  assert.equal(started.error, 'browser_command_failed');
  assert.equal(started.next, 'check_status_do_not_replay');
  assert.equal(started.diagnostics.failure.reason, 'browser_denied');
});
test('debug details drop credential values and never throw', () => {
  const message = 'Failed: _wpnonce=abc123&page=2 Authorization: Bearer tok.en password: hunter2';
  assert.equal(withDebug({}, new Error(message)).debug.message, 'Failed: _wpnonce=[redacted]&page=2 Authorization: Bearer [redacted] password: [redacted]');

  const cyclic = { code: 'rest_error', data: {} };
  cyclic.data.self = cyclic;
  assert.equal(withDebug({}, cyclic).debug.data, 'unreadable');
  assert.deepEqual(withDebug({}, { get message() { throw new Error('getter'); } }).debug, { value: 'unreadable' });
  assert.deepEqual(withDebug({ ok: false }, undefined), { ok: false });
});
