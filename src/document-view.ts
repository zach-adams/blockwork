import type { Block, WordPress } from './wordpress';
import { preparePostDates } from './query';
import { pause } from './timing';
import { requireCondition as assert } from './inspection';
import * as v from 'valibot';

// The Navigation screen wraps the entity in one editor-only core/navigation.
// Paths and persisted content refer to its children, never to that wrapper.
export function documentRoot(wp: WordPress): Block | undefined {
  if (wp.data.select('core/editor').getCurrentPostType() !== 'wp_navigation') {
    return;
  }

  const blocks = wp.data.select('core/block-editor').getBlocks();
  assert(
    blocks.length === 1 &&
      blocks[0].name === 'core/navigation' &&
      blocks[0].attributes.ref === wp.data.select('core/editor').getCurrentPostId(),
    'navigation_wrapper_unavailable',
  );

  return blocks[0];
}

export function documentBlocks(wp: WordPress): Block[] {
  return wp.data.select('core/block-editor').getBlocks(documentRoot(wp)?.clientId);
}

export function documentContent(wp: WordPress): string {
  return documentRoot(wp)
    ? wp.blocks.serialize(documentBlocks(wp))
    : wp.data.select('core/editor').getEditedPostContent();
}

export async function resetDocument(
  wp: WordPress,
  blocks: Block[],
  checkOwnership: () => void,
  beforeMutation: () => void = () => undefined,
): Promise<void> {
  const root = documentRoot(wp);
  const actions = wp.data.dispatch('core/block-editor');
  const checkDates = await preparePostDates(wp, blocks);
  checkOwnership();
  checkDates();

  if (root) {
    assert(actions.replaceInnerBlocks, 'navigation_wrapper_unavailable');
    beforeMutation();
    await actions.replaceInnerBlocks(root.clientId, blocks, false);
  } else {
    beforeMutation();
    await actions.resetBlocks(blocks);
  }
}

// Call only after exact content, IDs, effective settings, and pending settings
// match the original draft. Never clear an original human draft's edits.
export async function restoreDraftDirty(wp: WordPress, originallyDirty: boolean): Promise<void> {
  const editor = wp.data.select('core/editor');

  if (!originallyDirty && editor.isEditedPostDirty()) {
    const type = editor.getCurrentPostType();
    const id = editor.getCurrentPostId();
    const pending = wp.data.select('core').getEntityRecordNonTransientEdits('postType', type, id);
    const entries = Object.entries(pending);
    assert(
      entries.length === 1 && entries[0][0] === 'content' && v.is(v.function(), entries[0][1]),
      'revert_dirty_state_changed',
    );
    const actions = wp.data.dispatch('core');
    assert(actions.editEntityRecord, 'native_revert_state_unavailable');
    const clear = () =>
      actions.editEntityRecord!('postType', type, id, { content: undefined }, { undoIgnore: true });

    if (wp.element?.flushSync) {
      wp.element.flushSync(clear);
    } else {
      clear();
    }

    await pause(0);
  }

  assert(editor.isEditedPostDirty() === originallyDirty, 'revert_dirty_state_changed');
}
