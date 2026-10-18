/**
 * Genesis and per-event cumulative commitments. Historical batches are valid by
 * generation/header/chain/payload; publication epochs are a separate fence.
 * @module @1yefuwang1/dsh-azure-sync/sync/chain
 */
import { AzureSyncError } from '../azure/errors.js';
import { bytes32, canonicalJson, eventHash, payloadHash, sha256Hex } from './canonical.js';
import { CLOUD_SCHEMA_VERSION } from '../schema.js';

export interface ChainMetadata {
  readonly startSeq: number;
  readonly endSeq: number;
  readonly eventCount: number;
  readonly prevChainHash: string;
  readonly chainHash: string;
  readonly headHash: string;
  readonly payloadHash: string;
}

interface SequencedEvent {
  readonly seq: number;
}

/** Bind the canonical header and exact inherited cut. */
export function headerHash(header: unknown, inheritedEventCount: number): string {
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) {
    throw new AzureSyncError('INVALID_RECORD', 'The inherited event count must be a non-negative safe integer.');
  }
  return sha256Hex('header\0', canonicalJson(header), '\0', String(inheritedEventCount));
}

/** Genesis hash binds the session identity, generation, header, and schema version. */
export function genesisHash(sessionId: string, generation: number, headerBinding: string, schemaVersion = CLOUD_SCHEMA_VERSION): string {
  if (sessionId.length === 0) throw new AzureSyncError('INVALID_RECORD', 'A genesis hash requires a session id.');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new AzureSyncError('INVALID_RECORD', 'A genesis hash requires a positive generation.');
  if (!/^[0-9a-f]{64}$/u.test(headerBinding)) throw new AzureSyncError('INVALID_RECORD', 'A genesis hash requires a 64-hex header binding.');
  return sha256Hex('dsh-azure-sync\0', String(schemaVersion), '\0', sessionId, '\0', String(generation), '\0', headerBinding);
}

/** The empty committed chain is the genesis hash, not a special null. */
export function emptyChain(genesis: string): string {
  return genesis;
}

function assertEvents(events: readonly SequencedEvent[]): void {
  if (events.length === 0) throw new AzureSyncError('INVALID_RECORD', 'A batch must contain at least one event.');
  let expected: number | undefined;
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new AzureSyncError('INVALID_RECORD', 'Every event must have a non-negative integer seq.');
    if (expected !== undefined && event.seq !== expected) throw new AzureSyncError('INVALID_RECORD', 'A batch must contain contiguous events.');
    expected = event.seq + 1;
  }
}

/** Compute the complete commitment for one non-empty batch. */
export function chainEvents(prevChainHash: string, events: readonly SequencedEvent[]): ChainMetadata {
  assertEvents(events);
  let chain = bytes32(prevChainHash);
  let head = '';
  for (const event of events) {
    head = eventHash(event);
    chain = Buffer.from(sha256Hex(chain, bytes32(head)), 'hex');
  }
  const first = events[0] as SequencedEvent;
  const last = events[events.length - 1] as SequencedEvent;
  return Object.freeze({
    startSeq: first.seq,
    endSeq: last.seq,
    eventCount: events.length,
    prevChainHash,
    chainHash: chain.toString('hex'),
    headHash: head,
    payloadHash: payloadHash(events),
  });
}

/** Verify a batch's recomputed chain and payload against its recorded metadata. */
export function verifyBatchChain(events: readonly SequencedEvent[], metadata: ChainMetadata, expectedGenesis?: string): ChainMetadata {
  if (events.length !== metadata.eventCount) throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', 'A committed batch event count does not match its metadata.');
  if (expectedGenesis !== undefined && metadata.prevChainHash !== expectedGenesis) {
    throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', 'The first committed batch does not link to genesis.');
  }
  const computed = chainEvents(metadata.prevChainHash, events);
  if (computed.startSeq !== metadata.startSeq || computed.endSeq !== metadata.endSeq ||
      computed.chainHash !== metadata.chainHash || computed.headHash !== metadata.headHash ||
      computed.payloadHash !== metadata.payloadHash) {
    throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', 'A committed batch failed its payload/event-chain verification.');
  }
  return computed;
}

export function verifyHeaderBinding(header: unknown, inheritedEventCount: number, expected: string): void {
  if (headerHash(header, inheritedEventCount) !== expected) {
    throw new AzureSyncError('INVALID_RECORD', 'The session header does not match its recorded binding.');
  }
}
