/**
 * Crash-safe incremental uploader. Candidate blobs are immutable and written
 * before the atomic batch-row/tip transaction; a retry re-reads the committed
 * tip and never trusts a cached event count.
 * @module @1yefuwang1/dsh-azure-sync/sync/uploader
 */
import { gunzipSync } from 'node:zlib';
import type { AzureSyncConfig } from '../config.js';
import { AzureSyncError } from '../azure/errors.js';
import type { LocalStore } from '../local/store.js';
import {
  batchRowKey, sessionRowKey, type BatchRow, type CloudSessionEntity, type LocalSessionRecord,
  type Platform, type SyncStatus,
} from '../schema.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { chainEvents, genesisHash, headerHash } from './chain.js';
import { planBatch } from './batcher.js';
import { checkGuards } from './guards.js';
import { batchBlobMetadata } from './blob-metadata.js';
import { candidateBlobName, type CloudRepository, type StoredManifest } from './cloud-repository.js';
import type { SessionLease, SessionLeaseManager } from './lease-manager.js';
import type { SessionSource, SourceSnapshot } from './session-source.js';
import { canonicalizeLocalEvents, localToRemote, type CwdBinding } from './effective-cwd.js';
import { DrainCoordinator } from './drain-coordinator.js';
import { collectAttachmentReferences, type AttachmentSync } from './attachments.js';
import { remoteToLocal, verifyImportedProvenance } from './effective-cwd.js';
import { RemoteSessionReader } from './remote-session.js';
import type { DrainSnapshot } from './lease-drain.js';

export interface UploadDependencies {
  readonly config: AzureSyncConfig;
  readonly source: SessionSource;
  readonly repository: CloudRepository;
  readonly leases: SessionLeaseManager;
  readonly local: LocalStore;
  readonly deviceId: string;
  readonly platform: Platform;
  readonly now: () => number;
  readonly renewEveryMs?: number;
  readonly cwdBinding?: (sessionId: string, record: LocalSessionRecord) => Promise<CwdBinding | undefined>;
  readonly attachments?: AttachmentSync;
}

export interface UploadSummary {
  readonly status: 'disabled' | 'pending-materialization' | 'synced';
  readonly eventCount: number;
  readonly uploadedBatches: number;
}

export interface UploadOptions {
  /** Release the lease after a manual sync; the lifecycle drain owns release otherwise. */
  readonly release?: boolean;
  /** Explicit enable intent may revive a remotely disabled manifest. */
  readonly resume?: boolean;
}

export interface OwnershipProof {
  readonly owned: boolean;
  readonly reason?: 'paused-other-device' | 'ownership-unverified' | 'remote-ahead-live' | 'generation-changed' | 'removed-remotely';
}

export type DrainResult = 'released' | 'kept' | 'not-ready';

const STATUS_BY_CODE: Partial<Record<string, SyncStatus>> = {
  NO_CWD: 'no-cwd', SCHEDULE_UNSAFE: 'schedule-unsafe', PRESET_MISSING: 'preset-missing',
  LEASE_LOST: 'lease-lost', OWNERSHIP_UNVERIFIED: 'ownership-unverified', PRECONDITION: 'conflict',
  CONFLICT: 'conflict', AUTH_FAILED: 'auth-error', THROTTLED: 'retrying', TRANSIENT: 'retrying',
  LIMIT: 'degraded', CORRUPT_REMOTE: 'corrupt-remote', COMMITTED_INDEX_CORRUPT: 'committed-index-corrupt',
  UNMAPPABLE_CWD: 'cwd-unmappable', MAPPING_UNSTABLE: 'mapping-unstable', NEEDS_FOLDER: 'needs-folder',
  DISABLED: 'detached', GENERATION_CHANGED: 'generation-changed',
};

function initialLocal(sessionId: string): LocalSessionRecord {
  return {
    sessionId, enabled: true, generation: 1, writerEpoch: 0, state: 'active', status: 'pending-materialization',
    remapped: false, needsFolder: false, unmappablePaths: [], mappingUnstable: false,
    degradedAttachments: [], degradedAcknowledged: false, imported: false, weArchived: false, detached: false,
  };
}

export class Uploader {
  private readonly deps: UploadDependencies;
  private readonly held = new Map<string, SessionLease>();
  private readonly renewals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly drains = new DrainCoordinator();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly intents = new Map<string, number>();
  private readonly operations = new Map<number, { sessionId: string; intent: number; aborted: boolean }>();
  private nextOperation = 1;

  constructor(deps: UploadDependencies) {
    this.deps = deps;
  }

  private beginOperation(sessionId: string): number {
    const token = this.nextOperation++;
    if (!this.intents.has(sessionId)) this.intents.set(sessionId, 0);
    this.operations.set(token, { sessionId, intent: this.intents.get(sessionId) ?? 0, aborted: false });
    return token;
  }

  private finishOperation(token: number): void {
    this.operations.delete(token);
  }

  private bumpIntent(sessionId: string): void {
    this.intents.set(sessionId, (this.intents.get(sessionId) ?? 0) + 1);
    for (const [token, operation] of this.operations) {
      if (operation.sessionId === sessionId) this.operations.set(token, { ...operation, aborted: true });
    }
  }

  /** Invalidate every older user intent and all work currently queued for it. */
  abortOperation(sessionId: string): void {
    this.bumpIntent(sessionId);
  }

  private operationAborted(sessionId: string, token: number): boolean {
    if (token === 0) return false;
    const operation = this.operations.get(token);
    return operation === undefined || operation.aborted || operation.sessionId !== sessionId ||
      operation.intent !== (this.intents.get(sessionId) ?? 0);
  }

  private assertOperation(sessionId: string, token: number): void {
    if (token === 0) return;
    if (this.operationAborted(sessionId, token)) throw new AzureSyncError('CANCELLED', 'The sync operation was invalidated.');
  }

  private exclusive<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(sessionId, run.then(() => undefined, () => undefined));
    return run;
  }

  private clearRenewal(sessionId: string): void {
    const timer = this.renewals.get(sessionId);
    if (timer !== undefined) clearInterval(timer);
    this.renewals.delete(sessionId);
  }

  private holdLease(lease: SessionLease): void {
    this.held.set(lease.sessionId, lease);
    this.drains.hold(lease);
    if (this.renewals.has(lease.sessionId)) return;
    const timer = setInterval(() => {
      void (async () => {
        const current = this.held.get(lease.sessionId);
        if (current === undefined || current.epoch !== lease.epoch || !this.renewals.has(lease.sessionId)) return;
        try {
          const renewed = await this.deps.leases.renew(current);
          const after = this.held.get(lease.sessionId);
          if (after?.epoch === lease.epoch && this.renewals.has(lease.sessionId)) this.held.set(lease.sessionId, renewed);
        } catch {
          const after = this.held.get(lease.sessionId);
          if (after?.epoch === lease.epoch) this.releaseHeld(lease.sessionId);
        }
      })();
    }, this.deps.renewEveryMs ?? 30_000);
    timer.unref?.();
    this.renewals.set(lease.sessionId, timer);
  }

  private releaseHeld(sessionId: string): SessionLease | undefined {
    this.clearRenewal(sessionId);
    this.drains.forget(sessionId);
    const lease = this.held.get(sessionId);
    this.held.delete(sessionId);
    return lease;
  }

  private async update(record: LocalSessionRecord, patch: Partial<LocalSessionRecord>): Promise<LocalSessionRecord> {
    const current = this.deps.local.getSession(record.sessionId) ?? record;
    const next = { ...current, ...patch, lastAttemptAt: this.deps.now() };
    await this.deps.local.putSession(next);
    return next;
  }

  private async pending(sessionId: string): Promise<UploadSummary> {
    const record = this.deps.local.getSession(sessionId) ?? initialLocal(sessionId);
    await this.update(record, { status: 'pending-materialization', lastError: undefined });
    return { status: 'pending-materialization', eventCount: 0, uploadedBatches: 0 };
  }

  /** Toggle on: record the opt-in before any cloud work. */
  async enable(sessionId: string): Promise<UploadSummary> {
    const token = this.beginOperation(sessionId);
    try {
      return await this.exclusive(sessionId, async () => {
        this.assertOperation(sessionId, token);
        await this.markEnabledImpl(sessionId);
        this.assertOperation(sessionId, token);
        return this.syncImpl(sessionId, { resume: true }, token);
      });
    } finally { this.finishOperation(token); }
  }

  /** Stamp an explicit opt-in at API entry, then persist it before network setup. */
  async beginEnableIntent(sessionId: string): Promise<number> {
    const token = this.beginOperation(sessionId);
    try {
      await this.exclusive(sessionId, async () => {
        this.assertOperation(sessionId, token);
        await this.markEnabledImpl(sessionId);
      });
      return token;
    } catch (error) {
      this.finishOperation(token);
      throw error;
    }
  }

  /** Continue an explicit enable intent after service-level infrastructure setup. */
  async syncWithIntent(sessionId: string, token: number): Promise<UploadSummary> {
    try { return await this.exclusive(sessionId, () => this.syncImpl(sessionId, { resume: true }, token)); }
    finally { this.finishOperation(token); }
  }

  /** Durably opt in and return the intent token used by the caller's later sync. */
  async markEnabled(sessionId: string): Promise<void> {
    const token = this.beginOperation(sessionId);
    try {
      await this.exclusive(sessionId, async () => { this.assertOperation(sessionId, token); await this.markEnabledImpl(sessionId); });
    } finally { this.finishOperation(token); }
  }

  private async markEnabledImpl(sessionId: string): Promise<void> {
    const record = this.deps.local.getSession(sessionId) ?? initialLocal(sessionId);
    await this.update(record, { enabled: true, state: 'active', status: 'syncing', lastError: undefined });
  }

  /** Release every held lifecycle lease during plugin teardown. */
  async close(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    const wait = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
    const controlled = new Set<string>([...this.intents.keys(), ...this.queues.keys(), ...this.held.keys()]);
    for (const operation of this.operations.values()) controlled.add(operation.sessionId);
    for (const sessionId of controlled) this.abortOperation(sessionId);
    const work = (async () => {
      await Promise.race([Promise.allSettled([...this.queues.values()]), wait(remaining())]);
      const held = [...this.held.values()];
      for (const lease of held) {
        if (remaining() === 0) break;
        const token = this.beginOperation(lease.sessionId);
        try {
          const finish = (async () => { await this.deps.source.flush(); await this.syncImpl(lease.sessionId, { release: true }, token); })();
          await Promise.race([finish, wait(Math.min(2_000, remaining()))]);
        } catch { /* best-effort final publication inside the overall close budget */ }
        this.abortOperation(lease.sessionId);
        this.finishOperation(token);
      }
      for (const sessionId of [...this.renewals.keys()]) this.clearRenewal(sessionId);
      for (const sessionId of [...this.held.keys()]) this.releaseHeld(sessionId);
      const releases = held.map((lease) => this.deps.leases.release(lease).catch(() => undefined));
      await Promise.race([Promise.allSettled(releases), wait(remaining())]);
    })();
    await Promise.race([work, wait(timeoutMs)]);
  }

  async disable(sessionId: string, timeoutMs = 5_000): Promise<void> {
    this.abortOperation(sessionId);
    let finished = false;
    const disabled = this.exclusive(sessionId, async () => { await this.disableImpl(sessionId); finished = true; });
    await Promise.race([disabled.catch(() => undefined), new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
    const record = this.deps.local.getSession(sessionId);
    if (!finished && record !== undefined && record.enabled) {
      this.releaseHeld(sessionId);
      await this.update(record, { enabled: false, state: 'disabled' });
    }
  }

  private async disableImpl(sessionId: string): Promise<void> {
    const held = this.releaseHeld(sessionId);
    let leaseForFence = held;
    if (leaseForFence === undefined) {
      try { leaseForFence = await this.deps.leases.acquire(sessionId); } catch { /* CAS fallback below */ }
    }
    let fencedEpoch: number | undefined;
    let preservedDeleted = false;
    if (leaseForFence !== undefined) {
      try {
        const current = await this.deps.repository.getManifest(sessionId);
        if (current !== undefined && current.entity.state === 'deleted') {
          preservedDeleted = true;
        } else if (current !== undefined && current.entity.leaseOwner === this.deps.deviceId) {
          const epoch = current.entity.writerEpoch + 1;
          await this.deps.repository.updateManifest({
            ...current.entity, state: 'disabled', enabled: false, writerEpoch: epoch, leaseOwner: undefined, leaseUntil: undefined,
            updatedAt: this.deps.now(),
          }, current.etag);
          fencedEpoch = epoch;
        }
      } catch { /* fall through to CAS */ }
      await this.deps.leases.release(leaseForFence).catch(() => undefined);
    }
    if (fencedEpoch === undefined && !preservedDeleted) {
      let current = await this.deps.repository.getManifest(sessionId).catch(() => undefined);
      for (let attempt = 0; attempt < 3 && current !== undefined; attempt += 1) {
        if (current.entity.state === 'deleted') {
          preservedDeleted = true;
          break;
        }
        const epoch = current.entity.writerEpoch + 1;
        try {
          await this.deps.repository.updateManifest({
            ...current.entity, state: 'disabled', enabled: false, writerEpoch: epoch, leaseOwner: undefined, leaseUntil: undefined,
            updatedAt: this.deps.now(),
          }, current.etag);
          fencedEpoch = epoch;
          break;
        } catch (error) {
          if (!(error instanceof AzureSyncError) || (error.code !== 'PRECONDITION' && error.code !== 'CONFLICT')) break;
          current = await this.deps.repository.getManifest(sessionId).catch(() => undefined);
        }
      }
    }
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined) return;
    const confirmed = fencedEpoch !== undefined || preservedDeleted;
    await this.update(record, {
      enabled: false, state: 'disabled',
      ...(fencedEpoch === undefined ? { writerEpoch: record.writerEpoch } : { writerEpoch: fencedEpoch }),
      ...(confirmed ? {} : { status: 'detached', lastError: 'The local opt-out is kept, but the shared cloud opt-out could not be confirmed.' }),
    });
  }

  hasHeld(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  noteActivity(sessionId: string): void {
    this.drains.noteActivity(sessionId, this.deps.now());
  }

  noteFlushed(sessionId: string): void {
    this.drains.markFlushed(sessionId);
  }

  async ensureOwnership(sessionId: string, signal?: AbortSignal): Promise<OwnershipProof> {
    const token = this.beginOperation(sessionId);
    try { return await this.exclusive(sessionId, () => this.ensureOwnershipImpl(sessionId, token, signal)); }
    finally { this.finishOperation(token); }
  }

  private ownershipCheck(manifest: StoredManifest, snapshot: SourceSnapshot, record: LocalSessionRecord): OwnershipProof {
    const entity = manifest.entity;
    if (entity.state === 'deleted') return { owned: false, reason: 'removed-remotely' };
    if (entity.state !== 'active') return { owned: false, reason: 'paused-other-device' };
    if (entity.generation !== record.generation) return { owned: false, reason: 'generation-changed' };
    if (entity.headerHash !== headerHash(snapshot.header, snapshot.inheritedEventCount)) return { owned: false, reason: 'ownership-unverified' };
    if (entity.eventCount > snapshot.events.length) return { owned: false, reason: 'remote-ahead-live' };
    try { this.verifyLocalPrefix(manifest, snapshot, record.generation); }
    catch { return { owned: false, reason: 'ownership-unverified' }; }
    return { owned: true };
  }

  private async ensureOwnershipImpl(sessionId: string, generation: number, signal?: AbortSignal): Promise<OwnershipProof> {
    if (signal?.aborted) return { owned: false, reason: 'ownership-unverified' };
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined || !record.enabled) return { owned: false, reason: 'ownership-unverified' };
    await this.deps.source.flush();
    this.assertOperation(sessionId, generation);
    const raw = await this.deps.source.read(sessionId);
    if (raw === undefined) return { owned: false, reason: 'ownership-unverified' };
    const snapshot = await this.canonicalSnapshot(record, raw);
    const guard = checkGuards({ header: snapshot.header, events: snapshot.events });
    if (!guard.ok) return { owned: false, reason: 'ownership-unverified' };

    const held = this.held.get(sessionId);
    if (held !== undefined) {
      let renewed: SessionLease;
      try {
        renewed = await this.deps.leases.renew(held);
        this.held.set(sessionId, renewed);
      } catch (error) {
        this.releaseHeld(sessionId);
        if (error instanceof AzureSyncError && (error.code === 'LEASE_LOST' || error.code === 'PRECONDITION')) {
          return { owned: false, reason: 'paused-other-device' };
        }
        throw error;
      }
      this.assertOperation(sessionId, generation);
      const check = this.ownershipCheck(renewed.manifest, snapshot, record);
      if (!check.owned) {
        const lease = this.releaseHeld(sessionId);
        if (lease !== undefined) await this.deps.leases.release(lease).catch(() => undefined);
        return check;
      }
      await this.update(record, { writerEpoch: renewed.epoch, status: 'syncing' });
      return { owned: true };
    }

    try {
      let manifest = await this.deps.repository.getManifest(sessionId);
      if (manifest === undefined) {
        await this.deps.repository.createManifest(await this.initialManifest(sessionId, snapshot));
        manifest = await this.deps.repository.getManifest(sessionId);
      }
      if (manifest === undefined) return { owned: false, reason: 'ownership-unverified' };
      const lease = await this.deps.leases.acquire(sessionId, signal);
      if (signal?.aborted) {
        await this.deps.leases.release(lease).catch(() => undefined);
        return { owned: false, reason: 'ownership-unverified' };
      }
      this.assertOperation(sessionId, generation);
      const check = this.ownershipCheck(lease.manifest, snapshot, record);
      if (!check.owned) {
        await this.deps.leases.release(lease).catch(() => undefined);
        return check;
      }
      this.holdLease(lease);
      await this.update(record, { writerEpoch: lease.epoch, status: 'syncing' });
      return { owned: true };
    } catch (error) {
      if (error instanceof AzureSyncError && (error.code === 'LEASE_LOST' || error.code === 'CONFLICT' || error.code === 'PRECONDITION')) {
        return { owned: false, reason: 'paused-other-device' };
      }
      throw error;
    }
  }

  async drain(sessionId: string, snapshot: DrainSnapshot): Promise<DrainResult> {
    const token = this.beginOperation(sessionId);
    try { return await this.exclusive(sessionId, () => this.drainImpl(sessionId, snapshot, token)); }
    finally { this.finishOperation(token); }
  }

  private async drainImpl(sessionId: string, snapshot: DrainSnapshot, operation: number): Promise<DrainResult> {
    if (!this.held.has(sessionId)) return 'not-ready';
    const generation = this.drains.generation(sessionId);
    try {
      await this.deps.source.flush();
    } catch {
      await this.markDrainFailed(sessionId);
      return 'kept';
    }
    if (generation !== this.drains.generation(sessionId)) return 'kept';
    this.drains.markFlushed(sessionId);
    try {
      await this.syncImpl(sessionId, { release: false }, operation);
    } catch {
      await this.markDrainFailed(sessionId);
      return 'kept';
    }
    if (generation !== this.drains.generation(sessionId)) return 'kept';
    this.drains.markSuffix(sessionId);
    try {
      return await this.drains.maybeRelease(sessionId, this.deps.now(), snapshot, async (lease) => {
        const held = this.held.get(sessionId);
        if (held?.epoch === lease.epoch) {
          this.clearRenewal(sessionId);
          this.held.delete(sessionId);
        }
        await this.deps.leases.release(lease);
      }) ? 'released' : 'not-ready';
    } catch {
      await this.markDrainFailed(sessionId);
      return 'kept';
    }
  }

  private async markDrainFailed(sessionId: string): Promise<void> {
    const record = this.deps.local.getSession(sessionId);
    if (record !== undefined) await this.update(record, { status: 'drain-failed', lastError: 'The final drain upload failed; the lease is retained.' });
  }

  private async canonicalSnapshot(record: LocalSessionRecord, snapshot: SourceSnapshot): Promise<SourceSnapshot> {
    const binding = await this.deps.cwdBinding?.(snapshot.header.id, record);
    if (binding === undefined) return snapshot;
    if (record.imported && record.lastSyncedHeaderHash !== undefined) {
      const remote = await new RemoteSessionReader(this.deps.repository, {
        maxCompressedBytes: Math.max(this.deps.config.maxBatchBytes * 4, 1_048_576),
        maxExpandedBytes: this.deps.config.maxBatchBytes,
        maxEvents: this.deps.config.maxEventsPerSession,
      }).read(snapshot.header.id).catch(() => undefined);
      if (remote !== undefined && remote.events.length <= snapshot.events.length) {
        const localizedHeader = remote.header.cwd === undefined ? remote.header : { ...remote.header, cwd: await remoteToLocal(binding, remote.header.cwd) };
        const headerKeys = ['id', 'version', 'createdAt', 'isSeeded', 'cwd', 'parentSession', 'agentPreset', 'delegationDepth', 'origin'] as const;
        const headerChanged = headerKeys.some((key) => JSON.stringify((localizedHeader as unknown as Record<string, unknown>)[key]) !== JSON.stringify((snapshot.header as unknown as Record<string, unknown>)[key]));
        if (headerChanged || Number(snapshot.inheritedEventCount) !== Number(remote.inheritedEventCount)) {
          throw new AzureSyncError('PROVENANCE_MISMATCH', 'The local imported header or inherited cut differs from the canonical remote prefix.');
        }
        const prefix = snapshot.events.slice(0, remote.events.length);
        const prefixHasCwd = prefix.some((value) => (value as { type: string }).type === 'working-directory/change');
        const options = remote.header.cwd === undefined ? {}
          : prefixHasCwd ? { headerCwd: remote.header.cwd }
            : { headerCwd: remote.header.cwd, localCurrentCwd: await remoteToLocal(binding, remote.header.cwd) };
        await verifyImportedProvenance(binding, remote.events as never, prefix as never, options);
        const appended = await canonicalizeLocalEvents(snapshot.events.slice(remote.events.length) as never, binding);
        return { header: remote.header, inheritedEventCount: remote.inheritedEventCount, events: [...remote.events, ...appended] as never };
      }
      return snapshot;
    }
    try {
      const events = await canonicalizeLocalEvents(snapshot.events as never, binding);
      const header = snapshot.header.cwd === undefined ? snapshot.header : { ...snapshot.header, cwd: await localToRemote(binding, snapshot.header.cwd) };
      return { header, inheritedEventCount: snapshot.inheritedEventCount, events: events as never };
    } catch (error) {
      if (error instanceof AzureSyncError) throw new AzureSyncError('UNMAPPABLE_CWD', 'A working-directory/change event cannot be mapped to the remote binding.', { cause: { name: 'Error' } });
      throw error;
    }
  }

  async sync(sessionId: string, options: UploadOptions = {}): Promise<UploadSummary> {
    const token = this.beginOperation(sessionId);
    try { return await this.exclusive(sessionId, () => this.syncImpl(sessionId, options, token)); }
    finally { this.finishOperation(token); }
  }

  private async syncImpl(sessionId: string, options: UploadOptions = {}, generation = 0): Promise<UploadSummary> {
    if (generation !== 0) this.assertOperation(sessionId, generation);
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined || !record.enabled) return { status: 'disabled', eventCount: 0, uploadedBatches: 0 };
    try {
      await this.deps.source.flush();
      this.assertOperation(sessionId, generation);
      const raw = await this.deps.source.read(sessionId);
      if (raw === undefined) return this.pending(sessionId);
      const snapshot = await this.canonicalSnapshot(record, raw);
      if (snapshot.events.length > this.deps.config.maxEventsPerSession) {
        throw new AzureSyncError('LIMIT', 'The session exceeds the configured maximum event count.');
      }
      const headerBinding = headerHash(snapshot.header, snapshot.inheritedEventCount);
      const guard = checkGuards({ header: snapshot.header, events: snapshot.events });
      if (!guard.ok) {
        const status = guard.code ?? 'retrying';
        await this.update(record, { status, ...(guard.detail === undefined ? {} : { lastError: guard.detail }) });
        throw new AzureSyncError(status === 'no-cwd' ? 'NO_CWD' : status === 'schedule-unsafe' ? 'SCHEDULE_UNSAFE' : 'PRESET_MISSING', guard.detail ?? 'The session cannot be synced.');
      }

      let manifest = await this.deps.repository.getManifest(sessionId);
      if (manifest === undefined) {
        await this.deps.repository.createManifest(await this.initialManifest(sessionId, snapshot));
        manifest = await this.deps.repository.getManifest(sessionId);
      }
      if (manifest === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud session manifest could not be created.');
      if (manifest.entity.headerHash !== headerBinding) throw new AzureSyncError('CONFLICT', 'The cloud session header differs from this local session.');
      if (manifest.entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The cloud session has been removed.');
      if (manifest.entity.generation !== record.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud session generation changed.');
      if (!options.resume && (manifest.entity.state === 'disabled' || !manifest.entity.enabled)) throw new AzureSyncError('DISABLED', 'The cloud session is disabled; re-enable it explicitly.');
      if (manifest.entity.eventCount > snapshot.events.length) throw new AzureSyncError('CONFLICT', 'The cloud session is ahead of this local session.');
      if (!(options.resume === true && (manifest.entity.state === 'disabled' || !manifest.entity.enabled))) {
        this.verifyLocalPrefix(manifest, snapshot, record.generation);
      }

      let lease = this.held.get(sessionId);
      if (lease !== undefined) {
        try { lease = { ...lease, manifest: await this.deps.leases.proof(sessionId, lease.epoch) }; }
        catch (error) {
          this.releaseHeld(sessionId);
          if (!(error instanceof AzureSyncError) || error.code !== 'LEASE_LOST') throw error;
          lease = undefined;
        }
      }
      lease ??= await this.deps.leases.acquire(sessionId);
      if (options.resume === true && (lease.manifest.entity.enabled === false || lease.manifest.entity.state === 'disabled')) {
        await this.deps.repository.updateManifest({ ...lease.manifest.entity, state: 'active', enabled: true, updatedAt: this.deps.now() }, lease.manifest.etag);
        const enabled = await this.deps.repository.getManifest(sessionId);
        if (enabled === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The re-enabled manifest disappeared.');
        lease = { ...lease, manifest: enabled };
      }
      const heldLease = lease;
      this.assertOperation(sessionId, generation);
      this.verifyLocalPrefix(heldLease.manifest, snapshot, record.generation);
      const releaseAfter = options.release === true;
      let uploadedBatches = 0;
      try {
      const attachmentRefs = collectAttachmentReferences(snapshot.events);
      if (attachmentRefs.length > 0) {
        if (this.deps.attachments === undefined) {
          await this.update(record, { status: 'attachments-unavailable', degradedAttachments: attachmentRefs.map((ref) => ref.id), lastError: 'The host has no attachment store.' });
          throw new AzureSyncError('ATTACHMENT_UNSUPPORTED', 'Attachments are unavailable on this host.');
        }
        const uploaded = await this.deps.attachments.upload(attachmentRefs, {
          authorized: async () => {
            this.assertOperation(sessionId, generation);
            await this.deps.leases.proof(sessionId, heldLease.epoch);
            this.assertOperation(sessionId, generation);
          },
        });
        if (uploaded.missing.length > 0) {
          await this.update(record, { status: 'attachment-unsupported', degradedAttachments: [...uploaded.missing], lastError: 'Some attachments could not be read locally.' });
          throw new AzureSyncError('ATTACHMENT_UNSUPPORTED', 'Some attachments could not be read locally.');
        }
      }
        let committed = heldLease.manifest;
        let current = await this.update(record, {
          ...(snapshot.header.cwd === undefined ? {} : { canonicalCwd: snapshot.header.cwd }),
          ...(raw.header.cwd === undefined ? {} : { localCwd: raw.header.cwd }),
          ...(snapshot.header.cwd === raw.header.cwd ? {} : { remapped: true }),
        });
        let attempts = 0;
        while (committed.entity.eventCount < snapshot.events.length) {
          const proof = await this.deps.leases.proof(sessionId, heldLease.epoch);
          this.assertOperation(sessionId, generation);
          this.verifyLocalPrefix(proof, snapshot, record.generation);
          const from = proof.entity.eventCount;
          if (from >= snapshot.events.length) break;
          if (from > snapshot.events.length) throw new AzureSyncError('CONFLICT', 'The cloud session moved ahead during upload.');
          const plan = planBatch(snapshot.events, from, {
            maxEvents: this.deps.config.maxBatchEvents,
            maxBytes: this.deps.config.maxBatchBytes,
          }, proof.entity.chainHash);
          if (plan === undefined) break;
          if (plan.startSeq !== from) throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', 'The next batch does not start at the committed event count.');

          const createdEpoch = heldLease.epoch;
          const blobName = candidateBlobName(sessionId, proof.entity.generation, plan.startSeq, createdEpoch, plan.payloadHash);
          const put = await this.deps.repository.putCandidate(blobName, plan.gzip, batchBlobMetadata({
            startSeq: plan.startSeq, endSeq: plan.endSeq, eventCount: plan.chain.eventCount,
            prevChainHash: plan.chain.prevChainHash, chainHash: plan.chain.chainHash, headHash: plan.chain.headHash,
            headerHash: proof.entity.headerHash, generation: proof.entity.generation, createdEpoch,
            deviceId: this.deps.deviceId, schemaVersion: 4, payloadHash: plan.payloadHash,
          }));
          this.assertOperation(sessionId, generation);
          if (put.status === 'exists') {
            const metadata = await this.deps.repository.blob.getMetadata(blobName);
            if (metadata['payloadhash'] !== plan.payloadHash) {
              throw new AzureSyncError('CONFLICT', 'An immutable candidate already exists with different payload bytes.');
            }
            const compressed = await this.deps.repository.readCandidate(blobName, Math.max(this.deps.config.maxBatchBytes * 2, 1_048_576));
            let expanded: Buffer;
            try { expanded = gunzipSync(compressed, { maxOutputLength: this.deps.config.maxBatchBytes }); }
            catch { throw new AzureSyncError('CONFLICT', 'An immutable candidate expanded beyond the configured batch bound.'); }
            if (sha256Hex(expanded) !== plan.payloadHash) {
              throw new AzureSyncError('CONFLICT', 'An immutable candidate failed payload re-hashing.');
            }
          }
          this.assertOperation(sessionId, generation);

          const row: BatchRow = {
            partitionKey: proof.entity.partitionKey,
            rowKey: batchRowKey(sessionId, proof.entity.generation, plan.startSeq),
            schemaVersion: 4,
            sessionId,
            generation: proof.entity.generation,
            startSeq: plan.startSeq,
            endSeq: plan.endSeq,
            eventCount: plan.chain.eventCount,
            blobName,
            payloadHash: plan.payloadHash,
            prevChainHash: plan.chain.prevChainHash,
            chainHash: plan.chain.chainHash,
            headHash: plan.chain.headHash,
            ...(proof.entity.lastBatchRowKey === undefined ? {} : { prevBatchRowKey: proof.entity.lastBatchRowKey }),
            createdEpoch,
            deviceId: this.deps.deviceId,
            createdAt: this.deps.now(),
          };
          const next: CloudSessionEntity = {
            ...proof.entity,
            eventCount: plan.endSeq + 1,
            headSeq: plan.endSeq,
            headHash: plan.chain.headHash,
            chainHash: plan.chain.chainHash,
            batchCount: proof.entity.batchCount + 1,
            lastBatchRowKey: row.rowKey,
            lastBatchGeneration: proof.entity.generation,
            lastBatchBlobName: blobName,
            lastWriterDevice: this.deps.deviceId,
            updatedAt: this.deps.now(),
          };
          const root = proof.entity.rootSessionId === sessionId ? undefined : await this.deps.repository.getManifest(proof.entity.rootSessionId);
          if (proof.entity.rootSessionId !== sessionId && (root === undefined || root.entity.state !== 'active' || root.entity.generation !== proof.entity.rootGeneration)) {
            throw new AzureSyncError('LEASE_LOST', 'The child session root is no longer active.');
          }
          let retryBatch = false;
          for (;;) {
            try {
              committed = await this.deps.repository.commitBatch(proof, row, next, root);
              break;
            } catch (error) {
              if (!(error instanceof AzureSyncError) || (error.code !== 'PRECONDITION' && error.code !== 'CONFLICT')) throw error;
              attempts += 1;
              const after = await this.deps.repository.getManifest(sessionId);
              if (after !== undefined && after.entity.eventCount >= plan.endSeq + 1 && after.entity.chainHash === plan.chain.chainHash) {
                committed = after;
                break;
              }
              if (attempts >= 3 || after === undefined) throw error;
              this.verifyLocalPrefix(after, snapshot, record.generation);
              committed = after;
              retryBatch = true;
              break;
            }
          }
          if (retryBatch) continue;
          this.assertOperation(sessionId, generation);
          uploadedBatches += 1;
          current = await this.update(current, {
            status: 'syncing', lastSyncedEventCount: committed.entity.eventCount,
            lastSyncedChainHash: committed.entity.chainHash, lastSyncedHeaderHash: committed.entity.headerHash,
            remoteETag: committed.etag, lastSyncedAt: this.deps.now(), lastError: undefined,
            generation: committed.entity.generation, writerEpoch: heldLease.epoch,
          });
        }
        this.assertOperation(sessionId, generation);
        this.verifyLocalPrefix(committed, snapshot, record.generation);
        await this.update(current, {
          status: 'synced', lastSyncedEventCount: committed.entity.eventCount,
          lastSyncedChainHash: committed.entity.chainHash, lastSyncedHeaderHash: committed.entity.headerHash,
          remoteETag: committed.etag, lastSyncedAt: this.deps.now(), lastError: undefined,
          generation: committed.entity.generation, writerEpoch: heldLease.epoch,
        });
        return { status: 'synced', eventCount: committed.entity.eventCount, uploadedBatches };
      } finally {
        if (releaseAfter || this.operationAborted(sessionId, generation)) {
          this.releaseHeld(sessionId);
          await this.deps.leases.release(heldLease).catch(() => undefined);
        } else {
          this.holdLease(heldLease);
        }
      }
    } catch (error) {
      const code = error instanceof AzureSyncError ? error.code : undefined;
      const status = code === undefined ? 'retrying' : STATUS_BY_CODE[code] ?? 'retrying';
      if (code === 'LEASE_LOST') this.releaseHeld(sessionId);
      const current = this.deps.local.getSession(sessionId) ?? record;
      await this.update(current, { status, lastError: error instanceof Error ? error.message.slice(0, 4096) : 'Sync failed.' });
      throw error;
    }
  }

  private verifyLocalPrefix(manifest: StoredManifest, snapshot: SourceSnapshot, expectedGeneration?: number): void {
    if (manifest.entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The cloud session was removed during upload.');
    if (manifest.entity.state !== 'active') throw new AzureSyncError('DISABLED', 'The cloud session was disabled during upload.');
    if (expectedGeneration !== undefined && manifest.entity.generation !== expectedGeneration) {
      throw new AzureSyncError('GENERATION_CHANGED', 'The cloud session generation changed during upload.');
    }
    if (manifest.entity.headerHash !== headerHash(snapshot.header, snapshot.inheritedEventCount)) {
      throw new AzureSyncError('CONFLICT', 'The cloud session header changed during upload.');
    }
    const count = manifest.entity.eventCount;
    if (count === 0) {
      const genesis = genesisHash(manifest.entity.sessionId, manifest.entity.generation, manifest.entity.headerHash);
      if (manifest.entity.chainHash !== genesis) throw new AzureSyncError('CONFLICT', 'The empty cloud manifest has an invalid chain.');
      return;
    }
    if (snapshot.events.length < count) throw new AzureSyncError('CONFLICT', 'The local event prefix is shorter than the committed cloud prefix.');
    const genesis = genesisHash(manifest.entity.sessionId, manifest.entity.generation, manifest.entity.headerHash);
    const prefix = chainEvents(genesis, snapshot.events.slice(0, count) as never);
    if (prefix.chainHash !== manifest.entity.chainHash || prefix.headHash !== manifest.entity.headHash) {
      throw new AzureSyncError('CONFLICT', 'The local event prefix differs from the committed cloud history.');
    }
  }

  private async initialManifest(sessionId: string, snapshot: SourceSnapshot): Promise<CloudSessionEntity> {
    const binding = headerHash(snapshot.header, snapshot.inheritedEventCount);
    const genesis = genesisHash(sessionId, 1, binding);
    const now = this.deps.now();
    let rootSessionId = sessionId;
    let rootGeneration = 1;
    if (snapshot.header.origin === 'subagent') {
      if (snapshot.header.parentSession === undefined) throw new AzureSyncError('PRECONDITION', 'A subagent session has no parent to authorize its root.');
      const parent = await this.deps.repository.getManifest(snapshot.header.parentSession);
      if (parent === undefined || parent.entity.state !== 'active') throw new AzureSyncError('PRECONDITION', 'A subagent parent must be active and synced before the child can publish.');
      rootSessionId = parent.entity.rootSessionId;
      rootGeneration = parent.entity.rootGeneration;
    }
    return {
      partitionKey: 'account',
      rowKey: sessionRowKey(sessionId),
      schemaVersion: 4,
      sessionId,
      generation: 1,
      writerEpoch: 0,
      state: 'active',
      enabled: true,
      headerJson: canonicalJson(snapshot.header),
      headerHash: binding,
      inheritedEventCount: snapshot.inheritedEventCount,
      formatVersion: snapshot.header.version,
      eventCount: 0,
      headSeq: -1,
      headHash: genesis,
      chainHash: genesis,
      batchCount: 0,
      ...(snapshot.header.cwd === undefined ? {} : { cwd: snapshot.header.cwd }),
      sourceDeviceId: this.deps.deviceId,
      sourcePlatform: this.deps.platform,
      rootSessionId,
      rootGeneration,
      updatedAt: now,
    };
  }
}
