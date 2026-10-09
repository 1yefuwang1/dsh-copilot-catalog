import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiscoveryError, discoveryUrl, syncCopilotCatalog, VERSION_HEADER } from '../dist/discovery.js';
import { accountItem, discoveryFixture, grantFixture } from './helpers.mjs';

const sync = (fixture) => syncCopilotCatalog(fixture.credentials, fixture.options);

test('discovery uses shared catalog, authoritative auth headers, HTTPS and no redirects', async () => {
  const f = discoveryFixture();
  const result = await sync(f);
  assert.equal(result.status, 'synced');
  assert.equal(result.count, 1);
  assert.deepEqual(Object.keys(f.catalog), ['gpt-6-sol']);
  assert.deepEqual(f.requests[0], ['read', 'test-record-key']);
  const [, url, init] = f.requests[1];
  assert.equal(url.href, 'https://api.enterprise.githubcopilot.com/models');
  assert.equal(init.headers.get('Authorization'), 'Bearer test-access-token');
  assert.equal(init.headers.get('Editor-Version'), 'vscode/test');
  assert.equal(init.headers.get('X-GitHub-Api-Version'), VERSION_HEADER);
  assert.equal(init.redirect, 'error');
  assert.equal(init.signal.aborted, false);
});

test('generic discovery uses the OAuth origin and survives catalogs with no original models', async () => {
  const f = discoveryFixture();
  for (const id of Object.keys(f.catalog)) delete f.catalog[id];
  let generation = 0;
  f.options.fetcher = async (url, init) => {
    f.requests.push(['fetch', url, init]);
    generation++;
    assert.equal(init.headers.get('Editor-Version'), 'vscode/1.107.0');
    return { ok: true, json: async () => ({ data: [accountItem(`future-model-${generation}`)] }) };
  };
  for (const generation of [1, 2]) {
    const result = await sync(f);
    assert.equal(result.status, 'synced');
    assert.deepEqual(Object.keys(f.catalog), [`future-model-${generation}`]);
    const model = f.catalog[`future-model-${generation}`];
    assert.equal(model.baseUrl, 'https://api.enterprise.githubcopilot.com');
    assert.equal(model.headers.Authorization, undefined);
  }
});

test('missing or malformed credentials leave defaults intact with no network call', async () => {
  for (const record of [undefined, { kind: 'api-key', payload: 'test' },
    grantFixture({ refresh: '' }), grantFixture({ access: ' ' }), grantFixture({ expires: Infinity }),
  ]) {
    const f = discoveryFixture();
    f.credentials.readRecord = async () => record;
    const before = structuredClone(f.catalog);
    assert.deepEqual(await sync(f), { status: 'no Copilot credential' });
    assert.deepEqual(f.catalog, before);
    assert.deepEqual(f.requests, []);
  }
  assert.deepEqual(await syncCopilotCatalog(undefined, discoveryFixture().options), { status: 'no Copilot credential' });
});

test('stored API-key Copilot tokens derive an Enterprise endpoint without refresh or writes', async () => {
  const f = discoveryFixture();
  const token = ['synthetic-token', 'proxy-ep=proxy.enterprise.githubcopilot.com'].join(';');
  const record = { kind: 'api-key', key: token };
  f.credentials.readRecord = async () => record;
  f.options.oauth.refresh = () => { throw new Error('API-key credentials cannot refresh'); };
  f.options.oauth.toAuth = async (credential) => {
    assert.equal(credential.access, token);
    return { apiKey: token, baseUrl: 'https://api.enterprise.githubcopilot.com' };
  };
  const before = structuredClone(record);
  await sync(f);
  assert.deepEqual(record, before);
  assert.equal(f.requests[0][1].origin, 'https://api.enterprise.githubcopilot.com');
  assert.equal(f.requests[0][2].headers.get('Authorization'), `Bearer ${token}`);
});

test('opaque API-key credentials need an explicit endpoint rather than guessing Individual', async () => {
  const f = discoveryFixture({ resolveApiKey: async () => 'synthetic-token' });
  const before = structuredClone(f.catalog);
  await assert.rejects(sync(f), { code: 'MISSING_ENDPOINT' });
  assert.deepEqual(f.catalog, before);
  assert.deepEqual(f.requests, []);
  f.options.baseUrl = 'https://api.enterprise.githubcopilot.com';
  f.options.oauth.toAuth = () => { throw new Error('An explicit API-key endpoint needs no OAuth derivation'); };
  await sync(f);
  assert.equal(f.requests[0][1].origin, 'https://api.enterprise.githubcopilot.com');
});

test('validated OAuth routing is published before a failed refresh/listing but never after timeout', async () => {
  const f = discoveryFixture();
  const seen = [];
  f.options.onEndpoint = (endpoint) => seen.push(endpoint);
  f.record.payload.expires = 0;
  f.options.oauth.refresh = async () => { throw new Error('synthetic failure'); };
  await assert.rejects(sync(f));
  assert.deepEqual(seen, ['https://api.enterprise.githubcopilot.com']);
  const late = discoveryFixture({ timeoutMs: 10, onEndpoint: (endpoint) => seen.push(endpoint) });
  let release;
  late.options.oauth.toAuth = () => new Promise((resolve) => { release = resolve; });
  await assert.rejects(sync(late), { code: 'TIMEOUT' });
  release({ apiKey: 'synthetic', baseUrl: 'https://api.business.githubcopilot.com' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['https://api.enterprise.githubcopilot.com']);
});

test('expiring credentials refresh only a cloned in-memory grant and share the deadline signal', async () => {
  const f = discoveryFixture();
  f.record.payload.expires = Date.now();
  const before = structuredClone(f.record);
  let refreshSignal;
  f.options.oauth.refresh = async (credential, signal) => {
    refreshSignal = signal;
    credential.access = 'fresh-token';
    return credential;
  };
  await sync(f);
  assert.deepEqual(f.record, before);
  const init = f.requests[1][2];
  assert.equal(init.headers.get('Authorization'), 'Bearer fresh-token');
  assert.equal(init.signal, refreshSignal);
});

test('GHE API validation accepts only one valid tenant label and keeps models URL normalization', () => {
  for (const tenant of ['msft', 'example-corp', 'a', 'a'.repeat(63)]) {
    assert.equal(discoveryUrl(`https://copilot-api.${tenant}.ghe.com:443/v1?ignored=yes#ignored`).href,
      `https://copilot-api.${tenant}.ghe.com/models`);
  }
  assert.equal(discoveryUrl('https://COPILOT-API.MSFT.GHE.COM').href,
    'https://copilot-api.msft.ghe.com/models');
});

test('untrusted GHE destinations fail before dispatching credentials or publishing routing', async () => {
  for (const baseUrl of [
    'https://ghe.com', 'https://msft.ghe.com', 'https://copilot-api.ghe.com',
    'https://api.msft.ghe.com', 'https://copilot-proxy.msft.ghe.com', 'https://proxy.msft.ghe.com',
    'https://other.msft.ghe.com', 'https://copilot-api.tenant.msft.ghe.com',
    'https://copilot-api.-msft.ghe.com', 'https://copilot-api.msft-.ghe.com',
    'https://copilot-api.ms_ft.ghe.com', 'https://copilot-api..ghe.com',
    `https://copilot-api.${'a'.repeat(64)}.ghe.com`,
    'https://copilot-api.msft.ghe.com.attacker.example', 'https://copilot-api.msft.notghe.com',
    'http://copilot-api.msft.ghe.com', 'https://copilot-api.msft.ghe.com:8443',
    'https://user:secret@copilot-api.msft.ghe.com',
  ]) {
    assert.throws(() => discoveryUrl(baseUrl), { code: 'UNTRUSTED_ENDPOINT' });
    const endpoints = [];
    const f = discoveryFixture({ baseUrl, resolveApiKey: async () => 'synthetic-token',
      onEndpoint: (endpoint) => endpoints.push(endpoint) });
    const before = structuredClone(f.catalog);
    await assert.rejects(sync(f), { code: 'UNTRUSTED_ENDPOINT' });
    assert.deepEqual(f.requests, [], baseUrl);
    assert.deepEqual(endpoints, []);
    assert.deepEqual(f.catalog, before);
  }
});

test('GHE discovery gives new models the validated account origin without changing credentials', async () => {
  const f = discoveryFixture();
  f.record.payload.enterpriseUrl = 'msft.ghe.com';
  const before = structuredClone(f.record);
  const endpoints = [];
  f.options.onEndpoint = (endpoint) => endpoints.push(endpoint);
  f.options.oauth.toAuth = async (credential) => {
    assert.equal(credential.enterpriseUrl, 'msft.ghe.com');
    return { apiKey: credential.access, baseUrl: `https://copilot-api.${credential.enterpriseUrl}` };
  };
  f.options.fetcher = async (url, init) => {
    assert.equal(url.href, 'https://copilot-api.msft.ghe.com/models');
    assert.equal(init.headers.get('Authorization'), 'Bearer test-access-token');
    assert.equal(init.headers.get('X-GitHub-Api-Version'), VERSION_HEADER);
    assert.equal(init.redirect, 'error');
    return { ok: true, json: async () => ({ data: [accountItem('future-ghe-model')] }) };
  };
  assert.equal((await sync(f)).status, 'synced');
  assert.equal(f.catalog['future-ghe-model'].baseUrl, 'https://copilot-api.msft.ghe.com');
  assert.deepEqual(endpoints, ['https://copilot-api.msft.ghe.com']);
  assert.deepEqual(f.record, before);
});

test('GHE refresh keeps enterprise metadata read-only and revalidates the resulting endpoint', async () => {
  for (const trusted of [true, false]) {
    const endpoints = [];
    const f = discoveryFixture({ onEndpoint: (endpoint) => endpoints.push(endpoint) });
    f.record.payload.enterpriseUrl = 'msft.ghe.com';
    f.record.payload.expires = 0;
    const before = structuredClone(f.record);
    const catalogBefore = structuredClone(f.catalog);
    let refreshSignal;
    f.options.oauth.refresh = async (credential, signal) => {
      assert.equal(credential.enterpriseUrl, 'msft.ghe.com');
      refreshSignal = signal;
      credential.access = 'fresh-token';
      return credential;
    };
    f.options.oauth.toAuth = async (credential) => ({ apiKey: credential.access,
      baseUrl: credential.access === 'fresh-token'
        ? trusted ? 'https://copilot-api.msft.ghe.com' : 'https://api.msft.ghe.com'
        : 'https://api.enterprise.githubcopilot.com' });
    if (trusted) {
      await sync(f);
      const [, url, init] = f.requests[1];
      assert.equal(url.href, 'https://copilot-api.msft.ghe.com/models');
      assert.equal(init.headers.get('Authorization'), 'Bearer fresh-token');
      assert.equal(init.signal, refreshSignal);
      assert.deepEqual(endpoints, ['https://api.enterprise.githubcopilot.com', 'https://copilot-api.msft.ghe.com']);
    } else {
      await assert.rejects(sync(f), { code: 'UNTRUSTED_ENDPOINT' });
      assert.deepEqual(f.requests, [['read', 'test-record-key']]);
      assert.deepEqual(endpoints, ['https://api.enterprise.githubcopilot.com']);
      assert.deepEqual(f.catalog, catalogBefore);
    }
    assert.deepEqual(f.record, before);
  }
});

test('host validation rejects non-Copilot hosts, credentials, HTTP, and nonstandard ports', async () => {
  for (const base of [
    'http://api.githubcopilot.com', 'https://githubcopilot.com',
    'https://githubcopilot.com.attacker.example', 'https://notgithubcopilot.com',
    'https://api.githubcopilot.com:8443', 'https://user:secret@api.githubcopilot.com',
    'file:///tmp/models', 'not a url',
  ]) assert.throws(() => discoveryUrl(base), { code: 'UNTRUSTED_ENDPOINT' });
  assert.equal(discoveryUrl('https://api.business.githubcopilot.com:443/v1').href,
    'https://api.business.githubcopilot.com/models');
  const f = discoveryFixture();
  f.options.oauth.toAuth = async () => ({ apiKey: 'secret', baseUrl: 'https://attacker.example' });
  const before = structuredClone(f.catalog);
  await assert.rejects(sync(f), { code: 'UNTRUSTED_ENDPOINT' });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.catalog, before);
});

test('HTTP, JSON, OAuth and credential-read failures preserve catalog', async () => {
  for (const stage of ['http', 'json', 'refresh', 'auth', 'read', 'fetch', 'empty']) {
    const f = discoveryFixture();
    const before = structuredClone(f.catalog);
    const fail = async () => { throw new Error('synthetic failure'); };
    if (stage === 'http') f.options.fetcher = async () => ({ ok: false, status: 401 });
    if (stage === 'json') f.options.fetcher = async () => ({ ok: true, json: fail });
    if (stage === 'refresh') { f.record.payload.expires = 0; f.options.oauth.refresh = fail; }
    if (stage === 'auth') f.options.oauth.toAuth = fail;
    if (stage === 'read') f.credentials.readRecord = fail;
    if (stage === 'fetch') f.options.fetcher = fail;
    if (stage === 'empty') f.options.fetcher = async () => ({ ok: true, json: async () => ({ data: [] }) });
    await assert.rejects(sync(f));
    assert.deepEqual(f.catalog, before);
  }
});

test('entire attempt is bounded even when credentials, refresh, auth, fetch or body ignores abort', async () => {
  const forever = () => new Promise(() => {});
  for (const stage of ['read', 'refresh', 'auth', 'fetch', 'body']) {
    const f = discoveryFixture({ timeoutMs: 15 });
    const before = structuredClone(f.catalog);
    if (stage === 'read') f.credentials.readRecord = forever;
    if (stage === 'refresh') { f.record.payload.expires = 0; f.options.oauth.refresh = forever; }
    if (stage === 'auth') f.options.oauth.toAuth = forever;
    if (stage === 'fetch') f.options.fetcher = forever;
    if (stage === 'body') f.options.fetcher = async () => ({ ok: true, json: forever });
    await assert.rejects(sync(f), { code: 'TIMEOUT' });
    assert.deepEqual(f.catalog, before);
  }
});

test('a response arriving after timeout cannot mutate the shared catalog', async () => {
  const f = discoveryFixture({ timeoutMs: 10 });
  const before = structuredClone(f.catalog);
  let release;
  let responseSignal;
  f.options.fetcher = async (_url, { signal }) => {
    responseSignal = signal;
    return new Promise((resolve) => { release = resolve; });
  };
  await assert.rejects(sync(f), { code: 'TIMEOUT' });
  assert.equal(responseSignal.aborted, true);
  release({ ok: true, json: async () => ({ data: [accountItem('gpt-6.1-sol')] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.catalog, before);
});

test('immutable upstream catalogs fail before mutation and deadlines are validated', async () => {
  const f = discoveryFixture();
  Object.freeze(f.catalog);
  await assert.rejects(sync(f), { code: 'IMMUTABLE_CATALOG' });
  for (const timeoutMs of [0, -1, 1.5, 60001]) {
    await assert.rejects(syncCopilotCatalog(undefined, { timeoutMs }), /timeoutMs/);
  }
  assert.ok(new DiscoveryError('TEST', 'safe message') instanceof Error);
});
