import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { HostConnectionService, serverResponseSchema, type ConnectionFetchRoute, type HostConnectionHandle, type PeerAdmission } from '@deepseek-ai/dsh-client-connection';
import { registerCloudRpc, CLOUD_ACTION_ENDPOINT, CLOUD_STATUS_ENDPOINT, CLOUD_RPC_MAX_FLIGHTS } from '../src/rpc.js';
import { CLOUD_IMPORT_ENDPOINT, type CloudImportControllerPort, type CloudImportResponse } from '../src/import/protocol.js';
import { CLOUD_JSON_MAX_BYTES } from '../src/protocol.js';

const authority = '127.0.0.1:45128', origin = `http://${authority}`, cookie = 'synthetic-browser=authenticated';
const admission: CloudImportResponse = { version: 2, kind: 'import-admission', sessionId: 'original', reserved: false, ready: true, continued: true };
function request(payload: unknown = { v: 1, request: { action: 'import-admission', sessionId: 'original' } }, options: { endpoint?: string; headers?: Record<string, string>; signal?: AbortSignal; body?: BodyInit; wireMethod?: string } = {}) {
  const endpoint = options.endpoint ?? CLOUD_IMPORT_ENDPOINT;
  const body = options.body ?? JSON.stringify({ type: 'client-request', rpcId: 'import-call', method: options.wireMethod ?? endpoint, payload });
  return new Request(`${origin}/api/${endpoint}`, { method: 'POST', headers: { host: authority, origin, cookie, 'content-type': 'application/json', ...options.headers }, body, ...(options.signal ? { signal: options.signal } : {}), ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
}
async function value(response: Response) {
  assert.equal(response.status, 200); const raw: unknown = await response.json(); assert.equal(serverResponseSchema.safeParse(raw).success, true);
  return (raw as { result: { value: { v: number; ok: boolean; data?: unknown; error?: { code: string; message: string } } } }).result.value;
}
async function real(t: TestContext, imports: CloudImportControllerPort) {
  const ctx = new Context(), owner = createScope(ctx, {}); await owner.ctx.fiber.await();
  new HostConnectionService(owner.ctx, [], { isAuthenticated(input: Request) { return input.headers.get('host') === authority && input.headers.get('cookie') === cookie; }, authenticateApi() { return undefined; } } as unknown as ConstructorParameters<typeof HostConnectionService>[2]);
  const connection = ctx.get('connection') as HostConnectionHandle, plugin = createScope(ctx, {});
  let oldCalls = 0; const stop = registerCloudRpc(plugin.ctx, { async execute() { oldCalls++; return { kind: 'legacy' }; } }, imports);
  const handler = connection.createSharedFetchHandler('/api');
  t.after(async () => { await stop(); await plugin.dispose(); await owner.dispose(); });
  return { ctx, connection, stop, get oldCalls() { return oldCalls; }, send(input: Request) { const peer = connection.admit(input); return 'rejection' in peer ? Promise.resolve(new Response('refused', { status: peer.rejection })) : handler.fetch(input, peer.peer); } };
}
async function direct(t: TestContext, imports: CloudImportControllerPort) {
  const ctx = new Context(), scope = createScope(ctx, {}), peerCtx = new Context();
  const peer = { id: 'browser', ctx: peerCtx, principal: { kind: 'owner' }, signal: new AbortController().signal } as unknown as HostConnectionHandle['browserPeer'];
  let admitted: PeerAdmission = { peer }; const routes = new Map<string, ConnectionFetchRoute>();
  ctx.provide('connection', { browserPeer: peer, admit() { return admitted; }, fetch: { register(route: ConnectionFetchRoute) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } } as unknown as HostConnectionHandle);
  const stop = registerCloudRpc(scope.ctx, { async execute() { throw new Error('Legacy port must not receive import data'); } }, imports);
  t.after(async () => { await stop(); await scope.dispose(); });
  return { routes, peer, stop, set(value: PeerAdmission) { admitted = value; }, send(input: Request) { return routes.get(`/api/${CLOUD_IMPORT_ENDPOINT}`)!.fetch(input); } };
}

test('real public owner-browser import RPC stays separate, versioned and never resolves an Agent or legacy port', async t => {
  const calls: Parameters<CloudImportControllerPort['execute']>[] = [];
  const f = await real(t, { async execute(...args) { calls.push(args); return admission; } });
  f.ctx.provide('sessionController', { resolveAgent() { assert.fail('route cannot resolve a permission/target Agent'); } });
  const result = await value(await f.send(request())); assert.deepEqual(result, { v: 1, ok: true, data: admission });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0]?.[0], { action: 'import-admission', sessionId: 'original' });
  assert.equal(calls[0]?.[1].origin, 'rpc'); assert.equal(Object.hasOwn(calls[0]![1], 'sessionId'), false); assert.equal(f.oldCalls, 0);
  assert.equal((await f.send(request(undefined, { endpoint: CLOUD_IMPORT_ENDPOINT + '/other' }))).status, 404);
  const legacy = await value(await f.send(request({ v: 1, request: { action: 'status' } }, { endpoint: CLOUD_STATUS_ENDPOINT }))); assert.equal(legacy.ok, true); assert.equal(f.oldCalls, 1);
});

test('import exact owner identity is enforced BEFORE reading any request body', async t => {
  let calls = 0; const f = await direct(t, { async execute() { calls++; return admission; } });
  assert.deepEqual([...f.routes.keys()].sort(), [CLOUD_ACTION_ENDPOINT, CLOUD_STATUS_ENDPOINT, CLOUD_IMPORT_ENDPOINT].map(endpoint => '/api/' + endpoint).sort());
  for (const denied of [{ rejection: 401 }, { rejection: 403 }, { peer: { ...f.peer, principal: { kind: 'observer' } } }, { peer: { ...f.peer, id: 'other-owner' } }, { peer: { ...f.peer, ctx: new Context() } }] as PeerAdmission[]) {
    f.set(denied); let cancelled = 0;
    const input = request({}, { body: new ReadableStream({ start(controller) { controller.close(); }, cancel() { cancelled++; } }) });
    const response = await f.send(input);
    if ('rejection' in denied) assert.equal(response.status, denied.rejection); else assert.equal((await value(response)).error?.code, 'FORBIDDEN');
    assert.equal(input.bodyUsed, false); assert.equal(cancelled, 0);
  }
  assert.equal(calls, 0);
});

test('real Host/Origin, exact carriers and bounded import DTOs reject before controller effects', async t => {
  let calls = 0; const f = await real(t, { async execute() { calls++; return admission; } });
  const refusedHeaders: Record<string, string>[] = [{ cookie: '' }, { origin: 'http://attacker.invalid' }, { host: 'attacker.invalid', origin: 'http://attacker.invalid' }];
  for (const headers of refusedHeaders) assert.ok([401, 403].includes((await f.send(request(undefined, { headers }))).status));
  for (const payload of [{ v: 2, request: { action: 'import-admission', sessionId: 'original' } }, { v: 1, request: { action: 'import-admission' } }, { v: 1, request: { action: 'import-admission', sessionId: 'original', verified: true } }, { v: 1, request: { action: 'pull' } }]) assert.equal((await value(await f.send(request(payload)))).error?.code, 'INVALID_REQUEST');
  assert.equal((await value(await f.send(request(undefined, { wireMethod: CLOUD_ACTION_ENDPOINT })))).error?.code, 'INVALID_REQUEST');
  assert.equal((await f.send(request(undefined, { headers: { 'content-type': 'text/plain' } }))).status, 415);
  const oversized = await value(await f.send(request({}, { headers: { 'content-length': String(CLOUD_JSON_MAX_BYTES + 1) } })));
  assert.equal(oversized.error?.code, 'LIMIT'); assert.equal(calls, 0);
});

test('import route cancellation retains ignored providers in shared capacity until they settle', async t => {
  const resolvers: Array<(value: CloudImportResponse) => void> = []; let calls = 0;
  const f = await real(t, { execute() { calls++; return new Promise<CloudImportResponse>(resolve => resolvers.push(resolve)); } });
  for (let index = 0; index < CLOUD_RPC_MAX_FLIGHTS; index++) {
    const controller = new AbortController(), pending = f.send(request(undefined, { signal: controller.signal }));
    await setImmediate(); controller.abort(); assert.equal((await value(await pending)).error?.code, 'CANCELLED');
  }
  assert.equal(calls, CLOUD_RPC_MAX_FLIGHTS);
  assert.equal((await value(await f.send(request()))).error?.code, 'CAPACITY');
  for (const resolve of resolvers) resolve(admission); await setImmediate();
});

test('provider diagnostics are fixed/redacted on the new import channel and teardown unregisters only owned routes', async t => {
  const f = await real(t, { async execute() { throw new Error(['sensitive-', 'provider-diagnostic'].join('')); } });
  const result = await value(await f.send(request())); assert.equal(result.error?.code, 'OPERATION_FAILED'); assert.ok(!JSON.stringify(result).includes('sensitive-'));
  await f.stop(); assert.equal((await f.send(request())).status, 404);
});
