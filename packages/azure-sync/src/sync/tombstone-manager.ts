/**
 * Generation-scoped cloud removal and explicit resurrection.
 * @module @1yefuwang1/dsh-azure-sync/sync/tombstone-manager
 */
import { AzureSyncError } from '../azure/errors.js';
import type { CloudRepository } from './cloud-repository.js';
import type { LocalStore } from '../local/store.js';
import type { CloudSessionEntity } from '../schema.js';
import type { LocalSessionRecord } from '../schema.js';
import { genesisHash } from './chain.js';
import { planCleanup } from './cleanup.js';
import { resurrect, tombstone } from './tombstone.js';

export class TombstoneManager {
  private readonly repository: CloudRepository;
  private readonly local: LocalStore;
  private readonly now: () => number;

  constructor(repository: CloudRepository, local: LocalStore, now: () => number) {
    this.repository = repository;
    this.local = local;
    this.now = now;
  }

  async remove(sessionId: string, generation: number): Promise<void> {
    const manifest = await this.repository.getManifest(sessionId);
    if (manifest === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud session does not exist.');
    if (manifest.entity.state === 'deleted') return;
    if (manifest.entity.generation !== generation) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation changed before removal.');
    const dead = tombstone(manifest.entity, this.now()).entity;
    await this.repository.updateManifest(dead, manifest.etag);
    const rows = await this.repository.listBatchRows(sessionId, generation);
    const cleanup = planCleanup(rows, dead);
    for (const row of cleanup.rows) await this.repository.deleteBatchRow(row.rowKey).catch(() => undefined);
    for (const name of cleanup.blobNames) await this.repository.deleteBatchBlob(name).catch(() => undefined);
    const record = this.local.getSession(sessionId);
    if (record !== undefined) await this.local.putSession({ ...record, state: 'deleted', enabled: false, status: 'detached', generation: dead.generation, lastError: undefined });
  }

  async resurrect(sessionId: string): Promise<CloudSessionEntity> {
    const manifest = await this.repository.getManifest(sessionId);
    if (manifest === undefined) throw new AzureSyncError('NOT_FOUND', 'The cloud session does not exist.');
    const revived = resurrect(manifest.entity, this.now());
    if (revived === manifest.entity) return revived;
    const generation = revived.generation;
    const chain = genesisHash(sessionId, generation, revived.headerHash, 4);
    const reset: CloudSessionEntity = {
      ...revived, generation, eventCount: 0, headSeq: 0, headHash: chain, chainHash: chain,
      batchCount: 0, lastBatchRowKey: undefined, lastBatchGeneration: undefined,
      lastBatchBlobName: undefined, lastWriterDevice: undefined,
    };
    await this.repository.updateManifest(reset, manifest.etag);
    const record = this.local.getSession(sessionId);
    if (record !== undefined) await this.local.putSession({ ...record, state: 'active', enabled: true, generation, status: 'setup-needed', ...(reset.previousGeneration === undefined ? {} : {}) });
    return reset;
  }
}

export type { LocalSessionRecord };
