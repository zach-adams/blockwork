import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixture } from '../../tools/playground.mjs';
import { adminPage, executions, marker, wordpress } from '../helpers/abilities-page.mjs';

// Development builds put the underlying message in debug; nothing else may echo it.
function outsideDebug(result) {
  return JSON.stringify({ ...result, debug: undefined });
}

test('abilities run through real WordPress routes with the effect, method, and input core requires', async () => {
  const fixture = await startFixture(false, '7.1.4', true);

  try {
    const admin = await adminPage(fixture, 'admin');
    const post_id = fixture.state.documents.roundtrip.post_id;
    // Listing: schemas stay on the server, hidden and unregistered abilities are absent.
    const list = await admin.inspect();
    assert.equal(list.ok, true, JSON.stringify(list));
    const effects = Object.fromEntries(list.abilities.map((ability) => [ability.name, ability.effect]));
    assert.equal(effects['core/get-site-info'], 'read');
    assert.deepEqual(
      ['echo', 'large-output', 'set-marker', 'configure', 'state', 'unannotated', 'broken-output', 'fail', 'nonce-error', 'denied'].map((name) => effects[`blockwork-fixture/${name}`]),
      ['read', 'read', 'write', 'write', 'read', 'destructive', 'write', 'write', 'write', 'read'],
    );
    assert.equal(list.abilities.some((ability) => /^blockwork-(seo|fields)\//.test(ability.name)), false);
    assert.equal(admin.raw.at(-1).body.includes('input_schema'), false);
    const echoed = list.abilities.find((ability) => ability.name === 'blockwork-fixture/echo');
    assert.equal(echoed.description.length, 200);
    assert.equal(JSON.stringify(list).includes('FIXTURE-DESCRIPTION-END'), false);

    const detail = await admin.inspect({ name: 'blockwork-fixture/echo' });
    assert.match(detail.ability.description, /FIXTURE-DESCRIPTION-END$/);
    assert.equal(detail.ability.input_schema.properties.nested.type, 'object');

    // A read: nested input crosses the query string and core restores its types.
    const input = { text: 'héllo wörld & more=?', count: 3, flag: true, list: [1, 2], nested: { label: 'x', items: ['a', 'b c'] } };
    const read = await admin.run('blockwork-fixture/echo', 'read', input);
    assert.deepEqual([read.ok, read.effect, read.output?.input], [true, 'read', input], JSON.stringify(read));
    assert.deepEqual([read.output.types.count, read.output.types.flag], ['integer', 'boolean']);
    assert.equal((await admin.run('core/get-site-info', 'read')).ok, true);

    // A write, the ability's own failure inside a successful answer, and a refused effect.
    const written = await admin.run('blockwork-fixture/set-marker', 'write', { value: 'first' });
    assert.deepEqual([written.ok, written.effect, written.output?.success], [true, 'write', true], JSON.stringify(written));
    assert.equal(await marker(fixture), 'first');
    const rejected = await admin.run('blockwork-fixture/set-marker', 'write', { value: 'reject' });
    assert.deepEqual([rejected.ok, rejected.output.success], [true, false]);
    const mismatch = await admin.run('blockwork-fixture/set-marker', 'read', { value: 'second' });
    assert.deepEqual([mismatch.error, mismatch.diagnostics.declared_effect, mismatch.persistence], ['ability_effect_mismatch', 'write', 'not_attempted']);
    const undeclared = await admin.run('blockwork-fixture/unannotated', 'destructive');
    assert.deepEqual([undeclared.ok, undeclared.output?.counter], [true, 1], JSON.stringify(undeclared));

    // Input that breaks the schema WordPress published never leaves the page.
    const requests = admin.raw.length;
    const invalid = await admin.run('blockwork-fixture/set-marker', 'write', { value: 5 });
    assert.deepEqual([invalid.error, invalid.diagnostics, invalid.persistence, invalid.next],
      ['ability_input_rejected', { path: 'input.value', constraint: 'type', expected_type: 'string' }, 'not_attempted', 'correct_request'], JSON.stringify(invalid));
    assert.equal(admin.raw.slice(requests).some((request) => request.url.includes('/run')), false);

    // A rule only WordPress can apply is still its refusal, and so is any
    // input sent with the check skipped. Once a change is sent that refusal is
    // uncertain, though here the ability never ran.
    for (const [input, extra] of [[{ value: 'coded', code: 'UPPER' }, {}], [{ value: 5 }, { skip_input_check: true }]]) {
      const judged = await admin.run('blockwork-fixture/set-marker', 'write', input, extra);
      assert.deepEqual([judged.error, judged.diagnostics, judged.persistence, judged.next],
        ['ability_failed', { ability_error: 'ability_invalid_input', status: 400 }, 'uncertain', 'report_uncertain_do_not_replay'], JSON.stringify(judged));
    }

    assert.deepEqual([await marker(fixture), await executions(fixture, 'blockwork-fixture/set-marker')], ['first', 2]);

    // An ability that answers with the invalid-nonce error ran once. Core's
    // parsed apiFetch would refresh its nonce and send the run a second time.
    const stale = await admin.run('blockwork-fixture/nonce-error', 'write');
    assert.deepEqual([stale.error, stale.diagnostics, stale.persistence],
      ['ability_failed', { ability_error: 'rest_cookie_invalid_nonce', status: 403 }, 'uncertain'], JSON.stringify(stale));
    assert.equal(await executions(fixture, 'blockwork-fixture/nonce-error'), 1);
    assert.equal(/private nonce/i.test(outsideDebug(stale)), false);

    // Failures after the ability ran: only the site's error code comes back.
    const broken = await admin.run('blockwork-fixture/broken-output', 'write');
    assert.deepEqual([broken.error, broken.diagnostics.ability_error, broken.persistence, broken.next],
      ['ability_failed', 'ability_invalid_output', 'uncertain', 'report_uncertain_do_not_replay'], JSON.stringify(broken));
    assert.equal(await wordpress(fixture, "get_option('blockwork_fixture_broken')"), 'written');
    const failed = await admin.run('blockwork-fixture/fail', 'write', { status: 503 });
    assert.deepEqual([failed.error, failed.diagnostics, failed.persistence],
      ['ability_failed', { ability_error: 'blockwork_fixture_failed', status: 503 }, 'uncertain'], JSON.stringify(failed));
    assert.equal(/private detail/i.test(outsideDebug(failed)), false);
    const denied = await admin.run('blockwork-fixture/denied', 'read');
    assert.deepEqual([denied.error, denied.diagnostics, denied.persistence],
      ['ability_failed', { ability_error: 'blockwork_fixture_denied', status: 403 }, 'not_attempted'], JSON.stringify(denied));
    assert.equal(/private denial/i.test(outsideDebug(denied)), false);
    const large = await admin.run('blockwork-fixture/large-output', 'read', { bytes: 100000 });
    assert.deepEqual([large.ok, large.output_omitted, 'output' in large], [true, 'too_large', false]);
    assert.ok(large.output_bytes > 100000);

    // SEOPress keeps abilities registered but hidden; ACF leaves them unregistered. Both look absent.
    for (const name of ['blockwork-seo/get-post-title-description', 'blockwork-fields/books']) {
      const hidden = await admin.run(name, 'read', { post_id });
      assert.deepEqual([hidden.error, hidden.persistence], ['ability_unavailable', 'not_attempted'], JSON.stringify(hidden));
    }

    const configured = await admin.run('blockwork-fixture/configure', 'write', { seo_exposed: true, fields_enabled: true });
    assert.deepEqual(configured.output, { seo_exposed: true, fields_enabled: true }, JSON.stringify(configured));
    const exposed = (await admin.inspect()).abilities;
    const effect = (name) => exposed.find((ability) => ability.name === name)?.effect;

    // SEOPress marks its updates destructive and idempotent, which core routes
    // through DELETE with the input in the query string.
    assert.equal(effect('blockwork-seo/update-post-title-description'), 'destructive');
    const seo = await admin.run('blockwork-seo/update-post-title-description', 'destructive', { post_id, title: 'SEO title', description: 'SEO & description' });
    assert.equal(seo.ok, true, JSON.stringify(seo));
    assert.deepEqual([admin.raw.at(-1).method, admin.raw.at(-1).override], ['POST', 'DELETE']);
    assert.match(admin.raw.at(-1).url, /\/run\?input%5Bpost_id%5D=/);
    const stored = await admin.run('blockwork-seo/get-post-title-description', 'read', { post_id });
    assert.deepEqual([stored.output.title, stored.output.description], ['SEO title', 'SEO & description']);

    for (const noindex of [true, false]) {
      const robots = await admin.run('blockwork-seo/update-post-robots-settings', 'destructive', { post_id, noindex });
      assert.equal(robots.output?.noindex, noindex, JSON.stringify(robots));
    }

    // An empty list fits the schema, but the query string would drop it and
    // the ability would list its default post types instead.
    const dropped = await admin.run('blockwork-seo/list-posts-missing-metadata', 'read', { post_types: [] });
    assert.deepEqual([dropped.error, dropped.diagnostics.path, dropped.persistence],
      ['ability_query_input_unsupported', 'input.post_types', 'not_attempted'], JSON.stringify(dropped));
    const missing = await admin.run('blockwork-seo/list-posts-missing-metadata', 'read', { post_types: ['page'], missing: ['title'], per_page: 5 });
    assert.equal(missing.ok && Array.isArray(missing.output.items), true, JSON.stringify(missing));
    assert.equal(missing.output.items.some((item) => item.post_id === post_id), false);
    const absent = await admin.run('blockwork-seo/get-post-title-description', 'read', { post_id: 999999 });
    assert.deepEqual([absent.error, absent.diagnostics, absent.persistence],
      ['ability_failed', { ability_error: 'blockwork_seo_post_not_found', status: 404 }, 'not_attempted'], JSON.stringify(absent));

    // ACF generates abilities per post type and runs them through an inner REST request.
    assert.deepEqual(['books', 'create-book', 'update-book', 'delete-book'].map((name) => effect(`blockwork-fields/${name}`)),
      ['read', 'write', 'write', 'destructive']);
    const fields = { isbn: '978-3-16-148410-0', rating: 4, featured: true, tags: ['one', 'two words'], dimensions: { width: 12.5, height: 20 } };
    // Nested field values are checked against the schema before anything is sent.
    const overrated = await admin.run('blockwork-fields/create-book', 'write', { title: 'Fixture book', fields: { ...fields, rating: 9 } });
    assert.deepEqual([overrated.error, overrated.diagnostics, overrated.persistence],
      ['ability_input_rejected', { path: 'input.fields.rating', constraint: 'maximum' }, 'not_attempted'], JSON.stringify(overrated));
    assert.equal(await executions(fixture, 'blockwork-fields/create-book'), 0);
    const book = await admin.run('blockwork-fields/create-book', 'write', { title: 'Fixture book', fields });
    assert.deepEqual([book.ok, book.output?.status, book.output?.fields], [true, 'draft', fields], JSON.stringify(book));
    const updated = await admin.run('blockwork-fields/update-book', 'write', { id: book.output.id, fields: { rating: 5 } });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const viewed = await admin.run('blockwork-fields/view-book', 'read', { id: book.output.id });
    assert.deepEqual(viewed.output.fields, { ...fields, rating: 5 });
    const trashed = await admin.run('blockwork-fields/delete-book', 'destructive', { id: book.output.id, force: false });
    assert.deepEqual([trashed.output?.trashed, trashed.output?.deleted], [true, false], JSON.stringify(trashed));
    assert.equal(await wordpress(fixture, `get_post_status(${book.output.id})`), 'trash');
    // An inner REST error comes from the ability's own code.
    const gone = await admin.run('blockwork-fields/delete-book', 'destructive', { id: 999999, force: true });
    assert.deepEqual([gone.error, gone.diagnostics, gone.persistence],
      ['ability_failed', { ability_error: 'rest_post_invalid_id', status: 404 }, 'uncertain'], JSON.stringify(gone));

    // A user without the capability can list. A refused read is plain; a
    // refused change is uncertain, though here nothing executed.
    const subscriber = await adminPage(fixture, 'subscriber');
    assert.equal((await subscriber.inspect()).ok, true);
    const unread = await subscriber.run('core/get-site-info', 'read');
    assert.deepEqual([unread.error, unread.persistence], ['ability_forbidden', 'not_attempted'], JSON.stringify(unread));
    const forbidden = await subscriber.run('blockwork-fixture/set-marker', 'write', { value: 'subscriber' });
    assert.deepEqual([forbidden.error, forbidden.diagnostics, forbidden.persistence],
      ['ability_failed', { ability_error: 'rest_ability_cannot_execute', status: 403 }, 'uncertain'], JSON.stringify(forbidden));
    assert.equal(await executions(fixture, 'blockwork-fixture/set-marker'), 2);

    // A change that outlasts its wait is reported uncertain, and here it did land.
    // The 30-second wait is shortened; the ability sleeps past it before writing.
    const impatient = await adminPage(fixture, 'admin', { timeout: (ms) => AbortSignal.timeout(ms === 30000 ? 1500 : ms) });
    const late = await impatient.run('blockwork-fixture/set-marker', 'write', { value: 'late', delay_ms: 4000 });
    assert.deepEqual([late.error, late.persistence, late.next, late.diagnostics.request],
      ['request_timeout', 'uncertain', 'report_uncertain_do_not_replay', 'POST /wp-abilities/v1/abilities/:id'], JSON.stringify(late));

    for (let waited = 0; waited < 20 && (await marker(fixture)) !== 'late'; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    assert.deepEqual([await marker(fixture), await executions(fixture, 'blockwork-fixture/set-marker')], ['late', 3]);
    // The fixture reports the same through an ability, for a desktop run to read.
    const state = await admin.run('blockwork-fixture/state', 'read');
    assert.deepEqual([state.output?.marker, state.output?.calls['blockwork-fixture/set-marker'], state.output?.calls['blockwork-fixture/nonce-error']],
      ['late', 3, 1], JSON.stringify(state));

    // The reason runs go out unparsed: through core's parsed apiFetch, the
    // ability that answers with the nonce error runs again and again. Last,
    // because these runs outlive the call and race the execution log.
    await admin.evaluate(`wp.apiFetch({ path: '/wp-abilities/v1/abilities/blockwork-fixture/nonce-error/run',
      method: 'POST', signal: AbortSignal.timeout(2500) }).catch(() => undefined)`);
    assert.ok((await executions(fixture, 'blockwork-fixture/nonce-error')) > 2);
  } finally {
    await fixture.cli[Symbol.asyncDispose]();
  }
});
