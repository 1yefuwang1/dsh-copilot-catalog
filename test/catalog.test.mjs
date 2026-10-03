import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copilotHeaders, liveCost, replaceCatalog, selectAccountModels } from '../dist/catalog.js';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { accountItem, catalogFixture } from './helpers.mjs';

const select = (items, catalog = catalogFixture(), options) => selectAccountModels({ data: items }, catalog, options);

const rates = (input = 250) => ({ input_price: input, output_price: 1000, cache_price: 25, cache_write_price: 0 });

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

test('arbitrary new model IDs need no bundled siblings or model-family guesses', () => {
  const items = ['future-reasoner', 'acme/custom-model', 'brand-new-id'].map((id) => accountItem(id));
  const { models, unsupported } = select(items, {});
  assert.deepEqual(Object.keys(models), items.map((item) => item.id));
  assert.deepEqual(unsupported, []);
  for (const item of items) {
    const model = models[item.id];
    assert.equal(model.api, 'openai-responses');
    assert.equal(model.provider, 'github-copilot');
    assert.equal(model.contextWindow, 1000000);
    assert.equal(model.maxTokens, 128000);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.compat.supportsStrictMode, false);
    assert.deepEqual(getSupportedThinkingLevels(model), ['medium', 'high', 'xhigh', 'max']);
  }
});

test('both formerly special-cased IDs are handled exactly like arbitrary IDs', () => {
  const ids = ['gpt-6.1-sol', 'gpt-5.6-sol-fast', 'unrelated-new-model'];
  const { models } = select(ids.map((id) => accountItem(id)), {});
  const normalize = (model) => ({ ...model, id: 'same', name: 'same' });
  assert.deepEqual(normalize(models[ids[0]]), normalize(models[ids[1]]));
  assert.deepEqual(normalize(models[ids[0]]), normalize(models[ids[2]]));
});

test('protocols are selected by advertised endpoints, independent of model names', () => {
  for (const [id, endpoint, api] of [
    ['claude-name-but-responses', '/responses', 'openai-responses'],
    ['gpt-name-but-messages', '/v1/messages', 'anthropic-messages'],
    ['anonymous-chat-model', '/chat/completions', 'openai-completions'],
  ]) {
    const { models } = select([accountItem(id, { supported_endpoints: [endpoint] })], {});
    assert.equal(models[id].api, api);
  }
});

test('multiple endpoints use a deterministic preference: Responses, native Messages, then Chat', () => {
  for (const endpoints of [
    ['/chat/completions', '/v1/messages', '/responses'],
    ['/responses', '/chat/completions', '/v1/messages'],
  ]) assert.equal(select([accountItem('multi-api', { supported_endpoints: endpoints })], {}).models['multi-api'].api, 'openai-responses');
  assert.equal(select([accountItem('multi-api', { supported_endpoints: ['/chat/completions', '/v1/messages'] })], {}).models['multi-api'].api, 'anthropic-messages');
});

test('new descriptors do not inherit another model\'s compat, limits, pricing, or credentials', () => {
  const catalog = catalogFixture();
  const before = structuredClone(catalog);
  const item = accountItem('new-model', {
    name: 'New Model', api: 'anthropic-messages',
    baseUrl: 'https://attacker.example',
    headers: { Authorization: 'must-not-win' },
  });
  const model = select([item], catalog, { baseUrl: 'https://api.enterprise.githubcopilot.com' }).models[item.id];
  assert.equal(model.name, 'New Model');
  assert.equal(model.api, 'openai-responses');
  assert.equal(model.baseUrl, 'https://api.enterprise.githubcopilot.com');
  assert.notEqual(model.compat, catalog['gpt-6-sol'].compat);
  assert.equal(model.compat.supportsStrictMode, false);
  assert.equal(model.headers.Authorization, undefined);
  assert.equal(model.headers['Editor-Version'], 'vscode/test');
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(catalog, before);
});

test('only advertised reasoning levels are offered; none maps to the off selector', () => {
  for (const [efforts, expected] of [
    [['none', 'low', 'high'], ['off', 'low', 'high']],
    [['off', 'medium'], ['off', 'medium']],
    [['minimal', 'xhigh', 'max'], ['minimal', 'xhigh', 'max']],
  ]) {
    const item = accountItem('selective-reasoner');
    item.capabilities.supports.reasoning_effort = efforts;
    const model = select([item], {}).models[item.id];
    assert.deepEqual(getSupportedThinkingLevels(model), expected);
    if (efforts.includes('none')) assert.equal(model.thinkingLevelMap.off, 'none');
  }
});

test('missing, empty, malformed or unrecognized effort metadata never invents reasoning settings', () => {
  for (const efforts of [undefined, [], ['unsupported-effort'], [42], true, 'high']) {
    const item = accountItem('unconfigured-reasoning');
    item.capabilities.supports.reasoning_effort = efforts;
    item.capabilities.supports.vision = false;
    const model = select([item], {}).models[item.id];
    assert.equal(model.reasoning, false);
    assert.deepEqual(getSupportedThinkingLevels(model), ['off']);
    assert.deepEqual(model.input, ['text']);
  }
});

test('native Anthropic supports advertised adaptive effort or explicit legacy budget thinking', () => {
  const adaptive = accountItem('native-adaptive', { supported_endpoints: ['/v1/messages'] });
  const budget = accountItem('native-budget', { supported_endpoints: ['/v1/messages'] });
  delete budget.capabilities.supports.reasoning_effort;
  budget.capabilities.supports.thinking = true;
  const { models } = select([adaptive, budget], {});
  assert.equal(models[adaptive.id].compat.forceAdaptiveThinking, true);
  assert.deepEqual(getSupportedThinkingLevels(models[adaptive.id]), ['medium', 'high', 'xhigh', 'max']);
  assert.equal(models[budget.id].compat.forceAdaptiveThinking, false);
  assert.deepEqual(getSupportedThinkingLevels(models[budget.id]), ['off', 'minimal', 'low', 'medium', 'high']);
});

test('unknown protocols are logged, deduplicated, and do not hide supported new IDs', () => {
  const unsupported = accountItem('unknown-protocol', { supported_endpoints: ['/embeddings'] });
  const { models, unsupported: skipped } = select([
    null, {}, { id: '' }, unsupported, unsupported, accountItem('supported-future-model'),
  ], {});
  assert.deepEqual(Object.keys(models), ['supported-future-model']);
  assert.deepEqual(skipped, ['unknown-protocol']);
});

test('prototype-sensitive IDs become real own descriptors without prototype mutation', () => {
  const ids = ['__proto__', 'constructor', 'toString'];
  const { models } = select(ids.map((id) => accountItem(id)), {});
  assert.equal(Object.getPrototypeOf(models), null);
  for (const id of ids) {
    assert.ok(Object.hasOwn(models, id));
    assert.equal(models[id].id, id);
    assert.equal(typeof models[id], 'object');
  }
  const target = catalogFixture();
  replaceCatalog(target, models);
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  assert.equal(target.__proto__.id, '__proto__');
  assert.equal({}.id, undefined);
});

test('duplicate supported entries remain supported regardless of a malformed duplicate', () => {
  const invalid = accountItem('duplicate', { supported_endpoints: ['/unknown'] });
  for (const items of [[invalid, accountItem('duplicate')], [accountItem('duplicate'), invalid]]) {
    const result = select(items, {});
    assert.deepEqual(Object.keys(result.models), ['duplicate']);
    assert.deepEqual(result.unsupported, []);
  }
});

test('new IDs require a supported endpoint, chat semantics, streaming, and positive valid limits', () => {
  const valid = accountItem('future-model');
  for (const endpoint of [undefined, '/responses', {}, [], ['/unknown'], ['https://attacker.example/responses']]) {
    assert.throws(() => select([{ ...valid, supported_endpoints: endpoint }], {}), /No supported/);
  }
  for (const field of ['max_context_window_tokens', 'max_output_tokens']) {
    for (const value of [0, -1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1, '200000', undefined]) {
      const item = structuredClone(valid);
      item.capabilities.limits[field] = value;
      assert.throws(() => select([item], {}), /No supported/);
    }
  }
  const tooLarge = structuredClone(valid);
  tooLarge.capabilities.limits.max_output_tokens = 1000001;
  assert.throws(() => select([tooLarge], {}), /No supported/);
  const nonChat = structuredClone(valid);
  nonChat.capabilities.type = 'embeddings';
  assert.throws(() => select([nonChat], {}), /No supported/);
  const nonStreaming = structuredClone(valid);
  nonStreaming.capabilities.supports.streaming = false;
  assert.throws(() => select([nonStreaming], {}), /No supported/);
  for (const id of ['bad id', 'leading ', 'bad\nline', 'bad\u0000id']) {
    assert.throws(() => select([accountItem(id)], {}), /No supported/);
  }
});

test('headers work without any particular model and exclude non-identity fields', () => {
  const catalog = catalogFixture();
  const headers = copilotHeaders({ only: catalog.claude });
  assert.equal(headers['Editor-Version'], 'vscode/test');
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers['Copilot-Integration-Id'], 'vscode-chat');
  assert.equal(copilotHeaders({})['Editor-Version'], 'vscode/1.107.0');
});

test('invalid response or empty selection cannot replace defaults', () => {
  const catalog = catalogFixture();
  const before = structuredClone(catalog);
  for (const response of [null, {}, { data: {} }, { data: [] }]) {
    assert.throws(() => selectAccountModels(response, catalog));
  }
  assert.deepEqual(catalog, before);
});

test('live pricing for an arbitrary new model overrides unknown rates', () => {
  const item = accountItem('new-priced-model', { billing: { token_prices: {
    batch_size: 1000000, default: rates(),
  } } });
  assert.deepEqual(select([item], {}).models[item.id].cost, { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 });
});

test('pricing converts cents per million tokens including validated long-context tiers', () => {
  const billing = { token_prices: { batch_size: 1000000, default: { ...rates(), context_max: 200000 }, long_context: rates(500) } };
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
  const models = select([accountItem('arbitrary-new-model')], catalog).models;
  replaceCatalog(catalog, models);
  assert.deepEqual(Object.keys(catalog), ['arbitrary-new-model']);
  for (const target of [Object.freeze(catalogFixture()), Object.preventExtensions(catalogFixture())]) {
    const before = structuredClone(target);
    assert.throws(() => replaceCatalog(target, models), /not mutable/);
    assert.deepEqual(target, before);
  }
});
