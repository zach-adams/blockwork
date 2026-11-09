import * as v from 'valibot';
import { JsonObjectSchema, JsonSchema } from './contracts';
import type { JsonObject, JsonValue, Target } from './contracts';
import type { Block, EntityContent, PairedEntityEdit, WordPress } from './wordpress';
import type { Plan } from './edits';
import type { SettingsPlan } from './documents';
import { BlockworkError } from './errors';
import { readTree, requireCondition as assert } from './inspection';
import { renderAffected } from './initialization';
import { Budget, pause, remainingMs } from './timing';
import { same } from './values';

interface FootnoteState extends JsonObject {
  blocks: JsonValue;
  entity_blocks: JsonValue;
  entity_content: string;
  entity_meta: JsonValue;
  fields: JsonObject;
  selection: JsonObject;
  pending: JsonObject;
  pending_keys: string[];
  dirty: boolean;
}

export interface FootnoteCheckpoint {
  before: FootnoteState;
  original: Block[];
  content: EntityContent;
  contentOnly?: boolean;
  dispatched: boolean;
  verified: boolean;
  reached?: FootnoteState;
  reached_content?: EntityContent;
}

function json(value: JsonObject | Block[]): JsonValue {
  return v.parse(JsonSchema, JSON.parse(JSON.stringify(value)));
}

function entityRecord(wp: WordPress, target: Target) {
  const getRecord = wp.data.select('core').getEditedEntityRecord;
  assert(getRecord, 'native_readiness_unavailable');
  const record = getRecord('postType', target.post_type, target.post_id);
  assert(record, 'editor_record_unavailable');

  return record;
}

function snapshot(wp: WordPress, target: Target, fields: () => JsonObject): FootnoteState {
  const core = wp.data.select('core');
  const store = wp.data.select('core/block-editor');
  const editor = wp.data.select('core/editor');
  assert(
    store.getSelectionStart && store.getSelectionEnd && store.getSelectedBlocksInitialCaretPosition,
    'native_readiness_unavailable',
  );
  const record = entityRecord(wp, target);
  const content = v.is(v.function(), record.content) ? record.content(record) : record.content;
  const resolved = v.is(v.string(), content)
    ? content
    : v.parse(v.object({ raw: v.string() }), content).raw;
  const edits = core.getEntityRecordNonTransientEdits('postType', target.post_type, target.post_id);
  const pendingKeys = Object.keys(edits).sort();
  const currentFields = v.parse(JsonObjectSchema, json(fields()));
  assert(
    pendingKeys.every((key) => Object.hasOwn(currentFields, key)),
    'unsupported_pending_settings',
  );

  const pending = Object.fromEntries(
    Object.entries(edits).map(([key, value]) => {
      assert(!v.is(v.function(), value) || key === 'content', 'unsupported_pending_settings');

      return [key, v.is(v.function(), value) ? { callable: true, resolved: value(record) } : value];
    }),
  );

  return {
    blocks: json(store.getBlocks()),
    entity_blocks: record.blocks ? json(record.blocks) : null,
    entity_content: resolved,
    entity_meta: record.meta ? json(record.meta) : null,
    fields: currentFields,
    selection: v.parse(
      JsonObjectSchema,
      json({
        selectionStart: store.getSelectionStart(),
        selectionEnd: store.getSelectionEnd(),
        initialPosition: store.getSelectedBlocksInitialCaretPosition(),
      }),
    ),
    pending: v.parse(JsonObjectSchema, json(pending)),
    pending_keys: pendingKeys,
    dirty: editor.isEditedPostDirty(),
  };
}

function unrelatedPending(state: FootnoteState): JsonObject {
  return Object.fromEntries(
    Object.entries(state.pending).filter(([key]) => !['content', 'meta'].includes(key)),
  );
}

export function footnoteCheckpoint(
  wp: WordPress,
  plan: Plan,
  settings: SettingsPlan,
  expectedFields: JsonObject,
  fields: () => JsonObject,
  contentOnly = false,
): FootnoteCheckpoint {
  const before = snapshot(wp, plan.target, fields);
  const expected: JsonObject = contentOnly
    ? expectedFields
    : { ...expectedFields, meta: settings.original.meta };
  const keys = new Set([...Object.keys(expected), ...Object.keys(before.fields)]);
  const changed = [...keys].filter((key) => !same(expected[key], before.fields[key]));
  assert(!changed.length, 'field_changed', {
    stage: 'footnote_preparation',
    fields: changed.slice(0, 20),
    next_step: 'Read the draft and its complete settings before preparing another edit.',
  });
  assert(
    same(before.blocks, json(plan.steps[0].before)) &&
      (before.entity_blocks === null || same(before.entity_blocks, before.blocks)) &&
      before.entity_content === before.fields.content &&
      same(before.entity_meta, before.fields.meta ?? null),
    'prepared_content_changed',
    { stage: 'footnote_preparation' },
  );
  const record = entityRecord(wp, plan.target);
  const content = before.pending_keys.includes('content') ? record.content : before.entity_content;

  return {
    contentOnly,
    before,
    original: plan.steps[0].before,
    content,
    dispatched: false,
    verified: false,
  };
}

async function verifySettled(
  wp: WordPress,
  target: Target,
  fields: () => JsonObject,
  expected: FootnoteState,
  available: () => void,
  expectedContent: EntityContent,
): Promise<void> {
  for (let index = 0; index < 5; index++) {
    assert(remainingMs() >= 100, 'native_initialization_unsettled', { stage: 'footnote_settle' });
    await pause(100);
    available();
    assert(
      !v.is(v.function(), expectedContent) || entityRecord(wp, target).content === expectedContent,
      'prepared_content_changed',
      { stage: 'footnote_content_callback' },
    );
    assert(same(snapshot(wp, target, fields), expected), 'prepared_content_changed', {
      stage: 'footnote_settle',
      next_step: 'Read the draft and settings. Do not replay the paired edit.',
    });
  }
}

export async function applyExplicitFootnotes(
  wp: WordPress,
  plan: Plan,
  settings: SettingsPlan,
  checkpoint: FootnoteCheckpoint,
  fields: () => JsonObject,
  beforeMutation: () => void,
  available: () => void,
  background: boolean,
  permission: () => void = () => {},
  validateReached: () => Promise<void> = async () => {},
): Promise<void> {
  const flush = wp.element?.flushSync;
  const write = wp.data.dispatch('core').editEntityRecord;
  assert(flush && write, 'native_readiness_unavailable');
  const meta = checkpoint.contentOnly ? undefined : v.parse(JsonObjectSchema, settings.values.meta);
  const clean = wp.blocks.__unstableSerializeAndClean;
  assert(clean, 'native_readiness_unavailable');
  const rename = checkpoint.contentOnly && plan.steps.every((step) => step.edit.op === 'update');
  const update = wp.data.dispatch('core/block-editor').updateBlockAttributes;
  assert(!rename || update, 'native_readiness_unavailable');
  const content = clean(plan.blocks);
  const serialize: EntityContent = ({ blocks = [] }) => clean(blocks);
  const before = checkpoint.before;
  const expected: FootnoteState = {
    ...before,
    blocks: json(plan.blocks),
    entity_blocks: rename && before.entity_blocks === null ? null : json(plan.blocks),
    entity_content: content,
    entity_meta: meta ?? before.entity_meta,
    fields: meta ? { ...before.fields, content, meta } : { ...before.fields, content },
    dirty: true,
  };

  try {
    flush(() => {
      available();
      permission();
      assert(
        (!v.is(v.function(), checkpoint.content) ||
          entityRecord(wp, plan.target).content === checkpoint.content) &&
          same(snapshot(wp, plan.target, fields), before),
        'intervening_editor_change',
        {
          stage: 'footnote_dispatch',
          next_step: 'Read the changed draft and settings before editing.',
        },
      );
      beforeMutation();
      checkpoint.dispatched = true;

      if (rename) {
        const attributes: Record<string, JsonObject> = {};

        for (const step of plan.steps) {
          assert(step.edit.op === 'update', 'invalid_edit');
          let block = step.before[step.edit.path[0]];

          for (const index of step.edit.path.slice(1)) {
            block = block.innerBlocks![index];
          }

          assert(step.update, 'invalid_edit');
          attributes[block.clientId] = { ...attributes[block.clientId], ...step.update };
        }

        update(Object.keys(attributes), attributes, true);

        return;
      }

      const values: PairedEntityEdit = {
        blocks: plan.blocks,
        content: serialize,
        selection: before.selection,
      };

      if (meta) {
        values.meta = meta;
      }

      write('postType', plan.target.post_type, plan.target.post_id, values, { isCached: false });
    });
    const actual = snapshot(wp, plan.target, fields);
    // Only the complete, actually reached state can authorize a restore.
    // Core can replace Tabs' content callback while preserving the exact planned state.
    assert(
      (checkpoint.contentOnly || entityRecord(wp, plan.target).content === serialize) &&
        same(actual, { ...expected, pending: actual.pending, pending_keys: actual.pending_keys }) &&
        actual.pending_keys.includes('content') &&
        (!checkpoint.contentOnly || same(actual.pending.meta, before.pending.meta)) &&
        same(unrelatedPending(actual), unrelatedPending(before)),
      'prepared_content_changed',
      {
        stage: 'footnote_immediate',
        state_properties: Object.keys(expected).filter(
          (key) => !['pending', 'pending_keys'].includes(key) && !same(actual[key], expected[key]),
        ),
        pending_meta_changed: !same(actual.pending.meta, before.pending.meta),
        content_callback_matches:
          checkpoint.contentOnly || entityRecord(wp, plan.target).content === serialize,
      },
    );
    checkpoint.reached = actual;
    checkpoint.reached_content = checkpoint.contentOnly
      ? entityRecord(wp, plan.target).content
      : serialize;
    const budget = new Budget(
      document.visibilityState === 'hidden' ? 10000 : 5000,
      Math.min(30000, remainingMs()),
    );
    const original = new Map(
      readTree(wp, checkpoint.original).map((row) => [row.clientId, row.attributes]),
    );
    const affected = new Set(
      readTree(wp, plan.blocks).flatMap((row) =>
        !original.has(row.clientId) || !same(original.get(row.clientId), row.attributes)
          ? [row.clientId]
          : [],
      ),
    );
    await renderAffected(wp, affected, budget, background);
    assert(same(snapshot(wp, plan.target, fields), actual), 'prepared_content_changed', {
      stage: 'footnote_render',
    });
    await validateReached();
    await verifySettled(wp, plan.target, fields, actual, available, checkpoint.reached_content);
    checkpoint.verified = true;
  } catch (cause) {
    const error = cause instanceof BlockworkError ? cause : undefined;
    throw new BlockworkError(
      error?.code ?? 'operation_failed',
      {
        ...error?.diagnostics,
        dispatched_groups: Number(checkpoint.dispatched),
        completed_edits: checkpoint.verified ? plan.steps.length : 0,
        next_step: 'Read the draft and complete settings. Do not replay an uncertain paired edit.',
      },
      { cause },
    );
  }
}

export async function restoreExplicitFootnotes(
  wp: WordPress,
  target: Target,
  checkpoint: FootnoteCheckpoint,
  fields: () => JsonObject,
  available: () => void,
  beforeMutation: () => void,
): Promise<boolean> {
  const flush = wp.element?.flushSync;
  const write = wp.data.dispatch('core').editEntityRecord;
  assert(flush && write, 'native_readiness_unavailable');
  let restored = false;
  flush(() => {
    available();

    if (
      !checkpoint.reached ||
      entityRecord(wp, target).content !== checkpoint.reached_content ||
      !same(snapshot(wp, target, fields), checkpoint.reached)
    ) {
      return;
    }

    const before = checkpoint.before;
    beforeMutation();
    const values: PairedEntityEdit = {
      blocks: checkpoint.original,
      content: checkpoint.content,
      selection: before.selection,
    };

    if (!checkpoint.contentOnly) {
      values.meta = v.parse(JsonObjectSchema, before.fields.meta);
    }

    write('postType', target.post_type, target.post_id, values, { isCached: false });
    restored = true;
  });

  if (!restored) {
    return false;
  }

  const expected = { ...checkpoint.before, entity_blocks: checkpoint.before.blocks };
  assert(same(snapshot(wp, target, fields), expected), 'rollback_failed', {
    stage: 'footnote_restore_immediate',
  });
  // Includes original pending key presence, callback kind, selection and dirty state.
  await verifySettled(wp, target, fields, expected, available, checkpoint.content);
  checkpoint.reached = undefined;

  return true;
}
