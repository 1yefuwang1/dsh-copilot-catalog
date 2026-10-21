import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { GitOperations } from './git.js';
import { WorktreeError, abortIfRequested, failureOf } from './errors.js';
import { createExecutor, createMaintenanceExecutor, localProjectPath, planBlocksMutation, requireFullAccess, required } from './runtime.js';
import { SessionBootstrap } from './sessions.js';
import { WorktreeController, resolveWorktreeRoot } from './service.js';
import { hashValue } from './schema.js';
import { ProjectController, projectJsonSnapshot } from './projects.js';
import type { RecordTable, WorktreeStore } from './store.js';
import type { WorktreeConfig, WorktreeRecord } from './types.js';
import { WORKTREE_IMPORT_VERSION, type BoundImportReceipt, type ImportActorContext, type ImportBaseChoices, type ImportSourceFolder, type LocalImportBinding, type PortableCreationBase, type VerifiedImportProof, type WorktreeImportPlan, type WorktreeImportReceipt, type WorktreeImportRequest, type WorktreeImportStatus, type WorktreeImportPlacementV1, type WorktreeSourceContext } from './import-contract.js';
import { sanitizePortableRemote } from './portable-source.js';

const text = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u);
const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !/[\u0000-\u001f\u007f]/u.test(value));
const hex = z.string().regex(/^[a-f0-9]{64}$/u), oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const targetSchema = z.object({ scope: z.string().min(1).max(4096), sessionId: text, generation: z.number().int().positive(), headerHash: hex, inheritedEventCount: z.number().int().nonnegative(), eventCount: z.number().int().nonnegative(), chainHash: hex }).strict().refine(value => value.inheritedEventCount <= value.eventCount, 'Inherited cut exceeds committed history.');
const fullRef = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/u).refine(value => value.startsWith('refs/heads/'));
const baseSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('local-branch'), name: fullRef, oid }).strict(), z.object({ kind: z.literal('head'), oid }).strict(), z.object({ kind: z.literal('commit'), oid }).strict()]);
const requestSchema = z.object({ operationId: z.string().uuid(), target: targetSchema, intentId: text, projectId: z.string().uuid(), folderId: text, base: baseSchema, requiredDirectories: z.array(z.string().max(4096)).max(256).readonly().optional(), label: z.string().trim().min(1).max(60).regex(/^[^\u0000-\u001f\u007f]+$/u).optional() }).strict();
const planSchema = requestSchema.extend({ requestHash: hex, actorId: text, settingsHash: z.string().min(1).max(4096), worktreeId: z.string().uuid(), repoRoot: path, commonDir: path, projectSubdir: z.string().max(4096), checkoutRoot: path, effectiveCwd: path, branch: text, baseRef: text }).strict();
const receiptSchema = z.object({ version: z.literal(1), operationId: z.string().uuid(), requestHash: hex, target: targetSchema, intentId: text, actorId: text, worktreeId: z.string().uuid(), projectId: z.string().uuid(), folderId: text, workspaceId: text.optional(), repoRoot: path, commonDir: path, checkoutRoot: path, projectSubdir: z.string().max(4096), effectiveCwd: path, baseOid: oid, baseRef: text, branch: text, revision: z.number().int().positive() }).strict();
const remoteSchema = z.object({ name: text, sanitizedUrl: z.string().min(1).max(4096).refine(value => sanitizePortableRemote(value) === value) }).strict();
const creationBaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remote'), ref: fullRef, remote: remoteSchema, oid }).strict(),
  z.object({ kind: z.literal('local'), ref: fullRef, oid, upstreamAtCreation: z.object({ ref: fullRef, remote: remoteSchema }).strict().optional() }).strict(),
  z.object({ kind: z.literal('detached'), oid }).strict(),
]);
export const placementSchema = z.object({ version: z.literal(1), plan: planSchema, sourceIdentity: hex, checkoutIdentity: hex.optional(), phase: z.enum(['reserved', 'preparing', 'prepared', 'bound', 'ready', 'cancelled', 'recovery-required', 'reclaimed']), receipt: receiptSchema.optional(), error: z.object({ code: text, message: z.string().max(4096) }).strict().optional(), updatedAt: z.number().int().nonnegative() }).strict();
const sourceSchema = z.object({ worktreeId: z.string().uuid(), checkoutRoot: path, commonDir: path, baseOid: oid, creationBase: creationBaseSchema.optional() }).strict();
/** Independent journals: legacy create/handoff/settings schemas and versions are unchanged. */
export const importPlacementDomain = defineDomain({ name: 'dsh_worktree_import_placement', version: 1, layout: 'per-record', tables: { placements: domainTable(placementSchema), sources: domainTable(sourceSchema) } });
export type PlacementRecord = z.infer<typeof placementSchema>;
export interface ImportPlacementStore { placements: RecordTable<PlacementRecord> & { update(key: string, transform: (current: PlacementRecord) => PlacementRecord): Promise<PlacementRecord> }; sources: RecordTable<z.infer<typeof sourceSchema>>; close(): Promise<void> }
/** Structurally consumes the mandatory service's opaque issuer registry, not a JSON proof bit. */
export interface ImportProofVerifier {
  readonly version: 1;
  verifyProof(proof: unknown, expected: { operationId: string; sessionId: string; intentId: string }, complete?: boolean): Promise<boolean>;
  assertPlacement(expected: { operationId: string; sessionId: string; intentId: string; finalCwd: string }): Promise<void>;
  readonly journal: { read(sessionId: string): Promise<{ operationId: string; intentId: string; target: WorktreeImportPlan['target']; finalCwd: string; phase: string; cancelledAt?: number } | undefined> };
}
export interface ImportPlacementDependencies {
  worktreeRoot?: () => string;
  verifier?: () => ImportProofVerifier | undefined;
  /** Test/deployment managed executor injection; never a native-spawn fallback. */
  git?: (actor: Agent, guard: () => void, admission: () => Promise<void>) => GitOperations;
  readGit?: (guard: () => void) => GitOperations;
  bootstrap?: Pick<SessionBootstrap, 'actor' | 'isLive' | 'settings' | 'close'>;
}
interface Workspace { id: string; path: string; sessionIds: readonly string[]; attachSession(id: SessionId): Promise<void> }
interface Registry { list(): Workspace[]; get(id: string): Workspace | undefined; create(path: string, title?: string): Promise<Workspace> }
const copy = <T>(value: T): T => structuredClone(value);
function inside(root: string, value: string) { const part = relative(root, value); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); }
async function future(path: string): Promise<string> { try { return await realpath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error; return resolve(await future(dirname(path)), basename(path)); } }
async function physicalIdentity(paths: readonly string[]): Promise<string> {
  const values: unknown[] = [];
  try {
    for (const path of [...new Set(paths)]) {
      if (await realpath(path) !== path) throw new WorktreeError('PATH_CHANGED', 'A planned directory or Git mapping became an alias.');
      const value = await lstat(path, { bigint: true });
      if (value.ino === 0n || value.isSymbolicLink() || !value.isDirectory() && !value.isFile()) throw new WorktreeError('PATH_CHANGED', 'Stable native directory identity is unavailable.');
      values.push([path, String(value.dev), String(value.ino), String(value.birthtimeNs), String(value.mode)]);
    }
  } catch (error) { if (error instanceof WorktreeError) throw error; throw new WorktreeError('PATH_CHANGED', 'A planned directory or Git identity is missing or cannot be revalidated.'); }
  return hashValue(values);
}

/** Provision a checkout only. Importing its original SID remains the coordinator's job. */
export class WorktreeImportPlacement implements WorktreeImportPlacementV1 {
  readonly version = WORKTREE_IMPORT_VERSION;
  private readonly shutdown = new AbortController();
  private readonly plans = new Map<string, WorktreeImportPlan>();
  private readonly sourceIdentities = new Map<string, string>();
  private readonly stopped = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private readonly bootstrap: NonNullable<ImportPlacementDependencies['bootstrap']>;
  private readonly flights = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly owner: Context, private readonly config: WorktreeConfig, private readonly worktrees: WorktreeStore, private readonly journal: ImportPlacementStore, private readonly controller: WorktreeController, private readonly projects: ProjectController, private readonly deps: ImportPlacementDependencies = {}) { this.bootstrap = deps.bootstrap ?? new SessionBootstrap(owner); }
  private signal(signal: AbortSignal) { return AbortSignal.any([signal, this.shutdown.signal, AbortSignal.timeout(this.config.operationTimeoutMs)]); }
  private available(signal?: AbortSignal) { abortIfRequested(signal); if (this.closed) throw new WorktreeError('CLOSED', 'Import placement is unavailable.'); }
  private authority(context: ImportActorContext) {
    this.available(context.signal);
    if (!this.bootstrap.isLive(context.actor) || this.bootstrap.actor(context.actor.id) !== context.actor) throw new WorktreeError('SESSION_CHANGED', 'Select a genuine current ordinary permission context.');
    requireFullAccess(context.actor);
    if (context.origin === 'tool' && planBlocksMutation(context.actor)) throw new WorktreeError('PLAN_MODE', 'Worktree import placement is unavailable while plan mode is active or pending.');
  }
  private verifier(): ImportProofVerifier {
    const value = this.deps.verifier?.() ?? this.owner.get('cloudImportReadinessV1') as ImportProofVerifier | undefined;
    if (value?.version !== 1 || typeof value.verifyProof !== 'function' || typeof value.assertPlacement !== 'function' || typeof value.journal?.read !== 'function') throw new WorktreeError('IMPORT_ADMISSION_UNAVAILABLE', 'The compatible independent import guard is unavailable.');
    return value;
  }
  private veto(plan: WorktreeImportPlan) {
    this.available();
    if (this.stopped.has(plan.operationId) || this.journal.placements.get(plan.operationId)?.phase === 'cancelled') throw new WorktreeError('IMPORT_STOPPED', 'This original import intent is durably stopped.');
  }
  private async admission(plan: WorktreeImportPlan) {
    if (this.stopped.has(plan.operationId) || this.journal.placements.get(plan.operationId)?.phase === 'cancelled') {
      const record = this.worktrees.worktrees.get(plan.worktreeId);
      if (record?.state === 'ready') await this.worktrees.worktrees.put(record.id, { ...record, state: 'recovery-required', error: 'The import destination is stopped; retained effects need explicit recovery.' });
    }
    this.veto(plan); const verifier = this.verifier();
    const stopped = async () => {
      const current = await verifier.journal.read(plan.target.sessionId);
      if (current?.operationId === plan.operationId && current.intentId === plan.intentId && (current.cancelledAt !== undefined || current.phase === 'cancelled')) await this.suspend(plan.operationId, plan.target.sessionId, plan.intentId, this.shutdown.signal);
      return current;
    };
    try { await verifier.assertPlacement({ operationId: plan.operationId, sessionId: plan.target.sessionId, intentId: plan.intentId, finalCwd: plan.effectiveCwd }); }
    catch { await stopped(); this.veto(plan); throw new WorktreeError('IMPORT_ADMISSION_UNAVAILABLE', 'The independent import intent or coordinator is unavailable.'); }
    const record = await stopped();
    if (!record || record.operationId !== plan.operationId || record.intentId !== plan.intentId || record.finalCwd !== plan.effectiveCwd || hashValue(record.target) !== hashValue(plan.target) || record.cancelledAt !== undefined || record.phase === 'cancelled') throw new WorktreeError('IMPORT_STOPPED', 'The independent destination reservation changed or stopped.');
    this.veto(plan);
  }
  private git(context: ImportActorContext, plan?: WorktreeImportPlan) {
    const guard = () => { this.authority(context); if (plan) this.veto(plan); };
    const engine = this.deps.git?.(context.actor, guard, async () => { if (plan) await this.admission(plan); });
    if (engine) return engine; // Injected managed kernels preserve both callback boundaries, just like the production executor below.
    const execute = createExecutor(context.actor, this.config, this.shutdown.signal, guard);
    return new GitOperations(async spec => { if (plan) await this.admission(plan); guard(); return execute(spec); }, this.config, guard);
  }
  private readGit(signal: AbortSignal) {
    const guard = () => this.available(signal);
    return this.deps.readGit?.(guard) ?? new GitOperations(createMaintenanceExecutor(this.owner, this.config, guard, this.shutdown.signal), this.config, guard);
  }
  private async root() { return resolveWorktreeRoot(await future(resolveWorktreeRoot(this.deps.worktreeRoot?.() ?? this.config.root))); }
  private layoutRoot(plan: WorktreeImportPlan) {
    const root = resolveWorktreeRoot(dirname(dirname(dirname(plan.checkoutRoot))));
    if (resolve(root, hashValue(plan.commonDir).slice(0, 24), plan.worktreeId, `import-${plan.worktreeId}`) !== plan.checkoutRoot) throw new WorktreeError('INVALID_IMPORT_PLAN', 'The managed checkout layout differs from its reviewed identity.');
    return root;
  }
  private async selection(projectId: string, folderId: string, context: ImportActorContext) {
    this.authority(context);
    const folder = this.projects.resolveFolder(projectId, folderId);
    const local = await localProjectPath(context.actor, folder.path, context.signal);
    if (local !== folder.path || this.worktreesRecordForPath(local)) throw new WorktreeError('PROJECT_PATH_MISMATCH', 'Select the exact original Local project folder, not a managed checkout.');
    return folder;
  }
  private worktreesRecordForPath(path: string) { return [...this.worktrees.worktrees.entries()].map(([, row]) => row).find(row => inside(row.checkoutRoot, path)); }
  async folders(signal: AbortSignal): Promise<readonly ImportSourceFolder[]> {
    this.available(signal); await this.projects.synchronize();
    return this.projects.records().flatMap(project => project.folders.filter(folder => !this.worktreesRecordForPath(folder.path)).map(folder => ({ projectId: project.id, folderId: folder.id, title: `${project.title} · ${folder.title}`, path: folder.path })));
  }
  async bases(projectId: string, folderId: string, context: ImportActorContext): Promise<ImportBaseChoices> {
    const input = { ...context, signal: this.signal(context.signal) }, folder = await this.selection(projectId, folderId, input), git = this.git(input);
    const repo = await git.discover(folder.path, input.signal), refs = await git.localBranches(repo.root, input.signal), objectFormat = await git.objectFormat(repo.root, input.signal);
    const after = await git.discover(folder.path, input.signal);
    if (hashValue(after) !== hashValue(repo)) throw new WorktreeError('BRANCH_CHANGED', 'The source repository changed during import base discovery. Refresh its choices.');
    return { repoRoot: repo.root, commonDir: repo.commonDir, projectSubdir: repo.projectSubdir, objectFormat, head: repo.head, branches: refs.branches.filter(branch => branch.name !== 'HEAD').map(branch => ({ name: `refs/heads/${branch.name}`, oid: branch.oid })) };
  }
  async classifyPath(path: string, sessionId: string, signal: AbortSignal): Promise<'local' | 'managed-self' | 'managed-other'> {
    this.available(signal); const canonical = await realpath(path), record = this.worktreesRecordForPath(canonical);
    if (!record) return 'local';
    return record.sessionIds.includes(sessionId) && record.effectiveCwd === canonical ? 'managed-self' : 'managed-other';
  }
  async plan(request: WorktreeImportRequest, context: ImportActorContext): Promise<WorktreeImportPlan> {
    this.authority(context); this.verifier();
    if (process.platform === 'win32') throw new WorktreeError('IMPORT_PLATFORM_UNSUPPORTED', 'Worktree import placement requires a verified native Windows durable-claim primitive before preview can enable it.');
    const parsed = requestSchema.parse(projectJsonSnapshot(request)), input = { ...context, signal: this.signal(context.signal) };
    const folder = await this.selection(parsed.projectId, parsed.folderId, input), git = this.git(input), repo = await git.discover(folder.path, input.signal);
    const durable = this.journal.placements.get(parsed.operationId);
    if (!durable) await git.resolveImportBase(repo, parsed.base, input.signal);
    await git.validateImportDirectories(repo, parsed.base.oid, parsed.requiredDirectories, input.signal);
    const settings = await this.bootstrap.settings(input.actor, input.signal), root = await this.root();
    if (inside(repo.root, root) || inside(root, repo.root)) throw new WorktreeError('UNSAFE_ROOT', 'Managed imports must be outside the source checkout.');
    const requestHash = hashValue({ actorId: input.actor.id, request: parsed });
    const prior = this.journal.placements.get(parsed.operationId)?.plan ?? this.plans.get(parsed.operationId);
    if (prior) {
      if (prior.requestHash !== requestHash || prior.settingsHash !== settings.hash || prior.repoRoot !== repo.root || prior.commonDir !== repo.commonDir || prior.projectSubdir !== repo.projectSubdir) throw new WorktreeError('OPERATION_REUSED', 'This import operation is already bound to another request, actor, settings or repository.');
      const identity = durable?.sourceIdentity ?? this.sourceIdentities.get(prior.operationId);
      if (!identity || identity !== await physicalIdentity([folder.path, repo.root, repo.commonDir, resolve(repo.root, '.git')])) throw new WorktreeError('PATH_CHANGED', 'The original source identity changed before plan replay.');
      return copy(prior);
    }
    const worktreeId = randomUUID(), checkoutRoot = resolve(root, hashValue(repo.commonDir).slice(0, 24), worktreeId, `import-${worktreeId}`);
    const plan: WorktreeImportPlan = { ...parsed, requestHash, actorId: input.actor.id, settingsHash: settings.hash, worktreeId, repoRoot: repo.root, commonDir: repo.commonDir, projectSubdir: repo.projectSubdir, checkoutRoot, effectiveCwd: resolve(checkoutRoot, repo.projectSubdir), branch: `worktree/import-${worktreeId}`, baseRef: `refs/dsh-worktrees/${worktreeId}/base` };
    if (this.plans.size >= 256) { const oldest = this.plans.keys().next().value ?? ''; this.plans.delete(oldest); this.sourceIdentities.delete(oldest); }
    this.sourceIdentities.set(plan.operationId, await physicalIdentity([folder.path, repo.root, repo.commonDir, resolve(repo.root, '.git')]));
    this.plans.set(plan.operationId, copy(plan)); return copy(plan);
  }
  private track<T>(task: Promise<T>): Promise<T> { this.flights.add(task); void task.finally(() => this.flights.delete(task)).catch(() => undefined); return task; }
  provision(plan: WorktreeImportPlan, context: ImportActorContext): Promise<WorktreeImportReceipt> {
    const parsed = planSchema.parse(projectJsonSnapshot(plan)), input = { ...context, signal: this.signal(context.signal) };
    return this.track(this.controller.withRepositoryMaintenance(`import:${parsed.operationId}`, input.signal, signal => this.controller.withRepositoryMaintenance(parsed.commonDir, signal, lifetime => this.provisionNow(parsed, { ...input, signal: lifetime }))));
  }
  private async revalidate(plan: WorktreeImportPlan, context: ImportActorContext, checkSelection = true) {
    this.authority(context); await this.admission(plan);
    if (plan.actorId !== context.actor.id || (await this.bootstrap.settings(context.actor, context.signal)).hash !== plan.settingsHash) throw new WorktreeError('SETTINGS_CHANGED', 'The selected authorizing context changed. Review the import again.');
    const folder = await this.selection(plan.projectId, plan.folderId, context), repo = await this.git(context).discover(folder.path, context.signal);
    const identity = this.journal.placements.get(plan.operationId)?.sourceIdentity ?? this.sourceIdentities.get(plan.operationId);
    if (!identity || await physicalIdentity([folder.path, repo.root, repo.commonDir, resolve(repo.root, '.git')]) !== identity) throw new WorktreeError('PATH_CHANGED', 'The reviewed source directory or Git admin identity was replaced.');
    if (repo.root !== plan.repoRoot || repo.commonDir !== plan.commonDir || repo.projectSubdir !== plan.projectSubdir || plan.effectiveCwd !== resolve(plan.checkoutRoot, repo.projectSubdir)) throw new WorktreeError('PROJECT_CHANGED', 'The selected source folder or repository changed.');
    const root = this.layoutRoot(plan);
    if (!this.journal.placements.get(plan.operationId) && await this.root() !== root) throw new WorktreeError('PATH_CHANGED', 'The worktree root changed before confirmation. Refresh the review.');
    if (await future(plan.checkoutRoot) !== plan.checkoutRoot) throw new WorktreeError('PATH_CHANGED', 'The reviewed worktree path changed or became an alias.');
    if (checkSelection) await this.git(context).resolveImportBase(repo, plan.base, context.signal);
    await this.git(context).validateImportDirectories(repo, plan.base.oid, plan.requiredDirectories, context.signal);
    this.authority(context);
    return repo;
  }
  private async claim(plan: WorktreeImportPlan, context: ImportActorContext) {
    this.authority(context); await this.admission(plan);
    const root = this.layoutRoot(plan), claims = resolve(root, '.import-claims');
    const firstCreated = await mkdir(claims, { recursive: true, mode: 0o700 });
    if (await realpath(claims) !== claims) throw new WorktreeError('UNSAFE_ROOT', 'The import claim directory is not canonical.');
    this.authority(context);
    const directory = resolve(claims, plan.operationId);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorktreeError('IMPORT_CLAIMED', 'This operation already owns a placement claim. Inspect its durable status; no second checkout was allocated.'); throw error; }
    const handle = await open(resolve(directory, 'owner.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, operationId: plan.operationId, requestHash: plan.requestHash, worktreeId: plan.worktreeId, sessionId: plan.target.sessionId })); await handle.sync(); } finally { await handle.close(); }
    // Persist every newly created ancestor's directory entry, not just its own
    // contents; namespace durability is currently verified only on POSIX.
    const boundary = firstCreated === undefined ? dirname(claims) : dirname(firstCreated);
    for (let target = directory; ; target = dirname(target)) {
      const dir = await open(target, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      if (target === boundary) break;
      if (dirname(target) === target) throw new WorktreeError('UNSAFE_ROOT', 'The import claim ancestry did not reach its verified parent.');
    }
  }
  private save(row: Omit<PlacementRecord, 'sourceIdentity'> & { sourceIdentity?: string }): Promise<void> {
    const operationId = row.plan.operationId;
    const task = this.writes.then(async () => {
      const merge = (previous?: PlacementRecord): PlacementRecord => {
        const sourceIdentity = row.sourceIdentity ?? previous?.sourceIdentity ?? this.sourceIdentities.get(operationId);
        const stopped = this.stopped.has(operationId) || previous?.phase === 'cancelled';
        return placementSchema.parse(projectJsonSnapshot({ ...row, sourceIdentity, updatedAt: Math.max(Date.now(), row.updatedAt, previous?.updatedAt ?? 0),
          ...(previous?.receipt !== undefined && (row.receipt === undefined || row.receipt.revision < previous.receipt.revision) ? { receipt: previous.receipt } : {}),
          ...(row.checkoutIdentity === undefined && previous?.checkoutIdentity !== undefined ? { checkoutIdentity: previous.checkoutIdentity } : {}),
          ...(stopped ? { phase: 'cancelled', error: { code: 'IMPORT_STOPPED', message: 'The independent destination intent is durably stopped.' } } : {}),
        }));
      };
      if (this.journal.placements.get(operationId)) await this.journal.placements.update(operationId, merge);
      else await this.journal.placements.put(operationId, merge());
      if (this.stopped.has(operationId)) await this.journal.placements.update(operationId, previous => ({ ...previous, phase: 'cancelled', error: { code: 'IMPORT_STOPPED', message: 'The independent destination intent is durably stopped.' }, updatedAt: Date.now() }));
    });
    this.writes = task.catch(() => undefined); return task;
  }
  private record(plan: WorktreeImportPlan): WorktreeRecord {
    return { id: plan.worktreeId, operationId: plan.operationId, repoRoot: plan.repoRoot, commonDir: plan.commonDir, projectSubdir: plan.projectSubdir, checkoutRoot: plan.checkoutRoot, effectiveCwd: plan.effectiveCwd, remote: 'local', remoteIdentity: hashValue(plan.commonDir), remoteBranch: plan.base.kind === 'local-branch' ? plan.base.name : plan.base.kind === 'head' ? 'HEAD' : plan.base.oid, branchSource: 'local', ...(plan.base.kind === 'local-branch' ? { localBranch: plan.base.name.slice(11) } : {}), baseOid: plan.base.oid, baseRef: plan.baseRef, fetchedAt: Date.now(), createdAt: Date.now(), sessionIds: [], workspaceId: null, branch: null, projectId: plan.projectId, folderId: plan.folderId, protected: false, archived: false, state: 'creating', error: null };
  }
  private async provisionNow(plan: WorktreeImportPlan, context: ImportActorContext): Promise<WorktreeImportReceipt> {
    const stored = this.journal.placements.get(plan.operationId), issued = stored?.plan ?? this.plans.get(plan.operationId);
    if (!issued || hashValue(issued) !== hashValue(plan)) throw new WorktreeError('INVALID_IMPORT_PLAN', 'Provision requires the exact server-reviewed placement plan.');
    if (stored?.phase === 'cancelled' || stored?.phase === 'reclaimed') throw new WorktreeError('IMPORT_STOPPED', 'This original placement cannot be provisioned again.');
    const repo = await this.revalidate(plan, context, stored === undefined), git = this.git(context, plan);
    if (stored?.receipt) { await this.verifyCheckout(stored.receipt, git, context.signal); return copy(stored.receipt); }
    if (!stored) {
      if (process.platform === 'win32') throw new WorktreeError('IMPORT_PLATFORM_UNSUPPORTED', 'Durable placement claims require a verified native Windows implementation.');
      await this.claim(plan, context);
      await this.save({ version: 1, plan, phase: 'reserved', updatedAt: Date.now() });
      await this.worktrees.worktrees.put(plan.worktreeId, this.record(plan));
    }
    let record = this.worktrees.worktrees.get(plan.worktreeId) ?? this.record(plan);
    try {
      await this.save({ version: 1, plan, phase: 'preparing', updatedAt: Date.now() });
      await this.revalidate(plan, context, stored === undefined);
      const exists = await lstat(plan.checkoutRoot).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return false; });
      if (exists && !stored) throw new WorktreeError('DESTINATION_EXISTS', 'A new import requires a genuinely fresh checkout path; an existing path is not adopted.');
      if (!exists && stored) throw new WorktreeError('IMPORT_RECOVERY_REQUIRED', 'A prior placement may have pinned shared refs. No checkout was recreated; reconcile the original operation before retry.');
      if (!exists) {
        this.authority(context); await mkdir(dirname(plan.checkoutRoot), { recursive: true });
        await this.revalidate(plan, context);
        const { creationBase: _ignored, ...checkout } = await git.create({ id: plan.worktreeId, repository: repo, destination: plan.checkoutRoot, baseRef: plan.baseRef, branchSource: 'commit', commitOid: plan.base.oid, requiredDirectories: plan.requiredDirectories, ...(plan.base.kind === 'commit' ? {} : { verifyRef: plan.base.kind === 'head' ? 'HEAD' : plan.base.name }), signal: context.signal });
        record = { ...record, ...checkout };
        await this.worktrees.worktrees.put(record.id, copy(record));
      }
      this.authority(context);
      const checkoutIdentity = await physicalIdentity([plan.checkoutRoot, plan.effectiveCwd, resolve(plan.checkoutRoot, '.git')]);
      if (stored?.checkoutIdentity !== undefined && stored.checkoutIdentity !== checkoutIdentity) throw new WorktreeError('PATH_CHANGED', 'The prepared checkout directory identity was replaced.');
      await this.save({ version: 1, plan, checkoutIdentity, phase: 'preparing', updatedAt: Date.now() });
      const state = await git.verify(record, context.signal);
      if (state.head !== plan.base.oid || state.dirty || state.branch !== null && state.branch !== plan.branch) throw new WorktreeError('IMPORT_CHECKOUT_CHANGED', 'The original prepared checkout no longer matches the pinned import snapshot.');
      await this.revalidate(plan, context, false);
      if (state.branch === null) { const branch = await git.createBranch(record, plan.branch, context.signal); record = { ...record, branch: branch.branch }; }
      else record = { ...record, branch: state.branch };
      await this.worktrees.worktrees.put(record.id, copy(record));
      await this.revalidate(plan, context, false);
      // Do not publish a pending checkout in the native workspace registry.
      // Its real workspace ID is allocated only after complete history proof.
      const receipt: WorktreeImportReceipt = { version: 1, operationId: plan.operationId, requestHash: plan.requestHash, target: plan.target, intentId: plan.intentId, actorId: plan.actorId, worktreeId: plan.worktreeId, projectId: plan.projectId, folderId: plan.folderId, repoRoot: plan.repoRoot, commonDir: plan.commonDir, checkoutRoot: plan.checkoutRoot, projectSubdir: plan.projectSubdir, effectiveCwd: plan.effectiveCwd, baseOid: plan.base.oid, baseRef: plan.baseRef, branch: plan.branch, revision: 1 };
      if (await physicalIdentity([plan.checkoutRoot, plan.effectiveCwd, resolve(plan.checkoutRoot, '.git')]) !== checkoutIdentity) throw new WorktreeError('PATH_CHANGED', 'The checkout or project directory was replaced during preparation.');
      await this.save({ version: 1, plan, receipt, checkoutIdentity, phase: 'prepared', updatedAt: Date.now() });
      await this.admission(plan); this.authority(context); return copy(receipt);
    } catch (error) {
      const latest = this.journal.placements.get(plan.operationId);
      if (latest && latest.phase !== 'ready') await this.save({ ...latest, phase: 'recovery-required', error: failureOf(error), updatedAt: Date.now() });
      const actual = this.worktrees.worktrees.get(plan.worktreeId);
      if (actual && actual.state !== 'ready') await this.worktrees.worktrees.put(actual.id, { ...actual, state: 'recovery-required', error: 'Import placement requires recovery.' });
      throw error;
    }
  }
  private row(receipt: WorktreeImportReceipt): PlacementRecord {
    const parsed = receiptSchema.parse(projectJsonSnapshot(receipt)), row = this.journal.placements.get(parsed.operationId);
    const identity = (value: WorktreeImportReceipt) => { const { workspaceId: _workspace, revision: _revision, ...rest } = value; return hashValue(rest); };
    if (!row?.receipt || identity(row.receipt) !== identity(parsed) || parsed.revision > row.receipt.revision || parsed.workspaceId !== undefined && parsed.workspaceId !== row.receipt.workspaceId) throw new WorktreeError('IMPORT_RECEIPT_MISMATCH', 'The placement receipt does not match its durable original operation.');
    if (['cancelled', 'reclaimed'].includes(row.phase)) throw new WorktreeError('IMPORT_STOPPED', 'This placement is cancelled or reclaimed.');
    return row;
  }
  private async proof(value: unknown, operationId: string, sessionId: string, intentId: string, signal: AbortSignal) {
    this.available(signal);
    const verifier = this.verifier();
    if (!await verifier.verifyProof(value, { operationId, sessionId, intentId }, true)) throw new WorktreeError('IMPORT_PROOF_REQUIRED', 'A fresh complete proof from the mandatory native import guard is required.');
    const current = await verifier.journal.read(sessionId);
    if (!current || current.operationId !== operationId || current.intentId !== intentId || current.cancelledAt !== undefined || current.phase === 'cancelled') throw new WorktreeError('IMPORT_PROOF_REQUIRED', 'The native intent changed while its complete proof was checked.');
    await verifier.assertPlacement({ operationId, sessionId, intentId, finalCwd: current.finalCwd });
    this.available(signal);
  }
  private async native(sessionId: string, cwd: string, inherited?: number) {
    const persistence = required<SessionPersistence>(this.owner, 'sessionPersistence'), handle = await persistence.open(SessionId(sessionId), 'read');
    try {
      if (handle.header.id !== sessionId || handle.header.origin === 'subagent' || handle.header.cwd !== cwd || inherited !== undefined && handle.inheritedEventCount !== inherited) throw new WorktreeError('IMPORT_BINDING_MISMATCH', 'The original ordinary SID/header/cwd/cut differs from its placement.');
      await handle.read();
    } finally { await handle.close(); }
  }
  private async verifyCheckout(receipt: WorktreeImportReceipt, git: GitOperations, signal: AbortSignal) {
    const record = this.worktrees.worktrees.get(receipt.worktreeId);
    if (!record || record.checkoutRoot !== receipt.checkoutRoot || record.commonDir !== receipt.commonDir || record.effectiveCwd !== receipt.effectiveCwd || record.state === 'missing') throw new WorktreeError('IMPORT_BINDING_MISMATCH', 'The original checkout backing changed or was reclaimed.');
    const expected = this.journal.placements.get(receipt.operationId)?.checkoutIdentity;
    if (!expected || await physicalIdentity([receipt.checkoutRoot, receipt.effectiveCwd, resolve(receipt.checkoutRoot, '.git')]) !== expected) throw new WorktreeError('PATH_CHANGED', 'The original prepared directory identity changed.');
    const state = await git.verify(record, signal);
    if (state.head !== receipt.baseOid || state.branch !== receipt.branch || state.dirty) throw new WorktreeError('IMPORT_CHECKOUT_CHANGED', 'The prepared checkout changed before import was bound.');
  }
  async bindLocalImported(binding: LocalImportBinding, proof: VerifiedImportProof, signal: AbortSignal): Promise<void> {
    binding = z.object({ operationId: z.string().uuid(), sessionId: text, intentId: text, projectId: z.string().uuid(), folderId: text, cwd: path, workspaceId: text }).strict().parse(projectJsonSnapshot(binding));
    await this.proof(proof, binding.operationId, binding.sessionId, binding.intentId, signal);
    const folder = this.projects.resolveFolder(binding.projectId, binding.folderId), workspace = required<Registry>(this.owner, 'workspaceRegistry').get(binding.workspaceId);
    if (folder.path !== binding.cwd || workspace?.path !== binding.cwd || await realpath(binding.cwd) !== binding.cwd || await this.classifyPath(binding.cwd, binding.sessionId, signal) !== 'local') throw new WorktreeError('IMPORT_BINDING_MISMATCH', 'Local import requires the exact selected ordinary folder and native workspace.');
    await this.native(binding.sessionId, binding.cwd);
    await this.proof(proof, binding.operationId, binding.sessionId, binding.intentId, signal);
    await workspace.attachSession(SessionId(binding.sessionId));
    await this.projects.recordThread({ sessionId: binding.sessionId, projectId: binding.projectId, folderId: binding.folderId, mode: 'local', effectiveCwd: binding.cwd });
    await this.proof(proof, binding.operationId, binding.sessionId, binding.intentId, signal);
    if (!workspace.sessionIds.includes(binding.sessionId)) throw new WorktreeError('IMPORT_BINDING_MISMATCH', 'Native folder accounting did not persist the original SID.');
  }
  async bindImported(receipt: WorktreeImportReceipt, proof: VerifiedImportProof, signal: AbortSignal): Promise<BoundImportReceipt> {
    receipt = receiptSchema.parse(projectJsonSnapshot(receipt));
    this.row(receipt);
    return this.track(this.controller.withRepositoryMaintenance(receipt.commonDir, signal, async lifetime => {
      const row = this.row(receipt);
      await this.admission(row.plan);
      await this.proof(proof, receipt.operationId, receipt.target.sessionId, receipt.intentId, lifetime);
      await this.verifyCheckout(receipt, this.readGit(lifetime), lifetime);
      await this.native(receipt.target.sessionId, receipt.effectiveCwd, receipt.target.inheritedEventCount);
      const folder = this.projects.resolveFolder(receipt.projectId, receipt.folderId);
      if (folder.path !== resolve(receipt.repoRoot, receipt.projectSubdir)) throw new WorktreeError('PROJECT_CHANGED', 'The selected original project folder changed before binding.');
      await this.proof(proof, receipt.operationId, receipt.target.sessionId, receipt.intentId, lifetime);
      const current = row.receipt!, registry = required<Registry>(this.owner, 'workspaceRegistry');
      const workspace = current.workspaceId === undefined
        ? await registry.create(receipt.effectiveCwd, row.plan.label ?? `Imported · ${receipt.worktreeId.slice(0, 8)}`)
        : registry.get(current.workspaceId);
      if (workspace?.path !== receipt.effectiveCwd) throw new WorktreeError('IMPORT_BINDING_MISMATCH', 'The exact native workspace is unavailable or changed.');
      const actual: WorktreeImportReceipt & { workspaceId: string } = { ...current, workspaceId: workspace.id, revision: Math.max(2, current.revision) };
      // Retain an already committed native allocation even if cancellation wins
      // before attach/project binding; retry the same actual ID, never a fake ID.
      await this.save({ ...row, receipt: actual, updatedAt: Date.now() });
      const allocated = this.worktrees.worktrees.get(receipt.worktreeId)!;
      await this.worktrees.worktrees.put(allocated.id, { ...allocated, workspaceId: workspace.id });
      await this.admission(row.plan);
      await this.proof(proof, receipt.operationId, receipt.target.sessionId, receipt.intentId, lifetime);
      await workspace.attachSession(SessionId(receipt.target.sessionId));
      const record = this.worktrees.worktrees.get(receipt.worktreeId)!;
      await this.worktrees.worktrees.put(record.id, { ...record, sessionIds: [...new Set([...record.sessionIds, receipt.target.sessionId])], workspaceId: workspace.id });
      await this.projects.recordThread({ sessionId: receipt.target.sessionId, projectId: receipt.projectId, folderId: receipt.folderId, mode: 'worktree', effectiveCwd: receipt.effectiveCwd, worktreeId: receipt.worktreeId });
      await this.proof(proof, receipt.operationId, receipt.target.sessionId, receipt.intentId, lifetime);
      if (!workspace.sessionIds.includes(receipt.target.sessionId)) throw new WorktreeError('IMPORT_BINDING_MISMATCH', 'Required native original-SID attachment failed.');
      await this.save({ ...row, receipt: actual, phase: row.phase === 'ready' ? 'ready' : 'bound', updatedAt: Date.now() });
      await this.admission(row.plan);
      return { ...copy(actual), bound: true };
    }));
  }
  async acknowledgeReady(receipt: BoundImportReceipt, proof: VerifiedImportProof, signal: AbortSignal): Promise<void> {
    const { bound: _bound, ...plain } = receiptSchema.extend({ bound: z.literal(true), workspaceId: text }).parse(projectJsonSnapshot(receipt));
    this.row(plain);
    return this.track(this.controller.withRepositoryMaintenance(plain.commonDir, this.signal(signal), async lifetime => {
      const row = this.row(plain);
      if (row.receipt?.workspaceId !== plain.workspaceId || row.receipt.revision !== plain.revision || plain.revision < 2) throw new WorktreeError('IMPORT_RECEIPT_MISMATCH', 'Ready requires the exact current bound native workspace receipt.');
      await this.admission(row.plan);
      if (row.phase !== 'bound' && row.phase !== 'ready') throw new WorktreeError('IMPORT_NOT_BOUND', 'Required native/project attachment must precede Ready.');
      await this.proof(proof, plain.operationId, plain.target.sessionId, plain.intentId, lifetime);
      await this.native(plain.target.sessionId, plain.effectiveCwd, plain.target.inheritedEventCount);
      const record = this.worktrees.worktrees.get(plain.worktreeId), workspace = required<Registry>(this.owner, 'workspaceRegistry').get(plain.workspaceId), binding = this.projects.bindingFor(plain.target.sessionId, plain.effectiveCwd);
      if (!record || record.state === 'missing' || this.controller.records().find(value => value.id === plain.worktreeId)?.cleanup?.phase === 'collected') throw new WorktreeError('IMPORT_RECLAIMED', 'The original import checkout was reclaimed; use explicit Local continuation recovery, not same-SID placement replay.');
      if (!record.sessionIds.includes(plain.target.sessionId) || !workspace?.sessionIds.includes(plain.target.sessionId) || workspace.path !== plain.effectiveCwd || binding?.worktreeId !== plain.worktreeId || binding.projectId !== plain.projectId || binding.folderId !== plain.folderId) throw new WorktreeError('IMPORT_BINDING_MISMATCH', 'The final native/worktree/project receipt no longer matches.');
      if (row.phase !== 'ready' || record.state !== 'ready') await this.verifyCheckout(plain, this.readGit(lifetime), lifetime);
      await this.proof(proof, plain.operationId, plain.target.sessionId, plain.intentId, lifetime);
      if (row.phase !== 'ready') await this.save({ ...row, phase: 'ready', updatedAt: Date.now() });
      if (record.state !== 'ready') await this.worktrees.worktrees.put(record.id, { ...record, state: 'ready', createdAt: Math.max(record.createdAt, Date.now()), error: null });
      await this.admission(row.plan);
    }));
  }
  suspend(operationId: string, sessionId: string, intentId: string, _signal: AbortSignal): Promise<void> {
    return this.track((async () => {
      this.available();
      const own = this.journal.placements.get(operationId), plan = own?.plan ?? this.plans.get(operationId);
      if (!plan || plan.target.sessionId !== sessionId || plan.intentId !== intentId) throw new WorktreeError('IMPORT_RECEIPT_MISMATCH', 'The stopped IDs do not identify this original placement.');
      const record = await this.verifier().journal.read(sessionId);
      if (!record || record.operationId !== operationId || record.intentId !== intentId || record.target.sessionId !== sessionId || record.cancelledAt === undefined && record.phase !== 'cancelled') throw new WorktreeError('IMPORT_STOP_REQUIRED', 'The independent native journal must durably stop this exact original intent first.');
      // The synchronous veto precedes awaited metadata writes. Request abort does
      // not erase a stop already durably authorized by the independent journal.
      this.stopped.add(operationId);
      await this.save({ ...(own ?? { version: 1 as const, plan }), phase: 'cancelled', updatedAt: Date.now(), error: { code: 'IMPORT_STOPPED', message: 'The independent destination intent is durably stopped.' } });
      const worktree = this.worktrees.worktrees.get(plan.worktreeId);
      if (worktree && worktree.state !== 'missing') await this.worktrees.worktrees.put(worktree.id, { ...worktree, state: 'recovery-required', error: 'The import destination is stopped; retained effects need explicit recovery.' });
    })());
  }
  hasPending(record: WorktreeRecord): boolean {
    const row = this.journal.placements.get(record.operationId);
    if (!row || row.plan.worktreeId !== record.id) return false;
    if (this.closed || row.phase !== 'ready' || this.stopped.has(record.operationId)) return true;
    try { this.verifier(); return false; } catch { return true; }
  }
  async inspect(operationId: string, signal: AbortSignal): Promise<WorktreeImportStatus | undefined> {
    this.available(signal); const row = this.journal.placements.get(operationId); if (!row) return undefined;
    const record = this.worktrees.worktrees.get(row.plan.worktreeId), reclaimed = row.phase === 'ready' && (!record || record.state === 'missing' || this.controller.records().find(record => record.id === row.plan.worktreeId)?.cleanup?.phase === 'collected');
    return { operationId, sessionId: row.plan.target.sessionId, phase: reclaimed ? 'reclaimed' : row.phase, ...(row.receipt === undefined ? {} : { receipt: copy(row.receipt) }), ...(row.error === undefined ? {} : { reason: row.error.code }) };
  }
  async captureSource(record: WorktreeRecord, creationBase: PortableCreationBase | undefined): Promise<void> {
    const previous = this.journal.sources.get(record.id);
    if (previous) { if (previous.checkoutRoot !== record.checkoutRoot || previous.commonDir !== record.commonDir || previous.baseOid !== record.baseOid) throw new WorktreeError('SOURCE_CONTEXT_CHANGED', 'The historical source context cannot be replaced.'); return; }
    await this.journal.sources.put(record.id, sourceSchema.parse({ worktreeId: record.id, checkoutRoot: record.checkoutRoot, commonDir: record.commonDir, baseOid: record.baseOid, ...(creationBase === undefined ? {} : { creationBase }) }));
  }
  async sourceContext(sessionId: string, cwd: string, signal: AbortSignal): Promise<WorktreeSourceContext | undefined> {
    this.available(signal);
    const matches = [...this.worktrees.worktrees.entries()].map(([, row]) => row).filter(row => row.sessionIds.includes(sessionId) && row.effectiveCwd === cwd);
    if (matches.length > 1) throw new WorktreeError('SOURCE_CONTEXT_CHANGED', 'The ordinary SID has ambiguous checkout backing.');
    const record = matches[0]; if (!record) return undefined;
    await this.native(sessionId, cwd);
    await this.readGit(signal).verify(record, signal);
    const source = this.journal.sources.get(record.id), imported = this.journal.placements.get(record.operationId);
    if (source && (source.checkoutRoot !== record.checkoutRoot || source.commonDir !== record.commonDir || source.baseOid !== record.baseOid)) throw new WorktreeError('SOURCE_CONTEXT_CHANGED', 'The captured source checkout identity differs.');
    return { sessionId, cwd, commonDir: record.commonDir, provenance: imported ? 'import-placement' : 'original-checkout', ...(!imported && source?.creationBase !== undefined ? { creationBase: copy(source.creationBase) } : {}) };
  }
  async close() { if (this.closed) return; this.closed = true; this.shutdown.abort(); await Promise.allSettled([...this.flights]); await this.writes; this.plans.clear(); this.sourceIdentities.clear(); await this.bootstrap.close(); }
}
