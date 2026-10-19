/** Browser-safe control-plane contract. This module has no Host or provider imports. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type CloudResponse = JsonValue;
export type CloudAuth = 'auto' | 'connection-string' | 'azure-cli' | 'managed-identity';
export type CloudPlatform = 'linux' | 'darwin' | 'win32';
export type CloudMapping = { id?: string; remotePrefix: string; localPrefix: string; remotePlatform: CloudPlatform };
type ThreadAction = 'sync' | 'detach' | 'export' | 'repair' | 'acknowledge-degraded' | 'check-ownership' | 'git-info';
type ConfirmAction = 'takeover' | 'resurrect';
/** Missing sessionId is permitted for native invocation fallback. A sid-less pull lists remote threads. */
export type CloudRequest =
  | { action: 'status'; sessionId?: string; cursor?: string; limit?: number }
  | { action: 'toggle'; sessionId?: string; enabled: boolean }
  | { [A in Exclude<ThreadAction, 'repair'>]: { action: A; sessionId?: string } }[Exclude<ThreadAction, 'repair'>]
  | { action: 'pull'; sessionId?: string; cursor?: string; limit?: number }
  | { action: 'repair'; sessionId?: string; confirmMapping?: true }
  | { [A in ConfirmAction]: { action: A; sessionId?: string; confirm: true } }[ConfirmAction]
  | { action: 'remove'; sessionId?: string; confirm: true; acknowledgeAttachmentsRetained: true }
  | { action: 'map'; mapping: CloudMapping }
  | { action: 'unmap'; mappingId: string }
  | { action: 'mappings' }
  | { action: 'set-auth'; auth: CloudAuth; accountName?: string; managedIdentityClientId?: string; connectionString?: string; clearConnectionString?: boolean }
  | { action: 'test-auth' }
  | { action: 'set-defaults'; defaultEnabled?: boolean; pullOnStartup?: boolean; pollSeconds?: number };

export interface CloudControllerPort {
  execute(request: CloudRequest, context: { sessionId?: string; origin: 'command' | 'rpc'; signal: AbortSignal }): Promise<CloudResponse>;
}

const MESSAGES = {
  INVALID_REQUEST: 'The cloud request is invalid.',
  SETUP_NEEDED: 'Cloud sync setup is required.',
  FORBIDDEN: 'This cloud request is not permitted.',
  CONFIRM_REQUIRED: 'Explicit confirmation is required; removal also requires acknowledging that attachments are retained.',
  OPERATION_FAILED: 'The cloud operation failed.',
  CANCELLED: 'The cloud request was cancelled.',
  CAPACITY: 'The cloud control channel is at capacity. Try again later.',
  LIMIT: 'The cloud request or result exceeds its safe JSON bounds.',
} as const;
export type CloudErrorCode = keyof typeof MESSAGES;
export type CloudPublicError = { code: CloudErrorCode; message: string };
export type CloudEnvelope = { v: 1; ok: true; data: CloudResponse } | { v: 1; ok: false; error: CloudPublicError };
const errors = new WeakMap<object, CloudErrorCode>();

/** Only fixed, allowlisted messages cross a transport; even mutated Error properties are ignored. */
export class CloudControlError extends Error {
  readonly code: CloudErrorCode;
  constructor(code: CloudErrorCode) {
    // Runtime callers cannot use a cast to introduce a dynamic message or code.
    const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'OPERATION_FAILED';
    super(MESSAGES[known]);
    this.name = 'CloudControlError';
    this.code = known;
    errors.set(this, known);
  }
}

/** Never reads error.message/name/code/cause, invokes getters, or serializes provider failures. */
export function publicCloudError(error: unknown): CloudPublicError {
  const code = error !== null && (typeof error === 'object' || typeof error === 'function') ? errors.get(error) ?? 'OPERATION_FAILED' : 'OPERATION_FAILED';
  return { code, message: MESSAGES[code] };
}

export const CLOUD_JSON_MAX_BYTES = 256 * 1024;
export const CLOUD_JSON_MAX_DEPTH = 16;
export const CLOUD_JSON_MAX_NODES = 8192;
const encoder = new TextEncoder();
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'toJSON']);

/**
 * Make a detached, lossless plain-JSON snapshot without ever reading a property
 * value through access syntax or calling input.toJSON. Reject omissions, sparse
 * arrays, custom prototypes, accessors, symbols, unsafe numbers, and cycles.
 */
export function boundedJson(value: unknown): JsonValue {
  let bytes = 0; let nodes = 0;
  const ancestors = new Set<object>();
  const fail = (): never => { throw new CloudControlError('LIMIT'); };
  const charge = (amount: number): void => { bytes += amount; if (bytes > CLOUD_JSON_MAX_BYTES) fail(); };
  const stringBytes = (text: string): number => {
    if (text.length > CLOUD_JSON_MAX_BYTES) fail();
    return encoder.encode(JSON.stringify(text)).byteLength;
  };
  const visit = (input: unknown, depth: number): JsonValue => {
    if (++nodes > CLOUD_JSON_MAX_NODES || depth > CLOUD_JSON_MAX_DEPTH) fail();
    if (input === null || typeof input === 'boolean') { charge(input === false ? 5 : 4); return input; }
    if (typeof input === 'string') { charge(stringBytes(input)); return input; }
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0) || (Number.isInteger(input) && !Number.isSafeInteger(input))) fail();
      charge(String(input).length); return input;
    }
    if (input === null || typeof input !== 'object' || ancestors.has(input)) return fail();
    const array = Array.isArray(input);
    const prototype: unknown = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    const keys = Reflect.ownKeys(input);
    if (keys.length > CLOUD_JSON_MAX_NODES) fail();
    const output: JsonValue[] | { [key: string]: JsonValue } = array ? [] : {};
    let length = 0;
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(input, 'length');
      if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value > CLOUD_JSON_MAX_NODES) fail();
      length = descriptor!.value as number;
    }
    ancestors.add(input); charge(2);
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail();
      const name = key as string;
      if (RESERVED_KEYS.has(name)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
      if (array && name !== String(count)) fail();
      if (count++ > 0) charge(1);
      if (!array) charge(stringBytes(name) + 1);
      const child = visit(descriptor!.value, depth + 1);
      Object.defineProperty(output, name, { value: child, enumerable: true, writable: true, configurable: true });
    }
    if (array && count !== length) fail();
    ancestors.delete(input);
    return output;
  };
  try { return visit(value, 0); }
  catch { throw new CloudControlError('LIMIT'); }
}

type RecordValue = { [key: string]: JsonValue };
const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;
const invalid = (): never => { throw new CloudControlError('INVALID_REQUEST'); };
function record(value: JsonValue | undefined): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value;
}
function keys(input: RecordValue, allowed: readonly string[], required: readonly string[] = []): void {
  if (Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(input, key))) invalid();
}
function text(value: JsonValue | undefined, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function optionalText(input: RecordValue, key: string, max: number, empty = false): void {
  if (Object.hasOwn(input, key) && !text(input[key], max, empty)) invalid();
}
function optionalBoolean(input: RecordValue, key: string): void {
  if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') invalid();
}
function session(input: RecordValue): void { optionalText(input, 'sessionId', 256); }

/** Strict runtime validation shared by native commands, RPC, and the controller. */
export function parseCloudRequest(value: unknown): CloudRequest {
  let snapshot: JsonValue;
  try { snapshot = boundedJson(value); }
  catch { return invalid(); }
  const input = record(snapshot);
  switch (input.action) {
    case 'status':
      keys(input, ['action', 'sessionId', 'cursor', 'limit']); session(input); optionalText(input, 'cursor', 4096);
      if (Object.hasOwn(input, 'limit') && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) invalid();
      break;
    case 'toggle':
      keys(input, ['action', 'sessionId', 'enabled'], ['enabled']); session(input);
      if (typeof input.enabled !== 'boolean') invalid();
      break;
    case 'pull':
      keys(input, ['action', 'sessionId', 'cursor', 'limit']); session(input); optionalText(input, 'cursor', 4096);
      if (Object.hasOwn(input, 'limit') && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) invalid();
      if (Object.hasOwn(input, 'sessionId') && (Object.hasOwn(input, 'cursor') || Object.hasOwn(input, 'limit'))) invalid();
      break;
    case 'sync': case 'detach': case 'export': case 'acknowledge-degraded': case 'check-ownership': case 'git-info':
      keys(input, ['action', 'sessionId']); session(input); break;
    case 'repair':
      keys(input, ['action', 'sessionId', 'confirmMapping']); session(input);
      if (Object.hasOwn(input, 'confirmMapping') && input.confirmMapping !== true) invalid();
      break;
    case 'takeover': case 'resurrect': case 'remove':
      keys(input, input.action === 'remove' ? ['action', 'sessionId', 'confirm', 'acknowledgeAttachmentsRetained'] : ['action', 'sessionId', 'confirm']); session(input);
      if (input.confirm !== true || (input.action === 'remove' && input.acknowledgeAttachmentsRetained !== true)) throw new CloudControlError('CONFIRM_REQUIRED');
      break;
    case 'map': {
      keys(input, ['action', 'mapping'], ['mapping']);
      const mapping = record(input.mapping);
      keys(mapping, ['id', 'remotePrefix', 'localPrefix', 'remotePlatform'], ['remotePrefix', 'localPrefix', 'remotePlatform']);
      if (Object.hasOwn(mapping, 'id') && (typeof mapping.id !== 'string' || !UUID.test(mapping.id))) invalid();
      if (!text(mapping.remotePrefix, 4096) || !text(mapping.localPrefix, 4096) || !['linux', 'darwin', 'win32'].includes(mapping.remotePlatform as string)) invalid();
      break;
    }
    case 'unmap':
      keys(input, ['action', 'mappingId'], ['mappingId']);
      if (typeof input.mappingId !== 'string' || !UUID.test(input.mappingId)) invalid();
      break;
    case 'mappings': case 'test-auth': keys(input, ['action']); break;
    case 'set-auth':
      keys(input, ['action', 'auth', 'accountName', 'managedIdentityClientId', 'connectionString', 'clearConnectionString'], ['auth']);
      if (!['auto', 'connection-string', 'azure-cli', 'managed-identity'].includes(input.auth as string)) invalid();
      optionalText(input, 'accountName', 24, true); optionalText(input, 'managedIdentityClientId', 256, true);
      if (typeof input.accountName === 'string' && !/^(?:[a-z0-9]{3,24})?$/u.test(input.accountName)) invalid();
      optionalText(input, 'connectionString', 65536); optionalBoolean(input, 'clearConnectionString');
      if (Object.hasOwn(input, 'connectionString') && input.clearConnectionString === true) invalid();
      break;
    case 'set-defaults':
      keys(input, ['action', 'defaultEnabled', 'pullOnStartup', 'pollSeconds']);
      optionalBoolean(input, 'defaultEnabled'); optionalBoolean(input, 'pullOnStartup');
      if (Object.hasOwn(input, 'pollSeconds') && (typeof input.pollSeconds !== 'number' || !Number.isInteger(input.pollSeconds) || input.pollSeconds < 30 || input.pollSeconds > 86400)) invalid();
      break;
    default: return invalid();
  }
  return input as CloudRequest;
}

/** Versioning is separate from the SDK's carrier envelope; extra fields are never accepted. */
export function parseCloudPayload(value: unknown): CloudRequest {
  const input = record(boundedJson(value));
  keys(input, ['v', 'request'], ['v', 'request']);
  if (input.v !== 1) invalid();
  return parseCloudRequest(input.request);
}

/** Bound the entire outgoing application envelope, not just its data. */
export function cloudSuccess(data: unknown): CloudEnvelope {
  return boundedJson({ v: 1, ok: true, data }) as CloudEnvelope;
}
export function cloudFailure(error: unknown): CloudEnvelope {
  return { v: 1, ok: false, error: publicCloudError(error) };
}
