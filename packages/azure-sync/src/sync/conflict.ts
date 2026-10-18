/**
 * Divergence actions. v1 never merges or overwrites a remote history.
 * @module @1yefuwang1/dsh-azure-sync/sync/conflict
 */
import { AzureSyncError } from '../azure/errors.js';

export const CONFLICT_ACTIONS = ['keep-local', 'export-local', 'remove-cloud'] as const;
export type ConflictAction = (typeof CONFLICT_ACTIONS)[number];

export interface ConflictHandlers {
  readonly keepLocal: () => void | Promise<void>;
  readonly exportLocal: () => void | Promise<void>;
  readonly removeCloud: () => void | Promise<void>;
}

export function isConflictAction(value: unknown): value is ConflictAction {
  return typeof value === 'string' && (CONFLICT_ACTIONS as readonly string[]).includes(value);
}

export async function applyConflictAction(action: unknown, handlers: ConflictHandlers): Promise<ConflictAction> {
  if (!isConflictAction(action)) throw new AzureSyncError('CONFLICT', 'Unsupported conflict action. Choose keep-local, export-local, or remove-cloud.');
  switch (action) {
    case 'keep-local': await handlers.keepLocal(); break;
    case 'export-local': await handlers.exportLocal(); break;
    case 'remove-cloud': await handlers.removeCloud(); break;
  }
  return action;
}
