/** Stable history identity and durable accepted-history floors. H never denotes local application (L). */
import { z } from 'zod';
import { defineDomain, domainTable, type Domain, type DomainFacility, type DomainTableSpec, type KvTable } from '@deepseek-ai/dsh-storage-domain';
import { AzureSyncError } from '../azure/errors.js';
import type { CloudSessionEntity } from '../schema.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { genesisHash } from './chain.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(2048);
export const historyWatermarkSchema = z.object({
  scope: hash, partitionKey: text, sessionId: text, rowKey: text,
  schemaVersion: z.literal(4), formatVersion: z.literal(4), generation: integer.min(1),
  headerHash: hash, inheritedEventCount: integer, rootSessionId: text, rootGeneration: integer.min(1),
  eventCount: integer, headSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  headHash: hash, chainHash: hash, batchCount: integer,
  lastBatchRowKey: text.optional(), lastBatchGeneration: integer.min(1).optional(), lastBatchBlobName: text.optional(),
}).strict();
export type HistoryWatermark = z.infer<typeof historyWatermarkSchema>;
/** Health and object namespaces bind immutable identity, never unvalidated moving tip fields. */
export const historyIdentitySchema = historyWatermarkSchema.pick({ scope: true, partitionKey: true, sessionId: true, rowKey: true, schemaVersion: true,
  formatVersion: true, generation: true, headerHash: true, inheritedEventCount: true, rootSessionId: true, rootGeneration: true });
export type HistoryIdentity = z.infer<typeof historyIdentitySchema>;
export interface HistoryScope {
  readonly blobEndpoint: string;
  readonly tableEndpoint: string;
  readonly container: string;
  readonly table: string;
  readonly partitionKey: string;
}
/** SDK endpoints only; query strings, userinfo and fragments never enter durable keys. */
export function historyScopeId(scope: HistoryScope): string {
  const endpoint = (value: string): string => {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AzureSyncError('INVALID_CONFIG', 'History endpoints must use HTTP or HTTPS.');
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`;
  };
  if (!scope.container || !scope.table || !scope.partitionKey) throw new AzureSyncError('INVALID_CONFIG', 'A complete storage namespace is required for durable history.');
  return sha256Hex(canonicalJson({ ...scope, blobEndpoint: endpoint(scope.blobEndpoint), tableEndpoint: endpoint(scope.tableEndpoint) }));
}
export function historyWatermark(scope: string, entity: CloudSessionEntity): HistoryWatermark {
  const { partitionKey, sessionId, rowKey, schemaVersion, formatVersion, generation, headerHash, inheritedEventCount,
    rootSessionId, rootGeneration, eventCount, headSeq, headHash, chainHash, batchCount, lastBatchRowKey, lastBatchGeneration, lastBatchBlobName } = entity;
  return historyWatermarkSchema.parse({ scope, partitionKey, sessionId, rowKey, schemaVersion, formatVersion, generation,
    headerHash, inheritedEventCount, rootSessionId, rootGeneration, eventCount, headSeq, headHash, chainHash, batchCount,
    ...(lastBatchRowKey === undefined ? {} : { lastBatchRowKey }), ...(lastBatchGeneration === undefined ? {} : { lastBatchGeneration }),
    ...(lastBatchBlobName === undefined ? {} : { lastBatchBlobName }) });
}
/** Moving counts/tips never participate in the payload namespace. */
export function historyNamespace(watermark: HistoryIdentity): string {
  const { scope, partitionKey, sessionId, rowKey, schemaVersion, formatVersion, generation, headerHash, inheritedEventCount, rootSessionId, rootGeneration } = watermark;
  return sha256Hex(canonicalJson({ scope, partitionKey, sessionId, rowKey, schemaVersion, formatVersion, generation, headerHash, inheritedEventCount, rootSessionId, rootGeneration }));
}
export function sameHistory(a: HistoryWatermark, b: HistoryWatermark): boolean { return canonicalJson(a) === canonicalJson(b); }
export function compareAccepted(accepted: HistoryWatermark | undefined, next: HistoryWatermark): 'unknown' | 'same' | 'ahead' {
  if (accepted === undefined) return 'unknown';
  if (historyNamespace(accepted) !== historyNamespace(next)) throw new AzureSyncError('GENERATION_CHANGED', 'The accepted history belongs to another immutable session binding. Explicit reconciliation is required.');
  if (next.eventCount < accepted.eventCount || (next.eventCount === accepted.eventCount && !sameHistory(accepted, next))) {
    throw new AzureSyncError('CONFLICT', 'The cloud history is older than, or forks, the durable accepted history.');
  }
  return sameHistory(accepted, next) ? 'same' : 'ahead';
}
const pinSchema = z.object({ version: z.literal(1), watermark: historyWatermarkSchema }).strict();
const healthSchema = z.object({ version: z.literal(1), revision: integer, failure: z.enum(['corrupt-remote', 'committed-index-corrupt']).optional() }).strict();
export type HistoryHealth = z.infer<typeof healthSchema>;
interface HistoryDomainSpec {
  name: string; version: number; layout: 'single';
  tables: {
    pins: DomainTableSpec<string, { version: 1; watermark: HistoryWatermark }>;
    health: DomainTableSpec<string, HistoryHealth>;
  };
}
export const historyPinDomain: HistoryDomainSpec = defineDomain({ name: 'azure_sync_history_pins', version: 1, layout: 'single',
  tables: { pins: domainTable(pinSchema), health: domainTable(healthSchema) } });
type PinDomain = Domain<typeof historyPinDomain>;
type PinTable = KvTable<string, z.infer<typeof pinSchema>>;
/** One instance per Host/store, separate from disposable canonical payload files. No delete/reset API. */
export class HistoryPinStore {
  private domain?: PinDomain;
  private table?: PinTable;
  private healthTable?: KvTable<string, HistoryHealth>;
  private opening?: Promise<void>;
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly recovery = new Set<string>();
  constructor(private readonly domains: DomainFacility) {}
  async open(): Promise<void> {
    if (this.table) return;
    this.opening ??= this.domains.open(historyPinDomain).then(domain => {
      this.domain = domain; this.table = domain.table('pins') as PinTable; this.healthTable = domain.table('health');
    });
    return this.opening;
  }
  private key(w: Pick<HistoryWatermark, 'scope' | 'partitionKey' | 'sessionId'>): string {
    return sha256Hex(canonicalJson({ scope: w.scope, partitionKey: w.partitionKey, sessionId: w.sessionId }));
  }
  get(w: Pick<HistoryWatermark, 'scope' | 'partitionKey' | 'sessionId'>): HistoryWatermark | undefined {
    if (!this.table) throw new Error('The accepted-history pin store is not open.');
    const key = this.key(w);
    if (this.recovery.has(key)) throw new AzureSyncError('PRECONDITION', 'The accepted-history metadata needs explicit local recovery after an interrupted update.');
    const record = this.table.get(key);
    if (record === undefined) return undefined;
    // Schema/read errors deliberately propagate: corrupt required metadata must not bootstrap a new floor.
    return structuredClone(pinSchema.parse(record).watermark);
  }
  check(w: HistoryWatermark): 'unknown' | 'same' | 'ahead' { return compareAccepted(this.get(w), w); }
  private async putPin(table: PinTable, key: string, next: HistoryWatermark, previous: HistoryWatermark | undefined, check: () => void | Promise<void>): Promise<void> {
    let written = false;
    try { await table.put(key, { version: 1, watermark: next }); written = true; await check(); }
    catch (error) {
      if (written) {
        try {
          const current = table.get(key);
          if (current && sameHistory(current.watermark, next)) {
            if (previous) await table.update(key, latest => sameHistory(latest.watermark, next) ? { version: 1, watermark: previous } : latest);
            else if (sameHistory(table.get(key)!.watermark, next)) await table.delete(key);
          }
        } catch { this.recovery.add(key); throw new AzureSyncError('PRECONDITION', 'The interrupted accepted-history update could not be compensated; explicit local metadata recovery is required.'); }
      }
      throw error;
    }
  }
  async accept(watermark: HistoryWatermark, check: (latest: HistoryWatermark | undefined) => void | Promise<void> = () => {}): Promise<void> {
    const next = historyWatermarkSchema.parse(watermark);
    const table = this.table;
    if (!table) throw new Error('The accepted-history pin store is not open.');
    const key = this.key(next);
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const operation = previous.then(async () => {
      await check(this.get(next));
      const current = this.get(next); compareAccepted(current, next);
      // No other accepted-H writer for this key can interleave while the lane is held.
      // The component validates the latest floor's exact canonical ancestry here, not just before queuing.
      await check(this.get(next));
      if (current && sameHistory(current, next)) return;
      await this.putPin(table, key, next, current, () => check(this.get(next)));
    });
    const tail = operation.then(() => {}, () => {});
    this.lanes.set(key, tail);
    void tail.then(() => { if (this.lanes.get(key) === tail) this.lanes.delete(key); });
    return operation;
  }
  /** Explicit root resurrection only. The caller must retain its durable activation-intent guard. */
  async activateGeneration(previous: HistoryWatermark | undefined, next: HistoryWatermark, check: () => void | Promise<void>): Promise<void> {
    if (previous) previous = historyWatermarkSchema.parse(previous);
    next = historyWatermarkSchema.parse(next);
    const immutable = ['scope', 'partitionKey', 'sessionId', 'rowKey', 'schemaVersion', 'formatVersion', 'rootSessionId'] as const;
    const genesis = genesisHash(next.sessionId, next.generation, next.headerHash, next.schemaVersion);
    if ((previous && (immutable.some(key => previous![key] !== next[key]) || previous.rootSessionId !== previous.sessionId || next.generation !== previous.generation + 1)) || next.rootSessionId !== next.sessionId || next.rootGeneration !== next.generation || next.eventCount !== 0 || next.headSeq !== -1 || next.headHash !== genesis || next.chainHash !== genesis || next.batchCount !== 0 || next.lastBatchRowKey !== undefined || next.lastBatchGeneration !== undefined || next.lastBatchBlobName !== undefined) throw new AzureSyncError('GENERATION_CHANGED', 'Explicit history activation requires the next empty root generation.');
    const table = this.table;
    if (!table) throw new Error('The accepted-history pin store is not open.');
    const key = this.key(next);
    const operation = (this.lanes.get(key) ?? Promise.resolve()).then(async () => {
      await check();
      const current = this.get(next);
      if (current && sameHistory(current, next)) return;
      if ((current === undefined) !== (previous === undefined) || (current && previous && !sameHistory(current, previous))) throw new AzureSyncError('CONFLICT', 'The accepted-history floor changed before explicit generation activation.');
      await check(); await this.putPin(table, key, next, current, check);
    });
    const tail = operation.then(() => {}, () => {}); this.lanes.set(key, tail);
    void tail.then(() => { if (this.lanes.get(key) === tail) this.lanes.delete(key); });
    return operation;
  }
  /** Durable remote-health metadata is independent of payload retention and native session existence. */
  health(w: HistoryIdentity): HistoryHealth {
    if (!this.healthTable) throw new Error('The history health store is not open.');
    const namespace = historyNamespace(w);
    if (this.recovery.has(`health:${namespace}`)) throw new AzureSyncError('PRECONDITION', 'Remote-health metadata needs explicit local recovery after an interrupted update.');
    const record = this.healthTable.get(namespace);
    return record === undefined ? { version: 1, revision: 0 } : structuredClone(healthSchema.parse(record));
  }
  private async changeHealth(w: HistoryIdentity, check: () => void | Promise<void>, change: (current: HistoryHealth) => HistoryHealth | boolean): Promise<boolean> {
    const table = this.healthTable;
    if (!table) throw new Error('The history health store is not open.');
    const namespace = historyNamespace(historyIdentitySchema.strip().parse(w)), key = `health:${namespace}`;
    const operation = (this.lanes.get(key) ?? Promise.resolve()).then(async () => {
      await check();
      const previous = this.health(w), next = change(previous);
      if (typeof next === 'boolean') return next;
      const parsed = healthSchema.parse(next);
      await check();
      let written = false;
      try { await table.put(namespace, parsed); written = true; await check(); }
      catch (error) {
        if (written && previous.failure !== undefined && parsed.failure === undefined) {
          try {
            await table.update(namespace, current => canonicalJson(current) === canonicalJson(parsed)
              ? { version: 1, revision: current.revision + 1, failure: previous.failure } : current);
          } catch { this.recovery.add(key); throw new AzureSyncError('PRECONDITION', 'The interrupted audit-health clear could not be compensated; explicit local metadata recovery is required.'); }
        }
        // Restrictive failure writes remain valid; cancellation cannot turn failure into health.
        throw error;
      }
      return true;
    });
    const tail = operation.then(() => {}, () => {}); this.lanes.set(key, tail);
    void tail.then(() => { if (this.lanes.get(key) === tail) this.lanes.delete(key); });
    return operation;
  }
  async failHealth(w: HistoryIdentity, failure: NonNullable<HistoryHealth['failure']>, check: () => void | Promise<void>): Promise<void> {
    await this.changeHealth(w, check, current => ({ version: 1, revision: current.revision + 1, failure }));
  }
  /** Readers must not use a provisional clear while its post-put guard/compensation is still pending. */
  pendingHealth(w: HistoryIdentity): Promise<void> | undefined { return this.lanes.get(`health:${historyNamespace(w)}`); }
  /** A successful older audit cannot erase a failure learned by a newer concurrent audit. */
  clearHealth(w: HistoryIdentity, observedRevision: number, check: () => void | Promise<void>): Promise<boolean> {
    return this.changeHealth(w, check, current => {
      if (current.revision !== observedRevision) return current.failure === undefined;
      return current.failure === undefined ? true : { version: 1, revision: current.revision + 1 };
    });
  }
  async close(): Promise<void> {
    await this.opening?.catch(() => {});
    await Promise.all(this.lanes.values());
    await this.domain?.close();
    this.table = undefined; this.healthTable = undefined; this.domain = undefined; this.opening = undefined;
  }
}

/** Independent native application checkpoint, a scheduling hint only. Not an accepted-byte witness. */
export interface LocalHistoryCheckpoint { readonly eventCount?: number; readonly chainHash?: string; readonly headerHash?: string; }
export function needsLocalHistory(w: HistoryWatermark, local: LocalHistoryCheckpoint | undefined): boolean {
  return local?.eventCount !== w.eventCount || local.chainHash !== w.chainHash || local.headerHash !== w.headerHash;
}
