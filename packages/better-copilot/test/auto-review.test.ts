import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmError, LlmRuntime, markAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { configureAutoReview, DEFAULT_REVIEW_MODEL } from '../dist/auto-review.js';
import { createPlugin } from '../dist/plugin.js';
import { Config, minimalDependencies } from './merged-fixtures.js';
import { accountItem, catalogFixture, grantFixture } from './catalog-helpers.js';
import type { ModelCatalog } from '../dist/catalog-types.js';

const review = (overrides: Partial<GenerateOptions<string>> = {}): GenerateOptions<string> => Object.freeze({
  provider: 'github-copilot', model: 'gpt-6.1-sol', purpose: 'auto-review', temperature: 0,
  system: 'original review policy', messages: Object.freeze([]) as unknown as GenerateOptions['messages'],
  ...overrides,
});

const enabled = { enabled: true };

test('Copilot reviews default to Terra without changing the builtin request', () => {
  const original = review();
  const selected = configureAutoReview(original, enabled);
  assert.equal(DEFAULT_REVIEW_MODEL, 'gpt-6.1-terra');
  assert.equal(selected.model, DEFAULT_REVIEW_MODEL);
  assert.equal(selected.provider, original.provider);
  assert.equal(selected.reasoningEffort, undefined, 'review model uses adapter default');
  assert.equal(selected.messages, original.messages);
  assert.equal(selected.system, original.system);
  assert.ok(!Object.hasOwn(selected, 'temperature'), 'unknown reviewer sampling support omits the builtin zero');
  assert.equal(original.model, 'gpt-6.1-sol');
  assert.ok(Object.isFrozen(selected));
});

test('DeepSeek Flash and other providers retain their current review model', () => {
  for (const provider of ['deepseek', 'deepseek-account', 'github-copilot']) {
    const original = review({ provider, model: 'deepseek-v4-flash' });
    assert.equal(configureAutoReview(original, enabled).model, original.model);
  }
  const original = review({ provider: 'other', model: 'model-id' });
  assert.equal(configureAutoReview(original, enabled), original);
});

test('reviewer temperature requires positive capability even when the model does not change', () => {
  const base = catalogFixture()['gpt-6-sol']!;
  const original = review({ model: DEFAULT_REVIEW_MODEL });
  for (const support of [false, undefined, 'true']) {
    const catalog = { [DEFAULT_REVIEW_MODEL]: { ...base, id: DEFAULT_REVIEW_MODEL, compat: { supportsTemperature: support } } } as unknown as Parameters<typeof configureAutoReview>[2];
    assert.ok(!Object.hasOwn(configureAutoReview(original, enabled, catalog), 'temperature'));
  }
  const catalog = { [DEFAULT_REVIEW_MODEL]: { ...base, id: DEFAULT_REVIEW_MODEL, compat: { supportsTemperature: true } } };
  assert.equal(configureAutoReview(original, enabled, catalog), original);
});

test('explicit model and effort override defaults independently, using opaque ids', () => {
  const original = review({ provider: 'deepseek-account', model: 'deepseek-v4-flash' });
  const selected = configureAutoReview(original, { ...enabled, model: 'exact-review-id', reasoningEffort: 'max' });
  assert.equal(selected.model, 'exact-review-id');
  assert.equal(selected.reasoningEffort, 'max');
  assert.equal(selected.provider, 'deepseek-account');
  const effortOnly = configureAutoReview(review(), { ...enabled, reasoningEffort: 'high' });
  assert.equal(effortOnly.model, DEFAULT_REVIEW_MODEL);
  assert.equal(effortOnly.reasoningEffort, 'high');
});

test('a changed model drops old effort; an unchanged model retains it', () => {
  const original = review({ reasoningEffort: 'max' as GenerateOptions['reasoningEffort'], temperature: undefined });
  assert.ok(!Object.hasOwn(configureAutoReview(original, enabled), 'reasoningEffort'));
  assert.equal(configureAutoReview(original, { ...enabled, model: original.model }), original);
});

test('disabled routing and non-review or loop requests are byte-identical', () => {
  const original = review();
  assert.equal(configureAutoReview(original, { enabled: false, model: 'override', reasoningEffort: 'high' }), original);
  for (const purpose of [undefined, 'agent-loop', 'web-search', 'tool-result/summary']) {
    const options = review({ purpose });
    assert.equal(configureAutoReview(options, { ...enabled, model: 'override' }), options);
  }
  const loop = review();
  markAgentLoopRequest(loop as GenerateOptions);
  assert.equal(configureAutoReview(loop, { ...enabled, model: 'override' }), loop);
});

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(readonly provider: string) { super(); }
  override async resolveModel(_provider: string, model: string) {
    return { provider: this.provider, id: model, name: model, reasoning: {
      efforts: [{ id: 'high' as NonNullable<GenerateOptions['reasoningEffort']>, name: 'High' }],
      defaultEffort: 'high' as NonNullable<GenerateOptions['reasoningEffort']>,
    } };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    options.signal?.throwIfAborted();
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

test('real LLM waterfall routes a frozen builtin review once, validates effort and releases on unload', async t => {
  const host = new Context();
  host.provide('credentials', { readRecord: async () => undefined, resolve: async () => undefined });
  // Mount the public LLM service before the plugin.
  const llm = new LlmRuntime(host);
  const adapter = new RecordingAdapter('github-copilot');
  llm.registerAdapter(['github-copilot'], adapter);
  let modelReads = 0;
  const config = Config({ providers: {} });
  config.autoReview.model = { get: () => { modelReads++; return 'review-model'; } };
  config.autoReview.reasoningEffort = { get: () => 'high' };
  const plugin = createPlugin(minimalDependencies());
  // Direct apply with resolved volatile settings, owned by a plugin fiber.
  const fiber = host.plugin({ name: 'review-test', apply: (ctx: Context) => plugin.apply(ctx, config) });
  await fiber;
  t.after(async () => { await fiber.dispose(); });
  const abort = new AbortController();
  const options = review({ signal: abort.signal, sessionId: 'synthetic-session' as GenerateOptions['sessionId'] });
  for await (const _chunk of llm.stream(options as GenerateOptions)) { /* consume */ }
  assert.equal(adapter.requests.length, 1);
  assert.equal(modelReads, 1, 'nested waterfall uses the captured selection');
  const selected = adapter.requests[0]!;
  assert.equal(selected.model, 'review-model');
  assert.equal(selected.reasoningEffort, 'high');
  assert.equal(selected.sessionId, options.sessionId);
  assert.equal(selected.purpose, 'auto-review');
  assert.equal(selected.signal, abort.signal);
  assert.equal(selected.messages, options.messages);
  assert.equal(selected.system, options.system);
  assert.equal(options.model, 'gpt-6.1-sol');

  const ordinary = review({ purpose: undefined });
  for await (const _chunk of llm.stream(ordinary as GenerateOptions)) { /* consume */ }
  assert.equal(adapter.requests.at(-1)!.model, ordinary.model);
  assert.equal(modelReads, 1);

  config.autoReview.reasoningEffort = { get: () => 'unsupported' };
  const chunks: StreamChunk[] = [];
  for await (const chunk of llm.stream(options as GenerateOptions)) chunks.push(chunk);
  const finish = chunks.at(-1);
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error');
  assert.equal(finish.reason.failure.code, 'UNSUPPORTED_REASONING_EFFORT');
  assert.equal(adapter.requests.length, 2, 'invalid explicit efforts never dispatch');

  await fiber.dispose();
  for await (const _chunk of llm.stream(options as GenerateOptions)) { /* consume */ }
  assert.equal(adapter.requests.at(-1)!.model, options.model);
});

test('review dispatch materializes adapter effort defaults and live settings affect only the next call', async t => {
  const host = new Context();
  host.provide('credentials', { readRecord: async () => undefined, resolve: async () => undefined });
  const llm = new LlmRuntime(host);
  const adapter = new RecordingAdapter('github-copilot');
  llm.registerAdapter(['github-copilot'], adapter);
  const config = Config({ providers: {} });
  let model: string | undefined;
  let enabled = true;
  config.autoReview.model = { get: () => model };
  config.autoReview.enabled = { get: () => enabled };
  const plugin = createPlugin(minimalDependencies());
  const fiber = host.plugin({ name: 'review-default-test', apply: (ctx: Context) => plugin.apply(ctx, config) });
  await fiber;
  t.after(async () => { await fiber.dispose(); });
  const original = review({ reasoningEffort: 'old-model-effort' as GenerateOptions['reasoningEffort'] });
  for await (const _chunk of llm.stream(original as GenerateOptions)) { /* consume */ }
  assert.equal(adapter.requests.at(-1)!.model, DEFAULT_REVIEW_MODEL);
  assert.equal(adapter.requests.at(-1)!.reasoningEffort, 'high', 'new reviewer uses its own adapter default');
  assert.equal(original.reasoningEffort, 'old-model-effort');
  model = 'next-review-model';
  for await (const _chunk of llm.stream(original as GenerateOptions)) { /* consume */ }
  assert.equal(adapter.requests.at(-1)!.model, model);
  assert.equal(adapter.requests.at(-1)!.reasoningEffort, 'high');
  assert.equal(adapter.requests[0]!.model, DEFAULT_REVIEW_MODEL, 'prior request is not changed by settings edits');
  enabled = false;
  const builtin = review();
  for await (const _chunk of llm.stream(builtin as GenerateOptions)) { /* consume */ }
  assert.equal(adapter.requests.at(-1)!.model, builtin.model);
  assert.equal(adapter.requests.at(-1)!.temperature, 0, 'disabled auxiliary policy delegates builtin controls');
});

class CatalogReviewAdapter extends RecordingAdapter {
  readonly resolutions: string[] = [];
  constructor(readonly catalog: ModelCatalog, readonly declared: ReadonlySet<string> = new Set()) {
    super('github-copilot');
  }
  override async resolveModel(provider: string, model: string) {
    this.resolutions.push(model);
    if (!Object.hasOwn(this.catalog, model) && !this.declared.has(model)) {
      throw new LlmError(`Synthetic Copilot model "${model}" is unavailable`, 'UNKNOWN_MODEL');
    }
    return super.resolveModel(provider, model);
  }
}

/** Mount the complete parent plugin, but all credential and /models I/O is synthetic. */
async function reviewCatalogFixture(customModel?: string) {
  const host = new Context();
  const grant = grantFixture();
  host.provide('credentials', {
    readRecord: async () => grant,
    resolve: async () => undefined,
  });
  const llm = new LlmRuntime(host);
  const catalog = catalogFixture();
  const adapter = new CatalogReviewAdapter(catalog, new Set(customModel === undefined ? [] : [customModel]));
  let fetches = 0;
  const base = minimalDependencies();
  const plugin = createPlugin({
    ...base, catalog,
    original: { ...base.original, apply(ctx) { ctx.llm.registerAdapter(['github-copilot'], adapter); } },
    fetcher: async (input) => {
      assert.equal(new URL(String(input)).pathname, '/models', 'no inference or real account network request');
      fetches++;
      return Response.json({ data: [accountItem('gpt-6-sol')] });
    },
  });
  const config = Config({
    providers: { 'github-copilot': customModel === undefined ? {} : { models: [{ id: customModel }] } },
    catalog: { cache: false },
    autoReview: customModel === undefined ? {} : { model: customModel },
  });
  const fiber = host.plugin({ name: 'catalog-review-regression', inject: ['llm', 'credentials'], apply(ctx: Context) {
    return plugin.apply(ctx, config);
  } });
  await fiber;
  return { llm, adapter, catalog, fiber, fetches: () => fetches };
}

test('missing Terra reviewer attempts one catalog refresh then returns controlled UNKNOWN_MODEL without fallback', async (t) => {
  const fixture = await reviewCatalogFixture();
  t.after(async () => { await fixture.fiber.dispose(); });
  const initialFetches = fixture.fetches();
  assert.equal(initialFetches, 1, 'mount uses one synthetic account catalog fetch');
  const options = review();
  const chunks: StreamChunk[] = [];
  for await (const chunk of fixture.llm.stream(options as GenerateOptions)) chunks.push(chunk);
  const finish = chunks.at(-1);
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error');
  assert.equal(finish.reason.failure.code, 'UNKNOWN_MODEL');
  assert.match(finish.reason.failure.message, /gpt-6\.1-terra/);
  assert.match(finish.reason.failure.message, /remains unavailable after catalog refresh/);
  assert.match(finish.reason.failure.message, /autoReview\.model/);
  assert.equal(fixture.fetches() - initialFetches, 1, 'missing reviewer triggers exactly one refresh before model resolution');
  assert.deepEqual(fixture.adapter.resolutions, [DEFAULT_REVIEW_MODEL], 'never tries the caller model or an arbitrary available reviewer');
  assert.equal(fixture.adapter.requests.length, 0, 'unknown reviewer fails before inference dispatch');
  assert.equal(options.model, 'gpt-6.1-sol', 'builtin request remains unchanged');

  for await (const _chunk of fixture.llm.stream(options as GenerateOptions)) { /* consume controlled refusal */ }
  assert.equal(fixture.fetches() - initialFetches, 1, 'missing-model cooldown prevents repeated catalog traffic');
  assert.deepEqual(fixture.adapter.resolutions, [DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_MODEL]);
  assert.equal(fixture.adapter.requests.length, 0);
});

test('explicit configured custom reviewer stays allowed despite absence from the account-discovery catalog', async (t) => {
  const custom = 'synthetic-configured-reviewer';
  const fixture = await reviewCatalogFixture(custom);
  t.after(async () => { await fixture.fiber.dispose(); });
  const initialFetches = fixture.fetches();
  assert.equal(Object.hasOwn(fixture.catalog, custom), false, 'account-discovery catalog does not advertise the explicit profile model');
  const options = review({ reasoningEffort: 'caller-model-effort' as GenerateOptions['reasoningEffort'] });
  const chunks: StreamChunk[] = [];
  for await (const chunk of fixture.llm.stream(options as GenerateOptions)) chunks.push(chunk);
  const finish = chunks.at(-1);
  assert.ok(finish?.type === 'finish' && finish.reason.kind === 'stop');
  assert.equal(fixture.fetches() - initialFetches, 1, 'one missing-catalog refresh does not turn advisory membership into a routing gate');
  assert.deepEqual(fixture.adapter.resolutions, [custom]);
  assert.equal(fixture.adapter.requests.length, 1);
  assert.equal(fixture.adapter.requests[0]!.model, custom);
  assert.equal(fixture.adapter.requests[0]!.reasoningEffort, 'high', 'configured reviewer owns its reasoning default');
  assert.equal(fixture.adapter.requests[0]!.purpose, 'auto-review');
  assert.equal(fixture.adapter.requests[0]!.messages, options.messages);
  assert.equal(fixture.adapter.requests[0]!.system, options.system);
  assert.equal(Object.hasOwn(fixture.catalog, custom), false);
  assert.equal(options.model, 'gpt-6.1-sol');
});
