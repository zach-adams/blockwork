import { documentBlocks } from './document-view';
import { limit, pause } from './timing';
import type { Budget, Deadline } from './timing';
import type { WordPress } from './wordpress';
import { readTree, requireCondition as assert } from './inspection';
import { requireRendered } from './canvas';
import { same } from './values';
import type { JsonObject } from './contracts';
import { preparePostDates } from './query';
import { BlockworkError } from './errors';

export async function withinInitialization<T>(
  work: () => Promise<T>,
  deadline: Deadline,
  diagnostics?: JsonObject,
): Promise<T> {
  assert(Date.now() < limit(deadline), 'native_initialization_unsettled', diagnostics);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        // Progress elsewhere can extend a budget while this work runs.
        const check = () => {
          const left = limit(deadline) - Date.now();

          if (left > 0) {
            timer = setTimeout(check, left);
          } else {
            reject(new BlockworkError('native_initialization_unsettled', diagnostics));
          }
        };

        check();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function renderAffected(
  wp: WordPress,
  ids: Set<string>,
  budget: Budget,
  retainMissingSelection: boolean,
  beforeRender: () => void = () => undefined,
): Promise<void> {
  const checkDates = await preparePostDates(wp, documentBlocks(wp), ids);
  const checkRender = () => {
    beforeRender();
    checkDates();
  };

  const store = wp.data.select('core/block-editor');
  const { selectBlock, resetSelection } = wp.data.dispatch('core/block-editor');
  const { getSelectionStart, getSelectionEnd, getSelectedBlocksInitialCaretPosition } = store;
  const flush = wp.element?.flushSync;
  assert(
    flush &&
      getSelectionStart &&
      getSelectionEnd &&
      getSelectedBlocksInitialCaretPosition &&
      selectBlock &&
      resetSelection,
    'native_readiness_unavailable',
  );
  const rows = readTree(wp, documentBlocks(wp)).filter((row) => ids.has(row.clientId));

  // Query reads these exact dependencies before deriving perPage. Resolving
  // them explicitly covers the gap before public resolver metadata starts.
  if (rows.some((row) => row.name === 'core/query')) {
    const { canUser, getEntityRecord } = wp.data.resolveSelect?.('core') ?? {};
    assert(canUser && getEntityRecord, 'native_readiness_unavailable');

    const canRead = await withinInitialization(
      () => canUser('read', { kind: 'root', name: 'site' }),
      budget,
      { stage: 'query_site_permission', pending_resolver: 'core.canUser' },
    );

    if (canRead) {
      await withinInitialization(() => getEntityRecord('root', 'site'), budget, {
        stage: 'query_site_record',
        pending_resolver: 'core.getEntityRecord',
      });
    }
  }

  const start = { ...getSelectionStart() };
  const end = { ...getSelectionEnd() };
  const position = getSelectedBlocksInitialCaretPosition();
  let ownedSelection = start;
  let ownedEnd = end;
  let ownedPosition = position;

  try {
    for (const [index, row] of rows.entries()) {
      const diagnostics = {
        stage: 'render_affected',
        target_path: row.path,
        block_name: row.name,
        completed_blocks: index,
        block_count: rows.length,
      };
      assert(Date.now() < budget.deadline, 'native_initialization_unsettled', diagnostics);

      // A parent's deferred update may mount its descendants. Keep the parent
      // synchronous while waiting for the next block in tree order to mount.
      try {
        await withinInitialization(
          () => requireRendered([row.clientId], budget, checkRender),
          budget,
          { ...diagnostics, render_phase: 'mount' },
        );
      } catch (error) {
        if (error instanceof BlockworkError) {
          throw new BlockworkError(error.code, {
            ...diagnostics,
            render_phase: 'mount',
            ...error.diagnostics,
          });
        }

        throw error;
      }

      assert(
        same(getSelectionStart(), ownedSelection) &&
          same(getSelectionEnd(), ownedEnd) &&
          getSelectedBlocksInitialCaretPosition() === ownedPosition,
        'intervening_selection_change',
      );
      // Selecting switches Gutenberg's deferred useSelect subscriptions to
      // synchronous delivery. null avoids requesting a caret/focus move.
      // Record the requested selection first; native rendering can throw after
      // selecting, and cleanup still owns that exact selection.
      // Native SELECT_BLOCK retains each endpoint when its client ID already
      // matches. A selected text range can survive this render request.
      ownedSelection =
        getSelectionStart().clientId === row.clientId
          ? { ...getSelectionStart() }
          : { clientId: row.clientId };
      ownedEnd =
        getSelectionEnd().clientId === row.clientId
          ? { ...getSelectionEnd() }
          : { clientId: row.clientId };
      ownedPosition = null;
      checkRender();
      flush(() => selectBlock(row.clientId, null));
      assert(
        same(getSelectionStart(), ownedSelection) &&
          same(getSelectionEnd(), ownedEnd) &&
          getSelectedBlocksInitialCaretPosition() === null,
        'native_render_refused',
      );
      assert(Date.now() < budget.deadline, 'native_initialization_unsettled', {
        ...diagnostics,
        render_phase: 'selection_commit',
        completed_blocks: index + 1,
      });
      budget.progress();
    }
  } finally {
    if (
      same(getSelectionStart(), ownedSelection) &&
      same(getSelectionEnd(), ownedEnd) &&
      getSelectedBlocksInitialCaretPosition() === ownedPosition
    ) {
      const surviving = new Set(readTree(wp, documentBlocks(wp)).map((row) => row.clientId));
      const restoredStart =
        retainMissingSelection || !start.clientId || surviving.has(start.clientId) ? start : {};
      const restoredEnd =
        retainMissingSelection || !end.clientId || surviving.has(end.clientId) ? end : {};
      beforeRender();
      flush(() => resetSelection(restoredStart, restoredEnd, position));
      assert(
        same(getSelectionStart(), restoredStart) &&
          same(getSelectionEnd(), restoredEnd) &&
          getSelectedBlocksInitialCaretPosition() === position,
        'native_selection_restore_failed',
      );
    }
  }

  // Let layout-effect microtasks and queued resolver startup run before taking
  // the next snapshot, including effects triggered by restoring selection.
  await withinInitialization(() => pause(0), budget, {
    stage: 'render_affected',
    render_phase: 'queued_effects',
    block_count: rows.length,
  });
}
