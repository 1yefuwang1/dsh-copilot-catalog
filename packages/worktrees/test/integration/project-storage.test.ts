import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility, defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import type { ProjectRequest, ProjectRecord, ProjectThreadBinding, ProjectDependencies } from '../../dist/projects.js';
import { TypedProjectController as ProjectController, TypedWorktreeController as WorktreeController, type HostDouble } from '../controller-types.js';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { ProjectStartRecord } from '../../dist/project-store.js';
import type { ControllerDependencies } from '../../dist/service.js';
import type { SessionBootstrap } from '../../dist/sessions.js';
import type { WorktreeRecord, WorktreeRequest, SessionSettings, CheckoutState } from '../../dist/types.js';
import { required, hasCode, type DynamicMock } from './fixtures.js';
import { projectDomain } from '../../dist/project-store.js';
import { worktreeDomain } from '../../dist/store.js';
import { Config } from '../../dist/index.js';
import { tempDirectory, tmpBase } from '../helpers.js';

// Resolve the storage hub through the actual domain SDK's dependency, not an
// installed profile or an absolute Harness path. The JSON SDK is a dev dependency.
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href);
const invocation = { origin: 'ui' as const, signal: new AbortController().signal };


async function fixture(t: TestContext) {
  const root = await tempDirectory('project-storage-owned-');
  assert.equal(dirname(root), tmpBase);
  const path = resolve(root, 'source'), otherPath = resolve(root, 'other-source'), checkout = resolve(root, 'checkout');
  for (const folder of [path, otherPath, checkout]) await mkdir(folder);
  const files = [resolve(path, 'sentinel'), resolve(checkout, '.git')];
  for (const file of files) await writeFile(file, 'retained source or Git state');
  const folderId = randomUUID(), otherFolderId = randomUUID(), id = randomUUID(), otherId = randomUUID();
  const threads: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()];
  const headers = threads.map((id, index) => ({ id, cwd: index === 2 ? checkout : path, title: 'Retained conversation' }));
  const native = [
    { id: folderId, path, title: 'Source', sessionIds: threads.slice(0, 2), pins: [threads[0]], archived: [threads[1]] },
    { id: otherFolderId, path: otherPath, title: 'Other', sessionIds: [] },
    { id: randomUUID(), path: checkout, title: 'Managed', sessionIds: threads.slice(2) },
  ];
  const calls: Array<[string, string]> = [];
  const services = {
    workspaceRegistry: {
      list: () => native,
      async create(path: string) { calls.push(['create', path]); const workspace = native.find(value => value.path === path); assert.ok(workspace); return workspace; },
      delete() { assert.fail('remove must never delete a native workspace'); },
    },
    sessionQuery: { async listSessions() { return headers.map(header => ({ header: structuredClone(header) })); } },
    sessionController: { removeSession() { assert.fail('remove must never delete a session'); } },
  };
  const host = new Context(); new Storage(host);
  const backend = new JsonStorageBackend(resolve(root, 'data'));
  host.storage.backend.register('fixture-json', backend);
  const facility = new DomainFacility(host, { backend: 'fixture-json' });
  const worktrees: Array<Pick<WorktreeRecord, 'id' | 'repoRoot' | 'projectSubdir' | 'checkoutRoot' | 'effectiveCwd' | 'projectId' | 'folderId' | 'sessionIds' | 'protected' | 'archived' | 'state'>> = [{ id: randomUUID(), repoRoot: path, projectSubdir: '', checkoutRoot: checkout, effectiveCwd: checkout, projectId: id, folderId, sessionIds: threads.slice(2), protected: true, archived: true, state: 'ready' }];
  // Metadata-only fixture: these ports deliberately cannot activate/create sessions,
  // and retained worktree rows contain only the fields the project layer observes.
  const owner = { get: (name: keyof typeof services) => services[name] } as HostDouble, bootstrap = { async close() {} } as unknown as NonNullable<ProjectDependencies['bootstrap']>;
  const controllers: ProjectController[] = [];
  function controller(domain: Domain<typeof projectDomain>) {
    const store = { projects: domain.table('projects'), bindings: domain.table('bindings'), starts: domain.table('starts'), removals: domain.table('removals'), close: () => domain.close() };
    const controller = new ProjectController(owner, store, { records: () => structuredClone(worktrees) as WorktreeRecord[] }, { bootstrap });
    controllers.push(controller); return { controller, store, invoke: <const R extends ProjectRequest>(request: R) => controller.execute(request, invocation) };
  }
  const project: ProjectRecord = { id, title: 'Legacy project', folders: [{ id: folderId, path, title: 'Source' }], createdAt: 1, updatedAt: 2 };
  const other: ProjectRecord = { id: otherId, title: 'Unrelated project', folders: [{ id: otherFolderId, path: otherPath, title: 'Other' }], mainFolderId: otherFolderId, createdAt: 1, updatedAt: 2 };
  const binding = (sessionId: string): ProjectThreadBinding => ({ sessionId, projectId: id, folderId, mode: sessionId === threads[2] ? 'worktree' : 'local', effectiveCwd: sessionId === threads[2] ? checkout : path, ...(sessionId === threads[2] ? { worktreeId: required(worktrees[0]).id } : {}) });
  const starts: ProjectStartRecord[] = (['ready', 'recovery-required'] as const).map(phase => { const operationId = randomUUID(); return { id: operationId, projectId: id, folderId, actorId: null, effectiveCwd: path, requestedSessionId: operationId, phase, sessionId: threads[0], workspaceId: folderId, createdAt: 1, updatedAt: 2 }; });
  t.after(async () => { for (const controller of controllers) await controller.close(); await facility.closeAll(); await backend.close(); assert.equal(dirname(root), tmpBase); await rm(root, { recursive: true, force: true }); });
  return { root, path, checkout, folderId, id, otherId, project, other, threads, binding, starts, native, headers, worktrees, calls, backend, facility, controller, files };
}

async function seed(f: Awaited<ReturnType<typeof fixture>>, layout: 'per-record' | 'single' = 'per-record') {
  // Exact original three-table declaration and v1 stamps: the new removals
  // table is absent, and a legacy project may have no mainFolderId.
  const legacy = defineDomain({ name: projectDomain.name, version: 1, layout, tables: { projects: projectDomain.tables.projects, bindings: projectDomain.tables.bindings, starts: projectDomain.tables.starts } });
  const domain = await f.facility.open(legacy);
  await domain.table('projects').put(f.id, f.project); await domain.table('projects').put(f.otherId, f.other);
  for (const thread of f.threads) await domain.table('bindings').put(thread, f.binding(thread));
  for (const receipt of f.starts) await domain.table('starts').put(receipt.id, receipt);
  await domain.close();
}
const documentPath = (f: Awaited<ReturnType<typeof fixture>>, table: string, id: string) => resolve(f.root, 'data', projectDomain.name, table, id + '.json');

for (const layout of ['per-record', 'single'] as const) test(`actual storage SDK reads legacy v1 ${layout}, persists removal and explicit re-add without resurrection`, async t => {
  const f = await fixture(t); await seed(f, layout);
  const legacyFile = resolve(f.root, 'data', projectDomain.name + '.json');
  const legacyText = layout === 'single' ? await readFile(legacyFile, 'utf8') : undefined;
  let domain = await f.facility.open(projectDomain); let current = f.controller(domain);
  assert.deepEqual(current.store.projects.get(f.id), f.project); assert.equal(current.store.removals.size, 0);
  for (const receipt of f.starts) assert.deepEqual(current.store.starts.get(receipt.id), receipt);
  await current.controller.synchronize(); assert.equal(current.controller.resolveFolder(f.id).id, f.folderId);
  const unrelatedBefore = await readFile(documentPath(f, 'projects', f.otherId), 'utf8');
  const startTexts = await Promise.all(f.starts.map(receipt => readFile(documentPath(f, 'starts', receipt.id), 'utf8')));
  const nativeBefore = structuredClone(f.native), headersBefore = structuredClone(f.headers), worktreesBefore = structuredClone(f.worktrees);
  const result = { removed: true, projectId: f.id, scope: 'project-metadata' };
  assert.deepEqual(await current.invoke({ action: 'remove', projectId: f.id }), result);
  const removalDocument = JSON.parse(await readFile(documentPath(f, 'removals', f.id), 'utf8'));
  assert.equal(removalDocument.version, 1); assert.deepEqual(Object.keys(removalDocument.record), ['id', 'folders', 'removedAt']);
  assert.deepEqual(removalDocument.record.folders, [{ id: f.folderId, path: f.path }]);
  await current.controller.close(); await domain.close();
  domain = await f.facility.open(projectDomain); current = f.controller(domain);
  assert.equal(current.controller.bindingFor(f.threads[0]), undefined); await current.controller.synchronize();
  assert.deepEqual((await current.invoke({ action: 'list' })).projects.map(value => value.id), [f.otherId]);
  assert.equal(await current.controller.ensureFolder(f.path), undefined); assert.deepEqual(await current.invoke({ action: 'remove', projectId: f.id }), result);
  assert.deepEqual(f.calls, [], 'suppressed ensureFolder never registers a native workspace');
  const newId = randomUUID(); await current.invoke({ action: 'create', id: newId, title: 'Re-added', folders: [f.path] });
  assert.equal(required(current.controller.bindingFor(f.threads[0])).projectId, newId); assert.equal(required(current.controller.bindingFor(f.threads[2])).projectId, newId);
  assert.equal(required(current.controller.selectionForWorktree(required(f.worktrees[0]).id)).folderId, f.folderId);
  assert.deepEqual(await current.invoke({ action: 'remove', projectId: f.id }), result); assert.ok(current.store.projects.get(newId));
  await current.controller.close(); await domain.close();
  domain = await f.facility.open(projectDomain); current = f.controller(domain); await current.controller.synchronize();
  assert.equal(required(current.controller.folderForPath(f.path)).projectId, newId); assert.ok(current.store.removals.get(f.id));
  assert.equal(await readFile(documentPath(f, 'projects', f.otherId), 'utf8'), unrelatedBefore);
  for (let index = 0; index < f.starts.length; index++) assert.equal(await readFile(documentPath(f, 'starts', required(f.starts[index]).id), 'utf8'), startTexts[index]);
  assert.deepEqual(f.native, nativeBefore); assert.deepEqual(f.headers, headersBefore); assert.deepEqual(f.worktrees, worktreesBefore);
  for (const file of f.files) assert.equal(await readFile(file, 'utf8'), 'retained source or Git state');
  if (layout === 'single') assert.equal(await readFile(legacyFile, 'utf8'), legacyText, 'legacy bootstrap source stays unchanged and removals documents prevent a second bootstrap');
});

for (const boundary of ['receipt', 'project', 'first-binding', 'second-binding']) test(`actual durable storage failure at ${boundary} preserves commit ordering and restart repair`, async t => {
  const f = await fixture(t); await seed(f);
  const open = f.backend.kv.open; let fail = true, deletes = 0;
  f.backend.kv.open = async descriptor => {
    const unit = await open(descriptor);
    const put = unit.putRecord.bind(unit), remove = unit.deleteRecord.bind(unit);
    unit.putRecord = async (table, key, value) => { if (fail && boundary === 'receipt' && table === 'removals') throw Error('injected receipt failure'); return put(table, key, value); };
    unit.deleteRecord = async (table, key) => {
      if (fail && ((boundary === 'project' && table === 'projects') || (table === 'bindings' && ++deletes === (boundary === 'first-binding' ? 1 : boundary === 'second-binding' ? 2 : -1)))) throw Error('injected cleanup failure');
      return remove(table, key);
    };
    return unit;
  };
  let domain = await f.facility.open(projectDomain), current = f.controller(domain);
  const projectsBefore = [...current.store.projects.entries()], bindingsBefore = [...current.store.bindings.entries()];
  await assert.rejects(current.invoke({ action: 'remove', projectId: f.id }), /injected/u);
  if (boundary === 'receipt') {
    assert.equal(current.store.removals.size, 0); assert.deepEqual([...current.store.projects.entries()], projectsBefore); assert.deepEqual([...current.store.bindings.entries()], bindingsBefore);
    await assert.rejects(readFile(documentPath(f, 'removals', f.id)), hasCode('ENOENT'));
  } else {
    assert.ok(current.store.removals.get(f.id)); assert.ok(!current.controller.records().some(project => project.id === f.id));
    assert.equal(current.controller.folderForPath(f.path), undefined); assert.equal(current.controller.selectionForWorktree(required(f.worktrees[0]).id), undefined);
    for (const thread of f.threads) assert.equal(current.controller.bindingFor(thread, required(f.headers.find(header => header.id === thread)).cwd), undefined);
  }
  fail = false; await current.controller.close(); await domain.close();
  domain = await f.facility.open(projectDomain); current = f.controller(domain);
  if (boundary === 'receipt') assert.deepEqual(current.store.projects.get(f.id), f.project);
  else { await current.controller.synchronize(); assert.equal(current.store.projects.get(f.id), undefined); assert.equal(current.store.bindings.size, 0); assert.equal(await current.controller.ensureFolder(f.path), undefined); }
  assert.deepEqual(await current.invoke({ action: 'remove', projectId: f.id }), { removed: true, projectId: f.id, scope: 'project-metadata' });
  assert.ok(current.store.projects.get(f.otherId)); for (const receipt of f.starts) assert.deepEqual(current.store.starts.get(receipt.id), receipt);
  for (const file of f.files) assert.equal(await readFile(file, 'utf8'), 'retained source or Git state');
});


test('removed sources support independent worktree creation and retained worktree starts without project resurrection', async t => {
  const f = await fixture(t); await seed(f); const projectStorage = await f.facility.open(projectDomain), projects = f.controller(projectStorage);
  await projects.invoke({ action: 'remove', projectId: f.id });
  const domain = await f.facility.open(worktreeDomain), store = { worktrees: domain.table('worktrees'), operations: domain.table('operations'), close: () => domain.close() };
  const state: CheckoutState = { head: 'a'.repeat(40), branch: null, dirty: false, changes: 0, untracked: 0 };
  const commonDir = resolve(f.path, '.git');
  const retained = worktreeDomain.tables.worktrees.valueSchema.parse({ ...required(f.worktrees[0]), operationId: randomUUID(), commonDir, remote: 'origin', remoteIdentity: 'opaque', remoteBranch: 'main', baseOid: state.head, baseRef: 'refs/retained/base', fetchedAt: 1, createdAt: 1, workspaceId: null, branch: null, protected: false, archived: false, error: null });
  await store.worktrees.put(retained.id, retained);
  const agents = new Map<string, HostDouble>();
  function actor(id: string, cwd: string): HostDouble { const value = { id, session: { header: { id, cwd } }, ctx: { get(name: string) { if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }) }; } } }; agents.set(id, value); return value; }
  const source = actor(f.threads[0], f.path), isolated = actor(f.threads[2], f.checkout);
  const settings: SessionSettings = { model: { provider: 'github-copilot', model: 'gpt-6.1-sol' }, preset: null, sandbox: 'danger-full-access', approval: 'never', plan: false, hash: 'same-settings' };
  const sessionCalls: Parameters<SessionBootstrap['create']>[0][] = [];
  const bootstrap = {
    actor: (id: string) => agents.get(id), isLive: (agent: HostDouble) => agents.get(agent.id) === agent, async settings() { return structuredClone(settings); }, async assertBlank() {}, async close() {},
    async create(input: Parameters<SessionBootstrap['create']>[0]) { sessionCalls.push(input); const child = actor(randomUUID(), input.cwd), result = { agent: child, sessionId: child.id, workspaceId: randomUUID() }; await input.onCreated?.(result); return result; },
  };
  const git = {
    async discover(path: string) { return { root: path, commonDir, projectSubdir: '', head: state.head, branch: 'main' }; },
    async remotes() { return [{ name: 'origin', identity: 'opaque' }]; },
    async create(input: Extract<Parameters<import('../../dist/git.js').GitOperations['create']>[0], { branchSource?: 'remote' }>) { await mkdir(input.destination, { recursive: true }); return { checkoutRoot: input.destination, effectiveCwd: input.destination, baseOid: state.head, baseRef: input.baseRef, fetchedAt: 2 }; },
    async verify(record: WorktreeRecord) { return { ...state, branch: record.branch }; }, async status() { return state; }, async createBranch(_record: WorktreeRecord, branch: string) { return { ...state, branch }; },
  };
  const controller = new WorktreeController(new Context(), { ...Config({}), root: resolve(f.root, 'independent-managed'), cleanupEnabled: false, cleanupInactivityDays: 10 }, store, {
    projects: projects.controller, bootstrap, localPath: (agent, path) => realpath(path ?? required(agent.session.header.cwd)),
    git: ((_agent, _signal, guard) => Object.fromEntries(Object.entries(git).map(([name, method]) => [name, async (...args: DynamicMock[]) => { guard(); return (method as (...values: DynamicMock[]) => Promise<unknown>)(...args); }]))) as NonNullable<ControllerDependencies['git']>,
  });
  t.after(async () => { await controller.close(); await domain.close(); });
  const invoke = <const R extends WorktreeRequest>(request: R) => controller.execute(request, { origin: 'tool', agent: source, signal: invocation.signal });
  const request = { action: 'create' as const, operationId: randomUUID(), repoPath: f.path, remote: 'origin', remoteIdentity: 'opaque', remoteBranch: 'main' };
  const created = await invoke(request);
  assert.equal(created.worktree.projectId, undefined); assert.equal(created.worktree.folderId, undefined); assert.equal(created.operation.phase, 'ready'); assert.equal(required(sessionCalls[0]).cwd, created.worktree.effectiveCwd);
  assert.deepEqual(await invoke(request), created, 'independent worktree ready replay remains idempotent');
  const started = await invoke({ action: 'start', id: retained.id, sourceSessionId: isolated.id, sessionMode: 'new' });
  assert.equal(started.operation.phase, 'ready'); assert.equal(required(sessionCalls[1]).cwd, retained.effectiveCwd); assert.ok(required(store.worktrees.get(retained.id)).sessionIds.includes(isolated.id));
  const createFrom = (agent: HostDouble) => controller.execute({ ...request, operationId: randomUUID(), repoPath: agent.session.header.cwd, sourceSessionId: agent.id }, { origin: 'tool', agent, signal: invocation.signal });
  const linkedChild = await createFrom(isolated); f.worktrees.push(linkedChild.worktree);
  const linkedGrandchild = await createFrom(agents.get(linkedChild.sessionId)); f.worktrees.push(linkedGrandchild.worktree);
  const linkedGreatGrandchild = await createFrom(agents.get(linkedGrandchild.sessionId)); f.worktrees.push(linkedGreatGrandchild.worktree);
  assert.equal(linkedChild.worktree.repoRoot, retained.checkoutRoot); assert.equal(linkedGrandchild.worktree.repoRoot, linkedChild.worktree.checkoutRoot); assert.equal(linkedGreatGrandchild.worktree.repoRoot, linkedGrandchild.worktree.checkoutRoot);
  // Legacy nested rows can point at a known managed ancestor, with obsolete ownership hints.
  const legacyRoot = resolve(f.root, 'legacy-managed-child'); await mkdir(legacyRoot);
  const legacyActor = actor(randomUUID(), legacyRoot);
  const legacy = worktreeDomain.tables.worktrees.valueSchema.parse({ ...retained, id: randomUUID(), operationId: randomUUID(), repoRoot: retained.checkoutRoot, checkoutRoot: legacyRoot, effectiveCwd: legacyRoot, sessionIds: [legacyActor.id] });
  await store.worktrees.put(legacy.id, legacy); f.worktrees.push(legacy);
  const legacyChild = await createFrom(legacyActor); f.worktrees.push(legacyChild.worktree);
  assert.deepEqual(store.worktrees.get(legacy.id), legacy); assert.equal(legacyChild.worktree.repoRoot, legacy.checkoutRoot);
  for (const result of [linkedChild, linkedGrandchild, linkedGreatGrandchild, legacyChild]) {
    assert.equal(result.worktree.projectId, undefined); assert.equal(result.worktree.folderId, undefined); assert.equal(result.operation.phase, 'ready');
  }
  await projects.controller.synchronize();
  assert.equal(projects.store.projects.get(f.id), undefined); assert.equal(projects.store.bindings.size, 0); assert.ok(projects.store.removals.get(f.id));
  assert.deepEqual(f.calls, [], 'independent create/start, managed-source generations and legacy ancestry never register removed or managed folders');
  assert.equal(source.session.header.cwd, f.path); assert.equal(isolated.session.header.cwd, f.checkout);
  for (const file of f.files) assert.equal(await readFile(file, 'utf8'), 'retained source or Git state');
});
