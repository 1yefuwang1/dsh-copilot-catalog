import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, endpointsFor, resolveConfig } from '../src/config.js';

test('defaults are safe and side-effect free', () => {
  const config = Config({});
  assert.equal(config.auth, 'auto');
  assert.equal(config.connectionRef, 'DSH_AZURE_SYNC_CONNECTION');
  assert.equal(config.accountName, '');
  assert.equal(config.container, 'dsh-state');
  assert.equal(config.table, 'dshstatesync');
  assert.equal(config.allowInsecure, false);
  assert.equal(config.defaultEnabled, false);
  assert.equal(config.pullOnStartup, true);
  assert.equal(config.pollSeconds, 30);
  assert.equal(config.ownershipProofMs, 5_000);
  assert.equal(config.maxBatchEvents, 1_000);
  assert.equal(config.maxBatchBytes, 3_145_728);
  assert.equal(config.maxAttachmentBytes, 104_857_600);
});

test('storage names and numeric bounds are validated before use', () => {
  assert.throws(() => Config({ container: 'Bad_Name' }), /container/u);
  assert.throws(() => Config({ container: 'ab' }), /container/u);
  assert.throws(() => Config({ container: 'a--b' }), /container/u);
  assert.throws(() => Config({ table: '1bad' }), /table/u);
  assert.throws(() => Config({ table: 'bad name' }), /table/u);
  assert.throws(() => Config({ auth: 'bogus' as never }), /auth/u);
  assert.throws(() => Config({ pollSeconds: 0 }), /pollSeconds/u);
  assert.throws(() => Config({ maxBatchEvents: 0 }), /maxBatchEvents/u);
  assert.throws(() => Config({ ownershipProofMs: 100 }), /ownershipProofMs/u);
});

test('token endpoints are derived only from a valid account name', () => {
  assert.equal(endpointsFor(Config({})), undefined);
  assert.deepEqual(endpointsFor(Config({ accountName: 'acctest' })), {
    blob: 'https://acctest.blob.core.windows.net',
    table: 'https://acctest.table.core.windows.net',
  });
  assert.deepEqual(endpointsFor(Config({ accountName: 'acctest', endpointSuffix: 'core.chinacloudapi.cn' })), {
    blob: 'https://acctest.blob.core.chinacloudapi.cn',
    table: 'https://acctest.table.core.chinacloudapi.cn',
  });
  assert.throws(() => Config({ accountName: 'ACCTEST' }), /accountName/u);
});

test('resolveConfig reapplies defaults without changing explicit values', () => {
  const config = resolveConfig(Config({ container: 'custom-state', pollSeconds: 60 }));
  assert.equal(config.container, 'custom-state');
  assert.equal(config.pollSeconds, 60);
  assert.equal(config.table, 'dshstatesync');
  assert.equal(resolveConfig(Config({ pollSeconds: 300 })).pollSeconds, 300, 'explicit slower polling remains supported');
});
