import { documentBlocks } from './document-view';
import * as v from 'valibot';
import { ApiErrorSchema } from './contracts';
import type { BlockInput, JsonObject } from './contracts';
import type { Block, WordPress } from './wordpress';
import { blockState, readTree, requireCondition, sharedReference, validity } from './inspection';
import { same } from './values';
import { api, budgetedMs, timedRequest } from './native';
import { provePreservation } from './preservation';

const PatternSchema = v.object({
  name: v.string(),
  title: v.string(),
  content: v.string(),
  syncStatus: v.optional(v.string()),
});

export async function patterns(wp: WordPress) {
  const core = wp.data.resolveSelect?.('core');
  const getPatterns = core?.getBlockPatterns?.bind(core);
  requireCondition(getPatterns, 'native_patterns_unavailable');
  const raw = await timedRequest('core/getBlockPatterns', budgetedMs(12000), () => getPatterns());

  requireCondition(Array.isArray(raw) && raw.length <= 200, 'native_patterns_unavailable');
  const items = [];

  for (const value of raw) {
    if (!v.is(PatternSchema, value) || value.syncStatus) {
      continue;
    }

    requireCondition(value.content.length <= 256 * 1024, 'pattern_too_large');
    items.push({ name: value.name, title: value.title, content: value.content });
  }

  return items;
}

const GuidelineScopesSchema = v.array(
  v.object({ slug: v.string(), title: v.string(), order: v.number() }),
);

const GuidelineRowsSchema = v.array(
  v.object({ slug: v.string(), content: v.object({ rendered: v.string() }) }),
);

// Gutenberg's default guideline length. A site filter can raise it, so longer
// text is cut to keep one row from crowding the rest out of the response.
const guidelineLength = 5000;

// Gutenberg's Guidelines experiment registers these routes. Each guideline is
// a published wp_knowledge row named guideline-{scope}, or
// guideline-block-{namespace}_{name} for one block type.
export async function guidelines(wp: WordPress): Promise<JsonObject> {
  // The scope list goes first because it reports a missing route as
  // rest_no_route. apiFetch reads a per_page=-1 list unparsed, so its 404 is a
  // bare Response.
  const listed = await api(wp, '/wp/v2/knowledge/guideline-scopes?_fields=slug,title,order').catch(
    (error: unknown) => {
      const answer = v.safeParse(ApiErrorSchema, error);

      if (answer.success && answer.output.code === 'rest_no_route') {
        return undefined;
      }

      throw error;
    },
  );

  if (listed === undefined) {
    return { available: false, reason: 'guidelines_not_enabled' };
  }

  // Edit context would drop every row the user can't edit, and Gutenberg lets
  // only administrators edit published guidelines, so this reads rendered text.
  const published = await api(
    wp,
    '/wp/v2/knowledge?status=publish&per_page=-1&orderby=slug&order=asc&_fields=slug,content',
  );
  const scopes = v.parse(GuidelineScopesSchema, listed).sort((a, b) => a.order - b.order);
  const rows = v
    .parse(GuidelineRowsSchema, published)
    .map(({ slug, content }) => ({
      slug,
      content: wp.htmlEntities.decodeEntities(content.rendered.replace(/<[^>]*>/g, '')).trim(),
    }))
    .filter(({ content }) => content);
  const text = (content: string) =>
    content.length > guidelineLength
      ? { content: content.slice(0, guidelineLength), truncated: true }
      : { content };

  // Like the Settings page, read only registered scopes and block types, and
  // block rows only while the registry lists the blocks scope.
  return {
    available: true,
    scopes: scopes.flatMap(({ slug, title }) => {
      const row = rows.find((candidate) => candidate.slug === `guideline-${slug}`);

      return slug !== 'blocks' && row ? [{ scope: slug, title, ...text(row.content) }] : [];
    }),
    blocks: scopes.some(({ slug }) => slug === 'blocks')
      ? rows.flatMap(({ slug, content }) => {
          const name = slug.startsWith('guideline-block-')
            ? slug.slice('guideline-block-'.length).replace('_', '/')
            : '';

          return name && wp.blocks.getBlockType(name) ? [{ name, ...text(content) }] : [];
        })
      : [],
  };
}

export function blockInput(wp: WordPress, block: Block): BlockInput {
  const row = readTree(wp, [block])[0];
  const entries = Object.entries(row.attributes);
  const attributes = Object.fromEntries(entries.filter(([_key, value]) => value !== undefined));

  return {
    name: block.name,
    attributes,
    inner_blocks: (block.innerBlocks ?? []).map((child) => blockInput(wp, child)),
  };
}

export async function styles(wp: WordPress, name: string) {
  const registry = wp.data.select('core/blocks');
  requireCondition(registry?.getBlockStyles, 'native_styles_unavailable');
  const items = registry.getBlockStyles(name);
  requireCondition(items.length <= 64, 'styles_too_large');

  return { items };
}

export async function variations(wp: WordPress, name: string) {
  requireCondition(wp.blocks.getBlockVariations, 'native_variations_unavailable');
  const items = wp.blocks.getBlockVariations(name, 'inserter');
  requireCondition(items.length <= 64, 'variations_too_large');

  return items;
}

// Disable deprecations only during this synchronous parse to identify the saved
// representation. Always restore registrations before calling other native APIs.
export function unmigrated(wp: WordPress, content: string): Block[] {
  const types = wp.blocks.getBlockTypes();
  const originals = [];

  for (const type of types) {
    if (type.deprecated?.length) {
      originals.push({ type, deprecated: type.deprecated });
    }
  }

  try {
    for (const { type } of originals) {
      type.deprecated = [];
    }

    return wp.blocks.parse(content);
  } finally {
    for (const { type, deprecated } of originals) {
      type.deprecated = deprecated;
    }
  }
}

export function contentOnlyEdits(wp: WordPress): boolean {
  const editor = wp.data.select('core/editor');

  // Gutenberg records block arrays and selection as transient entity edits.
  const edits = wp.data
    .select('core')
    .getEntityRecordNonTransientEdits(
      'postType',
      editor.getCurrentPostType(),
      editor.getCurrentPostId(),
    );

  return Object.keys(edits).every((key) => key === 'content');
}

// Only valid blocks and preserved raw content may differ in markup formatting.
function equivalentContent(
  wp: WordPress,
  parsed: Block[],
  content: string,
  live: Block[] = documentBlocks(wp),
): boolean {
  const parsedRows = readTree(wp, parsed);
  const liveRows = readTree(wp, live);

  if (
    parsedRows.some((row) => row.support !== 'supported' && row.reason !== 'raw_content') ||
    !same(blockState(liveRows), blockState(parsedRows))
  ) {
    return false;
  }

  if (validity(parsedRows).unsupported.length) {
    try {
      // The no-edit proof requires unique, exact native raw regions in stored
      // content. The second proof compares the complete native save output,
      // including raw content that blockState alone cannot protect.
      provePreservation(wp, parsedRows, parsedRows, content, content, new Map());
      provePreservation(
        wp,
        parsedRows,
        liveRows,
        wp.blocks.serialize(parsed),
        wp.blocks.serialize(live),
        new Map(),
      );
    } catch {
      return false;
    }
  }

  return true;
}

export function nativeNormalization(wp: WordPress, content: string): boolean {
  const parsed = wp.blocks.parse(content);

  return (
    wp.blocks.serialize(parsed) !== content &&
    equivalentContent(wp, parsed, content) &&
    contentOnlyEdits(wp)
  );
}

// Mounting can fill a block saved empty, such as Buttons or List, with template
// children without marking the editor dirty. This returns those blocks when they
// are the only difference from canonical saved content. Nothing shows who added
// the children, so a caller must keep them unread rather than treat them as saved.
export function templateFills(wp: WordPress, content: string): Block[] {
  try {
    const parsed = unmigrated(wp, content);
    const filled: Block[] = [];
    const prune = (saved: Block[], live: Block[]): Block[] =>
      live.map((block, index) => {
        const children = saved[index]?.innerBlocks ?? [];

        if (sharedReference(block)) {
          return block;
        }

        if (block.innerBlocks?.length && !children.length) {
          filled.push(block);

          return { ...block, innerBlocks: [] };
        }

        return { ...block, innerBlocks: prune(children, block.innerBlocks ?? []) };
      });
    const pruned = prune(parsed, documentBlocks(wp));

    return wp.blocks.serialize(parsed) === content &&
      contentOnlyEdits(wp) &&
      equivalentContent(wp, parsed, content, pruned)
      ? filled
      : [];
  } catch {
    // Content Gutenberg cannot inspect stays a refusal.
    return [];
  }
}

// Block delimiters hold attributes. What remains is the HTML stored for visitors.
function storedHtml(content: string): string {
  return content.replace(/<!--\s*\/?wp:[\s\S]*?-->/g, '');
}

// WordPress can store markup that Gutenberg formats differently, such as a
// theme template it serialized in PHP. When that markup holds exactly the live
// blocks, edits plan from Gutenberg's serialization, and a save writes it as a
// native save would. A deprecation that moves attributes but keeps the HTML
// qualifies too, since the user couldn't review that in the editor. One that
// changes the HTML stays refused until the user re-saves it, even when the
// markup validates. Other differences still refuse in planning.
export function plannedContent(wp: WordPress, content: string): string {
  const live = wp.blocks.serialize(documentBlocks(wp));

  if (live === content) {
    return content;
  }

  try {
    const parsed =
      storedHtml(live) === storedHtml(content) ? wp.blocks.parse(content) : unmigrated(wp, content);

    return equivalentContent(wp, parsed, content) ? live : content;
  } catch {
    // Content Gutenberg cannot inspect keeps the planner's refusal.
    return content;
  }
}
