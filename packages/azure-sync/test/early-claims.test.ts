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
