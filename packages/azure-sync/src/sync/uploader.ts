/**
 * Crash-safe incremental uploader. Candidate blobs are immutable and written
 * before the atomic batch-row/tip transaction; a retry re-reads the committed
 * tip and never trusts a cached event count.
 * @module @1yefuwang1/dsh-azure-sync/sync/uploader
 */
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { parseGitFacts, type GitFacts } from '../git/sanitize.js';
import type { AzureSyncConfig } from '../config.js';
import { AzureSyncError } from '../azure/errors.js';
import type { LocalStore } from '../local/store.js';
import {
  batchRowKey, sessionRowKey, type BatchRow, type CloudSessionEntity, type LocalSessionRecord,
  type Platform, type SyncStatus, batchBlobMetadataSchema, encodeKeyPart,
} from '../schema.js';
import { canonicalJson, payloadBytes, sha256Hex } from './canonical.js';
import { chainEvents, genesisHash, headerHash } from './chain.js';
import { planBatch, type BatchPlan } from './batcher.js';
import { checkGuards } from './guards.js';
import { batchBlobMetadata } from './blob-metadata.js';
import { candidateBlobName, type CloudRepository, type StoredManifest } from './cloud-repository.js';
import { validateSessionLeaseSeconds, type SessionLease, type SessionLeaseManager, type SessionLeaseSeconds } from './lease-manager.js';
import type { SessionSource, SourceSnapshot } from './session-source.js';
import type { CwdBinding } from './effective-cwd.js';
import { DrainCoordinator } from './drain-coordinator.js';
import { collectAttachmentReferences, type AttachmentSync } from './attachments.js';
import { canonicalReconcileSnapshot } from './reconciler.js';
import type { RemoteSession } from './remote-session.js';
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
  readonly isOptingOut?: (sessionId: string) => boolean;
  /** Advisory LOCAL-only read; never an ownership or history proof. */
  readonly gitMetadata?: (sessionId: string) => Promise<GitFacts | null>;
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
  /** Cancels this IO operation only, not user intent or foreground proof tokens. */
  readonly signal?: AbortSignal;
  /** Internal cold-operation hint; never downgrade an already held native lease. */
  readonly leaseSeconds?: SessionLeaseSeconds;
}

export interface OwnershipProof {
  readonly owned: boolean;
  readonly reason?: 'paused-other-device' | 'ownership-unverified' | 'remote-ahead-live' | 'generation-changed' | 'removed-remotely' | 'remote-missing' | 'conflict';
}

export type DrainResult = 'released' | 'kept' | 'not-ready';
interface EnableEntry { exists: boolean; cancellationId: string | undefined; generation: number | undefined; detached: boolean }

const STATUS_BY_CODE: Partial<Record<string, SyncStatus>> = {
  NO_CWD: 'no-cwd', SCHEDULE_UNSAFE: 'schedule-unsafe', PRESET_MISSING: 'preset-missing',
  LEASE_LOST: 'lease-lost', OWNERSHIP_UNVERIFIED: 'ownership-unverified', PRECONDITION: 'retrying',
  CONFLICT: 'conflict', AUTH_FAILED: 'auth-error', THROTTLED: 'retrying', TRANSIENT: 'retrying',
  LIMIT: 'degraded', CORRUPT_REMOTE: 'corrupt-remote', COMMITTED_INDEX_CORRUPT: 'committed-index-corrupt',
  UNMAPPABLE_CWD: 'cwd-unmappable', MAPPING_UNSTABLE: 'mapping-unstable', NEEDS_FOLDER: 'needs-folder',
  DISABLED: 'detached', GENERATION_CHANGED: 'generation-changed', REMOVED_REMOTELY: 'removed-remotely',
  PROVENANCE_MISMATCH: 'conflict',
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
  private readonly localOptOut = new Set<string>();
  private readonly operations = new Map<number, { sessionId: string; intent: number; aborted: boolean; enabling: boolean; authority: string | undefined }>();
  private nextOperation = 1;
  private suspended = false;

  /** Retire this credential generation synchronously; cleanup/release remains allowed. */
  suspend(): void {
    this.suspended = true;
    for (const operation of this.operations.values()) operation.aborted = true;
    for (const sessionId of [...this.renewals.keys()]) this.clearRenewal(sessionId);
  }

  constructor(deps: UploadDependencies) {
    this.deps = deps;
  }

  private authority(record: LocalSessionRecord | undefined): string {
    return JSON.stringify([record?.resurrectionCancellationId ?? null, record?.generation ?? null,
      record?.enabled ?? null, record?.detached ?? null, record?.admissionStopped ?? false, record?.mappingUnstable ?? false]);
  }

  private beginOperation(sessionId: string, enabling = false): number {
    const token = this.nextOperation++;
    if (!this.intents.has(sessionId)) this.intents.set(sessionId, 0);
    let authority: string | undefined;
    try { authority = this.authority(this.deps.local.getSession(sessionId)); } catch { /* closed/unavailable is fail-closed */ }
    this.operations.set(token, { sessionId, intent: this.intents.get(sessionId) ?? 0, aborted: false, enabling, authority });
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
    if (this.suspended || this.deps.isOptingOut?.(sessionId)) return true;
    if (token === 0) return false;
    const operation = this.operations.get(token);
    if (operation === undefined || operation.aborted || operation.sessionId !== sessionId ||
      operation.intent !== (this.intents.get(sessionId) ?? 0)) return true;
    if (operation.enabling) return false;
    try { return operation.authority === undefined || operation.authority !== this.authority(this.deps.local.getSession(sessionId)); }
    catch { return true; }
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
    // Cold controls are finite even if their caller crashes or stalls. A native
    // proof promotes a known cold lease before it can admit active execution.
    if (lease.durationSeconds === 30) { this.clearRenewal(lease.sessionId); return; }
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
    const expected = this.authority(record);
    const next = await this.deps.local.transactSession(record.sessionId, current => {
      if (current === undefined || this.authority(current) !== expected) throw new AzureSyncError('CANCELLED', 'A newer local permission superseded this checkpoint.');
      return { ...current, ...patch, lastAttemptAt: this.deps.now() };
    });
    if (next === undefined) throw new AzureSyncError('CANCELLED', 'The checkpoint no longer has a session.');
    return next;
  }

  private async pending(sessionId: string): Promise<UploadSummary> {
    const record = this.deps.local.getSession(sessionId) ?? initialLocal(sessionId);
    await this.update(record, { status: 'pending-materialization', lastError: undefined });
    return { status: 'pending-materialization', eventCount: 0, uploadedBatches: 0 };
  }

  private enableEntry(sessionId: string): EnableEntry {
    const record = this.deps.local.getSession(sessionId);
    return { exists: record !== undefined, cancellationId: record?.resurrectionCancellationId, generation: record?.generation, detached: record?.detached ?? false };
  }

  /** Synchronous local safety intent; durable authority follows in the permission lane. */
  noteOptOut(sessionId: string): void { this.localOptOut.add(sessionId); this.abortOperation(sessionId); }

  /** Toggle on: record the opt-in before any cloud work. */
  async enable(sessionId: string): Promise<UploadSummary> {
    const entry = this.enableEntry(sessionId);
    const token = this.beginOperation(sessionId, true);
    try {
      return await this.exclusive(sessionId, async () => {
        this.assertOperation(sessionId, token);
        await this.markEnabledImpl(sessionId, entry, token);
        this.assertOperation(sessionId, token);
        return this.syncImpl(sessionId, { resume: true }, token);
      });
    } finally { this.finishOperation(token); }
  }

  /** Stamp an explicit opt-in at API entry, then persist it before network setup. */
  async beginEnableIntent(sessionId: string, signal?: AbortSignal): Promise<number> {
    const entry = this.enableEntry(sessionId);
    const token = this.beginOperation(sessionId, true);
    const cancel = () => { const operation = this.operations.get(token); if (operation !== undefined) operation.aborted = true; };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      await this.exclusive(sessionId, async () => {
        this.assertOperation(sessionId, token);
        await this.markEnabledImpl(sessionId, entry, token);
      });
      return token;
    } catch (error) {
      this.finishOperation(token);
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  /** Cancel only this explicit request token, never a concurrent foreground proof. */
  cancelIntent(token: number): void { this.operations.delete(token); }

  /** Continue an explicit enable intent after service-level infrastructure setup. */
  async syncWithIntent(sessionId: string, token: number, seconds: SessionLeaseSeconds = 60): Promise<UploadSummary> {
    try {
      const leaseSeconds = validateSessionLeaseSeconds(seconds);
      return await this.exclusive(sessionId, () => this.syncImpl(sessionId, { resume: true, leaseSeconds }, token));
    } finally { this.finishOperation(token); }
  }

  /** Durably opt in and return the intent token used by the caller's later sync. */
  async markEnabled(sessionId: string): Promise<void> {
    const entry = this.enableEntry(sessionId);
    const token = this.beginOperation(sessionId, true);
    try {
      await this.exclusive(sessionId, async () => { this.assertOperation(sessionId, token); await this.markEnabledImpl(sessionId, entry, token); });
    } finally { this.finishOperation(token); }
  }

  private async markEnabledImpl(sessionId: string, entry: EnableEntry, token: number): Promise<void> {
    const cancellationId = randomUUID();
    const saved = await this.deps.local.transactSession(sessionId, current => {
      this.assertOperation(sessionId, token);
      if ((current !== undefined) !== entry.exists || current?.resurrectionCancellationId !== entry.cancellationId ||
          (entry.generation !== undefined && current?.generation !== entry.generation) ||
          (!entry.detached && current?.detached)) throw new AzureSyncError('CANCELLED', 'A newer local safety intent superseded this opt-in.');
      const record = current ?? initialLocal(sessionId);
      if (record.importState !== undefined && record.importState !== 'complete' && !(record.importState === 'degraded' && record.degradedAcknowledged)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'Repair the initial import before enabling cloud publication.');
      if (record.admissionStopped || record.status === 'conflict' || record.status === 'remote-ahead-live') throw new AzureSyncError('CONFLICT', 'Resolve the stopped recovery/conflict or restart the stale live host before enabling sync.');
      return { ...record, enabled: true, detached: false, state: 'active', status: record.mappingUnstable ? 'mapping-unstable' : 'syncing',
        admissionStopped: record.mappingUnstable, resurrectionCancellationId: cancellationId,
        lastAttemptAt: this.deps.now(), lastError: undefined };
    });
    this.assertOperation(sessionId, token);
    if (saved === undefined || this.authority(this.deps.local.getSession(sessionId)) !== this.authority(saved)) throw new AzureSyncError('CANCELLED', 'The completed opt-in was superseded.');
    const operation = this.operations.get(token);
    if (operation === undefined) throw new AzureSyncError('CANCELLED', 'The opt-in request ended.');
    operation.authority = this.authority(saved); operation.enabling = false;
    this.assertOperation(sessionId, token);
    this.localOptOut.delete(sessionId);
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
    this.localOptOut.add(sessionId);
    this.abortOperation(sessionId);
    const cancellationId = randomUUID();
    const saved = await this.deps.local.transactSession(sessionId, (current) => {
      const record = current ?? initialLocal(sessionId);
      return { ...record, enabled: false, state: 'disabled', detached: true, admissionStopped: false, status: 'detached',
        resurrectionIntent: undefined, resurrectionCancellationId: cancellationId, lastAttemptAt: this.deps.now() };
    });
    if (saved === undefined) throw new AzureSyncError('CANCELLED', 'The local opt-out could not be recorded.');
    // An earlier SDK write may have advanced the generation while its cache
    // still showed the old value at API entry. Fence the generation actually
    // stopped by this serialized permission transaction, never a stale snapshot.
    const generation = saved.generation;
    const currentIntent = (record: LocalSessionRecord | undefined): record is LocalSessionRecord => record !== undefined &&
      record.generation === generation && record.resurrectionCancellationId === cancellationId &&
      !record.enabled && record.detached && record.state === 'disabled';
    let finished = false;
    const disabled = this.exclusive(sessionId, async () => {
      await this.disableImpl(sessionId, cancellationId, generation);
      finished = true;
    });
    await Promise.race([disabled.catch(() => undefined), new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
    if (!finished) {
      // A timeout retires only this runtime's capability. Its eventual worker
      // must still prove the durable nonce before touching a replacement intent.
      const held = this.releaseHeld(sessionId);
      if (held !== undefined) void this.deps.leases.release(held).catch(() => undefined);
      await this.deps.local.transactSession(sessionId, (record) => currentIntent(record)
        ? { ...record, status: 'detached', admissionStopped: false, resurrectionIntent: undefined, lastAttemptAt: this.deps.now() }
        : undefined);
    }
  }

  private async disableImpl(sessionId: string, cancellationId: string, generation: number): Promise<void> {
    const currentIntent = (record = this.deps.local.getSession(sessionId)): record is LocalSessionRecord => record !== undefined &&
      record.generation === generation && record.resurrectionCancellationId === cancellationId &&
      !record.enabled && record.detached && record.state === 'disabled';
    const held = this.releaseHeld(sessionId);
    try {
      if (!currentIntent()) return;
      // Opt-out already permits CAS fencing a foreign owner. Acquiring a new
      // lease here would publish an epoch inside another async workflow before
      // this retired worker could recheck its shared durable intent nonce.
      let current = await this.deps.repository.getManifest(sessionId).catch(() => undefined);
      if (!currentIntent()) return;
      let fencedEpoch: number | undefined;
      let preservedDeleted = false;
      for (let attempt = 0; attempt < 3 && current !== undefined; attempt += 1) {
        if (!currentIntent()) return;
        if (current.entity.generation !== generation) break;
        if (current.entity.state === 'deleted') { preservedDeleted = true; break; }
        const epoch = current.entity.writerEpoch + 1;
        try {
          await this.deps.repository.updateManifest({
            ...current.entity, state: 'disabled', enabled: false, writerEpoch: epoch, leaseOwner: undefined, leaseUntil: undefined,
            updatedAt: this.deps.now(),
          }, current.etag);
          if (!currentIntent()) return;
          fencedEpoch = epoch;
          break;
        } catch (error) {
          if (!currentIntent()) return;
          if (!(error instanceof AzureSyncError) || (error.code !== 'PRECONDITION' && error.code !== 'CONFLICT') || attempt === 2) break;
          current = await this.deps.repository.getManifest(sessionId).catch(() => undefined);
          if (!currentIntent()) return;
        }
      }
      if (!currentIntent()) return;
      const confirmed = fencedEpoch !== undefined || preservedDeleted;
      await this.deps.local.transactSession(sessionId, (record) => currentIntent(record) ? {
        ...record, enabled: false, state: 'disabled', detached: true, admissionStopped: false, status: 'detached', resurrectionIntent: undefined,
        ...(fencedEpoch === undefined ? {} : { writerEpoch: fencedEpoch }),
        ...(confirmed ? {} : { lastError: 'The local opt-out is kept, but the shared cloud opt-out could not be confirmed.' }),
        lastAttemptAt: this.deps.now(),
      } : undefined);
    } finally {
      // This handle belongs to the retired runtime and release is epoch guarded;
      // cleanup may not adopt, renew, or clear the replacement runtime's lease.
      if (held !== undefined) await this.deps.leases.release(held).catch(() => undefined);
    }
  }

  /** Inspection never invalidates a concurrent foreground token or releases its newly live Agent. */
  async releaseInspection(sessionId: string, canRelease: () => boolean): Promise<boolean> {
    return this.exclusive(sessionId, async () => {
      if (!canRelease()) return false;
      const lease = this.releaseHeld(sessionId);
      if (lease !== undefined) await this.deps.leases.release(lease);
      return true;
    });
  }

  hasHeld(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  heldLeaseSeconds(sessionId: string): SessionLeaseSeconds | undefined {
    const lease = this.held.get(sessionId);
    return lease === undefined ? undefined : lease.durationSeconds ?? 60;
  }

  noteActivity(sessionId: string): void {
    this.drains.noteActivity(sessionId, this.deps.now());
  }

  noteFlushed(sessionId: string): void {
    this.drains.markFlushed(sessionId);
  }

  async ensureOwnership(sessionId: string, signal?: AbortSignal, seconds: SessionLeaseSeconds = 60): Promise<OwnershipProof> {
    const leaseSeconds = validateSessionLeaseSeconds(seconds);
    const token = this.beginOperation(sessionId);
    const cancel = () => { const operation = this.operations.get(token); if (operation !== undefined) operation.aborted = true; };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try { return await this.exclusive(sessionId, () => this.ensureOwnershipImpl(sessionId, token, signal, leaseSeconds)); }
    finally { signal?.removeEventListener('abort', cancel); this.finishOperation(token); }
  }

  /** Explicit, confirmed takeover still proves the exact local prefix before breaking any lease. */
  async takeover(sessionId: string, signal?: AbortSignal, seconds: SessionLeaseSeconds = 60): Promise<OwnershipProof> {
    const leaseSeconds = validateSessionLeaseSeconds(seconds);
    const token = this.beginOperation(sessionId);
    const cancel = () => { const operation = this.operations.get(token); if (operation !== undefined) operation.aborted = true; };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      return await this.exclusive(sessionId, async () => {
        this.assertOperation(sessionId, token);
        const record = this.deps.local.getSession(sessionId);
        if (this.localOptOut.has(sessionId) || this.deps.isOptingOut?.(sessionId) || record?.enabled !== true || record.detached || record.admissionStopped || record.mappingUnstable) throw new AzureSyncError('DISABLED', 'The local copy is not eligible for takeover.');
        if (record.importState !== undefined && record.importState !== 'complete' && !(record.importState === 'degraded' && record.degradedAcknowledged)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'Repair the incomplete import before taking over cloud ownership.');
        if (record.status === 'conflict' || record.status === 'remote-ahead-live') throw new AzureSyncError('CONFLICT', 'Resolve the stopped history or restart the stale live host before takeover.');
        await this.deps.source.flush(); this.assertOperation(sessionId, token);
        const raw = await this.deps.source.read(sessionId); this.assertOperation(sessionId, token);
        if (raw === undefined) throw new AzureSyncError('NOT_FOUND', 'Materialize and sync the thread before takeover.');
        const snapshot = await this.canonicalSnapshot(record, raw); this.assertOperation(sessionId, token);
        const guard = checkGuards({ header: snapshot.header, events: snapshot.events });
        if (!guard.ok) throw new AzureSyncError('CONFLICT', 'The local history is not safe for takeover.');
        const manifest = await this.deps.repository.getManifest(sessionId); this.assertOperation(sessionId, token);
        if (manifest === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud copy does not exist.');
        this.verifyLocalPrefix(manifest, snapshot, record.generation);
        const existing = this.held.get(sessionId);
        if (leaseSeconds === 30 && existing !== undefined && (existing.durationSeconds ?? 60) === 60) {
          // An old cold hint is not permission to break a foreground capability.
          return this.ensureOwnershipImpl(sessionId, token, signal, 60);
        }
        const previous = this.releaseHeld(sessionId);
        if (previous !== undefined) await this.deps.leases.release(previous);
        this.assertOperation(sessionId, token);
        const lease = await this.deps.leases.takeover(sessionId, signal, leaseSeconds);
        let retained = false;
        try {
          this.assertOperation(sessionId, token);
          this.verifyLocalPrefix(lease.manifest, snapshot, record.generation);
          this.holdLease(lease); retained = true;
          await this.update(record, { writerEpoch: lease.epoch, status: 'syncing' });
          this.assertOperation(sessionId, token);
          return { owned: true };
        } finally {
          if (!retained || this.operationAborted(sessionId, token)) {
            if (this.held.get(sessionId)?.epoch === lease.epoch) this.releaseHeld(sessionId);
            await this.deps.leases.release(lease).catch(() => undefined);
          }
        }
      });
    } finally { signal?.removeEventListener('abort', cancel); this.finishOperation(token); }
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

  private async ensureOwnershipImpl(sessionId: string, generation: number, signal?: AbortSignal, leaseSeconds: SessionLeaseSeconds = 60): Promise<OwnershipProof> {
    if (signal?.aborted) return { owned: false, reason: 'ownership-unverified' };
    const record = this.deps.local.getSession(sessionId);
    if (this.localOptOut.has(sessionId) || this.deps.isOptingOut?.(sessionId) || record === undefined || !record.enabled || record.admissionStopped || record.mappingUnstable) return { owned: false, reason: 'ownership-unverified' };
    if (record.importState !== undefined && record.importState !== 'complete' && !(record.importState === 'degraded' && record.degradedAcknowledged)) return { owned: false, reason: 'ownership-unverified' };
    await this.deps.source.flush();
    this.assertOperation(sessionId, generation);
    const raw = await this.deps.source.read(sessionId);
    this.assertOperation(sessionId, generation);
    if (raw === undefined) return { owned: false, reason: 'ownership-unverified' };
    const snapshot = await this.canonicalSnapshot(record, raw);
    this.assertOperation(sessionId, generation);
    const guard = checkGuards({ header: snapshot.header, events: snapshot.events });
    if (!guard.ok) return { owned: false, reason: 'ownership-unverified' };

    let held = this.held.get(sessionId);
    if (held?.durationSeconds === 30 && leaseSeconds === 60) {
      // No model step may inherit a cold capability. Promotion is serialized,
      // advances the epoch via fresh acquisition, and rechecks the same prefix.
      this.releaseHeld(sessionId);
      await this.deps.leases.release(held);
      this.assertOperation(sessionId, generation);
      if (signal?.aborted) return { owned: false, reason: 'ownership-unverified' };
      held = undefined;
    }
    if (held !== undefined) {
      let renewed: SessionLease;
      try {
        renewed = await this.deps.leases.renew(held, signal);
        this.assertOperation(sessionId, generation);
        if (this.held.get(sessionId)?.epoch !== held.epoch) {
          await this.deps.leases.release(renewed).catch(() => undefined);
          return { owned: false, reason: 'ownership-unverified' };
        }
        this.held.set(sessionId, renewed);
      } catch (error) {
        if (this.held.get(sessionId)?.epoch === held.epoch) {
          this.releaseHeld(sessionId);
          if (signal?.aborted || this.operationAborted(sessionId, generation)) await this.deps.leases.release(held).catch(() => undefined);
        }
        this.assertOperation(sessionId, generation);
        if (signal?.aborted) return { owned: false, reason: 'ownership-unverified' };
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
      this.assertOperation(sessionId, generation);
      return { owned: true };
    }

    try {
      let manifest = await this.deps.repository.getManifest(sessionId);
      this.assertOperation(sessionId, generation);
      if (manifest === undefined) {
        const initial = await this.initialManifest(sessionId, snapshot);
        this.assertOperation(sessionId, generation);
        await this.deps.repository.createManifest(initial);
        this.assertOperation(sessionId, generation);
        manifest = await this.deps.repository.getManifest(sessionId);
        this.assertOperation(sessionId, generation);
      }
      if (manifest === undefined) return { owned: false, reason: 'ownership-unverified' };
      const lease = await this.deps.leases.acquire(sessionId, signal, leaseSeconds);
      let retained = false;
      try {
        this.assertOperation(sessionId, generation);
        if (signal?.aborted) return { owned: false, reason: 'ownership-unverified' };
        const check = this.ownershipCheck(lease.manifest, snapshot, record);
        if (!check.owned) return check;
        this.holdLease(lease);
        retained = true;
        await this.update(record, { writerEpoch: lease.epoch, status: 'syncing' });
        this.assertOperation(sessionId, generation);
        return { owned: true };
      } finally {
        if (!retained || this.operationAborted(sessionId, generation)) {
          if (this.held.get(sessionId)?.epoch === lease.epoch) this.releaseHeld(sessionId);
          await this.deps.leases.release(lease).catch(() => undefined);
        }
      }
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
    const record = this.deps.local.getSession(sessionId);
    if (this.localOptOut.has(sessionId) || this.deps.isOptingOut?.(sessionId) || record?.admissionStopped || record?.mappingUnstable) return 'kept';
    if (!this.held.has(sessionId)) return 'not-ready';
    const generation = this.drains.generation(sessionId);
    try {
      await this.deps.source.flush();
    } catch {
      await this.markDrainFailed(record);
      return 'kept';
    }
    if (generation !== this.drains.generation(sessionId)) return 'kept';
    this.drains.markFlushed(sessionId);
    try {
      await this.syncImpl(sessionId, { release: false }, operation);
    } catch {
      await this.markDrainFailed(record);
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
      await this.markDrainFailed(record);
      return 'kept';
    }
  }

  private async markDrainFailed(record: LocalSessionRecord | undefined): Promise<void> {
    if (record?.enabled && !record.detached && !record.admissionStopped && !record.mappingUnstable) await this.update(record, { status: 'drain-failed', lastError: 'The final drain upload failed; the lease is retained.' });
  }

  private async canonicalSnapshot(record: LocalSessionRecord, snapshot: SourceSnapshot, verifiedRemote?: RemoteSession, allowDisabled = false): Promise<SourceSnapshot> {
    const binding = await this.deps.cwdBinding?.(snapshot.header.id, record);
    const remote = verifiedRemote ?? (record.imported && binding !== undefined ? await new RemoteSessionReader(this.deps.repository, {
      maxCompressedBytes: Math.max(this.deps.config.maxBatchBytes * 4, 1_048_576),
      maxExpandedBytes: this.deps.config.maxBatchBytes,
      maxEvents: this.deps.config.maxEventsPerSession,
    }).read(snapshot.header.id, { allowDisabled }) : undefined);
    return canonicalReconcileSnapshot(record, snapshot, remote, binding);
  }

  /** Fresh durable read, sharing the exact upload canonicalization rules. */
  async snapshotForReconciliation(sessionId: string, remote: RemoteSession): Promise<SourceSnapshot | undefined> {
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined) return undefined;
    await this.deps.source.flush();
    const raw = await this.deps.source.read(sessionId);
    return raw === undefined ? undefined : this.canonicalSnapshot(record, raw, remote);
  }

  /** Explicit deleted→new-generation re-upload uses a fresh full local commitment. */
  async snapshotForResurrection(sessionId: string): Promise<SourceSnapshot | undefined> {
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined) return undefined;
    if (record.importState !== undefined && record.importState !== 'complete' && !(record.importState === 'degraded' && record.degradedAcknowledged)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'Repair the incomplete import before re-uploading a new cloud generation.');
    await this.deps.source.flush();
    const raw = await this.deps.source.read(sessionId);
    if (raw === undefined) return undefined;
    const fresh = { ...record, imported: false };
    const binding = await this.deps.cwdBinding?.(sessionId, fresh);
    return canonicalReconcileSnapshot(fresh, raw, undefined, binding);
  }

  /** Stop local publication/renewal without disabling or rewriting remote history. */
  async pause(sessionId: string): Promise<void> {
    this.abortOperation(sessionId);
    const held = this.releaseHeld(sessionId);
    if (held !== undefined) await this.deps.leases.release(held);
  }

  async sync(sessionId: string, options: UploadOptions = {}): Promise<UploadSummary> {
    const token = this.beginOperation(sessionId);
    const cancel = () => { const operation = this.operations.get(token); if (operation !== undefined) operation.aborted = true; };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try { return await this.exclusive(sessionId, () => this.syncImpl(sessionId, options, token)); }
    finally { options.signal?.removeEventListener('abort', cancel); this.finishOperation(token); }
  }

  private async syncImpl(sessionId: string, options: UploadOptions = {}, generation = 0): Promise<UploadSummary> {
    if (generation !== 0) this.assertOperation(sessionId, generation);
    const leaseSeconds = validateSessionLeaseSeconds(options.leaseSeconds ?? (options.release === true ? 30 : 60));
    const record = this.deps.local.getSession(sessionId);
    if (this.localOptOut.has(sessionId) || this.deps.isOptingOut?.(sessionId) || record === undefined || !record.enabled) return { status: 'disabled', eventCount: 0, uploadedBatches: 0 };
    if (record.importState !== undefined && record.importState !== 'complete' && !(record.importState === 'degraded' && record.degradedAcknowledged)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'Repair the incomplete import before publication.');
    if (record.admissionStopped || record.mappingUnstable) throw new AzureSyncError('MAPPING_UNSTABLE', 'Repair the frozen mapping or recovery before publication.');
    if (record.status === 'conflict' || record.status === 'remote-ahead-live') throw new AzureSyncError('CONFLICT', 'The local session is blocked pending explicit conflict resolution or host restart.');
    try {
      await this.deps.source.flush();
      this.assertOperation(sessionId, generation);
      const raw = await this.deps.source.read(sessionId);
      this.assertOperation(sessionId, generation);
      if (raw === undefined) return this.pending(sessionId);
      const snapshot = await this.canonicalSnapshot(record, raw, undefined, options.resume === true);
      this.assertOperation(sessionId, generation);
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

      const gitJson = await this.gitJson(sessionId);
      this.assertOperation(sessionId, generation);
      let manifest = await this.deps.repository.getManifest(sessionId);
      this.assertOperation(sessionId, generation);
      if (manifest === undefined) {
        const initial = await this.initialManifest(sessionId, snapshot);
        this.assertOperation(sessionId, generation);
        await this.deps.repository.createManifest(initial);
        this.assertOperation(sessionId, generation);
        manifest = await this.deps.repository.getManifest(sessionId);
        this.assertOperation(sessionId, generation);
      }
      if (manifest === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud session manifest could not be created.');
      if (manifest.entity.headerHash !== headerBinding) throw new AzureSyncError('CONFLICT', 'The cloud session header differs from this local session.');
      if (manifest.entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The cloud session has been removed.');
      if (manifest.entity.generation !== record.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud session generation changed.');
      if (!options.resume && (manifest.entity.state === 'disabled' || !manifest.entity.enabled)) throw new AzureSyncError('DISABLED', 'The cloud session is disabled; re-enable it explicitly.');
      if (manifest.entity.eventCount > snapshot.events.length) throw new AzureSyncError('CONFLICT', 'The cloud session is ahead of this local session.');
      this.verifyLocalPrefix(manifest, snapshot, record.generation, options.resume === true);

      let lease = this.held.get(sessionId);
      if (lease !== undefined) {
        try { lease = { ...lease, manifest: await this.deps.leases.proof(sessionId, lease.epoch) }; }
        catch (error) {
          this.releaseHeld(sessionId);
          if (!(error instanceof AzureSyncError) || error.code !== 'LEASE_LOST') throw error;
          lease = undefined;
        }
      }
      this.assertOperation(sessionId, generation);
      const protectNative = options.leaseSeconds === 30 && lease !== undefined && (lease.durationSeconds ?? 60) === 60;
      lease ??= await this.deps.leases.acquire(sessionId, options.signal, leaseSeconds);
      let heldLease = lease;
      // Close/drain explicit cleanup keeps its original semantics; only an old
      // explicit cold hint is prevented from releasing a foreground-held lease.
      const releaseAfter = options.release === true && !protectNative;
      let uploadedBatches = 0;
      try {
      this.assertOperation(sessionId, generation);
      this.verifyLocalPrefix(lease.manifest, snapshot, record.generation, options.resume === true);
      if (options.resume === true && (lease.manifest.entity.enabled === false || lease.manifest.entity.state === 'disabled')) {
        await this.deps.repository.updateManifest({ ...lease.manifest.entity, state: 'active', enabled: true, updatedAt: this.deps.now() }, lease.manifest.etag);
        const enabled = await this.deps.repository.getManifest(sessionId);
        if (enabled === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The re-enabled manifest disappeared.');
        heldLease = { ...lease, manifest: enabled };
      }
      this.assertOperation(sessionId, generation);
      this.verifyLocalPrefix(heldLease.manifest, snapshot, record.generation);
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
          const candidate = await this.candidatePrefix(proof, snapshot);
          this.assertOperation(sessionId, generation);
          const plan = candidate?.plan ?? planBatch(snapshot.events, from, {
            maxEvents: this.deps.config.maxBatchEvents,
            maxBytes: this.deps.config.maxBatchBytes,
          }, proof.entity.chainHash);
          if (plan === undefined) break;
          if (plan.startSeq !== from) throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', 'The next batch does not start at the committed event count.');

          const createdEpoch = candidate?.epoch ?? heldLease.epoch;
          const blobName = candidate?.name ?? candidateBlobName(sessionId, proof.entity.generation, plan.startSeq, createdEpoch, plan.payloadHash);
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
            deviceId: candidate?.deviceId ?? this.deps.deviceId,
            createdAt: this.deps.now(),
          };
          const titleEvent = snapshot.events.slice(plan.startSeq, plan.endSeq + 1).reverse().find(event => event.type === 'session/title');
          const title = titleEvent?.type === 'session/title' ? titleEvent.data.title.slice(0, 4096) : undefined;
          const next: CloudSessionEntity = {
            ...proof.entity,
            ...(title === undefined ? {} : { title }),
            ...(this.deps.gitMetadata === undefined ? {} : { gitJson }),
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
          this.assertOperation(sessionId, generation);
          if (proof.entity.rootSessionId !== sessionId && (root === undefined || root.entity.state !== 'active' || root.entity.generation !== proof.entity.rootGeneration)) {
            throw new AzureSyncError('LEASE_LOST', 'The child session root is no longer active.');
          }
          let retryBatch = false;
          for (;;) {
            try {
              this.assertOperation(sessionId, generation);
              committed = await this.deps.repository.commitBatch(proof, row, next, root);
              break;
            } catch (error) {
              if (!(error instanceof AzureSyncError) || (error.code !== 'PRECONDITION' && error.code !== 'CONFLICT')) throw error;
              attempts += 1;
              const after = await this.deps.repository.getManifest(sessionId);
              this.assertOperation(sessionId, generation);
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
          // A successful transaction can be followed by deletion/takeover/new
          // generation before its reply read. Never checkpoint that foreign tip.
          this.verifyLocalPrefix(committed, snapshot, record.generation);
          if (committed.entity.sessionId !== sessionId || committed.entity.partitionKey !== next.partitionKey ||
              committed.entity.rowKey !== next.rowKey || committed.entity.schemaVersion !== next.schemaVersion || committed.entity.headerJson !== next.headerJson ||
              committed.entity.inheritedEventCount !== next.inheritedEventCount || committed.entity.formatVersion !== next.formatVersion ||
              committed.entity.rootSessionId !== next.rootSessionId || committed.entity.rootGeneration !== next.rootGeneration) throw new AzureSyncError('CORRUPT_REMOTE', 'The publication response changed its immutable session binding.');
          if (committed.entity.writerEpoch !== heldLease.epoch || committed.entity.leaseOwner !== heldLease.deviceId) throw new AzureSyncError('LEASE_LOST', 'The publication response no longer belongs to this writer.');
          const tipFields = ['eventCount', 'headSeq', 'headHash', 'chainHash', 'batchCount', 'lastBatchRowKey', 'lastBatchGeneration', 'lastBatchBlobName'] as const;
          if (tipFields.some(field => committed.entity[field] !== next[field])) throw new AzureSyncError('CORRUPT_REMOTE', 'The publication response changed its accepted committed tip.');
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
      if (code === 'CANCELLED') throw error;
      const status = code === undefined ? 'retrying' : STATUS_BY_CODE[code] ?? 'retrying';
      if (code === 'LEASE_LOST') this.releaseHeld(sessionId);
      else if (code !== undefined && ['CONFLICT', 'PROVENANCE_MISMATCH', 'REMOVED_REMOTELY', 'GENERATION_CHANGED', 'DISABLED'].includes(code)) {
        const held = this.releaseHeld(sessionId);
        if (held !== undefined) await this.deps.leases.release(held).catch(() => undefined);
      }
      await this.update(record, { status, ...(code === 'REMOVED_REMOTELY' || code === 'GENERATION_CHANGED' || code === 'DISABLED' ? { enabled: false } : {}), ...(code === 'REMOVED_REMOTELY' ? { state: 'deleted' as const } : {}), lastError: error instanceof Error ? error.message.slice(0, 4096) : 'Sync failed.' });
      throw error;
    }
  }

  private verifyLocalPrefix(manifest: StoredManifest, snapshot: SourceSnapshot, expectedGeneration?: number, allowDisabled = false): void {
    if (manifest.entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The cloud session was removed during upload.');
    if ((manifest.entity.state !== 'active' || !manifest.entity.enabled) && !allowDisabled) throw new AzureSyncError('DISABLED', 'The cloud session was disabled during upload.');
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

  /** Adopt only an exact verified next local prefix; arbitrary siblings remain uncommitted. */
  private async candidatePrefix(manifest: StoredManifest, snapshot: SourceSnapshot): Promise<{ plan: BatchPlan; name: string; epoch: number; deviceId: string } | undefined> {
    const { entity } = manifest;
    // Minimal unit adapters need not implement listing; the production BlobStore does.
    if (typeof this.deps.repository.blob.list !== 'function') return undefined;
    const prefix = `v1/sessions/${encodeKeyPart(entity.sessionId)}/gen-${entity.generation}/batches/${entity.eventCount}-`;
    let best: { plan: BatchPlan; name: string; epoch: number; deviceId: string } | undefined;
    for await (const item of this.deps.repository.blob.list(prefix)) {
      if (item.sizeBytes > Math.max(this.deps.config.maxBatchBytes * 4, 1_048_576)) continue;
      const raw = await this.deps.repository.blob.getMetadata(item.name);
      const parsed = batchBlobMetadataSchema.safeParse(raw);
      if (!parsed.success) continue;
      const meta = parsed.data;
      const count = Number(meta.eventcount);
      const epoch = Number(meta.createdepoch);
      if (!Number.isSafeInteger(count) || count <= (best?.plan.events.length ?? 0) || count < 1 || count > this.deps.config.maxBatchEvents ||
          !Number.isSafeInteger(epoch) || Number(meta.generation) !== entity.generation || Number(meta.startseq) !== entity.eventCount ||
          Number(meta.endseq) !== entity.eventCount + count - 1 || entity.eventCount + count > snapshot.events.length ||
          meta.headerhash !== entity.headerHash || meta.prevchainhash !== entity.chainHash ||
          item.name !== candidateBlobName(entity.sessionId, entity.generation, entity.eventCount, epoch, meta.payloadhash)) continue;
      const selected = snapshot.events.slice(entity.eventCount, entity.eventCount + count);
      const payload = payloadBytes(selected);
      if (payload.length > this.deps.config.maxBatchBytes) continue;
      const chain = chainEvents(entity.chainHash, selected);
      if (chain.chainHash !== meta.chainhash || chain.headHash !== meta.headhash || chain.payloadHash !== meta.payloadhash) continue;
      const gzip = await this.deps.repository.readCandidate(item.name, Math.max(this.deps.config.maxBatchBytes * 4, 1_048_576));
      let expanded: Buffer;
      try { expanded = gunzipSync(gzip, { maxOutputLength: this.deps.config.maxBatchBytes }); }
      catch { continue; }
      if (!expanded.equals(payload)) continue;
      best = { name: item.name, epoch, deviceId: meta.deviceid, plan: { events: selected, startSeq: entity.eventCount, endSeq: entity.eventCount + count - 1, payload, gzip, payloadHash: chain.payloadHash, chain } };
    }
    return best;
  }

  private async gitJson(sessionId: string): Promise<string | undefined> {
    try { const facts = parseGitFacts(await this.deps.gitMetadata?.(sessionId)); return facts ? JSON.stringify(facts) : undefined; }
    catch { return undefined; } // An unavailable advisory probe never changes sync permission.
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
      gitJson: await this.gitJson(sessionId),
    };
  }
}
