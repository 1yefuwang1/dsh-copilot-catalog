import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import test, { type TestContext } from 'node:test';
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type { Invocation } from '../../dist/service.js';
import type { ProjectInvocation } from '../../dist/projects.js';
import { deferred, required, syntheticAuth, type ClientProtocol, type FetchOptions, type RpcReply } from './fixtures.js';
import { Context } from '@deepseek-ai/cordis';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { HostConnectionService, clientRequestSchema, serverResponseSchema } from '@deepseek-ai/dsh-client-connection';
import { registerQuietRpcRoute } from '../../dist/quiet-rpc.js';
import { registerWorktreeRpc, WORKTREE_RPC_ENDPOINT } from '../../dist/rpc.js';
import { registerProjectRpc, PROJECT_RPC_ENDPOINT } from '../../dist/project-rpc.js';

const AUTHORITY = '127.0.0.1:43129';
const ORIGIN = `http://${AUTHORITY}`;
const COOKIE = 'test-browser-session=synthetic-authenticated';
const BODY_LIMIT = 1048576 + 4096;
const encoder = new TextEncoder();

async function fixture(t: TestContext) {
  const host = new Context(); const connectionOwner = createScope(host, {});
  await connectionOwner.ctx.fiber.await();
  // Synthetic authentication only: the real public service still owns Host/Origin admission.
  let authCalls = 0;
  new HostConnectionService(connectionOwner.ctx, [], syntheticAuth(AUTHORITY, COOKIE, () => { authCalls++; }));
  const connection = required(host.get('connection'));
  const gatewayOwner = createScope(host, {}); const gatewayCalls: Array<{ endpoint: string; payload: unknown; signal: AbortSignal; peer: Parameters<ConnectionRpcHandler>[3] }> = [];
  required(gatewayOwner.ctx.get('connection')).rpc.intercept('/api', endpoint => endpoint === 'session/foo', async (endpoint, payload, signal, peer) => {
    gatewayCalls.push({ endpoint, payload, signal, peer }); return { ok: true, value: true };
  });
  const owner = createScope(host, {}); const shared = connection.createSharedFetchHandler('/api');
  t.after(async () => { await owner.dispose(); await gatewayOwner.dispose(); await connectionOwner.dispose(); });
  const request = (endpoint: string, payload: unknown, options: FetchOptions = {}) => {
    const rpcId = options.rpcId ?? randomUUID();
    const envelope = { type: 'client-request', rpcId, method: options.wireMethod ?? endpoint, payload };
    const body = Object.hasOwn(options, 'body') ? options.body : JSON.stringify(envelope);
    const init: RequestInit & { duplex?: 'half' } = {
      method: options.httpMethod ?? 'POST',
      headers: { host: AUTHORITY, origin: ORIGIN, cookie: COOKIE, 'content-type': 'application/json', ...options.headers },
      ...(body === undefined ? {} : { body }), ...(options.signal ? { signal: options.signal } : {}),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    };
    return new Request(`${ORIGIN}/api/${endpoint}${options.query ?? ''}`, init);
  };
  // Re-admit exactly like the carrier does: a rejected caller never reaches the route.
  const dispatch = (incoming: Request) => {
    const admitted = connection.admit(incoming);
    return 'rejection' in admitted ? new Response('rejected', { status: admitted.rejection }) : shared.fetch(incoming, admitted.peer);
  };
  const send = (endpoint: string, payload: unknown, options?: FetchOptions) => dispatch(request(endpoint, payload, options));
  return { host, owner, connection, gatewayOwner, gatewayCalls, shared, request, send, dispatch, get authCalls() { return authCalls; } };
}
async function wire(response: Response, rpcId: string): Promise<RpcReply> {
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(serverResponseSchema.safeParse(value).success, true);
  assert.deepEqual(Object.keys(value).sort(), ['result', 'rpcId', 'type']);
  assert.equal(value.type, 'server-response'); assert.equal(value.rpcId, rpcId);
  return value.result;
}
async function clientProtocol(): Promise<ClientProtocol> {
  const javascript = await readFile(new URL('../../dist/client.js', import.meta.url), 'utf8');
  const from = javascript.indexOf('    class WorktreeError extends Error');
  const to = javascript.indexOf('    function Icon(', from);
  assert.ok(from >= 0 && to > from);
  // Actual pure Client declarations only; no browser DOM, renderer or plugin mount.
  return vm.runInNewContext(`(() => { const NS='worktrees.ui', PANEL='dsh-worktrees'; ${javascript.slice(from, to)}; return {decodeReply, projectData, validateData}; })()`, { AbortController });
}

test('real SDK singleton /api gateway remains available beside exact streaming POST feature routes and after disposal', async t => {
  const f = await fixture(t); const calls: Array<{ endpoint: string; request: unknown; invocation: Invocation | ProjectInvocation }> = []; const actor = { id: 'test-source-actor' };
  f.host.provide('sessionController', { async resolveAgent(id: string) { assert.equal(id, actor.id); return { agent: actor }; } });
  const client = await clientProtocol();
  const gatewayId = randomUUID();
  assert.deepEqual(await wire(await f.send('session/foo', {}, { rpcId: gatewayId }), gatewayId), { ok: true, value: true });
  const executeStop = registerWorktreeRpc(f.owner.ctx, { async execute(request, invocation) {
    calls.push({ endpoint: WORKTREE_RPC_ENDPOINT, request, invocation }); return { items: [] };
  } });
  const projectsStop = registerProjectRpc(f.owner.ctx, { async execute(request, invocation) {
    calls.push({ endpoint: PROJECT_RPC_ENDPOINT, request, invocation }); return { projects: [], bindings: [] };
  } });
  assert.equal(scopeOf(f.connection.browserPeer.ctx), f.connection.browserPeer);
  for (const endpoint of [WORKTREE_RPC_ENDPOINT, PROJECT_RPC_ENDPOINT]) {
    assert.equal(f.shared.requestBodyMode({ method: 'POST', url: new URL(`${ORIGIN}/api/${endpoint}`) }), 'streaming');
    const rpcId = randomUUID(); const request = { action: 'list' };
    const payload = { v: 1, request, ...(endpoint === WORKTREE_RPC_ENDPOINT ? { actorId: actor.id } : {}) };
    assert.equal(clientRequestSchema.safeParse({ type: 'client-request', rpcId, method: endpoint, payload }).success, true);
    const result = await wire(await f.send(endpoint, payload, { rpcId, query: '?ignored=mount-safe' }), rpcId);
    const data = client.decodeReply(result);
    if (endpoint === PROJECT_RPC_ENDPOINT) assert.deepEqual(client.projectData(request, data), { projects: [], bindings: [] });
    else assert.deepEqual(client.validateData(request, data), { items: [] });
  }
  assert.equal(calls.length, 2); assert.equal(required(calls[0]).invocation.agent, actor); assert.equal(required(calls[1]).invocation.agent, undefined);
  assert.ok(calls.every(call => call.invocation.origin === 'ui'));
  for (const endpoint of [`${WORKTREE_RPC_ENDPOINT}/other`, `${PROJECT_RPC_ENDPOINT}/other`, 'unknown/endpoint']) {
    assert.equal((await f.send(endpoint, {})).status, 404);
  }
  for (const httpMethod of ['GET', 'HEAD']) {
    for (const endpoint of [WORKTREE_RPC_ENDPOINT, PROJECT_RPC_ENDPOINT]) assert.equal((await f.send(endpoint, undefined, { httpMethod, body: undefined })).status, 404);
  }
  const duringId = randomUUID(); assert.deepEqual(await wire(await f.send('session/foo', {}, { rpcId: duringId }), duringId), { ok: true, value: true });
  await executeStop(); await projectsStop(); await executeStop(); await projectsStop();
  for (const endpoint of [WORKTREE_RPC_ENDPOINT, PROJECT_RPC_ENDPOINT]) assert.equal((await f.send(endpoint, {})).status, 404);
  const afterId = randomUUID(); assert.deepEqual(await wire(await f.send('session/foo', {}, { rpcId: afterId }), afterId), { ok: true, value: true });
  assert.equal(f.gatewayCalls.length, 3); assert.ok(f.gatewayCalls.every(call => call.peer.id === f.connection.browserPeer.id && call.peer.ctx === f.connection.browserPeer.ctx));
});

test('exact Fetch route admission preserves real Host/Origin checks and synthetic cookie rejection before any body or handler work', async t => {
  const f = await fixture(t); let calls = 0;
  registerQuietRpcRoute(f.owner.ctx, PROJECT_RPC_ENDPOINT, async () => { calls++; return { ok: true, value: true }; });
  const bad: Array<[Record<string, string>, number]> = [
    [{ cookie: '' }, 401], [{ cookie: 'test-browser-session=wrong' }, 401],
    [{ authorization: ['Bearer', ' synthetic-query-only'].join(''), cookie: '' }, 401],
    [{ host: 'rebound.invalid:43129', origin: 'http://rebound.invalid:43129' }, 403],
    [{ origin: 'http://attacker.invalid' }, 403], [{ origin: 'http://127.0.0.1:43130' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
  ];
  for (const [headers, status] of bad) {
    let cancelled = 0;
    const body = new ReadableStream({ start(controller) { controller.close(); }, cancel() { cancelled++; } });
    const request = f.request(PROJECT_RPC_ENDPOINT, {}, { headers, body });
    const admission = f.connection.admit(request); assert.ok('rejection' in admission); assert.equal(admission.rejection, status);
    const response = await f.dispatch(request); assert.equal(response.status, status);
    assert.equal(request.bodyUsed, false); assert.equal(cancelled, 0); assert.equal(calls, 0);
  }
  const tokenOnly = await f.send(PROJECT_RPC_ENDPOINT, {}, { headers: { cookie: '' }, query: '?token=synthetic-not-a-login' });
  assert.equal(tokenOnly.status, 401);
  const rpcId = randomUUID(); assert.deepEqual(await wire(await f.send(PROJECT_RPC_ENDPOINT, {}, { rpcId }), rpcId), { ok: true, value: true });
  assert.equal(calls, 1); assert.ok(f.authCalls > 0);
});

test('actual client-request framing correlates failures and success; wrong method or malformed envelope never dispatches', async t => {
  const f = await fixture(t); const calls: Parameters<ConnectionRpcHandler>[] = [];
  registerQuietRpcRoute(f.owner.ctx, PROJECT_RPC_ENDPOINT, async (...args) => { calls.push(args); return { ok: true, value: { native: true } }; });
  for (const body of [
    { type: 'server-response', result: {}, rpcId: 'wrong-direction' },
    { type: 'client-request', rpcId: 'missing-method', payload: {} },
    { type: 'client-request', rpcId: 123, method: PROJECT_RPC_ENDPOINT, payload: {} },
    { type: 'client-request', rpcId: '', method: PROJECT_RPC_ENDPOINT, payload: {} },
  ]) {
    const id = typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request';
    const result = await wire(await f.send(PROJECT_RPC_ENDPOINT, {}, { body: JSON.stringify(body) }), id);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'gateway/bad-request'); assert.deepEqual(result.error.details, {});
  }
  const mismatchId = randomUUID();
  const mismatch = await wire(await f.send(PROJECT_RPC_ENDPOINT, {}, { rpcId: mismatchId, wireMethod: WORKTREE_RPC_ENDPOINT }), mismatchId);
  assert.equal(mismatch.error.code, 'gateway/bad-request'); assert.equal(calls.length, 0);
  assert.equal((await f.send(PROJECT_RPC_ENDPOINT, {}, { body: '{malformed-json' })).status, 400);
  // A replacement-character decoder must not repair invalid UTF-8 into valid JSON.
  const invalidUtf8 = new Uint8Array([...encoder.encode('{"type":"client-request","rpcId":"utf8","method":"dsh-worktrees/projects","payload":"'), 0xff, ...encoder.encode('"}')]);
  assert.equal((await f.send(PROJECT_RPC_ENDPOINT, {}, { body: invalidUtf8 })).status, 400);
  assert.equal((await f.send(PROJECT_RPC_ENDPOINT, {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(calls.length, 0);
  const rpcId = randomUUID(); const payload = { v: 1, request: { action: 'list' } };
  assert.deepEqual(await wire(await f.send(PROJECT_RPC_ENDPOINT, payload, { rpcId, headers: { 'content-type': ' Application/JSON ; charset=utf-8' } }), rpcId), { ok: true, value: { native: true } });
  assert.equal(calls.length, 1); assert.equal(required(calls[0])[0], PROJECT_RPC_ENDPOINT); assert.deepEqual(required(calls[0])[1], payload);
  assert.ok(required(calls[0])[2] instanceof AbortSignal); assert.equal(required(calls[0])[3].id, f.connection.browserPeer.id); assert.equal(required(calls[0])[3].ctx, f.connection.browserPeer.ctx);
});



test('a real HTTP carrier answers a chunked foreign-owner upload before the sender finishes', { timeout: 15000 }, async t => {
  const f = await fixture(t); let calls = 0, pulled = 0;
  const stop = registerQuietRpcRoute(f.owner.ctx, PROJECT_RPC_ENDPOINT, async () => { calls++; return { ok: true, value: true }; });
  t.after(async () => { await stop(); });
  // Mirror the carrier contract: mode lookup, streaming body handout, then the route.
  const shared = f.connection.createSharedFetchHandler('/api');
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://carrier.invalid');
    const mode = shared.requestBodyMode({ method: incoming.method ?? 'GET', url });
    assert.equal(mode, 'streaming');
    const request = new Request(url, {
      method: incoming.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(incoming.headers).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
      body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
      duplex: 'half',
      signal: AbortSignal.timeout(10000),
    } as RequestInit);
    // An API credential admits a non-owner principal; the carrier must refuse it at the
    // route boundary without ever consuming the still-open upload.
    const apiPeer = f.connection.createPeer({ principal: { kind: 'api' } as never });
    const response = await shared.fetch(request, apiPeer);
    const body = await response.text();
    const unread = !incoming.readableEnded;
    outgoing.writeHead(response.status, unread ? { 'content-type': 'application/json', connection: 'close' } : { 'content-type': 'application/json' });
    outgoing.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const authority = '127.0.0.1:' + String(address.port);
  const result = await new Promise<{ status: number; body: string; sentBytes: number; finishedSending: boolean }>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/' + PROJECT_RPC_ENDPOINT, method: 'POST',
      headers: { host: authority, origin: 'http://' + authority, cookie: COOKIE, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
    let sentBytes = 0, finishedSending = false, settled = false;
    outgoing.on('error', error => { if (!settled) reject(error); });
    outgoing.on('response', response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { settled = true; resolve({ status: response.statusCode ?? 0, body, sentBytes, finishedSending }); });
    });
    const opening = '{"type":"client-request","rpcId":"' + randomUUID() + '","method":"' + PROJECT_RPC_ENDPOINT + '","payload":';
    sentBytes += Buffer.byteLength(opening);
    outgoing.write(opening);
    // Keep the upload open: an unanswered request would stall the test until its timeout.
    const interval = setInterval(() => { if (!finishedSending) { sentBytes += 1; outgoing.write(' '.repeat(1024)); } }, 20);
    outgoing.on('close', () => clearInterval(interval));
  });
  assert.equal(result.finishedSending, false, 'the sender never completed its upload');
  assert.equal(result.status, 403, 'the carrier refuses a non-owner principal at the route boundary');
  assert.equal(result.body, 'forbidden');
  assert.ok(result.sentBytes > 0, 'bytes were actually in flight when the refusal arrived');
  assert.equal(calls, 0); assert.equal(pulled, 0);
});

test('body bound includes finite envelope headroom and counts actual streamed bytes, not only Content-Length', async t => {
  const f = await fixture(t); let calls = 0;
  registerQuietRpcRoute(f.owner.ctx, PROJECT_RPC_ENDPOINT, async () => { calls++; return { ok: true, value: true }; });
  const rpcId = randomUUID(); const envelope = { type: 'client-request', rpcId, method: PROJECT_RPC_ENDPOINT, payload: '' };
  const overhead = Buffer.byteLength(JSON.stringify(envelope));
  envelope.payload = 'x'.repeat(BODY_LIMIT - overhead);
  const exact = JSON.stringify(envelope); assert.equal(Buffer.byteLength(exact), BODY_LIMIT);
  assert.deepEqual(await wire(await f.send(PROJECT_RPC_ENDPOINT, {}, { body: exact }), rpcId), { ok: true, value: true });
  assert.equal(calls, 1);
  let cancelled = false;
  const tooBig = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(exact)); controller.enqueue(encoder.encode(' ')); }, cancel() { cancelled = true; } });
  assert.equal((await f.send(PROJECT_RPC_ENDPOINT, {}, { body: tooBig, headers: { 'content-length': '1' } })).status, 413);
  assert.equal(cancelled, true); assert.equal(calls, 1);
  for (const length of [String(BODY_LIMIT + 1), 'invalid', '-1']) {
    const request = f.request(PROJECT_RPC_ENDPOINT, {}, { headers: { 'content-length': length } });
    assert.equal((await f.dispatch(request)).status, 413); assert.equal(request.bodyUsed, false);
  }
});

test('unhandled transport handler errors are redacted and correlated, including failures during response encoding', async t => {
  const f = await fixture(t); let mode = 'throw';
  registerQuietRpcRoute(f.owner.ctx, PROJECT_RPC_ENDPOINT, async () => {
    if (mode === 'throw') throw Error('private synthetic provider diagnostic');
    if (mode === 'bigint') return { ok: true, value: 1n };
    const cycle: { self?: unknown } = {}; cycle.self = cycle; return { ok: true, value: cycle };
  });
  for (mode of ['throw', 'bigint', 'cycle']) {
    const rpcId = randomUUID(); const result = await wire(await f.send(PROJECT_RPC_ENDPOINT, {}, { rpcId }), rpcId);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'OPERATION_FAILED'); assert.deepEqual(result.error.details, {});
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('unload unregisters first, aborts and awaits the actual pending handler, while the gateway still answers', async t => {
  const f = await fixture(t); const { resolve: entered, promise: entering } = deferred(); let release!: () => void; let signal!: AbortSignal;
  const stop = registerQuietRpcRoute(f.owner.ctx, PROJECT_RPC_ENDPOINT, async (_endpoint, _payload, requestSignal) => {
    signal = requestSignal; entered(); await new Promise<void>(resolve => { release = resolve; });
    if (signal.aborted) throw Error('private cancellation diagnostic');
    return { ok: true, value: true };
  });
  const rpcId = randomUUID(); const pending = f.send(PROJECT_RPC_ENDPOINT, {}, { rpcId }); await entering;
  let done = false; const disposal = stop().then(() => { done = true; });
  try {
    assert.equal(signal.aborted, true); assert.equal((await f.send(PROJECT_RPC_ENDPOINT, {})).status, 404); assert.equal(done, false);
    const gatewayId = randomUUID(); assert.deepEqual(await wire(await f.send('session/foo', {}, { rpcId: gatewayId }), gatewayId), { ok: true, value: true });
  } finally { release(); }
  const result = await wire(await pending, rpcId); assert.equal(result.error.code, 'CANCELLED'); await disposal;
  const stopped = stop(); assert.equal(stop(), stopped); await stopped;
});

test('scope disposal aborts blocked body reading and awaits stream cancellation before reporting quiescence', async t => {
  const f = await fixture(t); let calls = 0; const { resolve: entered, promise: reading } = deferred();
  const { resolve: cancelEntered, promise: cancelling } = deferred(); let releaseCancel!: () => void;
  const body = new ReadableStream({
    pull() { entered(); return new Promise(() => {}); },
    cancel() { cancelEntered(); return new Promise<void>(resolve => { releaseCancel = resolve; }); },
  });
  const stop = registerQuietRpcRoute(f.owner.ctx, PROJECT_RPC_ENDPOINT, async () => { calls++; return { ok: true, value: true }; });
  const request = f.request(PROJECT_RPC_ENDPOINT, {}, { body }); const pending = f.dispatch(request); await reading;
  let done = false; const disposal = f.owner.dispose().then(() => { done = true; }); await cancelling;
  try {
    // Complete another public dispatch to give every disposal microtask a turn.
    const gatewayId = randomUUID(); assert.deepEqual(await wire(await f.send('session/foo', {}, { rpcId: gatewayId }), gatewayId), { ok: true, value: true });
    assert.equal((await f.send(PROJECT_RPC_ENDPOINT, {})).status, 404); assert.equal(done, false); assert.equal(calls, 0);
  } finally { releaseCancel(); }
  const result = await wire(await pending, 'invalid-request'); assert.equal(result.error.code, 'CANCELLED');
  await disposal; await stop(); assert.equal(done, true); assert.equal(required(request.body).locked, false);
});

test('request abort during body transfer or after parsed dispatch never invokes late work or leaks raw errors', async t => {
  const f = await fixture(t); let calls = 0; const { resolve: entered, promise: reading } = deferred();
  const stop = registerQuietRpcRoute(f.owner.ctx, PROJECT_RPC_ENDPOINT, async () => { calls++; return { ok: true, value: true }; });
  let cancelled = false; const body = new ReadableStream({ pull() { entered(); return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const abort = new AbortController(); const pending = f.send(PROJECT_RPC_ENDPOINT, {}, { body, signal: abort.signal }); await reading; abort.abort();
  const result = await wire(await pending, 'invalid-request'); assert.equal(result.error.code, 'CANCELLED'); assert.equal(cancelled, true); assert.equal(calls, 0);
  await stop();
  const { resolve: handlerEntered, promise: entering } = deferred();
  registerQuietRpcRoute(f.owner.ctx, PROJECT_RPC_ENDPOINT, async (_endpoint, _payload, signal) => {
    handlerEntered(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); throw Error('private abort failure');
  });
  const during = new AbortController(); const rpcId = randomUUID(); const running = f.send(PROJECT_RPC_ENDPOINT, {}, { rpcId, signal: during.signal }); await entering; during.abort();
  const cancelledResult = await wire(await running, rpcId); assert.equal(cancelledResult.error.code, 'CANCELLED'); assert.ok(!JSON.stringify(cancelledResult).includes('private'));
});
