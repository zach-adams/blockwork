import * as v from 'valibot';
import { Budget, pause, remainingMs } from './timing';
import type { Deadline } from './timing';
import { BlockInputSchema, JsonObjectSchema, JsonSchema, ResolvedEditSchema } from './contracts';
import type {
  BlockInput,
  BlockSummary,
  Edit,
  JsonObject,
  JsonValue,
  RequestedEdit,
} from './contracts';
import type { Attribute, Block, WordPress } from './wordpress';
import {
  blockState,
  postDateField,
  unsupportedBinding,
  containsPath,
  containerRestriction,
  editRestriction,
  editingMode,
  readTree,
  removalRestriction,
  requireCondition as assert,
  richTextInput,
  sharedReference,
  validity,
} from './inspection';
import { blockInput, patterns, styles, variations } from './catalog';
import { provePreservation } from './preservation';
import { canonical, same } from './values';
import { requireContexts } from './canvas';
import { renderAffected, withinInitialization } from './initialization';
import { safeValue, schemaAllows } from './schema';
import { editorUrl, readReference, referenceGraph } from './shared';
import type { ReferenceSchema } from './contracts';
import type { Target } from './contracts';
import { documentBlocks, documentRoot, resetDocument } from './document-view';
import {
  nativeMarginInput,
  normalizePatternSpacers,
  spacerSettings,
  styleControlFor,
  styleUpdate,
} from './styling';
import type { PatternSpacer } from './styling';
import {
  BlockworkError,
  blockMismatches,
  changedProperties,
  diagnosticKey,
  serializationDiagnostics,
} from './errors';
import { prepareEmptyComments, checkEmptyComments } from './comments';
import type { EmptyComments } from './comments';
import { readMedia } from './resources';
import type { mediaEdits } from './resources';
import {
  checkPostDateTemplates,
  checkQueryPreviews,
  prepareQueryNormalization,
  preparePostDates,
} from './query';
import type { FootnoteCompanion } from './structural-footnotes';

interface Step {
  comments?: EmptyComments;
  edit: Edit;
  blocks: Block[];
  before: Block[];
  after: Block[];
  update?: JsonObject;
}

// A live block an edit depends on: its attributes, its whole subtree, or the
// order of its children. The document root uses an empty client ID.
export interface Touch extends JsonObject {
  client_id: string;
  kind: 'attributes' | 'subtree' | 'children';
  edit_index: number;
}

export interface Plan {
  spacers?: Array<PatternSpacer & { clientId: string; ancestors: Block[] }>;
  edits: Edit[];
  steps: Step[];
  blocks: Block[];
  target: Target;
  references: Record<
    string,
    { identity: JsonObject; graph: Array<v.InferOutput<typeof ReferenceSchema>> }
  >;
  touched: Touch[];
}

function stepTargets(step: Step): Block[] {
  return ['update', 'update_style', 'set_block_style'].includes(step.edit.op) && 'path' in step.edit
    ? [at(step.after, step.edit.path)]
    : step.blocks;
}

// A step that inserts blocks other than a plain paragraph or separator needs
// their edit components to initialize them natively.
function stepNeedsPreparation(step: Step): boolean {
  return (
    step.edit.op !== 'move' &&
    step.blocks.some(
      (block) =>
        Boolean(block.innerBlocks?.length) ||
        !['core/paragraph', 'core/separator'].includes(block.name),
    )
  );
}

export function needsNativePreparation(plan: Plan): boolean {
  return plan.steps.some(stepNeedsPreparation);
}

// Native actions may retain attribute references. Capture independent JSON
// values; Gutenberg rich-text values supply their string through toJSON.
function copyAttributes(attributes: JsonObject): JsonObject {
  const copied = v.parse(JsonObjectSchema, JSON.parse(JSON.stringify(attributes)));

  // Native updateBlockAttributes uses undefined to reset an attribute. JSON
  // cloning must retain these root resets when applying a prepared style patch.
  // It also turns an empty RichTextData into '', which is falsy where the object
  // is not, so a save such as core/details' would write its default text instead.
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || (copied[key] === '' && value !== '')) {
      copied[key] = value;
    }
  }

  return copied;
}

export function copyTree(blocks: Block[]): Block[] {
  return blocks.map((block) => ({
    ...block,
    attributes: copyAttributes(block.attributes),
    innerBlocks: copyTree(block.innerBlocks ?? []),
  }));
}

function at(blocks: Block[], path: number[]): Block {
  let list = blocks;
  let block: Block | undefined;

  for (const [depth, index] of path.entries()) {
    block = list[index];
    assert(block, 'block_mismatch', {
      target_path: path,
      missing_path: path.slice(0, depth + 1),
      constraint: 'existing_block_path',
    });
    list = block.innerBlocks ?? [];
  }

  assert(block, 'block_mismatch');

  return block;
}

function resolveEdit(wp: WordPress, blocks: Block[], request: RequestedEdit): Edit {
  const resolved: JsonObject = { ...request };
  const rows = readTree(wp, blocks);

  for (const [selector, destination] of [
    ['client_id', 'path'],
    ['parent_client_id', 'parent'],
  ]) {
    if (!(selector in resolved)) {
      continue;
    }

    const clientId = resolved[selector];

    if (clientId === undefined) {
      delete resolved[selector];
      continue;
    }

    const matches = rows.filter((row) => row.clientId === clientId);
    assert(matches.length === 1, 'block_identity_missing', {
      selector_field: selector,
      matches: matches.length,
      constraint: 'one_current_block',
    });
    resolved[destination] = matches[0].path;
    delete resolved[selector];
  }

  // Selector edits may omit the block name. A supplied name stays a guard.
  if (resolved.name === undefined && v.is(v.array(v.number()), resolved.path)) {
    resolved.name = at(blocks, resolved.path).name;
  }

  if (resolved.name === undefined) {
    delete resolved.name;
  }

  return v.parse(ResolvedEditSchema, resolved);
}

function children(blocks: Block[], parent: number[]): Block[] {
  return parent.length ? (at(blocks, parent).innerBlocks ?? []) : blocks;
}

function checkCSSPermission(wp: WordPress, blocks: Block[]): void {
  const containsCSS = readTree(wp, blocks).some(
    (row) => v.is(JsonObjectSchema, row.attributes.style) && Boolean(row.attributes.style.css),
  );
  assert(
    !containsCSS || wp.data.select('core/block-editor').getSettings?.().canEditCSS === true,
    'custom_css_permission_required',
  );
}

function parent_id(wp: WordPress, blocks: Block[], parent: number[]): string | undefined {
  return parent.length ? at(blocks, parent).clientId : documentRoot(wp)?.clientId;
}

const metadataMembers = new Map<string, v.GenericSchema>([
  ['name', v.pipe(v.string(), v.maxLength(200))],
  ['patternName', v.pipe(v.string(), v.maxLength(200))],
  ['categories', v.pipe(v.array(v.union([v.string(), v.number()])), v.maxLength(50))],
  [
    'blockVisibility',
    v.union([
      v.literal(false),
      v.strictObject({
        viewport: v.record(v.picklist(['mobile', 'tablet', 'desktop']), v.boolean()),
      }),
    ]),
  ],
]);

// Requested values follow the agent write policy. Values a block's own edit
// component adds during initialization, such as a template lock, only need
// to be registered and schema-valid.
export function attributes(
  wp: WordPress,
  name: string,
  values: JsonObject,
  source: 'request' | 'native' = 'request',
): void {
  const registration = wp.blocks.getBlockType(name);
  assert(registration, 'block_unregistered');
  safeValue(values);

  for (const [key, value] of Object.entries(values)) {
    const attribute: Attribute | undefined = registration.attributes?.[key];
    assert(source === 'native' || attribute?.source !== 'meta', 'unsupported_attribute', {
      block_name: name,
      attribute: diagnosticKey(key),
      constraint: 'meta_requires_document_settings',
      use_instead:
        'Read settings: true, then edit settings.meta with only the supplied registered writable meta keys. Preserve the whole-meta guard; a key absent from the settings guide cannot be written.',
    });
    const protectedKeys =
      source === 'native'
        ? ['__proto__', 'constructor', 'prototype']
        : ['__proto__', 'constructor', 'prototype', 'metadata', 'lock', 'templateLock'];

    // Agents may label blocks for List View and keep the members Gutenberg
    // writes on pattern insertion, so read markup round-trips. Bindings and
    // other members keep their dedicated, permission-checked operations.
    if (key === 'metadata' && attribute && source === 'request') {
      const members: Array<[string, unknown]> = v.is(JsonObjectSchema, value)
        ? Object.entries(value)
        : [['', value]];

      for (const [member, memberValue] of members) {
        const schema = metadataMembers.get(member);
        assert(schema && v.is(schema, memberValue), 'unsupported_attribute', {
          block_name: name,
          attribute: member ? `metadata.${diagnosticKey(member)}` : key,
          constraint: 'allowed_metadata_members_only',
          allowed_members: [...metadataMembers.keys()],
        });
        // The front end only honors the Hide control where the block supports it.
        assert(
          member !== 'blockVisibility' || registration.supports?.visibility !== false,
          'unsupported_attribute',
          {
            block_name: name,
            attribute: 'metadata.blockVisibility',
            constraint: 'block_visibility_unsupported',
          },
        );
      }

      continue;
    }

    assert(!protectedKeys.includes(key) && attribute, 'unsupported_attribute', {
      block_name: name,
      attribute: diagnosticKey(key),
      use_instead: attribute ? undefined : styleControlFor(wp, name, key),
    });
    assert(
      source === 'native' ||
        !(
          ['core/block', 'core/navigation', 'core/template-part'].includes(name) &&
          ['ref', 'slug', 'theme', 'area'].includes(key)
        ),
      'reference_operation_required',
    );
    assert(
      !attribute.enum || attribute.enum.some((item) => same(item, value)),
      'invalid_attribute_value',
      {
        block_name: name,
        attribute: key.slice(0, 200),
        expected_type: attribute.type,
        constraint: 'registered_enum',
      },
    );
    assert(attribute.type && schemaAllows(value, attribute), 'unsupported_attribute_type', {
      block_name: name,
      attribute: key.slice(0, 200),
      expected_type: attribute.type,
      constraint: 'registered_attribute_schema',
    });
  }
}

function nesting(wp: WordPress, block: Block, ancestors: Block[]): void {
  const type = wp.blocks.getBlockType(block.name);
  assert(
    type && !['core/freeform', 'core/html', 'core/missing'].includes(block.name),
    'unsupported_block',
  );
  const parent = ancestors.at(-1);
  assert(
    !type.ancestor || ancestors.some((item) => type.ancestor!.includes(item.name)),
    'invalid_nesting',
  );
  const parentType = parent && wp.blocks.getBlockType(parent.name);
  assert(
    !parentType?.allowedBlocks || parentType.allowedBlocks.includes(block.name),
    'invalid_nesting',
  );
  const allowed = parent?.attributes.allowedBlocks;
  assert(!Array.isArray(allowed) || allowed.includes(block.name), 'invalid_nesting');

  for (const child of block.innerBlocks ?? []) {
    nesting(wp, child, [...ancestors, block]);
  }
}

// The deepest stored blocks Gutenberg would write differently from their markup.
function rewrittenPaths(wp: WordPress, blocks: Block[], content: string, at: number[] = []) {
  return blocks.flatMap((block, index): number[][] => {
    const path = [...at, index];

    if (content.includes(wp.blocks.serialize([block]))) {
      return [];
    }

    const inner = rewrittenPaths(wp, block.innerBlocks ?? [], content, path);

    return inner.length ? inner : [path];
  });
}

// Names the blocks Gutenberg would write differently from the stored content.
export function rewrittenBlocks(wp: WordPress, rows: BlockSummary[], content: string): JsonObject {
  const paths = rewrittenPaths(wp, wp.blocks.parse(content), content);

  return {
    rewritten_blocks: paths.slice(0, 10).flatMap((path) => {
      const row = rows.find((item) => same(item.path, path));

      return row ? [{ path, name: row.name.slice(0, 200), client_id: row.clientId }] : [];
    }),
    rewritten_block_count: paths.length,
  };
}

function ancestry(blocks: Block[], parent: number[]): Block[] {
  return parent.map((_index, index) => at(blocks, parent.slice(0, index + 1)));
}

async function policy(
  wp: WordPress,
  tree: Block[],
  edit: Edit,
  inserted: Block[],
  liveIds: Set<string>,
  deadline?: Deadline,
): Promise<void> {
  const rows = readTree(wp, tree);
  const structural = !['update', 'update_style', 'set_block_style', 'update_reference'].includes(
    edit.op,
  );
  const contexts = new Set<string>();
  const root = documentRoot(wp);

  if ('parent' in edit) {
    assert(
      !rows.some((row) => sharedReference(row.block) && containsPath(row.path, edit.parent)),
      'shared_descendant_not_editable',
    );
  }

  if (root) {
    liveIds.add(root.clientId);
  }

  if (structural && root) {
    contexts.add(root.clientId);
  }

  if ('path' in edit) {
    for (const block of ancestry(tree, edit.path.slice(0, -1))) {
      contexts.add(block.clientId);
    }

    // Removing or moving a subtree still checks every descendant's native
    // permissions below. Its children need no insertion contexts for removal.
  }

  if (inserted.length && 'parent' in edit) {
    for (const block of ancestry(tree, edit.parent)) {
      contexts.add(block.clientId);
    }
  }

  const destination = 'parent' in edit ? ancestry(tree, edit.parent) : [];
  const template = [...destination]
    .reverse()
    .find((block) => block.name === 'core/post-template' && liveIds.has(block.clientId));

  const selectTemplateChild =
    template?.innerBlocks?.length && readTree(wp, inserted).some((row) => postDateField(row));
  const renderContexts = new Set(
    [...contexts].filter(
      (id) =>
        liveIds.has(id) &&
        wp.data.select('core/block-editor').getBlockListSettings?.(id) === undefined,
    ),
  );

  if (selectTemplateChild && template) {
    renderContexts.add(template.clientId);
  }

  const checkDates = await preparePostDates(wp, tree, renderContexts);

  if (selectTemplateChild && template?.innerBlocks?.length) {
    const child = template.innerBlocks[0];
    await renderAffected(
      wp,
      new Set([child.clientId]),
      new Budget(5000, Math.min(12000, remainingMs())),
      true,
      checkDates,
    );
  }

  checkDates();
  await requireContexts(
    wp,
    [...contexts].filter((id) => liveIds.has(id)),
    deadline,
    checkDates,
  );

  checkPolicy(wp, tree, edit, inserted, liveIds);
}

function checkPolicy(
  wp: WordPress,
  tree: Block[],
  edit: Edit,
  inserted: Block[],
  liveIds: Set<string>,
): void {
  const store = wp.data.select('core/block-editor');
  const rows = readTree(wp, tree);
  const structural = !['update', 'update_style', 'set_block_style', 'update_reference'].includes(
    edit.op,
  );
  const root = documentRoot(wp);

  // Gutenberg must allow default editing of a live block that a structural
  // change moves, removes, or inserts into. The refusal names the restriction,
  // such as a pattern section.
  const requireDefaultMode = (block: Block) => {
    const row = rows.find((item) => item.clientId === block.clientId);

    if (!row) {
      assert(store.getBlockEditingMode(block.clientId) === 'default', 'block_not_editable');

      return;
    }

    const mode = editingMode(wp, row, rows);
    assert(mode.reason === '', 'block_not_editable', { block_name: block.name, ...mode });
  };

  const container = (path: number[], mode: 'insert' | 'remove' | 'move') => {
    const ancestors = ancestry(tree, path);
    const liveRows = rows.filter((row) => liveIds.has(row.clientId));
    const restriction = containerRestriction(wp, ancestors, liveRows, mode);
    const code = ['template_locked', 'native_insertion_policy_unavailable'].includes(
      restriction.reason,
    )
      ? restriction.reason
      : 'block_not_editable';
    assert(!restriction.reason, code, restriction);
  };

  if ('path' in edit) {
    const block = at(tree, edit.path);
    assert(block.name === edit.name, 'block_mismatch');
    const row = rows.find((item) => item.clientId === block.clientId)!;
    assert(row, 'shared_descendant_not_editable');

    if (!structural) {
      assert(
        !rows.some(
          (other) =>
            other.support === 'unsupported' &&
            (containsPath(other.path, edit.path) || containsPath(edit.path, other.path)),
        ),
        'unsupported_target_or_subtree',
      );
      assert(!unsupportedBinding(block), 'bound_block_unsupported');
      assert(row.support === 'supported', 'block_not_editable', {
        block_name: block.name,
        reason: row.reason,
      });

      const restriction = liveIds.has(block.clientId)
        ? editRestriction(wp, row, rows)
        : { reason: '' };
      const contentOnly = ['pattern_section', 'content_only'].includes(restriction.reason);
      assert(
        restriction.reason === '' ||
          (contentOnly && contentEdit(wp, block.name, edit, restriction.editing_mode)),
        'block_not_editable',
        { block_name: block.name, ...restriction },
      );
    } else {
      const move = edit.op === 'move';
      const sameParent = move && same(edit.path.slice(0, -1), edit.parent);
      container(edit.path.slice(0, -1), sameParent ? 'move' : 'remove');

      for (const child of readTree(wp, [block])) {
        assert(!unsupportedBinding(child), 'bound_block_unsupported');
      }

      // Like native removal and moves, only the selected block's own lock and
      // editing mode apply. A template lock on a descendant, such as one a
      // block's edit component adds, does not pin its whole ancestor.
      const locks = block.attributes.lock;
      assert(
        !v.is(JsonObjectSchema, locks) || !(move ? locks.move : locks.remove),
        'block_locked',
        { block_name: block.name },
      );

      if (liveIds.has(block.clientId)) {
        requireDefaultMode(block);

        if (!move) {
          const restriction = removalRestriction(wp, row, rows);
          const code = [
            'block_locked',
            'template_locked',
            'bound_block_unsupported',
            'unsupported_structural_edit',
            'native_insertion_policy_unavailable',
          ].includes(restriction.reason)
            ? restriction.reason
            : 'block_not_editable';
          assert(!restriction.reason, code, { block_name: block.name, ...restriction });
        }

        if (move) {
          assert(store.canMoveBlock?.(block.clientId) === true, 'block_locked', {
            block_name: block.name,
          });
        }
      }

      if (move && !sameParent) {
        assert(
          !liveIds.has(block.clientId) || store.canRemoveBlocks?.([block.clientId]) === true,
          'block_locked',
        );
      }
    }
  }

  if (inserted.length) {
    let destination: number[] = [];

    if ('parent' in edit) {
      destination = edit.parent;
    } else if ('path' in edit) {
      destination = edit.path.slice(0, -1);
    }

    const sameParent = edit.op === 'move' && same(edit.path.slice(0, -1), destination);
    container(destination, sameParent ? 'move' : 'insert');
    const ancestors = [...(root ? [root] : []), ...ancestry(tree, destination)];
    const id = parent_id(wp, tree, destination);
    assert(
      store.canInsertBlockType && store.canInsertBlocks,
      'native_insertion_policy_unavailable',
    );

    // Core's inserter disables a multiple: false block while the document holds
    // one. Pattern insertion and moves don't check, as natively.
    if (!['move', 'insert_pattern'].includes(edit.op)) {
      const kept = rows.filter((row) => !('path' in edit && containsPath(edit.path, row.path)));
      const added = readTree(wp, inserted);

      for (const [index, row] of added.entries()) {
        assert(
          wp.blocks.getBlockType(row.name)?.supports?.multiple !== false ||
            (!kept.some((other) => other.name === row.name) &&
              added.findIndex((other) => other.name === row.name) === index),
          'insertion_refused',
          { block_name: row.name, constraint: 'single_use_block' },
        );
      }
    }

    for (const block of inserted) {
      nesting(wp, block, ancestors);
      // A parent list is judged natively, because a mounted container's own
      // allowed list can also admit a block: canInsertBlockType below for a live
      // parent, and checkChildren once a new one mounts. Core lets a block whose
      // parents include core/post-content sit at the root of any document.
      const parents = wp.blocks.getBlockType(block.name)?.parent;
      assert(
        destination.length > 0 || !parents || parents.includes(root?.name ?? 'core/post-content'),
        'invalid_nesting',
      );

      if (!id || liveIds.has(id)) {
        if (id) {
          assert(store.getBlockListSettings?.(id), 'native_insertion_context_unavailable');
        }

        assert(
          edit.op === 'move' && liveIds.has(block.clientId)
            ? sameParent || store.canInsertBlocks([block.clientId], id)
            : store.canInsertBlockType(block.name, id),
          'insertion_refused',
          {
            block_name: block.name,
            parent_name: destination.length ? at(tree, destination).name : 'root',
          },
        );
      }
    }
  }
}

function plain(value: JsonValue | undefined): value is JsonObject {
  if (!v.is(JsonObjectSchema, value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function merged(base: JsonValue | undefined, patch: JsonValue): JsonValue {
  if (!plain(base) || !plain(patch)) {
    return patch;
  }

  const result: JsonObject = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      result[key] = merged(base[key], value);
    }
  }

  return result;
}

function without(value: JsonValue | undefined, keys: string[]): JsonValue | undefined {
  if (!plain(value)) {
    return value;
  }

  const [key, ...rest] = keys;
  const result: JsonObject = { ...value };

  if (rest.length) {
    const child = without(result[key], rest);
    result[key] = child;

    // Native controls drop emptied style groups instead of serializing {}.
    if (plain(child) && !Object.keys(child).length) {
      delete result[key];
    }
  } else {
    delete result[key];
  }

  return result;
}

// Native style controls never write empty objects, and WordPress stores {}
// as [] when PHP re-serializes a saved post. Drop them from a requested style;
// other attributes may give an empty object meaning, so they stay exact.
function compact(value: JsonValue | undefined): JsonValue | undefined {
  if (!plain(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const kept = compact(child);

      return plain(kept) && !Object.keys(kept).length ? [] : [[key, kept] as const];
    }),
  );
}

// update merges nested objects into the current values; arrays and scalars
// replace. unset removes nested keys or resets a whole attribute natively.
// Gutenberg's content-only mode, in a pattern section or under a contentOnly
// template lock, still lets a user change the attributes a block registers
// with role: content, such as a paragraph's text or an image's url and alt.
// Explicit ancestor template locks still apply after native section opening.
export function contentEdit(
  wp: WordPress,
  name: string,
  edit: { op: string; attributes?: JsonObject; unset?: string[][] },
  mode?: string,
): boolean {
  if (edit.op !== 'update' || !['default', 'contentOnly'].includes(mode ?? '')) {
    return false;
  }

  const registered = wp.blocks.getBlockType(name)?.attributes ?? {};
  const keys = [...Object.keys(edit.attributes ?? {}), ...(edit.unset ?? []).map(([key]) => key)];

  return keys.length > 0 && keys.every((key) => registered[key]?.role === 'content');
}

function updateAttributes(
  wp: WordPress,
  block: Block,
  patch: JsonObject,
  unset: string[][],
): JsonObject {
  assert(
    !postDateField(block) ||
      (!Object.hasOwn(patch, 'datetime') && !unset.some(([key]) => key === 'datetime')),
    'unsupported_attribute',
    {
      block_name: block.name,
      attribute: 'datetime',
      constraint: 'bound_datetime_read_only',
      use_instead:
        'Preserve the backing post date. Edit unbound style attributes or move or remove the block under native permissions.',
    },
  );
  const updates: JsonObject = {};
  const registered = wp.blocks.getBlockType(block.name)?.attributes ?? {};

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      const requested =
        key === 'style'
          ? (compact(nativeMarginInput(wp, block.name, value, ['style'])) ?? value)
          : (richTextInput(value, registered[key]) ?? value);
      updates[key] = key === 'metadata' ? value : merged(block.attributes[key], requested);
    }
  }

  for (const [unsetIndex, keys] of unset.entries()) {
    const [key, ...rest] = keys;

    if (registered[key]?.source === 'meta') {
      attributes(wp, block.name, { [key]: registered[key].default });
    }

    assert(
      !['__proto__', 'constructor', 'prototype', 'lock', 'templateLock'].includes(key) &&
        (key !== 'metadata' ||
          (rest.length === 1 && ['name', 'blockVisibility'].includes(rest[0]))) &&
        wp.blocks.getBlockType(block.name)?.attributes?.[key],
      'unsupported_attribute',
      { block_name: block.name, attribute: diagnosticKey(key), field: `unset.${unsetIndex}` },
    );
    const current = Object.hasOwn(updates, key) ? updates[key] : block.attributes[key];
    const value = rest.length ? without(current, rest) : registered[key]?.default;
    updates[key] = rest.length && plain(value) && !Object.keys(value).length ? undefined : value;
  }

  if (plain(patch.metadata)) {
    attributes(wp, block.name, { metadata: patch.metadata });
    const current = plain(block.attributes.metadata) ? block.attributes.metadata : {};
    // patternName makes a section content-only. Changing or clearing it would
    // bypass open_pattern_section, so an update may only resend the current one.
    assert(
      !Object.hasOwn(patch.metadata, 'patternName') ||
        same(patch.metadata.patternName, current.patternName),
      'unsupported_attribute',
      {
        block_name: block.name,
        attribute: 'metadata.patternName',
        constraint: 'pattern_name_unchanged',
      },
    );
    updates.metadata = merged(block.attributes.metadata, patch.metadata);
  }

  attributes(
    wp,
    block.name,
    Object.fromEntries(
      Object.entries(updates).filter(([key, value]) => value !== undefined && key !== 'metadata'),
    ),
  );

  return updates;
}

function create(
  wp: WordPress,
  input: BlockInput,
  depth = 0,
  count = { value: 0 },
  native = false,
): Block {
  assert(depth < 15 && ++count.value <= 200, 'tree_too_large');
  assert(
    !['core/block', 'core/navigation', 'core/template-part'].includes(input.name),
    'reference_operation_required',
  );
  const registered = wp.blocks.getBlockType(input.name)?.attributes ?? {};
  // read results and parsed markup include a lock attribute's registered
  // default, such as an Accordion panel's templateLock: false. On a new block
  // that default is not a lock change, so a round trip must not refuse it.
  const values = Object.fromEntries(
    Object.entries(input.attributes ?? {}).flatMap(([key, value]) => {
      if (['lock', 'templateLock'].includes(key) && same(value, registered[key]?.default)) {
        return [];
      }

      return [[key, key === 'style' ? compact(value) : richTextInput(value, registered[key])]];
    }),
  );
  const metadata = values.metadata;
  const binding = native && postDateField({ name: input.name, attributes: values });
  const validated = { ...values };

  if (binding && v.is(JsonObjectSchema, metadata)) {
    const { bindings: _bindings, ...members } = metadata;
    validated.metadata = members;
  }

  attributes(wp, input.name, validated);

  const block = wp.blocks.createBlock(
    input.name,
    values,
    (input.inner_blocks ?? []).map((child) => create(wp, child, depth + 1, count, native)),
  );

  assert(!unsupportedBinding(block), 'bound_block_unsupported');

  if (block.name !== 'core/post-date') {
    return block;
  }

  const parsed = wp.blocks.parse(wp.blocks.serialize([block]));
  assert(parsed.length === 1 && parsed[0].name === block.name, 'unsupported_markup');
  const prepared = parsed[0];
  const field = postDateField(prepared);

  if (field && !postDateField(block)) {
    assert(!Object.hasOwn(values, 'datetime'), 'unsupported_attribute', {
      block_name: block.name,
      attribute: 'datetime',
      constraint: 'supplied_datetime_must_remain_literal',
    });
    const metadata = v.is(JsonObjectSchema, block.attributes.metadata)
      ? { ...block.attributes.metadata }
      : {};
    metadata.bindings = { datetime: { source: 'core/post-data', args: { field } } };
    const expected = { ...block.attributes, metadata };
    assert(same(prepared.attributes, expected), 'bound_block_unsupported');
    block.attributes = prepared.attributes;
  }

  assert(
    same(block.attributes, prepared.attributes) &&
      wp.blocks.serialize([block]) === wp.blocks.serialize(parsed),
    'serialization_mismatch',
  );

  return block;
}

// Parser defaults may violate their registration's schema. Omit only exact
// defaults that native creation restores without changing attributes or bytes.
export function parsedBlockInput(wp: WordPress, block: Block): BlockInput {
  const input = blockInput(wp, block);
  const registered = wp.blocks.getBlockType(block.name)?.attributes ?? {};
  safeValue(input.attributes);
  const originalAttributes = input.attributes ?? {};
  input.attributes = Object.fromEntries(
    Object.entries(originalAttributes).filter(([key, value]) => {
      const schema = registered[key];

      return !(
        !['metadata', 'lock', 'templateLock', '__proto__', 'constructor', 'prototype'].includes(
          key,
        ) &&
        schema?.type &&
        'default' in schema &&
        same(value, schema.default) &&
        !schemaAllows(value, schema)
      );
    }),
  );
  input.inner_blocks = (block.innerBlocks ?? []).map((child) => parsedBlockInput(wp, child));
  const recreated = create(wp, input, 0, { value: 0 }, true);

  if (Object.keys(input.attributes).length !== Object.keys(originalAttributes).length) {
    const originalRows = readTree(wp, [block]);
    const recreatedRows = readTree(wp, [recreated]);
    assert(
      same(blockState(originalRows), blockState(recreatedRows)) &&
        wp.blocks.serialize([block]) === wp.blocks.serialize([recreated]),
      'unsupported_markup',
      { block_name: block.name, constraint: 'parser_recreation_preserves_attributes_and_markup' },
    );
  }

  return input;
}

// Gallery's unregistered Image UI fields are ignorable only after native
// whole-document serialization proves removal and parsed restoration harmless.
function gallerySavedFields(wp: WordPress, expected: BlockSummary[], actual: BlockSummary[]) {
  const ignored = new Map<string, Set<string>>();
  const roots = (rows: BlockSummary[]) =>
    rows.flatMap((row) => (row.path.length === 1 ? [row.block] : []));
  const planned = roots(expected);
  const parsed = roots(actual);
  const candidates = expected.filter(
    (row) =>
      row.name === 'core/image' &&
      row.path.length > 1 &&
      expected.some(
        (parent) => parent.name === 'core/gallery' && same(parent.path, row.path.slice(0, -1)),
      ),
  );
  const registered = wp.blocks.getBlockType('core/image')?.attributes ?? {};

  if (!candidates.length) {
    return ignored;
  }

  const plannedBytes = wp.blocks.serialize(planned);
  const parsedBytes = wp.blocks.serialize(parsed);
  const stripped = copyTree(planned);
  const strippedParsed = copyTree(parsed);
  const restored = copyTree(parsed);

  for (const row of candidates) {
    const counterpart = actual.find(
      (entry) => same(entry.path, row.path) && entry.name === row.name,
    );

    if (!counterpart) {
      return new Map<string, Set<string>>();
    }

    const keys = new Set<string>();

    for (const key of ['fullUrl', 'link']) {
      if (
        registered[key] ||
        (!Object.hasOwn(row.block.attributes, key) &&
          !Object.hasOwn(counterpart.block.attributes, key))
      ) {
        continue;
      }

      const removed = copyTree(planned);
      const removedParsed = copyTree(parsed);
      delete at(removed, row.path).attributes[key];
      delete at(removedParsed, row.path).attributes[key];
      const addedParsed = copyTree(parsed);
      at(addedParsed, row.path).attributes[key] = row.block.attributes[key];

      if (
        wp.blocks.serialize(addedParsed) !== parsedBytes ||
        wp.blocks.serialize(removed) !== plannedBytes ||
        wp.blocks.serialize(removedParsed) !== parsedBytes
      ) {
        return new Map<string, Set<string>>();
      }

      delete at(stripped, row.path).attributes[key];
      delete at(strippedParsed, row.path).attributes[key];
      at(restored, row.path).attributes[key] = row.block.attributes[key];
      keys.add(key);
    }

    ignored.set(row.path.join('.'), keys);
  }

  if (
    wp.blocks.serialize(stripped) !== plannedBytes ||
    wp.blocks.serialize(strippedParsed) !== parsedBytes ||
    wp.blocks.serialize(restored) !== parsedBytes
  ) {
    return new Map<string, Set<string>>();
  }

  return ignored;
}

// A local attribute is editor state that core never saves, so parsing can't
// restore it. One with a source is saved through markup, such as core/html's.
function savedState(wp: WordPress, rows: BlockSummary[], ignored = new Map<string, Set<string>>()) {
  return blockState(rows).map((state, index) => {
    const registered = wp.blocks.getBlockType(state.name)?.attributes ?? {};

    return {
      ...state,
      attributes: Object.fromEntries(
        Object.entries(state.attributes).filter(([key]) => {
          const schema = registered[key];

          if (ignored.get(rows[index].path.join('.'))?.has(key)) {
            return false;
          }

          return (
            schema?.source !== undefined ||
            (schema?.role !== 'local' && schema?.__experimentalRole !== 'local')
          );
        }),
      ),
    };
  });
}

// A parsed default is harmless only when adding it to the raw planned block
// leaves native save output byte-identical. Save functions see raw attributes.
export function roundTripMatches(
  wp: WordPress,
  expected: BlockSummary[],
  actual: BlockSummary[],
): boolean {
  const ignored = gallerySavedFields(wp, expected, actual);
  const expectedState = savedState(wp, expected, ignored);
  const actualState = savedState(wp, actual, ignored);

  if (same(expectedState, actualState)) {
    return true;
  }

  if (expected.length !== actual.length) {
    return false;
  }

  return expected.every((row, index) => {
    const parsed = actual[index];

    if (same(expectedState[index], actualState[index])) {
      return true;
    }

    const attributes = { ...expectedState[index].attributes };
    const additions: JsonObject = {};
    const registered = wp.blocks.getBlockType(row.name)?.attributes;

    for (const [key, value] of Object.entries(parsed.attributes)) {
      const schema = registered?.[key];
      const nativeValue = parsed.block.attributes[key];

      if (
        row.block.attributes[key] === undefined &&
        nativeValue !== undefined &&
        schema &&
        Object.hasOwn(actualState[index].attributes, key) &&
        ((schema.source === undefined &&
          'default' in schema &&
          JSON.stringify(nativeValue) === JSON.stringify(schema.default)) ||
          (nativeValue === false &&
            schema.type === 'boolean' &&
            schema.source === 'attribute' &&
            Boolean(schema.selector?.trim()) &&
            Boolean(schema.attribute?.trim())))
      ) {
        attributes[key] = value;
        additions[key] = nativeValue;
      }
    }

    if (!same({ ...expectedState[index], attributes }, actualState[index])) {
      return false;
    }

    const filled = { ...row.block, attributes: { ...row.block.attributes, ...additions } };

    try {
      return wp.blocks.serialize([filled]) === wp.blocks.serialize([row.block]);
    } catch (cause) {
      throw new BlockworkError(
        'serialization_mismatch',
        {
          stage: 'round_trip_defaults',
          comparison: 'default_filled_to_planned',
          target_path: row.path,
          markup_available: false,
        },
        { cause },
      );
    }
  });
}

// A fresh Gallery Image has native companion attributes. Require their final
// registered values in the caller's plan before adding unsaved UI values.
export async function prepareCompleteGallery(
  wp: WordPress,
  plan: Plan,
  media: Awaited<ReturnType<typeof mediaEdits>>,
  contentOnly: boolean,
): Promise<(() => void) | undefined> {
  const galleries = media.resolved.filter(({ binding }) => {
    const parent = binding.path.slice(0, -1);

    if (!parent.length || at(plan.blocks, parent).name !== 'core/gallery') {
      return false;
    }

    const image = at(plan.blocks, binding.path);
    const before = readTree(wp, plan.steps[0].before).find(
      (row) => row.clientId === image.clientId,
    );

    return !before?.block.originalContent;
  });

  if (!galleries.length) {
    return;
  }

  const requireGallery = (condition: boolean | undefined, attribute?: string) =>
    assert(condition, 'gallery_companion_required', {
      stage: 'gallery_preparation',
      target_path: galleries[0].binding.path,
      attribute,
      constraint: 'complete_fresh_unlinked_gallery_image',
    });
  requireGallery(contentOnly && media.resolved.length === 1 && galleries.length === 1);
  const [{ binding, record, token }] = galleries;
  const path = binding.path;
  const parent = path.slice(0, -1);
  const original = plan.steps[0].before;
  const before = at(original, path);
  const gallery = at(plan.blocks, parent);
  const image = at(plan.blocks, path);
  requireGallery(
    binding.name === 'core/image' &&
      before.name === 'core/image' &&
      image.name === 'core/image' &&
      at(original, parent).name === 'core/gallery' &&
      !before.attributes.id &&
      !before.originalContent &&
      !before.attributes.href &&
      !before.attributes.linkTarget &&
      !before.attributes.rel &&
      (!before.attributes.linkDestination || before.attributes.linkDestination === 'none') &&
      plan.steps.every((step) => step.edit.op === 'update') &&
      same(binding.bind, { id: 'id', url: 'url', alt: 'alt', size_slug: 'sizeSlug' }),
  );
  requireGallery(gallery.attributes.sizeSlug === binding.size, 'sizeSlug');
  requireGallery(gallery.attributes.linkTo === 'none', 'linkTo');
  requireGallery(!gallery.attributes.linkTarget && !gallery.attributes.rel, 'linkTarget');
  // An explicit nonempty caption avoids importing the attachment's caption.
  requireGallery(
    typeof image.attributes.caption === 'string' && image.attributes.caption.length > 0,
    'caption',
  );
  const nativeFinal: JsonObject = {
    sizeSlug: binding.size,
    linkDestination: 'none',
    href: undefined,
    lightbox: undefined,
    align: undefined,
    linkTarget: undefined,
    rel: undefined,
    className: image.attributes.className || undefined,
    aspectRatio:
      gallery.attributes.aspectRatio === 'auto' ? undefined : gallery.attributes.aspectRatio,
    alt: image.attributes.alt || record.alt_text,
  };

  for (const [key, value] of Object.entries(nativeFinal)) {
    requireGallery(same(image.attributes[key], value), key);
  }

  const ids = gallery
    .innerBlocks!.map((block) => block.attributes.id)
    .filter((id) => id !== undefined);
  const query = { include: ids.join(','), per_page: -1, orderby: 'include' };
  const resolve = wp.data.resolveSelect?.('core').getEntityRecords;
  const select = wp.data.select('core').getEntityRecords;
  requireGallery(Boolean(resolve && select), 'media');
  const records = await resolve!('postType', 'attachment', query);
  const mediaFields = (value: JsonValue | undefined) => {
    requireGallery(v.is(JsonObjectSchema, value), 'media');
    const object = v.parse(JsonObjectSchema, value);
    const details = v.is(JsonObjectSchema, object.media_details) ? object.media_details : {};
    const sizes = v.is(JsonObjectSchema, details.sizes) ? details.sizes : {};

    return {
      id: object.id,
      source_url: object.source_url,
      alt_text: object.alt_text,
      link: object.link,
      full_url:
        v.is(JsonObjectSchema, object.sizes) && v.is(JsonObjectSchema, object.sizes.full)
          ? object.sizes.full.url
          : undefined,
      sizes: Object.fromEntries(
        Object.entries(sizes).map(([name, size]) => {
          requireGallery(v.is(JsonObjectSchema, size), 'media_details.sizes');
          const entry = v.parse(JsonObjectSchema, size);

          return [name, { source_url: entry.source_url, width: entry.width, height: entry.height }];
        }),
      ),
    };
  };

  const findMedia = (values: JsonValue | undefined) => {
    requireGallery(Array.isArray(values), 'media');

    return v
      .parse(v.array(JsonSchema), values)
      .find((value) => v.is(JsonObjectSchema, value) && value.id === binding.media_id);
  };

  const inspected = mediaFields(record);
  requireGallery(same(mediaFields(findMedia(records)), inspected), 'media');
  const full = inspected.sizes.full;
  const selectedSize = inspected.sizes[binding.size];
  const fullUrl = inspected.full_url || full?.source_url;
  const selectedUrl =
    binding.size === 'full' ? fullUrl || inspected.source_url : selectedSize?.source_url;
  requireGallery(same(image.attributes.url, selectedUrl), 'url');
  const local: JsonObject = { link: inspected.link };
  requireGallery(typeof local.link === 'string', 'link');

  if (fullUrl) {
    requireGallery(typeof fullUrl === 'string', 'fullUrl');
    local.fullUrl = fullUrl;
  }

  const registered = wp.blocks.getBlockType('core/image')?.attributes ?? {};

  for (const [key, value] of Object.entries(local)) {
    if (registered[key]) {
      requireGallery(same(image.attributes[key], value), key);
    }
  }

  const step = plan.steps.at(-1)!;
  requireGallery(step.edit.op === 'update' && same(step.edit.path, path));
  step.update = { ...step.update, ...local };
  Object.assign(at(step.after, path).attributes, local);
  Object.assign(image.attributes, local);
  const rows = readTree(wp, plan.blocks);
  const parsed = readTree(wp, wp.blocks.parse(wp.blocks.serialize(plan.blocks)));
  requireGallery(
    !validity(parsed).invalid.length && roundTripMatches(wp, rows, parsed),
    'serialization',
  );
  const liveIds = new Set(readTree(wp, original).map((row) => row.clientId));

  for (const action of plan.steps) {
    await policy(wp, original, action.edit, action.blocks, liveIds);
  }

  requireGallery((await readMedia(wp, binding.media_id)).token === token, 'media_token');

  return () => {
    requireGallery(
      same(mediaFields(findMedia(select!('postType', 'attachment', query))), inspected),
      'media',
    );

    for (const action of plan.steps) {
      checkPolicy(wp, original, action.edit, action.blocks, liveIds);
    }
  };
}

// Only explicit final attributes are transported; no context-derived values are inferred.
export async function prepareCompleteContextMove(
  wp: WordPress,
  plan: Plan,
): Promise<(() => void) | undefined> {
  const [move, update] = plan.steps;

  if (
    !move ||
    move.edit.op !== 'move' ||
    !move.edit.path.slice(0, -1).length ||
    !move.edit.parent.length ||
    same(move.edit.path.slice(0, -1), move.edit.parent)
  ) {
    return;
  }

  const original = move.before;
  const leaf = at(original, move.edit.path);
  const source = at(original, move.edit.path.slice(0, -1));
  const destination = at(original, move.edit.parent);
  const used = wp.blocks.getBlockType(leaf.name)?.usesContext ?? [];
  const sourceContext = wp.blocks.getBlockType(source.name)?.providesContext ?? {};
  const destinationContext = wp.blocks.getBlockType(destination.name)?.providesContext ?? {};
  const shared = used.filter(
    (key) =>
      key.includes('/') &&
      !key.startsWith('core/') &&
      Object.hasOwn(sourceContext, key) &&
      Object.hasOwn(destinationContext, key),
  );

  if (
    leaf.innerBlocks?.length ||
    source.name !== destination.name ||
    !shared.length ||
    shared.length !== used.length
  ) {
    return;
  }

  const liveIds = new Set(readTree(wp, original).map((row) => row.clientId));
  assert(plan.steps.length !== 1, 'context_companion_required', {
    stage: 'context_preparation',
    edit_index: 0,
    target_path: move.edit.path,
    destination_path: [
      ...move.edit.parent,
      move.edit.index ?? destination.innerBlocks?.length ?? 0,
    ],
  });

  if (
    plan.steps.length !== 2 ||
    update.edit.op !== 'update' ||
    leaf.clientId !== at(update.before, update.edit.path).clientId ||
    !Object.keys(update.edit.attributes).length ||
    update.edit.unset?.length
  ) {
    return;
  }

  const updateOriginal: Edit = { ...update.edit, path: move.edit.path };
  await policy(wp, original, move.edit, move.blocks, liveIds);
  await policy(wp, original, updateOriginal, [], liveIds);
  await policy(wp, update.before, update.edit, [], liveIds);

  return () => {
    checkPolicy(wp, original, move.edit, move.blocks, liveIds);
    checkPolicy(wp, original, updateOriginal, [], liveIds);
    checkPolicy(wp, update.before, update.edit, [], liveIds);
  };
}

export async function checkCompleteTabsChildren(wp: WordPress, plan: Plan): Promise<void> {
  const [step] = plan.steps;

  if (step.edit.op !== 'insert' || step.edit.block.name !== 'core/tab-panel') {
    return;
  }

  const panel = step.blocks[0];
  await requireContexts(wp, [panel.clientId]);
  const child = panel.innerBlocks![0];
  const settings = wp.data.select('core/block-editor').getBlockListSettings?.(panel.clientId);
  const details = {
    target_path: [
      ...step.edit.parent,
      step.edit.index ?? at(step.before, step.edit.parent).innerBlocks!.length,
      0,
    ],
    block_name: child.name,
    parent_name: panel.name,
  };
  assert(settings, 'native_insertion_context_unavailable', details);
  const allowed = settings.allowedBlocks;
  const admitted = Array.isArray(allowed) && allowed.includes(child.name);
  assert(!Array.isArray(allowed) || admitted, 'insertion_refused', {
    ...details,
    constraint: 'parent_allowed_blocks',
  });
  const parents = wp.blocks.getBlockType(child.name)?.parent;
  assert(
    !parents ||
      admitted ||
      parents.includes(panel.name) ||
      wp.blocks.getBlockType(panel.name)?.allowedBlocks?.includes(child.name),
    'insertion_refused',
    { ...details, constraint: 'block_parent' },
  );
}

export async function prepareCompleteTabs(
  wp: WordPress,
  plan: Plan,
): Promise<(() => void) | undefined> {
  const [action] = plan.steps;

  if (!action || (!('path' in action.edit) && action.edit.op !== 'insert')) {
    return;
  }

  const add = action.edit.op === 'insert' && action.edit.block.name === 'core/tab-panel';
  const path =
    action.edit.op === 'insert'
      ? [...action.edit.parent, action.edit.index ?? 0]
      : action.edit.path;
  const rootPath = path.slice(0, -2);

  if (path.length < 3) {
    return;
  }

  const original = action.before;
  const root = at(original, rootPath);

  if (
    root.name !== 'core/tabs' ||
    root.innerBlocks?.length !== 2 ||
    root.innerBlocks[0].name !== 'core/tab-list' ||
    root.innerBlocks[1].name !== 'core/tab-panels' ||
    path.at(-2) !== 1 ||
    !root.innerBlocks[1].innerBlocks?.every((b) => b.name === 'core/tab-panel')
  ) {
    return;
  }

  const rename =
    action.edit.op === 'update' &&
    same(Object.keys(action.edit.attributes), ['label']) &&
    !action.edit.unset?.length;
  const structural =
    add ||
    action.edit.op === 'remove' ||
    (action.edit.op === 'move' && same(action.edit.parent, [...rootPath, 1]));

  if (!rename && !structural) {
    return;
  }

  if (add && action.edit.op === 'insert') {
    const panel = action.edit.block;
    const [paragraph] = panel.inner_blocks ?? [];
    assert(
      panel.inner_blocks?.length === 1 &&
        paragraph?.name === 'core/paragraph' &&
        !Object.keys(paragraph.attributes ?? {}).length &&
        !paragraph.inner_blocks?.length &&
        same(Object.keys(panel.attributes ?? {}), ['label']),
      'tabs_companion_required',
      {
        stage: 'tabs_preparation',
        edit_index: 0,
        target_path: path,
        constraint: 'explicit_single_empty_paragraph',
      },
    );
  }

  const finalRoot = at(plan.blocks, rootPath);
  const listPath = [...rootPath, 0];
  const expected = finalRoot.innerBlocks![1].innerBlocks!.map((block) => ({
    label: block.attributes.label || '',
  }));
  const validateTabs = (tabs: JsonValue | undefined) =>
    assert(same(tabs, expected), 'tabs_companion_required', {
      stage: 'tabs_preparation',
      edit_index: 0,
      target_path: listPath,
      attribute: 'tabs',
    });

  if (plan.steps.length !== (rename ? 2 : 3)) {
    const local = plan.steps[1]?.edit;
    const partial =
      (rename && plan.steps.length === 1) ||
      (structural &&
        plan.steps.length === 2 &&
        local.op === 'update' &&
        same(local.path, rootPath) &&
        same(Object.keys(local.attributes), ['editorActiveTabIndex']) &&
        !local.unset?.length);

    if (partial) {
      validateTabs(root.innerBlocks[0].attributes.tabs);
    }

    return;
  }

  const list = plan.steps.find(
    (step) => step.edit.op === 'update' && same(step.edit.path, listPath),
  );

  if (
    !list ||
    list.edit.op !== 'update' ||
    !same(Object.keys(list.edit.attributes), ['tabs']) ||
    list.edit.unset?.length
  ) {
    assert(!add, 'tabs_companion_required', {
      stage: 'tabs_preparation',
      target_path: listPath,
      attribute: 'tabs',
      constraint: 'complete_tab_list_update_only',
    });

    return;
  }

  validateTabs(list.edit.attributes.tabs);

  if (structural) {
    const local = plan.steps.find(
      (step) => step.edit.op === 'update' && same(step.edit.path, rootPath),
    );

    if (
      !local ||
      local.edit.op !== 'update' ||
      !same(Object.keys(local.edit.attributes), ['editorActiveTabIndex']) ||
      local.edit.unset?.length
    ) {
      assert(!add, 'tabs_companion_required', {
        stage: 'tabs_preparation',
        target_path: rootPath,
        attribute: 'editorActiveTabIndex',
        constraint: 'complete_root_active_index_update_only',
      });

      return;
    }
  }

  if (add && action.edit.op === 'insert') {
    const index = action.edit.index ?? root.innerBlocks[1].innerBlocks!.length;
    assert(finalRoot.attributes.editorActiveTabIndex === index, 'tabs_companion_required', {
      stage: 'tabs_preparation',
      target_path: rootPath,
      attribute: 'editorActiveTabIndex',
    });
  }

  const liveIds = new Set(readTree(wp, original).map((row) => row.clientId));

  for (const step of plan.steps) {
    await policy(wp, original, step.edit, step.blocks, liveIds);
  }

  return () => {
    for (const step of plan.steps) {
      checkPolicy(wp, original, step.edit, step.blocks, liveIds);
    }
  };
}

// This first paired path needs no policy from a newly mounted parent.
export async function prepareExplicitFootnotePlan(wp: WordPress, plan: Plan): Promise<void> {
  const original = plan.steps[0].before;
  assert(wp.blocks.__unstableSerializeAndClean, 'native_readiness_unavailable', {
    stage: 'footnote_preparation',
    capability: 'blocks.__unstableSerializeAndClean',
  });
  const liveIds = new Set(readTree(wp, original).map((row) => row.clientId));

  for (const step of plan.steps) {
    await policy(wp, original, step.edit, step.blocks, liveIds);
  }
}

// Root structural Footnotes use the original live policies before a paired write.
export async function authorizeFootnotePlan(
  wp: WordPress,
  plan: Plan,
  numbered: Block[],
  companions: FootnoteCompanion[],
): Promise<() => void> {
  const original = plan.steps[0].before;
  const permissionChecks: Array<() => void> = [];
  const liveIds = new Set(readTree(wp, original).map((row) => row.clientId));

  for (const [index, step] of plan.steps.entries()) {
    const edit = step.edit;
    assert(['insert', 'move', 'remove'].includes(edit.op), 'unsupported_structural_edit');
    let policyEdit = edit;

    if ('path' in edit) {
      const target = at(step.before, edit.path);
      const liveIndex = original.findIndex((block) => block.clientId === target.clientId);
      assert(
        edit.path.length === 1 && target.name === 'core/paragraph' && liveIndex >= 0,
        'unsupported_structural_edit',
        {
          edit_index: index,
          constraint: 'footnote_original_root_paragraph',
          next_step: 'Move or remove only existing root paragraphs in this paired request.',
        },
      );
      policyEdit = { ...edit, path: [liveIndex] };
    }

    const inserted = step.blocks.map(
      (block) => numbered.find((item) => item.clientId === block.clientId) ?? block,
    );

    if (edit.op === 'insert' && inserted[0].name === 'core/paragraph') {
      attributes(wp, 'core/paragraph', { content: inserted[0].attributes.content });
    }

    await policy(wp, original, policyEdit, inserted, liveIds);
    permissionChecks.push(() => checkPolicy(wp, original, policyEdit, inserted, liveIds));
  }

  for (const companion of companions) {
    const index = original.findIndex((block) => block.clientId === companion.client_id);

    assert(index >= 0, 'block_identity_missing', { target_path: companion.path });
    const edit: Edit = {
      op: 'update',
      name: 'core/paragraph',
      path: [index],
      attributes: { content: companion.content },
      unset: [],
    };
    const diagnostics = {
      stage: 'footnote_companion_permission',
      client_id: companion.client_id,
      target_path: companion.path,
      live_path: [index],
      attribute: 'content',
    };

    try {
      attributes(wp, 'core/paragraph', { content: companion.content });
      await policy(wp, original, edit, [], liveIds);
    } catch (cause) {
      const error = cause instanceof BlockworkError ? cause : undefined;

      throw new BlockworkError(
        error?.code ?? 'operation_failed',
        { ...error?.diagnostics, ...diagnostics },
        { cause },
      );
    }

    permissionChecks.push(() => {
      try {
        checkPolicy(wp, original, edit, [], liveIds);
      } catch (cause) {
        const error = cause instanceof BlockworkError ? cause : undefined;

        throw new BlockworkError(
          error?.code ?? 'operation_failed',
          { ...error?.diagnostics, ...diagnostics },
          { cause },
        );
      }
    });
    plan.touched.push({ client_id: companion.client_id, kind: 'attributes', edit_index: 0 });
  }

  return () => {
    for (const check of permissionChecks) {
      check();
    }
  };
}

export async function preparePlan(
  wp: WordPress,
  requests: RequestedEdit[],
  content: string,
  target: Target,
): Promise<Plan> {
  const original = copyTree(documentBlocks(wp));
  const originalRows = readTree(wp, original);

  checkCSSPermission(wp, original);

  const originalState = canonical(blockState(originalRows));
  const status = validity(originalRows);
  assert(status.invalid.length === 0, 'unsupported_block');
  assert(
    !status.unsupported.length ||
      requests.every((edit) => ['update', 'update_style'].includes(edit.op)),
    'unsupported_structural_edit',
  );
  const normalization = wp.blocks.serialize(original) !== content;
  // Gutenberg omits a single unmodified default block from document content.
  // Keep its live identity so the inspected placeholder can still be edited.
  const emptyPlaceholder =
    content === '' &&
    original.length === 1 &&
    !original[0].innerBlocks?.length &&
    wp.blocks.isUnmodifiedDefaultBlock?.(original[0]) === true;

  if (normalization && !emptyPlaceholder) {
    let diagnostics: JsonObject = {
      stage: 'initial_serialization',
      comparison: 'content_to_live',
      baseline_available: false,
      markup_changed: true,
    };

    try {
      const contentRows = readTree(wp, wp.blocks.parse(content));
      diagnostics = {
        ...serializationDiagnostics(
          contentRows,
          originalRows,
          'initial_serialization',
          'content_to_live',
        ),
        baseline_available: true,
        markup_changed: true,
        block_state_equal: same(blockState(contentRows), blockState(originalRows)),
        ...rewrittenBlocks(wp, originalRows, content),
      };
    } catch {
      // Preserve the original refusal when native content cannot be inspected.
    }

    throw new BlockworkError('initial_serialization_changed', {
      ...diagnostics,
      editor_url: editorUrl(target),
    });
  }

  const steps: Step[] = [];
  const edits: Edit[] = [];
  const liveIds = new Set(originalRows.map((row) => row.clientId));
  const changes = new Map<string, JsonObject>();
  const references: Plan['references'] = {};
  const touched: Touch[] = [];
  const spacers: NonNullable<Plan['spacers']> = [];
  let blocks = copyTree(original);

  for (const [editIndex, request] of requests.entries()) {
    let targetPath: number[] | undefined;
    let targetOrigin = 'unresolved';
    let livePath: number[] | undefined;

    try {
      const edit = resolveEdit(wp, blocks, request);
      targetPath = 'path' in edit ? edit.path : edit.parent;
      const targetBlock = targetPath.length ? at(blocks, targetPath) : undefined;
      const liveRow =
        targetBlock && originalRows.find((row) => row.clientId === targetBlock.clientId);
      targetOrigin = 'document_root';

      if (targetBlock) {
        targetOrigin = liveRow ? 'existing_block' : 'inserted_block';
      }

      livePath = liveRow?.path;
      edits.push(edit);

      if ('path' in edit && liveIds.has(at(blocks, edit.path).clientId)) {
        touched.push({
          client_id: at(blocks, edit.path).clientId,
          kind: ['update', 'update_style', 'set_block_style', 'update_reference'].includes(edit.op)
            ? 'attributes'
            : 'subtree',
          edit_index: editIndex,
        });
      }

      if ('parent' in edit && edit.index !== undefined) {
        const parentId = edit.parent.length ? at(blocks, edit.parent).clientId : '';

        if (!parentId || liveIds.has(parentId)) {
          touched.push({ client_id: parentId, kind: 'children', edit_index: editIndex });
        }
      }

      // A path names the intended block only while every ancestor keeps the
      // children the agent last read. Client ID selectors need no such check.
      // A move can address its source and its destination by path.
      const selectedPaths = [
        'path' in request && request.path !== undefined && 'path' in edit ? edit.path : undefined,
        'parent' in request && request.parent?.length && 'parent' in edit ? edit.parent : undefined,
      ];

      for (const selected of selectedPaths) {
        if (!selected) {
          continue;
        }

        touched.push({ client_id: '', kind: 'children', edit_index: editIndex });

        for (const ancestor of ancestry(blocks, selected.slice(0, -1))) {
          if (liveIds.has(ancestor.clientId)) {
            touched.push({ client_id: ancestor.clientId, kind: 'children', edit_index: editIndex });
          }
        }
      }

      const before = copyTree(blocks);
      let comments: EmptyComments | undefined;
      let inserted: Block[] = [];
      let update: JsonObject | undefined;
      const existing = 'path' in edit ? at(blocks, edit.path) : undefined;

      if (existing) {
        assert(existing.name === ('name' in edit ? edit.name : ''), 'block_mismatch', {
          target_path: 'path' in edit ? edit.path : undefined,
          expected_name: 'name' in edit ? edit.name : undefined,
          actual_name: existing.name.slice(0, 200),
          constraint: 'matching_block_name',
        });
      }

      if (edit.op === 'insert' || edit.op === 'replace') {
        inserted = [create(wp, edit.block)];
      }

      if (edit.op === 'insert_pattern') {
        const item = (await patterns(wp)).find((pattern) => pattern.name === edit.pattern);

        assert(item, 'stale_pattern');
        const parsed = wp.blocks.parse(item.content);
        assert(parsed.length > 0, 'unsupported_pattern');
        const parsedRows = readTree(wp, parsed);
        assert(validity(parsedRows).valid, 'unsupported_pattern');

        const prepared = await prepareEmptyComments(
          wp,
          target,
          edit.pattern,
          parsedRows.some((row) => row.name === 'core/comments') &&
            edit.parent.length === 0 &&
            requests.length === 1,
        );

        if (prepared) {
          comments = prepared.proof;
          const clone = (block: Block): Block => {
            const recreated = create(wp, parsedBlockInput(wp, block));
            assert(
              same(blockState(readTree(wp, [block])), blockState(readTree(wp, [recreated]))) &&
                wp.blocks.serialize([block]) === wp.blocks.serialize([recreated]),
              'unsupported_pattern',
            );

            return wp.blocks.cloneBlock(
              block,
              copyAttributes(block.attributes),
              (block.innerBlocks ?? []).map(clone),
            );
          };

          inserted = prepared.blocks.map(clone);
          const insertedRows = readTree(wp, inserted);
          const templates = insertedRows.filter((row) => row.name === 'core/comment-template');

          for (const row of insertedRows) {
            if (
              templates.some(
                (template) =>
                  row.path.length > template.path.length && containsPath(template.path, row.path),
              )
            ) {
              comments.hidden.add(row.clientId);
            }
          }
        } else {
          const inputs = parsed.map((block) => parsedBlockInput(wp, block));
          const parents = ancestry(blocks, edit.parent);
          const converted = normalizePatternSpacers(
            wp,
            inputs,
            parents,
            wp.blockSerializationDefaultParser?.parse(item.content) ?? [],
          );
          inserted = inputs.map((input) => create(wp, input, 0, { value: 0 }, true));

          for (const conversion of converted) {
            const dependencies = [...parents, ...ancestry(inserted, conversion.path.slice(0, -1))];
            spacers.push({
              ...conversion,
              clientId: at(inserted, conversion.path).clientId,
              ancestors: copyTree(dependencies),
            });

            for (const ancestor of dependencies) {
              if (liveIds.has(ancestor.clientId)) {
                const original = originalRows.find((row) => row.clientId === ancestor.clientId);
                assert(
                  same(original?.attributes, ancestor.attributes),
                  'prepared_content_changed',
                  {
                    constraint: 'pattern_spacer_ancestor',
                    next_step:
                      'Insert the pattern in a separate batch from changes to its containers.',
                  },
                );
                touched.push({
                  client_id: ancestor.clientId,
                  kind: 'attributes',
                  edit_index: editIndex,
                });
              }
            }
          }
        }
      }

      if (edit.op === 'insert_variation') {
        const item = (await variations(wp, edit.name)).find(
          (variation) => variation.name === edit.variation,
        );

        assert(item, 'stale_variation');
        attributes(wp, edit.name, edit.attributes);
        create(
          wp,
          {
            name: edit.name,
            attributes: item.attributes,
            inner_blocks: wp.blocks
              .createBlocksFromInnerBlocksTemplate(item.innerBlocks ?? [])
              .map((block) => blockInput(wp, block)),
          },
          0,
          { value: 0 },
          true,
        );
        const values = { ...item.attributes, ...edit.attributes };

        if (postDateField({ name: edit.name, attributes: item.attributes ?? {} })) {
          assert(!Object.hasOwn(edit.attributes, 'datetime'), 'unsupported_attribute', {
            block_name: edit.name,
            attribute: 'datetime',
            constraint: 'bound_datetime_read_only',
          });

          if (
            v.is(JsonObjectSchema, item.attributes?.metadata) &&
            v.is(JsonObjectSchema, edit.attributes.metadata)
          ) {
            values.metadata = { ...item.attributes.metadata, ...edit.attributes.metadata };
          }
        }

        inserted = [
          create(
            wp,
            {
              name: edit.name,
              attributes: values,
              inner_blocks: wp.blocks
                .createBlocksFromInnerBlocksTemplate(item.innerBlocks ?? [])
                .map((block) => blockInput(wp, block)),
            },
            0,
            { value: 0 },
            true,
          ),
        ];
      }

      if (edit.op === 'insert_reference' || edit.op === 'update_reference') {
        const resolved = await readReference(wp, target, edit.reference);
        assert(!same(resolved.target, target), 'recursive_entity_reference');
        const graph = await referenceGraph(wp, target, edit.reference);

        if (edit.op === 'insert_reference') {
          inserted = [wp.blocks.createBlock(resolved.name, resolved.attributes)];
        } else {
          assert(
            existing?.name === resolved.name && !existing.innerBlocks?.length,
            'reference_block_mismatch',
          );
          update = resolved.attributes;
        }

        const owner = edit.op === 'insert_reference' ? inserted[0] : existing;
        assert(owner, 'block_mismatch');
        references[owner.clientId] = { identity: resolved.attributes, graph };
      }

      if (edit.op === 'update') {
        assert(existing, 'block_mismatch');
        update = updateAttributes(wp, existing, edit.attributes, edit.unset);
      }

      if (edit.op === 'update_style') {
        assert(existing, 'block_mismatch');
        update = await styleUpdate(wp, existing, edit);
      }

      if (edit.op === 'set_block_style') {
        const catalog = await styles(wp, edit.name);
        assert(
          edit.style === null || catalog.items.some((item) => item.name === edit.style),
          'style_unavailable',
        );
        assert(
          wp.blocks.getBlockType(edit.name)?.supports?.customClassName !== false,
          'style_unavailable',
        );
        const old = existing?.attributes.className ?? '';
        assert(typeof old === 'string', 'invalid_class_name');
        const names = new Set(catalog.items.map((item) => `is-style-${item.name}`));
        const classes = old.split(/\s+/).filter((item) => item && !names.has(item));

        if (edit.style !== null) {
          classes.push(`is-style-${edit.style}`);
        }

        update = { className: [...new Set(classes)].join(' ') };
        attributes(wp, edit.name, update);
      }

      if (edit.op === 'move') {
        assert(existing && !containsPath(edit.path, edit.parent), 'invalid_move');
        inserted = [existing];
      }

      await policy(wp, blocks, edit, inserted, liveIds);
      const currentBlocks = documentBlocks(wp);
      const currentRows = readTree(wp, currentBlocks);
      const currentState = blockState(currentRows);

      if (!same(originalState, currentState)) {
        throw new BlockworkError('editor_content_changed', {
          mismatches: blockMismatches(originalRows, currentRows, true),
        });
      }

      if (update && existing) {
        changes.set(existing.clientId, update);
        existing.attributes = { ...existing.attributes, ...update };
      } else if ('parent' in edit) {
        const destination = children(blocks, edit.parent);

        if (edit.op === 'move') {
          children(blocks, edit.path.slice(0, -1)).splice(edit.path.at(-1)!, 1);
        }

        const index = edit.index ?? destination.length;
        assert(index <= destination.length, 'invalid_index');
        destination.splice(index, 0, ...inserted);
      } else if ('path' in edit) {
        children(blocks, edit.path.slice(0, -1)).splice(edit.path.at(-1)!, 1, ...inserted);
      }

      steps.push({ edit, blocks: inserted, before, after: copyTree(blocks), update, comments });
      blocks = copyTree(blocks);
    } catch (error) {
      if (error instanceof BlockworkError) {
        const diagnostics: JsonObject = {
          stage: 'prepare_plan',
          edit_index: editIndex,
          edit_operation: request.op,
          target_path: targetPath,
          path_space: 'planned',
          target_origin: targetOrigin,
          live_path: livePath,
          ...error.diagnostics,
        };

        if (error.diagnostics?.field) {
          diagnostics.field = `edits.${editIndex}.${error.diagnostics.field}`;
        }

        throw new BlockworkError(error.code, diagnostics);
      }

      throw error;
    }
  }

  const desired = wp.blocks.serialize(blocks);
  const parsedBlocks = wp.blocks.parse(desired);
  const parsedRows = readTree(wp, parsedBlocks);
  assert(!validity(parsedRows).invalid.length, 'unsupported_block');
  const plannedRows = readTree(wp, blocks);
  const boundDate = parsedRows.find((row, index) => {
    const metadata = row.attributes.metadata;

    return (
      row.name === 'core/post-date' &&
      v.is(JsonObjectSchema, metadata) &&
      Boolean(metadata.bindings) &&
      !postDateField(row) &&
      !same(metadata, plannedRows[index]?.attributes.metadata)
    );
  });

  assert(!boundDate, 'bound_block_unsupported', {
    target_path: boundDate?.path,
    block_name: 'core/post-date',
    attribute: 'metadata.bindings.datetime',
    constraint: 'native_post_data_binding_unsupported',
  });

  // Mismatch diagnostics scan the whole document, so build them only on failure.
  if (!roundTripMatches(wp, plannedRows, parsedRows)) {
    throw new BlockworkError(
      'serialization_mismatch',
      serializationDiagnostics(plannedRows, parsedRows, 'prepare_round_trip', 'planned_to_parsed'),
    );
  }

  if (status.unsupported.length) {
    provePreservation(wp, originalRows, plannedRows, content, desired, changes);
  }

  const plan = { edits, steps, blocks, target, references, touched, spacers };
  checkPatternSpacers(wp, plan, blocks, true);

  return plan;
}

function checkPatternSpacers(wp: WordPress, plan: Plan, blocks: Block[], final = false): void {
  const rows = readTree(wp, blocks);

  for (const spacer of plan.spacers ?? []) {
    assert(
      same(spacer.settings, spacerSettings(wp, spacer.ancestors)),
      'prepared_content_changed',
      {
        constraint: 'pattern_spacer_settings',
        next_step: 'Read the document and plan the pattern insertion again.',
      },
    );

    for (const ancestor of spacer.ancestors) {
      const actual = rows.find((row) => row.clientId === ancestor.clientId);
      assert(
        (!actual && !final) || same(actual?.attributes, ancestor.attributes),
        'prepared_content_changed',
        {
          constraint: 'pattern_spacer_ancestor',
          next_step: 'Insert the pattern in a separate batch from changes to its containers.',
        },
      );
    }

    const actual = rows.find((row) => row.clientId === spacer.clientId);
    const style = actual?.attributes.style;
    assert(
      (!actual && !final) ||
        (actual?.attributes.height === '0px' &&
          v.is(JsonObjectSchema, style) &&
          v.is(JsonObjectSchema, style.layout) &&
          style.layout.flexSize === spacer.resolvedSize &&
          style.layout.selfStretch === 'fixed'),
      'prepared_content_changed',
      {
        constraint: 'pattern_spacer_conversion',
        next_step: 'Insert the pattern in a separate batch from Spacer edits.',
      },
    );
  }
}

// Hidden tabs pause animation frames, and a background editor can be hidden.
// A frame or a short timer, whichever comes first, lets React commit.
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    void pause(50).then(resolve);

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
    }
  });
}

export async function restorePlan(
  wp: WordPress,
  plan: Plan,
  checkOwnership: () => void,
  beforeMutation: () => void = () => undefined,
): Promise<void> {
  const original = plan.steps[0].before;
  const store = wp.data.select('core/block-editor');
  const actions = wp.data.dispatch('core/block-editor');
  const start = store.getSelectionStart?.();
  const end = store.getSelectionEnd?.();
  const position = store.getSelectedBlocksInitialCaretPosition?.();
  const ids = new Set(readTree(wp, original).map((row) => row.clientId));
  const checkDates = await preparePostDates(wp, original);
  await resetDocument(wp, copyTree(original), checkOwnership, beforeMutation);

  // RESET_BLOCKS can clear nested selections even when their IDs survive.
  if (
    start &&
    end &&
    actions.resetSelection &&
    (!start.clientId || ids.has(start.clientId)) &&
    (!end.clientId || ids.has(end.clientId)) &&
    (!same(store.getSelectionStart?.(), start) ||
      !same(store.getSelectionEnd?.(), end) ||
      store.getSelectedBlocksInitialCaretPosition?.() !== position)
  ) {
    checkDates();
    const restore = () => actions.resetSelection!(start, end, position);

    if (wp.element?.flushSync) {
      wp.element.flushSync(restore);
    } else {
      restore();
    }

    assert(
      same(store.getSelectionStart?.(), start) &&
        same(store.getSelectionEnd?.(), end) &&
        store.getSelectedBlocksInitialCaretPosition?.() === position,
      'rollback_failed',
    );
  }

  // A hidden canvas may stop animation frames. Cleanup must still finish.
  await pause(0);
  const restoredBlocks = documentBlocks(wp);
  const restoredState = blockState(readTree(wp, restoredBlocks));
  const originalState = blockState(readTree(wp, original));
  assert(same(restoredState, originalState), 'rollback_failed');
}

// Native initialization may add registered data to new blocks. Existing values,
// topology, and every pre-existing block remain exact, including nested objects.
function includesValues(expected: JsonValue | undefined, actual: JsonValue | undefined): boolean {
  if (v.is(JsonObjectSchema, expected) && v.is(JsonObjectSchema, actual)) {
    return Object.entries(expected).every(([key, value]) => includesValues(value, actual[key]));
  }

  return same(expected, actual);
}

// A new block requested without children may receive its registered
// template from its own edit component, as a user's insertion would. Remove
// those generated descendants so the rest compares exactly. They must always
// be new blocks; full validation also requires them supported and nested.
export function withoutTemplates(
  wp: WordPress,
  expected: Block[],
  actual: Block[],
  originalIds: Set<string>,
  validation: 'full' | 'identity' = 'full',
): Block[] {
  const planned = new Map(readTree(wp, expected).map((row) => [row.clientId, row.block]));
  const prune = (blocks: Block[], ancestors: Block[]): Block[] =>
    blocks.map((block) => {
      const request = planned.get(block.clientId);

      if (
        request &&
        !originalIds.has(block.clientId) &&
        !request.innerBlocks?.length &&
        block.innerBlocks?.length
      ) {
        for (const row of readTree(wp, block.innerBlocks)) {
          assert(!originalIds.has(row.clientId), 'native_structure_changed', {
            stage: 'check_initialized',
            constraint: 'template_children_must_be_new',
          });
        }

        if (validation === 'full') {
          checkTemplate(wp, block, ancestors);
        }

        return { ...block, innerBlocks: [] };
      }

      return { ...block, innerBlocks: prune(block.innerBlocks ?? [], [...ancestors, block]) };
    });

  return prune(actual, []);
}

// Generated children meet the same support and nesting rules as requested
// ones, so the document stays fully supported.
function checkTemplate(wp: WordPress, block: Block, ancestors: Block[]): void {
  for (const child of block.innerBlocks ?? []) {
    nesting(wp, child, [...ancestors, block]);
  }

  for (const row of readTree(wp, block.innerBlocks ?? [])) {
    assert(row.support === 'supported', 'unsupported_block', {
      stage: 'check_initialized',
      block_name: row.name,
    });
    attributes(
      wp,
      row.name,
      Object.fromEntries(
        Object.entries(row.attributes).filter(([_key, value]) => value !== undefined),
      ),
      'native',
    );
  }
}

export function checkInitialized(
  wp: WordPress,
  expected: Block[],
  actual: Block[],
  originalIds: Set<string>,
): void {
  const expectedRows = readTree(wp, expected);
  const actualRows = readTree(wp, withoutTemplates(wp, expected, actual, originalIds));
  assert(expectedRows.length === actualRows.length, 'native_structure_changed', {
    stage: 'check_initialized',
    expected_block_count: expectedRows.length,
    actual_block_count: actualRows.length,
  });

  for (let i = 0; i < expectedRows.length; i++) {
    const before = expectedRows[i];
    const after = actualRows[i];
    assert(
      before.clientId === after.clientId &&
        before.name === after.name &&
        same(before.path, after.path),
      'native_structure_changed',
      { stage: 'check_initialized', target_path: before.path },
    );
    assert(
      before.support === after.support && before.reason === after.reason,
      'prepared_content_changed',
    );

    if (originalIds.has(before.clientId)) {
      if (!same(before.attributes, after.attributes)) {
        throw new BlockworkError('prepared_content_changed', {
          stage: 'check_initialized',
          target_path: before.path,
          properties: changedProperties(before.attributes, after.attributes),
        });
      }
    } else {
      if (!includesValues(before.attributes, after.attributes)) {
        throw new BlockworkError('native_requested_value_changed', {
          stage: 'check_initialized',
          target_path: before.path,
          properties: changedProperties(before.attributes, after.attributes),
        });
      }

      const changed = Object.fromEntries(
        Object.entries(after.attributes).filter(
          ([key, value]) => !same(before.attributes[key], value),
        ),
      );

      attributes(wp, after.name, changed, 'native');
    }
  }
}

async function settleInitialization(
  wp: WordPress,
  expected: Block[],
  originalIds: Set<string>,
  affected: Set<string>,
  budget: Budget,
  retainMissingSelection: boolean,
  checkDates: () => void,
): Promise<void> {
  const core = wp.data.select('core');
  assert(core.hasResolvingSelectors, 'native_readiness_unavailable');
  let previous = '';
  let wasResolving = false;
  let renderedState: string | undefined;
  let renderedResolving: boolean | undefined;
  let quietSince = Date.now();

  // This is bounded observed stability, not proof against arbitrary future
  // timers or plugin requests. Once sealed, further changes invalidate save.
  while (true) {
    if (Date.now() >= budget.deadline) {
      throw new BlockworkError('native_initialization_unsettled', {
        stage: 'settle_initialization',
        core_resolving: core.hasResolvingSelectors(),
        changes_from_plan: blockMismatches(
          readTree(wp, expected),
          readTree(wp, documentBlocks(wp)),
        ),
      });
    }

    checkInitialized(wp, expected, documentBlocks(wp), originalIds);

    const beforeRender = JSON.stringify(blockState(readTree(wp, documentBlocks(wp))));
    const resolving = core.hasResolvingSelectors();

    // A completed sweep remains useful while its tree and resolver state stay
    // unchanged. The quiet interval itself does not invalidate every block.
    if (beforeRender !== renderedState || resolving !== renderedResolving) {
      renderedState = beforeRender;
      renderedResolving = resolving;
      await renderAffected(wp, affected, budget, retainMissingSelection, checkDates);
      checkInitialized(wp, expected, documentBlocks(wp), originalIds);
    }

    const current = JSON.stringify(blockState(readTree(wp, documentBlocks(wp))));
    wasResolving = core.hasResolvingSelectors();

    if (current !== previous || wasResolving) {
      quietSince = Date.now();
    }

    previous = current;

    if (
      Date.now() - quietSince >= 100 &&
      current === renderedState &&
      wasResolving === renderedResolving
    ) {
      return;
    }

    await pause(25);
  }
}

export async function applyPlan(
  wp: WordPress,
  plan: Plan,
  beforeMutation: () => void,
  initialize = false,
  retainMissingSelection = true,
  checkpoint: (before: Block[], after?: Block[]) => void = () => {},
): Promise<void> {
  if (!plan.steps.length) {
    return;
  }

  const store = wp.data.select('core/block-editor');
  const actions = wp.data.dispatch('core/block-editor');
  const originalRows = readTree(wp, plan.steps[0].before);
  const originalIds = new Set(originalRows.map((row) => row.clientId));
  const affected = new Set<string>();
  const exactIds = new Set(originalIds);
  const hiddenComments = new Set<string>();

  for (const step of plan.steps) {
    for (const id of step.comments?.hidden ?? []) {
      exactIds.add(id);
      hiddenComments.add(id);
    }
  }

  const dateGuards: Array<() => void> = [];

  for (const [index, step] of plan.steps.entries()) {
    checkPostDateTemplates(
      wp,
      step.after,
      new Set(readTree(wp, stepTargets(step)).map((row) => row.clientId)),
    );
    const beforeRows = readTree(wp, step.before);
    const afterRows = readTree(wp, step.after);
    const previous = new Map(beforeRows.map((row) => [row.clientId, row]));
    const parents = (rows: BlockSummary[], path: number[]) =>
      rows.flatMap((row) =>
        row.path.length < path.length && containsPath(row.path, path) ? [row.clientId] : [],
      );
    const changed = new Set(
      afterRows.flatMap((row) => {
        const prior = previous.get(row.clientId);
        const providers = wp.blocks.getBlockType(row.name)?.providesContext ?? {};
        const contextAttributes = [
          'postId',
          'postType',
          'query',
          'previewPostType',
          'templateSlug',
        ].flatMap((key) => (providers[key] ? [providers[key]] : []));

        if (row.name === 'core/query') {
          contextAttributes.push('query');
        }

        return !prior ||
          !same(parents(beforeRows, prior.path), parents(afterRows, row.path)) ||
          (row.name === 'core/post-template' &&
            (prior.block.innerBlocks?.length ?? 0) > 0 &&
            !row.block.innerBlocks?.length) ||
          (postDateField(row) && !same(prior.attributes, row.attributes)) ||
          contextAttributes.some((key) => !same(prior.attributes[key], row.attributes[key]))
          ? [row.clientId]
          : [];
      }),
    );

    if (step.edit.op !== 'remove') {
      dateGuards.push(await preparePostDates(wp, step.before, changed));
    }

    dateGuards.push(await preparePostDates(wp, step.after, changed));
    await prepareQueryNormalization(
      wp,
      step.before,
      step.after,
      step.edit.op === 'move'
        ? readTree(wp, stepTargets(step)).map((row) => row.block)
        : stepTargets(step),
      originalIds,
      index,
    );
  }

  if (initialize) {
    // Only inserted trees need a preview resolved up front. An attribute edit
    // elsewhere in the batch must not refuse for a Query it does not insert.
    const candidates = new Map(
      plan.steps.flatMap((step, index) =>
        stepNeedsPreparation(step)
          ? readTree(wp, step.blocks).map((row) => [row.clientId, index] as const)
          : [],
      ),
    );
    await checkQueryPreviews(wp, plan.blocks, candidates);
  }

  // Each affected block is rendered once so its edit component can finish
  // native initialization. Hidden tabs mount blocks through throttled idle
  // callbacks, so they get a longer stall. The cap stays inside the invoker's
  // 45-second operation limit.
  const budget = new Budget(
    document.visibilityState === 'hidden' ? 10000 : 5000,
    Math.min(30000, remainingMs()),
  );
  let completedEdits = 0;
  let dispatchedEdits = 0;

  const matches = (expected: Block[]) => {
    checkPatternSpacers(wp, plan, documentBlocks(wp));

    if (initialize) {
      checkInitialized(wp, expected, documentBlocks(wp), exactIds);
    } else {
      const currentBlocks = documentBlocks(wp);
      const currentState = blockState(readTree(wp, currentBlocks));
      const expectedState = blockState(readTree(wp, expected));
      assert(same(currentState, expectedState), 'prepared_content_changed');
      assert(
        same(
          readTree(wp, currentBlocks).map((row) => row.clientId),
          readTree(wp, expected).map((row) => row.clientId),
        ),
        'prepared_content_changed',
      );
    }
  };

  try {
    for (const step of plan.steps) {
      const live = documentBlocks(wp);
      const rows = readTree(wp, live);
      matches(step.before);

      for (const check of dateGuards) {
        check();
      }

      await policy(
        wp,
        live,
        step.edit,
        step.blocks,
        new Set(rows.map((row) => row.clientId)),
        initialize ? budget : undefined,
      );
      matches(step.before);
      const edit = step.edit;

      if (initialize) {
        assert(Date.now() < budget.deadline, 'native_initialization_unsettled');
      }

      const checkQuery = await prepareQueryNormalization(
        wp,
        step.before,
        step.after,
        step.edit.op === 'move'
          ? readTree(wp, stepTargets(step)).map((row) => row.block)
          : stepTargets(step),
        originalIds,
        completedEdits,
      );
      matches(step.before);
      checkQuery();
      checkPatternSpacers(wp, plan, documentBlocks(wp));

      if (step.comments) {
        checkEmptyComments(wp, plan.target, step.comments, true);
      }

      for (const check of dateGuards) {
        check();
      }

      const dispatch = () => {
        checkpoint(step.before, step.after);
        beforeMutation();
        dispatchedEdits++;
      };

      if (!(edit.op === 'remove' && !step.after.length)) {
        dispatch();
      }

      // Planning read the reference moments ago in this call. Reading it again
      // here would leave an await between the guards above and the write.
      if (
        edit.op === 'update_reference' ||
        edit.op === 'update' ||
        edit.op === 'update_style' ||
        edit.op === 'set_block_style'
      ) {
        await actions.updateBlockAttributes(
          at(live, edit.path).clientId,
          copyAttributes(step.update!),
        );
      } else if (edit.op === 'move') {
        const block = at(live, edit.path);
        const destination = children(step.before, edit.parent);

        const index =
          edit.index ?? destination.length - (same(edit.parent, edit.path.slice(0, -1)) ? 1 : 0);

        await actions.moveBlocksToPosition(
          [block.clientId],
          parent_id(wp, live, edit.path.slice(0, -1)),
          parent_id(wp, live, edit.parent),
          index,
        );
      } else if ('parent' in edit) {
        await actions.insertBlocks(
          copyTree(step.blocks),
          edit.index ?? children(live, edit.parent).length,
          parent_id(wp, live, edit.parent),
          false,
        );
      } else if (edit.op === 'remove') {
        if (step.after.length) {
          await actions.removeBlocks([at(live, edit.path).clientId], false);
        } else {
          // removeBlocks recreates a default block when the document becomes empty.
          // The removal policy passed above; reset keeps this planned empty state.
          await resetDocument(wp, [], () => matches(step.before), dispatch);
        }
      } else if (edit.op === 'replace') {
        await actions.replaceBlocks([at(live, edit.path).clientId], copyTree(step.blocks), null);
      }

      if (initialize) {
        await withinInitialization(settle, budget);
      } else {
        await settle();
      }

      const targets = stepTargets(step);

      if (initialize && targets.length) {
        const hiddenQueryDescendants = new Set<string>();

        if (['update', 'update_style', 'set_block_style'].includes(step.edit.op)) {
          for (const target of targets) {
            if (target.name !== 'core/query' || !originalIds.has(target.clientId)) {
              continue;
            }

            for (const row of readTree(wp, target.innerBlocks ?? [])) {
              if (originalIds.has(row.clientId)) {
                hiddenQueryDescendants.add(row.clientId);
                affected.delete(row.clientId);
              }
            }
          }
        }

        const targetRows = readTree(wp, targets).filter(
          (row) => !hiddenQueryDescendants.has(row.clientId) && !hiddenComments.has(row.clientId),
        );

        for (const row of targetRows) {
          affected.add(row.clientId);
        }

        if (step === plan.steps.at(-1)) {
          await settleInitialization(
            wp,
            step.after,
            exactIds,
            affected,
            budget,
            retainMissingSelection,
            () => {
              for (const check of dateGuards) {
                check();
              }
            },
          );
        } else {
          // Intermediate containers must mount and refresh insertion policies.
          // Defer leaf initialization and the quiet interval to the final tree;
          // later edits may replace these descendants entirely.
          const containers = new Set(
            targetRows.flatMap((row) => (row.block.innerBlocks?.length ? [row.clientId] : [])),
          );
          await renderAffected(wp, containers, budget, retainMissingSelection, () => {
            for (const check of dateGuards) {
              check();
            }
          });
          checkInitialized(wp, step.after, documentBlocks(wp), exactIds);
        }
      }

      await requireContexts(
        wp,
        readTree(wp, step.blocks).flatMap((row) =>
          row.block.innerBlocks?.some((child) => !step.comments?.hidden.has(child.clientId))
            ? [row.clientId]
            : [],
        ),
        initialize ? budget : undefined,
        () => {
          for (const check of dateGuards) {
            check();
          }
        },
      );

      // New parents only acquire their contextual allowed-block lists after
      // insertion. Like native paste, nested children are not checked against
      // template locks; a locked template that disagrees resyncs natively and
      // fails the initialization check instead.
      for (const block of step.blocks) {
        const checkChildren = (parent: Block): void => {
          for (const child of parent.innerBlocks ?? []) {
            if (step.comments?.hidden.has(child.clientId)) {
              continue;
            }

            const settings = store.getBlockListSettings?.(parent.clientId);
            assert(settings, 'native_insertion_context_unavailable');
            const details = { block_name: child.name, parent_name: parent.name };
            const allowed = settings.allowedBlocks;
            const admitted = Array.isArray(allowed) && allowed.includes(child.name);
            assert(!Array.isArray(allowed) || admitted, 'insertion_refused', {
              ...details,
              constraint: 'parent_allowed_blocks',
            });
            const parents = wp.blocks.getBlockType(child.name)?.parent;
            assert(
              !parents ||
                admitted ||
                parents.includes(parent.name) ||
                wp.blocks.getBlockType(parent.name)?.allowedBlocks?.includes(child.name),
              'insertion_refused',
              { ...details, constraint: 'block_parent' },
            );
            checkChildren(child);
          }
        };

        checkChildren(block);
      }

      if (step.comments) {
        checkEmptyComments(wp, plan.target, step.comments);
      }

      matches(step.after);
      checkpoint(documentBlocks(wp));
      completedEdits++;
      budget.progress();
    }

    if (initialize) {
      const last = plan.steps.at(-1)!;

      // A final insert or attribute edit already settled the complete affected
      // set. Its policy and tree checks above run before freezing that result.
      if (
        !(
          last.blocks.length || ['update', 'update_style', 'set_block_style'].includes(last.edit.op)
        )
      ) {
        await settleInitialization(
          wp,
          plan.blocks,
          exactIds,
          affected,
          budget,
          retainMissingSelection,
          () => {
            for (const check of dateGuards) {
              check();
            }
          },
        );
      }

      checkPatternSpacers(wp, plan, documentBlocks(wp), true);
      checkpoint(documentBlocks(wp));
      plan.blocks = copyTree(documentBlocks(wp));
    }
  } catch (error) {
    if (error instanceof BlockworkError) {
      const step = plan.steps[Math.min(completedEdits, plan.steps.length - 1)];
      const timing = initialize ? budget.diagnostics() : undefined;

      throw new BlockworkError(error.code, {
        stage: 'apply_plan',
        ...timing,
        completed_edits: completedEdits,
        dispatched_edits: dispatchedEdits,
        edit_count: plan.steps.length,
        edit_index: Math.min(completedEdits, plan.steps.length - 1),
        edit_operation: step.edit.op,
        target_path: 'path' in step.edit ? step.edit.path : step.edit.parent,
        affected: readTree(wp, step.after)
          .flatMap((row) =>
            affected.has(row.clientId)
              ? [{ client_id: row.clientId, path: row.path, name: row.name }]
              : [],
          )
          .slice(0, 20),
        affected_truncated: affected.size > 20,
        ...error.diagnostics,
      });
    }

    throw error;
  }
}

// Parse authored markup through the site's registrations. Each top-level
// block becomes one tree input; invalid or unsupported markup refuses.
export function markupBlocks(
  wp: WordPress,
  markup: string,
  purpose: 'read' | 'create',
): BlockInput[] {
  const parsed = wp.blocks.parse(markup);
  assert(parsed.length > 0, 'unsupported_markup');
  const parsedRows = readTree(wp, parsed);
  assert(validity(parsedRows).valid, 'unsupported_markup', {
    invalid: validity(parsedRows).invalid.slice(0, 5),
    unsupported: validity(parsedRows).unsupported.slice(0, 5),
  });
  const convert = purpose === 'create' ? parsedBlockInput : blockInput;
  const inputs = parsed.map((block) => convert(wp, block));
  assert(
    inputs.every((block) => v.is(BlockInputSchema, block)),
    'unsupported_markup',
  );

  return inputs;
}
