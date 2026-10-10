import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { createScope } from '@deepseek-ai/dsh-scope';
import { registerProjectRpc, PROJECT_RPC_ENDPOINT } from '../dist/project-rpc.js';
import { WorktreeError } from '../dist/errors.js';

// Direct endpoint-handler seam only; the real SDK exact Fetch registry and
// singleton gateway interceptor are exercised separately by integration tests.
// Do not serialize malformed JS values and accidentally make them valid JSON.
function directRpcRegistry(operator) {
  const entries = new Set(); let unregisters = 0;
  return { operator, registerRoute(owner, endpoint, handler) {
    assert.ok(owner instanceof Context); assert.equal(endpoint, PROJECT_RPC_ENDPOINT);
    const entry = { endpoint, handler }; entries.add(entry); let disposal;
    return () => disposal ??= (async () => { unregisters++; entries.delete(entry); })();
  },
    dispatch(payload, { peer = operator, signal = new AbortController().signal, endpoint = PROJECT_RPC_ENDPOINT } = {}) {
      const entry = [...entries].find(value => value.endpoint === endpoint);
      return entry ? entry.handler(endpoint, payload, signal, peer) : Promise.resolve({ ok: false, error: { code: 'FALLBACK', message: 'Shared API retains this endpoint.', details: {} } });
    }, get size() { return entries.size; }, get unregisters() { return unregisters; },
  };
}
async function fixture(t) {
  const host = new Context(); new SessionStore(host); const rows = []; const lookups = []; const invocations = [];
  host.on('session/event', (_session, event) => rows.push(event));
  const scope = createScope(host, {}); const actor = { id: SessionId(randomUUID()), ctx: scope.ctx, inbox: { nextTurn: [], nextStep: [] } };
  actor.session = scope.ctx.sessions.create(actor.id, { meta: { cwd: '/ordinary/project' } });
  const operator = { id: 'operator', ctx: host, async dispose() {} }; const rpc = directRpcRegistry(operator); host.provide('connection', rpc);
  const resolver = { async resolveAgent(id) { lookups.push(id); return id === actor.id ? { agent: actor } : { error: { code: 'session/not-found', message: 'private diagnostics', details: { secret: 'hidden' } } }; } }; host.provide('sessionController', resolver);
  const snapshot = { projects: [], bindings: [] }; const controller = { async execute(request, invocation) { invocations.push({ request, invocation }); return snapshot; } };
  const owner = createScope(host, {}); const stop = registerProjectRpc(owner.ctx, controller, rpc.registerRoute);
  t.after(async () => { await stop(); await owner.dispose(); await scope.dispose(); });
  return { host, actor, operator, connection: rpc, resolver, controller, owner, stop, rows, lookups, invocations, snapshot };
}
const outer = (result, code) => { assert.equal(result.ok, false); assert.equal(result.error.code, code); assert.deepEqual(result.error.details, {}); };
const inner = (result, code) => { assert.equal(result.ok, true); assert.equal(result.value.v, 1); assert.equal(result.value.ok, false); assert.equal(result.value.error.code, code); };
const payload = request => ({ v: 1, request });

test('quiet authenticated empty-GUI metadata uses exact shared controller without Actor activation or event rows', async t => {
  const f = await fixture(t);
  const actions = [{ action: 'list' }, { action: 'create', id: randomUUID(), title: 'Project', folders: ['/existing/project'] }, { action: 'update', projectId: randomUUID(), title: 'Rename' }, { action: 'start', operationId: randomUUID(), projectId: randomUUID(), folderId: 'native-folder' }];
  for (const request of actions) assert.deepEqual(await f.connection.dispatch(payload(request)), { ok: true, value: { v: 1, ok: true, data: f.snapshot } });
  assert.equal(f.lookups.length, 0); assert.equal(f.invocations.length, actions.length); assert.ok(f.invocations.every(value => value.invocation.agent === undefined && value.invocation.origin === 'ui'));
  assert.equal(f.rows.length, 0); assert.deepEqual(f.actor.inbox, { nextTurn: [], nextStep: [] });
  outer(await f.connection.dispatch({}, { endpoint: 'session/list' }), 'FALLBACK'); outer(await f.connection.dispatch({}, { endpoint: `${PROJECT_RPC_ENDPOINT}/other` }), 'FALLBACK');
});

test('provided actor resolves exact Session identity while omission works without resolver service', async t => {
  const f = await fixture(t); const request = { action: 'bind', projectId: randomUUID(), folderId: 'native-folder', sessionId: f.actor.id };
  const result = await f.connection.dispatch({ ...payload(request), actorId: f.actor.id }); assert.equal(result.value.ok, true); assert.equal(f.invocations[0].invocation.agent, f.actor); assert.deepEqual(f.lookups, [f.actor.id]);
  outer(await f.connection.dispatch(payload(request)), 'INVALID_RPC_REQUEST');
  outer(await f.connection.dispatch({ ...payload({ action: 'list' }), actorId: 'absent' }), 'session/not-found'); assert.ok(!JSON.stringify(result).includes('private'));
  f.resolver.resolveAgent = async () => ({ agent: { ...f.actor, id: 'different' } }); outer(await f.connection.dispatch({ ...payload({ action: 'list' }), actorId: f.actor.id }), 'SESSION_CHANGED');
});

test('wrong operator id or forged context is refused before parsing or resolving any Actor', async t => {
  const f = await fixture(t); let accessed = false; const invalid = {}; Object.defineProperty(invalid, 'v', { enumerable: true, get() { accessed = true; return 1; } });
  outer(await f.connection.dispatch(invalid, { peer: { ...f.operator, id: 'foreign' } }), 'FORBIDDEN');
  outer(await f.connection.dispatch(invalid, { peer: { ...f.operator, ctx: f.host.isolate('anything') } }), 'FORBIDDEN');
  assert.equal(accessed, false); assert.equal(f.lookups.length, 0); assert.equal(f.invocations.length, 0); assert.equal(f.rows.length, 0);
});

test('strict bounded lossless payloads reject accessors, cycles, prototype values and authority injection before actor resolution', async t => {
  const f = await fixture(t); const valid = { ...payload({ action: 'list' }), actorId: f.actor.id }; let accessed = false;
  const accessor = { ...valid }; Object.defineProperty(accessor, 'extra', { enumerable: true, get() { accessed = true; return 'full'; } }); const cycle = { ...valid }; cycle.cycle = cycle;
  const invalid = [null, [], {}, { ...valid, v: 2 }, { ...valid, actorId: '' }, { ...valid, actorId: 'x'.repeat(257) }, { ...valid, actorId: 'line\nfeed' },
    ...['permissions', 'actor', 'origin', 'fullAccess', 'settings'].map(key => ({ ...valid, [key]: true })),
    ...[{ action: 'list', actorId: f.actor.id }, { action: 'list', folders: [] }, { action: 'create', id: randomUUID(), title: 'X', folders: ['relative'] }, { action: 'update', projectId: randomUUID() }, { action: 'bind', projectId: randomUUID(), folderId: 'folder', sessionId: 'thread', mode: 'worktree' }].map(request => ({ ...valid, request })),
    { ...valid, request: undefined }, { ...valid, extra: NaN }, { ...valid, extra: -0 }, { ...valid, extra: 1n }, { ...valid, request: new Date() }, { ...valid, request: Object.create({ action: 'list' }) }, { ...valid, request: { toJSON() { return { action: 'list' }; } } }, { ...valid, request: { action: 'list', text: 'x'.repeat(1048577) } }, accessor, cycle,
  ];
  for (const request of invalid) outer(await f.connection.dispatch(request), 'INVALID_RPC_REQUEST');
  assert.equal(accessed, false); assert.equal(f.lookups.length, 0); assert.equal(f.invocations.length, 0); assert.equal(f.rows.length, 0);
});

test('controller denial remains an inner failure and raw resolver/provider errors never expose details', async t => {
  const f = await fixture(t); const request = { ...payload({ action: 'list' }), actorId: f.actor.id };
  f.resolver.resolveAgent = async () => { throw Error('secret resolver token'); }; const resolution = await f.connection.dispatch(request); outer(resolution, 'SESSION_RESOLUTION_FAILED'); assert.ok(!JSON.stringify(resolution).includes('secret'));
  f.resolver.resolveAgent = async () => ({ agent: f.actor });
  f.controller.execute = async () => { throw Error('raw GIT_TOKEN=secret'); }; const raw = await f.connection.dispatch(request); inner(raw, 'OPERATION_FAILED'); assert.ok(!JSON.stringify(raw).includes('secret'));
  f.controller.execute = async () => { throw new WorktreeError('FULL_ACCESS_REQUIRED', 'Caller lacks full access.', { secret: 'hidden' }); }; inner(await f.connection.dispatch(request), 'FULL_ACCESS_REQUIRED');
  f.controller.execute = async () => { throw new WorktreeError('SETTINGS_CHANGED', ['Changed Authorization: Bearer hidden ', 'https://', 'user:', 'password', '@host/?token=hidden'].join('').repeat(500), { secret: 'hidden' }); };
  const redacted = await f.connection.dispatch(request); inner(redacted, 'SETTINGS_CHANGED'); assert.ok(redacted.value.error.message.length <= 4096); assert.ok(!JSON.stringify(redacted).includes('hidden')); assert.equal(redacted.value.error.details, undefined); assert.equal(f.rows.length, 0);
});

test('response cap is exactly 1MiB and snapshots reject non-JSON without coercion', async t => {
  const f = await fixture(t); const request = payload({ action: 'list' }); const overhead = Buffer.byteLength(JSON.stringify({ v: 1, ok: true, data: { text: '' } }));
  f.controller.execute = async () => ({ text: 'x'.repeat(1048576 - overhead) }); const boundary = await f.connection.dispatch(request); assert.equal(boundary.value.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(boundary.value)), 1048576);
  f.controller.execute = async () => ({ text: 'x'.repeat(1048577 - overhead) }); inner(await f.connection.dispatch(request), 'RESPONSE_LIMIT');
  for (const value of [{ invalid: undefined }, { invalid: Infinity }, { invalid: 1n }, new Date(), { toJSON() { return 'coerced'; } }]) { f.controller.execute = async () => value; inner(await f.connection.dispatch(request), 'RESPONSE_LIMIT'); }
  f.controller.execute = async () => f.snapshot; const detached = await f.connection.dispatch(request); assert.notEqual(detached.value.data, f.snapshot); assert.equal(f.rows.length, 0);
});

test('teardown unregisters first, aborts and awaits pending actor resolution; repeated disposal stays idempotent', async t => {
  const f = await fixture(t); let enter; const entered = new Promise(resolve => { enter = resolve; }); let release;
  f.resolver.resolveAgent = async () => { enter(); await new Promise(resolve => { release = resolve; }); return { agent: f.actor }; };
  const flight = f.connection.dispatch({ ...payload({ action: 'list' }), actorId: f.actor.id }); await entered;
  let done = false; const closing = f.stop().then(() => { done = true; }); await Promise.resolve(); assert.equal(f.connection.size, 0); assert.equal(done, false);
  outer(await f.connection.dispatch(payload({ action: 'list' })), 'FALLBACK'); release(); outer(await flight, 'CANCELLED'); await closing; await f.stop(); assert.equal(f.connection.unregisters, 1); assert.equal(f.invocations.length, 0); assert.equal(f.rows.length, 0);
});

test('scope teardown aborts actorless execution and waits without generating messages or disposing the Actor', async t => {
  const f = await fixture(t); let enter; const entered = new Promise(resolve => { enter = resolve; }); let release; let signal;
  f.controller.execute = async (_request, invocation) => { signal = invocation.signal; enter(); await new Promise(resolve => { release = resolve; }); return {}; };
  const flight = f.connection.dispatch(payload({ action: 'list' })); await entered; let done = false; const closing = f.owner.dispose().then(() => { done = true; }); await Promise.resolve();
  assert.equal(signal.aborted, true); assert.equal(f.connection.size, 0); assert.equal(done, false); release(); inner(await flight, 'CANCELLED'); await closing;
  const stopped = f.stop(); assert.equal(f.stop(), stopped); await stopped; assert.equal(f.connection.unregisters, 1); assert.equal(f.lookups.length, 0); assert.equal(f.rows.length, 0); assert.deepEqual(f.actor.inbox, { nextTurn: [], nextStep: [] });
});
