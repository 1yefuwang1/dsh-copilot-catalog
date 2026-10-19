import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { HostConnectionService, serverResponseSchema, type ConnectionFetchRoute, type HostConnectionHandle, type PeerAdmission } from '@deepseek-ai/dsh-client-connection';
import { registerCloudRpc, CLOUD_ACTION_ENDPOINT as ACTION, CLOUD_STATUS_ENDPOINT as STATUS, CLOUD_RPC_MAX_FLIGHTS } from '../src/rpc.js';
import { CloudControlError, CLOUD_JSON_MAX_BYTES, type CloudControllerPort, type CloudEnvelope, type CloudResponse } from '../src/protocol.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const authority = '127.0.0.1:45127'; const origin = `http://${authority}`; const cookie = 'synthetic-browser=authenticated';
function request(endpoint: string, payload: unknown, options: { body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal; method?: string; wireMethod?: string } = {}): Request {
  const body = Object.hasOwn(options, 'body') ? options.body : JSON.stringify({ type: 'client-request', rpcId: 'test-call', method: options.wireMethod ?? endpoint, payload });
  return new Request(`${origin}/api/${endpoint}`, { method: options.method ?? 'POST', headers: { host: authority, origin, cookie, 'content-type': 'application/json', ...options.headers }, body,
    ...(options.signal ? { signal: options.signal } : {}), ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
}
async function envelope(response: Response): Promise<CloudEnvelope> {
  assert.equal(response.status, 200);
  const wire: unknown = await response.json();
  assert.equal(serverResponseSchema.safeParse(wire).success, true);
  const value = wire as { type: string; rpcId: string; result: { ok: boolean; value: CloudEnvelope } };
  assert.equal(value.type, 'server-response'); assert.equal(value.result.ok, true);
  return value.result.value;
}
async function failure(response: Response, code: string): Promise<void> {
  const value = await envelope(response); assert.equal(value.ok, false);
  if (!value.ok) assert.equal(value.error.code, code);
}

async function fixture(t: TestContext, controller: CloudControllerPort) {
  const host = new Context(); const connectionOwner = createScope(host, {}); await connectionOwner.ctx.fiber.await();
  const auth = {
    isAuthenticated(input: Request) { return input.headers.get('host') === authority && input.headers.get('cookie') === cookie; },
    authenticateApi() { return undefined; },
  } as unknown as ConstructorParameters<typeof HostConnectionService>[2];
  new HostConnectionService(connectionOwner.ctx, [], auth);
  const connection = host.get('connection') as HostConnectionHandle;
  const gateway = createScope(host, {});
  gateway.ctx.get('connection')!.rpc.intercept('/api', endpoint => endpoint === 'session/unrelated', async () => ({ ok: true, value: 'gateway' }));
  const owner = createScope(host, {}); const stop = registerCloudRpc(owner.ctx, controller);
  const shared = connection.createSharedFetchHandler('/api');
  const send = (incoming: Request) => {
    const admission = connection.admit(incoming);
    return 'rejection' in admission ? Promise.resolve(new Response('rejected', { status: admission.rejection })) : shared.fetch(incoming, admission.peer);
  };
  t.after(async () => { await stop(); await owner.dispose(); await gateway.dispose(); await connectionOwner.dispose(); });
  return { host, owner, connection, shared, send, stop };
}

async function directFixture(t: TestContext, controller: CloudControllerPort) {
  const host = new Context(); const owner = createScope(host, {}); const peerContext = new Context();
  const peer = { id: 'browser', ctx: peerContext, principal: { kind: 'owner' }, signal: new AbortController().signal } as unknown as HostConnectionHandle['browserPeer'];
  let admission: PeerAdmission = { peer };
  const routes = new Map<string, ConnectionFetchRoute>(); let intercepted = 0;
  host.provide('connection', {
    browserPeer: peer, admit() { return admission; },
    fetch: { register(route: ConnectionFetchRoute) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } },
    rpc: { intercept() { intercepted++; throw new Error('singleton interceptor must not be touched'); } },
  } as unknown as HostConnectionHandle);
  const stop = registerCloudRpc(owner.ctx, controller);
  const route = routes.get(`/api/${ACTION}`)!;
  t.after(async () => { await stop(); await owner.dispose(); });
  return { routes, route, peer, stop, setAdmission(value: PeerAdmission) { admission = value; }, get intercepted() { return intercepted; } };
}

test('optional connection is a no-op; registration owns only two exact streaming POST routes', async t => {
  const ctx = new Context(); let calls = 0;
  const stop = registerCloudRpc(ctx, { async execute() { calls++; return null; } }); await stop(); await stop(); assert.equal(calls, 0);
  const f = await directFixture(t, { async execute() { return null; } });
  assert.deepEqual([...f.routes.keys()].sort(), [`/api/${ACTION}`, `/api/${STATUS}`].sort()); assert.equal(f.intercepted, 0);
  for (const route of f.routes.values()) { assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'streaming'); }
  await f.stop(); await f.stop(); assert.equal(f.routes.size, 0);
});

test('real public SDK routes preserve singleton gateway, invoke once, and never resolve agents', async t => {
  const calls: Array<{ request: unknown; context: Parameters<CloudControllerPort['execute']>[1] }> = [];
  const f = await fixture(t, { async execute(input, context) { calls.push({ request: input, context }); return { kind: input.action, safe: true }; } });
  f.host.provide('sessionController', { resolveAgent() { throw new Error('must not resolve an Agent'); } });
  for (const [endpoint, input] of [[STATUS, { action: 'status' }], [STATUS, { action: 'mappings' }], [ACTION, { action: 'sync', sessionId: 'cold-session' }], [ACTION, { action: 'pull' }], [ACTION, { action: 'toggle', enabled: true }]] as const) {
    assert.deepEqual(await envelope(await f.send(request(endpoint, { v: 1, request: input }))), { v: 1, ok: true, data: { kind: input.action, safe: true } });
  }
  assert.equal(calls.length, 5); assert.ok(calls.every(call => call.context.origin === 'rpc' && !Object.hasOwn(call.context, 'sessionId')));
  assert.ok(calls.every(call => call.context.signal instanceof AbortSignal));
  assert.deepEqual(calls[2]!.request, { action: 'sync', sessionId: 'cold-session' }); assert.deepEqual(calls[3]!.request, { action: 'pull' });
  const gateway = await f.send(request('session/unrelated', {})); const wire = await gateway.json() as { result: unknown };
  assert.deepEqual(wire.result, { ok: true, value: 'gateway' });
  assert.equal((await f.send(request(`${ACTION}/other`, {}))).status, 404);
  await f.stop(); assert.equal((await f.send(request(ACTION, {}))).status, 404);
  assert.equal((await f.send(request('session/unrelated', {}))).status, 200);
});

test('admission and exact owner browser identity are checked before any body read', async t => {
  let calls = 0; const f = await directFixture(t, { async execute() { calls++; return null; } });
  const variants: PeerAdmission[] = [{ rejection: 401 }, { rejection: 403 },
    { peer: { ...f.peer, principal: { kind: 'observer' } } as unknown as typeof f.peer },
    { peer: { ...f.peer, id: 'other-owner' } as typeof f.peer },
    { peer: { ...f.peer, ctx: new Context() } },
  ];
  for (const admission of variants) {
    f.setAdmission(admission);
    let cancelled = 0;
    const body = new ReadableStream({ start(controller) { controller.close(); }, cancel() { cancelled++; } });
    const incoming = request(ACTION, undefined, { body });
    const response = await f.route.fetch(incoming);
    if ('rejection' in admission) assert.equal(response.status, admission.rejection);
    else await failure(response, 'FORBIDDEN');
    assert.equal(incoming.bodyUsed, false); assert.equal(cancelled, 0);
  }
  assert.equal(calls, 0);
});

test('real Host and Origin fence rejects unauthenticated requests beside cloud routes', async t => {
  let calls = 0; const f = await fixture(t, { async execute() { calls++; return null; } });
  for (const [headers, status] of [[{ cookie: '' }, 401], [{ origin: 'http://attacker.invalid' }, 403], [{ host: 'attacker.invalid', origin: 'http://attacker.invalid' }, 403]] as const) {
    const incoming = request(ACTION, { v: 1, request: { action: 'status' } }, { headers });
    assert.equal((await f.send(incoming)).status, status); assert.equal(incoming.bodyUsed, false);
  }
  assert.equal(calls, 0);
});

test('status endpoint is read-only and payload/carrier envelopes are exact', async t => {
  let calls = 0; const f = await fixture(t, { async execute() { calls++; return null; } });
  await failure(await f.send(request(STATUS, { v: 1, request: { action: 'toggle', enabled: true } })), 'FORBIDDEN');
  const invalid: unknown[] = [{ action: 'status' }, { v: 2, request: { action: 'status' } }, { v: 1, actorId: 'sid', request: { action: 'status' } }, { v: 1, request: { action: 'status', unknown: true } }];
  for (const input of invalid) await failure(await f.send(request(ACTION, input)), 'INVALID_REQUEST');
  await failure(await f.send(request(ACTION, { v: 1, request: { action: 'status' } }, { wireMethod: STATUS })), 'INVALID_REQUEST');
  await failure(await f.send(request(ACTION, {}, { body: JSON.stringify({ type: 'client-request', rpcId: 'id', method: ACTION, payload: {}, extra: true }) })), 'INVALID_REQUEST');
  await failure(await f.send(request(ACTION, {}, { body: '{' })), 'INVALID_REQUEST');
  await failure(await f.send(request(ACTION, { v: 1, request: { action: 'remove', confirm: true } })), 'CONFIRM_REQUIRED');
  assert.equal(calls, 0);
});

test('bounded streaming bodies reject declared/actual oversize, invalid UTF-8 and unsuitable media types', async t => {
  let calls = 0; const f = await fixture(t, { async execute() { calls++; return null; } });
  await failure(await f.send(request(ACTION, {}, { headers: { 'content-length': String(CLOUD_JSON_MAX_BYTES + 1) } })), 'LIMIT');
  await failure(await f.send(request(ACTION, {}, { body: ' '.repeat(CLOUD_JSON_MAX_BYTES + 1) })), 'LIMIT');
  await failure(await f.send(request(ACTION, {}, { body: new Uint8Array([0xff]) })), 'INVALID_REQUEST');
  assert.equal((await f.send(request(ACTION, {}, { headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal(calls, 0);
});

test('controller errors/results never expose raw errors, getters, serializers or unbounded data', async t => {
  let reads = 0;
  let mode = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { reads++; throw new Error('synthetic-secret'); } });
  const hostile = Object.defineProperty({}, 'message', { get() { reads++; throw new Error('synthetic-secret'); } });
  const values: unknown[] = [new Error('synthetic-secret'), hostile, new CloudControlError('SETUP_NEEDED'), getter, { toJSON() { reads++; return 'synthetic-secret'; } }, 'x'.repeat(CLOUD_JSON_MAX_BYTES)];
  const f = await fixture(t, { async execute() { const value = values[mode]; if (mode < 3) throw value; return value as CloudResponse; } });
  for (mode = 0; mode < values.length; mode++) {
    const response = await f.send(request(ACTION, { v: 1, request: { action: 'status' } }));
    const text = await response.clone().text(); assert.doesNotMatch(text, /synthetic-secret/u);
    await failure(response, mode < 2 ? 'OPERATION_FAILED' : mode === 2 ? 'SETUP_NEEDED' : 'LIMIT');
  }
  assert.equal(reads, 0);
});

test('cancellation releases responses and teardown even for never-settling controller and late provider rejection', { timeout: 2000 }, async t => {
  const started = deferred(); const provider = deferred<CloudResponse>(); let signal: AbortSignal | undefined;
  const f = await fixture(t, { async execute(_input, context) { signal = context.signal; started.resolve(); return provider.promise; } });
  const abort = new AbortController(); const pending = f.send(request(ACTION, { v: 1, request: { action: 'sync', sessionId: 'cold' } }, { signal: abort.signal }));
  await started.promise; abort.abort(new Error('synthetic-secret-reason'));
  await failure(await pending, 'CANCELLED'); assert.equal(signal!.aborted, true);
  await f.stop(); provider.reject(new Error('synthetic-secret-late')); await setImmediate();
});

test('capacity caps outstanding provider work, including abandoned cancelled providers', { timeout: 3000 }, async t => {
  const providers = Array.from({ length: CLOUD_RPC_MAX_FLIGHTS }, () => deferred<CloudResponse>());
  const started = deferred(); let calls = 0;
  const f = await fixture(t, { async execute() { const index = calls++; if (calls === CLOUD_RPC_MAX_FLIGHTS) started.resolve(); return providers[index]!.promise; } });
  const aborts = providers.map(() => new AbortController());
  const pending = aborts.map(abort => f.send(request(ACTION, { v: 1, request: { action: 'sync', sessionId: 'cold' } }, { signal: abort.signal })));
  await started.promise;
  await failure(await f.send(request(ACTION, { v: 1, request: { action: 'status' } })), 'CAPACITY');
  for (const abort of aborts) abort.abort();
  for (const response of await Promise.all(pending)) await failure(response, 'CANCELLED');
  await failure(await f.send(request(ACTION, { v: 1, request: { action: 'status' } })), 'CAPACITY');
  assert.equal(calls, CLOUD_RPC_MAX_FLIGHTS);
  await f.stop(); for (const provider of providers) provider.reject(new Error('late')); await setImmediate();
});

test('scope teardown cancels stalled body reads without awaiting a non-settling stream cancel', { timeout: 2000 }, async t => {
  let calls = 0; const reading = deferred();
  const f = await fixture(t, { async execute() { calls++; return null; } });
  const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); return new Promise<void>(() => undefined); }, cancel() { return new Promise<void>(() => undefined); } });
  const pending = f.send(request(ACTION, undefined, { body })); await reading.promise;
  await f.stop(); await failure(await pending, 'CANCELLED'); assert.equal(calls, 0);
});
