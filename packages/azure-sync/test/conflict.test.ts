import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyConflictAction, isConflictAction, exportLocalSnapshot } from '../src/sync/conflict.js';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionSource } from '../src/sync/session-source.js';
import { sessionHeader } from './helpers.js';
import { AzureSyncError } from '../src/azure/errors.js';

test('only the three conservative conflict actions are accepted', async () => {
  assert.equal(isConflictAction('keep-local'), true);
  assert.equal(isConflictAction('overwrite'), false);
  const calls: string[] = [];
  const handlers = {
    keepLocal: () => { calls.push('keep-local'); },
    exportLocal: () => { calls.push('export-local'); },
    removeCloud: () => { calls.push('remove-cloud'); },
  };
  assert.equal(await applyConflictAction('export-local', handlers), 'export-local');
  assert.deepEqual(calls, ['export-local']);
  await assert.rejects(applyConflictAction('fork', handlers), (error: unknown) => error instanceof AzureSyncError && error.code === 'CONFLICT');
});

test('cancelled export never creates a backup after pre-write persistence waits', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'azure-export-cancel-')));
  t.after(async () => { assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); await rm(root, { recursive: true }); });
  for (const phase of ['before', 'flush', 'read'] as const) {
    const abort = new AbortController();
    if (phase === 'before') abort.abort();
    let flushes = 0;
    const source: SessionSource = {
      flush: async () => { flushes++; if (phase === 'flush') abort.abort(); },
      stat: async () => undefined,
      read: async () => { if (phase === 'read') abort.abort(); return { header: sessionHeader({ id: 'session-export' }) as never, inheritedEventCount: 0, events: [] }; },
    };
    await assert.rejects(exportLocalSnapshot(source, 'session-export', root, abort.signal), { name: 'AbortError' });
    assert.equal(flushes, phase === 'before' ? 0 : 1);
    assert.deepEqual(await readdir(root), []);
  }
});
