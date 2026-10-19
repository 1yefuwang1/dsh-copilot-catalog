import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EarlyImportClaims } from '../src/sync/importer.js';
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence';
import type { LocalStore } from '../src/local/store.js';
import type { LocalSessionRecord } from '../src/schema.js';
import { localSession } from './helpers.js';

class Handle {
  closed = false;
  async close() { this.closed = true; }
}

test('early claims hold incomplete writes and mark already-owned imports as import-race', async () => {
  const records = new Map<string, LocalSessionRecord>([
    ['creating', localSession({ sessionId: 'creating', importState: 'creating', status: 'importing' })],
    ['planned', localSession({ sessionId: 'planned', importState: 'planned', status: 'importing' })],
    ['owned', localSession({ sessionId: 'owned', importState: 'appending', status: 'importing' })],
    ['complete', localSession({ sessionId: 'complete', importState: 'complete', status: 'synced' })],
  ]);
  const local = {
    listSessions: () => records.entries(),
    getSession: (id: string) => records.get(id),
    putSession: async (record: LocalSessionRecord) => { records.set(record.sessionId, record); },
    transactSession: async (id: string, fn: Parameters<LocalStore['transactSession']>[1]) => {
      const next = fn(records.get(id));
      if (next !== undefined) records.set(id, next);
      return next;
    },
  } as unknown as LocalStore;
  const handles = new Map<string, Handle>();
  const persistence = {
    async open(id: string) {
      if (id === 'owned') throw new SessionAlreadyOwnedError(id as never);
      const handle = new Handle();
      handles.set(id, handle);
      return handle;
    },
  };
  const claims = new EarlyImportClaims(persistence as never, local);
  const result = await claims.claimAll();
  assert.deepEqual(result.claimed.map((claim) => claim.sessionId).sort(), ['creating', 'planned']);
  assert.deepEqual(result.raced, ['owned']);
  assert.equal(records.get('owned')?.status, 'import-race');
  assert.equal(records.get('complete')?.status, 'synced');
  const handle = claims.take('creating');
  assert.ok(handle);
  assert.equal(claims.take('creating'), undefined);
  await claims.release();
});

test('early claim acquisition and owned-status checkpoints preserve a newer detached authority', async (t) => {
  for (const owned of [false, true]) {
    await t.test(`owned=${owned}`, async () => {
      const prior = localSession({ sessionId: 'changing', importState: 'failed', status: 'import-incomplete' });
      let latest = prior;
      let entered!: () => void;
      let release!: () => void;
      const pendingCallback = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let writes = 0;
      const local = {
        listSessions: () => new Map([['changing', prior]]).entries(),
        getSession: () => prior, // Deliberately stale, enabled cache.
        transactSession: async (_id: string, fn: Parameters<LocalStore['transactSession']>[1]) => {
          entered();
          await gate;
          const next = fn(latest);
          if (next !== undefined) { writes += 1; latest = next; }
          return next;
        },
      } as unknown as LocalStore;
      const handle = new Handle();
      const persistence = { open: async () => {
        if (owned) throw new SessionAlreadyOwnedError('changing' as never);
        return handle;
      } };
      const claims = new EarlyImportClaims(persistence as never, local);
      const pending = claims.claimAll();
      await pendingCallback;
      latest = { ...prior, enabled: false, detached: true, status: 'detached', resurrectionCancellationId: '00000000-0000-4000-8000-000000000001' };
      const detached = latest;
      release();
      const result = await pending;
      assert.deepEqual(latest, detached);
      assert.equal(writes, 0);
      assert.deepEqual(result.claimed, []);
      assert.deepEqual(result.raced, []);
      assert.equal(claims.take('changing'), undefined);
      if (!owned) assert.equal(handle.closed, true, 'a superseded acquired early handle must close instead of being retained');
    });
  }
});
