import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { WorktreeSourceContext } from '@1yefuwang1/dsh-worktrees/import-contract';
import { GitProbe } from '../src/git/probe.js';
import { gitLocationHints } from '../src/git/context.js';

const anchor = { generation: 1, headerHash: 'a'.repeat(64), eventCount: 3, chainHash: 'b'.repeat(64) };
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', shell: false, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, `fixture Git ${args[0]} failed: ${result.stderr}`); return result.stdout.trim();
}
async function fixture(t: TestContext, committed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-context-probe-'))), repo = join(root, 'source-repository');
  await mkdir(repo); git(repo, 'init', '--initial-branch=release');
  t.after(async () => { assert.equal(await realpath(root), root); assert.equal(dirname(root), await realpath(tmpdir())); assert.ok(root.startsWith(join(await realpath(tmpdir()), 'git-context-probe-'))); await rm(root, { recursive: true, force: false }); });
  if (committed) { await writeFile(join(repo, 'tracked.txt'), 'creation bytes\n'); git(repo, 'add', '--', 'tracked.txt'); git(repo, 'commit', '-m', 'creation'); }
  return { root, repo };
}

test('fresh real Git context separates current upstream and HEAD B from immutable local-base release/A and upstreamAtCreation dev', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), creation = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'remote', 'add', 'origin', ['https://', 'fixture:synthetic-pass@example.invalid/original.git?private=1#fragment'].join(''));
  git(f.repo, 'remote', 'add', 'publish', ['ssh://', 'fixture@example.invalid/current.git'].join(''));
  const worktree = join(f.root, 'current-worktree'); git(f.repo, 'worktree', 'add', '-b', 'worktree/task-x', worktree, 'release');
  git(worktree, 'config', 'branch.worktree/task-x.remote', 'publish'); git(worktree, 'config', 'branch.worktree/task-x.merge', 'refs/heads/feature/nested');
  git(worktree, 'update-ref', 'refs/remotes/publish/feature/nested', creation);
  await writeFile(join(worktree, 'tracked.txt'), 'current bytes\n'); git(worktree, 'add', '--', 'tracked.txt'); git(worktree, 'commit', '-m', 'current');
  const current = git(worktree, 'rev-parse', 'HEAD'), commonDir = await realpath(join(f.repo, '.git'));
  const source: WorktreeSourceContext = { sessionId: 'source-thread', cwd: worktree, commonDir, provenance: 'original-checkout', creationBase: { kind: 'local', ref: 'refs/heads/release', oid: creation, upstreamAtCreation: { ref: 'refs/heads/dev', remote: { name: 'origin', sanitizedUrl: 'https://example.invalid/original.git' } } } };
  const beforeIndex = await readFile(join(commonDir, 'worktrees/current-worktree/index')), beforeTime = (await stat(join(commonDir, 'worktrees/current-worktree/index'), { bigint: true })).mtimeNs;
  const probe = new GitProbe(), result = await probe.capture(worktree, worktree, 'device-b', anchor, source);
  assert.ok(result); assert.equal(result.current.headOid, current); assert.notEqual(current, creation);
  assert.equal(result.current.branchRef, 'refs/heads/worktree/task-x'); assert.equal(result.repository.worktree, true);
  assert.deepEqual(result.repository.configuredRemote, { name: 'origin', sanitizedUrl: 'https://example.invalid/original.git' });
  assert.deepEqual(result.current.upstream, { kind: 'remote', ref: 'refs/heads/feature/nested', remote: { name: 'publish', sanitizedUrl: 'ssh://example.invalid/current.git' } });
  assert.deepEqual(result.creationBase, source.creationBase); assert.deepEqual(result.observation, { ...anchor, deviceId: 'device-b', observedAt: result.observation.observedAt });
  assert.deepEqual(gitLocationHints(result).map(value => ({ purpose: value.purpose, oid: value.oid, ref: value.ref })), [{ purpose: 'current', oid: current, ref: 'refs/heads/feature/nested' }, { purpose: 'creation', oid: creation, ref: 'refs/heads/dev' }]);
  assert.ok(!JSON.stringify(result).includes('synthetic-pass')); assert.ok(!JSON.stringify(result).includes('private=1'));
  assert.deepEqual(await readFile(join(commonDir, 'worktrees/current-worktree/index')), beforeIndex); assert.equal((await stat(join(commonDir, 'worktrees/current-worktree/index'), { bigint: true })).mtimeNs, beforeTime);
  git(worktree, 'config', 'branch.worktree/task-x.merge', 'refs/heads/other');
  git(worktree, 'update-ref', 'refs/remotes/publish/other', current);
  const changed = await probe.capture(worktree, worktree, 'device-b', { ...anchor, eventCount: 4 }, source);
  assert.ok(changed); assert.equal(changed.current.upstream?.ref, 'refs/heads/other'); assert.deepEqual(changed.creationBase, source.creationBase);
  const imported = await probe.capture(worktree, worktree, 'device-b', anchor, { ...source, provenance: 'import-placement', creationBase: undefined });
  assert.ok(imported); assert.equal(imported.creationBase, undefined, 'new receiving placement must not fabricate an original creation base');
});

for (const race of ['upstream', 'remote-url'] as const) test(`Git context refuses a ${race} change during capture even when HEAD is unchanged`, { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), head = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'remote', 'add', 'origin', 'https://example.invalid/old.git');
  git(f.repo, 'update-ref', 'refs/remotes/origin/dev', head); git(f.repo, 'update-ref', 'refs/remotes/origin/changed', head);
  git(f.repo, 'config', 'branch.release.remote', 'origin'); git(f.repo, 'config', 'branch.release.merge', 'refs/heads/dev');
  const wrapper = join(f.root, 'trusted-git-wrapper.cjs'), counter = join(f.root, 'capture-counter');
  await writeFile(wrapper, [
    `#!${process.execPath}`,
    "const fs = require('node:fs'); const {spawnSync}=require('node:child_process'); const args=process.argv.slice(2);",
    "const result=spawnSync('/usr/bin/git',args,{cwd:process.cwd(),encoding:'utf8',env:process.env});",
    `const counter=${JSON.stringify(counter)}; const mode=${JSON.stringify(race)};`,
    "let match=mode==='upstream' ? args.includes('for-each-ref') : args.includes('--get') && args.at(-1)==='remote.origin.url';",
    "if(match){ const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1; fs.writeFileSync(counter,String(n)); if(mode==='upstream'&&n===1) spawnSync('/usr/bin/git',['config','branch.release.merge','refs/heads/changed'],{cwd:process.cwd(),env:process.env}); if(mode==='remote-url'&&n===2) spawnSync('/usr/bin/git',['config','remote.origin.url','https://example.invalid/replaced.git'],{cwd:process.cwd(),env:process.env}); }",
    "process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??''); process.exit(result.status??1);",
  ].join('\n'), { mode: 0o700 });
  const result = await new GitProbe({ executable: wrapper, timeoutMs: 20_000 }).capture(f.repo, f.repo, 'device', anchor);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(result, null, 'a coherent observation cannot mix ref/config generations');
});

test('capture bypasses old advisory cache for no-event HEAD/branch changes and handles local upstream, detached and unborn without network', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), probe = new GitProbe(), first = git(f.repo, 'rev-parse', 'HEAD');
  assert.equal((await probe.inspect(f.repo, f.repo))?.commit, first);
  git(f.repo, 'branch', 'local-parent'); git(f.repo, 'config', 'branch.release.remote', '.'); git(f.repo, 'config', 'branch.release.merge', 'refs/heads/local-parent');
  await writeFile(join(f.repo, 'tracked.txt'), 'new HEAD without any conversation event\n'); git(f.repo, 'add', '--', 'tracked.txt'); git(f.repo, 'commit', '-m', 'new HEAD');
  const second = git(f.repo, 'rev-parse', 'HEAD'), captured = await probe.capture(f.repo, f.repo, 'device', anchor);
  assert.ok(captured); assert.equal(captured.current.headOid, second); assert.notEqual(second, first);
  assert.deepEqual(captured.current.upstream, { kind: 'local', ref: 'refs/heads/local-parent' });
  assert.equal((await probe.inspect(f.repo, f.repo))?.commit, first, 'old cached v1 advice is not v2 publication data');
  git(f.repo, 'checkout', '--detach', second);
  const detached = await probe.capture(f.repo, f.repo, 'device', anchor); assert.ok(detached); assert.equal(detached.current.detached, true); assert.equal(detached.current.branchRef, undefined); assert.equal(detached.current.upstream, undefined);
  const unborn = await fixture(t, false), empty = await probe.capture(unborn.repo, unborn.repo, 'device', anchor);
  assert.ok(empty); assert.equal(empty.current.unborn, true); assert.equal(empty.current.headOid, undefined); assert.equal(empty.current.branchRef, 'refs/heads/release');
  const cancelled = new AbortController(); cancelled.abort(); assert.equal(await probe.capture(f.repo, f.repo, 'device', anchor, undefined, cancelled.signal), null);
});
