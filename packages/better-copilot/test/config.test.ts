import assert from 'node:assert/strict';
import { test } from 'node:test';
import z from '@deepseek-ai/schemastery';
import { Config as OriginalConfig } from '@deepseek-ai/dsh-llm-pi-ai';
import { createConfig, DEFAULT_SEARCH_MODEL } from '../dist/config.js';

/** The adapter's own schema is the source of truth for provider settings. */
const Config = createConfig(OriginalConfig);

test('providers reuse the adapter schema, including its resolved profile defaults', () => {
  const config = Config({ providers: { 'github-copilot': {} } });
  const profile = config.providers.get()['github-copilot'] as unknown as Record<string, unknown> | undefined;
  assert.ok(profile);
  assert.equal(profile.baseURL, undefined);
  assert.equal(profile.defaultContextWindow, 1000000);
  assert.equal(profile.defaultMaxTokens, 128000);
  assert.deepEqual(profile.compat, { chatTemplateKwargs: {}, chatTemplateArgs: {} });
  // The reused schema instance is the adapter's own field schema, not a restatement.
  assert.equal((OriginalConfig as unknown as { dict: { providers: unknown } }).dict.providers, (createConfig(OriginalConfig) as unknown as { dict: { providers: unknown } }).dict.providers);
});

test('search and guard settings resolve their defaults and overrides through volatile leaves', () => {
  const defaults = Config({ providers: {} });
  assert.equal(defaults.search.model.get(), DEFAULT_SEARCH_MODEL);
  assert.equal(DEFAULT_SEARCH_MODEL, 'gpt-6.1-sol');
  assert.equal(defaults.search.maxTokens.get(), 4096);
  assert.equal(defaults.search.timeoutMs.get(), 60_000);
  assert.equal(defaults.search.maxResponseBytes.get(), 2_097_152);
  assert.equal(defaults.search.includeSources.get(), true);
  assert.equal(defaults.search.searchMode.get(), 'default');
  assert.equal(defaults.search.forceSearch.get(), false);
  assert.equal(defaults.search.apiKeyEnv.get(), undefined);
  assert.equal(defaults.search.baseURL.get(), undefined);
  assert.equal(defaults.toolSchema.logFixes.get(), false);
  assert.deepEqual(defaults.toolSchema.providers.get(), ['github-copilot']);
  assert.deepEqual(defaults.toolSchema.families.get(), ['gemini']);

  const overridden = Config({
    providers: { 'github-copilot': { baseURL: 'https://api.enterprise.githubcopilot.com' } },
    search: { model: 'gpt-6-luna', maxTokens: 8192, searchMode: 'live', forceSearch: true, apiKeyEnv: 'COPILOT_TOKEN', baseURL: 'https://api.enterprise.githubcopilot.com' },
    toolSchema: { providers: ['github-copilot', 'other'], families: ['gemini', 'gemma'], logFixes: true },
  });
  assert.equal(overridden.providers.get()['github-copilot']?.baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(overridden.search.model.get(), 'gpt-6-luna');
  assert.equal(overridden.search.maxTokens.get(), 8192);
  assert.equal(overridden.search.searchMode.get(), 'live');
  assert.equal(overridden.search.forceSearch.get(), true);
  assert.equal(overridden.search.apiKeyEnv.get(), 'COPILOT_TOKEN');
  assert.deepEqual(overridden.toolSchema.families.get(), ['gemini', 'gemma']);
  assert.equal(overridden.toolSchema.logFixes.get(), true);
});

test('builtin review overrides are optional volatile leaves with an enabled default', () => {
  const defaults = Config();
  assert.equal(defaults.autoReview.enabled.get(), true);
  assert.equal(defaults.autoReview.model.get(), undefined);
  assert.equal(defaults.autoReview.reasoningEffort.get(), undefined);
  const overridden = Config({ autoReview: { enabled: false, model: 'exact-model-id', reasoningEffort: 'max' } });
  assert.equal(overridden.autoReview.enabled.get(), false);
  assert.equal(overridden.autoReview.model.get(), 'exact-model-id');
  assert.equal(overridden.autoReview.reasoningEffort.get(), 'max');
  assert.throws(() => Config({ autoReview: { model: '' } }));
  assert.throws(() => Config({ autoReview: { reasoningEffort: '' } }));
});

test('catalog cache settings are volatile with bounded demand-refresh defaults', () => {
  const defaults = Config();
  assert.equal(defaults.catalog.cache.get(), true);
  assert.equal(defaults.catalog.refreshIntervalMs.get(), 900_000);
  const overridden = Config({ catalog: { cache: false, refreshIntervalMs: 60_000 } });
  assert.equal(overridden.catalog.cache.get(), false);
  assert.equal(overridden.catalog.refreshIntervalMs.get(), 60_000);
  for (const refreshIntervalMs of [0, 59_999, 86_400_001, 60_000.5]) {
    assert.throws(() => Config({ catalog: { refreshIntervalMs } }));
  }
  assert.throws(() => Config({ catalog: { cache: 'yes' as never } }));
});

test('the parity table keeps every predecessor field at its merged path', () => {
  // Literal expectations, so this test survives the predecessor packages' deletion.
  const expected = {
    'search.apiKeyEnv': 'credential-ref string',
    'search.baseURL': 'string',
    'search.model': 'gpt-6.1-sol',
    'search.maxTokens': 4096,
    'search.timeoutMs': 60000,
    'search.maxResponseBytes': 2097152,
    'search.includeSources': true,
    'search.searchMode': 'default',
    'search.forceSearch': false,
    'toolSchema.providers': ['github-copilot'],
    'toolSchema.families': ['gemini'],
    'toolSchema.logFixes': false,
  };
  const config = Config({ providers: {} });
  assert.equal(config.search.model.get(), expected['search.model']);
  assert.equal(config.search.maxTokens.get(), expected['search.maxTokens']);
  assert.equal(config.search.timeoutMs.get(), expected['search.timeoutMs']);
  assert.equal(config.search.maxResponseBytes.get(), expected['search.maxResponseBytes']);
  assert.equal(config.search.includeSources.get(), expected['search.includeSources']);
  assert.equal(config.search.searchMode.get(), expected['search.searchMode']);
  assert.equal(config.search.forceSearch.get(), expected['search.forceSearch']);
  assert.deepEqual(config.toolSchema.providers.get(), expected['toolSchema.providers']);
  assert.deepEqual(config.toolSchema.families.get(), expected['toolSchema.families']);
  assert.equal(config.toolSchema.logFixes.get(), expected['toolSchema.logFixes']);
  assert.equal(typeof config.search.baseURL.get(), 'undefined');
  assert.equal(typeof config.search.apiKeyEnv.get(), 'undefined');
});

test('an adapter schema without a providers dict fails loudly instead of degrading to an open schema', () => {
  assert.throws(() => createConfig(undefined), /Incompatible DSH\/pi-ai adapter/u);
  assert.throws(() => createConfig({}), /Incompatible DSH\/pi-ai adapter/u);
  assert.throws(() => createConfig({ dict: {} }), /Incompatible DSH\/pi-ai adapter/u);
  assert.throws(() => createConfig({ dict: { providers: { type: 'string' } } }), /Incompatible DSH\/pi-ai adapter/u);
});

test('volatile leaves require a plain container: a volatile wrapper would be rejected', () => {
  // The chosen shape resolves.
  assert.doesNotThrow(() => Config({ providers: {}, search: {}, toolSchema: {} }));
  // A volatile container around volatile leaves is exactly what schemastery rejects.
  const invalid = z.object({
    search: z.object({ model: z.string().default('m').volatile() }).volatile(),
  });
  assert.throws(() => invalid({ search: {} }), /volatile fields require a fixed object path/u);
});

test('unknown top-level keys are accepted and preserved (documented schemastery behaviour)', () => {
  const config = Config({ providers: {}, extra: 'kept' } as never) as unknown as Record<string, unknown>;
  assert.equal(config.extra, 'kept');
});
