/** Disposable private canonical payloads. Linux directory-FD capabilities fence path-swap races. */
import { isAbsolute, resolve } from 'node:path';
import { AzureSyncError } from '../azure/errors.js';
import { batchRowSchema, type BatchRow } from '../schema.js';
import { historyNamespace, historyWatermarkSchema, type HistoryWatermark } from './history-state.js';
import { sha256Hex, canonicalJson } from './canonical.js';
import { HistoryDirectory, secureHistoryFiles } from './history-files.js';
import type { HistoryOwner } from './history-work.js';
export interface HistoryCacheOptions {
  readonly directory?: string;
  readonly memoryBytes?: number;
  readonly diskBytes?: number;
  readonly maxMaterializations?: number;
  readonly maxFetches?: number;
}
export interface HistoryDiskPrefix { readonly watermark: HistoryWatermark; readonly rows: readonly BatchRow[]; readonly compressed: readonly Buffer[]; }
const safe = /^[a-f0-9]{64}$/u;
export class HistoryDiskCache {
  private readonly root?: string;
  private readonly budget: number;
  private lane: Promise<void> = Promise.resolve();
  private readonly latest = new Map<string, HistoryWatermark>();
  constructor(options: HistoryCacheOptions = {}, private readonly protectedNamespaces: (owner: HistoryOwner) => Promise<ReadonlySet<string>> = async () => new Set()) {
    this.budget = options.diskBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(this.budget) || this.budget < 0) throw new AzureSyncError('INVALID_CONFIG', 'The disk history budget is invalid.');
    if (options.directory !== undefined) {
      if (!isAbsolute(options.directory)) throw new AzureSyncError('INVALID_CONFIG', 'The private history directory must be absolute.');
      if (secureHistoryFiles) this.root = resolve(options.directory);
    }
  }
  get capacityBytes(): number { return this.root === undefined ? 0 : this.budget; }
  private object(row: BatchRow): string { return sha256Hex(row.blobName, '\0', row.payloadHash); }
  private async namespace<T>(w: HistoryWatermark, owner: HistoryOwner, create: boolean, action: (directory: HistoryDirectory) => Promise<T>): Promise<T> {
    const root = await HistoryDirectory.root(this.root!, owner, create);
    try { const directory = await root.directory(historyNamespace(w), owner, create); try { return await action(directory); } finally { await directory.close(); } }
    finally { await root.close(); }
  }
  async read(w: HistoryWatermark, maxCompressed: number, maxBatches: number, owner: HistoryOwner): Promise<HistoryDiskPrefix | undefined> {
    if (!this.root || this.budget === 0) return undefined;
    const operation = this.lane.then(async () => {
      try {
        return await this.namespace(w, owner, false, async directory => {
          const bytes = await directory.read('index.json', Math.min(16 * 1024 * 1024, 4096 + maxBatches * 4096), owner);
          const index = JSON.parse(bytes.toString('utf8')) as { version?: unknown; watermark?: unknown; rows?: unknown };
          if (index.version !== 1 || !Array.isArray(index.rows) || index.rows.length > maxBatches) return undefined;
          const watermark = historyWatermarkSchema.parse(index.watermark);
          if (historyNamespace(watermark) !== historyNamespace(w)) return undefined;
          const rows = index.rows.map(value => batchRowSchema.parse(value)), compressed: Buffer[] = [];
          let weight = 0;
          for (const row of rows) {
            const chunk = await directory.read(`${this.object(row)}.gz`, maxCompressed, owner); weight += chunk.length;
            if (weight > this.budget) return undefined; compressed.push(chunk);
          }
          return { watermark, rows, compressed };
        });
      } catch { await owner.check(); return undefined; }
    });
    this.lane = operation.then(() => {}, () => {}); return owner.wait(operation);
  }
  /** Content-only chunks carry neither prefix completeness nor permission authority. */
  async readChunk(w: HistoryWatermark, row: BatchRow, maxCompressed: number, owner: HistoryOwner): Promise<Buffer | undefined> {
    if (!this.root || this.budget === 0) return undefined;
    const operation = this.lane.then(async () => {
      try { return await this.namespace(w, owner, false, directory => directory.read(`${this.object(row)}.gz`, maxCompressed, owner)); }
      catch { await owner.check(); return undefined; }
    });
    this.lane = operation.then(() => {}, () => {}); return owner.wait(operation);
  }
  writeChunk(w: HistoryWatermark, row: BatchRow, bytes: Buffer, owner: HistoryOwner): Promise<boolean> { return this.write({ watermark: w, rows: [row], compressed: [bytes] }, owner, false); }
  async write(prefix: HistoryDiskPrefix, owner: HistoryOwner, complete = true): Promise<boolean> {
    if (!this.root || this.budget === 0) return false;
    const weight = prefix.compressed.reduce((sum, bytes) => sum + bytes.length, 0);
    const index = Buffer.from(canonicalJson({ version: 1, watermark: prefix.watermark, rows: prefix.rows }));
    if (weight > this.budget || index.length > 16 * 1024 * 1024) return false;
    const operation = this.lane.then(async () => {
      await owner.check(); const root = await HistoryDirectory.root(this.root!, owner, true);
      try {
        const key = historyNamespace(prefix.watermark);
        if (complete && (this.latest.get(key)?.eventCount ?? -1) > prefix.watermark.eventCount) return true;
        const entries: Array<{ name: string; bytes: number; time: number }> = []; let total = 0, own = 0;
        for (const name of await root.names(owner)) {
          if (!safe.test(name)) continue;
          const directory = await root.directory(name, owner);
          try {
            let bytes = 0;
            for (const file of await directory.names(owner)) {
              if (/^[a-f0-9-]{36}\.tmp$/u.test(file)) { await directory.remove(file, owner); continue; }
              if (!/^[a-f0-9]{64}\.gz$/u.test(file)) continue;
              const info = await directory.stat(file, owner); if (info.isFile() && !info.isSymbolicLink()) bytes += info.size;
            }
            if (name === key) own = bytes; else { total += bytes; entries.push({ name, bytes, time: (await directory.info(owner)).mtimeMs }); }
          } finally { await directory.close(); }
        }
        let nextWeight = complete ? weight : own + weight;
        if (!complete && own > 0) {
          // Replacing an existing content object does not reserve its compressed bytes twice.
          const directory = await root.directory(key, owner);
          try { for (const row of prefix.rows) { try { const stat = await directory.stat(`${this.object(row)}.gz`, owner); if (stat.isFile()) nextWeight -= stat.size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } }
          finally { await directory.close(); }
        }
        if (nextWeight > this.budget) return false;
        const protectedKeys = await this.protectedNamespaces(owner); await owner.check();
        const evictable = entries.filter(entry => !protectedKeys.has(entry.name));
        if (total + nextWeight - evictable.reduce((sum, entry) => sum + entry.bytes, 0) > this.budget) return false;
        for (const entry of evictable.sort((a, b) => a.time - b.time)) {
          if (total + nextWeight <= this.budget) break;
          await root.evict(entry.name, owner); this.latest.delete(entry.name); total -= entry.bytes;
        }
        const directory = await root.directory(key, owner, true);
        try {
          for (let i = 0; i < prefix.rows.length; i += 1) await directory.atomic(`${this.object(prefix.rows[i]!)}.gz`, prefix.compressed[i]!, owner);
          if (!complete) return true;
          await directory.atomic('index.json', index, owner); this.latest.set(key, structuredClone(prefix.watermark));
          const keep = new Set(['index.json', ...prefix.rows.map(row => `${this.object(row)}.gz`)]);
          for (const file of await directory.names(owner)) if (!keep.has(file) && /^(?:[a-f0-9]{64}\.gz|[a-f0-9-]{36}\.tmp)$/u.test(file)) await directory.remove(file, owner);
          return true;
        } finally { await directory.close(); }
      } finally { await root.close(); }
    });
    this.lane = operation.then(() => {}, () => {});
    try { return await owner.wait(operation); } catch { await owner.check(); return false; }
  }
}
