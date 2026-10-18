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
  readonly handle = { client: {}, leaseId: 'lease-id' } as unknown as LeaseHandle;
  async acquire(): Promise<LeaseHandle> { this.acquires += 1; return this.handle; }
  async renew(): Promise<void> {}
  async release(): Promise<void> { this.releases += 1; }
  async break(): Promise<void> { this.breaks += 1; }
}

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
