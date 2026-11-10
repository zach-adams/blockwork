import * as v from 'valibot';
import { JsonObjectSchema, PostTypeSchema } from './contracts';
import type { JsonObject, JsonValue } from './contracts';
import type { Block, WordPress } from './wordpress';
import { containsPath, postDateField, readTree, requireCondition as assert } from './inspection';
import { withinInitialization } from './initialization';
import { remainingMs } from './timing';
import { BlockworkError } from './errors';
import { same } from './values';

async function resolvePreview<T>(
  work: () => Promise<T>,
  deadline: number,
  diagnostics: JsonObject,
): Promise<T> {
  try {
    return await withinInitialization(work, deadline, diagnostics);
  } catch (error) {
    if (error instanceof BlockworkError && error.code === 'native_initialization_unsettled') {
      throw new BlockworkError('query_preview_unsettled', error.diagnostics);
    }

    throw error;
  }
}

export interface QueryPreview {
  type: string;
  args: JsonObject;
  records: JsonValue[];
}

// Post Template mounts its editable children only when its native query has
// results. Resolve preview queries before starting the mutation budget.
export async function checkQueryPreviews(
  wp: WordPress,
  blocks: Block[],
  affected: Map<string, number>,
): Promise<Map<string, QueryPreview>> {
  const previews = new Map<string, QueryPreview>();
  const rows = readTree(wp, blocks);
  const deadline = Date.now() + Math.min(12000, remainingMs());

  for (const template of rows.filter(
    (row) => row.name === 'core/post-template' && affected.has(row.clientId),
  )) {
    const owner = [...rows]
      .reverse()
      .find((row) => row.name === 'core/query' && containsPath(row.path, template.path));
    const context = queryContext(wp, blocks, template.path);
    const query = context.query;
    const diagnostics = {
      stage: 'query_preview_preflight',
      target_path: template.path,
      block_name: template.name,
      edit_index: affected.get(template.clientId),
    };
    const unavailable = (reason: string) => ({ ...diagnostics, reason });
    assert(
      owner && v.is(JsonObjectSchema, query),
      'query_preview_context_unavailable',
      unavailable('query_attribute_missing'),
    );
    assert(
      !rows.some(
        (row) =>
          row.path.length > owner.path.length &&
          row.path.length < template.path.length &&
          containsPath(row.path, template.path) &&
          ['query'].some((key) => wp.blocks.getBlockType(row.name)?.providesContext?.[key]),
      ),
      'query_preview_context_unavailable',
      unavailable('nested_query_context'),
    );
    const {
      perPage,
      offset,
      postType = 'post',
      order,
      orderBy,
      author,
      search,
      exclude,
      sticky,
      inherit,
      taxQuery,
      parents,
      pages: _pages,
      format,
      excludeCurrent,
      ...extra
    } = query;
    assert(
      v.is(PostTypeSchema, postType),
      'query_preview_context_unavailable',
      unavailable('unsupported_post_type'),
    );
    const args: JsonObject = { offset: offset || 0, order, orderby: orderBy };
    const core = wp.data.resolveSelect?.('core');
    const resolver = core?.getEntityRecords;
    assert(resolver, 'native_readiness_unavailable', diagnostics);

    if (taxQuery && !inherit && v.is(JsonObjectSchema, taxQuery)) {
      const getTaxonomies = core?.getTaxonomies;
      assert(getTaxonomies, 'native_readiness_unavailable', diagnostics);
      const taxonomies = await resolvePreview(
        () => getTaxonomies({ type: postType, per_page: -1, context: 'view' }),
        deadline,
        { ...diagnostics, budget_ms: 12000, pending_resolver: 'core.getTaxonomies' },
      );
      assert(Array.isArray(taxonomies), 'query_preview_unavailable', diagnostics);

      for (const [terms, suffix] of [
        [taxQuery.include, ''],
        [taxQuery.exclude, '_exclude'],
      ] as const) {
        if (!v.is(JsonObjectSchema, terms)) {
          continue;
        }

        for (const [slug, ids] of Object.entries(terms)) {
          const taxonomy = taxonomies.find(
            (item) => v.is(JsonObjectSchema, item) && item.slug === slug,
          );

          if (
            v.is(JsonObjectSchema, taxonomy) &&
            typeof taxonomy.rest_base === 'string' &&
            Array.isArray(ids) &&
            ids.length
          ) {
            args[taxonomy.rest_base + suffix] = ids;
          }
        }
      }
    }

    for (const [value, name] of [
      [perPage, 'per_page'],
      [author, 'author'],
      [search, 'search'],
      [exclude, 'exclude'],
      [parents, 'parent'],
      [format, 'format'],
    ] as const) {
      if (
        value &&
        (!['exclude', 'parent', 'format'].includes(name) ||
          ((Array.isArray(value) || typeof value === 'string') && value.length))
      ) {
        args[name] = value;
      }
    }

    if (excludeCurrent) {
      const id = context.postId;
      assert(
        v.is(v.number(), id) && Number.isInteger(id) && id > 0,
        'query_preview_context_unavailable',
        unavailable('exclude_current_context'),
      );
      args.exclude = [...(Array.isArray(exclude) ? exclude : []), id];
    }

    if (sticky === 'only' || sticky === 'exclude') {
      args.sticky = sticky === 'only';
    }

    if (sticky === '' || sticky === 'ignore') {
      args.ignore_sticky = sticky === 'ignore';
    }

    let usedPostType = postType;
    const templateSlug = context.templateSlug;

    if (inherit && typeof templateSlug === 'string') {
      if (templateSlug.startsWith('archive-')) {
        usedPostType = templateSlug.replace('archive-', '');
        assert(
          v.is(PostTypeSchema, usedPostType),
          'query_preview_context_unavailable',
          unavailable('unsupported_post_type'),
        );
        args.postType = usedPostType;
      } else if (templateSlug.startsWith('category-') || templateSlug.startsWith('tag-')) {
        const category = templateSlug.startsWith('category-');
        const prefix = category ? 'category-' : 'tag-';
        const terms = await resolvePreview(
          () =>
            resolver('taxonomy', category ? 'category' : 'post_tag', {
              context: 'view',
              per_page: 1,
              _fields: ['id'],
              slug: templateSlug.replace(prefix, ''),
            }),
          deadline,
          { ...diagnostics, budget_ms: 12000, pending_resolver: 'core.getEntityRecords' },
        );

        if (Array.isArray(terms) && v.is(JsonObjectSchema, terms[0])) {
          args[category ? 'categories' : 'tags'] = terms[0].id;
        }
      } else if (templateSlug.startsWith('taxonomy-post_format')) {
        args.format = templateSlug.replace('taxonomy-post_format-post-format-', '');
      }
    }

    if (context.previewPostType) {
      assert(
        v.is(PostTypeSchema, context.previewPostType),
        'query_preview_context_unavailable',
        unavailable('unsupported_post_type'),
      );
      usedPostType = context.previewPostType;
    }

    Object.assign(args, extra);
    const records = await resolvePreview(() => resolver('postType', usedPostType, args), deadline, {
      ...diagnostics,
      budget_ms: 12000,
      pending_resolver: 'core.getEntityRecords',
    });

    assert(Array.isArray(records), 'query_preview_unavailable', diagnostics);

    // Without results, Gutenberg leaves template children unmounted and cannot
    // establish their native insertion policies. Refuse the entire plan now.
    assert(records.length > 0, 'query_preview_empty', diagnostics);
    previews.set(template.clientId, { type: usedPostType, args, records });
  }

  return previews;
}

interface QuerySiteSelectors {
  canUser?(action: 'read', resource: { kind: 'root'; name: 'site' }): boolean | undefined;
  getEntityRecord?(kind: 'root', name: 'site'): JsonObject | undefined;
  getEntityRecordEdits?(kind: 'root', name: 'site'): JsonObject | undefined;
}

function queryContext(wp: WordPress, blocks: Block[], path: number[]): JsonObject {
  const post = wp.data.select('core/editor').getCurrentPost();
  const context: JsonObject = {
    postId: wp.data.select('core/editor').getCurrentPostId?.(),
    postType: post.type === 'wp_template' ? undefined : post.type,
    templateSlug: post.type === 'wp_template' ? post.slug : undefined,
  };

  for (const ancestor of readTree(wp, blocks)) {
    if (ancestor.path.length >= path.length || !containsPath(ancestor.path, path)) {
      continue;
    }

    const providers = wp.blocks.getBlockType(ancestor.name)?.providesContext ?? {};

    for (const key of [
      'postType',
      'templateSlug',
      'previewPostType',
      'postId',
      'query',
      'queryId',
      'enhancedPagination',
    ]) {
      if (providers[key]) {
        context[key] = ancestor.attributes[providers[key]];
      } else if (ancestor.name === 'core/query' && key === 'query') {
        context.query = ancestor.attributes.query;
      }
    }
  }

  return context;
}

// Return a synchronous guard so callers can recheck resolved dependencies next
// to the dispatch without opening another asynchronous mutation window.
export async function prepareQueryNormalization(
  wp: WordPress,
  before: Block[],
  after: Block[],
  targets: Block[],
  originalIds: Set<string>,
  editIndex: number,
): Promise<() => void> {
  const previous = new Map(readTree(wp, before).map((row) => [row.clientId, row]));
  const targetIds = new Set(targets.map((block) => block.clientId));
  const queries = readTree(wp, after).filter((row) => {
    if (row.name !== 'core/query') {
      return false;
    }

    const prior = previous.get(row.clientId);

    return (
      !prior ||
      targetIds.has(row.clientId) ||
      !same(prior.attributes, row.attributes) ||
      !same(queryContext(wp, before, prior.path), queryContext(wp, after, row.path))
    );
  });
  const needsSite = queries.some((row) => {
    const query = row.attributes.query;

    return (
      v.is(JsonObjectSchema, query) &&
      (query.inherit || !query.perPage) &&
      (originalIds.has(row.clientId) || query.perPage !== undefined)
    );
  });
  const deadline = Date.now() + Math.min(12000, remainingMs());
  // SAFETY: These optional native selectors are checked before dependent reads below.
  const site = wp.data.select('core') as QuerySiteSelectors;

  if (needsSite) {
    const resolver = wp.data.resolveSelect?.('core');
    assert(
      resolver?.canUser &&
        resolver.getEntityRecord &&
        site.getEntityRecordEdits &&
        site.canUser &&
        site.getEntityRecord,
      'native_readiness_unavailable',
      { stage: 'query_normalization_preflight', edit_index: editIndex, completed_edits: 0 },
    );
    const canRead = await withinInitialization(
      () => resolver.canUser!('read', { kind: 'root', name: 'site' }),
      deadline,
      { stage: 'query_normalization_preflight', pending_resolver: 'core.canUser' },
    );
    assert(canRead !== undefined, 'native_readiness_unavailable');

    if (canRead) {
      await withinInitialization(() => resolver.getEntityRecord!('root', 'site'), deadline, {
        stage: 'query_normalization_preflight',
        pending_resolver: 'core.getEntityRecord',
      });
    }
  }

  const check = () => {
    for (const row of queries) {
      const details = {
        stage: 'query_normalization_preflight',
        edit_index: editIndex,
        target_path: row.path,
        block_name: row.name,
      };
      const query = row.attributes.query;
      assert(v.is(JsonObjectSchema, query), 'query_preview_context_unavailable', {
        ...details,
        reason: 'query_attribute_missing',
      });
      const fields: string[] = [];
      const nativeValues: JsonObject = {};
      const isExisting = originalIds.has(row.clientId);

      if ((query.inherit || !query.perPage) && (isExisting || query.perPage !== undefined)) {
        const canRead = site.canUser?.('read', { kind: 'root', name: 'site' });
        assert(canRead !== undefined, 'native_readiness_unavailable', details);
        const edited = site.getEntityRecordEdits?.('root', 'site');
        const record = site.getEntityRecord?.('root', 'site');
        const settings = wp.data.select('core/block-editor').getSettings?.();
        assert(!canRead || record, 'native_readiness_unavailable', details);
        const postsPerPage =
          Number(edited?.posts_per_page) ||
          (canRead ? Number(record?.posts_per_page) : Number(settings?.postsPerPage)) ||
          3;

        if ((query.inherit && query.perPage !== postsPerPage) || !query.perPage) {
          fields.push('query.perPage');
          nativeValues['query.perPage'] = postsPerPage;
        }
      }

      if (query.excludeCurrent !== null && (isExisting || query.excludeCurrent !== undefined)) {
        const context = queryContext(wp, after, row.path);
        const slug = context.templateSlug;
        assert(
          slug === undefined || typeof slug === 'string',
          'query_preview_context_unavailable',
          { ...details, reason: 'template_context' },
        );
        let templateType = slug === 'wp' ? 'custom' : slug;

        if (typeof slug === 'string' && slug.includes('-') && slug.split('-').slice(1).join('-')) {
          templateType = slug.split('-')[0];
        }

        const singular =
          !slug || ['404', 'blank', 'single', 'page', 'custom'].includes(String(templateType));
        let eligible = false;

        if (singular && !query.inherit) {
          if (query.postType === templateType && templateType !== undefined) {
            eligible = true;
          } else {
            assert(v.is(PostTypeSchema, context.postType), 'query_preview_context_unavailable', {
              ...details,
              reason: 'exclude_current_context',
            });
            eligible = query.postType === context.postType;
          }
        }

        if (!eligible) {
          fields.push('query.excludeCurrent');
          nativeValues['query.excludeCurrent'] = null;
        }
      }

      assert(!fields.length, 'native_requested_value_changed', {
        ...details,
        properties: fields,
        native_values: nativeValues,
        repair:
          'Inspect the Query attributes and context. Supply values the native Query preserves before retrying.',
      });
    }
  };

  check();

  return check;
}

// An empty native template can populate Date children when it mounts.
export function checkPostDateTemplates(
  wp: WordPress,
  blocks: Block[],
  affected?: Set<string>,
): void {
  const rows = readTree(wp, blocks);
  const empty = rows.find(
    (row) =>
      row.name === 'core/post-template' &&
      !row.block.innerBlocks?.length &&
      (!affected ||
        rows.some(
          (ancestor) => affected.has(ancestor.clientId) && containsPath(ancestor.path, row.path),
        )),
  );
  assert(!empty, 'post_date_context_unavailable', {
    stage: 'post_date_context_preflight',
    target_path: empty?.path,
    reason: 'automatic_post_template_children_unproven',
    next_step:
      'Inspect the native Post Template children and supply that explicit tree, including Post Date blocks, before retrying. Automatic template population is unsupported.',
  });
}

// Resolve only dates that this render can mount or whose context an edit changes.
// A guard reads the same public source immediately before native rendering.
export async function preparePostDates(
  wp: WordPress,
  blocks: Block[],
  affected?: Set<string>,
): Promise<() => void> {
  const rows = readTree(wp, blocks);
  checkPostDateTemplates(wp, blocks, affected);
  const dates = rows.filter(
    (row) =>
      postDateField(row) &&
      (!affected ||
        rows.some(
          (ancestor) => affected.has(ancestor.clientId) && containsPath(ancestor.path, row.path),
        )),
  );

  if (!dates.length) {
    return () => undefined;
  }

  const templates = new Map<string, number>();
  const root = wp.data.select('core/editor').getCurrentPost();
  const rootContext = { type: root.type, slug: root.slug };
  const rootId = wp.data.select('core/editor').getCurrentPostId();
  const deadline = Date.now() + Math.min(12000, remainingMs());
  const details = (path: number[], reason: string): JsonObject => ({
    stage: 'post_date_context_preflight',
    target_path: path,
    block_name: 'core/post-date',
    reason,
    next_step:
      'Read the Post Date and its Query context. Supply explicit Post Template children and resolve every preview post with a valid backing date before retrying. Never invent a datetime or replay an uncertain mutation.',
  });

  for (const row of dates) {
    const ancestors = rows.filter(
      (ancestor) => ancestor.path.length < row.path.length && containsPath(ancestor.path, row.path),
    );
    const owners = ancestors.filter((ancestor) => ancestor.name === 'core/post-template');
    assert(
      owners.length <= 1,
      'post_date_context_unavailable',
      details(row.path, 'nested_post_template'),
    );

    for (const ancestor of ancestors) {
      const providers = wp.blocks.getBlockType(ancestor.name)?.providesContext ?? {};
      assert(
        ['core/query', 'core/post-template'].includes(ancestor.name) ||
          !Object.keys(providers).some((key) =>
            ['postId', 'postType', 'query', 'previewPostType', 'templateSlug'].includes(key),
          ),
        'post_date_context_unavailable',
        details(row.path, 'unknown_context_provider'),
      );
    }

    if (owners[0]) {
      templates.set(owners[0].clientId, 0);
    }
  }

  const previews = await checkQueryPreviews(wp, blocks, templates);
  const requirements: Array<{
    clientId: string;
    field: 'date' | 'modified';
    context: JsonObject;
    path: number[];
  }> = [];

  for (const row of dates) {
    const field = postDateField(row)!;
    const context = queryContext(wp, blocks, row.path);
    const template = rows.find(
      (ancestor) => ancestor.name === 'core/post-template' && containsPath(ancestor.path, row.path),
    );
    const preview = template && previews.get(template.clientId);

    if (preview) {
      for (const record of preview.records) {
        assert(
          v.is(JsonObjectSchema, record) &&
            v.is(PostTypeSchema, record.type) &&
            v.is(v.number(), record.id) &&
            Number.isInteger(record.id) &&
            record.id > 0,
          'post_date_context_unavailable',
          details(row.path, 'invalid_preview_entity'),
        );
        requirements.push({
          clientId: row.clientId,
          field,
          path: row.path,
          context: { ...context, postId: record.id, postType: record.type },
        });
      }
    } else {
      assert(
        v.is(PostTypeSchema, context.postType) &&
          !String(context.postType).startsWith('wp_') &&
          v.is(v.number(), context.postId) &&
          Number.isInteger(context.postId) &&
          context.postId > 0,
        'post_date_context_unavailable',
        details(row.path, 'current_post_context_unavailable'),
      );
      requirements.push({ clientId: row.clientId, field, context, path: row.path });
    }
  }

  const resolve = wp.data.resolveSelect?.('core').getEditedEntityRecord;
  assert(
    resolve,
    'post_date_context_unavailable',
    details(dates[0].path, 'entity_resolver_unavailable'),
  );

  for (const requirement of requirements) {
    await resolvePreview(
      () =>
        resolve(
          'postType',
          String(requirement.context.postType),
          Number(requirement.context.postId),
        ),
      deadline,
      details(requirement.path, 'backing_entity_unsettled'),
    );
  }

  const check = () => {
    const current = wp.data.select('core/editor').getCurrentPost();
    assert(
      same({ type: current.type, slug: current.slug }, rootContext) &&
        wp.data.select('core/editor').getCurrentPostId() === rootId,
      'post_date_context_unavailable',
      details(dates[0].path, 'editor_context_changed'),
    );
    const source = wp.blocks.getBlockBindingsSource?.('core/post-data');
    const supported = wp.data.select('core/block-editor').getSettings?.()
      .__experimentalBlockBindingsSupportedAttributes?.['core/post-date'];
    assert(
      source?.getValues && supported?.includes('datetime'),
      'post_date_context_unavailable',
      details(dates[0].path, 'binding_source_unavailable'),
    );
    const core = wp.data.select('core');

    for (const preview of previews.values()) {
      const records = core.getEntityRecords?.('postType', preview.type, preview.args);
      assert(
        same(records, preview.records),
        'post_date_context_unavailable',
        details(dates[0].path, 'query_preview_changed'),
      );
    }

    for (const { clientId, field, context, path } of requirements) {
      const record = core.getEditedEntityRecord?.(
        'postType',
        String(context.postType),
        Number(context.postId),
      );
      const value = record && record[field];
      assert(
        typeof value === 'string' &&
          /^\d{4}-\d\d-\d\dT/.test(value) &&
          Number.isFinite(Date.parse(value)),
        'post_date_context_unavailable',
        details(path, 'backing_date_unavailable'),
      );
      const computed: JsonObject = source.getValues({
        select: wp.data.select,
        clientId,
        context,
        bindings: { datetime: { args: { field } } },
      });
      assert(
        computed.datetime === value,
        'post_date_context_unavailable',
        details(path, 'bound_datetime_unavailable'),
      );
    }
  };

  check();

  return check;
}
