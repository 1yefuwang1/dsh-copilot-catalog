import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { catalogDomain, CATALOG_DOMAIN_NAME, openCatalogStore } from '../dist/catalog-store.js';
import { catalogCacheScope, createCatalogCacheEntry, CATALOG_CACHE_MAX_AGE_MS } from '../dist/catalog-cache.js';
import type { CatalogCacheScope, CredentialKey } from '../dist/catalog-types.js';
import { accountItem, discoveryFixture, discoveryOptions, grantFixture } from './catalog-helpers.js';
import { syncCopilotCatalog } from '../dist/discovery.js';

// Public SDK dependency resolution, never an installed profile or credential directory.
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href);
const tmpBase = await realpath(tmpdir());
// Construct intentionally fake credentials; never embed credential-like literals.
const syntheticCredential = (label: string): string => ['synthetic', label].join('-');
const live = () => new AbortController().signal;
const scope = (key = syntheticCredential('api-key-a'), endpoint = 'https://api.enterprise.githubcopilot.com') =>
  catalogCacheScope('synthetic-record' as CredentialKey, endpoint, { apiKey: key });
const entry = (current: CatalogCacheScope, id = 'synthetic-model', savedAt = Date.now()) =>
  createCatalogCacheEntry(current, { data: [accountItem(id)] }, savedAt)!;
const storageKey = (current: CatalogCacheScope) => createHash('sha256')
  .update(JSON.stringify([current.accountKey, current.endpoint])).digest('hex');

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpBase, 'copilot-catalog-store-synthetic-'));
  assert.equal(dirname(root), tmpBase);
  const resources: { facility: DomainFacility; backend: JsonStorageBackend }[] = [];
  const reopen = () => {
    const host = new Context(); new Storage(host);
    const backend = new JsonStorageBackend(join(root, 'data'));
    host.storage.backend.register('synthetic-json', backend);
    const facility = new DomainFacility(host, { backend: 'synthetic-json' });
    resources.push({ backend, facility });
    return { host, backend, facility };
  };
  t.after(async () => {
    for (const resource of resources) { await resource.facility.closeAll(); await resource.backend.close(); }
    // Verify the canonical absolute target is the uniquely owned fixture before deletion.
    assert.equal(dirname(root), tmpBase);
    assert.equal(root, await realpath(root));
    await rm(root, { recursive: true, force: true });
  });
  return { root, reopen, ...reopen() };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('real DSH JSON storage reopens last successful sanitized raw catalog with opaque account-scoped filenames', async t => {
  const f = await fixture(t);
  const first = await openCatalogStore(f.facility, live());
  const current = scope();
  const metadata = createCatalogCacheEntry(current, { data: [accountItem('synthetic-persisted', {
    headers: { Authorization: syntheticCredential('sensitive-authorization') }, refresh: syntheticCredential('sensitive-refresh'),
  })], access: syntheticCredential('sensitive-access') }, Date.now())!;
  await first.write(current, metadata, live());
  await first.close(); await f.facility.closeAll(); await f.backend.close();
  const fresh = f.reopen();
  const second = await openCatalogStore(fresh.facility, live());
  assert.deepEqual(await second.read(current, live()), metadata);
  const files = await readdir(join(f.root, 'data', CATALOG_DOMAIN_NAME, 'catalogs'));
  assert.deepEqual(files, [storageKey(current) + '.json']);
  assert.match(files[0]!, /^[a-f0-9]{64}\.json$/u);
  const disk = await readFile(join(f.root, 'data', CATALOG_DOMAIN_NAME, 'catalogs', files[0]!), 'utf8');
  assert.equal(disk.includes('synthetic-sensitive'), false);
  assert.equal(disk.includes(syntheticCredential('api-key-a')), false);
  assert.equal(disk.includes('Authorization'), false);
  await second.close();
});

test('actual persistent startup cache feeds discovery offline and leaves last success intact', async t => {
  const f = await fixture(t);
  let store = await openCatalogStore(f.facility, live());
  const discovery = discoveryFixture();
  const current = catalogCacheScope(discovery.options.recordKey, 'https://api.enterprise.githubcopilot.com',
    { credential: grantFixture({ refresh: discovery.record.payload.refresh }).payload });
  await store.write(current, entry(current, 'synthetic-offline-model'), live());
  await store.close();
  store = await openCatalogStore(f.facility, live());
  discovery.options.cache = store;
  discovery.options.fetcher = async () => { throw new Error('synthetic-offline-failure'); };
  const result = await syncCopilotCatalog(discovery.credentials, discoveryOptions(discovery.options));
  assert.deepEqual(result, { status: 'cached', count: 1, unsupported: [], reason: 'FETCH_FAILED' });
  assert.deepEqual(Object.keys(discovery.catalog), ['synthetic-offline-model']);
  assert.equal((await store.read(current, live()) as ReturnType<typeof entry>).raw.data[0]!.id, 'synthetic-offline-model');
  await store.close();
});

test('real storage isolates API-key accounts and validated endpoints, and rejects stale replacement writes', async t => {
  const f = await fixture(t); const store = await openCatalogStore(f.facility, live());
  const a = scope(); const b = scope(syntheticCredential('api-key-b'));
  const tenant = scope(syntheticCredential('api-key-a'), 'https://copilot-api.synthetic.ghe.com');
  const now = Date.now(); const original = entry(a, 'account-a-model', now);
  await store.write(a, original, live()); await store.write(b, entry(b, 'account-b-model', now), live());
  assert.equal(await store.read(tenant, live()), undefined);
  await assert.rejects(store.write(tenant, original, live()), /scope|invalid/iu);
  assert.equal(await store.read(tenant, live()), undefined);
  assert.deepEqual(await store.read(a, live()), original);
  assert.equal((await store.read(b, live()) as ReturnType<typeof entry>).raw.data[0]!.id, 'account-b-model');
  await store.write(a, entry(a, 'older-candidate', now - 1), live());
  assert.deepEqual(await store.read(a, live()), original);
  await store.close();
});

test('domain schema rejects credential-bearing, invalid-scope, future and stale documents without rewriting last success', async t => {
  const f = await fixture(t); const store = await openCatalogStore(f.facility, live());
  const current = scope(); const original = entry(current); await store.write(current, original, live());
  for (const bad of [
    { ...original, authorization: syntheticCredential('sensitive-auth') },
    { ...original, raw: { data: [{ ...original.raw.data[0], credentials: { key: syntheticCredential('sensitive-key') } }] } },
    { ...original, accountKey: 'not-a-digest' },
    { ...original, endpoint: 'https://attacker.example' },
    { ...original, savedAt: Date.now() + 60_000 },
    { ...original, savedAt: Date.now() - CATALOG_CACHE_MAX_AGE_MS - 1 },
  ]) {
    assert.equal(catalogDomain.tables.catalogs.valueSchema.safeParse(bad).success, false);
    // KvTable.put trusts typed values; the persistence adapter must guard writes explicitly.
    await assert.rejects(store.write(current, bad, live()), /invalid/iu);
    assert.deepEqual(await store.read(current, live()), original);
  }
  await store.close();
});

test('real domain reopen rejects and skips an externally corrupted synthetic record while retaining other accounts', async t => {
  const f = await fixture(t); const store = await openCatalogStore(f.facility, live());
  const a = scope(); const b = scope(syntheticCredential('api-key-b'));
  const first = entry(a, 'account-a'); const second = entry(b, 'account-b');
  await store.write(a, first, live()); await store.write(b, second, live()); await store.close();
  // Deliberately bypass the guarded writer to simulate a corrupt external document;
  // this uniquely owned fixture contains synthetic values only, never profile data.
  const unit = await f.backend.kv.open({ name: CATALOG_DOMAIN_NAME, version: 1,
    layout: 'per-record', tables: ['catalogs'], hasGlobal: false });
  await unit.putRecord('catalogs', storageKey(a), { ...first,
    raw: { data: [{ ...first.raw.data[0], authorization: syntheticCredential('corrupt-authorization') }] } });
  await unit.close();
  const reopened = await openCatalogStore(f.facility, live());
  assert.equal(await reopened.read(a, live()), undefined);
  assert.deepEqual(await reopened.read(b, live()), second);
  const files = await readdir(join(f.root, 'data', CATALOG_DOMAIN_NAME, 'catalogs'));
  assert.equal(files.includes(storageKey(a) + '.json'), false);
  assert.equal(files.includes(storageKey(b) + '.json'), true);
  await reopened.close();
});

test('failed durable JSON writes preserve the in-memory and reopened last-success document', async t => {
  const f = await fixture(t); let fail = false;
  const open = f.backend.kv.open;
  f.backend.kv.open = async descriptor => {
    const unit = await open(descriptor);
    const put = unit.putRecord.bind(unit);
    unit.putRecord = async (...args) => { if (fail) throw new Error('synthetic-persistence-failure'); await put(...args); };
    return unit;
  };
  const store = await openCatalogStore(f.facility, live()); const current = scope();
  const original = entry(current, 'last-success', Date.now() - 1000);
  await store.write(current, original, live()); fail = true;
  await assert.rejects(store.write(current, entry(current, 'failed-candidate'), live()), /synthetic-persistence-failure/u);
  assert.deepEqual(await store.read(current, live()), original);
  await store.close(); fail = false;
  const reopened = await openCatalogStore(f.facility, live());
  assert.deepEqual(await reopened.read(current, live()), original); await reopened.close();
});

test('closed cache and canceled caller/lifetime cannot begin a durable write', async t => {
  const f = await fixture(t); const owner = new AbortController();
  const store = await openCatalogStore(f.facility, owner.signal); const current = scope();
  const canceled = new AbortController(); canceled.abort(new Error('synthetic-cancelled-caller'));
  await assert.rejects(store.write(current, entry(current), canceled.signal), /synthetic-cancelled-caller/u);
  assert.equal(await store.read(current, live()), undefined);
  owner.abort(new Error('synthetic-unloaded-owner'));
  await assert.rejects(store.write(current, entry(current), live()), /synthetic-unloaded-owner/u);
  await store.close();
  const reopened = await openCatalogStore(f.facility, live()); await reopened.close();
  await assert.rejects(reopened.write(current, entry(current), live()), /closed/u);
  await assert.rejects(reopened.read(current, live()), /closed/u);
  const inspect = await openCatalogStore(f.facility, live());
  assert.equal(await inspect.read(current, live()), undefined); await inspect.close();
});

test('canceling a noncooperative domain open promptly rejects and closes the late handle', async () => {
  const owner = new AbortController(); let closed = 0; let release!: (domain: Domain<typeof catalogDomain>) => void;
  const storage = { open: () => new Promise<Domain<typeof catalogDomain>>(resolve => { release = resolve; }) } as unknown as DomainFacility;
  const opening = openCatalogStore(storage, owner.signal);
  owner.abort(new Error('synthetic-open-cancelled'));
  await assert.rejects(opening, /synthetic-open-cancelled/u);
  release({ close: async () => { closed++; } } as unknown as Domain<typeof catalogDomain>);
  await nextTurn(); assert.equal(closed, 1);
});

test('an abort raised synchronously by storage.open is observed before awaiting a noncooperative handle', async () => {
  const owner = new AbortController(); let closed = 0; let release!: (domain: Domain<typeof catalogDomain>) => void;
  const storage = { open: () => {
    owner.abort(new Error('synthetic-synchronous-open-abort'));
    return new Promise<Domain<typeof catalogDomain>>(resolve => { release = resolve; });
  } } as unknown as DomainFacility;
  let failureTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = openCatalogStore(storage, owner.signal);
    const bounded = Promise.race([operation, new Promise<never>((_resolve, reject) => {
      failureTimer = setTimeout(() => reject(new Error('missed synchronous storage-open abort')), 100);
    })]);
    await assert.rejects(bounded, /synthetic-synchronous-open-abort/u);
  } finally {
    clearTimeout(failureTimer);
    release({ close: async () => { closed++; } } as unknown as Domain<typeof catalogDomain>);
    await nextTurn();
  }
  assert.equal(closed, 1);
});

test('the one-second storage-open deadline rejects and closes a late noncooperative domain', async () => {
  let closed = 0; let release!: (domain: Domain<typeof catalogDomain>) => void;
  const storage = { open: () => new Promise<Domain<typeof catalogDomain>>(resolve => { release = resolve; }) } as unknown as DomainFacility;
  // AbortSignal.timeout uses an unref timer; an owned referenced timer keeps only this test alive.
  const keepAlive = setTimeout(() => {}, 1500);
  try {
    await assert.rejects(openCatalogStore(storage, live()), { name: 'TimeoutError' });
    release({ close: async () => { closed++; } } as unknown as Domain<typeof catalogDomain>);
    await nextTurn(); assert.equal(closed, 1);
  } finally { clearTimeout(keepAlive); }
});
