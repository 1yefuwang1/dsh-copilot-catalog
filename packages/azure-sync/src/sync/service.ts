/**
 * Sync control surface shared by lifecycle hooks and later commands/tools.
 * @module @1yefuwang1/dsh-azure-sync/sync/service
 */
import { randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LocalSessionRecord, SyncStatus } from '../schema.js';
import type { LocalStore } from '../local/store.js';
import type { OwnershipProof, UploadSummary, Uploader } from './uploader.js';
import { AzureSyncError } from '../azure/errors.js';
import type { CloudRepository } from './cloud-repository.js';
import type { RemoteSessionReader } from './remote-session.js';
import { reconcileManifest, type ReconcileDecision } from './reconciler.js';
import { decideLiveCatchup, REMOTE_AHEAD_LIVE_MESSAGE } from './live-guard.js';
import { ManifestPoller } from './poller.js';
import { applyConflictAction, exportLocalSnapshot } from './conflict.js';
import type { SessionSource } from './session-source.js';
import { checkGuards } from './guards.js';
import { isInitialIncompleteImport } from './importer.js';

export interface SyncServiceDependencies {
  readonly uploader: Uploader;
  readonly local: LocalStore;
  readonly ensureInfra?: () => Promise<void>;
  readonly agents?: { get(id: string): Agent | undefined };
  readonly ownershipProofMs?: number;
  readonly imports?: import('./import-service.js').ImportService;
  readonly tombstones?: import('./tombstone-manager.js').TombstoneManager;
  readonly repository?: CloudRepository;
  readonly reader?: RemoteSessionReader;
  readonly source?: SessionSource;
  readonly conflictDirectory?: string;
  readonly pollIntervalMs?: number;
  readonly refreshTimeoutMs?: number;
  readonly now?: () => number;
  readonly isOptingOut?: (sessionId: string) => boolean;
}

export class SyncService {
  private readonly deps: SyncServiceDependencies;
  private infra?: Promise<void>;
  private readonly drainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly refreshes = new Map<string, Promise<ReconcileDecision | undefined>>();
  private readonly lifetime = new AbortController();
  private readonly suspension = new AbortController();

  /** Invalidates fresh admission and publication before serialized teardown can run. */
  suspend(): void {
    this.suspension.abort();
    this.poller?.stop();
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    this.drainTimers.clear();
    this.deps.uploader.suspend();
  }
  private readonly sessionLifetimes = new Map<string, AbortController>();
  private poller?: ManifestPoller;

  private invalidate(sessionId: string): void {
    this.sessionLifetimes.get(sessionId)?.abort();
    this.sessionLifetimes.set(sessionId, new AbortController());
  }

  private sessionSignal(sessionId: string, signal?: AbortSignal): AbortSignal {
    let controller = this.sessionLifetimes.get(sessionId);
    if (controller === undefined) { controller = new AbortController(); this.sessionLifetimes.set(sessionId, controller); }
    return AbortSignal.any([controller.signal, this.lifetime.signal, this.suspension.signal, ...(signal === undefined ? [] : [signal])]);
  }

  private async abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([work, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  constructor(deps: SyncServiceDependencies) {
    this.deps = deps;
  }

  private check(signal?: AbortSignal): void {
    this.lifetime.signal.throwIfAborted();
    this.suspension.signal.throwIfAborted();
    signal?.throwIfAborted();
  }

  private async patch(sessionId: string, patch: Partial<LocalSessionRecord>, signal?: AbortSignal, expected?: LocalSessionRecord): Promise<void> {
    this.check(signal);
    const record = expected ?? this.deps.local.getSession(sessionId);
    if (record === undefined) return;
    await this.deps.local.transactSession(sessionId, latest => {
      this.check(signal);
      if (latest === undefined || latest.resurrectionCancellationId !== record.resurrectionCancellationId ||
          latest.generation !== record.generation || latest.enabled !== record.enabled || latest.detached !== record.detached ||
          !!latest.admissionStopped !== !!record.admissionStopped || latest.mappingUnstable !== record.mappingUnstable) return undefined;
      return { ...latest, ...patch };
    });
  }

  /** Start only after early import claims/recovery; teardown invalidates every refresh. */
  start(pullOnStartup = true): void {
    this.check();
    if (this.poller !== undefined || this.deps.repository === undefined) return;
    this.poller = new ManifestPoller({
      intervalMs: this.deps.pollIntervalMs ?? 300_000,
      ...(this.deps.refreshTimeoutMs === undefined ? {} : { refreshTimeoutMs: this.deps.refreshTimeoutMs }),
      refresh: (signal) => this.refreshAll(signal),
    });
    this.poller.start();
    if (pullOnStartup) void this.poller.tick();
  }

  async refreshAll(signal?: AbortSignal): Promise<void> {
    this.check(signal);
    // Opt-in only: do not enumerate/import unrelated cloud conversations here.
    const terminal = new Set<SyncStatus>(['conflict', 'corrupt-remote', 'committed-index-corrupt', 'incompatible-format', 'no-cwd', 'schedule-unsafe', 'preset-missing', 'mapping-unstable', 'ambiguous-mapping', 'needs-folder', 'cwd-unmappable']);
    let failure: unknown;
    for (const [sessionId, record] of this.deps.local.listSessions()) {
      this.check(signal);
      if (!record.enabled || record.detached || record.resurrectionIntent !== undefined || terminal.has(record.status) ||
          (!record.catchUpPending && (record.importState === 'failed' ||
            (record.importState !== undefined && !['complete', 'degraded'].includes(record.importState))))) continue;
      try {
        const result = await this.reconcile(sessionId, signal);
        this.check(signal);
        if (result?.uploadEvents && this.deps.local.getSession(sessionId)?.status !== 'conflict') {
          await this.deps.uploader.sync(sessionId, { release: this.deps.agents?.get(sessionId) === undefined, leaseSeconds: this.controlLeaseSeconds(sessionId), ...(signal === undefined ? {} : { signal }) });
          this.check(signal);
          if (this.deps.agents?.get(sessionId) !== undefined) this.scheduleDrain(sessionId);
        }
      }
      catch (error) {
        this.check(signal);
        if (this.deps.local.getSession(sessionId)?.enabled !== true) continue;
        const code = error instanceof AzureSyncError ? error.code : undefined;
        if (code === 'CANCELLED' || (error instanceof Error && error.name === 'AbortError')) continue;
        const statuses: Record<string, SyncStatus> = {
          AUTH_FAILED: 'auth-error', AUTH_REQUIRED: 'auth-error', CORRUPT_REMOTE: 'corrupt-remote',
          COMMITTED_INDEX_CORRUPT: 'committed-index-corrupt', CONFLICT: 'conflict', PROVENANCE_MISMATCH: 'conflict',
          GENERATION_CHANGED: 'generation-changed', REMOVED_REMOTELY: 'removed-remotely', DISABLED: 'detached',
          NO_CWD: 'no-cwd', SCHEDULE_UNSAFE: 'schedule-unsafe', PRESET_MISSING: 'preset-missing',
          NEEDS_FOLDER: 'needs-folder', MAPPING_UNSTABLE: 'mapping-unstable', UNMAPPABLE_CWD: 'cwd-unmappable',
        };
        await this.patch(sessionId, { status: code === undefined ? 'retrying' : statuses[code] ?? 'retrying', ...(code === 'REMOVED_REMOTELY' || code === 'GENERATION_CHANGED' || code === 'DISABLED' ? { enabled: false } : {}), lastError: 'Cloud refresh failed; continuation requires a fresh ownership proof.' }, signal, record);
        // Auth stops the poller. Terminal session failures do not starve other
        // threads; transient failures are reported once after the complete pass.
        if (code === 'AUTH_FAILED' || code === 'AUTH_REQUIRED') throw error;
        if (code === undefined || !terminal.has(statuses[code] ?? 'retrying')) failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async reconcile(sessionId: string, signal?: AbortSignal): Promise<ReconcileDecision | undefined> {
    const combined = this.sessionSignal(sessionId, signal);
    this.check(combined);
    const previous = this.refreshes.get(sessionId) ?? Promise.resolve();
    const run = this.abortable(previous.catch(() => undefined).then(() => {
      this.check(combined);
      return this.reconcileImpl(sessionId, combined);
    }), combined);
    this.refreshes.set(sessionId, run);
    try { return await run; }
    finally { if (this.refreshes.get(sessionId) === run) this.refreshes.delete(sessionId); }
  }

  private async reconcileImpl(sessionId: string, signal?: AbortSignal): Promise<ReconcileDecision | undefined> {
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined || !record.enabled || record.detached || this.deps.isOptingOut?.(sessionId) || record.admissionStopped || record.mappingUnstable || this.deps.repository === undefined || this.deps.reader === undefined) return undefined;
    const manifest = await this.deps.repository.getManifest(sessionId);
    this.check(signal);
    if (manifest === undefined) {
      // A tracked cloud copy disappearing is not permission to recreate it.
      if (record.lastSyncedAt !== undefined) await this.patch(sessionId, { status: 'remote-missing', enabled: false }, signal, record);
      return undefined;
    }
    const entity = manifest.entity;
    const stopped = entity.state === 'deleted' ? ['deleted', 'removed-remotely'] as const
      : entity.generation !== record.generation ? ['generation-changed', 'generation-changed'] as const
        : entity.state !== 'active' || !entity.enabled ? ['disabled', 'detached'] as const : undefined;
    if (stopped !== undefined) {
      await this.deps.uploader.pause(sessionId);
      await this.patch(sessionId, { enabled: false, state: entity.state, status: stopped[1] }, signal, record);
      return { kind: stopped[0], stop: true, importEvents: false, uploadEvents: false };
    }
    const remote = await this.deps.reader.read(sessionId);
    this.check(signal);
    if (remote === undefined) return undefined;
    if (remote.manifest.entity.generation !== record.generation) {
      await this.deps.uploader.pause(sessionId);
      await this.patch(sessionId, { enabled: false, status: 'generation-changed' }, signal, record);
      return { kind: 'generation-changed', stop: true, importEvents: false, uploadEvents: false };
    }
    let snapshot;
    try { snapshot = await this.deps.uploader.snapshotForReconciliation(sessionId, remote); }
    catch (error) {
      this.check(signal);
      if (!(error instanceof AzureSyncError) || !['CONFLICT', 'PROVENANCE_MISMATCH'].includes(error.code)) throw error;
      await this.deps.uploader.pause(sessionId);
      await this.patch(sessionId, { status: 'conflict', lastError: 'Local and cloud history diverged. Keep, export, or remove explicitly; no merge is attempted.' }, signal, record);
      return { kind: 'diverged', stop: true, importEvents: false, uploadEvents: false };
    }
    this.check(signal);
    if (snapshot === undefined) return undefined;
    const guard = checkGuards({ header: snapshot.header, events: snapshot.events });
    if (!guard.ok) {
      const status = guard.code ?? 'retrying';
      await this.patch(sessionId, { status, lastError: guard.detail }, signal, record);
      throw new AzureSyncError(status === 'no-cwd' ? 'NO_CWD' : status === 'schedule-unsafe' ? 'SCHEDULE_UNSAFE' : 'PRESET_MISSING', 'The local history does not satisfy sync guards.');
    }
    const result = reconcileManifest({ manifest: remote.manifest.entity, localGeneration: record.generation, local: snapshot, remoteEvents: remote.events });
    if (result.kind === 'diverged') {
      await this.deps.uploader.pause(sessionId);
      await this.patch(sessionId, { status: 'conflict', lastError: 'Local and cloud history diverged. Keep, export, or remove explicitly; no merge is attempted.' }, signal, record);
    } else if (result.kind === 'remote-ahead' || (result.kind === 'same' && record.catchUpPending)) {
      const hasLive = this.deps.agents?.get(sessionId) !== undefined;
      const live = result.kind === 'remote-ahead'
        ? decideLiveCatchup(hasLive, remote.events.length, snapshot.events.length)
        : { blocked: hasLive };
      await this.deps.uploader.pause(sessionId);
      this.check(signal);
      if (live.blocked) await this.patch(sessionId, { status: 'remote-ahead-live', lastError: REMOTE_AHEAD_LIVE_MESSAGE }, signal, record);
      else {
        if (this.deps.imports === undefined) throw new AzureSyncError('IMPORT_INCOMPLETE', 'Cold catch-up is unavailable.');
        await this.deps.imports.catchUp(sessionId, remote, { signal: AbortSignal.any([this.lifetime.signal, ...(signal === undefined ? [] : [signal])]), isLive: () => this.deps.agents?.get(sessionId) !== undefined });
        this.check(signal);
      }
    } else if (result.kind === 'same') {
      const current = this.deps.local.getSession(sessionId);
      if (current?.status !== 'conflict' && current?.degradedAttachments.length === 0 && !current.mappingUnstable && !current.needsFolder && (current.importState === undefined || current.importState === 'complete')) await this.patch(sessionId, { status: 'synced', lastSyncedAt: (this.deps.now ?? Date.now)(), lastSyncedEventCount: remote.manifest.entity.eventCount, lastSyncedChainHash: remote.manifest.entity.chainHash, lastSyncedHeaderHash: remote.manifest.entity.headerHash, remoteETag: remote.manifest.etag, lastError: undefined }, signal, record);
    }
    return result;
  }

  private async ensure(): Promise<void> {
    if (this.deps.ensureInfra === undefined) return;
    this.infra ??= this.deps.ensureInfra().catch((error: unknown) => {
      this.infra = undefined;
      throw error;
    });
    await this.infra;
  }

  async enable(sessionId: string, signal?: AbortSignal): Promise<UploadSummary> {
    this.check(signal);
    this.invalidate(sessionId);
    const current = this.sessionSignal(sessionId, signal);
    const leaseSeconds = this.controlLeaseSeconds(sessionId);
    const intent = await this.deps.uploader.beginEnableIntent(sessionId, current);
    const cancel = () => this.deps.uploader.cancelIntent(intent);
    current.addEventListener('abort', cancel, { once: true });
    let succeeded = false;
    try {
      this.check(current);
      await this.ensure();
      this.check(current);
      const summary = await this.deps.uploader.syncWithIntent(sessionId, intent, leaseSeconds);
      this.check(current);
      if (summary.status === 'synced') await this.promoteColdControl(sessionId, leaseSeconds, current);
      succeeded = summary.status === 'synced';
      return summary;
    } finally {
      current.removeEventListener('abort', cancel); this.deps.uploader.cancelIntent(intent);
      await this.settleControlLease(sessionId, succeeded && leaseSeconds === 30, current);
    }
  }

  async disable(sessionId: string): Promise<void> {
    this.invalidate(sessionId);
    await this.deps.uploader.disable(sessionId);
  }

  async sync(sessionId: string, signal?: AbortSignal): Promise<UploadSummary> {
    this.check(signal);
    const entry = this.deps.local.getSession(sessionId);
    if (entry?.enabled !== true || entry.detached || this.deps.isOptingOut?.(sessionId)) return { status: 'disabled', eventCount: 0, uploadedBatches: 0 };
    if (entry.admissionStopped || entry.mappingUnstable) throw new AzureSyncError('MAPPING_UNSTABLE', 'Resolve the stopped mapping or recovery before syncing.');
    await this.ensure();
    this.check(signal);
    const decision = await this.reconcile(sessionId, signal);
    this.check(signal);
    const record = this.deps.local.getSession(sessionId);
    if (record?.status === 'conflict' || record?.status === 'remote-ahead-live' || decision?.stop) throw new AzureSyncError('CONFLICT', 'Cloud sync is blocked; resolve the conflict or restart the host for live catch-up.');
    if (decision?.kind === 'remote-ahead' || (decision?.kind === 'same' && record?.status === 'synced')) {
      await this.settleControlLease(sessionId);
      return { status: record?.status === 'synced' ? 'synced' : 'disabled', eventCount: record?.lastSyncedEventCount ?? 0, uploadedBatches: 0 };
    }
    const result = await this.deps.uploader.sync(sessionId, { release: this.deps.agents?.get(sessionId) === undefined, leaseSeconds: this.controlLeaseSeconds(sessionId), ...(signal === undefined ? {} : { signal }) });
    await this.settleControlLease(sessionId);
    return result;
  }

  async close(timeoutMs = 5_000): Promise<void> {
    this.lifetime.abort();
    this.poller?.stop();
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    this.drainTimers.clear();
    await this.deps.uploader.close(timeoutMs);
  }

  noteActivity(sessionId: string): void {
    this.deps.uploader.noteActivity(sessionId);
  }

  noteFlushed(sessionId: string): void {
    this.deps.uploader.noteFlushed(sessionId);
  }

  private controlLeaseSeconds(sessionId: string): 30 | 60 {
    return this.deps.agents?.get(sessionId) === undefined ? 30 : 60;
  }

  private async promoteColdControl(sessionId: string, seconds: 30 | 60, signal?: AbortSignal): Promise<void> {
    this.check(signal);
    if (seconds !== 30 || !this.deps.uploader.hasHeld(sessionId) || this.deps.agents?.get(sessionId) === undefined) return;
    const proof = await this.deps.uploader.ensureOwnership(sessionId, signal, 60);
    this.check(signal);
    if (!proof.owned) throw new AzureSyncError('OWNERSHIP_UNVERIFIED', 'The newly live session requires a fresh active ownership proof.');
  }

  private async settleControlLease(sessionId: string, promoteIfLive = false, signal?: AbortSignal): Promise<void> {
    if (this.lifetime.signal.aborted || this.suspension.signal.aborted) return;
    if (!this.deps.uploader.hasHeld(sessionId)) return;
    if (this.deps.agents?.get(sessionId) === undefined) {
      const released = await this.deps.uploader.releaseInspection(sessionId, () => this.deps.agents?.get(sessionId) === undefined);
      if (released) return;
    }
    // A native owner can appear while queued cold cleanup rechecks its predicate.
    // Only a successful control's known cold handle may be promoted here; failures
    // remain finite, and existing native/legacy 60s capabilities are untouched.
    if (promoteIfLive && this.deps.uploader.heldLeaseSeconds(sessionId) === 30) await this.promoteColdControl(sessionId, 30, signal);
    if (this.deps.agents?.get(sessionId)?.status === 'idle') this.scheduleDrain(sessionId);
  }

  async ensureOwnership(sessionId: string, externalSignal?: AbortSignal, options: { inspection?: boolean } = {}): Promise<OwnershipProof> {
    if (this.lifetime.signal.aborted || this.suspension.signal.aborted) return { owned: false, reason: 'ownership-unverified' };
    const record = this.deps.local.getSession(sessionId);
    if (this.deps.isOptingOut?.(sessionId) || record?.admissionStopped || record?.mappingUnstable || record?.resurrectionIntent !== undefined) return { owned: false, reason: 'ownership-unverified' };
    const status = record?.status;
    if (status === 'remote-ahead-live') return { owned: false, reason: 'remote-ahead-live' };
    if (status === 'conflict') return { owned: false, reason: 'conflict' };
    if (status === 'generation-changed' || status === 'removed-remotely' || status === 'remote-missing') return { owned: false, reason: status };
    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, this.suspension.signal, controller.signal, ...(externalSignal === undefined ? [] : [externalSignal])]);
    const proof = (async (): Promise<OwnershipProof> => {
      let seconds: 30 | 60 = 60, succeeded = false;
      try {
        if (this.deps.repository !== undefined) await this.reconcile(sessionId, signal);
        this.check(signal);
        const current = this.deps.local.getSession(sessionId);
        if (current?.admissionStopped || current?.mappingUnstable) return { owned: false, reason: 'ownership-unverified' };
        const status = current?.status;
        if (status === 'conflict' || status === 'remote-ahead-live' || status === 'generation-changed' || status === 'removed-remotely' || status === 'remote-missing') return { owned: false, reason: status };
        seconds = this.controlLeaseSeconds(sessionId);
        const result = await this.deps.uploader.ensureOwnership(sessionId, signal, seconds);
        this.check(signal);
        if (result.owned) await this.promoteColdControl(sessionId, seconds, signal);
        succeeded = result.owned;
        return result;
      } finally {
        // Public inspection has no future Agent idle transition. Native pre-step
        // calls retain their lifecycle lease and normal quiet drain unchanged.
        if (options.inspection) await this.settleControlLease(sessionId, succeeded && seconds === 30, signal);
      }
    })();
    const ms = this.deps.ownershipProofMs ?? 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<OwnershipProof>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ owned: false, reason: 'ownership-unverified' }); }, ms);
      timer.unref?.();
    });
    try { return await Promise.race([this.abortable(proof, signal), timeout]); }
    catch (error) {
      if (controller.signal.aborted && !externalSignal?.aborted && !this.lifetime.signal.aborted) return { owned: false, reason: 'ownership-unverified' };
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  /** Check the quiet drain gate; retry once after the two-second quiet window. */
  async drain(sessionId: string): Promise<void> {
    if (this.lifetime.signal.aborted || this.suspension.signal.aborted) return;
    const record = this.deps.local.getSession(sessionId);
    if (this.deps.isOptingOut?.(sessionId) || record?.admissionStopped || record?.mappingUnstable) return;
    const status = record?.status;
    if (status === 'conflict' || status === 'remote-ahead-live' || status === 'removed-remotely' || status === 'generation-changed' || status === 'remote-missing') return;
    if (!this.deps.uploader.hasHeld(sessionId)) return;
    const agent = this.deps.agents?.get(sessionId);
    if (agent === undefined) return;
    const snapshot = { agentIdle: agent.status === 'idle', inboxSize: agent.inbox.nextTurn.length + agent.inbox.nextStep.length };
    if (!snapshot.agentIdle || snapshot.inboxSize !== 0) return;
    const result = await this.deps.uploader.drain(sessionId, snapshot);
    if (result !== 'released' && this.deps.uploader.hasHeld(sessionId)) this.scheduleDrain(sessionId);
  }

  scheduleDrain(sessionId: string): void {
    const previous = this.drainTimers.get(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.drainTimers.delete(sessionId);
      void this.drain(sessionId).catch(() => undefined);
    }, 2_100);
    timer.unref?.();
    this.drainTimers.set(sessionId, timer);
  }

  async removeFromCloud(sessionId: string, signal?: AbortSignal) {
    this.check(signal);
    if (this.deps.tombstones === undefined) throw new Error('azure-sync: tombstone manager is not ready.');
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined) throw new Error('azure-sync: session is not tracked.');
    const manifest = await this.deps.repository?.getManifest(sessionId);
    this.check(signal);
    if (manifest !== undefined && manifest.entity.rootSessionId !== sessionId) throw new AzureSyncError('CONFLICT', 'This action requires the root session.');
    this.invalidate(sessionId);
    await this.deps.uploader.pause(sessionId);
    this.check(signal);
    // Once the root tombstone is durable, cleanup is resumable even if the carrier disappears.
    await this.deps.tombstones.remove(sessionId, record.generation);
  }

  async resurrectInCloud(sessionId: string, signal?: AbortSignal) {
    this.check(signal);
    if (this.deps.tombstones === undefined) throw new Error('azure-sync: tombstone manager is not ready.');
    const entrySignal = this.sessionSignal(sessionId, signal);
    const record = this.deps.local.getSession(sessionId);
    const current = await this.deps.repository?.getManifest(sessionId);
    this.check(entrySignal);
    if (record?.resurrectionIntent === undefined && current?.entity.state !== 'deleted') throw new AzureSyncError('PRECONDITION', 'Only a deleted cloud copy may be resurrected; use verified enable for retained disabled history.');
    this.invalidate(sessionId);
    const actionSignal = this.sessionSignal(sessionId, signal);
    await this.deps.uploader.pause(sessionId);
    this.check(actionSignal);
    // A recorded completion retry repairs only its matching operation, not an
    // arbitrary active/disabled generation and never a second activation.
    const snapshot = record?.resurrectionIntent === undefined ? await this.deps.uploader.snapshotForResurrection(sessionId) : undefined;
    if (record?.resurrectionIntent === undefined && snapshot === undefined) throw new AzureSyncError('NOT_FOUND', 'The local re-upload snapshot is unavailable.');
    this.check(actionSignal);
    return this.deps.tombstones.resurrect(sessionId, record?.generation, snapshot, actionSignal);
  }

  async repairResurrections(): Promise<void> {
    this.check();
    await this.deps.tombstones?.repairPending((sessionId) => this.sessionSignal(sessionId));
  }

  /** Explicit conflict workflow, deliberately offering no merge or overwrite. */
  async resolveConflict(sessionId: string, action: unknown): Promise<void> {
    this.check();
    if (this.deps.local.getSession(sessionId)?.status !== 'conflict') throw new AzureSyncError('CONFLICT', 'This session has no unresolved conflict.');
    const detach = () => this.detach(sessionId);
    await applyConflictAction(action, {
      keepLocal: detach,
      exportLocal: async () => {
        if (this.deps.source === undefined || this.deps.conflictDirectory === undefined) throw new AzureSyncError('CONFLICT', 'The conflict export directory is unavailable.');
        const path = await exportLocalSnapshot(this.deps.source, sessionId, this.deps.conflictDirectory);
        await this.patch(sessionId, { conflictBackupPath: path });
      },
      removeCloud: async () => { await this.removeFromCloud(sessionId); await detach(); },
    });
  }

  /** Explicit local fork: release this device, never disable or rewrite the retained cloud copy. */
  async detach(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.check(signal);
    this.invalidate(sessionId);
    this.deps.uploader.noteOptOut(sessionId);
    const cancellationId = randomUUID();
    await this.deps.local.transactSession(sessionId, latest => {
      signal?.throwIfAborted();
      const record: LocalSessionRecord = latest ?? {
        sessionId, enabled: false, generation: 1, writerEpoch: 0, state: 'disabled', status: 'detached',
        remapped: false, needsFolder: false, unmappablePaths: [], mappingUnstable: false,
        degradedAttachments: [], degradedAcknowledged: false, imported: false, weArchived: false, detached: true,
      };
      return { ...record, enabled: false, detached: true, admissionStopped: false, status: 'detached',
        resurrectionIntent: undefined, resurrectionCancellationId: cancellationId, lastError: undefined };
    });
    signal?.throwIfAborted();
    const cleanup = this.deps.uploader.pause(sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); timer.unref?.(); });
    try { await this.abortable(Promise.race([cleanup, budget]), signal ?? new AbortController().signal); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async exportLocal(sessionId: string, signal?: AbortSignal): Promise<string> {
    const current = AbortSignal.any([this.lifetime.signal, ...(signal === undefined ? [] : [signal])]);
    this.check(current);
    if (this.deps.source === undefined || this.deps.conflictDirectory === undefined) throw new AzureSyncError('NOT_FOUND', 'Local export is unavailable.');
    const path = await exportLocalSnapshot(this.deps.source, sessionId, this.deps.conflictDirectory, current);
    this.check(current);
    await this.patch(sessionId, { conflictBackupPath: path }, current);
    return path;
  }

  async stopForMapping(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.check(signal);
    const record = this.deps.local.getSession(sessionId);
    if (record?.enabled !== true || record.detached) return;
    this.invalidate(sessionId);
    await this.patch(sessionId, { mappingUnstable: true, admissionStopped: true, status: 'mapping-unstable' }, signal, record);
    this.check(signal);
    await this.deps.uploader.pause(sessionId);
  }

  async acknowledgeDegraded(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.check(signal);
    const record = this.deps.local.getSession(sessionId);
    if (record?.importState !== 'degraded' || record.admissionStopped || record.mappingUnstable) throw new AzureSyncError('IMPORT_INCOMPLETE', 'Only a completed degraded import can be explicitly acknowledged.');
    await this.patch(sessionId, { degradedAcknowledged: true }, signal, record);
  }

  async repairSession(sessionId: string, options: { signal?: AbortSignal; confirmMapping?: boolean } = {}): Promise<void> {
    const signal = this.sessionSignal(sessionId, options.signal);
    this.check(signal);
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined) throw new AzureSyncError('NOT_FOUND', 'The local sync record does not exist.');
    if (record.resurrectionIntent !== undefined) { await this.deps.tombstones?.resurrect(sessionId, record.generation, undefined, signal); return; }
    const retained = !record.enabled || record.detached;
    if (retained && (!isInitialIncompleteImport(record, true) || record.importExpectedCount === undefined || record.importExpectedChainHash === undefined)) throw new AzureSyncError('DISABLED', 'Only a verified unfinished initial import may be repaired locally while explicitly disabled.');
    if (record.status === 'conflict' || (record.admissionStopped && !record.mappingUnstable)) throw new AzureSyncError('CONFLICT', 'Resolve the stopped history explicitly; repair never adopts another generation.');
    if (record.mappingUnstable && !options.confirmMapping) throw new AzureSyncError('MAPPING_UNSTABLE', 'Explicitly confirm the mapping before a forward-provenance repair.');
    if (this.deps.agents?.get(sessionId) !== undefined) throw new AzureSyncError('IMPORT_RACE', 'Restart the host before repairing a retained live session.');
    if (record.catchUpPending && !record.mappingUnstable) { await this.reconcile(sessionId, signal); return; }
    if (this.deps.imports === undefined) throw new AzureSyncError('IMPORT_INCOMPLETE', 'Import repair is unavailable.');
    const manifest = await this.deps.repository?.getManifest(sessionId);
    this.check(signal);
    if (manifest !== undefined && manifest.entity.generation !== record.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed; repair cannot adopt it.');
    const result = await this.deps.imports.resume(sessionId, { signal, confirmMapping: options.confirmMapping === true, ...(retained ? { allowDisabledRead: true } : {}) });
    this.check(signal);
    if (result.status === 'complete' || result.status === 'degraded') await this.patch(sessionId, { mappingUnstable: false, needsFolder: false, admissionStopped: false }, signal, record);
  }

  async takeover(sessionId: string, signal?: AbortSignal): Promise<OwnershipProof> {
    this.check(signal);
    await this.ensure();
    await this.reconcile(sessionId, signal);
    this.check(signal);
    const record = this.deps.local.getSession(sessionId);
    if (record?.enabled !== true || record.detached || record.admissionStopped || record.status === 'conflict' || record.status === 'remote-ahead-live') throw new AzureSyncError('CONFLICT', 'Only a verified current local copy may take over; cold-catch-up or restart first.');
    const current = this.sessionSignal(sessionId, signal);
    const seconds = this.controlLeaseSeconds(sessionId);
    const proof = await this.deps.uploader.takeover(sessionId, current, seconds);
    let succeeded = false;
    try {
      this.check(current);
      if (proof.owned) await this.promoteColdControl(sessionId, seconds, current);
      if (this.deps.agents?.get(sessionId) === undefined) await this.deps.uploader.sync(sessionId, { release: true, leaseSeconds: 30, signal: current });
      succeeded = proof.owned;
      return proof;
    } finally { await this.settleControlLease(sessionId, succeeded && seconds === 30, current); }
  }

  async importSession(sessionId: string, signal?: AbortSignal) {
    this.check(signal);
    if (this.deps.imports === undefined) throw new Error('azure-sync: import service is not ready.');
    if (this.deps.agents?.get(sessionId) !== undefined) throw new AzureSyncError('IMPORT_RACE', 'A retained live session cannot be imported.');
    return this.deps.imports.importSession(sessionId, this.sessionSignal(sessionId, signal));
  }

  async resumeImport(sessionId: string) {
    if (this.deps.imports === undefined) throw new Error('azure-sync: import service is not ready.');
    return this.deps.imports.resume(sessionId);
  }

  status(sessionId: string): { enabled: boolean; status: SyncStatus; record?: LocalSessionRecord } {
    const record = this.deps.local.getSession(sessionId);
    return { enabled: record?.enabled ?? false, status: record?.status ?? 'setup-needed', ...(record === undefined ? {} : { record }) };
  }
}
