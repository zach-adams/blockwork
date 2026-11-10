import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { BlockSummary, JsonObject, JsonValue } from './contracts';
import { contentEdit } from './edits';
import { editRestriction } from './inspection';
import { same } from './values';
import type { WordPress } from './wordpress';

// `update` writes only what it is sent, while one of core's controls can write
// several attributes or blocks at once. Each row below is one core control, read
// from the block's edit component. When an edit changes that control's value and
// leaves out what the control also writes, the edit's result carries a note with
// the missing writes. Notes never change the document, so an agent can decline one.

type Path = string | string[];

interface Write {
  row?: BlockSummary;
  set?: JsonObject;
  unset?: Path[];
}

interface NoteEdit extends JsonObject {
  op: 'update';
  client_id: string;
  attributes: JsonObject;
  unset: string[][];
}

interface View {
  row: BlockSummary;
  attrs: JsonObject;
  before: JsonObject;
  isNew: boolean;
  parent?: BlockSummary;
  children: BlockSummary[];
  site: Site;
  changed(...keys: string[]): boolean;
  changedOn(row: BlockSummary, key: string): boolean;
  childrenOf(row: BlockSummary): BlockSummary[];
  parentOf(row: BlockSummary): BlockSummary | undefined;
  isNewRow(row: BlockSummary): boolean;
  previousColumns(): JsonObject[] | undefined;
}

interface Site {
  imageSize?: JsonValue;
  colors: Map<string, string>;
}

interface Control {
  block: string | string[];
  id: string;
  message: string;
  when(view: View): boolean;
  writes(view: View): Write[];
  // A new block's attributes can be a copy or pattern a person already chose, so only
  // rows marked here look at one.
  onInsert?: boolean;
  // True when part of what core writes can't be worked out here.
  unresolved?(view: View): boolean;
}

function object(value: JsonValue | undefined): JsonObject {
  return v.is(JsonObjectSchema, value) ? value : {};
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// The same word removal as core's removeNewTabRel, double space included.
function withoutNoopener(rel: JsonValue | undefined): JsonValue | undefined {
  if (typeof rel !== 'string' || !rel) {
    return undefined;
  }

  const stripped = rel.replace(/\bnoopener\b/gi, '');

  return (stripped === rel ? rel : stripped.trim()) || undefined;
}

function setOrUnset(key: string, value: JsonValue | undefined): Write {
  return value === undefined ? { unset: [key] } : { set: { [key]: value } };
}

// core/image's onSetNewTab and core/button's getUpdatedLinkAttributes share this result.
function newTabRel(view: View): Write[] {
  const words = String(view.attrs.rel ?? '')
    .split(' ')
    .filter(Boolean);

  if (view.attrs.linkTarget === '_blank') {
    return words.includes('noopener') ? [] : [{ set: { rel: [...words, 'noopener'].join(' ') } }];
  }

  return [setOrUnset('rel', words.filter((word) => word !== 'noopener').join(' ') || undefined)];
}

function rgb(color: JsonValue | undefined): number[] | undefined {
  const hex = text(color)?.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];

  if (!hex) {
    return undefined;
  }

  const digits = hex.length === 3 ? [...hex].map((digit) => digit + digit) : hex.match(/../g);

  return digits?.map((pair) => parseInt(pair, 16));
}

function isDark([r, g, b]: number[]): boolean {
  return (r * 299 + g * 587 + b * 114) / 1000 / 255 < 0.5;
}

// core/cover's compositeIsDark. A cover with media needs the image's average color,
// which core samples in the browser, unless the overlay is fully opaque.
function coverIsDark({ attrs, site }: View): boolean | undefined {
  const named = text(attrs.overlayColor);
  const chosen = attrs.customOverlayColor ?? (named && site.colors.get(named));
  const hasMedia = Boolean(attrs.url || attrs.useFeaturedImage);

  // With no color chosen, core treats the overlay as black until media gives it one.
  if (!chosen && !named && hasMedia) {
    return undefined;
  }

  const overlay = rgb(chosen ?? (named ? undefined : '#000000'));
  const ratio = v.is(v.number(), attrs.dimRatio) ? attrs.dimRatio : 100;

  if (!overlay) {
    return undefined;
  }

  if (ratio === 100) {
    return isDark(overlay);
  }

  if (hasMedia) {
    return undefined;
  }

  return isDark(overlay.map((part) => (part * ratio + 255 * (100 - ratio)) / 100));
}

// One attachment's sizes differ only by a suffix such as -150x150. Sending one is a
// resolution change, which keeps the attachment, rather than a new file.
function replacedFile(before: JsonValue | undefined, after: JsonValue | undefined): boolean {
  const file = (url: JsonValue | undefined) => text(url)?.replace(/-\d+x\d+(\.\w+)$/, '$1');

  return Boolean(before) && Boolean(after) && file(before) !== file(after);
}

// core's image link control picks the destination by comparing href with the image's
// file and attachment page. Without the attachment record, only a file name can compare.
function linkDestination({ attrs, changed }: View): string | undefined {
  if (changed('linkDestination')) {
    return undefined;
  }

  if (!replacedFile(attrs.url, attrs.href)) {
    return 'media';
  }

  return attrs.linkDestination === 'attachment' ? undefined : 'custom';
}

function hasBothDimensions({ width, height }: JsonObject): boolean {
  return Boolean(width) && Boolean(height) && width !== 'auto' && height !== 'auto';
}

function imageChildren({ children }: View): BlockSummary[] {
  return children.filter((row) => row.name === 'core/image');
}

// core/gallery's getHrefAndDestination, without the attachment data it fetches.
function galleryLink(row: BlockSummary, linkTo: JsonValue | undefined): Write {
  switch (linkTo) {
    case 'media':
    case 'attachment':
      return {
        row,
        set: {
          linkDestination: linkTo,
          lightbox:
            object(row.attributes.lightbox).enabled === true
              ? { ...object(row.attributes.lightbox), enabled: false }
              : undefined,
        },
      };
    case 'lightbox':
      return {
        row,
        set: {
          linkDestination: 'none',
          lightbox: { ...object(row.attributes.lightbox), enabled: true },
        },
        unset: ['href'],
      };
    default:
      return { row, set: { linkDestination: 'none' }, unset: ['href', 'lightbox'] };
  }
}

function tableRows(attributes: JsonObject): JsonObject[][] {
  return ['head', 'body', 'foot'].flatMap((section) => {
    const rows = v.is(v.array(JsonObjectSchema), attributes[section]) ? attributes[section] : [];

    return rows.map((row) => (v.is(v.array(JsonObjectSchema), row.cells) ? row.cells : []));
  });
}

function columnAligns(rows: JsonObject[][]): string[][] {
  const columns = Math.max(0, ...rows.map((row) => row.length));

  return Array.from({ length: columns }, (_, index) =>
    rows.map((row) => text(row[index]?.align) ?? ''),
  );
}

function explicitWidth(width: JsonValue | undefined): boolean {
  return v.is(v.number(), width) || /^[\d.]+%$/.test(text(width) ?? '');
}

function widthOf(row: BlockSummary, count: number): number {
  return parseFloat(String(row.attributes.width ?? 100 / count));
}

function precise(width: number): number {
  return parseFloat(width.toFixed(2));
}

// core/columns' updateColumns, for a count changed through insert, move, or remove.
function columnWidths({ children, previousColumns, isNewRow }: View): Write[] {
  const previous = previousColumns();
  const count = children.length;

  if (
    !previous?.length ||
    !count ||
    previous.length === count ||
    !previous.every((column) => explicitWidth(column.width))
  ) {
    return [];
  }

  const total = children.reduce((sum, row) => sum + widthOf(row, count), 0);

  if (Math.abs(total - 100) <= 1) {
    return [];
  }

  const added = children.filter(isNewRow);
  const kept = children.filter((row) => !added.includes(row));
  const newWidth = precise(100 / count);
  const available = added.length ? 100 - newWidth * added.length : 100;
  const keptTotal = kept.reduce((sum, row) => sum + widthOf(row, count), 0);

  return [
    ...kept.map((row) => ({
      row,
      set: { width: `${precise((available * widthOf(row, count)) / keptTotal)}%` },
    })),
    ...added.map((row) => ({ row, set: { width: `${newWidth}%` } })),
  ];
}

// A Resolution control writes the size's URL, which comes from the attachment record.
function sizeControl(
  block: string,
  id: string,
  size: string,
  url: string,
  attachment: string,
): Control {
  return {
    block,
    id,
    message: `Core's Resolution control also sets ${url} to that size. Use media_bindings with the inspected attachment and size, or send ${url}.`,
    when: ({ changed, attrs, parent }) =>
      changed(size) &&
      !changed(url) &&
      Boolean(attrs[url]) &&
      Boolean(attrs[attachment]) &&
      parent?.name !== 'core/gallery',
    writes: () => [],
    unresolved: () => true,
  };
}

const controls: Control[] = [
  {
    block: 'core/video',
    id: 'video_autoplay',
    onInsert: true,
    message:
      "Core's Autoplay toggle also sets muted and playsInline to the same value, because browsers only autoplay muted video.",
    when: (view) => view.changed('autoplay'),
    writes: ({ attrs }) => [
      { set: { muted: Boolean(attrs.autoplay), playsInline: Boolean(attrs.autoplay) } },
    ],
  },
  {
    block: 'core/file',
    id: 'file_replace',
    message:
      "Choosing a new file in core also points the file name's link at it and replaces the attachment ID. Set id if the new file is in the media library, and check fileName.",
    when: (view) => view.changed('href') && Boolean(view.before.href),
    writes: ({ attrs, changed }) => [
      { set: { textLinkHref: attrs.href ?? '' }, unset: changed('id') ? [] : ['id'] },
    ],
  },
  {
    block: 'core/button',
    id: 'button_unlink',
    message: "Core's unlink control also clears linkTarget and rel.",
    when: ({ before, attrs }) => Boolean(before.url) && !attrs.url,
    writes: () => [{ unset: ['linkTarget', 'rel'] }],
  },
  {
    block: 'core/button',
    id: 'button_new_tab',
    message:
      "Core's Open in new tab control also adds noopener to rel, and removes it when turned off.",
    when: (view) => view.changed('linkTarget') && Boolean(view.attrs.url),
    writes: newTabRel,
  },
  {
    block: 'core/image',
    id: 'image_decorative',
    onInsert: true,
    message:
      "Core's Decorative control also empties alt and removes the caption and link, so the image doesn't become a link with no accessible name.",
    when: ({ changed, attrs }) => changed('isDecorative') && attrs.isDecorative === true,
    writes: () => [
      { set: { alt: '' }, unset: ['caption', 'href', 'linkDestination', 'linkTarget', 'rel'] },
    ],
  },
  {
    block: 'core/image',
    id: 'image_lightbox',
    message: "Core's Enlarge on click control also turns off isDecorative.",
    when: ({ changed, attrs }) => changed('lightbox') && object(attrs.lightbox).enabled === true,
    writes: () => [{ set: { isDecorative: false } }],
  },
  {
    block: 'core/image',
    id: 'image_url',
    message:
      "Replacing an image by URL in core also removes the old attachment ID, which would otherwise keep the old image's class and responsive sources, and resets sizeSlug. Set id instead if the new image is in the media library.",
    when: ({ before, attrs, changed }) =>
      replacedFile(before.url, attrs.url) && !changed('id', 'sizeSlug'),
    writes: ({ site }) => [{ set: { sizeSlug: site.imageSize }, unset: ['id', 'blob'] }],
  },
  {
    block: 'core/image',
    id: 'image_replaced',
    message:
      'Choosing a new image in core also copies its alt and caption, and updates href to the new file when the image links to its file. media_bindings sets url, id, and alt from an inspected attachment.',
    when: ({ before, changed, attrs }) =>
      replacedFile(before.url, attrs.url) && Boolean(attrs.id) && changed('id'),
    writes: () => [],
    unresolved: ({ attrs, changed }) =>
      !changed('alt') || (attrs.linkDestination === 'media' && !changed('href')),
  },
  sizeControl('core/image', 'image_size', 'sizeSlug', 'url', 'id'),
  {
    block: 'core/image',
    id: 'image_link',
    message:
      "Core's link control writes linkDestination with href, and a typed link turns off the lightbox. If the note is incomplete, keep attachment when href is still the attachment page, and otherwise set linkDestination to custom.",
    when: ({ changed, attrs }) => changed('href') && !attrs.isDecorative,
    unresolved: ({ attrs, changed }) =>
      attrs.linkDestination === 'attachment' &&
      !changed('linkDestination') &&
      replacedFile(attrs.url, attrs.href),
    writes: (view) => {
      const { attrs } = view;

      if (!attrs.href) {
        return [{ set: { linkDestination: 'none' } }];
      }

      return [
        {
          set: {
            linkDestination: linkDestination(view),
            lightbox:
              object(attrs.lightbox).enabled === true
                ? { ...object(attrs.lightbox), enabled: false }
                : undefined,
          },
        },
      ];
    },
  },
  {
    block: 'core/image',
    id: 'image_new_tab',
    message:
      "Core's Open in new tab control also adds noopener to rel, and removes it when turned off.",
    when: ({ changed, attrs, parent }) =>
      changed('linkTarget') && Boolean(attrs.href) && parent?.name !== 'core/gallery',
    writes: newTabRel,
  },
  {
    block: 'core/image',
    id: 'image_aspect_ratio',
    message:
      "Core's Aspect ratio control also sets scale, which is what crops the image instead of stretching it. Removing the ratio removes scale.",
    when: ({ changed, parent }) => changed('aspectRatio') && parent?.name !== 'core/gallery',
    writes: ({ attrs, before }) => {
      if (!attrs.aspectRatio || attrs.aspectRatio === 'auto') {
        return hasBothDimensions(attrs) ? [] : [{ unset: ['scale'] }];
      }

      return [{ set: { scale: attrs.scale ?? before.scale ?? 'cover' } }];
    },
  },
  {
    block: 'core/image',
    id: 'image_dimensions',
    message:
      "Setting both width and height in core's control replaces aspectRatio and sets scale, which is what crops the image instead of stretching it.",
    when: ({ changed, attrs }) => changed('width', 'height') && hasBothDimensions(attrs),
    writes: ({ attrs }) => [{ set: { scale: attrs.scale ?? 'cover' }, unset: ['aspectRatio'] }],
  },
  {
    block: 'core/cover',
    id: 'cover_media_removed',
    message:
      "Core's Clear media control also removes the attachment ID, background type, focal point, fixed and repeated background settings, and featured image setting.",
    when: ({ before, attrs }) => Boolean(before.url) && !attrs.url && !attrs.useFeaturedImage,
    writes: () => [
      {
        unset: [
          'id',
          'backgroundType',
          'focalPoint',
          'hasParallax',
          'isRepeated',
          'useFeaturedImage',
        ],
      },
    ],
  },
  {
    block: 'core/cover',
    id: 'cover_media_replaced',
    message:
      "Choosing new cover media in core also removes the focal point and featured image setting. An embedded video also removes the attachment ID and the fixed and repeated background settings. A new URL with the same id keeps the old image's ID, so set id if the media is in the library.",
    when: ({ before, attrs }) => replacedFile(before.url, attrs.url),
    writes: ({ attrs, changed }) => {
      const embed = attrs.backgroundType === 'embed-video';

      return [
        {
          unset: [
            ...(changed('id') ? [] : ['id']),
            'focalPoint',
            'useFeaturedImage',
            ...(embed ? ['hasParallax', 'isRepeated'] : []),
          ],
        },
      ];
    },
    unresolved: ({ attrs, changed }) => Boolean(attrs.id) && changed('id') && !changed('alt'),
  },
  sizeControl('core/cover', 'cover_size', 'sizeSlug', 'url', 'id'),
  {
    block: 'core/cover',
    id: 'cover_featured_image',
    message: "Core's Use featured image control also removes the attachment ID and URL.",
    when: ({ changed, attrs }) => changed('useFeaturedImage') && attrs.useFeaturedImage === true,
    writes: () => [{ unset: ['id', 'url', 'backgroundType'] }],
  },
  {
    block: 'core/cover',
    id: 'cover_overlay_color',
    message:
      "Core's overlay color control also sets isUserOverlayColor, so a later image change keeps the chosen color, and clears the other kind of overlay color.",
    when: (view) => view.changed('customOverlayColor', 'overlayColor'),
    writes: ({ attrs, changed }) => {
      const custom = changed('customOverlayColor') && Boolean(attrs.customOverlayColor);
      const named = changed('overlayColor') && Boolean(attrs.overlayColor);

      return custom || named
        ? [
            {
              set: { isUserOverlayColor: true },
              unset: custom ? ['overlayColor'] : ['customOverlayColor'],
            },
          ]
        : [];
    },
  },
  {
    block: 'core/cover',
    id: 'cover_is_dark',
    message:
      "Core recalculates isDark from the overlay and media, and it sets whether the cover's text is light. When the note is incomplete, core would sample the image's average color, so unless you already sent isDark, set it to true if the result is dark and false if it is light.",
    when: (view) =>
      view.changed('customOverlayColor', 'overlayColor', 'dimRatio', 'url', 'useFeaturedImage'),
    writes: (view) => {
      const value = coverIsDark(view);

      return value === undefined ? [] : [{ set: { isDark: value } }];
    },
    unresolved: (view) => coverIsDark(view) === undefined,
  },
  {
    block: 'core/cover',
    id: 'cover_min_height',
    message:
      "Core's minimum height control also removes the aspect ratio, which would otherwise override it.",
    when: ({ changed, attrs }) => changed('minHeight') && attrs.minHeight !== undefined,
    writes: () => [{ unset: [['style', 'dimensions', 'aspectRatio']] }],
  },
  {
    block: 'core/media-text',
    id: 'media_text_featured_image',
    message:
      "Core's Use featured image control also turns off image fill, sets mediaType to image, and removes the block's own media and link.",
    when: ({ changed, attrs }) => changed('useFeaturedImage') && attrs.useFeaturedImage === true,
    writes: () => [
      {
        set: { imageFill: false, mediaType: 'image' },
        unset: [
          'mediaId',
          'mediaUrl',
          'mediaAlt',
          'mediaLink',
          'linkDestination',
          'linkTarget',
          'linkClass',
          'rel',
          'href',
        ],
      },
    ],
  },
  {
    block: 'core/media-text',
    id: 'media_text_media_replaced',
    message:
      'Choosing new media in core also replaces the attachment ID, attachment link, and alt, and removes the focal point and featured image setting. Set mediaId if the media is in the library, check that mediaAlt describes it, and set href to the new file when the block links to its file.',
    when: ({ before, attrs }) => replacedFile(before.mediaUrl, attrs.mediaUrl),
    writes: ({ changed }) => [
      {
        set: { useFeaturedImage: false },
        unset: [...(changed('mediaId') ? [] : ['mediaId', 'mediaLink']), 'focalPoint'],
      },
    ],
    unresolved: ({ attrs, changed }) =>
      (Boolean(attrs.mediaId) && changed('mediaId') && !changed('mediaAlt')) ||
      (attrs.linkDestination === 'media' && !changed('href')),
  },
  sizeControl('core/media-text', 'media_text_size', 'mediaSizeSlug', 'mediaUrl', 'mediaId'),
  {
    block: 'core/media-text',
    id: 'media_text_media_removed',
    message: 'Removing the media in core also removes its ID, type, alt, links, and focal point.',
    when: ({ before, attrs }) =>
      Boolean(before.mediaUrl) && !attrs.mediaUrl && !attrs.useFeaturedImage,
    writes: () => [
      {
        set: { useFeaturedImage: false },
        unset: ['mediaId', 'mediaType', 'mediaAlt', 'mediaLink', 'href', 'focalPoint'],
      },
    ],
  },
  {
    block: 'core/columns',
    id: 'columns_vertical_alignment',
    message:
      "Vertical alignment on Columns also sets it on every Column, because core's CSS aligns each Column through its own class.",
    when: ({ changed, attrs, before, children }) =>
      changed('verticalAlignment') &&
      // A Column's own control clears the parent and leaves its siblings alone.
      (Boolean(attrs.verticalAlignment) ||
        children.every((row) => row.attributes.verticalAlignment === before.verticalAlignment)),
    writes: ({ attrs, children }) =>
      children.map((row) => ({
        row,
        ...setOrUnset('verticalAlignment', text(attrs.verticalAlignment)),
      })),
  },
  {
    block: 'core/column',
    id: 'column_vertical_alignment',
    message: "Vertical alignment on one Column also clears the parent Columns block's alignment.",
    when: ({ changed, parent, attrs }) =>
      changed('verticalAlignment') &&
      Boolean(parent?.attributes.verticalAlignment) &&
      parent?.attributes.verticalAlignment !== attrs.verticalAlignment,
    writes: ({ parent }) => [{ row: parent, unset: ['verticalAlignment'] }],
  },
  {
    block: 'core/columns',
    id: 'columns_count',
    message:
      'Changing the column count in core also redistributes explicit widths so they total 100%, because the widths otherwise overflow the row or leave a gap.',
    when: ({ isNew }) => !isNew,
    writes: columnWidths,
  },
  {
    block: 'core/accordion',
    id: 'accordion_heading_level',
    message: "An Accordion's heading level also sets level on every Accordion Heading inside it.",
    when: (view) => view.changed('headingLevel'),
    writes: ({ attrs, children, childrenOf }) =>
      children
        .flatMap(childrenOf)
        .filter((row) => row.name === 'core/accordion-heading')
        .map((row) => ({ row, set: { level: attrs.headingLevel ?? 3 } })),
  },
  {
    block: 'core/accordion-heading',
    id: 'accordion_item_added',
    onInsert: true,
    message: "Core's add item control gives the new heading the Accordion's heading level.",
    when: ({ isNew, parent, parentOf, isNewRow }) => {
      const accordion = parent && parentOf(parent);

      return isNew && accordion?.name === 'core/accordion' && !isNewRow(accordion);
    },
    writes: ({ parent, parentOf }) => {
      const level = parent && parentOf(parent)?.attributes.headingLevel;

      return [{ set: { level: level ?? 3 } }];
    },
  },
  {
    block: 'core/gallery',
    id: 'gallery_link',
    message:
      "A Gallery's link setting also writes each Image's link. For media and attachment links, core also sets each Image's href to its file or attachment page, which only you can send.",
    when: (view) => view.changed('linkTo'),
    writes: (view) => imageChildren(view).map((row) => galleryLink(row, view.attrs.linkTo)),
    unresolved: ({ attrs }) => attrs.linkTo === 'media' || attrs.linkTo === 'attachment',
  },
  {
    block: 'core/gallery',
    id: 'gallery_new_tab',
    message:
      "A Gallery's Open in new tab control also sets linkTarget on each Image and removes noopener from its rel.",
    when: (view) => view.changed('linkTarget'),
    writes: (view) =>
      imageChildren(view).map((row) => {
        const rel = setOrUnset('rel', withoutNoopener(row.attributes.rel));

        return {
          row,
          set: { linkTarget: text(view.attrs.linkTarget), ...rel.set },
          unset: [...(view.attrs.linkTarget ? [] : ['linkTarget']), ...(rel.unset ?? [])],
        };
      }),
  },
  {
    block: 'core/gallery',
    id: 'gallery_image_size',
    message:
      "A Gallery's Resolution control also sets sizeSlug on each Image and removes its width and height. Core also sets each Image's url to that size, so use media_bindings with the inspected attachment and size, or send each url.",
    when: (view) => view.changed('sizeSlug'),
    writes: (view) =>
      imageChildren(view).map((row) => ({
        row,
        set: { sizeSlug: text(view.attrs.sizeSlug) },
        unset: ['width', 'height'],
      })),
    unresolved: (view) => imageChildren(view).some((row) => !view.changedOn(row, 'url')),
  },
  {
    block: 'core/gallery',
    id: 'gallery_aspect_ratio',
    message: "A Gallery's Aspect ratio control also sets aspectRatio on each Image.",
    when: (view) => view.changed('aspectRatio'),
    writes: (view) =>
      imageChildren(view).map((row) => ({
        row,
        ...setOrUnset(
          'aspectRatio',
          view.attrs.aspectRatio === 'auto' ? undefined : text(view.attrs.aspectRatio),
        ),
      })),
  },
  {
    block: 'core/table',
    id: 'table_columns',
    message:
      "Core's column controls change every section. Inserting or deleting a column changes each row in head, body, and foot, and column alignment sets align on each cell in the column. Send every section that needs it.",
    when: (view) => view.changed('head', 'body', 'foot'),
    writes: () => [],
    unresolved: ({ attrs, before }) => {
      const rows = tableRows(attrs);

      if (rows.flat().some((cell) => cell.colspan || cell.rowspan)) {
        return false;
      }

      const aligns = columnAligns(rows);
      const previous = columnAligns(tableRows(before));

      return (
        new Set(rows.map((row) => row.length)).size > 1 ||
        aligns.some((column, index) => new Set(column).size > 1 && !same(column, previous[index]))
      );
    },
  },
  {
    block: ['core/navigation-link', 'core/navigation-submenu'],
    id: 'navigation_link_url',
    message:
      "A typed URL in core's link control also makes this a custom link. Keeping the old id and kind leaves it pointing at the old page. Send id, kind, and type yourself if the link should point at a page or post.",
    when: ({ changed, attrs }) =>
      changed('url') &&
      !changed('id') &&
      Boolean(attrs.id) &&
      !object(object(attrs.metadata).bindings).url,
    writes: () => [{ set: { kind: 'custom', type: 'custom' }, unset: ['id'] }],
  },
];

function pathOf(path: Path): string[] {
  return [path].flat();
}

function valueAt(attributes: JsonObject, path: string[]): JsonValue | undefined {
  return path.reduce<JsonValue | undefined>(
    (value, key) => (v.is(JsonObjectSchema, value) ? value[key] : undefined),
    attributes,
  );
}

// Reduces a write to what the block doesn't hold yet, and to attributes the site
// registers, so an older WordPress never gets an edit it would refuse.
function missingWrite(wp: WordPress, row: BlockSummary, write: Write): NoteEdit | undefined {
  const registered = wp.blocks.getBlockType(row.name)?.attributes ?? {};
  const set = Object.entries(write.set ?? {}).filter(([key, value]) => {
    const current = row.attributes[key];

    return (
      value !== undefined &&
      key in registered &&
      !same(current, value) &&
      !(typeof value === 'boolean' && Boolean(current) === value)
    );
  });
  const unset = (write.unset ?? []).map(pathOf).filter((path) => {
    const current = valueAt(row.attributes, path);
    const fallback = path.length === 1 ? registered[path[0]]?.default : undefined;

    return (
      path[0] in registered && current !== undefined && current !== '' && !same(current, fallback)
    );
  });

  return set.length || unset.length
    ? { op: 'update', client_id: row.clientId, attributes: Object.fromEntries(set), unset }
    : undefined;
}

function siteDetails(wp: WordPress): Site {
  const settings = wp.data.select('core/block-editor').getSettings?.() ?? {};
  const colors = new Map<string, string>();

  for (const item of Array.isArray(settings.colors) ? settings.colors : []) {
    const { slug, color } = object(item);

    if (typeof slug === 'string' && typeof color === 'string') {
      colors.set(slug, color);
    }
  }

  return { imageSize: settings.imageDefaultSize, colors };
}

const MAX_NOTES = 32;
const MAX_NOTE_EDITS = 64;

// Runs after an edit has applied, over the blocks it changed.
export function controlNotes(
  wp: WordPress,
  rows: BlockSummary[],
  changedRows: BlockSummary[],
  before: Map<string, { attributes: string; children: string }>,
): JsonObject {
  const byId = new Map(rows.map((row) => [row.clientId, row]));
  const parents = new Map(
    rows.flatMap((row) =>
      (row.block.innerBlocks ?? []).map((child) => [child.clientId, row] as const),
    ),
  );
  const childrenOf = (row: BlockSummary) =>
    (row.block.innerBlocks ?? []).flatMap((child) => byId.get(child.clientId) ?? []);
  const attributesBefore = (clientId: string): JsonObject | undefined => {
    const observed = before.get(clientId)?.attributes;

    return observed === undefined ? undefined : object(JSON.parse(observed));
  };

  const isNewRow = (row: BlockSummary) => !before.has(row.clientId);
  const site = siteDetails(wp);
  const notes: JsonObject[] = [];

  for (const row of changedRows) {
    const registered = wp.blocks.getBlockType(row.name)?.attributes ?? {};
    const previous = attributesBefore(row.clientId) ?? {};
    const value = (attributes: JsonObject, key: string) =>
      attributes[key] ?? registered[key]?.default;
    const view: View = {
      row,
      attrs: row.attributes,
      before: previous,
      isNew: isNewRow(row),
      parent: parents.get(row.clientId),
      children: childrenOf(row),
      site,
      changed: (...keys) =>
        keys.some((key) => !same(value(previous, key), value(row.attributes, key))),
      changedOn: (other, key) =>
        !same(attributesBefore(other.clientId)?.[key], other.attributes[key]),
      childrenOf,
      parentOf: (other) => parents.get(other.clientId),
      isNewRow,
      previousColumns: () => {
        const ids = before.get(row.clientId)?.children.split(',').filter(Boolean);

        return ids?.map((id) => attributesBefore(id) ?? {});
      },
    };

    for (const control of controls) {
      const applies =
        [control.block].flat().includes(row.name) &&
        (!view.isNew || control.onInsert) &&
        control.when(view);

      if (!applies) {
        continue;
      }

      const edits: NoteEdit[] = [];
      const restricted: JsonObject[] = [];

      for (const write of control.writes(view)) {
        const target = write.row ?? row;
        const edit = missingWrite(wp, target, write);
        const { reason, editing_mode: mode } = editRestriction(wp, target, rows);
        const contentOnly = ['pattern_section', 'content_only'].includes(reason);
        const allowed =
          !reason || (edit && contentOnly && contentEdit(wp, target.name, edit, mode));

        if (edit && !allowed) {
          restricted.push({ client_id: target.clientId, reason });
        } else if (edit) {
          edits.push(edit);
        }
      }

      const unresolved = !view.isNew && control.unresolved?.(view);

      if (edits.length || restricted.length || unresolved) {
        notes.push({
          control: control.id,
          client_id: row.clientId,
          name: row.name,
          path: row.path,
          message: control.message,
          edits: edits.slice(0, MAX_NOTE_EDITS),
          edits_truncated: edits.length > MAX_NOTE_EDITS ? edits.length : undefined,
          restricted: restricted.length ? restricted : undefined,
          incomplete: unresolved || restricted.length > 0 || undefined,
        });
      }
    }
  }

  return {
    notes: notes.length ? notes.slice(0, MAX_NOTES) : undefined,
    notes_truncated: notes.length > MAX_NOTES ? notes.length : undefined,
  };
}
