import * as v from 'valibot';
import { JsonObjectSchema, JsonSchema, SiteSchema, UserSchema } from './contracts';
import type { JsonObject, JsonValue, SiteTarget } from './contracts';
import type { ApiRequest, Attribute, WordPress } from './wordpress';
import { requireCondition as assert } from './inspection';
import { safeValue, schemaIssue } from './schema';
import { hash } from './values';
import { pause, remainingMs } from './timing';
import { BlockworkError } from './errors';

export const FieldSchema: v.GenericSchema<Attribute> = v.lazy(() =>
  v.object({
    type: v.optional(v.union([v.string(), v.array(v.string())])),
    enum: v.optional(v.array(JsonSchema)),
    items: v.optional(FieldSchema),
    properties: v.optional(v.record(v.string(), FieldSchema)),
    patternProperties: v.optional(v.record(v.string(), FieldSchema)),
    required: v.optional(v.union([v.array(v.string()), v.boolean()])),
    additionalProperties: v.optional(v.union([v.boolean(), FieldSchema])),
    minimum: v.optional(v.number()),
    maximum: v.optional(v.number()),
    minLength: v.optional(v.number()),
    maxLength: v.optional(v.number()),
    minItems: v.optional(v.number()),
    maxItems: v.optional(v.number()),
    uniqueItems: v.optional(v.boolean()),
    pattern: v.optional(v.string()),
    oneOf: v.optional(v.array(FieldSchema)),
    anyOf: v.optional(v.array(FieldSchema)),
    readonly: v.optional(v.boolean()),
    context: v.optional(v.array(v.string())),
    format: v.optional(v.string()),
  }),
);

const OptionsSchema = v.object({
  schema: v.object({ properties: v.record(v.string(), FieldSchema) }),
  endpoints: v.array(
    v.object({ methods: v.array(v.string()), args: v.record(v.string(), FieldSchema) }),
  ),
});

export const RouteSchema = v.object({
  slug: v.string(),
  rest_namespace: v.string(),
  rest_base: v.string(),
});

export function bounded<T extends JsonValue>(value: T, maximum = 256 * 1024): T {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  assert(encoded.length <= maximum, 'response_too_large', {
    response_bytes: encoded.length,
    limit_bytes: maximum,
  });

  return value;
}

// limitMs, or less when the operation's budget is nearly spent.
export function budgetedMs(limitMs: number): number {
  return Math.max(1, Math.min(limitMs, remainingMs()));
}

// A REST path as diagnostics may show it: the namespace and collection, then
// :id for anything after them. Record IDs, template IDs such as theme//slug,
// and encoded text never pass through.
export function routeLabel(path: string): string {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const named = segments
    .slice(0, 3)
    .map((segment) => (/^[a-z][a-z0-9_.-]{0,39}$/i.test(segment) ? segment : ':id'));

  return `/${[...named, ...(segments.length > 3 ? [':id'] : [])].join('/')}`;
}

// Whether the wait ran to the operation's shared end is known when it starts.
// Checking the clock when the timer fires is unreliable: timers run on the
// event loop's cached clock and can fire a few milliseconds before Date.now()
// reaches the same instant.
function timeoutEvidence(request: string, waitMs: number, exhausts: boolean): JsonObject {
  return { request, waited_ms: waitMs, operation_budget_spent: exhausts };
}

// Runs one request, or a native call that makes requests, and settles by
// waitMs. apiFetch reports its own signal's abort as fetch_error, and its
// nonce refresh sends a follow-up request without the signal, so the signal
// alone decides a timeout and is also raced directly. request labels it in
// diagnostics with a method and route or a fixed name.
export async function timedRequest<T>(
  request: string,
  waitMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(waitMs);
  const exhausts = waitMs >= remainingMs();
  const expired = Symbol('expired');
  // One task late, so a native rejection from the same abort wins and keeps
  // its cause for debug.
  const aborted = new Promise<typeof expired>((resolve) => {
    signal.addEventListener('abort', () => pause(0).then(() => resolve(expired)), { once: true });
  });
  let outcome: T | typeof expired;

  try {
    outcome = await Promise.race([run(signal), aborted]);
  } catch (error) {
    if (signal.aborted) {
      throw new BlockworkError('request_timeout', timeoutEvidence(request, waitMs, exhausts), {
        cause: error,
      });
    }

    throw error;
  }

  if (outcome === expired) {
    throw new BlockworkError('request_timeout', timeoutEvidence(request, waitMs, exhausts));
  }

  return outcome;
}

// timedRequest without the race, for a media upload. apiFetch's media
// post-processing runs on without the signal and deletes the attachment if it
// fails, so the call must not end, and free the resource session for an early
// verify_resource, until that pipeline does.
export async function awaitedRequest<T>(
  request: string,
  waitMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(waitMs);
  const exhausts = waitMs >= remainingMs();

  try {
    return await run(signal);
  } catch (error) {
    if (signal.aborted) {
      throw new BlockworkError('request_timeout', timeoutEvidence(request, waitMs, exhausts), {
        cause: error,
      });
    }

    throw error;
  }
}

export async function api(
  wp: WordPress,
  path: string,
  method: ApiRequest['method'] = 'GET',
  data?: JsonObject,
  maximum?: number,
) {
  const value = await timedRequest(`${method} ${routeLabel(path)}`, budgetedMs(12000), (signal) =>
    wp.apiFetch({ path, method, data, cache: 'no-store', signal }),
  );

  assert(v.is(JsonSchema, value), 'invalid_native_response');

  return bounded(value, maximum);
}

// A missing or expired sign-in sends wp-admin to the login form, where nothing
// can run. Only the user signs in; callers keep their own recovery fields.
export function requireSignIn() {
  assert(!location.pathname.endsWith('/wp-login.php'), 'reauthorization_required');
}

// The oldest release whose native lock and save checks passed. WordPress
// 7.0.0 and 7.0.1 also ship opt-in real-time collaboration, which hides the
// lock modal but leaves the lock state Blockwork reads intact.
const minimumVersion = { major: 7, minor: 0 };

// wp-admin names the running release in a body class such as version-7-0-2.
// An unreadable version refuses like an old one, but a page whose head
// scripts ran before its body exists is still loading.
export function requireSupportedWordPress(): void {
  assert(document.body, 'page_loading');
  const match = /(?:^|\s)version-(\d+)-(\d+)(?:-(\d+))?(?=\s|$)/.exec(document.body.className);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  assert(
    major > minimumVersion.major ||
      (major === minimumVersion.major && minor >= minimumVersion.minor),
    'wordpress_unsupported',
    {
      wordpress_version: match ? match.slice(1).filter(Boolean).join('.') : null,
      minimum_version: `${minimumVersion.major}.${minimumVersion.minor}`,
    },
  );
}

function requireSitePage(target: Pick<SiteTarget, 'site_url'>): URL {
  const site = new URL(target.site_url);
  assert(
    ['http:', 'https:'].includes(site.protocol) &&
      !site.username &&
      !site.password &&
      !site.search &&
      !site.hash,
    'invalid_site',
  );
  assert(
    location.origin === site.origin &&
      location.pathname.startsWith(`${site.pathname.replace(/\/$/, '')}/wp-admin/`),
    'target_mismatch',
  );
  requireSupportedWordPress();

  return site;
}

// Confirms the site and signed-in user over REST before an operation, and
// records them for this page load.
export async function authenticate(
  wp: WordPress,
  target: SiteTarget | Pick<SiteTarget, 'site_url'>,
) {
  const site = requireSitePage(target);
  const [userRecord, siteRecord] = await Promise.all([
    api(wp, '/wp/v2/users/me?context=edit'),
    api(wp, '/?_fields=url'),
  ]);
  const user = v.parse(UserSchema, userRecord);
  assert(!('user_id' in target) || user.id === target.user_id, 'user_mismatch', {
    expected_user_id: 'user_id' in target ? target.user_id : undefined,
    signed_in_user_id: user.id,
  });
  const index = v.parse(SiteSchema, siteRecord);
  const siteUrl = site.href.replace(/\/$/, '');
  assert(index.url.replace(/\/$/, '') === siteUrl, 'site_mismatch');
  window.__blockwork_identity = { site_url: siteUrl, user };

  return user;
}

// The identity this page last verified, for reads that cannot change the site.
// Asking WordPress again costs a round trip per call, which dominated resource
// reads on remote hosts. apiFetch refreshes its nonce after a sign-in change,
// so a later read can run as whoever is now signed in; every save, resource
// write, and recovery calls authenticate instead and refuses that change.
export async function readerIdentity(
  wp: WordPress,
  target: SiteTarget | Pick<SiteTarget, 'site_url'>,
) {
  const site = requireSitePage(target);
  const known = window.__blockwork_identity;
  const sameUser = !('user_id' in target) || known?.user.id === target.user_id;

  if (known?.site_url === site.href.replace(/\/$/, '') && sameUser) {
    return known.user;
  }

  return authenticate(wp, target);
}

export function route(value: v.InferOutput<typeof RouteSchema>): string {
  assert(
    [value.rest_namespace, value.rest_base].every(
      (part) =>
        /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(part) &&
        part.split('/').every((segment) => !['.', '..'].includes(segment)),
    ),
    'unsupported_rest_route',
  );

  return `/${value.rest_namespace}/${value.rest_base}`;
}

export async function contract(wp: WordPress, path: string) {
  const options = v.parse(OptionsSchema, await api(wp, path, 'OPTIONS'));
  const update = options.endpoints.find((item) => item.methods.includes('POST'));
  assert(update, 'native_write_unavailable');

  return {
    properties: options.schema.properties,
    args: update.args,
    token: await hash([options.schema.properties, update.args]),
  };
}

export type Contract = Awaited<ReturnType<typeof contract>>;

// PHP encodes an empty array as `[]`, so WordPress returns an empty
// object-typed value that way, at any depth, and accepts it back
// (rest_is_object). REST fields are checked with such values read as `{}`.
function restEquivalent(value: JsonValue, schema: Attribute): JsonValue {
  const types = [schema.type ?? []].flat();
  const items = schema.items;
  const extra = schema.additionalProperties;

  if (Array.isArray(value)) {
    if (!value.length && types.includes('object') && !types.includes('array')) {
      return {};
    }

    return items ? value.map((item) => restEquivalent(item, items)) : value;
  }

  if (!v.is(JsonObjectSchema, value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const property = schema.properties?.[key] ?? (extra && extra !== true ? extra : undefined);

      return [key, property && item !== undefined ? restEquivalent(item, property) : item];
    }),
  );
}

export function validateFields(
  fields: JsonObject,
  schema: Record<string, Attribute>,
  parent = '',
): void {
  safeValue(fields);

  for (const [name, value] of Object.entries(fields)) {
    const field = schema[name];
    const fieldPath = (parent ? `${parent}.${name}` : name).slice(0, 200);
    assert(
      field?.type && !field.readonly && (!field.context || field.context.includes('edit')),
      'field_not_writable',
      { field: fieldPath, constraint: 'writable_edit_context_field' },
    );

    // Each meta key is its own registered field, so check that each one is
    // writable first. The schema check below still covers meta-level rules.
    if (name === 'meta' && v.is(JsonObjectSchema, value)) {
      validateFields(value, field.properties ?? {}, fieldPath);
    }

    // WordPress accepts strings for the native title/excerpt/caption objects.
    const rawSchema = field.properties?.raw;
    const acceptsRawString =
      ['title', 'content', 'excerpt', 'caption', 'description'].includes(name) &&
      v.is(v.string(), value);
    const valueSchema = acceptsRawString && rawSchema ? rawSchema : field;
    const checked = value === undefined ? value : restEquivalent(value, valueSchema);
    const issue = schemaIssue(checked, valueSchema, false, fieldPath);

    assert(!issue, 'invalid_field_value', {
      field: issue?.path,
      expected_type: issue?.expected_type,
      constraint: issue?.constraint,
    });
  }
}

function rawValue(name: string, value: JsonValue | undefined): JsonValue | undefined {
  if (
    ['title', 'content', 'excerpt', 'caption', 'description'].includes(name) &&
    v.is(JsonObjectSchema, value) &&
    Object.hasOwn(value, 'raw')
  ) {
    return value.raw;
  }

  return value;
}

export function writableFields(
  record: JsonObject,
  schema: Record<string, Attribute>,
  dates: string[] = [],
  taxonomies: string[] = [],
): JsonObject {
  return Object.fromEntries(
    Object.entries(schema).flatMap(([name, field]) => {
      if (
        field.readonly ||
        (field.context && !field.context.includes('edit')) ||
        !Object.hasOwn(record, name) ||
        (['date', 'date_gmt'].includes(name) && !dates.includes(name))
      ) {
        return [];
      }

      const value =
        name === 'post' && record[name] === null && field.type === 'integer'
          ? 0
          : rawValue(name, record[name]);

      // Term membership has no semantic order. Other arrays, including meta, do.
      const normalized =
        taxonomies.includes(name) && field.items?.type === 'integer' && Array.isArray(value)
          ? [...value].sort((a, b) => Number(a) - Number(b))
          : value;

      return [[name, normalized]];
    }),
  );
}
