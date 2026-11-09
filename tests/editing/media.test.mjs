import assert from 'node:assert/strict';
import { editingTests } from './cases.mjs';

import { doc, paragraph } from './blocks.mjs';
import {
  assertRefused,
  assertSavedCleanly,
  seedDocument,
  seedImage,
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

const check = (result) => assert.equal(result.ok, true, JSON.stringify(result));
const refusal = (result) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.error && result.hint && result.next, JSON.stringify(result));
};

async function adminCaller(body) {
  const tab = await site.openTab(`${site.site}/wp-admin/upload.php`);
  await waitFor(site, tab, '!!window.wp?.apiFetch');
  const caller = await site.createCaller(tab);

  try {
    return await body(caller);
  } finally {
    await tab.close();
  }
}

test('inspect media by search, ID, IDs and type', async () => {
  const image = await seedImage(site, {
    name: 'inspection-image',
    title: 'Inspection image',
    alt: 'Example alt',
  });
  await adminCaller(async (caller) => {
    const target = { site_url: site.site };
    const one = await caller.call({ operation: 'inspect_media', target, id: image.id });
    check(one);
    assert.equal(one.record.id, image.id);
    assert.equal(one.record.alt_text, 'Example alt');
    const many = await caller.call({ operation: 'inspect_media', target, ids: [image.id, 999999] });
    check(many);
    assert.deepEqual(
      many.records.map((record) => record.id),
      [image.id],
    );
    assert.deepEqual(many.missing, [999999]);
    const search = await caller.call({
      operation: 'inspect_media',
      target,
      search: 'Inspection image',
      media_type: 'image',
    });
    check(search);
    assert.ok(search.records.some((record) => record.id === image.id));
    assert.equal(search.records[0].media_details, undefined);
    const empty = await caller.call({
      operation: 'inspect_media',
      target,
      search: 'nothing-matches-this-name',
    });
    check(empty);
    assert.deepEqual(empty.records, []);
    const applications = await caller.call({
      operation: 'inspect_media',
      target,
      media_type: 'application',
    });
    check(applications);
    assert.ok(applications.records.every((record) => record.media_type === 'application'));
  });
});

test('upload a real PNG, verify it and inspect resource status', async () => {
  const image = await seedImage(site, { name: 'upload-source', width: 40, height: 40 });
  const parent = await seedDocument(site, { content: doc(paragraph('Media parent')) });
  await adminCaller(async (caller) => {
    const target = { site_url: site.site, user_id: 1 };
    const downloaded = await caller.call({ operation: 'download_media', target, id: image.id });
    check(downloaded);
    const prepared = await caller.call({
      operation: 'prepare_media',
      target,
      upload: { ...downloaded.upload, name: 'image with spaces.png' },
      fields: {
        slug: 'upload-with-spaces',
        title: 'Uploaded title',
        alt: 'Uploaded alt',
        caption: 'Uploaded caption',
        description: 'Uploaded description',
        parent_id: parent,
      },
    });
    check(prepared);
    const saved = await caller.call({
      operation: 'save_resource',
      target,
      receipt: prepared.receipt,
    });
    check(saved);
    assert.equal(saved.persistence, 'verified');
    assert.equal(saved.record.title.raw, 'Uploaded title');
    assert.equal(saved.record.alt_text, 'Uploaded alt');
    assert.equal(saved.record.caption.raw, 'Uploaded caption');
    assert.equal(saved.record.description.raw, 'Uploaded description');
    assert.equal(saved.record.post, parent);
    const verified = await caller.call({
      operation: 'verify_resource',
      target,
      receipt: prepared.receipt,
      resource_id: saved.resource_id,
    });
    check(verified);
    assert.equal(verified.persistence, 'verified');
    const status = await caller.call({ operation: 'resource_status', target });
    check(status);
    assert.equal(status.busy, false);
  });
});

test('unsupported SVG and empty uploads refuse with guidance', async () => {
  for (const upload of [
    {
      name: 'image.svg',
      mime_type: 'image/svg+xml',
      base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'),
    },
    { name: 'empty.png', mime_type: 'image/png', base64: '' },
  ]) {
    await adminCaller(async (caller) => {
      const target = { site_url: site.site, user_id: 1 };
      const prepared = await caller.call({
        operation: 'prepare_media',
        target,
        upload,
        fields: { slug: 'refused-upload' },
      });

      if (!prepared.ok) {
        refusal(prepared);
      } else {
        refusal(
          await caller.call({ operation: 'save_resource', target, receipt: prepared.receipt }),
        );
      }
    });
  }
});

test('bind an inspected image and reject a stale token', async () => {
  const image = await seedImage(site, { name: 'bound-image', alt: 'Bound alt' });
  await withDocument(
    site,
    { content: doc(paragraph('Anchor')) },
    async ({ blockwork, id, before }) => {
      const inspected = await blockwork.call({ operation: 'inspect_media', id: image.id });
      check(inspected);
      check(await blockwork.edit({ edits: [{ op: 'insert', block: { name: 'core/image' } }] }));
      const binding = {
        path: [1],
        name: 'core/image',
        media_id: image.id,
        media_token: inspected.record.edit_token,
        size: 'full',
        bind: { id: 'id', url: 'url', alt: 'alt', size_slug: 'sizeSlug' },
      };
      check(await blockwork.edit({ media_bindings: [binding] }));
      const saved = await blockwork.save();
      const { after } = await assertSavedCleanly(site, id, before, saved);
      assert.match(after.content, /Bound alt/);
      assert.match(after.content, new RegExp(`wp-image-${image.id}`));
      await site.php(
        `update_post_meta(${image.id}, '_wp_attachment_image_alt', 'Changed elsewhere');`,
      );
      refusal(await blockwork.edit({ media_bindings: [binding] }));
    },
  );
});

test('capture a saved page and reject editor capture', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Capture target')) },
    async ({ blockwork, doc: connected }) => {
      const editorCapture = await blockwork.capture_page({ url: connected.link });
      assert.equal(
        editorCapture.error,
        'capture_requires_front_end_tab',
        JSON.stringify(editorCapture),
      );
      refusal(editorCapture);
      const tab = await site.openTab(connected.link);
      const front = await site.createCaller(tab);

      try {
        await waitFor(
          site,
          tab,
          "document.readyState === 'complete' && !!document.querySelector('p')",
        );
        const capture = await front.capture_page({
          widths: ['desktop', 'mobile'],
          selector: 'p',
          measure: { selectors: ['p', '.missing-fixture'] },
        });
        check(capture);
        assert.equal(capture.shots.length, 2);

        for (const shot of capture.shots) {
          assert.ok(shot.image.length > 0);
          assert.equal(shot.elements[0].found, true);
          assert.equal(shot.elements[1].found, false);
        }

        const missing = await front.capture_page({ selector: '.missing-fixture' });
        refusal(missing);
        assert.equal(missing.error, 'selector_not_found', JSON.stringify(missing));
        const invalidWidth = await front.capture_page({ widths: [100] });
        refusal(invalidWidth);
        assert.equal(invalidWidth.error, 'invalid_capture');
        assert.ok(invalidWidth.issues.some((issue) => issue.path.includes('widths')));
        const invalidSelector = await front.capture_page({ measure: { selectors: ['['] } });
        refusal(invalidSelector);
        assert.equal(invalidSelector.error, 'invalid_selector', JSON.stringify(invalidSelector));
        assert.match(invalidSelector.diagnostics.field, /measure.*selectors.*0/);
        const hovered = await front.capture_page({
          widths: [800],
          states: { selector: 'p', pseudo: ['hover'] },
          measure: { selectors: ['p'] },
        });
        check(hovered);
        await site.evaluate(
          tab,
          "(() => { const notice = document.createElement('aside'); notice.id = 'fixture-cookie-notice'; notice.style.cssText = 'position:fixed;bottom:0;left:0;background:white;z-index:99999'; notice.textContent = 'Cookie consent'; const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Accept'; notice.append(button); document.body.append(notice); })()",
        );
        const hidden = await front.capture_page({ widths: ['mobile'] });
        check(hidden);
        assert.ok(hidden.shots[0].hidden_notices > 0);
        const kept = await front.capture_page({ widths: ['mobile'], keep_notices: true });
        check(kept);
        assert.equal(kept.shots[0].hidden_notices, 0);
        await site.evaluate(
          tab,
          "(() => { const notice = document.getElementById('fixture-cookie-notice'); notice.firstChild.textContent = 'Datenschutz'; notice.querySelector('button').textContent = 'Zustimmen'; })()",
        );
        const translated = await front.capture_page({ widths: ['mobile'] });
        check(translated);
        assert.equal(translated.shots[0].hidden_notices, 0);
        const redirected = await front.capture_page({
          url: `${site.site}/?bw_fixture_redirect=${connected.target.post_id}`,
          widths: ['mobile'],
        });
        check(redirected);
        const notFoundUrl = `${site.site}/?p=999999`;
        assert.equal((await fetch(notFoundUrl)).status, 404);
        check(await front.capture_page({ url: notFoundUrl, widths: ['mobile'] }));
      } finally {
        await tab.close();
      }
    },
  );
});

test('copy media between sites twice without creating a duplicate', async () => {
  const targetSite = await startEditingSite();
  let sourceTab;
  let targetTab;

  try {
    await site.php("update_option('permalink_structure', '/%postname%/'); flush_rewrite_rules();");
    await targetSite.php(
      "update_option('permalink_structure', '/%postname%/'); flush_rewrite_rules();",
    );
    await seedDocument(site, {
      content: doc(paragraph('Source linked page')),
      extra: { post_name: 'linked-page' },
    });
    const linkedTarget = await seedDocument(targetSite, {
      content: doc(paragraph('Destination linked page')),
      extra: { post_name: 'linked-page' },
    });
    const sourceLink = `${site.site}/linked-page/`;
    const targetLink = `${targetSite.site}/linked-page/`;
    const image = await seedImage(site, {
      name: 'copy-source',
      width: 40,
      height: 40,
      alt: 'Copied alt',
    });
    sourceTab = await site.openTab(`${site.site}/wp-admin/upload.php`);
    targetTab = await targetSite.openTab(`${targetSite.site}/wp-admin/upload.php`);
    await waitFor(site, sourceTab, '!!window.wp?.apiFetch');
    await waitFor(targetSite, targetTab, '!!window.wp?.apiFetch');
    const source = await site.createCaller(sourceTab);
    const target = await targetSite.createCaller(targetTab);
    const request = {
      source,
      source_target: { site_url: site.site, user_id: 1 },
      target: { site_url: targetSite.site, user_id: 1 },
      ids: [image.id],
      copy_id: 'copy-fixture',
    };
    let first;

    for (let batch = 0; batch < 3; batch++) {
      first = await target.copy_media(request);
      check(first);

      if (first.complete) {
        break;
      }

      assert.equal(first.next, 'wait_for_media_copy', JSON.stringify(first));
      await waitFor(targetSite, targetTab, '!window.__blockwork_resources_v1?.busy');
    }

    assert.equal(first.complete, true, JSON.stringify(first));
    const second = await target.copy_media(request);
    check(second);
    assert.equal(second.complete, true, JSON.stringify(second));
    assert.deepEqual(second.media_map, first.media_map);
    const attachments = await targetSite.php(
      "echo wp_json_encode(get_posts(['post_type' => 'attachment', 'post_status' => 'inherit', 'fields' => 'ids', 'numberposts' => -1]));",
    );
    assert.equal(attachments.length, 1);
    await withDocument(
      targetSite,
      { content: doc(paragraph('Destination')) },
      async ({ blockwork, id, before }) => {
        const markup = doc(paragraph(`<a href="${sourceLink}">Linked page</a>`));
        const links = await blockwork.call({
          operation: 'map_links',
          markup,
          source_site_url: site.site,
        });
        check(links);
        assert.equal(links.link_map.urls[sourceLink], targetLink);
        assert.equal(links.link_map.ids[sourceLink], linkedTarget);
        const section = {
          name: 'core/group',
          attributes: { layout: { type: 'constrained' } },
          inner_blocks: [
            { name: 'core/image', attributes: { id: image.id, url: image.url, alt: image.alt } },
            {
              name: 'core/paragraph',
              attributes: { content: `<a href="${sourceLink}">Linked page</a>` },
            },
          ],
        };
        check(
          await blockwork.edit({
            edits: [
              {
                op: 'insert',
                block: section,
                media_map: first.media_map,
                link_map: links.link_map,
              },
            ],
          }),
        );
        const { after } = await assertSavedCleanly(targetSite, id, before, await blockwork.save());
        const mappedId = first.media_map.ids[String(image.id)];
        assert.match(after.content, new RegExp(`wp-image-${mappedId}`));
        assert.ok(!after.content.includes(image.url));
        assert.ok(after.content.includes(targetLink));
        assert.ok(!after.content.includes(sourceLink));
      },
    );
  } finally {
    await Promise.allSettled([sourceTab?.close(), targetTab?.close()]);
    await targetSite[Symbol.asyncDispose]();
  }
});

test('view a block immediately after inserting it', async () => {
  const image = await seedImage(site, { name: 'view-image', width: 40, height: 40 });
  await withDocument(
    site,
    { content: doc(paragraph('Anchor')) },
    async ({ blockwork, id, before }) => {
      for (const block of [
        { name: 'core/paragraph', attributes: { content: 'Visible paragraph' } },
        { name: 'core/heading', attributes: { content: 'Visible heading', level: 2 } },
        { name: 'core/image', attributes: { id: image.id, url: image.url, alt: 'Visible image' } },
      ]) {
        const edited = await blockwork.edit({ edits: [{ op: 'insert', block }] });
        check(edited);
        const read = await blockwork.read({ blocks: 'roots' });
        const clientId = read.blocks.at(-1).client_id;
        const view = await blockwork.view({ client_id: clientId, widths: ['desktop'] });
        check(view);
        assert.equal(view.shots[0].rendered, true, JSON.stringify(view));
        assert.ok(view.shots[0].image.length > 0);
        const measured = await blockwork.measure({ blocks: [clientId] });
        check(measured);
        assert.equal(measured.blocks[0].client_id, clientId);
        assert.equal(measured.blocks[0].rendered, true, JSON.stringify(measured));
        assert.ok(measured.blocks[0].elements[0].rect.width > 0);
        assert.ok(measured.blocks[0].elements[0].rect.height > 0);
      }

      await assertSavedCleanly(site, id, before, await blockwork.save());
    },
  );
});

test('image replacement preserves unrequested link and caption attributes', async () => {
  const first = await seedImage(site, { name: 'replacement-first', alt: 'First alt' });
  const second = await seedImage(site, { name: 'replacement-second', alt: 'Second alt' });
  await withDocument(
    site,
    { content: doc(paragraph('Anchor')) },
    async ({ blockwork, id, before }) => {
      check(
        await blockwork.edit({
          edits: [
            {
              op: 'insert',
              block: {
                name: 'core/image',
                attributes: {
                  id: first.id,
                  url: first.url,
                  alt: first.alt,
                  linkDestination: 'media',
                  href: first.url,
                  sizeSlug: 'full',
                  caption: 'First caption',
                },
              },
            },
          ],
        }),
      );
      const roots = await blockwork.read({ blocks: 'roots' });
      const clientId = roots.blocks.at(-1).client_id;
      check(
        await blockwork.edit({
          edits: [
            {
              op: 'update',
              client_id: clientId,
              attributes: { id: second.id, url: second.url, alt: second.alt },
            },
          ],
        }),
      );
      const read = await blockwork.read({ blocks: { client_id: clientId } });
      const attributes = read.blocks[0].attributes;
      assert.equal(attributes.id, second.id);
      assert.equal(attributes.url, second.url);
      assert.equal(attributes.href, first.url);
      assert.equal(attributes.linkDestination, 'media');
      assert.equal(attributes.sizeSlug, 'full');
      assert.equal(attributes.caption, 'First caption');
      await assertSavedCleanly(site, id, before, await blockwork.save());
    },
  );
});

test('map links once and refuse unmapped internal links before mutation', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Destination')) },
    async ({ blockwork, id, before }) => {
      const source = 'https://source.example.test';
      const first = `${source}/first/`;
      const second = `${source}/second/`;
      const third = `${source}/third/`;
      const markup = doc(paragraph(`<a href="${first}">First</a> <a href="${second}">Second</a>`));
      const mapped = await blockwork.call({
        operation: 'map_links',
        source_site_url: source,
        markup,
        overrides: [
          { source_url: first, target_url: second },
          { source_url: second, target_url: third },
        ],
      });
      check(mapped);
      check(await blockwork.edit({ edits: [{ op: 'insert', markup, link_map: mapped.link_map }] }));
      const missing = await blockwork.edit({
        edits: [
          {
            op: 'insert',
            markup: doc(paragraph(`<a href="${source}/missing/">Missing</a>`)),
            link_map: mapped.link_map,
          },
        ],
      });
      refusal(missing);
      assert.equal(missing.error, 'unmapped_internal_link', JSON.stringify(missing));
      const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.ok(after.content.includes(`href="${second}">First</a>`));
      assert.ok(after.content.includes(`href="${third}">Second</a>`));
      assert.ok(!after.content.includes(first));
      assert.ok(!after.content.includes('Missing'));
    },
  );
});

test('oversized upload refuses before any server write', async () => {
  await adminCaller(async (caller) => {
    const target = { site_url: site.site, user_id: 1 };
    const result = await caller.call({
      operation: 'prepare_media',
      target,
      upload: {
        name: 'large.png',
        mime_type: 'image/png',
        base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
      },
      fields: { slug: 'large-upload' },
    });
    refusal(result);
    const status = await caller.call({ operation: 'resource_status', target });
    check(status);
    assert.equal(status.attempted, false);
  });
});

test('recover a lost upload response without another attachment', async () => {
  const image = await seedImage(site, { name: 'lost-upload-source', width: 3000, height: 40 });
  const tab = await site.openTab(`${site.site}/wp-admin/upload.php`);
  await waitFor(site, tab, '!!window.wp?.apiFetch');
  const caller = await site.createCaller(tab);
  const target = { site_url: site.site, user_id: 1 };

  try {
    const downloaded = await caller.call({ operation: 'download_media', target, id: image.id });
    check(downloaded);
    const original = await site.php(
      `echo wp_json_encode(base64_encode(file_get_contents(wp_get_original_image_path(${image.id}))));`,
    );
    const prepared = await caller.call({
      operation: 'prepare_media',
      target,
      upload: { ...downloaded.upload, base64: original, name: '日本語 image.png' },
      fields: { slug: 'lost-upload' },
    });
    check(prepared);
    let uploads = 0;
    const stop = await site.intercept(tab, {
      urlPattern: '*',
      stage: 'Response',
      decide: ({ request }) => {
        if (request.method === 'POST' && request.url.includes('media')) {
          uploads++;

          return 'fail';
        }

        return 'pass';
      },
    });

    try {
      refusal(await caller.call({ operation: 'save_resource', target, receipt: prepared.receipt }));
    } finally {
      await stop();
    }

    const verified = await caller.call({
      operation: 'verify_resource',
      target,
      receipt: prepared.receipt,
    });
    check(verified);
    assert.equal(verified.persistence, 'verified', JSON.stringify(verified));
    assert.equal(uploads, 1);
    const count = await site.php(
      "echo wp_json_encode(count(get_posts(['post_type' => 'attachment', 'post_status' => 'inherit', 'name' => 'lost-upload'])));",
    );
    assert.equal(count, 1);
  } finally {
    await tab.close();
  }
});

for (const name of ['日本語.png', 'duplicate.png', 'renamed.png']) {
  test(`upload filename ${name}`, async () => {
    const image = await seedImage(site, { name: `source-${name}`, width: 40, height: 40 });
    await adminCaller(async (caller) => {
      const target = { site_url: site.site, user_id: 1 };
      const downloaded = await caller.call({ operation: 'download_media', target, id: image.id });
      check(downloaded);

      if (name === 'renamed.png') {
        await site.php("update_option('bw_rename_upload', true);");
      }

      try {
        for (let index = 0; index < (name === 'duplicate.png' ? 2 : 1); index++) {
          const prepared = await caller.call({
            operation: 'prepare_media',
            target,
            upload: { ...downloaded.upload, name },
            fields: {
              slug: `filename-${name === '日本語.png' ? 'unicode' : name.split('.')[0]}-${index}`,
            },
          });
          check(prepared);
          const saved = await caller.call({
            operation: 'save_resource',
            target,
            receipt: prepared.receipt,
          });
          check(saved);
          assert.equal(saved.persistence, 'verified');
        }
      } finally {
        await site.php("delete_option('bw_rename_upload');");
      }
    });
  });
}

test('recompressed upload reports different bytes without inviting another upload', async () => {
  const image = await seedImage(site, { name: 'optimizer-source', width: 40, height: 40 });
  await adminCaller(async (caller) => {
    const target = { site_url: site.site, user_id: 1 };
    const downloaded = await caller.call({ operation: 'download_media', target, id: image.id });
    check(downloaded);
    const prepared = await caller.call({
      operation: 'prepare_media',
      target,
      upload: downloaded.upload,
      fields: { slug: 'optimizer-upload' },
    });
    check(prepared);
    await site.php("update_option('bw_recompress_upload', true);");

    try {
      const saved = await caller.call({
        operation: 'save_resource',
        target,
        receipt: prepared.receipt,
      });
      check(saved);
      const result = await adminCaller((verifier) =>
        verifier.call({
          operation: 'verify_resource',
          target,
          receipt: prepared.receipt,
          resource_id: saved.resource_id,
        }),
      );
      refusal(result);
      assert.equal(result.outcome, 'upload_bytes_different', JSON.stringify(result));
      assert.equal(result.error, 'upload_bytes_different');
      assert.equal(result.persistence, 'uncertain');
      assert.equal(result.next, 'inspect_resource');
      assert.match(result.hint, /do not.*upload|never.*upload/i);
      assert.ok(result.resource_id);
    } finally {
      await site.php("delete_option('bw_recompress_upload');");
    }
  });
});

for (const [name, bind] of [
  ['core/cover', { id: 'id', url: 'url' }],
  ['core/media-text', { id: 'mediaId', url: 'mediaUrl' }],
  ['core/file', { id: 'id', url: 'href' }],
]) {
  test(`bind an attachment into ${name}`, async () => {
    const image = await seedImage(site, {
      name: `binding-${name.split('/')[1]}`,
      width: 40,
      height: 40,
    });
    await withDocument(
      site,
      { content: doc(paragraph('Anchor')) },
      async ({ blockwork, id, before }) => {
        const inspected = await blockwork.call({ operation: 'inspect_media', id: image.id });
        check(inspected);
        const block = { name };

        if (name === 'core/media-text') {
          block.attributes = { mediaType: 'image' };
        }

        if (name === 'core/cover') {
          block.inner_blocks = [{ name: 'core/paragraph', attributes: { content: 'Cover text' } }];
        }

        check(await blockwork.edit({ edits: [{ op: 'insert', block }] }));
        check(
          await blockwork.edit({
            media_bindings: [
              {
                path: [1],
                name,
                media_id: image.id,
                media_token: inspected.record.edit_token,
                size: 'full',
                bind,
              },
            ],
          }),
        );
        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.ok(after.content.includes(image.url));
      },
    );
  });
}

for (const extension of ['jpg', 'pdf', 'txt']) {
  test(`upload ${extension} with native MIME validation`, async () => {
    const image = await seedImage(site, { name: `mime-${extension}`, width: 40, height: 40 });
    const base64 = await site.php(
      `$image = imagecreatefrompng(get_attached_file(${image.id})); ob_start(); imagejpeg($image); echo wp_json_encode(base64_encode(ob_get_clean()));`,
    );
    const upload =
      extension === 'pdf'
        ? {
            name: 'document.pdf',
            mime_type: 'application/pdf',
            base64: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF').toString(
              'base64',
            ),
          }
        : { name: `photo.${extension}`, mime_type: 'image/jpeg', base64 };
    await adminCaller(async (caller) => {
      const target = { site_url: site.site, user_id: 1 };
      const prepared = await caller.call({
        operation: 'prepare_media',
        target,
        upload,
        fields: { slug: `uploaded-mime-${extension}` },
      });
      check(prepared);
      const result = await caller.call({
        operation: 'save_resource',
        target,
        receipt: prepared.receipt,
      });

      if (extension === 'txt') {
        refusal(result);
        assert.equal(result.error, 'rest_upload_unknown_error');
        assert.equal(result.next, 'verify_resource_do_not_replay');

        return;
      }

      check(result);
      assert.equal(result.persistence, 'verified');
      const inspected = await caller.call({
        operation: 'inspect_media',
        target,
        id: result.resource_id,
      });
      check(inspected);
      assert.equal(inspected.record.mime_type, upload.mime_type);

      if (extension === 'pdf') {
        const documents = await caller.call({
          operation: 'inspect_media',
          target,
          search: 'document',
          media_type: 'application',
        });
        check(documents);
        assert.ok(documents.records.some((record) => record.id === result.resource_id));
      }
    });
  });
}

test('PNG converted to JPEG reports a known attachment without another upload', async () => {
  const image = await seedImage(site, { name: 'conversion-source', width: 40, height: 40 });
  await adminCaller(async (caller) => {
    const target = { site_url: site.site, user_id: 1 };
    const downloaded = await caller.call({ operation: 'download_media', target, id: image.id });
    check(downloaded);
    const prepared = await caller.call({
      operation: 'prepare_media',
      target,
      upload: downloaded.upload,
      fields: { slug: 'converted-upload' },
    });
    check(prepared);
    await site.php("update_option('bw_convert_upload', true);");

    try {
      const result = await caller.call({
        operation: 'save_resource',
        target,
        receipt: prepared.receipt,
      });
      assert.equal(result.outcome, 'upload_bytes_unavailable', JSON.stringify(result));
      assert.equal(result.persistence, 'uncertain');
      assert.ok(result.resource_id);
      assert.equal(result.record.mime_type, 'image/jpeg');
      assert.match(result.hint, /do not.*upload|never.*upload/i);
    } finally {
      await site.php("delete_option('bw_convert_upload');");
    }
  });
});

test(
  'a Gallery binds its Image child and Site Logo refuses document media attributes',
  { todo: 'finding: gallery-native-media-coordination' },
  async () => {
    const image = await seedImage(site, { name: 'gallery-image', width: 40, height: 40 });
    await withDocument(
      site,
      { content: doc(paragraph('Anchor')) },
      async ({ blockwork, id, before }) => {
        const inspected = await blockwork.call({ operation: 'inspect_media', id: image.id });
        check(inspected);
        check(
          await blockwork.edit({
            edits: [
              {
                op: 'insert',
                block: { name: 'core/gallery', inner_blocks: [{ name: 'core/image' }] },
              },
            ],
          }),
        );
        check(
          await blockwork.edit({
            media_bindings: [
              {
                path: [1, 0],
                name: 'core/image',
                media_id: image.id,
                media_token: inspected.record.edit_token,
                size: 'full',
                bind: { id: 'id', url: 'url', alt: 'alt' },
              },
            ],
          }),
        );
        check(
          await blockwork.edit({ edits: [{ op: 'insert', block: { name: 'core/site-logo' } }] }),
        );
        refusal(
          await blockwork.edit({
            media_bindings: [
              {
                path: [2],
                name: 'core/site-logo',
                media_id: image.id,
                media_token: inspected.record.edit_token,
                size: 'full',
                bind: { id: 'id', url: 'url' },
              },
            ],
          }),
        );
        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.ok(after.content.includes(image.url));
      },
    );
  },
);

for (const type of ['audio', 'video']) {
  test(`upload and bind ${type}`, async () => {
    const audio = Buffer.alloc(8044);
    audio.write('RIFF');
    audio.writeUInt32LE(8036, 4);
    audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24);
    audio.writeUInt32LE(8000, 28);
    audio.writeUInt16LE(1, 32);
    audio.writeUInt16LE(8, 34);
    audio.write('data', 36);
    audio.writeUInt32LE(8000, 40);
    audio.fill(128, 44);
    const upload =
      type === 'audio'
        ? { name: 'silence.wav', mime_type: 'audio/wav', base64: audio.toString('base64') }
        : {
            name: 'blue.mp4',
            mime_type: 'video/mp4',
            base64:
              'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMUbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAAg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABZYAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALLAAAAAQAAABRzdGNvAAAAAAAAAAEAAANEAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMgAAAAhmcmVlAAAC021kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABZliIQAFf/+7M9+BTcgPIv1lAh0tW+B',
          };
    await withDocument(
      site,
      { content: doc(paragraph('Anchor')) },
      async ({ blockwork, id, before }) => {
        const prepared = await blockwork.call({
          operation: 'prepare_media',
          upload,
          fields: { slug: `binding-${type}` },
        });
        check(prepared);
        const saved = await blockwork.call({
          operation: 'save_resource',
          receipt: prepared.receipt,
        });
        check(saved);
        const inspected = await blockwork.call({
          operation: 'inspect_media',
          id: saved.resource_id,
        });
        check(inspected);
        const name = `core/${type}`;
        check(
          await blockwork.edit({
            edits: [
              { op: 'insert', block: { name, attributes: { src: inspected.record.source_url } } },
            ],
          }),
        );
        check(
          await blockwork.edit({
            media_bindings: [
              {
                path: [1],
                name,
                media_id: saved.resource_id,
                media_token: inspected.record.edit_token,
                size: 'full',
                bind: { id: 'id', url: 'src' },
              },
            ],
          }),
        );
        const { after } = await assertSavedCleanly(site, id, before, await blockwork.save());
        assert.ok(after.content.includes(inspected.record.source_url));
      },
    );
  });
}

test('view reports incomplete slices for a very tall block', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Anchor')) },
    async ({ blockwork, id, before }) => {
      check(
        await blockwork.edit({
          edits: [
            {
              op: 'insert',
              block: {
                name: 'core/group',
                attributes: { style: { dimensions: { minHeight: '20000px' } } },
                inner_blocks: [{ name: 'core/paragraph', attributes: { content: 'Tall block' } }],
              },
            },
          ],
        }),
      );
      const read = await blockwork.read({ blocks: 'roots' });
      const clientId = read.blocks.at(-1).client_id;
      const viewed = await blockwork.view({ client_id: clientId, widths: ['desktop'] });
      check(viewed);
      assert.deepEqual(viewed.incomplete, ['desktop']);
      await assertSavedCleanly(site, id, before, await blockwork.save());
    },
  );
});

test('media URL and ID mapping changes each value once', async () => {
  const a = await seedImage(site, { name: 'map-a', width: 40, height: 40 });
  const b = await seedImage(site, { name: 'map-b', width: 40, height: 40 });
  const c = await seedImage(site, { name: 'map-c', width: 40, height: 40 });
  await withDocument(
    site,
    { content: doc(paragraph('Anchor')) },
    async ({ blockwork, id, before }) => {
      const media_map = {
        ids: { [a.id]: b.id, [b.id]: c.id },
        urls: { [a.url]: b.url, [b.url]: c.url },
      };
      check(
        await blockwork.edit({
          edits: [
            {
              op: 'insert',
              block: {
                name: 'core/image',
                attributes: { id: a.id, url: a.url, alt: 'Preserved text' },
              },
              media_map,
            },
          ],
        }),
      );
      const read = await blockwork.read({ blocks: 'roots' });
      const selected = await blockwork.read({ blocks: { client_id: read.blocks[1].client_id } });
      check(selected);
      assert.equal(selected.blocks[0].attributes.id, b.id);
      assert.equal(selected.blocks[0].attributes.url, b.url);
      assert.equal(selected.blocks[0].attributes.alt, 'Preserved text');
      await assertSavedCleanly(site, id, before, await blockwork.save());
    },
  );
});

test('deleted attachment in existing content does not erase its block', async () => {
  const image = await seedImage(site, { name: 'deleted-attachment', width: 40, height: 40 });
  await withDocument(
    site,
    { content: doc(paragraph('Anchor')) },
    async ({ blockwork, id, before }) => {
      check(
        await blockwork.edit({
          edits: [
            {
              op: 'insert',
              block: {
                name: 'core/image',
                attributes: { id: image.id, url: image.url, alt: 'Retained image' },
              },
            },
          ],
        }),
      );
      await assertSavedCleanly(site, id, before, await blockwork.save());
      await site.php(`wp_delete_attachment(${image.id}, true);`);
      const current = await storedDocument(site, id);
      check(await blockwork.edit({ post: { title: 'Changed title' } }));
      const { after } = await assertSavedCleanly(site, id, current, await blockwork.save(), {
        allow: ['title'],
      });
      assert.equal(after.content, current.content);
    },
  );
});

test('Site Logo refuses document media bindings without changing the site logo', async () => {
  const image = await seedImage(site, { name: 'site-logo-binding', width: 40, height: 40 });
  const logo = await site.php("echo wp_json_encode(get_theme_mod('custom_logo', 0));");
  await withDocument(
    site,
    { content: doc(paragraph('Anchor')) },
    async ({ blockwork, id, before }) => {
      const media = await blockwork.call({ operation: 'inspect_media', id: image.id });
      check(media);
      check(await blockwork.edit({ edits: [{ op: 'insert', block: { name: 'core/site-logo' } }] }));
      const result = await blockwork.edit({
        media_bindings: [
          {
            path: [1],
            name: 'core/site-logo',
            media_id: image.id,
            media_token: media.record.edit_token,
            size: 'full',
            bind: { id: 'id', url: 'url' },
          },
        ],
      });
      await assertRefused(site, id, before, result);
      await assertSavedCleanly(site, id, before, await blockwork.save());
      assert.equal(await site.php("echo wp_json_encode(get_theme_mod('custom_logo', 0));"), logo);
    },
  );
});

test('site-allowed SVG preserves attachment text fields', async () => {
  await site.php("update_option('bw_allow_svg', true);");

  try {
    await adminCaller(async (caller) => {
      const target = { site_url: site.site, user_id: 1 };
      const upload = {
        name: 'allowed.svg',
        mime_type: 'image/svg+xml',
        base64: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" fill="#123456"/></svg>',
        ).toString('base64'),
      };
      const prepared = await caller.call({
        operation: 'prepare_media',
        target,
        upload,
        fields: {
          slug: 'allowed-svg',
          title: 'Vector title',
          alt: 'Vector alt',
          caption: 'Vector caption',
          description: 'Vector description',
        },
      });
      check(prepared);
      const saved = await caller.call({
        operation: 'save_resource',
        target,
        receipt: prepared.receipt,
      });
      check(saved);
      assert.equal(saved.persistence, 'verified');
      assert.equal(saved.record.mime_type, 'image/svg+xml');
      assert.equal(saved.record.title.raw, 'Vector title');
      assert.equal(saved.record.alt_text, 'Vector alt');
      assert.equal(saved.record.caption.raw, 'Vector caption');
      assert.equal(saved.record.description.raw, 'Vector description');
    });
  } finally {
    await site.php("delete_option('bw_allow_svg');");
  }
});

test('upload text rewritten by a plugin is corrected on the same attachment', async () => {
  const image = await seedImage(site, { name: 'correction-source', width: 40, height: 40 });
  const count = () =>
    site.php(
      "echo wp_json_encode(count(get_posts(['post_type' => 'attachment', 'post_status' => 'inherit', 'numberposts' => -1, 'fields' => 'ids'])));",
    );
  const before = await count();
  await site.php("update_option('bw_rewrite_upload_text', true);");

  try {
    await adminCaller(async (caller) => {
      const target = { site_url: site.site, user_id: 1 };
      const downloaded = await caller.call({ operation: 'download_media', target, id: image.id });
      check(downloaded);
      const prepared = await caller.call({
        operation: 'prepare_media',
        target,
        upload: downloaded.upload,
        fields: {
          slug: 'corrected-upload',
          title: 'Requested title',
          caption: 'Requested caption',
        },
      });
      check(prepared);
      const saved = await caller.call({
        operation: 'save_resource',
        target,
        receipt: prepared.receipt,
      });
      check(saved);
      assert.equal(saved.persistence, 'verified');
      assert.equal(saved.record.title.raw, 'Requested title');
      assert.equal(saved.record.caption.raw, 'Requested caption');
      assert.deepEqual(saved.corrective_update.fields.toSorted(), ['caption', 'title']);
      assert.equal(saved.corrective_update.acknowledged, true);
      assert.equal(saved.record.id, saved.resource_id);
      assert.equal(await count(), before + 1);
    });
  } finally {
    await site.php("delete_option('bw_rewrite_upload_text');");
  }
});

test('media-map validation does not disclose an arbitrary URL key', async () => {
  await withDocument(
    site,
    { content: doc(paragraph('Anchor')) },
    async ({ blockwork, id, before }) => {
      const result = await blockwork.edit({
        edits: [
          {
            op: 'insert',
            block: { name: 'core/image', attributes: { url: 'https://example.test/image.png' } },
            media_map: {
              urls: { 'https://example.test/private.png?token=fixture-secret': 'not-a-url' },
            },
          },
        ],
      });
      await assertRefused(site, id, before, result);
      assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private\.png/);
    },
  );
});

run();
