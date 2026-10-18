import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitPreStep, type OwnershipProof } from '../src/sync/admission.js';
import type { LocalStore } from '../src/local/store.js';
import type { LocalSessionRecord } from '../src/schema.js';
import { localSession } from './helpers.js';

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
  let record: LocalSessionRecord = localSession({ sessionId: 'session-test', writerEpoch: 1 });
  const local = {
    getSession: () => record,
    putSession: async (next: LocalSessionRecord) => { record = next; },
  } as unknown as LocalStore;
  const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] as never;
  const ownership = typeof proof === 'function' ? proof : async () => proof;
  return { agent, local, messages, prepends, appends, ownership, getRecord: () => record };
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
