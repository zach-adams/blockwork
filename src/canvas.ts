import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { WordPress } from './wordpress';
import { limit, pause } from './timing';
import type { Deadline } from './timing';
import { blockState, readTree, requireCondition as assert } from './inspection';
import { preparePostDates } from './query';
import { documentBlocks } from './document-view';
import { api } from './native';

const SavedPreferencesSchema = v.object({
  meta: v.object({ persisted_preferences: v.looseObject({ core: v.optional(JsonObjectSchema) }) }),
});

// WordPress saves Code Mode for the user, so one switch leaves every later
// editor without a canvas. An owned tab shows the visual editor through a layer
// that saves nothing and keeps the user's other preferences, such as dismissed
// guides, so the tab otherwise opens as the user's editor would.
export async function showVisualEditor(wp: WordPress): Promise<void> {
  if (wp.data.select('core/editor').getEditorMode?.() !== 'text') {
    return;
  }

  const record = v.safeParse(
    SavedPreferencesSchema,
    await api(wp, '/wp/v2/users/me?context=edit&_fields=meta'),
  );
  // WordPress sends an empty list for a user with no saved preferences.
  const saved = record.success ? record.output.meta.persisted_preferences : {};

  await wp.data
    .dispatch('core/preferences')
    .setPersistenceLayer({
      get: () => Promise.resolve({ ...saved, core: { ...saved.core, editorMode: 'visual' } }),
      set: () => undefined,
    });
}

// Code Mode renders no blocks, so nothing here could become ready. It belongs
// to the user, so report it instead of waiting or changing it.
function requireVisualEditor(): void {
  assert(window.wp?.data.select('core/editor').getEditorMode?.() !== 'text', 'editor_code_mode');
}

function canvasState(wp: WordPress): string {
  const rows = readTree(wp, documentBlocks(wp));

  return JSON.stringify([blockState(rows), rows.map((row) => row.clientId)]);
}

async function waitForCanvas(
  ready: () => boolean,
  deadline: Deadline,
  stalled = 'native_insertion_context_unavailable',
  beforeRender: () => void = () => undefined,
): Promise<void> {
  if (ready()) {
    return;
  }

  requireVisualEditor();
  let restored = false;
  let reloaded = false;

  while (!ready()) {
    assert(Date.now() < limit(deadline), stalled, { canvas_reloaded: reloaded });
    const frame = document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]');

    // The in-app browser can abort blob iframe navigation. Reuse Gutenberg's
    // exact same-origin document through srcdoc so its own load handler mounts
    // the canvas. Never supply block policies or alter iframe security settings.
    if (
      !restored &&
      frame &&
      !frame.srcdoc &&
      frame.contentDocument?.URL === 'about:blank' &&
      frame.contentDocument.readyState === 'complete' &&
      !frame.contentDocument.body?.childElementCount
    ) {
      const source = new URL(frame.src, location.href);

      if (source.protocol === 'blob:' && source.origin === location.origin) {
        restored = true;

        const response = await fetch(source.href, {
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, limit(deadline) - Date.now())),
        });

        assert(response.ok, 'native_canvas_load_failed');
        const html = await response.text();
        assert(frame.isConnected && frame.src === source.href, 'native_canvas_changed');

        if (!ready() && !frame.srcdoc && frame.contentDocument?.URL === 'about:blank') {
          const wp = window.wp;
          assert(wp, 'native_readiness_unavailable');
          const blocks = documentBlocks(wp);
          const state = canvasState(wp);
          const checkDates = await preparePostDates(wp, blocks);
          assert(frame.isConnected && frame.src === source.href, 'native_canvas_changed');
          assert(canvasState(wp) === state, 'intervening_editor_change');
          beforeRender();
          checkDates();

          if (!ready() && !frame.srcdoc && frame.contentDocument?.URL === 'about:blank') {
            frame.srcdoc = html;
          }

          reloaded = true;
        }
      }
    }

    if (!ready()) {
      await pause(25);
    }
  }
}

export async function requireContexts(
  wp: WordPress,
  ids: string[],
  deadline: Deadline = Date.now() + 5000,
  beforeRender: () => void = () => undefined,
): Promise<void> {
  if (!ids.length) {
    return;
  }

  const store = wp.data.select('core/block-editor');
  assert(store.getBlockListSettings, 'native_insertion_policy_unavailable');
  await waitForCanvas(
    () => ids.every((id) => store.getBlockListSettings!(id) !== undefined),
    deadline,
    undefined,
    beforeRender,
  );
}

export async function requireRendered(
  ids: string[],
  deadline: Deadline = Date.now() + 5000,
  beforeRender: () => void = () => undefined,
): Promise<void> {
  if (!ids.length) {
    return;
  }

  await waitForCanvas(
    () => {
      const canvas =
        document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]')
          ?.contentDocument ?? document;

      return ids.every((id) => Boolean(canvas.getElementById(`block-${id}`)));
    },
    deadline,
    undefined,
    beforeRender,
  );
}

// view and measure read the rendered canvas, so a blank one is mounted first,
// as edits do. Gutenberg then renders blocks into it over a few frames; a block
// still missing at the deadline is left for the caller to report as unrendered.
// An already mounted canvas returns at once, so pass every block the operation
// reads to the first call, before any device change. A non-iframed editor
// renders into the document and needs nothing.
export async function requireCanvas(
  ids: string[],
  deadline: Deadline = Date.now() + 5000,
): Promise<void> {
  requireVisualEditor();
  const frame = () => document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]');
  const mounted = () => {
    const canvas = frame();

    return !canvas || Boolean(canvas.contentDocument?.body?.childElementCount);
  };

  if (mounted()) {
    return;
  }

  await waitForCanvas(mounted, deadline, 'native_render_unavailable');
  const rendered = () => {
    const canvas = frame()?.contentDocument;

    return !canvas || ids.every((id) => Boolean(canvas.getElementById(`block-${id}`)));
  };

  while (!rendered() && Date.now() < limit(deadline)) {
    await pause(25);
  }
}
