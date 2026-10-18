import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TokenCredential } from '@azure/core-auth';
import { Config } from '../src/config.js';
import { createBlobServiceClient, createTableClient, redactConnectionString, resolveAuth } from '../src/auth.js';
import { AzureSyncError } from '../src/azure/errors.js';

const accountKey = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const secure = `DefaultEndpointsProtocol=https;AccountName=acctest;AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
const insecure = `DefaultEndpointsProtocol=http;AccountName=acctest;AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
const fakeToken = 'synthetic-token';
const fakeCredential = { getToken: async () => ({ token: fakeToken, expiresOnTimestamp: Date.now() + 60_000 }) } as unknown as TokenCredential;

function hasCode(code: string) {
  return (error: unknown) => error instanceof AzureSyncError && error.code === code;
}

test('connection-string auth is read from the configured credential reference', async () => {
  const auth = await resolveAuth(Config({ auth: 'connection-string' }), { readCredential: async (ref) => {
    assert.equal(ref, 'DSH_AZURE_SYNC_CONNECTION');
    return secure;
  } });
  assert.equal(auth.kind, 'connection-string');
  if (auth.kind === 'connection-string') assert.equal(auth.connectionString, secure);
});

test('auto prefers a configured connection string and otherwise falls back to DefaultAzureCredential', async () => {
  const withString = await resolveAuth(Config({ auth: 'auto' }), { readCredential: async () => secure });
  assert.equal(withString.kind, 'connection-string');
  const withToken = await resolveAuth(Config({ auth: 'auto', accountName: 'acctest' }), {
    readCredential: async () => undefined,
    defaultCredential: () => fakeCredential,
  });
  assert.equal(withToken.kind, 'token');
  if (withToken.kind === 'token') assert.equal(withToken.credential, fakeCredential);
});

test('explicit CLI and managed-identity modes use their credentials', async () => {
  const cli = await resolveAuth(Config({ auth: 'azure-cli', accountName: 'acctest' }), { azureCli: () => fakeCredential });
  assert.equal(cli.kind, 'token');
  const managed = await resolveAuth(Config({ auth: 'managed-identity', accountName: 'acctest', managedIdentityClientId: 'client-id' }), {
    managedIdentity: (clientId) => { assert.equal(clientId, 'client-id'); return fakeCredential; },
  });
  assert.equal(managed.kind, 'token');
});

test('missing setup and insecure endpoints are explicit failures', async () => {
  await assert.rejects(resolveAuth(Config({ auth: 'connection-string' }), { readCredential: async () => undefined }), hasCode('AUTH_REQUIRED'));
  await assert.rejects(resolveAuth(Config({ auth: 'auto' }), { readCredential: async () => undefined }), hasCode('ACCOUNT_REQUIRED'));
  await assert.rejects(resolveAuth(Config({ auth: 'connection-string' }), { readCredential: async () => insecure }), hasCode('INSECURE_ENDPOINT'));
  const allowed = await resolveAuth(Config({ auth: 'connection-string', allowInsecure: true }), { readCredential: async () => insecure });
  assert.equal(allowed.kind, 'connection-string');
  await assert.rejects(resolveAuth(Config({ auth: 'connection-string' }), { readCredential: async () => 'UseDevelopmentStorage=true' }), hasCode('INSECURE_ENDPOINT'));
  const dev = await resolveAuth(Config({ auth: 'connection-string', allowInsecure: true }), { readCredential: async () => 'UseDevelopmentStorage=true' });
  assert.equal(dev.kind, 'connection-string');
  const devBlob = createBlobServiceClient(Config({ auth: 'connection-string', allowInsecure: true }), dev);
  assert.match(devBlob.url, /^http:\/\/127\.0\.0\.1:10000\/devstoreaccount1/u);
  const devTable = createTableClient(Config({ auth: 'connection-string', allowInsecure: true }), dev);
  assert.match(devTable.url, /^http:\/\/127\.0\.0\.1:10002\/devstoreaccount1/u);
  const mixed = `DefaultEndpointsProtocol=https;BlobEndpoint=https://acctest.blob.core.windows.net;TableEndpoint=http://acctest.table.core.windows.net;AccountName=acctest;AccountKey=${accountKey}`;
  await assert.rejects(resolveAuth(Config({ auth: 'connection-string' }), { readCredential: async () => mixed }), hasCode('INSECURE_ENDPOINT'));
  const mixedAllowed = await resolveAuth(Config({ auth: 'connection-string', allowInsecure: true }), { readCredential: async () => mixed });
  assert.equal(mixedAllowed.kind, 'connection-string');
  assert.equal(createTableClient(Config({ auth: 'connection-string', allowInsecure: true }), mixedAllowed).tableName, 'dshstatesync');
});

test('clients are constructed without network work and use the configured endpoints/table', async () => {
  const auth = await resolveAuth(Config({ auth: 'connection-string', table: 'dshstatesync' }), { readCredential: async () => secure });
  const blob = createBlobServiceClient(Config({ auth: 'connection-string' }), auth);
  assert.match(blob.url, /^https:\/\/acctest\.blob\.core\.windows\.net\/?$/u);
  const table = createTableClient(Config({ auth: 'connection-string', table: 'dshstatesync' }), auth);
  assert.equal(table.tableName, 'dshstatesync');
  assert.match(table.url, /^https:\/\/acctest\.table\.core\.windows\.net\/?$/u);
});

test('connection strings are redacted from diagnostics', () => {
  const redacted = redactConnectionString(secure);
  assert.doesNotMatch(redacted, new RegExp(accountKey, 'u'));
  assert.match(redacted, /AccountKey=\*\*\*/u);
  assert.match(redactConnectionString(`${secure};SharedAccessSignature=synthetic-signature`), /SharedAccessSignature=\*\*\*/u);
});
