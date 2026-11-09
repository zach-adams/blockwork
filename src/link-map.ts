import * as v from 'valibot';
import { LinkUrlSchema } from './contracts';
import type { EditorRequest, JsonObject, LinkMap } from './contracts';
import type { WordPress } from './wordpress';
import { markupBlocks } from './edits';
import { mapBlockAttributes } from './media-map';
import { api, readerIdentity, route } from './native';
import { BlockworkError, invalidRequest } from './errors';

// Recognize the existing media convention without contacting the source site.
export function internalLink(value: string, sourceSite: string): URL | undefined {
  if (!/^https?:\/\//i.test(value) || !URL.canParse(value)) {
    return undefined;
  }

  const url = new URL(value);
  const source = new URL(sourceSite);
  const root = source.pathname.replace(/\/$/, '');
  const inside = url.pathname === root || url.pathname.startsWith(`${root}/`);

  return url.origin === source.origin && inside && !url.pathname.includes('/uploads/')
    ? url
    : undefined;
}

// Tokenize anchor attributes so href text in a title or data-href cannot match.
// Only matched href values change; surrounding rich-text markup keeps its bytes.
export function mapAnchors(text: string, target: (url: string) => string | undefined): string {
  return text.replace(/<a(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (tag) =>
    tag.replace(
      /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
      (
        attribute,
        name: string,
        double: string | undefined,
        single: string | undefined,
        bare: string | undefined,
      ) => {
        const value = double ?? single ?? bare;

        if (name.toLowerCase() !== 'href' || value === undefined) {
          return attribute;
        }

        const mapped = target(value.replaceAll('&amp;', '&'));

        if (mapped === undefined) {
          return attribute;
        }

        const quote = single === undefined ? '"' : "'";
        const escaped = mapped
          .replaceAll('&', '&amp;')
          .replaceAll(quote, quote === '"' ? '&quot;' : '&#39;');

        return `${name}=${quote}${escaped}${quote}`;
      },
    ),
  );
}

export function remainingInternalLink(text: string, sourceSite: string): boolean {
  return [...text.matchAll(/https?:\/\/[^\s"'<>]+/gi)].some(([value]) =>
    internalLink(value.replaceAll('&amp;', '&'), sourceSite),
  );
}

const TypeSchema = v.object({
  slug: v.string(),
  viewable: v.boolean(),
  rest_base: v.string(),
  rest_namespace: v.optional(v.string(), 'wp/v2'),
});
const MatchSchema = v.object({
  id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  link: LinkUrlSchema,
});

export async function mapLinks(
  wp: WordPress,
  input: Extract<EditorRequest, { operation: 'map_links' }>,
) {
  const sources = new Set<string>();
  const collect = (value: string) => {
    if (internalLink(value, input.source_site_url)) {
      sources.add(value);
    }

    return undefined;
  };

  mapBlockAttributes(markupBlocks(wp, input.markup, 'read'), (item, key) => {
    if (v.is(v.string(), item)) {
      if (key === 'url' || key === 'href') {
        collect(item);
      }

      mapAnchors(item, collect);
    }

    return item;
  });
  // Native parsing is local. Finish content-dependent validation before REST.
  const checked = v.safeParse(
    v.object({ markup: v.pipe(v.array(LinkUrlSchema), v.maxLength(50)) }),
    { markup: [...sources] },
  );

  if (!checked.success) {
    return invalidRequest('invalid_request', checked.issues);
  }

  await readerIdentity(wp, input.target);
  const sourceRoot = new URL(input.source_site_url).pathname.replace(/\/$/, '');
  const destination = new URL(input.target.site_url);
  const destinationRoot = destination.pathname.replace(/\/$/, '');
  const overrides = new Map(input.overrides.map((item) => [item.source_url, item.target_url]));
  const linkMap: LinkMap = { source_site_url: input.source_site_url, urls: {}, ids: {} };
  const links: JsonObject[] = [];
  const unresolved: JsonObject[] = [];
  let types: Array<v.InferOutput<typeof TypeSchema>> | undefined;

  for (const sourceUrl of sources) {
    const source = new URL(sourceUrl);
    const candidate = new URL(destination);
    const suffix = source.pathname.slice(sourceRoot.length);
    candidate.pathname = `${destinationRoot}${suffix || '/'}`;
    candidate.search = source.search;
    candidate.hash = source.hash;
    const override = overrides.get(sourceUrl);

    if (override !== undefined || suffix === '' || suffix === '/') {
      const targetUrl = override ?? candidate.href;
      linkMap.urls[sourceUrl] = targetUrl;
      links.push({ source_url: sourceUrl, target_url: targetUrl, post_type: null, post_id: null });
      continue;
    }

    if (!types) {
      types = Object.values(
        v.parse(v.record(v.string(), TypeSchema), await api(wp, '/wp/v2/types?context=edit')),
      ).filter((type) => type.viewable && type.slug !== 'attachment');
    }

    const slug = source.pathname.split('/').filter(Boolean).at(-1) ?? '';
    const expected = new URL(candidate);
    expected.search = '';
    expected.hash = '';
    const matches = [];
    let limited = false;

    for (const type of types) {
      const collection = route(type);

      // Refuse a full result window rather than infer uniqueness beyond it.
      const query = new URLSearchParams({
        slug: decodeURIComponent(slug),
        status: 'publish',
        per_page: '100',
        _fields: 'id,link',
      });
      const posts = v.parse(v.array(MatchSchema), await api(wp, `${collection}?${query}`));

      for (const post of posts) {
        if (post.link === expected.href) {
          matches.push({ post_type: type.slug, post_id: post.id });
        }
      }

      limited ||= posts.length === 100;
    }

    if (limited || matches.length !== 1) {
      let reason = matches.length ? 'ambiguous' : 'missing';

      if (limited) {
        reason = 'candidate_limit';
      }

      unresolved.push({ source_url: sourceUrl, reason });
      continue;
    }

    linkMap.urls[sourceUrl] = candidate.href;
    linkMap.ids[sourceUrl] = matches[0].post_id;
    links.push({ source_url: sourceUrl, target_url: candidate.href, ...matches[0] });
  }

  if (unresolved.length) {
    throw new BlockworkError('link_resolution_incomplete', {
      links: unresolved.slice(0, 10),
      truncated: unresolved.length > 10,
    });
  }

  return {
    ok: true,
    operation: 'map_links',
    persistence: 'not_attempted',
    link_map: linkMap,
    links,
  };
}
