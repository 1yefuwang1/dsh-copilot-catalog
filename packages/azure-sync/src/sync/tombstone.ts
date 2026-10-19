/**
 * Durable generation-scoped tombstones and explicit resurrection.
 * @module @1yefuwang1/dsh-azure-sync/sync/tombstone
 */
import { AzureSyncError } from '../azure/errors.js';
import type { BatchRow, CloudSessionEntity } from '../schema.js';
import { genesisHash } from './chain.js';

export interface TombstoneResult {
  readonly entity: CloudSessionEntity;
  readonly rowsToDelete: readonly BatchRow[];
}

export function tombstone(entity: CloudSessionEntity, now: number, deviceId = entity.sourceDeviceId): TombstoneResult {
  return {
    entity: {
      ...entity, state: 'deleted', enabled: false,
      writerEpoch: entity.writerEpoch + (entity.state === 'deleted' ? 0 : 1),
      previousGeneration: entity.generation, updatedAt: now,
      deletedAt: entity.deletedAt ?? now, deletedBy: entity.deletedBy ?? deviceId,
      leaseOwner: undefined, leaseUntil: undefined, cleanupPending: true,
    },
    rowsToDelete: [],
  };
}

/** Rows that belong to the tombstoned generation and may be swept. */
export function generationScopedRows(rows: readonly BatchRow[], generation: number): BatchRow[] {
  return rows.filter((row) => row.generation === generation);
}

/** Explicit root action only. Disabled history is retained, never reset. */
export function resurrect(entity: CloudSessionEntity, now: number): CloudSessionEntity {
  if (entity.rootSessionId !== entity.sessionId) {
    throw new AzureSyncError('CONFLICT', 'This action requires the root session.');
  }
  if (entity.state === 'deleted') {
    if (entity.cleanupPending !== false) {
      throw new AzureSyncError('PRECONDITION', 'Cloud removal is pending; resume cleanup before resurrection.');
    }
    const generation = entity.generation + 1;
    const chain = genesisHash(entity.sessionId, generation, entity.headerHash, entity.schemaVersion);
    return {
      ...entity, state: 'active', enabled: true, generation, rootGeneration: generation,
      writerEpoch: entity.writerEpoch + 1, previousGeneration: entity.generation, updatedAt: now,
      eventCount: 0, headSeq: -1, headHash: chain, chainHash: chain, batchCount: 0,
      lastBatchRowKey: undefined, lastBatchGeneration: undefined, lastBatchBlobName: undefined,
      lastWriterDevice: undefined, leaseOwner: undefined, leaseUntil: undefined,
      deletedAt: undefined, deletedBy: undefined, cleanupPending: undefined,
      // A prior generation's activation token must never prove this generation.
      resurrectionId: undefined,
    };
  }
  if (entity.state === 'disabled') {
    return { ...entity, state: 'active', enabled: true, writerEpoch: entity.writerEpoch + 1, updatedAt: now };
  }
  return entity;
}

/** Never authorize cleanup from a resurrected manifest or an active generation. */
export function canDeleteRow(row: BatchRow, current: Pick<CloudSessionEntity, 'state' | 'generation' | 'previousGeneration'>): boolean {
  return current.state === 'deleted' && row.generation === current.generation;
}
