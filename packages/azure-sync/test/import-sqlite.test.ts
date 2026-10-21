import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { candidateBlobName } from '../src/sync/cloud-repository.js';
import { batchRow, cloudSession, event, sessionHeader } from './helpers.js';
import { AcceptanceCloud } from './acceptance-helpers.js';
import { coordinatorFixture } from './import-coordinator-fixture.js';

test('actual SQLite FTS discovers a newly imported cold thread through the destination coordinator', { timeout: 45_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'destination-sqlite-')));
  let host: Awaited<ReturnType<typeof coordinatorFixture>> | undefined;
  let sqlite: SqliteSessionQueryEngine | undefined;
  t.after(async () => {
    await sqlite?.close(); await host?.close();
    assert.equal(await realpath(root), root); assert.equal(dirname(root), await realpath(tmpdir()));
    assert.ok(root.startsWith(join(await realpath(tmpdir()), 'destination-sqlite-')));
    await rm(root, { recursive: true, force: false });
  });
  const source = join(root, 'source-project'); await mkdir(source);
  const sid = SessionId(`session-${randomUUID()}`), operationId = randomUUID();
  const tag = 'destinationimportftsuniquemarker20261021';
  const message = createUserMessage({ content: [{ type: 'text', text: `Persisted imported native message ${tag} remains searchable.` }], source: { kind: 'user' } });
  const header = sessionHeader({ id: sid, cwd: source, delegationDepth: 0 });
  const events = [event(0, 'session/title', { title: 'Cold imported FTS thread', messageSeqs: [], source: { kind: 'user' } }), event(1, 'user/message', message)] as SessionEvent[];
  const canonicalHeader = headerHash(header, 0), genesis = genesisHash(sid, 1, canonicalHeader), chain = chainEvents(genesis, events);
  const blobName = candidateBlobName(sid, 1, 0, 1, chain.payloadHash);
  const row = batchRow(sid, 1, 0, { ...chain, eventCount: events.length, endSeq: events.length - 1, blobName });
  const cloud = new AcceptanceCloud();
  await cloud.putCandidate(blobName, gzipSync(payloadBytes(events)), {});
  await cloud.createManifest(cloudSession({ sessionId: sid, headerJson: JSON.stringify(header), headerHash: canonicalHeader, cwd: source, eventCount: events.length, headSeq: events.length - 1, chainHash: chain.chainHash, headHash: chain.headHash, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, lastBatchBlobName: blobName }));
  cloud.rows.set(row.rowKey, { entity: row, etag: 'sqlite-fixture-row' });
  host = await coordinatorFixture(join(root, 'receiver'), cloud, {
    queryFactory(ctx) { sqlite = new SqliteSessionQueryEngine(ctx, { path: join(root, 'derived-search.sqlite'), openAt: 'first-search', journalMode: 'delete' }); return sqlite; },
  });
  assert.ok(sqlite);
  assert.deepEqual((await sqlite.searchSessions({ query: tag })).items, [], 'index starts empty before import');
  const execution = () => ({ origin: 'rpc' as const, signal: new AbortController().signal });
  const plan = await host.coordinator.execute({ action: 'plan-import', sessionId: sid, generation: 1, operationId, gitContextVersion: 2, destination: { kind: 'local', folderPath: host.cwd }, mapping: { remotePlatform: 'linux', remotePrefix: source } }, execution());
  assert.equal(plan.kind, 'import-plan'); if (plan.kind !== 'import-plan') return;
  const imported = await host.coordinator.execute({ action: 'commit-import', sessionId: sid, operationId, revision: plan.revision, confirm: true, acknowledgeCodeMismatch: true }, execution());
  assert.equal(imported.kind, 'import-operation'); if (imported.kind !== 'import-operation') return;
  assert.equal(imported.phase, 'ready', JSON.stringify(imported));
  const sessions = await sqlite.searchSessions({ query: tag });
  assert.equal(sessions.items.length, 1); assert.equal(sessions.items[0]?.header.id, sid);
  assert.ok(sessions.items[0]?.bestMatch.snippet.includes(tag));
  const found = await sqlite.searchEvents({ sessionId: sid, query: tag });
  assert.equal(found.session.id, sid); assert.equal(found.items.length, 1); assert.ok(found.items[0]?.snippet.includes(tag));
  assert.equal(host.ctx.agents.get(sid), undefined, 'FTS reconciliation/cold reads never create the target Agent');
  assert.equal(host.llmCalls, 0); assert.equal(cloud.activeLeases.size, 0, 'read-only import/search does not acquire cloud writer authority');
});
