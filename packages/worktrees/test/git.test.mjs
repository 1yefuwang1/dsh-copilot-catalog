import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitOperations } from '../dist/git.js';
import { tempDirectory } from './helpers.mjs';

/** Test-only native runner. Every operation is bounded and confined to this fixture's own repos. */
function executor(owned, calls = []) {
  return async spec => {
    const cwd = await realpath(spec.cwd);
    assert.ok(cwd === owned || cwd.startsWith(`${owned}${path.sep}`), 'native test executor only accepts fixture-owned cwd');
    calls.push(spec);
    const env = { ...process.env };
    for (const [key, value] of Object.entries(spec.env ?? {})) { if (value === undefined) delete env[key]; else env[key] = value; }
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...spec.args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = []; const stderr = []; let bytes = 0; let terminalError;
      const timer = setTimeout(() => { terminalError = new Error('deadline exceeded'); child.kill('SIGKILL'); }, spec.timeoutMs ?? 5000);
      const abort = () => { terminalError = new Error('aborted'); child.kill('SIGKILL'); };
      spec.signal?.addEventListener('abort', abort, { once: true });
      if (spec.signal?.aborted) abort();
      const collect = target => chunk => { bytes += chunk.length; if (bytes > (spec.maxBytes ?? 1024 * 1024)) { terminalError = new Error('output limit'); child.kill('SIGKILL'); } else target.push(chunk); };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
      child.on('error', error => { terminalError = error; });
      child.on('close', code => {
        clearTimeout(timer); spec.signal?.removeEventListener('abort', abort);
        if (terminalError) return reject(terminalError);
        if (!(spec.allowedExitCodes ?? [0]).includes(code)) return reject(new Error(`Git exit ${code}: ${Buffer.concat(stderr)}`));
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(spec.stdin);
    });
  };
}

async function fixture(t, caps = {}) {
  const root = await tempDirectory('worktrees-engine-test-');
  t.after(async () => {
    assert.equal(path.resolve(root), root);
    assert.equal(await realpath(root), root);
    assert.ok(path.basename(root).startsWith('worktrees-engine-test-'));
    await rm(root, { recursive: true, force: false });
  });
  const calls = []; const exec = executor(root, calls);
  const git = async (cwd, ...args) => (await exec({ cwd, args: ['-c', 'user.name=Test User', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], timeoutMs: 10000, maxBytes: 4 * 1024 * 1024 })).stdout;
  const remote = path.join(root, 'remote.git'); const seed = path.join(root, 'seed'); const local = path.join(root, 'local');
  await mkdir(seed); await git(seed, 'init', '-b', 'topic/full/name');
  await mkdir(path.join(seed, 'project')); await writeFile(path.join(seed, 'project', 'file.txt'), 'base\n');
  await writeFile(path.join(seed, '.gitignore'), 'ignored-*\n');
  // The source pins the setting before its first add, so the blob cannot inherit a
  // CRLF store from the machine's git configuration.
  await git(seed, 'config', 'core.autocrlf', 'false');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'base');
  // Line endings must not depend on the machine's git config. A Windows runner can
  // materialise the clone with endings that differ from the committed blob, and a
  // freshly cloned target then reads as modified — which the engine's cleanliness
  // gate correctly refuses, far away from the cause. Pin the setting for the source
  // before cloning, and re-materialise the clone's working tree so the fixture is
  // clean by construction. This is the exact status command the gate runs.
  await git(root, 'clone', '--bare', seed, remote); await git(root, 'clone', remote, local);
  for (const repository of [remote, local]) await git(repository, 'config', 'core.autocrlf', 'false');
  await rm(path.join(local, '.gitignore'), { force: true }); await rm(path.join(local, 'project'), { recursive: true, force: true });
  await git(local, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none');
  await git(local, 'checkout', '--', '.');
  const cloneStatus = (await git(local, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none')).toString();
  assert.equal(cloneStatus, '', `a fresh target clone is not clean: ${cloneStatus.slice(0, 600)}`);
  await git(seed, 'remote', 'add', 'origin', remote);
  const managed = path.join(root, 'managed'); const snapshots = path.join(managed, '.snapshots'); await mkdir(managed); await mkdir(snapshots);
  const config = { root: managed, gitExecutable: 'git', defaultRemote: 'origin', defaultBranch: '', commandTimeoutMs: 5000, fetchTimeoutMs: 10000, operationTimeoutMs: 60000, maxSnapshotBytes: 4 * 1024 * 1024, maxFiles: 1000, maxRefBytes: 1024 * 1024, ...caps };
  const engine = new GitOperations(exec, config); const repository = await engine.discover(local);
  const identity = (await engine.remotes(local))[0].identity;
  const create = async (id = 'one', repositoryOverride = repository, onProgress) => {
    const created = await engine.create({ id, repository: repositoryOverride, destination: path.join(managed, id), remote: 'origin', remoteIdentity: identity, remoteBranch: 'topic/full/name', baseRef: `refs/dsh-worktrees/${id}/base`, onProgress });
    return { id, operationId: id, repoRoot: repository.root, commonDir: repository.commonDir, projectSubdir: repositoryOverride.projectSubdir, ...created, createdAt: Date.now(), remote: 'origin', remoteIdentity: identity, remoteBranch: 'topic/full/name', sessionIds: [], workspaceId: null, branch: null, protected: false, archived: false, state: 'ready', error: null };
  };
  const preview = record => engine.snapshot({ worktreeId: record.id, sourceSessionId: 'source-session', repositoryRoot: local, checkoutRoot: record.checkoutRoot, targetRoot: local, baseOid: record.baseOid, snapshotRoot: snapshots });
  return { root, remote, seed, local, managed, snapshots, calls, exec, git, config, engine, repository, identity, create, preview };
}
const code = expected => error => error?.code === expected;
// Windows has no POSIX permission bits: chmod cannot add an executable bit or make a
// file unreadable. Those product behaviours are asserted only where the platform can
// express them, and reported as uncovered elsewhere.
const posixModes = process.platform !== 'win32';

// Every fixture owns its temporary resources; no user's checkout or remote is mutated by these tests.
test('discover, advertised slash branch and fresh atomic fetch leave Source Local untouched', async t => {
  const f = await fixture(t);
  const subdir = await f.engine.discover(path.join(f.local, 'project'));
  assert.equal(subdir.projectSubdir, 'project'); assert.equal(subdir.branch, 'topic/full/name');
  const listed = await f.engine.branches(f.local, 'origin', f.identity);
  assert.equal(listed.defaultBranch, 'topic/full/name'); assert.deepEqual(listed.branches.map(branch => branch.name), ['topic/full/name']);
  assert.equal(Object.keys((await f.engine.remotes(f.local))[0]).includes('url'), false);
  await writeFile(path.join(f.local, 'project', 'file.txt'), 'local staged\n'); await f.git(f.local, 'add', '.');
  await writeFile(path.join(f.local, 'untracked.txt'), 'local untracked\n');
  const head = await f.git(f.local, 'rev-parse', 'HEAD'); const index = await readFile(path.join(f.local, '.git', 'index'));
  const status = await f.git(f.local, 'status', '--porcelain=v1', '-z');
  await writeFile(path.join(f.seed, 'project', 'file.txt'), 'remote new commit\n'); await f.git(f.seed, 'add', '.'); await f.git(f.seed, 'commit', '-m', 'advanced'); await f.git(f.seed, 'push', 'origin', 'topic/full/name');
  const record = await f.create('fresh', subdir);
  assert.notEqual(record.baseOid, listed.branches[0].oid);
  assert.equal(await readFile(path.join(record.checkoutRoot, 'project', 'file.txt'), 'utf8'), 'remote new commit\n');
  assert.equal(record.effectiveCwd, path.join(record.checkoutRoot, 'project'));
  assert.equal((await f.engine.verify(record)).branch, null);
  assert.deepEqual(await f.git(f.local, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(await readFile(path.join(f.local, '.git', 'index')), index);
  assert.deepEqual(await f.git(f.local, 'status', '--porcelain=v1', '-z'), status);
  assert.equal((await f.engine.status(f.local)).branch, 'topic/full/name');
  const fetch = f.calls.find(call => call.args.includes('fetch'));
  for (const flag of ['--atomic', '--refmap=', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-commit-graph', '--no-prune']) assert.ok(fetch.args.includes(flag));
  assert.equal(await lstat(path.join(f.local, '.git', 'FETCH_HEAD')).then(() => true, () => false), false);
});

async function localInput(f, id, localBranch = 'topic/full/name', localOid) {
  const repository = await f.engine.discover(path.join(f.seed, 'project'));
  return { id, repository, destination: path.join(f.managed, id), branchSource: 'local', localBranch, ...(localOid === undefined ? {} : { localOid }), baseRef: `refs/dsh-worktrees/${id}/base` };
}

test('local branch generation and creation work in a repository with no remote and preserve dirty source', async t => {
  const f = await fixture(t); await f.git(f.seed, 'remote', 'remove', 'origin');
  await f.git(f.seed, 'branch', 'feature/独立'); await f.git(f.seed, 'tag', 'not-a-branch'); await f.git(f.seed, 'tag', 'topic/full/name');
  assert.equal((await f.engine.discover(f.seed)).branch, 'topic/full/name', 'tag collision cannot alter the current local branch name');
  assert.deepEqual(await f.engine.remotes(f.seed), []);
  const start = f.calls.length;
  const listed = await f.engine.localBranches(f.seed);
  assert.equal(listed.branchSource, 'local'); assert.equal(listed.currentBranch, 'topic/full/name'); assert.equal(listed.defaultBranch, 'topic/full/name');
  assert.deepEqual(listed.branches.map(branch => branch.name), ['feature/独立', 'topic/full/name']);
  await writeFile(path.join(f.seed, 'project/file.txt'), 'staged source\n'); await f.git(f.seed, 'add', '.');
  await writeFile(path.join(f.seed, 'project/file.txt'), 'unstaged source\n'); await writeFile(path.join(f.seed, 'untracked'), 'preserve\n');
  const before = { head: await f.git(f.seed, 'rev-parse', 'HEAD'), index: await readFile(path.join(f.seed, '.git/index')), status: await f.git(f.seed, 'status', '--porcelain=v1', '-z') };
  const progress = [], input = await localInput(f, 'no-remote', listed.currentBranch, listed.branches.find(branch => branch.name === listed.currentBranch).oid);
  const created = await f.engine.create({ ...input, onProgress: stage => progress.push(stage) });
  assert.equal(created.baseOid, before.head.toString().trim()); assert.equal(created.effectiveCwd, path.join(created.checkoutRoot, 'project'));
  assert.equal(await readFile(path.join(created.checkoutRoot, 'project/file.txt'), 'utf8'), 'base\n'); assert.deepEqual(progress, ['creating']);
  assert.deepEqual(await f.git(f.seed, 'rev-parse', 'HEAD'), before.head); assert.deepEqual(await readFile(path.join(f.seed, '.git/index')), before.index); assert.deepEqual(await f.git(f.seed, 'status', '--porcelain=v1', '-z'), before.status);
  const record = { ...created, id: input.id, repoRoot: f.seed, commonDir: input.repository.commonDir, projectSubdir: 'project', remote: 'local', remoteIdentity: 'repository', remoteBranch: input.localBranch, branchSource: 'local', localBranch: input.localBranch };
  assert.equal((await f.engine.verify(record)).head, created.baseOid);
  const calls = f.calls.slice(start);
  assert.equal(calls.some(call => call.args.some(arg => ['fetch', 'ls-remote', 'get-url'].includes(arg))), false);
  const pin = calls.find(call => call.args.includes('update-ref')); assert.ok(pin.args.includes('--no-deref')); assert.match(pin.stdin, /verify refs\/heads\/topic\/full\/name [a-f0-9]{40}/u); assert.match(pin.stdin, /create refs\/dsh-worktrees\/no-remote\/base/u);
  assert.equal(await lstat(path.join(f.seed, '.git/FETCH_HEAD')).then(() => true, () => false), false);
});

test('local exact refs never accept tags, revision expressions, missing branches or moved selection', async t => {
  const f = await fixture(t); const selected = f.repository.head;
  await f.git(f.seed, 'tag', 'tag-only');
  for (const localBranch of ['--force', '../x', 'a\nrefs/heads/x', 'a\rrefs/heads/x', 'x:refs/heads/inject', 'topic/full/name~1', 'topic/full/name^{commit}', 'refs/heads/topic/full/name']) {
    const input = await localInput(f, `invalid-${f.calls.length}`, localBranch);
    await assert.rejects(f.engine.create(input), code(localBranch.startsWith('refs/') ? 'LOCAL_BRANCH_NOT_FOUND' : 'INVALID_REF'));
  }
  for (const localBranch of ['tag-only', 'missing']) await assert.rejects(f.engine.create(await localInput(f, localBranch, localBranch)), code('LOCAL_BRANCH_NOT_FOUND'));
  await writeFile(path.join(f.seed, 'project/file.txt'), 'new local commit\n'); await f.git(f.seed, 'add', '.'); await f.git(f.seed, 'commit', '-m', 'advance local');
  const moved = await localInput(f, 'moved', 'topic/full/name', selected);
  await assert.rejects(f.engine.create(moved), code('BRANCH_CHANGED'));
  assert.equal(await lstat(moved.destination).then(() => true, () => false), false);
  const base = await f.exec({ cwd: f.seed, args: ['show-ref', '--verify', '--quiet', moved.baseRef], allowedExitCodes: [0, 1] }); assert.equal(base.exitCode, 1);
  const current = await f.engine.create(await localInput(f, 'unpinned-current')); assert.notEqual(current.baseOid, selected);
});

test('local pinning rejects movement or symbolic replacement between resolution and transaction', async t => {
  for (const replacement of ['moved', 'symbolic', 'base-symbolic']) {
    const f = await fixture(t); const input = await localInput(f, `race-${replacement}`);
    const advanced = (await f.git(f.seed, 'commit-tree', `${f.repository.head}^{tree}`, '-p', f.repository.head, '-m', 'other commit')).toString().trim();
    let raced = false;
    const engine = new GitOperations(async spec => {
      if (spec.args.includes('update-ref') && !raced) {
        raced = true;
        if (replacement === 'moved') await f.git(f.seed, 'update-ref', 'refs/heads/topic/full/name', advanced);
        else if (replacement === 'symbolic') { await f.git(f.seed, 'update-ref', 'refs/heads/other', f.repository.head); await f.git(f.seed, 'symbolic-ref', 'refs/heads/topic/full/name', 'refs/heads/other'); }
        else await f.git(f.seed, 'symbolic-ref', input.baseRef, 'refs/heads/topic/full/name');
      }
      return f.exec(spec);
    }, f.config);
    await assert.rejects(engine.create(input), code('BRANCH_CHANGED')); assert.equal(raced, true);
    assert.equal(await lstat(input.destination).then(() => true, () => false), false);
    assert.equal((await f.git(f.seed, 'rev-parse', 'refs/heads/topic/full/name')).toString().trim(), replacement === 'moved' ? advanced : f.repository.head);
  }
});

test('detached local HEAD appears as pinned default and never silently follows a later attached HEAD', async t => {
  const f = await fixture(t); await f.git(f.seed, 'checkout', '--detach');
  const listed = await f.engine.localBranches(f.seed);
  assert.equal(listed.currentBranch, null); assert.equal(listed.defaultBranch, 'HEAD'); assert.equal(listed.branches.find(branch => branch.name === 'HEAD').oid, f.repository.head);
  const input = await localInput(f, 'detached-local', 'HEAD', f.repository.head);
  const created = await f.engine.create(input); assert.equal(created.baseOid, f.repository.head); assert.equal((await f.engine.status(f.seed)).branch, null);
  await assert.rejects(f.engine.create({ ...await localInput(f, 'missing-head-pin', 'HEAD') }), code('INVALID_REF'));
  await f.git(f.seed, 'checkout', 'topic/full/name');
  await assert.rejects(f.engine.create(await localInput(f, 'attached-head', 'HEAD', f.repository.head)), code('BRANCH_CHANGED'));
});

test('local generation is bounded and rejects truncated, symbolic and noncommit refs', async t => {
  const f = await fixture(t); await f.git(f.seed, 'branch', 'other');
  await assert.rejects(new GitOperations(f.exec, { ...f.config, maxFiles: 1 }).localBranches(f.seed), code('REF_LIMIT'));
  const truncated = new GitOperations(async spec => { const result = await f.exec(spec); return spec.args.includes('for-each-ref') ? { ...result, stdout: result.stdout.subarray(0, -1) } : result; }, f.config);
  await assert.rejects(truncated.localBranches(f.seed), code('TRUNCATED_OUTPUT'));
  await f.git(f.seed, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/other');
  await assert.rejects(f.engine.localBranches(f.seed), code('UNSUPPORTED_REF'));
  await assert.rejects(f.engine.create(await localInput(f, 'symbolic-local', 'alias')), code('UNSUPPORTED_REF'));
});

test('local creation retains path, attribute and live cancellation defenses without fetch', async t => {
  const f = await fixture(t), input = await localInput(f, 'local-defenses');
  await assert.rejects(f.engine.create({ ...input, destination: path.join(f.seed, 'nested') }), code('UNSAFE_PATH'));
  await assert.rejects(f.engine.create({ ...input, localOid: 'HEAD' }), code('INVALID_REF'));
  await writeFile(path.join(f.seed, '.gitattributes'), '*.txt filter=hostile\n'); await f.git(f.seed, 'add', '.gitattributes'); await f.git(f.seed, 'commit', '-m', 'unsupported local attributes');
  await assert.rejects(f.engine.create(input), code('UNSUPPORTED_ATTRIBUTES'));
  const abort = new AbortController(); let pinned = false;
  const cancelled = new GitOperations(async spec => { const result = await f.exec(spec); if (spec.args.includes('update-ref')) { pinned = true; abort.abort(); } return result; }, f.config);
  await assert.rejects(cancelled.create({ ...await localInput(f, 'local-cancelled'), signal: abort.signal }), code('CANCELLED')); assert.equal(pinned, true);
  assert.equal(await lstat(path.join(f.managed, 'local-cancelled')).then(() => true, () => false), false);
  assert.equal(f.calls.some(call => call.args.includes('fetch')), false);
});

test('read-only Git source discovery rejects ordinary directories, accepts repo subfolders and linked worktrees, and performs no remote/setup work', async t => {
  const f = await fixture(t); const linked = await f.create('read-only-probe');
  const plain = path.join(f.root, 'ordinary-folder'); await mkdir(plain);
  const before = { head: await f.git(f.local, 'rev-parse', 'HEAD'), index: await readFile(path.join(f.local, '.git', 'index')), calls: f.calls.length };
  await assert.rejects(f.engine.discover(plain), code('GIT_FAILED'));
  const nested = await f.engine.discover(path.join(f.local, 'project')); assert.equal(nested.root, f.local); assert.equal(nested.projectSubdir, 'project');
  const worktree = await f.engine.discover(path.join(linked.checkoutRoot, 'project')); assert.equal(worktree.root, linked.checkoutRoot); assert.equal(worktree.projectSubdir, 'project');
  assert.equal((await f.engine.remotes(nested.root)).length, 1);
  const probes = f.calls.slice(before.calls); assert.ok(probes.length > 0);
  assert.equal(probes.some(call => call.args.some(arg => ['fetch', 'ls-remote', 'worktree', 'branch', 'checkout', 'switch', 'reset', 'update-ref'].includes(arg))), false);
  assert.deepEqual(await f.git(f.local, 'rev-parse', 'HEAD'), before.head); assert.deepEqual(await readFile(path.join(f.local, '.git', 'index')), before.index);
});

test('checkout observers mark actual fresh fetch and validated worktree add boundaries with no extra fetch', async t => {
  const f = await fixture(t); const progress = [];
  const record = await f.create('staged', f.repository, stage => {
    progress.push({ stage, callCount: f.calls.length, args: f.calls.map(call => [...call.args]) });
  });
  assert.deepEqual(progress.map(p => p.stage), ['fetching', 'creating']);
  for (const p of progress) {
    assert.equal(p.args.filter(args => args.includes('worktree') && args.includes('add')).length, 0);
    assert.equal(p.args.filter(args => args.includes('fetch')).length, p.stage === 'fetching' ? 0 : 1);
    if (p.stage === 'creating') assert.ok(p.args.some(args => args.includes('check-attr') && args.includes('--cached')));
  }
  const fetchIndex = f.calls.findIndex(call => call.args.includes('fetch'));
  const addIndex = f.calls.findIndex(call => call.args.includes('worktree') && call.args.includes('add'));
  assert.ok(progress[0].callCount <= fetchIndex); assert.ok(fetchIndex < progress[1].callCount); assert.ok(progress[1].callCount <= addIndex);
  assert.equal(f.calls.filter(call => call.args.includes('fetch')).length, 1);
  assert.equal(await readFile(path.join(record.checkoutRoot, 'project/file.txt'), 'utf8'), 'base\n');
});

for (const listener of ['throwing', 'rejecting']) test(`${listener} checkout observer does not affect fresh fetch or checkout`, async t => {
  const f = await fixture(t), stages = [];
  const record = await f.create(`observer-${listener}`, f.repository, stage => {
    stages.push(stage);
    if (listener === 'rejecting') return Promise.reject(Error('Observer failed.'));
    throw Error('Observer failed.');
  });
  assert.deepEqual(stages, ['fetching', 'creating']);
  assert.equal((await f.engine.verify(record)).head, record.baseOid);
  assert.equal(f.calls.filter(call => call.args.includes('fetch')).length, 1);
});

test('failed fresh fetch and fetched tree validation never emit creating or add a checkout', async t => {
  const f = await fixture(t), stages = [];
  const project = await f.engine.discover(path.join(f.local, 'project'));
  await f.git(f.seed, 'rm', '-r', 'project'); await f.git(f.seed, 'commit', '-m', 'remove project'); await f.git(f.seed, 'push', 'origin', 'topic/full/name');
  await assert.rejects(f.create('invalid-fetched-tree', project, stage => stages.push(stage)), code('PROJECT_SUBDIR_MISSING'));
  assert.deepEqual(stages, ['fetching']); assert.equal(await lstat(path.join(f.managed, 'invalid-fetched-tree')).then(() => true, () => false), false);
  stages.length = 0;
  await f.git(f.remote, 'update-ref', '-d', 'refs/heads/topic/full/name');
  await assert.rejects(f.create('failed-fresh-fetch', f.repository, stage => stages.push(stage)), code('GIT_FAILED'));
  assert.deepEqual(stages, ['fetching']);
  assert.equal(f.calls.some(call => call.args.includes('worktree') && call.args.includes('add')), false);
});

test('safe branch rename changes refs only, preserving dirty checkout, index, cwd, HEAD and pinned base', async t => {
  const f = await fixture(t); const project = await f.engine.discover(path.join(f.local, 'project'));
  let record = await f.create('rename-dirty', project);
  record = { ...record, branch: (await f.engine.createBranch(record, 'worktree/random-initial')).branch };
  await writeFile(path.join(record.checkoutRoot, 'committed-task'), 'first turn commit\n'); await f.git(record.checkoutRoot, 'add', '.'); await f.git(record.checkoutRoot, 'commit', '-m', 'first task');
  await writeFile(path.join(record.checkoutRoot, 'project', 'file.txt'), 'staged task\n'); await f.git(record.checkoutRoot, 'add', '.');
  await writeFile(path.join(record.checkoutRoot, 'project', 'file.txt'), 'unstaged task\n');
  await writeFile(path.join(record.checkoutRoot, 'untracked'), 'untouched\n');
  const admin = (await f.git(record.checkoutRoot, 'rev-parse', '--absolute-git-dir')).toString().trim();
  const before = { head: await f.git(record.checkoutRoot, 'rev-parse', 'HEAD'), base: await f.git(f.local, 'rev-parse', record.baseRef), index: await readFile(path.join(admin, 'index')), status: await f.git(record.checkoutRoot, 'status', '--porcelain=v1', '-z'), fingerprint: await f.engine.fingerprint(record.checkoutRoot) };
  const start = f.calls.length;
  const renamed = await f.engine.renameBranch(record, record.branch, 'worktree/task-generated');
  assert.equal(renamed.branch, 'worktree/task-generated'); assert.equal(renamed.dirty, true);
  assert.deepEqual(await f.git(record.checkoutRoot, 'rev-parse', 'HEAD'), before.head); assert.deepEqual(await f.git(f.local, 'rev-parse', record.baseRef), before.base);
  assert.deepEqual(await readFile(path.join(admin, 'index')), before.index); assert.deepEqual(await f.git(record.checkoutRoot, 'status', '--porcelain=v1', '-z'), before.status);
  assert.equal(await f.engine.fingerprint(record.checkoutRoot), before.fingerprint);
  assert.equal(await realpath(record.effectiveCwd), record.effectiveCwd); assert.equal(await realpath(record.checkoutRoot), record.checkoutRoot);
  const calls = f.calls.slice(start); const mutation = calls.find(call => call.args.includes('branch') && call.args.includes('-m'));
  assert.ok(mutation); assert.equal(calls.some(call => call.args.some(arg => ['switch', 'checkout', 'reset', '-M', '--force'].includes(arg))), false);
});

test('safe rename refuses expected-branch changes, collisions and altered worktree identity', async t => {
  const f = await fixture(t); let record = await f.create('rename-refusal');
  record = { ...record, branch: (await f.engine.createBranch(record, 'worktree/random-initial')).branch };
  await f.git(record.checkoutRoot, 'branch', 'worktree/collision');
  await assert.rejects(f.engine.renameBranch(record, record.branch, 'worktree/collision'), code('BRANCH_EXISTS'));
  assert.equal((await f.engine.status(record.checkoutRoot)).branch, record.branch);
  await f.git(record.checkoutRoot, 'branch', '-m', 'feature/user-renamed');
  await assert.rejects(f.engine.renameBranch(record, record.branch, 'worktree/generated'), code('BRANCH_CHANGED'));
  await f.git(record.checkoutRoot, 'switch', '-c', 'feature/user-switched');
  await assert.rejects(f.engine.renameBranch(record, record.branch, 'worktree/generated'), code('BRANCH_CHANGED'));
  await assert.rejects(f.engine.renameBranch({ ...record, commonDir: f.remote }, record.branch, 'worktree/generated'), code('CHECKOUT_IDENTITY_CHANGED'));
  record = { ...record, branch: 'feature/user-switched' };
  for (const name of ['--force', 'HEAD', 'bad..ref']) await assert.rejects(f.engine.renameBranch(record, record.branch, name), code('INVALID_REF'));
  assert.equal((await f.engine.status(record.checkoutRoot)).branch, 'feature/user-switched');
});

test('two detached worktrees are independent; named branches never reused', async t => {
  const f = await fixture(t); const one = await f.create(); const two = await f.create('two');
  await writeFile(path.join(one.checkoutRoot, 'project', 'file.txt'), 'one\n');
  assert.equal(await readFile(path.join(two.checkoutRoot, 'project', 'file.txt'), 'utf8'), 'base\n');
  assert.equal((await f.engine.createBranch(one, 'feature/独立')).branch, 'feature/独立');
  await assert.rejects(f.engine.createBranch(two, 'feature/独立'), code('GIT_FAILED'));
  await assert.rejects(f.engine.createBranch(two, '--force'), code('INVALID_REF'));
  const changed = { ...one, commonDir: path.join(f.root, 'wrong') };
  await assert.rejects(f.engine.verify(changed), code('CHECKOUT_IDENTITY_CHANGED'));
});

test('missing relative project dir, deleted remote branch and repointed remote have no stale fallback', async t => {
  const f = await fixture(t); const project = await f.engine.discover(path.join(f.local, 'project'));
  await f.git(f.seed, 'rm', '-r', 'project'); await f.git(f.seed, 'commit', '-m', 'remove project'); await f.git(f.seed, 'push', 'origin', 'topic/full/name');
  await assert.rejects(f.create('missing', project), code('PROJECT_SUBDIR_MISSING'));
  assert.equal(await lstat(path.join(f.managed, 'missing')).then(() => true, () => false), false);
  await f.git(f.remote, 'update-ref', '-d', 'refs/heads/topic/full/name');
  await assert.rejects(f.create('deleted'), code('GIT_FAILED'));
  await f.git(f.local, 'remote', 'set-url', 'origin', f.seed);
  await assert.rejects(f.create('repointed'), code('REMOTE_CHANGED'));
});

test('destination nesting, existing paths, symlink ancestors and hostile references refused', async t => {
  const f = await fixture(t);
  const input = { id: 'unsafe', repository: f.repository, destination: path.join(f.local, 'nested'), remote: 'origin', remoteIdentity: f.identity, remoteBranch: 'topic/full/name', baseRef: 'refs/dsh-worktrees/unsafe/base' };
  await assert.rejects(f.engine.create(input), code('UNSAFE_PATH'));
  await mkdir(path.join(f.managed, 'exists'));
  await assert.rejects(f.engine.create({ ...input, destination: path.join(f.managed, 'exists') }), code('DESTINATION_EXISTS'));
  await symlink(f.managed, path.join(f.root, 'managed-link'));
  await assert.rejects(f.engine.create({ ...input, destination: path.join(f.root, 'managed-link', 'escape') }), code('UNSAFE_PATH'));
  for (const remoteBranch of ['--upload-pack=touch', '../x', 'a\nrefs/heads/x', 'x:refs/heads/inject']) await assert.rejects(f.engine.create({ ...input, destination: path.join(f.managed, 'safe'), remoteBranch }), code('INVALID_REF'));
});

test('environment selectors, fsmonitor and hooks cannot execute; remote helper transports rejected', async t => {
  const f = await fixture(t); const marker = path.join(f.root, 'executed'); const helper = path.join(f.root, 'helper.sh');
  await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); await chmod(helper, 0o755);
  await f.git(f.local, 'config', 'core.fsmonitor', helper); await f.git(f.local, 'config', 'core.hooksPath', path.dirname(helper));
  await writeFile(path.join(f.root, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`); await chmod(path.join(f.root, 'post-checkout'), 0o755);
  const hostile = { GIT_DIR: f.remote, GIT_WORK_TREE: f.seed, GIT_INDEX_FILE: path.join(f.seed, '.git', 'index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: helper, GIT_EXTERNAL_DIFF: helper, GIT_SSH_COMMAND: helper };
  const originals = Object.fromEntries(Object.keys(hostile).map(key => [key, process.env[key]]));
  Object.assign(process.env, hostile);
  try { const record = await f.create(); assert.equal((await f.engine.verify(record)).dirty, false); }
  finally { for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.equal(await lstat(marker).then(() => true, () => false), false);
  for (const transport of ['ext::sh -c touch', 'unknown::payload', 'http://example.invalid/repo']) {
    await f.git(f.local, 'remote', 'set-url', 'origin', transport);
    await assert.rejects(f.engine.remotes(f.local), code('UNSUPPORTED_REMOTE'));
  }
});

test('unsupported bare, unborn, sparse, partial, submodule and filter checkouts fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.discover(f.remote));
  const empty = path.join(f.root, 'empty'); await mkdir(empty); await f.git(empty, 'init');
  await assert.rejects(f.engine.discover(empty), code('UNBORN_REPOSITORY'));
  await f.git(f.local, 'config', 'core.sparseCheckout', 'true');
  await assert.rejects(f.engine.discover(f.local), code('UNSUPPORTED_REPOSITORY'));
  await f.git(f.local, 'config', '--unset', 'core.sparseCheckout');
  await f.git(f.local, 'config', 'remote.origin.promisor', 'true');
  await assert.rejects(f.engine.discover(f.local), code('UNSUPPORTED_REPOSITORY'));
  await f.git(f.local, 'config', '--unset', 'remote.origin.promisor');
  const record = await f.create();
  await writeFile(path.join(record.checkoutRoot, '.gitattributes'), '*.txt filter=evil\n');
  await assert.rejects(f.engine.fingerprint(record.checkoutRoot), code('UNSUPPORTED_ATTRIBUTES'));
  await f.git(record.checkoutRoot, 'update-index', '--add', '--cacheinfo', '160000', record.baseOid, 'submodule');
  await assert.rejects(f.engine.fingerprint(record.checkoutRoot), code('UNSUPPORTED_CHECKOUT'));
});

test('snapshot covers committed, staged, unstaged, binary, newline, untracked and executable changes without source mutation', async t => {
  const f = await fixture(t); const record = await f.create();
  await writeFile(path.join(record.checkoutRoot, 'committed.txt'), 'commit\n'); await f.git(record.checkoutRoot, 'add', '.'); await f.git(record.checkoutRoot, 'commit', '-m', 'source commit');
  await writeFile(path.join(record.checkoutRoot, 'staged.txt'), 'staged then final\n'); await f.git(record.checkoutRoot, 'add', '.');
  await writeFile(path.join(record.checkoutRoot, 'staged.txt'), 'final unstaged state\n');
  await writeFile(path.join(record.checkoutRoot, 'project', 'file.txt'), 'updated\n');
  await writeFile(path.join(record.checkoutRoot, 'binary.bin'), Buffer.from([0, 255, 128, 1, 0, 4]));
  // Names with a newline are legal on POSIX but not on Windows, and Git delimits
  // porcelain output with newlines, so the odd-name fixture stays portable.
  const oddName = 'space Unicode 你好 name.txt';
  await writeFile(path.join(record.checkoutRoot, oddName), 'odd filename\n');
  await writeFile(path.join(record.checkoutRoot, 'script.sh'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(record.checkoutRoot, 'script.sh'), 0o755);
  const gitdir = (await f.git(record.checkoutRoot, 'rev-parse', '--absolute-git-dir')).toString().trim();
  const index = await readFile(path.join(gitdir, 'index')); const head = await f.git(record.checkoutRoot, 'rev-parse', 'HEAD');
  const sourceStatus = await f.git(record.checkoutRoot, 'status', '--porcelain=v1', '-z');
  const objects = await readdir(path.join(f.local, '.git', 'objects')); const refs = await f.git(f.local, 'show-ref');
  const preview = await f.preview(record);
  assert.equal(preview.sourceRoot, record.checkoutRoot); assert.ok(preview.files.some(file => file.path === 'binary.bin' && file.binary));
  assert.deepEqual(await readFile(path.join(gitdir, 'index')), index); assert.deepEqual(await f.git(record.checkoutRoot, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(await f.git(record.checkoutRoot, 'status', '--porcelain=v1', '-z'), sourceStatus);
  assert.deepEqual(await readdir(path.join(f.local, '.git', 'objects')), objects); assert.deepEqual(await f.git(f.local, 'show-ref'), refs);
  assert.equal(preview.patchHash, createHash('sha256').update(await readFile(preview.patchPath)).digest('hex'));
  const targetIndex = await readFile(path.join(f.local, '.git', 'index'));
  const result = await new GitOperations(f.exec, f.config).apply(preview, record);
  assert.equal(result.head, record.baseOid); assert.equal(result.files, preview.files.length);
  assert.equal(await readFile(path.join(f.local, 'committed.txt'), 'utf8'), 'commit\n');
  assert.equal(await readFile(path.join(f.local, 'staged.txt'), 'utf8'), 'final unstaged state\n');
  assert.deepEqual(await readFile(path.join(f.local, 'binary.bin')), Buffer.from([0, 255, 128, 1, 0, 4]));
  if (posixModes) assert.ok((await lstat(path.join(f.local, 'script.sh'))).mode & 0o111);
  else t.diagnostic('Windows cannot carry an executable bit; mode preservation not exercised');
  assert.equal(await readFile(path.join(f.local, oddName), 'utf8'), 'odd filename\n');
  assert.deepEqual(await readFile(path.join(f.local, '.git', 'index')), targetIndex);
  assert.deepEqual(await readFile(path.join(gitdir, 'index')), index);
});

test('stale, dirty target, ignored collision and tampered patch previews are refused before writes', async t => {
  const f = await fixture(t); const record = await f.create();
  await writeFile(path.join(record.checkoutRoot, 'new.txt'), 'preview\n'); const preview = await f.preview(record);
  await writeFile(path.join(record.checkoutRoot, 'new.txt'), 'changed same status\n');
  await assert.rejects(f.engine.apply(preview, record), code('STALE_PREVIEW'));
  await writeFile(path.join(record.checkoutRoot, 'new.txt'), 'preview\n');
  await writeFile(path.join(f.local, 'project', 'file.txt'), 'target dirty\n');
  await assert.rejects(f.engine.apply(preview, record), code('TARGET_DIRTY'));
  await writeFile(path.join(f.local, 'project', 'file.txt'), 'base\n');
  await writeFile(preview.patchPath, 'tampered'); await assert.rejects(f.engine.apply(preview, record), code('INVALID_PREVIEW'));
  await writeFile(path.join(record.checkoutRoot, 'ignored-collision'), 'source\n'); await f.git(record.checkoutRoot, 'add', '-f', 'ignored-collision');
  await writeFile(path.join(f.local, 'ignored-collision'), 'target ignored\n');
  await assert.rejects(f.preview(record), code('TARGET_COLLISION'));
});

test('rename, delete and mode-only snapshots apply exactly', async t => {
  const f = await fixture(t); const record = await f.create();
  await f.git(record.checkoutRoot, 'mv', 'project/file.txt', 'renamed.txt');
  await chmod(path.join(record.checkoutRoot, '.gitignore'), 0o755);
  const preview = await f.preview(record); assert.ok(preview.files.some(file => file.status.startsWith('R')));
  await f.engine.apply(preview, record);
  assert.equal(await lstat(path.join(f.local, 'project', 'file.txt')).then(() => true, () => false), false);
  assert.equal(await readFile(path.join(f.local, 'renamed.txt'), 'utf8'), 'base\n');
  if (posixModes) assert.ok((await lstat(path.join(f.local, '.gitignore'))).mode & 0o111);
  else t.diagnostic('Windows cannot carry an executable bit; mode-only change not exercised');
});

test('changed unsafe symlinks, unreadable files, caps and truncated executor results fail closed', async t => {
  const f = await fixture(t); const record = await f.create();
  await symlink('../outside', path.join(record.checkoutRoot, 'link'));
  await assert.rejects(f.preview(record), code('UNSAFE_SYMLINK'));
  const link = path.join(record.checkoutRoot, 'link'); assert.equal(path.resolve(link), link); await rm(link);
  await writeFile(path.join(record.checkoutRoot, 'unreadable.txt'), 'secret\n');
  if (posixModes) {
    await chmod(path.join(record.checkoutRoot, 'unreadable.txt'), 0o000);
    await assert.rejects(f.engine.fingerprint(record.checkoutRoot), code('UNREADABLE_FILE'));
    await chmod(path.join(record.checkoutRoot, 'unreadable.txt'), 0o600);
  } else {
    // Windows cannot deny read through a mode, so the whole mode-driven refusal is
    // left uncovered there instead of being asserted with the wrong expectation.
    t.diagnostic('Windows cannot make a file unreadable by mode; refusal not exercised');
  }
  await assert.rejects(new GitOperations(f.exec, { ...f.config, maxSnapshotBytes: 1 }).fingerprint(record.checkoutRoot), code('SNAPSHOT_LIMIT'));
  await assert.rejects(new GitOperations(f.exec, { ...f.config, maxFiles: 1 }).fingerprint(record.checkoutRoot), code('FILE_LIMIT'));
  const truncated = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (spec.args.includes('status') && result.stdout.length) return { ...result, stdout: result.stdout.subarray(0, -1) };
    return result;
  }, f.config);
  await assert.rejects(truncated.status(record.checkoutRoot), code('TRUNCATED_OUTPUT'));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.engine.status(record.checkoutRoot, aborted.signal), code('CANCELLED'));
});

test('changed symlinks are refused before platform-normalized link bytes are compared', async t => {
  const f = await fixture(t); const record = await f.create();
  await symlink('../outside', path.join(record.checkoutRoot, 'link'));
  const gitdir = (await f.git(record.checkoutRoot, 'rev-parse', '--absolute-git-dir')).toString().trim();
  const sourceIndex = await readFile(path.join(gitdir, 'index'));
  const targetIndex = await readFile(path.join(f.local, '.git', 'index'));
  let normalized = false;
  const engine = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (spec.args.includes('ls-tree') && spec.env?.GIT_INDEX_FILE) {
      // Git for Windows normalizes link separators differently from native readlink.
      // Simulate that blob mismatch on every platform, without weakening byte checks.
      const stdout = result.stdout.toString().replace(/120000 blob [a-f0-9]{40}\tlink\0/u, () => {
        normalized = true;
        return `120000 blob ${'0'.repeat(40)}\tlink\0`;
      });
      return { ...result, stdout: Buffer.from(stdout) };
    }
    return result;
  }, f.config);
  await assert.rejects(engine.snapshot({ worktreeId: record.id, sourceSessionId: 's', repositoryRoot: f.local, checkoutRoot: record.checkoutRoot, targetRoot: f.local, baseOid: record.baseOid, snapshotRoot: f.snapshots }), code('UNSAFE_SYMLINK'));
  assert.ok(normalized, 'the private tree must exercise the link-byte mismatch');
  assert.deepEqual(await readdir(f.snapshots), []);
  assert.deepEqual(await readFile(path.join(gitdir, 'index')), sourceIndex);
  assert.deepEqual(await readFile(path.join(f.local, '.git', 'index')), targetIndex);
  assert.equal(await readFile(path.join(f.local, 'project', 'file.txt'), 'utf8'), 'base\n');
});

test('staged ignored additions and restored mtimes are represented in the final snapshot', async t => {
  const f = await fixture(t); const record = await f.create();
  const tracked = path.join(record.checkoutRoot, 'project', 'file.txt');
  const before = await lstat(tracked);
  await writeFile(tracked, 'same\n'); // same size as base\n
  const { utimes } = await import('node:fs/promises');
  await utimes(tracked, before.atime, before.mtime);
  await writeFile(path.join(record.checkoutRoot, 'ignored-staged'), 'explicit staging\n');
  await f.git(record.checkoutRoot, 'add', '-f', 'ignored-staged');
  const preview = await f.preview(record);
  assert.ok(preview.files.some(file => file.path === 'ignored-staged'));
  await f.engine.apply(preview, record);
  assert.equal(await readFile(path.join(f.local, 'project', 'file.txt'), 'utf8'), 'same\n');
  assert.equal(await readFile(path.join(f.local, 'ignored-staged'), 'utf8'), 'explicit staging\n');
});

test('remote identity checked after fetch and custom upload-pack never executed', async t => {
  const f = await fixture(t); const marker = path.join(f.root, 'uploadpack-executed');
  const helper = path.join(f.root, 'uploadpack.sh');
  await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); await chmod(helper, 0o755);
  await f.git(f.local, 'config', 'remote.origin.uploadpack', helper);
  await f.engine.branches(f.local, 'origin', f.identity);
  await f.create();
  assert.equal(await lstat(marker).then(() => true, () => false), false);
  const racing = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (spec.args.includes('fetch')) await f.git(f.local, 'remote', 'set-url', 'origin', f.seed);
    return result;
  }, f.config);
  await assert.rejects(racing.create({ id: 'race', repository: f.repository, destination: path.join(f.managed, 'race'), remote: 'origin', remoteIdentity: f.identity, remoteBranch: 'topic/full/name', baseRef: 'refs/dsh-worktrees/race/base' }), error => error.code === 'REMOTE_CHANGED' && error.details.refsMayHaveChanged);
  assert.equal(await lstat(path.join(f.managed, 'race')).then(() => true, () => false), false);
});

test('fetched filter attributes rejected without invoking configured clean/smudge/process drivers', async t => {
  const f = await fixture(t); const marker = path.join(f.root, 'filter-executed');
  for (const kind of ['process', 'clean', 'smudge']) await f.git(f.local, 'config', `filter.hostile.${kind}`, `touch '${marker}'`);
  await f.git(f.local, 'config', 'filter.hostile.required', 'true');
  await writeFile(path.join(f.seed, '.gitattributes'), '*.txt filter=hostile\n');
  await f.git(f.seed, 'add', '.'); await f.git(f.seed, 'commit', '-m', 'unsupported filter'); await f.git(f.seed, 'push', 'origin', 'topic/full/name');
  await assert.rejects(f.create(), code('UNSUPPORTED_ATTRIBUTES'));
  assert.equal(await lstat(marker).then(() => true, () => false), false);
  assert.ok(f.calls.some(call => call.args.includes('filter.hostile.process=')));
});

test('invalid UTF-8 filenames and bounded advertised generations fail closed', async t => {
  const f = await fixture(t); const record = await f.create();
  // Creating a non-UTF-8 name is a filesystem capability, not a product behaviour:
  // APFS and NTFS reject it with EILSEQ, while Linux ext4 accepts the raw bytes. The
  // refusal under test can only be exercised where such a name can exist at all.
  const invalidName = Buffer.concat([Buffer.from(`${record.checkoutRoot}/invalid-`), Buffer.from([0xff])]);
  try {
    await writeFile(invalidName, 'bytes\n');
    await assert.rejects(f.engine.fingerprint(record.checkoutRoot), code('UNSUPPORTED_ENCODING'));
  } catch (error) {
    // Windows translates the name into UTF-16 and cannot represent the raw byte at
    // all, so the refusal has nothing to act on. Any error from the setup or from the
    // product is reported as uncovered here rather than mistaken for a regression.
    t.diagnostic(`non-UTF-8 names are not exercisable on this filesystem (${error?.code ?? error?.name ?? 'unknown'}); decoding refusal not exercised`);
  }
  const truncated = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (spec.args.includes('ls-remote')) return { ...result, stdout: result.stdout.subarray(0, -1) };
    return result;
  }, f.config);
  await assert.rejects(truncated.branches(f.local, 'origin', f.identity), code('TRUNCATED_OUTPUT'));
  const oversized = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (spec.args.includes('ls-remote')) return { ...result, stdout: Buffer.alloc(f.config.maxRefBytes + 1) };
    return result;
  }, f.config);
  await assert.rejects(oversized.branches(f.local, 'origin', f.identity), code('OUTPUT_LIMIT'));
});

test('admin backlink and pinned base refs cannot be blindly adopted', async t => {
  const f = await fixture(t); const record = await f.create();
  const admin = (await f.git(record.checkoutRoot, 'rev-parse', '--absolute-git-dir')).toString().trim();
  const backlink = path.join(admin, 'gitdir'); const original = await readFile(backlink);
  await writeFile(backlink, `${path.join(f.local, '.git')}\n`);
  await assert.rejects(f.engine.verify(record), code('CHECKOUT_IDENTITY_CHANGED'));
  await writeFile(backlink, original);
  await writeFile(path.join(record.checkoutRoot, 'committed.txt'), 'new\n'); await f.git(record.checkoutRoot, 'add', '.'); await f.git(record.checkoutRoot, 'commit', '-m', 'advance');
  const advanced = (await f.git(record.checkoutRoot, 'rev-parse', 'HEAD')).toString().trim();
  await f.git(f.local, 'update-ref', record.baseRef, advanced);
  await assert.rejects(f.engine.verify(record), code('BASE_CHANGED'));
});

test('apply failures after writes report recovery and do not destructively roll back', async t => {
  const f = await fixture(t); const record = await f.create();
  await writeFile(path.join(record.checkoutRoot, 'project', 'file.txt'), 'handoff content\n');
  const preview = await f.preview(record);
  const failing = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (spec.args.includes('apply') && !spec.args.includes('--check')) throw new Error('simulated executor failure after writes');
    return result;
  }, f.config);
  await assert.rejects(failing.apply(preview, record), error => error.code === 'APPLY_RECOVERY_REQUIRED' && error.details.targetMayHaveChanged);
  assert.equal(await readFile(path.join(f.local, 'project', 'file.txt'), 'utf8'), 'handoff content\n');
  assert.equal(await readFile(path.join(record.checkoutRoot, 'project', 'file.txt'), 'utf8'), 'handoff content\n');
  assert.equal((await f.engine.status(f.local)).head, record.baseOid);
});

test('live authorization guard gates executor and native private directory mutations', async t => {
  const f = await fixture(t); const record = await f.create();
  let allowed = true; let calls = 0;
  const guarded = new GitOperations(f.exec, f.config, () => { calls++; if (!allowed) throw Object.assign(new Error('revoked'), { code: 'AUTH_REVOKED' }); });
  allowed = false;
  await assert.rejects(guarded.status(record.checkoutRoot));
  let treeCalls = 0;
  const mutating = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (spec.args.includes('ls-tree') && ++treeCalls === 2) allowed = false;
    return result;
  }, f.config, () => { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'AUTH_REVOKED' }); });
  allowed = true;
  await assert.rejects(mutating.snapshot({ worktreeId: record.id, sourceSessionId: 's', repositoryRoot: f.local, checkoutRoot: record.checkoutRoot, targetRoot: f.local, baseOid: record.baseOid, snapshotRoot: f.snapshots }));
  assert.deepEqual(await readdir(f.snapshots), []); assert.ok(calls > 0);
});

test('handoff can target another registered clean checkout without touching Source Local', async t => {
  const f = await fixture(t); const source = await f.create('source'); const target = await f.create('target');
  await writeFile(path.join(source.checkoutRoot, 'project', 'file.txt'), 'other checkout handoff\n');
  const preview = await f.engine.snapshot({ worktreeId: source.id, sourceSessionId: 'source', repositoryRoot: f.local, checkoutRoot: source.checkoutRoot, targetRoot: target.checkoutRoot, baseOid: source.baseOid, snapshotRoot: f.snapshots });
  await f.engine.apply(preview, source);
  assert.equal(await readFile(path.join(target.checkoutRoot, 'project', 'file.txt'), 'utf8'), 'other checkout handoff\n');
  assert.equal(await readFile(path.join(f.local, 'project', 'file.txt'), 'utf8'), 'base\n');
});

test('content-normalizing attributes never silently change final-working-state bytes', async t => {
  const f = await fixture(t); const record = await f.create();
  await writeFile(path.join(record.checkoutRoot, '.gitattributes'), '*.txt text\n');
  await writeFile(path.join(record.checkoutRoot, 'project', 'file.txt'), 'CRLF content\r\n');
  await assert.rejects(f.preview(record), code('UNSUPPORTED_CONTENT_TRANSFORM'));
  assert.equal(await readFile(path.join(record.checkoutRoot, 'project', 'file.txt'), 'utf8'), 'CRLF content\r\n');
  assert.equal((await f.engine.status(f.local)).dirty, false);
});

async function removalFixture(t, id = 'gc') {
  const f = await fixture(t);
  const project = await f.engine.discover(path.join(f.local, 'project'));
  const record = await f.create(id, project);
  return { ...f, record };
}

function noBroadCleanup(calls) {
  for (const call of calls) {
    assert.equal(call.args.includes('prune'), false);
    assert.equal(call.args.includes('reset'), false);
    assert.equal(call.args.includes('stash'), false);
    assert.equal(call.args.includes('branch') && call.args.some(value => ['-d', '-D'].includes(value)), false);
    if (call.args.includes('remove')) {
      assert.equal(call.args.filter(value => value === '--force').length, 1);
      assert.equal(call.args.includes('--'), true);
    }
  }
}

async function sourceReceipt(f) {
  return { head: await f.git(f.local, 'rev-parse', 'HEAD'), index: await readFile(path.join(f.local, '.git/index')), status: await f.git(f.local, 'status', '--porcelain=v1', '-z', '--ignored'), file: await readFile(path.join(f.local, 'project/file.txt')) };
}

async function assertSourceReceipt(f, before) {
  assert.deepEqual(await sourceReceipt(f), before);
}

test('GC removes authorized dirty, staged, untracked and ignored fixture bytes while retaining every shared ref and Source Local', async t => {
  const f = await removalFixture(t, 'dirty-gc'); const { record } = f;
  await f.engine.createBranch(record, 'feature/retained-gc');
  await writeFile(path.join(record.checkoutRoot, 'committed'), 'committed task\n'); await f.git(record.checkoutRoot, 'add', '.'); await f.git(record.checkoutRoot, 'commit', '-m', 'task commit');
  const finalHead = (await f.git(record.checkoutRoot, 'rev-parse', 'HEAD')).toString().trim();
  await writeFile(path.join(record.checkoutRoot, 'project/file.txt'), 'staged deletion authority\n'); await f.git(record.checkoutRoot, 'add', '.');
  await writeFile(path.join(record.checkoutRoot, 'untracked'), 'discard explicitly authorized\n');
  await writeFile(path.join(record.checkoutRoot, 'ignored-secret'), 'discard ignored explicitly authorized\n');
  await writeFile(path.join(f.local, 'project/file.txt'), 'preserve dirty Local\n'); await f.git(f.local, 'add', '.');
  await writeFile(path.join(f.local, 'ignored-local'), 'preserve ignored Local\n');
  await f.git(f.local, 'tag', 'keep-tag', finalHead); await f.git(f.local, 'update-ref', 'refs/custom/keep', finalHead);
  const refs = await f.git(f.local, 'for-each-ref', '--format=%(refname) %(objectname)');
  const source = await sourceReceipt(f); const start = f.calls.length;
  // The recorded direct parent may already be GCed; only the ultimate Local is authoritative.
  const legacyParent = { ...record, repoRoot: path.join(f.managed, 'already-collected') };
  const identity = await f.engine.inspectRemoval(legacyParent, f.local);
  assert.equal(identity.head, finalHead); assert.equal(identity.branch, 'feature/retained-gc');
  assert.equal(identity.sourceRoot, f.local); assert.equal(identity.checkoutRoot, record.checkoutRoot);
  assert.equal(typeof identity.pointerIdentity, 'string'); assert.ok(identity.retainedHeads.includes(record.baseOid));
  assert.deepEqual(JSON.parse(JSON.stringify(identity)), identity, 'identity evidence is durable JSON, never Buffer or bigint');
  const rescue = await f.engine.preserveRemovalHead(legacyParent, identity);
  assert.equal(rescue, `refs/dsh-worktrees/${record.id}/gc-head`);
  assert.equal(await f.engine.preserveRemovalHead(legacyParent, identity), rescue, 'repeated preservation only verifies the exact rescue ref');
  await f.engine.removeManagedCheckout(legacyParent, identity);
  assert.equal(await lstat(record.checkoutRoot).then(() => true, () => false), false);
  assert.equal(await lstat(identity.adminDir).then(() => true, () => false), false);
  assert.equal(await f.engine.removalState(legacyParent, f.local, identity), 'absent');
  assert.equal((await f.git(f.local, 'rev-parse', rescue)).toString().trim(), finalHead);
  const after = (await f.git(f.local, 'for-each-ref', '--format=%(refname) %(objectname)')).toString().split('\n');
  for (const row of refs.toString().trim().split('\n')) assert.ok(after.includes(row), `shared reference retained: ${row}`);
  await assertSourceReceipt(f, source);
  const remove = f.calls.slice(start).find(call => call.args.includes('worktree') && call.args.includes('remove'));
  assert.equal(remove.cwd, f.local); assert.equal(remove.args.at(-1), record.checkoutRoot); noBroadCleanup(f.calls.slice(start));
});

test('GC physical root authority tolerates missing effective subdirectory and conflicted index stages', async t => {
  const f = await removalFixture(t, 'conflicted-gc'); const { record } = f;
  assert.equal(await realpath(record.effectiveCwd), record.effectiveCwd);
  assert.equal(path.resolve(record.effectiveCwd), record.effectiveCwd); await rm(record.effectiveCwd, { recursive: true, force: false });
  const blob = (await f.git(f.local, 'rev-parse', `${record.baseOid}:project/file.txt`)).toString().trim();
  await f.exec({ cwd: record.checkoutRoot, args: ['update-index', '--index-info'], stdin: `0 ${'0'.repeat(40)}\tproject/file.txt\n100644 ${blob} 1\tproject/file.txt\n100644 ${blob} 2\tproject/file.txt\n100644 ${blob} 3\tproject/file.txt\n` });
  await assert.rejects(f.engine.verify(record));
  const identity = await f.engine.inspectRemoval(record, f.local);
  await f.engine.preserveRemovalHead(record, identity); await f.engine.removeManagedCheckout(record, identity);
  assert.equal(await f.engine.removalState(record, f.local, identity), 'absent');
});

test('GC detached final HEAD, superseded private reflog commits and private commit refs all remain reachable', async t => {
  const f = await removalFixture(t, 'detached-gc'); const { record } = f;
  await writeFile(path.join(record.checkoutRoot, 'detached'), 'first\n'); await f.git(record.checkoutRoot, 'add', '.'); await f.git(record.checkoutRoot, 'commit', '-m', 'detached first');
  const superseded = (await f.git(record.checkoutRoot, 'rev-parse', 'HEAD')).toString().trim();
  await writeFile(path.join(record.checkoutRoot, 'detached'), 'amended\n'); await f.git(record.checkoutRoot, 'add', '.'); await f.git(record.checkoutRoot, 'commit', '--amend', '-m', 'detached amended');
  await f.git(record.checkoutRoot, 'update-ref', 'refs/worktree/private', superseded);
  const identity = await f.engine.inspectRemoval(record, f.local);
  assert.equal(identity.branch, null); assert.ok(identity.retainedHeads.includes(superseded)); assert.notEqual(identity.head, superseded);
  await f.engine.preserveRemovalHead(record, identity); await f.engine.removeManagedCheckout(record, identity);
  assert.equal((await f.git(f.local, 'rev-parse', `refs/dsh-worktrees/${record.id}/gc-head`)).toString().trim(), identity.head);
  assert.equal((await f.git(f.local, 'rev-parse', `refs/dsh-worktrees/${record.id}/gc-retained/${superseded}`)).toString().trim(), superseded);
  assert.equal((await f.git(f.local, 'cat-file', '-t', superseded)).toString().trim(), 'commit');
});

for (const tamper of ['locked', 'index.lock', 'HEAD.lock', 'backlink', 'commondir', 'base', 'base-symbolic', 'pointer-symlink', 'nested', 'submodule']) test(`GC refuses ${tamper} before deletion`, async t => {
  const f = await removalFixture(t, `refuse-${tamper.replaceAll('.', '-')}`); const { record } = f;
  const admin = (await f.git(record.checkoutRoot, 'rev-parse', '--absolute-git-dir')).toString().trim();
  if (tamper === 'locked') await f.git(f.local, 'worktree', 'lock', '--reason', 'fixture lock', record.checkoutRoot);
  else if (tamper.endsWith('.lock')) await writeFile(path.join(admin, tamper), 'fixture admin lock\n');
  else if (tamper === 'backlink') await writeFile(path.join(admin, 'gitdir'), `${path.join(f.local, '.git')}\n`);
  else if (tamper === 'commondir') await writeFile(path.join(admin, 'commondir'), `${f.remote}\n`);
  else if (tamper === 'base') {
    const changed = (await f.git(f.local, 'commit-tree', `${record.baseOid}^{tree}`, '-p', record.baseOid, '-m', 'changed base')).toString().trim();
    await f.git(f.local, 'update-ref', record.baseRef, changed);
  } else if (tamper === 'base-symbolic') await f.git(f.local, 'symbolic-ref', record.baseRef, 'refs/heads/topic/full/name');
  else if (tamper === 'pointer-symlink') {
    const pointer = path.join(record.checkoutRoot, '.git'); const backup = path.join(f.root, 'pointer-backup');
    await writeFile(backup, await readFile(pointer)); assert.equal(path.resolve(pointer), pointer); await rm(pointer); await symlink(backup, pointer);
  } else if (tamper === 'nested') { const nested = path.join(record.checkoutRoot, 'ignored-nested'); await mkdir(nested); await f.git(nested, 'init'); }
  else await f.git(record.checkoutRoot, 'update-index', '--add', '--cacheinfo', '160000', record.baseOid, 'submodule');
  const start = f.calls.length;
  await assert.rejects(f.engine.inspectRemoval(record, f.local));
  assert.equal(f.calls.slice(start).some(call => call.args.includes('remove') || call.args.includes('update-ref')), false);
  assert.equal(await lstat(record.checkoutRoot).then(value => value.isDirectory()), true);
});

for (const lock of ['packed-refs.lock', 'refs/heads/topic/full/name.lock']) test(`GC refuses shared admin maintenance ${lock}`, async t => {
  const f = await removalFixture(t, `shared-lock-${lock.startsWith('refs/') ? 'branch' : 'packed'}`);
  await writeFile(path.join(f.repository.commonDir, lock), 'fixture shared lock\n');
  const start = f.calls.length;
  await assert.rejects(f.engine.inspectRemoval(f.record, f.local), code('WORKTREE_LOCKED'));
  assert.equal(f.calls.slice(start).some(call => call.args.includes('remove') || call.args.includes('update-ref')), false);
});

test('GC refuses symbolic attached branch aliases without changing shared refs', async t => {
  const f = await removalFixture(t, 'symbolic-head-gc');
  await f.git(f.local, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/topic/full/name');
  await f.git(f.record.checkoutRoot, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
  const refs = await f.git(f.local, 'show-ref'); const start = f.calls.length;
  await assert.rejects(f.engine.inspectRemoval(f.record, f.local), code('UNSUPPORTED_REF'));
  assert.deepEqual(await f.git(f.local, 'show-ref'), refs);
  assert.equal(f.calls.slice(start).some(call => call.args.includes('remove') || call.args.includes('update-ref')), false);
});

test('GC refuses source/path nesting, wrong exact base namespace, nonordinary and replaced pointers', async t => {
  const f = await removalFixture(t, 'identity-gc'); const { record } = f;
  await assert.rejects(f.engine.inspectRemoval({ ...record, checkoutRoot: f.local }, f.local), code('CHECKOUT_IDENTITY_CHANGED'));
  await assert.rejects(f.engine.inspectRemoval({ ...record, baseRef: `refs/dsh-worktrees/other/base` }, f.local), code('BASE_CHANGED'));
  await symlink(record.checkoutRoot, path.join(f.managed, 'checkout-alias'));
  await assert.rejects(f.engine.inspectRemoval({ ...record, checkoutRoot: path.join(f.managed, 'checkout-alias') }, f.local), code('CHECKOUT_IDENTITY_CHANGED'));
  const identity = await f.engine.inspectRemoval(record, f.local);
  const pointer = path.join(record.checkoutRoot, '.git'); const saved = await readFile(pointer);
  assert.equal(path.resolve(pointer), pointer); await rm(pointer); await writeFile(pointer, saved);
  await assert.rejects(f.engine.preserveRemovalHead(record, identity), code('CHECKOUT_IDENTITY_CHANGED'));
  assert.equal(await f.engine.removalState(record, f.local, identity), 'replaced');
  assert.equal(f.calls.some(call => call.args.includes('remove')), false);
});

test('GC stale HEAD and rescue-ref replacement are refused, without overwriting any ref', async t => {
  const f = await removalFixture(t, 'stale-head-gc'); const { record } = f;
  const stale = await f.engine.inspectRemoval(record, f.local);
  await f.git(record.checkoutRoot, 'commit', '--allow-empty', '-m', 'advance after inspection');
  await assert.rejects(f.engine.preserveRemovalHead(record, stale), code('HEAD_CHANGED'));
  const identity = await f.engine.inspectRemoval(record, f.local); await f.engine.preserveRemovalHead(record, identity);
  await f.git(f.local, 'update-ref', `refs/dsh-worktrees/${record.id}/gc-head`, record.baseOid);
  await assert.rejects(f.engine.removeManagedCheckout(record, identity), code('RESCUE_REF_CHANGED'));
  assert.equal((await f.git(f.local, 'rev-parse', `refs/dsh-worktrees/${record.id}/gc-head`)).toString().trim(), record.baseOid);
  assert.equal(await lstat(record.checkoutRoot).then(() => true), true);
  assert.equal(f.calls.some(call => call.args.includes('remove')), false);
});

test('GC reconciliation distinguishes exact absence, partial state and replaced root; ambiguous native completion requires recovery', async t => {
  const f = await removalFixture(t, 'reconcile-gc'); const { record } = f;
  const identity = await f.engine.inspectRemoval(record, f.local);
  assert.equal(await f.engine.removalState(record, f.local, identity), 'present', 'inspection phase need not have rescue refs yet');
  await f.engine.preserveRemovalHead(record, identity);
  assert.equal(await f.engine.removalState(record, f.local, identity), 'present');
  const moved = path.join(f.managed, 'fixture-moved-root');
  assert.equal(await realpath(record.checkoutRoot), record.checkoutRoot); assert.equal(path.resolve(moved), moved); await rename(record.checkoutRoot, moved);
  assert.equal(await f.engine.removalState(record, f.local, identity), 'partial');
  await mkdir(record.checkoutRoot); assert.equal(await f.engine.removalState(record, f.local, identity), 'replaced');
  assert.equal(await realpath(record.checkoutRoot), record.checkoutRoot); await rm(record.checkoutRoot, { recursive: true, force: false }); assert.equal(await realpath(moved), moved); await rename(moved, record.checkoutRoot);
  const engine = new GitOperations(async spec => { const result = await f.exec(spec); if (spec.args.includes('remove')) throw Error('fixture timeout after native completion'); return result; }, f.config);
  await assert.rejects(engine.removeManagedCheckout(record, identity), error => error.code === 'REMOVAL_RECOVERY_REQUIRED' && error.details.checkoutMayHaveChanged);
  assert.equal(await f.engine.removalState(record, f.local, identity), 'absent');
  assert.equal(await f.engine.removalState(record, f.local), 'partial', 'unknown admin receipt cannot imply complete removal');
  noBroadCleanup(f.calls);
});

test('GC revalidates admin locks after command driver discovery and respects live authorization revocation', async t => {
  const f = await removalFixture(t, 'preflight-gc'); const { record } = f;
  const identity = await f.engine.inspectRemoval(record, f.local); await f.engine.preserveRemovalHead(record, identity);
  let inspected = 0; let raced = false;
  const engine = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (spec.args.includes('worktree') && spec.args.includes('list') && ++inspected === 7) {
      raced = true; await writeFile(path.join(identity.adminDir, 'index.lock'), 'fixture new lock\n');
    }
    return result;
  }, f.config);
  await assert.rejects(engine.removeManagedCheckout(record, identity)); assert.equal(raced, true);
  assert.equal(f.calls.some(call => call.args.includes('remove')), false);
  const lock = path.join(identity.adminDir, 'index.lock'); assert.equal(path.resolve(lock), lock); await rm(lock);
  let authorized = true; let count = 0;
  const guarded = new GitOperations(async spec => { const result = await f.exec(spec); if (++count === 10) authorized = false; return result; }, f.config, () => { if (!authorized) throw Error('fixture revocation'); });
  await assert.rejects(guarded.removeManagedCheckout(record, identity));
  assert.equal(f.calls.some(call => call.args.includes('remove')), false);
});

test('GC bounded pointer/history observations reject unsupported private refs and output limits', async t => {
  const f = await removalFixture(t, 'bounded-gc'); const { record } = f;
  const admin = (await f.git(record.checkoutRoot, 'rev-parse', '--absolute-git-dir')).toString().trim();
  await f.git(record.checkoutRoot, 'symbolic-ref', 'refs/worktree/alias', 'refs/heads/topic/full/name');
  await assert.rejects(f.engine.inspectRemoval(record, f.local), code('UNSUPPORTED_CHECKOUT'));
  await f.git(record.checkoutRoot, 'symbolic-ref', '--delete', 'refs/worktree/alias');
  const pointer = path.join(record.checkoutRoot, '.git'); const content = await readFile(pointer);
  await writeFile(pointer, Buffer.alloc(f.config.maxRefBytes + 1, 120));
  await assert.rejects(f.engine.inspectRemoval(record, f.local), code('CHECKOUT_IDENTITY_CHANGED'));
  await writeFile(pointer, content);
  await mkdir(path.join(admin, 'rebase-merge'));
  await assert.rejects(f.engine.inspectRemoval(record, f.local), code('UNSUPPORTED_CHECKOUT'));
  assert.equal(f.calls.some(call => call.args.includes('remove')), false);
});

async function localSwitchFixture(t) {
  const f = await fixture(t);
  await f.git(f.local, 'switch', '-c', 'reopen/selected');
  await writeFile(path.join(f.local, 'project/file.txt'), 'selected branch bytes\n');
  await writeFile(path.join(f.local, 'new-target'), 'selected new path\n');
  await writeFile(path.join(f.local, 'ignored-target'), 'selected ignored-name tracked path\n');
  await f.git(f.local, 'add', 'project/file.txt', 'new-target'); await f.git(f.local, 'add', '-f', 'ignored-target'); await f.git(f.local, 'commit', '-m', 'selected Local branch');
  const selectedOid = (await f.git(f.local, 'rev-parse', 'HEAD')).toString().trim();
  await f.git(f.local, 'switch', 'topic/full/name');
  return { ...f, selectedOid };
}

test('Local current exact branch and detached selection reopen dirty/conflicted/ignored checkout without Git mutation', async t => {
  const f = await fixture(t);
  await f.git(f.local, 'tag', 'topic/full/name');
  await writeFile(path.join(f.local, 'project/file.txt'), 'dirty current Local\n'); await f.git(f.local, 'add', '.');
  await writeFile(path.join(f.local, 'untracked'), 'preserve\n'); await writeFile(path.join(f.local, 'ignored-local'), 'preserve ignored\n');
  const before = await sourceReceipt(f); const start = f.calls.length;
  const state = await f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'topic/full/name', f.repository.head, undefined, true);
  assert.equal(state.dirty, true); assert.equal(state.branch, 'topic/full/name'); await assertSourceReceipt(f, before);
  assert.equal(f.calls.slice(start).some(call => call.args.some(value => ['switch', 'update-ref', 'reset', 'stash', 'fetch'].includes(value))), false);
  const blob = (await f.git(f.local, 'rev-parse', 'HEAD:project/file.txt')).toString().trim();
  await f.exec({ cwd: f.local, args: ['update-index', '--index-info'], stdin: `0 ${'0'.repeat(40)}\tproject/file.txt\n100644 ${blob} 1\tproject/file.txt\n100644 ${blob} 2\tproject/file.txt\n100644 ${blob} 3\tproject/file.txt\n` });
  assert.equal((await f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'topic/full/name', f.repository.head, undefined, true)).dirty, true);
  // Test-only native HEAD change; product must not detach the selected attached branch.
  await f.git(f.local, 'update-ref', '--no-deref', 'HEAD', f.repository.head);
  const detachedStart = f.calls.length;
  assert.equal((await f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'HEAD', f.repository.head, undefined, true)).branch, null);
  assert.equal(f.calls.slice(detachedStart).some(call => call.args.includes('switch')), false);
});

test('Local verifyOnly rejects a different or concurrently switched current selection without any mutation', async t => {
  const f = await localSwitchFixture(t); const before = await sourceReceipt(f); const refs = await f.git(f.local, 'show-ref'); const start = f.calls.length;
  await assert.rejects(f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'reopen/selected', f.selectedOid, undefined, true), code('LOCAL_BRANCH_CHANGED'));
  await assert.rejects(f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'HEAD', f.repository.head, undefined, true), code('LOCAL_BRANCH_CHANGED'));
  await assertSourceReceipt(f, before); assert.deepEqual(await f.git(f.local, 'show-ref'), refs);
  assert.equal(f.calls.slice(start).some(call => call.args.some(value => ['switch', 'checkout', 'update-ref', 'reset', 'stash', 'merge', 'fetch'].includes(value))), false);
  let raced = false; let changedReceipt;
  const engine = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (!raced && spec.args.includes('worktree') && spec.args.includes('list')) {
      raced = true;
      // The external switch is fixture-owned. verifyOnly itself must not restore
      // the previously chosen branch under privileged Host maintenance authority.
      await f.git(f.local, 'switch', 'reopen/selected'); changedReceipt = await sourceReceipt(f);
    }
    return result;
  }, f.config);
  const raceStart = f.calls.length;
  await assert.rejects(engine.switchLocalBranch(f.local, f.repository.commonDir, 'topic/full/name', f.repository.head, undefined, true), code('LOCAL_BRANCH_CHANGED'));
  assert.equal(raced, true); await assertSourceReceipt(f, changedReceipt); assert.deepEqual(await f.git(f.local, 'show-ref'), refs);
  const switchCalls = f.calls.slice(raceStart).filter(call => call.args.includes('switch'));
  assert.equal(switchCalls.length, 1); assert.equal(switchCalls[0].args.includes('--no-pager'), false, 'only the external fixture switch executed');
});

test('Local different clean branch switches safely with exact OID and no-overwrite-ignore, preserving refs/history', async t => {
  const f = await localSwitchFixture(t); await f.git(f.local, 'tag', 'reopen/selected', f.selectedOid);
  const beforeRefs = await f.git(f.local, 'show-ref'); const start = f.calls.length;
  const state = await f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'reopen/selected', f.selectedOid);
  assert.equal(state.head, f.selectedOid); assert.equal(state.branch, 'reopen/selected'); assert.equal(state.dirty, false);
  assert.equal(await readFile(path.join(f.local, 'project/file.txt'), 'utf8'), 'selected branch bytes\n');
  assert.deepEqual(await f.git(f.local, 'show-ref'), beforeRefs);
  const calls = f.calls.slice(start); const mutation = calls.find(call => call.args.includes('switch'));
  assert.ok(mutation.args.includes('--no-overwrite-ignore')); assert.ok(mutation.args.includes('--no-guess')); assert.equal(mutation.args.includes('--no-track'), false, 'no-track can implicitly create a basename branch'); assert.equal(mutation.args.at(-1), 'reopen/selected');
  for (const forbidden of ['--force', 'reset', 'stash', 'merge', 'fetch', 'checkout', 'update-ref']) assert.equal(calls.some(call => call.args.includes(forbidden)), false);
});

for (const collision of ['dirty', 'staged', 'untracked', 'ignored']) test(`Local different branch refuses ${collision} and preserves exact source state`, async t => {
  const f = await localSwitchFixture(t);
  if (collision === 'dirty' || collision === 'staged') {
    await writeFile(path.join(f.local, 'project/file.txt'), 'keep Local edits\n');
    if (collision === 'staged') await f.git(f.local, 'add', '.');
  } else await writeFile(path.join(f.local, collision === 'untracked' ? 'new-target' : 'ignored-target'), 'keep Local collision\n');
  const before = await sourceReceipt(f); const start = f.calls.length;
  await assert.rejects(f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'reopen/selected', f.selectedOid), code('LOCAL_DIRTY'));
  await assertSourceReceipt(f, before); assert.equal(f.calls.slice(start).some(call => call.args.includes('switch')), false);
});

test('Local branch-in-use, stale branch/HEAD selections and canonical repo identity changes are refused', async t => {
  const f = await localSwitchFixture(t); const record = await f.create('local-branch-in-use');
  await f.git(record.checkoutRoot, 'switch', 'reopen/selected');
  const start = f.calls.length;
  await assert.rejects(f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'reopen/selected', f.selectedOid), code('BRANCH_IN_USE'));
  await assert.rejects(f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'reopen/selected', f.repository.head), code('BRANCH_CHANGED'));
  await assert.rejects(f.engine.switchLocalBranch(f.local, f.repository.commonDir, 'HEAD', f.repository.head), code('BRANCH_CHANGED'));
  await assert.rejects(f.engine.switchLocalBranch(f.local, f.remote, 'topic/full/name', f.repository.head), code('CHECKOUT_IDENTITY_CHANGED'));
  await symlink(f.local, path.join(f.root, 'local-alias'));
  await assert.rejects(f.engine.switchLocalBranch(path.join(f.root, 'local-alias'), f.repository.commonDir, 'topic/full/name', f.repository.head), code('CHECKOUT_IDENTITY_CHANGED'));
  await assert.rejects(f.engine.switchLocalBranch(f.local, f.repository.commonDir, '--force', f.repository.head), code('INVALID_REF'));
  assert.equal(f.calls.slice(start).some(call => call.args.includes('switch')), false);
  assert.equal((await f.engine.status(f.local)).branch, 'topic/full/name');
});

test('Local selected branch movement at final preflight refuses mutation; ambiguous completion reports recovery', async t => {
  const f = await localSwitchFixture(t); let counts = 0; let raced = false;
  const moved = (await f.git(f.local, 'commit-tree', `${f.selectedOid}^{tree}`, '-p', f.selectedOid, '-m', 'selection moved')).toString().trim();
  const engine = new GitOperations(async spec => {
    const result = await f.exec(spec);
    if (spec.args.includes('worktree') && spec.args.includes('list') && ++counts === 6) { raced = true; await f.git(f.local, 'update-ref', 'refs/heads/reopen/selected', moved); }
    return result;
  }, f.config);
  const start = f.calls.length;
  await assert.rejects(engine.switchLocalBranch(f.local, f.repository.commonDir, 'reopen/selected', f.selectedOid));
  assert.equal(raced, true); assert.equal(f.calls.slice(start).some(call => call.args.includes('switch')), false);
  await f.git(f.local, 'update-ref', 'refs/heads/reopen/selected', f.selectedOid);
  const ambiguous = new GitOperations(async spec => { const result = await f.exec(spec); if (spec.args.includes('switch')) throw Error('fixture timeout after successful switch'); return result; }, f.config);
  await assert.rejects(ambiguous.switchLocalBranch(f.local, f.repository.commonDir, 'reopen/selected', f.selectedOid), error => error.code === 'LOCAL_SWITCH_RECOVERY_REQUIRED' && error.details.targetMayHaveChanged);
  assert.equal((await f.engine.status(f.local)).head, f.selectedOid);
});

test('Local branch selection refuses a tree missing the original selected subdirectory before any switch', async t => {
  const f = await localSwitchFixture(t);
  const emptyTree = (await f.git(f.local, 'hash-object', '-t', 'tree', '--stdin')).toString().trim();
  const withoutProject = (await f.git(f.local, 'commit-tree', emptyTree, '-p', f.repository.head, '-m', 'without selected folder')).toString().trim();
  await f.git(f.local, 'branch', 'without-project', withoutProject);
  const before = await sourceReceipt(f), start = f.calls.length;
  await assert.rejects(f.engine.switchLocalBranch(path.join(f.local, 'project'), f.repository.commonDir, 'without-project', withoutProject), code('PROJECT_SUBDIR_MISSING'));
  await assertSourceReceipt(f, before); assert.equal(f.calls.slice(start).some(call => call.args.includes('switch')), false);
  assert.equal(await readFile(path.join(f.local, 'project/file.txt'), 'utf8'), 'base\n');
});
