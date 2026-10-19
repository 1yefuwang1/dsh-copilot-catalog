import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TransactionAction } from '@azure/data-tables';
import { CloudRepository, candidateBlobName, leaseBlobName } from '../src/sync/cloud-repository.js';
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

test('publication rejects invalid complete records before any cloud mutation', async () => {
  const session = cloudSession();
  const row = batchRow(session.sessionId, session.generation, 0);
  let mutations = 0;
  const table = { submitTransaction: async () => { mutations++; }, insert: async () => { mutations++; }, update: async () => { mutations++; } } as unknown as TableStore;
  const repository = new CloudRepository({} as BlobStore, table);
  const proof = { entity: session, etag: 'etag' };
  const invalid = (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD';
  await assert.rejects(repository.commitBatch(proof, { ...row, deviceId: 'x'.repeat(257) }, session), invalid);
  await assert.rejects(repository.commitBatch(proof, row, { ...session, sourceDeviceId: 'x'.repeat(257) }), invalid);
  await assert.rejects(repository.createManifest({ ...session, sourceDeviceId: 'x'.repeat(257) }), invalid);
  await assert.rejects(repository.updateManifest({ ...session, sourceDeviceId: 'x'.repeat(257) }, 'etag'), invalid);
  assert.equal(mutations, 0);
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
  let storedChild = child;
  let childETag = 'etag-child';
  const table = {
    get: async (_partition: string, key: string) => ({ value: { ...encodeCloudRecord(key === root.rowKey ? root : storedChild), etag: key === root.rowKey ? 'etag-root' : childETag } }),
    submitTransaction: async (nextActions: TransactionAction[]) => { actions = nextActions; storedChild = next; childETag = 'etag-accepted-child'; return { subResponses: [], status: 204 }; },
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
  await assert.rejects(repository.commitBatch(before, row, next, { entity: { ...root, sessionId: 'wrong-root' }, etag: 'etag-root' }));
});

test('child manifest creation atomically fences the real active root and propagates delete races', async () => {
  const root = cloudSession({ sessionId: 'root', generation: 2 });
  const child = cloudSession({ sessionId: 'child', rootSessionId: 'root', rootGeneration: 2 });
  let current = root;
  let actions: TransactionAction[] = [];
  let race = false;
  const table = {
    get: async () => ({ value: { ...encodeCloudRecord(current), etag: 'root-etag' } }),
    submitTransaction: async (received: TransactionAction[]) => {
      actions = received;
      if (race) throw new AzureSyncError('PRECONDITION', 'root removed');
    },
  } as unknown as TableStore;
  const repository = new CloudRepository({} as BlobStore, table);
  assert.equal(await repository.createManifest(child), true);
  assert.equal(actions[0]?.[0], 'create');
  assert.deepEqual(actions[1]?.[3], { etag: 'root-etag' });
  assert.equal(actions[1]?.[1].rowKey, root.rowKey);
  current = { ...root, state: 'deleted' };
  await assert.rejects(repository.createManifest(child), (error: unknown) => error instanceof AzureSyncError && error.code === 'GENERATION_CHANGED');
  current = root;
  race = true;
  await assert.rejects(repository.createManifest(child), (error: unknown) => error instanceof AzureSyncError && error.code === 'PRECONDITION');
  await assert.rejects(repository.createManifest({ ...root, rootGeneration: 1 }), /root generation/u);
});

test('active child manifest updates also fence ownership and re-enable against the root', async () => {
  const root = cloudSession({ sessionId: 'root' });
  const child = cloudSession({ sessionId: 'child', rootSessionId: 'root', leaseOwner: 'writer', leaseUntil: 300 });
  let current = root;
  let actions: TransactionAction[] = [];
  const table = {
    get: async () => ({ value: { ...encodeCloudRecord(current), etag: 'root-etag' } }),
    submitTransaction: async (received: TransactionAction[]) => { actions = received; },
  } as unknown as TableStore;
  const repository = new CloudRepository({} as BlobStore, table);
  await repository.updateManifest(child, 'child-etag');
  assert.deepEqual(actions[0]?.[3], { etag: 'child-etag' });
  assert.deepEqual(actions[1]?.[3], { etag: 'root-etag' });
  current = { ...root, state: 'deleted', enabled: false };
  await assert.rejects(repository.updateManifest(child, 'child-etag'), /root is not active/u);
  await assert.rejects(repository.updateManifest({ ...current, leaseOwner: 'bad-writer' }, 'root-etag'), /tombstone cannot/u);
});

test('idempotent commit retries never report a tombstoned tip as successfully active', async () => {
  const session = cloudSession({ sessionId: 'root' });
  const row = batchRow('root', 1, 0, { chainHash: session.chainHash });
  const table = {
    get: async () => ({ value: { ...encodeCloudRecord({ ...session, state: 'deleted', enabled: false }), etag: 'dead-etag' } }),
    submitTransaction: async () => { throw new AzureSyncError('PRECONDITION', 'deleted'); },
  } as unknown as TableStore;
  const repository = new CloudRepository({} as BlobStore, table);
  await assert.rejects(repository.commitBatch({ entity: session, etag: 'old-etag' }, row, session), /tip changed/u);
});

test('checked cleanup uses row and blob ETags, rejects untrusted references and stale tombstones', async () => {
  const dead = cloudSession({ sessionId: 'root', state: 'deleted', enabled: false, cleanupPending: true });
  let current = dead;
  let currentETag = 'dead-etag';
  const deleted: unknown[][] = [];
  const table = {
    get: async () => ({ value: { ...encodeCloudRecord(current), etag: currentETag } }),
    delete: async (...args: unknown[]) => { deleted.push(args); },
  } as unknown as TableStore;
  const blob = {
    identity: async () => ({ etag: 'blob-etag', leased: false }),
    deleteIfExists: async (...args: unknown[]) => { deleted.push(args); },
  } as unknown as BlobStore;
  const repository = new CloudRepository(blob, table);
  const stored = { entity: dead, etag: 'dead-etag' };
  const row = batchRow('root', 1, 0);
  await repository.deleteBatchBlob(row.blobName, stored);
  await repository.deleteBatchRow({ entity: row, etag: 'row-etag' }, stored);
  assert.deepEqual(deleted, [[row.blobName, 'blob-etag'], ['account', row.rowKey, 'row-etag']]);
  await assert.rejects(repository.deleteBatchBlob('v1/attachments/shared', stored), /outside/u);
  await assert.rejects(repository.deleteBatchRow({ entity: { ...row, sessionId: 'other' }, etag: 'row-etag' }, stored), /generation key/u);
  current = { ...dead, state: 'active', generation: 2, previousGeneration: 1 };
  currentETag = 'new-etag';
  await assert.rejects(repository.deleteBatchBlob(row.blobName, stored), /tombstone changed/u);
  await assert.rejects(repository.deleteBatchRow({ entity: row, etag: 'row-etag' }, stored), /tombstone changed/u);
  assert.equal(deleted.length, 2);
});

test('lease cleanup snapshots ETag before the manifest check and fences delayed new-generation lease deletion', async () => {
  const dead = cloudSession({ sessionId: 'root', state: 'deleted', enabled: false, cleanupPending: true });
  const events: string[] = [];
  let current = dead;
  let etag = 'dead-etag';
  let blobETag = 'old-lease-etag';
  let beforeBreak: (() => void) | undefined;
  const table = { get: async () => {
    events.push('manifest');
    return { value: { ...encodeCloudRecord(current), etag } };
  } } as unknown as TableStore;
  const blob = {
    identity: async () => { events.push('identity'); return { etag: blobETag, leased: true }; },
    breakLeaseIfMatch: async (name: string, expected: string) => {
      events.push('break');
      assert.equal(name, leaseBlobName('root'));
      beforeBreak?.();
      if (expected !== blobETag) throw new AzureSyncError('PRECONDITION', 'lease recreated');
    },
    deleteIfExists: async (_name: string, expected: string) => { events.push('delete'); assert.equal(expected, blobETag); },
  } as unknown as BlobStore;
  const repository = new CloudRepository(blob, table);
  const stored = { entity: dead, etag };
  await repository.deleteLeaseBlob(stored);
  assert.deepEqual(events, ['identity', 'manifest', 'break', 'delete']);
  beforeBreak = () => {
    current = { ...dead, state: 'active', generation: 2, rootGeneration: 2 };
    etag = 'revived-etag';
    blobETag = 'new-lease-etag';
  };
  events.length = 0;
  await assert.rejects(repository.deleteLeaseBlob(stored), /lease recreated/u);
  assert.deepEqual(events, ['identity', 'manifest', 'break']);
  events.length = 0;
  await assert.rejects(repository.deleteLeaseBlob(stored), /tombstone changed/u);
  assert.deepEqual(events, ['identity', 'manifest']);
});

test('generation candidate listing validates every orphan name and session-prefix boundary', async () => {
  const good = candidateBlobName('root', 1, 0, 1, 'a'.repeat(64));
  const blob = { list: async function* (prefix: string) {
    assert.equal(prefix, 'v1/sessions/cm9vdA/gen-1/batches/');
    yield { name: good, sizeBytes: 3 };
    yield { name: 'v1/attachments/shared', sizeBytes: 3 };
  } } as unknown as BlobStore;
  const repository = new CloudRepository(blob, {} as TableStore);
  const names: string[] = [];
  await assert.rejects(async () => { for await (const name of repository.listGenerationBlobs('root', 1)) names.push(name); }, /outside/u);
  assert.deepEqual(names, [good]);
});
