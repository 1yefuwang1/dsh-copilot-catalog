import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { GitOperations } from '../src/git.js';
import { WorktreeController } from '../src/service.js';
import { ProjectController } from '../src/projects.js';
import { WorktreeImportPlacement, importPlacementDomain, type ImportPlacementStore } from '../src/import-placement.js';
import { worktreeDomain, type WorktreeStore } from '../src/store.js';
import { WorktreeError } from '../src/errors.js';
import type { GitExecutor, GitRunSpec, WorktreeConfig, WorktreeRecord } from '../src/types.js';
import type { VerifiedImportProof, WorktreeImportRequest, WorktreeImportReceipt } from '../src/import-contract.js';
import { sanitizePortableRemote } from '../src/portable-source.js';
import { sanitizeGitRemote } from '../../azure-sync/src/git/sanitize.js';
import { ImportGuardV1, importFence } from '../../azure-sync/src/import/guard.js';
import { headerHash } from '../../azure-sync/src/sync/chain.js';
import { payloadHash } from '../../azure-sync/src/sync/canonical.js';
import { header, history, nativeHost, persistenceHost, route } from '../../azure-sync/test/import-native-fixture.js';
import { tempDirectory, tmpBase } from './helpers.js';

/** Bounded native Git, exclusively inside the fixture's canonical temporary tree. */
function executor(root: string, calls: GitRunSpec[]): GitExecutor {
  return async spec => {
    assert.ok((await realpath(spec.cwd)).startsWith(`${root}${sep}`) || spec.cwd === root);
    calls.push(spec);
    const env = { ...process.env };
    for (const [key, value] of Object.entries(spec.env ?? {})) { if (value === undefined) delete env[key]; else env[key] = value; }
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...spec.args], { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let failure: Error | undefined, size = 0;
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const timeout = setTimeout(() => { failure = new Error('fixture Git timeout'); child.kill('SIGKILL'); }, spec.timeoutMs ?? 10000);
      const abort = () => { failure = new Error('fixture Git aborted'); child.kill('SIGKILL'); };
      spec.signal?.addEventListener('abort', abort, { once: true });
      const collect = (list: Buffer[]) => (value: Buffer) => { size += value.length; if (size > (spec.maxBytes ?? 4 * 1024 * 1024)) { failure = new Error('fixture Git output bound'); child.kill('SIGKILL'); } else list.push(value); };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr)); child.on('error', error => { failure = error; });
      child.on('close', code => {
        clearTimeout(timeout); spec.signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code === null || !(spec.allowedExitCodes ?? [0]).includes(code)) reject(new Error(`fixture Git exit ${code}: ${Buffer.concat(stderr)}`));
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code });
      });
      child.stdin.on('error', () => {}); child.stdin.end(spec.stdin);
      if (spec.signal?.aborted) abort();
    });
  };
}
async function fixture(t: TestContext) {
  const root = await tempDirectory('worktree-import-placement-');
  assert.equal(dirname(root), tmpBase);
  const repo = join(root, 'repo'), cwd = join(repo, 'project'), managed = join(root, 'managed');
  await mkdir(cwd, { recursive: true });
  const calls: GitRunSpec[] = [], exec = executor(root, calls);
  const git = async (cwd: string, ...args: string[]) => (await exec({ cwd, args: ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args] })).stdout.toString('utf8').trim();
  await git(repo, 'init', '-b', 'release'); await writeFile(join(cwd, 'file.txt'), 'commit A\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'A');
  const a = await git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(cwd, 'file.txt'), 'commit B\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'B');
  const b = await git(repo, 'rev-parse', 'HEAD');
  const config: WorktreeConfig = { root: managed, gitExecutable: 'git', defaultRemote: 'origin', defaultBranch: 'main', commandTimeoutMs: 10000, fetchTimeoutMs: 10000, operationTimeoutMs: 60000, maxSnapshotBytes: 4 * 1024 * 1024, maxFiles: 1000, maxRefBytes: 1024 * 1024, namingEnabled: false, cleanupEnabled: false };
  const host = await nativeHost(join(root, 'host'), cwd);
  const actorHandle = await host.ctx.agents.create({ sessionId: SessionId(`actor-${randomUUID()}`), meta: { cwd }, agentOptions: route });
  const actor = actorHandle.agent;
  const policy = { mode: 'danger-full-access', workspaceRoot: cwd };
  actor.ctx.provide('sandboxPolicy', { resolve: () => policy });
  // Complete this bench's explicit local-filesystem provider contract; this is
  // fixture adapter setup, not a core/private sink or execution-policy bypass.
  Object.assign(host.ctx.get('fs')!, { processPathFromHostPath: (path: string) => path });
  const worktreeDomainHandle = await host.facility.open(worktreeDomain);
  const store: WorktreeStore = { worktrees: worktreeDomainHandle.table('worktrees'), operations: worktreeDomainHandle.table('operations'), close: () => worktreeDomainHandle.close() };
  const importDomainHandle = await host.facility.open(importPlacementDomain);
  const journal: ImportPlacementStore = { placements: importDomainHandle.table('placements'), sources: importDomainHandle.table('sources'), close: () => importDomainHandle.close() };
  let controller!: WorktreeController, port!: WorktreeImportPlacement;
  const projects = new ProjectController(host.ctx, host.projectStore, { records: () => controller.records() });
  const engine = (guard: () => void = () => {}, admission: () => Promise<void> = async () => {}) => new GitOperations(async spec => { await admission(); guard(); return exec(spec); }, config, guard);
  controller = new WorktreeController(host.ctx, config, store, { projects, git: (_actor, _signal, guard) => engine(guard), importPending: record => port.hasPending(record), captureSource: (record, base) => port.captureSource(record, base) });
  const guard = await ImportGuardV1.open({ root: join(root, 'guard') });
  const detach = guard.attachPersistence({ identity: host.ctx.sessionPersistence.identity, stat: id => host.ctx.sessionPersistence.stat(SessionId(id)), list: () => host.ctx.sessionPersistence.list(), async coldRead(id) {
    const cold = await persistenceHost(join(root, 'host', 'logs'));
    try { const read = await cold.persistence.open(SessionId(id), 'read'); try { return { header: read.header, inheritedEventCount: read.inheritedEventCount, events: (await read.read()).events }; } finally { await read.close(); } }
    finally { await cold.close(); }
  } });
  const registration = guard.registerCoordinator({ version: 1, ready: () => true });
  port = new WorktreeImportPlacement(host.ctx, config, store, journal, controller, projects, { git: (_actor, guard, admit) => engine(guard, admit), readGit: guard => engine(guard), verifier: () => guard });
  await projects.ensureFolder(cwd);
  const folder = projects.folderForPath(cwd)!;
  const context = { actor, origin: 'ui' as const, signal: new AbortController().signal };
  const request = (oid = b): WorktreeImportRequest => {
    const id = `cloud-${randomUUID()}`, originalHeader = header(id, '/remote/repo/project');
    return { operationId: randomUUID(), target: { scope: 'fixture-account', sessionId: id, generation: 1, headerHash: headerHash(originalHeader, 0 as never), inheritedEventCount: 0, eventCount: 2, chainHash: 'c'.repeat(64) }, intentId: randomUUID(), projectId: folder.projectId, folderId: folder.folderId, base: { kind: 'commit', oid } };
  };
  const claims: Array<{ release(): Promise<void> }> = [];
  const reservations = new Map<string, { claim: Awaited<ReturnType<typeof guard.claims.acquire>>; record: Awaited<ReturnType<typeof registration.reserve>> }>();
  async function reserve(receipt: Pick<WorktreeImportReceipt, 'operationId' | 'requestHash' | 'target' | 'intentId' | 'effectiveCwd' | 'checkoutRoot' | 'projectId' | 'folderId'>) {
    const prior = reservations.get(receipt.operationId); if (prior) return prior;
    const id = receipt.target.sessionId, targetHeader = header(id, receipt.effectiveCwd);
    const claim = await guard.claims.acquire(id, receipt.operationId); claims.push(claim);
    const record = await registration.reserve(claim, { version: 1, operationId: receipt.operationId, requestHash: receipt.requestHash, target: receipt.target, intentId: receipt.intentId, intentRevision: 0, revision: 0, mode: 'worktree', finalCwd: receipt.effectiveCwd, localHeaderHash: headerHash(targetHeader, 0 as never), mapping: { id: randomUUID(), revision: 'a'.repeat(64), remotePlatform: 'linux', remotePrefix: '/remote/repo', localRoot: receipt.checkoutRoot }, sourceFolder: { projectId: receipt.projectId, folderId: receipt.folderId, path: cwd }, phase: 'reserved', effects: [], createdAt: Date.now(), updatedAt: Date.now() });
    const value = { claim, record }; reservations.set(receipt.operationId, value); return value;
  }
  async function materialize(receipt: WorktreeImportReceipt) {
    const { claim, record } = await reserve(receipt);
    const targetHeader = header(receipt.target.sessionId, receipt.effectiveCwd), events = history(receipt.effectiveCwd).events;
    await registration.withWrite(claim, importFence(record), context.signal, async () => {
      const handle = await host.ctx.sessionPersistence.create(targetHeader); await handle.append(events); await handle.flush(); await handle.close();
    });
    const artifact = { headerHash: record.localHeaderHash, inheritedEventCount: 0, prefixCount: events.length, prefixHash: payloadHash(events) };
    const current = await guard.journal.update(claim, importFence(record), value => ({ ...value, artifact, phase: 'history-verified', revision: value.revision + 1, updatedAt: Date.now() }));
    const proof = await registration.proveReadable(claim, importFence(current), artifact);
    return { claim, record: current, proof };
  }
  t.after(async () => {
    await port.close(); await controller.close(); await projects.close(); await actorHandle.dispose(); for (const claim of claims) await claim.release(); registration.unregister(); detach(); guard.close(); await journal.close(); await store.close(); await host.close();
    assert.equal(await realpath(root), root); assert.equal(dirname(root), tmpBase); await rm(root, { recursive: true, force: false });
  });
  return { root, repo, cwd, managed, a, b, calls, exec, git, engine, config, host, actor, policy, store, journal, projects, controller, port, guard, registration, context, request, reserve, materialize };
}
const code = (value: string) => (error: unknown) => error instanceof WorktreeError && error.code === value;

// No network/cloud, source checkout mutation, prompt, naming, or target Agent is
// part of placement. All Git writes below target fixture-owned temporary repos.
test('same-SID placement provisions exact locally available object, binds native/project history, and blocks lifecycle until Ready', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), request = f.request(f.a);
  await f.git(f.repo, 'branch', 'only-B', f.b); // A is locally available without a local branch naming it.
  const sourceIndex = await readFile(join(f.repo, '.git', 'index')), sourceHead = await f.git(f.repo, 'rev-parse', 'HEAD');
  await writeFile(join(f.cwd, 'file.txt'), 'dirty source must stay\n');
  const sourceStatus = await f.git(f.repo, 'status', '--porcelain=v1', '-z');
  const before = f.calls.length, plan = await f.port.plan(request, f.context);
  assert.equal(await stat(f.managed).then(() => true, () => false), false, 'preview creates no files/workspace/checkout/journal');
  assert.equal(f.journal.placements.get(plan.operationId), undefined);
  await f.reserve(plan);
  const [receipt, replay] = await Promise.all([f.port.provision(plan, f.context), f.port.provision(plan, f.context)]);
  assert.deepEqual(replay, receipt);
  assert.equal(await readFile(join(receipt.effectiveCwd, 'file.txt'), 'utf8'), 'commit A\n');
  assert.equal(receipt.effectiveCwd, join(receipt.checkoutRoot, 'project'));
  assert.equal(await f.git(receipt.checkoutRoot, 'rev-parse', 'HEAD'), f.a);
  assert.equal(await f.git(receipt.checkoutRoot, 'symbolic-ref', '--short', 'HEAD'), plan.branch);
  assert.equal((await f.port.inspect(plan.operationId, f.context.signal))?.phase, 'prepared');
  const record = f.store.worktrees.get(plan.worktreeId)!;
  assert.equal(f.controller.hasPendingEffects(record), true); assert.equal(record.state, 'creating');
  assert.deepEqual(record.sessionIds, []); assert.equal(record.firstMessageNaming, undefined);
  assert.equal(receipt.workspaceId, undefined); assert.equal(record.workspaceId, null);
  assert.equal(f.host.ctx.workspaceRegistry.list().some(value => value.path === receipt.effectiveCwd), false, 'provision does not advertise a pending native workspace');
  assert.equal([...f.store.operations.entries()].length, 0, 'no fake legacy create/settings operation');
  for (const action of ['start', 'handoff'] as const) await assert.rejects(f.controller.execute({ action, id: record.id, ...(action === 'handoff' ? { operationId: randomUUID(), previewId: randomUUID() } : {}) }, { agent: f.actor, origin: 'ui', signal: f.context.signal }), code('IMPORT_PENDING'));
  assert.equal(f.host.ctx.agents.list().length, 1); assert.equal(f.host.ctx.agents.get(SessionId(request.target.sessionId)), undefined); assert.equal(f.host.llmCalls, 0);
  const { proof } = await f.materialize(receipt);
  await assert.rejects(f.port.bindImported(receipt, { operationId: plan.operationId, sessionId: request.target.sessionId, intentId: plan.intentId } as VerifiedImportProof, f.context.signal), code('IMPORT_PROOF_REQUIRED'));
  const bound = await f.port.bindImported(receipt, proof, f.context.signal);
  assert.equal(f.controller.hasPendingEffects(f.store.worktrees.get(plan.worktreeId)!), true);
  assert.equal(bound.revision, 2); assert.ok(bound.workspaceId);
  assert.deepEqual(f.host.ctx.workspaceRegistry.get(bound.workspaceId as never)?.sessionIds, [request.target.sessionId]);
  assert.deepEqual(await f.port.bindImported(receipt, proof, f.context.signal), bound, 'prepared revision1 retry adopts the actual bound revision2 without another workspace ID');
  assert.equal(f.projects.bindingFor(request.target.sessionId, receipt.effectiveCwd)?.worktreeId, plan.worktreeId);
  await f.port.acknowledgeReady(bound, proof, f.context.signal);
  assert.equal(f.controller.hasPendingEffects(f.store.worktrees.get(plan.worktreeId)!), false);
  assert.equal(f.store.worktrees.get(plan.worktreeId)?.state, 'ready');
  assert.equal((await f.port.inspect(plan.operationId, f.context.signal))?.phase, 'ready');
  assert.deepEqual(await f.port.sourceContext(request.target.sessionId, receipt.effectiveCwd, f.context.signal), { sessionId: request.target.sessionId, cwd: receipt.effectiveCwd, commonDir: receipt.commonDir, provenance: 'import-placement' });
  assert.equal(await f.port.classifyPath(receipt.effectiveCwd, 'another-thread', f.context.signal), 'managed-other');
  assert.equal(await f.port.classifyPath(receipt.effectiveCwd, request.target.sessionId, f.context.signal), 'managed-self');
  assert.deepEqual(await readFile(join(f.repo, '.git', 'index')), sourceIndex); assert.equal(await f.git(f.repo, 'rev-parse', 'HEAD'), sourceHead); assert.equal(await f.git(f.repo, 'status', '--porcelain=v1', '-z'), sourceStatus);
  assert.equal(f.calls.slice(before).some(call => call.args.includes('fetch') || call.args.includes('ls-remote')), false);
  assert.equal(f.actor.session.header.cwd, f.cwd); assert.equal(f.host.llmCalls, 0);
  const readyRecord = f.store.worktrees.get(plan.worktreeId)!;
  await f.port.acknowledgeReady(bound, proof, f.context.signal);
  assert.equal(f.store.worktrees.get(plan.worktreeId)?.createdAt, readyRecord.createdAt, 'Ready replay does not refresh inactivity age');
  await f.store.worktrees.put(plan.worktreeId, { ...readyRecord, state: 'missing' });
  assert.equal((await f.port.inspect(plan.operationId, f.context.signal))?.phase, 'reclaimed');
  await assert.rejects(f.port.acknowledgeReady(bound, proof, f.context.signal), code('IMPORT_RECLAIMED'));
  await assert.rejects(f.port.provision(plan, f.context), code('IMPORT_BINDING_MISMATCH'));
  assert.equal(f.store.worktrees.get(plan.worktreeId)?.state, 'missing', 'old Ready receipts cannot resurrect reclaimed backing');
});

test('moving reviewed refs, missing/wrong object types, forged plans and changed actor policy refuse before checkout', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), request = { ...f.request(), base: { kind: 'local-branch' as const, name: 'refs/heads/release', oid: f.b } };
  const plan = await f.port.plan(request, f.context); await f.reserve(plan);
  await f.git(f.repo, 'branch', '-f', 'release-other', f.a);
  await f.git(f.repo, 'update-ref', 'refs/heads/release', f.a);
  await assert.rejects(f.port.provision(plan, f.context), code('BRANCH_CHANGED'));
  assert.equal(f.journal.placements.get(plan.operationId), undefined);
  await f.git(f.repo, 'update-ref', 'refs/heads/release', f.b);
  await assert.rejects(f.port.provision({ ...plan, target: { ...plan.target, sessionId: 'forged' } }, f.context), code('INVALID_IMPORT_PLAN'));
  f.policy.mode = 'workspace-write';
  await assert.rejects(f.port.provision(plan, f.context), code('FULL_ACCESS_REQUIRED'));
  assert.equal(await stat(f.managed).then(() => true, () => false), false);
  f.policy.mode = 'danger-full-access';
  const blob = await f.git(f.repo, 'rev-parse', 'HEAD:project/file.txt');
  for (const oid of [blob, '0'.repeat(40), 'a'.repeat(64)]) await assert.rejects(f.port.plan({ ...f.request(), base: { kind: 'commit', oid } }, f.context));
});

test('two cloud SIDs with identical remote cwd get distinct destinations; current HEAD branch and raw commit choices never fetch', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), requestA = { ...f.request(), base: { kind: 'head' as const, oid: f.b } }, requestB = f.request(f.a);
  const planA = await f.port.plan(requestA, f.context), planB = await f.port.plan(requestB, f.context);
  await f.reserve(planA); await f.reserve(planB);
  const a = await f.port.provision(planA, f.context), b = await f.port.provision(planB, f.context);
  assert.notEqual(a.checkoutRoot, b.checkoutRoot); assert.notEqual(a.branch, b.branch);
  assert.equal(await f.git(a.checkoutRoot, 'rev-parse', 'HEAD'), f.b); assert.equal(await f.git(b.checkoutRoot, 'rev-parse', 'HEAD'), f.a);
  assert.equal(f.host.ctx.agents.list().length, 1); assert.equal(f.host.llmCalls, 0);
  assert.equal(f.calls.some(call => call.args.includes('fetch')), false);
});

test('normal local-base capture retains selected release/A and upstreamAtCreation dev after config/checkout changes while cloud Off', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await f.git(f.repo, 'remote', 'add', 'origin', ['https://', 'user:secret@', 'example.invalid/repo.git?token=secret#fragment'].join(''));
  await f.git(f.repo, 'config', 'branch.release.remote', 'origin'); await f.git(f.repo, 'config', 'branch.release.merge', 'refs/heads/dev');
  await f.git(f.repo, 'update-ref', 'refs/remotes/origin/dev', f.b);
  const repo = await f.engine().discover(f.cwd), id = randomUUID(), destination = join(f.root, 'normal-managed');
  const created = await f.engine().create({ id, repository: repo, destination, branchSource: 'local', localBranch: 'release', localOid: f.b, baseRef: `refs/dsh-worktrees/${id}/base` });
  assert.deepEqual(created.creationBase, { kind: 'local', ref: 'refs/heads/release', oid: f.b, upstreamAtCreation: { ref: 'refs/heads/dev', remote: { name: 'origin', sanitizedUrl: 'https://example.invalid/repo.git' } } });
  const { creationBase, ...checkout } = created;
  const sid = `normal-${randomUUID()}`;
  const record: WorktreeRecord = { id, operationId: randomUUID(), repoRoot: repo.root, commonDir: repo.commonDir, projectSubdir: repo.projectSubdir, ...checkout, createdAt: Date.now(), remote: 'local', remoteIdentity: 'never-export-this', remoteBranch: 'release', branchSource: 'local', localBranch: 'release', sessionIds: [sid], workspaceId: null, branch: null, protected: false, archived: false, state: 'ready', error: null };
  await f.store.worktrees.put(id, record); await f.port.captureSource(record, creationBase);
  const native = await f.host.ctx.sessionPersistence.create(header(sid, created.effectiveCwd)); await native.append(history(created.effectiveCwd).events); await native.flush(); await native.close();
  await f.git(f.repo, 'config', 'branch.release.merge', 'refs/heads/changed-later');
  await f.git(destination, 'switch', '-c', 'generated/current'); await writeFile(join(created.effectiveCwd, 'file.txt'), 'later C\n'); await f.git(destination, 'add', '.'); await f.git(destination, 'commit', '-m', 'C');
  const context = await f.port.sourceContext(sid, created.effectiveCwd, f.context.signal);
  assert.deepEqual(context?.creationBase, created.creationBase);
  assert.equal(JSON.stringify(context).includes('never-export-this'), false); assert.equal(JSON.stringify(context).includes('secret'), false); assert.equal(JSON.stringify(context).includes(record.baseRef), false);
  await f.journal.sources.delete(id); // Legacy absence remains unknown, never derived from today's upstream.
  assert.equal((await f.port.sourceContext(sid, created.effectiveCwd, f.context.signal))?.creationBase, undefined);
});

test('ALL historical cwd directories are literal bounded trees before any managed ref/path effect', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), request = f.request();
  const before = f.calls.length;
  for (const requiredDirectories of [['missing'], ['project/file.txt'], ['../escape'], ['/outside'], ['project/../project'], ['.git'], ['project/.GIT/objects'], ['project/*'], ['project\\\\nested'], Array.from({ length: 257 }, (_, index) => `dir-${index}`)]) {
    await assert.rejects(f.port.plan({ ...request, operationId: randomUUID(), requiredDirectories }, f.context));
  }
  const repository = await f.engine().discover(f.cwd);
  await assert.rejects(f.engine().create({ id: 'missing-directory', repository, destination: join(f.root, 'must-not-exist'), baseRef: 'refs/dsh-worktrees/missing-directory/base', branchSource: 'commit', commitOid: f.b, requiredDirectories: ['missing'] }), code('IMPORT_DIRECTORY_MISSING'));
  assert.equal(f.calls.slice(before).some(call => call.args.includes('update-ref') || call.args.includes('worktree')), false);
  assert.equal(await stat(f.managed).then(() => true, () => false), false);
  const plan = await f.port.plan({ ...request, requiredDirectories: ['', 'project'] }, f.context);
  assert.deepEqual(plan.requiredDirectories, ['', 'project']);
  if (process.platform !== 'win32') {
    await symlink('project', join(f.repo, 'alias')); await f.git(f.repo, 'add', 'alias'); await f.git(f.repo, 'commit', '-m', 'internal symlink');
    const oid = await f.git(f.repo, 'rev-parse', 'HEAD');
    await assert.rejects(f.port.plan({ ...f.request(oid), requiredDirectories: ['alias'] }, f.context), code('IMPORT_SYMLINK_CWD_UNSUPPORTED'));
    assert.equal(await stat(f.managed).then(() => true, () => false), false);
  }
});

test('cancelled native issuer proof cannot bind or acknowledge Ready and keeps cleanup excluded', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), plan = await f.port.plan(f.request(), f.context); await f.reserve(plan);
  const receipt = await f.port.provision(plan, f.context);
  const { claim, record, proof } = await f.materialize(receipt);
  const bound = await f.port.bindImported(receipt, proof, f.context.signal);
  await assert.rejects(f.port.suspend(plan.operationId, plan.target.sessionId, plan.intentId, f.context.signal), code('IMPORT_STOP_REQUIRED'));
  await f.guard.journal.cancel(claim, importFence(record), { intentId: randomUUID(), intentRevision: 1 });
  await f.port.suspend(plan.operationId, plan.target.sessionId, plan.intentId, AbortSignal.abort());
  await assert.rejects(f.port.acknowledgeReady(bound, proof, f.context.signal), code('IMPORT_STOPPED'));
  await assert.rejects(f.port.bindImported(receipt, proof, f.context.signal), code('IMPORT_STOPPED'));
  assert.equal((await f.port.inspect(plan.operationId, f.context.signal))?.receipt?.worktreeId, receipt.worktreeId, 'stopping retains the exact known Git receipt');
  assert.equal(f.store.worktrees.get(plan.worktreeId)?.state, 'recovery-required');
  assert.equal(f.controller.hasPendingEffects(f.store.worktrees.get(plan.worktreeId)!), true);
  assert.equal(f.host.ctx.agents.get(SessionId(plan.target.sessionId)), undefined);
});

test('late ignored-abort checkout is journaled and exact prepared identity is adopted without another worktree add', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), cancel = new AbortController();
  const port = new WorktreeImportPlacement(f.host.ctx, f.config, f.store, f.journal, f.controller, f.projects, {
    git: (_actor, guard, admit) => new GitOperations(async spec => {
      await admit();
      const result = await f.exec({ ...spec, signal: undefined }); // Adversarial provider ignores request abort.
      if (spec.args.includes('worktree') && spec.args.includes('add')) cancel.abort(new Error('cancel-after-actual-add'));
      return result;
    }, f.config, guard), readGit: guard => f.engine(guard), verifier: () => f.guard,
  });
  try {
    const context = { ...f.context, signal: cancel.signal }, request = { ...f.request(), base: { kind: 'head' as const, oid: f.b } }, plan = await port.plan(request, context);
    await f.reserve(plan);
    await assert.rejects(port.provision(plan, context), code('CANCELLED'));
    assert.equal((await port.inspect(plan.operationId, f.context.signal))?.phase, 'recovery-required');
    assert.equal(f.store.worktrees.get(plan.worktreeId)?.checkoutRoot, plan.checkoutRoot);
    assert.equal(await stat(plan.checkoutRoot).then(value => value.isDirectory()), true);
    assert.equal(f.host.ctx.agents.get(SessionId(plan.target.sessionId)), undefined);
    const adds = f.calls.filter(call => call.args.includes('worktree') && call.args.includes('add')).length;
    await f.git(f.repo, 'update-ref', 'refs/heads/release', f.a); // Source moved AFTER the exact private base/checkout effect; it cannot retarget recovery.
    assert.deepEqual(await port.plan(request, f.context), plan);
    const recovered = await port.provision(plan, f.context);
    assert.equal(recovered.checkoutRoot, plan.checkoutRoot); assert.equal(recovered.worktreeId, plan.worktreeId);
    assert.equal(f.calls.filter(call => call.args.includes('worktree') && call.args.includes('add')).length, adds);
    assert.equal((await port.inspect(plan.operationId, f.context.signal))?.phase, 'prepared');
    assert.equal(f.controller.hasPendingEffects(f.store.worktrees.get(plan.worktreeId)!), true);
  } finally { await port.close(); }
});

test('same-spelling source and prepared checkout directory replacement fails native identity revalidation', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), plan = await f.port.plan(f.request(), f.context); await f.reserve(plan);
  await rename(f.cwd, join(f.repo, 'old-project')); await mkdir(f.cwd); await writeFile(join(f.cwd, 'file.txt'), 'commit B\n');
  await assert.rejects(f.port.provision(plan, f.context), code('PATH_CHANGED'));
  assert.equal(await stat(f.managed).then(() => true, () => false), false);
  const fresh = await f.port.plan(f.request(), f.context); await f.reserve(fresh);
  const receipt = await f.port.provision(fresh, f.context);
  await rename(receipt.checkoutRoot, `${receipt.checkoutRoot}-replaced`); await mkdir(receipt.checkoutRoot); await mkdir(receipt.effectiveCwd);
  await assert.rejects(f.port.provision(fresh, f.context), code('PATH_CHANGED'));
  assert.equal(f.host.ctx.agents.get(SessionId(fresh.target.sessionId)), undefined);
  assert.equal(f.controller.hasPendingEffects(f.store.worktrees.get(fresh.worktreeId)!), true);
});

test('durable suspend wins a late native workspace completion while retaining its exact Git receipt', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), plan = await f.port.plan(f.request(), f.context); await f.reserve(plan);
  const prepared = await f.port.provision(plan, f.context), materialized = await f.materialize(prepared);
  const registry = f.host.ctx.workspaceRegistry, original = registry.create.bind(registry);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(done => { enter = done; }), gate = new Promise<void>(done => { release = done; });
  registry.create = async (...args: Parameters<typeof original>) => { if (args[0] === plan.effectiveCwd) { enter(); await gate; } return original(...args); };
  const task = f.port.bindImported(prepared, materialized.proof, f.context.signal);
  try {
    await Promise.race([entered, task.then(() => { throw new Error('workspace gate was not reached'); })]);
    await f.guard.journal.cancel(materialized.claim, importFence(materialized.record), { intentId: randomUUID(), intentRevision: 1 });
    await f.port.suspend(plan.operationId, plan.target.sessionId, plan.intentId, AbortSignal.abort());
    assert.equal((await f.port.inspect(plan.operationId, f.context.signal))?.phase, 'cancelled');
    release();
    await assert.rejects(task, code('IMPORT_STOPPED'));
    const stopped = await f.port.inspect(plan.operationId, f.context.signal);
    assert.equal(stopped?.phase, 'cancelled'); assert.equal(stopped.receipt?.worktreeId, plan.worktreeId);
    assert.ok(stopped.receipt?.workspaceId, 'late committed native metadata remains inspectable, not erased');
    assert.notEqual(f.store.worktrees.get(plan.worktreeId)?.state, 'ready');
    assert.equal(f.controller.hasPendingEffects(f.store.worktrees.get(plan.worktreeId)!), true);
    assert.equal(f.host.ctx.agents.get(SessionId(plan.target.sessionId)), undefined, 'cancelled binding cannot resume/execute the readable original SID');
  } finally { release(); registry.create = original; await task.catch(() => undefined); }
});

test('missing mandatory admission or an unreserved plan cannot allocate any destination', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), plan = await f.port.plan(f.request(), f.context);
  await assert.rejects(f.port.provision(plan, f.context), code('IMPORT_ADMISSION_UNAVAILABLE'));
  assert.equal(await stat(f.managed).then(() => true, () => false), false);
  const unavailable = new WorktreeImportPlacement(f.host.ctx, f.config, f.store, f.journal, f.controller, f.projects);
  try { await assert.rejects(unavailable.plan(f.request(), f.context), code('IMPORT_ADMISSION_UNAVAILABLE')); }
  finally { await unavailable.close(); }
  await f.reserve(plan); f.registration.unregister();
  await assert.rejects(f.port.provision(plan, f.context), code('IMPORT_ADMISSION_UNAVAILABLE'));
  assert.equal(await stat(f.managed).then(() => true, () => false), false);
});

test('portable remote sanitizer stays byte-for-byte aligned with strict cloud privacy codec', () => {
  for (const value of [['https://', 'u:p@', 'example.invalid/a.git?token=s#fragment'].join(''), 'ssh://git@example.invalid/a.git', 'git@example.invalid:org/repo.git', 'host:repo', '/local/repo', 'file:///private/repo', 'ext::helper', ['https://', 'u:p@', 'example.invalid\\evil/a'].join(''), 'git://host/repo', 'http://host/repo?token=s', 'user:password@host:repo', 'C:/repo', 'host:repo?x=@secret', null, 12]) assert.equal(sanitizePortableRemote(value), sanitizeGitRemote(value));
});
