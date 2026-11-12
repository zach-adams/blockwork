import * as v from 'valibot';
import { styleRules, style_guide } from './styling';
import type { StyleCatalog } from './styling';
import { JsonObjectSchema, JsonSchema } from './contracts';
import type { BlockSummary, JsonObject, JsonValue, ReadOptions } from './contracts';
import type { Attribute, Block, WordPress } from './wordpress';
import { guidelines, patterns, styles, variations } from './catalog';
import { documentRoot } from './document-view';
import { escapeBareAmpersands, escapeBareLessThan, same, stored } from './values';
import { BlockworkError, accessFailure, blockMismatches, diagnosticKey } from './errors';
import { debugDetails } from './debug';

// Only this exact native binding is supported for ordinary block operations.
export function postDateField(
  block: Pick<Block, 'name' | 'attributes'>,
): 'date' | 'modified' | undefined {
  const metadata = block.attributes.metadata;
  const bindings = v.is(JsonObjectSchema, metadata) ? metadata.bindings : undefined;
  const binding = v.is(JsonObjectSchema, bindings) ? bindings.datetime : undefined;
  const args = v.is(JsonObjectSchema, binding) ? binding.args : undefined;

  if (
    block.name === 'core/post-date' &&
    v.is(JsonObjectSchema, bindings) &&
    Object.keys(bindings).length === 1 &&
    v.is(JsonObjectSchema, binding) &&
    Object.keys(binding).length === 2 &&
    binding.source === 'core/post-data' &&
    v.is(JsonObjectSchema, args) &&
    Object.keys(args).length === 1 &&
    (args.field === 'date' || args.field === 'modified')
  ) {
    return args.field;
  }
}

export function unsupportedBinding(block: Pick<Block, 'name' | 'attributes'>): boolean {
  const metadata = block.attributes.metadata;

  return v.is(JsonObjectSchema, metadata) && Boolean(metadata.bindings) && !postDateField(block);
}

export function sharedReference(block: Block): boolean {
  return (
    ['core/block', 'core/template-part'].includes(block.name) ||
    (block.name === 'core/navigation' && Boolean(block.attributes.ref))
  );
}

export function requireCondition<T>(
  condition: T,
  code: string,
  diagnostics?: JsonObject,
): asserts condition {
  if (!condition) {
    throw new BlockworkError(code, diagnostics);
  }
}

export function containsPath(parent: number[], child: number[]): boolean {
  return parent.length <= child.length && parent.every((index, offset) => index === child[offset]);
}

// Applies convert to each rich-text value an attribute holds. Query sources
// can nest rich text inside arrays, as Table does for cells; follow the
// registration so other objects keep their validation behavior.
function mapRichText(
  value: JsonValue | undefined,
  schema: Attribute | undefined,
  convert: (text: JsonValue | undefined) => JsonValue | undefined,
): JsonValue | undefined {
  if (schema?.type === 'rich-text') {
    return convert(value);
  }

  if (schema?.source === 'query' && Array.isArray(value)) {
    return value.map((entry) => {
      if (!v.is(JsonObjectSchema, entry)) {
        return entry;
      }

      const attributes = Object.entries(entry).map(([name, nested]) => [
        name,
        mapRichText(nested, schema.query?.[name], convert),
      ]);

      return Object.fromEntries(attributes);
    });
  }

  return value;
}

// Gutenberg creation and DOM parsing spell the same text differently: a parsed
// block keeps the browser's innerHTML, with &gt;, &nbsp;, and decoded entities.
// Comparing that spelling lets a new block and its parsed form match.
function parsedSpelling(html: string): string {
  if (!/[&<>\u00a0]/.test(html)) {
    return html;
  }

  const template = document.createElement('template');
  template.innerHTML = html;

  return template.innerHTML;
}

// Unset rich text parses back as empty, so the two compare the same.
function nativeAttribute(value: JsonValue | undefined, schema?: Attribute): JsonValue | undefined {
  return mapRichText(value, schema, (text) =>
    text === undefined ? '' : parsedSpelling(String(text)),
  );
}

// Rich text is HTML, so a bare & or < in requested text is literal. Escape them
// as the editor does; entities and complete tags stay as written.
export function richTextInput(
  value: JsonValue | undefined,
  schema?: Attribute,
): JsonValue | undefined {
  return mapRichText(value, schema, (text) =>
    typeof text === 'string' ? escapeBareLessThan(escapeBareAmpersands(text)) : text,
  );
}

export function readTree(
  wp: WordPress,
  list: Block[],
  parent: number[] = [],
  output: BlockSummary[] = [],
): BlockSummary[] {
  requireCondition(parent.length < 16, 'tree_too_deep');

  for (const [index, block] of list.entries()) {
    requireCondition(output.length < 2000, 'too_many_blocks');
    const registration = wp.blocks.getBlockType(block.name);
    let reason = '';
    let support: BlockSummary['support'] = 'supported';

    if (!registration || block.name === 'core/missing') {
      reason = 'missing_registration';
      support = 'unsupported';
    } else if (block.isValid === false) {
      reason = 'invalid_block';
      support = 'invalid';
    } else if (['core/freeform', 'core/html'].includes(block.name)) {
      reason = 'raw_content';
      support = 'unsupported';
    }

    const attributes = Object.fromEntries(
      Object.entries(block.attributes).map(([name, value]) => [
        name,
        nativeAttribute(value, registration?.attributes?.[name]),
      ]),
    );

    requireCondition(v.is(JsonObjectSchema, attributes), 'unsupported_block');
    output.push({
      path: [...parent, index],
      name: block.name,
      attributes,
      clientId: block.clientId,
      block,
      support,
      reason,
    });

    // Shared entity children belong to another document and must never become
    // paths in this one. Referenced content is edited by its own exact target.
    if (!sharedReference(block)) {
      readTree(wp, block.innerBlocks || [], [...parent, index], output);
    }
  }

  return output;
}

export function blockState(rows: BlockSummary[]) {
  return rows.map(({ path, name, attributes, support, reason }) => ({
    path,
    name,
    attributes,
    support,
    reason,
  }));
}

export function refuseAmbiguousUnion(wp: WordPress, rows: BlockSummary[]): void {
  for (const row of rows) {
    const attributes = wp.blocks.getBlockType(row.name)?.attributes ?? {};

    for (const [name, value] of Object.entries(row.attributes)) {
      const type = attributes[name]?.type;

      if (
        Array.isArray(value) &&
        Array.isArray(type) &&
        type.includes('object') &&
        type.includes('array')
      ) {
        throw new BlockworkError('ambiguous_union_attribute', {
          path: row.path,
          attribute: diagnosticKey(name),
        });
      }
    }
  }
}

function storedRows(wp: WordPress, rows: BlockSummary[]): BlockSummary[] {
  return rows.map((row) => ({
    ...row,
    attributes: Object.fromEntries(
      Object.entries(row.attributes).map(([key, value]) => [
        key,
        stored(value, wp.blocks.getBlockType(row.name)?.attributes?.[key]),
      ]),
    ),
  }));
}

function storedMarkup(row: BlockSummary): JsonValue {
  const markup = row.block.originalContent ?? '';

  if (row.support !== 'supported') {
    return markup || null;
  }

  if (!/<pre(?:\s|>)/i.test(markup)) {
    return null;
  }

  const template = document.createElement('template');
  template.innerHTML = markup;

  return Array.from(template.content.querySelectorAll('pre'), (element) => element.textContent);
}

export function storedState(wp: WordPress, rows: BlockSummary[]) {
  return blockState(storedRows(wp, rows)).map((state, index) => ({
    ...state,
    original: storedMarkup(rows[index]),
  }));
}

export function storedMismatches(wp: WordPress, expected: BlockSummary[], actual: BlockSummary[]) {
  const found = blockMismatches(storedRows(wp, expected), storedRows(wp, actual));
  const rewritten = expected.flatMap((row, index) => {
    const other = actual[index];

    return other && same(row.path, other.path) && !same(storedMarkup(row), storedMarkup(other))
      ? [{ path: row.path, properties: ['original_markup'], truncated: false }]
      : [];
  });

  return { blocks: [...found.blocks, ...rewritten].slice(0, 20), truncated: found.truncated };
}

export function validity(rows: BlockSummary[]) {
  const issue = ({ path, name, reason }: BlockSummary) => ({ path, name, reason });

  return {
    valid: rows.every((row) => row.support === 'supported'),
    unsupported: rows.flatMap((row) => (row.support === 'unsupported' ? [issue(row)] : [])),
    invalid: rows.flatMap((row) => (row.support === 'invalid' ? [issue(row)] : [])),
  };
}

export interface EditRestriction extends JsonObject {
  reason: string;
  section_client_id?: string;
  editing_mode?: string;
}

// Gutenberg treats an unsynced pattern (one with metadata.patternName) as a
// section whose blocks allow only content changes until the toolbar's Edit
// pattern opens it. Template parts and synced patterns never reach these rows.
function patternSection(row: BlockSummary, rows: BlockSummary[]): BlockSummary | undefined {
  return rows.find((other) => {
    const metadata = other.attributes.metadata;

    return (
      other.path.length < row.path.length &&
      containsPath(other.path, row.path) &&
      v.is(JsonObjectSchema, metadata) &&
      Boolean(metadata.patternName)
    );
  });
}

// Why a block cannot be edited, with reason '' when it can.
export function editRestriction(
  wp: WordPress,
  row: BlockSummary,
  rows: BlockSummary[],
): EditRestriction {
  const store = wp.data.select('core/block-editor');

  if (row.support !== 'supported') {
    return { reason: row.reason };
  }

  const blockedByTree = rows.some((other) => {
    if (other.support === 'invalid') {
      return true;
    }

    if (other.support !== 'unsupported') {
      return false;
    }

    return containsPath(other.path, row.path) || containsPath(row.path, other.path);
  });

  if (blockedByTree) {
    return { reason: 'unsupported_subtree' };
  }

  if (unsupportedBinding(row)) {
    return { reason: 'bound_attributes' };
  }

  if (!store.canEditBlock(row.clientId)) {
    return { reason: 'block_locked' };
  }

  return editingMode(wp, row, rows);
}

// Gutenberg's editing mode for the block, explained.
export function editingMode(
  wp: WordPress,
  row: BlockSummary,
  rows: BlockSummary[],
): EditRestriction {
  const mode = wp.data.select('core/block-editor').getBlockEditingMode(row.clientId);

  // Section editing relaxes native modes, but an author's template lock still
  // limits descendants to content attributes. A disabled native mode stays disabled.
  const contentOnlyTemplate = rows.some(
    (other) =>
      other.path.length < row.path.length &&
      containsPath(other.path, row.path) &&
      other.attributes.templateLock === 'contentOnly',
  );

  if (contentOnlyTemplate) {
    return { reason: 'content_only', editing_mode: mode };
  }

  if (mode === 'default') {
    return { reason: '' };
  }

  const section = patternSection(row, rows);

  if (section) {
    return { reason: 'pattern_section', section_client_id: section.clientId, editing_mode: mode };
  }

  return {
    reason: mode === 'contentOnly' ? 'content_only' : 'editing_disabled',
    editing_mode: mode,
  };
}

export function editable(wp: WordPress, row: BlockSummary, rows: BlockSummary[]): boolean {
  return editRestriction(wp, row, rows).reason === '';
}

// Editing a section disables its outer ancestors. Only the destination's own
// mode governs its children; explicit ancestor template locks still apply.
export function containerRestriction(
  wp: WordPress,
  ancestors: Block[],
  rows: BlockSummary[],
  mode: 'insert' | 'remove' | 'move',
): EditRestriction {
  const store = wp.data.select('core/block-editor');

  if (!store.getTemplateLock) {
    return { reason: 'native_insertion_policy_unavailable' };
  }

  // As in native list settings, the nearest explicit lock governs and false lifts
  // an outer one. Only contentOnly always reaches its descendants.
  const locks = ancestors.map((block) => block.attributes.templateLock);
  const nearestLock = locks.filter((lock) => lock !== undefined).at(-1);

  if (
    locks.includes('contentOnly') ||
    nearestLock === 'all' ||
    (nearestLock === 'insert' && mode !== 'move')
  ) {
    return { reason: 'template_locked' };
  }

  const parent = ancestors.at(-1);
  const row = rows.find((item) => item.clientId === parent?.clientId);

  if (row) {
    const restriction = editingMode(wp, row, rows);

    if (restriction.reason) {
      return restriction;
    }
  }

  const id = parent?.clientId ?? documentRoot(wp)?.clientId;
  const lock = parent && !row ? false : store.getTemplateLock(id);

  return { reason: lock && !(lock === 'insert' && mode === 'move') ? 'template_locked' : '' };
}

export function removalRestriction(
  wp: WordPress,
  row: BlockSummary,
  rows: BlockSummary[],
): EditRestriction {
  if (rows.some((other) => other.support !== 'supported')) {
    return { reason: 'unsupported_structural_edit' };
  }

  const ancestors = rows.filter(
    (other) => other.path.length < row.path.length && containsPath(other.path, row.path),
  );
  const container = containerRestriction(
    wp,
    ancestors.map((other) => other.block),
    rows,
    'remove',
  );

  if (container.reason) {
    return container;
  }

  if (rows.some((other) => containsPath(row.path, other.path) && unsupportedBinding(other))) {
    return { reason: 'bound_block_unsupported' };
  }

  const mode = editingMode(wp, row, rows);

  if (mode.reason) {
    return mode;
  }

  const lock = row.attributes.lock;
  const removable =
    (!v.is(JsonObjectSchema, lock) || !lock.remove) &&
    wp.data.select('core/block-editor').canRemoveBlocks?.([row.clientId]) === true;

  return { reason: removable ? '' : 'block_locked' };
}

// Text as a reader sees it: tags stripped before entities decode, so escaped
// markup stays visible, and any whitespace run, including NBSP, is one space.
export function textFor(wp: WordPress, row: BlockSummary): string {
  const metadata = row.attributes.metadata;
  const richText: Array<JsonValue | undefined> = [];

  for (const [key, schema] of Object.entries(wp.blocks.getBlockType(row.name)?.attributes ?? {})) {
    mapRichText(row.attributes[key], schema, (text) => {
      richText.push(text);

      return text;
    });
  }

  const values = [
    row.name,
    v.is(JsonObjectSchema, metadata) ? metadata.name : '',
    row.attributes.anchor,
    ...['content', 'text', 'caption', 'title', 'label', 'alt'].map((key) => row.attributes[key]),
    ...richText,
  ];
  const text = [...new Set(values)]
    .flatMap((value) => (typeof value === 'string' ? [value] : []))
    .join(' ')
    .replace(/<[^>]*>/g, ' ');

  return wp.htmlEntities.decodeEntities(text).replace(/\s+/g, ' ');
}

// Label and visible text without the block name, for compact outlines.
export function previewFor(wp: WordPress, row: BlockSummary, length: number): string | undefined {
  const text = textFor(wp, row).slice(row.name.length).trim();

  return text ? text.slice(0, length) : undefined;
}

// Read selectors and guides name live blocks by client ID. Paths in results
// describe the current tree only and shift after structural edits.
export interface MediaReference extends JsonObject {
  id: number;
  url: string;
  paths: Array<{ path: number[]; name: string; attribute: string }>;
}

const attachmentId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

// Attachments a subtree references: any attribute object that holds a positive
// id with a file URL beside it, such as an Image's id and url, Media & Text's
// mediaId and mediaUrl, or a background image. Only URLs inside an uploads
// directory count, so a link's post ID and permalink do not. Every occurrence
// is listed, because a copy rewrites exactly these; the inspection size limit
// refuses a list too large to return.
function mediaReferences(rows: BlockSummary[]): MediaReference[] {
  const found = new Map<number, MediaReference>();

  const visit = (row: BlockSummary, value: JsonValue | undefined, at: string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(row, item, [...at, String(index)]));

      return;
    }

    if (!v.is(JsonObjectSchema, value)) {
      return;
    }

    for (const [key, item] of Object.entries(value)) {
      const prefix = key.endsWith('Id') ? key.slice(0, -2) : undefined;
      const urlKeys = key === 'id' ? ['url', 'src', 'href'] : [`${prefix}Url`, `${prefix}Src`];
      const url = urlKeys
        .map((name) => value[name])
        .find((candidate) => typeof candidate === 'string' && candidate.includes('/uploads/'));

      if ((key === 'id' || prefix) && v.is(attachmentId, item) && typeof url === 'string') {
        const reference = found.get(item) ?? { id: item, url, paths: [] };
        found.set(item, reference);

        reference.paths.push({ path: row.path, name: row.name, attribute: [...at, key].join('.') });
      }

      visit(row, item, [...at, key]);
    }
  };

  for (const row of rows) {
    visit(row, row.attributes, []);
  }

  return [...found.values()];
}

export function liveRow(rows: BlockSummary[], clientId: string, field: string): BlockSummary {
  const matches = rows.filter((row) => row.clientId === clientId);
  requireCondition(matches.length === 1, 'block_identity_missing', {
    field,
    selector_field: 'client_id',
    matches: matches.length,
    constraint: 'one_current_block',
  });

  return matches[0];
}

// core/table is exact, table or wp:table matches in any namespace, and * is a
// wildcard, as in core/* or *accordion*.
function blockNamePattern(names: string | string[]): RegExp {
  const patterns = [names].flat().map((name) => {
    const pattern = name
      .replace(/^wp:/i, '')
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*+/g, '.*');

    return name.includes('/') ? pattern : `(?:[^/]+/)?${pattern}`;
  });

  return new RegExp(`^(?:${patterns.join('|')})$`, 'i');
}

// live is false for a saved source document, whose blocks are not in this
// editor and so have no native editing state.
export async function projectInspection(
  wp: WordPress,
  rows: BlockSummary[],
  options: Omit<ReadOptions, 'operation' | 'target' | 'request_id' | 'source'>,
  live = true,
): Promise<JsonObject> {
  const selector = options.blocks;
  const scopeRow =
    typeof selector !== 'string' && 'client_id' in selector && selector.client_id
      ? liveRow(rows, selector.client_id, 'blocks.client_id')
      : undefined;
  const scope = scopeRow?.path ?? [];
  const limit = typeof selector === 'string' ? 60 : Math.min(selector.limit, 50);
  const depth = typeof selector !== 'string' && 'depth' in selector ? selector.depth : undefined;
  const maxDepth = depth === undefined ? undefined : Math.min(depth, 8);
  const clamped: JsonObject = {};

  if (typeof selector !== 'string' && selector.limit > 50) {
    clamped.limit = 50;
  }

  if (depth !== undefined && depth > 8) {
    clamped.depth = 8;
  }

  const names =
    typeof selector !== 'string' && 'name' in selector && selector.name
      ? blockNamePattern(selector.name)
      : undefined;
  const selected = rows.filter((row) => {
    if (selector === 'roots') {
      return row.path.length === 1;
    }

    if (selector === 'all') {
      return true;
    }

    if (!containsPath(scope, row.path)) {
      return false;
    }

    if ('search' in selector || 'name' in selector) {
      return (
        (!names || names.test(row.name)) &&
        (!selector.search ||
          textFor(wp, row)
            .toLowerCase()
            .includes(selector.search.replace(/\s+/g, ' ').toLowerCase()))
      );
    }

    return row.path.length - scope.length <= (maxDepth ?? 0);
  });

  const detailed =
    typeof selector !== 'string' &&
    (!('search' in selector || 'name' in selector) || selector.attributes);

  const blocks = await Promise.all(
    selected.slice(0, limit).map(async (row) => {
      const restriction = live ? editRestriction(wp, row, rows) : undefined;
      const removal = live ? removalRestriction(wp, row, rows) : undefined;
      const result: JsonObject = {
        path: row.path,
        name: row.name,
        client_id: row.clientId,
        preview: previewFor(wp, row, 160),
        child_count: sharedReference(row.block) ? 0 : (row.block.innerBlocks?.length ?? 0),
        support: row.support,
        reason: restriction?.reason ?? row.reason,
        section_client_id: restriction?.section_client_id,
        editing_mode: restriction?.editing_mode,
        editable: restriction ? restriction.reason === '' : undefined,
        removable: removal ? removal.reason === '' : undefined,
        removal_restriction: removal?.reason ? removal : undefined,
      };

      if (detailed) {
        result.attributes = row.attributes;
      }

      return result;
    }),
  );

  const selection: JsonObject = {
    total: selected.length,
    returned: blocks.length,
    truncated: selected.length > limit,
  };

  // Descendants below the depth bound were left out.
  if (maxDepth !== undefined) {
    selection.depth_limited = rows.some(
      (row) => containsPath(scope, row.path) && row.path.length - scope.length > maxDepth,
    );
  }

  if (Object.keys(clamped).length) {
    selection.clamped = clamped;
  }

  const result: JsonObject = {
    blocks,
    selection,
    block_count: rows.length,
    validity: validity(rows),
  };

  if (scopeRow && typeof selector !== 'string' && 'markup' in selector && selector.markup) {
    result.markup = wp.blocks.serialize([scopeRow.block]);
  }

  if (scopeRow && typeof selector !== 'string' && 'media' in selector && selector.media) {
    result.media = mediaReferences(rows.filter((row) => containsPath(scopeRow.path, row.path)));
  }

  const guide = options.attribute_guide;

  if (options.style_guides) {
    const guides: JsonObject[] = [];
    const catalogs: StyleCatalog[] = [];
    const hasCSS = rows.some(
      (item) => v.is(JsonObjectSchema, item.attributes.style) && Boolean(item.attributes.style.css),
    );

    for (const [guideIndex, guide] of options.style_guides.entries()) {
      const row =
        'client_id' in guide
          ? liveRow(rows, guide.client_id, `style_guides.${guideIndex}.client_id`)
          : undefined;
      const name = 'name' in guide ? guide.name : row!.name;
      requireCondition(wp.blocks.getBlockType(name), 'unregistered_block', {
        field: `style_guides.${guideIndex}.${'name' in guide ? 'name' : 'client_id'}`,
        block_name: name,
      });
      const parent = row && rows.find((item) => same(item.path, row.path.slice(0, -1)));
      const styling = await style_guide(
        wp,
        row?.block ?? { name, attributes: {} },
        catalogs,
        parent?.block,
        guide.properties,
      );
      guides.push({
        ...styling,
        existing: row ? styling.existing : null,
        guide_index: guideIndex,
        source: row ? 'live_block' : 'registration',
        client_id: row?.clientId,
        editable: row ? editable(wp, row, rows) : undefined,
      });
    }

    result.style_guides = guides;
    result.style_catalogs = catalogs;
    result.style_rules = styleRules(wp, hasCSS);
  }

  if (guide) {
    const row =
      'client_id' in guide
        ? liveRow(rows, guide.client_id, 'attribute_guide.client_id')
        : undefined;
    const name = 'name' in guide ? guide.name : row!.name;
    const registration = wp.blocks.getBlockType(name);
    const attributes: JsonObject[] = [];

    for (const [key, attribute] of Object.entries(registration?.attributes ?? {}).slice(0, 200)) {
      const types = Array.isArray(attribute.type) ? attribute.type : [attribute.type ?? ''];
      const supportedTypes = types.every((type) =>
        ['string', 'rich-text', 'boolean', 'integer', 'number', 'object', 'array', 'null'].includes(
          type,
        ),
      );
      const protectedAttribute = [
        '__proto__',
        'constructor',
        'prototype',
        'metadata',
        'lock',
        'templateLock',
      ].includes(key);
      const sharedEntityAttribute =
        ['core/block', 'core/navigation', 'core/template-part'].includes(name) &&
        ['ref', 'slug', 'theme', 'area'].includes(key);

      const item: JsonObject = {
        name: key,
        editable:
          supportedTypes &&
          !protectedAttribute &&
          !sharedEntityAttribute &&
          attribute.source !== 'meta' &&
          !(row && postDateField(row) && key === 'datetime'),
      };

      if (attribute.source === 'meta') {
        if (typeof attribute.meta === 'string') {
          item.meta_key = attribute.meta;
        }

        item.use_instead =
          'Read settings: true for the writable REST meta contract, then edit settings.meta with only supplied keys. A registration meta key alone does not establish REST writability.';
      }

      for (const field of [
        'type',
        'enum',
        'default',
        'source',
        'selector',
        'attribute',
        'role',
      ] as const) {
        if (attribute[field] !== undefined && v.is(JsonSchema, attribute[field])) {
          item[field] = attribute[field];
        }
      }

      attributes.push(item);
    }

    result.attribute_guide = {
      name,
      registered: Boolean(registration),
      attributes,
      truncated: Object.keys(registration?.attributes ?? {}).length > 200,
    };

    if (registration && wp.data.select('core/blocks')?.getBlockStyles) {
      result.attribute_guide.styles = await styles(wp, name);
    }

    if (registration && wp.blocks.getBlockVariations) {
      result.attribute_guide.variations = (await variations(wp, name)).map(
        ({ name: variation, title }) => ({ name: variation, title: title ?? variation }),
      );
    }

    if (row) {
      result.attribute_guide.editable = editable(wp, row, rows);
    }
  }

  if (options.insertion) {
    const parentId = options.insertion.parent_client_id;
    const parent = parentId ? liveRow(rows, parentId, 'insertion.parent_client_id') : undefined;
    const store = wp.data.select('core/block-editor');
    const parent_id = parent?.clientId ?? documentRoot(wp)?.clientId;

    if (parent && sharedReference(parent.block)) {
      result.insertion = {
        available: false,
        parent_client_id: parentId,
        reason: 'shared_descendant_not_editable',
      };
    } else if (!store.getInserterItems || !store.canInsertBlockType || !store.getTemplateLock) {
      result.insertion = { available: false, reason: 'native_insertion_policy_unavailable' };
    } else if (parent_id && !store.getBlockListSettings?.(parent_id)) {
      result.insertion = {
        available: false,
        parent_client_id: parentId,
        reason: 'native_insertion_context_unavailable',
      };
    } else {
      const lock = store.getTemplateLock(parent_id);
      const items = store.getInserterItems(parent_id);
      result.insertion = {
        available: true,
        parent_client_id: parentId,
        template_lock: lock || false,
        items: items
          .filter((item, index) => items.findIndex((other) => other.name === item.name) === index)
          .slice(0, 200)
          .map((item) => ({
            name: item.name,
            title: item.title?.slice(0, 200) ?? item.name,
            allowed: !lock && !item.isDisabled && store.canInsertBlockType!(item.name, parent_id),
          })),
        truncated: items.length > 200,
      };
    }
  }

  if (options.patterns) {
    try {
      result.patterns = {
        available: true,
        items: (await patterns(wp)).map(({ name, title }) => ({ name, title })),
        insertion_checked: false,
      };
    } catch (error) {
      result.patterns = {
        available: false,
        reason: 'native_patterns_unavailable',
        debug: debugDetails(error),
      };
    }
  }

  if (options.guidelines) {
    try {
      result.guidelines = await guidelines(wp);
    } catch (error) {
      // An ended session or a timeout fails the read with its own recovery.
      if (
        accessFailure(error)?.error === 'reauthorization_required' ||
        (error instanceof BlockworkError && error.code === 'request_timeout')
      ) {
        throw error;
      }

      result.guidelines = {
        available: false,
        reason: 'native_guidelines_unavailable',
        debug: debugDetails(error),
      };
    }
  }

  const responseBytes = new TextEncoder().encode(JSON.stringify(result)).length;

  if (responseBytes > 64 * 1024) {
    const sectionBytes = Object.fromEntries(
      Object.entries(result).map(([key, value]) => [
        key,
        new TextEncoder().encode(JSON.stringify(value)).length,
      ]),
    );
    throw new BlockworkError('inspection_too_large', {
      stage: 'inspection_response',
      response_bytes: responseBytes,
      max_bytes: 64 * 1024,
      section_bytes: sectionBytes,
      guide_bytes: Array.isArray(result.style_guides)
        ? result.style_guides.map((guide, guide_index) => ({
            guide_index,
            bytes: new TextEncoder().encode(JSON.stringify(guide)).length,
          }))
        : [],
    });
  }

  return result;
}

// Theme and plugin blocks to consider before composing the same thing from
// core blocks. Child-only blocks name the blocks they belong inside.
export function customBlocks(wp: WordPress): JsonObject[] {
  return wp.blocks
    .getBlockTypes()
    .filter((type) => !type.name.startsWith('core/') && type.supports?.inserter !== false)
    .slice(0, 150)
    .map((type) => ({
      name: type.name,
      title: type.title?.slice(0, 80) ?? type.name,
      description: type.description?.slice(0, 120) || undefined,
      inside: type.parent ?? type.ancestor,
    }));
}
