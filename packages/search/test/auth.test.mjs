import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebError } from '@deepseek-ai/dsh-web';
import { CopilotAuthError, createCopilotAuthResolver, createCopilotCredentialStore } from '../dist/auth.js';
import { trustedCopilotOrigin } from '../dist/endpoint.js';
import { contextFixture, credentialFixture, deferred, enterprise, ghe, gheToken, grant, individual, runtimeFixture, token } from './auth-helpers.mjs';

const signal = () => new AbortController().signal;
const turn = () => new Promise((resolve) => setImmediate(resolve));

function setup(record, { ambient, references, runtime, beforeMutation } = {}) {
  const fixture = credentialFixture(record, { references, beforeMutation });
  const dependencies = runtime ?? runtimeFixture();
  return { ...fixture, runtime: dependencies,
    resolve: createCopilotAuthResolver(contextFixture(fixture.service, ambient), dependencies) };
}

function safeError(code, secret) {
  return (error) => {
    assert.ok(error instanceof WebError);
    if (code) assert.equal(error.code, code);
    if (secret) assert.ok(!`${error.message}\n${error.stack}\n${JSON.stringify(error)}`.includes(secret));
    return true;
  };
}

test('fresh stored OAuth uses the account origin and never writes or refreshes', async () => {
  let refreshes = 0;
  const stored = grant({ availableModelIds: ['synthetic-responses-model'] });
  const fixture = setup(stored, { runtime: runtimeFixture({ refresh: async () => { refreshes++; throw new Error('Unexpected refresh'); } }) });
  const auth = await fixture.resolve({}, signal());
  assert.equal(auth.apiKey, token());
  assert.equal(auth.baseUrl, enterprise);
  assert.equal(fixture.current(), stored);
  assert.equal(refreshes, 0);
  assert.equal(fixture.stats.writes, 0);
  assert.deepEqual(fixture.stats.references, []);
});

test('explicit key reference owns authentication over an unrelated stored OAuth account', async () => {
  const fixture = setup(grant({ access: token('individual') }), { references: { COPILOT_ACCESS_TOKEN: token() } });
  const auth = await fixture.resolve({ apiKeyEnv: 'COPILOT_ACCESS_TOKEN' }, signal());
  assert.equal(auth.baseUrl, enterprise);
  assert.equal(auth.apiKey, token());
  assert.equal(fixture.stats.reads, 0);
  assert.equal(fixture.stats.writes, 0);
});

test('unset or invalid explicit references cannot fall back to a stored or ambient account', async () => {
  const fixture = setup(grant(), { ambient: { COPILOT_GITHUB_TOKEN: token() } });
  await assert.rejects(fixture.resolve({ apiKeyEnv: 'UNSET_COPILOT_TOKEN' }, signal()), safeError('WEB_PROVIDER_CREDENTIAL_MISSING'));
  await assert.rejects(fixture.resolve({ apiKeyEnv: 'not a reference' }, signal()), safeError('WEB_PROVIDER_AUTH_INVALID'));
  assert.equal(fixture.stats.reads, 0);
  assert.equal(fixture.stats.writes, 0);
});

test('ambient and stored API keys preserve the public SDK precedence and account routing', async () => {
  const ambient = setup(undefined, { ambient: { COPILOT_GITHUB_TOKEN: token() } });
  assert.equal((await ambient.resolve({}, signal())).baseUrl, enterprise);
  const stored = setup({ kind: 'api-key', key: token(), env: { COPILOT_GITHUB_TOKEN: token('individual') } },
    { ambient: { COPILOT_GITHUB_TOKEN: token('individual') } });
  const auth = await stored.resolve({}, signal());
  assert.equal(auth.baseUrl, enterprise);
  assert.equal(auth.apiKey, token());
  assert.equal(stored.stats.writes, 0);
  // pi-ai's standard Copilot handler uses credential.key or ctx.env, not credential.env.
  // An environment-only record must not introduce a search-only account override.
  const environmentOnly = setup({ kind: 'api-key', env: { COPILOT_GITHUB_TOKEN: token() } },
    { ambient: { COPILOT_GITHUB_TOKEN: token('individual') } });
  assert.equal((await environmentOnly.resolve({}, signal())).baseUrl, individual);
});

test('opaque API keys require explicit origins; OAuth retains its own account routing', async () => {
  const opaque = setup({ kind: 'api-key', key: 'synthetic-token' });
  await assert.rejects(opaque.resolve({}, signal()), safeError('WEB_PROVIDER_ENDPOINT_MISSING'));
  assert.equal((await opaque.resolve({ baseURL: enterprise }, signal())).baseUrl, enterprise);
  const oauth = setup(grant());
  assert.equal((await oauth.resolve({ baseURL: individual }, signal())).baseUrl, enterprise);
});

test('trusted origins reject redirects-by-configuration, userinfo, paths, ports and controls', async () => {
  const rejected = [
    'http://api.enterprise.githubcopilot.com', 'https://githubcopilot.com',
    'https://api.githubcopilot.com.evil.invalid', 'https://api.githubcopilot.com:444',
    'https://api.githubcopilot.com/responses', 'https://api.githubcopilot.com?query=value',
    'https://api.githubcopilot.com#fragment', ' https://api.githubcopilot.com', 'https://@api.githubcopilot.com',
    'https:\\api.githubcopilot.com',
    'https://api.githubcopilot.com\n', 'https://' + 'user:secret@api.githubcopilot.com',
  ];
  for (const value of rejected) assert.throws(() => trustedCopilotOrigin(value), safeError('WEB_PROVIDER_ENDPOINT_UNTRUSTED'));
  assert.equal(trustedCopilotOrigin(`${enterprise}:443/`), enterprise);
  const fixture = setup(grant());
  await assert.rejects(fixture.resolve({ baseURL: rejected[0] }, signal()), safeError('WEB_PROVIDER_ENDPOINT_UNTRUSTED'));
  assert.equal(fixture.stats.reads, 0);
});

test('GHE origins accept only tenant-specific Copilot API gateways', () => {
  for (const tenant of ['company', 'a', 'team-123', 'a'.repeat(63)]) {
    const origin = `https://copilot-api.${tenant}.ghe.com`;
    assert.equal(trustedCopilotOrigin(origin), origin);
    assert.equal(trustedCopilotOrigin(`${origin}:443/`), origin);
  }
  assert.equal(trustedCopilotOrigin('https://COPILOT-API.COMPANY.GHE.COM/'), ghe);
  const rejected = [
    'https://ghe.com', 'https://company.ghe.com', 'https://api.company.ghe.com',
    'https://copilot-api.ghe.com', 'https://copilot-api..ghe.com',
    'https://copilot-api.team.company.ghe.com', 'https://copilot-api.company.ghe.com.evil.invalid',
    'https://copilot-api.company.evilghe.com', 'https://evilcopilot-api.company.ghe.com',
    'https://copilot-api.-company.ghe.com', 'https://copilot-api.company-.ghe.com',
    'https://copilot-api.company_name.ghe.com', `https://copilot-api.${'a'.repeat(64)}.ghe.com`,
    'https://copilot-api.company.ghe.com.', 'http://copilot-api.company.ghe.com',
    `${ghe}:444`, `${ghe}/responses`, `${ghe}?query=value`, `${ghe}#fragment`,
    ` ${ghe}`, `${ghe}\n`, 'https://@copilot-api.company.ghe.com',
    'https://' + 'user:secret@copilot-api.company.ghe.com',
    'https://copilot-api.company.ghe.com\\responses',
  ];
  for (const value of rejected) assert.throws(() => trustedCopilotOrigin(value), safeError('WEB_PROVIDER_ENDPOINT_UNTRUSTED'));
});

test('GHE OAuth keeps token-derived or Enterprise fallback routing without a global override', async () => {
  for (const access of [gheToken(), 'synthetic-token']) {
    const stored = grant({ access, enterpriseUrl: 'company.ghe.com' });
    const fixture = setup(stored);
    const auth = await fixture.resolve({ baseURL: individual }, signal());
    assert.equal(auth.baseUrl, ghe);
    assert.equal(auth.apiKey, access);
    assert.equal(fixture.current(), stored);
    assert.equal(fixture.stats.writes, 0);
  }
  const keyed = setup({ kind: 'api-key', key: gheToken() });
  assert.equal((await keyed.resolve({}, signal())).baseUrl, ghe);
  const opaque = setup({ kind: 'api-key', key: 'synthetic-token' });
  assert.equal((await opaque.resolve({ baseURL: ghe }, signal())).baseUrl, ghe);
});

test('expired OAuth refresh is serialized globally and normalizes optional JSON fields', async () => {
  let refreshes = 0;
  const original = grant({ expires: 0 });
  const fixture = setup(original, { runtime: runtimeFixture({ refresh: async (current) => {
    refreshes++;
    current.availableModelIds = ['synthetic-responses-model'];
    return { ...current, access: token(), expires: Date.now() + 3_600_000, enterpriseUrl: undefined,
      extra: { absent: undefined, list: [undefined, 'kept'] } };
  } }) });
  const results = await Promise.all([fixture.resolve({}, signal()), fixture.resolve({}, signal())]);
  assert.equal(refreshes, 1);
  assert.equal(fixture.stats.writes, 1);
  assert.equal(fixture.stats.modifications, 2);
  assert.ok(results.every((auth) => auth.baseUrl === enterprise && auth.apiKey === token()));
  assert.equal(Object.hasOwn(fixture.current().payload, 'enterpriseUrl'), false);
  assert.deepEqual(fixture.current().payload.extra, { list: [null, 'kept'] });
  assert.equal(Object.hasOwn(original.payload, 'availableModelIds'), false, 'Upstream mutators receive a detached grant');
});

test('pre-cancelled auth never reads credentials or references', async () => {
  const fixture = setup(grant());
  const controller = new AbortController();
  controller.abort('synthetic cancellation');
  await assert.rejects(fixture.resolve({}, controller.signal), safeError('WEB_ABORTED'));
  assert.equal(fixture.stats.reads, 0);
  assert.equal(fixture.stats.references.length, 0);
});

test('cancellation releases an uncooperative explicit reference and observes its late rejection', async () => {
  const gate = deferred();
  const entered = deferred();
  const fixture = setup(grant());
  fixture.service.resolve = async () => { entered.resolve(); return gate.promise; };
  const controller = new AbortController();
  const pending = fixture.resolve({ apiKeyEnv: 'COPILOT_ACCESS_TOKEN' }, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, safeError('WEB_ABORTED'));
  gate.reject(new Error('synthetic late failure'));
  await turn();
  assert.equal(fixture.stats.reads, 0);
  assert.equal(fixture.stats.writes, 0);
});

test('cancelled lock wait cannot start a late OAuth mutation', async () => {
  const entered = deferred(), gate = deferred();
  let refreshes = 0;
  const fixture = setup(grant({ expires: 0 }), {
    beforeMutation: async () => { entered.resolve(); await gate.promise; },
    runtime: runtimeFixture({ refresh: async (current) => { refreshes++; return { ...current, expires: Date.now() + 3_600_000 }; } }),
  });
  const controller = new AbortController();
  const pending = fixture.resolve({}, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, safeError('WEB_ABORTED'));
  gate.resolve();
  await fixture.drained();
  assert.equal(refreshes, 0);
  assert.equal(fixture.stats.writes, 0);
});

test('an uncooperative refresh returning after cancellation cannot commit a new grant', async () => {
  const entered = deferred(), gate = deferred();
  const original = grant({ expires: 0 });
  const fixture = setup(original, { runtime: runtimeFixture({ refresh: async (current) => {
    entered.resolve(); await gate.promise;
    return { ...current, access: token('individual'), expires: Date.now() + 3_600_000 };
  } }) });
  const controller = new AbortController();
  const pending = fixture.resolve({}, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, safeError('WEB_ABORTED'));
  gate.resolve();
  await fixture.drained();
  assert.equal(fixture.stats.writes, 0);
  assert.equal(fixture.current(), original);
});

test('logout or another fresh account under the lock is not overwritten by stale refresh work', async () => {
  for (const replacement of [undefined, grant({ access: token('individual') })]) {
    const entered = deferred(), gate = deferred();
    let refreshes = 0;
    const fixture = setup(grant({ expires: 0 }), { ambient: { COPILOT_GITHUB_TOKEN: token() },
      beforeMutation: async () => { entered.resolve(); await gate.promise; },
      runtime: runtimeFixture({ refresh: async () => { refreshes++; throw new Error('Stale refresh must not run'); } }),
    });
    const pending = fixture.resolve({}, signal());
    await entered.promise;
    fixture.set(replacement);
    gate.resolve();
    const result = await pending;
    assert.equal(refreshes, 0);
    assert.equal(fixture.stats.writes, 0);
    assert.equal(fixture.current(), replacement);
    assert.equal(result?.baseUrl, replacement === undefined ? undefined : individual);
    assert.deepEqual(fixture.stats.references, [], 'A stored OAuth route never silently switches to ambient auth');
  }
});

test('credential bridge cannot create records, replace API keys, cross provider scope or delete', async () => {
  for (const original of [undefined, { kind: 'api-key', key: 'synthetic-token' }]) {
    const fixture = credentialFixture(original);
    const runtime = runtimeFixture();
    const store = createCopilotCredentialStore(fixture.service, runtime.recordKeyFor('github-copilot'));
    await assert.rejects(store.modify('github-copilot', async () => grant().payload), safeError('WEB_PROVIDER_AUTH_WRITE_REFUSED'));
    await assert.rejects(store.modify('another-provider', async () => undefined), safeError('WEB_PROVIDER_AUTH_WRITE_REFUSED'));
    await assert.rejects(store.delete('github-copilot'), safeError('WEB_PROVIDER_AUTH_WRITE_REFUSED'));
    assert.equal(await store.read('another-provider'), undefined);
    assert.equal(fixture.stats.writes, 0);
    assert.equal(fixture.current(), original);
  }
});

test('bridge clones grant data even when a mutator declines replacement', async () => {
  const original = grant({ availableModelIds: ['kept'] });
  const fixture = credentialFixture(original);
  const runtime = runtimeFixture();
  const store = createCopilotCredentialStore(fixture.service, runtime.recordKeyFor('github-copilot'));
  await store.modify('github-copilot', async (current) => { current.availableModelIds.push('discarded'); return undefined; });
  assert.deepEqual(original.payload.availableModelIds, ['kept']);
  assert.equal(fixture.stats.writes, 0);
});

test('malformed stored grants fail closed without refreshing or ambient fallback', async () => {
  for (const payload of [null, {}, { ...grant().payload, type: 'another-grant' },
    { ...grant().payload, expires: Infinity }, { ...grant().payload, access: ['synthetic', 'unsafe'].join('\n') },
    Object.assign(Object.create({ foreign: true }), grant().payload)]) {
    let refreshes = 0;
    const fixture = setup({ kind: 'grant', payload }, { ambient: { COPILOT_GITHUB_TOKEN: token() },
      runtime: runtimeFixture({ refresh: async () => { refreshes++; throw new Error('Invalid grant must not refresh'); } }) });
    await assert.rejects(fixture.resolve({}, signal()), safeError('WEB_PROVIDER_AUTH_ERROR'));
    assert.equal(refreshes, 0);
    assert.equal(fixture.stats.writes, 0);
    assert.deepEqual(fixture.stats.references, []);
  }
});

test('token-derived untrusted endpoints and unsafe refreshed tokens fail without secret exposure', async () => {
  const secret = 'test-access-token';
  const untrusted = setup(grant({ access: [secret, 'proxy-ep=untrusted.invalid'].join(';') }));
  await assert.rejects(untrusted.resolve({}, signal()), safeError('WEB_PROVIDER_ENDPOINT_UNTRUSTED', secret));
  const unsafe = setup(grant({ expires: 0 }), { runtime: runtimeFixture({ refresh: async (current) => ({
    ...current, access: `${secret}\nunsafe`, expires: Date.now() + 3_600_000,
  }) }) });
  await assert.rejects(unsafe.resolve({}, signal()), safeError('WEB_PROVIDER_AUTH_ERROR', secret));
  assert.equal(unsafe.stats.writes, 0);
});

test('SDK, store and mutable owned dependency errors are replaced with controlled diagnostics', async () => {
  const secret = 'test-access-token';
  const stored = setup(grant());
  stored.service.readRecord = async () => { throw new Error(`private body ${secret}`); };
  await assert.rejects(stored.resolve({}, signal()), safeError('WEB_PROVIDER_AUTH_ERROR', secret));
  const upstream = setup(grant({ expires: 0 }), { runtime: runtimeFixture({ refresh: async () => { throw new Error(`private body ${secret}`); } }) });
  await assert.rejects(upstream.resolve({}, signal()), safeError('WEB_PROVIDER_AUTH_ERROR', secret));
  const mutated = setup(grant());
  mutated.service.resolve = async () => {
    const error = new CopilotAuthError('failed');
    error.message = secret;
    error.code = secret;
    error.kind = '__proto__';
    throw error;
  };
  await assert.rejects(mutated.resolve({ apiKeyEnv: 'COPILOT_ACCESS_TOKEN' }, signal()), safeError('WEB_PROVIDER_AUTH_ERROR', secret));
});

test('throwing error kinds, coercion and prototype traps cannot escape controlled auth diagnostics', async () => {
  const secret = 'test-access-token';
  const failures = [
    () => {
      const error = new CopilotAuthError('failed');
      Object.defineProperty(error, 'kind', { get() { throw new Error(secret); } });
      return error;
    },
    () => {
      const error = new CopilotAuthError('failed');
      error.kind = { [Symbol.toPrimitive]() { throw new Error(secret); } };
      return error;
    },
    () => new Proxy({}, { getPrototypeOf() { throw new Error(secret); } }),
  ];
  for (const failure of failures) {
    const fixture = setup(grant());
    fixture.service.resolve = async () => { throw failure(); };
    await assert.rejects(fixture.resolve({ apiKeyEnv: 'COPILOT_ACCESS_TOKEN' }, signal()), safeError('WEB_PROVIDER_AUTH_ERROR', secret));
  }
  assert.equal(new CopilotAuthError({ [Symbol.toPrimitive]() { throw new Error(secret); } }).code, 'WEB_PROVIDER_AUTH_ERROR');
});

test('mutating a callback snapshot cannot promote an API-key record or replace OAuth account authority', async () => {
  const runtime = runtimeFixture();
  const keyed = credentialFixture({ kind: 'api-key', key: 'synthetic-token' });
  const keyStore = createCopilotCredentialStore(keyed.service, runtime.recordKeyFor('github-copilot'));
  await assert.rejects(keyStore.modify('github-copilot', async (current) => Object.assign(current, grant().payload)),
    safeError('WEB_PROVIDER_AUTH_WRITE_REFUSED'));
  assert.equal(keyed.stats.writes, 0);
  assert.equal(keyed.current().kind, 'api-key');
  for (const changes of [{ refresh: 'synthetic-token' }, { enterpriseUrl: 'company.ghe.com' }]) {
    const original = grant();
    const fixture = credentialFixture(original);
    const store = createCopilotCredentialStore(fixture.service, runtime.recordKeyFor('github-copilot'));
    await assert.rejects(store.modify('github-copilot', async (current) => Object.assign(current, changes)),
      safeError('WEB_PROVIDER_AUTH_WRITE_REFUSED'));
    assert.equal(fixture.stats.writes, 0);
    assert.equal(fixture.current(), original);
  }
});
