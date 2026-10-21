/** Versioned, browser-safe Git observations. Advisory data is never Git or writer authority. */
import { boundedJson, type JsonValue } from '../protocol.js';
import { parseGitFacts, sanitizeGitRemote, type GitFacts } from './sanitize.js';

export const GIT_CONTEXT_MAX_BYTES = 16_384;
export type GitObjectFormat = 'sha1' | 'sha256';
export interface GitRemoteDescriptor { readonly name: string; readonly sanitizedUrl: string }
export interface GitRemoteRef { readonly ref: string; readonly remote: GitRemoteDescriptor }
export type GitCreationBase =
  | { readonly kind: 'remote'; readonly ref: string; readonly remote: GitRemoteDescriptor; readonly oid: string }
  | { readonly kind: 'local'; readonly ref: string; readonly upstreamAtCreation?: GitRemoteRef; readonly oid: string }
  | { readonly kind: 'detached'; readonly oid: string };
export type GitUpstream =
  | { readonly kind: 'remote'; readonly ref: string; readonly remote: GitRemoteDescriptor }
  | { readonly kind: 'local'; readonly ref: string };
export interface GitContext {
  readonly v: 2;
  readonly observation: {
    readonly deviceId: string; readonly observedAt: number; readonly generation: number;
    readonly headerHash: string; readonly eventCount: number; readonly chainHash: string;
  };
  readonly repository: {
    readonly objectFormat: GitObjectFormat; readonly root: string; readonly worktree: boolean;
    readonly configuredRemote?: GitRemoteDescriptor;
  };
  readonly creationBase?: GitCreationBase;
  readonly current: {
    readonly branchRef?: string; readonly headOid?: string; readonly detached: boolean; readonly unborn: boolean;
    readonly dirty: 'clean' | 'dirty' | 'unknown'; readonly upstream?: GitUpstream;
  };
}
export type StoredGitContext = GitFacts | GitContext;
export interface GitSelectionFacts {
  readonly schemaVersion: 1 | 2; readonly repositoryIdentity: string; readonly objectFormat: GitObjectFormat;
  readonly headOid?: string; readonly resolvedRef?: string; readonly selectedOid: string;
}

type RecordValue = { [key: string]: JsonValue };
const encoder = new TextEncoder();
const invalid = (): never => { throw new Error('Invalid Git context.'); };
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const oid = (value: unknown, format: GitObjectFormat): value is string => typeof value === 'string' && (format === 'sha1' ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u).test(value);
function record(value: JsonValue | undefined): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value;
}
function keys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function snapshot(value: unknown): JsonValue {
  const result = boundedJson(value);
  if (encoder.encode(JSON.stringify(result)).byteLength > GIT_CONTEXT_MAX_BYTES) invalid();
  return result;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A conservative full branch-ref grammar; Host provisioning still uses Git's own validation. */
export function isGitBranchRef(value: unknown): value is string {
  if (!text(value, 1024) || !value.startsWith('refs/heads/')) return false;
  const name = value.slice('refs/heads/'.length);
  if (!name || name.startsWith('-') || value.includes('..') || value.includes('@{') || /[\s~^:?*\[\\]/u.test(value)) return false;
  return value.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}
function remote(value: JsonValue | undefined): GitRemoteDescriptor {
  const input = record(value); keys(input, ['name', 'sanitizedUrl']);
  if (!text(input.name, 256) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(input.name) || !text(input.sanitizedUrl) || sanitizeGitRemote(input.sanitizedUrl) !== input.sanitizedUrl) invalid();
  return { name: input.name as string, sanitizedUrl: input.sanitizedUrl as string };
}
function remoteRef(value: JsonValue | undefined): GitRemoteRef {
  const input = record(value); keys(input, ['ref', 'remote']);
  if (!isGitBranchRef(input.ref)) invalid();
  return { ref: input.ref as string, remote: remote(input.remote) };
}
function base(value: JsonValue, format: GitObjectFormat): GitCreationBase {
  const input = record(value);
  if (!oid(input.oid, format)) invalid();
  if (input.kind === 'remote') {
    keys(input, ['kind', 'ref', 'remote', 'oid']);
    if (!isGitBranchRef(input.ref)) invalid();
    return { kind: 'remote', ref: input.ref as string, remote: remote(input.remote), oid: input.oid as string };
  }
  if (input.kind === 'local') {
    keys(input, ['kind', 'ref', 'oid'], ['upstreamAtCreation']);
    if (!isGitBranchRef(input.ref)) invalid();
    return { kind: 'local', ref: input.ref as string, oid: input.oid as string,
      ...(input.upstreamAtCreation === undefined ? {} : { upstreamAtCreation: remoteRef(input.upstreamAtCreation) }) };
  }
  if (input.kind !== 'detached') return invalid();
  keys(input, ['kind', 'oid']);
  return { kind: 'detached', oid: input.oid as string };
}
function upstream(value: JsonValue): GitUpstream {
  const input = record(value);
  if (!isGitBranchRef(input.ref)) invalid();
  if (input.kind === 'remote') {
    keys(input, ['kind', 'ref', 'remote']);
    return { kind: 'remote', ref: input.ref as string, remote: remote(input.remote) };
  }
  if (input.kind !== 'local') return invalid();
  keys(input, ['kind', 'ref']);
  return { kind: 'local', ref: input.ref as string };
}

/** Detach and deeply freeze valid v2 data; reject getters, extra keys, secrets and inconsistent flags. */
export function parseGitContext(value: unknown): GitContext | undefined {
  try {
    const input = record(snapshot(value)); keys(input, ['v', 'observation', 'repository', 'current'], ['creationBase']);
    if (input.v !== 2) return undefined;
    const observation = record(input.observation);
    keys(observation, ['deviceId', 'observedAt', 'generation', 'headerHash', 'eventCount', 'chainHash']);
    if (!text(observation.deviceId, 256) || !integer(observation.observedAt) || !integer(observation.generation) || observation.generation < 1 || !integer(observation.eventCount) || !hash(observation.headerHash) || !hash(observation.chainHash)) return undefined;
    const repository = record(input.repository); keys(repository, ['objectFormat', 'root', 'worktree'], ['configuredRemote']);
    if ((repository.objectFormat !== 'sha1' && repository.objectFormat !== 'sha256') || !text(repository.root) || typeof repository.worktree !== 'boolean') return undefined;
    const format = repository.objectFormat;
    const current = record(input.current); keys(current, ['detached', 'unborn', 'dirty'], ['branchRef', 'headOid', 'upstream']);
    if (typeof current.detached !== 'boolean' || typeof current.unborn !== 'boolean' || !['clean', 'dirty', 'unknown'].includes(current.dirty as string)) return undefined;
    if (current.branchRef !== undefined && !isGitBranchRef(current.branchRef) || current.headOid !== undefined && !oid(current.headOid, format)) return undefined;
    if (current.detached ? current.unborn || current.branchRef !== undefined || current.headOid === undefined : current.branchRef === undefined) return undefined;
    if (current.unborn ? current.headOid !== undefined : current.headOid === undefined) return undefined;
    if (current.detached && current.upstream !== undefined) return undefined;
    const parsed: GitContext = {
      v: 2,
      observation: { deviceId: observation.deviceId as string, observedAt: observation.observedAt, generation: observation.generation, headerHash: observation.headerHash, eventCount: observation.eventCount, chainHash: observation.chainHash },
      repository: { objectFormat: format, root: repository.root, worktree: repository.worktree,
        ...(repository.configuredRemote === undefined ? {} : { configuredRemote: remote(repository.configuredRemote) }) },
      ...(input.creationBase === undefined ? {} : { creationBase: base(input.creationBase, format) }),
      current: { detached: current.detached, unborn: current.unborn, dirty: current.dirty as GitContext['current']['dirty'],
        ...(current.branchRef === undefined ? {} : { branchRef: current.branchRef as string }),
        ...(current.headOid === undefined ? {} : { headOid: current.headOid as string }),
        ...(current.upstream === undefined ? {} : { upstream: upstream(current.upstream) }) },
    };
    return freeze(parsed);
  } catch { return undefined; }
}

/** Storage decoding only. Legacy catalog responses must continue using decodeGitJson, not this union. */
export function decodeGitContextJson(value: string | undefined): StoredGitContext | undefined {
  if (value === undefined || value.length > GIT_CONTEXT_MAX_BYTES) return undefined;
  try { const input: unknown = JSON.parse(value); return parseGitContext(input) ?? parseGitFacts(snapshot(input)); }
  catch { return undefined; }
}
export function encodeGitContext(value: GitContext): string {
  const parsed = parseGitContext(value);
  if (parsed === undefined) return invalid();
  return JSON.stringify(parsed);
}

/** Stable selection identity excludes observation time/history anchors and unselected display hints. */
export function gitSelectionKey(value: GitSelectionFacts): string {
  const input = record(snapshot(value)); keys(input, ['schemaVersion', 'repositoryIdentity', 'objectFormat', 'selectedOid'], ['headOid', 'resolvedRef']);
  if ((input.schemaVersion !== 1 && input.schemaVersion !== 2) || !text(input.repositoryIdentity, 8192) || (input.objectFormat !== 'sha1' && input.objectFormat !== 'sha256')) return invalid();
  const format = input.objectFormat;
  if (!oid(input.selectedOid, format) || input.headOid !== undefined && !oid(input.headOid, format) || input.resolvedRef !== undefined && !isGitBranchRef(input.resolvedRef)) return invalid();
  return JSON.stringify([input.schemaVersion, input.repositoryIdentity, format, input.headOid ?? null, input.resolvedRef ?? null, input.selectedOid]);
}

export interface GitLocationHint { readonly purpose: 'current' | 'creation'; readonly oid: string; readonly ref: string; readonly remote: GitRemoteDescriptor }
/** Locations are not publication proofs; a local source branch must not masquerade as its upstream. */
export function gitLocationHints(context: GitContext): readonly GitLocationHint[] {
  const parsed = parseGitContext(context);
  if (parsed === undefined) return Object.freeze([]);
  const hints: GitLocationHint[] = [];
  if (parsed.current.headOid !== undefined && parsed.current.upstream?.kind === 'remote') hints.push({ purpose: 'current', oid: parsed.current.headOid, ref: parsed.current.upstream.ref, remote: parsed.current.upstream.remote });
  const creation = parsed.creationBase;
  if (creation?.kind === 'remote') hints.push({ purpose: 'creation', oid: creation.oid, ref: creation.ref, remote: creation.remote });
  else if (creation?.kind === 'local' && creation.upstreamAtCreation !== undefined) hints.push({ purpose: 'creation', oid: creation.oid, ...creation.upstreamAtCreation });
  return freeze(hints);
}
