import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { GitProbe, GIT_PROBE_LIMITS, GIT_READ_ONLY_ARGS, gitProbeEnvironment } from '../src/git/probe.js';
import { decodeGitJson, parseGitFacts, sanitizeGitRemote, type GitFacts } from '../src/git/sanitize.js';
import { gitGuidance, quotePosix, quotePowerShell } from '../src/git/guidance.js';

const binary = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/cmd/git.exe') : '/usr/bin/git';
function git(cwd: string, ...args: string[]) {
  const result = spawnSync(binary, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', shell: false, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
  assert.equal(result.status, 0, `fixture Git ${args[0]} failed: ${result.stderr}`); return result.stdout.trim();
}
async function fixture(t: TestContext, committed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'azure-git-'))), repo = join(root, "project with 'quotes' and $literal");
  await mkdir(repo); git(repo, 'init', '--initial-branch=main');
  if (committed) { await writeFile(join(repo, 'file.txt'), 'original bytes\n'); git(repo, 'add', '--', 'file.txt'); git(repo, 'commit', '-m', 'fixture'); }
  t.after(async () => { const canonical = await realpath(root); assert.equal(canonical, root); assert.equal(dirname(root), await realpath(tmpdir())); assert.ok(root.startsWith(join(await realpath(tmpdir()), 'azure-git-'))); await rm(root, { recursive: true }); });
  const inspect = () => new GitProbe().inspect(repo, repo);
  return { root, repo, inspect };
}
async function missing(path: string) { await assert.rejects(access(path), error => error instanceof Error && 'code' in error && error.code === 'ENOENT'); }
const facts = (patch: Partial<GitFacts> = {}): GitFacts => ({ v: 1, root: '/local project', branch: 'main', commit: 'a'.repeat(40), detached: false, unborn: false, worktree: false, dirty: 'clean', ...patch });

test('Git remote sanitization removes all userinfo/query/fragment and rejects helpers/local paths', () => {
  const raw = ['https://', 'user:synthetic-pass@EXAMPLE.invalid/repo.git?sig=private#private'].join('');
  assert.equal(sanitizeGitRemote(raw), 'https://example.invalid/repo.git');
  assert.equal(sanitizeGitRemote('git@example.invalid:team/repo.git?sig=private#fragment'), 'ssh://example.invalid/team/repo.git');
  assert.equal(sanitizeGitRemote('ssh://user@example.invalid:2222/team/repo#secret'), 'ssh://example.invalid:2222/team/repo');
  for (const input of ['file:///private/repo', '/private/repo', '../relative', 'C:\\project', 'ext::sh -c dangerous', '--upload-pack=x', 'https://host/repo\nunsafe', 'javascript:alert(1)']) assert.equal(sanitizeGitRemote(input), undefined);
});

test('raw backslashes are rejected before WHATWG can reclassify Git/libcurl userinfo as a host or path', () => {
  for (const scheme of ['http', 'https']) for (const userinfo of ['CANARYTOKEN', 'CANARYUSER:12345']) {
    const remote = `${scheme}://${userinfo}${String.fromCharCode(92)}@127.0.0.1:49157/repo.git`;
    assert.equal(sanitizeGitRemote(remote), undefined);
    assert.equal(parseGitFacts(facts({ remote })), undefined);
    assert.equal(decodeGitJson(JSON.stringify(facts({ remote }))), undefined);
  }
  for (const remote of ['ssh://user@example.invalid/team\\\\repo', 'git@example.invalid:team\\\\repo', 'C:\\\\local\\\\repo']) assert.equal(sanitizeGitRemote(remote), undefined);
  assert.equal(sanitizeGitRemote('git@example.invalid:team/repo.git'), 'ssh://example.invalid/team/repo.git');
  assert.equal(sanitizeGitRemote('ssh://git@example.invalid:2222/team/repo.git'), 'ssh://example.invalid:2222/team/repo.git');
});

test('actual Git remote config with raw-backslash userinfo yields no published credential-shaped remote', async t => {
  const f = await fixture(t); const index = await readFile(join(f.repo, '.git/index')), mtime = (await stat(join(f.repo, '.git/index'), { bigint: true })).mtimeNs;
  for (const scheme of ['http', 'https']) for (const userinfo of ['CANARYTOKEN', 'CANARYUSER:12345']) {
    git(f.repo, 'config', 'remote.origin.url', `${scheme}://${userinfo}${String.fromCharCode(92)}@127.0.0.1:49157/repo.git`);
    const result = await f.inspect(); assert.ok(result); assert.equal(result.remote, undefined); assert.ok(!JSON.stringify(result).includes('CANARY'));
  }
  assert.deepEqual(await readFile(join(f.repo, '.git/index')), index); assert.equal((await stat(join(f.repo, '.git/index'), { bigint: true })).mtimeNs, mtime);
});

test('strict SCP grammar cannot reclassify colon/userinfo or PAT strings as a credential-bearing path', () => {
  for (const remote of ['CANARYUSER:12345@example.invalid:team/repo.git', 'org:glpat-CANARY@example.invalid:team/repo.git', 'git@example.invalid:team@repo', 'git@example.invalid:team:repo', 'git@example.invalid:team repo', 'git@x:repo', 'git@@example.invalid:repo', 'CANARYUSER:12345?@example.invalid:repo']) {
    assert.equal(sanitizeGitRemote(remote), undefined); assert.equal(parseGitFacts(facts({ remote })), undefined); assert.equal(decodeGitJson(JSON.stringify(facts({ remote }))), undefined);
  }
  assert.equal(sanitizeGitRemote('git@example.invalid:team/repo.git'), 'ssh://example.invalid/team/repo.git');
  assert.equal(sanitizeGitRemote('git@example.invalid:team/repo.git?sig=private#fragment'), 'ssh://example.invalid/team/repo.git');
  assert.equal(sanitizeGitRemote('example.invalid:team/repo.git'), 'ssh://example.invalid/team/repo.git');
  assert.equal(sanitizeGitRemote('CANARYTOKEN@example.invalid:team/repo.git'), 'ssh://example.invalid/team/repo.git');
  assert.equal(sanitizeGitRemote('ssh://git@example.invalid/team/name@tag:part.git'), 'ssh://example.invalid/team/name@tag:part.git');
});

test('actual secret-bearing SCP Git config cannot leak through strict publication JSON or catalog decoding', async t => {
  const f = await fixture(t); const index = await readFile(join(f.repo, '.git/index')), mtime = (await stat(join(f.repo, '.git/index'), { bigint: true })).mtimeNs;
  for (const remote of ['CANARYUSER:12345@example.invalid:team/repo.git', 'org:glpat-CANARY@example.invalid:team/repo.git']) {
    git(f.repo, 'config', 'remote.origin.url', remote);
    const result = await f.inspect(); assert.ok(result); assert.equal(result.remote, undefined);
    const validated = parseGitFacts(result); assert.ok(validated); const publicationJson = JSON.stringify(validated);
    assert.doesNotMatch(publicationJson, /CANARY/iu);
    const catalog = decodeGitJson(publicationJson); assert.deepEqual(catalog, validated); assert.equal(catalog?.remote, undefined);
  }
  assert.deepEqual(await readFile(join(f.repo, '.git/index')), index); assert.equal((await stat(join(f.repo, '.git/index'), { bigint: true })).mtimeNs, mtime);
});

test('scope root replaced with a final symlink is rejected on fresh inspection; ancestor aliases remain allowed', async t => {
  const f = await fixture(t), other = await fixture(t), saved = join(f.root, 'original-repository');
  assert.ok(await f.inspect());
  assert.equal(await realpath(f.repo), f.repo); assert.equal(resolve(saved), saved); assert.equal(dirname(saved), f.root); assert.equal(await realpath(f.root), f.root);
  await rename(f.repo, saved); // Only the verified, freshly created fixture directory.
  await symlink(other.repo, f.repo, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await readFile(join(other.repo, '.git/index')), mtime = (await stat(join(other.repo, '.git/index'), { bigint: true })).mtimeNs;
  assert.equal(await f.inspect(), null);
  for (const suffix of [sep, sep.repeat(3)]) assert.equal(await new GitProbe().inspect(f.repo + suffix, f.repo + suffix), null, 'trailing separators cannot make lstat follow the final alias');
  const ancestor = join(f.root, 'ancestor-alias'); await symlink(other.root, ancestor, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasedRoot = join(ancestor, basename(other.repo));
  assert.equal((await new GitProbe().inspect(aliasedRoot, aliasedRoot))?.root, other.repo);
  assert.equal((await new GitProbe().inspect(aliasedRoot + sep, aliasedRoot + sep))?.root, other.repo);
  assert.deepEqual(await readFile(join(other.repo, '.git/index')), before); assert.equal((await stat(join(other.repo, '.git/index'), { bigint: true })).mtimeNs, mtime);
});

test('Git facts parser is a strict detached allowlist and never exposes malformed cloud Git JSON', () => {
  const valid = facts({ remote: 'https://example.invalid/repo' }); assert.deepEqual(parseGitFacts(valid), valid); assert.ok(Object.isFrozen(parseGitFacts(valid)));
  for (const bad of [{ ...valid, rawUrl: 'private' }, { ...valid, remote: 'https://example.invalid/repo?sig=private' }, { ...valid, dirty: false }, { ...valid, commit: 'not-a-hash' }, { ...valid, detached: true }, { ...valid, unborn: true }]) assert.equal(parseGitFacts(bad), undefined);
  let touched = 0; const hostile = Object.defineProperty({}, 'v', { get() { touched++; return 1; } });
  assert.equal(parseGitFacts(hostile), undefined); assert.equal(touched, 0);
  assert.equal(decodeGitJson('{broken'), undefined); assert.equal(decodeGitJson('x'.repeat(20_000)), undefined);
  assert.equal(JSON.stringify(parseGitFacts(valid)).includes('private'), false);
});

test('POSIX and PowerShell guidance quote literal arguments, use -- and only inspect verified local refs', () => {
  const path = "/local space/'quote';$(touch SHOULD_NOT_EXIST)`x`";
  assert.equal(quotePowerShell("a'b $() `"), "'a''b $() `'"); assert.equal(quotePosix("a'b"), "'a'\"'\"'b'");
  const advice = gitGuidance(facts({ root: path }), facts({ root: 'C:\\remote\\never-used', branch: 'feature/quote-safe', commit: 'b'.repeat(40) }));
  assert.equal(advice.mismatch, true); assert.equal(advice.posix.length, 2); assert.equal(advice.powershell.length, 2);
  for (const line of [...advice.posix, ...advice.powershell]) { assert.ok(!line.includes('never-used')); assert.doesNotMatch(line, /\b(?:fetch|push|checkout|worktree|clone|reset)\b/u); }
  assert.ok(advice.posix[1]?.includes("'--' 'refs/heads/feature/quote-safe'"));
  assert.deepEqual(gitGuidance(null, facts()).posix, []);
  assert.equal(gitGuidance(facts(), facts({ branch: '-unsafe' })).posix.length, 1);
  for (const quote of [quotePosix, quotePowerShell]) assert.throws(() => quote('bad\nargument'));
});

test('real clean/dirty/staged/untracked Git facts preserve actual index bytes/mtime and working bytes', async t => {
  const f = await fixture(t), index = join(f.repo, '.git/index');
  const before = await readFile(index), mtime = (await stat(index, { bigint: true })).mtimeNs, file = await readFile(join(f.repo, 'file.txt'));
  const clean = await f.inspect(); assert.ok(clean); assert.equal(clean.dirty, 'clean'); assert.equal(clean.branch, 'main'); assert.equal(clean.root, f.repo); assert.equal(clean.unborn, false);
  assert.deepEqual(await readFile(index), before); assert.equal((await stat(index, { bigint: true })).mtimeNs, mtime); assert.deepEqual(await readFile(join(f.repo, 'file.txt')), file); await missing(join(f.repo, '.git/index.lock'));
  await writeFile(join(f.repo, 'file.txt'), 'changed bytes\n'); assert.equal((await f.inspect())?.dirty, 'dirty');
  git(f.repo, 'add', '--', 'file.txt'); const staged = await readFile(index), stagedMtime = (await stat(index, { bigint: true })).mtimeNs;
  assert.equal((await f.inspect())?.dirty, 'dirty'); assert.deepEqual(await readFile(index), staged); assert.equal((await stat(index, { bigint: true })).mtimeNs, stagedMtime);
  git(f.repo, 'commit', '-m', 'changed'); await writeFile(join(f.repo, 'untracked'), 'untracked'); assert.equal((await f.inspect())?.dirty, 'dirty');
});

test('unborn, detached and linked-worktree facts are advisory without branch/worktree mutation', async t => {
  const empty = await fixture(t, false); const unborn = await empty.inspect(); assert.ok(unborn); assert.equal(unborn.unborn, true); assert.equal(unborn.branch, 'main'); assert.equal(unborn.dirty, 'clean');
  await writeFile(join(empty.repo, 'new.txt'), 'new'); git(empty.repo, 'add', '--', 'new.txt'); assert.equal((await empty.inspect())?.dirty, 'dirty');
  const f = await fixture(t); const commit = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'update-ref', '--no-deref', 'HEAD', commit); assert.equal((await f.inspect())?.detached, true); assert.equal((await f.inspect())?.commit, commit);
  const linked = join(f.root, 'linked'); git(f.repo, 'worktree', 'add', '--detach', linked, commit); // Fixture setup ONLY, never a probe command.
  const headBefore = await readFile(join(f.repo, '.git/HEAD'));
  const result = await new GitProbe().inspect(linked, linked); assert.ok(result); assert.equal(result.worktree, true); assert.equal(result.detached, true); assert.equal(result.dirty, 'clean');
  assert.deepEqual(await readFile(join(f.repo, '.git/HEAD')), headBefore);
});

test('non-Git, foreign scope and symlink cwd escapes return null without probing cloud-like paths', async t => {
  const f = await fixture(t), other = join(f.root, 'other'); await mkdir(other);
  assert.equal(await new GitProbe().inspect(other, other), null);
  assert.equal(await new GitProbe().inspect(f.repo, other), null);
  assert.equal(await new GitProbe().inspect('C:\\remote\\project', f.repo), null);
  if (process.platform !== 'win32') { await symlink(other, join(f.repo, 'escape')); assert.equal(await new GitProbe().inspect(join(f.repo, 'escape'), f.repo), null); }
  assert.equal(await new GitProbe().inspect('relative', f.repo), null);
});

test('attributes, filters, CRLF, sparse and promisor configurations produce Unknown without invoking code or lazy fetch', async t => {
  const f = await fixture(t), sentinel = join(f.root, 'MUST_NOT_RUN');
  const command = `${process.execPath} -e "require('fs').writeFileSync(${JSON.stringify(sentinel)},'executed')"`;
  for (const [key, value] of [['core.fsmonitor', command], ['filter.evil.clean', command], ['filter.evil.smudge', command], ['filter.evil.process', command], ['diff.evil.textconv', command], ['diff.external', command], ['core.autocrlf', 'true'], ['remote.origin.promisor', 'true'], ['remote.origin.url', 'ext::' + command]]) git(f.repo, 'config', key!, value!);
  await writeFile(join(f.repo, '.gitattributes'), '*.txt filter=evil diff=evil\n');
  const before = await readFile(join(f.repo, '.git/index')), mtime = (await stat(join(f.repo, '.git/index'), { bigint: true })).mtimeNs;
  const result = await f.inspect(); assert.ok(result); assert.equal(result.dirty, 'unknown'); assert.equal(result.remote, undefined);
  await missing(sentinel); assert.deepEqual(await readFile(join(f.repo, '.git/index')), before); assert.equal((await stat(join(f.repo, '.git/index'), { bigint: true })).mtimeNs, mtime);
  const attrs = await fixture(t); await writeFile(join(attrs.repo, '.gitattributes'), '*.txt text eol=crlf\n'); assert.equal((await attrs.inspect())?.dirty, 'unknown');
  const sparse = await fixture(t); git(sparse.repo, 'config', 'core.sparseCheckout', 'true'); assert.equal((await sparse.inspect())?.dirty, 'unknown');
});

test('trusted absolute Git binary, environment allowlist and fixed read-only argv resist inherited Git/PATH injections', async t => {
  const f = await fixture(t); const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TRACE', 'GIT_TRACE2_EVENT', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'PATH'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = join(f.root, 'injected');
    process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor'; process.env.PATH = `${f.repo}:.:`;
    const env = gitProbeEnvironment(); assert.equal(env.GIT_DIR, undefined); assert.equal(env.GIT_INDEX_FILE, undefined); assert.equal(env.GIT_CONFIG_KEY_0, undefined); assert.equal(env.GIT_TRACE, undefined); assert.equal(env.GIT_EXTERNAL_DIFF, undefined); assert.equal(env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(env.GIT_NO_LAZY_FETCH, '1');
    assert.ok(!env.PATH?.includes(f.repo)); assert.equal((await f.inspect())?.dirty, 'clean');
    assert.equal(await new GitProbe({ executable: './git' }).inspect(f.repo, f.repo), null);
  } finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
});

test('bounded native reads never publish file contents and large files become Unknown', async t => {
  const f = await fixture(t); await writeFile(join(f.repo, 'file.txt'), Buffer.alloc(GIT_PROBE_LIMITS.fileBytes + 1, 65));
  const result = await f.inspect(); assert.ok(result); assert.equal(result.dirty, 'unknown'); assert.ok(JSON.stringify(result).length < 5000);
  assert.equal(JSON.stringify(result).includes('A'.repeat(50)), false);
});

test('native directory depth and total-content budgets fail conservatively without changing the index', async t => {
  const f = await fixture(t); let nested = f.repo;
  for (let depth = 0; depth < GIT_PROBE_LIMITS.depth + 2; depth++) { nested = join(nested, 'd'); await mkdir(nested); }
  const before = await readFile(join(f.repo, '.git/index')); const deep = await f.inspect(); assert.ok(deep === null || deep.dirty === 'unknown'); assert.deepEqual(await readFile(join(f.repo, '.git/index')), before);
  const large = await fixture(t);
  for (let index = 0; index < 9; index++) await writeFile(join(large.repo, `large-${index}`), Buffer.alloc(GIT_PROBE_LIMITS.fileBytes, 65 + index));
  git(large.repo, 'add', '--all'); git(large.repo, 'commit', '-m', 'bounded-content-fixture');
  const indexBytes = await readFile(join(large.repo, '.git/index')), mtime = (await stat(join(large.repo, '.git/index'), { bigint: true })).mtimeNs;
  const result = await large.inspect(); assert.ok(result === null || result.dirty === 'unknown'); assert.deepEqual(await readFile(join(large.repo, '.git/index')), indexBytes); assert.equal((await stat(join(large.repo, '.git/index'), { bigint: true })).mtimeNs, mtime);
});

test('POSIX shell receives literal quoting rather than executing a path payload', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), sentinel = join(f.root, 'NEVER_CREATED');
  const value = `${f.repo}/'quote';$(touch ${sentinel})`;
  const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${quotePosix(value)}`], { cwd: f.repo, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0); assert.equal(result.stdout, value); await missing(sentinel);
});

test('real command traces contain only fixed read-only probes; partial clones never open tree objects', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), trace = join(f.root, 'trace.jsonl'), wrapper = join(f.root, 'trusted-git-wrapper');
  await writeFile(wrapper, `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+'\\n');const r=cp.spawnSync(${JSON.stringify(binary)},process.argv.slice(2),{cwd:process.cwd(),env:process.env});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);\n`); await chmod(wrapper, 0o700);
  const result = await new GitProbe({ executable: wrapper }).inspect(f.repo, f.repo); assert.equal(result?.dirty, 'clean');
  let calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  for (const args of calls) { assert.deepEqual(args.slice(0, GIT_READ_ONLY_ARGS.length), GIT_READ_ONLY_ARGS); assert.ok(['rev-parse', 'symbolic-ref', 'config', 'ls-files', 'ls-tree'].includes(args[GIT_READ_ONLY_ARGS.length]!)); assert.ok(!args.some(arg => ['fetch', 'push', 'checkout', 'status', 'diff-files', 'worktree'].includes(arg))); }
  git(f.repo, 'config', 'remote.origin.promisor', 'true');
  const offset = calls.length; assert.equal((await new GitProbe({ executable: wrapper }).inspect(f.repo, f.repo))?.dirty, 'unknown');
  calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.ok(calls.slice(offset).every(args => !args.includes('ls-tree')));
});

test('subprocess output, timeouts, caller cancellation and untrusted executables are bounded', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), noisy = join(f.root, 'noisy'), hung = join(f.root, 'hung');
  await writeFile(noisy, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(400000));\n`); await chmod(noisy, 0o700);
  await writeFile(hung, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`); await chmod(hung, 0o700);
  assert.equal(await new GitProbe({ executable: noisy }).inspect(f.repo, f.repo), null);
  const invalid = join(f.root, 'invalid-utf8'); await writeFile(invalid, `#!${process.execPath}\nprocess.stdout.write(Buffer.from([255]));\n`); await chmod(invalid, 0o700);
  assert.equal(await new GitProbe({ executable: invalid }).inspect(f.repo, f.repo), null);
  const before = Date.now(); assert.equal(await new GitProbe({ executable: hung, timeoutMs: 100 }).inspect(f.repo, f.repo), null); assert.ok(Date.now() - before < 2000);
  const stop = new AbortController(); const pending = new GitProbe({ executable: hung, timeoutMs: 5000 }).inspect(f.repo, f.repo, stop.signal); stop.abort(); assert.equal(await pending, null);
  assert.equal(await new GitProbe({ executable: resolve(f.root, 'absent') }).inspect(f.repo, f.repo), null);
});
