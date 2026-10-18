/**
 * Effective working-directory mapping. Remote path spellings are normalized as
 * strings before any local filesystem call; the mapped local result is then
 * realpath-validated inside its root. Historical provenance is forward-only.
 * @module @1yefuwang1/dsh-azure-sync/sync/effective-cwd
 */
import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { AzureSyncError } from '../azure/errors.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { PathMappingRecord, Platform } from '../schema.js';

export interface CwdFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export const nodeCwdFs: CwdFs = {
  realpath: (path) => fsRealpath(path),
  stat: async (path) => {
    const value = await fsStat(path);
    return { isDirectory: () => value.isDirectory() };
  },
};

export type CwdIssueCode = 'NEEDS_FOLDER' | 'UNMAPPABLE_CWD' | 'MAPPING_UNSTABLE' | 'AMBIGUOUS_MAPPING';

export interface CwdIssue {
  readonly code: CwdIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface ImportedCwdValidation {
  readonly ok: boolean;
  readonly localPaths: readonly string[];
  readonly issues: readonly CwdIssue[];
}

function issue(code: CwdIssueCode, path: string, message: string): CwdIssue {
  return { code, path, message };
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

export interface PathApi {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  readonly sep: string;
}

const hostPathApi: PathApi = { relative, isAbsolute, sep };

/** Containment check that rejects absolute cross-drive/UNC relatives as well as `..`. */
export function isInside(root: string, candidate: string, pathApi: PathApi = hostPathApi): boolean {
  if (candidate === root) return true;
  const local = pathApi.relative(root, candidate);
  return local.length > 0 && !pathApi.isAbsolute(local) && !local.startsWith(`..${pathApi.sep}`) && local !== '..' && !local.startsWith(pathApi.sep);
}

function matchesRemotePrefix(remote: string, prefix: string, platform: Platform): boolean {
  const left = platform === 'win32' ? remote.toLowerCase() : remote;
  const right = platform === 'win32' ? prefix.toLowerCase() : prefix;
  if (right === '/') return left.startsWith('/');
  if (/^[a-z]:\/$/u.test(right)) return left === right || left.startsWith(right);
  return left === right || left.startsWith(`${right}/`);
}

/** Normalize a remote spelling without touching the local filesystem. */
export function normalizeRemotePath(value: string, platform: Platform): string {
  if (value.length === 0) throw new AzureSyncError('UNMAPPABLE_CWD', 'A remote path must not be empty.');
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new AzureSyncError('UNMAPPABLE_CWD', 'A remote path contains control characters.');
  let path = value.replace(/\\/gu, '/');
  const unc = path.startsWith('//');
  path = unc ? `//${path.slice(2).replace(/\/+/gu, '/')}` : path.replace(/\/+/gu, '/');
  if (path !== '/' && !/^[A-Za-z]:\/$/u.test(path)) path = path.replace(/\/+$/u, '');
  if (path.length === 0) path = '/';

  const drive = platform === 'win32' ? /^([A-Za-z]):\//u.exec(path) : null;
  if (platform === 'win32' && drive === null && !path.startsWith('//')) {
    throw new AzureSyncError('UNMAPPABLE_CWD', 'A Windows remote path must be drive-absolute or UNC.');
  }
  if (platform !== 'win32' && !path.startsWith('/')) {
    throw new AzureSyncError('UNMAPPABLE_CWD', 'A POSIX remote path must be absolute.');
  }
  if (drive !== null) path = `${(drive[1] as string).toUpperCase()}:${path.slice(2)}`;

  const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : '';
  let body = path.slice(prefix.length);
  if (drive !== null) body = body.replace(/^[A-Za-z]:/u, '');
  const segments = body.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) throw new AzureSyncError('UNMAPPABLE_CWD', 'A remote path must not contain "..".');
  if (segments.some((segment) => segment.includes(':'))) throw new AzureSyncError('UNMAPPABLE_CWD', 'A remote path must not contain colon-separated segments.');
  const rebuilt = segments.join('/');
  if (drive !== null) {
    const letter = (drive[1] as string).toUpperCase();
    return rebuilt.length === 0 ? `${letter}:/` : `${letter}:/${rebuilt}`;
  }
  if (prefix === '//') return rebuilt.length === 0 ? '//' : `//${rebuilt}`;
  return rebuilt.length === 0 ? '/' : `/${rebuilt}`;
}

export function mappingRevision(remotePrefix: string, localPrefix: string): string {
  return sha256Hex('mapping\0', remotePrefix, '\0', localPrefix);
}

export interface CwdBinding {
  readonly mapping: PathMappingRecord;
  readonly fs: CwdFs;
}

/** Map a canonical remote path to an existing local directory inside the binding root. */
export async function remoteToLocal(binding: CwdBinding, remotePath: string): Promise<string> {
  const mapping = binding.mapping;
  const remote = normalizeRemotePath(remotePath, mapping.remotePlatform);
  const prefix = normalizeRemotePath(mapping.remotePrefix, mapping.remotePlatform);
  if (!matchesRemotePrefix(remote, prefix, mapping.remotePlatform)) throw new AzureSyncError('UNMAPPABLE_CWD', 'The remote path is outside the configured mapping.');
  const remainder = remote === prefix ? '' : remote.slice(prefix.length).replace(/^\/+/u, '');
  const local = remainder.length === 0 ? mapping.localPrefix : join(mapping.localPrefix, ...remainder.split('/'));
  let canonical: string;
  try {
    canonical = await binding.fs.realpath(local);
  } catch (error) {
    if (isMissing(error)) throw new AzureSyncError('NEEDS_FOLDER', 'The mapped local directory does not exist.');
    throw new AzureSyncError('UNMAPPABLE_CWD', 'The mapped local path could not be resolved.', { cause: { name: 'Error' } });
  }
  const root = mapping.localPrefix;
  if (!isAbsolute(root)) throw new AzureSyncError('MAPPING_UNSTABLE', 'The mapping local root must be absolute.');
  if (!isInside(root, canonical)) throw new AzureSyncError('UNMAPPABLE_CWD', 'The mapped local path escapes its configured root.');
  const info = await binding.fs.stat(canonical);
  if (!info.isDirectory()) throw new AzureSyncError('NEEDS_FOLDER', 'The mapped local path is not a directory.');
  return canonical;
}

/** Reverse-map a new local cwd; only used for newly created local events. */
export async function localToRemote(binding: CwdBinding, localPath: string): Promise<string> {
  const mapping = binding.mapping;
  if (!isAbsolute(localPath)) throw new AzureSyncError('UNMAPPABLE_CWD', 'The local working directory must be absolute.');
  let canonical: string;
  try {
    canonical = await binding.fs.realpath(localPath);
  } catch (error) {
    if (isMissing(error)) throw new AzureSyncError('NEEDS_FOLDER', 'The local working directory does not exist.');
    throw new AzureSyncError('UNMAPPABLE_CWD', 'The local working directory could not be resolved.', { cause: { name: 'Error' } });
  }
  const root = mapping.localPrefix;
  if (!isAbsolute(root)) throw new AzureSyncError('MAPPING_UNSTABLE', 'The mapping local root must be absolute.');
  if (!isInside(root, canonical)) throw new AzureSyncError('UNMAPPABLE_CWD', 'The local working directory is outside the configured mapping.');
  const remainder = relative(root, canonical).split(sep).filter(Boolean).join('/');
  const remote = normalizeRemotePath(remainder.length === 0 ? mapping.remotePrefix : `${mapping.remotePrefix}/${remainder}`, mapping.remotePlatform);
  const roundTrip = await remoteToLocal(binding, remote);
  if (roundTrip !== canonical) throw new AzureSyncError('MAPPING_UNSTABLE', 'The local path does not round-trip through the configured mapping.');
  return remote;
}

/** Validate and canonicalize a mapping root. */
export async function normalizeMapping(mapping: PathMappingRecord, fs: CwdFs = nodeCwdFs): Promise<PathMappingRecord> {
  if (!isAbsolute(mapping.localPrefix)) throw new AzureSyncError('NEEDS_FOLDER', 'The mapping local root must be an absolute path.');
  const remotePrefix = normalizeRemotePath(mapping.remotePrefix, mapping.remotePlatform);
  let localPrefix: string;
  try {
    localPrefix = await fs.realpath(mapping.localPrefix);
  } catch {
    throw new AzureSyncError('NEEDS_FOLDER', 'The mapping local root does not exist.');
  }
  const info = await fs.stat(localPrefix);
  if (!info.isDirectory()) throw new AzureSyncError('NEEDS_FOLDER', 'The mapping local root is not a directory.');
  return Object.freeze({ ...mapping, remotePrefix, localPrefix, revision: mappingRevision(remotePrefix, localPrefix) });
}

/** Select the longest matching mapping for a remote path and platform. */
export function selectMapping(mappings: readonly PathMappingRecord[], remotePath: string, platform: Platform): PathMappingRecord | undefined {
  const path = normalizeRemotePath(remotePath, platform);
  const matches = mappings.filter((mapping) => {
    if (mapping.remotePlatform !== platform) return false;
    const prefix = normalizeRemotePath(mapping.remotePrefix, platform);
    return matchesRemotePrefix(path, prefix, platform);
  });
  if (matches.length === 0) return undefined;
  matches.sort((left, right) => normalizeRemotePath(right.remotePrefix, platform).length - normalizeRemotePath(left.remotePrefix, platform).length);
  const first = matches[0] as PathMappingRecord;
  const second = matches[1];
  if (second !== undefined) {
    const firstPrefix = normalizeRemotePath(first.remotePrefix, platform);
    const secondPrefix = normalizeRemotePath(second.remotePrefix, platform);
    const firstKey = platform === 'win32' ? firstPrefix.toLowerCase() : firstPrefix;
    const secondKey = platform === 'win32' ? secondPrefix.toLowerCase() : secondPrefix;
    if (firstPrefix.length === secondPrefix.length && (firstKey !== secondKey || first.id !== second.id)) {
      throw new AzureSyncError('AMBIGUOUS_MAPPING', 'Two mappings match the remote path at the same prefix length.');
    }
  }
  return first;
}

/** Localize every historical working-directory change; any failure blocks import. */
export async function validateImportedCwds(binding: CwdBinding, paths: readonly string[]): Promise<ImportedCwdValidation> {
  const localPaths: string[] = [];
  const issues: CwdIssue[] = [];
  for (const path of paths) {
    try {
      localPaths.push(await remoteToLocal(binding, path));
    } catch (error) {
      if (error instanceof AzureSyncError) {
        const code = error.code;
        const mapped: CwdIssueCode = code === 'NEEDS_FOLDER' ? 'NEEDS_FOLDER'
          : code === 'MAPPING_UNSTABLE' ? 'MAPPING_UNSTABLE'
            : code === 'AMBIGUOUS_MAPPING' ? 'AMBIGUOUS_MAPPING' : 'UNMAPPABLE_CWD';
        issues.push(issue(mapped, path, error.message));
      } else {
        issues.push(issue('UNMAPPABLE_CWD', path, 'The working directory could not be mapped.'));
      }
    }
  }
  return { ok: issues.length === 0, localPaths, issues };
}

interface CwdEvent { readonly type: string; readonly data?: Record<string, unknown>; readonly [key: string]: unknown }

export interface ProvenanceComparison {
  readonly eventCount: number;
  readonly currentLocalCwd?: string;
}

export interface ProvenanceOptions {
  readonly headerCwd?: string;
  readonly localCurrentCwd?: string;
}

function lastLocalCwd(events: readonly CwdEvent[]): string | undefined {
  let cwd: string | undefined;
  for (const event of events) {
    if (event.type !== 'working-directory/change') continue;
    const value = event.data?.['cwd'];
    if (typeof value === 'string') cwd = value;
  }
  return cwd;
}

/**
 * Forward-only provenance check: localize the verified canonical range and
 * compare every event (all fields, seq, and count) with the freshly read local
 * range. Historical local cwd values are never reverse-mapped.
 */
export async function verifyImportedProvenance(
  binding: CwdBinding,
  canonicalEvents: readonly CwdEvent[],
  localEvents: readonly CwdEvent[],
  options: ProvenanceOptions = {},
): Promise<ProvenanceComparison> {
  const localized = await localizeImportedEvents(canonicalEvents, binding);
  if (localEvents.length !== localized.events.length) {
    throw new AzureSyncError('PROVENANCE_MISMATCH', 'The local event count does not match the verified canonical range.');
  }
  for (let index = 0; index < localized.events.length; index += 1) {
    const expected = localized.events[index] as CwdEvent;
    const actual = localEvents[index] as CwdEvent;
    if (expected.type !== actual.type) {
      throw new AzureSyncError('PROVENANCE_MISMATCH', `The local event type at index ${index} does not match the verified canonical range.`);
    }
    if (expected.seq !== undefined && actual.seq !== expected.seq) {
      throw new AzureSyncError('PROVENANCE_MISMATCH', `The local event seq at index ${index} does not match the verified canonical range.`);
    }
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      throw new AzureSyncError('PROVENANCE_MISMATCH', `The local event at index ${index} does not match the forwarded canonical event.`);
    }
  }
  const expectedCurrent = localized.currentCwd ?? (options.headerCwd === undefined ? undefined : await remoteToLocal(binding, options.headerCwd));
  const actualCurrent = options.localCurrentCwd ?? lastLocalCwd(localEvents);
  if (expectedCurrent !== actualCurrent) {
    throw new AzureSyncError('PROVENANCE_MISMATCH', 'The local current working directory does not match the forwarded canonical range.');
  }
  return { eventCount: localized.events.length, ...(expectedCurrent === undefined ? {} : { currentLocalCwd: expectedCurrent }) };
}

export interface LocalizedEventStream<T extends CwdEvent> {
  readonly events: readonly T[];
  readonly currentCwd?: string;
  readonly localPaths: readonly string[];
}

/** Localize a whole imported stream and expose the final current cwd for range checks. */
export async function localizeImportedEvents<T extends CwdEvent>(events: readonly T[], binding: CwdBinding): Promise<LocalizedEventStream<T>> {
  const localized: T[] = [];
  const localPaths: string[] = [];
  let currentCwd: string | undefined;
  for (const event of events) {
    const mapped = await localizeEvent(event, binding);
    localized.push(mapped);
    if (mapped.type === 'working-directory/change') {
      const cwd = mapped.data?.['cwd'];
      if (typeof cwd === 'string') {
        localPaths.push(cwd);
        currentCwd = cwd;
      }
    }
  }
  return { events: localized, currentCwd, localPaths };
}

/** Canonicalize a newly local stream; every local cwd must round-trip to the remote binding. */
export async function canonicalizeLocalEvents<T extends CwdEvent>(events: readonly T[], binding: CwdBinding): Promise<readonly T[]> {
  const canonical: T[] = [];
  for (const event of events) canonical.push(await canonicalizeEvent(event, binding));
  return canonical;
}

/** Localize one imported working-directory/change event (all other events are unchanged). */
export async function localizeEvent<T extends CwdEvent>(event: T, binding: CwdBinding): Promise<T> {
  if (event.type !== 'working-directory/change') return event;
  const cwd = event.data?.['cwd'];
  if (typeof cwd !== 'string') throw new AzureSyncError('INVALID_RECORD', 'A working-directory/change event has no cwd.');
  const localized = await remoteToLocal(binding, cwd);
  return { ...event, data: { ...event.data, cwd: localized } };
}

/** Canonicalize one newly local working-directory/change event for upload. */
export async function canonicalizeEvent<T extends CwdEvent>(event: T, binding: CwdBinding): Promise<T> {
  if (event.type !== 'working-directory/change') return event;
  const cwd = event.data?.['cwd'];
  if (typeof cwd !== 'string') throw new AzureSyncError('INVALID_RECORD', 'A working-directory/change event has no cwd.');
  const canonical = await localToRemote(binding, cwd);
  return { ...event, data: { ...event.data, cwd: canonical } };
}
