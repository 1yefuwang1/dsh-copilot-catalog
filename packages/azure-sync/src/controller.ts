/** Shared, validated host control plane. Native commands and browser RPC have identical gates. */
import { createHash, randomUUID } from 'node:crypto';
import { decodeGitJson, parseGitFacts, type GitFacts } from './git/sanitize.js';
import type { LocalStore } from './local/store.js';
import type { LocalSessionRecord, PathMappingRecord } from './schema.js';
import type { SettingsService } from './settings.js';
import type { SyncService } from './sync/service.js';
import type { CloudRepository } from './sync/cloud-repository.js';
import type { SessionSource } from './sync/session-source.js';
import { exportLocalSnapshot } from './sync/conflict.js';
import { isInside, mappingRevision, nodeCwdFs, normalizeMapping, normalizeRemotePath, selectMapping, type CwdFs } from './sync/effective-cwd.js';
import { requiresCloudAdmission } from './sync/admission.js';
import { boundedJson, CloudControlError, parseCloudRequest, type CloudControllerPort, type CloudRequest, type CloudResponse } from './protocol.js';

export interface CloudCore {
  readonly service: SyncService;
  readonly repository: CloudRepository;
  readonly testAuth: (signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}
export interface ControllerDependencies {
  readonly local: LocalStore;
  readonly settings: SettingsService;
  readonly core: (signal: AbortSignal) => Promise<CloudCore>;
  readonly current?: () => CloudCore | undefined;
  readonly source?: SessionSource;
  readonly exportDirectory?: string;
  readonly now?: () => number;
  readonly fs?: CwdFs;
  readonly gitMetadata?: (sessionId: string, signal?: AbortSignal) => Promise<GitFacts | null>;
}

function localView(record: LocalSessionRecord) {
  return {
    sessionId: record.sessionId, enabled: record.enabled, state: record.state, status: record.status,
    generation: record.generation, detached: record.detached,
    admissionRequired: requiresCloudAdmission(record), admissionStopped: record.admissionStopped ?? false,
    restartRequired: record.status === 'remote-ahead-live' || record.status === 'live-restart-required',
    needsFolder: record.needsFolder, mappingUnstable: record.mappingUnstable,
    degradedAttachmentCount: record.degradedAttachments.length, degradedAcknowledged: record.degradedAcknowledged,
    hasConflictBackup: record.conflictBackupPath !== undefined,
    ...(record.importState === undefined ? {} : { importState: record.importState }),
    ...(record.lastSyncedEventCount === undefined ? {} : { eventCount: record.lastSyncedEventCount }),
    ...(record.lastSyncedAt === undefined ? {} : { lastSyncedAt: record.lastSyncedAt }),
    // Provider diagnostics, receipts, event payloads, headers and credentials never cross this surface.
  };
}
function mappingView(mapping: PathMappingRecord) {
  return { id: mapping.id, remotePrefix: mapping.remotePrefix, localPrefix: mapping.localPrefix,
    remotePlatform: mapping.remotePlatform, revision: mapping.revision };
}

export class CloudController implements CloudControllerPort {
  private readonly deps: ControllerDependencies;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly shutdown = new AbortController();
  private revision = 0;
  private readonly sessionIntents = new Map<string, AbortController>();
  private readonly safetyTails = new Map<string, Promise<unknown>>();
  private readonly coreFlights = new Set<Promise<CloudCore>>();
  private readonly authProbeFlights = new Set<Promise<void>>();
  private readonly gitProbeFlights = new Set<Promise<GitFacts | null | undefined>>();

  private intentSignal(sessionId: string, replace = false): AbortSignal {
    let intent = this.sessionIntents.get(sessionId);
    if (replace) { intent?.abort(); intent = undefined; }
    if (intent === undefined) { intent = new AbortController(); this.sessionIntents.set(sessionId, intent); }
    return intent.signal;
  }

  private async cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort: () => void = () => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new CloudControlError('CANCELLED'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([work, stopped]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  constructor(deps: ControllerDependencies) { this.deps = deps; }

  private check(signal: AbortSignal): void {
    if (signal.aborted || this.shutdown.signal.aborted) throw new CloudControlError('CANCELLED');
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
  /** Credential notifications enter the same mutation ordering as human actions. */
  maintenance(task: () => Promise<void>): Promise<void> {
    return this.exclusive(async () => { this.check(this.shutdown.signal); await task(); this.revision++; });
  }
  close(): void { this.shutdown.abort(); }
  /** Synchronous priority intent also fences cores created while its durable write is pending. */
  isOptingOut(sessionId: string): boolean { return this.safetyTails.has(sessionId); }

  private target(request: { sessionId?: string }, fallback?: string): string {
    const id = request.sessionId ?? fallback;
    if (id === undefined || id.length === 0 || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) throw new CloudControlError('INVALID_REQUEST');
    return id;
  }
  private async core(signal: AbortSignal): Promise<CloudCore> {
    this.check(signal);
    if (this.coreFlights.size >= 32) throw new CloudControlError('CAPACITY');
    const pending = Promise.resolve().then(() => { this.check(signal); return this.deps.core(signal); });
    this.coreFlights.add(pending);
    void pending.then(() => this.coreFlights.delete(pending), () => this.coreFlights.delete(pending));
    // Aborted callers release the mutation queue, but ignored/late setup work
    // retains a bounded slot until it actually settles (no cancellation amplification).
    const core = await this.cancellable(pending, signal);
    this.check(signal);
    if (core.signal?.aborted) throw new CloudControlError('SETUP_NEEDED');
    return core;
  }
  private current(signal: AbortSignal, core: CloudCore): AbortSignal {
    return AbortSignal.any([signal, this.shutdown.signal, ...(core.signal === undefined ? [] : [core.signal])]);
  }

  private async status(request: Extract<CloudRequest, { action: 'status' }>, signal: AbortSignal) {
    const settings = await this.deps.settings.get();
    this.check(signal);
    const limit = request.limit ?? 25;
    let offset = 0;
    if (request.cursor !== undefined) {
      if (!/^local:(?:0|[1-9]\d{0,6})$/u.test(request.cursor)) throw new CloudControlError('INVALID_REQUEST');
      offset = Number(request.cursor.slice(6));
    }
    const items: ReturnType<typeof localView>[] = [];
    let index = 0;
    let more = false;
    const projection = createHash('sha256');
    for (const [id, record] of this.deps.local.listSessions()) {
      projection.update(JSON.stringify([id, record.generation, record.lastSyncedEventCount ?? null,
        record.importState ?? null, record.importedThroughSeq ?? null, record.lastSyncedHeaderHash ?? null]));
      if (request.sessionId !== undefined) { if (id === request.sessionId) items.push(localView(record)); continue; }
      if (index++ < offset) continue;
      if (items.length < limit) items.push(localView(record)); else more = true;
    }
    return { kind: 'status', revision: this.revision, projectionRevision: projection.digest('hex'), settings,
      items, ...(more && request.sessionId === undefined ? { nextCursor: `local:${offset + items.length}` } : {}),
      ...(request.sessionId !== undefined && items.length === 0 ? { untracked: { sessionId: request.sessionId, enabled: false, admissionRequired: false } } : {}) };
  }

  private affected(record: LocalSessionRecord, mappings: readonly PathMappingRecord[]): boolean {
    return mappings.some(mapping => {
      if (record.importMappingId === mapping.id) return true;
      if (record.localCwd !== undefined && isInside(mapping.localPrefix, record.localCwd)) return true;
      if (record.canonicalCwd === undefined) return false;
      try { return selectMapping([mapping], record.canonicalCwd, mapping.remotePlatform) !== undefined; }
      catch { return false; }
    });
  }
  private async freezeMappings(mappings: readonly PathMappingRecord[], signal: AbortSignal): Promise<void> {
    const affected = [...this.deps.local.listSessions()].filter(([, record]) => !record.detached && (record.enabled || record.catchUpPending) && this.affected(record, mappings));
    if (affected.length === 0) return;
    const core = await this.core(signal);
    for (const [id] of affected) {
      this.check(signal);
      await core.service.stopForMapping(id, this.current(signal, core));
    }
  }

  private async localAction(request: Extract<CloudRequest, { action: 'toggle' | 'detach' | 'export' }>, fallback: string | undefined, signal: AbortSignal) {
    const sessionId = this.target(request, fallback);
    const ready = this.deps.current?.();
    let detail: unknown;
    if (ready !== undefined && !ready.signal?.aborted) {
      const current = this.current(signal, ready);
      if (request.action === 'export') detail = { exportPath: await ready.service.exportLocal(sessionId, current) };
      else if (request.action === 'detach') await ready.service.detach(sessionId, signal);
      else await ready.service.disable(sessionId);
    } else if (request.action === 'export') {
      if (this.deps.source === undefined || this.deps.exportDirectory === undefined) throw new CloudControlError('SETUP_NEEDED');
      const path = await exportLocalSnapshot(this.deps.source, sessionId, this.deps.exportDirectory, signal);
      this.check(signal);
      await this.deps.local.mutateSession(sessionId, latest => ({ ...latest, conflictBackupPath: path }));
      detail = { exportPath: path };
    } else {
      // Offline continuation is always an explicit LOCAL choice. Do not claim a
      // shared cloud opt-out was confirmed when no authenticated core exists.
      const cancellationId = randomUUID();
      this.check(signal);
      // Use the same local permission lane as ready-core on/off/detach, including
      // initial creation while an older opt-in or metadata write is pending.
      await this.deps.local.transactSession(sessionId, latest => {
        this.check(signal);
        const record: LocalSessionRecord = latest ?? {
          sessionId, enabled: false, generation: 1, writerEpoch: 0, state: 'disabled', status: 'detached',
          remapped: false, needsFolder: false, unmappablePaths: [], mappingUnstable: false,
          degradedAttachments: [], degradedAcknowledged: false, imported: false, weArchived: false, detached: true,
        };
        return { ...record, enabled: false, detached: true, admissionStopped: false, status: 'detached',
          resurrectionIntent: undefined, resurrectionCancellationId: cancellationId,
          ...(request.action === 'toggle' ? { state: 'disabled' as const } : {}),
          lastError: request.action === 'toggle' ? 'Local opt-out saved; shared cloud opt-out could not be confirmed.' : undefined };
      });
      detail = { cloudConfirmed: false };
    }
    this.check(signal);
    this.revision++;
    const record = this.deps.local.getSession(sessionId);
    return { kind: 'action', action: request.action, sessionId, state: record?.status ?? 'setup-needed',
      ...(detail === undefined ? {} : { detail }) };
  }

  async execute(input: CloudRequest, context: { sessionId?: string; origin: 'command' | 'rpc'; signal: AbortSignal }): Promise<CloudResponse> {
    const request = parseCloudRequest(input);
    let signal = AbortSignal.any([context.signal, this.shutdown.signal]);
    this.check(signal);
    if (request.action === 'status') return boundedJson(await this.status(context.origin === 'command' && request.sessionId === undefined && context.sessionId !== undefined ? { ...request, sessionId: context.sessionId } : request, signal));
    if (request.action === 'mappings') return boundedJson({ kind: 'mappings', items: [...this.deps.local.listMappings()].map(([, value]) => mappingView(value)) });
    if (request.action === 'git-info') {
      const sessionId = this.target(request, context.origin === 'command' ? context.sessionId : undefined);
      if (this.gitProbeFlights.size >= 16) throw new CloudControlError('CAPACITY');
      const probe = Promise.resolve().then(() => { this.check(signal); return this.deps.gitMetadata?.(sessionId, signal); }).catch(() => null);
      this.gitProbeFlights.add(probe); void probe.then(() => this.gitProbeFlights.delete(probe));
      const facts = await this.cancellable(probe, signal);
      this.check(signal);
      // Purely local inspection: no auth boot, cloud request, Agent resolution or
      // permission mutation. Source Git facts are separately projected in catalog.
      return boundedJson({ kind: 'git', sessionId, local: parseGitFacts(facts) ?? null });
    }
    const threadScoped = !['set-auth', 'set-defaults', 'test-auth', 'map', 'unmap'].includes(request.action) && !(request.action === 'pull' && request.sessionId === undefined);
    const sessionId = threadScoped ? this.target(request as { sessionId?: string }, context.origin === 'command' ? context.sessionId : undefined) : undefined;
    const safety = request.action === 'detach' || (request.action === 'toggle' && !request.enabled);
    if (sessionId !== undefined) signal = AbortSignal.any([signal, this.intentSignal(sessionId, safety)]);
    const barrier = sessionId === undefined ? undefined : this.safetyTails.get(sessionId);
    if (safety) {
      // Local safety intent preempts hung setup/network work. Older requests
      // captured the replaced per-thread signal before queue admission/core IO.
      const task = this.localAction(request, context.origin === 'command' ? context.sessionId : undefined, signal);
      const tail = Promise.allSettled([...(barrier === undefined ? [] : [barrier]), task]);
      this.safetyTails.set(sessionId!, tail);
      void tail.then(() => { if (this.safetyTails.get(sessionId!) === tail) this.safetyTails.delete(sessionId!); });
      try { return boundedJson(await task); }
      catch (error) { if (signal.aborted) throw new CloudControlError('CANCELLED'); throw error; }
    }
    let operationSignal = signal;
    return this.exclusive(async () => {
      this.check(signal);
      if (barrier !== undefined) await this.cancellable(barrier.catch(() => undefined), signal);
      this.check(signal);
      if (request.action === 'export') {
        return boundedJson(await this.localAction(request, context.origin === 'command' ? context.sessionId : undefined, signal));
      }
      let result: unknown;
      switch (request.action) {
        case 'set-auth': {
          if (context.origin !== 'rpc') throw new CloudControlError('FORBIDDEN');
          const { action: _action, ...update } = request;
          result = { kind: 'settings', settings: await this.deps.settings.setAuth(update, signal) };
          break;
        }
        case 'set-defaults': {
          const { action: _action, ...update } = request;
          result = { kind: 'settings', settings: await this.deps.settings.setDefaults(update, signal) };
          break;
        }
        case 'map': {
          const now = (this.deps.now ?? Date.now)();
          const old = request.mapping.id === undefined ? undefined : this.deps.local.getMapping(request.mapping.id);
          if (request.mapping.id !== undefined && old === undefined) throw new CloudControlError('INVALID_REQUEST');
          const id = old?.id ?? randomUUID();
          const next = await normalizeMapping({ ...request.mapping, id, revision: mappingRevision(request.mapping.remotePrefix, request.mapping.localPrefix), createdAt: old?.createdAt ?? now, updatedAt: now }, this.deps.fs ?? nodeCwdFs);
          this.check(signal);
          const candidates = [...this.deps.local.listMappings()].map(([, value]) => value).filter(value => value.id !== id);
          selectMapping([...candidates, next], normalizeRemotePath(next.remotePrefix, next.remotePlatform), next.remotePlatform);
          await this.freezeMappings(old === undefined ? [next] : [old, next], signal);
          this.check(signal);
          await this.deps.local.putMapping(next);
          result = { kind: 'mapping', mapping: mappingView(next) };
          break;
        }
        case 'unmap': {
          const old = this.deps.local.getMapping(request.mappingId);
          if (old === undefined) throw new CloudControlError('INVALID_REQUEST');
          await this.freezeMappings([old], signal);
          this.check(signal);
          await this.deps.local.deleteMapping(old.id);
          result = { kind: 'mapping-removed', mappingId: old.id };
          break;
        }
        case 'test-auth': {
          const core = await this.core(signal);
          operationSignal = this.current(signal, core);
          if (this.authProbeFlights.size >= 32) throw new CloudControlError('CAPACITY');
          const probeSignal = operationSignal;
          const probe = Promise.resolve().then(() => { this.check(probeSignal); return core.testAuth(probeSignal); });
          this.authProbeFlights.add(probe);
          void probe.then(() => this.authProbeFlights.delete(probe), () => this.authProbeFlights.delete(probe));
          await this.cancellable(probe, probeSignal);
          result = { kind: 'auth-test', configured: true };
          break;
        }
        case 'pull': {
          const core = await this.core(signal);
          const current = this.current(signal, core);
          operationSignal = current;
          if (request.sessionId === undefined) {
            const page = await core.repository.listManifestsPage({ limit: request.limit ?? 25, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) }, current);
            result = { kind: 'remote', items: page.items.map(({ entity }) => ({
              sessionId: entity.sessionId, generation: entity.generation, state: entity.state, enabled: entity.enabled,
              eventCount: entity.eventCount, updatedAt: entity.updatedAt, sourcePlatform: entity.sourcePlatform,
              ...(entity.cwd === undefined ? {} : { cwd: entity.cwd }), sourceDeviceId: entity.sourceDeviceId,
              ...(entity.lastWriterDevice === undefined ? {} : { lastWriterDevice: entity.lastWriterDevice }),
              ...(entity.leaseOwner === undefined ? {} : { leaseOwner: entity.leaseOwner }),
              ...(entity.leaseUntil === undefined ? {} : { leaseUntil: entity.leaseUntil }),
              ...(decodeGitJson(entity.gitJson) === undefined ? {} : { git: decodeGitJson(entity.gitJson) }),
              rootSessionId: entity.rootSessionId, rootGeneration: entity.rootGeneration,
              ...(entity.title === undefined ? {} : { title: entity.title.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 256) }),
            })), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
          } else {
            if (this.deps.local.getSession(request.sessionId) === undefined) await core.service.importSession(request.sessionId, current);
            else await core.service.reconcile(request.sessionId, current);
            result = { kind: 'action', action: 'pull', sessionId: request.sessionId, state: core.service.status(request.sessionId).status };
          }
          break;
        }
        default: {
          const sessionId = this.target(request, context.origin === 'command' ? context.sessionId : undefined);
          const core = await this.core(signal);
          const current = this.current(signal, core);
          operationSignal = current;
          let detail: unknown;
          switch (request.action) {
            case 'toggle': detail = request.enabled ? await core.service.enable(sessionId, current) : await core.service.disable(sessionId); break;
            case 'sync': detail = await core.service.sync(sessionId, current); break;
            case 'repair': await core.service.repairSession(sessionId, { signal: current, confirmMapping: request.confirmMapping === true }); break;
            case 'acknowledge-degraded': await core.service.acknowledgeDegraded(sessionId, current); break;
            case 'check-ownership': detail = await core.service.ensureOwnership(sessionId, current, { inspection: true }); break;
            case 'takeover': detail = await core.service.takeover(sessionId, current); break;
            case 'remove': await core.service.removeFromCloud(sessionId, current); break;
            case 'resurrect': await core.service.resurrectInCloud(sessionId, current); break;
          }
          this.check(current);
          result = { kind: 'action', action: request.action, sessionId, state: core.service.status(sessionId).status,
            ...(detail === undefined ? {} : { detail }) };
        }
      }
      this.check(signal);
      this.revision++;
      return boundedJson(result);
    }).catch(error => { if (signal.aborted || operationSignal.aborted) throw new CloudControlError('CANCELLED'); throw error; });
  }
}
