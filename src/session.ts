import * as v from 'valibot';
import {
  ApiErrorSchema,
  ConnectionSchema,
  JsonObjectSchema,
  PostSchema,
  ReceiptSchema,
  RequestSchema,
  TargetIdentitySchema,
  TargetSchema,
} from './contracts';
import type {
  BlockSummary,
  DraftCheckpoint,
  DraftState,
  Connection,
  EditorRequest,
  JsonObject,
  JsonValue,
  MeasureOptions,
  MetaBoxOutcome,
  Observed,
  Post,
  Request,
  SaveResult,
  Session,
} from './contracts';
import type { Block, WordPress } from './wordpress';
import { controlNotes } from './native-controls';
import {
  BlockworkError,
  accessFailure,
  blockMismatches,
  changedProperties,
  failureCode,
  diagnosticKey,
  invalidRequest,
  serializationDiagnostics,
  validationIssues,
  wordpressError,
} from './errors';
import {
  blockState,
  storedState,
  storedMismatches,
  customBlocks,
  liveRow,
  projectInspection,
  readTree,
  refuseAmbiguousUnion,
  requireCondition as assert,
  sharedReference,
  previewFor,
  validity,
} from './inspection';
import {
  applyPlan,
  copyTree,
  markupBlocks,
  needsNativePreparation,
  preparePlan,
  rewrittenBlocks,
  prepareExplicitFootnotePlan,
  prepareCompleteTabs,
  prepareCompleteContextMove,
  checkCompleteTabsChildren,
  prepareCompleteGallery,
  restorePlan,
  roundTripMatches,
} from './edits';
import type { Plan, Touch } from './edits';
import {
  applyExplicitFootnotes,
  footnoteCheckpoint,
  restoreExplicitFootnotes,
} from './explicit-footnotes';
import {
  explicitFootnoteRequest,
  prepareStructuralFootnotePlan,
  refuseUnpairedFootnoteChange,
  requireRootFootnoteEdits,
  structuralFootnoteRequest,
  validateExplicitFootnotes,
} from './structural-footnotes';
import { retargetBlocks } from './media-map';
import { mapLinks } from './link-map';
import { debugDetails } from './debug';
import { openPatternSection, patternSectionState } from './pattern-sections';
import { documentBlocks, documentContent, resetDocument, restoreDraftDirty } from './document-view';
import {
  documentContract,
  documentFields,
  documentReadFields,
  metaBoxField,
  prepareSettings,
  settingsGuide,
  settingsPatch,
} from './documents';
import type { SettingsPlan } from './documents';
import {
  api,
  authenticate,
  bounded,
  budgetedMs,
  requireSignIn,
  requireSupportedWordPress,
  timedRequest,
} from './native';
import {
  checkContentSize,
  checkSharedRecord,
  editorUrl,
  entitySummary,
  postRecord,
  readReference,
  sharedType,
} from './shared';
import { entityToken, mediaEdits } from './resources';
import { nativeNormalization, plannedContent, templateFills } from './catalog';
import { canonical, hash, same } from './values';
import { contentlessHash, receiptMatch } from './persistence';
import { measureBlocks } from './measure';
import { requireCanvas, showVisualEditor } from './canvas';
import { pause, remainingMs } from './timing';
import { placeBlock, restoreView, showWidth } from './view';

type EditInput = Extract<EditorRequest, { operation: 'edit' }>;

const sessionKey = 'blockwork/session';
// The one document field core builds editor settings from: the page template
// supplies Post Content's layout, and plugins key block restrictions on it.
// Gutenberg keeps its loaded settings until a reload, so a template change
// must be saved, and the editor reopened, before structural edits.
const policyFields = ['template'];
const attributeOps = ['update', 'update_style', 'set_block_style', 'update_reference'];
const mutationKey = 'blockwork/attached_mutation';
const ConnectionIdentitySchema = v.object({ target: v.omit(TargetIdentitySchema, ['user_id']) });
const TargetIdentityRequestSchema = v.object({ target: TargetIdentitySchema });

const invalidCodes = new Map([
  ['connect', 'invalid_connection'],
  ['read', 'invalid_read'],
  ['edit', 'invalid_edit'],
  ['measure', 'invalid_measure'],
  ['view', 'invalid_view'],
]);

// One editor session per page, for both workflows. Edits change the live
// draft immediately; only save persists. Background owns its tab and lock.
export async function editorOperation(request: Request | Connection): Promise<JsonObject> {
  const operation = request?.operation;

  if (operation === 'connect') {
    const identity = v.safeParse(ConnectionIdentitySchema, request);
    const validated = v.safeParse(ConnectionSchema, request);

    if (!identity.success || !validated.success) {
      return invalidRequest(
        'invalid_connection',
        identity.success ? (validated.issues ?? []) : identity.issues,
      );
    }

    return connect(validated.output);
  }

  const identity = v.safeParse(TargetIdentityRequestSchema, request);
  const validated = v.safeParse(RequestSchema, request);

  if (!identity.success || !validated.success) {
    return invalidRequest(
      invalidCodes.get(operation) ?? 'invalid_request',
      identity.success ? (validated.issues ?? []) : identity.issues,
    );
  }

  const input = validated.output;
  const session = window.__blockwork_editor;
  const released = window.__blockwork_release;

  // A release whose response was lost can still be confirmed here.
  if (session?.protocol !== 4 && input.operation === 'status' && released) {
    return same(released.target, input.target)
      ? { ok: true, busy: false, released: true, ...released }
      : failure(new BlockworkError('target_mismatch'));
  }

  if (session?.protocol !== 4) {
    return failure(
      new BlockworkError(session ? 'session_from_older_build' : 'connect_required'),
      session,
    );
  }

  if (!Array.isArray(session.media_references)) {
    return failure(new BlockworkError('session_from_older_build'), session);
  }

  if (!same(session.target, input.target)) {
    return failure(new BlockworkError('target_mismatch'), session);
  }

  if (input.operation === 'status') {
    return status(session);
  }

  if (session.busy) {
    return failure(new BlockworkError('operation_in_progress'), session);
  }

  const wp = window.wp;
  const mutating = ['edit', 'revert', 'save', 'release'].includes(input.operation);
  session.busy = true;

  if (mutating) {
    session.last_request = {
      id: input.request_id ?? crypto.randomUUID(),
      operation: input.operation,
      outcome: 'running',
    };
  }

  try {
    assert(wp?.data && wp.blocks && wp.apiFetch, 'editor_unavailable');
    const editor = editorContext(wp, session);

    if (['edit', 'revert', 'prepare_save', 'save'].includes(input.operation)) {
      await editor.nativeSaveSettled();
    }

    // A view left behind by a failed host call is undone before other work. A
    // measure at a width keeps it, like each view slice, until the host
    // restores it after resizing its own tab back.
    if (
      input.operation !== 'map_links' &&
      input.operation !== 'view' &&
      !(input.operation === 'measure' && input.width)
    ) {
      await restoreView(wp, session);
    }

    switch (input.operation) {
      case 'map_links':
        editor.sameDocument();

        return await mapLinks(wp, input);
      case 'read':
        return await read(editor, input);
      case 'edit':
        return await edit(editor, input);
      case 'prepare_resave':
        return await prepareResave(editor);
      case 'measure': {
        editor.sameDocument();
        // A device change would otherwise run before the blocks finish
        // rendering into a newly mounted canvas.
        await requireCanvas(
          input.blocks.map((id, index) => liveRow(editor.rows(), id, `blocks.${index}`).clientId),
        );
        const fitted = input.width === undefined ? {} : await showWidth(wp, session, input.width);

        // The host resizes its own tab and measures again.
        return fitted.resize
          ? { ok: true, ...fitted }
          : { ok: true, ...fitted, ...(await measureBlocks(wp, editor.rows(), input)) };
      }

      case 'view':
        editor.sameDocument();

        return await placeBlock(
          wp,
          session,
          liveRow(editor.rows(), input.client_id, 'client_id').clientId,
          input.width,
          input.offset,
        );
      case 'restore_view':
        return { ok: true };
      case 'revert':
        return await revert(editor);
      case 'prepare_save':
        return await prepareSave(editor, input.save_all_pending);
      case 'save':
        return await save(editor, input.receipt, input.save_all_pending);
      default:
        return await release(editor);
    }
  } catch (error) {
    if (mutating && session.last_request?.outcome === 'running') {
      session.last_request.outcome = 'failed';
    }

    const result = failure(error, session);

    if (wp && input.operation === 'edit' && input.open_pattern_section) {
      result.pattern_section = patternSectionState(wp);
    }

    // status() reports why, for a caller whose host call lost this result.
    if (mutating && session.last_request) {
      session.last_request.error = String(result.error);
    }

    return result;
  } finally {
    if (wp && session.workflow === 'attached' && !session.footnote_recovery) {
      wp.data.dispatch('core/editor').unlockPostAutosaving(mutationKey);
    }

    session.busy = false;
  }
}

function fieldValue(fields: JsonObject, path: string[]): JsonValue | undefined {
  let value: JsonValue | undefined = fields;

  for (const key of path) {
    if (!v.is(JsonObjectSchema, value) || !Object.hasOwn(value, key)) {
      return undefined;
    }

    value = value[key];
  }

  return value;
}

// Keep raw paths for full-value checks; bound and sanitize only their output.
function fieldChanges(expected: JsonObject, actual: JsonObject): string[][] {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((name) => {
    if (
      name === 'meta' &&
      (expected.meta === undefined || v.is(JsonObjectSchema, expected.meta)) &&
      (actual.meta === undefined || v.is(JsonObjectSchema, actual.meta))
    ) {
      const keys = new Set([
        ...Object.keys(expected.meta ?? {}),
        ...Object.keys(actual.meta ?? {}),
      ]);
      const changed = [...keys].flatMap((key) =>
        same(fieldValue(expected, [name, key]), fieldValue(actual, [name, key]))
          ? []
          : [[name, key]],
      );

      if (changed.length) {
        return changed;
      }
    }

    return same(fieldValue(expected, [name]), fieldValue(actual, [name])) ? [] : [[name]];
  });
}

function fieldNames(paths: string[][]): string[] {
  return paths.slice(0, 20).map((path) => path.map(diagnosticKey).join('.').slice(0, 160));
}

function differingFields(expected: JsonObject, actual: JsonObject): string[] {
  return fieldNames(fieldChanges(expected, actual));
}

function editorContext(wp: WordPress, session: Session) {
  const target = session.target;
  const editor = wp.data.select('core/editor');
  const actions = wp.data.dispatch('core/editor');
  const fields = (post: Post, dates: string[] = []) => documentFields(post, session.schema, dates);

  const sameDocument = () => {
    assert(
      editor.getCurrentPostId() === target.post_id &&
        editor.getCurrentPostType() === target.post_type,
      'target_mismatch',
    );
  };

  const available = () => {
    sameDocument();
    assert(!editor.isPostLocked() && !editor.isPostLockTakeover(), 'post_locked');
    assert(
      !editor.isSavingPost() && !wp.data.select('core/edit-post')?.isSavingMetaBoxes(),
      'save_in_progress',
    );

    if (session.preview) {
      assert(
        editor.isPostAutosavingLocked?.() && editor.isPostSavingLocked(),
        'unsaved_preview_lock_lost',
      );
    }
  };

  const fresh = async () => {
    const post = await postRecord(
      wp,
      session.schema.collection,
      target.post_id,
      documentReadFields(session.schema),
    );
    assert(v.is(PostSchema, post), 'post_mismatch');
    checkSharedRecord(post, target);

    return post;
  };

  const loadedPost = (): Post => {
    const record = JSON.parse(JSON.stringify(editor.getCurrentPost()));
    assert(v.is(JsonObjectSchema, record), 'editor_record_unavailable');

    // core/editor exposes raw text as strings; REST exposes { raw }. Convert
    // that native boundary before comparing the saved and live baselines.
    for (const name of ['title', 'excerpt', 'content']) {
      if (v.is(v.string(), record[name])) {
        record[name] = { raw: record[name] };
      }
    }

    assert(v.is(PostSchema, record), 'editor_record_unavailable');

    return record;
  };

  // The saved record must be the one this editor loaded or last saved itself.
  // A store subscription follows this editor's own saves, including native
  // autosave of a draft and the user's saves. A record adopted into the store
  // any other way, or a save from another tab, user, or tool, does not move it.
  // Dates are excluded: a draft's floating date differs between the editor's
  // record and REST after autosave, and saves only send dates they edit.
  // After a native save with meta boxes, the editor's record misses what their
  // forms wrote, so adopt the stored meta keys and plugin fields once.
  const matchesSaved = (saved: Post) => {
    const current = fields(saved);
    const changed = fieldChanges(session.baseline, current).filter(
      (path) => !(session.meta_box_save && metaBoxField(path[0], session.schema.taxonomy_fields)),
    );
    assert(!changed.length, 'saved_record_changed', { fields: fieldNames(changed) });

    if (session.meta_box_save) {
      session.baseline = current;
      session.meta_box_save = false;
    }
  };

  const watchSaves = () => {
    if (session.stop_save_watch) {
      return;
    }

    // Connect refuses during a save, so watching starts between saves.
    let saving = false;
    let writesPost = false;
    let autosave = false;
    session.stop_save_watch = wp.data.subscribe(() => {
      const now = editor.isSavingPost();

      // Autosaving a published post writes only a revision; autosaving a
      // draft writes the post itself, as every other save does.
      if (!saving && now) {
        autosave = Boolean(editor.isAutosavingPost?.());
        writesPost =
          !autosave || ['draft', 'auto-draft'].includes(String(editor.getCurrentPost().status));
      }

      // A listener must never throw into the editor's own dispatch. An
      // unreadable record leaves no baseline, so the next save refuses.
      if (saving && !now && writesPost && editor.didPostSaveRequestSucceed()) {
        try {
          session.persisted = loadedPost();
          session.baseline = fields(session.persisted);
          // Core posts meta box forms after full saves, never autosaves.
          session.meta_box_save ||=
            !autosave && (wp.data.select('core/edit-post')?.hasMetaBoxes() ?? false);
        } catch {
          session.baseline = {};
        }
      }

      saving = now;
    });
  };

  // A plugin can lock saving while it checks the draft, as ACF does for about
  // a second after a block's fields change. Wait for it instead of refusing.
  const savingUnlocked = async () => {
    const until = Date.now() + Math.min(10000, remainingMs());

    while (editor.isPostSavingLocked() && Date.now() < until) {
      await pause(50);
    }
  };

  // Native autosave in a user's editor runs on its own schedule and finishes
  // within about a second. Wait for it instead of refusing the operation.
  const nativeSaveSettled = async () => {
    const until = Date.now() + Math.min(10000, remainingMs());

    while (editor.isSavingPost() && Date.now() < until) {
      await pause(50);
    }
  };

  const pending = (): JsonObject => {
    const edits = wp.data
      .select('core')
      .getEntityRecordNonTransientEdits('postType', target.post_type, target.post_id);
    const values = Object.fromEntries(
      Object.keys(edits).flatMap((name) =>
        name === 'content' ? [] : [[name, editor.getEditedPostAttribute(name)]],
      ),
    );
    const copied = JSON.parse(JSON.stringify(values));
    assert(v.is(JsonObjectSchema, copied), 'unsupported_pending_settings');

    return copied;
  };

  const livePost = (): Post => {
    const current: Post = { ...loadedPost(), content: { raw: documentContent(wp) } };

    for (const [name, value] of Object.entries(pending())) {
      assert(value !== undefined, 'unsupported_pending_settings');

      if (['title', 'excerpt'].includes(name)) {
        assert(v.is(v.string(), value), 'unsupported_pending_settings');
        current[name] = { raw: value };
      } else {
        current[name] = value;
      }
    }

    return current;
  };

  const rows = () => readTree(wp, documentBlocks(wp));
  // Synchronous on purpose: a guard that compares this state must run in the
  // same task as the reset or save it protects, with no await in between.
  const liveState = () =>
    JSON.stringify(
      canonical([
        session.editor_instance,
        fields(livePost(), ['date_gmt']),
        rows().map((row) => ({ client_id: row.clientId, ...blockState([row])[0] })),
      ]),
    );
  const savedToken = (post: Post) =>
    hash([fields(post, ['date_gmt']), post.modified_gmt ?? null, post.modified ?? null]);

  const pauseAutosave = () => {
    if (session.workflow === 'attached') {
      actions.lockPostAutosaving(mutationKey);
    }
  };

  return {
    wp,
    session,
    target,
    editor,
    actions,
    fields,
    sameDocument,
    available,
    fresh,
    matchesSaved,
    watchSaves,
    nativeSaveSettled,
    savingUnlocked,
    loadedPost,
    pending,
    livePost,
    rows,
    liveState,
    savedToken,
    pauseAutosave,
  };
}

type Context = ReturnType<typeof editorContext>;

function observedState(row: BlockSummary): Observed {
  return {
    name: row.name,
    attributes: JSON.stringify(canonical(row.attributes)),
    children: sharedReference(row.block)
      ? ''
      : (row.block.innerBlocks ?? []).map((child) => child.clientId).join(','),
  };
}

function rootState(wp: WordPress): Observed {
  return {
    name: '',
    attributes: '',
    children: documentBlocks(wp)
      .map((block) => block.clientId)
      .join(','),
  };
}

// Record what the agent has now seen. Without ids, the whole document.
function observe(context: Context, rows: BlockSummary[], ids?: Set<string>) {
  const observed = context.session.observed;

  for (const row of rows) {
    if (!ids || ids.has(row.clientId)) {
      observed[row.clientId] = observedState(row);
    }
  }

  if (!ids || ids.has('')) {
    observed[''] = rootState(context.wp);
  }
}

// Connect's result may omit these children, so they stay unread and a background
// save asks for a read first.
function leaveUnread(context: Context, filled: Block[]) {
  const observed = context.session.observed;

  for (const block of filled) {
    observed[block.clientId] = { ...observed[block.clientId], children: '' };

    // A stale entry rather than none, because reconnect treats a block it has
    // no entry for as seen.
    for (const row of readTree(context.wp, block.innerBlocks ?? [])) {
      observed[row.clientId] = { name: row.name, attributes: '', children: '' };
    }
  }
}

// Record only the document fields this session wrote, so a foreign change to
// another setting still refuses a later edit of that setting.
function observeFields(context: Context, settings: SettingsPlan) {
  const live = context.fields(context.livePost(), ['date_gmt']);
  const observed = context.session.observed_fields;

  for (const name of Object.keys(settings.values)) {
    if (name === 'meta') {
      const before = v.parse(JsonObjectSchema, observed.meta ?? {});
      const meta = v.parse(JsonObjectSchema, live.meta);
      observed.meta = {
        ...before,
        ...Object.fromEntries(settings.meta_keys.map((key) => [key, meta[key]])),
      };
    } else {
      observed[name] = live[name];
    }
  }
}

function changedKeys(before: string, after: string): string[] {
  const parse = (value: string) => {
    const parsed = JSON.parse(value || '{}');

    return v.is(JsonObjectSchema, parsed) ? parsed : {};
  };

  const a = parse(before);
  const b = parse(after);

  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !same(a[key], b[key]))
    .slice(0, 20);
}

// Foreign changes since Blockwork last observed a block refuse only the edits
// that depend on that block. Typing elsewhere in the draft never blocks.
function checkConflicts(context: Context, rows: BlockSummary[], touched: Touch[]) {
  const observed = context.session.observed;
  const byId = new Map(rows.map((row) => [row.clientId, row]));
  const conflicts: JsonObject[] = [];
  const seen = new Set<string>();

  const check = (id: string, kind: Touch['kind'], editIndex: number) => {
    if (seen.has(`${id}:${kind}`)) {
      return;
    }

    seen.add(`${id}:${kind}`);
    const row = byId.get(id);
    const live = row ? observedState(row) : rootState(context.wp);
    const before = observed[id];

    if (!before) {
      conflicts.push({
        client_id: id,
        name: row?.name,
        changed: ['not_read'],
        edit_index: editIndex,
      });

      return;
    }

    const changed = [];

    if (kind !== 'children' && live.attributes !== before.attributes) {
      changed.push(...changedKeys(before.attributes, live.attributes));
    }

    if (kind !== 'attributes' && live.children !== before.children) {
      changed.push('children');
    }

    if (changed.length) {
      conflicts.push({
        client_id: id,
        name: row?.name,
        path: row?.path,
        changed,
        edit_index: editIndex,
      });
    }
  };

  for (const touch of touched) {
    if (touch.kind !== 'subtree') {
      check(touch.client_id, touch.kind, touch.edit_index);
      continue;
    }

    const root = byId.get(touch.client_id);

    for (const row of rows) {
      if (
        root &&
        row.path.length >= root.path.length &&
        root.path.every((index, depth) => row.path[depth] === index)
      ) {
        check(row.clientId, 'subtree', touch.edit_index);
      }
    }
  }

  assert(!conflicts.length, 'block_changed', {
    conflicts: conflicts.slice(0, 20),
    conflict_count: conflicts.length,
  });
}

// A tab opened moments ago may still be starting Gutenberg. Its editor store
// reports no post until setup, and the block editor receives the post's
// blocks a moment later. Both are waits, not another or an empty document.
const editorStartMs = 10000;

// The startup stage the tab is still in, or undefined once it is ready.
function startStage(wp: WordPress | undefined): string | undefined {
  // The store reports a null post until setup finishes. The Editor type
  // leaves that out because every other caller runs after connect.
  const loaded = Boolean(wp?.data && wp.blocks && wp.apiFetch);
  const editor = loaded ? wp?.data.select('core/editor') : undefined;
  const postId = editor?.getCurrentPostId();

  if (!wp || !editor || postId === null || postId === undefined) {
    return 'editor_start';
  }

  if (!editor.getEditorBlocks?.().length) {
    return;
  }

  const blockEditor = wp.data.select('core/block-editor');
  const roots = blockEditor.getBlocks();
  // The Navigation screen's editor-only wrapper arrives before its children.
  const synced =
    editor.getCurrentPostType() === 'wp_navigation'
      ? roots.length === 1 && blockEditor.getBlocks(roots[0].clientId).length > 0
      : roots.length > 0;

  return synced ? undefined : 'block_sync';
}

async function startedEditor(): Promise<WordPress> {
  const waitMs = Math.max(0, Math.min(editorStartMs, remainingMs()));
  const until = Date.now() + waitMs;

  for (;;) {
    const wp = window.wp;
    const stage = startStage(wp);

    if (wp && !stage) {
      return wp;
    }

    assert(Date.now() < until, 'editor_unavailable', { stage, waited_ms: waitMs });
    await pause(100);
  }
}

async function connect(input: Connection): Promise<JsonObject> {
  // A session left by an earlier engine build has a different shape.
  const existing =
    window.__blockwork_editor?.protocol === 4 ? window.__blockwork_editor : undefined;
  let wp: WordPress | undefined;
  let created: Session | undefined;
  let acquired: Session | undefined;

  try {
    requireSignIn();
    wp = await startedEditor();
    // authenticate checks this too, but connect starts its document reads
    // beside authenticate.
    requireSupportedWordPress();
    const editor = wp.data.select('core/editor');
    assert(
      editor.getCurrentPostId() === input.target.post_id &&
        editor.getCurrentPostType() === input.target.post_type,
      'target_mismatch',
      { editor: { post_id: editor.getCurrentPostId(), post_type: editor.getCurrentPostType() } },
    );

    // A released background tab stopped renewing its lock and must close.
    assert(window.__blockwork_release?.workflow !== 'background', 'document_released');
    // An older build's session may hold locks this build cannot release.
    assert(
      !window.__blockwork_editor ||
        (window.__blockwork_editor.protocol === 4 &&
          Array.isArray(window.__blockwork_editor.media_references)),
      'session_from_older_build',
    );

    if (existing) {
      assert(!existing.busy, 'operation_in_progress');
      assert(existing.workflow === input.workflow, 'workflow_mismatch');
      assert(same({ ...existing.target, user_id: undefined }, input.target), 'target_mismatch');
    }

    const [user, [schema, saved]] = await Promise.all([
      authenticate(wp, { site_url: input.target.site_url }),
      (async () => {
        const contract = await documentContract(wp, input.target);
        const post = await postRecord(
          wp,
          contract.collection,
          input.target.post_id,
          documentReadFields(contract),
        );
        assert(v.is(PostSchema, post), 'post_mismatch');
        checkContentSize(post.content.raw);

        return [contract, post] as const;
      })(),
    ]);
    const target = { ...input.target, user_id: user.id };
    assert(v.is(TargetSchema, target), 'target_mismatch');
    assert(!existing || existing.target.user_id === user.id, 'user_mismatch', {
      expected_user_id: existing?.target.user_id,
      signed_in_user_id: user.id,
    });
    checkSharedRecord(saved, target);
    // Another connect may have installed a session while this one awaited.
    const current = window.__blockwork_editor;
    assert((current?.protocol === 4 ? current : undefined) === existing, 'operation_in_progress');
    const session: Session = existing ?? {
      protocol: 4,
      target,
      workflow: input.workflow,
      editor_instance: crypto.randomUUID(),
      user,
      busy: false,
      schema,
      persisted: saved,
      baseline: {},
      persistence: 'not_attempted',
      observed: {},
      observed_fields: {},
      requested: {},
      references: [],
      shared_references: {},
      media_references: [],
      edit_count: 0,
    };

    assert(!session.busy, 'operation_in_progress');
    session.busy = true;
    acquired = session;
    session.schema = schema;
    session.user = user;

    if (!existing) {
      created = session;
      window.__blockwork_editor = session;
      window.__blockwork_release = undefined;
    }

    const context = editorContext(wp, session);
    context.available();

    const loadedFields = context.fields(context.loadedPost());
    const savedFields = context.fields(saved);
    // core-data blanks the title of every auto-draft it loads, while REST keeps
    // the stored placeholder, which is translated. The loaded title therefore
    // says nothing about the saved one.
    const autoDraftTitle =
      loadedFields.status === 'auto-draft' &&
      savedFields.status === 'auto-draft' &&
      loadedFields.title === '';
    const comparableLoaded = autoDraftTitle
      ? { ...loadedFields, title: savedFields.title }
      : loadedFields;

    let confirmedSave = false;

    if (created) {
      const changed = differingFields(comparableLoaded, savedFields);
      assert(!changed.length, 'saved_record_changed', { fields: changed });
      session.baseline = context.fields(saved);
      context.watchSaves();
    } else if (
      session.save?.attempted &&
      (await receiptMatch(
        wp,
        context.fields(saved, session.save.receipt.date_fields),
        session.save.receipt,
      )) === 'matched'
    ) {
      // An uncertain save of this session reached WordPress.
      session.baseline = context.fields(saved);
      session.meta_box_save = false;
      confirmedSave = true;
    } else {
      context.matchesSaved(saved);
    }

    if (session.workflow === 'background') {
      const requireInitialState = (wp: WordPress) => {
        const normalized = nativeNormalization(wp, saved.content.raw);
        const content = documentContent(wp);
        // Gutenberg fills a new post from its type's template as the editor
        // loads, without a pending edit. Admit exactly that native result.
        const template = editor.getEditorSettings().template;
        const initialContent =
          content === saved.content.raw ||
          (savedFields.status === 'auto-draft' &&
            Array.isArray(template) &&
            content ===
              wp.blocks.serialize(
                wp.blocks.synchronizeBlocksWithTemplate(
                  wp.blocks.parse(saved.content.raw),
                  template,
                ),
              ));
        // Reopening an auto-draft supplies that same placeholder as an initial
        // title edit. Admit no other pending field or content changes.
        const pendingFields = Object.entries(context.pending()).flatMap(([name, value]) =>
          autoDraftTitle && name === 'title' && value === savedFields.title ? [] : [name],
        );
        const dirty = editor.isEditedPostDirty();
        assert(
          (!dirty && content === saved.content.raw) ||
            normalized ||
            (autoDraftTitle && !pendingFields.length && initialContent) ||
            (!dirty && templateFills(wp, saved.content.raw).length),
          'editor_not_clean',
          { fields: pendingFields.slice(0, 20), content_changed: !initialContent },
        );
      };

      if (created) {
        requireInitialState(wp);
        context.actions.lockPostAutosaving(sessionKey);
        await showVisualEditor(wp);

        // Only the post editor takes post locks, and it supplies postLockUtils
        // to release them. The Site Editor, which edits templates, template
        // parts, and navigation, neither takes nor checks them, so those
        // documents rely on the saved-record checks before each save.
        if (editor.getEditorSettings().postLockUtils && v.is(v.number(), saved.id)) {
          session.lock_post_id = saved.id;
        }
      }

      await pulse(context);

      // Observing the tree below would otherwise mark a change that arrived
      // during the lock request as read.
      if (created) {
        requireInitialState(wp);
      }
    }

    if (input.unsaved_preview && !session.preview) {
      const actions = context.actions;
      assert(
        actions.lockPostSaving && actions.unlockPostSaving && editor.isPostAutosavingLocked,
        'unsaved_preview_unavailable',
      );
      // Only exact restoration of this initial draft releases these locks.
      session.preview = {
        state: context.liveState(),
        saved_token: await context.savedToken(saved),
        dirty: editor.isEditedPostDirty(),
        pending: context.pending(),
        blocks: copyTree(documentBlocks(wp)),
      };
      actions.lockPostAutosaving(previewKey(session));
      actions.lockPostSaving(previewKey(session));
    }

    assert(!session.preview || input.unsaved_preview, 'unsaved_preview_flag_required');
    // Reconnecting re-baselines persistence, for example after recover
    // settled an uncertain save.
    session.persisted = saved;

    if (confirmedSave) {
      clearConfirmedSave(session);
      session.persistence = 'verified';

      if (session.last_request) {
        session.last_request.outcome = 'saved';
        session.last_request.error = undefined;
      }
    }

    session.save = undefined;
    const rows = context.rows();
    let filled: Block[] = [];

    // A new session starts from the current draft. Reconnecting keeps what was
    // already observed, so earlier foreign changes still refuse dependent edits.
    if (created) {
      observe(context, rows);

      if (session.workflow === 'background' && documentContent(wp) !== saved.content.raw) {
        filled = templateFills(wp, saved.content.raw);
        leaveUnread(context, filled);
      }

      session.observed_fields = context.fields(context.livePost(), ['date_gmt']);
      session.expected_state = context.liveState();
    } else {
      const known = new Set(Object.keys(session.observed));
      observe(
        context,
        rows,
        new Set(['', ...rows.map((row) => row.clientId)].filter((id) => !known.has(id))),
      );
    }

    const projection = await projectInspection(wp, rows, input);
    const shared = sharedType(target.post_type);

    return {
      ok: true,
      target,
      user,
      workflow: session.workflow,
      editor_instance: session.editor_instance,
      save: session.workflow === 'attached' ? 'explicit_request_only' : 'default_completion',
      title: saved.title?.raw ?? '',
      status: saved.status,
      link: permalink(saved),
      dirty: editor.isEditedPostDirty(),
      editor_mode: session.workflow === 'attached' ? editor.getEditorMode?.() : undefined,
      ...projection,
      custom_blocks: customBlocks(wp),
      native_selection: session.workflow === 'attached' ? nativeSelection(wp, rows) : undefined,
      settings: input.settings ? bounded(settingsGuide(context.livePost(), schema)) : undefined,
      entity: shared ? entitySummary(saved, target) : undefined,
      normalization_required:
        session.workflow === 'background' ? nativeNormalization(wp, saved.content.raw) : undefined,
      template_fills: filled.length
        ? {
            blocks: filled
              .slice(0, 20)
              .map((block) => ({
                client_id: block.clientId,
                name: block.name,
                path: rows.find((row) => row.clientId === block.clientId)?.path ?? [],
              })),
            block_count: filled.length,
          }
        : undefined,
      unsaved_preview: Boolean(session.preview),
    };
  } catch (error) {
    if (created && wp) {
      // A failed first connection leaves no session, lock key, or preview.
      if (created.workflow === 'background') {
        wp.data.dispatch('core/editor').unlockPostAutosaving(sessionKey);
      }

      if (created.preview) {
        wp.data.dispatch('core/editor').unlockPostAutosaving(previewKey(created));
        wp.data.dispatch('core/editor').unlockPostSaving?.(previewKey(created));
      }

      created.stop_save_watch?.();
      window.__blockwork_editor = undefined;
    }

    const result = failure(error, existing ?? window.__blockwork_editor);

    // Before connect succeeds the caller has no target for status(), and a
    // later connect joins the session once the running operation finishes.
    return result.error === 'operation_in_progress' ? { ...result, next: 'retry' } : result;
  } finally {
    // Only clear the flag this call set; a refused reconnect must not mark a
    // still-running operation idle.
    if (acquired) {
      acquired.busy = false;
    }
  }
}

function previewKey(session: Session) {
  return `blockwork/unsaved_preview/${session.editor_instance}`;
}

function nativeSelection(wp: WordPress, rows: BlockSummary[]): JsonObject {
  const store = wp.data.select('core/block-editor');
  const start = store.getSelectionStart?.() ?? {};
  const end = store.getSelectionEnd?.() ?? {};
  const selected =
    store.getSelectedBlockClientIds?.() ??
    [start.clientId, end.clientId].flatMap((id) => (id ? [id] : []));

  return {
    start: { ...start },
    end: { ...end },
    blocks: rows.flatMap((row) =>
      selected.includes(row.clientId)
        ? [{ client_id: row.clientId, path: row.path, name: row.name }]
        : [],
    ),
  };
}

type ReadInput = Extract<EditorRequest, { operation: 'read' }>;

// A saved document read through this editor's registrations, so an agent can
// copy how other pages are built. It never touches this editor's draft.
async function readSource(
  context: Context,
  input: ReadInput & { source: NonNullable<ReadInput['source']> },
): Promise<JsonObject> {
  const { wp, session, target } = context;
  const guides = ['attribute_guide', 'style_guides', 'insertion', 'patterns', 'settings'] as const;
  const extra = guides.filter((name) => input[name] !== undefined && input[name] !== false);
  assert(!extra.length, 'source_read_blocks_only', { fields: extra });

  const source = { ...target, ...input.source };
  const [user, contract] = await Promise.all([
    authenticate(wp, target),
    documentContract(wp, source),
  ]);
  assert(user.id === target.user_id, 'user_mismatch');
  const post = await postRecord(wp, contract.collection, source.post_id).catch((cause: unknown) => {
    const native = v.safeParse(ApiErrorSchema, cause);

    if (native.success && native.output.data?.status === 404) {
      throw new BlockworkError(
        'source_not_found',
        { post_id: source.post_id, post_type: source.post_type },
        { cause },
      );
    }

    throw cause;
  });
  assert(v.is(PostSchema, post), 'post_mismatch');
  checkContentSize(post.content.raw);
  checkSharedRecord(post, source);
  const key = `${source.post_type}:${source.post_id}`;
  const token = await hash(post.content.raw);
  let cached = session.sources?.[key];

  if (cached?.token !== token) {
    cached = { token, blocks: wp.blocks.parse(post.content.raw) };
    session.sources = { ...session.sources, [key]: cached };
  }

  const projection = await projectInspection(wp, readTree(wp, cached.blocks), input, false);

  return {
    ok: true,
    source: {
      ...input.source,
      title: post.title?.raw ?? '',
      status: post.status,
      link: permalink(post),
    },
    ...projection,
  };
}

// WordPress's permalink. A draft's link opens for signed-in editors.
function permalink(post: Post): string | undefined {
  return v.is(v.string(), post.link) ? post.link : undefined;
}

const RevisionLinksSchema = v.object({
  'predecessor-version': v.pipe(v.array(v.object({ id: v.number() })), v.minLength(1)),
});

// WordPress links a saved record to its latest revision. Its revisions screen
// compares and restores revisioned fields such as title and content, the
// native undo for those. A save that changed no revisioned field adds no
// revision, and slug, status, parent, and terms are never revisioned. Post
// types without revisions, and sites that disable them, have no link.
function revisions(post: Post): JsonObject | null {
  const links = v.safeParse(RevisionLinksSchema, post._links);

  if (!links.success) {
    return null;
  }

  const id = links.output['predecessor-version'][0].id;

  return { latest_id: id, url: new URL(`revision.php?revision=${id}`, location.href).href };
}

async function read(context: Context, input: ReadInput): Promise<JsonObject> {
  if (input.source) {
    return readSource(context, { ...input, source: input.source });
  }

  context.sameDocument();
  const rows = context.rows();
  const projection = await projectInspection(context.wp, rows, input);
  const ids = new Set<string>();

  for (const block of v.is(v.array(JsonObjectSchema), projection.blocks) ? projection.blocks : []) {
    if (v.is(v.string(), block.client_id)) {
      ids.add(block.client_id);
    }
  }

  for (const guide of input.style_guides ?? []) {
    if ('client_id' in guide) {
      ids.add(guide.client_id);
    }
  }

  if (input.attribute_guide && 'client_id' in input.attribute_guide) {
    ids.add(input.attribute_guide.client_id);
  }

  // A depth read without client_id starts at the root, like roots.
  if (
    v.is(v.string(), input.blocks) ||
    !('client_id' in input.blocks || 'search' in input.blocks || 'name' in input.blocks)
  ) {
    ids.add('');
  }

  observe(context, rows, ids);

  if (input.settings) {
    context.session.observed_fields = context.fields(context.livePost(), ['date_gmt']);
  }

  return {
    ok: true,
    dirty: context.editor.isEditedPostDirty(),
    ...projection,
    native_selection:
      context.session.workflow === 'attached' ? nativeSelection(context.wp, rows) : undefined,
    settings: input.settings
      ? bounded(settingsGuide(context.livePost(), context.session.schema))
      : undefined,
  };
}

// Authored markup becomes ordinary tree inserts before planning.
function expandEdits(wp: WordPress, input: EditInput) {
  const edits = [];

  for (const [editIndex, edit] of input.edits.entries()) {
    if (edit.op !== 'insert' && edit.op !== 'replace') {
      edits.push(edit);
      continue;
    }

    const { markup, media_map: mediaMap, link_map: linkMap, ...rest } = edit;
    let blocks;

    try {
      const given = markup === undefined ? [rest.block] : markupBlocks(wp, markup, 'create');
      const present = given.filter((block) => block !== undefined);
      blocks = mediaMap || linkMap ? retargetBlocks(present, mediaMap, linkMap) : present;
    } catch (error) {
      if (error instanceof BlockworkError) {
        const fields = new Map([
          ['unmapped_media_url', 'media_map'],
          ['unmapped_internal_link', 'link_map'],
        ]);
        throw new BlockworkError(error.code, {
          ...error.diagnostics,
          edit_index: editIndex,
          field: `edits.${editIndex}.${fields.get(error.code) ?? 'markup'}`,
        });
      }

      throw error;
    }

    if (rest.op === 'replace') {
      assert(blocks.length === 1, 'invalid_replacement_markup', {
        edit_index: editIndex,
        field: `edits.${editIndex}.markup`,
        block_count: blocks.length,
      });
      edits.push({ ...rest, block: blocks[0] });
    } else {
      for (const [offset, block] of blocks.entries()) {
        edits.push({
          ...rest,
          block,
          index: rest.index === undefined ? undefined : rest.index + offset,
        });
      }
    }
  }

  assert(edits.length <= 32, 'too_many_edits', { edit_count: edits.length, max_edits: 32 });

  return edits;
}

function emptySettings(context: Context): SettingsPlan {
  return {
    values: {},
    original: {},
    meta_keys: [],
    schema_token: context.session.schema.token,
    references: [],
    date_fields: [],
    binding_writes: [],
  };
}

// The primary blocks of each edit: updated targets and new subtree roots.
function primaryBlocks(plan: Plan): string[] {
  const ids = plan.steps.flatMap((step) => {
    if (step.blocks.length) {
      return step.blocks.map((block) => block.clientId);
    }

    if ('path' in step.edit && step.edit.op !== 'remove') {
      let list = step.before;
      let block: Block | undefined;

      for (const index of step.edit.path) {
        block = list[index];
        list = block?.innerBlocks ?? [];
      }

      return block ? [block.clientId] : [];
    }

    return [];
  });

  return [...new Set(ids)];
}

// Named fields that no longer hold the given values. Callers check this
// synchronously right before writing settings, with no await in between.
function changedFields(context: Context, values: JsonObject, names: string[]): string[] {
  const live = context.fields(context.livePost(), ['date_gmt']);

  return names.flatMap((name) => differingFields({ [name]: values[name] }, { [name]: live[name] }));
}

function draftBlocks(context: Context, blocks: Block[]): JsonValue {
  const rows = readTree(context.wp, blocks).map((row) => ({
    client_id: row.clientId,
    ...blockState([row])[0],
  }));

  return JSON.parse(JSON.stringify(rows));
}

function draftState(context: Context): DraftState {
  const { wp, target, editor } = context;
  const core = wp.data.select('core');
  assert(wp.blocks.__unstableSerializeAndClean, 'native_readiness_unavailable');
  const raw = core.getEntityRecordNonTransientEdits('postType', target.post_type, target.post_id);
  // Read keys before cloning. JSON drops callable content and undefined keys.
  const entries = Object.entries(raw).filter(([, value]) => value !== undefined);
  const pendingKeys = entries.map(([key]) => key).sort();
  const pending = Object.fromEntries(
    entries.map(([key, value]) => {
      const callable = v.is(v.function(), value);
      assert(!callable || key === 'content', 'unsupported_pending_settings');

      if (callable) {
        const record = core.getEditedEntityRecord?.('postType', target.post_type, target.post_id);
        assert(record, 'editor_record_unavailable');
        value = value(record);
      }

      return [key, { callable, value }];
    }),
  );

  return {
    blocks: draftBlocks(context, documentBlocks(wp)),
    fields: context.fields(context.livePost(), ['date_gmt']),
    pending: v.parse(JsonObjectSchema, JSON.parse(JSON.stringify(pending))),
    pending_keys: pendingKeys,
    dirty: editor.isEditedPostDirty(),
  };
}

function draftTransition(
  context: Context,
  before: DraftState,
  actual: DraftState,
  blocks: Block[],
  values?: JsonObject,
  restoring = false,
): boolean {
  const fields = { ...before.fields, ...values };
  const pending = { ...before.pending };
  const saved = context.fields(context.loadedPost(), ['date_gmt']);

  if (values?.meta) {
    fields.meta = {
      ...v.parse(JsonObjectSchema, before.fields.meta),
      ...v.parse(JsonObjectSchema, values.meta),
    };
  }

  if (values) {
    for (const name of Object.keys(values)) {
      if (same(fields[name], saved[name])) {
        delete pending[name];
      } else {
        pending[name] = { callable: false, value: fields[name] };
      }
    }
  } else {
    fields.content = context.wp.blocks.__unstableSerializeAndClean!(blocks);
    const content = actual.pending.content;

    if (content !== undefined) {
      const entry = v.parse(JsonObjectSchema, content);
      const value = v.is(v.string(), entry.value)
        ? entry.value
        : v.parse(JsonObjectSchema, entry.value).raw;

      if (
        !same(value, fields.content) ||
        (entry.callable !== true && !same(content, before.pending.content))
      ) {
        return false;
      }

      pending.content = content;
    } else if (before.pending.content !== undefined) {
      return false;
    }
  }

  const dirty =
    values || restoring
      ? Object.keys(pending).length > 0 || !same(fields.content, saved.content)
      : true;

  return same(actual, {
    blocks: draftBlocks(context, blocks),
    fields,
    pending,
    pending_keys: Object.keys(pending).sort(),
    dirty,
  });
}

function verifyDraftTransition(context: Context, draft: DraftCheckpoint, blocks: Block[]): void {
  const actual = draftState(context);
  const dispatch = draft.dispatch;
  const expectedBlocks = dispatch?.values ? dispatch.blocks : blocks;
  const matches = dispatch
    ? draftTransition(context, draft.current, actual, expectedBlocks, dispatch.values)
    : same(actual, draft.current);

  if (!matches) {
    const mismatches = blockMismatches(readTree(context.wp, expectedBlocks), context.rows(), true);
    assert(
      !Array.isArray(mismatches.blocks) || !mismatches.blocks.length,
      'prepared_content_changed',
      { mismatches },
    );
    const fields: JsonObject = {
      ...draft.current.fields,
      ...dispatch?.values,
      content: actual.fields.content,
    };

    if (dispatch?.values?.meta) {
      fields.meta = {
        ...v.parse(JsonObjectSchema, draft.current.fields.meta),
        ...v.parse(JsonObjectSchema, dispatch.values.meta),
      };
    }

    const changed = differingFields(fields, actual.fields);
    assert(!changed.length, 'field_changed', { fields: changed.slice(0, 20) });
    throw new BlockworkError('intervening_editor_change', {
      stage: 'draft_transition',
      changed_since_checkpoint: ['pending', 'pending_keys', 'dirty'].filter(
        (key) => !same(actual[key], draft.current[key]),
      ),
    });
  }

  draft.current = actual;
  draft.dispatch = undefined;
}

async function restoreOrdinary(
  context: Context,
  plan: Plan,
  settings: SettingsPlan,
  draft: DraftCheckpoint,
  beforeMutation: () => void,
): Promise<boolean> {
  const { wp, target } = context;
  let current = draftState(context);
  const dispatch = draft.dispatch;
  const owned =
    same(current, draft.current) ||
    (dispatch &&
      draftTransition(context, draft.current, current, dispatch.blocks, dispatch.values));

  if (!owned) {
    return false;
  }

  const guard = () => {
    context.available();
    assert(same(draftState(context), current), 'intervening_editor_change');
  };

  if (plan.steps.length) {
    const previous = current;
    // restorePlan calls this guard synchronously after its async date preflight.
    await restorePlan(wp, plan, guard, beforeMutation);
    const restored = draftState(context);
    assert(
      draftTransition(context, previous, restored, draft.original, undefined, true),
      'intervening_editor_change',
    );
    current = restored;
  }

  if (draft.settings_dispatched) {
    guard();
    const previous = current;
    const values = settingsPatch(settings, true);
    beforeMutation();
    await context.actions.editPost(values);
    const restored = draftState(context);
    assert(
      draftTransition(context, previous, restored, draft.original, values, true),
      'intervening_editor_change',
    );
    current = restored;
  }

  if (!same(current, draft.before)) {
    // RESET_BLOCKS creates a content callback even for a formerly clean document.
    // Clear only that known marker after every other part of the original matches.
    const content = v.parse(JsonObjectSchema, current.pending.content);
    const expected = {
      ...draft.before,
      fields: {
        ...draft.before.fields,
        content: wp.blocks.__unstableSerializeAndClean!(draft.original),
      },
      pending: { ...draft.before.pending, content },
      pending_keys: [
        ...draft.before.pending_keys.filter((key) => key !== 'content'),
        'content',
      ].sort(),
      dirty: true,
    };
    assert(
      same(current, expected) &&
        content.callable === true &&
        same(content.value, expected.fields.content),
      'intervening_editor_change',
    );
    const write = wp.data.dispatch('core').editEntityRecord;
    assert(write, 'native_revert_state_unavailable');
    const original = draft.before.pending.content;
    const value = original === undefined ? undefined : v.parse(JsonObjectSchema, original).value;
    const values: JsonObject = { content: value };

    if (!draft.entity_blocks) {
      values.blocks = undefined;
    }

    const clear = () => {
      guard();
      beforeMutation();
      write('postType', target.post_type, target.post_id, values, { undoIgnore: true });
    };

    if (wp.element?.flushSync) {
      wp.element.flushSync(clear);
    } else {
      clear();
    }

    await pause(0);
    current = draftState(context);
    assert(same(current, draft.before), 'intervening_editor_change', {
      stage: 'restore_original_draft',
      fields: differingFields(draft.before.fields, current.fields).slice(0, 20),
    });
  }

  await pause(0);
  context.available();
  assert(same(draftState(context), draft.before), 'intervening_editor_change');

  return true;
}

// Remember that the draft changed outside Blockwork since its last operation.
// Preview release then refuses to restore, since that would erase the change.
function noteForeignChanges(context: Context) {
  const { session } = context;

  if (session.expected_state && context.liveState() !== session.expected_state) {
    session.foreign_change = true;
  }
}

// Blocks and child lists in the draft that Blockwork neither produced nor
// returned from a read. A background save requires none.
function unseenBlocks(context: Context, rows: BlockSummary[]): JsonObject[] {
  const observed = context.session.observed;
  const unseen: JsonObject[] = rows.flatMap((row) => {
    const before = observed[row.clientId];
    const current = observedState(row);

    return before &&
      before.attributes === current.attributes &&
      before.children === current.children
      ? []
      : [{ client_id: row.clientId, name: row.name, path: row.path }];
  });

  if (observed['']?.children !== rootState(context.wp).children) {
    unseen.push({ client_id: '', name: 'root' });
  }

  return unseen;
}

// Record what this operation changed. Each block keeps its old observation
// for any part (attributes or children) that already differed from what
// Blockwork last saw, so a foreign change made earlier stays unseen.
function observeOwnChanges(
  context: Context,
  before: Map<string, Observed>,
  rootBefore: string,
  rows: BlockSummary[],
) {
  const observed = context.session.observed;

  for (const row of rows) {
    const previous = before.get(row.clientId);
    const current = observedState(row);
    const seen = observed[row.clientId];

    if (!previous) {
      observed[row.clientId] = current;
    } else if (
      seen &&
      (previous.attributes !== current.attributes || previous.children !== current.children)
    ) {
      observed[row.clientId] = {
        name: current.name,
        attributes: previous.attributes === seen.attributes ? current.attributes : seen.attributes,
        children: previous.children === seen.children ? current.children : seen.children,
      };
    }
  }

  if (observed['']?.children === rootBefore) {
    observed[''] = rootState(context.wp);
  }
}

function changedBlocks(before: Map<string, Observed>, rows: BlockSummary[]) {
  return rows.filter((row) => {
    const previous = before.get(row.clientId);
    const current = observedState(row);

    return (
      !previous ||
      previous.attributes !== current.attributes ||
      previous.children !== current.children
    );
  });
}

async function edit(context: Context, input: EditInput): Promise<JsonObject> {
  const { wp, session, editor, actions } = context;
  context.available();
  noteForeignChanges(context);

  if (session.workflow === 'attached' && !session.preview) {
    refuseAmbiguousUnion(wp, context.rows());
  }

  const shared = sharedType(context.target.post_type);
  assert(shared ? input.scope === shared.scope : !input.scope, 'shared_scope_required');
  const requested = expandEdits(wp, input);
  const footnoteOnly =
    !input.post &&
    !input.open_pattern_section &&
    !input.binding_writes.length &&
    !input.media_bindings.length &&
    same(Object.keys(input.settings ?? {}), ['meta']) &&
    same(Object.keys(input.settings?.meta ?? {}), ['footnotes']);
  const explicitFootnoteInput = footnoteOnly && explicitFootnoteRequest(wp, requested);
  const structuralFootnoteInput =
    !explicitFootnoteInput && structuralFootnoteRequest(wp, requested);

  if (structuralFootnoteInput) {
    assert(
      footnoteOnly ||
        (!input.post &&
          !input.settings &&
          !input.open_pattern_section &&
          !input.binding_writes.length &&
          !input.media_bindings.length),
      'unsupported_structural_edit',
      {
        constraint: 'footnote_separate_structural_request',
        next_step:
          'Submit root paragraph moves, removals or copies separately from other edits or settings. A complete settings.meta.footnotes list may accompany a copy.',
      },
    );
    requireRootFootnoteEdits(wp, requested);
  }

  const draftBefore = draftState(context);
  const originalBlocks = copyTree(documentBlocks(wp));
  const entity = wp.data
    .select('core')
    .getEditedEntityRecord?.('postType', context.target.post_type, context.target.post_id);
  assert(entity, 'editor_record_unavailable');
  const draft: DraftCheckpoint = {
    before: draftBefore,
    current: draftBefore,
    original: originalBlocks,
    entity_blocks: Array.isArray(entity.blocks),
    settings_dispatched: false,
  };
  const hasSettings =
    input.post || input.settings || input.binding_writes.length || input.media_bindings.length;
  let settings = hasSettings
    ? await prepareSettings(wp, input, context.livePost(), session.schema)
    : emptySettings(context);
  const media = await mediaEdits(wp, input.media_bindings);
  const edits = [...requested, ...media.edits];
  assert(edits.length <= 32, 'too_many_edits', { edit_count: edits.length, max_edits: 32 });
  assert(edits.length || Object.keys(settings.values).length, 'empty_edit');
  // A template change can change server-side editor policy. Save it before
  // changing structure that policy would govern.
  const structural = edits.some((item) => !attributeOps.includes(item.op));
  const policyChanges = [...Object.keys(session.requested), ...Object.keys(settings.values)].filter(
    (name) => policyFields.includes(name),
  );
  assert(!structural || !policyChanges.length, 'settings_before_structure', {
    fields: [...new Set(policyChanges)],
  });
  assert(!structural || !session.structure_requires_reload, 'reopen_required');

  const liveFields = draftBefore.fields;
  const writtenFields = new Set(Object.keys(settings.values));

  if (structuralFootnoteInput) {
    writtenFields.add('meta');
  }

  const fieldConflicts = [...writtenFields].flatMap((name) => {
    if (name === 'meta' && !structuralFootnoteInput && !explicitFootnoteInput) {
      const observed = v.parse(JsonObjectSchema, session.observed_fields.meta ?? {});
      const live = v.parse(JsonObjectSchema, liveFields.meta);

      return settings.meta_keys.flatMap((key) =>
        same(observed[key], live[key]) ? [] : [`meta.${diagnosticKey(key)}`],
      );
    }

    return differingFields({ [name]: session.observed_fields[name] }, { [name]: liveFields[name] });
  });
  assert(!fieldConflicts.length, 'field_changed', { fields: fieldConflicts.slice(0, 20) });

  if (input.open_pattern_section) {
    await openPatternSection(
      wp,
      context.rows(),
      input.open_pattern_section.section_client_id,
      context.available,
    );
  }

  const beforeRows = context.rows();
  const before = new Map(beforeRows.map((row) => [row.clientId, observedState(row)]));
  const rootBefore = rootState(wp).children;
  const stored = documentContent(wp);
  const content = plannedContent(wp, stored);
  const plan = await preparePlan(wp, edits, content, context.target);
  const rewritten = content === stored ? undefined : rewrittenBlocks(wp, beforeRows, stored);

  if (explicitFootnoteInput) {
    const declared = input.settings?.meta?.footnotes;
    assert(v.is(v.string(), declared), 'unsupported_field_value', {
      field: 'settings.meta.footnotes',
    });
    validateExplicitFootnotes(wp, plan, declared);
  } else if (!structuralFootnoteInput) {
    refuseUnpairedFootnoteChange(wp, plan);
  }

  refuseAmbiguousUnion(
    wp,
    beforeRows.filter((row) =>
      plan.touched.some((touch) => {
        const root = beforeRows.find((item) => item.clientId === touch.client_id);

        return touch.kind === 'attributes'
          ? row.clientId === touch.client_id
          : touch.kind === 'subtree' &&
              root &&
              root.path.every((index, depth) => row.path[depth] === index);
      }),
    ),
  );
  checkConflicts(context, beforeRows, plan.touched);
  assert(
    Object.keys(settings.values).length || wp.blocks.serialize(plan.blocks) !== content,
    'no_change',
  );

  let footnoteWrites: JsonObject | undefined;
  let footnotePermission: (() => void) | undefined;

  if (structuralFootnoteInput) {
    const meta = v.parse(JsonObjectSchema, liveFields.meta);
    assert(meta.footnotes === undefined || v.is(v.string(), meta.footnotes), 'meta_unavailable');
    const declared = input.settings?.meta?.footnotes;
    assert(declared === undefined || v.is(v.string(), declared), 'unsupported_field_value', {
      field: 'settings.meta.footnotes',
      next_step: 'Supply the complete final Footnote body list as a JSON string.',
    });
    const prepared = await prepareStructuralFootnotePlan(
      wp,
      plan,
      meta.footnotes ?? '',
      declared,
      session.observed,
    );
    footnoteWrites = { ...prepared.footnote_writes, requested_edits: input.edits.length };
    footnotePermission = prepared.permission;
    const post = context.livePost();
    const currentMeta = context.fields(post, ['date_gmt']).meta;
    // Compare the whole observed metadata immediately before deriving a settings plan.
    assert(same(session.observed_fields.meta, currentMeta), 'field_changed', {
      fields: ['meta'],
      stage: 'footnote_settings',
      next_step: 'Read the draft and complete settings before preparing another edit.',
    });
    settings = await prepareSettings(
      wp,
      { ...input, settings: { meta: { footnotes: prepared.footnotes } } },
      post,
      session.schema,
    );
    checkConflicts(context, beforeRows, plan.touched);
  }

  const galleryPermission = await prepareCompleteGallery(
    wp,
    plan,
    media,
    !input.post &&
      !input.open_pattern_section &&
      !input.binding_writes.length &&
      !Object.keys(settings.values).length,
  );
  const tabsPermission =
    !input.post &&
    !input.open_pattern_section &&
    !input.binding_writes.length &&
    !input.media_bindings.length &&
    !Object.keys(settings.values).length
      ? await prepareCompleteTabs(wp, plan)
      : undefined;
  const contextPermission =
    !input.post &&
    !input.open_pattern_section &&
    !input.binding_writes.length &&
    !input.media_bindings.length &&
    !Object.keys(settings.values).length
      ? await prepareCompleteContextMove(wp, plan)
      : undefined;
  const paired = structuralFootnoteInput || explicitFootnoteInput;

  if (explicitFootnoteInput) {
    await prepareExplicitFootnotePlan(wp, plan);
  }

  const readFields = () => context.fields(context.livePost(), ['date_gmt']);
  const footnote =
    paired || tabsPermission || galleryPermission || contextPermission
      ? footnoteCheckpoint(
          wp,
          plan,
          settings,
          liveFields,
          readFields,
          Boolean(tabsPermission || galleryPermission || contextPermission),
        )
      : undefined;
  const pendingBefore = context.pending();
  const dirtyBefore = draftBefore.dirty;
  const initialize = needsNativePreparation(plan);
  let mutated = false;
  let settingsApplied = false;
  context.pauseAutosave();

  try {
    if (footnote) {
      await applyExplicitFootnotes(
        wp,
        plan,
        settings,
        footnote,
        readFields,
        () => {
          mutated = true;
          settingsApplied = true;
        },
        context.available,
        session.workflow === 'background',
        footnotePermission ?? tabsPermission ?? galleryPermission ?? contextPermission,
        tabsPermission ? () => checkCompleteTabsChildren(wp, plan) : undefined,
      );
    } else {
      await applyPlan(
        wp,
        plan,
        () => {
          context.available();
          mutated = true;
        },
        initialize,
        session.workflow === 'background',
        (before, after) => {
          if (after) {
            assert(same(draftState(context), draft.current), 'intervening_editor_change');
            draft.dispatch = { blocks: copyTree(after) };
          } else {
            verifyDraftTransition(context, draft, before);
          }
        },
      );
    }

    if (!settingsApplied && Object.keys(settings.values).length) {
      context.available();
      const changed = changedFields(context, liveFields, Object.keys(settings.values));
      assert(!changed.length, 'field_changed', { fields: changed.slice(0, 20) });
      assert(same(draftState(context), draft.current), 'intervening_editor_change');
      const patch = settingsPatch(settings);
      draft.dispatch = { blocks: copyTree(documentBlocks(wp)), values: patch };
      mutated = true;
      settingsApplied = true;
      draft.settings_dispatched = true;
      await actions.editPost(patch);
      verifyDraftTransition(context, draft, documentBlocks(wp));
    }

    const liveRows = context.rows();
    const plannedRows = readTree(wp, plan.blocks);

    // Mismatch diagnostics scan the whole document, so build them only on failure.
    if (!same(blockState(liveRows), blockState(plannedRows))) {
      throw new BlockworkError('prepared_content_changed', {
        mismatches: blockMismatches(plannedRows, liveRows, true),
      });
    }

    const parsed = readTree(wp, wp.blocks.parse(wp.blocks.serialize(documentBlocks(wp))));

    if (!roundTripMatches(wp, liveRows, parsed)) {
      throw new BlockworkError(
        'serialization_mismatch',
        serializationDiagnostics(parsed, liveRows, 'edit_round_trip', 'parsed_to_live'),
      );
    }

    for (const [name, value] of Object.entries(settings.values)) {
      assert(
        same(context.fields(context.livePost(), settings.date_fields)[name], value),
        'prepared_settings_changed',
        { field: name },
      );
    }

    if (!footnote) {
      assert(same(draftState(context), draft.current), 'intervening_editor_change');
    }
  } catch (error) {
    if (mutated) {
      const rollback = async (): Promise<{
        outcome: 'rolled_back' | 'partial';
        failure?: Error;
      }> => {
        if (!footnote) {
          return rollBack(context, plan, settings, draft);
        }

        try {
          const restored = await restoreExplicitFootnotes(
            wp,
            context.target,
            footnote,
            readFields,
            context.available,
            () => {},
          );

          return { outcome: restored ? 'rolled_back' : 'partial', failure: undefined };
        } catch (cause) {
          return {
            outcome: 'partial',
            failure: new Error('The paired restore failed.', { cause }),
          };
        }
      };

      const { outcome, failure: rollbackFailure } = await rollback();

      if (footnote && outcome === 'partial') {
        session.footnote_recovery = true;
      }

      if (session.last_request) {
        session.last_request.outcome = outcome;
      }

      throw withOutcome(error, outcome, rollbackFailure);
    }

    throw error;
  }

  const afterRows = context.rows();
  const changed = changedBlocks(before, afterRows);
  observeOwnChanges(context, before, rootBefore, afterRows);

  observeFields(context, settings);
  const requestedBefore = session.requested;
  const referencesBefore = session.references;
  const mediaReferencesBefore = session.media_references;
  const sharedReferencesBefore = Object.fromEntries(
    Object.entries(session.shared_references).map(([id, owned]) => [
      id,
      {
        identity: { ...owned.identity },
        graph: owned.graph.map((reference) => ({ ...reference })),
      },
    ]),
  );
  const patch = settingsPatch(settings);
  session.requested = { ...session.requested, ...patch };

  if (patch.meta) {
    session.requested.meta = {
      ...v.parse(JsonObjectSchema, requestedBefore.meta ?? {}),
      ...v.parse(JsonObjectSchema, patch.meta),
    };
  }

  session.references = [...session.references, ...settings.references];
  const sharedReferences = { ...session.shared_references };

  for (const [id, owned] of Object.entries(plan.references)) {
    if (!sharedReferences[id] || !same(sharedReferences[id].identity, owned.identity)) {
      sharedReferences[id] = owned;
    }
  }

  session.shared_references = Object.fromEntries(
    Object.entries(sharedReferences).filter(([id, owned]) => {
      const row = afterRows.find((item) => item.clientId === id);

      return (
        row &&
        ['ref', 'slug', 'theme'].every((key) => same(row.attributes[key], owned.identity[key]))
      );
    }),
  );
  const mediaReferences = [...session.media_references];

  for (const [index, { binding }] of media.resolved.entries()) {
    const row = afterRows.find((item) => same(item.path, binding.path));
    const attribute =
      binding.bind.id ?? binding.bind.url ?? binding.bind.alt ?? binding.bind.size_slug;
    assert(row && attribute, 'invalid_media_binding');
    const value = media.edits[index].attributes[attribute];
    assert(value !== undefined, 'invalid_media_binding');

    const ownerIndex = mediaReferences.findIndex(
      (owned) =>
        owned.client_id === row.clientId &&
        owned.attribute === attribute &&
        same(owned.value, value),
    );
    const before = beforeRows.find((item) => item.clientId === row.clientId);
    const changed = Object.values(binding.bind).some(
      (key) => !same(before?.attributes[key], row.attributes[key]),
    );

    if (ownerIndex === -1 || changed) {
      const owned = {
        client_id: row.clientId,
        attribute,
        value,
        media_id: binding.media_id,
        ...media.references[index],
      };

      if (ownerIndex === -1) {
        mediaReferences.push(owned);
      } else {
        mediaReferences[ownerIndex] = owned;
      }
    }
  }

  session.media_references = mediaReferences.filter((owned) => {
    const row = afterRows.find((item) => item.clientId === owned.client_id);

    return row && same(row.attributes[owned.attribute], owned.value);
  });
  session.edit_count += 1;
  session.expected_state = context.liveState();
  session.last_edit = {
    footnote,
    draft: footnote ? undefined : draft,
    plan,
    settings,
    applied_state: session.expected_state,
    pending_before: pendingBefore,
    dirty_before: dirtyBefore,
    requested_before: requestedBefore,
    references_before: referencesBefore,
    shared_references_before: sharedReferencesBefore,
    media_references_before: mediaReferencesBefore,
  };

  if (session.last_request) {
    session.last_request.outcome = 'applied';
  }

  const primary = new Set(primaryBlocks(plan));
  const affected = afterRows.filter((row) => primary.has(row.clientId) || changed.includes(row));
  const measure = input.measure === true ? {} : input.measure;
  const writtenSettings = footnote ? settings.values : settingsPatch(settings);

  return {
    ok: true,
    editor_result: 'applied',
    edit_count: session.edit_count,
    pattern_section: patternSectionState(wp),
    dirty: editor.isEditedPostDirty(),
    valid: validity(afterRows).valid,
    block_count: afterRows.length,
    changed: affected.slice(0, 80).map((row) => {
      const properties = changedAttributes(before.get(row.clientId), row);

      return {
        client_id: row.clientId,
        name: row.name,
        path: row.path,
        preview: previewFor(context.wp, row, 80),
        properties: properties?.paths,
        properties_truncated: properties?.truncated || undefined,
      };
    }),
    changed_truncated: affected.length > 80 ? affected.length : undefined,
    ...rewritten,
    settings: Object.keys(settings.values).length ? writtenSettings : undefined,
    footnote_writes: footnoteWrites,
    measure: measure ? await measureAfterEdit(wp, afterRows, measure, [...primary]) : undefined,
    ...notesAfterEdit(wp, afterRows, changed, before),
  };
}

// The edit is already applied. A failure here must not read as an edit failure,
// or an agent could repeat the change.
function notesAfterEdit(
  wp: WordPress,
  rows: BlockSummary[],
  changed: BlockSummary[],
  before: Map<string, Observed>,
): JsonObject {
  try {
    return controlNotes(wp, rows, changed, before);
  } catch {
    return {};
  }
}

// Attribute paths an edit changed on a block that existed before it, so an
// agent can confirm the edit's scope without diffing reads.
function changedAttributes(previous: Observed | undefined, row: BlockSummary) {
  if (!previous) {
    return undefined;
  }

  const attributesBefore: JsonValue = JSON.parse(previous.attributes);
  const changed = changedProperties(attributesBefore, row.attributes);

  return changed.paths.length ? changed : undefined;
}

// The edit is already applied. A measurement failure must not read as an
// edit failure, or an agent could repeat the change.
async function measureAfterEdit(
  wp: WordPress,
  rows: BlockSummary[],
  options: MeasureOptions,
  primary: string[],
): Promise<JsonObject> {
  try {
    return { ok: true, ...(await measureBlocks(wp, rows, defaultMeasure(options, primary))) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof BlockworkError ? error.code : 'measure_failed',
      diagnostics: error instanceof BlockworkError ? error.diagnostics : undefined,
      debug: debugDetails(error),
    };
  }
}

// Carry the editor outcome on any error thrown after the draft changed, so the
// result never reads as nothing applied.
function withOutcome(cause: unknown, outcome: string, rollbackFailure?: Error): BlockworkError {
  const options = {
    cause: rollbackFailure
      ? new AggregateError([cause, rollbackFailure], 'The edit failed.')
      : cause,
  };

  if (cause instanceof BlockworkError) {
    return new BlockworkError(
      cause.code,
      { ...cause.diagnostics, editor_result: outcome },
      options,
    );
  }

  const native = v.safeParse(ApiErrorSchema, cause);
  const access = accessFailure(cause);

  // The wrapper drops the native status, so classify sign-in and permission
  // failures while it is still known.
  return new BlockworkError(
    access?.error ??
      (native.success ? (native.output.code ?? 'operation_failed') : 'operation_failed'),
    { ...access?.diagnostics, editor_result: outcome },
    options,
  );
}

function defaultMeasure(options: MeasureOptions, primary: string[]) {
  return { blocks: options.blocks ?? primary.slice(0, 20), properties: options.properties };
}

// Only the latest verified state and its one outstanding dispatch can own a restore.
async function rollBack(
  context: Context,
  plan: Plan,
  settings: SettingsPlan,
  draft: DraftCheckpoint,
): Promise<{ outcome: 'rolled_back' | 'partial'; failure?: Error }> {
  try {
    const restored = await restoreOrdinary(context, plan, settings, draft, () => {});

    return { outcome: restored ? 'rolled_back' : 'partial' };
  } catch (error) {
    return { outcome: 'partial', failure: new Error('The rollback failed.', { cause: error }) };
  }
}

async function revert(context: Context): Promise<JsonObject> {
  const { wp, session, editor } = context;
  const last = session.last_edit;
  assert(last, 'revert_not_available');
  context.available();
  noteForeignChanges(context);

  if (last.draft) {
    assert(same(draftState(context), last.draft.current), 'intervening_editor_change');
  }

  context.pauseAutosave();
  const beforeRows = context.rows();
  const before = new Map(beforeRows.map((row) => [row.clientId, observedState(row)]));
  const rootBefore = rootState(wp).children;
  let mutated = false;

  try {
    if (last.footnote) {
      const restored = await restoreExplicitFootnotes(
        wp,
        context.target,
        last.footnote,
        () => context.fields(context.livePost(), ['date_gmt']),
        context.available,
        () => {
          mutated = true;
        },
      );
      assert(restored, 'intervening_editor_change', {
        next_step:
          'Read the draft and settings. The paired result changed; retain it and release the session.',
      });
    } else {
      assert(last.draft, 'revert_not_available');
      const restored = await restoreOrdinary(context, last.plan, last.settings, last.draft, () => {
        mutated = true;
      });
      assert(restored, 'intervening_editor_change');
    }
  } catch (error) {
    if (last.footnote) {
      session.footnote_recovery = true;

      if (session.last_request) {
        session.last_request.outcome = 'partial';
      }

      throw withOutcome(error, 'partial');
    }

    if (!mutated) {
      throw error;
    }

    // Part of the revert ran. Report it so the agent reads before acting.
    session.last_edit = undefined;

    if (session.last_request) {
      session.last_request.outcome = 'partial';
    }

    throw withOutcome(error, 'partial');
  }

  observeOwnChanges(context, before, rootBefore, context.rows());
  observeFields(context, last.settings);

  if (last.footnote) {
    session.footnote_recovery = undefined;
  }

  session.requested = last.requested_before;
  session.references = last.references_before;
  session.shared_references = last.shared_references_before;
  session.media_references = last.media_references_before;
  session.last_edit = undefined;
  session.expected_state = context.liveState();

  if (session.last_request) {
    session.last_request.outcome = 'reverted';
  }

  return { ok: true, editor_result: 'reverted', dirty: editor.isEditedPostDirty() };
}

async function prepareSave(context: Context, saveAllPending?: boolean): Promise<JsonObject> {
  const { wp, session, editor } = context;
  context.available();
  // A native autosave starting now would change the saved record mid-check.
  context.pauseAutosave();
  assert(!session.preview, 'unsaved_preview_save_forbidden');
  assert(session.workflow === 'background' || saveAllPending === true, 'save_all_pending_required');
  // An attempted save may have reached WordPress. recover and reconnect settle
  // it; preparing again must never reopen it for a second write.
  assert(!session.save?.attempted, 'save_unresolved');
  refuseAmbiguousUnion(wp, context.rows());
  const requested = session.requested;
  const requestedNames = new Set(Object.keys(requested));
  const lockCheck = session.workflow === 'background' ? pulse(context) : undefined;
  // Earlier validation errors retain precedence even if the pulse rejects later.
  void lockCheck?.catch(() => {});

  // Identity and the field schema were cached for draft edits. Confirm both
  // before persisting; the schema only matters when settings are pending.
  const [user, saved, schema] = await Promise.all([
    authenticate(wp, context.target),
    context.fresh(),
    Object.keys(context.pending()).length ? documentContract(wp, context.target) : undefined,
  ]);
  assert(user.id === context.target.user_id, 'user_mismatch');
  assert(!schema || schema.token === session.schema.token, 'stale_settings_schema');
  context.matchesSaved(saved);

  // Terms, media, parents, and taxonomies that settings edits referenced must
  // still be what those edits checked.
  for (const reference of session.references) {
    assert(
      (await entityToken(await api(wp, reference.path))) === reference.token,
      'stale_reference',
    );
  }

  for (const owned of session.media_references) {
    const row = context.rows().find((item) => item.clientId === owned.client_id);

    if (row && same(row.attributes[owned.attribute], owned.value)) {
      assert((await entityToken(await api(wp, owned.path))) === owned.token, 'stale_reference', {
        stage: 'media_currentness',
        owner_client_id: owned.client_id,
        live_block_path: row.path,
        media_id: owned.media_id,
      });
    }
  }

  for (const [ownerId, owned] of Object.entries(session.shared_references)) {
    const row = context.rows().find((item) => item.clientId === ownerId);

    if (
      !row ||
      !['ref', 'slug', 'theme'].every((key) => same(row.attributes[key], owned.identity[key]))
    ) {
      continue;
    }

    for (const [index, reference] of owned.graph.entries()) {
      await readReference(wp, context.target, reference).catch((cause: unknown) => {
        const native = v.safeParse(ApiErrorSchema, cause);

        if (
          (cause instanceof BlockworkError && cause.code === 'stale_entity_reference') ||
          (native.success && native.output.data?.status === 404)
        ) {
          throw new BlockworkError(
            'stale_entity_reference',
            {
              stage: 'reference_currentness',
              entity_type: reference.entity_type,
              entity_id: reference.entity_id,
              owner_client_id: ownerId,
              live_block_path: row.path,
              dependency: index !== 0,
            },
            { cause },
          );
        }

        throw cause;
      });
    }
  }

  if (session.persisted.status === 'auto-draft') {
    assert(
      ['title', 'slug', 'status'].every((name) => requestedNames.has(name)),
      'creation_fields_required',
    );
    const slug = String(context.livePost().slug);
    const duplicates = await api(
      wp,
      `${session.schema.collection}?context=edit&status=any&slug=${encodeURIComponent(slug)}&per_page=2`,
    );
    assert(Array.isArray(duplicates) && duplicates.length === 0, 'slug_already_exists');
  }

  if (session.workflow === 'background') {
    await lockCheck;
  }

  await context.savingUnlocked();
  context.available();
  assert(editor.isEditedPostSaveable() && !editor.isPostSavingLocked(), 'save_refused');
  // Read the draft and its state hash in the same tick; the receipt must
  // describe exactly the state save() later checks.
  const live = context.livePost();
  // Saved content over the limit could not be read back to verify the save.
  checkContentSize(live.content.raw);
  const pending = Object.keys(context.pending());
  const state = context.liveState();
  const liveFields = context.fields(live, ['date_gmt']);
  // A pending setting counts as requested only while it still holds the value
  // Blockwork wrote; a later native change to the same field does not.
  const authorized = { ...context.fields(session.persisted), ...requested };

  if (requested.meta) {
    authorized.meta = {
      ...v.parse(JsonObjectSchema, context.fields(session.persisted).meta ?? {}),
      ...v.parse(JsonObjectSchema, requested.meta),
    };
  }

  const asRequested = (name: string) =>
    Object.hasOwn(requested, name) && same(liveFields[name], authorized[name]);

  // A background tab may only save work Blockwork produced or the agent read.
  // Late native changes and anything else need a read of the listed blocks.
  if (session.workflow === 'background') {
    const unseen = unseenBlocks(context, context.rows());
    // Name changed meta keys rather than all of meta: against Blockwork's own
    // meta request when it made one, otherwise against the saved record.
    const unrequested = pending.flatMap((name) => {
      if (asRequested(name)) {
        return [];
      }

      if (name !== 'meta') {
        return [name];
      }

      const baseline = authorized.meta;
      const changed = differingFields({ meta: baseline }, { meta: liveFields.meta });

      return changed.length ? changed : [name];
    });
    assert(!unseen.length && !unrequested.length, 'unexpected_editor_change', {
      blocks: unseen.slice(0, 20),
      block_count: unseen.length,
      fields: unrequested.slice(0, 20),
    });
  }

  assert(
    live.status === session.persisted.status || asRequested('status'),
    'publication_change_requires_request',
  );
  const dates: Array<'date_gmt'> =
    requestedNames.has('date_gmt') || pending.includes('date_gmt') ? ['date_gmt'] : [];
  const parsed = readTree(wp, wp.blocks.parse(live.content.raw));
  const shared = sharedType(context.target.post_type);
  const liveDesired = context.fields(live, dates);
  // A save sends only pending fields and content, so the rest keep their stored
  // values. A meta box form may have rewritten those since the editor loaded.
  const desired = {
    ...context.fields(saved, dates),
    ...Object.fromEntries(
      Object.entries(liveDesired).filter(([name]) => name === 'content' || pending.includes(name)),
    ),
  };

  // WordPress assigns the first database override of a file-backed template
  // to its creating user. Existing overrides keep their author.
  if (shared && saved.wp_id === 0 && !saved.author) {
    desired.author = context.target.user_id;
  }

  const original = context.fields(saved, dates);
  // WordPress generates a slug when a draft with none stops being a draft.
  const generatesSlug =
    original.slug === '' &&
    desired.slug === '' &&
    !['draft', 'pending', 'auto-draft'].includes(String(desired.status));
  const receipt = v.parse(ReceiptSchema, {
    target: context.target,
    workflow: session.workflow,
    editor_instance: session.editor_instance,
    original_hash: await hash(original),
    desired_hash: await hash(desired),
    fields_hash: await contentlessHash(desired),
    block_hash: await hash(storedState(wp, parsed)),
    unsupported_block_count: validity(parsed).unsupported.length,
    date_fields: dates,
    generated_slug: generatesSlug || undefined,
    scope: shared?.scope,
  });
  const savedToken = await context.savedToken(saved);
  assert(context.liveState() === state, 'intervening_editor_change');

  // Core posts active meta box forms even when readable document fields match.
  if (
    receipt.desired_hash === receipt.original_hash &&
    !wp.data.select('core/edit-post')?.hasMetaBoxes()
  ) {
    return { ok: true, persistence: 'unchanged', saved: false };
  }

  session.save = {
    receipt,
    state,
    saved_token: savedToken,
    attempted: false,
    original,
    desired,
    rows: parsed,
  };

  return { ok: true, receipt, operation_started: false, persistence: 'not_attempted' };
}

async function saveWithMetaBoxes(savePost: () => Promise<void>): Promise<MetaBoxOutcome> {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'fetch');

  // A plugin can define fetch as an accessor whose setter replaces its own
  // delegate, so an assignment could not be undone. Swap the property itself,
  // and save natively when it cannot be swapped back.
  if (!descriptor?.configurable) {
    await savePost();

    return 'unobserved';
  }

  let metaBoxes: MetaBoxOutcome = 'none';
  let saving = true;
  const originalFetch = window.fetch;

  // Core's handler ignores the response, so the POST runs edit_post() without
  // fetching the editor page its redirect points to.
  const post = async (receiver: Window, input: string | URL, options: RequestInit) => {
    try {
      const response = await originalFetch.call(receiver, input, {
        ...options,
        redirect: 'manual',
      });
      const redirected = response.type === 'opaqueredirect';

      if (!redirected && !response.ok) {
        metaBoxes = 'failed';
      } else if (metaBoxes !== 'failed') {
        metaBoxes = 'saved';
      }

      return redirected ? new Response(null, { status: 200 }) : response;
    } catch (error) {
      metaBoxes = 'failed';

      throw error;
    }
  };

  const saveFetch = function (this: Window, ...args: Parameters<typeof fetch>) {
    const [input, options] = args;
    const target = v.is(v.string(), input) || input instanceof URL ? input : undefined;
    let matches = false;

    if (saving && target && options?.method?.toUpperCase() === 'POST' && window._wpMetaBoxUrl) {
      try {
        const requestUrl = new URL(target, location.href);
        const metaBoxUrl = new URL(window._wpMetaBoxUrl, location.href);
        // Middleware may add parameters, such as apiFetch's _locale.
        matches =
          requestUrl.origin === metaBoxUrl.origin &&
          requestUrl.pathname === metaBoxUrl.pathname &&
          [...metaBoxUrl.searchParams.keys()].every((name) =>
            same(requestUrl.searchParams.getAll(name), metaBoxUrl.searchParams.getAll(name)),
          );
      } catch {
        // Invalid URLs still belong to the original fetch's error handling.
      }
    }

    return matches && target && options
      ? post(this, target, options)
      : originalFetch.call(this, ...args);
  };

  Object.defineProperty(window, 'fetch', {
    configurable: true,
    enumerable: descriptor.enumerable,
    writable: true,
    value: saveFetch,
  });

  try {
    await savePost();
  } finally {
    // A replacement fetch may keep this wrapper chained after our save ends.
    saving = false;

    if (Object.getOwnPropertyDescriptor(window, 'fetch')?.value === saveFetch) {
      Object.defineProperty(window, 'fetch', descriptor);
    }
  }

  return metaBoxes;
}

function clearConfirmedSave(session: Context['session']): void {
  session.references = [];
  session.shared_references = {};
  session.media_references = [];
  session.structure_requires_reload ||= Object.keys(session.requested).some((name) =>
    policyFields.includes(name),
  );
  session.requested = {};
  session.last_edit = undefined;
}

async function save(
  context: Context,
  receipt: v.InferOutput<typeof ReceiptSchema>,
  saveAllPending?: boolean,
): Promise<SaveResult> {
  const { wp, session, editor, actions } = context;
  const prepared = session.save;
  assert(
    prepared?.original && !prepared.attempted && same(prepared.receipt, receipt),
    'save_not_prepared',
  );
  assert(session.workflow === 'background' || saveAllPending === true, 'save_all_pending_required');
  context.available();
  context.pauseAutosave();
  const saved = await context.fresh();

  if ((await context.savedToken(saved)) !== prepared.saved_token) {
    session.persistence = 'not_attempted';
    throw new BlockworkError('saved_record_changed', {
      stage: 'before_save',
      post_id: context.target.post_id,
      post_type: context.target.post_type,
      saved_token_changed: true,
      fields: fieldNames(
        fieldChanges(prepared.original, context.fields(saved, receipt.date_fields)),
      ),
    });
  }

  context.available();
  assert(context.liveState() === prepared.state, 'intervening_editor_change');
  assert(editor.isEditedPostSaveable() && !editor.isPostSavingLocked(), 'save_refused');
  const persistenceBefore = session.persistence;
  prepared.attempted = true;
  session.persistence = 'uncertain';

  if (session.last_request) {
    session.last_request.outcome = 'uncertain';
  }

  // WordPress's refusal explains a failed save but does not prove nothing was
  // written, so the save stays uncertain until recover settles it. Core-data
  // keeps the last error until a save request starts, and a pre-save hook can
  // stop savePost before one does, so only an error this save replaced counts.
  const saveError = () =>
    wp.data
      .select('core')
      .getLastEntitySaveError?.('postType', editor.getCurrentPostType(), editor.getCurrentPostId());
  const earlierError = saveError();
  // A plugin's pre-save check, such as ACF's required-field validation, can
  // settle savePost without a request. Only a request that started can write.
  let sent = false;
  const stopWatching = wp.data.subscribe(() => {
    sent ||= editor.isSavingPost();
  });
  const metaBoxes = await saveWithMetaBoxes(() => actions.savePost()).finally(stopWatching);

  if (!sent) {
    session.save = undefined;
    session.persistence = persistenceBefore;

    if (session.last_request) {
      session.last_request.outcome = 'failed';
    }
  }

  assert(sent, 'save_not_sent');
  const latestError = saveError();
  assert(
    editor.didPostSaveRequestSucceed(),
    'save_uncertain',
    latestError === earlierError ? undefined : wordpressError(latestError),
  );
  const persisted = await context.fresh();
  const savedRows = readTree(wp, wp.blocks.parse(persisted.content.raw));
  const savedFields = context.fields(persisted, receipt.date_fields);
  const match = await receiptMatch(wp, savedFields, receipt);
  let differences: string[][] = [];

  if (match !== 'matched') {
    const changes = fieldChanges(prepared.desired, savedFields).filter(
      (path) => path[0] !== 'content',
    );
    // A meta box form may rewrite meta keys and plugin fields this save left
    // alone. A key or field it did change must still verify.
    differences = changes.filter(
      (path) =>
        !(
          metaBoxes === 'saved' &&
          metaBoxField(path[0], session.schema.taxonomy_fields) &&
          same(fieldValue(prepared.original, path), fieldValue(prepared.desired, path))
        ),
    );
    const blocks = storedMismatches(wp, prepared.rows, savedRows);
    const explained =
      changes.length > 0 &&
      differences.every((path) => {
        const before = fieldValue(prepared.original, path);
        const desired = fieldValue(prepared.desired, path);
        const stored = fieldValue(savedFields, path);
        // WordPress fills an empty taxonomy with its default term, such as
        // Uncategorized for posts, even when the request left it empty.
        const defaultTerm =
          session.schema.taxonomy_fields.includes(path[0]) &&
          same(desired, []) &&
          Array.isArray(stored) &&
          stored.length > 0;

        return defaultTerm || (!same(before, desired) && !same(before, stored));
      });
    assert(!blocks.blocks.length && !blocks.truncated && explained, 'verification_mismatch', {
      meta_boxes: metaBoxes,
      fields: fieldNames(differences),
      blocks: blocks.blocks,
      blocks_truncated: blocks.truncated,
    });
  }

  const storedDifferently = differences.length > 0;
  session.persisted = persisted;
  session.baseline = context.fields(persisted);
  session.meta_box_save = false;
  session.persistence = storedDifferently ? 'applied_with_differences' : 'verified';
  clearConfirmedSave(session);
  session.expected_state = context.liveState();
  session.save = undefined;

  if (session.last_request) {
    session.last_request.outcome = storedDifferently ? 'stored_with_field_differences' : 'saved';
    session.last_request.error = storedDifferently ? 'stored_with_field_differences' : undefined;
  }

  const shared = sharedType(context.target.post_type);

  const pendingEntities =
    session.workflow === 'attached'
      ? wp.data.select('core').__experimentalGetDirtyEntityRecords?.()
      : undefined;

  return {
    ok: !storedDifferently,
    meta_boxes: metaBoxes,
    error: storedDifferently ? 'stored_with_field_differences' : undefined,
    outcome: storedDifferently ? 'stored_with_field_differences' : undefined,
    persistence: session.persistence,
    diagnostics: storedDifferently
      ? { fields: fieldNames(differences), fields_truncated: differences.length > 20 }
      : undefined,
    next: storedDifferently ? 'inspect_stored_fields' : undefined,
    receipt,
    status: persisted.status,
    link: permalink(persisted),
    editor_url: editorUrl(context.target),
    revisions: revisions(persisted),
    valid: validity(savedRows).valid,
    dirty: editor.isEditedPostDirty(),
    saved_all_pending:
      session.workflow === 'attached'
        ? !storedDifferently &&
          !editor.isEditedPostDirty() &&
          Array.isArray(pendingEntities) &&
          pendingEntities.length === 0
        : undefined,
    pending_entity_count: Array.isArray(pendingEntities) ? pendingEntities.length : undefined,
    entity: shared ? entitySummary(persisted, context.target) : undefined,
    unsupported_block_count: receipt.unsupported_block_count,
    preservation_status: receipt.unsupported_block_count ? 'verified_after_read' : 'not_applicable',
  };
}

// Gutenberg upgrades older blocks when it loads them, but writes that only after
// a block changes, and until then its Save stays disabled. Resetting the document
// to its own blocks is that change, with every client ID kept. A tab an agent
// opened also has a blank canvas, so this loads it for the user to check.
async function prepareResave(context: Context): Promise<JsonObject> {
  const { wp, session, editor } = context;
  assert(session.workflow === 'attached', 'workflow_mismatch');
  assert(!session.preview, 'unsaved_preview_save_forbidden');
  context.available();
  await requireCanvas(documentBlocks(wp).map((block) => block.clientId));
  context.available();
  await resetDocument(wp, documentBlocks(wp), context.available);

  return { ok: true, dirty: editor.isEditedPostDirty() };
}

function status(session: Session): JsonObject {
  const wp = window.wp;
  const editor = wp?.data.select('core/editor');

  return {
    ok: true,
    workflow: session.workflow,
    busy: session.busy,
    last_request: session.last_request,
    edit_count: session.edit_count,
    revert_available: Boolean(session.last_edit),
    persistence: session.persistence,
    receipt: session.save?.receipt,
    dirty: editor?.isEditedPostDirty(),
    unsaved_preview: Boolean(session.preview),
    pattern_section: wp ? patternSectionState(wp) : undefined,
  };
}

async function release(context: Context): Promise<JsonObject> {
  const { wp, session, editor, actions } = context;
  // Record the ended session so status can confirm a release whose response
  // was lost. A background record also refuses reconnecting this tab.
  const ended = (cleanup: string) => {
    if (session.last_request) {
      session.last_request.outcome = 'released';
    }

    session.stop_save_watch?.();
    window.__blockwork_editor = undefined;
    window.__blockwork_release = {
      target: session.target,
      workflow: session.workflow,
      last_request: session.last_request,
      cleanup,
    };
  };

  if (session.workflow === 'background') {
    const cleanup = await releaseLock(context);
    actions.unlockPostAutosaving(sessionKey);
    ended(cleanup);

    return {
      ok: true,
      workflow: session.workflow,
      cleanup,
      close_document: true,
      persistence: session.persistence,
      unsaved_changes: editor.isEditedPostDirty(),
    };
  }

  const preview = session.preview;

  if (preview) {
    const saved = await context.fresh();
    context.available();
    const unchanged = async () =>
      context.liveState() === preview.state && same(context.pending(), preview.pending);
    assert(
      (await context.savedToken(saved)) === preview.saved_token,
      'unsaved_preview_saved_changed',
    );

    // Undo Blockwork's own preview edits only while the draft never held
    // anything else: no foreign change at any point, no settings changes.
    noteForeignChanges(context);

    if (context.liveState() !== preview.state) {
      assert(
        !session.foreign_change &&
          context.liveState() === session.expected_state &&
          !Object.keys(session.requested).length &&
          same(context.pending(), preview.pending),
        'unsaved_preview_pending',
      );
      await resetDocument(wp, copyTree(preview.blocks), () => {
        context.available();
        noteForeignChanges(context);
        assert(
          !session.foreign_change &&
            context.liveState() === session.expected_state &&
            !Object.keys(session.requested).length &&
            same(context.pending(), preview.pending),
          'unsaved_preview_pending',
        );
      });
    }

    await restoreDraftDirty(wp, preview.dirty);
    assert(await unchanged(), 'unsaved_preview_pending');
    assert(actions.unlockPostSaving, 'unsaved_preview_unavailable');
    actions.unlockPostAutosaving(previewKey(session));
    actions.unlockPostSaving(previewKey(session));
  }

  session.footnote_recovery = undefined;
  ended('editor_retained');

  return {
    ok: true,
    workflow: session.workflow,
    cleanup: 'editor_retained',
    close_document: false,
    persistence: session.persistence,
    unsaved_changes: editor.isEditedPostDirty(),
  };
}

// Confirm the owned lock through one Heartbeat round trip before connecting
// and saving. Native Heartbeat keeps renewing it between these points.
function pulse(context: Context): Promise<void> {
  const { wp, session, editor, actions, target } = context;

  return new Promise<void>((resolve, reject) => {
    if (!session.lock_post_id) {
      resolve();

      return;
    }

    const hook = `blockwork/pulse/${crypto.randomUUID()}`;

    const done = (error?: string) => {
      clearTimeout(timer);
      wp.hooks.removeAction('heartbeat.tick', hook);
      wp.hooks.removeAction('heartbeat.error', hook);

      if (error) {
        reject(new BlockworkError(error));
      } else {
        resolve();
      }
    };

    const timer = setTimeout(
      () => done('heartbeat_timeout'),
      Math.max(1, Math.min(12000, remainingMs())),
    );
    wp.hooks.addAction('heartbeat.tick', hook, (data) => {
      const lock = data['wp-refresh-post-lock'];

      if (lock?.lock_error) {
        return done('post_locked');
      }

      if (lock?.new_lock) {
        if (Number(lock.new_lock.split(':')[1]) !== target.user_id) {
          return done('lock_owner_mismatch');
        }

        actions.updatePostLock({ isLocked: false, activePostLock: lock.new_lock });
        done();
      }
    });
    wp.hooks.addAction('heartbeat.error', hook, () => done('heartbeat_failed'));
    wp.heartbeat.enqueue('wp-refresh-post-lock', {
      post_id: session.lock_post_id,
      lock: editor.getActivePostLock(),
    });
    wp.heartbeat.connectNow();
  });
}

async function releaseLock(context: Context): Promise<string> {
  const { wp, session, editor, target } = context;
  const locked = () => editor.isPostLocked() || editor.isPostLockTakeover();

  // Stop renewals only at teardown. Native Heartbeat runs throughout editing.
  if (!locked()) {
    await pulse(context);
  }

  wp.hooks.addAction(
    'heartbeat.send',
    'blockwork/closing',
    (data) => {
      delete data['wp-refresh-post-lock'];
    },
    1000000,
  );
  wp.heartbeat.dequeue('wp-refresh-post-lock');
  assert(!editor.isSavingPost(), 'cleanup_pending');

  // Site Editor documents never held a post lock.
  if (!session.lock_post_id) {
    return 'no_post_lock';
  }

  const lock = editor.getActivePostLock();

  if (!lock || locked() || Number(lock.split(':')[1]) !== target.user_id) {
    return 'not_owned';
  }

  const site = new URL(target.site_url);
  const utils = editor.getEditorSettings().postLockUtils;
  assert(utils?.unlockNonce, 'cleanup_nonce_unavailable');
  const url = new URL(utils.ajaxUrl, location.href);
  assert(url.origin === site.origin, 'cleanup_origin_mismatch');
  const confirmed = await timedRequest('post_lock_release', budgetedMs(12000), async (signal) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      body: new URLSearchParams({
        action: 'wp-remove-post-lock',
        post_ID: String(session.lock_post_id),
        active_post_lock: lock,
        _wpnonce: utils.unlockNonce,
      }),
      signal,
    });

    return response.ok && (await response.text()).trim() === '1';
  });
  assert(confirmed, 'cleanup_unconfirmed');

  // WordPress conditionally expires the exact lock with a five-second grace
  // period. Its response does not prove the stored value changed.
  return 'release_requested';
}

function failure(cause: unknown, session?: Session): JsonObject {
  const parsed = v.safeParse(ApiErrorSchema, cause);
  const native = parsed.success ? parsed.output : undefined;
  const code = cause instanceof BlockworkError ? cause.code : native?.code;
  const access = accessFailure(cause);
  const auth = code === 'reauthorization_required' || access?.error === 'reauthorization_required';
  const diagnostics = cause instanceof BlockworkError ? cause.diagnostics : access?.diagnostics;
  const outcome = session?.last_request?.outcome;
  let next = 'correct_request';

  if (outcome === 'uncertain' || session?.save?.attempted) {
    next = 'recover_save_do_not_replay';
  } else if (outcome === 'partial') {
    next = 'read_changed_blocks_do_not_replay';
  } else if (code === 'stale_entity_reference') {
    next = 'inspect_entity_then_reconcile';
  } else if (code === 'ambiguous_union_attribute') {
    next = 'inspect_then_report_ambiguity';
  } else if (['block_changed', 'field_changed', 'intervening_editor_change'].includes(code ?? '')) {
    next = 'read_then_retry';
  } else if (auth) {
    next = 'reauthorize_site';
  } else if (code === 'connect_required' || code === 'target_mismatch') {
    next = 'connect';
  } else if (code === 'operation_in_progress') {
    next = 'check_status';
  } else if (code === 'editor_not_clean') {
    next = 'report_pending_changes';
  } else if (code === 'initial_serialization_changed' || code === 'save_not_sent') {
    next = 'ask_user';
  }

  return {
    ok: false,
    error: failureCode(code, access, v.isValiError(cause)),
    diagnostics,
    issues: v.isValiError(cause) ? validationIssues(cause.issues, 'native_response') : undefined,
    validation_source: v.isValiError(cause) ? 'native_response' : undefined,
    editor_result: v.is(v.string(), diagnostics?.editor_result)
      ? diagnostics.editor_result
      : 'not_applied',
    persistence: session?.persistence ?? 'not_attempted',
    receipt: session?.save?.attempted ? session.save.receipt : undefined,
    last_request: session?.last_request,
    next,
    debug: debugDetails(cause),
  };
}
