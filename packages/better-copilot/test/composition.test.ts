import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import z from '@deepseek-ai/schemastery';
import { createConfig, type BetterCopilotConfig } from '../dist/config.js';
import { createPlugin, type BetterCopilotDependencies } from '../dist/plugin.js';
import { COPILOT_SEARCH_PROVIDER_ID } from '../dist/provider.js';

const enterprise = 'https://api.enterprise.githubcopilot.com';
const individual = 'https://api.individual.githubcopilot.com';

/** A minimal adapter schema shaped like the real one: the merged config reads `dict.providers`. */
const FakeAdapterConfig = z.object({ providers: z.dict(z.any()).default({}).volatile() });
const Config = createConfig(FakeAdapterConfig);

const grant = (expires = Date.now() + 3_600_000) => ({
  kind: 'grant',
  payload: { type: 'oauth', access: 'test-access-token', refresh: 'test-refresh-token', expires },
});

const model = (id: string) => ({
  id, name: id, api: 'openai-responses', provider: 'github-copilot', baseUrl: individual,
  contextWindow: 128_000, maxTokens: 8_192, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, headers: {},
});

interface Call { config: Record<string, unknown>; ctx: unknown }

function fixture() {
  const calls: Call[] = [];
  const catalog: Record<string, unknown> = { 'gpt-6-sol': model('gpt-6-sol') };
  const original = {
    name: 'llm-pi-ai',
    Config: FakeAdapterConfig,
    inject: ['llm'],
    recordKeyFor: (id: string) => `llm-pi-ai/${id}`,
    apply(ctx: unknown, config: Record<string, unknown>) { calls.push({ ctx, config }); return Promise.resolve(); },
  };
  const dependencies: BetterCopilotDependencies = {
    original: original as unknown as BetterCopilotDependencies['original'],
    catalog: catalog as BetterCopilotDependencies['catalog'],
    oauth: {
      refresh: async (credential: unknown) => credential,
      toAuth: async () => ({ apiKey: 'test-access-token', baseUrl: individual }),
    } as unknown as BetterCopilotDependencies['oauth'],
    recordKeyFor: ((id: string) => `llm-pi-ai/${id}`) as unknown as BetterCopilotDependencies['recordKeyFor'],
    createModels: (() => ({ setProvider() {}, getAuth: async () => undefined })) as unknown as BetterCopilotDependencies['createModels'],
    provider: { id: 'github-copilot', auth: { oauth: {} }, getModels: () => [] } as unknown as BetterCopilotDependencies['provider'],
    headers: Object.freeze({ 'User-Agent': 'GitHubCopilotChat/0.35.0' }),
    installIdentity: () => () => {},
  };
  return { calls, catalog, dependencies, original };
}

function fakeContext(options: {
  credentials?: unknown;
  web?: 'missing' | 'throwing' | { registerSearchProvider(provider?: unknown): unknown };
  effectThrows?: number;
} = {}) {
  const listeners: unknown[] = [];
  const effects: (() => void)[] = [];
  let effectCalls = 0;
  const logs: unknown[][] = [];
  const ctx = {
    effect(execute: () => () => void) {
      // Capability containment: an installer that throws must only lose its capability.
      if (options.effectThrows === ++effectCalls) throw new Error('effect unavailable');
      const release = execute();
      effects.push(release);
      return release;
    },
    on(_event: string, listener: unknown) {
      listeners.push(listener);
      return () => {};
    },
    get(name: string) { return name === 'credentials' ? options.credentials : undefined; },
    inject(_deps: string[], callback: (child: { web: unknown }) => void) {
      if (options.web === 'missing') return () => {};
      if (options.web === 'throwing') {
        callback({ web: { registerSearchProvider() { throw new Error('web refused'); } } });
        return () => {};
      }
      callback({ web: options.web ?? { registerSearchProvider() { return () => {}; } } });
      return () => {};
    },
    logger: {
      info: (...args: unknown[]) => logs.push(['info', ...args]),
      warn: (...args: unknown[]) => logs.push(['warn', ...args]),
    },
  };
  return { ctx, listeners, effects, logs };
}

/** The fake context is not a Cordis Context; the plugin only uses this structural seam. */
const asContext = (ctx: unknown) => ctx as Parameters<ReturnType<typeof createPlugin>['apply']>[0];

test('one apply registers search, installs the guard transform and delegates exactly one providers config', async t => {
  const { calls, dependencies } = fixture();
  const host = new Context();
  // The merged plugin injects these two services; provide them so the fiber activates.
  host.provide('llm', {});
  host.provide('credentials', { readRecord: async () => undefined, resolve: async () => undefined });
  const web = new WebRuntime(host, WebRuntime.Config({ searchProvider: COPILOT_SEARCH_PROVIDER_ID, fetchProvider: 'http' }));
  // The tool-schema guard is a wire transform; capture what the adapter would send.
  const sent: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { sent.push(String(init?.body ?? '')); return new Response('ok'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Before the plugin mounts, the configured provider is unknown to the web seam.
  await assert.rejects(web.search({ query: 'before mount' }), (error) => error instanceof Error && 'code' in error && error.code === 'WEB_PROVIDER_CONFIGURED_MISSING');

  const fiber = host.plugin(createPlugin(dependencies), { providers: { 'github-copilot': {} }, search: {}, toolSchema: {} });
  await fiber;
  t.after(async () => { await fiber.dispose(); });

  // One delegation, with exactly one config key: the facade cannot leak search/guard settings.
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!.config), ['providers']);
  // Search is registered; without a credential the merged provider reports the missing credential.
  await assert.rejects(web.search({ query: 'synthetic' }), (error) => error instanceof Error && 'code' in error && error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING');
  // The guard normalizes a defective Gemini declaration on the serialized request.
  const defective = JSON.stringify({ model: 'gemini-4-argon', tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }] });
  await globalThis.fetch('https://api.individual.githubcopilot.com/chat/completions', { method: 'POST', body: defective });
  assert.deepEqual((JSON.parse(sent[0]!).tools[0].function.parameters as { properties?: object }).properties, {});

  // Disposal unwinds the search registration and the guard transform.
  await fiber.dispose();
  await assert.rejects(web.search({ query: 'after disposal' }), (error) => error instanceof Error && 'code' in error && error.code === 'WEB_PROVIDER_CONFIGURED_MISSING');
  await globalThis.fetch('https://api.individual.githubcopilot.com/chat/completions', { method: 'POST', body: defective });
  assert.equal(sent[1], defective, 'the released transform leaves the body byte-identical');
});

test('a discovered Enterprise endpoint becomes a runtime default without changing the caller config', async () => {
  const { calls, dependencies } = fixture();
  const { ctx } = fakeContext({
    credentials: { readRecord: async () => grant(), resolve: async () => undefined },
    web: { registerSearchProvider: () => () => {} },
  });
  // The bundle patch always supplies a github-copilot profile entry; without it the
  // adapter has no route to inject an endpoint into.
  const config = Config({ providers: { 'github-copilot': {} } }) as BetterCopilotConfig;
  const seen: string[] = [];
  const discover = {
    ...dependencies,
    fetcher: async (url: string | URL) => {
      seen.push(String(url));
      return Response.json({ data: [{ id: 'gpt-6-sol', model_picker_enabled: true, policy: { state: 'enabled' } }] });
    },
  } as BetterCopilotDependencies;
  // Route discovery through an Enterprise account grant.
  (discover.oauth as unknown as { toAuth(): Promise<unknown> }).toAuth = async () => ({ apiKey: 'test-access-token', baseUrl: enterprise });
  const result = await createPlugin(discover).apply(asContext(ctx), config);
  assert.equal(result, undefined);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.endsWith('/models'));
  const handed = calls[0]!.config.providers as { get(): Record<string, { baseURL?: string }> };
  assert.equal(handed.get()['github-copilot']?.baseURL, enterprise);
  // The caller's own provider map is untouched.
  assert.equal(config.providers.get()['github-copilot']?.baseURL, undefined);
});

test('without a discovered endpoint the adapter receives the caller provider map unchanged', async () => {
  const { calls, dependencies } = fixture();
  const { ctx } = fakeContext({ web: { registerSearchProvider: () => () => {} } });
  const config = Config({ providers: { 'github-copilot': { apiKeyEnv: 'COPILOT_GH_TOKEN' } } }) as BetterCopilotConfig;
  await createPlugin(dependencies).apply(asContext(ctx), config);
  const handed = calls[0]!.config.providers as { get(): Record<string, { baseURL?: string; apiKeyEnv?: string }> };
  assert.equal(handed.get()['github-copilot']?.baseURL, undefined);
  assert.equal(handed.get()['github-copilot']?.apiKeyEnv, 'COPILOT_GH_TOKEN');
});

test('a missing web service is a silent skip and a throwing guard registration is contained', async () => {
  // No web service: search simply does not mount, the adapter still delegates.
  const missing = fixture();
  const missingContext = fakeContext({ web: 'missing' });
  assert.equal(await createPlugin(missing.dependencies).apply(asContext(missingContext.ctx), Config({ providers: {} }) as BetterCopilotConfig), undefined);
  assert.equal(missing.calls.length, 1);
  assert.deepEqual(missingContext.logs.filter(([level]) => level === 'warn'), []);

  // A throwing guard effect is contained and logged without credential material.
  const throwing = fixture();
  const throwingContext = fakeContext({ effectThrows: 2, web: { registerSearchProvider: () => () => {} } });
  assert.equal(await createPlugin(throwing.dependencies).apply(asContext(throwingContext.ctx), Config({ providers: {} }) as BetterCopilotConfig), undefined);
  assert.equal(throwing.calls.length, 1);
  const warning = throwingContext.logs.find(([level, message]) => level === 'warn' && String(message).includes('registration failed'));
  assert.ok(warning, 'a contained capability failure is logged as a code-only warning');
  assert.deepEqual(warning.slice(2), ['tool-schema guard', 'Gemini tool-schema normalization']);
  assert.ok(!JSON.stringify(warning).includes('test-access-token'));
});

test('a throwing identity installer still registers the guard and one search provider', async () => {
  const { calls, dependencies } = fixture();
  const registrations: unknown[] = [];
  const { ctx, logs, effects } = fakeContext({
    web: { registerSearchProvider(provider: unknown) { registrations.push(provider); return () => {}; } },
  });
  const installIdentity = () => { throw new Error('identity unavailable'); };
  const plugin = createPlugin({ ...dependencies, installIdentity });
  const result = await plugin.apply(asContext(ctx), Config({ providers: {} }) as BetterCopilotConfig);
  assert.equal(result, undefined);
  assert.equal(calls.length, 1, 'the adapter still mounts');
  assert.equal(effects.length, 3, 'the guard and two catalog lifetime effects install even when identity throws');
  assert.equal(registrations.length, 1, 'search registers even when identity installation throws');
  assert.ok(logs.some(([level, ...rest]) => level === 'warn' && rest.some((value) => String(value) === 'wire identity')));
});

test('a throwing search registration cannot block the adapter', async () => {
  const { calls, dependencies } = fixture();
  const { ctx, logs, effects } = fakeContext({ web: 'throwing' });
  const result = await createPlugin(dependencies).apply(asContext(ctx), Config({ providers: {} }) as BetterCopilotConfig);
  assert.equal(result, undefined);
  assert.equal(calls.length, 1, 'the adapter mounts despite the web seam failing');
  assert.equal(effects.length, 4, 'identity, guard and both catalog lifetime effects are unaffected');
  assert.ok(logs.some(([level, ...rest]) => level === 'warn' && rest.some((value) => String(value) === 'search provider')));
});

test('discovery failure logs only a controlled reason code and still delegates', async () => {
  const { calls, dependencies } = fixture();
  const { ctx, logs } = fakeContext({
    credentials: { readRecord: async () => grant(), resolve: async () => undefined },
    web: { registerSearchProvider: () => () => {} },
  });
  const failing = {
    ...dependencies,
    fetcher: async () => { throw new Error('network said test-access-token'); },
  } as BetterCopilotDependencies;
  (failing.oauth as unknown as { toAuth(): Promise<unknown> }).toAuth = async () => ({ apiKey: 'test-access-token', baseUrl: enterprise });
  const result = await createPlugin(failing).apply(asContext(ctx), Config({ providers: {} }) as BetterCopilotConfig);
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  const discoveryWarning = logs.find(([level, message]) => level === 'warn' && String(message).includes('catalog refresh'));
  assert.ok(discoveryWarning);
  assert.deepEqual(discoveryWarning.slice(2), ['DISCOVERY_FAILED']);
  assert.ok(!JSON.stringify(logs).includes('test-access-token'));
});

test('a failing adapter apply still fails the mount, exactly as before the merge', async () => {
  const { dependencies } = fixture();
  const failing = {
    ...dependencies,
    original: { ...(dependencies.original as object), apply: () => { throw new Error('adapter refused'); } },
  } as unknown as BetterCopilotDependencies;
  const { ctx } = fakeContext({ web: { registerSearchProvider: () => () => {} } });
  await assert.rejects(createPlugin(failing).apply(asContext(ctx), Config({ providers: {} }) as BetterCopilotConfig), /adapter refused/u);
});

test('the identity effect is released once when the install seam succeeds', async () => {
  const { dependencies } = fixture();
  const { ctx, effects } = fakeContext({ web: { registerSearchProvider: () => () => {} } });
  const released: string[] = [];
  await createPlugin({ ...dependencies, installIdentity: () => () => { released.push('released'); } })
    .apply(asContext(ctx), Config({ providers: {} }) as BetterCopilotConfig);
  assert.equal(effects.length, 4, 'identity, guard and both catalog lifetime effects are installed');
  effects[0]!();
  assert.deepEqual(released, ['released']);
});
