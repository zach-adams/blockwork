import assert from 'node:assert/strict';
import test from 'node:test';
import { changes, copy, fixture, canvasRoot, stalledCanvas, canvasBlock, sizedEditor } from './helpers/editor-fixture.mjs';

test('edit measurement failure leaves a successful edit and usable revert', async () => {
  const f = fixture();
  await f.call('connect', { workflow: 'attached' });
  const edited = await f.call('edit', { edits: changes, measure: true });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(edited.editor_result, 'applied');
  assert.equal(edited.measure.ok, false);
  assert.equal(edited.measure.error, 'native_render_unavailable');
  assert.equal(f.blocks[0].attributes.content, 'After');
  assert.equal((await f.call('status')).last_request.outcome, 'applied');
  assert.equal((await f.call('revert')).ok, true);
});

test('measure reads the canvas window and reports font loading failures without editor actions', async () => {
  const f = fixture();
  const wrapper = { tagName: 'P', getBoundingClientRect: () => ({ x: 12.34, y: 4, width: 120, height: 30 }), matches: () => false, querySelector: () => null };
  const faces = [{ family: '"Body"', weight: '400', style: 'normal', status: 'error' }, { family: 'Body', weight: '400', style: 'normal', status: 'error' }, { family: 'Display', status: 'loading' }];
  faces.status = 'loading'; faces.ready = Promise.resolve();
  const closed = { ...wrapper, display: 'block', getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }) };
  const contents = { ...closed, display: 'contents' };
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: { scrollWidth: 400 }, fonts: faces,
    getElementById: id => ({ 'block-a': wrapper, 'block-c': closed })[id] ?? null,
    defaultView: { innerWidth: 400, innerHeight: 800, requestAnimationFrame: callback => callback(),
      getComputedStyle: element => { assert.ok([wrapper, closed, contents].includes(element));

 return { display: element.display, getPropertyValue: property => property === 'font-size' ? '18px' : 'Body' }; } },
  } };
  await f.call('connect', { workflow: 'attached' });
  f.onSelect = () => assert.fail('Measurement changed selection');
  const measured = await f.call('measure', { blocks: ['a', 'b', 'c'], properties: ['font_size', 'font-family'] });
  assert.equal(measured.ok, true, JSON.stringify(measured));
  assert.equal(measured.canvas, 'iframe');
  assert.deepEqual(copy(measured.fonts), { status: 'loading', failed: ['Body 400 normal'], loading: 1 });
  assert.deepEqual(copy(measured.blocks[0].elements[0].rect), { x: 12.3, y: 4, width: 120, height: 30 });
  assert.deepEqual(copy(measured.blocks[0].elements[0].styles), { 'font-size': '18px', 'font-family': 'Body' });
  assert.equal(measured.blocks[1].rendered, false);
  // A closed panel's zero box and styles would read as real geometry.
  assert.deepEqual(copy(measured.blocks[2]), { client_id: 'c', name: 'core/paragraph', rendered: false });
  // A display: contents wrapper has no box of its own, but its children render.
  f.frame.contentDocument.getElementById = id => (id === 'block-c' ? contents : null);
  const unboxed = await f.call('measure', { blocks: ['c'] });
  assert.equal(unboxed.blocks[0].rendered, true);
  assert.equal(f.dirty, false);
});

test('a failed view leaves its checkpoint, and the next operation restores the editor', async () => {
  const f = fixture();
  const scroller = { scrollTop: 40, scrollLeft: 0, scrollTo({ top, left }) { this.scrollTop = top; this.scrollLeft = left; } };
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), scrollingElement: scroller, getElementById: () => null },
    parentElement: null, closest: () => null, getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0 }),
    get clientWidth() { return f.device === 'Mobile' ? 479 : 100; } };
  f.device = 'Desktop';
  f.window.wp.data.select('core/editor').getDeviceType = () => f.device;
  f.window.wp.data.dispatch('core/editor').setDeviceType = (device) => { f.device = device; };

  await f.call('connect', { workflow: 'attached' });

  const failed = await f.call('view', { client_id: 'a', width: 'mobile' });
  assert.equal(failed.error, 'block_not_rendered', JSON.stringify(failed));
  assert.equal(f.device, 'Mobile');
  scroller.scrollTop = 900;
  assert.equal((await f.call('read')).ok, true);
  assert.equal(f.device, 'Desktop');
  assert.equal(scroller.scrollTop, 40);
  assert.equal(f.window.__blockwork_editor.view, undefined);
});

test('view places a display: contents block by its children', async () => {
  const f = fixture();
  const child = (top, height) => ({ display: 'block', children: [], getBoundingClientRect: () => ({ left: 10, top, right: 110, bottom: top + height }) });
  const wrapper = { display: 'contents', children: [child(20, 30), child(60, 40)], querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) };
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), getElementById: (id) => (id === 'block-a' ? wrapper : null) },
    contentWindow: { getComputedStyle: (element) => ({ display: element.display }), requestAnimationFrame: (callback) => callback() },
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');

  await f.call('connect', { workflow: 'attached' });
  const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(placed.rendered, true, JSON.stringify(placed));
  assert.equal(placed.block_height, 80);
  assert.deepEqual(copy(placed.clip), { x: 10, y: 20, width: 100, height: 80 });
  // The host's clip is in document pixels, so the page's own scroll is added.
  f.window.scrollY = 40;
  assert.deepEqual(copy((await f.call('view', { client_id: 'a', width: 'desktop' })).clip), { x: 10, y: 60, width: 100, height: 80 });
});

test('view waits briefly for a just-edited block to lay out before reporting it hidden', async () => {
  for (const laidOutAfter of [3, Infinity]) {
    const f = fixture();
    let checks = 0;
    const block = { display: 'block', children: [], querySelectorAll: () => [], getBoundingClientRect: () => (++checks > laidOutAfter
      ? { left: 10, top: 20, right: 110, bottom: 70 } : { left: 0, top: 0, right: 0, bottom: 0 }) };
    f.window.innerWidth = 1000;
    f.window.innerHeight = 1000;
    f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), getElementById: (id) => (id === 'block-a' ? block : null) },
      contentWindow: { getComputedStyle: (element) => ({ display: element.display }), requestAnimationFrame: (callback) => callback() },
      parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
      getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
    f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
    f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');
    await f.call('connect', { workflow: 'attached' });
    const started = Date.now();
    const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
    assert.equal(placed.ok, true, JSON.stringify(placed));
    assert.equal(placed.rendered, laidOutAfter !== Infinity, JSON.stringify(placed));
    assert.ok(Date.now() - started < 2000);
  }
});

test('view scrolls a card row to the block and restores it, and reports a card clipped by its track', async () => {
  const f = fixture();
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  // A row 500px wide whose sixth card starts 600px in, past its right edge.
  const row = (overflowX, width = 500) => ({ overflowX, display: 'flex', scrollLeft: 0, scrollTop: 0, scrollWidth: 1000, clientWidth: width, clientTop: 0,
    clientHeight: 300, clientLeft: 0, parentElement: null, getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: 300 }),
    scrollTo({ left }) { this.scrollLeft = left; } });
  const card = (parent, left = 600) => ({ display: 'block', parentElement: parent, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: left - parent.scrollLeft, top: 20, right: left + 100 - parent.scrollLeft, bottom: 100 }) });
  let block;
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), getElementById: (id) => (id === 'block-a' ? block : null) },
    contentWindow: { getComputedStyle: (element) => ({ display: element.display, overflowX: element.overflowX ?? 'visible', overflowY: 'visible' }),
      requestAnimationFrame: (callback) => callback() },
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');
  await f.call('connect', { workflow: 'attached' });

  const scrolling = row('auto');
  block = card(scrolling);
  const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(placed.rendered, true, JSON.stringify(placed));
  assert.deepEqual(copy(placed.clip), { x: 0, y: 20, width: 100, height: 80 });
  assert.equal(scrolling.scrollLeft, 600);
  assert.equal((await f.call('restore_view')).ok, true);
  assert.equal(scrolling.scrollLeft, 0);

  block = card(row('hidden'));
  const clipped = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(clipped.error, 'block_clipped', JSON.stringify(clipped));
  assert.match(clipped.hint, /container block/);

  // A 100px track inside the canvas hides a slide 200px in, and half of one 50px in.
  block = card(row('hidden', 100), 200);
  assert.equal((await f.call('view', { client_id: 'a', width: 'desktop' })).error, 'block_clipped');
  block = card(row('hidden', 100), 50);
  const half = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([half.clipped, half.clip.width, half.next_offset], [true, 50, null]);
});

test('view shows only the part of a block its containers leave visible, and slices only toward more of it', async () => {
  const f = fixture();
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  const parent = (top, bottom) => ({ display: 'block', overflowX: 'visible', overflowY: 'hidden', parentElement: null, clientLeft: 0, clientTop: 0,
    clientWidth: 500, clientHeight: bottom - top, getBoundingClientRect: () => ({ left: 0, top, right: 500, bottom }) });
  const child = (container, top, bottom) => ({ display: 'block', parentElement: container, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top, right: 400, bottom }) });
  let block;
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), getElementById: (id) => (id === 'block-a' ? block : null) },
    contentWindow: { getComputedStyle: (element) => ({ display: element.display, overflowX: element.overflowX ?? 'visible', overflowY: element.overflowY ?? 'visible' }),
      requestAnimationFrame: (callback) => callback() },
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');
  await f.call('connect', { workflow: 'attached' });

  // A container hides the top 50px of a 100px block.
  block = child(parent(50, 300), 0, 100);
  const top = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([top.from, top.to, top.clipped, top.next_offset], [50, 100, true, null], JSON.stringify(top));
  // An 800px container at the canvas's own height hides the rest of a 1600px block.
  block = child(parent(0, 800), 0, 1600);
  const tall = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([tall.from, tall.to, tall.clipped, tall.next_offset], [0, 800, true, null], JSON.stringify(tall));
  // Without the container, the canvas edge cuts it and the next slice continues.
  block = child(null, 0, 1600);
  const open = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([open.to, open.clipped, open.next_offset], [800, false, 800], JSON.stringify(open));
});

test('view starts the first slice where a container shows the block after its images load', async () => {
  const f = fixture();
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  // The canvas scrolls a document where an 800px container at 1000px hides the
  // top of a bottom-aligned block, which grows from 850px to 1700px once its
  // image loads.
  const doc = { scrollTop: 0, scrollLeft: 0, scrollTo({ top }) { this.scrollTop = top; } };
  const rect = (top, bottom) => ({ left: 0, right: 400, top: top - doc.scrollTop, bottom: bottom - doc.scrollTop });
  let height = 850;
  let ready = false;
  let checks = 0;
  const image = { get complete() {
    if (!checks++) setTimeout(() => { height = 1700; ready = true; }, 10);

    return ready;
  } };
  const container = { display: 'block', overflowX: 'visible', overflowY: 'hidden', parentElement: null, clientLeft: 0, clientTop: 0,
    clientWidth: 500, clientHeight: 800, getBoundingClientRect: () => rect(1000, 1800) };
  const block = { display: 'block', parentElement: container, querySelectorAll: () => [image], getBoundingClientRect: () => rect(1800 - height, 1800) };
  f.frame = { contentDocument: { body: { childElementCount: 1 }, documentElement: canvasRoot(), scrollingElement: doc,
    getElementById: (id) => (id === 'block-a' ? block : null) },
    contentWindow: { getComputedStyle: (element) => ({ display: element.display, overflowX: element.overflowX ?? 'visible', overflowY: element.overflowY ?? 'visible' }),
      requestAnimationFrame: (callback) => callback() },
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');
  await f.call('connect', { workflow: 'attached' });

  const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([placed.from, placed.to, placed.clipped, placed.next_offset], [900, 1700, true, null], JSON.stringify(placed));
});

test('view mounts a blank native canvas and waits for the block before placing it', async () => {
  const f = fixture();
  f.window.innerWidth = 1000;
  f.window.innerHeight = 1000;
  stalledCanvas(f, canvasBlock());
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');

  await f.call('connect', { workflow: 'attached' });
  const placed = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(placed.rendered, true, JSON.stringify(placed));
  assert.deepEqual(copy(placed.clip), { x: 10, y: 20, width: 100, height: 80 });
  assert.equal(f.frame.srcdoc, f.canvasHtml);
  assert.equal(f.blobReads, 1);
});

test('measure at a device width waits for blocks in a newly mounted canvas', async () => {
  const f = fixture();
  stalledCanvas(f, canvasBlock());
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('The device was already desktop');

  await f.call('connect', { workflow: 'attached' });
  const measured = await f.call('measure', { blocks: ['a'], width: 'desktop' });
  assert.equal(measured.ok, true, JSON.stringify(measured));
  assert.equal(measured.blocks[0].rendered, true);
  assert.equal(f.blobReads, 1);
});

test('view reports a canvas that stays blank after reloading it, before changing the device', async () => {
  const f = fixture();
  stalledCanvas(f, null, { mounts: false });
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('A blank canvas changed the device');

  await f.call('connect', { workflow: 'attached' });
  const failed = await f.call('view', { client_id: 'a', width: 'mobile' });
  assert.equal(failed.error, 'native_render_unavailable', JSON.stringify(failed));
  assert.equal(failed.diagnostics.canvas_reloaded, true);
  assert.match(failed.hint, /front end/);
  assert.equal(f.blobReads, 1);
});

test('view sizes the canvas only in its own tab and refuses widths a user editor cannot show', async () => {
  const owned = fixture();
  sizedEditor(owned);
  await owned.call('connect');
  const resize = await owned.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual(copy(resize.resize), { width: 'desktop', canvas_width: 930, target_width: 1440, window_width: 1790 });
  assert.equal(resize.rendered, undefined);
  owned.window.innerWidth = 1790;
  const placed = await owned.call('view', { client_id: 'a', width: 'desktop' });
  assert.equal(placed.rendered, true, JSON.stringify(placed));
  assert.deepEqual([placed.canvas_width, placed.width_source, placed.clipped], [1440, 'exact', false]);
  // A 400px canvas would need a 750px window, where wp-admin covers the canvas.
  const narrow = await owned.call('view', { client_id: 'a', width: 400 });
  assert.equal(narrow.error, 'width_unavailable', JSON.stringify(narrow));
  assert.equal(narrow.diagnostics.window_width, 750);

  const user = fixture();
  sizedEditor(user);
  await user.call('connect', { workflow: 'attached' });
  const exact = await user.call('view', { client_id: 'a', width: 1440 });
  assert.equal(exact.error, 'width_requires_background', JSON.stringify(exact));
  assert.equal(user.device, 'Desktop');
  user.window.innerWidth = 1100;
  const squeezed = await user.call('view', { client_id: 'a', width: 'tablet' });
  assert.equal(squeezed.error, 'width_unavailable', JSON.stringify(squeezed));
  assert.deepEqual(copy(squeezed.diagnostics), { width: 'tablet', canvas_width: 702, target_width: 781 });
  assert.equal((await user.call('restore_view')).ok, true);
  assert.equal(user.device, 'Desktop');
  const own = await user.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([own.canvas_width, own.width_source], [750, 'user_editor']);
});

test('a user editor dragged to its own canvas width is never switched away from it', async () => {
  const f = fixture();
  sizedEditor(f);
  await f.call('connect', { workflow: 'attached' });
  f.device = 'Tablet';
  f.box.style.width = '600px';
  f.window.wp.data.dispatch('core/editor').setDeviceType = () => assert.fail('A custom canvas width was reset');

  for (const width of ['tablet', 'mobile', 'desktop']) {
    const refused = await f.call('view', { client_id: 'a', width });
    assert.equal(refused.error, 'custom_canvas_width', JSON.stringify(refused));
    assert.deepEqual(copy(refused.diagnostics), { width, device: 'Tablet', canvas_width: 600 });
  }

  // Zoomed out, Gutenberg reports Desktop and hides its stored width.
  assert.equal((await f.call('restore_view')).ok, true);
  f.device = 'Desktop';
  f.box.style.width = '100%';
  f.zoomedOut = true;
  assert.equal((await f.call('view', { client_id: 'a', width: 'tablet' })).error, 'custom_canvas_width');
  assert.equal((await f.call('view', { client_id: 'a', width: 'desktop' })).width_source, 'user_editor');
  f.zoomedOut = false;

  // A custom width wider than the tablet range is a Desktop canvas, shown as is.
  assert.equal((await f.call('restore_view')).ok, true);
  f.device = 'Desktop';
  f.box.style.width = '880px';
  const own = await f.call('view', { client_id: 'a', width: 'desktop' });
  assert.deepEqual([own.rendered, own.canvas_width, own.width_source], [true, 880, 'user_editor']);
  assert.equal((await f.call('view', { client_id: 'a', width: 'mobile' })).error, 'custom_canvas_width');
});

test('a width the user drags after a lost restore stays theirs', async () => {
  const f = fixture();
  sizedEditor(f);
  f.window.innerWidth = 1600;
  await f.call('connect', { workflow: 'attached' });
  assert.equal((await f.call('measure', { blocks: ['a'], width: 'tablet' })).width_source, 'preset');
  // The host's restore never arrives, and the user drags the Tablet canvas.
  f.box.style.width = '600px';
  const dispatch = f.window.wp.data.dispatch('core/editor');
  const setDeviceType = dispatch.setDeviceType;
  dispatch.setDeviceType = () => assert.fail('A dragged width was reset');
  assert.equal((await f.call('measure', { blocks: ['a'], width: 'mobile' })).error, 'custom_canvas_width');
  assert.equal((await f.call('read')).ok, true);
  assert.deepEqual([f.device, f.box.style.width, f.window.__blockwork_editor.view], ['Tablet', '600px', undefined]);
  dispatch.setDeviceType = setDeviceType;
});

test('a measure at a width keeps the editor in that preview until the view is restored', async () => {
  const f = fixture();
  sizedEditor(f);
  f.window.innerWidth = 1100;
  await f.call('connect');
  const resize = await f.call('measure', { blocks: ['a'], width: 'tablet' });
  assert.deepEqual(copy(resize.resize), { width: 'tablet', canvas_width: 702, target_width: 781, window_width: 1179 });
  f.window.innerWidth = 1179;
  const measured = await f.call('measure', { blocks: ['a'], width: 'tablet' });
  assert.equal(measured.ok, true, JSON.stringify(measured));
  assert.deepEqual([measured.canvas_width, measured.width_source], [781, 'preset']);
  assert.equal(f.device, 'Tablet');
  assert.equal((await f.call('restore_view')).ok, true);
  assert.equal(f.device, 'Desktop');
});
