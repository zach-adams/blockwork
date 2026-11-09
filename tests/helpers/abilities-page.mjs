import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { bundles } from '../../tools/bundle.mjs';

const { editor: source } = await bundles({ debug: true });

// A signed-in wp-admin page as the engine sees it. WordPress's own scripts
// provide wp.url and wp.apiFetch, set up as wp-admin sets them up, so method
// overrides, error parsing, and the nonce retry are core's. Only the browser is
// replaced: `fetch` adds the login cookie a browser would send, and `raw` keeps
// each request and response body for transport assertions.
export async function adminPage(fixture, account, signals = AbortSignal) {
  const site = fixture.target.site_url;
  const username = account === 'admin' ? 'admin' : `blockwork_${account}`;
  // A fresh site answers its first request with a redirect and no session.
  await fetch(`${site}/wp-login.php`);
  const login = await fetch(`${site}/wp-login.php`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'wordpress_test_cookie=WP%20Cookie%20check' },
    body: new URLSearchParams({ log: username, pwd: fixture.password, testcookie: '1' }),
  });
  const cookie = login.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  assert.match(cookie, /wordpress_logged_in_/, `${username} did not sign in`);
  const text = async (path) => (await fetch(`${site}${path}`, { headers: { cookie } })).text();
  const nonce_url = `${site}/wp-admin/admin-ajax.php?action=rest-nonce`;
  const nonce = await (await fetch(nonce_url, { headers: { cookie } })).text();
  const page = { raw: [] };
  // One realm holds WordPress's scripts and the engine, as one page does.
  // wp.url nests only plain objects of its own realm.
  const window = { URL, URLSearchParams, TextEncoder, Response, Headers, FormData, crypto, AbortSignal: signals,
    setTimeout, clearTimeout, Date, navigator: { onLine: true },
    location: new URL(`${site}/wp-admin/index.php`), document: { visibilityState: 'visible', readyState: 'complete',
      body: { className: `version-${fixture.state.wordpress.replaceAll('.', '-')}` } } };
  window.window = window;

  window.fetch = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { ...options.headers, cookie } });
    page.raw.push({ url: String(url), method: options.method ?? 'GET',
      override: options.headers?.['X-HTTP-Method-Override'], body: await response.clone().text() });

    return response;
  };

  const realm = createContext(window);

  for (const script of ['hooks', 'i18n', 'private-apis', 'url', 'api-fetch']) {
    runInContext(await text(`/wp-includes/js/dist/${script}.min.js`), realm);
  }

  // wp-admin's own inline setup for wp-api-fetch.
  runInContext(`
    wp.apiFetch.use(wp.apiFetch.createRootURLMiddleware(${JSON.stringify(`${site}/wp-json/`)}));
    wp.apiFetch.nonceMiddleware = wp.apiFetch.createNonceMiddleware(${JSON.stringify(nonce)});
    wp.apiFetch.use(wp.apiFetch.nonceMiddleware);
    wp.apiFetch.use(wp.apiFetch.mediaUploadMiddleware);
    wp.apiFetch.nonceEndpoint = ${JSON.stringify(nonce_url)};
  `, realm);
  window.engine = runInContext(source, realm);
  // The host passes each request as source text, so its objects belong to the page.
  const invoke = (request) => runInContext(`engine(${JSON.stringify(request)})`, realm);
  const target = { site_url: site, user_id: fixture.state.accounts[account] };
  // The engine's objects come from another realm, so compare their JSON form.
  const plain = async (request) => JSON.parse(JSON.stringify(await invoke({ ...request, target })));
  page.evaluate = (expression) => runInContext(expression, realm);
  page.inspect = (extra = {}) => plain({ operation: 'inspect_abilities', ...extra });
  page.run = (name, effect, input, extra = {}) => plain({ operation: 'run_ability', name, effect, input, ...extra });

  return page;
}

export async function wordpress(fixture, code) {
  const result = await fixture.cli.playground.run({ code: `<?php require '/wordpress/wp-load.php'; echo json_encode(${code});` });
  assert.equal(result.exitCode, 0, result.errors);

  return result.json;
}

// How often each ability that is not read-only has executed.
export async function executions(fixture, name) {
  const calls = await wordpress(fixture, "get_option('blockwork_fixture_calls', [])");

  return calls.filter((item) => item === name).length;
}

export const marker = (fixture) => wordpress(fixture, "get_option('blockwork_fixture_marker')");
