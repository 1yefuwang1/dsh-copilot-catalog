import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TableClient } from '@azure/data-tables';
import type { BlobStore } from '../src/azure/blob.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { TableStore } from '../src/azure/table.js';
import { encodeCloudRecord, sessionRowKey, type CloudSessionEntity } from '../src/schema.js';
import { CloudRepository } from '../src/sync/cloud-repository.js';
import { cloudSession } from './helpers.js';

const cursorFor = (rowKey: string) => Buffer.from(rowKey).toString('base64url');
const code = (expected: string) => (error: unknown) => error instanceof AzureSyncError && error.code === expected;
const clone = <T>(value: T): T => structuredClone(value);

function wire(entity: CloudSessionEntity): Record<string, unknown> {
  return { ...encodeCloudRecord(entity), etag: `etag-${entity.sessionId}`, timestamp: new Date(0), 'odata.etag': 'sdk-metadata' };
}

function entities(count: number, partitionKey = 'account') {
  return Array.from({ length: count }, (_, index) => cloudSession({ sessionId: `catalog-${String(index).padStart(4, '0')}`, partitionKey }))
    .sort((a, b) => a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0);
}

/** Both production listing layers are real; fake only the lazy Azure SDK iterator. */
function fixture(input: { rows?: Record<string, unknown>[]; partition?: string } = {}) {
  let rows = input.rows ?? entities(4, input.partition).map(wire);
  const requests: Array<{ queryOptions?: { filter?: string }; abortSignal?: AbortSignal; requestOptions?: { timeout: number } }> = [];
  let yielded = 0;
  let closed = 0;
  let mutations = 0;
  let reads = 0;
  const hooks: { beforeRow?: (index: number) => void; afterRow?: (index: number) => void } = {};
  const mutate = async () => { mutations++; throw new Error('Catalog listing is read-only.'); };
  const client = {
    listEntities(options: (typeof requests)[number]) {
      requests.push(options);
      return (async function* () {
        try {
          for (let index = 0; index < rows.length; index++) {
            hooks.beforeRow?.(index);
            yielded++;
            yield clone(rows[index]!);
            hooks.afterRow?.(index);
          }
        } finally { closed++; }
      })();
    },
    getEntity: async () => { reads++; throw new Error('Catalog must not read individual sessions.'); },
    createEntity: mutate, updateEntity: mutate, upsertEntity: mutate, deleteEntity: mutate, submitTransaction: mutate,
  } as unknown as TableClient;
  const table = new TableStore(client, 1234);
  const repository = new CloudRepository({ read: async () => { reads++; throw new Error('Catalog must not fetch payload blobs.'); } } as unknown as BlobStore,
    table, input.partition ?? 'account');
  return { repository, table, requests, hooks, setRows: (next: Record<string, unknown>[]) => { rows = next; }, counts: () => ({ yielded, closed, mutations, reads }) };
}

test('catalog accepts every integer limit from 1 through 100 and consumes at most count+1 rows', async () => {
  const all = entities(102).map(wire);
  for (let limit = 1; limit <= 100; limit++) {
    const f = fixture({ rows: all });
    const page = await f.repository.listManifestsPage({ limit });
    assert.equal(page.items.length, limit);
    assert.equal(page.nextCursor, cursorFor(page.items.at(-1)!.entity.rowKey));
    assert.deepEqual(f.counts(), { yielded: limit + 1, closed: 1, mutations: 0, reads: 0 });
    assert.equal(f.requests.length, 1);
  }
});

for (const limit of [0, -1, 101, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, '1', null, undefined]) {
  test(`catalog rejects non-bounded/non-integer limit ${String(limit)} before opening a source iterator`, async () => {
    const f = fixture();
    await assert.rejects(f.repository.listManifestsPage({ limit: limit as number }), code('LIMIT'));
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.counts(), { yielded: 0, closed: 0, mutations: 0, reads: 0 });
  });
}

test('catalog emits an opaque canonical RowKey cursor, not the session ID or SDK continuation token', async () => {
  const all = entities(5);
  const f = fixture({ rows: all.map(wire) });
  const first = await f.repository.listManifestsPage({ limit: 2 });
  assert.deepEqual(first.items.map(item => item.entity.sessionId), all.slice(0, 2).map(item => item.sessionId));
  const cursor = first.nextCursor; assert.ok(cursor);
  assert.equal(Buffer.from(cursor, 'base64url').toString('utf8'), all[1]!.rowKey);
  assert.equal(cursorFor(Buffer.from(cursor, 'base64url').toString('utf8')), cursor);
  assert.notEqual(cursor, all[1]!.sessionId);
  f.setRows(all.slice(2).map(wire));
  const second = await f.repository.listManifestsPage({ limit: 2, cursor });
  assert.deepEqual(second.items.map(item => item.entity.sessionId), all.slice(2, 4).map(item => item.sessionId));
  assert.equal(second.nextCursor, cursorFor(all[3]!.rowKey));
  f.setRows(all.slice(4).map(wire));
  const final = await f.repository.listManifestsPage({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(final.items.map(item => item.entity.sessionId), [all[4]!.sessionId]);
  assert.equal(Object.hasOwn(final, 'nextCursor'), false);
  assert.equal(f.counts().mutations, 0);
});

const validCursor = cursorFor(sessionRowKey('catalog-cursor'));
const malformedCursors = [
  '', 'not a cursor', `${validCursor}=`, `${validCursor}\n`, 'a', '_w', 'x'.repeat(4097),
  cursorFor('batch:YWJj:gen-1:0'), cursorFor('session:'), cursorFor("session:YWJj' or true"), cursorFor('session;YWJj'),
];
for (const [index, cursor] of malformedCursors.entries()) {
  test(`catalog rejects malformed or noncanonical opaque cursor ${index + 1} before listing`, async () => {
    const f = fixture();
    await assert.rejects(f.repository.listManifestsPage({ limit: 2, cursor }), code('INVALID_RECORD'));
    assert.equal(f.requests.length, 0);
    assert.equal(f.counts().mutations, 0);
  });
}

for (const rowKey of ['session:YR', 'session:_w']) {
  test(`catalog cursor requires a canonical UTF-8 session RowKey, not merely a base64url-looking suffix (${rowKey})`, async () => {
    const f = fixture({ rows: [] });
    await assert.rejects(f.repository.listManifestsPage({ limit: 1, cursor: cursorFor(rowKey) }), code('INVALID_RECORD'));
    assert.equal(f.requests.length, 0);
  });
}

test('catalog sends an escaped partition plus strict session-key range and exclusive keyset predicate to TableStore', async () => {
  const partition = "tenant'o'hare";
  const all = entities(3, partition);
  const after = all[0]!.rowKey;
  const f = fixture({ rows: all.slice(1).map(wire), partition });
  const controller = new AbortController();
  const page = await f.repository.listManifestsPage({ limit: 1, cursor: cursorFor(after) }, controller.signal);
  assert.equal(page.items[0]?.entity.partitionKey, partition);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.queryOptions?.filter,
    `PartitionKey eq 'tenant''o''hare' and RowKey ge 'session:' and RowKey lt 'session;' and RowKey gt '${after}'`);
  assert.equal(f.requests[0]?.abortSignal, controller.signal);
  assert.deepEqual(f.requests[0]?.requestOptions, { timeout: 1234 });
  assert.deepEqual(f.counts(), { yielded: 2, closed: 1, mutations: 0, reads: 0 });
});

for (const count of [0, 1, 2]) {
  test(`catalog exhausted source with ${count} rows returns no spurious continuation cursor`, async () => {
    const f = fixture({ rows: entities(count).map(wire) });
    const page = await f.repository.listManifestsPage({ limit: 2 });
    assert.equal(page.items.length, count);
    assert.deepEqual(Object.keys(page), ['items']);
    assert.equal(f.counts().yielded, count);
    assert.equal(f.counts().closed, 1);
  });
}

test('catalog closes the SDK iterator at the lookahead row instead of materializing the rest of an account', async () => {
  const f = fixture({ rows: [...entities(3).map(wire), { rowKey: 'must-never-decode-this-account-tail' }] });
  f.hooks.beforeRow = (index) => assert.ok(index < 3, 'a limit-2 page must not request the fourth SDK row');
  const page = await f.repository.listManifestsPage({ limit: 2 });
  assert.equal(page.items.length, 2);
  assert.deepEqual(f.counts(), { yielded: 3, closed: 1, mutations: 0, reads: 0 });
});

const corruptRows: Array<{ name: string; rows: () => Record<string, unknown>[]; cursor?: string }> = [
  { name: 'foreign partition', rows: () => [wire(cloudSession({ sessionId: 'foreign', partitionKey: 'other-account' }))] },
  { name: 'row/session identity mismatch', rows: () => [wire(cloudSession({ sessionId: 'identity-a', rowKey: sessionRowKey('identity-b') }))] },
  { name: 'non-session row key', rows: () => [wire(cloudSession({ sessionId: 'identity-a', rowKey: 'batch:YWJj' }))] },
  { name: 'out-of-order manifest', rows: () => entities(2).reverse().map(wire) },
  { name: 'duplicate manifest', rows: () => { const value = wire(entities(1)[0]!); return [value, clone(value)]; } },
  { name: 'row at cursor', rows: () => [wire(cloudSession({ sessionId: 'cursor' }))], cursor: cursorFor(sessionRowKey('cursor')) },
  { name: 'row before cursor', rows: () => [wire(cloudSession({ sessionId: 'a' }))], cursor: cursorFor(sessionRowKey('z')) },
];
for (const item of corruptRows) {
  test(`catalog fails closed on ${item.name}, even if a server-side filter is ignored`, async () => {
    const f = fixture({ rows: item.rows() });
    await assert.rejects(f.repository.listManifestsPage({ limit: 2, ...(item.cursor === undefined ? {} : { cursor: item.cursor }) }), code('CORRUPT_REMOTE'));
    assert.equal(f.counts().mutations, 0);
    assert.equal(f.counts().reads, 0);
    assert.equal(f.counts().closed, 1);
  });
}

test('catalog validates the lookahead row too; a foreign partition is never accepted as proof of another page', async () => {
  const f = fixture({ rows: [wire(entities(1)[0]!), wire(cloudSession({ sessionId: 'foreign', partitionKey: 'foreign' }))] });
  await assert.rejects(f.repository.listManifestsPage({ limit: 1 }), code('CORRUPT_REMOTE'));
  assert.deepEqual(f.counts(), { yielded: 2, closed: 1, mutations: 0, reads: 0 });
});

test('catalog rejects missing ETags and malformed manifests without yielding a partial successful page', async () => {
  const noETag = wire(entities(1)[0]!); delete noETag['etag'];
  const f = fixture({ rows: [noETag] });
  await assert.rejects(f.repository.listManifestsPage({ limit: 2 }), code('CORRUPT_REMOTE'));
  f.setRows([{ ...wire(entities(1)[0]!), eventCount: 'not-an-int64' }]);
  await assert.rejects(f.repository.listManifestsPage({ limit: 2 }), code('INVALID_RECORD'));
  assert.equal(f.counts().mutations, 0);
});

test('catalog strips SDK metadata and returns only its repository envelope; controller projection is a separate boundary', async () => {
  const entity = entities(1)[0]!;
  const f = fixture({ rows: [wire(entity)] });
  const page = await f.repository.listManifestsPage({ limit: 1 });
  assert.deepEqual(Object.keys(page), ['items']);
  assert.deepEqual(Object.keys(page.items[0]!).sort(), ['entity', 'etag']);
  assert.deepEqual(page.items[0]?.entity, entity);
  assert.equal(Object.hasOwn(page.items[0]!.entity, 'timestamp'), false);
  assert.equal(Object.hasOwn(page.items[0]!.entity, 'odata.etag'), false);
  assert.equal(f.counts().reads, 0, 'catalog must not fetch raw payloads or extra per-session data');
  assert.equal(f.counts().mutations, 0);
});

test('source cancellation before catalog entry performs no list or mutation', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.repository.listManifestsPage({ limit: 2 }, controller.signal));
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.counts(), { yielded: 0, closed: 0, mutations: 0, reads: 0 });
});

test('source cancellation between SDK rows stops catalog decoding, closes the iterator and performs no mutations', async () => {
  const f = fixture({ rows: [wire(entities(1)[0]!), { malicious: 'must not be decoded after abort' }, ...entities(3).map(wire)] });
  const controller = new AbortController();
  f.hooks.afterRow = (index) => { if (index === 0) controller.abort(); };
  await assert.rejects(f.repository.listManifestsPage({ limit: 100 }, controller.signal), code('CANCELLED'));
  assert.deepEqual(f.counts(), { yielded: 2, closed: 1, mutations: 0, reads: 0 });
  assert.equal(f.requests[0]?.abortSignal, controller.signal);
});

test('TableStore.list independently refuses a pre-aborted signal before calling its SDK client', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  const iterator = f.table.list('PartitionKey eq \'account\'', controller.signal);
  await assert.rejects(iterator.next(), code('CANCELLED'));
  assert.equal(f.requests.length, 0);
});

test('TableStore.list independently stops between rows when an SDK source ignores its abort signal', async () => {
  const f = fixture(); const controller = new AbortController();
  const iterator = f.table.list('PartitionKey eq \'account\'', controller.signal);
  const first = await iterator.next(); assert.equal(first.done, false);
  controller.abort();
  await assert.rejects(iterator.next(), code('CANCELLED'));
  assert.deepEqual(f.counts(), { yielded: 2, closed: 1, mutations: 0, reads: 0 });
});
