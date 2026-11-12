import * as v from 'valibot';
import { ApiErrorSchema, JsonObjectSchema } from './contracts';
import type { BlockSummary, JsonObject, JsonValue } from './contracts';
import { same } from './values';
import { uploadLimitHint } from './uploads';

// cause keeps the native error a refusal replaced, for development `debug`.
export class BlockworkError extends Error {
  constructor(
    readonly code: string,
    readonly diagnostics?: JsonObject,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export function failureCode(
  code: string | undefined,
  access: AccessFailure | undefined,
  invalidResponse: boolean,
): string {
  if (access) {
    return access.error;
  }

  if (code) {
    return code;
  }

  return invalidResponse ? 'invalid_native_response' : 'operation_failed';
}

interface AccessFailure {
  error: 'reauthorization_required' | 'permission_denied';
  diagnostics?: JsonObject;
}

// WordPress answers 401 to a request without a valid session and 403 to a
// signed-in user who lacks the capability (rest_authorization_required_code).
// An expired nonce is the exception at 403. Without a status, only WordPress's
// own refusal codes count.
export function accessFailure(cause: unknown): AccessFailure | undefined {
  const parsed = v.safeParse(ApiErrorSchema, cause);

  if (cause instanceof BlockworkError || !parsed.success) {
    return undefined;
  }

  const { code = '', data } = parsed.output;

  if (['rest_cookie_invalid_nonce', 'rest_not_logged_in'].includes(code) || data?.status === 401) {
    return { error: 'reauthorization_required' };
  }

  if (data?.status === 403 || (!data?.status && /^rest_(forbidden|cannot_)/.test(code))) {
    return { error: 'permission_denied', diagnostics: wordpressError(cause) };
  }

  return undefined;
}

// WordPress's error code and status, never its message, as evidence of why a
// native request failed.
export function wordpressError(cause: unknown): JsonObject | undefined {
  const parsed = v.safeParse(ApiErrorSchema, cause);

  if (!parsed.success || (!parsed.output.code && !parsed.output.data?.status)) {
    return undefined;
  }

  return {
    wordpress_error: parsed.output.code ? diagnosticKey(parsed.output.code) : undefined,
    status: parsed.output.data?.status,
  };
}

// Keys a request supplies can carry content, such as a media_map URL used as a
// record key, so diagnostics show only identifier-like keys.
export function diagnosticKey(key: string): string {
  return /^[A-Za-z0-9_$@-]{1,64}$/.test(key) ? key : '<key>';
}

// Names agents carry over from Gutenberg's own API.
const fieldCorrections = new Map([
  ['attribute', 'attributes'],
  ['attrs', 'attributes'],
  ['innerBlocks', 'inner_blocks'],
  ['clientId', 'client_id'],
  ['parentClientId', 'parent_client_id'],
]);

function issuePath(issue: v.BaseIssue<unknown>): string {
  return (issue.path ?? [])
    .map(({ key }) => diagnosticKey(String(key)))
    .join('.')
    .slice(0, 160);
}

export function validationIssues(
  issues: Array<v.BaseIssue<unknown>>,
  source = 'request',
  requestCode = 'invalid_request',
) {
  return issues.slice(0, 12).map((issue) => {
    const path = issuePath(issue);
    const field = path.split('.').at(-1);
    const missing = issue.input === undefined && issue.expected === JSON.stringify(field);
    const expected = missing ? 'required field' : (issue.expected?.slice(0, 300) ?? 'valid value');

    if (source === 'native_response') {
      return {
        path,
        expected,
        constraint: issue.type,
        hint: 'This path belongs to the native response. Preserve the result and receipt, follow next to verify any possible mutation, and inspect that exact record. Do not rewrite the request or server data to bypass this schema failure.',
      };
    }

    const tokenSources = new Map([
      [
        'edit_token',
        'inspect_media.record.edit_token or inspect_terms.record.edit_token for this exact resource',
      ],
      ['reference_token', 'inspect_entity.reference_token for the exact shared entity'],
      ['media_token', 'inspect_media.record.edit_token for the exact attachment'],
    ]);
    const tokenSource = tokenSources.get(field ?? '');

    if (tokenSource && expected !== 'never') {
      return {
        path,
        expected: '64 lowercase hexadecimal characters from the matching successful inspection',
        hint: `Copy ${tokenSource}. Supply it at ${path}; do not copy a token from the response root, invent one, or omit it.`,
      };
    }

    if (
      requestCode === 'invalid_resource_request' &&
      path === 'upload.base64' &&
      issue.type === 'max_length'
    ) {
      return { path, expected, constraint: issue.type, hint: uploadLimitHint };
    }

    if (field === 'receipt') {
      return {
        path,
        expected: 'complete stored receipt object',
        hint: 'Use the complete receipt the caller stored for this save or resource write. Do not construct a receipt from individual fields.',
      };
    }

    if (missing) {
      return {
        path,
        expected,
        constraint: 'required_key',
        hint: `The required key at ${path} is absent. Add it using the operation reference's exact type and shape; do not supply the field name as its value.`,
      };
    }

    if (field === 'edge' && /^edits\.\d+\.set\.\d+\.edge$/.test(path)) {
      return {
        path,
        expected: 'never',
        constraint: 'property_path_edge',
        hint: 'Append the side to the property array, for example ["style","spacing","margin","top"]. Remove the separate edge key. Copy the control property and allowed edges from the matching style guide.',
      };
    }

    if (['invalid_connection', 'invalid_read'].includes(requestCode) && path === 'blocks') {
      return {
        path,
        expected,
        constraint: issue.type,
        hint: 'Use one selector shape: "roots", "all", {client_id, depth?, limit?, markup?, media?}, {depth, limit?}, or {search and/or name, client_id?, attributes?, limit?}. Limits are whole numbers from 1 and depth from 0; Blockwork clamps them to 50 and 8.',
      };
    }

    if (/^style_guides\.\d+$/.test(path)) {
      return {
        path,
        expected: '{name} or {client_id}, with optional properties',
        constraint: issue.type,
        hint: 'Each entry is {name: "core/group"} or {client_id}, plus optional properties: an array of property paths, each an array of keys, such as [["layout"], ["style","spacing"]]. A dotted string such as "style.spacing" is not a path.',
      };
    }

    if (issue.message === 'Provide at most one of id, ids, or slugs') {
      return {
        path: 'id',
        expected: issue.message,
        hint: 'Use id for one full attachment record, ids for up to 50 full records in one request, slugs for exact native slug matches, or none of them with search, page, and limit for compact summaries.',
      };
    }

    if (issue.message === 'unsaved_preview requires workflow attached') {
      return {
        path: 'unsaved_preview',
        expected: 'false for background; boolean for attached',
        hint: 'Use workflow attached with unsaved_preview true, or omit unsaved_preview for background.',
      };
    }

    if (issue.message === 'Provide blocks or client_id') {
      return {
        path,
        expected: issue.message,
        hint: 'Use blocks with 1 to 20 live client IDs, or client_id with one, not both.',
      };
    }

    if (
      issue.message === 'Provide exactly one of path or client_id' ||
      issue.message === 'Provide parent or parent_client_id, not both'
    ) {
      return {
        path,
        expected: issue.message,
        hint: 'Use client_id from read or an earlier edit result for an existing block. For destinations, omit both selectors for the root or provide exactly one parent selector.',
      };
    }

    const correction = issue.expected === 'never' ? fieldCorrections.get(field ?? '') : undefined;

    if (correction) {
      return { path, expected, constraint: issue.type, hint: `Use ${correction}, not ${field}.` };
    }

    return {
      path,
      expected,
      constraint: issue.type,
      hint:
        issue.expected === 'never'
          ? 'Remove this unexpected key. Check the operation example for its correct placement.'
          : `Use ${issue.expected?.slice(0, 300) ?? 'a valid value'} at this path.`,
    };
  });
}

export function invalidRequest(code: string, issues: Array<v.BaseIssue<unknown>>) {
  const corrections = issues.flatMap((issue) => {
    const field = String(issue.path?.at(-1)?.key);
    const correction = issue.expected === 'never' ? fieldCorrections.get(field) : undefined;

    return correction ? [`${field} is ${correction}.`] : [];
  });

  return {
    ok: false,
    error: code,
    persistence: 'not_attempted',
    editor_result: 'not_attempted',
    validation_source: 'request',
    diagnostics: corrections.length ? { field_corrections: corrections.slice(0, 12) } : undefined,
    issues: validationIssues(issues, 'request', code),
    issues_truncated: issues.length > 12,
    next: 'correct_request',
  };
}

// Hints are authored here, never copied from server messages or input values.
export function errorHint(code: string, operation: string, diagnostics?: JsonObject): string {
  if (code === 'unsupported_structural_edit') {
    switch (diagnostics?.constraint) {
      case 'footnote_request_incomplete':
        return 'Read the blocks and settings. Submit paragraph content updates, one bare root Footnotes insert only if the document has none, and the complete final settings.meta.footnotes list as a JSON string. Put everything else in a separate request. References outside paragraphs are unsupported; preserve the draft and report that limit.';
      case 'footnote_body_order':
        return 'Read the blocks and settings. Supply settings.meta.footnotes as a JSON string containing an array of the complete final bodies in reference order, repeating a body for each repeated ID.';
      case 'footnote_reference_number':
        return 'Read the reference at diagnostics.target_path and add a content update for that paragraph in the same request with diagnostics.expected_number. A reference outside a paragraph cannot be renumbered this way; preserve the draft and report that limit.';
      case 'footnote_list_missing':
        return 'Read the document and include one bare root Footnotes block insert with the paragraph updates and complete final settings.meta.footnotes list.';
    }
  }

  if (
    code === 'native_requested_value_changed' &&
    diagnostics?.stage === 'query_normalization_preflight'
  ) {
    return 'Core would replace the reported Query properties. No edit started when editor_result is not_applied. Inspect the Query attributes and its inherited context. Use the reported native_values in a new request only when they preserve the intended query. An independent Query can use a positive perPage and excludeCurrent:null; do not change inherit or other requested behavior without authorization. If the native values conflict with the requested result, preserve the draft and report that result as unsupported.';
  }

  if (code === 'initial_serialization_changed') {
    return 'This document\'s stored markup is older than what Gutenberg writes now, so Blockwork cannot prove an edit would leave the rest of it alone. No edit was applied. The user re-saving it fixes this. Follow the recovery reference\'s "Older stored markup" section, which opens the editor for them with Save ready and finishes the request once they click it. That save rewrites blocks the request did not mention, so it needs their check first.';
  }

  if (Array.isArray(diagnostics?.field_corrections)) {
    return `${diagnostics.field_corrections.join(' ')} ${repairHint(code, operation)}`;
  }

  if (
    code === 'unsupported_attribute' &&
    diagnostics?.constraint === 'meta_requires_document_settings'
  ) {
    return 'This block attribute stores its value in document metadata. Read attribute_guide for its meta_key, then read settings: true for the writable REST contract. Submit only authorized writable settings.meta keys. If that key is absent from the settings guide, preserve it and report the unsupported write.';
  }

  if (
    code === 'unsupported_structural_edit' &&
    [
      'footnote_body_required',
      'footnote_body_list',
      'footnote_list_required',
      'footnote_complete_body_order',
    ].includes(String(diagnostics?.constraint))
  ) {
    return 'Read the source paragraph markup and settings, then read all destination blocks and settings. Supply the complete final settings.meta.footnotes JSON list in reference order with the copied markup, retaining destination bodies. Insert a root Footnotes block in the same request if needed. Markup alone cannot supply a missing body. If the source body is unavailable, preserve the draft and report that limit.';
  }

  const repair = Array.isArray(diagnostics?.use_instead)
    ? 'This block has no attribute by that name. Its block support stores the setting at the style path in diagnostics.use_instead; set it there with update or update_style.'
    : repairHint(code, operation);

  if (diagnostics?.path_space !== 'planned') {
    return repair;
  }

  const location =
    diagnostics.target_origin === 'inserted_block'
      ? 'The target is a block this edit inserts. Read style_guides or attribute_guide by block name to correct it.'
      : 'target_path is the planned path after preceding edits in this request; live_path is its current path.';

  return `${location} ${repair}`;
}

function repairHint(code: string, operation: string): string {
  if (operation === 'download_media') {
    if (code === 'reauthorization_required') {
      return 'The source tab is not signed in or its session expired. Ask the user to sign in to the source admin tab, then open the attachment URL there to confirm access and resume the same copy_id. This item was not uploaded.';
    }

    if (code === 'rest_post_invalid_id') {
      return 'The source attachment record is missing. Inspect that attachment ID on the source site and correct the requested IDs, then resume the same copy_id. This item was not uploaded.';
    }
  }

  switch (code) {
    case 'invalid_connection':
    case 'invalid_read':
      return (
        (operation === 'connect'
          ? 'connect requires target with site_url, post_id, and post_type, plus workflow. Omit user_id; connect reads it from the signed-in account. '
          : '') +
        'blocks accepts "roots", "all", {client_id, depth?, limit?, markup?, media?}, {depth, limit?}, or {search and/or name, client_id?, attributes?, limit?}. ' +
        'attribute_guide takes {name} or {client_id}; style_guides takes 1 to 16 entries of {client_id} or {name}, each with optional properties, a list of key arrays such as [["style","spacing"]]. ' +
        'insertion takes {parent_client_id?}; patterns and settings are booleans. unsaved_preview applies to attached connect only.'
      );
    case 'invalid_edit':
      return (
        'edit takes edits, post, settings, binding_writes, media_bindings, scope, and measure. ' +
        'Address existing blocks by client_id and destinations by parent_client_id. insert and replace take block or markup. ' +
        'update merges attributes and accepts unset paths. Supply at most 32 edits after markup expansion.'
      );
    case 'invalid_request':
      return `Check the ${operation} example in the operation reference and correct the listed paths. Use only documented keys.`;
    case 'upload_too_large':
      return uploadLimitHint;
    case 'media_download_source_unavailable':
      return 'The attachment source_url must be an absolute URL on the source tab origin without URL credentials. Inspect the source attachment and use an explicit byte upload for a CDN file. This item was not uploaded.';
    case 'media_download_authorization_required':
      return 'The attachment request is not authorized. Open its URL in the signed-in source tab to confirm access, then resume the same copy_id. This item was not uploaded.';
    case 'media_download_unavailable':
      return 'The source tab could not download a successful attachment response. The file may be missing or redirecting; the cause is unconfirmed. Open the attachment URL in the source tab and confirm it loads without redirects, then resume the same copy_id. This item was not uploaded.';
    case 'media_download_timeout':
      return 'The source attachment download timed out within the bounded read budget. Open its URL in the source tab to confirm it loads, then resume the same copy_id. This item was not uploaded.';
    case 'media_download_too_large':
      return 'The source file exceeds the 5 MiB download limit. Resize or recompress it and use an explicit byte upload. This item was not uploaded; keep existing receipts.';
    case 'media_download_empty':
      return 'The source attachment download contained zero bytes. Repair the source file and confirm its URL loads in the source tab, then resume the same copy_id. This item was not uploaded.';
    case 'invalid_resource_request':
      if (operation === 'inspect_media' || operation === 'inspect_terms') {
        return `Provide target.site_url; target.user_id is optional. Check the ${operation} request example and correct the listed paths.`;
      }

    case 'invalid_shared_request':
      return `Check the ${operation} request example in the operation reference and correct the listed paths. Use only documented keys and copy tokens and receipts from successful results.`;
    case 'invalid_ability_request':
      return "inspect_abilities takes target and an optional name or page. run_ability takes target, name, effect, an optional input, and an optional skip_input_check: true. Copy name and effect (read, write, or destructive) from inspect_abilities, and shape input to that ability's input_schema. Use only those keys.";
    case 'abilities_api_unavailable':
      return 'This site has no Abilities API route: WordPress is older than 6.9, or something blocks the route. Nothing ran. Report that abilities are unavailable on this site; do not call a plugin REST route or an MCP server in their place.';
    case 'ability_unavailable':
      return "No ability by that name is exposed to REST. It may be misspelled or unregistered, or its plugin hides it until the site owner turns on that plugin's external-access setting. Nothing was sent to it. Call inspect_abilities for the exposed names. Change a plugin setting only when the user asked for that.";
    case 'ability_effect_mismatch':
      return "effect must equal the ability's declared effect, which is diagnostics.declared_effect. Nothing was sent. A write or destructive ability changes the site outside Blockwork's locks, receipts, and verification, so send it with that effect only when the user asked for this change.";
    case 'ability_query_input_unsupported':
      return 'This ability takes its input in the query string (diagnostics.method), which cannot carry null, an empty array or object, or an object key that is empty, contains a bracket, or is constructor, prototype, or __proto__: the ability would get a default or another value in its place. diagnostics.path names the first one. Nothing was sent. Leave that key out when the input_schema allows it; otherwise tell the user this value cannot reach this ability.';
    case 'ability_output_unreadable':
      return "WordPress answered success (diagnostics.status), but the body was not the ability's JSON output. A page from a cache or a firewall, or PHP warnings printed ahead of the output, can cause that, and neither shows whether the ability ran. When persistence is uncertain, tell the user the outcome is unconfirmed and never send the run again. For a read, check that the site responds in the browser, then run it again.";
    case 'ability_forbidden':
      return 'WordPress refused this read because the signed-in user lacks the permission the ability requires. Report the missing permission; do not switch accounts or reach the data another way.';
    case 'ability_input_rejected':
      return "input does not match the ability's input_schema, and nothing changed. When diagnostics.path is present, Blockwork found the mismatch before sending: path names the value and constraint the schema rule it breaks, such as type, required, enum, maximum, or additional_properties. Otherwise WordPress rejected a read. Call inspect_abilities with this name, correct that value to the schema, and send JSON values of the schema's own types. Blockwork's check can be stricter than WordPress for an unusual schema: when the value is right for the schema as written, send the run again with skip_input_check: true and WordPress judges it instead. On a write or destructive run, its refusal then comes back uncertain.";
    case 'ability_failed':
      return "WordPress or the ability answered with an error. diagnostics.ability_error is the site's error code and diagnostics.status its HTTP status. When persistence is not_attempted, nothing changed. When it is uncertain, a write or destructive run was sent: rest_ability_cannot_execute means a missing permission and ability_invalid_input means input that fails the input_schema, and WordPress checks both before the ability's code runs, but that code can pass on the same errors after changing something. Tell the user what WordPress answered and that the outcome is unconfirmed. Never send the same run again, and send a corrected one only after the user confirms.";
    case 'invalid_measure':
      return 'measure takes 1 to 20 live client IDs in blocks, or one in client_id, up to 32 CSS property names in properties, and an optional width: desktop, tablet, mobile, or a whole number of CSS pixels from 320 to 2560.';
    case 'connect_required':
      return 'No Blockwork session exists in this tab. Call connect with the exact target and workflow, then read before editing.';
    case 'block_changed':
      return 'Someone else changed a block or child list this edit depends on since Blockwork last read it. diagnostics.conflicts lists each client_id and what changed. Read those blocks, decide whether the edit still applies, and send it again.';
    case 'editor_content_changed':
      return 'The live block tree changed while Blockwork checked the edit, before applying it. diagnostics.mismatches.blocks lists bounded block paths, block names, and changed properties or children, without values; truncated means more differences exist. The cause is unconfirmed. Preserve the draft, call view for the affected container if it has not rendered, then read that subtree including descendants and review the changes before preparing a new edit. Do not replay the failed request automatically.';
    case 'field_changed':
      return 'A document setting this edit writes changed. Read the changed blocks and settings. If editor_result is partial, preserve the draft and do not replay the request. Otherwise send a new edit only if it still applies.';
    case 'unexpected_editor_change':
      return 'The owned background draft contains blocks Blockwork neither produced nor returned from a read (diagnostics.blocks), or settings it did not request (diagnostics.fields, with meta keys as meta.<key>), often written by a theme or plugin script in the editor. Reading the listed blocks clears them; decide whether to keep them. Reading never clears a field: read with settings: true, then send the value to keep through edit({settings}), such as the current value to keep the change or the saved value to undo it. Then save; do not save unreviewed work.';
    case 'empty_edit':
      return 'Supply at least one edit or document setting.';
    case 'too_many_edits':
      return 'An edit accepts at most 32 operations after markup expansion. Split the work across several edit calls.';
    case 'invalid_native_response':
    case 'invalid_entity_list':
      return 'The native response did not match the required schema. Check issues for the response field and constraint; these paths describe native data, not request fields. Preserve the receipt and follow next if a write may have occurred. Do not change the request to accommodate malformed server data.';
    case 'operation_failed':
      return 'The operation failed without an identified native condition. Its cause is unavailable; do not infer one from this code. Retain the complete result and receipt, follow next, and verify any possible mutation before a fresh read or plan.';
    case 'request_timeout':
      return 'WordPress did not answer diagnostics.request within diagnostics.waited_ms milliseconds; operation_budget_spent says whether this call had used up its shared time. When next is retry, nothing changed: wait a few seconds and call again, and if it repeats, check that the site responds in the browser. Otherwise a change may have reached WordPress: follow next and never send it again.';
    case 'fetch_error':
    case 'offline_error':
      return 'The browser could not get a response from WordPress for this request. Check that the site is up and the tab is still signed in. When next is retry, nothing changed and the call can run again; otherwise follow next and never send the change again.';
    case 'verification_deferred':
      return 'WordPress accepted the write and returned resource_id, but this call had too little time left to verify it. Call verify_resource with the stored receipt and resource_id; never save the receipt again.';
    case 'native_api_unavailable':
      if (
        [
          'discover',
          'inspect_media',
          'download_media',
          'inspect_terms',
          'prepare_media',
          'prepare_term',
          'save_resource',
          'verify_resource',
        ].includes(operation)
      ) {
        return 'This wp-admin tab has not exposed wp.apiFetch. Blockwork waits up to 2 seconds while the document is loading; a fully loaded page is checked immediately. Confirm the site and signed-in user in an owned resource tab such as wp-admin/upload.php, let loading finish, then retry the read or preparation. For a possibly sent write, retain its receipt and use verify_resource once the API is available. Do not open a post editor just for resource work.';
      }

      return 'The chosen tab lacks a usable native Gutenberg runtime, current post record, or document schema. Confirm the exact editor tab, post ID and type, then inspect after native loading finishes. Do not reload a user draft or substitute direct REST editing.';
    case 'editor_unavailable':
    case 'editor_record_unavailable':
    case 'document_schema_unavailable':
      return 'The chosen tab lacks a usable native Gutenberg runtime, current post record, or document schema. Confirm the exact editor tab, post ID and type, then inspect after native loading finishes. Do not reload a user draft or substitute direct REST editing.';
    case 'native_canvas_load_failed':
    case 'native_canvas_changed':
      return "Blockwork could not reload Gutenberg's own blank canvas document, or the canvas changed while it tried. For view or measure, report rendered evidence as unavailable and check the saved page on the front end. For an edit, follow editor_result and read the document before a new edit; do not insert blocks manually or raise the deadline.";
    case 'native_insertion_policy_unavailable':
    case 'native_insertion_context_unavailable':
    case 'native_render_refused':
      return 'Native canvas or insertion-policy evidence was unavailable or changed for the reported stage and block. Preserve the draft and inspect diagnostics before a new edit. Confirm the container rendered and exposes native policies; do not insert manually, bypass policy, or raise the bounded initialization deadline.';
    case 'native_patterns_unavailable':
    case 'native_styles_unavailable':
    case 'native_variations_unavailable':
      return 'The native pattern, style, or variation catalogue could not be read in this editor. Inspect the matching catalogue availability and live block registration. Retain the current document if that catalogue is absent; do not guess a catalogue name or token.';
    case 'native_write_unavailable':
    case 'navigation_wrapper_unavailable':
    case 'native_readiness_unavailable':
      return 'The native editor lacks a required write, Navigation wrapper, or readiness API. Read diagnostics for the named stage or resolver when available. Report the capability gap in this exact runtime and retain the draft; do not replace native editing with another write route.';
    case 'editor_code_mode':
      return "This editor is in Code Mode, which has no block canvas, so rendering and nested insertion cannot run here. Code Mode is the user's saved preference, so do not switch it yourself. Ask the user to choose Visual editor from the editor's Options menu, or report rendered evidence as unavailable. Follow next and editor_result before making a new request.";
    case 'native_render_unavailable':
      return "The editor canvas did not render within 5 seconds, or it has no computed-style API. When present, diagnostics.canvas_reloaded says whether Blockwork reloaded Gutenberg's own blank canvas document first. Report rendered evidence as unavailable and check the saved page on the front end instead. Never reload a user's editor or change its canvas yourself.";
    case 'measure_response_too_large':
      return 'Measurement exceeded 64 KiB. Measure fewer blocks or request fewer properties.';
    case 'serialization_mismatch':
      return 'Native serialization changed block values or structure beyond default additions proved to leave native markup byte-identical. Inspect the reported block/property paths and validity or attribute guides, then correct only the requested targets. For a File or Video placeholder, inspect_media and insert with its href or src before binding; do not invent a URL. If markup_available is false, report that the native default markup proof could not be completed. Do not write unrelated defaults or save through the UI to force the edit through. Preserve intervening work and follow next for partial-state recovery.';
    case 'native_requested_value_changed':
    case 'native_structure_changed':
      return 'Native serialization or initialization changed requested values or structure. Compare the reported property paths and block mismatches without assuming their cause. Preserve intervening work, follow next for partial-state recovery, and inspect validity or migration guidance before a new edit.';
    case 'native_selection_restore_failed':
    case 'intervening_selection_change':
      return 'The original native selection could not be restored or the user changed it during the operation. Preserve the current selection and draft. Reconcile the reported editor outcome before another plan; do not force the old selection or replay the edit.';
    case 'unregistered_block':
    case 'block_unregistered':
      return 'The reported block name is not registered in this loaded editor. Inspect insertion or attribute_guide by name and use a registered block. A name-based style guide requires a live registration, not an existing block instance.';
    case 'unsupported_block':
    case 'unsupported_markup':
    case 'unsupported_pattern':
    case 'invalid_replacement_markup':
      return 'Native parsing or the supported-block check rejected this content. Inspect validity and the requested subtree or catalogue item. Use valid registered blocks and preserve unsupported content exactly; do not repair or replace unrelated content to make the plan pass.';
    case 'style_unavailable':
    case 'invalid_class_name':
      return 'The requested registered block style is unavailable, custom classes are disabled, or the existing className is not a string. Read the attribute_guide styles for this block and use a listed style; do not invent a class.';
    case 'binding_attribute_unsupported':
    case 'binding_context_unavailable':
    case 'binding_write_refused':
    case 'bound_block_not_editable':
    case 'bound_block_unsupported':
    case 'unsupported_binding_target':
    case 'conflicting_meta_write':
      return 'The requested binding lacks a supported writable attribute, backing field, or document context, or conflicts with a direct meta write. Inspect the exact binding and settings schema. Write only an inspected public core post-meta binding, once; preserve unsupported or private bindings.';
    case 'invalid_attribute_value':
    case 'invalid_field_value':
    case 'unsupported_attribute':
    case 'unsupported_attribute_type':
    case 'unsupported_media_field':
      return 'The reported attribute or field violates its native schema or write policy. Check diagnostics.attribute or field, expected_type, and constraint. Inspect the matching attribute_guide or settings/resource schema and correct that field without changing unrelated data.';
    case 'field_not_writable':
    case 'field_unavailable':
    case 'meta_unavailable':
    case 'private_meta_unsupported':
    case 'unsupported_pending_settings':
    case 'unsupported_settings_document':
      return 'The requested field, metadata, or pending settings are absent or not supported for a native write in this document. Inspect its writable settings schema and pending work. Retain unavailable or private fields; do not erase pending edits or invent a schema.';
    case 'unsupported_post_type':
    case 'unsupported_rest_route':
    case 'unsupported_taxonomy':
    case 'taxonomy_not_attached':
    case 'taxonomy_required':
    case 'shared_entity_required':
    case 'shared_content_only':
    case 'shared_descendant_not_editable':
      return 'The requested native document, shared entity, REST route, or taxonomy is unsupported or not editable in this context. Use discover or inspect_entity for the exact target and its allowed fields and scope. Do not guess a route, change a shared identity, or bypass content-only restrictions.';
    case 'invalid_resource_identity':
    case 'resource_lookup_failed':
    case 'resource_schema_mismatch':
    case 'media_size_unavailable':
    case 'invalid_media_binding':
    case 'term_impact_unavailable':
    case 'term_parent_unavailable':
    case 'entity_identity_unavailable':
    case 'current_theme_unavailable':
      return 'The required resource identity, schema, media size, parent, deletion impact, or theme context could not be established. Inspect the exact resource or entity and copy its reported identity and token. Preserve existing content if the evidence remains unavailable; never choose a substitute identity to force the operation.';
    case 'reference_block_mismatch':
      return 'The target block does not match the inspected shared reference type or has unexpected children. Inspect that live block and the shared entity separately. Use insert_reference or update_reference with the matching native reference name and token.';
    case 'save_not_sent':
      return "A plugin's check in the editor stopped the save before any request reached WordPress, so nothing was saved. ACF does this when a required field is empty, and the editor shows a notice naming it. Blockwork does not fill plugin fields. In a background tab, release it, ask the user to fill the field and save in their own editor, then connect again and redo the edit. In the user's editor, ask them to fill the field, then save again.";
    case 'save_refused':
      return 'Native Gutenberg refused or did not confirm the save. Inspect persistence and next to determine whether read-only verification is required. Confirm the native lock, publication intent, and editor notices without replaying a possibly completed save.';
    case 'preservation_target_missing':
      return 'The plan lost a protected preservation target. Inspect the original and planned subtrees, use distinct supported targets, and preserve all unrelated bytes. Reconcile partial work before another edit.';
    case 'native_initialization_unsettled':
      return (
        'Native initialization stopped making progress for diagnostics.stall_ms, or the edit reached diagnostics.cap_ms in total (see elapsed_ms). ' +
        'Use diagnostics.stage, completed_blocks, and affected paths to find the delay. If diagnostics.document_hidden is true, the browser is throttling this tab, so close any other tab you opened and leave tabs the user opened or is viewing. Read the changed blocks before anything else; ' +
        'if editor_result is partial, the inserted blocks may be present. If the cap was reached while blocks kept completing, split the work across several edits, with one or two repeated custom items such as tab panels or slides in each. ' +
        'If a replace that wraps existing blocks stalled, insert an empty wrapper and move those blocks into it instead of replacing them with copies. Do not replay the write.'
      );
    case 'upload_bytes_unavailable':
      return 'WordPress stored attachment resource_id with every requested field, but Blockwork could not compare its stored file with the uploaded bytes. A plugin may have converted the upload to another format (compare record.mime_type with the upload), or the file may be unreachable. Do not upload again. Inspect resource_id, check its preview, and use that attachment if it is right, or call verify_resource with the stored receipt once the file is reachable.';
    case 'secure_origin_required':
      return 'Browsers only give a secure origin the crypto.subtle and crypto.randomUUID APIs that Blockwork needs for receipts and verification. This site was opened over plain HTTP on a host other than localhost, so nothing ran. Open the site over HTTPS; if it has no HTTPS, report that Blockwork cannot edit it until it does.';
    case 'upload_bytes_different':
      return 'WordPress stored attachment resource_id with every requested field, but its stored original differs from the uploaded bytes. An image optimizer or another plugin may rewrite originals after upload. Do not upload again. Inspect resource_id, check its dimensions or preview against the intended image, and use that attachment.';
    case 'verification_mismatch':
      if (operation === 'save_resource' || operation === 'verify_resource') {
        return 'Stored resource fields differ from the receipt. diagnostics.fields lists only the differing names, never values. When diagnostics.slug_made_unique is true, WordPress found the requested slug in use and added a numeric suffix; keep the stored slug or prepare an update with a different one. Inspect resource_id for a fresh edit_token. After an exact acknowledged read reports different, prepare an update to that same ID for the intended fields, then save the new receipt. corrective_update reports any automatic upload correction and whether it was acknowledged. If persistence is uncertain, use verify_resource with the stored receipt first; never upload again or replay the old write.';
      }

      if (operation === 'save') {
        return (
          'WordPress stored something other than the prepared draft. diagnostics.fields names differing document fields, with metadata as meta.<key>, and diagnostics.blocks lists block paths with the attribute paths that differ; ' +
          'a server filter such as kses may have rewritten them. Keep the receipt, run recover, then connect again and read those blocks before deciding. Never save the same receipt again.'
        );
      }

      return (
        'The requested verification did not match the prepared result. ' +
        'Read the editor_result and persistence fields and the diagnostics. ' +
        'A draft change does not imply a saved match. Read the current state before a new edit; do not replay the write.'
      );
    case 'saved_record_changed':
      return 'The saved document fields differ from the record this editor loaded or last saved. diagnostics.fields names the differing fields and meta keys, without values. Blockwork cannot determine what caused the difference. Writing now could overwrite saved changes. Tell the user. A background tab should be released and replaced by a fresh editor; in a user editor, only the user decides whether to reload, because reloading discards unsaved work.';
    case 'invalid_view':
      return 'view takes one live client_id and widths, a list of distinct values from desktop, tablet, mobile, or whole numbers of CSS pixels from 320 to 2560. Read the block first to get its current client_id.';
    case 'width_requires_background':
      return "An exact pixel width needs Blockwork to resize the tab's window, which it does only in its own background tab, never in a user's editor. Here use desktop, tablet, or mobile. Check exact widths on the front end after an authorized save.";
    case 'custom_canvas_width':
      return "The user dragged their editor canvas to a width of their own, diagnostics.canvas_width, or zoomed out. Gutenberg cannot set that width again through its public API, so Blockwork changes nothing: it shows that canvas only as desktop, when Gutenberg's View menu shows Desktop. Ask the user to choose a preview in the View menu only if another width matters to the request, or check it on the front end after an authorized save.";
    case 'width_unavailable':
      return "The editor canvas cannot show this width: diagnostics.target_width is what it needs and canvas_width what it got. In a user's editor, Blockwork never resizes the window; use another width, and ask the user to widen the window or close a sidebar only if this width matters to the request. In Blockwork's own tab, a window_width below 782 would switch wp-admin to its small-screen layout, which covers the canvas; use the mobile preview or check that width on the front end.";
    case 'native_device_preview_unavailable':
      return 'This editor has no native device preview (core/editor setDeviceType). Use measure at the current width and check other widths on the front end after saving.';
    case 'block_not_rendered':
      return 'Gutenberg has not rendered this block into the editor canvas. Read the block to confirm it still exists, then view its nearest rendered ancestor, or check the saved page on the front end.';
    case 'block_clipped':
      return 'The block has a box, but a container clips it out of the visible canvas at this width, such as a carousel slide outside its track. Blockwork scrolls scrolling containers to it but does not move carousels. View the container block to see what it shows, use measure for this block, or check that slide on the front end.';
    case 'recover_requires_editor':
      return "The saved content bytes differ, and comparing its blocks needs this site's block registrations. Run recover again in an editor tab for the same site; keep the receipt and never save it again.";
    case 'session_from_older_build':
      return 'This tab holds a session from an older Blockwork build, which may hold editor locks this build cannot release. Close an owned background tab and open a fresh one. In a user editor, ask the user to keep or save their work and reload the tab; never reload it yourself.';
    case 'source_not_found':
      return 'No saved document of that post_type has this post_id, or it was deleted. Find the ID with blockwork.call({operation: "discover", post_type, search}), then read it again.';
    case 'source_read_blocks_only':
      return "A read with source returns only that document's blocks. Remove the fields in diagnostics.fields, and request guides in a separate read without source; guides describe this editor.";
    case 'save_not_applied':
      return 'The saved record still matches the original, so the save did not apply. Connect again, check that the draft still holds the intended changes, then save again.';
    case 'saved_record_different':
      return 'The saved record matches neither the prepared draft nor the original. Another save or a server filter changed it. Connect again, read the blocks you changed, and compare before deciding; never save the same receipt again.';
    case 'stored_with_field_differences':
      return "Content blocks and every other requested field matched, but diagnostics.fields names fields stored differently from the prepared draft, without values. diagnostics.fields_truncated means more paths differ. Blockwork cannot determine why they differ, though a taxonomy field the draft left empty usually holds the default term WordPress assigns, such as Uncategorized; tell the user which term it stored. Inspect those saved fields and decide whether the user's intent still holds. The live session is settled. Never replay this save.";
    case 'post_date_context_unavailable':
      return 'A dynamic Post Date cannot mount safely in the affected context. Inspect diagnostics.reason and target_path. Resolve every actual preview post with a valid backing date and a supported core/post-data datetime source. For an empty Post Template, inspect and supply its explicit native children. Preserve the draft and report an unresolved context; never invent a datetime or replay an uncertain edit.';
    case 'query_preview_context_unavailable':
      return 'Before an edit inserts a Query Loop or Post Template, Blockwork resolves its preview. diagnostics.reason names the unavailable context: query_attribute_missing, nested_query_context, unsupported_post_type, or exclude_current_context. Inspect the Query and its surrounding blocks, then correct the unsupported context or retain the draft and report this capability gap. Do not invent preview results.';
    case 'query_preview_unavailable':
      return 'The native Query preview resolver returned no usable result. Inspect the Query post type and permissions, then edit again only after the read failure is resolved.';
    case 'query_preview_empty':
      return 'The native Query preview returned no results, so Gutenberg cannot mount the template children and establish their insertion policies. Inspect the reported editor outcome and current draft before acting. Inspect the Query post type and filters, then prepare a new edit whose native preview has results, or retain the draft and report this unsupported empty preview. Do not insert the subtree manually or bypass native policy.';
    case 'query_preview_unsettled':
      return 'Query preview reads exceeded their shared twelve-second budget. Check diagnostics for the resolver, template path, and completed work. Inspect the reported editor outcome and current draft before preparing a new request after the read issue is resolved. Do not raise the deadline.';
    case 'revert_dirty_state_changed':
    case 'native_revert_state_unavailable':
      return 'The original content was restored, but native pending edits or dirty state could not be restored safely. Preserve the draft, inspect its current pending work, and report the incomplete revert. Do not clear all entity edits or save to clean the editor.';
    case 'unsaved_preview_unavailable':
      return 'This native editor cannot hold both autosave and manual-save locks. Preserve the draft and report the missing capability; do not apply a no-save preview.';
    case 'unsaved_preview_flag_required':
      return 'This tab holds an unsaved preview. Pass unsaved_preview: true when reconnecting; it keeps the original preview baseline.';
    case 'unsaved_preview_save_forbidden':
      return 'Saving is forbidden while this unsaved preview is active. Restore the original draft and release, or keep the preview unsaved.';
    case 'unsaved_preview_lock_lost':
      return 'A native save lock is missing while the preview remains active. Preserve the draft and report the interrupted protection. Do not mutate, save, reload, or claim no persistence. Reconcile the exact editor and saved record before cleanup.';
    case 'unsaved_preview_saved_changed':
      return 'The saved record changed during the unsaved preview. Keep the owned locks and original receipt, inspect the saved and live states, and report the persistence change. Do not release protection or overwrite the draft automatically.';
    case 'unsaved_preview_pending':
      return 'The initial preview draft, client IDs, or pending settings are not restored, so the owned save locks stay. Restore the original draft without erasing human edits, then release. Do not clear all entity edits or reload.';
    case 'reauthorization_required':
      return (
        "The browser is not signed in to this site, or the session expired. Hand the tab to the user to sign in to the intended account, and wait with wait_for_sign_in as the recovery reference's Sign-in section shows. " +
        'Then confirm the site and user again, and verify any uncertain write with its stored receipt before editing again. ' +
        'Never sign in for the user or create a session, cookie, or login link through WP-CLI, SSH, a hosting API, or CDP.'
      );
    case 'page_loading':
      return 'This wp-admin page has not finished loading, so Blockwork could not read its WordPress version. This call sent nothing. Wait a few seconds for the page to load, then call again in the same tab, or follow next for an earlier unresolved write. Do not reload a user editor.';
    case 'wordpress_unsupported':
      return 'This site runs WordPress diagnostics.wordpress_version, older than the minimum_version Blockwork supports; a null version means wp-admin did not name its version. Nothing changed. Report that Blockwork does not support this site. Do not edit it another way or update WordPress unless the user asks.';
    case 'permission_denied':
      return (
        "WordPress refused this request for the signed-in account, which normally means the account lacks the permission it needs; diagnostics.wordpress_error is WordPress's error code, such as rest_cannot_publish. Signing in again does not fix a missing permission. " +
        'Tell the user which change this account may not make. Leave that change out, or change it only as the user decides, such as submitting for review instead of publishing. ' +
        'If the tab now shows the WordPress login page or a later call returns reauthorization_required, the session ended instead; follow that. ' +
        'Do not switch accounts or make the change another way. When persistence is uncertain, follow next to settle the write first.'
      );
    case 'save_all_pending_required':
      return 'An attached save writes the whole pending document, including earlier user edits. Edits in a user editor stay unsaved by default. Pass save_all_pending: true only when the user explicitly asked to save that whole document.';
    case 'publication_change_requires_request':
      return 'The draft contains a publication change. Obtain explicit status-change intent and set post.status in an edit before saving.';
    case 'editor_not_clean':
      return (
        'This background editor loaded unsaved changes, so Blockwork did not connect and nothing was edited or saved. diagnostics.fields names pending settings, and diagnostics.content_changed reports content that differs from the saved record, apart from the post type template Gutenberg inserts into a new post. ' +
        'Changes made while the editor loads may appear again in another background editor, so do not reopen one to retry. ' +
        'Tell the user which changes are pending. If they want them kept, connect to this same tab with workflow attached, whose save needs save_all_pending: true. Otherwise leave the document unchanged.'
      );
    case 'settings_before_structure':
      return 'A page template change (diagnostics.fields) can change native editor policy, such as allowed blocks. Make structural edits before changing the template, or save the template change and reopen the editor before structural edits.';
    case 'workflow_mismatch':
      return 'This tab already has a session in another workflow. Use that workflow, or release it first.';
    case 'receipt_mismatch':
    case 'invalid_resource_receipt':
      return 'Supply the complete unmodified receipt stored for this write. Preserve the draft and follow next; a reloaded editor cannot recover unsaved work from a receipt.';
    case 'post_locked':
    case 'block_locked':
    case 'template_locked':
    case 'insertion_refused':
      return 'Native locks or editing/insertion policies refused this change. Inspect the target and insertion guide; choose an allowed change. When diagnostics.constraint is single_use_block, the block allows only one copy per document and this document already has it, so edit that one. Do not take over a lock or bypass the policy.';
    case 'block_not_editable':
      return 'Gutenberg or an explicit template lock does not allow this change; diagnostics.reason says why. For pattern_section, request edit with open_pattern_section: {section_client_id: diagnostics.section_client_id} to open that unsynced pattern through the native Edit pattern action before planning. In an attached editor this changes the section the user sees, so include the option only when opening it is intended. Do not click Edit pattern through raw CDP. content_only limits updates to attributes listed with role: content in attribute_guide, even when opening a section makes the native editing_mode default. A native disabled mode still permits no change. editing_disabled permits no change, including while another section is open; read the intended section and explicitly open it if appropriate. block_locked forbids editing. Do not take over a lock, override editing modes, or bypass native policy.';
    case 'pattern_section_open_unavailable':
      return "This editor lacks the public action or public state selector needed to open and verify a pattern section. Ask the user to open the requested section with the toolbar's Edit pattern, then read the target again and submit the intended edit without open_pattern_section. Do not click it through raw CDP or use private APIs.";
    case 'pattern_section_required':
      return 'open_pattern_section.section_client_id must identify the outermost unsynced pattern section in this document. Read the intended block and use its section_client_id, or inspect the section root. Synced patterns, template parts, ordinary blocks, and nested sections cannot be opened this way.';
    case 'pattern_section_not_opened':
      return 'The public action did not confirm the requested section as open. No document edit was applied. Check status().pattern_section and read the target again; ask the user to open it with Edit pattern if needed, then submit a newly inspected edit. Do not replay an edit with an unknown outcome or click the toolbar through raw CDP.';
    case 'no_change':
      return 'The edit produces no effective change. Read the current attributes and settings before sending another edit.';
    case 'custom_css_permission_required':
      return 'Read style_rules.custom_css (can_edit_css, document_has_custom_css) and the style guide custom_css flag. This account needs native edit_css permission even to preserve existing CSS during save; do not substitute page-scoped CSS.';
    case 'unsupported_style_property':
      return 'The exact diagnostics.property has no enabled update_style control. Check control_property and control_enabled when present. Inspect the matching style_guides entry and use its exact enabled property arrays. A refusal by Blockwork does not establish that WordPress lacks the feature. If absent, inspect attribute_guide and native documentation before choosing another operation.';
    case 'unsupported_style_value':
      return 'The patch value does not match the control or registered attribute. Check diagnostics.property, expected_type, constraint, and allowed_values when present. Use the matching style_guides control value_type, values, and preset_value_format. Do not substitute a scalar for a native object or array.';
    case 'style_parent_not_object':
      return 'A parent of diagnostics.property currently holds a scalar or array, so an edge patch cannot preserve its representation. Inspect existing values. Explicitly unset that shorthand in an earlier edit and set the required individual sides, or use an authorized complete attribute update that preserves the intended values.';
    case 'style_side_required':
      return 'This control supports selected sides only. Append one of diagnostics.allowed_edges to the control property; a scalar shorthand would change unsupported sides.';
    case 'style_preset_unavailable':
      return 'The preset requested at diagnostics.property is absent, disabled, or has the wrong preset type. Find the matching style_guides control, then use a slug from read style_catalogs[control.preset_catalog].items and its preset_value_format. Flat preset attributes take a bare slug; nested properties take var:preset|TYPE|SLUG.';
    case 'overlapping_style_properties':
    case 'competing_style_properties':
      return 'Two patches address the same property or competing preset/custom representations. Check diagnostics.property and remove the competing patch. Set one representation; update_style clears its native base counterpart.';
    case 'invalid_style_patch':
      return 'update_style requires 1 to 32 combined set and unset patches. Correct those arrays before editing again.';
    case 'unsupported_style_state':
      return 'The viewport or pseudo-state in diagnostics.property is not supported in this editor. Use diagnostics.supported_states, the style guide responsive (or style_rules.responsive) states, or the style guide pseudo_states. There is no @desktop key.';
    case 'style_state_editing_disabled':
      return 'The native editor disables responsive or state editing. Inspect responsive.editing_enabled in the style guide or style_rules. Use an authorized base style or report the capability restriction.';
    case 'custom_style_disabled':
      return 'The effective theme settings disable custom values for diagnostics.property. Use an available preset from read style_catalogs[control.preset_catalog].items for the matching control, or retain the current value.';
    case 'invalid_custom_css':
      return 'Native instance CSS requires a string containing CSS declarations or nested & selectors, without HTML markup. Correct the CSS value at the reported patch; keep the user-authorized scope.';
    case 'operation_in_progress':
      return operation === 'connect'
        ? 'An earlier connect or operation is still running in this tab, possibly one whose response was lost. Wait a few seconds, then call connect again; it joins that session once the running operation finishes. Do not reload the tab.'
        : 'Another Blockwork operation is still running in this tab. Call status until it finishes, then read its last_request outcome. Never repeat an uncertain request.';
    case 'save_in_progress':
    case 'cleanup_pending':
      return 'Wait for the native save to finish, then call status. Do not issue concurrent writes or close a tab while saving.';
    case 'verify_do_not_replay':
      if (['prepare_media', 'prepare_term'].includes(operation)) {
        return 'An earlier resource write is unresolved in this tab. Call verify_resource with its stored receipt and known resource_id after any in-flight request ends. A verified match, or an exact acknowledged resource read with different fields, permits a fresh preparation; missing or ambiguous creates and unverifiable upload bytes remain blocked, except upload_bytes_different with every requested field matching. Never repeat save_resource or upload again to resolve this refusal.';
      }

      return 'A write may have happened. Keep the receipt, follow next (status for edits, recover for saves, verify_resource for resources), and read the current state before anything else. Never repeat the write.';
    case 'save_uncertain':
      return "The native save did not report success, so a write may have happened. diagnostics.wordpress_error, when present, is WordPress's error code for the failed save; a refusal such as rest_cannot_publish usually means nothing was written, but only recover settles it. Keep the receipt and call recover before anything else. Never repeat the save.";
    case 'rollback_failed':
    case 'resource_save_unconfirmed':
      return 'A write may have happened. Keep the receipt, follow next (status for edits, recover for saves, verify_resource for resources), and read the current state before anything else. Never repeat the write.';
    case 'shared_scope_required':
      return 'Inspect the shared entity and use its reported scope: all_references for synced patterns, site_wide for templates, parts, and navigation. Confirm that shared impact is authorized.';
    case 'gallery_companion_required':
      return 'Read the Gallery and its direct Image child, then inspect the attachment. A fresh unlinked Image requires one complete edit: update its Gallery with sizeSlug matching media_bindings.size and linkTo: none; update the Image with a chosen nonempty caption, the same sizeSlug and linkDestination: none; include its token-checked media binding for id, url, alt and size_slug. Supply any required native attribute resets explicitly with unset. Keep unrelated Images unchanged. Read references/media.md for the complete call. Fresh linked targets and incomplete parent-size requests remain unsupported.';
    case 'context_companion_required':
      return 'This leaf uses custom context from both parents. Move-only cannot supply its derived attributes. Read the block documentation or ask the user for the final values, then send one complete request with edits: [{ op: "move", path: SOURCE_PATH, parent: DESTINATION_PARENT, index: DESTINATION_INDEX }, { op: "update", path: RESULT_PATH, attributes: DOCUMENTED_FINAL_ATTRIBUTES }]. For the documented red-to-blue context-label fixture, use edits: [{ op: "move", path: [0, 0], parent: [1], index: 0 }, { op: "update", path: [1, 0], attributes: { resolvedTone: "blue" } }]. Never infer a derivation for another custom block. See references/edit.md#supply-known-context-derived-attributes.';
    case 'tabs_companion_required':
      return 'Read the Tabs root, its panels, and its tab list. Rename with both the panel label and the complete tab-list tabs array matching the final panel labels in one edit. For an existing-panel move or removal, also supply editorActiveTabIndex on the Tabs root. A move selects its destination index. Removal selects its old index, except removing the last panel selects its predecessor. Read the complete examples in references/edit.md#coordinate-existing-tabs-panels. Keep user-supplied labels exact. To add a panel, insert core/tab-panel under the existing core/tab-panels with attributes { label: "New" } and inner_blocks: [{ name: "core/paragraph" }], then update the Tabs root editorActiveTabIndex to its new index and supply the complete final tab-list tabs array. The single empty paragraph must be explicit.';
    case 'invalid_index':
    case 'invalid_parent':
    case 'invalid_move':
    case 'invalid_nesting':
      return 'Inspect the target and destination insertion guide. Paths resolve after each preceding edit; move indexes resolve after removal. Use the inspected block name, a valid child index, and an allowed parent outside the moved subtree.';
    case 'block_mismatch':
      return 'The selected block has a different name than requested. Compare diagnostics.expected_name and actual_name, read the current subtree, and select by client_id.';
    case 'block_identity_missing':
      return 'The client_id did not match exactly one current block. It may have been removed or replaced. Read the current subtree and use a client_id it returns; do not retarget by name alone.';
    case 'ambiguous_union_attribute':
      return 'The array at diagnostics.path and diagnostics.attribute may have been an object before the REST response. Inspect the document and preserve the original stored content. Report the ambiguity; do not save or silently rewrite the value. Legitimate arrays have the same ambiguity. For an unrelated edit in an attached editor, reconnect with unsaved_preview: true first to protect against native autosave, then restore the preview before releasing it.';
    case 'inspection_path_missing':
      return 'The requested block is absent from the live tree. Read roots or search, then use a current client_id.';
    case 'unsupported_structural_edit':
    case 'unsupported_target_or_subtree':
    case 'ambiguous_preservation_region':
    case 'overlapping_preservation_regions':
      return 'Inspect validity and the target subtree. Mixed unsupported content permits supported scalar/style edits only with exact preservation. Choose nonoverlapping supported targets; do not repair or remove unsupported content implicitly.';
    case 'resource_not_prepared':
      return 'This resource receipt was not prepared in this tab or was already attempted. Never save it again. Verify any unresolved write with verify_resource and its stored receipt first. Once settled, inspect the exact ID for a fresh edit_token and prepare a new receipt for the intended change.';
    case 'save_not_prepared':
      return 'This write was not prepared in the current session or was already attempted. Call status, then save again only if nothing is pending.';
    case 'document_released':
      return 'This background tab was released and no longer renews its lock. Close it and open a fresh editor tab for further work.';
    case 'heartbeat_timeout':
    case 'heartbeat_failed':
    case 'lock_owner_mismatch':
      return 'WordPress Heartbeat did not confirm that this tab owns the post lock. Check that the editor is signed in and no other editor holds the lock, then close this tab and open a fresh editor; never take over the lock.';
    case 'save_unresolved':
      return 'An earlier save attempt may have reached WordPress. Reconcile it with recover and the stored receipt, then connect again before saving. Never save that receipt twice.';
    case 'reopen_required':
      return 'A saved page template change can change native editor policy, such as allowed blocks. Release, reopen the editor, and connect again before structural edits.';
    case 'revert_not_available':
      return 'revert undoes only the latest edit, once, and only while the draft is exactly as that edit left it. Read the current state and make a new edit instead.';
    case 'term_deletion_scope_required':
    case 'term_has_children':
    case 'stale_term_impact':
      return 'Inspect the exact term and its deletion impact. Deletion requires explicit all_relationships scope and a current impact token, and refuses child terms. Confirm the requested relationship impact before editing again.';
    case 'invalid_term_parent':
    case 'taxonomy_not_hierarchical':
      return 'Inspect the taxonomy and candidate parent. Only hierarchical taxonomies accept parents; the parent must be in that taxonomy and must not introduce a cycle.';
    case 'creation_slug_required':
    case 'creation_fields_required':
    case 'slug_already_exists':
      return 'Inspect existing records and create with the required identity fields, an explicit status for documents, and a unique requested slug. Never invent a replacement slug or repeat an uncertain creation.';
    case 'future_date_required':
      return 'Scheduling requires post.status future and an explicit valid future post.date_gmt in YYYY-MM-DDTHH:mm:ss UTC form. Confirm the intended time before preparing.';
    case 'unmapped_media_url':
      return 'The copied blocks still use files from the source site that media_map does not move, so nothing changed. diagnostics.references names each block by its path within the inserted blocks, with block_name and attribute. When the attribute holds the file URL as its whole value, find or upload that file on this site, add its URL, and its ID when the block stores one beside it, to media_map, then send the edit again. media_map never rewrites a URL inside text, such as an inline image in a paragraph; change it in the markup or block tree you send first.';
    case 'link_resolution_incomplete':
      return 'Destination links could not all be resolved. diagnostics.links lists up to 10 source URLs with missing, ambiguous, or candidate_limit reasons; truncated means more failed. Pass explicit overrides for changed slugs, archives, or external targets, or publish the destination page first, then call map_links again. No source site was queried and nothing changed.';
    case 'unmapped_internal_link':
      return 'The copied blocks still contain an unmapped absolute link under link_map.source_site_url, so nothing changed. diagnostics.references names up to 10 block paths and attributes. Run map_links on this section with overrides for unresolved links and pass its complete link_map. Only whole-value strings and anchor href values change. Change source URLs in other text explicitly before editing; uploads belong to media_map.';
    case 'user_mismatch':
      return 'This tab is signed in as diagnostics.signed_in_user_id, not diagnostics.expected_user_id. Nothing changed. If the signed-in account is the one the task should use, send its ID as target.user_id; discover with only target.site_url also returns it. Otherwise ask the user to sign in as the intended account in this browser. Never sign in for them or switch targets to force a match.';
    case 'url_outside_site':
      return "url is not under this site's home address, so nothing was looked up. Use a front-end URL from the site in target.site_url, or run discover in a wp-admin tab of the site that serves the page.";
    case 'document_not_found':
      return 'No single document the signed-in user can edit has this exact permalink, so nothing was opened. diagnostics.reason is missing, ambiguous, or no_front_page; no_front_page means the home address shows the latest posts or carries a query other than p or page_id, such as a search. Archives and search results are not documents. Find the document with discover, post_type, and search, or ask the user which one they mean.';
    case 'reference_operation_required':
    case 'recursive_entity_reference':
    case 'pattern_not_synced':
      return 'Inspect the published synced pattern or shared entity and its reference token. Use insert_reference or update_reference for shared identity. References cannot include the owner or create an indirect cycle.';
  }

  if (code === 'stale_entity_reference') {
    return 'The referenced entity changed or is no longer published since it was inspected, so this edit applied nothing. Inspect it again with inspect_entity and retry the edit with the fresh reference_token. If it is no longer published, ask the user which entity to use.';
  }

  if (code.startsWith('cleanup_')) {
    return 'Owned-lock cleanup was not confirmed. Retain the receipt and confirm no save is in flight. Follow background cleanup rules to close an owned tab and allow native lock expiration, or retain an attached user tab. Report the failure; never clear another editor lock.';
  }

  if (code.startsWith('stale_') || code.includes('changed') || code.startsWith('intervening_')) {
    return 'The draft, settings, selection, or registration changed during this operation. Preserve intervening work, call status if a mutation may have started, then read again before a new edit.';
  }

  if (code.endsWith('_mismatch') || code === 'invalid_site') {
    return 'Confirm the exact site URL, user, document/resource identity, and current editor. Compare the inspected target and stored receipt before continuing; do not switch targets to force a match.';
  }

  if (code.includes('style') || code.includes('css')) {
    return 'Read style_guides for the target and parent, and attribute_guide where needed. Use enabled property paths, edge names, presets, and native value types. Remove conflicting or overlapping patches.';
  }

  if (
    code.includes('attribute') ||
    code.includes('field') ||
    code.includes('meta') ||
    code.includes('binding')
  ) {
    return 'Inspect the target attribute_guide or native document/resource settings schema. Use writable registered fields and their exact types and constraints. Bound attributes require an inspected supported binding write.';
  }

  if (code === 'inspection_too_large') {
    return 'Inspection detail exceeded 64 KiB. Read diagnostics.section_bytes and guide_bytes to identify the oversized section. Request fewer blocks or guides, use style_guides[index].properties prefixes such as ["layout"] or ["style","spacing"], and omit optional insertion, patterns, or attribute guides when unneeded. If one block or guide is still too large, use roots or search outlines without style_guides and report the single-value detail limit instead of repeating that read. See inspection.md inspection shapes and styling.md compact catalogs; do not raise the response limit.';
  }

  if (code === 'content_too_large') {
    return "This document's block content is diagnostics.content_bytes bytes, over Blockwork's limit_bytes document limit, so Blockwork cannot read or verify it. prepare_save refuses before writing anything. Report that the document is too large for Blockwork. Remove content to fit only when the user asks; never split or rewrite it on your own. When persistence is uncertain, follow next.";
  }

  if (code === 'response_too_large') {
    return 'A WordPress response was diagnostics.response_bytes bytes, over the limit_bytes Blockwork reads at once. A read changed nothing; if the response answered a write, the write may have happened, so follow next and never repeat it. For a list, request a smaller page or a narrower search; for one record, report the limit. Do not raise the limit.';
  }

  if (code.includes('too_large') || code.includes('too_many') || code.includes('too_deep')) {
    return 'Narrow the inspection projection or reduce the plan to documented size, depth, and count limits. Reconcile partial writes before splitting work; do not silently split a requested save.';
  }

  if (
    code.startsWith('native_') ||
    code.endsWith('_unavailable') ||
    code.startsWith('unsupported_')
  ) {
    return 'Inspect the reported native capability or support restriction in this exact editor. Use supported registrations and host APIs. If the capability is absent, report the gap; do not substitute a helper, plugin, or guessed attribute.';
  }

  return (
    `The ${operation} operation reported an unclassified failure. Its specific cause and repair are unavailable. Preserve the full error and receipt, ` +
    'follow next, and inspect this exact target before a new edit. Do not infer the cause or replay an uncertain mutation.'
  );
}

export function changedProperties(expected: JsonValue | undefined, actual: JsonValue | undefined) {
  const paths: string[] = [];
  let truncated = false;
  const walk = (
    before: JsonValue | undefined,
    after: JsonValue | undefined,
    path: string,
    depth: number,
  ): void => {
    if (same(before, after)) {
      return;
    }

    if (paths.length >= 20) {
      truncated = true;

      return;
    }

    if (depth < 16 && v.is(JsonObjectSchema, before) && v.is(JsonObjectSchema, after)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

      for (const key of keys) {
        const name = diagnosticKey(key);
        walk(before[key], after[key], path ? `${path}.${name}` : name, depth + 1);
      }
    } else {
      paths.push(path.slice(0, 200));
    }
  };

  walk(expected, actual, '', 0);

  return { paths, truncated };
}

export function blockMismatches(
  expected: BlockSummary[],
  actual: BlockSummary[],
  identity = false,
) {
  const mismatches: JsonObject[] = [];
  const byPath = (rows: BlockSummary[]) => new Map(rows.map((row) => [row.path.join('.'), row]));
  const expectedRows = byPath(expected);
  const actualRows = byPath(actual);
  const paths = new Map([...expected, ...actual].map((row) => [row.path.join('.'), row.path]));
  let truncated = false;

  for (const [key, path] of paths) {
    const before = expectedRows.get(key);
    const after = actualRows.get(key);
    const snapshot = (row: BlockSummary | undefined): JsonObject | undefined => {
      if (!row) {
        return identity ? {} : undefined;
      }

      return {
        name: row.name,
        attributes: row.attributes,
        support: row.support,
        client_id: identity ? row.clientId : undefined,
        children: identity
          ? (row.block.innerBlocks ?? []).map((child) => child.clientId)
          : undefined,
        reason: identity ? row.reason : undefined,
      };
    };

    const changed = changedProperties(snapshot(before), snapshot(after));

    if (!changed.paths.length) {
      continue;
    }

    if (mismatches.length >= 20) {
      truncated = true;
      break;
    }

    const mismatch: JsonObject = { path, properties: changed.paths, truncated: changed.truncated };

    if (identity && before) {
      mismatch.expected_name = before.name.slice(0, 200);
    }

    if (identity && after) {
      mismatch.actual_name = after.name.slice(0, 200);
    }

    mismatches.push(mismatch);
  }

  return { blocks: mismatches, truncated };
}

export function serializationDiagnostics(
  expected: BlockSummary[],
  actual: BlockSummary[],
  stage: string,
  comparison: string,
): JsonObject {
  const mismatches = blockMismatches(expected, actual);

  return {
    stage,
    comparison,
    mismatches: {
      ...mismatches,
      blocks: mismatches.blocks.map((block) => ({
        ...block,
        expected_name: expected.find((row) => same(row.path, block.path))?.name,
        actual_name: actual.find((row) => same(row.path, block.path))?.name,
      })),
    },
  };
}
