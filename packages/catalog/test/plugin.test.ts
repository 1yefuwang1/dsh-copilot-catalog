import type { CredentialKey, OriginalAdapter, PluginConfig, PluginContext, PluginDependencies } from '../dist/types.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlugin, withCopilotEndpoint } from '../dist/plugin.js';
import { accountItem, catalogFixture, discoveryFixture, discoveryOptions, fetchRequest, type FixtureOptions, type FixtureCredentials } from './helpers.js';
interface ProviderProfile { baseURL?: string; apiKeyEnv?: string }
interface FixtureConfig { providers: { get(): Record<'github-copilot', ProviderProfile> } }
interface FixtureContext {
  get(): FixtureCredentials | undefined;
  effect(execute: () => () => void): unknown;
  logger?: { info(...args: unknown[]): unknown; warn(...args: unknown[]): unknown };
}
type AdapterCall = ['apply', FixtureContext, FixtureConfig, string[]];
type LogCall = ['info' | 'warn', ...unknown[]];
type IdentityCall = 'install' | 'release';
type Call = AdapterCall | LogCall;


function fixture(overrides: Partial<FixtureOptions> = {}) {
  const f = discoveryFixture();
  const calls: Call[] = [];
  const identityCalls: IdentityCall[] = [];
  const effects: (() => void)[] = [];
  const config: FixtureConfig = { providers: { get: () => ({ 'github-copilot': {} }) } };
  const original = {
    name: 'llm-pi-ai', Config: () => {}, inject: ['llm'],
    recordKeyFor: () => 'key' as CredentialKey,
    apply(ctx: FixtureContext, supplied: FixtureConfig) { calls.push(['apply', ctx, supplied, Object.keys(f.catalog)]); return 'adapter-result'; },
  };
  const ctx: FixtureContext = {
    get: () => f.credentials,
    effect: (execute) => {
      const release = execute();
      effects.push(release);
    },
    logger: {
      info: (...args: unknown[]) => calls.push(['info', ...args]),
      warn: (...args: unknown[]) => calls.push(['warn', ...args]),
    },
  };
  const installIdentity = () => {
    identityCalls.push('install');
    return () => { identityCalls.push('release'); };
  };
  // The dynamic Cordis adapter double implements only the settings/lifecycle seam used here.
  const plugin = createPlugin({
    original: original as unknown as OriginalAdapter,
    ...discoveryOptions({ ...f.options, ...overrides }),
    installIdentity,
  });
  const dispose = () => { for (const release of effects.splice(0)) release(); };
  return { ...f, plugin, original, ctx, config, calls, identityCalls, dispose };
}

test('wrapper preserves original schema and settings while adding an Enterprise runtime default', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  assert.equal(f.plugin.name, f.original.name);
  assert.equal(f.plugin.Config, f.original.Config);
  assert.deepEqual(f.plugin.inject, ['llm', 'credentials']);
  assert.equal(await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig), 'adapter-result');
  const invocation = f.calls.find((call): call is AdapterCall => call[0] === 'apply');
  assert.ok(invocation);
  assert.equal(invocation[1], f.ctx);
  assert.equal(invocation[2].providers.get()['github-copilot']!.baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(f.config.providers.get()['github-copilot']!.baseURL, undefined);
  assert.deepEqual(invocation[3], ['gpt-6-sol']);
});

test('wire identity is installed by default and released with the plugin effect', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig);
  assert.deepEqual(f.identityCalls, ['install']);
  f.dispose();
  assert.deepEqual(f.identityCalls, ['install', 'release']);
});

test('wire identity opt-out performs no installation and no identity work', async (t) => {
  const previous = process.env.DSH_COPILOT_WIRE_IDENTITY;
  process.env.DSH_COPILOT_WIRE_IDENTITY = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_COPILOT_WIRE_IDENTITY;
    else process.env.DSH_COPILOT_WIRE_IDENTITY = previous;
  });
  const f = fixture();
  t.after(f.dispose);
  await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig);
  assert.deepEqual(f.identityCalls, []);
});

test('discovery failure is fail-open without leaking raw OAuth or credential exceptions', async (t) => {
  const f = fixture({ fetcher: async () => { throw new Error('Bearer TOP-SECRET token payload'); } });
  t.after(f.dispose);
  assert.equal(await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig), 'adapter-result');
  assert.deepEqual(Object.keys(f.catalog), Object.keys(catalogFixture()));
  const log = JSON.stringify(f.calls.filter((call) => call[0] !== 'apply'));
  assert.ok(log.includes('DISCOVERY_FAILED'));
  assert.ok(!log.includes('TOP-SECRET'));
});

test('no credentials and no logger still delegate to original adapter', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  f.ctx = { get: () => undefined, effect: f.ctx.effect };
  await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]![0], 'apply');
});

test('a bounded startup timeout delegates to the adapter', async (t) => {
  const f = fixture({ timeoutMs: 10, fetcher: () => new Promise(() => {}) });
  t.after(f.dispose);
  await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig);
  assert.ok(JSON.stringify(f.calls[0]!).includes('TIMEOUT'));
  assert.equal(f.calls.at(-1)![0], 'apply');
});

test('new model diagnostics escape control characters', async (t) => {
  const f = fixture({ fetcher: async () => ({ ok: true, json: async () => ({
    data: [accountItem('gpt-6-sol'), accountItem('unknown\nFORGED-LOG')],
  }) }) });
  t.after(f.dispose);
  await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig);
  const diagnostic = f.calls[0]!.at(-1);
  assert.equal(diagnostic, '["unknown\\nFORGED-LOG"]');
});

test('validated Enterprise routing survives a failed model listing without changing bundled descriptors', async (t) => {
  const f = fixture({ fetcher: async () => ({ ok: false, status: 503 }) });
  t.after(f.dispose);
  const before = structuredClone(f.catalog);
  await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig);
  const invocation = f.calls.find((call): call is AdapterCall => call[0] === 'apply');
  assert.ok(invocation);
  assert.equal(invocation[2].providers.get()['github-copilot']!.baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.deepEqual(f.catalog, before);
});

test('GHE account routing survives a failed listing as a runtime default without rewriting settings', async (t) => {
  const f = fixture({ oauth: {
    refresh: async () => { throw new Error('Valid synthetic credentials must not refresh'); },
    toAuth: async (credential) => ({ apiKey: credential.access, baseUrl: 'https://copilot-api.msft.ghe.com' }),
  }, fetcher: async (url, init) => {
    assert.equal(url.origin, 'https://copilot-api.msft.ghe.com');
    assert.equal(init.redirect, 'error');
    return { ok: false, status: 503 };
  } });
  t.after(f.dispose);
  const before = structuredClone(f.catalog);
  await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig);
  const invocation = f.calls.find((call): call is AdapterCall => call[0] === 'apply');
  assert.ok(invocation);
  assert.equal(invocation[2].providers.get()['github-copilot']!.baseURL, 'https://copilot-api.msft.ghe.com');
  assert.equal(f.config.providers.get()['github-copilot']!.baseURL, undefined);
  assert.deepEqual(f.catalog, before);
  const log = JSON.stringify(f.calls.filter((call) => call[0] !== 'apply'));
  assert.ok(log.includes('HTTP_ERROR'));
  assert.ok(log.includes('https://copilot-api.msft.ghe.com'));
});

test('runtime default preserves explicit URLs, other providers, volatile updates, and snapshot memoization', () => {
  let raw: Record<'github-copilot' | 'openai', ProviderProfile> = { 'github-copilot': {}, openai: { baseURL: 'https://example.invalid' } };
  const config = { providers: { get: () => raw } };
  const routed = withCopilotEndpoint(config as PluginConfig, 'https://api.enterprise.githubcopilot.com');
  const first = routed.providers.get();
  assert.equal(routed.providers.get(), first);
  assert.equal(first.openai, raw.openai);
  assert.equal(raw['github-copilot'].baseURL, undefined);
  raw = { ...raw, 'github-copilot': { baseURL: 'https://api.business.githubcopilot.com' } };
  assert.equal(routed.providers.get(), raw);
  assert.equal(routed.providers.get()['github-copilot']!.baseURL, 'https://api.business.githubcopilot.com');
  raw = { ...raw, 'github-copilot': {} };
  assert.equal(routed.providers.get()['github-copilot']!.baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(withCopilotEndpoint(config as PluginConfig, undefined), config);
});

test('an explicit API-key reference wins over an unrelated stored OAuth account', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  const token = ['synthetic-token', 'proxy-ep=proxy.enterprise.githubcopilot.com'].join(';');
  f.config.providers.get = () => ({ 'github-copilot': { apiKeyEnv: 'SYNTHETIC_COPILOT_TOKEN' } });
  f.credentials.resolve = async (ref) => {
    assert.equal(ref, 'SYNTHETIC_COPILOT_TOKEN');
    return { value: token };
  };
  f.credentials.readRecord = () => { throw new Error('Explicit API key must bypass the unrelated stored grant'); };
  await f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig);
  const invocation = f.calls.find((call): call is AdapterCall => call[0] === 'apply');
  assert.ok(invocation);
  assert.equal(invocation[2].providers.get()['github-copilot']!.baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(fetchRequest(f.requests, 0)[2].headers.get('Authorization'), `Bearer ${token}`);
});

test('adapter mount errors remain fatal rather than being mistaken for discovery failures', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  f.original.apply = () => { throw new Error('duplicate route'); };
  await assert.rejects(f.plugin.apply(f.ctx as unknown as PluginContext, f.config as PluginConfig), /duplicate route/);
});

test('incompatible runtime fails clearly and injection is deduplicated', () => {
  assert.throws(() => createPlugin({} as PluginDependencies), /Incompatible/);
  const f = fixture();
  f.original.inject = ['llm', 'credentials'];
  const plugin = createPlugin({ original: f.original as unknown as OriginalAdapter, ...discoveryOptions(f.options) });
  assert.deepEqual(plugin.inject, ['llm', 'credentials']);
});
