import * as v from 'valibot';
import { ApiErrorSchema, JsonObjectSchema, JsonSchema, SiteTargetSchema } from './contracts';
import type { JsonObject, JsonValue } from './contracts';
import type { ApiRequest, WordPress } from './wordpress';
import {
  FieldSchema,
  api,
  authenticate,
  bounded,
  budgetedMs,
  readerIdentity,
  requireSignIn,
  routeLabel,
  timedRequest,
} from './native';
import { schemaIssue } from './schema';
import { requireCondition as assert } from './inspection';
import { BlockworkError, failureCode, invalidRequest, validationIssues } from './errors';
import { debugDetails } from './debug';
import { remainingMs } from './timing';

const collection = '/wp-abilities/v1/abilities';
const pageSize = 50;
// Ability output above this size is reported by its byte count instead.
const maximumOutputBytes = 64 * 1024;
// Time a write or destructive run must still have when it is sent.
const minimumRunMs = 10000;
// Core's own ability name rule, which also makes a name safe inside a route.
const abilityName = v.pipe(v.string(), v.maxLength(200), v.regex(/^[a-z0-9-]+\/[a-z0-9-]+$/));
const EffectSchema = v.picklist(['read', 'write', 'destructive']);

type Effect = v.InferOutput<typeof EffectSchema>;

// Blockwork's own reads come first, then one run: a read, or a change.
type Stage = 'lookup' | 'read' | 'change';

export const AbilityRequestSchema = v.variant('operation', [
  v.strictObject({
    operation: v.literal('inspect_abilities'),
    target: SiteTargetSchema,
    name: v.optional(abilityName),
    page: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1)), 1),
  }),
  v.strictObject({
    operation: v.literal('run_ability'),
    target: SiteTargetSchema,
    name: abilityName,
    effect: EffectSchema,
    input: v.optional(JsonSchema),
    skip_input_check: v.optional(v.literal(true)),
  }),
]);

export type AbilityRequest = v.InferInput<typeof AbilityRequestSchema>;

// The plugin that registers an ability writes its label, description, schema,
// and output. They reach the caller as site data, bounded here.
const AbilitySchema = v.object({
  name: abilityName,
  label: v.optional(v.string(), ''),
  description: v.optional(v.string(), ''),
  input_schema: v.optional(JsonSchema),
  meta: v.optional(v.object({ annotations: v.optional(JsonSchema) }), {}),
});

type Ability = v.InferOutput<typeof AbilitySchema>;

// Refusals Blockwork makes itself before a run, which a corrected request fixes.
const localRefusals = [
  'ability_effect_mismatch',
  'ability_input_rejected',
  'ability_query_input_unsupported',
];

// WordPress's own answers, named for a stage where nothing can have changed.
const answers = new Map([
  ['rest_ability_not_found', 'ability_unavailable'],
  ['rest_ability_cannot_execute', 'ability_forbidden'],
  ['ability_invalid_input', 'ability_input_rejected'],
  ['ability_missing_input_schema', 'ability_input_rejected'],
]);

function annotations(ability: Ability): JsonObject {
  const declared = ability.meta.annotations;

  return v.is(JsonObjectSchema, declared) ? declared : {};
}

// PHP's empty(), which core applies to each annotation, whatever its type.
function phpEmpty(value: JsonValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    value === '' ||
    value === '0' ||
    (Array.isArray(value) && value.length === 0)
  );
}

// The method WP_REST_Abilities_V1_Run_Controller requires for these
// annotations. It answers 405 to any other.
function runMethod(ability: Ability) {
  const { readonly, destructive, idempotent } = annotations(ability);

  if (!phpEmpty(readonly)) {
    return 'GET';
  }

  return !phpEmpty(destructive) && !phpEmpty(idempotent) ? 'DELETE' : 'POST';
}

// A read is exactly what core sends through GET. An ability that declares
// nothing else may overwrite or delete, as far as a caller can tell, so only
// an explicit `destructive: false` makes it a plain write.
function declaredEffect(ability: Ability): Effect {
  if (runMethod(ability) === 'GET') {
    return 'read';
  }

  return annotations(ability).destructive === false ? 'write' : 'destructive';
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function summary(ability: Ability, descriptionLimit: number) {
  return {
    name: ability.name,
    label: clip(ability.label, 120),
    effect: declaredEffect(ability),
    description: clip(ability.description, descriptionLimit),
  };
}

// Object keys the query transport rewrites: wp.url takes an own `constructor`
// for a non-object, wp.apiFetch's locale step renames `prototype`, brackets
// become nesting, and PHP reads an empty key as an append.
const unsafeQueryKey = /^$|[[\]]|^(?:constructor|prototype|__proto__)$/;

// The first place in an input that a query string cannot carry. wp.url drops
// an empty array or object and writes null as an empty string, so the ability
// would see a default or a different value in its place.
function queryGap(value: JsonValue, path = 'input'): string | undefined {
  if (value === null) {
    return path;
  }

  const named = v.is(JsonObjectSchema, value);

  if (!Array.isArray(value) && !named) {
    return undefined;
  }

  const entries = Object.entries(value);

  if (!entries.length) {
    return path;
  }

  for (const [key, item] of entries) {
    if (named && unsafeQueryKey.test(key)) {
      return `${path}.${key}`;
    }

    const gap = item === undefined ? undefined : queryGap(item, `${path}.${key}`);

    if (gap) {
      return gap;
    }
  }

  return undefined;
}

// The first place an input breaks the ability's schema, found before sending
// so that a mistake on a change is a plain refusal and not an uncertain run.
// The check is Blockwork's own and best effort: WordPress still validates
// every input, and a caller can skip the check and let WordPress judge.
function inputIssue(ability: Ability, given: JsonValue | undefined) {
  const declared = ability.input_schema;

  // A schema Blockwork cannot read is WordPress's to apply. That includes an
  // empty one: core publishes only the keywords it knows, so the schema it
  // validates against may hold more.
  if (!v.is(JsonObjectSchema, declared) || !Object.keys(declared).length) {
    return undefined;
  }

  // Core fills an omitted input from the schema's default.
  if (given === undefined && Object.hasOwn(declared, 'default')) {
    return undefined;
  }

  const schema = v.safeParse(FieldSchema, declared);

  return schema.success ? schemaIssue(given ?? null, schema.output, true, 'input') : undefined;
}

async function readAbility(wp: WordPress, name: string, fields: string) {
  return v.parse(AbilitySchema, await api(wp, `${collection}/${name}?_fields=${fields}`));
}

async function listAbilities(wp: WordPress, page: number) {
  // Schemas stay on the server until one ability is inspected by name.
  const records = await api(
    wp,
    `${collection}?per_page=${pageSize}&page=${page}&_fields=name,label,description,meta.annotations`,
  );

  assert(Array.isArray(records), 'invalid_native_response');

  return bounded({
    ok: true,
    abilities: records.map((record) => summary(v.parse(AbilitySchema, record), 200)),
    page,
    may_have_more: records.length === pageSize,
  });
}

// One run request, sent once. With its default parsing, wp.apiFetch answers a
// `rest_cookie_invalid_nonce` error by refreshing its nonce and sending the
// same request again, and an ability's own code can return that error after
// it changed something. Unparsed, apiFetch hands back the response as it is.
async function sendRun(wp: WordPress, request: ApiRequest) {
  let response: Response;

  try {
    response = await wp.apiFetch({ ...request, parse: false });
  } catch (thrown) {
    if (!(thrown instanceof Response)) {
      throw thrown;
    }

    response = thrown;
  }

  const text = await response.text();
  let body: JsonValue | undefined;

  try {
    const parsed = JSON.parse(text);
    body = v.is(JsonSchema, parsed) ? parsed : undefined;
  } catch {
    // Left undefined: the body is not JSON.
  }

  // WordPress answers 204 with no body. Any other success must be the
  // ability's JSON output. A page from a cache or a firewall, or PHP warnings
  // printed ahead of the output, shows nothing about the run.
  if (response.ok && response.status !== 204 && body === undefined) {
    throw new BlockworkError(
      'ability_output_unreadable',
      { status: response.status },
      { cause: new Error(text.slice(0, 500)) },
    );
  }

  return { ok: response.ok, status: response.status, body };
}

// A failure WordPress answered, as distinct from one that got no answer.
function siteFailure(stage: Stage, code: string | undefined, status: number | undefined) {
  // A site error code is an identifier, never its message.
  const diagnostics = {
    ability_error: code && /^[\w.:-]{1,80}$/.test(code) ? code : 'unrecognized',
    status,
  };

  // Only a success settles a change that was sent. WordPress refuses bad
  // input or a missing permission before the ability's code runs, but that
  // code can pass on the same errors from an inner request after it changed
  // something, and nothing in the answer tells the two apart.
  if (stage === 'change') {
    return {
      ok: false,
      error: 'ability_failed',
      diagnostics,
      persistence: 'uncertain',
      next: 'report_uncertain_do_not_replay',
    };
  }

  const signedOut =
    ['rest_cookie_invalid_nonce', 'rest_not_logged_in'].includes(code ?? '') ||
    // An ability can answer 401 for its own reasons, such as a remote service.
    // During a run only the controller's refusal means the session.
    (status === 401 && (stage === 'lookup' || code === 'rest_ability_cannot_execute'));

  let error = signedOut ? 'reauthorization_required' : answers.get(code ?? '');

  if (stage === 'lookup' && code === 'rest_no_route') {
    error = 'abilities_api_unavailable';
  }

  return {
    ok: false,
    error: error ?? 'ability_failed',
    diagnostics: error ? undefined : diagnostics,
    persistence: 'not_attempted',
    next: error === 'ability_input_rejected' ? 'correct_request' : 'inspect_abilities',
  };
}

export async function abilityOperation(request: AbilityRequest) {
  const validated = v.safeParse(AbilityRequestSchema, request);

  if (!validated.success) {
    return invalidRequest('invalid_ability_request', validated.issues);
  }

  const input = validated.output;
  let stage: Stage = 'lookup';

  try {
    requireSignIn();
    const wp = window.wp;
    const url = wp?.url;
    assert(wp?.apiFetch && url?.addQueryArgs, 'native_api_unavailable');
    await (input.operation === 'run_ability'
      ? authenticate(wp, input.target)
      : readerIdentity(wp, input.target));

    if (input.operation === 'inspect_abilities') {
      if (input.name === undefined) {
        return await listAbilities(wp, input.page);
      }

      const ability = await readAbility(
        wp,
        input.name,
        'name,label,description,input_schema,meta.annotations',
      );

      return bounded({
        ok: true,
        ability: { ...summary(ability, 2000), input_schema: ability.input_schema ?? null },
      });
    }

    const ability = await readAbility(wp, input.name, 'name,input_schema,meta.annotations');
    const effect = declaredEffect(ability);
    assert(input.effect === effect, 'ability_effect_mismatch', { declared_effect: effect });
    const method = runMethod(ability);
    const runPath = `${collection}/${input.name}/run`;
    // Core reads a null input as none, from the query and from JSON alike.
    const given = input.input ?? undefined;
    const mismatch = input.skip_input_check ? undefined : inputIssue(ability, given);
    assert(!mismatch, 'ability_input_rejected', mismatch);
    let path = runPath;

    // Core reads GET and DELETE input from the query and POST input from JSON.
    if (given !== undefined && method !== 'POST') {
      const gap = queryGap(given);
      assert(!gap, 'ability_query_input_unsupported', { path: gap?.slice(0, 200), method });
      path = url.addQueryArgs(runPath, { input: given });
    }

    const data = given !== undefined && method === 'POST' ? { input: given } : undefined;
    const label = `${method} ${routeLabel(runPath)}`;

    // A change sent with little time left could only come back uncertain.
    assert(effect === 'read' || remainingMs() >= minimumRunMs, 'request_timeout', {
      request: label,
      waited_ms: 0,
      operation_budget_spent: true,
    });
    stage = effect === 'read' ? 'read' : 'change';

    const answer = await timedRequest(label, budgetedMs(30000), (signal) =>
      sendRun(wp, { path, method, data, cache: 'no-store', signal }),
    );

    if (!answer.ok) {
      const site = v.safeParse(ApiErrorSchema, answer.body);

      return {
        ...siteFailure(stage, site.success ? site.output.code : undefined, answer.status),
        debug: debugDetails(answer.body ?? undefined),
      };
    }

    const output = answer.body ?? null;
    const output_bytes = new TextEncoder().encode(JSON.stringify(output)).length;

    if (output_bytes > maximumOutputBytes) {
      return { ok: true, effect, output_omitted: 'too_large', output_bytes };
    }

    return { ok: true, effect, output };
  } catch (error) {
    const parsed = v.safeParse(ApiErrorSchema, error);
    const code = parsed.success ? parsed.output.code : undefined;
    const unanswered = ['request_timeout', 'fetch_error', 'offline_error'].includes(code ?? '');

    // wp.apiFetch throws WordPress's parsed error for Blockwork's own reads.
    if (parsed.success && code && !unanswered && !(error instanceof BlockworkError)) {
      return {
        ...siteFailure(stage, code, parsed.output.data?.status),
        debug: debugDetails(error),
      };
    }

    const uncertain = stage === 'change';
    let next = 'inspect_abilities';

    if (uncertain) {
      next = 'report_uncertain_do_not_replay';
    } else if (unanswered) {
      next = 'retry';
    } else if (localRefusals.includes(code ?? '')) {
      next = 'correct_request';
    }

    return {
      ok: false,
      error: failureCode(code, undefined, v.isValiError(error)),
      diagnostics: error instanceof BlockworkError ? error.diagnostics : undefined,
      issues: v.isValiError(error) ? validationIssues(error.issues, 'native_response') : undefined,
      validation_source: v.isValiError(error) ? 'native_response' : undefined,
      persistence: uncertain ? 'uncertain' : 'not_attempted',
      next,
      debug: debugDetails(error),
    };
  }
}
