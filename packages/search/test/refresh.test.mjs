import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebError } from '@deepseek-ai/dsh-web';
import { createSafeCopilotRefresh } from '../dist/refresh.js';
import { createCopilotAuthResolver } from '../dist/auth.js';
import { loadRuntime } from '../dist/runtime.js';
import { contextFixture, credentialFixture, deferred, enterprise, grant, individual, runtimeFixture, token } from './auth-helpers.mjs';

const expiry = () => Math.floor(Date.now() / 1000) + 1800;
const freshToken = (value = token()) => Response.json({ token: value, expires_at: expiry() });
const enabled = (id, fields = {}) => ({ id, model_picker_enabled: true, policy: { state: 'enabled' }, ...fields });
const catalog = (data = [enabled('synthetic-model')]) => Response.json({ data });
const signal = () => new AbortController().signal;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const safeFailure = (error) => error instanceof WebError && !error.message.includes('synthetic-private');

async function setup(initial = grant({ expires: 0 }), responder) {
  const requests = [];
  const runtime = await loadRuntime({ fetcher: async (url, init) => {
    const request = { url, init };
    requests.push(request);
    return responder(request, requests.length);
  } });
  const store = credentialFixture(initial);
  return { ...store, runtime, requests, resolve: createCopilotAuthResolver(contextFixture(store.service), runtime) };
}

test('real public Models auth refresh uses validated local transport and the shared record lock', async () => {
  const fixture = await setup(grant({ expires: 0 }), ({ url, init }) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url === 'https://api.github.com/copilot_internal/v2/token') {
      assert.equal(init.headers.get('authorization'), `Bearer ${'test-refresh-token'}`);
      return freshToken();
    }
    assert.equal(url, `${enterprise}/models`);
    assert.equal(init.headers.get('authorization'), `Bearer ${token()}`);
    assert.equal(init.headers.get('x-github-api-version'), '2026-06-01');
    return catalog();
  });
  const auth = await fixture.resolve({}, signal());
  assert.equal(auth.baseUrl, enterprise);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.stats.writes, 1);
  assert.deepEqual(fixture.current().payload.availableModelIds, ['synthetic-model']);
  assert.equal(fixture.current().payload.refresh, 'test-refresh-token');
});

test('response-derived untrusted catalog origin is rejected before dispatch or commit', async () => {
  const original = grant({ expires: 0 });
  const malicious = ['test-access-token', 'proxy-ep=receiver.example.invalid'].join(';');
  const fixture = await setup(original, () => freshToken(malicious));
  await assert.rejects(fixture.resolve({}, signal()), safeFailure);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].url, 'https://api.github.com/copilot_internal/v2/token');
  assert.equal(fixture.stats.writes, 0);
  assert.equal(fixture.current(), original);
});

test('exchange and catalog redirects fail without following Location or persisting credentials', async () => {
  for (const redirectedStage of [1, 2]) {
    const fixture = await setup(grant({ expires: 0 }), (_request, count) => {
      if (count === redirectedStage) return new Response(null, { status: 302, headers: { location: 'https://receiver.example.invalid' } });
      return freshToken();
    });
    await assert.rejects(fixture.resolve({}, signal()), safeFailure);
    assert.equal(fixture.requests.length, redirectedStage);
    assert.ok(fixture.requests.every(({ init }) => init.redirect === 'error'));
    assert.ok(fixture.requests.every(({ url }) => !url.includes('receiver.example.invalid')));
    assert.equal(fixture.stats.writes, 0);
  }
});

test('token and expiry validation precedes catalog dispatch and persistence', async () => {
  for (const body of [
    { token: '', expires_at: expiry() }, { token: ['synthetic', 'unsafe'].join('\n'), expires_at: expiry() },
    { token: token(), expires_at: 'invalid' }, { token: token(), expires_at: 0 },
    { token: token(), expires_at: Number.MAX_SAFE_INTEGER },
  ]) {
    const fixture = await setup(grant({ expires: 0 }), () => Response.json(body));
    await assert.rejects(fixture.resolve({}, signal()), safeFailure);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.stats.writes, 0);
  }
});

test('only existing owner-grant metadata chooses the Enterprise exchange domain', async () => {
  const original = grant({ expires: 0, enterpriseUrl: 'company.ghe.com' });
  const fixture = await setup(original, ({ url }, count) => {
    if (count === 1) {
      assert.equal(url, 'https://api.company.ghe.com/copilot_internal/v2/token');
      return Response.json({ token: token(), expires_at: expiry(), enterpriseUrl: 'receiver.example.invalid', refresh: 'fresh-token' });
    }
    assert.equal(url, `${enterprise}/models`);
    return catalog();
  });
  await fixture.resolve({}, signal());
  assert.equal(fixture.current().payload.enterpriseUrl, 'company.ghe.com');
  assert.equal(fixture.current().payload.refresh, 'test-refresh-token');
  for (const enterpriseUrl of ['http://company.ghe.com', 'company.ghe.com/path', '@company.ghe.com', 'company.ghe.com:444', 'company.ghe.com?value=x', 'company.ghe.com\n']) {
    const rejected = await setup(grant({ expires: 0, enterpriseUrl }), () => { throw new Error('Invalid authority must not dispatch'); });
    await assert.rejects(rejected.resolve({}, signal()), safeFailure);
    assert.equal(rejected.requests.length, 0);
    assert.equal(rejected.stats.writes, 0);
  }
});

test('refresh preserves the SDK picker and Individual-only policy fallback semantics', async () => {
  const entries = [
    enabled('picker-enabled'), enabled('picker-absent-policy', { policy: undefined }),
    enabled('picker-disabled', { policy: { state: 'disabled' } }),
    enabled('picker-unconfigured', { policy: { state: 'unconfigured' } }),
    enabled('no-tools', { capabilities: { supports: { tool_calls: false } } }),
    enabled('policy-only', { model_picker_enabled: false }),
  ];
  const fixture = await setup(grant({ expires: 0 }), (_request, count) => count === 1 ? freshToken() : catalog(entries));
  await fixture.resolve({}, signal());
  assert.deepEqual(fixture.current().payload.availableModelIds, ['picker-enabled', 'picker-absent-policy', 'picker-unconfigured']);
  for (const account of ['individual', 'enterprise']) {
    const fallback = await setup(grant({ expires: 0 }), (_request, count) => count === 1 ? freshToken(token(account))
      : catalog([enabled('policy-only', { model_picker_enabled: false })]));
    const auth = await fallback.resolve({}, signal());
    assert.equal(auth.baseUrl, account === 'individual' ? individual : enterprise);
    assert.deepEqual(fallback.current().payload.availableModelIds, account === 'individual' ? ['policy-only'] : []);
  }
});

test('oversized, malformed, failed or non-JSON auth responses cannot commit a grant', async () => {
  for (const stage of [1, 2]) {
    for (const bad of [
      () => new Response('synthetic-private malformed', { headers: { 'content-type': 'application/json' } }),
      () => new Response('synthetic-private body', { status: 500 }),
      () => Response.json({ payload: 'x'.repeat(1048577) }),
      () => new Response('not JSON', { headers: { 'content-type': 'text/html' } }),
      () => Response.json({}, { headers: { 'content-length': '1048577' } }),
    ]) {
      const fixture = await setup(grant({ expires: 0 }), (_request, count) => count === stage ? bad() : freshToken());
      await assert.rejects(fixture.resolve({}, signal()), safeFailure);
      assert.equal(fixture.stats.writes, 0);
    }
  }
});

test('cancellation during late exchange work never dispatches a later catalog request or commit', async () => {
  const entered = deferred(), gate = deferred();
  const fixture = await setup(grant({ expires: 0 }), async () => { entered.resolve(); return gate.promise; });
  const controller = new AbortController();
  const pending = fixture.resolve({}, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'WEB_ABORTED');
  gate.resolve(freshToken());
  await fixture.drained();
  await turn();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.stats.writes, 0);
});

test('cancellation during an uncooperative catalog body read cannot commit a refreshed grant', async () => {
  const entered = deferred(), gate = deferred();
  const fixture = await setup(grant({ expires: 0 }), (_request, count) => {
    if (count === 1) return freshToken();
    return { ok: true, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader() {
      return { async read() { entered.resolve(); return gate.promise; }, async cancel() {}, releaseLock() {} };
    } } };
  });
  const controller = new AbortController();
  const pending = fixture.resolve({}, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'WEB_ABORTED');
  gate.reject(new Error('synthetic-private late body failure'));
  await fixture.drained();
  await turn();
  assert.equal(fixture.stats.writes, 0);
});

test('refresh failures expose no raw provider details and do not mutate original providers', async () => {
  const runtime = runtimeFixture();
  const originalRefresh = runtime.provider.auth.oauth.refresh;
  const refresh = createSafeCopilotRefresh({ oauth: runtime.oauth, headers: runtime.headers,
    fetcher: async () => { throw new Error('synthetic-private transport failure'); } });
  await assert.rejects(refresh(grant().payload, signal()), safeFailure);
  assert.equal(runtime.provider.auth.oauth.refresh, originalRefresh);
});
