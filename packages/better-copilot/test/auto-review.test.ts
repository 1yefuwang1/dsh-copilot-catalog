import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmRuntime, markAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { configureAutoReview, DEFAULT_REVIEW_MODEL } from '../dist/auto-review.js';
import { createPlugin } from '../dist/plugin.js';
import { Config, minimalDependencies } from './merged-fixtures.js';
import { catalogFixture } from './catalog-helpers.js';

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
