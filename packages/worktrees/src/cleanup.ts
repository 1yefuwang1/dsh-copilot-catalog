import { randomUUID, createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-workspace';
import type { SessionObservation } from '@deepseek-ai/dsh-session-query';
import { GitOperations } from './git.js';
import { SessionBootstrap, type ColdFactoryHold } from './sessions.js';
import { cleanupSummary, type CleanupReceipt, type CleanupStore, type ReopenReceipt } from './cleanup-store.js';
import { abortIfRequested, failureOf, WorktreeError } from './errors.js';
import { capability, createExecutor, createMaintenanceExecutor, planBlocksMutation, requireFullAccess, required } from './runtime.js';
import { hashValue, parseRequest } from './schema.js';
import type { WorktreeStore } from './store.js';
import type { ProjectController } from './projects.js';
import type { RecoveryInvocation, WorktreeController } from './service.js';
import type { LocalBranches, WorktreeCleanupSummary, WorktreeConfig, WorktreeRecord, WorktreeRequest, WorktreeReopenInfo, WorktreeReopenResult } from './types.js';

const DAY = 86400000;
export const CLEANUP_INTERVAL_MS = 3600000;
type CleanupGit = Pick<GitOperations, 'discover' | 'localBranches' | 'inspectRemoval' | 'preserveRemovalHead' | 'removeManagedCheckout' | 'removalState' | 'switchLocalBranch'>;
interface Agents { get(id: string): Agent | undefined; list(): Agent[] }
interface Query { listSessions(signal?: AbortSignal): Promise<{ header: SessionHeader }[]>; observeSession(id: SessionId, options: { signal?: AbortSignal; projectionMode: 'all' }): Promise<SessionObservation> }
interface Persistence { stat(id: SessionId, options?: { signal?: AbortSignal }): Promise<{ header: SessionHeader; revision: unknown } | undefined>; open(id: SessionId, access: 'write', options?: { signal?: AbortSignal }): Promise<SessionHandle> }
interface Jobs { list(id?: Agent['id']): { status: string }[] }
interface Schedules { catalog(): Promise<{ sessionId: string; status: string }[]> }
export interface CleanupSettings { enabled: boolean; days: number }
export interface CleanupDependencies {
  settings?: () => CleanupSettings;
  executionContext?: () => Context;
  now?: () => number;
  git?: (record: WorktreeRecord, guard: () => void, signal: AbortSignal) => CleanupGit;
  bootstrap?: Pick<SessionBootstrap, 'coldSource' | 'stageColdContinuation' | 'close'>;
  projects?: Pick<ProjectController, 'selectionForWorktree' | 'folderForPath' | 'recordThread'>;
}
function contains(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
function validTime(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
async function canonicalFuture(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path); if (parent === path) throw error;
    return resolve(await canonicalFuture(parent), basename(path));
  }
}
interface SettingsEvents { on(event: 'settings/document-updated', callback: () => void): () => void }
const copy = <T>(value: T): T => structuredClone(value);

/** Derive ownership from the exact creation layout, never the current root setting. */
export function historicalWorktreeRoot(record: WorktreeRecord): string {
  const checkout = resolve(record.checkoutRoot), parent = dirname(checkout), repository = dirname(parent), root = dirname(repository);
  const key = createHash('sha256').update(record.commonDir).digest('hex').slice(0, 24);
  if (checkout !== record.checkoutRoot || basename(parent) !== record.id || basename(repository) !== key || basename(checkout) !== `worktree-${record.id}` || root === dirname(root)) {
    throw new WorktreeError('UNSAFE_MANAGED_LAYOUT', 'The recorded checkout is not in the verified managed creation layout; automatic cleanup is deferred.');
  }
  return root;
}

/** Configured housekeeping over owned checkouts; never activates a source Agent. */
export class WorktreeCleanup {
  private readonly shutdown = new AbortController();
  private readonly bootstrap: NonNullable<CleanupDependencies['bootstrap']>;
  private readonly stops: Array<() => void> = [];
  private readonly flights = new Set<Promise<unknown>>();
  private readonly collecting = new Set<string>();
  private readonly pendingTargets = new Set<string>();
  private readonly targetHolds = new Map<string, { agent: Agent; release: () => void; task: Promise<void>; signal?: AbortSignal }>();
  private readonly listeners = new Set<() => void>();
  private readonly activity = new Map<string, { revision: unknown; identity: unknown; at: number }>();
  private readonly branches = new Map<string, { sourceId: string; value: LocalBranches }>();
  private activeSweep: Promise<void> | undefined;
  private revision = 0;
  private scheduled = false;
  private closed = false;
  constructor(private readonly owner: Context, private readonly config: WorktreeConfig, private readonly worktrees: WorktreeStore, private readonly store: CleanupStore, private readonly controller: Pick<WorktreeController, 'withRepositoryMaintenance' | 'hasPendingEffects' | 'withLocalClaims'>, private readonly deps: CleanupDependencies = {}) {
    this.bootstrap = deps.bootstrap ?? new SessionBootstrap(owner);
    for (const [, row] of store.reopens.entries()) if (row.phase !== 'ready') this.pendingTargets.add(row.sessionId);
  }
  private now(): number { const value = (this.deps.now ?? Date.now)(); if (!validTime(value)) throw new WorktreeError('INVALID_CLOCK', 'Cleanup requires a valid timestamp.'); return value; }
  private settings(): CleanupSettings {
    const result = this.deps.settings?.() ?? { enabled: this.config.cleanupEnabled ?? true, days: this.config.cleanupInactivityDays ?? 10 };
    if (typeof result.enabled !== 'boolean' || !Number.isSafeInteger(result.days) || result.days < 1 || result.days > 3650) throw new WorktreeError('INVALID_CLEANUP_CONFIG', 'Cleanup needs an enable flag and 1–3650 whole inactivity days.');
    return result;
  }
  summary(id: string): WorktreeCleanupSummary | undefined { const row = this.store.cleanup.get(id); return row === undefined ? undefined : cleanupSummary(row); }
  recoveryFor(sessionId: string): { cleanup: WorktreeCleanupSummary; oldCheckout: string } | undefined {
    const reopen = [...this.store.reopens.entries()].map(([, row]) => row).find(row => row.sessionId === sessionId);
    const cleanup = reopen === undefined ? undefined : this.store.cleanup.get(reopen.worktreeId);
    return cleanup?.phase === 'collected' ? { cleanup: cleanupSummary(cleanup), oldCheckout: cleanup.checkoutRoot } : undefined;
  }
  private changed(): void { this.revision++; for (const listener of [...this.listeners]) listener(); }
  private async put(row: CleanupReceipt): Promise<void> {
    const old = this.store.cleanup.get(row.id);
    if (old !== undefined && hashValue({ ...old, updatedAt: 0 }) === hashValue({ ...row, updatedAt: 0 })) return;
    await this.store.cleanup.put(row.id, copy(row)); this.changed();
  }
  private async putReopen(row: ReopenReceipt, onCommitted?: () => void): Promise<void> { await this.store.reopens.put(row.id, copy(row)); onCommitted?.(); this.changed(); }
  private fence(cwd: string | undefined, sessionId?: string): boolean {
    const path = cwd === undefined ? undefined : resolve(cwd);
    for (const [id, row] of this.store.cleanup.entries()) if ((this.collecting.has(id) || row.phase === 'removing' || row.phase === 'collected' || row.phase === 'recovery-required')
      && ((path !== undefined && contains(row.checkoutRoot, path)) || (sessionId !== undefined && row.sessionIds.includes(sessionId)))) return true;
    return false;
  }
  private async canonicalFence(agent: Agent): Promise<boolean> {
    const cwd = agent.session.header.cwd;
    if (this.fence(cwd, agent.id)) return true;
    if (cwd === undefined || ![...this.store.cleanup.entries()].some(([id, row]) => this.collecting.has(id) || ['removing', 'collected', 'recovery-required'].includes(row.phase))) return false;
    const canonical = await realpath(cwd).catch(() => { throw new WorktreeError('CWD_UNKNOWN', 'The runtime directory cannot be verified against reclaimed checkouts.'); });
    return this.fence(canonical, agent.id);
  }
  /** A real pre-turn maintenance hold parks new input without creating turns or discarding it. */
  private holdInput(agent: Agent, factory?: ColdFactoryHold): void {
    const existing = this.targetHolds.get(agent.id);
    if (existing?.agent === agent && !existing.signal?.aborted) return;
    if (existing !== undefined) throw new WorktreeError('TARGET_BUSY', 'The pending continuation runtime changed or its input hold was cancelled.');
    if (factory !== undefined) {
      if (factory.signal.aborted) throw new WorktreeError('TARGET_BUSY', 'The continuation factory input hold was cancelled.');
      const held = { agent, ...factory };
      this.targetHolds.set(agent.id, held);
      void held.task.finally(() => { if (this.targetHolds.get(agent.id) === held) this.targetHolds.delete(agent.id); }).catch(() => undefined);
      return;
    }
    let release!: () => void;
    const ready = new Promise<void>(fulfill => { release = fulfill; });
    const held = { agent, release, task: Promise.resolve(), signal: undefined as AbortSignal | undefined };
    this.targetHolds.set(agent.id, held);
    try {
      held.task = agent.runMaintenance(async signal => {
        held.signal = signal;
        await new Promise<void>((fulfill, reject) => {
          const abort = () => { signal.removeEventListener('abort', abort); reject(new WorktreeError('TARGET_HOLD_CANCELLED', 'The continuation input hold was cancelled.')); };
          signal.addEventListener('abort', abort, { once: true });
          void ready.then(() => { signal.removeEventListener('abort', abort); fulfill(); });
          if (signal.aborted) abort();
        });
      });
      void held.task.finally(() => { if (this.targetHolds.get(agent.id) === held) this.targetHolds.delete(agent.id); }).catch(() => undefined);
    } catch {
      this.targetHolds.delete(agent.id); throw new WorktreeError('TARGET_BUSY', 'A pre-turn input hold could not be acquired for this continuation.');
    }
  }
  start(initialSweep = true): void {
    this.stops.push(this.owner.on('agent/created', async ({ agent, signal }) => {
      if (await this.canonicalFence(agent)) throw new WorktreeError('WORKTREE_RECLAIMED', 'This worktree is being reclaimed or was garbage-collected. Open its history and choose a Local branch to continue.');
      if (this.pendingTargets.has(agent.id)) {
        if (this.closed) throw new WorktreeError('CLOSED', 'The pending continuation is closing; retry after reload.');
        const existing = this.targetHolds.get(agent.id);
        if (existing?.agent === agent && !existing.signal?.aborted) return undefined;
        // A native resume can enter a previously journaled target too. Gate its
        // serial publication under the existing initialization claim, not nested
        // maintenance. Subsequent native controls resolve the entered real Agent.
        if (signal === undefined) throw new WorktreeError('MISSING_FACTORY_CLAIM', 'Pending recovery requires an abortable factory publication boundary.');
        const lifetime = AbortSignal.any([signal, this.shutdown.signal]);
        let release!: () => void;
        const ready = new Promise<void>(fulfill => { release = fulfill; });
        const task = new Promise<void>((fulfill, reject) => {
          const abort = () => { lifetime.removeEventListener('abort', abort); reject(new WorktreeError('TARGET_HOLD_CANCELLED', 'The continuation publication hold was cancelled.')); };
          lifetime.addEventListener('abort', abort, { once: true });
          void ready.then(() => { lifetime.removeEventListener('abort', abort); fulfill(); });
          if (lifetime.aborted) abort();
        });
        // A rejected gate makes the native factory roll back, but the gate's
        // rejection itself is not its writer/scope drain. Observe the exact
        // public disposal edge outside the awaited creation listener. Root-owned
        // observation survives this plugin's unload until close() drains it.
        let stopDisposed!: () => void;
        const disposed = new Promise<void>(fulfill => {
          stopDisposed = this.owner.root.on('agent/disposed', ({ agent: removed }) => {
            if (removed === agent) fulfill();
          });
          if (required<Agents>(this.owner, 'agents').get(agent.id) !== agent) fulfill();
        });
        this.stops.push(stopDisposed);
        const drained = task.catch(async error => { await disposed; throw error; });
        void drained.finally(stopDisposed).catch(() => undefined);
        this.holdInput(agent, { signal: lifetime, release, task: drained });
        await task;
      }
      return undefined;
    }));
    this.stops.push(this.owner.on('agent/pre-step', async ({ agent }, next) => {
      try { if (this.pendingTargets.has(agent.id) || await this.canonicalFence(agent)) return { kind: 'reject' as const }; }
      catch { return { kind: 'reject' as const }; }
      return next();
    }));
    this.stops.push(this.owner.on('agent/disposed', () => this.retry()));
    this.stops.push(this.owner.on('api-session/activity', id => { this.activity.delete(id); }));
    let settings = hashValue(this.settings());
    this.stops.push((this.owner as unknown as SettingsEvents).on('settings/document-updated', () => {
      try { const next = hashValue(this.settings()); if (next !== settings) { settings = next; this.retry(); } } catch { /* A bad getter never authorizes deletion. */ }
    }));
    const interval = setInterval(() => this.retry(), CLEANUP_INTERVAL_MS); interval.unref();
    this.stops.push(() => clearInterval(interval));
    if (initialSweep) this.retry();
  }
  private retry(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(() => { this.scheduled = false; if (!this.closed) void this.sweep().catch(() => undefined); });
  }
  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.activeSweep !== undefined) return this.activeSweep;
    const task = this.sweepNow(); this.activeSweep = task; this.flights.add(task);
    void task.finally(() => { if (this.activeSweep === task) this.activeSweep = undefined; this.flights.delete(task); }).catch(() => undefined);
    return task;
  }
  private async sweepNow(): Promise<void> {
    // No source Agents are resumed by listing the durable corpus.
    const rows = [...this.worktrees.worktrees.entries()].map(([, row]) => copy(row));
    const enabled = this.settings().enabled;
    for (const record of rows) {
      if (this.closed) break;
      const previous = this.store.cleanup.get(record.id);
      if (previous?.phase === 'collected') { await this.markMissing(record); continue; }
      if (!enabled && previous?.phase !== 'removing' && previous?.phase !== 'recovery-required') continue;
      if (record.state !== 'ready' && previous?.phase !== 'removing' && previous?.phase !== 'recovery-required') continue;
      await this.controller.withRepositoryMaintenance(record.commonDir, this.shutdown.signal, signal => this.collect(record.id, signal)).catch(() => undefined);
    }
  }
  private record(id: string): WorktreeRecord { const row = this.worktrees.worktrees.get(id); if (row === undefined) throw new WorktreeError('NOT_FOUND', 'The managed worktree no longer has a record.'); return copy(row); }
  private guard(signal: AbortSignal): void { abortIfRequested(signal); if (this.closed) throw new WorktreeError('CLOSED', 'The cleanup service is closing.'); }
  private noLive(record: WorktreeRecord): void {
    for (const agent of required<Agents>(this.owner, 'agents').list()) {
      const cwd = agent.session.header.cwd; if (cwd === undefined) continue;
      let canonical: string;
      try { canonical = realpathSync(cwd); }
      catch { throw new WorktreeError('BUSY_UNKNOWN', 'A loaded runtime directory cannot be verified safely.'); }
      if (contains(record.checkoutRoot, resolve(cwd)) || contains(record.checkoutRoot, canonical)) throw new WorktreeError('LOADED_AGENT', 'A conversation runtime still uses this checkout, even if idle. Cleanup retries after it unloads, often at a server restart.');
    }
  }
  private async resources(record: WorktreeRecord, ids: readonly string[], signal: AbortSignal): Promise<void> {
    this.guard(signal); this.noLive(record);
    // Account for canonical aliases too; uncertainty is not a cold-checkout proof.
    for (const agent of required<Agents>(this.owner, 'agents').list()) {
      const cwd = agent.session.header.cwd; if (cwd === undefined) continue;
      const canonical = await realpath(cwd).catch(() => { throw new WorktreeError('BUSY_UNKNOWN', 'A loaded runtime directory cannot be inspected safely.'); });
      if (contains(record.checkoutRoot, canonical)) throw new WorktreeError('LOADED_AGENT', 'A loaded conversation runtime still uses this checkout.');
    }
    const jobs = capability<Jobs>(this.owner, 'jobs');
    if (jobs !== undefined) {
      const owned = [...new Set([...ids, ...required<Agents>(this.owner, 'agents').list().map(agent => agent.id)])];
      if ([...jobs.list(), ...owned.flatMap(id => jobs.list(SessionId(id)))].some(job => ['running', 'stopping'].includes(job.status))) throw new WorktreeError('ACTIVE_JOB', 'Background jobs are running or stopping; their checkout use cannot be ruled out.');
    }
    const schedules = capability<Schedules>(this.owner, 'schedule');
    if (schedules !== undefined && (await schedules.catalog()).some(task => ids.includes(task.sessionId) && task.status === 'active')) throw new WorktreeError('ACTIVE_SCHEDULE', 'An active reminder can wake a thread in this checkout. Remove it before cleanup.');
    for (const id of ids) {
      const terminal = capability<{ list(id: Agent['id']): { state: string }[] }>(this.owner, 'terminalController');
      if (terminal?.list(SessionId(id)).some(item => item.state === 'running')) throw new WorktreeError('ACTIVE_TERMINAL', 'A user terminal still uses this checkout.');
      const activity = await this.owner.waterfall('workspace/session-activity', { sessionId: SessionId(id) }, async () => []);
      if (activity.length > 0) throw new WorktreeError('ACTIVE_WORK', 'A thread still owns active work.');
    }
    if (this.controller.hasPendingEffects(record)) throw new WorktreeError('PENDING_OPERATION', 'An unfinished checkout, handoff, or naming operation still references this worktree.');
    this.guard(signal); this.noLive(record);
  }
  private async associated(record: WorktreeRecord, signal: AbortSignal): Promise<SessionHeader[]> {
    const rows = await required<Query>(this.owner, 'sessionQuery').listSessions(signal);
    const headers: SessionHeader[] = [];
    for (const { header } of rows) {
      if (header.cwd === undefined) continue;
      const path = resolve(header.cwd);
      // Canonical ancestors keep aliases observable even if an unsaved project subdirectory disappeared.
      const canonical = contains(record.checkoutRoot, path) ? path : await canonicalFuture(path);
      if (contains(record.checkoutRoot, canonical)) headers.push(copy(header));
    }
    for (const id of record.sessionIds) {
      const header = headers.find(row => row.id === id) ?? rows.find(row => row.header.id === id)?.header;
      // Local handoff descendants listed on a legacy record are not backing it.
      if (header === undefined) throw new WorktreeError('ACTIVITY_UNKNOWN', 'A recorded conversation cannot be observed safely.');
    }
    return headers.sort((a, b) => a.id.localeCompare(b.id));
  }
  private async lastActivity(record: WorktreeRecord, headers: readonly SessionHeader[], signal: AbortSignal, fresh = false): Promise<number> {
    const persistence = required<Persistence>(this.owner, 'sessionPersistence');
    const query = required<Query>(this.owner, 'sessionQuery');
    let at = record.createdAt;
    for (const header of headers) {
      const stat = await persistence.stat(header.id, { signal });
      if (stat === undefined) throw new WorktreeError('ACTIVITY_UNKNOWN', 'A backing session is not durably observable.');
      const cache = this.activity.get(header.id);
      let value: number;
      if (!fresh && cache !== undefined && cache.revision === stat.revision && cache.identity === persistence) value = cache.at;
      else {
        const observation = await query.observeSession(header.id, { signal, projectionMode: 'all' });
        try {
          if (observation.header.cwd !== header.cwd) throw new WorktreeError('SESSION_CHANGED', 'A backing session identity changed during cleanup.');
          const inbox = observation.projections?.values.inbox;
          if (inbox === undefined && observation.events.some(event => event.type === 'agent/inbox/spliced')) throw new WorktreeError('INBOX_UNKNOWN', 'Pending input cannot be ruled out.');
          if (inbox !== undefined && (inbox['next-turn'].length > 0 || inbox['next-step'].length > 0)) throw new WorktreeError('PENDING_INPUT', 'A backing thread has queued or steering input.');
          const metadata = observation.projections?.values.sessionListMetadata;
          const prompt = metadata?.lastPromptAt ?? observation.events.reduce((latest, event) => event.type === 'user/message' && event.data.source.kind === 'user' ? Math.max(latest, event.time) : latest, 0);
          value = prompt || header.createdAt;
          if (!validTime(value)) throw new WorktreeError('ACTIVITY_UNKNOWN', 'A backing session has an invalid activity timestamp.');
          this.activity.set(header.id, { revision: stat.revision, identity: persistence, at: value });
        } finally { observation[Symbol.dispose](); }
      }
      at = Math.max(at, value);
    }
    if (!validTime(at)) throw new WorktreeError('ACTIVITY_UNKNOWN', 'The managed checkout has no trustworthy inactivity timestamp.');
    return at;
  }
  private original(record: WorktreeRecord, previous?: CleanupReceipt): { path: string; projectId?: string; folderId?: string } {
    if (previous?.originalFolder !== null && previous?.originalFolder !== undefined) return { path: previous.originalFolder, ...(previous.projectId === undefined ? {} : { projectId: previous.projectId, folderId: previous.folderId }) };
    const selected = this.deps.projects?.selectionForWorktree(record.id);
    let path = selected?.path ?? resolve(record.repoRoot, record.projectSubdir);
    const seen = new Set<string>();
    for (let depth = 0; depth < 64; depth++) {
      const parents = [...this.worktrees.worktrees.entries()].map(([, row]) => row).filter(row => row.id !== record.id && row.commonDir === record.commonDir && contains(row.checkoutRoot, path));
      if (parents.length === 0) return { path, ...(selected === undefined ? {} : { projectId: selected.projectId, folderId: selected.folderId }) };
      if (parents.length !== 1 || seen.has(parents[0]!.id)) break;
      const parent = parents[0]!; seen.add(parent.id); path = resolve(parent.repoRoot, relative(parent.checkoutRoot, path));
    }
    throw new WorktreeError('SOURCE_UNKNOWN', 'The original selected Local folder has ambiguous managed ancestry.');
  }
  private git(record: WorktreeRecord, signal: AbortSignal, guard: () => void): CleanupGit {
    if (this.deps.git !== undefined) return this.deps.git(record, guard, signal);
    const config = { ...this.config, root: historicalWorktreeRoot(record) };
    return new GitOperations(createMaintenanceExecutor(this.deps.executionContext?.() ?? this.owner, config, guard, this.shutdown.signal), config, guard);
  }
  private async collect(id: string, signal: AbortSignal): Promise<void> {
    let record = this.record(id), previous = this.store.cleanup.get(id);
    const settings = this.settings(), now = this.now();
    let row: CleanupReceipt = previous === undefined ? {
      id, checkoutRoot: record.checkoutRoot, commonDir: record.commonDir, originalFolder: null, sourceRoot: null,
      sessionIds: [], phase: 'deferred', inactivityDays: settings.days, lastActivityAt: null, eligibleAfter: null,
      reclaimedAt: null, recoveryRef: null, createdAt: now, updatedAt: now, reason: null,
    } : { ...copy(previous), inactivityDays: settings.days, updatedAt: now };
    let effect = previous?.phase === 'removing' || previous?.phase === 'recovery-required';
    const leases: SessionHandle[] = [];
    try {
      this.guard(signal);
      if ((previous?.phase === 'removing' || previous?.phase === 'recovery-required') && previous.identity !== undefined && previous.sourceRoot !== null) {
        const state = await this.git(record, signal, () => this.guard(signal)).removalState(record, previous.sourceRoot, previous.identity, signal);
        if (state === 'absent') { await this.finish(record, previous); return; }
        if (state !== 'present') throw new WorktreeError('REMOVAL_UNCERTAIN', 'Checkout removal is partial or its identity changed; automatic retries are refused.');
        effect = false;
      }
      if (!settings.enabled) throw new WorktreeError('CLEANUP_DISABLED', 'Automatic cleanup is disabled.');
      if (record.protected) throw new WorktreeError('PROTECTED', 'This worktree is protected from automatic cleanup.');
      if (record.state !== 'ready') throw new WorktreeError('WORKTREE_NOT_READY', 'This worktree needs recovery before cleanup.');
      historicalWorktreeRoot(record);
      this.noLive(record);
      let headers = await this.associated(record, signal);
      const ids = headers.map(header => String(header.id));
      if (!headers.some(header => header.origin !== 'subagent')) throw new WorktreeError('NO_BACKING_THREAD', 'No durable ordinary thread can own a cleanup writer claim; orphan cleanup requires inspection.');
      await this.resources(record, ids, signal);
      const at = await this.lastActivity(record, headers, signal);
      row = { ...row, lastActivityAt: at, eligibleAfter: at + settings.days * DAY, sessionIds: ids };
      if (now < row.eligibleAfter!) throw new WorktreeError('NOT_EXPIRED', 'The messaging inactivity threshold has not been reached.');
      const original = this.original(record, row);
      const guard = () => {
        this.guard(signal); this.noLive(this.record(id)); const live = this.settings();
        if (!live.enabled || this.record(id).protected || this.now() < at + live.days * DAY) throw new WorktreeError('CLEANUP_CHANGED', 'Cleanup settings, inactivity eligibility, or protection changed before the effect.');
      };
      const git = this.git(record, signal, guard);
      const source = await git.discover(original.path, signal);
      if (source.commonDir !== record.commonDir || contains(record.checkoutRoot, original.path)) throw new WorktreeError('SOURCE_CHANGED', 'The original Local checkout no longer identifies this repository.');
      row = { ...row, originalFolder: original.path, sourceRoot: source.root, ...(original.projectId === undefined ? {} : { projectId: original.projectId, folderId: original.folderId }), phase: 'planned', reason: null };
      await this.put(row); this.collecting.add(id);
      // Durable single-writer handles serialize cooperating sweeps and block
      // cold resume without inventing a stale filesystem lock or deleting a computed directory.
      const persistence = required<Persistence>(this.owner, 'sessionPersistence');
      for (const header of headers) leases.push(await persistence.open(header.id, 'write', { signal }));
      headers = await this.associated(record, signal);
      if (hashValue(headers.map(header => header.id)) !== hashValue(ids)) throw new WorktreeError('SESSION_CHANGED', 'The backing session set changed while claiming cleanup.');
      await this.resources(record, ids, signal);
      const latest = await this.lastActivity(record, headers, signal, true);
      const currentSettings = this.settings();
      if (latest !== at || !currentSettings.enabled || this.now() < latest + currentSettings.days * DAY) throw new WorktreeError('ACTIVITY_CHANGED', 'Activity or cleanup settings changed before deletion.');
      record = this.record(id); guard();
      const identity = await git.inspectRemoval(record, source.root, signal);
      row = { ...row, phase: 'preserving', identity, inactivityDays: currentSettings.days, eligibleAfter: latest + currentSettings.days * DAY, updatedAt: this.now() };
      await this.put(row);
      const recoveryRef = await git.preserveRemovalHead(record, identity, signal);
      row = { ...row, recoveryRef, phase: 'removing', updatedAt: this.now() }; await this.put(row);
      await this.resources(record, ids, signal); guard(); effect = true;
      await git.removeManagedCheckout(record, identity, signal);
      await this.finish(record, row);
    } catch (error) {
      const reason = failureOf(error);
      row = { ...row, phase: effect ? 'recovery-required' : 'deferred', reason, updatedAt: this.now() };
      // Storage-only receipt of an ambiguous effect survives cancellation.
      await this.put(row).catch(() => undefined);
    } finally {
      await Promise.allSettled(leases.map(lease => lease.close()));
      this.collecting.delete(id);
    }
  }
  private async markMissing(record: WorktreeRecord): Promise<void> {
    const current = this.worktrees.worktrees.get(record.id);
    if (current !== undefined && current.state !== 'missing') { const { cleanup: _cleanup, ...raw } = current; await this.worktrees.worktrees.put(record.id, { ...raw, state: 'missing', error: null }); }
  }
  private async finish(record: WorktreeRecord, row: CleanupReceipt): Promise<void> {
    await this.put({ ...row, phase: 'collected', reclaimedAt: row.reclaimedAt ?? this.now(), updatedAt: this.now(), reason: null });
    await this.markMissing(record);
  }
  private async header(id: string, signal: AbortSignal): Promise<SessionHeader> {
    const live = required<Agents>(this.owner, 'agents').get(id);
    const header = live?.session.header ?? (await required<Persistence>(this.owner, 'sessionPersistence').stat(SessionId(id), { signal }))?.header;
    if (header === undefined) throw new WorktreeError('SESSION_NOT_FOUND', 'This historical conversation is unavailable.');
    return header;
  }
  private reopenReceipt(id: string): ReopenReceipt | undefined { return this.store.reopens.get(id) ?? [...this.store.reopens.entries()].map(([, row]) => row).find(row => row.sessionId === id); }
  private async sourceRow(id: string, signal: AbortSignal): Promise<{ record: WorktreeRecord; cleanup: CleanupReceipt; historicalId: string; reopen?: ReopenReceipt } | undefined> {
    const reopen = this.reopenReceipt(id), historicalId = reopen?.id ?? id;
    const header = await this.header(historicalId, signal);
    const record = [...this.worktrees.worktrees.entries()].map(([, row]) => row).find(row => this.store.cleanup.get(row.id)?.sessionIds.includes(historicalId)
      || (header.cwd !== undefined && contains(row.checkoutRoot, resolve(header.cwd))));
    if (record === undefined) return undefined;
    const cleanup = this.store.cleanup.get(record.id);
    return cleanup === undefined ? undefined : { record: copy(record), cleanup: copy(cleanup), historicalId, ...(reopen === undefined ? {} : { reopen: copy(reopen) }) };
  }
  async info(sourceSessionId: string, signal: AbortSignal, options: Pick<WorktreeRequest, 'cursor' | 'limit'> = {}): Promise<WorktreeReopenInfo> {
    this.guard(signal);
    const source = await this.sourceRow(sourceSessionId, signal);
    const info: WorktreeReopenInfo = { sourceSessionId, worktreeId: source?.record.id ?? null, cleanup: source === undefined ? null : cleanupSummary(source.cleanup), continuationSessionId: source?.reopen?.phase === 'ready' ? source.reopen.sessionId : null, originalFolder: source?.cleanup.originalFolder ?? null, revision: this.revision };
    if (source?.reopen?.phase === 'ready') { info.recoveredBranch = source.reopen.localBranch === 'HEAD' ? null : source.reopen.localBranch; return info; }
    if (source?.reopen !== undefined) info.pendingSessionId = source.reopen.sessionId;
    if (source?.cleanup.phase !== 'collected') return info;
    if (source.cleanup.originalFolder === null || source.cleanup.sourceRoot === null || source.cleanup.identity === undefined) throw new WorktreeError('SOURCE_UNKNOWN', 'The reclaimed checkout has no verified original Local folder receipt.');
    const git = this.git(source.record, signal, () => this.guard(signal));
    if (await git.removalState(source.record, source.cleanup.sourceRoot, source.cleanup.identity, signal) !== 'absent') throw new WorktreeError('SOURCE_CHANGED', 'The original repository or reclaimed checkout identity changed. Inspect recovery before continuing.');
    const repository = await git.discover(source.cleanup.originalFolder, signal);
    if (repository.commonDir !== source.record.commonDir || repository.root !== source.cleanup.sourceRoot) throw new WorktreeError('SOURCE_CHANGED', 'The original Local checkout no longer identifies the saved repository.');
    info.repository = { root: repository.root, commonDir: repository.commonDir, head: repository.head, branch: repository.branch };
    let generation: { sourceId: string; value: LocalBranches }, generationId: string, offset = 0;
    if (options.cursor === undefined) {
      generationId = randomUUID(); generation = { sourceId: source.historicalId, value: await git.localBranches(repository.root, signal) };
      if (this.branches.size >= 64) this.branches.delete(this.branches.keys().next().value ?? '');
      this.branches.set(generationId, generation);
    } else {
      const match = /^([a-f0-9-]{36}):(\d+)$/u.exec(options.cursor);
      const existing = match === null ? undefined : this.branches.get(match[1]!);
      if (existing === undefined || existing.sourceId !== source.historicalId) throw new WorktreeError('STALE_CURSOR', 'The Local branch list expired. Refresh it.');
      generationId = match![1]!; generation = existing; offset = Number(match![2]);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > generation.value.branches.length) throw new WorktreeError('STALE_CURSOR', 'Invalid Local branch page.');
    }
    const limit = options.limit ?? 100;
    info.branches = generation.value.branches.slice(offset, offset + limit); info.observedAt = generation.value.observedAt;
    if (offset + limit < generation.value.branches.length) info.nextCursor = `${generationId}:${offset + limit}`;
    return info;
  }
  async wait(sourceSessionId: string, after: number, signal: AbortSignal): Promise<WorktreeReopenInfo> {
    this.guard(signal);
    if (this.revision <= after) await new Promise<void>((fulfill, reject) => {
      const finish = () => { cleanup(); fulfill(); };
      const abort = () => { cleanup(); reject(new WorktreeError('CANCELLED', 'Lifecycle observation was cancelled.')); };
      const cleanup = () => { this.listeners.delete(finish); signal.removeEventListener('abort', abort); this.shutdown.signal.removeEventListener('abort', abort); };
      this.listeners.add(finish); signal.addEventListener('abort', abort, { once: true }); this.shutdown.signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted || this.shutdown.signal.aborted) abort(); else if (this.revision > after) finish();
    });
    return this.info(sourceSessionId, signal);
  }
  reopen(input: WorktreeRequest, invocation: RecoveryInvocation): Promise<WorktreeReopenResult> {
    const request = parseRequest(input);
    if (request.action !== 'reopen') return Promise.reject(new WorktreeError('INVALID_REQUEST', 'Choose a Local branch before reopening.'));
    if (invocation.agent === undefined && invocation.origin !== 'ui') return Promise.reject(new WorktreeError('NO_CALLER', 'A real invoking Agent is required.'));
    if (invocation.agent !== undefined && invocation.origin === 'tool' && planBlocksMutation(invocation.agent)) return Promise.reject(new WorktreeError('PLAN_MODE', 'Local recovery is unavailable in plan mode.'));
    const signal = AbortSignal.any([invocation.signal, this.shutdown.signal]);
    const task = this.reopenNow(request, { ...invocation, signal }); this.flights.add(task);
    void task.finally(() => this.flights.delete(task)).catch(() => undefined);
    return task;
  }
  private async reopenNow(request: WorktreeRequest, invocation: RecoveryInvocation): Promise<WorktreeReopenResult> {
    this.guard(invocation.signal);
    const requestedId = request.sourceSessionId!, source = await this.sourceRow(requestedId, invocation.signal);
    if (source?.cleanup.phase !== 'collected') throw new WorktreeError('NOT_RECLAIMED', 'This thread has no confirmed worktree cleanup receipt.');
    return this.controller.withRepositoryMaintenance(source.record.commonDir, invocation.signal, async signal => {
      this.guard(signal);
      const latest = await this.sourceRow(requestedId, signal);
      if (latest?.cleanup.phase !== 'collected' || latest.cleanup.originalFolder === null || latest.cleanup.sourceRoot === null || latest.cleanup.identity === undefined) throw new WorktreeError('SOURCE_UNKNOWN', 'The Local recovery receipt is incomplete.');
      let receipt = this.store.reopens.get(latest.historicalId);
      if (receipt?.phase === 'ready') {
        const target = await this.header(receipt.sessionId, signal);
        if (target.cwd !== receipt.cwd || target.parentSession !== receipt.id) throw new WorktreeError('CONTINUATION_CHANGED', 'The saved Local continuation has conflicting identity.');
        return this.result(requestedId, receipt, latest.cleanup);
      }
      const git = this.git(latest.record, signal, () => this.guard(signal));
      if (await git.removalState(latest.record, latest.cleanup.sourceRoot, latest.cleanup.identity, signal) !== 'absent') throw new WorktreeError('SOURCE_CHANGED', 'The repository identity changed after cleanup.');
      const original = await git.discover(latest.cleanup.originalFolder, signal);
      if (original.root !== latest.cleanup.sourceRoot || original.commonDir !== latest.record.commonDir) throw new WorktreeError('SOURCE_CHANGED', 'The original selected Local folder changed.');
      const cold = await this.bootstrap.coldSource(latest.historicalId, signal);
      if (receipt !== undefined && receipt.sourceHash !== cold.hash) throw new WorktreeError('SOURCE_CHANGED', 'Historical history or preset intent changed after recovery was planned.');
      const now = this.now();
      receipt = receipt === undefined ? {
        id: latest.historicalId, worktreeId: latest.record.id, sessionId: randomUUID(), sourceHash: cold.hash,
        sourceBoundary: cold.boundary, cwd: latest.cleanup.originalFolder, sourceRoot: original.root, commonDir: original.commonDir,
        localBranch: request.localBranch!, localOid: request.localOid!, workspaceId: null, phase: 'planned', createdAt: now, updatedAt: now, reason: null,
      } : { ...copy(receipt), localBranch: request.localBranch!, localOid: request.localOid!, phase: 'planned', updatedAt: now, reason: null };
      await this.putReopen(receipt); this.pendingTargets.add(receipt.sessionId);
      let committed = false;
      try {
        const child = await this.bootstrap.stageColdContinuation({ sessionId: receipt.sessionId, cwd: receipt.cwd, title: latest.record.displayName ?? basename(original.root), source: cold, signal: this.shutdown.signal, holdInput: (agent, factory) => this.holdInput(agent, factory),
          onCreated: async identity => { receipt = { ...receipt!, workspaceId: identity.workspaceId, phase: 'session-created', updatedAt: this.now() }; await this.putReopen(receipt); },
        });
        receipt = { ...receipt, workspaceId: child.workspaceId, phase: 'session-created', updatedAt: this.now() }; await this.putReopen(receipt);
        // Use the REAL requested Local continuation, not a temporary privileged actor.
        const actor = invocation.agent ?? child.agent;
        const guard = () => {
          this.guard(signal);
          const hold = this.targetHolds.get(child.agent.id);
          if (hold?.agent !== child.agent || hold.signal?.aborted || required<Agents>(this.owner, 'agents').get(actor.id) !== actor) throw new WorktreeError('SESSION_CHANGED', 'The invoking runtime or pending input hold changed.');
        };
        guard();
        const changing = original.branch !== receipt.localBranch && !(receipt.localBranch === 'HEAD' && original.branch === null);
        let branch = original.branch;
        if (changing) {
          requireFullAccess(actor);
          receipt = { ...receipt, phase: 'switching', updatedAt: this.now() }; await this.putReopen(receipt);
          const state = await this.controller.withLocalClaims([original.root], { agent: actor, origin: invocation.origin, signal }, async (maintenance, guardClaims) => {
            const authorize = () => { guard(); requireFullAccess(actor); guardClaims(); };
            const callerGit = new GitOperations(createExecutor(actor, this.config, this.shutdown.signal, authorize), this.config, authorize);
            return callerGit.switchLocalBranch(receipt!.cwd, receipt!.commonDir, receipt!.localBranch, receipt!.localOid, maintenance);
          }, [child.agent]);
          branch = state.branch;
        } else {
          // Validate a no-op selection even when Local has unsaved files.
          const state = await git.switchLocalBranch(receipt.cwd, receipt.commonDir, receipt.localBranch, receipt.localOid, signal, true); branch = state.branch;
        }
        const membership = this.deps.projects?.folderForPath(receipt.cwd);
        if (membership !== undefined) await this.deps.projects?.recordThread({ sessionId: child.sessionId, projectId: membership.projectId, folderId: membership.folderId, mode: 'local', effectiveCwd: receipt.cwd });
        receipt = { ...receipt, localBranch: branch ?? 'HEAD', phase: 'ready', updatedAt: this.now(), reason: null };
        // READY commits the validated branch/history/workspace identity, not
        // the success of unrelated downstream factory publication listeners.
        // This is the same commitment boundary for bootstrap-owned factories
        // and native factories whose eventual completion belongs to the Host.
        guard(); await this.putReopen(receipt, () => {
          committed = true;
          this.pendingTargets.delete(receipt!.sessionId);
          this.targetHolds.get(child.agent.id)?.release();
        });
        await child.completion;
        return this.result(requestedId, receipt, latest.cleanup);
      } catch (error) {
        if (committed) throw new WorktreeError('CONTINUATION_PUBLICATION_FAILED', 'Local recovery is committed to the chosen branch and continuation, but its Agent could not finish publication. Open the same continuation through the native Session controls to retry; no new conversation or branch is needed.', { sessionId: receipt.sessionId, publication: failureOf(error) });
        this.pendingTargets.add(receipt.sessionId);
        await this.putReopen({ ...receipt, phase: 'recovery-required', reason: failureOf(error), updatedAt: this.now() }); throw error;
      }
    });
  }
  private result(sourceSessionId: string, receipt: ReopenReceipt, cleanup: CleanupReceipt): WorktreeReopenResult {
    if (receipt.workspaceId === null) throw new WorktreeError('CONTINUATION_UNCERTAIN', 'The continuation has no durable workspace identity.');
    return { sourceSessionId, sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, worktreeId: receipt.worktreeId, cwd: receipt.cwd, branch: receipt.localBranch === 'HEAD' ? null : receipt.localBranch, cleanup: cleanupSummary(cleanup) };
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.shutdown.abort();
    // Keep admission fences until native commands and all owned Agents drain.
    await Promise.allSettled([...this.flights]);
    for (const hold of this.targetHolds.values()) hold.agent.cancel({ kind: 'disposed' }, { keepInbox: true });
    await this.bootstrap.close(); await Promise.allSettled([...this.targetHolds.values()].map(hold => hold.task));
    for (const stop of this.stops.splice(0)) stop();
    this.listeners.clear(); this.activity.clear(); this.branches.clear();
  }
}
