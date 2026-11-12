import * as v from 'valibot';
import {
  ApiErrorSchema,
  JsonObjectSchema,
  LinkUrlSchema,
  PostTypeSchema,
  SiteTargetSchema,
} from './contracts';
import type { JsonObject, JsonValue, Preparation, SiteTarget } from './contracts';
import type { WordPress } from './wordpress';
import {
  api,
  authenticate,
  awaitedRequest,
  bounded,
  budgetedMs,
  contract,
  readerIdentity,
  requireSignIn,
  RouteSchema,
  route,
  routeLabel,
  timedRequest,
  validateFields,
  writableFields,
} from './native';
import { requireCondition as assert } from './inspection';
import { escapeBareAmpersands, hash, same } from './values';
import { pause, remainingMs } from './timing';
import {
  BlockworkError,
  accessFailure,
  failureCode,
  invalidRequest,
  validationIssues,
} from './errors';
import { debugDetails } from './debug';
import { maximumUploadBytes } from './uploads';

const id = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const zeroId = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const slug = v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), v.maxLength(200));
const taxonomyName = v.pipe(v.string(), v.regex(/^[a-z0-9_-]{1,32}$/));
// Time save_resource keeps for its record reread and an upload's download.
const verifyReserveMs = 10000;

const query = {
  search: v.optional(v.pipe(v.string(), v.maxLength(256)), ''),
  limit: v.optional(v.pipe(id, v.maxValue(50)), 20),
  page: v.optional(id, 1),
};

const MediaFieldsSchema = v.strictObject({
  title: v.optional(v.string()),
  alt: v.optional(v.string()),
  caption: v.optional(v.string()),
  description: v.optional(v.string()),
  parent_id: v.optional(zeroId),
  slug: v.optional(slug),
});

const UploadSchema = v.strictObject({
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(200),
    v.check((name) =>
      [...name].every(
        (character) => character.charCodeAt(0) >= 32 && !['/', '\\'].includes(character),
      ),
    ),
  ),
  mime_type: v.pipe(v.string(), v.regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)),
  base64: v.pipe(
    v.string(),
    v.minLength(4),
    v.maxLength(Math.ceil(maximumUploadBytes / 3) * 4),
    v.check((value) => value.length % 4 === 0),
    v.regex(/^[A-Za-z0-9+/]*={0,2}$/),
  ),
});

const TermFieldsSchema = v.strictObject({
  name: v.optional(v.string()),
  slug: v.optional(slug),
  description: v.optional(v.string()),
  parent_id: v.optional(zeroId),
  meta: v.optional(JsonObjectSchema),
});

export const ResourceReceiptSchema = v.strictObject({
  key: digest,
  target: SiteTargetSchema,
  kind: v.picklist(['media', 'term']),
  action: v.picklist(['create', 'update', 'delete']),
  id: v.optional(id),
  taxonomy: v.optional(taxonomyName),
  original_token: v.nullable(digest),
  schema_token: digest,
  desired: JsonObjectSchema,
  upload: v.optional(
    v.strictObject({
      name: UploadSchema.entries.name,
      mime_type: UploadSchema.entries.mime_type,
      size: v.pipe(id, v.maxValue(maximumUploadBytes)),
      hash: digest,
    }),
  ),
  impact_token: v.optional(digest),
});

export type ResourceReceipt = v.InferOutput<typeof ResourceReceiptSchema>;

const ReaderTargetSchema = v.object({ ...SiteTargetSchema.entries, user_id: v.optional(id) });

export const ResourceRequestSchema = v.variant('operation', [
  v.strictObject({ operation: v.literal('resource_status'), target: SiteTargetSchema }),
  v.strictObject({
    operation: v.literal('discover'),
    target: ReaderTargetSchema,
    post_type: v.optional(PostTypeSchema),
    // A front-end address, resolved to the one document whose permalink it is.
    url: v.optional(LinkUrlSchema),
    ...query,
  }),
  v.pipe(
    v.strictObject({
      operation: v.literal('inspect_media'),
      target: ReaderTargetSchema,
      id: v.optional(id),
      // Full records for many attachments in one request, such as every image
      // a copied document uses.
      ids: v.optional(v.pipe(v.array(id), v.minLength(1), v.maxLength(50))),
      // Exact native slugs. WordPress search does not match file names.
      slugs: v.optional(
        v.pipe(
          v.array(v.pipe(v.string(), v.regex(/^[^\s,]+$/), v.maxLength(200))),
          v.minLength(1),
          v.maxLength(50),
        ),
      ),
      media_type: v.optional(v.picklist(['image', 'video', 'audio', 'application', 'text'])),
      ...query,
    }),
    v.check(
      (request) => [request.id, request.ids, request.slugs].filter(Boolean).length <= 1,
      'Provide at most one of id, ids, or slugs',
    ),
  ),
  v.strictObject({
    operation: v.literal('download_media'),
    target: SiteTargetSchema,
    id,
    timeout_ms: v.optional(v.pipe(id, v.maxValue(12000)), 12000),
  }),
  v.strictObject({
    operation: v.literal('inspect_terms'),
    target: ReaderTargetSchema,
    taxonomy: v.optional(taxonomyName),
    id: v.optional(id),
    parent_id: v.optional(zeroId),
    ...query,
  }),
  v.strictObject({
    operation: v.literal('prepare_media'),
    target: SiteTargetSchema,
    id: v.optional(id),
    edit_token: v.optional(digest),
    fields: MediaFieldsSchema,
    upload: v.optional(UploadSchema),
  }),
  v.strictObject({
    operation: v.literal('prepare_term'),
    target: SiteTargetSchema,
    taxonomy: taxonomyName,
    action: v.picklist(['create', 'update', 'delete']),
    id: v.optional(id),
    edit_token: v.optional(digest),
    fields: v.optional(TermFieldsSchema, {}),
    scope: v.optional(v.literal('all_relationships')),
  }),
  v.strictObject({
    operation: v.literal('save_resource'),
    target: SiteTargetSchema,
    receipt: ResourceReceiptSchema,
  }),
  v.strictObject({
    operation: v.literal('verify_resource'),
    target: SiteTargetSchema,
    receipt: ResourceReceiptSchema,
    resource_id: v.optional(id),
  }),
]);

export type ResourceRequest = v.InferInput<typeof ResourceRequestSchema>;

export interface ResourceSession {
  target: SiteTarget;
  busy: boolean;
  attempted: boolean;
  acknowledged: boolean;
  verified: boolean;
  settled: boolean;
  corrective_update?: { fields: string[]; acknowledged: boolean };
  receipt?: ResourceReceipt;
  upload?: v.InferOutput<typeof UploadSchema>;
  fields?: JsonObject;
  resource_id?: number;
  references?: Array<{ path: string; token: string }>;
}

export function entityToken(record: JsonValue): Promise<string> {
  return hash([
    location.origin,
    v.is(JsonObjectSchema, record)
      ? Object.fromEntries(
          Object.entries(record).filter(([key]) => !['_links', '_embedded'].includes(key)),
        )
      : record,
  ]);
}

const MediaSchema = v.object({
  id,
  media_type: v.string(),
  mime_type: v.string(),
  source_url: v.string(),
  media_details: JsonObjectSchema,
  alt_text: v.string(),
});

const MediaSummarySchema = v.object({
  ...MediaSchema.entries,
  title: v.object({ raw: v.string() }),
  media_details: v.object({
    width: v.optional(zeroId),
    height: v.optional(zeroId),
    sizes: v.optional(
      v.record(v.string(), v.object({ source_url: v.string(), width: zeroId, height: zeroId })),
    ),
  }),
});

const TaxonomySchema = v.object({
  ...RouteSchema.entries,
  types: v.array(v.string()),
  hierarchical: v.boolean(),
});

const TermSchema = v.object({
  id,
  taxonomy: v.string(),
  name: v.string(),
  slug: v.string(),
  count: zeroId,
});

export async function readMedia(wp: WordPress, media_id: number) {
  const record = await api(wp, `/wp/v2/media/${media_id}?context=edit`);
  assert(
    v.is(JsonObjectSchema, record) && v.is(MediaSchema, record) && record.id === media_id,
    'media_mismatch',
  );

  return { record, token: await entityToken(record) };
}

export async function taxonomy(wp: WordPress, name: string) {
  assert(
    v.is(taxonomyName, name) && !name.startsWith('wp_') && name !== 'nav_menu',
    'unsupported_taxonomy',
  );
  const value = await api(wp, `/wp/v2/taxonomies/${name}?context=edit`);
  assert(v.is(TaxonomySchema, value) && value.slug === name, 'taxonomy_mismatch');
  route(value);

  return value;
}

export async function mediaEdits(wp: WordPress, bindings: Preparation['media_bindings']) {
  const edits = [];
  const references = [];
  const resolved = [];

  for (const binding of bindings) {
    const media = await readMedia(wp, binding.media_id);
    assert(media.token === binding.media_token, 'stale_media');
    assert(
      media.record.media_type === 'image' ||
        (binding.size === 'full' && !binding.bind.alt && !binding.bind.size_slug),
      'unsupported_media_field',
    );
    const attributes: JsonObject = {};

    const sizes = v.is(JsonObjectSchema, media.record.media_details.sizes)
      ? media.record.media_details.sizes
      : {};

    const size = sizes[binding.size];
    let url: JsonValue | undefined;

    if (binding.size === 'full') {
      url = media.record.source_url;
    } else if (v.is(JsonObjectSchema, size)) {
      url = size.source_url;
    }

    assert(
      typeof url === 'string' && ['http:', 'https:'].includes(new URL(url).protocol),
      'media_size_unavailable',
    );
    const destinations = Object.values(binding.bind);
    assert(
      destinations.length && new Set(destinations).size === destinations.length,
      'invalid_media_binding',
    );

    if (binding.bind.id) {
      attributes[binding.bind.id] = media.record.id;
    }

    if (binding.bind.url) {
      attributes[binding.bind.url] = url;
    }

    if (binding.bind.alt) {
      attributes[binding.bind.alt] = media.record.alt_text;
    }

    if (binding.bind.size_slug) {
      attributes[binding.bind.size_slug] = binding.size;
    }

    edits.push({
      op: 'update' as const,
      path: binding.path,
      name: binding.name,
      attributes,
      unset: [],
    });
    references.push({ path: `/wp/v2/media/${binding.media_id}?context=edit`, token: media.token });
    resolved.push({ binding, record: media.record, token: media.token });
  }

  return { edits, references, resolved };
}

async function collection(wp: WordPress, receipt: Pick<ResourceReceipt, 'kind' | 'taxonomy'>) {
  if (receipt.kind === 'media') {
    return '/wp/v2/media';
  }

  assert(receipt.taxonomy, 'taxonomy_required');

  return route(await taxonomy(wp, receipt.taxonomy));
}

async function readRecord(
  wp: WordPress,
  path: string,
  receipt: Pick<ResourceReceipt, 'kind' | 'taxonomy'>,
  resource_id: number,
) {
  const record = await api(wp, `${path}/${resource_id}?context=edit`);
  assert(
    v.is(JsonObjectSchema, record) &&
      (receipt.kind === 'media' ? v.is(MediaSchema, record) : v.is(TermSchema, record)),
    'resource_mismatch',
  );
  assert(
    record.id === resource_id && (receipt.kind === 'media' || record.taxonomy === receipt.taxonomy),
    'resource_mismatch',
  );

  return record;
}

const DocumentRecordSchema = v.object({
  id,
  type: v.string(),
  status: v.string(),
  title: JsonObjectSchema,
  slug: v.string(),
  link: v.string(),
});
const documentFields = '_fields=id,type,status,title,slug,link';

// Origin and path without a trailing slash, with percent escapes in one case,
// because WordPress stores non-ASCII slugs with lowercase escapes.
function pageAddress(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/$/, '').replace(/%[0-9a-f]{2}/gi, (escape) => {
    return escape.toUpperCase();
  });

  return `${url.origin}${path}`;
}

// The one document whose permalink is a front-end address. The REST index
// names the home URL, which differs from the installation URL when WordPress
// sits in a subdirectory.
async function documentAt(
  wp: WordPress,
  url: string,
  types: Array<v.InferOutput<typeof RouteSchema>>,
) {
  const wanted = pageAddress(url);
  const index = v.parse(
    v.object({ home: LinkUrlSchema, show_on_front: v.string(), page_on_front: zeroId }),
    await api(wp, '/?_fields=home,show_on_front,page_on_front'),
  );
  const home = pageAddress(index.home);
  assert(wanted === home || wanted.startsWith(`${home}/`), 'url_outside_site');
  // Plain permalinks, shortlinks, and draft previews name the document by ID.
  const query = new URL(url).searchParams;
  const queried = Number(query.get('page_id') ?? query.get('p'));
  const byId = Number.isSafeInteger(queried) && queried > 0;
  let records: Array<v.InferOutput<typeof DocumentRecordSchema>>;

  if (wanted === home && !byId) {
    const pages = types.find((type) => type.slug === 'page');
    // Any other query on the home address, such as a search, is not the front page.
    const front = index.show_on_front === 'page' && !query.size ? index.page_on_front : 0;
    assert(pages && front, 'document_not_found', { reason: 'no_front_page' });
    const record = await api(wp, `${route(pages)}/${front}?context=edit&${documentFields}`);
    records = [v.parse(DocumentRecordSchema, record)];
  } else {
    const slug = wanted.split('/').at(-1) ?? '';
    const search = new URLSearchParams({
      ...(byId ? { include: String(queried) } : { slug }),
      status: 'any',
      context: 'edit',
      per_page: '100',
    });
    const lists = await Promise.all(
      types.map((type) => api(wp, `${route(type)}?${search}&${documentFields}`)),
    );
    records = lists.flatMap((list) => v.parse(v.array(DocumentRecordSchema), list));
  }

  const matches = records.filter((record) =>
    byId ? record.id === queried : pageAddress(record.link) === wanted,
  );
  assert(matches.length === 1, 'document_not_found', {
    reason: matches.length ? 'ambiguous' : 'missing',
  });

  return matches[0];
}

async function deletionImpact(wp: WordPress, path: string, term: JsonObject) {
  const children = await api(
    wp,
    `${path}?context=edit&parent=${term.id}&per_page=100&_fields=id,parent`,
  );

  assert(Array.isArray(children), 'term_impact_unavailable');

  return {
    native_count: term.count,
    direct_children: children,
    complete: children.length < 100,
    impact_token: await hash([term.count ?? null, children]),
  };
}

async function publicRecord(record: JsonValue) {
  assert(v.is(JsonObjectSchema, record), 'invalid_native_response');

  return {
    ...Object.fromEntries(
      Object.entries(record).filter(([name]) => !['_links', '_embedded'].includes(name)),
    ),
    edit_token: await entityToken(record),
  };
}

async function mediaRecord(record: JsonValue) {
  const media = v.parse(
    v.object({ ...MediaSchema.entries, media_details: MediaSummarySchema.entries.media_details }),
    record,
  );
  assert(v.is(JsonObjectSchema, record), 'invalid_native_response');
  const fields: JsonObject = {};

  for (const name of ['title', 'caption', 'description']) {
    if (!Object.hasOwn(record, name)) {
      continue;
    }

    const text: JsonValue | undefined = record[name];
    assert(v.is(v.object({ raw: v.string() }), text), 'invalid_native_response');
    fields[name] = { raw: text.raw };
  }

  for (const name of ['slug', 'post', 'link', 'type']) {
    if (Object.hasOwn(record, name)) {
      fields[name] = record[name];
    }
  }

  return {
    ...fields,
    id: media.id,
    alt_text: media.alt_text,
    media_type: media.media_type,
    mime_type: media.mime_type,
    source_url: media.source_url,
    media_details: {
      width: media.media_details.width,
      height: media.media_details.height,
      sizes: media.media_details.sizes ?? {},
    },
    edit_token: await entityToken(record),
  };
}

// Lists give named dimensions; a single record also gives each size's URL.
async function mediaSummary(record: JsonValue) {
  const { media_details: details, ...summary } = v.parse(MediaSummarySchema, record);

  return {
    ...summary,
    width: details.width,
    height: details.height,
    sizes: Object.fromEntries(
      Object.entries(details.sizes ?? {})
        .filter(([name]) => name !== 'full')
        .map(([name, size]) => [name, `${size.width}x${size.height}`]),
    ),
    edit_token: await entityToken(record),
  };
}

function uploadBytes(upload: v.InferOutput<typeof UploadSchema>) {
  const value = Uint8Array.from(atob(upload.base64), (character) => character.charCodeAt(0));
  assert(value.length > 0 && value.length <= maximumUploadBytes, 'upload_too_large');

  return value;
}

async function bytesHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function receiptKey(receipt: ResourceReceipt) {
  const { key: _key, ...contents } = receipt;

  return hash(contents);
}

async function validateReceipt(receipt: ResourceReceipt) {
  assert(receipt.key === (await receiptKey(receipt)), 'receipt_mismatch');
  assert(
    receipt.action === 'create'
      ? receipt.id === undefined && receipt.original_token === null
      : receipt.id !== undefined && receipt.original_token !== null,
    'invalid_resource_identity',
  );
  assert(
    receipt.kind === 'term'
      ? receipt.taxonomy !== undefined && receipt.upload === undefined
      : receipt.taxonomy === undefined &&
          receipt.action !== 'delete' &&
          (receipt.action === 'create') === Boolean(receipt.upload),
    'invalid_resource_identity',
  );
  assert(receipt.action !== 'create' || v.is(slug, receipt.desired.slug), 'creation_slug_required');
  assert(
    receipt.action !== 'delete' || !Object.keys(receipt.desired).length,
    'invalid_resource_receipt',
  );
  bounded(receipt, 128 * 1024);
}

async function verifyUpload(record: JsonObject, upload: NonNullable<ResourceReceipt['upload']>) {
  try {
    assert(typeof record.source_url === 'string', 'upload_source_unavailable');
    const source = new URL(record.source_url);
    assert(
      source.origin === location.origin && !source.username && !source.password,
      'upload_source_unavailable',
    );

    const original = v.is(JsonObjectSchema, record.media_details)
      ? record.media_details.original_image
      : undefined;

    if (original !== undefined) {
      assert(
        typeof original === 'string' &&
          original.length > 0 &&
          !['.', '..'].includes(original) &&
          Array.from(original).every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ) &&
          !/[\\/%]/.test(original),
        'upload_source_unavailable',
      );
      source.pathname = `${source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1)}${encodeURIComponent(original)}`;
    }

    const bytes = await downloadBytes(source, upload.size);

    return bytes.length === upload.size && (await bytesHash(bytes)) === upload.hash
      ? 'matched'
      : 'different';
  } catch {
    return 'unavailable';
  }
}

async function downloadBytes(source: URL, maximum: number, timeoutMs = 12000) {
  assert(
    source.origin === location.origin && !source.username && !source.password,
    'media_download_source_unavailable',
  );
  const signal = AbortSignal.timeout(budgetedMs(timeoutMs));

  try {
    const response = await fetch(source.href, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
    assert(![401, 403].includes(response.status), 'media_download_authorization_required');
    assert(response.ok && response.body, 'media_download_unavailable');

    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;

    try {
      while (true) {
        const next = await reader.read();

        if (next.done) {
          break;
        }

        size += next.value.length;
        assert(size <= maximum && size <= maximumUploadBytes, 'media_download_too_large');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return bytes;
  } catch (error) {
    if (error instanceof BlockworkError) {
      throw error;
    }

    throw new BlockworkError(
      signal.aborted ? 'media_download_timeout' : 'media_download_unavailable',
      undefined,
      { cause: error },
    );
  }
}

async function verify(
  wp: WordPress,
  receipt: ResourceReceipt,
  resource_id: number | undefined,
  acknowledged: boolean,
) {
  assert(
    receipt.id === undefined || resource_id === undefined || resource_id === receipt.id,
    'resource_id_mismatch',
  );
  const path = await collection(wp, receipt);
  let selected = resource_id ?? receipt.id;

  if (!selected || (receipt.action === 'create' && !acknowledged)) {
    assert(typeof receipt.desired.slug === 'string', 'creation_slug_required');

    const found = await api(
      wp,
      `${path}?context=edit&slug=${encodeURIComponent(receipt.desired.slug)}&per_page=2`,
    );

    assert(Array.isArray(found), 'resource_lookup_failed');

    if (!found.length) {
      return { ok: false, persistence: 'uncertain', outcome: 'not_found', receipt };
    }

    if (found.length > 1) {
      return { ok: false, persistence: 'uncertain', outcome: 'ambiguous', receipt };
    }

    assert(v.is(v.object({ id }), found[0]), 'resource_lookup_failed');
    assert(selected === undefined || selected === found[0].id, 'resource_id_mismatch');
    selected = found[0].id;
  }

  let record: JsonObject;

  try {
    record = await readRecord(wp, path, receipt, selected);
  } catch (error) {
    const failure = v.safeParse(ApiErrorSchema, error);

    if (
      failure.success &&
      failure.output.data?.status === 404 &&
      failure.output.code ===
        (receipt.kind === 'term' ? 'rest_term_invalid' : 'rest_post_invalid_id')
    ) {
      return {
        ok: receipt.action === 'delete',
        persistence: receipt.action === 'delete' ? 'verified' : 'uncertain',
        outcome: receipt.action === 'delete' ? 'deleted' : 'not_found',
        resource_id: selected,
        receipt,
      };
    }

    throw error;
  }

  const original =
    receipt.original_token !== null && (await entityToken(record)) === receipt.original_token;

  if (receipt.action === 'delete') {
    return {
      ok: false,
      persistence: original ? 'original' : 'different',
      outcome: original ? 'matched_original' : 'different',
      resource_id: selected,
      receipt,
    };
  }

  const schema = await contract(wp, receipt.id ? `${path}/${selected}` : path);
  assert(schema.token === receipt.schema_token, 'resource_schema_mismatch');

  const actual = writableFields(record, schema.properties);
  const desiredSlug = receipt.desired.slug;
  const storedSlug = actual.slug;
  const slugMadeUnique =
    receipt.kind === 'media' &&
    receipt.action === 'create' &&
    typeof desiredSlug === 'string' &&
    typeof storedSlug === 'string' &&
    storedSlug.startsWith(`${desiredSlug}-`) &&
    /^\d+$/.test(storedSlug.slice(desiredSlug.length + 1));

  // Native term filters escape bare ampersands. Preserve existing entities and
  // all other differences, including HTML sanitization and metadata changes.
  const fields = Object.entries(receipt.desired)
    .filter(([name, value]) => {
      if (!Object.hasOwn(actual, name)) {
        return true;
      }

      if (same(actual[name], value)) {
        return false;
      }

      if (receipt.kind !== 'term' || !['name', 'description'].includes(name)) {
        return true;
      }

      if (typeof value !== 'string') {
        return true;
      }

      return !same(actual[name], escapeBareAmpersands(value));
    })
    .map(([name]) => name);
  const matches = fields.length === 0;
  let upload = 'matched';

  if (receipt.upload && !(acknowledged && record.mime_type === receipt.upload.mime_type)) {
    upload = await verifyUpload(record, receipt.upload);
  }

  const verified = matches && upload === 'matched';
  let persistence = 'different';
  let outcome = 'different';

  if (verified) {
    persistence = 'verified';
    outcome = 'matched_desired';
  } else if (upload !== 'matched') {
    persistence = 'uncertain';
    outcome = upload === 'different' ? 'upload_bytes_different' : 'upload_bytes_unavailable';
  } else if (original) {
    persistence = 'original';
    outcome = 'matched_original';
  }

  let error = fields.length ? 'verification_mismatch' : undefined;

  if (!error && upload !== 'matched') {
    error = upload === 'different' ? 'upload_bytes_different' : 'upload_bytes_unavailable';
  }

  return {
    ok: verified,
    persistence,
    outcome,
    resource_id: selected,
    receipt,
    record: receipt.kind === 'media' ? await mediaRecord(record) : await publicRecord(record),
    error,
    diagnostics: fields.length
      ? {
          fields: fields.slice(0, 12).map((name) => name.slice(0, 160)),
          slug_made_unique: slugMadeUnique || undefined,
        }
      : undefined,
    next:
      persistence === 'uncertain' && error !== 'upload_bytes_different'
        ? 'verify_resource_do_not_replay'
        : 'inspect_resource',
  };
}

function settledVerification(
  receipt: ResourceReceipt,
  persistence: string,
  acknowledged: boolean,
  error?: string,
): boolean {
  if (persistence === 'verified' || error === 'upload_bytes_different') {
    return true;
  }

  return (
    ['original', 'different'].includes(persistence) && (receipt.action !== 'create' || acknowledged)
  );
}

function resourceStatus(
  input: Extract<v.InferOutput<typeof ResourceRequestSchema>, { operation: 'resource_status' }>,
) {
  requireSignIn();
  assert(new URL(input.target.site_url).origin === location.origin, 'target_mismatch');
  const current = window.__blockwork_resources_v1;
  assert(!current || same(current.target, input.target), 'target_mismatch');

  // Local observation must neither acquire the session nor reset a running job's budget.
  return bounded({
    ok: true,
    busy: Boolean(current?.busy || window.__blockwork_editor?.busy),
    attempted: current?.attempted ?? false,
    verified: current?.verified ?? false,
    receipt: current?.receipt,
    resource_id: current?.resource_id,
  });
}

async function discoverDocuments(
  input: Extract<v.InferOutput<typeof ResourceRequestSchema>, { operation: 'discover' }>,
  wp: WordPress,
  target: SiteTarget,
  user: Awaited<ReturnType<typeof readerIdentity>>,
  browsing: string,
) {
  const types = v.parse(
    v.record(
      v.string(),
      v.object({
        ...RouteSchema.entries,
        supports: JsonObjectSchema,
        viewable: v.optional(v.boolean()),
      }),
    ),
    await api(wp, '/wp/v2/types?context=edit'),
  );

  const available = Object.values(types).filter(
    (type) => v.is(PostTypeSchema, type.slug) && type.supports.editor,
  );

  const base = input.target.site_url.replace(/\/$/, '');

  if (input.url) {
    const searched = available.filter(
      (type) => type.viewable && (!input.post_type || type.slug === input.post_type),
    );
    const record = await documentAt(wp, input.url, searched);

    return bounded({
      ok: true,
      target,
      user,
      record,
      editor_url: `${base}/wp-admin/post.php?post=${record.id}&action=edit`,
    });
  }

  if (!input.post_type) {
    return bounded({
      ok: true,
      target,
      user,
      types: available.map((type) => ({
        name: type.slug,
        collection: route(type),
        new_editor_url: `${base}/wp-admin/post-new.php?post_type=${type.slug}`,
      })),
    });
  }

  const type = available.find((item) => item.slug === input.post_type);
  assert(type, 'unsupported_post_type');

  if (type.slug === 'wp_block') {
    // The Allow header core-data's canUser reads. A plain wp-admin tab may not
    // load core-data, and apiFetch throws an unparsed error as its Response.
    const response = await timedRequest('OPTIONS /wp/v2/blocks', budgetedMs(12000), (signal) =>
      wp.apiFetch({
        path: '/wp/v2/blocks',
        method: 'OPTIONS',
        cache: 'no-store',
        signal,
        parse: false,
      }),
    ).catch(async (error: unknown) => {
      if (!(error instanceof Response)) {
        throw error;
      }

      // WordPress's own error, such as an ended session, classifies as it
      // would for a parsed request.
      let body: unknown;

      try {
        body = JSON.parse((await error.text()).slice(0, 64 * 1024));
      } catch {
        // Left undefined: the body is not WordPress's JSON error.
      }

      throw v.is(ApiErrorSchema, body) && body.code
        ? body
        : new BlockworkError('invalid_native_response', {
            request: 'OPTIONS /wp/v2/blocks',
            status: error.status,
          });
    });
    const allow = response.headers.get('allow');
    assert(allow !== null, 'invalid_native_response', {
      request: 'OPTIONS /wp/v2/blocks',
      status: response.status,
    });
    assert(
      allow.split(',').some((method) => method.trim() === 'POST'),
      'pattern_creation_forbidden',
      { capability: 'create', post_type: 'wp_block' },
    );
  }

  const records = await api(
    wp,
    `${route(type)}?${browsing}&status=any&_fields=id,type,status,title,slug,link`,
  );

  assert(Array.isArray(records), 'invalid_native_response');

  return bounded({
    ok: true,
    target,
    user,
    records,
    page: input.page,
    may_have_more: records.length === input.limit,
    new_editor_url: `${base}/wp-admin/post-new.php?post_type=${type.slug}`,
  });
}

async function downloadMedia(
  input: Extract<v.InferOutput<typeof ResourceRequestSchema>, { operation: 'download_media' }>,
  wp: WordPress,
  started: number,
) {
  const { record } = await readMedia(wp, input.id);
  assert(
    typeof record.source_url === 'string' && URL.canParse(record.source_url),
    'media_download_source_unavailable',
  );
  const source = new URL(record.source_url);
  const timeoutMs = input.timeout_ms - (Date.now() - started);
  assert(timeoutMs > 0, 'media_download_timeout');
  const bytes = await downloadBytes(source, maximumUploadBytes, timeoutMs);
  assert(bytes.length > 0, 'media_download_empty');
  const chunks = [];

  // Bound each spread to the browser's argument limit, including a 5 MiB file.
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }

  const upload = v.parse(UploadSchema, {
    name: decodeURIComponent(source.pathname.split('/').at(-1) ?? ''),
    mime_type: record.mime_type,
    base64: btoa(chunks.join('')),
  });

  return bounded({ ok: true, upload }, Math.ceil(maximumUploadBytes / 3) * 4 + 4096);
}

async function inspectMedia(
  input: Extract<v.InferOutput<typeof ResourceRequestSchema>, { operation: 'inspect_media' }>,
  wp: WordPress,
  target: SiteTarget,
  user: Awaited<ReturnType<typeof readerIdentity>>,
  browsing: string,
) {
  if (input.id) {
    return bounded({
      ok: true,
      target,
      user,
      record: await mediaRecord((await readMedia(wp, input.id)).record),
    });
  }

  if (input.ids || input.slugs) {
    const wanted = input.ids ?? input.slugs ?? [];
    const filter = input.ids
      ? `include=${input.ids.join(',')}&orderby=include`
      : `slug=${wanted.map((slug) => encodeURIComponent(slug)).join(',')}`;
    const found = await api(
      wp,
      `/wp/v2/media?context=edit&per_page=${wanted.length}&${filter}${input.media_type ? `&media_type=${input.media_type}` : ''}`,
    );
    assert(Array.isArray(found), 'invalid_native_response');
    const identities = v.parse(v.array(v.object({ id, slug: v.string() })), found);
    const keys = new Set(identities.map((record) => (input.ids ? record.id : record.slug)));
    const records = await Promise.all(found.map(mediaRecord));

    return bounded({
      ok: true,
      target,
      user,
      records,
      missing: wanted.filter((key) => !keys.has(key)),
    });
  }

  const records = await api(
    wp,
    `/wp/v2/media?${browsing}${input.media_type ? `&media_type=${input.media_type}` : ''}`,
  );

  assert(Array.isArray(records), 'invalid_native_response');

  return bounded({
    ok: true,
    target,
    user,
    records: await Promise.all(records.map(mediaSummary)),
    page: input.page,
    may_have_more: records.length === input.limit,
  });
}

async function inspectTerms(
  input: Extract<v.InferOutput<typeof ResourceRequestSchema>, { operation: 'inspect_terms' }>,
  wp: WordPress,
  target: SiteTarget,
  user: Awaited<ReturnType<typeof readerIdentity>>,
  browsing: string,
) {
  if (!input.taxonomy) {
    return bounded({
      ok: true,
      target,
      user,
      taxonomies: await api(wp, '/wp/v2/taxonomies?context=edit'),
    });
  }

  const tax = await taxonomy(wp, input.taxonomy);
  const path = route(tax);

  if (input.id) {
    const record = await readRecord(wp, path, { kind: 'term', taxonomy: input.taxonomy }, input.id);

    return bounded({
      ok: true,
      target,
      user,
      record: await publicRecord(record),
      impact: tax.hierarchical
        ? await deletionImpact(wp, path, record)
        : { native_count: record.count, direct_children: [], complete: true },
    });
  }

  assert(input.parent_id === undefined || tax.hierarchical, 'taxonomy_not_hierarchical');

  const records = await api(
    wp,
    `${path}?${browsing}${input.parent_id === undefined ? '' : `&parent=${input.parent_id}`}`,
  );

  assert(Array.isArray(records), 'invalid_native_response');

  return bounded({
    ok: true,
    target,
    user,
    records: await Promise.all(records.map(publicRecord)),
    page: input.page,
    may_have_more: records.length === input.limit,
  });
}

async function verifyResource(
  input: Extract<v.InferOutput<typeof ResourceRequestSchema>, { operation: 'verify_resource' }>,
  wp: WordPress,
  session: ResourceSession,
) {
  // Recovery consumes a receipt for reads only. It never restores a prepared write.
  if (!session.receipt) {
    session.receipt = input.receipt;
    session.attempted = true;
    session.resource_id = input.receipt.id;
  }

  const owned = session.receipt?.key === input.receipt.key;
  assert(!owned || same(session.receipt, input.receipt), 'receipt_mismatch');
  assert(
    !owned ||
      input.resource_id === undefined ||
      session.resource_id === undefined ||
      input.resource_id === session.resource_id,
    'resource_id_mismatch',
  );

  const result = await verify(
    wp,
    input.receipt,
    input.resource_id ?? (owned ? session.resource_id : undefined),
    owned && session.acknowledged,
  );

  if (owned) {
    session.verified = result.persistence === 'verified';
    session.settled ||= settledVerification(
      input.receipt,
      result.persistence,
      session.acknowledged,
      result.error,
    );
  }

  return {
    ...result,
    corrective_update: owned ? session.corrective_update : undefined,
    next:
      (owned && session.settled) ||
      settledVerification(
        input.receipt,
        result.persistence,
        owned && session.acknowledged,
        result.error,
      )
        ? 'inspect_resource'
        : 'verify_resource_do_not_replay',
  };
}

async function saveResource(
  input: Extract<v.InferOutput<typeof ResourceRequestSchema>, { operation: 'save_resource' }>,
  wp: WordPress,
  session: ResourceSession,
) {
  assert(
    session.receipt && same(input.receipt, session.receipt) && !session.attempted && session.fields,
    'resource_not_prepared',
  );
  const receipt = session.receipt;
  await validateReceipt(receipt);
  const path = await collection(wp, receipt);
  const schema = await contract(wp, receipt.id ? `${path}/${receipt.id}` : path);
  assert(schema.token === receipt.schema_token, 'stale_resource_schema');

  for (const reference of session.references ?? []) {
    const record = await api(wp, reference.path);
    const currentToken = await entityToken(record);
    assert(currentToken === reference.token, 'stale_resource_reference');
  }

  if (receipt.id) {
    const current = await readRecord(wp, path, receipt, receipt.id);
    assert((await entityToken(current)) === receipt.original_token, 'stale_resource');

    if (receipt.impact_token) {
      assert(
        (await deletionImpact(wp, path, current)).impact_token === receipt.impact_token,
        'stale_term_impact',
      );
    }
  } else {
    const found = await api(
      wp,
      `${path}?context=edit&slug=${encodeURIComponent(String(receipt.desired.slug))}&per_page=2`,
    );

    assert(Array.isArray(found) && found.length === 0, 'slug_already_exists');
  }

  let body: FormData | undefined;

  if (session.upload) {
    body = new FormData();
    body.append(
      'file',
      new Blob([uploadBytes(session.upload)], { type: session.upload.mime_type }),
      session.upload.name,
    );

    for (const [name, value] of Object.entries(session.fields)) {
      body.append(name, String(value));
    }
  }

  session.attempted = true;

  let response: JsonValue;

  if (receipt.action === 'delete') {
    response = await api(wp, `${path}/${receipt.id}?force=true`, 'DELETE');
  } else if (body) {
    const upload = body;
    // A fixed 30 seconds, not capped by the budget, and awaited to the end:
    // see awaitedRequest.
    response = await awaitedRequest(`POST ${routeLabel(path)}`, 30000, (signal) =>
      wp.apiFetch({ path, method: 'POST', body: upload, cache: 'no-store', signal }),
    );
  } else {
    response = await api(wp, receipt.id ? `${path}/${receipt.id}` : path, 'POST', session.fields);
  }

  if (receipt.action !== 'delete') {
    assert(
      v.is(v.object({ id }), response) && (!receipt.id || response.id === receipt.id),
      'resource_save_unconfirmed',
    );
    session.resource_id = response.id;
  }

  session.acknowledged = true;

  // Verifying rereads the record and can download an upload again. When
  // too little of this call's time is left, report the acknowledged write
  // rather than start a verification the invoker would cut off.
  if (remainingMs() < verifyReserveMs) {
    return {
      ok: false,
      error: 'verification_deferred',
      persistence: 'uncertain',
      receipt,
      resource_id: session.resource_id,
      next: 'verify_resource_do_not_replay',
    };
  }

  let result = await verify(wp, receipt, session.resource_id, session.acknowledged);

  if (
    receipt.kind === 'media' &&
    receipt.action === 'create' &&
    result.persistence === 'different' &&
    'diagnostics' in result &&
    result.diagnostics
  ) {
    const correction: JsonObject = {};

    for (const name of result.diagnostics.fields) {
      if (name === 'slug' && result.diagnostics.slug_made_unique) {
        continue;
      }

      assert(
        ['title', 'alt_text', 'caption', 'description', 'post', 'slug'].includes(name),
        'unsupported_media_field',
      );
      correction[name] = receipt.desired[name];
    }

    const fields = Object.keys(correction);

    if (fields.length) {
      // Correction is an update of the acknowledged ID, never another upload.
      session.corrective_update = { fields, acknowledged: false };
      const corrected = await api(wp, `${path}/${session.resource_id}`, 'POST', correction);
      assert(
        v.is(v.object({ id }), corrected) && corrected.id === session.resource_id,
        'resource_save_unconfirmed',
      );
      session.corrective_update.acknowledged = true;

      if (remainingMs() < verifyReserveMs) {
        return {
          ok: false,
          error: 'verification_deferred',
          persistence: 'uncertain',
          receipt,
          resource_id: session.resource_id,
          corrective_update: session.corrective_update,
          next: 'verify_resource_do_not_replay',
        };
      }

      result = await verify(wp, receipt, session.resource_id, session.acknowledged);
    }
  }

  session.verified = result.persistence === 'verified';
  session.settled = settledVerification(
    receipt,
    result.persistence,
    session.acknowledged,
    result.error,
  );

  return { ...result, corrective_update: session.corrective_update };
}

async function prepareResource(
  input: Extract<
    v.InferOutput<typeof ResourceRequestSchema>,
    { operation: 'prepare_media' | 'prepare_term' }
  >,
  wp: WordPress,
  session: ResourceSession,
) {
  assert(!session.attempted || session.settled, 'verify_do_not_replay');
  const kind = input.operation === 'prepare_media' ? 'media' : 'term';
  let action: ResourceReceipt['action'];

  if (input.operation === 'prepare_media') {
    action = input.upload ? 'create' : 'update';
  } else {
    action = input.action;
  }

  assert(
    action === 'create' ? input.id === undefined : input.id !== undefined,
    'invalid_resource_identity',
  );
  const tax = input.operation === 'prepare_term' ? await taxonomy(wp, input.taxonomy) : undefined;
  const path = tax ? route(tax) : '/wp/v2/media';
  const schema = await contract(wp, input.id ? `${path}/${input.id}` : path);

  const receipt: ResourceReceipt = {
    key: '',
    target: input.target,
    kind,
    action,
    id: input.id,
    taxonomy: tax?.slug,
    original_token: null,
    schema_token: schema.token,
    desired: {},
  };

  const record = input.id ? await readRecord(wp, path, receipt, input.id) : undefined;

  if (record) {
    receipt.original_token = await entityToken(record);
    assert(input.edit_token === receipt.original_token, 'stale_resource');
  }

  const fields: JsonObject = Object.fromEntries(
    Object.entries(input.fields).map(([name, value]) => {
      let nativeName = name;

      if (name === 'alt') {
        nativeName = 'alt_text';
      } else if (name === 'parent_id') {
        nativeName = kind === 'media' ? 'post' : 'parent';
      }

      return [nativeName, value];
    }),
  );

  bounded(fields, 64 * 1024);
  validateFields(fields, schema.args);

  const references = [];

  if (tax && v.is(id, fields.parent)) {
    const seen = new Set([input.id]);
    let parent = fields.parent;

    while (parent) {
      assert(!seen.has(parent) && seen.size < 32, 'invalid_term_parent');
      seen.add(parent);
      const ancestor = await readRecord(wp, path, receipt, parent);
      assert(v.is(zeroId, ancestor.parent), 'term_parent_unavailable');
      references.push({
        path: `${path}/${parent}?context=edit`,
        token: await entityToken(ancestor),
      });
      parent = ancestor.parent;
    }
  }

  if (action === 'delete') {
    assert(
      input.operation === 'prepare_term' &&
        input.scope === 'all_relationships' &&
        record &&
        !Object.keys(fields).length,
      'term_deletion_scope_required',
    );

    if (tax?.hierarchical) {
      const impact = await deletionImpact(wp, path, record);
      assert(impact.complete && impact.direct_children.length === 0, 'term_has_children');
      receipt.impact_token = impact.impact_token;
    }
  } else {
    assert(Object.keys(fields).length > 0, 'no_change');

    if (action === 'create') {
      assert(fields.slug && (kind === 'media' || fields.name), 'creation_fields_required');

      const found = await api(
        wp,
        `${path}?context=edit&slug=${encodeURIComponent(String(fields.slug))}&per_page=2`,
      );

      assert(Array.isArray(found) && found.length === 0, 'slug_already_exists');
    }

    if (record && v.is(JsonObjectSchema, fields.meta)) {
      fields.meta = { ...v.parse(JsonObjectSchema, record.meta), ...fields.meta };
    }

    receipt.desired = { ...fields };

    if (record) {
      receipt.desired = { ...writableFields(record, schema.properties), ...fields };
    }

    assert(
      !record || !same(receipt.desired, writableFields(record, schema.properties)),
      'no_change',
    );
  }

  if (input.operation === 'prepare_media' && input.upload) {
    const bytes = uploadBytes(input.upload);
    const fileHash = await bytesHash(bytes);
    receipt.upload = {
      name: input.upload.name,
      mime_type: input.upload.mime_type,
      size: bytes.length,
      hash: fileHash,
    };
  }

  receipt.key = await receiptKey(receipt);
  session.receipt = receipt;
  session.fields = fields;
  session.references = references;
  session.upload = input.operation === 'prepare_media' ? input.upload : undefined;
  session.attempted = false;
  session.acknowledged = false;
  session.verified = false;
  session.settled = false;
  session.corrective_update = undefined;
  session.resource_id = input.id;

  return { ok: true, persistence: 'not_attempted', receipt };
}

export async function resourceOperation(request: ResourceRequest) {
  const started = Date.now();
  let session: ResourceSession | undefined;
  let entered = false;
  let recovery: ResourceReceipt | undefined;
  const validated = v.safeParse(ResourceRequestSchema, request);

  if (!validated.success) {
    return invalidRequest('invalid_resource_request', validated.issues);
  }

  try {
    const input = validated.output;

    if (input.operation === 'resource_status') {
      return resourceStatus(input);
    }

    if (input.operation === 'verify_resource') {
      assert(same(input.receipt.target, input.target), 'target_mismatch');
      await validateReceipt(input.receipt);
      recovery = input.receipt;
    }

    session = window.__blockwork_resources_v1;
    requireSignIn();
    const readyBy = Date.now() + Math.min(2000, remainingMs());

    while (
      (!window.wp?.apiFetch || !document.body) &&
      document.readyState !== 'complete' &&
      Date.now() < readyBy
    ) {
      await pause(50);
    }

    const wp = window.wp;
    assert(wp?.apiFetch, 'native_api_unavailable');
    const user =
      input.operation === 'save_resource' || input.operation === 'verify_resource'
        ? await authenticate(wp, input.target)
        : await readerIdentity(wp, input.target);
    const target = { site_url: input.target.site_url, user_id: user.id };
    session ??= {
      target,
      busy: false,
      attempted: false,
      acknowledged: false,
      verified: false,
      settled: false,
    };
    assert(same(session.target, target), 'target_mismatch');
    assert(!session.busy, 'operation_in_progress');
    window.__blockwork_resources_v1 = session;
    session.busy = true;
    entered = true;

    const browsing =
      'limit' in input
        ? `context=edit&search=${encodeURIComponent(input.search)}&per_page=${input.limit}&page=${input.page}`
        : '';

    if (input.operation === 'discover') {
      return await discoverDocuments(input, wp, target, user, browsing);
    }

    if (input.operation === 'download_media') {
      return await downloadMedia(input, wp, started);
    }

    if (input.operation === 'inspect_media') {
      return await inspectMedia(input, wp, target, user, browsing);
    }

    if (input.operation === 'inspect_terms') {
      return await inspectTerms(input, wp, target, user, browsing);
    }

    if (input.operation === 'verify_resource') {
      return await verifyResource(input, wp, session);
    }

    if (input.operation === 'save_resource') {
      return await saveResource(input, wp, session);
    }

    return await prepareResource(input, wp, session);
  } catch (error) {
    const parsed = v.safeParse(ApiErrorSchema, error);
    const failure = parsed.success ? parsed.output : undefined;
    const access = accessFailure(error);

    return {
      ok: false,
      error: failureCode(failure?.code, access, v.isValiError(error)),
      diagnostics: error instanceof BlockworkError ? error.diagnostics : access?.diagnostics,
      issues: v.isValiError(error) ? validationIssues(error.issues, 'native_response') : undefined,
      validation_source: v.isValiError(error) ? 'native_response' : undefined,
      persistence:
        recovery || (session?.attempted && !session.settled) ? 'uncertain' : 'not_attempted',
      receipt: recovery ?? session?.receipt,
      outcome: recovery ? 'unavailable' : undefined,
      resource_id: recovery?.id ?? session?.resource_id,
      next:
        recovery || (session?.attempted && !session.settled)
          ? 'verify_resource_do_not_replay'
          : 'inspect_resource',
      corrective_update: session?.corrective_update,
      debug: debugDetails(error),
    };
  } finally {
    if (entered && session) {
      session.busy = false;
    }
  }
}
