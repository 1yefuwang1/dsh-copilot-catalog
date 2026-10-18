/**
 * Stable Azure sync failures. Messages are safe to show; provider diagnostics,
 * connection strings, account keys, and SAS values never enter them.
 * @module @1yefuwang1/dsh-azure-sync/azure/errors
 */

export type AzureSyncErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'ACCOUNT_REQUIRED'
  | 'INSECURE_ENDPOINT'
  | 'INVALID_CONFIG'
  | 'CONTAINER_PUBLIC'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION'
  | 'THROTTLED'
  | 'TRANSIENT'
  | 'CANCELLED'
  | 'LIMIT'
  | 'INVALID_RECORD'
  | 'CORRUPT_REMOTE'
  | 'COMMITTED_INDEX_CORRUPT'
  | 'MAPPING_UNSTABLE'
  | 'AMBIGUOUS_MAPPING'
  | 'NEEDS_FOLDER'
  | 'UNMAPPABLE_CWD'
  | 'NO_CWD'
  | 'SCHEDULE_UNSAFE'
  | 'PRESET_MISSING'
  | 'MODEL_UNAVAILABLE'
  | 'PROVENANCE_MISMATCH'
  | 'LEASE_LOST'
  | 'OWNERSHIP_UNVERIFIED'
  | 'REMOVED_REMOTELY'
  | 'DISABLED'
  | 'GENERATION_CHANGED'
  | 'INCOMPATIBLE_FORMAT'
  | 'IMPORT_RACE'
  | 'IMPORT_INCOMPLETE'
  | 'ATTACHMENT_UNSUPPORTED'
  | 'PROJECTION_WARM_PARTIAL'
  | 'IMPORT_STATE'
  | 'AZURE_OPERATION_FAILED';

export class AzureSyncError extends Error {
  readonly code: AzureSyncErrorCode;

  constructor(code: AzureSyncErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AzureSyncError';
    this.code = code;
  }
}

interface ProviderFailure {
  statusCode?: unknown;
  code?: unknown;
  name?: unknown;
}

function providerFailure(error: unknown): ProviderFailure {
  return error !== null && typeof error === 'object' ? error as ProviderFailure : {};
}

/** HTTP status from an Azure SDK/REST failure, if one is present. */
export function statusOf(error: unknown): number | undefined {
  const value = providerFailure(error).statusCode;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/** Stable provider code (for example `BlobAlreadyExists`), if present. */
export function codeOf(error: unknown): string | undefined {
  const value = providerFailure(error).code;
  return typeof value === 'string' ? value : undefined;
}

export function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404 || codeOf(error) === 'ResourceNotFound' || codeOf(error) === 'BlobNotFound' || codeOf(error) === 'TableNotFound';
}

export function isAlreadyExists(error: unknown): boolean {
  return statusOf(error) === 409 || codeOf(error) === 'BlobAlreadyExists' || codeOf(error) === 'TableAlreadyExists' || codeOf(error) === 'EntityAlreadyExists';
}

export function isPreconditionFailed(error: unknown): boolean {
  return statusOf(error) === 412 || codeOf(error) === 'ConditionNotMet' || codeOf(error) === 'UpdateConditionNotSatisfied';
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

interface SafeCause {
  readonly name: string;
  readonly statusCode?: number;
  readonly code?: string;
}

/** Preserve only non-secret provider classification; never attach raw messages, URLs, or headers. */
function safeCause(error: unknown): SafeCause {
  const name = error instanceof Error && typeof error.name === 'string' && error.name.length > 0 ? error.name : 'Error';
  const status = statusOf(error);
  const code = codeOf(error);
  return {
    name,
    ...(status === undefined ? {} : { statusCode: status }),
    ...(code === undefined ? {} : { code }),
  };
}

/** Convert a provider failure into a stable, redacted sync failure. */
export function mapAzureError(error: unknown, operation: string): AzureSyncError {
  if (error instanceof AzureSyncError) return error;
  const cause = safeCause(error);
  if (isAbort(error)) return new AzureSyncError('CANCELLED', `Azure ${operation} was cancelled.`, { cause });
  const status = statusOf(error);
  if (status === 401 || status === 403) return new AzureSyncError('AUTH_FAILED', `Azure ${operation} was refused by the storage account. Check the credential and RBAC role assignments.`, { cause });
  if (status === 404) return new AzureSyncError('NOT_FOUND', `Azure ${operation} could not find the requested object.`, { cause });
  if (isPreconditionFailed(error)) return new AzureSyncError('PRECONDITION', `Azure ${operation} lost a concurrent-update race. Re-read the manifest and retry.`, { cause });
  if (isAlreadyExists(error)) return new AzureSyncError('CONFLICT', `Azure ${operation} found an existing immutable object.`, { cause });
  if (status === 409) return new AzureSyncError('CONFLICT', `Azure ${operation} conflicted with another writer.`, { cause });
  if (status === 429) return new AzureSyncError('THROTTLED', `Azure ${operation} was throttled. Retry with backoff.`, { cause });
  if (status !== undefined && status >= 500) return new AzureSyncError('TRANSIENT', `Azure ${operation} is temporarily unavailable. Retry with backoff.`, { cause });
  return new AzureSyncError('AZURE_OPERATION_FAILED', `Azure ${operation} failed.`, { cause });
}
