/**
 * Write-ahead import state machine. A session is continuable only from
 * `complete`; `degraded` remains blocked until the user acknowledges missing
 * attachments. Failed states are never treated as synced.
 * @module @1yefuwang1/dsh-azure-sync/sync/import-state
 */
import { AzureSyncError } from '../azure/errors.js';
import { importStateSchema, parseRecord, type ImportState } from '../schema.js';

const transitions: Readonly<Record<ImportState, readonly ImportState[]>> = Object.freeze({
  planned: ['creating', 'failed'],
  creating: ['appending', 'failed'],
  appending: ['attachments', 'failed'],
  attachments: ['warming', 'degraded', 'failed'],
  warming: ['complete', 'degraded', 'failed'],
  complete: [],
  degraded: ['warming', 'failed'],
  failed: ['planned'],
});

/** Whether a state can transition to another. */
export function canAdvance(from: ImportState, to: ImportState): boolean {
  return transitions[from].includes(to);
}

/** Advance one state or fail with a stable error. */
export function advanceImport(from: ImportState, to: ImportState): ImportState {
  const parsedFrom = parseRecord(importStateSchema, from, 'import state');
  const parsedTo = parseRecord(importStateSchema, to, 'import state');
  if (!canAdvance(parsedFrom, parsedTo)) throw new AzureSyncError('IMPORT_STATE', `Cannot advance an import from ${parsedFrom} to ${parsedTo}.`);
  return parsedTo;
}

/** A session may be resumed only after a complete import. */
export function isContinuable(state: ImportState, degradedAcknowledged = false): boolean {
  return state === 'complete' || (state === 'degraded' && degradedAcknowledged);
}

/** A failed/degraded import still needs visible repair work. */
export function needsRepair(state: ImportState): boolean {
  return state === 'degraded' || state === 'failed' || state === 'planned' || state === 'creating' || state === 'appending' || state === 'attachments' || state === 'warming';
}
