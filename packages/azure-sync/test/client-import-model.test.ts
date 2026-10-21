import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImportClient, decodeImportReply, importSourceFacts } from '../client-import-model.js';
import { CloudClientError } from '../client-model.js';
import type { CloudImportRequest, CloudImportView } from '../src/import/protocol.js';
import type { GitContext } from '../src/git/context.js';

const sid = 'original-cloud-thread', operationId = '9df64992-7c2c-4e65-bd88-58ade5f3a08d', projectId = 'a2d6ebf2-1204-497e-8641-be075725565e';
const sha = 'a'.repeat(40);
const envelope = (data: unknown) => ({ ok: true, value: { v: 1, ok: true, data } });
const capabilities = { version: 2, kind: 'import-capabilities', local: true, worktree: false, seeded: false, folders: [{ path: '/local/project', title: 'Project' }] };
const view = (patch: Partial<CloudImportView> = {}): CloudImportView => ({ version: 2, kind: 'import-operation', operationId, sessionId: sid, generation: 1, revision: 4, phase: 'ready', destination: 'local', continuable: false, pendingInput: true, cwd: '/local/project', ...patch });
function store<T>(initial: T) { let value = initial; const listeners = new Set<() => void>(); return { getSnapshot: () => value, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }, publish(next: T) { value = next; for (const listener of listeners) listener(); }, get size() { return listeners.size; } }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture(reply: (request: CloudImportRequest) => unknown | Promise<unknown> = () => envelope(capabilities)) {
  const generation = store<{ id: number } | undefined>({ id: 1 }), calls: { request: CloudImportRequest; signal?: AbortSignal }[] = [];
  let refreshes = 0;
  const client = createImportClient({ connection: { generation, rpc: { async call(route, endpoint, payload, signal) {
    assert.equal(route, '/api'); assert.equal(endpoint, 'azure-sync/import');
    const body = payload as { v: number; request: CloudImportRequest }; assert.equal(body.v, 1); assert.deepEqual(Object.keys(body).sort(), ['request', 'v']);
    calls.push({ request: body.request, signal }); return reply(body.request);
  } } }, sessions: { refresh() { refreshes++; } } });
  return { client, generation, calls, get refreshes() { return refreshes; } };
}

test('version2 import data cannot be confused with an old pull/catalog DTO or another target', () => {
  const request: CloudImportRequest = { action: 'import-operation', sessionId: sid, operationId };
  assert.deepEqual(decodeImportReply(request, envelope(view())), view());
  for (const bad of [{ kind: 'action', action: 'pull', sessionId: sid, state: 'synced' }, view({ sessionId: 'other' }), view({ operationId: 'other' }), { ...view(), version: 1 }, { ...view(), rawHeader: {} }, view({ phase: 'binding', continuable: true })]) assert.throws(() => decodeImportReply(request, envelope(bad)));
  const result = decodeImportReply({ action: 'import-capabilities' }, envelope(capabilities)); assert.ok(Object.isFrozen(result));
  assert.throws(() => decodeImportReply({ action: 'import-capabilities' }, envelope({ ...capabilities, folders: [{ path: '/local/project', title: 'Project', projectId }] })));
});

test('local import admission cannot grant Continue without Ready or confuse a reserved identity', () => {
  const request: CloudImportRequest = { action: 'import-admission', sessionId: sid };
  const ordinary = { version: 2, kind: 'import-admission', sessionId: sid, reserved: false, ready: true, continued: true };
  assert.equal(decodeImportReply(request, envelope(ordinary)).kind, 'import-admission');
  assert.throws(() => decodeImportReply(request, envelope({ ...ordinary, reserved: true })));
  assert.throws(() => decodeImportReply(request, envelope({ ...ordinary, ready: false })));
  const pending = { ...ordinary, reserved: true, operationId, generation: 1, ready: true, continued: false };
  assert.equal(decodeImportReply(request, envelope(pending)).kind, 'import-admission');
  assert.throws(() => decodeImportReply(request, envelope({ ...pending, sessionId: 'other' })));
  assert.throws(() => decodeImportReply(request, envelope({ ...pending, ready: false, continued: true })));
});

test('source and plan responses bind generation, original SID, selected mode and operation revision', () => {
  const inspect: CloudImportRequest = { action: 'inspect-import', sessionId: sid, generation: 1, gitContextVersion: 2 };
  const source = { version: 2, kind: 'import-source', sessionId: sid, generation: 1, cwd: '/source', platform: 'linux', eventCount: 2, eligible: true, gitUsable: false, seeded: false };
  assert.equal(decodeImportReply(inspect, envelope(source)).kind, 'import-source');
  assert.throws(() => decodeImportReply(inspect, envelope({ ...source, generation: 2 })));
  const planRequest: CloudImportRequest = { action: 'plan-import', sessionId: sid, generation: 1, operationId, gitContextVersion: 2, destination: { kind: 'local', folderPath: '/local/project' }, mapping: { remotePlatform: 'linux', remotePrefix: '/source' } };
  const plan = { version: 2, kind: 'import-plan', operationId, sessionId: sid, generation: 1, revision: 1, expiresAt: 200, eventCount: 2, cwd: '/local/project', destination: 'local', warnings: [], codeMismatch: false };
  assert.equal(decodeImportReply(planRequest, envelope(plan)).kind, 'import-plan');
  assert.throws(() => decodeImportReply(planRequest, envelope({ ...plan, destination: 'worktree' })));
  assert.throws(() => decodeImportReply(planRequest, envelope({ ...plan, warnings: ['raw provider exception'] })));
});

test('new branch choices are full local refs with exact object-format-consistent commits', () => {
  const request: CloudImportRequest = { action: 'import-bases', projectId, folderId: 'folder', permissionActorId: 'existing-local' };
  const data = { version: 2, kind: 'import-bases', projectId, folderId: 'folder', repoRoot: '/repo', objectFormat: 'sha1', head: sha, branches: [{ name: 'refs/heads/dev', oid: sha }] };
  assert.equal(decodeImportReply(request, envelope(data)).kind, 'import-bases');
  for (const patch of [{ folderId: 'other' }, { head: 'b'.repeat(64) }, { branches: [{ name: 'origin/dev', oid: sha }] }, { branches: [{ name: 'refs/dsh-worktrees/id/base', oid: sha }] }]) assert.throws(() => decodeImportReply(request, envelope({ ...data, ...patch })));
});

test('source display separates original local-base upstream from current branch and expected OIDs', () => {
  const remote = { name: 'origin', sanitizedUrl: 'https://example.invalid/repo' };
  const input: GitContext = { v: 2, observation: { deviceId: 'source', observedAt: 1, generation: 1, headerHash: 'c'.repeat(64), eventCount: 1, chainHash: 'd'.repeat(64) }, repository: { objectFormat: 'sha1', root: '/source', worktree: true }, creationBase: { kind: 'local', ref: 'refs/heads/release', oid: sha, upstreamAtCreation: { ref: 'refs/heads/dev', remote } }, current: { detached: false, unborn: false, dirty: 'dirty', branchRef: 'refs/heads/worktree/task', headOid: 'b'.repeat(40), upstream: { kind: 'remote', ref: 'refs/heads/feature', remote } } };
  assert.deepEqual(importSourceFacts(input), { head: 'b'.repeat(40), localBranch: 'refs/heads/worktree/task', currentRemote: 'origin', currentRef: 'refs/heads/feature', baseOid: sha, baseRemote: 'origin', baseRef: 'refs/heads/dev' });
  assert.equal(importSourceFacts(undefined).head, '');
});

test('new transport uses only its own endpoint and ignores late results after connection replacement', async () => {
  const gate = deferred<unknown>(), run = fixture(() => gate.promise);
  const pending = run.client.request({ action: 'import-capabilities' }); const rejected = assert.rejects(pending, error => error instanceof CloudClientError && error.code === 'CANCELLED');
  await flush(); assert.equal(run.calls.length, 1); run.generation.publish({ id: 2 }); await rejected;
  assert.equal(run.calls[0]?.signal?.aborted, true); gate.resolve(envelope(capabilities)); await flush(); assert.equal(run.refreshes, 0);
  run.client.dispose(); assert.equal(run.generation.size, 0);
});

test('completed mutations refresh native list but cancellation/disposal cannot publish stale success', async () => {
  const run = fixture(() => envelope(view()));
  const result = await run.client.request({ action: 'commit-import', sessionId: sid, operationId, revision: 1, confirm: true });
  assert.equal(result.kind, 'import-operation'); assert.equal(run.refreshes, 1); run.client.dispose();
  await assert.rejects(run.client.request({ action: 'import-capabilities' }), error => error instanceof CloudClientError && error.code === 'DISPOSED');
  const gate = deferred<unknown>(), cancelled = fixture(() => gate.promise), controller = new AbortController();
  const promise = cancelled.client.request({ action: 'continue-import', sessionId: sid, operationId, revision: 1, confirm: true, acknowledgePendingInput: true }, controller.signal);
  const refused = assert.rejects(promise, error => error instanceof CloudClientError && error.code === 'CANCELLED'); await flush(); controller.abort(); await refused;
  gate.resolve(envelope(view({ continuable: true }))); await flush(); assert.equal(cancelled.refreshes, 0); cancelled.client.dispose();
});

test('cancelling ignored providers retains capacity until the raw work settles', async () => {
  const gates = Array.from({ length: 33 }, () => deferred<unknown>());
  let entered = 0;
  const run = fixture(() => gates[entered++]!.promise);
  for (let index = 0; index < 32; index++) {
    const controller = new AbortController(), pending = run.client.request({ action: 'import-capabilities' }, controller.signal);
    const rejected = assert.rejects(pending, error => error instanceof CloudClientError && error.code === 'CANCELLED'); await flush(); controller.abort(); await rejected;
  }
  await assert.rejects(run.client.request({ action: 'import-capabilities' }), error => error instanceof CloudClientError && error.code === 'CAPACITY');
  assert.equal(run.calls.length, 32);
  gates[0]!.resolve(envelope(capabilities)); await flush();
  const last = run.client.request({ action: 'import-capabilities' }); await flush();
  run.client.dispose(); await assert.rejects(last);
  for (const gate of gates) gate.resolve(envelope(capabilities)); await flush();
});
