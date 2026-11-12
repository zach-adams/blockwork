import * as v from 'valibot';
import {
  ApiErrorSchema,
  JsonObjectSchema,
  PostSchema,
  ReceiptSchema,
  ReferenceSchema,
  SharedTypeSchema,
  SiteTargetSchema,
} from './contracts';
import type { JsonObject, Post, Target } from './contracts';
import type { WordPress } from './wordpress';
import {
  api,
  authenticate,
  bounded,
  budgetedMs,
  readerIdentity,
  requireSignIn,
  timedRequest,
} from './native';
import { requireCondition as assert } from './inspection';
import { hash, same } from './values';
import { documentContract, documentFields, documentReadFields } from './documents';
import { receiptMatch } from './persistence';
import {
  BlockworkError,
  accessFailure,
  failureCode,
  invalidRequest,
  validationIssues,
} from './errors';
import { debugDetails } from './debug';

export const sharedTypes = {
  wp_block: { collection: '/wp/v2/blocks', block: 'core/block', scope: 'all_references' },
  wp_navigation: { collection: '/wp/v2/navigation', block: 'core/navigation', scope: 'site_wide' },
  wp_template: { collection: '/wp/v2/templates', block: '', scope: 'site_wide' },
  wp_template_part: {
    collection: '/wp/v2/template-parts',
    block: 'core/template-part',
    scope: 'site_wide',
  },
} as const;

export function sharedType(post_type: string) {
  return v.is(SharedTypeSchema, post_type) ? sharedTypes[post_type] : undefined;
}

export function recordPath(collection: string, id: number | string): string {
  return `${collection}/${String(id).split('//').map(encodeURIComponent).join('//')}`;
}

const maximumContentBytes = 256 * 1024;

// The document limit applies to stored block markup Blockwork admits for
// editing: the connected document, a source read, and a draft before saving.
// Reads that verify or recover a save skip it, so content WordPress grew while
// saving can still settle the save.
export function checkContentSize(raw: string): void {
  const bytes = new TextEncoder().encode(raw).length;
  assert(bytes <= maximumContentBytes, 'content_too_large', {
    content_bytes: bytes,
    limit_bytes: maximumContentBytes,
  });
}

// Keep room for metadata, rendered title/excerpt, and server-grown content.
// Unfiltered shared-entity and source reads also carry rendered content.
export function postRecord(
  wp: WordPress,
  collection: string,
  id: number | string,
  fields?: string[],
  context: 'edit' | 'view' = 'edit',
) {
  const selection = fields ? `&_fields=${encodeURIComponent(fields.join(','))}` : '';

  return api(
    wp,
    `${recordPath(collection, id)}?context=${context}${selection}`,
    'GET',
    undefined,
    4 * maximumContentBytes,
  );
}

export function checkSharedRecord(post: Post, target: Target): void {
  assert(post.id === target.post_id && post.type === target.post_type, 'post_mismatch');

  if (target.post_type === 'wp_block') {
    assert(
      post.wp_pattern_sync_status !== 'unsynced' &&
        (!v.is(JsonObjectSchema, post.meta) || post.meta.wp_pattern_sync_status !== 'unsynced'),
      'pattern_not_synced',
    );
  }

  if (['wp_template', 'wp_template_part'].includes(target.post_type)) {
    assert(
      post.id === `${post.theme}//${post.slug}` &&
        ['theme', 'plugin', 'custom'].includes(String(post.source)) &&
        Number.isSafeInteger(post.wp_id) &&
        Number(post.wp_id) >= 0,
      'entity_identity_unavailable',
    );
    assert(post.source !== 'custom' || Number(post.wp_id) > 0, 'entity_identity_unavailable');
  }
}

export function reference_token(post: Post, target: Target): Promise<string> {
  return hash([
    target,
    Object.fromEntries(
      Object.entries(post).filter(([key]) => !['_links', '_embedded'].includes(key)),
    ),
  ]);
}

// Site-wide entities open in the site editor; every other document opens in
// the post editor.
export function editorUrl(target: Target): string {
  const site = target.site_url.replace(/\/$/, '');

  return sharedType(target.post_type)?.scope === 'site_wide'
    ? `${site}/wp-admin/site-editor.php?postType=${target.post_type}&postId=${encodeURIComponent(String(target.post_id))}&canvas=edit`
    : `${site}/wp-admin/post.php?post=${target.post_id}&action=edit`;
}

export function entitySummary(post: Post, target: Target) {
  return {
    target,
    title: post.title?.raw ?? '',
    status: post.status,
    source: post.source ?? 'custom',
    origin: post.origin ?? null,
    has_theme_file: post.has_theme_file ?? false,
    wp_id: post.wp_id ?? post.id,
    theme: post.theme,
    area: post.area,
    editor_url: editorUrl(target),
    scope: sharedType(target.post_type)?.scope,
  };
}

const query = {
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)), 20),
  page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1),
};

export const SharedRequestSchema = v.variant('operation', [
  v.strictObject({
    operation: v.literal('list_entities'),
    target: SiteTargetSchema,
    entity_type: SharedTypeSchema,
    ...query,
  }),
  v.strictObject({ operation: v.literal('inspect_entity'), target: ReceiptSchema.entries.target }),
  v.strictObject({
    operation: v.literal('recover'),
    target: SiteTargetSchema,
    receipt: ReceiptSchema,
  }),
]);

export type SharedRequest = v.InferInput<typeof SharedRequestSchema>;

export async function readReference(
  wp: WordPress,
  target: Pick<Target, 'site_url' | 'user_id'>,
  reference: v.InferOutput<typeof ReferenceSchema>,
) {
  const entity = v.parse(ReceiptSchema.entries.target, {
    ...target,
    post_type: reference.entity_type,
    post_id: reference.entity_id,
  });

  const post = v.parse(
    PostSchema,
    await postRecord(wp, sharedTypes[reference.entity_type].collection, reference.entity_id),
  );
  checkSharedRecord(post, entity);
  assert(
    post.status === 'publish' &&
      (await reference_token(post, entity)) === reference.reference_token,
    'stale_entity_reference',
  );

  const attributes: JsonObject =
    reference.entity_type === 'wp_template_part'
      ? { slug: post.slug, theme: post.theme }
      : { ref: reference.entity_id };

  // Area is part of a template part's identity, not a caller-selected override.
  if (reference.entity_type === 'wp_template_part' && typeof post.area === 'string') {
    attributes.area = post.area;
  }

  return { name: sharedTypes[reference.entity_type].block, attributes, target: entity, post };
}

// Refuses recursive, unpublished, or oversized reference graphs before insertion.
export async function checkReferenceGraph(
  wp: WordPress,
  owner: Target,
  reference: v.InferOutput<typeof ReferenceSchema>,
) {
  const visited = new Set<string>();

  const walk = async (
    item: v.InferOutput<typeof ReferenceSchema>,
    ancestors: string[],
  ): Promise<void> => {
    const key = `${item.entity_type}:${item.entity_id}`;
    assert(
      key !== `${owner.post_type}:${owner.post_id}` && !ancestors.includes(key),
      'recursive_entity_reference',
    );

    if (visited.has(key)) {
      return;
    }

    assert(visited.size < 32 && ancestors.length < 15, 'reference_graph_too_large');
    visited.add(key);
    const resolved = await readReference(wp, owner, item);
    const blocks = wp.blocks.parse(resolved.post.content.raw);
    const pending = [...blocks];
    let count = 0;

    while (pending.length) {
      assert(++count <= 200, 'reference_graph_too_large');
      const block = pending.pop()!;
      let type: v.InferOutput<typeof SharedTypeSchema> | undefined;

      if (block.name === 'core/block') {
        type = 'wp_block';
      } else if (block.name === 'core/template-part') {
        type = 'wp_template_part';
      } else if (block.name === 'core/navigation' && block.attributes.ref) {
        type = 'wp_navigation';
      }

      if (!type) {
        pending.push(...(block.innerBlocks ?? []));
        continue;
      }

      let theme = block.attributes.theme;

      if (type === 'wp_template_part' && !theme) {
        const current = await timedRequest('core/getCurrentTheme', budgetedMs(12000), async () =>
          wp.data.resolveSelect?.('core').getCurrentTheme?.(),
        );
        assert(
          v.is(JsonObjectSchema, current) && typeof current.stylesheet === 'string',
          'current_theme_unavailable',
        );
        theme = current.stylesheet;
      }

      const id =
        type === 'wp_template_part' ? `${theme}//${block.attributes.slug}` : block.attributes.ref;

      const target = v.parse(ReceiptSchema.entries.target, {
        site_url: owner.site_url,
        user_id: owner.user_id,
        post_type: type,
        post_id: id,
      });

      const related = v.parse(
        PostSchema,
        await postRecord(wp, sharedTypes[type].collection, target.post_id),
      );

      const next = v.parse(ReferenceSchema, {
        entity_type: type,
        entity_id: target.post_id,
        reference_token: await reference_token(related, target),
      });

      await walk(next, [...ancestors, key]);
    }
  };

  await walk(reference, []);
}

export async function sharedOperation(request: SharedRequest) {
  const validated = v.safeParse(SharedRequestSchema, request);

  if (!validated.success) {
    return invalidRequest('invalid_shared_request', validated.issues);
  }

  try {
    const input = validated.output;
    requireSignIn();
    const wp = window.wp;
    assert(wp?.apiFetch, 'native_api_unavailable');
    await (input.operation === 'recover'
      ? authenticate(wp, input.target)
      : readerIdentity(wp, input.target));

    if (input.operation === 'recover') {
      const receipt = input.receipt;
      assert(
        same(input.target, { site_url: receipt.target.site_url, user_id: receipt.target.user_id }),
        'target_mismatch',
      );
      assert(
        !window.__blockwork_editor?.busy && !wp.data?.select('core/editor')?.isSavingPost?.(),
        'save_in_progress',
      );
      const schema = await documentContract(wp, receipt.target);

      const post = v.parse(
        PostSchema,
        await postRecord(wp, schema.collection, receipt.target.post_id, documentReadFields(schema)),
      );

      checkSharedRecord(post, receipt.target);
      const current = documentFields(post, schema, receipt.date_fields);
      let outcome = 'different';
      const match = await receiptMatch(wp, current, receipt);

      if (match === 'matched') {
        outcome = 'matched_desired';
      } else if ((await hash(current)) === receipt.original_hash) {
        outcome = 'unchanged_original';
      } else if (match === 'unavailable') {
        outcome = 'verification_unavailable';
      }

      const errors = new Map([
        ['unchanged_original', 'save_not_applied'],
        ['different', 'saved_record_different'],
        ['verification_unavailable', 'recover_requires_editor'],
      ]);

      return {
        ok: outcome === 'matched_desired',
        error: errors.get(outcome),
        persistence: outcome === 'matched_desired' ? 'verified' : 'different',
        outcome,
        validity: 'unavailable',
        receipt,
        next: 'fresh_inspection_before_new_plan',
      };
    }

    if (input.operation === 'inspect_entity') {
      const config = sharedType(input.target.post_type);
      assert(config, 'shared_entity_required');

      const post = v.parse(
        PostSchema,
        await postRecord(wp, config.collection, input.target.post_id),
      );

      checkSharedRecord(post, input.target);

      return bounded({
        ok: true,
        ...entitySummary(post, input.target),
        reference_token: await reference_token(post, input.target),
      });
    }

    const config = sharedTypes[input.entity_type];
    const templates = ['wp_template', 'wp_template_part'].includes(input.entity_type);

    // The native template controller has no pagination. Bound its identity
    // list, page it locally, and retrieve content only for that requested page.
    const result = await api(
      wp,
      templates
        ? `${config.collection}?context=edit&_fields=id`
        : `${config.collection}?context=edit&per_page=${input.limit}&page=${input.page}`,
    );

    assert(Array.isArray(result) && result.length <= 200, 'invalid_entity_list');
    const start = (input.page - 1) * input.limit;
    let selected = result;

    if (templates) {
      const sorted = [...result].sort((a, b) => {
        const firstId = String(v.parse(JsonObjectSchema, a).id);
        const secondId = String(v.parse(JsonObjectSchema, b).id);

        return firstId.localeCompare(secondId);
      });
      selected = sorted.slice(start, start + input.limit);
    }

    const items = [];

    for (const item of selected) {
      const identity = v.parse(JsonObjectSchema, item).id;

      const selectedTarget = v.parse(ReceiptSchema.entries.target, {
        ...input.target,
        post_type: input.entity_type,
        post_id: identity,
      });

      const post = v.parse(
        PostSchema,
        templates ? await postRecord(wp, config.collection, selectedTarget.post_id) : item,
      );

      const target = v.parse(ReceiptSchema.entries.target, {
        ...input.target,
        post_type: input.entity_type,
        post_id: post.id,
      });

      if (
        input.entity_type === 'wp_block' &&
        (post.wp_pattern_sync_status === 'unsynced' ||
          (v.is(JsonObjectSchema, post.meta) && post.meta.wp_pattern_sync_status === 'unsynced'))
      ) {
        continue;
      }

      checkSharedRecord(post, target);
      items.push({
        ...entitySummary(post, target),
        reference_token: await reference_token(post, target),
      });
    }

    return bounded({
      ok: true,
      items,
      page: input.page,
      may_have_more: templates ? start + input.limit < result.length : result.length >= input.limit,
    });
  } catch (error) {
    const parsed = v.safeParse(ApiErrorSchema, error);
    const failure = parsed.success ? parsed.output : undefined;
    const access = accessFailure(error);

    return {
      ok: false,
      error: failureCode(failure?.code, access, v.isValiError(error)),
      diagnostics: error instanceof BlockworkError ? error.diagnostics : access?.diagnostics,
      issues: v.isValiError(error) ? validationIssues(error.issues, 'native_response') : undefined,
      validation_source: v.isValiError(error) ? 'native_response' : undefined,
      persistence: request?.operation === 'recover' ? 'uncertain' : 'not_attempted',
      outcome: 'unavailable',
      next: 'inspect_do_not_replay',
      debug: debugDetails(error),
    };
  }
}
