import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitOperations } from '../dist/git.js';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktrees-engine-test-'));
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
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'base');
  await git(root, 'clone', '--bare', seed, remote); await git(root, 'clone', remote, local);
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
  await writeFile(path.join(record.checkoutRoot, 'space Unicode 你好\nname.txt'), 'odd filename\n');
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
  assert.ok((await lstat(path.join(f.local, 'script.sh'))).mode & 0o111);
  assert.equal(await readFile(path.join(f.local, 'space Unicode 你好\nname.txt'), 'utf8'), 'odd filename\n');
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
  assert.ok((await lstat(path.join(f.local, '.gitignore'))).mode & 0o111);
});

test('changed unsafe symlinks, unreadable files, caps and truncated executor results fail closed', async t => {
  const f = await fixture(t); const record = await f.create();
  await symlink('../outside', path.join(record.checkoutRoot, 'link'));
  await assert.rejects(f.preview(record), code('UNSAFE_SYMLINK'));
  const link = path.join(record.checkoutRoot, 'link'); assert.equal(path.resolve(link), link); await rm(link);
  await writeFile(path.join(record.checkoutRoot, 'unreadable.txt'), 'secret\n'); await chmod(path.join(record.checkoutRoot, 'unreadable.txt'), 0o000);
  await assert.rejects(f.engine.fingerprint(record.checkoutRoot), code('UNREADABLE_FILE'));
  await chmod(path.join(record.checkoutRoot, 'unreadable.txt'), 0o600);
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
  await writeFile(Buffer.concat([Buffer.from(`${record.checkoutRoot}/invalid-`), Buffer.from([0xff])]), 'bytes\n');
  await assert.rejects(f.engine.fingerprint(record.checkoutRoot), code('UNSUPPORTED_ENCODING'));
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
