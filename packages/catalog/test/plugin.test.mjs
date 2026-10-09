import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlugin, withCopilotEndpoint } from '../dist/plugin.js';
import { accountItem, catalogFixture, discoveryFixture } from './helpers.mjs';

function fixture(overrides = {}) {
  const f = discoveryFixture();
  const calls = [];
  const config = { providers: { get: () => ({ 'github-copilot': {} }) } };
  const original = {
    name: 'llm-pi-ai', Config: () => {}, inject: ['llm'],
    recordKeyFor: () => 'key',
    apply(ctx, supplied) { calls.push(['apply', ctx, supplied, Object.keys(f.catalog)]); return 'adapter-result'; },
  };
  const ctx = {
    get: () => f.credentials,
    logger: {
      info: (...args) => calls.push(['info', ...args]),
      warn: (...args) => calls.push(['warn', ...args]),
    },
  };
  const plugin = createPlugin({ original, ...f.options, ...overrides });
  return { ...f, plugin, original, ctx, config, calls };
}

test('wrapper preserves original schema and settings while adding an Enterprise runtime default', async () => {
  const f = fixture();
  assert.equal(f.plugin.name, f.original.name);
  assert.equal(f.plugin.Config, f.original.Config);
  assert.deepEqual(f.plugin.inject, ['llm', 'credentials']);
  assert.equal(await f.plugin.apply(f.ctx, f.config), 'adapter-result');
  const invocation = f.calls.find((call) => call[0] === 'apply');
  assert.equal(invocation[1], f.ctx);
  assert.equal(invocation[2].providers.get()['github-copilot'].baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(f.config.providers.get()['github-copilot'].baseURL, undefined);
  assert.deepEqual(invocation[3], ['gpt-6-sol']);
});

test('discovery failure is fail-open without leaking raw OAuth or credential exceptions', async () => {
  const f = fixture({ fetcher: async () => { throw new Error('Bearer TOP-SECRET token payload'); } });
  assert.equal(await f.plugin.apply(f.ctx, f.config), 'adapter-result');
  assert.deepEqual(Object.keys(f.catalog), Object.keys(catalogFixture()));
  const log = JSON.stringify(f.calls.filter((call) => call[0] !== 'apply'));
  assert.ok(log.includes('DISCOVERY_FAILED'));
  assert.ok(!log.includes('TOP-SECRET'));
});

test('no credentials and no logger still delegate to original adapter', async () => {
  const f = fixture();
  f.ctx = { get: () => undefined };
  await f.plugin.apply(f.ctx, f.config);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'apply');
});

test('a bounded startup timeout delegates to the adapter', async () => {
  const f = fixture({ timeoutMs: 10, fetcher: () => new Promise(() => {}) });
  await f.plugin.apply(f.ctx, f.config);
  assert.ok(JSON.stringify(f.calls[0]).includes('TIMEOUT'));
  assert.equal(f.calls.at(-1)[0], 'apply');
});

test('new model diagnostics escape control characters', async () => {
  const f = fixture({ fetcher: async () => ({ ok: true, json: async () => ({
    data: [accountItem('gpt-6-sol'), accountItem('unknown\nFORGED-LOG')],
  }) }) });
  await f.plugin.apply(f.ctx, f.config);
  const diagnostic = f.calls[0].at(-1);
  assert.equal(diagnostic, '["unknown\\nFORGED-LOG"]');
});

test('validated Enterprise routing survives a failed model listing without changing bundled descriptors', async () => {
  const f = fixture({ fetcher: async () => ({ ok: false, status: 503 }) });
  const before = structuredClone(f.catalog);
  await f.plugin.apply(f.ctx, f.config);
  const invocation = f.calls.find((call) => call[0] === 'apply');
  assert.equal(invocation[2].providers.get()['github-copilot'].baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.deepEqual(f.catalog, before);
});

test('GHE account routing survives a failed listing as a runtime default without rewriting settings', async () => {
  const f = fixture({ oauth: {
    refresh: async () => { throw new Error('Valid synthetic credentials must not refresh'); },
    toAuth: async (credential) => ({ apiKey: credential.access, baseUrl: 'https://copilot-api.msft.ghe.com' }),
  }, fetcher: async (url, init) => {
    assert.equal(url.origin, 'https://copilot-api.msft.ghe.com');
    assert.equal(init.redirect, 'error');
    return { ok: false, status: 503 };
  } });
  const before = structuredClone(f.catalog);
  await f.plugin.apply(f.ctx, f.config);
  const invocation = f.calls.find((call) => call[0] === 'apply');
  assert.equal(invocation[2].providers.get()['github-copilot'].baseURL, 'https://copilot-api.msft.ghe.com');
  assert.equal(f.config.providers.get()['github-copilot'].baseURL, undefined);
  assert.deepEqual(f.catalog, before);
  const log = JSON.stringify(f.calls.filter((call) => call[0] !== 'apply'));
  assert.ok(log.includes('HTTP_ERROR'));
  assert.ok(log.includes('https://copilot-api.msft.ghe.com'));
});

test('runtime default preserves explicit URLs, other providers, volatile updates, and snapshot memoization', () => {
  let raw = { 'github-copilot': {}, openai: { baseURL: 'https://example.invalid' } };
  const config = { providers: { get: () => raw } };
  const routed = withCopilotEndpoint(config, 'https://api.enterprise.githubcopilot.com');
  const first = routed.providers.get();
  assert.equal(routed.providers.get(), first);
  assert.equal(first.openai, raw.openai);
  assert.equal(raw['github-copilot'].baseURL, undefined);
  raw = { ...raw, 'github-copilot': { baseURL: 'https://api.business.githubcopilot.com' } };
  assert.equal(routed.providers.get(), raw);
  assert.equal(routed.providers.get()['github-copilot'].baseURL, 'https://api.business.githubcopilot.com');
  raw = { ...raw, 'github-copilot': {} };
  assert.equal(routed.providers.get()['github-copilot'].baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(withCopilotEndpoint(config, undefined), config);
});

test('an explicit API-key reference wins over an unrelated stored OAuth account', async () => {
  const f = fixture();
  const token = ['synthetic-token', 'proxy-ep=proxy.enterprise.githubcopilot.com'].join(';');
  f.config.providers.get = () => ({ 'github-copilot': { apiKeyEnv: 'SYNTHETIC_COPILOT_TOKEN' } });
  f.credentials.resolve = async (ref) => {
    assert.equal(ref, 'SYNTHETIC_COPILOT_TOKEN');
    return { value: token };
  };
  f.credentials.readRecord = () => { throw new Error('Explicit API key must bypass the unrelated stored grant'); };
  await f.plugin.apply(f.ctx, f.config);
  const invocation = f.calls.find((call) => call[0] === 'apply');
  assert.equal(invocation[2].providers.get()['github-copilot'].baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(f.requests.find((request) => request[0] === 'fetch')[2].headers.get('Authorization'), `Bearer ${token}`);
});

test('adapter mount errors remain fatal rather than being mistaken for discovery failures', async () => {
  const f = fixture();
  f.original.apply = () => { throw new Error('duplicate route'); };
  await assert.rejects(f.plugin.apply(f.ctx, f.config), /duplicate route/);
});

test('incompatible runtime fails clearly and injection is deduplicated', () => {
  assert.throws(() => createPlugin({}), /Incompatible/);
  const f = fixture();
  f.original.inject = ['llm', 'credentials'];
  const plugin = createPlugin({ original: f.original, ...f.options });
  assert.deepEqual(plugin.inject, ['llm', 'credentials']);
});
