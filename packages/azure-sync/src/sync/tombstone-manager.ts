/**
 * Root-first durable cloud removal. A failed sweep leaves a resumable tombstone,
 * never a false success; local history and shared attachments are retained.
 * @module @1yefuwang1/dsh-azure-sync/sync/tombstone-manager
 */
import { randomUUID } from 'node:crypto';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import { AzureSyncError } from '../azure/errors.js';
import { leaseBlobName, type CloudRepository, type StoredManifest } from './cloud-repository.js';
import type { LocalStore } from '../local/store.js';
import {
  cloudSessionEntitySchema, parseRecord, resurrectionIntentSchema, sessionRowKey,
  type CloudSessionEntity, type LocalSessionRecord, type ResurrectionIntent,
} from '../schema.js';
import { canonicalJson } from './canonical.js';
import { genesisHash, headerHash } from './chain.js';
import { assertGenerationRow } from './cleanup.js';
import { selectCommittedChain } from './committed-index.js';
import { resurrect, tombstone } from './tombstone.js';
import { assertRecoveryScope } from './runtime-history-floor.js';

/** Explicit re-upload may bind fresh canonical bytes only in a NEW generation. */
export interface ReuploadHeader {
  readonly header: SessionHeader;
  readonly inheritedEventCount: number;
}

export type ConfirmHistoryActivation = (intent: ResurrectionIntent, receipt: StoredManifest,
  context: { readonly signal?: AbortSignal; readonly check: () => void }) => Promise<void>;

export interface ResurrectionRepairReport {
  readonly repaired: readonly string[];
  readonly failed: readonly string[];
}

type TombstoneLocalStore = Pick<LocalStore, 'getSession' | 'listSessions' | 'transactSession'>;
interface LocalMutationFence {
  readonly generation: number;
  readonly cancellationId?: string;
  readonly resurrectionId?: string;
  readonly publicationScope?: string;
}

export class TombstoneManager {
  private readonly repository: CloudRepository;
  private readonly local: TombstoneLocalStore;
  private readonly now: () => number;
  private readonly deviceId?: string;
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(repository: CloudRepository, local: TombstoneLocalStore, now: () => number, deviceId?: string,
    private readonly confirmHistoryActivation?: ConfirmHistoryActivation, private readonly scope?: string) {
    this.repository = repository;
    this.local = local;
    this.now = now;
    this.deviceId = deviceId;
  }

  private exclusive<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const next = previous.then(action, action);
    this.operations.set(sessionId, next);
    void next.finally(() => { if (this.operations.get(sessionId) === next) this.operations.delete(sessionId); }).catch(() => undefined);
    return next;
  }

  private async requireRoot(sessionId: string, generation?: number): Promise<StoredManifest> {
    assertRecoveryScope(this.local.getSession(sessionId), this.scope);
    const manifest = await this.repository.getManifest(sessionId);
    if (manifest === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud session does not exist.');
    if (manifest.entity.rootSessionId !== sessionId) throw new AzureSyncError('CONFLICT', 'This action requires the root session.');
    if (manifest.entity.rootGeneration !== manifest.entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The root generation fence is invalid.');
    if (generation !== undefined && manifest.entity.generation !== generation) {
      throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed before this action.');
    }
    return manifest;
  }

  private localFence(record: LocalSessionRecord): LocalMutationFence {
    return { generation: record.generation, cancellationId: record.resurrectionCancellationId,
      resurrectionId: record.resurrectionIntent?.operationId, publicationScope: record.publicationScope };
  }

  private matchesFence(record: LocalSessionRecord | undefined, fence: LocalMutationFence | undefined): record is LocalSessionRecord {
    return record !== undefined && fence !== undefined && record.generation === fence.generation &&
      record.resurrectionCancellationId === fence.cancellationId && record.resurrectionIntent?.operationId === fence.resurrectionId &&
      record.publicationScope === fence.publicationScope && (this.scope === undefined || record.publicationScope === undefined || record.publicationScope === this.scope);
  }

  private removalFences(): ReadonlyMap<string, LocalMutationFence> {
    return new Map([...this.local.listSessions()].map(([id, record]) => [id, this.localFence(record)]));
  }

  private async markDeleted(manifest: StoredManifest, fence: LocalMutationFence | undefined): Promise<StoredManifest> {
    const dead = tombstone(manifest.entity, this.now(), this.deviceId).entity;
    await this.repository.updateManifest(dead, manifest.etag);
    const stored = await this.repository.getManifest(dead.sessionId);
    if (stored === undefined || stored.entity.generation !== dead.generation || stored.entity.state !== 'deleted' || stored.entity.cleanupPending !== true) {
      throw new AzureSyncError('PRECONDITION', 'The tombstone changed before removal could resume.');
    }
    await this.persistDeleted(stored.entity, true, fence);
    return stored;
  }

  private async persistDeleted(entity: CloudSessionEntity, pending: boolean, fence: LocalMutationFence | undefined): Promise<void> {
    await this.local.transactSession(entity.sessionId, record => {
      // Cloud cleanup is generation-fenced separately. Its delayed diagnostics
      // are not authority to overwrite a newer local on/off/detach or create a row.
      if (!this.matchesFence(record, fence) || record.generation !== entity.generation) return undefined;
      return { ...record, state: 'deleted', enabled: false, detached: false, admissionStopped: true, status: 'removed-remotely',
        generation: entity.generation, writerEpoch: entity.writerEpoch, remoteETag: undefined,
        deletedAt: entity.deletedAt, deletedBy: entity.deletedBy, previousGeneration: entity.previousGeneration,
        cleanupPending: pending, admissionReceipt: undefined, lastAttemptAt: this.now(),
        lastError: pending ? 'Cloud removal is pending; retry removal to finish generation cleanup.' : undefined };
    });
  }

  private async sweep(manifest: StoredManifest): Promise<void> {
    const { sessionId, generation } = manifest.entity;
    for await (const stored of this.repository.iterateBatchRows(sessionId, generation)) {
      assertGenerationRow(stored.entity, sessionId, generation, manifest.entity.partitionKey);
      // Never lose the only row reference when a blob delete fails.
      await this.repository.deleteBatchBlob(stored.entity.blobName, manifest);
      await this.repository.deleteBatchRow(stored, manifest);
    }
    // Includes uncommitted candidates and blobs whose row deletion was persisted
    // by an earlier process. Both SDK iterators follow continuation tokens.
    for await (const name of this.repository.listGenerationBlobs(sessionId, generation)) {
      await this.repository.deleteBatchBlob(name, manifest);
    }
    await this.repository.deleteLeaseBlob(manifest);
  }

  private async complete(manifest: StoredManifest, fence: LocalMutationFence | undefined): Promise<void> {
    await this.repository.assertCleanup(manifest);
    const complete = { ...manifest.entity, cleanupPending: false, updatedAt: this.now() };
    await this.repository.updateManifest(complete, manifest.etag);
    await this.persistDeleted(complete, false, fence);
  }

  remove(sessionId: string, generation: number): Promise<void> {
    const fences = this.removalFences();
    return this.exclusive(sessionId, () => this.removeImpl(sessionId, generation, fences));
  }

  private async removeImpl(sessionId: string, generation: number, fences: ReadonlyMap<string, LocalMutationFence>): Promise<void> {
    const root = await this.markDeleted(await this.requireRoot(sessionId, generation), fences.get(sessionId));
    let failure: unknown;
    // First fence ALL descendants, before deleting any history. The root CAS
    // already prevents a racing child create or commit via the root touch.
    for await (const child of this.repository.listDescendants(sessionId, root.entity.rootGeneration)) {
      try {
        await this.repository.assertCleanup(root);
        await this.markDeleted(child, fences.get(child.entity.sessionId));
      } catch (error) { failure ??= error; }
    }
    for await (const child of this.repository.listDescendants(sessionId, root.entity.rootGeneration)) {
      try {
        await this.repository.assertCleanup(root);
        if (child.entity.state !== 'deleted' || child.entity.cleanupPending !== true) {
          throw new AzureSyncError('PRECONDITION', 'A descendant was not durably tombstoned. Retry root removal.');
        }
        await this.sweep(child);
        await this.complete(child, fences.get(child.entity.sessionId));
      } catch (error) { failure ??= error; }
    }
    try { await this.sweep(root); } catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
    await this.complete(root, fences.get(sessionId));
  }

  /** Startup finishes ONLY recorded explicit intents; one bad record cannot starve other threads. */
  async repairPending(signalForSession?: (sessionId: string) => AbortSignal, eligible?: (sessionId: string) => boolean): Promise<ResurrectionRepairReport> {
    const repaired: string[] = [];
    const failed: string[] = [];
    // Capture the complete repair cohort's signals before the first queued IO.
    const pending = [...this.local.listSessions()].filter(([, record]) => record.resurrectionIntent !== undefined)
      .map(([sessionId]) => ({ sessionId, signal: signalForSession?.(sessionId) }));
    for (const { sessionId, signal } of pending) {
      try {
        await this.exclusive(sessionId, async () => {
          assertRecoveryScope(this.local.getSession(sessionId), this.scope, true);
          if (eligible?.(sessionId) === false) throw new AzureSyncError('OWNERSHIP_UNVERIFIED', 'Automatic recovery has no matching namespace consent.');
          const intent = this.local.getSession(sessionId)?.resurrectionIntent;
          if (intent !== undefined) { await this.recoverResurrection(sessionId, intent, signal); repaired.push(sessionId); }
        });
      } catch { failed.push(sessionId); }
    }
    return { repaired, failed };
  }

  private async compensateCancellation(sessionId: string, intent: ResurrectionIntent): Promise<void> {
    try { assertRecoveryScope(this.local.getSession(sessionId), this.scope); } catch { return; }
    const current = await this.repository.getManifest(sessionId);
    if (current === undefined) return;
    const entity = current.entity;
    const target = intent.target;
    // A newer user intent may have cleared the local token while our activation
    // CAS was in flight. Fence ONLY that untouched activation, never a newer
    // lease owner, committed tip, operation token, or generation.
    if (entity.resurrectionId !== intent.operationId || entity.generation !== intent.targetGeneration ||
      entity.partitionKey !== target.partitionKey || entity.rowKey !== target.rowKey || entity.schemaVersion !== target.schemaVersion ||
      entity.sessionId !== sessionId || entity.rootSessionId !== sessionId || entity.rootGeneration !== intent.targetGeneration ||
      entity.state !== 'active' || !entity.enabled || entity.writerEpoch !== target.writerEpoch ||
      entity.leaseOwner !== undefined || entity.leaseUntil !== undefined ||
      entity.headerJson !== target.headerJson || entity.headerHash !== target.headerHash ||
      entity.inheritedEventCount !== target.inheritedEventCount || entity.previousGeneration !== target.previousGeneration ||
      entity.eventCount !== target.eventCount || entity.headSeq !== target.headSeq ||
      entity.headHash !== target.headHash || entity.chainHash !== target.chainHash || entity.batchCount !== target.batchCount ||
      entity.lastBatchRowKey !== target.lastBatchRowKey || entity.lastBatchGeneration !== target.lastBatchGeneration ||
      entity.lastBatchBlobName !== target.lastBatchBlobName) return;
    try {
      await this.repository.updateManifest({ ...entity, state: 'disabled', enabled: false,
        writerEpoch: entity.writerEpoch + 1, updatedAt: this.now() }, current.etag);
    } catch (error) {
      // Losing the exact ETag means a newer actor won; do not chase or fence it.
      if (!(error instanceof AzureSyncError && error.code === 'PRECONDITION')) throw error;
    }
  }

  private async terminalize(sessionId: string, intent: ResurrectionIntent, fence: LocalMutationFence | undefined, error: unknown, signal?: AbortSignal): Promise<void> {
    if (!(error instanceof AzureSyncError)) return; // local writes / unknown transport failures remain retryable
    const statuses: Partial<Record<AzureSyncError['code'], LocalSessionRecord['status']>> = {
      GENERATION_CHANGED: 'generation-changed', REMOVED_REMOTELY: 'removed-remotely', DISABLED: 'detached',
      CONFLICT: 'conflict', PRECONDITION: 'conflict', NOT_FOUND: 'remote-missing',
      INVALID_RECORD: 'corrupt-remote', CORRUPT_REMOTE: 'corrupt-remote',
      COMMITTED_INDEX_CORRUPT: 'committed-index-corrupt', PROVENANCE_MISMATCH: 'conflict',
    };
    const status = statuses[error.code];
    if (status === undefined) return; // auth/transient errors retain their durable explicit intent
    if (error.code === 'PRECONDITION') {
      // An ambiguous CAS response may actually have committed our token. Do not
      // discard that recovery proof, nor mistake a still-current source for loss.
      const current = await this.repository.getManifest(sessionId);
      if (current?.entity.resurrectionId === intent.operationId || (current?.etag === intent.sourceETag &&
        current.entity.generation === intent.priorGeneration && current.entity.state === intent.priorState)) return;
    }
    await this.local.transactSession(sessionId, record => {
      this.checkCancelled(signal);
      if (!this.matchesFence(record, fence) || record.resurrectionIntent?.operationId !== intent.operationId) return undefined;
      return { ...record, enabled: false, detached: false, admissionStopped: true, resurrectionIntent: undefined, status,
        lastError: 'The explicit cloud resurrection can no longer be recovered. Local history and generation were retained; resolve this stopped session explicitly.' };
    });
  }

  private async recoverResurrection(sessionId: string, intent: ResurrectionIntent, signal?: AbortSignal): Promise<CloudSessionEntity> {
    const observed = this.local.getSession(sessionId);
    if (observed?.destination) throw new AzureSyncError('GENERATION_CHANGED', 'Destination-scoped generation adoption is unavailable; retain the original placement and generation.');
    const fence = observed === undefined ? undefined : this.localFence(observed);
    try { return await this.finishResurrection(sessionId, intent, signal); }
    catch (error) {
      const record = this.local.getSession(sessionId);
      if (signal?.aborted || (error instanceof AzureSyncError && error.code === 'CANCELLED') ||
        (record?.resurrectionIntent?.operationId !== intent.operationId && record?.enabled !== true)) {
        // Also handle an ambiguous/lost CAS response after a newer off cleared
        // the token: the response error must not skip late-activation fencing.
        await this.compensateCancellation(sessionId, intent);
        throw new AzureSyncError('CANCELLED', 'A newer explicit off or detach cancelled this resurrection.');
      }
      await this.terminalize(sessionId, intent, fence, error, signal);
      throw error;
    }
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AzureSyncError('CANCELLED', 'The explicit resurrection was cancelled by a newer session action.');
  }

  private pendingRecord(sessionId: string, intent: ResurrectionIntent, signal?: AbortSignal, fence?: LocalMutationFence): LocalSessionRecord {
    assertRecoveryScope(this.local.getSession(sessionId), this.scope);
    this.checkCancelled(signal);
    const record = this.local.getSession(sessionId);
    if (record?.resurrectionIntent?.operationId !== intent.operationId || (fence !== undefined && !this.matchesFence(record, fence))) {
      throw new AzureSyncError('CANCELLED', 'The explicit resurrection intent was cancelled or replaced.');
    }
    if (record.generation !== intent.priorGeneration) {
      throw new AzureSyncError('GENERATION_CHANGED', 'The local generation changed during resurrection repair.');
    }
    return record;
  }

  private assertIntent(sessionId: string, intent: ResurrectionIntent): void {
    const target = intent.target;
    const wasDeleted = intent.priorState === 'deleted';
    if (target.sessionId !== sessionId || target.rowKey !== sessionRowKey(sessionId) ||
      target.resurrectionId !== intent.operationId || target.generation !== intent.targetGeneration ||
      target.rootSessionId !== sessionId || target.rootGeneration !== intent.targetGeneration ||
      target.state !== 'active' || !target.enabled ||
      intent.targetGeneration !== intent.priorGeneration + (wasDeleted ? 1 : 0) ||
      (wasDeleted && target.previousGeneration !== intent.priorGeneration)) {
      throw new AzureSyncError('INVALID_RECORD', 'The explicit resurrection intent has an invalid generation or root proof.');
    }
    let header: SessionHeader;
    try { header = JSON.parse(target.headerJson) as SessionHeader; }
    catch { throw new AzureSyncError('INVALID_RECORD', 'The resurrection header is not valid JSON.'); }
    if (header === null || typeof header !== 'object' || header.id !== sessionId || header.version !== target.formatVersion ||
      headerHash(header, target.inheritedEventCount) !== target.headerHash ||
      genesisHash(sessionId, target.generation, target.headerHash, target.schemaVersion) !== intent.genesisHash) {
      throw new AzureSyncError('INVALID_RECORD', 'The resurrection header, cut, or genesis commitment is invalid.');
    }
    if (wasDeleted && (target.eventCount !== 0 || target.headSeq !== -1 || target.batchCount !== 0 ||
      target.chainHash !== intent.genesisHash || target.headHash !== intent.genesisHash ||
      target.lastBatchRowKey !== undefined || target.lastBatchGeneration !== undefined || target.lastBatchBlobName !== undefined)) {
      throw new AzureSyncError('INVALID_RECORD', 'A new resurrection generation must start at its recorded genesis.');
    }
  }

  private async verifyCompletion(manifest: StoredManifest, intent: ResurrectionIntent): Promise<void> {
    const entity = manifest.entity;
    const target = intent.target;
    if (entity.generation !== intent.targetGeneration) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed after the explicit resurrection.');
    if (entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The resurrected cloud generation was removed again.');
    if (entity.state !== 'active' || !entity.enabled) throw new AzureSyncError('DISABLED', 'The resurrected cloud generation was disabled again.');
    if (entity.resurrectionId !== intent.operationId || entity.partitionKey !== target.partitionKey ||
      entity.rowKey !== target.rowKey || entity.sessionId !== target.sessionId ||
      entity.rootSessionId !== target.rootSessionId || entity.rootGeneration !== target.rootGeneration ||
      entity.previousGeneration !== target.previousGeneration || entity.schemaVersion !== target.schemaVersion ||
      entity.headerJson !== target.headerJson || entity.headerHash !== target.headerHash ||
      entity.inheritedEventCount !== target.inheritedEventCount || entity.formatVersion !== target.formatVersion ||
      entity.cwd !== target.cwd || entity.writerEpoch < target.writerEpoch ||
      genesisHash(entity.sessionId, entity.generation, entity.headerHash, entity.schemaVersion) !== intent.genesisHash) {
      throw new AzureSyncError('GENERATION_CHANGED', 'The cloud activation does not match this explicit resurrection intent.');
    }
    // Tip/epoch progression in THIS operation's generation is allowed, but must
    // still link to its recorded genesis and retained disabled tip. This is not
    // a local/remote raw-prefix proof: new-generation checkpoints remain unset.
    const rows = entity.eventCount === 0 ? [] : await this.repository.listBatchRows(entity.sessionId, entity.generation);
    const chain = selectCommittedChain(entity, rows);
    for (const row of chain.rows) assertGenerationRow(row, entity.sessionId, entity.generation, entity.partitionKey);
    const tip = chain.rows.at(-1);
    if (entity.headSeq !== entity.eventCount - 1 || entity.batchCount !== chain.rows.length ||
      entity.headHash !== (tip?.headHash ?? intent.genesisHash) ||
      entity.lastBatchBlobName !== tip?.blobName || entity.lastBatchGeneration !== (tip === undefined ? undefined : entity.generation)) {
      throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', 'The resurrected cloud tip does not match its committed ancestry.');
    }
    if (intent.priorState === 'disabled' && target.eventCount > 0) {
      const retained = chain.rows.find((row) => row.rowKey === target.lastBatchRowKey);
      if (retained === undefined || retained.endSeq !== target.headSeq || retained.endSeq + 1 !== target.eventCount ||
        retained.chainHash !== target.chainHash || retained.headHash !== target.headHash ||
        retained.blobName !== target.lastBatchBlobName || target.lastBatchGeneration !== entity.generation ||
        chain.rows.indexOf(retained) + 1 !== target.batchCount) {
        throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', 'Re-enable no longer retains the exact recorded disabled history.');
      }
    } else if (target.eventCount === 0 && (target.chainHash !== intent.genesisHash || target.headHash !== intent.genesisHash)) {
      throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', 'The recorded empty activation does not match genesis.');
    }
  }

  private async finishResurrection(sessionId: string, saved: ResurrectionIntent, signal?: AbortSignal): Promise<CloudSessionEntity> {
    const intent = parseRecord(resurrectionIntentSchema, saved, 'local resurrection intent');
    this.assertIntent(sessionId, intent);
    const initial = this.pendingRecord(sessionId, intent, signal);
    const fence = this.localFence(initial);
    let manifest = await this.requireRoot(sessionId);
    this.pendingRecord(sessionId, intent, signal, fence);
    if (manifest.entity.resurrectionId !== intent.operationId) {
      if (manifest.entity.generation !== intent.priorGeneration) {
        throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed before the recorded resurrection completed.');
      }
      if (manifest.etag !== intent.sourceETag || manifest.entity.state !== intent.priorState ||
        manifest.entity.partitionKey !== intent.target.partitionKey) {
        throw new AzureSyncError('PRECONDITION', 'The recorded resurrection lost its original manifest fence.');
      }
      if (intent.priorState === 'deleted') {
        if (manifest.entity.cleanupPending !== false) throw new AzureSyncError('PRECONDITION', 'Resurrection cleanup is no longer complete.');
        // Recreating a missing lease is safe only behind the original tombstone
        // ETag; old cleanup must still pass its own exact tombstone/blob fences.
        await this.repository.blob.ensureEmptyBlob(leaseBlobName(sessionId));
      }
      this.pendingRecord(sessionId, intent, signal, fence);
      await this.repository.updateManifest(intent.target, intent.sourceETag);
      this.pendingRecord(sessionId, intent, signal, fence);
      manifest = await this.requireRoot(sessionId);
    }
    this.pendingRecord(sessionId, intent, signal, fence);
    await this.verifyCompletion(manifest, intent);
    // A newer explicit off/detach may clear the intent during any cloud await.
    // Never re-enable from a stale saved copy after that cancellation.
    this.pendingRecord(sessionId, intent, signal, fence);
    if (intent.priorState === 'deleted' && this.confirmHistoryActivation !== undefined) {
      // A proof-bound explicit generation activation is the only way to move H
      // across generations. Keep the intent durable if pin/checkpoint IO fails.
      await this.confirmHistoryActivation(intent, manifest, {
        ...(signal === undefined ? {} : { signal }),
        check: () => { this.pendingRecord(sessionId, intent, signal, fence); },
      });
      this.pendingRecord(sessionId, intent, signal, fence);
    }
    const revived = manifest.entity;
    const completed = await this.local.transactSession(sessionId, record => {
      this.checkCancelled(signal);
      if (!this.matchesFence(record, fence) || record.resurrectionIntent?.operationId !== intent.operationId ||
        record.generation !== intent.priorGeneration || record.enabled || record.detached || record.state !== intent.priorState) {
        throw new AzureSyncError('CANCELLED', 'The latest local permission no longer authorizes this resurrection checkpoint.');
      }
      return {
        ...record, state: 'active', enabled: true, detached: false, admissionStopped: false, generation: revived.generation,
        writerEpoch: revived.writerEpoch, status: 'setup-needed', lastError: undefined,
        remoteETag: undefined, admissionReceipt: undefined, resurrectionIntent: undefined,
        deletedAt: undefined, deletedBy: undefined, cleanupPending: undefined,
        previousGeneration: revived.previousGeneration,
        ...(intent.priorState === 'deleted' ? {
          lastSyncedEventCount: undefined, lastSyncedChainHash: undefined, lastSyncedHeaderHash: undefined,
          lastSyncedAt: undefined, lastAttemptAt: undefined, importState: undefined, catchUpPending: false,
          importExpectedCount: undefined, importExpectedChainHash: undefined, importAppendedCount: undefined,
          importMappingId: undefined, importMappingRevision: undefined, importedThroughSeq: undefined,
          imported: false, canonicalCwd: revived.cwd,
          degradedAttachments: [], degradedAcknowledged: false, conflictBackupPath: undefined,
        } : {}),
      };
    });
    if (completed === undefined) throw new AzureSyncError('CANCELLED', 'The local resurrection checkpoint was not committed.');
    this.checkCancelled(signal);
    return revived;
  }

  resurrect(sessionId: string, expectedGeneration?: number, reuploadHeader?: ReuploadHeader, signal?: AbortSignal): Promise<CloudSessionEntity> {
    // Capture at invocation, not after the exclusive queue: a newer explicit off
    // must also cancel an older resurrection waiting to start or finish cleanup.
    const entry = this.local.getSession(sessionId);
    if (entry?.destination) return Promise.reject(new AzureSyncError('GENERATION_CHANGED', 'Destination-scoped generation adoption is unavailable; legacy resurrection cannot change it.'));
    const cancellationId = entry?.resurrectionCancellationId;
    const entryFence = entry === undefined ? undefined : this.localFence(entry);
    const fences = this.removalFences();
    return this.exclusive(sessionId, async () => {
      assertRecoveryScope(this.local.getSession(sessionId), this.scope);
      this.checkCancelled(signal);
      if (this.local.getSession(sessionId)?.resurrectionCancellationId !== cancellationId) {
        throw new AzureSyncError('CANCELLED', 'A newer explicit off or detach cancelled this queued resurrection.');
      }
      const saved = this.local.getSession(sessionId)?.resurrectionIntent;
      if (saved !== undefined) {
        if (expectedGeneration !== undefined && expectedGeneration !== saved.priorGeneration && expectedGeneration !== saved.targetGeneration) {
          throw new AzureSyncError('GENERATION_CHANGED', 'The expected generation does not match the recorded explicit resurrection.');
        }
        if (reuploadHeader !== undefined && (saved.priorState !== 'deleted' ||
          canonicalJson(reuploadHeader.header) !== saved.target.headerJson ||
          headerHash(reuploadHeader.header, reuploadHeader.inheritedEventCount) !== saved.target.headerHash ||
          reuploadHeader.inheritedEventCount !== saved.target.inheritedEventCount)) {
          throw new AzureSyncError('PROVENANCE_MISMATCH', 'The retry header does not match the recorded explicit resurrection.');
        }
        return this.recoverResurrection(sessionId, saved, signal);
      }
      let manifest = await this.requireRoot(sessionId, expectedGeneration ?? this.local.getSession(sessionId)?.generation);
      this.checkCancelled(signal);
      const wasDeleted = manifest.entity.state === 'deleted';
      if (reuploadHeader !== undefined && !wasDeleted) {
        throw new AzureSyncError('PRECONDITION', 'Only a deleted session may reset the canonical header in a new generation.');
      }
      if (reuploadHeader !== undefined && reuploadHeader.header.id !== sessionId) {
        throw new AzureSyncError('INVALID_RECORD', 'The re-upload header does not match the root session identity.');
      }
      if (manifest.entity.state === 'active') return manifest.entity;
      if (this.local.getSession(sessionId) === undefined) throw new AzureSyncError('NOT_FOUND', 'A durable local sync record is required for explicit resurrection.');
      if (wasDeleted) {
        // Even an already-complete tombstone is swept again: retry after a crash
        // must also collect any delayed uncommitted old-generation candidates.
        await this.removeImpl(sessionId, manifest.entity.generation, fences);
        this.checkCancelled(signal);
        manifest = await this.requireRoot(sessionId, manifest.entity.generation);
        this.checkCancelled(signal);
      }
      let revived = resurrect(manifest.entity, this.now());
      if (reuploadHeader !== undefined) {
        const binding = headerHash(reuploadHeader.header, reuploadHeader.inheritedEventCount);
        const chain = genesisHash(sessionId, revived.generation, binding, revived.schemaVersion);
        // Fresh canonical bytes are allowed ONLY in the explicitly new generation.
        revived = { ...revived, headerJson: canonicalJson(reuploadHeader.header), headerHash: binding,
          inheritedEventCount: reuploadHeader.inheritedEventCount, formatVersion: reuploadHeader.header.version,
          cwd: reuploadHeader.header.cwd, chainHash: chain, headHash: chain };
      }
      const operationId = randomUUID();
      revived = parseRecord(cloudSessionEntitySchema, { ...revived, resurrectionId: operationId }, 'resurrected cloud session');
      const intent = parseRecord(resurrectionIntentSchema, {
        operationId, priorGeneration: manifest.entity.generation, targetGeneration: revived.generation,
        priorState: wasDeleted ? 'deleted' : 'disabled', sourceETag: manifest.etag,
        genesisHash: genesisHash(sessionId, revived.generation, revived.headerHash, revived.schemaVersion), target: revived,
      }, 'local resurrection intent');
      this.assertIntent(sessionId, intent);
      this.checkCancelled(signal);
      // Evaluate authority again INSIDE the shared SDK write lane. A read before
      // awaiting this transaction cannot authorize a stale plan or recreate a row.
      const planned = await this.local.transactSession(sessionId, record => {
        this.checkCancelled(signal);
        if (!this.matchesFence(record, entryFence) || record.resurrectionCancellationId !== cancellationId ||
          record.generation !== intent.priorGeneration || record.resurrectionIntent !== undefined) {
          throw new AzureSyncError('CANCELLED', 'The latest local permission no longer authorizes this resurrection plan.');
        }
        return { ...record, enabled: false, detached: false, admissionStopped: true, state: intent.priorState,
          status: wasDeleted ? 'removed-remotely' : 'detached', resurrectionIntent: intent,
          lastError: 'Explicit cloud resurrection is pending; retry or restart to finish the local checkpoint.' };
      });
      if (planned === undefined) throw new AzureSyncError('CANCELLED', 'The local resurrection plan was not committed.');
      return this.recoverResurrection(sessionId, intent, signal);
    });
  }
}

export type { LocalSessionRecord };
