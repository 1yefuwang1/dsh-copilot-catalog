import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlugin } from '../dist/plugin.js';
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

test('wrapper preserves original schema, name, dependencies, return and config identity', async () => {
  const f = fixture();
  assert.equal(f.plugin.name, f.original.name);
  assert.equal(f.plugin.Config, f.original.Config);
  assert.deepEqual(f.plugin.inject, ['llm', 'credentials']);
  assert.equal(await f.plugin.apply(f.ctx, f.config), 'adapter-result');
  const invocation = f.calls.find((call) => call[0] === 'apply');
  assert.equal(invocation[1], f.ctx);
  assert.equal(invocation[2], f.config);
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
