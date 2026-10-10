import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckoutState, CreateCheckoutInput, CreatedCheckout, GitExecutor, GitRunResult, PatchFile, RemoteBranches, RemoteInfo, RepositoryInfo, SnapshotInput, WorktreeConfig, WorktreePreview, WorktreeRecord } from './types.js';
import { abortIfRequested, WorktreeError } from './errors.js';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const overrides = [
  'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false',
  'core.attributesFile=/dev/null', 'core.autocrlf=false', 'core.safecrlf=false',
  'core.fileMode=true', 'core.symlinks=true', 'core.quotePath=true', 'core.askPass=',
  'core.ignoreStat=false', 'core.ignorecase=false', 'core.checkStat=default', 'core.trustctime=true',
  'diff.external=', 'diff.ignoreSubmodules=none', 'submodule.recurse=false',
  'fetch.recurseSubmodules=false', 'fetch.writeCommitGraph=false',
  'maintenance.auto=false', 'gc.auto=0', 'gc.autoDetach=false',
  'protocol.allow=never', 'protocol.file.allow=always', 'protocol.https.allow=always',
  'protocol.ssh.allow=always', 'protocol.ext.allow=never', 'credential.interactive=false',
  'core.pager=cat', 'color.ui=false', 'advice.detachedHead=false',
];
const selectors = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_EXEC_PATH', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS', 'GIT_TEMPLATE_DIR', 'GIT_ATTR_SOURCE', 'GIT_ATTR_NOSYSTEM', 'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_SHALLOW_FILE', 'GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_TRACE_CURL', 'GIT_TRACE_SETUP'];
type PrivateStore = { root: string; env: NodeJS.ProcessEnv };
type Entry = { path: string; mode: string; oid: string };
type Status = { state: CheckoutState; raw: Buffer; paths: string[] };

function checkoutProgress(input: CreateCheckoutInput, stage: 'fetching' | 'creating'): void {
  // Observation is not admission. Also absorb rejected promises from JS listeners.
  try { void Promise.resolve(input.onProgress?.(stage)).catch(() => undefined); } catch { /* observer only */ }
}

function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new WorktreeError(code, message, details); }
function text(data: Buffer): string {
  try { return utf8.decode(data); } catch { return fail('UNSUPPORTED_ENCODING', 'Git paths or output are not valid UTF-8.'); }
}
function nul(data: Buffer): string[] {
  if (!data.length) return [];
  if (data[data.length - 1] !== 0) fail('TRUNCATED_OUTPUT', 'Git returned an incomplete NUL-delimited result.');
  return text(data).slice(0, -1).split('\0');
}
function oid(value: string): string { if (!oidPattern.test(value)) fail('INVALID_GIT_OUTPUT', 'Git returned an invalid object identity.'); return value; }
function inside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function validPath(value: string): void {
  if (!value || value.includes('\0') || (path.sep === '\\' && value.includes('\\')) || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) fail('UNSAFE_PATH', 'An unsupported or unsafe repository path was encountered.');
}
function hash(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function line(data: Buffer): string { const value = text(data); if (!value.endsWith('\n')) fail('TRUNCATED_OUTPUT', 'Git returned an incomplete result.'); return value.slice(0, -1); }

/** Strict Git engine. Its executor must enforce byte bounds, deadlines and caller sandbox access. */
export class GitOperations {
  constructor(private readonly execute: GitExecutor, private readonly config: WorktreeConfig, private readonly authorize: () => void = () => undefined) {}

  private env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    for (const name of [...Object.keys(process.env).filter(key => key.startsWith('GIT_')), ...selectors]) result[name] = undefined;
    result.SSH_ASKPASS = undefined;
    result.SSH_ASKPASS_REQUIRE = 'never';
    result.GIT_TERMINAL_PROMPT = '0'; result.GCM_INTERACTIVE = 'Never';
    result.GIT_OPTIONAL_LOCKS = '0'; result.GIT_NO_REPLACE_OBJECTS = '1';
    result.GIT_ATTR_NOSYSTEM = '1'; result.LC_ALL = 'C.UTF-8';
    return { ...result, ...extra };
  }

  private async run(cwd: string, args: string[], signal?: AbortSignal, options: { env?: NodeJS.ProcessEnv; stdin?: string | Uint8Array; allowed?: number[]; fetch?: boolean; maxBytes?: number } = {}): Promise<GitRunResult> {
    abortIfRequested(signal);
    const maxBytes = options.maxBytes ?? this.config.maxRefBytes;
    try {
      const disabledDrivers: string[] = [];
      if (args[0] !== 'config') {
        const drivers = await this.run(cwd, ['config', '--null', '--get-regexp', '^(filter\\..*\\.(process|clean|smudge|required)|diff\\..*\\.(command|textconv))$'], signal, { allowed: [0, 1], env: options.env });
        for (const row of nul(drivers.stdout)) {
          const key = row.slice(0, row.indexOf('\n'));
          if (!key || /[\0\r\n]/u.test(key)) fail('UNSUPPORTED_CONFIG', 'A configured Git driver has an unsupported name.');
          disabledDrivers.push(`${key}=${key.endsWith('.required') ? 'false' : ''}`);
        }
      }
      this.authorize();
      const result = await this.execute({ cwd, args: ['--no-pager', ...[...overrides, ...disabledDrivers].flatMap(value => ['-c', value]), ...args], env: this.env(options.env), signal, stdin: options.stdin, timeoutMs: options.fetch ? this.config.fetchTimeoutMs : this.config.commandTimeoutMs, maxBytes, allowedExitCodes: options.allowed ?? [0] });
      if (result.stdout.length + result.stderr.length > maxBytes) fail('OUTPUT_LIMIT', 'Git output exceeded the configured byte limit.');
      if (!(options.allowed ?? [0]).includes(result.exitCode)) fail('GIT_FAILED', 'Git could not complete the requested operation.', { exitCode: result.exitCode });
      return result;
    } catch (error) {
      if (error instanceof WorktreeError) throw error;
      abortIfRequested(signal);
      // Executor diagnostics may contain remote URLs, credential-helper output, or local secrets.
      throw new WorktreeError('GIT_FAILED', 'Git could not complete the requested operation within its limits.');
    }
  }

  private async configValues(root: string, key: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.run(root, ['config', '--null', '--get-all', key], signal, { allowed: [0, 1] });
    return result.exitCode === 1 ? [] : nul(result.stdout);
  }

  private async supported(root: string, signal?: AbortSignal): Promise<void> {
    for (const key of ['core.sparseCheckout', 'core.sparseCheckoutCone', 'extensions.partialClone', 'extensions.worktreeConfig', 'extensions.refStorage']) {
      const values = await this.configValues(root, key, signal);
      if (values.some(value => !['false', 'no', 'off', '0'].includes(value.toLowerCase()))) fail('UNSUPPORTED_REPOSITORY', 'Sparse, partial or unsupported repository mappings are not supported.');
    }
    const promisor = await this.run(root, ['config', '--null', '--get-regexp', '^remote\\..*\\.promisor$'], signal, { allowed: [0, 1] });
    if (promisor.exitCode === 0 && nul(promisor.stdout).some(value => !['false', 'no', 'off', '0'].includes(value.slice(value.indexOf('\n') + 1).toLowerCase()))) fail('UNSUPPORTED_REPOSITORY', 'Partial repositories are not supported.');
    const shallow = line((await this.run(root, ['rev-parse', '--is-shallow-repository'], signal)).stdout);
    if (shallow !== 'false') fail('UNSUPPORTED_REPOSITORY', 'Shallow repositories are not supported.');
    const bare = line((await this.run(root, ['rev-parse', '--is-bare-repository'], signal)).stdout);
    if (bare !== 'false') fail('UNSUPPORTED_REPOSITORY', 'Bare repositories cannot be used as source checkouts.');
    const coreWorkTree = await this.configValues(root, 'core.worktree', signal);
    if (coreWorkTree.length) fail('UNSUPPORTED_REPOSITORY', 'Custom Git worktree mappings are not supported.');
  }

  async discover(projectPath: string, signal?: AbortSignal): Promise<RepositoryInfo> {
    const project = await realpath(projectPath).catch(() => fail('MISSING_PATH', 'The selected project directory is unavailable.'));
    if (path.resolve(projectPath) !== project) fail('UNSAFE_PATH', 'Symlinked project directory mappings are not supported.');
    if (!(await stat(project)).isDirectory()) fail('MISSING_PATH', 'The selected project must be a directory.');
    const root = await realpath(line((await this.run(project, ['rev-parse', '--path-format=absolute', '--show-toplevel'], signal)).stdout));
    if (!inside(root, project)) fail('UNSAFE_PATH', 'The project directory is outside the repository.');
    await this.supported(root, signal);
    const commonDir = await realpath(line((await this.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).stdout));
    const mapping = await lstat(path.join(root, '.git'));
    if (mapping.isSymbolicLink() || (!mapping.isFile() && !mapping.isDirectory()) || (mapping.isDirectory() && commonDir !== path.join(root, '.git'))) fail('UNSUPPORTED_REPOSITORY', 'Unsupported Git admin directory mappings are not supported.');
    const headResult = await this.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal, { allowed: [0, 128] });
    if (headResult.exitCode !== 0) fail('UNBORN_REPOSITORY', 'The repository does not have a committed HEAD.');
    const branchResult = await this.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal, { allowed: [0, 1] });
    return { root, commonDir, projectSubdir: path.relative(root, project).split(path.sep).join('/'), head: oid(line(headResult.stdout)), branch: branchResult.exitCode === 0 ? line(branchResult.stdout) : null };
  }

  private async ref(root: string, value: string, signal?: AbortSignal): Promise<void> {
    if (value.includes('\0') || value.includes('\n') || value.startsWith('-')) fail('INVALID_REF', 'The selected Git reference is invalid.');
    const result = await this.run(root, ['check-ref-format', value], signal, { allowed: [0, 1] });
    if (result.exitCode !== 0) fail('INVALID_REF', 'The selected Git reference is invalid.');
  }

  private async remote(root: string, name: string, signal?: AbortSignal): Promise<{ identity: string }> {
    if (!name || name.startsWith('-') || /[\0\r\n]/u.test(name)) fail('INVALID_REF', 'The remote name is invalid.');
    await this.ref(root, `refs/remotes/${name}/__validate__`, signal);
    const raw = await this.configValues(root, `remote.${name}.url`, signal);
    if (raw.length !== 1 || raw[0]?.includes('\n')) fail('UNSUPPORTED_REMOTE', 'The remote must have exactly one unambiguous fetch URL.');
    if ((await this.configValues(root, `remote.${name}.vcs`, signal)).length) fail('UNSUPPORTED_REMOTE', 'Executable remote helpers are not supported.');
    const effective = line((await this.run(root, ['remote', 'get-url', '--all', name], signal)).stdout);
    if (!effective || /[\0\r\n]/u.test(effective) || effective.startsWith('-')) fail('UNSUPPORTED_REMOTE', 'The remote transport is not supported.');
    let canonical: string;
    if (/^https:\/\//iu.test(effective)) {
      const url = new URL(effective);
      if (!url.hostname || url.hash) fail('UNSUPPORTED_REMOTE', 'The remote transport is not supported.');
      canonical = url.href;
    } else if (/^ssh:\/\//iu.test(effective)) {
      const url = new URL(effective);
      if (!url.hostname || url.password || url.hash || url.search) fail('UNSUPPORTED_REMOTE', 'The remote transport is not supported.');
      canonical = url.href;
    } else if (/^file:\/\//iu.test(effective)) {
      const url = new URL(effective);
      if ((url.hostname && url.hostname !== 'localhost') || url.username || url.password || url.hash || url.search) fail('UNSUPPORTED_REMOTE', 'Only canonical local file remotes are supported.');
      canonical = await realpath(decodeURIComponent(url.pathname)).catch(() => fail('REMOTE_UNAVAILABLE', 'The local remote is unavailable.'));
    } else if (/^(?:[^\s/:@]+@)?[^\s/:]+:[^\0\r\n]+$/u.test(effective) && !effective.includes('::') && !effective.includes('://')) {
      canonical = effective; // Standard SSH scp syntax, never an executable helper scheme.
    } else if (!/^[a-z][a-z0-9+.-]*:/iu.test(effective)) {
      canonical = await realpath(path.resolve(root, effective)).catch(() => fail('REMOTE_UNAVAILABLE', 'The local remote is unavailable.'));
    } else return fail('UNSUPPORTED_REMOTE', 'Only HTTPS, SSH and local file remotes are supported.');
    return { identity: hash(JSON.stringify({ name, configured: raw[0], canonical })) };
  }

  async remotes(repoRoot: string, signal?: AbortSignal): Promise<RemoteInfo[]> {
    const result = await this.run(repoRoot, ['config', '--null', '--get-regexp', '^remote\\..*\\.url$'], signal, { allowed: [0, 1] });
    if (result.exitCode === 1) return [];
    const names = new Set<string>();
    for (const record of nul(result.stdout)) {
      const key = record.slice(0, record.indexOf('\n'));
      if (!key.startsWith('remote.') || !key.endsWith('.url')) fail('INVALID_GIT_OUTPUT', 'Git returned an invalid remote entry.');
      names.add(key.slice(7, -4));
    }
    const output: RemoteInfo[] = [];
    for (const name of [...names].sort()) output.push({ name, identity: (await this.remote(repoRoot, name, signal)).identity });
    return output;
  }

  async branches(repoRoot: string, remote: string, identity?: string, signal?: AbortSignal): Promise<RemoteBranches> {
    const selected = await this.remote(repoRoot, remote, signal);
    if (identity && selected.identity !== identity) fail('REMOTE_CHANGED', 'The remote identity has changed.');
    const result = await this.run(repoRoot, ['ls-remote', '--symref', '--upload-pack=git-upload-pack', '--', remote, 'HEAD', 'refs/heads/*'], signal, { fetch: true });
    const output = text(result.stdout);
    if (output && !output.endsWith('\n')) fail('TRUNCATED_OUTPUT', 'The advertised branch generation was truncated.');
    const branches: RemoteBranches['branches'] = [];
    let defaultBranch: string | null = null;
    const seen = new Set<string>();
    for (const row of output ? output.slice(0, -1).split('\n') : []) {
      const tab = row.indexOf('\t');
      if (tab < 0) fail('INVALID_GIT_OUTPUT', 'The remote advertised an invalid reference.');
      const left = row.slice(0, tab); const right = row.slice(tab + 1);
      if (left.startsWith('ref: ')) {
        if (right !== 'HEAD' || !left.slice(5).startsWith('refs/heads/')) fail('INVALID_GIT_OUTPUT', 'The remote advertised an unsupported symbolic reference.');
        defaultBranch = left.slice(16);
      } else if (right.startsWith('refs/heads/')) {
        await this.ref(repoRoot, right, signal);
        const name = right.slice(11);
        if (seen.has(name)) fail('INVALID_GIT_OUTPUT', 'The remote advertised duplicate references.');
        seen.add(name); branches.push({ name, oid: oid(left) });
        if (branches.length > this.config.maxFiles) fail('REF_LIMIT', 'The advertised branch generation exceeds the configured count limit.');
      } else if (right === 'HEAD') oid(left);
      else fail('INVALID_GIT_OUTPUT', 'The remote advertised an unexpected reference.');
    }
    if ((await this.remote(repoRoot, remote, signal)).identity !== selected.identity) fail('REMOTE_CHANGED', 'The remote identity changed during branch discovery.');
    return { remote, remoteIdentity: selected.identity, defaultBranch, branches: branches.sort((a, b) => a.name.localeCompare(b.name)), observedAt: Date.now() };
  }

  private async destination(root: string, requested: string): Promise<string> {
    const absolute = path.resolve(requested);
    const parent = await realpath(path.dirname(absolute)).catch(() => fail('MISSING_PATH', 'The managed checkout parent directory is unavailable.'));
    if (parent !== path.dirname(absolute)) fail('UNSAFE_PATH', 'The managed checkout destination has symlinked ancestors.');
    if (inside(root, absolute) || inside(absolute, root)) fail('UNSAFE_PATH', 'Source and managed checkout paths must not be nested.');
    const exists = await lstat(absolute).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return false; });
    if (exists) fail('DESTINATION_EXISTS', 'The managed checkout destination already exists.');
    return absolute;
  }

  private async store(root: string, commonDir: string): Promise<PrivateStore> {
    const canonical = await realpath(root);
    if (canonical !== path.resolve(root)) fail('UNSAFE_PATH', 'The snapshot directory has symlinked ancestors.');
    this.authorize();
    const privateRoot = await mkdtemp(path.join(canonical, 'git-private-'));
    this.authorize();
    await mkdir(path.join(privateRoot, 'objects'), { mode: 0o700 });
    return { root: privateRoot, env: { GIT_INDEX_FILE: path.join(privateRoot, 'index'), GIT_OBJECT_DIRECTORY: path.join(privateRoot, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(path.join(commonDir, 'objects')) } };
  }

  private async removeStore(store: PrivateStore): Promise<void> {
    const absolute = path.resolve(store.root);
    if (absolute !== store.root || !path.basename(absolute).startsWith('git-private-') || (await realpath(absolute)) !== absolute) fail('UNSAFE_PATH', 'Private snapshot cleanup could not verify its owned directory.');
    this.authorize();
    await rm(absolute, { recursive: true, force: false });
  }

  private async tree(root: string, tree: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<Entry[]> {
    const rows = nul((await this.run(root, ['ls-tree', '-rz', '--full-tree', tree], signal, { env })).stdout);
    if (rows.length > this.config.maxFiles) fail('FILE_LIMIT', 'The repository exceeds the configured file count limit.');
    return rows.map(row => {
      const tab = row.indexOf('\t'); const metadata = row.slice(0, tab).split(' '); const name = row.slice(tab + 1);
      if (tab < 0 || metadata.length !== 3 || metadata[1] !== 'blob' || !['100644', '100755', '120000'].includes(metadata[0] ?? '')) fail('UNSUPPORTED_CHECKOUT', 'Submodules or unsupported tree entries are not supported.');
      validPath(name);
      return { path: name, mode: metadata[0]!, oid: oid(metadata[2]!) };
    });
  }

  private async attributes(root: string, files: string[], signal?: AbortSignal, env?: NodeJS.ProcessEnv, cached = false): Promise<void> {
    if (!files.length) return;
    const result = await this.run(root, ['check-attr', ...(cached ? ['--cached'] : []), '-z', '--stdin', 'filter', 'working-tree-encoding'], signal, { env, stdin: `${files.join('\0')}\0` });
    const records = nul(result.stdout);
    if (records.length !== files.length * 6) fail('TRUNCATED_OUTPUT', 'Git returned incomplete attribute results.');
    for (let index = 0; index < records.length; index += 3) {
      if (!['unspecified', 'unset'].includes(records[index + 2] ?? '')) fail('UNSUPPORTED_ATTRIBUTES', 'Clean/smudge/LFS filters and working-tree encodings are not supported.');
    }
  }

  async create(input: CreateCheckoutInput): Promise<CreatedCheckout> {
    const { signal } = input;
    const repository = await this.discover(path.join(input.repository.root, input.repository.projectSubdir), signal);
    if (repository.root !== input.repository.root || repository.commonDir !== input.repository.commonDir) fail('REPOSITORY_CHANGED', 'The source repository identity changed.');
    const destination = await this.destination(repository.root, input.destination);
    if (!input.remoteBranch || input.remoteBranch.startsWith('-')) fail('INVALID_REF', 'The selected branch name is invalid.');
    await this.ref(repository.root, `refs/heads/${input.remoteBranch}`, signal);
    await this.ref(repository.root, `refs/remotes/${input.remote}/${input.remoteBranch}`, signal);
    await this.ref(repository.root, input.baseRef, signal);
    if (!input.baseRef.startsWith('refs/dsh-worktrees/')) fail('INVALID_REF', 'The persistent base ref must use the managed worktree namespace.');
    const prior = await this.run(repository.root, ['show-ref', '--verify', '--quiet', input.baseRef], signal, { allowed: [0, 1] });
    if (prior.exitCode === 0) fail('BASE_REF_EXISTS', 'The persistent base reference is already in use.');
    const remote = await this.remote(repository.root, input.remote, signal);
    if (remote.identity !== input.remoteIdentity) fail('REMOTE_CHANGED', 'The selected remote identity has changed.');
    checkoutProgress(input, 'fetching');
    await this.run(repository.root, ['fetch', '--atomic', '--refmap=', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-commit-graph', '--no-prune', '--upload-pack=git-upload-pack', '--', input.remote, `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remote}/${input.remoteBranch}`, `refs/heads/${input.remoteBranch}:${input.baseRef}`], signal, { fetch: true });
    if ((await this.remote(repository.root, input.remote, signal)).identity !== remote.identity) fail('REMOTE_CHANGED', 'The remote changed during fetch; fetched refs may remain.', { refsMayHaveChanged: true });
    const baseOid = oid(line((await this.run(repository.root, ['rev-parse', '--verify', `${input.baseRef}^{commit}`], signal)).stdout));
    const entries = await this.tree(repository.root, baseOid, signal);
    if (repository.projectSubdir && !entries.some(entry => entry.path.startsWith(`${repository.projectSubdir}/`))) fail('PROJECT_SUBDIR_MISSING', 'The project subdirectory is absent from the freshly fetched tree.');
    // Attribute validation uses an isolated index and object store, never the source index.
    const privateStore = await this.store(path.dirname(destination), repository.commonDir);
    try {
      await this.run(repository.root, ['read-tree', baseOid], signal, { env: privateStore.env });
      await this.attributes(repository.root, entries.map(entry => entry.path), signal, privateStore.env, true);
      for (const entry of entries.filter(value => value.mode === '120000')) {
        const target = text((await this.run(repository.root, ['cat-file', 'blob', entry.oid], signal)).stdout);
        if (!target || path.isAbsolute(target) || !inside(destination, path.resolve(destination, path.dirname(entry.path), target))) fail('UNSAFE_SYMLINK', 'The fetched tree contains an escaping symlink.');
      }
    } finally { await this.removeStore(privateStore); }
    checkoutProgress(input, 'creating');
    try {
      await this.run(repository.root, ['worktree', 'add', '--detach', '--', destination, baseOid], signal);
      const checkoutRoot = await realpath(destination);
      const effectiveCwd = await realpath(path.join(checkoutRoot, repository.projectSubdir)).catch(() => fail('PROJECT_SUBDIR_MISSING', 'The fetched project directory is unavailable.'));
      if (checkoutRoot !== destination || !inside(checkoutRoot, effectiveCwd)) fail('UNSAFE_PATH', 'The created checkout has an unsafe project mapping.');
      return { checkoutRoot, effectiveCwd, baseOid, baseRef: input.baseRef, fetchedAt: Date.now() };
    } catch (error) {
      throw new WorktreeError(error instanceof WorktreeError ? error.code : 'CREATE_FAILED', 'Checkout creation failed; inspect the managed path before recovery. No checkout was deleted.', { checkoutMayExist: true, refsMayHaveChanged: true });
    }
  }

  private async identity(root: string, expectedCommon: string, signal?: AbortSignal): Promise<RepositoryInfo> {
    const info = await this.discover(root, signal);
    if (info.root !== root || info.commonDir !== expectedCommon) fail('CHECKOUT_IDENTITY_CHANGED', 'The checkout repository identity changed.');
    return info;
  }

  private async metadata(file: string): Promise<string> {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > this.config.maxRefBytes) fail('CHECKOUT_IDENTITY_CHANGED', 'Git admin metadata is not a bounded ordinary file.');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const data = await handle.readFile(); if (data.length > this.config.maxRefBytes) fail('OUTPUT_LIMIT', 'Git admin metadata exceeds the configured byte limit.'); return text(data); }
    finally { await handle.close(); }
  }

  private async registered(info: RepositoryInfo, repositoryRoot: string, signal?: AbortSignal): Promise<void> {
    const dotGit = path.join(info.root, '.git');
    const mapping = await lstat(dotGit);
    if (mapping.isDirectory()) {
      if (dotGit !== info.commonDir || await realpath(dotGit) !== dotGit) fail('CHECKOUT_IDENTITY_CHANGED', 'The main checkout Git admin mapping changed.');
    } else {
      const pointer = await this.metadata(dotGit);
      if (!pointer.startsWith('gitdir: ') || !pointer.endsWith('\n') || pointer.slice(8, -1).includes('\n')) fail('CHECKOUT_IDENTITY_CHANGED', 'The checkout Git admin pointer is invalid.');
      const admin = await realpath(path.resolve(info.root, pointer.slice(8, -1)));
      if (path.dirname(admin) !== path.join(info.commonDir, 'worktrees')) fail('CHECKOUT_IDENTITY_CHANGED', 'The checkout Git admin directory is not a registered worktree.');
      const backlink = (await this.metadata(path.join(admin, 'gitdir'))).replace(/\n$/u, '');
      if (await realpath(path.resolve(admin, backlink)) !== dotGit) fail('CHECKOUT_IDENTITY_CHANGED', 'The Git admin backlink does not identify this checkout.');
      const common = (await this.metadata(path.join(admin, 'commondir'))).replace(/\n$/u, '');
      if (await realpath(path.resolve(admin, common)) !== info.commonDir) fail('CHECKOUT_IDENTITY_CHANGED', 'The Git admin common directory changed.');
    }
    const registration = nul((await this.run(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'], signal)).stdout);
    const roots = registration.filter(value => value.startsWith('worktree ')).map(value => value.slice(9));
    if (roots.filter(value => value === info.root).length !== 1) fail('CHECKOUT_IDENTITY_CHANGED', 'The checkout is not uniquely registered with its source repository.');
  }

  async verify(record: WorktreeRecord, signal?: AbortSignal): Promise<CheckoutState> {
    if (path.resolve(record.checkoutRoot) !== record.checkoutRoot || (await realpath(record.checkoutRoot)) !== record.checkoutRoot) fail('CHECKOUT_IDENTITY_CHANGED', 'The managed checkout path is not canonical.');
    const info = await this.identity(record.checkoutRoot, record.commonDir, signal);
    const source = await this.identity(record.repoRoot, record.commonDir, signal);
    if (source.root === info.root || inside(source.root, info.root)) fail('CHECKOUT_IDENTITY_CHANGED', 'The managed checkout has an unsupported source mapping.');
    const effective = await realpath(path.join(info.root, record.projectSubdir));
    if (effective !== record.effectiveCwd || !inside(info.root, effective)) fail('CHECKOUT_IDENTITY_CHANGED', 'The managed project directory changed.');
    if (!(await lstat(path.join(info.root, '.git'))).isFile()) fail('CHECKOUT_IDENTITY_CHANGED', 'The managed checkout must have a Git admin pointer file.');
    await this.registered(info, record.repoRoot, signal);
    await this.ref(record.repoRoot, record.baseRef, signal);
    if (!record.baseRef.startsWith('refs/dsh-worktrees/') || oid(line((await this.run(record.repoRoot, ['rev-parse', '--verify', `${record.baseRef}^{commit}`], signal)).stdout)) !== record.baseOid) fail('BASE_CHANGED', 'The pinned checkout base reference changed.');
    return this.status(record.checkoutRoot, signal);
  }

  private async statusRaw(root: string, signal?: AbortSignal): Promise<Status> {
    const result = await this.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], signal);
    const rows = nul(result.stdout); const paths: string[] = []; let changes = 0; let untracked = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (row.length < 4 || row[2] !== ' ') fail('INVALID_GIT_OUTPUT', 'Git status returned an invalid record.');
      const code = row.slice(0, 2); const file = row.slice(3); validPath(file); paths.push(file);
      if (code.includes('U') || ['AA', 'DD'].includes(code)) fail('UNMERGED_CHECKOUT', 'Unmerged files are not supported.');
      if (code === '??') untracked++; else changes++;
      if (/[RC]/u.test(code)) { const original = rows[++index]; if (!original) fail('TRUNCATED_OUTPUT', 'Git status returned an incomplete rename.'); validPath(original); paths.push(original); }
    }
    if (changes + untracked > this.config.maxFiles) fail('FILE_LIMIT', 'Git status exceeds the configured file count limit.');
    const head = oid(line((await this.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).stdout));
    const branch = await this.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal, { allowed: [0, 1] });
    return { state: { head, branch: branch.exitCode === 0 ? line(branch.stdout) : null, dirty: changes + untracked > 0, changes, untracked }, raw: result.stdout, paths };
  }

  async status(checkoutRoot: string, signal?: AbortSignal): Promise<CheckoutState> { return (await this.statusRaw(checkoutRoot, signal)).state; }

  async createBranch(record: WorktreeRecord, name: string, signal?: AbortSignal): Promise<CheckoutState> {
    await this.verify(record, signal);
    await this.files(record.checkoutRoot, signal);
    await this.ref(record.checkoutRoot, `refs/heads/${name}`, signal);
    if (name.startsWith('-') || name === 'HEAD') fail('INVALID_REF', 'The branch name is invalid.');
    await this.run(record.checkoutRoot, ['switch', '--no-track', '-c', name], signal);
    return this.status(record.checkoutRoot, signal);
  }

  /** Rename metadata only, never switch HEAD, force a collision or touch the index/files. */
  async renameBranch(record: WorktreeRecord, expected: string, name: string, signal?: AbortSignal): Promise<CheckoutState> {
    const before = await this.verify(record, signal);
    if (before.branch !== expected || record.branch !== expected) fail('BRANCH_CHANGED', 'The initial worktree branch was changed; automatic naming will not override it.');
    for (const branch of [expected, name]) {
      await this.ref(record.checkoutRoot, `refs/heads/${branch}`, signal);
      if (branch.startsWith('-') || branch === 'HEAD') fail('INVALID_REF', 'The branch name is invalid.');
    }
    if (name === expected) return before;
    const exists = await this.run(record.checkoutRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], signal, { allowed: [0, 1] });
    if (exists.exitCode === 0) fail('BRANCH_EXISTS', 'The generated branch already exists; automatic naming will not overwrite it.');
    // Revalidate both the registered checkout and expected HEAD immediately before mutation.
    if ((await this.verify(record, signal)).branch !== expected) fail('BRANCH_CHANGED', 'The initial worktree branch changed before naming.');
    await this.run(record.checkoutRoot, ['branch', '-m', expected, name], signal);
    const after = await this.verify(record, signal);
    if (after.branch !== name || after.head !== before.head) fail('BRANCH_RENAME_UNCERTAIN', 'The branch rename result changed; inspect the checkout before recovery.');
    return after;
  }

  private async files(root: string, signal?: AbortSignal): Promise<{ paths: string[]; index: Buffer; status: Status }> {
    await this.supported(root, signal);
    const index = (await this.run(root, ['ls-files', '--stage', '-z'], signal)).stdout;
    for (const entry of nul(index)) {
      const tab = entry.indexOf('\t'); const mode = entry.slice(0, 6);
      if (tab < 0 || !entry.slice(0, tab).endsWith(' 0') || !['100644', '100755', '120000'].includes(mode)) fail('UNSUPPORTED_CHECKOUT', 'Unmerged entries, submodules and unsupported index entries are not supported.');
    }
    const flags = nul((await this.run(root, ['ls-files', '-v', '-z'], signal)).stdout);
    if (flags.some(value => value[0] !== 'H')) fail('UNSUPPORTED_CHECKOUT', 'Sparse, skip-worktree and assume-unchanged index entries are not supported.');
    const paths = [...new Set(nul((await this.run(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal)).stdout))].sort();
    if (paths.length > this.config.maxFiles) fail('FILE_LIMIT', 'The checkout exceeds the configured file count limit.');
    for (const file of paths) validPath(file);
    await this.attributes(root, paths, signal);
    return { paths, index, status: await this.statusRaw(root, signal) };
  }

  private async fileData(root: string, name: string, remaining: number): Promise<{ data: Buffer; kind: string; executable: boolean }> {
    const absolute = path.join(root, name);
    let info;
    try { info = await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: Buffer.alloc(0), kind: 'missing', executable: false }; return fail('UNREADABLE_FILE', 'A checkout file cannot be read.'); }
    // Never traverse a repository-controlled ancestor symlink.
    const parent = await realpath(path.dirname(absolute)).catch(() => fail('UNREADABLE_FILE', 'A checkout path cannot be read.'));
    if (parent !== path.dirname(absolute) || !inside(root, parent)) fail('UNSAFE_SYMLINK', 'A checkout path traverses a symlink.');
    if (info.isSymbolicLink()) {
      const { readlink } = await import('node:fs/promises');
      const data = await readlink(absolute, { encoding: 'buffer' }); text(data);
      if (data.length > remaining) fail('SNAPSHOT_LIMIT', 'Checkout contents exceed the configured snapshot byte limit.');
      return { data, kind: 'symlink', executable: false };
    }
    if (!info.isFile()) fail('UNSUPPORTED_CHECKOUT', 'Special files and nested repositories are not supported.');
    if ((info.mode & 0o444) === 0) fail('UNREADABLE_FILE', 'A checkout file is unreadable.');
    if (info.size > remaining) fail('SNAPSHOT_LIMIT', 'Checkout contents exceed the configured snapshot byte limit.');
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail('UNREADABLE_FILE', 'A checkout file cannot be opened safely.'));
    try {
      const data = await handle.readFile();
      if (data.length > remaining) fail('SNAPSHOT_LIMIT', 'Checkout contents exceed the configured snapshot byte limit.');
      return { data, kind: 'file', executable: (info.mode & 0o111) !== 0 };
    } finally { await handle.close(); }
  }

  async fingerprint(checkoutRoot: string, signal?: AbortSignal): Promise<string> {
    const root = await realpath(checkoutRoot);
    const before = await this.files(root, signal);
    const digest = createHash('sha256').update(before.status.state.head).update(before.index).update(before.status.raw);
    let bytes = 0;
    for (const name of before.paths) {
      abortIfRequested(signal);
      const content = await this.fileData(root, name, this.config.maxSnapshotBytes - bytes); bytes += content.data.length;
      digest.update(JSON.stringify([name, content.kind, content.executable, content.data.length])).update('\0').update(content.data);
    }
    const after = await this.statusRaw(root, signal);
    if (after.state.head !== before.status.state.head || !after.raw.equals(before.status.raw)) fail('SOURCE_CHANGED', 'The checkout changed while being fingerprinted.');
    return digest.digest('hex');
  }

  private async exactContents(root: string, entries: Entry[], paths: string[], signal?: AbortSignal): Promise<void> {
    const final = new Map(entries.map(entry => [entry.path, entry]));
    let bytes = 0;
    for (const name of paths) {
      abortIfRequested(signal);
      const content = await this.fileData(root, name, this.config.maxSnapshotBytes - bytes);
      bytes += content.data.length;
      const entry = final.get(name);
      if (content.kind === 'missing') {
        if (entry) fail('SOURCE_CHANGED', 'A snapshot file disappeared unexpectedly.');
        continue;
      }
      const algorithm = entry?.oid.length === 64 ? 'sha256' : 'sha1';
      const identity = createHash(algorithm).update(`blob ${content.data.length}\0`).update(content.data).digest('hex');
      const mode = content.kind === 'symlink' ? '120000' : content.executable ? '100755' : '100644';
      if (!entry || entry.oid !== identity || entry.mode !== mode) fail('UNSUPPORTED_CONTENT_TRANSFORM', 'The Git index does not exactly represent working file bytes and modes; content-transforming attributes are unsupported.');
    }
    const known = new Set(paths);
    if (entries.some(entry => !known.has(entry.path))) fail('SOURCE_CHANGED', 'The checkout file set changed during snapshot capture.');
  }

  private async ensureBase(source: RepositoryInfo, target: RepositoryInfo, baseOid: string, signal?: AbortSignal): Promise<void> {
    oid(baseOid);
    if (source.commonDir !== target.commonDir || source.root === target.root) fail('CHECKOUT_IDENTITY_CHANGED', 'Source and target must be distinct checkouts of the same repository.');
    if (target.head !== baseOid) fail('TARGET_BASE_CHANGED', 'The target must still be at the recorded base commit.');
    if ((await this.status(target.root, signal)).dirty) fail('TARGET_DIRTY', 'The target checkout must be clean.');
    const ancestry = await this.run(source.root, ['merge-base', '--is-ancestor', baseOid, source.head], signal, { allowed: [0, 1] });
    if (ancestry.exitCode !== 0) fail('SOURCE_BASE_CHANGED', 'The source is no longer descended from its recorded base.');
  }

  private async patchFiles(root: string, base: string, finalTree: string, store: PrivateStore, signal?: AbortSignal): Promise<PatchFile[]> {
    const rows = nul((await this.run(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', base, finalTree, '--'], signal, { env: store.env })).stdout);
    const binary = new Set<string>();
    const stats = nul((await this.run(root, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--no-renames', base, finalTree, '--'], signal, { env: store.env })).stdout);
    for (const row of stats) { const first = row.indexOf('\t'); const second = row.indexOf('\t', first + 1); if (first < 0 || second < 0) fail('INVALID_GIT_OUTPUT', 'Git returned invalid diff statistics.'); if (row.slice(0, first) === '-') binary.add(row.slice(second + 1)); }
    const files: PatchFile[] = [];
    for (let index = 0; index < rows.length; index++) {
      const status = rows[index]!; const original = rows[++index];
      if (!original || !/^(?:[AMDT]|R[0-9]+)$/u.test(status)) fail('INVALID_GIT_OUTPUT', 'Git returned invalid changed-file metadata.');
      validPath(original);
      if (status.startsWith('R')) { const renamed = rows[++index]; if (!renamed) fail('TRUNCATED_OUTPUT', 'Git returned an incomplete rename.'); validPath(renamed); files.push({ path: renamed, status: `${status}:${original}`, binary: binary.has(original) || binary.has(renamed) }); }
      else files.push({ path: original, status, binary: binary.has(original) });
    }
    if (files.length > this.config.maxFiles) fail('FILE_LIMIT', 'The patch exceeds the configured file count limit.');
    return files;
  }

  private async collisions(target: string, files: PatchFile[], base: Entry[]): Promise<void> {
    const tracked = new Set(base.map(entry => entry.path));
    for (const file of files) {
      validPath(file.path);
      let current = target;
      const parts = file.path.split('/');
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]!);
        const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info) break;
        if (info.isSymbolicLink()) fail('TARGET_COLLISION', 'A target patch path collides with a symlink.');
        if (index < parts.length - 1 && !info.isDirectory()) fail('TARGET_COLLISION', 'A target patch parent collides with an existing file.');
        if (index === parts.length - 1 && (!tracked.has(file.path) || !info.isFile())) fail('TARGET_COLLISION', 'A target patch path collides with an existing untracked or ignored entry.');
      }
    }
  }

  async snapshot(input: SnapshotInput): Promise<WorktreePreview> {
    const { signal } = input;
    const source = await this.discover(input.checkoutRoot, signal);
    const repository = await this.discover(input.repositoryRoot, signal);
    const target = await this.discover(input.targetRoot, signal);
    if (source.root !== input.checkoutRoot || target.root !== input.targetRoot || repository.root !== input.repositoryRoot || repository.commonDir !== source.commonDir) fail('CHECKOUT_IDENTITY_CHANGED', 'The snapshot checkout identities changed.');
    await this.registered(source, repository.root, signal);
    await this.registered(target, repository.root, signal);
    await this.ensureBase(source, target, input.baseOid, signal);
    const snapshotRoot = await realpath(input.snapshotRoot);
    const managed = await realpath(path.resolve(this.config.root));
    if (!inside(managed, snapshotRoot)) fail('UNSAFE_PATH', 'Private snapshots must be inside the authorized managed root.');
    if (inside(source.root, snapshotRoot) || inside(target.root, snapshotRoot) || inside(source.commonDir, snapshotRoot)) fail('UNSAFE_PATH', 'Private snapshots must live outside Git checkouts and source object storage.');
    const sourceFingerprint = await this.fingerprint(source.root, signal);
    const sourceFiles = await this.files(source.root, signal);
    const base = await this.tree(source.root, input.baseOid, signal);
    const headTree = await this.tree(source.root, source.head, signal);
    const symlinks = new Set([...base, ...headTree].filter(entry => entry.mode === '120000').map(entry => entry.path));
    for (const name of sourceFiles.paths) {
      const info = await lstat(path.join(source.root, name)).catch(() => null);
      if (info?.isSymbolicLink()) symlinks.add(name);
    }
    const privateStore = await this.store(snapshotRoot, source.commonDir);
    let retained = false;
    try {
      // Copy the real index's semantic entries, not its stat cache or extensions.
      // Staged ignored additions remain tracked; zero stat data forces re-reading even
      // same-size files whose mtimes have been restored. The real index is read only.
      await this.run(source.root, ['read-tree', '--empty'], signal, { env: privateStore.env });
      await this.run(source.root, ['update-index', '-z', '--index-info'], signal, { env: privateStore.env, stdin: sourceFiles.index });
      await this.attributes(source.root, sourceFiles.paths, signal, privateStore.env, true);
      await this.run(source.root, ['add', '-A', '--', '.'], signal, { env: privateStore.env });
      const finalTree = oid(line((await this.run(source.root, ['write-tree'], signal, { env: privateStore.env })).stdout));
      const finalEntries = await this.tree(source.root, finalTree, signal, privateStore.env);
      await this.exactContents(source.root, finalEntries, sourceFiles.paths, signal);
      await this.attributes(source.root, finalEntries.map(entry => entry.path), signal, privateStore.env, true);
      const files = await this.patchFiles(source.root, input.baseOid, finalTree, privateStore, signal);
      for (const file of files) {
        const original = file.status.startsWith('R') ? file.status.slice(file.status.indexOf(':') + 1) : file.path;
        if (symlinks.has(file.path) || symlinks.has(original)) fail('UNSAFE_SYMLINK', 'Changed symlinks are not supported by handoff snapshots.');
      }
      await this.collisions(target.root, files, base);
      const patch = (await this.run(source.root, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', input.baseOid, finalTree, '--'], signal, { env: privateStore.env, maxBytes: this.config.maxSnapshotBytes })).stdout;
      if (await this.fingerprint(source.root, signal) !== sourceFingerprint) fail('SOURCE_CHANGED', 'The source changed while the snapshot was created.');
      await this.ensureBase(await this.discover(source.root, signal), await this.discover(target.root, signal), input.baseOid, signal);
      const patchPath = path.join(privateStore.root, 'handoff.patch');
      this.authorize();
      await writeFile(patchPath, patch, { flag: 'wx', mode: 0o600 });
      const preview: WorktreePreview = { id: randomUUID(), worktreeId: input.worktreeId, sourceSessionId: input.sourceSessionId, sourceRoot: source.root, sourceCommonDir: source.commonDir, sourceHead: source.head, sourceFingerprint, targetRoot: target.root, targetCommonDir: target.commonDir, targetHead: target.head, baseOid: input.baseOid, finalTree, snapshotRoot: privateStore.root, patchPath, patchHash: hash(patch), bytes: patch.length, files, createdAt: Date.now() };
      const manifest = JSON.stringify(preview);
      if (Buffer.byteLength(manifest) > this.config.maxRefBytes) fail('OUTPUT_LIMIT', 'The preview metadata exceeds the configured byte limit.');
      this.authorize();
      await writeFile(path.join(privateStore.root, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
      retained = true;
      return preview;
    } finally { if (!retained) await this.removeStore(privateStore); }
  }

  private async ownedPreview(preview: WorktreePreview): Promise<{ patch: Buffer; store: PrivateStore }> {
    const root = path.resolve(preview.snapshotRoot);
    const managed = await realpath(path.resolve(this.config.root));
    if (!inside(managed, root)) fail('INVALID_PREVIEW', 'The preview is outside the authorized managed root.');
    if (root !== preview.snapshotRoot || (await realpath(root)) !== root || !path.basename(root).startsWith('git-private-') || preview.patchPath !== path.join(root, 'handoff.patch')) fail('INVALID_PREVIEW', 'The preview patch does not identify an owned snapshot.');
    for (const name of ['handoff.patch', 'manifest.json', 'objects']) {
      if ((await lstat(path.join(root, name))).isSymbolicLink()) fail('INVALID_PREVIEW', 'The snapshot contains an unsafe path.');
    }
    const manifestInfo = await stat(path.join(root, 'manifest.json'));
    if (manifestInfo.size > this.config.maxRefBytes) fail('INVALID_PREVIEW', 'The persisted preview metadata exceeds its limit.');
    const manifest = JSON.parse(text(await readFile(path.join(root, 'manifest.json')))) as WorktreePreview;
    if (JSON.stringify(manifest) !== JSON.stringify(preview)) fail('INVALID_PREVIEW', 'The persisted preview identity does not match.');
    const info = await stat(preview.patchPath);
    if (!info.isFile() || info.size > this.config.maxSnapshotBytes || info.size !== preview.bytes) fail('INVALID_PREVIEW', 'The preview patch size is invalid.');
    const patch = await readFile(preview.patchPath);
    if (hash(patch) !== preview.patchHash) fail('INVALID_PREVIEW', 'The preview patch hash changed.');
    return { patch, store: { root, env: { GIT_INDEX_FILE: path.join(root, `verify-${randomUUID()}.index`), GIT_OBJECT_DIRECTORY: path.join(root, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(path.join(preview.sourceCommonDir, 'objects')) } } };
  }

  async apply(preview: WorktreePreview, record: WorktreeRecord, signal?: AbortSignal): Promise<{ head: string; files: number }> {
    const owned = await this.ownedPreview(preview);
    await this.verify(record, signal);
    if (preview.worktreeId !== record.id || preview.sourceRoot !== record.checkoutRoot || preview.sourceCommonDir !== record.commonDir || preview.targetCommonDir !== record.commonDir || preview.baseOid !== record.baseOid || preview.targetHead !== record.baseOid) fail('INVALID_PREVIEW', 'The preview does not belong to this checkout and target.');
    const source = await this.identity(preview.sourceRoot, record.commonDir, signal);
    const target = await this.identity(preview.targetRoot, record.commonDir, signal);
    await this.registered(target, record.repoRoot, signal);
    await this.ensureBase(source, target, record.baseOid, signal);
    if (source.head !== preview.sourceHead || await this.fingerprint(source.root, signal) !== preview.sourceFingerprint) fail('STALE_PREVIEW', 'The source changed since this preview was created.');
    const base = await this.tree(target.root, record.baseOid, signal);
    await this.collisions(target.root, preview.files, base);
    await this.attributes(target.root, [...new Set([...base.map(entry => entry.path), ...preview.files.map(file => file.path)])], signal);
    if (!owned.patch.length) return { head: target.head, files: 0 };
    await this.run(target.root, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], signal, { stdin: owned.patch, maxBytes: this.config.maxSnapshotBytes });
    // Parent holds the source/target idle claims. This is intentionally not a global transaction.
    if (await this.fingerprint(source.root, signal) !== preview.sourceFingerprint) fail('STALE_PREVIEW', 'The source changed before handoff.');
    await this.ensureBase(await this.discover(source.root, signal), await this.discover(target.root, signal), record.baseOid, signal);
    let effects = false;
    try {
      effects = true;
      await this.run(target.root, ['apply', '--binary', '--whitespace=nowarn', '-'], signal, { stdin: owned.patch, maxBytes: this.config.maxSnapshotBytes });
      await this.run(target.root, ['read-tree', preview.finalTree], signal, { env: owned.store.env });
      await this.run(target.root, ['add', '-A', '--', '.'], signal, { env: owned.store.env });
      const resultTree = oid(line((await this.run(target.root, ['write-tree'], signal, { env: owned.store.env })).stdout));
      const actual = await this.status(target.root, signal);
      if (actual.head !== record.baseOid || resultTree !== preview.finalTree) fail('APPLY_RESULT_MISMATCH', 'The applied target does not match the preview.');
      const expected = await this.tree(target.root, preview.finalTree, signal, owned.store.env);
      await this.exactContents(target.root, expected, expected.map(entry => entry.path), signal);
      return { head: actual.head, files: preview.files.length };
    } catch (error) {
      throw new WorktreeError(effects ? 'APPLY_RECOVERY_REQUIRED' : 'APPLY_FAILED', 'Handoff failed after target writes may have begun. No destructive rollback was performed.', { targetMayHaveChanged: effects, causeCode: error instanceof WorktreeError ? error.code : 'GIT_FAILED' });
    } finally {
      const index = owned.store.env.GIT_INDEX_FILE;
      if (index && path.dirname(index) === owned.store.root && path.basename(index).startsWith('verify-')) {
        const resolved = path.resolve(index);
        if (resolved !== index) fail('UNSAFE_PATH', 'Private verification index cleanup was refused.');
        this.authorize();
        await rm(resolved, { force: true });
      }
    }
  }
}
