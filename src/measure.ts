import type { BlockSummary, JsonObject } from './contracts';
import { pause } from './timing';
import type { WordPress } from './wordpress';
import { liveRow, requireCondition as assert } from './inspection';
import { requireCanvas } from './canvas';

const defaultProperties = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'padding',
  'margin',
];

const parts = [
  ['link', '.wp-block-button__link'],
  ['image', 'img'],
  ['text', 'h1,h2,h3,h4,h5,h6,p'],
];

function evidence(element: Element, view: Window, part: string, properties: string[]): JsonObject {
  const bounds = element.getBoundingClientRect();
  const computed = view.getComputedStyle(element);
  const round = (value: number) => Math.round(value * 10) / 10;

  return {
    part,
    tag: element.tagName.toLowerCase(),
    rect: {
      x: round(bounds.x),
      y: round(bounds.y),
      width: round(bounds.width),
      height: round(bounds.height),
    },
    styles: Object.fromEntries(
      properties.map((property) => [property, computed.getPropertyValue(property).slice(0, 200)]),
    ),
  };
}

// Failed faces explain wrong typography faster than repeated restyling.
// Only faces the canvas tried to load appear; unused families stay unloaded.
function fonts(canvas: Document): JsonObject {
  const faces = canvas.fonts ? [...canvas.fonts] : [];
  const failed = faces
    .filter((face) => face.status === 'error')
    .map((face) => `${face.family.replaceAll('"', '')} ${face.weight} ${face.style}`);

  return {
    status: canvas.fonts?.status ?? 'unavailable',
    failed: [...new Set(failed)].slice(0, 10),
    loading: faces.filter((face) => face.status === 'loading').length,
  };
}

// Reads the editor canvas only, mounting a blank one first. It never scrolls,
// selects, or edits.
export async function measureBlocks(
  wp: WordPress,
  rows: BlockSummary[],
  options: { blocks: string[]; properties?: string[] },
): Promise<JsonObject> {
  const targets = options.blocks.map((id, index) => liveRow(rows, id, `blocks.${index}`));
  await requireCanvas(targets.map((row) => row.clientId));
  const properties = (options.properties?.length ? options.properties : defaultProperties).map(
    (property) => (property.startsWith('--') ? property : property.replaceAll('_', '-')),
  );
  const frame = document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]');
  const canvas = frame ? frame.contentDocument : document;
  const view = canvas?.defaultView;
  assert(
    wp.data && canvas && view?.getComputedStyle && canvas.body?.childElementCount,
    'native_render_unavailable',
  );

  // Let React commit pending block renders. Hidden tabs may never paint, so
  // animation frames race a short timer instead of being required.
  await pause(0);
  await Promise.race([
    new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve))),
    pause(150),
  ]);

  if (canvas.fonts) {
    await Promise.race([canvas.fonts.ready, new Promise((resolve) => setTimeout(resolve, 1500))]);
  }

  const blocks = targets.map((row) => {
    const wrapper = canvas.getElementById(`block-${row.clientId}`);
    const result: JsonObject = { client_id: row.clientId, name: row.name };

    if (!wrapper) {
      return { ...result, rendered: false };
    }

    const box = wrapper.getBoundingClientRect();

    // A closed panel or a block hidden at this width has no box, and its
    // computed styles say nothing about its layout. A `display: contents`
    // wrapper, such as Page List in a spaced Navigation, has no box but
    // lays out visible children.
    if ((!box.width || !box.height) && view.getComputedStyle(wrapper).display !== 'contents') {
      return { ...result, rendered: false };
    }

    const elements = [evidence(wrapper, view, 'block', properties)];

    for (const [part, selector] of parts) {
      const element: Element | null = wrapper.matches(selector)
        ? wrapper
        : wrapper.querySelector(selector);

      if (element && element !== wrapper) {
        elements.push(evidence(element, view, part, properties));
      }
    }

    return { ...result, rendered: true, elements };
  });
  const result = {
    canvas: frame ? 'iframe' : 'document',
    viewport: {
      width: view.innerWidth,
      height: view.innerHeight,
      scroll_width: canvas.documentElement.scrollWidth,
    },
    fonts: fonts(canvas),
    blocks,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
  assert(bytes <= 64 * 1024, 'measure_response_too_large', {
    response_bytes: bytes,
    max_bytes: 64 * 1024,
  });

  return result;
}
