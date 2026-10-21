import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCloudRequest, type CloudRequest } from '../src/protocol.js';
import { CLOUD_IMPORT_PROTOCOL_VERSION, parseCloudImportPayload, parseCloudImportRequest, type CloudImportRequest } from '../src/import/protocol.js';

const operationId = 'c790612c-c2a8-4ca5-b7cd-c49457d09c74';
const projectId = '660d65a7-1211-4b08-8ba3-8265e1df1edb';
const sessionId = 'original-cloud-session';
const mapping = { remotePlatform: 'win32' as const, remotePrefix: 'C:\\source\\project' };
const local = (): CloudImportRequest => ({ action: 'plan-import', sessionId, generation: 2, operationId, gitContextVersion: 2, destination: { kind: 'local', folderPath: '/selected/project' }, mapping });
const worktree = (): CloudImportRequest => ({ action: 'plan-import', sessionId, generation: 2, operationId, gitContextVersion: 2, destination: { kind: 'worktree', projectId, folderId: 'local-folder', permissionActorId: 'existing-permission-context', base: { kind: 'commit', oid: 'a'.repeat(40) } }, mapping });
const confirmed = (action: 'commit-import' | 'resume-import' | 'continue-import'): CloudImportRequest => ({ action, sessionId, operationId, revision: 3, confirm: true });
function invalid(value: unknown) {
  assert.throws(() => parseCloudImportRequest(value), error => error instanceof Error && error.message === 'The cloud request is invalid.');
}

test('import protocol is explicitly versioned and separate from legacy pull request/catalog', () => {
  assert.equal(CLOUD_IMPORT_PROTOCOL_VERSION, 2);
  const candidates: CloudImportRequest[] = [
    { action: 'import-capabilities' },
    { action: 'import-admission', sessionId },
    { action: 'inspect-import', sessionId, generation: 2, gitContextVersion: 2 },
    { action: 'import-bases', projectId, folderId: 'folder', permissionActorId: 'existing-actor' },
    local(), worktree(), ...(['commit-import', 'resume-import', 'continue-import'] as const).map(confirmed),
    { action: 'import-operation', sessionId, operationId }, { action: 'cancel-import', sessionId, operationId },
  ];
  for (const request of candidates) {
    const decoded = parseCloudImportRequest(request); assert.deepEqual(decoded, request); assert.notEqual(decoded, request);
    assert.deepEqual(parseCloudImportPayload({ v: 1, request }), request);
    assert.throws(() => parseCloudRequest(request), 'new actions must not alter legacy ingress');
  }
  assert.deepEqual(parseCloudRequest({ action: 'pull' }), { action: 'pull' });
  invalid({ action: 'pull' } satisfies CloudRequest);
});

test('Local can carry exact selected project membership or a separate explicit ancestor mapping root', () => {
  const request = local(); assert.equal(request.action, 'plan-import');
  if (request.action !== 'plan-import') return;
  const value: CloudImportRequest = { ...request, destination: { kind: 'local', folderPath: '/selected/project/subdir', projectId, folderId: 'exact-subdir-folder' }, mapping: { ...mapping, localPrefix: '/selected/project' } };
  assert.deepEqual(parseCloudImportRequest(value), value);
  invalid({ ...request, destination: { kind: 'local', folderPath: '/selected/project', projectId } });
  invalid({ ...request, destination: { kind: 'local', folderPath: '/selected/project', folderId: 'folder' } });
  invalid({ ...request, destination: { kind: 'local', folderPath: '/selected/project', permissionActorId: 'not-local-authority' } });
});

test('worktree requires real explicit actor intent, paired source folder and exact available commit', () => {
  const request = worktree(); if (request.action !== 'plan-import' || request.destination.kind !== 'worktree') return;
  for (const base of [{ kind: 'head', oid: 'b'.repeat(40) }, { kind: 'commit', oid: 'c'.repeat(64) }, { kind: 'local-branch', name: 'refs/heads/feature/a/b', oid: 'd'.repeat(40) }]) {
    const value: unknown = { ...request, destination: { ...request.destination, base } };
    assert.deepEqual(parseCloudImportRequest(value), value);
  }
  for (const base of [{ kind: 'commit', oid: 'HEAD' }, { kind: 'head', name: 'HEAD', oid: 'b'.repeat(40) }, { kind: 'local-branch', name: 'dev', oid: 'c'.repeat(40) }, { kind: 'local-branch', name: 'refs/dsh-worktrees/id/base', oid: 'd'.repeat(40) }, { kind: 'remote', remote: 'origin', name: 'dev', oid: 'd'.repeat(40) }]) invalid({ ...request, destination: { ...request.destination, base } });
  invalid({ ...request, destination: { ...request.destination, permissionActorId: '' } });
  invalid({ ...request, destination: { ...request.destination, projectId: 'not-uuid' } });
  invalid({ ...request, destination: { ...request.destination, label: ' trailing ' } });
  invalid({ ...request, mapping: { ...mapping, localPrefix: '/untrusted/generated-worktree' } });
  invalid({ ...request, destination: { ...request.destination, requireBlankSource: false } });
  invalid({ ...request, destination: { ...request.destination, firstPrompt: 'never send a dummy message' } });
});

test('explicit confirmations cannot be inferred, omitted or substituted with arbitrary booleans', () => {
  for (const action of ['commit-import', 'resume-import', 'continue-import'] as const) {
    const request = confirmed(action);
    invalid({ ...request, confirm: false }); invalid({ ...request, revision: 0 }); invalid({ ...request, revision: 1.5 });
    const { confirm: _confirm, ...without } = request as Exclude<CloudImportRequest, { action: 'plan-import' | 'inspect-import' | 'import-capabilities' | 'import-admission' | 'import-bases' | 'import-operation' | 'cancel-import' }>;
    invalid(without);
  }
  assert.deepEqual(parseCloudImportRequest({ ...confirmed('commit-import'), acknowledgeCodeMismatch: true }), { ...confirmed('commit-import'), acknowledgeCodeMismatch: true });
  assert.deepEqual(parseCloudImportRequest({ ...confirmed('continue-import'), acknowledgePendingInput: true }), { ...confirmed('continue-import'), acknowledgePendingInput: true });
  invalid({ ...confirmed('continue-import'), acknowledgePendingInput: false });
  invalid({ ...confirmed('commit-import'), acknowledgeCodeMismatch: false });
  invalid({ ...confirmed('commit-import'), acknowledgePendingInput: true });
  invalid({ action: 'cancel-import', sessionId, operationId, confirm: true });
});

test('remote target identity, generation and schema cannot fall back to current conversation', () => {
  const request = local(); if (request.action !== 'plan-import') return;
  for (const patch of [{ sessionId: undefined }, { sessionId: '' }, { sessionId: 'line\nbreak' }, { operationId: 'not-uuid' }, { generation: 0 }, { generation: -1 }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { gitContextVersion: 1 }, { gitContextVersion: 3 }, { actorId: 'implicit-host-authority' }, { origin: 'tool' }]) invalid({ ...request, ...patch });
  invalid({ action: 'import-operation', operationId });
  invalid({ action: 'import-capabilities', sessionId });
});

test('unknown payload keys, hostile objects, sparse data and wrong envelopes refuse before effects', () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, 'action', { enumerable: true, get() { invoked++; return 'import-capabilities'; } });
  invalid(getter); invalid({ action: 'import-capabilities', toJSON() { invoked++; return {}; } });
  invalid(Object.assign(Object.create({ inherited: true }), { action: 'import-capabilities' }));
  assert.equal(invoked, 0);
  for (const value of [{ v: 2, request: local() }, { v: 1, request: local(), actorId: 'wrong' }, { v: 1 }, { request: local() }]) assert.throws(() => parseCloudImportPayload(value));
  const request = local(); if (request.action !== 'plan-import') return;
  invalid({ ...request, mapping: { ...mapping, id: operationId } });
  invalid({ ...request, mapping: { ...mapping, remotePlatform: 'unknown' } });
  invalid({ ...request, destination: { kind: 'local', folderPath: 'x'.repeat(4097) } });
});
