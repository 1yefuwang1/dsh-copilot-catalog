import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { AzureSyncError } from '../src/azure/errors.js';
import { HistoryPinStore, historyPinDomain, historyWatermark, historyScopeId, historyNamespace } from '../src/sync/history-state.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { candidateBlobName } from '../src/sync/cloud-repository.js';
import { bounds, historyFixture, scope } from './history-fixture.js';
import { chainEvents, genesisHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { gzipSync } from 'node:zlib';
import { event } from './helpers.js';
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href);
const code = (expected: string) => (error: unknown) => error instanceof AzureSyncError && error.code === expected;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'history-foundation-')); const host = new Context(); new Storage(host);
  const backend = new JsonStorageBackend(resolve(root, 'metadata')); host.storage.backend.register('history-test', backend);
  const facility = new DomainFacility(host, { backend: 'history-test' }); const pins = new HistoryPinStore(facility); await pins.open();
  return { root, backend, facility, pins, async close() { await pins.close(); await facility.closeAll(); await backend.close(); await rm(root, { recursive: true, force: true }); } };
}

test('A10/A11 durable H survives payload eviction, reader restart, serialized older completion and fork-to-larger', async t => {
  const local = await fixture(); t.after(() => local.close()); assert.equal(historyPinDomain.layout, 'single');
  const f = historyFixture(); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: local.pins }); await reader.read(f.sessionId); await reader.close();
  const current = historyWatermark(historyScopeId(scope), f.manifest.entity); const floor = local.pins.get(current)!;
  const lower = { ...current, eventCount: 1, headSeq: 0, batchCount: 1, chainHash: f.rows[0]!.chainHash, headHash: f.rows[0]!.headHash, lastBatchRowKey: f.rows[0]!.rowKey, lastBatchBlobName: f.rows[0]!.blobName };
  await assert.rejects(local.pins.accept(lower), code('CONFLICT')); assert.deepEqual(local.pins.get(current), floor);
  await local.pins.close(); await local.pins.open();
  const next = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: local.pins }); f.manifest = { ...f.manifest, entity: { ...f.manifest.entity, eventCount: lower.eventCount, headSeq: lower.headSeq, batchCount: lower.batchCount, chainHash: lower.chainHash, headHash: lower.headHash, lastBatchRowKey: lower.lastBatchRowKey, lastBatchBlobName: lower.lastBatchBlobName } };
  await assert.rejects(next.observe(f.sessionId), code('CONFLICT')); await next.close();
  const fork = historyFixture(3, f.sessionId); let previous = genesisHash(f.sessionId, 1, floor.headerHash);
  for (let i = 0; i < fork.rows.length; i += 1) {
    const e = event(i, 'user/message', { id: `fork-${i}` }); const c = chainEvents(previous, [e]); Object.assign(fork.rows[i]!, c, { blobName: candidateBlobName(f.sessionId, 1, i, 1, c.payloadHash) }); fork.blobs.set(fork.rows[i]!.blobName, gzipSync(payloadBytes([e]))); previous = c.chainHash;
  }
  fork.manifest = { ...fork.manifest, entity: { ...fork.manifest.entity, chainHash: previous, headHash: fork.rows.at(-1)!.headHash, lastBatchBlobName: fork.rows.at(-1)!.blobName } };
  const rebuilt = new RemoteSessionReader(fork.repository, { ...bounds, scope, pins: local.pins }); await assert.rejects(rebuilt.read(fork.sessionId), code('CONFLICT')); assert.deepEqual(local.pins.get(current), floor); await rebuilt.close();
});
test('A11 disk restart rehashes canonical bytes; forged verified sidecar cannot admit changed payload', async t => {
  const local = await fixture(); t.after(() => local.close()); const f = historyFixture(); const directory = join(local.root, 'private-cache');
  const options = { ...bounds, scope, pins: local.pins, cache: { directory, memoryBytes: 0, diskBytes: 10_000 } };
  const first = new RemoteSessionReader(f.repository, options); await first.read(f.sessionId); await first.close(); const downloads = f.calls.blob;
  const second = new RemoteSessionReader(f.repository, options); assert.equal((await second.read(f.sessionId))?.events.length, 2); assert.equal(f.calls.blob, downloads); await second.close();
  const namespace = historyNamespace(historyWatermark(historyScopeId(scope), f.manifest.entity)); const files = await readdir(join(directory, namespace)); const chunk = files.find(name => name.endsWith('.gz'))!;
  await writeFile(join(directory, namespace, chunk), gzipSync(Buffer.from('forged\n')), { mode: 0o600 });
  const index = JSON.parse(await readFile(join(directory, namespace, 'index.json'), 'utf8')); index.verified = true; index.localizedJsonl = 'not a witness'; await writeFile(join(directory, namespace, 'index.json'), JSON.stringify(index), { mode: 0o600 });
  const third = new RemoteSessionReader(f.repository, options); assert.equal((await third.read(f.sessionId))?.events.length, 2); assert.equal(f.calls.blob, downloads + 1, 'one guarded selected-chain reconstruction repairs only the damaged canonical chunk'); await third.close();
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  for (const name of await readdir(join(directory, namespace))) assert.equal((await lstat(join(directory, namespace, name))).mode & 0o777, 0o600);
});
test('A12 whole-prefix disk eviction preserves H and no hole advertises payload completeness', async t => {
  const local = await fixture(); t.after(() => local.close()); const one = historyFixture(2, 'one'); const two = historyFixture(2, 'two');
  const weight = [...one.blobs.values()].reduce((sum, bytes) => sum + bytes.length, 0); const directory = join(local.root, 'bounded');
  const options = { ...bounds, scope, pins: local.pins, cache: { directory, memoryBytes: 0, diskBytes: weight + 10 } };
  const a = new RemoteSessionReader(one.repository, options); await a.read(one.sessionId); await a.close();
  const b = new RemoteSessionReader(two.repository, options); await b.read(two.sessionId); await b.close();
  assert.equal((await readdir(directory)).length, 1); assert.equal(local.pins.get(historyWatermark(historyScopeId(scope), one.manifest.entity))?.eventCount, 2);
  const before = one.calls.blob; const observed = new RemoteSessionReader(one.repository, options); await observed.observe(one.sessionId); assert.equal(one.calls.blob, before); await observed.close();
});
test('A12 content-only partial chunks survive a finite failure without becoming a complete prefix or H', async t => {
  const local = await fixture(); t.after(() => local.close()); const f = historyFixture(3); const directory = join(local.root, 'partial');
  let fail = true; f.beforeBlob = name => { if (fail && name === f.rows[1]!.blobName) throw new AzureSyncError('TRANSIENT', 'Injected finite transport failure.'); };
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: local.pins, cache: { directory } });
  await assert.rejects(reader.read(f.sessionId), code('TRANSIENT')); assert.equal((await reader.observe(f.sessionId))?.acceptedPin, undefined);
  const namespace = historyNamespace(historyWatermark(historyScopeId(scope), f.manifest.entity)); assert.equal((await readdir(join(directory, namespace))).includes('index.json'), false);
  fail = false; assert.equal((await reader.read(f.sessionId))?.events.length, 3); assert.equal(f.calls.blob, 4, 'completed first chunk is rehashed and reused, not downloaded again'); await reader.close();
});
test('A19 private cache refuses symlink roots and chunks without reading path-escaped data', async t => {
  const local = await fixture(); t.after(() => local.close()); const f = historyFixture(); const outside = join(local.root, 'outside'); await import('node:fs/promises').then(fs => fs.mkdir(outside, { mode: 0o700 }));
  const directory = join(local.root, 'linked'); await symlink(outside, directory);
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: local.pins, cache: { directory, memoryBytes: 10_000 } }); await reader.read(f.sessionId); assert.deepEqual(await readdir(outside), []); await reader.close();
});
test('A19 required authoritative pin schema/version corruption fails closed rather than bootstrap', async t => {
  const local = await fixture(); t.after(() => local.close()); const f = historyFixture(); const w = historyWatermark(historyScopeId(scope), f.manifest.entity); await local.pins.accept(w); await local.pins.close();
  const entries = await readdir(join(local.root, 'metadata')); const document = entries.find(name => name.endsWith('.json'))!; assert.ok(document, 'single-layout authoritative domain document exists');
  const path = join(local.root, 'metadata', document); const record = JSON.parse(await readFile(path, 'utf8')); record.unit.version = 999; await writeFile(path, JSON.stringify(record));
  await assert.rejects(local.pins.open());
  // Restore only to permit the fixture's normal close; not a production recovery mechanism.
  record.unit.version = 1; await writeFile(path, JSON.stringify(record));
});
