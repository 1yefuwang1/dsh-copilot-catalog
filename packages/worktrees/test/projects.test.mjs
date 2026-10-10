import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { z } from 'zod';
import { ProjectController, parseProjectRequest, parameterSchema, resolveMainFolder } from '../dist/projects.js';
import { projectDomain, projectRecordSchema } from '../dist/project-store.js';
import { WorktreeError } from '../dist/errors.js';

const errorCode = code => error => error instanceof WorktreeError && error.code === code;
function table(schema, initial = [], persist = async () => {}) {
  const map = new Map(initial.map(([id, value]) => [id, structuredClone(schema.parse(value))]));
  return { map, get: id => map.get(id), entries: () => map.entries(), async put(id, value) { const parsed = structuredClone(schema.parse(value)); await persist(); map.set(id, parsed); }, async delete(id) { await persist(); return map.delete(id); } };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'project-layer-owned-'));
  assert.equal(dirname(directory), await realpath(tmpdir()));
  const paths = { a: resolve(directory, 'a'), b: resolve(directory, 'b'), c: resolve(directory, 'c'), checkout: resolve(directory, 'managed', 'checkout') };
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true });
  const headers = new Map(); const sessionEvents = new Map(); const actors = new Map(); const worktrees = []; const workspaces = new Map(); const calls = []; const policy = new Map(); const plans = new Map();
  const registry = {
    list: () => [...workspaces.values()],
    async create(path, title = 'Folder') {
      calls.push(['registry', path]); const canonical = await realpath(path);
      const existing = [...workspaces.values()].find(value => value.path === canonical); if (existing) return existing;
      const workspace = { id: randomUUID(), path: canonical, title, get sessionIds() { return [...headers.values()].filter(header => header.cwd === canonical).map(header => header.id); }, async attachSession(id) { assert.equal(headers.get(id).cwd, canonical); } };
      workspaces.set(workspace.id, workspace); return workspace;
    },
  };
  function session(cwd, origin) { const value = { id: randomUUID(), cwd, ...(origin ? { origin } : {}) }; headers.set(value.id, value); return value; }
  function actor(cwd = paths.a, origin) {
    const header = session(cwd, origin);
    const value = { id: header.id, session: { header }, ctx: { get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: policy.get(value.id) ?? 'danger-full-access', workspaceRoot: cwd }) };
      if (name === 'planMode') return { get: () => plans.get(value.id) ?? { active: false, pending: false } };
    } } };
    actors.set(value.id, value); return value;
  }
  const settings = { model: { provider: 'github-copilot', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }, preset: 'preset', sandbox: 'workspace-write', approval: 'ask', plan: true, hash: 'current' };
  const bootstrap = {
    actor(id) { const value = actors.get(id); if (!value) throw new WorktreeError('SESSION_NOT_LIVE', 'missing'); if (value.session.header.origin === 'subagent') throw new WorktreeError('SUBAGENT_SOURCE', 'ordinary only'); return value; },
    isLive: value => actors.get(value.id) === value,
    async settings() { calls.push(['settings']); return structuredClone(settings); },
    async create(input) {
      calls.push(['bootstrap', input]); if (options.beforeBootstrap) await options.beforeBootstrap(input);
      const child = actor(input.cwd); const workspace = await registry.create(input.cwd, input.title); const result = { agent: child, sessionId: child.id, workspaceId: workspace.id };
      await input.onCreated?.(result); if (options.afterBootstrap) await options.afterBootstrap(input, result); return result;
    },
    async close() { calls.push(['closed']); },
  };
  const services = { workspaceRegistry: registry, sessionQuery: {
    async listSessions(signal) { if (options.listSessions) await options.listSessions(signal); return [...headers.values()].map(header => ({ header: structuredClone(header) })); },
    async observeSession(id) { calls.push(['observe', id]); const header = headers.get(id); if (!header) throw new WorktreeError('NOT_FOUND', 'missing'); return { header: structuredClone(header), events: sessionEvents.get(id) ?? [], [Symbol.dispose]() { calls.push(['dispose', id]); } }; },
  }, sessionController: {
    async create(input) {
      calls.push(['native', input]); if (options.beforeNative) await options.beforeNative(input);
      if (!headers.has(input.sessionId)) headers.set(input.sessionId, { id: input.sessionId, cwd: input.cwd });
      const result = { sessionId: input.sessionId }; if (options.afterNative) await options.afterNative(input, result); return result;
    },
  } };
  const owner = { get: name => services[name] };
  const store = { projects: table(projectDomain.tables.projects.valueSchema), bindings: table(projectDomain.tables.bindings.valueSchema), starts: table(projectDomain.tables.starts.valueSchema), removals: table(projectDomain.tables.removals.valueSchema), async close() {} };
  const dependencies = { bootstrap, localPath: async (_agent, path) => realpath(path), operationTimeoutMs: 60000 };
  const controller = new ProjectController(owner, store, { records: () => structuredClone(worktrees) }, dependencies);
  const invocation = { origin: 'ui', signal: new AbortController().signal };
  const invoke = request => controller.execute(request, invocation);
  t.after(async () => { await controller.close(); assert.equal(dirname(directory), await realpath(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return { directory, paths, controller, store, registry, headers, sessionEvents, actors, actor, session, calls, policy, plans, worktrees, invocation, invoke, services, dependencies, owner, settings };
}
function managed(f, extra = {}) {
  const record = { id: randomUUID(), operationId: randomUUID(), repoRoot: f.paths.a, projectSubdir: '', checkoutRoot: f.paths.checkout, effectiveCwd: f.paths.checkout, sessionIds: [], state: 'ready', ...extra };
  f.worktrees.push(record); return record;
}

test('imports native Local folders durably; create merges multiple imported folders and rebinds without changing cwd', async t => {
  const f = await fixture(t); const a = await f.registry.create(f.paths.a, 'Alpha'); const b = await f.registry.create(f.paths.b, 'Beta');
  const threadA = f.session(f.paths.a); const threadB = f.session(f.paths.b);
  const imported = await f.invoke({ action: 'list' }); assert.equal(imported.projects.length, 2); assert.ok(imported.projects.every(project => project.imported === true && project.mainFolderId === project.folders[0].id));
  assert.equal(imported.bindings.length, 2); assert.ok(imported.bindings.every(binding => binding.mode === 'local'));
  const id = randomUUID(); const result = await f.invoke({ action: 'create', id, title: 'Combined', folders: [f.paths.a, f.paths.b] });
  assert.deepEqual(result.project.folders.map(folder => folder.id), [a.id, b.id]); assert.equal(result.project.mainFolderId, a.id); assert.equal(result.project.imported, undefined);
  const snapshot = await f.invoke({ action: 'list' }); assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.projects[0].id, id);
  assert.ok(snapshot.bindings.every(binding => binding.projectId === id)); assert.equal(f.headers.get(threadA.id).cwd, f.paths.a); assert.equal(f.headers.get(threadB.id).cwd, f.paths.b);
  result.project.folders.length = 0; assert.equal(f.controller.records()[0].folders.length, 2);
});

test('update adopts additional imports but explicit custom conflicts and removal of threaded folders reject', async t => {
  const f = await fixture(t); await f.registry.create(f.paths.a); await f.registry.create(f.paths.b); await f.registry.create(f.paths.c);
  const thread = f.session(f.paths.a); const id = randomUUID(); await f.invoke({ action: 'create', id, title: 'One', folders: [f.paths.a] });
  const updated = await f.invoke({ action: 'update', projectId: id, title: 'Both', folders: [f.paths.a, f.paths.b] }); assert.equal(updated.project.folders.length, 2);
  await assert.rejects(f.invoke({ action: 'create', id: randomUUID(), title: 'Steal', folders: [f.paths.b, f.paths.c] }), errorCode('PROJECT_FOLDER_CONFLICT'));
  await assert.rejects(f.invoke({ action: 'update', projectId: id, folders: [f.paths.b] }), errorCode('PROJECT_FOLDER_IN_USE'));
  assert.equal(f.controller.bindingFor(thread.id).projectId, id);
});

test('folds managed native workspace into source project; exact cwd keeps Local handoff truthful', async t => {
  const f = await fixture(t); const source = await f.registry.create(f.paths.a); await f.registry.create(f.paths.checkout);
  const isolated = f.session(f.paths.checkout); const local = f.session(f.paths.a); const subagent = f.session(f.paths.checkout, 'subagent');
  const row = managed(f, { sessionIds: [isolated.id, local.id, subagent.id] });
  const snapshot = await f.invoke({ action: 'list' }); assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.projects[0].folders[0].id, source.id);
  const worktree = f.controller.bindingFor(isolated.id); assert.equal(worktree.mode, 'worktree'); assert.equal(worktree.worktreeId, row.id);
  const handoff = f.controller.bindingFor(local.id); assert.equal(handoff.mode, 'local'); assert.equal(handoff.worktreeId, undefined);
  assert.equal(f.controller.bindingFor(isolated.id, f.paths.a).mode, 'local'); assert.equal(f.controller.bindingFor(isolated.id, f.paths.c), undefined);
  assert.equal(f.controller.bindingFor(subagent.id), undefined); assert.equal(snapshot.bindings.length, 2);
  // Parent's optional row ownership supports creating a worktree from another managed checkout.
  row.repoRoot = f.paths.checkout; row.projectId = worktree.projectId; row.folderId = worktree.folderId;
  assert.equal(f.controller.bindingFor(isolated.id).projectId, worktree.projectId);
});

test('bind and internal receipt infer backing instead of trusting identity lists or client mode', async t => {
  const f = await fixture(t); await f.registry.create(f.paths.a); const actor = f.actor(); await f.controller.synchronize(); const selection = f.controller.folderForPath(f.paths.a);
  const request = { action: 'bind', projectId: selection.projectId, folderId: selection.folderId, sessionId: actor.id };
  await assert.rejects(f.invoke(request), errorCode('NO_CALLER'));
  const result = await f.controller.execute(request, { ...f.invocation, agent: actor }); assert.equal(result.binding.mode, 'local');
  await assert.rejects(f.controller.execute({ ...request, mode: 'worktree' }, { ...f.invocation, agent: actor }), errorCode('INVALID_REQUEST'));
  await assert.rejects(f.controller.recordThread({ ...result.binding, mode: 'worktree', worktreeId: randomUUID() }), errorCode('PROJECT_BINDING_MISMATCH'));
  // Storage receipt field order is not authority and need not match controller construction order.
  await f.controller.recordThread({ mode: 'local', effectiveCwd: f.paths.a, folderId: selection.folderId, projectId: selection.projectId, sessionId: actor.id });
  assert.equal(f.calls.filter(([kind]) => kind === 'observe').length, f.calls.filter(([kind]) => kind === 'dispose').length);
});

test('strict actions and existing absolute canonical paths reject duplicates, managed checkouts, unknown and authority fields', async t => {
  const f = await fixture(t); const id = randomUUID(); const base = { action: 'create', id, title: 'Name', folders: [f.paths.a] };
  for (const request of [null, [], {}, { action: 'remove', projectId: 'not-a-uuid' }, { ...base, title: ' ' }, { ...base, title: 'x'.repeat(121) }, { ...base, folders: [] }, { ...base, folders: Array(33).fill(f.paths.a) }, { ...base, folders: ['relative'] }, { ...base, permissions: 'full' }, { action: 'list', folderId: id }, { action: 'update', projectId: id }, { ...base, folders: ['/tmp/line\nbreak'] }]) assert.throws(() => parseProjectRequest(request), errorCode('INVALID_REQUEST'));
  let accessor = false; const request = { action: 'list' }; Object.defineProperty(request, 'evil', { enumerable: true, get() { accessor = true; return 1; } }); assert.throws(() => parseProjectRequest(request)); assert.equal(accessor, false);
  assert.ok(!JSON.stringify(parameterSchema).includes('~standard')); assert.equal(parameterSchema.oneOf.length, 6);
  await assert.rejects(f.invoke({ ...base, folders: [resolve(f.directory, 'missing')] }), errorCode('INVALID_PROJECT_PATH'));
  const file = resolve(f.directory, 'regular'); await writeFile(file, 'file'); await assert.rejects(f.invoke({ ...base, folders: [file] }), errorCode('INVALID_PROJECT_PATH'));
  const alias = resolve(f.directory, 'alias'); await symlink(f.paths.a, alias); await assert.rejects(f.invoke({ ...base, folders: [f.paths.a, alias] }), errorCode('DUPLICATE_PROJECT_FOLDER'));
  managed(f); await assert.rejects(f.invoke({ ...base, folders: [f.paths.checkout] }), errorCode('MANAGED_PROJECT_FOLDER'));
});

test('actorless UI starts are blank fixed-identity idempotent; no tool/command ambient fallback', async t => {
  const f = await fixture(t); await f.registry.create(f.paths.a); await f.controller.synchronize(); const folder = f.controller.folderForPath(f.paths.a);
  const request = { action: 'start', operationId: randomUUID(), projectId: folder.projectId, folderId: folder.folderId };
  const [first, replay] = await Promise.all([f.invoke(request), f.invoke(request)]); assert.deepEqual(replay, first); assert.equal(first.sessionId, request.operationId); assert.equal(first.workspaceId, folder.folderId); assert.equal(first.binding.mode, 'local');
  assert.equal(f.calls.filter(([kind]) => kind === 'native').length, 1); assert.equal(f.calls.filter(([kind]) => kind === 'bootstrap').length, 0); assert.equal(f.store.starts.get(request.operationId).phase, 'ready');
  for (const origin of ['tool', 'command']) {
    await assert.rejects(f.controller.execute({ action: 'list' }, { ...f.invocation, origin }), errorCode('NO_CALLER'));
    await assert.rejects(f.controller.execute({ action: 'start', operationId: randomUUID(), projectId: randomUUID() }, { ...f.invocation, origin }), errorCode('NO_CALLER'));
  }
  await assert.rejects(f.invoke({ ...request, projectId: randomUUID() }), errorCode('PROJECT_FOLDER_NOT_FOUND'));
});

test('actual caller cross-root/plan authority is enforced; actor start copies settings and stays new/blank', async t => {
  const f = await fixture(t); await f.registry.create(f.paths.a); await f.registry.create(f.paths.b); const actor = f.actor(); await f.controller.synchronize();
  const own = f.controller.folderForPath(f.paths.a); const cross = f.controller.folderForPath(f.paths.b); const request = { action: 'start', operationId: randomUUID(), projectId: cross.projectId, folderId: cross.folderId };
  const invocation = { ...f.invocation, agent: actor, origin: 'tool' }; f.policy.set(actor.id, 'workspace-write');
  await assert.rejects(f.controller.execute(request, invocation), errorCode('FULL_ACCESS_REQUIRED')); assert.equal(f.store.starts.map.size, 0);
  // Metadata grouping cannot grant sandbox authority and remains useful under restricted callers.
  await f.controller.execute({ action: 'update', projectId: own.projectId, title: 'Own' }, invocation); assert.equal(f.policy.get(actor.id), 'workspace-write');
  f.policy.set(actor.id, 'danger-full-access'); f.plans.set(actor.id, { active: false, pending: true }); await assert.rejects(f.controller.execute(request, invocation), errorCode('PLAN_MODE'));
  f.plans.set(actor.id, { active: true, pending: false }); await assert.rejects(f.controller.execute({ action: 'update', projectId: own.projectId, title: 'No' }, invocation), errorCode('PLAN_MODE'));
  const result = await f.controller.execute(request, { ...invocation, origin: 'ui' }); const input = f.calls.find(([kind]) => kind === 'bootstrap')[1];
  assert.equal(input.source, actor); assert.deepEqual(input.settings, f.settings); assert.equal(input.mode, 'new'); assert.equal(input.cwd, f.paths.b); assert.equal(input.prompt, undefined); assert.equal(result.binding.mode, 'local');
  const impostor = { ...actor }; await assert.rejects(f.controller.execute({ action: 'list' }, { ...invocation, agent: impostor }), errorCode('SESSION_CHANGED'));
  const child = f.actor(f.paths.a, 'subagent'); await assert.rejects(f.controller.execute({ action: 'list' }, { ...invocation, agent: child }), errorCode('SUBAGENT_SOURCE'));
  delete f.services.sessionController; f.plans.set(actor.id, { active: false });
  await f.controller.execute({ action: 'start', operationId: randomUUID(), projectId: own.projectId, folderId: own.folderId }, invocation);
});

test('cancellation before effects never creates; committed cancellation records a ready receipt and never duplicates', async t => {
  const options = {}; const f = await fixture(t, options); await f.registry.create(f.paths.a); await f.controller.synchronize(); const folder = f.controller.folderForPath(f.paths.a);
  const request = () => ({ action: 'start', operationId: randomUUID(), projectId: folder.projectId, folderId: folder.folderId });
  const early = new AbortController(); early.abort(); await assert.rejects(f.controller.execute(request(), { ...f.invocation, signal: early.signal }), errorCode('CANCELLED')); assert.equal(f.store.starts.map.size, 0);
  const during = new AbortController(); options.afterNative = () => during.abort(); const started = request();
  await assert.rejects(f.controller.execute(started, { ...f.invocation, signal: during.signal }), errorCode('CANCELLED'));
  assert.equal(f.store.starts.get(started.operationId).phase, 'ready'); const replay = await f.invoke(started); assert.equal(replay.sessionId, started.operationId); assert.equal(f.calls.filter(([kind]) => kind === 'native').length, 1);
});

test('ambiguous actor bootstrap failure journals identity and refuses duplicated starts', async t => {
  const f = await fixture(t, { afterBootstrap: async () => { throw Error('flush failed'); } }); await f.registry.create(f.paths.a); const actor = f.actor(); await f.controller.synchronize(); const folder = f.controller.folderForPath(f.paths.a);
  const request = { action: 'start', operationId: randomUUID(), projectId: folder.projectId, folderId: folder.folderId }; const invocation = { ...f.invocation, agent: actor };
  await assert.rejects(f.controller.execute(request, invocation), /flush failed/u); const operation = f.store.starts.get(request.operationId); assert.equal(operation.phase, 'recovery-required'); assert.ok(operation.sessionId); assert.equal(operation.workspaceId, folder.folderId);
  await assert.rejects(f.controller.execute(request, invocation), errorCode('RECOVERY_REQUIRED')); assert.equal(f.calls.filter(([kind]) => kind === 'bootstrap').length, 1);
});

test('restart reloads validated durable storage and repairs interrupted import adoption', async t => {
  const f = await fixture(t); await f.registry.create(f.paths.a); await f.registry.create(f.paths.b); f.session(f.paths.a); await f.controller.synchronize();
  const imported = f.controller.records(); const id = randomUUID(); const explicit = { id, title: 'Merged after crash', folders: imported.flatMap(project => project.folders), createdAt: 1, updatedAt: 2 };
  // Crash boundary immediately after winner publish, before donor cleanup and thread rebinding.
  await f.store.projects.put(id, explicit);
  const filename = resolve(f.directory, 'durable.json');
  await writeFile(filename, JSON.stringify(Object.fromEntries(['projects', 'bindings', 'starts', 'removals'].map(name => [name, [...f.store[name].entries()]]))));
  await f.controller.close(); const loaded = JSON.parse(await readFile(filename, 'utf8'));
  const store = Object.fromEntries(['projects', 'bindings', 'starts', 'removals'].map(name => [name, table(projectDomain.tables[name].valueSchema, loaded[name])])); store.close = async () => {};
  const restarted = new ProjectController(f.owner, store, { records: () => f.worktrees }, f.dependencies); t.after(() => restarted.close());
  await restarted.synchronize(); const snapshot = await restarted.execute({ action: 'list' }, f.invocation); assert.equal(snapshot.projects.length, 1); assert.deepEqual(snapshot.projects[0], { ...explicit, mainFolderId: explicit.folders[0].id }); assert.ok(snapshot.bindings.every(binding => binding.projectId === id));
  assert.equal(projectDomain.name, 'dsh_worktree_projects'); assert.equal(projectDomain.version, 1); assert.deepEqual(Object.keys(projectDomain.tables), ['projects', 'bindings', 'starts', 'removals']);
});

test('ensureFolder imports ordinary existing source once and close aborts/awaits flights', async t => {
  const options = {}; const f = await fixture(t, options); const thread = f.session(f.paths.c);
  const selection = await f.controller.ensureFolder(f.paths.c); assert.equal(selection.path, f.paths.c); assert.equal(f.controller.bindingFor(thread.id).projectId, selection.projectId); assert.deepEqual(await f.controller.ensureFolder(f.paths.c), selection);
  managed(f); await assert.rejects(f.controller.ensureFolder(f.paths.checkout), errorCode('MANAGED_PROJECT_FOLDER'));
  let entered; const began = new Promise(resolve => { entered = resolve; }); let release;
  options.listSessions = signal => new Promise(resolve => { release = resolve; entered(signal); });
  const flight = f.invoke({ action: 'list' }); const signal = await began; let finished = false; const close = f.controller.close().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(signal.aborted, true); assert.equal(finished, false); release(); await assert.rejects(flight, errorCode('CANCELLED')); await close;
  await assert.rejects(f.invoke({ action: 'list' }), errorCode('CLOSED'));
});

test('legacy symlink-spelled session headers use the native canonical exact-cwd index', async t => {
  const f = await fixture(t); const native = await f.registry.create(f.paths.a); const alias = resolve(f.directory, 'legacy-alias'); await symlink(f.paths.a, alias);
  const actor = f.actor(alias); Object.defineProperty(native, 'sessionIds', { get: () => [actor.id] });
  const snapshot = await f.invoke({ action: 'list' }); assert.equal(snapshot.bindings.length, 1); const binding = f.controller.bindingFor(actor.id);
  assert.equal(binding.mode, 'local'); assert.equal(binding.effectiveCwd, f.paths.a); assert.equal(binding.folderId, native.id);
  const bound = await f.controller.execute({ action: 'bind', projectId: binding.projectId, folderId: native.id, sessionId: actor.id }, { ...f.invocation, agent: actor }); assert.deepEqual(bound.binding, binding);
});

test('list projectId filter returns only the selected project and adjacent bindings', async t => {
  const f = await fixture(t); await f.registry.create(f.paths.a); await f.registry.create(f.paths.b); const one = f.session(f.paths.a); f.session(f.paths.b); await f.controller.synchronize();
  const selected = f.controller.bindingFor(one.id); const snapshot = await f.invoke({ action: 'list', projectId: selected.projectId }); assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.projects[0].id, selected.projectId); assert.deepEqual(snapshot.bindings, [selected]);
  assert.deepEqual(await f.invoke({ action: 'list', projectId: randomUUID() }), { projects: [], bindings: [], records: [] });
});

test('metadata lists return current branch records as isolated snapshots, scoped to source project', async t => {
  const f = await fixture(t); await f.registry.create(f.paths.a); await f.registry.create(f.paths.b); await f.controller.synchronize();
  const source = f.controller.folderForPath(f.paths.a), other = f.controller.folderForPath(f.paths.b);
  const row = managed(f, { projectId: source.projectId, folderId: source.folderId, branch: 'worktree/random' });
  const first = await f.invoke({ action: 'list', projectId: source.projectId }); assert.deepEqual(first.records, [row]);
  row.branch = 'worktree/generated'; row.displayName = 'Generated title';
  const updated = await f.invoke({ action: 'list' }); assert.equal(updated.records[0].branch, row.branch); assert.equal(updated.records[0].displayName, row.displayName);
  assert.equal(first.records[0].branch, 'worktree/random'); updated.records[0].branch = 'mutated client copy'; assert.equal(f.worktrees[0].branch, 'worktree/generated');
  assert.deepEqual((await f.invoke({ action: 'list', projectId: other.projectId })).records, []);
});

test('ready starts replay their durable identity after controller/storage restart', async t => {
  const f = await fixture(t); await f.registry.create(f.paths.a); await f.controller.synchronize(); const folder = f.controller.folderForPath(f.paths.a); const request = { action: 'start', operationId: randomUUID(), projectId: folder.projectId, folderId: folder.folderId };
  const first = await f.invoke(request); const filename = resolve(f.directory, 'start-restart.json');
  await writeFile(filename, JSON.stringify(Object.fromEntries(['projects', 'bindings', 'starts', 'removals'].map(name => [name, [...f.store[name].entries()]])))); await f.controller.close();
  const loaded = JSON.parse(await readFile(filename, 'utf8')); const store = Object.fromEntries(['projects', 'bindings', 'starts', 'removals'].map(name => [name, table(projectDomain.tables[name].valueSchema, loaded[name])])); store.close = async () => {};
  const restarted = new ProjectController(f.owner, store, { records: () => f.worktrees }, f.dependencies); t.after(() => restarted.close());
  assert.deepEqual(await restarted.execute(request, f.invocation), first); assert.equal(f.calls.filter(([kind]) => kind === 'native').length, 1);
});

test('legacy two-generation managed ancestry folds by matching roots/commonDir, rejects cycles and survives imported-owner adoption', async t => {
  const f = await fixture(t); const native = await f.registry.create(f.paths.a); const commonDir = resolve(f.directory, '.git');
  const firstCwd = resolve(f.paths.checkout, 'a'); const secondRoot = resolve(f.directory, 'managed-second'); const secondCwd = resolve(secondRoot, 'a');
  await mkdir(firstCwd, { recursive: true }); await mkdir(secondCwd, { recursive: true });
  const first = managed(f, { repoRoot: f.directory, commonDir, projectSubdir: 'a', effectiveCwd: firstCwd });
  const second = managed(f, { repoRoot: first.checkoutRoot, commonDir, projectSubdir: 'a', checkoutRoot: secondRoot, effectiveCwd: secondCwd });
  await f.registry.create(firstCwd); await f.registry.create(secondCwd); const thread = f.session(secondCwd);
  const snapshot = await f.invoke({ action: 'list' }); assert.equal(snapshot.projects.length, 1); const original = snapshot.projects[0];
  assert.deepEqual(f.controller.bindingFor(thread.id), { sessionId: thread.id, projectId: original.id, folderId: native.id, mode: 'worktree', effectiveCwd: secondCwd, worktreeId: second.id });
  assert.deepEqual(f.controller.selectionForWorktree(second.id), { projectId: original.id, folderId: native.id, path: f.paths.a });
  assert.equal(f.controller.selectionForWorktree(randomUUID()), undefined);
  second.commonDir = resolve(f.directory, 'unrelated.git'); assert.equal(f.controller.bindingFor(thread.id), undefined);
  second.commonDir = commonDir; first.repoRoot = second.checkoutRoot; assert.equal(f.controller.bindingFor(thread.id), undefined);
  first.repoRoot = f.directory; second.projectId = original.id; second.folderId = native.id;
  const winner = randomUUID(); await f.invoke({ action: 'create', id: winner, title: 'Adopted', folders: [f.paths.a] });
  assert.equal(f.store.projects.get(original.id), undefined); assert.equal(f.controller.bindingFor(thread.id).projectId, winner);
  assert.deepEqual(f.controller.selectionForWorktree(second.id), { projectId: winner, folderId: native.id, path: f.paths.a });
  // A durable native folder hint still identifies the winner after legacy ancestry records are unavailable.
  f.worktrees.splice(f.worktrees.indexOf(first), 1); assert.equal(f.controller.bindingFor(thread.id).projectId, winner);
});

test('an identity collision becoming nonblank during public create is journaled, never adopted or duplicated', async t => {
  const options = {}; const f = await fixture(t, options); await f.registry.create(f.paths.a); await f.controller.synchronize(); const folder = f.controller.folderForPath(f.paths.a);
  const request = { action: 'start', operationId: randomUUID(), projectId: folder.projectId, folderId: folder.folderId };
  options.afterNative = (_input, result) => { f.sessionEvents.set(result.sessionId, [{ type: 'turn/start' }]); };
  await assert.rejects(f.invoke(request), errorCode('SESSION_NOT_BLANK')); assert.equal(f.store.starts.get(request.operationId).phase, 'recovery-required'); assert.equal(f.store.starts.get(request.operationId).sessionId, request.operationId);
  await assert.rejects(f.invoke(request), errorCode('RECOVERY_REQUIRED')); assert.equal(f.calls.filter(([kind]) => kind === 'native').length, 1);
});

test('main-folder parser and additive v1 schema accept legacy records, reject explicit nonmembers and project cleanly', () => {
  const id = randomUUID(); const folders = [{ id: 'folder-a', path: '/source/a', title: 'A' }, { id: 'folder-b', path: '/source/b', title: 'B' }];
  const legacy = { id, title: 'Legacy', folders, createdAt: 1, updatedAt: 2 };
  assert.deepEqual(projectRecordSchema.parse(legacy), legacy); assert.equal(resolveMainFolder(legacy).id, 'folder-a');
  const explicit = { ...legacy, mainFolderId: 'folder-b' }; assert.deepEqual(projectRecordSchema.parse(explicit), explicit); assert.equal(resolveMainFolder(explicit).id, 'folder-b');
  for (const mainFolderId of ['', 'not-a-member', null]) assert.equal(projectRecordSchema.safeParse({ ...legacy, mainFolderId }).success, false);
  assert.throws(() => resolveMainFolder({ ...legacy, mainFolderId: 'not-a-member' }), errorCode('PROJECT_FOLDER_NOT_FOUND'));
  const projected = z.toJSONSchema(projectRecordSchema); assert.equal(projected.properties.mainFolderId.type, 'string'); assert.ok(!projected.required.includes('mainFolderId'));
  for (const request of [{ action: 'create', id, title: 'New', folders: ['/source/a'], mainFolder: '/source/a' }, { action: 'update', projectId: id, mainFolder: '/source/b' }, { action: 'start', projectId: id, operationId: randomUUID() }]) assert.deepEqual(parseProjectRequest(request), request);
  for (const mainFolder of ['relative', '', '/line\nbreak', null, 1]) assert.throws(() => parseProjectRequest({ action: 'update', projectId: id, mainFolder }), errorCode('INVALID_REQUEST'));
  assert.throws(() => parseProjectRequest({ action: 'update', projectId: id, mainFolderId: 'folder-a' }), errorCode('INVALID_REQUEST'));
  const create = parameterSchema.oneOf.find(value => value.properties.action.const === 'create');
  const update = parameterSchema.oneOf.find(value => value.properties.action.const === 'update');
  const start = parameterSchema.oneOf.find(value => value.properties.action.const === 'start');
  assert.equal(create.properties.mainFolder.type, 'string'); assert.ok(!create.required.includes('mainFolder')); assert.ok(update.anyOf.some(value => value.required.includes('mainFolder'))); assert.ok(!start.required.includes('folderId')); assert.match(start.properties.folderId.description, /receipt/u);
  assert.equal(projectDomain.version, 1);
});

test('create canonicalizes explicit main membership before registry effects and adopts imports by stable native IDs', async t => {
  const f = await fixture(t); const alias = resolve(f.directory, 'main-alias'); await symlink(f.paths.b, alias);
  const base = { action: 'create', id: randomUUID(), title: 'Main B', folders: [f.paths.a, f.paths.b] };
  for (const [mainFolder, code] of [[f.paths.c, 'PROJECT_MAIN_FOLDER_NOT_FOUND'], [resolve(f.directory, 'missing'), 'INVALID_PROJECT_PATH']]) {
    const count = f.calls.length; await assert.rejects(f.invoke({ ...base, mainFolder }), errorCode(code)); assert.equal(f.calls.slice(count).filter(([kind]) => kind === 'registry').length, 0); assert.equal(f.store.projects.get(base.id), undefined);
  }
  const file = resolve(f.directory, 'main-file'); await writeFile(file, 'ordinary file'); await assert.rejects(f.invoke({ ...base, mainFolder: file }), errorCode('INVALID_PROJECT_PATH'));
  const b = await f.registry.create(f.paths.b); const imported = (await f.invoke({ action: 'list' })).projects.find(project => project.folders[0].id === b.id);
  const created = await f.invoke({ ...base, mainFolder: alias }); assert.equal(created.project.mainFolderId, b.id); assert.equal(resolveMainFolder(created.project).path, f.paths.b); assert.equal(f.store.projects.get(imported.id), undefined);
  const fallback = await f.invoke({ action: 'create', id: randomUUID(), title: 'Default C', folders: [f.paths.c] }); assert.equal(fallback.project.mainFolderId, fallback.project.folders[0].id);
  const before = structuredClone(f.store.projects.get(base.id)); const count = f.calls.length;
  await assert.rejects(f.invoke({ action: 'update', projectId: base.id, folders: [f.paths.a, f.paths.b], mainFolder: f.paths.c }), errorCode('PROJECT_MAIN_FOLDER_NOT_FOUND'));
  assert.deepEqual(f.store.projects.get(base.id), before); assert.equal(f.calls.slice(count).filter(([kind]) => kind === 'registry').length, 0);
});

test('main-only updates and reorder preserve existing Local/worktree cwd, bindings and managed rows', async t => {
  const f = await fixture(t); const id = randomUUID(); const created = await f.invoke({ action: 'create', id, title: 'Two', folders: [f.paths.a, f.paths.b], mainFolder: f.paths.b });
  const localA = f.session(f.paths.a); const localB = f.session(f.paths.b); const isolated = f.session(f.paths.checkout);
  const row = managed(f, { projectId: id, folderId: created.project.folders[0].id, sessionIds: [isolated.id] }); await f.controller.synchronize();
  const bindings = [...f.store.bindings.entries()]; const headers = [...f.headers.entries()]; const records = structuredClone(f.worktrees);
  const reordered = await f.invoke({ action: 'update', projectId: id, folders: [f.paths.b, f.paths.a] }); assert.equal(reordered.project.mainFolderId, created.project.mainFolderId);
  const updated = await f.invoke({ action: 'update', projectId: id, mainFolder: f.paths.a }); assert.equal(updated.project.title, 'Two'); assert.equal(updated.project.mainFolderId, created.project.folders[0].id);
  assert.deepEqual([...f.store.bindings.entries()], bindings); assert.deepEqual([...f.headers.entries()], headers); assert.deepEqual(f.worktrees, records);
  assert.equal(f.controller.bindingFor(localA.id).effectiveCwd, f.paths.a); assert.equal(f.controller.bindingFor(localB.id).effectiveCwd, f.paths.b); assert.equal(f.controller.bindingFor(isolated.id).worktreeId, row.id);
  const renamed = await f.invoke({ action: 'update', projectId: id, title: 'Renamed' }); assert.equal(renamed.project.mainFolderId, updated.project.mainFolderId);
});

test('removing unused prior main requires a replacement for multiple remaining folders, but a sole folder becomes main', async t => {
  const f = await fixture(t); const id = randomUUID(); await f.invoke({ action: 'create', id, title: 'Three', folders: [f.paths.a, f.paths.b, f.paths.c] });
  const count = f.calls.length; await assert.rejects(f.invoke({ action: 'update', projectId: id, folders: [f.paths.b, f.paths.c] }), errorCode('PROJECT_MAIN_FOLDER_REQUIRED')); assert.equal(f.calls.slice(count).filter(([kind]) => kind === 'registry').length, 0);
  const replaced = await f.invoke({ action: 'update', projectId: id, folders: [f.paths.b, f.paths.c], mainFolder: f.paths.c }); assert.equal(resolveMainFolder(replaced.project).path, f.paths.c);
  const single = await f.invoke({ action: 'update', projectId: id, folders: [f.paths.b] }); assert.equal(single.project.mainFolderId, single.project.folders[0].id);
  // The removed directory remains a native Local workspace, reimported without moving anything.
  assert.equal(f.controller.folderForPath(f.paths.c).path, f.paths.c);
});

test('explicit replacement never bypasses used-folder removal guards, including hint-only legacy managed ancestry', async t => {
  const f = await fixture(t); const id = randomUUID(); const created = await f.invoke({ action: 'create', id, title: 'Two', folders: [f.paths.a, f.paths.b] });
  const request = { action: 'update', projectId: id, folders: [f.paths.b], mainFolder: f.paths.b };
  const thread = f.session(f.paths.a); await assert.rejects(f.invoke(request), errorCode('PROJECT_FOLDER_IN_USE')); f.headers.delete(thread.id);
  const startId = randomUUID(); const now = Date.now(); await f.store.starts.put(startId, { id: startId, projectId: id, folderId: created.project.mainFolderId, actorId: null, effectiveCwd: f.paths.a, requestedSessionId: startId, phase: 'recovery-required', sessionId: null, workspaceId: null, createdAt: now, updatedAt: now });
  await assert.rejects(f.invoke(request), errorCode('PROJECT_FOLDER_IN_USE')); await f.store.starts.delete(startId);
  // Only the child's durable ownership hint remains; its managed Git parent is unavailable.
  const row = managed(f, { repoRoot: resolve(f.directory, 'unavailable-parent'), projectId: id, folderId: created.project.mainFolderId }); assert.notEqual(resolve(row.repoRoot, row.projectSubdir), f.paths.a);
  await assert.rejects(f.invoke(request), errorCode('PROJECT_FOLDER_IN_USE')); assert.equal(f.store.projects.get(id).mainFolderId, created.project.mainFolderId);
  delete row.projectId; delete row.folderId; row.repoRoot = resolve(f.directory, 'unknown');
  const commonDir = resolve(f.directory, 'shared.git'); const parentRoot = resolve(f.directory, 'parent-checkout'); const ancestor = managed(f, { repoRoot: f.directory, projectSubdir: 'a', commonDir, checkoutRoot: parentRoot, effectiveCwd: resolve(parentRoot, 'a') });
  row.repoRoot = ancestor.checkoutRoot; row.projectSubdir = 'a'; row.commonDir = commonDir;
  await assert.rejects(f.invoke(request), errorCode('PROJECT_FOLDER_IN_USE'));
});

test('default starts use current main, explicit overrides stay exact and replay pins receipt across serialized main changes', async t => {
  const f = await fixture(t); const id = randomUUID(); const created = await f.invoke({ action: 'create', id, title: 'Two', folders: [f.paths.a, f.paths.b] });
  const request = { action: 'start', operationId: randomUUID(), projectId: id };
  const [first, updated, replay, second] = await Promise.all([f.invoke(request), f.invoke({ action: 'update', projectId: id, mainFolder: f.paths.b }), f.invoke(request), f.invoke({ ...request, operationId: randomUUID() })]);
  assert.equal(first.binding.effectiveCwd, f.paths.a); assert.equal(updated.project.mainFolderId, created.project.folders[1].id); assert.deepEqual(replay, first); assert.equal(second.binding.effectiveCwd, f.paths.b);
  assert.deepEqual(await f.invoke({ ...request, folderId: created.project.folders[0].id }), first);
  await assert.rejects(f.invoke({ ...request, folderId: created.project.folders[1].id }), errorCode('OPERATION_REUSED'));
  const overridden = await f.invoke({ ...request, operationId: randomUUID(), folderId: created.project.folders[0].id }); assert.equal(overridden.binding.effectiveCwd, f.paths.a);
  assert.equal(f.calls.filter(([kind]) => kind === 'native').length, 3); assert.equal(f.store.starts.get(request.operationId).folderId, created.project.folders[0].id);
  assert.equal(f.headers.get(first.sessionId).cwd, f.paths.a); assert.equal(f.controller.resolveFolder(id).path, f.paths.b);
});

test('default-start authorization checks receipt/captured folder, not a newly different main, before effects', async t => {
  const f = await fixture(t); const id = randomUUID(); const created = await f.invoke({ action: 'create', id, title: 'Two', folders: [f.paths.a, f.paths.b] });
  const actor = f.actor(); const invocation = { ...f.invocation, origin: 'tool', agent: actor }; f.policy.set(actor.id, 'workspace-write');
  const ownRequest = { action: 'start', operationId: randomUUID(), projectId: id }; const own = await f.controller.execute(ownRequest, invocation);
  await f.invoke({ action: 'update', projectId: id, mainFolder: f.paths.b }); const count = f.calls.length;
  assert.deepEqual(await f.controller.execute(ownRequest, invocation), own); assert.equal(f.calls.slice(count).filter(([kind]) => ['bootstrap', 'settings', 'native', 'registry'].includes(kind)).length, 0);
  const denied = { ...ownRequest, operationId: randomUUID() }; await assert.rejects(f.controller.execute(denied, invocation), errorCode('FULL_ACCESS_REQUIRED')); assert.equal(f.store.starts.get(denied.operationId), undefined);
  const explicitOwn = await f.controller.execute({ ...denied, folderId: created.project.folders[0].id }, invocation); assert.equal(explicitOwn.binding.effectiveCwd, f.paths.a);
  f.policy.set(actor.id, 'danger-full-access'); const crossRequest = { ...ownRequest, operationId: randomUUID() }; const cross = await f.controller.execute(crossRequest, invocation); assert.equal(cross.binding.effectiveCwd, f.paths.b);
  await f.invoke({ action: 'update', projectId: id, mainFolder: f.paths.a }); f.policy.set(actor.id, 'workspace-write'); const receipt = structuredClone(f.store.starts.get(crossRequest.operationId)); const crossCount = f.calls.length;
  await assert.rejects(f.controller.execute(crossRequest, invocation), errorCode('FULL_ACCESS_REQUIRED')); assert.deepEqual(f.store.starts.get(crossRequest.operationId), receipt); assert.equal(f.calls.slice(crossCount).filter(([kind]) => ['bootstrap', 'settings', 'native', 'registry'].includes(kind)).length, 0);
  const impostor = { ...actor }; await assert.rejects(f.controller.execute(ownRequest, { ...invocation, agent: impostor }), errorCode('SESSION_CHANGED'));
  await assert.rejects(f.controller.execute({ ...ownRequest, projectId: randomUUID() }, { ...invocation, agent: impostor }), errorCode('SESSION_CHANGED'));
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(f.controller.execute({ ...ownRequest, projectId: randomUUID() }, { ...invocation, signal: aborted.signal }), errorCode('CANCELLED'));
  const other = f.actor(); await assert.rejects(f.controller.execute(ownRequest, { ...invocation, agent: other }), errorCode('OPERATION_REUSED'));
});

test('default starts recheck authority, settings and cancellation on captured folder before session effects', async t => {
  const f = await fixture(t); const id = randomUUID(); const created = await f.invoke({ action: 'create', id, title: 'Two', folders: [f.paths.a, f.paths.b], mainFolder: f.paths.b });
  const actor = f.actor(); const invocation = { ...f.invocation, origin: 'tool', agent: actor }; const settings = f.dependencies.bootstrap.settings;
  const request = () => ({ action: 'start', operationId: randomUUID(), projectId: id });
  f.dependencies.bootstrap.settings = async (...args) => { const result = await settings(...args); await f.store.projects.put(id, { ...created.project, mainFolderId: created.project.folders[0].id }); f.policy.set(actor.id, 'workspace-write'); return result; };
  const denied = request(); await assert.rejects(f.controller.execute(denied, invocation), errorCode('FULL_ACCESS_REQUIRED')); assert.equal(f.store.starts.get(denied.operationId), undefined); assert.equal(f.controller.resolveFolder(id).path, f.paths.a);
  await f.store.projects.put(id, created.project); f.policy.set(actor.id, 'danger-full-access'); let settingsCalls = 0;
  f.dependencies.bootstrap.settings = async (...args) => ({ ...await settings(...args), hash: ++settingsCalls === 1 ? 'captured' : 'changed' });
  const changed = request(); await assert.rejects(f.controller.execute(changed, invocation), errorCode('SETTINGS_CHANGED')); assert.equal(f.store.starts.get(changed.operationId).phase, 'recovery-required'); assert.equal(f.store.starts.get(changed.operationId).folderId, created.project.mainFolderId);
  f.dependencies.bootstrap.settings = settings; const abort = new AbortController();
  f.dependencies.bootstrap.settings = async (...args) => { const result = await settings(...args); abort.abort(); return result; };
  const cancelled = request(); await assert.rejects(f.controller.execute(cancelled, { ...invocation, signal: abort.signal }), errorCode('CANCELLED')); assert.equal(f.store.starts.get(cancelled.operationId), undefined);
  assert.equal(f.calls.filter(([kind]) => ['native', 'bootstrap'].includes(kind)).length, 0);
});

test('legacy first-main repair persists across restart without rebinding existing sessions, then edited main and replay survive another restart', async t => {
  const f = await fixture(t); const a = await f.registry.create(f.paths.a); const b = await f.registry.create(f.paths.b); const id = randomUUID();
  const legacy = { id, title: 'Legacy', folders: [{ id: b.id, path: b.path, title: b.title }, { id: a.id, path: a.path, title: a.title }], createdAt: 1, updatedAt: 2 }; await f.store.projects.put(id, legacy);
  const local = f.session(f.paths.a); const binding = { sessionId: local.id, projectId: id, folderId: a.id, mode: 'local', effectiveCwd: f.paths.a }; await f.store.bindings.put(local.id, binding);
  const filename = resolve(f.directory, 'main-restart.json');
  const persist = async store => writeFile(filename, JSON.stringify(Object.fromEntries(['projects', 'bindings', 'starts', 'removals'].map(name => [name, [...store[name].entries()]]))));
  const load = async () => { const loaded = JSON.parse(await readFile(filename, 'utf8')); const store = Object.fromEntries(['projects', 'bindings', 'starts', 'removals'].map(name => [name, table(projectDomain.tables[name].valueSchema, loaded[name])])); store.close = async () => {}; return store; };
  await persist(f.store); await f.controller.close(); const store = await load(); const restarted = new ProjectController(f.owner, store, { records: () => f.worktrees }, f.dependencies); t.after(() => restarted.close());
  assert.equal(restarted.resolveFolder(id).id, b.id); await restarted.synchronize(); assert.deepEqual(store.projects.get(id), { ...legacy, mainFolderId: b.id }); assert.deepEqual(store.bindings.get(local.id), binding); assert.equal(f.headers.get(local.id).cwd, f.paths.a);
  const request = { action: 'start', operationId: randomUUID(), projectId: id }; const first = await restarted.execute(request, f.invocation); assert.equal(first.binding.folderId, b.id);
  await restarted.execute({ action: 'update', projectId: id, mainFolder: f.paths.a }, f.invocation); await persist(store); await restarted.close();
  const lastStore = await load(); const last = new ProjectController(f.owner, lastStore, { records: () => f.worktrees }, f.dependencies); t.after(() => last.close());
  assert.equal(last.resolveFolder(id).id, a.id); assert.deepEqual(await last.execute(request, f.invocation), first); assert.equal(lastStore.projects.get(id).mainFolderId, a.id); assert.deepEqual(lastStore.bindings.get(local.id), binding); assert.equal(f.calls.filter(([kind]) => kind === 'native').length, 1);
});

test('partial imported adoption preserves a retained main or selects the first remaining member when its main was adopted', async t => {
  const f = await fixture(t); const a = await f.registry.create(f.paths.a); const b = await f.registry.create(f.paths.b); const c = await f.registry.create(f.paths.c);
  const folder = workspace => ({ id: workspace.id, path: workspace.path, title: workspace.title }); const importedId = randomUUID();
  await f.store.projects.put(importedId, { id: importedId, title: 'Imported group', imported: true, folders: [folder(a), folder(b), folder(c)], mainFolderId: c.id, createdAt: 1, updatedAt: 2 });
  await f.invoke({ action: 'create', id: randomUUID(), title: 'Adopt A', folders: [f.paths.a] }); assert.equal(f.store.projects.get(importedId).mainFolderId, c.id); assert.deepEqual(f.store.projects.get(importedId).folders.map(value => value.id), [b.id, c.id]);
  await f.invoke({ action: 'create', id: randomUUID(), title: 'Adopt C', folders: [f.paths.c] }); assert.equal(f.store.projects.get(importedId).mainFolderId, b.id); assert.deepEqual(f.store.projects.get(importedId).folders.map(value => value.id), [b.id]);
});


test('strict remove exposes only project UUID and metadata-only semantics', () => {
  const request = { action: 'remove', projectId: randomUUID() };
  assert.deepEqual(parseProjectRequest(request), request);
  for (const projectId of ['', 'folder-id', null, 1]) assert.throws(() => parseProjectRequest({ ...request, projectId }), errorCode('INVALID_REQUEST'));
  for (const field of ['id', 'folders', 'folderId', 'deleteFolders', 'recursive', 'force', 'permissions', 'origin', 'actorId', 'settings']) assert.throws(() => parseProjectRequest({ ...request, [field]: true }), errorCode('INVALID_REQUEST'));
  const remove = parameterSchema.oneOf.find(value => value.properties.action.const === 'remove');
  assert.equal(remove.additionalProperties, false); assert.deepEqual(remove.required, ['action', 'projectId']);
  assert.deepEqual(Object.keys(remove.properties), ['action', 'projectId']); assert.equal(remove.properties.projectId.format, 'uuid');
  assert.match(remove.properties.projectId.description, /only project metadata/u); assert.match(remove.properties.projectId.description, /remain/u);
  const receipt = { id: request.projectId, folders: [{ id: 'folder', path: '/source' }], removedAt: 1 };
  assert.deepEqual(projectDomain.tables.removals.valueSchema.parse(receipt), receipt);
  assert.equal(projectDomain.tables.removals.valueSchema.safeParse({ ...receipt, title: 'Deleted title' }).success, false);
});

test('remove allows running/bound Local and managed threads and all start receipts, touching only its own metadata', async t => {
  const f = await fixture(t); const id = randomUUID(); const created = await f.invoke({ action: 'create', id, title: 'Remove metadata', folders: [f.paths.a, f.paths.b] });
  const local = f.actor(); local.status = 'running'; const isolated = f.actor(f.paths.checkout); isolated.status = 'running'; const unrelated = f.session(f.paths.c);
  const row = managed(f, { projectId: id, folderId: created.project.folders[0].id, sessionIds: [isolated.id], branch: 'worktree/retained', baseRef: 'refs/retained', archived: true, protected: true });
  const readyRequest = { action: 'start', operationId: randomUUID(), projectId: id }; await f.invoke(readyRequest);
  const recoveryId = randomUUID(); await f.store.starts.put(recoveryId, { ...f.store.starts.get(readyRequest.operationId), id: recoveryId, requestedSessionId: recoveryId, phase: 'recovery-required' });
  await f.registry.create(f.paths.c); await f.controller.synchronize(); const otherProject = f.controller.folderForPath(f.paths.c).projectId;
  const sentinelPaths = [resolve(f.paths.a, 'sentinel.txt'), resolve(f.paths.b, 'sentinel.txt'), resolve(f.paths.checkout, '.git')];
  for (const path of sentinelPaths) await writeFile(path, 'must remain byte-for-byte');
  const headers = structuredClone([...f.headers]); const events = structuredClone([...f.sessionEvents]); const worktrees = structuredClone(f.worktrees); const starts = structuredClone([...f.store.starts.entries()]);
  const native = f.registry.list().map(workspace => ({ id: workspace.id, path: workspace.path, title: workspace.title, sessionIds: [...workspace.sessionIds] }));
  const other = structuredClone(f.store.projects.get(otherProject)), otherBinding = structuredClone(f.store.bindings.get(unrelated.id));
  f.registry.delete = f.registry.removeWorkspace = () => assert.fail('native workspace deletion is forbidden'); f.services.sessionController.removeSession = () => assert.fail('session deletion is forbidden');
  const count = f.calls.length; const request = { action: 'remove', projectId: id };
  const expected = { removed: true, projectId: id, scope: 'project-metadata' };
  assert.deepEqual(await f.invoke(request), expected); assert.deepEqual(await f.invoke(request), expected);
  assert.equal(f.calls.length, count, 'remove needs no native or session services');
  const receipt = f.store.removals.get(id); assert.deepEqual(Object.keys(receipt), ['id', 'folders', 'removedAt']); assert.deepEqual(receipt.folders, created.project.folders.map(({ id, path }) => ({ id, path })));
  assert.equal(f.store.projects.get(id), undefined); assert.ok(![...f.store.bindings.entries()].some(([, binding]) => binding.projectId === id));
  assert.equal(f.controller.bindingFor(local.id), undefined); assert.equal(f.controller.bindingFor(isolated.id), undefined); assert.equal(f.controller.selectionForWorktree(row.id), undefined);
  assert.throws(() => f.controller.resolveFolder(id), errorCode('PROJECT_FOLDER_NOT_FOUND'));
  assert.deepEqual(await f.invoke({ action: 'list', projectId: id }), { projects: [], bindings: [], records: [] });
  assert.deepEqual(f.headers.size, headers.length); assert.deepEqual([...f.headers], headers); assert.deepEqual([...f.sessionEvents], events); assert.deepEqual(f.worktrees, worktrees); assert.deepEqual([...f.store.starts.entries()], starts);
  assert.deepEqual(f.registry.list().map(workspace => ({ id: workspace.id, path: workspace.path, title: workspace.title, sessionIds: [...workspace.sessionIds] })), native);
  assert.deepEqual(f.store.projects.get(otherProject), other); assert.deepEqual(f.store.bindings.get(unrelated.id), otherBinding);
  for (const path of sentinelPaths) assert.equal(await readFile(path, 'utf8'), 'must remain byte-for-byte');
  assert.equal(local.status, 'running'); assert.equal(isolated.status, 'running');
  await assert.rejects(f.invoke({ action: 'remove', projectId: randomUUID() }), errorCode('PROJECT_NOT_FOUND'));
});

test('tombstone-first interrupted cleanup masks membership immediately and replay or restart completes each crash boundary', async t => {
  for (const boundary of ['project', 'first-binding', 'second-binding']) await t.test(boundary, async t => {
    const f = await fixture(t); const id = randomUUID(); const created = await f.invoke({ action: 'create', id, title: 'Interrupted', folders: [f.paths.a] });
    const first = f.session(f.paths.a), second = f.session(f.paths.a), isolated = f.session(f.paths.checkout); const row = managed(f, { projectId: id, folderId: created.project.mainFolderId, sessionIds: [isolated.id] });
    await f.controller.synchronize(); const projectsDelete = f.store.projects.delete, bindingsDelete = f.store.bindings.delete; let deletes = 0;
    if (boundary === 'project') f.store.projects.delete = async () => { throw Error('project deletion interrupted'); };
    else f.store.bindings.delete = async key => { if (++deletes === (boundary === 'first-binding' ? 1 : 2)) throw Error('binding deletion interrupted'); return bindingsDelete(key); };
    await assert.rejects(f.invoke({ action: 'remove', projectId: id }), /deletion interrupted/u);
    assert.ok(f.store.removals.get(id)); assert.deepEqual(f.controller.records(), []); assert.equal(f.controller.folderForPath(f.paths.a), undefined);
    for (const thread of [first, second, isolated]) assert.equal(f.controller.bindingFor(thread.id), undefined);
    assert.equal(f.controller.selectionForWorktree(row.id), undefined); assert.throws(() => f.controller.resolveFolder(id), errorCode('PROJECT_FOLDER_NOT_FOUND'));
    f.store.projects.delete = projectsDelete; f.store.bindings.delete = bindingsDelete;
    if (boundary === 'first-binding') {
      assert.deepEqual(await f.invoke({ action: 'remove', projectId: id }), { removed: true, projectId: id, scope: 'project-metadata' });
    } else {
      const persisted = Object.fromEntries(Object.keys(projectDomain.tables).map(name => [name, [...f.store[name].entries()]])); await f.controller.close();
      const store = Object.fromEntries(Object.keys(projectDomain.tables).map(name => [name, table(projectDomain.tables[name].valueSchema, persisted[name])]));
      const restarted = new ProjectController(f.owner, store, { records: () => f.worktrees }, f.dependencies); t.after(() => restarted.close());
      await restarted.synchronize(); assert.deepEqual(await restarted.execute({ action: 'list' }, f.invocation), { projects: [], bindings: [], records: [row] });
      assert.equal(store.projects.get(id), undefined); assert.equal([...store.bindings.entries()].length, 0);
      assert.deepEqual(await restarted.execute({ action: 'remove', projectId: id }, f.invocation), { removed: true, projectId: id, scope: 'project-metadata' });
    }
  });
});

test('failed receipt write leaves project/bindings untouched; cancellation and exact caller/plan guards remain fail closed', async t => {
  const f = await fixture(t); const id = randomUUID(); await f.invoke({ action: 'create', id, title: 'Guarded', folders: [f.paths.a] }); const actor = f.actor(); await f.controller.synchronize();
  const request = { action: 'remove', projectId: id }; const invocation = { ...f.invocation, agent: actor, origin: 'tool' };
  const before = structuredClone([...f.store.projects.entries()]), bindings = structuredClone([...f.store.bindings.entries()]);
  const put = f.store.removals.put; f.store.removals.put = async () => { throw Error('storage before commit'); };
  await assert.rejects(f.controller.execute(request, invocation), /storage before commit/u); assert.deepEqual([...f.store.projects.entries()], before); assert.deepEqual([...f.store.bindings.entries()], bindings); assert.equal(f.store.removals.map.size, 0);
  f.store.removals.put = put;
  for (const origin of ['tool', 'command']) await assert.rejects(f.controller.execute(request, { ...f.invocation, origin }), errorCode('NO_CALLER'));
  await assert.rejects(f.controller.execute(request, { ...invocation, agent: { ...actor } }), errorCode('SESSION_CHANGED'));
  const child = f.actor(f.paths.a, 'subagent'); await assert.rejects(f.controller.execute(request, { ...invocation, agent: child }), errorCode('SUBAGENT_SOURCE'));
  for (const state of [{ active: true, pending: false }, { active: false, pending: true }]) { f.plans.set(actor.id, state); await assert.rejects(f.controller.execute(request, invocation), errorCode('PLAN_MODE')); }
  f.plans.set(actor.id, { active: false, pending: false }); const early = new AbortController(); early.abort(); await assert.rejects(f.controller.execute(request, { ...invocation, signal: early.signal }), errorCode('CANCELLED')); assert.equal(f.store.removals.map.size, 0);
  const committed = new AbortController(); f.store.removals.put = async (...args) => { await put(...args); committed.abort(); };
  await assert.rejects(f.controller.execute(request, { ...invocation, signal: committed.signal }), errorCode('CANCELLED')); assert.equal(f.store.projects.get(id), undefined); assert.equal(f.store.bindings.map.size, 0); const receipt = structuredClone(f.store.removals.get(id));
  f.store.removals.put = async () => assert.fail('replay must not replace receipt');
  f.plans.set(actor.id, { active: true }); await assert.rejects(f.controller.execute(request, invocation), errorCode('PLAN_MODE'));
  assert.deepEqual(await f.controller.execute(request, { ...invocation, origin: 'command' }), { removed: true, projectId: id, scope: 'project-metadata' }); assert.deepEqual(f.store.removals.get(id), receipt);
});

test('durable removal suppresses list/restart/ensureFolder imports, permits fresh UUID adoption and makes stale remove harmless', async t => {
  const f = await fixture(t); const id = randomUUID(); const created = await f.invoke({ action: 'create', id, title: 'Retain folders', folders: [f.paths.a, f.paths.b] }); const local = f.session(f.paths.a), isolated = f.session(f.paths.checkout);
  const row = managed(f, { projectId: id, folderId: created.project.folders[0].id, sessionIds: [isolated.id] }); await f.controller.synchronize();
  await f.invoke({ action: 'remove', projectId: id }); const count = f.calls.length;
  assert.equal(await f.controller.ensureFolder(f.paths.a), undefined); assert.equal(await f.controller.ensureFolder(f.paths.b), undefined); assert.equal(f.calls.length, count);
  const filename = resolve(f.directory, 'removed-restart.json'); await writeFile(filename, JSON.stringify(Object.fromEntries(Object.keys(projectDomain.tables).map(name => [name, [...f.store[name].entries()]])))); await f.controller.close();
  const loaded = JSON.parse(await readFile(filename, 'utf8')); const store = Object.fromEntries(Object.keys(projectDomain.tables).map(name => [name, table(projectDomain.tables[name].valueSchema, loaded[name])]));
  const restarted = new ProjectController(f.owner, store, { records: () => f.worktrees }, f.dependencies); t.after(() => restarted.close()); const invoke = request => restarted.execute(request, f.invocation);
  await restarted.synchronize(); assert.deepEqual((await invoke({ action: 'list' })).projects, []); assert.equal(await restarted.ensureFolder(f.paths.a), undefined);
  for (const removedId of [id, id.toUpperCase()]) await assert.rejects(invoke({ action: 'create', id: removedId, title: 'Recycled', folders: [f.paths.a] }), errorCode('PROJECT_REMOVED'));
  await assert.rejects(invoke({ action: 'update', projectId: id, title: 'Unknown' }), errorCode('PROJECT_NOT_FOUND'));
  const newId = randomUUID(); const adopted = await invoke({ action: 'create', id: newId, title: 'Explicitly re-added', folders: [f.paths.a, f.paths.b] });
  assert.deepEqual(adopted.project.folders.map(folder => folder.id), created.project.folders.map(folder => folder.id)); assert.equal(restarted.bindingFor(local.id).projectId, newId); assert.equal(restarted.bindingFor(isolated.id).projectId, newId);
  assert.equal(restarted.selectionForWorktree(row.id).projectId, newId); assert.equal((await restarted.ensureFolder(f.paths.a)).projectId, newId);
  assert.deepEqual(await invoke({ action: 'remove', projectId: id }), { removed: true, projectId: id, scope: 'project-metadata' }); assert.deepEqual(store.projects.get(newId), adopted.project);
  // Suppression is not consumed by re-add: dropping a now-unused folder cannot resurrect it.
  await invoke({ action: 'update', projectId: newId, folders: [f.paths.a] }); await restarted.synchronize(); assert.equal(restarted.folderForPath(f.paths.b), undefined); assert.equal(await restarted.ensureFolder(f.paths.b), undefined);
  assert.equal(store.removals.get(id).folders.length, 2); assert.deepEqual(f.worktrees, [row]); assert.equal(f.headers.get(local.id).cwd, f.paths.a);
});

test('receipt commit still finishes metadata cleanup when actual caller or plan changes, and preserves exact request UUID', async t => {
  for (const change of ['caller', 'plan']) await t.test(change, async t => {
    const f = await fixture(t); const id = randomUUID().toUpperCase(); await f.invoke({ action: 'create', id, title: 'Exact UUID', folders: [f.paths.a] }); const actor = f.actor(); await f.controller.synchronize();
    f.policy.set(actor.id, 'read-only'); const invocation = { ...f.invocation, origin: 'tool', agent: actor }; const request = { action: 'remove', projectId: id };
    const put = f.store.removals.put; f.store.removals.put = async (...args) => { await put(...args); if (change === 'caller') f.actors.delete(actor.id); else f.plans.set(actor.id, { active: false, pending: true }); };
    await assert.rejects(f.controller.execute(request, invocation), errorCode(change === 'caller' ? 'SESSION_CHANGED' : 'PLAN_MODE'));
    assert.equal(f.store.projects.get(id), undefined); assert.equal(f.store.bindings.map.size, 0); const receipt = structuredClone(f.store.removals.get(id));
    f.actors.set(actor.id, actor); f.plans.set(actor.id, { active: false, pending: false }); f.store.removals.put = async () => assert.fail('stale retry cannot replace a receipt');
    assert.deepEqual(await f.controller.execute(request, invocation), { removed: true, projectId: id, scope: 'project-metadata' }); assert.deepEqual(f.store.removals.get(id), receipt); assert.equal(f.policy.get(actor.id), 'read-only');
  });
});
