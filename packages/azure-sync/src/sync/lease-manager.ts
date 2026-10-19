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

export type SessionLeaseSeconds = 30 | 60;
export function validateSessionLeaseSeconds(value: unknown): SessionLeaseSeconds {
  if (value !== 30 && value !== 60) throw new AzureSyncError('INVALID_RECORD', 'Session leases must last 30 or 60 seconds.');
  return value;
}

export interface SessionLease {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly epoch: number;
  readonly handle: LeaseHandle;
  readonly manifest: StoredManifest;
  /** Ephemeral duration only; absent legacy handles are conservatively active/60s. */
  readonly durationSeconds?: SessionLeaseSeconds;
}

export interface LeaseDependencies {
  readonly repository: CloudRepository;
  readonly leases: LeaseManager;
  readonly deviceId: string;
  readonly now: () => number;
  readonly leaseSeconds?: SessionLeaseSeconds;
}


export class SessionLeaseManager {
  private readonly deps: LeaseDependencies;

  constructor(deps: LeaseDependencies) {
    this.deps = deps;
  }

  private check(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AzureSyncError('CANCELLED', 'The lease operation was cancelled.');
  }

  /** Bound cancellation even when an SDK transport ignores its caller's signal. */
  private wait<T>(operation: () => Promise<T>, signal?: AbortSignal, late?: (value: T) => void, lateError?: () => void): Promise<T> {
    this.check(signal);
    if (signal === undefined) return operation();
    return new Promise<T>((resolve, reject) => {
      let cancelled = false;
      let settled = false;
      const abort = () => {
        if (settled) return;
        cancelled = true;
        signal.removeEventListener('abort', abort);
        reject(new AzureSyncError('CANCELLED', 'The lease operation was cancelled.'));
      };
      signal.addEventListener('abort', abort, { once: true });
      let pending: Promise<T>;
      try { pending = operation(); }
      catch (error) { signal.removeEventListener('abort', abort); reject(error); return; }
      void pending.then((value) => {
        signal.removeEventListener('abort', abort);
        settled = true;
        if (cancelled) { late?.(value); return; }
        resolve(value);
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort);
        settled = true;
        if (cancelled) { lateError?.(); return; }
        reject(error);
      });
      if (signal.aborted) abort();
    });
  }

  private async clearOwnedMirror(sessionId: string, epoch: number): Promise<void> {
    try {
      const current = await this.deps.repository.getManifest(sessionId);
      if (current?.entity.leaseOwner !== this.deps.deviceId || current.entity.writerEpoch !== epoch) return;
      await this.deps.repository.updateManifest({ ...current.entity, leaseOwner: undefined, leaseUntil: undefined, updatedAt: this.deps.now() }, current.etag);
    } catch { /* Best effort: a changed epoch/ETag must never be cleared. */ }
  }

  /** Start release BEFORE any potentially stalled mirror read; never delay cancellation. */
  private abandon(handle: LeaseHandle, sessionId?: string, epoch?: number): void {
    void this.deps.leases.release(handle).catch(() => undefined);
    if (sessionId !== undefined && epoch !== undefined) void this.clearOwnedMirror(sessionId, epoch);
  }

  private assertProof(manifest: StoredManifest | undefined, epoch: number): asserts manifest is StoredManifest {
    if (manifest === undefined) throw new AzureSyncError('LEASE_LOST', 'The cloud session manifest no longer exists.');
    const entity = manifest.entity;
    if (entity.leaseOwner !== this.deps.deviceId || entity.writerEpoch !== epoch) {
      throw new AzureSyncError('LEASE_LOST', 'Another device owns the cloud session writer lease.');
    }
    if (entity.leaseUntil === undefined || entity.leaseUntil <= this.deps.now()) {
      throw new AzureSyncError('LEASE_LOST', 'The cloud session writer lease has expired.');
    }
  }

  /** Acquire the Blob lease, advance the epoch, and persist both server-side. */
  async acquire(sessionId: string, signal?: AbortSignal, requestedSeconds?: SessionLeaseSeconds): Promise<SessionLease> {
    const durationSeconds = validateSessionLeaseSeconds(requestedSeconds ?? this.deps.leaseSeconds ?? 60);
    this.check(signal);
    const before = await this.wait(() => this.deps.repository.getManifest(sessionId), signal);
    this.check(signal);
    if (before === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud session manifest does not exist.');
    if (before.entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The cloud session has been removed.');
    let handle: LeaseHandle | undefined;
    let epoch: number | undefined;
    let accepted = false;
    try {
      // The finally owns every acquired handle immediately. If cancellation wins
      // while the raw acquire is pending, its late fulfillment owns cleanup.
      handle = await this.wait(() => this.deps.leases.acquire(leaseBlobName(sessionId), durationSeconds),
        signal, (lateHandle) => this.abandon(lateHandle));
      this.check(signal);
      epoch = before.entity.writerEpoch + 1;
      const now = this.deps.now();
      const entity: CloudSessionEntity = {
        ...before.entity, writerEpoch: epoch, leaseOwner: this.deps.deviceId,
        leaseUntil: now + durationSeconds * 1_000, lastWriterDevice: this.deps.deviceId, updatedAt: now,
      };
      const clearLateMirror = () => { if (epoch !== undefined) void this.clearOwnedMirror(sessionId, epoch); };
      this.check(signal);
      await this.wait(() => this.deps.repository.updateManifest(entity, before.etag), signal, clearLateMirror, clearLateMirror);
      this.check(signal);
      const manifest = await this.wait(() => this.deps.repository.getManifest(sessionId), signal);
      this.check(signal);
      if (manifest === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud session manifest disappeared after lease acquisition.');
      this.assertProof(manifest, epoch);
      if (manifest.entity.generation !== before.entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed during lease acquisition.');
      this.check(signal);
      accepted = true;
      return { sessionId, deviceId: this.deps.deviceId, epoch, handle, manifest, durationSeconds };
    } finally {
      if (!accepted && handle !== undefined) this.abandon(handle, sessionId, epoch);
    }
  }

  /** Prove ownership before renewal; every transport boundary is cancellation-fenced. */
  async renew(lease: SessionLease, signal?: AbortSignal): Promise<SessionLease> {
    const durationSeconds = validateSessionLeaseSeconds(lease.durationSeconds ?? 60);
    let accepted = false;
    try {
      this.check(signal);
      const proof = await this.proof(lease.sessionId, lease.epoch, signal);
      this.check(signal);
      await this.wait(() => this.deps.leases.renew(lease.handle), signal,
        () => this.abandon(lease.handle, lease.sessionId, lease.epoch));
      this.check(signal);
      const now = this.deps.now();
      const entity: CloudSessionEntity = { ...proof.entity, leaseUntil: now + durationSeconds * 1_000, updatedAt: now };
      const clearLateMirror = () => { void this.clearOwnedMirror(lease.sessionId, lease.epoch); };
      this.check(signal);
      await this.wait(() => this.deps.repository.updateManifest(entity, proof.etag), signal, clearLateMirror, clearLateMirror);
      this.check(signal);
      const manifest = await this.wait(() => this.deps.repository.getManifest(lease.sessionId), signal);
      this.check(signal);
      if (manifest === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud session manifest disappeared after lease renewal.');
      this.assertProof(manifest, lease.epoch);
      if (manifest.entity.generation !== lease.manifest.entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed during lease renewal.');
      this.check(signal);
      accepted = true;
      return { ...lease, manifest };
    } finally {
      if (!accepted) this.abandon(lease.handle, lease.sessionId, lease.epoch);
    }
  }

  /** Release the lease and clear the mirror only if this epoch still owns it. */
  async release(lease: SessionLease): Promise<void> {
    // Relinquish the actual capability independently of a potentially stalled
    // best-effort mirror read; the mirror is never execution authority.
    const released = this.deps.leases.release(lease.handle).catch(() => undefined);
    try {
      const current = await this.deps.repository.getManifest(lease.sessionId);
      if (current !== undefined && current.entity.leaseOwner === this.deps.deviceId && current.entity.writerEpoch === lease.epoch) {
        const entity: CloudSessionEntity = { ...current.entity, leaseOwner: undefined, leaseUntil: undefined, updatedAt: this.deps.now() };
        await this.deps.repository.updateManifest(entity, current.etag);
      }
    } finally {
      await released;
    }
  }

  /** Explicit takeover: break any old lease, then acquire a fresh epoch. */
  async takeover(sessionId: string, signal?: AbortSignal, requestedSeconds?: SessionLeaseSeconds): Promise<SessionLease> {
    const durationSeconds = validateSessionLeaseSeconds(requestedSeconds ?? this.deps.leaseSeconds ?? 60);
    this.check(signal);
    await this.wait(() => this.deps.leases.break(leaseBlobName(sessionId)), signal);
    this.check(signal);
    return this.acquire(sessionId, signal, durationSeconds);
  }

  /** Server proof for one step; never cache this result across steps. */
  async proof(sessionId: string, epoch: number, signal?: AbortSignal): Promise<StoredManifest> {
    this.check(signal);
    const manifest = await this.wait(() => this.deps.repository.getManifest(sessionId), signal);
    this.check(signal);
    this.assertProof(manifest, epoch);
    return manifest;
  }
}
