import type { WorktreeCleanupSummary, WorktreeReopenInfo } from '../dist/types.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { parseRecoveryPayload, registerRecoveryRpc, RECOVERY_RPC_ENDPOINT } from '../dist/recovery-rpc.js';

// React stub hook inputs cross the VM contract.

type Listener = () => void;
type ComposerBlock = { reason: string } | undefined;
interface MockRequest {
  action: string; id?: string; operationId?: string; projectId?: string; folderId?: string;
  sessionId?: string; sourceSessionId?: string; branchSource?: string; remote?: string;
  remoteIdentity?: string; remoteBranch?: string; localBranch?: string; localOid?: string;
  repoPath?: string; cursor?: string; limit?: number; title?: string; folders?: string[];
  mainFolder?: string; firstPrompt?: string; sessionMode?: string; requireBlankSource?: boolean;
}
interface MockPayload { v: number; actorId?: string; request: MockRequest; after?: number; }
type RpcArgs = [channel: string, endpoint: string, payload: MockPayload, signal: AbortSignal];
interface SessionItem { retainedBy: Record<string, number>; title?: string; blank?: boolean; updatedAt?: number; }
interface SessionList { byId: Record<string, SessionItem>; }
// The client script is evaluated in a separate VM realm and deliberately exposes
// unexported implementations; dynamic values stop at this inspected VM contract.
type VmValue = any;










// Static assertions ignore emitted line wrapping; VM execution keeps the original text.
function staticSource(text: string): string { return text.replace(/\s+/g, ' '); }
const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
const start = source.indexOf('class WorktreeError extends Error');
const end = source.indexOf('function Icon(', start);
const p: VmValue = vm.runInNewContext(`(() => { const NS = 'worktrees.ui', PANEL = 'dsh-worktrees'; ${source.slice(start, end)}; return { cleanupData, recoveryRequest, recoveryData, validateData, projectData, requestRecovery, createRecoveryStore, recoveryBranches }; })()`, { AbortController, AbortSignal, crypto: webcrypto });
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const cleanup: WorktreeCleanupSummary = { phase: 'collected', inactivityDays: 10, lastActivityAt: 100, eligibleAfter: 200, reclaimedAt: 300, originalFolder: '/repo/project', recoveryRef: 'refs/dsh-worktrees/tree/gc-head', reason: null };
const info: WorktreeReopenInfo = { sourceSessionId: 'old', worktreeId: 'tree', cleanup, continuationSessionId: null, originalFolder: '/repo/project', repository: { root: '/repo', commonDir: '/repo/.git', head: A, branch: 'main' }, branches: [{ name: 'feature/retained', oid: B }], nextCursor: 'page-2', observedAt: 10, revision: 1 };
const result = { sourceSessionId: 'old', sessionId: 'local-exact', workspaceId: 'local-folder', worktreeId: 'tree', cwd: '/repo/project', branch: 'feature/retained', cleanup };
const success = <T>(data: T) => ({ ok: true, value: { v: 1, ok: true, data } });
function observable<T>(initial: T) {
  let value = initial; const listeners = new Set<Listener>();
  return { getSnapshot: () => value, subscribe(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }, publish(next: T) { value = next; for (const fn of [...listeners]) fn(); }, listeners };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function deferred<T = unknown>() { let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const cancelled = () => Object.assign(new Error('fixture cancellation'), { name: 'AbortError' });
function fixture(t: import('node:test').TestContext, { initial = info, reply, navigate = true, foreign, beforeMount }: { initial?: WorktreeReopenInfo; reply?: (request: MockRequest, signal: AbortSignal, after?: number) => unknown; navigate?: boolean; foreign?: ComposerBlock; beforeMount?: (environment: { ctx: { uiWorkspace: { openWorkspace: (workspaceId: string) => Promise<void>; startSession: (workspaceId: string) => Promise<void> } }; sessions: unknown; navigations: AbortSignal[]; pending: unknown[] }) => void } = {}) {
  const calls: { request: MockRequest; after?: number; signal: AbortSignal }[] = [], waits: (ReturnType<typeof deferred> & { request: MockRequest; after: number; signal: AbortSignal })[] = [], opens: string[] = [], retains: { sessionId: string; released: boolean; release: () => void }[] = [], navigations: AbortSignal[] = [], pending: (ReturnType<typeof deferred<string>> & { workspaceId: string })[] = [], blockStores = new Map<string, ReturnType<typeof observable<ComposerBlock>>>(), bindings = new Map();
  let navigation: AbortController | undefined;
  const layout = {
    beginNavigation() { navigation?.abort(); navigation = new AbortController(); navigations.push(navigation.signal); return navigation.signal; },
    selectPanel(_id?: string | null) { navigation?.abort(); },
  };
  const sessions = observable<SessionList>({ byId: { old: { retainedBy: { mainView: 1 }, blank: false } } });
  const generation = observable<{ id: number } | undefined>({ id: 1 }); let latest = initial;
  const draft = { draft: 'unfinished @file', draftRev: 9, phase: 'plain', attachmentIds: ['generic-file', 'image'], queue: [], chips: [{ source: 'files', ref: 'file', appearance: 'file' }], files: [{ id: 'generic-file', bytes: new Uint8Array([1, 2, 3]) }] };
  bindings.set('old', { ctx: {}, draft });
  const blockFor = (id: string) => { if (!blockStores.has(id)) blockStores.set(id, observable(id === 'old' ? foreign : undefined)); return blockStores.get(id)!; };
  const ctx = {
    sessions: { list: sessions, binding: (id: string) => bindings.get(id), retain(id: string, options: { source: string }) {
      assert.equal(options.source, 'controllerOperation'); assert.equal(id, pSession(), 'only the selected real Client generation is retained');
      const ref = { sessionId: id, binding: bindings.get(id) || { ctx: {} }, ready: Promise.resolve(bindings.get(id) || { ctx: {} }), released: false, release() { assert.equal(this.released, false); this.released = true; } }; retains.push(ref); return ref;
    } },
    conversation: { blocks: { storeFor: blockFor, set: (id: string, value: ComposerBlock) => blockFor(id).publish(value) }, input: { for() { assert.fail('recovery cannot replace or flatten the structured draft'); } } },
    layout,
    uiWorkspace: {
      openSession(id: string) {
        opens.push(id);
        if (navigate) sessions.publish({ byId: Object.fromEntries([...new Set([...Object.keys(sessions.getSnapshot().byId), id])].map((key: string) => [key, { retainedBy: { mainView: key === id ? 1 : 0 }, blank: false }])) });
        layout.selectPanel(null);
      },
      // rc.2 openWorkspace/New Thread starts navigation synchronously, awaits
      // connectWorkspace without changing mainView, then commits only if current.
      connectWorkspace(workspaceId: string) { const connection = deferred<string>(); pending.push({ workspaceId, ...connection }); return connection.promise; },
      async openWorkspace(workspaceId: string) {
        const signal = layout.beginNavigation(), sessionId = await ctx.uiWorkspace.connectWorkspace(workspaceId);
        if (!signal.aborted) ctx.uiWorkspace.openSession(sessionId!);
      },
      startSession(workspaceId: string) { return ctx.uiWorkspace.openWorkspace(workspaceId); },
    },
    connection: { generation, rpc: { async call(...[channel, endpoint, payload, signal]: RpcArgs) {
      assert.equal(channel, '/api'); assert.equal(endpoint, 'dsh-worktrees/recovery'); assert.deepEqual(Object.keys(payload).sort(), payload.after === undefined ? ['request', 'v'] : ['after', 'request', 'v']); assert.equal(payload.v, 1);
      const request = payload.request, after = payload.after; assert.equal(Object.hasOwn(request, 'after'), false); calls.push({ request, after, signal });
      if (reply) { const answer = reply(request, signal, after); if (answer !== undefined) return answer; }
      if (request.action === 'reopen') { latest = { ...latest, continuationSessionId: result.sessionId, recoveredBranch: result.branch }; return success({ ...result, sourceSessionId: request.sourceSessionId }); }
      if (after !== undefined) {
        const wait = deferred(); const entry = { request, after, signal, ...wait }; waits.push(entry);
        signal.addEventListener('abort', () => wait.reject(cancelled()), { once: true }); if (signal.aborted) wait.reject(cancelled()); return wait.promise;
      }
      if (request.cursor) return success({ ...latest, sourceSessionId: request.sourceSessionId, branches: [{ name: 'release', oid: C }], nextCursor: undefined });
      const related = request.sourceSessionId === initial.sourceSessionId || request.sourceSessionId === latest.continuationSessionId || request.sourceSessionId === latest.pendingSessionId;
      return success(related ? { ...latest, sourceSessionId: request.sourceSessionId } : { sourceSessionId: request.sourceSessionId, worktreeId: null, cleanup: null, continuationSessionId: null, originalFolder: null, revision: 0 });
    } } },
  };
  function pSession() { return Object.keys(sessions.getSnapshot().byId).find((id: string) => sessions.getSnapshot().byId[id]!.retainedBy.mainView! > 0); }
  const projects = { store: observable({ records: [{ id: 'tree', sessionIds: ['old'], branch: 'feature/retained', cleanup: initial.cleanup }] }) };
  beforeMount?.({ ctx, sessions, navigations, pending });
  const api = p.createRecoveryStore(ctx, (key: string) => key, projects);
  t.after(() => api.dispose());
  return { api, ctx, calls, waits, opens, retains, navigations, pending, sessions, generation, draft, blockFor, setInfo(value: WorktreeReopenInfo) { latest = value; }, async event(value: WorktreeReopenInfo) { latest = value; const wait = waits.findLast(entry => !entry.signal.aborted); assert.ok(wait); wait.resolve(success({ ...value, sourceSessionId: wait.request.sourceSessionId })); await flush(); } };
}

test('recovery uses its exact quiet transport, no actor fallback, privilege payload or normal worktree endpoint', async () => {
  const calls: RpcArgs[] = [], controller = new AbortController(), request = { action: 'reopen-info', sourceSessionId: 'old', after: 0 };
  const data = await p.requestRecovery({ connection: { rpc: { call: async (...args: RpcArgs) => { calls.push(args); return success(info); } } } }, request, controller.signal);
  assert.equal(data, info); assert.equal(calls.length, 1); assert.equal(calls[0]![0], '/api'); assert.equal(calls[0]![1], 'dsh-worktrees/recovery'); assert.deepEqual({ ...calls[0]![2]!.request }, { action: 'reopen-info', sourceSessionId: 'old' }); assert.equal(calls[0]![2].after!, 0); assert.equal(Object.hasOwn(calls[0]![2]!.request, 'after'), false); assert.equal(calls[0]![3], controller.signal);
  for (const invalid of [{ ...request, actorId: 'invented' }, { ...request, after: -1 }, { ...request, cursor: 'cursor' }, { ...request, limit: 10 }, { ...request, sourceSessionId: 's'.repeat(257) }, { action: 'reopen', sourceSessionId: 'old', localBranch: 'main', localOid: A, permissionMode: 'override' }, { action: 'reopen', sourceSessionId: 'old', localBranch: 'main', localOid: 'HEAD' }]) assert.throws(() => p.recoveryRequest(invalid), (error: VmValue) => error.kind === 'decode');
  assert.equal([...source.matchAll(/ctx\.connection\.rpc\.call\(/g)].length, 1);
  assert.doesNotMatch(staticSource(source), /setTimeout\(|setInterval\(|sessions\.create\(|permissionMode|grantPermission|remote\.commands/);
});

test('actual Client lifecycle wire roundtrips through real Host parser/route into wait, never historical actor resolution', async (t: import('node:test').TestContext) => {
  const host = new Context(), owned = createScope(host, {}), sourceSessionId = '12345678-1234-4234-8234-123456789abc';
  const operator = { id: 'wire-fixture-operator' as Parameters<Parameters<NonNullable<Parameters<typeof registerRecoveryRpc>[2]>>[2]>[3]['id'], ctx: new Context(), dispose: async () => {} }, selected: { kind: string; id?: string; after?: number; options?: Pick<MockRequest, 'cursor' | 'limit'>; invocation?: { origin: string; agent?: unknown } }[] = [], wireCalls: { wire: MockPayload; parsed: ReturnType<typeof parseRecoveryPayload>; signal: AbortSignal }[] = [];
  host.provide('connection', { operator });
  host.provide('sessionController', { resolveAgent() { assert.fail('lifecycle observation must never resolve the historical Agent'); } });
  host.provide('agents', { get() { assert.fail('lifecycle observation must never select a privileged Actor'); } });
  let handler: Parameters<NonNullable<Parameters<typeof registerRecoveryRpc>[2]>>[2] | undefined;
  const stop = registerRecoveryRpc(owned.ctx, {
    async info(id: string, _signal: AbortSignal, options?: Pick<MockRequest, 'cursor' | 'limit'>) { selected.push({ kind: 'info', id, options }); return { ...info, sourceSessionId: id }; },
    async wait(id: string, after: number, _signal: AbortSignal) { selected.push({ kind: 'wait', id, after }); return { ...info, sourceSessionId: id, revision: after! + 1 }; },
    async reopen(request: MockRequest, invocation) { selected.push({ kind: 'reopen', invocation }); return { ...result, sourceSessionId: request.sourceSessionId! }; },
  }, (_owner, endpoint, route) => { assert.equal(endpoint, RECOVERY_RPC_ENDPOINT); handler = route; return async () => { handler = undefined; }; });
  t.after(async () => { await stop(); await owned.dispose(); });
  const ctx = { connection: { rpc: { async call(...[channel, endpoint, payload, signal]: RpcArgs) {
    assert.equal(channel, '/api'); assert.equal(endpoint, RECOVERY_RPC_ENDPOINT);
    // The genuine Connection crosses a JSON boundary. Recreate that boundary
    // before the real Host's lossless plain-object parser sees the VM object.
    const wire = JSON.parse(JSON.stringify(payload)), parsed = parseRecoveryPayload(wire); wireCalls.push({ wire, parsed, signal });
    assert.equal(Object.hasOwn(wire.request, 'after'), false); assert.equal(Object.hasOwn(wire, 'actorId'), false);
    return handler!(endpoint, wire, signal, operator);
  } } } };
  const controller = new AbortController();
  for (const after of [0, 7]) {
    const data = await p.requestRecovery(ctx, { action: 'reopen-info', sourceSessionId, after }, controller.signal);
    assert.equal(data.revision, after + 1);
    const call = wireCalls.at(-1); assert.deepEqual(Object.keys(call!.wire).sort(), ['after', 'request', 'v']); assert.equal(call!.wire.after, after); assert.equal(call!.parsed.after, after);
    assert.deepEqual(call!.parsed.request, { action: 'reopen-info', sourceSessionId }); assert.equal(call!.signal, controller.signal);
    assert.equal(selected.at(-1)!.kind, 'wait'); assert.equal(selected.at(-1)!.after, after); assert.equal(selected.at(-1)!.id, sourceSessionId);
  }
  await p.requestRecovery(ctx, { action: 'reopen-info', sourceSessionId, cursor: 'page', limit: 10 }, controller.signal);
  assert.equal(selected.at(-1)!.kind, 'info'); assert.equal(wireCalls.at(-1)!.parsed.after, undefined); assert.equal(selected.at(-1)!.options!.cursor, 'page');
  await p.requestRecovery(ctx, { action: 'reopen', sourceSessionId, localBranch: 'main', localOid: A }, controller.signal);
  assert.equal(selected.at(-1)!.kind, 'reopen'); assert.equal(selected.at(-1)!.invocation!.origin, 'ui'); assert.equal(selected.at(-1)!.invocation!.agent, undefined);
  assert.deepEqual(Object.keys(wireCalls.at(-1)!.wire).sort(), ['request', 'v']);
  assert.throws(() => parseRecoveryPayload({ v: 1, request: { action: 'reopen-info', sourceSessionId, after: 0 } }), (error: VmValue) => error.code === 'INVALID_REQUEST', 'old nested-after wire regression is rejected by the real Host parser');
  for (const request of [{ action: 'reopen-info', sourceSessionId, after: 0, limit: 10 }, { action: 'reopen-info', sourceSessionId, after: 0, cursor: 'page' }, { action: 'reopen-info', sourceSessionId: 's'.repeat(257) }]) await assert.rejects(p.requestRecovery(ctx, request, controller.signal), (error: VmValue) => error.kind === 'decode');
  assert.equal(wireCalls.length, 4, 'invalid Client requests never cross the real Host route');
  assert.equal(p.recoveryRequest({ action: 'reopen-info', sourceSessionId: 's'.repeat(256) }).sourceSessionId.length, 256);
});

test('strict recovery and cleanup validators reject malformed/cross-session replies before navigation', () => {
  const request = { action: 'reopen-info', sourceSessionId: 'old' };
  for (const bad of [null, [], {}, { ...info, sourceSessionId: 'other' }, { ...info, revision: -1 }, { ...info, cleanup: { ...cleanup, phase: 'invented' } }, { ...info, cleanup: { ...cleanup, inactivityDays: 0 } }, { ...info, cleanup: { ...cleanup, reclaimedAt: -1 } }, { ...info, branches: [{ name: 'HEAD', oid: A }] }, { ...info, branches: [{ name: 'main', oid: 'stale' }] }, { ...info, pendingSessionId: 1 }]) assert.throws(() => p.recoveryData(request, bad), (error: VmValue) => error.kind === 'decode');
  assert.equal(p.validateData(request, info), info);
  assert.equal(p.recoveryData({ action: 'reopen', sourceSessionId: 'old' }, result), result);
  assert.throws(() => p.recoveryData({ action: 'reopen', sourceSessionId: 'other' }, result), (error: VmValue) => error.kind === 'decode');
  const record = { id: 'tree', operationId: 'op', effectiveCwd: '/managed/tree', remote: 'origin', remoteBranch: 'main', baseOid: A, branch: null, sessionIds: ['old'], protected: false, archived: false, state: 'missing', cleanup };
  assert.equal(p.projectData({ action: 'list' }, { projects: [], bindings: [], records: [record] }).records[0], record);
  assert.throws(() => p.projectData({ action: 'list' }, { projects: [], bindings: [], records: [{ ...record, cleanup: { ...cleanup, reason: 'bad' } }] }), (error: VmValue) => error.kind === 'decode');
});

test('root coalesces one initial read per selected mainView and connection, never token/status updates or typing', async (t: import('node:test').TestContext) => {
  const f = fixture(t); await flush();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0]!.after, undefined); assert.equal(f.calls[1]!.after, 1);
  assert.equal(f.api.store.getSnapshot().selected, null, 'collected history never defaults to current branch');
  f.sessions.publish({ byId: { old: { retainedBy: { mainView: 1 }, blank: false, updatedAt: 999 } } }); f.api.setQuery('retained'); await flush(); assert.equal(f.calls.length, 2);
  const wait = f.waits[0]; f.generation.publish(undefined); assert.equal(wait!.signal.aborted, true);
  f.generation.publish({ id: 2 }); await flush(); assert.equal(f.calls.filter(call => call.after === undefined).length, 2);
  f.api.dispose(); assert.ok(f.calls.at(-1)!.signal.aborted); assert.equal(f.sessions.listeners.size, 0); assert.equal(f.generation.listeners.size, 0);
});

test('lifecycle wait observes future cleanup even before receipt exists and blocks only verified unsafe phases', async (t: import('node:test').TestContext) => {
  const plain = { ...info, worktreeId: null, cleanup: null, branches: undefined, repository: undefined, nextCursor: undefined, observedAt: undefined, revision: 0 };
  const f = fixture(t, { initial: plain }); await flush(); assert.equal(f.blockFor('old').getSnapshot(), undefined); assert.equal(f.waits[0]!.after, 0);
  await f.event({ ...plain, worktreeId: 'tree', cleanup: { ...cleanup, phase: 'planned', reclaimedAt: null }, revision: 1 });
  const owned = f.blockFor('old').getSnapshot(); assert.equal(owned!.reason, 'gcBlock'); assert.equal(f.retains.length, 1);
  await f.event({ ...info, cleanup: { ...cleanup, phase: 'recovery-required' }, revision: 2 }); assert.equal(f.blockFor('old').getSnapshot(), owned);
  await f.event({ ...info, revision: 3 }); assert.equal(f.api.store.getSnapshot().selected, null); assert.equal(f.blockFor('old').getSnapshot(), owned);
});

test('loaded branches are current/retained/paged, filtered locally, and HEAD is explicit only when detached', async (t: import('node:test').TestContext) => {
  const f = fixture(t); await flush();
  assert.deepEqual(Array.from(f.api.store.getSnapshot().branches, (item: VmValue) => [item.name, item.current, item.retained]), [['main', true, false], ['feature/retained', false, true]]);
  const n = f.calls.length; f.api.setQuery('feat'); await flush(); assert.equal(f.calls.length, n);
  await f.api.more(); assert.deepEqual(Array.from(f.api.store.getSnapshot().branches, (item: VmValue) => item.name), ['main', 'feature/retained', 'release']);
  assert.equal(f.calls.at(-1)!.request.cursor, 'page-2'); assert.equal(f.api.store.getSnapshot().selected, null);
  const detached = p.recoveryBranches({ ...info, repository: { ...info.repository, branch: null }, branches: [{ name: 'HEAD', oid: A }] });
  assert.equal(detached[0].name, 'HEAD'); assert.equal(detached[0].current, true);
});

test('Cancel keeps old history/draft/block; Review and Refresh require a new explicit branch', async (t: import('node:test').TestContext) => {
  const f = fixture(t); await flush(); const block = f.blockFor('old').getSnapshot();
  f.api.choose('feature/retained'); f.api.cancel(); assert.equal(f.api.store.getSnapshot().cancelled, true); assert.equal(f.api.store.getSnapshot().selected, null);
  await f.api.resume(); assert.equal(f.calls.some(call => call.request.action === 'reopen'), false); assert.equal(f.blockFor('old').getSnapshot(), block); assert.equal(f.draft.chips[0]!.ref, 'file');
  await f.api.retry(); assert.equal(f.api.store.getSnapshot().cancelled, false); assert.equal(f.api.store.getSnapshot().selected, null);
  assert.equal(f.retains.length, 1); assert.equal(f.retains[0]!.released, false);
});

test('explicit continue sends exact OID once, opens exact Local ID and preserves text/chips/file drafts without resubmission', async (t: import('node:test').TestContext) => {
  const f = fixture(t); await flush(); const draft = f.draft, chips = draft.chips, files = draft.files;
  assert.equal(f.api.choose('feature/retained'), true); const first = f.api.resume(); const duplicate = f.api.resume(); await Promise.all([first, duplicate]); await flush();
  const calls = f.calls.filter(call => call.request.action === 'reopen'); assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0]!.request }, { action: 'reopen', sourceSessionId: 'old', localBranch: 'feature/retained', localOid: B });
  assert.deepEqual(f.opens, ['local-exact']); assert.equal(f.api.store.getSnapshot().draftHistoryId, 'old'); assert.equal(f.api.store.getSnapshot().info.continuationSessionId, 'local-exact');
  assert.equal(draft.chips, chips); assert.equal(draft.files, files); assert.equal(draft.draft, 'unfinished @file'); assert.equal(f.retains[0]!.released, false);
  await f.api.openHistory(); await flush(); assert.equal(f.opens.at(-1), 'old'); assert.equal(f.opens.filter((id: string) => id === 'local-exact').length, 1, 'View historical draft cannot trigger a redirect loop');
  await f.api.refresh(); f.generation.publish({ id: 2 }); await flush();
  assert.equal(f.opens.filter((id: string) => id === 'local-exact').length, 1, 'historical draft preference survives forced reads and reconnect');
  assert.equal(draft.chips, chips); assert.equal(draft.files, files);
  f.api.dispose(); assert.equal(f.retains[0]!.released, true);
});

test('already-ready metadata preserves history and warning until explicit Open selects the exact Local once', async (t: import('node:test').TestContext) => {
  const ready = { ...info, continuationSessionId: 'local-exact', recoveredBranch: 'feature/retained' };
  const f = fixture(t, { initial: ready }); await flush();
  assert.deepEqual(f.opens, []); assert.equal(f.navigations.length, 0);
  assert.equal(f.api.store.getSnapshot().sessionId, 'old'); assert.equal(f.api.store.getSnapshot().info.cleanup, cleanup);
  assert.ok(f.blockFor('old').getSnapshot()); assert.equal(f.api.store.getSnapshot().selected, null);
  await f.event({ ...ready, revision: 2 }); assert.deepEqual(f.opens, []); assert.equal(f.navigations.length, 0);
  await f.api.openTarget(); await flush(); assert.deepEqual(f.opens, ['local-exact']); assert.equal(f.navigations.length, 1);
  assert.equal(f.calls.some(call => call.request.action === 'reopen'), false); assert.equal(f.retains.length, 1);
});

for (const phase of ['initial', 'lifecycle']) for (const native of ['openWorkspace', 'startSession'] as const) {
  test(`delayed ${phase} ready info cannot supersede native ${native} while old mainView remains`, async (t: import('node:test').TestContext) => {
    const flight = deferred(), ready = { ...info, continuationSessionId: 'local-exact', recoveredBranch: 'feature/retained', revision: 2 };
    const f = fixture(t, { reply(request: MockRequest, _signal: AbortSignal, after: number | undefined) { if (phase === 'initial' && request.sourceSessionId === 'old' && after === undefined) return flight.promise; } });
    if (phase === 'lifecycle') await flush();
    // For initial reads, native intent even starts before the scheduled read.
    const task = f.ctx.uiWorkspace[native]('user-workspace'), intent = f.navigations.at(-1);
    await flush();
    assert.equal(f.api.store.getSnapshot().sessionId, 'old');
    assert.equal(f.sessions.getSnapshot().byId.old!.retainedBy.mainView!, 1);
    assert.equal(f.pending.length, 1); assert.equal(intent!.aborted, false);
    if (phase === 'initial') { flight.resolve(success(ready)); await flush(); }
    else await f.event(ready);
    assert.deepEqual(f.opens, [], 'old ready facts cannot open their continuation');
    assert.equal(intent!.aborted, false, 'user Workspace connection still owns navigation');
    assert.equal(f.navigations.length, 1, 'async facts never begin a new navigation');
    assert.equal(f.calls.some(call => call.request.action === 'reopen'), false);
    assert.equal(f.api.store.getSnapshot().selected, null);
    f.pending[0]!.resolve('user-exact-session'); await task; await flush();
    assert.deepEqual(f.opens, ['user-exact-session']);
    assert.equal(f.api.store.getSnapshot().sessionId, 'user-exact-session');
  });
}

for (const native of ['openWorkspace', 'startSession'] as const) {
  test(`mount cannot supersede pre-existing pending native ${native}`, async (t: import('node:test').TestContext) => {
    let task: Promise<void> | undefined, intent: AbortSignal | undefined;
    const ready = { ...info, continuationSessionId: 'local-exact', recoveredBranch: 'feature/retained' };
    const f = fixture(t, { initial: ready, beforeMount({ ctx, navigations }) {
      task = ctx.uiWorkspace[native]('user-workspace'); intent = navigations.at(-1);
    } });
    assert.equal(intent!.aborted, false, 'mount does not claim navigation authority');
    await flush(); assert.equal(intent!.aborted, false); assert.equal(f.navigations.length, 1);
    assert.deepEqual(f.opens, []); assert.equal(f.api.store.getSnapshot().sessionId, 'old');
    assert.equal(f.api.store.getSnapshot().info.continuationSessionId, 'local-exact');
    assert.ok(f.blockFor('old').getSnapshot()); assert.equal(f.retains[0]!.released, false);
    f.pending[0]!.resolve('user-exact-session'); await task; await flush();
    assert.deepEqual(f.opens, ['user-exact-session']);
  });

  test(`selection before its first read cannot supersede a second native ${native} intent`, async (t: import('node:test').TestContext) => {
    const flight = deferred(), ready = { ...info, sourceSessionId: 'selected-history', continuationSessionId: 'local-exact' };
    const f = fixture(t, { reply(request: MockRequest, _signal: AbortSignal, after: number | undefined) {
      if (request.sourceSessionId === 'selected-history' && after === undefined) return flight.promise;
    } });
    await flush(); assert.equal(f.navigations.length, 0);
    f.ctx.uiWorkspace.openSession('selected-history');
    const task = f.ctx.uiWorkspace[native]('user-workspace'), intent = f.navigations.at(-1);
    // The second native intent starts before the scheduled first read for the
    // newly selected history. Selection observation must remain read-only.
    await flush(); assert.equal(intent!.aborted, false); assert.equal(f.navigations.length, 1);
    assert.equal(f.api.store.getSnapshot().sessionId, 'selected-history');
    flight.resolve(success(ready)); await flush();
    assert.equal(intent!.aborted, false); assert.deepEqual(f.opens, ['selected-history']);
    assert.equal(f.api.store.getSnapshot().info.continuationSessionId, 'local-exact');
    assert.ok(f.blockFor('selected-history').getSnapshot());
    f.pending[0]!.resolve('user-exact-session'); await task; await flush();
    assert.deepEqual(f.opens, ['selected-history', 'user-exact-session']);
  });
}

test('reconnect and forced re-read remain read-only and discard stale generation facts', async (t: import('node:test').TestContext) => {
  const reads: (ReturnType<typeof deferred> & { signal: AbortSignal })[] = [];
  const f = fixture(t, { reply(request: MockRequest, signal: AbortSignal, after: number | undefined) {
    if (request.sourceSessionId === 'old' && after === undefined) { const flight = deferred(); reads.push({ ...flight, signal }); return flight.promise; }
  } });
  await flush(); assert.equal(reads.length, 1);
  const task = f.ctx.uiWorkspace.openWorkspace('user-workspace'), intent = f.navigations.at(-1);
  const refresh = f.api.refresh(); assert.equal(reads.length, 2); assert.equal(reads[0]!.signal.aborted, true);
  f.generation.publish(undefined); f.generation.publish({ id: 2 }); await flush();
  assert.equal(reads.length, 3); assert.equal(reads[1]!.signal.aborted, true);
  const ready = { ...info, continuationSessionId: 'local-exact', revision: 2 };
  reads[0]!.resolve(success(ready)); reads[1]!.resolve(success(ready)); await refresh; await flush();
  assert.equal(f.api.store.getSnapshot().checked, false, 'old read generations cannot publish');
  reads[2]!.resolve(success(ready)); await flush();
  assert.equal(f.api.store.getSnapshot().checked, true, 'current facts remain readable without redirect authority');
  f.sessions.publish({ byId: { old: { retainedBy: { mainView: 1 }, updatedAt: 999 } } });
  await f.event({ ...ready, revision: 3 });
  assert.deepEqual(f.opens, []); assert.equal(intent!.aborted, false); assert.equal(f.navigations.length, 1);
  assert.equal(reads.length, 3, 'token/structural updates do not create reads or navigation lifetimes');
  f.pending[0]!.resolve('user-exact-session'); await task; await flush();
  assert.deepEqual(f.opens, ['user-exact-session']);
});

test('plain default conversation observation is harmless and does not submit or choose a branch', async (t: import('node:test').TestContext) => {
  const plain = { ...info, worktreeId: null, cleanup: null, branches: undefined, repository: undefined, nextCursor: undefined, observedAt: undefined, revision: 0 };
  const f = fixture(t, { initial: plain }); await flush();
  await f.api.refresh(); await flush();
  assert.deepEqual(f.opens, []); assert.equal(f.navigations.length, 0);
  assert.equal(f.retains.length, 0); assert.equal(f.api.store.getSnapshot().selected, null);
  assert.ok(f.calls.every(call => call.request.action === 'reopen-info'));
});

test('late metadata and reopen completions after navigation/connection replacement never navigate or overwrite selected state', async (t: import('node:test').TestContext) => {
  const flight = deferred(); const f = fixture(t, { reply(request: MockRequest) { if (request.action === 'reopen') return flight.promise; } }); await flush(); f.api.choose('main'); const task = f.api.resume();
  const owned = f.calls.find(call => call.request.action === 'reopen');
  f.sessions.publish({ byId: { old: { retainedBy: { mainView: 0 } }, other: { retainedBy: { mainView: 1 } } } }); assert.equal(owned!.signal.aborted, true); await flush(); flight.resolve(success(result)); await task; await flush();
  assert.equal(f.opens.length, 0); assert.equal(f.api.store.getSnapshot().sessionId, 'other'); assert.equal(f.retains.find(ref => ref.sessionId === 'old')!.released, false);
  const read = deferred(); const stale = fixture(t, { initial: { ...info, cleanup: null }, reply(request: MockRequest, _signal: AbortSignal, after: number | undefined) { if (request.sourceSessionId === 'old' && after === undefined) return read.promise; } });
  await flush(); stale.generation.publish({ id: 2 }); await flush(); read.resolve(success({ ...info, continuationSessionId: 'local-exact' })); await flush();
  // Even current-generation ready facts remain read-only; neither completion
  // can mint a navigation or automatically open the Local target.
  assert.deepEqual(stale.opens, []); assert.equal(stale.navigations.length, 0);
});

test('a newer native navigation aborts explicit recovery before mainView ownership finishes changing', async (t: import('node:test').TestContext) => {
  const flight = deferred(); const f = fixture(t, { reply(request: MockRequest) { if (request.action === 'reopen') return flight.promise; } }); await flush();
  f.api.choose('main'); const task = f.api.resume(); const request = f.calls.find(call => call.request.action === 'reopen');
  f.ctx.layout.beginNavigation(); assert.equal(request!.signal.aborted, true); assert.equal(f.api.store.getSnapshot().sessionId, 'old');
  flight.resolve(success(result)); await task; await flush(); assert.equal(f.opens.length, 0); assert.equal(f.retains[0]!.released, false);
  await f.event({ ...info, continuationSessionId: result.sessionId, recoveredBranch: result.branch, revision: 2 });
  assert.equal(f.opens.length, 0, 'later ready lifecycle cannot override newer native navigation'); assert.equal(f.api.store.getSnapshot().cancelled, true);
});

test('other plugin composer blocks are never overwritten or cleared; owned block restores only after foreign owner clears', async (t: import('node:test').TestContext) => {
  const foreign = Object.freeze({ reason: 'another plugin' }); const f = fixture(t, { foreign }); await flush(); assert.equal(f.blockFor('old').getSnapshot(), foreign); assert.equal(f.api.store.getSnapshot().foreignBlock, true);
  f.blockFor('old').publish(undefined); const owned = f.blockFor('old').getSnapshot(); assert.notEqual(owned, foreign); assert.equal(owned!.reason, 'gcBlock');
  const replacement = Object.freeze({ reason: 'gcBlock' }); f.blockFor('old').publish(replacement); f.api.dispose(); assert.equal(f.blockFor('old').getSnapshot(), replacement);
});

test('Host refusal surfaces staged real Local permission target without privilege fields or fabricated actors', async (t: import('node:test').TestContext) => {
  const f = fixture(t, { reply(request: MockRequest) {
    if (request.action === 'reopen') { f.setInfo({ ...info, pendingSessionId: 'real-pending-local' }); return { ok: true, value: { v: 1, ok: false, error: { code: 'FULL_ACCESS_REQUIRED', message: 'Adjust real Local controls.' } } }; }
  } }); await flush(); f.api.choose('feature/retained'); await f.api.resume(); await flush();
  assert.match(f.api.store.getSnapshot().error, /FULL_ACCESS_REQUIRED/); assert.equal(f.api.store.getSnapshot().info.pendingSessionId, 'real-pending-local'); assert.equal(f.opens.length, 0);
  await f.api.openPermissions(); await flush(); assert.equal(f.opens[0], 'real-pending-local'); assert.equal(f.api.store.getSnapshot().draftHistoryId, 'old'); assert.equal(f.draft.draft, 'unfinished @file');
  for (const call of f.calls) assert.equal(Object.hasOwn(call.request, 'actorId'), false);
});

test('failed Refresh preserves persistent cleanup facts/block and refuses stale branch actions until verified retry', async (t: import('node:test').TestContext) => {
  let offline = false;
  const f = fixture(t, { reply(request: MockRequest, _signal: AbortSignal, after: number | undefined) { if (offline && request.action === 'reopen-info' && after === undefined) return Promise.reject(Error('fixture offline')); } }); await flush();
  const held = f.blockFor('old').getSnapshot(); f.api.choose('main'); offline = true; await f.api.refresh();
  const state = f.api.store.getSnapshot(); assert.equal(state.info.cleanup, cleanup); assert.equal(state.checked, false); assert.equal(state.selected, null); assert.match(state.error, /fixture offline/); assert.equal(f.blockFor('old').getSnapshot(), held);
  assert.equal(f.api.choose('main'), false); await f.api.resume(); assert.equal(f.calls.some(call => call.request.action === 'reopen'), false);
  offline = false; await f.api.refresh(); assert.equal(f.api.store.getSnapshot().checked, true); assert.equal(f.api.choose('feature/retained'), true); assert.equal(f.retains.length, 1);
});

test('malformed nonadvancing lifecycle revision fails once instead of creating a polling spin', async (t: import('node:test').TestContext) => {
  const f = fixture(t, { reply(_request: MockRequest, _signal: AbortSignal, after: number | undefined) { if (after !== undefined) return success(info); } }); await flush();
  assert.equal(f.calls.length, 2); assert.match(f.api.store.getSnapshot().error, /lifecycle-revision-not-advanced/);
});
