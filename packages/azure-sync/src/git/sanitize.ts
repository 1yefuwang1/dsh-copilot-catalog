/** Browser-safe, advisory Git metadata. Never execution or writer authority. */
export interface GitFacts {
  readonly v: 1;
  readonly root: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly detached: boolean;
  readonly unborn: boolean;
  readonly worktree: boolean;
  /** Raw-content comparison; ignored/untracked files may conservatively mark dirty. */
  readonly dirty: 'clean' | 'dirty' | 'unknown';
  readonly remote?: string;
}
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

/** Drop ALL userinfo, query and fragment; reject local paths, helpers and opaque protocols. */
export function sanitizeGitRemote(input: unknown): string | undefined {
  // Git/libcurl can treat a raw backslash as userinfo while WHATWG URL
  // normalizes it into an authority/path separator. Reject BEFORE parsing so
  // credentials cannot be reclassified as a hostname/path and then published.
  if (!text(input, 4096) || input.includes('\\')) return undefined;
  let candidate = input;
  if (!candidate.includes('://')) {
    if (/^(?:file|ext|javascript|data|mailto|https?|ssh|git|ftp):/iu.test(candidate)) return undefined;
    // Validate the entire pre-query SCP spelling BEFORE dropping any suffix.
    // A colon before @ must not become a host plus a credential-bearing path.
    const core = candidate.split(/[?#]/u, 1)[0]!;
    // SCP has no URL query authority: an @ hidden in a suffix is ambiguous too.
    if (candidate.slice(core.length).includes('@')) return undefined;
    const scp = /^(?:[^@/:?#\s]+@)?([A-Za-z0-9][A-Za-z0-9.-]*):([^@:\s?#]+)$/u.exec(core);
    if (!scp || scp[1]!.length === 1 || !scp[2] || scp[2]!.startsWith(':')) return undefined;
    candidate = `ssh://${scp[1]}/${scp[2]!.replace(/^\//u, '')}`;
  }
  try {
    const url = new URL(candidate);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || url.hostname.includes('%') || url.pathname.includes('\\')) return undefined;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    const result = url.href;
    return text(result, 4096) ? result : undefined;
  } catch { return undefined; }
}

/** Strict detached allowlist. Invalid/untrusted cloud JSON is omitted, never echoed. */
export function parseGitFacts(input: unknown): GitFacts | undefined {
  if (input === null || typeof input !== 'object' || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return undefined;
  const keys = Reflect.ownKeys(input), allowed = ['v', 'root', 'branch', 'commit', 'detached', 'unborn', 'worktree', 'dirty', 'remote'];
  const value: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return undefined;
    value[key] = descriptor.value;
  }
  if (value.v !== 1 || !text(value.root, 4096) || typeof value.detached !== 'boolean' || typeof value.unborn !== 'boolean' || typeof value.worktree !== 'boolean' || !['clean', 'dirty', 'unknown'].includes(value.dirty as string)) return undefined;
  if (value.branch !== undefined && !text(value.branch, 256)) return undefined;
  if (value.commit !== undefined && (typeof value.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.commit))) return undefined;
  if (value.remote !== undefined && (typeof value.remote !== 'string' || sanitizeGitRemote(value.remote) !== value.remote)) return undefined;
  if (value.detached && value.branch !== undefined || value.unborn && value.commit !== undefined) return undefined;
  return Object.freeze({ v: 1, root: value.root, detached: value.detached, unborn: value.unborn, worktree: value.worktree, dirty: value.dirty as GitFacts['dirty'],
    ...(value.branch === undefined ? {} : { branch: value.branch as string }), ...(value.commit === undefined ? {} : { commit: value.commit as string }), ...(value.remote === undefined ? {} : { remote: value.remote as string }) });
}
export function decodeGitJson(value: string | undefined): GitFacts | undefined {
  if (value === undefined || value.length > 16_384) return undefined;
  try { return parseGitFacts(JSON.parse(value)); } catch { return undefined; }
}
