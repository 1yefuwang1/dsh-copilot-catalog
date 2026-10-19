import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, connect } from 'node:net';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient } from '@azure/data-tables';
import { BlobStore } from '../src/azure/blob.js';
import { TableStore } from '../src/azure/table.js';
import { CloudRepository, candidateBlobName, leaseBlobName } from '../src/sync/cloud-repository.js';
import { TombstoneManager } from '../src/sync/tombstone-manager.js';
import { tombstone } from '../src/sync/tombstone.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { encodeCloudRecord, type LocalSessionRecord } from '../src/schema.js';
import type { LocalStore } from '../src/local/store.js';
import type { TransactionAction } from '@azure/data-tables';
import { LeaseManager } from '../src/azure/lease.js';
import { batchRow, cloudSession, localSession, sessionHeader, HEX_A } from './helpers.js';
import { headerHash } from '../src/sync/chain.js';

const accountKey = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => port > 0 ? resolvePort(port) : reject(new Error('no port')));
    });
  });
}

async function waitPort(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ok = await new Promise<boolean>((resolvePort) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolvePort(true); });
      socket.once('error', () => { socket.destroy(); resolvePort(false); });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`Azurite port ${port} did not open`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

test('real Azurite accepts the private-container, table, and atomic commit contract', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-azurite-'));
  const blobPort = await freePort();
  const tablePort = await freePort();
  const queuePort = await freePort();
  const executable = resolve(fileURLToPath(new URL('.', import.meta.url)), '../node_modules/.bin',
    process.platform === 'win32' ? 'azurite.cmd' : 'azurite');
  const child = spawn(executable, [
    '--silent', '--location', root, '--blobHost', '127.0.0.1', '--blobPort', String(blobPort),
    '--tableHost', '127.0.0.1', '--tablePort', String(tablePort),
    '--queueHost', '127.0.0.1', '--queuePort', String(queuePort), '--skipApiVersionCheck',
  ], { stdio: 'ignore' });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([waitPort(blobPort), waitPort(tablePort), waitPort(queuePort)]);
  const connection = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${accountKey};BlobEndpoint=http://127.0.0.1:${blobPort}/devstoreaccount1;TableEndpoint=http://127.0.0.1:${tablePort}/devstoreaccount1;QueueEndpoint=http://127.0.0.1:${queuePort}/devstoreaccount1;`;
  const blob = new BlobStore(BlobServiceClient.fromConnectionString(connection).getContainerClient('dsh-state'));
  const table = new TableStore(TableClient.fromConnectionString(connection, 'dshstatesync', { allowInsecureConnection: true }));
  await blob.ensurePrivateContainer();
  await table.ensureTable();
  const lease = await new LeaseManager(blob).acquire('v1/leases/azurite-test', 15);
  await new LeaseManager(blob).renew(lease);
  await new LeaseManager(blob).release(lease);
  const repository = new CloudRepository(blob, table);
  const entity = cloudSession({ eventCount: 0, batchCount: 0, lastBatchRowKey: undefined });
  assert.equal(await repository.createManifest(entity), true);
  const before = await repository.getManifest(entity.sessionId);
  assert.ok(before);
  const row = batchRow(entity.sessionId, 1, 0);
  const next = { ...before.entity, eventCount: 1, batchCount: 1, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, chainHash: row.chainHash };
  const after = await repository.commitBatch(before, row, next);
  assert.equal(after.entity.eventCount, 1);
  assert.equal((await repository.getBatch(row.rowKey))?.chainHash, row.chainHash);
  assert.equal(await repository.candidateExists('v1/sessions/missing'), false);

  await t.test('root-first removal resumes failed blob-before-row cleanup, sweeps orphan candidates and held leases, then publishes a new generation', async () => {
    const rootId = 'az-delete-root';
    const rootHeader = sessionHeader({ id: rootId });
    const root = cloudSession({ sessionId: rootId, headerJson: JSON.stringify(rootHeader), headerHash: headerHash(rootHeader, 0), leaseOwner: 'old-owner', leaseUntil: Date.now() + 60_000 });
    const childEntity = cloudSession({ sessionId: 'az-delete-child', rootSessionId: rootId });
    const grandchild = cloudSession({ sessionId: 'az-delete-grandchild', rootSessionId: rootId });
    for (const entity of [root, childEntity, grandchild]) assert.equal(await repository.createManifest(entity), true);
    const rows = [batchRow(rootId, 1, 0), batchRow(childEntity.sessionId, 1, 0), batchRow(grandchild.sessionId, 1, 0)];
    for (const row of rows) {
      assert.equal(await table.insert({ ...encodeCloudRecord(row), partitionKey: row.partitionKey, rowKey: row.rowKey }), true);
      await blob.putIfAbsent(row.blobName, Buffer.from('committed payload'));
    }
    const orphan = candidateBlobName(rootId, 1, 5, 3, HEX_A);
    const childOrphan = candidateBlobName(childEntity.sessionId, 1, 9, 3, HEX_A);
    const futureBlob = candidateBlobName(rootId, 7, 0, 3, HEX_A);
    for (const name of [orphan, childOrphan, futureBlob, 'v1/attachments/retained-delete-test']) await blob.putIfAbsent(name, Buffer.from('retained'));
    const leaseManager = new LeaseManager(blob);
    const oldRootLease = await leaseManager.acquire(leaseBlobName(rootId));
    const oldLeaseIdentity = await blob.identity(leaseBlobName(rootId));
    assert.ok(oldLeaseIdentity);
    await leaseManager.acquire(leaseBlobName(childEntity.sessionId));
    await leaseManager.acquire(leaseBlobName(grandchild.sessionId));
    const records = new Map<string, LocalSessionRecord>([root, childEntity, grandchild].map((entity) => [entity.sessionId, localSession({ sessionId: entity.sessionId, lastSyncedEventCount: 1 })]));
    let lane: Promise<unknown> = Promise.resolve();
    const local = {
      getSession: (id: string) => records.get(id), listSessions: () => records.entries(),
      putSession: async (record: LocalSessionRecord) => { records.set(record.sessionId, record); },
      transactSession: (id: string, fn: (value: LocalSessionRecord | undefined) => LocalSessionRecord | undefined) => {
        const task = lane.then(() => { const next = fn(records.get(id)); if (next !== undefined) { assert.equal(next.sessionId, id); records.set(id, next); } return next; });
        lane = task.then(() => undefined, () => undefined); return task;
      },
    } as unknown as LocalStore;
    const manager = new TombstoneManager(repository, local, () => Date.now(), 'az-delete-device');
    const realDelete = blob.deleteIfExists.bind(blob);
    let failOnce = true;
    blob.deleteIfExists = async (name, etag) => {
      if (failOnce && name === rows[0]!.blobName) {
        failOnce = false;
        throw new AzureSyncError('TRANSIENT', 'injected real-blob delete failure');
      }
      await realDelete(name, etag);
    };
    await assert.rejects(manager.remove(rootId, 1), /injected real-blob/u);
    assert.ok(await repository.getBatch(rows[0]!.rowKey), 'blob failure must preserve the committed row');
    const pending = await repository.getManifest(rootId);
    assert.ok(pending);
    assert.equal(pending.entity.cleanupPending, true);
    assert.equal((await repository.getManifest(childEntity.sessionId))?.entity.state, 'deleted');
    assert.equal((await repository.getManifest(grandchild.sessionId))?.entity.state, 'deleted');
    assert.match(records.get(rootId)?.lastError ?? '', /pending/u);
    await manager.remove(rootId, 1);
    assert.equal((await repository.getManifest(rootId))?.entity.cleanupPending, false);
    for (const row of rows) {
      assert.equal(await repository.getBatch(row.rowKey), undefined);
      assert.equal(await blob.exists(row.blobName), false);
    }
    for (const id of [rootId, childEntity.sessionId, grandchild.sessionId]) {
      assert.equal(await blob.exists(leaseBlobName(id)), false);
      assert.equal(records.get(id)?.state, 'deleted');
      assert.equal(records.get(id)?.lastError, undefined);
    }
    assert.equal(await blob.exists(orphan), false);
    assert.equal(await blob.exists(childOrphan), false);
    assert.equal(await blob.exists(futureBlob), true);
    assert.equal(await blob.exists('v1/attachments/retained-delete-test'), true);
    await assert.rejects(leaseManager.renew(oldRootLease));
    const revived = await manager.resurrect(rootId, 1);
    assert.equal(revived.generation, 2);
    assert.equal(revived.rootGeneration, 2);
    assert.equal(revived.eventCount, 0);
    assert.equal(revived.headSeq, -1);
    assert.equal(records.get(rootId)?.lastSyncedEventCount, undefined);
    const newLease = await leaseManager.acquire(leaseBlobName(rootId));
    await assert.rejects(blob.breakLeaseIfMatch(leaseBlobName(rootId), oldLeaseIdentity.etag), (error: unknown) => error instanceof AzureSyncError && error.code === 'PRECONDITION');
    await assert.rejects(repository.deleteLeaseBlob(pending), /tombstone changed/u);
    await assert.rejects(repository.deleteBatchBlob(rows[0]!.blobName, pending), /tombstone changed/u);
    await leaseManager.renew(newLease);
    await leaseManager.release(newLease);
    const rootBefore = await repository.getManifest(rootId);
    assert.ok(rootBefore);
    const rootRow = batchRow(rootId, 2, 0);
    await blob.putIfAbsent(rootRow.blobName, Buffer.from('new-generation'));
    await repository.commitBatch(rootBefore, rootRow, { ...rootBefore.entity, eventCount: 1, headSeq: 0, batchCount: 1,
      lastBatchRowKey: rootRow.rowKey, lastBatchGeneration: 2, lastBatchBlobName: rootRow.blobName, chainHash: rootRow.chainHash });
    const newChild = cloudSession({ sessionId: 'az-new-child', rootSessionId: rootId, rootGeneration: 2, eventCount: 0,
      batchCount: 0, headSeq: -1, lastBatchRowKey: undefined, lastBatchGeneration: undefined, lastBatchBlobName: undefined });
    assert.equal(await repository.createManifest(newChild), true);
    const childBefore = await repository.getManifest(newChild.sessionId);
    const newRoot = await repository.getManifest(rootId);
    assert.ok(childBefore && newRoot);
    const childRow = batchRow(newChild.sessionId, 1, 0);
    await blob.putIfAbsent(childRow.blobName, Buffer.from('child generation under root 2'));
    const publishedChild = await repository.commitBatch(childBefore, childRow, { ...childBefore.entity, eventCount: 1,
      headSeq: 0, batchCount: 1, lastBatchRowKey: childRow.rowKey, lastBatchGeneration: 1, chainHash: childRow.chainHash }, newRoot);
    assert.equal(publishedChild.entity.rootGeneration, 2);
    assert.ok(await repository.getBatch(rootRow.rowKey));
    assert.ok(await repository.getBatch(childRow.rowKey));
    await assert.rejects(manager.remove(rootId, 1), /generation changed/u);
    await assert.rejects(manager.remove(newChild.sessionId, 1), /root session/u);
  });

  await t.test('row ETag changes refuse deletion, and an already-missing blob remains resumable', async () => {
    const dead = tombstone(cloudSession({ sessionId: 'az-row-etag' }), Date.now(), 'etag-device').entity;
    assert.equal(await repository.createManifest(dead), true);
    const row = batchRow(dead.sessionId, 1, 0);
    assert.equal(await table.insert({ ...encodeCloudRecord(row), partitionKey: row.partitionKey, rowKey: row.rowKey }), true);
    const stored = (await repository.iterateBatchRows(dead.sessionId, 1).next()).value;
    const proof = await repository.getManifest(dead.sessionId);
    assert.ok(stored && proof);
    await table.update({ ...encodeCloudRecord({ ...row, deviceId: 'changed-row' }), partitionKey: row.partitionKey, rowKey: row.rowKey }, stored.etag);
    await assert.rejects(repository.deleteBatchRow(stored, proof), (error: unknown) => error instanceof AzureSyncError && error.code === 'PRECONDITION');
    assert.equal((await repository.getBatch(row.rowKey))?.deviceId, 'changed-row');
    const emptyLocal = { getSession: () => undefined, listSessions: () => new Map<string, LocalSessionRecord>().entries(), transactSession: async (_id: string, fn: (value: LocalSessionRecord | undefined) => LocalSessionRecord | undefined) => fn(undefined) } as unknown as LocalStore;
    await new TombstoneManager(repository, emptyLocal, Date.now, 'etag-device').remove(dead.sessionId, 1);
    assert.equal(await repository.getBatch(row.rowKey), undefined);
    assert.equal((await repository.getManifest(dead.sessionId))?.entity.cleanupPending, false);
  });

  await t.test('root deletion wins against stale child creation and publication transactions', async () => {
    const root = cloudSession({ sessionId: 'az-root-race' });
    assert.equal(await repository.createManifest(root), true);
    const existingChild = cloudSession({ sessionId: 'az-existing-child-race', rootSessionId: root.sessionId });
    assert.equal(await repository.createManifest(existingChild), true);
    const staleRoot = await repository.getManifest(root.sessionId);
    const staleChild = await repository.getManifest(existingChild.sessionId);
    assert.ok(staleRoot && staleChild);
    const raceTable = Object.create(table) as TableStore;
    raceTable.submitTransaction = async (actions: TransactionAction[]) => {
      // The root tombstone lands after createManifest reads its root, before
      // the atomic child create + root touch reaches the actual Table service.
      await repository.updateManifest(tombstone(staleRoot.entity, Date.now(), 'race-device').entity, staleRoot.etag);
      return table.submitTransaction(actions);
    };
    const raced = new CloudRepository(blob, raceTable);
    const child = cloudSession({ sessionId: 'az-new-child-race', rootSessionId: root.sessionId });
    await assert.rejects(raced.createManifest(child), (error: unknown) => error instanceof AzureSyncError && error.code === 'PRECONDITION');
    assert.equal(await repository.getManifest(child.sessionId), undefined);
    const row = batchRow(existingChild.sessionId, 1, 1);
    await assert.rejects(repository.commitBatch(staleChild, row, { ...staleChild.entity, eventCount: 2,
      lastBatchRowKey: row.rowKey, chainHash: row.chainHash }, staleRoot), (error: unknown) => error instanceof AzureSyncError && error.code === 'PRECONDITION');
    assert.equal(await repository.getBatch(row.rowKey), undefined);
    const emptyLocal = { getSession: () => undefined, listSessions: () => new Map<string, LocalSessionRecord>().entries(), transactSession: async (_id: string, fn: (value: LocalSessionRecord | undefined) => LocalSessionRecord | undefined) => fn(undefined) } as unknown as LocalStore;
    await new TombstoneManager(repository, emptyLocal, Date.now, 'race-device').remove(root.sessionId, 1);
    assert.equal((await repository.getManifest(existingChild.sessionId))?.entity.state, 'deleted');
  });
});
