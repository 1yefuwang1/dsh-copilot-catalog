/**
 * Pure bounded batch construction. The batch boundary is by event count and
 * exact canonical JSONL bytes; compression never changes identity.
 * @module @1yefuwang1/dsh-azure-sync/sync/batcher
 */
import { gzipSync } from 'node:zlib';
import { AzureSyncError } from '../azure/errors.js';
import { payloadBytes, payloadHash } from './canonical.js';
import { chainEvents, type ChainMetadata } from './chain.js';

export interface SequencedEvent {
  readonly seq: number;
}

export interface BatchPlan {
  readonly events: readonly SequencedEvent[];
  readonly startSeq: number;
  readonly endSeq: number;
  readonly payload: Buffer;
  readonly gzip: Buffer;
  readonly payloadHash: string;
  readonly chain: ChainMetadata;
}

export interface BatchLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
}

/** Take up to the count/byte caps from `fromSeq`; return undefined when no event remains. */
export function planBatch(events: readonly SequencedEvent[], fromSeq: number, limits: BatchLimits, prevChainHash: string): BatchPlan | undefined {
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new AzureSyncError('INVALID_RECORD', 'A batch start sequence must be non-negative.');
  if (limits.maxEvents < 1 || limits.maxBytes < 1) throw new AzureSyncError('LIMIT', 'Batch limits must be positive.');
  const selected: SequencedEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    if (event.seq < fromSeq) continue;
    if (selected.length > 0 && event.seq !== (selected[selected.length - 1] as SequencedEvent).seq + 1) {
      throw new AzureSyncError('INVALID_RECORD', 'A batch source has a sequence gap.');
    }
    if (selected.length >= limits.maxEvents) break;
    const encoded = payloadBytes([event]);
    if (selected.length === 0 && encoded.byteLength > limits.maxBytes) {
      throw new AzureSyncError('LIMIT', 'One event exceeds the configured batch byte limit.');
    }
    if (bytes + encoded.byteLength > limits.maxBytes) break;
    selected.push(event);
    bytes += encoded.byteLength;
  }
  if (selected.length === 0) return undefined;
  const payload = payloadBytes(selected);
  const chain = chainEvents(prevChainHash, selected);
  const first = selected[0] as SequencedEvent;
  const last = selected[selected.length - 1] as SequencedEvent;
  return {
    events: selected,
    startSeq: first.seq,
    endSeq: last.seq,
    payload,
    gzip: gzipSync(payload, { level: 9 }),
    payloadHash: payloadHash(selected),
    chain,
  };
}
