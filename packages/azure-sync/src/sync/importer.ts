/**
 * Cold import: verified remote batches are localized, created/appended through
 * the public persistence handle, forwarded-provenance checked, and only then
 * marked complete. Incomplete local imports are resumed through the same handle.
 * @module @1yefuwang1/dsh-azure-sync/sync/importer
 */
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { SessionAlreadyOwnedError, SessionAlreadyExistsError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type { AzureSyncConfig } from '../config.js';
import { AzureSyncError } from '../azure/errors.js';
import type { LocalStore } from '../local/store.js';
import type { LocalSessionRecord, SyncStatus } from '../schema.js';
import type { CloudRepository } from './cloud-repository.js';
import { RemoteSessionReader, type RemoteSession } from './remote-session.js';
import {
  localizeImportedEvents, remoteToLocal, validateImportedCwds, verifyImportedProvenance,
  type CwdBinding,
} from './effective-cwd.js';
import { checkGuards } from './guards.js';
import { headerHash } from './chain.js';
import { collectAttachmentReferences, type AttachmentSync } from './attachments.js';
import { ProjectionWarmer, type WarmResult } from './projection-warmer.js';

export interface ImportDependencies {
  readonly config: AzureSyncConfig;
  readonly persistence: SessionPersistence;
  readonly repository: CloudRepository;
  readonly local: LocalStore;
  readonly cwdBinding: (sessionId: string, header: SessionHeader) => Promise<CwdBinding | undefined>;
  readonly attachments?: AttachmentSync;
  readonly projection?: ProjectionWarmer;
  readonly guard?: ImportGuard;
  readonly workspace?: import('./workspace.js').WorkspaceAttacher;
  readonly presetAvailable?: (preset: string) => boolean;
  readonly presetResolver?: (preset: string) => Promise<boolean>;
  readonly sessionController?: { list(request?: unknown, signal?: AbortSignal): unknown };
  readonly now: () => number;
}

export class ImportGuard {
  private readonly local: LocalStore;
  private readonly allowed = new Set<string>();

  constructor(local: LocalStore) {
    this.local = local;
  }

  allow(sessionId: string): void {
    this.allowed.add(sessionId);
  }

  disallow(sessionId: string): void {
    this.allowed.delete(sessionId);
  }

  incomplete(sessionId: string): boolean {
    const state = this.local.getSession(sessionId)?.importState;
    return state !== undefined && state !== 'complete' &&
      !(state === 'degraded' && this.local.getSession(sessionId)?.degradedAcknowledged === true);
  }

  /** Synchronous session/created veto for an incomplete import. */
  assertCreatable(sessionId: string): void {
    if (this.incomplete(sessionId) && !this.allowed.has(sessionId)) {
      throw new AzureSyncError('IMPORT_INCOMPLETE', 'The session has an incomplete cloud import; repair it before resuming.');
    }
  }
}

export interface ImportResult {
  readonly status: 'complete' | 'degraded' | 'partial';
  readonly sessionId: string;
  readonly eventCount: number;
  readonly degradedAttachments: readonly string[];
  readonly warm: WarmResult;
}

function initialRecord(sessionId: string): LocalSessionRecord {
  return {
    sessionId, enabled: true, generation: 1, writerEpoch: 0, state: 'active', status: 'importing',
    remapped: false, needsFolder: false, unmappablePaths: [], mappingUnstable: false,
    degradedAttachments: [], degradedAcknowledged: false, imported: true, weArchived: false, detached: false,
  };
}

export class Importer {
  private readonly deps: ImportDependencies;
  private readonly reader: RemoteSessionReader;

  constructor(deps: ImportDependencies) {
    this.deps = deps;
    this.reader = new RemoteSessionReader(deps.repository, {
      maxCompressedBytes: Math.max(deps.config.maxBatchBytes * 4, 1_048_576),
      maxExpandedBytes: deps.config.maxBatchBytes,
      maxEvents: deps.config.maxEventsPerSession,
    });
  }

  private async update(sessionId: string, patch: Partial<LocalSessionRecord>): Promise<LocalSessionRecord> {
    const current = this.deps.local.getSession(sessionId) ?? initialRecord(sessionId);
    const next = { ...current, ...patch, lastAttemptAt: this.deps.now() };
    await this.deps.local.putSession(next);
    return next;
  }

  private async recordFailure(sessionId: string, error: unknown): Promise<void> {
    const code = error instanceof AzureSyncError ? error.code : undefined;
    const status: SyncStatus = code === 'NEEDS_FOLDER' ? 'needs-folder'
      : code === 'UNMAPPABLE_CWD' ? 'cwd-unmappable'
        : code === 'MAPPING_UNSTABLE' ? 'mapping-unstable'
          : code === 'AMBIGUOUS_MAPPING' ? 'ambiguous-mapping'
            : code === 'PRESET_MISSING' ? 'preset-missing'
              : code === 'SCHEDULE_UNSAFE' ? 'schedule-unsafe'
                : code === 'NO_CWD' ? 'no-cwd'
                  : 'import-incomplete';
    const record = this.deps.local.getSession(sessionId) ?? initialRecord(sessionId);
    await this.update(sessionId, {
      status, importState: 'failed',
      ...(status === 'needs-folder' ? { needsFolder: true } : {}),
      ...(status === 'cwd-unmappable' ? { unmappablePaths: [record.canonicalCwd ?? record.localCwd ?? 'unknown'].filter((path) => path.length > 0) } : {}),
      ...(status === 'mapping-unstable' || status === 'ambiguous-mapping' ? { mappingUnstable: true } : {}),
      lastError: error instanceof Error ? error.message.slice(0, 4096) : 'Import failed.',
    }).catch(() => undefined);
  }

  private async preflight(sessionId: string, remote: RemoteSession, binding: CwdBinding): Promise<{ events: readonly SessionEvent[]; header: SessionHeader; degraded: readonly string[]; warm: WarmResult }> {
    const preset = remote.header.agentPreset;
    if (preset !== undefined && this.deps.presetResolver !== undefined) {
      const available = await this.deps.presetResolver(preset).catch(() => false);
      if (!available) throw new AzureSyncError('PRESET_MISSING', 'The imported agent preset is not available on this host.');
    }
    const guard = checkGuards({ header: remote.header, events: remote.events, ...(this.deps.presetAvailable === undefined ? {} : { presetAvailable: this.deps.presetAvailable }) });
    if (!guard.ok) {
      const code = guard.code === 'no-cwd' ? 'NO_CWD' : guard.code === 'schedule-unsafe' ? 'SCHEDULE_UNSAFE' : 'PRESET_MISSING';
      throw new AzureSyncError(code, guard.detail ?? 'The remote session cannot be imported.');
    }
    const cwdPaths = (remote.events as unknown as { type: string; data?: { cwd?: unknown } }[]).flatMap((event) => {
      if (event.type !== 'working-directory/change') return [];
      const cwd = event.data?.cwd;
      return typeof cwd === 'string' ? [cwd] : [];
    });
    const validation = await validateImportedCwds(binding, cwdPaths);
    if (!validation.ok) {
      const code = validation.issues[0]?.code === 'NEEDS_FOLDER' ? 'NEEDS_FOLDER'
        : validation.issues[0]?.code === 'MAPPING_UNSTABLE' ? 'MAPPING_UNSTABLE'
          : validation.issues[0]?.code === 'AMBIGUOUS_MAPPING' ? 'AMBIGUOUS_MAPPING' : 'UNMAPPABLE_CWD';
      const status: SyncStatus = code === 'NEEDS_FOLDER' ? 'needs-folder' : code === 'MAPPING_UNSTABLE' ? 'mapping-unstable' : code === 'AMBIGUOUS_MAPPING' ? 'ambiguous-mapping' : 'cwd-unmappable';
      await this.update(sessionId, {
        status, importState: 'failed',
        ...(code === 'NEEDS_FOLDER' ? { needsFolder: true } : {}),
        ...(code === 'MAPPING_UNSTABLE' || code === 'AMBIGUOUS_MAPPING' ? { mappingUnstable: true } : {}),
        unmappablePaths: validation.issues.map((issue) => issue.path).filter((path) => path.length > 0),
        lastError: validation.issues[0]?.message ?? 'The remote working directories cannot be mapped.',
      });
      throw new AzureSyncError(code, validation.issues[0]?.message ?? 'The remote working directories cannot be mapped.');
    }
    const localized = await localizeImportedEvents(remote.events as never, binding);
    const header: SessionHeader = remote.header.cwd === undefined ? remote.header : { ...remote.header, cwd: await remoteToLocal(binding, remote.header.cwd) };
    const refs = collectAttachmentReferences(remote.events);
    const degraded = this.deps.attachments === undefined ? refs.map((ref) => ref.id) : [];
    return { events: localized.events as never, header, degraded, warm: 'partial' };
  }

  private async provenanceOptions(remote: RemoteSession, binding: CwdBinding, prefixLength: number) {
    const headerCwd = remote.header.cwd;
    if (headerCwd === undefined) return {};
    const hasCwdEvent = remote.events.slice(0, prefixLength).some((event) => (event as { type: string }).type === 'working-directory/change');
    return hasCwdEvent ? { headerCwd } : { headerCwd, localCurrentCwd: await remoteToLocal(binding, headerCwd) };
  }

  private async validateHandle(sessionId: string, remote: RemoteSession, binding: CwdBinding, preflightHeader: SessionHeader, handle: SessionHandle): Promise<void> {
    if (handle.id !== sessionId || handle.header.id !== sessionId) {
      throw new AzureSyncError('PROVENANCE_MISMATCH', 'The existing write handle belongs to another session.');
    }
    const expected = headerHash(preflightHeader, remote.inheritedEventCount as never);
    const actual = headerHash(handle.header, Number(handle.inheritedEventCount) as never);
    if (actual !== expected) throw new AzureSyncError('PROVENANCE_MISMATCH', 'The existing write handle header or inherited cut does not match the remote import.');
    const record = this.deps.local.getSession(sessionId);
    if (record?.importMappingId !== undefined && (record.importMappingId !== binding.mapping.id || record.importMappingRevision !== binding.mapping.revision)) {
      throw new AzureSyncError('MAPPING_UNSTABLE', 'The import mapping revision changed since the original attempt.');
    }
  }

  private async appendAll(handle: SessionHandle, events: readonly SessionEvent[], sessionId: string, remote?: RemoteSession, binding?: CwdBinding): Promise<void> {
    const size = Math.max(1, this.deps.config.maxBatchEvents);
    for (let offset = 0; offset < events.length; offset += size) {
      await handle.append(events.slice(offset, offset + size) as never);
      await handle.flush();
      let importedThroughSeq: number | undefined;
      if (remote !== undefined && binding !== undefined) {
        const read = await handle.read(0);
        await verifyImportedProvenance(binding, remote.events.slice(0, read.events.length) as never, read.events as never, await this.provenanceOptions(remote, binding, read.events.length));
        importedThroughSeq = read.events.length === 0 ? undefined : read.events.length - 1;
      }
      await this.update(sessionId, { importAppendedCount: Math.min(events.length, offset + size), status: 'importing', ...(importedThroughSeq === undefined ? {} : { importedThroughSeq }) });
    }
  }

  private async materializeAttachments(sessionId: string, remote: RemoteSession): Promise<{ degraded: readonly string[] }> {
    const refs = collectAttachmentReferences(remote.events);
    if (refs.length === 0) return { degraded: [] };
    if (this.deps.attachments === undefined) {
      await this.update(sessionId, { status: 'attachments-unavailable', degradedAttachments: refs.map((ref) => ref.id) });
      return { degraded: refs.map((ref) => ref.id) };
    }
    const result = await this.deps.attachments.import(refs);
    if (result.degraded.length > 0) {
      const status: SyncStatus = 'attachment-unsupported';
      await this.update(sessionId, { status, degradedAttachments: [...result.degraded] });
      return { degraded: result.degraded };
    }
    await this.update(sessionId, { degradedAttachments: [] });
    return { degraded: [] };
  }

  private async finalize(sessionId: string, remote: RemoteSession, binding: CwdBinding, handle: SessionHandle): Promise<ImportResult> {
    const readBack = await handle.read(0);
    await verifyImportedProvenance(binding, remote.events as never, readBack.events as never, await this.provenanceOptions(remote, binding, remote.events.length));
    await handle.flush();
    await this.update(sessionId, { importState: 'attachments', status: 'importing' });
    const attachments = await this.materializeAttachments(sessionId, remote);
    await this.update(sessionId, { importState: 'warming', status: 'importing', importExpectedCount: remote.events.length, importExpectedChainHash: remote.manifest.entity.chainHash });
    const localizedHeader = remote.header.cwd === undefined ? remote.header : { ...remote.header, cwd: await remoteToLocal(binding, remote.header.cwd) };
    let warm: WarmResult = 'partial';
    if (this.deps.projection !== undefined) {
      try { warm = await this.deps.projection.warm(sessionId, localizedHeader, remote.inheritedEventCount, readBack.events); }
      catch { warm = 'partial'; }
    }
    if (warm === 'complete' && this.deps.sessionController !== undefined) {
      try {
        const result = await this.deps.sessionController.list({}, new AbortController().signal) as { items?: readonly unknown[] } | readonly unknown[];
        const items: readonly unknown[] = Array.isArray(result) ? result as readonly unknown[] : ((result as { items?: readonly unknown[] }).items ?? []);
        const listed = items.some((item: unknown) => {
          const value = item as { sessionId?: string; header?: { id?: string } };
          return value.sessionId === sessionId || value.header?.id === sessionId;
        });
        if (!listed) warm = 'partial';
      } catch { warm = 'partial'; }
    }
    const degraded = attachments.degraded.length > 0 || warm !== 'complete';
    const status: SyncStatus = attachments.degraded.length > 0 ? 'attachment-unsupported' : warm === 'complete' ? 'synced' : 'projection-warm-partial';
    await this.update(sessionId, {
      importState: degraded ? 'degraded' : 'complete', ...(readBack.events.length === 0 ? {} : { importedThroughSeq: readBack.events.length - 1 }),
      lastSyncedEventCount: remote.events.length, lastSyncedChainHash: remote.manifest.entity.chainHash,
      lastSyncedHeaderHash: remote.manifest.entity.headerHash, remoteETag: remote.manifest.etag,
      lastSyncedAt: this.deps.now(), status, generation: remote.manifest.entity.generation,
      ...(localizedHeader.cwd === undefined ? { localCwd: undefined } : { localCwd: localizedHeader.cwd }),
      ...(remote.header.cwd === undefined ? {} : { canonicalCwd: remote.header.cwd }),
      remapped: remote.header.cwd !== localizedHeader.cwd,
      ...(degraded ? { lastError: 'Import completed with degraded attachments/projection.' } : { lastError: undefined }),
    });
    if (this.deps.workspace !== undefined) {
      const localizedCwd = remote.header.cwd === undefined ? undefined : await remoteToLocal(binding, remote.header.cwd);
      if (localizedCwd !== undefined) await this.deps.workspace.attach(localizedCwd, undefined, sessionId);
    }
    return { status: degraded ? 'degraded' : 'complete', sessionId, eventCount: remote.events.length, degradedAttachments: attachments.degraded, warm };
  }

  /** First import of a session; the caller may pre-hold a write handle from early claims. */
  async import(sessionId: string, heldHandle?: SessionHandle): Promise<ImportResult> {
    const remote = await this.reader.read(sessionId);
    if (remote === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud session does not exist.');
    const previous = this.deps.local.getSession(sessionId);
    const binding = await this.deps.cwdBinding(sessionId, remote.header);
    if (binding === undefined) {
      await this.update(sessionId, { status: 'needs-folder', importState: 'failed', needsFolder: true, unmappablePaths: remote.header.cwd === undefined ? [] : [remote.header.cwd], lastError: 'No local folder is mapped for the remote session.' }).catch(() => undefined);
      throw new AzureSyncError('NEEDS_FOLDER', 'No local folder is mapped for the remote session.');
    }
    const preflight = await this.preflight(sessionId, remote, binding).catch(async (error: unknown) => { await this.recordFailure(sessionId, error); throw error; });
    await this.update(sessionId, {
      importState: 'planned', status: 'importing', importExpectedCount: remote.events.length,
      ...(remote.header.parentSession === undefined ? {} : { parentSession: remote.header.parentSession }),
      ...(remote.header.delegationDepth === undefined ? {} : { delegationDepth: remote.header.delegationDepth }),
      subagent: remote.header.origin === 'subagent',
      importExpectedChainHash: remote.manifest.entity.chainHash, importMappingId: binding.mapping.id,
      importMappingRevision: binding.mapping.revision, canonicalCwd: remote.header.cwd,
    });
    const ownsHandle = heldHandle === undefined;
    let handle = heldHandle;
    if (handle === undefined) {
      try { handle = await this.deps.persistence.create(preflight.header, { inheritedEventCount: remote.inheritedEventCount as never }); }
      catch (error) {
        if (error instanceof SessionAlreadyOwnedError || error instanceof SessionAlreadyExistsError) {
          if (previous === undefined) await this.deps.local.deleteSession(sessionId).catch(() => undefined);
          else await this.deps.local.putSession(previous).catch(() => undefined);
          throw new AzureSyncError('IMPORT_RACE', 'The session is already owned or exists locally.');
        }
        throw error;
      }
    }
    let completed = false;
    try {
      await this.validateHandle(sessionId, remote, binding, preflight.header, handle);
      await this.update(sessionId, { importState: 'creating' });
      await this.update(sessionId, { importState: 'appending' });
      await this.appendAll(handle, preflight.events, sessionId, remote, binding);
      const result = await this.finalize(sessionId, remote, binding, handle);
      completed = true;
      return result;
    } catch (error) {
      await this.recordFailure(sessionId, error);
      throw error;
    } finally {
      if (ownsHandle || completed) await handle.close().catch(() => undefined);
    }
  }

  /** Resume an incomplete import through a held or freshly opened write handle. */
  async resume(sessionId: string, heldHandle?: SessionHandle): Promise<ImportResult> {
    const existing = this.deps.local.getSession(sessionId);
    if (existing === undefined) throw new AzureSyncError('NOT_FOUND', 'There is no local import to resume.');
    const remote = await this.reader.read(sessionId);
    if (remote === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud session does not exist.');
    const binding = await this.deps.cwdBinding(sessionId, remote.header);
    if (binding === undefined) {
      await this.update(sessionId, { status: 'needs-folder', importState: 'failed', needsFolder: true, unmappablePaths: remote.header.cwd === undefined ? [] : [remote.header.cwd], lastError: 'No local folder is mapped for the remote session.' }).catch(() => undefined);
      throw new AzureSyncError('NEEDS_FOLDER', 'No local folder is mapped for the remote session.');
    }
    const preflight = await this.preflight(sessionId, remote, binding).catch(async (error: unknown) => { await this.recordFailure(sessionId, error); throw error; });
    const ownsHandle = heldHandle === undefined;
    let handle = heldHandle;
    if (handle === undefined) {
      try { handle = await this.deps.persistence.open(sessionId as never, 'write'); }
      catch (error) {
        if (error instanceof SessionAlreadyOwnedError) {
          await this.update(sessionId, { status: 'import-race', lastError: 'Another process owns the import write handle.' });
          throw new AzureSyncError('IMPORT_RACE', 'Another process owns the import write handle.');
        }
        throw error;
      }
    }
    let completed = false;
    try {
      await this.validateHandle(sessionId, remote, binding, preflight.header, handle);
      const current = await handle.read(0);
      if (current.events.length > preflight.events.length) throw new AzureSyncError('CORRUPT_REMOTE', 'The local import is longer than the committed remote history.');
      await verifyImportedProvenance(binding, remote.events.slice(0, current.events.length) as never, current.events as never, await this.provenanceOptions(remote, binding, current.events.length));
      await this.appendAll(handle, preflight.events.slice(current.events.length), sessionId, remote, binding);
      const result = await this.finalize(sessionId, remote, binding, handle);
      completed = true;
      return result;
    } catch (error) {
      await this.recordFailure(sessionId, error);
      throw error;
    } finally {
      if (ownsHandle || completed) await handle.close().catch(() => undefined);
    }
  }
}

export interface EarlyClaim {
  readonly sessionId: string;
  readonly handle: SessionHandle;
}

/** Claim every incomplete import before the API/UI can resume it. */
export class EarlyImportClaims {
  private readonly persistence: SessionPersistence;
  private readonly local: LocalStore;
  private readonly handles = new Map<string, SessionHandle>();

  constructor(persistence: SessionPersistence, local: LocalStore) {
    this.persistence = persistence;
    this.local = local;
  }

  async claimAll(): Promise<{ readonly claimed: readonly EarlyClaim[]; readonly raced: readonly string[] }> {
    const claimed: EarlyClaim[] = [];
    const raced: string[] = [];
    for (const [sessionId, record] of this.local.listSessions()) {
      if (record.importState === 'complete' || record.importState === undefined) continue;
      try {
        const handle = await this.persistence.open(sessionId as never, 'write');
        this.handles.set(sessionId, handle);
        claimed.push({ sessionId, handle });
      } catch (error) {
        if (error instanceof SessionAlreadyOwnedError) {
          await this.local.putSession({ ...record, status: 'import-race', lastError: 'Another process already owns this incomplete import.' });
          raced.push(sessionId);
        } else if (!(error instanceof SessionPersistenceNotFoundError)) {
          continue;
        }
      }
    }
    return { claimed, raced };
  }

  take(sessionId: string): SessionHandle | undefined {
    const handle = this.handles.get(sessionId);
    this.handles.delete(sessionId);
    return handle;
  }

  /** Return a failed borrowed handle to the claim map for a later retry. */
  restore(sessionId: string, handle: SessionHandle): void {
    this.handles.set(sessionId, handle);
  }

  async release(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
  }
}
