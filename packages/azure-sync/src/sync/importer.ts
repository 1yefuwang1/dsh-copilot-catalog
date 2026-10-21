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
import { chainEvents, genesisHash, headerHash } from './chain.js';
import { collectAttachmentReferences, type AttachmentSync } from './attachments.js';
import { ProjectionWarmer, type WarmResult } from './projection-warmer.js';

export interface ImportDependencies {
  readonly config: AzureSyncConfig;
  readonly persistence: SessionPersistence;
  readonly repository: CloudRepository;
  readonly local: LocalStore;
  /** Root intent remains visible while the durable opt-out write is pending. */
  readonly isOptingOut?: (sessionId: string) => boolean;
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

export interface CatchUpOptions {
  readonly signal: AbortSignal;
  readonly isLive: () => boolean;
}

export interface ResumeImportOptions {
  readonly signal?: AbortSignal;
  readonly confirmMapping?: boolean;
  /** Internal explicit repair consent to read retained bytes, never to re-enable sync. */
  readonly allowDisabledRead?: boolean;
}

/** Initial import evidence, never permission to recreate a native or completed copy. */
export function isInitialIncompleteImport(record: LocalSessionRecord, allowDisabledRead = false): boolean {
  const permitted = record.enabled && !record.detached && record.state === 'active' ||
    allowDisabledRead && !record.enabled && record.detached && record.state === 'disabled' && record.resurrectionCancellationId !== undefined;
  return permitted && record.imported && record.importState !== undefined &&
    record.importState !== 'complete' && record.importState !== 'degraded' && !record.catchUpPending &&
    record.resurrectionIntent === undefined && record.lastSyncedAt === undefined &&
    record.lastSyncedHeaderHash === undefined && record.lastSyncedEventCount === undefined && record.lastSyncedChainHash === undefined;
}

interface ImportOperation {
  readonly check: (latest?: { readonly record: LocalSessionRecord | undefined }) => void;
  readonly accept: (record: LocalSessionRecord | undefined) => void;
  readonly signal: AbortSignal;
}

/** Permission/provenance authority, not a stale whole status record. */
function sameAuthority(expected: LocalSessionRecord | undefined, latest: LocalSessionRecord | undefined): boolean {
  if (expected === undefined || latest === undefined) return expected === latest;
  return expected.sessionId === latest.sessionId &&
    expected.resurrectionCancellationId === latest.resurrectionCancellationId &&
    expected.generation === latest.generation && expected.writerEpoch === latest.writerEpoch &&
    expected.enabled === latest.enabled && expected.detached === latest.detached && expected.state === latest.state &&
    !!expected.admissionStopped === !!latest.admissionStopped && expected.mappingUnstable === latest.mappingUnstable &&
    expected.needsFolder === latest.needsFolder && expected.importMappingId === latest.importMappingId &&
    expected.importMappingRevision === latest.importMappingRevision &&
    expected.imported === latest.imported && !!expected.catchUpPending === !!latest.catchUpPending &&
    expected.importExpectedCount === latest.importExpectedCount && expected.importExpectedChainHash === latest.importExpectedChainHash &&
    expected.lastSyncedAt === latest.lastSyncedAt && expected.lastSyncedHeaderHash === latest.lastSyncedHeaderHash &&
    (expected.importState === 'complete' || expected.importState === 'degraded') === (latest.importState === 'complete' || latest.importState === 'degraded') &&
    expected.resurrectionIntent?.operationId === latest.resurrectionIntent?.operationId &&
    expected.destination?.operationId === latest.destination?.operationId && expected.destination?.scope === latest.destination?.scope &&
    expected.destination?.phase === latest.destination?.phase && expected.destination?.journalRevision === latest.destination?.journalRevision;
}

function snapshot(record: LocalSessionRecord | undefined): LocalSessionRecord | undefined {
  return record === undefined ? undefined : { ...record };
}

export class Importer {
  private readonly deps: ImportDependencies;
  private readonly catchups = new Map<string, ImportOperation>();
  private readonly requests = new Map<string, ImportOperation>();

  private operation(sessionId: string): ImportOperation | undefined {
    return this.requests.get(sessionId) ?? this.catchups.get(sessionId);
  }

  private assertNotOptingOut(sessionId: string): void {
    if (this.deps.isOptingOut?.(sessionId) === true) throw new AzureSyncError('CANCELLED', 'The local sync opt-out is pending.');
  }

  private assertActive(sessionId: string): void { this.operation(sessionId)?.check(); }

  /** Capture the operation, and race only raw IO, never a mutating helper. */
  private async waitOperation<T>(operation: ImportOperation | undefined, work: () => T | Promise<T>): Promise<T> {
    operation?.check();
    if (operation === undefined) return work();
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(operation.signal.reason);
      operation.signal.addEventListener('abort', abort, { once: true });
      if (operation.signal.aborted) abort();
    });
    try {
      const pending = Promise.resolve().then(() => { operation.check(); return work(); });
      const result = await Promise.race([pending, cancelled]);
      operation.check();
      return result;
    } finally { operation.signal.removeEventListener('abort', abort); }
  }

  private waitActive<T>(sessionId: string, work: () => T | Promise<T>): Promise<T> {
    return this.waitOperation(this.operation(sessionId), work);
  }

  /** An abandoned create/open still owns its eventual result and must close it. */
  private async acquireHandle(sessionId: string, work: () => Promise<SessionHandle>): Promise<SessionHandle> {
    this.assertActive(sessionId);
    const pending = work();
    try { return await this.waitActive(sessionId, () => pending); }
    catch (error) {
      void pending.then((handle) => handle.close().catch(() => undefined), () => undefined);
      throw error;
    }
  }

  private beginRequest(sessionId: string, signal = new AbortController().signal): ImportOperation {
    if (this.operation(sessionId) !== undefined) throw new AzureSyncError('IMPORT_RACE', 'An import operation is already active.');
    let authority = snapshot(this.deps.local.getSession(sessionId));
    let revoked: AzureSyncError | undefined;
    const operation: ImportOperation = { signal, accept: (record) => { authority = snapshot(record); }, check: (latest) => {
      signal.throwIfAborted();
      this.assertNotOptingOut(sessionId);
      if (revoked !== undefined) throw revoked;
      if (this.requests.get(sessionId) !== operation) throw new AzureSyncError('CANCELLED', 'The import request is no longer active.');
      const current = latest === undefined ? this.deps.local.getSession(sessionId) : latest.record;
      if (!sameAuthority(authority, current)) {
        revoked = new AzureSyncError('CANCELLED', 'The local import authority changed.');
        throw revoked;
      }
    } };
    this.requests.set(sessionId, operation);
    return operation;
  }

  /** Reader and cwd helpers may continue pure work, but cannot begin later IO. */
  private readRemote(sessionId: string, allowDisabled = false): Promise<RemoteSession | undefined> {
    const operation = this.operation(sessionId);
    const repository = this.deps.repository;
    const reader = new RemoteSessionReader({
      getManifest: (id: string) => this.waitOperation(operation, () => repository.getManifest(id)),
      listBatchRows: (id: string, generation: number) => this.waitOperation(operation, () => repository.listBatchRows(id, generation)),
      readCandidate: (name: string, limit: number) => this.waitOperation(operation, () => repository.readCandidate(name, limit)),
    } as CloudRepository, {
      maxCompressedBytes: Math.max(this.deps.config.maxBatchBytes * 4, 1_048_576),
      maxExpandedBytes: this.deps.config.maxBatchBytes,
      maxEvents: this.deps.config.maxEventsPerSession,
    });
    return reader.read(sessionId, { allowDisabled });
  }

  private async binding(sessionId: string, header: SessionHeader): Promise<CwdBinding | undefined> {
    const operation = this.operation(sessionId);
    const binding = await this.waitOperation(operation, () => this.deps.cwdBinding(sessionId, header));
    if (binding === undefined) return undefined;
    return { ...binding, fs: {
      realpath: (path) => this.waitOperation(operation, () => binding.fs.realpath(path)),
      stat: (path) => this.waitOperation(operation, () => binding.fs.stat(path)),
    } };
  }

  constructor(deps: ImportDependencies) { this.deps = deps; }

  /** Prepared-placement continuation. Caller already cold-proved the exact initial
   * artifact and published its destination-linked record. Never creates a SID or
   * writes an initial planned record. */
  async importPrepared(sessionId: string, remote: RemoteSession, binding: CwdBinding, localizedHeader: SessionHeader, options: ResumeImportOptions = {}): Promise<ImportResult> {
    const operation = this.beginRequest(sessionId, options.signal);
    let handle: SessionHandle | undefined;
    let failureReady = false;
    try {
      const record = this.deps.local.getSession(sessionId);
      if (!record?.destination || !record.imported || record.destination.headerCwd !== localizedHeader.cwd || ((!record.enabled || record.detached) && options.allowDisabledRead !== true)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'The prepared destination record is unavailable.');
      failureReady = true;
      operation.check();
      const preflight = await this.preflight(sessionId, remote, binding);
      operation.check();
      handle = await this.acquireHandle(sessionId, () => this.deps.persistence.open(sessionId as never, 'write'));
      await this.validateHandle(sessionId, remote, binding, localizedHeader, handle);
      const current = await this.waitActive(sessionId, () => handle!.read(0));
      if (current.events.length > preflight.events.length) throw new AzureSyncError('PROVENANCE_MISMATCH', 'The prepared artifact advanced beyond the reviewed history.');
      await verifyImportedProvenance(binding, remote.events.slice(0, current.events.length) as never, current.events as never, await this.provenanceOptions(remote, binding, current.events.length));
      await this.update(sessionId, { importState: 'appending', status: 'importing' });
      await this.appendAll(handle, preflight.events.slice(current.events.length), sessionId, remote, binding, undefined, current.events.length);
      const result = await this.finalize(sessionId, remote, binding, handle, undefined, localizedHeader, true);
      operation.check(); return result;
    } catch (error) {
      operation.check();
      if (failureReady) await this.recordFailure(sessionId, error); throw error;
    } finally {
      try { await handle?.close(); } finally { this.requests.delete(sessionId); }
    }
  }

  private async update(sessionId: string, patch: Partial<LocalSessionRecord>): Promise<LocalSessionRecord> {
    const operation = this.operation(sessionId);
    operation?.check();
    const expected = snapshot(this.deps.local.getSession(sessionId));
    const next = await this.deps.local.transactSession(sessionId, (latest) => {
      // This callback executes against the latest SDK-chain value, not getSession's
      // possibly stale cache. Capture the operation before entering that chain.
      operation?.check({ record: latest });
      this.assertNotOptingOut(sessionId);
      if (!sameAuthority(expected, latest)) throw new AzureSyncError('CANCELLED', 'The local checkpoint authority changed.');
      return { ...(latest ?? initialRecord(sessionId)), ...patch,
        // A repair failure is not evidence that a previously complete artifact
        // was an unfinished initial import, even for old sparse checkpoints.
        ...(patch.importState === 'failed' && (latest?.importState === 'complete' || latest?.importState === 'degraded') ? { importState: latest.importState } : {}),
        lastAttemptAt: this.deps.now() };
    });
    if (next === undefined) throw new AzureSyncError('CANCELLED', 'The local checkpoint was not applied.');
    // Only our own committed transition may advance the captured authority. This
    // includes the initial remote generation stamp and explicit proven new pins.
    operation?.accept(next);
    operation?.check();
    return next;
  }

  private async recordFailure(sessionId: string, error: unknown, patch: Partial<LocalSessionRecord> = {}): Promise<void> {
    const code = error instanceof AzureSyncError ? error.code : undefined;
    const status: SyncStatus = code === 'NEEDS_FOLDER' ? 'needs-folder'
      : code === 'UNMAPPABLE_CWD' ? 'cwd-unmappable'
        : code === 'MAPPING_UNSTABLE' ? 'mapping-unstable'
          : code === 'AMBIGUOUS_MAPPING' ? 'ambiguous-mapping'
            : code === 'PRESET_MISSING' ? 'preset-missing'
              : code === 'SCHEDULE_UNSAFE' ? 'schedule-unsafe'
                : code === 'NO_CWD' ? 'no-cwd'
                  : code === 'IMPORT_RACE' ? 'import-race'
                    : code === 'GENERATION_CHANGED' ? 'generation-changed'
                      : 'import-incomplete';
    const record = this.deps.local.getSession(sessionId) ?? initialRecord(sessionId);
    await this.update(sessionId, {
      status, importState: 'failed',
      ...(status === 'needs-folder' ? { needsFolder: true } : {}),
      ...(status === 'cwd-unmappable' ? { unmappablePaths: [record.canonicalCwd ?? record.localCwd ?? 'unknown'].filter((path) => path.length > 0) } : {}),
      ...(status === 'mapping-unstable' || status === 'ambiguous-mapping' ? { mappingUnstable: true } : {}),
      lastError: error instanceof Error ? error.message.slice(0, 4096) : 'Import failed.',
      ...patch,
    }).catch(() => { this.assertActive(sessionId); });
  }

  private async preflight(sessionId: string, remote: RemoteSession, binding: CwdBinding): Promise<{ events: readonly SessionEvent[]; header: SessionHeader; degraded: readonly string[]; warm: WarmResult }> {
    const preset = remote.header.agentPreset;
    if (preset !== undefined && this.deps.presetResolver !== undefined) {
      const available = await this.waitActive(sessionId, () => this.deps.presetResolver!(preset)).catch(() => false);
      this.assertActive(sessionId);
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

  /** The original chain binds identity, generation, canonical header and inherited cut. */
  private verifyInitialTarget(record: LocalSessionRecord, remote: RemoteSession): void {
    if (record.generation !== remote.manifest.entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed since this import began.');
    const count = record.importExpectedCount;
    const expected = record.importExpectedChainHash;
    if (count === undefined || expected === undefined) throw new AzureSyncError('IMPORT_INCOMPLETE', 'The initial import has no verified target checkpoint; a missing artifact cannot be recreated safely.');
    if (remote.events.length < count) throw new AzureSyncError('CONFLICT', 'The cloud history rolled back behind the initial import target.');
    const genesis = genesisHash(record.sessionId, record.generation, headerHash(remote.header, remote.inheritedEventCount));
    const prefix = count === 0 ? genesis : chainEvents(genesis, remote.events.slice(0, count)).chainHash;
    if (prefix !== expected) throw new AzureSyncError('PROVENANCE_MISMATCH', 'The canonical header, inherited cut or original import target prefix changed.');
  }

  private assertMapping(record: LocalSessionRecord | undefined, binding: CwdBinding, confirmMapping: boolean): void {
    if (!confirmMapping && record?.importMappingId !== undefined && (record.importMappingId !== binding.mapping.id || record.importMappingRevision !== binding.mapping.revision)) {
      throw new AzureSyncError('MAPPING_UNSTABLE', 'The import mapping revision changed since the original attempt.');
    }
  }

  private async provenanceOptions(remote: RemoteSession, binding: CwdBinding, prefixLength: number) {
    const headerCwd = remote.header.cwd;
    if (headerCwd === undefined) return {};
    const hasCwdEvent = remote.events.slice(0, prefixLength).some((event) => (event as { type: string }).type === 'working-directory/change');
    return hasCwdEvent ? { headerCwd } : { headerCwd, localCurrentCwd: await remoteToLocal(binding, headerCwd) };
  }

  private async validateHandle(sessionId: string, remote: RemoteSession, binding: CwdBinding, preflightHeader: SessionHeader, handle: SessionHandle, confirmMapping = false): Promise<void> {
    if (handle.id !== sessionId || handle.header.id !== sessionId) {
      throw new AzureSyncError('PROVENANCE_MISMATCH', 'The existing write handle belongs to another session.');
    }
    const expected = headerHash(preflightHeader, remote.inheritedEventCount as never);
    const actual = headerHash(handle.header, Number(handle.inheritedEventCount) as never);
    if (actual !== expected) throw new AzureSyncError('PROVENANCE_MISMATCH', 'The existing write handle header or inherited cut does not match the remote import.');
    this.assertMapping(this.deps.local.getSession(sessionId), binding, confirmMapping);
  }

  private async appendAll(handle: SessionHandle, events: readonly SessionEvent[], sessionId: string, remote?: RemoteSession, binding?: CwdBinding, checkRemote?: () => Promise<void>, baseOffset = 0): Promise<void> {
    const size = Math.max(1, this.deps.config.maxBatchEvents);
    for (let offset = 0; offset < events.length; offset += size) {
      await checkRemote?.();
      this.assertActive(sessionId);
      await this.waitActive(sessionId, () => handle.append(events.slice(offset, offset + size) as never));
      await this.waitActive(sessionId, () => handle.flush());
      let importedThroughSeq: number | undefined;
      if (remote !== undefined && binding !== undefined) {
        const read = await this.waitActive(sessionId, () => handle.read(0));
        await verifyImportedProvenance(binding, remote.events.slice(0, read.events.length) as never, read.events as never, await this.provenanceOptions(remote, binding, read.events.length));
        importedThroughSeq = read.events.length === 0 ? undefined : read.events.length - 1;
      }
      await this.update(sessionId, { importAppendedCount: baseOffset + Math.min(events.length, offset + size), status: 'importing', ...(importedThroughSeq === undefined ? {} : { importedThroughSeq }) });
    }
  }

  private async materializeAttachments(sessionId: string, remote: RemoteSession): Promise<{ degraded: readonly string[] }> {
    const refs = collectAttachmentReferences(remote.events);
    if (refs.length === 0) return { degraded: [] };
    if (this.deps.attachments === undefined) {
      await this.update(sessionId, { status: 'attachments-unavailable', degradedAttachments: refs.map((ref) => ref.id) });
      return { degraded: refs.map((ref) => ref.id) };
    }
    const result = await this.waitActive(sessionId, () => this.deps.attachments!.import(refs));
    if (result.degraded.length > 0) {
      const status: SyncStatus = 'attachment-unsupported';
      await this.update(sessionId, { status, degradedAttachments: [...result.degraded] });
      return { degraded: result.degraded };
    }
    await this.update(sessionId, { degradedAttachments: [] });
    return { degraded: [] };
  }

  private async finalize(sessionId: string, remote: RemoteSession, binding: CwdBinding, handle: SessionHandle, checkRemote?: () => Promise<void>, localizedHeaderOverride?: SessionHeader, strictPlacement = false): Promise<ImportResult> {
    const readBack = await this.waitActive(sessionId, () => handle.read(0));
    await verifyImportedProvenance(binding, remote.events as never, readBack.events as never, await this.provenanceOptions(remote, binding, remote.events.length));
    await this.waitActive(sessionId, () => handle.flush());
    await this.update(sessionId, { importState: 'attachments', status: 'importing' });
    const attachments = await this.materializeAttachments(sessionId, remote);
    await this.update(sessionId, { importState: 'warming', status: 'importing', importExpectedCount: remote.events.length, importExpectedChainHash: remote.manifest.entity.chainHash });
    const localizedHeader = localizedHeaderOverride ?? (remote.header.cwd === undefined ? remote.header : { ...remote.header, cwd: await remoteToLocal(binding, remote.header.cwd) });
    let warm: WarmResult = 'partial';
    if (this.deps.projection !== undefined) {
      try { warm = await this.waitActive(sessionId, () => this.deps.projection!.warm(sessionId, localizedHeader, remote.inheritedEventCount, readBack.events)); }
      catch { this.assertActive(sessionId); warm = 'partial'; }
    }
    if (!strictPlacement && warm === 'complete' && this.deps.sessionController !== undefined) {
      try {
        const signal = this.operation(sessionId)?.signal ?? new AbortController().signal;
        const result = await this.waitActive(sessionId, () => this.deps.sessionController!.list({}, signal)) as { items?: readonly unknown[] } | readonly unknown[];
        const items: readonly unknown[] = Array.isArray(result) ? result as readonly unknown[] : ((result as { items?: readonly unknown[] }).items ?? []);
        const listed = items.some((item: unknown) => {
          const value = item as { sessionId?: string; header?: { id?: string } };
          return value.sessionId === sessionId || value.header?.id === sessionId;
        });
        if (!listed) warm = 'partial';
      } catch { this.assertActive(sessionId); warm = 'partial'; }
    }
    const degraded = attachments.degraded.length > 0 || warm !== 'complete';
    const record = this.deps.local.getSession(sessionId);
    const status: SyncStatus = record?.enabled === false && record.detached ? 'detached'
      : attachments.degraded.length > 0 ? 'attachment-unsupported' : warm === 'complete' ? 'synced' : 'projection-warm-partial';
    await checkRemote?.();
    await this.update(sessionId, {
      importState: degraded ? 'degraded' : 'complete', ...(this.catchups.has(sessionId) || this.deps.local.getSession(sessionId)?.catchUpPending === true ? { catchUpPending: false } : {}),
      ...(readBack.events.length === 0 ? {} : { importedThroughSeq: readBack.events.length - 1 }),
      lastSyncedEventCount: remote.events.length, lastSyncedChainHash: remote.manifest.entity.chainHash,
      lastSyncedHeaderHash: remote.manifest.entity.headerHash, remoteETag: remote.manifest.etag,
      lastSyncedAt: this.deps.now(), status, generation: remote.manifest.entity.generation, imported: true,
      ...(localizedHeader.cwd === undefined ? { localCwd: undefined } : { localCwd: localizedHeader.cwd }),
      ...(remote.header.cwd === undefined ? {} : { canonicalCwd: remote.header.cwd }),
      remapped: remote.header.cwd !== localizedHeader.cwd,
      ...(degraded ? { lastError: 'Import completed with degraded attachments/projection.' } : { lastError: undefined }),
    });
    if (!strictPlacement && this.deps.workspace !== undefined) {
      const localizedCwd = remote.header.cwd === undefined ? undefined : await remoteToLocal(binding, remote.header.cwd);
      if (localizedCwd !== undefined) await this.waitActive(sessionId, () => this.deps.workspace!.attach(localizedCwd, undefined, sessionId));
    }
    return { status: degraded ? 'degraded' : 'complete', sessionId, eventCount: remote.events.length, degradedAttachments: attachments.degraded, warm };
  }

  /** Append only a verified canonical suffix to a cold local copy. */
  async catchUp(sessionId: string, remote: RemoteSession, options: CatchUpOptions): Promise<ImportResult> {
    options.signal.throwIfAborted();
    this.assertNotOptingOut(sessionId);
    const existing = this.deps.local.getSession(sessionId);
    if (existing === undefined || !existing.enabled || existing.detached || existing.state !== 'active') throw new AzureSyncError('DISABLED', 'The local session is not opted in.');
    const incomplete = existing.importState !== undefined && existing.importState !== 'complete' &&
      !(existing.importState === 'degraded' && existing.degradedAcknowledged);
    if (incomplete && existing.catchUpPending !== true) throw new AzureSyncError('IMPORT_INCOMPLETE', 'An initial import must be repaired through import recovery, not cold catch-up.');
    if (this.operation(sessionId) !== undefined) throw new AzureSyncError('IMPORT_RACE', 'An import operation is already active.');
    let authority = snapshot(existing);
    let revoked: AzureSyncError | undefined;
    const check: ImportOperation['check'] = (latest) => {
      options.signal.throwIfAborted();
      this.assertNotOptingOut(sessionId);
      if (revoked !== undefined) throw revoked;
      const current = latest === undefined ? this.deps.local.getSession(sessionId) : latest.record;
      if (!sameAuthority(authority, current)) {
        revoked = new AzureSyncError('CANCELLED', 'The local catch-up authority changed.');
        throw revoked;
      }
      if (current?.enabled !== true || current.detached || current.state !== 'active') throw new AzureSyncError('CANCELLED', 'The local sync intent changed.');
      if (current.generation !== remote.manifest.entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The local generation changed during catch-up.');
    };
    const checkRemote = async () => {
      check();
      const current = await this.waitActive(sessionId, () => this.deps.repository.getManifest(sessionId));
      check();
      if (current?.entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The cloud session was removed during catch-up.');
      if (current?.entity.generation !== remote.manifest.entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed during catch-up.');
      if (current.entity.state !== 'active' || !current.entity.enabled) throw new AzureSyncError('DISABLED', 'The cloud session was disabled during catch-up.');
      if (current.entity.headerHash !== remote.manifest.entity.headerHash) throw new AzureSyncError('CONFLICT', 'The immutable cloud header changed during catch-up.');
      if (current.entity.chainHash !== remote.manifest.entity.chainHash || current.entity.eventCount !== remote.events.length) throw new AzureSyncError('TRANSIENT', 'The committed cloud tip moved during catch-up; retry from a fresh verified tip.');
    };
    this.catchups.set(sessionId, { check, signal: options.signal, accept: (record) => { authority = snapshot(record); } });
    let handle: SessionHandle | undefined;
    try {
      check();
      // Write-ahead retry intent distinguishes a canceled/moving-tip catch-up
      // from an incomplete initial import. Never clear it on an aborted await.
      await this.update(sessionId, { catchUpPending: true, importState: 'planned', status: 'importing', lastError: undefined });
      await checkRemote();
      const binding = await this.binding(sessionId, remote.header);
      check();
      if (binding === undefined) throw new AzureSyncError('NEEDS_FOLDER', 'No local folder is mapped for cold catch-up.');
      if (existing.importMappingId !== undefined &&
        (existing.importMappingId !== binding.mapping.id || existing.importMappingRevision !== binding.mapping.revision)) {
        throw new AzureSyncError('MAPPING_UNSTABLE', 'The pending catch-up mapping revision changed.');
      }
      const preflight = await this.preflight(sessionId, remote, binding);
      check();
      await this.update(sessionId, {
        importState: 'planned', status: 'importing', imported: true,
        importExpectedCount: remote.events.length, importExpectedChainHash: remote.manifest.entity.chainHash,
        importMappingId: binding.mapping.id, importMappingRevision: binding.mapping.revision,
        canonicalCwd: remote.header.cwd,
      });
      await checkRemote();
      if (options.isLive()) throw new AzureSyncError('IMPORT_RACE', 'A retained live Agent requires a host restart before cloud catch-up.');
      handle = await this.acquireHandle(sessionId, () => this.deps.persistence.open(sessionId as never, 'write'));
      check();
      await this.validateHandle(sessionId, remote, binding, preflight.header, handle);
      const current = await this.waitActive(sessionId, () => handle!.read(0));
      check();
      if (current.events.length > remote.events.length) throw new AzureSyncError('CONFLICT', 'The local history advanced before the cold write claim.');
      try { await verifyImportedProvenance(binding, remote.events.slice(0, current.events.length) as never, current.events as never, await this.provenanceOptions(remote, binding, current.events.length)); }
      catch { throw new AzureSyncError('CONFLICT', 'The local prefix changed before cold catch-up; it is preserved without merging.'); }
      await this.update(sessionId, { importState: 'appending' });
      await this.appendAll(handle, preflight.events.slice(current.events.length), sessionId, remote, binding, checkRemote);
      return await this.finalize(sessionId, remote, binding, handle, checkRemote);
    } catch (error) {
      if (!options.signal.aborted) {
        const code = error instanceof AzureSyncError ? error.code : undefined;
        if (code === 'TRANSIENT' || code === 'THROTTLED' || code === 'CANCELLED') {
          // Keep the actual planned/appending/attachments/warming checkpoint.
          // update re-checks local opt-out/generation intent before publishing.
          await this.update(sessionId, { status: 'retrying', lastError: error instanceof Error ? error.message.slice(0, 4096) : 'Cold catch-up will retry.' }).catch(() => undefined);
        } else {
          const status: SyncStatus | undefined = code === 'CONFLICT' || code === 'PROVENANCE_MISMATCH' ? 'conflict'
            : code === 'GENERATION_CHANGED' ? 'generation-changed' : code === 'REMOVED_REMOTELY' ? 'removed-remotely'
              : code === 'DISABLED' ? 'detached'
                : error instanceof SessionAlreadyOwnedError || code === 'IMPORT_RACE' ? 'remote-ahead-live' : undefined;
          if (status !== undefined) await this.update(sessionId, {
            status, catchUpPending: false,
            ...(status === 'remote-ahead-live' ? { importState: existing.importState } : { importState: 'failed' }),
            ...(status === 'removed-remotely' || status === 'generation-changed' || code === 'DISABLED' ? { enabled: false } : {}),
            ...(status === 'removed-remotely' ? { state: 'deleted' as const } : code === 'DISABLED' ? { state: 'disabled' as const } : {}),
          }).catch(() => undefined);
          else await this.recordFailure(sessionId, error, { catchUpPending: false });
        }
      }
      if (revoked !== undefined) throw revoked;
      throw error;
    } finally {
      try { if (handle !== undefined) await handle.close(); }
      finally { this.catchups.delete(sessionId); }
    }
  }

  /** First import of a session; the caller may pre-hold a write handle from early claims. */
  async import(sessionId: string, heldHandle?: SessionHandle, signal?: AbortSignal): Promise<ImportResult> {
    const operation = this.beginRequest(sessionId, signal);
    const previous = this.deps.local.getSession(sessionId);
    let handle = heldHandle;
    let completed = false;
    let collision = false;
    let failureReady = false;
    let rejectedWithCancellation = false;
    try {
      operation.check();
      const remote = await this.readRemote(sessionId);
      operation.check();
      if (remote === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud session does not exist.');
      failureReady = true;
      if (previous !== undefined && previous.generation !== remote.manifest.entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The tracked cloud generation changed; import cannot adopt it.');
      if (previous === undefined) {
        // Bind the verified INITIAL target before cwd/preset preflight can fail.
        // Known tracked generations are never replaced by a fresh import request.
        await this.update(sessionId, {
          imported: true, importState: 'planned', status: 'importing',
          generation: remote.manifest.entity.generation, writerEpoch: remote.manifest.entity.writerEpoch,
          importExpectedCount: remote.events.length, importExpectedChainHash: remote.manifest.entity.chainHash,
          canonicalCwd: remote.header.cwd,
        });
      }
      const binding = await this.binding(sessionId, remote.header);
      if (binding === undefined) {
        await this.update(sessionId, { status: 'needs-folder', importState: 'failed', needsFolder: true, unmappablePaths: remote.header.cwd === undefined ? [] : [remote.header.cwd], lastError: 'No local folder is mapped for the remote session.' });
        throw new AzureSyncError('NEEDS_FOLDER', 'No local folder is mapped for the remote session.');
      }
      const preflight = await this.preflight(sessionId, remote, binding);
      const planned = await this.update(sessionId, {
        importState: 'planned', status: 'importing', importExpectedCount: remote.events.length,
        generation: remote.manifest.entity.generation, writerEpoch: remote.manifest.entity.writerEpoch,
        ...(remote.header.parentSession === undefined ? {} : { parentSession: remote.header.parentSession }),
        ...(remote.header.delegationDepth === undefined ? {} : { delegationDepth: remote.header.delegationDepth }),
        subagent: remote.header.origin === 'subagent',
        importExpectedChainHash: remote.manifest.entity.chainHash, importMappingId: binding.mapping.id,
        importMappingRevision: binding.mapping.revision, canonicalCwd: remote.header.cwd,
      });
      if (handle === undefined) {
        try { handle = await this.acquireHandle(sessionId, () => this.deps.persistence.create(preflight.header, { inheritedEventCount: remote.inheritedEventCount as never })); }
        catch (error) {
          operation.check();
          if (error instanceof SessionAlreadyOwnedError || error instanceof SessionAlreadyExistsError) {
            collision = true;
            // Rollback must not resurrect a newer explicit local opt-out.
            if (previous === undefined) {
              const removed = await this.deps.local.deleteSessionIf(sessionId, (latest) => {
                operation.check({ record: latest });
                if (!sameAuthority(planned, latest)) throw new AzureSyncError('CANCELLED', 'The import collision authority changed.');
                return true;
              });
              if (!removed) throw new AzureSyncError('CANCELLED', 'The import collision record was superseded.');
              operation.accept(undefined);
            } else {
              const restored = await this.deps.local.transactSession(sessionId, (latest) => {
                operation.check({ record: latest });
                if (!sameAuthority(planned, latest)) throw new AzureSyncError('CANCELLED', 'The import collision authority changed.');
                return previous;
              });
              operation.accept(restored);
            }
            throw new AzureSyncError('IMPORT_RACE', 'The session is already owned or exists locally.');
          }
          throw error;
        }
      }
      operation.check();
      await this.validateHandle(sessionId, remote, binding, preflight.header, handle);
      await this.update(sessionId, { importState: 'creating' });
      await this.update(sessionId, { importState: 'appending' });
      await this.appendAll(handle, preflight.events, sessionId, remote, binding);
      const result = await this.finalize(sessionId, remote, binding, handle);
      operation.check();
      completed = true;
      return result;
    } catch (error) {
      rejectedWithCancellation = error instanceof AzureSyncError && error.code === 'CANCELLED';
      operation.check();
      if (failureReady && !collision && !rejectedWithCancellation) await this.recordFailure(sessionId, error);
      throw error;
    } finally {
      try {
        let cancelled = false;
        try { operation.check(); } catch { cancelled = true; }
        if (handle !== undefined && (heldHandle === undefined || completed || cancelled || rejectedWithCancellation)) await handle.close().catch(() => undefined);
      } finally { this.requests.delete(sessionId); }
    }
  }

  /** Resume without rewriting history; mapping changes require a fresh prefix proof. */
  async resume(sessionId: string, heldHandle?: SessionHandle, options: ResumeImportOptions = {}): Promise<ImportResult> {
    const operation = this.beginRequest(sessionId, options.signal);
    let handle = heldHandle;
    let completed = false;
    let failureReady = false;
    let rejectedWithCancellation = false;
    try {
      operation.check();
      const existing = this.deps.local.getSession(sessionId);
      if (existing === undefined) throw new AzureSyncError('NOT_FOUND', 'There is no local import to resume.');
      const retained = options.allowDisabledRead === true;
      if (retained && (existing.enabled || !existing.detached || existing.state !== 'disabled' || !isInitialIncompleteImport(existing, true))) throw new AzureSyncError('DISABLED', 'Retained-byte repair is limited to an explicitly disabled unfinished initial import.');
      const remote = await this.readRemote(sessionId, retained);
      operation.check();
      if (remote === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud session does not exist.');
      // A failed repair must not erase proof that this import already completed.
      failureReady = existing.importState !== 'complete' && existing.importState !== 'degraded';
      if (existing.generation !== remote.manifest.entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed since this import began.');
      const initial = isInitialIncompleteImport(existing, retained);
      const anchored = initial && (retained || existing.importExpectedCount !== undefined || existing.importExpectedChainHash !== undefined);
      if (anchored) this.verifyInitialTarget(existing, remote);
      const checkRemote = !anchored ? undefined : async () => {
        const latest = await this.waitActive(sessionId, () => this.deps.repository.getManifest(sessionId));
        this.assertActive(sessionId);
        if (latest === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud import target disappeared.');
        const entity = latest.entity;
        if (entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The cloud import target was removed.');
        if (entity.generation !== existing.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed during import repair.');
        if (!retained && (entity.state !== 'active' || !entity.enabled)) throw new AzureSyncError('DISABLED', 'The cloud import target was disabled.');
        if (entity.headerHash !== remote.manifest.entity.headerHash || entity.inheritedEventCount !== remote.inheritedEventCount) throw new AzureSyncError('PROVENANCE_MISMATCH', 'The immutable import header or inherited cut changed.');
        if (entity.eventCount < remote.events.length) throw new AzureSyncError('CONFLICT', 'The cloud history rolled back during import repair.');
        if (entity.eventCount > remote.events.length) throw new AzureSyncError('TRANSIENT', 'The cloud tip advanced during import repair; retry from a fresh verified snapshot.');
        if (entity.chainHash !== remote.manifest.entity.chainHash) throw new AzureSyncError('PROVENANCE_MISMATCH', 'The verified cloud history changed during import repair.');
      };
      const binding = await this.binding(sessionId, remote.header);
      if (binding === undefined) {
        await this.update(sessionId, { status: 'needs-folder', importState: 'failed', needsFolder: true, unmappablePaths: remote.header.cwd === undefined ? [] : [remote.header.cwd], lastError: 'No local folder is mapped for the remote session.' });
        throw new AzureSyncError('NEEDS_FOLDER', 'No local folder is mapped for the remote session.');
      }
      const preflight = await this.preflight(sessionId, remote, binding);
      await checkRemote?.();
      let created = false;
      if (handle === undefined) {
        try { handle = await this.acquireHandle(sessionId, () => this.deps.persistence.open(sessionId as never, 'write')); }
        catch (error) {
          operation.check();
          if (error instanceof SessionPersistenceNotFoundError && initial) {
            // No file is not a blank-prefix proof for native/complete/catch-up
            // history. Only the verified initial target can authorize create.
            this.verifyInitialTarget(existing, remote);
            this.assertMapping(existing, binding, options.confirmMapping === true);
            await checkRemote?.();
            try {
              handle = await this.acquireHandle(sessionId, () => this.deps.persistence.create(preflight.header, { inheritedEventCount: remote.inheritedEventCount as never }));
              created = true;
            } catch (collision) {
              operation.check();
              if (collision instanceof SessionAlreadyOwnedError || collision instanceof SessionAlreadyExistsError) throw new AzureSyncError('IMPORT_RACE', 'The missing import artifact was claimed concurrently; existing history is preserved.');
              throw collision;
            }
          } else if (error instanceof SessionAlreadyOwnedError) {
            await this.update(sessionId, { status: 'import-race', lastError: 'Another process owns the import write handle.' });
            throw new AzureSyncError('IMPORT_RACE', 'Another process owns the import write handle.');
          } else throw error;
        }
      }
      operation.check();
      await this.validateHandle(sessionId, remote, binding, preflight.header, handle, options.confirmMapping === true);
      const current = await this.waitActive(sessionId, () => handle!.read(0));
      if (current.events.length > preflight.events.length) throw new AzureSyncError('CORRUPT_REMOTE', 'The local import is longer than the committed remote history.');
      await verifyImportedProvenance(binding, remote.events.slice(0, current.events.length) as never, current.events as never, await this.provenanceOptions(remote, binding, current.events.length));
      // Pins change only after both the immutable header/cut and the ENTIRE
      // stored prefix have been forward-localized under the newly chosen root.
      if (options.confirmMapping === true || existing.importMappingId === undefined) await this.update(sessionId, {
        importMappingId: binding.mapping.id, importMappingRevision: binding.mapping.revision,
      });
      if (created) await this.update(sessionId, { importState: 'appending', status: 'importing' });
      await checkRemote?.();
      await this.appendAll(handle, preflight.events.slice(current.events.length), sessionId, remote, binding, checkRemote);
      const result = await this.finalize(sessionId, remote, binding, handle, checkRemote);
      operation.check();
      completed = true;
      return result;
    } catch (error) {
      rejectedWithCancellation = error instanceof AzureSyncError && error.code === 'CANCELLED';
      operation.check();
      // Ordinary failures retain borrowed T4 claims. Cancellation must neither
      // publish a failed checkpoint over newer intent nor retain a closed claim.
      if (failureReady && !rejectedWithCancellation) await this.recordFailure(sessionId, error);
      throw error;
    } finally {
      try {
        let cancelled = false;
        try { operation.check(); } catch { cancelled = true; }
        if (handle !== undefined && (heldHandle === undefined || completed || cancelled || rejectedWithCancellation)) await handle.close().catch(() => undefined);
      } finally { this.requests.delete(sessionId); }
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

  constructor(persistence: SessionPersistence, local: LocalStore, private readonly destinationReserved?: (sessionId: string) => Promise<boolean>) {
    this.persistence = persistence;
    this.local = local;
  }

  async claimAll(): Promise<{ readonly claimed: readonly EarlyClaim[]; readonly raced: readonly string[] }> {
    const claimed: EarlyClaim[] = [];
    const raced: string[] = [];
    for (const [sessionId, record] of this.local.listSessions()) {
      if (record.destination || await this.destinationReserved?.(sessionId)) continue;
      if (record.catchUpPending === true || record.importState === 'complete' || record.importState === undefined) continue;
      try {
        const handle = await this.persistence.open(sessionId as never, 'write');
        try {
          await this.local.transactSession(sessionId, (latest) => {
            if (!sameAuthority(record, latest) || latest?.catchUpPending || latest?.importState === 'complete') {
              throw new AzureSyncError('CANCELLED', 'The incomplete import changed before its early claim.');
            }
            return undefined;
          });
        } catch (error) { await handle.close().catch(() => undefined); throw error; }
        this.handles.set(sessionId, handle);
        claimed.push({ sessionId, handle });
      } catch (error) {
        if (error instanceof SessionAlreadyOwnedError) {
          const updated = await this.local.transactSession(sessionId, (latest) => {
            if (!sameAuthority(record, latest) || latest === undefined || latest.catchUpPending || latest.importState === 'complete') return undefined;
            return { ...latest, status: 'import-race', lastError: 'Another process already owns this incomplete import.' };
          });
          if (updated !== undefined) raced.push(sessionId);
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
