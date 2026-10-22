import { randomUUID } from 'node:crypto';
import { batchRowKey, encodeKeyPart, sessionRowKey, type BatchRow, type CloudSessionEntity, type LocalSessionRecord, type PathMappingRecord } from '../src/schema.js';

export const HEX_A = 'a'.repeat(64);
export const HEX_B = 'b'.repeat(64);
export const HEX_C = 'c'.repeat(64);

export function sessionHeader(overrides: Record<string, unknown> = {}) {
  return {
    version: 4,
    id: 'session-test',
    createdAt: 1,
    cwd: '/remote/project',
    isSeeded: false,
    ...overrides,
  };
}

export function event(seq: number, type = 'user/message', data: Record<string, unknown> = {}) {
  const payload = type === 'user/message'
    ? { id: `message-${seq}`, role: 'user', content: [], source: { kind: 'user' }, ...data }
    : data;
  return { type, seq, time: 1_000 + seq, data: payload, ...(type === 'user/message' ? { surfaceOp: 'append' } : {}) };
}

export function cloudSession(overrides: Partial<CloudSessionEntity> = {}): CloudSessionEntity {
  const sessionId = overrides.sessionId ?? `session-${randomUUID()}`;
  const base: CloudSessionEntity = {
    partitionKey: 'account',
    rowKey: sessionRowKey(sessionId),
    schemaVersion: 4,
    sessionId,
    generation: 1,
    writerEpoch: 1,
    state: 'active',
    enabled: true,
    headerJson: JSON.stringify(sessionHeader({ id: sessionId })),
    headerHash: HEX_A,
    inheritedEventCount: 0,
    formatVersion: 4,
    eventCount: 1,
    headSeq: 0,
    headHash: HEX_B,
    chainHash: HEX_C,
    batchCount: 1,
    lastBatchRowKey: batchRowKey(sessionId, 1, 0),
    lastBatchGeneration: 1,
    lastBatchBlobName: `v1/sessions/${encodeKeyPart(sessionId)}/gen-1/batches/0-1-${HEX_A.slice(0, 16)}.jsonl.gz`,
    cwd: '/remote/project',
    sourceDeviceId: 'device-a',
    sourcePlatform: 'linux',
    rootSessionId: sessionId,
    rootGeneration: overrides.generation ?? 1,
    updatedAt: 10,
  };
  return { ...base, ...overrides };
}

export function batchRow(sessionId: string, generation: number, startSeq: number, overrides: Partial<BatchRow> = {}): BatchRow {
  const base: BatchRow = {
    partitionKey: 'account',
    rowKey: batchRowKey(sessionId, generation, startSeq),
    schemaVersion: 4,
    sessionId,
    generation,
    startSeq,
    endSeq: startSeq,
    eventCount: 1,
    blobName: `v1/sessions/${encodeKeyPart(sessionId)}/gen-${generation}/batches/${startSeq}-${overrides.createdEpoch ?? 1}-${(overrides.payloadHash ?? HEX_A).slice(0, 16)}.jsonl.gz`,
    payloadHash: HEX_A,
    prevChainHash: HEX_A,
    chainHash: HEX_B,
    headHash: HEX_C,
    createdEpoch: 1,
    deviceId: 'device-a',
    createdAt: 1,
  };
  return { ...base, ...overrides };
}

export function localSession(overrides: Partial<LocalSessionRecord> = {}): LocalSessionRecord {
  const sessionId = overrides.sessionId ?? `session-${randomUUID()}`;
  return {
    sessionId,
    enabled: true,
    generation: 1,
    writerEpoch: 1,
    state: 'active',
    status: 'synced',
    remapped: false,
    needsFolder: false,
    unmappablePaths: [],
    mappingUnstable: false,
    degradedAttachments: [],
    degradedAcknowledged: false,
    imported: false,
    weArchived: false,
    detached: false,
    ...overrides,
  };
}

export function pathMapping(overrides: Partial<PathMappingRecord> = {}): PathMappingRecord {
  return {
    id: randomUUID(),
    remotePrefix: '/remote/project',
    localPrefix: '/local/project',
    remotePlatform: 'linux',
    revision: HEX_A,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
