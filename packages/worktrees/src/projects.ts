import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { abortIfRequested, WorktreeError } from './errors.js';
import { localProjectPath, planBlocksMutation, policyOf, required } from './runtime.js';
import { SessionBootstrap } from './sessions.js';
import { projectBindingSchema, projectRecordSchema, type ProjectStartRecord, type ProjectStore } from './project-store.js';
import type { WorktreeRecord } from './types.js';

export interface ProjectFolder { id: string; path: string; title: string }
export interface ProjectRecord { id: string; title: string; folders: ProjectFolder[]; mainFolderId?: string; createdAt: number; updatedAt: number; imported?: boolean }
/** Legacy records select their first folder; an explicit main ID must name a member. */
export function resolveMainFolder(project: Pick<ProjectRecord, 'folders' | 'mainFolderId'>): ProjectFolder {
  const folder = project.mainFolderId === undefined ? project.folders[0] : project.folders.find(value => value.id === project.mainFolderId);
  if (folder === undefined) throw new WorktreeError('PROJECT_FOLDER_NOT_FOUND', 'The project main folder is not registered.');
  return folder;
}
export interface ProjectThreadBinding { sessionId: string; projectId: string; folderId: string; mode: 'local' | 'worktree'; effectiveCwd: string; worktreeId?: string }
export interface ProjectSnapshot { projects: ProjectRecord[]; bindings: ProjectThreadBinding[]; records?: WorktreeRecord[] }
export type ProjectRequest =
  | { action: 'list'; projectId?: string }
  | { action: 'create'; id: string; title: string; folders: string[]; mainFolder?: string }
  | { action: 'update'; projectId: string; title?: string; folders?: string[]; mainFolder?: string }
  | { action: 'remove'; projectId: string }
  | { action: 'bind'; projectId: string; folderId: string; sessionId: string }
  | { action: 'start'; operationId: string; projectId: string; folderId?: string };
export interface ProjectInvocation { agent?: Agent; origin: 'ui' | 'tool' | 'command'; signal: AbortSignal }
export interface ProjectRemoveResult { removed: true; projectId: string; scope: 'project-metadata' }
export interface ProjectStartResult { sessionId: string; workspaceId: string; binding: ProjectThreadBinding }
export interface ProjectWorktreeSource { records(): WorktreeRecord[] }
type BootstrapApi = Pick<SessionBootstrap, 'actor' | 'isLive' | 'settings' | 'create' | 'close'>;
export interface ProjectDependencies { bootstrap?: BootstrapApi; localPath?: typeof localProjectPath; operationTimeoutMs?: number }
interface NativeWorkspace { id: string; path: string; title: string; sessionIds: readonly string[]; attachSession(id: SessionId): Promise<void> }
interface Registry { list(): NativeWorkspace[]; create(path: string, title?: string): Promise<NativeWorkspace> }
interface SessionHeader { id: string; cwd?: string; origin?: string; isSeeded?: boolean }
interface Query {
  listSessions(signal?: AbortSignal): Promise<{ header: SessionHeader }[]>;
  observeSession(id: SessionId, options: { signal?: AbortSignal; projectionMode: 'none' }): Promise<{ header: SessionHeader; events: readonly { type: string }[]; [Symbol.dispose](): void }>;
}
interface Sessions {
  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader }>;
  create(input: { workspaceId: string; cwd: string; sessionId: SessionId }): Promise<{ sessionId: string }>;
}
const clone = <T>(value: T): T => structuredClone(value);
const text = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u);
const pathSchema = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value));
const titleSchema = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u);
const foldersSchema = z.array(pathSchema).min(1).max(32);
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), projectId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal('create'), id: z.string().uuid(), title: titleSchema, folders: foldersSchema, mainFolder: pathSchema.optional() }).strict(),
  z.object({ action: z.literal('update'), projectId: z.string().uuid(), title: titleSchema.optional(), folders: foldersSchema.optional(), mainFolder: pathSchema.optional() }).strict().refine(value => value.title !== undefined || value.folders !== undefined || value.mainFolder !== undefined),
  z.object({ action: z.literal('remove'), projectId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('bind'), projectId: z.string().uuid(), folderId: text, sessionId: text }).strict(),
  z.object({ action: z.literal('start'), operationId: z.string().uuid(), projectId: z.string().uuid(), folderId: text.optional() }).strict(),
]);

/** Lossless, bounded plain JSON validation shared by the tool parser and quiet RPC. */
export function projectJsonSnapshot(value: unknown, code = 'INVALID_REQUEST'): unknown {
  const limit = 1048576; let bytes = 0; let nodes = 0; const seen = new Set<object>();
  const invalid = (): never => { throw new WorktreeError(code, 'Bounded, lossless plain JSON is required.'); };
  const charge = (count: number) => { if ((bytes += count) > limit) invalid(); };
  const visit = (input: unknown, depth: number): void => {
    if (++nodes > 65536 || depth > 16) invalid();
    if (input === null || typeof input === 'boolean') { charge(input === false ? 5 : 4); return; }
    if (typeof input === 'string') { if (Buffer.byteLength(input) > limit) invalid(); charge(Buffer.byteLength(JSON.stringify(input))); return; }
    if (typeof input === 'number') { if (!Number.isFinite(input) || Object.is(input, -0) || (Number.isInteger(input) && !Number.isSafeInteger(input))) invalid(); charge(String(input).length); return; }
    if (typeof input !== 'object' || input === null || seen.has(input)) invalid();
    const object = input as object; const array = Array.isArray(object); const prototype: unknown = Object.getPrototypeOf(object);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    seen.add(object); charge(2); const keys = Reflect.ownKeys(object); if (keys.length > 65536) invalid(); let elements = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') invalid(); const name = key as string;
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) invalid();
      if (array && name !== String(elements)) invalid(); if (elements++ > 0) charge(1);
      if (!array) charge(Buffer.byteLength(JSON.stringify(name)) + 1); visit(descriptor!.value, depth + 1);
    }
    if (array && elements !== (object as unknown[]).length) invalid(); seen.delete(object);
  };
  visit(value, 0); return JSON.parse(JSON.stringify(value)) as unknown;
}
export function parseProjectRequest(input: unknown): ProjectRequest {
  const parsed = requestSchema.safeParse(projectJsonSnapshot(input));
  if (!parsed.success) throw new WorktreeError('INVALID_REQUEST', 'Invalid project action or fields. Use absolute existing folder paths.');
  return parsed.data;
}
const uuidParameter = { type: 'string', format: 'uuid' };
const idParameter = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
const folderParameter = { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute path to an existing local directory. Canonical duplicates are rejected.' } };
const titleParameter = { type: 'string', minLength: 1, maxLength: 120 };
const mainFolderParameter = { type: 'string', minLength: 1, maxLength: 4096 };
const variant = (action: string, properties: Record<string, unknown>, requiredFields: string[]) => ({ type: 'object', additionalProperties: false, properties: { action: { const: action, type: 'string' }, ...properties }, required: ['action', ...requiredFields] });
/** Plain JSON schema, not a Zod object. Folder updates replace the complete folder array. */
export const parameterSchema: Record<string, unknown> = { type: 'object', oneOf: [
  variant('list', { projectId: uuidParameter }, []), variant('create', { id: uuidParameter, title: titleParameter, folders: folderParameter, mainFolder: { ...mainFolderParameter, description: 'Absolute existing source directory in folders (canonical match); omitted uses the first folder.' } }, ['id', 'title', 'folders']),
  { ...variant('update', { projectId: uuidParameter, title: titleParameter, folders: folderParameter, mainFolder: { ...mainFolderParameter, description: 'Absolute existing source directory in resulting folders (canonical match). Omitted retains the main, or uses the sole remaining folder; supply a replacement to remove the main when multiple folders remain.' } }, ['projectId']), anyOf: [{ required: ['title'] }, { required: ['folders'] }, { required: ['mainFolder'] }] },
  variant('remove', { projectId: { ...uuidParameter, description: 'Remove only project metadata and membership. Folders, files, conversations and worktrees remain; use a fresh UUID to re-add.' } }, ['projectId']),
  variant('bind', { projectId: uuidParameter, folderId: idParameter, sessionId: idParameter }, ['projectId', 'folderId', 'sessionId']),
  variant('start', { operationId: uuidParameter, projectId: uuidParameter, folderId: { ...idParameter, description: 'Override the main folder for this new start. Omitted uses the main; replay reuses the original receipt folder and session.' } }, ['operationId', 'projectId']),
] };
export const projectParameterSchema = parameterSchema;
function contained(root: string, path: string): boolean { const part = relative(root, path); return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)); }

/** Durable project membership never changes native workspace paths, session cwd, files or history. */
export class ProjectController {
  private readonly bootstrap: BootstrapApi;
  private readonly shutdown = new AbortController();
  private readonly flights = new Set<Promise<unknown>>();
  private readonly headers = new Map<string, SessionHeader>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly owner: Context, private readonly store: ProjectStore, private readonly worktrees: ProjectWorktreeSource, private readonly dependencies: ProjectDependencies = {}) { this.bootstrap = dependencies.bootstrap ?? new SessionBootstrap(owner); }
  records(): ProjectRecord[] { return [...this.store.projects.entries()].filter(([id]) => this.store.removals.get(id) === undefined).map(([, record]) => clone(record)); }
  /** Internal read-only selection from a known managed row, never from a fabricated session ID. */
  selectionForWorktree(worktreeId: string): { projectId: string; folderId: string; path: string } | undefined {
    const records = this.worktrees.records(); const record = records.find(value => value.id === worktreeId);
    return record === undefined ? undefined : this.worktreeFolder(record, records);
  }
  resolveFolder(projectId: string, folderId?: string): ProjectFolder {
    const project = this.store.removals.get(projectId) === undefined ? this.store.projects.get(projectId) : undefined;
    const folder = project === undefined ? undefined : folderId === undefined ? resolveMainFolder(project) : project.folders.find(value => value.id === folderId);
    if (folder === undefined) throw new WorktreeError('PROJECT_FOLDER_NOT_FOUND', 'The selected project folder is not registered.');
    return clone(folder);
  }
  private startFolder(request: Extract<ProjectRequest, { action: 'start' }>): ProjectFolder {
    const receipt = this.store.starts.get(request.operationId);
    // A default replay is pinned to its receipt, never to a subsequently changed main.
    const folderId = request.folderId ?? (receipt?.projectId === request.projectId ? receipt.folderId : undefined);
    return this.resolveFolder(request.projectId, folderId);
  }
  folderForPath(path: string): { projectId: string; folderId: string; path: string } | undefined {
    for (const record of this.records()) { const folder = record.folders.find(value => value.path === path); if (folder !== undefined) return { projectId: record.id, folderId: folder.id, path: folder.path }; }
    return undefined;
  }
  bindingFor(sessionId: string, cwd?: string): ProjectThreadBinding | undefined {
    const header = this.headers.get(sessionId); if (header?.origin === 'subagent') return undefined;
    const path = cwd ?? header?.cwd;
    // A known or supplied cwd always wins over an old receipt, especially a Local handoff.
    if (path !== undefined) return this.infer(sessionId, path);
    const receipt = this.store.bindings.get(sessionId);
    return receipt === undefined ? undefined : this.infer(sessionId, receipt.effectiveCwd);
  }
  execute(request: ProjectRequest, invocation: ProjectInvocation): Promise<unknown> {
    const signal = AbortSignal.any([invocation.signal, this.shutdown.signal, AbortSignal.timeout(this.dependencies.operationTimeoutMs ?? 120000)]);
    const input = { ...invocation, signal };
    return this.serial(async () => {
      const parsed = parseProjectRequest(request);
      const startFolder = this.guard(parsed, input);
      if (parsed.action === 'remove') return this.removeProject(parsed, input);
      await this.synchronizeNow(signal); this.guard(parsed, input, startFolder);
      if (parsed.action === 'list') return this.snapshot(parsed.projectId);
      if (parsed.action === 'create' || parsed.action === 'update') return this.changeProject(parsed, input);
      if (parsed.action === 'bind') {
        const folder = this.resolveFolder(parsed.projectId, parsed.folderId); const header = await this.inspect(parsed.sessionId, signal);
        const binding = header.cwd === undefined || header.origin === 'subagent' ? undefined : this.infer(parsed.sessionId, header.cwd);
        if (binding === undefined || binding.projectId !== parsed.projectId || binding.folderId !== folder.id) throw new WorktreeError('PROJECT_BINDING_MISMATCH', 'The ordinary session cwd does not belong to this exact project folder.');
        this.guard(parsed, input); await this.store.bindings.put(binding.sessionId, binding); return { binding: clone(binding) };
      }
      return this.start(parsed, input, startFolder!);
    });
  }
  synchronize(): Promise<void> { return this.serial(() => this.synchronizeNow(this.shutdown.signal)); }
  /** Internal metadata-only import after admission; removed sources remain independent of projects. */
  ensureFolder(path: string, signal?: AbortSignal): Promise<{ projectId: string; folderId: string; path: string } | undefined> {
    return this.serial(async () => {
      const lifetime = signal === undefined ? this.shutdown.signal : AbortSignal.any([signal, this.shutdown.signal]);
      abortIfRequested(lifetime);
      if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw new WorktreeError('INVALID_PROJECT_PATH', 'An absolute existing source folder is required.');
      const canonical = (await this.canonicalFolders([path]))[0]!;
      const existing = this.folderForPath(canonical); if (existing !== undefined) return existing;
      abortIfRequested(lifetime); const registry = required<Registry>(this.owner, 'workspaceRegistry');
      if (this.suppressedFolder(canonical, registry.list().find(workspace => workspace.path === canonical)?.id)) return undefined;
      await registry.create(canonical);
      await this.synchronizeNow(lifetime);
      const imported = this.folderForPath(canonical);
      if (imported === undefined) throw new WorktreeError('PROJECT_FOLDER_NOT_FOUND', 'The source folder could not be imported.');
      return imported;
    });
  }
  recordThread(binding: ProjectThreadBinding): Promise<void> {
    return this.serial(async () => {
      const parsed = projectBindingSchema.safeParse(projectJsonSnapshot(binding));
      if (!parsed.success) throw new WorktreeError('PROJECT_BINDING_MISMATCH', 'Invalid internal thread receipt.');
      const header = await this.inspect(binding.sessionId);
      const actual = header.origin === 'subagent' || header.cwd === undefined ? undefined : this.infer(binding.sessionId, header.cwd);
      if (actual === undefined || actual.sessionId !== parsed.data.sessionId || actual.projectId !== parsed.data.projectId || actual.folderId !== parsed.data.folderId || actual.mode !== parsed.data.mode || actual.effectiveCwd !== parsed.data.effectiveCwd || actual.worktreeId !== parsed.data.worktreeId) throw new WorktreeError('PROJECT_BINDING_MISMATCH', 'The receipt does not match the exact ordinary session cwd and backing checkout.');
      await this.store.bindings.put(actual.sessionId, clone(actual));
    });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => { this.closed = true; this.shutdown.abort(); await Promise.allSettled([...this.flights]); await this.bootstrap.close(); this.headers.clear(); })();
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WorktreeError('CLOSED', 'The project controller is closing.'));
    const task = this.queue.then(operation); this.queue = task.catch(() => undefined); this.flights.add(task);
    void task.then(() => this.flights.delete(task), () => this.flights.delete(task)); return task;
  }
  private guard(request: ProjectRequest, invocation: ProjectInvocation, startFolder?: ProjectFolder): ProjectFolder | undefined {
    abortIfRequested(invocation.signal);
    const agent = invocation.agent;
    if (agent === undefined) {
      if (invocation.origin !== 'ui' || request.action === 'bind') throw new WorktreeError('NO_CALLER', 'A genuine invoking ordinary session is required.');
      return request.action === 'start' ? startFolder ?? this.startFolder(request) : undefined;
    }
    if (!this.bootstrap.isLive(agent) || this.bootstrap.actor(agent.id) !== agent) throw new WorktreeError('SESSION_CHANGED', 'The invoking session is no longer the exact ordinary live session.');
    if (invocation.origin === 'tool' && request.action !== 'list' && planBlocksMutation(agent)) throw new WorktreeError('PLAN_MODE', 'Project mutations are unavailable while plan mode is active or pending enabled.');
    if (request.action === 'start') {
      const folder = startFolder ?? this.startFolder(request); const policy = policyOf(agent);
      if (!isAbsolute(policy.workspaceRoot) || (!contained(policy.workspaceRoot, folder.path) && policy.mode !== 'danger-full-access')) throw new WorktreeError('FULL_ACCESS_REQUIRED', 'Starting a conversation outside the caller workspace requires existing full access; metadata never grants permissions.');
      return folder;
    }
    return undefined;
  }
  private infer(sessionId: string, cwd: string): ProjectThreadBinding | undefined {
    const local = this.folderForPath(cwd);
    if (local !== undefined) return { sessionId, projectId: local.projectId, folderId: local.folderId, mode: 'local', effectiveCwd: cwd };
    const records = this.worktrees.records();
    for (const record of records) {
      if (record.effectiveCwd !== cwd) continue;
      const source = this.worktreeFolder(record, records);
      if (source !== undefined) return { sessionId, projectId: source.projectId, folderId: source.folderId, mode: 'worktree', effectiveCwd: cwd, worktreeId: record.id };
    }
    return undefined;
  }
  private worktreeFolder(record: WorktreeRecord, records: readonly WorktreeRecord[]): { projectId: string; folderId: string; path: string } | undefined {
    const hint = (row: WorktreeRecord): { projectId: string; folderId: string; path: string } | undefined => {
      const ownership = row as WorktreeRecord & { projectId?: string; folderId?: string };
      if (ownership.folderId === undefined) return undefined;
      const projects = this.records();
      const exact = projects.find(project => project.id === ownership.projectId)?.folders.find(folder => folder.id === ownership.folderId);
      if (exact !== undefined) return { projectId: ownership.projectId!, folderId: exact.id, path: exact.path };
      // Imported-project adoption keeps the native folder ID stable while replacing its logical owner.
      for (const project of projects) {
        const folder = project.folders.find(value => value.id === ownership.folderId);
        if (folder !== undefined) return { projectId: project.id, folderId: folder.id, path: folder.path };
      }
      return undefined;
    };
    const captured = hint(record); if (captured !== undefined) return captured;
    let root = record.repoRoot; let sourcePath = resolve(root, record.projectSubdir);
    const seen = new Set([record.id]);
    // Older rows can point to another managed checkout as their Git source. Map only known,
    // unambiguous roots of the same repository; no filesystem/Git lookup occurs on a context read.
    for (let depth = 0; depth < 64; depth++) {
      const source = this.folderForPath(sourcePath); if (source !== undefined) return source;
      if (typeof record.commonDir !== 'string' || record.commonDir.length === 0 || !contained(root, sourcePath)) return undefined;
      const parents = records.filter(row => row.checkoutRoot === root && row.commonDir === record.commonDir);
      if (parents.length !== 1) return undefined;
      const parent = parents[0]!; if (seen.has(parent.id)) return undefined; seen.add(parent.id);
      // A parent ownership hint applies only to its exact selected project subdirectory.
      if (sourcePath === parent.effectiveCwd) { const inherited = hint(parent); if (inherited !== undefined) return inherited; }
      const subdir = relative(parent.checkoutRoot, sourcePath);
      root = parent.repoRoot; sourcePath = resolve(root, subdir);
    }
    return undefined;
  }
  private async inspect(id: string, signal?: AbortSignal, requireBlank = false): Promise<SessionHeader> {
    const observation = await required<Query>(this.owner, 'sessionQuery').observeSession(SessionId(id), { signal, projectionMode: 'none' });
    let header: SessionHeader;
    try {
      if (observation.header.id !== id) throw new WorktreeError('SESSION_CHANGED', 'The inspected session identity changed.');
      if (requireBlank && (observation.header.isSeeded === true || observation.events.some(event => event.type === 'turn/start' || event.type === 'user/message'))) throw new WorktreeError('SESSION_NOT_BLANK', 'The requested new thread already has conversation history; this start will not adopt or duplicate it.');
      header = clone(observation.header);
    } finally { observation[Symbol.dispose](); }
    if (header.cwd !== undefined) {
      const native = required<Registry>(this.owner, 'workspaceRegistry').list().find(workspace => workspace.sessionIds.includes(id));
      if (native !== undefined) header.cwd = native.path;
      else { try { header.cwd = await realpath(header.cwd); } catch { /* Missing execution directories cannot invent another membership. */ } }
    }
    this.headers.set(id, header); return header;
  }
  private snapshot(projectId?: string): ProjectSnapshot {
    const projects = this.records().filter(record => projectId === undefined || record.id === projectId); const bindings: ProjectThreadBinding[] = [];
    for (const [id] of this.store.bindings.entries()) { const binding = this.bindingFor(id); if (binding !== undefined && (projectId === undefined || binding.projectId === projectId)) bindings.push(binding); }
    const allRecords = this.worktrees.records();
    const records = allRecords.filter(record => projectId === undefined || this.worktreeFolder(record, allRecords)?.projectId === projectId);
    return projectJsonSnapshot({ projects, bindings, records }, 'RESPONSE_LIMIT') as ProjectSnapshot;
  }
  private async synchronizeNow(signal?: AbortSignal): Promise<void> {
    abortIfRequested(signal); const registry = required<Registry>(this.owner, 'workspaceRegistry');
    // Receipt-first removal repair must precede adoption, imports and binding inference.
    for (const [id] of this.store.removals.entries()) { abortIfRequested(signal); await this.finishRemoval(id); }
    const worktrees = this.worktrees.records();
    // Repair interrupted imported-folder adoption. Custom projects are the only permitted winners.
    const customs = this.records().filter(record => record.imported !== true);
    for (const imported of this.records().filter(record => record.imported === true)) {
      const retained = imported.folders.filter(folder => !customs.some(project => project.folders.some(value => value.path === folder.path)));
      if (retained.length === imported.folders.length) continue;
      if (retained.length === 0) await this.store.projects.delete(imported.id);
      else await this.store.projects.put(imported.id, { ...imported, folders: retained, mainFolderId: retained.find(folder => folder.id === imported.mainFolderId)?.id ?? retained[0]!.id, updatedAt: Date.now() });
    }
    // Additive v1 repair: metadata only, with stable folder ordering and no session changes.
    for (const project of this.records()) {
      abortIfRequested(signal);
      if (project.mainFolderId === undefined) await this.store.projects.put(project.id, { ...project, mainFolderId: resolveMainFolder(project).id });
    }
    for (const workspace of registry.list()) {
      abortIfRequested(signal);
      if (this.folderForPath(workspace.path) !== undefined || this.suppressedFolder(workspace.path, workspace.id) || worktrees.some(record => contained(record.checkoutRoot, workspace.path))) continue;
      const now = Date.now(); const project: ProjectRecord = { id: randomUUID(), title: workspace.title.trim().slice(0, 120) || basename(workspace.path) || 'Project', folders: [{ id: workspace.id, path: workspace.path, title: workspace.title }], mainFolderId: workspace.id, createdAt: now, updatedAt: now, imported: true };
      await this.store.projects.put(project.id, project);
    }
    const nativePaths = new Map(registry.list().flatMap(workspace => workspace.sessionIds.map(id => [id, workspace.path] as const)));
    const sessions = await required<Query>(this.owner, 'sessionQuery').listSessions(signal);
    abortIfRequested(signal); this.headers.clear();
    for (const { header: sourceHeader } of sessions) {
      const header = clone(sourceHeader); const indexedCwd = nativePaths.get(header.id);
      if (header.cwd !== undefined && indexedCwd !== undefined) header.cwd = indexedCwd;
      this.headers.set(header.id, header);
      const binding = header.origin === 'subagent' || header.cwd === undefined ? undefined : this.infer(header.id, header.cwd);
      const stored = this.store.bindings.get(header.id);
      if (binding === undefined) { if (stored !== undefined) await this.store.bindings.delete(header.id); }
      else if (JSON.stringify(stored) !== JSON.stringify(binding)) await this.store.bindings.put(header.id, binding);
    }
    // The registry's exact canonical-cwd index is authoritative even for old cold sessions.
    for (const [id, path] of nativePaths) {
      if (this.headers.get(id)?.origin === 'subagent') continue;
      const header = this.headers.get(id); this.headers.set(id, { ...header, id, cwd: path });
      const binding = this.bindingFor(id, path);
      if (binding !== undefined && JSON.stringify(this.store.bindings.get(id)) !== JSON.stringify(binding)) await this.store.bindings.put(id, binding);
    }
    for (const [id] of this.store.bindings.entries()) if (!this.headers.has(id)) await this.store.bindings.delete(id);
  }
  private suppressedFolder(path: string, folderId?: string): boolean {
    return [...this.store.removals.entries()].some(([, receipt]) => receipt.folders.some(folder => folder.path === path || folder.id === folderId));
  }
  /** Cleanup is metadata-only and may finish after cancellation once the receipt commits. */
  private async finishRemoval(projectId: string): Promise<void> {
    await this.store.projects.delete(projectId);
    for (const [id, binding] of this.store.bindings.entries()) if (binding.projectId === projectId) await this.store.bindings.delete(id);
  }
  private async removeProject(request: Extract<ProjectRequest, { action: 'remove' }>, invocation: ProjectInvocation): Promise<ProjectRemoveResult> {
    const id = request.projectId;
    if (this.store.removals.get(id) === undefined) {
      const project = this.store.projects.get(id);
      if (project === undefined) throw new WorktreeError('PROJECT_NOT_FOUND', 'This project is not registered.');
      this.guard(request, invocation);
      // Publish the durable decision before deleting anything. Readers hide it immediately;
      // retry/restart repairs interrupted cleanup without reimporting retained native folders.
      await this.store.removals.put(id, { id, folders: project.folders.map(({ id, path }) => ({ id, path })), removedAt: Date.now() });
    }
    await this.finishRemoval(id); this.guard(request, invocation);
    return { removed: true, projectId: id, scope: 'project-metadata' };
  }
  private async canonicalFolders(paths: string[]): Promise<string[]> {
    const result: string[] = [];
    for (const path of paths) {
      let canonical: string;
      try { canonical = await realpath(path); if (!(await stat(canonical)).isDirectory()) throw Error('not directory'); }
      catch { throw new WorktreeError('INVALID_PROJECT_PATH', 'Each project folder must be an existing absolute local directory.'); }
      if (result.includes(canonical)) throw new WorktreeError('DUPLICATE_PROJECT_FOLDER', 'Canonical folder paths must be distinct.');
      if (this.worktrees.records().some(record => contained(record.checkoutRoot, canonical))) throw new WorktreeError('MANAGED_PROJECT_FOLDER', 'Managed worktree checkouts belong to their source project, not a new Local folder.');
      result.push(canonical);
    }
    return result;
  }
  private async changeProject(request: Extract<ProjectRequest, { action: 'create' | 'update' }>, invocation: ProjectInvocation): Promise<{ project: ProjectRecord }> {
    const id = request.action === 'create' ? request.id : request.projectId;
    const existing = this.store.projects.get(id);
    if (request.action === 'create' && [...this.store.removals.entries()].some(([removedId]) => removedId.toLowerCase() === id.toLowerCase())) throw new WorktreeError('PROJECT_REMOVED', 'This project id was removed. Use a fresh UUID to re-add folders.');
    if (request.action === 'create' && existing !== undefined) throw new WorktreeError('PROJECT_EXISTS', 'This project id is already registered.');
    if (request.action === 'update' && existing === undefined) throw new WorktreeError('PROJECT_NOT_FOUND', 'This project is not registered.');
    const paths = request.folders === undefined ? existing!.folders.map(folder => folder.path) : await this.canonicalFolders(request.folders);
    const explicitMain = request.mainFolder === undefined ? undefined : (await this.canonicalFolders([request.mainFolder]))[0]!;
    if (explicitMain !== undefined && !paths.includes(explicitMain)) throw new WorktreeError('PROJECT_MAIN_FOLDER_NOT_FOUND', 'The main folder must be a canonical member of the resulting project folders.');
    for (const path of paths) {
      const owner = this.folderForPath(path); const project = owner === undefined ? undefined : this.store.projects.get(owner.projectId);
      if (project !== undefined && project.id !== id && project.imported !== true) throw new WorktreeError('PROJECT_FOLDER_CONFLICT', 'This canonical folder belongs to another explicit project.');
    }
    if (existing !== undefined) for (const folder of existing.folders) {
      if (paths.includes(folder.path)) continue;
      const bound = [...this.store.bindings.entries()].some(([, binding]) => binding.projectId === id && binding.folderId === folder.id);
      const pending = [...this.store.starts.entries()].some(([, start]) => start.projectId === id && start.folderId === folder.id);
      const records = this.worktrees.records();
      const managed = records.some(record => this.worktreeFolder(record, records)?.folderId === folder.id || resolve(record.repoRoot, record.projectSubdir) === folder.path);
      if (bound || pending || managed) throw new WorktreeError('PROJECT_FOLDER_IN_USE', 'Retain folders with existing threads, managed worktrees or start receipts.');
    }
    const priorMain = existing === undefined ? undefined : resolveMainFolder(existing).path;
    const mainPath = explicitMain ?? (priorMain !== undefined && paths.includes(priorMain) ? priorMain : paths.length === 1 || existing === undefined ? paths[0]! : undefined);
    if (mainPath === undefined) throw new WorktreeError('PROJECT_MAIN_FOLDER_REQUIRED', 'Supply a replacement main folder when removing the prior main from a multi-folder project.');
    const registry = required<Registry>(this.owner, 'workspaceRegistry'); const folders: ProjectFolder[] = [];
    for (const path of paths) {
      this.guard(request, invocation); const workspace = await registry.create(path);
      if (workspace.path !== path) throw new WorktreeError('PROJECT_PATH_CHANGED', 'The canonical folder path changed during registration.');
      folders.push({ id: workspace.id, path: workspace.path, title: workspace.title });
    }
    this.guard(request, invocation); const now = Date.now();
    const project = projectRecordSchema.parse({ id, title: request.title ?? existing!.title, folders, mainFolderId: folders.find(folder => folder.path === mainPath)!.id, createdAt: existing?.createdAt ?? now, updatedAt: now });
    // Publish the explicit winner first. If storage fails afterwards, synchronize repairs adoption.
    await this.store.projects.put(id, project);
    await this.synchronizeNow(); return { project: clone(project) };
  }
  private async start(request: Extract<ProjectRequest, { action: 'start' }>, invocation: ProjectInvocation, folder: ProjectFolder): Promise<ProjectStartResult> {
    const current = this.resolveFolder(request.projectId, folder.id);
    if (current.path !== folder.path) throw new WorktreeError('PROJECT_PATH_CHANGED', 'The captured project folder changed during synchronization.');
    const actorId = invocation.agent?.id ?? null;
    const guard = () => this.guard(request, invocation, folder);
    const previous = this.store.starts.get(request.operationId);
    if (previous !== undefined) {
      if (previous.projectId !== request.projectId || previous.folderId !== folder.id || previous.actorId !== actorId || previous.effectiveCwd !== folder.path) throw new WorktreeError('OPERATION_REUSED', 'This start operation id belongs to another project folder or caller.');
      if (previous.phase !== 'ready' || previous.sessionId === null || previous.workspaceId === null) throw new WorktreeError('RECOVERY_REQUIRED', 'This start may have committed a session. Do not duplicate it; inspect or open the recorded thread.');
      const binding = this.bindingFor(previous.sessionId);
      if (binding === undefined || binding.projectId !== request.projectId || binding.folderId !== folder.id) throw new WorktreeError('RECOVERY_REQUIRED', 'The recorded session no longer has the expected exact project cwd.');
      return { sessionId: previous.sessionId, workspaceId: previous.workspaceId, binding };
    }
    if (invocation.agent === undefined && this.headers.has(request.operationId)) throw new WorktreeError('OPERATION_REUSED', 'The requested session identity already exists independently of this start.');
    const canonical = await this.canonicalFolders([folder.path]);
    if (canonical[0] !== folder.path) throw new WorktreeError('PROJECT_PATH_CHANGED', 'The selected folder no longer has its registered canonical path.');
    if (invocation.agent !== undefined && await (this.dependencies.localPath ?? localProjectPath)(invocation.agent, folder.path, invocation.signal) !== folder.path) throw new WorktreeError('PROJECT_PATH_CHANGED', 'The caller filesystem does not map to this exact native folder.');
    const settings = invocation.agent === undefined ? undefined : await this.bootstrap.settings(invocation.agent, invocation.signal);
    guard(); const now = Date.now();
    let operation: ProjectStartRecord = { id: request.operationId, projectId: request.projectId, folderId: folder.id, actorId, effectiveCwd: folder.path, requestedSessionId: request.operationId, phase: 'planned', sessionId: null, workspaceId: null, createdAt: now, updatedAt: now };
    const receipt = async (phase: ProjectStartRecord['phase'], extra: Partial<ProjectStartRecord> = {}) => { operation = { ...operation, ...extra, phase, updatedAt: Date.now() }; await this.store.starts.put(operation.id, clone(operation)); };
    try {
      await receipt('planned'); guard();
      if (invocation.agent !== undefined && (await this.bootstrap.settings(invocation.agent, invocation.signal)).hash !== settings!.hash) throw new WorktreeError('SETTINGS_CHANGED', 'The invoking settings changed before session creation.');
      guard(); await receipt('creating'); guard();
      let result: { sessionId: string; workspaceId: string };
      if (invocation.agent !== undefined) {
        const created = await this.bootstrap.create({ cwd: folder.path, title: folder.title, source: invocation.agent, settings: settings!, mode: 'new', signal: invocation.signal,
          onCreated: async identity => { await receipt('session-created', { sessionId: identity.sessionId, workspaceId: identity.workspaceId }); },
        });
        result = { sessionId: created.sessionId, workspaceId: created.workspaceId };
      } else {
        const created = await required<Sessions>(this.owner, 'sessionController').create({ workspaceId: folder.id, cwd: folder.path, sessionId: SessionId(operation.requestedSessionId) });
        result = { sessionId: created.sessionId, workspaceId: folder.id };
        await receipt('session-created', result);
      }
      if (result.workspaceId !== folder.id || (invocation.agent === undefined && result.sessionId !== operation.requestedSessionId)) throw new WorktreeError('PROJECT_BINDING_MISMATCH', 'The created session did not match its requested native workspace identity.');
      const header = await this.inspect(result.sessionId, undefined, true);
      if (header.origin === 'subagent' || header.cwd !== folder.path) throw new WorktreeError('PROJECT_BINDING_MISMATCH', 'The created ordinary session cwd does not match the selected folder.');
      const binding: ProjectThreadBinding = { sessionId: result.sessionId, projectId: request.projectId, folderId: folder.id, mode: 'local', effectiveCwd: folder.path };
      await this.store.bindings.put(binding.sessionId, binding); await receipt('ready', result);
      guard(); return { ...result, binding: clone(binding) };
    } catch (error) {
      if (operation.phase !== 'ready') await receipt('recovery-required');
      throw error;
    }
  }
}
