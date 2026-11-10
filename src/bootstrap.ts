import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { JsonObject, JsonValue, MediaMap, Target, Width } from './contracts';
import type { ResourceReceipt } from './resources';
import type * as Invocation from './invocation';
import {
  CaptureSchema,
  HostMeasureSchema,
  HostViewSchema,
  CreateSchema,
  CopySchema,
  CopyUrlEntriesSchema,
  PageSizeSchema,
  PixelRatioSchema,
  PageSchema,
  EvaluationSchema,
  MetricsSchema,
  ScreenshotSchema,
  DomDocumentSchema,
  DomMatchSchema,
  IdentitySchema,
  SignInSchema,
  measuredPage,
  requestIssue,
  mediaCallers,
  pageWidths,
} from './bootstrap-contracts';
import type {
  HostTab,
  HostFailure,
  EngineSuccess,
  Connected,
  Discovered,
  Resizable,
  Placed,
  Clip,
  Size,
  Screenshot,
  BlockworkCaller,
  MediaAccess,
  MediaRecord,
  MediaResult,
  InspectedMedia,
  StoredMedia,
  CopyRequest,
  CaptureMeasure,
  Page,
  VisualResult,
  VisualShot,
} from './bootstrap-contracts';

// Bundled beside the compiled invoker. This host helper never opens a browser or
// chooses a tab; the caller supplies the exact host tab. Its cdp capability
// runs the engine and takes screenshots, and create navigates it with goto.
export async function createBlockwork(tab: HostTab): Promise<BlockworkCaller> {
  const capability = await tab.capabilities.get('cdp');
  const source = await readFile(new URL('./editor.js', import.meta.url), 'utf8');
  const invokerUrl = new URL('./invoke.mjs', import.meta.url);
  const invoker = await readFile(invokerUrl, 'utf8');
  const manifest = JSON.parse(
    await readFile(new URL('../../../plugin.json', import.meta.url), 'utf8'),
  );
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const build: HostBuild = {
    version: manifest.version,
    engine_sha256: hash(source),
    invoker_sha256: hash(invoker),
    bootstrap_sha256: hash(await readFile(new URL(import.meta.url), 'utf8')),
  };
  invokerUrl.searchParams.set('build', build.invoker_sha256);
  const { callBlockwork, debug, withDebug }: typeof Invocation = await import(invokerUrl.href);

  function debugResult<T extends JsonObject>(result: T, error: unknown): T {
    // SAFETY: withDebug only adds the optional debug field to the supplied result.
    return withDebug(result, error) as T;
  }

  // Development builds add the underlying error to failures as `debug`.
  build.debug = debug;
  // The latest receipt a page call returned. Only an unsettled write needs it,
  // and the page refuses another write until that one settles.
  let receipt: JsonObject | undefined;
  // Host failures leave the page operation's outcome unknown. Further changes
  // wait until status() shows it settled, so nothing is ever replayed.
  const hostFailures = ['browser_command_failed', 'browser_operation_pending'];
  const mutations = ['edit', 'prepare_save', 'save', 'revert', 'release'];
  // These take a site-only target, which connect already confirmed.
  const siteOperations = [
    'discover',
    'inspect_media',
    'download_media',
    'resource_status',
    'inspect_terms',
    'prepare_media',
    'prepare_term',
    'save_resource',
    'verify_resource',
    'list_entities',
    'recover',
    'inspect_abilities',
    'run_ability',
  ];
  // Normalize requests exactly as the page receives them, including sparse arrays.
  const json = (value: unknown): JsonValue | undefined => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return undefined;
    }
  };

  const defaultPageProperties = [
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'color',
    'background-color',
    'padding',
    'margin',
  ];
  const pageProperties = (properties: string[] | undefined) =>
    (properties?.length ? properties : defaultPageProperties).map((property) =>
      property.startsWith('--') ? property : property.replaceAll('_', '-'),
    );

  // Blockwork resizes only its own background tab, never a user's. The tall
  // window keeps most blocks in one screenshot, and the starting width leaves
  // Gutenberg's tablet and mobile previews room so they are never squeezed.
  const windowHeight = 1080;
  const startWidth = 1600;
  // Front-end widths: a common laptop, tablet, and phone.
  let busy = false;
  // A view or a resized measure spans several page calls; other calls wait.
  let held = false;
  let creationAttempted = false;
  let connectAttempted = false;
  let target: Target | undefined;
  let workflow: Connected['workflow'] | undefined;
  // Whether this caller released its session; workflow keeps which kind.
  let released = false;
  let unresolved: { operation: string; request_id?: JsonObject['request_id'] } | undefined;
  // The tab's size before Blockwork first resized it, which every reset puts
  // back, and whether Blockwork's own size may still be in place.
  let baseline: number[] | undefined;
  let overridden = false;

  const refuse = (
    operation: JsonObject['operation'],
    error: string,
    next: string,
    hint: string,
  ): HostFailure => ({ ok: false, error, operation, operation_started: false, next, hint });

  async function call<T extends EngineSuccess = EngineSuccess>(
    request: JsonObject,
    inView = false,
    deadline?: number,
  ): Promise<T | HostFailure> {
    if (busy || (held && !inView)) {
      return refuse(
        request.operation,
        'host_operation_in_progress',
        'wait_for_host_operation',
        "Wait for this caller's current operation to return before starting another.",
      );
    }

    if (
      unresolved &&
      typeof request.operation === 'string' &&
      mutations.includes(request.operation)
    ) {
      return refuse(
        request.operation,
        'status_required',
        'check_status',
        unresolved.operation === 'prepare_save'
          ? 'The save preparation returned no page result. Call status() until busy is false before retrying the preparation; it invoked no save.'
          : `The ${unresolved.operation} request ${unresolved.request_id} returned no page result. Call status() and read last_request before changing anything; never repeat that request.`,
      );
    }

    busy = true;

    try {
      // A tab size a failed reset left behind is undone before other work.
      const unreset = overridden && !inView ? await resetSize(request.operation) : undefined;
      // SAFETY: The bundled engine owns its operation-specific result contracts.
      const result = (await callBlockwork(capability, source, request, { deadline })) as
        | T
        | HostFailure;

      if (v.is(JsonObjectSchema, result.receipt)) {
        receipt = result.receipt;
      }

      if (
        !result.ok &&
        hostFailures.includes(result.error) &&
        typeof request.operation === 'string' &&
        mutations.includes(request.operation)
      ) {
        unresolved = { operation: request.operation, request_id: request.request_id };
      }

      return unreset ? { ...result, tab_resize: unreset } : result;
    } finally {
      busy = false;
    }
  }

  // A released background document must close, so this caller cannot connect
  // to it again; an attached session can start again in the same tab.
  const releasedDocument = (operation: string) =>
    refuse(
      operation,
      'document_released',
      'correct_request',
      'This caller released its background document, and that tab no longer renews its lock. Close the tab, open a fresh editor tab, and create a new caller for it.',
    );

  function editor<T extends EngineSuccess = EngineSuccess>(
    operation: string,
    request: JsonObject = {},
    inView = false,
    deadline?: number,
  ): Promise<T | HostFailure> | HostFailure {
    if (!target && released && workflow === 'background') {
      return releasedDocument(operation);
    }

    if (!target) {
      return refuse(
        operation,
        'connect_required',
        'connect',
        released
          ? 'This caller released its session. Call connect() with the exact target and workflow to start another in the same tab.'
          : 'Call connect() with the exact target and workflow first.',
      );
    }

    return call<T>({ ...request, operation, target, request_id: randomUUID() }, inView, deadline);
  }

  // Sets the tab's window size, or clears Blockwork's override without a
  // width. Returns a failure or nothing.
  async function emulate(
    operation: JsonObject['operation'],
    width?: number,
    height = windowHeight,
  ): Promise<HostFailure | undefined> {
    try {
      if (width === undefined) {
        await capability.send('Emulation.clearDeviceMetricsOverride', {});
      } else {
        await capability.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 0,
          mobile: false,
        });
      }
    } catch (error) {
      return debugResult(
        refuse(
          operation,
          'tab_resize_failed',
          'correct_request',
          "The browser refused to resize Blockwork's own tab or to put its size back. A result beside this stands; the next call tries the reset again, and closing the tab ends it. Use the tablet and mobile previews, or check exact widths on the front end.",
        ),
        error,
      );
    }
  }

  // One page request at a width. The page asks for a window size when the
  // canvas is not at that width yet; one correction follows the first resize.
  async function sized<T extends Resizable = Resizable>(
    request: SizedRequest,
  ): Promise<T | HostFailure> {
    for (let resized = 0; ; resized++) {
      const result = await editor<T>(request.operation, request, true);

      if (!result.ok || !result.resize) {
        return result;
      }

      if (resized === 2) {
        return {
          ...refuse(
            request.operation,
            'width_unavailable',
            'correct_request',
            'The canvas did not reach diagnostics.target_width after Blockwork resized its own tab twice; canvas_width says where it stopped. Something in the editor changes width with the window. Try once more, then use the tablet or mobile preview or check this width on the front end.',
          ),
          diagnostics: result.resize,
        };
      }

      const failed = await emulate(request.operation, result.resize.window_width);

      if (failed) {
        return failed;
      }
    }
  }

  // The window size the page sees, as { size } or { error }.
  async function pageSize(): Promise<{ size?: number[]; error?: unknown }> {
    try {
      const { result } = v.parse(
        EvaluationSchema,
        await capability.send('Runtime.evaluate', {
          expression: '[innerWidth, innerHeight]',
          returnByValue: true,
        }),
      );

      return v.is(PageSizeSchema, result?.value) ? { size: result.value } : { error: undefined };
    } catch (error) {
      return { error };
    }
  }

  // Records the tab's own size, once, and marks Blockwork's size as in place.
  // A size an earlier failed reset left is reset first, so it never becomes
  // the baseline. Returns a failure or nothing; it resizes nothing itself.
  async function startResizing(operation: string): Promise<HostFailure | undefined> {
    const unreset = overridden ? await resetSize(operation) : undefined;

    if (unreset) {
      return unreset;
    }

    if (!baseline) {
      const read = await pageSize();

      if (!read.size) {
        return debugResult(
          refuse(
            operation,
            'tab_size_unavailable',
            'correct_request',
            "Blockwork could not read this tab's size, so it did not resize the tab. Try once more; otherwise use the tablet and mobile previews, or check exact widths on the front end.",
          ),
          read.error,
        );
      }

      baseline = read.size;
    }

    overridden = true;
  }

  // Clears Blockwork's override, then sets the baseline again if clearing left
  // another size, as a hidden tab can take the browser's own size. Until this
  // succeeds, the next call tries again. Returns a failure or nothing.
  async function resetSize(operation: JsonObject['operation']): Promise<HostFailure | undefined> {
    let failed = await emulate(operation);

    if (!failed) {
      const read = await pageSize();

      if (!read.size) {
        failed = debugResult(
          refuse(
            operation,
            'tab_resize_unverified',
            'correct_request',
            'Blockwork cleared its size for its own tab but could not read the size afterward, so the tab may not be at its own size. A result beside this stands; the next call checks again, and closing the tab ends it.',
          ),
          read.error,
        );
      } else if (read.size[0] !== baseline![0] || read.size[1] !== baseline![1]) {
        failed = await emulate(operation, baseline![0], baseline![1]);
      }
    }

    overridden = Boolean(failed);

    return failed;
  }

  // Restoration is reported even when an earlier failure is returned.
  async function restoreView() {
    const restored = await editor('restore_view', {}, true);

    return restored.ok ? undefined : restored;
  }

  // Runs page requests in a held sequence. A background tab starts at the
  // starting size. Afterward the tab's own size comes back first, so the
  // editor's device and scroll positions return at that size.
  async function holding<T extends { ok?: boolean }>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T | HostFailure> {
    const owned = workflow === 'background';
    held = true;
    let result!: T | HostFailure;

    try {
      const failed = owned
        ? ((await startResizing(operation)) ?? (await emulate(operation, startWidth)))
        : undefined;
      result = failed ?? (await run());
    } finally {
      const cleared = overridden ? await resetSize(operation) : undefined;
      const restored = await restoreView();
      held = false;

      // A failed reset is reported beside a completed result, which stands.
      if (restored) {
        result = result?.ok === false ? { ...result, view_restore: restored } : restored;
      }

      if (cleared) {
        result = { ...result, tab_resize: cleared };
      }
    }

    return result;
  }

  // Checks a screenshot against the region it was taken of. Returns its size
  // or a failure.
  function checkedImage(
    operation: string,
    image: Uint8Array,
    clip: Clip,
  ): HostFailure | { ok?: never; size: Size } {
    const size = imageSize(image);

    if (!size) {
      return refuse(
        operation,
        'screenshot_failed',
        'correct_request',
        'The browser returned an image Blockwork could not read. Try once more; if it repeats, report the visual check as unavailable.',
      );
    }

    // A region screenshot keeps the region's shape; another shape means the
    // browser cropped it. A whole image scaled down passes.
    if (Math.abs(size.height - (clip.height * size.width) / clip.width) > 2) {
      return {
        ...refuse(
          operation,
          'screenshot_cropped',
          'correct_request',
          'The browser returned an image with a different shape from the region Blockwork asked for, so part of it may be missing. Try once more; if it repeats, report the visual check as unavailable.',
        ),
        diagnostics: { clip: { width: clip.width, height: clip.height }, image: size },
      };
    }

    return { size };
  }

  const noticeMark = 'data-blockwork-hidden-notice';
  const restoreNotices = `(() => { for (const element of document.querySelectorAll('[${noticeMark}]')) {
    element.style.setProperty('display', ...JSON.parse(element.getAttribute('${noticeMark}')));
    element.removeAttribute('${noticeMark}');
  } })()`;

  // Returns a refusal when the page's hidden notices could not be put back.
  async function putBackNotices() {
    let response: v.InferOutput<typeof EvaluationSchema> | undefined;
    let failure;

    try {
      response = v.parse(
        EvaluationSchema,
        await capability.send('Runtime.evaluate', { expression: restoreNotices }),
      );
    } catch (error) {
      failure = error;
    }

    if (!failure && !response?.exceptionDetails) {
      return;
    }

    return debugResult(
      refuse(
        'capture_page',
        'notice_restore_failed',
        'close_tab',
        'The browser could not put back the cookie or consent notice it hid for the shots. Close your front-end tab before relying on it.',
      ),
      failure ?? response?.exceptionDetails,
    );
  }

  // Waits for the resized page to lay out, scrolls to selector or the top,
  // gives images in view and web fonts time to load, and jumps running
  // entrance animations to their end so the shot shows the settled page,
  // repeating while animations end. Then it measures the first match of each
  // measure selector. A cookie or consent notice stays hidden until
  // restoreNotices, unless keepNotices is set.
  async function settlePage(
    selector: string | undefined,
    measure: CaptureMeasure | undefined,
    keepNotices: boolean | undefined,
  ): Promise<Page | HostFailure> {
    const input = {
      selector: selector ?? null,
      selectors: measure?.selectors ?? [],
      properties: measure ? pageProperties(measure.properties) : [],
      keep_notices: keepNotices === true,
    };
    const expression = `(async ({ selector, selectors, properties, keep_notices }) => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // A hidden tab renders no frames and runs timers about once a second, so
      // waiting there for a frame only adds delay; the capture paints it.
      const frame = () => document.visibilityState === 'hidden'
        ? Promise.resolve()
        : Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), pause(100)]);

      for (const [index, item] of selectors.entries()) {
        try {
          document.querySelector(item);
        } catch {
          return { ok: false, error: 'invalid_selector', field: 'measure.selectors.' + index };
        }
      }

      // A notice covers part of the page in any fresh browser. Its inline display
      // goes on the element for restoreNotices. An inline style works under a
      // strict content security policy, where an added style sheet would not.
      const hideNotices = () => {
        if (keep_notices) {
          return;
        }

        for (const candidate of document.querySelectorAll('body *')) {
          const style = getComputedStyle(candidate);

          if (style.position !== 'fixed' || style.display === 'none' || style.visibility !== 'visible') {
            continue;
          }

          const text = candidate.innerText ?? '';

          // The length rules out a fixed wrapper around the whole page.
          if (text.length > 2000 || !/\\b(cookies?|consent|gdpr)\\b/i.test(text) || candidate.closest('[${noticeMark}]')) {
            continue;
          }

          // Only an answer counts. A menu can hold "Cookie policy" and "Settings".
          const controls = [...candidate.querySelectorAll('button, a, input, [role="button"]')];
          const answers = (control) => {
            const label = control.innerText || control.value || control.getAttribute('aria-label') || '';
            return /\\b(accept|agree|allow|reject|decline|deny|refuse|opt.?out)\\b/i.test(label) ||
              (/\\b(got it|understand|ok|okay)\\b/i.test(label) &&
                /\\b(cookies?(?!\\s+polic(?:y|ies)\\b)|consent|gdpr)\\b/i.test(text));
          };

          if (controls.some(answers)) {
            candidate.setAttribute('${noticeMark}', JSON.stringify([
              candidate.style.getPropertyValue('display'),
              candidate.style.getPropertyPriority('display'),
            ]));
            candidate.style.setProperty('display', 'none', 'important');
          }
        }
      };

      let selectorOffset = 0;
      const scroll = () => {
        if (!selector) {
          scrollTo({ top: 0, left: 0, behavior: 'instant' });

          return;
        }

        let element;

        try {
          element = document.querySelector(selector);
        } catch {
          return { ok: false, error: 'invalid_selector', field: 'selector' };
        }

        if (!element) {
          return { ok: false, error: 'selector_not_found', field: 'selector' };
        }

        element.scrollIntoView({ block: 'start', behavior: 'instant' });
        const box = element.getBoundingClientRect();
        const overlays = [];

        for (const candidate of document.querySelectorAll('body *')) {
          if (candidate.contains(element) || element.contains(candidate)) {
            continue;
          }

          const style = getComputedStyle(candidate);

          if (!['fixed', 'sticky'].includes(style.position) ||
              style.visibility === 'hidden' || style.visibility === 'collapse' ||
              style.display === 'none' || Number(style.opacity) === 0 ||
              Number(style.zIndex) < 0) {
            continue;
          }

          const overlay = candidate.getBoundingClientRect();

          // A box over half the viewport tall is a backdrop or modal, not a
          // bar, and no scroll would clear it.
          if (overlay.width > 0 && overlay.height > 0 && overlay.height <= innerHeight / 2 &&
              overlay.right > box.left && overlay.left < box.right) {
            overlays.push(overlay);
          }
        }

        // Follow stacked bars that cover the target's top edge. Together they
        // get at most half the viewport so the target stays in the shot.
        let edge = Math.max(0, box.top);

        for (const overlay of overlays.sort((a, b) => a.top - b.top)) {
          if (overlay.top <= edge && overlay.bottom > edge) {
            edge = overlay.bottom;
          }
        }

        const offset = Math.min(Math.max(0, edge - box.top), innerHeight / 2);
        const before = scrollY;
        scrollTo({ top: Math.max(0, scrollY - offset), left: scrollX, behavior: 'instant' });
        selectorOffset = before - scrollY;
      };

      // Waits for the images in view and web fonts to load, until the deadline.
      const settle = async (until) => {
        // Lazy loaders request the images now in view a frame after scrolling.
        await frame();
        const loading = () => [...document.images].some((image) => {
          const box = image.getBoundingClientRect();

          return !image.complete && box.bottom > 0 && box.top < innerHeight;
        });

        while (loading() && Date.now() < until) {
          await pause(50);
        }

        await Promise.race([document.fonts?.ready, pause(Math.max(0, until - Date.now()))]);
        await frame();
      };

      // Jumps each running time-based animation that has an end to that end,
      // and returns how many. Endless and scroll-driven ones keep running.
      // Ending one can start the next, so this repeats.
      const finishAnimations = async () => {
        let count = 0;

        for (let turn = 0; turn < 5; turn++) {
          const ending = (document.getAnimations?.() ?? []).filter((animation) =>
            animation.playState === 'running' &&
            animation.timeline === document.timeline &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime));

          if (!ending.length) {
            break;
          }

          for (const animation of ending) {
            try {
              animation.finish();
              count++;
            } catch {
              // A zero-rate animation cannot finish; it stays as it is.
            }
          }

          await frame();
        }

        return count;
      };

      // An entrance animation would be caught partway, so it jumps to its end.
      // That can move or remove the selector, bring images into view, or let a
      // scroll start another animation, so scrolling, loading, and finishing
      // repeat until nothing more ends: three passes at most, with three
      // seconds of loading for the first and three more shared by the rest.
      await frame();
      const started = Date.now();
      let finished = 0;

      for (let pass = 0; pass < 3; pass++) {
        hideNotices();
        const unscrolled = scroll();

        if (unscrolled) {
          return unscrolled;
        }

        await settle(started + (pass ? 6000 : 3000));
        const ended = await finishAnimations();
        finished += ended;

        if (!ended) {
          break;
        }
      }

      // A notice often appears a moment after the page loads.
      hideNotices();
      const round = (value) => Math.round(value * 10) / 10;
      const elements = selectors.map((item) => {
        const element = document.querySelector(item);

        if (!element) {
          return { selector: item, found: false };
        }

        const box = element.getBoundingClientRect();
        const computed = getComputedStyle(element);

        return {
          selector: item,
          found: true,
          tag: element.tagName.toLowerCase().slice(0, 100),
          rect: { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) },
          styles: Object.fromEntries(properties.map((property) => [property, computed.getPropertyValue(property).slice(0, 200)])),
        };
      });

      if (new TextEncoder().encode(JSON.stringify(elements)).length > 65536) {
        return { ok: false, error: 'measure_response_too_large' };
      }

      return {
        ok: true,
        width: innerWidth,
        height: innerHeight,
        scroll_x: scrollX,
        scroll_y: scrollY,
        scroll_width: document.documentElement.scrollWidth,
        hidden: document.visibilityState === 'hidden',
        finished_animations: finished,
        hidden_notices: document.querySelectorAll('[${noticeMark}]').length,
        selector_offset: selectorOffset,
        elements,
      };
    })(${JSON.stringify(input)})`;
    const hints = {
      page_unavailable:
        'The page did not answer. Check that the tab is still open and has loaded, then try again.',
      invalid_selector:
        'diagnostics.field names a string that is not a valid CSS selector. Correct it; omit selector to capture the top of the page, or remove a measure selector.',
      selector_not_found:
        'No element on this page matches selector at this width. Check it against the page, or omit it to capture the top of the page.',
      measure_response_too_large:
        'The measurements at one width exceeded 64 KiB. Measure fewer selectors or request fewer properties.',
    };
    let response: v.InferOutput<typeof EvaluationSchema> | undefined;
    let failure;

    try {
      response = v.parse(
        EvaluationSchema,
        await capability.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }),
      );
    } catch (error) {
      failure = error;
    }

    const shown = response?.result?.value;
    const measured = measuredPage(shown, input.selectors, input.properties);
    // The page checks this too; the caller holds it to the same bytes.
    const oversized =
      measured && !v.is(v.pipe(v.string(), v.maxBytes(65536)), JSON.stringify(shown.elements));

    if (measured && v.is(PageSchema, shown) && !oversized) {
      return shown;
    }

    const failedPage = v.safeParse(
      v.object({ error: v.optional(v.unknown()), field: v.optional(v.unknown()) }),
      shown,
    );
    const pageError = failedPage.success ? failedPage.output.error : undefined;
    const matchedHint = Object.entries(hints).find(([code]) => code === pageError);
    let [code, hint] = matchedHint ?? ['page_unavailable', hints.page_unavailable];

    if (oversized) {
      code = 'measure_response_too_large';
      hint = hints.measure_response_too_large;
    }

    const refused = refuse('capture_page', code, 'correct_request', hint);
    // Only the field names this script itself reports.
    const reportedField = failedPage.success ? failedPage.output.field : undefined;
    const field =
      v.is(v.string(), reportedField) &&
      /^(selector|measure\.selectors\.\d{1,2})$/.test(reportedField)
        ? reportedField
        : null;

    return debugResult(
      field ? { ...refused, diagnostics: { field } } : refused,
      failure ?? response?.exceptionDetails,
    );
  }

  // A screenshot clip is in document pixels, so a viewport's starts at the scroll.
  const viewport = (shown: Page): Clip => ({
    x: shown.scroll_x,
    y: shown.scroll_y,
    width: shown.width,
    height: shown.height,
  });

  // A hidden tab renders no frames until a capture forces one. That frame
  // runs the intersection and animation-end handlers that reveal more, so
  // what the settle after it finishes or loads can need another frame. The
  // page is painted and settled three times before the shot.
  async function paintHidden(
    shown: Page,
    selector: string | undefined,
    measure: CaptureMeasure | undefined,
    keepNotices: boolean | undefined,
  ): Promise<Page | HostFailure> {
    let settled = shown;

    for (let paint = 0; paint < 3; paint++) {
      const painted = await screenshot('capture_page', viewport(settled));

      if (painted.ok === false) {
        return painted;
      }

      const next = await settlePage(selector, measure, keepNotices);

      if (!next.ok) {
        return next;
      }

      settled = {
        ...next,
        finished_animations: settled.finished_animations + next.finished_animations,
      };
    }

    return settled;
  }

  // Captures through CDP. In the desktop app, the host's tab.screenshot left
  // large images in a hidden tab blank or pixelated. CDP takes the clip in
  // device-independent pixels, so the CSS clip is multiplied by the browser
  // zoom; the scale then returns CSS pixels, matching measured rects.
  async function screenshot(operation: string, clip: Clip): Promise<Screenshot | HostFailure> {
    const failed = (error: unknown): HostFailure =>
      debugResult(
        refuse(
          operation,
          'screenshot_failed',
          'correct_request',
          `The browser could not capture this tab. Check that the tab is still open, then try again${operation === 'view' ? ' or use measure' : ''}.`,
        ),
        error,
      );
    let image;
    let screenshotError;

    try {
      const metrics = v.parse(MetricsSchema, await capability.send('Page.getLayoutMetrics', {}));
      const { zoom, scale: pinch } = metrics?.cssVisualViewport ?? {};
      const ratio = v.parse(
        EvaluationSchema,
        await capability.send('Runtime.evaluate', {
          expression: 'devicePixelRatio',
          returnByValue: true,
        }),
      );
      const pixels = ratio?.result?.value;

      if (
        !v.is(PixelRatioSchema, zoom) ||
        !v.is(PixelRatioSchema, pinch) ||
        !v.is(PixelRatioSchema, pixels)
      ) {
        return failed(ratio?.exceptionDetails);
      }

      // Chromium resets a pinch zoom after a clipped capture in a tab with no
      // size override, as in a user's editor.
      if (Math.abs(pinch - 1) > 0.01) {
        return refuse(
          operation,
          'tab_zoomed',
          'correct_request',
          `The tab is pinch-zoomed, and a screenshot would reset its zoom. Ask the user to zoom the tab back out, then try again${operation === 'view' ? ', or use measure' : ''}.`,
        );
      }

      const shot = v.parse(
        ScreenshotSchema,
        await capability.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 90,
          clip: {
            x: clip.x * zoom,
            y: clip.y * zoom,
            width: clip.width * zoom,
            height: clip.height * zoom,
            scale: 1 / pixels,
          },
        }),
      );
      const bytes = v.is(v.string(), shot?.data) ? Buffer.from(shot.data, 'base64') : undefined;

      if (bytes?.length) {
        image = bytes;
      }
    } catch (error) {
      screenshotError = error;
    }

    if (!image) {
      return failed(screenshotError);
    }

    const checked = checkedImage(operation, image, clip);

    return checked.ok === false ? checked : { image, image_size: checked.size };
  }

  async function connect(request: JsonObject, inCreate = false): Promise<Connected | HostFailure> {
    if (released && workflow === 'background') {
      return releasedDocument('connect');
    }

    connectAttempted = true;
    const result = await call<Connected>({ ...request, operation: 'connect' }, inCreate);

    if (result.ok) {
      target = result.target;
      workflow = result.workflow;
      released = false;
    }

    return result;
  }

  async function create(input: unknown): Promise<JsonObject> {
    const request = json(input);
    const parsed = v.safeParse(CreateSchema, request);

    if (!parsed.success) {
      const issue = requestIssue(parsed.issues[0]);

      return {
        ...refuse(
          'create',
          'invalid_create',
          'correct_request',
          `Correct ${issue.path || 'the request'}: expected ${issue.expected}. create takes only target: {site_url, user_id} and post_type.`,
        ),
        issues: [issue],
      };
    }

    if (busy || held) {
      return refuse(
        'create',
        'host_operation_in_progress',
        'wait_for_host_operation',
        "Wait for this caller's current operation to return before creating a document.",
      );
    }

    if (target || released || unresolved) {
      return refuse(
        'create',
        'create_requires_owned_tab',
        'open_owned_admin_tab',
        'Create a new caller in a fresh owned wp-admin tab with wp.apiFetch available. This caller already has document or recovery state; preserve it and finish its release or recovery first.',
      );
    }

    if (creationAttempted) {
      return refuse(
        'create',
        'create_already_attempted',
        'inspect_created_document',
        'This caller already attempted creation. Inspect this owned tab for the document already created, record its identity, and connect to it with workflow background. Do not repeat create.',
      );
    }

    held = true;
    let document: JsonObject | undefined;
    let navigated = false;

    try {
      // Native discovery validates the site, user, and type before navigation.
      const discovery = await call<Discovered>(
        { ...parsed.output, operation: 'discover', limit: 1 },
        true,
      );

      if (!discovery.ok) {
        return discovery;
      }

      // The host's own navigation: raw CDP is scoped to the tab's origin and
      // may not be allowed to navigate.
      navigated = true;
      creationAttempted = true;
      await tab.goto(discovery.new_editor_url);

      const until = Date.now() + 10000;

      do {
        const observed = await capability.send(
          'Runtime.evaluate',
          {
            expression: `(() => {
            if (location.pathname.endsWith('/wp-login.php')) return { reauthorization_required: true };
            if (location.href !== ${JSON.stringify(discovery.new_editor_url)}) return null;
            const editor = window.wp?.data?.select('core/editor');
            const post_id = editor?.getCurrentPostId();
            return Number.isInteger(post_id) && post_id > 0
              ? { post_id, post_type: editor.getCurrentPostType() } : null;
          })()`,
            returnByValue: true,
          },
          { timeoutMs: Math.max(1, until - Date.now()) },
        );
        const identity = v.parse(EvaluationSchema, observed).result?.value;

        if (v.is(SignInSchema, identity) && identity.reauthorization_required) {
          return {
            ...refuse(
              'create',
              'reauthorization_required',
              'reauthorize_site',
              'The new editor redirected to WordPress sign-in. Ask the user to sign in in this tab, then inspect its document identity and connect. Never sign in for the user or repeat create without checking whether an auto-draft exists.',
            ),
            operation_started: true,
          };
        }

        if (v.is(IdentitySchema, identity) && identity.post_type === parsed.output.post_type) {
          document = {
            site_url: parsed.output.target.site_url,
            post_id: identity.post_id,
            post_type: identity.post_type,
          };
          const result = await connect({ target: document, workflow: 'background' }, true);

          return { ...result, document };
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < until);

      return {
        ...refuse(
          'create',
          'create_editor_timeout',
          'inspect_created_document',
          'The new editor did not expose a positive post ID and the requested post_type within 10 seconds. An auto-draft may exist. Inspect this owned tab after native loading finishes, record its identity, and connect with workflow background. Do not repeat create or save through the UI.',
        ),
        operation_started: true,
        diagnostics: { stage: 'new_editor', waited_ms: 10000 },
      };
    } catch (error) {
      const failed: JsonObject = {
        ...refuse(
          'create',
          'create_browser_failed',
          'inspect_created_document',
          'The browser did not return a usable result during creation. Inspect this owned tab and record any new document identity before deciding whether to connect. Do not repeat create: navigation may already have created an auto-draft.',
        ),
        operation_started: navigated,
      };

      if (document) {
        failed.document = document;
      }

      return debugResult(failed, error);
    } finally {
      held = false;
    }
  }

  let saveWaits = 0;
  let signInWaits = 0;
  const caller: BlockworkCaller = {
    build,
    get receipt() {
      return receipt;
    },
    get target() {
      return target;
    },
    connect,
    create,
    copy_media: (request) => copyMedia(caller, request, withDebug),
    read: (request) => editor('read', request),
    edit: (request) => editor('edit', request),
    // A width shows a device preview, and in a background tab may resize
    // Blockwork's own tab first; both are undone before this returns.
    async measure(input = {}) {
      // Without a width the page checks the request itself. A width request is
      // checked here in the JSON shape the page receives, and refused here,
      // never sent without the restoring sequence.
      if (input?.width === undefined || !target) {
        return editor('measure', input);
      }

      const request = json(input);

      if (!request || !v.is(HostMeasureSchema, request)) {
        return refuse(
          'measure',
          'invalid_measure',
          'correct_request',
          'measure takes blocks, 1 to 20 client IDs from read or edit, or client_id, one of them; optional properties, up to 32 CSS property names; and width: desktop, tablet, mobile, or a whole number of CSS pixels from 320 to 2560. Remove any other keys.',
        );
      }

      if (busy || held) {
        return refuse(
          'measure',
          'host_operation_in_progress',
          'wait_for_host_operation',
          "Wait for this caller's current operation to return before starting another.",
        );
      }

      return holding('measure', () => sized({ ...request, operation: 'measure' }));
    },
    // Screenshots of one block in the editor canvas at each width. Tall blocks
    // come back in up to four slices per width. The editor's device and scroll
    // positions, and the size of Blockwork's own tab, are restored before this
    // returns.
    async view(request = {}) {
      const parsed = v.safeParse(HostViewSchema, request ?? {});

      if (!parsed.success) {
        return refuse(
          'view',
          'invalid_view',
          'correct_request',
          'view takes client_id, a live client ID from read or edit, and widths, a list of one to six distinct values from desktop, tablet, mobile, or whole numbers of CSS pixels from 320 to 2560.',
        );
      }

      const { client_id, widths } = parsed.output;

      if (!target) {
        return editor('view');
      }

      if (busy || held) {
        return refuse(
          'view',
          'host_operation_in_progress',
          'wait_for_host_operation',
          "Wait for this caller's current operation to return before starting another.",
        );
      }

      const shots: VisualShot[] = [];
      const incomplete: Width[] = [];
      const capture = async () => {
        for (const width of widths) {
          let offset = 0;

          for (let slice = 0; slice < 4; slice++) {
            const placed = await sized<Placed>({ operation: 'view', client_id, width, offset });

            if (!placed.ok) {
              return placed;
            }

            const { canvas_width, width_source } = placed;

            if (!placed.rendered) {
              shots.push({ width, rendered: false, canvas_width, width_source });
              break;
            }

            const { clip, clipped, from, to, block_height, next_offset } = placed;
            const captured = await screenshot('view', clip);

            if (captured.ok === false) {
              return captured;
            }

            shots.push({
              width,
              rendered: true,
              canvas_width,
              width_source,
              clipped,
              from,
              to,
              block_height,
              ...captured,
            });

            if (next_offset === null) {
              break;
            }

            offset = next_offset;

            if (slice === 3) {
              incomplete.push(width);
            }
          }
        }

        return {
          ok: true,
          client_id,
          shots,
          incomplete,
          hint: incomplete.length
            ? "Four slices did not reach the bottom of the block at the widths in incomplete. View the block's children for the rest, or check the saved page with capture_page."
            : undefined,
        };
      };

      return holding('view', capture);
    },
    // Screenshots of the page in this tab at each width, for a front-end check.
    // It resizes the tab's window for each width and clears the override
    // afterward, so use it only in a tab the agent opened, never the user's.
    // It needs no connect. selector scrolls that element to the top first, and
    // measure reports elements by selector at each width. Cookie and consent
    // notices are hidden for the shots and put back afterward.
    async capture_page(request = {}) {
      const normalized = json(request ?? {});
      const parsed = v.safeParse(CaptureSchema, normalized);

      if (!parsed.success) {
        const issue = requestIssue(parsed.issues[0]);

        return {
          ...refuse(
            'capture_page',
            'invalid_capture',
            'correct_request',
            'capture_page takes an optional absolute http or https url of up to 2048 characters; widths, a list of one to six distinct values from desktop (1440), tablet (768), mobile (390), or whole numbers of CSS pixels from 320 to 2560; selector, an optional CSS selector string of up to 500 characters; states, optionally {selector, pseudo} with one selector and a list of hover, focus, focus-visible, active, or focus-within; measure, optionally {selectors, properties}: 1 to 20 CSS selector strings of up to 500 characters, and up to 32 CSS property names; and keep_notices, optionally true to leave cookie and consent notices showing. issues names the field to correct.',
          ),
          validation_source: 'request',
          issues: [
            {
              ...issue,
              hint: `Correct ${issue.path || 'the request'} and call capture_page again. Nothing was resized, navigated or captured.`,
            },
          ],
        };
      }

      const {
        url,
        widths = ['desktop', 'mobile'],
        selector,
        states,
        measure,
        keep_notices: keepNotices,
      } = parsed.output;

      if (busy || held) {
        return refuse(
          'capture_page',
          'host_operation_in_progress',
          'wait_for_host_operation',
          "Wait for this caller's current operation to return before starting another.",
        );
      }

      if (url !== undefined && target) {
        return refuse(
          'capture_page',
          'capture_requires_front_end_tab',
          'open_front_end_tab',
          'This caller has a connected editor session. Open your own front-end tab and create a caller for it before navigating.',
        );
      }

      held = true;
      const shots: VisualShot[] = [];
      let result: HostFailure | VisualResult | undefined;
      let stateNode: number | undefined;
      let noticesTouched = false;

      try {
        if (url !== undefined) {
          try {
            await tab.goto(url);
          } catch (error) {
            return debugResult(
              refuse(
                'capture_page',
                'navigation_failed',
                'inspect_tab',
                'Navigation did not complete. Inspect your front-end tab and its address before trying another capture.',
              ),
              error,
            );
          }
        }

        if (states) {
          try {
            const checked = v.parse(
              EvaluationSchema,
              await capability.send('Runtime.evaluate', {
                expression: `(() => { try { return !!document.querySelector(${JSON.stringify(states.selector)}); } catch { return null; } })()`,
                returnByValue: true,
              }),
            );
            const found = checked?.result?.value;

            if (found === null || found === false) {
              return {
                ...refuse(
                  'capture_page',
                  found === null ? 'invalid_selector' : 'selector_not_found',
                  'correct_request',
                  found === null
                    ? 'states.selector is not a valid CSS selector. Correct it and capture again.'
                    : 'No element matches states.selector. Check it against the page or omit states.',
                ),
                diagnostics: { field: 'states.selector' },
              };
            }

            if (found !== true) {
              throw new Error('Selector check unavailable');
            }

            await capability.send('DOM.enable', {});
            const document = v.parse(
              DomDocumentSchema,
              await capability.send('DOM.getDocument', {}),
            );
            const match = v.parse(
              DomMatchSchema,
              await capability.send('DOM.querySelector', {
                nodeId: document.root.nodeId,
                selector: states.selector,
              }),
            );

            if (!match.nodeId) {
              return {
                ...refuse(
                  'capture_page',
                  'selector_not_found',
                  'correct_request',
                  'No element matches states.selector. Check it against the page or omit states.',
                ),
                diagnostics: { field: 'states.selector' },
              };
            }

            await capability.send('CSS.enable', {});
            stateNode = match.nodeId;
            await capability.send('CSS.forcePseudoState', {
              nodeId: stateNode,
              forcedPseudoClasses: states.pseudo,
            });
          } catch (error) {
            result = debugResult(
              refuse(
                'capture_page',
                'pseudo_state_failed',
                'inspect_tab',
                'The browser could not force the requested CSS states. Inspect the tab and try again, or omit states.',
              ),
              error,
            );
          }
        }

        result ??= await startResizing('capture_page');

        for (const width of result ? [] : widths) {
          const pixels = typeof width === 'number' ? width : pageWidths[width];
          result = await emulate('capture_page', pixels, pageHeight(pixels));

          if (result) {
            break;
          }

          noticesTouched = !keepNotices;
          let shown = await settlePage(selector, measure, keepNotices);

          if (shown.ok && shown.hidden) {
            shown = await paintHidden(shown, selector, measure, keepNotices);
          }

          if (!shown.ok) {
            const diagnostics = v.parse(
              v.optional(v.record(v.string(), v.unknown()), {}),
              shown.diagnostics,
            );
            result = { ...shown, diagnostics: { ...diagnostics, width } };
            break;
          }

          if (Math.abs(shown.width - pixels) > 1) {
            result = {
              ...refuse(
                'capture_page',
                'width_unavailable',
                'correct_request',
                'The page did not take the requested width; diagnostics.viewport_width is what it got. Report this width as unchecked.',
              ),
              diagnostics: { width, viewport_width: shown.width },
            };
            break;
          }

          const captured = await screenshot('capture_page', viewport(shown));

          if (captured.ok === false) {
            result = captured;
            break;
          }

          shots.push({
            width,
            viewport_width: shown.width,
            scroll_y: Math.round(shown.scroll_y),
            scroll_width: shown.scroll_width,
            finished_animations: shown.finished_animations,
            hidden_notices: shown.hidden_notices,
            selector_offset: shown.selector_offset,
            elements: measure ? shown.elements : undefined,
            ...captured,
          });
        }
      } finally {
        if (stateNode) {
          try {
            await capability.send('CSS.forcePseudoState', {
              nodeId: stateNode,
              forcedPseudoClasses: [],
            });
          } catch (error) {
            const failure = debugResult(
              refuse(
                'capture_page',
                'pseudo_state_clear_failed',
                'close_tab',
                'The browser could not clear the forced CSS states. Close your front-end tab before continuing.',
              ),
              error,
            );
            result = { ...(result ?? { ok: true, shots }), state_cleanup: failure };
          }
        }

        const noticeFailure = noticesTouched ? await putBackNotices() : undefined;

        if (noticeFailure) {
          result = { ...(result ?? { ok: true, shots }), notice_cleanup: noticeFailure };
        }

        const cleared = overridden ? await resetSize('capture_page') : undefined;
        held = false;

        // A failed reset is reported beside the shots, which stand.
        if (cleared) {
          result = { ...(result ?? { ok: true, shots }), tab_resize: cleared };
        }
      }

      return result ?? { ok: true, shots };
    },
    revert: () => editor('revert'),
    prepare_resave: () => editor('prepare_resave'),
    // The host stops a call at 60 seconds and resets the REPL, so even a page
    // that stopped answering returns within 55. Six calls give the user about
    // five minutes, and next tells the agent whether to call again.
    async wait_for_save() {
      const until = Date.now() + 50000;
      let result = await caller.status(until + 5000);

      while (result.ok && result.dirty && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = await caller.status(until + 5000);
      }

      if (!result.ok || !result.dirty) {
        return result;
      }

      saveWaits += 1;

      return { ...result, next: saveWaits < 6 ? 'wait_for_save' : 'ask_user' };
    },
    // Only the user signs in. This waits, with wait_for_save's pacing, for this
    // tab to reach the site's wp-admin signed in, passing through the login
    // page, a sign-in service's pages, and loading wp-admin on the way.
    async wait_for_sign_in(site = {}) {
      const until = Date.now() + 50000;
      const pending = [
        'reauthorization_required',
        'target_mismatch',
        'page_loading',
        'native_api_unavailable',
        'browser_command_failed',
      ];
      const check = () =>
        call({ operation: 'discover', target: { site_url: site.site_url } }, false, until + 5000);
      // A lost browser binding fails like a navigation does, but never recovers.
      const waiting = (result: JsonObject) =>
        !result.ok &&
        pending.some((error) => error === result.error) &&
        result.next !== 'rebind_browser';
      let result = await check();

      while (waiting(result) && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = await check();
      }

      if (result.ok) {
        return {
          ok: true,
          operation: 'wait_for_sign_in',
          target: result.target,
          user: result.user,
        };
      }

      if (!waiting(result)) {
        return result;
      }

      signInWaits += 1;

      return {
        ...result,
        operation: 'wait_for_sign_in',
        next: signInWaits < 6 ? 'wait_for_sign_in' : 'ask_user',
      };
    },
    // Two page calls: the first returns the receipt the second one needs.
    async save(request = {}) {
      const deadline = Date.now() + 45000;
      const prepared = await editor('prepare_save', request, false, deadline);

      if (!prepared.ok || !prepared.receipt) {
        return prepared;
      }

      return editor('save', { ...request, receipt: prepared.receipt }, false, deadline);
    },
    async status(deadline) {
      const result = await editor('status', {}, false, deadline);

      if (result.ok && !result.busy) {
        unresolved = undefined;
      }

      // A release confirmed after its response was lost ends this target.
      if (result.ok && result.released) {
        target = undefined;
        released = true;
      }

      return result;
    },
    async release() {
      // A caller that never connected or created, such as one used only for
      // capture_page, holds no session to end.
      if (!target && !released && !connectAttempted && !creationAttempted) {
        return {
          ok: true,
          operation: 'release',
          cleanup: 'not_connected',
          persistence: 'not_attempted',
          unsaved_changes: false,
        };
      }

      const result = await editor('release');

      if (result.ok) {
        target = undefined;
        released = true;
      }

      return result;
    },
    // Raw requests for resource and shared operations. Without a target, a
    // site operation uses the connected site and user.
    call(request) {
      if (target && !request?.target && request?.operation === 'map_links') {
        return call({ ...request, target });
      }

      if (
        target &&
        !request?.target &&
        siteOperations.some((operation) => operation === request?.operation)
      ) {
        const { site_url, user_id } = target;

        return call({ ...request, target: { site_url, user_id } });
      }

      return call(request);
    },
  };
  mediaCallers.set(caller, {
    call: async (request, deadline) => {
      // SAFETY: Media operations return the resource engine's record and receipt fields.
      return (await call(request, true, deadline)) as MediaResult;
    },
    busy: () => held || busy,
    verified: new Set(),
    receipts: new Map(),
    acquire() {
      if (held || busy) {
        return false;
      }

      held = true;

      return true;
    },
    release() {
      held = false;
    },
  });

  return caller;
}

// A prior receipt vetoes another upload even before the server inserts its slug.
async function copyMedia(
  caller: BlockworkCaller,
  input: unknown,
  withDebug: typeof Invocation.withDebug,
): Promise<JsonObject> {
  const parsed = v.safeParse(CopySchema, input);

  if (!parsed.success) {
    const issue = requestIssue(parsed.issues[0], true);

    return {
      ok: false,
      operation: 'copy_media',
      error: 'invalid_media_copy',
      next: 'correct_request',
      hint: 'Correct the named field. No copy operation started.',
      issues: [issue],
      persistence: 'not_attempted',
    };
  }

  const request = parsed.output;
  const started = Date.now();
  const deadline = started + (request.deadline_ms ?? 55000) - 2000;
  const ready = () => deadline - Date.now() >= 3000;
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        request.copy_id,
        request.source_target.site_url,
        request.source_target.user_id,
        request.target.site_url,
        request.target.user_id,
        request.parent_id ?? 0,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  const destination = mediaCallers.get(caller)!;
  const origin = mediaCallers.get(request.source)!;
  const accesses = [...new Set([destination, origin])];
  const items: CopyItem[] = request.ids.map((source_id) => ({
    source_id,
    state: 'pending',
    timings: {},
  }));
  const media_map: MediaMap = { ids: {}, urls: {} };
  const timings: Record<string, number> = {};
  const summary = (failure?: JsonObject, waiting = false) => {
    const remaining = items.flatMap((entry) =>
      ['verified', 'upload_bytes_different'].includes(entry.state) ? [] : [entry.source_id],
    );
    let persistence = remaining.length ? 'not_attempted' : 'verified';

    if (Object.keys(media_map.ids).length && remaining.length) {
      persistence = 'partial';
    }

    if (
      waiting ||
      items.some((entry) => ['attempted', 'upload_bytes_different'].includes(entry.state))
    ) {
      persistence = 'uncertain';
    }

    return {
      ok: !failure,
      operation: 'copy_media',
      copy_id: request.copy_id,
      complete: !remaining.length,
      persistence,
      media_map,
      remaining,
      items,
      timings,
      elapsed_ms: Date.now() - started,
      next: waiting ? 'wait_for_media_copy' : 'resume_media_copy',
      hint: waiting
        ? 'A caller or page operation is running. Wait, then repeat copy_media.'
        : 'Resume with this caller and the same copy_id and targets. Use media_map when complete.',
      ...failure,
    };
  };

  if (accesses.some((access) => access.busy())) {
    return summary(undefined, true);
  }

  for (const access of accesses) {
    access.acquire();
  }

  let stage = 'resource_status';
  let item: CopyItem | undefined;
  const siteCall =
    (access: MediaAccess, target: CopyRequest['target']) =>
    async <T extends MediaResult = MediaResult>(
      operation: string,
      fields: JsonObject = {},
      label = operation,
    ): Promise<T> => {
      stage = label;
      const before = Date.now();
      const result = await access.call({ ...fields, operation, target }, deadline);

      if (item) {
        item.timings[`${label}_ms`] = Date.now() - before;

        if (!['inspect', 'fetch'].includes(label) || !result.ok) {
          item.result = result;
        }

        item.resource_id ??= result.resource_id;
      } else {
        timings[`${label}_ms`] = Date.now() - before;
      }

      if (!result.ok && !(label === 'verify' && result.error === 'upload_bytes_different')) {
        if (item && label === 'save' && result.operation_started === false) {
          item.state = 'prepared';
        }

        throw new MediaCopyError(
          ['save', 'verify'].includes(label)
            ? 'media_copy_needs_verification'
            : 'media_copy_operation_failed',
          label === 'fetch' && result.hint
            ? result.hint
            : 'Follow items[].result.hint, then resume the same copy with this caller, which keeps its upload receipts. Never replay an uncertain upload, even when its slug is absent.',
          { result },
        );
      }

      // SAFETY: Each call selects the resource operation whose fields it consumes.
      return result as T;
    };

  const to = siteCall(destination, request.target);
  const from = siteCall(origin, request.source_target);

  try {
    const statuses = new Map<MediaAccess, MediaResult>();

    for (const access of accesses) {
      const status = await (access === destination ? to : from)('resource_status');

      if (status.busy) {
        return summary(undefined, true);
      }

      statuses.set(access, status);
    }

    const found = await to<InspectedMedia>(
      'inspect_media',
      { slugs: request.ids.map((id) => `bw-${key}-${id}`) },
      'lookup',
    );

    if (!ready()) {
      return summary();
    }

    const inspected = await from<InspectedMedia>('inspect_media', { ids: request.ids }, 'inspect');
    const sources = new Map(inspected.records.map((record) => [record.id, record]));

    for (item of items) {
      if (!ready()) {
        break;
      }

      const slug = `bw-${key}-${item.source_id}`;
      const matches = found.records.filter((record) => record.slug === slug);

      if (matches.length > 1) {
        throw new MediaCopyError(
          'media_copy_slug_ambiguous',
          'The exact copy slug matched several attachments. Inspect those records; do not upload again.',
        );
      }

      let record: MediaRecord | undefined = matches[0];
      const native = statuses.get(destination)!;
      let receipt = destination.receipts.get(slug);

      // A recreated caller adopts the page's latest upload and keeps it until it verifies.
      if (!receipt && native.receipt?.desired.slug === slug) {
        receipt = native.receipt;
        destination.receipts.set(slug, receipt);
      }

      const owned = receipt && native.receipt?.key === receipt.key;
      item.receipt = receipt;

      const verifiedHere =
        destination.verified.has(receipt?.key) ||
        (owned && native.verified && native.resource_id === record?.id);

      if (receipt && (!record || !verifiedHere)) {
        item.state = owned && !native.attempted && !record ? 'prepared' : 'attempted';

        if (item.state === 'attempted') {
          if (!ready()) {
            break;
          }

          const verified = await to<StoredMedia>(
            'verify_resource',
            { receipt, resource_id: owned ? native.resource_id : record?.id },
            'verify',
          );
          record = verified.record;
        }
      }

      if (!ready()) {
        break;
      }

      const source = sources.get(item.source_id);

      if (!source) {
        throw new MediaCopyError(
          'media_copy_source_missing',
          'Source inspection omitted this attachment ID. Inspect items[].source_id on the source site, then resume. No upload was sent for this item.',
        );
      }

      if (!record) {
        if (!receipt) {
          if (!ready()) {
            break;
          }

          const { upload } = await from(
            'download_media',
            { id: item.source_id, timeout_ms: Math.max(1, Math.min(12000, deadline - Date.now())) },
            'fetch',
          );

          if (!ready()) {
            break;
          }

          receipt = (
            await to(
              'prepare_media',
              {
                upload,
                fields: {
                  slug,
                  title: source.title.raw,
                  alt: source.alt_text,
                  caption: source.caption.raw,
                  description: source.description.raw,
                  parent_id: request.parent_id ?? 0,
                },
              },
              'prepare',
            )
          ).receipt;
          item.receipt = receipt;
          item.state = 'prepared';
          destination.receipts.set(slug, receipt!);
        }

        if (!ready()) {
          break;
        }

        item.state = 'attempted';
        record = (await to<StoredMedia>('save_resource', { receipt }, 'save')).record;
      }

      if (record.slug !== slug) {
        throw new MediaCopyError(
          'media_copy_slug_changed',
          'WordPress changed the copy slug. Inspect the returned attachment ID and verify its receipt. Never upload this item again.',
        );
      }

      const urls = { [source.source_url]: record.source_url };

      for (const [name, size] of Object.entries(source.media_details.sizes ?? {})) {
        urls[size.source_url] = record.media_details.sizes?.[name]?.source_url ?? record.source_url;
      }

      if (!v.is(CopyUrlEntriesSchema, Object.entries({ ...media_map.urls, ...urls }))) {
        throw new MediaCopyError(
          'media_copy_map_limit',
          'The map requires at most 2000 absolute http or https URLs of at most 2048 characters. Keep receipts and split IDs into smaller requests with the same copy_id; existing copies will be read.',
        );
      }

      Object.assign(media_map.urls, urls);
      media_map.ids[String(item.source_id)] = record.id;
      item.resource_id = record.id;
      item.state =
        item.result?.error === 'upload_bytes_different' ? 'upload_bytes_different' : 'verified';

      if (receipt && item.state === 'verified') {
        destination.verified.add(receipt.key);
        destination.receipts.delete(slug);
      }

      item.result ??= { ok: true, persistence: 'verified', record, receipt };
    }

    const result = summary();

    if (result.complete) {
      result.next = 'edit_with_media_map';
    }

    return result;
  } catch (error) {
    const native = error instanceof MediaCopyError ? error.result : undefined;

    if (['browser_operation_pending', 'operation_in_progress'].includes(native?.error ?? '')) {
      const waiting = summary(undefined, true);

      // A pending source download is a read; it leaves upload persistence as it was.
      if (stage === 'fetch') {
        waiting.persistence = summary().persistence;
      }

      return waiting;
    }

    const failure: JsonObject = {
      error: error instanceof MediaCopyError ? error.code : 'media_copy_interrupted',
      hint:
        error instanceof MediaCopyError
          ? error.hint
          : 'Repair the named stage and resume with this caller and the same copy_id and targets. Never replay an uncertain upload.',
      diagnostics: { stage },
    };

    if (stage !== 'fetch' && native?.persistence && native.operation_started !== false) {
      failure.persistence = native.persistence;
    }

    if (!item && native) {
      failure.operation_result = native;
      failure.hint = native.hint ?? failure.hint;
    }

    return summary(withDebug(failure, error));
  } finally {
    for (const access of accesses) {
      access.release();
    }
  }
}

class MediaCopyError extends Error {
  readonly result: MediaResult | undefined;

  constructor(
    readonly code: string,
    readonly hint: string,
    options?: ErrorOptions & { result: MediaResult },
  ) {
    super(code, options);
    this.result = options?.result;
  }
}

// The pixel size of a PNG or JPEG screenshot: undefined for another format,
// null for a PNG or JPEG without a readable size. Blockwork requests JPEG.
function imageSize(image: Uint8Array | ArrayBuffer): Size | null | undefined {
  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;

  if (bytes.length >= 4 && data.getUint32(0) === 0x89504e47) {
    return bytes.length >= 24 ? size(data.getUint32(16), data.getUint32(20)) : null;
  }

  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }

  // JPEG segments start with 0xFF, a marker, and a length; a start-of-frame
  // marker holds the size. C4, C8, and CC are tables, not frames.
  for (let at = 2; at + 9 <= bytes.length;) {
    if (bytes[at] !== 0xff) {
      return null;
    }

    const marker = bytes[at + 1];

    if (marker === 0xff) {
      at += 1;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return size(data.getUint16(at + 7), data.getUint16(at + 5));
    } else {
      at += 2 + data.getUint16(at + 2);
    }
  }

  return null;
}

// A typical viewport height for a front-end width, since vh units size page
// sections such as heroes: a phone, a portrait tablet, or a desktop.
function pageHeight(width: number) {
  if (width < 600) {
    return 844;
  }

  return width < 1024 ? 1024 : 1080;
}

interface CopyItem extends JsonObject {
  source_id: number;
  state: string;
  timings: Record<string, number>;
  receipt?: ResourceReceipt;
  resource_id?: number;
  result?: JsonObject;
}

interface HostBuild extends JsonObject {
  version: string;
  engine_sha256: string;
  invoker_sha256: string;
  bootstrap_sha256: string;
  debug?: boolean;
}

interface SizedRequest extends JsonObject {
  operation: string;
}
