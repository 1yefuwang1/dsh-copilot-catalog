/**
 * Lowercase Blob metadata for one immutable batch candidate. No display text
 * or raw Unicode is stored in Azure metadata headers.
 * @module @1yefuwang1/dsh-azure-sync/sync/blob-metadata
 */
import { CLOUD_SCHEMA_VERSION, type BatchBlobMetadata } from '../schema.js';

export interface BatchMetadataInput {
  readonly startSeq: number;
  readonly endSeq: number;
  readonly eventCount: number;
  readonly prevChainHash: string;
  readonly chainHash: string;
  readonly headHash: string;
  readonly headerHash: string;
  readonly generation: number;
  readonly createdEpoch: number;
  readonly deviceId: string;
  readonly schemaVersion: number;
  readonly payloadHash: string;
}

export function batchBlobMetadata(input: BatchMetadataInput): BatchBlobMetadata {
  return {
    startseq: String(input.startSeq),
    endseq: String(input.endSeq),
    eventcount: String(input.eventCount),
    prevchainhash: input.prevChainHash,
    chainhash: input.chainHash,
    headhash: input.headHash,
    headerhash: input.headerHash,
    generation: String(input.generation),
    createdepoch: String(input.createdEpoch),
    deviceid: input.deviceId,
    schemaversion: String(input.schemaVersion ?? CLOUD_SCHEMA_VERSION),
    payloadhash: input.payloadHash,
  };
}
