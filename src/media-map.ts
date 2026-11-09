import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { BlockInput, JsonObject, JsonValue, LinkMap, MediaMap } from './contracts';
import { BlockworkError, diagnosticKey } from './errors';
import { mapAnchors, remainingInternalLink } from './link-map';

const attachmentId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
// Finds URLs only to refuse a leftover. A URL never changes inside text.
const urlTokens = /(?:https?:)?\/\/[^\s"'<>]+/gi;

function parsed(token: string, scheme = 'https:'): URL | undefined {
  const absolute = token.startsWith('//') ? `${scheme}${token}` : token;

  return URL.canParse(absolute) ? new URL(absolute) : undefined;
}

// Rewrites parsed attributes, and Gutenberg's own serializer then writes the
// markup, including an Image's src and wp-image class. Block attributes hold
// file URLs as whole values, so only a whole value that is a map key changes,
// and only a wp-image token in a className follows the ids. An `id` or
// `<prefix>Id` changes only beside a URL the map moves, so a link's post ID
// stays. A source-host upload URL anywhere else, including inside text such as
// an inline image, refuses the whole edit rather than being rewritten.
export function retargetBlocks(
  blocks: BlockInput[],
  map?: MediaMap,
  links?: LinkMap,
): BlockInput[] {
  const urls = new Map(
    Object.entries(map?.urls ?? {}).map(([source, target]) => [
      parsed(source)?.href ?? source,
      target,
    ]),
  );
  const targetHosts = new Set(Object.values(map?.urls ?? {}).map((url) => parsed(url)?.host));
  const sourceHosts = new Set(
    Object.keys(map?.urls ?? {})
      .map((url) => parsed(url)?.host)
      .filter((host) => !targetHosts.has(host)),
  );
  const unmapped: JsonObject[] = [];
  const unmappedLinks: JsonObject[] = [];
  const linkTarget = (url: string) =>
    links && Object.hasOwn(links.urls, url) ? links.urls[url] : undefined;

  const targetOf = (value: string): string | undefined => {
    const secure = parsed(value)?.href;
    const plain = parsed(value, 'http:')?.href;

    return (secure && urls.get(secure)) ?? (plain && urls.get(plain)) ?? undefined;
  };

  const leftover = (text: string) =>
    [...text.matchAll(urlTokens)].some(([token]) => {
      const url = parsed(token);

      return url !== undefined && sourceHosts.has(url.host) && url.pathname.includes('/uploads/');
    });

  const move = (text: string, where: JsonObject, at: string[]): string => {
    const classes =
      at.at(-1) === 'className'
        ? text
            .split(/(\s+)/)
            .map((token) => {
              const id = /^wp-image-(\d+)$/.exec(token)?.[1];

              return id && map && Object.hasOwn(map.ids, id) ? `wp-image-${map.ids[id]}` : token;
            })
            .join('')
        : text;
    const target = targetOf(classes.trim());

    if (target === undefined && leftover(classes) && unmapped.length <= 10) {
      unmapped.push({ ...where, attribute: at.map(diagnosticKey).join('.').slice(0, 200) });
    }

    const linked = linkTarget(text);
    const moved = target ?? linked ?? mapAnchors(classes, linkTarget);

    if (links && target === undefined && linked === undefined) {
      // Check original unmatched references. A destination subdirectory can
      // still be under the source installation's URL.
      const unmatched = mapAnchors(classes, (url) =>
        linkTarget(url) === undefined ? undefined : '',
      );

      if (remainingInternalLink(unmatched, links.source_site_url) && unmappedLinks.length <= 10) {
        unmappedLinks.push({ ...where, attribute: at.map(diagnosticKey).join('.').slice(0, 200) });
      }
    }

    return moved;
  };

  const moved = mapBlockAttributes(blocks, (item, key, value, where, at) => {
    if (
      links &&
      at.length === 0 &&
      v.is(JsonObjectSchema, item) &&
      ['core/navigation-link', 'core/navigation-submenu'].includes(String(where.block_name)) &&
      v.is(v.string(), item.url) &&
      Object.hasOwn(links.urls, item.url)
    ) {
      const { id: _sourceId, ...attributes } = item;
      const id = links.ids[item.url];

      return id === undefined ? attributes : { ...attributes, id };
    }

    if (v.is(v.string(), item)) {
      return move(item, where, at);
    }

    const prefix = key.length > 2 && key.endsWith('Id') ? key.slice(0, -2) : undefined;
    const siblings = key === 'id' ? ['url', 'src', 'href'] : [`${prefix}Url`, `${prefix}Src`];
    const attachment =
      (key === 'id' || prefix) &&
      map &&
      v.is(attachmentId, item) &&
      Object.hasOwn(map.ids, String(item)) &&
      siblings.some((name) => {
        const sibling = value[name];

        return v.is(v.string(), sibling) && targetOf(sibling.trim()) !== undefined;
      });

    if (attachment) {
      return map.ids[String(item)];
    }

    return item;
  });

  if (unmapped.length) {
    throw new BlockworkError('unmapped_media_url', {
      references: unmapped.slice(0, 10),
      truncated: unmapped.length > 10,
    });
  }

  if (unmappedLinks.length) {
    throw new BlockworkError('unmapped_internal_link', {
      references: unmappedLinks.slice(0, 10),
      truncated: unmappedLinks.length > 10,
    });
  }

  return moved;
}

// Both mapping and inspection traverse the same detached attributes, including
// nested query attributes. The callback sees original siblings, never moved ones.
export function mapBlockAttributes(
  blocks: BlockInput[],
  transform: (
    item: JsonValue | undefined,
    key: string,
    siblings: JsonObject,
    where: JsonObject,
    at: string[],
  ) => JsonValue | undefined,
): BlockInput[] {
  const visit = (value: JsonValue, where: JsonObject, at: string[]): JsonValue => {
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        const path = [...at, String(index)];
        const moved = transform(item, String(index), {}, where, path);

        return moved === undefined ? null : visit(moved, where, path);
      });
    }

    if (!v.is(JsonObjectSchema, value)) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const path = [...at, key];
        const moved = transform(item, key, value, where, path);

        return [key, moved === undefined ? moved : visit(moved, where, path)];
      }),
    );
  };

  const retarget = (block: BlockInput, path: number[]): BlockInput => {
    const where = { block_name: block.name, path };
    const original = transform(block.attributes ?? {}, '', {}, where, []);
    const attributes = original === undefined ? undefined : visit(original, where, []);

    return {
      ...block,
      attributes: v.is(JsonObjectSchema, attributes) ? attributes : block.attributes,
      inner_blocks: block.inner_blocks?.map((child, index) => retarget(child, [...path, index])),
    };
  };

  return blocks.map((block, index) => retarget(block, [index]));
}
