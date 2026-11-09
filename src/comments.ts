import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { JsonObject, Target } from './contracts';
import type { Block, OfferedPattern, WordPress } from './wordpress';
import { documentRoot } from './document-view';
import { blockState, readTree, requireCondition as assert } from './inspection';
import { same } from './values';
import { budgetedMs, timedRequest } from './native';
import { BlockworkError } from './errors';

export interface EmptyComments {
  pattern: OfferedPattern;
  recipe: string;
  query: JsonObject;
  discussion: JsonObject;
  hidden: Set<string>;
}

function requireComments(condition: unknown): asserts condition {
  assert(condition, 'unsupported_pattern', {
    constraint: 'root_empty_comments_recipe',
    next_step:
      'Use an offered Comments pattern at the current post or page root after its native comment query resolves empty. Read the document again before preparing another edit.',
  });
}

function offered(wp: WordPress, name: string): OfferedPattern {
  const store = wp.data.select('core/block-editor');
  requireComments(store.__experimentalGetAllowedPatterns);
  const pattern = store.__experimentalGetAllowedPatterns().find((item) => item.name === name);
  requireComments(
    pattern &&
      !pattern.syncStatus &&
      pattern.blocks.length === 1 &&
      readTree(wp, pattern.blocks).some((row) => row.name === 'core/comments'),
  );
  requireComments(
    store.canInsertBlockType?.(pattern.blocks[0].name) === true && !store.getTemplateLock?.(),
  );

  return pattern;
}

function recipe(wp: WordPress, pattern: OfferedPattern): string {
  return JSON.stringify({
    name: pattern.name,
    title: pattern.title,
    content: pattern.content,
    categories: pattern.categories,
    state: blockState(readTree(wp, pattern.blocks)),
    serialization: wp.blocks.serialize(pattern.blocks),
  });
}

function context(wp: WordPress, target: Target): JsonObject {
  const editor = wp.data.select('core/editor');
  requireComments(
    ['post', 'page'].includes(target.post_type) &&
      !documentRoot(wp) &&
      editor.getCurrentPostId() === target.post_id &&
      editor.getCurrentPostType() === target.post_type,
  );
  requireComments(wp.data.select('core/block-editor').getSettings);
  const discussion =
    wp.data.select('core/block-editor').getSettings?.().__experimentalDiscussionSettings ?? {};
  requireComments(v.is(JsonObjectSchema, discussion));

  return discussion;
}

function queryFor(target: Target, discussion: JsonObject): JsonObject {
  const { pageComments, commentsPerPage, defaultCommentsPage } = discussion;
  requireComments(
    pageComments === undefined ||
      v.is(v.boolean(), pageComments) ||
      pageComments === 0 ||
      pageComments === 1 ||
      pageComments === '' ||
      pageComments === '0' ||
      pageComments === '1',
  );
  requireComments(
    defaultCommentsPage === undefined || ['oldest', 'newest'].includes(String(defaultCommentsPage)),
  );
  requireComments(
    !pageComments ||
      ((v.is(v.number(), commentsPerPage) ||
        (v.is(v.string(), commentsPerPage) && /^\d+$/.test(commentsPerPage))) &&
        Number.isInteger(Number(commentsPerPage)) &&
        Number(commentsPerPage) > 0),
  );

  return {
    status: 'approve',
    order: 'asc',
    context: 'embed',
    parent: 0,
    _embed: 'children',
    post: target.post_id,
    per_page: pageComments ? Math.min(Number(commentsPerPage), 100) : 100,
    page: 1,
  };
}

export function checkEmptyComments(
  wp: WordPress,
  target: Target,
  proof: EmptyComments,
  admission = false,
): void {
  requireComments(same(context(wp, target), proof.discussion));
  requireComments(
    recipe(wp, admission ? offered(wp, proof.pattern.name) : proof.pattern) === proof.recipe,
  );
  const core = wp.data.select('core');
  requireComments(core.getEntityRecords && core.hasFinishedResolution);
  const records = core.getEntityRecords('root', 'comment', proof.query);
  requireComments(
    Array.isArray(records) &&
      records.length === 0 &&
      (core.getEntityRecordsTotalItems?.('root', 'comment', proof.query) === 0 ||
        core.getEntityRecordsTotalPages?.('root', 'comment', proof.query) === 0) &&
      core.hasFinishedResolution('getEntityRecords', ['root', 'comment', proof.query]),
  );
}

export async function emptyComments(
  wp: WordPress,
  target: Target,
  name: string,
): Promise<{ proof: EmptyComments; blocks: Block[] }> {
  const pattern = offered(wp, name);
  const discussion = JSON.parse(JSON.stringify(context(wp, target)));
  const query = queryFor(target, discussion);
  const rows = readTree(wp, pattern.blocks);
  requireComments(rows.some((row) => row.name === 'core/comment-template'));

  for (const row of rows) {
    const provides = wp.blocks.getBlockType(row.name)?.providesContext ?? {};
    requireComments(
      !Object.hasOwn(provides, 'postId') &&
        !Object.hasOwn(provides, 'postType') &&
        row.name !== 'core/spacer',
    );
  }

  const resolve = wp.data.resolveSelect?.('core').getEntityRecords;
  requireComments(resolve);
  await timedRequest('core/getEntityRecords', budgetedMs(12000), () =>
    resolve('root', 'comment', query),
  );
  const proof: EmptyComments = {
    pattern,
    recipe: recipe(wp, pattern),
    query,
    discussion,
    hidden: new Set(),
  };
  checkEmptyComments(wp, target, proof, true);

  return { proof, blocks: pattern.blocks };
}

export async function prepareEmptyComments(
  wp: WordPress,
  target: Target,
  name: string,
  eligible: boolean,
): Promise<{ proof: EmptyComments; blocks: Block[] } | undefined> {
  if (!eligible) {
    return undefined;
  }

  try {
    return await emptyComments(wp, target, name);
  } catch (error) {
    if (error instanceof BlockworkError && error.code === 'unsupported_pattern') {
      return undefined;
    }

    throw error;
  }
}
