import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chainEvents, emptyChain, genesisHash, headerHash, verifyBatchChain, verifyHeaderBinding } from '../src/sync/chain.js';
import { eventHash, sha256Hex } from '../src/sync/canonical.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { event, sessionHeader } from './helpers.js';

test('header, genesis, and empty chain are deterministic and bound', () => {
  const header = sessionHeader();
  const binding = headerHash(header, 0);
  assert.match(binding, /^[0-9a-f]{64}$/u);
  assert.notEqual(binding, headerHash(header, 1));
  const genesis = genesisHash('session-test', 1, binding);
  assert.equal(emptyChain(genesis), genesis);
  assert.notEqual(genesis, genesisHash('session-test', 2, binding));
  assert.throws(() => genesisHash('', 1, binding), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
  assert.throws(() => genesisHash('session-test', 0, binding), /positive generation/u);
});

test('a batch chain is raw-32-byte cumulative, and metadata verification detects tampering', () => {
  const prev = '0'.repeat(64);
  const events = [event(0), event(1)];
  const chain = chainEvents(prev, events);
  assert.equal(chain.startSeq, 0);
  assert.equal(chain.endSeq, 1);
  assert.equal(chain.eventCount, 2);
  assert.equal(chain.prevChainHash, prev);
  assert.match(chain.chainHash, /^[0-9a-f]{64}$/u);
  assert.equal(chain.headHash, eventHash(events[1]));
  assert.notEqual(chain.chainHash, sha256Hex(prev, eventHash(events[1])), 'raw bytes, not hex ASCII');
  assert.doesNotThrow(() => verifyBatchChain(events, chain));
  assert.throws(() => verifyBatchChain([event(0), { ...event(1), data: { changed: true } }], chain),
    (error: unknown) => error instanceof AzureSyncError && error.code === 'COMMITTED_INDEX_CORRUPT');
  assert.throws(() => verifyBatchChain(events, chain, 'f'.repeat(64)), /genesis/u);
});

test('genesis is required for the first batch and header bindings are exact', () => {
  const header = sessionHeader();
  const binding = headerHash(header, 0);
  assert.doesNotThrow(() => verifyHeaderBinding(header, 0, binding));
  assert.throws(() => verifyHeaderBinding({ ...header, cwd: '/other' }, 0, binding), /header/u);
  const events = [event(0)];
  const chain = chainEvents(binding, events);
  assert.throws(() => verifyBatchChain(events, chain, genesisHash('session-test', 1, binding)),
    (error: unknown) => error instanceof AzureSyncError && error.code === 'COMMITTED_INDEX_CORRUPT');
  assert.doesNotThrow(() => verifyBatchChain(events, chain, binding));
});
