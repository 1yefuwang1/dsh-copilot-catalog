import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { TransactionAction } from '@azure/data-tables';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { BlobStore } from '../src/azure/blob.js';
import type { TableStore } from '../src/azure/table.js';
import { Config } from '../src/config.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { CloudRepository, type StoredManifest } from '../src/sync/cloud-repository.js';
import { Uploader, type UploadDependencies } from '../src/sync/uploader.js';
import type { SessionLease, SessionLeaseManager, SessionLeaseSeconds } from '../src/sync/lease-manager.js';
import type { SourceSnapshot } from '../src/sync/session-source.js';
import { canonicalJson } from '../src/sync/canonical.js';
import { cloudSessionEntitySchema, decodeCloudRecord, type CloudSessionEntity, type LocalSessionRecord } from '../src/schema.js';
import { decodeGitContextJson, type GitContext, type GitCreationBase } from '../src/git/context.js';
import { localSession, cloudSession } from './helpers.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const remote = { name: 'origin', sanitizedUrl: 'https://example.invalid/repo' };
/** Conditional wire transport only; CloudRepository/Uploader/chain and authority logic are real. */
class Tables {
  readonly rows = new Map<string, { value: Record<string, unknown>; etag: string }>();
  readonly metadata: CloudSessionEntity[] = [];
  beforeMetadata?: () => void | Promise<void>;
  private revision = 0;
  private key(value: Record<string, unknown>) { return String(value['partitionKey']) + '\0' + String(value['rowKey']); }
  async get(partition: string, row: string) { const stored = this.rows.get(partition + '\0' + row); return stored ? { value: { ...structuredClone(stored.value), etag: stored.etag }, etag: stored.etag } : undefined; }
  async insert(value: Record<string, unknown>) { const key = this.key(value); if (this.rows.has(key)) return false; this.rows.set(key, { value: structuredClone(value), etag: `etag-${++this.revision}` }); return true; }
  async update(value: Record<string, unknown>, etag: string) { return this.submitTransaction([['update', value as never, 'Replace', { etag }]]); }
  async submitTransaction(actions: TransactionAction[]) {
    const first = actions[0] as unknown[] | undefined, firstValue = first?.[1] as Record<string, unknown> | undefined;
    const previous = firstValue ? this.rows.get(this.key(firstValue)) : undefined;
    const metadata = first?.[0] === 'update' && firstValue && previous && firstValue['gitJson'] !== previous.value['gitJson'] && canonicalJson(firstValue['eventCount']) === canonicalJson(previous.value['eventCount']);
    if (metadata) await this.beforeMetadata?.();
    const draft = new Map(this.rows);
    for (const raw of actions) {
      const action = raw as unknown[], value = action[1] as Record<string, unknown>, key = this.key(value), old = draft.get(key);
      if (action[0] === 'create') { if (old) throw new AzureSyncError('CONFLICT', 'Conditional fixture row exists.'); }
      else { if (!old || old.etag !== (action[3] as { etag: string }).etag) throw new AzureSyncError('PRECONDITION', 'Conditional fixture ETag changed.'); }
      draft.set(key, { value: structuredClone(value), etag: `etag-${++this.revision}` });
    }
    this.rows.clear(); for (const [key, value] of draft) this.rows.set(key, value);
    if (metadata && firstValue) this.metadata.push(decodeCloudRecord(cloudSessionEntitySchema, { ...firstValue, etag: 'accepted' }, 'metadata fixture').record);
    return { subResponses: [], status: 204 };
  }
  async *list(filter: string) {
    const partition = /PartitionKey eq '([^']+)'/u.exec(filter)?.[1];
    const equal = /RowKey eq '([^']+)'/u.exec(filter)?.[1], lower = /RowKey ge '([^']+)'/u.exec(filter)?.[1], upper = /RowKey lt '([^']+)'/u.exec(filter)?.[1];
    for (const entry of this.rows.values()) {
      const row = String(entry.value['rowKey']);
      if (partition && entry.value['partitionKey'] !== partition || equal && row !== equal || lower && row < lower || upper && row >= upper) continue;
      yield { value: { ...structuredClone(entry.value), etag: entry.etag }, etag: entry.etag };
    }
  }
}
class Leases {
  lost = false;
  constructor(readonly repository: CloudRepository, readonly deviceId: string) {}
  async acquire(sessionId: string, _signal?: AbortSignal, durationSeconds: SessionLeaseSeconds = 60): Promise<SessionLease> {
    const old = await this.repository.getManifest(sessionId); assert.ok(old);
    const next = { ...old.entity, writerEpoch: old.entity.writerEpoch + 1, leaseOwner: this.deviceId, leaseUntil: Date.now() + durationSeconds * 1000 };
    await this.repository.updateManifest(next, old.etag);
    const manifest = await this.repository.getManifest(sessionId); assert.ok(manifest);
    return { sessionId, deviceId: this.deviceId, epoch: next.writerEpoch, durationSeconds, handle: {} as never, manifest };
  }
  async proof(sessionId: string, epoch: number): Promise<StoredManifest> {
    const current = await this.repository.getManifest(sessionId); assert.ok(current);
    if (this.lost || current.entity.writerEpoch !== epoch || current.entity.leaseOwner !== this.deviceId) throw new AzureSyncError('LEASE_LOST', 'Fixture foreign writer.');
    return current;
  }
  async renew(lease: SessionLease) { return { ...lease, manifest: await this.proof(lease.sessionId, lease.epoch) }; }
  async release() {}
}
function localStore(record: LocalSessionRecord) {
  let current = record, lane: Promise<unknown> = Promise.resolve();
  return { getSession: () => current, putSession: async (next: LocalSessionRecord) => { current = next; },
    transactSession(_sid: string, fn: (value: LocalSessionRecord | undefined) => LocalSessionRecord | undefined) {
      const next = lane.then(() => { const value = fn(current); if (value) current = value; return value; }); lane = next.then(() => undefined, () => undefined); return next;
    }, get() { return current; } };
}
async function fixture(t: TestContext, child = false) {
  const sid = child ? 'metadata-child' : 'metadata-thread', tables = new Tables(), blobs = new Map<string, { data: Buffer; metadata: Record<string, string> }>();
  const blob = { async putIfAbsent(name: string, bytes: Uint8Array, metadata: Record<string, string>) { if (blobs.has(name)) return 'exists'; blobs.set(name, { data: Buffer.from(bytes), metadata: structuredClone(metadata) }); return 'created'; }, async read(name: string) { const stored = blobs.get(name); assert.ok(stored); return Buffer.from(stored.data); }, async exists(name: string) { return blobs.has(name); }, async getMetadata(name: string) { return blobs.get(name)?.metadata ?? {}; }, async *list(prefix: string) { for (const [name, stored] of blobs) if (name.startsWith(prefix)) yield { name, sizeBytes: stored.data.length }; } };
  const repository = new CloudRepository(blob as unknown as BlobStore, tables as unknown as TableStore);
  if (child) await repository.createManifest(cloudSession({ sessionId: 'root', rootSessionId: 'root', generation: 1, rootGeneration: 1 }));
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId(sid), createdAt: 1, cwd: '/local/project', isSeeded: false, delegationDepth: child ? 1 : 0, ...(child ? { origin: 'subagent' as const, parentSession: SessionId('root') } : {}) };
  const events: SourceSnapshot['events'] = [0, 1, 2].map(index => ({ type: 'user/message', surfaceOp: 'append', seq: SessionSeq(index), time: 1000 + index, data: createUserMessage({ content: [{ type: 'text', text: `Metadata fixture message ${index}` }], source: { kind: 'user' } }) }));
  const snapshot: SourceSnapshot = { header, inheritedEventCount: 0, events };
  const local = localStore(localSession({ sessionId: sid })), leases = new Leases(repository, 'device');
  let currentHead = b, creationBase: GitCreationBase | undefined = { kind: 'remote', ref: 'refs/heads/dev', remote, oid: a }, captures = 0;
  let beforeCapture: (() => void | Promise<void>) | undefined;
  const anchors: { generation: number; headerHash: string; eventCount: number; chainHash: string }[] = [];
  const gitContext: NonNullable<UploadDependencies['gitContext']> = async (_sid, anchor) => {
    anchors.push({ ...anchor }); const observedAt = ++captures; await beforeCapture?.();
    return { v: 2, observation: { ...anchor, deviceId: 'device', observedAt }, repository: { objectFormat: 'sha1', root: '/repo', worktree: true }, ...(creationBase ? { creationBase } : {}), current: { branchRef: 'refs/heads/worktree/current', headOid: currentHead, detached: false, unborn: false, dirty: 'clean', upstream: { kind: 'remote', ref: 'refs/heads/feature', remote } } };
  };
  const uploader = new Uploader({ config: Config({ maxBatchEvents: 1 }), source: { async flush() {}, async read() { return snapshot; }, async stat() { return { header, eventCount: events.length }; } }, repository, leases: leases as unknown as SessionLeaseManager, local: local as never, deviceId: 'device', platform: 'linux', now: () => 1000 + captures, gitContext });
  t.after(() => uploader.close());
  return { sid, tables, blobs, repository, uploader, leases, local, anchors, setHead(value: string) { currentHead = value; }, setBase(value: GitCreationBase | undefined) { creationBase = value; }, onCapture(value: (() => void | Promise<void>) | undefined) { beforeCapture = value; }, async manifest() { const value = await repository.getManifest(sid); assert.ok(value); return value; } };
}
const history = (value: CloudSessionEntity) => ({ headerJson: value.headerJson, headerHash: value.headerHash, generation: value.generation, inheritedEventCount: value.inheritedEventCount, eventCount: value.eventCount, chainHash: value.chainHash, headHash: value.headHash, headSeq: value.headSeq, batchCount: value.batchCount, lastBatchRowKey: value.lastBatchRowKey, lastBatchGeneration: value.lastBatchGeneration, lastBatchBlobName: value.lastBatchBlobName });
const parsed = (value: StoredManifest): GitContext => { const data = decodeGitContextJson(value.entity.gitJson); assert.ok(data?.v === 2); return data; };

test('real repository publication captures each exact batch candidate and no-event Sync updates only Git metadata', async t => {
  const f = await fixture(t); await f.uploader.sync(f.sid, { release: true });
  const before = await f.manifest(), beforeRows = f.tables.rows.size, beforeBlobs = f.blobs.size;
  const original = parsed(before); assert.equal(original.current.headOid, b); assert.equal(original.creationBase?.oid, a);
  assert.deepEqual(f.anchors.slice(0, 4).map(value => value.eventCount), [0, 1, 2, 3]);
  f.setHead(c); const result = await f.uploader.sync(f.sid, { release: true }); const after = await f.manifest();
  assert.equal(result.uploadedBatches, 0); assert.equal(parsed(after).current.headOid, c);
  assert.deepEqual(history(after.entity), history(before.entity)); assert.equal(f.tables.rows.size, beforeRows); assert.equal(f.blobs.size, beforeBlobs);
  for (const entity of f.tables.metadata) { const ctx = parsed({ entity, etag: 'fixture' }); assert.equal(ctx.observation.eventCount, entity.eventCount); assert.equal(ctx.observation.chainHash, entity.chainHash); assert.equal(ctx.observation.headerHash, entity.headerHash); }
});

test('receiving placement never erases or replaces known original creation A within one cloud generation', async t => {
  const f = await fixture(t); await f.uploader.sync(f.sid, { release: true }); const original = parsed(await f.manifest()).creationBase;
  f.setBase(undefined); f.setHead(c); await f.uploader.sync(f.sid, { release: true });
  assert.deepEqual(parsed(await f.manifest()).creationBase, original);
  f.setBase({ kind: 'local', ref: 'refs/heads/new-receiving-base', oid: c }); await f.uploader.sync(f.sid, { release: true });
  assert.deepEqual(parsed(await f.manifest()).creationBase, original);
});

test('failed advisory capture preserves exact prior creation context without pretending a fresh observation', async t => {
  const f = await fixture(t); await f.uploader.sync(f.sid, { release: true }); const before = await f.manifest();
  f.setBase(undefined); f.onCapture(() => { throw new Error('advisory inspection failed'); });
  const result = await f.uploader.sync(f.sid, { release: true }); const after = await f.manifest();
  assert.equal(result.uploadedBatches, 0); assert.equal(after.entity.gitJson, before.entity.gitJson);
  assert.deepEqual(history(after.entity), history(before.entity));
  assert.deepEqual(parsed(after).creationBase, parsed(before).creationBase);
});

test('failed capture preserves exact prior v2 observation even when no creation base was ever known', async t => {
  const f = await fixture(t); f.setBase(undefined); await f.uploader.sync(f.sid, { release: true });
  const before = await f.manifest(); assert.equal(parsed(before).creationBase, undefined);
  f.onCapture(() => { throw new Error('transient capture failure'); }); f.setHead(c);
  await f.uploader.sync(f.sid, { release: true }); const after = await f.manifest();
  assert.equal(after.entity.gitJson, before.entity.gitJson); assert.deepEqual(history(after.entity), history(before.entity));
  assert.equal(parsed(after).current.headOid, b, 'retained stale observation is not restamped as current C');
});

test('failed new capture preserves exact prior legacy v1 bytes instead of omitting gitJson in Table Replace', async t => {
  const f = await fixture(t); await f.uploader.sync(f.sid, { release: true }); const existing = await f.manifest();
  const legacy = JSON.stringify({ v: 1, root: '/repo', branch: 'legacy-local', commit: b, detached: false, unborn: false, worktree: false, dirty: 'clean' }, null, 2);
  await f.repository.updateManifest({ ...existing.entity, gitJson: legacy }, existing.etag);
  f.onCapture(() => { throw new Error('transient capture failure'); });
  await f.uploader.sync(f.sid, { release: true }); const after = await f.manifest();
  assert.equal(after.entity.gitJson, legacy); assert.deepEqual(history(after.entity), history(existing.entity));
});

test('metadata CAS retry rereads Git for its exact candidate instead of replaying a pre-loop string', async t => {
  const f = await fixture(t); await f.uploader.sync(f.sid, { release: true }); f.setHead(c);
  let changed = false;
  f.tables.beforeMetadata = async () => {
    if (changed) return; changed = true; const current = await f.manifest();
    await f.repository.updateManifest({ ...current.entity, updatedAt: current.entity.updatedAt + 1 }, current.etag);
  };
  const previous = f.anchors.length; await f.uploader.sync(f.sid, { release: true });
  assert.ok(f.anchors.length >= previous + 2); assert.equal(parsed(await f.manifest()).observation.observedAt, f.anchors.length);
});

test('metadata child update conditionally touches active root and cannot publish after root deletion', async t => {
  const f = await fixture(t, true); await f.uploader.sync(f.sid, { release: true }); const before = await f.manifest(); f.setHead(c);
  let deleted = false;
  f.tables.beforeMetadata = async () => {
    if (deleted) return; deleted = true; const root = await f.repository.getManifest('root'); assert.ok(root);
    await f.repository.updateManifest({ ...root.entity, state: 'deleted', enabled: false, leaseOwner: undefined, leaseUntil: undefined, deletedAt: Date.now(), deletedBy: 'fixture' }, root.etag);
  };
  await assert.rejects(f.uploader.sync(f.sid, { release: true }), error => error instanceof AzureSyncError && error.code === 'GENERATION_CHANGED');
  assert.equal((await f.manifest()).entity.gitJson, before.entity.gitJson);
});

test('Off preempts an ignored-abort Git read and cannot let stale metadata reenable local/cloud intent', async t => {
  const f = await fixture(t); await f.uploader.sync(f.sid, { release: true }); const before = await f.manifest(); f.setHead(c);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(yes => { entered = yes; }), pending = new Promise<void>(yes => { release = yes; });
  f.onCapture(async () => { entered(); await pending; });
  const sync = f.uploader.sync(f.sid, { release: true }), rejected = assert.rejects(sync, error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  await started; const stopping = f.uploader.disable(f.sid); await f.local.transactSession(f.sid, () => undefined);
  assert.equal(f.local.get().enabled, false); release(); await stopping; await rejected;
  assert.equal(f.local.get().enabled, false); assert.equal((await f.manifest()).entity.gitJson, before.entity.gitJson);
});

test('metadata-only repository method refuses any history/owner/generation substitution before transport', async t => {
  const f = await fixture(t); await f.uploader.sync(f.sid, { release: true }); const proof = await f.manifest(), before = f.tables.metadata.length;
  for (const patch of [{ eventCount: proof.entity.eventCount + 1 }, { generation: 2 }, { leaseOwner: 'foreign' }, { enabled: false }, { headerJson: '{}' }]) await assert.rejects(f.repository.commitMetadata(proof, { ...proof.entity, ...patch }));
  assert.equal(f.tables.metadata.length, before);
});
