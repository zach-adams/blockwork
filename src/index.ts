import * as v from 'valibot';
import { abilityOperation } from './abilities';
import type { AbilityRequest } from './abilities';
import { resourceOperation } from './resources';
import type { Connection, Request } from './contracts';
import { JsonObjectSchema, editorOperations, readOnlyOperations } from './contracts';
import type { ResourceRequest } from './resources';
import { sharedOperation } from './shared';
import type { SharedRequest } from './shared';
import { errorHint } from './errors';
import { editorOperation } from './session';
import { startOperation } from './timing';

const resourceOperations = [
  'resource_status',
  'discover',
  'inspect_media',
  'download_media',
  'inspect_terms',
  'prepare_media',
  'prepare_term',
  'save_resource',
  'verify_resource',
];
const sharedOperations = ['list_entities', 'inspect_entity', 'recover'];
const abilityOperations = ['inspect_abilities', 'run_ability'];

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

  const known = [
    ...editorOperations,
    ...resourceOperations,
    ...sharedOperations,
    ...abilityOperations,
  ];
  const operation = known.includes(request?.operation) ? String(request.operation) : 'unknown';
  let code =
    'error' in result && v.is(v.string(), result.error) ? result.error : 'operation_failed';

  // Plain HTTP on a real host lacks both APIs, so the first use of either throws
  // an error with no code. A failure that may have written keeps its own answer.
  if (
    code === 'operation_failed' &&
    (!('persistence' in result) || result.persistence === 'not_attempted') &&
    (!globalThis.crypto?.subtle || !v.is(v.function(), globalThis.crypto.randomUUID))
  ) {
    code = 'secure_origin_required';
  }

  let next = 'correct_request';

  if (operation === 'verify_resource' || operation === 'save_resource') {
    next = 'verify_resource_do_not_replay';
  }

  if ('next' in result && v.is(v.string(), result.next)) {
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
