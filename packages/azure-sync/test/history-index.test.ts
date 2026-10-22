import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectCommittedChain, selectCommittedSuffix } from '../src/sync/committed-index.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { bounds, deferred, historyFixture, scope } from './history-fixture.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { HistorySemaphore, HistoryOwner } from '../src/sync/history-work.js';
import { candidateBlobName } from '../src/sync/cloud-repository.js';
import { genesisHash } from '../src/sync/chain.js';
import { randomUUID } from 'node:crypto';
import type { ResurrectionIntent } from '../src/schema.js';
const corrupt = (error: unknown) => error instanceof AzureSyncError && error.code === 'COMMITTED_INDEX_CORRUPT';
test('A7 chosen-chain corruption matrix rejects exact row/partition/range/link/batch/tip fields', async () => {
  for (const mutate of [
    (f: ReturnType<typeof historyFixture>) => { f.rows[1]!.partitionKey = 'other'; },
    (f: ReturnType<typeof historyFixture>) => { f.rows[1]!.rowKey += '-wrong'; },
    (f: ReturnType<typeof historyFixture>) => { f.rows[1]!.sessionId = 'other'; },
    (f: ReturnType<typeof historyFixture>) => { f.rows[1]!.prevChainHash = 'f'.repeat(64); },
    (f: ReturnType<typeof historyFixture>) => { f.rows[1]!.eventCount = 0; },
    (f: ReturnType<typeof historyFixture>) => { f.rows[1]!.startSeq = Number.MAX_SAFE_INTEGER + 1; },
    (f: ReturnType<typeof historyFixture>) => { f.rows[1]!.prevBatchRowKey = f.rows[1]!.rowKey; },
    (f: ReturnType<typeof historyFixture>) => { f.rows[1]!.prevBatchRowKey = undefined; },
    (f: ReturnType<typeof historyFixture>) => { f.rows[1]!.blobName = candidateBlobName(f.sessionId, 2, 1, 1, f.rows[1]!.payloadHash); },
    (f: ReturnType<typeof historyFixture>) => { f.manifest.entity.headHash = 'a'.repeat(64); },
    (f: ReturnType<typeof historyFixture>) => { f.manifest.entity.batchCount = 3; },
    (f: ReturnType<typeof historyFixture>) => { f.manifest.entity.lastBatchBlobName = f.rows[0]!.blobName; },
  ]) {
    const f = historyFixture(); mutate(f);
    await assert.rejects(selectCommittedSuffix(f.manifest.entity, async key => f.rows.find(row => row.rowKey === key)), corrupt);
  }
});
test('A7 suffix exact boundary cannot be spoofed by row key or chain alone; traversal bound applies before IO', async () => {
  const f = historyFixture(3); const row = f.rows[0]!; const lower = { ...f.manifest.entity, eventCount: 1, headSeq: 0, headHash: row.headHash, chainHash: row.chainHash, batchCount: 1, lastBatchRowKey: row.rowKey, lastBatchBlobName: row.blobName };
  const anchor = { manifest: lower, rows: [row] }; let reads = 0;
  assert.equal((await selectCommittedSuffix(f.manifest.entity, async key => { reads += 1; return f.rows.find(row => row.rowKey === key); }, anchor)).rows.length, 2); assert.equal(reads, 2);
  reads = 0; await assert.rejects(selectCommittedSuffix(f.manifest.entity, async () => { reads += 1; return undefined; }, anchor, 1), error => error instanceof AzureSyncError && error.code === 'LIMIT'); assert.equal(reads, 0);
  await assert.rejects(selectCommittedSuffix(f.manifest.entity, async key => f.rows.find(row => row.rowKey === key), { ...anchor, manifest: { ...lower, headHash: 'f'.repeat(64) } }), corrupt);
  const different = { ...row, chainHash: 'e'.repeat(64) };
  await assert.rejects(selectCommittedSuffix(f.manifest.entity, async key => f.rows.find(row => row.rowKey === key), { manifest: { ...lower, chainHash: different.chainHash }, rows: [different] }), corrupt);
});
test('A7 historical createdEpoch is not the current writer epoch', () => {
  const f = historyFixture(); f.manifest.entity.writerEpoch = 99; assert.equal(selectCommittedChain(f.manifest.entity, f.rows).rows.length, 2);
});
test('A14 semaphore never exceeds materialization capacity and canceled queued callers start no work', async () => {
  const semaphore = new HistorySemaphore(2); const runtime = new AbortController(); const owner = new HistoryOwner({}, runtime.signal);
  const one = await semaphore.acquire(owner); const two = await semaphore.acquire(owner); const aborted = new AbortController();
  const waiting = semaphore.acquire(new HistoryOwner({ signal: aborted.signal }, runtime.signal)); aborted.abort(); await assert.rejects(waiting, error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  one(); const three = await semaphore.acquire(owner); three(); two();
});
test('A9 fresh root drift during payload wait rejects publication; no root proof comes from cached bytes', async () => {
  const f = historyFixture(); const root = historyFixture(0, 'root'); f.manifest.entity.rootSessionId = root.sessionId;
  const get = f.repository.getManifest.bind(f.repository); f.repository.getManifest = async id => id === root.sessionId ? structuredClone(root.manifest) : get(id);
  const started = deferred(); const gate = deferred(); f.beforeBlob = async () => { started.resolve(); await gate.promise; };
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); const pending = reader.read(f.sessionId); await started.promise;
  root.manifest.entity.enabled = false; root.manifest.entity.state = 'disabled'; gate.resolve();
  await assert.rejects(pending, error => error instanceof AzureSyncError && error.code === 'GENERATION_CHANGED'); await reader.close();
});
test('A9 explicit durable resurrection intent admits empty genesis only and cannot auto-adopt', async () => {
  const f = historyFixture(); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); await reader.read(f.sessionId);
  const previous = structuredClone(f.manifest); const generation = 2; const operationId = randomUUID(); const genesis = genesisHash(f.sessionId, generation, previous.entity.headerHash);
  const target = { ...previous.entity, generation, rootGeneration: generation, previousGeneration: 1, resurrectionId: operationId, eventCount: 0, headSeq: -1, headHash: genesis, chainHash: genesis, batchCount: 0, lastBatchRowKey: undefined, lastBatchGeneration: undefined, lastBatchBlobName: undefined };
  const intent: ResurrectionIntent = { operationId, priorGeneration: 1, targetGeneration: 2, priorState: 'deleted', sourceETag: previous.etag, genesisHash: genesis, target };
  f.manifest = { entity: target, etag: 'resurrected' }; await assert.rejects(reader.observe(f.sessionId), error => error instanceof AzureSyncError && error.code === 'GENERATION_CHANGED');
  await reader.confirmGenerationActivation(intent, f.manifest, { check: () => {} }); assert.equal((await reader.observe(f.sessionId))?.acceptedPin?.eventCount, 0);
  await reader.confirmGenerationActivation(intent, f.manifest, { check: () => {} }); assert.equal((await reader.read(f.sessionId))?.events.length, 0); await reader.close();
  const legacy = new RemoteSessionReader(f.repository, { ...bounds, scope }); await legacy.confirmGenerationActivation(intent, f.manifest, { check: () => {} }); assert.equal((await legacy.observe(f.sessionId))?.acceptedPin?.eventCount, 0); await legacy.close();
});
