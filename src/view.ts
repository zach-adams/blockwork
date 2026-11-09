import type { JsonObject, Session, Width } from './contracts';
import type { WordPress } from './wordpress';
import { requireCondition as assert } from './inspection';
import { requireCanvas } from './canvas';
import { pause, remainingMs } from './timing';
import { editorBreakpoints } from './styling';

// Gutenberg's own View menu: the canvas reflows at each width without a reload.
// Tablet and mobile are its previews at the site's breakpoints. Desktop and
// exact widths use the Desktop preview, which fills the space the window gives.
const devices = new Map<Width, string>([
  ['desktop', 'Desktop'],
  ['tablet', 'Tablet'],
  ['mobile', 'Mobile'],
]);
// Desktop in Blockwork's own background tab, where the host can size the window.
const desktopWidth = 1440;
// Below this window width wp-admin switches to its small-screen layout, and
// List View covers the canvas.
const smallestWindow = 782;

function canvasFrame(): HTMLIFrameElement {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]');
  assert(frame?.contentDocument?.body?.childElementCount, 'native_render_unavailable');

  return frame;
}

// The canvas document and every editor container around the iframe; scrolling
// a block into view may move any of them.
function scrollers(frame: HTMLIFrameElement): Element[] {
  const list: Element[] = [];

  if (frame.contentDocument?.scrollingElement) {
    list.push(frame.contentDocument.scrollingElement);
  }

  for (let node = frame.parentElement; node; node = node.parentElement) {
    list.push(node);
  }

  return list;
}

function frames(view: Window): Promise<void> {
  // Hidden tabs may never paint, so frames race a short timer.
  return Promise.race([
    new Promise<void>((resolve) =>
      view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())),
    ),
    pause(100),
  ]);
}

// Device changes animate the canvas size for a few hundred milliseconds.
async function canvasSettled(frame: HTMLIFrameElement): Promise<void> {
  const until = Date.now() + 3000;
  let last = '';
  let stable = 0;

  while (stable < 3 && Date.now() < until) {
    await pause(50);
    const bounds = frame.getBoundingClientRect();
    const size = `${bounds.width}x${bounds.height}@${bounds.left},${bounds.top}`;
    stable = size === last ? stable + 1 : 0;
    last = size;
  }
}

// The canvas width Gutenberg gives its tablet or mobile preview: the
// breakpoint less 1px, as its own setDeviceType computes it, or none when the
// site has no such breakpoint and the preview fills the space.
function presetWidth(wp: WordPress, width: 'tablet' | 'mobile'): number | undefined {
  const breakpoints = editorBreakpoints(wp);
  const breakpoint = breakpoints[width]?.pixels;
  const lower = width === 'tablet' ? (breakpoints.mobile?.pixels ?? 0) : 0;

  return breakpoint === undefined ? undefined : breakpoint - Math.min(1, (breakpoint - lower) / 2);
}

// Whether a user's canvas has a width Gutenberg cannot set again through its
// public API, so switching the preview would lose it: one they dragged it to,
// which differs from the width the current preview sets (Desktop sets none),
// or any while zoomed out, where Gutenberg hides the stored width.
function ownWidth(wp: WordPress, frame: HTMLIFrameElement, device: string): boolean {
  if (frame.contentDocument?.documentElement.classList.contains('is-zoomed-out')) {
    return true;
  }

  // An editor without Gutenberg's resizable canvas has no width to drag.
  const resizable = frame.closest<HTMLElement>('.editor-resizable-editor');

  if (!resizable) {
    return false;
  }

  const styled = resizable.style.width.match(/^(\d+(?:\.\d+)?)px$/);
  const set = styled ? Number(styled[1]) : undefined;
  let preset: number | undefined;

  if (device === devices.get('tablet')) {
    preset = presetWidth(wp, 'tablet');
  } else if (device === devices.get('mobile')) {
    preset = presetWidth(wp, 'mobile');
  }

  return set === undefined || preset === undefined ? set !== preset : Math.abs(set - preset) > 0.5;
}

// The canvas width a request needs, and whether this tab can reach it. A
// background tab asks the host to resize its window by returning `resize`; a
// user's editor is never resized, so it refuses instead of showing another
// width under this one's name. A narrow window squeezes a preset's canvas.
function fit(wp: WordPress, frame: HTMLIFrameElement, session: Session, width: Width): JsonObject {
  const canvas = Math.round(frame.clientWidth);
  const attached = session.workflow === 'attached';

  if (width === 'desktop' && attached) {
    return { width, canvas_width: canvas, width_source: 'user_editor' };
  }

  const preset = width === 'tablet' || width === 'mobile';
  let target = desktopWidth;

  if (width === 'tablet' || width === 'mobile') {
    target = presetWidth(wp, width) ?? canvas;
  } else if (width !== 'desktop') {
    target = width;
  }

  const result = { width, canvas_width: canvas, width_source: preset ? 'preset' : 'exact' };

  if (Math.abs(canvas - target) <= 1) {
    return result;
  }

  const windowWidth = Math.round(window.innerWidth + target - canvas);
  const diagnostics = { width, canvas_width: canvas, target_width: target };
  assert(!attached, 'width_unavailable', diagnostics);
  assert(windowWidth >= smallestWindow, 'width_unavailable', {
    ...diagnostics,
    window_width: windowWidth,
  });

  return { ...result, resize: { ...diagnostics, window_width: windowWidth } };
}

// Shows a width through Gutenberg's device preview and reports the canvas.
// The first call records the editor's own device and scroll positions, so
// restoreView can return a user's editor exactly as it was. A width Gutenberg
// cannot set again is checked live on every call, since the user may change it
// between calls; such an editor shows only its own Desktop canvas and is never
// switched. The canvas settles even without a device change, because the host
// may just have resized the window.
export async function showWidth(
  wp: WordPress,
  session: Session,
  width: Width,
): Promise<JsonObject> {
  const attached = session.workflow === 'attached';
  assert(devices.has(width) || !attached, 'width_requires_background', { width });
  const editor = wp.data.select('core/editor');
  const actions = wp.data.dispatch('core/editor');
  assert(editor.getDeviceType && actions.setDeviceType, 'native_device_preview_unavailable');
  const frame = canvasFrame();
  const current = editor.getDeviceType();
  const device = devices.get(width) ?? 'Desktop';

  session.view ??= {
    device: current,
    scroll: scrollers(frame).map((element) => ({
      element,
      top: element.scrollTop,
      left: element.scrollLeft,
    })),
  };

  assert(
    !attached || !ownWidth(wp, frame, current) || (width === 'desktop' && current === 'Desktop'),
    'custom_canvas_width',
    { width, device: current, canvas_width: Math.round(frame.clientWidth) },
  );

  if (current !== device) {
    actions.setDeviceType(device);
  }

  await canvasSettled(frame);

  return fit(wp, frame, session, width);
}

// The checkpoint stays until restoration ran, so a failure here is retried by
// the next operation. Restoring needs no canvas; a missing one is skipped. A
// width the user set since the checkpoint, such as by dragging the canvas
// after a lost restore, is theirs and keeps its preview. The canvas settles
// before scrolling, since the host may just have resized it.
export async function restoreView(wp: WordPress, session: Session): Promise<void> {
  const saved = session.view;

  if (!saved) {
    return;
  }

  const frame = document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]');
  const device = wp.data.select('core/editor').getDeviceType?.();
  const theirs = session.workflow === 'attached' && frame && ownWidth(wp, frame, device ?? '');

  if (device !== saved.device && !theirs) {
    wp.data.dispatch('core/editor').setDeviceType?.(saved.device);
  }

  if (frame) {
    await canvasSettled(frame);
  }

  // Themes may set scroll-behavior: smooth; every scroll here is instant.
  for (const { element, top, left } of saved.scroll) {
    element.scrollTo({ top, left, behavior: 'instant' });
  }

  session.view = undefined;
}

// Images inside the block load once scrolled near the viewport. Wait briefly
// for them and for web fonts so the screenshot shows the finished render.
async function loaded(element: Element, canvas: Document): Promise<void> {
  const until = Date.now() + 3000;
  const images = [...element.querySelectorAll('img')];

  while (images.some((image) => !image.complete) && Date.now() < until) {
    await pause(50);
  }

  if (canvas.fonts) {
    await Promise.race([canvas.fonts.ready, pause(Math.max(0, until - Date.now()))]);
  }
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function intersect(first: Box, second: Box): Box {
  return {
    left: Math.max(first.left, second.left),
    top: Math.max(first.top, second.top),
    right: Math.min(first.right, second.right),
    bottom: Math.min(first.bottom, second.bottom),
  };
}

// The part of the canvas a screenshot can show: the iframe's content box,
// within the window and every editor container that clips it.
function visibleCanvas(frame: HTMLIFrameElement, scale: number): Box {
  const outer = frame.getBoundingClientRect();
  const left = outer.left + frame.clientLeft * scale;
  const top = outer.top + frame.clientTop * scale;
  let region = intersect(
    {
      left,
      top,
      right: left + frame.clientWidth * scale,
      bottom: top + frame.clientHeight * scale,
    },
    { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
  );

  for (let node = frame.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflow !== 'visible') {
      const bounds = node.getBoundingClientRect();
      region = intersect(region, {
        left: bounds.left + node.clientLeft,
        top: bounds.top + node.clientTop,
        right: bounds.left + node.clientLeft + node.clientWidth,
        bottom: bounds.top + node.clientTop + node.clientHeight,
      });
    }
  }

  return region;
}

// The block's box in canvas pixels, or none when it is hidden. A
// `display: contents` wrapper, such as Page List in a spaced Navigation, has no
// box of its own, so its children's boxes make up the block.
function contentBox(element: Element, view: Window): Box | undefined {
  if (view.getComputedStyle(element).display === 'contents') {
    const boxes = [...element.children].flatMap((child) => contentBox(child, view) ?? []);

    return boxes.length
      ? {
          left: Math.min(...boxes.map((box) => box.left)),
          top: Math.min(...boxes.map((box) => box.top)),
          right: Math.max(...boxes.map((box) => box.right)),
          bottom: Math.max(...boxes.map((box) => box.bottom)),
        }
      : undefined;
  }

  const { left, top, right, bottom } = element.getBoundingClientRect();

  return right > left && bottom > top ? { left, top, right, bottom } : undefined;
}

// The part of a canvas box that containers inside the canvas leave visible:
// each ancestor whose overflow is not visible clips it to its padding box on
// that axis, such as a carousel track hiding the slides beside it.
function containedBox(element: Element, view: Window, root: Element, box: Box): Box {
  let region = box;

  for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    const clipsX = style.overflowX !== 'visible';
    const clipsY = style.overflowY !== 'visible';

    if (style.display === 'contents' || (!clipsX && !clipsY)) {
      continue;
    }

    const bounds = node.getBoundingClientRect();
    const left = bounds.left + node.clientLeft;
    const top = bounds.top + node.clientTop;
    region = intersect(region, {
      left: clipsX ? left : region.left,
      top: clipsY ? top : region.top,
      right: clipsX ? left + node.clientWidth : region.right,
      bottom: clipsY ? top + node.clientHeight : region.bottom,
    });
  }

  return region;
}

// A canvas box in top-level page pixels.
function pageBox(frame: HTMLIFrameElement, box: Box, scale: number): Box {
  const outer = frame.getBoundingClientRect();
  const left = outer.left + frame.clientLeft * scale;
  const top = outer.top + frame.clientTop * scale;

  return {
    left: left + box.left * scale,
    top: top + box.top * scale,
    right: left + box.right * scale,
    bottom: top + box.bottom * scale,
  };
}

// Brings the block's left edge into each horizontal scroller around it inside
// the canvas, such as a scrolling card row. Their positions join the view's
// checkpoint first, so restoreView puts them back; a scroll-snapped row may
// settle on its nearest snap point. Carousels that move slides with transforms
// or hidden overflow are left alone.
function alignInline(element: Element, view: Window, session: Session): void {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = view.getComputedStyle(node).overflowX;

    if (node.scrollWidth <= node.clientWidth || !['auto', 'scroll'].includes(overflow)) {
      continue;
    }

    const box = contentBox(element, view);

    if (!box) {
      return;
    }

    const left = node.getBoundingClientRect().left + node.clientLeft;

    if (box.left >= left && box.right <= left + node.clientWidth) {
      continue;
    }

    if (!session.view?.scroll.some((saved) => saved.element === node)) {
      session.view?.scroll.push({ element: node, top: node.scrollTop, left: node.scrollLeft });
    }

    node.scrollTo({ left: node.scrollLeft + box.left - left, behavior: 'instant' });
  }
}

// Brings `offset` canvas pixels into the block to the top of the visible
// canvas: the canvas document scrolls first, then each container around it,
// so a slice still lines up when the canvas itself cannot scroll further.
function align(
  frame: HTMLIFrameElement,
  element: Element,
  view: Window,
  offset: number,
  scale: number,
): void {
  const inner = frame.contentDocument?.scrollingElement;
  const scrollers: Array<[Element, number]> = inner ? [[inner, scale]] : [];

  for (let node = frame.parentElement; node; node = node.parentElement) {
    scrollers.push([node, 1]);
  }

  for (const [scroller, factor] of scrollers) {
    const box = contentBox(element, view);

    if (!box) {
      return;
    }

    const delta = pageBox(frame, box, scale).top + offset * scale - visibleCanvas(frame, scale).top;

    if (Math.abs(delta) < 1) {
      return;
    }

    scroller.scrollTo({ top: scroller.scrollTop + delta / factor, behavior: 'instant' });
  }
}

// Scrolls one block into the canvas at a width and returns the part that is
// visible, in top-level page pixels for the screenshot clip. offset
// skips the part of a tall block an earlier slice already showed. A width this
// tab must first be resized for returns the fit's `resize` without placing.
export async function placeBlock(
  wp: WordPress,
  session: Session,
  clientId: string,
  width: Width,
  offset: number,
): Promise<JsonObject> {
  await requireCanvas([clientId]);
  const fitted = await showWidth(wp, session, width);

  if (fitted.resize) {
    return { ok: true, ...fitted };
  }

  const frame = canvasFrame();
  const canvas = frame.contentDocument!;
  const view = frame.contentWindow!;
  let element = canvas.getElementById(`block-${clientId}`);
  assert(element, 'block_not_rendered', { client_id: clientId, width });
  const scale = frame.clientWidth ? frame.getBoundingClientRect().width / frame.clientWidth : 1;
  const hidden = { ok: true, ...fitted, rendered: false, block_height: 0 };
  // A block edited a moment ago can lack a layout box for a few frames. Report
  // it hidden only once it has had a second to lay out.
  const until = Date.now() + Math.min(1000, remainingMs());

  while (!contentBox(element, view)) {
    if (Date.now() >= until) {
      return hidden;
    }

    await pause(50);
    element = canvas.getElementById(`block-${clientId}`) ?? element;
  }

  alignInline(element, view, session);
  // Slices walk the part of the block its containers in the canvas show, so a
  // container hiding the block's top moves the first slice down to it.
  const root = canvas.documentElement;
  const start = (): number | undefined => {
    const now = contentBox(element, view);

    return now && Math.max(offset, containedBox(element, view, root, now).top - now.top);
  };

  let from = start();

  if (from === undefined) {
    return hidden;
  }

  align(frame, element, view, from, scale);
  await frames(view);
  await loaded(element, canvas);
  // Late images and fonts can change layout, including how much of the block
  // a container hides; line the slice up again and measure it as it is now.
  alignInline(element, view, session);
  from = start();

  if (from === undefined) {
    return hidden;
  }

  align(frame, element, view, from, scale);
  await frames(view);

  const box = contentBox(element, view);

  if (!box) {
    return hidden;
  }

  const height = Math.round(box.bottom - box.top);
  const block = pageBox(frame, box, scale);
  const visible = visibleCanvas(frame, scale);
  // The part any slice can show: what containers in the canvas leave, within
  // the canvas's sides. Scrolling reaches the rest of its height.
  const kept = intersect(pageBox(frame, containedBox(element, view, root, box), scale), {
    left: visible.left,
    top: -Infinity,
    right: visible.right,
    bottom: Infinity,
  });
  const clip = intersect(intersect(kept, visible), { ...block, top: block.top + from * scale });
  assert(clip.bottom > clip.top && clip.right > clip.left, 'block_clipped', {
    client_id: clientId,
    width,
  });
  const shownTo = Math.round((clip.bottom - block.top) / scale);

  return {
    ok: true,
    ...fitted,
    rendered: true,
    // The screenshot clip is in document pixels, so the top-level page's own
    // scroll is added; wp-admin's editor seldom scrolls.
    clip: {
      x: Math.floor(clip.left + window.scrollX),
      y: Math.floor(clip.top + window.scrollY),
      width: Math.ceil(clip.right + window.scrollX - Math.floor(clip.left + window.scrollX)),
      height: Math.ceil(clip.bottom + window.scrollY - Math.floor(clip.top + window.scrollY)),
    },
    // No slice can show part of the block.
    clipped:
      kept.left > block.left + 1 ||
      kept.top > block.top + 1 ||
      kept.right < block.right - 1 ||
      kept.bottom < block.bottom - 1,
    block_height: height,
    from: Math.round((clip.top - block.top) / scale),
    to: shownTo,
    next_offset: clip.bottom < kept.bottom - 1 ? shownTo : null,
  };
}
