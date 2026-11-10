import * as v from 'valibot';
import { JsonObjectSchema } from './contracts';
import type { BlockInput, Edit, JsonObject, JsonValue } from './contracts';
import type { Block, ParsedPatternBlock, WordPress } from './wordpress';
import { requireCondition as assert } from './inspection';
import { styles } from './catalog';
import { same } from './values';
import { safeValue, schemaAllows } from './schema';
import { BlockworkError } from './errors';

export interface PatternSpacer {
  path: number[];
  height: string;
  resolvedSize: string;
  settings: JsonValue[];
}

const spacerSettingPaths = [
  ['spacing', 'spacingSizes', 'custom'],
  ['spacing', 'spacingSizes', 'theme'],
  ['spacing', 'spacingSizes', 'default'],
  ['spacing', 'defaultSpacingSizes'],
];

function settingAt(settings: JsonObject, path: string[]): JsonValue | undefined {
  let value: JsonValue | undefined = settings;

  for (const key of path) {
    value = object(value)[key];
  }

  return value;
}

export function spacerSettings(wp: WordPress, ancestors: Block[]): JsonValue[] {
  // hasFilter also reports hooks that ran without any registered callbacks.
  assert(
    wp.hooks.filters &&
      !wp.hooks.filters['blockEditor.useSetting.before']?.handlers.length &&
      !wp.hooks.filters.all?.handlers.length,
    'unsupported_pattern',
    {
      constraint: 'spacer_setting_filter',
      next_step:
        'Keep the site filters. Use an explicitly configured block tree only when its pixel spacing is known and authorized; otherwise retain the draft and report this unsupported pattern context.',
    },
  );

  for (const block of ancestors) {
    if (!wp.blocks.getBlockType(block.name)?.supports?.__experimentalSettings) {
      continue;
    }

    const settings = object(block.attributes.settings);
    const local = object(object(settings.blocks)['core/spacer']);
    assert(
      !spacerSettingPaths.some(
        (path) => (settingAt(local, path) ?? settingAt(settings, path)) !== undefined,
      ),
      'unsupported_pattern',
      {
        constraint: 'spacer_ancestor_settings',
        next_step: 'Insert the pattern outside the container that overrides spacing settings.',
      },
    );
  }

  const features = object(
    wp.data.select('core/block-editor').getSettings?.().__experimentalFeatures,
  );
  const local = object(object(features.blocks)['core/spacer']);

  return spacerSettingPaths.map((path) => {
    const value = settingAt(local, path) ?? settingAt(features, path) ?? null;

    return v.parse(JsonObjectSchema, JSON.parse(JSON.stringify({ value }))).value ?? null;
  });
}

// Only registered-pattern input takes this path. Other editing operations retain
// the attributes requested by the caller and the existing initialization checks.
export function normalizePatternSpacers(
  wp: WordPress,
  inputs: BlockInput[],
  ancestors: Block[],
  original: ParsedPatternBlock[],
): PatternSpacer[] {
  const conversions: PatternSpacer[] = [];
  const visit = (
    items: BlockInput[],
    parents: Block[],
    prefix: number[],
    raw: ParsedPatternBlock[],
  ): void => {
    const named = raw.filter((block) => block.blockName !== null);

    for (const [index, input] of items.entries()) {
      const path = [...prefix, index];
      const parent = parents.at(-1);
      const parentLayout = object(parent?.attributes.layout);
      const attributes = input.attributes ?? {};
      const style = object(attributes.style);
      const layout = object(style.layout);
      const eligible =
        input.name === 'core/spacer' &&
        prefix.length > 0 &&
        parent?.name === 'core/group' &&
        parentLayout.type === 'flex' &&
        parentLayout.orientation === 'vertical' &&
        Boolean(wp.blocks.getBlockType(parent.name)?.supports?.layout) &&
        layout.flexSize === undefined &&
        (layout.selfStretch === undefined || layout.selfStretch === 'fixed');

      if (eligible) {
        const parentStyle = object(parent.attributes.style);
        assert(
          !Object.keys(parentStyle).some(
            (key) => key === 'css' || key.startsWith('@') || key.startsWith(':'),
          ),
          'unsupported_pattern',
          {
            constraint: 'spacer_parent_layout_uncertainty',
            next_step: 'Use a vertical Group without responsive or custom CSS layout overrides.',
          },
        );
        assert(
          named[index]?.blockName === input.name && Object.hasOwn(named[index].attrs, 'height'),
          'unsupported_pattern',
          {
            constraint: 'spacer_explicit_height',
            next_step: 'Set an explicit Spacer height in the registered pattern.',
          },
        );
        const settings = spacerSettings(wp, parents);
        const sizes = settings
          .slice(0, settings[3] === false ? 2 : 3)
          .flatMap((value) =>
            Array.isArray(value) ? value.filter((item) => v.is(JsonObjectSchema, item)) : [],
          );
        const height = attributes.height;
        const preset = typeof height === 'string' && height.match(/^var:preset\|spacing\|([^|]+)$/);
        const resolved =
          typeof height === 'string' &&
          wp.blockEditor?.getCustomValueFromPreset &&
          (!preset || !['0', 'default'].includes(preset[1]))
            ? wp.blockEditor.getCustomValueFromPreset(height, sizes)
            : undefined;
        const pixels =
          typeof resolved === 'string' &&
          /^(?:\d+|\d*\.\d+)px$/.test(resolved) &&
          Number.isFinite(Number(resolved.slice(0, -2)));
        assert(
          pixels &&
            attributes.width === undefined &&
            !Object.keys(style).some(
              (key) => key === 'css' || key.startsWith('@') || key.startsWith(':'),
            ),
          'unsupported_pattern',
          {
            constraint: 'spacer_explicit_pixel_height',
            next_step:
              'Use an explicit nonnegative pixel height or a spacing preset that resolves to one.',
          },
        );
        assert(typeof height === 'string' && typeof resolved === 'string', 'unsupported_pattern');
        attributes.height = '0px';
        attributes.style = {
          ...style,
          layout: { ...layout, flexSize: resolved, selfStretch: 'fixed' },
        };
        conversions.push({ path, height, resolvedSize: resolved, settings });
      }

      visit(
        input.inner_blocks ?? [],
        [...parents, { name: input.name, attributes, clientId: '' }],
        path,
        named[index]?.innerBlocks ?? [],
      );
    }
  };

  visit(inputs, ancestors, [], original);

  return conversions;
}

// CSS zero must remain explicit so native gap rules do not treat it as absent.
export function nativeMarginInput(
  wp: WordPress,
  name: string,
  value: JsonValue,
  path: string[],
): JsonValue {
  const prefix = ['style', 'spacing', 'margin'];

  if (!path.slice(0, 3).every((key, index) => key === prefix[index])) {
    return value;
  }

  if (path.length === 4 && ['top', 'bottom', 'left', 'right'].includes(path[3]) && value === 0) {
    const support = object(wp.blocks.getBlockType(name)?.supports?.spacing).margin;

    return support === true || (Array.isArray(support) && support.includes(path[3])) ? '0' : value;
  }

  if (path.length <= 3 && v.is(JsonObjectSchema, value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        child === undefined ? child : nativeMarginInput(wp, name, child, [...path, key]),
      ]),
    );
  }

  return value;
}

interface StyleControl extends JsonObject {
  property: string[];
  support: JsonValue;
  setting?: JsonValue;
  enabled: boolean;
  edges: string[];
  requires_edge?: boolean;
  preset_attribute?: string;
  preset_type?: string;
  preset_value_format?: string;
  presets?: JsonValue;
  custom?: JsonValue;
  values?: JsonValue[];
  value_type?: string;
  custom_colors?: JsonValue;
  colors?: JsonValue;
}

interface StyleContext extends JsonObject {
  controls: StyleControl[];
  settings: JsonObject;
  responsive: JsonObject;
  custom_css: JsonObject;
  pseudo_states: string[];
}

interface StyleDefinition {
  group: string;
  key: string;
  support_key?: string;
  setting_key?: string;
  preset_attribute?: string;
  preset_catalogue?: string;
  preset_type?: string;
  kind?: string;
  preset_group?: string;
  values?: JsonValue[];
}

export interface StyleCatalog extends JsonObject {
  preset_type: string;
  items: JsonObject[];
}

function presetItems(value: JsonValue | undefined): JsonObject[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!v.is(JsonObjectSchema, item) || typeof item.slug !== 'string') {
        return [];
      }

      // Font-file declarations and other native metadata do not describe a
      // selectable preset. Keep the slug and values needed to choose one.
      return [
        {
          slug: item.slug,
          name: item.name,
          color: item.color,
          gradient: item.gradient,
          size: item.size,
          fontFamily: item.fontFamily,
          shadow: item.shadow,
          colors: item.colors,
        },
      ];
    });
  }

  return Object.values(object(value)).flatMap(presetItems);
}

function presetCatalog(
  catalogs: StyleCatalog[],
  type: string | undefined,
  value: JsonValue | undefined,
): number | undefined {
  if (!type) {
    return;
  }

  const items = presetItems(value);

  if (!items.length) {
    return;
  }

  const catalog = { preset_type: type, items };
  const index = catalogs.findIndex((existing) => same(existing, catalog));

  if (index >= 0) {
    return index;
  }

  catalogs.push(catalog);

  return catalogs.length - 1;
}

function availablePresets(settings: JsonObject, catalogue: string): JsonValue | undefined {
  const flags = new Map([
    ['palette', 'defaultPalette'],
    ['gradients', 'defaultGradients'],
    ['fontSizes', 'defaultFontSizes'],
    ['spacingSizes', 'defaultSpacingSizes'],
    ['presets', 'defaultPresets'],
    ['duotone', 'defaultDuotone'],
  ]);
  const value = settings[catalogue];
  const flag = flags.get(catalogue);

  if (flag && settings[flag] === false && v.is(JsonObjectSchema, value)) {
    const allowed = { ...value };
    delete allowed.default;

    return allowed;
  }

  return value;
}

function object(value: JsonValue | undefined): JsonObject {
  return v.is(JsonObjectSchema, value) ? value : {};
}

function merge(base: JsonObject, override: JsonObject): JsonObject {
  const result = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (v.is(JsonObjectSchema, value) && v.is(JsonObjectSchema, base[key])) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

// WordPress's viewport normalization, including a single configured range and
// invalid or reversed ranges; with none configured, the native defaults.
export function viewportBreakpoints(
  configured: JsonObject,
): Partial<Record<'mobile' | 'tablet', { value: string; pixels: number }>> {
  const breakpoints: ReturnType<typeof viewportBreakpoints> = {};

  for (const name of ['mobile', 'tablet'] as const) {
    const value = configured[name];
    const match =
      typeof value === 'string' ? value.trim().match(/^(\d+|\d*\.\d+)(px|em|rem)$/) : null;

    if (match) {
      breakpoints[name] = {
        value: value!.toString().trim(),
        pixels: Number(match[1]) * (match[2] === 'px' ? 1 : 16),
      };
    }
  }

  if (!breakpoints.mobile && !breakpoints.tablet) {
    return { mobile: { value: '480px', pixels: 480 }, tablet: { value: '782px', pixels: 782 } };
  }

  if (
    breakpoints.mobile &&
    breakpoints.tablet &&
    breakpoints.mobile.pixels >= breakpoints.tablet.pixels
  ) {
    delete breakpoints.tablet;
  }

  return breakpoints;
}

// Missing configuration uses native defaults only when the loaded editor
// exposes its responsive control.
function responsive(wp: WordPress, settings: JsonObject): JsonObject {
  const available = typeof wp.blockEditor?.__experimentalResponsiveBlockControl === 'function';
  const configured = object(settings.viewport);
  const ranges: JsonObject = {};

  if (available) {
    for (const [name, breakpoint] of Object.entries(viewportBreakpoints(configured))) {
      ranges[name] = breakpoint.value;
    }
  }

  const states: JsonObject = {};

  if (ranges.mobile) {
    states['@mobile'] = `width <= ${ranges.mobile}`;
  }

  if (ranges.tablet) {
    states['@tablet'] = ranges.mobile
      ? `${ranges.mobile} < width <= ${ranges.tablet}`
      : `width <= ${ranges.tablet}`;
  }

  return {
    available,
    evidence: available ? 'native_responsive_control' : 'unknown_native_responsive_support',
    configured,
    states,
    base: 'Applies at every width. There is no @desktop style key.',
    inheritance:
      'Each range inherits base styles independently. Tablet does not cascade to mobile.',
  };
}

function context(wp: WordPress, name: string): StyleContext {
  const registration = wp.blocks.getBlockType(name);
  assert(registration, 'unregistered_block');
  const supports = registration.supports ?? {};
  const editor = wp.data.select('core/block-editor').getSettings?.() ?? {};
  const features = object(editor.__experimentalFeatures);
  safeValue(features);
  const settings = merge(features, object(object(features.blocks)[name]));
  delete settings.blocks;
  const controls: StyleControl[] = [];
  const definitions: StyleDefinition[] = [
    ...['padding', 'margin'].map((key) => ({ group: 'spacing', key, kind: 'box' })),
    { group: 'spacing', key: 'blockGap', kind: 'gap' },
    {
      group: 'color',
      key: 'text',
      preset_attribute: 'textColor',
      preset_catalogue: 'palette',
      preset_type: 'color',
      kind: 'custom',
    },
    {
      group: 'color',
      key: 'background',
      preset_attribute: 'backgroundColor',
      preset_catalogue: 'palette',
      preset_type: 'color',
      kind: 'custom',
    },
    {
      group: 'color',
      key: 'gradient',
      support_key: 'gradients',
      setting_key: 'background',
      preset_attribute: 'gradient',
      preset_catalogue: 'gradients',
      preset_type: 'gradient',
      kind: 'customGradient',
    },
    {
      group: 'typography',
      key: 'fontSize',
      preset_attribute: 'fontSize',
      preset_catalogue: 'fontSizes',
      preset_type: 'font-size',
      kind: 'customFontSize',
    },
    {
      group: 'typography',
      key: 'fontFamily',
      support_key: '__experimentalFontFamily',
      preset_attribute: 'fontFamily',
      preset_catalogue: 'fontFamilies',
      preset_type: 'font-family',
    },
    { group: 'typography', key: 'lineHeight' },
    { group: 'typography', key: 'textAlign', values: ['left', 'center', 'right'] },
    { group: 'typography', key: 'textColumns' },
    { group: 'typography', key: 'textIndent' },
    { group: 'typography', key: 'writingMode', support_key: '__experimentalWritingMode' },
    ...['fontStyle', 'fontWeight', 'letterSpacing', 'textDecoration', 'textTransform'].map(
      (key) => ({
        group: 'typography',
        key,
        support_key: `__experimental${key[0].toUpperCase()}${key.slice(1)}`,
      }),
    ),
    ...['minHeight', 'aspectRatio', 'width', 'height', 'minWidth'].map((key) => ({
      group: 'dimensions',
      key,
    })),
    {
      group: 'border',
      key: 'color',
      preset_attribute: 'borderColor',
      preset_catalogue: 'palette',
      preset_type: 'color',
      preset_group: 'color',
      kind: 'custom',
    },
    ...['style', 'width', 'radius'].map((key) => ({ group: 'border', key })),
    { group: 'background', key: 'backgroundImage', kind: 'background_image' },
    ...['backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundAttachment'].map(
      (key) => ({
        group: 'background',
        key,
        support_key: 'backgroundSize',
        setting_key: 'backgroundSize',
      }),
    ),
    {
      group: 'background',
      key: 'gradient',
      preset_catalogue: 'gradients',
      preset_type: 'gradient',
      preset_group: 'color',
      kind: 'customGradient',
    },
    { group: 'shadow', key: '', preset_catalogue: 'presets', preset_type: 'shadow' },
  ];

  for (const {
    group,
    key,
    support_key = key,
    setting_key = key,
    preset_attribute,
    preset_catalogue,
    preset_type,
    preset_group = group,
    values,
    kind = '',
  } of definitions) {
    const groupSupport = group === 'border' ? supports.__experimentalBorder : supports[group];
    let support = key ? object(groupSupport)[support_key] : groupSupport;

    if (groupSupport === true && ['border', 'background'].includes(group)) {
      support = true;
    }

    if (
      groupSupport &&
      group === 'color' &&
      ['text', 'background'].includes(key) &&
      support === undefined
    ) {
      support = true;
    }

    const groupSettings = object(settings[group]);
    const presetSettings = object(settings[preset_group]);
    const setting = key ? groupSettings[setting_key] : groupSettings;
    const property = key ? ['style', group, key] : ['style', group];
    const supported = support === true || Array.isArray(support) || v.is(JsonObjectSchema, support);

    controls.push({
      property,
      support: support ?? false,
      setting,
      enabled: supported && setting !== false && Boolean(registration.attributes?.style),
      edges: kind === 'box' ? ['top', 'right', 'bottom', 'left'] : [],
      preset_attribute:
        preset_attribute && registration.attributes?.[preset_attribute]
          ? preset_attribute
          : undefined,
      preset_type: preset_type || (group === 'spacing' ? 'spacing' : undefined),
      preset_value_format: preset_type ? `var:preset|${preset_type}|SLUG` : undefined,
      presets: availablePresets(presetSettings, preset_catalogue || 'spacingSizes'),
      custom: ['custom', 'customGradient', 'customFontSize'].includes(kind)
        ? presetSettings[kind]
        : undefined,
      values: Array.isArray(support) && key === 'textAlign' ? support : values,
      value_type: kind === 'background_image' ? 'background_image' : 'string_or_number',
    });
  }

  const colorSettings = object(settings.color);

  for (const element of ['link', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'caption']) {
    const feature = /^h[1-6]$/.test(element) ? 'heading' : element;
    const support = object(supports.color)[feature];

    for (const key of element === 'button' ? ['text', 'background'] : ['text']) {
      controls.push({
        property: ['style', 'elements', element, 'color', key],
        support: support ?? false,
        setting: colorSettings[feature],
        enabled:
          support === true &&
          colorSettings[feature] !== false &&
          Boolean(registration.attributes?.style),
        edges: [],
        preset_type: 'color',
        preset_value_format: 'var:preset|color|SLUG',
        presets: availablePresets(colorSettings, 'palette'),
        custom: colorSettings.custom,
        value_type: 'string_or_number',
      });
    }
  }

  const duotoneSupport = object(supports.filter).duotone;
  controls.push({
    property: ['style', 'color', 'duotone'],
    support: duotoneSupport ?? false,
    enabled: duotoneSupport === true && Boolean(registration.attributes?.style),
    edges: [],
    preset_type: 'duotone',
    preset_value_format: 'var:preset|duotone|SLUG',
    presets: availablePresets(colorSettings, 'duotone'),
    custom: colorSettings.customDuotone,
    custom_colors: colorSettings.custom,
    colors: availablePresets(colorSettings, 'palette'),
    value_type: 'duotone',
  });

  // Split borders store the side before the property, unlike spacing boxes.
  // Side colors use nested preset tokens, never the whole-border slug attribute.
  const borderControls = controls.filter(
    (control) => control.property[1] === 'border' && control.property[2] !== 'radius',
  );

  for (const control of borderControls) {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      controls.push({
        ...control,
        property: ['style', 'border', side, control.property[2]],
        preset_attribute: undefined,
      });
    }
  }

  for (const control of controls) {
    if (control.property.join('.') === 'style.spacing.blockGap') {
      control.edges = ['top', 'left'];
      const sides = object(control.support).sides;

      if (Array.isArray(sides)) {
        control.edges = control.edges.filter((edge) =>
          sides.includes(edge === 'top' ? 'vertical' : 'horizontal'),
        );
      }
    } else if (control.property.join('.') === 'style.border.radius') {
      control.edges = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
    }

    if (Array.isArray(control.support)) {
      const supportedEdges = control.support;
      control.edges = control.edges.filter((edge) => supportedEdges.includes(edge));
      control.requires_edge = control.edges.length > 0;
    }

    if (control.preset_type === 'spacing') {
      control.preset_value_format = 'var:preset|spacing|SLUG';
      control.custom = object(settings.spacing).customSpacingSize;
    }
  }

  if (supports.layout && registration.attributes?.layout) {
    for (const key of [
      'type',
      'orientation',
      'justifyContent',
      'verticalAlignment',
      'flexWrap',
      'contentSize',
      'wideSize',
      'columnCount',
      'minimumColumnWidth',
    ]) {
      controls.push({
        property: ['layout', key],
        support: supports.layout,
        enabled: true,
        edges: [],
      });
    }
  }

  if (supports.align && registration.attributes?.align) {
    controls.push({ property: ['align'], support: supports.align, enabled: true, edges: [] });
  }

  const nativeResponsive = responsiveRules(wp, settings, editor);

  return {
    controls,
    settings,
    responsive: nativeResponsive,
    pseudo_states:
      nativeResponsive.available &&
      editor.blockStatesEditingEnabled !== false &&
      ['core/button', 'core/navigation-link'].includes(name)
        ? [':hover', ':focus', ':focus-visible', ':active']
        : [],
    custom_css: {
      ...cssPolicy(editor),
      supported:
        supports.customCSS !== false &&
        Boolean(registration.attributes?.style) &&
        typeof editor.canEditCSS === 'boolean',
    },
  };
}

function responsiveRules(wp: WordPress, settings: JsonObject, editor: JsonObject): JsonObject {
  return {
    ...responsive(wp, settings),
    editing_enabled:
      editor.blockStatesEditingEnabled !== false && editor.responsiveEditingEnabled !== false,
  };
}

function cssPolicy(editor: JsonObject): JsonObject {
  return {
    property: ['style', 'css'],
    evidence:
      typeof editor.canEditCSS === 'boolean'
        ? 'native_css_permission_setting'
        : 'unknown_native_custom_css_support',
    can_edit_css: editor.canEditCSS === true,
    permission_evidence: 'native-editor-settings.canEditCSS',
    format:
      'CSS declarations and nested & selectors. Native Gutenberg generates the instance selector.',
    policy:
      'Use native controls first. Repeated treatments belong in registered block styles. Page-scoped styles require explicit user permission.',
  };
}

// Editor-wide responsive rules, before any block type's own viewport ranges.
function editorResponsive(wp: WordPress): JsonObject {
  const editor = wp.data.select('core/block-editor').getSettings?.() ?? {};

  return responsiveRules(wp, object(editor.__experimentalFeatures), editor);
}

// The editor-wide breakpoints Gutenberg's device previews use.
export function editorBreakpoints(wp: WordPress): ReturnType<typeof viewportBreakpoints> {
  const editor = wp.data.select('core/block-editor').getSettings?.() ?? {};

  return viewportBreakpoints(object(object(editor.__experimentalFeatures).viewport));
}

// WordPress 7.1 moved settings such as textAlign from text blocks' own
// attributes into block supports, which store them under style. This names
// the enabled native control for such a setting, so a refusal can point to it.
export function styleControlFor(wp: WordPress, name: string, key: string): string[] | undefined {
  try {
    return context(wp, name)
      .controls.filter(
        (control) =>
          control.enabled && control.property[0] === 'style' && control.property.at(-1) === key,
      )
      .map((control) => control.property)
      .sort((a, b) => a.length - b.length)[0];
  } catch {
    // Missing style settings leave the refusal without a pointer.
    return undefined;
  }
}

// Editor-wide rules, returned once per read beside the guides. Each guide's
// custom_css says whether that block supports instance CSS, and a guide whose
// block type configures its own viewport ranges carries its own responsive.
export function styleRules(wp: WordPress, documentHasCSS: boolean): JsonObject {
  const editor = wp.data.select('core/block-editor').getSettings?.() ?? {};

  return {
    responsive: editorResponsive(wp),
    custom_css: { ...cssPolicy(editor), document_has_custom_css: documentHasCSS },
  };
}

export async function style_guide(
  wp: WordPress,
  block: Pick<Block, 'name' | 'attributes'>,
  catalogs: StyleCatalog[],
  parent?: Block,
  properties?: string[][],
): Promise<JsonObject> {
  const current = context(wp, block.name);
  const controls = current.controls.flatMap((control) => {
    const matches =
      !properties ||
      properties.some((prefix) => prefix.every((key, index) => control.property[index] === key));

    if (!control.enabled || !matches) {
      return [];
    }

    // Guides list enabled controls only, so they carry no enabled flag.
    return [
      {
        property: control.property,
        edges: control.edges.length ? control.edges : undefined,
        requires_edge: control.requires_edge,
        preset_attribute: control.preset_attribute,
        preset_type: control.preset_type,
        preset_value_format: control.preset_value_format,
        preset_catalog: presetCatalog(catalogs, control.preset_type, control.presets),
        color_catalog: presetCatalog(catalogs, 'color', control.colors),
        custom: control.custom,
        custom_colors: control.custom_colors,
        values: control.values,
        value_type: control.value_type,
      },
    ];
  });

  return {
    name: block.name,
    controls,
    properties,
    responsive: same(current.responsive, editorResponsive(wp)) ? undefined : current.responsive,
    pseudo_states: current.pseudo_states,
    custom_css: current.custom_css.supported,
    existing: {
      style: block.attributes.style,
      layout: block.attributes.layout,
      align: block.attributes.align,
      presets: Object.fromEntries(
        current.controls.flatMap((control) =>
          control.preset_attribute
            ? [[control.preset_attribute, block.attributes[control.preset_attribute]]]
            : [],
        ),
      ),
    },
    registered_styles: await styles(wp, block.name),
    parent: parent
      ? { name: parent.name, layout: parent.attributes.layout, style: parent.attributes.style }
      : null,
  };
}

function mutate(
  values: JsonObject,
  property: string[],
  value: JsonValue | undefined,
  parents: string[] = [],
): void {
  const [key, ...rest] = property;

  if (!rest.length) {
    if (value === undefined) {
      delete values[key];
    } else {
      values[key] = value;
    }

    return;
  }

  assert(
    values[key] === undefined ||
      v.is(JsonObjectSchema, values[key]) ||
      (Array.isArray(values[key]) && values[key].length === 0),
    'style_parent_not_object',
    { parent_property: [...parents, key], constraint: 'object_parent_required' },
  );
  const child = { ...object(values[key]) };
  mutate(child, rest, value, [...parents, key]);

  if (Object.keys(child).length) {
    values[key] = child;
  } else {
    delete values[key];
  }
}

function presetValues(value: JsonValue | undefined, key = 'slug'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof object(item)[key] === 'string' ? [String(object(item)[key])] : [],
    );
  }

  return Object.values(object(value)).flatMap((item) => presetValues(item, key));
}

function controlFor(current: StyleContext, property: string[]): StyleControl | undefined {
  return current.controls.find((control) => {
    if (property.length === 1 && control.preset_attribute === property[0]) {
      return true;
    }

    if (!control.property.every((key, index) => key === property[index])) {
      return false;
    }

    const suffix = property.slice(control.property.length);

    return !suffix.length || (suffix.length === 1 && control.edges.includes(suffix[0]));
  });
}

export async function styleUpdate(
  wp: WordPress,
  block: Block,
  edit: Extract<Edit, { op: 'update_style' }>,
): Promise<JsonObject> {
  const current = context(wp, block.name);
  assert(
    edit.set.length + edit.unset.length > 0 && edit.set.length + edit.unset.length <= 32,
    'invalid_style_patch',
  );
  const requests = [...edit.set, ...edit.unset.map((property) => ({ property, value: undefined }))];
  const result = v.parse(JsonObjectSchema, JSON.parse(JSON.stringify(block.attributes)));
  const roots = new Set<string>();

  for (const [patchIndex, request] of requests.entries()) {
    const property = request.property;
    const patchKind = patchIndex < edit.set.length ? 'set' : 'unset';
    const index = patchKind === 'set' ? patchIndex : patchIndex - edit.set.length;
    const diagnostics: JsonObject = {
      property,
      field: `${patchKind}.${index}${patchKind === 'set' ? '.property' : ''}`,
      patch_kind: patchKind,
      patch_index: index,
      block_name: block.name,
    };
    const check = (
      condition: JsonValue | StyleControl | undefined,
      code: string,
      details?: JsonObject,
    ) => {
      const valueFailure = [
        'unsupported_style_value',
        'style_preset_unavailable',
        'custom_style_disabled',
        'invalid_custom_css',
      ].includes(code);
      assert(condition, code, {
        ...diagnostics,
        field: valueFailure && patchKind === 'set' ? `set.${index}.value` : diagnostics.field,
        ...details,
      });
    };

    check(
      property.every((key) => !['__proto__', 'prototype', 'constructor'].includes(key)),
      'unsupported_style_property',
    );
    check(
      !requests.some(
        (other) =>
          other !== request && property.every((key, index) => key === other.property[index]),
      ),
      'overlapping_style_properties',
      { constraint: 'nonoverlapping_property_paths' },
    );
    const normalized = [...property];
    const state = normalized[1];

    if (normalized[0] === 'style' && (state?.startsWith('@') || state?.startsWith(':'))) {
      check(current.responsive.editing_enabled === true, 'style_state_editing_disabled');

      if (state.startsWith('@')) {
        check(Object.hasOwn(object(current.responsive.states), state), 'unsupported_style_state', {
          supported_states: Object.keys(object(current.responsive.states)),
        });
        normalized.splice(1, 1);
      }

      if (normalized[1]?.startsWith(':')) {
        check(current.pseudo_states.includes(normalized[1]), 'unsupported_style_state', {
          supported_states: current.pseudo_states,
        });
        normalized.splice(1, 1);
      }
    }

    const css = normalized.join('.') === 'style.css';
    const control = controlFor(current, normalized);
    check(
      css
        ? property.length === 2 && current.custom_css.supported && current.custom_css.can_edit_css
        : control?.enabled,
      'unsupported_style_property',
      {
        control_property: control?.property,
        control_enabled: control?.enabled ?? false,
        constraint: control ? 'native_control_disabled' : 'property_not_in_style_guide',
      },
    );
    safeValue(request.value);

    if (
      normalized[0] === 'align' &&
      request.value !== undefined &&
      Array.isArray(control?.support)
    ) {
      check(control.support.includes(request.value), 'unsupported_style_value', {
        constraint: 'registered_alignment',
      });
    }

    if (normalized.join('.') === 'layout.type' && request.value !== undefined) {
      check(
        ['default', 'constrained', 'flex', 'grid'].includes(String(request.value)),
        'unsupported_style_value',
      );
    }

    if (request.value !== undefined) {
      const backgroundImage = v.strictObject({
        url: v.pipe(v.string(), v.url()),
        id: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
        source: v.optional(v.literal('file')),
        title: v.optional(v.string()),
      });
      const scalar = typeof request.value === 'string' || v.is(v.number(), request.value);
      let accepted = scalar;

      if (control?.value_type === 'background_image') {
        accepted = request.value === 'none' || v.is(backgroundImage, request.value);
      } else if (control?.value_type === 'duotone') {
        accepted =
          request.value === 'unset' ||
          (typeof request.value === 'string' &&
            /^var:preset\|duotone\|[^|]+$/.test(request.value)) ||
          v.is(v.pipe(v.array(v.string()), v.length(2)), request.value);
      }

      check(accepted, 'unsupported_style_value', {
        expected_type: control?.value_type ?? 'string_or_number',
      });
      check(!control?.values || control.values.includes(request.value), 'unsupported_style_value', {
        constraint: 'listed_control_value',
        allowed_values: control?.values,
      });
      const flatPreset = control?.preset_attribute === normalized[0];

      if (control && normalized.length === control.property.length && control.requires_edge) {
        check(false, 'style_side_required', { allowed_edges: control.edges });
      }

      const match =
        typeof request.value === 'string'
          ? request.value.match(/^var:preset\|([^|]+)\|([^|]+)$/)
          : null;

      if (flatPreset || match) {
        check(
          control &&
            (!match || match[1] === control.preset_type) &&
            presetValues(control.presets).includes(match ? match[2] : String(request.value)),
          'style_preset_unavailable',
          { preset_type: control?.preset_type, constraint: 'listed_preset_slug' },
        );
      } else {
        check(
          control?.custom !== false ||
            (control.value_type === 'duotone' && request.value === 'unset'),
          'custom_style_disabled',
        );
      }

      if (
        control?.value_type === 'duotone' &&
        Array.isArray(request.value) &&
        control.custom_colors === false
      ) {
        const colors = presetValues(control.colors, 'color');
        check(
          request.value.every((value) => colors.includes(String(value))),
          'custom_style_disabled',
          { constraint: 'listed_palette_colors' },
        );
      }

      if (css) {
        check(
          typeof request.value === 'string' && !/<\/?\w+/.test(request.value),
          'invalid_custom_css',
        );
      }
    }

    try {
      mutate(
        result,
        property,
        request.value === undefined
          ? undefined
          : nativeMarginInput(wp, block.name, request.value, normalized),
      );
    } catch (error) {
      if (error instanceof BlockworkError) {
        throw new BlockworkError(error.code, { ...diagnostics, ...error.diagnostics });
      }

      throw error;
    }

    roots.add(property[0]);

    // A whole-border preset class can override split inline colors. Preserve
    // its inherited color as a nested token before removing the native slug.
    if (
      request.value !== undefined &&
      normalized[1] === 'border' &&
      normalized.length === 4 &&
      normalized[3] === 'color' &&
      property.length === normalized.length &&
      typeof result.borderColor === 'string'
    ) {
      check(
        !requests.some((other) => other.property[0] === 'borderColor'),
        'competing_style_properties',
      );
      mutate(result, ['style', 'border', 'color'], `var:preset|color|${result.borderColor}`);
      mutate(result, ['borderColor'], undefined);
      roots.add('borderColor');
    }

    // Gutenberg stores base presets outside style. Clear the competing custom
    // value or slug only in base, never the inherited base of a responsive state.
    if (
      request.value !== undefined &&
      control?.preset_attribute &&
      property.length === normalized.length
    ) {
      const competing =
        normalized[0] === control.preset_attribute ? control.property : [control.preset_attribute];
      check(
        !requests.some((other) => competing.every((key, index) => key === other.property[index])),
        'competing_style_properties',
      );
      mutate(result, competing, undefined);
      roots.add(competing[0]);
    }
  }

  const updates: JsonObject = {};

  for (const root of roots) {
    const schema = wp.blocks.getBlockType(block.name)?.attributes?.[root];
    assert(schema, 'unsupported_style_property', { property: [root], block_name: block.name });
    const value = result[root] ?? schema.default;
    assert(value === undefined || schemaAllows(value, schema), 'unsupported_style_value', {
      property: [root],
      block_name: block.name,
      constraint: 'registered_attribute_schema',
    });
    updates[root] = value;
  }

  return updates;
}
