/** Shared manifest-first canonical history verification. Payloads are never control authority. */
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { AzureSyncError } from '../azure/errors.js';
import { cloudSessionEntitySchema, decodeCloudRecord, parseRecord, resurrectionIntentSchema, sessionRowKey, type BatchRow, type ResurrectionIntent } from '../schema.js';
import type { CloudRepository, StoredManifest } from './cloud-repository.js';
import { selectCommittedChain, selectCommittedSuffix, validateCommittedManifest } from './committed-index.js';
import { genesisHash, verifyBatchChain, verifyHeaderBinding } from './chain.js';
import { canonicalJson, payloadBytes, sha256Hex } from './canonical.js';
import { compareAccepted, historyIdentitySchema, historyNamespace, historyScopeId, historyWatermark, sameHistory, type HistoryHealth, type HistoryIdentity, type HistoryPinStore, type HistoryScope, type HistoryWatermark } from './history-state.js';
import { HistoryRetentionPool, type HistoryRetention, type RetentionReservation, type RetentionSize } from './history-retention.js';
import { HistoryDiskCache, type HistoryCacheOptions } from './history-cache.js';
import { HistoryFetches, HistoryOwner, HistorySemaphore, type HistoryReadContext } from './history-work.js';
export type { HistoryReadContext } from './history-work.js';
export type { HistoryCacheOptions } from './history-cache.js';
export type { HistoryScope, HistoryWatermark } from './history-state.js';
export type { HistoryRetention } from './history-retention.js';

export interface RemoteSession {
  readonly manifest: StoredManifest;
  readonly header: SessionHeader;
  readonly inheritedEventCount: number;
  readonly events: readonly SessionEvent[];
}
export interface HistoryObservation {
  readonly manifest: StoredManifest;
  readonly header: SessionHeader;
  readonly watermark: HistoryWatermark;
  readonly acceptedPin?: HistoryWatermark;
  readonly comparison: 'unknown' | 'same' | 'ahead';
}
export interface RemoteSessionReaderOptions {
  readonly maxCompressedBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxEvents?: number;
  readonly maxBatches?: number;
  readonly scope?: HistoryScope;
  readonly pins?: HistoryPinStore;
  readonly cache?: HistoryCacheOptions;
}
interface Prefix {
  readonly watermark: HistoryWatermark;
  readonly rows: readonly BatchRow[];
  readonly compressed: readonly Buffer[];
  readonly events: readonly SessionEvent[];
  readonly weight: number;
}
export interface ConfirmedHistoryUpload {
  readonly base: StoredManifest;
  readonly row: BatchRow;
  readonly compressed: Uint8Array;
  readonly receipt: StoredManifest;
}
interface Envelope { readonly manifest: StoredManifest; readonly header: SessionHeader; readonly watermark: HistoryWatermark; }
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) if (item && typeof item === 'object' && !Object.isFrozen(item)) immutable(item); }
  return value;
}
export class RemoteSessionReader {
  readonly scopeId: string;
  private readonly memory = new Map<string, Prefix>();
  private memoryWeight = 0;
  private readonly memoryBudget: number;
  private readonly disk: HistoryDiskCache;
  private readonly retention: HistoryRetentionPool;
  private readonly capacityPressure = new Set<string>();
  private readonly fetches: HistoryFetches;
  private readonly materializations: HistorySemaphore;
  private readonly runtime = new AbortController();
  private readonly sessions = new Map<string, AbortController>();
  private readonly pressure = new Map<string, string>();
  private readonly auditFailures = new Map<string, HistoryHealth>();
  private readonly accepted = new Map<string, HistoryWatermark>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly maxEvents: number;
  private readonly maxBatches: number;
  constructor(private readonly repository: CloudRepository, private readonly options: RemoteSessionReaderOptions) {
    for (const bound of [options.maxCompressedBytes, options.maxExpandedBytes]) if (!Number.isSafeInteger(bound) || bound < 1) throw new AzureSyncError('INVALID_CONFIG', 'History payload bounds must be positive safe integers.');
    this.maxEvents = options.maxEvents ?? 1_000_000;
    this.maxBatches = options.maxBatches ?? 100_000;
    this.memoryBudget = options.cache?.memoryBytes ?? 128 * 1024 * 1024;
    if (![this.maxEvents, this.maxBatches, this.memoryBudget].every(bound => Number.isSafeInteger(bound) && bound >= 0)) throw new AzureSyncError('INVALID_CONFIG', 'History cache and traversal limits are invalid.');
    let scope = options.scope;
    if (!scope && repository.blob?.container?.url && repository.table?.client?.url) {
      scope = { blobEndpoint: repository.blob.container.url, tableEndpoint: repository.table.client.url,
        container: repository.blob.container.containerName, table: repository.table.client.tableName, partitionKey: repository.partitionKey };
    }
    if (!scope && (options.pins || options.cache?.directory)) throw new AzureSyncError('INVALID_CONFIG', 'Durable history requires actual SDK endpoint namespace identity.');
    // Port-only ephemeral readers cannot share content or durable pins across instances.
    this.scopeId = scope ? historyScopeId(scope) : sha256Hex('ephemeral-history\0', randomUUID());
    if (scope && repository.partitionKey !== undefined && scope.partitionKey !== repository.partitionKey) throw new AzureSyncError('INVALID_CONFIG', 'The history scope partition does not match its repository.');
    this.disk = new HistoryDiskCache(options.cache, owner => this.retention.diskProtected(owner));
    this.retention = new HistoryRetentionPool(this.memoryBudget, this.disk.capacityBytes);
    this.fetches = new HistoryFetches(options.cache?.maxFetches ?? 4);
    this.materializations = new HistorySemaphore(options.cache?.maxMaterializations ?? 2);
  }
  private owner(sessionId: string, context: HistoryReadContext, bounded = true): HistoryOwner {
    let session = this.sessions.get(sessionId);
    if (!session) { session = new AbortController(); this.sessions.set(sessionId, session); }
    return new HistoryOwner(context, AbortSignal.any([this.runtime.signal, session.signal, ...(bounded ? [AbortSignal.timeout(120_000)] : [])]));
  }
  /** Data residency only; synchronous enrollment performs no IO and grants no authority. */
  retain(sessionId: string, context: HistoryReadContext): HistoryRetention {
    const token = this.retention.enroll(sessionId, this.owner(sessionId, context, false));
    const partitionKey = this.options.scope?.partitionKey ?? this.repository.partitionKey;
    const accepted = partitionKey === undefined ? [...this.accepted.values()].find(w => w.sessionId === sessionId) : this.options.pins?.get({ scope: this.scopeId, partitionKey, sessionId }) ?? this.accepted.get(this.pinKey({ scope: this.scopeId, partitionKey, sessionId }));
    if (accepted) token.bind(accepted);
    return Object.freeze({ release: () => token.release() });
  }
  private size(prefix: Prefix): RetentionSize { return { watermark: prefix.watermark, memory: prefix.weight, disk: prefix.compressed.reduce((sum, bytes) => sum + bytes.length, 0) }; }
  private async reserve(size: RetentionSize, owner: HistoryOwner): Promise<RetentionReservation> {
    try { return await this.retention.reserve(size, owner); }
    catch (error) {
      if (error instanceof AzureSyncError && error.code === 'LIMIT') {
        const key = historyNamespace(size.watermark); this.pressure.set(key, canonicalJson(size.watermark)); this.capacityPressure.add(key);
      }
      throw error;
    }
  }
  private ioContext(owner: HistoryOwner): { readonly signal: AbortSignal; readonly check: () => Promise<void> } { return { signal: owner.signal, check: () => owner.check() }; }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(() => {}, () => {}).finally(() => this.operations.delete(operation));
    return operation;
  }
  private pinKey(w: Pick<HistoryIdentity, 'scope' | 'partitionKey' | 'sessionId'>): string { return `${w.scope}:${w.partitionKey}:${w.sessionId}`; }
  private pin(w: HistoryIdentity): HistoryWatermark | undefined { return this.options.pins?.get(w) ?? this.accepted.get(this.pinKey(w)); }
  private assertAncestor(accepted: HistoryWatermark | undefined, prefix: Prefix): void {
    if (!accepted) return;
    compareAccepted(accepted, prefix.watermark);
    if (sameHistory(accepted, prefix.watermark)) return;
    try { selectCommittedChain(accepted, prefix.rows.slice(0, accepted.batchCount)); }
    catch { throw new AzureSyncError('CONFLICT', 'The selected history does not contain the exact latest accepted prefix.'); }
  }
  private async accept(prefix: Prefix, owner: HistoryOwner): Promise<void> {
    const w = prefix.watermark;
    await owner.check(); this.assertAncestor(this.pin(w), prefix);
    // Even same-W witnesses join the lane: they cannot publish through a provisional put
    // that another canceled owner is still compensating.
    if (this.options.pins) await owner.wait(this.options.pins.accept(w, async latest => {
      await owner.check(); this.assertAncestor(latest, prefix);
    }));
    await owner.check();
    this.assertAncestor(this.accepted.get(this.pinKey(w)), prefix);
    this.accepted.set(this.pinKey(w), immutable(structuredClone(w)));
  }
  private health(w: HistoryIdentity): HistoryHealth {
    return this.options.pins?.health(w) ?? this.auditFailures.get(historyNamespace(w)) ?? { version: 1, revision: 0 };
  }
  private assertHealthy(w: HistoryWatermark): void {
    const failure = this.health(w).failure;
    if (failure) throw new AzureSyncError(failure === 'committed-index-corrupt' ? 'COMMITTED_INDEX_CORRUPT' : 'CORRUPT_REMOTE', 'A cloud-copy audit found unverifiable remote history. Explicitly verify the repaired cloud copy before using retained cache bytes.');
  }
  private async failedAudit(w: HistoryIdentity, error: AzureSyncError, owner: HistoryOwner): Promise<void> {
    const failure = error.code === 'COMMITTED_INDEX_CORRUPT' ? 'committed-index-corrupt' : 'corrupt-remote';
    await owner.check();
    if (this.options.pins) await owner.wait(this.options.pins.failHealth(w, failure, () => owner.check()));
    else this.auditFailures.set(historyNamespace(w), { version: 1, revision: this.health(w).revision + 1, failure });
  }
  private async clearAudit(w: HistoryWatermark, observedRevision: number, owner: HistoryOwner): Promise<boolean> {
    if (this.options.pins) return owner.wait(this.options.pins.clearHealth(w, observedRevision, () => owner.check()));
    const current = this.health(w);
    if (current.revision !== observedRevision) return current.failure === undefined;
    if (current.failure) this.auditFailures.set(historyNamespace(w), { version: 1, revision: current.revision + 1 });
    return true;
  }
  private auditIdentity(sessionId: string, entity: Record<string, unknown>, owner: HistoryOwner, wire = false): HistoryIdentity | undefined {
    const routingSchema = cloudSessionEntitySchema.pick({ partitionKey: true, rowKey: true, sessionId: true, generation: true });
    const routingFields: Record<string, unknown> = {};
    for (const field of Object.keys(routingSchema.shape)) routingFields[field] = entity[field];
    let route;
    try { route = wire ? decodeCloudRecord(routingSchema, routingFields, 'audit health routing identity').record : routingSchema.parse(routingFields); }
    catch { return undefined; }
    const context = owner.context, partition = this.options.scope?.partitionKey ?? this.repository.partitionKey;
    if (route.sessionId !== sessionId || route.rowKey !== sessionRowKey(sessionId) || (partition !== undefined && route.partitionKey !== partition) ||
      (context.expectedScope !== undefined && context.expectedScope !== this.scopeId) ||
      (context.expectedGeneration !== undefined && context.expectedGeneration !== route.generation) ||
      entity.state === 'deleted' || ((entity.state === 'disabled' || entity.enabled === false) && !context.allowDisabled)) return undefined;
    const key = { scope: this.scopeId, partitionKey: route.partitionKey, sessionId };
    const accepted = this.options.pins?.get(key) ?? this.accepted.get(this.pinKey(key));
    // The established binding is authoritative for health attribution even when its
    // untrusted replacement hash/cut/root/schema fields are missing or malformed.
    if (accepted?.generation === route.generation) {
      if ((context.expectedRootSessionId !== undefined && context.expectedRootSessionId !== accepted.rootSessionId) ||
        (context.expectedRootGeneration !== undefined && context.expectedRootGeneration !== accepted.rootGeneration)) return undefined;
      return accepted;
    }
    const fields: Record<string, unknown> = {};
    for (const field of Object.keys(historyIdentitySchema.shape)) if (field !== 'scope') fields[field] = entity[field];
    try {
      const candidate = wire ? decodeCloudRecord(historyIdentitySchema.omit({ scope: true }), fields, 'audit immutable health identity').record : fields;
      const decoded = historyIdentitySchema.safeParse({ ...candidate, scope: this.scopeId });
      if (!decoded.success) return undefined;
      const w = decoded.data;
      if ((context.expectedRootSessionId !== undefined && context.expectedRootSessionId !== w.rootSessionId) ||
        (context.expectedRootGeneration !== undefined && context.expectedRootGeneration !== w.rootGeneration)) return undefined;
      return w;
    } catch { return undefined; }
  }
  private async auditedEnvelope(sessionId: string, owner: HistoryOwner): Promise<Envelope | undefined> {
    let identity: HistoryIdentity | undefined;
    try { return await this.envelope(sessionId, owner, true, false, candidate => { identity = candidate; }); }
    catch (error) {
      await owner.check();
      if (error instanceof AzureSyncError && ['CORRUPT_REMOTE', 'COMMITTED_INDEX_CORRUPT', 'INVALID_RECORD', 'NOT_FOUND'].includes(error.code)) {
        if (error.code === 'NOT_FOUND') {
          const partitionKey = this.options.scope?.partitionKey ?? this.repository.partitionKey;
          const accepted = partitionKey === undefined ? [...this.accepted.values()].find(w => w.sessionId === sessionId) : this.options.pins?.get({ scope: this.scopeId, partitionKey, sessionId }) ?? this.accepted.get(this.pinKey({ scope: this.scopeId, partitionKey, sessionId }));
          const context = owner.context;
          if (accepted && (context.expectedScope === undefined || context.expectedScope === this.scopeId) &&
            (context.expectedGeneration === undefined || context.expectedGeneration === accepted.generation) &&
            (context.expectedRootSessionId === undefined || context.expectedRootSessionId === accepted.rootSessionId) &&
            (context.expectedRootGeneration === undefined || context.expectedRootGeneration === accepted.rootGeneration)) identity = accepted;
        }
        // A strict repository decode can reject a moving field before returning its DTO.
        // Read only immutable fields for health attribution; never treat this as a manifest/read proof.
        if (!identity && error.code === 'INVALID_RECORD' && this.repository.table?.get) {
          try {
            const raw = await owner.io(() => this.repository.table.get<Record<string, unknown>>(this.repository.partitionKey, sessionRowKey(sessionId), this.ioContext(owner)));
            if (raw) identity = this.auditIdentity(sessionId, raw.value, owner, true);
          } catch { await owner.check(); }
        }
        if (identity) await this.failedAudit(identity, error, owner);
      }
      throw error;
    }
  }
  private async envelope(sessionId: string, owner: HistoryOwner, materialize: boolean, activation = false, onIdentity?: (identity: HistoryIdentity | undefined) => void, restarts = 0): Promise<Envelope | undefined> {
    const partition = this.options.scope?.partitionKey ?? this.repository.partitionKey;
    const acceptedBefore = partition === undefined ? [...this.accepted.values()].find(w => w.sessionId === sessionId) : this.options.pins?.get({ scope: this.scopeId, partitionKey: partition, sessionId }) ?? this.accepted.get(this.pinKey({ scope: this.scopeId, partitionKey: partition, sessionId }));
    const stored = await owner.io(() => this.repository.getManifest(sessionId, this.ioContext(owner)));
    if (!stored) {
      const partitionKey = this.options.scope?.partitionKey ?? this.repository.partitionKey;
      const known = partitionKey === undefined ? [...this.accepted.values()].find(w => w.sessionId === sessionId) : this.options.pins?.get({ scope: this.scopeId, partitionKey, sessionId }) ?? [...this.accepted.values()].find(w => w.sessionId === sessionId && w.partitionKey === partitionKey);
      if (known && acceptedBefore && historyNamespace(acceptedBefore) !== historyNamespace(known)) throw new AzureSyncError('GENERATION_CHANGED', 'The accepted generation or binding changed during control observation.');
      if (known && (acceptedBefore === undefined || (historyNamespace(acceptedBefore) === historyNamespace(known) && !sameHistory(acceptedBefore, known)))) {
        if (restarts >= 3) throw new AzureSyncError('TRANSIENT', 'Accepted history kept advancing during control observation. Retry within a new operation deadline.');
        return this.envelope(sessionId, owner, materialize, activation, onIdentity, restarts + 1);
      }
      if (known) throw new AzureSyncError('NOT_FOUND', 'The cloud manifest is missing for a previously accepted history. Reconcile explicitly; do not recreate its suffix.');
      return undefined;
    }
    onIdentity?.(this.auditIdentity(sessionId, stored.entity, owner));
    const entity = parseRecord(cloudSessionEntitySchema, structuredClone(stored.entity), 'history manifest');
    if (!stored.etag || entity.sessionId !== sessionId || entity.rowKey !== sessionRowKey(sessionId) || (this.repository.partitionKey !== undefined && entity.partitionKey !== this.repository.partitionKey)) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud manifest identity does not match this history namespace.');
    const context = owner.context;
    if (context.expectedScope !== undefined && context.expectedScope !== this.scopeId) throw new AzureSyncError('GENERATION_CHANGED', 'The storage namespace changed before history verification.');
    if ((context.expectedGeneration !== undefined && entity.generation !== context.expectedGeneration) || (context.expectedRootSessionId !== undefined && context.expectedRootSessionId !== entity.rootSessionId) || (context.expectedRootGeneration !== undefined && context.expectedRootGeneration !== entity.rootGeneration)) throw new AzureSyncError('GENERATION_CHANGED', 'The cloud generation or root does not match this operation.');
    if (materialize && entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The cloud session is a tombstone.');
    if (materialize && (entity.state === 'disabled' || !entity.enabled) && !context.allowDisabled) throw new AzureSyncError('DISABLED', 'The cloud session is disabled.');
    let header: SessionHeader;
    try { header = JSON.parse(entity.headerJson) as SessionHeader; } catch { throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud header is not valid JSON.'); }
    if (!header || header.id !== sessionId) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud header identity does not match the requested session.');
    verifyHeaderBinding(header, entity.inheritedEventCount, entity.headerHash);
    if (header.version !== 4 || entity.formatVersion !== 4) throw new AzureSyncError('INCOMPATIBLE_FORMAT', 'Only session format v4 can be materialized.');
    validateCommittedManifest(entity);
    if (entity.eventCount > this.maxEvents || entity.batchCount > this.maxBatches) throw new AzureSyncError('LIMIT', 'The cloud history exceeds its event or traversal bound.');
    if (entity.rootSessionId === sessionId) {
      if (entity.rootGeneration !== entity.generation) throw new AzureSyncError('GENERATION_CHANGED', 'The root generation does not match its session.');
    } else {
      const storedRoot = await owner.io(() => this.repository.getManifest(entity.rootSessionId, this.ioContext(owner)));
      const root = storedRoot ? parseRecord(cloudSessionEntitySchema, storedRoot.entity, 'history root manifest') : undefined;
      if (!root || !storedRoot?.etag || root.partitionKey !== entity.partitionKey || root.rowKey !== sessionRowKey(entity.rootSessionId) || root.sessionId !== entity.rootSessionId || root.rootSessionId !== entity.rootSessionId || root.rootGeneration !== root.generation || root.generation !== entity.rootGeneration || root.state !== 'active' || !root.enabled) throw new AzureSyncError('GENERATION_CHANGED', 'The session root is not eligible in the expected generation.');
    }
    await owner.check();
    const watermark = historyWatermark(this.scopeId, entity);
    if (!activation) {
      const accepted = this.pin(watermark);
      try { compareAccepted(accepted, watermark); }
      catch (error) {
        if (error instanceof AzureSyncError && error.code === 'CONFLICT' && accepted && historyNamespace(accepted) === historyNamespace(watermark) &&
          (acceptedBefore === undefined || !sameHistory(acceptedBefore, accepted))) {
          if (restarts >= 3) throw new AzureSyncError('TRANSIENT', 'Accepted history kept advancing during control observation. Retry within a new operation deadline.');
          return this.envelope(sessionId, owner, materialize, activation, onIdentity, restarts + 1);
        }
        throw error;
      }
    }
    return { manifest: { entity, etag: stored.etag }, header, watermark };
  }
  observe(sessionId: string, context: HistoryReadContext = {}): Promise<HistoryObservation | undefined> {
    const owner = this.owner(sessionId, context);
    return this.track((async () => {
      let envelope = await this.envelope(sessionId, owner, false);
      if (!envelope) return undefined;
      for (let restart = 0; restart < 3; restart += 1) {
        const pending = this.options.pins?.pendingHealth(envelope.watermark);
        if (!pending) break;
        await owner.wait(pending);
        envelope = await this.envelope(sessionId, owner, false); if (!envelope) return undefined;
        if (restart === 2 && this.options.pins?.pendingHealth(envelope.watermark)) throw new AzureSyncError('TRANSIENT', 'Remote-health updates kept changing during observation. Retry within a new operation deadline.');
      }
      this.assertHealthy(envelope.watermark);
      const acceptedPin = this.pin(envelope.watermark);
      return { ...envelope, ...(acceptedPin ? { acceptedPin: structuredClone(acceptedPin) } : {}), comparison: compareAccepted(acceptedPin, envelope.watermark) };
    })());
  }
  read(sessionId: string, context: HistoryReadContext = {}): Promise<RemoteSession | undefined> { return this.track(this.materialize(sessionId, this.owner(sessionId, context), false)); }
  audit(sessionId: string, context: HistoryReadContext = {}): Promise<RemoteSession | undefined> { return this.track(this.materialize(sessionId, this.owner(sessionId, context), true)); }
  /** Explicit audit control precheck only: no payload/index IO, H/L update, health clear or byte proof. */
  auditControl(sessionId: string, context: HistoryReadContext = {}): Promise<StoredManifest | undefined> {
    const owner = this.owner(sessionId, context);
    return this.track((async () => {
      const envelope = await this.auditedEnvelope(sessionId, owner);
      await owner.check(); return envelope ? structuredClone(envelope.manifest) : undefined;
    })());
  }
  private parse(compressed: Buffer, row: BatchRow, previous: string): { events: SessionEvent[]; weight: number } {
    if (compressed.length > this.options.maxCompressedBytes) throw new AzureSyncError('LIMIT', 'A committed compressed payload exceeds its bound.');
    let payload: Buffer;
    try { payload = gunzipSync(compressed, { maxOutputLength: this.options.maxExpandedBytes }); }
    catch { throw new AzureSyncError('CORRUPT_REMOTE', 'A committed payload is invalid or exceeds the expansion bound.'); }
    if (sha256Hex(payload) !== row.payloadHash) throw new AzureSyncError('CORRUPT_REMOTE', 'A committed batch raw payload hash does not match its row.');
    const lines = payload.toString('utf8').split('\n');
    if (lines.pop() !== '' || lines.length !== row.eventCount) throw new AzureSyncError('CORRUPT_REMOTE', 'A committed batch JSONL boundary or count is invalid.');
    let events: SessionEvent[];
    try { events = lines.map(line => JSON.parse(line) as SessionEvent); } catch { throw new AzureSyncError('CORRUPT_REMOTE', 'A committed payload contains invalid JSON.'); }
    if (!payload.equals(payloadBytes(events))) throw new AzureSyncError('CORRUPT_REMOTE', 'A committed event payload is not canonical JSONL.');
    verifyBatchChain(events, row, previous);
    return { events, weight: payload.length };
  }
  private async verify(header: SessionHeader, w: HistoryWatermark, rows: readonly BatchRow[], compressed: readonly Buffer[], owner: HistoryOwner): Promise<Prefix> {
    await owner.check();
    const chain = selectCommittedChain(w, rows);
    const accepted = this.pin(w);
    if (accepted && accepted.eventCount <= w.eventCount) {
      compareAccepted(accepted, w);
      try { selectCommittedChain(accepted, chain.rows.slice(0, accepted.batchCount)); }
      catch { throw new AzureSyncError('CONFLICT', 'The selected history does not contain the exact durable accepted prefix.'); }
    }
    const events: SessionEvent[] = [];
    let previous = chain.genesis; let weight = 0;
    if (rows.length !== compressed.length) throw new AzureSyncError('CORRUPT_REMOTE', 'A stored prefix is incomplete.');
    for (let i = 0; i < chain.rows.length; i += 1) {
      // Yield between bounded chunks so proof deadlines/revocation are not starved by a large disk rehash.
      await yieldTurn(); await owner.check();
      const parsed = this.parse(compressed[i]!, chain.rows[i]!, previous);
      if (events.length + parsed.events.length > this.maxEvents) throw new AzureSyncError('LIMIT', 'The cloud history exceeds its event bound.');
      for (const event of parsed.events) events.push(event);
      weight += parsed.weight; previous = chain.rows[i]!.chainHash;
    }
    try { validateStoredEvents(header, events as never); } catch { throw new AzureSyncError('INVALID_RECORD', 'The canonical history does not satisfy the complete stored-event contract.'); }
    return { watermark: immutable(structuredClone(w)), rows: immutable(structuredClone(rows)), compressed: compressed.map(bytes => Buffer.from(bytes)), events: immutable(events), weight };
  }
  private memoryGet(w: HistoryWatermark): Prefix | undefined {
    const key = historyNamespace(w); const prefix = this.memory.get(key);
    if (prefix) { this.memory.delete(key); this.memory.set(key, prefix); }
    return prefix;
  }
  private memoryPut(prefix: Prefix): boolean {
    const key = historyNamespace(prefix.watermark), previous = this.memory.get(key);
    if (previous && previous.watermark.eventCount > prefix.watermark.eventCount) return true;
    if (prefix.weight > this.memoryBudget) return false;
    const protectedKeys = this.retention.memoryProtected();
    const evictable = [...this.memory].filter(([victim]) => victim !== key && !protectedKeys.has(victim));
    if (this.memoryWeight - (previous?.weight ?? 0) + prefix.weight - evictable.reduce((sum, [, value]) => sum + value.weight, 0) > this.memoryBudget) return false;
    if (previous) { this.memoryWeight -= previous.weight; this.memory.delete(key); }
    for (const [victim, value] of evictable) {
      if (this.memoryWeight + prefix.weight <= this.memoryBudget) break;
      this.memory.delete(victim); this.memoryWeight -= value.weight;
    }
    this.memory.set(key, prefix); this.memoryWeight += prefix.weight; return true;
  }
  private result(envelope: Envelope, prefix: Prefix): RemoteSession {
    return { manifest: structuredClone(envelope.manifest), header: structuredClone(envelope.header), inheritedEventCount: envelope.manifest.entity.inheritedEventCount, events: structuredClone(prefix.events) };
  }
  private async materialize(sessionId: string, owner: HistoryOwner, audit: boolean): Promise<RemoteSession | undefined> {
    const release = await this.materializations.acquire(owner);
    const enrollment = audit ? undefined : this.retention.enroll(sessionId, owner);
    let reservation: RetentionReservation | undefined;
    let prepared: Prefix | undefined;
    let diskAttempted = false;
    const getEnvelope = () => audit ? this.auditedEnvelope(sessionId, owner) : this.envelope(sessionId, owner, true);
    try {
      let envelope = await getEnvelope();
      if (!envelope) return undefined;
      const namespace = historyNamespace(envelope.watermark);
      const auditRevision = this.health(envelope.watermark).revision;
      if (!audit) this.assertHealthy(envelope.watermark);
      enrollment?.bind(envelope.watermark);
      const pressure = this.pressure.get(namespace) === canonicalJson(envelope.watermark);
      if (!audit && pressure && !this.capacityPressure.has(namespace)) throw new AzureSyncError('LIMIT', 'This history exceeds local cache capacity. Increase capacity or explicitly invalidate before retrying.');
      const known = this.retention.known(envelope.watermark);
      if (!audit && known) {
        reservation = await this.reserve(known, owner);
        this.pressure.delete(namespace); this.capacityPressure.delete(namespace);
      }
      for (let restart = 0; restart <= 3; restart += 1) {
        if (historyNamespace(envelope.watermark) !== namespace) throw new AzureSyncError('GENERATION_CHANGED', 'The immutable history binding changed during materialization.');
        let usedDisk = false;
        try {
          let prefix = audit ? undefined : this.memoryGet(envelope.watermark) ?? prepared;
          let needsStore = !prefix;
          if (!prefix && !audit && !diskAttempted) {
            diskAttempted = true;
            const disk = await this.disk.read(envelope.watermark, this.options.maxCompressedBytes, this.maxBatches, owner);
            if (disk && disk.watermark.eventCount <= envelope.watermark.eventCount && (disk.watermark.eventCount !== envelope.watermark.eventCount || sameHistory(disk.watermark, envelope.watermark))) {
              try { prefix = await this.verify(envelope.header, disk.watermark, disk.rows, disk.compressed, owner); usedDisk = true; needsStore = false; }
              catch { await owner.check(); /* Disk sidecars are untrusted; a miss cannot reset H. */ }
            }
          }
          if (prefix && historyNamespace(prefix.watermark) !== namespace) prefix = undefined;
          if (prefix && prefix.watermark.eventCount > envelope.watermark.eventCount) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud tip rolled back behind its verified prefix.');
          // Even a zero-suffix hit checks every final tip field through exact W equality.
          if (prefix && prefix.watermark.eventCount === envelope.watermark.eventCount && !sameHistory(prefix.watermark, envelope.watermark)) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud tip forks its verified prefix.');
          if (!prefix || !sameHistory(prefix.watermark, envelope.watermark) || audit) {
            const chain = await selectCommittedSuffix(envelope.manifest.entity, key => owner.io(() => this.repository.getBatch(key, this.ioContext(owner))), prefix ? { manifest: prefix.watermark, rows: prefix.rows } : undefined, this.maxBatches);
            const rows = [...(prefix?.rows ?? []), ...chain.rows];
            const compressed = [...(prefix?.compressed ?? [])];
            for (const row of chain.rows) {
              let bytes = audit ? undefined : await this.disk.readChunk(envelope.watermark, row, this.options.maxCompressedBytes, owner);
              if (bytes) {
                try { this.parse(bytes, row, row.prevChainHash); }
                catch { bytes = undefined; await owner.check(); }
              }
              if (!bytes) {
                // Audits must fetch independently, but still occupy the same bounded raw transport pool.
                const key = audit ? `audit:${randomUUID()}` : `${namespace}:${sha256Hex(row.blobName, '\0', row.payloadHash)}`;
                bytes = await this.fetches.fetch(key, owner, context => this.repository.readCandidate(row.blobName, this.options.maxCompressedBytes, context));
                this.parse(bytes, row, row.prevChainHash);
                if (!audit) await this.disk.writeChunk(envelope.watermark, row, bytes, owner);
              }
              compressed.push(bytes);
            }
            await owner.check();
            prefix = await this.verify(envelope.header, envelope.watermark, rows, compressed, owner);
            needsStore = true;
          }
          prepared = prefix;
          await owner.check();
          if (!audit) reservation = await this.reserve(this.size(prefix), owner);
          else await this.retention.diskProtected(owner);
          const retained = audit ? false : !needsStore || await this.disk.write(prefix, owner);
          if (!audit && reservation?.placement === 'disk' && !retained) {
            this.capacityPressure.delete(namespace);
            this.pressure.set(namespace, canonicalJson(envelope.watermark));
            throw new AzureSyncError('LIMIT', 'This history cannot fit the local canonical cache. Increase the private cache capacity before retrying.');
          }
          let fresh = await getEnvelope();
          if (!fresh) throw new AzureSyncError('NOT_FOUND', 'The cloud session disappeared during history verification.');
          if (historyNamespace(fresh.watermark) !== namespace) throw new AzureSyncError('GENERATION_CHANGED', 'The immutable history binding changed during verification.');
          if (!sameHistory(fresh.watermark, envelope.watermark)) { envelope = fresh; continue; }
          if (!audit) this.assertHealthy(prefix.watermark);
          await this.accept(prefix, owner);
          const pendingHealth = this.options.pins?.pendingHealth(prefix.watermark);
          if (pendingHealth) await owner.wait(pendingHealth);
          if (!audit) this.assertHealthy(prefix.watermark);
          fresh = await getEnvelope();
          if (!fresh) throw new AzureSyncError('NOT_FOUND', 'The cloud session disappeared before history publication.');
          if (historyNamespace(fresh.watermark) !== namespace) throw new AzureSyncError('GENERATION_CHANGED', 'The immutable history binding changed before prefix publication.');
          if (!sameHistory(fresh.watermark, prefix.watermark)) { envelope = fresh; continue; }
          await owner.check();
          if (audit && !await this.clearAudit(prefix.watermark, auditRevision, owner)) this.assertHealthy(prefix.watermark);
          await owner.check(); this.assertHealthy(prefix.watermark);
          const memoryRetained = this.memoryPut(prefix);
          if (!audit && reservation?.placement === 'memory' && !memoryRetained) throw new AzureSyncError('LIMIT', 'Active canonical memory reservations changed before publication. Retry after releasing another active owner.');
          if (reservation) this.retention.commit(reservation);
          return this.result(fresh, prefix);
        } catch (error) {
          await owner.check();
          if (error instanceof AzureSyncError && error.code === 'CONFLICT' && (this.pin(envelope.watermark)?.eventCount ?? 0) > envelope.watermark.eventCount) {
            const fresh = await getEnvelope();
            if (fresh && !sameHistory(fresh.watermark, envelope.watermark)) { envelope = fresh; continue; }
          }
          if (usedDisk && error instanceof AzureSyncError && ['CORRUPT_REMOTE', 'COMMITTED_INDEX_CORRUPT', 'INVALID_RECORD'].includes(error.code)) { prepared = undefined; continue; }
          if (error instanceof AzureSyncError && ['CORRUPT_REMOTE', 'COMMITTED_INDEX_CORRUPT', 'INVALID_RECORD', 'NOT_FOUND', ...(audit ? ['LIMIT'] : [])].includes(error.code)) {
            const fresh = await getEnvelope();
            if (fresh && historyNamespace(fresh.watermark) !== namespace) throw new AzureSyncError('GENERATION_CHANGED', 'The immutable history binding changed during the selected-chain walk.');
            if (fresh && !sameHistory(fresh.watermark, envelope.watermark)) { envelope = fresh; continue; }
            if (audit) await this.failedAudit(envelope.watermark, error, owner);
          }
          throw error;
        }
      }
      throw new AzureSyncError('TRANSIENT', 'The cloud history kept advancing during verification. Retry within a new operation deadline.');
    } finally { if (reservation) this.retention.rollback(reservation, owner); enrollment?.release(); release(); }
  }
  seedConfirmedUpload(input: ConfirmedHistoryUpload, context: HistoryReadContext = {}): Promise<boolean> {
    const sessionId = input.receipt.entity.sessionId;
    const owner = this.owner(sessionId, context);
    return this.track((async () => {
      const enrollment = this.retention.enroll(sessionId, owner);
      let reservation: RetentionReservation | undefined;
      try {
      await owner.check();
      const receipt = structuredClone(input.receipt); const base = structuredClone(input.base); const row = structuredClone(input.row); const bytes = Buffer.from(input.compressed);
      const envelope = await this.envelope(sessionId, owner, true);
      if (!envelope) return false;
      this.assertHealthy(envelope.watermark); enrollment.bind(envelope.watermark);
      const receiptW = historyWatermark(this.scopeId, receipt.entity); const baseW = historyWatermark(this.scopeId, base.entity);
      if (!sameHistory(receiptW, envelope.watermark) || historyNamespace(baseW) !== historyNamespace(receiptW)) return false;
      const committed = await owner.io(() => this.repository.getBatch(row.rowKey, this.ioContext(owner)));
      if (!committed || canonicalJson(committed) !== canonicalJson(row)) return false;
      let prefix = this.memoryGet(baseW);
      if (prefix && !sameHistory(prefix.watermark, baseW)) return false;
      if (!prefix) {
        if (baseW.eventCount !== 0) return false;
        prefix = await this.verify(envelope.header, baseW, [], [], owner);
      }
      const suffix = await selectCommittedSuffix(receipt.entity, async key => key === row.rowKey ? committed : undefined, { manifest: prefix.watermark, rows: prefix.rows }, 1);
      if (suffix.rows.length !== 1 || suffix.rows[0]!.rowKey !== row.rowKey) return false;
      const next = await this.verify(envelope.header, receiptW, [...prefix.rows, row], [...prefix.compressed, bytes], owner);
      try { reservation = await this.reserve(this.size(next), owner); }
      catch (error) { if (!(error instanceof AzureSyncError && error.code === 'LIMIT')) throw error; }
      const diskRetained = await this.disk.write(next, owner);
      const fresh = await this.envelope(sessionId, owner, true);
      if (!fresh || !sameHistory(fresh.watermark, receiptW)) return false;
      this.assertHealthy(receiptW);
      await this.accept(next, owner);
      const pendingHealth = this.options.pins?.pendingHealth(receiptW);
      if (pendingHealth) await owner.wait(pendingHealth);
      const final = await this.envelope(sessionId, owner, true);
      if (!final || !sameHistory(final.watermark, receiptW)) return false;
      await owner.check(); this.assertHealthy(receiptW);
      const memoryRetained = this.memoryPut(next);
      if (reservation && (reservation.placement === 'memory' ? memoryRetained : diskRetained)) this.retention.commit(reservation);
      return true;
      } finally { if (reservation) this.retention.rollback(reservation, owner); enrollment.release(); }
    })());
  }
  /** Explicit activation receipt only: no automatic generation adoption or retained-history reset. */
  confirmGenerationActivation(intentInput: ResurrectionIntent, receiptInput: StoredManifest, context: HistoryReadContext & { readonly check: () => void | Promise<void> }): Promise<void> {
    const intent = parseRecord(resurrectionIntentSchema, structuredClone(intentInput), 'explicit history activation intent');
    const receipt = structuredClone(receiptInput);
    const sessionId = receipt.entity.sessionId; const owner = this.owner(sessionId, context);
    return this.track((async () => {
      if (!context.check) throw new AzureSyncError('PRECONDITION', 'Explicit generation activation requires its durable intent guard.');
      await owner.check();
      if (intent.priorState === 'disabled') return; // Retained history needs canonical verification, never an empty reset.
      const target = historyWatermark(this.scopeId, intent.target);
      validateCommittedManifest(intent.target);
      if (intent.targetGeneration !== intent.priorGeneration + 1 || target.generation !== intent.targetGeneration || target.sessionId !== sessionId || target.rootSessionId !== sessionId || target.rootGeneration !== target.generation || target.eventCount !== 0 || intent.target.resurrectionId !== intent.operationId || target.chainHash !== intent.genesisHash) throw new AzureSyncError('PRECONDITION', 'The durable intent does not name an exact empty root activation.');
      const fresh = await this.envelope(sessionId, owner, true, true);
      if (!fresh || historyNamespace(fresh.watermark) !== historyNamespace(target) || historyNamespace(historyWatermark(this.scopeId, receipt.entity)) !== historyNamespace(target) || fresh.manifest.entity.resurrectionId !== intent.operationId || receipt.entity.resurrectionId !== intent.operationId || fresh.manifest.entity.previousGeneration !== intent.priorGeneration || receipt.entity.previousGeneration !== intent.priorGeneration || fresh.watermark.generation !== intent.targetGeneration || fresh.watermark.rootSessionId !== sessionId || fresh.watermark.rootGeneration !== fresh.watermark.generation) throw new AzureSyncError('PRECONDITION', 'The explicit generation activation receipt is no longer current.');
      const current = this.pin(fresh.watermark);
      if (current && historyNamespace(current) === historyNamespace(fresh.watermark)) {
        compareAccepted(current, fresh.watermark); return; // Idempotent intent retry must never lower an already accepted new tip.
      }
      if (current && current.generation !== intent.priorGeneration) throw new AzureSyncError('CONFLICT', 'The accepted history no longer belongs to the explicitly activated prior generation.');
      const genesis = genesisHash(sessionId, fresh.watermark.generation, fresh.watermark.headerHash, fresh.watermark.schemaVersion);
      const empty: HistoryWatermark = { ...fresh.watermark, eventCount: 0, headSeq: -1, headHash: genesis, chainHash: genesis, batchCount: 0 };
      delete empty.lastBatchRowKey; delete empty.lastBatchGeneration; delete empty.lastBatchBlobName;
      try { validateStoredEvents(fresh.header, [] as never); }
      catch { throw new AzureSyncError('INVALID_RECORD', 'The activated empty generation has an invalid canonical storage header.'); }
      if (this.options.pins) await owner.wait(this.options.pins.activateGeneration(current, empty, () => owner.check()));
      await owner.check(); this.accepted.set(this.pinKey(empty), immutable(structuredClone(empty)));
      const final = await this.envelope(sessionId, owner, true);
      if (!final || final.manifest.entity.resurrectionId !== intent.operationId) throw new AzureSyncError('PRECONDITION', 'The explicit activation changed before confirmation.');
    })());
  }
  /** Intent/runtime revocation fences active calls. Payload eviction never erases accepted H. */
  invalidate(sessionId?: string): void {
    this.retention.invalidate(sessionId);
    if (sessionId === undefined) {
      for (const controller of this.sessions.values()) controller.abort();
      this.sessions.clear(); this.memory.clear(); this.memoryWeight = 0; this.pressure.clear(); this.capacityPressure.clear();
    } else {
      this.sessions.get(sessionId)?.abort(); this.sessions.delete(sessionId);
      for (const [key, prefix] of this.memory) if (prefix.watermark.sessionId === sessionId) { this.memory.delete(key); this.memoryWeight -= prefix.weight; }
      for (const [key, watermark] of this.pressure) if ((JSON.parse(watermark) as HistoryWatermark).sessionId === sessionId) { this.pressure.delete(key); this.capacityPressure.delete(key); }
    }
  }
  async close(): Promise<void> {
    this.runtime.abort(); this.invalidate();
    await Promise.allSettled([...this.operations]);
    await this.fetches.close();
  }
}
