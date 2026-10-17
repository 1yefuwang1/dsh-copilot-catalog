import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { after, test, type TestContext } from 'node:test';
import vm from 'node:vm';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

type Listener = () => void;
type VmValue = any; // Only the inspected, in-memory factory export crosses this VM boundary.
type VmModule = { id: string; factory: (require: (name: string) => unknown) => VmValue };
interface SessionSnapshot {
  blank: boolean; subagent: unknown | null; openState: string; removed: boolean; running: boolean;
  promptAttempted: boolean; awaitingFirstTurn: boolean; pendingSubmissions: unknown[];
}
interface SessionItem { displayTitle: string; origin: string; retainedBy: Record<string, number>; }
interface SessionList { byId: Record<string, SessionItem>; }
interface Workspace { workspaceId: string; path: string; title: string; sessionIds: string[]; }
interface WorkspaceList { phase: string; items: Workspace[]; archivedSessionIds: string[]; pinnedSessionIds: string[]; }
interface WorktreeRecord {
  id: string; operationId: string; effectiveCwd: string; remote: string; remoteBranch: string;
  baseOid: string; sessionIds: string[]; branch: string | null; protected: boolean; archived: boolean;
  state: string; cleanup?: { phase: string; inactivityDays: number; lastActivityAt: null; eligibleAfter: null; reclaimedAt: null; originalFolder: null; recoveryRef: null; reason: null };
}
interface Binding { ctx: { effect(factory: () => () => void): () => void }; session: ReturnType<typeof observable<SessionSnapshot>>; }
interface Reference { sessionId: string; ready: Binding | PromiseLike<Binding>; releases: number; release(): void; }
interface Request { action: string; id?: string; sessionMode?: string; }
interface FixtureOptions {
  record?: Partial<WorktreeRecord>; actorId?: string | null; knownIds?: string[];
  workspace?: Partial<WorkspaceList>; workspaceItems?: Workspace[]; coldIds?: string[];
  snapshots?: Record<string, Partial<SessionSnapshot>>; discoverIds?: string[];
  refreshWait?: Promise<void>; nativeError?: Error;
}

const clientUrl = new URL('../dist/client.js', import.meta.url);
const source = await readFile(clientUrl, 'utf8');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  HTMLDialogElement: dom.window.HTMLDialogElement, IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
after(() => {
  dom.window.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

// Keep the native AbortSignal API, but make only its deadline clock explicit.
// No production guard or promise is replaced and no test sleeps for 30 seconds.
const deadlines: { milliseconds: number; controller: AbortController }[] = [];
class ClockedAbortSignal extends AbortSignal {
  static override timeout(milliseconds: number) {
    const controller = new AbortController(); deadlines.push({ milliseconds, controller }); return controller.signal;
  }
}
let module!: VmModule;
const marker = /^[ \t]*inject:/gm;
assert.equal([...source.matchAll(marker)].length, 1, 'the actual client factory has exactly one export seam');
// Expose only existing declarations, in memory. RecordCard, its hooks, guards,
// retained-session helper and click handlers remain the shipped implementations.
vm.runInNewContext(source.replace(marker, 'renderTest: { RecordCard, en },\n$&'), {
  window: { __ModuleLoader__: { load(value: VmModule) { module = value; } } },
  AbortController, AbortSignal: ClockedAbortSignal, crypto: webcrypto,
}, { filename: clientUrl.pathname });
assert.equal(module.id, '@1yefuwang1/dsh-worktrees');
const real = module.factory((name: string) => { assert.equal(name, 'react'); return React; }).renderTest;
const RecordCard: React.ComponentType<{
  record: WorktreeRecord; runtime: unknown; actorId?: string; list: SessionList;
  sessionStatuses: Map<string, { running?: boolean }>; t(key: string): string; onChanged(): void; onPreview(): void;
}> = real.RecordCard;

function observable<T>(initial: T) {
  let value = initial; const listeners = new Set<Listener>();
  return {
    getSnapshot: () => value,
    subscribe(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); },
    publish(next: T) { value = next; for (const listener of [...listeners]) listener(); },
  };
}
// Native workspace facades expose receiver-dependent prototype methods, unlike
// the closure stores used for plugin metadata and the local session fixture.
// Passing either method naked to React must fail as it does in the real client.
class NativeWorkspaceStore {
  private state: WorkspaceList;
  private readonly listeners = new Set<Listener>();
  snapshotRefreshes = 0; subscriptions = 0; releases = 0;
  constructor(initial: WorkspaceList) { this.state = initial; }
  refreshSnapshot() { this.snapshotRefreshes += 1; }
  getSnapshot() { this.refreshSnapshot(); return this.state; }
  subscribe(listener: Listener) {
    this.listeners.add(listener); this.subscriptions += 1; let live = true;
    return () => {
      assert.equal(live, true, 'each native workspace listener is released once'); live = false;
      this.listeners.delete(listener); this.releases += 1;
    };
  }
  publish(next: WorkspaceList) { this.state = next; for (const listener of [...this.listeners]) listener(); }
  listenerCount() { return this.listeners.size; }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const openSnapshot: SessionSnapshot = {
  blank: false, subagent: null, openState: 'open', removed: false, running: false,
  promptAttempted: true, awaitingFirstTurn: false, pendingSubmissions: [],
};
const baseRecord: WorktreeRecord = {
  id: 'worktree-one', operationId: 'create-one', effectiveCwd: '/worktrees/one',
  remote: 'origin', remoteBranch: 'main', baseOid: 'a'.repeat(40), sessionIds: ['target', 'second'],
  branch: 'feature/one', protected: false, archived: false, state: 'ready',
};
function workspace(sessionIds = ['target', 'second'], path = baseRecord.effectiveCwd): Workspace {
  return { workspaceId: 'workspace-one', path, title: 'Worktree one', sessionIds };
}
function mainActor(list: SessionList) {
  const ids = Object.keys(list.byId).filter(id => (list.byId[id]!.retainedBy.mainView || 0) > 0 && list.byId[id]!.origin !== 'subagent');
  return ids.length === 1 ? ids[0] : undefined;
}
function button(container: ParentNode, label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
  assert.ok(result, `the real RecordCard renders button ${label}`); return result;
}
async function click(element: HTMLButtonElement) { await act(async () => element.click()); }

async function mountCard(t: TestContext, options: FixtureOptions = {}) {
  let record = { ...baseRecord, ...options.record };
  const deadlineStart = deadlines.length;
  const actorId = options.actorId === undefined ? 'source' : options.actorId;
  const calls = { requests: [] as Request[], retain: [] as string[], refresh: 0, open: [] as string[], forbidden: [] as string[], changed: 0 };
  const events: string[] = [], references: Reference[] = [], bindings = new Map<string, Binding>();
  const ready = new Map<string, ReturnType<typeof deferred<Binding>>>(), snapshots = new Map<string, ReturnType<typeof observable<SessionSnapshot>>>();
  const coldIds = new Set(options.coldIds || []);
  const effect = (factory: () => () => void) => factory();
  function session(id: string) {
    let state = snapshots.get(id);
    if (!state) { state = observable({ ...openSnapshot, ...options.snapshots?.[id] }); snapshots.set(id, state); }
    return state;
  }
  function makeBinding(id: string): Binding { return { ctx: { effect }, session: session(id) }; }
  const initial: SessionList = { byId: {} };
  for (const id of new Set([...(options.knownIds || ['source', 'target', 'second']), ...(actorId ? [actorId] : [])])) {
    initial.byId[id] = { displayTitle: `Conversation ${id}`, origin: 'user', retainedBy: { mainView: id === actorId ? 1 : 0 } };
    if (coldIds.has(id)) ready.set(id, deferred<Binding>()); else bindings.set(id, makeBinding(id));
  }
  for (const id of coldIds) if (!ready.has(id)) ready.set(id, deferred<Binding>());
  const list = observable(initial), statuses = observable(new Map<string, { running?: boolean }>());
  const workspaces = new NativeWorkspaceStore({ phase: 'ready', items: options.workspaceItems || [workspace()], archivedSessionIds: [], pinnedSessionIds: [], ...options.workspace });
  const generation = observable<{ id: number } | undefined>({ id: 1 });
  // This wrapper supplies metadata as props, just as the real Manager does.
  const metadata = observable({ records: [record] });
  let navigation = new AbortController(), mounted = true;
  const retainInfo = new Map<string, ReturnType<typeof observable<{ retainedBy: Record<string, number> }>>>();
  function publishList(next: SessionList) {
    list.publish(next);
    for (const [id, store] of retainInfo) store.publish({ retainedBy: next.byId[id]?.retainedBy || {} });
  }
  function controllerOwnership(id: string, delta: number) {
    const current = list.getSnapshot(), item = current.byId[id]!;
    const count = (item.retainedBy.controllerOperation || 0) + delta; assert.ok(count >= 0);
    publishList({ byId: { ...current.byId, [id]: { ...item, retainedBy: { ...item.retainedBy, controllerOperation: count } } } });
  }
  function selectMain(id: string | null) {
    const next = { byId: Object.fromEntries(Object.entries(list.getSnapshot().byId).map(([key, item]) => [key, { ...item, retainedBy: { ...item.retainedBy, mainView: key === id ? 1 : 0 } }])) };
    publishList(next);
  }
  function forbidden(name: string): never { calls.forbidden.push(name); throw new Error(`Open must not ${name}`); }
  const runtime = {
    effect,
    sessions: {
      list,
      binding(id: string | undefined) { return id ? bindings.get(id) : undefined; },
      retain(id: string, ownership: { source: string }) {
        calls.retain.push(id); events.push(`retain:${id}`); assert.equal(ownership.source, 'controllerOperation');
        // Real retain cannot resolve a workspace-discovered ID until the catalog
        // knows it. Returning an arbitrary binding here would hide that regression.
        if (!list.getSnapshot().byId[id]) throw new Error(`Unknown session: ${id}`);
        const reference: Reference = {
          sessionId: id, ready: ready.get(id)?.promise || bindings.get(id) || makeBinding(id), releases: 0,
          release() {
            this.releases += 1; events.push(`release:${id}`); assert.equal(this.releases, 1, 'each acquired controller reference is released once');
            controllerOwnership(id, -1);
          },
        };
        references.push(reference);
        // Real retention publishes the list synchronously and can re-enter the
        // discovery subscription before retain returns its reference.
        controllerOwnership(id, 1); return reference;
      },
      async refresh() {
        calls.refresh += 1; events.push('refresh'); await options.refreshWait;
        const next = { byId: { ...list.getSnapshot().byId } };
        for (const id of options.discoverIds || []) {
          next.byId[id] = { displayTitle: `Conversation ${id}`, origin: 'user', retainedBy: {} };
          if (!coldIds.has(id)) bindings.set(id, makeBinding(id));
        }
        publishList(next);
      },
      retainInfo(id: string) {
        let store = retainInfo.get(id);
        if (!store) { store = observable({ retainedBy: list.getSnapshot().byId[id]?.retainedBy || {} }); retainInfo.set(id, store); }
        return store;
      },
      create() { return forbidden('create a session'); }, fork() { return forbidden('fork a session'); },
    },
    workspaces: { list: workspaces }, uiSession: { sessionStatus: statuses },
    connection: { generation, rpc: { async call(channel: string, endpoint: string, payload: { v: number; actorId?: string; request: Request }) {
      calls.requests.push({ ...payload.request });
      assert.equal(channel, '/api'); assert.equal(endpoint, 'dsh-worktrees/execute'); assert.equal(payload.v, 1);
      assert.equal(payload.request.action, 'status', 'mount-time status is the only allowed Host action');
      return { ok: true, value: { v: 1, ok: true, data: { settingsHash: 'settings-one', worktree: record, status: { dirty: false, head: record.baseOid, changes: 0, untracked: 0 } } } };
    } } },
    layout: {
      beginNavigation() { navigation.abort(); navigation = new AbortController(); return navigation.signal; },
      selectPanel() { navigation.abort(); },
    },
    uiWorkspace: {
      openSession(id: string) {
        calls.open.push(id); events.push(`open:${id}`);
        const reference = references.filter(item => item.sessionId === id).at(-1);
        assert.ok(reference, 'native Open receives the exact acquired destination');
        assert.equal(reference.releases, 0, 'controller ownership survives until native main-view acquisition');
        assert.equal(list.getSnapshot().byId[id]!.retainedBy.controllerOperation, 1);
        if (options.nativeError) throw options.nativeError;
        // The native API takes mainView ownership synchronously, before returning.
        selectMain(id); events.push(`main:${id}`);
      },
      startSession() { return forbidden('start a session'); },
    },
  };
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  function Card() {
    const currentList = React.useSyncExternalStore(list.subscribe, list.getSnapshot);
    const currentStatuses = React.useSyncExternalStore(statuses.subscribe, statuses.getSnapshot);
    const currentMetadata = React.useSyncExternalStore(metadata.subscribe, metadata.getSnapshot);
    return React.createElement(RecordCard, {
      record: currentMetadata.records[0]!, runtime, actorId: mainActor(currentList), list: currentList, sessionStatuses: currentStatuses,
      t: (key: string) => real.en[key] || key, onChanged() { calls.changed += 1; }, onPreview() {},
    });
  }
  async function unmount() { if (mounted) { mounted = false; await act(async () => root.unmount()); container.remove(); } }
  t.after(async () => {
    await unmount();
    assert.deepEqual(calls.forbidden, [], 'Open never creates, starts or forks a conversation');
    assert.ok(calls.requests.every(request => request.action === 'status'), 'Open never sends start/create/fork/continue RPCs');
    assert.equal(calls.changed, 0, 'opening an existing conversation is not a worktree mutation');
    for (const reference of references) assert.equal(reference.releases, 1, `released ${reference.sessionId}`);
    assert.ok(Object.values(list.getSnapshot().byId).every(item => !item.retainedBy.controllerOperation), 'no controller retention leaks');
    assert.equal(workspaces.listenerCount(), 0, 'unmount releases every native workspace listener');
    assert.equal(workspaces.subscriptions, workspaces.releases, 'native workspace subscriptions are balanced');
  });
  await act(async () => root.render(React.createElement(Card)));
  return {
    container, calls, events, references, runtime, list, workspaces, generation, metadata, bindings, session, unmount,
    open: () => button(container, 'Open conversation'), row: (id: string) => button(container, list.getSnapshot().byId[id]?.displayTitle || id),
    alert: () => container.querySelector('[role=alert]')?.textContent || '',
    async resolve(id: string, patch: Partial<SessionSnapshot> = {}, beforeCommit?: () => void) {
      await act(async () => {
        session(id).publish({ ...session(id).getSnapshot(), ...patch }); const binding = makeBinding(id); bindings.set(id, binding); ready.get(id)!.resolve(binding);
        if (beforeCommit) queueMicrotask(beforeCommit);
      });
    },
    async expire() {
      const pending = deadlines.slice(deadlineStart); assert.equal(pending.length, 1, 'one bounded exact-session wait');
      assert.equal(pending[0]!.milliseconds, 30000); await act(async () => pending[0]!.controller.abort());
    },
    async reject(id: string, failure: Error) { await act(async () => ready.get(id)!.reject(failure)); },
    async select(id: string | null) { await act(async () => selectMain(id)); },
    async navigate() { await act(async () => runtime.layout.beginNavigation()); },
    async updateRecord(patch: Partial<WorktreeRecord>) { await act(async () => { record = { ...record, ...patch }; metadata.publish({ ...metadata.getSnapshot(), records: [record] }); }); },
  };
}

test('receiver-dependent native workspace methods mount, update, and release through the actual RecordCard', async (t) => {
  const native = new NativeWorkspaceStore({ phase: 'ready', items: [workspace()], archivedSessionIds: [], pinnedSessionIds: [] });
  const nakedSnapshot = native.getSnapshot, nakedSubscribe = native.subscribe;
  assert.equal(Object.hasOwn(native, 'getSnapshot'), false, 'getSnapshot is a native-style prototype method');
  assert.equal(Object.hasOwn(native, 'subscribe'), false, 'subscribe is a native-style prototype method');
  assert.throws(() => nakedSnapshot(), TypeError, 'a detached getSnapshot loses its refreshSnapshot receiver');
  assert.throws(() => nakedSubscribe(() => {}), TypeError, 'a detached subscribe loses its listener receiver');
  assert.equal(native.listenerCount(), 0);

  const card = await mountCard(t, { coldIds: ['target'] });
  assert.ok(card.workspaces.snapshotRefreshes > 0, 'the real React hook reads the native facade');
  assert.equal(card.workspaces.listenerCount(), 1, 'the mounted hook owns one native subscription');
  const mountedSubscriptions = card.workspaces.subscriptions;
  await act(async () => card.workspaces.publish({ ...card.workspaces.getSnapshot(), items: [] }));
  assert.equal(card.open().disabled, true); assert.equal(card.row('target').disabled, true);
  await act(async () => card.workspaces.publish({ ...card.workspaces.getSnapshot(), items: [workspace()] }));
  assert.equal(card.open().disabled, false); assert.equal(card.row('target').disabled, false);
  assert.equal(card.workspaces.subscriptions, mountedSubscriptions, 'stable hook adapters do not resubscribe on snapshot changes');

  await click(card.open());
  assert.equal(card.workspaces.listenerCount(), 2, 'the in-flight Open also watches authoritative membership');
  await act(async () => card.workspaces.publish({ ...card.workspaces.getSnapshot(), items: [] }));
  assert.equal(card.references[0]!.releases, 1); assert.deepEqual(card.calls.open, []);
  assert.equal(card.workspaces.listenerCount(), 1, 'cancellation releases the operation watcher but keeps the mounted hook');
  await card.unmount();
  assert.equal(card.workspaces.listenerCount(), 0); assert.equal(card.workspaces.subscriptions, card.workspaces.releases);
  await card.resolve('target'); assert.deepEqual(card.calls.open, [], 'late ready cannot reopen the unmounted card');
});

test('manager Open repeatedly selects the same deterministic existing member and never forks', async (t) => {
  const card = await mountCard(t, { record: { sessionIds: ['stale', 'target', 'second'] }, knownIds: ['source', 'stale', 'target', 'second'] });
  assert.equal(card.calls.requests.length, 1, 'the existing mount-time status check still runs');
  assert.equal(card.open().disabled, false); assert.equal(card.row('stale').disabled, true);
  await click(card.open()); await click(card.open());
  assert.deepEqual(card.calls.open, ['target', 'target']); assert.deepEqual(card.calls.retain, ['target', 'target']);
  assert.equal(card.calls.refresh, 0); assert.equal(card.alert(), '');
  assert.deepEqual(card.events, ['retain:target', 'open:target', 'main:target', 'release:target', 'retain:target', 'open:target', 'main:target', 'release:target']);
});

test('the current main member is preferred over record order, but a stale current ID is not', async (t) => {
  const member = await mountCard(t, { actorId: 'second' }); await click(member.open());
  assert.deepEqual(member.calls.open, ['second']);
  const stale = await mountCard(t, { actorId: 'stale', record: { sessionIds: ['stale', 'target', 'second'] }, knownIds: ['stale', 'target', 'second'] });
  await click(stale.open()); assert.deepEqual(stale.calls.open, ['target']);
});

test('read-only existing-session Open needs no selected source actor', async (t) => {
  const card = await mountCard(t, { actorId: null }); assert.equal(card.open().disabled, false);
  assert.deepEqual(card.calls.requests, [], 'no actor is needed or resolved for a Host read');
  await click(card.open()); assert.deepEqual(card.calls.open, ['target']);
});

test('per-session row Open acquires and opens that exact ID rather than the default member', async (t) => {
  const card = await mountCard(t); await click(card.row('second'));
  assert.deepEqual(card.calls.open, ['second']); assert.deepEqual(card.calls.retain, ['second']);
});

for (const viaRow of [false, true]) {
  test(`cold known destination waits for its retained binding before ${viaRow ? 'row' : 'manager'} Open`, async (t) => {
    const card = await mountCard(t, { coldIds: ['target'] });
    await click(viaRow ? card.row('target') : card.open());
    assert.deepEqual(card.calls.open, []); assert.equal(card.references.length, 1); assert.equal(card.references[0]!.releases, 0);
    assert.equal(card.calls.refresh, 0, 'a known cold session does not need catalog discovery');
    await card.resolve('target'); assert.deepEqual(card.calls.open, ['target']); assert.equal(card.references[0]!.releases, 1);
  });
}

test('unknown workspace member refreshes the catalog once, then retains and waits for its exact binding', async (t) => {
  const card = await mountCard(t, { knownIds: ['source'], record: { sessionIds: ['discovered'] }, workspaceItems: [workspace(['discovered'])], discoverIds: ['discovered'], coldIds: ['discovered'] });
  await click(card.open());
  assert.equal(card.calls.refresh, 1); assert.equal(card.references.length, 1); assert.deepEqual(card.calls.open, []);
  assert.equal(card.references[0]!.sessionId, 'discovered');
  await card.resolve('discovered'); assert.deepEqual(card.calls.open, ['discovered']); assert.equal(card.calls.refresh, 1);
});

test('a member still absent after the single catalog refresh fails without opening or leaking', async (t) => {
  const card = await mountCard(t, { knownIds: ['source'], record: { sessionIds: ['missing'] }, workspaceItems: [workspace(['missing'])] });
  await click(card.open()); assert.equal(card.calls.refresh, 1); assert.equal(card.references.length, 0);
  assert.equal(card.open().disabled, true, 'discovery remains pending after the baseline pull');
  await card.expire(); assert.deepEqual(card.calls.open, []); assert.match(card.alert(), /Timed out/); assert.equal(card.open().disabled, false);
});

for (const [name, options] of [
  ['moved to another checkout', { workspaceItems: [workspace(['target', 'second'], '/different/checkout')] }],
  ['detached from the checkout', { workspaceItems: [workspace([])] }],
  ['missing from authoritative workspaces', { workspaceItems: [] }],
  ['workspace list not ready', { workspace: { phase: 'loading' } }],
  ['no record candidates', { record: { sessionIds: [] } }],
  ['archived record', { record: { archived: true } }],
  ['creating record', { record: { state: 'creating' } }],
  ['missing record', { record: { state: 'missing' } }],
  ['recovery-required record', { record: { state: 'recovery-required' } }],
] satisfies [string, FixtureOptions][]) {
  test(`manager and row Open are disabled for ${name}`, async (t) => {
    const card = await mountCard(t, options); assert.equal(card.open().disabled, true); await click(card.open());
    for (const id of options.record?.sessionIds || baseRecord.sessionIds) { assert.equal(card.row(id).disabled, true); await click(card.row(id)); }
    assert.deepEqual(card.calls.open, []); assert.deepEqual(card.calls.retain, []); assert.equal(card.calls.refresh, 0);
  });
}

for (const phase of ['planned', 'preserving', 'removing', 'collected', 'recovery-required']) {
  test(`cleanup ${phase} disables both manager and row navigation`, async (t) => {
    const cleanup = { phase, inactivityDays: 30, lastActivityAt: null, eligibleAfter: null, reclaimedAt: null, originalFolder: null, recoveryRef: null, reason: null };
    const card = await mountCard(t, { record: { cleanup } });
    assert.equal(card.open().disabled, true); assert.equal(card.row('target').disabled, true);
    await click(card.open()); await click(card.row('target')); assert.deepEqual(card.calls.open, []);
  });
}

for (const [name, snapshot] of [
  ['ready resolves to an error state', { openState: 'error' }],
  ['ready resolves to a removed session', { removed: true }],
  ['ready resolves to a subagent session', { subagent: { parentSessionId: 'source' } }],
  ['ready resolves without an explicitly ordinary session', { subagent: undefined }],
] satisfies [string, Partial<SessionSnapshot>][]) {
  test(`${name} cannot open and releases the acquired reference`, async (t) => {
    const card = await mountCard(t, { coldIds: ['target'] }); await click(card.open()); await card.resolve('target', snapshot);
    assert.deepEqual(card.calls.open, []); assert.equal(card.references[0]!.releases, 1); assert.ok(card.alert()); assert.equal(card.open().disabled, false);
  });
}

for (const [name, patch] of [
  ['error', { openState: 'error' }], ['removed', { removed: true }], ['subagent', { subagent: { parentSessionId: 'source' } }],
] satisfies [string, Partial<SessionSnapshot>][]) {
  test(`destination becoming ${name} after readiness validation is rechecked at native commit`, async (t) => {
    const card = await mountCard(t, { coldIds: ['target'] }); await click(card.open());
    // Resolve first: the helper validates its binding in its queued continuation.
    // The following microtask then changes state before RecordCard can commit.
    await card.resolve('target', {}, () => card.session('target').publish({ ...card.session('target').getSnapshot(), ...patch }));
    assert.deepEqual(card.calls.open, []); assert.equal(card.references[0]!.releases, 1); assert.ok(card.alert());
  });
}

test('an opening deadline releases ownership even when ready never settles, and late ready cannot navigate', async (t) => {
  const card = await mountCard(t, { coldIds: ['target'] }); await click(card.open()); await card.expire();
  assert.equal(card.references[0]!.releases, 1); assert.match(card.alert(), /Timed out/);
  await card.resolve('target'); assert.deepEqual(card.calls.open, []); assert.equal(card.references[0]!.releases, 1);
});

test('a rejected retained ready promise is handled and releases ownership', async (t) => {
  const card = await mountCard(t, { coldIds: ['target'] }); await click(card.row('target'));
  await card.reject('target', new Error('Retained binding failed')); assert.deepEqual(card.calls.open, []);
  assert.equal(card.references[0]!.releases, 1); assert.match(card.alert(), /Retained binding failed/);
});

test('running and nonblank destinations remain valid existing conversations', async (t) => {
  const card = await mountCard(t, { snapshots: { target: { running: true, blank: false, pendingSubmissions: [{}], awaitingFirstTurn: true } } });
  await act(async () => card.runtime.uiSession.sessionStatus.publish(new Map([['target', { running: true }]])));
  assert.equal(card.open().disabled, false); assert.equal(card.row('target').disabled, false);
  await click(card.open()); assert.deepEqual(card.calls.open, ['target']); assert.equal(card.alert(), '');
});

for (const viaRow of [false, true]) {
  test(`synchronous native ${viaRow ? 'row' : 'manager'} Open failure releases its reference and reports the error`, async (t) => {
    const card = await mountCard(t, { nativeError: new Error('Native open refused') });
    await click(viaRow ? card.row('target') : card.open());
    assert.deepEqual(card.calls.open, ['target']); assert.equal(card.references[0]!.releases, 1);
    assert.match(card.alert(), /Native open refused/); assert.equal(card.open().disabled, false);
    assert.deepEqual(card.events, ['retain:target', 'open:target', 'release:target']);
  });
}

test('rapid manager and row clicks share one in-flight Open and one retained destination', async (t) => {
  const card = await mountCard(t, { coldIds: ['target'] });
  await act(async () => { card.open().click(); card.open().click(); card.row('second').click(); });
  assert.deepEqual(card.calls.retain, ['target']); assert.equal(card.references.length, 1); assert.deepEqual(card.calls.open, []);
  await card.resolve('target'); assert.deepEqual(card.calls.open, ['target']);
});

for (const cause of ['unmount', 'navigation', 'generation', 'generation-away-and-back', 'main-selection', 'main-selection-away-and-back', 'record-path', 'record-membership', 'record-archive', 'record-metadata', 'workspace-moved', 'workspace-detached', 'workspace-not-ready']) {
  test(`${cause} while retaining prevents any late manager Open`, async (t) => {
    const card = await mountCard(t, { coldIds: ['target'] }); await click(card.open()); assert.equal(card.references.length, 1);
    if (cause === 'unmount') await card.unmount();
    else if (cause === 'navigation') await card.navigate();
    else if (cause === 'generation' || cause === 'generation-away-and-back') {
      await act(async () => { card.generation.publish({ id: 2 }); if (cause.endsWith('away-and-back')) card.generation.publish({ id: 1 }); });
    } else if (cause === 'main-selection' || cause === 'main-selection-away-and-back') {
      await card.select('second'); if (cause.endsWith('away-and-back')) await card.select('source');
    } else if (cause === 'record-path') await card.updateRecord({ effectiveCwd: '/worktrees/replaced' });
    else if (cause === 'record-membership') await card.updateRecord({ sessionIds: ['second'] });
    else if (cause === 'record-archive') await card.updateRecord({ archived: true });
    else if (cause === 'record-metadata') await card.updateRecord({ branch: 'feature/renamed' });
    else await act(async () => card.workspaces.publish({ ...card.workspaces.getSnapshot(),
      ...(cause === 'workspace-not-ready' ? { phase: 'loading' } : { items: [workspace(cause === 'workspace-detached' ? ['second'] : ['target', 'second'], cause === 'workspace-moved' ? '/worktrees/moved' : baseRecord.effectiveCwd)] }),
    }));
    await card.resolve('target'); assert.deepEqual(card.calls.open, []); assert.equal(card.references[0]!.releases, 1);
  });
}

for (const cause of ['metadata-only replacement', 'main actor replacement']) {
  test(`${cause} cancels the cold wait, releases once, and permits a fresh exact-ID Open`, async (t) => {
    const card = await mountCard(t, { knownIds: ['source', 'replacement', 'target', 'second'], coldIds: ['target'] });
    await click(card.open()); assert.equal(card.references.length, 1); assert.equal(card.open().disabled, true);
    if (cause === 'metadata-only replacement') await card.updateRecord({ branch: 'feature/renamed' });
    else await card.select('replacement');
    assert.deepEqual(card.calls.open, [], 'the abandoned operation never navigates');
    assert.equal(card.references[0]!.releases, 1, 'lifetime cancellation releases without waiting for ready');
    assert.equal(card.open().disabled, false, 'the still-valid reused card must not keep its old busy latch');
    await click(card.open());
    assert.deepEqual(card.calls.retain, ['target', 'target']); assert.equal(card.references.length, 2);
    assert.equal(card.references[1]!.releases, 0); assert.deepEqual(card.calls.open, []);
    await card.resolve('target');
    assert.deepEqual(card.calls.open, ['target'], 'only the fresh operation commits when the shared ready settles');
    assert.equal(card.references[0]!.releases, 1); assert.equal(card.references[1]!.releases, 1); assert.equal(card.open().disabled, false);
  });
}

test('a pending per-session row Open obeys the same navigation cancellation guard', async (t) => {
  const card = await mountCard(t, { coldIds: ['second'] }); await click(card.row('second')); await card.navigate();
  await card.resolve('second'); assert.deepEqual(card.calls.open, []); assert.equal(card.references[0]!.releases, 1);
});

test('cancelling during unknown-session refresh never retains or opens the late discovered target', async (t) => {
  const refresh = deferred<void>();
  const card = await mountCard(t, { knownIds: ['source'], record: { sessionIds: ['discovered'] }, workspaceItems: [workspace(['discovered'])], discoverIds: ['discovered'], refreshWait: refresh.promise });
  await click(card.open()); assert.equal(card.calls.refresh, 1); assert.equal(card.references.length, 0); await card.navigate();
  await act(async () => refresh.resolve()); assert.deepEqual(card.calls.open, []); assert.equal(card.references.length, 0); assert.equal(card.calls.refresh, 1);
});
