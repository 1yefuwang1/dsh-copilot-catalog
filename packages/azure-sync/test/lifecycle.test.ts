import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerSyncLifecycle } from '../src/sync/lifecycle.js';
import type { SyncService } from '../src/sync/service.js';
import type { UploadScheduler } from '../src/sync/scheduler.js';
import type { LocalStore } from '../src/local/store.js';
import type { LocalSessionRecord } from '../src/schema.js';
import { localSession } from './helpers.js';

test('lifecycle schedules without awaiting uploads and gates pre-step through the service proof', async () => {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const ctx = { on: (name: string, handler: (...args: never[]) => unknown) => { handlers.set(name, handler); return () => undefined; } } as never;
  let record: LocalSessionRecord = localSession({ sessionId: 'session-test', writerEpoch: 1 });
  const local = { getSession: () => record, putSession: async (next: LocalSessionRecord) => { record = next; } } as unknown as LocalStore;
  const scheduled: string[] = [], flushed: string[] = [], drained: string[] = [], activities: string[] = [];
  const scheduler = { schedule: (id: string) => scheduled.push(id), flushNow: async (id: string) => { flushed.push(id); } } as unknown as UploadScheduler;
  let owned = true;
  const service = {
    noteActivity: (id: string) => activities.push(id),
    noteFlushed: (id: string) => { void id; },
    ensureOwnership: async () => ({ owned }),
    drain: async (id: string) => { drained.push(id); },
  } as unknown as SyncService;
  const dispose = registerSyncLifecycle({ ctx, service, scheduler, local, now: () => 0 });
  assert.equal(handlers.has('agent/turn-stopping'), false);

  (handlers.get('session/event') as (session: { id: string }) => void)({ id: 'session-test' });
  assert.deepEqual(scheduled, ['session-test']);
  (handlers.get('session/flush') as (session: { id: string }) => void)({ id: 'session-test' });
  assert.deepEqual(flushed, []);
  assert.deepEqual(scheduled, ['session-test', 'session-test']);

  let next = 0;
  type AdmissionPayload = { agent: { session: { id: string }; inbox: { prepend: () => void; append: () => void } }; messages: { id: string }[]; turn: number; step: number };
  const payload: AdmissionPayload = { agent: { session: { id: 'session-test' }, inbox: { prepend: () => undefined, append: () => undefined } }, messages: [{ id: 'm' }], turn: 1, step: 1 };
  const admitted = await (handlers.get('agent/pre-step') as (payload: AdmissionPayload, next: () => Promise<unknown>) => Promise<{ kind: string }>)(payload, async () => { next += 1; return { kind: 'enter', messages: [] }; });
  assert.equal(admitted.kind, 'enter');
  assert.equal(next, 1);
  owned = false;
  const rejected = await (handlers.get('agent/pre-step') as (payload: AdmissionPayload, next: () => Promise<unknown>) => Promise<{ kind: string }>)(payload, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(rejected.kind, 'reject');

  (handlers.get('agent/status') as (payload: { agent: { session: { id: string } }; status: string }) => void)({ agent: { session: { id: 'session-test' } }, status: 'idle' });
  assert.deepEqual(drained, ['session-test']);
  assert.deepEqual(activities, ['session-test', 'session-test', 'session-test']);
  dispose();
});
