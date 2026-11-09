import * as v from 'valibot';
import type { JsonObject } from './contracts';

declare const BLOCKWORK_DEBUG: boolean;
// Development builds add the underlying error to each failure as `debug`, so
// Blockwork's own problems can be diagnosed from a run. Release builds compile
// this to false: agents get authored codes and hints, which cost less context
// than native, server, and host messages.
export const debug: boolean = BLOCKWORK_DEBUG;

const ErrorSchema = v.object({
  name: v.optional(v.string()),
  message: v.optional(v.string()),
  stack: v.optional(v.string()),
  code: v.optional(v.string()),
  data: v.optional(v.record(v.string(), v.unknown())),
  cause: v.optional(v.unknown()),
  errors: v.optional(v.array(v.unknown())),
});

// Messages can carry a nonce or token in a URL, header, or field; drop those
// values even in development.
function scrub(text: string, limit: number): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\b([\w-]*(?:nonce|token|password|secret|cookie|auth)[\w-]*)(["']?\s*[=:]\s*["']?)(?!Bearer \[redacted\])[^\s&"',;]+/gi,
      '$1$2[redacted]',
    )
    .slice(0, limit);
}

// Building a failure must never throw, whatever was thrown.
function text(cause: unknown, limit: number): string {
  try {
    return scrub(v.is(v.string(), cause) ? cause : (JSON.stringify(cause) ?? String(cause)), limit);
  } catch {
    return 'unreadable';
  }
}

// The thrown value behind a failure, with its causes, bounded for a result.
export function debugDetails(cause: unknown, depth = 0): JsonObject | undefined {
  if (!debug || cause === undefined) {
    return undefined;
  }

  // A throwing getter or proxy must not turn a failure into an exception.
  try {
    return details(cause, depth);
  } catch {
    return { value: 'unreadable' };
  }
}

function details(cause: unknown, depth: number): JsonObject {
  const parsed = v.safeParse(ErrorSchema, cause);

  if (!parsed.success) {
    return { value: text(cause, 1000) };
  }

  const error = parsed.output;
  const { status, ...data } = error.data ?? {};
  // Room for an edit error, its rollback failure, and that failure's cause.
  const nested = depth < 3;

  return {
    name: error.name,
    code: error.code,
    status: v.is(v.number(), status) ? status : undefined,
    message: error.message && error.message !== error.code ? scrub(error.message, 2000) : undefined,
    data: Object.keys(data).length ? text(data, 1000) : undefined,
    // The first line repeats the message.
    stack: error.stack ? scrub(error.stack.split('\n').slice(1, 7).join('\n'), 1500) : undefined,
    cause: nested ? debugDetails(error.cause, depth + 1) : undefined,
    errors: nested
      ? error.errors?.slice(0, 3).map((item) => debugDetails(item, depth + 1) ?? {})
      : undefined,
  };
}

// Host-side results are printed as objects, not serialized, so add the key
// only when it has content.
export function withDebug(result: JsonObject, cause: unknown): JsonObject {
  const details = debugDetails(cause);

  return details ? { ...result, debug: details } : result;
}
