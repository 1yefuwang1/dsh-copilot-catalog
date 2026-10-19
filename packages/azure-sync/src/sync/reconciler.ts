/**
 * Verified canonical-prefix reconciliation. Counts select a direction only after
 * header/cut/genesis and the shared per-event chain have been proved.
 * @module @1yefuwang1/dsh-azure-sync/sync/reconciler
 */
import type { CloudSessionEntity, LocalSessionRecord } from '../schema.js';
import type { SourceSnapshot } from './session-source.js';
import type { RemoteSession } from './remote-session.js';
import { chainEvents, genesisHash, headerHash } from './chain.js';
import { canonicalizeLocalEvents, localizeImportedEvents, localToRemote, remoteToLocal, type CwdBinding } from './effective-cwd.js';
import { canonicalJson } from './canonical.js';
import { AzureSyncError } from '../azure/errors.js';

export type ReconcileKind = 'same' | 'local-ahead' | 'remote-ahead' | 'diverged' | 'deleted' | 'disabled' | 'generation-changed';
export interface ReconcileDecision {
  readonly kind: ReconcileKind;
  readonly importEvents: boolean;
  readonly uploadEvents: boolean;
  readonly stop: boolean;
}

const decision = (kind: ReconcileKind): ReconcileDecision => ({
  kind, importEvents: kind === 'remote-ahead', uploadEvents: kind === 'local-ahead',
  stop: !['same', 'local-ahead', 'remote-ahead'].includes(kind),
});

function commitment(genesis: string, events: SourceSnapshot['events']) {
  if (events.some((event, index) => event.seq !== index)) throw new AzureSyncError('INVALID_RECORD', 'The canonical history is not contiguous from zero.');
  return events.length === 0 ? { chainHash: genesis, headHash: genesis } : chainEvents(genesis, events);
}

export function reconcileManifest(input: {
  readonly manifest: CloudSessionEntity;
  readonly localGeneration: number;
  readonly local: SourceSnapshot;
  /** Verified committed events, never a listing of sibling candidates. */
  readonly remoteEvents: SourceSnapshot['events'];
}): ReconcileDecision {
  const { manifest, local, remoteEvents } = input;
  if (manifest.state === 'deleted') return decision('deleted');
  if (manifest.generation !== input.localGeneration) return decision('generation-changed');
  if (manifest.state !== 'active' || !manifest.enabled) return decision('disabled');
  try {
    const binding = headerHash(local.header, local.inheritedEventCount);
    if (local.header.id !== manifest.sessionId || binding !== manifest.headerHash || local.inheritedEventCount !== manifest.inheritedEventCount) return decision('diverged');
    const genesis = genesisHash(manifest.sessionId, manifest.generation, binding);
    const remote = commitment(genesis, remoteEvents);
    if (remoteEvents.length !== manifest.eventCount || manifest.headSeq !== manifest.eventCount - 1 || remote.chainHash !== manifest.chainHash || remote.headHash !== manifest.headHash) {
      throw new AzureSyncError('CORRUPT_REMOTE', 'The remote history does not match its manifest commitment.');
    }
    commitment(genesis, local.events);
    const count = Math.min(local.events.length, remoteEvents.length);
    if (commitment(genesis, local.events.slice(0, count)).chainHash !== commitment(genesis, remoteEvents.slice(0, count)).chainHash) return decision('diverged');
    return decision(local.events.length === remoteEvents.length ? 'same' : local.events.length > remoteEvents.length ? 'local-ahead' : 'remote-ahead');
  } catch (error) {
    if (error instanceof AzureSyncError && error.code === 'CORRUPT_REMOTE') throw error;
    return decision('diverged');
  }
}

/** Preserve imported canonical bytes by proving forward localization, never by reverse-mapping them. */
export async function canonicalReconcileSnapshot(record: LocalSessionRecord, local: SourceSnapshot, remote: RemoteSession | undefined, binding: CwdBinding | undefined): Promise<SourceSnapshot> {
  if (binding === undefined) {
    if (record.remapped) throw new AzureSyncError('MAPPING_UNSTABLE', 'The imported mapping is unavailable.');
    return local;
  }
  if (record.imported && remote !== undefined) {
    if (record.importMappingId !== undefined && (record.importMappingId !== binding.mapping.id || record.importMappingRevision !== binding.mapping.revision)) throw new AzureSyncError('MAPPING_UNSTABLE', 'The imported mapping revision changed.');
    const localizedHeader = remote.header.cwd === undefined ? remote.header : { ...remote.header, cwd: await remoteToLocal(binding, remote.header.cwd) };
    if (headerHash(localizedHeader, remote.inheritedEventCount) !== headerHash(local.header, local.inheritedEventCount)) throw new AzureSyncError('CONFLICT', 'The imported header or inherited cut changed.');
    const count = Math.min(local.events.length, remote.events.length);
    const localized = await localizeImportedEvents(remote.events.slice(0, count) as never, binding);
    if (canonicalJson(localized.events) !== canonicalJson(local.events.slice(0, count))) throw new AzureSyncError('CONFLICT', 'The local history differs from the forward-localized committed prefix.');
    const suffix = await canonicalizeLocalEvents(local.events.slice(count) as never, binding);
    return { header: remote.header, inheritedEventCount: remote.inheritedEventCount, events: [...remote.events.slice(0, count), ...suffix] as never };
  }
  const header = local.header.cwd === undefined ? local.header : { ...local.header, cwd: await localToRemote(binding, local.header.cwd) };
  return { header, inheritedEventCount: local.inheritedEventCount, events: await canonicalizeLocalEvents(local.events as never, binding) as never };
}

export function isDiverged(value: ReconcileDecision): boolean { return value.kind === 'diverged'; }
