import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as AzurePlugin from '../src/index.js';
import { Config } from '../src/config.js';
import { localDomain } from '../src/local/store.js';
import { localSessionRecordSchema } from '../src/schema.js';
import { AcceptanceCloud, acceptanceDevice, type AcceptanceDevice } from './acceptance-helpers.js';
import { localSession } from './helpers.js';

test('actual plugin startup with missing credentials rejects persisted opted-in direct AgentLoop input while explicit off remains executable', { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'azure-startup-admission-')));
  const cloud = new AcceptanceCloud();
  const devices: AcceptanceDevice[] = [];
  let scope: ReturnType<AcceptanceDevice['ctx']['plugin']> | undefined;
  t.after(async () => {
    await scope?.dispose();
    for (const device of devices.reverse()) await device.close();
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: false });
  });

  const enabledId = `session-enabled-${randomUUID()}`;
  const offId = `session-off-${randomUUID()}`;
  const original = await acceptanceDevice(join(root, 'host'), 'device-a', cloud); devices.push(original);
  const firstAgent = await original.create(enabledId);
  firstAgent.session.append('session/title', { title: 'Credentials lost after host restart', messageSeqs: [], source: { kind: 'user' } });
  await original.uploader.markEnabled(enabledId);
  assert.equal((await original.uploader.sync(enabledId, { release: true })).status, 'synced');
  const originalOff = await original.create(offId);
  originalOff.session.append('session/title', { title: 'Explicit local-only session', messageSeqs: [], source: { kind: 'user' } });
  await original.ctx.sessionPersistence.flush();
  await original.local.putSession(localSession({ sessionId: offId, enabled: false, detached: true, status: 'detached', state: 'disabled' }));
  await original.close();

  // Recreate the host over the same real JSONL/domain roots. Then hand the
  // public fixture facility to the actual plugin; no private LocalStore fields,
  // fake Agent, manually registered lifecycle, or ownership helper is used.
  const host = await acceptanceDevice(join(root, 'host'), 'device-a', cloud); devices.push(host);
  assert.equal(host.local.getSession(enabledId)?.enabled, true);
  assert.equal(host.local.getSession(offId)?.enabled, false);
  const enabledAgent = await host.resume(enabledId);
  const offAgent = await host.resume(offId);
  await host.service.close();
  await host.local.close();
  host.ctx.provide('storageDomain', host.facility);
  const missingRef = `AZURE_TEST_MISSING_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  assert.equal(process.env[missingRef], undefined);
  scope = host.ctx.plugin(AzurePlugin, Config({ auth: 'connection-string', connectionRef: missingRef }));
  await scope.await();
  assert.equal(scope.state, 2, 'missing setup is a contained plugin startup failure, not an inactive fixture');

  const writes = host.writeOpens;
  const cloudBefore = await cloud.getManifest(enabledId);
  const blocked = host.prompt('Cloud sync is still enabled; missing credentials must not authorize execution.');
  enabledAgent.send(blocked, 'next-turn', true);
  await enabledAgent.whenIdle();
  await host.ctx.sessionPersistence.flush();
  assert.equal(host.llmCalls, 0, 'always-on admission protects persisted enabled sessions before auth/runtime boot succeeds');
  assert.deepEqual(enabledAgent.inbox.nextTurn.map(message => message.id), [blocked.id]);
  const domain = host.facility.get(localDomain.name); assert.ok(domain);
  const record = localSessionRecordSchema.parse(domain.table('sessions').get(enabledId));
  assert.equal(record.enabled, true, 'setup failure never silently opts out the tracked thread');
  assert.equal(record.status, 'ownership-unverified');
  assert.equal(record.admissionReceipt?.reason, 'ownership-unverified');
  assert.deepEqual(record.admissionReceipt?.messageIds, [blocked.id]);
  assert.equal(host.writeOpens, writes, 'the retained Agent is still the only local writer');
  assert.deepEqual(await cloud.getManifest(enabledId), cloudBefore);

  const allowed = host.prompt('This thread is explicitly off and may continue locally.');
  offAgent.send(allowed, 'next-turn', true);
  await offAgent.whenIdle();
  await host.ctx.sessionPersistence.flush();
  assert.equal(host.llmCalls, 1, 'the same real AgentLoop/LLM pipeline remains executable for an ordinary off session');
  assert.equal(offAgent.inbox.nextTurn.length, 0);
  assert.deepEqual(enabledAgent.inbox.nextTurn.map(message => message.id), [blocked.id], 'unrelated local work does not consume the blocked prompt');
  const events = (await host.source.read(offId))?.events; assert.ok(events);
  assert.equal(events.filter(value => value.type === 'user/message' && value.data.id === allowed.id).length, 1);
  assert.equal(host.writeOpens, writes);
});
