import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { selectCommittedChain } from '../src/sync/committed-index.js';
import { batchRowKey } from '../src/schema.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { batchRow, cloudSession, event, sessionHeader } from './helpers.js';

function fixture() {
  const sessionId = 'session-test';
  const header = sessionHeader({ id: sessionId });
  const binding = headerHash(header, 0);
  const genesis = genesisHash(sessionId, 1, binding);
  const c0 = chainEvents(genesis, [event(0)]);
  const c1 = chainEvents(c0.chainHash, [event(1)]);
  const row0 = batchRow(sessionId, 1, 0, {
    startSeq: 0, endSeq: 0, eventCount: 1, prevChainHash: genesis, chainHash: c0.chainHash,
    headHash: c0.headHash, payloadHash: c0.payloadHash,
  });
  const row1 = batchRow(sessionId, 1, 1, {
    startSeq: 1, endSeq: 1, eventCount: 1, prevChainHash: c0.chainHash, chainHash: c1.chainHash,
    headHash: c1.headHash, payloadHash: c1.payloadHash, prevBatchRowKey: row0.rowKey,
  });
  const manifest = cloudSession({
    sessionId, headerHash: binding, eventCount: 2, chainHash: c1.chainHash,
    lastBatchRowKey: row1.rowKey, lastBatchGeneration: 1, batchCount: 2,
  });
  return { sessionId, binding, genesis, row0, row1, manifest, c0, c1 };
}

const corrupt = (error: unknown) => error instanceof AzureSyncError && error.code === 'COMMITTED_INDEX_CORRUPT';

test('the linked tip chain is selected in order and unchosen siblings are ignored', () => {
  const f = fixture();
  const sibling = batchRow(f.sessionId, 1, 2, {
    chainHash: 'd'.repeat(64), headHash: 'e'.repeat(64), payloadHash: 'f'.repeat(64),
  });
  const chain = selectCommittedChain(f.manifest, [f.row1, sibling, f.row0]);
  assert.deepEqual(chain.rows.map((row) => row.rowKey), [f.row0.rowKey, f.row1.rowKey]);
  assert.equal(chain.genesis, f.genesis);
});

test('an empty manifest binds to genesis and has no tip', () => {
  const f = fixture();
  const empty = cloudSession({
    sessionId: f.sessionId, headerHash: f.binding, eventCount: 0, chainHash: f.genesis,
    lastBatchRowKey: undefined, batchCount: 0,
  });
  assert.deepEqual(selectCommittedChain(empty, []).rows, []);
  assert.deepEqual(selectCommittedChain(empty, [f.row0]).rows, []);
});

test('gaps, missing links, wrong chains, and generation mismatches refuse', () => {
  const f = fixture();
  assert.throws(() => selectCommittedChain(f.manifest, [f.row1]), corrupt);
  assert.throws(() => selectCommittedChain({ ...f.manifest, lastBatchRowKey: batchRowKey(f.sessionId, 1, 2) }, [f.row0, f.row1]), corrupt);
  assert.throws(() => selectCommittedChain({ ...f.manifest, chainHash: '0'.repeat(64) }, [f.row0, f.row1]), corrupt);
  assert.throws(() => selectCommittedChain(f.manifest, [{ ...f.row1, generation: 2 }, f.row0]), corrupt);
  assert.throws(() => selectCommittedChain(f.manifest, [f.row0, { ...f.row1, prevBatchRowKey: undefined }]), corrupt);
  assert.throws(() => selectCommittedChain(f.manifest, [f.row0, { ...f.row1, prevChainHash: '0'.repeat(64) }]), corrupt);
  assert.throws(() => selectCommittedChain(f.manifest, [f.row0, { ...f.row1, eventCount: 5 }]), corrupt);
});
