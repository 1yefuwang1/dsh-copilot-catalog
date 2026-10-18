import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Config } from '../src/config.js';
import { Importer } from '../src/sync/importer.js';
import type { CloudRepository, StoredManifest } from '../src/sync/cloud-repository.js';
import type { LocalStore } from '../src/local/store.js';
import type { ProjectionWarmer } from '../src/sync/projection-warmer.js';
import { nodeCwdFs } from '../src/sync/effective-cwd.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { batchRow, cloudSession, event, localSession, pathMapping, sessionHeader } from './helpers.js';

test('importer works against a real JSONL persistence handle with no synthetic closers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-jsonl-import-'));
  const localRoot = join(root, 'local');
  await mkdir(localRoot, { recursive: true });
  const real = await realpath(localRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const header = sessionHeader({ id: 'session-jsonl' });
  const binding = headerHash(header, 0);
  const genesis = genesisHash('session-jsonl', 1, binding);
  const e0 = event(0, 'working-directory/change', { cwd: '/remote/project' });
  const chain = chainEvents(genesis, [e0]);
  const row = batchRow('session-jsonl', 1, 0, { endSeq: 0, eventCount: 1, prevChainHash: genesis, chainHash: chain.chainHash, headHash: chain.headHash, payloadHash: chain.payloadHash });
  const manifest: StoredManifest = { entity: cloudSession({ sessionId: 'session-jsonl', headerHash: binding, eventCount: 1, chainHash: chain.chainHash, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1 }), etag: 'e' };
  const repository = {
    getManifest: async () => manifest,
    listBatchRows: async () => [row],
    readCandidate: async () => gzipSync(payloadBytes([e0])),
  } as unknown as CloudRepository;
  const records = new Map<string, ReturnType<typeof localSession>>();
  const local = {
    getSession: (id: string) => records.get(id),
    putSession: async (record: ReturnType<typeof localSession>) => { records.set(record.sessionId, record); },
  } as unknown as LocalStore;
  const ctx = new Context();
  await jsonl.apply(ctx, { root: join(root, 'data') });
  const importer = new Importer({
    config: Config({}), persistence: ctx.sessionPersistence, repository, local,
    cwdBinding: async () => ({ mapping: pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' }), fs: nodeCwdFs }),
    projection: { warm: async () => 'complete' } as unknown as ProjectionWarmer, now: () => 1,
  });
  const result = await importer.import('session-jsonl');
  assert.equal(result.status, 'complete');
  const handle = await ctx.sessionPersistence.open('session-jsonl' as never, 'read');
  try {
    const read = await handle.read(0);
    assert.deepEqual(read.events.map((value) => value.type), ['working-directory/change']);
    assert.equal(handle.header.cwd, real);
  } finally {
    await handle.close();
  }
});
