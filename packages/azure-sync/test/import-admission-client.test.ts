import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudClient, type CloudLocalView, type CloudRequest, type CloudSettingsView } from '../client-model.js';

const sid = 'imported-original-thread';
function store<T>(initial: T) { let value = initial; const listeners = new Set<() => void>(); return { getSnapshot: () => value, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }, publish(next: T) { value = next; for (const fn of listeners) fn(); } }; }
const settings: CloudSettingsView = { auth: 'auto', accountName: '', managedIdentityClientId: '', connectionRef: 'FIXTURE_REFERENCE', container: 'sessions', table: 'sessions', endpointSuffix: 'core.windows.net', defaultEnabled: false, pullOnStartup: false, pollSeconds: 60, authPending: false, connection: { configured: false, writable: false } };
const local = (patch: Partial<CloudLocalView> = {}): CloudLocalView => ({ sessionId: sid, generation: 1, enabled: true, state: 'active', status: 'synced', detached: false, admissionRequired: true, admissionStopped: false, restartRequired: false, needsFolder: false, mappingUnstable: false, degradedAttachmentCount: 0, degradedAcknowledged: false, hasConflictBackup: false, importState: 'complete', ...patch });
function fixture(view = local()) {
  const generation = store<{ id: number } | undefined>({ id: 1 }), blocks = new Map<string, ReturnType<typeof store<{ reason: string } | undefined>>>();
  let allowed = false, fail = false, ownership = 0, admissionCalls = 0;
  const block = (id: string) => { let entry = blocks.get(id); if (!entry) { entry = store<{ reason: string } | undefined>(undefined); blocks.set(id, entry); } return entry; };
  const client = createCloudClient({ connection: { generation, rpc: { async call(_path, _endpoint, payload) {
    const request = (payload as { request: CloudRequest }).request;
    if (request.action === 'status') return { ok: true, value: { v: 1, ok: true, data: { kind: 'status', revision: 1, projectionRevision: 'a'.repeat(64), settings, items: [view] } } };
    assert.equal(request.action, 'check-ownership'); ownership++;
    return { ok: true, value: { v: 1, ok: true, data: { kind: 'action', action: 'check-ownership', sessionId: sid, state: view.status, detail: { owned: true } } } };
  } } }, sessions: { refresh() {} }, conversation: { blocks: { storeFor: block, set(id, value) { block(id).publish(value); } } } }, {
    async importAdmission(target, signal) { admissionCalls++; assert.equal(target, sid); signal.throwIfAborted(); if (fail) throw new Error('fixture unavailable'); return allowed; },
  });
  return { client, generation, block, setAllowed(value: boolean) { allowed = value; }, setFail(value: boolean) { fail = value; }, get ownership() { return ownership; }, get admissionCalls() { return admissionCalls; } };
}

test('verified complete cloud history stays composer-blocked until independent destination Continue', async () => {
  const run = fixture(), release = run.client.watchSession(sid);
  try {
    await run.client.refresh(sid);
    assert.equal(run.client.getThread(sid).blocked, true); assert.equal(run.client.getThread(sid).flags.destinationAdmitted, false);
    assert.ok(run.block(sid).getSnapshot()); assert.equal(run.ownership, 0, 'read-only Open does not perform an Azure ownership inspection');
    run.setAllowed(true); await run.client.refresh(sid);
    assert.equal(run.client.getThread(sid).phase, 'ready'); assert.equal(run.client.getThread(sid).blocked, false);
    assert.equal(run.ownership, 1); assert.equal(run.block(sid).getSnapshot(), undefined);
  } finally { release(); run.client.dispose(); }
});

test('turning sync Off does not bypass the new destination readiness/Continue UX gate', async () => {
  const run = fixture(local({ enabled: false, state: 'disabled', status: 'detached', detached: true, admissionRequired: false })), release = run.client.watchSession(sid);
  try {
    await run.client.refresh(sid); assert.equal(run.client.getThread(sid).blocked, true); assert.equal(run.ownership, 0);
    run.setAllowed(true); await run.client.refresh(sid); assert.equal(run.client.getThread(sid).phase, 'local'); assert.equal(run.ownership, 0);
  } finally { release(); run.client.dispose(); }
});

test('missing readiness lookup and a new connection cannot retain a previously allowed destination flag', async () => {
  const run = fixture(local({ enabled: false, state: 'disabled', status: 'detached', detached: true, admissionRequired: false })), release = run.client.watchSession(sid);
  try {
    run.setAllowed(true); await run.client.refresh(sid); assert.equal(run.client.getThread(sid).blocked, false);
    run.setFail(true); await run.client.refresh(sid); assert.equal(run.client.getThread(sid).blocked, true); assert.equal(run.client.getThread(sid).flags.destinationAdmitted, false);
    run.setFail(false); run.setAllowed(false); run.generation.publish({ id: 2 }); await run.client.refresh(sid);
    assert.equal(run.client.getThread(sid).blocked, true); assert.ok(run.admissionCalls >= 3);
  } finally { release(); run.client.dispose(); }
});

test('destination guard uses the existing block owner and preserves any foreign blocker', async () => {
  const run = fixture(), foreign = { reason: 'foreign-owner' };
  run.block(sid).publish(foreign); const release = run.client.watchSession(sid);
  try {
    await run.client.refresh(sid); assert.equal(run.block(sid).getSnapshot(), foreign);
    run.setAllowed(true); await run.client.refresh(sid); assert.equal(run.block(sid).getSnapshot(), foreign);
  } finally { release(); run.client.dispose(); assert.equal(run.block(sid).getSnapshot(), foreign); }
});
