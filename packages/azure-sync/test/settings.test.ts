import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { Config } from '../src/config.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { LocalStore } from '../src/local/store.js';
import { localSettingsSchema, type LocalSettingsRecord } from '../src/schema.js';
import { SettingsService, type AuthUpdate, type DefaultsUpdate } from '../src/settings.js';

const syntheticKey = Buffer.from('secretkey').toString('base64');
const SECRET = `DefaultEndpointsProtocol=https;AccountName=account123;AccountKey=${syntheticKey};EndpointSuffix=core.windows.net`;
const REF = 'DSH_AZURE_SYNC_SETTINGS_TEST';
const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href);

function config(overrides: Record<string, unknown> = {}) {
  return Config({ connectionRef: REF, accountName: 'account123', ...overrides });
}

function fakeLocal(initial?: LocalSettingsRecord, events: string[] = []) {
  const state = { record: initial, fail: false, puts: 0, failAt: undefined as number | undefined,
    commitThenFailAt: undefined as number | undefined,
    onPut: undefined as ((record: LocalSettingsRecord, count: number) => Promise<void>) | undefined };
  const local = {
    getSettings: () => state.record,
    async putSettings(record: LocalSettingsRecord) {
      events.push('put');
      const count = ++state.puts;
      await state.onPut?.(record, count);
      if (state.fail || state.failAt === count) throw new Error(SECRET);
      state.record = localSettingsSchema.parse(record);
      if (state.commitThenFailAt === count) throw new Error(SECRET);
    },
  } as unknown as LocalStore;
  return { local, state };
}

function fakeCredentials(events: string[] = []) {
  const state = {
    value: undefined as string | undefined,
    fallback: undefined as string | undefined,
    writable: true,
    source: 'file',
    fail: undefined as 'resolve' | 'describe' | 'set' | 'unset' | undefined,
    onSet: undefined as (() => Promise<void>) | undefined,
    onUnset: undefined as (() => Promise<void>) | undefined,
    onResolve: undefined as (() => Promise<void>) | undefined,
    onDescribe: undefined as ((count: number) => Promise<void>) | undefined,
    describeCount: 0,
  };
  const provider = {
    async resolve(ref: string) {
      assert.equal(ref, REF);
      events.push('resolve');
      if (state.fail === 'resolve') throw new Error(SECRET);
      await state.onResolve?.();
      const value = state.value ?? state.fallback;
      return value === undefined ? undefined : { value, source: state.source };
    },
    async describe(ref: string) {
      assert.equal(ref, REF);
      state.describeCount++;
      if (state.fail === 'describe') throw new Error(SECRET);
      await state.onDescribe?.(state.describeCount);
      return { configured: Boolean(state.value ?? state.fallback), writable: state.writable, source: state.source, connectionString: SECRET, arbitrary: { nestedSecret: SECRET } };
    },
    async set(ref: string, value: string) {
      assert.equal(ref, REF);
      events.push('set');
      state.value = value;
      await state.onSet?.();
      if (state.fail === 'set') throw new Error(SECRET);
    },
    async unset(ref: string) {
      assert.equal(ref, REF);
      events.push('unset');
      state.value = undefined;
      await state.onUnset?.();
      if (state.fail === 'unset') throw new Error(SECRET);
    },
  } as unknown as CredentialProvider;
  return { provider, state };
}

function safeError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AzureSyncError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes(SECRET));
    assert.ok(!JSON.stringify(error).includes(SECRET));
    return true;
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test('get enumerates safe metadata and never opts new threads in, including administrator defaults', async () => {
  const local = fakeLocal();
  const credentials = fakeCredentials();
  credentials.state.value = SECRET;
  credentials.state.source = `untrusted-${SECRET}`;
  const service = new SettingsService({ local: local.local, config: config({ defaultEnabled: true }), credentials: credentials.provider });
  const view = await service.get();
  assert.equal(view.defaultEnabled, false);
  assert.equal(service.effectiveConfig().defaultEnabled, false);
  assert.deepEqual(view.connection, { configured: true, writable: true, source: 'provider' });
  assert.equal(view.connectionRef, REF);
  assert.equal(view.container, 'dsh-state');
  assert.equal(view.table, 'dshstatesync');
  assert.equal(view.endpointSuffix, 'core.windows.net');
  assert.ok(!JSON.stringify(view).includes(SECRET));
  assert.equal(Object.hasOwn(view, 'connectionString'), false);
});

test('legacy durable defaultEnabled true loads as off and every next settings write persists false', async () => {
  for (const nextWrite of ['auth', 'defaults']) {
    const local = fakeLocal({ defaultEnabled: true, pullOnStartup: false, pollSeconds: 45 });
    const service = new SettingsService({ local: local.local, config: config({ defaultEnabled: true }) });
    assert.equal(service.effectiveConfig().defaultEnabled, false);
    const view = await service.get();
    assert.equal(view.defaultEnabled, false);
    assert.equal(view.pullOnStartup, false);
    assert.equal(view.pollSeconds, 45);
    // Reading old bytes remains compatible and never grants implicit opt-in.
    assert.equal(local.state.record?.defaultEnabled, true);
    await assert.rejects(service.setDefaults({ defaultEnabled: true }), safeError('INVALID_CONFIG'));
    const updated = nextWrite === 'auth'
      ? await service.setAuth({ auth: 'azure-cli' })
      : await service.setDefaults({ pollSeconds: 60 });
    assert.equal(updated.defaultEnabled, false);
    assert.equal(local.state.record?.defaultEnabled, false);
  }
});

test('legacy durable pollSeconds above the configured range loads clamped and normalizes on every next write', async () => {
  for (const pollSeconds of [100_000, Number.MAX_SAFE_INTEGER]) {
    for (const nextWrite of ['auth', 'defaults']) {
      const local = fakeLocal({ defaultEnabled: false, pullOnStartup: true, pollSeconds });
      const service = new SettingsService({ local: local.local, config: config() });
      assert.equal(service.effectiveConfig().pollSeconds, 86_400);
      assert.equal((await service.get()).pollSeconds, 86_400);
      assert.equal(local.state.record?.pollSeconds, pollSeconds);
      await assert.rejects(service.setDefaults({ pollSeconds }), safeError('INVALID_CONFIG'));
      const updated = nextWrite === 'auth'
        ? await service.setAuth({ auth: 'azure-cli' })
        : await service.setDefaults({ pullOnStartup: false });
      assert.equal(updated.pollSeconds, 86_400);
      assert.equal(local.state.record?.pollSeconds, 86_400);
    }
  }
});

test('auth writes only through the public fixed-reference credential API and ordered runtime hooks', async () => {
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  const credentials = fakeCredentials(events);
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
    now: () => 123, onBeforeChange: async () => { events.push('before'); }, onChange: async () => {
      events.push('change');
      assert.equal(local.state.record?.auth, 'connection-string');
    },
  });
  const view = await service.setAuth({ auth: 'connection-string', connectionString: ` ${SECRET} `, accountName: 'account456' });
  assert.deepEqual(events, ['before', 'put', 'set', 'put', 'change']);
  assert.equal(credentials.state.value, SECRET);
  assert.match(local.state.record?.authGeneration ?? '', /^[0-9a-f-]{36}$/u);
  assert.deepEqual(local.state.record, { defaultEnabled: false, pullOnStartup: true, pollSeconds: 300,
    auth: 'connection-string', accountName: 'account456', managedIdentityClientId: '', updatedAt: 123,
    authGeneration: local.state.record?.authGeneration });
  assert.equal(view.authPending, false);
  assert.equal(view.auth, 'connection-string');
  assert.equal(view.updatedAt, 123);
  assert.ok(!JSON.stringify(local.state.record).includes(SECRET));
  assert.ok(!JSON.stringify(view).includes(SECRET));
});

test('clear removes only the writable credential and reports the remaining fallback honestly', async () => {
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  const credentials = fakeCredentials(events);
  credentials.state.value = SECRET;
  credentials.state.fallback = SECRET;
  credentials.state.source = 'env';
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
    onBeforeChange: async () => { events.push('before'); }, onChange: async () => { events.push('change'); },
  });
  const view = await service.setAuth({ auth: 'azure-cli', clearConnectionString: true });
  assert.deepEqual(events, ['before', 'put', 'unset', 'put', 'change']);
  assert.equal(credentials.state.value, undefined);
  assert.deepEqual(view.connection, { configured: true, writable: true, source: 'env' });
  assert.equal(await service.readCredential(REF), SECRET);
});

test('ambient authentication and pull/poll defaults work without optional credential or runtime services', async () => {
  const local = fakeLocal();
  const service = new SettingsService({ local: local.local, config: config() });
  assert.equal((await service.setAuth({ auth: 'managed-identity', managedIdentityClientId: CLIENT_ID })).managedIdentityClientId, CLIENT_ID);
  const view = await service.setDefaults({ defaultEnabled: false, pullOnStartup: false, pollSeconds: 86_400 });
  assert.equal(view.defaultEnabled, false);
  assert.equal(view.pullOnStartup, false);
  assert.equal(view.pollSeconds, 86_400);
  assert.equal(view.connection.writable, false);
  const effective = service.effectiveConfig();
  assert.equal(effective.auth, 'managed-identity');
  assert.equal(effective.connectionRef, REF);
  assert.equal(effective.container, 'dsh-state');
  effective.accountName = 'changed123';
  assert.equal(service.effectiveConfig().accountName, 'account123');
});

test('environment fallback is read-only when credentials are absent and reference reads are restricted', async (t) => {
  const original = process.env[REF];
  process.env[REF] = SECRET;
  t.after(() => { if (original === undefined) delete process.env[REF]; else process.env[REF] = original; });
  const local = fakeLocal();
  let before = 0;
  const service = new SettingsService({ local: local.local, config: config(), onBeforeChange: async () => { before++; } });
  assert.equal(await service.readCredential(REF), SECRET);
  assert.deepEqual((await service.get()).connection, { configured: true, writable: false, source: 'env' });
  await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }), safeError('AUTH_REQUIRED'));
  await assert.rejects(service.setAuth({ auth: 'azure-cli', clearConnectionString: true }), safeError('AUTH_REQUIRED'));
  await assert.rejects(service.readCredential('OTHER_SECRET'), safeError('INVALID_CONFIG'));
  assert.equal(process.env[REF], SECRET);
  assert.equal(before, 0);
  assert.equal(local.state.record, undefined);
});

test('provider resolution is fresh per read and never silently falls back after an error', async () => {
  const local = fakeLocal();
  const credentials = fakeCredentials();
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
  assert.equal(await service.readCredential(REF), undefined);
  credentials.state.value = SECRET;
  assert.equal(await service.readCredential(REF), SECRET);
  credentials.state.value = '   ';
  assert.equal(await service.readCredential(REF), undefined);
  credentials.state.fail = 'resolve';
  await assert.rejects(service.readCredential(REF), safeError('AUTH_FAILED'));
  credentials.state.fail = 'describe';
  await assert.rejects(service.get(), safeError('AUTH_FAILED'));
});

test('unconfigured descriptions omit source and recognized source names are the only reflected values', async () => {
  const local = fakeLocal();
  const credentials = fakeCredentials();
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
  assert.deepEqual((await service.get()).connection, { configured: false, writable: true });
  credentials.state.value = SECRET;
  for (const source of ['env', 'file', 'project-env', 'user-env']) {
    credentials.state.source = source;
    assert.equal((await service.get()).connection.source, source);
  }
});

test('strict auth input rejects unknown admin fields, secret ambiguity, malformed account/client id, and empty secrets', async () => {
  for (const input of [
    { auth: 'azure-cli', connectionRef: 'OTHER_REF' },
    { auth: 'azure-cli', container: 'another-container' },
    { auth: 'azure-cli', table: 'othertable' },
    { auth: 'azure-cli', endpointSuffix: 'example.com' },
    { auth: 'auto', connectionString: SECRET, clearConnectionString: true },
    { auth: 'azure-cli', connectionString: SECRET },
    { auth: 'azure-cli', accountName: 'Bad/Name' },
    { auth: 'managed-identity', managedIdentityClientId: SECRET },
    { auth: 'auto', connectionString: '' },
    { auth: 'unknown' },
  ]) {
    const events: string[] = [];
    const local = fakeLocal(undefined, events);
    const credentials = fakeCredentials(events);
    const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider, onBeforeChange: async () => { events.push('before'); } });
    await assert.rejects(service.setAuth(input as AuthUpdate), safeError('INVALID_CONFIG'));
    assert.deepEqual(events, []);
    assert.equal(local.state.record, undefined);
  }
});

test('strict defaults reject enabling future threads and out-of-bounds or unexpected fields', async () => {
  for (const input of [
    { defaultEnabled: true }, { pollSeconds: 29 }, { pollSeconds: 86_401 }, { pollSeconds: 30.5 },
    { pollSeconds: NaN }, { pullOnStartup: 'yes' }, { auth: 'auto' }, { connectionString: SECRET },
  ]) {
    const local = fakeLocal();
    const service = new SettingsService({ local: local.local, config: config() });
    await assert.rejects(service.setDefaults(input as DefaultsUpdate), safeError('INVALID_CONFIG'));
    assert.equal(local.state.record, undefined);
  }
  const local = fakeLocal();
  const service = new SettingsService({ local: local.local, config: config() });
  assert.equal((await service.setDefaults({ pollSeconds: 30 })).pollSeconds, 30);
});

test('local settings schema persists only bounded nonsecret overrides', () => {
  const base = { defaultEnabled: false, pullOnStartup: true, pollSeconds: 300 };
  assert.ok(localSettingsSchema.safeParse({ ...base, auth: 'auto', accountName: '', managedIdentityClientId: CLIENT_ID }).success);
  for (const extra of [
    { connectionString: SECRET }, { connectionRef: REF }, { endpointSuffix: 'example.com' },
    { auth: 'other' }, { accountName: SECRET }, { managedIdentityClientId: SECRET },
    { defaultEnabled: 'true' }, { pollSeconds: '86401' }, { pollSeconds: 29 },
  ]) assert.equal(localSettingsSchema.safeParse({ ...base, ...extra }).success, false);
});

test('insecure or malformed connection strings fail before any credential, settings, or runtime mutation', async () => {
  const cases: Array<[string, string]> = [
    [SECRET.replace('https', 'http'), 'INSECURE_ENDPOINT'],
    [`${SECRET};BlobEndpoint=http://example.com`, 'INSECURE_ENDPOINT'],
    [`${SECRET};QueueEndpoint=http://example.com`, 'INSECURE_ENDPOINT'],
    ['UseDevelopmentStorage=true', 'INSECURE_ENDPOINT'],
    [`${SECRET};AccountKey=second`, 'INVALID_CONFIG'],
    [`${SECRET};accountkey=second`, 'INVALID_CONFIG'],
    [`${SECRET};SharedAccessSignature=sv=2024&sig=secret`, 'INVALID_CONFIG'],
    [`${SECRET};Unknown=field`, 'INVALID_CONFIG'],
    [`${SECRET};;`, 'INVALID_CONFIG'],
    [`${SECRET};BlobEndpoint=${['https://', 'user:password@example.com'].join('')}`, 'INVALID_CONFIG'],
    [`${SECRET};BlobEndpoint=https://example.com/?sig=secret`, 'INVALID_CONFIG'],
    [`${SECRET};TableEndpoint=https://example.com/#secret`, 'INVALID_CONFIG'],
    [`${SECRET};TableEndpoint=ftp://example.com`, 'INSECURE_ENDPOINT'],
    ['AccountName=account123;AccountKey=not-a-base64-key', 'INVALID_CONFIG'],
    ['DefaultEndpointsProtocol=https;AccountName=account123', 'INVALID_CONFIG'],
    ['SharedAccessSignature=sv=2024&sig=one&sig=two', 'INVALID_CONFIG'],
    ['SharedAccessSignature=sv=2024&sig=one', 'INVALID_CONFIG'],
    [`${SECRET}\n`, 'INVALID_CONFIG'],
    [' '.repeat(2), 'INVALID_CONFIG'],
  ];
  for (const [connectionString, code] of cases) {
    const events: string[] = [];
    const local = fakeLocal(undefined, events);
    const credentials = fakeCredentials(events);
    const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider, onBeforeChange: async () => { events.push('before'); } });
    await assert.rejects(service.setAuth({ auth: 'connection-string', connectionString }), safeError(code), connectionString);
    assert.deepEqual(events, []);
    assert.equal(credentials.state.value, undefined);
    assert.equal(local.state.record, undefined);
  }
});

test('valid SAS and explicitly administrator-authorized emulator credentials are accepted', async () => {
  const sas = 'BlobEndpoint=https://account123.blob.core.windows.net;TableEndpoint=https://account123.table.core.windows.net;SharedAccessSignature=sv=2024-11-04&sig=signature&sp=rwl';
  for (const [connectionString, allowInsecure] of [[sas, false], ['UseDevelopmentStorage=true', true]] as const) {
    const local = fakeLocal();
    const credentials = fakeCredentials();
    const service = new SettingsService({ local: local.local, config: config({ allowInsecure }), credentials: credentials.provider });
    assert.equal((await service.setAuth({ auth: 'connection-string', connectionString })).connection.configured, true);
    assert.equal(credentials.state.value, connectionString);
  }
});

test('switching to an existing insecure credential fails before settings change', async () => {
  const local = fakeLocal();
  const credentials = fakeCredentials();
  credentials.state.value = SECRET.replace('https', 'http');
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
  await assert.rejects(service.setAuth({ auth: 'auto' }), safeError('INSECURE_ENDPOINT'));
  assert.equal(local.state.record, undefined);
  // Ambient modes do not need to resolve a dormant connection string.
  credentials.state.fail = 'resolve';
  assert.equal((await service.setAuth({ auth: 'azure-cli' })).auth, 'azure-cli');
});

test('read-only credential providers reject writes without stopping the current runtime', async () => {
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  const credentials = fakeCredentials(events);
  credentials.state.writable = false;
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider, onBeforeChange: async () => { events.push('before'); } });
  await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }), safeError('AUTH_REQUIRED'));
  assert.deepEqual(events, []);
});

test('failed pre-change hook cannot change credentials or settings and its exception is sanitized', async () => {
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  const credentials = fakeCredentials(events);
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
    onBeforeChange: async () => { throw new Error(SECRET); }, onChange: async () => { events.push('change'); },
  });
  await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }), safeError('AZURE_OPERATION_FAILED'));
  assert.deepEqual(events, []);
  assert.equal(local.state.record, undefined);
});

test('unconfirmed credential set/unset never restarts or rolls back unsafely', async () => {
  for (const method of ['set', 'unset'] as const) {
    const events: string[] = [];
    const local = fakeLocal(undefined, events);
    const credentials = fakeCredentials(events);
    credentials.state.fail = method;
    const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
      onBeforeChange: async () => { events.push('before'); }, onChange: async () => { events.push('change'); },
    });
    await assert.rejects(service.setAuth({ auth: 'auto', ...(method === 'set' ? { connectionString: SECRET } : { clearConnectionString: true }) }), safeError('AUTH_FAILED'));
    assert.deepEqual(events, ['before', 'put', method, 'put']);
    assert.equal(local.state.record?.authPending?.auth, 'auto');
    assert.throws(() => service.effectiveConfig(), safeError('AUTH_REQUIRED'));
    await assert.rejects(service.readCredential(REF), safeError('AUTH_REQUIRED'));
  }
});

test('local persistence failure after credential change leaves runtime stopped and exposes no provider diagnostics', async () => {
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  local.state.failAt = 2;
  const credentials = fakeCredentials(events);
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
    onBeforeChange: async () => { events.push('before'); }, onChange: async () => { events.push('change'); },
  });
  await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }), safeError('AZURE_OPERATION_FAILED'));
  assert.deepEqual(events, ['before', 'put', 'set', 'put', 'put']);
  assert.equal(credentials.state.value, SECRET);
  assert.ok(local.state.record?.authPending);
  assert.throws(() => service.effectiveConfig(), safeError('AUTH_REQUIRED'));
  await assert.rejects(service.readCredential(REF), safeError('AUTH_REQUIRED'));
});

test('post-write metadata failure occurs before restart and remains failclosed', async () => {
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  const credentials = fakeCredentials(events);
  credentials.state.onSet = async () => { credentials.state.fail = 'describe'; };
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
    onBeforeChange: async () => { events.push('before'); }, onChange: async () => { events.push('change'); },
  });
  await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }), safeError('AUTH_FAILED'));
  assert.deepEqual(events, ['before', 'put', 'set', 'put']);
  assert.equal(local.state.record?.authPending?.auth, 'auto');
  assert.equal((await service.get()).authPending, true);
  assert.equal((await service.get()).connection.available, false);
});

test('provider commit notifications cannot boot new secrets with old config when the final settings commit fails', async () => {
  const local = fakeLocal({ defaultEnabled: false, pullOnStartup: true, pollSeconds: 300, auth: 'azure-cli', accountName: 'oldaccount' });
  const credentials = fakeCredentials();
  let changes = 0;
  let notified = 0;
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider, onChange: async () => { changes++; } });
  local.state.failAt = 2;
  credentials.state.onSet = async () => {
    notified++;
    assert.equal(local.state.record?.auth, 'azure-cli');
    assert.equal(local.state.record?.authPending?.auth, 'connection-string');
    assert.equal(local.state.record?.authPending?.accountName, 'account456');
    assert.throws(() => service.effectiveConfig(), safeError('AUTH_REQUIRED'));
    await assert.rejects(service.readCredential(REF), safeError('AUTH_REQUIRED'));
    // A notification or host restart gets a new instance, with no memory latch.
    const observer = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
    assert.throws(() => observer.effectiveConfig(), safeError('AUTH_REQUIRED'));
    await assert.rejects(observer.readCredential(REF), safeError('AUTH_REQUIRED'));
    assert.equal((await observer.get()).authPending, true);
  };
  await assert.rejects(service.setAuth({ auth: 'connection-string', accountName: 'account456', connectionString: SECRET }), safeError('AZURE_OPERATION_FAILED'));
  assert.equal(notified, 1);
  assert.equal(changes, 0);
  const nonce = local.state.record?.authPending?.id;
  assert.ok(nonce);
  const restarted = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider, onChange: async () => { changes++; } });
  const pending = await restarted.get();
  assert.equal(pending.auth, 'azure-cli');
  assert.equal(pending.accountName, 'oldaccount');
  assert.equal(pending.authPending, true);
  assert.deepEqual(pending.pendingAuth, { auth: 'connection-string', accountName: 'account456', managedIdentityClientId: '' });
  assert.ok(!JSON.stringify(pending).includes(SECRET));
  assert.throws(() => restarted.effectiveConfig(), safeError('AUTH_REQUIRED'));
  await assert.rejects(restarted.readCredential(REF), safeError('AUTH_REQUIRED'));
  await restarted.setDefaults({ pollSeconds: 60 });
  assert.equal(local.state.record?.authPending?.id, nonce);
  assert.equal(changes, 0);
  for (const auth of ['auto', 'connection-string'] as const) await assert.rejects(restarted.setAuth({ auth }), safeError('AUTH_REQUIRED'));
  credentials.state.onSet = undefined;
  const accepted = await restarted.setAuth({ auth: 'connection-string', connectionString: SECRET });
  assert.equal(accepted.authPending, false);
  assert.equal(accepted.accountName, 'account456');
  assert.equal(accepted.pollSeconds, 60);
  assert.equal(local.state.record?.authPending, undefined);
  assert.notEqual(local.state.record?.authGeneration, nonce);
  assert.equal(changes, 1);
});

test('a final settings put that commits then throws is re-marked pending rather than accepted silently', async () => {
  const local = fakeLocal();
  local.state.commitThenFailAt = 2;
  const credentials = fakeCredentials();
  let changed = false;
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider, onChange: async () => { changed = true; } });
  await assert.rejects(service.setAuth({ auth: 'connection-string', connectionString: SECRET }), safeError('AZURE_OPERATION_FAILED'));
  assert.equal(changed, false);
  assert.ok(local.state.record?.authPending);
  assert.equal(local.state.record?.authGeneration, local.state.record?.authPending?.id);
  const restarted = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
  assert.throws(() => restarted.effectiveConfig(), safeError('AUTH_REQUIRED'));
  await assert.rejects(restarted.readCredential(REF), safeError('AUTH_REQUIRED'));
});

test('failure to save the pending intent never touches credentials and leaves this process failclosed', async () => {
  const local = fakeLocal();
  local.state.fail = true;
  const credentials = fakeCredentials();
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
  await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }), safeError('AZURE_OPERATION_FAILED'));
  assert.equal(credentials.state.value, undefined);
  assert.equal(local.state.record, undefined);
  assert.equal((await service.get()).authPending, true);
  assert.throws(() => service.effectiveConfig(), safeError('AUTH_REQUIRED'));
  await assert.rejects(service.readCredential(REF), safeError('AUTH_REQUIRED'));
  local.state.fail = false;
  await service.setDefaults({ pollSeconds: 60 });
  assert.ok(local.local.getSettings()?.authPending);
});

test('explicit CLI or managed-identity recovery never reads an uncertain dormant secret or reuses it later', async () => {
  for (const auth of ['azure-cli', 'managed-identity'] as const) {
    const events: string[] = [];
    const local = fakeLocal(undefined, events);
    const credentials = fakeCredentials(events);
    credentials.state.fail = 'set';
    const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
    await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }), safeError('AUTH_FAILED'));
    credentials.state.fail = undefined;
    events.length = 0;
    const view = await service.setAuth({ auth });
    assert.equal(view.authPending, false);
    assert.equal(view.connection.requiresUpdate, true);
    assert.equal(service.effectiveConfig().auth, auth);
    assert.equal(local.state.record?.connectionUncertain, true);
    assert.ok(!events.some(event => ['resolve', 'set', 'unset'].includes(event)));
    await assert.rejects(service.readCredential(REF), safeError('AUTH_REQUIRED'));
    await assert.rejects(service.setAuth({ auth: 'auto' }), safeError('AUTH_REQUIRED'));
    const restarted = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
    await assert.rejects(restarted.setAuth({ auth: 'connection-string' }), safeError('AUTH_REQUIRED'));
    const cleared = await restarted.setAuth({ auth: 'auto', clearConnectionString: true });
    assert.equal(cleared.authPending, false);
    assert.equal(cleared.connection.requiresUpdate, undefined);
    assert.equal(local.state.record?.connectionUncertain, undefined);
    assert.equal(await restarted.readCredential(REF), undefined);
  }
});

test('ambient recovery can ignore an unavailable optional credentials provider without adopting its secret', async () => {
  const local = fakeLocal();
  const credentials = fakeCredentials();
  credentials.state.fail = 'set';
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
  await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }), safeError('AUTH_FAILED'));
  credentials.state.fail = 'describe';
  const recovered = await service.setAuth({ auth: 'azure-cli' });
  assert.equal(recovered.authPending, false);
  assert.equal(recovered.connection.available, false);
  assert.equal(recovered.connection.requiresUpdate, true);
  assert.equal(service.effectiveConfig().auth, 'azure-cli');
  await assert.rejects(service.readCredential(REF), safeError('AUTH_REQUIRED'));
});

test('pending auth schema accepts only validated nonsecret targets and UUID generation tokens', () => {
  const base = { defaultEnabled: false, pullOnStartup: true, pollSeconds: 300 };
  const intent = { id: '11111111-2222-4333-8444-555555555555', auth: 'auto', accountName: 'account123', managedIdentityClientId: '', startedAt: 1 };
  assert.equal(localSettingsSchema.safeParse({ ...base, authPending: intent }).success, true);
  for (const update of [{ connectionString: SECRET }, { id: SECRET }, { accountName: SECRET }, { managedIdentityClientId: SECRET }, { startedAt: -1 }]) {
    assert.equal(localSettingsSchema.safeParse({ ...base, authPending: { ...intent, ...update } }).success, false);
  }
  assert.equal(localSettingsSchema.safeParse({ ...base, authGeneration: SECRET }).success, false);
});

test('auth cancellation at intent, metadata, final commit, and restart boundaries preserves the durable guard', async () => {
  for (const stage of ['intent', 'metadata', 'final', 'restart']) {
    const local = fakeLocal();
    const credentials = fakeCredentials();
    const abort = new AbortController();
    let changes = 0;
    local.state.onPut = async (_record, count) => {
      if ((stage === 'intent' && count === 1) || (stage === 'final' && count === 2)) abort.abort(SECRET);
    };
    credentials.state.onDescribe = async count => { if (stage === 'metadata' && count === 2) abort.abort(SECRET); };
    const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
      onChange: async () => { changes++; if (stage === 'restart') abort.abort(SECRET); },
    });
    await assert.rejects(service.setAuth({ auth: 'connection-string', connectionString: SECRET }, abort.signal), safeError('CANCELLED'));
    assert.equal(changes, stage === 'restart' ? 1 : 0);
    assert.equal(credentials.state.value, stage === 'intent' ? undefined : SECRET);
    assert.ok(local.state.record?.authPending);
    const restarted = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
    assert.equal((await restarted.get()).authPending, true);
    assert.throws(() => restarted.effectiveConfig(), safeError('AUTH_REQUIRED'));
    await assert.rejects(restarted.readCredential(REF), safeError('AUTH_REQUIRED'));
  }
});

test('a credential read spanning a successful auth generation change rejects instead of returning a mixed-generation secret', async () => {
  const local = fakeLocal();
  const credentials = fakeCredentials();
  const entered = gate();
  const released = gate();
  credentials.state.onResolve = async () => { entered.release(); await released.promise; };
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
  const reading = service.readCredential(REF);
  const rejected = assert.rejects(reading, safeError('AUTH_REQUIRED'));
  await entered.promise;
  await service.setAuth({ auth: 'connection-string', connectionString: SECRET });
  released.release();
  await rejected;
  credentials.state.onResolve = undefined;
  assert.equal(await service.readCredential(REF), SECRET);
});

test('a replaced auth intent nonce cannot be finalized or overwritten by a stale operation', async () => {
  const local = fakeLocal();
  const credentials = fakeCredentials();
  const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  credentials.state.onSet = async () => {
    local.state.record = { ...local.state.record!, authPending: { ...local.state.record!.authPending!, id: other } };
  };
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
  await assert.rejects(service.setAuth({ auth: 'connection-string', connectionString: SECRET }), safeError('AUTH_REQUIRED'));
  assert.equal(local.state.record?.authPending?.id, other);
  assert.equal(local.state.record?.authGeneration, undefined);
});

test('auth restart failure re-marks the accepted generation pending and stops the partial runtime', async () => {
  const local = fakeLocal();
  const credentials = fakeCredentials();
  let stops = 0;
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
    onBeforeChange: async () => { stops++; }, onChange: async () => { throw new Error(SECRET); },
  });
  await assert.rejects(service.setAuth({ auth: 'connection-string', connectionString: SECRET }), safeError('AZURE_OPERATION_FAILED'));
  assert.equal(stops, 2);
  assert.ok(local.state.record?.authPending);
  assert.equal(local.state.record?.authGeneration, local.state.record?.authPending?.id);
  assert.equal(credentials.state.value, SECRET);
  const restarted = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider });
  assert.throws(() => restarted.effectiveConfig(), safeError('AUTH_REQUIRED'));
});

test('restart failure attempts to stop a partial new runtime and keeps durable settings', async () => {
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  const service = new SettingsService({ local: local.local, config: config(),
    onBeforeChange: async () => { events.push('before'); }, onChange: async () => { events.push('change'); throw new Error(SECRET); },
  });
  await assert.rejects(service.setDefaults({ pollSeconds: 60 }), safeError('AZURE_OPERATION_FAILED'));
  assert.deepEqual(events, ['before', 'put', 'change', 'before']);
  assert.equal(local.state.record?.pollSeconds, 60);
});

test('pre-aborted updates ignore arbitrary abort reasons and perform no work', async () => {
  const local = fakeLocal();
  const service = new SettingsService({ local: local.local, config: config() });
  const abort = new AbortController();
  abort.abort(new Error(SECRET));
  await assert.rejects(service.setAuth({ auth: 'azure-cli' }, abort.signal), safeError('CANCELLED'));
  await assert.rejects(service.setDefaults({ pollSeconds: 30 }, abort.signal), safeError('CANCELLED'));
  assert.equal(local.state.record, undefined);
});

test('abort while draining prevents credential and settings writes', async () => {
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  const credentials = fakeCredentials(events);
  const abort = new AbortController();
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
    onBeforeChange: async () => { events.push('before'); abort.abort(SECRET); }, onChange: async () => { events.push('change'); },
  });
  await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }, abort.signal), safeError('CANCELLED'));
  assert.deepEqual(events, ['before']);
});

test('abort after credential commit does not restart or falsely roll back the committed secret', async () => {
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  const credentials = fakeCredentials(events);
  const abort = new AbortController();
  credentials.state.onSet = async () => { abort.abort(SECRET); };
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
    onBeforeChange: async () => { events.push('before'); }, onChange: async () => { events.push('change'); },
  });
  await assert.rejects(service.setAuth({ auth: 'auto', connectionString: SECRET }, abort.signal), safeError('CANCELLED'));
  assert.deepEqual(events, ['before', 'put', 'set', 'put']);
  assert.equal(credentials.state.value, SECRET);
  assert.ok(local.state.record?.authPending);
  assert.throws(() => service.effectiveConfig(), safeError('AUTH_REQUIRED'));
});

test('abort after local commit leaves durable settings stopped; abort during restart stops the rebuilt runtime', async () => {
  for (const stage of ['put', 'change']) {
    const events: string[] = [];
    const local = fakeLocal(undefined, events);
    const abort = new AbortController();
    if (stage === 'put') local.state.onPut = async () => { abort.abort(SECRET); };
    const service = new SettingsService({ local: local.local, config: config(),
      onBeforeChange: async () => { events.push('before'); }, onChange: async () => { events.push('change'); if (stage === 'change') abort.abort(SECRET); },
    });
    await assert.rejects(service.setDefaults({ pollSeconds: 60 }, abort.signal), safeError('CANCELLED'));
    assert.deepEqual(events, stage === 'put' ? ['before', 'put'] : ['before', 'put', 'change', 'before']);
    assert.equal(local.state.record?.pollSeconds, 60);
  }
});

test('concurrent auth/default updates serialize and queued cancellation cannot lose the other update', async () => {
  const entered = gate();
  const release = gate();
  const events: string[] = [];
  const local = fakeLocal(undefined, events);
  const credentials = fakeCredentials(events);
  credentials.state.onSet = async () => { entered.release(); await release.promise; };
  const service = new SettingsService({ local: local.local, config: config(), credentials: credentials.provider,
    onBeforeChange: async () => { events.push('before'); }, onChange: async () => { events.push('change'); },
  });
  const first = service.setAuth({ auth: 'connection-string', connectionString: SECRET });
  await entered.promise;
  const abort = new AbortController();
  const second = service.setDefaults({ pullOnStartup: false, pollSeconds: 60 }, abort.signal);
  const rejected = assert.rejects(second, safeError('CANCELLED'));
  abort.abort(SECRET);
  const third = service.setDefaults({ pollSeconds: 90 });
  release.release();
  await first;
  await rejected;
  const view = await third;
  assert.equal(view.auth, 'connection-string');
  assert.equal(view.pollSeconds, 90);
  assert.equal(view.pullOnStartup, true);
  assert.deepEqual(events, ['before', 'put', 'set', 'put', 'change', 'before', 'put', 'change']);
});

test('a failed update does not poison the queue and invalid local settings never leak into config', async () => {
  const local = fakeLocal();
  local.state.fail = true;
  const service = new SettingsService({ local: local.local, config: config() });
  await assert.rejects(service.setDefaults({ pollSeconds: 60 }), safeError('AZURE_OPERATION_FAILED'));
  local.state.fail = false;
  assert.equal((await service.setDefaults({ pollSeconds: 90 })).pollSeconds, 90);
  local.state.record = { ...local.state.record!, connectionString: SECRET } as LocalSettingsRecord;
  assert.throws(() => service.effectiveConfig(), safeError('INVALID_CONFIG'));
});

test('real local-domain reopen preserves nonsecret settings while no secret enters domain files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'azure-settings-'));
  const resources: Array<{ store: LocalStore; facility: DomainFacility; backend: JsonStorageBackend }> = [];
  t.after(async () => {
    for (const resource of resources) {
      await resource.store.close();
      await resource.facility.closeAll();
      await resource.backend.close();
    }
    // root is the verified mkdtemp directory created above, not a computed user path.
    await rm(root, { recursive: true, force: true });
  });
  async function open() {
    const host = new Context();
    new Storage(host);
    const backend = new JsonStorageBackend(resolve(root, 'data'));
    host.storage.backend.register('fixture-json', backend);
    const facility = new DomainFacility(host, { backend: 'fixture-json' });
    const store = new LocalStore(facility);
    await store.open();
    const resource = { store, facility, backend };
    resources.push(resource);
    return resource;
  }
  const legacy = await open();
  await legacy.store.putSettings({ defaultEnabled: true, pullOnStartup: true, pollSeconds: 100_000 });
  await legacy.store.close();
  await legacy.facility.closeAll();
  await legacy.backend.close();
  const first = await open();
  assert.equal(first.store.getSettings()?.defaultEnabled, true);
  assert.equal(first.store.getSettings()?.pollSeconds, 100_000);
  const credentials = fakeCredentials();
  let failFinal = true;
  const failingLocal = {
    getSettings: () => first.store.getSettings(),
    async putSettings(record: LocalSettingsRecord) {
      if (record.authPending === undefined && record.authGeneration !== undefined && failFinal) {
        failFinal = false;
        throw new Error(SECRET);
      }
      await first.store.putSettings(record);
    },
  } as unknown as LocalStore;
  const service = new SettingsService({ local: failingLocal, config: config({ defaultEnabled: true }), credentials: credentials.provider, now: () => 456 });
  assert.equal(service.effectiveConfig().defaultEnabled, false);
  assert.equal(service.effectiveConfig().pollSeconds, 86_400);
  assert.equal((await service.get()).defaultEnabled, false);
  assert.equal((await service.get()).pollSeconds, 86_400);
  await assert.rejects(service.setAuth({ auth: 'connection-string', accountName: 'account456', connectionString: SECRET }), safeError('AZURE_OPERATION_FAILED'));
  assert.equal(first.store.getSettings()?.defaultEnabled, false);
  assert.equal(first.store.getSettings()?.pollSeconds, 86_400);
  const pendingId = first.store.getSettings()?.authPending?.id;
  assert.ok(pendingId);
  await first.store.close();
  await first.facility.closeAll();
  await first.backend.close();
  const second = await open();
  const recovering = new SettingsService({ local: second.store, config: config(), credentials: credentials.provider, now: () => 456 });
  assert.equal((await recovering.get()).authPending, true);
  assert.equal(second.store.getSettings()?.authPending?.id, pendingId);
  assert.throws(() => recovering.effectiveConfig(), safeError('AUTH_REQUIRED'));
  await assert.rejects(recovering.readCredential(REF), safeError('AUTH_REQUIRED'));
  await recovering.setDefaults({ pullOnStartup: false, pollSeconds: 45 });
  assert.equal(second.store.getSettings()?.authPending?.id, pendingId);
  await recovering.setAuth({ auth: 'connection-string', connectionString: SECRET });
  assert.notEqual(second.store.getSettings()?.authGeneration, pendingId);
  await second.store.close();
  await second.facility.closeAll();
  await second.backend.close();
  const third = await open();
  const reopened = new SettingsService({ local: third.store, config: config(), credentials: credentials.provider });
  const view = await reopened.get();
  assert.equal(view.authPending, false);
  assert.equal(view.auth, 'connection-string');
  assert.equal(view.accountName, 'account456');
  assert.equal(view.pollSeconds, 45);
  assert.equal(view.pullOnStartup, false);
  assert.equal(view.defaultEnabled, false);
  assert.equal(view.updatedAt, 456);
  assert.equal(await reopened.readCredential(REF), SECRET);
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  for (const file of files) {
    if (!file.isFile()) continue;
    const contents = await readFile(join(file.parentPath, file.name), 'utf8');
    assert.ok(!contents.includes(SECRET));
    assert.ok(!contents.includes('c2VjcmV0a2V5'));
  }
});
