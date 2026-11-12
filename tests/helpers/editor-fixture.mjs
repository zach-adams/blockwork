import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { footnoteRichText, footnoteParagraph, footnoteBodies } from './footnote-rich-text.mjs';

const source = await readFile(new URL('../../skills/blockwork/scripts/editor.js', import.meta.url), 'utf8');
const target = { site_url: 'https://example.test', user_id: 5, post_id: 7, post_type: 'page' };
const changes = [{ op: 'update', path: [0], name: 'core/paragraph', attributes: { content: 'After' } }];
const copy = (value) => structuredClone(value);

// Development builds put the underlying message in debug; nothing else may echo it.
function outsideDebug(result) {
  return JSON.stringify({ ...result, debug: undefined });
}

// Mirror rest_filter_response_fields, including dotted keys and parent precedence.
function restFields(value, path, method) {
  const fields = new URL(path, target.site_url).searchParams.get('_fields')?.split(/[\s,]+/).filter(Boolean);

  if (method !== 'GET' || !fields?.length) return copy(value);
  const hierarchy = new Map();

  for (const field of fields) {
    const parts = field.split('.');
    let node = hierarchy;

    for (let index = 0; index < parts.length; index++) {
      const name = parts[index];

      if (node.get(name) === true) break;

      if (index === parts.length - 1) {
        node.set(name, true);
        break;
      }

      if (!node.has(name)) node.set(name, new Map());
      node = node.get(name);
    }
  }

  const intersect = (record, selected) => Object.fromEntries(Object.entries(record).flatMap(([name, entry]) => {
    if (!selected.has(name)) return [];
    const nested = selected.get(name);

    return [[name, entry instanceof Object && nested instanceof Map ? intersect(entry, nested) : entry]];
  }));

  return copy(Array.isArray(value) ? value.map((record) => intersect(record, hierarchy)) : intersect(value, hierarchy));
}

function stylingFixture() {
  const f = fixture();
  f.window.wp.blockEditor = { __experimentalResponsiveBlockControl() {} };
  Object.assign(f.registrations['core/group'], {
    supports: { spacing: { padding: true, margin: true, blockGap: true }, color: { gradients: true }, typography: { fontSize: true }, layout: true },
    attributes: { ...f.registrations['core/group'].attributes, fontSize: { type: 'string' }, textColor: { type: 'string' }, backgroundColor: { type: 'string' } },
  });
  f.editorSettings = { canEditCSS: true, blockStatesEditingEnabled: true, __experimentalFeatures: {
    viewport: { mobile: '32rem', tablet: '60rem' }, spacing: { padding: true, margin: true, blockGap: true },
    typography: { fontSizes: { theme: [{ slug: 'large', size: '32px' }] }, customFontSize: true },
    color: { palette: { theme: [{ slug: 'accent', color: '#c00' }] }, custom: true },
  } };
  f.blocks = [{ name: 'core/group', clientId: 'a', isValid: true, innerBlocks: [], attributes: {
    className: 'retained', layout: { type: 'flex', orientation: 'horizontal' },
    style: { spacing: { padding: { top: '24px', right: '16px' } }, typography: { fontSize: '20px' },
      '@mobile': { spacing: { padding: { top: '12px', left: '8px' } } },
      '@tablet': { spacing: { padding: { top: '18px' } } }, css: '& strong { color: red; }' },
  } }];
  f.syncContent();

  return f;
}

async function styleEdit(f, set = [], unset = []) {
  if (!f.window.__blockwork_editor) {
    const connected = await f.call('connect');
    assert.equal(connected.ok, true, JSON.stringify(connected));
  }

  return f.call('edit', { edits: [{ op: 'update_style', client_id: f.blocks[0].clientId, set, unset }] });
}

function fixture(post_type = 'page', url = 'https://example.test/wp-admin/post.php?post=7&action=edit', engine = source) {
  const f = { saves: 0, releases: 0, pulses: 0, dirty: false, locked: false, auth: true, user_id: 5, requests: [], autosaveLocks: new Set(), savingLocks: new Set(), listeners: new Set() };
  f.notify = () => { for (const listener of f.listeners) listener(); };

  // Native autosave of a draft writes the post itself and updates the editor's record.
  // Autosaving a published post writes only a revision.
  f.autosave = () => {
    f.saving = f.autosaving = true;
    f.notify();

    if (['draft', 'auto-draft'].includes(f.post.status)) {
      f.syncContent();
      f.post.modified_gmt = 'autosaved';
      f.dirty = false;
    }

    f.saving = f.autosaving = false;
    f.notify();
  };

  const registrations = {
    'core/paragraph': { attributes: { content: { type: 'rich-text' }, dropCap: { type: 'boolean' } } },
    'example/card': { attributes: { variant: { type: 'string', enum: ['plain', 'accent'] } } },
    'core/group': { attributes: { className: { type: 'string' }, style: { type: 'object' }, layout: { type: 'object' }, allowedBlocks: { type: 'array' } } },
    'core/html': { attributes: { content: { type: 'string' } } },
    'core/navigation': { attributes: { ref: { type: 'number' } } },
  };

  for (const [name, registration] of Object.entries(registrations)) registration.name = name;

  const plain = (list) => list.map(({ name, attributes, innerBlocks }) => ({ name,
    attributes: Object.fromEntries(Object.entries(attributes).filter(([key]) => registrations[name]?.attributes?.[key]?.role !== 'local')),
    innerBlocks: plain(innerBlocks || []) }));

  const serialize = (list) => plain(list).map((block) => JSON.stringify(block)).join('\n\n');

  const richTextAttributes = (values, schema, convert) => Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const attribute = schema?.[key];

    if (attribute?.type === 'rich-text') return [key, convert(String(value))];

    if (attribute?.source === 'query' && Array.isArray(value)) {
      return [key, value.map((entry) => richTextAttributes(entry, attribute.query, convert))];
    }

    return [key, value];
  }));

  const parse = (text) => {
    let index = 0;

    const restore = (list) => list.map((block) => {
      const legacy = block.name === 'example/legacy' && block.attributes.old !== undefined;
      const migrated = legacy && registrations[block.name]?.deprecated?.length;

      return { ...block, attributes: migrated ? { content: block.attributes.old } : richTextAttributes(block.attributes, registrations[block.name]?.attributes, (value) => value.replaceAll('\u00a0', '&nbsp;').replace(/&(?![A-Za-z][A-Za-z0-9]*;|#[0-9]+;|#[xX][0-9A-Fa-f]+;)/g, '&amp;')), originalContent: JSON.stringify(block),
        clientId: `parsed-${index++}`, isValid: !f.invalidParse && (!legacy || !!migrated || !!f.legacyValid), innerBlocks: restore(block.innerBlocks) };
    });

    return restore(text ? text.split('\n\n').map((value) => JSON.parse(value)) : []);
  };

  f.blocks = [
    { name: 'core/paragraph', attributes: { content: 'Before' }, clientId: 'a', innerBlocks: [], isValid: true },
    { name: 'example/card', attributes: { variant: 'plain' }, clientId: 'b', innerBlocks: [], isValid: true },
    { name: 'core/paragraph', attributes: { content: 'Preserve' }, clientId: 'c', innerBlocks: [], isValid: true },
  ];
  f.post = { id: 7, type: post_type, status: 'draft', slug: 'example', title: { raw: 'Test' }, excerpt: { raw: '' },
    content: { raw: serialize(f.blocks) }, template: '', parent: 0, menu_order: 0, featured_media: 0, meta: {}, modified_gmt: 'before', date: 'before', date_gmt: 'before' };
  const handlers = new Map();
  const runningHooks = new Set();

  const hooks = {
    addAction(event, namespace, callback) {
      assert.match(namespace, /^[a-zA-Z][a-zA-Z0-9_.\-/]*$/);

      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push({ namespace, callback });
    },
    removeAction(event, namespace) {
      const list = handlers.get(event) ?? [];

      // WordPress removes every match and adjusts active dispatch indices.
      for (let index = list.length - 1; index >= 0; index--) {
        if (list[index].namespace !== namespace) continue;
        list.splice(index, 1);

        for (const run of runningHooks) {
          if (run.event === event && run.index >= index) run.index--;
        }
      }
    },
    emit(event, data) {
      const list = handlers.get(event) ?? [];
      const run = { event, index: 0 };
      runningHooks.add(run);

      try {
        while (run.index < list.length) {
          list[run.index].callback(data);
          run.index++;
        }
      } finally {
        runningHooks.delete(run);
      }
    },
  };

  const editor = {
    getCurrentPost: () => copy(f.loadedPost ?? f.post),
    getCurrentPostId: () => f.post.id, getCurrentPostType: () => f.post.type,
    getEditedPostAttribute: (name) => f.postEdits?.[name] ?? (f.post[name]?.raw ?? f.post[name]),
    getEditedPostContent: () => serialize(f.blocks), getEditorBlocks: () => f.blocks,
    isEditedPostDirty: () => f.dirty, isSavingPost: () => !!f.saving, isAutosavingPost: () => !!f.autosaving,
    isPostLocked: () => f.locked, isPostLockTakeover: () => false,
    getActivePostLock: () => '100:5', getEditorSettings: () => ({ postLockUtils: { ajaxUrl: '/wp-admin/admin-ajax.php', unlockNonce: 'test-only' } }),
    isEditedPostSaveable: () => true, isPostSavingLocked: () => f.savingLocks.size > 0,
    isPostAutosavingLocked: () => f.autosaveLocks.size > 0,
    didPostSaveRequestSucceed: () => true, getPostEdits: () => f.postEdits ?? {},
  };

  const blockEditor = { getBlocks: (root) => root ? find(f.blocks).find((block) => block.clientId === root).innerBlocks : f.blocks, canEditBlock: () => !f.disabled,
    getSettings: () => ({ __experimentalBlockBindingsSupportedAttributes: { 'core/paragraph': ['content'] }, ...f.editorSettings }),
    getSelectionStart: () => f.selectionStart ?? {}, getSelectionEnd: () => f.selectionEnd ?? {},
    getSelectedBlocksInitialCaretPosition: () => f.caret ?? null,
    getBlockEditingMode: () => f.mode || 'default',
    getTemplateLock: () => f.templateLock || false,
    getBlockListSettings: () => f.missingContext ? undefined : {},
    canRemoveBlocks: () => !f.removeLocked, canMoveBlock: () => !f.moveLocked, canInsertBlocks: () => !f.insertLocked,
    canInsertBlockType: (name, parent) => !f.insertLocked && !f.templateLock && name !== 'core/html' && parent !== 'blocked-parent',
    getInserterItems: () => Object.keys(registrations).map((name) => ({ name, title: name, isDisabled: name === 'core/html' })) };

  const actions = { lockPostAutosaving: (key) => { f.autosaveLocks.add(key); f.autosaveLocked = true; },
    unlockPostAutosaving: (key) => { f.autosaveLocks.delete(key); f.autosaveLocked = f.autosaveLocks.size > 0; },
    lockPostSaving: (key) => { f.savingLocks.add(key); }, unlockPostSaving: (key) => { f.savingLocks.delete(key); }, updatePostLock: () => {},
    editPost(values) {
      f.postEdits = { ...f.postEdits };

      for (const [name, value] of Object.entries(values)) {
        // Gutenberg merges a meta edit into the editor's record, which a meta box form's write leaves stale.
        const next = name === 'meta' ? { ...(f.postEdits.meta ?? (f.loadedPost ?? f.post).meta), ...copy(value) } : copy(value);
        const saved = f.post[name]?.raw ?? f.post[name];

        if (value === undefined || JSON.stringify(next) === JSON.stringify(saved)) delete f.postEdits[name];
        else f.postEdits[name] = next;
      }

      f.dirty = editor.getEditedPostContent() !== f.post.content.raw || Object.keys(f.postEdits).length > 0;
    },
    async savePost() {
      f.saves++;
      f.saving = true;
      f.notify();

      if (f.post.wp_id === 0) { f.post.wp_id = 51; f.post.source = 'custom'; f.post.author = f.user_id; }

      const editedDate = f.postEdits?.date_gmt;

      for (const [key, value] of Object.entries(f.postEdits ?? {})) {
        if (['content', 'blocks', 'selection'].includes(key)) continue;
        f.post[key] = ['title', 'excerpt'].includes(key) ? { raw: value } : copy(value);
      }

      f.postEdits = {};
      f.post.content.raw = serialize(f.post.type === 'wp_navigation' ? f.blocks[0].innerBlocks : f.blocks);
      f.post.date = f.post.modified_gmt = 'after';
      f.post.date_gmt = editedDate ?? 'after';
      f.dirty = false;

      if (f.metaBoxBody !== undefined) {
        try {
          const response = await f.window.fetch(f.metaBoxUrl ?? f.window._wpMetaBoxUrl, { method: 'POST', body: f.metaBoxBody, credentials: 'include' });

          if (!response.ok) throw new Error('Meta box save failed');
          f.metaBoxResponse = response;
        } catch (error) {
          // Core reports meta box failures separately from the document save.
          f.metaBoxError = error;
        }
      }

      await f.duringSave?.();

      f.saving = false;
      f.notify();

      if (f.interruptSave) throw new Error('connection-lost');

      if (f.statusAfterSave) f.post.status = f.statusAfterSave;
    } };

  let nextId = 0;
  const find = (list) => list.flatMap((block) => [block, ...find(block.innerBlocks || [])]);
  const listFor = (id) => id ? find(f.blocks).find((block) => block.clientId === id).innerBlocks : f.blocks;

  const parentFor = (id, list = f.blocks) => {
    if (list.some((block) => block.clientId === id)) return list;

    for (const block of list) { const found = parentFor(id, block.innerBlocks || []);

 if (found) return found; }
  };

  const wp = {
    element: { flushSync(callback) { callback(); } },
    htmlEntities: { decodeEntities: (html) => html.replace(/&(nbsp|amp|lt|gt);/g, (_, name) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>' })[name]) },
    hooks,
    heartbeat: {
      enqueue() {}, dequeue() {},
      connectNow() {
        f.pulses++;
        f.onPulse?.();
        queueMicrotask(() => hooks.emit('heartbeat.tick', { 'wp-refresh-post-lock': f.takeover
          ? { lock_error: { name: 'Other editor' } } : { new_lock: '101:5' } }));
      },
    },
    blocks: { getBlockType: (name) => registrations[name], getBlockTypes: () => Object.values(registrations), serialize, parse,
      hasBlockSupport: (name, feature, defaultValue) => registrations[name]?.supports?.[feature] ?? defaultValue,
      __unstableSerializeAndClean: (blocks) => blocks.length === 1 && wp.blocks.isUnmodifiedDefaultBlock(blocks[0]) ? '' : wp.blocks.serialize(blocks),
      isUnmodifiedDefaultBlock: (block) => block.name === 'core/paragraph' &&
        Object.entries(registrations[block.name].attributes).every(([key, definition]) => {
          const value = block.attributes[key];

          if (Object.hasOwn(definition, 'default')) return value === definition.default;

          return definition.type === 'rich-text' ? !value?.length : value === undefined;
        }),
      createBlock: (name, attributes = {}, innerBlocks = []) => ({ name,
        // Gutenberg wraps top-level rich text and decodes &nbsp;; query values stay strings.
        attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key,
          registrations[name]?.attributes?.[key]?.type === 'rich-text' ? String(value).replaceAll('&nbsp;', '\u00a0') : value])), innerBlocks, clientId: `new-${nextId++}`, isValid: true }),
      createBlocksFromInnerBlocksTemplate: (items) => items.map(([name, attributes, children = []]) => wp.blocks.createBlock(name, attributes, wp.blocks.createBlocksFromInnerBlocksTemplate(children))),
      // Gutenberg keeps blocks that match the template by position and name.
      synchronizeBlocksWithTemplate: (blocks, items) => !items ? blocks : items.map(([name, attributes, children], index) => blocks[index]?.name === name
        ? { ...blocks[index], innerBlocks: wp.blocks.synchronizeBlocksWithTemplate(blocks[index].innerBlocks, children) }
        : wp.blocks.createBlock(name, attributes, wp.blocks.synchronizeBlocksWithTemplate([], children))),
      getBlockStyles: (name) => registrations[name]?.styles ?? [],
      getBlockVariations: (name) => registrations[name]?.variations ?? [],
      cloneBlock: (block, attributes, innerBlocks) => ({ ...block, attributes: { ...block.attributes, ...attributes }, innerBlocks }) },
    data: { resolveSelect: () => ({ getBlockPatterns: async () => f.patterns ?? [], getCurrentTheme: async () => ({ stylesheet: 'theme' }),
      canUser: async (...args) => {
        const result = f.resolveCanUser ? await f.resolveCanUser(...args) : false;

        if (args[1]?.kind === 'root' && args[1]?.name === 'site') f.siteCanRead = result;

        return result;
      },
      getEntityRecord: async (...args) => {
        const result = f.resolveEntity ? await f.resolveEntity(...args) : undefined;

        if (args[0] === 'root' && args[1] === 'site') f.siteRecord = result;

        return result;
      },
      getTaxonomies: async (...args) => f.resolveTaxonomies ? f.resolveTaxonomies(...args) : [],
      getEntityRecords: async (...args) => f.resolveRecords ? f.resolveRecords(...args) : [] }), subscribe(callback) {
      f.listeners.add(callback);

      return () => f.listeners.delete(callback);
    },
      select: (name) => name === 'core/editor' ? editor : name === 'core/edit-post' ? {
        hasMetaBoxes: () => !!f.hasMetaBoxes,
        isSavingMetaBoxes: () => !!f.savingMetaBoxes,
      } : name === 'core' ? {
        canUser: () => f.siteCanRead ?? false,
        getEntityRecord: () => f.siteRecord,
        getEntityRecordEdits: () => f.siteEdits ?? {},
        __experimentalGetDirtyEntityRecords: () => copy(f.dirtyEntities ?? []),
        hasResolvingSelectors: () => !!f.resolving,
        getLastEntitySaveError: () => f.saveError,
        getEntityRecordNonTransientEdits: () => Object.fromEntries(Object.entries(f.postEdits ?? {}).filter(([key]) => !['blocks', 'selection'].includes(key))),
        getEditedEntityRecord: () => ({ blocks: f.blocks, content: f.postEdits?.content ?? f.post.content.raw, meta: f.postEdits?.meta ?? f.post.meta }),
      } : name === 'core/blocks' ? { getBlockStyles: (name) => registrations[name]?.styles ?? [] } : blockEditor,
      dispatch: (name) => name === 'core/editor' ? actions : name === 'core' ? {
        editEntityRecord(kind, type, id, edits, options) {
          assert.equal(kind, 'postType'); assert.equal(type, f.post.type); assert.equal(id, f.post.id);
          assert.equal(options.undoIgnore, true);
          assert.deepEqual(Object.keys(edits), ['content']);

          if (edits.content === undefined) delete f.postEdits.content;
          else f.postEdits.content = edits.content;
          f.dirty = editor.getEditedPostContent() !== f.post.content.raw || Object.keys(f.postEdits).length > 0;
        },
      } : {
        selectBlock(id) {
          if (f.selectionStart?.clientId !== id) f.selectionStart = { clientId: id };

          if (f.selectionEnd?.clientId !== id) f.selectionEnd = { clientId: id };
          f.caret = null; f.onSelect?.(id);
        },
        resetSelection(start, end, position) { f.selectionStart = start; f.selectionEnd = end; f.caret = position; f.onSelectionRestore?.(); },
        insertBlocks(blocks, index, parent) { listFor(parent).splice(index, 0, ...copy(blocks)); f.dirty = true; f.afterInsert?.(); },
        replaceBlocks(ids, blocks) { const list = parentFor(ids[0]); list.splice(list.findIndex((block) => block.clientId === ids[0]), 1, ...copy(blocks)); f.dirty = true; },
        removeBlocks(ids) {
          const list = parentFor(ids[0]);
          list.splice(list.findIndex((block) => block.clientId === ids[0]), 1);

          if (f.ensureDefaultBlock && !f.blocks.length) f.blocks.push(wp.blocks.createBlock('core/paragraph', { content: '' }));
          f.dirty = true;
        },
        moveBlocksToPosition(ids, from, to, index) { const list = listFor(from); const [block] = list.splice(list.findIndex((block) => block.clientId === ids[0]), 1); listFor(to).splice(index, 0, block); f.dirty = true; },
        replaceInnerBlocks(id, blocks) { find(f.blocks).find(b => b.clientId === id).innerBlocks = copy(blocks); f.dirty = true; },
        resetBlocks(blocks) {
          f.blocks = copy(blocks);
          f.dirty = editor.getEditedPostContent() !== f.post.content.raw || Object.keys(f.postEdits ?? {}).length > 0;

          if (f.nativeContentMarker) {
            f.postEdits = { ...f.postEdits, content: () => wp.blocks.__unstableSerializeAndClean(f.blocks) };
            f.dirty = true;
          }

          // Native RESET_BLOCKS only retains selections present at the root.
          if (f.selectionStart?.clientId && !blocks.some((block) => block.clientId === f.selectionStart.clientId)) {
            f.selectionStart = f.selectionEnd = {};
          }
        },
        updateBlockAttributes(id, attributes) {
          const find = (list) => list.flatMap((block) => [block, ...find(block.innerBlocks || [])]);
          Object.assign(find(f.blocks).find((block) => block.clientId === id).attributes, attributes);
          f.dirty = true;
        },
      } },
    async apiFetch(options) {
      const { path, method = 'GET' } = options;
      f.requests.push({ path, method });

      if (!f.auth) throw { code: 'rest_cookie_invalid_nonce', message: 'secret' };

      if (path.includes('/users/me')) return { id: f.user_id, name: 'Test user', slug: 'test' };

      if (path === '/?_fields=url') return { url: f.site_url ?? target.site_url };

      if (f.api) {
        const value = await f.api(options);

        if (value !== undefined) return restFields(value, path, method);
      }

      if (path.startsWith('/wp/v2/types/')) return { slug: post_type, rest_base: post_type === 'page' ? 'pages' : post_type === 'post' ? 'posts' : 'books',
        rest_namespace: post_type === 'book' ? 'library/v1' : 'wp/v2', supports: { editor: true, title: true, 'custom-fields': true } };

      if (path.startsWith('/wp/v2/taxonomies')) return {};

      if (method === 'OPTIONS') {
        const raw = { type: 'object', properties: { raw: { type: 'string' } } };

        const properties = { id: { type: ['integer', 'string'], readonly: true }, type: { type: 'string', readonly: true },
          modified: { type: ['string', 'null'], readonly: true }, modified_gmt: { type: ['string', 'null'], readonly: true },
          date: { type: ['string', 'null'] }, link: { type: 'string', readonly: true },
          permalink_template: { type: 'string', readonly: true }, generated_slug: { type: 'string', readonly: true },
          author: { type: 'integer' }, password: { type: 'string' }, comment_status: { type: 'string' }, ping_status: { type: 'string' },
          sticky: { type: 'boolean' }, format: { type: 'string' }, categories: { type: 'array', items: { type: 'integer' } }, tags: { type: 'array', items: { type: 'integer' } },
          theme: { type: 'string' }, area: { type: 'string' }, wp_id: { type: 'integer', readonly: true }, source: { type: 'string', readonly: true },
          origin: { type: 'string', readonly: true }, has_theme_file: { type: 'boolean', readonly: true },
          title: raw, excerpt: raw, content: raw, slug: { type: 'string' }, status: { type: 'string', enum: ['draft', 'publish', 'pending', 'private', 'future'] },
          meta: { type: 'object', properties: { note: { type: 'string' }, count: { type: 'integer' }, footnotes: { type: 'string' } } },
          date_gmt: { type: ['string', 'null'], format: 'date-time', required: false },
          template: { type: 'string' }, parent: { type: 'integer' }, menu_order: { type: 'integer' }, featured_media: { type: 'integer' },
          ...f.schema };

        return { schema: { properties }, endpoints: [{ methods: ['POST', 'PUT', 'PATCH'], args: properties }] };
      }

      return restFields(f.post, path, method);
    },
  };

  f.window = { wp, scrollX: 0, scrollY: 0, fetch: () => Promise.resolve(new Response()) };
  f.registrations = registrations;
  f.syncContent = () => { f.post.content.raw = serialize(f.blocks); };

  // Browser invocation decodes JSON in the engine's realm, including nested patches.
  // A test moves the tab, as a redirect to the login page would, through f.location.
  f.location = new URL(url);
  const invoke = runInNewContext(`const invoke = ${engine}; (json) => invoke(JSON.parse(json))`, { window: f.window, location: f.location,
    URL, URLSearchParams, Response, TextEncoder, crypto, AbortSignal, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return Date.now() + (f.elapsedMs ?? 0); } },
    document: { body: { get className() { return f.bodyClass ?? 'wp-admin branch-7-1 version-7-1-2'; } }, createElement: () => ({ set innerHTML(html) { this.html = html.replaceAll('\u00a0', '&nbsp;').replace(/\s>\s/g, ' &gt; '); }, get innerHTML() { return this.html; } }), getElementById: (id) => f.isRendered?.(id) === false ? null : {}, querySelector: () => {
      f.canvasReads = (f.canvasReads ?? 0) + 1;

      return f.frame ?? null;
    } },
    fetch: async (url) => {
      if (String(url).startsWith('blob:')) {
        f.blobReads = (f.blobReads ?? 0) + 1;

        return { ok: true, text: async () => f.canvasHtml };
      }

      f.releases++;

      return { ok: true, text: async () => '1' };
    } });

  f.call = (operation, extra = {}) => {
    const identity = { ...target, post_type };

    if (operation === 'connect') delete identity.user_id;

    const request = { operation, target: identity };

    if (operation === 'connect') request.workflow = 'background';

    return invoke(JSON.stringify({ ...request, ...extra }));
  };

  f.edit = async (edits = changes) => {
    if (!f.window.__blockwork_editor) {
      const connected = await f.call('connect');
      assert.equal(connected.ok, true, JSON.stringify(connected));
    }

    return f.call('edit', { edits: edits.map((edit) => ({ op: 'update', ...edit })) });
  };

  f.save = async (extra = {}) => {
    const prepared = await f.call('prepare_save', extra);

    if (!prepared.ok || !prepared.receipt) return prepared;

    return f.call('save', { ...extra, receipt: prepared.receipt });
  };

  return f;
}

function defaultRoundTripFixture() {
  const f = fixture();
  f.registrations['core/image'] = { name: 'core/image', attributes: {
    url: { type: 'string' }, isDecorative: { type: 'boolean', default: false },
  } };
  f.blocks[1] = { name: 'core/group', clientId: 'images', attributes: {}, isValid: true, innerBlocks: [
    { name: 'core/image', clientId: 'image', attributes: { url: 'https://example.test/fixture.png' }, isValid: true, innerBlocks: [] },
  ] };
  const serialize = f.window.wp.blocks.serialize;
  f.window.wp.blocks.serialize = (list) => serialize(list).replaceAll(',"isDecorative":false', '');
  const parse = f.window.wp.blocks.parse;
  f.window.wp.blocks.parse = (text) => {
    const list = parse(text);
    const defaults = (blocks) => blocks.forEach((block) => {
      if (block.name === 'core/image') block.attributes.isDecorative ??= false;
      defaults(block.innerBlocks);
    });
    defaults(list);

    return list;
  };

  f.syncContent();

  return f;
}

function mixedFixture() {
  const f = fixture();
  f.blocks.push({ name: 'core/html', attributes: { content: '<p>Preserve raw bytes.</p>' }, clientId: 'raw', innerBlocks: [], isValid: true });
  f.syncContent();

  return f;
}

function linkFixture(site = target.site_url) {
  const f = fixture('page', `${site}/wp-admin/post.php?post=7&action=edit`);
  f.site_url = site;
  const call = f.call;
  f.call = (operation, extra = {}) => call(operation, { ...extra,
    target: operation === 'connect' ? { site_url: site, post_id: 7, post_type: 'page' }
      : { ...target, site_url: site } });
  f.registrations['example/link'] = { name: 'example/link', attributes: {
    url: { type: 'string' }, href: { type: 'string' }, content: { type: 'string' },
    note: { type: 'string' }, items: { type: 'array' }, id: { type: 'number' } } };

  for (const name of ['core/navigation-link', 'core/navigation-submenu']) {
    f.registrations[name] = { name, attributes: { url: { type: 'string' }, id: { type: 'number' } } };
  }

  f.types = {
    page: { slug: 'page', rest_base: 'pages', viewable: true },
    book: { slug: 'book', rest_namespace: 'library/v1', rest_base: 'books', viewable: true },
    attachment: { slug: 'attachment', rest_base: 'media', viewable: true },
    hidden: { slug: 'hidden', rest_base: 'hidden', viewable: false },
  };
  f.matches = [];
  f.api = ({ path }) => {
    // WordPress reports viewable only in edit context.
    if (path.startsWith('/wp/v2/types?')) {
      return path === '/wp/v2/types?context=edit'
        ? f.types
        : Object.fromEntries(Object.entries(f.types).map(([key, { viewable: _viewable, ...type }]) => [key, type]));
    }

    if (/^\/(wp\/v2\/pages|library\/v1\/books)\?/.test(path)) {
      const url = new URL(path, site);
      assert.equal(url.searchParams.get('status'), 'publish');
      assert.equal(url.searchParams.get('per_page'), '100');

      return f.matches.filter((record) => record.collection === url.pathname && record.slug === url.searchParams.get('slug'));
    }

    if (/^\/wp\/v2\/(media|hidden)\?/.test(path)) assert.fail(`Unexpected type lookup ${path}`);
  };

  f.markup = (attributes, name = 'example/link') => f.window.wp.blocks.serialize([{ name, attributes, innerBlocks: [] }]);

  return f;
}

function patternSectionFixture() {
  const f = fixture();
  f.registrations['core/group'].attributes.metadata = { type: 'object' };
  const group = (clientId, attributes, innerBlocks) => ({
    name: 'core/group', clientId, attributes, innerBlocks, isValid: true,
  });
  f.blocks = [group('wrapper', {}, [group('section', { metadata: { patternName: 'fixture/section' } }, [
    group('empty', {}, []), ...f.blocks,
  ])]), group('second', { metadata: { patternName: 'fixture/second' } }, [])];
  f.syncContent();
  const store = f.window.wp.data.select('core/block-editor');
  const actions = f.window.wp.data.dispatch('core/block-editor');
  f.openSection = null;
  f.sectionOpens = [];
  store.__unstableGetTemporarilyEditingAsBlocks = () => f.openSection;
  store.getBlockEditingMode = (id) => {
    if (f.openSection) {
      return (f.openSection === 'section' && ['section', 'empty', 'a', 'b'].includes(id)) ||
        id === f.openSection ? 'default' : 'disabled';
    }

    return ['empty', 'a', 'b'].includes(id) ? 'contentOnly' : 'default';
  };

  actions.__unstableSetTemporarilyEditingAsBlocks = (id) => {
    f.sectionOpens.push(id);
    f.openSection = id;
  };

  const dispatch = f.window.wp.data.dispatch;
  f.window.wp.data.dispatch = (name) => name === 'core/block-editor' ? actions : dispatch(name);

  return f;
}

function queryFixture() {
  const f = fixture();
  f.editorSettings = { ...f.editorSettings, postsPerPage: 1 };
  f.registrations['core/query'] = { name: 'core/query', attributes: { query: { type: 'object' } } };
  f.registrations['core/post-template'] = { name: 'core/post-template', ancestor: ['core/query'], attributes: {} };
  f.queryEdit = { op: 'insert', block: { name: 'core/query', attributes: { query: {
    inherit: false, postType: 'post', perPage: 1, order: 'desc', orderBy: 'date',
  } }, inner_blocks: [{ name: 'core/post-template', inner_blocks: [
    { name: 'core/paragraph', attributes: { content: 'Template child' } },
  ] }] } };

  return f;
}

function filledFixture() {
  const f = fixture();
  f.blocks[1] = { name: 'core/group', clientId: 'group', attributes: {}, innerBlocks: [] };
  f.syncContent();
  f.blocks[1].innerBlocks = [{ name: 'core/paragraph', clientId: 'filled', attributes: { content: '' }, innerBlocks: [] }];

  return f;
}

function sharedFixture(post_type = 'wp_block', identity = 7) {
  const url = post_type === 'wp_block' ? 'https://example.test/wp-admin/post.php?post=7&action=edit'
    : 'https://example.test/wp-admin/site-editor.php?canvas=edit';

  const f = fixture(post_type, url);
  const selected = { ...target, post_type, post_id: identity };
  f.post.id = identity;
  f.post.status = 'publish';

  if (['wp_template', 'wp_template_part'].includes(post_type)) {
    [f.post.theme, f.post.slug] = identity.split('//');
    f.post.wp_id = 51;
    f.post.source = 'custom';
    delete f.post.date_gmt;
    delete f.post.modified_gmt;
  }

  // Only the post editor supplies post lock utilities.
  if (post_type !== 'wp_block') f.window.wp.data.select('core/editor').getEditorSettings = () => ({});

  if (post_type === 'wp_navigation') {
    f.blocks = [{ name: 'core/navigation', attributes: { ref: identity }, clientId: 'wrapper', isValid: true, innerBlocks: f.blocks }];
    // The entity's own blocks, without the block editor's wrapper.
    f.window.wp.data.select('core/editor').getEditorBlocks = () => f.blocks[0].innerBlocks;
  }

  const call = f.call;
  f.call = (operation, extra = {}) => {
    const identity = { ...selected };

    if (operation === 'connect') delete identity.user_id;

    return call(operation, { target: identity, ...extra });
  };

  return f;
}

function referenceFixture() {
  const f = fixture();
  f.registrations['core/block'] = { name: 'core/block', attributes: { ref: { type: 'number' } } };
  const record = { ...copy(f.post), id: 77, type: 'wp_block', status: 'publish' };
  const baseApi = f.api;
  f.api = async (request) => request.method !== 'OPTIONS' && request.path.startsWith('/wp/v2/blocks/77') ? record : baseApi?.(request);
  f.referenceRecord = record;
  const clone = f.window.wp.blocks.cloneBlock;
  f.window.wp.blocks.cloneBlock = (block, attributes, innerBlocks) => ({
    ...clone(block, attributes, innerBlocks), clientId: f.window.wp.blocks.createBlock(block.name).clientId,
  });
  const select = f.window.wp.data.select;
  f.window.wp.data.select = (store) => {
    const selected = select(store);

    return store === 'core' ? { ...selected, getEditedEntityRecord: (kind, name, id) =>
      name === 'wp_block' && id === 77 ? f.editedReference : selected.getEditedEntityRecord(kind, name, id) } : selected;
  };

  return f;
}

// The editor shows stored markup until its first change, as Gutenberg does.
function storedMarkup(f, raw) {
  const wp = f.window.wp;
  f.post.content.raw = raw;
  wp.data.select('core/editor').getEditedPostContent = () => f.dirty ? wp.blocks.serialize(f.blocks) : f.post.content.raw;
}

// A canvas document's root element; zoomedOut marks Gutenberg's zoom-out mode.
const canvasRoot = (state = {}) => ({ scrollWidth: 500, classList: { contains: (name) => name === 'is-zoomed-out' && Boolean(state.zoomedOut) } });

// The in-app browser aborts Gutenberg's blob canvas navigation and leaves an
// empty about:blank document until Blockwork reloads it through srcdoc.
const stalledCanvas = (f, block, { mounts = true } = {}) => {
  const view = { innerWidth: 500, innerHeight: 800, requestAnimationFrame: (callback) => callback(),
    getComputedStyle: () => ({ display: 'block', getPropertyValue: () => '' }) };
  const canvas = { URL: 'about:blank', readyState: 'complete', body: { childElementCount: 0 },
    documentElement: canvasRoot(), defaultView: view, getElementById: () => null };
  f.canvasHtml = '<!doctype html><html><body>Native canvas fixture</body></html>';
  f.frame = { src: 'blob:https://example.test/native-canvas', isConnected: true, contentDocument: canvas, contentWindow: view,
    parentElement: null, closest: () => null, clientLeft: 0, clientTop: 0, clientWidth: 500, clientHeight: 800,
    getBoundingClientRect: () => ({ width: 500, height: 800, left: 0, top: 0 }),
    get srcdoc() { return this.html ?? ''; },
    set srcdoc(value) {
      this.html = value;

      if (!mounts) {
        f.elapsedMs = 6000;

        return;
      }

      // Gutenberg mounts the canvas, then renders blocks into it a little later.
      setTimeout(() => { canvas.URL = 'about:srcdoc'; canvas.body.childElementCount = 1; }, 20);
      setTimeout(() => { canvas.getElementById = (id) => (id === 'block-a' ? block : null); }, 40);
    } };
  f.window.wp.data.select('core/editor').getDeviceType = () => 'Desktop';
};

const canvasBlock = () => ({ tagName: 'P', matches: () => false, querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 80, left: 10, top: 20, right: 110, bottom: 100 }) });

// An editor whose Desktop canvas is the window less 350px of List View, and
// whose Tablet preview is a 781px resizable canvas inside 24px of padding.
const sizedEditor = (f) => {
  const box = { style: { width: '100%' } };
  f.box = box;
  f.device = 'Desktop';
  f.window.innerWidth = 1280;
  f.window.innerHeight = 1080;
  const space = () => f.window.innerWidth - 350;
  const set = () => Number.parseFloat(box.style.width);
  const width = () => (box.style.width.endsWith('px') ? Math.min(set(), space() - 48) : space());
  const view = { get innerWidth() { return width(); }, innerHeight: 900, requestAnimationFrame: (callback) => callback(),
    getComputedStyle: () => ({ display: 'block', overflowX: 'visible', getPropertyValue: () => '' }) };
  f.frame = { contentDocument: { body: { childElementCount: 1 }, defaultView: view, documentElement: canvasRoot(f),
    getElementById: (id) => (id === 'block-a' ? canvasBlock() : null) },
    contentWindow: view, parentElement: null, clientLeft: 0, clientTop: 0, clientHeight: 900, closest: () => box,
    get clientWidth() { return width(); },
    getBoundingClientRect: () => ({ width: width(), height: 900, left: 0, top: 0 }) };
  f.window.wp.data.select('core/editor').getDeviceType = () => f.device;
  f.window.wp.data.dispatch('core/editor').setDeviceType = (device) => {
    f.device = device;
    box.style.width = { Tablet: '781px', Mobile: '479px' }[device] ?? '100%';
  };
};

function explicitFootnoteFixture() {
  const f = fixture('post');
  f.blocks = [f.blocks[0], f.blocks[2]];
  f.post.meta = { footnotes: '[]', note: 'Retained' };
  f.syncContent();
  f.registrations['core/footnotes'] = { name: 'core/footnotes', attributes: {}, supports: { multiple: false } };
  const wp = f.window.wp;
  wp.richText = footnoteRichText;
  wp.blocks.__unstableSerializeAndClean = values => values.length === 1 && wp.blocks.isUnmodifiedDefaultBlock(values[0]) ? '' : wp.blocks.serialize(values);
  const select = wp.data.select;
  const dispatch = wp.data.dispatch;
  const editor = select('core/editor');
  const blocks = select('core/block-editor');
  let entityBlocks;
  let entityContent;
  f.pairedWrites = 0;
  f.settingsWrites = 0;
  f.selectionStart = f.selectionEnd = { clientId: 'c', attributeKey: 'content', offset: 2 };
  f.caret = 0;
  const postActions = dispatch('core/editor');
  const editPost = postActions.editPost;
  postActions.editPost = (values) => { f.settingsWrites++;

 return editPost(values); };

  const core = { ...select('core'), getEditedEntityRecord: () => ({
    blocks: entityBlocks, content: entityContent ?? f.postEdits?.content ?? f.post.content.raw,
    meta: f.postEdits?.meta ?? f.post.meta,
  }) };
  const entityActions = { editEntityRecord(kind, type, id, edits, options) {
    assert.deepEqual([kind, type, id, copy(options)], ['postType', 'post', 7, { isCached: false }]);
    f.pairedWrites++;
    entityBlocks = copy(edits.blocks);
    entityContent = edits.content;
    f.postEdits = { ...f.postEdits };

    if (JSON.stringify(edits.meta) === JSON.stringify(f.post.meta)) delete f.postEdits.meta;
    else f.postEdits.meta = copy(edits.meta);

    if (edits.content === f.post.content.raw) delete f.postEdits.content;
    else f.postEdits.content = edits.content;

    if (!f.entityOnly) f.blocks = copy(edits.blocks);
    f.selectionStart = copy(edits.selection.selectionStart);
    f.selectionEnd = copy(edits.selection.selectionEnd);
    f.caret = edits.selection.initialPosition;
    f.dirty = editor.getEditedPostContent() !== f.post.content.raw || Object.keys(f.postEdits).length > 0;
    f.afterPaired?.();
  } };
  wp.data.select = (name) => name === 'core' ? core : select(name);
  wp.data.dispatch = (name) => name === 'core' ? entityActions : dispatch(name);
  wp.element = { flushSync(callback) { f.beforeFlush?.(); callback(); f.afterFlush?.(); } };
  f.foreignMeta = () => { f.postEdits = { ...f.postEdits, meta: {
    ...(f.postEdits?.meta ?? f.post.meta), note: 'Foreign',
  } }; f.dirty = true; };

  f.footnoteRequest = {
    edits: [
      { op: 'update', path: [0], attributes: { content: 'Reference <sup data-fn="note_a" class="fn"><a href="#note_a" id="note_a-link">1</a></sup>' } },
      { op: 'insert', block: { name: 'core/footnotes' } },
    ],
    settings: { meta: { footnotes: JSON.stringify([{ id: 'note_a', content: 'Inserted note' }]) } },
  };
  f.selection = () => [copy(blocks.getSelectionStart()), copy(blocks.getSelectionEnd()), blocks.getSelectedBlocksInitialCaretPosition()];

  return f;
}

function completeTabsFixture(action = 'label') {
  const f = explicitFootnoteFixture();
  const wp = f.window.wp;

  for (const name of ['tabs', 'tab-list', 'tab-panels', 'tab-panel']) {
    f.registrations['core/' + name] = { name: 'core/' + name, attributes: {
      label: { type: 'string' }, tabs: { type: 'array' }, editorActiveTabIndex: { type: 'number', role: 'local' },
    } };
  }

  const block = (name, clientId, attributes = {}, innerBlocks = []) => ({ name: 'core/' + name, clientId, attributes, innerBlocks, isValid: true });
  f.blocks = [block('tabs', 'tabs', { editorActiveTabIndex: 0 }, [
    block('tab-list', 'list', { tabs: ['First', 'Second', 'Third'].map(label => ({ label })) }),
    block('tab-panels', 'panels', {}, ['First', 'Second', 'Third'].map((label, i) => block('tab-panel', 'panel' + i, { label }, [block('paragraph', 'text' + i, { content: label })]))),
  ])];
  f.syncContent();
  const core = wp.data.select('core');
  let entityBlocks;
  let entityContent;
  core.getEditedEntityRecord = () => ({ blocks: entityBlocks, content: entityContent ?? f.post.content.raw, meta: f.postEdits?.meta ?? f.post.meta });
  const actions = wp.data.dispatch('core');
  actions.editEntityRecord = (_kind, _type, _id, edits) => {
    assert.equal(Object.hasOwn(edits, 'meta'), false);
    f.pairedWrites++;
    entityBlocks = copy(edits.blocks);
    entityContent = f.replacePairedContent && edits.content !== f.post.content.raw
      ? record => edits.content(record)
      : edits.content;
    f.blocks = copy(edits.blocks);

    if (edits.content === f.post.content.raw) delete f.postEdits.content;
    else f.postEdits.content = entityContent;
    f.dirty = Object.keys(f.postEdits).length > 0;
    f.afterPaired?.();
  };

  const updates = wp.data.dispatch('core/block-editor');
  const single = updates.updateBlockAttributes;
  updates.updateBlockAttributes = (ids, attrs, unique) => {
    if (!Array.isArray(ids)) return single(ids, attrs);
    assert.equal(unique, true); f.attributeGroups = (f.attributeGroups ?? 0) + 1;

    for (const id of ids) single(id, attrs[id]);
    entityContent = ({ blocks = f.blocks }) => wp.blocks.__unstableSerializeAndClean(blocks);
    f.postEdits.content = entityContent; f.afterPaired?.();
  };

  const dispatch = wp.data.dispatch;
  wp.data.dispatch = name => name === 'core/block-editor' ? updates : dispatch(name);
  f.selectionStart = f.selectionEnd = { clientId: 'text0', attributeKey: 'content', offset: 2 };
  f.postEdits = {};
  const labels = action === 'label' ? ['Renamed', 'Second', 'Third'] : action === 'remove' ? ['First', 'Second'] : ['Second', 'First', 'Third'];
  f.tabsRequest = { edits: [action === 'label'
    ? { op: 'update', path: [0, 1, 0], attributes: { label: 'Renamed' } }
    : action === 'remove' ? { op: 'remove', path: [0, 1, 2] }
      : { op: 'move', path: [0, 1, 0], parent: [0, 1], index: 1 },
    ...(action === 'label' ? [] : [{ op: 'update', path: [0], attributes: { editorActiveTabIndex: 1 } }]),
    { op: 'update', path: [0, 0], attributes: { tabs: labels.map(label => ({ label })) } },
  ] };

  return f;
}

function structuralFootnoteFixture() {
  const f = explicitFootnoteFixture();
  f.window.wp.richText = footnoteRichText;
  f.blocks = [
    { ...footnoteParagraph('note_a', 1), clientId: 'a' },
    { ...footnoteParagraph('note_b', 2), clientId: 'b' },
    f.blocks[1],
    {
      name: 'core/footnotes',
      clientId: 'footnotes',
      attributes: {},
      innerBlocks: [],
      isValid: true,
    },
  ];
  f.post.meta.footnotes = footnoteBodies(['note_a', 'note_b']);
  f.syncContent();

  return f;
}

function emptyCommentsFixture() {
  const f = fixture();

  for (const name of ['core/comments', 'core/comment-template']) {
    f.registrations[name] = { name, attributes: { metadata: { type: 'object' } } };
  }

  const wp = f.window.wp;
  const hidden = wp.blocks.createBlock('core/group', {}, [wp.blocks.createBlock('core/paragraph', { content: 'Comment body' })]);
  const template = wp.blocks.createBlock('core/comment-template', {}, [hidden]);
  const visible = wp.blocks.createBlock('core/group', {}, [template]);
  const root = wp.blocks.createBlock('core/comments', {}, [visible]);
  const pattern = { name: 'example/comments', title: 'Comments', content: wp.blocks.serialize([root]), blocks: [root] };
  f.patterns = [pattern];
  f.editorSettings = { __experimentalDiscussionSettings: { pageComments: '1', commentsPerPage: '50', defaultCommentsPage: 'newest' } };
  const select = wp.data.select;
  const resolve = wp.data.resolveSelect;
  wp.data.select = (name) => name === 'core' ? {
    ...select(name), getEntityRecords: () => [], getEntityRecordsTotalItems: () => 0,
    hasFinishedResolution: () => true,
  } : select(name);
  wp.data.resolveSelect = (name) => ({ ...resolve(name), getEntityRecords: async () => [] });
  const store = select('core/block-editor');
  store.__experimentalGetAllowedPatterns = () => [pattern];

  return { f, wp, store, root, visible, template, hidden, request: [{ op: 'insert_pattern', pattern: pattern.name }] };
}

function completeGalleryFixture() {
  const f = completeTabsFixture();
  const wp = f.window.wp;
  const attrs = Object.fromEntries(
    [
      'url',
      'alt',
      'sizeSlug',
      'caption',
      'linkDestination',
      'href',
      'align',
      'linkTarget',
      'rel',
      'className',
      'aspectRatio',
    ].map((key) => [key, { type: 'string' }]),
  );
  f.registrations['core/image'] = {
    name: 'core/image',
    attributes: { ...attrs, id: { type: 'integer' }, lightbox: { type: 'object' } },
  };
  f.registrations['core/gallery'] = {
    name: 'core/gallery',
    attributes: {
      sizeSlug: { type: 'string' },
      linkTo: { type: 'string' },
      aspectRatio: { type: 'string' },
    },
  };
  const image = (clientId, attributes) => ({
    name: 'core/image',
    clientId,
    attributes,
    innerBlocks: [],
    isValid: true,
  });
  f.blocks = [
    {
      name: 'core/gallery',
      clientId: 'gallery',
      attributes: { sizeSlug: 'large', linkTo: 'none', aspectRatio: 'auto' },
      isValid: true,
      innerBlocks: [
        image('image', { caption: '', sizeSlug: 'large', align: 'left', className: 'retained' }),
        image('sibling', {
          id: 21,
          url: 'https://example.test/sibling.jpg',
          caption: 'Sibling caption',
          href: 'https://example.test/custom',
          linkDestination: 'custom',
          rel: 'noreferrer',
          className: 'sibling-class',
        }),
      ],
    },
  ];
  const serialize = wp.blocks.serialize;
  const withoutUi = (blocks) =>
    blocks.map((block) => {
      const attributes = { ...block.attributes };

      if (block.name === 'core/image') {
        for (const key of ['fullUrl', 'link']) {
          if (!f.registrations['core/image'].attributes[key] && !f.serializeGalleryUi)
            delete attributes[key];
        }
      }

      return { ...block, attributes, innerBlocks: withoutUi(block.innerBlocks ?? []) };
    });
  wp.blocks.serialize = (blocks) => serialize(withoutUi(blocks));
  wp.data.select('core/editor').getEditedPostContent = () => wp.blocks.serialize(f.blocks);
  f.syncContent = () => {
    f.post.content.raw = wp.blocks.serialize(f.blocks);
  };

  f.syncContent();
  f.selectionStart = f.selectionEnd = { clientId: 'image', attributeKey: 'caption', offset: 0 };
  f.media = {
    id: 20,
    media_type: 'image',
    mime_type: 'image/jpeg',
    source_url: 'https://example.test/full.jpg',
    link: 'https://example.test/attachment',
    alt_text: 'Attachment alt',
    caption: { raw: 'Attachment caption' },
    media_details: {
      sizes: {
        full: {
          source_url: 'https://example.test/full.jpg',
          width: 1200,
          height: 800,
          file: 'full.jpg',
          mime_type: 'image/jpeg',
        },
      },
    },
  };
  f.api = ({ path }) => (path.startsWith('/wp/v2/media/20') ? f.media : undefined);
  f.resolveRecords = async (kind, name, query) => {
    assert.deepEqual(
      [kind, name, copy(query)],
      ['postType', 'attachment', { include: '20,21', per_page: -1, orderby: 'include' }],
    );
    f.galleryRecords = [copy(f.media)];

    return f.galleryRecords;
  };

  wp.data.select('core').getEntityRecords = () => f.galleryRecords;
  const save = wp.data.dispatch('core/editor').savePost;
  wp.data.dispatch('core/editor').savePost = async () => {
    await save();
    f.syncContent();
  };

  f.galleryRequest = async () => {
    const inspected = await f.call('inspect_media', {
      target: { site_url: target.site_url, user_id: 5 },
      id: 20,
    });

    return {
      edits: [
        {
          op: 'update',
          path: [0],
          name: 'core/gallery',
          attributes: { sizeSlug: 'full', linkTo: 'none' },
        },
        {
          op: 'update',
          path: [0, 0],
          name: 'core/image',
          attributes: { caption: 'Chosen caption', sizeSlug: 'full', linkDestination: 'none' },
          unset: ['align'],
        },
      ],
      media_bindings: [
        {
          path: [0, 0],
          name: 'core/image',
          media_id: 20,
          media_token: inspected.record.edit_token,
          size: 'full',
          bind: { id: 'id', url: 'url', alt: 'alt', size_slug: 'sizeSlug' },
        },
      ],
    };
  };

  return f;
}

function completeContextFixture() {
  const f = completeTabsFixture();
  f.registrations['example/context-box'] = { name: 'example/context-box', attributes: { tone: { type: 'string' } }, providesContext: { 'example/tone': 'tone' } };
  f.registrations['example/context-label'] = { name: 'example/context-label', attributes: { resolvedTone: { type: 'string' } }, usesContext: ['example/tone'] };
  const leaf = { name: 'example/context-label', clientId: 'leaf', attributes: { resolvedTone: 'red' }, innerBlocks: [], isValid: true };
  f.blocks = ['red', 'blue'].map((tone, i) => ({ name: 'example/context-box', clientId: 'box' + i, attributes: { tone }, innerBlocks: i ? [] : [leaf], isValid: true }));
  f.selectionStart = f.selectionEnd = { clientId: 'leaf', attributeKey: 'resolvedTone', offset: 0 };
  f.syncContent();
  f.contextRequest = { edits: [{ op: 'move', path: [0, 0], parent: [1], index: 0 }, { op: 'update', path: [1, 0], attributes: { resolvedTone: 'blue' } }] };

  return f;
}

function completeTabsAddFixture() {
  const f = completeTabsFixture();
  f.tabsRequest = { edits: [
    { op: 'insert', parent: [0, 1], block: { name: 'core/tab-panel', attributes: { label: 'Fourth' }, inner_blocks: [{ name: 'core/paragraph' }] } },
    { op: 'update', path: [0], attributes: { editorActiveTabIndex: 3 } },
    { op: 'update', path: [0, 0], attributes: { tabs: ['First', 'Second', 'Third', 'Fourth'].map(label => ({ label })) } },
  ] };

  return f;
}

function ordinaryMetaFixture() {
  const f = fixture();
  f.post.meta = { note: 'Before', other: 1 };
  f.schema = { meta: { type: 'object', properties: { note: { type: 'string' }, other: { type: 'integer' } } } };

  return f;
}

function ordinaryBlockActions(f) {
  const dispatch = f.window.wp.data.dispatch;
  const actions = dispatch('core/block-editor');
  f.window.wp.data.dispatch = name => name === 'core/block-editor' ? actions : dispatch(name);

  return actions;
}

export { source, target, changes, copy, outsideDebug, stylingFixture, styleEdit, fixture, defaultRoundTripFixture, mixedFixture, linkFixture, patternSectionFixture, queryFixture, filledFixture, sharedFixture, referenceFixture, storedMarkup, canvasRoot, stalledCanvas, canvasBlock, sizedEditor, explicitFootnoteFixture, completeTabsFixture, structuralFootnoteFixture, emptyCommentsFixture, completeGalleryFixture, completeContextFixture, completeTabsAddFixture, ordinaryMetaFixture, ordinaryBlockActions };
