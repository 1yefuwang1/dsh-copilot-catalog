/** Strict selected-chain verification, including exact verified-prefix suffix anchors. */
import { AzureSyncError } from '../azure/errors.js';
import { batchRowKey, batchRowSchema, type BatchRow, type CloudSessionEntity } from '../schema.js';
import { genesisHash } from './chain.js';

export interface CommittedChain { readonly rows: readonly BatchRow[]; readonly genesis: string; }
export type CommittedManifest = Pick<CloudSessionEntity,
  'partitionKey' | 'schemaVersion' | 'sessionId' | 'generation' | 'headerHash' | 'eventCount' | 'headSeq' | 'headHash' |
  'chainHash' | 'batchCount' | 'lastBatchRowKey' | 'lastBatchGeneration' | 'lastBatchBlobName'>;
export interface CommittedAnchor { readonly manifest: CommittedManifest; readonly rows: readonly BatchRow[]; }
function corrupt(message: string): never { throw new AzureSyncError('COMMITTED_INDEX_CORRUPT', message); }
export function validateCommittedManifest(manifest: CommittedManifest): string {
  const genesis = genesisHash(manifest.sessionId, manifest.generation, manifest.headerHash, manifest.schemaVersion);
  if (![manifest.eventCount, manifest.batchCount].every(value => Number.isSafeInteger(value) && value >= 0) || manifest.headSeq !== manifest.eventCount - 1) corrupt('The committed manifest has invalid counts or head sequence.');
  if (manifest.eventCount === 0) {
    if (manifest.chainHash !== genesis || manifest.headHash !== genesis || manifest.batchCount !== 0 || manifest.lastBatchRowKey !== undefined || manifest.lastBatchGeneration !== undefined || manifest.lastBatchBlobName !== undefined) corrupt('An empty manifest must have exact genesis, zero batches and no tip fields.');
  } else if (manifest.batchCount < 1 || manifest.batchCount > manifest.eventCount || !manifest.lastBatchRowKey || !manifest.lastBatchBlobName || manifest.lastBatchGeneration !== manifest.generation) corrupt('A non-empty manifest must have a complete generation-bound batch tip.');
  return genesis;
}
export function validateCommittedRow(manifest: CommittedManifest, row: BatchRow, requestedKey = row.rowKey): void {
  if (!batchRowSchema.safeParse(row).success) corrupt('A committed batch row has invalid bounded fields.');
  if (row.rowKey !== requestedKey || row.rowKey !== batchRowKey(row.sessionId, row.generation, row.startSeq) || row.partitionKey !== manifest.partitionKey || row.schemaVersion !== manifest.schemaVersion || row.sessionId !== manifest.sessionId || row.generation !== manifest.generation) corrupt('A committed batch row has the wrong key, partition or session binding.');
  if (row.eventCount < 1 || row.endSeq < row.startSeq || row.eventCount !== row.endSeq - row.startSeq + 1 || row.endSeq >= manifest.eventCount) corrupt('A committed batch has an invalid non-empty range.');
  if (row.prevBatchRowKey === row.rowKey) corrupt('A committed batch points to itself.');
  // A historical createdEpoch is deliberately independent of the current writer epoch.
  const prefix = `v1/sessions/${Buffer.from(manifest.sessionId).toString('base64url')}/gen-${manifest.generation}/batches/`;
  if (row.blobName !== `${prefix}${row.startSeq}-${row.createdEpoch}-${row.payloadHash.slice(0, 16)}.jsonl.gz`) corrupt('A committed batch blob does not match its exact generation, sequence, historical epoch and payload identity.');
}
function verifyOrdered(manifest: CommittedManifest, rows: readonly BatchRow[]): CommittedChain {
  const genesis = validateCommittedManifest(manifest);
  if (rows.length !== manifest.batchCount) corrupt('The committed batch count does not match the manifest.');
  let expectedStart = 0;
  let previous: BatchRow | undefined;
  let chain = genesis;
  for (const row of rows) {
    validateCommittedRow(manifest, row);
    if (row.startSeq !== expectedStart || row.prevChainHash !== chain || row.prevBatchRowKey !== previous?.rowKey) corrupt('The committed batch boundary, previous-row link or chain commitment is broken.');
    expectedStart = row.endSeq + 1; chain = row.chainHash; previous = row;
  }
  if (expectedStart !== manifest.eventCount || chain !== manifest.chainHash) corrupt('The committed chain does not cover the manifest commitment.');
  if (previous && (previous.endSeq !== manifest.headSeq || previous.headHash !== manifest.headHash || previous.rowKey !== manifest.lastBatchRowKey || previous.generation !== manifest.lastBatchGeneration || previous.blobName !== manifest.lastBatchBlobName)) corrupt('The complete committed tip does not match the manifest.');
  return { rows, genesis };
}
/** Cold linked selection: unchosen sibling candidates are never interpreted as history. */
export function selectCommittedChain(manifest: CommittedManifest, rows: Iterable<BatchRow>): CommittedChain {
  validateCommittedManifest(manifest);
  const byKey = new Map<string, BatchRow>();
  for (const row of rows) { if (byKey.has(row.rowKey)) corrupt('The committed batch index contains duplicate row keys.'); byKey.set(row.rowKey, row); }
  const reversed: BatchRow[] = [];
  const seen = new Set<string>();
  let key = manifest.lastBatchRowKey;
  while (key !== undefined) {
    if (seen.has(key) || reversed.length >= manifest.batchCount) corrupt('The committed batch walk contains a cycle or exceeds its count.');
    seen.add(key);
    const row = byKey.get(key);
    if (!row) corrupt('The committed batch index is missing a linked row.');
    validateCommittedRow(manifest, row, key);
    reversed.push(row); key = row.prevBatchRowKey;
  }
  return verifyOrdered(manifest, reversed.reverse());
}
/** Point-walk only chosen new rows, stopping at the exact previously verified boundary. */
export async function selectCommittedSuffix(manifest: CommittedManifest, getBatch: (key: string) => Promise<BatchRow | undefined>, anchor?: CommittedAnchor, maxRows = 100_000): Promise<CommittedChain> {
  const genesis = validateCommittedManifest(manifest);
  const lower = anchor?.manifest;
  if (anchor) {
    verifyOrdered(anchor.manifest, anchor.rows);
    if (lower!.partitionKey !== manifest.partitionKey || lower!.sessionId !== manifest.sessionId || lower!.generation !== manifest.generation || lower!.schemaVersion !== manifest.schemaVersion || lower!.headerHash !== manifest.headerHash || lower!.eventCount > manifest.eventCount) corrupt('The verified prefix is not an anchor for this manifest.');
  }
  const boundary = lower?.lastBatchRowKey;
  const reversed: BatchRow[] = [];
  const seen = new Set<string>();
  let key = manifest.lastBatchRowKey;
  const missingCount = manifest.batchCount - (lower?.batchCount ?? 0);
  if (!Number.isSafeInteger(maxRows) || maxRows < 0 || missingCount < 0 || missingCount > maxRows) throw new AzureSyncError('LIMIT', 'The committed batch traversal exceeds the configured limit.');
  while (key !== boundary) {
    if (key === undefined || seen.has(key) || reversed.length >= missingCount || reversed.length >= maxRows) corrupt('The selected chain does not reach its exact verified boundary.');
    seen.add(key);
    const requested = key;
    const row = await getBatch(requested);
    if (!row) corrupt('The committed batch index is missing a selected row.');
    validateCommittedRow(manifest, row, requested);
    reversed.push(row); key = row.prevBatchRowKey;
  }
  if (reversed.length !== missingCount) corrupt('The selected suffix batch count does not match its anchor.');
  const suffix = reversed.reverse();
  verifyOrdered(manifest, [...(anchor?.rows ?? []), ...suffix]);
  return { rows: suffix, genesis };
}
