import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import type { ContainerClient } from '@azure/storage-blob';
import { BlobClient } from '@azure/storage-blob';
import type { TableClient } from '@azure/data-tables';
import { BlobStore } from '../src/azure/blob.js';
import { LeaseManager, type LeaseHandle } from '../src/azure/lease.js';
import { TableStore, requireEntity } from '../src/azure/table.js';
import { AzureSyncError, isAlreadyExists, isNotFound, mapAzureError } from '../src/azure/errors.js';

const failure = (statusCode: number, code?: string) => ({ statusCode, ...(code === undefined ? {} : { code }) });

test('provider failures map to stable codes and never expose provider text or secrets', () => {
  assert.equal(mapAzureError(failure(401), 'read').code, 'AUTH_FAILED');
  assert.equal(mapAzureError(failure(403), 'read').code, 'AUTH_FAILED');
  assert.equal(mapAzureError(failure(404), 'read').code, 'NOT_FOUND');
  assert.equal(mapAzureError(failure(412), 'update').code, 'PRECONDITION');
  assert.equal(mapAzureError(failure(409, 'BlobAlreadyExists'), 'upload').code, 'CONFLICT');
  assert.equal(mapAzureError(failure(429), 'poll').code, 'THROTTLED');
  assert.equal(mapAzureError(failure(503), 'poll').code, 'TRANSIENT');
  assert.equal(mapAzureError(new Error('socket reset'), 'poll').code, 'AZURE_OPERATION_FAILED');
  assert.equal(isAlreadyExists(failure(409)), true);
  assert.equal(isNotFound(failure(404, 'BlobNotFound')), true);
  const error = new AzureSyncError('LIMIT', 'bounded');
  assert.equal(mapAzureError(error, 'read'), error);

  const raw = Object.assign(new Error('provider https://acctest.blob.core.windows.net/?sig=synthetic-secret AccountKey=synthetic-account-key'), {
    statusCode: 403, code: 'AuthorizationFailure', cause: new Error('nested-synthetic-secret'),
  });
  const mapped = mapAzureError(raw, 'read');
  assert.equal(mapped.code, 'AUTH_FAILED');
  assert.deepEqual(mapped.cause, { name: 'Error', statusCode: 403, code: 'AuthorizationFailure' });
  for (const rendered of [String(mapped), mapped.stack ?? '', inspect(mapped, { depth: 8 }), JSON.stringify(mapped)]) {
    assert.doesNotMatch(rendered, /synthetic-secret|synthetic-account-key|nested-synthetic-secret|sig=|AccountKey/iu);
  }
});

function fakeContainer(publicAccess: string | undefined = undefined) {
  const uploads: { name: string; length: number; options: Record<string, unknown> }[] = [];
  let read: Buffer<ArrayBufferLike> = Buffer.from('abc');
  const container = {
    createIfNotExists: async () => ({}),
    getProperties: async () => ({ blobPublicAccess: publicAccess }),
    getBlockBlobClient: (name: string) => ({
      upload: async (_data: Uint8Array, length: number, options: Record<string, unknown>) => {
        uploads.push({ name, length, options });
      },
    }),
    getBlobClient: (name: string) => ({
      getProperties: async () => {
        if (name === 'missing') throw failure(404);
        return { contentLength: read.byteLength };
      },
      deleteIfExists: async () => ({ succeeded: true }),
      downloadToBuffer: async (offset: number, count: number) => {
        assert.equal(offset, 0);
        assert.equal(count, read.byteLength);
        return read;
      },
      getBlobLeaseClient: () => ({}),
    }),
    listBlobsFlat: async function* () {
      yield { name: 'sessions/a/batch', properties: { contentLength: 3 } };
    },
  };
  return { container, uploads, setRead: (value: Buffer) => { read = value; } };
}

test('blob writes are conditional and private-container verification refuses public access', async () => {
  const fake = fakeContainer();
  const store = new BlobStore(fake.container as unknown as ContainerClient);
  await store.ensurePrivateContainer();
  assert.equal(await store.putIfAbsent('a/b', new Uint8Array([1, 2, 3]), { generation: '1' }), 'created');
  assert.deepEqual(fake.uploads[0], {
    name: 'a/b', length: 3,
    options: { conditions: { ifNoneMatch: '*' }, metadata: { generation: '1' } },
  });
  await store.ensureEmptyBlob('leases/a');
  assert.equal(fake.uploads[1]?.length, 0);

  const publicStore = new BlobStore(fakeContainer('blob').container as unknown as ContainerClient);
  await assert.rejects(publicStore.ensurePrivateContainer(), (error: unknown) => error instanceof AzureSyncError && error.code === 'CONTAINER_PUBLIC');
});

test('blob reads preflight the actual length and use the real SDK range buffering', async () => {
  const fake = fakeContainer();
  const store = new BlobStore(fake.container as unknown as ContainerClient);
  assert.equal(await store.exists('missing'), false);
  fake.setRead(Buffer.from('abcd'));
  await assert.rejects(store.read('large', 3), (error: unknown) => error instanceof AzureSyncError && error.code === 'LIMIT');
  fake.setRead(Buffer.from('abc'));
  assert.equal((await store.read('ok', 3)).toString(), 'abc');
  const listed = [];
  for await (const item of store.list('sessions/')) listed.push(item);
  assert.deepEqual(listed, [{ name: 'sessions/a/batch', sizeBytes: 3 }]);

  // Exercise the actual BlobClient.downloadToBuffer implementation (its
  // allocation/range loop) with only the transport call replaced.
  const blob = new BlobClient('https://example.blob.core.windows.net/container/blob');
  const ranges: [number, number | undefined][] = [];
  const patched = blob as unknown as {
    getProperties: () => Promise<{ contentLength: number }>;
    download: (offset?: number, count?: number) => Promise<unknown>;
  };
  patched.getProperties = async () => ({ contentLength: 3 });
  patched.download = async (offset = 0, count?: number) => {
    ranges.push([offset, count]);
    const body = Buffer.from('abc');
    return {
      readableStreamBody: Readable.from([body.subarray(offset, count === undefined ? undefined : offset + count)]),
      contentLength: body.byteLength,
    };
  };
  const realStore = new BlobStore({ getBlobClient: () => blob } as unknown as ContainerClient);
  assert.equal((await realStore.read('small', 8)).toString(), 'abc');
  assert.deepEqual(ranges, [[0, 3]], 'the SDK must receive the exact content length, not maxBytes + 1');

  patched.getProperties = async () => ({ contentLength: 0 });
  ranges.length = 0;
  assert.equal((await realStore.read('empty', 8)).byteLength, 0);
  assert.deepEqual(ranges, [], 'an empty blob needs no download');
});

interface TableOptions { requestOptions?: { timeout?: number } }

function fakeTable(expectedTimeout = 30_000) {
  const rows = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let created = false;
  const check = (options: TableOptions | undefined) => {
    assert.equal(options?.requestOptions?.timeout, expectedTimeout);
  };
  const client = {
    createTable: async (options?: TableOptions) => {
      check(options);
      if (created) throw failure(409, 'TableAlreadyExists');
      created = true;
      calls.push('createTable');
    },
    getEntity: async (partitionKey: string, rowKey: string, options?: TableOptions) => {
      check(options);
      const value = rows.get(`${partitionKey}/${rowKey}`);
      if (value === undefined) throw failure(404);
      return { ...value, partitionKey, rowKey, etag: 'etag-1' };
    },
    createEntity: async (entity: Record<string, unknown>, options?: TableOptions) => {
      check(options);
      const key = `${String(entity.partitionKey)}/${String(entity.rowKey)}`;
      if (rows.has(key)) throw failure(409, 'EntityAlreadyExists');
      rows.set(key, entity);
      calls.push('createEntity');
    },
    upsertEntity: async (entity: Record<string, unknown>, _mode: string, options?: TableOptions) => {
      check(options);
      rows.set(`${String(entity.partitionKey)}/${String(entity.rowKey)}`, entity);
      calls.push('upsertEntity');
    },
    updateEntity: async (entity: Record<string, unknown>, mode: string, options: TableOptions & { etag?: string }) => {
      check(options);
      assert.equal(mode, 'Replace');
      assert.equal(options.etag, 'etag-1');
      rows.set(`${String(entity.partitionKey)}/${String(entity.rowKey)}`, entity);
      calls.push('updateEntity');
    },
    deleteEntity: async (partitionKey: string, rowKey: string, options: TableOptions & { etag?: string } | undefined) => {
      check(options);
      assert.equal(options?.etag, 'etag-1');
      rows.delete(`${partitionKey}/${rowKey}`);
      calls.push('deleteEntity');
    },
    listEntities: async function* (options?: TableOptions) {
      check(options);
      for (const [key, value] of rows) {
        const [partitionKey = '', rowKey = ''] = key.split('/');
        yield { ...value, partitionKey, rowKey, etag: 'etag-1' };
      }
    },
  };
  return { client, rows, calls };
}

test('table operations preserve inserts, ETags, timeouts, and existing-table semantics', async () => {
  const fake = fakeTable();
  const store = new TableStore(fake.client as unknown as TableClient);
  await store.ensureTable();
  await store.ensureTable(); // 409 TableAlreadyExists is success
  assert.equal(await store.get('account', 'missing'), undefined);
  assert.equal(await store.insert({ partitionKey: 'account', rowKey: 'one', value: 1 }), true);
  assert.equal(await store.insert({ partitionKey: 'account', rowKey: 'one', value: 2 }), false);
  const stored = requireEntity(await store.get<{ value: number }>('account', 'one'), { partitionKey: 'account', rowKey: 'one' });
  assert.equal(stored.value.value, 1);
  assert.equal(stored.etag, 'etag-1');
  await store.update({ partitionKey: 'account', rowKey: 'one', value: 3 }, 'etag-1');
  assert.equal((await store.get<{ value: number }>('account', 'one'))?.value.value, 3);
  await store.upsert({ partitionKey: 'account', rowKey: 'two', value: 2 });
  const listed = [];
  for await (const item of store.list()) listed.push(item.value.rowKey);
  assert.deepEqual(listed.sort(), ['one', 'two']);
  await store.delete('account', 'two', 'etag-1');
  assert.equal(await store.get('account', 'two'), undefined);
  assert.throws(() => requireEntity(undefined, { partitionKey: 'account', rowKey: 'missing' }), (error: unknown) => error instanceof AzureSyncError && error.code === 'NOT_FOUND');

  const timed = fakeTable(1_234);
  const timedStore = new TableStore(timed.client as unknown as TableClient, 1_234);
  await timedStore.get('account', 'missing');
});

test('lease lifecycle separates the acquire client from the bound renew/release client', async () => {
  const calls: string[] = [];
  const unbound = {
    acquireLease: async (duration: number) => { calls.push(`acquire:${duration}`); return { leaseId: 'lease-id' }; },
    renewLease: async () => { calls.push('wrong-renew'); throw new Error('unbound renewal must not be used'); },
    breakLease: async (period: number) => { calls.push(`break:${period}`); return 0; },
  };
  const bound = {
    renewLease: async () => { calls.push('renew'); return 'lease-id'; },
    releaseLease: async () => { calls.push('release'); return {}; },
  };
  const store = {
    ensureEmptyBlob: async (name: string) => { calls.push(`ensure:${name}`); },
    lease: (name: string, leaseId?: string) => {
      calls.push(`lease:${name}${leaseId === undefined ? '' : `:${leaseId}`}`);
      return leaseId === undefined ? unbound : bound;
    },
  };
  const manager = new LeaseManager(store as never);
  const handle: LeaseHandle = await manager.acquire('leases/a');
  assert.equal(handle.leaseId, 'lease-id');
  await manager.renew(handle);
  await manager.release(handle);
  await manager.break('leases/a');
  assert.deepEqual(calls, ['ensure:leases/a', 'lease:leases/a', 'acquire:60', 'lease:leases/a:lease-id', 'renew', 'release', 'lease:leases/a', 'break:0']);
});
