import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOG_CACHE_MAX_AGE_MS, CATALOG_CACHE_MAX_BYTES, CATALOG_CACHE_MAX_MODELS,
  catalogCacheScope, createCatalogCacheEntry, readCatalogCacheEntry, sanitizeCatalogMetadata } from '../dist/catalog-cache.js';
import { selectAccountModels } from '../dist/catalog.js';
import { accountItem, catalogFixture, grantFixture } from './catalog-helpers.js';
import type { CredentialKey } from '../dist/catalog-types.js';

// Construct intentionally fake credentials; never embed credential-like literals.
const syntheticCredential = (label: string): string => ['synthetic', label].join('-');
const NOW = 1_800_000_000_000;
const KEY = 'synthetic-cache-record' as CredentialKey;
const ENDPOINT = 'https://api.enterprise.githubcopilot.com';
const scope = () => catalogCacheScope(KEY, ENDPOINT, { credential: grantFixture().payload });
const metadata = () => ({ data: [accountItem('synthetic-model')] });

test('cache hashes stable OAuth refresh identity, record, Enterprise context and endpoint, never rotating access', () => {
  const grant = grantFixture().payload;
  const first = catalogCacheScope(KEY, ENDPOINT, { credential: grant });
  assert.match(first.accountKey, /^[a-f0-9]{64}$/u);
  assert.deepEqual(catalogCacheScope(KEY, ENDPOINT, { credential: { ...grant, access: syntheticCredential('rotated-access'), expires: 0 } }), first);
  for (const next of [
    catalogCacheScope(KEY, ENDPOINT, { credential: { ...grant, refresh: syntheticCredential('other-refresh') } }),
    catalogCacheScope(KEY, ENDPOINT, { credential: { ...grant, enterpriseUrl: 'synthetic.ghe.com' } }),
    catalogCacheScope('another-record' as CredentialKey, ENDPOINT, { credential: grant }),
    catalogCacheScope(KEY, 'https://api.business.githubcopilot.com', { credential: grant }),
    catalogCacheScope(KEY, ENDPOINT, { apiKey: grant.refresh }),
  ]) assert.notEqual(next.accountKey, first.accountKey);
  assert.notEqual(catalogCacheScope(KEY, ENDPOINT, { apiKey: syntheticCredential('api-key-a') }).accountKey,
    catalogCacheScope(KEY, ENDPOINT, { apiKey: syntheticCredential('api-key-b') }).accountKey);
  assert.equal(JSON.stringify(first).includes(grant.refresh), false);
  assert.equal(JSON.stringify(first).includes(grant.access), false);
});

test('cache persists only bounded raw selection metadata and never nested secrets, headers or descriptors', () => {
  const input = { data: [accountItem('synthetic-model', {
    access: syntheticCredential('sensitive-access'), refresh: syntheticCredential('sensitive-refresh'),
    Authorization: syntheticCredential('sensitive-auth'), headers: { Authorization: syntheticCredential('sensitive-auth') },
    baseUrl: 'https://attacker.example', credentials: { key: 'synthetic-sensitive-key' },
    billing: { token_prices: { batch_size: 1_000_000,
      default: { input_price: 10, output_price: 20, cache_price: 1, cache_write_price: 2, context_max: 100000,
        authorization: syntheticCredential('sensitive-auth') },
      long_context: { input_price: 20, output_price: 40, cache_price: 2, cache_write_price: 4 } } },
  })], token: syntheticCredential('sensitive-token') };
  const entry = createCatalogCacheEntry(scope(), input, NOW)!;
  assert.ok(entry);
  const json = JSON.stringify(entry);
  for (const value of ['synthetic-sensitive', 'Authorization', 'headers', 'credentials', 'baseUrl', 'attacker.example']) assert.equal(json.includes(value), false);
  const selected = selectAccountModels(entry.raw, catalogFixture(), { baseUrl: ENDPOINT });
  assert.equal(selected.models['synthetic-model']!.cost.input, 0.1);
  assert.equal(selected.models['synthetic-model']!.contextWindow, 1_000_000);
  assert.deepEqual(readCatalogCacheEntry(entry, scope(), NOW), entry);
  const copy = readCatalogCacheEntry(entry, scope(), NOW)!;
  copy.raw.data[0]!.id = 'another-synthetic-model';
  assert.equal(entry.raw.data[0]!.id, 'synthetic-model');
});

test('credential-looking strings and known credential echoes are never retained in otherwise allowed fields', () => {
  const secret = syntheticCredential('private-credential');
  const raw = sanitizeCatalogMetadata({ data: [accountItem('synthetic-model', { name: `model ${secret}` }),
    accountItem(secret), accountItem('gho_' + syntheticCredential('key')), accountItem('synthetic-other', { name: 'Bearer synthetic-key' }),
  ] }, [secret])!;
  assert.deepEqual(raw.data.map((item) => item.id), ['synthetic-model', 'synthetic-other']);
  assert.equal(JSON.stringify(raw).includes(secret), false);
  assert.equal(raw.data[0]!.name, undefined);
  assert.equal(raw.data[1]!.name, undefined);
});

test('allowlisted metadata preserves policy rejection and capability decisions instead of broadening access', () => {
  const input = { data: [accountItem('synthetic-model'), accountItem('numeric-policy', { policy: { state: 2 } }),
    accountItem('disabled', { policy: { state: 'provider-disabled-details' } }),
    accountItem('embedding', { capabilities: { type: 'embedding' } }),
    accountItem('temperature', { capabilities: { limits: { max_context_window_tokens: 100000, max_output_tokens: 1000 },
      supports: { temperature: false, tool_calls: true, streaming: true, reasoning_effort: ['none', 'high', 'synthetic-sensitive-effort'] } } }),
  ] };
  const raw = sanitizeCatalogMetadata(input)!;
  assert.deepEqual(Object.keys(selectAccountModels(raw, catalogFixture()).models), ['synthetic-model', 'temperature']);
  assert.equal(JSON.stringify(raw).includes('provider-disabled-details'), false);
  assert.equal(JSON.stringify(raw).includes('synthetic-sensitive-effort'), false);
});

test('cache rejects foreign scope, stale/future/version/timestamp and unsanitized documents', () => {
  const current = scope();
  const entry = createCatalogCacheEntry(current, metadata(), NOW)!;
  for (const value of [undefined, null, [], {},
    { ...entry, version: 2 }, { ...entry, accountKey: 'a'.repeat(64) },
    { ...entry, endpoint: 'https://api.business.githubcopilot.com' },
    { ...entry, savedAt: NOW + 1 }, { ...entry, savedAt: NOW - CATALOG_CACHE_MAX_AGE_MS - 1 },
    { ...entry, savedAt: -1 }, { ...entry, savedAt: NaN }, { ...entry, savedAt: NOW + 0.5 },
    { ...entry, authorization: syntheticCredential('sensitive-auth') },
    { ...entry, raw: { ...entry.raw, token: syntheticCredential('sensitive-token') } },
    { ...entry, raw: { data: [{ ...entry.raw.data[0], headers: { Authorization: syntheticCredential('sensitive-auth') } }] } },
    { ...entry, raw: { data: [] } },
  ]) assert.equal(readCatalogCacheEntry(value, current, NOW), undefined);
  assert.ok(readCatalogCacheEntry({ ...entry, savedAt: NOW - CATALOG_CACHE_MAX_AGE_MS }, current, NOW));
});

test('cache scope requires a canonical trusted live origin and never copies extra scope fields', () => {
  const current = scope();
  const expanded = { ...current, authorization: syntheticCredential('sensitive-scope-field') };
  assert.equal(JSON.stringify(createCatalogCacheEntry(expanded, metadata(), NOW)).includes('synthetic-sensitive'), false);
  for (const endpoint of ['https://attacker.example', 'http://api.enterprise.githubcopilot.com',
    'https://api.enterprise.githubcopilot.com/models', 'https://api.enterprise.githubcopilot.com:443',
    'https://' + 'user:synthetic-key@api.enterprise.githubcopilot.com', 'https://api.synthetic.ghe.com']) {
    const foreign = { ...current, endpoint };
    assert.equal(createCatalogCacheEntry(foreign, metadata(), NOW), undefined);
    assert.equal(readCatalogCacheEntry({ ...createCatalogCacheEntry(current, metadata(), NOW)!, endpoint }, foreign, NOW), undefined);
    assert.throws(() => catalogCacheScope(KEY, endpoint, { apiKey: syntheticCredential('key') }), /endpoint/u);
  }
});

test('cache metadata limits and hostile prototypes fail closed', () => {
  assert.equal(sanitizeCatalogMetadata({ data: Array.from({ length: CATALOG_CACHE_MAX_MODELS + 1 }, () => accountItem('synthetic')) }), undefined);
  assert.equal(sanitizeCatalogMetadata({ data: [accountItem('a'.repeat(257))] }), undefined);
  assert.equal(sanitizeCatalogMetadata({ data: [accountItem('synthetic', { supported_endpoints: Array(33).fill('/responses') })] }), undefined);
  assert.equal(sanitizeCatalogMetadata({ data: [accountItem('synthetic', { capabilities: { supports: { reasoning_effort: Array(33).fill('high') } } })] }), undefined);
  assert.equal(sanitizeCatalogMetadata({ data: [accountItem('bad\nidentifier')] }), undefined);
  assert.equal(sanitizeCatalogMetadata(Object.create({ data: metadata().data })), undefined);
  const entry = createCatalogCacheEntry(scope(), metadata(), NOW)!;
  assert.equal(readCatalogCacheEntry({ ...entry, raw: { data: [{ id: 'synthetic', name: 'a'.repeat(CATALOG_CACHE_MAX_BYTES + 1) }] } }, scope(), NOW), undefined);
  const hostile = Object.create({ ...entry }) as unknown;
  assert.equal(readCatalogCacheEntry(hostile, scope(), NOW), undefined);
  assert.equal(createCatalogCacheEntry(scope(), metadata(), Infinity), undefined);
});
