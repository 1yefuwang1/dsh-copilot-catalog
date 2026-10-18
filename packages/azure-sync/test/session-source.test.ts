import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { PersistenceSessionSource } from '../src/sync/session-source.js';
import { sessionHeader } from './helpers.js';

test('the persistence source reads a real JSONL header/event log', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-jsonl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = new Context();
  await jsonl.apply(ctx, { root });
  const handle = await ctx.sessionPersistence.create(sessionHeader({ id: 'session-jsonl' }) as never);
  await handle.append([{ type: 'working-directory/change', seq: 0, time: 1, data: { cwd: '/remote/project' } }] as never);
  await handle.flush();
  await handle.close();

  const source = new PersistenceSessionSource(ctx.sessionPersistence);
  const snapshot = await source.read('session-jsonl');
  assert.ok(snapshot);
  assert.equal(snapshot.header.id, 'session-jsonl');
  assert.equal(snapshot.inheritedEventCount, 0);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.type, 'working-directory/change');
  assert.equal((await source.stat('session-jsonl'))?.header.id, 'session-jsonl');
  assert.equal(await source.read('missing-session'), undefined);
  await source.flush();
});
