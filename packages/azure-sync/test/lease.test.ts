import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionLeaseManager } from '../src/sync/lease-manager.js';
import type { CloudRepository, StoredManifest } from '../src/sync/cloud-repository.js';
import type { LeaseHandle, LeaseManager } from '../src/azure/lease.js';
import type { CloudSessionEntity } from '../src/schema.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { cloudSession } from './helpers.js';

class Repo {
  manifest: StoredManifest = { entity: cloudSession({ writerEpoch: 0 }), etag: 'etag-1' };
  async getManifest(): Promise<StoredManifest | undefined> { return structuredClone(this.manifest); }
  async updateManifest(entity: CloudSessionEntity, etag: string): Promise<void> {
    assert.equal(this.manifest.etag, etag);
    this.manifest = { entity: structuredClone(entity), etag: `etag-${Number(etag.slice(5)) + 1}` };
  }
}

class Leases {
  breaks = 0;
  acquires = 0;
  releases = 0;
  renews = 0;
  readonly durations: number[] = [];
  readonly handle = { client: {}, leaseId: 'lease-id' } as unknown as LeaseHandle;
  async acquire(_name?: string, seconds = 60): Promise<LeaseHandle> { this.acquires += 1; this.durations.push(seconds); return this.handle; }
  async renew(): Promise<void> { this.renews += 1; }
  async release(): Promise<void> { this.releases += 1; }
  async break(): Promise<void> { this.breaks += 1; }
}

for (const seconds of [30, 60] as const) test(`session lease ${seconds}s acquisition/takeover and renewal mirror match the raw requested duration`, async () => {
  const repo = new Repo(), leases = new Leases(); let now = 1000;
  const manager = new SessionLeaseManager({ repository: repo as unknown as CloudRepository, leases: leases as unknown as LeaseManager, deviceId: 'device-a', now: () => now });
  const first = await manager.acquire('session-test', undefined, seconds); assert.equal(first.durationSeconds, seconds); assert.deepEqual(leases.durations, [seconds]); assert.equal(first.manifest.entity.leaseUntil, now + seconds * 1000);
  now += 5000; const renewed = await manager.renew(first); assert.equal(renewed.durationSeconds, seconds); assert.equal(renewed.manifest.entity.leaseUntil, now + seconds * 1000);
  const taken = await manager.takeover('session-test', undefined, seconds); assert.equal(taken.durationSeconds, seconds); assert.deepEqual(leases.durations, [seconds, seconds]); assert.equal(taken.epoch, 2); await manager.release(taken);
});

test('session lease duration rejects arbitrary/infinite hints before any manifest read or lease break', async () => {
  const f = fixture(); let reads = 0; f.repo.getManifest = async () => { reads++; return f.repo.manifest; };
  for (const seconds of [-1, 0, 15, 45, Infinity, NaN]) {
    await assert.rejects(f.manager.acquire('session-test', undefined, seconds as 30), error => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
    await assert.rejects(f.manager.takeover('session-test', undefined, seconds as 30), error => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
  }
  assert.equal(reads, 0); assert.equal(f.leases.acquires, 0); assert.equal(f.leases.breaks, 0);
});

test('legacy unknown lease duration renews as active 60s rather than a cold downgrade', async () => {
  const f = fixture(), lease = await f.manager.acquire('session-test');
  const renewed = await f.manager.renew({ ...lease, durationSeconds: undefined }); assert.equal(renewed.manifest.entity.leaseUntil, 61000); assert.deepEqual(f.leases.durations, [60]);
});

test('lease acquisition advances the epoch and releases only the owning generation', async () => {
  const repo = new Repo();
  const leases = new Leases();
  let now = 1_000;
  const manager = new SessionLeaseManager({ repository: repo as unknown as CloudRepository, leases: leases as unknown as LeaseManager, deviceId: 'device-a', now: () => now });
  const first = await manager.acquire('session-test');
  assert.equal(first.epoch, 1);
  assert.equal(repo.manifest.entity.writerEpoch, 1);
  assert.equal(repo.manifest.entity.leaseOwner, 'device-a');
  assert.equal((await manager.proof('session-test', 1)).entity.writerEpoch, 1);
  now += 30_000;
  const renewed = await manager.renew(first);
  assert.equal(renewed.manifest.entity.leaseUntil, now + 60_000);
  await manager.release(first);
  assert.equal(repo.manifest.entity.leaseOwner, undefined);
  assert.equal(leases.releases, 1);
});

test('takeover breaks the old lease and fences the old epoch', async () => {
  const repo = new Repo();
  const leases = new Leases();
  let now = 1_000;
  const manager = new SessionLeaseManager({ repository: repo as unknown as CloudRepository, leases: leases as unknown as LeaseManager, deviceId: 'device-a', now: () => now });
  const first = await manager.acquire('session-test');
  const second = await manager.takeover('session-test');
  assert.equal(leases.breaks, 1);
  assert.equal(second.epoch, 2);
  await assert.rejects(manager.proof('session-test', first.epoch), (error: unknown) => error instanceof AzureSyncError && error.code === 'LEASE_LOST');
  now += 61_000;
  await assert.rejects(manager.proof('session-test', second.epoch), (error: unknown) => error instanceof AzureSyncError && error.code === 'LEASE_LOST');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const repo = new Repo();
  const leases = new Leases();
  const manager = new SessionLeaseManager({ repository: repo as unknown as CloudRepository, leases: leases as unknown as LeaseManager,
    deviceId: 'device-a', now: () => 1_000 });
  return { repo, leases, manager };
}

const cancelled = (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED';

test('pre-cancelled acquisition performs no read, raw acquire, or epoch mutation', async () => {
  const { repo, leases, manager } = fixture();
  let reads = 0;
  const read = repo.getManifest.bind(repo);
  repo.getManifest = async () => { reads++; return read(); };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(manager.acquire('session-test', controller.signal), cancelled);
  assert.equal(reads, 0);
  assert.equal(leases.acquires, 0);
  assert.equal(repo.manifest.entity.writerEpoch, 0);
});

test('a never-settling initial manifest read is promptly cancellable and its late result cannot acquire', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const read = deferred<StoredManifest | undefined>();
  const entered = deferred<void>();
  repo.getManifest = async () => { entered.resolve(); return read.promise; };
  const controller = new AbortController();
  const acquired = manager.acquire('session-test', controller.signal);
  const rejected = assert.rejects(acquired, cancelled);
  await entered.promise;
  controller.abort();
  await rejected;
  read.resolve(repo.manifest);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(leases.acquires, 0);
  assert.equal(repo.manifest.entity.writerEpoch, 0);
});

test('a raw acquire that finishes after cancellation is released without advancing the epoch', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const raw = deferred<LeaseHandle>();
  const entered = deferred<void>();
  const released = deferred<void>();
  leases.acquire = async () => { leases.acquires++; entered.resolve(); return raw.promise; };
  leases.release = async () => { leases.releases++; released.resolve(); };
  const controller = new AbortController();
  const acquired = manager.acquire('session-test', controller.signal);
  const rejected = assert.rejects(acquired, cancelled);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(leases.releases, 0, 'no handle exists before the late acquire response');
  raw.resolve(leases.handle);
  await released.promise;
  assert.equal(leases.releases, 1);
  assert.equal(repo.manifest.entity.writerEpoch, 0);
  assert.equal(repo.manifest.entity.leaseOwner, undefined);
});

test('cancellation during an accepted epoch write releases immediately and clears a late owned mirror', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const cleared = deferred<void>();
  const update = repo.updateManifest.bind(repo);
  repo.updateManifest = async (entity, etag) => {
    if (entity.leaseOwner !== undefined) { entered.resolve(); await gate.promise; }
    await update(entity, etag);
    if (entity.leaseOwner === undefined) cleared.resolve();
  };
  const controller = new AbortController();
  const acquired = manager.acquire('session-test', controller.signal);
  const rejected = assert.rejects(acquired, cancelled);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(leases.releases, 1, 'release must not wait for the epoch write response');
  gate.resolve();
  await cleared.promise;
  assert.equal(repo.manifest.entity.writerEpoch, 1);
  assert.equal(repo.manifest.entity.leaseOwner, undefined);
  assert.equal(repo.manifest.entity.leaseUntil, undefined);
});

test('cancellation during the final manifest read releases the raw lease without awaiting that read', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const final = deferred<StoredManifest | undefined>();
  const entered = deferred<void>();
  const cleared = deferred<void>();
  const read = repo.getManifest.bind(repo);
  const update = repo.updateManifest.bind(repo);
  let reads = 0;
  repo.getManifest = async () => {
    if (++reads === 2) { entered.resolve(); return final.promise; }
    return read();
  };
  repo.updateManifest = async (entity, etag) => { await update(entity, etag); if (entity.leaseOwner === undefined) cleared.resolve(); };
  const controller = new AbortController();
  const acquired = manager.acquire('session-test', controller.signal);
  const rejected = assert.rejects(acquired, cancelled);
  await entered.promise;
  const owned = structuredClone(repo.manifest);
  controller.abort();
  await rejected;
  assert.equal(leases.releases, 1);
  await cleared.promise;
  final.resolve(owned);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(repo.manifest.entity.leaseOwner, undefined);
  assert.equal(leases.acquires, 1);
});

for (const finalRead of ['missing', 'error'] as const) {
  test(`a ${finalRead} final manifest after epoch publication releases and clears only its owned mirror`, { timeout: 1_000 }, async () => {
    const { repo, leases, manager } = fixture();
    const cleared = deferred<void>();
    const read = repo.getManifest.bind(repo);
    const update = repo.updateManifest.bind(repo);
    let reads = 0;
    repo.getManifest = async () => {
      if (++reads === 2) {
        if (finalRead === 'error') throw new AzureSyncError('TRANSIENT', 'injected final read');
        return undefined;
      }
      return read();
    };
    repo.updateManifest = async (entity, etag) => { await update(entity, etag); if (entity.leaseOwner === undefined) cleared.resolve(); };
    await assert.rejects(manager.acquire('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === (finalRead === 'error' ? 'TRANSIENT' : 'CORRUPT_REMOTE'));
    assert.equal(leases.releases, 1);
    await cleared.promise;
    assert.equal(repo.manifest.entity.writerEpoch, 1);
    assert.equal(repo.manifest.entity.leaseOwner, undefined);
  });
}

test('cancellation cleanup never clears a newer owner or epoch', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const final = deferred<StoredManifest | undefined>();
  const entered = deferred<void>();
  const read = repo.getManifest.bind(repo);
  let reads = 0;
  repo.getManifest = async () => {
    if (++reads === 2) { entered.resolve(); return final.promise; }
    return read();
  };
  const controller = new AbortController();
  const acquired = manager.acquire('session-test', controller.signal);
  const rejected = assert.rejects(acquired, cancelled);
  await entered.promise;
  repo.manifest = { entity: { ...repo.manifest.entity, writerEpoch: 2, leaseOwner: 'device-b' }, etag: 'new-owner-etag' };
  controller.abort();
  await rejected;
  assert.equal(leases.releases, 1);
  final.resolve(repo.manifest);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(repo.manifest.entity.writerEpoch, 2);
  assert.equal(repo.manifest.entity.leaseOwner, 'device-b');
});

test('renew cancellation during a stalled proof never renews raw lease or publishes a deadline', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const lease = await manager.acquire('session-test');
  const proof = deferred<StoredManifest | undefined>();
  const entered = deferred<void>();
  const cleared = deferred<void>();
  const read = repo.getManifest.bind(repo);
  const update = repo.updateManifest.bind(repo);
  let reads = 0;
  let extendingWrites = 0;
  repo.getManifest = async () => { if (++reads === 1) { entered.resolve(); return proof.promise; } return read(); };
  repo.updateManifest = async (entity, etag) => {
    if (entity.leaseOwner !== undefined) extendingWrites++;
    await update(entity, etag);
    if (entity.leaseOwner === undefined) cleared.resolve();
  };
  const controller = new AbortController();
  const renewed = manager.renew(lease, controller.signal);
  const rejected = assert.rejects(renewed, cancelled);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(leases.releases, 1);
  await cleared.promise;
  proof.resolve(lease.manifest);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(leases.renews, 0);
  assert.equal(extendingWrites, 0);
  assert.equal(repo.manifest.entity.leaseOwner, undefined);
});

test('raw release is not blocked by a never-settling best-effort cleanup mirror read', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const blocked = deferred<StoredManifest | undefined>();
  const entered = deferred<void>();
  const cleared = deferred<void>();
  const read = repo.getManifest.bind(repo);
  const update = repo.updateManifest.bind(repo);
  let reads = 0;
  repo.getManifest = async () => {
    if (++reads >= 2) { entered.resolve(); return blocked.promise; }
    return read();
  };
  repo.updateManifest = async (entity, etag) => { await update(entity, etag); if (entity.leaseOwner === undefined) cleared.resolve(); };
  const controller = new AbortController();
  const acquired = manager.acquire('session-test', controller.signal);
  const rejected = assert.rejects(acquired, cancelled);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(leases.releases, 1, 'cleanup getManifest must not precede raw release');
  assert.ok(reads >= 3, 'best-effort cleanup was attempted despite not delaying cancellation');
  blocked.resolve(repo.manifest);
  await cleared.promise;
  assert.equal(repo.manifest.entity.leaseOwner, undefined);
});

test('renew cancellation after an accepted deadline write clears its mirror without returning a late renewed lease', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const lease = await manager.acquire('session-test');
  const gate = deferred<void>();
  const entered = deferred<void>();
  const cleared = deferred<void>();
  const update = repo.updateManifest.bind(repo);
  let extendingWrites = 0;
  repo.updateManifest = async (entity, etag) => {
    await update(entity, etag);
    if (entity.leaseOwner !== undefined) { extendingWrites++; entered.resolve(); await gate.promise; }
    else cleared.resolve();
  };
  const controller = new AbortController();
  const renewed = manager.renew(lease, controller.signal);
  const rejected = assert.rejects(renewed, cancelled);
  await entered.promise;
  controller.abort();
  await rejected;
  await cleared.promise;
  gate.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(leases.releases, 1);
  assert.equal(leases.renews, 1);
  assert.equal(extendingWrites, 1, 'only the request accepted before cancellation may extend the mirror');
  assert.equal(repo.manifest.entity.leaseOwner, undefined);
});

test('renew cancellation in its final manifest read releases and never returns the late proof', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const lease = await manager.acquire('session-test');
  const final = deferred<StoredManifest | undefined>();
  const entered = deferred<void>();
  const cleared = deferred<void>();
  const read = repo.getManifest.bind(repo);
  const update = repo.updateManifest.bind(repo);
  let reads = 0;
  repo.getManifest = async () => { if (++reads === 2) { entered.resolve(); return final.promise; } return read(); };
  repo.updateManifest = async (entity, etag) => { await update(entity, etag); if (entity.leaseOwner === undefined) cleared.resolve(); };
  const controller = new AbortController();
  const renewed = manager.renew(lease, controller.signal);
  const rejected = assert.rejects(renewed, cancelled);
  await entered.promise;
  const oldProof = structuredClone(repo.manifest);
  controller.abort();
  await rejected;
  await cleared.promise;
  final.resolve(oldProof);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(leases.releases, 1);
  assert.equal(leases.renews, 1);
  assert.equal(repo.manifest.entity.leaseOwner, undefined);
});

test('late raw renewal after cancellation releases again rather than restoring ownership', { timeout: 1_000 }, async () => {
  const { repo, leases, manager } = fixture();
  const lease = await manager.acquire('session-test');
  const gate = deferred<void>();
  const entered = deferred<void>();
  const releasedAgain = deferred<void>();
  leases.renew = async () => { leases.renews++; entered.resolve(); await gate.promise; };
  leases.release = async () => { leases.releases++; if (leases.releases === 2) releasedAgain.resolve(); };
  const controller = new AbortController();
  const renewed = manager.renew(lease, controller.signal);
  const rejected = assert.rejects(renewed, cancelled);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(leases.releases, 1);
  gate.resolve();
  await releasedAgain.promise;
  assert.equal(leases.renews, 1);
  assert.equal(repo.manifest.entity.leaseOwner, undefined);
});
