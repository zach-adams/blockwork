import * as v from 'valibot';
import type { FootnoteCheckpoint } from './explicit-footnotes';
import type { Plan } from './edits';
import type { DocumentContract, SettingsPlan } from './documents';
import type { Block } from './wordpress';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export const JsonSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([v.string(), v.number(), v.boolean(), v.null(), v.array(JsonSchema), JsonObjectSchema]),
);

// Keep the original keys. Record parsing drops prototype-named keys, which
// would silently change a requested value before the edit validator sees it.
export const JsonObjectSchema: v.GenericSchema<JsonObject> = v.custom<JsonObject>(
  (input) =>
    Object.prototype.toString.call(input) === '[object Object]' &&
    v.is(v.record(v.string(), v.optional(JsonSchema)), input),
);

const id = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const index = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const path = v.pipe(v.array(index), v.minLength(1), v.maxLength(15));
const parent = v.pipe(v.array(index), v.maxLength(14));
const name = v.pipe(
  v.string(),
  v.maxLength(200),
  v.regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
);
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const candidate = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const styleProperty = v.pipe(v.array(candidate), v.minLength(1), v.maxLength(8));
const styleProperties = v.optional(v.pipe(v.array(styleProperty), v.minLength(1), v.maxLength(32)));
// Inspection clamps larger values to 50 and reports it.
const limit = v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1)), 20);
export const SiteTargetSchema = v.object({ site_url: v.string(), user_id: id });

export type SiteTarget = v.InferOutput<typeof SiteTargetSchema>;

export const PostTypeSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9_-]{1,32}$/),
  v.check(
    (value) =>
      !value.startsWith('wp_') && !['attachment', 'revision', 'nav_menu_item'].includes(value),
  ),
);

export const TemplateIdSchema = v.pipe(
  v.string(),
  v.maxLength(255),
  v.regex(/^[a-zA-Z0-9_.-]+\/\/[a-zA-Z0-9_%.-]+$/),
);

export const SharedTypeSchema = v.picklist([
  'wp_block',
  'wp_template',
  'wp_template_part',
  'wp_navigation',
]);

// Check common identity fields before selecting the native target variant so
// missing fields retain their exact request paths instead of a union summary.
export const TargetIdentitySchema = v.objectWithRest(
  { ...SiteTargetSchema.entries, post_id: v.union([id, TemplateIdSchema]), post_type: v.string() },
  JsonSchema,
);

export const TargetSchema = v.union([
  v.strictObject({ ...SiteTargetSchema.entries, post_id: id, post_type: PostTypeSchema }),
  v.strictObject({
    ...SiteTargetSchema.entries,
    post_id: id,
    post_type: v.picklist(['wp_block', 'wp_navigation']),
  }),
  v.strictObject({
    ...SiteTargetSchema.entries,
    post_id: TemplateIdSchema,
    post_type: v.picklist(['wp_template', 'wp_template_part']),
  }),
]);

export const ScopeSchema = v.picklist(['all_references', 'site_wide']);

export const ReferenceSchema = v.union([
  v.strictObject({
    entity_type: v.picklist(['wp_block', 'wp_navigation']),
    entity_id: id,
    reference_token: hash,
  }),
  v.strictObject({
    entity_type: v.literal('wp_template_part'),
    entity_id: TemplateIdSchema,
    reference_token: hash,
  }),
]);

export type Target = v.InferOutput<typeof TargetSchema>;

export const WorkflowSchema = v.picklist(['background', 'attached']);
// Inspection clamps larger values to 8 and reports it.
const depth = v.optional(index, 1);
const search = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256));
const namePattern = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200));

const BlockSelectionSchema = v.union([
  v.picklist(['roots', 'all']),
  v.strictObject({
    client_id: candidate,
    depth,
    limit,
    markup: v.optional(v.boolean(), false),
    media: v.optional(v.boolean(), false),
  }),
  v.strictObject({ depth: index, limit }),
  v.pipe(
    v.strictObject({
      search: v.optional(search),
      name: v.optional(
        v.union([namePattern, v.pipe(v.array(namePattern), v.minLength(1), v.maxLength(16))]),
      ),
      client_id: v.optional(candidate),
      attributes: v.optional(v.boolean(), false),
      limit,
    }),
    v.check(({ search, name }) => search !== undefined || name !== undefined),
  ),
]);

// connect and read share these fields. Selectors use live client IDs; paths
// shift with every structural edit and are accepted only inside edits.
const readEntries = {
  blocks: v.optional(BlockSelectionSchema, 'roots'),
  attribute_guide: v.optional(
    v.union([
      v.strictObject({ name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) }),
      v.strictObject({ client_id: candidate }),
    ]),
  ),
  style_guides: v.optional(
    v.pipe(
      v.array(
        v.union([
          v.strictObject({ client_id: candidate, properties: styleProperties }),
          v.strictObject({ name, properties: styleProperties }),
        ]),
      ),
      v.minLength(1),
      v.maxLength(16),
    ),
  ),
  insertion: v.optional(v.strictObject({ parent_client_id: v.optional(candidate) })),
  patterns: v.optional(v.boolean(), false),
  guidelines: v.optional(v.boolean(), false),
  settings: v.optional(v.boolean(), false),
};

export const ReadSchema = v.strictObject({
  operation: v.literal('read'),
  target: TargetSchema,
  request_id: v.optional(candidate),
  // Another saved document on the same site, read without an editor.
  source: v.optional(
    v.union([
      v.omit(TargetSchema.options[0], ['site_url', 'user_id']),
      v.omit(TargetSchema.options[1], ['site_url', 'user_id']),
      v.omit(TargetSchema.options[2], ['site_url', 'user_id']),
    ]),
  ),
  ...readEntries,
});

export type ReadOptions = v.InferOutput<typeof ReadSchema>;

export const ConnectionSchema = v.pipe(
  v.strictObject({
    operation: v.literal('connect'),
    target: v.union([
      v.omit(TargetSchema.options[0], ['user_id']),
      v.omit(TargetSchema.options[1], ['user_id']),
      v.omit(TargetSchema.options[2], ['user_id']),
    ]),
    workflow: WorkflowSchema,
    unsaved_preview: v.optional(v.boolean(), false),
    request_id: v.optional(candidate),
    ...readEntries,
  }),
  v.forward(
    v.check(
      (request) => !request.unsaved_preview || request.workflow === 'attached',
      'unsaved_preview requires workflow attached',
    ),
    ['unsaved_preview'],
  ),
);

export type Connection = v.InferOutput<typeof ConnectionSchema>;

export const ReceiptSchema = v.object({
  target: TargetSchema,
  workflow: WorkflowSchema,
  editor_instance: v.pipe(v.string(), v.uuid()),
  original_hash: hash,
  desired_hash: hash,
  // Every desired field except content, and the content's blocks in stored
  // form; together they verify a save whose bytes PHP re-serialized.
  fields_hash: hash,
  block_hash: hash,
  unsupported_block_count: index,
  date_fields: v.optional(v.array(v.picklist(['date_gmt'])), []),
  // This save moves a draft with no slug out of draft, so WordPress will add one.
  generated_slug: v.optional(v.boolean()),
  scope: v.optional(ScopeSchema),
});

export type Receipt = v.InferOutput<typeof ReceiptSchema>;

export interface BlockInput extends JsonObject {
  name: string;
  attributes?: JsonObject;
  inner_blocks?: BlockInput[];
}

export const BlockInputSchema: v.GenericSchema<BlockInput> = v.lazy(() =>
  v.strictObject({
    name,
    attributes: v.optional(JsonObjectSchema),
    inner_blocks: v.optional(v.pipe(v.array(BlockInputSchema), v.maxLength(200))),
  }),
);

const markup = v.pipe(v.string(), v.minLength(1), v.maxLength(256 * 1024));
const fileUrl = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.regex(/^https?:\/\/\S+$/i),
  v.check((url) => URL.canParse(url), 'an absolute http or https URL'),
);

export const LinkUrlSchema = v.pipe(
  fileUrl,
  v.check((value) => {
    if (!URL.canParse(value)) {
      return false;
    }

    const url = new URL(value);

    return !url.username && !url.password;
  }, 'an absolute http or https URL without credentials'),
);
const installationUrl = v.pipe(
  LinkUrlSchema,
  v.check((value) => {
    if (!URL.canParse(value)) {
      return false;
    }

    const url = new URL(value);

    return !url.username && !url.password && !url.search && !url.hash;
  }, 'an installation URL without credentials, query, or fragment'),
);

export const LinkMapSchema = v.strictObject({
  source_site_url: installationUrl,
  urls: v.pipe(v.record(LinkUrlSchema, LinkUrlSchema), v.maxEntries(50)),
  ids: v.pipe(v.record(LinkUrlSchema, id), v.maxEntries(50)),
});

export type LinkMap = v.InferOutput<typeof LinkMapSchema>;

const mapLinksEntries = {
  markup,
  source_site_url: installationUrl,
  overrides: v.optional(
    v.pipe(
      v.array(v.strictObject({ source_url: LinkUrlSchema, target_url: LinkUrlSchema })),
      v.maxLength(50),
      v.check(
        (items) => new Set(items.map((item) => item.source_url)).size === items.length,
        'at most one override per source URL',
      ),
    ),
    [],
  ),
};

// Moves a copied block tree to another site's attachments. ids maps each
// source attachment ID, as a string key, to the target's. urls maps each source
// file URL, including each size's, to the target's.
export const MediaMapSchema = v.strictObject({
  ids: v.optional(
    v.pipe(v.record(v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,15}$/)), id), v.maxEntries(500)),
    {},
  ),
  urls: v.pipe(v.record(fileUrl, fileUrl), v.minEntries(1), v.maxEntries(2000)),
});

export type MediaMap = v.InferOutput<typeof MediaMapSchema>;

const attributePath = v.pipe(v.array(candidate), v.minLength(1), v.maxLength(8));
const point = { parent: v.optional(parent, []), index: v.optional(index) };
const targetBlock = { path, name };

function editSchema<
  Target extends v.ObjectEntries,
  Point extends v.ObjectEntries,
  Content extends v.ObjectEntries,
>(targetBlock: Target, point: Point, content: Content) {
  return v.variant('op', [
    v.strictObject({
      op: v.literal('update'),
      ...targetBlock,
      attributes: v.optional(JsonObjectSchema, {}),
      // A bare attribute name is the one-key path to that attribute.
      unset: v.optional(
        v.pipe(
          v.array(
            v.union([
              attributePath,
              v.pipe(
                candidate,
                v.transform((key) => [key]),
              ),
            ]),
          ),
          v.maxLength(32),
        ),
        [],
      ),
    }),
    v.strictObject({
      op: v.literal('update_style'),
      ...targetBlock,
      set: v.optional(
        v.pipe(
          v.array(v.strictObject({ property: styleProperty, value: JsonSchema })),
          v.maxLength(32),
        ),
        [],
      ),
      unset: v.optional(v.pipe(v.array(styleProperty), v.maxLength(32)), []),
    }),
    v.strictObject({ op: v.literal('insert'), ...point, ...content }),
    v.strictObject({ op: v.literal('replace'), ...targetBlock, ...content }),
    v.strictObject({ op: v.literal('move'), ...targetBlock, ...point }),
    v.strictObject({ op: v.literal('remove'), ...targetBlock }),
    v.strictObject({ op: v.literal('insert_pattern'), ...point, pattern: candidate }),
    v.strictObject({
      op: v.literal('insert_variation'),
      ...point,
      name,
      variation: candidate,
      attributes: v.optional(JsonObjectSchema, {}),
    }),
    v.strictObject({
      op: v.literal('set_block_style'),
      ...targetBlock,
      style: v.nullable(candidate),
    }),
    v.strictObject({ op: v.literal('insert_reference'), ...point, reference: ReferenceSchema }),
    v.strictObject({
      op: v.literal('update_reference'),
      ...targetBlock,
      reference: ReferenceSchema,
    }),
  ]);
}

// Native policy and application use resolved paths. Public selectors are
// resolved separately against the evolving detached tree before each edit.
export const ResolvedEditSchema = editSchema(targetBlock, point, { block: BlockInputSchema });

export type Edit = v.InferOutput<typeof ResolvedEditSchema>;

const selectorOps = [
  'update',
  'update_style',
  'replace',
  'move',
  'remove',
  'set_block_style',
  'update_reference',
];

export const EditSchema = v.pipe(
  editSchema(
    { path: v.optional(path), client_id: v.optional(candidate), name: v.optional(name) },
    {
      parent: v.optional(parent),
      parent_client_id: v.optional(candidate),
      index: v.optional(index),
    },
    {
      block: v.optional(BlockInputSchema),
      markup: v.optional(markup),
      media_map: v.optional(MediaMapSchema),
      link_map: v.optional(LinkMapSchema),
    },
  ),
  v.forward(
    v.check(
      (edit) =>
        !selectorOps.includes(edit.op) ||
        ('path' in edit && edit.path !== undefined) !==
          ('client_id' in edit && edit.client_id !== undefined),
      'Provide exactly one of path or client_id',
    ),
    ['client_id'],
  ),
  v.forward(
    v.check(
      (edit) =>
        !('parent_client_id' in edit) ||
        edit.parent === undefined ||
        edit.parent_client_id === undefined,
      'Provide parent or parent_client_id, not both',
    ),
    ['parent_client_id'],
  ),
  v.forward(
    v.check(
      (edit) =>
        !['insert', 'replace'].includes(edit.op) ||
        ('block' in edit && edit.block !== undefined) !==
          ('markup' in edit && edit.markup !== undefined),
      'Provide exactly one of block or markup',
    ),
    ['block'],
  ),
  v.forward(
    v.check(
      (edit) => edit.op !== 'update' || Object.keys(edit.attributes).length + edit.unset.length > 0,
      'Provide attributes or unset',
    ),
    ['attributes'],
  ),
);

export type RequestedEdit = v.InferOutput<typeof EditSchema>;

export const PostChangesSchema = v.strictObject({
  title: v.optional(v.string()),
  excerpt: v.optional(v.string()),
  slug: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), v.maxLength(200))),
  status: v.optional(v.picklist(['draft', 'publish', 'private', 'pending', 'future'])),
  template: v.optional(v.string()),
  parent_id: v.optional(index),
  menu_order: v.optional(v.pipe(v.number(), v.safeInteger())),
  date_gmt: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
      v.check(
        (value) =>
          Number.isFinite(Date.parse(`${value}Z`)) &&
          new Date(`${value}Z`).toISOString() === `${value}.000Z`,
      ),
    ),
  ),
});

export const SettingsSchema = v.strictObject({
  featured_media: v.optional(v.union([v.literal(0), v.strictObject({ id, media_token: hash })])),
  meta: v.optional(JsonObjectSchema),
  taxonomies: v.optional(
    v.pipe(
      JsonObjectSchema,
      v.check((value) =>
        Object.keys(value).every((key) => !['__proto__', 'constructor', 'prototype'].includes(key)),
      ),
      v.record(v.string(), v.pipe(v.array(id), v.maxLength(100))),
    ),
  ),
});

export const BindingWriteSchema = v.strictObject({
  ...targetBlock,
  attribute: candidate,
  value: JsonSchema,
});

export const MediaBindingSchema = v.strictObject({
  ...targetBlock,
  media_id: id,
  media_token: hash,
  size: v.optional(candidate, 'full'),
  bind: v.strictObject({
    id: v.optional(candidate),
    url: v.optional(candidate),
    alt: v.optional(candidate),
    size_slug: v.optional(candidate),
  }),
});

const cssProperty = v.pipe(v.string(), v.regex(/^-{0,2}[a-z][a-z0-9_-]{0,80}$/));

export const MeasureOptionsSchema = v.strictObject({
  blocks: v.optional(v.pipe(v.array(candidate), v.minLength(1), v.maxLength(20))),
  properties: v.optional(v.pipe(v.array(cssProperty), v.maxLength(32))),
});

export type MeasureOptions = v.InferOutput<typeof MeasureOptionsSchema>;

export const EditRequestSchema = v.strictObject({
  operation: v.literal('edit'),
  target: TargetSchema,
  request_id: v.optional(candidate),
  edits: v.optional(v.pipe(v.array(EditSchema), v.maxLength(32)), []),
  post: v.optional(PostChangesSchema),
  settings: v.optional(SettingsSchema),
  binding_writes: v.optional(v.pipe(v.array(BindingWriteSchema), v.maxLength(32)), []),
  media_bindings: v.optional(v.pipe(v.array(MediaBindingSchema), v.maxLength(32)), []),
  scope: v.optional(ScopeSchema),
  open_pattern_section: v.optional(v.strictObject({ section_client_id: candidate })),
  measure: v.optional(v.union([v.literal(true), MeasureOptionsSchema])),
});

export type Preparation = v.InferOutput<typeof EditRequestSchema>;

// A named width or an exact canvas width in CSS pixels. Region screenshots
// are verified up to 2560.
export const WidthSchema = v.union([
  v.picklist(['desktop', 'tablet', 'mobile']),
  v.pipe(v.number(), v.integer(), v.minValue(320), v.maxValue(2560)),
]);

export type Width = v.InferOutput<typeof WidthSchema>;

export const MeasureSchema = v.pipe(
  v.strictObject({
    operation: v.literal('measure'),
    target: TargetSchema,
    request_id: v.optional(candidate),
    blocks: v.optional(v.pipe(v.array(candidate), v.minLength(1), v.maxLength(20))),
    client_id: v.optional(candidate),
    properties: v.optional(v.pipe(v.array(cssProperty), v.maxLength(32))),
    width: v.optional(WidthSchema),
  }),
  v.forward(
    v.check(
      ({ blocks, client_id }) => (blocks === undefined) !== (client_id === undefined),
      'Provide blocks or client_id',
    ),
    ['blocks'],
  ),
  v.transform(({ client_id, blocks, ...request }) => ({
    ...request,
    blocks: blocks ?? [client_id ?? ''],
  })),
);

const session = { target: TargetSchema, request_id: v.optional(candidate) };

// One screenshot slice of a block in the editor canvas. The bootstrap caller
// sends these and always ends with restore_view.
export const ViewSchema = v.strictObject({
  operation: v.literal('view'),
  ...session,
  client_id: candidate,
  width: v.optional(WidthSchema, 'desktop'),
  offset: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100000)), 0),
});

export const RequestSchema = v.variant('operation', [
  ReadSchema,
  v.strictObject({ operation: v.literal('map_links'), ...session, ...mapLinksEntries }),
  EditRequestSchema,
  MeasureSchema,
  ViewSchema,
  v.strictObject({
    operation: v.literal('prepare_save'),
    ...session,
    save_all_pending: v.optional(v.boolean()),
  }),
  v.strictObject({
    operation: v.literal('save'),
    ...session,
    receipt: ReceiptSchema,
    save_all_pending: v.optional(v.boolean()),
  }),
  v.strictObject({
    operation: v.picklist(['revert', 'status', 'release', 'restore_view', 'prepare_resave']),
    ...session,
  }),
]);

export type Request = v.InferInput<typeof RequestSchema>;

export type EditorRequest = v.InferOutput<typeof RequestSchema>;

export const editorOperations = [
  'connect',
  'read',
  'map_links',
  'edit',
  'measure',
  'view',
  'restore_view',
  'prepare_save',
  'prepare_resave',
  'save',
  'revert',
  'status',
  'release',
] as const;

// Running these again changes no content, so a failed one can be called again.
export const readOnlyOperations: readonly string[] = [
  'connect',
  'read',
  'map_links',
  'measure',
  'status',
  'view',
  'restore_view',
  'discover',
  'inspect_media',
  'download_media',
  'resource_status',
  'inspect_terms',
  'verify_resource',
  'list_entities',
  'inspect_entity',
  'recover',
  'inspect_abilities',
];

const rawText = v.object({ raw: v.string() });

// Validate REST data without replacing it with parsed output, which drops some keys.
export const PostSchema = v.objectWithRest(
  {
    id: v.union([id, TemplateIdSchema]),
    type: v.string(),
    status: v.string(),
    slug: v.string(),
    title: v.optional(rawText),
    excerpt: v.optional(rawText),
    content: rawText,
    date: v.optional(v.nullable(v.string())),
    date_gmt: v.optional(v.nullable(v.string())),
    modified_gmt: v.optional(v.nullable(v.string())),
  },
  JsonSchema,
);

export type Post = v.InferOutput<typeof PostSchema>;

export const UserSchema = v.object({ id, name: v.string(), slug: v.string() });

export type User = v.InferOutput<typeof UserSchema>;

export const SiteSchema = v.object({ url: v.string() });

// WordPress sends `data: null` for an error that carries no status.
export const ApiErrorSchema = v.object({
  code: v.optional(v.string()),
  data: v.nullish(v.object({ status: v.optional(v.number()) })),
});

export type Persistence = 'not_attempted' | 'uncertain' | 'verified' | 'applied_with_differences';

export type MetaBoxOutcome = 'none' | 'saved' | 'failed' | 'unobserved';

export interface SaveResult extends JsonObject {
  meta_boxes: MetaBoxOutcome;
}

// What Blockwork last reported or wrote for one block. An edit refuses only
// when a later foreign change touches a block or child list it depends on.
export interface Observed {
  name: string;
  attributes: string;
  children: string;
}

export interface LastRequest extends JsonObject {
  id: string;
  operation: string;
  outcome:
    | 'running'
    | 'applied'
    | 'rolled_back'
    | 'partial'
    | 'failed'
    | 'uncertain'
    | 'saved'
    | 'stored_with_field_differences'
    | 'reverted'
    | 'released';
  // The error code when a change failed, rolled back, or partly applied.
  error?: string;
}

// Kept on the page after release so a lost release response can be confirmed.
export interface ReleaseRecord {
  target: Target;
  workflow: v.InferOutput<typeof WorkflowSchema>;
  last_request?: LastRequest;
  cleanup: string;
}

export interface MediaReference {
  client_id: string;
  attribute: string;
  value: JsonValue;
  media_id: number;
  path: string;
  token: string;
}

export interface DraftState extends JsonObject {
  blocks: JsonValue;
  fields: JsonObject;
  pending: JsonObject;
  pending_keys: string[];
  dirty: boolean;
}

export interface DraftCheckpoint {
  before: DraftState;
  current: DraftState;
  original: Block[];
  entity_blocks: boolean;
  dispatch?: { blocks: Block[]; values?: JsonObject };
  settings_dispatched: boolean;
}

export interface Session {
  protocol: 4;
  target: Target;
  workflow: v.InferOutput<typeof WorkflowSchema>;
  editor_instance: string;
  user: User;
  busy: boolean;
  schema: DocumentContract;
  persisted: Post;
  persistence: Persistence;
  // Saved fields this editor loaded or last saved itself, including native
  // autosave. Only a save from somewhere else leaves the saved record behind.
  baseline: JsonObject;
  // A native save posted meta box forms after its baseline was taken, so meta
  // keys and plugin fields may have changed since.
  meta_box_save?: boolean;
  stop_save_watch?: () => void;
  observed: Record<string, Observed>;
  observed_fields: JsonObject;
  // Settings explicitly authorized since the last save; meta holds only requested keys.
  requested: JsonObject;
  expected_state?: string;
  structure_requires_reload?: boolean;
  edit_count: number;
  last_request?: LastRequest;
  // A partial paired write keeps autosave paused until explicit release.
  footnote_recovery?: boolean;
  last_edit?: {
    footnote?: FootnoteCheckpoint;
    draft?: DraftCheckpoint;
    plan: Plan;
    settings: SettingsPlan;
    applied_state: string;
    pending_before: JsonObject;
    dirty_before: boolean;
    requested_before: JsonObject;
    references_before: SettingsPlan['references'];
    shared_references_before: Plan['references'];
    media_references_before: MediaReference[];
  };
  // References from settings edits, checked again before saving.
  references: SettingsPlan['references'];
  shared_references: Plan['references'];
  media_references: MediaReference[];
  // Set once the draft changed outside Blockwork while this session held it.
  foreign_change?: boolean;
  // What prepare_save checked, kept so save can explain a verification mismatch.
  save?: {
    receipt: Receipt;
    state: string;
    attempted: boolean;
    // Save subscriptions replace the session baseline; retain this plan's original.
    original: JsonObject;
    desired: JsonObject;
    rows: BlockSummary[];
  };
  preview?: {
    state: string;
    saved_token: string;
    dirty: boolean;
    pending: JsonObject;
    blocks: Block[];
  };
  lock_post_id?: number;
  // The editor's own device and scroll positions while a view is showing.
  view?: { device: string; scroll: Array<{ element: Element; top: number; left: number }> };
  // Parsed source documents, kept while their content is unchanged so client
  // IDs from one read stay valid for the next.
  sources?: Record<string, { token: string; blocks: Block[] }>;
}

export interface BlockSummary {
  path: number[];
  name: string;
  attributes: JsonObject;
  clientId: string;
  block: Block;
  support: 'supported' | 'unsupported' | 'invalid';
  reason: string;
}
