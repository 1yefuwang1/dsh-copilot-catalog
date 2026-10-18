/**
 * Verified remote session reader: the manifest tip selects only the linked
 * committed chain; every candidate is decompressed within a bound, rehashed,
 * and chain-verified before import can see it.
 * @module @1yefuwang1/dsh-azure-sync/sync/remote-session
 */
import { gunzipSync } from 'node:zlib';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { AzureSyncError } from '../azure/errors.js';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import type { BatchRow } from '../schema.js';
import type { CloudRepository, StoredManifest } from './cloud-repository.js';
import { selectCommittedChain } from './committed-index.js';
import { verifyBatchChain, verifyHeaderBinding } from './chain.js';
import { sha256Hex } from './canonical.js';

export interface RemoteSession {
  readonly manifest: StoredManifest;
  readonly header: SessionHeader;
  readonly inheritedEventCount: number;
  readonly events: readonly SessionEvent[];
}

export interface RemoteSessionReaderOptions {
  readonly maxCompressedBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxEvents?: number;
}

export class RemoteSessionReader {
  private readonly repository: CloudRepository;
  private readonly options: RemoteSessionReaderOptions;

  constructor(repository: CloudRepository, options: RemoteSessionReaderOptions) {
    this.repository = repository;
    this.options = options;
  }

  async read(sessionId: string): Promise<RemoteSession | undefined> {
    const manifest = await this.repository.getManifest(sessionId);
    if (manifest === undefined) return undefined;
    if (manifest.entity.state === 'deleted') throw new AzureSyncError('REMOVED_REMOTELY', 'The cloud session is a tombstone.');
    if (manifest.entity.state === 'disabled') throw new AzureSyncError('DISABLED', 'The cloud session is disabled.');
    if (manifest.entity.sessionId !== sessionId) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud manifest identity does not match the requested session.');
    let header: SessionHeader;
    try { header = JSON.parse(manifest.entity.headerJson) as SessionHeader; }
    catch { throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud session header is not valid JSON.'); }
    if (header.id !== sessionId) throw new AzureSyncError('CORRUPT_REMOTE', 'The cloud header identity does not match the requested session.');
    verifyHeaderBinding(header, manifest.entity.inheritedEventCount, manifest.entity.headerHash);
    if (header.version !== 4 || manifest.entity.formatVersion !== 4) throw new AzureSyncError('INCOMPATIBLE_FORMAT', 'Only session format v4 can be imported.');

    const rows = await this.repository.listBatchRows(sessionId, manifest.entity.generation);
    const chain = selectCommittedChain(manifest.entity, rows);
    const events: SessionEvent[] = [];
    let expectedPrev = chain.genesis;
    for (const row of chain.rows) {
      const compressed = await this.repository.readCandidate(row.blobName, this.options.maxCompressedBytes);
      let payload: Buffer;
      try { payload = gunzipSync(compressed, { maxOutputLength: this.options.maxExpandedBytes }); }
      catch { throw new AzureSyncError('LIMIT', 'A committed batch exceeded the configured expansion bound.'); }
      if (sha256Hex(payload) !== row.payloadHash) throw new AzureSyncError('CORRUPT_REMOTE', 'A committed batch raw payload hash does not match its row.');
      const batchEvents = this.parseBatch(payload, row);
      try { verifyBatchChain(batchEvents, this.metadata(row), expectedPrev); }
      catch { throw new AzureSyncError('CORRUPT_REMOTE', 'A committed batch failed chain verification.'); }
      if (this.options.maxEvents !== undefined && events.length + batchEvents.length > this.options.maxEvents) throw new AzureSyncError('LIMIT', 'The cloud session exceeds the configured event limit.');
      events.push(...batchEvents);
      expectedPrev = row.chainHash;
    }
    if (events.length !== manifest.entity.eventCount) throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', 'The committed chain does not match the manifest event count.');
    try { validateStoredEvents(header, events as never); }
    catch { throw new AzureSyncError('INVALID_RECORD', 'The committed remote events do not satisfy the session storage contract.'); }
    return { manifest, header, inheritedEventCount: manifest.entity.inheritedEventCount, events };
  }

  private parseBatch(payload: Buffer, row: BatchRow): SessionEvent[] {
    const text = payload.toString('utf8');
    const lines = text.split('\n');
    if (lines.at(-1) !== '') throw new AzureSyncError('CORRUPT_REMOTE', 'A committed batch does not end with a newline.');
    lines.pop();
    if (lines.length !== row.eventCount) throw new AzureSyncError('CORRUPT_REMOTE', 'A committed batch event count is inconsistent.');
    const events: SessionEvent[] = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line) as SessionEvent); }
      catch { throw new AzureSyncError('CORRUPT_REMOTE', 'A committed batch contains invalid JSON.'); }
    }
    return events;
  }

  private metadata(row: BatchRow) {
    return {
      startSeq: row.startSeq, endSeq: row.endSeq, eventCount: row.eventCount,
      prevChainHash: row.prevChainHash, chainHash: row.chainHash, headHash: row.headHash, payloadHash: row.payloadHash,
    };
  }
}
