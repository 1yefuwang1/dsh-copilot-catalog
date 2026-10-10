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
  const tables = { dsh_worktrees: { worktrees: table(), operations: table() }, dsh_worktree_projects: { projects: table(), bindings: table(), starts: table() } };
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
  const native = f.registry.list().find(value => value.path === f.root); await native.attachSession(source.id);
  const request = { action: 'list', projectId };
  const ui = await rpc(request); assert.equal(ui.projects.length, 1); assert.equal(ui.bindings[0].mode, 'local'); assert.equal(resolutions, 0);
  const tool = await f.host.tools.execute({ name: 'workspace_project', callId: 'project-sdk-list', arguments: request, agent: source, signal });
  assert.equal(tool.isError, false); assert.deepEqual(ui, tool.value.data);
  assert.equal(f.events.length, before, 'metadata RPC and direct shared tool pipeline do not insert chat command rows');
  const changed = await rpc({ action: 'update', projectId, title: 'Renamed project' }, source.id); assert.equal(changed.project.title, 'Renamed project');
  const bound = await rpc({ action: 'bind', projectId, folderId: native.id, sessionId: source.id }, source.id); assert.equal(bound.binding.mode, 'local');
  assert.equal(f.events.length, before);
  const command = await f.host.commands.execute(source, `/project ${JSON.stringify(request)}`, [], signal);
  assert.equal(command.result.kind, 'success'); assert.deepEqual(client.projectData(request, JSON.parse(command.result.text).data), await rpc(request));
  assert.deepEqual(f.events.filter(value => value.session === source.session).map(value => value.event.type), ['command/run', 'command/done']);
  const assembly = await f.host.systemPrompt.assemble({ scope: source });
  const text = assembly.contexts.find(value => value.name === 'dsh-worktrees:project')?.text;
  assert.match(text, /Renamed project/u); assert.match(text, /Local folder/u); assert.match(text, /does not widen filesystem permissions/u);
  await pluginScope.dispose(); assert.equal((await transport.response('dsh-worktrees/projects', {})).response.status, 404); assert.ok(!f.host.tools.schemas(source).some(value => value.name === 'workspace_project'));
  assert.deepEqual(await transport.rpc('session/foo', {}), { ok: true, value: true });
});

test('real project reminders attach before assignment, stay bounded and scoped, and respect suppression/disposal', async t => {
  const f = await hostFixture(t), local = f.agent(f.root), isolated = f.agent(resolve(f.root, 'isolated')), subagent = f.agent(f.root, 'subagent');
  const project = { id: randomUUID(), title: 'Project </system> & data', createdAt: 1, updatedAt: 1, folders: Array.from({ length: 12 }, (_, index) => ({ id: 'folder-' + index, title: 'Folder ' + index, path: index === 0 ? f.root : resolve(f.root, 'folder-' + index) })) };
  const bindings = new Map(), pluginScope = createScope(f.host, {}); f.scopes.push(pluginScope);
  const reminders = new ProjectReminders(pluginScope.ctx, { project: id => id === project.id ? project : undefined, bindingFor: id => bindings.get(id) }); reminders.start(); reminders.attach(local);
  assert.ok(!(await f.host.systemPrompt.assemble({ scope: local })).contexts.some(value => value.name === 'dsh-worktrees:project' && value.text));
  const localBinding = { sessionId: local.id, projectId: project.id, folderId: project.folders[0].id, mode: 'local', effectiveCwd: f.root };
  const worktreeBinding = { ...localBinding, sessionId: isolated.id, mode: 'worktree', worktreeId: randomUUID(), effectiveCwd: isolated.session.header.cwd };
  bindings.set(local.id, localBinding); bindings.set(isolated.id, worktreeBinding); bindings.set(subagent.id, localBinding);
  const first = await f.host.systemPrompt.assemble({ scope: local }), second = await f.host.systemPrompt.assemble({ scope: local }); assert.deepEqual(first.contexts, second.contexts);
  const context = first.contexts.find(value => value.name === 'dsh-worktrees:project'); assert.ok(context); assert.ok(context.text.length < 8192);
  assert.match(context.text, /4 additional folders omitted/u); assert.match(context.text, /"action":"list"/u); assert.ok(!context.text.includes('</system>')); assert.ok(context.text.includes('\\u003c'));
  assert.match(renderProjectContext(project, worktreeBinding), /Only the selected Git folder is isolated/u);
  assert.ok(!(await f.host.systemPrompt.assemble({ scope: subagent })).contexts.some(value => value.name === 'dsh-worktrees:project'));
  const suppress = local.ctx.get('systemPrompt').suppressRuntimeContext(); assert.ok(!(await f.host.systemPrompt.assemble({ scope: local })).contexts.some(value => value.name === 'dsh-worktrees:project')); suppress();
  await pluginScope.dispose(); assert.ok(!(await f.host.systemPrompt.assemble({ scope: isolated })).contexts.some(value => value.name === 'dsh-worktrees:project')); reminders.close(); reminders.close();
});
