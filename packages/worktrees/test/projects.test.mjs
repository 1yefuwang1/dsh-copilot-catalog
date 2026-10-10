import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ProjectController, parseProjectRequest, parameterSchema } from '../dist/projects.js';
import { projectDomain } from '../dist/project-store.js';
import { WorktreeError } from '../dist/errors.js';

const errorCode = code => error => error instanceof WorktreeError && error.code === code;
function table(schema, initial = [], persist = async () => {}) {
  const map = new Map(initial);
  return { map, get: id => map.get(id), entries: () => map.entries(), async put(id, value) { map.set(id, structuredClone(schema.parse(value))); await persist(); }, async delete(id) { const deleted = map.delete(id); await persist(); return deleted; } };
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
  const store = { projects: table(projectDomain.tables.projects.valueSchema), bindings: table(projectDomain.tables.bindings.valueSchema), starts: table(projectDomain.tables.starts.valueSchema), async close() {} };
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
  const imported = await f.invoke({ action: 'list' }); assert.equal(imported.projects.length, 2); assert.ok(imported.projects.every(project => project.imported === true));
  assert.equal(imported.bindings.length, 2); assert.ok(imported.bindings.every(binding => binding.mode === 'local'));
  const id = randomUUID(); const result = await f.invoke({ action: 'create', id, title: 'Combined', folders: [f.paths.a, f.paths.b] });
  assert.deepEqual(result.project.folders.map(folder => folder.id), [a.id, b.id]); assert.equal(result.project.imported, undefined);
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
  for (const request of [null, [], {}, { action: 'remove', projectId: id }, { ...base, title: ' ' }, { ...base, title: 'x'.repeat(121) }, { ...base, folders: [] }, { ...base, folders: Array(33).fill(f.paths.a) }, { ...base, folders: ['relative'] }, { ...base, permissions: 'full' }, { action: 'list', folderId: id }, { action: 'update', projectId: id }, { ...base, folders: ['/tmp/line\nbreak'] }]) assert.throws(() => parseProjectRequest(request), errorCode('INVALID_REQUEST'));
  let accessor = false; const request = { action: 'list' }; Object.defineProperty(request, 'evil', { enumerable: true, get() { accessor = true; return 1; } }); assert.throws(() => parseProjectRequest(request)); assert.equal(accessor, false);
  assert.ok(!JSON.stringify(parameterSchema).includes('~standard')); assert.equal(parameterSchema.oneOf.length, 5);
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
  for (const origin of ['tool', 'command']) await assert.rejects(f.controller.execute({ action: 'list' }, { ...f.invocation, origin }), errorCode('NO_CALLER'));
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
  await writeFile(filename, JSON.stringify(Object.fromEntries(['projects', 'bindings', 'starts'].map(name => [name, [...f.store[name].entries()]]))));
  await f.controller.close(); const loaded = JSON.parse(await readFile(filename, 'utf8'));
  const store = Object.fromEntries(['projects', 'bindings', 'starts'].map(name => [name, table(projectDomain.tables[name].valueSchema, loaded[name])])); store.close = async () => {};
  const restarted = new ProjectController(f.owner, store, { records: () => f.worktrees }, f.dependencies); t.after(() => restarted.close());
  await restarted.synchronize(); const snapshot = await restarted.execute({ action: 'list' }, f.invocation); assert.equal(snapshot.projects.length, 1); assert.deepEqual(snapshot.projects[0], explicit); assert.ok(snapshot.bindings.every(binding => binding.projectId === id));
  assert.equal(projectDomain.name, 'dsh_worktree_projects'); assert.equal(projectDomain.version, 1); assert.deepEqual(Object.keys(projectDomain.tables), ['projects', 'bindings', 'starts']);
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
  await writeFile(filename, JSON.stringify(Object.fromEntries(['projects', 'bindings', 'starts'].map(name => [name, [...f.store[name].entries()]])))); await f.controller.close();
  const loaded = JSON.parse(await readFile(filename, 'utf8')); const store = Object.fromEntries(['projects', 'bindings', 'starts'].map(name => [name, table(projectDomain.tables[name].valueSchema, loaded[name])])); store.close = async () => {};
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
