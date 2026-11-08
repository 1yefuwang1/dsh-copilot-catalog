import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
  LlmAdapter, LlmRuntime, type AdapterRegistrationHandle, type GenerateOptions,
  type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import * as original from '@deepseek-ai/dsh-llm-pi-ai';
import type { PluginContext } from '../dist/catalog-types.js';
import { adapterContext, createCatalogAdapter } from '../dist/catalog-adapter.js';
import { transportResponse } from './transport-fixtures.js';

const COPILOT = 'github-copilot';
const request = (provider = COPILOT, model = 'synthetic-model'): GenerateOptions => ({
  provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
});
const drain = async (stream: AsyncIterable<StreamChunk>) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

class RecordingAdapter extends LlmAdapter {
  #receiver = this;
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly handles: PreparedAdapterCall[] = [];
  generation = 1;
  closed = 0;
  readonly retry = { mode: 'always' as const, initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 };
  readonly pricing = { priceImages: () => [] };
  readonly target = { width: 1, height: 2, maxBytes: 3 };
  record(method: string, args: unknown[]) {
    assert.equal(this.#receiver, this, `${method} preserves the adapter receiver`);
    this.calls.push({ method, args });
  }
  info(provider: string, model: string): LlmResolvedModelInfo {
    return { provider, id: model, name: `${model}-${this.generation}`, context: { contextWindow: this.generation * 1000 } };
  }
  override providerInfo(provider: string) {
    this.record('providerInfo', [provider]);
    return { id: provider, name: 'Synthetic provider' };
  }
  override providerRetryPolicy(provider: string) {
    this.record('providerRetryPolicy', [provider]);
    return this.retry;
  }
  override imageRequestPricing(...args: Parameters<LlmAdapter['imageRequestPricing']>) {
    this.record('imageRequestPricing', args);
    return this.pricing;
  }
  override imageRequestTarget(...args: Parameters<LlmAdapter['imageRequestTarget']>) {
    this.record('imageRequestTarget', args);
    return this.target;
  }
  override async listModels(provider: string) {
    this.record('listModels', [provider]);
    return [this.info(provider, 'synthetic-model')];
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    this.record('resolveModel', [provider, model, signal]);
    return this.info(provider, model);
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    this.record('prepareCall', [provider, model, signal]);
    const snapshot = this.info(provider, model);
    const owner = this;
    const prepared: PreparedAdapterCall = {
      model: snapshot,
      async *stream(options) {
        assert.equal(this, prepared, 'prepared stream retains its own receiver');
        owner.record('preparedStream', [options, snapshot.context?.contextWindow]);
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    this.handles.push(prepared);
    return prepared;
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.record('stream', [options]);
    try {
      yield { type: 'text-delta', index: 0, text: `${this.generation}` };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally { this.closed++; }
  }
}

test('forwards every synchronous adapter method unchanged and never refreshes', () => {
  const original = new RecordingAdapter();
  const wrapped = createCatalogAdapter(original, async () => { assert.fail('synchronous methods must not refresh'); });
  const image = { attachmentId: 'synthetic-image', mediaType: 'image/png', bytes: 1, width: 2, height: 3 } as Parameters<LlmAdapter['imageRequestTarget']>[2];
  assert.deepEqual(wrapped.providerInfo(COPILOT), { id: COPILOT, name: 'Synthetic provider' });
  assert.equal(wrapped.providerRetryPolicy(COPILOT), original.retry);
  assert.equal(wrapped.imageRequestPricing(COPILOT, 'm'), original.pricing);
  assert.equal(wrapped.imageRequestTarget(COPILOT, 'm', image), original.target);
  assert.deepEqual(original.calls.map((call) => call.method), [
    'providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'imageRequestTarget',
  ]);
  assert.equal(original.calls.at(-1)!.args[2], image);
});

test('awaits refresh before any public asynchronous method captures a snapshot', async (t) => {
  for (const method of ['resolveModel', 'listModels', 'prepareCall', 'stream'] as const) {
    await t.test(method, async () => {
      const original = new RecordingAdapter();
      const gate = deferred();
      const signal = new AbortController().signal;
      const refreshes: unknown[][] = [];
      const wrapped = createCatalogAdapter(original, async (model, suppliedSignal) => {
        refreshes.push([model, suppliedSignal]);
        await gate.promise;
        original.generation = 2;
      });
      const options = { ...request(), signal };
      const pending = method === 'stream' ? drain(wrapped.stream(options))
        : method === 'listModels' ? wrapped.listModels(COPILOT)
          : wrapped[method](COPILOT, options.model, signal);
      assert.equal(original.calls.length, 0, 'no adapter operation before refresh settles');
      assert.deepEqual(refreshes, [[method === 'listModels' ? undefined : options.model,
        method === 'listModels' ? undefined : signal]]);
      gate.resolve();
      const result = await pending;
      assert.equal(original.calls[0]!.method, method);
      if (method === 'resolveModel') assert.equal((result as LlmResolvedModelInfo).context?.contextWindow, 2000);
      if (method === 'prepareCall') assert.equal((result as PreparedAdapterCall).model.context?.contextWindow, 2000);
      if (method === 'listModels') assert.equal((result as LlmResolvedModelInfo[])[0]!.name, 'synthetic-model-2');
      if (method === 'stream') assert.deepEqual((result as StreamChunk[])[0], { type: 'text-delta', index: 0, text: '2' });
      if (method === 'resolveModel' || method === 'prepareCall') assert.equal(original.calls[0]!.args[2], signal);
      if (method === 'stream') assert.equal(original.calls[0]!.args[0], options);
    });
  }
});

test('all non-Copilot routes bypass refresh including lookalike provider names', async () => {
  const original = new RecordingAdapter();
  const wrapped = createCatalogAdapter(original, async () => { assert.fail('only the exact github-copilot route refreshes'); });
  for (const provider of ['openai', 'github-copilot-other', 'GitHub-Copilot']) {
    await wrapped.resolveModel(provider, 'm');
    await wrapped.listModels(provider);
    const prepared = await wrapped.prepareCall(provider, 'm');
    await drain(prepared.stream(request(provider, 'm')));
    await drain(wrapped.stream(request(provider, 'm')));
  }
  assert.equal(original.calls.length, 15);
});

test('prepared handle identity and generation survive dispatch without another refresh', async () => {
  const original = new RecordingAdapter();
  let refreshes = 0;
  const wrapped = createCatalogAdapter(original, async () => { refreshes++; original.generation = 2; });
  const prepared = await wrapped.prepareCall(COPILOT, 'm');
  assert.equal(prepared, original.handles[0]);
  original.generation = 3;
  await drain(prepared.stream(request(COPILOT, 'm')));
  assert.equal(refreshes, 1);
  assert.equal(prepared.model.context?.contextWindow, 2000);
  assert.equal(original.calls.at(-1)!.args[1], 2000);
});

test('direct stream delegates iterator cleanup and propagates iterator failure', async () => {
  const original = new RecordingAdapter();
  const wrapped = createCatalogAdapter(original, async () => {});
  for await (const _chunk of wrapped.stream(request())) break;
  assert.equal(original.closed, 1);
  const failure = new Error('synthetic iteration failure');
  class ThrowingAdapter extends LlmAdapter {
    closed = false;
    override async *stream(): AsyncIterable<StreamChunk> {
      try { yield { type: 'finish', reason: { kind: 'stop' } }; throw failure; }
      finally { this.closed = true; }
    }
  }
  const throwing = new ThrowingAdapter();
  await assert.rejects(drain(createCatalogAdapter(throwing, async () => {}).stream(request())), (error) => error === failure);
  assert.equal(throwing.closed, true);
});

test('refresh errors and caller cancellation reject before underlying adapter work', async () => {
  const original = new RecordingAdapter();
  const failure = new Error('synthetic refresh failure');
  const wrapped = createCatalogAdapter(original, async () => { throw failure; });
  await assert.rejects(wrapped.resolveModel(COPILOT, 'm'), (error) => error === failure);
  await assert.rejects(wrapped.listModels(COPILOT), (error) => error === failure);
  await assert.rejects(wrapped.prepareCall(COPILOT, 'm'), (error) => error === failure);
  await assert.rejects(drain(wrapped.stream(request())), (error) => error === failure);
  const abort = new AbortController();
  const cancelled = createCatalogAdapter(original, async (_model, signal) => {
    assert.equal(signal, abort.signal);
    await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
  });
  const pending = cancelled.prepareCall(COPILOT, 'm', abort.signal);
  abort.abort(failure);
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(original.calls.length, 0);
});

test('public LlmRuntime prepares before waterfall and preserves registration-bound dispatch', async () => {
  const host = new Context();
  const llm = new LlmRuntime(host);
  const original = new RecordingAdapter();
  let refreshes = 0;
  const wrapped = createCatalogAdapter(original, async () => { refreshes++; original.generation = 2; });
  const registration = llm.registerAdapter([COPILOT], wrapped);
  const events: string[] = [];
  const listener = host.on('llm/stream', async function* (_options, next) {
    events.push('waterfall');
    yield* next();
  });
  try {
    const prepared = await llm.prepareCall({ provider: COPILOT, model: 'm' });
    assert.equal(prepared.context?.contextWindow, 2000);
    assert.equal(refreshes, 1);
    assert.deepEqual(events, [], 'AgentLoop preparation already has refreshed facts before any stream middleware');
    registration();
    const replacement = new RecordingAdapter();
    const nextRegistration = llm.registerAdapter([COPILOT], replacement);
    try {
      original.generation = 3;
      await drain(prepared.stream({ ...request(COPILOT, 'm'), ...prepared.config }));
      assert.equal(refreshes, 1);
      assert.equal(original.calls.at(-1)!.method, 'preparedStream');
      assert.equal(original.calls.at(-1)!.args[1], 2000);
      assert.equal(replacement.calls.some((call) => call.method === 'preparedStream'), false);
      assert.deepEqual(events, ['waterfall']);
    } finally { nextRegistration(); }
  } finally { listener(); registration(); }
});

test('public LlmRuntime.stream refreshes at its adapter preparation boundary exactly once', async () => {
  const host = new Context();
  const llm = new LlmRuntime(host);
  const original = new RecordingAdapter();
  let refreshes = 0;
  const registration = llm.registerAdapter([COPILOT], createCatalogAdapter(original, async () => {
    refreshes++;
    original.generation = 2;
  }));
  try {
    const chunks = await drain(llm.stream(request()));
    assert.equal(refreshes, 1);
    assert.deepEqual(original.calls.filter((call) => !call.method.startsWith('provider')).map((call) => call.method),
      ['prepareCall', 'preparedStream']);
    assert.ok(chunks.at(-1)?.type === 'finish');
    assert.equal(original.calls.at(-1)!.args[1], 2000);
  } finally { registration(); }
});

test('context facade preserves context functions/properties and handles, gating refresh to Copilot routes', async () => {
  const noLlm = { get() {}, effect() {} } as unknown as PluginContext;
  assert.equal(adapterContext(noLlm, async () => {}), noLlm);
  const registrations: { providers: string[]; adapter: LlmAdapter }[] = [];
  const replacements: string[][] = [];
  let disposed = 0;
  const handle = Object.assign(() => { disposed++; }, { replace: (providers: string[]) => { replacements.push(providers); } });
  class Service {
    #value = 'original service receiver';
    registerAdapter(providers: string[], adapter: LlmAdapter) {
      assert.equal(this.#value, 'original service receiver');
      registrations.push({ providers, adapter });
      return handle;
    }
    other() { return this.#value; }
  }
  const service = new Service();
  const ctx = { llm: service, get() { return this; }, effect() {}, token: {} };
  let refreshes = 0;
  const facade = adapterContext(ctx as unknown as PluginContext, async () => { refreshes++; });
  assert.notEqual(facade, ctx);
  assert.equal(facade.get, ctx.get);
  assert.equal(facade.effect, ctx.effect);
  assert.equal((facade as unknown as typeof ctx).token, ctx.token);
  assert.equal((facade.llm as unknown as Service).other(), 'original service receiver');
  const original = new RecordingAdapter();
  assert.equal(facade.llm.registerAdapter(['openai'], original), handle);
  assert.notEqual(registrations[0]!.adapter, original);
  await registrations[0]!.adapter.listModels('openai');
  assert.equal(refreshes, 0, 'non-Copilot registration forwards without refreshing');
  assert.equal(facade.llm.registerAdapter([COPILOT, 'anthropic'], original), handle);
  assert.notEqual(registrations[1]!.adapter, original);
  assert.equal(registrations.length, 2, 'one underlying registration per call');
  handle.replace(['anthropic']);
  assert.deepEqual(replacements, [['anthropic']]);
  handle();
  assert.equal(disposed, 1);
});

test('Cordis fiber owns facade registrations and replace/disposal without duplicate registration', async () => {
  const host = new Context();
  const llm = new LlmRuntime(host);
  const original = new RecordingAdapter();
  let handle!: AdapterRegistrationHandle;
  let refreshes = 0;
  const fiber = host.plugin({ name: 'catalog-context-owner', inject: ['llm'], apply(ctx: Context) {
    const facade = adapterContext(ctx, async () => { refreshes++; });
    assert.equal(facade.fiber, ctx.fiber);
    assert.equal(facade.root, ctx.root);
    handle = facade.llm.registerAdapter(['synthetic-other'], original);
  } });
  await fiber;
  try {
    assert.deepEqual(llm.listProviders().map((provider) => provider.id), ['synthetic-other']);
    await llm.listModels('synthetic-other');
    assert.equal(refreshes, 0);
    handle.replace([COPILOT, 'synthetic-other']);
    assert.deepEqual(llm.listProviders().map((provider) => provider.id), [COPILOT, 'synthetic-other']);
    await llm.listModels(COPILOT);
    assert.equal(refreshes, 1, 'adding Copilot through the original replace handle enables refresh');
    await llm.listModels('synthetic-other');
    assert.equal(refreshes, 1);
    handle.replace([COPILOT]);
    assert.deepEqual(llm.listProviders().map((provider) => provider.id), [COPILOT]);
  } finally { await fiber.dispose(); }
  assert.deepEqual(llm.listProviders(), [], 'registration effect belongs to original plugin fiber');
  assert.throws(() => handle.replace([COPILOT]), (error) => error instanceof Error && 'code' in error && error.code === 'REGISTRATION_DISPOSED');
});

test('real original.apply/PiAiAdapter observes refreshed facade identity in active runtime and binds old prepared wire facts', async () => {
  const host = new Context();
  host.provide('credentials', {
    resolve: async () => ({ value: 'synthetic-api-key' }),
    readRecord: async () => undefined,
  });
  const llm = new LlmRuntime(host);
  const profile = (generation: number) => ({
    'github-copilot': {
      apiKeyEnv: 'SYNTHETIC_COPILOT_KEY', api: 'openai-completions',
      baseURL: `https://generation-${generation}.example.invalid`,
      models: [{ id: generation === 1 ? 'synthetic-before-refresh' : 'synthetic-model', name: `Generation ${generation}`, contextWindow: generation * 10000,
        maxTokens: 1024, reasoning: false, input: ['text' as const] }],
    },
  });
  let raw = profile(1);
  const base = original.Config({ providers: raw });
  const config: original.Config = { ...base, providers: Object.freeze({ ...base.providers, get: () => raw }) };
  let refreshes = 0;
  let targetGeneration = 1;
  const ensure = async () => {
    refreshes++;
    await Promise.resolve();
    // This is the parent's in-memory configured facade update, not a disk write.
    if (raw[COPILOT].baseURL !== `https://generation-${targetGeneration}.example.invalid`) raw = profile(targetGeneration);
  };
  const requests: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-api-key');
    return transportResponse('openai-completions', 'synthetic-model');
  };
  const fiber = host.plugin({ name: 'real-catalog-adapter-test', inject: ['llm', 'credentials'], apply(ctx: Context) {
    original.apply(adapterContext(ctx, ensure), config);
  } });
  try {
    await fiber;
    assert.equal(llm.listProviders().filter((provider) => provider.id === COPILOT).length, 1);
    const initialModels = await llm.listModels(COPILOT);
    assert.equal(initialModels[0]!.name, 'Generation 1');
    assert.deepEqual(initialModels.map((model) => model.id), ['synthetic-before-refresh']);
    const initialIdentity = config.providers.get();
    targetGeneration = 2;
    const prepared = await llm.prepareCall({ provider: COPILOT, model: 'synthetic-model' });
    assert.notEqual(config.providers.get(), initialIdentity, 'new facade identity invalidates real adapter memoized profiles');
    assert.equal(prepared.context?.contextWindow, 20000, 'active registry uses refreshed model capacity before stream');
    const preparedRefreshes = refreshes;
    targetGeneration = 3;
    raw = profile(3);
    const preparedChunks = await drain(prepared.stream({ ...request(), ...prepared.config }));
    assert.equal(refreshes, preparedRefreshes, 'prepared dispatch never refreshes or resolves new profiles');
    const preparedFinish = preparedChunks.at(-1);
    assert.ok(preparedFinish?.type === 'finish' && preparedFinish.reason.kind === 'stop');
    assert.deepEqual(requests, ['https://generation-2.example.invalid/chat/completions']);
    assert.equal((await llm.listModels(COPILOT))[0]!.name, 'Generation 3', 'the active adapter sees the next catalog without re-registration');
    assert.equal((await llm.resolveModelInfo(COPILOT, 'synthetic-model')).context?.contextWindow, 30000);
    const nextChunks = await drain(llm.stream(request()));
    const finish = nextChunks.at(-1);
    assert.ok(finish?.type === 'finish' && finish.reason.kind === 'stop');
    assert.deepEqual(requests, [
      'https://generation-2.example.invalid/chat/completions',
      'https://generation-3.example.invalid/chat/completions',
    ]);
    assert.equal(llm.listProviders().filter((provider) => provider.id === COPILOT).length, 1);
  } finally {
    await fiber.dispose();
    globalThis.fetch = savedFetch;
  }
  assert.deepEqual(llm.listProviders(), [], 'actual original.apply registrations dispose with the original fiber');
});
