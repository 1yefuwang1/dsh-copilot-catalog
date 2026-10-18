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
  batchRowKey, cloudSessionEntitySchema, batchRowSchema, decodeCloudRecord, encodeCloudRecord,
  encodeKeyPart, sessionRowKey, type BatchBlobMetadata, type BatchRow, type CloudSessionEntity,
} from '../schema.js';
import { batchBlobMetadata } from './blob-metadata.js';

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
    try {
      return await this.table.insert(encodeCloudRecord(entity) as TableEntity<Record<string, unknown>>);
    } catch (error) {
      if (error instanceof AzureSyncError && (error.code === 'CONFLICT' || error.code === 'PRECONDITION')) return false;
      throw error;
    }
  }

  async updateManifest(entity: CloudSessionEntity, etag: string): Promise<void> {
    await this.table.update(encodeCloudRecord(entity) as TableEntity<Record<string, unknown>>, etag);
  }

  async deleteBatchRow(rowKey: string): Promise<void> {
    await this.table.delete(this.partitionKey, rowKey);
  }

  async deleteBatchBlob(name: string): Promise<void> {
    await this.blob.deleteIfExists(name);
  }

  async getBatch(rowKey: string): Promise<BatchRow | undefined> {
    const stored = await this.table.get<Record<string, unknown>>(this.partitionKey, rowKey);
    if (stored === undefined) return undefined;
    return decodeCloudRecord(batchRowSchema, stored.value, 'committed batch row').record;
  }

  async listBatchRows(sessionId: string, generation: number): Promise<BatchRow[]> {
    const prefix = `batch:${encodeKeyPart(sessionId)}:gen-${generation}:`;
    const filter = `PartitionKey eq '${this.partitionKey.replaceAll("'", "''")}' and RowKey ge '${prefix}' and RowKey lt '${prefix};'`;
    const rows: BatchRow[] = [];
    for await (const item of this.table.list<Record<string, unknown>>(filter)) {
      rows.push(decodeCloudRecord(batchRowSchema, item.value, 'committed batch row').record);
    }
    return rows;
  }

  /**
   * Commit one immutable batch and advance the tip atomically. A retry that
   * finds its row already linked to the tip is idempotent.
   */
  async commitBatch(manifest: StoredManifest, row: BatchRow, next: CloudSessionEntity, root?: StoredManifest): Promise<StoredManifest> {
    if (next.rootSessionId !== next.sessionId) {
      if (root === undefined || root.entity.state !== 'active' || root.entity.generation !== next.rootGeneration) {
        throw new AzureSyncError('LEASE_LOST', 'The child session root is not active in the expected generation.');
      }
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
      if (current !== undefined && current.entity.lastBatchRowKey === row.rowKey && current.entity.chainHash === row.chainHash) return current;
      throw new AzureSyncError('PRECONDITION', 'The committed tip changed before this batch transaction; re-read and retry.', { cause: { name: 'Error' } });
    }
    const current = await this.getManifest(row.sessionId);
    if (current === undefined) throw new AzureSyncError('CORRUPT_REMOTE', 'The committed session manifest disappeared after a transaction.');
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
