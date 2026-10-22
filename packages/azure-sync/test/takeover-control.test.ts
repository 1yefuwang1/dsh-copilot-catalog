import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TableClient } from '@azure/data-tables';
import { Config } from '../src/config.js';
import { AzureSyncError } from '../src/azure/errors.js';
import type { BlobStore } from '../src/azure/blob.js';
import type { LeaseHandle, LeaseManager } from '../src/azure/lease.js';
import { TableStore } from '../src/azure/table.js';
import type { LocalStore } from '../src/local/store.js';
import { encodeCloudRecord, type CloudSessionEntity, type LocalSessionRecord } from '../src/schema.js';
import { planBatch } from '../src/sync/batcher.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { CloudRepository, candidateBlobName, leaseBlobName } from '../src/sync/cloud-repository.js';
import type { CwdBinding } from '../src/sync/effective-cwd.js';
import { SessionLeaseManager } from '../src/sync/lease-manager.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { SyncService } from '../src/sync/service.js';
import type { SessionSource, SourceSnapshot } from '../src/sync/session-source.js';
import { Uploader } from '../src/sync/uploader.js';
import { batchRow, cloudSession, event, localSession, pathMapping, sessionHeader } from './helpers.js';

const id = 'takeover-session';
const owner = 'device-current';
const now = 10_000;
const clone = <T>(value: T): T => structuredClone(value);
const code = (expected: string) => (error: unknown) => error instanceof AzureSyncError && error.code === expected;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function snapshot(events: unknown[] = [event(0), event(1)], header = sessionHeader({ id })): SourceSnapshot {
  return { header: header as never, inheritedEventCount: 0, events: events as never };
}

/** Fake only SDK/storage boundaries: all takeover, fencing and reconciliation classes are real. */
function fixture(options: { remote?: SourceSnapshot; local?: SourceSnapshot; binding?: CwdBinding; live?: boolean } = {}) {
  const remote = options.remote ?? snapshot();
  let current = options.local ?? clone(remote);
  let record = localSession({ sessionId: id, writerEpoch: 7, status: 'ownership-unverified' });
  const writes: LocalSessionRecord[] = [];
  const trace: string[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const blobs = new Map<string, Buffer>();
  let candidateWrites = 0;
  let batchTransactions = 0;
  const persistenceHooks: { afterWrite?: (next: LocalSessionRecord) => Promise<void> } = {};
  let revision = 0;
  const store = (entity: CloudSessionEntity) => {
    rows.set(entity.rowKey, { ...encodeCloudRecord(entity), etag: `etag-${++revision}` });
  };
  const bindingHash = headerHash(remote.header, remote.inheritedEventCount);
  const genesis = genesisHash(id, 1, bindingHash);
  const chain = remote.events.length === 0 ? { chainHash: genesis, headHash: genesis } : chainEvents(genesis, remote.events);
  const plan = planBatch(remote.events, 0, { maxEvents: 1_000, maxBytes: 1_048_576 }, genesis);
  const name = plan === undefined ? undefined : candidateBlobName(id, 1, 0, 7, plan.payloadHash);
  if (plan !== undefined && name !== undefined) {
    const row = batchRow(id, 1, 0, {
      endSeq: remote.events.length - 1, eventCount: remote.events.length, blobName: name,
      payloadHash: plan.payloadHash, prevChainHash: genesis, chainHash: plan.chain.chainHash,
      headHash: plan.chain.headHash, createdEpoch: 7,
    });
    rows.set(row.rowKey, { ...encodeCloudRecord(row), etag: 'batch-etag' });
    blobs.set(name, plan.gzip);
  }
  store(cloudSession({ sessionId: id, writerEpoch: 7, leaseOwner: 'device-previous', leaseUntil: now + 60_000,
    headerJson: JSON.stringify(remote.header), headerHash: bindingHash, inheritedEventCount: remote.inheritedEventCount,
    chainHash: chain.chainHash, headHash: chain.headHash, eventCount: remote.events.length, headSeq: remote.events.length - 1,
    batchCount: plan === undefined ? 0 : 1, lastBatchRowKey: plan === undefined ? undefined : batchRow(id, 1, 0).rowKey,
    lastBatchGeneration: plan === undefined ? undefined : 1, lastBatchBlobName: name,
  }));
  const client = {
    async getEntity(_partition: string, key: string) {
      trace.push(key.startsWith('session:') ? 'manifest-read' : 'batch-read');
      const row = rows.get(key);
      if (row === undefined) throw { statusCode: 404 };
      return clone(row);
    },
    async updateEntity(entity: Record<string, unknown>, _mode: string, input: { etag: string }) {
      const key = String(entity['rowKey']);
      if (rows.get(key)?.['etag'] !== input.etag) throw { statusCode: 412 };
      trace.push('manifest-write');
      rows.set(key, { ...clone(entity), etag: `etag-${++revision}` });
      // Read logical state through the public codec below, not through SDK Int64 values.
    },
    async *listEntities() {
      for (const [key, value] of rows) if (key.startsWith('batch:')) yield clone(value);
    },
    async submitTransaction() {
      batchTransactions++; trace.push('batch-transaction');
      throw new Error('This control fixture must never publish a batch.');
    },
  } as unknown as TableClient;
  const repository = new CloudRepository({
    read: async (key: string) => {
      trace.push('blob-read');
      const value = blobs.get(key); assert.ok(value); return Buffer.from(value);
    },
    putIfAbsent: async () => {
      candidateWrites++; trace.push('candidate-write');
      throw new Error('This control fixture must never publish a candidate.');
    },
  } as unknown as BlobStore, new TableStore(client));
  let active: LeaseHandle | undefined = { leaseId: 'previous-lease', client: {} as never };
  let breaks = 0;
  let acquires = 0;
  let releases = 0;
  let renews = 0;
  const hooks: {
    beforeBreak?: () => void | Promise<void>;
    acquireResponse?: (handle: LeaseHandle) => Promise<LeaseHandle>;
  } = {};
  const raw = {
    async break(name: string) {
      assert.equal(name, leaseBlobName(id));
      trace.push('break'); breaks++;
      await hooks.beforeBreak?.(); active = undefined;
    },
    async acquire(name: string) {
      assert.equal(name, leaseBlobName(id));
      trace.push('acquire'); acquires++;
      if (active !== undefined) throw new AzureSyncError('CONFLICT', 'Server lease remains held.');
      const handle = { leaseId: `lease-${acquires}`, client: {} as never };
      active = handle;
      return hooks.acquireResponse === undefined ? handle : hooks.acquireResponse(handle);
    },
    async release(handle: LeaseHandle) {
      trace.push('release'); releases++;
      if (active?.leaseId === handle.leaseId) active = undefined;
    },
    async renew(handle: LeaseHandle) {
      trace.push('renew'); renews++;
      if (active?.leaseId !== handle.leaseId) throw new AzureSyncError('LEASE_LOST', 'Server lease no longer held.');
    },
  };
  const leases = new SessionLeaseManager({ repository, leases: raw as unknown as LeaseManager, deviceId: owner, now: () => now });
  let permissionLane: Promise<unknown> = Promise.resolve();
  const local = {
    getSession: () => clone(record),
    putSession: async (next: LocalSessionRecord) => {
      record = clone(next); writes.push(clone(next)); await persistenceHooks.afterWrite?.(clone(next));
    },
    transactSession: (_id: string, fn: (value: LocalSessionRecord | undefined) => LocalSessionRecord | undefined) => {
      const task = permissionLane.then(() => { const next = fn(clone(record)); if (next !== undefined) { assert.equal(next.sessionId, _id); record = clone(next); writes.push(clone(next)); } return next; });
      permissionLane = task.then(() => undefined, () => undefined);
      return task.then(async next => { if (next !== undefined) await persistenceHooks.afterWrite?.(clone(next)); return next; });
    },
    listSessions: () => new Map([[id, clone(record)]]).entries(),
  } as unknown as LocalStore;
  const source: SessionSource = {
    flush: async () => { trace.push('flush'); },
    read: async () => { trace.push('local-read'); return clone(current); },
    stat: async () => ({ header: current.header }),
  };
  const uploader = new Uploader({ config: Config({}), source, repository, leases, local,
    deviceId: owner, platform: 'linux', now: () => now,
    ...(options.binding === undefined ? {} : { cwdBinding: async () => { trace.push('canonicalize'); return options.binding; } }),
  });
  const reader = new RemoteSessionReader(repository, { maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576 });
  record = { ...record, publicationScope: reader.scopeId }; // Existing explicit consent for this fixture account.
  const service = new SyncService({ uploader, local, source, reader, repository, now: () => now,
    agents: { get: () => options.live ? {} as never : undefined },
  });
  return {
    uploader, service, repository, reader, leases, source, raw, hooks, trace, writes, persistenceHooks,
    publications: () => ({ candidateWrites, batchTransactions }),
    cloudState: () => clone({ rows: [...rows], blobs: [...blobs] }),
    record: () => clone(record), setRecord: (patch: Partial<LocalSessionRecord>) => { record = { ...record, ...patch }; },
    setLocal: (next: SourceSnapshot) => { current = clone(next); },
    async patchRemote(patch: Partial<CloudSessionEntity>) {
      const before = await repository.getManifest(id); assert.ok(before); store({ ...before.entity, ...patch });
    },
    counts: () => ({ breaks, acquires, releases, renews, active: active?.leaseId }),
    async dispose() { await uploader.pause(id); },
  };
}

test('explicit current copy proves canonical header and event prefix before any break, acquires a new epoch and freshly proves it', async (t) => {
  const binding: CwdBinding = { mapping: pathMapping(), fs: { realpath: async (path) => path, stat: async () => ({ isDirectory: () => true }) } };
  const remote = snapshot([event(0, 'working-directory/change', { cwd: '/remote/project/nested' }), event(1)]);
  const local = snapshot([event(0, 'working-directory/change', { cwd: '/local/project/nested' }), event(1)], sessionHeader({ id, cwd: '/local/project' }));
  const f = fixture({ remote, local, binding }); t.after(() => f.dispose());
  f.hooks.beforeBreak = () => {
    assert.deepEqual(f.trace.slice(0, 5), ['flush', 'local-read', 'canonicalize', 'manifest-read', 'break']);
    assert.equal(f.counts().acquires, 0);
  };
  assert.deepEqual(await f.uploader.takeover(id), { owned: true });
  assert.equal(f.counts().breaks, 1);
  assert.equal(f.counts().acquires, 1);
  assert.equal(f.uploader.hasHeld(id), true);
  assert.equal(f.record().writerEpoch, 8);
  assert.equal((await f.leases.proof(id, 8)).entity.leaseOwner, owner);
  await assert.rejects(f.leases.proof(id, 7), code('LEASE_LOST'));
  const before = f.trace.length;
  assert.deepEqual(await f.uploader.ensureOwnership(id), { owned: true });
  assert.ok(f.trace.slice(before).includes('manifest-read'), 'the next proof must read server state again');
  assert.equal(f.counts().renews, 1);
  assert.equal(f.counts().breaks, 1);
});

const refusals: Array<{ name: string; prepare: (f: ReturnType<typeof fixture>) => void | Promise<void>; expected: string }> = [
  { name: 'same-count divergent event', prepare: f => f.setLocal(snapshot([event(0), event(1, 'user/message', { text: 'divergent' })])), expected: 'CONFLICT' },
  { name: 'local-short prefix', prepare: f => f.setLocal(snapshot([event(0)])), expected: 'CONFLICT' },
  { name: 'different immutable header', prepare: f => f.setLocal(snapshot([event(0), event(1)], sessionHeader({ id, createdAt: 2 }))), expected: 'CONFLICT' },
  { name: 'deleted remote', prepare: f => f.patchRemote({ state: 'deleted', enabled: false, leaseOwner: undefined, leaseUntil: undefined }), expected: 'REMOVED_REMOTELY' },
  { name: 'disabled remote', prepare: f => f.patchRemote({ state: 'disabled', enabled: false }), expected: 'DISABLED' },
  { name: 'active but disabled remote', prepare: f => f.patchRemote({ enabled: false }), expected: 'DISABLED' },
  { name: 'changed generation', prepare: f => f.patchRemote({ generation: 2, rootGeneration: 2 }), expected: 'GENERATION_CHANGED' },
  { name: 'local disabled', prepare: f => f.setRecord({ enabled: false }), expected: 'DISABLED' },
  { name: 'local detached', prepare: f => f.setRecord({ detached: true }), expected: 'DISABLED' },
  { name: 'admissionStopped', prepare: f => f.setRecord({ admissionStopped: true }), expected: 'DISABLED' },
];
for (const item of refusals) {
  test(`direct Uploader takeover refuses ${item.name} before any lease break or acquisition`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); await item.prepare(f);
    const before = await f.repository.getManifest(id);
    await assert.rejects(f.uploader.takeover(id), code(item.expected));
    assert.equal(f.counts().breaks, 0);
    assert.equal(f.counts().acquires, 0);
    assert.equal(f.uploader.hasHeld(id), false);
    assert.deepEqual(await f.repository.getManifest(id), before);
    assert.equal(f.writes.length, 0);
  });
}

for (const status of ['conflict', 'remote-ahead-live'] as const) {
  test(`direct Uploader takeover preserves the local ${status} stop even with matching durable bytes`, async (t) => {
    const f = fixture(); t.after(() => f.dispose()); f.setRecord({ status });
    await assert.rejects(f.uploader.takeover(id), code('CONFLICT'));
    assert.equal(f.counts().breaks, 0);
    assert.equal(f.counts().acquires, 0);
    assert.equal(f.record().status, status);
  });
}

for (const kind of ['no-cwd', 'schedule'] as const) {
  test(`direct Uploader takeover enforces ${kind} guards even when the committed prefix is otherwise identical`, async (t) => {
    const unsafe = kind === 'no-cwd' ? snapshot([event(0)], sessionHeader({ id, cwd: undefined })) : snapshot([event(0, 'schedule/change')]);
    const f = fixture({ remote: unsafe }); t.after(() => f.dispose());
    await assert.rejects(f.uploader.takeover(id), code('CONFLICT'));
    assert.equal(f.counts().breaks, 0);
    assert.equal(f.counts().acquires, 0);
    assert.equal(f.writes.length, 0);
  });
}

test('SyncService facade detects a retained stale Agent remote-ahead before delegating to any takeover', async (t) => {
  const f = fixture({ local: snapshot([event(0)]), live: true }); t.after(() => f.dispose());
  await assert.rejects(f.service.takeover(id), code('CONFLICT'));
  assert.equal(f.record().status, 'remote-ahead-live');
  assert.equal(f.counts().breaks, 0);
  assert.equal(f.counts().acquires, 0);
  assert.equal(f.uploader.hasHeld(id), false);
  assert.ok(f.trace.includes('blob-read'), 'service reconciliation must verify the actual committed remote history');
});

test('SyncService facade accepts an explicitly confirmed, freshly verified current local copy', async (t) => {
  const f = fixture({ live: true }); t.after(() => f.dispose());
  assert.deepEqual(await f.service.takeover(id), { owned: true });
  assert.equal(f.counts().breaks, 1);
  assert.equal(f.record().writerEpoch, 8);
  assert.deepEqual(await f.service.ensureOwnership(id), { owned: true });
  assert.equal(f.counts().renews, 1);
});

for (const change of ['prefix', 'generation', 'disabled'] as const) {
  test(`manifest ${change} changes between verification and acquisition: the acquired resource is released, never retained`, async (t) => {
    const f = fixture(); t.after(() => f.dispose());
    f.hooks.beforeBreak = () => f.patchRemote(change === 'prefix' ? { chainHash: 'f'.repeat(64) }
      : change === 'generation' ? { generation: 2, rootGeneration: 2 } : { state: 'disabled', enabled: false });
    await assert.rejects(f.uploader.takeover(id), code(change === 'prefix' ? 'CONFLICT' : change === 'generation' ? 'GENERATION_CHANGED' : 'DISABLED'));
    assert.equal(f.counts().breaks, 1);
    assert.equal(f.counts().acquires, 1);
    assert.equal(f.counts().releases, 1);
    assert.equal(f.counts().active, undefined);
    assert.equal(f.uploader.hasHeld(id), false);
    assert.equal(f.record().writerEpoch, 7);
    assert.equal(f.writes.length, 0);
    assert.equal((await f.repository.getManifest(id))?.entity.leaseOwner, undefined);
  });
}

test('pre-cancelled service, uploader and public lease-manager takeover never break any lease', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.takeover(id, controller.signal));
  await assert.rejects(f.uploader.takeover(id, controller.signal), code('CANCELLED'));
  await assert.rejects(f.leases.takeover(id, controller.signal), code('CANCELLED'));
  assert.equal(f.trace.length, 0);
  assert.equal(f.counts().breaks, 0);
  assert.equal(f.counts().acquires, 0);
  assert.equal(f.writes.length, 0);
});

test('cancellation while reading the fresh local copy is fenced before the lease break', { timeout: 2_000 }, async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  const entered = deferred<void>(); const read = deferred<SourceSnapshot>();
  f.source.read = async () => { entered.resolve(); return read.promise; };
  const controller = new AbortController();
  const rejected = assert.rejects(f.uploader.takeover(id, controller.signal), code('CANCELLED'));
  await entered.promise; controller.abort(); read.resolve(snapshot()); await rejected;
  assert.equal(f.counts().breaks, 0);
  assert.equal(f.counts().acquires, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.uploader.hasHeld(id), false);
});

test('a server-accepted late takeover acquire is cleaned after cancellation, without a held lease or success status', { timeout: 2_000 }, async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  const entered = deferred<LeaseHandle>(); const response = deferred<LeaseHandle>(); const released = deferred<void>();
  f.hooks.acquireResponse = async (handle) => { entered.resolve(handle); return response.promise; };
  const release = f.raw.release.bind(f.raw);
  f.raw.release = async (handle) => { await release(handle); released.resolve(); };
  const controller = new AbortController();
  const rejected = assert.rejects(f.uploader.takeover(id, controller.signal), code('CANCELLED'));
  const handle = await entered.promise;
  assert.equal(f.counts().active, handle.leaseId, 'the server has accepted the lease before its response arrives');
  controller.abort(); await rejected;
  assert.equal(f.uploader.hasHeld(id), false);
  assert.equal(f.writes.length, 0);
  response.resolve(handle); await released.promise;
  assert.equal(f.counts().breaks, 1);
  assert.equal(f.counts().acquires, 1);
  assert.equal(f.counts().releases, 1);
  assert.equal(f.counts().active, undefined);
  assert.equal(f.record().status, 'ownership-unverified');
  const remote = await f.repository.getManifest(id); assert.ok(remote);
  assert.equal(remote.entity.writerEpoch, 7, 'a cancelled late acquire must not publish an epoch');
  assert.notEqual(remote.entity.leaseOwner, owner);
});

test('an ordinary queued IO request and its cancellation do not invalidate a foreground ownership proof', { timeout: 2_000 }, async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  await f.uploader.takeover(id);
  const entered = deferred<void>(); const flush = deferred<void>();
  let calls = 0;
  f.source.flush = async () => { if (++calls === 1) { entered.resolve(); await flush.promise; } };
  const proof = f.uploader.ensureOwnership(id);
  await entered.promise;
  const controller = new AbortController();
  const rejected = assert.rejects(f.uploader.sync(id, { signal: controller.signal }), code('CANCELLED'));
  controller.abort(); flush.resolve();
  assert.deepEqual(await proof, { owned: true });
  await rejected;
  assert.equal(f.uploader.hasHeld(id), true);
  assert.equal(f.counts().renews, 1);
  assert.equal(f.counts().releases, 0);
  assert.equal(f.counts().breaks, 1);
});

test('public lease-manager takeover cancellation during break cannot proceed to acquire', { timeout: 2_000 }, async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  const entered = deferred<void>(); const broken = deferred<void>();
  f.hooks.beforeBreak = async () => { entered.resolve(); await broken.promise; };
  const controller = new AbortController();
  const rejected = assert.rejects(f.leases.takeover(id, controller.signal), code('CANCELLED'));
  await entered.promise; controller.abort(); await rejected;
  broken.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.counts().breaks, 1);
  assert.equal(f.counts().acquires, 0);
  assert.equal(f.writes.length, 0);
});

function assertFrozenWithoutCloudWork(f: ReturnType<typeof fixture>, before: ReturnType<ReturnType<typeof fixture>['cloudState']>, counts: ReturnType<ReturnType<typeof fixture>['counts']>, traceAt: number) {
  assert.equal(f.record().mappingUnstable, true);
  assert.equal(f.record().admissionStopped, true);
  assert.equal(f.record().status, 'mapping-unstable');
  assert.equal(f.uploader.hasHeld(id), false);
  assert.deepEqual(f.counts(), counts, 'a frozen path must not acquire, renew, break or release a new writer');
  assert.deepEqual(f.publications(), { candidateWrites: 0, batchTransactions: 0 });
  assert.deepEqual(f.cloudState(), before, 'frozen paths must not mutate the manifest, batch rows or payloads');
  assert.deepEqual(f.trace.slice(traceAt), [], 'guards must run before source flush, canonicalization or cloud IO');
}

test('stopForMapping releases the real writer and freezes scheduled service/direct uploader work without any historical change', async (t) => {
  const f = fixture({ live: true }); t.after(() => f.dispose());
  assert.deepEqual(await f.uploader.takeover(id), { owned: true });
  assert.equal(f.uploader.hasHeld(id), true);
  await f.service.stopForMapping(id);
  assert.equal(f.counts().releases, 1);
  assert.equal(f.counts().active, undefined);
  assert.equal((await f.repository.getManifest(id))?.entity.leaseOwner, undefined);
  const before = f.cloudState(); const counts = f.counts(); const traceAt = f.trace.length;
  const scheduled = Promise.resolve().then(() => f.service.sync(id));
  await assert.rejects(scheduled, code('MAPPING_UNSTABLE'));
  await f.service.refreshAll();
  assert.equal(await f.service.reconcile(id), undefined);
  await f.service.drain(id);
  assert.deepEqual(await f.service.ensureOwnership(id), { owned: false, reason: 'ownership-unverified' });
  await assert.rejects(f.uploader.sync(id), code('MAPPING_UNSTABLE'));
  assert.equal(await f.uploader.drain(id, { agentIdle: true, inboxSize: 0 }), 'kept');
  assert.deepEqual(await f.uploader.ensureOwnership(id), { owned: false, reason: 'ownership-unverified' });
  await assert.rejects(f.uploader.takeover(id), code('DISABLED'));
  await assert.rejects(f.service.enable(id), code('CONFLICT'));
  await assert.rejects(f.service.repairSession(id), code('MAPPING_UNSTABLE'));
  assertFrozenWithoutCloudWork(f, before, counts, traceAt);
});

test('mapping-frozen remote-ahead reconciliation never imports a suffix or reopens ownership', async (t) => {
  const f = fixture({ remote: snapshot([event(0), event(1)]), local: snapshot([event(0)]) }); t.after(() => f.dispose());
  // The same real reader proves this is a valid remote-ahead prefix, not a malformed fixture.
  assert.equal((await f.reader.read(id))?.events.length, 2);
  await f.service.stopForMapping(id);
  const before = f.cloudState(); const counts = f.counts(); const traceAt = f.trace.length;
  assert.equal(await f.service.reconcile(id), undefined);
  await f.service.refreshAll();
  await assert.rejects(f.service.sync(id), code('MAPPING_UNSTABLE'));
  await f.service.drain(id);
  assert.deepEqual(await f.service.ensureOwnership(id), { owned: false, reason: 'ownership-unverified' });
  assertFrozenWithoutCloudWork(f, before, counts, traceAt);
});

for (const flags of [{ admissionStopped: true, mappingUnstable: false }, { admissionStopped: false, mappingUnstable: true }]) {
  test(`each freeze flag independently stops service and direct uploader publication/admission (${flags.admissionStopped ? 'admissionStopped' : 'mappingUnstable'})`, async (t) => {
    const f = fixture({ local: snapshot([event(0), event(1), event(2)]) }); t.after(() => f.dispose());
    f.setRecord({ ...flags, status: 'mapping-unstable' });
    const before = f.cloudState(); const counts = f.counts(); const traceAt = f.trace.length;
    await assert.rejects(f.service.sync(id), code('MAPPING_UNSTABLE'));
    assert.equal(await f.service.reconcile(id), undefined);
    await f.service.drain(id);
    assert.deepEqual(await f.service.ensureOwnership(id), { owned: false, reason: 'ownership-unverified' });
    await assert.rejects(f.uploader.sync(id), code('MAPPING_UNSTABLE'));
    assert.equal(await f.uploader.drain(id, { agentIdle: true, inboxSize: 0 }), 'kept');
    assert.deepEqual(await f.uploader.ensureOwnership(id), { owned: false, reason: 'ownership-unverified' });
    await assert.rejects(f.uploader.takeover(id), code('DISABLED'));
    assert.equal(f.uploader.hasHeld(id), false);
    assert.deepEqual(f.counts(), counts);
    assert.deepEqual(f.publications(), { candidateWrites: 0, batchTransactions: 0 });
    assert.deepEqual(f.cloudState(), before);
    assert.deepEqual(f.trace.slice(traceAt), []);
    assert.deepEqual({ admissionStopped: f.record().admissionStopped, mappingUnstable: f.record().mappingUnstable }, flags);
  });
}

test('ordinary on cannot clear a mapping-only freeze or acquire/publish a writer', async (t) => {
  const f = fixture(); t.after(() => f.dispose());
  f.setRecord({ mappingUnstable: true, admissionStopped: false, status: 'mapping-unstable' });
  const before = f.cloudState(); const counts = f.counts(); const traceAt = f.trace.length;
  await assert.rejects(f.service.enable(id), code('MAPPING_UNSTABLE'));
  assertFrozenWithoutCloudWork(f, before, counts, traceAt);
});

test('a newer priority off wins over an older stopForMapping persistence completion and all later scheduled sync work', { timeout: 2_000 }, async (t) => {
  const f = fixture({ live: true }); t.after(() => f.dispose());
  await f.uploader.takeover(id);
  const entered = deferred<void>(); const completed = deferred<void>();
  f.persistenceHooks.afterWrite = async (next) => {
    if (next.status === 'mapping-unstable') { entered.resolve(); await completed.promise; }
  };
  const freeze = f.service.stopForMapping(id);
  await entered.promise;
  assert.equal(f.record().mappingUnstable, true);
  await f.service.disable(id);
  assert.equal(f.record().enabled, false);
  assert.equal(f.record().detached, true);
  completed.resolve(); await freeze;
  const off = f.record();
  assert.equal(off.enabled, false);
  assert.equal(off.detached, true);
  assert.equal(off.status, 'detached');
  assert.equal(off.mappingUnstable, true, 'opt-out must preserve the explicit-repair marker');
  assert.equal(f.uploader.hasHeld(id), false);
  assert.equal(f.counts().active, undefined);
  const remote = await f.repository.getManifest(id); assert.ok(remote);
  assert.equal(remote.entity.state, 'disabled');
  assert.equal(remote.entity.enabled, false);
  assert.equal(remote.entity.leaseOwner, undefined);
  const before = f.cloudState(); const counts = f.counts(); const traceAt = f.trace.length;
  // A delayed older mapping callback must not turn off back into a frozen opt-in.
  await f.service.stopForMapping(id);
  assert.deepEqual(await Promise.resolve().then(() => f.service.sync(id)), { status: 'disabled', eventCount: 0, uploadedBatches: 0 });
  assert.equal(await f.service.reconcile(id), undefined);
  await f.service.drain(id);
  assert.deepEqual(await f.uploader.sync(id), { status: 'disabled', eventCount: 0, uploadedBatches: 0 });
  assert.deepEqual(await f.uploader.ensureOwnership(id), { owned: false, reason: 'ownership-unverified' });
  await assert.rejects(f.uploader.takeover(id), code('DISABLED'));
  await assert.rejects(f.service.repairSession(id, { confirmMapping: true }), code('DISABLED'));
  assert.deepEqual(f.record(), off);
  assert.deepEqual(f.cloudState(), before);
  assert.deepEqual(f.counts(), counts);
  assert.deepEqual(f.publications(), { candidateWrites: 0, batchTransactions: 0 });
  assert.deepEqual(f.trace.slice(traceAt), []);
});
