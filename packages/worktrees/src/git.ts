import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckoutState, CreateCheckoutInput, CreatedCheckout, GitExecutor, GitRunResult, PatchFile, LocalBranches, RemoteBranches, RemoteInfo, RepositoryInfo, SnapshotInput, WorktreeConfig, WorktreePreview, WorktreeRecord } from './types.js';
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

/** Durable observations, not deletion authority. Rechecked under the caller's maintenance claim. */
export interface RemovalIdentity {
  checkoutRoot: string;
  sourceRoot: string;
  commonDir: string;
  adminDir: string;
  head: string;
  branch: string | null;
  checkoutIdentity: string;
  sourceIdentity: string;
  commonIdentity: string;
  adminIdentity: string;
  pointerIdentity: string;
  pointerHash: string;
  backlinkIdentity: string;
  backlinkHash: string;
  commonPointerIdentity: string;
  commonPointerHash: string;
  sourceMappingIdentity: string;
  sourceMappingHash: string;
  privateStateHash: string;
  retainedHeads: string[];
}
export type RemovalState = 'present' | 'absent' | 'partial' | 'replaced';
type MetadataIdentity = { data: string; identity: string; hash: string };
type Registration = { root: string; locked: boolean; branch: string | null };

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

  private async run(cwd: string, args: string[], signal?: AbortSignal, options: { env?: NodeJS.ProcessEnv; stdin?: string | Uint8Array; allowed?: number[]; fetch?: boolean; maxBytes?: number; preflight?: () => Promise<void> } = {}): Promise<GitRunResult> {
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
      await options.preflight?.();
      abortIfRequested(signal);
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
    const branchResult = await this.run(root, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'], signal, { allowed: [0, 1] });
    const branchRef = branchResult.exitCode === 0 ? line(branchResult.stdout) : null;
    if (branchRef !== null && !branchRef.startsWith('refs/heads/')) fail('UNSUPPORTED_REF', 'HEAD must identify a local branch or a detached commit.');
    return { root, commonDir, projectSubdir: path.relative(root, project).split(path.sep).join('/'), head: oid(line(headResult.stdout)), branch: branchRef === null ? null : branchRef.slice(11) };
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

  /** One bounded local ref generation; no remote configuration or network commands. */
  async localBranches(repoRoot: string, signal?: AbortSignal): Promise<LocalBranches> {
    const repository = await this.discover(repoRoot, signal);
    const result = await this.run(repository.root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)%00', 'refs/heads/'], signal);
    const output = text(result.stdout);
    if (output && !output.endsWith('\n')) fail('TRUNCATED_OUTPUT', 'The local branch generation was truncated.');
    const branches: LocalBranches['branches'] = []; const seen = new Set<string>();
    for (const row of output ? output.slice(0, -1).split('\n') : []) {
      const parts = row.split('\0');
      if (parts.length !== 5 || parts[4] !== '' || !parts[0]?.startsWith('refs/heads/')) fail('INVALID_GIT_OUTPUT', 'Git returned an invalid local reference.');
      await this.ref(repository.root, parts[0], signal);
      if (parts[2] !== 'commit' || parts[3] !== '') fail('UNSUPPORTED_REF', 'Local branches must directly identify commits, not symbolic refs or other objects.');
      const name = parts[0].slice(11);
      if (name === 'HEAD' || seen.has(name)) fail('UNSUPPORTED_REF', 'The local branch generation contains an ambiguous branch.');
      seen.add(name); branches.push({ name, oid: oid(parts[1]!) });
      if (branches.length > this.config.maxFiles) fail('REF_LIMIT', 'The local branch generation exceeds the configured count limit.');
    }
    const after = await this.discover(repoRoot, signal);
    if (after.root !== repository.root || after.commonDir !== repository.commonDir || after.head !== repository.head || after.branch !== repository.branch) fail('BRANCH_CHANGED', 'HEAD changed during local branch discovery. Reload its first page.');
    if (repository.branch === null) branches.push({ name: 'HEAD', oid: repository.head });
    else if (branches.find(branch => branch.name === repository.branch)?.oid !== repository.head) fail('BRANCH_CHANGED', 'The current branch changed during local branch discovery.');
    if (branches.length > this.config.maxFiles) fail('REF_LIMIT', 'The local branch generation exceeds the configured count limit.');
    return { branchSource: 'local', currentBranch: repository.branch, defaultBranch: repository.branch ?? 'HEAD', branches: branches.sort((a, b) => a.name.localeCompare(b.name)), observedAt: Date.now() };
  }

  /** Safe Local reopening; verifyOnly structurally prohibits every switch path. */
  async switchLocalBranch(sourcePath: string, expectedCommon: string, localBranch: string, localOid: string, signal?: AbortSignal, verifyOnly = false): Promise<CheckoutState> {
    if (!localBranch || localBranch.startsWith('-') || !oidPattern.test(localOid)) fail('INVALID_REF', 'An exact local branch and commit selection are required.');
    const selectedPath = await this.directoryIdentity(sourcePath);
    const source = await this.discover(sourcePath, signal);
    if (source.commonDir !== expectedCommon || path.resolve(expectedCommon) !== expectedCommon) fail('CHECKOUT_IDENTITY_CHANGED', 'The original Local repository identity changed.');
    const rootIdentity = await this.directoryIdentity(source.root); const commonIdentity = await this.directoryIdentity(source.commonDir);
    await this.registered(source, source.root, signal);
    const mappingPath = path.join(source.root, '.git');
    const mapping = async (): Promise<string> => {
      const info = await lstat(mappingPath);
      if (info.isDirectory()) return await this.directoryIdentity(mappingPath);
      const value = await this.metadataIdentity(mappingPath);
      return JSON.stringify([value.identity, value.hash]);
    };
    const mappingIdentity = await mapping();
    const validateIdentity = async (): Promise<RepositoryInfo> => {
      if (await this.directoryIdentity(sourcePath) !== selectedPath || await this.directoryIdentity(source.root) !== rootIdentity || await this.directoryIdentity(source.commonDir) !== commonIdentity || await mapping() !== mappingIdentity) fail('CHECKOUT_IDENTITY_CHANGED', 'The original Local directory or admin mapping changed.');
      const current = await this.identity(source.root, expectedCommon, signal);
      await this.registered(current, source.root, signal);
      return current;
    };
    const selectedRef = localBranch === 'HEAD' ? null : `refs/heads/${localBranch}`;
    const changedCode = verifyOnly ? 'LOCAL_BRANCH_CHANGED' : 'BRANCH_CHANGED';
    const isChosen = (info: Pick<RepositoryInfo, 'head' | 'branch'>): boolean => info.head === localOid && info.branch === (selectedRef === null ? null : localBranch);
    if (verifyOnly && !isChosen(source)) fail('LOCAL_BRANCH_CHANGED', 'The current Local branch or HEAD changed; verification cannot switch it.');
    if (selectedRef === null) {
      // HEAD is the explicit pinned detached option from localBranches, not an
      // invitation to detach an attached branch or follow its latest commit.
      if (source.branch !== null || source.head !== localOid) fail(changedCode, 'The selected detached HEAD changed. Reload the local branch list.');
    } else if (await this.directCommit(source.root, selectedRef, signal) !== localOid) fail(changedCode, 'The selected local branch moved or disappeared. Reload its branch list.');
    if (isChosen(source)) {
      const result = await this.statusRaw(source.root, signal, true);
      if (!isChosen(result.state) || !isChosen(await validateIdentity()) || selectedRef !== null && await this.directCommit(source.root, selectedRef, signal) !== localOid) fail(changedCode, 'The current Local selection changed before reopening.');
      return result.state;
    }
    if (verifyOnly) fail('LOCAL_BRANCH_CHANGED', 'Verification cannot mutate the Local checkout.');
    const ensureSwitchable = async (): Promise<void> => {
      const current = await validateIdentity();
      if (current.head !== source.head || current.branch !== source.branch) fail('BRANCH_CHANGED', 'Local HEAD changed before branch selection.');
      if (selectedRef === null || await this.directCommit(source.root, selectedRef, signal) !== localOid) fail('BRANCH_CHANGED', 'The selected local branch moved before switching.');
      const files = await this.files(source.root, signal);
      if (files.status.state.dirty) fail('LOCAL_DIRTY', 'A different Local branch requires a clean index and working tree.');
      const ignored = nul((await this.run(source.root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], signal)).stdout);
      if (ignored.length) fail('LOCAL_DIRTY', 'A different Local branch cannot overwrite or carry ignored files.');
      await this.removalPaths(source.root, false, signal);
      const targetEntries = await this.tree(source.root, localOid, signal);
      if (source.projectSubdir && !targetEntries.some(entry => entry.path.startsWith(`${source.projectSubdir}/`))) fail('PROJECT_SUBDIR_MISSING', 'The chosen branch does not contain the original selected Local folder. No branch was switched.');
      for (const entry of targetEntries.filter(value => value.mode === '120000')) {
        const target = text((await this.run(source.root, ['cat-file', 'blob', entry.oid], signal)).stdout);
        if (!target || path.isAbsolute(target) || !inside(source.root, path.resolve(source.root, path.dirname(entry.path), target))) fail('UNSAFE_SYMLINK', 'The selected Local tree contains an escaping symlink.');
      }
      for (const registration of await this.registrations(source.root, signal)) if (registration.branch === selectedRef && path.resolve(registration.root) !== source.root) fail('BRANCH_IN_USE', 'The selected branch is already checked out elsewhere.');
    };
    await ensureSwitchable();
    await ensureSwitchable();
    abortIfRequested(signal);
    this.authorize();
    try {
      // --no-track implies new-branch creation in Git's switch parser, even for
      // existing slash names. --no-guess switches only the existing exact branch.
      await this.run(source.root, ['switch', '--no-overwrite-ignore', '--no-guess', '--', localBranch], signal, { preflight: ensureSwitchable });
      const after = await validateIdentity();
      const result = await this.status(source.root, signal);
      if (!isChosen(after) || result.head !== localOid || result.branch !== localBranch || result.dirty || await this.directCommit(source.root, selectedRef!, signal) !== localOid) fail('LOCAL_SWITCH_RECOVERY_REQUIRED', 'The Local branch switch result changed.');
      return result;
    } catch (error) {
      throw new WorktreeError('LOCAL_SWITCH_RECOVERY_REQUIRED', 'Local branch switching may have begun; inspect it before recovery. No reset, stash or rollback was attempted.', { targetMayHaveChanged: true, causeCode: error instanceof WorktreeError ? error.code : 'GIT_FAILED' });
    }
  }

  private async localBase(repository: RepositoryInfo, input: Extract<CreateCheckoutInput, { branchSource: 'local' }>): Promise<string> {
    const { signal, localBranch, localOid } = input;
    if (!localBranch || localBranch.startsWith('-')) fail('INVALID_REF', 'The selected local branch name is invalid.');
    if (localOid !== undefined && !oidPattern.test(localOid)) fail('INVALID_REF', 'The selected local commit identity is invalid.');
    const ref = localBranch === 'HEAD' ? 'HEAD' : `refs/heads/${localBranch}`;
    if (localBranch === 'HEAD') {
      if (localOid === undefined) fail('INVALID_REF', 'Detached HEAD creation requires an expected local commit.');
      if (repository.branch !== null) fail('BRANCH_CHANGED', 'HEAD is no longer detached. Reload the local branch list.');
    } else await this.ref(repository.root, ref, signal);
    const symbolic = await this.run(repository.root, ['symbolic-ref', '--quiet', ref], signal, { allowed: [0, 1] });
    if (symbolic.exitCode === 0) fail('UNSUPPORTED_REF', 'The selected local reference must directly identify a commit.');
    const resolved = await this.run(repository.root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], signal, { allowed: [0, 128] });
    if (resolved.exitCode !== 0) fail('LOCAL_BRANCH_NOT_FOUND', 'The selected local branch has no commit.');
    const baseOid = oid(line(resolved.stdout));
    const direct = oid(line((await this.run(repository.root, ['rev-parse', '--verify', '--end-of-options', ref], signal)).stdout));
    if (direct !== baseOid) fail('UNSUPPORTED_REF', 'The selected local branch must directly identify a commit.');
    if (localOid !== undefined && localOid !== baseOid) fail('BRANCH_CHANGED', 'The selected local branch moved. Reload its branch list.');
    // Compare the source under its ref lock and create (never overwrite/dereference)
    // the managed base in the same transaction. No source ref/index/file is changed.
    const pin = await this.run(repository.root, ['update-ref', '--no-deref', '--stdin'], signal, {
      stdin: `start\nverify ${ref} ${baseOid}\ncreate ${input.baseRef} ${baseOid}\nprepare\ncommit\n`, allowed: [0, 128],
    });
    if (pin.exitCode !== 0) fail('BRANCH_CHANGED', 'The local branch or managed base changed before pinning; no checkout was created.');
    // Git's no-deref verify may still compare a symbolic ref's resolved OID.
    // Reject replacement explicitly before any checkout, retaining the exact base
    // as a recovery receipt rather than ever writing through the source reference.
    const after = await this.run(repository.root, ['symbolic-ref', '--quiet', ref], signal, { allowed: [0, 1] });
    if (after.exitCode === 0) fail('BRANCH_CHANGED', 'The selected local branch became symbolic during pinning; the exact base may remain but no checkout was created.', { refsMayHaveChanged: true });
    return baseOid;
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
    await this.ref(repository.root, input.baseRef, signal);
    if (!input.baseRef.startsWith('refs/dsh-worktrees/')) fail('INVALID_REF', 'The persistent base ref must use the managed worktree namespace.');
    const prior = await this.run(repository.root, ['show-ref', '--verify', '--quiet', input.baseRef], signal, { allowed: [0, 1] });
    if (prior.exitCode === 0) fail('BASE_REF_EXISTS', 'The persistent base reference is already in use.');
    let baseOid: string;
    if (input.branchSource === 'local') {
      if (input.remote !== undefined || input.remoteIdentity !== undefined || input.remoteBranch !== undefined) fail('INVALID_REQUEST', 'Local source does not accept remote fields.');
      baseOid = await this.localBase(repository, input);
    } else {
      if (input.branchSource !== undefined && input.branchSource !== 'remote') fail('INVALID_REQUEST', 'The branch source is invalid.');
      if (input.localBranch !== undefined || input.localOid !== undefined) fail('INVALID_REQUEST', 'Remote source does not accept local fields.');
      if (!input.remoteBranch || input.remoteBranch.startsWith('-')) fail('INVALID_REF', 'The selected branch name is invalid.');
      await this.ref(repository.root, `refs/heads/${input.remoteBranch}`, signal);
      await this.ref(repository.root, `refs/remotes/${input.remote}/${input.remoteBranch}`, signal);
      const remote = await this.remote(repository.root, input.remote, signal);
      if (remote.identity !== input.remoteIdentity) fail('REMOTE_CHANGED', 'The selected remote identity has changed.');
      checkoutProgress(input, 'fetching');
      await this.run(repository.root, ['fetch', '--atomic', '--refmap=', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-commit-graph', '--no-prune', '--upload-pack=git-upload-pack', '--', input.remote, `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remote}/${input.remoteBranch}`, `refs/heads/${input.remoteBranch}:${input.baseRef}`], signal, { fetch: true });
      if ((await this.remote(repository.root, input.remote, signal)).identity !== remote.identity) fail('REMOTE_CHANGED', 'The remote changed during fetch; fetched refs may remain.', { refsMayHaveChanged: true });
      baseOid = oid(line((await this.run(repository.root, ['rev-parse', '--verify', `${input.baseRef}^{commit}`], signal)).stdout));
    }
    const entries = await this.tree(repository.root, baseOid, signal);
    if (repository.projectSubdir && !entries.some(entry => entry.path.startsWith(`${repository.projectSubdir}/`))) fail('PROJECT_SUBDIR_MISSING', 'The project subdirectory is absent from the selected base tree.');
    // Attribute validation uses an isolated index and object store, never the source index.
    const privateStore = await this.store(path.dirname(destination), repository.commonDir);
    try {
      await this.run(repository.root, ['read-tree', baseOid], signal, { env: privateStore.env });
      await this.attributes(repository.root, entries.map(entry => entry.path), signal, privateStore.env, true);
      for (const entry of entries.filter(value => value.mode === '120000')) {
        const target = text((await this.run(repository.root, ['cat-file', 'blob', entry.oid], signal)).stdout);
        if (!target || path.isAbsolute(target) || !inside(destination, path.resolve(destination, path.dirname(entry.path), target))) fail('UNSAFE_SYMLINK', 'The selected base tree contains an escaping symlink.');
      }
    } finally { await this.removeStore(privateStore); }
    checkoutProgress(input, 'creating');
    try {
      await this.run(repository.root, ['worktree', 'add', '--detach', '--', destination, baseOid], signal);
      const checkoutRoot = await realpath(destination);
      const effectiveCwd = await realpath(path.join(checkoutRoot, repository.projectSubdir)).catch(() => fail('PROJECT_SUBDIR_MISSING', 'The selected base project directory is unavailable.'));
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

  private statIdentity(info: { dev: bigint; ino: bigint; birthtimeNs: bigint; mode: bigint }): string {
    // Lossless identity evidence; mutable directory timestamps deliberately are not
    // authority. Filesystems without inode identities are unsupported for cleanup.
    if (info.ino === 0n) fail('CHECKOUT_IDENTITY_CHANGED', 'The filesystem does not provide stable identity evidence.');
    return JSON.stringify([String(info.dev), String(info.ino), String(info.birthtimeNs), String(info.mode)]);
  }

  private async directoryIdentity(directory: string): Promise<string> {
    if (path.resolve(directory) !== directory || await realpath(directory) !== directory) fail('CHECKOUT_IDENTITY_CHANGED', 'A repository directory is not canonical.');
    const info = await lstat(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail('CHECKOUT_IDENTITY_CHANGED', 'A repository directory identity changed.');
    return this.statIdentity(info);
  }

  private async metadataIdentity(file: string): Promise<MetadataIdentity> {
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(this.config.maxRefBytes)) fail('CHECKOUT_IDENTITY_CHANGED', 'Git admin metadata is not a bounded ordinary file.');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (this.statIdentity(opened) !== this.statIdentity(info) || !opened.isFile()) fail('CHECKOUT_IDENTITY_CHANGED', 'Git admin metadata was replaced while opening.');
      const buffer = Buffer.alloc(Math.min(this.config.maxRefBytes + 1, Number(opened.size) + 1));
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const current = await lstat(file, { bigint: true });
      if (this.statIdentity(current) !== this.statIdentity(opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || BigInt(length) !== opened.size) fail('CHECKOUT_IDENTITY_CHANGED', 'Git admin metadata changed while reading.');
      if (length > this.config.maxRefBytes) fail('OUTPUT_LIMIT', 'Git admin metadata exceeds the configured byte limit.');
      const data = buffer.subarray(0, length);
      return { data: text(data), identity: this.statIdentity(opened), hash: hash(data) };
    } finally { await handle.close(); }
  }

  private async metadata(file: string): Promise<string> { return (await this.metadataIdentity(file)).data; }

  private async registrations(root: string, signal?: AbortSignal): Promise<Registration[]> {
    const rows = nul((await this.run(root, ['worktree', 'list', '--porcelain', '-z'], signal)).stdout);
    const output: Registration[] = [];
    for (const row of rows) {
      if (row.startsWith('worktree ')) output.push({ root: row.slice(9), locked: false, branch: null });
      else if (row.startsWith('branch ')) {
        const registration = output[output.length - 1];
        if (!registration || !row.slice(7).startsWith('refs/heads/')) fail('INVALID_GIT_OUTPUT', 'Git returned an invalid worktree branch registration.');
        registration.branch = row.slice(7);
      } else if (row === 'locked' || row.startsWith('locked ')) {
        const registration = output[output.length - 1];
        if (!registration) fail('INVALID_GIT_OUTPUT', 'Git returned an invalid worktree registration.');
        registration.locked = true;
      }
    }
    if (output.length > this.config.maxFiles) fail('FILE_LIMIT', 'Git worktree registrations exceed the configured limit.');
    return output;
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
    const roots = (await this.registrations(repositoryRoot, signal)).map(value => value.root);
    // Git reports these machine-formatted, so a raw comparison against the canonical
    // root fails wherever the two forms differ: Windows mixes separators and may
    // report a short name, and a symlinked ancestor appears in one form only. Match
    // canonically, and leave an entry that cannot be resolved unmatched rather than
    // turning a stale registration into a failure to enumerate.
    const matches = await Promise.all(roots.map(async value => {
      const canonical = await realpath(value).catch(() => undefined);
      return canonical === undefined ? value === info.root : canonical === info.root;
    }));
    if (matches.filter(Boolean).length !== 1) fail('CHECKOUT_IDENTITY_CHANGED', 'The checkout is not uniquely registered with its source repository.');
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

  private async exists(target: string): Promise<boolean> {
    return lstat(target).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
  }

  private async directCommit(root: string, ref: string, signal?: AbortSignal): Promise<string | null> {
    await this.ref(root, ref, signal);
    const symbolic = await this.run(root, ['symbolic-ref', '--quiet', ref], signal, { allowed: [0, 1] });
    if (symbolic.exitCode === 0) fail('UNSUPPORTED_REF', 'A retained reference must directly identify a commit.');
    const result = await this.run(root, ['rev-parse', '--verify', '--end-of-options', ref], signal, { allowed: [0, 128] });
    if (result.exitCode !== 0) return null;
    const value = oid(line(result.stdout));
    if (line((await this.run(root, ['cat-file', '-t', value], signal)).stdout) !== 'commit') fail('UNSUPPORTED_REF', 'A retained reference must identify a commit.');
    return value;
  }

  private async removalBase(record: WorktreeRecord, sourceRoot: string, signal?: AbortSignal): Promise<void> {
    if (record.baseRef !== `refs/dsh-worktrees/${record.id}/base` || !oidPattern.test(record.baseOid)) fail('BASE_CHANGED', 'The managed base reference does not match the exact recorded namespace.');
    if (await this.directCommit(sourceRoot, record.baseRef, signal) !== record.baseOid) fail('BASE_CHANGED', 'The exact managed base reference changed.');
  }

  /** Bounded physical traversal. Never follow checkout-controlled symlinks. */
  private async removalPaths(root: string, admin: boolean, signal?: AbortSignal): Promise<string[]> {
    const files: string[] = []; let count = 0;
    const visit = async (directory: string): Promise<void> => {
      abortIfRequested(signal);
      const before = await this.directoryIdentity(directory);
      const handle = await opendir(directory);
      for await (const entry of handle) {
        abortIfRequested(signal);
        if (++count > this.config.maxFiles) fail('FILE_LIMIT', 'Removal inspection exceeds the configured path count limit.');
        const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (admin && (entry.name === 'locked' || entry.name.endsWith('.lock'))) fail('WORKTREE_LOCKED', 'A worktree registration or admin operation is locked.');
        if (!admin && relative === '.git') continue;
        if (!admin && entry.name.toLowerCase() === '.git') fail('UNSUPPORTED_CHECKOUT', 'Nested repositories cannot be removed automatically.');
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          if (admin) fail('CHECKOUT_IDENTITY_CHANGED', 'Worktree admin paths cannot be symlinked.');
          continue; // Git removal unlinks, rather than follows, a working-tree symlink.
        }
        if (info.isDirectory()) {
          if (admin && ['rebase-merge', 'rebase-apply', 'sequencer'].includes(entry.name)) fail('UNSUPPORTED_CHECKOUT', 'An in-progress private history operation must be recovered before cleanup.');
          if (!admin && await this.exists(path.join(absolute, 'HEAD')) && await this.exists(path.join(absolute, 'objects')) && await this.exists(path.join(absolute, 'refs'))) fail('UNSUPPORTED_CHECKOUT', 'Nested bare repositories cannot be removed automatically.');
          await visit(absolute);
        } else if (!info.isFile()) fail('UNSUPPORTED_CHECKOUT', 'Special filesystem entries cannot be removed automatically.');
        else files.push(relative);
      }
      if (await this.directoryIdentity(directory) !== before) fail('CHECKOUT_IDENTITY_CHANGED', 'A inspected directory was replaced.');
    };
    await visit(root);
    return files.sort();
  }

  private async removalPrivate(root: string, admin: string, head: string, signal?: AbortSignal): Promise<{ privateStateHash: string; retainedHeads: string[] }> {
    const files = await this.removalPaths(admin, true, signal); const retained = new Set<string>([head]);
    const digest = createHash('sha256'); let bytes = 0;
    for (const file of files) {
      // AUTO_MERGE trees and the real index are unsaved recovery state, not commit
      // heads. Explicit dirty/conflicted cleanup authorization permits their loss.
      if (!file.startsWith('refs/') && !file.startsWith('logs/') && !['ORIG_HEAD', 'MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'FETCH_HEAD'].includes(file)) continue;
      const observed = await this.metadataIdentity(path.join(admin, file));
      bytes += Buffer.byteLength(observed.data);
      if (bytes > this.config.maxRefBytes) fail('OUTPUT_LIMIT', 'Private worktree history exceeds the configured byte bound.');
      digest.update(JSON.stringify([file, observed.identity, observed.hash]));
      if (observed.data && !observed.data.endsWith('\n')) fail('UNSUPPORTED_CHECKOUT', 'Private worktree history is incomplete.');
      for (const row of observed.data ? observed.data.slice(0, -1).split('\n') : []) {
        const values = file.startsWith('logs/') ? row.split(' ').slice(0, 2) : file === 'FETCH_HEAD' ? [row.split('\t')[0]!] : [row];
        if (file.startsWith('logs/') && values.length !== 2) fail('UNSUPPORTED_CHECKOUT', 'Private reflog history is unsupported.');
        for (const value of values) {
          if (/^(?:0{40}|0{64})$/u.test(value)) continue;
          if (!oidPattern.test(value)) fail('UNSUPPORTED_CHECKOUT', 'Private symbolic or unsupported history prevents automatic cleanup.');
          retained.add(value);
        }
        if (retained.size > this.config.maxFiles) fail('REF_LIMIT', 'Private commit history exceeds the configured count bound.');
      }
    }
    for (const value of retained) if (line((await this.run(root, ['cat-file', '-t', value], signal)).stdout) !== 'commit') fail('UNSUPPORTED_CHECKOUT', 'Private worktree history contains a noncommit object.');
    return { privateStateHash: digest.digest('hex'), retainedHeads: [...retained].sort() };
  }

  private sameRemoval(expected: RemovalIdentity, actual: RemovalIdentity): void {
    for (const key of Object.keys(actual) as (keyof RemovalIdentity)[]) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) fail(key === 'head' || key === 'branch' ? 'HEAD_CHANGED' : 'CHECKOUT_IDENTITY_CHANGED', 'The inspected removal identity changed; no checkout was deleted.');
    }
  }

  /** Dirty, missing project subdirectories and conflicted indexes are allowed. */
  async inspectRemoval(record: WorktreeRecord, sourceRoot: string, signal?: AbortSignal): Promise<RemovalIdentity> {
    try {
      const checkoutIdentity = await this.directoryIdentity(record.checkoutRoot);
      const managedRoot = await realpath(path.resolve(this.config.root));
      if (managedRoot !== path.resolve(this.config.root) || record.checkoutRoot === managedRoot || !inside(managedRoot, record.checkoutRoot)) fail('CHECKOUT_IDENTITY_CHANGED', 'The checkout is outside the configured canonical managed root.');
      const sourceIdentity = await this.directoryIdentity(sourceRoot);
      const commonIdentity = await this.directoryIdentity(record.commonDir);
      if (inside(sourceRoot, record.checkoutRoot) || inside(record.checkoutRoot, sourceRoot) || inside(record.checkoutRoot, record.commonDir) || inside(record.commonDir, record.checkoutRoot)) fail('CHECKOUT_IDENTITY_CHANGED', 'Source, object storage and managed checkout paths must be distinct and unnested.');
      const pointer = await this.metadataIdentity(path.join(record.checkoutRoot, '.git'));
      const source = await this.identity(sourceRoot, record.commonDir, signal);
      const info = await this.identity(record.checkoutRoot, record.commonDir, signal);
      await this.registered(source, sourceRoot, signal);
      await this.registered(info, sourceRoot, signal);
      if (!pointer.data.startsWith('gitdir: ') || !pointer.data.endsWith('\n') || /[\0\r\n]/u.test(pointer.data.slice(8, -1))) fail('CHECKOUT_IDENTITY_CHANGED', 'The managed .git pointer is invalid.');
      const adminDir = path.resolve(info.root, pointer.data.slice(8, -1));
      const adminIdentity = await this.directoryIdentity(adminDir);
      // Git for Windows emits forward slashes; normalize native path syntax without
      // resolving filesystem aliases or relaxing the canonical directory identity above.
      const reportedAdmin = path.normalize(line((await this.run(info.root, ['rev-parse', '--absolute-git-dir'], signal)).stdout));
      if (path.dirname(adminDir) !== path.join(info.commonDir, 'worktrees') || reportedAdmin !== adminDir) fail('CHECKOUT_IDENTITY_CHANGED', 'The worktree admin identity changed.');
      const backlink = await this.metadataIdentity(path.join(adminDir, 'gitdir'));
      const commonPointer = await this.metadataIdentity(path.join(adminDir, 'commondir'));
      for (const value of [backlink.data, commonPointer.data]) if (!value.endsWith('\n') || /[\0\r\n]/u.test(value.slice(0, -1))) fail('CHECKOUT_IDENTITY_CHANGED', 'The worktree admin mapping is invalid.');
      if (path.resolve(adminDir, backlink.data.slice(0, -1)) !== path.join(info.root, '.git') || path.resolve(adminDir, commonPointer.data.slice(0, -1)) !== info.commonDir) fail('CHECKOUT_IDENTITY_CHANGED', 'The exact admin backlink or common directory changed.');
      const registrations = await this.registrations(sourceRoot, signal);
      const matches = registrations.filter(value => path.resolve(value.root) === info.root);
      if (matches.length !== 1) fail('CHECKOUT_IDENTITY_CHANGED', 'The exact managed root is not uniquely registered.');
      if (matches[0]!.locked) fail('WORKTREE_LOCKED', 'Locked registrations cannot be removed automatically.');
      await this.removalBase(record, sourceRoot, signal);
      if (info.branch !== null && await this.directCommit(info.root, `refs/heads/${info.branch}`, signal) !== info.head) fail('HEAD_CHANGED', 'The current worktree branch changed or is unsupported.');
      // Common ref/config locks also indicate native Git maintenance, even when
      // no managed Agent is live. Never remove through a concurrent ref update.
      const commonEntries = await opendir(info.commonDir);
      let commonCount = 0;
      for await (const entry of commonEntries) {
        if (++commonCount > this.config.maxFiles) fail('FILE_LIMIT', 'Common admin inspection exceeds its count bound.');
        if (entry.name.endsWith('.lock')) fail('WORKTREE_LOCKED', 'Shared Git admin maintenance is locked.');
      }
      if (await this.exists(path.join(info.commonDir, 'refs'))) await this.removalPaths(path.join(info.commonDir, 'refs'), true, signal);
      await this.tree(info.root, info.head, signal);
      const index = nul((await this.run(info.root, ['ls-files', '--stage', '-z'], signal)).stdout);
      if (index.length > this.config.maxFiles) fail('FILE_LIMIT', 'The index exceeds the configured entry count bound.');
      for (const entry of index) {
        const tab = entry.indexOf('\t');
        if (tab < 0 || !/^(?:100644|100755|120000) [a-f0-9]{40}(?:[a-f0-9]{24})? [0-3]$/u.test(entry.slice(0, tab))) fail('UNSUPPORTED_CHECKOUT', 'Submodules or unsupported index entries prevent automatic cleanup.');
        validPath(entry.slice(tab + 1));
      }
      await this.removalPaths(info.root, false, signal);
      const privateState = await this.removalPrivate(info.root, adminDir, info.head, signal);
      const sourceMappingPath = path.join(sourceRoot, '.git'); const sourceMapping = await lstat(sourceMappingPath);
      const sourceMappingEvidence = sourceMapping.isDirectory() ? { identity: await this.directoryIdentity(sourceMappingPath), hash: '' } : await this.metadataIdentity(sourceMappingPath);
      const sourceMappingIdentity = sourceMappingEvidence.identity; const sourceMappingHash = sourceMappingEvidence.hash;
      const result: RemovalIdentity = { checkoutRoot: info.root, sourceRoot, commonDir: info.commonDir, adminDir, head: info.head, branch: info.branch, checkoutIdentity, sourceIdentity, commonIdentity, adminIdentity, pointerIdentity: pointer.identity, pointerHash: pointer.hash, backlinkIdentity: backlink.identity, backlinkHash: backlink.hash, commonPointerIdentity: commonPointer.identity, commonPointerHash: commonPointer.hash, sourceMappingIdentity, sourceMappingHash, ...privateState };
      const after = await this.identity(info.root, record.commonDir, signal);
      if (after.head !== result.head || after.branch !== result.branch) fail('HEAD_CHANGED', 'HEAD changed during removal inspection.');
      if (await this.directoryIdentity(info.root) !== checkoutIdentity || await this.directoryIdentity(sourceRoot) !== sourceIdentity || await this.directoryIdentity(record.commonDir) !== commonIdentity || await this.directoryIdentity(adminDir) !== adminIdentity) fail('CHECKOUT_IDENTITY_CHANGED', 'Directory identity changed during inspection.');
      for (const [file, expected] of [[path.join(info.root, '.git'), pointer], [path.join(adminDir, 'gitdir'), backlink], [path.join(adminDir, 'commondir'), commonPointer]] as [string, MetadataIdentity][]) {
        const observed = await this.metadataIdentity(file);
        if (observed.identity !== expected.identity || observed.hash !== expected.hash) fail('CHECKOUT_IDENTITY_CHANGED', 'Admin pointer identity changed during inspection.');
      }
      const finalSourceMapping = sourceMapping.isDirectory() ? { identity: await this.directoryIdentity(sourceMappingPath), hash: '' } : await this.metadataIdentity(sourceMappingPath);
      if (finalSourceMapping.identity !== sourceMappingIdentity || finalSourceMapping.hash !== sourceMappingHash) fail('CHECKOUT_IDENTITY_CHANGED', 'The original Local admin mapping changed during inspection.');
      return result;
    } catch (error) {
      if (error instanceof WorktreeError) throw error;
      abortIfRequested(signal);
      throw new WorktreeError('CHECKOUT_IDENTITY_CHANGED', 'Removal inspection could not verify the managed identity. No checkout was deleted.');
    }
  }

  private rescueRefs(record: WorktreeRecord, identity: RemovalIdentity): [string, string][] {
    return [[`refs/dsh-worktrees/${record.id}/gc-head`, identity.head], ...identity.retainedHeads.filter(value => value !== identity.head).map(value => [`refs/dsh-worktrees/${record.id}/gc-retained/${value}`, value] as [string, string])];
  }

  /** Retain final HEAD and bounded private reflog/ref commits, never unsaved file backups. */
  async preserveRemovalHead(record: WorktreeRecord, identity: RemovalIdentity, signal?: AbortSignal): Promise<string> {
    this.sameRemoval(identity, await this.inspectRemoval(record, identity.sourceRoot, signal));
    const refs = this.rescueRefs(record, identity); const instructions: string[] = [];
    for (const [ref, value] of refs) {
      const existing = await this.directCommit(identity.sourceRoot, ref, signal);
      if (existing !== null && existing !== value) fail('RESCUE_REF_CHANGED', 'The deterministic rescue reference already identifies a different commit.');
      instructions.push(`${existing === null ? 'create' : 'verify'} ${ref} ${value}`);
    }
    this.sameRemoval(identity, await this.inspectRemoval(record, identity.sourceRoot, signal));
    let result: GitRunResult;
    try {
      // Git locks HEAD's referent during verify even with --no-deref; verifying
      // the attached branch again would be a forbidden duplicate update. The
      // exact symbolic branch is checked in preflight and again after commit.
      result = await this.run(identity.checkoutRoot, ['update-ref', '--no-deref', '--stdin'], signal, {
        stdin: `start\nverify HEAD ${identity.head}\nverify ${record.baseRef} ${record.baseOid}\n${instructions.join('\n')}\nprepare\ncommit\n`, allowed: [0, 128],
        preflight: async () => this.sameRemoval(identity, await this.inspectRemoval(record, identity.sourceRoot, signal)),
      });
    } catch (error) {
      throw new WorktreeError('REMOVAL_RECOVERY_REQUIRED', 'Commit preservation may have begun; verify the exact rescue refs before recovery. No checkout was deleted.', { refsMayHaveChanged: true, causeCode: error instanceof WorktreeError ? error.code : 'GIT_FAILED' });
    }
    if (result.exitCode !== 0) fail('HEAD_CHANGED', 'HEAD, base or rescue refs changed before commit preservation.');
    try {
      this.sameRemoval(identity, await this.inspectRemoval(record, identity.sourceRoot, signal));
      await this.preservedRemoval(record, identity, signal);
    } catch (error) { throw new WorktreeError('REMOVAL_RECOVERY_REQUIRED', 'Commit preservation requires inspection; no checkout was deleted.', { refsMayHaveChanged: true, causeCode: error instanceof WorktreeError ? error.code : 'GIT_FAILED' }); }
    return refs[0]![0];
  }

  private async preservedRemoval(record: WorktreeRecord, identity: RemovalIdentity, signal?: AbortSignal): Promise<void> {
    for (const [ref, value] of this.rescueRefs(record, identity)) if (await this.directCommit(identity.sourceRoot, ref, signal) !== value) fail('RESCUE_REF_CHANGED', 'The exact preserved commit reference is missing or changed.');
  }

  /** Caller journals before entry and owns live-agent, repository and idle claims. */
  async removeManagedCheckout(record: WorktreeRecord, identity: RemovalIdentity, signal?: AbortSignal): Promise<void> {
    this.sameRemoval(identity, await this.inspectRemoval(record, identity.sourceRoot, signal));
    await this.preservedRemoval(record, identity, signal);
    this.sameRemoval(identity, await this.inspectRemoval(record, identity.sourceRoot, signal));
    abortIfRequested(signal);
    this.authorize();
    try {
      await this.run(identity.sourceRoot, ['worktree', 'remove', '--force', '--', identity.checkoutRoot], signal, { preflight: async () => {
        await this.preservedRemoval(record, identity, signal);
        this.sameRemoval(identity, await this.inspectRemoval(record, identity.sourceRoot, signal));
      } });
      if (await this.removalState(record, identity.sourceRoot, identity, signal) !== 'absent') fail('REMOVAL_RECOVERY_REQUIRED', 'Removal did not confirm both checkout and exact registration absent.');
    } catch (error) {
      throw new WorktreeError('REMOVAL_RECOVERY_REQUIRED', 'Checkout removal may have begun; reconcile the exact directory and registration before recovery. No prune or broad deletion was attempted.', { checkoutMayHaveChanged: true, causeCode: error instanceof WorktreeError ? error.code : 'GIT_FAILED' });
    }
  }

  /** Read-only, conservative reconciliation; never repairs, prunes or retries deletion. */
  async removalState(record: WorktreeRecord, sourceRoot: string, identity?: RemovalIdentity, signal?: AbortSignal): Promise<RemovalState> {
    try {
      const source = await this.identity(sourceRoot, record.commonDir, signal);
      await this.registered(source, sourceRoot, signal);
      await this.removalBase(record, sourceRoot, signal);
      if (identity) {
        const mapping = path.join(sourceRoot, '.git'); const info = await lstat(mapping);
        const evidence = info.isDirectory() ? { identity: await this.directoryIdentity(mapping), hash: '' } : await this.metadataIdentity(mapping);
        if (identity.sourceRoot !== sourceRoot || identity.checkoutRoot !== record.checkoutRoot || identity.commonDir !== record.commonDir || await this.directoryIdentity(sourceRoot) !== identity.sourceIdentity || await this.directoryIdentity(record.commonDir) !== identity.commonIdentity || evidence.identity !== identity.sourceMappingIdentity || evidence.hash !== identity.sourceMappingHash || path.dirname(identity.adminDir) !== path.join(record.commonDir, 'worktrees')) return 'replaced';
      }
      const directory = await this.exists(record.checkoutRoot);
      const registrations = (await this.registrations(sourceRoot, signal)).filter(value => path.resolve(value.root) === record.checkoutRoot);
      const admin = identity ? await this.exists(identity.adminDir) : true;
      if (!directory && registrations.length === 0 && !admin) {
        if (identity) await this.preservedRemoval(record, identity, signal);
        return 'absent';
      }
      if (!directory || registrations.length !== 1 || !admin) return 'partial';
      if (identity && (await this.directoryIdentity(record.checkoutRoot) !== identity.checkoutIdentity || await this.directoryIdentity(identity.adminDir) !== identity.adminIdentity)) return 'replaced';
      const fresh = await this.inspectRemoval(record, sourceRoot, signal);
      if (identity) this.sameRemoval(identity, fresh);
      return 'present';
    } catch (error) {
      abortIfRequested(signal);
      if (error instanceof WorktreeError && ['CHECKOUT_IDENTITY_CHANGED', 'HEAD_CHANGED', 'BASE_CHANGED', 'UNSUPPORTED_REF', 'RESCUE_REF_CHANGED'].includes(error.code)) return 'replaced';
      return 'partial';
    }
  }

  private async statusRaw(root: string, signal?: AbortSignal, allowUnmerged = false): Promise<Status> {
    const result = await this.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], signal);
    const rows = nul(result.stdout); const paths: string[] = []; let changes = 0; let untracked = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (row.length < 4 || row[2] !== ' ') fail('INVALID_GIT_OUTPUT', 'Git status returned an invalid record.');
      const code = row.slice(0, 2); const file = row.slice(3); validPath(file); paths.push(file);
      if (!allowUnmerged && (code.includes('U') || ['AA', 'DD'].includes(code))) fail('UNMERGED_CHECKOUT', 'Unmerged files are not supported.');
      if (code === '??') untracked++; else changes++;
      if (/[RC]/u.test(code)) { const original = rows[++index]; if (!original) fail('TRUNCATED_OUTPUT', 'Git status returned an incomplete rename.'); validPath(original); paths.push(original); }
    }
    if (changes + untracked > this.config.maxFiles) fail('FILE_LIMIT', 'Git status exceeds the configured file count limit.');
    const head = oid(line((await this.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).stdout));
    const branch = await this.run(root, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'], signal, { allowed: [0, 1] });
    const branchRef = branch.exitCode === 0 ? line(branch.stdout) : null;
    if (branchRef !== null && !branchRef.startsWith('refs/heads/')) fail('UNSUPPORTED_REF', 'HEAD must identify an exact local branch or detached commit.');
    return { state: { head, branch: branchRef === null ? null : branchRef.slice(11), dirty: changes + untracked > 0, changes, untracked }, raw: result.stdout, paths };
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
      await this.attributes(source.root, finalEntries.map(entry => entry.path), signal, privateStore.env, true);
      const files = await this.patchFiles(source.root, input.baseOid, finalTree, privateStore, signal);
      for (const file of files) {
        const original = file.status.startsWith('R') ? file.status.slice(file.status.indexOf(':') + 1) : file.path;
        if (symlinks.has(file.path) || symlinks.has(original)) fail('UNSAFE_SYMLINK', 'Changed symlinks are not supported by handoff snapshots.');
      }
      // Refuse changed symlinks before comparing native readlink bytes with Git blobs:
      // Windows normalizes link separators, but these changes are unsupported either way.
      // Supported files must still match their exact working bytes and modes.
      await this.exactContents(source.root, finalEntries, sourceFiles.paths, signal);
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
