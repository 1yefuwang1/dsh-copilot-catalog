import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  attachmentMetadataSchema, batchBlobMetadataSchema, batchRowKey, batchRowSchema, cloudSessionEntitySchema, decodeCloudRecord, decodeKeyPart, decodeNameB64, encodeCloudRecord, encodeNameB64, MAX_TABLE_STRING,
  encodeKeyPart, localSessionRecordSchema, parseBatchRowKey, parseRecord, pathMappingSchema, sessionRowKey,
} from '../src/schema.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { batchRow, cloudSession, localSession, pathMapping } from './helpers.js';

test('valid cloud and local records parse; unknown fields and versions refuse', () => {
  assert.doesNotThrow(() => cloudSessionEntitySchema.parse(cloudSession()));
  assert.doesNotThrow(() => batchRowSchema.parse(batchRow('session-test', 1, 0)));
  assert.doesNotThrow(() => localSessionRecordSchema.parse(localSession()));
  assert.doesNotThrow(() => pathMappingSchema.parse(pathMapping()));
  assert.throws(() => cloudSessionEntitySchema.parse({ ...cloudSession(), schemaVersion: 3 }));
  assert.throws(() => cloudSessionEntitySchema.parse({ ...cloudSession(), extra: true }));
  assert.throws(() => localSessionRecordSchema.parse({ ...localSession(), status: 'not-a-status' }));
  assert.throws(() => pathMappingSchema.parse({ ...pathMapping(), id: 'not-a-uuid' }));
});

test('Table/blob key encoding is reversible and generation-qualified', () => {
  const id = `session-${randomUUID()}/with spaces`;
  assert.equal(decodeKeyPart(encodeKeyPart(id)), id);
  assert.equal(sessionRowKey(id), `session:${encodeKeyPart(id)}`);
  const key = batchRowKey(id, 2, 7);
  assert.equal(key, `batch:${encodeKeyPart(id)}:gen-2:000000000007`);
  assert.deepEqual(parseBatchRowKey(key), { sessionId: id, generation: 2, startSeq: 7 });
  assert.throws(() => parseBatchRowKey('batch:abc:0'), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
  assert.throws(() => batchRowKey(id, 0, 0), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
});

test('Blob metadata uses lowercase keys and rejects unsafe values', () => {
  const metadata = {
    startseq: '0', endseq: '1', eventcount: '2', prevchainhash: 'a'.repeat(64), chainhash: 'b'.repeat(64),
    headhash: 'c'.repeat(64), headerhash: 'd'.repeat(64), generation: '1', createdepoch: '1',
    deviceid: 'device-a', schemaversion: '4', payloadhash: 'e'.repeat(64),
  };
  assert.doesNotThrow(() => batchBlobMetadataSchema.parse(metadata));
  assert.throws(() => batchBlobMetadataSchema.parse({ ...metadata, startSeq: '0' }));
  assert.throws(() => batchBlobMetadataSchema.parse({ ...metadata, chainhash: 'not-hex' }));
});

test('parseRecord reports a redacted stable failure without echoing the value', () => {
  const suspicious = ['synthetic', 'secret'].join('-');
  assert.throws(() => parseRecord(localSessionRecordSchema, { value: suspicious }, 'session record'),
    (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD' && !error.message.includes(suspicious));
});

test('Unicode display names use base64url metadata and 32K bounds refuse overflow', () => {
  const name = '资料/会话 名.jsonl.gz';
  const encoded = encodeNameB64(name);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/u);
  assert.equal(decodeNameB64(encoded), name);
  assert.doesNotThrow(() => attachmentMetadataSchema.parse({
    attachmentid: 'attachment-1', kind: 'file', bytes: '12', mediatype: 'application/octet-stream',
    nameb64: encoded, sha256: 'a'.repeat(64),
  }));
  assert.throws(() => attachmentMetadataSchema.parse({ attachmentid: 'a', kind: 'file', bytes: '1', mediatype: 'x', nameb64: name, sha256: 'a'.repeat(64) }));
  assert.throws(() => cloudSessionEntitySchema.parse({ ...cloudSession(), title: 'x'.repeat(MAX_TABLE_STRING + 1) }));
});

test('epoch/count fields are bounded safe Int64 values', () => {
  const parsed = cloudSessionEntitySchema.parse({ ...cloudSession(), updatedAt: 1_700_000_000_000, eventCount: 200_000, headSeq: 199_999 });
  assert.equal(parsed.updatedAt, 1_700_000_000_000);
  assert.throws(() => cloudSessionEntitySchema.parse({ ...cloudSession(), updatedAt: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => cloudSessionEntitySchema.parse({ ...cloudSession(), headSeq: -2 }));
});

test('Table wire codec keeps ETag outside the record and handles Edm.Int64/bigint', () => {
  const record = cloudSession({ updatedAt: 1_700_000_000_000, eventCount: 5, headSeq: 4 });
  const wire = encodeCloudRecord(record);
  assert.deepEqual(wire['updatedAt'], { type: 'Int64', value: '1700000000000' });
  assert.equal(wire['etag'], undefined);
  const decoded = decodeCloudRecord(cloudSessionEntitySchema, { ...wire, etag: 'etag-1', timestamp: new Date(7) }, 'session');
  assert.equal(decoded.record.updatedAt, 1_700_000_000_000);
  assert.equal(decoded.record.eventCount, 5);
  assert.equal(decoded.etag, 'etag-1');
  assert.equal(decoded.timestamp?.getTime(), 7);
  assert.throws(() => cloudSessionEntitySchema.parse({ ...record, etag: 'etag-1' }));
  const fromSdk = decodeCloudRecord(cloudSessionEntitySchema, { ...wire, updatedAt: 1_700_000_000_000n, eventCount: 5n }, 'session');
  assert.equal(fromSdk.record.updatedAt, 1_700_000_000_000);
  assert.equal(fromSdk.record.eventCount, 5);
  assert.throws(() => decodeCloudRecord(cloudSessionEntitySchema, { ...wire, updatedAt: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, 'session'), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
  assert.throws(() => decodeCloudRecord(cloudSessionEntitySchema, null, 'session'), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
  const canary = ['SYNTHETIC', 'INTEGER', 'CANARY'].join('_');
  assert.throws(() => decodeCloudRecord(cloudSessionEntitySchema, { ...wire, updatedAt: { type: 'Int64', value: canary } }, 'session'),
    (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD' && !error.message.includes(canary));
});
