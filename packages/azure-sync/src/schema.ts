/**
 * Validated cloud and local record schemas. Unknown schema versions and fields
 * fail closed; display-only strings are bounded before any Table write.
 * @module @1yefuwang1/dsh-azure-sync/schema
 */
import { z } from 'zod';
import { AzureSyncError } from './azure/errors.js';

export const CLOUD_SCHEMA_VERSION = 4;
export const LOCAL_DOMAIN_VERSION = 5;
export const MAX_TABLE_STRING = 32 * 1024;
export const MAX_PATH_LENGTH = 4096;
export const INT64_MAX = Number.MAX_SAFE_INTEGER;

const int64 = z.number().int().min(0).max(INT64_MAX);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const nonEmpty = (max: number) => z.string().min(1).max(max);
export const platformSchema = z.enum(['darwin', 'win32', 'linux']);
export type Platform = z.infer<typeof platformSchema>;

export const importStateSchema = z.enum([
  'planned', 'creating', 'appending', 'attachments', 'warming', 'complete', 'degraded', 'failed',
]);
export type ImportState = z.infer<typeof importStateSchema>;

export const syncStatusSchema = z.enum([
  'setup-needed', 'auth-error', 'pending-materialization', 'syncing', 'synced', 'retrying',
  'ownership-unverified', 'paused-other-device', 'lease-lost', 'needs-folder', 'unmappable-cwd',
  'cwd-unmappable', 'mapping-unstable', 'ambiguous-mapping', 'conflict', 'removed-remotely',
  'generation-changed', 'remote-missing', 'remote-ahead-live', 'committed-index-corrupt',
  'corrupt-remote', 'incompatible-format', 'no-cwd', 'schedule-unsafe', 'preset-missing',
  'model-unavailable', 'attachments-unavailable', 'attachment-unsupported', 'degraded',
  'importing', 'import-incomplete', 'import-race', 'drain-failed', 'projection-warm-partial',
  'projection-warm-failed', 'live-restart-required', 'block-conflict', 'detached',
]);
export type SyncStatus = z.infer<typeof syncStatusSchema>;

/** Encode one opaque id into a path/Table-key-safe component. */
export function encodeKeyPart(value: string): string {
  if (value.length === 0) throw new AzureSyncError('INVALID_RECORD', 'A Table/blob key component must not be empty.');
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeKeyPart(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AzureSyncError('INVALID_RECORD', 'A Table/blob key component is malformed.');
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (decoded.length === 0) throw new AzureSyncError('INVALID_RECORD', 'A Table/blob key component decoded to an empty value.');
  return decoded;
}

export function sessionRowKey(sessionId: string): string {
  return `session:${encodeKeyPart(sessionId)}`;
}

export function deviceRowKey(deviceId: string): string {
  return `device:${encodeKeyPart(deviceId)}`;
}

export function batchRowKey(sessionId: string, generation: number, startSeq: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new AzureSyncError('INVALID_RECORD', 'A batch generation must be a positive safe integer.');
  if (!Number.isSafeInteger(startSeq) || startSeq < 0) throw new AzureSyncError('INVALID_RECORD', 'A batch start sequence must be a non-negative safe integer.');
  return `batch:${encodeKeyPart(sessionId)}:gen-${generation}:${String(startSeq).padStart(12, '0')}`;
}

const batchKeyPattern = /^batch:([A-Za-z0-9_-]+):gen-(\d+):(\d{12})$/u;

export function parseBatchRowKey(rowKey: string): { sessionId: string; generation: number; startSeq: number } {
  const match = batchKeyPattern.exec(rowKey);
  if (match === null) throw new AzureSyncError('INVALID_RECORD', 'A committed batch row key is malformed.');
  const sessionId = decodeKeyPart(match[1] as string);
  const generation = Number(match[2]);
  const startSeq = Number(match[3]);
  if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(startSeq) || startSeq < 0) {
    throw new AzureSyncError('INVALID_RECORD', 'A committed batch row key has an invalid generation or sequence.');
  }
  return { sessionId, generation, startSeq };
}

const optionalText = (max = MAX_TABLE_STRING) => z.string().max(max).optional();
const optionalPath = z.string().min(1).max(MAX_PATH_LENGTH).optional();

/** Canonical session manifest entity. */
export const cloudSessionEntitySchema = z.object({
  partitionKey: nonEmpty(1024),
  rowKey: nonEmpty(1024),
  schemaVersion: z.literal(CLOUD_SCHEMA_VERSION),
  sessionId: nonEmpty(256),
  generation: int64.min(1),
  writerEpoch: int64,
  state: z.enum(['active', 'disabled', 'deleted']),
  enabled: z.boolean(),
  headerJson: nonEmpty(MAX_TABLE_STRING),
  headerHash: hex64,
  inheritedEventCount: int64,
  formatVersion: int64,
  eventCount: int64,
  headSeq: z.number().int().min(-1).max(INT64_MAX),
  headHash: hex64,
  chainHash: hex64,
  batchCount: int64,
  lastBatchRowKey: nonEmpty(1024).optional(),
  lastBatchGeneration: int64.min(1).optional(),
  lastBatchBlobName: nonEmpty(1024).optional(),
  cwd: optionalPath,
  sourceDeviceId: nonEmpty(256),
  sourcePlatform: platformSchema,
  workspaceTitle: optionalText(4096),
  title: optionalText(4096),
  gitJson: optionalText(MAX_TABLE_STRING),
  rootSessionId: nonEmpty(256),
  rootGeneration: int64.min(1),
  enabledBy: optionalText(256),
  enabledAt: int64.optional(),
  lastWriterDevice: optionalText(256),
  updatedAt: int64,
  leaseOwner: optionalText(256),
  leaseUntil: int64.optional(),
  deletedAt: int64.optional(),
  deletedBy: optionalText(256),
  previousGeneration: int64.min(1).optional(),
  // Unique explicit activation token; retained across same-generation tip/epoch updates.
  resurrectionId: z.string().uuid().optional(),
  // Durable tombstone progress; resurrection must finish the generation sweep first.
  cleanupPending: z.boolean().optional(),
}).strict();
export type CloudSessionEntity = z.infer<typeof cloudSessionEntitySchema>;

/** One immutable committed batch row in the linked index. */
export const batchRowSchema = z.object({
  partitionKey: nonEmpty(1024),
  rowKey: nonEmpty(1024),
  schemaVersion: z.literal(CLOUD_SCHEMA_VERSION),
  sessionId: nonEmpty(256),
  generation: int64.min(1),
  startSeq: int64,
  endSeq: int64,
  eventCount: int64,
  blobName: nonEmpty(1024),
  payloadHash: hex64,
  prevChainHash: hex64,
  chainHash: hex64,
  headHash: hex64,
  prevBatchRowKey: nonEmpty(1024).optional(),
  createdEpoch: int64,
  deviceId: nonEmpty(256),
  createdAt: int64,
}).strict();
export type BatchRow = z.infer<typeof batchRowSchema>;

export const deviceEntitySchema = z.object({
  partitionKey: nonEmpty(1024),
  rowKey: nonEmpty(1024),
  schemaVersion: z.literal(CLOUD_SCHEMA_VERSION),
  deviceId: nonEmpty(256),
  name: nonEmpty(4096),
  platform: platformSchema,
  appVersion: optionalText(256),
  firstSeen: int64,
  lastSeen: int64,
}).strict();
export type DeviceEntity = z.infer<typeof deviceEntitySchema>;

export const metaEntitySchema = z.object({
  partitionKey: nonEmpty(1024),
  rowKey: z.literal('meta'),
  schemaVersion: z.literal(CLOUD_SCHEMA_VERSION),
  createdAt: int64,
  container: nonEmpty(256),
  table: nonEmpty(256),
  lastSeenBy: optionalText(256),
}).strict();
export type MetaEntity = z.infer<typeof metaEntitySchema>;

/** Lowercase Blob metadata names Azure returns. */
export const batchBlobMetadataSchema = z.object({
  startseq: z.string().regex(/^\d+$/u),
  endseq: z.string().regex(/^\d+$/u),
  eventcount: z.string().regex(/^\d+$/u),
  prevchainhash: hex64,
  chainhash: hex64,
  headhash: hex64,
  headerhash: hex64,
  generation: z.string().regex(/^\d+$/u),
  createdepoch: z.string().regex(/^\d+$/u),
  deviceid: z.string().min(1).max(256),
  schemaversion: z.literal(String(CLOUD_SCHEMA_VERSION)),
  payloadhash: hex64,
}).strict();
export type BatchBlobMetadata = z.infer<typeof batchBlobMetadataSchema>;

export const admissionReceiptSchema = z.object({
  reason: syncStatusSchema,
  messageIds: z.array(nonEmpty(256)).max(256),
  turn: int64.optional(),
  step: int64.optional(),
  seqStart: int64.optional(),
  seqEnd: int64.optional(),
  at: int64,
}).strict();
export type AdmissionReceipt = z.infer<typeof admissionReceiptSchema>;

/** Write-ahead record of ONE explicit root activation, never permission to adopt another generation. */
export const resurrectionIntentSchema = z.object({
  operationId: z.string().uuid(),
  priorGeneration: int64.min(1),
  targetGeneration: int64.min(1),
  priorState: z.enum(['deleted', 'disabled']),
  sourceETag: nonEmpty(1024),
  genesisHash: hex64,
  // Exact proposed CAS bytes retain the header/cut and, for re-enable, the entire old tip.
  target: cloudSessionEntitySchema,
}).strict();
export type ResurrectionIntent = z.infer<typeof resurrectionIntentSchema>;

/** Device-local placement binding; absence alone denotes the legacy global-mapping path. */
export const sessionDestinationSchema = z.object({
  version: z.literal(1), operationId: z.string().uuid(), scope: nonEmpty(512), intentId: z.string().uuid(),
  mode: z.enum(['local', 'worktree']), headerCwd: nonEmpty(MAX_PATH_LENGTH), localHeaderHash: hex64,
  mapping: z.object({ id: z.string().uuid(), revision: hex64, remotePlatform: platformSchema, remotePrefix: nonEmpty(MAX_PATH_LENGTH), localRoot: nonEmpty(MAX_PATH_LENGTH) }).strict(),
  phase: z.enum(['pending', 'ready', 'cancelled']), journalRevision: int64,
  projectId: z.string().uuid().optional(), folderId: nonEmpty(256).optional(), worktreeId: z.string().uuid().optional(), workspaceId: nonEmpty(256).optional(),
}).strict();
export type SessionDestination = z.infer<typeof sessionDestinationSchema>;

/** Per-session local sync state. */
export const localSessionRecordSchema = z.object({
  sessionId: nonEmpty(256),
  enabled: z.boolean(),
  generation: int64.min(1),
  writerEpoch: int64,
  state: z.enum(['active', 'disabled', 'deleted']),
  status: syncStatusSchema,
  /** Explicit publication/admission consent for an actual endpoint namespace; never inferred from H or L. */
  publicationScope: hex64.optional(),
  /** Durable remote-health refusal; cached history or runtime restart cannot clear an audit failure. */
  remoteAuditFailure: z.enum(['corrupt-remote', 'committed-index-corrupt']).optional(),
  remoteAuditScope: hex64.optional(),
  deletedAt: int64.optional(),
  deletedBy: optionalText(256),
  previousGeneration: int64.min(1).optional(),
  cleanupPending: z.boolean().optional(),
  lastError: optionalText(4096),
  lastSyncedEventCount: int64.optional(),
  lastSyncedChainHash: hex64.optional(),
  lastSyncedHeaderHash: hex64.optional(),
  remoteETag: optionalText(1024),
  lastSyncedAt: int64.optional(),
  lastAttemptAt: int64.optional(),
  importState: importStateSchema.optional(),
  catchUpPending: z.boolean().optional(),
  importExpectedCount: int64.optional(),
  importExpectedChainHash: hex64.optional(),
  importAppendedCount: int64.optional(),
  importMappingId: z.string().uuid().optional(),
  importMappingRevision: hex64.optional(),
  importedThroughSeq: int64.optional(),
  canonicalCwd: optionalPath,
  localCwd: optionalPath,
  parentSession: nonEmpty(256).optional(),
  delegationDepth: int64.optional(),
  subagent: z.boolean().optional(),
  remapped: z.boolean(),
  needsFolder: z.boolean(),
  unmappablePaths: z.array(nonEmpty(MAX_PATH_LENGTH)).max(256),
  mappingUnstable: z.boolean(),
  degradedAttachments: z.array(nonEmpty(256)).max(1000),
  degradedAcknowledged: z.boolean(),
  conflictBackupPath: optionalPath,
  imported: z.boolean(),
  lastKnownDevice: optionalText(256),
  weArchived: z.boolean(),
  detached: z.boolean(),
  admissionReceipt: admissionReceiptSchema.optional(),
  admissionStopped: z.boolean().optional(),
  resurrectionIntent: resurrectionIntentSchema.optional(),
  resurrectionCancellationId: z.string().uuid().optional(),
  destination: sessionDestinationSchema.optional(),
}).strict();
export type LocalSessionRecord = z.infer<typeof localSessionRecordSchema>;

export const pathMappingSchema = z.object({
  id: z.string().uuid(),
  remotePrefix: nonEmpty(MAX_PATH_LENGTH),
  localPrefix: nonEmpty(MAX_PATH_LENGTH),
  remotePlatform: platformSchema,
  revision: hex64,
  createdAt: int64,
  updatedAt: int64,
}).strict();
export type PathMappingRecord = z.infer<typeof pathMappingSchema>;

export const localDeviceSchema = z.object({
  deviceId: nonEmpty(256),
  name: nonEmpty(4096),
  platform: platformSchema,
  firstSeen: int64,
}).strict();
export type LocalDeviceRecord = z.infer<typeof localDeviceSchema>;

export const localSettingsSchema = z.object({
  // Read legacy true values so old durable records cannot prevent startup.
  // SettingsService always resolves/writes false; thread opt-in stays explicit.
  defaultEnabled: z.boolean(),
  pullOnStartup: z.boolean(),
  // Preserve old v4 reads; SettingsService clamps/normalizes the runtime limit.
  pollSeconds: int64.min(30),
  auth: z.enum(['auto', 'connection-string', 'azure-cli', 'managed-identity']).optional(),
  accountName: z.string().regex(/^(?:[a-z0-9]{3,24})?$/u).optional(),
  managedIdentityClientId: z.string().regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/iu).optional(),
  // Write-ahead authentication intent: provider and domain writes are not atomic.
  authPending: z.object({
    id: z.string().uuid(),
    auth: z.enum(['auto', 'connection-string', 'azure-cli', 'managed-identity']),
    accountName: z.string().regex(/^(?:[a-z0-9]{3,24})?$/u),
    managedIdentityClientId: z.string().regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/iu),
    startedAt: int64,
  }).strict().optional(),
  authGeneration: z.string().uuid().optional(),
  // A CLI/identity recovery may ignore, but must never later reuse, an unknown secret.
  connectionUncertain: z.boolean().optional(),
  updatedAt: int64.optional(),
  lastPullAt: int64.optional(),
  lastPushAt: int64.optional(),
  lastError: optionalText(4096),
}).strict();
export type LocalSettingsRecord = z.infer<typeof localSettingsSchema>;

/** Base64url UTF-8 display name for Blob metadata; never put raw Unicode in Azure headers. */
export function encodeNameB64(value: string): string {
  if (value.length === 0) throw new AzureSyncError('INVALID_RECORD', 'An attachment display name must not be empty.');
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeNameB64(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AzureSyncError('INVALID_RECORD', 'An attachment display-name encoding is malformed.');
  return Buffer.from(value, 'base64url').toString('utf8');
}

export const attachmentMetadataSchema = z.object({
  attachmentid: nonEmpty(256),
  kind: z.enum(['image', 'file']),
  bytes: z.string().regex(/^\d+$/u),
  mediatype: nonEmpty(256),
  nameb64: z.string().regex(/^[A-Za-z0-9_-]+$/u).optional(),
  sha256: hex64,
}).strict();
export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;

/** Numeric fields stored as Azure Table Edm.Int64 (epochs and event counts). */
const INT64_FIELDS = new Set([
  'generation', 'writerEpoch', 'inheritedEventCount', 'formatVersion', 'eventCount', 'headSeq', 'batchCount',
  'lastBatchGeneration', 'enabledAt', 'updatedAt', 'leaseUntil', 'deletedAt', 'previousGeneration', 'rootGeneration',
  'startSeq', 'endSeq', 'createdEpoch', 'createdAt', 'firstSeen', 'lastSeen',
]);

function malformedInt64(): never {
  throw new AzureSyncError('INVALID_RECORD', 'A Table Int64 field is malformed.');
}

function decodeInt64Value(value: unknown): number {
  try {
    let big: bigint;
    if (typeof value === 'bigint') big = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    else if (typeof value === 'string' && /^-?\d+$/u.test(value)) big = BigInt(value);
    else if (value !== null && typeof value === 'object' && 'value' in value &&
      ((value as { type?: unknown }).type === 'Int64' || (value as { type?: unknown }).type === 'Edm.Int64')) {
      const raw = (value as { value?: unknown }).value;
      if (typeof raw !== 'bigint' && typeof raw !== 'number' && typeof raw !== 'string') malformedInt64();
      const text = String(raw);
      if (!/^-?\d+$/u.test(text)) malformedInt64();
      big = BigInt(text);
    } else {
      malformedInt64();
    }
    const number = Number(big);
    if (!Number.isSafeInteger(number)) throw new AzureSyncError('INVALID_RECORD', 'A Table Int64 field exceeds the safe JavaScript range.');
    return number;
  } catch (error) {
    if (error instanceof AzureSyncError) throw error;
    throw new AzureSyncError('INVALID_RECORD', 'A Table Int64 field is malformed.');
  }
}

/** Encode logical numbers as explicit Edm.Int64 values for the Table SDK. */
export function encodeCloudRecord<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || key === 'etag' || key === 'timestamp') continue;
    if (INT64_FIELDS.has(key) && (typeof value === 'number' || typeof value === 'bigint')) {
      encoded[key] = { type: 'Int64', value: String(value) };
    } else {
      encoded[key] = value;
    }
  }
  return encoded;
}

export interface DecodedCloudRecord<T> {
  readonly record: T;
  readonly etag?: string;
  readonly timestamp?: Date;
}

/** Strip SDK metadata, normalize Edm.Int64/bigint values, then validate the record. */
export function decodeCloudRecord<T>(schema: z.ZodType<T>, entity: unknown, label: string): DecodedCloudRecord<T> {
  if (entity === null || typeof entity !== 'object' || Array.isArray(entity)) {
    throw new AzureSyncError('INVALID_RECORD', `${label} is not a Table entity.`);
  }
  const raw: Record<string, unknown> = { ...(entity as Record<string, unknown>) };
  const etag = raw['etag'];
  const timestamp = raw['timestamp'];
  delete raw['etag'];
  delete raw['timestamp'];
  for (const key of Object.keys(raw)) if (key.startsWith('odata.')) delete raw[key];
  for (const field of INT64_FIELDS) {
    if (raw[field] !== undefined) raw[field] = decodeInt64Value(raw[field]);
  }
  const record = parseRecord(schema, raw, label);
  return {
    record,
    ...(typeof etag === 'string' ? { etag } : {}),
    ...(timestamp instanceof Date ? { timestamp } : {}),
  };
}

/** Parse an untrusted record, throwing a stable redacted error without echoing it. */
export function parseRecord<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AzureSyncError('INVALID_RECORD', `${label} failed schema validation.`);
  return result.data;
}
