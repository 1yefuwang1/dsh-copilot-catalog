import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TombstoneManager } from '../src/sync/tombstone-manager.js';
import type { CloudRepository, StoredManifest } from '../src/sync/cloud-repository.js';
import type { LocalStore } from '../src/local/store.js';
import type { BatchRow, CloudSessionEntity } from '../src/schema.js';
import { localSession, batchRow, cloudSession } from './helpers.js';

class MemoryRepo {
  manifest: StoredManifest;
  rows: BatchRow[];
  blobs = new Set<string>();
  deletedRows: string[] = [];
  constructor(entity: CloudSessionEntity, rows: BatchRow[]) {
    this.manifest = { entity, etag: 'e1' };
    this.rows = rows;
    for (const row of rows) this.blobs.add(row.blobName);
  }
  async getManifest() { return this.manifest; }
  async updateManifest(entity: CloudSessionEntity) { this.manifest = { entity, etag: 'e2' }; }
  async listBatchRows() { return this.rows.filter((row) => this.blobs.has(row.blobName)); }
  async deleteBatchRow(rowKey: string) { this.deletedRows.push(rowKey); this.rows = this.rows.filter((row) => row.rowKey !== rowKey); }
  async deleteBatchBlob(name: string) { this.blobs.delete(name); }
}

test('remove tombstones, sweeps only the current generation, and resurrect resets the chain', async () => {
  const entity = cloudSession({ sessionId: 's', generation: 2, state: 'active', enabled: true, writerEpoch: 4 });
  const old = batchRow('s', 2, 0, { blobName: 'old' });
  const future = batchRow('s', 3, 0, { blobName: 'future' });
  const repo = new MemoryRepo(entity, [old, future]);
  const records = new Map([['s', localSession({ sessionId: 's', enabled: true, generation: 2, state: 'active' })]]);
  const local = { getSession: (id: string) => records.get(id), putSession: async (record: ReturnType<typeof localSession>) => { records.set(record.sessionId, record); } } as unknown as LocalStore;
  const manager = new TombstoneManager(repo as unknown as CloudRepository, local, () => 10);
  await manager.remove('s', 2);
  assert.equal(repo.manifest.entity.state, 'deleted');
  assert.deepEqual(repo.deletedRows, [old.rowKey]);
  assert.deepEqual([...repo.blobs], ['future']);
  assert.equal(records.get('s')?.state, 'deleted');
  await manager.remove('s', 2);
  assert.equal(repo.deletedRows.length, 1);
  const revived = await manager.resurrect('s');
  assert.equal(revived.generation, 3);
  assert.equal(revived.eventCount, 0);
  assert.equal(records.get('s')?.state, 'active');
  assert.equal(records.get('s')?.generation, 3);
});
