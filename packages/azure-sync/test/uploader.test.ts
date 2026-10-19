import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '../src/config.js';
import { Uploader, type UploadDependencies } from '../src/sync/uploader.js';
import { batchRowSchema, type BatchRow, type CloudSessionEntity, type LocalSessionRecord } from '../src/schema.js';
import { candidateBlobName, type CloudRepository, type StoredManifest } from '../src/sync/cloud-repository.js';
import { planBatch } from '../src/sync/batcher.js';
import { batchBlobMetadata } from '../src/sync/blob-metadata.js';
import type { SessionLease, SessionLeaseManager, SessionLeaseSeconds } from '../src/sync/lease-manager.js';
import { SyncService } from '../src/sync/service.js';
import type { SessionSource, SourceSnapshot } from '../src/sync/session-source.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { cloudSession, event, localSession, pathMapping, sessionHeader } from './helpers.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { gzipSync } from 'node:zlib';
import { batchRow } from './helpers.js';
import { nodeCwdFs, type CwdBinding } from '../src/sync/effective-cwd.js';
import { AttachmentSync } from '../src/sync/attachments.js';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { BlobStore } from '../src/azure/blob.js';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

function snapshot(events: unknown[], id = 'session-test'): SourceSnapshot {
  return { header: sessionHeader({ id }) as never, inheritedEventCount: 0, events: events as never };
}

class MemoryRepository {
  manifest?: StoredManifest;
  readonly rows = new Map<string, BatchRow>();
  readonly blobs = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  failCommit = false;
  failuresRemaining = 0;
  beforeCommit?: () => Promise<void>;
  beforeUpdate?: (entity: CloudSessionEntity) => void;
  async getManifest(): Promise<StoredManifest | undefined> { return this.manifest === undefined ? undefined : structuredClone(this.manifest); }
  async createManifest(entity: CloudSessionEntity): Promise<boolean> {
    if (this.manifest !== undefined) return false;
    this.manifest = { entity: structuredClone(entity), etag: 'etag-1' };
    return true;
  }
  async updateManifest(entity: CloudSessionEntity, etag: string): Promise<void> {
    this.beforeUpdate?.(entity);
    assert.equal(this.manifest?.etag, etag);
    this.manifest = { entity: structuredClone(entity), etag: `etag-${Number(etag.slice(5)) + 1}` };
  }
  async putCandidate(name: string, bytes: Uint8Array, metadata: Record<string, string>): Promise<{ status: 'created' | 'exists' }> {
    if (this.blobs.has(name)) return { status: 'exists' };
    this.blobs.set(name, { bytes: Uint8Array.from(bytes), metadata });
    return { status: 'created' };
  }
  private async *listCandidates(prefix: string) {
    for (const [name, blob] of this.blobs) if (name.startsWith(prefix)) yield { name, sizeBytes: blob.bytes.byteLength };
  }
  readonly blob = { getMetadata: async (name: string) => this.blobs.get(name)?.metadata ?? {}, list: (prefix: string) => this.listCandidates(prefix) };
  async readCandidate(name: string): Promise<Buffer> { return Buffer.from(this.blobs.get(name)?.bytes ?? new Uint8Array()); }
  async commitBatch(proof: StoredManifest, row: BatchRow, next: CloudSessionEntity): Promise<StoredManifest> {
    if (this.beforeCommit !== undefined) await this.beforeCommit();
    if (this.failCommit || this.failuresRemaining > 0) {
      if (this.failuresRemaining > 0) this.failuresRemaining -= 1;
      throw new AzureSyncError('PRECONDITION', 'synthetic conflict');
    }
    assert.equal(this.manifest?.etag, proof.etag);
    this.rows.set(row.rowKey, structuredClone(row));
    this.manifest = { entity: structuredClone(next), etag: `etag-${Number(proof.etag.slice(5)) + 1}` };
    return structuredClone(this.manifest);
  }
}

class MemoryLeases {
  epoch = 0;
  beforeAcquire?: () => Promise<void>;
  beforeRenew?: () => Promise<void>;
  lost = false;
  renews = 0;
  releases = 0;
  takeovers = 0;
  readonly durations: SessionLeaseSeconds[] = [];
  constructor(private readonly repo: MemoryRepository) {}
  async acquire(sessionId: string, _signal?: AbortSignal, seconds: SessionLeaseSeconds = 60): Promise<SessionLease> {
    this.durations.push(seconds);
    if (this.beforeAcquire !== undefined) await this.beforeAcquire();
    const manifest = this.repo.manifest;
    assert.ok(manifest);
    const epoch = manifest.entity.writerEpoch + 1;
    const entity: CloudSessionEntity = { ...manifest.entity, writerEpoch: epoch, leaseOwner: 'device-a', leaseUntil: Date.now() + seconds * 1000, updatedAt: 1 };
    await this.repo.updateManifest(entity, manifest.etag);
    this.epoch = epoch;
    return { sessionId, deviceId: 'device-a', epoch, handle: {} as never, manifest: (await this.repo.getManifest()) as StoredManifest, durationSeconds: seconds };
  }
  async takeover(sessionId: string, signal?: AbortSignal, seconds: SessionLeaseSeconds = 60): Promise<SessionLease> { this.takeovers++; return this.acquire(sessionId, signal, seconds); }
  async proof(_sessionId: string, epoch: number): Promise<StoredManifest> {
    if (this.lost) throw new AzureSyncError('LEASE_LOST', 'synthetic lost');
    const manifest = await this.repo.getManifest();
    assert.ok(manifest);
    assert.equal(manifest.entity.writerEpoch, epoch);
    return manifest;
  }
  async renew(lease: SessionLease): Promise<SessionLease> {
    if (this.beforeRenew !== undefined) await this.beforeRenew();
    if (this.lost) throw new AzureSyncError('LEASE_LOST', 'synthetic lost');
    this.renews += 1;
    const manifest = await this.repo.getManifest();
    return { ...lease, manifest: manifest as StoredManifest };
  }
  async release(): Promise<void> { this.releases += 1; }
}

function localFake(record: LocalSessionRecord) {
  let current = record;
  let lane: Promise<unknown> = Promise.resolve();
  return {
    getSession: () => current,
    putSession: async (next: LocalSessionRecord) => { current = next; },
    transactSession: (_id: string, fn: (value: LocalSessionRecord | undefined) => LocalSessionRecord | undefined) => {
      const task = lane.then(() => { const next = fn(current); if (next !== undefined) current = next; return next; });
      lane = task.then(() => undefined, () => undefined); return task;
    },
    get: () => current,
  };
}

function fixture(events: unknown[], options: { materialized?: boolean; maxBatchEvents?: number; renewEveryMs?: number; cwdBinding?: () => Promise<CwdBinding | undefined>; attachments?: AttachmentSync; gitMetadata?: UploadDependencies['gitMetadata'] } = {}) {
  const repo = new MemoryRepository();
  const leases = new MemoryLeases(repo);
  const local = localFake(localSession({ sessionId: 'session-test' }));
  let currentEvents = events;
  let materialized = options.materialized ?? true;
  const source: SessionSource = {
    flush: async () => undefined,
    read: async (id) => materialized ? snapshot(currentEvents, id) : undefined,
    stat: async () => materialized ? { header: snapshot(currentEvents).header } : undefined,
  };
  const config = Config({ maxBatchEvents: options.maxBatchEvents ?? 1000 });
  let now = 1_000;
  const uploader = new Uploader({
    config, source, repository: repo as unknown as CloudRepository, leases: leases as unknown as SessionLeaseManager,
    local: local as never, deviceId: 'device-a', platform: 'linux', now: () => now,
    ...(options.renewEveryMs === undefined ? {} : { renewEveryMs: options.renewEveryMs }),
    ...(options.cwdBinding === undefined ? {} : { cwdBinding: options.cwdBinding }),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.gitMetadata === undefined ? {} : { gitMetadata: options.gitMetadata }),
  });
  return { repo, leases, local, source, uploader, setEvents: (next: unknown[]) => { currentEvents = next; }, setMaterialized: (next: boolean) => { materialized = next; }, setNow: (next: number) => { now = next; } };
}

for (const importState of ['planned', 'creating', 'appending', 'attachments', 'warming', 'failed', 'degraded'] as const) {
  test(`incomplete ${importState} import cannot enable, publish, prove ownership, or break a lease before repair`, async () => {
    const f = fixture([event(0)]);
    await f.local.putSession({ ...f.local.get(), importState, imported: true });
    const before = structuredClone(f.local.get());
    f.source.flush = async () => { assert.fail('incomplete import must stop before persistence/cloud work'); };
    const incomplete = (error: unknown) => error instanceof AzureSyncError && error.code === 'IMPORT_INCOMPLETE';
    await assert.rejects(f.uploader.enable('session-test'), incomplete);
    await assert.rejects(f.uploader.sync('session-test'), incomplete);
    assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: false, reason: 'ownership-unverified' });
    await assert.rejects(f.uploader.takeover('session-test'), incomplete);
    await assert.rejects(f.uploader.snapshotForResurrection('session-test'), incomplete);
    assert.deepEqual(f.local.get(), before, 'failed actions never grant permission or change the durable import record');
    assert.equal(f.repo.manifest, undefined); assert.equal(f.repo.rows.size, 0); assert.equal(f.repo.blobs.size, 0);
    assert.equal(f.leases.epoch, 0); assert.equal(f.leases.renews, 0); assert.equal(f.leases.releases, 0);
    await f.local.putSession({ ...before, enabled: false, detached: true, state: 'disabled', status: 'detached' });
    const stopped = structuredClone(f.local.get());
    await assert.rejects(f.uploader.enable('session-test'), incomplete);
    assert.deepEqual(f.local.get(), stopped, 'rejected On preserves explicit local opt-out');
    assert.equal((await f.uploader.sync('session-test')).status, 'disabled');
    assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: false, reason: 'ownership-unverified' });
  });
}

test('advisory Git metadata publishes only sanitized allowlisted facts and never grants disabled permission', async () => {
  const facts = { v: 1 as const, root: '/local/project', branch: 'main', commit: 'a'.repeat(40), detached: false, unborn: false, worktree: false, dirty: 'clean' as const, remote: 'https://example.invalid/repo' };
  const f = fixture([event(0)], { gitMetadata: async () => facts }); await f.uploader.sync('session-test');
  assert.deepEqual(JSON.parse(f.repo.manifest!.entity.gitJson!), facts); assert.equal(f.repo.manifest!.entity.eventCount, 1);
  const bad = fixture([event(0)], { gitMetadata: async () => ({ ...facts, remote: 'https://example.invalid/repo?sig=must-not-cross' }) });
  await bad.uploader.sync('session-test'); assert.equal(bad.repo.manifest!.entity.gitJson, undefined); assert.ok(!JSON.stringify(bad.repo.manifest).includes('must-not-cross'));
  for (const scheme of ['http', 'https']) for (const userinfo of ['CANARYTOKEN', 'CANARYUSER:12345']) {
    const remote = `${scheme}://${userinfo}${String.fromCharCode(92)}@example.invalid/repo.git`;
    const unsafe = fixture([event(0)], { gitMetadata: async () => ({ ...facts, remote }) });
    await unsafe.uploader.sync('session-test', { release: true });
    assert.equal(unsafe.repo.manifest!.entity.gitJson, undefined); assert.ok(!JSON.stringify(unsafe.repo.manifest).includes('CANARY'));
  }
  for (const remote of ['CANARYUSER:12345@example.invalid:team/repo.git', 'org:glpat-CANARY@example.invalid:team/repo.git']) {
    const unsafe = fixture([event(0)], { gitMetadata: async () => ({ ...facts, remote }) }); await unsafe.uploader.sync('session-test', { release: true });
    assert.equal(unsafe.repo.manifest!.entity.gitJson, undefined); assert.doesNotMatch(JSON.stringify(unsafe.repo.manifest), /CANARY/iu);
  }
  let reads = 0; const off = fixture([event(0)], { gitMetadata: async () => { reads++; return facts; } });
  await off.local.putSession({ ...off.local.get(), enabled: false, detached: true }); assert.equal((await off.uploader.sync('session-test')).status, 'disabled'); assert.equal(reads, 0); assert.equal(off.repo.manifest, undefined);
});

test('a newer off during advisory Git IO still preempts every later cloud write and metadata checkpoint', async () => {
  let ready!: () => void, release!: () => void; const started = new Promise<void>(done => { ready = done; }), pending = new Promise<void>(done => { release = done; });
  const f = fixture([event(0)], { gitMetadata: async () => { ready(); await pending; return null; } });
  const sync = f.uploader.sync('session-test'); const rejected = assert.rejects(sync, error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  await started; const disabling = f.uploader.disable('session-test');
  await f.local.transactSession('session-test', () => undefined); assert.equal(f.local.get().enabled, false);
  release(); await disabling; const stopped = structuredClone(f.local.get()); await rejected;
  assert.deepEqual(f.local.get(), stopped); assert.equal(f.local.get().enabled, false); assert.equal(f.repo.manifest, undefined); assert.equal(f.repo.blobs.size, 0); assert.equal(f.leases.epoch, 0);
});

test('cold 30s handles have no background renewal and a native proof promotes through a new 60s epoch', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const f = fixture([event(0)]); t.after(() => f.uploader.close());
  assert.equal((await f.uploader.ensureOwnership('session-test', undefined, 30)).owned, true); assert.deepEqual(f.leases.durations, [30]);
  t.mock.timers.tick(90_000); await new Promise<void>(done => setImmediate(done)); assert.equal(f.leases.renews, 0, 'stalled cold controls must not keep renewing forever');
  const priorEpoch = f.local.get().writerEpoch;
  assert.equal((await f.uploader.ensureOwnership('session-test', undefined, 60)).owned, true); assert.deepEqual(f.leases.durations, [30, 60]); assert.equal(f.leases.releases, 1); assert.ok(f.local.get().writerEpoch > priorEpoch);
});

test('a cold hint never downgrades, breaks or releases a pre-existing native 60s foreground lease', async t => {
  const f = fixture([event(0)]); t.after(() => f.uploader.close()); await f.uploader.ensureOwnership('session-test');
  const epoch = f.local.get().writerEpoch;
  assert.equal((await f.uploader.ensureOwnership('session-test', undefined, 30)).owned, true);
  await f.uploader.sync('session-test', { release: true, leaseSeconds: 30 });
  assert.equal((await f.uploader.takeover('session-test', undefined, 30)).owned, true);
  assert.deepEqual(f.leases.durations, [60]); assert.equal(f.leases.takeovers, 0); assert.equal(f.leases.releases, 0); assert.equal(f.local.get().writerEpoch, epoch); assert.equal(f.uploader.hasHeld('session-test'), true);
});

test('cold-to-native promotion that loses acquisition returns nonowned, never the old cold grant', async t => {
  const f = fixture([event(0)]); t.after(() => f.uploader.close()); await f.uploader.ensureOwnership('session-test', undefined, 30);
  f.leases.beforeAcquire = async () => { throw new AzureSyncError('CONFLICT', 'another owner won'); };
  const result = await f.uploader.ensureOwnership('session-test', undefined, 60); assert.deepEqual(result, { owned: false, reason: 'paused-other-device' }); assert.equal(f.uploader.hasHeld('session-test'), false); assert.equal(f.leases.releases, 1);
});

test('cancelled promotion cleans a late accepted 60s acquisition without installing renewal or new local authority', async t => {
  const f = fixture([event(0)]); t.after(() => f.uploader.close()); await f.uploader.ensureOwnership('session-test', undefined, 30);
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(done => { enter = done; }), wait = new Promise<void>(done => { release = done; });
  f.leases.beforeAcquire = async () => { enter(); await wait; };
  const before = structuredClone(f.local.get()), stop = new AbortController(); const promotion = f.uploader.ensureOwnership('session-test', stop.signal, 60);
  const rejected = assert.rejects(promotion, error => error instanceof AzureSyncError && error.code === 'CANCELLED'); await entered; stop.abort(); release(); await rejected;
  assert.deepEqual(f.leases.durations, [30, 60]); assert.equal(f.leases.releases, 2); assert.equal(f.uploader.hasHeld('session-test'), false); assert.deepEqual(f.local.get(), before);
});

for (const action of ['on', 'sync', 'takeover', 'inspection'] as const) test(`cold service ${action} requests 30s and immediately cleans its capability`, async t => {
  const f = fixture([event(0)]);
  if (action === 'takeover') { await f.uploader.sync('session-test', { release: true, leaseSeconds: 30 }); f.leases.durations.length = 0; f.leases.releases = 0; }
  const service = new SyncService({ uploader: f.uploader, local: f.local as never, source: f.source, agents: { get: () => undefined } as never }); t.after(() => service.close());
  if (action === 'on') await service.enable('session-test');
  else if (action === 'sync') await service.sync('session-test');
  else if (action === 'takeover') assert.equal((await service.takeover('session-test')).owned, true);
  else assert.equal((await service.ensureOwnership('session-test', undefined, { inspection: true })).owned, true);
  assert.deepEqual(f.leases.durations, [30]); assert.equal(f.uploader.hasHeld('session-test'), false); assert.equal(f.leases.releases, 1);
});

test('a failed cold On still releases its 30s capability and never installs background renewal', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const f = fixture([event(0)]); f.repo.failCommit = true;
  const service = new SyncService({ uploader: f.uploader, local: f.local as never, source: f.source, agents: { get: () => undefined } as never }); t.after(() => service.close());
  await assert.rejects(service.enable('session-test'), error => error instanceof AzureSyncError && error.code === 'PRECONDITION');
  assert.deepEqual(f.leases.durations, [30]); assert.equal(f.leases.releases, 1); assert.equal(f.uploader.hasHeld('session-test'), false); assert.equal(f.repo.rows.size, 0); assert.notEqual(f.local.get().status, 'synced');
  t.mock.timers.tick(90_000); await new Promise<void>(done => setImmediate(done)); assert.equal(f.leases.renews, 0);
});

test('Agent appearance followed by foreign promotion loss fails closed instead of returning the old cold proof', async t => {
  const f = fixture([event(0)]); let live = false;
  f.leases.beforeAcquire = async () => { if (f.leases.durations.length === 1) live = true; else throw new AzureSyncError('CONFLICT', 'foreign owner won'); };
  const service = new SyncService({ uploader: f.uploader, local: f.local as never, source: f.source, agents: { get: () => live ? { status: 'busy' } : undefined } as never }); t.after(() => service.close());
  await assert.rejects(service.ensureOwnership('session-test', undefined, { inspection: true }), error => error instanceof AzureSyncError && error.code === 'OWNERSHIP_UNVERIFIED');
  assert.deepEqual(f.leases.durations, [30, 60]); assert.equal(f.uploader.hasHeld('session-test'), false); assert.equal(f.leases.releases, 1);
});

for (const action of ['on', 'takeover', 'inspection'] as const) test(`a native Agent appearing during cold ${action} is promoted before the control completes`, async t => {
  const f = fixture([event(0)]); let live = false;
  if (action === 'takeover') { await f.uploader.sync('session-test', { release: true, leaseSeconds: 30 }); f.leases.durations.length = 0; f.leases.releases = 0; }
  f.leases.beforeAcquire = async () => { live = true; };
  const service = new SyncService({ uploader: f.uploader, local: f.local as never, source: f.source, agents: { get: () => live ? { status: 'busy' } : undefined } as never }); t.after(() => service.close());
  if (action === 'on') await service.enable('session-test');
  else if (action === 'takeover') assert.equal((await service.takeover('session-test')).owned, true);
  else assert.equal((await service.ensureOwnership('session-test', undefined, { inspection: true })).owned, true);
  assert.deepEqual(f.leases.durations, [30, 60]); assert.equal(f.leases.releases, 1, 'only the old cold handle is released'); assert.equal(f.uploader.hasHeld('session-test'), true);
});

test('an older queued cold inspection cannot downgrade or release the new foreground 60s proof', async t => {
  const f = fixture([event(0)]); let live = false, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(done => { enter = done; }), wait = new Promise<void>(done => { release = done; });
  f.leases.beforeAcquire = async () => { enter(); await wait; live = true; };
  const native = f.uploader.ensureOwnership('session-test', undefined, 60); await entered;
  const service = new SyncService({ uploader: f.uploader, local: f.local as never, source: f.source, agents: { get: () => live ? { status: 'busy' } : undefined } as never }); t.after(() => service.close());
  const cold = service.ensureOwnership('session-test', undefined, { inspection: true }); release();
  assert.equal((await native).owned, true); assert.equal((await cold).owned, true);
  assert.deepEqual(f.leases.durations, [60]); assert.equal(f.leases.releases, 0); assert.equal(f.uploader.hasHeld('session-test'), true);
});

for (const action of ['on', 'inspection'] as const) test(`Agent appearance during queued cold ${action} finalization promotes the retained 30s handle`, async t => {
  const f = fixture([event(0)]); let live = false;
  const releaseInspection = f.uploader.releaseInspection.bind(f.uploader);
  t.mock.method(f.uploader, 'releaseInspection', async (id: string, predicate: () => boolean) => { live = true; return releaseInspection(id, predicate); });
  const service = new SyncService({ uploader: f.uploader, local: f.local as never, source: f.source, agents: { get: () => live ? { status: 'busy' } : undefined } as never }); t.after(() => service.close());
  if (action === 'on') await service.enable('session-test'); else assert.equal((await service.ensureOwnership('session-test', undefined, { inspection: true })).owned, true);
  assert.deepEqual(f.leases.durations, [30, 60]); assert.equal(f.leases.releases, 1); assert.equal(f.uploader.heldLeaseSeconds('session-test'), 60);
});

test('failed cold On finalization never promotes a failed operation into active background renewal', async t => {
  const f = fixture([event(0)]); let live = false; f.repo.failCommit = true;
  const releaseInspection = f.uploader.releaseInspection.bind(f.uploader);
  t.mock.method(f.uploader, 'releaseInspection', async (id: string, predicate: () => boolean) => { live = true; return releaseInspection(id, predicate); });
  const service = new SyncService({ uploader: f.uploader, local: f.local as never, source: f.source, agents: { get: () => live ? { status: 'busy' } : undefined } as never }); t.after(() => service.close());
  await assert.rejects(service.enable('session-test'), error => error instanceof AzureSyncError && error.code === 'PRECONDITION');
  assert.deepEqual(f.leases.durations, [30]); assert.equal(f.uploader.heldLeaseSeconds('session-test'), 30); assert.notEqual(f.local.get().status, 'synced');
});

test('uploader writes blobs before atomic batches and advances the epoch', async () => {
  const f = fixture([event(0), event(1), event(2)], { maxBatchEvents: 2 });
  const result = await f.uploader.sync('session-test');
  assert.equal(result.status, 'synced');
  assert.equal(result.uploadedBatches, 2);
  assert.equal(f.repo.manifest?.entity.eventCount, 3);
  assert.equal(f.repo.manifest?.entity.batchCount, 2);
  assert.equal(f.repo.rows.size, 2);
  assert.equal(f.repo.blobs.size, 2);
  assert.equal(f.repo.manifest?.entity.writerEpoch, 1);
  assert.equal(f.local.get().status, 'synced');
  assert.equal(f.local.get().lastSyncedEventCount, 3);
});

test('unmaterialized empty sessions stay pending; materialized blank sessions create an empty manifest', async () => {
  const pending = fixture([], { materialized: false });
  assert.equal((await pending.uploader.sync('session-test')).status, 'pending-materialization');
  assert.equal(pending.repo.manifest, undefined);
  assert.equal(pending.local.get().status, 'pending-materialization');

  const blank = fixture([], { materialized: true });
  assert.equal((await blank.uploader.sync('session-test')).status, 'synced');
  assert.equal(blank.repo.manifest?.entity.eventCount, 0);
  assert.equal(blank.repo.rows.size, 0);
});

test('schedule and no-cwd guards refuse before any cloud write', async () => {
  const schedule = fixture([event(0, 'schedule/change')]);
  await assert.rejects(schedule.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'SCHEDULE_UNSAFE');
  assert.equal(schedule.repo.manifest, undefined);
  assert.equal(schedule.local.get().status, 'schedule-unsafe');
});

test('no-cwd sessions refuse before any cloud write', async () => {
  const f = fixture([event(0)]);
  const source = f.source as unknown as { read: (id: string) => Promise<SourceSnapshot | undefined> };
  const original = source.read;
  source.read = async (id) => ({ ...(await original(id))!, header: sessionHeader({ id, cwd: undefined }) as never });
  await assert.rejects(f.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'NO_CWD');
  assert.equal(f.repo.manifest, undefined);
  assert.equal(f.local.get().status, 'no-cwd');
});

test('a lost lease stops the uploader and records lease-lost', async () => {
  const f = fixture([event(0), event(1)], { maxBatchEvents: 1 });
  f.leases.lost = true;
  await assert.rejects(f.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'LEASE_LOST');
  assert.equal(f.local.get().status, 'lease-lost');
  assert.equal(f.repo.rows.size, 0);
});

test('a crash after blob upload leaves no committed row and the retry reuses the candidate', async () => {
  const f = fixture([event(0), event(1)], { maxBatchEvents: 2 });
  f.repo.failCommit = true;
  await assert.rejects(f.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'PRECONDITION');
  assert.equal(f.repo.blobs.size, 1);
  assert.equal(f.repo.rows.size, 0);
  assert.equal(f.repo.manifest?.entity.eventCount, 0);
  f.repo.failCommit = false;
  const result = await f.uploader.sync('session-test');
  assert.equal(result.status, 'synced');
  assert.equal(f.repo.rows.size, 1);
  assert.equal(f.repo.blobs.size, 1);
  assert.equal(f.repo.manifest?.entity.eventCount, 2);
});

test('enable blanks stay pending until materialized; disable retains the cloud copy', async () => {
  const blank = fixture([], { materialized: false });
  assert.equal((await blank.uploader.enable('session-test')).status, 'pending-materialization');
  assert.equal(blank.local.get().enabled, true);
  assert.equal(blank.repo.manifest, undefined);
  blank.setMaterialized(true);
  assert.equal((await blank.uploader.sync('session-test')).status, 'synced');
  await blank.uploader.disable('session-test');
  assert.equal(blank.local.get().enabled, false);
  const blankManifest = blank.repo.manifest as StoredManifest | undefined;
  assert.ok(blankManifest);
  assert.equal((blankManifest as StoredManifest).entity.enabled, false);
  assert.ok((blankManifest as StoredManifest).entity.writerEpoch >= 1);
});

test('candidate names carry start, creation epoch, and payload-hash prefix', async () => {
  const f = fixture([event(0)], { maxBatchEvents: 1 });
  await f.uploader.sync('session-test');
  const name = [...f.repo.blobs.keys()][0] ?? '';
  assert.match(name, /^v1\/sessions\/[A-Za-z0-9_-]+\/gen-1\/batches\/0-\d+-[0-9a-f]{16}\.jsonl\.gz$/u);
  assert.equal(f.repo.manifest?.entity.lastBatchBlobName, name);
});

test('a held lease is reused across lifecycle syncs instead of re-acquiring every time', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  const epoch = f.repo.manifest?.entity.writerEpoch;
  await f.uploader.sync('session-test', { release: false });
  assert.equal(f.repo.manifest?.entity.writerEpoch, epoch);
  assert.equal(f.repo.rows.size, 1);
  await f.uploader.disable('session-test');
});

test('held leases renew on the configured interval and teardown stops the timer', async () => {
  const f = fixture([event(0)], { renewEveryMs: 5 });
  await f.uploader.sync('session-test', { release: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(f.leases.renews > 0);
  await f.uploader.close();
});

test('a divergent local prefix is refused instead of being chained to the remote head', async () => {
  const f = fixture([event(0, 'user/message', { text: 'original' })]);
  await f.uploader.sync('session-test');
  assert.equal(f.repo.rows.size, 1);
  f.setEvents([event(0, 'user/message', { text: 'divergent' })]);
  await assert.rejects(f.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'CONFLICT');
  assert.equal(f.repo.rows.size, 1);
  assert.equal(f.repo.manifest?.entity.eventCount, 1);
});

test('committed rows and candidate names use the writer epoch as createdEpoch', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test');
  const row = [...f.repo.rows.values()][0];
  assert.equal(row?.createdEpoch, f.repo.manifest?.entity.writerEpoch);
  assert.match(row?.blobName ?? '', new RegExp(`-${row?.createdEpoch}-[0-9a-f]{16}\\.jsonl\\.gz$`, 'u'));
});

test('drain waits for the quiet window, publishes the final suffix, and releases', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  f.uploader.noteActivity('session-test');
  assert.equal(await f.uploader.drain('session-test', { agentIdle: true, inboxSize: 0 }), 'not-ready');
  assert.ok(f.repo.manifest);
  f.setNow(3_001);
  assert.equal(await f.uploader.drain('session-test', { agentIdle: true, inboxSize: 0 }), 'released');
  assert.equal(f.leases.releases, 1);
  assert.equal(f.uploader.hasHeld('session-test'), false);
  f.setNow(4_000);
  assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: true });
  assert.equal(f.uploader.hasHeld('session-test'), true);
});

test('a drain upload failure keeps the leased session and marks drain-failed', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  f.uploader.noteActivity('session-test');
  f.setNow(3_001);
  f.repo.failCommit = true;
  f.setEvents([event(0), event(1)]);
  assert.equal(await f.uploader.drain('session-test', { agentIdle: true, inboxSize: 0 }), 'kept');
  assert.equal(f.local.get().status, 'drain-failed');
  assert.equal(f.leases.releases, 0);
});

test('mapped sessions canonicalize local cwd events and header before upload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-upload-cwd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, 'local');
  await mkdir(local, { recursive: true });
  const real = await realpath(local);
  const mapping = pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' });
  const header = sessionHeader({ id: 'session-test', cwd: real });
  let currentEvents = [event(0, 'working-directory/change', { cwd: real })];
  const repo = new MemoryRepository();
  const leases = new MemoryLeases(repo);
  const localStore = localFake(localSession({ sessionId: 'session-test' }));
  const config = Config({});
  const uploader = new Uploader({
    config, repository: repo as unknown as CloudRepository, leases: leases as unknown as SessionLeaseManager,
    local: localStore as never, deviceId: 'device-a', platform: 'linux', now: () => 1_000,
    source: { flush: async () => undefined, read: async () => ({ header: header as never, inheritedEventCount: 0, events: currentEvents as never }), stat: async () => undefined },
    cwdBinding: async () => ({ mapping, fs: nodeCwdFs }),
  });
  await uploader.sync('session-test');
  const manifest = repo.manifest?.entity;
  assert.ok(manifest);
  assert.equal(JSON.parse(manifest.headerJson).cwd, '/remote/project');
  const payload = gunzipSync(Buffer.from([...repo.blobs.values()][0]!.bytes)).toString('utf8');
  assert.equal((JSON.parse(payload.split('\n')[0] as string) as { data: { cwd: string } }).data.cwd, '/remote/project');
});

test('a transient tip ETag race is retried up to three times before conflict', async () => {
  const f = fixture([event(0)]);
  f.repo.failuresRemaining = 2;
  const result = await f.uploader.sync('session-test');
  assert.equal(result.status, 'synced');
  assert.equal(result.uploadedBatches, 1);
  assert.equal(f.repo.rows.size, 1);
});

test('new activity during the final drain upload aborts release and keeps the lease', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  f.uploader.noteActivity('session-test');
  f.setNow(3_001);
  f.setEvents([event(0), event(1)]);
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.repo.beforeCommit = async () => { start(); await gate; };
  const draining = f.uploader.drain('session-test', { agentIdle: true, inboxSize: 0 });
  await started;
  f.uploader.noteActivity('session-test');
  release();
  assert.equal(await draining, 'kept');
  assert.equal(f.leases.releases, 0);
});

test('execution ownership is acquired or renewed against the authoritative lease path', async () => {
  const f = fixture([event(0)]);
  assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: true });
  assert.ok(f.repo.manifest);
  assert.equal(f.local.get().writerEpoch, 1);
  f.leases.lost = true;
  assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: false, reason: 'paused-other-device' });
  f.leases.lost = false;
  assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: true });
});

test('disable is serialized after an in-flight sync and cannot be overwritten', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  f.setEvents([event(0), event(1)]);
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.repo.beforeCommit = async () => { start(); await gate; };
  const syncing = f.uploader.sync('session-test', { release: false });
  await started;
  const disabling = f.uploader.disable('session-test');
  release();
  await syncing.catch(() => undefined);
  await disabling;
  assert.equal(f.local.get().enabled, false);
  assert.equal(f.repo.manifest?.entity.enabled, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.local.get().enabled, false);
});

test('ownership rejects a remote-ahead or divergent local prefix before execution', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  f.setEvents([event(0)]);
  f.repo.manifest = { ...(f.repo.manifest as StoredManifest), entity: { ...(f.repo.manifest as StoredManifest).entity, eventCount: 2 } };
  assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: false, reason: 'remote-ahead-live' });
  f.setEvents([event(0, 'user/message', { text: 'divergent' })]);
  f.repo.manifest = { ...(f.repo.manifest as StoredManifest), entity: { ...(f.repo.manifest as StoredManifest).entity, eventCount: 1 } };
  assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: false, reason: 'ownership-unverified' });
});

test('a remote prefix advance between verification and acquisition is caught against the lease manifest', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: true });
  f.setEvents([event(0), event(1), event(2)]);
  f.leases.beforeAcquire = async () => {
    const manifest = f.repo.manifest;
    assert.ok(manifest);
    f.repo.manifest = { entity: { ...manifest.entity, eventCount: 2, chainHash: 'd'.repeat(64), headHash: 'e'.repeat(64) }, etag: manifest.etag };
  };
  await assert.rejects(f.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'CONFLICT');
  assert.equal(f.repo.rows.size, 1);
});

test('ordinary forks are independent opt-ins unless the header is subagent lineage', async () => {
  const f = fixture([event(0)]);
  f.source.read = async () => ({ header: sessionHeader({ id: 'session-test', parentSession: 'unsynced-parent' }) as never, inheritedEventCount: 0, events: [event(0)] as never });
  await f.uploader.sync('session-test');
  assert.equal(f.repo.manifest?.entity.rootSessionId, 'session-test');
});

test('ownership blocks disabled, changed-generation, and tombstoned manifests before execution', async () => {
  const f = fixture([event(0)]);
  assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: true });
  const manifest = f.repo.manifest as StoredManifest;
  f.repo.manifest = { entity: { ...manifest.entity, state: 'disabled' }, etag: manifest.etag };
  assert.equal((await f.uploader.ensureOwnership('session-test')).owned, false);
  f.repo.manifest = { entity: { ...manifest.entity, generation: 2 }, etag: manifest.etag };
  assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: false, reason: 'generation-changed' });
  f.repo.manifest = { entity: { ...manifest.entity, state: 'deleted' }, etag: manifest.etag };
  assert.deepEqual(await f.uploader.ensureOwnership('session-test'), { owned: false, reason: 'removed-remotely' });
});

test('a subagent cannot silently become its own root when the parent is absent', async () => {
  const f = fixture([event(0)]);
  f.source.read = async () => ({ header: sessionHeader({ id: 'child', origin: 'subagent', parentSession: 'missing-parent' }) as never, inheritedEventCount: 0, events: [event(0)] as never });
  await assert.rejects(f.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'PRECONDITION');
  assert.equal(f.repo.manifest, undefined);
});

test('background sync never revives a remote disabled state or changed generation', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: true });
  const manifest = f.repo.manifest as StoredManifest;
  f.repo.manifest = { entity: { ...manifest.entity, state: 'disabled', enabled: false }, etag: manifest.etag };
  await assert.rejects(f.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'DISABLED');
  assert.equal(f.repo.manifest?.entity.state, 'disabled');
  assert.equal(f.repo.manifest?.entity.enabled, false);

  assert.equal(f.local.get().enabled, false);
  assert.equal((await f.uploader.sync('session-test')).status, 'disabled');
  const changed = fixture([event(0)]);
  changed.repo.manifest = { entity: { ...manifest.entity, generation: 2 }, etag: manifest.etag };
  await assert.rejects(changed.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'GENERATION_CHANGED');
  assert.equal(changed.local.get().generation, 1);
  assert.equal(changed.local.get().enabled, false);

  f.repo.manifest = { entity: { ...manifest.entity, state: 'disabled', enabled: false }, etag: manifest.etag };
  await f.uploader.enable('session-test');
  assert.equal(f.repo.manifest?.entity.state, 'active');
  assert.equal(f.repo.manifest?.entity.enabled, true);
});

test('disable remains usable after a never-settling ownership proof', async () => {
  const f = fixture([event(0)]);
  f.source.flush = async () => new Promise<void>(() => undefined);
  void f.uploader.ensureOwnership('session-test');
  await f.uploader.disable('session-test', 20);
  assert.equal(f.local.get().enabled, false);
  await f.uploader.close(20);
});

test('turning off after an idle drain still fences the shared cloud record', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  f.uploader.noteActivity('session-test');
  f.setNow(3_001);
  assert.equal(await f.uploader.drain('session-test', { agentIdle: true, inboxSize: 0 }), 'released');
  assert.equal(f.uploader.hasHeld('session-test'), false);
  await f.uploader.disable('session-test');
  assert.equal(f.local.get().enabled, false);
  assert.equal(f.repo.manifest?.entity.state, 'disabled');
  assert.equal(f.repo.manifest?.entity.enabled, false);
});

test('direct release-true sync followed by disable still fences the cloud record', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: true });
  await f.uploader.disable('session-test');
  assert.equal(f.local.get().enabled, false);
  assert.equal(f.repo.manifest?.entity.state, 'disabled');
  assert.equal(f.repo.manifest?.entity.enabled, false);
});

test('disable CAS-fences the shared record even when another device owns the lease', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: true });
  const manifest = f.repo.manifest as StoredManifest;
  f.repo.manifest = { entity: { ...manifest.entity, leaseOwner: 'device-b', leaseUntil: 99_000, state: 'active', enabled: true }, etag: manifest.etag };
  f.leases.acquire = async () => { throw new AzureSyncError('CONFLICT', 'other device'); };
  await f.uploader.disable('session-test');
  assert.equal(f.local.get().enabled, false);
  assert.equal(f.repo.manifest?.entity.state, 'disabled');
  assert.equal(f.repo.manifest?.entity.enabled, false);
});

test('close returns within its overall deadline even when release never settles', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  f.leases.release = async () => new Promise<void>(() => undefined);
  const started = Date.now();
  await f.uploader.close(20);
  assert.ok(Date.now() - started < 500);
});

test('an owned fast-path CAS failure falls back and confirms the shared opt-out', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: true });
  let failed = false;
  f.repo.beforeUpdate = (entity) => {
    if (entity.state === 'disabled' && !failed) { failed = true; throw new AzureSyncError('PRECONDITION', 'synthetic cas failure'); }
  };
  await f.uploader.disable('session-test');
  assert.equal(f.local.get().enabled, false);
  assert.equal(f.repo.manifest?.entity.state, 'disabled');
  assert.equal(f.repo.manifest?.entity.enabled, false);
  assert.equal(f.local.get().status, 'detached');
  assert.equal(f.local.get().detached, true);
});

test('disabling a tombstoned thread preserves the tombstone', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: true });
  const manifest = f.repo.manifest as StoredManifest;
  f.repo.manifest = { entity: { ...manifest.entity, state: 'deleted', enabled: false }, etag: manifest.etag };
  await f.uploader.disable('session-test');
  assert.equal(f.repo.manifest?.entity.state, 'deleted');
  assert.equal(f.local.get().enabled, false);
});

test('a queued older enable cannot publish after a newer disable', async () => {
  const f = fixture([event(0)]);
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.source.flush = async () => { start(); await gate; };
  const initial = f.uploader.sync('session-test');
  await started;
  const olderEnable = f.uploader.enable('session-test');
  await f.uploader.disable('session-test', 20);
  f.setEvents([event(0), event(1, 'user/message', { text: 'PRIVATE_AFTER_OFF' })]);
  release();
  await assert.rejects(initial, (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
  await assert.rejects(olderEnable, (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
  assert.equal(f.repo.rows.size, 0);
  assert.equal(f.local.get().enabled, false);
});

test('background sync does not invalidate a valid foreground ownership proof; disable does', async () => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.leases.beforeRenew = async () => { start(); await gate; };
  const proof = f.uploader.ensureOwnership('session-test');
  await started;
  const background = f.uploader.sync('session-test', { release: false });
  release();
  assert.deepEqual(await proof, { owned: true });
  assert.equal((await background).status, 'synced');

  let start2!: () => void;
  const started2 = new Promise<void>((resolve) => { start2 = resolve; });
  let release2!: () => void;
  const gate2 = new Promise<void>((resolve) => { release2 = resolve; });
  f.leases.beforeRenew = async () => { start2(); await gate2; };
  const next = f.uploader.ensureOwnership('session-test');
  await started2;
  await f.uploader.disable('session-test', 20);
  release2();
  assert.equal(await next.catch(() => 'cancelled'), 'cancelled');
  assert.equal(f.local.get().enabled, false);
});

test('close aborts an in-flight sync even when disable was never called', async () => {
  const f = fixture([event(0)]);
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.source.flush = async () => { start(); await gate; };
  const syncing = f.uploader.sync('session-test');
  await started;
  await f.uploader.close(20);
  release();
  await assert.rejects(syncing, (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
  assert.equal(f.repo.rows.size, 0);
});

test('uploader uploads referenced attachments before committing the event batch', async () => {
  const uploaded: string[] = [];
  const attachments = { upload: async (refs: { id: string }[]) => { uploaded.push(...refs.map((ref) => ref.id)); return { uploaded: refs.map((ref) => ref.id), missing: [] }; } } as unknown as AttachmentSync;
  const f = fixture([event(0, 'user/message', { content: [{ type: 'image', attachmentId: 'img-1', mediaType: 'image/png' }] })], { attachments });
  await f.uploader.sync('session-test');
  assert.deepEqual(uploaded, ['img-1']);
  assert.equal(f.repo.rows.size, 1);
});

test('a real capped image attachment cannot publish bytes, metadata or a fully-synced event tip', async () => {
  let puts = 0;
  const attachments = new AttachmentSync({ maxBytes: 4, now: () => 1, store: { readImage: async () => ({ data: Buffer.alloc(5) }) } as unknown as AttachmentStore, blob: { putIfAbsent: async () => { puts++; throw new Error('over-cap bytes must never reach Blob'); } } as unknown as BlobStore });
  const f = fixture([event(0, 'user/message', { content: [{ type: 'image', attachmentId: 'oversize', mediaType: 'image/png' }] })], { attachments });
  await assert.rejects(f.uploader.sync('session-test'), error => error instanceof AzureSyncError && error.code === 'ATTACHMENT_UNSUPPORTED');
  assert.equal(puts, 0); assert.equal(f.repo.rows.size, 0); assert.equal(f.repo.blobs.size, 0); assert.equal(f.repo.manifest?.entity.eventCount, 0); assert.notEqual(f.local.get().status, 'synced');
});

test('uploader blocks a synced state when a referenced attachment is missing', async () => {
  const attachments = { upload: async (refs: { id: string }[]) => ({ uploaded: [], missing: refs.map((ref) => ref.id) }) } as unknown as AttachmentSync;
  const f = fixture([event(0, 'user/message', { content: [{ type: 'file', attachmentId: 'file-1', name: 'a.txt', bytes: 1 }] })], { attachments });
  await assert.rejects(f.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'ATTACHMENT_UNSUPPORTED');
  assert.equal(f.repo.rows.size, 0);
});

test('attachments are never uploaded before a disabled/generation authorization check', async () => {
  const uploaded: string[] = [];
  const attachments = { upload: async (refs: { id: string }[]) => { uploaded.push(...refs.map((ref) => ref.id)); return { uploaded: refs.map((ref) => ref.id), missing: [] }; } } as unknown as AttachmentSync;
  const f = fixture([event(0, 'user/message', { content: [{ type: 'image', attachmentId: 'img-1', mediaType: 'image/png' }] })], { attachments });
  const header = sessionHeader({ id: 'session-test' });
  f.repo.manifest = { entity: cloudSession({ sessionId: 'session-test', headerHash: headerHash(header, 0), state: 'disabled', enabled: false }), etag: 'e' };
  await assert.rejects(f.uploader.sync('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'DISABLED');
  assert.deepEqual(uploaded, []);
});

test('imported upload keeps the exact canonical Windows header/prefix instead of reverse-mapping it', async (t) => {
  const localRoot = await mkdtemp(join(tmpdir(), 'dsh-azure-win-'));
  t.after(() => rm(localRoot, { recursive: true, force: true }));
  await mkdir(join(localRoot, 'app', 'sub'), { recursive: true });
  const realLocal = await realpath(localRoot);
  const sessionId = 'session-windows';
  const header = sessionHeader({ id: sessionId, cwd: 'C:\\work\\app' });
  const binding = headerHash(header, 0);
  const genesis = genesisHash(sessionId, 1, binding);
  const canonicalEvent = event(0, 'working-directory/change', { cwd: 'C:\\work\\app\\sub' });
  const chain = chainEvents(genesis, [canonicalEvent]);
  const row = batchRow(sessionId, 1, 0, { endSeq: 0, eventCount: 1, prevChainHash: genesis, chainHash: chain.chainHash, headHash: chain.headHash, payloadHash: chain.payloadHash });
  const manifest: StoredManifest = { entity: cloudSession({ sessionId, headerJson: JSON.stringify(header), headerHash: binding, eventCount: 1, chainHash: chain.chainHash, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1 }), etag: 'e' };
  const repository = {
    getManifest: async () => manifest, listBatchRows: async () => [row], readCandidate: async () => gzipSync(payloadBytes([canonicalEvent])),
  } as unknown as CloudRepository;
  const localEvent = event(0, 'working-directory/change', { cwd: join(realLocal, 'app', 'sub') });
  const f = fixture([localEvent], { cwdBinding: async () => ({ mapping: pathMapping({ remotePrefix: 'C:\\work', localPrefix: realLocal, remotePlatform: 'win32' }), fs: nodeCwdFs }) });
  (f.uploader as unknown as { deps: Record<string, unknown> }).deps['repository'] = repository;
  const record = localSession({ sessionId, imported: true, lastSyncedHeaderHash: binding, canonicalCwd: 'C:\\work\\app', localCwd: join(realLocal, 'app') });
  const canonical = await (f.uploader as unknown as { canonicalSnapshot(record: unknown, snapshot: unknown): Promise<{ header: { cwd?: string }; events: { data: { cwd?: string } }[] }> }).canonicalSnapshot(record, { header: { ...sessionHeader({ id: sessionId }), cwd: join(realLocal, 'app') }, inheritedEventCount: 0, events: [localEvent] });
  assert.equal(canonical.header.cwd, 'C:\\work\\app');
  assert.equal(canonical.events[0]?.data.cwd, 'C:\\work\\app\\sub');
});

test('retry adopts the longest verified next candidate across epochs and ignores invalid/divergent siblings', async () => {
  const f = fixture([]);
  await f.uploader.sync('session-test', { release: true });
  const manifest = f.repo.manifest!;
  const events = [event(0), event(1), event(2)];
  f.setEvents(events);
  const seed = (values: typeof events, count: number, epoch: number, corrupt = false) => {
    const plan = planBatch(values, 0, { maxEvents: count, maxBytes: 1_000_000 }, manifest.entity.chainHash)!;
    const name = candidateBlobName('session-test', 1, 0, epoch, plan.payloadHash);
    const metadata = batchBlobMetadata({ ...plan.chain, headerHash: manifest.entity.headerHash, generation: 1, createdEpoch: epoch, deviceId: 'old-device', schemaVersion: 4 });
    f.repo.blobs.set(name, { bytes: corrupt ? gzipSync(Buffer.from('invalid\n')) : plan.gzip, metadata: { ...metadata } });
    return name;
  };
  seed(events, 1, 1);
  const longest = seed(events, 2, 1);
  seed(events, 3, 5, true);
  seed([event(0, 'user/message', { text: 'unchosen' }), event(1), event(2)], 3, 7);
  const result = await f.uploader.sync('session-test', { release: true });
  assert.equal(result.uploadedBatches, 2);
  const committed = [...f.repo.rows.values()];
  assert.equal(committed[0]?.blobName, longest);
  assert.equal(committed[0]?.createdEpoch, 1);
  assert.equal(committed[0]?.deviceId, 'old-device');
  assert.equal(committed[1]?.startSeq, 2);
  assert.equal(f.repo.manifest?.entity.eventCount, 3);
  assert.equal(f.repo.manifest?.entity.writerEpoch, 2);
});

function cancellationGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function watchCancellation(f: ReturnType<typeof fixture>, signal: AbortSignal) {
  const cloudMutations: string[] = [];
  const localWrites: LocalSessionRecord[] = [];
  const create = f.repo.createManifest.bind(f.repo);
  f.repo.createManifest = async (entity) => {
    if (signal.aborted) cloudMutations.push('createManifest');
    return create(entity);
  };
  const update = f.repo.updateManifest.bind(f.repo);
  f.repo.updateManifest = async (entity, etag) => {
    if (signal.aborted) cloudMutations.push('updateManifest');
    return update(entity, etag);
  };
  const acquire = f.leases.acquire.bind(f.leases);
  f.leases.acquire = async (id) => {
    if (signal.aborted) cloudMutations.push('acquire');
    return acquire(id);
  };
  const put = f.local.putSession.bind(f.local);
  f.local.putSession = async (record) => {
    if (signal.aborted) localWrites.push(structuredClone(record));
    await put(record);
  };
  return { cloudMutations, localWrites };
}

const cancelled = (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED';

test('cancelled pre-write reads cannot create a manifest, acquire a lease, or publish local state', async (t) => {
  const phases = ['source-read', 'unmaterialized-read', 'canonical-binding', 'get-manifest', 'pre-create-parent-read'] as const;
  const cases = (['sync', 'ownership'] as const).flatMap((mode) => phases.map((phase) => ({ mode, phase })));
  for (const { mode, phase } of cases) {
    await t.test(`${mode}/${phase}`, async (t) => {
      const entered = cancellationGate();
      const release = cancellationGate();
      const controller = new AbortController();
      const f = fixture([event(0)], phase === 'canonical-binding' ? {
        cwdBinding: async () => { entered.resolve(); await release.promise; return undefined; },
      } : {});
      t.after(() => f.uploader.pause('session-test'));
      const audit = watchCancellation(f, controller.signal);
      const beforeLocal = structuredClone(f.local.get());
      if (phase === 'source-read' || phase === 'unmaterialized-read') {
        const read = f.source.read.bind(f.source);
        f.source.read = async (id) => {
          const result = phase === 'unmaterialized-read' ? undefined : await read(id);
          entered.resolve();
          await release.promise;
          return result;
        };
      } else if (phase === 'get-manifest') {
        const get = f.repo.getManifest.bind(f.repo);
        f.repo.getManifest = async () => {
          const result = await get();
          entered.resolve();
          await release.promise;
          return result;
        };
      } else if (phase === 'pre-create-parent-read') {
        f.source.read = async () => ({
          ...snapshot([event(0)]),
          header: sessionHeader({ id: 'session-test', origin: 'subagent', parentSession: 'parent-test' }) as never,
        });
        const get = f.repo.getManifest.bind(f.repo);
        f.repo.getManifest = async (id?: string) => {
          if (id !== 'parent-test') return get();
          const parent = { entity: cloudSession({ sessionId: 'parent-test', rootSessionId: 'parent-test', rootGeneration: 1 }), etag: 'parent-etag' };
          entered.resolve();
          await release.promise;
          return parent;
        };
      }
      const pending = mode === 'sync'
        ? f.uploader.sync('session-test', { signal: controller.signal })
        : f.uploader.ensureOwnership('session-test', controller.signal);
      const observed = pending.then(
        (result) => ({ owned: 'owned' in result ? result.owned : undefined, error: undefined }),
        (error: unknown) => ({ owned: undefined, error }),
      );
      await entered.promise;
      assert.equal(f.repo.manifest, undefined);
      controller.abort(new AzureSyncError('CANCELLED', 'Synthetic pre-write cancellation.'));
      release.resolve();
      const outcome = await observed;
      assert.ok(cancelled(outcome.error) || (mode === 'ownership' && outcome.owned === false), 'cancelled IO must reject sync or refuse ownership');
      assert.deepEqual(audit.cloudMutations, [], `cancelled ${phase} must not initiate a new cloud mutation`);
      assert.equal(f.repo.manifest, undefined);
      assert.equal(f.repo.rows.size, 0);
      assert.equal(f.repo.blobs.size, 0);
      assert.equal(f.leases.epoch, 0);
      assert.equal(f.leases.releases, 0);
      assert.equal(f.uploader.hasHeld('session-test'), false);
      assert.deepEqual(audit.localWrites, []);
      assert.deepEqual(f.local.get(), beforeLocal);
    });
  }
});

test('a lease accepted by the server but returned after sync cancellation is released exactly once', async (t) => {
  const f = fixture([event(0)]);
  t.after(() => f.uploader.pause('session-test'));
  const entered = cancellationGate();
  const release = cancellationGate();
  const controller = new AbortController();
  const audit = watchCancellation(f, controller.signal);
  const activeHandles = new Set<SessionLease['handle']>();
  const acquire = f.leases.acquire.bind(f.leases);
  f.leases.acquire = async (id) => {
    const lease = await acquire(id);
    activeHandles.add(lease.handle);
    entered.resolve();
    await release.promise;
    return lease;
  };
  const releaseLease = f.leases.release.bind(f.leases);
  f.leases.release = async (lease?: SessionLease) => {
    if (lease !== undefined) activeHandles.delete(lease.handle);
    await releaseLease();
  };
  const pending = f.uploader.sync('session-test', { signal: controller.signal });
  const rejection = assert.rejects(pending, cancelled);
  await entered.promise;
  assert.equal(f.repo.manifest?.entity.leaseOwner, 'device-a', 'the server has already granted ownership');
  assert.equal(activeHandles.size, 1);
  assert.equal(f.uploader.hasHeld('session-test'), false);
  controller.abort(new AzureSyncError('CANCELLED', 'Synthetic late acquisition cancellation.'));
  release.resolve();
  await rejection;
  assert.equal(f.leases.releases, 1);
  assert.equal(activeHandles.size, 0, 'the late grant cannot become an unreachable leaked resource');
  assert.equal(f.uploader.hasHeld('session-test'), false);
  assert.equal(f.repo.rows.size, 0);
  assert.equal(f.repo.blobs.size, 0);
  assert.deepEqual(audit.cloudMutations, [], 'only cleanup may occur after the accepted grant is cancelled');
  assert.deepEqual(audit.localWrites, []);
});

test('an aborted ownership proof cannot install a late held-lease renewal or publish syncing', async (t) => {
  const f = fixture([event(0)]);
  await f.uploader.sync('session-test', { release: false });
  t.after(() => f.uploader.pause('session-test'));
  const entered = cancellationGate();
  const release = cancellationGate();
  const controller = new AbortController();
  const audit = watchCancellation(f, controller.signal);
  const previousLocal = structuredClone(f.local.get());
  let lateRenewal: SessionLease | undefined;
  const renew = f.leases.renew.bind(f.leases);
  f.leases.renew = async (lease) => {
    const renewed = await renew(lease);
    lateRenewal = { ...renewed, manifest: { ...renewed.manifest, etag: 'late-proof-result' } };
    entered.resolve();
    await release.promise;
    return lateRenewal;
  };
  const observed = f.uploader.ensureOwnership('session-test', controller.signal).then(
    (proof) => ({ proof, error: undefined }),
    (error: unknown) => ({ proof: undefined, error }),
  );
  await entered.promise;
  controller.abort(new AzureSyncError('CANCELLED', 'Synthetic held proof cancellation.'));
  release.resolve();
  const outcome = await observed;
  assert.ok(outcome.proof?.owned === false || cancelled(outcome.error), 'an aborted proof must not grant execution');
  const held = (f.uploader as unknown as { held: Map<string, SessionLease> }).held.get('session-test');
  assert.notEqual(held, lateRenewal, 'late renewal must not overwrite retained lifecycle ownership');
  assert.equal(audit.localWrites.some((record) => record.status === 'syncing'), false);
  assert.deepEqual(f.local.get(), previousLocal, 'an aborted proof cannot publish stale state');
  assert.deepEqual(audit.cloudMutations, []);
});

function seedUncommittedCandidate(f: ReturnType<typeof fixture>, events: ReturnType<typeof event>[], deviceId: string): string {
  const manifest = f.repo.manifest;
  assert.ok(manifest);
  const plan = planBatch(events, 0, { maxEvents: events.length, maxBytes: 1_000_000 }, manifest.entity.chainHash);
  assert.ok(plan);
  const epoch = manifest.entity.writerEpoch;
  const name = candidateBlobName('session-test', 1, 0, epoch, plan.payloadHash);
  const metadata = batchBlobMetadata({
    ...plan.chain, headerHash: manifest.entity.headerHash, generation: 1, createdEpoch: epoch,
    deviceId, schemaVersion: 4,
  });
  f.repo.blobs.set(name, { bytes: plan.gzip, metadata: { ...metadata } });
  return name;
}

test('candidate adoption ignores an otherwise verified candidate whose device id cannot form a valid batch row', async (t) => {
  const f = fixture([]);
  t.after(() => f.uploader.pause('session-test'));
  await f.uploader.sync('session-test', { release: true });
  const events = [event(0), event(1)];
  const valid = seedUncommittedCandidate(f, events.slice(0, 1), 'previous-device');
  const malformed = seedUncommittedCandidate(f, events, 'x'.repeat(257));
  f.setEvents(events);
  const result = await f.uploader.sync('session-test', { release: true });
  assert.equal(result.status, 'synced');
  assert.equal(result.uploadedBatches, 2);
  const committed = [...f.repo.rows.values()];
  assert.equal(committed[0]?.blobName, valid, 'a malformed longest candidate must not displace a shorter valid candidate');
  assert.equal(committed.some((row) => row.blobName === malformed), false);
  assert.ok(committed.every((row) => batchRowSchema.safeParse(row).success), 'every adopted candidate must produce a schema-valid whole row');
  assert.equal(f.repo.blobs.has(malformed), true, 'unchosen candidate remains uncommitted, not destructively removed');
  assert.equal(f.repo.manifest?.entity.eventCount, events.length);
});

test('candidate adoption respects maxBatchEvents even when a longer exact candidate has valid hashes and metadata', async (t) => {
  const f = fixture([], { maxBatchEvents: 1 });
  t.after(() => f.uploader.pause('session-test'));
  await f.uploader.sync('session-test', { release: true });
  const events = [event(0), event(1), event(2)];
  const oversized = seedUncommittedCandidate(f, events, 'previous-device');
  f.setEvents(events);
  const result = await f.uploader.sync('session-test', { release: true });
  assert.equal(result.status, 'synced');
  assert.equal(result.uploadedBatches, 3);
  const committed = [...f.repo.rows.values()];
  assert.deepEqual(committed.map((row) => row.eventCount), [1, 1, 1]);
  assert.deepEqual(committed.map((row) => row.startSeq), [0, 1, 2]);
  assert.equal(committed.some((row) => row.blobName === oversized), false);
  assert.ok(committed.every((row) => batchRowSchema.safeParse(row).success));
  assert.equal(f.repo.blobs.has(oversized), true);
  assert.equal(f.repo.manifest?.entity.eventCount, events.length);
});
