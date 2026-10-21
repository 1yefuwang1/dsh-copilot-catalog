import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { WorktreeSourceContext } from '@1yefuwang1/dsh-worktrees/import-contract';
import { GitProbe, gitProbeEnvironment } from '../src/git/probe.js';

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await execute('/usr/bin/git', args, { cwd, env: gitProbeEnvironment(), maxBuffer: 262_144 })).stdout.trim(); }

test('verified header-root/current descendant retains creation A; sibling linked checkout with same commonDir and nested-header scope cannot borrow or broaden it', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-cwd-scope-')));
  t.after(async () => { assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: false }); });
  const source = join(root, 'source'); await mkdir(source);
  await git(source, 'init', '-b', 'base'); await git(source, 'config', 'user.name', 'Fixture'); await git(source, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, 'tracked.txt'), 'A\n'); await git(source, 'add', 'tracked.txt'); await git(source, 'commit', '-m', 'A');
  const oid = await git(source, 'rev-parse', 'HEAD'), a = join(root, 'checkout-a'), b = join(root, 'checkout-b');
  await git(source, 'worktree', 'add', '-b', 'local-a', a, oid); await git(source, 'worktree', 'add', '-b', 'local-b', b, oid);
  const childA = join(a, 'nested'), childB = join(b, 'nested'); await mkdir(childA); await mkdir(childB);
  const commonDir = await realpath(join(source, '.git'));
  const context: WorktreeSourceContext = { sessionId: 'original-native', cwd: a, commonDir, provenance: 'original-checkout', creationBase: { kind: 'local', ref: 'refs/heads/base', oid } };
  const anchor = { generation: 1, headerHash: 'a'.repeat(64), eventCount: 0, chainHash: 'b'.repeat(64) };
  const probe = new GitProbe({ timeoutMs: 5_000 });
  const descendant = await probe.capture(childA, a, 'fixture-device', anchor, context);
  assert.deepEqual(descendant?.creationBase, context.creationBase); assert.equal(descendant?.current.headOid, oid);
  assert.equal(await probe.capture(childB, b, 'fixture-device', anchor, context), null, 'same commonDir is not same checkout/header root');
  assert.equal(await probe.capture(childA, childA, 'fixture-device', anchor, { ...context, cwd: childA }), null, 'header nested below Git root remains safe-unavailable; no parent file scan');
  assert.equal(await git(a, 'rev-parse', 'HEAD'), oid); assert.equal(await git(b, 'rev-parse', 'HEAD'), oid);
});
