/**
 * The committed linked batch index. The session tip points to the last batch
 * row; each row points to the previous row in the same generation. Import
 * follows exactly this chain and ignores unchosen sibling candidates.
 * @module @1yefuwang1/dsh-azure-sync/sync/committed-index
 */
import { AzureSyncError } from '../azure/errors.js';
import { batchRowKey, type BatchRow, type CloudSessionEntity } from '../schema.js';
import { emptyChain, genesisHash } from './chain.js';

export interface CommittedChain {
  readonly rows: readonly BatchRow[];
  readonly genesis: string;
}

export type CommittedManifest = Pick<CloudSessionEntity,
  'sessionId' | 'generation' | 'headerHash' | 'eventCount' | 'chainHash' | 'lastBatchRowKey' | 'lastBatchGeneration'>;

function corrupt(message: string): never {
  throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', message);
}

/** Follow the explicit tip→previous links and verify the complete committed chain. */
export function selectCommittedChain(manifest: CommittedManifest, rows: Iterable<BatchRow>): CommittedChain {
  const genesis = genesisHash(manifest.sessionId, manifest.generation, manifest.headerHash);
  if (manifest.eventCount === 0) {
    if (manifest.chainHash !== emptyChain(genesis)) corrupt('An empty manifest must carry the genesis chain hash.');
    if (manifest.lastBatchRowKey !== undefined) corrupt('An empty manifest must not have a batch tip.');
    return { rows: [], genesis };
  }

  if (manifest.lastBatchRowKey === undefined) corrupt('A non-empty manifest must have a batch tip.');
  if (manifest.lastBatchGeneration !== manifest.generation) corrupt('The batch tip generation does not match the manifest.');

  const byKey = new Map<string, BatchRow>();
  for (const row of rows) {
    if (byKey.has(row.rowKey)) corrupt('The committed batch index contains duplicate row keys.');
    byKey.set(row.rowKey, row);
  }

  const reversed: BatchRow[] = [];
  const seen = new Set<string>();
  let key: string | undefined = manifest.lastBatchRowKey;
  while (key !== undefined) {
    if (seen.has(key)) corrupt('The committed batch index contains a cycle.');
    seen.add(key);
    const row = byKey.get(key);
    if (row === undefined) corrupt('The committed batch index is missing a linked row.');
    reversed.push(row);
    key = row.prevBatchRowKey;
  }
  reversed.reverse();

  let expectedStart = 0;
  let expectedPrevChain = genesis;
  let previous: BatchRow | undefined;
  for (const row of reversed) {
    if (row.rowKey !== batchRowKey(row.sessionId, row.generation, row.startSeq)) corrupt('A committed batch row key is not canonical.');
    if (row.sessionId !== manifest.sessionId || row.generation !== manifest.generation) corrupt('A committed batch row belongs to another session/generation.');
    if (row.startSeq !== expectedStart) corrupt('The committed batch chain has a gap or overlap.');
    if (row.endSeq < row.startSeq) corrupt('A committed batch has an invalid range.');
    if (row.eventCount !== row.endSeq - row.startSeq + 1) corrupt('A committed batch event count does not match its range.');
    if (row.prevChainHash !== expectedPrevChain) corrupt('A committed batch does not link to the previous chain hash.');
    if (previous === undefined) {
      if (row.prevBatchRowKey !== undefined) corrupt('The first committed batch must not have a previous row.');
    } else if (row.prevBatchRowKey !== previous.rowKey) {
      corrupt('A committed batch previous-row link is broken.');
    }
    if (previous !== undefined && previous.endSeq + 1 !== row.startSeq) corrupt('Committed batch ranges are not contiguous.');
    expectedStart = row.endSeq + 1;
    expectedPrevChain = row.chainHash;
    previous = row;
  }

  const tip = previous;
  if (tip === undefined) corrupt('A non-empty manifest resolved to no committed rows.');
  if (expectedStart !== manifest.eventCount) corrupt('The committed chain does not cover the manifest event count.');
  if (tip.chainHash !== manifest.chainHash) corrupt('The committed chain tip does not match the manifest chain hash.');
  if (tip.rowKey !== manifest.lastBatchRowKey) corrupt('The committed chain tip row does not match the manifest tip.');

  return { rows: reversed, genesis };
}
