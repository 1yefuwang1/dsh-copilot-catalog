import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { LocalStore, localDomain } from '../src/local/store.js';
import { pathMapping, localSession } from './helpers.js';

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-local-'));
  const host = new Context();
  new Storage(host);
  const backend = new JsonStorageBackend(resolve(root, 'data'));
  host.storage.backend.register('fixture-json', backend);
  const facility = new DomainFacility(host, { backend: 'fixture-json' });
  const store = new LocalStore(facility);
  await store.open();
  return { root, host, backend, facility, store };
}

test('the local domain is version 4 and persists sessions, mappings, device, and settings', async (t) => {
  assert.equal(localDomain.name, 'dsh_azure_sync');
  assert.equal(localDomain.version, 4);
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const session = localSession({ sessionId: 'session-local' });
  const mapping = pathMapping({ remotePrefix: '/remote/project', localPrefix: '/local/project' });
  await f.store.putSession(session);
  await f.store.putMapping(mapping);
  await f.store.putDevice({ deviceId: 'device-a', name: 'A', platform: 'linux', firstSeen: 1 });
  await f.store.putSettings({ defaultEnabled: false, pullOnStartup: true, pollSeconds: 300 });

  assert.deepEqual(f.store.getSession('session-local'), session);
  assert.deepEqual(f.store.getMapping(mapping.id), mapping);
  assert.equal(f.store.getDevice()?.name, 'A');
  assert.equal(f.store.getSettings()?.pollSeconds, 300);
  assert.equal([...f.store.listSessions()].length, 1);
  assert.equal([...f.store.listMappings()].length, 1);
});

test('the local domain reopens durably and rejects invalid records', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  await f.store.putSession(localSession({ sessionId: 'session-reopen' }));
  await f.store.close();
  await f.facility.closeAll();
  await f.backend.close();

  const host = new Context();
  new Storage(host);
  const backend = new JsonStorageBackend(resolve(f.root, 'data'));
  host.storage.backend.register('fixture-json', backend);
  const facility = new DomainFacility(host, { backend: 'fixture-json' });
  const store = new LocalStore(facility);
  await store.open();
  assert.equal(store.getSession('session-reopen')?.sessionId, 'session-reopen');
  await assert.rejects(store.putSession({ ...localSession(), status: 'bogus' as never }), (error: unknown) => error instanceof Error && error.name === 'AzureSyncError' && (error as { code?: string }).code === 'INVALID_RECORD');
  await store.close();
  await facility.closeAll();
  await backend.close();
});
