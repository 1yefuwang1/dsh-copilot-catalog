import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import type { CloudRepository, StoredManifest } from '../src/sync/cloud-repository.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { batchRow, cloudSession, event, sessionHeader } from './helpers.js';
import { AzureSyncError } from '../src/azure/errors.js';

function fixture(corrupt = false) {
  const sessionId = 'session-test';
  const header = sessionHeader({ id: sessionId });
  const binding = headerHash(header, 0);
  const genesis = genesisHash(sessionId, 1, binding);
  const e0 = event(0);
  const e1 = event(1);
  const c0 = chainEvents(genesis, [e0]);
  const c1 = chainEvents(c0.chainHash, [e1]);
  const row0 = batchRow(sessionId, 1, 0, { endSeq: 0, eventCount: 1, prevChainHash: genesis, chainHash: c0.chainHash, headHash: c0.headHash, payloadHash: c0.payloadHash });
  const row1 = batchRow(sessionId, 1, 1, { endSeq: 1, eventCount: 1, prevChainHash: c0.chainHash, chainHash: c1.chainHash, headHash: c1.headHash, payloadHash: c1.payloadHash, prevBatchRowKey: row0.rowKey });
  const entity = cloudSession({ sessionId, headerHash: binding, eventCount: 2, headSeq: 1, headHash: c1.headHash, chainHash: c1.chainHash, lastBatchRowKey: row1.rowKey, lastBatchGeneration: 1, lastBatchBlobName: row1.blobName, batchCount: 2 });
  const manifest: StoredManifest = { entity, etag: 'etag-1' };
  const blobs = new Map<string, Buffer>([
    [row0.blobName, corrupt ? gzipSync(Buffer.from('{"broken":true}\n')) : gzipSync(payloadBytes([e0]))],
    [row1.blobName, gzipSync(payloadBytes([e1]))],
  ]);
  const repository = {
    getManifest: async () => manifest,
    getBatch: async (key: string) => [row0, row1].find(row => row.rowKey === key),
    listBatchRows: async () => [row0, row1],
    readCandidate: async (name: string) => blobs.get(name) ?? Buffer.alloc(0),
  } as unknown as CloudRepository;
  return { repository, row0, row1, header };
}

test('remote reader verifies the linked chain and returns the canonical events', async () => {
  const f = fixture();
  const reader = new RemoteSessionReader(f.repository, { maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576 });
  const remote = await reader.read('session-test');
  assert.ok(remote);
  assert.equal(remote.header.id, 'session-test');
  assert.deepEqual(remote.events.map((event) => event.seq), [0, 1]);
});

test('remote reader refuses a committed payload that does not match its chain', async () => {
  const f = fixture(true);
  const reader = new RemoteSessionReader(f.repository, { maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576 });
  await assert.rejects(reader.read('session-test'), (error: unknown) => error instanceof AzureSyncError && (error.code === 'CORRUPT_REMOTE' || error.code === 'COMMITTED_INDEX_CORRUPT'));
});

test('remote reader rejects v3, wrong identity, and non-canonical raw payload bytes', async () => {
  const base = fixture();
  const manifest = await base.repository.getManifest('session-test');
  assert.ok(manifest);
  const wrongVersion = { ...manifest, entity: { ...manifest.entity, formatVersion: 3 }, etag: 'e' };
  const wrongIdentity = { ...manifest, entity: { ...manifest.entity, sessionId: 'other' }, etag: 'e' };
  for (const [candidate, code] of [[wrongVersion, 'INCOMPATIBLE_FORMAT'], [wrongIdentity, 'CORRUPT_REMOTE']] as const) {
    const repo = { ...base.repository, getManifest: async () => candidate } as unknown as CloudRepository;
    await assert.rejects(new RemoteSessionReader(repo, { maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576 }).read('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === code);
  }
  const raw = { ...base.repository, readCandidate: async () => gzipSync(Buffer.from('{"seq":0, "type":"user/message","time":1,"data":{}}\n')) } as unknown as CloudRepository;
  await assert.rejects(new RemoteSessionReader(raw, { maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576 }).read('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'CORRUPT_REMOTE');
});
