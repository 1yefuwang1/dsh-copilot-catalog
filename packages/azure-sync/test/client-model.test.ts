import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  CLOUD_CLIENT_MAX_FLIGHTS, CLOUD_STATUS_POLL_MS, CLOUD_STATUSES, CloudClientError, cloudClientErrorCode,
  createCloudClient, decodeCloudReply, type CloudClientRuntime, type CloudLocalView, type CloudRequest, type CloudSettingsView,
} from '../client-model.js';
import type { CloudBlock } from '../client-blocks.js';

function store<T>(initial: T) {
  let value = initial; const listeners = new Set<() => void>();
  return { getSnapshot: () => value, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, set(next: T) { value = next; for (const listener of [...listeners]) listener(); }, get subscriptions() { return listeners.size; } };
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
const wire = (data: unknown) => ({ ok: true, value: { v: 1, ok: true, data } });
const settings = (): CloudSettingsView => ({ auth: 'azure-cli', accountName: 'account', managedIdentityClientId: '', connectionRef: 'AZURE_STORAGE_CONNECTION_STRING', container: 'sessions', table: 'Sessions', endpointSuffix: 'core.windows.net', defaultEnabled: false, pullOnStartup: false, pollSeconds: 30, authPending: false, connection: { configured: false, writable: true } });
const record = (sessionId = 's', patch: Partial<CloudLocalView> = {}): CloudLocalView => ({ sessionId, enabled: true, state: 'active', status: 'synced', generation: 1, detached: false, admissionRequired: true, admissionStopped: false, restartRequired: false, needsFolder: false, mappingUnstable: false, degradedAttachmentCount: 0, degradedAcknowledged: false, hasConflictBackup: false, ...patch });
const local = (sessionId = 's'): CloudLocalView => record(sessionId, { enabled: false, state: 'disabled', status: 'detached', detached: true, admissionRequired: false });
interface Call { route: string; endpoint: string; payload: { v: number; request: CloudRequest }; signal?: AbortSignal }
async function flush() { await setImmediate(); }
function fixture(t: TestContext) {
  const generation = store<{ id: number } | undefined>({ id: 1 }), records = new Map<string, CloudLocalView>(), blockStores = new Map<string, ReturnType<typeof store<CloudBlock | undefined>>>();
  const calls: Call[] = [], blockWrites: Array<{ sessionId: string; value: CloudBlock | undefined }> = [];
  let currentSettings = settings(), projection = 'a'.repeat(64), refreshes = 0;
  const blockStore = (id: string) => { let found = blockStores.get(id); if (!found) { found = store<CloudBlock | undefined>(undefined); blockStores.set(id, found); } return found; };
  function defaultReply(request: CloudRequest): unknown {
    if (request.action === 'status') {
      const items = request.sessionId === undefined ? [...records.values()].slice(0, 100) : records.has(request.sessionId) ? [records.get(request.sessionId)!] : [];
      return { kind: 'status', revision: 0, projectionRevision: projection, settings: currentSettings, items,
        ...(request.sessionId !== undefined && items.length === 0 ? { untracked: { sessionId: request.sessionId, enabled: false, admissionRequired: false } } : {}) };
    }
    if (request.action === 'git-info') return { kind: 'git', sessionId: request.sessionId, local: null };
    if (request.action === 'mappings') return { kind: 'mappings', items: [] };
    if (request.action === 'pull' && request.sessionId === undefined) return { kind: 'remote', items: [] };
    if (request.action === 'set-auth' || request.action === 'set-defaults') return { kind: 'settings', settings: currentSettings };
    if (request.action === 'test-auth') return { kind: 'auth-test', configured: true };
    if (request.action === 'map') return { kind: 'mapping', mapping: { ...request.mapping, id: request.mapping.id ?? 'mapping', revision: 'b'.repeat(64) } };
    if (request.action === 'unmap') return { kind: 'mapping-removed', mappingId: request.mappingId };
    const id = 'sessionId' in request ? request.sessionId : undefined;
    const detail = request.action === 'check-ownership' || request.action === 'takeover' ? { owned: true }
      : request.action === 'sync' || (request.action === 'toggle' && request.enabled) ? { status: 'synced', eventCount: 1, uploadedBatches: 0 }
      : request.action === 'export' ? { exportPath: '/safe/export.jsonl' } : undefined;
    return { kind: 'action', action: request.action, sessionId: id, state: records.get(id!)?.status ?? 'setup-needed', ...(detail ? { detail } : {}) };
  }
  let handler = (request: CloudRequest, _call: Call): unknown | Promise<unknown> => defaultReply(request);
  const runtime: CloudClientRuntime = {
    connection: { generation, rpc: { async call(route, endpoint, payload, signal) {
      const call = { route, endpoint, payload: payload as Call['payload'], signal }; calls.push(call);
      return wire(await handler(call.payload.request, call));
    } } },
    sessions: { refresh() { refreshes++; } },
    conversation: { blocks: { storeFor: blockStore, set(sessionId, value) { const target = blockStore(sessionId); if (target.getSnapshot()?.reason === value?.reason) return; blockWrites.push({ sessionId, value }); target.set(value); } } },
  };
  const model = createCloudClient(runtime); t.after(() => model.dispose());
  return { model, runtime, generation, records, calls, blockWrites, blockStore, defaultReply,
    setHandler(next: typeof handler) { handler = next; }, setSettings(value: CloudSettingsView) { currentSettings = value; }, setProjection(value: string) { projection = value; }, get refreshes() { return refreshes; },
    count(action: CloudRequest['action']) { return calls.filter(call => call.payload.request.action === action).length; },
  };
}
function rejectsCode(promise: Promise<unknown>, code: string) { return assert.rejects(promise, error => error instanceof CloudClientError && cloudClientErrorCode(error) === code); }

// The decoder is exercised independently of the fixture so a fabricated SDK frame cannot pass accidentally.
test('SDK carrier and application version are exact; global status/catalog/settings DTOs decode without Agent/session context', () => {
  const data = { kind: 'status', revision: 0, projectionRevision: 'a'.repeat(64), settings: settings(), items: [] };
  const reply = decodeCloudReply({ action: 'status' }, wire(data)); assert.equal(reply.kind, 'status'); assert.ok(Object.isFrozen(reply)); assert.ok(Object.isFrozen(reply.settings));
  const invalid = [data, { v: 1, ok: true, data }, { type: 'server-response', rpcId: 'x', result: wire(data) }, { ok: true, value: { v: 2, ok: true, data } }, { ...wire(data), extra: true }, wire({ ...data, lastError: 'raw provider data' }), wire({ ...data, settings: { ...settings(), connectionString: 'secret' } })];
  for (const input of invalid) assert.throws(() => decodeCloudReply({ action: 'status' }, input), error => cloudClientErrorCode(error) === 'MALFORMED_REPLY');
  assert.deepEqual(decodeCloudReply({ action: 'pull' }, wire({ kind: 'remote', items: [] })), { kind: 'remote', items: [] });
});

test('response bounds reject accessors/toJSON/class instances and never read provider errors or expose error messages', () => {
  let touched = 0;
  const hostile = Object.defineProperty({}, 'ok', { enumerable: true, get() { touched++; throw new Error('secret'); } });
  const toJSON = { toJSON() { touched++; return wire({}); } };
  for (const input of [hostile, toJSON, new Error('secret'), wire({ text: 'x'.repeat(300_000) })]) assert.throws(() => decodeCloudReply({ action: 'status' }, input), error => cloudClientErrorCode(error) === 'MALFORMED_REPLY');
  assert.equal(touched, 0);
  const provider = Object.defineProperties({}, { code: { get() { touched++; throw 1; } }, message: { get() { touched++; throw 1; } }, toJSON: { get() { touched++; throw 1; } } });
  assert.equal(cloudClientErrorCode(provider), 'OPERATION_FAILED'); assert.equal(touched, 0);
  let error: unknown;
  try { decodeCloudReply({ action: 'mappings' }, { ok: true, value: { v: 1, ok: false, error: { code: 'OPERATION_FAILED', message: 'AccountKey=do-not-expose' } } }); } catch (caught) { error = caught; }
  assert.equal(cloudClientErrorCode(error), 'OPERATION_FAILED'); assert.ok(!String(error).includes('do-not-expose'));
  assert.throws(() => decodeCloudReply({ action: 'mappings' }, { ok: true, value: { v: 1, ok: false, error: { code: 'AccountKey=secret', message: 'secret' } } }), error => cloudClientErrorCode(error) === 'MALFORMED_REPLY');
  assert.throws(() => decodeCloudReply({ action: 'mappings' }, { ok: false, error: { code: 'provider', message: 'secret', details: {} } }), error => cloudClientErrorCode(error) === 'TRANSPORT' && !String(error).includes('secret'));
});

test('strict known shape checks include authPending/connection metadata, all local flags, mappings, remote advisory metadata, and action detail', () => {
  const view = settings();
  const pending: CloudSettingsView = { ...view, authPending: true, pendingAuth: { auth: 'managed-identity', accountName: 'newaccount', managedIdentityClientId: 'target-client' }, connection: { configured: false, writable: false, available: false, requiresUpdate: true } };
  assert.equal(decodeCloudReply({ action: 'set-auth', auth: 'auto' }, wire({ kind: 'settings', settings: pending })).settings.authPending, true);
  const remote = { sessionId: 'r', generation: 1, state: 'active', enabled: true, eventCount: 0, updatedAt: 1, sourcePlatform: 'linux', rootSessionId: 'r', rootGeneration: 1, cwd: '/remote', sourceDeviceId: 'device', lastWriterDevice: 'writer', leaseOwner: 'advisory', leaseUntil: 123 };
  assert.equal(decodeCloudReply({ action: 'pull' }, wire({ kind: 'remote', items: [remote] })).kind, 'remote');
  for (const extra of [{ rawHeader: {} }, { receipt: {} }, { lastError: 'secret' }, { leaseUntil: 'not-number' }]) assert.throws(() => decodeCloudReply({ action: 'pull' }, wire({ kind: 'remote', items: [{ ...remote, ...extra }] })));
  assert.throws(() => decodeCloudReply({ action: 'check-ownership', sessionId: 's' }, wire({ kind: 'action', action: 'check-ownership', sessionId: 'other', state: 'synced', detail: { owned: true } })));
  assert.throws(() => decodeCloudReply({ action: 'check-ownership', sessionId: 's' }, wire({ kind: 'action', action: 'check-ownership', sessionId: 's', state: 'synced', detail: { owned: true, leaseUntil: 123 } })));
  assert.throws(() => decodeCloudReply({ action: 'sync', sessionId: 's' }, wire({ kind: 'action', action: 'sync', sessionId: 's', state: 'synced' })));
});

test('unknown/new default-off thread is blocked until explicit untracked status; rewatch discards cached local permission', async t => {
  const f = fixture(t), first = deferred(), later = deferred(); let pending = first;
  f.setHandler(request => request.action === 'status' ? pending.promise : f.defaultReply(request));
  assert.equal(f.model.getThread('s').blocked, true);
  const release = f.model.watchSession('s'); assert.ok(f.blockStore('s').getSnapshot()); assert.equal(f.model.getThread('s').phase, 'loading');
  first.resolve(f.defaultReply({ action: 'status', sessionId: 's' })); await flush();
  assert.equal(f.model.getThread('s').phase, 'local'); assert.equal(f.count('check-ownership'), 0); assert.equal(f.blockStore('s').getSnapshot(), undefined);
  release(); assert.equal(f.blockStore('s').subscriptions, 0); pending = later;
  f.records.set('s', record()); const stop = f.model.watchSession('s'); assert.equal(f.model.getThread('s').blocked, true); assert.ok(f.blockStore('s').getSnapshot());
  later.resolve(f.defaultReply({ action: 'status', sessionId: 's' })); await flush(); assert.equal(f.model.getThread('s').phase, 'ready'); stop();
});

test('cloud enabled needs complete/degraded acknowledgement and a fresh ownership check; repeated watchers share one scope', async t => {
  const f = fixture(t), proof = deferred(); f.records.set('s', record());
  f.setHandler(request => request.action === 'check-ownership' ? proof.promise : f.defaultReply(request));
  const a = f.model.watchSession('s'), b = f.model.watchSession('s'); await flush();
  assert.equal(f.count('check-ownership'), 1); assert.equal(f.model.getThread('s').blocked, true); const marker = f.blockStore('s').getSnapshot(); assert.ok(marker);
  a(); assert.equal(f.blockStore('s').getSnapshot(), marker); assert.equal(f.blockStore('s').subscriptions, 1);
  proof.resolve(f.defaultReply({ action: 'check-ownership', sessionId: 's' })); await flush();
  assert.equal(f.model.getThread('s').phase, 'ready'); assert.equal(f.model.getThread('s').provisional, true); assert.equal(f.model.getThread('s').flags.ownershipVerified, true);
  b(); assert.equal(f.blockStore('s').getSnapshot(), undefined); assert.equal(f.blockStore('s').subscriptions, 0);
});

test('ownership inspection changing synced -> syncing uses one post-check local status, not a second Azure ownership call', async t => {
  const f = fixture(t); f.records.set('s', record());
  f.setHandler(request => { if (request.action === 'check-ownership') f.records.set('s', record('s', { status: 'syncing' })); return f.defaultReply(request); });
  f.model.watchSession('s'); await flush(); assert.equal(f.model.getThread('s').phase, 'ready'); assert.equal(f.count('check-ownership'), 1); assert.equal(f.count('status'), 2);
});

test('local/off/detached is permitted only with admissionRequired:false; enabled:false remote stop remains blocked', async t => {
  const f = fixture(t); f.records.set('safe', local('safe'));
  for (const status of ['removed-remotely', 'generation-changed', 'remote-missing', 'conflict', 'remote-ahead-live'] as const) { f.records.set(status, record(status, { enabled: false, state: 'disabled', status })); f.model.watchSession(status); }
  f.model.watchSession('safe'); await flush(); assert.equal(f.model.getThread('safe').phase, 'local');
  for (const status of ['removed-remotely', 'generation-changed', 'remote-missing', 'conflict', 'remote-ahead-live']) { assert.equal(f.model.getThread(status).blocked, true); assert.ok(f.blockStore(status).getSnapshot()); }
  assert.equal(f.count('check-ownership'), 0);
});

test('all unsafe import/mapping/cwd/preset/schedule/generation/auth/conflict states conservatively block without ownership churn', async t => {
  const f = fixture(t);
  const patches: Partial<CloudLocalView>[] = [
    ...['planned', 'creating', 'appending', 'attachments', 'warming', 'failed'].map(importState => ({ importState } as Partial<CloudLocalView>)),
    { importState: 'degraded', degradedAcknowledged: false }, { needsFolder: true }, { mappingUnstable: true }, { admissionStopped: true }, { restartRequired: true },
    ...CLOUD_STATUSES.filter(status => !['synced', 'syncing', 'retrying', 'ownership-unverified', 'paused-other-device', 'lease-lost', 'degraded'].includes(status)).map(status => ({ status })),
  ];
  patches.forEach((patch, index) => { const id = `unsafe-${index}`; f.records.set(id, record(id, patch)); });
  // Exercise in batches below the private unresolved-provider cap.
  for (let offset = 0; offset < patches.length; offset += 20) {
    for (let index = offset; index < Math.min(offset + 20, patches.length); index++) f.model.watchSession(`unsafe-${index}`);
    await flush();
  }
  patches.forEach((_patch, index) => assert.equal(f.model.getThread(`unsafe-${index}`).blocked, true));
  assert.equal(f.count('check-ownership'), 0);
});

test('degraded import can become provisionally ready only after explicit acknowledgement and proof', async t => {
  const f = fixture(t); f.records.set('s', record('s', { status: 'degraded', importState: 'degraded', degradedAttachmentCount: 2, degradedAcknowledged: false }));
  f.model.watchSession('s'); await flush(); assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.count('check-ownership'), 0);
  f.records.set('s', record('s', { status: 'degraded', importState: 'degraded', degradedAttachmentCount: 2, degradedAcknowledged: true }));
  await f.model.refresh('s'); assert.equal(f.model.getThread('s').phase, 'ready'); assert.equal(f.count('check-ownership'), 1);
});

test('explicit off or detach never authorizes an initial partial import; off/detach and readonly repair remain reachable', async t => {
  const f = fixture(t);
  for (const importState of ['planned', 'creating', 'appending', 'attachments', 'warming', 'failed', 'degraded'] as const) {
    f.records.set(importState, { ...local(importState), importState, degradedAttachmentCount: importState === 'degraded' ? 2 : 0, degradedAcknowledged: false });
    f.model.watchSession(importState);
  }
  await flush();
  for (const id of f.records.keys()) {
    const thread = f.model.getThread(id);
    assert.equal(thread.phase, 'blocked'); assert.equal(thread.flags.admissionRequired, false); assert.equal(thread.flags.importComplete, false); assert.ok(f.blockStore(id).getSnapshot());
  }
  assert.equal(f.count('check-ownership'), 0);
  await f.model.request({ action: 'toggle', sessionId: 'failed', enabled: false }); await flush();
  await f.model.request({ action: 'detach', sessionId: 'failed' }); await flush();
  assert.equal(f.model.getThread('failed').blocked, true, 'saving local off/detach cannot finish an incomplete native import');
  f.setHandler(request => {
    if (request.action === 'repair' && request.sessionId === 'failed') {
      const before = f.records.get('failed')!;
      f.records.set('failed', { ...before, importState: 'complete' });
    }
    return f.defaultReply(request);
  });
  await f.model.request({ action: 'repair', sessionId: 'failed' }); await flush();
  const repaired = f.model.getThread('failed');
  assert.equal(repaired.phase, 'local'); assert.equal(repaired.flags.importComplete, true); assert.equal(repaired.status?.enabled, false); assert.equal(repaired.status?.detached, true); assert.equal(repaired.status?.admissionRequired, false);
  assert.equal(f.count('check-ownership'), 0, 'readonly completion while off never acquires cloud ownership');
  f.records.set('degraded', { ...f.records.get('degraded')!, degradedAcknowledged: true }); await f.model.refresh('degraded');
  assert.equal(f.model.getThread('degraded').phase, 'local'); assert.equal(f.model.getThread('degraded').flags.importComplete, true);
});

test('projection-only degraded Off then explicit acknowledgement permits local only; later On requires a new ownership proof', async t => {
  const f = fixture(t); f.records.set('s', record('s', { importState: 'degraded', status: 'projection-warm-partial' }));
  f.setHandler(request => {
    if (request.action === 'toggle' && !request.enabled) f.records.set('s', { ...local(), importState: 'degraded' });
    if (request.action === 'acknowledge-degraded') f.records.set('s', { ...f.records.get('s')!, degradedAcknowledged: true });
    if (request.action === 'toggle' && request.enabled) f.records.set('s', record('s', { importState: 'degraded', degradedAcknowledged: true }));
    return f.defaultReply(request);
  });
  f.model.watchSession('s'); await flush(); assert.equal(f.model.getThread('s').blocked, true);
  await f.model.request({ action: 'toggle', sessionId: 's', enabled: false }); await flush();
  assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.count('check-ownership'), 0);
  await f.model.request({ action: 'acknowledge-degraded', sessionId: 's' }); await flush();
  assert.equal(f.model.getThread('s').phase, 'local'); assert.equal(f.model.getThread('s').status?.enabled, false);
  assert.equal(f.model.getThread('s').status?.detached, true); assert.equal(f.count('check-ownership'), 0);
  await f.model.request({ action: 'toggle', sessionId: 's', enabled: true }); await flush();
  assert.equal(f.model.getThread('s').phase, 'ready'); assert.equal(f.count('check-ownership'), 1);
});

test('authPending, provider unavailable, and uncertain secret all block cloud even if a forged old proof was ready; explicit local remains local', async t => {
  const f = fixture(t); f.records.set('s', record()); f.records.set('local', local('local')); f.model.watchSession('s'); f.model.watchSession('local'); await flush();
  assert.equal(f.model.getThread('s').phase, 'ready');
  for (const patch of [{ authPending: true }, { connection: { configured: true, writable: false, available: false as const } }, { connection: { configured: true, writable: true, requiresUpdate: true as const } }]) {
    f.setSettings({ ...settings(), ...patch }); await f.model.refresh(); assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.model.getThread('local').phase, 'local');
  }
});

test('status polling is local-only every 15 seconds; unchanged state/activity counters do not renew ownership or leases', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t); f.records.set('s', record()); const release = f.model.watchSession('s'); await flush();
  assert.equal(f.count('check-ownership'), 1); const statusBefore = f.count('status');
  t.mock.timers.tick(CLOUD_STATUS_POLL_MS - 1); await flush(); assert.equal(f.count('status'), statusBefore);
  for (let iteration = 1; iteration <= 4; iteration++) {
    f.records.set('s', record('s', { lastSyncedAt: iteration, eventCount: iteration })); t.mock.timers.tick(CLOUD_STATUS_POLL_MS); await flush();
  }
  assert.equal(f.count('status'), statusBefore + 4); assert.equal(f.count('check-ownership'), 1); assert.equal(f.model.getThread('s').phase, 'ready');
  await f.model.refresh('s'); assert.equal(f.count('check-ownership'), 2, 'an explicit refresh is a new user safety inspection');
  release(); const stopped = f.calls.length; t.mock.timers.tick(CLOUD_STATUS_POLL_MS * 2); await flush(); assert.equal(f.calls.length, stopped);
});

test('fresh terminal status invalidates proof and an unknown network failure never unblocks known cloud/terminal state', async t => {
  const f = fixture(t); f.records.set('s', record()); f.model.watchSession('s'); await flush(); assert.equal(f.model.getThread('s').phase, 'ready');
  f.records.set('s', record('s', { enabled: false, status: 'removed-remotely' })); await f.model.refresh('s'); assert.equal(f.model.getThread('s').blocked, true);
  let touched = 0; const provider = Object.defineProperty({}, 'message', { get() { touched++; throw new Error('secret'); } });
  f.setHandler(() => { throw provider; }); await f.model.refresh('s');
  assert.equal(touched, 0); assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.model.getThread('s').status?.status, 'removed-remotely'); assert.equal(f.model.getThread('s').error, 'TRANSPORT');
});

test('credentials are request JSON body only; global actions never inject Agent or sid and native state is secret-free', async t => {
  const f = fixture(t), secret = ['AccountKey', 'synthetic-secret-never-cache'].join('=');
  const reply = await f.model.request({ action: 'set-auth', auth: 'connection-string', connectionString: secret }); assert.equal(reply.kind, 'settings');
  const call = f.calls[0]!; assert.equal(call.route, '/api'); assert.equal(call.endpoint, 'azure-sync/action');
  assert.deepEqual(call.payload, { v: 1, request: { action: 'set-auth', auth: 'connection-string', connectionString: secret } });
  assert.deepEqual(Object.keys(call.payload), ['v', 'request']); assert.equal(JSON.stringify(f.model.store.getSnapshot()).includes(secret), false);
  await f.model.request({ action: 'status' }); await f.model.request({ action: 'mappings' }); await f.model.request({ action: 'pull' }); await f.model.request({ action: 'test-auth' });
  assert.deepEqual(f.calls.slice(1).map(call => call.payload.request), [{ action: 'status' }, { action: 'mappings' }, { action: 'pull' }, { action: 'test-auth' }]);
  assert.ok(f.calls.slice(1, 3).every(call => call.endpoint === 'azure-sync/status'));
  await rejectsCode(f.model.request({ action: 'sync' }), 'INVALID_REQUEST');
  let touched = 0; const bad = Object.defineProperty({ action: 'set-auth', auth: 'connection-string' }, 'connectionString', { enumerable: true, get() { touched++; return secret; } });
  await rejectsCode(f.model.request(bad as CloudRequest), 'INVALID_REQUEST'); assert.equal(touched, 0);
});

test('connection generation changes block immediately, abort stale work, suppress late old updates and refresh the new generation', async t => {
  const f = fixture(t); f.records.set('s', record()); f.model.watchSession('s'); await flush(); assert.equal(f.model.getThread('s').phase, 'ready');
  const old = deferred(); f.setHandler(request => request.action === 'status' ? old.promise : f.defaultReply(request)); const pending = f.model.refresh('s'); await flush();
  const oldCall = f.calls.at(-1)!; f.generation.set(undefined); assert.equal(oldCall.signal?.aborted, true); assert.equal(f.model.getThread('s').blocked, true);
  f.records.set('s', record('s', { status: 'remote-ahead-live', restartRequired: true })); f.setHandler(request => f.defaultReply(request)); f.generation.set({ id: 2 }); await flush();
  old.resolve({ kind: 'status', revision: 1, projectionRevision: 'b'.repeat(64), settings: settings(), items: [local()] }); await pending; await flush();
  assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.model.getThread('s').status?.status, 'remote-ahead-live'); assert.equal(f.model.getThread('s').flags.restartRequired, true);
  assert.equal(f.generation.subscriptions, 1); f.model.dispose(); assert.equal(f.generation.subscriptions, 0);
});

test('last watcher/session switch/unload abort old scope; late responses cannot authorize replacement scope or leave blocks', async t => {
  const f = fixture(t), old = deferred(); f.setHandler(request => request.action === 'status' && request.sessionId === 's' ? old.promise : f.defaultReply(request));
  const release = f.model.watchSession('s'); const oldCall = f.calls[0]!; release(); assert.equal(oldCall.signal?.aborted, true); assert.equal(f.blockStore('s').getSnapshot(), undefined);
  const releaseOther = f.model.watchSession('other'); await flush(); assert.equal(f.model.getThread('other').phase, 'local');
  f.records.set('s', record('s', { status: 'conflict' })); f.setHandler(request => f.defaultReply(request)); const fresh = f.model.watchSession('s'); await flush();
  old.resolve({ kind: 'status', revision: 0, projectionRevision: 'a'.repeat(64), settings: settings(), items: [local()] }); await flush(); assert.equal(f.model.getThread('s').blocked, true);
  f.model.dispose(); fresh(); releaseOther(); assert.equal(f.blockStore('s').getSnapshot(), undefined); assert.equal(f.blockStore('s').subscriptions, 0); assert.equal(f.generation.subscriptions, 0);
  assert.deepEqual(f.model.store.getSnapshot(), { threads: {}, pending: [] }); await rejectsCode(f.model.request({ action: 'test-auth' }), 'DISPOSED');
});

test('priority detach/off abort older session action even if provider ignores cancellation, remain callable while busy, and newer safety state wins', async t => {
  for (const safety of [{ action: 'detach', sessionId: 's' }, { action: 'toggle', sessionId: 's', enabled: false }] as const) {
    const f = fixture(t), old = deferred(); f.records.set('s', record()); f.model.watchSession('s'); await flush();
    f.setHandler(request => {
      if (request.action === 'sync') return old.promise;
      if (request.action === 'detach' || (request.action === 'toggle' && !request.enabled)) f.records.set('s', local());
      return f.defaultReply(request);
    });
    const pending = f.model.request({ action: 'sync', sessionId: 's' }); const cancelled = rejectsCode(pending, 'CANCELLED'); await flush(); assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.model.getThread('s').pending, true);
    await rejectsCode(f.model.request({ action: 'repair', sessionId: 's' }), 'BUSY');
    await f.model.request(safety); await cancelled; await flush(); assert.equal(f.model.getThread('s').phase, 'local');
    const oldCall = f.calls.find(call => call.payload.request.action === 'sync')!; assert.equal(oldCall.signal?.aborted, true);
    old.resolve({ kind: 'action', action: 'sync', sessionId: 's', state: 'synced', detail: { status: 'synced', eventCount: 1, uploadedBatches: 0 } }); await flush();
    assert.equal(f.model.getThread('s').phase, 'local'); assert.equal(f.model.getThread('s').pending, false); f.model.dispose();
  }
});

test('priority safety cancellation works for an unmounted remote/import target as well', async t => {
  const f = fixture(t), old = deferred();
  f.setHandler(request => request.action === 'pull' ? old.promise : f.defaultReply(request));
  const pending = f.model.request({ action: 'pull', sessionId: 'remote' }); const cancelled = rejectsCode(pending, 'CANCELLED');
  await f.model.request({ action: 'detach', sessionId: 'remote' }); await cancelled; assert.equal(f.calls[0]!.signal?.aborted, true);
  old.resolve({ kind: 'action', action: 'pull', sessionId: 'remote', state: 'synced' }); await flush(); assert.equal(f.refreshes, 0);
});

test('Git facts are readonly advisory DTOs and never invalidate or create ownership/proof or automatic filesystem polling', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t); f.records.set('s', record()); f.model.watchSession('s'); await flush();
  const checks = f.count('check-ownership'); assert.equal(f.model.getThread('s').phase, 'ready');
  assert.deepEqual(await f.model.request({ action: 'git-info', sessionId: 's' }), { kind: 'git', sessionId: 's', local: null });
  assert.equal(f.model.getThread('s').phase, 'ready'); assert.equal(f.count('check-ownership'), checks);
  t.mock.timers.tick(CLOUD_STATUS_POLL_MS * 3); await flush(); assert.equal(f.count('git-info'), 1); assert.equal(f.count('check-ownership'), checks);
  const bad = { kind: 'git', sessionId: 's', local: { v: 1, root: '/local', detached: false, unborn: false, worktree: false, dirty: 'clean', remote: 'https://example.invalid/path?sig=private' } };
  assert.throws(() => decodeCloudReply({ action: 'git-info', sessionId: 's' }, wire(bad)), error => cloudClientErrorCode(error) === 'MALFORMED_REPLY');
  assert.throws(() => decodeCloudReply({ action: 'git-info', sessionId: 's' }, wire({ kind: 'git', sessionId: 'other', local: null })));
});

test('explicit ownership request checks once and the resulting local status refresh does not automatically check again', async t => {
  const f = fixture(t); f.records.set('s', record()); f.model.watchSession('s'); await flush(); const checks = f.count('check-ownership');
  await f.model.request({ action: 'check-ownership', sessionId: 's' }); await flush(); assert.equal(f.count('check-ownership'), checks + 1); assert.equal(f.model.getThread('s').phase, 'ready');
});

test('private unresolved-provider cap survives cancellation and late completion releases capacity', async t => {
  const f = fixture(t), ignored: ReturnType<typeof deferred>[] = [];
  f.setHandler(() => { const value = deferred(); ignored.push(value); return value.promise; });
  for (let index = 0; index < CLOUD_CLIENT_MAX_FLIGHTS; index++) {
    const controller = new AbortController(), pending = f.model.request({ action: 'test-auth' }, controller.signal); controller.abort(); await rejectsCode(pending, 'CANCELLED');
  }
  await rejectsCode(f.model.request({ action: 'test-auth' }), 'CAPACITY'); assert.equal(f.calls.length, CLOUD_CLIENT_MAX_FLIGHTS);
  for (const value of ignored) value.resolve({ kind: 'auth-test', configured: true }); await flush();
  f.setHandler(request => f.defaultReply(request)); assert.equal((await f.model.request({ action: 'test-auth' })).kind, 'auth-test');
});

test('aborted caller settles promptly without provider error inspection or stale snapshot changes', async t => {
  const f = fixture(t), hung = deferred(), abort = new AbortController(); f.setHandler(() => hung.promise);
  const pending = f.model.request({ action: 'test-auth' }, abort.signal); abort.abort(); await rejectsCode(pending, 'CANCELLED');
  const snapshot = JSON.stringify(f.model.store.getSnapshot()); let touched = 0;
  hung.reject(Object.defineProperty({}, 'message', { get() { touched++; throw 'secret'; } })); await flush(); assert.equal(touched, 0); assert.equal(JSON.stringify(f.model.store.getSnapshot()), snapshot);
  const already = new AbortController(); already.abort(); const calls = f.calls.length; await rejectsCode(f.model.request({ action: 'test-auth' }, already.signal), 'CANCELLED'); assert.equal(f.calls.length, calls);
});

test('native session refresh is coalesced for changed projection and imports, never Agent acquisition', async t => {
  const f = fixture(t); f.records.set('s', local()); f.records.set('t', local('t')); f.model.watchSession('s'); f.model.watchSession('t'); await flush(); assert.equal(f.refreshes, 0);
  f.setProjection('b'.repeat(64)); await f.model.refresh(); await flush(); assert.equal(f.refreshes, 1);
  await f.model.refresh(); await flush(); assert.equal(f.refreshes, 1);
  await f.model.request({ action: 'pull', sessionId: 'new-import' }); await flush(); assert.equal(f.refreshes, 2);
  assert.ok(!('retain' in f.runtime.sessions)); assert.ok(!('resolveAgent' in f.runtime.sessions));
});

test('model publisher cooperates with foreign worktrees blocks and multiple model instances during hot unload', async t => {
  const f = fixture(t); f.records.set('s', record('s', { status: 'conflict' })); const foreign = { reason: 'worktrees' };
  f.runtime.conversation.blocks.set('s', foreign); const a = f.model.watchSession('s'); await flush(); assert.equal(f.blockStore('s').getSnapshot(), foreign);
  const other = createCloudClient(f.runtime); t.after(() => other.dispose()); const b = other.watchSession('s'); await flush();
  f.runtime.conversation.blocks.set('s', undefined); const owned = f.blockStore('s').getSnapshot(); assert.ok(owned); assert.notEqual(owned, foreign);
  a(); f.model.dispose(); assert.equal(f.blockStore('s').getSnapshot(), owned);
  f.runtime.conversation.blocks.set('s', foreign); b(); other.dispose(); assert.equal(f.blockStore('s').getSnapshot(), foreign);
  assert.equal(f.blockStore('s').subscriptions, 0); f.runtime.conversation.blocks.set('s', undefined); assert.equal(f.blockStore('s').getSnapshot(), undefined);
});

test('mount during a pending import inherits its action and stays blocked until the current projection and ownership are checked', async t => {
  const f = fixture(t), imported = deferred();
  f.setHandler(request => request.action === 'pull' && request.sessionId === 'remote' ? imported.promise : f.defaultReply(request));
  const action = f.model.request({ action: 'pull', sessionId: 'remote' });
  f.model.watchSession('remote'); await flush();
  assert.equal(f.model.getThread('remote').blocked, true); assert.equal(f.count('status'), 0, 'intermediate untracked status is not permission while importing');
  f.records.set('remote', record('remote', { importState: 'complete' }));
  imported.resolve(f.defaultReply({ action: 'pull', sessionId: 'remote' })); await action; await flush();
  assert.equal(f.model.getThread('remote').phase, 'ready'); assert.equal(f.count('check-ownership'), 1); assert.equal(f.model.getThread('remote').pending, false);
});

test('mount during global auth mutation also waits for its final settings, while remote listing/auth test do not invalidate existing proof', async t => {
  const f = fixture(t), saving = deferred();
  f.setHandler(request => request.action === 'set-auth' ? saving.promise : f.defaultReply(request));
  const action = f.model.request({ action: 'set-auth', auth: 'azure-cli' }); f.model.watchSession('s'); await flush();
  assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.count('status'), 0);
  f.records.set('s', record()); saving.resolve(f.defaultReply({ action: 'set-auth', auth: 'azure-cli' })); await action; await flush();
  assert.equal(f.model.getThread('s').phase, 'ready'); const checks = f.count('check-ownership');
  await f.model.request({ action: 'pull' }); await f.model.request({ action: 'test-auth' }); await flush();
  assert.equal(f.model.getThread('s').phase, 'ready'); assert.equal(f.count('check-ownership'), checks);
});

test('new scoped status request aborts older local lookup and late untracked response cannot override newer terminal stop', async t => {
  const f = fixture(t), old = deferred(); f.setHandler(request => request.action === 'status' ? old.promise : f.defaultReply(request));
  f.model.watchSession('s'); const oldCall = f.calls[0]!;
  f.records.set('s', record('s', { enabled: false, status: 'removed-remotely' })); f.setHandler(request => f.defaultReply(request));
  await f.model.request({ action: 'status', sessionId: 's' }); await flush(); assert.equal(oldCall.signal?.aborted, true);
  old.resolve({ kind: 'status', revision: 0, projectionRevision: 'a'.repeat(64), settings: settings(), items: [], untracked: { sessionId: 's', enabled: false, admissionRequired: false } }); await flush();
  assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.model.getThread('s').status?.status, 'removed-remotely');
});

test('ownership result from prior auth settings cannot authorize the current target after another scope observes changed settings', async t => {
  const f = fixture(t), oldProof = deferred(); f.records.set('s', record()); f.records.set('other', local('other'));
  f.setHandler(request => request.action === 'check-ownership' && request.sessionId === 's' ? oldProof.promise : f.defaultReply(request));
  f.model.watchSession('s'); await flush(); assert.equal(f.count('check-ownership'), 1);
  f.setSettings({ ...settings(), accountName: 'changedaccount' }); f.model.watchSession('other'); await flush();
  oldProof.resolve(f.defaultReply({ action: 'check-ownership', sessionId: 's' })); await flush(); assert.equal(f.model.getThread('s').blocked, true);
  f.setHandler(request => f.defaultReply(request)); await f.model.refresh('s'); assert.equal(f.model.getThread('s').phase, 'ready'); assert.equal(f.count('check-ownership'), 2);
});

test('malformed scoped status fails closed instead of allowing missing admission flags or false untracked matches', async t => {
  const f = fixture(t);
  f.setHandler(() => ({ kind: 'status', revision: 0, projectionRevision: 'a'.repeat(64), settings: settings(), items: [], untracked: { sessionId: 'other', enabled: false, admissionRequired: false } }));
  f.model.watchSession('s'); await flush(); assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.model.getThread('s').error, 'MALFORMED_REPLY');
  f.setHandler(() => ({ kind: 'status', revision: 0, projectionRevision: 'a'.repeat(64), settings: settings(), items: [{ sessionId: 's', enabled: false }] }));
  await f.model.refresh('s'); assert.equal(f.model.getThread('s').blocked, true); assert.equal(f.model.getThread('s').error, 'MALFORMED_REPLY');
});
