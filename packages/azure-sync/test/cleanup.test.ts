import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGenerationBlob, assertGenerationRow, generationBlobPrefix, planCleanup } from '../src/sync/cleanup.js';
import { candidateBlobName } from '../src/sync/cloud-repository.js';
import { batchRow, cloudSession, HEX_A } from './helpers.js';

test('cleanup accepts only exact encoded session/generation candidate names', () => {
  const sessionId = 'root/a 雪';
  const name = candidateBlobName(sessionId, 2, 0, 4, HEX_A);
  assert.equal(name.startsWith(generationBlobPrefix(sessionId, 2)), true);
  assert.doesNotThrow(() => assertGenerationBlob(name, sessionId, 2));
  for (const bad of [candidateBlobName(sessionId, 20, 0, 4, HEX_A), candidateBlobName('other', 2, 0, 4, HEX_A),
    'v1/attachments/shared', `${generationBlobPrefix(sessionId, 2)}../shared`, `${generationBlobPrefix(sessionId, 2)}unexpected`]) {
    assert.throws(() => assertGenerationBlob(bad, sessionId, 2), /outside/u);
  }
});

test('cleanup rejects mismatched row properties, row keys, partitions, and attachment references', () => {
  const row = batchRow('s', 2, 0);
  assert.doesNotThrow(() => assertGenerationRow(row, 's', 2, 'account'));
  for (const invalid of [{ ...row, sessionId: 'other' }, { ...row, generation: 3 },
    { ...row, partitionKey: 'other' }, { ...row, rowKey: batchRow('s', 3, 0).rowKey },
    { ...row, blobName: 'v1/attachments/keep' }]) {
    assert.throws(() => assertGenerationRow(invalid, 's', 2, 'account'));
  }
  const dead = cloudSession({ sessionId: 's', generation: 2, state: 'deleted' });
  assert.throws(() => planCleanup([{ ...row, blobName: 'v1/attachments/keep' }], dead));
});
