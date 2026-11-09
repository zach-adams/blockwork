import * as v from 'valibot';
import { JsonObjectSchema, PostTypeSchema } from './contracts';
import type { JsonObject, Post, Preparation, Target } from './contracts';
import type { WordPress } from './wordpress';
import {
  api,
  budgetedMs,
  contract,
  RouteSchema,
  route,
  timedRequest,
  validateFields,
  writableFields,
} from './native';
import type { Contract } from './native';
import { containsPath, readTree, requireCondition as assert, validity } from './inspection';
import { hash, same } from './values';
import { entityToken, readMedia, taxonomy } from './resources';
import { recordPath, sharedType } from './shared';
import { documentBlocks } from './document-view';

const TypeSchema = v.object({ ...RouteSchema.entries, supports: JsonObjectSchema });

const TaxonomiesSchema = v.record(
  v.string(),
  v.object({ ...RouteSchema.entries, types: v.array(v.string()) }),
);

export async function documentContract(
  wp: WordPress,
  target: Pick<Target, 'post_id' | 'post_type'>,
) {
  const shared = sharedType(target.post_type);

  if (shared) {
    const schema = await contract(wp, recordPath(shared.collection, target.post_id));

    return { ...schema, collection: shared.collection, taxonomies: [], taxonomy_fields: [] };
  }

  assert(v.is(PostTypeSchema, target.post_type), 'unsupported_post_type');
  const [typeRecord, taxonomyRecords] = await Promise.all([
    api(wp, `/wp/v2/types/${target.post_type}?context=edit`),
    api(wp, '/wp/v2/taxonomies?context=edit'),
  ]);
  const type = v.parse(TypeSchema, typeRecord);
  assert(type.slug === target.post_type && type.supports.editor, 'unsupported_post_type');
  const collection = route(type);
  const schema = await contract(wp, recordPath(collection, target.post_id));
  const all = v.parse(TaxonomiesSchema, taxonomyRecords);
  const taxonomies = Object.values(all).filter((tax) => tax.types.includes(target.post_type));
  const taxonomy_fields = taxonomies.map((tax) => tax.rest_base).sort();

  return {
    ...schema,
    collection,
    taxonomies,
    taxonomy_fields,
    token: await hash([schema.token, taxonomy_fields]),
  };
}

export type DocumentContract = Awaited<ReturnType<typeof documentContract>>;

const baselineFields = [
  'id',
  'type',
  'status',
  'slug',
  'author',
  'password',
  'parent',
  'menu_order',
  'template',
  'featured_media',
  'comment_status',
  'ping_status',
  'sticky',
  'format',
  'categories',
  'tags',
  'meta',
  'theme',
  'area',
];

export function documentReadFields(schema: DocumentContract): string[] | undefined {
  const names = Object.keys(schema.properties);

  // _fields treats dots as nesting and cannot select a literal dotted key.
  if (names.some((name) => name.includes('.'))) {
    return undefined;
  }

  const fields = [...new Set([...names, ...baselineFields])].map((name) =>
    name === 'content' ? 'content.raw' : name,
  );

  // Core's pattern controller moves this out of meta without declaring it.
  if (schema.collection === '/wp/v2/blocks') {
    fields.push('wp_pattern_sync_status');
  }

  return [...fields, '_links'];
}

const coreFields = new Set([...baselineFields, 'title', 'excerpt', 'content', 'date', 'date_gmt']);

// Core posts a meta box's form after the REST save, and the form can rewrite
// meta keys and fields plugins add to the REST record, such as ACF's acf.
export function metaBoxField(name: string, taxonomyFields: string[]): boolean {
  return name === 'meta' || (!coreFields.has(name) && !taxonomyFields.includes(name));
}

// Preserve every editable REST field, including custom taxonomy bases. The
// explicit baseline also catches malformed or incomplete controller schemas.
export function documentFields(
  post: Post,
  schema: Contract & { taxonomy_fields: string[] },
  dates: string[] = [],
): JsonObject {
  return {
    ...Object.fromEntries(
      baselineFields.flatMap((name) => (Object.hasOwn(post, name) ? [[name, post[name]]] : [])),
    ),
    ...writableFields(post, schema.properties, dates, schema.taxonomy_fields),
    content: post.content.raw,
  };
}

interface Reference {
  path: string;
  token: string;
}

export interface SettingsPlan {
  values: JsonObject;
  original: JsonObject;
  meta_keys: string[];
  schema_token: string;
  references: Reference[];
  date_fields: Array<'date_gmt'>;
  binding_writes: Preparation['binding_writes'];
  creation_slug?: string;
}

async function bindingMeta(
  wp: WordPress,
  target: Target,
  writes: Preparation['binding_writes'],
  meta: JsonObject,
) {
  const rows = readTree(wp, documentBlocks(wp));
  const store = wp.data.select('core/block-editor');

  for (const write of writes) {
    const row = rows.find((item) => same(item.path, write.path) && item.name === write.name);
    assert(
      row &&
        store.canEditBlock(row.clientId) &&
        store.getBlockEditingMode(row.clientId) === 'default',
      'bound_block_not_editable',
    );
    const metadata = v.parse(JsonObjectSchema, row.attributes.metadata);
    const bindings = v.parse(JsonObjectSchema, metadata.bindings);

    const binding = v.parse(
      v.strictObject({
        source: v.literal('core/post-meta'),
        args: v.strictObject({ key: v.string() }),
      }),
      bindings[write.attribute],
    );

    const supported =
      store.getSettings?.().__experimentalBlockBindingsSupportedAttributes?.[row.name];

    assert(supported?.includes(write.attribute), 'binding_attribute_unsupported');

    // Gutenberg exposes declared context providers, but no public selector for
    // a block's resolved context. Admit only ancestors preserving the document.
    const ancestors = rows.filter(
      (item) => item.path.length < row.path.length && containsPath(item.path, row.path),
    );

    for (const ancestor of ancestors) {
      const type = wp.blocks.getBlockType(ancestor.name);
      assert(type && ancestor.name !== 'core/post-template', 'binding_context_unavailable');
      const changesDocumentContext = ['postId', 'postType', 'query', 'queryId'].some((key) =>
        Object.hasOwn(type.providesContext ?? {}, key),
      );
      assert(!changesDocumentContext, 'binding_context_unavailable');
    }

    const context = { postId: target.post_id, postType: target.post_type };

    assert(!binding.args.key.startsWith('_'), 'private_meta_unsupported');
    assert(v.is(v.number(), target.post_id), 'unsupported_binding_target');

    const postId = target.post_id;
    const allowed = await timedRequest('core/canUser', budgetedMs(12000), async () =>
      wp.data
        .resolveSelect?.('core')
        .canUser?.('update', { kind: 'postType', name: target.post_type, id: postId }),
    );

    const source = wp.blocks.getBlockBindingsSource?.('core/post-meta');
    assert(
      allowed &&
        source?.canUserEditValue?.({ select: wp.data.select, context, args: binding.args }),
      'binding_write_refused',
    );
    assert(
      !Object.hasOwn(meta, binding.args.key) || same(meta[binding.args.key], write.value),
      'conflicting_meta_write',
    );
    meta[binding.args.key] = write.value;
  }
}

export async function prepareSettings(
  wp: WordPress,
  input: Preparation,
  post: Post,
  schema: DocumentContract,
): Promise<SettingsPlan> {
  const values: JsonObject = {};
  const references: Reference[] = [];

  if (sharedType(input.target.post_type)) {
    assert(!input.post && !input.settings && !input.binding_writes.length, 'shared_content_only');

    return {
      values,
      original: {},
      meta_keys: [],
      references,
      schema_token: schema.token,
      date_fields: [],
      binding_writes: [],
    };
  }

  for (const [key, value] of Object.entries(input.post ?? {})) {
    const name = key === 'parent_id' ? 'parent' : key;

    values[name] = value;
  }

  const meta = { ...input.settings?.meta };
  await bindingMeta(wp, input.target, input.binding_writes, meta);

  if (Object.keys(meta).length) {
    validateFields({ meta }, schema.args);
    assert(v.is(JsonObjectSchema, post.meta), 'meta_unavailable');
    values.meta = { ...post.meta, ...meta };
  }

  const featured = input.settings?.featured_media;

  if (featured !== undefined) {
    values.featured_media = featured === 0 ? 0 : featured.id;

    if (featured !== 0) {
      const media = await readMedia(wp, featured.id);
      assert(
        media.token === featured.media_token && media.record.media_type === 'image',
        'stale_featured_media',
      );
      references.push({ path: `/wp/v2/media/${featured.id}?context=edit`, token: media.token });
    }
  }

  for (const [name, ids] of Object.entries(input.settings?.taxonomies ?? {})) {
    const tax = await taxonomy(wp, name);
    assert(tax.types.includes(input.target.post_type), 'taxonomy_not_attached');
    values[tax.rest_base] = [...new Set(ids)].sort((a, b) => a - b);
    references.push({
      path: `/wp/v2/taxonomies/${name}?context=edit`,
      token: await entityToken(tax),
    });

    for (const id of ids) {
      const path = `${route(tax)}/${id}?context=view`;
      const term = await api(wp, path);
      assert(
        v.is(v.object({ id: v.literal(id), taxonomy: v.literal(name) }), term),
        'term_mismatch',
      );
      references.push({ path, token: await entityToken(term) });
    }
  }

  if (input.post?.parent_id) {
    assert(input.post.parent_id !== input.target.post_id, 'invalid_parent');
    let parent = input.post.parent_id;
    const seen = new Set([input.target.post_id]);

    while (parent) {
      assert(!seen.has(parent) && seen.size < 32, 'invalid_parent');
      seen.add(parent);
      // Only the chain matters, and a parent's rendered content can exceed the
      // response limit. The saved reference rechecks the same projection.
      const path = `${schema.collection}/${parent}?context=edit&_fields=id,type,parent`;
      const raw = await api(wp, path);

      const record = v.parse(
        v.object({ id: v.number(), type: v.string(), parent: v.number() }),
        raw,
      );

      assert(record.id === parent && record.type === input.target.post_type, 'invalid_parent');
      references.push({ path, token: await entityToken(raw) });
      parent = record.parent;
    }
  }

  if (post.status === 'auto-draft') {
    const creation = input.post;
    assert(
      creation &&
        creation.title?.trim() &&
        creation.slug &&
        ['draft', 'publish'].includes(creation.status ?? ''),
      'creation_fields_required',
    );

    const duplicates = await api(
      wp,
      `${schema.collection}?context=edit&status=any&slug=${encodeURIComponent(creation.slug)}&per_page=2`,
    );

    assert(Array.isArray(duplicates) && duplicates.length === 0, 'slug_already_exists');
  }

  if (values.status === 'future') {
    assert(
      v.is(v.string(), values.date_gmt) && Date.parse(`${values.date_gmt}Z`) > Date.now(),
      'future_date_required',
    );
  }

  // Full merged metadata may contain unrelated keys omitted from the schema.
  const postFields = Object.entries(values).filter(([name]) => name !== 'meta');
  validateFields(Object.fromEntries(postFields), schema.args);
  const date_fields: Array<'date_gmt'> = values.date_gmt === undefined ? [] : ['date_gmt'];
  const original = documentFields(post, schema, date_fields);

  for (const name of Object.keys(values)) {
    assert(Object.hasOwn(original, name), 'field_unavailable');
  }

  if (Object.keys(values).length) {
    const blocks = documentBlocks(wp);
    const rows = readTree(wp, blocks);
    assert(validity(rows).valid, 'unsupported_settings_document');
  }

  return {
    values,
    original: Object.fromEntries(Object.keys(values).map((name) => [name, original[name]])),
    meta_keys: Object.keys(meta),
    schema_token: schema.token,
    references,
    date_fields,
    binding_writes: input.binding_writes,
    creation_slug: post.status === 'auto-draft' ? input.post?.slug : undefined,
  };
}

// Native post meta merges patches into the current pending object.
export function settingsPatch(settings: SettingsPlan, original = false): JsonObject {
  const values = original ? settings.original : settings.values;

  if (!Object.hasOwn(values, 'meta')) {
    return values;
  }

  const meta = v.parse(JsonObjectSchema, values.meta);

  return { ...values, meta: Object.fromEntries(settings.meta_keys.map((key) => [key, meta[key]])) };
}

export function settingsGuide(post: Post, schema: DocumentContract) {
  const fieldEntries = Object.entries(schema.args).filter(([name]) =>
    [
      'title',
      'excerpt',
      'slug',
      'status',
      'template',
      'parent',
      'menu_order',
      'date_gmt',
      'featured_media',
      'meta',
    ].includes(name),
  );
  const fields = Object.fromEntries(fieldEntries);
  const currentValues = documentFields(post, schema, ['date_gmt']);
  const values = Object.fromEntries(Object.keys(fields).map((name) => [name, currentValues[name]]));

  return { fields, values, taxonomies: schema.taxonomies, schema_token: schema.token };
}
