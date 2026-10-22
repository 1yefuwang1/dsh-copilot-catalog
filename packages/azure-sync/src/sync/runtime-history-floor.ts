/** Consumer-local reject-only recovery knowledge. Never canonical bytes or execution permission. */
import { AzureSyncError } from '../azure/errors.js';
import type { CloudSessionEntity, LocalSessionRecord } from '../schema.js';

/** Manual legacy recovery may be unscoped; automatic recovery never invents namespace consent. */
export function assertRecoveryScope(record: LocalSessionRecord | undefined, scope: string | undefined, automatic = false): void {
  if (scope !== undefined && (record?.publicationScope === undefined ? automatic : record.publicationScope !== scope)) {
    throw new AzureSyncError('OWNERSHIP_UNVERIFIED', 'This recovery has no matching storage namespace consent; reconcile the account explicitly first.');
  }
}

export function assertScopedAppliedFloor(record: LocalSessionRecord | undefined, remote: CloudSessionEntity, scope: string | undefined): void {
  if (scope === undefined || record?.publicationScope !== scope || record.generation !== remote.generation || record.lastSyncedAt === undefined) return;
  const count = record.lastSyncedEventCount;
  if ((count !== undefined && remote.eventCount < count) ||
    (record.lastSyncedHeaderHash !== undefined && remote.headerHash !== record.lastSyncedHeaderHash) ||
    (count === remote.eventCount && record.lastSyncedChainHash !== undefined && remote.chainHash !== record.lastSyncedChainHash)) {
    throw new AzureSyncError('CONFLICT', 'The cloud history is older than, or conflicts with, this account-scoped applied checkpoint. Required accepted-history metadata cannot be reset by a cold read.');
  }
}

/** Explicit namespace consent does not transfer the old account's remote application proof. */
export function publicationScopePatch(record: LocalSessionRecord | undefined, scope: string | undefined): Partial<LocalSessionRecord> {
  if (scope === undefined) return {};
  return { publicationScope: scope, ...(record?.publicationScope === scope ? {} : {
    ...(record?.lastSyncedAt === undefined ? {} : { lastSyncedAt: undefined }),
    ...(record?.lastSyncedEventCount === undefined ? {} : { lastSyncedEventCount: undefined }),
    ...(record?.lastSyncedChainHash === undefined ? {} : { lastSyncedChainHash: undefined }),
    ...(record?.lastSyncedHeaderHash === undefined ? {} : { lastSyncedHeaderHash: undefined }),
    ...(record?.remoteETag === undefined ? {} : { remoteETag: undefined }),
    ...(record?.catchUpPending === undefined ? {} : { catchUpPending: false }),
  }) };
}
