import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { historyNamespace, historyScopeId, historyWatermark, needsLocalHistory } from '../src/sync/history-state.js';
import { bounds, deferred, historyFixture, scope } from './history-fixture.js';
const code = (expected: string) => (error: unknown) => error instanceof AzureSyncError && error.code === expected;

test('A1/A2/A20 observe is payload-independent, does not establish H or L', async () => {
  const f = historyFixture(); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope, cache: { memoryBytes: 0, diskBytes: 0 } });
  for (let i = 0; i < 4; i += 1) {
    const observation = await reader.observe(f.sessionId); assert.equal(observation?.comparison, 'unknown');
    assert.equal(needsLocalHistory(observation!.watermark, { eventCount: 1 }), true);
  }
  assert.equal(f.calls.blob, 0); assert.equal(f.calls.row, 0); assert.equal(f.calls.list, 0); await reader.close();
});
test('A4/A5 complete memory hits use fresh control metadata and copied events', async () => {
  const f = historyFixture(); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope });
  const first = await reader.read(f.sessionId); assert.equal(first?.events.length, 2);
  (first!.events as unknown as Array<{ time: number }>)[0]!.time = 99;
  f.manifest = { entity: { ...f.manifest.entity, writerEpoch: 8, gitJson: '{}', leaseOwner: 'another' }, etag: 'new-etag' };
  const second = await reader.read(f.sessionId); assert.equal(second?.manifest.etag, 'new-etag'); assert.equal(second?.manifest.entity.writerEpoch, 8); assert.equal(second?.events[0]?.time, 1000);
  assert.equal(f.calls.blob, 2); assert.equal(f.calls.row, 2);
  f.manifest = { ...f.manifest, entity: { ...f.manifest.entity, state: 'disabled', enabled: false } };
  await assert.rejects(reader.read(f.sessionId), code('DISABLED'));
  assert.equal((await reader.read(f.sessionId, { allowDisabled: true }))?.events.length, 2);
  f.manifest = { ...f.manifest, entity: { ...f.manifest.entity, state: 'deleted' } };
  await assert.rejects(reader.read(f.sessionId, { allowDisabled: true }), code('REMOVED_REMOTELY')); await reader.close();
});
test('A6 strict warm extension point-walks only K new rows/blobs', async () => {
  const f = historyFixture(4); const full = structuredClone(f.manifest); const boundary = f.rows[1]!;
  f.manifest = { ...full, entity: { ...full.entity, eventCount: 2, headSeq: 1, headHash: boundary.headHash, chainHash: boundary.chainHash, batchCount: 2, lastBatchRowKey: boundary.rowKey, lastBatchBlobName: boundary.blobName } };
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); await reader.read(f.sessionId);
  f.manifest = full; const result = await reader.read(f.sessionId); assert.equal(result?.events.length, 4);
  assert.equal(f.calls.row, 4); assert.equal(f.calls.blob, 4); assert.equal(f.calls.list, 0); await reader.close();
});
test('A7 zero suffix still rejects every malformed tip and exact empty fields', async () => {
  for (const patch of [{ headSeq: 0 }, { headHash: 'd'.repeat(64) }, { batchCount: 1 }, { lastBatchBlobName: 'wrong' }, { lastBatchGeneration: 2 }]) {
    const f = historyFixture(); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); await reader.read(f.sessionId);
    f.manifest = { ...f.manifest, entity: { ...f.manifest.entity, ...patch } };
    await assert.rejects(reader.read(f.sessionId), error => error instanceof AzureSyncError && ['CONFLICT', 'COMMITTED_INDEX_CORRUPT'].includes(error.code));
    assert.equal(f.calls.blob, 2); await reader.close();
  }
  const f = historyFixture(0); f.manifest = { ...f.manifest, entity: { ...f.manifest.entity, lastBatchGeneration: 1 } };
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); await assert.rejects(reader.read(f.sessionId), code('COMMITTED_INDEX_CORRUPT')); await reader.close();
});
test('A8 normal tip advance during delayed network extends rather than pairing stale bytes/new envelope', async () => {
  const f = historyFixture(3); const full = structuredClone(f.manifest); const tip = f.rows[1]!;
  f.manifest = { ...full, entity: { ...full.entity, eventCount: 2, headSeq: 1, headHash: tip.headHash, chainHash: tip.chainHash, batchCount: 2, lastBatchRowKey: tip.rowKey, lastBatchBlobName: tip.blobName } };
  f.beforeBlob = () => { f.manifest = full; };
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); const result = await reader.read(f.sessionId);
  assert.equal(result?.events.length, 3); assert.equal(result?.manifest.entity.eventCount, 3); assert.equal(f.calls.blob, 3); await reader.close();
});
test('A9 control and root drift during waits cannot publish bytes or H', async () => {
  const f = historyFixture(); const wait = deferred(); const started = deferred();
  f.beforeBlob = async () => { started.resolve(); await wait.promise; };
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); const pending = reader.read(f.sessionId); await started.promise;
  f.manifest = { ...f.manifest, entity: { ...f.manifest.entity, enabled: false, state: 'disabled' } }; wait.resolve();
  await assert.rejects(pending, code('DISABLED')); assert.equal((await reader.observe(f.sessionId))?.acceptedPin, undefined); await reader.close();
});
test('A10 rollback/fork after memory eviction and missing manifest retain accepted floor', async () => {
  const f = historyFixture(); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); await reader.read(f.sessionId); reader.invalidate(f.sessionId);
  const good = structuredClone(f.manifest); const first = f.rows[0]!;
  f.manifest = { ...good, entity: { ...good.entity, eventCount: 1, headSeq: 0, headHash: first.headHash, chainHash: first.chainHash, batchCount: 1, lastBatchRowKey: first.rowKey, lastBatchBlobName: first.blobName } };
  await assert.rejects(reader.observe(f.sessionId), code('CONFLICT'));
  f.manifest = { ...good, entity: { ...good.entity, chainHash: 'f'.repeat(64) } }; await assert.rejects(reader.read(f.sessionId), code('CONFLICT'));
  f.clearManifest(); await assert.rejects(reader.read(f.sessionId), code('NOT_FOUND')); await reader.close();
});
test('A14 two callers own a shared fetch independently; sole cancellation stops next IO and close is bounded', async () => {
  const f = historyFixture(); const wait = deferred(); const started = deferred(); f.beforeBlob = async () => { started.resolve(); await wait.promise; };
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); const cancelled = new AbortController();
  const one = reader.read(f.sessionId, { signal: cancelled.signal }); const two = reader.read(f.sessionId); await started.promise;
  cancelled.abort(); await assert.rejects(one, code('CANCELLED')); wait.resolve(); assert.equal((await two)?.events.length, 2); assert.equal(f.calls.blob, 2); await reader.close();
  const sole = historyFixture(); const hang = deferred(); const began = deferred(); sole.beforeBlob = async () => { began.resolve(); await hang.promise; };
  const component = new RemoteSessionReader(sole.repository, { ...bounds, scope }); const abort = new AbortController(); const pending = component.read(sole.sessionId, { signal: abort.signal }); await began.promise; abort.abort();
  await assert.rejects(pending, code('CANCELLED')); await component.close(); assert.equal(sole.calls.blob, 1); hang.resolve();
});
test('A12 pressure fails once, then no repeated history IO; fetch/materialization concurrency bounded', async () => {
  const f = historyFixture(); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope, cache: { memoryBytes: 1, diskBytes: 0 } });
  await assert.rejects(reader.read(f.sessionId), code('LIMIT')); const reads = f.calls.blob; await assert.rejects(reader.read(f.sessionId), code('LIMIT')); assert.equal(f.calls.blob, reads);
  reader.invalidate(f.sessionId); await assert.rejects(reader.read(f.sessionId), code('LIMIT')); assert.equal(f.calls.blob, reads * 2, 'only an explicit retry reopens a pressured unchanged target'); await reader.close();
});
test('A15 upload seeding requires exact confirmed committed row and component-owned complete base', async () => {
  const f = historyFixture(1); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); const receipt = structuredClone(f.manifest);
  const empty = historyFixture(0, f.sessionId).manifest;
  const row = f.rows[0]!; const bytes = f.blobs.get(row.blobName)!;
  const orphan = { ...receipt, entity: { ...receipt.entity, lastBatchBlobName: row.blobName + '-orphan' } };
  assert.equal(await reader.seedConfirmedUpload({ base: empty, row, compressed: bytes, receipt: orphan }), false);
  assert.equal((await reader.observe(f.sessionId))?.acceptedPin, undefined);
  assert.equal(await reader.seedConfirmedUpload({ base: empty, row, compressed: bytes, receipt }), true);
  assert.equal((await reader.read(f.sessionId))?.events.length, 1); assert.equal(f.calls.blob, 0); await reader.close();
});
test('A17 explicit audit bypasses rows and payload cache; sticky remote damage cannot be hidden by a later hit', async () => {
  const f = historyFixture(); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); await reader.read(f.sessionId);
  const tip = f.rows.at(-1)!; const good = f.blobs.get(tip.blobName)!; f.blobs.set(tip.blobName, Buffer.from('damaged'));
  await assert.rejects(reader.audit(f.sessionId), code('CORRUPT_REMOTE')); const reads = f.calls.blob;
  await assert.rejects(reader.read(f.sessionId), code('CORRUPT_REMOTE')); assert.equal(f.calls.blob, reads);
  f.blobs.set(tip.blobName, good); assert.equal((await reader.audit(f.sessionId))?.events.length, 2); assert.equal((await reader.read(f.sessionId))?.events.length, 2); await reader.close();
});
test('A19 actual endpoint namespace isolates accounts; moving tips reuse stable namespace and strip secrets', () => {
  const f = historyFixture(); const id = historyScopeId(scope); const w = historyWatermark(id, f.manifest.entity);
  const endpoint = new URL(scope.blobEndpoint); endpoint.username = 'user'; endpoint.password = 'pass';
  endpoint.searchParams.set('sig', 'synthetic'); endpoint.hash = 'fragment';
  assert.equal(id, historyScopeId({ ...scope, blobEndpoint: endpoint.href }));
  assert.notEqual(id, historyScopeId({ ...scope, table: 'other' })); assert.notEqual(id, historyScopeId({ ...scope, partitionKey: 'other' }));
  const moved = { ...w, eventCount: 900, chainHash: 'b'.repeat(64) };
  assert.equal(historyNamespace(w), historyNamespace(moved));
});
