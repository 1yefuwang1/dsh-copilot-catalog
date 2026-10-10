import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { createScope } from '@deepseek-ai/dsh-scope';
import { HostConnectionService, serverResponseSchema } from '@deepseek-ai/dsh-client-connection';
import { registerWorktreeRpc, registerWorktreeProgressRpc, WORKTREE_PREPARE_ENDPOINT as PREPARE, WORKTREE_PROGRESS_ENDPOINT as PROGRESS } from '../../dist/rpc.js';
import { registerProjectRpc } from '../../dist/project-rpc.js';
import { WorktreeError } from '../../dist/errors.js';
import { registerQuietRpcRoute } from '../../dist/quiet-rpc.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, direct = false) {
  const host = new Context(); new SessionStore(host);
  const events = []; host.on('session/event', (_session, event) => events.push(event));
  const sourceScope = createScope(host, {});
  const actor = { id: SessionId(randomUUID()), inbox: { nextTurn: [], nextStep: [] } };
  actor.session = sourceScope.ctx.sessions.create(actor.id, { meta: { cwd: '/repo/project' } });
  const connectionScope = createScope(host, {}); await connectionScope.ctx.fiber.await();
  const authority = '127.0.0.1:43131', origin = `http://${authority}`, cookie = 'test-browser=synthetic';
  new HostConnectionService(connectionScope.ctx, [], { isAuthenticated: request => request.headers.get('cookie') === cookie && request.headers.get('host') === authority });
  const connection = host.get('connection');
  // Mount the actual native gateway FIRST: plugin routes must never shadow it.
  const gatewayScope = createScope(host, {}), gatewayCalls = [];
  gatewayScope.ctx.get('connection').rpc.intercept('/api', endpoint => endpoint === 'session/prompt', async (...args) => { gatewayCalls.push(args); return { ok: true, value: { native: true } }; });
  const owner = createScope(host, {}), shared = connection.createSharedFetchHandler('/api');
  const lookups = [], calls = [], started = deferred();
  const resolver = { async resolveAgent(id) { lookups.push(id); return id === actor.id ? { agent: actor } : { error: { code: 'session/not-found', message: 'secret resolver detail', details: { secret: true } } }; } };
  host.provide('sessionController', resolver);
  const receipt = { sessionId: randomUUID(), workspaceId: randomUUID(), settingsHash: 'settings', worktree: { id: randomUUID() }, operation: { id: randomUUID() } };
  const controller = { async execute(request, invocation) { calls.push({ request, invocation }); started.resolve(); return receipt; } };
  const handlers = new Map(); let unregisters = 0;
  let progressAdmission = () => {};
  const registerRoute = direct ? (_owner, endpoint, handler) => {
    assert.ok(!handlers.has(endpoint)); handlers.set(endpoint, handler);
    return async () => { if (handlers.delete(endpoint)) unregisters++; };
  } : (owner, endpoint, handler) => registerQuietRpcRoute(owner, endpoint, (...args) => {
    if (endpoint === PROGRESS) progressAdmission();
    return handler(...args);
  });
  const stop = registerWorktreeProgressRpc(owner.ctx, controller, registerRoute);
  t.after(async () => { await stop(); await owner.dispose(); await gatewayScope.dispose(); await sourceScope.dispose(); await connectionScope.dispose(); });
  const request = (operationId = randomUUID(), overrides = {}) => ({ action: 'create', operationId, repoPath: '/repo/project', remote: 'origin', remoteIdentity: 'opaque', remoteBranch: 'main', sourceSessionId: actor.id, sessionMode: 'new', requireBlankSource: true, settingsHash: 'settings', firstPrompt: 'Fix a task without sending a conversation yet', ...overrides });
  const payload = request => ({ v: 1, actorId: actor.id, request });
  const progress = (operationId, after = 0, actorId = actor.id) => ({ v: 1, actorId, operationId, after });
  async function fetchResponse(endpoint, payload, options = {}) {
    const rpcId = randomUUID();
    const request = new Request(`${origin}/api/${endpoint}`, { method: 'POST', headers: { host: authority, origin, cookie, 'content-type': 'application/json', ...options.headers }, body: JSON.stringify({ type: 'client-request', rpcId, method: options.wireMethod ?? endpoint, payload }), ...(options.signal ? { signal: options.signal } : {}) });
    return { response: await shared.fetch(request), rpcId };
  }
  async function send(endpoint, payload, options = {}) {
    if (direct) {
      const handler = handlers.get(endpoint);
      return handler ? handler(endpoint, payload, options.signal ?? new AbortController().signal, options.peer ?? connection.operator) : { ok: false, error: { code: 'FALLBACK' } };
    }
    const { response, rpcId } = await fetchResponse(endpoint, payload, options);
    assert.equal(response.status, 200); const wire = await response.json();
    assert.equal(serverResponseSchema.safeParse(wire).success, true);
    assert.deepEqual(Object.keys(wire).sort(), ['result', 'rpcId', 'type']); assert.equal(wire.rpcId, rpcId);
    return wire.result;
  }
  return { host, actor, owner, connection, shared, stop, lookups, resolver, calls, controller, receipt, started, events, gatewayCalls, request, payload, progress, send, fetchResponse, onProgressAdmission(callback) { progressAdmission = callback; }, get unregisters() { return unregisters; } };
}
function data(reply) { assert.equal(reply.ok, true); assert.equal(reply.value.v, 1); assert.equal(reply.value.ok, true); return reply.value.data; }
function code(reply, expected) { assert.equal(reply.ok, false); assert.equal(reply.error.code, expected); assert.deepEqual(reply.error.details, {}); }
const STAGES = ['fetching', 'creating', 'naming', 'opening', 'ready'];

// Run through real Host Fetch routes, not an interceptor substitute or a fake SDK.
test('gateway-first real SDK prepare/progress coexist with execute/projects and observe phases before deferred execute finishes', async t => {
  const f = await fixture(t); const gate = deferred(), begin = deferred();
  registerWorktreeRpc(f.owner.ctx, { async execute() { return { items: [] }; } });
  registerProjectRpc(f.owner.ctx, { async execute() { return { projects: [], bindings: [], records: [] }; } });
  f.controller.execute = async (request, invocation) => { f.calls.push({ request, invocation }); begin.resolve(); await gate.promise; return f.receipt; };
  for (const endpoint of [PREPARE, PROGRESS, 'dsh-worktrees/execute', 'dsh-worktrees/projects']) assert.equal(f.shared.requestBodyMode({ method: 'POST', url: new URL(`http://127.0.0.1:43131/api/${endpoint}`) }), 'buffered');
  const request = f.request();
  let prepared = false;
  let waiting = f.send(PROGRESS, f.progress(request.operationId));
  const prepare = f.send(PREPARE, f.payload(request)).then(reply => { prepared = true; return reply; });
  await begin.promise;
  const invocation = f.calls[0].invocation;
  assert.equal(invocation.agent, f.actor); assert.equal(invocation.origin, 'ui'); assert.deepEqual(f.lookups, [f.actor.id]);
  for (let index = 0; index < STAGES.length; index++) {
    invocation.onProgress(Object.freeze({ stage: STAGES[index], operationId: request.operationId, worktreeId: f.receipt.worktree.id }));
    const observed = data(await waiting);
    assert.equal(observed.operationId, request.operationId); assert.equal(observed.revision, index + 1); assert.equal(observed.terminal, false);
    assert.deepEqual(observed.stages.map(value => value.stage), STAGES.slice(0, index + 1));
    assert.ok(observed.stages.every(value => Object.keys(value).sort().join() === 'operationId,stage,worktreeId'));
    assert.equal(prepared, false);
    waiting = f.send(PROGRESS, f.progress(request.operationId, observed.revision));
  }
  gate.resolve();
  assert.deepEqual(data(await prepare), f.receipt);
  const terminal = data(await waiting); assert.equal(terminal.terminal, true); assert.equal(terminal.revision, 6); assert.deepEqual(terminal.stages.map(value => value.stage), STAGES);
  assert.deepEqual(data(await f.send(PROGRESS, f.progress(request.operationId, 6))), terminal);
  assert.deepEqual(data(await f.send('dsh-worktrees/execute', f.payload({ action: 'list' }))), { items: [] });
  assert.deepEqual(data(await f.send('dsh-worktrees/projects', { v: 1, request: { action: 'list' } })), { projects: [], bindings: [], records: [] });
  assert.equal(f.lookups.length, 2, 'only prepare and execute resolve Agents; progress never activates an Actor');
  assert.equal(f.gatewayCalls.length, 0, 'setup did not send any native prompt');
  assert.equal(f.events.length, 0); assert.deepEqual(f.actor.inbox, { nextTurn: [], nextStep: [] });
  assert.deepEqual(await f.send('session/prompt', {}), { ok: true, value: { native: true } });
  await f.stop();
  for (const endpoint of [PREPARE, PROGRESS]) assert.equal((await f.fetchResponse(endpoint, {})).response.status, 404);
  assert.deepEqual(await f.send('session/prompt', {}), { ok: true, value: { native: true } });
});

test('fast synchronous phase transitions remain cumulative and terminal publication drains the pre-prepare waiter', async t => {
  const f = await fixture(t); const request = f.request();
  f.controller.execute = async (_request, invocation) => { for (const stage of STAGES) invocation.onProgress({ stage, operationId: request.operationId }); return f.receipt; };
  const waiting = f.send(PROGRESS, f.progress(request.operationId));
  await f.send(PREPARE, f.payload(request));
  const first = data(await waiting); assert.ok(first.revision >= 1); assert.equal(first.stages[0].stage, 'fetching');
  const all = data(await f.send(PROGRESS, f.progress(request.operationId, first.revision)));
  assert.equal(all.terminal, true); assert.equal(all.revision, 6); assert.deepEqual(all.stages.map(value => value.stage), STAGES); assert.deepEqual(f.lookups, [f.actor.id]);
});

test('simultaneous duplicate prepare shares exact receipt and Actor lookup; different request or actor is refused before execution', async t => {
  const f = await fixture(t, true); const gate = deferred(), request = f.request();
  f.controller.execute = async (request, invocation) => { f.calls.push({ request, invocation }); f.started.resolve(); await gate.promise; return f.receipt; };
  const first = f.send(PREPARE, f.payload(request)); await f.started.promise;
  const second = f.send(PREPARE, f.payload({ ...request }));
  code(await f.send(PREPARE, f.payload({ ...request, remoteBranch: 'other' })), 'OPERATION_CONFLICT');
  code(await f.send(PREPARE, { v: 1, actorId: 'other-actor', request: { ...request, sourceSessionId: 'other-actor' } }), 'FORBIDDEN');
  code(await f.send(PROGRESS, f.progress(request.operationId, 0, 'other-actor')), 'FORBIDDEN');
  assert.equal(f.calls.length, 1); assert.equal(f.lookups.length, 1); assert.ok(Object.isFrozen(f.calls[0].request));
  gate.resolve(); const a = await first, b = await second; assert.deepEqual(a, b); assert.notEqual(a.value, b.value);
  a.value.data.sessionId = 'changed-by-consumer';
  const replay = data(await f.send(PREPARE, f.payload(request))); assert.equal(replay.sessionId, f.receipt.sessionId); assert.equal(f.calls.length, 1); assert.equal(f.lookups.length, 1);
});

test('unadmitted watcher actor never reserves operation authority and is rejected when actual prepare binds another Actor', async t => {
  const f = await fixture(t, true), request = f.request();
  const forged = f.send(PROGRESS, f.progress(request.operationId, 0, 'forged-actor'));
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(data(await f.send(PREPARE, f.payload(request))), f.receipt);
  code(await forged, 'FORBIDDEN'); assert.deepEqual(f.lookups, [f.actor.id]);
});

test('strict progress/prepare payloads and forged operators fail before resolution or arbitrary property access', async t => {
  const f = await fixture(t, true), request = f.request(), valid = f.progress(request.operationId);
  let read = false; const accessor = { ...valid }; Object.defineProperty(accessor, 'after', { enumerable: true, get() { read = true; return 0; } });
  const cycle = { ...valid }; cycle.self = cycle;
  for (const bad of [null, [], {}, { ...valid, v: 2 }, { ...valid, actorId: '' }, { ...valid, actorId: 'line\nfeed' }, { ...valid, operationId: 'not-uuid' }, { ...valid, after: -1 }, { ...valid, after: -0 }, { ...valid, after: NaN }, { ...valid, after: Infinity }, { ...valid, after: 0.5 }, { ...valid, after: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, after: 1n }, { ...valid, fullAccess: true }, { ...valid, request: {} }, accessor, cycle, new Date()]) code(await f.send(PROGRESS, bad), 'INVALID_RPC_REQUEST');
  const prepare = f.payload(request);
  for (const bad of [null, {}, { ...prepare, permissions: 'full' }, f.payload({ action: 'list' }), f.payload({ ...request, firstPrompt: undefined }), f.payload({ ...request, sessionMode: 'continue' }), f.payload({ ...request, requireBlankSource: false }), f.payload({ ...request, sourceSessionId: 'foreign' }), f.payload({ ...request, operationId: 'not-uuid' }), f.payload({ ...request, firstPrompt: 'x'.repeat(1048577) })]) code(await f.send(PREPARE, bad), 'INVALID_RPC_REQUEST');
  for (const endpoint of [PREPARE, PROGRESS]) {
    code(await f.send(endpoint, accessor, { peer: { ...f.connection.operator, id: 'forged' } }), 'FORBIDDEN');
    code(await f.send(endpoint, accessor, { peer: { ...f.connection.operator, ctx: f.host } }), 'FORBIDDEN');
  }
  assert.equal(read, false); assert.deepEqual(f.lookups, []); assert.equal(f.calls.length, 0);
});

test('real Fetch authentication, correlation and exact endpoint matching apply to both new routes', async t => {
  const f = await fixture(t), request = f.request();
  for (const endpoint of [PREPARE, PROGRESS]) {
    for (const [headers, status] of [[{ cookie: '' }, 401], [{ origin: 'http://attacker.invalid' }, 403], [{ host: 'foreign.invalid' }, 403]]) assert.equal((await f.fetchResponse(endpoint, {}, { headers })).response.status, status);
    code(await f.send(endpoint, {}, { wireMethod: 'session/prompt' }), 'gateway/bad-request');
    assert.equal((await f.fetchResponse(`${endpoint}/other`, {})).response.status, 404);
  }
  assert.equal(f.lookups.length, 0); assert.equal(f.gatewayCalls.length, 0);
  const result = await f.send(PREPARE, f.payload(request)); assert.deepEqual(data(result), f.receipt);
});

test('observer enforces operation and worktree identity, bounded true-order phases, and no extra secret data', async t => {
  const f = await fixture(t, true), request = f.request();
  f.controller.execute = async (_request, invocation) => {
    for (const progress of [
      { stage: 'fetching', operationId: randomUUID() }, { stage: 'fetching', operationId: request.operationId, task: 'secret' },
      { stage: 'unknown', operationId: request.operationId }, { stage: 'fetching', operationId: request.operationId, worktreeId: 'secret' },
      { stage: 'fetching', operationId: request.operationId, worktreeId: f.receipt.worktree.id },
      { stage: 'fetching', operationId: request.operationId }, { stage: 'creating', operationId: request.operationId, worktreeId: randomUUID() },
      { stage: 'creating', operationId: request.operationId, worktreeId: f.receipt.worktree.id },
      { stage: 'fetching', operationId: request.operationId }, { stage: 'naming', operationId: request.operationId },
      { stage: 'opening', operationId: request.operationId }, { stage: 'ready', operationId: request.operationId },
    ]) invocation.onProgress(progress);
    const getter = {}; Object.defineProperty(getter, 'stage', { enumerable: true, get() { throw Error('secret getter'); } }); invocation.onProgress(getter);
    return f.receipt;
  };
  assert.deepEqual(data(await f.send(PREPARE, f.payload(request))), f.receipt);
  const observed = data(await f.send(PROGRESS, f.progress(request.operationId))); assert.equal(observed.revision, 6); assert.equal(observed.terminal, true); assert.deepEqual(observed.stages.map(value => value.stage), STAGES); assert.ok(!JSON.stringify(observed).includes('secret'));
});

test('redacted controller/resolver failures publish terminal revision even without phases', async t => {
  const f = await fixture(t, true);
  for (const mode of ['provider', 'git', 'resolver', 'missing', 'changed']) {
    const request = f.request();
    f.resolver.resolveAgent = async id => { f.lookups.push(id); if (mode === 'resolver') throw Error('secret credential'); if (mode === 'missing') return { error: { code: 'session/not-found', message: 'secret credential', details: {} } }; if (mode === 'changed') return { agent: { id: 'changed' } }; return { agent: f.actor }; };
    f.controller.execute = async () => { if (mode === 'git') throw new WorktreeError('GIT_FAILED', 'secret credential'); throw Error('secret provider diagnostic'); };
    const waiter = f.send(PROGRESS, f.progress(request.operationId));
    const prepared = await f.send(PREPARE, f.payload(request));
    assert.ok(!JSON.stringify(prepared).includes('secret'));
    if (['provider', 'git'].includes(mode)) { assert.equal(prepared.ok, true); assert.equal(prepared.value.ok, false); assert.equal(prepared.value.error.code, mode === 'git' ? 'GIT_FAILED' : 'OPERATION_FAILED'); }
    else code(prepared, mode === 'resolver' ? 'SESSION_RESOLUTION_FAILED' : mode === 'missing' ? 'session/not-found' : 'SESSION_CHANGED');
    assert.deepEqual(data(await waiter), { operationId: request.operationId, revision: 1, stages: [], terminal: true });
  }
});

test('cancellation cleans unknown and active waiters and duplicate cancellation never cancels the owning prepare', async t => {
  const f = await fixture(t, true), unknown = randomUUID(), abort = new AbortController();
  const waiter = f.send(PROGRESS, f.progress(unknown, Number.MAX_SAFE_INTEGER), { signal: abort.signal }); abort.abort(); code(await waiter, 'CANCELLED'); assert.equal(f.lookups.length, 0);
  const gate = deferred(), request = f.request();
  f.controller.execute = async (request, invocation) => { f.calls.push({ request, invocation }); f.started.resolve(); await gate.promise; return f.receipt; };
  const prepare = f.send(PREPARE, f.payload(request)); await f.started.promise;
  const duplicateAbort = new AbortController(), duplicate = f.send(PREPARE, f.payload(request), { signal: duplicateAbort.signal }); duplicateAbort.abort(); code(await duplicate, 'CANCELLED'); assert.equal(f.calls[0].invocation.signal.aborted, false);
  const activeAbort = new AbortController(), active = f.send(PROGRESS, f.progress(request.operationId), { signal: activeAbort.signal }); activeAbort.abort(); code(await active, 'CANCELLED');
  gate.resolve(); assert.deepEqual(data(await prepare), f.receipt);
  const preAborted = new AbortController(); preAborted.abort(); code(await f.send(PREPARE, f.payload(f.request()), { signal: preAborted.signal }), 'CANCELLED'); assert.equal(f.lookups.length, 1);
});

test('scope unload aborts and awaits execution plus unknown/begun waits; unregisters once and native gateway stays alive', async t => {
  const f = await fixture(t), request = f.request(), gate = deferred(), begin = deferred(); let invocation;
  f.controller.execute = async (_request, value) => { invocation = value; begin.resolve(); await gate.promise; return f.receipt; };
  const prepare = f.send(PREPARE, f.payload(request)); await begin.promise;
  let admitted = 0; const waitersAdmitted = deferred();
  f.onProgressAdmission(() => { if (++admitted === 2) waitersAdmitted.resolve(); });
  const begun = f.send(PROGRESS, f.progress(request.operationId)), unknown = f.send(PROGRESS, f.progress(randomUUID()));
  await waitersAdmitted.promise;
  let disposed = false; const disposal = f.owner.dispose().then(() => { disposed = true; });
  try {
    assert.deepEqual(await f.send('session/prompt', {}), { ok: true, value: { native: true } });
    assert.equal(invocation.signal.aborted, true); assert.equal(disposed, false);
    for (const endpoint of [PREPARE, PROGRESS]) assert.equal((await f.fetchResponse(endpoint, {})).response.status, 404);
    code(await begun, 'CANCELLED'); code(await unknown, 'CANCELLED');
  } finally { gate.resolve(); }
  const result = await prepare; assert.equal(result.ok, true); assert.equal(result.value.error.code, 'CANCELLED'); await disposal; await f.stop();
  assert.equal(f.events.length, 0); assert.deepEqual(f.actor.inbox, { nextTurn: [], nextStep: [] });
  assert.deepEqual(await f.send('session/prompt', {}), { ok: true, value: { native: true } });
});

test('bounded operation and waiter limits refuse allocation and release capacity after cancellation', async t => {
  const f = await fixture(t, true), allEntered = deferred();
  f.controller.execute = async (request, invocation) => { f.calls.push({ request, invocation }); if (f.calls.length === 64) allEntered.resolve(); await new Promise(resolve => invocation.signal.addEventListener('abort', resolve, { once: true })); throw new WorktreeError('CANCELLED', 'Cancelled'); };
  const prepares = Array.from({ length: 64 }, () => f.send(PREPARE, f.payload(f.request()))); await allEntered.promise;
  code(await f.send(PREPARE, f.payload(f.request())), 'OPERATION_LIMIT'); assert.equal(f.lookups.length, 64);
  const signals = Array.from({ length: 128 }, () => new AbortController());
  const waits = signals.map(signal => f.send(PROGRESS, f.progress(randomUUID()), { signal: signal.signal }));
  code(await f.send(PROGRESS, f.progress(randomUUID())), 'WAITER_LIMIT');
  code(await f.send(PREPARE, f.payload(f.calls[0].request)), 'WAITER_LIMIT');
  signals[0].abort(); code(await waits[0], 'CANCELLED');
  const replacementAbort = new AbortController(), replacement = f.send(PROGRESS, f.progress(randomUUID()), { signal: replacementAbort.signal }); replacementAbort.abort(); code(await replacement, 'CANCELLED');
  await f.stop(); await Promise.all([...prepares, ...waits]); assert.equal(f.unregisters, 2);
});

test('retained terminal records are bounded and late watcher receives exact history until eviction', async t => {
  const f = await fixture(t, true), requests = Array.from({ length: 129 }, () => f.request());
  for (const request of requests) await f.send(PREPARE, f.payload(request));
  assert.deepEqual(data(await f.send(PROGRESS, f.progress(requests[128].operationId))), { operationId: requests[128].operationId, revision: 1, stages: [], terminal: true });
  const abort = new AbortController(), evicted = f.send(PROGRESS, f.progress(requests[0].operationId), { signal: abort.signal }); abort.abort(); code(await evicted, 'CANCELLED');
  assert.equal(f.lookups.length, 129);
});

test('prepare receipts preserve exact 1MiB response bound on first completion and detached replay', async t => {
  const f = await fixture(t, true), request = f.request();
  const overhead = Buffer.byteLength(JSON.stringify({ v: 1, ok: true, data: { text: '' } }));
  f.controller.execute = async () => ({ text: 'x'.repeat(1048576 - overhead) });
  const first = await f.send(PREPARE, f.payload(request)); assert.equal(first.value.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(first.value)), 1048576);
  const replay = await f.send(PREPARE, f.payload(request)); assert.deepEqual(replay, first); assert.notEqual(replay.value, first.value); assert.equal(f.lookups.length, 1);
  for (const result of [{ text: 'x'.repeat(1048577 - overhead) }, new Date(), { invalid: NaN }, { toJSON() { return 'coerced'; } }]) {
    f.controller.execute = async () => result;
    const next = f.request(), prepared = await f.send(PREPARE, f.payload(next));
    assert.equal(prepared.ok, true); assert.equal(prepared.value.ok, false); assert.equal(prepared.value.error.code, 'RESPONSE_LIMIT');
    assert.equal(data(await f.send(PROGRESS, f.progress(next.operationId))).terminal, true);
  }
});

test('scope teardown awaits pending prepare Actor resolution before reporting quiescence; progress never resolves one', async t => {
  const f = await fixture(t, true), request = f.request(), entered = deferred(), gate = deferred();
  f.resolver.resolveAgent = async id => { f.lookups.push(id); entered.resolve(); await gate.promise; return { agent: f.actor }; };
  const waiter = f.send(PROGRESS, f.progress(request.operationId));
  const prepare = f.send(PREPARE, f.payload(request)); await entered.promise;
  let disposed = false; const disposal = f.stop().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(f.unregisters, 2); assert.equal(disposed, false); code(await waiter, 'CANCELLED');
  gate.resolve(); code(await prepare, 'CANCELLED'); await disposal;
  assert.deepEqual(f.lookups, [f.actor.id]); assert.equal(f.calls.length, 0); assert.equal(f.events.length, 0);
});
