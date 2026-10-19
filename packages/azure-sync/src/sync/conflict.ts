/**
 * Divergence actions. v1 never merges or overwrites a remote history.
 * @module @1yefuwang1/dsh-azure-sync/sync/conflict
 */
import { AzureSyncError } from '../azure/errors.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { SessionSource } from './session-source.js';
import { canonicalJson } from './canonical.js';

/** Export the local (not cloud-canonicalized) header, exact fork cut and events. */
export async function exportLocalSnapshot(source: SessionSource, sessionId: string, directory: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await source.flush();
  signal?.throwIfAborted();
  const snapshot = await source.read(sessionId);
  signal?.throwIfAborted();
  if (snapshot === undefined) throw new AzureSyncError('NOT_FOUND', 'The local session has not materialized.');
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  // Random basename, no user-controlled path components, never overwrite a backup.
  const path = join(root, `conflict-${randomUUID()}.jsonl`);
  const handle = await open(path, 'wx', 0o600);
  try {
    signal?.throwIfAborted();
    await handle.chmod(0o600);
    signal?.throwIfAborted();
    await handle.writeFile([canonicalJson({ type: 'session', ...snapshot.header, inheritedEventCount: snapshot.inheritedEventCount }), ...snapshot.events.map((event) => canonicalJson(event))].join('\n') + '\n');
    signal?.throwIfAborted();
    await handle.sync();
    signal?.throwIfAborted();
  } finally { await handle.close(); }
  return path;
}

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
