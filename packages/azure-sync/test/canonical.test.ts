import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, eventHash, payloadBytes, payloadHash, sha256Hex, bytes32 } from '../src/sync/canonical.js';
import { AzureSyncError } from '../src/azure/errors.js';

test('canonical JSON sorts keys, strips undefined object properties, and preserves array order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 }, skip: undefined, list: [2, 1] }), '{"a":{"c":3,"d":2},"b":1,"list":[2,1]}');
  assert.equal(canonicalJson({ z: 0, a: -0 }), '{"a":0,"z":0}');
  assert.equal(canonicalJson(1e-7), JSON.stringify(1e-7));
  assert.equal(canonicalJson('line\n"quote"'), JSON.stringify('line\n"quote"'));
});

test('canonical JSON rejects values that are not lossless JSON', () => {
  for (const value of [undefined, 1n, () => 1, Symbol('x'), Number.NaN, Infinity, new Date(), new Map()]) {
    assert.throws(() => canonicalJson(value), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
  }
  const sparse = new Array<number>(2);
  sparse[1] = 1;
  assert.throws(() => canonicalJson(sparse), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  assert.throws(() => canonicalJson(cycle), /cycle/u);
  assert.equal(canonicalJson([{ ok: 1, bad: undefined }]), '[{"ok":1}]');
});

test('payload bytes are one canonical JSON record plus one newline per event', () => {
  const events = [{ seq: 0, type: 'a' }, { seq: 1, type: 'b' }];
  const bytes = payloadBytes(events);
  assert.equal(bytes.toString('utf8'), '{"seq":0,"type":"a"}\n{"seq":1,"type":"b"}\n');
  assert.equal(payloadBytes([]).byteLength, 0);
  assert.equal(payloadHash([]), sha256Hex(''));
  assert.notEqual(eventHash(events[0]), eventHash(events[1]));
});

test('32-byte digest storage round-trips and rejects malformed hex', () => {
  const hex = 'a'.repeat(64);
  assert.equal(bytes32(hex).byteLength, 32);
  assert.throws(() => bytes32('a'.repeat(63)), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
  assert.throws(() => bytes32('A'.repeat(64)), /hex/u);
});
