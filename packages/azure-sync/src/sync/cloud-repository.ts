/**
 * Narrow cloud repository: immutable candidate blobs plus the committed
 * batch-row/tip transaction. Logical records are separated from SDK ETags and
 * Edm.Int64 wire values by the schema codec.
 * @module @1yefuwang1/dsh-azure-sync/sync/cloud-repository
 */
import type { TableEntity, TransactionAction } from '@azure/data-tables';
import { AzureSyncError } from '../azure/errors.js';
import type { BlobStore } from '../azure/blob.js';
import type { TableStore } from '../azure/table.js';
import {
  batchRowKey, cloudSessionEntitySchema, batchRowSchema, decodeCloudRecord, encodeCloudRecord, parseRecord,
  encodeKeyPart, sessionRowKey, type BatchBlobMetadata, type BatchRow, type CloudSessionEntity,
} from '../schema.js';
import { batchBlobMetadata } from './blob-metadata.js';
import { assertGenerationBlob, assertGenerationRow, generationBlobPrefix } from './cleanup.js';

export interface StoredBatch {
  readonly entity: BatchRow;
  readonly etag: string;
}

export interface StoredManifest {
  readonly entity: CloudSessionEntity;
  readonly etag: string;
}

export interface CandidatePutResult {
  readonly status: 'created' | 'exists';
}

export function leaseBlobName(sessionId: string): string {
  return `v1/leases/${encodeKeyPart(sessionId)}`;
}

export function candidateBlobName(sessionId: string, generation: number, startSeq: number, createdEpoch: number, payloadHash: string): string {
  return `v1/sessions/${encodeKeyPart(sessionId)}/gen-${generation}/batches/${startSeq}-${createdEpoch}-${payloadHash.slice(0, 16)}.jsonl.gz`;
}

export function batchMetadata(row: BatchRow, headerHash: string): BatchBlobMetadata {
  return batchBlobMetadata({
    startSeq: row.startSeq, endSeq: row.endSeq, eventCount: row.eventCount,
    prevChainHash: row.prevChainHash, chainHash: row.chainHash, headHash: row.headHash,
    headerHash, generation: row.generation, createdEpoch: row.createdEpoch,
    deviceId: row.deviceId, schemaVersion: row.schemaVersion, payloadHash: row.payloadHash,
  });
}

export class CloudRepository {
  readonly blob: BlobStore;
  readonly table: TableStore;
  readonly partitionKey: string;

  constructor(blob: BlobStore, table: TableStore, partitionKey = 'account') {
    this.blob = blob;
    this.table = table;
    this.partitionKey = partitionKey;
  }

  async getManifest(sessionId: string): Promise<StoredManifest | undefined> {
    const stored = await this.table.get<Record<string, unknown>>(this.partitionKey, sessionRowKey(sessionId));
    if (stored === undefined) return undefined;
    const decoded = decodeCloudRecord(cloudSessionEntitySchema, stored.value, 'cloud session manifest');
    if (decoded.etag === undefined) throw new AzureSyncError('INVALID_RECORD', 'A cloud session manifest has no ETag.');
    return { entity: decoded.record, etag: decoded.etag };
  }

  async createManifest(entity: CloudSessionEntity): Promise<boolean> {
    parseRecord(cloudSessionEntitySchema, entity, 'cloud publication manifest');
    if (entity.partitionKey !== this.partitionKey || entity.rowKey !== sessionRowKey(entity.sessionId)) {
      throw new AzureSyncError('INVALID_RECORD', 'The session manifest key does not match its identity.');
    }
    if (entity.rootSessionId === entity.sessionId && entity.rootGeneration !== entity.generation) {
      throw new AzureSyncError('GENERATION_CHANGED', 'The root generation does not match its session generation.');
    }
    try {
      if (entity.rootSessionId === entity.sessionId) {
        return await this.table.insert(encodeCloudRecord(entity) as TableEntity<Record<string, unknown>>);
      }
      const root = await this.getManifest(entity.rootSessionId);
      this.assertActiveRoot(entity, root);
      await this.table.submitTransaction([
        ['create', encodeCloudRecord(entity) as TableEntity<Record<string, unknown>>],
        ['update', encodeCloudRecord(root.entity) as TableEntity<Record<string, unknown>>, 'Replace', { etag: root.etag }],
      ]);
      return true;
    } catch (error) {
      if (error instanceof AzureSyncError && error.code === 'CONFLICT') return false;
      throw error;
    }
  }

  private assertActiveRoot(child: CloudSessionEntity, root: StoredManifest | undefined): asserts root is StoredManifest {
    if (root === undefined || root.entity.sessionId !== child.rootSessionId ||
      root.entity.rootSessionId !== root.entity.sessionId || root.entity.state !== 'active' || !root.entity.enabled ||
      root.entity.generation !== child.rootGeneration || root.entity.rootGeneration !== root.entity.generation) {
      throw new AzureSyncError('GENERATION_CHANGED', 'The child session root is not active in the expected generation.');
    }
  }

  /** Bounded keyset page for the human remote catalog; never return headers or payloads here. */
  async listManifestsPage(input: { readonly cursor?: string; readonly limit: number }, signal?: AbortSignal): Promise<{ items: StoredManifest[]; nextCursor?: string }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new AzureSyncError('LIMIT', 'The manifest page size is invalid.');
    signal?.throwIfAborted();
    let after: string | undefined;
    if (input.cursor !== undefined) {
      if (input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) throw new AzureSyncError('INVALID_RECORD', 'The manifest cursor is invalid.');
      after = Buffer.from(input.cursor, 'base64url').toString('utf8');
      if (Buffer.from(after).toString('base64url') !== input.cursor || !/^session:[A-Za-z0-9_-]+$/u.test(after)) throw new AzureSyncError('INVALID_RECORD', 'The manifest cursor is invalid.');
      const sessionId = Buffer.from(after.slice('session:'.length), 'base64url').toString('utf8');
      if (sessionId.length === 0 || sessionId.length > 256 || sessionRowKey(sessionId) !== after) throw new AzureSyncError('INVALID_RECORD', 'The manifest cursor identity is invalid.');
    }
    const partition = this.partitionKey.replaceAll("'", "''");
    const filter = `PartitionKey eq '${partition}' and RowKey ge 'session:' and RowKey lt 'session;'${after === undefined ? '' : ` and RowKey gt '${after}'`}`;
    const items: StoredManifest[] = [];
    let more = false;
    for await (const stored of this.table.list<Record<string, unknown>>(filter, signal)) {
      signal?.throwIfAborted();
      const decoded = decodeCloudRecord(cloudSessionEntitySchema, stored.value, 'cloud catalog manifest');
      const entity = decoded.record;
      if (decoded.etag === undefined || entity.partitionKey !== this.partitionKey || entity.rowKey !== sessionRowKey(entity.sessionId) ||
          (after !== undefined && entity.rowKey <= after) || (items.length > 0 && entity.rowKey <= items[items.length - 1]!.entity.rowKey)) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud catalog identities or order are invalid.');
      if (items.length === input.limit) { more = true; break; }
      items.push({ entity, etag: decoded.etag });
    }
    const last = items.at(-1);
    return { items, ...(more && last !== undefined ? { nextCursor: Buffer.from(last.entity.rowKey).toString('base64url') } : {}) };
  }

  /** The SDK iterator follows continuation tokens; never materialize the account. */
  async *listDescendants(rootSessionId: string, rootGeneration: number): AsyncGenerator<StoredManifest> {
    const quoted = (value: string): string => value.replaceAll("'", "''");
    const filter = `PartitionKey eq '${quoted(this.partitionKey)}' and rootSessionId eq '${quoted(rootSessionId)}' and rootGeneration eq ${rootGeneration}L`;
    for await (const item of this.table.list<Record<string, unknown>>(filter)) {
      const decoded = decodeCloudRecord(cloudSessionEntitySchema, item.value, 'descendant session manifest');
      const entity = decoded.record;
      if (entity.sessionId === rootSessionId) continue;
      if (entity.partitionKey !== this.partitionKey || entity.rowKey !== sessionRowKey(entity.sessionId) ||
        entity.rootSessionId !== rootSessionId || entity.rootGeneration !== rootGeneration || decoded.etag === undefined) {
        throw new AzureSyncError('CORRUPT_REMOTE', 'A descendant manifest does not match the root generation fence.');
      }
      yield { entity, etag: decoded.etag };
    }
  }

  async updateManifest(entity: CloudSessionEntity, etag: string): Promise<void> {
    parseRecord(cloudSessionEntitySchema, entity, 'cloud publication manifest');
    if (entity.state === 'deleted' && (entity.enabled || entity.leaseOwner !== undefined || entity.leaseUntil !== undefined)) {
      throw new AzureSyncError('INVALID_RECORD', 'A tombstone cannot enable a writer or retain lease mirror fields.');
    }
    if (entity.rootSessionId === entity.sessionId && entity.rootGeneration !== entity.generation) {
      throw new AzureSyncError('GENERATION_CHANGED', 'The root generation does not match its session generation.');
    }
    if (entity.rootSessionId !== entity.sessionId && entity.state === 'active') {
      // Acquisition, renewal, and disabled re-enable must not leave an active
      // child behind a root deletion either, not just batch publication.
      const root = await this.getManifest(entity.rootSessionId);
      this.assertActiveRoot(entity, root);
      await this.table.submitTransaction([
        ['update', encodeCloudRecord(entity) as TableEntity<Record<string, unknown>>, 'Replace', { etag }],
        ['update', encodeCloudRecord(root.entity) as TableEntity<Record<string, unknown>>, 'Replace', { etag: root.etag }],
      ]);
      return;
    }
    await this.table.update(encodeCloudRecord(entity) as TableEntity<Record<string, unknown>>, etag);
  }

  /** Every destructive operation revalidates the exact pending tombstone. */
  async assertCleanup(manifest: StoredManifest): Promise<void> {
    const current = await this.getManifest(manifest.entity.sessionId);
    if (current === undefined || current.etag !== manifest.etag || current.entity.state !== 'deleted' ||
      current.entity.generation !== manifest.entity.generation || current.entity.cleanupPending === false) {
      throw new AzureSyncError('PRECONDITION', 'The tombstone changed before cleanup; re-read and resume removal.');
    }
  }

  async deleteBatchRow(row: StoredBatch, manifest: StoredManifest): Promise<void> {
    assertGenerationRow(row.entity, manifest.entity.sessionId, manifest.entity.generation, this.partitionKey);
    await this.assertCleanup(manifest);
    // The SDK's transaction delete silently discards ETags. Use its conditional
    // standalone delete instead; generation-qualified immutable keys isolate a
    // concurrently resurrected generation even after the manifest read.
    try {
      await this.table.delete(this.partitionKey, row.entity.rowKey, row.etag);
    } catch (error) {
      if (!(error instanceof AzureSyncError && error.code === 'NOT_FOUND')) throw error;
    }
  }

  async deleteBatchBlob(name: string, manifest: StoredManifest): Promise<void> {
    assertGenerationBlob(name, manifest.entity.sessionId, manifest.entity.generation);
    const identity = await this.blob.identity(name);
    await this.assertCleanup(manifest);
    if (identity !== undefined) await this.blob.deleteIfExists(name, identity.etag);
  }

  async *listGenerationBlobs(sessionId: string, generation: number): AsyncGenerator<string> {
    for await (const item of this.blob.list(generationBlobPrefix(sessionId, generation))) {
      assertGenerationBlob(item.name, sessionId, generation);
      yield item.name;
    }
  }

  async deleteLeaseBlob(manifest: StoredManifest): Promise<void> {
    const name = leaseBlobName(manifest.entity.sessionId);
    // Snapshot BEFORE the manifest check. A revived generation creates a fresh
    // object only after cleanupPending is false; its ETag cannot pass this fence.
    const identity = await this.blob.identity(name);
    await this.assertCleanup(manifest);
    if (identity === undefined) return;
    if (identity.leased) await this.blob.breakLeaseIfMatch(name, identity.etag);
    await this.blob.deleteIfExists(name, identity.etag);
  }

  async getBatch(rowKey: string): Promise<BatchRow | undefined> {
    const stored = await this.table.get<Record<string, unknown>>(this.partitionKey, rowKey);
    if (stored === undefined) return undefined;
    return decodeCloudRecord(batchRowSchema, stored.value, 'committed batch row').record;
  }

  async *iterateBatchRows(sessionId: string, generation: number): AsyncGenerator<StoredBatch> {
    const prefix = `batch:${encodeKeyPart(sessionId)}:gen-${generation}:`;
    const filter = `PartitionKey eq '${this.partitionKey.replaceAll("'", "''")}' and RowKey ge '${prefix}' and RowKey lt '${prefix};'`;
    for await (const item of this.table.list<Record<string, unknown>>(filter)) {
      const decoded = decodeCloudRecord(batchRowSchema, item.value, 'committed batch row');
      if (decoded.etag === undefined) throw new AzureSyncError('INVALID_RECORD', 'A cleanup batch row has no ETag.');
      yield { entity: decoded.record, etag: decoded.etag };
    }
  }

  async listBatchRows(sessionId: string, generation: number): Promise<BatchRow[]> {
    const rows: BatchRow[] = [];
    for await (const stored of this.iterateBatchRows(sessionId, generation)) rows.push(stored.entity);
    return rows;
  }

  /** A transaction receipt is not proof that a later manifest still belongs to it. */
  private assertPublicationResult(current: StoredManifest | undefined, proof: StoredManifest, next: CloudSessionEntity): asserts current is StoredManifest {
    if (current === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The committed session manifest disappeared after a transaction.');
    const entity = current.entity;
    if (entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The committed tip changed to a tombstone after publication.');
    if (entity.generation !== next.generation || entity.generation !== proof.entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The committed tip changed generation after publication.');
    if (entity.state !== 'active' || !entity.enabled) throw new AzureSyncError('DISABLED', 'The committed tip changed to a disabled session after publication.');
    if (entity.partitionKey !== this.partitionKey || entity.rowKey !== sessionRowKey(entity.sessionId)) throw new AzureSyncError('CORRUPT_REMOTE', 'The publication response has an invalid session identity.');
    const binding = ['partitionKey', 'rowKey', 'sessionId', 'schemaVersion', 'headerJson', 'headerHash', 'inheritedEventCount', 'formatVersion', 'rootSessionId', 'rootGeneration'] as const;
    if (binding.some(field => entity[field] !== next[field] || entity[field] !== proof.entity[field])) throw new AzureSyncError('CORRUPT_REMOTE', 'The publication response changed its immutable session binding.');
    if (entity.writerEpoch !== next.writerEpoch || entity.writerEpoch !== proof.entity.writerEpoch ||
        entity.leaseOwner !== next.leaseOwner || entity.leaseOwner !== proof.entity.leaseOwner) throw new AzureSyncError('LEASE_LOST', 'The publication response no longer belongs to this writer.');
    const tip = ['eventCount', 'headSeq', 'headHash', 'chainHash', 'batchCount', 'lastBatchRowKey', 'lastBatchGeneration', 'lastBatchBlobName'] as const;
    if (tip.some(field => entity[field] !== next[field])) throw new AzureSyncError('PRECONDITION', 'The committed tip changed after this batch transaction; re-read and retry.');
  }

  /**
   * Commit one immutable batch and advance the tip atomically. A retry that
   * finds its row already linked to the tip is idempotent.
   */
  async commitBatch(manifest: StoredManifest, row: BatchRow, next: CloudSessionEntity, root?: StoredManifest): Promise<StoredManifest> {
    // Reject invalid audit fields/extra properties before an irreversible commit.
    parseRecord(batchRowSchema, row, 'committed publication row');
    parseRecord(cloudSessionEntitySchema, next, 'cloud publication manifest');
    parseRecord(cloudSessionEntitySchema, manifest.entity, 'cloud publication proof');
    if (root !== undefined) parseRecord(cloudSessionEntitySchema, root.entity, 'cloud root proof');
    if (manifest.entity.sessionId !== next.sessionId || manifest.entity.generation !== next.generation ||
      manifest.entity.writerEpoch !== next.writerEpoch || manifest.entity.state !== 'active' || !manifest.entity.enabled ||
      next.state !== 'active' || !next.enabled || row.sessionId !== next.sessionId || row.generation !== next.generation) {
      throw new AzureSyncError('PRECONDITION', 'The manifest is not an active publication fence for this generation.');
    }
    if (next.rootSessionId !== next.sessionId) this.assertActiveRoot(next, root);
    else if (next.rootGeneration !== next.generation) {
      throw new AzureSyncError('GENERATION_CHANGED', 'The root generation does not match the publication generation.');
    }
    const actions: TransactionAction[] = [
      ['create', encodeCloudRecord(row) as TableEntity<Record<string, unknown>>],
      ['update', encodeCloudRecord(next) as TableEntity<Record<string, unknown>>, 'Replace', { etag: manifest.etag }],
      ...(root === undefined ? [] : [['update', encodeCloudRecord(root.entity) as TableEntity<Record<string, unknown>>, 'Replace', { etag: root.etag }] as TransactionAction]),
    ];
    try {
      await this.table.submitTransaction(actions);
    } catch (error) {
      if (!(error instanceof AzureSyncError && (error.code === 'PRECONDITION' || error.code === 'CONFLICT'))) throw error;
      const current = await this.getManifest(row.sessionId);
      this.assertPublicationResult(current, manifest, next);
      if (current.entity.lastBatchRowKey !== row.rowKey || current.entity.chainHash !== row.chainHash) throw new AzureSyncError('PRECONDITION', 'The committed tip changed before this batch transaction; re-read and retry.');
      if (next.rootSessionId !== next.sessionId) this.assertActiveRoot(next, await this.getManifest(next.rootSessionId));
      return current;
    }
    const current = await this.getManifest(row.sessionId);
    this.assertPublicationResult(current, manifest, next);
    if (next.rootSessionId !== next.sessionId) this.assertActiveRoot(next, await this.getManifest(next.rootSessionId));
    return current;
  }

  async putCandidate(name: string, bytes: Uint8Array, metadata: BatchBlobMetadata): Promise<CandidatePutResult> {
    const status = await this.blob.putIfAbsent(name, bytes, metadata as unknown as Record<string, string>);
    return { status };
  }

  async readCandidate(name: string, maxBytes: number): Promise<Buffer> {
    return this.blob.read(name, maxBytes);
  }

  async candidateExists(name: string): Promise<boolean> {
    return this.blob.exists(name);
  }

  /** Fetch the row's current committed tip only (used by server-proof and tests). */
  async currentTip(sessionId: string): Promise<{ rowKey: string; generation: number } | undefined> {
    const manifest = await this.getManifest(sessionId);
    if (manifest?.entity.lastBatchRowKey === undefined || manifest.entity.lastBatchGeneration === undefined) return undefined;
    return { rowKey: manifest.entity.lastBatchRowKey, generation: manifest.entity.lastBatchGeneration };
  }

  batchRowKey(sessionId: string, generation: number, startSeq: number): string {
    return batchRowKey(sessionId, generation, startSeq);
  }
}
