/** Bounded LOCAL-only Git facts. No status/diff-files, filters, network or index writes. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { parseGitFacts, sanitizeGitRemote, type GitFacts } from './sanitize.js';

export interface GitProbeOptions { readonly executable?: string; readonly timeoutMs?: number; readonly defaultRemote?: string }
export const GIT_PROBE_LIMITS = Object.freeze({ outputBytes: 262_144, files: 5_000, entries: 10_000, depth: 32, fileBytes: 1_048_576, totalBytes: 8_388_608 });
const safeText = (value: string) => value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
const inside = (root: string, path: string) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const NUL = process.platform === 'win32' ? 'NUL' : '/dev/null';

export function gitProbeEnvironment(): NodeJS.ProcessEnv {
  // An allowlist, NOT a spread: GIT_DIR/WORK_TREE/INDEX_FILE/CONFIG_COUNT,
  // alternates, injected config, helpers, trace outputs and prompts never inherit.
  return { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: NUL, GIT_CONFIG_GLOBAL: NUL, GIT_CONFIG_COUNT: '0',
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C', LANG: 'C', PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin' };
}
export const GIT_READ_ONLY_ARGS = Object.freeze(['--no-optional-locks', '--no-pager', '--literal-pathspecs',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.preloadIndex=false',
  '-c', `core.hooksPath=${NUL}`, '-c', 'diff.external=', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
  '-c', 'fetch.writeCommitGraph=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never']);

async function trustedGit(configured: string): Promise<string | undefined> {
  const candidates = configured === 'git'
    ? process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe')]
      : ['/usr/bin/git', '/usr/local/bin/git', '/bin/git', '/opt/homebrew/bin/git']
    : isAbsolute(configured) && safeText(configured) ? [configured] : [];
  for (const candidate of candidates) {
    try { const path = await realpath(candidate); if ((await stat(path)).isFile()) return path; } catch { /* no PATH fallback */ }
  }
  return undefined;
}
interface Result { code: number | null; text: string }
class Budget {
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(ms: number, signal?: AbortSignal) {
    this.timer = setTimeout(() => this.controller.abort(), ms);
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
  }
  readonly signal: AbortSignal;
  check(): void { this.signal.throwIfAborted(); }
  async wait<T>(promise: Promise<T>): Promise<T> {
    // Observe even an IO promise created just before a simultaneous cancellation.
    void promise.catch(() => undefined);
    this.check(); let stop: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => { stop = () => reject(new Error('Git inspection cancelled.')); this.signal.addEventListener('abort', stop, { once: true }); if (this.signal.aborted) stop(); });
    try { const result = await Promise.race([promise, cancelled]); this.check(); return result; }
    finally { this.signal.removeEventListener('abort', stop); }
  }
  close(): void { clearTimeout(this.timer); this.controller.abort(); }
}
function execute(binary: string, cwd: string, args: readonly string[], budget: Budget): Promise<Result> {
  budget.check();
  return new Promise((done) => {
    let bytes = 0, overflow = false; const chunks: Buffer[] = [];
    const child = spawn(binary, [...GIT_READ_ONLY_ARGS, ...args], { cwd, env: gitProbeEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: budget.signal, killSignal: 'SIGKILL' });
    const consume = (data: Buffer, output: boolean) => {
      bytes += data.byteLength;
      if (bytes > GIT_PROBE_LIMITS.outputBytes) { overflow = true; child.kill('SIGKILL'); return; }
      if (output) chunks.push(data);
    };
    child.stdout.on('data', (data: Buffer) => consume(data, true)); child.stderr.on('data', (data: Buffer) => consume(data, false));
    child.on('error', () => done({ code: null, text: '' }));
    child.on('close', code => {
      try { done({ code: overflow ? null : code, text: overflow ? '' : new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }); }
      catch { done({ code: null, text: '' }); }
    });
  });
}
interface Entry { mode: string; hash: string }
function entries(text: string, tree: boolean): Map<string, Entry> | undefined {
  if (text && !text.endsWith('\0')) return undefined;
  const map = new Map<string, Entry>();
  for (const row of text.split('\0').filter(Boolean)) {
    const match = (tree ? /^(\d{6}) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u : /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t(.+)$/u).exec(row);
    if (!match || !safeText(match[3]!) || match[3]!.split('/').some(part => part === '..' || part === '.' || part === '.git' || part === '') || isAbsolute(match[3]!) || map.has(match[3]!)) return undefined;
    map.set(match[3]!, { mode: match[1]!, hash: match[2]! }); if (map.size > GIT_PROBE_LIMITS.files) return undefined;
  }
  return map;
}
async function contentState(root: string, index: Map<string, Entry>, algorithm: string, budget: Budget): Promise<GitFacts['dirty']> {
  let count = 0, total = 0, unknown = false, dirty = false;
  const seen = new Set<string>();
  async function visit(directory: string, prefix = '', depth = 0): Promise<void> {
    budget.check(); if (depth > GIT_PROBE_LIMITS.depth) throw new Error('Git inspection limit.');
    if (!inside(root, await budget.wait(realpath(directory)))) throw new Error('Unsafe Git inspection path.');
    const opening = opendir(directory, { bufferSize: 32 }); let directoryHandle;
    try { directoryHandle = await budget.wait(opening); }
    catch (error) { void opening.then(value => value.close().catch(() => undefined), () => undefined); throw error; }
    try { for (;;) {
      const entry = await budget.wait(directoryHandle.read()); if (entry === null) break;
      budget.check(); if (++count > GIT_PROBE_LIMITS.entries) throw new Error('Git inspection limit.');
      if (entry.name === '.git') continue;
      const name = prefix + entry.name, path = join(directory, entry.name);
      if (!safeText(name)) { unknown = true; continue; }
      if (entry.name === '.gitattributes') unknown = true;
      if (entry.isDirectory()) { if (index.get(name)?.mode === '160000') { unknown = true; seen.add(name); } else await visit(path, `${name}/`, depth + 1); continue; }
      const tracked = index.get(name);
      if (!tracked) { dirty = true; continue; } // May be ignored: deliberately conservative.
      seen.add(name);
      let bytes: Buffer;
      if (tracked.mode === '120000' && entry.isSymbolicLink()) bytes = Buffer.from(await budget.wait(readlink(path)));
      else if (tracked.mode === '100644' || tracked.mode === '100755') {
        if (!entry.isFile() || entry.isSymbolicLink()) { dirty = true; continue; }
        const canonical = await budget.wait(realpath(path)); if (!inside(root, canonical)) throw new Error('Unsafe Git inspection path.');
        const opening = open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let handle;
        try { handle = await budget.wait(opening); }
        catch (error) { void opening.then(value => value.close().catch(() => undefined), () => undefined); throw error; }
        try {
          const before = await budget.wait(handle.stat());
          if (!before.isFile() || before.size > GIT_PROBE_LIMITS.fileBytes || total + before.size > GIT_PROBE_LIMITS.totalBytes) { unknown = true; continue; }
          const buffer = Buffer.alloc(before.size + 1); let used = 0;
          while (used < buffer.byteLength) { const result = await budget.wait(handle.read(buffer, used, buffer.byteLength - used, used)); if (result.bytesRead === 0) break; used += result.bytesRead; }
          bytes = buffer.subarray(0, used); total += bytes.byteLength;
          const after = await budget.wait(handle.stat());
          if (bytes.byteLength > GIT_PROBE_LIMITS.fileBytes || total > GIT_PROBE_LIMITS.totalBytes || before.mtimeMs !== after.mtimeMs || before.size !== after.size) { unknown = true; continue; }
          if (process.platform !== 'win32' && ((before.mode & 0o111) !== 0) !== (tracked.mode === '100755')) dirty = true;
        } finally { await budget.wait(handle.close()).catch(() => undefined); }
      } else { unknown = true; continue; }
      const hash = createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
      if (hash !== tracked.hash) dirty = true;
    } } finally { await budget.wait(directoryHandle.close()).catch(() => undefined); }
  }
  try { await visit(root); } catch { return 'unknown'; }
  if ([...index.keys()].some(name => !seen.has(name))) dirty = true;
  return unknown ? 'unknown' : dirty ? 'dirty' : 'clean';
}

/** No cache is ownership proof; this cache only bounds repeated advisory filesystem reads. */
export class GitProbe {
  private readonly options: GitProbeOptions;
  private readonly cache = new Map<string, { at: number; facts: GitFacts | null }>();
  private readonly flights = new Set<Promise<GitFacts | null>>();
  constructor(options: GitProbeOptions = {}) { this.options = options; }
  async inspect(cwd: string, scopeRoot: string, signal?: AbortSignal): Promise<GitFacts | null> {
    if (!isAbsolute(cwd) || !isAbsolute(scopeRoot) || !safeText(cwd) || !safeText(scopeRoot) || signal?.aborted || this.flights.size >= 16) return null;
    const key = JSON.stringify([cwd, scopeRoot]); const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.facts;
    const work = this.read(cwd, scopeRoot, signal); this.flights.add(work);
    try { const facts = await work; if (!signal?.aborted) { if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!); this.cache.set(key, { at: Date.now(), facts }); } return facts; }
    finally { this.flights.delete(work); }
  }
  private async read(cwd: string, scopeRoot: string, signal?: AbortSignal): Promise<GitFacts | null> {
    const budget = new Budget(Math.max(1, Math.min(this.options.timeoutMs ?? 5_000, 60_000)), signal);
    try {
      // The pinned root itself must not become an alias to a replacement repo.
      // Ancestor symlinks remain allowed; realpath still bounds the local cwd.
      const rootPrefix = parse(scopeRoot).root;
      const strippedRoot = scopeRoot.replace(process.platform === 'win32' ? /[\\/]+$/u : /\/+$/u, '');
      const finalRoot = strippedRoot.length < rootPrefix.length ? rootPrefix : strippedRoot;
      if ((await budget.wait(lstat(finalRoot))).isSymbolicLink()) return null;
      const local = await budget.wait(realpath(cwd)), scope = await budget.wait(realpath(scopeRoot));
      if (!inside(scope, local) || !(await budget.wait(stat(local))).isDirectory()) return null;
      const binary = await budget.wait(trustedGit(this.options.executable ?? 'git')); if (!binary) return null;
      const run = (args: readonly string[]) => budget.wait(execute(binary, local, args, budget));
      const locations = await run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-object-format']);
      if (locations.code !== 0) return null;
      const [rootText, gitText, commonText, algorithm] = locations.text.trimEnd().split('\n');
      if (!rootText || !gitText || !commonText || !safeText(rootText) || !safeText(gitText) || !safeText(commonText) || !['sha1', 'sha256'].includes(algorithm ?? '')) return null;
      const root = await budget.wait(realpath(rootText)), git = await budget.wait(realpath(gitText)), common = await budget.wait(realpath(resolve(local, commonText)));
      if (!inside(scope, root) || !inside(root, local)) return null;
      const branchResult = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const branch = branchResult.code === 0 && safeText(branchResult.text.trim()) && branchResult.text.trim().length <= 256 ? branchResult.text.trim() : undefined;
      if (branchResult.code !== 0 && branchResult.code !== 1) return null;
      const head = await run(['rev-parse', '--verify', 'HEAD']);
      const commit = head.code === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\n?$/u.test(head.text) ? head.text.trim() : undefined;
      if (!commit && !branch) return null;
      const remoteName = this.options.defaultRemote ?? 'origin'; let remote: string | undefined;
      if (/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(remoteName)) {
        const url = await run(['config', '--null', '--get', `remote.${remoteName}.url`]);
        if (url.code === 0 && url.text.endsWith('\0')) remote = sanitizeGitRemote(url.text.slice(0, -1));
      }
      // Never open an ODB tree in partial/promisor/sparse repos. Old Git may not
      // implement GIT_NO_LAZY_FETCH; skipping the operation is the safe fallback.
      const special = await run(['config', '--null', '--name-only', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor|core\\.sparsecheckout|core\\.attributesfile|core\\.autocrlf|filter\\..*)$']);
      let dirty: GitFacts['dirty'] = 'unknown';
      if (special.code === 1 && special.text === '') {
        let hasAttributes = false;
        for (const metadata of new Set([git, common])) {
          try { await budget.wait(lstat(join(metadata, 'info', 'attributes'))); hasAttributes = true; }
          catch (error) { budget.check(); if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) hasAttributes = true; }
        }
        if (!hasAttributes) {
          const listed = await run(['ls-files', '--stage', '-z', '--cached']);
          const index = listed.code === 0 ? entries(listed.text, false) : undefined;
          if (index) {
            if (!commit) dirty = index.size > 0 ? 'dirty' : await contentState(root, index, algorithm!, budget);
            else {
              const treeResult = await run(['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
              const tree = treeResult.code === 0 ? entries(treeResult.text, true) : undefined;
              if (tree) dirty = index.size !== tree.size || [...index].some(([name, value]) => tree.get(name)?.hash !== value.hash || tree.get(name)?.mode !== value.mode) ? 'dirty' : await contentState(root, index, algorithm!, budget);
            }
          }
        }
      }
      return parseGitFacts({ v: 1, root, detached: branch === undefined, unborn: commit === undefined, worktree: git !== common, dirty, ...(branch ? { branch } : {}), ...(commit ? { commit } : {}), ...(remote ? { remote } : {}) }) ?? null;
    } catch { return null; }
    finally { budget.close(); }
  }
}
