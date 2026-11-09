import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { BlockInput, JsonObject, JsonValue, Observed, RequestedEdit } from './contracts';
import type { Block, FootnoteRichText, RichTextReplacement, WordPress } from './wordpress';
import type { Plan } from './edits';
import { authorizeFootnotePlan, roundTripMatches } from './edits';
import { documentBlocks } from './document-view';
import { readTree, requireCondition as assert, validity } from './inspection';
import { BlockworkError, diagnosticKey, serializationDiagnostics } from './errors';
import { same } from './values';

interface FootnoteBody extends JsonObject {
  id: string;
  content: string;
}

export interface FootnoteCompanion {
  client_id: string;
  path: number[];
  content: string;
}

export interface StructuralFootnotes {
  blocks: Block[];
  footnotes: string;
  companions: FootnoteCompanion[];
  dependencies: string[];
  footnote_writes: JsonObject;
}

const bodiesSchema = v.array(v.strictObject({ id: v.string(), content: v.string() }));
const repair =
  'Read source paragraph markup and settings.values.meta.footnotes, then read destination settings. Submit the markup, a root Footnotes block if needed, and the complete final settings.meta.footnotes list.';

function bodies(value: string, constraint = 'footnote_body_list'): FootnoteBody[] {
  try {
    return v.parse(bodiesSchema, JSON.parse(value || '[]'));
  } catch (cause) {
    const next =
      constraint === 'footnote_body_list'
        ? repair
        : 'Supply all bodies in reference order as a JSON string.';
    throw new BlockworkError(
      'unsupported_structural_edit',
      { field: 'settings.meta.footnotes', constraint, next_step: next },
      { cause },
    );
  }
}

function hasReferences(wp: WordPress, blocks: Block[]): boolean {
  return readTree(wp, blocks).some(
    (row) => row.name === 'core/paragraph' && paragraphReferences(wp, row.attributes.content),
  );
}

// shortcut: raw HTML blocks can contain replacements that core's block traversal ignores.
function footnoteReferences(wp: WordPress, html: string): RichTextReplacement[] {
  if (!html.includes('data-fn')) {
    return [];
  }

  assert(wp.richText, 'native_readiness_unavailable', {
    capability: 'richText.create/toHTMLString',
  });

  return wp.richText
    .create({ html })
    .replacements.filter((item): item is RichTextReplacement => item?.type === 'core/footnote');
}

function referenceId(reference: RichTextReplacement): string {
  return reference.attributes?.['data-fn'] ?? '';
}

function referenceIds(wp: WordPress, html: string): string[] {
  return footnoteReferences(wp, html).map(referenceId);
}

function paragraphReferences(wp: WordPress, content: JsonValue | undefined): boolean {
  return footnoteReferences(wp, String(content ?? '')).length > 0;
}

export function explicitFootnoteRequest(wp: WordPress, requests: RequestedEdit[]): boolean {
  const roots = documentBlocks(wp);
  const rows = readTree(wp, roots);
  const last = requests.at(-1);
  const insert = last?.op === 'insert' ? last : undefined;
  const updates = insert ? requests.slice(0, -1) : requests;

  if (
    !updates.length ||
    (insert &&
      (!insert.block ||
        insert.parent?.length ||
        insert.parent_client_id ||
        insert.block.name !== 'core/footnotes' ||
        Object.keys(insert.block.attributes ?? {}).length ||
        insert.block.inner_blocks?.length ||
        (insert.index !== undefined && insert.index !== roots.length)))
  ) {
    return false;
  }

  let changed = false;

  for (const update of updates) {
    if (
      update.op !== 'update' ||
      !same(Object.keys(update.attributes), ['content']) ||
      update.unset?.length
    ) {
      return false;
    }

    const row = rows.find((item) =>
      update.client_id ? item.clientId === update.client_id : same(item.path, update.path),
    );

    if (row?.name !== 'core/paragraph') {
      return false;
    }

    changed ||= !same(
      referenceIds(wp, String(row.attributes.content ?? '')),
      referenceIds(wp, String(update.attributes.content ?? '')),
    );
  }

  return Boolean(insert) || changed;
}

// Core rewrites meta.footnotes and every label whenever reference order changes, so
// these values must already agree with its order. Refuse a mismatch; never correct it.
export function validateExplicitFootnotes(wp: WordPress, plan: Plan, declared: string): void {
  const references = footnoteReferences(wp, wp.blocks.serialize(plan.blocks));
  const order = references.map(referenceId);
  const rows = readTree(wp, plan.blocks);
  assert(
    same(
      bodies(declared, 'footnote_body_order').map((body) => body.id),
      order,
    ),
    'unsupported_structural_edit',
    {
      field: 'settings.meta.footnotes',
      constraint: 'footnote_body_order',
      reference_order: order.slice(0, 80).map(diagnosticKey),
    },
  );

  for (const reference of references) {
    const id = referenceId(reference);
    const expected = String(order.indexOf(id) + 1);

    if (wp.richText?.create({ html: reference.innerHTML ?? '' }).text !== expected) {
      const row = rows.find((item) =>
        footnoteReferences(wp, String(item.attributes.content ?? '')).some(
          (other) => referenceId(other) === id && other.innerHTML === reference.innerHTML,
        ),
      );

      throw new BlockworkError('unsupported_structural_edit', {
        constraint: 'footnote_reference_number',
        reference_id: diagnosticKey(id),
        expected_number: expected,
        target_path: row?.path,
      });
    }
  }

  assert(
    !order.length || rows.some((row) => row.name === 'core/footnotes'),
    'unsupported_structural_edit',
    { field: 'edits', constraint: 'footnote_list_missing' },
  );
}

// Outside the paired paths core rewrites the metadata as soon as any step changes the
// order, even when a later step would restore it, and that leaves a partial draft.
export function refuseUnpairedFootnoteChange(wp: WordPress, plan: Plan): void {
  const ids = (blocks: Block[]) => referenceIds(wp, wp.blocks.serialize(blocks));
  const index = plan.steps.findIndex((step) => !same(ids(step.before), ids(step.after)));

  if (index < 0) {
    return;
  }

  const { edit } = plan.steps[index];
  const parent = 'parent' in edit ? edit.parent : [];
  throw new BlockworkError('unsupported_structural_edit', {
    constraint: 'footnote_request_incomplete',
    edit_index: index,
    target_path: 'path' in edit ? edit.path : parent,
  });
}

// Recognize the bounded structural path before opening any pattern section.
export function structuralFootnoteRequest(wp: WordPress, requests: RequestedEdit[]): boolean {
  if (!requests.some((edit) => !['update', 'update_style', 'set_block_style'].includes(edit.op))) {
    return false;
  }

  const insertedReferences = (block: BlockInput): boolean =>
    (block.name === 'core/paragraph' && paragraphReferences(wp, block.attributes?.content)) ||
    (block.inner_blocks?.some(insertedReferences) ?? false);
  const original = documentBlocks(wp);
  const rows = readTree(wp, original);

  if (
    requests.some((edit) => {
      if (['update', 'update_style', 'set_block_style'].includes(edit.op)) {
        return false;
      }

      if ('block' in edit && edit.block && insertedReferences(edit.block)) {
        return true;
      }

      const target =
        'client_id' in edit && edit.client_id
          ? rows.find((row) => row.clientId === edit.client_id)
          : undefined;

      return target ? hasReferences(wp, [target.block]) : false;
    })
  ) {
    return true;
  }

  // Only root insert/move/remove/replace batches use this paired path.
  // Project their order so later paths select the same roots as the planner.
  const roots = original.map((block) => ({
    clientId: block.clientId,
    references: hasReferences(wp, [block]),
  }));

  for (const edit of requests) {
    if (['update', 'update_style', 'set_block_style'].includes(edit.op)) {
      continue;
    }

    if (edit.op === 'insert' && edit.block && !edit.parent?.length && !edit.parent_client_id) {
      const index = edit.index ?? roots.length;

      if (index > roots.length) {
        return false;
      }

      roots.splice(index, 0, { clientId: '', references: false });
      continue;
    }

    let index = -1;

    if ('client_id' in edit && edit.client_id) {
      index = roots.findIndex((root) => root.clientId === edit.client_id);
    } else if ('path' in edit && edit.path?.length === 1) {
      index = edit.path[0];
    }

    if (index < 0 || index >= roots.length) {
      return false;
    }

    if (roots[index].references) {
      return true;
    }

    if (edit.op === 'remove') {
      roots.splice(index, 1);
    } else if (edit.op === 'move' && !edit.parent?.length && !edit.parent_client_id) {
      const [root] = roots.splice(index, 1);
      const destination = edit.index ?? roots.length;

      if (destination > roots.length) {
        return false;
      }

      roots.splice(destination, 0, root);
    } else if (edit.op === 'replace' && edit.block) {
      roots.splice(index, 1, { clientId: '', references: false });
    } else {
      return false;
    }
  }

  return false;
}

export function requireRootFootnoteEdits(wp: WordPress, requests: RequestedEdit[]): void {
  const roots = documentBlocks(wp);
  assert(
    requests.every((edit) => {
      if (edit.op === 'insert' && edit.block) {
        return (
          !edit.parent?.length &&
          !edit.parent_client_id &&
          ['core/paragraph', 'core/footnotes'].includes(edit.block.name) &&
          !edit.block.inner_blocks?.length
        );
      }

      if (edit.op !== 'move' && edit.op !== 'remove') {
        return false;
      }

      const root = edit.client_id
        ? roots.find((block) => block.clientId === edit.client_id)
        : undefined;
      const rootTarget = edit.client_id ? root?.name === 'core/paragraph' : edit.path?.length === 1;

      return rootTarget && (edit.op !== 'move' || (!edit.parent?.length && !edit.parent_client_id));
    }),
    'unsupported_structural_edit',
    {
      constraint: 'footnote_root_operations',
      next_step:
        'Use a separate request containing only root paragraph moves, removals or copies, and a root Footnotes insertion if needed.',
    },
  );
}

// Native replacement labels contain a link. Keep its formats when changing the digits.
function numberedLabel(richText: FootnoteRichText, html: string, number: number): string {
  const label = richText.create({ html });
  assert(/^\d+$/.test(label.text), 'unsupported_structural_edit', {
    constraint: 'footnote_numeric_label',
    next_step: 'Use native numbered Footnote references for this structural edit.',
  });
  const text = String(number);

  if (label.text === text) {
    return html;
  }

  const numbered = richText.create({ text });
  numbered.formats = Array.from(
    { length: text.length },
    (_, index) => label.formats[Math.min(index, label.text.length - 1)],
  );

  return richText.toHTMLString({ value: numbered });
}

// The caller authorizes every companion and validates the final tree before dispatch.
export function structuralFootnotes(
  wp: WordPress,
  original: Block[],
  planned: Block[],
  observed: string,
  declared?: string,
): StructuralFootnotes {
  const richText = wp.richText;
  assert(richText, 'native_readiness_unavailable', { capability: 'richText.create/toHTMLString' });
  const inspected = bodies(observed);
  const available = bodies(declared ?? observed);
  const references: string[] = [];
  const output: FootnoteBody[] = [];
  const first = new Map<string, number>();
  const companions: FootnoteCompanion[] = [];
  const numberedPaths: number[][] = [];
  const existingIds = new Set(original.map((block) => block.clientId));
  const dependencies: string[] = [];

  for (const block of original) {
    if (block.name === 'core/paragraph') {
      if (
        richText
          .create({ html: String(block.attributes.content ?? '') })
          .replacements.some((replacement) => replacement?.type === 'core/footnote')
      ) {
        dependencies.push(block.clientId);
      }
    }
  }

  for (const tree of [original, planned]) {
    for (const [index, block] of tree.entries()) {
      const paragraph = block.name === 'core/paragraph' && !block.innerBlocks?.length;

      if (paragraph || (block.name === 'core/footnotes' && !block.innerBlocks?.length)) {
        continue;
      }

      const value = richText.create({ html: wp.blocks.serialize([block]) });
      assert(
        !value.replacements.some((replacement) => replacement?.type === 'core/footnote') &&
          !readTree(wp, [block]).some((row) => row.name === 'core/footnotes'),
        'unsupported_structural_edit',
        {
          target_path: [index],
          constraint: 'footnote_root_references',
          next_step:
            'This paired edit supports Footnote references only in root paragraphs. Keep nested references in the native editor.',
        },
      );
    }
  }

  const blocks = planned.map((block, index) => {
    if (block.name !== 'core/paragraph') {
      return block;
    }

    const content = String(block.attributes.content ?? '');
    const value = richText.create({ html: content });
    let changed = false;

    for (const replacement of value.replacements) {
      if (replacement?.type !== 'core/footnote') {
        continue;
      }

      const id = replacement.attributes?.['data-fn'];
      const matches = available.filter((body) => body.id === id);
      const body = matches[0];
      assert(
        body && matches.every((item) => item.content === body.content),
        'unsupported_structural_edit',
        { target_path: [index], constraint: 'footnote_body_required', next_step: repair },
      );
      assert(
        inspected.filter((item) => item.id === id).every((item) => item.content === body.content),
        'unsupported_structural_edit',
        {
          target_path: [index],
          constraint: 'footnote_observed_body_unchanged',
          next_step: 'Keep observed Footnote bodies unchanged during a structural edit.',
        },
      );
      references.push(body.id);
      output.push({ ...body });

      if (!first.has(body.id)) {
        first.set(body.id, references.length);
      }

      const html = numberedLabel(richText, replacement.innerHTML ?? '', first.get(body.id)!);

      if (replacement.innerHTML !== html) {
        replacement.innerHTML = html;
        changed = true;
      }
    }

    if (!changed) {
      return block;
    }

    const numbered = richText.toHTMLString({ value });
    numberedPaths.push([index]);

    if (existingIds.has(block.clientId)) {
      companions.push({ client_id: block.clientId, path: [index], content: numbered });
    }

    return { ...block, attributes: { ...block.attributes, content: numbered } };
  });
  assert(
    !references.length || planned.some((block) => block.name === 'core/footnotes'),
    'unsupported_structural_edit',
    { constraint: 'footnote_list_required', next_step: repair },
  );
  assert(declared === undefined || same(available, output), 'unsupported_structural_edit', {
    constraint: 'footnote_complete_body_order',
    next_step:
      'Supply the complete final body list in reference order, repeating records for duplicate IDs.',
  });

  return {
    blocks,
    footnotes: JSON.stringify(output),
    companions,
    dependencies,
    footnote_writes: {
      source: declared === undefined ? 'document' : 'settings',
      affected_paths: numberedPaths.slice(0, 80),
      affected_paths_truncated: numberedPaths.length > 80 ? numberedPaths.length : undefined,
      numbered_paragraphs: numberedPaths.length,
      companion_writes: companions.length,
      body_count_before: inspected.length,
      body_count_after: output.length,
      reference_count: references.length,
      order_changed: !same(
        inspected.map((body) => body.id),
        references,
      ),
    },
  };
}

export async function prepareStructuralFootnotePlan(
  wp: WordPress,
  plan: Plan,
  observed: string,
  declared: string | undefined,
  observedBlocks: Record<string, Observed>,
): Promise<StructuralFootnotes & { permission: () => void }> {
  const result = structuralFootnotes(wp, plan.steps[0].before, plan.blocks, observed, declared);
  const permission = await authorizeFootnotePlan(wp, plan, result.blocks, result.companions);
  const clean = wp.blocks.__unstableSerializeAndClean;
  assert(clean, 'native_readiness_unavailable', {
    capability: 'blocks.__unstableSerializeAndClean',
  });
  const rows = readTree(wp, result.blocks);
  const parsed = readTree(wp, wp.blocks.parse(clean(result.blocks)));
  assert(validity(parsed).valid, 'unsupported_block');

  if (!roundTripMatches(wp, rows, parsed)) {
    throw new BlockworkError(
      'serialization_mismatch',
      serializationDiagnostics(rows, parsed, 'footnote_round_trip', 'planned_to_parsed'),
    );
  }

  // A foreign deletion of a reference still depends on its earlier observation.
  for (const block of plan.steps[0].before) {
    const previous = observedBlocks[block.clientId];

    if (previous?.name !== 'core/paragraph') {
      continue;
    }

    const attributes = v.parse(JsonObjectSchema, JSON.parse(previous.attributes));
    const value = wp.richText!.create({ html: String(attributes.content ?? '') });

    if (value.replacements.some((replacement) => replacement?.type === 'core/footnote')) {
      result.dependencies.push(block.clientId);
    }
  }

  for (const id of new Set(result.dependencies)) {
    plan.touched.push({ client_id: id, kind: 'attributes', edit_index: 0 });
  }

  plan.touched.push({ client_id: '', kind: 'children', edit_index: 0 });
  plan.blocks = result.blocks;

  return { ...result, permission };
}
