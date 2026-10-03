import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveCost, MODEL_TEMPLATES, replaceCatalog, selectAccountModels } from '../dist/catalog.js';
import { accountItem, catalogFixture } from './helpers.mjs';

const select = (items, catalog = catalogFixture()) => selectAccountModels({ data: items }, catalog);

test('known models retain descriptor identity and mixed API metadata', () => {
  const catalog = catalogFixture();
  const selected = select([accountItem('claude'), accountItem('gpt-6-sol')], catalog);
  assert.equal(selected.models.claude, catalog.claude);
  assert.equal(selected.models.claude.api, 'anthropic-messages');
  assert.equal(selected.models['gpt-6-sol'], catalog['gpt-6-sol']);
  assert.deepEqual(selected.unsupported, []);
});

test('exclude non-picker, disabled, unconfigured, invalid-policy, and tool-less models', () => {
  for (const changes of [
    { model_picker_enabled: false }, { model_picker_enabled: 'true' },
    { policy: { state: 'disabled' } }, { policy: { state: 'unconfigured' } },
    { policy: { state: '' } }, { policy: { state: null } },
    { capabilities: { supports: { tool_calls: false } } },
  ]) {
    assert.throws(() => select([accountItem('gpt-6-sol', changes)]), /No supported/);
  }
  assert.equal(Object.keys(select([accountItem('gpt-6-sol', { policy: undefined })]).models).length, 1);
});

test('new validated siblings inherit compatibility, not stale limits or names', () => {
  const catalog = catalogFixture();
  const before = structuredClone(catalog);
  const result = select([accountItem('gpt-6.1-sol', { name: 'New Sol' }), accountItem('gpt-5.6-sol-fast')], catalog);
  const model = result.models['gpt-6.1-sol'];
  assert.equal(model.name, 'New Sol');
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.maxTokens, 128000);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.compat, catalog['gpt-6-sol'].compat);
  assert.equal(model.thinkingLevelMap.off, null);
  assert.equal(model.thinkingLevelMap.minimal, null);
  assert.equal(model.thinkingLevelMap.low, null);
  assert.equal(model.thinkingLevelMap.max, 'max');
  assert.deepEqual(catalog, before);
});

test('reasoning arrays constrain both known sibling types and preserve wire mappings', () => {
  const catalog = catalogFixture();
  catalog['gpt-5.6-sol'].thinkingLevelMap.high = 'provider-high';
  const item = accountItem('gpt-5.6-sol-fast');
  item.capabilities.supports.reasoning_effort = ['provider-high'];
  item.capabilities.supports.vision = false;
  const model = select([item], catalog).models[item.id];
  assert.equal(model.thinkingLevelMap.high, 'provider-high');
  assert.equal(model.thinkingLevelMap.medium, null);
  assert.equal(model.thinkingLevelMap.off, null);
  assert.deepEqual(model.input, ['text']);
});

test('unknown and inherited-property IDs are skipped and deduplicated safely', () => {
  const catalog = catalogFixture();
  const result = select([
    null, {}, { id: '' }, accountItem('gpt-6-sol'),
    ...['unknown', 'unknown', '__proto__', 'constructor', 'toString'].map((id) => accountItem(id)),
  ], catalog);
  assert.deepEqual(Object.keys(result.models), ['gpt-6-sol']);
  assert.deepEqual(result.unsupported, ['unknown', '__proto__', 'constructor', 'toString']);
  assert.equal(Object.getPrototypeOf(result.models), null);
  assert.equal(Object.hasOwn(MODEL_TEMPLATES, '__proto__'), false);
});

test('new IDs require responses support, a matching template and sound positive limits', () => {
  const valid = accountItem('gpt-6.1-sol');
  for (const endpoint of [undefined, '/responses', {}, ['/chat/completions']]) {
    assert.throws(() => select([{ ...valid, supported_endpoints: endpoint }]), /No supported/);
  }
  for (const value of [0, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1, '200000']) {
    const item = structuredClone(valid);
    item.capabilities.limits.max_context_window_tokens = value;
    assert.throws(() => select([item]), /No supported/);
  }
  const tooLarge = structuredClone(valid);
  tooLarge.capabilities.limits.max_output_tokens = 1000001;
  assert.throws(() => select([tooLarge]), /No supported/);
  const wrongApi = catalogFixture();
  wrongApi['gpt-6-sol'].api = 'openai-completions';
  assert.throws(() => select([valid], wrongApi), /No supported/);
});

test('invalid response or empty selection cannot replace defaults', () => {
  const catalog = catalogFixture();
  const before = structuredClone(catalog);
  for (const response of [null, {}, { data: {} }, { data: [] }]) {
    assert.throws(() => selectAccountModels(response, catalog));
  }
  assert.deepEqual(catalog, before);
});

test('pricing converts cents per million tokens including validated long-context tiers', () => {
  const prices = { input_price: 250, output_price: 1000, cache_price: 25, cache_write_price: 0, context_max: 200000 };
  const billing = { token_prices: { batch_size: 1000000, default: prices, long_context: { ...prices, input_price: 500 } } };
  assert.deepEqual(liveCost(billing, {}), {
    input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0,
    tiers: [{ inputTokensAbove: 200000, input: 5, output: 10, cacheRead: 0.25, cacheWrite: 0 }],
  });
  const invalidLong = structuredClone(billing);
  invalidLong.token_prices.long_context.output_price = -1;
  assert.equal(liveCost(invalidLong, {}).tiers, undefined);
});

test('incomplete, negative, non-finite or differently scaled prices preserve fallback', () => {
  const fallback = { input: 2 };
  for (const billing of [null, {}, { token_prices: { batch_size: 1000, default: {} } },
    ...[undefined, -1, Infinity, '2'].map((input_price) => ({ token_prices: {
      batch_size: 1000000, default: { input_price, output_price: 0, cache_price: 0, cache_write_price: 0 },
    } })),
  ]) assert.equal(liveCost(billing, fallback), fallback);
});

test('replaceCatalog commits a validated selection and preflights immutability', () => {
  const catalog = catalogFixture();
  const models = select([accountItem('gpt-6.1-sol')], catalog).models;
  replaceCatalog(catalog, models);
  assert.deepEqual(Object.keys(catalog), ['gpt-6.1-sol']);
  for (const target of [Object.freeze(catalogFixture()), Object.preventExtensions(catalogFixture())]) {
    const before = structuredClone(target);
    assert.throws(() => replaceCatalog(target, models), /not mutable/);
    assert.deepEqual(target, before);
  }
});
