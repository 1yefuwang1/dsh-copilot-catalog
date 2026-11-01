import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
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
  web?: 'missing' | 'throwing' | { registerSearchProvider(): unknown };
  onThrows?: boolean;
} = {}) {
  const listeners: unknown[] = [];
  const effects: (() => void)[] = [];
  const logs: unknown[][] = [];
  const ctx = {
    effect(execute: () => () => void) {
      const release = execute();
      effects.push(release);
      return release;
    },
    on(_event: string, listener: unknown) {
      if (options.onThrows) throw new Error('on is unavailable');
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

test('one apply registers search, installs the guard listener and delegates exactly one providers config', async t => {
  const { calls, dependencies } = fixture();
  const host = new Context();
  // The merged plugin injects these two services; provide them so the fiber activates.
  host.provide('llm', {});
  host.provide('credentials', { readRecord: async () => undefined, resolve: async () => undefined });
  const web = new WebRuntime(host, WebRuntime.Config({ searchProvider: COPILOT_SEARCH_PROVIDER_ID, fetchProvider: 'http' }));
  const systemPrompt = host.plugin(SystemPrompt);
  await systemPrompt;
  const tools = [{ name: 't', description: 'd', parameters: { type: 'object' } }];
  host.systemPrompt.tools(() => ({ schemas: structuredClone(tools) }));
  host.systemPrompt.variable('provider', () => 'github-copilot');
  host.systemPrompt.variable('model', () => 'gemini-4-argon');

  // Before the plugin mounts, the configured provider is unknown to the web seam.
  await assert.rejects(web.search({ query: 'before mount' }), (error) => error instanceof Error && 'code' in error && error.code === 'WEB_PROVIDER_CONFIGURED_MISSING');

  const fiber = host.plugin(createPlugin(dependencies), { providers: { 'github-copilot': {} }, search: {}, toolSchema: {} });
  await fiber;
  t.after(async () => { await fiber.dispose(); await systemPrompt.dispose(); });

  // One delegation, with exactly one config key: the facade cannot leak search/guard settings.
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!.config), ['providers']);
  // Search is registered; without a credential the merged provider reports the missing credential.
  await assert.rejects(web.search({ query: 'synthetic' }), (error) => error instanceof Error && 'code' in error && error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING');
  // The guard normalizes a defective Gemini declaration through the real assembly waterfall.
  const assembly = await host.systemPrompt.assemble({});
  assert.deepEqual((assembly.tools[0]!.parameters as { properties?: object }).properties, {});

  // Disposal unwinds the search registration and the guard listener.
  await fiber.dispose();
  await assert.rejects(web.search({ query: 'after disposal' }), (error) => error instanceof Error && 'code' in error && error.code === 'WEB_PROVIDER_CONFIGURED_MISSING');
  const afterDisposal = await host.systemPrompt.assemble({});
  assert.equal((afterDisposal.tools[0]!.parameters as { properties?: object }).properties, undefined);
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

  // A throwing ctx.on is contained and logged without credential material.
  const throwing = fixture();
  const throwingContext = fakeContext({ onThrows: true, web: { registerSearchProvider: () => () => {} } });
  assert.equal(await createPlugin(throwing.dependencies).apply(asContext(throwingContext.ctx), Config({ providers: {} }) as BetterCopilotConfig), undefined);
  assert.equal(throwing.calls.length, 1);
  const warning = throwingContext.logs.find(([level, message]) => level === 'warn' && String(message).includes('registration failed'));
  assert.ok(warning, 'a contained capability failure is logged as a code-only warning');
  assert.deepEqual(warning.slice(2), ['tool-schema guard', 'Gemini tool-schema normalization']);
  assert.ok(!JSON.stringify(warning).includes('test-access-token'));
});

test('a throwing search registration and a throwing identity installer cannot block the adapter', async () => {
  for (const overrides of [
    { web: 'throwing' as const },
    {},
  ]) {
    const { calls, dependencies } = fixture();
    const { ctx, logs, listeners } = fakeContext(overrides);
    const config = Config({ providers: {} }) as BetterCopilotConfig;
    const installIdentity = () => { throw new Error('identity unavailable'); };
    const plugin = createPlugin({ ...dependencies, installIdentity });
    const result = await plugin.apply(asContext(ctx), config);
    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.equal(listeners.length, 1, 'the guard registers even when identity installation throws');
    assert.ok(logs.some(([level, ...rest]) => level === 'warn' && rest.some((value) => String(value) === 'wire identity')));
  }
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
  const discoveryWarning = logs.find(([level, message]) => level === 'warn' && String(message).includes('discovery failed'));
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
  assert.equal(effects.length, 1);
  effects[0]!();
  assert.deepEqual(released, ['released']);
});
