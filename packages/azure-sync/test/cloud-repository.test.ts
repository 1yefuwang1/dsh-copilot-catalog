import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TransactionAction } from '@azure/data-tables';
import { CloudRepository } from '../src/sync/cloud-repository.js';
import type { BlobStore } from '../src/azure/blob.js';
import type { TableStore } from '../src/azure/table.js';
import { encodeCloudRecord, type CloudSessionEntity } from '../src/schema.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { batchRow, cloudSession } from './helpers.js';

test('commitBatch creates the row and advances the tip with the manifest ETag', async () => {
  const session = cloudSession({ eventCount: 0, batchCount: 0, lastBatchRowKey: undefined, chainHash: 'a'.repeat(64) });
  let stored: Record<string, unknown> = { ...encodeCloudRecord(session), etag: 'etag-1' };
  let actions: TransactionAction[] = [];
  const row = batchRow(session.sessionId, 1, 0);
  const next: CloudSessionEntity = { ...session, eventCount: 1, batchCount: 1, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, chainHash: row.chainHash };
  const table = {
    get: async () => ({ value: stored, etag: String(stored['etag']) }),
    submitTransaction: async (nextActions: TransactionAction[]) => {
      actions = nextActions;
      stored = { ...encodeCloudRecord(next), etag: 'etag-2' };
      return { subResponses: [], status: 204 };
    },
  } as unknown as TableStore;
  const repository = new CloudRepository({} as BlobStore, table);
  const before = await repository.getManifest(session.sessionId);
  assert.ok(before);
  const after = await repository.commitBatch(before, row, next);
  assert.equal(actions[0]?.[0], 'create');
  assert.equal(actions[1]?.[0], 'update');
  assert.deepEqual(actions[1]?.[3], { etag: 'etag-1' });
  assert.equal(after.entity.eventCount, 1);
  assert.equal(after.etag, 'etag-2');
});

test('a transaction that loses the ETag race re-reads the committed tip', async () => {
  const session = cloudSession();
  const row = batchRow(session.sessionId, 1, 1, { prevBatchRowKey: session.lastBatchRowKey });
  const committed: CloudSessionEntity = { ...session, eventCount: 2, lastBatchRowKey: row.rowKey, chainHash: row.chainHash };
  let calls = 0;
  const table = {
    get: async () => ({ value: { ...encodeCloudRecord(calls === 0 ? session : committed), etag: 'etag-2' }, etag: 'etag-2' }),
    submitTransaction: async () => {
      calls += 1;
      throw new AzureSyncError('PRECONDITION', 'race');
    },
  } as unknown as TableStore;
  const repository = new CloudRepository({} as BlobStore, table);
  const before = await repository.getManifest(session.sessionId);
  assert.ok(before);
  const after = await repository.commitBatch(before, row, committed);
  assert.equal(after.entity.lastBatchRowKey, row.rowKey);
  assert.equal(after.entity.chainHash, row.chainHash);
});

test('a child transaction includes an active root-row conditional touch', async () => {
  const child = cloudSession({ sessionId: 'child', rootSessionId: 'root', rootGeneration: 1 });
  const root = cloudSession({ sessionId: 'root', generation: 1, state: 'active', rootSessionId: 'root' });
  let actions: TransactionAction[] = [];
  const table = {
    get: async () => ({ value: { ...encodeCloudRecord(child), etag: 'etag-child' }, etag: 'etag-child' }),
    submitTransaction: async (nextActions: TransactionAction[]) => { actions = nextActions; return { subResponses: [], status: 204 }; },
  } as unknown as TableStore;
  const repository = new CloudRepository({} as BlobStore, table);
  const before = await repository.getManifest('child');
  assert.ok(before);
  const row = batchRow('child', 1, 0);
  const next = { ...child, eventCount: 1, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, chainHash: row.chainHash };
  await repository.commitBatch(before, row, next, { entity: root, etag: 'etag-root' });
  assert.equal(actions.length, 3);
  assert.deepEqual(actions[2]?.[3], { etag: 'etag-root' });
  await assert.rejects(repository.commitBatch(before, row, next, { entity: { ...root, state: 'deleted' }, etag: 'etag-root' }));
});
