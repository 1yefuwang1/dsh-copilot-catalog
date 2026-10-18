/**
 * Generation-scoped tombstones and resurrection. Old-generation rows are never
 * selected, deleted across generations, or allowed to block a new generation.
 * @module @1yefuwang1/dsh-azure-sync/sync/tombstone
 */
import type { BatchRow, CloudSessionEntity } from '../schema.js';

export interface TombstoneResult {
  readonly entity: CloudSessionEntity;
  readonly rowsToDelete: readonly BatchRow[];
}

export function tombstone(entity: CloudSessionEntity, now: number): TombstoneResult {
  const tombstoned: CloudSessionEntity = {
    ...entity,
    state: 'deleted',
    enabled: false,
    writerEpoch: entity.writerEpoch + 1,
    previousGeneration: entity.generation,
    updatedAt: now,
  };
  return { entity: tombstoned, rowsToDelete: [] };
}

/** Rows that belong to the tombstoned generation and may be swept. */
export function generationScopedRows(rows: readonly BatchRow[], generation: number): BatchRow[] {
  return rows.filter((row) => row.generation === generation);
}

/** Resurrect explicitly; never on an offline reconnect. */
export function resurrect(entity: CloudSessionEntity, now: number): CloudSessionEntity {
  if (entity.state === 'deleted') {
    return {
      ...entity, state: 'active', enabled: true, generation: entity.generation + 1,
      writerEpoch: entity.writerEpoch + 1, previousGeneration: entity.generation, updatedAt: now,
    };
  }
  if (entity.state === 'disabled') return { ...entity, state: 'active', enabled: true, updatedAt: now };
  return entity;
}

/** A delayed cleanup of an old generation can never touch the current one. */
export function canDeleteRow(row: BatchRow, current: Pick<CloudSessionEntity, 'state' | 'generation' | 'previousGeneration'>): boolean {
  if (current.state === 'deleted') return row.generation === current.generation;
  return row.generation === current.previousGeneration && row.generation !== current.generation;
}
