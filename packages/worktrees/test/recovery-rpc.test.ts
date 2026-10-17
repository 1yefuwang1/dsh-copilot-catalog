import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { registerRecoveryRpc, parseRecoveryPayload, RECOVERY_RPC_ENDPOINT } from '../dist/recovery-rpc.js';
import { registerQuietRpcRoute } from '../dist/quiet-rpc.js';
import { WorktreeError } from '../dist/errors.js';
import type { WorktreeCleanup } from '../dist/cleanup.js';
import type { HostDouble } from './controller-types.js';
import type { registerQuietRpcRoute as RegisterRoute } from '../dist/quiet-rpc.js';
type RouteHandler = Parameters<typeof RegisterRoute>[2];
interface RouteEntry { endpoint: string; handler: RouteHandler; flights?: Set<Promise<HostDouble>> }
// The direct transport seam deliberately accepts and returns non-JSON hostile values.
type RpcResponse = HostDouble;


const OID = 'a'.repeat(40);
const deferred = () => Promise.withResolvers<void>();
const outerCode = (value: RpcResponse, code: string) => { assert.equal(value.ok, false); assert.equal(value.error.code, code); assert.deepEqual(value.error.details, {}); };
const innerCode = (value: RpcResponse, code: string) => { assert.equal(value.ok, true); assert.equal(value.value.v, 1); assert.equal(value.value.ok, false); assert.equal(value.value.error.code, code); };

// Exact per-feature route seam, not a replacement singleton /api interceptor.
function registry(operator: HostDouble) {
  const rows = new Map<string, RouteEntry>(); let unregisters = 0;
  return { operator, browserPeer: operator, rows,
    registerRoute(owner: Context, endpoint: string, handler: RouteHandler) {
      assert.ok(owner instanceof Context); assert.equal(rows.has(endpoint), false); const entry: RouteEntry & {flights: Set<Promise<RpcResponse>>} = { endpoint, handler, flights: new Set() }; rows.set(endpoint, entry);
      let disposal: Promise<void> | undefined; return () => disposal ??= (async () => { unregisters++; rows.delete(endpoint); await Promise.allSettled([...entry.flights!]); })();
    },
    dispatch(payload: unknown, { endpoint = RECOVERY_RPC_ENDPOINT, peer = operator, signal = new AbortController().signal }: {endpoint?: string; signal?: AbortSignal; peer?: HostDouble} = {}): Promise<RpcResponse> {
      const entry = rows.get(endpoint); if (!entry) return Promise.resolve({ ok: false, error: { code: 'FALLBACK', message: 'Shared API retains this endpoint.', details: {} } });
      const flight = Promise.resolve().then(() => entry.handler(endpoint, payload, signal, peer)); entry.flights!.add(flight); void flight.then(() => entry.flights!.delete(flight), () => entry.flights!.delete(flight)); return flight;
    },
    get unregisters() { return unregisters; },
  };
}
async function fixture(t: TestContext) {
  const host = new Context(), owned = createScope(host, {}), sourceId = randomUUID(); const calls: [string, ...HostDouble[]][] = [], events: HostDouble[][] = [], lookups: string[] = [];
  host.on('session/event', (...args) => events.push(args));
  const operator: HostDouble = { id: 'authenticated-operator', principal: { kind: 'owner' }, ctx: new Context() }, connection = registry(operator); host.provide('connection', connection);
  host.provide('sessionController', { resolveAgent(id: string) { lookups.push(id); assert.fail('Recovery must not activate the historical Agent'); } });
  host.provide('agents', { get() { assert.fail('Quiet recovery RPC must not choose an Actor'); } });
  // Transport-level negative tests substitute invalid controller responses intentionally.
  const controller: { [K in 'info' | 'wait' | 'reopen']: (...args: Parameters<WorktreeCleanup[K]>) => Promise<unknown> } = {
    async info(id, signal, options) { calls.push(['info', id, signal, options]); return { sourceSessionId: id, worktreeId: null, cleanup: null, continuationSessionId: null, originalFolder: null, revision: 7 }; },
    async wait(id, after, signal) { calls.push(['wait', id, after, signal]); return { sourceSessionId: id, revision: after + 1 }; },
    async reopen(request, invocation) { calls.push(['reopen', request, invocation]); return { sourceSessionId: request.sourceSessionId, sessionId: randomUUID(), cwd: '/fixture/local', branch: request.localBranch }; },
  };
  const stop = registerRecoveryRpc(owned.ctx, controller as unknown as Pick<WorktreeCleanup, 'info' | 'wait' | 'reopen'>, connection.registerRoute);
  t.after(async () => { await stop(); await owned.dispose(); });
  const payload = (request: Record<string, unknown> = {}) => ({ v: 1, request: { action: 'reopen-info' as const, sourceSessionId: sourceId, ...request } });
  return { host, owned, sourceId, operator, connection, controller, stop, calls, events, lookups, payload };
}

test('recovery reads and Local reopening share a quiet versioned route with no historical resolveAgent or Actor', async t => {
  const f = await fixture(t);
  const info = await f.connection.dispatch(f.payload()); assert.equal(info.value.ok, true); assert.equal(info.value.data.sourceSessionId, f.sourceId);
  const page = await f.connection.dispatch(f.payload({ cursor: 'opaque-page', limit: 10 })); assert.equal(page.value.ok, true); assert.equal(f.calls[1]![3].cursor, 'opaque-page');
  const wait = await f.connection.dispatch({ ...f.payload(), after: 7 }); assert.equal(wait.value.data.revision, 8);
  const reopen = await f.connection.dispatch(f.payload({ action: 'reopen' as const, localBranch: 'main', localOid: OID })); assert.equal(reopen.value.ok, true);
  const invocation = f.calls.find(([kind]) => kind === 'reopen')![2]; assert.equal(invocation.origin, 'ui'); assert.equal(invocation.agent, undefined); assert.ok(invocation.signal instanceof AbortSignal);
  assert.deepEqual(f.lookups, []); assert.deepEqual(f.events, []); assert.ok(f.calls.every(call => call[1] === f.sourceId || call[1].sourceSessionId === f.sourceId));
});

test('authenticated operator and exact endpoint are checked before payload traversal or any cold read/admission', async t => {
  const f = await fixture(t); let traversed = 0;
  const payload = new Proxy(f.payload(), { ownKeys() { traversed++; throw Error('untrusted payload traversed'); } });
  for (const peer of [{ ...f.operator, id: 'foreign' }, { ...f.operator, ctx: f.host }]) outerCode(await f.connection.dispatch(payload, { peer }), 'FORBIDDEN');
  const handler = f.connection.rows.get(RECOVERY_RPC_ENDPOINT)!.handler;
  outerCode(await handler('session/remove', payload, new AbortController().signal, f.operator), 'FORBIDDEN');
  assert.equal(traversed, 0); assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0);
});

test('only strict bounded lossless v1 recovery requests are accepted; extra authority and other actions never reach controllers', async t => {
  const f = await fixture(t); let accessorRead = false; const accessor = f.payload(); Object.defineProperty(accessor, 'authority', { enumerable: true, get() { accessorRead = true; return 'full'; } });
  const cycle = f.payload(); (cycle as HostDouble).self = cycle;
  const invalid = [null, [], {}, { ...f.payload(), v: 2 }, { v: 1 }, { ...f.payload(), request: new Date() }, { ...f.payload(), request: Object.create({ action: 'reopen-info' as const }) }, accessor, cycle,
    ...['actorId', 'agent', 'origin', 'permissions', 'fullAccess', 'sessionId', 'holdInput'].map(key => ({ ...f.payload(), [key]: 'forged' })),
    ...['list', 'status', 'create', 'start', 'branch', 'archive', 'handoff', 'protect'].map(action => f.payload({ action })),
    f.payload({ sourceSessionId: '' }), f.payload({ sourceSessionId: 'x'.repeat(257) }), f.payload({ extra: true }), f.payload({ limit: 0 }), f.payload({ limit: 101 }),
    f.payload({ limit: NaN }), f.payload({ limit: -0 }), f.payload({ limit: Infinity }), f.payload({ limit: 2n }), f.payload({ limit: undefined }),
    f.payload({ action: 'reopen' as const, localBranch: 'main' }), f.payload({ action: 'reopen' as const, localBranch: 'main', localOid: 'HEAD' }),
    f.payload({ sourceSessionId: 'x'.repeat(1048577) }),
  ];
  for (const payload of invalid) { const response = await f.connection.dispatch(payload); assert.equal(response.ok, true); assert.equal(response.value.ok, false); assert.ok(['INVALID_RPC_REQUEST', 'INVALID_REQUEST'].includes(response.value.error.code)); }
  assert.equal(accessorRead, false); assert.equal(f.calls.length, 0); assert.equal(f.lookups.length, 0); assert.equal(f.events.length, 0);
  const accepted = parseRecoveryPayload(f.payload({ action: 'reopen' as const, localBranch: 'topic/name', localOid: OID })); assert.equal(accepted.request.localBranch, 'topic/name');
});

test('after belongs only to bounded nonnegative read revisions, never reopen or branch paging', async t => {
  const f = await fixture(t);
  for (const after of [-1, 0.5, NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) assert.throws(() => parseRecoveryPayload({ ...f.payload(), after }), error => error instanceof Error && 'code' in error && error.code === 'INVALID_RPC_REQUEST');
  for (const request of [{ action: 'reopen' as const, localBranch: 'main', localOid: OID }, { cursor: 'page' }, { limit: 10 }]) innerCode(await f.connection.dispatch({ ...f.payload(request), after: 0 }), 'INVALID_RPC_REQUEST');
  assert.deepEqual(parseRecoveryPayload({ ...f.payload(), after: Number.MAX_SAFE_INTEGER }), { request: f.payload().request, after: Number.MAX_SAFE_INTEGER });
  assert.equal(f.calls.length, 0);
});

test('cancellation before admission and after a committed controller result remains quiet and bounded', async t => {
  const f = await fixture(t); const abort = new AbortController(); abort.abort(); innerCode(await f.connection.dispatch(f.payload(), { signal: abort.signal }), 'CANCELLED'); assert.equal(f.calls.length, 0);
  const entered = deferred(), released = deferred(); let signal!:AbortSignal;
  f.controller.reopen = async (_request, invocation) => { signal = invocation.signal; entered.resolve(); await released.promise; return { sessionId: 'committed-target' }; };
  const caller = new AbortController(), flight = f.connection.dispatch(f.payload({ action: 'reopen' as const, localBranch: 'main', localOid: OID }), { signal: caller.signal });
  await entered.promise; caller.abort(); assert.equal(signal.aborted, true); released.resolve(); innerCode(await flight, 'CANCELLED'); assert.equal(f.events.length, 0); assert.equal(f.lookups.length, 0);
});

test('recognized errors are redacted without private details and unknown provider failures are generic', async t => {
  const f = await fixture(t); const secret = ['https://', 'user:password', '@host/path?', 'token=', 'hidden github_', 'pat_private Authorization: Bearer hidden'].join('');
  f.controller.info = async () => { throw Error(`raw environment ${secret}`); }; const unknown = await f.connection.dispatch(f.payload()); innerCode(unknown, 'OPERATION_FAILED'); assert.ok(!JSON.stringify(unknown).includes('hidden'));
  f.controller.info = async () => { throw new WorktreeError('GIT_FAILED', secret.repeat(1000), { stderr: secret, password: 'hidden' }); };
  const recognized = await f.connection.dispatch(f.payload()); innerCode(recognized, 'GIT_FAILED'); assert.equal(recognized.value.error.details, undefined); assert.ok(recognized.value.error.message.length <= 4096); assert.ok(!JSON.stringify(recognized).includes('hidden'));
  f.controller.info = async () => { const error = Error(secret); error.name = 'AbortError'; throw error; }; innerCode(await f.connection.dispatch(f.payload()), 'CANCELLED');
});

test('responses are detached lossless snapshots with an exact 1MiB cap and no coercion', async t => {
  const f = await fixture(t); const data = { branches: [{ name: 'main', oid: OID }] }; f.controller.info = async () => data;
  const response = await f.connection.dispatch(f.payload()); assert.deepEqual(response.value.data, data); assert.notEqual(response.value.data, data); data.branches[0]!.name = 'mutated'; assert.equal(response.value.data.branches[0].name, 'main');
  const overhead = Buffer.byteLength(JSON.stringify({ v: 1, ok: true, data: { text: '' } }));
  f.controller.info = async () => ({ text: 'x'.repeat(1048576 - overhead) }); const exact = await f.connection.dispatch(f.payload()); assert.equal(Buffer.byteLength(JSON.stringify(exact.value)), 1048576);
  f.controller.info = async () => ({ text: 'x'.repeat(1048577 - overhead) }); innerCode(await f.connection.dispatch(f.payload()), 'RESPONSE_LIMIT');
  for (const value of [{ bad: undefined }, { bad: NaN }, { bad: 1n }, new Date(), { toJSON() { return 'coerced'; } }]) { f.controller.info = async () => value; innerCode(await f.connection.dispatch(f.payload()), 'RESPONSE_LIMIT'); }
});

test('the 128 in-flight waiter bound rejects new reads before controller entry and caller abort drains capacity', async t => {
  const f = await fixture(t); let entered = 0; const full = deferred();
  f.controller.wait = async (_id, _after, signal) => { if (++entered === 128) full.resolve(); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); throw new WorktreeError('CANCELLED', 'Wait ended.'); };
  const aborts = Array.from({ length: 128 }, () => new AbortController()); const waits = aborts.map(abort => f.connection.dispatch({ ...f.payload(), after: 0 }, { signal: abort.signal })); await full.promise;
  outerCode(await f.connection.dispatch({ ...f.payload(), after: 0 }), 'WAITER_LIMIT'); assert.equal(entered, 128);
  for (const abort of aborts) abort.abort(); const results = await Promise.all(waits); for (const result of results) innerCode(result, 'CANCELLED');
  assert.equal((await f.connection.dispatch(f.payload())).value.ok, true);
});

test('async disposal aborts and drains in-flight reads exactly once while leaving unrelated exact routes and fallback untouched', async t => {
  const f = await fixture(t); const unrelatedStop = f.connection.registerRoute(f.owned.ctx, 'dsh-worktrees/other', async () => ({ ok: true, value: 'unrelated' })); t.after(unrelatedStop);
  const entered = deferred(), release = deferred(); let signal!:AbortSignal;
  f.controller.wait = async (_id, _after, value) => { signal = value; entered.resolve(); await release.promise; return {}; };
  const pending = f.connection.dispatch({ ...f.payload(), after: 0 }); await entered.promise;
  let done = false; const disposal = f.stop().then(() => { done = true; }); await Promise.resolve(); assert.equal(signal.aborted, true); assert.equal(done, false); assert.equal(f.connection.rows.has(RECOVERY_RPC_ENDPOINT), false);
  outerCode(await f.connection.dispatch(f.payload()), 'FALLBACK'); assert.deepEqual(await f.connection.dispatch({}, { endpoint: 'dsh-worktrees/other' }), { ok: true, value: 'unrelated' });
  release.resolve(); innerCode(await pending, 'CANCELLED'); await disposal; await f.stop(); assert.equal(f.connection.unregisters, 1); assert.equal(f.lookups.length, 0);
});

test('scope teardown owns the same drain promise and never resumes the old missing-cwd Agent', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(); let signal!:AbortSignal;
  f.controller.info = async (_id, value) => { signal = value; entered.resolve(); await release.promise; return {}; };
  const pending = f.connection.dispatch(f.payload()); await entered.promise;
  let done = false; const disposal = f.owned.dispose().then(() => { done = true; }); await Promise.resolve(); assert.equal(signal.aborted, true); assert.equal(done, false);
  const stopped = f.stop(); assert.equal(stopped, f.stop()); release.resolve(); innerCode(await pending, 'CANCELLED'); await disposal; await stopped; assert.equal(f.connection.unregisters, 1); assert.equal(f.lookups.length, 0); assert.equal(f.events.length, 0);
});

test('shared quiet transport registers one exact streaming POST feature route, never singleton /api, and authenticates before body work', async t => {
  const host = new Context(), owned = createScope(host, {}), registrations: HostDouble[] = [], operator = { id: 'operator', principal: { kind: 'owner' }, ctx: host }, calls: [string, ...HostDouble[]][] = [];
  let admitted: HostDouble = { peer: operator };
  host.provide('connection', { operator, browserPeer: operator, admit() { return admitted; }, fetch: { register(spec: HostDouble) { registrations.push(spec); return async () => { calls.push(['unregister']); }; } } });
  const stop = registerQuietRpcRoute(owned.ctx, RECOVERY_RPC_ENDPOINT, async (_method, payload) => { calls.push(['handler', payload]); return { ok: true, value: true }; }); t.after(async () => { await stop(); await owned.dispose(); });
  const spec = registrations[0]; assert.equal(registrations.length, 1); assert.equal(spec.path, `/api/${RECOVERY_RPC_ENDPOINT}`); assert.deepEqual(spec.methods, ['POST']); assert.equal(spec.requestBody, 'streaming'); assert.notEqual(spec.path, '/api');
  const request = (body: BodyInit, options: {headers?: Record<string,string>;signal?:AbortSignal} = {}) => new Request(`http://fixture.invalid/api/${RECOVERY_RPC_ENDPOINT}`, { method: 'POST', headers: { 'content-type': 'application/json', ...options.headers }, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  admitted = { rejection: 401 }; assert.equal((await spec.fetch(request('not JSON'))).status, 401); assert.equal(calls.length, 0);
  admitted = { peer: { ...operator, id: 'foreign' } }; const foreign = await (await spec.fetch(request('not JSON'))).json(); outerCode(foreign.result, 'FORBIDDEN'); assert.equal(calls.length, 0);
  // A disallowed admitted peer must be refused before the handler touches the body:
  // this body never yields, so a route that read it before authorizing would hang here.
  const blocked = new ReadableStream({ pull() { return new Promise(() => {}); } });
  const blockedRequest = request(blocked);
  const refused = await (await spec.fetch(blockedRequest)).json();
  outerCode(refused.result, 'FORBIDDEN');
  assert.equal(blockedRequest.bodyUsed, false, 'the guarded route never read the body');
  assert.equal(calls.length, 0);
  // The same streaming route reads a body only after the browser peer is admitted.
  admitted = { peer: operator };
  admitted = { peer: operator }; assert.equal((await spec.fetch(request('x', { headers: { 'content-length': String(1048576 + 4097) } }))).status, 413);
  const rpcId = randomUUID(); const valid = { type: 'client-request', rpcId, method: RECOVERY_RPC_ENDPOINT, payload: { v: 1, request: { action: 'reopen-info' as const, sourceSessionId: 'history' } } };
  const wire = await (await spec.fetch(request(JSON.stringify(valid)))).json(); assert.equal(wire.rpcId, rpcId); assert.equal(wire.type, 'server-response'); assert.deepEqual(wire.result, { ok: true, value: true });
  const wrong = await (await spec.fetch(request(JSON.stringify({ ...valid, method: 'session/list' })))).json(); outerCode(wrong.result, 'gateway/bad-request'); assert.equal(calls.filter(([kind]) => kind === 'handler').length, 1);
});
