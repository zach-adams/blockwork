import * as v from 'valibot';
import { AbilityRequestSchema, abilityOperation } from './abilities';
import type { AbilityRequest } from './abilities';
import { ResourceRequestSchema, resourceOperation } from './resources';
import type { Connection, Request } from './contracts';
import { JsonObjectSchema, editorOperations, readOnlyOperations } from './contracts';
import type { ResourceRequest } from './resources';
import { SharedRequestSchema, sharedOperation } from './shared';
import type { SharedRequest } from './shared';
import { errorHint } from './errors';
import { editorOperation } from './session';
import { startOperation } from './timing';

// The request schemas already name each operation, so read the names from them.
const knownOperations: readonly string[] = [
  ...editorOperations,
  ...[ResourceRequestSchema, SharedRequestSchema, AbilityRequestSchema].flatMap((schema) =>
    schema.options.map((option) => option.entries.operation.literal),
  ),
];

type AnyRequest = Request | ResourceRequest | SharedRequest | AbilityRequest | Connection;

async function dispatch(request: AnyRequest) {
  switch (request?.operation) {
    case 'inspect_abilities':
    case 'run_ability':
      return abilityOperation(request);
    case 'list_entities':
    case 'inspect_entity':
    case 'recover':
      return sharedOperation(request);
    case 'discover':
    case 'resource_status':
    case 'inspect_media':
    case 'download_media':
    case 'inspect_terms':
    case 'prepare_media':
    case 'prepare_term':
    case 'save_resource':
    case 'verify_resource':
      return resourceOperation(request);
    default:
      return editorOperation(request);
  }
}

export async function blockwork(request: AnyRequest) {
  if (request?.operation !== 'resource_status') {
    startOperation();
  }

  const result = await dispatch(request);

  if (result.ok) {
    return result;
  }

  const operation = knownOperations.includes(request?.operation)
    ? String(request.operation)
    : 'unknown';
  let code =
    'error' in result && typeof result.error === 'string' ? result.error : 'operation_failed';

  // Plain HTTP on a real host lacks both APIs, so the first use of either throws
  // an error with no code. A failure that may have written keeps its own answer.
  if (
    code === 'operation_failed' &&
    (!('persistence' in result) || result.persistence === 'not_attempted') &&
    (!globalThis.crypto?.subtle || typeof globalThis.crypto.randomUUID !== 'function')
  ) {
    code = 'secure_origin_required';
  }

  let next = 'correct_request';

  if (operation === 'verify_resource' || operation === 'save_resource') {
    next = 'verify_resource_do_not_replay';
  }

  if ('next' in result && typeof result.next === 'string') {
    next = result.next;
  }

  // A read or preparation that got no answer changed nothing, so it can simply
  // run again. Preparations write nothing; the save they prepare is separate.
  if (
    ['request_timeout', 'fetch_error', 'offline_error'].includes(code) &&
    [
      ...readOnlyOperations,
      'prepare_save',
      'prepare_resave',
      'prepare_media',
      'prepare_term',
    ].includes(operation)
  ) {
    next = 'retry';
  }

  const diagnostics =
    'diagnostics' in result && v.is(JsonObjectSchema, result.diagnostics)
      ? result.diagnostics
      : undefined;

  return { ...result, error: code, operation, hint: errorHint(code, operation, diagnostics), next };
}
