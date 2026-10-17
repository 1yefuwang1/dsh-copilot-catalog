import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { createScope } from '@deepseek-ai/dsh-scope';
import { registerWorktreeRpc, WORKTREE_RPC_ENDPOINT } from '../dist/rpc.js';
import { WorktreeController, type Invocation, type ControllerDependencies } from '../dist/service.js';
import type { WorktreeRequest, WorktreeRecord, OperationRecord } from '../dist/types.js';
import type { SessionEvent, Session } from '@deepseek-ai/dsh-session';
import { WorktreeError } from '../dist/errors.js';
import type { HostDouble } from './controller-types.js';
import type { registerQuietRpcRoute as RegisterRoute } from '../dist/quiet-rpc.js';
type RouteHandler = Parameters<typeof RegisterRoute>[2];
interface RouteEntry { endpoint: string; handler: RouteHandler; flights?: Set<Promise<HostDouble>> }
// The direct transport seam deliberately accepts and returns non-JSON hostile values.
type RpcResponse = HostDouble;


function table<T>() { const map = new Map<string,T>(); return { map, get: (key: string) => map.get(key), entries: () => map.entries(), async put(key: string, value: T) { map.set(key, structuredClone(value)); }, async delete(key: string) {return map.delete(key);} }; }
// In-process handler seam, NOT a fake SDK interceptor registry. Native Fetch
// transport is covered against the real public SDK in integration/http-rpc.test.ts.
// Keep raw JS payloads here: JSON.stringify would conceal getters, Dates and NaN.
function directRpcRegistry(browserPeer: HostDouble) {
  const registrations = new Set<RouteEntry>(); let unregisters = 0;
  return {
    browserPeer,
    registerRoute(owner: Context, endpoint: string, handler: RouteHandler) {
      assert.ok(owner instanceof Context); assert.equal(endpoint, WORKTREE_RPC_ENDPOINT);
      const entry: RouteEntry & {flights: Set<Promise<RpcResponse>>} = { endpoint, handler, flights: new Set() }; registrations.add(entry);
      let disposal: Promise<void> | undefined;
      return () => disposal ??= (async () => { unregisters++; registrations.delete(entry); await Promise.allSettled([...entry.flights!]); })();
    },
    dispatch(payload: unknown, { endpoint = WORKTREE_RPC_ENDPOINT, signal = new AbortController().signal, peer = browserPeer }: {endpoint?: string; signal?: AbortSignal; peer?: HostDouble} = {}): Promise<RpcResponse> {
      const entry = [...registrations].find(value => value.endpoint === endpoint);
      if (!entry) return Promise.resolve({ ok: false, error: { code: 'FALLBACK', message: 'Shared API retains this endpoint.', details: {} } });
      const flight = Promise.resolve().then(() => entry.handler(endpoint, payload, signal, peer)); entry.flights!.add(flight);
      void flight.then(() => entry.flights!.delete(flight), () => entry.flights!.delete(flight)); return flight;
    },
    get size() { return registrations.size; }, get unregisters() { return unregisters; },
  };
}
async function fixture(t: TestContext) {
  const host = new Context(); new SessionStore(host);
  const events: {session: Session; event: SessionEvent}[] = []; const actors = new Map<string,HostDouble>(); const scopes: ReturnType<typeof createScope>[] = []; const plans = new Map<string,{active:boolean;pending?:boolean}>(); const policies = new Map<string,string>(); const lookups: string[] = []; const invocations: {request: WorktreeRequest; invocation: Invocation}[] = []; const gitCalls: {name:string;actor:HostDouble;signal:AbortSignal}[] = [];
  host.on('session/event', (session, event) => events.push({ session, event }));
  host.provide('agents', { get: (id: string) => actors.get(id), list: () => [...actors.values()] });
  host.provide('sandboxPolicy', { resolve() { throw Error('Host default authority must never be read'); } });
  host.provide('planMode', { get: (value: HostDouble) => plans.get(value.id) ?? { active: false } });
  host.provide('sessionQuery', { async observeSession(id: string) { const value = actors.get(id); return { header: value.session.header, events: events.filter(e => e.session === value.session).map(e => e.event), projections: { values: {} }, [Symbol.dispose]() {} }; } });
  function actor(origin?: 'subagent') {
    const value: HostDouble = { id: SessionId(randomUUID()), options: { provider: 'github-copilot', model: 'gpt-6.1-sol' }, status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
    const scope = createScope(host.isolate('sandboxPolicy'), value); scopes.push(scope); value.ctx = scope.ctx; value.scope = scope;
    scope.ctx.provide('sandboxPolicy', { resolve: ({ session }: HostDouble) => { assert.equal(session, value.session); return { mode: policies.get(value.id) ?? 'danger-full-access', workspaceRoot: '/repo/project', sessionId: value.id }; } });
    value.session = scope.ctx.sessions.create(value.id, { meta: { cwd: '/repo/project', ...(origin ? { origin } : {}) } }); actors.set(value.id, value); return value;
  }
  const source = actor();
  const owner = createScope(host, {}); scopes.push(owner);
  const browserPeer = { id: 'browser-peer', principal: { kind: 'owner' }, ctx: host.isolate('sandboxPolicy'), async dispose() {} };
  browserPeer.ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/' }) });
  const connection = directRpcRegistry(browserPeer); host.provide('connection', connection);
  const resolver: {resolveAgent(id:string):Promise<HostDouble>} = { async resolveAgent(id) { lookups.push(id); const agent = actors.get(id); return agent ? { agent } : { error: { code: 'session/not-found', message: 'sensitive resolver diagnostic', details: { secret: 'private' } } }; } };
  host.provide('sessionController', resolver);
  const store = { worktrees: table<WorktreeRecord>(), operations: table<OperationRecord>(), async close() {} };
  const record: WorktreeRecord = { id: randomUUID(), operationId: randomUUID(), repoRoot: '/repo', commonDir: '/repo/.git', projectSubdir: 'project', checkoutRoot: '/managed/isolated', effectiveCwd: '/managed/isolated/project', remote: 'origin', remoteIdentity: 'opaque', remoteBranch: 'main', baseOid: 'a'.repeat(40), baseRef: 'refs/isolated/base', fetchedAt: 1, createdAt: 1, sessionIds: [], workspaceId: null, branch: null, protected: false, archived: false, state: 'ready', error: null };
  store.worktrees.map.set(record.id, record);
  const repository = { root: '/repo', commonDir: '/repo/.git', projectSubdir: 'project', head: record.baseOid, branch: 'main' };
  const git: Pick<ReturnType<NonNullable<ControllerDependencies['git']>>, 'discover' | 'remotes' | 'branches' | 'localBranches' | 'verify' | 'createBranch'> = {
    async discover() { return repository; }, async remotes() { return [{ name: 'origin', identity: 'opaque' }]; },
    async branches() { return { remote: 'origin', remoteIdentity: 'opaque', defaultBranch: 'main', branches: [{ name: 'main', oid: record.baseOid }], observedAt: 1 }; },
    async localBranches() { return { branchSource: 'local' as const, currentBranch: 'main', defaultBranch: 'main', branches: [{ name: 'main', oid: record.baseOid }], observedAt: 1 }; },
    async verify() { return { head: record.baseOid, branch: null, dirty: false, changes: 0, untracked: 0 }; },
    async createBranch(_record, name) { return { head: record.baseOid, branch: name, dirty: false, changes: 0, untracked: 0 }; },
  };
  const controller = new WorktreeController(owner.ctx, { root: '/managed', gitExecutable: 'git', defaultRemote: 'origin', defaultBranch: 'main', commandTimeoutMs: 1000, fetchTimeoutMs: 1000, operationTimeoutMs: 60000, maxSnapshotBytes: 1048576, maxFiles: 1000, maxRefBytes: 1048576 }, store, {
    localPath: async (value, path) => { assert.ok(actors.get(value.id) === value); return path ?? value.session.header.cwd!; },
    git: (value, signal, guard) => Object.fromEntries(Object.entries(git).map(([name, method]) => [name, async (...args: HostDouble[]) => { guard(); gitCalls.push({ name, actor: value, signal }); return (method as (...args:HostDouble[])=>unknown)(...args); }])) as ReturnType<NonNullable<ControllerDependencies['git']>>,
  });
  const delegate: Pick<WorktreeController, 'execute'> = { async execute(request, invocation) { invocations.push({ request, invocation }); return controller.execute(request, invocation); } };
  const stop = registerWorktreeRpc(owner.ctx, delegate, connection.registerRoute);
  t.after(async () => { await stop(); await controller.close(); for (const scope of scopes.reverse()) await scope.dispose(); });
  const payload = (request: unknown) => ({ v: 1, actorId: source.id, request });
  return { host, source, actor, actors, events, policies, plans, lookups, invocations, controller, delegate, resolver, connection, owner, stop, payload, record, store, git, gitCalls };
}

const outerCode = (value: RpcResponse, code: string) => { assert.equal(value.ok, false); assert.equal(value.error.code, code); assert.deepEqual(value.error.details, {}); };
const innerCode = (value: RpcResponse, code: string) => { assert.equal(value.ok, true); assert.equal(value.value.v, 1); assert.equal(value.value.ok, false); assert.equal(value.value.error.code, code); };

test('UI list/status/branches directly invoke the same caller-owned controller with plain versioned JSON and no chat events', async t => {
  const f = await fixture(t);
  for (const request of [{ action: 'list' as const }, { action: 'status' as const }, { action: 'branches' as const, remote: 'origin' }]) {
    const native = await f.controller.execute(request, { agent: f.source, origin: 'command' as const, signal: new AbortController().signal });
    const tool = await f.controller.execute(request, { agent: f.source, origin: 'tool' as const, signal: new AbortController().signal });
    const rpc = await f.connection.dispatch(f.payload(request));
    assert.deepEqual(rpc, { ok: true, value: { v: 1, ok: true, data: native } }); assert.deepEqual(rpc.value.data, tool);
    assert.deepEqual(JSON.parse(JSON.stringify(rpc)), rpc); assert.notEqual(rpc.value.data, native); assert.ok(!JSON.stringify(rpc).includes('~standard'));
  }
  assert.equal(f.invocations.length, 3); assert.ok(f.invocations.every(value => value.invocation.agent === f.source && value.invocation.origin === 'ui'));
  assert.ok(f.gitCalls.every(value => value.actor === f.source)); assert.equal(f.events.length, 0); assert.deepEqual(f.source.inbox, { nextTurn: [], nextStep: [] });
  outerCode(await f.connection.dispatch({}, { endpoint: 'session/list' }), 'FALLBACK');
  outerCode(await f.connection.dispatch({}, { endpoint: `${WORKTREE_RPC_ENDPOINT}/other` }), 'FALLBACK');
});

test('UI local branch RPC requires no remote and rejects mixed source selectors before actor lookup', async t => {
  const f = await fixture(t);
  f.git.remotes = async () => { throw Error('local-only repository must not inspect remotes'); };
  const response = await f.connection.dispatch(f.payload({ action: 'branches' as const, branchSource: 'local' as const }));
  assert.deepEqual(response, { ok: true, value: { v: 1, ok: true, data: { branchSource: 'local' as const, currentBranch: 'main', defaultBranch: 'main', items: [{ name: 'main', oid: f.record.baseOid }], observedAt: 1 } } });
  assert.deepEqual(f.gitCalls.map(call => call.name), ['discover', 'localBranches']);
  const lookups = f.lookups.length;
  for (const request of [
    { action: 'branches' as const, branchSource: 'local' as const, remote: 'origin' },
    { action: 'create' as const, branchSource: 'local' as const, localBranch: 'HEAD', operationId: randomUUID() },
    { action: 'create' as const, branchSource: 'local' as const, localBranch: 'main', localOid: 'HEAD', operationId: randomUUID() },
  ]) outerCode(await f.connection.dispatch(f.payload(request)), 'INVALID_RPC_REQUEST');
  assert.equal(f.lookups.length, lookups); assert.equal(f.events.length, 0);
});

test('wrong operator or forged context is refused before Actor lookup; missing Actor has no Host fallback', async t => {
  const f = await fixture(t);
  outerCode(await f.connection.dispatch(f.payload({ action: 'list' as const }), { peer: { ...f.connection.browserPeer, id: 'foreign' } }), 'FORBIDDEN');
  outerCode(await f.connection.dispatch(f.payload({ action: 'list' as const }), { peer: { ...f.connection.browserPeer, ctx: f.host } }), 'FORBIDDEN');
  outerCode(await f.connection.dispatch(f.payload({ action: 'list' as const }), { peer: { ...f.connection.browserPeer, principal: { kind: 'api' } } }), 'FORBIDDEN');
  assert.equal(f.lookups.length, 0); assert.equal(f.invocations.length, 0);
  const result = await f.connection.dispatch({ ...f.payload({ action: 'list' as const }), actorId: 'absent' }); outerCode(result, 'session/not-found');
  assert.ok(!JSON.stringify(result).includes('sensitive')); assert.equal(f.invocations.length, 0);
});

test('strict lossless bounded JSON and exact parseRequest reject authority injection before resolution', async t => {
  const f = await fixture(t); const valid = f.payload({ action: 'list' as const }); let readAccessor = false;
  const accessor = { ...valid }; Object.defineProperty(accessor, 'permissions', { enumerable: true, get() { readAccessor = true; return 'full'; } });
  const cycle = { ...valid }; (cycle as HostDouble).self = cycle;
  const invalid = [null, [], {}, { ...valid, v: 2 }, { v: 1, request: valid.request }, { ...valid, actorId: '' }, { ...valid, actorId: 'x'.repeat(257) }, { ...valid, actorId: 'line\nfeed' },
    ...['origin', 'actorContext', 'permissions', 'fullAccess', 'sessionId'].map(key => ({ ...valid, [key]: true })),
    ...[{ action: 'list' as const, permissions: 'full' }, { action: 'list' as const, sourceSessionId: f.source.id }, { action: 'branches' as const }, { action: 'status' as const, id: randomUUID(), operationId: randomUUID() }, { action: 'list' as const, limit: NaN }, { action: 'list' as const, limit: -0 }, { action: 'list' as const, repoPath: undefined }, { action: 'list' as const, limit: 2n }, { action: 'list' as const, limit: Infinity }].map(request => ({ ...valid, request })),
    { ...valid, request: new Date() }, { ...valid, request: Object.create({ action: 'list' as const }) }, { ...valid, request: { action: 'list' as const, toJSON() { return { action: 'list' as const }; } } },
    { ...valid, request: { action: 'list' as const, repoPath: 'x'.repeat(1048577) } }, accessor, cycle,
  ];
  for (const input of invalid) outerCode(await f.connection.dispatch(input), 'INVALID_RPC_REQUEST');
  assert.equal(readAccessor, false); assert.equal(f.lookups.length, 0); assert.equal(f.invocations.length, 0); assert.equal(f.events.length, 0);
});

test('source readonly/full-access and tool-only plan rules remain shared controller semantics, never Peer/Host authority', async t => {
  const f = await fixture(t); const branch = { action: 'branch' as const, id: f.record.id, name: 'new-branch' };
  f.policies.set(f.source.id, 'read-only');
  innerCode(await f.connection.dispatch(f.payload(branch)), 'FULL_ACCESS_REQUIRED');
  assert.equal(f.gitCalls.length, 0);
  assert.equal((await f.connection.dispatch(f.payload({ action: 'list' as const }))).value.ok, true);
  f.policies.set(f.source.id, 'danger-full-access'); f.plans.set(f.source.id, { active: true, pending: true });
  await assert.rejects(f.controller.execute(branch, { agent: f.source, origin: 'tool' as const, signal: new AbortController().signal }), error => error instanceof Error && 'code' in error && error.code === 'PLAN_MODE');
  const ui = await f.connection.dispatch(f.payload(branch)); assert.equal(ui.value.ok, true); assert.equal(ui.value.data.worktree.branch, 'new-branch');
  const command = await f.controller.execute(branch, { agent: f.source, origin: 'command' as const, signal: new AbortController().signal }); assert.deepEqual(ui.value.data, command);
  const subagent = f.actor('subagent'); innerCode(await f.connection.dispatch({ ...f.payload({ action: 'list' as const }), actorId: subagent.id }), 'SUBAGENT_SOURCE');
  f.resolver.resolveAgent = async () => ({ agent: { ...f.source } }); innerCode(await f.connection.dispatch(f.payload({ action: 'list' as const })), 'SESSION_CHANGED');
  assert.equal(f.events.length, 0);
});

test('cancellation before lookup, while resolving and during execution never generates command/message events', async t => {
  const f = await fixture(t); const cancelled = new AbortController(); cancelled.abort();
  outerCode(await f.connection.dispatch(f.payload({ action: 'list' as const }), { signal: cancelled.signal }), 'CANCELLED'); assert.equal(f.lookups.length, 0);
  let release!:() => void; let entered!:() => void; const entering = new Promise<void>(resolve => { entered = resolve; });
  f.resolver.resolveAgent = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { agent: f.source }; };
  const duringLookup = new AbortController(); const pending = f.connection.dispatch(f.payload({ action: 'list' as const }), { signal: duringLookup.signal });
  await entering; duringLookup.abort(); release(); outerCode(await pending, 'CANCELLED'); assert.equal(f.invocations.length, 0);
  f.resolver.resolveAgent = async () => ({ agent: f.source });
  let start!:() => void; const started = new Promise<void>(resolve => { start = resolve; });
  // An injected controller supplies the same cancellation lifetime contract without leaving hung provider work.
  f.delegate.execute = async (_request, invocation) => { start(); await new Promise<void>(resolve => invocation.signal.addEventListener('abort', () => resolve(), { once: true })); throw new WorktreeError('CANCELLED', 'The operation was cancelled; committed effects may remain.'); };
  const duringExecution = new AbortController(); const running = f.connection.dispatch(f.payload({ action: 'list' as const }), { signal: duringExecution.signal });
  await started; duringExecution.abort(); innerCode(await running, 'CANCELLED'); assert.equal(f.events.length, 0);
});

test('resolver and operation failures expose bounded redacted codes/messages without private details or raw provider output', async t => {
  const f = await fixture(t); const secret = ['https://', 'user:password', '@host/path?', 'token=', 'hidden github_', 'pat_private Authorization: Bearer hidden'].join('');
  f.resolver.resolveAgent = async () => { throw Error(secret); };
  const resolver = await f.connection.dispatch(f.payload({ action: 'list' as const })); outerCode(resolver, 'SESSION_RESOLUTION_FAILED'); assert.ok(!JSON.stringify(resolver).includes('hidden'));
  f.resolver.resolveAgent = async () => ({ agent: f.source });
  f.delegate.execute = async () => { throw Error(`raw environment GIT_TOKEN=hidden ${secret}`); };
  const raw = await f.connection.dispatch(f.payload({ action: 'list' as const })); innerCode(raw, 'OPERATION_FAILED'); assert.ok(!JSON.stringify(raw).includes('hidden'));
  f.delegate.execute = async () => { const error = new Error(secret); error.name = 'AbortError'; throw error; };
  const cancelled = await f.connection.dispatch(f.payload({ action: 'list' as const })); innerCode(cancelled, 'CANCELLED'); assert.ok(!JSON.stringify(cancelled).includes('hidden'));
  f.delegate.execute = async () => { throw new WorktreeError('GIT_FAILED', `raw GIT_TOKEN=hidden ${secret}`, { stderr: secret }); };
  const git = await f.connection.dispatch(f.payload({ action: 'list' as const })); innerCode(git, 'GIT_FAILED'); assert.ok(!JSON.stringify(git).includes('hidden')); assert.ok(!JSON.stringify(git).includes('https:'));
  f.delegate.execute = async () => { throw new WorktreeError('SETTINGS_CHANGED', `Selection changed ${secret}`.repeat(500), { secret }); };
  const recognized = await f.connection.dispatch(f.payload({ action: 'list' as const })); innerCode(recognized, 'SETTINGS_CHANGED'); assert.ok(recognized.value.error.message.length <= 4096); assert.ok(!JSON.stringify(recognized).includes('hidden')); assert.equal(recognized.value.error.details, undefined);
});

test('response is a detached JSON snapshot with an exact 1MiB cap; no coercion or ~standard helpers escape', async t => {
  const f = await fixture(t); const request = f.payload({ action: 'list' as const });
  const overhead = Buffer.byteLength(JSON.stringify({ v: 1, ok: true, data: { text: '' } }));
  f.delegate.execute = async () => ({ text: 'x'.repeat(1048576 - overhead) });
  const boundary = await f.connection.dispatch(request); assert.equal(boundary.value.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(boundary.value)), 1048576);
  f.delegate.execute = async () => ({ text: 'x'.repeat(1048577 - overhead) }); innerCode(await f.connection.dispatch(request), 'RESPONSE_LIMIT');
  for (const data of [{ bad: undefined }, { bad: NaN }, { bad: 1n }, { '~standard': { validate() {} } }, new Date(), { toJSON() { return 'coerced'; } }]) {
    f.delegate.execute = async () => data; innerCode(await f.connection.dispatch(request), 'RESPONSE_LIMIT');
  }
});

test('owned async disposer unregisters exactly once, aborts and awaits in-flight lookup/execution, and leaves shared API fallback intact', async t => {
  const f = await fixture(t); let release!:() => void; let enter!:() => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  f.resolver.resolveAgent = async () => { enter(); await new Promise<void>(resolve => { release = resolve; }); return { agent: f.source }; };
  const pending = f.connection.dispatch(f.payload({ action: 'list' as const })); await entered;
  let disposed = false; const disposal = f.stop().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(f.connection.size, 0); assert.equal(disposed, false);
  outerCode(await f.connection.dispatch(f.payload({ action: 'list' as const })), 'FALLBACK'); release(); outerCode(await pending, 'CANCELLED'); await disposal;
  await f.stop(); await f.owner.dispose(); assert.equal(f.connection.unregisters, 1); assert.equal(f.invocations.length, 0);
});

test('scope disposal cancels execution and awaits channel quiescence without disposing the source Actor', async t => {
  const f = await fixture(t); let start!:() => void; let release!:() => void; const started = new Promise<void>(resolve => { start = resolve; }); let signal!:AbortSignal;
  f.delegate.execute = async (_request, invocation) => { signal = invocation.signal; start(); await new Promise<void>(resolve => { release = resolve; }); return {}; };
  const pending = f.connection.dispatch(f.payload({ action: 'list' as const })); await started;
  let disposed = false; const disposal = f.owner.dispose().then(() => { disposed = true; }); await Promise.resolve();
  assert.equal(signal.aborted, true); assert.equal(f.connection.size, 0); assert.equal(disposed, false);
  let stopFinished = false; const duringDisposal = f.stop().then(() => { stopFinished = true; }); await Promise.resolve(); assert.equal(stopFinished, false);
  release(); innerCode(await pending, 'CANCELLED'); await disposal; await duringDisposal;
  const stopped = f.stop(); assert.ok(stopped instanceof Promise); assert.equal(f.stop(), stopped); await stopped;
  assert.equal(f.connection.unregisters, 1); assert.equal(f.actors.get(f.source.id), f.source); assert.equal(f.events.length, 0);
});
