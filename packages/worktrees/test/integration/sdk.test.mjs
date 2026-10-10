import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises';
import vm from 'node:vm';
import { basename, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { HostConnectionService, serverResponseSchema } from '@deepseek-ai/dsh-client-connection';
import * as plugin from '../../dist/index.js';
import { WorktreeReminders } from '../../dist/context.js';
import { ProjectReminders, renderProjectContext } from '../../dist/project-context.js';

function record(root) {
  const id = randomUUID(); return { id, operationId: randomUUID(), repoRoot: resolve(root, 'original'), commonDir: resolve(root, 'original/.git'), projectSubdir: 'project', checkoutRoot: resolve(root, 'isolated'), effectiveCwd: resolve(root, 'isolated/project'), remote: 'origin', remoteIdentity: 'opaque', remoteBranch: 'main', baseOid: 'a'.repeat(40), baseRef: `refs/dsh-worktrees/${id}/base`, fetchedAt: 1, createdAt: 1, sessionIds: [], workspaceId: null, branch: null, protected: false, archived: false, state: 'ready', error: null };
}
function table() { const map = new Map(); return { map, get: key => map.get(key), entries: () => map.entries(), async put(key, value) { map.set(key, structuredClone(value)); }, async delete(key) { return map.delete(key); } }; }
function domainTables(worktree) {
  const tables = { dsh_worktrees: { worktrees: table(), operations: table() }, dsh_worktree_projects: { projects: table(), bindings: table(), starts: table(), removals: table() } };
  tables.dsh_worktrees.worktrees.map.set(worktree.id, worktree); return tables;
}
async function hostFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'worktree-sdk-owned-')); assert.equal(dirname(root), await realpath(tmpdir()));
  const host = new Context(); new SessionStore(host); new SystemPrompt(host, { includeHarnessIdentity: false }); new ToolRuntime(host); new CommandRuntime(host);
  const scopes = []; const agents = new Map(); const events = [];
  host.on('session/event', (session, event) => { events.push({ session, event }); });
  function agent(cwd, origin) {
    const value = { id: SessionId(randomUUID()), options: { provider: 'github-copilot', model: 'gpt-6.1-sol' }, status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
    const scope = createScope(host, value); scopes.push(scope); value.scope = scope; value.ctx = scope.ctx;
    value.session = scope.ctx.sessions.create(value.id, { meta: { cwd, ...(origin ? { origin } : {}) } }); agents.set(value.id, value); return value;
  }
  host.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()] });
  host.provide('sessionQuery', {
    async listSessions() { return [...agents.values()].map(value => ({ header: value.session.header, live: true, persisted: true })); },
    async observeSession(id) { const value = agents.get(id); return { header: value.session.header, events: events.filter(e => e.session.id === id).map(e => e.event), projections: { values: { modelSelection: { next: value.options } } }, [Symbol.dispose]() {} }; },
  });
  const nativeWorkspaces = new Map();
  const registry = {
    list: () => [...nativeWorkspaces.values()],
    async create(path, title) {
      const canonical = await realpath(path);
      const existing = [...nativeWorkspaces.values()].find(value => value.path === canonical); if (existing) return existing;
      const workspace = { id: randomUUID(), path: canonical, title: title ?? basename(canonical), sessionIds: [], async attachSession(id) {
        assert.equal(agents.get(id).session.header.cwd, canonical); if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
      } };
      nativeWorkspaces.set(workspace.id, workspace); return workspace;
    },
  };
  host.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'danger-full-access', workspaceRoot: session.header.cwd }) });
  host.provide('subprocess', { async resolveExecutable() { throw Error('No processes are permitted in SDK registration tests'); }, spawn() { throw Error('No processes are permitted in SDK registration tests'); } });
  t.after(async () => { for (const scope of scopes) await scope.dispose(); assert.equal(dirname(root), await realpath(tmpdir())); await rm(root, { recursive: true, force: true }); });
  return { host, root, agent, agents, scopes, events, registry };
}

async function connectionFixture(f) {
  const owner = createScope(f.host, {}); f.scopes.push(owner);
  await owner.ctx.fiber.await();
  // Test-only credentials: no credential provider, profile or launch token is read.
  const authority = '127.0.0.1:43127';
  const cookie = 'test-browser-session=authenticated';
  new HostConnectionService(owner.ctx, [], {
    isAuthenticated: request => request.headers.get('host') === authority && request.headers.get('cookie') === cookie,
  });
  const connection = f.host.get('connection');
  const gatewayOwner = createScope(f.host, {}); f.scopes.push(gatewayOwner);
  const gatewayCalls = [];
  gatewayOwner.ctx.get('connection').rpc.intercept('/api', endpoint => endpoint === 'session/foo', async (endpoint, payload, signal, peer) => {
    gatewayCalls.push({ endpoint, payload, signal, peer }); return { ok: true, value: true };
  });
  const shared = connection.createSharedFetchHandler('/api');
  async function response(endpoint, payload, options = {}) {
    const rpcId = options.rpcId ?? randomUUID();
    const request = new Request(`http://${authority}/api/${endpoint}`, {
      method: 'POST', headers: { host: authority, origin: `http://${authority}`, cookie, 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { response: await shared.fetch(request), rpcId };
  }
  async function rpc(endpoint, payload, options) {
    const result = await response(endpoint, payload, options);
    assert.equal(result.response.status, 200);
    const wire = await result.response.json();
    assert.equal(wire.type, 'server-response'); assert.equal(wire.rpcId, result.rpcId);
    assert.equal(serverResponseSchema.safeParse(wire).success, true);
    assert.deepEqual(Object.keys(wire).sort(), ['result', 'rpcId', 'type']);
    return wire.result;
  }
  return { connection, shared, rpc, response, gatewayCalls };
}

test('native root Config defaults to existing Host root and returns a bounded volatile string', () => {
  const defaults = plugin.Config({});
  assert.equal(typeof defaults.root, 'object'); assert.equal(typeof defaults.root.get, 'function');
  assert.equal(defaults.root.get(), dshHomePath('worktrees'));
  const root = resolve(tmpdir(), 'managed root with spaces');
  assert.equal(plugin.Config({ root }).root.get(), root);
  const schema = plugin.Config.dict.root;
  assert.equal(schema.type, 'string'); assert.equal(schema.meta.volatile, true);
  assert.equal(schema.meta.min, 1); assert.equal(schema.meta.max, 4096); assert.equal(typeof schema.meta.pattern.source, 'string');
  for (const value of ['', ' ', 'relative/root', ` ${root}`, `${root} `, `${root}\u0000bad`, `${root}\nline`, `${root}\n`, '/'.repeat(4097)]) {
    assert.throws(() => plugin.Config({ root: value }), /root/u);
  }
});

test('public plain-string apply config retains compatibility and invalid getters open no storage', async t => {
  const f = await hostFixture(t), source = f.agent(f.root), worktree = record(f.root), tables = domainTables(worktree);
  let opened = 0;
  f.host.provide('storageDomain', { async open(spec) { opened++; return { table: name => tables[spec.name][name], async close() {} }; } });
  f.host.provide('sessionPersistence', {}); f.host.provide('workspaceRegistry', f.registry);
  const config = { ...plugin.Config({}), root: relative(process.cwd(), resolve(f.root, 'legacy-managed')) };
  const owner = f.host.plugin({ name: 'plain-root-config-compat', apply: ctx => plugin.apply(ctx, config) }); f.scopes.push(owner); await owner;
  assert.equal(opened, 2); assert.equal(f.host.commands.find(source, 'worktree').name, 'worktree');
  await owner.dispose();
  for (const root of [{ get() { throw Error('private getter failure'); } }, { get: () => 'relative-live-root' }, { get: () => '' }, { get: () => resolve('/') }]) {
    await assert.rejects(plugin.apply(owner.ctx, { ...config, root }), error => ['INVALID_ROOT', 'UNSAFE_ROOT'].includes(error.code));
  }
  assert.equal(opened, 2, 'invalid initial roots fail before storage is opened');
});

test('optional native settings presentation belongs to plugin fiber and is disposed with it', async t => {
  const f = await hostFixture(t), worktree = record(f.root), tables = domainTables(worktree), calls = [];
  f.host.provide('storageDomain', { async open(spec) { return { table: name => tables[spec.name][name], async close() {} }; } });
  f.host.provide('sessionPersistence', {}); f.host.provide('workspaceRegistry', f.registry);
  f.host.provide('settings', { configure(presentation, owner) { calls.push({ presentation, owner }); return () => calls.push('dispose'); } });
  const pluginScope = f.host.plugin(plugin, { root: resolve(f.root, 'managed') }); f.scopes.push(pluginScope); await pluginScope;
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].presentation, { auto: false }); assert.equal(calls[0].owner, pluginScope.ctx.fiber);
  await pluginScope.dispose(); assert.equal(calls.at(-1), 'dispose'); assert.equal(calls.length, 2);
});

test('published plugin Config and real SDK register command/tool and dispose exact lifecycle', async t => {
  const f = await hostFixture(t); const source = f.agent(f.root); const worktree = record(f.root);
  const tables = domainTables(worktree); let opened = 0; let closed = 0;
  f.host.provide('storageDomain', { async open(spec) { opened++; assert.ok(tables[spec.name]); return { table: name => tables[spec.name][name], async close() { closed++; } }; } });
  f.host.provide('sessionPersistence', {}); f.host.provide('workspaceRegistry', f.registry);
  const config = plugin.Config({ root: resolve(f.root, 'managed') });
  assert.equal(config.defaultRemote, 'origin'); assert.equal(config.gitExecutable, 'git'); assert.equal(config.maxFiles, 1000);
  const pluginScope = f.host.plugin(plugin, { root: resolve(f.root, 'managed') }); f.scopes.push(pluginScope);
  await pluginScope;
  assert.equal(opened, 2); assert.equal(f.host.commands.find(source, 'worktree').name, 'worktree');
  assert.equal(f.host.commands.find(source, 'project').name, 'project');
  assert.ok(f.host.tools.schemas(source).some(tool => tool.name === 'workspace_project'));
  const schema = f.host.tools.schemas(source).find(tool => tool.name === 'git_worktree'); assert.ok(schema); assert.equal(schema.parameters.additionalProperties, false); assert.ok(!('fullAccess' in schema.parameters.properties));
  const signal = new AbortController().signal;
  const command = await f.host.commands.execute(source, `/worktree protect ${JSON.stringify({ id: worktree.id, protected: true })}`, [], signal);
  assert.equal(command.result.kind, 'success'); const envelope = JSON.parse(command.result.text); assert.equal(envelope.v, 1); assert.equal(envelope.ok, true); assert.equal(envelope.data.worktree.protected, true);
  assert.deepEqual(f.events.filter(e => e.session === source.session).map(e => e.event.type), ['command/run', 'command/done']);
  const tool = await f.host.tools.execute({ name: 'git_worktree', callId: 'worktree-sdk-call', arguments: { action: 'protect', id: worktree.id, protected: false }, agent: source, signal });
  assert.equal(tool.isError, false); assert.equal(tool.value.v, 1); assert.equal(tool.value.data.worktree.protected, false);
  const missingActor = await f.host.tools.execute({ name: 'git_worktree', callId: 'worktree-sdk-no-caller', arguments: { action: 'protect', id: worktree.id, protected: false }, signal }); assert.equal(missingActor.isError, true); assert.match(JSON.stringify(missingActor), /NO_CALLER|receiving agent/u);
  const invalid = await f.host.commands.execute(source, '/worktree create {"fullAccess":true}', [], signal); assert.equal(invalid.result.kind, 'error'); assert.equal(JSON.parse(invalid.result.text).error.code, 'INVALID_REQUEST');
  await pluginScope.dispose(); assert.equal(f.host.commands.find(source, 'worktree'), undefined); assert.ok(!f.host.tools.schemas(source).some(tool => tool.name === 'git_worktree')); assert.equal(closed, 2); assert.equal(f.host.commands.find(source, 'project'), undefined); assert.ok(!f.host.tools.schemas(source).some(tool => tool.name === 'workspace_project'));
});

test('actual plugin exact UI routes coexist with the real SDK gateway and await admission disposal', async t => {
  const f = await hostFixture(t); const source = f.agent(f.root); const worktree = record(f.root);
  const tables = domainTables(worktree); const transport = await connectionFixture(f);
  let closed = 0;
  f.host.provide('storageDomain', { async open(spec) { return { table: name => tables[spec.name][name], async close() { closed++; } }; } });
  f.host.provide('sessionPersistence', {}); f.host.provide('workspaceRegistry', f.registry);
  const lookups = [];
  const resolver = { async resolveAgent(id) { lookups.push(id); const agent = f.agents.get(id); return agent ? { agent } : { error: { code: 'session/not-found', message: 'Missing source', details: {} } }; } };
  f.host.provide('sessionController', resolver);
  assert.deepEqual(await transport.rpc('session/foo', {}), { ok: true, value: true });
  const pluginScope = f.host.plugin(plugin, { root: resolve(f.root, 'managed') }); f.scopes.push(pluginScope); await pluginScope;
  assert.deepEqual(await transport.rpc('session/foo', {}), { ok: true, value: true });
  assert.deepEqual(await transport.rpc('dsh-worktrees/projects', { v: 1, request: { action: 'list' } }), { ok: true, value: { v: 1, ok: true, data: { projects: [], bindings: [], records: [worktree] } } });
  // Actual optional plugin registration owns both lazy setup routes as well.
  const setupOperation = randomUUID();
  const setupProgress = transport.rpc('dsh-worktrees/progress', { v: 1, actorId: source.id, operationId: setupOperation, after: 0 });
  const setup = await transport.rpc('dsh-worktrees/prepare', { v: 1, actorId: source.id, request: { action: 'create', operationId: setupOperation, repoPath: f.root, remote: 'origin', remoteIdentity: 'opaque', remoteBranch: 'main', sourceSessionId: source.id, sessionMode: 'new', requireBlankSource: true, firstPrompt: 'Prepare only; do not send a conversation.' } });
  // This real controller fixture forbids subprocesses, so preparation ends safely without a checkout.
  assert.equal(setup.ok, true); assert.equal(setup.value.ok, false);
  const observed = await setupProgress;
  assert.deepEqual(observed, { ok: true, value: { v: 1, ok: true, data: { operationId: setupOperation, revision: 1, stages: [], terminal: true } } });
  assert.deepEqual(lookups, [source.id]); assert.equal(f.events.length, 0); assert.deepEqual(source.inbox, { nextTurn: [], nextStep: [] });
  for (const endpoint of ['dsh-worktrees/execute/other', 'dsh-worktrees/projects/other', 'dsh-worktrees/prepare/other', 'dsh-worktrees/progress/other', 'unknown/endpoint']) {
    assert.equal((await transport.response(endpoint, {})).response.status, 404);
  }
  const signal = new AbortController().signal;
  const rpc = (request, options) => transport.rpc('dsh-worktrees/execute', { v: 1, actorId: source.id, request }, options);
  const command = await f.host.commands.execute(source, `/worktree protect ${JSON.stringify({ id: worktree.id, protected: true })}`, [], signal);
  assert.equal(command.result.kind, 'success'); const commandValue = JSON.parse(command.result.text);
  const before = f.events.length;
  const ui = await rpc({ action: 'protect', id: worktree.id, protected: true }); assert.deepEqual(ui, { ok: true, value: commandValue });
  const tool = await f.host.tools.execute({ name: 'git_worktree', callId: 'rpc-sdk-tool', arguments: { action: 'protect', id: worktree.id, protected: true }, agent: source, signal });
  assert.equal(tool.isError, false); assert.deepEqual(ui.value, tool.value); assert.equal(f.events.length, before);
  // Ordinary read failures/cancellation must also remain silent; this fixture forbids all subprocesses.
  for (const request of [{ action: 'list' }, { action: 'status' }, { action: 'branches', remote: 'origin' }]) {
    const result = await rpc(request); assert.equal(result.ok, true); assert.equal(result.value.ok, false); assert.equal(f.events.length, before);
  }
  const cancelled = new AbortController(); cancelled.abort();
  const cancelledResponse = await transport.response('dsh-worktrees/execute', { v: 1, actorId: source.id, request: { action: 'list' } }, { signal: cancelled.signal });
  const cancelledWire = await cancelledResponse.response.json();
  assert.equal(serverResponseSchema.safeParse(cancelledWire).success, true);
  // The aborted body was never read, so its correlation id is intentionally unknown.
  assert.equal(cancelledWire.rpcId, 'invalid-request'); const cancelledResult = cancelledWire.result;
  assert.equal(cancelledResult.ok, false); assert.equal(cancelledResult.error.code, 'CANCELLED'); assert.equal(f.events.length, before);
  const denied = await transport.response('dsh-worktrees/execute', { v: 1, actorId: source.id, request: { action: 'list' } }, { headers: { cookie: '' } });
  assert.equal(denied.response.status, 401); assert.equal(f.events.length, before);
  assert.deepEqual(f.events.filter(e => e.session === source.session).map(e => e.event.type), ['command/run', 'command/done']);
  let release; let enter; const entered = new Promise(resolve => { enter = resolve; });
  resolver.resolveAgent = async () => { enter(); await new Promise(resolve => { release = resolve; }); return { agent: source }; };
  const pending = rpc({ action: 'list' }); await entered;
  let disposed = false; const disposal = pluginScope.dispose().then(() => { disposed = true; });
  // Awaiting the real SDK handler gives disposal a scheduling point without inspecting private route maps.
  assert.deepEqual(await transport.rpc('session/foo', {}), { ok: true, value: true });
  assert.equal((await transport.response('dsh-worktrees/execute', {})).response.status, 404);
  assert.equal((await transport.response('dsh-worktrees/projects', {})).response.status, 404);
  assert.equal((await transport.response('dsh-worktrees/prepare', {})).response.status, 404);
  assert.equal((await transport.response('dsh-worktrees/progress', {})).response.status, 404);
  assert.equal(disposed, false); assert.equal(closed, 0);
  release(); const pendingResult = await pending; assert.equal(pendingResult.error.code, 'CANCELLED'); await disposal;
  assert.equal(closed, 2); assert.equal(f.events.length, before);
  assert.deepEqual(await transport.rpc('session/foo', {}), { ok: true, value: true });
  assert.ok(transport.gatewayCalls.every(call => call.peer.id === transport.connection.operator.id && call.peer.ctx === transport.connection.operator.ctx));
  assert.equal(f.host.commands.find(source, 'worktree'), undefined); assert.ok(!f.host.tools.schemas(source).some(value => value.name === 'git_worktree'));
  assert.equal(f.agents.get(source.id), source);
});

test('real system prompt reminders are scoped, stable, deduplicated and removed by plugin unload', async t => {
  const f = await hostFixture(t); const worktree = record(f.root);
  const isolated = f.agent(worktree.effectiveCwd); const local = f.agent(worktree.repoRoot);
  const pluginScope = createScope(f.host, {}); f.scopes.push(pluginScope);
  let cached = { head: worktree.baseOid, branch: null, dirty: false, changes: 0, untracked: 0 };
  const reminders = new WorktreeReminders(pluginScope.ctx, { records: () => [structuredClone(worktree)], cachedStatus: () => ({ ...cached }) });
  reminders.start(); reminders.attach(isolated); reminders.attach(isolated);
  const first = await f.host.systemPrompt.assemble({ scope: isolated }); const second = await f.host.systemPrompt.assemble({ scope: isolated });
  const context = first.contexts.filter(c => c.name === 'dsh-worktrees:context'); assert.equal(context.length, 1); assert.deepEqual(first.contexts, second.contexts);
  assert.match(context[0].text, /creation-time fetched snapshot/u); assert.match(context[0].text, /detached HEAD/u); assert.ok(context[0].text.includes(worktree.effectiveCwd));
  assert.ok(!(await f.host.systemPrompt.assemble({ scope: local })).contexts.some(c => c.name === 'dsh-worktrees:context'));
  cached = { ...cached, branch: 'work' }; assert.match((await f.host.systemPrompt.assemble({ scope: isolated })).contexts[0].text, /work/u);
  await pluginScope.dispose(); assert.ok(!(await f.host.systemPrompt.assemble({ scope: isolated })).contexts.some(c => c.name === 'dsh-worktrees:context'));
  reminders.close(); reminders.close();
});

test('real agent-scope disposal and lifecycle events detach reminder without disposing foreign agents', async t => {
  const f = await hostFixture(t); const worktree = record(f.root); const isolated = f.agent(worktree.effectiveCwd);
  const pluginScope = createScope(f.host, {}); f.scopes.push(pluginScope);
  const reminders = new WorktreeReminders(pluginScope.ctx, { records: () => [worktree], cachedStatus: () => undefined }); reminders.start();
  assert.equal((await f.host.systemPrompt.assemble({ scope: isolated })).contexts.length, 1);
  await isolated.scope.dispose(); assert.equal((await f.host.systemPrompt.assemble({ scope: isolated })).contexts.length, 0); assert.equal(f.agents.get(isolated.id), isolated);
  f.host.emit(scopeTarget(isolated, isolated), 'agent/disposed', { agent: isolated }); reminders.close();
});

test('actual Host project DTOs decode in actual Client protocol and share quiet UI/tool/command operations', async t => {
  const f = await hostFixture(t), source = f.agent(f.root), worktree = record(f.root), tables = domainTables(worktree);
  const folder2 = resolve(f.root, 'second-folder'); await mkdir(folder2);
  f.host.provide('storageDomain', { async open(spec) { return { table: name => tables[spec.name][name], async close() {} }; } });
  f.host.provide('sessionPersistence', {}); f.host.provide('workspaceRegistry', f.registry);
  const transport = await connectionFixture(f);
  let resolutions = 0;
  f.host.provide('sessionController', { async resolveAgent(id) { resolutions++; return { agent: f.agents.get(id) }; } });
  const pluginScope = f.host.plugin(plugin, { root: resolve(f.root, 'managed') }); f.scopes.push(pluginScope); await pluginScope;
  const javascript = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  const from = javascript.indexOf('    class WorktreeError extends Error'), to = javascript.indexOf('    function Icon(', from);
  // Only execute actual pure protocol declarations; no React/DOM renderer is made.
  const client = vm.runInNewContext(`(() => { const NS='worktrees.ui', PANEL='dsh-worktrees'; ${javascript.slice(from, to)}; return {decodeReply, projectData}; })()`, { AbortController });
  const signal = new AbortController().signal;
  const rpc = async (request, actorId) => {
    const reply = await transport.rpc('dsh-worktrees/projects', { v: 1, request, ...(actorId === undefined ? {} : { actorId }) }, { signal });
    return client.projectData(request, client.decodeReply(reply));
  };
  const before = f.events.length, projectId = randomUUID();
  const created = await rpc({ action: 'create', id: projectId, title: 'Two folders', folders: [f.root, folder2] });
  assert.equal(typeof created.project.createdAt, 'number'); assert.equal(created.project.folders.length, 2); assert.equal(resolutions, 0);
  assert.equal(created.project.mainFolderId, created.project.folders[0].id);
  const native = f.registry.list().find(value => value.path === f.root); await native.attachSession(source.id);
  const request = { action: 'list', projectId };
  const ui = await rpc(request); assert.equal(ui.projects.length, 1); assert.equal(ui.bindings[0].mode, 'local'); assert.equal(resolutions, 0);
  const tool = await f.host.tools.execute({ name: 'workspace_project', callId: 'project-sdk-list', arguments: request, agent: source, signal });
  assert.equal(tool.isError, false); assert.deepEqual(ui, tool.value.data);
  assert.equal(f.events.length, before, 'metadata RPC and direct shared tool pipeline do not insert chat command rows');
  const changed = await rpc({ action: 'update', projectId, title: 'Renamed project', mainFolder: folder2 }, source.id); assert.equal(changed.project.title, 'Renamed project');
  assert.equal(changed.project.mainFolderId, created.project.folders[1].id);
  const bound = await rpc({ action: 'bind', projectId, folderId: native.id, sessionId: source.id }, source.id); assert.equal(bound.binding.mode, 'local');
  assert.equal(f.events.length, before);
  const command = await f.host.commands.execute(source, `/project ${JSON.stringify(request)}`, [], signal);
  assert.equal(command.result.kind, 'success'); assert.deepEqual(client.projectData(request, JSON.parse(command.result.text).data), await rpc(request));
  assert.deepEqual(f.events.filter(value => value.session === source.session).map(value => value.event.type), ['command/run', 'command/done']);
  const assembly = await f.host.systemPrompt.assemble({ scope: source });
  const text = assembly.contexts.find(value => value.name === 'dsh-worktrees:project')?.text;
  assert.match(text, /Renamed project/u); assert.match(text, /Local folder/u); assert.match(text, /does not widen filesystem permissions/u);
  assert.ok(text.includes(`Main project folder (default for new conversations): ${JSON.stringify(basename(folder2))} (id ${JSON.stringify(changed.project.mainFolderId)})`));
  assert.ok(text.includes(`Main folder path: ${JSON.stringify(folder2)}`)); assert.ok(text.includes(`Selected project folder: ${JSON.stringify(native.title)} (id ${JSON.stringify(native.id)})`));
  assert.ok(text.includes(`Original folder (selected source path): ${JSON.stringify(f.root)}`)); assert.ok(text.includes(`Execution directory: ${JSON.stringify(f.root)}`));
  const resetMain = await rpc({ action: 'update', projectId, mainFolder: f.root }, source.id); assert.equal(resetMain.project.mainFolderId, native.id);
  const nextAssembly = await f.host.systemPrompt.assemble({ scope: source }), nextContexts = nextAssembly.contexts.filter(value => value.name === 'dsh-worktrees:project');
  assert.equal(nextContexts.length, 1); assert.ok(nextContexts[0].text.includes(`Main folder path: ${JSON.stringify(f.root)}`));
  assert.ok(nextContexts[0].text.includes(`(id ${JSON.stringify(native.id)}) [main, selected]`)); assert.equal(source.session.header.cwd, f.root);
  assert.deepEqual(f.events.filter(value => value.session === source.session).map(value => value.event.type), ['command/run', 'command/done']);
  await pluginScope.dispose(); assert.equal((await transport.response('dsh-worktrees/projects', {})).response.status, 404); assert.ok(!f.host.tools.schemas(source).some(value => value.name === 'workspace_project'));
  assert.deepEqual(await transport.rpc('session/foo', {}), { ok: true, value: true });
});

function projectContextFixture() {
  const project = { id: randomUUID(), title: 'Multi-folder project', mainFolderId: 'folder-0', createdAt: 1, updatedAt: 1, folders: Array.from({ length: 12 }, (_, index) => ({ id: 'folder-' + index, title: 'Folder ' + index, path: '/project/folder-' + index })) };
  const binding = { sessionId: randomUUID(), projectId: project.id, folderId: 'folder-1', mode: 'local', effectiveCwd: project.folders[1].path };
  return { project, binding };
}

test('project context distinguishes durable main-folder default from an alternative selection', () => {
  const { project, binding } = projectContextFixture(); project.mainFolderId = 'folder-2';
  const text = renderProjectContext(project, binding);
  assert.ok(text.includes('Main project folder (default for new conversations): "Folder 2" (id "folder-2")'));
  assert.ok(text.includes('Main folder path: "/project/folder-2"'));
  assert.ok(text.includes('Selected project folder: "Folder 1" (id "folder-1")'));
  assert.ok(text.includes('Original folder (selected source path): "/project/folder-1"'));
  assert.ok(text.includes('Execution directory: "/project/folder-1"'));
  assert.ok(text.includes('- "Folder 2" (id "folder-2") [main]: "/project/folder-2"'));
  assert.ok(text.includes('- "Folder 1" (id "folder-1") [selected]: "/project/folder-1"'));
  assert.match(text, /Users may select another folder/u);
  assert.match(text, /default does not change this conversation's selected folder or execution directory/u);
  assert.match(text, /does not widen filesystem permissions or change the session working directory/u);
  assert.match(text, /Project folders do not automatically receive worktrees/u);
  assert.ok(text.includes(`workspace_project using {"action":"list","projectId":"${project.id}"}`));
  assert.equal(project.mainFolderId, 'folder-2'); assert.equal(binding.folderId, 'folder-1');
});

test('project context uses deterministic first-folder fallback only for missing legacy main id', () => {
  const { project, binding } = projectContextFixture(); delete project.mainFolderId;
  const text = renderProjectContext(project, { ...binding, folderId: 'folder-0', effectiveCwd: project.folders[0].path });
  assert.ok(text.includes('Main project folder (default for new conversations): "Folder 0" (id "folder-0")'));
  assert.ok(text.includes('- "Folder 0" (id "folder-0") [main, selected]: "/project/folder-0"'));
  assert.equal(renderProjectContext({ ...project, mainFolderId: 'removed-folder' }, binding), '');
  assert.equal(renderProjectContext({ ...project, mainFolderId: '' }, binding), '');
  assert.equal(renderProjectContext({ ...project, folders: [] }, binding), '');
  assert.equal(renderProjectContext(project, { ...binding, folderId: 'removed-folder' }), '');
  assert.equal(renderProjectContext(project, { ...binding, projectId: randomUUID() }), '');
});

test('project context keeps main and selected folders beyond the first eight in a bounded list', () => {
  const { project, binding } = projectContextFixture(); project.mainFolderId = 'folder-10'; binding.folderId = 'folder-11'; binding.effectiveCwd = project.folders[11].path;
  const text = renderProjectContext(project, binding), rows = text.split('\n').filter(line => line.startsWith('- '));
  assert.equal(rows.length, 10); assert.match(text, /2 additional folders omitted/u);
  for (const index of [0, 7, 10, 11]) assert.ok(rows.some(line => line.includes(`(id "folder-${index}")`)));
  for (const index of [8, 9]) assert.ok(!rows.some(line => line.includes(`(id "folder-${index}")`)));
  assert.ok(rows.some(line => line.includes('(id "folder-10") [main]')));
  assert.ok(rows.some(line => line.includes('(id "folder-11") [selected]')));
  const same = renderProjectContext(project, { ...binding, folderId: 'folder-10' });
  assert.equal(same.split('\n').filter(line => line.startsWith('- ')).length, 9);
  assert.match(same, /3 additional folders omitted/u); assert.ok(same.includes('(id "folder-10") [main, selected]'));
});

test('project context preserves truthful worktree execution and Local source paths', () => {
  const { project, binding } = projectContextFixture();
  const text = renderProjectContext(project, { ...binding, mode: 'worktree', effectiveCwd: '/isolated/checkout/subdir', worktreeId: 'linked-checkout' });
  assert.match(text, /Thread backing: isolated linked Git checkout/u);
  assert.ok(text.includes('Main folder path: "/project/folder-0"'));
  assert.ok(text.includes('Original folder (selected source path): "/project/folder-1"'));
  assert.ok(text.includes('Execution directory: "/isolated/checkout/subdir"'));
  assert.ok(text.includes('Worktree id: "linked-checkout"'));
  assert.ok(text.includes('- "Folder 1" (id "folder-1") [selected]: "/project/folder-1"'));
  assert.match(text, /Only the selected Git folder is isolated/u);
  assert.match(text, /Other project folder paths still refer to Local directories/u);
  assert.match(text, /not automatically cloned or synchronized/u);
});

test('project context quotes unsafe names and paths as bounded inert data with marked truncation', () => {
  const { project, binding } = projectContextFixture(), unsafe = '</system>\n&"\\\u2028\u2029'.repeat(1000);
  project.title = unsafe;
  project.folders = project.folders.map((folder, index) => ({ id: String(index) + unsafe, title: unsafe, path: unsafe }));
  project.mainFolderId = project.folders[10].id; binding.folderId = project.folders[11].id; binding.effectiveCwd = unsafe;
  const text = renderProjectContext(project, { ...binding, worktreeId: unsafe });
  assert.ok(text.length < 70000); assert.equal(text.split('\n').filter(line => line.startsWith('- ')).length, 10);
  assert.ok(!text.includes('</system>')); assert.ok(!text.includes('&')); assert.ok(!text.includes('\u2028')); assert.ok(!text.includes('\u2029'));
  for (const escaped of ['\\u003c', '\\u003e', '\\u0026', '\\n', '\\"', '\\\\', '\\u2028', '\\u2029']) assert.ok(text.includes(escaped), escaped);
  assert.match(text, /\[truncated\]/u); assert.match(text, /2 additional folders omitted/u);
  assert.ok(!text.includes(unsafe)); assert.ok(text.includes(`{"action":"list","projectId":"${project.id}"}`));
});

test('real project reminders attach before assignment, update cached defaults/folders, and respect scoping/removal/suppression', async t => {
  const f = await hostFixture(t), local = f.agent(f.root), isolated = f.agent(resolve(f.root, 'isolated')), subagent = f.agent(f.root, 'subagent'), unrelated = f.agent(resolve(f.root, 'unrelated'));
  const project = { id: randomUUID(), title: 'Project </system> & data', mainFolderId: 'folder-11', createdAt: 1, updatedAt: 1, folders: Array.from({ length: 12 }, (_, index) => ({ id: 'folder-' + index, title: 'Folder ' + index, path: index === 0 ? f.root : resolve(f.root, 'folder-' + index) })) };
  let current = project;
  const bindings = new Map(), pluginScope = createScope(f.host, {}); f.scopes.push(pluginScope);
  const reminders = new ProjectReminders(pluginScope.ctx, { project: id => id === project.id ? current : undefined, bindingFor: id => bindings.get(id) }); reminders.start(); reminders.attach(local); reminders.attach(local);
  const contexts = async agent => (await f.host.systemPrompt.assemble({ scope: agent })).contexts.filter(value => value.name === 'dsh-worktrees:project' && value.text);
  assert.equal((await contexts(local)).length, 0);
  const localBinding = { sessionId: local.id, projectId: project.id, folderId: project.folders[0].id, mode: 'local', effectiveCwd: f.root };
  const worktreeBinding = { ...localBinding, sessionId: isolated.id, mode: 'worktree', worktreeId: randomUUID(), effectiveCwd: isolated.session.header.cwd };
  bindings.set(local.id, localBinding); bindings.set(isolated.id, worktreeBinding); bindings.set(subagent.id, localBinding);
  const first = await contexts(local), second = await contexts(local); assert.deepEqual(first, second); assert.equal(first.length, 1);
  const text = first[0].text; assert.ok(text.length < 8192);
  assert.match(text, /3 additional folders omitted/u); assert.match(text, /"action":"list"/u); assert.ok(!text.includes('</system>')); assert.ok(text.includes('\\u003c'));
  assert.ok(text.includes('Main project folder (default for new conversations): "Folder 11" (id "folder-11")'));
  const worktreeText = (await contexts(isolated))[0].text;
  assert.match(worktreeText, /Only the selected Git folder is isolated/u); assert.ok(worktreeText.includes(`Execution directory: ${JSON.stringify(isolated.session.header.cwd)}`));
  assert.ok(worktreeText.includes(`Original folder (selected source path): ${JSON.stringify(f.root)}`));
  assert.equal((await contexts(subagent)).length, 0); assert.equal((await contexts(unrelated)).length, 0);
  current = { ...project, title: 'Updated project', mainFolderId: 'folder-10', folders: project.folders.map(folder => folder.id === 'folder-10' ? { ...folder, title: 'New main', path: resolve(f.root, 'renamed-main') } : folder.id === 'folder-0' ? { ...folder, title: 'Selected renamed' } : folder) };
  const updated = await contexts(local); assert.equal(updated.length, 1); assert.match(updated[0].text, /Updated project/u);
  assert.ok(updated[0].text.includes('Main project folder (default for new conversations): "New main" (id "folder-10")'));
  assert.ok(updated[0].text.includes(`Main folder path: ${JSON.stringify(resolve(f.root, 'renamed-main'))}`));
  assert.ok(updated[0].text.includes('Selected project folder: "Selected renamed" (id "folder-0")'));
  assert.ok(updated[0].text.includes(`Execution directory: ${JSON.stringify(f.root)}`)); assert.equal(local.session.header.cwd, f.root);
  const valid = current;
  current = { ...valid, mainFolderId: 'removed-main' }; assert.equal((await contexts(local)).length, 0);
  current = { ...valid, folders: valid.folders.filter(folder => folder.id !== localBinding.folderId) }; assert.equal((await contexts(local)).length, 0);
  current = undefined; assert.equal((await contexts(local)).length, 0);
  current = valid; bindings.delete(local.id); assert.equal((await contexts(local)).length, 0);
  bindings.set(local.id, localBinding); reminders.attach(local); assert.equal((await contexts(local)).length, 1);
  const suppress = local.ctx.get('systemPrompt').suppressRuntimeContext(), suppressAgain = local.ctx.get('systemPrompt').suppressRuntimeContext();
  assert.equal((await contexts(local)).length, 0); assert.equal((await contexts(isolated)).length, 1);
  suppress(); assert.equal((await contexts(local)).length, 0); suppressAgain(); assert.equal((await contexts(local)).length, 1);
  assert.equal(f.events.length, 0, 'native dynamic context never injects user messages or session events');
  await pluginScope.dispose(); assert.equal((await contexts(local)).length, 0); assert.equal((await contexts(isolated)).length, 0); assert.equal(f.agents.get(local.id), local); reminders.close(); reminders.close();
});

test('real project reminder lifecycle attaches during serial creation and unwinds exact agent ownership', async t => {
  const f = await hostFixture(t);
  const { project } = projectContextFixture(); project.folders[0].path = f.root;
  const bindings = new Map(); let reminders;
  const pluginScope = f.host.plugin({ name: 'project-reminder-lifecycle', apply(ctx) { reminders = new ProjectReminders(ctx, { project: id => id === project.id ? project : undefined, bindingFor: id => bindings.get(id) }); reminders.start(); } }); f.scopes.push(pluginScope); await pluginScope;
  const agent = f.agent(f.root), other = f.agent(f.root);
  for (const value of [agent, other]) bindings.set(value.id, { sessionId: value.id, projectId: project.id, folderId: project.folders[0].id, mode: 'local', effectiveCwd: f.root });
  const contexts = async value => (await f.host.systemPrompt.assemble({ scope: value })).contexts.filter(context => context.name === 'dsh-worktrees:project');
  let sawInitialized = false;
  pluginScope.ctx.on('agent/created', async ({ agent: created }) => { assert.equal((await contexts(created)).length, 1); sawInitialized = true; return undefined; });
  await f.host.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' }); assert.equal(sawInitialized, true);
  await f.host.serial(scopeTarget(other, other), 'agent/created', { agent: other, source: 'startup' });
  reminders.attach(agent); assert.equal((await contexts(agent)).length, 1);
  f.host.emit(scopeTarget(agent, agent), 'agent/disposed', { agent }); assert.equal((await contexts(agent)).length, 0); assert.equal((await contexts(other)).length, 1); assert.equal(f.agents.get(agent.id), agent);
  await other.scope.dispose(); assert.equal((await contexts(other)).length, 0); assert.equal(f.agents.get(other.id), other);
  f.host.emit(scopeTarget(other, other), 'agent/disposed', { agent: other }); reminders.close(); reminders.close();
  assert.equal(f.events.length, 0);
});


test('project remove shares exact quiet RPC/tool/command execution and retains live sessions, managed rows and start receipts', async t => {
  const f = await hostFixture(t), source = f.agent(f.root), worktree = record(f.root), tables = domainTables(worktree);
  const transport = await connectionFixture(f); const signal = new AbortController().signal;
  f.host.provide('storageDomain', { async open(spec) { return { table: name => tables[spec.name][name], async close() {} }; } });
  f.host.provide('sessionPersistence', {}); f.host.provide('workspaceRegistry', f.registry);
  f.host.provide('sessionController', { async resolveAgent(id) { const agent = f.agents.get(id); return agent ? { agent } : { error: { code: 'session/not-found', message: 'Missing ordinary session', details: {} } }; } });
  const scope = f.host.plugin(plugin, { root: resolve(f.root, 'managed') }); f.scopes.push(scope); await scope;
  const rpc = request => transport.rpc('dsh-worktrees/projects', { v: 1, request });
  const id = randomUUID(); const create = await rpc({ action: 'create', id, title: 'Metadata to remove', folders: [f.root] }); assert.equal(create.value.ok, true);
  const native = f.registry.list()[0]; await native.attachSession(source.id); native.pins = [source.id]; native.archived = [source.id];
  source.status = 'running'; source.inbox.nextTurn.push({ retained: 'pending conversation' });
  worktree.projectId = id; worktree.folderId = native.id;
  const isolated = f.agent(worktree.effectiveCwd); isolated.status = 'running'; worktree.sessionIds.push(isolated.id);
  const startId = randomUUID(); const start = { id: startId, projectId: id, folderId: native.id, actorId: source.id, effectiveCwd: f.root, requestedSessionId: startId, phase: 'recovery-required', sessionId: source.id, workspaceId: native.id, createdAt: 1, updatedAt: 2 };
  await tables.dsh_worktree_projects.starts.put(startId, start); await rpc({ action: 'list' });
  const headers = [structuredClone(source.session.header), structuredClone(isolated.session.header)], inbox = structuredClone(source.inbox), retained = structuredClone(worktree);
  const before = f.events.length, request = { action: 'remove', projectId: id }, data = { removed: true, projectId: id, scope: 'project-metadata' };
  const removed = await f.host.tools.execute({ name: 'workspace_project', callId: 'project-sdk-remove', arguments: request, agent: source, signal });
  assert.equal(removed.isError, false); assert.deepEqual(removed.value, { v: 1, ok: true, data });
  const ui = await rpc(request); assert.deepEqual(ui, { ok: true, value: removed.value }); assert.equal(f.events.length, before);
  const command = await f.host.commands.execute(source, `/project ${JSON.stringify(request)}`, [], signal);
  assert.equal(command.result.kind, 'success'); assert.deepEqual(JSON.parse(command.result.text), removed.value);
  assert.deepEqual(f.events.slice(before).map(value => value.event.type), ['command/run', 'command/done']);
  assert.deepEqual((await rpc({ action: 'list', projectId: id })).value.data, { projects: [], bindings: [], records: [] });
  assert.deepEqual(source.session.header, headers[0]); assert.deepEqual(isolated.session.header, headers[1]); assert.deepEqual(source.inbox, inbox);
  assert.equal(source.status, 'running'); assert.equal(isolated.status, 'running'); assert.equal(f.agents.get(source.id), source); assert.equal(f.agents.get(isolated.id), isolated);
  assert.deepEqual(tables.dsh_worktrees.worktrees.get(worktree.id), retained); assert.deepEqual(tables.dsh_worktree_projects.starts.get(startId), start);
  assert.deepEqual(native.pins, [source.id]); assert.deepEqual(native.archived, [source.id]); assert.deepEqual(native.sessionIds, [source.id]); assert.equal(native.path, f.root);
  assert.ok(!(await f.host.systemPrompt.assemble({ scope: source })).contexts.some(value => value.name === 'dsh-worktrees:project' && value.text));
  const schema = f.host.tools.schemas(source).find(tool => tool.name === 'workspace_project');
  assert.equal(schema.parameters.oneOf.length, 6); assert.equal(f.host.tools.executionMode({ name: 'workspace_project', arguments: request, agent: source }).kind, 'exclusive');
  const unknown = await rpc({ action: 'remove', projectId: randomUUID() }); assert.equal(unknown.value.error.code, 'PROJECT_NOT_FOUND');
  const invalid = await rpc({ ...request, deleteFolders: true }); assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'INVALID_RPC_REQUEST');
  const noCaller = await f.host.tools.execute({ name: 'workspace_project', callId: 'project-sdk-remove-no-caller', arguments: request, signal }); assert.equal(noCaller.isError, true);
  const impostor = await f.host.tools.execute({ name: 'workspace_project', callId: 'project-sdk-remove-impostor', arguments: request, agent: { ...source }, signal }); assert.equal(impostor.isError, true); assert.match(JSON.stringify(impostor), /SESSION_CHANGED|exact ordinary live session/u);
  const aborted = new AbortController(); aborted.abort(); const cancel = await f.host.tools.execute({ name: 'workspace_project', callId: 'project-sdk-remove-cancelled', arguments: request, agent: source, signal: aborted.signal }); assert.equal(cancel.isError, true);
  // Retained managed rows are still independently operable without project metadata.
  const protect = await f.host.tools.execute({ name: 'git_worktree', callId: 'project-sdk-retained-protect', arguments: { action: 'protect', id: worktree.id, protected: true }, agent: source, signal });
  assert.equal(protect.isError, false); assert.equal(protect.value.data.worktree.protected, true); assert.equal(tables.dsh_worktree_projects.projects.map.size, 0);
  assert.deepEqual(f.events.slice(before).map(value => value.event.type), ['command/run', 'command/done']);
});
