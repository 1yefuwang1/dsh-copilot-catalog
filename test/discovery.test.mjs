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

test('missing, invalid or api-key credentials leave defaults intact with no network call', async () => {
  for (const record of [undefined, { kind: 'api-key', payload: 'test' },
    grantFixture({ refresh: '' }), grantFixture({ access: ' ' }), grantFixture({ expires: Infinity }),
  ]) {
    const f = discoveryFixture();
    f.credentials.readRecord = async () => record;
    const before = structuredClone(f.catalog);
    assert.deepEqual(await sync(f), { status: 'no OAuth grant' });
    assert.deepEqual(f.catalog, before);
    assert.deepEqual(f.requests, []);
  }
  assert.deepEqual(await syncCopilotCatalog(undefined, discoveryFixture().options), { status: 'no OAuth grant' });
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
