import { randomUUID, createHash } from 'node:crypto';
import { mkdir, realpath, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { GitOperations } from './git.js';
import { WorktreeError, abortIfRequested, failureOf } from './errors.js';
import { capability, required, createExecutor, localProjectPath, planBlocksMutation, requireFullAccess } from './runtime.js';
import { fullAccessActions, mutationActions, hashValue, parseRequest } from './schema.js';
import { SessionBootstrap, type SessionSettings } from './sessions.js';
import { fallbackName, generateWorktreeName, NAMING_DEFAULTS, NAMING_INPUT_CHARS, namingConfig } from './naming.js';
import type { WorktreeStore } from './store.js';
import type { ProjectController } from './projects.js';
import type { CheckoutState, OperationRecord, RemoteBranches, RepositoryInfo, SessionResult, WorktreeConfig, WorktreePreview, WorktreeRecord, WorktreeRequest, WorktreeSetupProgress } from './types.js';

export interface Invocation {
  agent: Agent; origin: 'tool' | 'command' | 'ui'; signal: AbortSignal;
  /** Internal observer only: cannot authorize operations; failures are ignored. */
  onProgress?: (progress: WorktreeSetupProgress) => void;
  /** Internal admission snapshot only; execute always replaces caller-supplied values. */
  capturedRoot?: string;
}
type GitApi = Pick<GitOperations, 'discover' | 'remotes' | 'branches' | 'create' | 'verify' | 'status' | 'createBranch' | 'renameBranch' | 'fingerprint' | 'snapshot' | 'apply'>;
type BootstrapApi = Pick<SessionBootstrap, 'actor' | 'isLive' | 'settings' | 'assertBlank' | 'create' | 'close'>;
export interface ControllerDependencies {
  git?: (actor: Agent, signal: AbortSignal, guard: () => void) => GitApi;
  bootstrap?: BootstrapApi;
  /** Live destination setting for newly admitted creates only; other roots stay static. */
  worktreeRoot?: () => string;
  localPath?: typeof localProjectPath;
  onNamingEligible?: (agent: Agent) => void;
  projects?: Pick<ProjectController, 'resolveFolder' | 'folderForPath' | 'selectionForWorktree' | 'ensureFolder' | 'recordThread' | 'bindingFor'>;
}
interface ProjectSelection { projectId: string; folderId: string; path: string }
interface AgentsCapability { list(): Agent[] }
interface JobsCapability { list(sessionId?: Agent['id']): { status: string }[] }
interface TerminalsCapability { hasOwnerActivity(agent: Agent): boolean }
interface TerminalControllerCapability { list(sessionId: Agent['id']): { state: string }[] }
interface BranchGeneration { id: string; repository: string; value: RemoteBranches }

/** Validate before any filesystem/Git/naming effects; legacy plain configs may be relative. */
export function resolveWorktreeRoot(value: unknown, allowRelative = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value !== value.trim() || /[\u0000-\u001f]/u.test(value) || (!allowRelative && !isAbsolute(value))) {
    throw new WorktreeError('INVALID_ROOT', 'The worktree root must be a nonempty absolute Host path of at most 4096 characters, without control characters or surrounding whitespace.');
  }
  const root = resolve(value);
  if (dirname(root) === root) throw new WorktreeError('UNSAFE_ROOT', 'The filesystem root cannot be the managed worktree root.');
  return root;
}

function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
}
function requiredText(value: string | undefined, field: string): string {
  if (value === undefined) throw new WorktreeError('INVALID_REQUEST', `Missing ${field}.`);
  return value;
}
function clone<T>(value: T): T { return structuredClone(value); }
async function canonicalFuture(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalFuture(parent), basename(path));
  }
}
function waitFor(prior: Promise<void>, signal: AbortSignal): Promise<void> {
  abortIfRequested(signal);
  return new Promise((fulfill, reject) => {
    const abort = () => { cleanup(); reject(new WorktreeError('CANCELLED', 'Cancelled while waiting for the repository queue.')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    prior.then(() => { cleanup(); fulfill(); }, error => { cleanup(); reject(error); });
  });
}

/** Caller-authorized operations; shared Git metadata is serialized per canonical common directory. */
export class WorktreeController {
  private readonly bootstrap: BootstrapApi;
  private readonly shutdown = new AbortController();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly flights = new Set<Promise<unknown>>();
  private readonly statuses = new Map<string, CheckoutState>();
  private readonly previews = new Map<string, WorktreePreview>();
  private readonly namingPreparations = new Map<string, { agent: Agent; task: Promise<void> }>();
  private generation: BranchGeneration | undefined;
  private readonly cursors = new Map<string, { key: string; offset: number }>();
  private closed = false;
  constructor(private readonly owner: Context, private readonly config: WorktreeConfig, private readonly store: WorktreeStore, private readonly dependencies: ControllerDependencies = {}) {
    this.bootstrap = dependencies.bootstrap ?? new SessionBootstrap(owner);
  }
  records(): WorktreeRecord[] { return [...this.store.worktrees.entries()].map(([, record]) => clone(record)); }
  cachedStatus(id: string): CheckoutState | undefined { const state = this.statuses.get(id); return state === undefined ? undefined : clone(state); }
  execute(request: WorktreeRequest, invocation: Invocation): Promise<unknown> {
    if (this.closed) return Promise.reject(new WorktreeError('CLOSED', 'The worktree controller is closing.'));
    const signal = AbortSignal.any([invocation.signal, this.shutdown.signal, AbortSignal.timeout(this.config.operationTimeoutMs)]);
    let parsed: WorktreeRequest;
    const input: Invocation = { ...invocation, signal, capturedRoot: undefined };
    try {
      parsed = parseRequest(request);
      if (parsed.action === 'create') {
        this.guard(parsed, input);
        let root: unknown;
        try { root = this.dependencies.worktreeRoot === undefined ? this.config.root : this.dependencies.worktreeRoot(); }
        catch { throw new WorktreeError('INVALID_ROOT', 'The live worktree root setting could not be read.'); }
        // Read exactly once, synchronously at admission, before bootstrap or queues.
        input.capturedRoot = resolveWorktreeRoot(root, this.dependencies.worktreeRoot === undefined);
      }
    } catch (error) { return Promise.reject(error); }
    const task = Promise.resolve().then(() => this.run(parsed, input));
    this.flights.add(task);
    void task.then(() => this.flights.delete(task), () => this.flights.delete(task));
    return task;
  }
  private namingTask<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WorktreeError('CLOSED', 'The worktree controller is closing.'));
    const lifetime = AbortSignal.any([signal, this.shutdown.signal, AbortSignal.timeout(this.config.operationTimeoutMs)]);
    const result = Promise.resolve().then(() => task(lifetime));
    this.flights.add(result);
    void result.then(() => this.flights.delete(result), () => this.flights.delete(result));
    return result;
  }
  async skipFirstMessageName(id: string, reason: string): Promise<void> {
    const record = this.record(id);
    await this.queued(record.commonDir, this.shutdown.signal, async () => {
      const current = this.record(id); const naming = current.firstMessageNaming;
      if (naming === undefined || naming.phase === 'complete' || naming.phase === 'skipped') return;
      await this.store.worktrees.put(id, { ...current, firstMessageNaming: { ...naming, phase: 'skipped', reason } });
    });
  }
  prepareFirstMessageName(id: string, agent: Agent, event: SessionEvent<'user/message'> | undefined, signal: AbortSignal): Promise<void> {
    const active = this.namingPreparations.get(id);
    if (active?.agent === agent) return active.task;
    const task = this.namingTask(signal, lifetime => this.prepareName(id, agent, event, lifetime));
    this.namingPreparations.set(id, { agent, task });
    const cleanup = () => { if (this.namingPreparations.get(id)?.task === task) this.namingPreparations.delete(id); };
    void task.then(cleanup, cleanup);
    return task;
  }
  private namingInvocation(id: string, agent: Agent, signal: AbortSignal): { request: WorktreeRequest; invocation: Invocation } {
    const request: WorktreeRequest = { action: 'branch', id };
    const invocation: Invocation = { agent, origin: 'tool', signal };
    this.guard(request, invocation);
    const record = this.record(id);
    if (record.firstMessageNaming?.sessionId !== agent.id || !record.sessionIds.includes(agent.id) || agent.session.header.cwd !== record.effectiveCwd) throw new WorktreeError('SESSION_CHANGED', 'First-message naming requires the exact receiving ordinary session and execution directory.');
    this.usable(record, false);
    return { request, invocation };
  }
  private messageForNaming(id: string, agent: Agent, supplied?: SessionEvent<'user/message'>): SessionEvent<'user/message'> {
    const naming = this.record(id).firstMessageNaming;
    const event = naming?.messageSeq === undefined ? supplied : agent.session.eventAt(SessionSeq(naming.messageSeq));
    if (event?.type !== 'user/message' || event.surfaceOp !== 'append' || event.sourceEventSeqs?.length || !agent.session.isOwnSeq(event.seq) || event.data.role !== 'user' || event.data.source.kind !== 'user') throw new WorktreeError('MESSAGE_CHANGED', 'The original authored message is unavailable; automatic naming will not use replacements.');
    if (agent.session.eventAt(event.seq) !== event) throw new WorktreeError('MESSAGE_CHANGED', 'The message is not the receiving session committed event.');
    if (naming?.messageSeq !== undefined && (event.data.id !== naming.messageId || hashValue(event.data) !== naming.messageHash)) throw new WorktreeError('MESSAGE_CHANGED', 'The original first-message identity changed.');
    return event;
  }
  private async prepareName(id: string, agent: Agent, supplied: SessionEvent<'user/message'> | undefined, signal: AbortSignal): Promise<void> {
    const record = this.record(id);
    const prior = record.firstMessageNaming;
    if (prior === undefined || prior.phase === 'complete' || prior.phase === 'skipped') return;
    try {
      const { request, invocation } = this.namingInvocation(id, agent, signal);
      const event = this.messageForNaming(id, agent, supplied);
      const flushed = await required<{ flush(session: Agent['session']): Promise<boolean> }>(this.owner, 'sessions').flush(agent.session);
      if (!flushed) throw new WorktreeError('MISSING_DURABILITY_BARRIER', 'First-message naming requires a successful session durability checkpoint.');
      this.namingInvocation(id, agent, signal);
      let infer = false;
      await this.queued(record.commonDir, signal, async () => {
        this.namingInvocation(id, agent, signal);
        const current = this.record(id); const naming = current.firstMessageNaming!;
        if (naming.phase !== 'waiting') return;
        // Durable intent is written before auxiliary inference. Recovery of an
        // interrupted intent uses fallback rather than paying for another call.
        await this.putRecord({ ...current, firstMessageNaming: { ...naming, phase: 'generating', messageSeq: event.seq, messageId: event.data.id, messageHash: hashValue(event.data) } }, request, invocation);
        infer = true;
      });
      const pending = this.record(id).firstMessageNaming!;
      if (pending.phase !== 'generating') return;
      let text = '';
      for (const block of event.data.content) {
        if (block.type !== 'text') continue;
        text += `${text ? '\n' : ''}${block.text.slice(0, NAMING_INPUT_CHARS - text.length)}`;
        text = text.slice(0, NAMING_INPUT_CHARS);
        if (text.length === NAMING_INPUT_CHARS) break;
      }
      const generatedName = infer
        ? await generateWorktreeName({ source: agent, caller: agent, firstPrompt: text, id, config: this.config, signal, guard: () => { this.namingInvocation(id, agent, signal); } })
        : fallbackName(text, id, 'provider-failure');
      await this.queued(record.commonDir, signal, async () => {
        this.namingInvocation(id, agent, signal);
        const current = this.record(id); const naming = current.firstMessageNaming!;
        if (naming.phase !== 'generating') return;
        await this.putRecord({ ...current, firstMessageNaming: { ...naming, phase: 'generated', generatedName } }, request, invocation);
      });
    } catch (error) {
      if (!signal.aborted && error instanceof WorktreeError && ['PROTECTED', 'ARCHIVED', 'MESSAGE_CHANGED', 'SESSION_CHANGED', 'SESSION_NOT_LIVE', 'FULL_ACCESS_REQUIRED', 'PLAN_MODE'].includes(error.code)) await this.skipFirstMessageName(id, error.code);
      throw error;
    }
  }
  finishFirstMessageName(id: string, agent: Agent, signal: AbortSignal): Promise<void> {
    return this.namingTask(signal, lifetime => this.finishName(id, agent, lifetime));
  }
  private namingMaintenance(agent: Agent, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    try { return agent.runMaintenance(task); }
    catch { return Promise.reject(new WorktreeError('BUSY', 'The receiving agent became active before the idle naming claim.')); }
  }
  private async finishName(id: string, agent: Agent, signal: AbortSignal): Promise<void> {
    const record = this.record(id);
    try {
      await this.queued(record.commonDir, signal, async () => {
        const current = this.record(id); const naming = current.firstMessageNaming;
        if (naming === undefined || !['generated', 'renaming'].includes(naming.phase) || naming.generatedName === undefined) return;
        const { request, invocation } = this.namingInvocation(id, agent, signal);
        this.messageForNaming(id, agent);
        // Acquiring true idle inside the repository queue closes the race with
        // waking input, without blocking the original prompt or emitting chat rows.
        await this.namingMaintenance(agent, async maintenance => {
          const scopedSignal = AbortSignal.any([signal, maintenance]);
          const scoped = { ...invocation, signal: scopedSignal };
          const guard = () => { this.namingInvocation(id, agent, scopedSignal); this.messageForNaming(id, agent); };
          guard();
          const flushed = await required<{ flush(session: Agent['session']): Promise<boolean> }>(this.owner, 'sessions').flush(agent.session);
          if (!flushed) throw new WorktreeError('MISSING_DURABILITY_BARRIER', 'First-message log durability was not established before branch mutation.');
          guard();
          const git = this.git(request, scoped);
          const state = await git.verify(current, scopedSignal);
          const generatedName = naming.generatedName!;
          if (state.branch !== naming.initialBranch && !(naming.phase === 'renaming' && state.branch === generatedName.branch)) throw new WorktreeError('BRANCH_CHANGED', 'The user changed the initial branch; automatic naming is skipped.');
          let next = current;
          if (state.branch === naming.initialBranch) {
            next = { ...current, firstMessageNaming: { ...naming, phase: 'renaming' } };
            await this.putRecord(next, request, scoped); guard();
            const renamed = await git.renameBranch(next, naming.initialBranch, generatedName.branch, scopedSignal);
            this.statuses.set(id, renamed);
          }
          // Receipt of committed Git effect survives cancellation/permission changes.
          next = { ...this.record(id), branch: generatedName.branch, naming: generatedName, displayName: generatedName.title, firstMessageNaming: { ...naming, phase: 'renaming' } };
          await this.store.worktrees.put(id, clone(next));
          guard();
          const workspace = next.workspaceId === null ? undefined : capability<{ get(id: string): { path: string; title: string; setTitle(title: string): Promise<void> } | undefined }>(this.owner, 'workspaceRegistry')?.get(next.workspaceId);
          if (workspace !== undefined) {
            if (workspace.path !== next.effectiveCwd) throw new WorktreeError('SESSION_CHANGED', 'The workspace no longer identifies the receiving checkout.');
            // The no-prompt flow always creates this default title. Publish the
            // usual structural change only while it is still plugin-owned; a
            // manually edited native Workspace title takes precedence.
            if (workspace.title === `${basename(next.repoRoot)} · ${next.remoteBranch}`) await workspace.setTitle(generatedName.title);
          }
          guard();
          await this.putRecord({ ...next, firstMessageNaming: { ...naming, phase: 'complete' } }, request, scoped);
        });
      });
    } catch (error) {
      if (!signal.aborted && error instanceof WorktreeError && ['BRANCH_CHANGED', 'BRANCH_EXISTS', 'PROTECTED', 'ARCHIVED', 'MESSAGE_CHANGED', 'SESSION_CHANGED', 'SESSION_NOT_LIVE', 'FULL_ACCESS_REQUIRED', 'PLAN_MODE'].includes(error.code)) await this.skipFirstMessageName(id, error.code);
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.shutdown.abort();
    await Promise.allSettled([...this.flights]);
    await this.bootstrap.close();
    this.previews.clear(); this.cursors.clear(); this.statuses.clear();
  }
  private guard(request: WorktreeRequest, invocation: Invocation): void {
    abortIfRequested(invocation.signal);
    if (!this.bootstrap.isLive(invocation.agent) || this.bootstrap.actor(invocation.agent.id) !== invocation.agent) throw new WorktreeError('SESSION_CHANGED', 'The invoking session is no longer the exact live ordinary session.');
    if (fullAccessActions.has(request.action)) requireFullAccess(invocation.agent);
    if (invocation.origin === 'tool' && mutationActions.has(request.action) && planBlocksMutation(invocation.agent)) throw new WorktreeError('PLAN_MODE', 'This mutation is unavailable while plan mode is active or pending enabled.');
  }
  private git(request: WorktreeRequest, invocation: Invocation): GitApi {
    const guard = () => this.guard(request, invocation);
    if (this.dependencies.git !== undefined) return this.dependencies.git(invocation.agent, invocation.signal, guard);
    const executor = createExecutor(invocation.agent, this.config, this.shutdown.signal);
    return new GitOperations(async spec => { guard(); return executor(spec); }, this.config, guard);
  }
  private local(actor: Agent, path: string | undefined, signal: AbortSignal): Promise<string> { return (this.dependencies.localPath ?? localProjectPath)(actor, path, signal); }
  private projectSelection(path: string, request?: WorktreeRequest): ProjectSelection | undefined {
    const projects = this.dependencies.projects;
    if (request?.projectId !== undefined && request.folderId !== undefined) {
      if (projects === undefined) throw new WorktreeError('MISSING_PROJECTS', 'The project capability is unavailable.');
      const folder = projects.resolveFolder(request.projectId, request.folderId);
      if (folder.path !== path) throw new WorktreeError('PROJECT_PATH_MISMATCH', 'The selected project folder no longer matches the creation directory.');
      return { projectId: request.projectId, folderId: folder.id, path: folder.path };
    }
    return projects?.folderForPath(path);
  }
  private assertProject(selection: ProjectSelection | undefined): void {
    if (selection === undefined) return;
    const folder = this.dependencies.projects?.resolveFolder(selection.projectId, selection.folderId);
    if (folder?.path !== selection.path) throw new WorktreeError('PROJECT_CHANGED', 'Project folder membership changed while preparing the thread.');
  }
  private async bindThread(sessionId: string, cwd: string, selection: ProjectSelection | undefined, worktreeId?: string): Promise<void> {
    if (selection === undefined) return;
    await this.dependencies.projects?.recordThread({ sessionId, projectId: selection.projectId, folderId: selection.folderId, effectiveCwd: cwd, mode: worktreeId === undefined ? 'local' : 'worktree', ...(worktreeId === undefined ? {} : { worktreeId }) });
  }
  private async queued<T>(key: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(fulfill => { release = fulfill; });
    const tail = prior.then(() => gate);
    this.queues.set(key, tail);
    try { await waitFor(prior, signal); abortIfRequested(signal); return await operation(); }
    finally { release(); void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); }); }
  }
  private record(id: string | undefined): WorktreeRecord {
    const record = this.store.worktrees.get(requiredText(id, 'id'));
    if (record === undefined) throw new WorktreeError('NOT_FOUND', 'This worktree is not recorded by the plugin.');
    return clone(record);
  }
  private usable(record: WorktreeRecord, allowProtected = true): void {
    if (record.archived) throw new WorktreeError('ARCHIVED', 'Unarchive the worktree before using it.');
    if (record.state !== 'ready') throw new WorktreeError('RECOVERY_REQUIRED', 'The worktree is not ready. Inspect its operation status before proceeding.');
    if (!allowProtected && record.protected) throw new WorktreeError('PROTECTED', 'Unprotect the worktree before this operation.');
  }
  private async putRecord(record: WorktreeRecord, request: WorktreeRequest, invocation: Invocation): Promise<void> { this.guard(request, invocation); await this.store.worktrees.put(record.id, clone(record)); }
  private async putOperation(operation: OperationRecord, request: WorktreeRequest, invocation: Invocation): Promise<void> { this.guard(request, invocation); await this.store.operations.put(operation.id, clone(operation)); }
  private progress(invocation: Invocation, operation: Pick<OperationRecord, 'id' | 'worktreeId'>, stage: WorktreeSetupProgress['stage']): void {
    // Immutable identity only; no request/settings/provider data or authorization.
    try { void Promise.resolve(invocation.onProgress?.(Object.freeze({ stage, operationId: operation.id, worktreeId: operation.worktreeId }))).catch(() => undefined); } catch { /* observer only */ }
  }
  private operationResult(operation: OperationRecord): SessionResult {
    if (operation.sessionId === null || operation.workspaceId === null) throw new WorktreeError('RECOVERY_REQUIRED', 'The operation has no durably recorded conversation identity.');
    return { worktree: this.record(operation.worktreeId), sessionId: operation.sessionId, workspaceId: operation.workspaceId, settingsHash: operation.settingsHash, operation: clone(operation) };
  }
  private cursor(key: string, supplied: string | undefined): number {
    if (supplied === undefined) return 0;
    const cursor = this.cursors.get(supplied);
    if (cursor === undefined || cursor.key !== key) throw new WorktreeError('STALE_CURSOR', 'The advertised generation or list changed. Reload from its first page.');
    return cursor.offset;
  }
  private nextCursor(key: string, offset: number): string {
    if (this.cursors.size >= 512) this.cursors.delete(this.cursors.keys().next().value ?? '');
    const token = randomUUID(); this.cursors.set(token, { key, offset }); return token;
  }
  private async run(request: WorktreeRequest, invocation: Invocation): Promise<unknown> {
    this.guard(request, invocation);
    if (request.action === 'start' || request.action === 'branch' || request.action === 'export' || (request.action === 'status' && request.id !== undefined)) await this.local(invocation.agent, undefined, invocation.signal);
    const git = this.git(request, invocation);
    if (request.action === 'create' || request.action === 'handoff') return this.queued(`operation:${requiredText(request.operationId, 'operationId')}`, invocation.signal, () => request.action === 'create' ? this.create(request, invocation, git) : this.handoff(request, invocation, git));
    if (request.action === 'status') return this.status(request, invocation, git);
    if (request.action === 'list' || request.action === 'branches') {
      const path = await this.local(invocation.agent, request.repoPath, invocation.signal);
      const repository = await git.discover(path, invocation.signal);
      if (request.action === 'list') {
        const items = this.records().filter(r => r.commonDir === repository.commonDir && (request.includeArchived === true || !r.archived)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        const key = hashValue({ repository: repository.commonDir, includeArchived: request.includeArchived === true, records: items.map(r => [r.id, r.createdAt, r.archived]) });
        const offset = this.cursor(key, request.cursor); const limit = request.limit ?? 50;
        return { items: items.slice(offset, offset + limit), ...(offset + limit < items.length ? { nextCursor: this.nextCursor(key, offset + limit) } : {}) };
      }
      return this.branches(request, invocation, git, repository);
    }
    if (request.action === 'export') return this.exportPatch(request, invocation);
    const record = this.record(request.id);
    return this.queued(record.commonDir, invocation.signal, async () => {
      this.guard(request, invocation);
      const current = this.record(record.id);
      if (request.action === 'protect') { const next = { ...current, protected: request.protected === true }; await this.putRecord(next, request, invocation); return { worktree: next }; }
      if (request.action === 'archive') {
        if (current.protected && request.archived !== false) throw new WorktreeError('PROTECTED', 'Unprotect the worktree before archiving it.');
        const next = { ...current, archived: request.archived !== false }; await this.putRecord(next, request, invocation);
        return { worktree: next, scope: 'plugin-record', retained: ['checkout', 'base-ref', 'sessions', 'logs'] };
      }
      this.usable(current);
      this.statuses.set(current.id, await git.verify(current, invocation.signal));
      if (request.action === 'branch') {
        this.usable(current, false); this.guard(request, invocation);
        const state = await git.createBranch(current, requiredText(request.name, 'name'), invocation.signal);
        const next = { ...current, branch: state.branch }; this.statuses.set(next.id, state);
        await this.putRecord(next, request, invocation); return { worktree: next, status: state };
      }
      if (request.action === 'start') return this.start(request, invocation, current);
      if (request.action === 'preview') return this.preview(request, invocation, git, current);
      throw new WorktreeError('INVALID_REQUEST', 'Unsupported worktree action.');
    });
  }
  private async status(request: WorktreeRequest, invocation: Invocation, git: GitApi): Promise<unknown> {
    const settings = await this.bootstrap.settings(invocation.agent, invocation.signal);
    if (request.operationId !== undefined) {
      const operation = this.store.operations.get(request.operationId);
      if (operation === undefined) throw new WorktreeError('NOT_FOUND', 'This operation is not recorded.');
      const worktree = this.store.worktrees.get(operation.worktreeId);
      return { operation: clone(operation), ...(worktree === undefined ? {} : { worktree: clone(worktree) }), ...(operation.sessionId === null ? {} : { sessionId: operation.sessionId }), settingsHash: settings.hash };
    }
    if (request.id !== undefined) {
      const record = this.record(request.id);
      let state: CheckoutState | null = null;
      try { state = await git.verify(record, invocation.signal); this.statuses.set(record.id, state); }
      catch (error) { abortIfRequested(invocation.signal); if (!(error instanceof WorktreeError)) throw error; this.statuses.delete(record.id); }
      return { worktree: record, status: state, settingsHash: settings.hash };
    }
    const path = await this.local(invocation.agent, request.repoPath, invocation.signal);
    const repository = await git.discover(path, invocation.signal);
    const projectBinding = this.dependencies.projects?.bindingFor(invocation.agent.id) ?? this.dependencies.projects?.bindingFor(invocation.agent.id, path);
    return { repository, projectPath: path, ...(projectBinding === undefined ? {} : { projectBinding }), remotes: await git.remotes(repository.root, invocation.signal), settingsHash: settings.hash, defaults: { remote: this.config.defaultRemote, branch: this.config.defaultBranch }, namingConfig: namingConfig(this.config) };
  }
  private async branches(request: WorktreeRequest, invocation: Invocation, git: GitApi, repository: RepositoryInfo): Promise<unknown> {
    const remote = requiredText(request.remote, 'remote');
    const identity = (await git.remotes(repository.root, invocation.signal)).find(r => r.name === remote)?.identity;
    if (identity === undefined) throw new WorktreeError('REMOTE_NOT_FOUND', 'The selected remote is not configured.');
    if (request.remoteIdentity !== undefined && request.remoteIdentity !== identity) throw new WorktreeError('REMOTE_CHANGED', 'The remote configuration changed. Reload its branch list.');
    let generation = this.generation;
    if (request.cursor === undefined) {
      this.generation = undefined;
      const value = await git.branches(repository.root, remote, identity, invocation.signal);
      generation = { id: randomUUID(), repository: repository.commonDir, value: { ...value, branches: [...value.branches].sort((a, b) => a.name.localeCompare(b.name)) } };
      this.generation = generation;
    }
    if (generation === undefined || generation.repository !== repository.commonDir || generation.value.remote !== remote || generation.value.remoteIdentity !== identity) throw new WorktreeError('STALE_CURSOR', 'The branch generation expired. Reload its first page.');
    const query = request.query ?? '';
    const items = generation.value.branches.filter(branch => branch.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const key = hashValue({ generation: generation.id, query }); const offset = this.cursor(key, request.cursor); const limit = request.limit ?? 50;
    return { remote, remoteIdentity: identity, defaultBranch: generation.value.defaultBranch, items: items.slice(offset, offset + limit), observedAt: generation.value.observedAt, ...(offset + limit < items.length ? { nextCursor: this.nextCursor(key, offset + limit) } : {}) };
  }
  private normalizedCreate(request: WorktreeRequest, actor: Agent, path: string): unknown {
    return { ...request, repoPath: path, sourceSessionId: request.sourceSessionId ?? actor.id, sessionMode: request.sessionMode ?? 'new', requireBlankSource: request.requireBlankSource ?? false };
  }
  private async sameSettings(source: Agent, settings: SessionSettings, request: WorktreeRequest, invocation: Invocation): Promise<void> {
    this.guard(request, invocation);
    if ((await this.bootstrap.settings(source, invocation.signal)).hash !== settings.hash) throw new WorktreeError('SETTINGS_CHANGED', 'Source settings changed. Prepare a new operation with the current selection.');
    if (request.requireBlankSource === true) await this.bootstrap.assertBlank(source);
  }
  private newOperation(id: string, kind: OperationRecord['kind'], requestHash: string, actor: Agent, record: WorktreeRecord, source: Agent, settings: SessionSettings, mode: 'new' | 'continue', targetRoot: string | null = null, previewId: string | null = null): OperationRecord {
    const now = Date.now();
    return { id, kind, requestHash, actorId: actor.id, worktreeId: record.id, phase: 'planned', createdAt: now, updatedAt: now, sessionId: null, workspaceId: null, error: null, settingsHash: settings.hash, settings: clone(settings), sourceSessionId: source.id, sessionMode: mode, targetRoot, previewId, appliedHead: null, appliedFingerprint: null };
  }
  private async phase(operation: OperationRecord, phase: OperationRecord['phase'], request: WorktreeRequest, invocation: Invocation, extra: Partial<OperationRecord> = {}): Promise<OperationRecord> {
    const next = { ...operation, ...extra, phase, updatedAt: Date.now() }; await this.putOperation(next, request, invocation); return next;
  }
  private async receipt(operation: OperationRecord, phase: OperationRecord['phase'], extra: Partial<OperationRecord> = {}): Promise<OperationRecord> {
    // Recording an already committed effect must survive cancellation or permission changes.
    // This is storage-only recovery bookkeeping, never admission for another Git/session effect.
    const next = { ...operation, ...extra, phase, updatedAt: Date.now() };
    await this.store.operations.put(next.id, clone(next));
    return next;
  }
  private async journalFailure(id: string, error: unknown, effects: boolean): Promise<void> {
    const current = this.store.operations.get(id); if (current === undefined || current.phase === 'ready') return;
    const failure = failureOf(error);
    // Cleanup journaling may outlive cancellation; it never performs Git or session effects.
    const phase = current.phase === 'code-applied' ? 'code-applied' : !effects && (failure.code === 'CANCELLED' || failure.code === 'TIMEOUT') ? 'cancelled-before-effects' : 'recovery-required';
    await this.store.operations.put(id, { ...current, phase, updatedAt: Date.now(), error: failure });
    const record = this.store.worktrees.get(current.worktreeId);
    if (record !== undefined && record.state === 'creating') await this.store.worktrees.put(record.id, { ...record, state: 'recovery-required', error: failure.message });
  }
  private async create(request: WorktreeRequest, invocation: Invocation, git: GitApi): Promise<SessionResult> {
    const path = await this.local(invocation.agent, request.repoPath, invocation.signal);
    const operationId = requiredText(request.operationId, 'operationId');
    const requestHash = hashValue({ actor: invocation.agent.id, request: this.normalizedCreate(request, invocation.agent, path) });
    const existing = this.store.operations.get(operationId);
    if (existing !== undefined) {
      if (existing.kind !== 'create' || existing.actorId !== invocation.agent.id || existing.requestHash !== requestHash) throw new WorktreeError('OPERATION_REUSED', 'The operation id is already bound to another request or caller.');
      if (existing.phase === 'ready') {
        const result = this.operationResult(existing);
        this.progress(invocation, existing, 'ready');
        return result;
      }
      throw new WorktreeError('RECOVERY_REQUIRED', 'This operation may have committed effects. Inspect its status; do not repeat checkout creation.');
    }
    const source = this.bootstrap.actor(request.sourceSessionId ?? invocation.agent.id);
    const settings = await this.bootstrap.settings(source, invocation.signal);
    if (request.settingsHash !== undefined && request.settingsHash !== settings.hash) throw new WorktreeError('SETTINGS_CHANGED', 'Source settings changed before preparation.');
    if (request.requireBlankSource === true) await this.bootstrap.assertBlank(source);
    let repository = await git.discover(path, invocation.signal);
    let project = this.projectSelection(path, request);
    if (project === undefined && this.dependencies.projects !== undefined) {
      // An explicit agent repoPath may not have had a native Workspace yet.
      // Import only metadata after the actual caller admitted that source path.
      const sourceRecord = this.records().find(record => record.effectiveCwd === path);
      const owner = sourceRecord === undefined ? undefined : this.dependencies.projects.selectionForWorktree(sourceRecord.id);
      if (owner !== undefined) project = owner;
      else {
        const binding = this.dependencies.projects.bindingFor(invocation.agent.id, path);
        if (binding !== undefined) {
          const folder = this.dependencies.projects.resolveFolder(binding.projectId, binding.folderId);
          project = { projectId: binding.projectId, folderId: folder.id, path: folder.path };
        } else {
          const localFolder = sourceRecord === undefined ? path : resolve(sourceRecord.repoRoot, sourceRecord.projectSubdir);
          // Removed/independent nested sources may name another managed checkout.
          // Optional metadata must not reimport that checkout or block independent use.
          if (!this.records().some(record => contained(record.checkoutRoot, localFolder))) project = await this.dependencies.projects.ensureFolder(localFolder, invocation.signal);
        }
      }
    }
    if (project !== undefined && project.path !== path) {
      // A thread may originate in another managed checkout. Its logical Local
      // folder remains the original project folder, not a new project or handoff target.
      const originalPath = await this.local(invocation.agent, project.path, invocation.signal);
      const original = await git.discover(originalPath, invocation.signal);
      if (originalPath !== project.path || original.commonDir !== repository.commonDir || original.projectSubdir !== repository.projectSubdir) throw new WorktreeError('PROJECT_REPOSITORY_MISMATCH', 'The source checkout does not map to the selected original project folder.');
      repository = original;
    }
    return this.queued(repository.commonDir, invocation.signal, async () => {
      this.assertProject(project);
      await this.sameSettings(source, settings, request, invocation);
      const remote = requiredText(request.remote, 'remote'); const remoteBranch = requiredText(request.remoteBranch, 'remoteBranch');
      const identity = (await git.remotes(repository.root, invocation.signal)).find(r => r.name === remote)?.identity;
      if (identity === undefined) throw new WorktreeError('REMOTE_NOT_FOUND', 'The selected remote is not configured.');
      if (request.remoteIdentity !== undefined && request.remoteIdentity !== identity) throw new WorktreeError('REMOTE_CHANGED', 'The remote configuration changed. Reload its branch list.');
      const root = resolveWorktreeRoot(await canonicalFuture(resolveWorktreeRoot(invocation.capturedRoot)));
      if (contained(repository.root, root)) throw new WorktreeError('UNSAFE_ROOT', 'The worktree root must be outside the source checkout.');
      const id = randomUUID(); const directoryRoot = resolve(root, hashValue(repository.commonDir).slice(0, 24), id);
      const initialBranch = `worktree/${id}`;
      const destination = resolve(directoryRoot, `worktree-${id}`);
      const record: WorktreeRecord = { id, operationId, repoRoot: repository.root, commonDir: repository.commonDir, projectSubdir: repository.projectSubdir, checkoutRoot: destination, effectiveCwd: resolve(destination, repository.projectSubdir), remote, remoteIdentity: identity, remoteBranch, baseOid: '', baseRef: `refs/dsh-worktrees/${id}/base`, fetchedAt: 0, createdAt: Date.now(), sessionIds: [], workspaceId: null, branch: null, ...(project === undefined ? {} : { projectId: project.projectId, folderId: project.folderId }), protected: false, archived: false, state: 'creating', error: null };
      let operation = this.newOperation(operationId, 'create', requestHash, invocation.agent, record, source, settings, request.sessionMode ?? 'new');
      let effects = false;
      try {
        await this.putOperation(operation, request, invocation); await this.putRecord(record, request, invocation);
        await this.sameSettings(source, settings, request, invocation);
        operation = await this.phase(operation, 'fetching', request, invocation); effects = true;
        this.guard(request, invocation); await mkdir(dirname(destination), { recursive: true });
        if (await canonicalFuture(destination) !== destination) throw new WorktreeError('PATH_CHANGED', 'The destination ancestry changed during preparation.');
        this.guard(request, invocation);
        const progressOperation = Object.freeze({ id: operationId, worktreeId: id });
        const checkout = await git.create({ id, repository, destination, remote, remoteIdentity: identity, remoteBranch, baseRef: record.baseRef, signal: invocation.signal,
          onProgress: stage => this.progress(invocation, progressOperation, stage),
        });
        let created = { ...record, ...checkout };
        await this.store.worktrees.put(created.id, clone(created)); operation = await this.receipt(operation, 'checkout-created');
        await this.sameSettings(source, settings, request, invocation);
        if (created.checkoutRoot !== destination || created.effectiveCwd !== record.effectiveCwd || !contained(destination, created.effectiveCwd)) throw new WorktreeError('UNSAFE_PATH', 'The created checkout does not match its planned directory mapping.');
        {
          this.guard(request, invocation);
          // Keep one stable random checkout and initial branch in both flows.
          const state = await git.createBranch(created, initialBranch, invocation.signal);
          created = { ...created, branch: state.branch }; this.statuses.set(created.id, state);
          await this.store.worktrees.put(created.id, clone(created));
          await this.sameSettings(source, settings, request, invocation);
        }
        if (request.firstPrompt !== undefined) {
          // Durable intent precedes the one bounded auxiliary call. Interrupted
          // creates remain fail-closed, retaining checkout/name instead of paying again.
          operation = await this.phase(operation, 'checkout-created', request, invocation, { namingStarted: true });
          this.progress(invocation, progressOperation, 'naming');
          this.guard(request, invocation);
          // Foreground setup never waits beyond 15s, even if legacy background
          // naming has a longer configured limit; shorter configured limits win.
          const config = { ...this.config, namingTimeoutMs: Math.min(namingConfig(this.config).namingTimeoutMs, NAMING_DEFAULTS.namingTimeoutMs) };
          const generatedName = await generateWorktreeName({ source, caller: invocation.agent, firstPrompt: request.firstPrompt, id, config, signal: invocation.signal, guard: () => this.guard(request, invocation) });
          operation = await this.receipt(operation, 'checkout-created', { generatedName });
          created = { ...created, displayName: generatedName.title, naming: generatedName };
          await this.store.worktrees.put(created.id, clone(created));
          await this.sameSettings(source, settings, request, invocation);
          this.assertProject(project);
          const renamed = await git.renameBranch(created, initialBranch, generatedName.branch, invocation.signal);
          // This receipt is storage-only even if cancellation follows Git's commit.
          created = { ...created, branch: renamed.branch }; this.statuses.set(created.id, renamed);
          await this.store.worktrees.put(created.id, clone(created));
          await this.sameSettings(source, settings, request, invocation);
        }
        this.assertProject(project);
        this.progress(invocation, progressOperation, 'opening');
        this.guard(request, invocation);
        const result = await this.bootstrap.create({ cwd: checkout.effectiveCwd, title: created.displayName ?? `${basename(repository.root)} · ${remoteBranch}`, source, settings, mode: operation.sessionMode, signal: invocation.signal,
          onCreated: async identity => {
            operation = await this.receipt(operation, 'session-created', { sessionId: identity.sessionId, workspaceId: identity.workspaceId });
            if (request.firstPrompt === undefined) created = { ...created, firstMessageNaming: { sessionId: identity.sessionId, initialBranch, phase: 'waiting' } };
            await this.store.worktrees.put(created.id, { ...created, sessionIds: [identity.sessionId], workspaceId: identity.workspaceId });
            await this.bindThread(identity.sessionId, checkout.effectiveCwd, project, created.id);
          },
        });
        const next = { ...created, sessionIds: [result.sessionId], workspaceId: result.workspaceId };
        await this.sameSettings(source, settings, request, invocation);
        await this.putRecord({ ...next, state: 'ready' }, request, invocation); operation = await this.phase(operation, 'ready', request, invocation);
        this.progress(invocation, progressOperation, 'ready');
        if (request.firstPrompt === undefined) this.dependencies.onNamingEligible?.(result.agent);
        return this.operationResult(operation);
      } catch (error) { await this.journalFailure(operation.id, error, effects); throw error; }
    });
  }
  private async start(request: WorktreeRequest, invocation: Invocation, record: WorktreeRecord): Promise<SessionResult> {
    const source = this.bootstrap.actor(request.sourceSessionId ?? invocation.agent.id);
    const settings = await this.bootstrap.settings(source, invocation.signal);
    const project = this.dependencies.projects?.selectionForWorktree(record.id) ?? this.projectSelection(resolve(record.repoRoot, record.projectSubdir));
    let operation = this.newOperation(randomUUID(), 'create', hashValue({ request, actor: invocation.agent.id }), invocation.agent, record, source, settings, request.sessionMode ?? 'new');
    try {
      await this.putOperation(operation, request, invocation); this.assertProject(project); await this.sameSettings(source, settings, request, invocation);
      await this.bootstrap.create({ cwd: record.effectiveCwd, title: record.displayName ?? `${basename(record.repoRoot)} · ${record.remoteBranch}`, source, settings, mode: operation.sessionMode, signal: invocation.signal,
        onCreated: async identity => {
          operation = await this.receipt(operation, 'session-created', { sessionId: identity.sessionId, workspaceId: identity.workspaceId });
          await this.store.worktrees.put(record.id, { ...record, sessionIds: [...record.sessionIds, identity.sessionId], workspaceId: identity.workspaceId });
          await this.bindThread(identity.sessionId, record.effectiveCwd, project, record.id);
        },
      });
      await this.sameSettings(source, settings, request, invocation); operation = await this.phase(operation, 'ready', request, invocation); return this.operationResult(operation);
    } catch (error) { await this.journalFailure(operation.id, error, true); throw error; }
  }
  private async candidates(roots: readonly string[], signal: AbortSignal): Promise<Agent[]> {
    const agents = required<AgentsCapability>(this.owner, 'agents').list();
    const candidates: Agent[] = [];
    for (const agent of agents) {
      abortIfRequested(signal);
      const cwd = agent.session.header.cwd; if (cwd === undefined) continue;
      let canonical: string;
      try { canonical = await realpath(cwd); } catch { throw new WorktreeError('BUSY_UNKNOWN', 'A live session working directory could not be inspected safely.'); }
      if (roots.some(root => contained(root, canonical))) candidates.push(agent);
    }
    return candidates.sort((a, b) => a.id.localeCompare(b.id));
  }
  private checkIdle(agents: readonly Agent[], invocation: Invocation): void {
    for (const agent of agents) {
      if (!this.bootstrap.isLive(agent) || agent.status !== 'idle' || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) throw new WorktreeError('BUSY', 'A known source or target session has active or pending work. Finish it before handoff; the invoking tool never waits for its own turn.');
      try {
        if (capability<JobsCapability>(this.owner, 'jobs')?.list(agent.id).some(job => job.status === 'running' || job.status === 'stopping')) throw new WorktreeError('BUSY', 'Known background jobs are still running or stopping.');
        if (capability<TerminalsCapability>(this.owner, 'terminals')?.hasOwnerActivity(agent)) throw new WorktreeError('BUSY', 'A known terminal still owns activity in the checkout.');
        if (capability<TerminalControllerCapability>(this.owner, 'terminalController')?.list(agent.id).some(terminal => terminal.state === 'running')) throw new WorktreeError('BUSY', 'A known user terminal is running in the checkout.');
      } catch (error) { if (error instanceof WorktreeError) throw error; throw new WorktreeError('BUSY_UNKNOWN', 'Background activity diagnostics could not be read.'); }
    }
    // Unowned jobs cannot be associated reliably with any checkout; conservatively deny.
    try { if (capability<JobsCapability>(this.owner, 'jobs')?.list().some(job => job.status === 'running' || job.status === 'stopping')) throw new WorktreeError('BUSY', 'An unowned background job is still running or stopping.'); }
    catch (error) { if (error instanceof WorktreeError) throw error; throw new WorktreeError('BUSY_UNKNOWN', 'Unowned job diagnostics could not be read.'); }
    abortIfRequested(invocation.signal);
  }
  private async checkClaimed(roots: readonly string[], claimed: readonly Agent[], invocation: Invocation): Promise<void> {
    const current = await this.candidates(roots, invocation.signal);
    if (current.length !== claimed.length || current.some(agent => !claimed.includes(agent))) throw new WorktreeError('BUSY', 'The known source or target session set changed while acquiring maintenance claims. Retry with a new preview.');
    this.checkIdle(current, invocation);
  }
  private async claims<T>(agents: readonly Agent[], invocation: Invocation, task: (signal: AbortSignal) => Promise<T>, index = 0, signals: AbortSignal[] = []): Promise<T> {
    const agent = agents[index];
    if (agent === undefined) return task(AbortSignal.any([invocation.signal, ...signals]));
    this.checkIdle([agent], invocation);
    let claim: Promise<T>;
    try { claim = agent.runMaintenance(signal => this.claims(agents, invocation, task, index + 1, [...signals, signal])); }
    catch { throw new WorktreeError('BUSY', 'An idle maintenance claim could not be acquired. Finish active work before retrying.'); }
    return claim;
  }
  private async sourceIn(record: WorktreeRecord, requested: string | undefined, actor: Agent, signal: AbortSignal): Promise<Agent> {
    let source: Agent;
    if (requested !== undefined) source = this.bootstrap.actor(requested);
    else {
      const cwd = actor.session.header.cwd;
      const actorInCheckout = cwd !== undefined && contained(record.checkoutRoot, await realpath(cwd));
      source = actorInCheckout ? actor : this.bootstrap.actor(requiredText(record.sessionIds[0], 'primary worktree session'));
    }
    const cwd = await this.local(source, undefined, signal);
    if (!contained(record.checkoutRoot, cwd)) throw new WorktreeError('SOURCE_OUTSIDE_WORKTREE', 'The source session must execute inside this validated worktree.');
    return source;
  }
  private async preview(request: WorktreeRequest, invocation: Invocation, git: GitApi, record: WorktreeRecord): Promise<WorktreePreview> {
    const source = await this.sourceIn(record, request.sourceSessionId, invocation.agent, invocation.signal);
    const originalFolder = this.dependencies.projects?.selectionForWorktree(record.id)?.path;
    const targetPath = await this.local(invocation.agent, request.targetPath ?? originalFolder ?? record.repoRoot, invocation.signal);
    const target = await git.discover(targetPath, invocation.signal);
    if (target.commonDir !== record.commonDir || target.root === record.checkoutRoot || this.records().some(item => item.checkoutRoot === target.root)) throw new WorktreeError('INVALID_TARGET', 'Choose a Local checkout of this repository, not a managed worktree.');
    const roots = [record.checkoutRoot, target.root]; const agents = await this.candidates(roots, invocation.signal);
    this.checkIdle(agents, invocation);
    return this.claims(agents, invocation, async signal => {
      const scoped = { ...invocation, signal }; this.guard(request, scoped);
      await this.checkClaimed(roots, agents, scoped);
      const snapshotRoot = resolve(await canonicalFuture(resolve(this.config.root)), '.snapshots');
      if (roots.some(root => contained(root, snapshotRoot))) throw new WorktreeError('UNSAFE_ROOT', 'Private snapshots must remain outside both checkouts.');
      this.guard(request, scoped); await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
      if (await realpath(snapshotRoot) !== snapshotRoot) throw new WorktreeError('PATH_CHANGED', 'The snapshot directory ancestry changed.');
      this.guard(request, scoped);
      const preview = await git.snapshot({ worktreeId: record.id, sourceSessionId: source.id, repositoryRoot: record.repoRoot, checkoutRoot: record.checkoutRoot, targetRoot: target.root, baseOid: record.baseOid, snapshotRoot, signal });
      if (this.previews.size >= 128) this.previews.delete(this.previews.keys().next().value ?? '');
      this.previews.set(preview.id, clone(preview)); return clone(preview);
    });
  }
  private previewById(id: string | undefined): WorktreePreview {
    const preview = this.previews.get(requiredText(id, 'previewId'));
    if (preview === undefined) throw new WorktreeError('PREVIEW_EXPIRED', 'The preview expired or belongs to an earlier plugin lifetime. Generate a fresh preview.');
    return clone(preview);
  }
  private async exportPatch(request: WorktreeRequest, invocation: Invocation): Promise<unknown> {
    const preview = this.previewById(request.previewId); this.guard(request, invocation);
    const root = await realpath(resolve(this.config.root, '.snapshots')); const path = await realpath(preview.patchPath);
    const info = await stat(path);
    if (!contained(root, path) || !info.isFile()) throw new WorktreeError('INVALID_PATCH', 'The patch is not an existing plugin-owned snapshot file.');
    if (info.size !== preview.bytes || info.size > this.config.maxSnapshotBytes) throw new WorktreeError('PATCH_CHANGED', 'The exported patch exceeds its immutable preview size or configured bound.');
    this.guard(request, invocation);
    const bytes = await readFile(path);
    if (bytes.length !== preview.bytes || createHash('sha256').update(bytes).digest('hex') !== preview.patchHash) throw new WorktreeError('PATCH_CHANGED', 'The exported patch no longer matches its immutable preview.');
    return { path, bytes: preview.bytes, patchHash: preview.patchHash, ...(bytes.length <= 65536 ? { patch: bytes.toString('utf8') } : {}) };
  }
  private async handoff(request: WorktreeRequest, invocation: Invocation, git: GitApi): Promise<SessionResult> {
    const id = requiredText(request.operationId, 'operationId'); const requestHash = hashValue({ request, actor: invocation.agent.id });
    const existing = this.store.operations.get(id);
    if (existing !== undefined && (existing.kind !== 'handoff' || existing.actorId !== invocation.agent.id || existing.requestHash !== requestHash)) throw new WorktreeError('OPERATION_REUSED', 'The operation id is already bound to another request or caller.');
    if (existing?.phase === 'ready') return this.operationResult(existing);
    if (existing !== undefined && existing.phase !== 'code-applied') throw new WorktreeError('RECOVERY_REQUIRED', 'The application result is uncertain. Inspect actual checkout state; the patch is never automatically repeated.');
    const record = this.record(request.id); this.usable(record, false);
    const preview = existing === undefined ? this.previewById(request.previewId) : undefined;
    if (preview !== undefined && preview.worktreeId !== record.id) throw new WorktreeError('PREVIEW_MISMATCH', 'This preview belongs to another worktree.');
    const source = await this.sourceIn(record, existing?.sourceSessionId ?? preview?.sourceSessionId, invocation.agent, invocation.signal);
    const settings = existing?.settings ?? await this.bootstrap.settings(source, invocation.signal);
    const targetRoot = existing?.targetRoot ?? preview?.targetRoot;
    if (targetRoot === undefined || targetRoot === null) throw new WorktreeError('RECOVERY_REQUIRED', 'The durable target checkout identity is unavailable.');
    const target = await git.discover(await this.local(invocation.agent, targetRoot, invocation.signal), invocation.signal);
    if (target.root !== targetRoot || target.commonDir !== record.commonDir) throw new WorktreeError('INVALID_TARGET', 'The target checkout identity changed.');
    const targetWorktree = this.records().find(item => item.checkoutRoot === targetRoot);
    if (targetWorktree !== undefined && existing === undefined) throw new WorktreeError('INVALID_TARGET', 'Choose a Local checkout rather than another managed worktree.');
    return this.queued(record.commonDir, invocation.signal, async () => {
      this.guard(request, invocation); this.statuses.set(record.id, await git.verify(record, invocation.signal));
      const roots = [record.checkoutRoot, targetRoot]; const agents = await this.candidates(roots, invocation.signal); this.checkIdle(agents, invocation);
      return this.claims(agents, invocation, async signal => {
        const scoped = { ...invocation, signal }; this.guard(request, scoped); await this.checkClaimed(roots, agents, scoped);
        await this.sameSettings(source, settings, request, scoped);
        const cwd = await realpath(resolve(targetRoot, record.projectSubdir));
        if (!contained(targetRoot, cwd) || !(await stat(cwd)).isDirectory()) throw new WorktreeError('MISSING_PROJECT_DIRECTORY', 'The target project directory is missing or escapes the target checkout.');
        const targetProject = this.dependencies.projects === undefined ? undefined : targetWorktree === undefined
          ? await this.dependencies.projects.ensureFolder(cwd, signal)
          : this.dependencies.projects.selectionForWorktree(targetWorktree.id);
        this.assertProject(targetProject); this.guard(request, scoped);
        let operation = existing ?? this.newOperation(id, 'handoff', requestHash, invocation.agent, record, source, settings, 'continue', targetRoot, preview?.id ?? null);
        try {
          if (existing === undefined) {
            if (preview === undefined) throw new WorktreeError('PREVIEW_EXPIRED', 'Generate a new preview.');
            await this.putOperation(operation, request, scoped); operation = await this.phase(operation, 'applying', request, scoped);
            this.guard(request, scoped); await this.checkClaimed(roots, agents, scoped);
            const applied = await git.apply(preview, record, signal);
            operation = await this.receipt(operation, 'code-applied', { appliedHead: applied.head });
            const appliedFingerprint = await git.fingerprint(targetRoot, signal);
            operation = await this.receipt(operation, 'code-applied', { appliedFingerprint });
          } else {
            const state = await git.status(targetRoot, signal);
            const fingerprint = await git.fingerprint(targetRoot, signal);
            if (state.head !== operation.appliedHead || fingerprint !== operation.appliedFingerprint) throw new WorktreeError('RECOVERY_REQUIRED', 'The target checkout changed after application. Inspect actual state before creating the continuation.');
          }
          if (await realpath(resolve(targetRoot, record.projectSubdir)) !== cwd || !(await stat(cwd)).isDirectory()) throw new WorktreeError('MISSING_PROJECT_DIRECTORY', 'The Local project directory changed during application.');
          this.assertProject(targetProject); this.guard(request, scoped); await this.sameSettings(source, settings, request, scoped);
          await this.bootstrap.create({ cwd, title: `${basename(record.repoRoot)} · local continuation`, source, settings, mode: 'continue', signal,
            onCreated: async identity => {
              operation = await this.receipt(operation, 'session-created', { sessionId: identity.sessionId, workspaceId: identity.workspaceId });
              // Normal handoff is Local. Older already-applied receipts targeting
              // a managed checkout retain truthful target backing during recovery.
              await this.bindThread(identity.sessionId, cwd, targetProject, targetWorktree?.id);
            },
          });
          await this.sameSettings(source, settings, request, scoped); operation = await this.phase(operation, 'ready', request, scoped);
          return this.operationResult(operation);
        } catch (error) { await this.journalFailure(operation.id, error, true); throw error; }
      });
    });
  }
}
