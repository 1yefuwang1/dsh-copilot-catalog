/**
 * Generation-scoped cleanup planning; deletion itself is conditional on the
 * tombstone/generation rows selected here.
 * @module @1yefuwang1/dsh-azure-sync/sync/cleanup
 */
import type { BatchRow, CloudSessionEntity } from '../schema.js';
import { canDeleteRow } from './tombstone.js';

export interface CleanupPlan {
  readonly rows: readonly BatchRow[];
  readonly blobNames: readonly string[];
}

export function planCleanup(rows: readonly BatchRow[], entity: Pick<CloudSessionEntity, 'state' | 'generation' | 'previousGeneration'>): CleanupPlan {
  const selected = rows.filter((row) => canDeleteRow(row, entity));
  return { rows: selected, blobNames: selected.map((row) => row.blobName) };
}
