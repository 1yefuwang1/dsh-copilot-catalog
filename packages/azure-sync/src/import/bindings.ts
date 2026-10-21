/** One destination resolver for import, reconciliation, upload, catch-up and Git probing. */
import type { LocalStore } from '../local/store.js';
import type { LocalSessionRecord, SessionDestination } from '../schema.js';
import { AzureSyncError } from '../azure/errors.js';
import { canonicalJson } from '../sync/canonical.js';
import { nodeCwdFs, normalizeMapping, type CwdBinding } from '../sync/effective-cwd.js';
import type { ImportGuardV1 } from './guard.js';
import type { ImportReservation } from './journal.js';

export function destinationBinding(record: ImportReservation, phase: SessionDestination['phase'] = 'pending'): SessionDestination {
  return {
    version: 1, operationId: record.operationId, scope: record.target.scope, intentId: record.intentId,
    mode: record.mode, headerCwd: record.finalCwd, localHeaderHash: record.localHeaderHash, mapping: record.mapping,
    phase, journalRevision: record.revision,
    ...(record.sourceFolder ? { projectId: record.sourceFolder.projectId, folderId: record.sourceFolder.folderId } : {}),
    ...(record.placement ? { projectId: record.placement.projectId, folderId: record.placement.folderId, worktreeId: record.placement.worktreeId } : {}),
    ...(record.binding ? { workspaceId: record.binding.workspaceId } : {}),
  };
}
export function reservationMapping(record: ImportReservation): CwdBinding {
  return { mapping: { id: record.mapping.id, remotePrefix: record.mapping.remotePrefix, localPrefix: record.mapping.localRoot, remotePlatform: record.mapping.remotePlatform, revision: record.mapping.revision, createdAt: record.createdAt, updatedAt: record.updatedAt }, fs: nodeCwdFs };
}
export class DestinationBindings {
  constructor(private readonly local: LocalStore, private readonly guard: ImportGuardV1 | undefined, private readonly scope: () => string | undefined) {}
  async reserved(sessionId: string): Promise<boolean> {
    if (this.local.getSession(sessionId)?.destination && !this.guard) throw new AzureSyncError('IMPORT_INCOMPLETE', 'The mandatory destination journal is unavailable.');
    return this.guard ? (await this.guard.journal.read(sessionId)) !== undefined : false;
  }
  private async record(sessionId: string, local = this.local.getSession(sessionId)): Promise<ImportReservation | undefined> {
    const reservation = await this.guard?.journal.read(sessionId);
    if (!local?.destination && !reservation) return undefined;
    if (!reservation || !local?.destination || !reservation.artifact) throw new AzureSyncError('IMPORT_INCOMPLETE', 'The session belongs to an unfinished destination operation.');
    const destination = local.destination;
    if (local.generation !== reservation.target.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The recorded placement belongs to a different cloud generation.');
    if (destination.operationId !== reservation.operationId || destination.scope !== reservation.target.scope || destination.intentId !== reservation.intentId || destination.mode !== reservation.mode || destination.headerCwd !== reservation.finalCwd || destination.localHeaderHash !== reservation.localHeaderHash || canonicalJson(destination.mapping) !== canonicalJson(reservation.mapping)) throw new AzureSyncError('PROVENANCE_MISMATCH', 'The destination binding differs from its durable operation.');
    if (this.scope() !== reservation.target.scope) throw new AzureSyncError('IMPORT_INCOMPLETE', 'The destination belongs to a different cloud scope.');
    return reservation;
  }
  async binding(sessionId: string, local?: LocalSessionRecord): Promise<CwdBinding | undefined> {
    const record = await this.record(sessionId, local);
    if (!record) return undefined;
    const binding = reservationMapping(record);
    const normalized = await normalizeMapping(binding.mapping, binding.fs);
    if (normalized.localPrefix !== record.mapping.localRoot || normalized.revision !== record.mapping.revision || normalized.remotePrefix !== record.mapping.remotePrefix) throw new AzureSyncError('MAPPING_UNSTABLE', 'The immutable session destination no longer resolves exactly.');
    return { ...binding, mapping: normalized };
  }
  async ready(sessionId: string): Promise<boolean> {
    const local = this.local.getSession(sessionId);
    const record = await this.record(sessionId, local);
    if (!record) return true;
    return record.phase === 'ready' && record.cancelledAt === undefined && local?.destination?.phase === 'ready' && local.destination.journalRevision <= record.revision && record.binding !== undefined;
  }
}
