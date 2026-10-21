/** Separate versioned import channel. Legacy pull/catalog DTOs are deliberately unchanged. */
import { boundedJson, CloudControlError, type CloudPlatform, type JsonValue } from '../protocol.js';
import { isGitBranchRef, type GitContext } from '../git/context.js';
import type { GitFacts } from '../git/sanitize.js';

export const CLOUD_IMPORT_ENDPOINT = 'azure-sync/import';
export const CLOUD_IMPORT_PROTOCOL_VERSION = 2;
export type ImportBase =
  | { readonly kind: 'local-branch'; readonly name: string; readonly oid: string }
  | { readonly kind: 'head' | 'commit'; readonly oid: string };
export type ImportDestination =
  | { readonly kind: 'local'; readonly folderPath: string; readonly projectId?: string; readonly folderId?: string }
  | { readonly kind: 'worktree'; readonly projectId: string; readonly folderId: string; readonly base: ImportBase; readonly permissionActorId: string; readonly label?: string };
export interface ImportMapping {
  readonly remotePlatform: CloudPlatform;
  readonly remotePrefix: string;
  /** Local only: an explicitly selected ancestor mapping root; default is the chosen folder. */
  readonly localPrefix?: string;
}
export type CloudImportRequest =
  | { readonly action: 'import-capabilities' }
  | { readonly action: 'import-admission'; readonly sessionId: string }
  | { readonly action: 'inspect-import'; readonly sessionId: string; readonly generation: number; readonly gitContextVersion: 2 }
  | { readonly action: 'import-bases'; readonly projectId: string; readonly folderId: string; readonly permissionActorId: string }
  | { readonly action: 'plan-import'; readonly sessionId: string; readonly generation: number; readonly operationId: string; readonly gitContextVersion: 2; readonly destination: ImportDestination; readonly mapping: ImportMapping }
  | { readonly action: 'commit-import' | 'resume-import'; readonly sessionId: string; readonly operationId: string; readonly revision: number; readonly confirm: true; readonly acknowledgeCodeMismatch?: true }
  | { readonly action: 'import-operation' | 'cancel-import'; readonly sessionId: string; readonly operationId: string }
  | { readonly action: 'continue-import'; readonly sessionId: string; readonly operationId: string; readonly revision: number; readonly confirm: true; readonly acknowledgePendingInput?: true };
export type CloudImportPhase = 'reviewed' | 'reserved' | 'preparing' | 'prepared' | 'materializing' | 'importing' | 'attachments' | 'warming' | 'binding' | 'ready' | 'cancelled' | 'recovery-required';
export interface CloudImportFolder {
  readonly path: string; readonly title: string; readonly projectId?: string; readonly folderId?: string;
}
export interface CloudImportSourceView {
  readonly version: 2; readonly kind: 'import-source'; readonly sessionId: string; readonly generation: number;
  readonly cwd: string; readonly platform: CloudPlatform; readonly eventCount: number;
  readonly eligible: boolean; readonly reason?: string; readonly sourceGit?: GitContext | GitFacts;
  readonly gitUsable: boolean; readonly seeded: boolean; readonly operationId?: string;
}
export interface CloudImportBases {
  readonly version: 2; readonly kind: 'import-bases'; readonly projectId: string; readonly folderId: string;
  readonly repoRoot: string; readonly objectFormat: 'sha1' | 'sha256'; readonly head: string;
  readonly branches: readonly { readonly name: string; readonly oid: string }[];
}
export interface CloudImportAdmission {
  readonly version: 2; readonly kind: 'import-admission'; readonly sessionId: string;
  readonly reserved: boolean; readonly ready: boolean; readonly continued: boolean;
  readonly operationId?: string; readonly generation?: number; readonly reason?: string;
}
export interface CloudImportCapabilities {
  readonly version: 2;
  readonly kind: 'import-capabilities';
  readonly local: boolean;
  readonly worktree: boolean;
  readonly seeded: boolean;
  readonly folders: readonly CloudImportFolder[];
  readonly reason?: string;
}
export interface CloudImportView {
  readonly version: 2;
  readonly kind: 'import-operation';
  readonly operationId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
  readonly phase: CloudImportPhase;
  readonly destination: 'local' | 'worktree';
  readonly cwd?: string;
  readonly worktreeId?: string;
  readonly branch?: string;
  readonly baseOid?: string;
  readonly reason?: string;
  readonly continuable: boolean;
  readonly pendingInput: boolean;
}
export interface CloudImportPlanView {
  readonly version: 2;
  readonly kind: 'import-plan';
  readonly operationId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
  readonly expiresAt: number;
  readonly eventCount: number;
  readonly cwd: string;
  readonly destination: 'local' | 'worktree';
  readonly branch?: string;
  readonly baseOid?: string;
  readonly sourceGit?: GitContext | GitFacts;
  readonly warnings: readonly string[];
  readonly codeMismatch: boolean;
}
export type CloudImportResponse = CloudImportCapabilities | CloudImportAdmission | CloudImportSourceView | CloudImportBases | CloudImportView | CloudImportPlanView;
export interface CloudImportControllerPort {
  execute(request: CloudImportRequest, context: { readonly origin: 'command' | 'rpc'; readonly sessionId?: string; readonly signal: AbortSignal }): Promise<CloudImportResponse>;
}

type Obj = { [key: string]: JsonValue };
const invalid = (): never => { throw new CloudControlError('INVALID_REQUEST'); };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const oid = (value: unknown): value is string => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
function record(value: JsonValue | undefined): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value;
}
function keys(value: Obj, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function placement(value: JsonValue | undefined): ImportDestination {
  const input = record(value);
  if (input.kind === 'local') {
    keys(input, ['kind', 'folderPath'], ['projectId', 'folderId']);
    if (!text(input.folderPath) || (input.projectId === undefined) !== (input.folderId === undefined) || input.projectId !== undefined && !uuid(input.projectId) || input.folderId !== undefined && !text(input.folderId, 256)) return invalid();
    return input as unknown as ImportDestination;
  }
  keys(input, ['kind', 'projectId', 'folderId', 'base', 'permissionActorId'], ['label']);
  if (input.kind !== 'worktree' || !uuid(input.projectId) || !text(input.folderId, 256) || !text(input.permissionActorId, 256) || input.label !== undefined && (!text(input.label, 60) || input.label.trim() !== input.label)) return invalid();
  const base = record(input.base);
  if (base.kind === 'local-branch') {
    keys(base, ['kind', 'name', 'oid']);
    // The new contract uses a full local ref; the Host strips its prefix only after Git validates it.
    if (!isGitBranchRef(base.name)) return invalid();
  } else {
    keys(base, ['kind', 'oid']);
    if (base.kind !== 'head' && base.kind !== 'commit') return invalid();
  }
  if (!oid(base.oid)) return invalid();
  return input as unknown as ImportDestination;
}

/** Strict bounded detached requests, with no current-thread fallback for remote/import identities. */
export function parseCloudImportRequest(value: unknown): CloudImportRequest {
  let input: Obj;
  try { input = record(boundedJson(value)); } catch { return invalid(); }
  if (input.action === 'import-capabilities') { keys(input, ['action']); return { action: 'import-capabilities' }; }
  if (input.action === 'import-admission') {
    keys(input, ['action', 'sessionId']);
    if (!text(input.sessionId, 256)) return invalid();
    return { action: 'import-admission', sessionId: input.sessionId };
  }
  if (input.action === 'inspect-import') {
    keys(input, ['action', 'sessionId', 'generation', 'gitContextVersion']);
    if (!text(input.sessionId, 256) || !positive(input.generation) || input.gitContextVersion !== 2) return invalid();
    return { action: 'inspect-import', sessionId: input.sessionId, generation: input.generation, gitContextVersion: 2 };
  }
  if (input.action === 'import-bases') {
    keys(input, ['action', 'projectId', 'folderId', 'permissionActorId']);
    if (!uuid(input.projectId) || !text(input.folderId, 256) || !text(input.permissionActorId, 256)) return invalid();
    return { action: 'import-bases', projectId: input.projectId, folderId: input.folderId, permissionActorId: input.permissionActorId };
  }
  if (input.action === 'plan-import') {
    keys(input, ['action', 'sessionId', 'generation', 'operationId', 'gitContextVersion', 'destination', 'mapping']);
    if (!text(input.sessionId, 256) || !uuid(input.operationId) || !positive(input.generation) || input.gitContextVersion !== 2) return invalid();
    const destination = placement(input.destination), mapping = record(input.mapping);
    keys(mapping, ['remotePlatform', 'remotePrefix'], destination.kind === 'local' ? ['localPrefix'] : []);
    if (!['linux', 'darwin', 'win32'].includes(mapping.remotePlatform as string) || !text(mapping.remotePrefix) || mapping.localPrefix !== undefined && !text(mapping.localPrefix)) return invalid();
    return { action: 'plan-import', sessionId: input.sessionId, generation: input.generation, operationId: input.operationId, gitContextVersion: 2, destination, mapping: mapping as unknown as ImportMapping };
  }
  const confirmed = input.action === 'commit-import' || input.action === 'resume-import' || input.action === 'continue-import';
  if (!confirmed && input.action !== 'import-operation' && input.action !== 'cancel-import') return invalid();
  keys(input, confirmed ? ['action', 'sessionId', 'operationId', 'revision', 'confirm'] : ['action', 'sessionId', 'operationId'], input.action === 'continue-import' ? ['acknowledgePendingInput'] : confirmed ? ['acknowledgeCodeMismatch'] : []);
  if (!text(input.sessionId, 256) || !uuid(input.operationId) || confirmed && (!positive(input.revision) || input.confirm !== true) || input.acknowledgePendingInput !== undefined && input.acknowledgePendingInput !== true || input.acknowledgeCodeMismatch !== undefined && input.acknowledgeCodeMismatch !== true) return invalid();
  return input as unknown as CloudImportRequest;
}
export function parseCloudImportPayload(value: unknown): CloudImportRequest {
  let input: Obj;
  try { input = record(boundedJson(value)); } catch { return invalid(); }
  keys(input, ['v', 'request']);
  if (input.v !== 1) return invalid();
  return parseCloudImportRequest(input.request);
}
