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
import { RuntimeHistoryJobs, type PreparationWaiter } from './runtime-history-jobs.js';
import { assertRecoveryScope, assertScopedAppliedFloor } from './runtime-history-floor.js';
import type { RemoteSession } from './remote-session.js';
import type { StoredManifest } from './cloud-repository.js';
import type { CloudAuditResult } from '../protocol.js';

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
  readonly historyJobTimeoutMs?: number;
  readonly now?: () => number;
  readonly isOptingOut?: (sessionId: string) => boolean;
  readonly destinationReady?: (sessionId: string) => Promise<boolean>;
  readonly refreshGitOnSync?: boolean;
}

export class SyncService {
  private readonly deps: SyncServiceDependencies;
  private infra?: Promise<void>;
  private readonly drainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly refreshes = new Map<string, Promise<ReconcileDecision | undefined>>();
  private readonly lifetime = new AbortController();
  private readonly suspension = new AbortController();
  private readonly jobs: RuntimeHistoryJobs;
  private readonly dirty = new Map<string, number>();

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
    this.jobs.invalidate(sessionId);
    this.deps.reader?.invalidate?.(sessionId);
    this.dirty.delete(sessionId);
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
    this.jobs = new RuntimeHistoryJobs({
      signal: AbortSignal.any([this.lifetime.signal, this.suspension.signal]),
      authority: sessionId => this.historyAuthority(sessionId),
      check: (sessionId, expected) => this.checkHistoryAuthority(sessionId, expected),
      ...(deps.historyJobTimeoutMs === undefined ? {} : { timeoutMs: deps.historyJobTimeoutMs }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  }

  private historyAuthority(sessionId: string): string {
    const record = this.deps.local.getSession(sessionId);
    return JSON.stringify([this.deps.reader?.scopeId ?? null, record?.generation, record?.enabled,
      record?.detached, record?.resurrectionCancellationId, !!record?.admissionStopped,
      record?.mappingUnstable, record?.resurrectionIntent?.operationId, record?.publicationScope, record?.remoteAuditFailure, record?.remoteAuditScope]);
  }

  private checkHistoryAuthority(sessionId: string, expected: string, requirePublicationScope = true): void {
    this.check();
    const record = this.deps.local.getSession(sessionId);
    if (this.historyAuthority(sessionId) !== expected || record?.enabled !== true || record.detached ||
      record.admissionStopped || record.mappingUnstable || record.resurrectionIntent !== undefined || this.deps.isOptingOut?.(sessionId) ||
      record.remoteAuditFailure !== undefined || record.status === 'corrupt-remote' || record.status === 'committed-index-corrupt' ||
      (requirePublicationScope && !this.publicationEligible(record))) {
      throw new AzureSyncError('CANCELLED', 'The history job no longer has the current local intent.');
    }
  }

  private publicationEligible(record: LocalSessionRecord): boolean {
    const scope = this.deps.reader?.scopeId;
    return scope === undefined || record.publicationScope === scope;
  }

  private async requirePublicationScope(sessionId: string, record: LocalSessionRecord, signal?: AbortSignal): Promise<boolean> {
    if (this.publicationEligible(record)) return true;
    const lastError = 'Explicitly Sync or turn On this thread for the current storage account before automatic publication or continuation.';
    if (record.lastError !== lastError) await this.patch(sessionId, { lastError }, signal, record);
    return false;
  }

  private readContext(sessionId: string, signal?: AbortSignal, requirePublicationScope = true) {
    const expected = this.historyAuthority(sessionId);
    const generation = this.deps.local.getSession(sessionId)?.generation;
    return { ...(signal === undefined ? {} : { signal }), ...(generation === undefined ? {} : { expectedGeneration: generation }),
      check: () => { this.check(signal); this.checkHistoryAuthority(sessionId, expected, requirePublicationScope); } };
  }

  private retainHistory(sessionId: string, signal?: AbortSignal): ReturnType<RemoteSessionReader['retain']> | undefined {
    const reader = this.deps.reader, record = this.deps.local.getSession(sessionId);
    if (!reader?.retain || !record?.enabled || record.detached || record.admissionStopped || record.mappingUnstable ||
      record.resurrectionIntent || record.remoteAuditFailure || record.status === 'corrupt-remote' || record.status === 'committed-index-corrupt' ||
      this.deps.isOptingOut?.(sessionId) || !this.publicationEligible(record)) return undefined;
    const context = this.readContext(sessionId, signal); context.check();
    return reader.retain(sessionId, { ...context, expectedScope: reader.scopeId });
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
          latest.generation !== record.generation || latest.enabled !== record.enabled || latest.detached !== record.detached || latest.publicationScope !== record.publicationScope || latest.remoteAuditFailure !== record.remoteAuditFailure || latest.remoteAuditScope !== record.remoteAuditScope ||
          !!latest.admissionStopped !== !!record.admissionStopped || latest.mappingUnstable !== record.mappingUnstable) return undefined;
      return { ...latest, ...patch };
    });
  }

  /** Start only after early import claims/recovery; teardown invalidates every refresh. */
  start(pullOnStartup = true): void {
    this.check();
    if (this.poller !== undefined || this.deps.repository === undefined) return;
    this.poller = new ManifestPoller({
      intervalMs: this.deps.pollIntervalMs ?? 30_000,
      ...(this.deps.refreshTimeoutMs === undefined ? {} : { refreshTimeoutMs: this.deps.refreshTimeoutMs }),
      refresh: (signal) => this.refreshAll(signal),
    });
    this.poller.start();
    if (pullOnStartup) void this.poller.tick();
  }

  /** Metadata-only scheduling; payload eviction is never a reason to hydrate. */
  private async observeSession(sessionId: string, record: LocalSessionRecord, signal?: AbortSignal): Promise<void> {
    const reader = this.deps.reader;
    if (reader === undefined || typeof reader.observe !== 'function') return;
    const combined = this.sessionSignal(sessionId, signal);
    if (!await this.requirePublicationScope(sessionId, record, combined)) return;
    const context = this.readContext(sessionId, combined);
    const observation = await this.abortable(reader.observe(sessionId, context), combined);
    context.check();
    if (observation === undefined) {
      if (record.lastSyncedAt !== undefined) await this.patch(sessionId, { status: 'remote-missing', enabled: false }, combined, record);
      return;
    }
    if (await this.stopForManifest(sessionId, observation.manifest, record, combined)) return;
    assertScopedAppliedFloor(record, observation.manifest.entity, reader.scopeId);
    const remote = observation.manifest.entity;
    // L is native application evidence, not the independently accepted H. An
    // audit/preview may have accepted W without ever applying those events here.
    const applied = record.lastSyncedAt !== undefined && record.lastSyncedEventCount === remote.eventCount &&
      record.lastSyncedChainHash === remote.chainHash && record.lastSyncedHeaderHash === remote.headerHash;
    let localCount: number | undefined;
    if (this.deps.source !== undefined) {
      const stat = await this.abortable(this.deps.source.stat(sessionId), combined); context.check();
      localCount = stat?.eventCount;
      if (localCount === undefined) {
        const local = await this.abortable(this.deps.source.read(sessionId), combined); context.check();
        localCount = local?.events.length;
      }
    }
    const dirtyVersion = this.dirty.get(sessionId);
    if (!record.catchUpPending && applied && localCount === remote.eventCount && dirtyVersion === undefined) return;
    // Unknown H alone does not trigger a startup download of every unchanged
    // legacy history. It remains unverified until contents are actually needed.
    const work = this.jobs.work(sessionId, async job => {
      const retention = this.retainHistory(sessionId, job.signal);
      try {
        job.check();
        // reconcile takes its OWN fresh H/W envelope before Native/upload work.
        const result = await this.reconcile(sessionId, job.signal); job.check();
        if (result?.uploadEvents && this.deps.local.getSession(sessionId)?.status !== 'conflict') {
          await this.deps.uploader.sync(sessionId, { release: this.deps.agents?.get(sessionId) === undefined,
            leaseSeconds: this.controlLeaseSeconds(sessionId), signal: job.signal });
          job.check();
          if (this.deps.agents?.get(sessionId) !== undefined) this.scheduleDrain(sessionId);
        }
        if (this.dirty.get(sessionId) === dirtyVersion) this.dirty.delete(sessionId);
      } catch (error) {
        job.check();
        await this.recordRefreshFailure(sessionId, record, error, job.signal);
        throw error;
      } finally { retention?.release(); }
    });
    void work?.catch(() => undefined);
  }

  private async stopForManifest(sessionId: string, manifest: StoredManifest, record: LocalSessionRecord, signal?: AbortSignal): Promise<ReconcileDecision | undefined> {
    const entity = manifest.entity;
    const stopped = entity.state === 'deleted' ? ['deleted', 'removed-remotely'] as const
      : entity.generation !== record.generation ? ['generation-changed', 'generation-changed'] as const
        : entity.state !== 'active' || !entity.enabled ? ['disabled', 'detached'] as const : undefined;
    if (stopped === undefined) return undefined;
    await this.deps.uploader.pause(sessionId);
    await this.patch(sessionId, { enabled: false, state: entity.state, status: stopped[1] }, signal, record);
    return { kind: stopped[0], stop: true, importEvents: false, uploadEvents: false };
  }

  private async recordRefreshFailure(sessionId: string, record: LocalSessionRecord, error: unknown, signal?: AbortSignal): Promise<void> {
    this.check(signal);
    if (this.deps.local.getSession(sessionId)?.enabled !== true || record.remoteAuditFailure !== undefined) return;
    const code = error instanceof AzureSyncError ? error.code : undefined;
    if (code === 'CANCELLED' || (error instanceof Error && error.name === 'AbortError')) return;
    const statuses: Record<string, SyncStatus> = {
      AUTH_FAILED: 'auth-error', AUTH_REQUIRED: 'auth-error', OWNERSHIP_UNVERIFIED: 'ownership-unverified', CORRUPT_REMOTE: 'corrupt-remote',
      COMMITTED_INDEX_CORRUPT: 'committed-index-corrupt', CONFLICT: 'conflict', PROVENANCE_MISMATCH: 'conflict',
      GENERATION_CHANGED: 'generation-changed', REMOVED_REMOTELY: 'removed-remotely', DISABLED: 'detached', NOT_FOUND: 'remote-missing',
      NO_CWD: 'no-cwd', SCHEDULE_UNSAFE: 'schedule-unsafe', PRESET_MISSING: 'preset-missing',
      NEEDS_FOLDER: 'needs-folder', MAPPING_UNSTABLE: 'mapping-unstable', UNMAPPABLE_CWD: 'cwd-unmappable',
    };
    if (code !== undefined && ['REMOVED_REMOTELY', 'GENERATION_CHANGED', 'DISABLED', 'NOT_FOUND', 'CONFLICT', 'PROVENANCE_MISMATCH', 'CORRUPT_REMOTE', 'COMMITTED_INDEX_CORRUPT'].includes(code)) await this.deps.uploader.pause(sessionId);
    await this.patch(sessionId, { status: code === undefined ? 'retrying' : statuses[code] ?? 'retrying',
      ...(code === 'REMOVED_REMOTELY' || code === 'GENERATION_CHANGED' || code === 'DISABLED' || code === 'NOT_FOUND' ? { enabled: false } : {}),
      lastError: code === 'OWNERSHIP_UNVERIFIED' ? 'Explicitly Sync or turn On this thread for the current storage account before automatic publication or continuation.'
        : 'Cloud refresh failed; continuation requires a fresh ownership proof.' }, signal, record);
    if (code === 'AUTH_FAILED' || code === 'AUTH_REQUIRED') this.poller?.stop();
  }

  /** Observe completion/failure of already registered work; this starts no IO or permission. */
  waitForHistoryWork(sessionId: string): Promise<void> { return this.jobs.waitForWork(sessionId); }

  async refreshAll(signal?: AbortSignal): Promise<void> {
    this.check(signal);
    // Opt-in only: do not enumerate/import unrelated cloud conversations here.
    const terminal = new Set<SyncStatus>(['conflict', 'corrupt-remote', 'committed-index-corrupt', 'incompatible-format', 'no-cwd', 'schedule-unsafe', 'preset-missing', 'mapping-unstable', 'ambiguous-mapping', 'needs-folder', 'cwd-unmappable']);
    let failure: unknown;
    for (const [sessionId, record] of this.deps.local.listSessions()) {
      this.check(signal);
      if (!record.enabled || record.detached || record.resurrectionIntent !== undefined || record.remoteAuditFailure !== undefined || terminal.has(record.status) ||
          (!record.catchUpPending && (record.importState === 'failed' ||
            (record.importState !== undefined && !['complete', 'degraded'].includes(record.importState))))) continue;
      try {
        if (this.deps.reader !== undefined && typeof this.deps.reader.observe === 'function') {
          await this.observeSession(sessionId, record, signal);
          this.check(signal);
          continue;
        }
        // Reader-only adapters are retained for existing isolated unit fixtures.
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
          AUTH_FAILED: 'auth-error', AUTH_REQUIRED: 'auth-error', OWNERSHIP_UNVERIFIED: 'ownership-unverified', CORRUPT_REMOTE: 'corrupt-remote',
          COMMITTED_INDEX_CORRUPT: 'committed-index-corrupt', CONFLICT: 'conflict', PROVENANCE_MISMATCH: 'conflict',
          GENERATION_CHANGED: 'generation-changed', REMOVED_REMOTELY: 'removed-remotely', DISABLED: 'detached', NOT_FOUND: 'remote-missing',
          NO_CWD: 'no-cwd', SCHEDULE_UNSAFE: 'schedule-unsafe', PRESET_MISSING: 'preset-missing',
          NEEDS_FOLDER: 'needs-folder', MAPPING_UNSTABLE: 'mapping-unstable', UNMAPPABLE_CWD: 'cwd-unmappable',
        };
        await this.recordRefreshFailure(sessionId, record, error, signal);
        // Auth stops the poller. Terminal session failures do not starve other
        // threads; transient failures are reported once after the complete pass.
        if (code === 'AUTH_FAILED' || code === 'AUTH_REQUIRED') throw error;
        if (code === 'GENERATION_CHANGED' || code === 'REMOVED_REMOTELY' || code === 'DISABLED' || code === 'NOT_FOUND') continue;
        if (code === undefined || !terminal.has(statuses[code] ?? 'retrying')) failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async reconcile(sessionId: string, signal?: AbortSignal): Promise<ReconcileDecision | undefined> {
    const combined = this.sessionSignal(sessionId, signal);
    this.check(combined);
    const entry = this.deps.local.getSession(sessionId);
    const previous = this.refreshes.get(sessionId) ?? Promise.resolve();
    const run = this.abortable(previous.catch(() => undefined).then(async () => {
      this.check(combined);
      const retention = this.retainHistory(sessionId, combined);
      try { return await this.reconcileImpl(sessionId, combined); }
      finally { retention?.release(); }
    }), combined);
    this.refreshes.set(sessionId, run);
    try { return await run; }
    catch (error) {
      if (!combined.aborted && entry !== undefined) {
        await this.recordRefreshFailure(sessionId, entry, error, combined);
        const code = error instanceof AzureSyncError ? error.code : undefined;
        const stopped = code === 'GENERATION_CHANGED' ? 'generation-changed' : code === 'REMOVED_REMOTELY' ? 'deleted' : code === 'DISABLED' ? 'disabled' : undefined;
        if (stopped !== undefined) return { kind: stopped, stop: true, importEvents: false, uploadEvents: false };
        if (code === 'NOT_FOUND') return undefined;
      }
      throw error;
    } finally { if (this.refreshes.get(sessionId) === run) this.refreshes.delete(sessionId); }
  }

  private async reconcileImpl(sessionId: string, signal?: AbortSignal): Promise<ReconcileDecision | undefined> {
    if (this.deps.destinationReady && !await this.deps.destinationReady(sessionId)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'The recorded destination is not ready.');
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined || !record.enabled || record.detached || this.deps.isOptingOut?.(sessionId) || record.admissionStopped || record.mappingUnstable || this.deps.repository === undefined || this.deps.reader === undefined) return undefined;
    const integrity = record.remoteAuditFailure ?? (record.status === 'corrupt-remote' || record.status === 'committed-index-corrupt' ? record.status : undefined);
    if (integrity !== undefined) throw new AzureSyncError(integrity === 'corrupt-remote' ? 'CORRUPT_REMOTE' : 'COMMITTED_INDEX_CORRUPT', 'Explicitly verify the cloud copy before local reconciliation after a remote-health failure.');
    if (!await this.requirePublicationScope(sessionId, record, signal)) throw new AzureSyncError('OWNERSHIP_UNVERIFIED', 'Explicitly Sync or turn On this thread for the current storage account.');
    const context = this.readContext(sessionId, signal);
    const manifest = typeof this.deps.reader.observe === 'function'
      ? (await this.deps.reader.observe(sessionId, context))?.manifest
      : await this.deps.repository.getManifest(sessionId);
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
    assertScopedAppliedFloor(record, manifest.entity, this.deps.reader.scopeId);
    const remote = await this.deps.reader.read(sessionId, context);
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
      if (current?.status !== 'conflict' && current?.status !== 'corrupt-remote' && current?.status !== 'committed-index-corrupt' && current?.degradedAttachments.length === 0 && !current.mappingUnstable && !current.needsFolder && (current.importState === undefined || current.importState === 'complete')) await this.patch(sessionId, { status: 'synced', lastSyncedAt: (this.deps.now ?? Date.now)(), lastSyncedEventCount: remote.manifest.entity.eventCount, lastSyncedChainHash: remote.manifest.entity.chainHash, lastSyncedHeaderHash: remote.manifest.entity.headerHash, remoteETag: remote.manifest.etag, lastError: undefined }, signal, record);
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
    if (this.deps.destinationReady && !await this.deps.destinationReady(sessionId)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'Finish the recorded destination operation before enabling sync.');
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

  async sync(sessionId: string, signal?: AbortSignal, options: { readonly explicit?: boolean } = {}): Promise<UploadSummary> {
    this.check(signal);
    const entry = this.deps.local.getSession(sessionId);
    if (entry?.enabled !== true || entry.detached || this.deps.isOptingOut?.(sessionId)) return { status: 'disabled', eventCount: 0, uploadedBatches: 0 };
    if (entry.admissionStopped || entry.mappingUnstable) throw new AzureSyncError('MAPPING_UNSTABLE', 'Resolve the stopped mapping or recovery before syncing.');
    const expected = this.historyAuthority(sessionId);
    await this.ensure();
    this.check(signal);
    if (options.explicit) {
      this.checkHistoryAuthority(sessionId, expected, false);
      await this.deps.uploader.bindPublicationScope(sessionId, signal);
      this.check(signal);
    }
    const retention = this.retainHistory(sessionId, this.sessionSignal(sessionId, signal));
    try {
      const decision = await this.reconcile(sessionId, signal);
      this.check(signal);
      const record = this.deps.local.getSession(sessionId);
      if (record?.status === 'conflict' || record?.status === 'remote-ahead-live' || decision?.stop) throw new AzureSyncError('CONFLICT', 'Cloud sync is blocked; resolve the conflict or restart the host for live catch-up.');
      if (decision?.kind === 'remote-ahead' || (decision?.kind === 'same' && record?.status === 'synced' && !this.deps.refreshGitOnSync)) {
        await this.settleControlLease(sessionId);
        return { status: record?.status === 'synced' ? 'synced' : 'disabled', eventCount: record?.lastSyncedEventCount ?? 0, uploadedBatches: 0 };
      }
      const result = await this.deps.uploader.sync(sessionId, { release: this.deps.agents?.get(sessionId) === undefined, leaseSeconds: this.controlLeaseSeconds(sessionId), ...(signal === undefined ? {} : { signal }) });
      await this.settleControlLease(sessionId);
      return result;
    } finally { retention?.release(); }
  }

  async close(timeoutMs = 5_000): Promise<void> {
    this.lifetime.abort();
    this.poller?.stop();
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    this.drainTimers.clear();
    const deadline = Date.now() + timeoutMs;
    await this.jobs.settle(Math.max(0, deadline - Date.now()));
    await this.deps.uploader.close(Math.max(0, deadline - Date.now()));
  }

  noteActivity(sessionId: string): void {
    this.dirty.set(sessionId, (this.dirty.get(sessionId) ?? 0) + 1);
    this.deps.uploader.noteActivity(sessionId);
  }

  noteFlushed(sessionId: string): void {
    this.dirty.set(sessionId, (this.dirty.get(sessionId) ?? 0) + 1);
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
    externalSignal?.throwIfAborted();
    try { if (this.deps.destinationReady && !await this.deps.destinationReady(sessionId)) return { owned: false, reason: 'ownership-unverified' }; }
    catch { return { owned: false, reason: 'ownership-unverified' }; }
    const record = this.deps.local.getSession(sessionId);
    if (record?.enabled !== true || record.detached || this.deps.isOptingOut?.(sessionId) || record.admissionStopped || record.mappingUnstable || record.resurrectionIntent !== undefined) return { owned: false, reason: 'ownership-unverified' };
    if (record !== undefined && !await this.requirePublicationScope(sessionId, record, externalSignal)) return { owned: false, reason: 'ownership-unverified' };
    const status = record?.status;
    if (status === 'remote-ahead-live') return { owned: false, reason: 'remote-ahead-live' };
    if (status === 'conflict') return { owned: false, reason: 'conflict' };
    if (status === 'generation-changed' || status === 'removed-remotely' || status === 'remote-missing') return { owned: false, reason: status };
    externalSignal?.throwIfAborted();
    if (record.remoteAuditFailure !== undefined || status === 'corrupt-remote' || status === 'committed-index-corrupt') return { owned: false, reason: 'ownership-unverified' };
    const controller = new AbortController();
    const signal = this.sessionSignal(sessionId, AbortSignal.any([controller.signal, ...(externalSignal === undefined ? [] : [externalSignal])]));
    const requestRetention = this.retainHistory(sessionId, signal);
    let preparation: PreparationWaiter<RemoteSession | undefined> | undefined;
    if (!options.inspection && record?.enabled === true && !record.detached && this.deps.reader !== undefined && typeof this.deps.reader.observe === 'function') {
      const reader = this.deps.reader;
      try {
        // Enroll BEFORE data IO. This task can only prepare canonical bytes/H;
        // it has no uploader/importer, Native, Ready, lease or input capability.
        preparation = this.jobs.prepare(sessionId, async job => {
          const retention = this.retainHistory(sessionId, job.signal);
          try {
            const context = { signal: job.signal, check: job.check, expectedGeneration: record.generation };
            const observed = await reader.observe(sessionId, context);
            if (observed !== undefined) assertScopedAppliedFloor(record, observed.manifest.entity, reader.scopeId);
            return await reader.read(sessionId, context);
          } finally { retention?.release(); }
        });
      } catch { requestRetention?.release(); return { owned: false, reason: 'ownership-unverified' }; }
    }
    const cancelPreparation = () => preparation?.release();
    externalSignal?.addEventListener('abort', cancelPreparation, { once: true });
    const proof = (async (): Promise<OwnershipProof> => {
      let seconds: 30 | 60 = 60, succeeded = false;
      try {
        if (preparation !== undefined) await this.abortable(preparation.promise, signal);
        this.check(signal);
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
      timer = setTimeout(() => {
        if (!externalSignal?.aborted) preparation?.release(true);
        controller.abort(); resolve({ owned: false, reason: 'ownership-unverified' });
      }, ms);
      timer.unref?.();
    });
    try { return await Promise.race([this.abortable(proof, signal), timeout]); }
    catch (error) {
      if (controller.signal.aborted && !externalSignal?.aborted && !this.lifetime.signal.aborted) return { owned: false, reason: 'ownership-unverified' };
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', cancelPreparation);
      preparation?.release();
      requestRetention?.release();
    }
  }

  /** Check the quiet drain gate; retry once after the two-second quiet window. */
  async drain(sessionId: string): Promise<void> {
    if (this.lifetime.signal.aborted || this.suspension.signal.aborted) return;
    const record = this.deps.local.getSession(sessionId);
    if (this.deps.isOptingOut?.(sessionId) || record?.admissionStopped || record?.mappingUnstable || record?.remoteAuditFailure !== undefined ||
      record?.status === 'corrupt-remote' || record?.status === 'committed-index-corrupt' || (record !== undefined && !this.publicationEligible(record))) return;
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
    assertRecoveryScope(record, this.deps.reader?.scopeId);
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
    if (this.deps.local.getSession(sessionId)?.destination) throw new AzureSyncError('GENERATION_CHANGED', 'Destination-scoped history requires explicit proof-bound generation adoption; legacy resurrection is unavailable.');
    if (this.deps.tombstones === undefined) throw new Error('azure-sync: tombstone manager is not ready.');
    const entrySignal = this.sessionSignal(sessionId, signal);
    const record = this.deps.local.getSession(sessionId);
    assertRecoveryScope(record, this.deps.reader?.scopeId);
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
    await this.deps.tombstones?.repairPending((sessionId) => this.sessionSignal(sessionId), sessionId => {
      const scope = this.deps.reader?.scopeId;
      return scope === undefined || this.deps.local.getSession(sessionId)?.publicationScope === scope;
    });
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
    assertRecoveryScope(record, this.deps.reader?.scopeId);
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
    const result = await this.deps.imports.resume(sessionId, { signal, explicit: true, confirmMapping: options.confirmMapping === true, ...(retained ? { allowDisabledRead: true } : {}) });
    this.check(signal);
    if (result.status === 'complete' || result.status === 'degraded') await this.patch(sessionId, { mappingUnstable: false, needsFolder: false, admissionStopped: false }, signal, record);
  }

  async takeover(sessionId: string, signal?: AbortSignal): Promise<OwnershipProof> {
    this.check(signal);
    await this.ensure();
    const current = this.sessionSignal(sessionId, signal), retention = this.retainHistory(sessionId, current);
    try {
      await this.reconcile(sessionId, signal);
      this.check(signal);
      const record = this.deps.local.getSession(sessionId);
      if (record?.enabled !== true || record.detached || record.admissionStopped || record.status === 'conflict' || record.status === 'remote-ahead-live') throw new AzureSyncError('CONFLICT', 'Only a verified current local copy may take over; cold-catch-up or restart first.');
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
    } finally { retention?.release(); }
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

  private async recordAuditHealth(sessionId: string, expected: LocalSessionRecord, signal: AbortSignal, scope: string, failure?: 'corrupt-remote' | 'committed-index-corrupt'): Promise<void> {
    await this.deps.local.transactSession(sessionId, latest => {
      this.check(signal);
      if (latest === undefined || latest.generation !== expected.generation || latest.publicationScope !== expected.publicationScope ||
        latest.enabled !== expected.enabled || latest.detached !== expected.detached || latest.resurrectionCancellationId !== expected.resurrectionCancellationId ||
        latest.remoteAuditFailure !== expected.remoteAuditFailure || latest.remoteAuditScope !== expected.remoteAuditScope || latest.mappingUnstable !== expected.mappingUnstable ||
        !!latest.admissionStopped !== !!expected.admissionStopped) return undefined;
      if (failure !== undefined) {
        const replaceable = ['setup-needed', 'synced', 'syncing', 'retrying', 'ownership-unverified', 'corrupt-remote', 'committed-index-corrupt'].includes(latest.status);
        return { ...latest, remoteAuditFailure: failure, remoteAuditScope: scope, ...(replaceable ? { status: failure,
          lastError: 'Cloud-copy verification refused damaged or unverifiable committed history; retained cache bytes are not proof of remote health.' } : {}) };
      }
      if (latest.remoteAuditFailure === undefined && latest.status !== 'corrupt-remote' && latest.status !== 'committed-index-corrupt') return undefined;
      if ((latest.remoteAuditScope ?? latest.publicationScope) !== scope) return undefined;
      // Only this explicit fresh row/object bypass can clear remote-health state.
      // Unrelated mapping/conflict/import/degraded blocks and all L stay intact.
      return { ...latest, remoteAuditFailure: undefined, remoteAuditScope: undefined,
        ...(latest.status === 'corrupt-remote' || latest.status === 'committed-index-corrupt' ? { status: 'retrying' as const,
          lastError: 'Cloud bytes verified; local reconciliation and a fresh ownership proof are still required.' } : {}) };
    });
  }

  /** Explicit remote-health audit: no lease, opt-in, Native, Ready or input effects. */
  async verifyCloudCopy(sessionId: string, externalSignal?: AbortSignal): Promise<CloudAuditResult> {
    const signal = this.sessionSignal(sessionId, externalSignal);
    this.check(signal);
    const reader = this.deps.reader;
    if (reader === undefined || typeof reader.audit !== 'function' || typeof reader.auditControl !== 'function') throw new AzureSyncError('TRANSIENT', 'Cloud-copy verification is unavailable.');
    const record = this.deps.local.getSession(sessionId);
    const authority = this.historyAuthority(sessionId);
    const check = () => {
      this.check(signal);
      if (this.historyAuthority(sessionId) !== authority || this.deps.isOptingOut?.(sessionId)) throw new AzureSyncError('CANCELLED', 'The audit scope or local intent changed.');
    };
    let absentUnknownTarget = false;
    try {
      const expectedScope = record?.remoteAuditScope ?? record?.publicationScope;
      const context = { signal, check, allowDisabled: true, ...(record === undefined ? {} : { expectedGeneration: record.generation }),
        ...(expectedScope === undefined ? {} : { expectedScope }) };
      if (expectedScope !== undefined && expectedScope !== reader.scopeId) throw new AzureSyncError('GENERATION_CHANGED', 'This audit belongs to another storage namespace.');
      // The audited control path attributes decode/semantic failures without
      // clearing health, materializing payloads, or relying on cached control.
      check();
      const control = await this.abortable(reader.auditControl(sessionId, context), signal);
      check();
      if (control !== undefined) assertScopedAppliedFloor(record, control.entity, reader.scopeId);
      const remote = await this.abortable(reader.audit(sessionId, context), signal);
      check();
      if (remote === undefined) { absentUnknownTarget = true; throw new AzureSyncError('NOT_FOUND', 'The cloud session does not exist.'); }
      const entity = remote.manifest.entity;
      assertScopedAppliedFloor(this.deps.local.getSession(sessionId), entity, reader.scopeId);
      if (record !== undefined) await this.recordAuditHealth(sessionId, record, signal, reader.scopeId);
      return { status: 'verified', current: true, auditedAt: (this.deps.now ?? Date.now)(), watermark: {
        sessionId: entity.sessionId, schemaVersion: entity.schemaVersion, formatVersion: entity.formatVersion,
        generation: entity.generation, headerHash: entity.headerHash, inheritedEventCount: entity.inheritedEventCount,
        eventCount: entity.eventCount, headSeq: entity.headSeq, headHash: entity.headHash, chainHash: entity.chainHash,
        batchCount: entity.batchCount, rootSessionId: entity.rootSessionId, rootGeneration: entity.rootGeneration,
        ...(entity.lastBatchGeneration === undefined ? {} : { lastBatchGeneration: entity.lastBatchGeneration }),
        ...(entity.lastBatchRowKey === undefined ? {} : { lastBatchRowKey: entity.lastBatchRowKey }),
        ...(entity.lastBatchBlobName === undefined ? {} : { lastBatchBlobName: entity.lastBatchBlobName }),
      } };
    } catch (error) {
      check();
      const code = error instanceof AzureSyncError ? error.code : undefined;
      if (!absentUnknownTarget && record !== undefined && code !== undefined && ['CORRUPT_REMOTE', 'COMMITTED_INDEX_CORRUPT', 'INVALID_RECORD', 'LIMIT', 'NOT_FOUND'].includes(code)) {
        await this.recordAuditHealth(sessionId, record, signal, reader.scopeId, code === 'COMMITTED_INDEX_CORRUPT' ? 'committed-index-corrupt' : 'corrupt-remote');
      }
      throw error;
    }
  }

  status(sessionId: string): { enabled: boolean; status: SyncStatus; record?: LocalSessionRecord } {
    const record = this.deps.local.getSession(sessionId);
    return { enabled: record?.enabled ?? false, status: record?.status ?? 'setup-needed', ...(record === undefined ? {} : { record }) };
  }
}
