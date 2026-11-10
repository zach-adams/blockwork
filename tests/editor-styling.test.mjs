import assert from 'node:assert/strict';
import test from 'node:test';
import { copy, stylingFixture, styleEdit, fixture } from './helpers/editor-fixture.mjs';

test('style guide uses effective per-block settings, live presets, and normalized viewport ranges', async () => {
  const f = stylingFixture();
  f.editorSettings.__experimentalFeatures.blocks = { 'core/group': { spacing: { margin: false } } };
  const inspected = await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const guide = inspected.style_guides[0];
  assert.equal(inspected.style_rules.responsive.states['@mobile'], 'width <= 32rem');
  assert.equal(inspected.style_rules.responsive.states['@tablet'], '32rem < width <= 60rem');
  assert.equal(guide.responsive, undefined);
  assert.equal(guide.controls.some((control) => control.property.join('.') === 'style.spacing.margin'), false);
  assert.ok(guide.controls.some((control) => control.property.join('.') === 'style.color.text'));
  assert.equal(guide.controls.some((control) => 'enabled' in control), false);
  assert.equal(guide.custom_css, true);
  assert.equal(inspected.style_rules.custom_css.can_edit_css, true);
  assert.equal(inspected.style_rules.custom_css.document_has_custom_css, true);
  delete f.window.wp.blockEditor;
  const unknown = await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  assert.equal(unknown.style_rules.responsive.available, false);
  assert.deepEqual(Object.keys(unknown.style_rules.responsive.states), []);
});

test('a block type with its own viewport ranges carries its own responsive rules in any guide order', async () => {
  const f = stylingFixture();
  f.editorSettings.__experimentalFeatures.blocks = { 'core/group': { viewport: { tablet: '50rem' } } };

  for (const order of [[{ client_id: 'a' }, { name: 'core/paragraph' }], [{ name: 'core/paragraph' }, { client_id: 'a' }]]) {
    const inspected = await f.call('connect', { style_guides: order });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.equal(inspected.style_rules.responsive.states['@tablet'], '32rem < width <= 60rem');
    const group = inspected.style_guides.find((guide) => guide.name === 'core/group');
    const paragraph = inspected.style_guides.find((guide) => guide.name === 'core/paragraph');
    assert.equal(group.responsive.states['@tablet'], '32rem < width <= 50rem');
    assert.equal(paragraph.responsive, undefined);
  }
});

test('compact style inspection shares usable preset catalogs across guides without changing the draft', async () => {
  for (const workflow of ['background', 'attached']) {
    const f = stylingFixture();
    const palette = Array.from({ length: 60 }, (_, index) => ({
      name: `Theme color ${index}`, slug: `theme-color-${index}`, color: '#445566',
    }));
    f.editorSettings.__experimentalFeatures.color.palette.theme = palette;
    f.registrations['core/group'].supports.typography.__experimentalFontFamily = true;
    f.editorSettings.__experimentalFeatures.typography.fontFamilies = { theme: [{
      name: 'Body', slug: 'body', fontFamily: 'Body, sans-serif',
      fontFace: [{ src: 'font-file-'.repeat(1000) }],
    }] };
    const before = copy(f.blocks);
    const inspected = await f.call('connect', { workflow, style_guides: [
      { client_id: 'a' }, ...Array.from({ length: 5 }, () => ({ name: 'core/group' })),
    ] });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.ok(Buffer.byteLength(JSON.stringify(inspected)) < 32 * 1024);
    assert.equal(inspected.style_guides.length, 6);
    const text = inspected.style_guides[0].controls.find(control => control.property.join('.') === 'style.color.text');
    const catalog = inspected.style_catalogs[text.preset_catalog];
    assert.equal(catalog.preset_type, 'color');
    assert.deepEqual(JSON.parse(JSON.stringify(catalog.items)), palette);
    assert.equal(inspected.style_catalogs.filter(item => item.preset_type === 'color').length, 1);
    const font = inspected.style_guides[0].controls.find(control => control.preset_type === 'font-family');
    assert.deepEqual(JSON.parse(JSON.stringify(inspected.style_catalogs[font.preset_catalog].items)), [
      { name: 'Body', slug: 'body', fontFamily: 'Body, sans-serif' },
    ]);
    assert.deepEqual(copy(f.blocks), before);
    assert.equal(f.dirty, false);
    const edit = { op: 'update_style', path: [0], name: 'core/group',
      set: [{ property: ['style', 'color', 'text'], value: 'var:preset|color|theme-color-59' }] };
    const edited = await f.call('edit', { edits: [edit] });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.equal(f.saves, 0);
  }
});

test('invalid style property prefixes fail before acquiring an editor session', async () => {
  const f = fixture();
  const result = await f.call('connect', { style_guides: [{ name: 'core/group', properties: [['']] }] });
  assert.equal(result.error, 'invalid_connection');
  assert.equal(result.issues[0].path, 'style_guides.0.properties.0.0');
  assert.match(result.hint, /key arrays/);
  assert.equal(f.window.__blockwork_editor, undefined);
  assert.equal(f.saves, 0);
});

test('inspection response budget identifies oversized sections without exposing their values', async () => {
  const f = stylingFixture();
  f.blocks[0].attributes.style.css = 'PRIVATE_STYLE_VALUE'.repeat(4000);
  f.syncContent();
  const before = copy(f.blocks);
  const result = await f.call('connect', { workflow: 'attached', style_guides: [{ client_id: 'a' }] });
  assert.equal(result.error, 'inspection_too_large');
  assert.equal(result.diagnostics.stage, 'inspection_response');
  assert.equal(result.diagnostics.max_bytes, 64 * 1024);
  assert.ok(result.diagnostics.response_bytes > result.diagnostics.max_bytes);
  assert.ok(result.diagnostics.section_bytes.style_guides > result.diagnostics.max_bytes);
  assert.equal(result.diagnostics.guide_bytes[0].guide_index, 0);
  assert.ok(result.diagnostics.guide_bytes[0].bytes > result.diagnostics.max_bytes);
  assert.match(result.hint, /style_guides\[index\].properties/);
  assert.match(result.hint, /do not raise/);
  assert.equal(JSON.stringify(result).includes('PRIVATE_STYLE_VALUE'), false);
  assert.deepEqual(copy(f.blocks), before);
  assert.equal(f.saves, 0);
});

test('responsive style patch preserves sibling values, CSS, classes and base styles through a verified save', async () => {
  const f = stylingFixture();
  const before = copy(f.blocks[0].attributes);
  const edited = await styleEdit(f, [{ property: ['style', '@mobile', 'spacing', 'padding', 'top'], value: '10px' }]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.deepEqual(copy(edited.changed[0].properties), ['style.@mobile.spacing.padding.top']);
  assert.equal(f.dirty, true);
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  const expected = copy(before);
  expected.style['@mobile'].spacing.padding.top = '10px';
  assert.deepEqual(copy(f.blocks[0].attributes), expected);
  assert.equal(f.post.status, 'draft');
});

test('unsetting a responsive property restores inheritance and preserves other ranges', async () => {
  const f = stylingFixture();
  const edited = await styleEdit(f, [], [['style', '@tablet', 'spacing', 'padding', 'top']]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.style['@tablet'], undefined);
  assert.equal(f.blocks[0].attributes.style.spacing.padding.top, '24px');
  assert.equal(f.blocks[0].attributes.style['@mobile'].spacing.padding.left, '8px');
});

test('preset and custom representations switch without retaining the competing base value', async () => {
  for (const custom of [false, true]) {
    const f = stylingFixture();

    if (custom) { f.blocks[0].attributes.fontSize = 'large'; delete f.blocks[0].attributes.style.typography; f.syncContent(); }

    const set = custom ? [{ property: ['style', 'typography', 'fontSize'], value: '28px' }]
      : [{ property: ['fontSize'], value: 'large' }];
    const edited = await styleEdit(f, set);
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const saved = await f.save();
    assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
    assert.equal(f.blocks[0].attributes.fontSize, custom ? undefined : 'large');
    assert.equal(f.blocks[0].attributes.style.typography?.fontSize, custom ? '28px' : undefined);
    assert.equal(f.blocks[0].attributes.style.css, '& strong { color: red; }');
  }
});

test('style patches reject unsupported states, properties, presets and conflicting requests', async () => {
  const cases = [
    [[{ property: ['style', '@desktop', 'spacing', 'padding', 'top'], value: '2px' }], [], 'unsupported_style_state'],
    [[{ property: ['metadata', 'name'], value: 'hidden mutation' }], [], 'unsupported_style_property'],
    [[{ property: ['style', '__proto__', 'polluted'], value: 'yes' }], [], 'unsupported_style_property'],
    [[{ property: ['fontSize'], value: 'missing' }], [], 'style_preset_unavailable'],
    [[{ property: ['style', 'spacing', 'padding', 'top'], value: '2px' }], [['style', 'spacing', 'padding']], 'overlapping_style_properties'],
    [[{ property: ['fontSize'], value: 'large' }, { property: ['style', 'typography', 'fontSize'], value: '2px' }], [], 'competing_style_properties'],
  ];

  for (const [set, unset, error] of cases) {
    const f = stylingFixture();
    const result = await styleEdit(f, set, unset);
    assert.equal(result.ok, false);
    assert.equal(result.error, error, JSON.stringify(result));
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);
  }
});

test('style patches protect existing native CSS from a save without edit_css permission', async () => {
  const f = stylingFixture();
  f.editorSettings.canEditCSS = false;
  const edited = await styleEdit(f, [{ property: ['style', 'spacing', 'padding', 'top'], value: '30px' }]);
  assert.equal(edited.ok, false);
  assert.equal(edited.error, 'custom_css_permission_required');
  assert.equal(f.saves, 0);
  assert.equal(f.dirty, false);

  delete f.blocks[0].attributes.style.css;
  f.blocks.push({ name: 'core/group', clientId: 'neighbor', isValid: true, innerBlocks: [], attributes: { style: { css: 'color: red;' } } });
  f.syncContent();
  const neighbor = await styleEdit(f, [{ property: ['style', 'spacing', 'padding', 'top'], value: '30px' }]);
  assert.equal(neighbor.error, 'custom_css_permission_required');
  assert.equal(f.saves, 0);
});

test('ordered style patches beside unsupported content retain its exact bytes through save', async () => {
  const f = stylingFixture();
  f.blocks.push({ name: 'core/html', attributes: { content: '<p>Preserve raw bytes.</p>' }, clientId: 'raw', innerBlocks: [], isValid: true });
  f.syncContent();
  const originalRaw = f.window.wp.blocks.serialize([f.blocks[1]]);
  await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  const edits = ['top', 'right'].map((side) => ({ op: 'update_style', path: [0], name: 'core/group',
    set: [{ property: ['style', 'spacing', 'padding', side], value: '32px' }] }));
  const edited = await f.call('edit', { edits });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(saved.preservation_status, 'verified_after_read');
  assert.equal(f.window.wp.blocks.serialize([f.blocks[1]]), originalRaw);
  assert.equal(f.blocks[0].attributes.style.spacing.padding.top, '32px');
  assert.equal(f.blocks[0].attributes.style.spacing.padding.right, '32px');
});

test('native CSS accepts child selectors while custom-value and responsive editing restrictions refuse', async () => {
  const f = stylingFixture();
  const css = '& > p { color: red; }';
  const edited = await styleEdit(f, [{ property: ['style', 'css'], value: css }]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.style.css, css);

  const g = stylingFixture();
  g.editorSettings.__experimentalFeatures.typography.customFontSize = false;
  assert.equal((await styleEdit(g, [{ property: ['style', 'typography', 'fontSize'], value: '2px' }])).error, 'custom_style_disabled');
  g.editorSettings.responsiveEditingEnabled = false;
  assert.equal((await styleEdit(g, [{ property: ['style', '@mobile', 'spacing', 'padding', 'top'], value: '2px' }])).error, 'style_state_editing_disabled');
});

test('style guides restrict side patches to the registration and give exact preset value formats', async () => {
  const f = stylingFixture();
  f.registrations['core/group'].supports.spacing.margin = ['top', 'bottom'];
  const read = await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  const margin = read.style_guides[0].controls.find((control) => control.property.join('.') === 'style.spacing.margin');
  assert.deepEqual(copy(margin.edges), ['top', 'bottom']);
  assert.equal(margin.requires_edge, true);
  const font = read.style_guides[0].controls.find((control) => control.preset_attribute === 'fontSize');
  assert.equal(font.preset_value_format, 'var:preset|font-size|SLUG');
  const wrongSide = await styleEdit(f, [{ property: ['style', 'spacing', 'margin', 'left'], value: '2px' }]);
  assert.equal(wrongSide.error, 'unsupported_style_property');
  const shorthand = await styleEdit(f, [{ property: ['style', 'spacing', 'margin'], value: '2px' }]);
  assert.equal(shorthand.error, 'style_side_required');

  f.editorSettings.__experimentalFeatures.typography.defaultFontSizes = false;
  f.editorSettings.__experimentalFeatures.typography.fontSizes.default = [{ slug: 'hidden', size: '16px' }];
  const hidden = await styleEdit(f, [{ property: ['fontSize'], value: 'hidden' }]);
  assert.equal(hidden.error, 'style_preset_unavailable');
});

test('resetting the last style property removes the attribute while a responsive preset retains the base', async () => {
  const f = stylingFixture();
  f.blocks[0].attributes.style = { spacing: { padding: { top: '24px' } } };
  f.syncContent();
  const edited = await styleEdit(f, [], [['style', 'spacing', 'padding', 'top']]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.equal(f.blocks[0].attributes.style, undefined);

  const g = stylingFixture();
  g.blocks[0].attributes.fontSize = 'large';
  delete g.blocks[0].attributes.style.typography;
  g.syncContent();
  const plan = await styleEdit(g, [{ property: ['style', '@mobile', 'typography', 'fontSize'], value: 'var:preset|font-size|large' }]);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await g.save()).persistence, 'verified');
  assert.equal(g.blocks[0].attributes.fontSize, 'large');
  assert.equal(g.blocks[0].attributes.style['@mobile'].typography.fontSize, 'var:preset|font-size|large');
});

test('native Column border sides, presets and empty side containers survive unrelated values and save', async () => {
  const f = stylingFixture();
  f.registrations['core/column'] = {
    ...f.registrations['core/group'], name: 'core/column',
    supports: { ...f.registrations['core/group'].supports, __experimentalBorder: true },
    attributes: { ...f.registrations['core/group'].attributes, borderColor: { type: 'string' } },
  };
  f.blocks[0].name = 'core/column';
  f.blocks[0].attributes.borderColor = 'accent';
  f.blocks[0].attributes.style.border = { radius: '8px', right: [], left: { width: '2px' } };
  f.syncContent();
  const inspected = await f.call('connect', { style_guides: [{ client_id: 'a' }] });
  const side = inspected.style_guides[0].controls.find(control => control.property.join('.') === 'style.border.right.color');
  assert.ok(side);
  assert.equal(side.preset_attribute, undefined);
  assert.equal(side.preset_value_format, 'var:preset|color|SLUG');
  const edited = await styleEdit(f, [
    { property: ['style', 'border', 'right', 'color'], value: 'var:preset|color|accent' },
    { property: ['style', 'border', 'right', 'width'], value: '1px' },
    { property: ['style', 'border', 'right', 'style'], value: 'solid' },
  ]);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const saved = await f.save();
  assert.equal(saved.persistence, 'verified', JSON.stringify(saved));
  assert.deepEqual(copy(f.blocks[0].attributes.style.border), {
    color: 'var:preset|color|accent', radius: '8px', left: { width: '2px' },
    right: { color: 'var:preset|color|accent', width: '1px', style: 'solid' },
  });
  assert.equal(f.blocks[0].attributes.borderColor, undefined);
  assert.equal(f.blocks[0].attributes.style.spacing.padding.top, '24px');
  delete f.window.__blockwork_editor;
  const reset = await styleEdit(f, [], [['style', 'border', 'right', 'width']]);
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.style.border.right.width, undefined);
  assert.equal(f.blocks[0].attributes.style.border.right.color, 'var:preset|color|accent');
});

test('border side controls honor registration and theme restrictions and validate color presets', async () => {
  for (const configure of [
    f => { f.registrations['core/group'].supports.__experimentalBorder = { width: true, color: false }; },
    f => { f.registrations['core/group'].supports.__experimentalBorder = true; f.editorSettings.__experimentalFeatures.border = { color: false }; },
  ]) {
    const f = stylingFixture(); configure(f);
    const result = await styleEdit(f, [{ property: ['style', 'border', 'right', 'color'], value: '#ddd' }]);
    assert.equal(result.error, 'unsupported_style_property');
    assert.equal(result.diagnostics.field, 'edits.0.set.0.property');
    assert.deepEqual(copy(result.diagnostics.property), ['style', 'border', 'right', 'color']);
    assert.equal(result.diagnostics.control_enabled, false);
    assert.equal(f.dirty, false);
    assert.equal(f.saves, 0);
  }

  const f = stylingFixture();
  f.registrations['core/group'].supports.__experimentalBorder = true;
  f.registrations['core/group'].attributes.borderColor = { type: 'string' };
  const preset = await styleEdit(f, [{ property: ['borderColor'], value: 'accent' }]);
  assert.equal(preset.ok, true, JSON.stringify(preset));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.borderColor, 'accent');
  delete f.window.__blockwork_editor;
  const invalid = await styleEdit(f, [{ property: ['style', 'border', 'left', 'color'], value: 'var:preset|color|private-input' }]);
  assert.equal(invalid.error, 'style_preset_unavailable');
  assert.equal(JSON.stringify(invalid).includes('private-input'), false);
});

test('native background, typography, element colors and duotone controls use exact value shapes', async () => {
  const f = stylingFixture();
  Object.assign(f.registrations['core/group'].supports, {
    background: { backgroundImage: true, backgroundSize: true },
    color: { link: true, button: true, heading: true }, filter: { duotone: true },
    typography: { textAlign: ['left', 'center'], textColumns: true, textIndent: true, __experimentalWritingMode: true },
  });
  const patches = [
    { property: ['style', 'background', 'backgroundImage'], value: { url: 'https://example.test/image.jpg', id: 21, source: 'file' } },
    { property: ['style', 'background', 'backgroundSize'], value: 'cover' },
    { property: ['style', 'background', 'backgroundPosition'], value: '50% 50%' },
    { property: ['style', 'background', 'backgroundRepeat'], value: 'no-repeat' },
    { property: ['style', 'background', 'backgroundAttachment'], value: 'scroll' },
    { property: ['style', 'typography', 'textAlign'], value: 'left' },
    { property: ['style', 'typography', 'textColumns'], value: 2 },
    { property: ['style', 'typography', 'textIndent'], value: '1em' },
    { property: ['style', 'typography', 'writingMode'], value: 'vertical-rl' },
    { property: ['style', 'elements', 'link', 'color', 'text'], value: 'var:preset|color|accent' },
    { property: ['style', 'elements', 'button', 'color', 'background'], value: '#ddd' },
    { property: ['style', 'elements', 'h2', 'color', 'text'], value: '#333' },
    { property: ['style', 'color', 'duotone'], value: ['#111', '#eee'] },
  ];
  const edited = await styleEdit(f, patches);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal((await f.save()).persistence, 'verified');
  assert.equal(f.blocks[0].attributes.style.typography.fontSize, '20px');
  assert.deepEqual(copy(f.blocks[0].attributes.style.color.duotone), ['#111', '#eee']);

  delete f.window.__blockwork_editor;

  for (const patch of [
    { property: ['style', 'background', 'backgroundImage'], value: { url: 'private-input' } },
    { property: ['style', 'typography', 'textAlign'], value: 'right' },
    { property: ['style', 'color', 'duotone'], value: ['#000'] },
  ]) {
    const result = await styleEdit(f, [patch]);
    assert.equal(result.error, 'unsupported_style_value', JSON.stringify(result));
    assert.equal(result.diagnostics.patch_index, 0);
    assert.equal(result.diagnostics.field, 'edits.0.set.0.value');
    assert.equal(JSON.stringify(result).includes('private-input'), false);
  }

  f.editorSettings.__experimentalFeatures.background = { backgroundSize: false };
  const disabled = await styleEdit(f, [patches[1]]);
  assert.equal(disabled.error, 'unsupported_style_property');
  f.editorSettings.__experimentalFeatures.color.customDuotone = false;
  assert.equal((await styleEdit(f, [patches.at(-1)])).error, 'custom_style_disabled');
});

test('style failures distinguish inserted planned targets from moved pre-existing live targets', async () => {
  for (const inserted of [true, false]) {
    const f = stylingFixture();
    const before = copy(f.blocks);
    await f.call('connect', { workflow: 'attached', style_guides: [{ name: 'core/group' }] });
    const result = await f.call('edit', { edits: [
      { op: 'insert', block: { name: 'core/group' }, index: inserted ? 1 : 0 },
      { op: 'update_style', path: [1], name: 'core/group', set: [{ property: ['style', 'border', 'right', 'color'], value: '#ddd' }] },
    ] });
    assert.equal(result.error, 'unsupported_style_property');
    assert.equal(result.diagnostics.edit_index, 1);
    assert.equal(result.diagnostics.path_space, 'planned');
    assert.equal(result.diagnostics.target_origin, inserted ? 'inserted_block' : 'existing_block');
    assert.deepEqual(copy(result.diagnostics.live_path), inserted ? undefined : [0]);
    assert.equal(result.diagnostics.field, 'edits.1.set.0.property');
    assert.match(result.hint, inserted ? /block this edit inserts/ : /live_path/);
    assert.deepEqual(f.blocks, before);
    assert.equal(f.saves, 0);
  }
});

test('written styles drop nested empty objects without touching other values', async () => {
  const f = fixture();
  await f.call('connect');
  const inserted = await f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/group',
    attributes: { style: { border: {}, spacing: { padding: { top: '4px' }, margin: {} } } } } }] });
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  const group = f.blocks.at(-1);
  assert.deepEqual(copy(group.attributes.style), { spacing: { padding: { top: '4px' } } });
  const updated = await f.call('edit', { edits: [{ op: 'update', client_id: group.clientId, attributes: { style: { color: {}, spacing: { padding: { left: '2px' } } } } }] });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.deepEqual(copy(group.attributes.style), { spacing: { padding: { top: '4px', left: '2px' } } });

  group.attributes.layout = { type: 'flex', options: { empty: {} } };
  group.attributes.style.typography = {};
  await f.call('read', { blocks: { client_id: group.clientId, depth: 0 } });
  const kept = await f.call('edit', { edits: [{ op: 'update', client_id: group.clientId, attributes: { layout: { options: { label: 'x' } }, style: { color: { text: 'red' } } } }] });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(copy(group.attributes.layout), { type: 'flex', options: { empty: {}, label: 'x' } });
  assert.deepEqual(copy(group.attributes.style.typography), {});
});

test('an attribute moved into block supports names its enabled style control', async () => {
  const f = stylingFixture();
  f.registrations['core/paragraph'].attributes.style = { type: 'object' };
  f.registrations['core/paragraph'].supports = {
    typography: { textAlign: true, __experimentalFontWeight: true, __experimentalDefaultControls: { textAlign: true } },
    dimensions: { minHeight: true }, __experimentalBorder: { radius: true }, color: { text: true, link: true },
  };
  await f.call('connect');
  const insert = (attributes) => f.call('edit', { edits: [{ op: 'insert', block: { name: 'core/paragraph', attributes } }] });

  for (const [attribute, path] of [
    ['textAlign', ['style', 'typography', 'textAlign']], ['fontWeight', ['style', 'typography', 'fontWeight']],
    ['minHeight', ['style', 'dimensions', 'minHeight']], ['radius', ['style', 'border', 'radius']], ['text', ['style', 'color', 'text']],
  ]) {
    const refused = await insert({ [attribute]: 'center' });
    assert.equal(refused.error, 'unsupported_attribute', attribute);
    assert.deepEqual(copy(refused.diagnostics.use_instead), path);
    assert.match(refused.hint, /diagnostics\.use_instead/);
  }

  for (const attribute of ['nope', 'link', 'defaultControls', '__experimentalFontWeight']) {
    const refused = await insert({ [attribute]: 1 });
    assert.equal(refused.error, 'unsupported_attribute', attribute);
    assert.equal(refused.diagnostics.use_instead, undefined, attribute);
    assert.doesNotMatch(refused.hint, /use_instead/);
  }
});

test('style guide entries with dotted property strings get a shape hint', async () => {
  const f = fixture();
  await f.call('connect');
  const refused = await f.call('read', { style_guides: [{ name: 'core/group', properties: ['style.spacing'] }] });
  assert.equal(refused.error, 'invalid_read');
  assert.equal(refused.issues[0].path, 'style_guides.0');
  assert.match(refused.issues[0].hint, /\[\["layout"\], \["style","spacing"\]\]/);
});
