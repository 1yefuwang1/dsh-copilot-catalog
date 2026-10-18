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
import { CloudRepository } from '../src/sync/cloud-repository.js';
import { LeaseManager } from '../src/azure/lease.js';
import { batchRow, cloudSession } from './helpers.js';

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
});
