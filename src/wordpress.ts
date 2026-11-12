import type { JsonObject, JsonValue, ReleaseRecord, Session, User } from './contracts';
import type { ResourceSession } from './resources';

export interface Block {
  name: string;
  clientId: string;
  attributes: JsonObject;
  innerBlocks?: Block[];
  isValid?: boolean;
  originalContent?: string;
}

export interface Attribute extends JsonObject {
  type?: string | string[];
  enum?: JsonValue[];
  default?: JsonValue;
  source?: string;
  selector?: string;
  attribute?: string;
  role?: string;
  query?: Record<string, Attribute>;
  items?: Attribute;
  properties?: Record<string, Attribute>;
  patternProperties?: Record<string, Attribute>;
  required?: string[] | boolean;
  additionalProperties?: boolean | Attribute;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  oneOf?: Attribute[];
  anyOf?: Attribute[];
  readonly?: boolean;
  context?: string[];
  format?: string;
}

export interface Registration {
  name: string;
  title?: string;
  description?: string;
  attributes?: Record<string, Attribute>;
  parent?: string[];
  ancestor?: string[];
  allowedBlocks?: string[];
  providesContext?: Record<string, string>;
  usesContext?: string[];
  supports?: JsonObject;
  deprecated?: Registration[];
  save?: (...args: never[]) => object | null;
}

export interface Variation {
  name: string;
  title?: string;
  attributes?: JsonObject;
  innerBlocks?: JsonValue[];
}

export interface BlockStyle extends JsonObject {
  name: string;
  label: string;
  isDefault?: boolean;
}

interface PostLock {
  isLocked: boolean;
  activePostLock: string;
}

interface Selection extends JsonObject {
  clientId?: string;
  attributeKey?: string;
  offset?: number;
}

export interface EditedEntityRecord {
  blocks?: Block[];
  content: EntityContent;
  meta?: JsonObject;
  date?: string | null;
  modified?: string | null;
}

export type EntityContent = string | { raw: string } | ((record: EditedEntityRecord) => string);

export interface PairedEntityEdit {
  blocks: Block[];
  content: EntityContent;
  meta?: JsonObject;
  selection: JsonObject;
}

interface Editor {
  getCurrentPost(): JsonObject;
  getCurrentPostId(): number | string;
  getCurrentPostType(): string;
  getEditedPostAttribute(name: string): JsonValue | undefined;
  getEditedPostContent(): string;
  getEditorBlocks?(): Block[];
  getEditorMode?(): string;
  isEditedPostDirty(): boolean;
  isSavingPost(): boolean;
  isAutosavingPost?(): boolean;
  isPostLocked(): boolean;
  isPostLockTakeover(): boolean;
  getActivePostLock(): string | undefined;
  getEditorSettings(): {
    postLockUtils?: { ajaxUrl: string; unlockNonce: string };
    template?: JsonValue;
  };
  isEditedPostSaveable(): boolean;
  isPostSavingLocked(): boolean;
  isPostAutosavingLocked?(): boolean;
  didPostSaveRequestSucceed(): boolean;
  getDeviceType?(): string;
}

export interface EditorStyleSettings extends JsonObject {
  __experimentalBlockBindingsSupportedAttributes?: Record<string, string[]>;
  __experimentalFeatures?: JsonObject;
  canEditCSS?: boolean;
  blockStatesEditingEnabled?: boolean;
  responsiveEditingEnabled?: boolean;
}

export interface OfferedPattern {
  name: string;
  title: string;
  content: string;
  categories?: JsonValue;
  syncStatus?: string;
  blocks: Block[];
}

export interface BlockEditor {
  __experimentalGetAllowedPatterns?(rootClientId?: string): OfferedPattern[];
  getBlocks(rootClientId?: string): Block[];
  getSettings?(): EditorStyleSettings;
  getSelectionStart?(): Selection;
  getSelectionEnd?(): Selection;
  getSelectedBlockClientIds?(): string[];
  getSelectedBlocksInitialCaretPosition?(): number | null | undefined;
  canEditBlock(clientId: string): boolean;
  getBlockEditingMode(clientId: string): string;
  __unstableGetTemporarilyEditingAsBlocks?(): string | null | undefined;
  getBlockListSettings?(
    clientId: string,
  ): { allowedBlocks?: string[]; templateLock?: string | false } | undefined;
  getTemplateLock?(clientId?: string): string | false | undefined;
  canInsertBlockType?(name: string, parent?: string): boolean;
  canInsertBlocks?(clientIds: string[], parent?: string): boolean;
  canRemoveBlocks?(ids: string[]): boolean;
  canMoveBlock?(id: string): boolean;
  getInserterItems?(parent?: string): Array<{ name: string; title?: string; isDisabled?: boolean }>;
}

interface EditorActions {
  editPost(values: JsonObject): void | Promise<void>;
  lockPostAutosaving(key: string): void;
  unlockPostAutosaving(key: string): void;
  lockPostSaving?(key: string): void;
  unlockPostSaving?(key: string): void;
  updatePostLock(lock: PostLock): void;
  savePost(): Promise<void>;
  setDeviceType?(device: string): void;
}

export interface BlockActions {
  __unstableSetTemporarilyEditingAsBlocks?(clientId: string): void | Promise<void>;
  selectBlock?(clientId: string, initialPosition: null): void;
  resetSelection?(
    start: Selection,
    end: Selection,
    initialPosition: number | null | undefined,
  ): void;
  updateBlockAttributes(clientId: string, attributes: JsonObject): void | Promise<void>;
  updateBlockAttributes(
    clientIds: string[],
    attributes: Record<string, JsonObject>,
    uniqueByBlock: true,
  ): void;
  insertBlocks(
    blocks: Block[],
    index: number,
    parent?: string,
    updateSelection?: boolean,
  ): void | Promise<void>;
  replaceBlocks(
    ids: string[],
    blocks: Block[],
    indexToSelect?: number | null,
  ): void | Promise<void>;
  moveBlocksToPosition(
    ids: string[],
    fromParent?: string,
    toParent?: string,
    index?: number,
  ): void | Promise<void>;
  removeBlocks(ids: string[], selectPrevious?: boolean): void | Promise<void>;
  resetBlocks(blocks: Block[]): void | Promise<void>;
  replaceInnerBlocks?(
    rootClientId: string,
    blocks: Block[],
    updateSelection: boolean,
  ): void | Promise<void>;
}

interface HeartbeatData {
  'wp-refresh-post-lock'?: {
    lock_error?: JsonValue;
    new_lock?: string;
    post_id?: number;
    lock?: string;
  };
}

export interface ApiRequest {
  path: string;
  cache: 'no-store';
  signal: AbortSignal;
  method?: 'GET' | 'OPTIONS' | 'POST' | 'DELETE';
  data?: JsonObject;
  body?: FormData;
  // false returns the Response as it is, and throws it when it is an error.
  parse?: false;
}

// Describe only the native APIs this prototype calls. WordPress owns their implementation.
export interface ParsedPatternBlock {
  blockName: string | null;
  attrs: JsonObject;
  innerBlocks: ParsedPatternBlock[];
  innerHTML: string;
  innerContent: Array<string | null>;
}

export interface RichTextReplacement {
  type: string;
  attributes?: Record<string, string>;
  innerHTML?: string;
}

export interface RichTextValue {
  text: string;
  formats: Array<JsonObject[] | undefined>;
  replacements: Array<RichTextReplacement | undefined>;
}

export interface FootnoteRichText {
  create(input: { html?: string; text?: string }): RichTextValue;
  toHTMLString(input: { value: RichTextValue }): string;
}

export interface WordPress {
  richText?: FootnoteRichText;
  blockSerializationDefaultParser?: { parse(content: string): ParsedPatternBlock[] };
  element?: { flushSync(callback: () => void): void };
  blockEditor?: {
    __experimentalResponsiveBlockControl?: () => object;
    getCustomValueFromPreset?(value: string, sizes: JsonObject[]): string | number | undefined;
  };
  htmlEntities: { decodeEntities(html: string): string };
  blocks: {
    getBlockBindingsSource?(
      name: string,
    ):
      | {
          getValues?(args: {
            select: WordPress['data']['select'];
            clientId: string;
            context: JsonObject;
            bindings: JsonObject;
          }): JsonObject;
          canUserEditValue?(args: {
            select: WordPress['data']['select'];
            context: JsonObject;
            args: JsonObject;
          }): boolean;
        }
      | undefined;
    getBlockType(name: string): Registration | undefined;
    hasBlockSupport(name: string, feature: string, defaultValue?: boolean): boolean;
    getBlockTypes(): Registration[];
    isUnmodifiedDefaultBlock?(block: Block): boolean;
    getBlockVariations?(name: string, scope: string): Variation[];
    createBlock(name: string, attributes?: JsonObject, innerBlocks?: Block[]): Block;
    createBlocksFromInnerBlocksTemplate(template: JsonValue[]): Block[];
    synchronizeBlocksWithTemplate(blocks: Block[], template: JsonValue[]): Block[];
    serialize(blocks: Block[]): string;
    __unstableSerializeAndClean?(blocks: Block[]): string;
    parse(content: string): Block[];
    cloneBlock(block: Block, attributes: JsonObject, innerBlocks: Block[]): Block;
  };
  data: {
    resolveSelect?(store: 'core'): {
      getBlockPatterns?(): Promise<JsonValue>;
      getCurrentTheme?(): Promise<JsonValue>;
      canUser?(
        action: 'read' | 'update' | 'create',
        resource: { kind: 'root' | 'postType'; name: string; id?: number },
      ): Promise<boolean | undefined>;
      getEntityRecord?(kind: 'root', name: 'site'): Promise<JsonValue | undefined>;
      getEditedEntityRecord?(
        kind: 'postType',
        name: string,
        id: number | string,
      ): Promise<EditedEntityRecord | false | undefined>;
      getTaxonomies?(query: JsonObject): Promise<JsonValue | undefined>;
      getEntityRecords?(
        kind: 'postType' | 'taxonomy' | 'root',
        name: string,
        query: JsonObject,
      ): Promise<JsonValue | undefined>;
    };
    select(store: 'core/editor'): Editor;
    select(
      store: 'core/edit-post',
    ): { hasMetaBoxes(): boolean; isSavingMetaBoxes(): boolean } | undefined;
    select(store: 'core'): {
      getEditedEntityRecord?(
        kind: 'postType',
        name: string,
        id: number | string,
      ): EditedEntityRecord | false | undefined;
      __experimentalGetDirtyEntityRecords?(): unknown[];
      getEntityRecordNonTransientEdits(kind: 'postType', name: string, id: number | string): object;
      getLastEntitySaveError?(
        kind: 'postType',
        name: string,
        id: number | string,
      ): object | undefined;
      getEntityRecords?(
        kind: 'postType' | 'root',
        name: string,
        query: JsonObject,
      ): JsonValue | undefined;
      getEntityRecordsTotalItems?(
        kind: 'root',
        name: 'comment',
        query: JsonObject,
      ): number | undefined;
      getEntityRecordsTotalPages?(
        kind: 'root',
        name: 'comment',
        query: JsonObject,
      ): number | undefined;
      hasFinishedResolution?(selector: string, args: JsonValue[]): boolean;
      hasResolvingSelectors(): boolean;
    };
    select(store: 'core/blocks'): { getBlockStyles?(name: string): BlockStyle[] };
    select(store: 'core/block-editor'): BlockEditor;
    dispatch(store: 'core/editor'): EditorActions;
    dispatch(store: 'core'): {
      editEntityRecord?(
        kind: 'postType',
        name: string,
        id: number | string,
        edits: JsonObject | PairedEntityEdit,
        options: { undoIgnore?: true; isCached?: false },
      ): void;
    };
    dispatch(store: 'core/block-editor'): BlockActions;
    dispatch(store: 'core/preferences'): {
      setPersistenceLayer(layer: {
        get(): Promise<JsonObject>;
        set(preferences: JsonObject): void;
      }): Promise<void>;
    };
    subscribe(callback: () => void): () => void;
  };
  hooks: {
    filters?: Record<string, { handlers: Array<{ namespace: string }> }>;
    addAction(
      event: string,
      namespace: string,
      callback: (data: HeartbeatData) => void,
      priority?: number,
    ): void;
    removeAction(event: string, namespace: string): void;
  };
  heartbeat: {
    enqueue(key: string, data: { post_id: number; lock?: string }): void;
    dequeue(key: string): void;
    connectNow(): void;
  };
  apiFetch(options: ApiRequest & { parse: false }): Promise<Response>;
  apiFetch(options: ApiRequest): Promise<JsonValue>;
  url?: { addQueryArgs(url: string, args: JsonObject): string };
}

declare global {
  interface Window {
    wp?: WordPress;
    _wpMetaBoxUrl?: string;
    __blockwork_editor?: Session;
    __blockwork_resources_v1?: ResourceSession;
    __blockwork_release?: ReleaseRecord;
    __blockwork_identity?: { site_url: string; user: User };
  }
}
