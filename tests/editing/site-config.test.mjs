import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

import { doc, paragraph } from './blocks.mjs';
import {
  assertRefused,
  assertSavedCleanly,
  seedDocument,
  startEditingSite,
  storedDocument,
  waitFor,
  withDocument,
} from './harness.mjs';

let site;
const { after, before, test, run } = editingTests(import.meta.url);

before(async () => {
  site = await startEditingSite();
});
after(() => site?.[Symbol.asyncDispose]());

async function completeCycle(seed = {}) {
  await withDocument(
    site,
    { content: doc(paragraph('Before')), ...seed },
    async ({ blockwork, id, before }) => {
      const edit = await blockwork.edit({
        edits: [
          { op: 'update', path: [0], name: 'core/paragraph', attributes: { content: 'After' } },
        ],
      });
      assert.equal(edit.ok, true, JSON.stringify(edit));
      const saved = await blockwork.save();
      await assertSavedCleanly(site, id, before, saved);
      assert.equal((await storedDocument(site, id)).content, doc(paragraph('After')));
    },
  );
}

test('all gettext strings translated permit a complete edit', async () => {
  await site.php(`update_option('bw_test_translate_all', 1);`);

  try {
    await completeCycle();
  } finally {
    await site.php(`delete_option('bw_test_translate_all');`);
  }
});

test('static front and posts pages retain their reading assignments', async () => {
  const front = await seedDocument(site, { content: doc(paragraph('Before')) });
  const posts = await seedDocument(site, { content: '' });
  await site.php(
    `update_option('show_on_front','page'); update_option('page_on_front',${front}); update_option('page_for_posts',${posts});`,
  );

  try {
    await completeCycle();
    assert.deepEqual(
      await site.php(
        `echo wp_json_encode([(int)get_option('page_on_front'),(int)get_option('page_for_posts')]);`,
      ),
      [front, posts],
    );
  } finally {
    await site.php(
      `update_option('show_on_front','posts'); delete_option('page_on_front'); delete_option('page_for_posts');`,
    );
  }
});

test('scheduled date fourteen hours ahead survives editing', async () => {
  await site.php(`update_option('timezone_string','Pacific/Kiritimati');`);

  try {
    await completeCycle({
      status: 'future',
      extra: { post_date: '2030-01-02 12:00:00', post_date_gmt: '2030-01-01 22:00:00' },
    });
  } finally {
    await site.php(`update_option('timezone_string','');`);
  }
});

test('WordPress below the minimum refuses with repair guidance', async () => {
  const legacy = await startEditingSite({ version: '6.9' });

  try {
    await withDocument(
      legacy,
      { content: doc(paragraph('Before')) },
      async ({ doc: result, id, before }) => {
        await assertRefused(legacy, id, before, result, { error: 'wordpress_unsupported' });
      },
      { connected: false },
    );
  } finally {
    await legacy[Symbol.asyncDispose]();
  }
});

for (const structure of ['', '/%postname%/', '/index.php/%postname%/']) {
  test(`edit and save with permalink structure ${structure || 'plain'}`, async () => {
    const original = await site.php(`echo wp_json_encode(get_option('permalink_structure'));`);
    await site.php(`update_option('permalink_structure', ${JSON.stringify(structure)});`);

    try {
      await withDocument(
        site,
        { content: doc(paragraph('Before')) },
        async ({ blockwork, id, before }) => {
          const result = await blockwork.edit({
            edits: [
              { op: 'update', path: [0], name: 'core/paragraph', attributes: { content: 'After' } },
            ],
          });
          assert.equal(result.ok, true, JSON.stringify(result));
          const saved = await blockwork.save();
          await assertSavedCleanly(site, id, before, saved);
          assert.equal((await storedDocument(site, id)).content, doc(paragraph('After')));
        },
      );
    } finally {
      await site.php(`update_option('permalink_structure', ${JSON.stringify(original)});`);
    }
  });
}

test('empty site title and unusual reading settings do not prevent editing', async () => {
  const settings = await site.php(
    `echo wp_json_encode(['name' => get_option('blogname'), 'count' => get_option('posts_per_page'), 'timezone' => get_option('timezone_string')]);`,
  );
  await site.php(
    `update_option('blogname', ''); update_option('posts_per_page', 500); update_option('timezone_string', 'Pacific/Kiritimati');`,
  );

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, id, before }) => {
        assert.equal(
          (
            await blockwork.edit({
              edits: [
                {
                  op: 'update',
                  path: [0],
                  name: 'core/paragraph',
                  attributes: { content: 'After' },
                },
              ],
            })
          ).ok,
          true,
        );
        await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.equal((await storedDocument(site, id)).content, doc(paragraph('After')));
      },
    );
  } finally {
    await site.php(
      `$s = json_decode(base64_decode('${Buffer.from(JSON.stringify(settings)).toString('base64')}'), true); update_option('blogname', $s['name']); update_option('posts_per_page', $s['count']); update_option('timezone_string', $s['timezone']);`,
    );
  }
});

test('a translated admin label does not prevent a complete edit', async () => {
  await site.php(`update_option('bw_test_translate', 1);`);

  try {
    await withDocument(
      site,
      { content: doc(paragraph('Before')) },
      async ({ blockwork, id, before }) => {
        assert.equal(
          (
            await blockwork.edit({
              edits: [
                {
                  op: 'update',
                  path: [0],
                  name: 'core/paragraph',
                  attributes: { content: 'After' },
                },
              ],
            })
          ).ok,
          true,
        );
        await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.equal((await storedDocument(site, id)).content, doc(paragraph('After')));
      },
    );
  } finally {
    await site.php(`delete_option('bw_test_translate');`);
  }
});

for (const version of ['7.0.0', '7.0.8', '7.1.4']) {
  test(`a complete edit on WordPress ${version}`, async () => {
    const versionSite = await startEditingSite({ version });

    try {
      assert.equal(versionSite.fixture.state.wordpress, version === '7.0.0' ? '7.0' : version);
      await withDocument(
        versionSite,
        { content: doc(paragraph('Before')) },
        async ({ blockwork, id, before }) => {
          assert.equal(
            (
              await blockwork.edit({
                edits: [
                  {
                    op: 'update',
                    path: [0],
                    name: 'core/paragraph',
                    attributes: { content: 'After' },
                  },
                ],
              })
            ).ok,
            true,
          );
          await assertSavedCleanly(versionSite, id, before, await blockwork.save());
          assert.equal((await storedDocument(versionSite, id)).content, doc(paragraph('After')));
        },
      );
    } finally {
      await versionSite[Symbol.asyncDispose]();
    }
  });
}

for (const theme of ['classic', 'hybrid']) {
  test(`${theme} theme supports native template metadata and saving`, async () => {
    const original = await site.php(`echo wp_json_encode(get_stylesheet());`);
    await site.php(
      `$dir=WP_CONTENT_DIR.'/themes/fixture-${theme}'; wp_mkdir_p($dir); file_put_contents($dir.'/style.css','/* Theme Name: Fixture ${theme} */'); file_put_contents($dir.'/index.php','<?php while(have_posts()) { the_post(); the_content(); }'); file_put_contents($dir.'/fixture.php','<?php /* Template Name: Fixture page */ while(have_posts()) { the_post(); the_content(); }'); wp_clean_themes_cache(); switch_theme('fixture-${theme}');`,
    );

    if (theme === 'hybrid') {
      await site.php(
        `file_put_contents(WP_CONTENT_DIR.'/themes/fixture-hybrid/theme.json', wp_json_encode(['version'=>3,'settings'=>['appearanceTools'=>true]]));`,
      );
    }

    try {
      await completeCycle({ meta: { _wp_page_template: 'fixture.php' } });
    } finally {
      await site.php(`switch_theme(${JSON.stringify(original)});`);
    }
  });
}

test('custom REST prefix works with query-string REST routing', async () => {
  await site.php(
    `update_option('bw_test_rest_prefix',1); update_option('permalink_structure','');`,
  );

  try {
    assert.match(await site.php(`echo wp_json_encode(rest_url('wp/v2/pages'));`), /rest_route=/);
    await completeCycle();
  } finally {
    await site.php(`delete_option('bw_test_rest_prefix');`);
  }
});

test('disabled revisions, restricted HTML and frequent autosaving permit ordinary text saves', async () => {
  const original = await site.php(
    `echo wp_json_encode(file_get_contents(ABSPATH.'wp-config.php'));`,
  );
  await site.php(
    `$p=ABSPATH.'wp-config.php'; $s=file_get_contents($p); $s=str_replace('<?php', '<?php define("WP_POST_REVISIONS",false); define("DISALLOW_UNFILTERED_HTML",true); define("AUTOSAVE_INTERVAL",5);', $s); file_put_contents($p,$s);`,
  );

  try {
    assert.deepEqual(
      await site.php(
        `echo wp_json_encode([WP_POST_REVISIONS,DISALLOW_UNFILTERED_HTML,AUTOSAVE_INTERVAL]);`,
      ),
      [false, true, 5],
    );
    await completeCycle();
  } finally {
    await site.php(
      `file_put_contents(ABSPATH.'wp-config.php',base64_decode('${Buffer.from(original).toString('base64')}'));`,
    );
  }
});

test('insecure non-loopback origin refuses with an explicit crypto prerequisite', async () => {
  const previous = process.env.AGENT_BROWSER_ARGS;
  process.env.AGENT_BROWSER_ARGS = '--host-resolver-rules=MAP fixture.example.test 127.0.0.1';
  let insecure;

  try {
    insecure = await startEditingSite();
    const url = new URL(insecure.site);
    url.hostname = 'fixture.example.test';
    const origin = url.origin;
    await insecure.php(
      `update_option('bw_test_installation_url', '${origin}'); update_option('siteurl', '${origin}'); update_option('home', '${origin}');`,
    );
    assert.equal(await insecure.php(`echo wp_json_encode(site_url());`), origin);
    const id = await seedDocument(insecure, { content: doc(paragraph('Before')) });
    const tab = await insecure.openTab('about:blank');

    try {
      const cookies = (await insecure.authCookies()).map((cookie) => ({
        ...cookie,
        domain: url.hostname,
      }));
      await tab.cdp.send('Network.setCookies', { cookies });
      await tab.goto(`${origin}/wp-admin/post.php?post=${id}&action=edit`);
      await waitFor(
        insecure,
        tab,
        `document.readyState === 'complete' && location.hostname === 'fixture.example.test'`,
      );
      assert.equal(await insecure.evaluate(tab, 'window.isSecureContext'), false);
      assert.equal(await insecure.evaluate(tab, 'new URL(wpApiSettings.root).origin'), origin);
      assert.deepEqual(
        await insecure.evaluate(tab, '[typeof crypto.randomUUID, typeof crypto.subtle]'),
        ['undefined', 'undefined'],
      );
      const caller = await insecure.createCaller(tab);
      const result = await caller.connect({
        target: { site_url: origin, post_id: id, post_type: 'page' },
        workflow: 'background',
      });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.ok(result.hint && result.next, JSON.stringify(result));
      assert.match(result.hint, /secure|crypto|HTTPS/i, JSON.stringify(result));
    } finally {
      await tab.close();
    }
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_BROWSER_ARGS;
    } else {
      process.env.AGENT_BROWSER_ARGS = previous;
    }

    await insecure?.[Symbol.asyncDispose]();
  }
});

test(
  'a subdirectory installation with a different public home',
  {
    skip: 'The harness fixes Playground installation at the server root. A loopback proxy with verified site_url/home_url overrides still receives native 302 redirects from /cms/wp-admin to /wp-admin, then 404 before Gutenberg loads. This needs an installation URL/document-root setting at fixture startup.',
  },
  () => {},
);

test('a custom REST prefix works through pretty REST routes', async () => {
  const original = await site.php(`echo wp_json_encode(get_option('permalink_structure'));`);
  await site.php(
    `update_option('bw_test_rest_prefix',1); update_option('permalink_structure','/%postname%/');`,
  );
  await site.php(`flush_rewrite_rules(false);`);

  try {
    assert.equal(
      new URL(await site.php(`echo wp_json_encode(rest_url('wp/v2/pages'));`)).pathname,
      '/fixture-api/wp/v2/pages',
    );
    await completeCycle();
  } finally {
    await site.php(
      `delete_option('bw_test_rest_prefix'); update_option('permalink_structure', ${JSON.stringify(original)});`,
    );
    await site.php(`flush_rewrite_rules(false);`);
  }
});

test('a real language pack or complete gettext fallback permits a full cycle', async (t) => {
  const installed = await site.php(
    `require_once ABSPATH.'wp-admin/includes/admin.php'; require_once ABSPATH.'wp-admin/includes/translation-install.php'; $result=wp_download_language_pack('de_DE'); echo wp_json_encode($result === 'de_DE');`,
  );
  const original = await site.php(`echo wp_json_encode(get_option('WPLANG'));`);

  if (installed) {
    await site.php(`update_option('WPLANG','de_DE');`);
  } else {
    t.diagnostic(
      'The native language-pack installer returned false in Playground; using the complete gettext fixture.',
    );
    await site.php(`update_option('bw_test_translate_all',1);`);
  }

  try {
    await completeCycle();
  } finally {
    await site.php(
      `update_option('WPLANG', ${JSON.stringify(original)}); delete_option('bw_test_translate_all');`,
    );
  }
});

test(
  'multisite unfiltered_html capabilities',
  {
    skip: 'Playground enableMultisite rejects custom URL ports. This harness always allocates a random port; a default-port fixture is required.',
  },
  () => {},
);

run();
