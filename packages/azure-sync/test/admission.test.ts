import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitPreStep, type OwnershipProof } from '../src/sync/admission.js';
import type { LocalStore } from '../src/local/store.js';
import type { LocalSessionRecord } from '../src/schema.js';
import { cloudSession, HEX_A, localSession } from './helpers.js';

function setup(proof: OwnershipProof | (() => Promise<OwnershipProof>), prependFails = false) {
  const prepends: [string, string][] = [];
  const appends: [string, string][] = [];
  const agent = { inbox: {
    prepend: (target: string, message: { id: string }) => {
      if (prependFails) throw new Error('inbox closed');
      prepends.push([target, message.id]);
    },
    append: (target: string, message: { id: string }) => { appends.push([target, message.id]); },
  } } as never;
  let record: LocalSessionRecord | undefined = localSession({ sessionId: 'session-test', writerEpoch: 1 });
  const local = {
    getSession: () => record,
    putSession: async (next: LocalSessionRecord) => { record = next; },
    mutateSession: async (_id: string, fn: (current: LocalSessionRecord) => LocalSessionRecord) => {
      if (record !== undefined) record = fn(record);
    },
    deleteSession: async () => { const present = record !== undefined; record = undefined; return present; },
  } as unknown as LocalStore;
  const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] as never;
  const ownership = typeof proof === 'function' ? proof : async () => proof;
  return { agent, local, messages, prepends, appends, ownership, getRecord: () => { assert.ok(record); return record; } };
}

const base = { sessionId: 'session-test', turn: 1, step: 1, now: () => 1 };

test('admission enters only for a fresh owned proof', async () => {
  const own = setup({ owned: true });
  const result = await admitPreStep({ ...base, agent: own.agent, messages: own.messages, local: own.local, ownership: own.ownership });
  assert.equal(result.kind, 'enter');
  assert.deepEqual(own.prepends, []);
});

test('another owner requeues to next-turn last-to-first with a receipt', async () => {
  const other = setup({ owned: false, reason: 'paused-other-device' });
  const result = await admitPreStep({ ...base, agent: other.agent, messages: other.messages, local: other.local, ownership: other.ownership });
  assert.equal(result.kind, 'reject');
  assert.deepEqual(other.prepends, [['next-turn', 'm3'], ['next-turn', 'm2'], ['next-turn', 'm1']]);
  assert.equal(other.getRecord().status, 'paused-other-device');
  assert.deepEqual(other.getRecord().admissionReceipt?.messageIds, ['m1', 'm2', 'm3']);
});

test('a failed proof fails closed with ownership-unverified', async () => {
  const failed = setup(async () => { throw new Error('network'); });
  const result = await admitPreStep({ ...base, agent: failed.agent, messages: failed.messages, local: failed.local, ownership: failed.ownership });
  assert.equal(result.kind, 'reject');
  assert.equal(failed.getRecord().status, 'ownership-unverified');
});

test('a prepend failure falls back to an ordered append and records the failure', async () => {
  const fallback = setup({ owned: false, reason: 'paused-other-device' }, true);
  const result = await admitPreStep({ ...base, agent: fallback.agent, messages: fallback.messages, local: fallback.local, ownership: fallback.ownership });
  assert.equal(result.kind, 'reject');
  assert.deepEqual(fallback.prepends, []);
  assert.deepEqual(fallback.appends, [['next-turn', 'm1'], ['next-turn', 'm2'], ['next-turn', 'm3']]);
  assert.equal(fallback.getRecord().status, 'ownership-unverified');
});

test('disabled sessions bypass admission entirely', async () => {
  const disabled = setup({ owned: false, reason: 'paused-other-device' });
  await disabled.local.putSession({ ...disabled.getRecord(), enabled: false });
  assert.equal((await admitPreStep({ ...base, agent: disabled.agent, messages: disabled.messages, local: disabled.local, ownership: disabled.ownership })).kind, 'enter');
  assert.deepEqual(disabled.prepends, []);
});

test('terminal stop stays gated after publication opt-out and prepend fallback', async () => {
  for (const status of ['removed-remotely', 'generation-changed', 'remote-missing', 'conflict', 'remote-ahead-live'] as const) {
    let proofs = 0;
    const f = setup(async () => { proofs++; return { owned: true }; }, true);
    await f.local.putSession({ ...f.getRecord(), enabled: false, detached: false, status });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await admitPreStep({ ...base, ...f })).kind, 'reject');
      assert.equal(f.getRecord().status, status, 'fallback cannot erase the persistent stop and authorize the next input');
      assert.equal(f.getRecord().admissionReceipt?.reason, status);
    }
    assert.equal(proofs, 0);
    await f.local.putSession({ ...f.getRecord(), detached: true, status: 'detached' });
    assert.equal((await admitPreStep({ ...base, ...f })).kind, 'enter');
  }
});

test('durable admission stops gate every recovery diagnostic, including corruption and remote disabled', async () => {
  for (const status of ['committed-index-corrupt', 'corrupt-remote', 'detached', 'generation-changed', 'remote-missing', 'conflict'] as const) {
    let proofs = 0;
    const f = setup(async () => { proofs++; return { owned: true }; }, true);
    await f.local.putSession({ ...f.getRecord(), enabled: false, detached: false, admissionStopped: true, status });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await admitPreStep({ ...base, ...f })).kind, 'reject');
      assert.equal(f.getRecord().status, status);
      assert.equal(f.getRecord().admissionReceipt?.reason, status);
      assert.equal(f.getRecord().admissionStopped, true);
    }
    assert.equal(proofs, 0);
    await f.local.putSession({ ...f.getRecord(), detached: true, admissionStopped: false, status: 'detached' });
    assert.equal((await admitPreStep({ ...base, ...f })).kind, 'enter');
  }
});

test('disabled incomplete history is not implicitly continuable', async () => {
  const f = setup({ owned: true });
  await f.local.putSession({ ...f.getRecord(), enabled: false, detached: false, importState: 'failed', status: 'import-incomplete' });
  assert.equal((await admitPreStep({ ...base, ...f })).kind, 'reject');
  assert.equal(f.getRecord().admissionReceipt?.reason, 'import-incomplete');
});

for (const fallback of [false, true]) {
  test(`receipt preserves all latest flags and off/stop diagnostics (append fallback: ${fallback})`, async () => {
    const diagnostics: Partial<LocalSessionRecord>[] = [
      { enabled: false, detached: true, admissionStopped: false, status: 'detached', state: 'disabled', resurrectionIntent: undefined },
      { enabled: false, detached: false, admissionStopped: false, status: 'detached', state: 'disabled' },
      { enabled: true, detached: true, admissionStopped: false, status: 'detached' },
      { enabled: true, detached: false, admissionStopped: true, status: 'committed-index-corrupt' },
      { enabled: true, detached: false, admissionStopped: false, status: 'removed-remotely' },
    ];
    for (const diagnostic of diagnostics) {
      const latest = localSession({
        sessionId: base.sessionId, generation: 2, writerEpoch: 7, remapped: true, needsFolder: true,
        mappingUnstable: true, degradedAcknowledged: true, imported: true, weArchived: true,
        importState: 'degraded', catchUpPending: true, cleanupPending: true, subagent: true,
        parentSession: 'parent', delegationDepth: 1, unmappablePaths: ['/missing'], degradedAttachments: ['attachment'],
        canonicalCwd: '/remote/new', localCwd: '/local/new', lastError: 'Latest local diagnostic.',
        resurrectionCancellationId: '11111111-1111-4111-8111-111111111111',
        resurrectionIntent: {
          operationId: '22222222-2222-4222-8222-222222222222', priorGeneration: 1, targetGeneration: 2,
          priorState: 'disabled', sourceETag: 'etag', genesisHash: HEX_A,
          target: cloudSession({ sessionId: base.sessionId, generation: 2 }),
        },
        ...diagnostic,
      });
      const f = setup(async () => {
        await f.local.putSession(latest);
        return { owned: false, reason: 'paused-other-device' };
      }, fallback);
      assert.equal((await admitPreStep({ ...base, ...f })).kind, 'reject');
      assert.deepEqual(f.getRecord(), {
        ...latest,
        ...(fallback ? { lastError: 'Failed to prepend claimed messages back to next-turn; appended instead.' } : {}),
        admissionReceipt: { reason: 'paused-other-device', messageIds: ['m1', 'm2', 'm3'], turn: 1, step: 1, at: 1 },
      });
      assert.equal(f.prepends.length + f.appends.length, 3);
    }
  });
}

test('a session deleted while the proof is pending is not recreated by its rejection receipt', async () => {
  const f = setup(async () => {
    await f.local.deleteSession(base.sessionId);
    return { owned: false, reason: 'paused-other-device' };
  });
  assert.equal((await admitPreStep({ ...base, ...f })).kind, 'reject');
  assert.equal(f.local.getSession(base.sessionId), undefined);
  assert.deepEqual(f.prepends, [['next-turn', 'm3'], ['next-turn', 'm2'], ['next-turn', 'm1']]);
});

test('an already missing session bypasses ownership without creating a receipt', async () => {
  let proofs = 0;
  const f = setup(async () => { proofs++; return { owned: false }; });
  await f.local.deleteSession(base.sessionId);
  assert.equal((await admitPreStep({ ...base, ...f })).kind, 'enter');
  assert.equal(f.local.getSession(base.sessionId), undefined);
  assert.equal(proofs, 0);
  assert.deepEqual(f.prepends, []);
});
