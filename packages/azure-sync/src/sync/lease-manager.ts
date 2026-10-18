/**
 * Session ownership: a 60-second Blob lease plus a monotonically advancing
 * manifest epoch. Every execution step re-reads the server proof; no cached
 * TTL grants write authority.
 * @module @1yefuwang1/dsh-azure-sync/sync/lease-manager
 */
import { AzureSyncError } from '../azure/errors.js';
import type { LeaseHandle, LeaseManager } from '../azure/lease.js';
import type { CloudSessionEntity } from '../schema.js';
import type { CloudRepository, StoredManifest } from './cloud-repository.js';
import { leaseBlobName } from './cloud-repository.js';

export interface SessionLease {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly epoch: number;
  readonly handle: LeaseHandle;
  readonly manifest: StoredManifest;
}

export interface LeaseDependencies {
  readonly repository: CloudRepository;
  readonly leases: LeaseManager;
  readonly deviceId: string;
  readonly now: () => number;
  readonly leaseSeconds?: number;
}


export class SessionLeaseManager {
  private readonly deps: LeaseDependencies;

  constructor(deps: LeaseDependencies) {
    this.deps = deps;
  }

  private get leaseMs(): number {
    return (this.deps.leaseSeconds ?? 60) * 1_000;
  }

  /** Acquire the Blob lease, advance the epoch, and persist both server-side. */
  async acquire(sessionId: string, signal?: AbortSignal): Promise<SessionLease> {
    const before = await this.deps.repository.getManifest(sessionId);
    if (before === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud session manifest does not exist.');
    const handle = await this.deps.leases.acquire(leaseBlobName(sessionId), this.deps.leaseSeconds ?? 60);
    if (signal?.aborted) {
      await this.deps.leases.release(handle).catch(() => undefined);
      throw new AzureSyncError('CANCELLED', 'Lease acquisition was cancelled.');
    }
    const epoch = before.entity.writerEpoch + 1;
    const now = this.deps.now();
    const entity: CloudSessionEntity = {
      ...before.entity,
      writerEpoch: epoch,
      leaseOwner: this.deps.deviceId,
      leaseUntil: now + this.leaseMs,
      lastWriterDevice: this.deps.deviceId,
      updatedAt: now,
    };
    try {
      await this.deps.repository.updateManifest(entity, before.etag);
    } catch (error) {
      await this.deps.leases.release(handle).catch(() => undefined);
      throw error;
    }
    const manifest = await this.deps.repository.getManifest(sessionId);
    if (manifest === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud session manifest disappeared after lease acquisition.');
    return { sessionId, deviceId: this.deps.deviceId, epoch, handle, manifest };
  }

  /** Renew the Blob lease and mirror the deadline; ownership is re-read first. */
  async renew(lease: SessionLease): Promise<SessionLease> {
    await this.deps.leases.renew(lease.handle);
    const proof = await this.proof(lease.sessionId, lease.epoch);
    const now = this.deps.now();
    const entity: CloudSessionEntity = { ...proof.entity, leaseUntil: now + this.leaseMs, updatedAt: now };
    await this.deps.repository.updateManifest(entity, proof.etag);
    const manifest = await this.deps.repository.getManifest(lease.sessionId);
    if (manifest === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud session manifest disappeared after lease renewal.');
    return { ...lease, manifest };
  }

  /** Release the lease and clear the mirror only if this epoch still owns it. */
  async release(lease: SessionLease): Promise<void> {
    try {
      const current = await this.deps.repository.getManifest(lease.sessionId);
      if (current !== undefined && current.entity.leaseOwner === this.deps.deviceId && current.entity.writerEpoch === lease.epoch) {
        const entity: CloudSessionEntity = { ...current.entity, leaseOwner: undefined, leaseUntil: undefined, updatedAt: this.deps.now() };
        await this.deps.repository.updateManifest(entity, current.etag);
      }
    } finally {
      await this.deps.leases.release(lease.handle).catch(() => undefined);
    }
  }

  /** Explicit takeover: break any old lease, then acquire a fresh epoch. */
  async takeover(sessionId: string): Promise<SessionLease> {
    await this.deps.leases.break(leaseBlobName(sessionId));
    return this.acquire(sessionId);
  }

  /** Server proof for one step; never cache this result across steps. */
  async proof(sessionId: string, epoch: number): Promise<StoredManifest> {
    const manifest = await this.deps.repository.getManifest(sessionId);
    if (manifest === undefined) throw new AzureSyncError('LEASE_LOST', 'The cloud session manifest no longer exists.');
    const entity = manifest.entity;
    if (entity.leaseOwner !== this.deps.deviceId || entity.writerEpoch !== epoch) {
      throw new AzureSyncError('LEASE_LOST', 'Another device owns the cloud session writer lease.');
    }
    if (entity.leaseUntil === undefined || entity.leaseUntil <= this.deps.now()) {
      throw new AzureSyncError('LEASE_LOST', 'The cloud session writer lease has expired.');
    }
    return manifest;
  }
}
