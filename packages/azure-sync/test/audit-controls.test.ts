import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands';
import type { ContainerClient } from '@azure/storage-blob';
import type { TableClient } from '@azure/data-tables';
import { BlobStore } from '../src/azure/blob.js';
import { TableStore } from '../src/azure/table.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { CloudController, type CloudCore } from '../src/controller.js';
import { parseCloudCommand, registerCloudCommands } from '../src/commands.js';
import { boundedJson, parseCloudAuditResult, parseCloudRequest, publicCloudError, type CloudAuditResult, type CloudRequest } from '../src/protocol.js';
import type { LocalStore } from '../src/local/store.js';
import type { SettingsService } from '../src/settings.js';
import type { SyncService } from '../src/sync/service.js';
import type { CloudRepository } from '../src/sync/cloud-repository.js';
import { createCloudClient, decodeCloudReply, type CloudClientRuntime, type CloudLocalView, type CloudSettingsView } from '../client-model.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const signal = () => new AbortController().signal;
const wire = (data: unknown) => ({ ok: true, value: { v: 1, ok: true, data } });
function audit(sessionId = 'audited'): CloudAuditResult {
  return { status: 'verified', current: true, auditedAt: 1000, watermark: {
    sessionId, schemaVersion: 4, formatVersion: 4, generation: 2, headerHash: 'a'.repeat(64), inheritedEventCount: 0,
    eventCount: 3, headSeq: 2, headHash: 'b'.repeat(64), chainHash: 'c'.repeat(64), batchCount: 1,
    rootSessionId: sessionId, rootGeneration: 2, lastBatchGeneration: 2,
    lastBatchRowKey: 'synthetic-batch-row', lastBatchBlobName: 'v1/synthetic-batch.jsonl.gz',
  } };
}
const cancelled = (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED';

test('audit request and literal command are explicit, bounded and cannot accept authority/cache-bypass options', () => {
  assert.deepEqual(parseCloudRequest({ action: 'verify', sessionId: 'audited' }), { action: 'verify', sessionId: 'audited' });
  assert.deepEqual(parseCloudCommand('verify'), { action: 'verify' });
  assert.deepEqual(parseCloudCommand('verify "remote thread"'), { action: 'verify', sessionId: 'remote thread' });
  for (const extra of [{ owned: true }, { allowDisabled: true }, { confirm: true }, { force: true }, { events: [] }]) {
    assert.throws(() => parseCloudRequest({ action: 'verify', sessionId: 'audited', ...extra }));
  }
  for (const text of ['verify --force', 'verify first second', 'verify --allow-disabled true']) assert.throws(() => parseCloudCommand(text));
});

test('audit DTO validates exact cutoff, rejects unexpected fields, and never invokes accessors', () => {
  const valid = audit();
  assert.deepEqual(parseCloudAuditResult(valid, 'audited'), valid);
  const empty = { ...valid, watermark: { ...valid.watermark, eventCount: 0, batchCount: 0, headSeq: -1, headHash: 'd'.repeat(64), chainHash: 'd'.repeat(64) } };
  delete empty.watermark.lastBatchGeneration; delete empty.watermark.lastBatchRowKey; delete empty.watermark.lastBatchBlobName;
  assert.equal(parseCloudAuditResult(empty, 'audited').watermark.eventCount, 0);
  for (const bad of [
    { ...valid, owned: true }, { ...valid, events: [] }, { ...valid, current: 'true' }, { ...valid, auditedAt: -1 },
    { ...valid, watermark: { ...valid.watermark, sessionId: 'other' } },
    { ...valid, watermark: { ...valid.watermark, headSeq: 0 } },
    { ...valid, watermark: { ...valid.watermark, batchCount: 4 } },
    { ...valid, watermark: { ...valid.watermark, lastBatchGeneration: 1 } },
    { ...valid, watermark: { ...valid.watermark, scope: 'e'.repeat(64) } },
    { ...empty, watermark: { ...empty.watermark, lastBatchBlobName: 'unexpected' } },
  ]) assert.throws(() => parseCloudAuditResult(bad, 'audited'), error => publicCloudError(error).code === 'OPERATION_FAILED');
  let touched = 0;
  const getter = Object.defineProperty({}, 'watermark', { enumerable: true, get() { touched++; return valid.watermark; } });
  assert.throws(() => parseCloudAuditResult(getter, 'audited'));
  assert.equal(touched, 0);
});

function control() {
  const calls: string[] = [];
  const state = { run: async (id: string, _signal: AbortSignal): Promise<CloudAuditResult> => audit(id) };
  const service = {
    async verifyCloudCopy(id: string, current: AbortSignal) { calls.push('verify'); return state.run(id, current); },
    status() { calls.push('status'); return { enabled: false, status: 'setup-needed' as const }; },
    async disable() { calls.push('explicit-off'); },
    async ensureOwnership() { calls.push('UNEXPECTED-ownership'); throw new Error('Audit must never obtain a writer.'); },
    async sync() { calls.push('UNEXPECTED-sync'); throw new Error('Audit must never publish.'); },
    async importSession() { calls.push('UNEXPECTED-import'); throw new Error('Audit must never import.'); },
  } as unknown as SyncService;
  const local = { getSession: () => undefined, listSessions: function* () { /* No Native or sync records. */ } } as unknown as LocalStore;
  const core: CloudCore = { service, repository: {} as CloudRepository, testAuth: async () => { calls.push('UNEXPECTED-infra'); } };
  const controller = new CloudController({ local, settings: {} as SettingsService, core: async () => core, current: () => core });
  const run = (request: CloudRequest, current = signal()) => controller.execute(request, { origin: 'rpc', signal: current });
  return { calls, state, controller, run };
}

test('audit controller dispatch is read-only, creates no local record and returns only strict summary data', async t => {
  const f = control(); t.after(() => f.controller.close());
  const result = await f.run({ action: 'verify', sessionId: 'audited' });
  assert.deepEqual(f.calls, ['verify', 'status']);
  const decoded = decodeCloudReply({ action: 'verify', sessionId: 'audited' }, wire(result));
  assert.equal(decoded.detail?.watermark?.eventCount, 3);
  assert.ok(Object.isFrozen(decoded.detail?.watermark));
  f.state.run = async id => ({ ...audit(id), diagnostic: 'must-not-leak-provider-text' } as CloudAuditResult);
  await assert.rejects(f.run({ action: 'verify', sessionId: 'audited' }), error => publicCloudError(error).code === 'OPERATION_FAILED');
});

test('explicit Off preempts a stalled audit and the audit cannot publish its late result', { timeout: 2000 }, async t => {
  const f = control(), entered = deferred(), result = deferred<CloudAuditResult>(); t.after(() => { result.resolve(audit()); f.controller.close(); });
  f.state.run = async () => { entered.resolve(); return result.promise; };
  const pending = f.run({ action: 'verify', sessionId: 'audited' });
  await entered.promise;
  await f.run({ action: 'toggle', sessionId: 'audited', enabled: false });
  await assert.rejects(pending, error => publicCloudError(error).code === 'CANCELLED');
  result.resolve(audit()); await setImmediate();
  assert.equal(f.calls.filter(value => value === 'verify').length, 1);
  assert.equal(f.calls.some(value => value.startsWith('UNEXPECTED')), false);
});

test('ignored canceled audit providers retain bounded capacity until they actually settle', { timeout: 3000 }, async t => {
  const f = control(), gates: Array<ReturnType<typeof deferred<CloudAuditResult>>> = [];
  t.after(() => { gates.forEach((gate, i) => gate.resolve(audit(`a${i}`))); f.controller.close(); });
  let entered = deferred();
  f.state.run = async () => { const gate = deferred<CloudAuditResult>(); gates.push(gate); entered.resolve(); return gate.promise; };
  for (let i = 0; i < 4; i++) {
    entered = deferred(); const stop = new AbortController();
    const work = f.run({ action: 'verify', sessionId: `a${i}` }, stop.signal);
    await entered.promise; stop.abort();
    await assert.rejects(work, error => publicCloudError(error).code === 'CANCELLED');
  }
  await assert.rejects(f.run({ action: 'verify', sessionId: 'overflow' }), error => publicCloudError(error).code === 'CAPACITY');
  assert.equal(gates.length, 4);
  gates.forEach((gate, i) => gate.resolve(audit(`a${i}`))); await setImmediate();
});

test('native audit command records only finite summary text and never grants or serializes provider authority', async t => {
  const host = new Context(), owner = createScope(host, {}); let definition!: CommandDefinition;
  host.provide('commands', { register(value: CommandDefinition) { definition = value; return () => {}; } });
  const calls: CloudRequest[] = [];
  const stop = registerCloudCommands(owner.ctx, { async execute(request, context) {
    calls.push(request); assert.equal(context.sessionId, 'native-context');
    const id = 'sessionId' in request ? request.sessionId ?? context.sessionId! : context.sessionId!;
    return boundedJson({ kind: 'action', action: 'verify', sessionId: id, state: 'setup-needed', detail: audit(id) });
  } });
  t.after(async () => { stop(); await owner.dispose(); });
  const result = await definition.handler({ rawInput: 'verify target', signal: signal(), attachments: [], commandId: 'synthetic', agent: { session: { id: 'native-context' } } } as unknown as CommandInvocation);
  assert.equal(definition.recordInput, false);
  assert.equal(result.kind, 'success');
  assert.match(result.text!, /generation 2, 3 events, 1 batches/u);
  assert.match(result.text!, /No writer permission/u);
  assert.doesNotMatch(result.text!, /synthetic-batch|v1\/|cccccccc/u);
  assert.deepEqual(calls, [{ action: 'verify', sessionId: 'target' }]);
});

test('blob cancellation between HEAD and GET prevents the next request while preserving length bounds', async () => {
  const entered = deferred(), properties = deferred<{ contentLength: number }>(), stop = new AbortController();
  let heads = 0, gets = 0;
  const container = { getBlobClient() { return {
    async getProperties(options: { abortSignal?: AbortSignal }) { heads++; assert.equal(options.abortSignal, stop.signal); entered.resolve(); return properties.promise; },
    async downloadToBuffer() { gets++; return Buffer.from('abc'); },
  }; } } as unknown as ContainerClient;
  const blob = new BlobStore(container);
  const work = blob.read('synthetic', 3, { signal: stop.signal });
  await entered.promise; stop.abort('must-not-appear'); properties.resolve({ contentLength: 3 });
  await assert.rejects(work, error => cancelled(error) && !String(error).includes('must-not-appear'));
  assert.equal(heads, 1); assert.equal(gets, 0);
  await assert.rejects(blob.read('synthetic', 3, { signal: stop.signal }), cancelled);
  assert.equal(heads, 1);
});

test('blob authority callback is checked again after HEAD even without transport cancellation', async () => {
  let valid = true, gets = 0;
  const blob = new BlobStore({ getBlobClient: () => ({
    async getProperties() { valid = false; return { contentLength: 3 }; },
    async downloadToBuffer() { gets++; return Buffer.from('abc'); },
  }) } as unknown as ContainerClient);
  await assert.rejects(blob.read('synthetic', 3, { check() { if (!valid) throw new AzureSyncError('CANCELLED', 'Reader retired.'); } }), cancelled);
  assert.equal(gets, 0);
});

test('range downloads are serialized per blob and conditional on the size-checked object identity', async () => {
  let gets = 0;
  const blob = new BlobStore({ getBlobClient: () => ({
    async getProperties() { return { contentLength: 3, etag: 'synthetic-object-etag' }; },
    async downloadToBuffer(offset: number, count: number, options: { concurrency?: number; conditions?: { ifMatch?: string } }) {
      gets++; assert.equal(offset, 0); assert.equal(count, 3); assert.equal(options.concurrency, 1);
      assert.equal(options.conditions?.ifMatch, 'synthetic-object-etag'); return Buffer.from('abc');
    },
  }) } as unknown as ContainerClient);
  assert.equal((await blob.read('synthetic', 3)).toString(), 'abc'); assert.equal(gets, 1);
});

test('table transport receives cancellation and cannot turn a canceled 404 into an absent manifest', async () => {
  const entered = deferred(), response = deferred<never>(), stop = new AbortController(); let reads = 0;
  const table = new TableStore({ async getEntity(_p: string, _r: string, options: { abortSignal?: AbortSignal; requestOptions: { timeout: number } }) {
    reads++; assert.equal(options.abortSignal, stop.signal); assert.equal(options.requestOptions.timeout, 1234); entered.resolve(); return response.promise;
  } } as unknown as TableClient, 1234);
  const work = table.get('partition', 'row', { signal: stop.signal });
  await entered.promise; stop.abort('must-not-leak'); response.reject({ statusCode: 404 });
  await assert.rejects(work, cancelled);
  await assert.rejects(table.get('partition', 'row', { signal: stop.signal }), cancelled);
  assert.equal(reads, 1);
});

function store<T>(initial: T) {
  let value = initial; const listeners = new Set<() => void>();
  return { getSnapshot: () => value, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
}

test('browser audit cannot unblock a retained thread or cause automatic ownership/native refresh', async t => {
  const settings: CloudSettingsView = { auth: 'auto', accountName: '', managedIdentityClientId: '', connectionRef: 'SYNTHETIC_REFERENCE', container: 'sessions', table: 'sessions', endpointSuffix: 'core.windows.net', defaultEnabled: false, pullOnStartup: false, pollSeconds: 300, authPending: false, connection: { configured: false, writable: true } };
  const local: CloudLocalView = { sessionId: 'audited', enabled: true, state: 'active', status: 'remote-ahead-live', generation: 2, detached: false, admissionRequired: true, admissionStopped: false, restartRequired: true, needsFolder: false, mappingUnstable: false, degradedAttachmentCount: 0, degradedAcknowledged: false, hasConflictBackup: false };
  const calls: string[] = []; let refreshes = 0;
  const block = store<{ reason: string } | undefined>(undefined);
  const runtime: CloudClientRuntime = {
    connection: { generation: store<{ id: number } | undefined>({ id: 1 }), rpc: { async call(_route, _endpoint, payload) {
      const request = (payload as { request: CloudRequest }).request; calls.push(request.action);
      if (request.action === 'status') return wire({ kind: 'status', revision: 1, projectionRevision: 'f'.repeat(64), settings, items: [local] });
      if (request.action === 'verify') return wire({ kind: 'action', action: 'verify', sessionId: 'audited', state: 'synced', detail: audit() });
      throw new Error('Unexpected writer/permission operation from audit.');
    } } },
    sessions: { refresh() { refreshes++; } }, conversation: { blocks: { storeFor: () => block, set() {} } },
  };
  const client = createCloudClient(runtime); t.after(() => client.dispose());
  client.watchSession('audited'); await setImmediate();
  assert.equal(client.getThread('audited').blocked, true);
  const before = calls.length;
  const reply = await client.request({ action: 'verify', sessionId: 'audited' }); await setImmediate();
  assert.equal(reply.detail?.watermark?.eventCount, 3);
  assert.deepEqual(calls.slice(before), ['verify']);
  assert.equal(client.getThread('audited').blocked, true);
  assert.equal(client.getThread('audited').flags.ownershipVerified, false);
  assert.equal(refreshes, 0);
});
