/**
 * Fail-closed cleanup selection: only the tombstoned session/generation's
 * candidate namespace is eligible. Attachments are never selected.
 * @module @1yefuwang1/dsh-azure-sync/sync/cleanup
 */
import { AzureSyncError } from '../azure/errors.js';
import { batchRowKey, encodeKeyPart, type BatchRow, type CloudSessionEntity } from '../schema.js';
import { canDeleteRow } from './tombstone.js';

export interface CleanupPlan {
  readonly rows: readonly BatchRow[];
  readonly blobNames: readonly string[];
}

export function generationBlobPrefix(sessionId: string, generation: number): string {
  // Validate the generation before interpolating it into an object prefix.
  batchRowKey(sessionId, generation, 0);
  return `v1/sessions/${encodeKeyPart(sessionId)}/gen-${generation}/batches/`;
}

export function assertGenerationBlob(name: string, sessionId: string, generation: number): void {
  const prefix = generationBlobPrefix(sessionId, generation);
  if (!name.startsWith(prefix) || !/^\d+-\d+-[a-f0-9]{16}\.jsonl\.gz$/u.test(name.slice(prefix.length))) {
    throw new AzureSyncError('CORRUPT_REMOTE', 'A cleanup blob reference is outside the target session generation.');
  }
}

export function assertGenerationRow(row: BatchRow, sessionId: string, generation: number, partitionKey = row.partitionKey): void {
  if (row.sessionId !== sessionId || row.generation !== generation || row.partitionKey !== partitionKey ||
    row.rowKey !== batchRowKey(sessionId, generation, row.startSeq)) {
    throw new AzureSyncError('CORRUPT_REMOTE', 'A cleanup row does not match its session generation key.');
  }
  assertGenerationBlob(row.blobName, sessionId, generation);
}

export function planCleanup(rows: readonly BatchRow[], entity: Pick<CloudSessionEntity, 'sessionId' | 'partitionKey' | 'state' | 'generation' | 'previousGeneration'>): CleanupPlan {
  const selected = rows.filter((row) => canDeleteRow(row, entity));
  for (const row of selected) assertGenerationRow(row, entity.sessionId, entity.generation, entity.partitionKey);
  return { rows: selected, blobNames: selected.map((row) => row.blobName) };
}
