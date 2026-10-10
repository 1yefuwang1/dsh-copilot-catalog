import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionBootstrap } from '../dist/sessions.js';
import { WorktreeError } from '../dist/errors.js';

async function fixture(t, behavior = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'worktrees-session-owned-')); assert.equal(dirname(root), await realpath(tmpdir()));
  const sourcePath = resolve(root, 'source'); const cwd = resolve(root, 'checkout', 'project');
  await mkdir(sourcePath, { recursive: true }); await mkdir(cwd, { recursive: true });
  const owner = new Context(); new SessionStore(owner);
  const live = new Map(); const logs = new Map(); const scopes = []; const created = []; const lifecycle = []; const flushes = [];
  owner.on('session/event', (session, event) => { const events = logs.get(session.id) ?? []; events.push(event); logs.set(session.id, events); });
  let projected = { modelSelection: { next: { provider: 'github-copilot', model: 'gpt-6.1-sol', reasoningEffort: 'high' } } };
  let observedDisposed = 0; let globalDefaultReads = 0;
  owner.provide('sessionQuery', { async observeSession(id) { const value = live.get(id); return { header: value.session.header, events: [...(logs.get(id) ?? [])], projections: { values: projected }, [Symbol.dispose]() { observedDisposed++; } }; } });
  owner.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.id === source.id ? 'workspace-write' : 'danger-full-access', workspaceRoot: session.header.cwd }) });
  owner.provide('approval', { config: { policy: 'ask' }, overrideOf: () => 'never' });
  owner.provide('planMode', { get: () => ({ active: false, pending: true }) });
  owner.provide('llm', { get defaultModel() { globalDefaultReads++; throw Error('global default must not be read'); } });
  owner.provide('agentPresets', { async resolve(id) { lifecycle.push(['resolve-preset', id]); return { id: id ?? 'default-preset' }; }, async mount(ctx, id) { lifecycle.push(['mount-preset', ctx, id]); } });
  owner.provide('workspaceRegistry', { async create(path, title) { const id = randomUUID(); lifecycle.push(['workspace', path, title]); return { id, path, async attachSession(sessionId) { lifecycle.push(['attach', sessionId]); } }; } });
  function makeAgent(id, path, options = {}, seed, inheritedEventCount, meta = {}) {
    const value = { id, options, status: 'idle', inbox: { nextStep: [], nextTurn: [], clear() { lifecycle.push(['clear', id]); this.nextStep.length = 0; this.nextTurn.length = 0; } }, cancel(cause) { lifecycle.push(['cancel', id, cause.kind]); }, async whenIdle() { lifecycle.push(['idle', id]); } };
    const scope = createScope(owner, value); scopes.push(scope); value.ctx = scope.ctx;
    const session = scope.ctx.sessions.create(SessionId(id), { meta: { ...meta, cwd: path }, ...(seed === undefined ? {} : { seed }), ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }) });
    value.session = session; logs.set(id, [...(seed ?? [])]); live.set(id, value);
    // Listener owned by this exact Agent scope; raw dispatch with the Session as key misses it.
    if (behavior.durability !== false) scope.ctx.on('session/flush', flushed => { flushes.push(flushed.id); lifecycle.push(['flush', flushed.id]); });
    return value;
  }
  const source = makeAgent(randomUUID(), sourcePath, { provider: 'github-copilot', model: 'old-model' }, undefined, undefined, { agentPreset: 'source-preset' });
  owner.provide('agents', { get: id => live.get(id), list: () => [...live.values()], async create(options) {
    created.push(options);
    const child = makeAgent(options.sessionId, options.meta.cwd, options.agentOptions, options.seed, options.inheritedEventCount, options.meta);
    child.inbox.nextTurn.push('preset-seeded-input');
    await options.setup(child.ctx, child);
    lifecycle.push(['published', child.id]);
    return { agent: child, async dispose() { lifecycle.push(['dispose', child.id]); live.delete(child.id); } };
  } });
  const bootstrap = new SessionBootstrap(owner);
  t.after(async () => { await bootstrap.close(); for (const scope of scopes) await scope.dispose(); assert.equal(dirname(root), await realpath(tmpdir())); await rm(root, { recursive: true, force: true }); });
  return { owner, bootstrap, source, cwd, created, logs, lifecycle, flushes, live, set projected(value) { projected = value; }, get globalDefaultReads() { return globalDefaultReads; }, get observedDisposed() { return observedDisposed; } };
}
function code(value) { return error => error instanceof WorktreeError && error.code === value; }

test('settings captures projected next model, source preset and caller policy without global defaults', async t => {
  const f = await fixture(t); const settings = await f.bootstrap.settings(f.source);
  assert.deepEqual(settings.model, { provider: 'github-copilot', model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  assert.equal(settings.preset, 'source-preset'); assert.equal(settings.sandbox, 'workspace-write'); assert.equal(settings.approval, 'never'); assert.equal(settings.plan, true);
  assert.equal(f.globalDefaultReads, 0); assert.equal(f.observedDisposed, 1);
});

test('fresh bootstrap logs exact initial settings, clears only child inbox and flushes exact Agent scope', async t => {
  const f = await fixture(t); const sourceEvents = [...f.logs.get(f.source.id)]; f.source.inbox.nextTurn.push('source-pending');
  const settings = await f.bootstrap.settings(f.source);
  const result = await f.bootstrap.create({ cwd: f.cwd, title: 'isolated conversation', source: f.source, settings, mode: 'new', onCreated: async identity => { f.lifecycle.push(['receipt', identity.sessionId]); } });
  assert.equal(result.agent.session.header.cwd, f.cwd); assert.equal(result.agent.session.header.agentPreset, 'source-preset'); assert.equal(result.agent.session.header.origin, undefined);
  assert.deepEqual(f.created[0].agentOptions, settings.model); assert.equal(f.created[0].seed, undefined); assert.equal(f.created[0].parentAgent, undefined);
  assert.deepEqual(result.agent.inbox.nextTurn, []); assert.deepEqual(f.source.inbox.nextTurn, ['source-pending']); assert.deepEqual(f.logs.get(f.source.id), sourceEvents);
  const events = f.logs.get(result.sessionId); assert.deepEqual(events.map(e => e.type), ['sandbox/mode', 'approval/policy', 'plan/mode', 'model/selection']);
  assert.deepEqual(events.at(-1).data, settings.model); assert.equal(events.find(e => e.type === 'sandbox/mode').data.mode, settings.sandbox);
  assert.ok(!events.some(e => e.type === 'turn/start' || e.type === 'user/message'));
  assert.deepEqual(f.flushes, [result.sessionId]);
  const order = f.lifecycle.filter(([kind]) => ['published', 'receipt', 'attach', 'flush'].includes(kind)).map(([kind]) => kind);
  assert.deepEqual(order, ['published', 'receipt', 'attach', 'flush']); assert.equal(f.globalDefaultReads, 0);
});

test('continuation forks only last completed turn, rewrites cwd and preserves source log', async t => {
  const f = await fixture(t);
  f.source.session.append('turn/start', { turn: 1 }); f.source.session.append('turn/end', { turn: 1, reason: 'completed' });
  f.source.session.append('turn/start', { turn: 2 });
  const before = [...f.logs.get(f.source.id)];
  const result = await f.bootstrap.create({ cwd: f.cwd, title: 'continuation', source: f.source, settings: await f.bootstrap.settings(f.source), mode: 'continue' });
  const options = f.created[0]; assert.equal(options.inheritedEventCount, 2); assert.equal(options.meta.parentSession, f.source.id); assert.equal(options.meta.isSeeded, true);
  assert.deepEqual(options.seed.slice(0, 2), before.slice(0, 2)); assert.ok(!options.seed.some(e => e.type === 'turn/start' && e.data.turn === 2));
  assert.equal(result.agent.session.header.cwd, f.cwd); assert.equal(result.agent.session.header.parentSession, f.source.id); assert.deepEqual(f.logs.get(f.source.id), before);
});

test('blank and ordinary checks reject started, pending, replaced or subagent sources', async t => {
  const f = await fixture(t); await f.bootstrap.assertBlank(f.source);
  f.source.inbox.nextStep.push('pending'); await assert.rejects(f.bootstrap.assertBlank(f.source), code('SOURCE_BUSY')); f.source.inbox.nextStep.length = 0;
  f.source.session.append('turn/start', { turn: 1 }); await assert.rejects(f.bootstrap.assertBlank(f.source), code('SOURCE_STARTED'));
  f.live.set(f.source.id, { ...f.source }); await assert.rejects(f.bootstrap.settings(f.source), code('SESSION_CHANGED'));
  f.live.set('subagent', { session: { header: { origin: 'subagent' } } }); assert.throws(() => f.bootstrap.actor('subagent'), code('SUBAGENT_SOURCE'));
  assert.throws(() => f.bootstrap.actor('missing'), code('SESSION_NOT_LIVE'));
});

test('missing durability barrier fails only after durable identity receipt, retaining owned handle for cleanup', async t => {
  const f = await fixture(t, { durability: false }); const settings = await f.bootstrap.settings(f.source); let identity;
  await assert.rejects(f.bootstrap.create({ cwd: f.cwd, title: 'unflushed', source: f.source, settings, mode: 'new', onCreated: async result => { identity = result; } }), code('MISSING_DURABILITY_BARRIER'));
  assert.ok(identity.sessionId); assert.equal(f.live.get(identity.sessionId), identity.agent);
  await f.bootstrap.close(); assert.equal(f.live.has(identity.sessionId), false); assert.equal(f.live.get(f.source.id), f.source);
});

test('continue without completed turn rejects; owned teardown never disposes source', async t => {
  const f = await fixture(t); const settings = await f.bootstrap.settings(f.source);
  await assert.rejects(f.bootstrap.create({ cwd: f.cwd, title: 'no inherited turn', source: f.source, settings, mode: 'continue' }), code('NO_COMPLETED_TURN'));
  const result = await f.bootstrap.create({ cwd: f.cwd, title: 'fresh', source: f.source, settings, mode: 'new' });
  await f.bootstrap.close(); assert.equal(f.live.get(f.source.id), f.source); assert.equal(f.live.has(result.sessionId), false);
  assert.ok(!f.lifecycle.some(([kind, id]) => ['cancel', 'dispose'].includes(kind) && id === f.source.id));
});
