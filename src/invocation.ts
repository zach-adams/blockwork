import * as v from 'valibot';
import { JsonObjectSchema, readOnlyOperations } from './contracts';
import type { JsonObject, JsonValue } from './contracts';
import { withDebug } from './debug';
import { maximumUploadBytes, uploadLimitHint } from './uploads';

export { debug, withDebug } from './debug';

export interface BrowserCapability {
  send(method: string, params: JsonObject, options?: { timeoutMs: number }): Promise<JsonValue>;
}

export interface InvocationOptions {
  write_receipt(receipt: JsonObject): Promise<void>;
  // A caller may stop observing earlier. The page job is never replayed or cancelled.
  deadline?: number;
}

const EvaluationSchema = v.object({
  result: v.optional(
    v.object({ objectId: v.optional(v.string()), value: v.optional(JsonObjectSchema) }),
  ),
  exceptionDetails: v.optional(JsonObjectSchema),
});
const PropertiesSchema = v.object({
  internalProperties: v.array(v.object({ name: v.string(), value: JsonObjectSchema })),
});
const ExceptionSchema = v.object({
  text: v.optional(v.string()),
  exception: v.optional(v.object({ description: v.optional(v.string()) })),
});

// Host messages and names can echo request content, so failures carry
// authored labels for known phrases and names instead of either. Development
// builds add the message itself as debug.
const reasons: Array<[RegExp, string]> = [
  // First, because the browser's final refusal quotes its own reason after this phrase.
  [/\brejected this action due to browser security policy\b/i, 'browser_denied'],
  [/\bbrowser is not available\b|\bnative pipe closed before response\b/i, 'browser_unavailable'],
  [/\btimed out\b|\btimeout exceeded\b/i, 'timeout'],
  [/\btarget closed\b|\bsession closed\b|\btab (was )?closed\b|\bno tab with\b/i, 'tab_closed'],
  [
    /execution context was destroyed|cannot find context with specified id|inspected target navigated/i,
    'page_changed',
  ],
  [/debugger is not attached|not attached to the (tab|target)/i, 'debugger_not_attached'],
  [
    /\bpermission denied\b|\bnot allowed to (access|attach|debug|use)\b|\baccess denied\b/i,
    'not_permitted',
  ],
  // The browser's own checks before it sends a raw CDP command.
  [/\brequired documentation has not been read\b/i, 'documentation_unread'],
  [/\bbrowser use\b|\braw cdp\b|\bfull cdp access\b/i, 'browser_refused'],
];
const errorNames = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'TimeoutError',
  'AbortError',
  'ProtocolError',
];

const HostErrorSchema = v.object({ name: v.string(), message: v.string() });

type HostError = v.InferOutput<typeof HostErrorSchema>;

// The page's own exception text becomes the message, for development debug.
class PageFailure extends Error {
  constructor(
    readonly reason: string,
    details?: JsonObject,
  ) {
    super(exceptionText(details) ?? reason);
  }
}

function exceptionText(details: JsonObject | undefined): string | undefined {
  const exception = v.safeParse(ExceptionSchema, details);

  return exception.success
    ? (exception.output.exception?.description ?? exception.output.text)
    : undefined;
}

// The outer host can end awaitPromise before the page-side operation settles.
// Keep one native Promise, poll only its state, and never execute the edit again.
export async function callBlockwork(
  capability: BrowserCapability,
  source: string,
  request: JsonObject,
  options?: InvocationOptions,
): Promise<JsonObject> {
  if (request.operation === 'prepare_media') {
    const upload = v.safeParse(v.object({ base64: v.string() }), request.upload);

    if (
      upload.success &&
      (upload.output.base64.length > Math.ceil(maximumUploadBytes / 3) * 4 ||
        (uploadByteSize(request) ?? 0) > maximumUploadBytes)
    ) {
      return {
        ok: false,
        error: 'upload_too_large',
        operation: request.operation,
        operation_started: false,
        persistence: 'not_attempted',
        diagnostics: { path: 'upload.base64', maximum_upload_bytes: maximumUploadBytes },
        next: 'correct_request',
        hint: uploadLimitHint,
      };
    }
  }

  if (options && typeof options.write_receipt !== 'function') {
    return receiptFailure(request);
  }

  const stored = await storeReceipt(options, request.receipt);

  if (stored !== true) {
    return receiptFailure(request, undefined, stored);
  }

  return invoke(capability, source, request, options);
}

async function invoke(
  capability: BrowserCapability,
  source: string,
  request: JsonObject,
  options?: InvocationOptions,
): Promise<JsonObject> {
  const started = Date.now();
  const deadline = Math.min(started + 45000, options?.deadline ?? Infinity);
  let jobId: string | undefined;
  let stage = 'start';
  let received = false;
  let delayedChecks = 0;
  let lastDelay: unknown;
  const remaining = () => ({ timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())) });

  try {
    const expression = `${source}\n(${JSON.stringify(request)})`;

    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: 'browser_deadline_exhausted',
        operation: request.operation,
        operation_started: false,
        persistence: 'not_attempted',
        editor_result: 'not_attempted',
        diagnostics: { stage: 'before_invocation' },
        next: 'retry',
        hint: 'The batch deadline expired before this request reached the page. No browser operation started for this request. Retry within a fresh batch budget; retain receipts and verify any earlier uncertain writes before proceeding.',
      };
    }

    const evaluation = v.parse(
      EvaluationSchema,
      await capability.send(
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: false,
          returnByValue: false,
          objectGroup: 'blockwork-invocation',
        },
        remaining(),
      ),
    );
    jobId = evaluation.result?.objectId;

    if (evaluation.exceptionDetails) {
      throw new PageFailure('engine_exception', evaluation.exceptionDetails);
    }

    if (!jobId) {
      throw new PageFailure('no_job');
    }

    stage = 'poll';

    while (Date.now() < deadline) {
      try {
        const properties = v.parse(
          PropertiesSchema,
          await capability.send(
            'Runtime.getProperties',
            { objectId: jobId, ownProperties: true },
            remaining(),
          ),
        );
        const state = properties.internalProperties.find((p) => p.name === '[[PromiseState]]')
          ?.value.value;

        if (state === 'fulfilled' || state === 'rejected') {
          stage = 'result';
          const response = v.parse(
            EvaluationSchema,
            await capability.send(
              'Runtime.awaitPromise',
              { promiseObjectId: jobId, returnByValue: true },
              remaining(),
            ),
          );

          if (response.exceptionDetails || !response.result?.value) {
            throw new PageFailure('no_result', response.exceptionDetails);
          }

          received = true;
          const stored = await storeReceipt(options, response.result.value.receipt);

          if (stored !== true) {
            return receiptFailure(request, response.result.value, stored);
          }

          return response.result.value;
        }

        if (state !== 'pending') {
          throw new PageFailure('promise_state_unavailable');
        }
      } catch (error) {
        // A busy or hidden page can hold one check past its own timeout while
        // the job keeps running. The handle remains, so check again until the
        // overall limit rather than report a result that may still arrive.
        if (failure(error).reason !== 'timeout') {
          throw error;
        }

        delayedChecks += 1;
        lastDelay = error;
        continue;
      }

      // Most edits settle within a second; poll quickly at first, then back off.
      const interval = Date.now() - started < 1000 ? 20 : 250;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(interval, Math.max(1, deadline - Date.now()))),
      );
    }

    return hostFailure(request, 'browser_operation_pending', {
      stage,
      jobId,
      started,
      deadline,
      delayedChecks,
      cause: lastDelay,
    });
  } catch (error) {
    // The browser refuses before sending the first command, so nothing started.
    if (stage === 'start' && failure(error).reason === 'documentation_unread') {
      const missing = unreadDocumentation(error);

      return withDebug(
        {
          ok: false,
          error: 'documentation_unread',
          operation: request.operation,
          operation_started: false,
          next: 'read_documentation',
          diagnostics: { missing },
          hint: documentationHint(missing),
        },
        error,
      );
    }

    if (stage === 'start' && failure(error).reason === 'browser_denied') {
      return withDebug(
        {
          ok: false,
          error: 'browser_access_denied',
          operation: request.operation,
          operation_started: false,
          next: 'ask_user',
          hint: "The browser's security policy refused page access for this site before anything started, so no content changed. Retrying will not help. Tell the user Blockwork can't edit this site until the browser allows it, and ask them to approve the permission prompt when they try again. If no prompt appeared, the chat's approval setting may be refusing by itself, so ask them to turn approvals on for this chat. A managed policy or site safety block has to be changed outside this chat. Never work around this through raw CDP or another browser API.",
        },
        error,
      );
    }

    return hostFailure(request, 'browser_command_failed', {
      stage,
      jobId,
      started,
      deadline,
      delayedChecks,
      cause: error,
    });
  } finally {
    // Retain a pending or unread Promise for read-only recovery. Release only
    // a settled handle, never cancel a native operation to force a verdict.
    if (jobId && received) {
      try {
        await capability.send('Runtime.releaseObject', { objectId: jobId }, remaining());
      } catch {
        // This releases a debugger handle, not editor state or a native lock.
      }
    }
  }
}

// The documents a browser refusal names, as authored labels. The browser's own
// documentation, which holds its confirmation rules, loads with cua.getBrowser,
// cua.createBrowserTab, or cua.getTab, once per browser in a REPL session.
function unreadDocumentation(cause: unknown): string[] {
  const message = v.is(HostErrorSchema, cause) ? cause.message : '';
  const listed = /has not been read: (.*?)\. Read the instructions/i.exec(message)?.[1] ?? '';
  const labels = [...listed.matchAll(/"([^"]+)"/g)].map(([, name]) => {
    if (name === 'capabilities/tab/cdp') {
      return 'cdp';
    }

    return name === 'confirmations' ? 'browser' : 'other';
  });

  return [...new Set(labels)];
}

function documentationHint(missing: string[]): string {
  const steps = [];

  if (missing.includes('browser')) {
    steps.push(
      "load this browser's documentation once with await cua.getBrowser({ id: BROWSER_ID }), using the tab's browser ID",
    );
  }

  if (missing.includes('cdp') || !missing.length) {
    steps.push('read nodeRepl.write(await (await tab.capabilities.get("cdp")).documentation())');
  }

  if (missing.includes('other')) {
    steps.push(
      'for a document Blockwork does not know, read the name in debug, in a development build, with await agent.documentation.get(NAME), or else report the refusal to the user',
    );
  }

  return `The browser refuses CDP commands until its required documentation has been read in this REPL session, so this request never reached the page. Each loads once per session: ${steps.join(', then ')}. Then call this operation again.`;
}

function failure(cause: unknown): JsonObject {
  if (cause instanceof PageFailure) {
    return { source: 'page', reason: cause.reason };
  }

  if (v.isValiError(cause)) {
    return { source: 'host_response', reason: 'unexpected_shape' };
  }

  // Host errors can come from another realm, so match their shape.
  const error: HostError | undefined = v.is(HostErrorSchema, cause) ? cause : undefined;

  return {
    source: 'host',
    error_name: errorNames.find((name) => name === error?.name) ?? 'other',
    reason: reasons.find(([pattern]) => pattern.test(error?.message ?? ''))?.[1] ?? 'unrecognized',
  };
}

// Resolves true once the receipt is stored, or with the storage error.
async function storeReceipt(
  options: InvocationOptions | undefined,
  receipt: JsonValue | undefined,
): Promise<true | Error> {
  if (!options || !v.is(JsonObjectSchema, receipt)) {
    return true;
  }

  try {
    await options.write_receipt(receipt);

    return true;
  } catch (error) {
    return new Error('Receipt storage failed.', { cause: error });
  }
}

function receiptFailure(request: JsonObject, result?: JsonObject, cause?: Error): JsonObject {
  return withDebug(
    {
      ok: false,
      error: 'receipt_storage_failed',
      operation: request.operation,
      operation_started: Boolean(result),
      operation_result: result,
      receipt: result?.receipt,
      persistence: result ? result.persistence : 'not_attempted',
      editor_result: result ? result.editor_result : 'not_attempted',
      diagnostics: { stage: result ? 'after_result' : 'before_invocation' },
      next: result ? 'store_receipt_do_not_replay' : 'store_receipt_before_retry',
      hint: result
        ? 'The browser operation returned, but receipt storage failed. Retain the complete operation_result and its receipt, repair storage, and store that receipt without invoking the operation again. Follow operation_result.next if the operation itself failed.'
        : 'Receipt storage is unavailable or the input receipt could not be stored. No browser operation started. Supply a working write_receipt function before invoking the requested operation.',
    },
    cause,
  );
}

// What follows a change that returned no page result, where status() cannot say.
const unconfirmed = new Map([
  ['save_resource', 'verify_resource_do_not_replay'],
  ['run_ability', 'report_uncertain_do_not_replay'],
]);

interface HostAttempt {
  stage: string;
  jobId: string | undefined;
  started: number;
  deadline: number;
  delayedChecks: number;
  cause?: unknown;
}

function uploadByteSize(request: JsonObject): number | undefined {
  const upload = v.safeParse(v.object({ base64: v.string() }), request.upload);

  if (!upload.success) {
    return undefined;
  }

  const { base64 } = upload.output;

  if (!base64.length || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return undefined;
  }

  const padding = base64.endsWith('==') ? 2 : Number(base64.endsWith('='));

  return (base64.length / 4) * 3 - padding;
}

function hostFailure(request: JsonObject, code: string, attempt: HostAttempt): JsonObject {
  const diagnostics = {
    stage: attempt.stage,
    job_id: attempt.jobId,
    elapsed_ms: Date.now() - attempt.started,
    budget_ms: attempt.deadline - attempt.started,
    delayed_checks: attempt.delayedChecks || undefined,
    upload_bytes: uploadByteSize(request),
    // A pending result's cause is its last delayed check, kept only for debug.
    failure:
      code === 'browser_command_failed' && attempt.cause !== undefined
        ? failure(attempt.cause)
        : undefined,
  };
  const browserUnavailable = diagnostics.failure?.reason === 'browser_unavailable';
  let bindingHint = browserUnavailable
    ? 'This caller holds a lost browser binding. Run await cua.getState() for a fresh browser and tab inventory, rebind the same editor or admin tab with const tab = await (await cua.getBrowser({ id: BROWSER_ID })).tabs.get(TAB_ID) using its current IDs, read nodeRepl.write(await (await tab.capabilities.get("cdp")).documentation()), and createBlockwork(tab) again. If this caller was connected to a document, reconnect with the original target and workflow, and call status() before any change. If this caller was used only for site-targeted operations, resume in that same admin tab with the same site target; settle any uncertain resource write with verify_resource first. Do not reload or navigate the tab. '
    : '';

  if (browserUnavailable && diagnostics.upload_bytes !== undefined) {
    bindingHint +=
      'Large uploads have coincided with this failure; the cause is unknown. After rebinding, a smaller or recompressed file is worth trying for a new preparation. ';
  }

  const preparation = ['prepare_save', 'prepare_media', 'prepare_term'].includes(
    String(request.operation),
  );

  if (preparation) {
    const waitHint =
      request.operation === 'prepare_save'
        ? 'Call status() until busy is false before retrying this preparation. '
        : 'Wait a few seconds before retrying this preparation; if it is still running, let it settle. ';

    return withDebug(
      {
        ok: false,
        error: code,
        operation: request.operation,
        next: browserUnavailable ? 'rebind_browser' : 'retry',
        diagnostics,
        hint:
          bindingHint +
          'This preparation writes no WordPress content. ' +
          waitHint +
          'Prepare again to obtain a fresh plan before saving; no save was invoked by this call.',
      },
      attempt.cause,
    );
  }

  const readOnly =
    readOnlyOperations.includes(String(request.operation)) ||
    // The engine sends a read run through GET, or refuses it before any request.
    (request.operation === 'run_ability' && request.effect === 'read');

  if (readOnly) {
    return withDebug(
      {
        ok: false,
        error: code,
        operation: request.operation,
        next: browserUnavailable ? 'rebind_browser' : 'retry',
        diagnostics,
        hint:
          bindingHint +
          'No result came back, but this operation changes no content. Wait a few seconds, then call it again. If it fails the same way, check diagnostics.failure.reason and that the tab is still open on the same page before anything else. Do not run the engine through CDP yourself.',
      },
      attempt.cause,
    );
  }

  return withDebug(
    {
      ok: false,
      error: code,
      operation: request.operation,
      next: unconfirmed.get(String(request.operation)) ?? 'check_status_do_not_replay',
      persistence: request.operation === 'save' ? 'uncertain' : undefined,
      diagnostics,
      hint:
        bindingHint +
        'The browser response did not establish an operation result. Retain any existing receipt and job_id. For editor operations, call status() until busy is false and read last_request; for resources, verify with the stored receipt; an ability run has no check, so tell the user its outcome is unknown. Never replay an uncertain mutation or reload the user editor.',
    },
    attempt.cause,
  );
}
