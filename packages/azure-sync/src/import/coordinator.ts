/** Destination import saga. No target Agent exists until explicit, freshly admitted Continue. */
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { WorkspaceId, type WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import type { WorktreeImportPlan, WorktreeImportPlacementV1, ImportActorContext } from '@1yefuwang1/dsh-worktrees/import-contract';
import type { LocalStore } from '../local/store.js';
import type { AzureSyncConfig } from '../config.js';
import type { LocalSessionRecord } from '../schema.js';
import { CloudControlError } from '../protocol.js';
import { AzureSyncError } from '../azure/errors.js';
import { decodeGitContextJson, gitSelectionKey, type GitContext, type StoredGitContext } from '../git/context.js';
import { canonicalJson, payloadHash, sha256Hex } from '../sync/canonical.js';
import { chainEvents, genesisHash, headerHash } from '../sync/chain.js';
import { checkGuards } from '../sync/guards.js';
import { localizeImportedEvents, mappingRevision, nodeCwdFs, normalizeMapping, normalizeRemotePath, remoteToLocal, validateImportedCwds, type CwdBinding } from '../sync/effective-cwd.js';
import type { Importer, ImportResult } from '../sync/importer.js';
import type { CloudRepository } from '../sync/cloud-repository.js';
import type { RemoteSession, RemoteSessionReader } from '../sync/remote-session.js';
import type { SyncService } from '../sync/service.js';
import type { GitObservationAnchor } from '../git/probe.js';
import { compareLocalCode, localGitFingerprint, localGitObservation } from './local-code.js';
import { ImportClaimError, type SidClaim } from './claims.js';
import { assertInitialImportHeader, type ImportGuardV1, type CoordinatorRegistration } from './guard.js';
import { importFence, type ImportReservation } from './journal.js';
import { destinationBinding, reservationMapping } from './bindings.js';
import { materializeInitial } from './materialize.js';
import { ReviewedPlanStore, reviewedDestination, type ReviewedImportPlan } from './plans.js';
import { persistentImportProfileReady } from './profile.js';
import { parseCloudImportRequest, type CloudImportControllerPort, type CloudImportRequest, type CloudImportResponse, type CloudImportView, type CloudImportPlanView, type CloudImportSourceView } from './protocol.js';

export interface DestinationImportRuntime {
  readonly scope: string; readonly signal: AbortSignal; readonly config: AzureSyncConfig;
  readonly repository: CloudRepository; readonly reader: Pick<RemoteSessionReader, 'read'>; readonly importer: Importer; readonly service: SyncService;
}
export interface DestinationImportDependencies {
  readonly ctx: Context; readonly guard?: ImportGuardV1; readonly local: LocalStore;
  readonly runtime: (signal: AbortSignal) => Promise<DestinationImportRuntime>;
  readonly current: () => DestinationImportRuntime | undefined;
  readonly settingsKey: () => string; readonly now?: () => number;
  /** Fresh bounded read-only observation within the explicitly selected Local mapping root. */
  readonly observeLocalGit?: (cwd: string, scopeRoot: string, anchor: GitObservationAnchor, signal: AbortSignal) => Promise<GitContext | null>;
}
interface Running { readonly operationId: string; readonly controller: AbortController; claim?: SidClaim; readonly promise: Promise<CloudImportView> }
function fail(): never { throw new CloudControlError('OPERATION_FAILED'); }
const pending = (record: LocalSessionRecord | undefined) => record?.importState !== 'complete' && !(record?.importState === 'degraded' && record.degradedAcknowledged);
function sourceGit(remote: RemoteSession): StoredGitContext | undefined { return decodeGitContextJson(remote.manifest.entity.gitJson); }
function currentGit(remote: RemoteSession): StoredGitContext | undefined {
  const git = sourceGit(remote);
  return git?.v === 2 && (git.observation.generation !== remote.manifest.entity.generation || git.observation.headerHash !== remote.manifest.entity.headerHash || git.observation.eventCount !== remote.events.length || git.observation.chainHash !== remote.manifest.entity.chainHash) ? undefined : git;
}
function sourceKey(git: StoredGitContext | undefined): string {
  if (!git) return 'unknown';
  // Selection semantics only. Device-local root, observation clocks/history
  // anchors and unselected branch/upstream display hints are not input refs.
  return git.v === 1 ? canonicalJson({ schema: 1, headOid: git.commit, dirty: git.dirty }) : canonicalJson({ schema: 2, objectFormat: git.repository.objectFormat, headOid: git.current.headOid, dirty: git.current.dirty });
}
function relativeCwd(remote: string, prefix: string, platform: 'linux' | 'darwin' | 'win32'): string {
  const value = normalizeRemotePath(remote, platform), root = normalizeRemotePath(prefix, platform);
  const left = platform === 'win32' ? value.toLowerCase() : value, right = platform === 'win32' ? root.toLowerCase() : root;
  if (left === right) return '';
  if (!left.startsWith(right.endsWith('/') ? right : `${right}/`)) throw new CloudControlError('INVALID_REQUEST');
  return value.slice(root.length).replace(/^\/+/, '');
}
function historicalDirectories(remote: RemoteSession, prefix: string, platform: 'linux' | 'darwin' | 'win32'): string[] {
  if (!remote.header.cwd) throw new CloudControlError('INVALID_REQUEST');
  return [...new Set([remote.header.cwd, ...remote.events.flatMap(event => event.type === 'working-directory/change' ? [event.data.cwd] : [])].map(cwd => relativeCwd(cwd, prefix, platform)))];
}
function reviewedRemote(remote: RemoteSession, record: ImportReservation): RemoteSession {
  const identity = record.target;
  if (remote.manifest.entity.generation !== identity.generation || remote.manifest.entity.headerHash !== identity.headerHash || remote.inheritedEventCount !== identity.inheritedEventCount || remote.events.length < identity.eventCount) fail();
  const events = remote.events.slice(0, identity.eventCount);
  const genesis = genesisHash(identity.sessionId, identity.generation, identity.headerHash);
  const chain = events.length ? chainEvents(genesis, events) : { chainHash: genesis, headHash: genesis };
  if (chain.chainHash !== identity.chainHash) fail();
  return { ...remote, events, manifest: { ...remote.manifest, entity: { ...remote.manifest.entity, eventCount: identity.eventCount, headSeq: identity.eventCount - 1, chainHash: identity.chainHash, headHash: chain.headHash } } };
}

export class DestinationImportCoordinator implements CloudImportControllerPort {
  private readonly shutdown = new AbortController();
  private readonly running = new Map<string, Running>();
  private readonly woken = new Set<string>();
  private readonly reviewed = new Map<string, string>();
  private readonly reasons = new Map<string, string>();
  private registration?: CoordinatorRegistration;
  private plans?: ReviewedPlanStore;
  private readonly now: () => number;
  private constructor(private readonly deps: DestinationImportDependencies) { this.now = deps.now ?? Date.now; }
  static async create(deps: DestinationImportDependencies): Promise<DestinationImportCoordinator> {
    const coordinator = new DestinationImportCoordinator(deps);
    if (deps.guard) {
      coordinator.plans = await ReviewedPlanStore.open(join(dirname(deps.guard.journal.root), 'plans'));
      coordinator.registration = deps.guard.registerCoordinator({ version: 1, ready: record => coordinator.capabilityReady(record), continuationReady: async record => {
        const local = deps.local.getSession(record.target.sessionId);
        return local?.enabled === true && local.generation === record.target.generation && !local.detached && local.destination?.phase === 'ready' && !pending(local) && await coordinator.codeConsentReady(record) && await coordinator.destinationReceiptReady(record);
      } });
    }
    return coordinator;
  }
  private port(): WorktreeImportPlacementV1 | undefined {
    const port = this.deps.ctx.get('worktreeImportPlacement') as WorktreeImportPlacementV1 | undefined;
    return port?.version === 1 && typeof port.folders === 'function' && typeof port.classifyPath === 'function' && typeof port.bindLocalImported === 'function' ? port : undefined;
  }
  private workspace(): WorkspaceRegistry | undefined { return this.deps.ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined; }
  private async capabilityReady(record: ImportReservation): Promise<boolean> {
    if (this.shutdown.signal.aborted || !this.deps.guard?.isGuardedPersistence(this.deps.ctx.sessionPersistence.identity)) return false;
    const runtime = this.deps.current();
    if (!runtime || runtime.signal.aborted || runtime.scope !== record.target.scope || !this.workspace()) return false;
    const port = this.port();
    if (record.mode === 'worktree') {
      if (!port) return false;
      // Only capability/intent checks here: placement's own pre-effect
      // assertPlacement calls this callback, so invoking its controller here
      // would recurse. Concrete receipts are revalidated at bind/Continue.
    } else if (record.sourceFolder && !port) return false;
    return true;
  }
  private async codeConsentReady(record: ImportReservation): Promise<boolean> {
    const plan = await this.plans?.read(record.operationId);
    if (!plan || record.mode === 'local' && !plan.localGitFingerprint) return false;
    const git = plan.sourceGitJson ? decodeGitContextJson(plan.sourceGitJson) : undefined;
    const sourceUnverified = git?.v !== 2 || git.current.unborn || !git.current.headOid || git.current.dirty !== 'clean' ||
      git.observation.generation !== plan.target.generation || git.observation.headerHash !== plan.target.headerHash || git.observation.eventCount !== plan.target.eventCount || git.observation.chainHash !== plan.target.chainHash;
    return !(plan.codeMismatch || sourceUnverified) || record.codeMismatchAcknowledged === true;
  }
  private async observeLocal(cwd: string, scopeRoot: string, anchor: GitObservationAnchor, signal: AbortSignal): Promise<GitContext | undefined> {
    if (!this.deps.observeLocalGit) return undefined;
    const observation = { generation: anchor.generation, headerHash: anchor.headerHash, eventCount: anchor.eventCount, chainHash: anchor.chainHash };
    try { return localGitObservation(await this.deps.observeLocalGit(cwd, scopeRoot, observation, signal)); }
    catch { this.check(signal); return undefined; }
  }
  private async assertLocalReview(plan: ReviewedImportPlan, signal: AbortSignal): Promise<void> {
    if (plan.reservation.mode !== 'local') return;
    if (!plan.localGitFingerprint) fail(); // Pre-fix durable Local reviews are not inferred verified.
    const current = await this.observeLocal(plan.reservation.finalCwd, plan.reservation.mapping.localRoot, plan.target, signal);
    this.check(signal);
    if (localGitFingerprint(current) !== plan.localGitFingerprint) fail();
  }
  private async destinationReceiptReady(record: ImportReservation): Promise<boolean> {
    try {
      if (!record.binding || record.phase !== 'ready' || await realpath(record.mapping.localRoot) !== record.mapping.localRoot || await realpath(record.finalCwd) !== record.finalCwd || !(await stat(record.finalCwd)).isDirectory()) return false;
      const workspace = this.workspace()?.get(WorkspaceId(record.binding.workspaceId));
      if (!workspace || workspace.path !== record.finalCwd || !workspace.sessionIds.includes(SessionId(record.target.sessionId)) || await workspace.status() !== 'ok') return false;
      const port = this.port();
      if (record.mode === 'worktree') {
        const status = await port?.inspect(record.operationId, this.shutdown.signal);
        if (status?.phase !== 'ready' || !status.receipt || !record.placement || status.receipt.worktreeId !== record.placement.worktreeId || status.receipt.commonDir !== record.placement.commonDir || status.receipt.workspaceId !== record.binding.workspaceId) return false;
      }
      if (record.sourceFolder) {
        const folder = (await port?.folders(this.shutdown.signal))?.find(folder => folder.projectId === record.sourceFolder!.projectId && folder.folderId === record.sourceFolder!.folderId);
        if (!folder || await realpath(folder.path) !== record.sourceFolder.path) return false;
      }
      return true;
    } catch { return false; }
  }
  private async profile(): Promise<boolean> { return persistentImportProfileReady(this.deps.ctx, this.deps.guard); }
  private check(signal: AbortSignal) { signal.throwIfAborted(); this.shutdown.signal.throwIfAborted(); }
  private actor(id: string, target: string, origin: 'command' | 'rpc', signal: AbortSignal): ImportActorContext {
    if (id === target) throw new CloudControlError('FORBIDDEN');
    const actor = (this.deps.ctx.get('agents') as AgentRegistry | undefined)?.get(SessionId(id));
    if (!actor || actor.session.header.origin === 'subagent') throw new CloudControlError('FORBIDDEN');
    return { actor, origin: origin === 'command' ? 'command' : 'ui', signal };
  }
  private async remote(sessionId: string, generation: number | undefined, runtime: DestinationImportRuntime, signal: AbortSignal, retained = false) {
    const current = AbortSignal.any([signal, runtime.signal, this.shutdown.signal]);
    const check = () => {
      this.check(current);
      if (this.deps.current()?.scope !== runtime.scope) throw new CloudControlError('CANCELLED');
    };
    check();
    const remote = await runtime.reader.read(sessionId, { signal: current, check, allowDisabled: retained,
      ...(generation === undefined ? {} : { expectedGeneration: generation }) });
    check();
    if (!remote || generation !== undefined && remote.manifest.entity.generation !== generation) fail();
    return remote;
  }
  private inspectView(remote: RemoteSession, eligible: boolean, reason?: string, operationId?: string): CloudImportSourceView {
    const git = sourceGit(remote);
    return { version: 2, kind: 'import-source', sessionId: remote.header.id, generation: remote.manifest.entity.generation,
      cwd: remote.header.cwd ?? '', platform: remote.manifest.entity.sourcePlatform, eventCount: remote.events.length,
      eligible, seeded: remote.header.isSeeded, gitUsable: currentGit(remote)?.v === 2,
      ...(reason ? { reason } : {}), ...(git ? { sourceGit: git } : {}), ...(operationId ? { operationId } : {}) };
  }
  private async view(record: ImportReservation): Promise<CloudImportView> {
    const local = this.deps.local.getSession(record.target.sessionId);
    let pendingInput = false;
    if (record.artifact) try { const snapshot = await this.readSnapshot(record.target.sessionId); pendingInput = this.pendingInput(snapshot); } catch { /* reflected by readiness below */ }
    const claimState = !this.running.has(record.target.sessionId) ? await this.deps.guard?.claims.inspect(record.target.sessionId) : 'busy';
    const offlineRecovery = claimState === 'recovery-required' || claimState === 'uncertain';
    const foreignBusy = claimState === 'busy' && !this.running.has(record.target.sessionId);
    const generationStopped = local?.generation !== undefined && local.generation !== record.target.generation || ['generation-changed', 'removed-remotely', 'remote-missing'].includes(local?.status ?? '');
    const metadataPending = record.phase === 'ready' && local?.destination?.phase !== 'ready';
    const codeReviewMissing = record.phase === 'ready' && !await this.codeConsentReady(record);
    const reason = offlineRecovery ? 'offline-recovery-required' : foreignBusy ? 'operation-owned-by-another-runtime' : generationStopped ? 'source-generation-unavailable' : codeReviewMissing ? 'code-review-required' : metadataPending ? 'destination-metadata-repair-required' : this.reasons.get(record.operationId) ?? record.error;
    const phase = ({ 'destination-preparing': 'preparing', 'destination-prepared': 'prepared', 'initial-readable': 'materializing', 'history-importing': 'importing', 'history-verified': 'binding', 'destination-bound': 'binding' } as const)[record.phase as 'destination-preparing'] ?? record.phase;
    return { version: 2, kind: 'import-operation', operationId: record.operationId, sessionId: record.target.sessionId,
      generation: record.target.generation, revision: record.revision + 1, phase: offlineRecovery || generationStopped || codeReviewMissing ? 'recovery-required' : metadataPending ? 'binding' : phase as CloudImportView['phase'], destination: record.mode, cwd: record.finalCwd,
      ...(record.placement ? { worktreeId: record.placement.worktreeId, branch: record.placement.branch, baseOid: record.placement.baseOid } : {}),
      ...(reason ? { reason } : {}),
      continuable: !offlineRecovery && !foreignBusy && !generationStopped && !metadataPending && !codeReviewMissing && record.phase === 'ready' && !record.cancelledAt && !pending(local) && local?.enabled === true && !local.detached && await this.capabilityReady(record) && await this.destinationReceiptReady(record), pendingInput };
  }
  private cancelledView(plan: ReviewedImportPlan, reason?: string): CloudImportView {
    return { version: 2, kind: 'import-operation', operationId: plan.operationId, sessionId: plan.sessionId, generation: plan.target.generation, revision: plan.revision, phase: 'cancelled', destination: plan.reservation.mode, continuable: false, pendingInput: false, ...(reason ? { reason } : {}) };
  }
  private planView(plan: ReviewedImportPlan): CloudImportPlanView {
    const destination = reviewedDestination(plan);
    const worktree = plan.worktreePlanJson ? JSON.parse(plan.worktreePlanJson) as WorktreeImportPlan : undefined;
    const git = plan.sourceGitJson ? decodeGitContextJson(plan.sourceGitJson) : undefined;
    const local = plan.localGitJson ? localGitObservation(JSON.parse(plan.localGitJson)) : undefined;
    const branch = worktree?.branch ?? local?.current.branchRef, baseOid = worktree?.base.oid ?? local?.current.headOid;
    return { version: 2, kind: 'import-plan', operationId: plan.operationId, sessionId: plan.sessionId, generation: plan.target.generation,
      revision: plan.revision, expiresAt: plan.expiresAt, eventCount: plan.target.eventCount, cwd: plan.reservation.finalCwd, destination: destination.kind,
      ...(branch ? { branch } : {}), ...(baseOid ? { baseOid } : {}), ...(git ? { sourceGit: git } : {}), warnings: plan.warnings, codeMismatch: plan.codeMismatch };
  }
  private async readSnapshot(sessionId: string) {
    const handle = await this.deps.ctx.sessionPersistence.open(SessionId(sessionId), 'read');
    try { return { header: handle.header, inheritedEventCount: Number(handle.inheritedEventCount), events: (await handle.read(0)).events }; }
    finally { await handle.close(); }
  }
  private pendingInput(snapshot: Awaited<ReturnType<DestinationImportCoordinator['readSnapshot']>>): boolean {
    const projections = this.deps.ctx.get('sessionProjections') as SessionProjectionRegistry | undefined;
    if (!projections) throw new CloudControlError('SETUP_NEEDED');
    const value = projections.restore({}, snapshot.events, SessionLogOffset(0), snapshot.header, SessionLogOffset(snapshot.inheritedEventCount)).snapshot.values.inbox as { 'next-turn'?: readonly unknown[]; 'next-step'?: readonly unknown[] } | undefined;
    return !!value && ((value['next-turn']?.length ?? 0) > 0 || (value['next-step']?.length ?? 0) > 0);
  }
  async reserved(sessionId: string): Promise<boolean> { return !!await this.deps.guard?.journal.read(sessionId); }
  async execute(input: CloudImportRequest, context: { origin: 'command' | 'rpc'; sessionId?: string; signal: AbortSignal }): Promise<CloudImportResponse> {
    const request = parseCloudImportRequest(input); const signal = AbortSignal.any([context.signal, this.shutdown.signal]); this.check(signal);
    if (request.action === 'import-admission') {
      const local = this.deps.local.getSession(request.sessionId);
      if (!this.deps.guard) return local?.destination ? { version: 2, kind: 'import-admission', sessionId: request.sessionId, reserved: true, ready: false, continued: false, operationId: local.destination.operationId, generation: local.generation, reason: 'profile-required' }
        : { version: 2, kind: 'import-admission', sessionId: request.sessionId, reserved: false, ready: true, continued: true };
      const record = await this.deps.guard.journal.read(request.sessionId);
      if (!record) {
        if (local?.destination) return { version: 2, kind: 'import-admission', sessionId: request.sessionId, reserved: true, ready: false, continued: false, operationId: local.destination.operationId, generation: local.generation, reason: 'recovery-required' };
        return { version: 2, kind: 'import-admission', sessionId: request.sessionId, reserved: false, ready: true, continued: true };
      }
      const ready = record.phase === 'ready' && record.artifact !== undefined && record.binding !== undefined && local?.destination?.phase === 'ready' && local.generation === record.target.generation && !pending(local) && await this.codeConsentReady(record) && await this.destinationReceiptReady(record);
      let continued = false;
      try { await this.deps.guard.writeAdmission(request.sessionId); continued = ready; } catch { /* Read-only current activation check; NEVER boot auth or resolve Native. */ }
      return { version: 2, kind: 'import-admission', sessionId: request.sessionId, reserved: true, ready, continued, operationId: record.operationId, generation: record.target.generation,
        ...(!continued ? { reason: record.cancelledAt !== undefined ? 'cancelled' : ready ? 'continue-required' : 'destination-not-ready' } : {}) };
    }
    if (request.action === 'import-capabilities') {
      const mounted = await this.profile(), port = this.port();
      const folders = port ? await port.folders(signal) : (this.workspace()?.list() ?? []).map(folder => ({ path: folder.path, title: folder.title }));
      const classification = !!port || this.deps.ctx.get('gitWorktrees') === undefined;
      return { version: 2, kind: 'import-capabilities', local: mounted && !!this.workspace() && classification, worktree: mounted && !!port && !!this.workspace(), seeded: false, folders,
        ...(!mounted ? { reason: 'profile-required' } : !classification ? { reason: 'managed-path-classification-unavailable' } : !this.workspace() ? { reason: 'workspace-unavailable' } : {}) };
    }
    if (request.action === 'import-bases') {
      if (!await this.profile()) throw new CloudControlError('SETUP_NEEDED');
      const port = this.port(); if (!port) throw new CloudControlError('SETUP_NEEDED');
      const result = await port.bases(request.projectId, request.folderId, this.actor(request.permissionActorId, '', context.origin, signal));
      return { version: 2, kind: 'import-bases', projectId: request.projectId, folderId: request.folderId, repoRoot: result.repoRoot, objectFormat: result.objectFormat, head: result.head,
        branches: result.branches.map(branch => ({ ...branch, name: branch.name.startsWith('refs/heads/') ? branch.name : `refs/heads/${branch.name}` })) };
    }
    if (request.action === 'inspect-import') {
      const runtime = await this.deps.runtime(signal); this.check(signal);
      const remote = await this.remote(request.sessionId, request.generation, runtime, signal); this.check(signal);
      const operation = await this.deps.guard?.journal.read(request.sessionId);
      const reason = operation && operation.target.generation !== remote.manifest.entity.generation ? 'source-generation-unavailable' : remote.header.origin === 'subagent' ? 'independent-subagent-placement-unsupported' : remote.header.isSeeded ? 'seeded-initial-materialization-unsupported' : !remote.header.cwd ? 'source-cwd-required' : !await this.profile() ? 'profile-required' : undefined;
      return this.inspectView(remote, !reason, reason, operation?.operationId);
    }
    if (!this.deps.guard || !this.registration || !this.plans) throw new CloudControlError('SETUP_NEEDED');
    if (request.action === 'plan-import') return this.plan(request, context.origin, signal);
    const record = await this.deps.guard.journal.read(request.sessionId);
    if (record && record.operationId !== request.operationId) throw new CloudControlError('INVALID_REQUEST');
    if (request.action === 'cancel-import') return this.cancelSession(request.sessionId, request.operationId);
    if (request.action === 'import-operation') {
      if (record) return this.view(record);
      const plan = await this.plans.read(request.operationId);
      if (!plan || plan.sessionId !== request.sessionId) fail();
      return plan.cancelledAt === undefined ? this.planView(plan) : { version: 2, kind: 'import-operation', operationId: plan.operationId, sessionId: plan.sessionId, generation: plan.target.generation, revision: plan.revision, phase: 'cancelled', destination: plan.reservation.mode, continuable: false, pendingInput: false };
    }
    if (request.action === 'continue-import') {
      if (!record || request.revision !== record.revision + 1) fail();
      const existing = this.running.get(request.sessionId); if (existing) return existing.promise;
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.continue(record, request.acknowledgePendingInput === true, controller.signal)).finally(() => { this.running.delete(request.sessionId); });
      this.running.set(request.sessionId, { operationId: request.operationId, controller, promise }); return promise;
    }
    if (request.action !== 'commit-import' && request.action !== 'resume-import') fail();
    if (!await this.profile()) throw new CloudControlError('SETUP_NEEDED');
    const existing = this.running.get(request.sessionId);
    if (existing) { if (existing.operationId !== request.operationId) fail(); return existing.promise; }
    const plan = await this.plans.read(request.operationId);
    if (!plan || plan.sessionId !== request.sessionId || plan.cancelledAt !== undefined && !record) fail();
    if (record?.phase === 'ready' && this.deps.local.getSession(request.sessionId)?.destination?.phase === 'ready') return this.view(record);
    if (record ? request.revision !== record.revision + 1 : request.revision !== plan.revision || plan.expiresAt < this.now()) fail();
    if (plan.codeMismatch && !request.acknowledgeCodeMismatch && !record?.codeMismatchAcknowledged && record?.cancelledAt === undefined) throw new CloudControlError('CONFIRM_REQUIRED');
    if (this.running.size >= 16) throw new CloudControlError('CAPACITY');
    let claim: SidClaim;
    try { claim = await this.deps.guard.claims.acquire(request.sessionId, request.operationId); }
    catch (error) {
      if (record) {
        const state = await this.deps.guard.claims.inspect(request.sessionId);
        if (state === 'recovery-required' || state === 'uncertain') { this.reasons.set(record.operationId, 'offline-recovery-required'); return this.view(record); }
        if (state === 'busy') { this.reasons.set(record.operationId, 'operation-owned-by-another-runtime'); return this.view(record); }
      }
      throw error;
    }
    const controller = new AbortController();
    const promise = this.run(plan, claim, controller.signal, context.origin, !!record?.cancelledAt, request.acknowledgeCodeMismatch === true).catch(async error => {
      let latest = await this.deps.guard!.journal.read(request.sessionId);
      if (latest?.cancelledAt !== undefined && !this.deps.local.getSession(request.sessionId)) {
        try { await this.registration!.releaseCancelledBeforeEffects(claim, importFence(latest)); } catch { /* Exact committed/unknown effects stay reserved. */ }
        latest = await this.deps.guard!.journal.read(request.sessionId);
      }
      if (latest?.cancelledAt !== undefined) this.reasons.set(request.operationId, 'cancelled-retained-effects');
      else this.reasons.set(request.operationId, error instanceof ImportClaimError ? 'offline-recovery-required' : 'import-recovery-required');
      if (latest && latest.cancelledAt === undefined) latest = await this.deps.guard!.journal.update(claim, importFence(latest), current => ({ ...current, phase: 'recovery-required', error: 'recovery-required', revision: current.revision + 1, updatedAt: this.now() })).catch(() => latest);
      if (latest) return this.view(latest);
      const reviewed = await this.plans!.read(request.operationId);
      if (reviewed?.cancelledAt !== undefined) return this.cancelledView(reviewed);
      throw error;
    }).finally(async () => { this.running.delete(request.sessionId); await claim.release(); });
    this.running.set(request.sessionId, { operationId: request.operationId, controller, claim, promise });
    return promise;
  }
  private async plan(request: Extract<CloudImportRequest, { action: 'plan-import' }>, origin: 'command' | 'rpc', signal: AbortSignal): Promise<CloudImportResponse> {
    if (!await this.profile()) throw new CloudControlError('SETUP_NEEDED');
    const occupied = await this.deps.guard!.journal.read(request.sessionId);
    if (occupied) { const view = await this.view(occupied); return occupied.target.generation === request.generation ? view : { ...view, phase: 'recovery-required', continuable: false, reason: 'source-generation-unavailable' }; }
    if (this.deps.local.getSession(request.sessionId) || await this.deps.ctx.sessionPersistence.stat(SessionId(request.sessionId))) fail();
    const old = await this.plans!.read(request.operationId); if (old) { if (old.requestJson !== canonicalJson(request) || old.cancelledAt !== undefined) fail(); return this.planView(old); }
    if (this.reviewed.size >= 128) throw new CloudControlError('CAPACITY');
    const runtime = await this.deps.runtime(signal); this.check(signal);
    const remote = await this.remote(request.sessionId, request.generation, runtime, signal);
    if (remote.header.origin === 'subagent' || remote.header.isSeeded || !remote.header.cwd || !checkGuards({ header: remote.header, events: remote.events }).ok) fail();
    const platform = request.mapping.remotePlatform;
    if (platform !== remote.manifest.entity.sourcePlatform) throw new CloudControlError('INVALID_REQUEST');
    const prefix = normalizeRemotePath(request.mapping.remotePrefix, platform);
    const directories = historicalDirectories(remote, prefix, platform);
    const intentId = randomUUID(), now = this.now();
    const target = { scope: runtime.scope, sessionId: request.sessionId, generation: request.generation, headerHash: remote.manifest.entity.headerHash, inheritedEventCount: remote.inheritedEventCount, eventCount: remote.events.length, chainHash: remote.manifest.entity.chainHash };
    let worktree: WorktreeImportPlan | undefined, binding: CwdBinding, finalCwd: string, sourceFolder: ImportReservation['sourceFolder'];
    const warnings: string[] = []; let codeMismatch = false, selection: string | undefined;
    let localGit: GitContext | undefined, localFingerprint: string | undefined;
    const port = this.port();
    if (request.destination.kind === 'worktree') {
      if (!port) throw new CloudControlError('SETUP_NEEDED');
      const actor = this.actor(request.destination.permissionActorId, request.sessionId, origin, signal);
      const base = request.destination.base; // Public v1 port takes the validated FULL refs/heads/... ref. No ambiguous short-name fallback.
      worktree = await port.plan({ operationId: request.operationId, target, intentId, projectId: request.destination.projectId, folderId: request.destination.folderId, base, requiredDirectories: directories, ...(request.destination.label ? { label: request.destination.label } : {}) }, actor);
      if (relativeCwd(remote.header.cwd, prefix, platform) !== worktree.projectSubdir.replaceAll('\\', '/').replace(/^\.\/?$/u, '')) throw new CloudControlError('INVALID_REQUEST');
      finalCwd = worktree.effectiveCwd;
      binding = { mapping: { id: randomUUID(), remotePrefix: prefix, localPrefix: worktree.checkoutRoot, remotePlatform: platform, revision: mappingRevision(prefix, worktree.checkoutRoot), createdAt: now, updatedAt: now }, fs: nodeCwdFs };
      const folders = await port.folders(signal); const selected = folders.find(folder => folder.projectId === request.destination.projectId && folder.folderId === request.destination.folderId); if (!selected) fail();
      sourceFolder = { projectId: selected.projectId, folderId: selected.folderId, path: selected.path };
      const choices = await port.bases(selected.projectId, selected.folderId, actor);
      const git = currentGit(remote), sourceOid = git?.v === 2 ? git.current.headOid : git?.commit;
      codeMismatch = !git || git.v !== 2 || sourceOid !== request.destination.base.oid || (git.v === 2 && (git.repository.objectFormat !== choices.objectFormat || git.current.dirty !== 'clean'));
      if (codeMismatch) warnings.push('code-snapshot-differs-or-source-unverified');
      if (git?.v === 2 && git.current.dirty !== 'clean' || git?.v === 1 && git.dirty !== 'clean') warnings.push('uncommitted-source-files-are-not-restored');
      if (git?.v === 2 && git.current.dirty === 'dirty') warnings.push('source-working-tree-dirty');
      if (git?.v === 2 && git.current.dirty === 'unknown') warnings.push('source-working-tree-unknown');
      selection = gitSelectionKey({ schemaVersion: sourceGit(remote)?.v ?? 1, repositoryIdentity: choices.commonDir, objectFormat: choices.objectFormat, headOid: choices.head, selectedOid: request.destination.base.oid, ...(request.destination.base.kind === 'local-branch' ? { resolvedRef: request.destination.base.name } : {}) });
    } else {
      if (!this.workspace() || !port && this.deps.ctx.get('gitWorktrees') !== undefined) throw new CloudControlError('SETUP_NEEDED');
      finalCwd = await realpath(request.destination.folderPath); if (!isAbsolute(finalCwd) || !(await stat(finalCwd)).isDirectory()) throw new CloudControlError('INVALID_REQUEST');
      if (port && await port.classifyPath(finalCwd, request.sessionId, signal) !== 'local') throw new CloudControlError('FORBIDDEN');
      if (request.destination.projectId) {
        if (!port) throw new CloudControlError('SETUP_NEEDED');
        const selected = (await port.folders(signal)).find(folder => folder.projectId === request.destination.projectId && folder.folderId === request.destination.folderId);
        if (!selected || await realpath(selected.path) !== finalCwd) throw new CloudControlError('INVALID_REQUEST');
        sourceFolder = { projectId: selected.projectId, folderId: selected.folderId, path: finalCwd };
      }
      const mapping = await normalizeMapping({ id: randomUUID(), remotePrefix: prefix, localPrefix: request.mapping.localPrefix ?? finalCwd, remotePlatform: platform, revision: '', createdAt: now, updatedAt: now });
      binding = { mapping, fs: nodeCwdFs };
      if (await remoteToLocal(binding, remote.header.cwd) !== finalCwd || !(await validateImportedCwds(binding, remote.events.flatMap(event => event.type === 'working-directory/change' ? [event.data.cwd] : []))).ok) throw new CloudControlError('INVALID_REQUEST');
      localGit = await this.observeLocal(finalCwd, binding.mapping.localPrefix, target, signal); this.check(signal);
      localFingerprint = localGitFingerprint(localGit);
      const comparison = compareLocalCode(currentGit(remote), localGit);
      codeMismatch = comparison.codeMismatch; warnings.push(...comparison.warnings);
    }
    const header = { ...remote.header, delegationDepth: remote.header.delegationDepth ?? 0, cwd: finalCwd };
    assertInitialImportHeader(header, remote.inheritedEventCount); this.check(signal);
    const requestHash = worktree?.requestHash ?? sha256Hex(canonicalJson({ request, target, finalCwd }));
    const reservation: ImportReservation = { version: 1, operationId: request.operationId, requestHash, target, intentId, intentRevision: 0, revision: 0, mode: request.destination.kind, finalCwd,
      localHeaderHash: headerHash(header, remote.inheritedEventCount as never), mapping: { id: binding.mapping.id, revision: binding.mapping.revision, remotePlatform: platform, remotePrefix: prefix, localRoot: binding.mapping.localPrefix },
      ...(sourceFolder ? { sourceFolder } : {}), phase: 'reserved', effects: [], createdAt: now, updatedAt: now };
    const git = sourceGit(remote);
    const plan = await this.plans!.put({ version: 1, operationId: request.operationId, sessionId: request.sessionId, revision: 1, target, requestJson: canonicalJson(request), reservation,
      localizedHeaderJson: canonicalJson(header), ...(worktree ? { worktreePlanJson: canonicalJson(worktree) } : {}), settingsKey: this.deps.settingsKey(),
      ...(selection ? { gitSelectionKey: selection } : {}), ...(git ? { sourceGitJson: JSON.stringify(git) } : {}),
      ...(localFingerprint ? { localGitFingerprint: localFingerprint } : {}), ...(localGit ? { localGitJson: JSON.stringify(localGit) } : {}), codeMismatch, warnings, expiresAt: now + 10 * 60_000, createdAt: now });
    this.reviewed.set(plan.operationId, plan.sessionId); return this.planView(plan);
  }
  private async run(plan: ReviewedImportPlan, claim: SidClaim, userSignal: AbortSignal, origin: 'command' | 'rpc', retained: boolean, acknowledgedCodeMismatch = false): Promise<CloudImportView> {
    this.check(userSignal);
    if (retained) {
      const existing = await this.deps.guard!.journal.read(plan.sessionId), local = this.deps.local.getSession(plan.sessionId);
      if (existing?.cancelledAt !== undefined && existing.historyArtifact && local?.destination?.operationId === existing.operationId && !local.enabled && local.detached && ['complete', 'degraded'].includes(local.importState ?? '')) {
        const snapshot = await this.readSnapshot(plan.sessionId);
        this.deps.guard!.validateSnapshot(existing, snapshot, existing.historyArtifact);
        this.check(userSignal); await claim.assertOwned();
        this.reasons.set(existing.operationId, 'cancelled-retained-history-already-complete');
        return this.view(existing); // Local-only, no cloud read/lease, no truncation of later Native-authored history.
      }
    }
    const runtime = await this.deps.runtime(userSignal); const signal = AbortSignal.any([userSignal, runtime.signal, this.shutdown.signal]); this.check(signal);
    if (runtime.scope !== plan.target.scope || this.deps.settingsKey() !== plan.settingsKey && !await this.deps.guard!.journal.read(plan.sessionId)) fail();
    const remote = await this.remote(plan.sessionId, plan.target.generation, runtime, signal, retained); this.check(signal);
    const reviewed = reviewedRemote(remote, plan.reservation);
    const header = JSON.parse(plan.localizedHeaderJson) as SessionHeader;
    let record = await this.deps.guard!.journal.read(plan.sessionId);
    if (!retained && !record?.artifact) {
      await this.assertLocalReview(plan, signal);
      if (sourceKey(sourceGit(remote)) !== sourceKey(plan.sourceGitJson ? decodeGitContextJson(plan.sourceGitJson) : undefined)) fail();
    }
    if (!record) {
      if (this.deps.local.getSession(plan.sessionId)) fail();
      if (sourceKey(sourceGit(remote)) !== sourceKey(plan.sourceGitJson ? decodeGitContextJson(plan.sourceGitJson) : undefined)) fail();
      this.check(signal);
      record = await this.registration!.reserve(claim, { ...plan.reservation, ...(acknowledgedCodeMismatch ? { codeMismatchAcknowledged: true as const } : {}) }, signal);
    }
    if (record.cancelledAt !== undefined) {
      // Explicit user repair may restore retained bytes at the SAME prepared
      // destination, but cannot provision Git, revive Off, or publish Ready.
      if (record.mode === 'worktree') {
        const port = this.port(); if (!port || !plan.worktreePlanJson) fail();
        const status = await port.inspect(record.operationId, signal);
        const receipt = status?.receipt, expected = JSON.parse(plan.worktreePlanJson) as WorktreeImportPlan;
        if (!receipt || status?.phase === 'reclaimed' || receipt.operationId !== record.operationId || receipt.requestHash !== record.requestHash || receipt.worktreeId !== expected.worktreeId || receipt.effectiveCwd !== record.finalCwd || receipt.commonDir !== expected.commonDir || canonicalJson(receipt.target) !== canonicalJson(record.target)) fail();
        if (!record.placement) record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, placement: receipt, effects: [...current.effects, { kind: 'destination', receiptHash: sha256Hex(canonicalJson(receipt)), at: this.now() }], revision: current.revision + 1, updatedAt: this.now() }));
      }
      const binding = reservationMapping(record); const normalized = await normalizeMapping(binding.mapping);
      if (normalized.localPrefix !== record.mapping.localRoot || normalized.revision !== record.mapping.revision || await remoteToLocal(binding, reviewed.header.cwd!) !== record.finalCwd || !(await validateImportedCwds(binding, reviewed.events.flatMap(event => event.type === 'working-directory/change' ? [event.data.cwd] : []))).ok) fail();
      if (record.mode === 'local' && this.port() && await this.port()!.classifyPath(record.finalCwd, plan.sessionId, signal) !== 'local') fail();
      const initial = await materializeInitial({ record, header, claim, registration: this.registration!, guard: this.deps.guard!, persistence: this.deps.ctx.sessionPersistence, signal, now: this.now, retained: true });
      record = initial.record;
      await this.ensureLocalRecord(record, reviewed, true);
      await this.registration!.withRetainedWrite(claim, importFence(record), signal, () => runtime.importer.importPrepared(plan.sessionId, reviewed, binding, header, { signal, allowDisabledRead: true }));
      const localized = await localizeImportedEvents(reviewed.events as never, binding);
      const historyArtifact = { headerHash: record.localHeaderHash, inheritedEventCount: record.target.inheritedEventCount, prefixCount: reviewed.events.length, prefixHash: payloadHash(localized.events) };
      await this.registration!.proveRetainedReadable(claim, importFence(record), historyArtifact);
      record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, historyArtifact,
        effects: current.effects.some(effect => effect.kind === 'history') ? current.effects : [...current.effects, { kind: 'history', receiptHash: current.target.chainHash, at: this.now() }],
        revision: current.revision + 1, updatedAt: this.now() }));
      this.reasons.set(record.operationId, 'cancelled-retained-history-repaired'); return this.view(record);
    }
    if (record.mode === 'worktree' && !record.placement) {
      const port = this.port(); if (!port || !plan.worktreePlanJson) fail();
      const worktree = JSON.parse(plan.worktreePlanJson) as WorktreeImportPlan;
      const destination = reviewedDestination(plan); if (destination.kind !== 'worktree') fail();
      const actor = this.actor(destination.permissionActorId, plan.sessionId, origin, signal);
      const choices = await port.bases(destination.projectId, destination.folderId, actor);
      const selection = gitSelectionKey({ schemaVersion: sourceGit(remote)?.v ?? 1, repositoryIdentity: choices.commonDir, objectFormat: choices.objectFormat, headOid: choices.head, selectedOid: destination.base.oid, ...(destination.base.kind === 'local-branch' ? { resolvedRef: destination.base.name } : {}) });
      if (selection !== plan.gitSelectionKey) fail();
      record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, phase: 'destination-preparing', revision: current.revision + 1, updatedAt: this.now() }));
      const receipt = await port.provision(worktree, actor); this.check(signal);
      record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, phase: 'destination-prepared', placement: receipt, effects: [...current.effects, { kind: 'destination', receiptHash: sha256Hex(canonicalJson(receipt)), at: this.now() }], revision: current.revision + 1, updatedAt: this.now() }));
    }
    const binding = reservationMapping(record);
    const normalized = await normalizeMapping(binding.mapping);
    if (normalized.localPrefix !== record.mapping.localRoot || normalized.revision !== record.mapping.revision || await remoteToLocal(binding, reviewed.header.cwd!) !== record.finalCwd || !(await validateImportedCwds(binding, reviewed.events.flatMap(event => event.type === 'working-directory/change' ? [event.data.cwd] : []))).ok) fail();
    if (record.mode === 'local') {
      if (this.port() && await this.port()!.classifyPath(record.finalCwd, plan.sessionId, signal) !== 'local') fail();
      if (record.phase === 'reserved') record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, phase: 'destination-prepared', revision: current.revision + 1, updatedAt: this.now() }));
    }
    if (!record.artifact) await this.assertLocalReview(plan, signal);
    const initial = await materializeInitial({ record, header, claim, registration: this.registration!, guard: this.deps.guard!, persistence: this.deps.ctx.sessionPersistence, signal, now: this.now });
    record = initial.record;
    await this.ensureLocalRecord(record, reviewed, false); this.check(signal);
    record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, phase: 'history-importing', revision: current.revision + 1, updatedAt: this.now() }));
    const imported = await this.registration!.withWrite(claim, importFence(record), signal, () => runtime.importer.importPrepared(plan.sessionId, reviewed, binding, header, { signal }));
    this.check(signal);
    const localized = await localizeImportedEvents(reviewed.events as never, binding);
    const historyArtifact = { headerHash: record.localHeaderHash, inheritedEventCount: record.target.inheritedEventCount, prefixCount: reviewed.events.length, prefixHash: payloadHash(localized.events) };
    const proof = await this.registration!.proveReadable(claim, importFence(record), historyArtifact);
    record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, phase: 'history-verified', historyArtifact, effects: current.effects.some(effect => effect.kind === 'history') ? current.effects : [...current.effects, { kind: 'history', receiptHash: record!.target.chainHash, at: this.now() }], revision: current.revision + 1, updatedAt: this.now() }));
    const currentRemote = await this.remote(plan.sessionId, record.target.generation, runtime, signal); reviewedRemote(currentRemote, record); this.check(signal);
    if (record.mode === 'worktree') {
      const port = this.port(); if (!port || !record.placement) fail();
      // The placement owner creates/exposes the real native Workspace only now,
      // after the complete history proof. Provisioning never manufactured one.
      const receipt = await this.registration!.withWrite(claim, importFence(record), signal, () => port.bindImported(record!.placement!, proof, signal));
      const workspace = this.workspace()!.get(WorkspaceId(receipt.workspaceId));
      if (!workspace || workspace.path !== record.finalCwd || !workspace.sessionIds.includes(SessionId(plan.sessionId))) fail();
      record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, phase: 'destination-bound', placement: receipt, binding: { workspaceId: receipt.workspaceId, projectId: receipt.projectId, folderId: receipt.folderId, placementRevision: receipt.revision }, revision: current.revision + 1, updatedAt: this.now() }));
      const status = await this.registration!.withWrite(claim, importFence(record), signal, async () => { await port.acknowledgeReady(receipt, proof, signal); return port.inspect(record!.operationId, signal); }); if (status?.phase !== 'ready' || status.receipt?.worktreeId !== receipt.worktreeId) fail();
    } else {
      const workspace = await this.registration!.withWrite(claim, importFence(record), signal, async () => {
        const workspace = await this.workspace()!.create(record!.finalCwd);
        await workspace.attachSession(SessionId(plan.sessionId));
        if (workspace.path !== record!.finalCwd || !this.workspace()!.get(workspace.id)?.sessionIds.includes(SessionId(plan.sessionId))) fail();
        if (record!.sourceFolder) {
          const port = this.port(); if (!port) fail();
          await port.bindLocalImported({ operationId: record!.operationId, sessionId: plan.sessionId, intentId: record!.intentId, projectId: record!.sourceFolder.projectId, folderId: record!.sourceFolder.folderId, cwd: record!.finalCwd, workspaceId: workspace.id }, proof, signal);
        }
        return workspace;
      });
      record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, phase: 'destination-bound', binding: { workspaceId: workspace.id, ...(record!.sourceFolder ? { projectId: record!.sourceFolder.projectId, folderId: record!.sourceFolder.folderId } : {}) }, revision: current.revision + 1, updatedAt: this.now() }));
    }
    reviewedRemote(await this.remote(plan.sessionId, record.target.generation, runtime, signal), record); this.check(signal);
    record = await this.deps.guard!.journal.update(claim, importFence(record), current => ({ ...current, phase: 'ready', effects: current.effects.some(effect => effect.kind === 'binding') ? current.effects : [...current.effects, { kind: 'binding', receiptHash: sha256Hex(canonicalJson(current.binding)), at: this.now() }], revision: current.revision + 1, updatedAt: this.now() }));
    await this.deps.local.transactSession(plan.sessionId, current => {
      this.check(signal); if (!current || current.destination?.operationId !== record!.operationId || !current.enabled || current.detached) fail();
      return { ...current, destination: destinationBinding(record!, 'ready'), ...(currentRemote.events.length > reviewed.events.length ? { catchUpPending: true } : {}) };
    });
    if (imported.status !== 'complete') this.reasons.set(record.operationId, 'history-degraded-acknowledgement-required');
    return this.view(record);
  }
  private async ensureLocalRecord(record: ImportReservation, remote: RemoteSession, retained: boolean): Promise<void> {
    if (!record.artifact) fail();
    await this.deps.local.transactSession(record.target.sessionId, current => {
      if (current) {
        if (current.destination?.operationId !== record.operationId || current.destination.scope !== record.target.scope) fail();
        if (!retained && (!current.enabled || current.detached)) fail();
        if (retained) return { ...current, enabled: false, detached: true, state: 'disabled', status: 'detached',
          destination: { ...current.destination, phase: 'cancelled', journalRevision: record.revision },
          resurrectionCancellationId: current.resurrectionCancellationId ?? record.cancellationIntentId };
        return current;
      }
      return { sessionId: record.target.sessionId, enabled: !retained, detached: retained, state: retained ? 'disabled' : 'active', generation: record.target.generation, writerEpoch: remote.manifest.entity.writerEpoch,
        status: retained ? 'detached' : 'importing', imported: true, importState: 'planned', importExpectedCount: record.target.eventCount, importExpectedChainHash: record.target.chainHash,
        importMappingId: record.mapping.id, importMappingRevision: record.mapping.revision, canonicalCwd: remote.header.cwd, localCwd: record.finalCwd,
        ...(remote.header.parentSession ? { parentSession: remote.header.parentSession } : {}), delegationDepth: remote.header.delegationDepth ?? 0, subagent: false,
        remapped: remote.header.cwd !== record.finalCwd, needsFolder: false, unmappablePaths: [], mappingUnstable: false, degradedAttachments: [], degradedAcknowledged: false, weArchived: false,
        ...(retained && record.cancellationIntentId ? { resurrectionCancellationId: record.cancellationIntentId } : {}), destination: destinationBinding(record, retained ? 'cancelled' : 'pending') };
    });
  }
  async catchUp(sessionId: string, remote: RemoteSession, options: Parameters<Importer['catchUp']>[2]): Promise<ImportResult> {
    const record = await this.deps.guard?.journal.read(sessionId); if (!record || record.phase !== 'ready' || record.cancelledAt !== undefined) fail();
    const runtime = await this.deps.runtime(options.signal); if (runtime.scope !== record.target.scope) fail();
    const active = this.running.get(sessionId); if (active?.claim) fail();
    const claim = await this.deps.guard!.claims.acquire(sessionId, record.operationId);
    if (active) active.claim = claim;
    try { return await this.registration!.withWrite(claim, importFence(record), options.signal, () => runtime.importer.catchUp(sessionId, remote, options)); }
    finally { await claim.release(); if (active?.claim === claim) active.claim = undefined; }
  }
  async cancelSession(sessionId: string, operationId?: string): Promise<CloudImportView> {
    if (!this.deps.guard || !this.registration || !this.plans) throw new CloudControlError('SETUP_NEEDED');
    const active = this.running.get(sessionId); active?.controller.abort();
    let record = await this.deps.guard.journal.read(sessionId);
    const id = operationId ?? record?.operationId ?? [...this.reviewed].find(([, sid]) => sid === sessionId)?.[0]; if (!id) fail();
    if (record && record.operationId !== id) fail();
    (this.deps.ctx.get('agents') as AgentRegistry | undefined)?.get(SessionId(sessionId))?.cancel({ kind: 'user' }, { keepInbox: true });
    const reviewed = await this.plans.read(id); if (reviewed && reviewed.sessionId !== sessionId) fail();
    let claim = active?.claim; let owned = false;
    if (!claim) {
      try { claim = await this.deps.guard.claims.acquire(sessionId, id); owned = true; }
      catch (error) {
        if (!active || !(error instanceof ImportClaimError) || error.code !== 'BUSY') throw error;
        // A Continue cold-catch-up may be between claiming and publishing its
        // in-process handle. Its abort is already latched; drain before release.
        await active.promise.catch(() => undefined);
        claim = await this.deps.guard.claims.acquire(sessionId, id); owned = true;
      }
    }
    try {
      try { await claim.assertOwned(); }
      catch (error) {
        if (owned || !active) throw error;
        await active.promise.catch(() => undefined); claim = await this.deps.guard.claims.acquire(sessionId, id); owned = true;
      }
      await claim.waitForWrites();
      record = await this.deps.guard.journal.read(sessionId);
      if (record && record.operationId !== id) fail();
      if (record) {
        record = await this.deps.guard.journal.cancel(claim, importFence(record), { intentId: randomUUID(), intentRevision: record.intentRevision + 1 }, this.now());
        const port = this.port();
        if (record.mode === 'worktree' && port && typeof port.suspend === 'function') {
          try { await port.suspend(record.operationId, sessionId, record.intentId, this.shutdown.signal); }
          catch { this.reasons.set(id, 'cancelled-placement-veto-pending'); } // Independent durable journal already vetoes every late effect.
        }
      }
      await this.plans.cancel(id, this.now());
      const local = this.deps.local.getSession(sessionId);
      if (local?.destination?.operationId === id) await this.deps.local.transactSession(sessionId, current => current?.destination?.operationId === id ? { ...current, enabled: false, detached: true, state: 'disabled', status: 'detached', destination: { ...current.destination, phase: 'cancelled', journalRevision: record?.revision ?? current.destination.journalRevision }, resurrectionCancellationId: record?.cancellationIntentId } : undefined);
      if (active && this.running.get(sessionId) === active) {
        this.reasons.set(id, 'cancelled-draining-effects');
        if (record) return this.view(record);
        const plan = await this.plans.read(id); if (!plan) fail();
        return { version: 2, kind: 'import-operation', operationId: id, sessionId, generation: plan.target.generation, revision: plan.revision, phase: 'cancelled', destination: plan.reservation.mode, reason: 'cancelled-draining-effects', continuable: false, pendingInput: false };
      }
      if (!owned) { claim = await this.deps.guard.claims.acquire(sessionId, id); owned = true; }
      record = await this.deps.guard.journal.read(sessionId);
      if (record && !this.deps.local.getSession(sessionId)) {
        try { await this.registration.releaseCancelledBeforeEffects(claim, importFence(record)); record = undefined; } catch { /* Committed or uncertain effects stay reserved. */ }
      }
      if (record) return this.view(record);
      const plan = await this.plans.read(id); if (!plan) fail();
      return { version: 2, kind: 'import-operation', operationId: id, sessionId, generation: plan.target.generation, revision: plan.revision, phase: 'cancelled', destination: plan.reservation.mode, continuable: false, pendingInput: false };
    } finally { if (owned) await claim.release(); }
  }
  async legacy(sessionId: string): Promise<never> { if (await this.reserved(sessionId)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'This session has a destination operation; use its explicit Resume/Repair control.'); throw new AzureSyncError('NOT_FOUND', 'No destination operation exists.'); }
  async invalidate(): Promise<void> {
    for (const active of this.running.values()) active.controller.abort();
    for (const [id] of this.reviewed) await this.plans?.cancel(id, this.now()).catch(() => undefined);
  }
  private async continue(record: ImportReservation, acknowledgePendingInput: boolean, signal: AbortSignal): Promise<CloudImportView> {
    if (!await this.profile() || record.phase !== 'ready' || record.cancelledAt !== undefined || pending(this.deps.local.getSession(record.target.sessionId)) || !await this.codeConsentReady(record)) fail();
    const runtime = await this.deps.runtime(signal); if (runtime.scope !== record.target.scope) fail();
    let claim: SidClaim | undefined; let activatedGrant: string | undefined;
    const active = this.running.get(record.target.sessionId);
    try {
      let snapshot = await this.readSnapshot(record.target.sessionId);
      if (this.pendingInput(snapshot) && !acknowledgePendingInput) throw new CloudControlError('CONFIRM_REQUIRED');
      // This first proof may cold-catch-up using its OWN exact-SID scope. Do not
      // hold a second claim around it or it would deadlock its public importer.
      const ownership = await runtime.service.ensureOwnership(record.target.sessionId, signal);
      if (!ownership.owned) fail(); this.check(signal);
      claim = await this.deps.guard!.claims.acquire(record.target.sessionId, record.operationId);
      if (active) active.claim = claim;
      record = (await this.deps.guard!.journal.read(record.target.sessionId))!;
      if (record.phase !== 'ready' || record.cancelledAt !== undefined || !await this.capabilityReady(record)) fail();
      if (record.mode === 'worktree') {
        const status = await this.port()?.inspect(record.operationId, signal);
        const receipt = status?.receipt, placement = record.placement;
        if (status?.phase !== 'ready' || !receipt || !placement || receipt.worktreeId !== placement.worktreeId || receipt.commonDir !== placement.commonDir) fail();
      }
      snapshot = await this.readSnapshot(record.target.sessionId);
      if (this.pendingInput(snapshot) && !acknowledgePendingInput) throw new CloudControlError('CONFIRM_REQUIRED');
      const proof = await this.registration!.proveReadable(claim, importFence(record), { headerHash: record.localHeaderHash, inheritedEventCount: record.target.inheritedEventCount, prefixCount: record.target.eventCount, prefixHash: payloadHash(snapshot.events.slice(0, record.target.eventCount)) });
      record = await this.registration!.grantContinue(claim, importFence(record), proof);
      activatedGrant = record.continueReceipt?.grantId;
      const controller = this.deps.ctx.get('sessionController') as SessionController | undefined;
      if (!controller) throw new CloudControlError('SETUP_NEEDED');
      const resolved = await controller.resolveAgent(SessionId(record.target.sessionId)); if (!('agent' in resolved)) fail();
      const agent = resolved.agent;
      // Resolve current Native runtime/model and effective local directory while
      // the restored inbox is still idle. Never copy the provisioning actor's
      // options or synthesize a wake to discover missing local readiness.
      const llm = this.deps.ctx.get('llm') as LlmRuntime | undefined;
      if (!llm || !agent.options.provider || !agent.options.model) throw new CloudControlError('SETUP_NEEDED');
      await llm.resolveModelInfo(agent.options.provider, agent.options.model, signal);
      const workingDirectory = this.deps.ctx.get('workingDirectory') as WorkingDirectoryService | undefined;
      if (workingDirectory) await workingDirectory.ensure(agent, signal);
      this.check(signal);
      if (!(await runtime.service.ensureOwnership(record.target.sessionId, signal)).owned) fail();
      if (acknowledgePendingInput && record.continueReceipt && !this.woken.has(record.continueReceipt.grantId)) {
        await wakeConfirmedPending(agent, () => this.deps.ctx.sessions.flush(agent.session).then(() => undefined));
        this.woken.add(record.continueReceipt.grantId);
      }
      return this.view(record);
    } catch (error) {
      if (activatedGrant) this.deps.guard!.revokeContinueGrant(activatedGrant);
      throw error;
    } finally {
      await claim?.release(); if (active && active.claim === claim) active.claim = undefined;
    }
  }
  async close(timeoutMs = 5_000): Promise<void> {
    this.shutdown.abort(); this.registration?.unregister();
    for (const active of this.running.values()) active.controller.abort();
    const drained = Promise.allSettled([...this.running.values()].map(active => active.promise));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([drained, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(1, timeoutMs)); })]); }
    finally { if (timer) clearTimeout(timer); }
    // Ignored late IO remains owned by its original promise/claim until it
    // actually settles. Teardown never steals/releases uncertain SID authority.
  }
}

/** Public maintenance claim, exact original last item and queue order; never a synthetic prompt. */
export async function wakeConfirmedPending(agent: Agent, flush: () => Promise<void>): Promise<void> {
  const target = agent.inbox.nextTurn.length ? 'next-turn' : 'next-step';
  const original = [...(target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep)];
  const message = original.at(-1); if (!message) return;
  await agent.runMaintenance(async () => {
    if (!agent.inbox.remove(message.id)) fail();
    agent.send(message, target, true);
    const actual = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep;
    if (canonicalJson(actual) !== canonicalJson(original)) fail();
    await flush();
  });
}
