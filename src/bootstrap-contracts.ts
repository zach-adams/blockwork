import * as v from 'valibot';
import {
  JsonSchema,
  MeasureOptionsSchema,
  SiteTargetSchema,
  ViewSchema,
  WidthSchema,
} from './contracts';
import type { JsonObject, Target, Width } from './contracts';
import type { BrowserCapability } from './invocation';
import type { ResourceReceipt } from './resources';

export interface HostTab {
  capabilities: { get(name: 'cdp'): Promise<BrowserCapability> };
  goto(url: string): Promise<void>;
}

export interface BootstrapOptions {
  receipt_directory?: string;
}

export interface HostFailure extends JsonObject {
  ok: false;
  operation?: JsonObject['operation'];
  error: string;
  next: string;
  hint: string;
}

export interface EngineSuccess extends JsonObject {
  ok: true;
}

export interface Connected extends EngineSuccess {
  target: Target;
  workflow: 'attached' | 'background';
}

export interface Discovered extends EngineSuccess {
  new_editor_url: string;
}

export interface Resizable extends EngineSuccess {
  resize?: { window_width: number; target_width: number; canvas_width: number };
}

export interface Placed extends Resizable {
  rendered: boolean;
  canvas_width: number;
  width_source: string;
  clip: Clip;
  clipped: boolean;
  from: number;
  to: number;
  block_height: number;
  next_offset: number | null;
}

export interface Clip extends JsonObject {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size extends JsonObject {
  width: number;
  height: number;
}

export interface Screenshot {
  ok?: never;
  image: Uint8Array;
  image_size: Size;
}

export interface MediaRecord extends JsonObject {
  id: number;
  slug: string;
  source_url: string;
  title: { raw: string };
  caption: { raw: string };
  description: { raw: string };
  alt_text: string;
  media_details: { sizes?: Record<string, { source_url: string }> };
}

export interface MediaResult extends JsonObject {
  ok: boolean;
  error?: string;
  hint?: string;
  receipt?: ResourceReceipt;
  resource_id?: number;
}

export interface InspectedMedia extends MediaResult {
  records: MediaRecord[];
}

export interface StoredMedia extends MediaResult {
  record: MediaRecord;
}

export interface MediaAccess {
  call(request: JsonObject, deadline: number): Promise<MediaResult>;
  busy(): boolean;
  verified: Set<string | undefined>;
  acquire(): boolean;
  release(): void;
}

export const mediaCallers = new WeakMap<WeakKey, MediaAccess>();

export interface BlockworkCaller {
  build: JsonObject;
  readonly receipt_path: string | undefined;
  readonly target: Target | undefined;
  read_receipt(): Promise<JsonObject | undefined>;
  connect(request: JsonObject): Promise<Connected | HostFailure>;
  create(request: unknown): Promise<JsonObject>;
  copy_media(request: unknown): Promise<JsonObject>;
  read(request?: JsonObject): Promise<JsonObject> | HostFailure;
  edit(request?: JsonObject): Promise<JsonObject> | HostFailure;
  measure(request?: JsonObject): Promise<JsonObject>;
  view(request?: unknown): Promise<VisualResult>;
  capture_page(request?: unknown): Promise<VisualResult>;
  revert(): Promise<JsonObject> | HostFailure;
  prepare_resave(): Promise<JsonObject> | HostFailure;
  wait_for_save(): Promise<JsonObject>;
  wait_for_sign_in(site?: { site_url?: string }): Promise<JsonObject>;
  save(request?: JsonObject): Promise<JsonObject>;
  status(deadline?: number): Promise<JsonObject>;
  release(): Promise<JsonObject>;
  call(request: JsonObject): Promise<JsonObject>;
}

export interface RequestIssue extends JsonObject {
  path: string;
  expected: string;
}

const LooseRecordSchema = v.looseObject({});
const RecordSchema = v.custom<v.InferOutput<typeof LooseRecordSchema>>(
  (value) => Object.prototype.toString.call(value) === '[object Object]',
);

// Check own keys before fields, preserving the host's first-error ordering.
function hostObject<TEntries extends v.ObjectEntries>(
  entries: TEntries,
  expected: string,
  allowed: string,
) {
  return v.pipe(
    v.message(RecordSchema, expected),
    v.rawCheck<v.InferOutput<typeof RecordSchema>>(({ dataset, addIssue }) => {
      if (!dataset.typed) {
        return;
      }

      const key = Object.keys(dataset.value).find((key) => !Object.hasOwn(entries, key));

      if (key !== undefined) {
        addIssue({
          message: `absent; use only ${allowed}`,
          path: [
            { type: 'object', origin: 'key', input: dataset.value, key, value: dataset.value[key] },
          ],
        });
      }
    }),
    v.object(entries),
  );
}

export const MediaUrlSchema = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.check((value) => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol)),
);
export const CopyUrlEntriesSchema = v.pipe(
  v.array(v.tuple([MediaUrlSchema, MediaUrlSchema])),
  v.maxLength(2000),
);
const selectorExpected = 'a CSS selector string of 1 to 500 characters';
const SelectorSchema = v.pipe(
  v.string(selectorExpected),
  v.minLength(1, selectorExpected),
  v.maxLength(500, selectorExpected),
);
const widthExpected =
  'a distinct desktop, tablet, mobile, or whole number of CSS pixels from 320 to 2560';
const WidthsSchema = v.pipe(
  v.array(v.unknown(), 'a list of one to six widths'),
  v.minLength(1, 'a list of one to six widths'),
  v.maxLength(6, 'a list of one to six widths'),
  v.checkItems(
    (value, index, values) => v.is(WidthSchema, value) && values.indexOf(value) === index,
    widthExpected,
  ),
  v.array(WidthSchema),
);
const pseudoExpected = 'a distinct hover, focus, focus-visible, active, or focus-within';
const PseudoSchema = v.picklist(['hover', 'focus', 'focus-visible', 'active', 'focus-within']);
const PseudosSchema = v.pipe(
  v.array(v.unknown(), 'a list of 1 to 5 distinct pseudo-classes'),
  v.minLength(1, 'a list of 1 to 5 distinct pseudo-classes'),
  v.maxLength(5, 'a list of 1 to 5 distinct pseudo-classes'),
  v.checkItems(
    (value, index, values) => v.is(PseudoSchema, value) && values.indexOf(value) === index,
    pseudoExpected,
  ),
  v.array(PseudoSchema),
);
const CaptureMeasureSchema = hostObject(
  {
    selectors: v.pipe(
      v.array(v.unknown(), 'a list of 1 to 20 CSS selectors'),
      v.minLength(1, 'a list of 1 to 20 CSS selectors'),
      v.maxLength(20, 'a list of 1 to 20 CSS selectors'),
      v.array(SelectorSchema),
    ),
    properties: v.optional(
      v.pipe(
        v.array(v.unknown(), 'a list of up to 32 CSS property names'),
        v.maxLength(32, 'a list of up to 32 CSS property names'),
        v.array(
          v.message(
            MeasureOptionsSchema.entries.properties.wrapped.item,
            'a lowercase CSS property name, such as margin-top, min_height, or --brand-gap',
          ),
        ),
      ),
    ),
  },
  'an object with selectors and optional properties',
  'selectors and properties',
);

export const CaptureSchema = hostObject(
  {
    keep_notices: v.optional(v.boolean('true or false')),
    url: v.optional(
      v.message(MediaUrlSchema, 'an absolute http or https URL of up to 2048 characters'),
    ),
    widths: v.optional(WidthsSchema, ['desktop', 'mobile']),
    selector: v.optional(SelectorSchema),
    states: v.optional(
      hostObject(
        { selector: SelectorSchema, pseudo: PseudosSchema },
        'an object with selector and pseudo',
        'selector and pseudo',
      ),
    ),
    measure: v.optional(CaptureMeasureSchema),
  },
  'an object with url, widths, selector, states, measure, and keep_notices',
  'url, widths, selector, states, measure, and keep_notices',
);

export type CaptureMeasure = v.InferOutput<typeof CaptureMeasureSchema>;

// target, request_id, and operation are forwarded but the page validates them.
export const HostMeasureSchema = v.pipe(
  v.strictObject({
    blocks: MeasureOptionsSchema.entries.blocks,
    client_id: v.optional(ViewSchema.entries.client_id),
    properties: MeasureOptionsSchema.entries.properties,
    width: WidthSchema,
    target: v.optional(JsonSchema),
    request_id: v.optional(JsonSchema),
    operation: v.optional(JsonSchema),
  }),
  v.check(({ blocks, client_id }) => (blocks === undefined) !== (client_id === undefined)),
);
export const HostViewSchema = v.strictObject({
  client_id: ViewSchema.entries.client_id,
  widths: v.optional(WidthsSchema, ['desktop']),
});
export const CreateSchema = hostObject(
  {
    target: hostObject(
      { site_url: v.optional(JsonSchema), user_id: v.optional(JsonSchema) },
      'an object with site_url and user_id',
      'site_url and user_id',
    ),
    post_type: JsonSchema,
  },
  'an object with target and post_type',
  'target and post_type',
);

const CopyTargetSchema = v.pipe(
  RecordSchema,
  v.check((value) => Object.keys(value).sort().join() === 'site_url,user_id'),
  v.object({
    ...SiteTargetSchema.entries,
    site_url: v.pipe(
      MediaUrlSchema,
      v.check((value) => !new URL(value).username && !new URL(value).password),
    ),
  }),
);
const CopyFields = {
  source: v.custom<BlockworkCaller>(
    (value) => v.is(RecordSchema, value) && mediaCallers.has(value),
    'a caller from this bootstrap module',
  ),
  source_target: v.message(
    CopyTargetSchema,
    'an exact http or https site_url and positive user_id',
  ),
  target: v.message(CopyTargetSchema, 'an exact http or https site_url and positive user_id'),
  ids: v.message(
    v.pipe(
      v.array(SiteTargetSchema.entries.user_id),
      v.minLength(1),
      v.maxLength(50),
      v.check((ids) => new Set(ids).size === ids.length),
    ),
    '1 to 50 distinct positive attachment IDs',
  ),
  copy_id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)),
  deadline_ms: v.optional(v.pipe(v.number(), v.integer(), v.minValue(45000), v.maxValue(55000))),
  parent_id: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
};
export const CopySchema = v.pipe(
  v.message(
    RecordSchema,
    'source, source_target, target, ids, copy_id, and optional deadline_ms and parent_id only',
  ),
  v.check(
    (value) => Object.keys(value).every((key) => Object.hasOwn(CopyFields, key)),
    'source, source_target, target, ids, copy_id, and optional deadline_ms and parent_id only',
  ),
  v.object(CopyFields),
);

export type CopyRequest = v.InferOutput<typeof CopySchema>;

const missingExpected = {
  'states.selector': selectorExpected,
  'states.pseudo': 'a list of 1 to 5 distinct pseudo-classes',
  'measure.selectors': 'a list of 1 to 20 CSS selectors',
  target: 'an object with site_url and user_id',
  post_type: 'a required REST-visible editor type such as page',
};
const copyExpected = {
  source: 'a caller from this bootstrap module',
  source_target: 'an exact http or https site_url and positive user_id',
  target: 'an exact http or https site_url and positive user_id',
  ids: '1 to 50 distinct positive attachment IDs',
  copy_id:
    '1 to 80 lowercase letters, digits, underscores, or hyphens, starting with a letter or digit',
  deadline_ms: 'an integer from 45000 to 55000 milliseconds',
  parent_id: 'a nonnegative target post ID',
};

export function requestIssue(issue: v.BaseIssue<unknown>, copy = false): RequestIssue {
  const path = issue.path?.map((item) => String(item.key)).join('.') ?? '';

  if (copy) {
    const field = path.split('.')[0];

    return {
      path: field,
      expected: v.is(v.keyof(v.object(CopyFields)), field) ? copyExpected[field] : issue.message,
    };
  }

  const missing = Object.entries(missingExpected).find(([name]) => name === path)?.[1];

  if (issue.type === 'object' && issue.input === undefined && missing) {
    return { path, expected: missing };
  }

  return { path, expected: issue.message };
}

const finite = v.pipe(v.number(), v.finite());
const nonnegative = v.pipe(finite, v.minValue(0));
const positive = v.pipe(finite, v.minValue(Number.MIN_VALUE));
export const PageSizeSchema = v.array(positive);
export const PixelRatioSchema = positive;
export const EvaluationSchema = v.object({
  result: v.optional(v.object({ value: v.optional(v.unknown()) })),
  exceptionDetails: v.optional(v.unknown()),
});
export const MetricsSchema = v.object({
  cssVisualViewport: v.optional(
    v.object({ zoom: v.optional(v.unknown()), scale: v.optional(v.unknown()) }),
  ),
});
export const ScreenshotSchema = v.object({ data: v.optional(v.string()) });
export const DomDocumentSchema = v.object({ root: v.object({ nodeId: v.number() }) });
export const DomMatchSchema = v.object({ nodeId: v.optional(v.number()) });
export const IdentitySchema = v.object({
  post_id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  post_type: v.string(),
});
export const SignInSchema = v.object({ reauthorization_required: v.optional(v.unknown()) });
const StyleValueSchema = v.pipe(v.string(), v.maxLength(200));
const ElementSchema = v.union([
  v.strictObject({ selector: v.string(), found: v.literal(false) }),
  v.strictObject({
    selector: v.string(),
    found: v.literal(true),
    tag: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    rect: v.strictObject({ x: finite, y: finite, width: nonnegative, height: nonnegative }),
    styles: v.pipe(RecordSchema, v.record(v.string(), StyleValueSchema)),
  }),
]);
const MeasurementsSchema = v.looseObject({
  width: positive,
  height: positive,
  scroll_x: finite,
  scroll_y: finite,
  scroll_width: positive,
  selector_offset: nonnegative,
  finished_animations: v.pipe(v.number(), v.integer(), v.minValue(0)),
  hidden_notices: v.pipe(v.number(), v.integer(), v.minValue(0)),
  elements: v.array(ElementSchema),
});

export const PageSchema = v.looseObject({ ...MeasurementsSchema.entries, ok: v.literal(true) });

export type Page = v.InferOutput<typeof PageSchema>;

export type Measurements = v.InferOutput<typeof MeasurementsSchema>;

export function measuredPage(
  value: unknown,
  selectors: string[],
  properties: string[],
): value is Measurements {
  const schema = v.pipe(
    MeasurementsSchema,
    v.check((page) => page.selector_offset <= page.height / 2),
    v.check((page) => page.elements.length === selectors.length),
    v.check((page) =>
      page.elements.every(
        (element, index) =>
          element.selector === selectors[index] &&
          (!element.found ||
            (Object.keys(element.styles).length === new Set(properties).size &&
              properties.every((property) => v.is(StyleValueSchema, element.styles[property])))),
      ),
    ),
  );

  return v.is(schema, value);
}

export const pageWidths: Record<Exclude<Width, number>, number> = {
  desktop: 1440,
  tablet: 768,
  mobile: 390,
};

export interface VisualShot {
  width: Width;
  image?: Uint8Array;
  image_size?: Size;
  clipped?: boolean;
  from?: number;
  to?: number;
  block_height?: number;
  rendered?: boolean;
  canvas_width?: number;
  width_source?: string;
  viewport_width?: number;
  scroll_y?: number;
  scroll_width?: number;
  finished_animations?: number;
  hidden_notices?: number;
  selector_offset?: number;
  elements?: Page['elements'];
}

export interface VisualResult {
  ok: boolean;
  shots?: VisualShot[];
  state_cleanup?: HostFailure;
  notice_cleanup?: HostFailure;
  tab_resize?: HostFailure;
}
