import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { test, type TestContext } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { SubprocessRuntime, scrubbedParentEnv, type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import * as Worktrees from '@1yefuwang1/dsh-worktrees';
import type { ProjectSnapshot, WorktreeRecord } from '@1yefuwang1/dsh-worktrees';
import { coordinatorFixture } from './import-coordinator-fixture.js';
import { AcceptanceCloud, route } from './acceptance-helpers.js';
import { batchRow, cloudSession, event, sessionHeader } from './helpers.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { candidateBlobName } from '../src/sync/cloud-repository.js';
import { publicCloudError } from '../src/protocol.js';

const within = (root: string, value: string) => { const part = relative(root, value); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
async function findGit() {
  for (const folder of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) for (const name of process.platform === 'win32' ? ['git.exe', 'git.com'] : ['git']) {
    const path = resolve(folder, name);
    try { await access(path, constants.X_OK); if (!(await lstat(path)).isDirectory()) return realpath(path); } catch { /* Try the next public PATH candidate. */ }
  }
  return undefined;
}
interface ProcessCall { cwd: string; argv: readonly string[] }
/** Public subprocess implementation seam, real Git, no Host-policy fallback.
 * Fixture execution supports one observable child range (Git hooks/drivers are
 * disabled by the real Worktrees kernel). All cwd/output/time bounds are real.
 */
class OwnedGitProcesses extends SubprocessRuntime {
  private readonly running = new Set<SubprocessHandle>();
  constructor(ctx: Context, private readonly root: string, private readonly git: string, readonly calls: ProcessCall[]) {
    super(ctx);
    ctx.effect(() => async () => { for (const process of this.running) process.terminate(); await Promise.allSettled([...this.running].map(process => process.done)); });
  }
  async resolveExecutable(command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal) { signal?.throwIfAborted(); assert.ok(command === 'git' || command === this.git); return this.git; }
  async terminalEnvironment(): Promise<never> { throw new Error('No terminal in this integration fixture.'); }
  async spawnTerminal(): Promise<never> { throw new Error('No terminal in this integration fixture.'); }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted();
    const cwd = realpathSync(spec.cwd); assert.equal(cwd, spec.cwd); assert.ok(within(this.root, cwd)); assert.equal(spec.argv[0], this.git);
    assert.equal(spec.stdio.stdout, 'pipe'); assert.equal(spec.stdio.stderr, 'pipe');
    const env: NodeJS.ProcessEnv = { ...scrubbedParentEnv(), HOME: join(this.root, 'empty-home'), USERPROFILE: join(this.root, 'empty-home'), XDG_CONFIG_HOME: join(this.root, 'empty-config') };
    for (const [key, value] of Object.entries(spec.env ?? {})) { if (value === undefined) delete env[key]; else env[key] = value; }
    this.calls.push({ cwd, argv: [...spec.argv] });
    const child = spawn(this.git, spec.argv.slice(1), { cwd, env, shell: false, stdio: [spec.stdio.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let exited = false, bytes = 0, failure: Error | undefined, kill: NodeJS.Timeout | undefined;
    const terminate = () => { if (!exited) { child.kill('SIGTERM'); kill ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, Math.min(spec.graceMs, 1000)); } };
    const abort = () => terminate(); spec.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { failure = new Error('Fixture managed Git deadline.'); terminate(); }, 20000);
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', value => { bytes += value.length; if (bytes > 8 * 1024 * 1024) { failure = new Error('Fixture managed Git output bound.'); terminate(); } });
    child.on('error', error => { failure = error; });
    const done = new Promise<Awaited<SubprocessHandle['done']>>((fulfill, reject) => child.on('close', (exitCode, signal) => {
      exited = true; clearTimeout(timer); clearTimeout(kill); spec.signal?.removeEventListener('abort', abort); this.running.delete(handle);
      if (failure) reject(failure); else fulfill({ exitCode, signal });
    }));
    const handle: SubprocessHandle = { stdin: child.stdin ?? undefined, stdout: child.stdout ?? undefined, stderr: child.stderr ?? undefined, control: undefined, collected: {}, done, terminate,
      async waitForExit(signal?: AbortSignal) { if (exited) return true; if (signal?.aborted) return false; let listener!: () => void;
        const aborted = new Promise<boolean>(resolve => { listener = () => resolve(false); signal?.addEventListener('abort', listener, { once: true }); });
        try { return await Promise.race([done.then(() => true), aborted]); } finally { signal?.removeEventListener('abort', listener); }
      },
    };
    this.running.add(handle); if (spec.signal?.aborted) terminate(); return handle;
  }
}
async function setupGit(git: string, cwd: string, args: readonly string[]) {
  return new Promise<string>((fulfill, reject) => {
    const child = spawn(git, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], { cwd, shell: false, env: { ...scrubbedParentEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.on('data', value => { bytes += value.length; if (bytes > 4 * 1024 * 1024) child.kill('SIGKILL'); else out.push(value); }); child.stderr.on('data', value => err.push(value));
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Fixture setup Git ${code}: ${Buffer.concat(err)}`)); else fulfill(Buffer.concat(out).toString('utf8').trim()); });
  });
}

async function fixture(t: TestContext, sourceDirty: 'clean' | 'dirty' | 'unknown' = 'clean') {
  const git = await findGit(); assert.ok(git, 'This native cross-package gate requires installed Git.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'import-worktree-e2e-'))), repo = join(root, 'repository'), project = join(repo, 'project'), managed = join(root, 'managed');
  let host: Awaited<ReturnType<typeof coordinatorFixture>> | undefined, publicContext: Context | undefined;
  t.after(async () => { if (host) await host.close(); else await publicContext?.fiber.dispose(); assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: false }); });
  await mkdir(project, { recursive: true }); await mkdir(join(root, 'empty-home')); await mkdir(join(root, 'empty-config'));
  await setupGit(git, repo, ['init', '-b', 'release']); await writeFile(join(project, 'file.txt'), 'code at A\n'); await setupGit(git, repo, ['add', '.']); await setupGit(git, repo, ['commit', '-m', 'A']);
  const a = await setupGit(git, repo, ['rev-parse', 'HEAD']);
  await mkdir(join(project, 'nested')); await writeFile(join(project, 'nested', 'keep.txt'), 'required historical directory\n');
  await mkdir(join(project, 'history', 'deeper'), { recursive: true }); await writeFile(join(project, 'history', 'deeper', 'keep.txt'), 'another required historical directory\n');
  await writeFile(join(project, 'file.txt'), 'code at B\n'); await setupGit(git, repo, ['add', '.']); await setupGit(git, repo, ['commit', '-m', 'B']);
  const b = await setupGit(git, repo, ['rev-parse', 'HEAD']);
  const cloud = new AcceptanceCloud(), sid = SessionId(`session-${randomUUID()}`), operationId = randomUUID(), originalCwd = '/remote/repo/project';
  const queued = createUserMessage({ content: [{ type: 'text', text: 'Confirmed original cloud inbox; do not consume before Continue.' }], source: { kind: 'user' } });
  const header = sessionHeader({ id: sid, cwd: originalCwd, delegationDepth: 0 });
  const events = [event(0, 'working-directory/change', { cwd: originalCwd }), event(1, 'user/message', { content: [{ type: 'text', text: 'Uniquely tagged original cross-package history.' }] }),
    event(2, 'working-directory/change', { cwd: '/remote/repo/project/nested' }), event(3, 'session/title', { title: 'Original imported title', messageSeqs: [], source: { kind: 'user' } }),
    event(4, 'working-directory/change', { cwd: '/remote/repo/project/history/deeper' }), { type: 'agent/inbox/spliced', seq: 5, time: 1005, data: { target: 'next-turn', start: 0, inserted: [queued] } }] as SessionEvent[];
  const binding = headerHash(header, 0), genesis = genesisHash(sid, 1, binding), chain = chainEvents(genesis, events), blobName = candidateBlobName(sid, 1, 0, 1, chain.payloadHash);
  const row = batchRow(sid, 1, 0, { ...chain, eventCount: events.length, endSeq: events.length - 1, blobName });
  await cloud.putCandidate(blobName, gzipSync(payloadBytes(events)), {}); cloud.rows.set(row.rowKey, { entity: row, etag: 'e2e-row' });
  await cloud.createManifest(cloudSession({ sessionId: sid, headerJson: JSON.stringify(header), headerHash: binding, cwd: originalCwd, eventCount: events.length, headSeq: events.length - 1, chainHash: chain.chainHash, headHash: chain.headHash, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, lastBatchBlobName: blobName,
    gitJson: JSON.stringify({ v: 2, observation: { deviceId: 'source-device', observedAt: 10, generation: 1, headerHash: binding, eventCount: events.length, chainHash: chain.chainHash }, repository: { objectFormat: 'sha1', root: '/remote/repo', worktree: true }, creationBase: { kind: 'remote', ref: 'refs/heads/dev', oid: a, remote: { name: 'origin', sanitizedUrl: 'https://example.invalid/repository.git' } }, current: { headOid: b, branchRef: 'refs/heads/worktree/source', detached: false, unborn: false, dirty: sourceDirty, upstream: { kind: 'remote', ref: 'refs/heads/feature', remote: { name: 'origin', sanitizedUrl: 'https://example.invalid/repository.git' } } } }),
  }));
  const calls: ProcessCall[] = [];
  let actor!: Agent, actorHandle!: AgentHandle, policy!: { defaultMode: string; resolve(input?: { session?: Agent['session'] }): { mode: string } }, projectId = randomUUID(), folderId = '';
  let setMode!: (mode: 'read-only' | 'workspace-write' | 'danger-full-access') => Promise<void>;
  host = await coordinatorFixture(join(root, 'receiver'), cloud, { afterBoot: async ctx => {
    publicContext = ctx;
    const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-api-session-controller'));
    const sandbox = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-sandbox-policy')).href), approval = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-user-approval')).href);
    // Genuine native policy, not a copied/forged Actor or a permissive Host default.
    policy = new sandbox.SandboxPolicyService(ctx, { mode: 'read-only', workspaceRoot: project });
    new approval.ApprovalService(ctx, { policy: 'ask' });
    Object.assign(ctx.get('fs')!, { processPathFromHostPath: (path: string) => isAbsolute(path) && within(root, resolve(path)) ? resolve(path) : undefined });
    new OwnedGitProcesses(ctx, root, git, calls);
    const scope = ctx.plugin(Worktrees, { root: managed, namingEnabled: false, cleanupEnabled: false, commandTimeoutMs: 15000, operationTimeoutMs: 120000 }); await scope.await(); assert.equal(scope.state, 2);
    ctx.effect(() => () => scope.dispose());
    actorHandle = await ctx.agents.create({ sessionId: SessionId(`permission-${randomUUID()}`), meta: { cwd: project }, agentOptions: route }); actor = actorHandle.agent;
    ctx.effect(() => () => actorHandle.dispose());
    setMode = async mode => { sandbox.setSandboxMode(actor.session, mode); await ctx.sessions.flush(actor.session); };
    const result = await ctx.tools.execute({ name: 'workspace_project', callId: `project-create-${randomUUID()}` as never, arguments: { action: 'create', id: projectId, title: 'Real receiver project', folders: [project] }, agent: actor, signal: new AbortController().signal });
    assert.equal(result.isError, false); const data = result.value as unknown as { v: number; ok: boolean; data: { project: ProjectSnapshot['projects'][number] } }; assert.equal(data.ok, true); folderId = data.data.project.folders[0]!.id;
  } });
  const context = () => ({ origin: 'rpc' as const, signal: new AbortController().signal });
  const plan = (oid = b, kind: 'commit' | 'local-branch' = 'commit', id = operationId) => host!.coordinator.execute({ action: 'plan-import', sessionId: sid, generation: 1, operationId: id, gitContextVersion: 2,
    destination: { kind: 'worktree', projectId, folderId, base: kind === 'commit' ? { kind, oid } : { kind, oid, name: 'refs/heads/release' }, permissionActorId: actor.id, label: 'History placement' }, mapping: { remotePlatform: 'linux', remotePrefix: '/remote/repo' } }, context());
  async function worktreeRecords(): Promise<WorktreeRecord[]> {
    const value = await host!.ctx.tools.execute({ name: 'git_worktree', callId: `list-${randomUUID()}` as never, arguments: { action: 'list', repoPath: project, includeArchived: true }, agent: actor, signal: new AbortController().signal });
    assert.equal(value.isError, false); return (value.value as unknown as { data: { items: WorktreeRecord[] } }).data.items;
  }
  async function projects(): Promise<ProjectSnapshot> {
    const value = await host!.ctx.tools.execute({ name: 'workspace_project', callId: `projects-${randomUUID()}` as never, arguments: { action: 'list' }, agent: actor, signal: new AbortController().signal });
    assert.equal(value.isError, false); return (value.value as unknown as { data: ProjectSnapshot }).data;
  }
  return { root, repo, project, managed, git, a, b, sid, operationId, originalCwd, header, events, queued, cloud, host, actor, policy, setMode, projectId, folderId, calls, context, plan, worktreeRecords, projects };
}

for (const kind of ['commit', 'local-branch'] as const) test(`actual public coordinator→Worktrees ${kind}: same SID, blank genuine Full-access actor, exact commit/dirs/native/project readiness`, { timeout: 120000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  assert.equal(f.policy.defaultMode, 'read-only'); assert.equal(f.policy.resolve().mode, 'read-only'); assert.equal(f.policy.resolve({ session: f.actor.session }).mode, 'read-only');
  await assert.rejects(f.plan(f.b, kind), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'FULL_ACCESS_REQUIRED');
  assert.equal(await f.host.guard.journal.read(f.sid), undefined); assert.equal(await f.host.ctx.sessionPersistence.stat(f.sid), undefined);
  await f.setMode('danger-full-access');
  assert.equal(f.policy.resolve().mode, 'read-only'); assert.equal(f.policy.resolve({ session: f.actor.session }).mode, 'danger-full-access');
  assert.equal(f.actor.session.snapshotEvents().some(event => event.type === 'turn/start' || event.type === 'user/message'), false, 'permission actor remains genuinely blank');
  const capabilities = await f.host.coordinator.execute({ action: 'import-capabilities' }, f.context()); assert.equal(capabilities.kind, 'import-capabilities');
  if (capabilities.kind === 'import-capabilities') assert.equal(capabilities.worktree, true);
  const bases = await f.host.coordinator.execute({ action: 'import-bases', projectId: f.projectId, folderId: f.folderId, permissionActorId: f.actor.id }, f.context());
  assert.equal(bases.kind, 'import-bases'); if (bases.kind === 'import-bases') assert.ok(bases.branches.some(branch => branch.name === 'refs/heads/release' && branch.oid === f.b));
  const beforeHead = await setupGit(f.git, f.repo, ['rev-parse', 'HEAD']), beforeIndex = await readFile(join(f.repo, '.git', 'index'));
  const plan = await f.plan(f.b, kind); assert.equal(plan.kind, 'import-plan'); if (plan.kind !== 'import-plan') return;
  assert.equal(plan.codeMismatch, false, JSON.stringify(plan)); assert.equal(plan.baseOid, f.b);
  assert.equal(f.host.ctx.agents.list().length, 1); assert.equal(f.host.ctx.agents.get(f.sid), undefined); assert.equal(f.host.local.getSession(f.sid), undefined);
  assert.equal(await f.host.guard.journal.read(f.sid), undefined); assert.equal(f.host.ctx.workspaceRegistry.list().some(workspace => workspace.path === plan.cwd), false);
  const imported = await f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true }, f.context());
  assert.equal(imported.kind, 'import-operation'); if (imported.kind !== 'import-operation') return;
  assert.equal(imported.phase, 'ready', JSON.stringify(imported)); assert.equal(imported.pendingInput, true); assert.equal(imported.baseOid, f.b);
  const journal = (await f.host.guard.journal.read(f.sid))!;
  assert.equal(journal.phase, 'ready'); assert.equal(journal.placement?.bound, true); assert.equal(journal.placement?.revision, 2); assert.ok(journal.placement?.workspaceId);
  const record = (await f.worktreeRecords()).find(value => value.id === imported.worktreeId); assert.ok(record);
  assert.deepEqual(record.sessionIds, [f.sid]); assert.equal(record.effectiveCwd, plan.cwd); assert.equal(record.workspaceId, journal.binding?.workspaceId);
  assert.equal(record.firstMessageNaming, undefined); assert.equal(record.state, 'ready'); assert.equal(record.baseOid, f.b);
  assert.equal(await setupGit(f.git, record.checkoutRoot, ['rev-parse', 'HEAD']), f.b);
  assert.equal(await readFile(join(record.effectiveCwd, 'nested', 'keep.txt'), 'utf8'), 'required historical directory\n');
  assert.equal(await readFile(join(record.effectiveCwd, 'history', 'deeper', 'keep.txt'), 'utf8'), 'another required historical directory\n');
  const workspace = f.host.ctx.workspaceRegistry.list().find(value => value.path === plan.cwd); assert.deepEqual(workspace?.sessionIds, [f.sid]);
  const project = (await f.projects()).bindings.find(value => value.sessionId === f.sid); assert.equal(project?.projectId, f.projectId); assert.equal(project.folderId, f.folderId); assert.equal(project.mode, 'worktree'); assert.equal(project.worktreeId, record.id);
  const snapshot = await f.host.source.read(f.sid); assert.ok(snapshot); assert.deepEqual(snapshot.header, { ...f.header, cwd: plan.cwd });
  const localized = f.events.map(value => value.type === 'working-directory/change' ? { ...value, data: { ...value.data, cwd: value.data.cwd.replace('/remote/repo', record.checkoutRoot) } } : value);
  assert.deepEqual(snapshot.events, localized, 'all IDs, sequences, timestamps, text and pending-input identity survive; only native cwd fields localize');
  assert.equal(snapshot.inheritedEventCount, 0); assert.equal(f.host.local.getSession(f.sid)?.destination?.phase, 'ready');
  assert.equal(f.host.ctx.agents.get(f.sid), undefined); assert.equal(f.host.ctx.agents.list().length, 1); assert.equal(f.host.llmCalls, 0); assert.equal(f.cloud.activeLeases.size, 0);
  assert.equal(f.actor.session.header.cwd, f.project); assert.equal(f.actor.session.snapshotEvents().some(value => value.type === 'user/message' || value.type === 'turn/start'), false);
  assert.equal(await setupGit(f.git, f.repo, ['rev-parse', 'HEAD']), beforeHead); assert.deepEqual(await readFile(join(f.repo, '.git', 'index')), beforeIndex);
  assert.equal(f.calls.some(call => call.argv.includes('fetch') || call.argv.includes('ls-remote')), false);
  const opened = await f.host.native.page({ address: { kind: 'session', sessionId: f.sid }, throughSeq: f.events.length - 1 }, new AbortController().signal); assert.ok(opened.records.length > 0);
  const denied = await f.host.native.resolveAgent(f.sid); assert.ok('error' in denied); assert.equal(f.host.ctx.agents.get(f.sid), undefined); assert.equal(f.host.llmCalls, 0);
  if (kind === 'commit') {
    await assert.rejects(f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: imported.revision, confirm: true }, f.context()), error => publicCloudError(error).code === 'CONFIRM_REQUIRED');
    const continued = await f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: imported.revision, confirm: true, acknowledgePendingInput: true }, f.context()); assert.equal(continued.kind, 'import-operation');
    const target = f.host.ctx.agents.get(f.sid); assert.ok(target); await target.whenIdle(); assert.equal(f.host.llmCalls, 1);
    assert.equal(target.session.header.id, f.sid); assert.equal(target.session.header.cwd, plan.cwd); assert.deepEqual(target.inbox.nextTurn, []);
    assert.equal(target.session.snapshotEvents().filter(value => value.type === 'user/message' && value.data.id === f.queued.id).length, 1);
    assert.equal(f.policy.resolve({ session: target.session }).mode, 'read-only', 'permission actor Full access was never copied to imported execution');
  }
});

for (const sourceDirty of ['dirty', 'unknown'] as const) test(`actual public coordinator matching B with ${sourceDirty} SOURCE requires separate code acknowledgement before all effects`, { timeout: 120000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, sourceDirty); await f.setMode('danger-full-access');
  assert.equal(f.policy.defaultMode, 'read-only'); assert.equal(f.policy.resolve({ session: f.actor.session }).mode, 'danger-full-access');
  const beforeHead = await setupGit(f.git, f.repo, ['rev-parse', 'HEAD']), beforeIndex = await readFile(join(f.repo, '.git', 'index'));
  const plan = await f.plan(f.b); assert.equal(plan.kind, 'import-plan'); if (plan.kind !== 'import-plan') return;
  assert.equal(plan.baseOid, f.b); assert.equal(plan.sourceGit?.v, 2);
  if (plan.sourceGit?.v !== 2) return;
  assert.equal(plan.sourceGit.current.headOid, f.b, 'source HEAD exactly matches the receiving selected commit');
  assert.equal(plan.sourceGit.current.dirty, sourceDirty); assert.equal(plan.sourceGit.observation.headerHash, headerHash(f.header, 0));
  assert.equal(plan.sourceGit.observation.generation, 1); assert.equal(plan.sourceGit.observation.eventCount, f.events.length);
  const committed = await f.cloud.asRepository().getManifest(f.sid); assert.ok(committed);
  assert.equal(plan.sourceGit.observation.chainHash, committed.entity.chainHash, 'warning is based on exact current anchored v2 observation, not stale/no Git fallback');
  assert.equal(plan.codeMismatch, true, 'matching commit alone cannot assert that SOURCE working-tree bytes were restored');
  assert.deepEqual([...plan.warnings].sort(), ['code-snapshot-differs-or-source-unverified', 'uncommitted-source-files-are-not-restored', sourceDirty === 'dirty' ? 'source-working-tree-dirty' : 'source-working-tree-unknown'].sort());
  const commit = { action: 'commit-import' as const, sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true as const };
  const callsBeforeRefusal = f.calls.length;
  await assert.rejects(f.host.coordinator.execute(commit, f.context()), error => publicCloudError(error).code === 'CONFIRM_REQUIRED');
  assert.equal(f.calls.slice(callsBeforeRefusal).some(call => call.argv.includes('update-ref') || call.argv.includes('worktree') && call.argv.includes('add')), false, 'code acknowledgement refusal precedes every managed Git pin/add');
  assert.equal(await stat(f.managed).then(() => true, () => false), false, 'no managed checkout or private placement claim path is allocated');
  assert.equal(await f.host.guard.journal.read(f.sid), undefined); assert.equal(await f.host.ctx.worktreeImportPlacement.inspect(f.operationId, new AbortController().signal), undefined);
  assert.equal(await f.host.ctx.sessionPersistence.stat(f.sid), undefined); assert.equal(f.host.local.getSession(f.sid), undefined);
  assert.equal(f.host.ctx.workspaceRegistry.list().some(value => value.path === plan.cwd), false);
  assert.deepEqual(await f.worktreeRecords(), []); assert.equal((await f.projects()).bindings.some(value => value.sessionId === f.sid), false);
  assert.equal(f.host.ctx.agents.get(f.sid), undefined); assert.equal(f.host.ctx.agents.list().length, 1); assert.equal(f.host.llmCalls, 0);
  // The SAME reviewed plan succeeds only after the separate explicit code
  // acknowledgement. It neither acknowledges pending input nor grants execution.
  const imported = await f.host.coordinator.execute({ ...commit, acknowledgeCodeMismatch: true }, f.context());
  assert.equal(imported.kind, 'import-operation'); if (imported.kind !== 'import-operation') return;
  assert.equal(imported.phase, 'ready', JSON.stringify(imported)); assert.equal(imported.baseOid, f.b); assert.equal(imported.pendingInput, true);
  const journal = (await f.host.guard.journal.read(f.sid))!;
  assert.equal(journal.phase, 'ready'); assert.equal(journal.codeMismatchAcknowledged, true); assert.equal(journal.placement?.bound, true); assert.equal(journal.placement?.revision, 2);
  const record = (await f.worktreeRecords()).find(value => value.id === imported.worktreeId); assert.ok(record);
  assert.equal(await setupGit(f.git, record.checkoutRoot, ['rev-parse', 'HEAD']), f.b); assert.equal(await readFile(join(record.effectiveCwd, 'file.txt'), 'utf8'), 'code at B\n');
  assert.equal(record.firstMessageNaming, undefined); assert.deepEqual(record.sessionIds, [f.sid]); assert.equal(record.state, 'ready');
  assert.deepEqual(f.host.ctx.workspaceRegistry.list().find(value => value.path === plan.cwd)?.sessionIds, [f.sid]);
  const snapshot = await f.host.source.read(f.sid); assert.ok(snapshot);
  assert.deepEqual(snapshot.header, { ...f.header, cwd: plan.cwd });
  assert.deepEqual(snapshot.events, f.events.map(value => value.type === 'working-directory/change' ? { ...value, data: { ...value.data, cwd: value.data.cwd.replace('/remote/repo', record.checkoutRoot) } } : value));
  assert.equal(snapshot.events.some(value => value.type === 'sandbox/mode'), false, 'Full permission actor metadata never enters imported history');
  assert.equal(f.host.ctx.agents.get(f.sid), undefined); assert.equal(f.host.llmCalls, 0); assert.equal(f.cloud.activeLeases.size, 0);
  assert.equal(f.actor.session.header.cwd, f.project); assert.equal(f.actor.session.snapshotEvents().some(value => value.type === 'user/message' || value.type === 'turn/start'), false);
  assert.equal(await setupGit(f.git, f.repo, ['rev-parse', 'HEAD']), beforeHead); assert.deepEqual(await readFile(join(f.repo, '.git', 'index')), beforeIndex);
  assert.equal(f.calls.some(call => call.argv.includes('fetch') || call.argv.includes('ls-remote')), false);
  const denied = await f.host.native.resolveAgent(f.sid); assert.ok('error' in denied); assert.equal(f.host.ctx.agents.get(f.sid), undefined);
  await assert.rejects(f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: imported.revision, confirm: true }, f.context()), error => publicCloudError(error).code === 'CONFIRM_REQUIRED');
  assert.equal(f.host.llmCalls, 0, 'code acknowledgement is never implicit pending-input or model permission');
  const continued = await f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: imported.revision, confirm: true, acknowledgePendingInput: true }, f.context());
  assert.equal(continued.kind, 'import-operation'); const target = f.host.ctx.agents.get(f.sid); assert.ok(target); await target.whenIdle();
  assert.equal(f.host.llmCalls, 1); assert.equal(f.policy.resolve({ session: target.session }).mode, 'read-only', 'permission actor Full access is not copied after acknowledged import');
  assert.equal(target.session.snapshotEvents().filter(value => value.type === 'user/message' && value.data.id === f.queued.id).length, 1);
});

test('actual public coordinator rejects missing historical commit directories before any native reservation/Git effect', { timeout: 120000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.setMode('danger-full-access');
  const before = f.calls.length;
  await assert.rejects(f.plan(f.a), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'IMPORT_DIRECTORY_MISSING');
  assert.equal(await f.host.guard.journal.read(f.sid), undefined); assert.equal(await f.host.ctx.sessionPersistence.stat(f.sid), undefined); assert.equal(f.host.local.getSession(f.sid), undefined);
  assert.equal(f.calls.slice(before).some(call => call.argv.includes('update-ref') || call.argv.includes('worktree')), false);
  assert.equal(f.host.ctx.agents.get(f.sid), undefined); assert.equal(f.host.llmCalls, 0);
});
