import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, basename, relative } from 'node:path';
import test from 'node:test';
import { WorktreeController } from '../dist/service.js';
import { FirstMessageNamer } from '../dist/first-message.js';
import { WorktreeError } from '../dist/errors.js';
import { hashValue } from '../dist/schema.js';
import { worktreeDomain } from '../dist/store.js';

const state = { head: 'a'.repeat(40), branch: null, dirty: false, changes: 0, untracked: 0 };
function table(events, name) {
  const map = new Map(), observers = new Set();
  return {
    map, get: key => map.get(key), entries: () => map.entries(),
    observe(callback) { observers.add(callback); return () => observers.delete(callback); },
    async put(key, value) { const saved = structuredClone(value); Object.freeze(saved.sessionIds ?? []); Object.freeze(saved); map.set(key, saved); events.push({ name, value: saved }); for (const callback of observers) callback(key, saved); },
    async delete(key) { return map.delete(key); },
  };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'worktree-controller-owned-'));
  // Tests remove only the exact unique directory they created, never caller project data.
  assert.equal(dirname(directory), await realpath(tmpdir()));
  const root = resolve(directory, 'managed'); const repo = resolve(directory, 'repo');
  await mkdir(resolve(repo, 'project'), { recursive: true });
  const events = []; const agents = new Map(); const settings = new Map(); const calls = [];
  const config = { root, gitExecutable: 'git', defaultRemote: 'origin', defaultBranch: 'main', commandTimeoutMs: 1000, fetchTimeoutMs: 1000, operationTimeoutMs: 60000, maxSnapshotBytes: 1024 * 1024, maxFiles: 1000, maxRefBytes: 1024 * 1024, ...options.config };
  const policy = new Map(); const plans = new Map();
  const listeners = new Map(), workspaceTitles = new Map();
  const effect = callback => { const dispose = callback(); let active = true; return () => { if (active) { active = false; return dispose?.(); } }; };
  const ctx = {
    on(name, callback) { const rows = listeners.get(name) ?? new Set(); listeners.set(name, rows); rows.add(callback); return () => rows.delete(callback); }, effect,
    get(name) {
      if (name === 'agents') return { list: () => [...agents.values()] };
      if (name === 'sessions') return { async flush(session) { calls.push(['flush', session]); return options.flush ? options.flush(session) : true; } };
      if (name === 'workspaceRegistry') return { get(id) { const record = [...store.worktrees.map.values()].find(row => row.workspaceId === id); return record && { path: record.effectiveCwd, get title() { return options.workspaceTitle ?? workspaceTitles.get(id) ?? `${basename(record.repoRoot)} · ${record.remoteBranch}`; }, async setTitle(title) { workspaceTitles.set(id, title); calls.push(['workspace-title', id, title]); } }; } };
      return options.capabilities?.[name];
    },
  };
  function agent(id = randomUUID(), cwd = resolve(repo, 'project')) {
    const log = [], effects = [];
    const value = {
      id, status: 'idle', inbox: { nextStep: [], nextTurn: [] }, session: { header: { cwd },
        ownEvents: () => log.filter(event => event.seq >= (value.inheritedEventCount ?? 0)), eventAt: seq => log[seq], isOwnSeq: seq => seq >= (value.inheritedEventCount ?? 0),
        append(type, data, intent = {}) { const event = { type, data, seq: log.length, time: Date.now(), ...intent }; log.push(event); for (const callback of listeners.get('session/event') ?? []) callback(value.session, event); return event; },
      },
      async whenIdle() { calls.push(['idle', id]); if (value.idleGate) await value.idleGate; },
      disposeEffects() { for (const dispose of effects.splice(0)) dispose(); },
      ctx: { effect(callback) { const dispose = effect(callback); effects.push(dispose); return dispose; }, get(name) { if (name === 'sandboxPolicy') return { resolve: () => ({ mode: policy.get(id) ?? 'danger-full-access', workspaceRoot: cwd }) }; if (name === 'planMode') return { get: () => plans.get(id) ?? { active: false, pending: false } }; return options.agentCapabilities?.[name]; } },
      runMaintenance(task) { if (this.claimed || this.status !== 'idle') throw Error('not idle'); this.claimed = true; calls.push(['claim', id]); return Promise.resolve(task(new AbortController().signal)).finally(() => { this.claimed = false; calls.push(['release', id]); }); },
    };
    agents.set(id, value);
    settings.set(id, { model: { provider: 'github-copilot', model: 'gpt-6.1-sol' }, preset: null, sandbox: 'danger-full-access', approval: 'never', plan: false, hash: 'settings-1' });
    return value;
  }
  const actor = agent();
  const bootstrap = {
    actor(id) { const found = agents.get(id); if (!found) throw new WorktreeError('SESSION_NOT_LIVE', 'missing source'); if (found.session.header.origin === 'subagent') throw new WorktreeError('SUBAGENT_SOURCE', 'ordinary only'); return found; },
    isLive(value) { return agents.get(value.id) === value; },
    async settings(value) { calls.push(['settings', value.id]); return structuredClone(settings.get(value.id)); },
    async assertBlank(value) { if (value.started || value.status !== 'idle') throw new WorktreeError('SOURCE_STARTED', 'not blank'); },
    async create(input) {
      calls.push(['session', input]);
      if (options.beforeSession) await options.beforeSession(input);
      const child = agent(randomUUID(), input.cwd); const result = { agent: child, sessionId: child.id, workspaceId: randomUUID() };
      if (input.onCreated) await input.onCreated(result);
      if (options.afterSession) await options.afterSession(input, result);
      return result;
    },
    async close() { calls.push(['close']); },
  };
  const repository = { root: repo, commonDir: resolve(repo, '.git'), projectSubdir: 'project', head: state.head, branch: 'main' };
  let remoteIdentity = 'opaque-remote'; let fetchCount = 0; let applyCount = 0;
  const git = {
    async discover(path) { calls.push(['discover', path]); const record = [...store.worktrees.map.values()].find(r => path === r.checkoutRoot || path.startsWith(`${r.checkoutRoot}/`)); return record ? { ...repository, root: record.checkoutRoot, projectSubdir: path === record.checkoutRoot ? '' : 'project' } : { ...repository, projectSubdir: path === repo ? '' : 'project' }; },
    async remotes() { return [{ name: 'origin', identity: remoteIdentity }]; },
    async branches() { calls.push(['branches']); if (options.branchesFailure) throw new WorktreeError('GIT_FAILED', 'advertisement unavailable'); return { remote: 'origin', remoteIdentity, defaultBranch: 'main', branches: Array.from({ length: 123 }, (_, index) => ({ name: `branch-${String(index).padStart(3, '0')}`, oid: state.head })).reverse(), observedAt: 42 }; },
    async create(input) {
      calls.push(['create', input]); fetchCount++;
      assert.equal(store.operations.get(input.id), undefined);
      assert.equal(store.worktrees.get(input.id).state, 'creating');
      assert.equal(store.operations.get(store.worktrees.get(input.id).operationId).phase, 'fetching');
      input.onProgress?.('fetching');
      if (options.create) return options.create(input);
      input.onProgress?.('creating');
      await mkdir(resolve(input.destination, 'project'), { recursive: true });
      return { checkoutRoot: input.destination, effectiveCwd: resolve(input.destination, input.repository.projectSubdir), baseOid: state.head, baseRef: input.baseRef, fetchedAt: 12 };
    },
    async verify(record) { calls.push(['verify', record.id]); if (options.verifyFailure) throw new WorktreeError('MISSING_CHECKOUT', 'missing'); return { ...state, branch: options.actualBranch ?? record.branch }; },
    async status() { return { ...state }; },
    async createBranch(record, name) { calls.push(['branch', record.id, name]); if (options.createBranch) return options.createBranch(record, name); return { ...state, branch: name }; },
    async renameBranch(record, expected, name) { calls.push(['rename', record.id, expected, name]); assert.equal(record.branch, expected); if (options.renameBranch) return options.renameBranch(record, expected, name); return { ...state, branch: name }; },
    async fingerprint() { return 'fingerprint'; },
    async snapshot(input) {
      assert.equal(await realpath(input.snapshotRoot), input.snapshotRoot, 'controller creates canonical private snapshot root before Git.snapshot');
      calls.push(['snapshot', input]); const id = randomUUID(); const snapshotRoot = resolve(input.snapshotRoot, id); const patchPath = resolve(snapshotRoot, 'change.patch'); const patch = 'diff --git a/file b/file\n';
      await mkdir(snapshotRoot, { recursive: true }); await writeFile(patchPath, patch);
      return { id, worktreeId: input.worktreeId, sourceSessionId: input.sourceSessionId, sourceHead: state.head, sourceFingerprint: 'fingerprint', sourceRoot: input.checkoutRoot, sourceCommonDir: repository.commonDir, targetCommonDir: repository.commonDir, finalTree: 'b'.repeat(40), snapshotRoot, targetRoot: input.targetRoot, targetHead: state.head, baseOid: input.baseOid, patchPath, patchHash: createHash('sha256').update(patch).digest('hex'), bytes: Buffer.byteLength(patch), files: [{ path: 'file', status: 'M', binary: false }], createdAt: 42 };
    },
    async apply(preview, record) { calls.push(['apply', preview.id, record.id]); applyCount++; if (options.apply) return options.apply(preview, record); return { head: state.head, files: preview.files }; },
  };
  const store = { worktrees: table(events, 'record'), operations: table(events, 'operation'), async close() {} };
  const dependencies = { bootstrap, git: (_actor, _signal, guard) => {
    // Mock production command authorization, without spawning processes or touching a user repo.
    return Object.fromEntries(Object.entries(git).map(([name, method]) => [name, async (...args) => { guard(); return method(...args); }]));
  }, localPath: async (value, path) => realpath(path === undefined ? value.session.header.cwd : resolve(value.session.header.cwd, path)), ...(options.projects === undefined ? {} : { projects: options.projects }) };
  let namer;
  if (options.observe) dependencies.onNamingEligible = agent => namer.attach(agent);
  if (options.worktreeRoot) dependencies.worktreeRoot = options.worktreeRoot;
  const controller = new WorktreeController(ctx, config, store, dependencies);
  if (options.observe) { namer = new FirstMessageNamer(ctx, controller); namer.start(); t.after(() => namer.close()); }
  const invocation = { agent: actor, origin: 'command', signal: new AbortController().signal };
  const request = () => ({ action: 'create', operationId: randomUUID(), remote: 'origin', remoteIdentity, remoteBranch: 'main', requireBlankSource: true, settingsHash: settings.get(actor.id).hash });
  t.after(async () => { await controller.close(); assert.equal(dirname(directory), await realpath(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return { directory, repo, root, config, ctx, controller, namer, listeners, invocation, actor, agent, agents, policy, plans, store, git, dependencies, calls, events, settings, request, get fetchCount() { return fetchCount; }, get applyCount() { return applyCount; }, set remoteIdentity(value) { remoteIdentity = value; } };
}
function errorCode(code) { return error => error instanceof WorktreeError && error.code === code; }

test('create journals before Git, uses project cwd, exact ready replay never refetches', async t => {
  const f = await fixture(t); const request = f.request(); const result = await f.controller.execute(request, f.invocation);
  assert.equal(result.settingsHash, 'settings-1'); assert.equal(result.worktree.baseOid, state.head);
  assert.equal(result.worktree.baseRef, `refs/dsh-worktrees/${result.worktree.id}/base`);
  assert.equal(result.operation.phase, 'ready'); assert.equal(result.sessionId, result.operation.sessionId);
  assert.equal(f.calls.find(([kind]) => kind === 'session')[1].cwd, result.worktree.effectiveCwd);
  assert.equal(basename(result.worktree.effectiveCwd), 'project'); assert.equal(result.worktree.state, 'ready');
  assert.deepEqual(f.events.filter(e => e.name === 'operation').map(e => e.value.phase), ['planned', 'fetching', 'checkout-created', 'session-created', 'ready']);
  f.settings.set(f.actor.id, { ...f.settings.get(f.actor.id), hash: 'settings-2' });
  const replay = await f.controller.execute(request, f.invocation);
  assert.deepEqual(replay, result); assert.equal(f.fetchCount, 1);
  await assert.rejects(f.controller.execute({ ...request, remoteBranch: 'different' }, f.invocation), errorCode('OPERATION_REUSED'));
  const status = await f.controller.execute({ action: 'status', operationId: request.operationId }, f.invocation);
  assert.equal(status.settingsHash, 'settings-2'); assert.equal(status.sessionId, result.sessionId);
});

test('live root changes affect only new creates and ready replay keeps identity without effects', async t => {
  let root, reads = 0;
  const llm = namingLlm();
  const f = await fixture(t, { worktreeRoot: () => { reads++; return root; }, agentCapabilities: { llm } });
  root = f.root;
  const request = { ...f.request(), firstPrompt: 'Use the original root' };
  const first = await f.controller.execute(request, f.invocation);
  const retained = structuredClone(first.worktree), originalSession = f.agents.get(first.sessionId);
  assert.ok(first.worktree.checkoutRoot.startsWith(`${f.root}/`));
  root = resolve(f.directory, 'new managed root');
  const second = await f.controller.execute({ ...f.request(), firstPrompt: 'Use the changed root' }, f.invocation);
  assert.ok(second.worktree.checkoutRoot.startsWith(`${root}/`));
  assert.deepEqual(f.store.worktrees.get(first.worktree.id), retained);
  assert.equal(originalSession.session.header.cwd, retained.effectiveCwd);
  assert.equal(await realpath(retained.checkoutRoot), retained.checkoutRoot);
  const effects = [f.fetchCount, llm.calls.length, f.calls.filter(([kind]) => kind === 'session').length];
  assert.deepEqual(await f.controller.execute(request, f.invocation), first);
  assert.deepEqual([f.fetchCount, llm.calls.length, f.calls.filter(([kind]) => kind === 'session').length], effects);
  assert.equal(reads, 3, 'one live read per admitted create, including an effect-free replay');
  assert.equal(f.config.root, f.root, 'static snapshot/Git configuration is not rewritten');
});

test('creation root is captured synchronously before execute yields, ignoring invocation overrides', async t => {
  let root, reads = 0;
  const f = await fixture(t, { worktreeRoot: () => { reads++; return root; } }); root = f.root;
  const task = f.controller.execute(f.request(), { ...f.invocation, capturedRoot: resolve(f.directory, 'forged') });
  assert.equal(reads, 1);
  root = resolve(f.directory, 'changed-before-any-await');
  const result = await task;
  assert.ok(result.worktree.checkoutRoot.startsWith(`${f.root}/`)); assert.equal(reads, 1);
});

test('creation root stays captured across asynchronous source bootstrap', async t => {
  let root, entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { worktreeRoot: () => root }); root = f.root;
  const settings = f.dependencies.bootstrap.settings;
  f.dependencies.bootstrap.settings = async agent => { entered(); await gate; return settings(agent); };
  const task = f.controller.execute(f.request(), f.invocation); await ready;
  root = resolve(f.directory, 'changed-during-bootstrap'); release();
  assert.ok((await task).worktree.checkoutRoot.startsWith(`${f.root}/`));
});

test('repository-queued and fetching creates retain admission roots, later creates use edited root', async t => {
  let root, reads = 0, entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { worktreeRoot: () => { reads++; return root; }, create: async input => {
    entered(); await gate;
    await mkdir(resolve(input.destination, 'project'), { recursive: true });
    return { checkoutRoot: input.destination, effectiveCwd: resolve(input.destination, 'project'), baseOid: state.head, baseRef: input.baseRef, fetchedAt: 3 };
  } }); root = f.root;
  const first = f.controller.execute(f.request(), f.invocation); await ready;
  const second = f.controller.execute(f.request(), f.invocation);
  // Await an independent read to allow the second create to reach its repository queue.
  await f.controller.execute({ action: 'status' }, f.invocation);
  assert.equal(f.fetchCount, 1); assert.equal(reads, 2);
  root = resolve(f.directory, 'changed-while-queued'); release();
  for (const result of await Promise.all([first, second])) assert.ok(result.worktree.checkoutRoot.startsWith(`${f.root}/`));
  assert.ok((await f.controller.execute(f.request(), f.invocation)).worktree.checkoutRoot.startsWith(`${root}/`));
  assert.equal(reads, 3);
});

test('naming and session opening root edits never relocate the existing checkout', async t => {
  let root, f;
  const llm = namingLlm({ onPrepare() { root = resolve(f.directory, 'changed-during-naming'); } });
  f = await fixture(t, { worktreeRoot: () => root, agentCapabilities: { llm }, beforeSession() { root = resolve(f.directory, 'changed-during-opening'); } }); root = f.root;
  const request = { ...f.request(), firstPrompt: 'Keep the checkout directory' };
  const result = await f.controller.execute(request, f.invocation);
  assert.ok(result.worktree.checkoutRoot.startsWith(`${f.root}/`));
  assert.equal(f.calls.find(([kind]) => kind === 'session')[1].cwd, result.worktree.effectiveCwd);
  assert.deepEqual(await f.controller.execute(request, f.invocation), result); assert.equal(f.fetchCount, 1); assert.equal(llm.calls.length, 2);
});

test('bad live roots and getter failures refuse before directory, bootstrap, Git or naming effects', async t => {
  let root;
  const llm = namingLlm(), f = await fixture(t, { worktreeRoot: () => root, agentCapabilities: { llm } });
  const invalid = [undefined, null, 1, '', ' ', 'relative/root', ` ${f.root}`, `${f.root} `, `${f.root}\u0000bad`, `${f.root}\nline`, '/'.repeat(4097)];
  for (root of invalid) await assert.rejects(f.controller.execute({ ...f.request(), firstPrompt: 'No effects' }, f.invocation), errorCode('INVALID_ROOT'));
  for (root of ['/', '/..']) await assert.rejects(f.controller.execute(f.request(), f.invocation), errorCode('UNSAFE_ROOT'));
  f.dependencies.worktreeRoot = () => { throw Error('secret getter detail'); };
  await assert.rejects(f.controller.execute(f.request(), f.invocation), error => errorCode('INVALID_ROOT')(error) && !error.message.includes('secret'));
  assert.equal(f.calls.length, 0); assert.equal(f.fetchCount, 0); assert.equal(llm.calls.length, 0); assert.equal(f.store.operations.map.size, 0);
  await assert.rejects(stat(f.root), error => error.code === 'ENOENT');
});

test('live root getter cannot precede or bypass Full access and tool plan admission', async t => {
  let reads = 0;
  const f = await fixture(t, { worktreeRoot: () => { reads++; throw Error('must not read'); } });
  f.policy.set(f.actor.id, 'workspace-write');
  await assert.rejects(f.controller.execute(f.request(), f.invocation), errorCode('FULL_ACCESS_REQUIRED'));
  f.policy.set(f.actor.id, 'danger-full-access');
  for (const plan of [{ active: true, pending: false }, { active: false, pending: true }]) {
    f.plans.set(f.actor.id, plan);
    await assert.rejects(f.controller.execute(f.request(), { ...f.invocation, origin: 'tool' }), errorCode('PLAN_MODE'));
  }
  assert.equal(reads, 0); assert.equal(f.calls.length, 0); assert.equal(f.store.operations.map.size, 0);
});

test('live root inside selected repository still refuses without mkdir, fetch or naming', async t => {
  let root;
  const llm = namingLlm(), f = await fixture(t, { worktreeRoot: () => root, agentCapabilities: { llm } });
  root = resolve(f.repo, 'nested-live-root');
  await assert.rejects(f.controller.execute({ ...f.request(), firstPrompt: 'No unsafe creation' }, f.invocation), errorCode('UNSAFE_ROOT'));
  assert.equal(f.fetchCount, 0); assert.equal(llm.calls.length, 0); assert.equal(f.store.operations.map.size, 0);
  await assert.rejects(stat(root), error => error.code === 'ENOENT');
});

test('plain constructor root strings retain relative resolution when live dependency is absent', async t => {
  const f = await fixture(t);
  // Resolve into the fixture without changing cwd or creating anything outside it.
  f.config.root = relative(process.cwd(), f.root);
  const result = await f.controller.execute(f.request(), f.invocation);
  assert.ok(result.worktree.checkoutRoot.startsWith(`${f.root}/`));
});

test('live root edits leave previews, exports and handoff on the initial private snapshot root', async t => {
  let root;
  const f = await fixture(t, { worktreeRoot: () => root }); root = f.root;
  const original = await f.controller.execute(f.request(), f.invocation);
  const preview = await f.controller.execute({ action: 'preview', id: original.worktree.id }, f.invocation);
  assert.ok(preview.patchPath.startsWith(`${resolve(f.root, '.snapshots')}/`));
  root = resolve(f.directory, 'edited-live-root');
  const changed = await f.controller.execute(f.request(), f.invocation);
  assert.ok(changed.worktree.checkoutRoot.startsWith(`${root}/`));
  f.dependencies.worktreeRoot = () => { throw Error('non-create must never read this'); };
  const secondPreview = await f.controller.execute({ action: 'preview', id: changed.worktree.id }, f.invocation);
  assert.ok(secondPreview.patchPath.startsWith(`${resolve(f.root, '.snapshots')}/`));
  for (const item of [preview, secondPreview]) assert.equal((await f.controller.execute({ action: 'export', previewId: item.id }, f.invocation)).patchHash, item.patchHash);
  const result = await f.controller.execute({ action: 'handoff', id: original.worktree.id, previewId: preview.id, operationId: randomUUID() }, f.invocation);
  assert.equal(result.operation.phase, 'ready'); assert.equal(f.applyCount, 1);
  assert.equal(result.worktree.checkoutRoot, original.worktree.checkoutRoot);
  assert.equal(f.agents.get(original.sessionId).session.header.cwd, original.worktree.effectiveCwd);
  assert.equal(f.config.root, f.root);
});

test('full access and pending plan guard actual invocation, not source or owner, before Git or naming', async t => {
  const llm = namingLlm(), f = await fixture(t, { agentCapabilities: { llm } }); const source = f.agent();
  const request = () => ({ ...f.request(), firstPrompt: 'Guard the naming flow' });
  f.policy.set(f.actor.id, 'workspace-write');
  await assert.rejects(f.controller.execute({ ...request(), sourceSessionId: source.id }, f.invocation), errorCode('FULL_ACCESS_REQUIRED'));
  assert.equal(f.fetchCount, 0); assert.equal(f.store.operations.map.size, 0);
  f.policy.set(f.actor.id, 'danger-full-access'); f.plans.set(f.actor.id, { active: false, pending: true });
  await assert.rejects(f.controller.execute(request(), { ...f.invocation, origin: 'tool' }), errorCode('PLAN_MODE'));
  f.plans.set(f.actor.id, { active: true, pending: false });
  await assert.rejects(f.controller.execute(request(), { ...f.invocation, origin: 'tool' }), errorCode('PLAN_MODE'));
  assert.equal(llm.calls.length, 0); assert.equal(f.store.operations.map.size, 0);
  const result = await f.controller.execute(request(), f.invocation); assert.equal(result.operation.phase, 'ready');
  assert.equal(f.fetchCount, 1); assert.equal(llm.calls.length, 2);
});

test('source settings rechecked after irreversible checkout; uncertain op is never repeated', async t => {
  let f;
  f = await fixture(t, { create: async input => {
    await mkdir(resolve(input.destination, 'project'), { recursive: true });
    f.settings.set(f.actor.id, { ...f.settings.get(f.actor.id), hash: 'changed' });
    return { checkoutRoot: input.destination, effectiveCwd: resolve(input.destination, 'project'), baseOid: state.head, baseRef: input.baseRef, fetchedAt: 7 };
  } });
  const request = f.request();
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('SETTINGS_CHANGED'));
  assert.equal(f.store.operations.get(request.operationId).phase, 'recovery-required'); assert.equal(f.fetchCount, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'session').length, 0);
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED')); assert.equal(f.fetchCount, 1);
});

test('actual actor authorization is rechecked after checkout effects without losing its durable receipt', async t => {
  let f;
  f = await fixture(t, { create: async input => {
    await mkdir(resolve(input.destination, 'project'), { recursive: true });
    f.policy.set(f.actor.id, 'read-only');
    return { checkoutRoot: input.destination, effectiveCwd: resolve(input.destination, 'project'), baseOid: state.head, baseRef: input.baseRef, fetchedAt: 7 };
  } });
  const request = f.request(); await assert.rejects(f.controller.execute(request, f.invocation), errorCode('FULL_ACCESS_REQUIRED'));
  const operation = f.store.operations.get(request.operationId); assert.equal(operation.phase, 'recovery-required'); assert.equal(f.store.worktrees.get(operation.worktreeId).baseOid, state.head);
  assert.equal(f.calls.filter(([kind]) => kind === 'session').length, 0); assert.equal(f.fetchCount, 1);
});

test('session identity is durable before bootstrap flush can fail', async t => {
  const f = await fixture(t, { afterSession: async () => { throw new WorktreeError('FLUSH_FAILED', 'flush failed'); } });
  const request = f.request(); await assert.rejects(f.controller.execute(request, f.invocation), errorCode('FLUSH_FAILED'));
  const operation = f.store.operations.get(request.operationId);
  assert.ok(operation.sessionId); assert.ok(operation.workspaceId); assert.equal(operation.phase, 'recovery-required');
  assert.deepEqual(f.store.worktrees.get(operation.worktreeId).sessionIds, [operation.sessionId]);
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED')); assert.equal(f.fetchCount, 1);
});

test('branch advertisements use sorted bounded pages and reject stale remote identity', async t => {
  const f = await fixture(t);
  const first = await f.controller.execute({ action: 'branches', remote: 'origin', limit: 50 }, f.invocation);
  assert.equal(first.items.length, 50); assert.equal(first.items[0].name, 'branch-000'); assert.ok(first.nextCursor); assert.equal(first.branches, undefined);
  const second = await f.controller.execute({ action: 'branches', remote: 'origin', cursor: first.nextCursor, limit: 50 }, f.invocation);
  assert.equal(second.items[0].name, 'branch-050'); assert.equal(f.calls.filter(([kind]) => kind === 'branches').length, 1);
  f.remoteIdentity = 'new-identity';
  await assert.rejects(f.controller.execute({ action: 'branches', remote: 'origin', remoteIdentity: first.remoteIdentity, cursor: first.nextCursor }, f.invocation), errorCode('REMOTE_CHANGED'));
  await assert.rejects(f.controller.execute({ action: 'branches', remote: 'origin', cursor: first.nextCursor }, f.invocation), errorCode('STALE_CURSOR'));
});

test('failed branch refresh does not offer cached fallback', async t => {
  const options = {}; const f = await fixture(t, options);
  const first = await f.controller.execute({ action: 'branches', remote: 'origin' }, f.invocation); options.branchesFailure = true;
  await assert.rejects(f.controller.execute({ action: 'branches', remote: 'origin' }, f.invocation), errorCode('GIT_FAILED'));
  await assert.rejects(f.controller.execute({ action: 'branches', remote: 'origin', cursor: first.nextCursor }, f.invocation), errorCode('STALE_CURSOR'));
});

test('metadata archive retains files and base; protection and readonly arrays respected', async t => {
  const f = await fixture(t); const result = await f.controller.execute(f.request(), f.invocation); const id = result.worktree.id;
  await f.controller.execute({ action: 'protect', id, protected: true }, f.invocation);
  await assert.rejects(f.controller.execute({ action: 'archive', id }, f.invocation), errorCode('PROTECTED'));
  await f.controller.execute({ action: 'protect', id, protected: false }, f.invocation);
  const archived = await f.controller.execute({ action: 'archive', id }, f.invocation); assert.equal(archived.scope, 'plugin-record'); assert.equal(archived.worktree.baseRef, result.worktree.baseRef);
  assert.equal(await realpath(archived.worktree.checkoutRoot), archived.worktree.checkoutRoot);
  assert.equal((await f.controller.execute({ action: 'list' }, f.invocation)).items.length, 0);
  assert.equal((await f.controller.execute({ action: 'list', includeArchived: true }, f.invocation)).items.length, 1);
  await assert.rejects(f.controller.execute({ action: 'start', id }, f.invocation), errorCode('ARCHIVED'));
  await f.controller.execute({ action: 'archive', id, archived: false }, f.invocation);
  const started = await f.controller.execute({ action: 'start', id }, f.invocation);
  assert.notEqual(started.sessionId, result.sessionId); assert.deepEqual(started.worktree.sessionIds, [result.sessionId, started.sessionId]); assert.equal(f.fetchCount, 1);
  const copies = f.controller.records(); copies[0].sessionIds.length = 0; assert.equal(f.controller.records()[0].sessionIds.length, 2);
});

test('preview and export retain source; handoff claims every subdirectory session and replays once', async t => {
  const f = await fixture(t); const created = await f.controller.execute(f.request(), f.invocation); const id = created.worktree.id;
  const source = f.agents.get(created.sessionId); const targetChild = f.agent(randomUUID(), resolve(f.repo, 'project'));
  const preview = await f.controller.execute({ action: 'preview', id }, f.invocation); assert.equal(preview.sourceSessionId, source.id);
  const exported = await f.controller.execute({ action: 'export', previewId: preview.id }, f.invocation); assert.equal(exported.bytes, preview.bytes); assert.ok(exported.patch);
  const request = { action: 'handoff', id, previewId: preview.id, operationId: randomUUID() };
  const result = await f.controller.execute(request, f.invocation); assert.equal(result.operation.phase, 'ready'); assert.equal(f.applyCount, 1);
  assert.equal(result.worktree.checkoutRoot, created.worktree.checkoutRoot); assert.equal(source.session.header.cwd, created.worktree.effectiveCwd);
  assert.equal(f.calls.filter(([kind]) => kind === 'session').at(-1)[1].mode, 'continue');
  assert.equal(f.calls.filter(([kind]) => kind === 'session').at(-1)[1].cwd, resolve(f.repo, 'project'));
  assert.ok(f.calls.some(([kind, id]) => kind === 'claim' && id === targetChild.id));
  assert.deepEqual(await f.controller.execute(request, f.invocation), result); assert.equal(f.applyCount, 1);
});

test('running source tool handoff fails BUSY immediately, never waits on its own turn', async t => {
  const f = await fixture(t); const created = await f.controller.execute(f.request(), f.invocation); const source = f.agents.get(created.sessionId);
  const preview = await f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation);
  source.status = 'running'; source.whenIdle = () => { throw Error('must never wait'); };
  await assert.rejects(f.controller.execute({ action: 'handoff', id: created.worktree.id, previewId: preview.id, operationId: randomUUID() }, { ...f.invocation, agent: source, origin: 'tool' }), errorCode('BUSY'));
  assert.equal(f.applyCount, 0);
});

test('known jobs, pending inbox and terminal diagnostics fail conservatively', async t => {
  const capabilities = {}; const f = await fixture(t, { capabilities }); const created = await f.controller.execute(f.request(), f.invocation);
  capabilities.jobs = { list: () => [{ status: 'stopping' }] };
  await assert.rejects(f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation), errorCode('BUSY'));
  capabilities.jobs = { list: () => { throw Error('cannot inspect'); } };
  await assert.rejects(f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation), errorCode('BUSY_UNKNOWN'));
  delete capabilities.jobs; capabilities.terminals = { hasOwnerActivity: () => true };
  await assert.rejects(f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation), errorCode('BUSY'));
  delete capabilities.terminals; f.actor.inbox.nextTurn.push('pending');
  await assert.rejects(f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation), errorCode('BUSY'));
  assert.equal(f.calls.filter(([kind]) => kind === 'snapshot').length, 0);
});

test('code-applied session failure retries only the continuation, never the patch', async t => {
  const options = {}; const f = await fixture(t, options); const created = await f.controller.execute(f.request(), f.invocation);
  const preview = await f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation);
  options.beforeSession = async input => { if (input.mode === 'continue') throw new WorktreeError('SESSION_FAILED', 'continuation failed'); };
  const request = { action: 'handoff', id: created.worktree.id, previewId: preview.id, operationId: randomUUID() };
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('SESSION_FAILED'));
  assert.equal(f.store.operations.get(request.operationId).phase, 'code-applied'); assert.equal(f.applyCount, 1);
  delete options.beforeSession; const recovered = await f.controller.execute(request, f.invocation);
  assert.equal(recovered.operation.phase, 'ready'); assert.equal(f.applyCount, 1);
});

test('uncertain apply is journaled and never repeated automatically; diagnostics redacted', async t => {
  const f = await fixture(t, { apply: async () => { throw new WorktreeError('APPLY_UNCERTAIN', ['https://', 'user:', 'password', '@example.invalid failed ', 'ghp_', 'abc123'].join('')); } });
  const created = await f.controller.execute(f.request(), f.invocation); const preview = await f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation);
  const request = { action: 'handoff', id: created.worktree.id, previewId: preview.id, operationId: randomUUID() };
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('APPLY_UNCERTAIN'));
  const operation = f.store.operations.get(request.operationId); assert.equal(operation.phase, 'recovery-required'); assert.ok(!operation.error.message.includes('password')); assert.ok(!operation.error.message.includes('ghp_'));
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED')); assert.equal(f.applyCount, 1);
});

test('per-common-dir serialization and cancellation while queued cannot bypass active writer', async t => {
  let release; let entered; const started = new Promise(resolve => { entered = resolve; }); const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { create: async input => { entered(); await blocked; await mkdir(resolve(input.destination, 'project'), { recursive: true }); return { checkoutRoot: input.destination, effectiveCwd: resolve(input.destination, 'project'), baseOid: state.head, baseRef: input.baseRef, fetchedAt: 3 }; } });
  const first = f.controller.execute(f.request(), f.invocation); await started;
  const abort = new AbortController(); const second = f.controller.execute(f.request(), { ...f.invocation, signal: abort.signal }); abort.abort();
  await assert.rejects(second, errorCode('CANCELLED')); assert.equal(f.fetchCount, 1);
  release(); await first; assert.equal(f.fetchCount, 1);
});

test('close drains in-flight operations and only disposes bootstrap-owned handles', async t => {
  const f = await fixture(t); await f.controller.execute(f.request(), f.invocation); const originalSize = f.agents.size;
  await f.controller.close(); assert.equal(f.agents.size, originalSize); assert.equal(f.calls.filter(([kind]) => kind === 'close').length, 1);
  await assert.rejects(f.controller.execute({ action: 'list' }, f.invocation), errorCode('CLOSED'));
});

test('initial request rejection binds no journal and no unexpected privilege parameters', async t => {
  const f = await fixture(t);
  await assert.rejects(async () => f.controller.execute({ ...f.request(), fullAccess: true }, f.invocation), errorCode('INVALID_REQUEST'));
  await assert.rejects(f.controller.execute({ ...f.request(), settingsHash: 'stale' }, f.invocation), errorCode('SETTINGS_CHANGED'));
  f.actor.session.header.origin = 'subagent'; await assert.rejects(f.controller.execute(f.request(), f.invocation), errorCode('SUBAGENT_SOURCE'));
  assert.equal(f.store.operations.map.size, 0); assert.equal(f.fetchCount, 0);
});

test('cancellation after apply retains code-applied receipt and never replays the patch', async t => {
  const abort = new AbortController();
  const f = await fixture(t, { apply: async preview => { abort.abort(); return { head: state.head, files: preview.files }; } });
  const created = await f.controller.execute(f.request(), f.invocation);
  const preview = await f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation);
  const request = { action: 'handoff', id: created.worktree.id, previewId: preview.id, operationId: randomUUID() };
  await assert.rejects(f.controller.execute(request, { ...f.invocation, signal: abort.signal }), errorCode('CANCELLED'));
  const operation = f.store.operations.get(request.operationId);
  assert.equal(operation.phase, 'code-applied'); assert.equal(operation.appliedHead, state.head); assert.equal(operation.appliedFingerprint, null);
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED'));
  assert.equal(f.applyCount, 1);
});

test('code-applied recovery refuses intervening target changes', async t => {
  const options = {}; const f = await fixture(t, options);
  const created = await f.controller.execute(f.request(), f.invocation);
  const preview = await f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation);
  options.beforeSession = async input => { if (input.mode === 'continue') throw new WorktreeError('SESSION_FAILED', 'not created'); };
  const request = { action: 'handoff', id: created.worktree.id, previewId: preview.id, operationId: randomUUID() };
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('SESSION_FAILED'));
  delete options.beforeSession; f.git.fingerprint = async () => 'changed-dirty-tree';
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED')); assert.equal(f.applyCount, 1);
});

test('export validates actual snapshot size and content before returning inline data', async t => {
  const f = await fixture(t); const created = await f.controller.execute(f.request(), f.invocation);
  const preview = await f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation);
  await writeFile(preview.patchPath, 'changed');
  await assert.rejects(f.controller.execute({ action: 'export', previewId: preview.id }, f.invocation), errorCode('PATCH_CHANGED'));
  const unknown = randomUUID(); await assert.rejects(f.controller.execute({ action: 'export', previewId: unknown }, f.invocation), errorCode('PREVIEW_EXPIRED'));
});

test('repository root cannot contain managed checkout destination', async t => {
  const f = await fixture(t); f.config.root = resolve(f.repo, 'nested-managed');
  await assert.rejects(f.controller.execute(f.request(), f.invocation), errorCode('UNSAFE_ROOT'));
  assert.equal(f.store.operations.map.size, 0); assert.equal(f.fetchCount, 0);
});

// Guard against accidental dependence on request-field insertion order.
test('journal hashes canonicalize normalized object ordering', () => { assert.equal(hashValue({ b: 2, a: 1 }), hashValue({ a: 1, b: 2 })); });

function namingLlm({ onPrepare, output = '{"title":"Add search filters","slug":"search-filters"}', stream } = {}) {
  const calls = [];
  return { calls, async prepareCall(config, signal) {
    calls.push(['prepare', structuredClone(config), signal]); await onPrepare?.(config, signal);
    return { config: { ...config }, stream(options) {
      calls.push(['stream', options]);
      return stream?.(options) ?? (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: output };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: output } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    } };
  } };
}

test('first Send fetches, checks out, names branch, opens, then returns durable ready once without moving cwd', async t => {
  let f; const stages = []; let checkoutRoot;
  const llm = namingLlm({ onPrepare() {
    assert.equal(f.fetchCount, 1);
    assert.deepEqual(f.calls.filter(([kind]) => ['create', 'branch', 'rename', 'session'].includes(kind)).map(([kind]) => kind), ['create', 'branch']);
    const operation = [...f.store.operations.map.values()][0];
    assert.equal(operation.phase, 'checkout-created'); assert.equal(operation.namingStarted, true); assert.equal(operation.generatedName, undefined);
    const record = f.store.worktrees.get(operation.worktreeId);
    assert.equal(record.state, 'creating'); assert.equal(record.baseOid, state.head);
    assert.equal(record.branch, `worktree/${record.id}`); assert.equal(record.sessionIds.length, 0);
    checkoutRoot = record.checkoutRoot;
    assert.deepEqual(stages.map(p => p.stage), ['fetching', 'creating', 'naming']);
  } });
  f = await fixture(t, { agentCapabilities: { llm }, beforeSession(input) {
    const operation = [...f.store.operations.map.values()][0], record = f.store.worktrees.get(operation.worktreeId);
    assert.equal(record.branch, operation.generatedName.branch); assert.equal(record.checkoutRoot, checkoutRoot);
    assert.deepEqual(record.naming, operation.generatedName); assert.equal(record.firstMessageNaming, undefined);
    assert.equal(input.mode, 'new'); assert.equal(input.cwd, record.effectiveCwd);
    assert.deepEqual(stages.map(p => p.stage), ['fetching', 'creating', 'naming', 'opening']);
  } });
  const request = { ...f.request(), firstPrompt: 'Add search filters to records' };
  const invocation = { ...f.invocation, onProgress(progress) {
    assert.equal(progress.operationId, request.operationId); assert.ok(Object.isFrozen(progress));
    assert.deepEqual(Object.keys(progress).sort(), ['operationId', 'stage', 'worktreeId']);
    if (progress.stage === 'ready') assert.equal(f.store.operations.get(progress.operationId).phase, 'ready');
    stages.push(progress);
  } };
  const result = await f.controller.execute(request, invocation);
  const id = result.worktree.id; const naming = result.worktree.naming;
  assert.deepEqual(naming, result.operation.generatedName); assert.equal(naming.source, 'model');
  assert.equal(result.worktree.displayName, 'Add search filters'); assert.equal(result.worktree.branch, `worktree/search-filters-${id.slice(0, 8)}`);
  assert.equal(result.worktree.remoteBranch, 'main'); assert.equal(result.worktree.baseRef, `refs/dsh-worktrees/${id}/base`);
  assert.equal(result.worktree.checkoutRoot, resolve(f.root, hashValue(resolve(f.repo, '.git')).slice(0, 24), id, `worktree-${id}`));
  assert.equal(result.worktree.checkoutRoot, checkoutRoot);
  assert.equal(result.worktree.effectiveCwd, resolve(result.worktree.checkoutRoot, 'project'));
  assert.equal(result.worktree.firstMessageNaming, undefined);
  assert.deepEqual(f.agents.get(result.sessionId).session.ownEvents(), []);
  assert.deepEqual(f.actor.session.ownEvents(), [], 'backend never admits the source prompt');
  const bootstrap = f.calls.find(([kind]) => kind === 'session')[1];
  assert.equal(bootstrap.title, naming.title); assert.equal(bootstrap.cwd, result.worktree.effectiveCwd);
  assert.deepEqual(f.calls.filter(([kind]) => ['create', 'branch', 'rename', 'session'].includes(kind)).map(([kind]) => kind), ['create', 'branch', 'rename', 'session']);
  const rename = f.calls.find(([kind]) => kind === 'rename'); assert.equal(rename[2], `worktree/${id}`); assert.equal(rename[3], naming.branch);
  assert.equal(f.events.find(e => e.name === 'operation' && e.value.phase === 'fetching').value.generatedName, undefined);
  assert.equal(JSON.stringify(result.operation).includes(request.firstPrompt), false);
  assert.deepEqual(worktreeDomain.tables.worktrees.valueSchema.parse(result.worktree), result.worktree);
  assert.deepEqual(worktreeDomain.tables.operations.valueSchema.parse(result.operation), result.operation);
  assert.deepEqual(stages.map(p => p.stage), ['fetching', 'creating', 'naming', 'opening', 'ready']);
  assert.ok(stages.every(p => p.worktreeId === id));
  assert.equal(llm.calls.length, 2);
  const priorCalls = f.calls.filter(([kind]) => ['create', 'branch', 'rename', 'session'].includes(kind)).length;
  assert.deepEqual(await f.controller.execute(request, invocation), result);
  assert.deepEqual(stages.map(p => p.stage), ['fetching', 'creating', 'naming', 'opening', 'ready', 'ready']);
  assert.equal(llm.calls.length, 2); assert.equal(f.fetchCount, 1);
  assert.equal(f.calls.filter(([kind]) => ['create', 'branch', 'rename', 'session'].includes(kind)).length, priorCalls);
  await assert.rejects(f.controller.execute({ ...request, firstPrompt: 'Different task' }, invocation), errorCode('OPERATION_REUSED'));
  assert.equal(llm.calls.length, 2);
});

test('no-prompt create immediately uses stable random directory and local branch without inference', async t => {
  const llm = namingLlm({ onPrepare() { throw Error('Blank flow must never name'); } });
  const f = await fixture(t, { agentCapabilities: { llm } });
  const result = await f.controller.execute(f.request(), f.invocation);
  assert.equal(llm.calls.length, 0); assert.equal(result.worktree.branch, `worktree/${result.worktree.id}`);
  assert.equal(basename(result.worktree.checkoutRoot), `worktree-${result.worktree.id}`);
  assert.equal('displayName' in result.worktree, false); assert.equal('naming' in result.worktree, false); assert.equal('generatedName' in result.operation, false);
  assert.deepEqual(result.worktree.firstMessageNaming, { sessionId: result.sessionId, initialBranch: result.worktree.branch, phase: 'waiting' });
  assert.deepEqual(worktreeDomain.tables.worktrees.valueSchema.parse(result.worktree), result.worktree);
  assert.deepEqual(worktreeDomain.tables.operations.valueSchema.parse(result.operation), result.operation);
  assert.equal(f.calls.filter(([kind]) => kind === 'branch').length, 1);
  assert.equal(f.calls.find(([kind]) => kind === 'session')[1].mode, 'new');
  assert.deepEqual(f.agents.get(result.sessionId).session.ownEvents(), []);
});

test('duplicate generated slugs have different directories and branches without changing base branch', async t => {
  const llm = namingLlm(); const f = await fixture(t, { agentCapabilities: { llm } });
  const first = await f.controller.execute({ ...f.request(), firstPrompt: 'Add search filters' }, f.invocation);
  const second = await f.controller.execute({ ...f.request(), firstPrompt: 'Add search filters' }, f.invocation);
  assert.notEqual(first.worktree.branch, second.worktree.branch); assert.notEqual(first.worktree.checkoutRoot, second.worktree.checkoutRoot);
  assert.equal(first.worktree.remoteBranch, second.worktree.remoteBranch); assert.equal(llm.calls.length, 4);
});

test('invalid naming output is visible as fallback metadata and still creates a safe branch', async t => {
  const llm = namingLlm({ output: 'not JSON secret-error' }); const f = await fixture(t, { agentCapabilities: { llm } });
  const result = await f.controller.execute({ ...f.request(), firstPrompt: 'Repair API routes' }, f.invocation);
  assert.equal(result.worktree.naming.source, 'fallback'); assert.equal(result.worktree.naming.fallbackReason, 'invalid-output');
  assert.match(result.worktree.branch, /^worktree\/repair-api-routes-[0-9a-f]{8}$/u);
  assert.equal(llm.calls.length, 2); assert.ok(!JSON.stringify(result).includes('secret-error'));
});

test('disabled Config creates deterministic task names without a model call, while status advertises naming Config', async t => {
  const llm = namingLlm(); const f = await fixture(t, { agentCapabilities: { llm }, config: { namingEnabled: false, namingProvider: 'custom', namingModel: 'namer', namingMaxTokens: 512 } });
  const status = await f.controller.execute({ action: 'status' }, f.invocation);
  assert.deepEqual(status.namingConfig, { namingEnabled: false, namingProvider: 'custom', namingModel: 'namer', namingTimeoutMs: 15000, namingMaxTokens: 512 });
  const result = await f.controller.execute({ ...f.request(), firstPrompt: 'Repair API routes' }, f.invocation);
  assert.equal(result.worktree.naming.fallbackReason, 'disabled'); assert.equal(llm.calls.length, 0);
  const restarted = await f.controller.execute({ action: 'start', id: result.worktree.id }, f.invocation);
  assert.equal(restarted.worktree.displayName, result.worktree.displayName);
  assert.equal(f.calls.filter(([kind]) => kind === 'session').at(-1)[1].title, result.worktree.displayName);
});

test('naming uses the exact source scoped LLM but attributes caller, independently of conversation settings', async t => {
  const initiators = []; const llm = namingLlm(); const f = await fixture(t);
  const source = f.agent(); const originalGet = source.ctx.get;
  source.ctx.get = name => name === 'llm' ? llm : name === 'agents' ? { withInitiator(caller, task) { initiators.push(caller); return task(); } } : originalGet(name);
  const settings = structuredClone(f.settings.get(source.id));
  const result = await f.controller.execute({ ...f.request(), sourceSessionId: source.id, firstPrompt: 'Name the task' }, f.invocation);
  assert.equal(result.worktree.naming.source, 'model'); assert.deepEqual(initiators, [f.actor]);
  assert.equal(llm.calls[1][1].sessionId, source.id); assert.equal(llm.calls[0][1].model, 'gpt-6-luna');
  assert.deepEqual(f.settings.get(source.id), settings); assert.equal(result.operation.settings.model.model, 'gpt-6.1-sol');
});

test('cancelled naming retains checkout and initial branch; same operation cannot incur another inference', async t => {
  const abort = new AbortController(); let entered; const ready = new Promise(resolve => { entered = resolve; }); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const llm = namingLlm({ stream: () => (async function* () { entered(); await gate; yield { type: 'text-delta', index: 0, text: '{"title":"Late","slug":"late"}' }; yield { type: 'finish', reason: { kind: 'stop' } }; })() });
  const f = await fixture(t, { agentCapabilities: { llm } }); const stages = [];
  const request = { ...f.request(), firstPrompt: 'Cancel naming' };
  const task = f.controller.execute(request, { ...f.invocation, signal: abort.signal, onProgress: p => stages.push(p.stage) }); await ready; abort.abort();
  await assert.rejects(task, errorCode('CANCELLED'));
  const operation = f.store.operations.get(request.operationId); assert.equal(operation.phase, 'recovery-required'); assert.equal(f.fetchCount, 1); assert.equal(operation.namingStarted, true);
  const record = f.store.worktrees.get(operation.worktreeId); assert.equal(record.state, 'recovery-required');
  assert.equal(await realpath(record.checkoutRoot), record.checkoutRoot); assert.equal(record.branch, `worktree/${record.id}`);
  assert.equal(basename(record.checkoutRoot), `worktree-${record.id}`); assert.equal(record.baseOid, state.head);
  assert.equal(f.calls.filter(([kind]) => kind === 'rename' || kind === 'session').length, 0);
  assert.deepEqual(stages, ['fetching', 'creating', 'naming']);
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED')); assert.equal(llm.calls.length, 2);
  release(); await gate; await Promise.resolve(); assert.equal(f.fetchCount, 1);
});

test('failed rename collision retains checkout and durable generated name; replay never fetches or pays again', async t => {
  const llm = namingLlm(); const f = await fixture(t, { agentCapabilities: { llm }, renameBranch() { throw new WorktreeError('BRANCH_EXISTS', 'Branch already exists'); } });
  const request = { ...f.request(), firstPrompt: 'Add search filters' };
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('BRANCH_EXISTS'));
  const operation = f.store.operations.get(request.operationId); const record = f.store.worktrees.get(operation.worktreeId);
  assert.equal(operation.phase, 'recovery-required'); assert.equal(record.state, 'recovery-required'); assert.ok(operation.generatedName);
  assert.equal(await realpath(record.checkoutRoot), record.checkoutRoot); assert.equal(record.branch, `worktree/${record.id}`);
  assert.deepEqual(record.naming, operation.generatedName); assert.equal(basename(record.checkoutRoot), `worktree-${record.id}`);
  assert.equal(f.calls.filter(([kind]) => kind === 'session').length, 0);
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED')); assert.equal(llm.calls.length, 2); assert.equal(f.fetchCount, 1);
});

test('authorization changed during auxiliary naming retains prior checkout but prevents rename and session effects', async t => {
  let f; const llm = namingLlm({ onPrepare() { f.policy.set(f.actor.id, 'read-only'); } });
  f = await fixture(t, { agentCapabilities: { llm } }); const request = { ...f.request(), firstPrompt: 'New task' };
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('FULL_ACCESS_REQUIRED'));
  assert.equal(llm.calls.length, 1); assert.equal(f.fetchCount, 1); assert.equal(f.calls.filter(([kind]) => kind === 'rename' || kind === 'session').length, 0);
  const operation = f.store.operations.get(request.operationId); const record = f.store.worktrees.get(operation.worktreeId);
  assert.equal(operation.phase, 'recovery-required'); assert.equal(record.branch, `worktree/${record.id}`);
  assert.equal(await realpath(record.checkoutRoot), record.checkoutRoot);
});

for (const failure of ['fresh-fetch', 'checkout']) test(`${failure} failure never names or bootstraps; uncertain operation replays fail-closed`, async t => {
  const stages = [], llm = namingLlm();
  const f = await fixture(t, { agentCapabilities: { llm }, create(input) {
    if (failure === 'checkout') input.onProgress?.('creating');
    throw new WorktreeError('GIT_FAILED', 'Fresh setup failed.');
  } });
  const request = { ...f.request(), firstPrompt: 'Should not infer before checkout succeeds' };
  await assert.rejects(f.controller.execute(request, { ...f.invocation, onProgress: p => stages.push(p.stage) }), errorCode('GIT_FAILED'));
  assert.deepEqual(stages, failure === 'fresh-fetch' ? ['fetching'] : ['fetching', 'creating']);
  assert.equal(llm.calls.length, 0); assert.equal(f.calls.filter(([kind]) => ['branch', 'rename', 'session'].includes(kind)).length, 0);
  assert.equal(f.store.operations.get(request.operationId).phase, 'recovery-required');
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED'));
  assert.equal(f.fetchCount, 1); assert.equal(llm.calls.length, 0);
});

test('failed initial branch never pays for naming, retains checkout, and does not bootstrap', async t => {
  const llm = namingLlm(), f = await fixture(t, { agentCapabilities: { llm }, createBranch() { throw new WorktreeError('GIT_FAILED', 'Initial branch failed.'); } });
  const request = { ...f.request(), firstPrompt: 'Should not infer before initial branch exists' };
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('GIT_FAILED'));
  const operation = f.store.operations.get(request.operationId), record = f.store.worktrees.get(operation.worktreeId);
  assert.equal(operation.namingStarted, undefined); assert.equal(operation.generatedName, undefined); assert.equal(record.branch, null);
  assert.equal(await realpath(record.checkoutRoot), record.checkoutRoot);
  assert.equal(llm.calls.length, 0); assert.equal(f.calls.filter(([kind]) => kind === 'rename' || kind === 'session').length, 0);
});

for (const listener of ['throwing', 'rejecting']) test(`${listener} progress listener is harmless and cannot authorize request parameters`, async t => {
  const llm = namingLlm(), f = await fixture(t, { agentCapabilities: { llm } }); const stages = [];
  const invocation = { ...f.invocation, onProgress(p) {
    stages.push(p.stage);
    if (listener === 'rejecting') return Promise.reject(Error('Observer failed.'));
    p.operationId = randomUUID(); // Frozen; throws without changing the real operation.
  } };
  const request = { ...f.request(), firstPrompt: 'Name after checkout' };
  const result = await f.controller.execute(request, invocation);
  assert.equal(result.operation.id, request.operationId); assert.equal(result.operation.phase, 'ready');
  assert.deepEqual(stages, ['fetching', 'creating', 'naming', 'opening', 'ready']); assert.equal(llm.calls.length, 2);
  await assert.rejects(f.controller.execute({ ...f.request(), onProgress: () => {} }, invocation), errorCode('INVALID_REQUEST'));
  f.policy.set(f.actor.id, 'read-only');
  await assert.rejects(f.controller.execute({ ...f.request(), firstPrompt: 'No privilege from listener' }, invocation), errorCode('FULL_ACCESS_REQUIRED'));
  assert.equal(f.fetchCount, 1);
});

for (const reason of ['timeout', 'invalid-output']) test(`checkout-first ${reason} naming fallback retains stable files and applies branch before opening`, async t => {
  const llm = namingLlm(reason === 'timeout' ? { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) } : { output: 'Invalid secret-output' });
  const f = await fixture(t, { agentCapabilities: { llm }, config: { namingTimeoutMs: 100 } });
  const result = await f.controller.execute({ ...f.request(), firstPrompt: 'Repair setup flow' }, f.invocation);
  assert.equal(result.worktree.naming.fallbackReason, reason); assert.equal(result.worktree.branch, result.operation.generatedName.branch);
  assert.equal(await realpath(result.worktree.checkoutRoot), result.worktree.checkoutRoot); assert.equal(basename(result.worktree.checkoutRoot), `worktree-${result.worktree.id}`);
  assert.equal(result.worktree.firstMessageNaming, undefined); assert.equal(f.fetchCount, 1); assert.equal(llm.calls.length, 2);
  assert.deepEqual(f.calls.filter(([kind]) => ['create', 'branch', 'rename', 'session'].includes(kind)).map(([kind]) => kind), ['create', 'branch', 'rename', 'session']);
  assert.ok(!JSON.stringify(result).includes('secret-output'));
});

test('foreground naming clamps longer configured deadlines to 15s without changing configured model', async t => {
  const llm = namingLlm({ stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) });
  const f = await fixture(t, { agentCapabilities: { llm }, config: { namingTimeoutMs: 60000, namingProvider: 'configured-provider', namingModel: 'fast-naming-model' } });
  const delays = [], original = globalThis.setTimeout;
  let result;
  try {
    // Observe the real configured timer while shortening wall-clock time for the fixture.
    globalThis.setTimeout = (callback, delay, ...args) => { delays.push(delay); return original(callback, Math.min(delay, 25), ...args); };
    result = await f.controller.execute({ ...f.request(), firstPrompt: 'Bound foreground setup' }, f.invocation);
  } finally { globalThis.setTimeout = original; }
  assert.deepEqual(delays, [15000]); assert.equal(result.worktree.naming.fallbackReason, 'timeout');
  assert.equal(f.config.namingTimeoutMs, 60000);
  assert.deepEqual(llm.calls[0][1], { provider: 'configured-provider', model: 'fast-naming-model', maxTokens: 256 });
});

test('cancellation after rename keeps exact applied branch and naming receipts, never opens or repeats', async t => {
  const abort = new AbortController(), llm = namingLlm();
  const f = await fixture(t, { agentCapabilities: { llm }, renameBranch(_record, _expected, name) { abort.abort(); return { ...state, branch: name }; } });
  const request = { ...f.request(), firstPrompt: 'Keep branch receipt' };
  await assert.rejects(f.controller.execute(request, { ...f.invocation, signal: abort.signal }), errorCode('CANCELLED'));
  const operation = f.store.operations.get(request.operationId), record = f.store.worktrees.get(operation.worktreeId);
  assert.equal(operation.phase, 'recovery-required'); assert.equal(record.branch, operation.generatedName.branch);
  assert.deepEqual(record.naming, operation.generatedName); assert.equal(await realpath(record.checkoutRoot), record.checkoutRoot);
  assert.equal(f.calls.filter(([kind]) => kind === 'session').length, 0);
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED'));
  assert.equal(f.fetchCount, 1); assert.equal(llm.calls.length, 2); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 1);
});

test('concurrent identical first Send requests infer and create once, second observer sees ready replay only', async t => {
  let entered, release; const prepared = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const llm = namingLlm({ stream: () => (async function* () {
    entered(); await gate;
    yield { type: 'text-delta', index: 0, text: '{"title":"Concurrent task","slug":"concurrent-task"}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() });
  const f = await fixture(t, { agentCapabilities: { llm } }), stages = [[], []];
  const request = { ...f.request(), firstPrompt: 'Concurrent task' };
  const first = f.controller.execute(request, { ...f.invocation, onProgress: p => stages[0].push(p.stage) });
  await prepared;
  const second = f.controller.execute(request, { ...f.invocation, onProgress: p => stages[1].push(p.stage) });
  release(); const [result, replay] = await Promise.all([first, second]);
  assert.deepEqual(replay, result); assert.equal(llm.calls.length, 2); assert.equal(f.fetchCount, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'session').length, 1); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 1);
  assert.deepEqual(stages, [['fetching', 'creating', 'naming', 'opening', 'ready'], ['ready']]);
});

test('settings changed during naming retain generated result and initial branch, without session or rename', async t => {
  let f; const llm = namingLlm({ onPrepare() { f.settings.set(f.actor.id, { ...f.settings.get(f.actor.id), hash: 'changed-during-naming' }); } });
  f = await fixture(t, { agentCapabilities: { llm } }); const request = { ...f.request(), firstPrompt: 'Retain exact generated result' };
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('SETTINGS_CHANGED'));
  const operation = f.store.operations.get(request.operationId), record = f.store.worktrees.get(operation.worktreeId);
  assert.equal(operation.phase, 'recovery-required'); assert.equal(record.branch, `worktree/${record.id}`);
  assert.deepEqual(record.naming, operation.generatedName); assert.equal(operation.generatedName.source, 'model');
  assert.equal(f.calls.filter(([kind]) => kind === 'rename' || kind === 'session').length, 0);
  await assert.rejects(f.controller.execute(request, f.invocation), errorCode('RECOVERY_REQUIRED'));
  assert.equal(llm.calls.length, 2); assert.equal(f.fetchCount, 1);
});

test('explicit continue tool create remains honored after naming without any source prompt admission', async t => {
  const llm = namingLlm(), f = await fixture(t, { agentCapabilities: { llm } });
  const result = await f.controller.execute({ ...f.request(), firstPrompt: 'Continue existing task', sessionMode: 'continue' }, { ...f.invocation, origin: 'tool' });
  assert.equal(result.operation.sessionMode, 'continue'); assert.equal(f.calls.find(([kind]) => kind === 'session')[1].mode, 'continue');
  assert.equal(result.worktree.firstMessageNaming, undefined); assert.deepEqual(f.actor.session.ownEvents(), []);
  assert.equal(result.worktree.branch, result.operation.generatedName.branch);
});

function projectFixture() {
  let selection; let controller; const bindings = [], imported = [];
  const projects = {
    folderForPath: path => selection?.path === path ? structuredClone(selection) : undefined,
    resolveFolder(projectId, folderId) { if (!selection || selection.projectId !== projectId || selection.folderId !== folderId) throw new WorktreeError('PROJECT_FOLDER_NOT_FOUND', 'Folder changed'); return { id: folderId, path: selection.path, title: 'Project folder' }; },
    selectionForWorktree(id) { const record = controller?.records().find(value => value.id === id); return record && selection ? structuredClone(selection) : undefined; },
    async ensureFolder(path) { imported.push(path); if (!selection) selection = { projectId: randomUUID(), folderId: randomUUID(), path }; return structuredClone(selection); },
    bindingFor(id, cwd) { return bindings.find(value => value.sessionId === id && (cwd === undefined || value.effectiveCwd === cwd)); },
    async recordThread(binding) { bindings.push(structuredClone(binding)); },
  };
  return { projects, bindings, imported, attach(f) { controller = f.controller; selection = { projectId: randomUUID(), folderId: randomUUID(), path: resolve(f.repo, 'project') }; return structuredClone(selection); }, move() { selection = { ...selection, projectId: randomUUID() }; return structuredClone(selection); } };
}

test('project-aware status preserves canonical execution subdirectory and creates exact project receipts', async t => {
  const p = projectFixture(), f = await fixture(t, { projects: p.projects }), selected = p.attach(f);
  const status = await f.controller.execute({ action: 'status' }, f.invocation);
  assert.equal(status.projectPath, selected.path); assert.equal(status.repository.projectSubdir, 'project');
  const result = await f.controller.execute({ ...f.request(), projectId: selected.projectId, folderId: selected.folderId }, f.invocation);
  assert.equal(result.worktree.projectId, selected.projectId); assert.equal(result.worktree.folderId, selected.folderId);
  assert.deepEqual(p.bindings[0], { sessionId: result.sessionId, projectId: selected.projectId, folderId: selected.folderId, effectiveCwd: result.worktree.effectiveCwd, mode: 'worktree', worktreeId: result.worktree.id });
  assert.equal(p.bindings[0].effectiveCwd.endsWith('/project'), true);
  assert.equal(worktreeDomain.tables.worktrees.valueSchema.safeParse(result.worktree).success, true);
});

test('mismatched project folder and unpaired IDs refuse before checkout effects', async t => {
  const p = projectFixture(), f = await fixture(t, { projects: p.projects }), selected = p.attach(f);
  await assert.rejects(f.controller.execute({ ...f.request(), repoPath: f.repo, projectId: selected.projectId, folderId: selected.folderId }, f.invocation), errorCode('PROJECT_PATH_MISMATCH'));
  await assert.rejects(f.controller.execute({ ...f.request(), projectId: selected.projectId }, f.invocation), errorCode('INVALID_REQUEST'));
  await assert.rejects(f.controller.execute({ action: 'status', projectId: selected.projectId, folderId: selected.folderId }, f.invocation), errorCode('INVALID_REQUEST'));
  assert.equal(f.fetchCount, 0); assert.equal(f.store.operations.map.size, 0);
});

test('managed-source generations keep original Local project and survive imported-project adoption', async t => {
  const p = projectFixture(), f = await fixture(t, { projects: p.projects }), selected = p.attach(f);
  const first = await f.controller.execute(f.request(), f.invocation);
  const second = await f.controller.execute({ ...f.request(), requireBlankSource: false }, { ...f.invocation, agent: f.agents.get(first.sessionId) });
  const third = await f.controller.execute({ ...f.request(), requireBlankSource: false }, { ...f.invocation, agent: f.agents.get(second.sessionId) });
  for (const result of [first, second, third]) { assert.equal(result.worktree.repoRoot, f.repo); assert.equal(result.worktree.projectSubdir, 'project'); assert.equal(result.worktree.projectId, selected.projectId); }
  const current = p.move();
  const started = await f.controller.execute({ action: 'start', id: third.worktree.id, sessionMode: 'new' }, f.invocation);
  assert.equal(p.bindings.at(-1).sessionId, started.sessionId); assert.equal(p.bindings.at(-1).projectId, current.projectId); assert.equal(p.bindings.at(-1).mode, 'worktree');
  assert.equal(f.fetchCount, 3); assert.equal(p.imported.length, 0);
});

test('Local handoff binds target project before publication and never marks it as source worktree', async t => {
  const p = projectFixture(), f = await fixture(t, { projects: p.projects }), selected = p.attach(f);
  const created = await f.controller.execute(f.request(), f.invocation);
  const preview = await f.controller.execute({ action: 'preview', id: created.worktree.id }, f.invocation);
  const result = await f.controller.execute({ action: 'handoff', id: created.worktree.id, previewId: preview.id, operationId: randomUUID() }, f.invocation);
  assert.deepEqual(p.bindings.at(-1), { sessionId: result.sessionId, projectId: selected.projectId, folderId: selected.folderId, effectiveCwd: selected.path, mode: 'local' });
  assert.ok(p.imported.includes(selected.path)); assert.equal(f.applyCount, 1);
  const another = await f.controller.execute(f.request(), f.invocation);
  await assert.rejects(f.controller.execute({ action: 'preview', id: created.worktree.id, targetPath: another.worktree.effectiveCwd }, f.invocation), errorCode('INVALID_TARGET'));
});

const userMessage = (text, source = { kind: 'user' }) => ({ role: 'user', id: randomUUID(), source, content: [{ type: 'text', text }] });
const message = (agent, text, source, intent = { surfaceOp: 'append' }) => agent.session.append('user/message', userMessage(text, source), intent);
const endTurn = agent => agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
const lifetime = () => new AbortController().signal;
function namingPhase(f, id, phase) {
  if (f.store.worktrees.get(id).firstMessageNaming?.phase === phase) return Promise.resolve();
  return new Promise(resolve => { const stop = f.store.worktrees.observe((key, row) => { if (key === id && row.firstMessageNaming?.phase === phase) { stop(); resolve(); } }); });
}

test('own first authored committed message alone names branch once after turn end and true idle', async t => {
  const llm = namingLlm(); const p = projectFixture();
  const f = await fixture(t, { agentCapabilities: { llm }, projects: p.projects }); p.attach(f);
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  const original = structuredClone(created.worktree), binding = structuredClone(p.bindings[0]);
  message(child, 'Inherited'); child.inheritedEventCount = child.session.ownEvents().length;
  const namer = new FirstMessageNamer(f.ctx, f.controller); namer.attach(child, 'resume'); t.after(() => namer.close());
  message(child, 'Injected', { kind: 'system-prompt' });
  message(child, 'Replacement', undefined, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } });
  message(child, 'Replay append', undefined, { surfaceOp: 'append', sourceEventSeqs: [0] });
  child.status = 'running'; let idle; child.idleGate = new Promise(resolve => { idle = resolve; });
  const first = message(child, 'Add search filters to records');
  message(child, 'Do not name from this later prompt');
  await namingPhase(f, id, 'generated');
  assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 0);
  assert.equal(llm.calls.length, 2); assert.equal(llm.calls[1][1].sessionId, child.id);
  assert.equal(JSON.parse(llm.calls[1][1].messages[0].content[0].text).task, first.data.content[0].text);
  assert.equal(f.store.worktrees.get(id).firstMessageNaming.messageSeq, first.seq);
  assert.equal(f.calls.find(([kind]) => kind === 'flush')[1], child.session);
  endTurn(child); await Promise.resolve(); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 0);
  child.status = 'idle'; idle(); await namingPhase(f, id, 'complete');
  const renamed = f.store.worktrees.get(id);
  assert.equal(renamed.branch, `worktree/search-filters-${id.slice(0, 8)}`);
  for (const field of ['checkoutRoot', 'effectiveCwd', 'baseOid', 'baseRef', 'workspaceId', 'projectId', 'folderId', 'sessionIds']) assert.deepEqual(renamed[field], original[field]);
  assert.equal(child.session.header.cwd, original.effectiveCwd); assert.deepEqual(p.bindings[0], binding);
  assert.deepEqual(f.calls.find(([kind]) => kind === 'workspace-title').slice(1), [original.workspaceId, 'Add search filters']);
  message(child, 'Later message'); endTurn(child); await namer.close();
  assert.equal(llm.calls.length, 2); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 1);
  assert.equal(child.session.ownEvents().some(event => event.type === 'command/result'), false);
});

test('branch naming preserves a manually edited native Workspace title', async t => {
  const options = { agentCapabilities: { llm: namingLlm() } }; const f = await fixture(t, options);
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  await f.controller.prepareFirstMessageName(id, child, message(child, 'Task'), lifetime());
  options.workspaceTitle = 'My manually chosen workspace title';
  await f.controller.finishFirstMessageName(id, child, lifetime());
  const row = f.store.worktrees.get(id);
  assert.equal(row.firstMessageNaming.phase, 'complete'); assert.equal(row.branch, row.naming.branch);
  assert.equal(f.ctx.get('workspaceRegistry').get(row.workspaceId).title, options.workspaceTitle);
  assert.equal(f.calls.filter(([kind]) => kind === 'workspace-title').length, 0);
});

for (const [name, configure, expected] of [
  ['manually switched branch', options => { options.actualBranch = 'feature/manual'; }, 'BRANCH_CHANGED'],
  ['collision', options => { options.renameBranch = () => { throw new WorktreeError('BRANCH_EXISTS', 'exists'); }; }, 'BRANCH_EXISTS'],
  ['protected row', async (_options, f, id) => { await f.controller.execute({ action: 'protect', id, protected: true }, f.invocation); }, 'PROTECTED'],
  ['archived row', async (_options, f, id) => { await f.controller.execute({ action: 'archive', id }, f.invocation); }, 'ARCHIVED'],
  ['receiving permission downgraded', (_options, f, _id, child) => { f.policy.set(child.id, 'read-only'); }, 'FULL_ACCESS_REQUIRED'],
  ['receiving pending plan mode', (_options, f, _id, child) => { f.plans.set(child.id, { active: false, pending: true }); }, 'PLAN_MODE'],
]) test(`post-message naming skips ${name}, never overriding it`, async t => {
  const options = { agentCapabilities: { llm: namingLlm() } }; const f = await fixture(t, options);
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  const first = message(child, 'Add search filters'); await f.controller.prepareFirstMessageName(id, child, first, lifetime());
  await configure(options, f, id, child);
  await assert.rejects(f.controller.finishFirstMessageName(id, child, lifetime()), errorCode(expected));
  assert.equal(f.store.worktrees.get(id).firstMessageNaming.phase, 'skipped');
  assert.equal(f.store.worktrees.get(id).firstMessageNaming.reason, expected);
  assert.equal(f.store.worktrees.get(id).branch, created.worktree.branch);
  assert.equal(await realpath(created.worktree.checkoutRoot), created.worktree.checkoutRoot);
});

for (const flush of [async () => false, async () => { throw new WorktreeError('FLUSH_FAILED', 'failed'); }]) test('first-message durability failure prevents inference and Git mutation', async t => {
  const llm = namingLlm(); const f = await fixture(t, { agentCapabilities: { llm }, flush });
  const created = await f.controller.execute(f.request(), f.invocation), child = f.agents.get(created.sessionId);
  await assert.rejects(f.controller.prepareFirstMessageName(created.worktree.id, child, message(child, 'Name task'), lifetime()));
  assert.equal(llm.calls.length, 0); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 0);
  assert.equal(f.store.worktrees.get(created.worktree.id).firstMessageNaming.phase, 'waiting');
});

test('durability is re-established at maintenance before mutation, exact result survives failure', async t => {
  const options = { agentCapabilities: { llm: namingLlm() } }; const f = await fixture(t, options);
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  await f.controller.prepareFirstMessageName(id, child, message(child, 'Task'), lifetime());
  options.flush = async () => false;
  await assert.rejects(f.controller.finishFirstMessageName(id, child, lifetime()), errorCode('MISSING_DURABILITY_BARRIER'));
  assert.equal(f.store.worktrees.get(id).firstMessageNaming.phase, 'generated'); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 0);
  delete options.flush; await f.controller.finishFirstMessageName(id, child, lifetime());
  assert.equal(options.agentCapabilities.llm.calls.length, 2);
});

for (const mode of ['disabled', 'timeout', 'invalid']) test(`post-message ${mode} fallback is persisted and used without retries`, async t => {
  const llm = namingLlm(mode === 'timeout' ? { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) } : mode === 'invalid' ? { output: 'invalid output' } : {});
  const f = await fixture(t, { agentCapabilities: { llm }, config: { namingEnabled: mode !== 'disabled', namingTimeoutMs: 100 } });
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  await f.controller.prepareFirstMessageName(id, child, message(child, 'Repair API routes'), lifetime());
  const generated = f.store.worktrees.get(id).firstMessageNaming.generatedName;
  assert.equal(generated.source, 'fallback'); assert.equal(generated.fallbackReason, mode === 'invalid' ? 'invalid-output' : mode);
  await f.controller.finishFirstMessageName(id, child, lifetime());
  assert.deepEqual(f.store.worktrees.get(id).naming, generated); assert.equal(llm.calls.length, mode === 'disabled' ? 0 : 2);
});

for (const phase of ['generated', 'renaming']) test(`resume reuses ${phase} durable exact result without duplicate inference or rename`, async t => {
  const llm = namingLlm(); const options = { agentCapabilities: { llm } }; const f = await fixture(t, options);
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  const first = message(child, 'Task'); endTurn(child);
  await f.controller.prepareFirstMessageName(id, child, first, lifetime());
  const row = f.store.worktrees.get(id); await f.store.worktrees.put(id, { ...row, firstMessageNaming: { ...row.firstMessageNaming, phase } });
  if (phase === 'renaming') options.actualBranch = row.firstMessageNaming.generatedName.branch;
  const resumed = new FirstMessageNamer(f.ctx, f.controller); resumed.attach(child, 'resume'); await namingPhase(f, id, 'complete'); await resumed.close();
  assert.equal(llm.calls.length, 2); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, phase === 'generated' ? 1 : 0);
  const duplicate = new FirstMessageNamer(f.ctx, f.controller); duplicate.attach(child, 'resume'); await duplicate.close(); assert.equal(llm.calls.length, 2);
});

test('restart recovers committed first user before receipt, never uses a later prompt', async t => {
  const llm = namingLlm(); const f = await fixture(t, { agentCapabilities: { llm } });
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  message(child, 'Actual first task'); message(child, 'Later task'); endTurn(child);
  const resumed = new FirstMessageNamer(f.ctx, f.controller); resumed.attach(child, 'resume'); await namingPhase(f, id, 'complete'); await resumed.close();
  assert.equal(JSON.parse(llm.calls[1][1].messages[0].content[0].text).task, 'Actual first task');
});

test('interrupted inference is recovered with logged deterministic fallback, not another paid call', async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const llm = namingLlm({ stream: () => { entered(); return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }; } });
  const f = await fixture(t, { agentCapabilities: { llm } });
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId), abort = new AbortController();
  const first = message(child, 'Recover exact task'); endTurn(child);
  const pending = f.controller.prepareFirstMessageName(id, child, first, abort.signal); await ready; abort.abort(); await assert.rejects(pending, errorCode('CANCELLED'));
  assert.equal(f.store.worktrees.get(id).firstMessageNaming.phase, 'generating');
  const resumed = new FirstMessageNamer(f.ctx, f.controller); resumed.attach(child, 'resume'); await namingPhase(f, id, 'complete'); await resumed.close();
  assert.equal(llm.calls.length, 2); assert.equal(f.store.worktrees.get(id).naming.fallbackReason, 'provider-failure');
  assert.match(f.store.worktrees.get(id).branch, /^worktree\/recover-exact-task-/u);
});

for (const close of ['plugin', 'agent', 'registry']) test(`${close} disposal aborts/drains background naming without Git mutation`, async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const llm = namingLlm({ stream: () => { entered(); return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }; } });
  const f = await fixture(t, { observe: true, agentCapabilities: { llm } });
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  message(child, 'Task'); await ready;
  if (close === 'agent') child.disposeEffects();
  if (close === 'registry') { f.agents.delete(child.id); for (const callback of f.listeners.get('agent/disposed') ?? []) callback({ agent: child }); }
  await f.namer.close(); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 0);
  assert.equal(llm.calls[1][1].signal.aborted, true); assert.equal(f.store.worktrees.get(id).firstMessageNaming.phase, 'generating');
});

test('controller close drains direct background inference, authority never falls back to creator', async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const llm = namingLlm({ stream: () => { entered(); return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }; } });
  const f = await fixture(t, { agentCapabilities: { llm } });
  const created = await f.controller.execute(f.request(), f.invocation), child = f.agents.get(created.sessionId);
  const pending = f.controller.prepareFirstMessageName(created.worktree.id, child, message(child, 'Task'), lifetime()); const failed = assert.rejects(pending, errorCode('CANCELLED'));
  await ready; await f.controller.close(); await failed;
  assert.equal(llm.calls[1][1].signal.aborted, true); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 0);
});

test('duplicate committed notifications and simultaneous prepare reuse one inference', async t => {
  let entered, release; const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const llm = namingLlm({ onPrepare: async () => { entered(); await gate; } }); const f = await fixture(t, { observe: true, agentCapabilities: { llm } });
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId), first = message(child, 'Original task');
  await ready;
  for (const listener of f.listeners.get('session/event')) listener(child.session, first);
  const duplicate = f.controller.prepareFirstMessageName(id, child, first, lifetime());
  message(child, 'Later task'); endTurn(child); release(); await duplicate; await namingPhase(f, id, 'complete'); await f.namer.close();
  assert.equal(llm.calls.length, 2); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 1);
});

test('idle claim race waits for real later activity without renaming from its prompt', async t => {
  const llm = namingLlm(); const f = await fixture(t, { observe: true, agentCapabilities: { llm } });
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  let lost, settle; const losing = new Promise(resolve => { lost = resolve; }), activity = new Promise(resolve => { settle = resolve; });
  const run = child.runMaintenance.bind(child); let claims = 0;
  child.runMaintenance = task => { if (claims++ === 0) { child.status = 'running'; child.idleGate = activity; lost(); throw Error('waking input won'); } return run(task); };
  message(child, 'Original task'); endTurn(child); await losing;
  assert.equal(f.store.worktrees.get(id).firstMessageNaming.phase, 'generated'); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 0);
  message(child, 'Later task must not change generated name'); child.status = 'idle'; settle(); await namingPhase(f, id, 'complete'); await f.namer.close();
  assert.equal(llm.calls.length, 2); assert.equal(JSON.parse(llm.calls[1][1].messages[0].content[0].text).task, 'Original task');
});

test('receiving authority revoked during inference stops it without borrowing creator permissions', async t => {
  let f, child; const llm = namingLlm({ onPrepare() {
    assert.equal(f.store.worktrees.entries().next().value[1].firstMessageNaming.phase, 'generating');
    assert.ok(f.calls.some(([kind, session]) => kind === 'flush' && session === child.session));
    f.policy.set(child.id, 'read-only');
  } });
  f = await fixture(t, { agentCapabilities: { llm } }); const created = await f.controller.execute(f.request(), f.invocation); child = f.agents.get(created.sessionId);
  await assert.rejects(f.controller.prepareFirstMessageName(created.worktree.id, child, message(child, 'Task'), lifetime()), errorCode('FULL_ACCESS_REQUIRED'));
  assert.equal(llm.calls.length, 1); assert.equal(f.policy.get(f.actor.id), undefined); assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 0);
  assert.equal(f.store.worktrees.get(created.worktree.id).firstMessageNaming.phase, 'skipped');
});

test('uncommitted/fabricated message is refused before inference and mutation', async t => {
  const llm = namingLlm(); const f = await fixture(t, { agentCapabilities: { llm } });
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  const first = message(child, 'Original task');
  await assert.rejects(f.controller.prepareFirstMessageName(id, child, { ...first, data: userMessage('Fabricated') }, lifetime()), errorCode('MESSAGE_CHANGED'));
  assert.equal(llm.calls.length, 0); assert.equal(f.store.worktrees.get(id).firstMessageNaming.phase, 'skipped');
});

test('changed first-message identity prevents a pending rename even after successful inference', async t => {
  const llm = namingLlm(); const f = await fixture(t, { agentCapabilities: { llm } });
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId), first = message(child, 'Original task');
  await f.controller.prepareFirstMessageName(id, child, first, lifetime());
  child.session.eventAt = seq => seq === first.seq ? { ...first, data: userMessage('Replacement') } : undefined;
  await assert.rejects(f.controller.finishFirstMessageName(id, child, lifetime()), errorCode('MESSAGE_CHANGED'));
  assert.equal(f.calls.filter(([kind]) => kind === 'rename').length, 0); assert.equal(llm.calls.length, 2);
});

test('subagents and compact/clear replacement lifecycle cannot claim the naming opportunity', async t => {
  const llm = namingLlm(); const f = await fixture(t, { agentCapabilities: { llm } });
  const created = await f.controller.execute(f.request(), f.invocation), id = created.worktree.id, child = f.agents.get(created.sessionId);
  child.session.header.origin = 'subagent'; const namer = new FirstMessageNamer(f.ctx, f.controller); namer.attach(child); message(child, 'Subagent'); await namer.close(); assert.equal(llm.calls.length, 0);
  delete child.session.header.origin; const replaced = new FirstMessageNamer(f.ctx, f.controller); replaced.attach(child, 'compact'); await namingPhase(f, id, 'skipped'); await replaced.close(); assert.equal(llm.calls.length, 0);
});
