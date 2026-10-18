import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderImportCandidates } from '../src/sync/recovery.js';
import { AzureSyncError } from '../src/azure/errors.js';

test('import recovery orders parents before subagent descendants and refuses orphans', () => {
  const ordered = orderImportCandidates([
    { sessionId: 'child', parentSession: 'root', delegationDepth: 1, subagent: true },
    { sessionId: 'root', delegationDepth: 0 },
    { sessionId: 'grandchild', parentSession: 'child', delegationDepth: 2, subagent: true },
  ]);
  assert.deepEqual(ordered.map((candidate) => candidate.sessionId), ['root', 'child', 'grandchild']);
  assert.throws(() => orderImportCandidates([{ sessionId: 'orphan', parentSession: 'missing', subagent: true }]), (error: unknown) => error instanceof AzureSyncError && error.code === 'IMPORT_INCOMPLETE');
  assert.throws(() => orderImportCandidates([
    { sessionId: 'a', parentSession: 'b', subagent: true }, { sessionId: 'b', parentSession: 'a', subagent: true },
  ]), (error: unknown) => error instanceof AzureSyncError && error.code === 'IMPORT_INCOMPLETE');
});

test('recovery resumes parents before children and reports failures', async () => {
  const { ImportRecovery } = await import('../src/sync/recovery.js');
  const records = new Map<string, { sessionId: string; importState: string; parentSession?: string; delegationDepth?: number; subagent?: boolean }>([
    ['root', { sessionId: 'root', importState: 'failed' }],
    ['child', { sessionId: 'child', importState: 'failed', parentSession: 'root', delegationDepth: 1, subagent: true }],
  ]);
  const local = {
    listSessions: () => records.entries(),
    getSession: (id: string) => records.get(id),
  } as never;
  const resumed: string[] = [];
  const importer = { resume: async (id: string) => { resumed.push(id); return { status: 'complete' }; } } as never;
  const recovery = new ImportRecovery(importer, local);
  const result = await recovery.repairAll();
  assert.deepEqual(resumed, ['root', 'child']);
  assert.deepEqual(result.repaired, ['root', 'child']);
});

test('a completed parent satisfies a child repair instead of aborting it', async () => {
  const { ImportRecovery } = await import('../src/sync/recovery.js');
  const records = new Map<string, { sessionId: string; importState: string; parentSession?: string; delegationDepth?: number; subagent?: boolean }>([
    ['root', { sessionId: 'root', importState: 'complete' }],
    ['child', { sessionId: 'child', importState: 'failed', parentSession: 'root', delegationDepth: 1, subagent: true }],
  ]);
  const local = { listSessions: () => records.entries(), getSession: (id: string) => records.get(id) } as never;
  const resumed: string[] = [];
  const importer = { resume: async (id: string) => { resumed.push(id); return { status: 'complete' }; } } as never;
  const result = await new ImportRecovery(importer, local).repairAll();
  assert.deepEqual(resumed, ['child']);
  assert.deepEqual(result.repaired, ['child']);
});

test('a failed parent blocks its subagent child in the same repair pass', async () => {
  const { ImportRecovery } = await import('../src/sync/recovery.js');
  const records = new Map<string, { sessionId: string; importState: string; parentSession?: string; delegationDepth?: number; subagent?: boolean }>([
    ['root', { sessionId: 'root', importState: 'failed' }],
    ['child', { sessionId: 'child', importState: 'failed', parentSession: 'root', delegationDepth: 1, subagent: true }],
  ]);
  const local = { listSessions: () => records.entries(), getSession: (id: string) => records.get(id) } as never;
  const calls: string[] = [];
  const importer = { resume: async (id: string) => { calls.push(id); if (id === 'root') throw new Error('parent failed'); return { status: 'complete' }; } } as never;
  const result = await new ImportRecovery(importer, local).repairAll();
  assert.deepEqual(calls, ['root']);
  assert.deepEqual(result.repaired, []);
  assert.deepEqual(result.failed, ['root', 'child']);
});
