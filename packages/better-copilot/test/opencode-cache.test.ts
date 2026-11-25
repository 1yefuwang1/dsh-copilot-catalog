import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATALOG_CACHE_MAX_AGE_MS,
  catalogCacheScope,
  createCatalogCacheEntry,
  opencodeCacheScope,
  readCatalogCacheEntry,
  sanitizeCatalogMetadata,
} from '../dist/catalog-cache.js';
import type { CatalogCacheKind } from '../dist/catalog-types.js';
import type { CredentialKey } from '../dist/catalog-types.js';
import { normalizeOpencodeCatalog } from '../dist/opencode.js';
import { opencodeDocument, opencodeItem } from './opencode-helpers.js';
import { accountItem, grantFixture } from './catalog-helpers.js';

const NOW = 1_800_000_000_000;
const LISTING = 'https://opencode.ai/inference/go/v1/models';
const COPILOT_ENDPOINT = 'https://api.enterprise.githubcopilot.com';
const KEY = 'synthetic-cache-record' as CredentialKey;

function opencodeRaw(): Record<string, unknown>[] {
  const normalized = normalizeOpencodeCatalog(opencodeDocument(
    opencodeItem('synthetic-known'),
    opencodeItem('synthetic-new', { limit: { context: 200_000, output: 300_000 } }),
  ));
  assert.ok(normalized);
  return normalized.data as unknown as Record<string, unknown>[];
}

const opencodeScope = () => opencodeCacheScope(LISTING);
const copilotScope = () => catalogCacheScope(KEY, COPILOT_ENDPOINT, { credential: grantFixture().payload });

test('the OpenCode scope digests the exact listing URL and stores only its canonical origin', () => {
  const first = opencodeScope();
  assert.match(first.accountKey, /^[a-f0-9]{64}$/u);
  assert.equal(first.endpoint, 'https://opencode.ai');
  assert.deepEqual(opencodeCacheScope('https://opencode.ai/inference/go/v1/models'), first);
  for (const changed of [
    'https://opencode.ai/inference/go/v1/models?v=2',
    'https://gateway.example.com/v1/models',
    'https://opencode.ai/inference/zen/v1/models',
  ]) assert.notEqual(opencodeCacheScope(changed).accountKey, first.accountKey);
  for (const invalid of ['http://opencode.ai/inference/go/v1/models', 'https://' + 'user:secret@opencode.ai/models',
    'https://opencode.ai:8443/models', 'not a url']) {
    assert.throws(() => opencodeCacheScope(invalid), /Invalid OpenCode Go cache endpoint/u);
  }
});

test('an OpenCode record round-trips through the shared table and is explicitly typed', () => {
  const scope = opencodeScope();
  const entry = createCatalogCacheEntry(scope, { data: opencodeRaw() }, NOW, [], 'opencode-go');
  assert.ok(entry);
  assert.equal(entry.kind, 'opencode-go');
  assert.equal(entry.endpoint, 'https://opencode.ai');
  const read = readCatalogCacheEntry(entry, scope, NOW);
  assert.deepEqual(read, entry);
  // The document is detached from the caller's object.
  (read!.raw.data[0] as { context?: number }).context = 1;
  assert.notEqual((entry.raw.data[0] as { context?: number }).context, 1);
});

test('legacy Copilot records without a kind stay readable and unchanged', () => {
  const scope = copilotScope();
  const created = createCatalogCacheEntry(scope, { data: [accountItem('synthetic-model')] }, NOW);
  assert.ok(created);
  const legacy = { ...created } as Record<string, unknown>;
  delete legacy.kind;
  const read = readCatalogCacheEntry(legacy, scope, NOW);
  assert.ok(read);
  assert.equal(read.kind, 'github-copilot');
  assert.deepEqual(read.raw, created.raw);
});

test('the record kind selects the allowlist, so each provider rejects the other shape', () => {
  const scope = opencodeScope();
  assert.equal(createCatalogCacheEntry(scope, { data: [accountItem('synthetic-model')] }, NOW, [], 'opencode-go'), undefined,
    'a Copilot payload has no bounded OpenCode metadata');
  const copilot = copilotScope();
  const reduced = createCatalogCacheEntry(copilot, { data: opencodeRaw() }, NOW);
  assert.ok(reduced);
  assert.deepEqual(reduced.raw.data.map((item) => Object.keys(item).sort()), [['id', 'name'], ['id', 'name']],
    'the Copilot allowlist keeps only Copilot-shaped selection fields');
  const entry = createCatalogCacheEntry(scope, { data: opencodeRaw() }, NOW, [], 'opencode-go')!;
  assert.equal(readCatalogCacheEntry({ ...entry, kind: 'future-provider' as CatalogCacheKind }, scope, NOW), undefined);
  assert.equal(readCatalogCacheEntry({ ...entry, kind: undefined }, scope, NOW), undefined,
    'a missing kind means the legacy Copilot shape, which a public OpenCode origin cannot validate');
});

test('OpenCode scope validation still refuses non-canonical storage endpoints', () => {
  const current = opencodeScope();
  for (const endpoint of ['http://opencode.ai', 'https://opencode.ai:8443', 'https://opencode.ai/models',
    'https://' + 'user:synthetic@opencode.ai']) {
    const foreign = { ...current, endpoint };
    assert.equal(createCatalogCacheEntry(foreign, { data: opencodeRaw() }, NOW, [], 'opencode-go'), undefined);
    assert.equal(readCatalogCacheEntry({ ...createCatalogCacheEntry(current, { data: opencodeRaw() }, NOW, [], 'opencode-go')!, endpoint },
      foreign, NOW), undefined);
  }
});

test('OpenCode records reject tampering, expiry and unsanitized documents', () => {
  const scope = opencodeScope();
  const entry = createCatalogCacheEntry(scope, { data: opencodeRaw() }, NOW, [], 'opencode-go')!;
  const tamper = (mutate: (raw: Record<string, unknown>[]) => unknown): unknown => {
    const copy = structuredClone(entry) as unknown as Record<string, unknown> & { raw: { data: Record<string, unknown>[] } };
    copy.raw.data = mutate(copy.raw.data) as Record<string, unknown>[];
    return copy;
  };
  for (const value of [
    { ...entry, version: 2 }, { ...entry, accountKey: 'b'.repeat(64) }, { ...entry, savedAt: NOW + 1 },
    { ...entry, savedAt: NOW - CATALOG_CACHE_MAX_AGE_MS - 1 }, { ...entry, savedAt: NaN },
    { ...entry, extra: 'synthetic' },
    tamper((data) => data.map((item, index) => index === 0 ? { ...item, context: 0 } : item)),
    tamper((data) => data.map((item, index) => index === 0 ? { ...item, unknown: true } : item)),
    tamper((data) => data.map((item, index) => index === 0 ? { ...item, cost: { ...(item.cost as Record<string, unknown>), input: -1 } } : item)),
    { ...entry, raw: { data: [] } },
  ]) assert.equal(readCatalogCacheEntry(value, scope, NOW), undefined);
  assert.ok(readCatalogCacheEntry({ ...entry, savedAt: NOW - CATALOG_CACHE_MAX_AGE_MS }, scope, NOW));
});

test('both record kinds share one table without reading each other', () => {
  const copilot = copilotScope();
  const opencode = opencodeScope();
  const copilotEntry = createCatalogCacheEntry(copilot, { data: [accountItem('synthetic-model')] }, NOW)!;
  const opencodeEntry = createCatalogCacheEntry(opencode, { data: opencodeRaw() }, NOW, [], 'opencode-go')!;
  assert.notEqual(copilotEntry.accountKey, opencodeEntry.accountKey);
  assert.equal(readCatalogCacheEntry(copilotEntry, opencode, NOW), undefined);
  assert.equal(readCatalogCacheEntry(opencodeEntry, copilot, NOW), undefined);
  assert.notDeepEqual(sanitizeCatalogMetadata(opencodeEntry.raw), opencodeEntry.raw,
    'the Copilot allowlist is not the OpenCode shape');
});
