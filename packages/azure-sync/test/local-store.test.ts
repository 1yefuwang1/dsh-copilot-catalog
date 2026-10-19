import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { DomainError, DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { LocalStore, localDomain } from '../src/local/store.js';
import { admitPreStep } from '../src/sync/admission.js';
import type { LocalSessionRecord } from '../src/schema.js';
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

test('session mutation reads the latest queued durable record and validates its result and identity', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const initial = localSession({ sessionId: 'session-mutate' });
  await f.store.putSession(initial);
  const latest = { ...initial, enabled: false, detached: true, admissionStopped: false, status: 'detached' as const };
  const pending = f.store.putSession(latest);
  assert.deepEqual(f.store.getSession(initial.sessionId), initial, 'pending durable I/O has not changed the read snapshot');
  let observed: LocalSessionRecord | undefined;
  const mutation = f.store.mutateSession(initial.sessionId, (current) => {
    observed = current;
    return { ...current, lastError: 'Latest record mutation.' };
  });
  await Promise.all([pending, mutation]);
  assert.deepEqual(observed, latest);
  const expected = { ...latest, lastError: 'Latest record mutation.' };
  assert.deepEqual(f.store.getSession(initial.sessionId), expected);

  for (const invalid of [
    { status: 'bogus' },
    { sessionId: 'different-session' },
    { enabled: undefined },
    { unknownPermission: true },
  ]) {
    await assert.rejects(f.store.mutateSession(initial.sessionId, (current) => ({ ...current, ...invalid }) as LocalSessionRecord),
      (error: unknown) => error instanceof Error && error.name === 'AzureSyncError' && (error as { code?: string }).code === 'INVALID_RECORD');
    assert.deepEqual(f.store.getSession(initial.sessionId), expected);
    assert.equal(f.store.getSession('different-session'), undefined);
  }
  const callbackError = new DomainError('missing-key', 'A callback failure must not be mistaken for a missing record.');
  await assert.rejects(f.store.mutateSession(initial.sessionId, () => { throw callbackError; }), (error) => error === callbackError);
  await f.store.mutateSession(initial.sessionId, (current) => ({ ...current, lastError: undefined }));
  assert.deepEqual(f.store.getSession(initial.sessionId), { ...latest, lastError: undefined }, 'failed mutations leave the write chain usable');
});

test('session mutation no-ops for missing and queued-deleted records without invoking the callback', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  let calls = 0;
  const transform = (current: LocalSessionRecord) => { calls++; return { ...current, enabled: true }; };
  await f.store.mutateSession('missing', transform);
  assert.equal(f.store.getSession('missing'), undefined);
  const initial = localSession({ sessionId: 'session-delete' });
  await f.store.putSession(initial);
  const domain = f.facility.get(localDomain.name);
  assert.ok(domain);
  const deletion = domain.table('sessions').delete(initial.sessionId);
  assert.deepEqual(f.store.getSession(initial.sessionId), initial, 'the public table delete is still queued');
  await Promise.all([deletion, f.store.mutateSession(initial.sessionId, transform)]);
  assert.equal(calls, 0);
  assert.equal(f.store.getSession(initial.sessionId), undefined);
  await f.store.close();
  await assert.rejects(f.store.mutateSession(initial.sessionId, transform), /local store is not open/);
});

for (const fallback of [false, true]) {
  test(`a real JSON-domain pending opt-out wins over a denied admission receipt (append fallback: ${fallback})`, async (t) => {
    const f = await fixture();
    t.after(async () => {
      await f.store.close();
      await f.facility.closeAll();
      await f.backend.close();
      await rm(f.root, { recursive: true, force: true });
    });
    const initial = localSession({ sessionId: 'session-off-race' });
    await f.store.putSession(initial);
    const off = { ...initial, enabled: false, detached: true, admissionStopped: false, state: 'disabled' as const, status: 'detached' as const };
    // Do not await: KvTable.put has enqueued the off write, but its read map is still enabled.
    const pendingOff = f.store.putSession(off);
    assert.deepEqual(f.store.getSession(initial.sessionId), initial);
    const prepends: string[] = [], appends: string[] = [];
    const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
    const admission = admitPreStep({
      sessionId: initial.sessionId, local: f.store, messages: messages as never, turn: 1, step: 2, now: () => 3,
      agent: { inbox: {
        prepend: (_target: string, message: { id: string }) => {
          if (fallback) throw new Error('inbox closed');
          prepends.push(message.id);
        },
        append: (_target: string, message: { id: string }) => { appends.push(message.id); },
      } } as never,
      ownership: async () => {
        assert.equal(f.store.getSession(initial.sessionId)?.enabled, true, 'the ownership proof races the still-pending off write');
        return { owned: false, reason: 'paused-other-device' };
      },
    });
    const [, result] = await Promise.all([pendingOff, admission]);
    assert.equal(result.kind, 'reject');
    const expected = {
      ...off,
      ...(fallback ? { lastError: 'Failed to prepend claimed messages back to next-turn; appended instead.' } : {}),
      admissionReceipt: { reason: 'paused-other-device', messageIds: ['m1', 'm2', 'm3'], turn: 1, step: 2, at: 3 },
    };
    assert.deepEqual(f.store.getSession(initial.sessionId), expected, 'the receipt cannot restore any stale permission or replace detached status');
    assert.deepEqual(prepends, fallback ? [] : ['m3', 'm2', 'm1']);
    assert.deepEqual(appends, fallback ? ['m1', 'm2', 'm3'] : []);
    await f.store.close();
    await f.facility.closeAll();
    await f.store.open();
    assert.deepEqual(f.store.getSession(initial.sessionId), expected, 'the safe opt-out and receipt are durable');
  });
}

test('a real JSON-domain delete queued during denied ownership cannot be undone by the receipt', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const initial = localSession({ sessionId: 'session-admission-delete' });
  await f.store.putSession(initial);
  const domain = f.facility.get(localDomain.name);
  assert.ok(domain);
  const deletion = domain.table('sessions').delete(initial.sessionId);
  const requeued: string[] = [];
  const admission = admitPreStep({
    sessionId: initial.sessionId, local: f.store, messages: [{ id: 'm1' }] as never, turn: 1, step: 1, now: () => 1,
    agent: { inbox: { prepend: (_target: string, message: { id: string }) => { requeued.push(message.id); } } } as never,
    ownership: async () => ({ owned: false, reason: 'paused-other-device' }),
  });
  const [, result] = await Promise.all([deletion, admission]);
  assert.equal(result.kind, 'reject');
  assert.equal(f.store.getSession(initial.sessionId), undefined);
  assert.deepEqual(requeued, ['m1']);
});

test('local permission transactions serialize first creation and newer opt-out across shared-store callers', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const id = 'session-permission-create';
  const enabled = localSession({ sessionId: id });
  const observations: (LocalSessionRecord | undefined)[] = [];
  const changes: unknown[] = [];
  f.host.on('domain/changed', (change) => {
    if (change.table === 'sessions' && change.key === id) changes.push(change.value);
  });
  // Separate closure owners model old/new runtime instances sharing this store.
  const oldEnable = () => f.store.transactSession(id, (current) => { observations.push(current); return enabled; });
  const newerOff = () => f.store.transactSession(id, (current) => {
    observations.push(current);
    return { ...(current ?? enabled), enabled: false, detached: true, admissionStopped: false, state: 'disabled', status: 'detached' };
  });
  const creating = oldEnable();
  const optingOut = newerOff();
  assert.equal(f.store.getSession(id), undefined, 'the first permission write is not durable yet');
  const [created, off] = await Promise.all([creating, optingOut]);
  assert.deepEqual(created, enabled);
  assert.deepEqual(observations, [undefined, enabled]);
  assert.ok(off);
  assert.equal(off.enabled, false);
  assert.equal(off.detached, true);
  assert.equal(off.admissionStopped, false);
  assert.equal(off.status, 'detached');
  assert.deepEqual(changes, [created, off], 'permission writes enter the SDK chain in caller order');
  assert.deepEqual(f.store.getSession(id), off);
  await f.store.close();
  await f.facility.closeAll();
  await f.store.open();
  assert.deepEqual(f.store.getSession(id), off, 'the newer opt-out wins durably');
});

for (const permissionLane of [false, true]) {
  test(`a guarded stale authorization sees the latest cancellation ID and does not write (permission lane: ${permissionLane})`, async (t) => {
    const f = await fixture();
    t.after(async () => {
      await f.store.close();
      await f.facility.closeAll();
      await f.backend.close();
      await rm(f.root, { recursive: true, force: true });
    });
    const initial = localSession({ sessionId: 'session-stale-authorization', resurrectionCancellationId: '11111111-1111-4111-8111-111111111111' });
    await f.store.putSession(initial);
    const stale = { ...initial, enabled: true, detached: false, admissionStopped: false, status: 'syncing' as const };
    const off = { ...initial, enabled: false, detached: true, admissionStopped: false, state: 'disabled' as const,
      status: 'detached' as const, resurrectionCancellationId: '22222222-2222-4222-8222-222222222222' };
    const changes: unknown[] = [];
    f.host.on('domain/changed', (change) => {
      if (change.table === 'sessions' && change.key === initial.sessionId) changes.push(change.value);
    });
    const pendingOff = permissionLane
      ? f.store.transactSession(initial.sessionId, () => off)
      : f.store.putSession(off);
    assert.deepEqual(f.store.getSession(initial.sessionId), initial, 'the read snapshot is still stale');
    let observed: LocalSessionRecord | undefined;
    const pendingEnable = f.store.transactSession(initial.sessionId, (current) => {
      observed = current;
      return current?.resurrectionCancellationId === stale.resurrectionCancellationId ? stale : undefined;
    });
    const [, enabled] = await Promise.all([pendingOff, pendingEnable]);
    assert.equal(enabled, undefined);
    assert.deepEqual(observed, off, 'the guard runs against SDK-current data rather than an earlier snapshot');
    assert.deepEqual(f.store.getSession(initial.sessionId), off);
    assert.deepEqual(changes, [off], 'undefined aborts the SDK update without an event or redundant write');
  });
}

test('permission transactions no-op on absent records and reevaluate a queued deletion as absent', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const seen: (LocalSessionRecord | undefined)[] = [];
  const noChange = (current: LocalSessionRecord | undefined) => { seen.push(current); return undefined; };
  assert.equal(await f.store.transactSession('missing-permission', noChange), undefined);
  assert.equal(f.store.getSession('missing-permission'), undefined);
  const initial = localSession({ sessionId: 'session-permission-delete' });
  await f.store.putSession(initial);
  const domain = f.facility.get(localDomain.name);
  assert.ok(domain);
  const deletion = domain.table('sessions').delete(initial.sessionId);
  const transaction = f.store.transactSession(initial.sessionId, noChange);
  await Promise.all([deletion, transaction]);
  assert.deepEqual(seen, [undefined, undefined]);
  assert.equal(f.store.getSession(initial.sessionId), undefined, 'a deleted record is never replaced by a stale candidate');
  const off = localSession({ sessionId: initial.sessionId, enabled: false, detached: true, status: 'detached' });
  assert.deepEqual(await f.store.transactSession(initial.sessionId, (current) => {
    assert.equal(current, undefined);
    return off;
  }), off, 'a new explicit permission operation can deliberately recreate missing sidecar state');
});

test('permission creation and update validate strict records and session identity without poisoning their lane', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const id = 'session-permission-validation';
  const valid = localSession({ sessionId: id });
  const invalidRecord = (error: unknown) => error instanceof Error && error.name === 'AzureSyncError' && (error as { code?: string }).code === 'INVALID_RECORD';
  for (const exists of [false, true]) {
    if (exists) await f.store.putSession(valid);
    for (const invalid of [{ status: 'bogus' }, { sessionId: 'wrong-key' }, { enabled: undefined }, { unknownPermission: true }]) {
      const bad = f.store.transactSession(id, () => ({ ...valid, ...invalid }) as LocalSessionRecord);
      const next = f.store.transactSession(id, () => undefined);
      await assert.rejects(bad, invalidRecord);
      assert.equal(await next, undefined, 'a queued no-op still runs after failed validation');
      assert.deepEqual(f.store.getSession(id), exists ? valid : undefined);
      assert.equal(f.store.getSession('wrong-key'), undefined);
    }
  }
  let calls = 0;
  const callbackError = new DomainError('missing-key', 'The transform error is not SDK absence.');
  const failed = f.store.transactSession(id, () => { calls++; throw callbackError; });
  const off = { ...valid, enabled: false, detached: true, admissionStopped: false, status: 'detached' as const };
  const recovered = f.store.transactSession(id, () => off);
  await assert.rejects(failed, (error) => error === callbackError);
  assert.equal(calls, 1, 'a callback missing-key error is not retried as an absent record');
  assert.deepEqual(await recovered, off, 'a queued permission change survives its predecessor failure');
  assert.deepEqual(f.store.getSession(id), off);
  const missingId = 'session-permission-failed-create';
  const failedCreation = f.store.transactSession(missingId, () => { throw callbackError; });
  const recoveredCreation = f.store.transactSession(missingId, () => ({ ...off, sessionId: missingId }));
  await assert.rejects(failedCreation, (error) => error === callbackError);
  assert.deepEqual(await recoveredCreation, { ...off, sessionId: missingId }, 'failed creation also releases the permission lane');
});

test('permission transactions propagate closed-domain errors and work after reopening the store', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const id = 'session-permission-reopen';
  const domain = f.facility.get(localDomain.name);
  assert.ok(domain);
  await domain.close();
  let calls = 0;
  await assert.rejects(f.store.transactSession(id, () => { calls++; return localSession({ sessionId: id }); }),
    (error: unknown) => error instanceof DomainError && error.code === 'closed');
  assert.equal(calls, 0);
  await f.store.close();
  await assert.rejects(f.store.transactSession(id, () => undefined), /local store is not open/);
  await f.store.open();
  const off = localSession({ sessionId: id, enabled: false, detached: true, status: 'detached' });
  assert.deepEqual(await f.store.transactSession(id, () => off), off);
  assert.deepEqual(f.store.getSession(id), off);
});

for (const enabled of [false, true]) {
  test(`conditional rollback preserves a newer ${enabled ? 'on' : 'off'} permission record and its durable cancellation ID`, async (t) => {
    const f = await fixture();
    t.after(async () => {
      await f.store.close();
      await f.facility.closeAll();
      await f.backend.close();
      await rm(f.root, { recursive: true, force: true });
    });
    const initial = localSession({ sessionId: 'session-rollback-protection', resurrectionCancellationId: '11111111-1111-4111-8111-111111111111' });
    await f.store.putSession(initial);
    const latest = { ...initial, enabled, detached: !enabled, status: enabled ? 'syncing' as const : 'detached' as const,
      resurrectionCancellationId: '22222222-2222-4222-8222-222222222222' };
    const changes: string[] = [];
    f.host.on('domain/changed', (change) => {
      if (change.table === 'sessions' && change.key === initial.sessionId) changes.push(change.operation);
    });
    const permission = f.store.transactSession(initial.sessionId, () => latest);
    let observed: LocalSessionRecord | undefined;
    const rollback = f.store.deleteSessionIf(initial.sessionId, (current) => {
      observed = current;
      return current.resurrectionCancellationId === initial.resurrectionCancellationId;
    });
    const [, deleted] = await Promise.all([permission, rollback]);
    assert.equal(deleted, false);
    assert.deepEqual(observed, latest, 'the rollback predicate checks the latest SDK record, not its old import snapshot');
    assert.deepEqual(f.store.getSession(initial.sessionId), latest);
    assert.deepEqual(changes, ['put'], 'a protected row is neither deleted nor redundantly rewritten');
    await f.store.close();
    await f.facility.closeAll();
    await f.store.open();
    assert.deepEqual(f.store.getSession(initial.sessionId), latest);
  });
}

for (const writer of ['put-off', 'transact-on'] as const) {
  test(`conditional delete holds its local lane through deletion before a newer ${writer}`, async (t) => {
    const f = await fixture();
    t.after(async () => {
      await f.store.close();
      await f.facility.closeAll();
      await f.backend.close();
      await rm(f.root, { recursive: true, force: true });
    });
    const initial = localSession({ sessionId: 'session-rollback-write-gap' });
    await f.store.putSession(initial);
    const next = { ...initial, enabled: writer === 'transact-on', detached: writer === 'put-off',
      status: writer === 'put-off' ? 'detached' as const : 'syncing' as const };
    const changes: string[] = [];
    f.host.on('domain/changed', (change) => {
      if (change.table === 'sessions' && change.key === initial.sessionId) changes.push(change.operation);
    });
    let signalChecked!: () => void;
    const checked = new Promise<void>((resolve) => { signalChecked = resolve; });
    const rollback = f.store.deleteSessionIf(initial.sessionId, (current) => {
      assert.deepEqual(current, initial);
      signalChecked();
      return true;
    });
    // Resume in the SDK check/delete gap. The newer operation must wait for
    // deletion, not slip into the SDK chain and then be removed by old rollback.
    await checked;
    const newer = writer === 'put-off'
      ? f.store.putSession(next)
      : f.store.transactSession(initial.sessionId, () => next);
    const [deleted] = await Promise.all([rollback, newer]);
    assert.equal(deleted, true);
    assert.deepEqual(changes, ['deleted', 'put']);
    assert.deepEqual(f.store.getSession(initial.sessionId), next);
    await f.store.close();
    await f.facility.closeAll();
    await f.store.open();
    assert.deepEqual(f.store.getSession(initial.sessionId), next, 'the newer permission operation survives durably');
  });
}

for (const writer of ['mutate', 'delete'] as const) {
  test(`ordinary ${writer} also waits for the conditional check/delete lane`, async (t) => {
    const f = await fixture();
    t.after(async () => {
      await f.store.close();
      await f.facility.closeAll();
      await f.backend.close();
      await rm(f.root, { recursive: true, force: true });
    });
    const initial = localSession({ sessionId: 'session-rollback-metadata-gap' });
    await f.store.putSession(initial);
    let signalChecked!: () => void;
    const checked = new Promise<void>((resolve) => { signalChecked = resolve; });
    const rollback = f.store.deleteSessionIf(initial.sessionId, () => { signalChecked(); return true; });
    await checked;
    let mutationCalls = 0;
    const newer = writer === 'delete'
      ? f.store.deleteSession(initial.sessionId)
      : f.store.mutateSession(initial.sessionId, (current) => { mutationCalls++; return { ...current, lastError: 'receipt' }; });
    const [deleted, after] = await Promise.all([rollback, newer]);
    assert.equal(deleted, true, 'the earlier conditional delete owns the existing row');
    if (writer === 'delete') assert.equal(after, false, 'the later ordinary delete sees an already absent row');
    assert.equal(mutationCalls, 0, 'a later receipt mutation cannot run against the row being rolled back');
    assert.equal(f.store.getSession(initial.sessionId), undefined);
  });
}

test('conditional delete skips missing rows, propagates predicate errors, and releases its lane', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  let calls = 0;
  assert.equal(await f.store.deleteSessionIf('missing-delete', () => { calls++; return true; }), false);
  assert.equal(calls, 0);
  assert.equal(f.store.getSession('missing-delete'), undefined);
  const initial = localSession({ sessionId: 'session-delete-predicate-error' });
  await f.store.putSession(initial);
  const snapshot = f.store.getSession(initial.sessionId);
  assert.equal(await f.store.deleteSessionIf(initial.sessionId, () => false), false);
  assert.equal(f.store.getSession(initial.sessionId), snapshot, 'a false predicate does not replace the stored object');
  const error = new DomainError('missing-key', 'A predicate error must not be swallowed as SDK absence.');
  const failed = f.store.deleteSessionIf(initial.sessionId, () => { throw error; });
  const next = { ...initial, enabled: false, detached: true, status: 'detached' as const };
  const recovered = f.store.putSession(next);
  await assert.rejects(failed, (caught) => caught === error);
  await recovered;
  assert.deepEqual(f.store.getSession(initial.sessionId), next, 'the failed predicate cannot delete or poison later writes');
  await f.store.close();
  await assert.rejects(f.store.deleteSessionIf(initial.sessionId, () => true), /local store is not open/);
});

test('conditional delete rejects malformed SDK records and identity changes before invoking the predicate', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const initial = localSession({ sessionId: 'session-delete-invalid' });
  const domain = f.facility.get(localDomain.name);
  assert.ok(domain);
  const sessions = domain.table('sessions');
  let calls = 0;
  for (const malformed of [{ ...initial, status: 'bogus' }, { ...initial, sessionId: 'wrong-key' }]) {
    // Public administrative SDK access is used only to inject malformed data.
    await sessions.put(initial.sessionId, malformed);
    await assert.rejects(f.store.deleteSessionIf(initial.sessionId, () => { calls++; return true; }),
      (error: unknown) => error instanceof Error && error.name === 'AzureSyncError' && (error as { code?: string }).code === 'INVALID_RECORD');
    assert.deepEqual(sessions.get(initial.sessionId), malformed);
  }
  assert.equal(calls, 0);
  await f.store.putSession(initial);
  assert.equal(await f.store.deleteSessionIf(initial.sessionId, () => true), true, 'validation failures leave the lane usable');
  assert.equal(f.store.getSession(initial.sessionId), undefined);
  await domain.close();
  await assert.rejects(f.store.deleteSessionIf(initial.sessionId, () => true),
    (error: unknown) => error instanceof DomainError && error.code === 'closed');
});

test('store close drains accepted session lanes through queued conditional deletion and recreation', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.store.close();
    await f.facility.closeAll();
    await f.backend.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const initial = localSession({ sessionId: 'session-close-lane' });
  const off = { ...initial, enabled: false, detached: true, status: 'detached' as const };
  const creation = f.store.putSession(initial);
  const mutation = f.store.mutateSession(initial.sessionId, (current) => ({ ...current, status: 'ownership-unverified' }));
  const deletion = f.store.deleteSessionIf(initial.sessionId, (current) => current.status === 'ownership-unverified');
  const recreation = f.store.transactSession(initial.sessionId, (current) => {
    assert.equal(current, undefined);
    return off;
  });
  const closing = f.store.close();
  await assert.rejects(f.store.putSession(initial), /local store is not open/);
  const [, , deleted] = await Promise.all([creation, mutation, deletion, recreation, closing]);
  assert.equal(deleted, true);
  await f.facility.closeAll();
  await f.store.open();
  assert.deepEqual(f.store.getSession(initial.sessionId), off, 'all accepted local writes were durable before close resolved');
});
