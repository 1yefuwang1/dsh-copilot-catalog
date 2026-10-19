import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundedJson, cloudSuccess, CloudControlError, CLOUD_JSON_MAX_BYTES, CLOUD_JSON_MAX_DEPTH,
  CLOUD_JSON_MAX_NODES, parseCloudPayload, parseCloudRequest, publicCloudError,
  type CloudErrorCode, type CloudRequest,
} from '../src/protocol.js';

const uuid = '12345678-1234-4234-9234-123456789abc';
const code = (expected: CloudErrorCode) => (error: unknown): boolean => publicCloudError(error).code === expected;

test('shared request union accepts every advertised action and detaches its input', () => {
  const values: CloudRequest[] = [
    { action: 'status', sessionId: 'session', cursor: 'next', limit: 100 }, { action: 'status', limit: 1 },
    { action: 'toggle', enabled: true }, { action: 'toggle', sessionId: 'session', enabled: false },
    ...(['sync', 'pull', 'detach', 'export', 'repair', 'acknowledge-degraded', 'check-ownership'] as const).map(action => ({ action, sessionId: 'session' })),
    { action: 'pull' }, { action: 'pull', cursor: 'c2Vzc2lvbjp4', limit: 100 }, { action: 'repair', confirmMapping: true },
    { action: 'takeover', confirm: true }, { action: 'resurrect', confirm: true },
    { action: 'remove', confirm: true, acknowledgeAttachmentsRetained: true },
    { action: 'map', mapping: { id: uuid, remotePrefix: '/remote', localPrefix: 'C:\\local path', remotePlatform: 'linux' } },
    { action: 'unmap', mappingId: uuid }, { action: 'mappings' },
    { action: 'set-auth', auth: 'auto' }, { action: 'set-auth', auth: 'azure-cli', accountName: 'account123' },
    { action: 'set-auth', auth: 'managed-identity', managedIdentityClientId: 'identity', accountName: '' },
    { action: 'set-auth', auth: 'connection-string', connectionString: 'synthetic-secret' },
    { action: 'set-auth', auth: 'auto', clearConnectionString: true }, { action: 'test-auth' },
    { action: 'set-defaults', defaultEnabled: false, pullOnStartup: true, pollSeconds: 30 },
    { action: 'set-defaults', pollSeconds: 86400 },
  ];
  for (const value of values) {
    const parsed = parseCloudRequest(value);
    assert.deepEqual(parsed, value); assert.notEqual(parsed, value);
    assert.deepEqual(parseCloudPayload({ v: 1, request: value }), value);
  }
  const input = { action: 'map', mapping: { remotePrefix: '/remote', localPrefix: '/local', remotePlatform: 'linux' } };
  const parsed = parseCloudRequest(input);
  input.mapping.localPrefix = '/changed';
  assert.equal(parsed.action === 'map' && parsed.mapping.localPrefix, '/local');
});

test('strict discriminated requests reject unknown fields, coercions, invalid ranges and unsafe identifiers', () => {
  const invalid: unknown[] = [
    null, [], 'status', {}, { action: 'unknown' }, { action: 'status', enabled: true },
    { action: 'status', sessionId: '' }, { action: 'status', sessionId: 'x\n' }, { action: 'status', sessionId: 'x'.repeat(257) },
    { action: 'status', limit: 0 }, { action: 'status', limit: 101 }, { action: 'status', limit: 1.5 }, { action: 'status', limit: '1' },
    { action: 'status', cursor: '' }, { action: 'toggle' }, { action: 'toggle', enabled: 1 },
    { action: 'sync', confirm: true }, { action: 'pull', importAll: true }, { action: 'mappings', sessionId: 'x' },
    { action: 'pull', limit: 0 }, { action: 'pull', limit: 101 }, { action: 'pull', limit: '1' },
    { action: 'pull', sessionId: 'sid', cursor: 'page' }, { action: 'pull', sessionId: 'sid', limit: 1 },
    { action: 'repair', confirmMapping: false }, { action: 'repair', confirmMapping: 'true' },
    { action: 'map', mapping: { remotePrefix: '/', localPrefix: '/', remotePlatform: 'freebsd' } },
    { action: 'map', mapping: { remotePrefix: '', localPrefix: '/', remotePlatform: 'linux' } },
    { action: 'map', mapping: { remotePrefix: '/', localPrefix: '/', remotePlatform: 'linux', extra: true } },
    { action: 'map', mapping: { id: 'not-a-uuid', remotePrefix: '/', localPrefix: '/', remotePlatform: 'linux' } },
    { action: 'unmap', mappingId: 'not-a-uuid' }, { action: 'test-auth', accountName: 'ignored' },
    { action: 'set-auth', auth: 'token' }, { action: 'set-auth', auth: 'auto', accountName: 'UPPER' },
    { action: 'set-auth', auth: 'auto', connectionString: '' },
    { action: 'set-auth', auth: 'auto', connectionString: 'secret', clearConnectionString: true },
    { action: 'set-auth', auth: 'auto', connectionRef: 'arbitrary' },
    { action: 'set-defaults', pollSeconds: 29 }, { action: 'set-defaults', pollSeconds: 86401 },
    { action: 'set-defaults', pollSeconds: 30.5 }, { action: 'set-defaults', defaultEnabled: 'false' },
    { action: 'set-defaults', unknown: false },
  ];
  for (const value of invalid) assert.throws(() => parseCloudRequest(value), code('INVALID_REQUEST'));
  const invalidVersion: unknown[] = [{ request: { action: 'status' } }, { v: 2, request: { action: 'status' } }, { v: 1, request: { action: 'status' }, actorId: 'sid' }, { v: 1, action: 'status' }];
  for (const value of invalidVersion) assert.throws(() => parseCloudPayload(value), code('INVALID_REQUEST'));
});

test('takeover, resurrection and removal cannot bypass explicit literal confirmation', () => {
  for (const action of ['takeover', 'resurrect', 'remove']) {
    for (const confirm of [undefined, false, 'true', 1]) {
      assert.throws(() => parseCloudRequest({ action, ...(confirm === undefined ? {} : { confirm }) }), code('CONFIRM_REQUIRED'));
    }
  }
  for (const acknowledgeAttachmentsRetained of [undefined, false, 'true']) {
    assert.throws(() => parseCloudRequest({ action: 'remove', confirm: true, ...(acknowledgeAttachmentsRetained === undefined ? {} : { acknowledgeAttachmentsRetained }) }), code('CONFIRM_REQUIRED'));
  }
});

test('JSON snapshot is lossless and accepts only finite, safe numbers and plain dense data', () => {
  const shared = { value: 1 }; const source = { nested: [null, false, true, 'é😀', 0.125], left: shared, right: shared };
  assert.deepEqual(boundedJson(source), source);
  const snapshot = boundedJson(source) as typeof source;
  assert.notEqual(snapshot.left, source.left); assert.notEqual(snapshot.left, snapshot.right);
  assert.deepEqual(boundedJson(Object.assign(Object.create(null) as object, { safe: true })), { safe: true });
  const sparse = Array(2); sparse[1] = 'x';
  const cycle: unknown[] = []; cycle.push(cycle);
  const invalid: unknown[] = [undefined, NaN, Infinity, -Infinity, -0, Number.MAX_SAFE_INTEGER + 1, 1n, Symbol('x'), () => 1,
    new Date(), new Map(), new Set(), new (class { value = 1; })(), Object.create({ inherited: true }),
    sparse, cycle, [undefined], { value: undefined }, Object.assign([], { extra: true }),
    Object.defineProperty({}, 'hidden', { value: true }), Object.defineProperty({}, Symbol('secret'), { value: true, enumerable: true }),
    JSON.parse('{"__proto__":{"secret":true}}'), { constructor: 'secret' }, { prototype: true },
  ];
  for (const value of invalid) assert.throws(() => boundedJson(value), code('LIMIT'));
});

test('neither request nor result validation invokes accessors or toJSON hooks', () => {
  let reads = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { reads++; throw new Error('secret'); } });
  const serializer = { toJSON() { reads++; return { action: 'status' }; } };
  assert.throws(() => boundedJson(getter), code('LIMIT'));
  assert.throws(() => cloudSuccess(getter), code('LIMIT'));
  assert.throws(() => boundedJson(serializer), code('LIMIT'));
  assert.throws(() => parseCloudRequest(Object.defineProperty({}, 'action', { enumerable: true, get() { reads++; return 'status'; } })), code('INVALID_REQUEST'));
  assert.equal(reads, 0);
});

test('JSON limits account for UTF-8, escaping, depth, node count and outgoing envelope overhead', () => {
  assert.equal(boundedJson('x'.repeat(CLOUD_JSON_MAX_BYTES - 2)), 'x'.repeat(CLOUD_JSON_MAX_BYTES - 2));
  assert.throws(() => boundedJson('x'.repeat(CLOUD_JSON_MAX_BYTES - 1)), code('LIMIT'));
  assert.throws(() => boundedJson('😀'.repeat(70000)), code('LIMIT'));
  assert.throws(() => boundedJson('\n'.repeat(CLOUD_JSON_MAX_BYTES / 2)), code('LIMIT'));
  assert.throws(() => cloudSuccess('x'.repeat(CLOUD_JSON_MAX_BYTES - 2)), code('LIMIT'));
  let deep: unknown = null;
  for (let i = 0; i < CLOUD_JSON_MAX_DEPTH; i++) deep = [deep];
  assert.doesNotThrow(() => boundedJson(deep));
  assert.throws(() => boundedJson([deep]), code('LIMIT'));
  assert.doesNotThrow(() => boundedJson(Array(CLOUD_JSON_MAX_NODES - 1).fill(null)));
  assert.throws(() => boundedJson(Array(CLOUD_JSON_MAX_NODES).fill(null)), code('LIMIT'));
});

test('public errors use fixed branded codes and never inspect arbitrary provider errors or getters', () => {
  let reads = 0;
  const hostile = Object.fromEntries(['message', 'code', 'name', 'cause', 'toJSON'].map(key => [key, null]));
  for (const key of Object.keys(hostile)) Object.defineProperty(hostile, key, { get() { reads++; throw new Error('synthetic-secret'); } });
  assert.deepEqual(publicCloudError(hostile), { code: 'OPERATION_FAILED', message: 'The cloud operation failed.' });
  assert.equal(publicCloudError({ code: 'CANCELLED', message: 'synthetic-secret' }).code, 'OPERATION_FAILED');
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
  assert.equal(publicCloudError(proxy).code, 'OPERATION_FAILED');
  for (const known of ['INVALID_REQUEST', 'SETUP_NEEDED', 'FORBIDDEN', 'CONFIRM_REQUIRED', 'OPERATION_FAILED', 'CANCELLED', 'CAPACITY', 'LIMIT'] as const) {
    const error = new CloudControlError(known);
    Object.defineProperty(error, 'message', { get() { reads++; return 'synthetic-secret'; } });
    Object.defineProperty(error, 'code', { get() { reads++; return 'synthetic-secret'; } });
    assert.equal(publicCloudError(error).code, known);
    assert.doesNotMatch(publicCloudError(error).message, /synthetic-secret/u);
  }
  assert.equal(reads, 0);
  assert.equal(publicCloudError(new CloudControlError('synthetic-secret' as CloudErrorCode)).code, 'OPERATION_FAILED');
});

test('public request typing preserves literal action discrimination and confirmation requirements', () => {
  const sync: Extract<CloudRequest, { action: 'sync' }> = { action: 'sync' };
  assert.equal(sync.action, 'sync');
  // @ts-expect-error confirmation is a required literal true
  const missing: CloudRequest = { action: 'takeover' };
  // @ts-expect-error auth cannot be written through an unrelated action
  const extra: CloudRequest = { action: 'status', connectionString: 'secret' };
  void missing; void extra;
});
