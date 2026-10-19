import assert from 'node:assert/strict';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type AgentHandle } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionId, SessionStore, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { LlmRuntime, LlmAdapter, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory';
import { Storage } from '@deepseek-ai/dsh-storage';
import { LocalStore } from '../src/local/store.js';
import { Config } from '../src/config.js';
import { AzureSyncError } from '../src/azure/errors.js';
import type { BatchRow, CloudSessionEntity } from '../src/schema.js';
import type { CloudRepository, StoredBatch, StoredManifest } from '../src/sync/cloud-repository.js';
import type { SessionLease, SessionLeaseManager } from '../src/sync/lease-manager.js';
import { nodeCwdFs } from '../src/sync/effective-cwd.js';
import { Importer } from '../src/sync/importer.js';
import { ImportService } from '../src/sync/import-service.js';
import { PersistenceSessionSource } from '../src/sync/session-source.js';
import { ProjectionWarmer } from '../src/sync/projection-warmer.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { SyncService } from '../src/sync/service.js';
import { TombstoneManager } from '../src/sync/tombstone-manager.js';
import { Uploader } from '../src/sync/uploader.js';
import { pathMapping } from './helpers.js';

const clone = <T>(value: T): T => structuredClone(value);
export const route = { provider: 'fixture', model: 'no-network' };

/** Conditional immutable cloud transport; the sync/import/reconcile runtimes are real. */
export class AcceptanceCloud {
  readonly partitionKey = 'account';
  readonly manifests = new Map<string, StoredManifest>();
  readonly rows = new Map<string, StoredBatch>();
  readonly candidates = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  readonly reads: string[] = [];
  readonly activeLeases = new Map<string, { owner: string; epoch: number }>();
  private revision = 0;
  private etag(): string { return `etag-${++this.revision}`; }
  async getManifest(id: string): Promise<StoredManifest | undefined> { return clone(this.manifests.get(id)); }
  async createManifest(entity: CloudSessionEntity): Promise<boolean> {
    if (this.manifests.has(entity.sessionId)) return false;
    this.manifests.set(entity.sessionId, { entity: clone(entity), etag: this.etag() });
    return true;
  }
  async updateManifest(entity: CloudSessionEntity, etag: string): Promise<void> {
    if (this.manifests.get(entity.sessionId)?.etag !== etag) throw new AzureSyncError('PRECONDITION', 'Stale manifest ETag.');
    this.manifests.set(entity.sessionId, { entity: clone(entity), etag: this.etag() });
  }
  async commitBatch(proof: StoredManifest, row: BatchRow, next: CloudSessionEntity): Promise<StoredManifest> {
    const current = this.manifests.get(row.sessionId);
    if (current?.etag !== proof.etag || current.entity.writerEpoch !== next.writerEpoch || current.entity.state !== 'active' || !current.entity.enabled) throw new AzureSyncError('PRECONDITION', 'Stale publication proof.');
    if (this.rows.has(row.rowKey)) throw new AzureSyncError('CONFLICT', 'Committed rows are immutable.');
    assert.ok(this.candidates.has(row.blobName), 'the immutable blob precedes its row/tip transaction');
    this.rows.set(row.rowKey, { entity: clone(row), etag: this.etag() });
    const stored = { entity: clone(next), etag: this.etag() };
    this.manifests.set(row.sessionId, stored);
    return clone(stored);
  }
  async putCandidate(name: string, bytes: Uint8Array, metadata: Record<string, string>) {
    if (this.candidates.has(name)) return { status: 'exists' as const };
    this.candidates.set(name, { bytes: Buffer.from(bytes), metadata: clone(metadata) });
    return { status: 'created' as const };
  }
  async readCandidate(name: string): Promise<Buffer> {
    this.reads.push(name);
    const value = this.candidates.get(name);
    assert.ok(value, `candidate ${name} exists`);
    return Buffer.from(value.bytes);
  }
  async listBatchRows(id: string, generation: number): Promise<BatchRow[]> {
    return [...this.rows.values()].filter(row => row.entity.sessionId === id && row.entity.generation === generation).map(row => clone(row.entity));
  }
  async *iterateBatchRows(id: string, generation: number): AsyncGenerator<StoredBatch> {
    for (const row of [...this.rows.values()]) if (row.entity.sessionId === id && row.entity.generation === generation) yield clone(row);
  }
  async *listDescendants(id: string, generation: number): AsyncGenerator<StoredManifest> {
    for (const value of this.manifests.values()) if (value.entity.sessionId !== id && value.entity.rootSessionId === id && value.entity.rootGeneration === generation) yield clone(value);
  }
  async assertCleanup(proof: StoredManifest): Promise<void> {
    const current = this.manifests.get(proof.entity.sessionId);
    if (current?.etag !== proof.etag || current.entity.state !== 'deleted' || current.entity.cleanupPending !== true) throw new AzureSyncError('PRECONDITION', 'Stale cleanup fence.');
  }
  async deleteBatchBlob(name: string, proof: StoredManifest): Promise<void> { await this.assertCleanup(proof); this.candidates.delete(name); }
  async deleteBatchRow(row: StoredBatch, proof: StoredManifest): Promise<void> { await this.assertCleanup(proof); assert.equal(this.rows.get(row.entity.rowKey)?.etag, row.etag); this.rows.delete(row.entity.rowKey); }
  async *listGenerationBlobs(id: string, generation: number): AsyncGenerator<string> {
    const prefix = `v1/sessions/${Buffer.from(id).toString('base64url')}/gen-${generation}/`;
    for (const name of this.candidates.keys()) if (name.startsWith(prefix)) yield name;
  }
  async deleteLeaseBlob(proof: StoredManifest): Promise<void> { await this.assertCleanup(proof); this.activeLeases.delete(proof.entity.sessionId); }
  readonly blob = { getMetadata: async (name: string) => clone(this.candidates.get(name)?.metadata ?? {}), ensureEmptyBlob: async () => {} };
  asRepository(): CloudRepository { return this as unknown as CloudRepository; }
  leases(owner: string): SessionLeaseManager {
    const cloud = this;
    const proof = async (id: string, epoch: number): Promise<StoredManifest> => {
      const manifest = await cloud.getManifest(id);
      if (manifest === undefined || manifest.entity.writerEpoch !== epoch || cloud.activeLeases.get(id)?.owner !== owner || cloud.activeLeases.get(id)?.epoch !== epoch) throw new AzureSyncError('LEASE_LOST', 'Server lease/epoch no longer owned.');
      return manifest;
    };
    return {
      async acquire(id: string): Promise<SessionLease> {
        if (cloud.activeLeases.has(id)) throw new AzureSyncError('CONFLICT', 'Another device owns this session.');
        const manifest = await cloud.getManifest(id); assert.ok(manifest);
        const epoch = manifest.entity.writerEpoch + 1;
        await cloud.updateManifest({ ...manifest.entity, writerEpoch: epoch, leaseOwner: owner, leaseUntil: Date.now() + 60_000 }, manifest.etag);
        cloud.activeLeases.set(id, { owner, epoch });
        return { sessionId: id, deviceId: owner, epoch, handle: {} as never, manifest: (await cloud.getManifest(id))! };
      },
      proof,
      async renew(lease: SessionLease): Promise<SessionLease> { return { ...lease, manifest: await proof(lease.sessionId, lease.epoch) }; },
      async release(lease: SessionLease): Promise<void> { if (cloud.activeLeases.get(lease.sessionId)?.owner === owner && cloud.activeLeases.get(lease.sessionId)?.epoch === lease.epoch) cloud.activeLeases.delete(lease.sessionId); },
    } as unknown as SessionLeaseManager;
  }
}

/** Real JSONL + real retained AgentLoop + real cwd/projection registry per device. */
export async function acceptanceDevice(root: string, deviceId: string, cloud: AcceptanceCloud, canonicalRoot?: string) {
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(cwd, 'nested'), { recursive: true });
  const localRoot = await realpath(cwd);
  const ctx = new Context();
  const scopes: Array<ReturnType<Context['plugin']>> = [];
  const handles: AgentHandle[] = [];
  const mount = async (plugin: Parameters<Context['plugin']>[0], config?: unknown) => {
    const scope = ctx.plugin(plugin, config); scopes.push(scope); await scope.await();
    assert.equal(scope.state, 2, `public plugin ${String((plugin as { name?: string }).name)} mounted`);
    return scope;
  };
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx);
  ctx.provide('fs', {
    async resolve(path: string, options?: { cwd?: string }) { return { path: await realpath(isAbsolute(path) ? path : resolve(options?.cwd ?? localRoot, path)) }; },
    async stat(target: { path: string }) { const info = await stat(target.path); return { type: info.isDirectory() ? 'directory' : 'file' }; },
    processPath: (target: { path: string }) => target.path,
  });
  new LlmRuntime(ctx);
  let llmCalls = 0;
  class NoNetworkAdapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      llmCalls += 1;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Fixture completion.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture completion.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new NoNetworkAdapter() as never);
  await mount(JsonlPersistence, { root: join(root, 'logs'), compression: 'none' });
  await mount(WorkingDirectoryService, { defaultDirectory: localRoot });
  const loopScope = await mount(AgentLoop, {});
  new Storage(ctx);
  const backend = new JsonStorageBackend(join(root, 'domain'));
  ctx.storage.backend.register('fixture-json', backend);
  const facility = new DomainFacility(ctx, { backend: 'fixture-json' });
  const local = new LocalStore(facility); await local.open();
  const config = Config({ maxBatchEvents: 4 });
  const mapping = pathMapping({ id: deviceId === 'device-a' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002', revision: '1'.repeat(64), remotePrefix: canonicalRoot ?? localRoot, localPrefix: localRoot, remotePlatform: 'linux' });
  const binding = { mapping, fs: nodeCwdFs };
  const source = new PersistenceSessionSource(ctx.sessionPersistence);
  // The installed public SDK supplies the real fold registry, not the optional
  // sessionProjectionCache host service. This cache port runs its actual restore
  // algorithm; assertions below inspect the resulting cwd/asOfSeq, never a stub.
  const checkpoints = new Map<string, ReturnType<Context['sessionProjections']['snapshot']>>();
  const cache = {
    coldSnapshot(header: SessionHeader, inherited: number, events: readonly SessionEvent[]) {
      const restored = ctx.sessionProjections.restore({}, events, 0 as never, header, inherited as never);
      checkpoints.set(header.id, restored.snapshot);
    },
    cachedSnapshot(header: SessionHeader) { return checkpoints.get(header.id); },
  };
  const projection = new ProjectionWarmer({ cache: cache as never, pollMs: 1 });
  const importer = new Importer({ config, persistence: ctx.sessionPersistence, repository: cloud.asRepository(), local, cwdBinding: async () => binding, projection, now: Date.now });
  const imports = new ImportService(importer);
  const uploader = new Uploader({ config, source, repository: cloud.asRepository(), leases: cloud.leases(deviceId), local, deviceId, platform: 'linux', cwdBinding: async () => binding, now: Date.now });
  const reader = new RemoteSessionReader(cloud.asRepository(), { maxCompressedBytes: 1_048_576, maxExpandedBytes: config.maxBatchBytes });
  const service = new SyncService({ uploader, local, imports, reader, source, agents: ctx.agents, repository: cloud.asRepository(), conflictDirectory: join(root, 'exports'), tombstones: new TombstoneManager(cloud.asRepository(), local, Date.now, deviceId), now: Date.now });
  let writeOpens = 0;
  const persistence = ctx.sessionPersistence;
  const originalOpen = persistence.open.bind(persistence);
  persistence.open = ((...args: Parameters<typeof persistence.open>) => {
    if (args[1] === 'write') writeOpens += 1;
    return originalOpen(...args);
  }) as typeof persistence.open;
  let closed = false;
  return {
    ctx, local, facility, service, uploader, imports, reader, source, root, cwd: localRoot, checkpoints,
    get llmCalls() { return llmCalls; }, get writeOpens() { return writeOpens; },
    async create(id: string) { const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: localRoot }, agentOptions: route }); handles.push(handle); return handle.agent; },
    async resume(id: string) { const handle = await ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions: route }); handles.push(handle); return handle.agent; },
    async stopHost() { await loopScope.dispose(); assert.equal(ctx.agents.list().length, 0); },
    prompt(text: string) { return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }); },
    async close() {
      if (closed) return; closed = true;
      await service.close();
      for (const handle of handles.reverse()) await handle.dispose();
      for (const scope of scopes.reverse()) await scope.dispose();
      await local.close(); await facility.closeAll(); await backend.close();
    },
  };
}
export type AcceptanceDevice = Awaited<ReturnType<typeof acceptanceDevice>>;
