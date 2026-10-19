import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalStore } from '../src/local/store.js';
import { SyncService } from '../src/sync/service.js';
import type { Uploader } from '../src/sync/uploader.js';
import type { CloudRepository, StoredManifest } from '../src/sync/cloud-repository.js';
import type { RemoteSession, RemoteSessionReader } from '../src/sync/remote-session.js';
import type { ImportService } from '../src/sync/import-service.js';
import type { LocalSessionRecord } from '../src/schema.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { cloudSession, event, localSession, sessionHeader } from './helpers.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(localCount = 1, remoteCount = 1, live = false) {
  const id = 'session-service';
  const header = sessionHeader({ id });
  const events = [event(0), event(1), event(2)];
  const binding = headerHash(header, 0);
  const genesis = genesisHash(id, 1, binding);
  const chain = chainEvents(genesis, events.slice(0, remoteCount));
  let manifest: StoredManifest | undefined = { entity: cloudSession({ sessionId: id, headerHash: binding, ...chain, eventCount: remoteCount, headSeq: remoteCount - 1 }), etag: 'remote-etag' };
  let record = localSession({ sessionId: id, status: 'retrying' });
  const local = {
    getSession: () => record,
    putSession: async (next: LocalSessionRecord) => { record = next; },
    transactSession: async (_id: string, fn: (value: LocalSessionRecord | undefined) => LocalSessionRecord | undefined) => { const next = fn(record); if (next !== undefined) record = next; return next; },
    listSessions: () => new Map([[id, record]]).entries(),
  } as unknown as LocalStore;
  let snapshot = { header: header as never, inheritedEventCount: 0, events: events.slice(0, localCount) as never };
  let pauses = 0;
  let uploads = 0;
  let proofs = 0;
  let catches = 0;
  let reads = 0;
  const uploader = {
    snapshotForReconciliation: async () => snapshot,
    pause: async () => { pauses++; },
    sync: async () => { uploads++; return { status: 'synced', eventCount: localCount, uploadedBatches: 1 }; },
    disable: async () => { record = { ...record, enabled: false, state: 'disabled' }; },
    ensureOwnership: async () => { proofs++; return { owned: true }; },
    close: async () => undefined,
    hasHeld: () => false,
  } as unknown as Uploader;
  const reader = { read: async () => { reads++; return { manifest, header, inheritedEventCount: 0, events: events.slice(0, remoteCount) } as unknown as RemoteSession; } };
  const repository = { getManifest: async () => manifest };
  const imports = { catchUp: async (_id: string, _remote: RemoteSession, options: { signal: AbortSignal; isLive: () => boolean }) => { options.signal.throwIfAborted(); assert.equal(options.isLive(), false); catches++; record = { ...record, status: 'synced', lastSyncedEventCount: remoteCount }; } } as unknown as ImportService;
  const service = new SyncService({ uploader, local, repository: repository as unknown as CloudRepository, reader: reader as unknown as RemoteSessionReader, imports, agents: { get: () => live ? {} as never : undefined } });
  return { id, service, reader, repository, get: () => record, set: (next: Partial<LocalSessionRecord>) => { record = { ...record, ...next }; }, setManifest: (next: StoredManifest | undefined) => { manifest = next; }, manifest: () => manifest!, snapshot: () => snapshot, setSnapshot: (value: typeof snapshot) => { snapshot = value; }, counts: () => ({ pauses, uploads, proofs, catches, reads }) };
}

test('runtime dispatches verified same/local-ahead/cold-ahead/live-ahead without claiming a live writer', async () => {
  const same = fixture();
  assert.equal((await same.service.reconcile(same.id))?.kind, 'same');
  assert.equal(same.get().status, 'synced');
  const local = fixture(2, 1);
  await local.service.sync(local.id);
  assert.equal(local.counts().uploads, 1);
  const cold = fixture(1, 2);
  await cold.service.sync(cold.id);
  assert.equal(cold.counts().catches, 1);
  assert.equal(cold.counts().uploads, 0);
  const live = fixture(1, 2, true);
  assert.equal((await live.service.reconcile(live.id))?.kind, 'remote-ahead');
  assert.equal(live.get().status, 'remote-ahead-live');
  assert.equal(live.counts().catches, 0);
  assert.equal((await live.service.ensureOwnership(live.id)).reason, 'remote-ahead-live');
  assert.equal(live.counts().proofs, 0);
});

test('poll refresh publishes a verified local suffix, while same-count degraded state stays degraded', async () => {
  const ahead = fixture(2, 1);
  await ahead.service.refreshAll();
  assert.equal(ahead.counts().uploads, 1);
  const degraded = fixture();
  degraded.set({ status: 'attachment-unsupported', degradedAttachments: ['missing-attachment'] });
  await degraded.service.reconcile(degraded.id);
  assert.equal(degraded.get().status, 'attachment-unsupported');
  assert.equal(degraded.get().lastSyncedAt, undefined);
});

test('three overlapping refreshes serialize their full reconciliation workflows', async () => {
  const f = fixture();
  let active = 0;
  let max = 0;
  f.repository.getManifest = async () => {
    active++;
    max = Math.max(max, active);
    await Promise.resolve(); await Promise.resolve();
    active--;
    return f.manifest();
  };
  const results = await Promise.all([f.service.reconcile(f.id), f.service.reconcile(f.id), f.service.reconcile(f.id)]);
  assert.deepEqual(results.map(result => result?.kind), ['same', 'same', 'same']);
  assert.equal(max, 1);
});

test('runtime persists divergence and never lets ownership or background sync clear it', async () => {
  const f = fixture();
  f.setSnapshot({ ...f.snapshot(), events: [event(0, 'user/message', { text: 'different' })] as never });
  assert.equal((await f.service.reconcile(f.id))?.kind, 'diverged');
  assert.equal(f.get().status, 'conflict');
  assert.equal(f.get().enabled, true);
  assert.equal((await f.service.ensureOwnership(f.id)).reason, 'conflict');
  assert.equal(f.counts().proofs, 0);
  await assert.rejects(f.service.sync(f.id));
  assert.equal(f.counts().uploads, 0);
});

test('offline tombstone/generation/shared-disable stop without reading or recreating history', async () => {
  for (const [state, generation, expected] of [['deleted', 1, 'removed-remotely'], ['active', 2, 'generation-changed'], ['disabled', 1, 'detached']] as const) {
    const f = fixture();
    f.setManifest({ ...f.manifest(), entity: { ...f.manifest().entity, state, generation } });
    await f.service.reconcile(f.id);
    assert.equal(f.get().status, expected);
    assert.equal(f.get().enabled, false);
    assert.equal(f.counts().reads, 0);
    assert.equal(f.counts().uploads, 0);
  }
  const missing = fixture();
  missing.set({ lastSyncedAt: 1 });
  missing.setManifest(undefined);
  await missing.service.sync(missing.id);
  assert.equal(missing.get().status, 'remote-missing');
  assert.equal(missing.get().enabled, false);
});

test('close aborts a never-settling refresh and late success cannot update local state', async () => {
  const f = fixture();
  const pending = deferred<StoredManifest | undefined>();
  f.repository.getManifest = () => pending.promise;
  const refresh = f.service.reconcile(f.id);
  const rejected = assert.rejects(refresh, { name: 'AbortError' });
  await f.service.close(25);
  await rejected;
  pending.resolve(f.manifest());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.get().status, 'retrying');
  assert.equal(f.counts().reads, 0);
});

test('disable invalidates an in-flight reader before catch-up or synced-state publication', async () => {
  const f = fixture(1, 2);
  const pending = deferred<RemoteSession>();
  const entered = deferred<void>();
  f.reader.read = async () => { entered.resolve(); return pending.promise; };
  const refresh = f.service.reconcile(f.id);
  const rejected = assert.rejects(refresh, { name: 'AbortError' });
  await entered.promise;
  await f.service.disable(f.id);
  await rejected;
  pending.resolve({ manifest: f.manifest(), header: sessionHeader({ id: f.id }), inheritedEventCount: 0, events: [event(0), event(1)] } as unknown as RemoteSession);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.get().enabled, false);
  assert.equal(f.counts().catches, 0);
  assert.notEqual(f.get().status, 'synced');
});
