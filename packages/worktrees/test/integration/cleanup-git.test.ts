import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { Readable, Writable } from 'node:stream';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { WorktreeRecord } from '../../dist/types.js';
import { deferred, required, hasCode } from './fixtures.js';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session';
import { WorktreeCleanup, historicalWorktreeRoot } from '../../dist/cleanup.js';
import { cleanupDomain } from '../../dist/cleanup-store.js';
import { worktreeDomain } from '../../dist/store.js';
import { WorktreeController } from '../../dist/service.js';
import { GitOperations } from '../../dist/git.js';
import { createMaintenanceExecutor } from '../../dist/runtime.js';
import { tempDirectory, tmpBase } from '../helpers.js';

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href);
const clone = <T>(value: T): T => structuredClone(value);
function within(root: string, candidate: string) { const part = relative(root, candidate); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); }
async function findGit() {
  const key = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
  for (const folder of (process.env[key ?? 'PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32' ? ['git.exe', 'git.com'] : ['git']) {
      const candidate = resolve(folder, name);
      try { await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); if ((await lstat(candidate)).isDirectory()) continue; return await realpath(candidate); } catch {}
    }
  }
  return undefined;
}

/** Test-only managed provider: exactly PATH-resolved Git, bounded output/deadlines, fixture-owned cwd only. */
interface SpawnSpec { cwd: string; argv: readonly string[]; env?: NodeJS.ProcessEnv; stdio: { stdin: 'pipe' | 'ignore' }; signal?: AbortSignal }
interface ProcessHandle { stdin: Writable | undefined; stdout: Readable | null; stderr: Readable | null; done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>; terminate(): void; waitForExit(signal?: AbortSignal): Promise<boolean> }
interface ProcessCall { cwd: string; argv: string[]; env: NodeJS.ProcessEnv; input: SpawnSpec['stdio']['stdin']; exitCode?: number | null }
function subprocessProvider(root: string, git: string, calls: ProcessCall[], running: Set<ProcessHandle>) {
  const baseline: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, 'empty-home'), USERPROFILE: join(root, 'empty-home'), XDG_CONFIG_HOME: join(root, 'empty-config') };
  for (const key of Object.keys(baseline)) if (key.startsWith('GIT_')) delete baseline[key];
  return {
    async resolveExecutable(command: string, _env: Readonly<Record<string, string>> | undefined, signal?: AbortSignal) { assert.equal(signal?.aborted, false); assert.ok(command === git || command === 'git'); return git; },
    spawn(spec: SpawnSpec) {
      const cwd = realpathSync(spec.cwd); assert.equal(cwd, spec.cwd); assert.ok(within(root, cwd)); assert.equal(spec.argv[0], git);
      const env = { ...baseline };
      for (const [key, value] of Object.entries(spec.env ?? {})) { if (value === undefined) delete env[key]; else env[key] = value; }
      const entry: ProcessCall = { cwd, argv: [...spec.argv], env: { ...spec.env }, input: spec.stdio.stdin }; calls.push(entry);
      const child = spawn(git, spec.argv.slice(1), { cwd, env, shell: false, stdio: [spec.stdio.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      let closed = false, failure: Error | undefined, bytes = 0, killTimer: NodeJS.Timeout | undefined; const closeGate = deferred<boolean>();
      const terminate = () => { if (!closed) { child.kill('SIGTERM'); killTimer ??= setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 500); killTimer.unref(); } };
      const abort = () => terminate(); spec.signal?.addEventListener('abort', abort, { once: true }); if (spec.signal?.aborted) abort();
      const timer = setTimeout(() => { failure = Error('Fixture Git provider deadline exceeded'); terminate(); }, 15000); timer.unref();
      for (const stream of [child.stdout, child.stderr]) required(stream).on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { failure = Error('Fixture Git provider output cap exceeded'); terminate(); } });
      child.on('error', error => { failure = error; });
      const done = new Promise<Awaited<ProcessHandle['done']>>((fulfill, reject) => child.on('close', (exitCode, signal) => {
        closed = true; clearTimeout(timer); clearTimeout(killTimer); spec.signal?.removeEventListener('abort', abort); running.delete(handle); entry.exitCode = exitCode; closeGate.resolve(true);
        if (failure) reject(failure); else fulfill({ exitCode, signal });
      }));
      const handle: ProcessHandle = { stdin: child.stdin ?? undefined, stdout: child.stdout, stderr: child.stderr, done, terminate,
        async waitForExit(signal?: AbortSignal) {
          if (closed) return true; if (signal?.aborted) return false;
          if (!signal) return closeGate.promise;
          let listener!: () => void; const abort = new Promise<boolean>(resolve => { listener = () => resolve(false); signal.addEventListener('abort', listener, { once: true }); });
          try { return await Promise.race([closeGate.promise, abort]); } finally { signal.removeEventListener('abort', listener); }
        },
      }; running.add(handle); return handle;
    },
  };
}

test('default cleanup coordinator, managed real Git and strict JSON receipts reclaim only the expired checkout and retain Local/history/refs', { timeout: 120000 }, async t => {
  const gitExecutable = await findGit(); if (!gitExecutable) { t.skip('Git is unavailable on the local PATH.'); return; }
  const root = await tempDirectory('worktrees-cleanup-git-owned-'); assert.equal(dirname(root), tmpBase);
  const local = join(root, 'local'), project = join(local, 'project'), managed = join(root, 'historical-managed');
  await mkdir(project, { recursive: true }); await mkdir(managed); await mkdir(join(root, 'empty-home')); await mkdir(join(root, 'empty-config')); await mkdir(join(root, 'empty-hooks'));
  const owner = new Context(), calls: ProcessCall[] = [], running = new Set<ProcessHandle>(); let cleanup: WorktreeCleanup | undefined, controller: WorktreeController | undefined, facility: DomainFacility | undefined, backend: JsonStorageBackend | undefined, worktreeUnit: Domain<typeof worktreeDomain> | undefined, cleanupUnit: Domain<typeof cleanupDomain> | undefined;
  t.after(async () => {
    await cleanup?.close(); await controller?.close(); await worktreeUnit?.close(); await cleanupUnit?.close(); await facility?.closeAll(); await backend?.close();
    for (const handle of running) handle.terminate(); await Promise.allSettled([...running].map(handle => handle.done)); assert.equal(running.size, 0);
    assert.equal(resolve(root), root); assert.equal(await realpath(root), root); assert.equal(dirname(root), tmpBase); assert.ok(basename(root).startsWith('worktrees-cleanup-git-owned-')); await rm(root, { recursive: true, force: false });
  });
  owner.provide('subprocess', subprocessProvider(root, gitExecutable, calls, running));
  owner.provide('fs', {
    async resolve(path: string) { const canonical = await realpath(path); assert.ok(within(root, canonical)); return { path: canonical }; },
    processPath: (target: { path: string }) => target.path,
    processPathFromHostPath: (path: string) => isAbsolute(path) && within(root, resolve(path)) ? resolve(path) : undefined,
  });
  owner.provide('sandboxPolicy', { resolve() { assert.fail('Unattended verified cleanup must not borrow Agent or Host-default sandbox authority'); } });
  let creations = 0, resumes = 0, resolves = 0;
  owner.provide('agents', { list: () => [], get: () => undefined, create() { creations++; assert.fail('Cleanup cannot invent an Agent'); }, resume() { resumes++; assert.fail('Cleanup cannot revive the missing-cwd Agent'); } });
  owner.provide('sessionController', { resolveAgent() { resolves++; assert.fail('Reopen info must read removed history cold'); } });
  const config = { root: managed, gitExecutable, defaultRemote: 'origin', defaultBranch: 'main', commandTimeoutMs: 15000, fetchTimeoutMs: 15000, operationTimeoutMs: 120000, maxSnapshotBytes: 4 * 1024 * 1024, maxFiles: 1000, maxRefBytes: 1024 * 1024 };
  const executor = createMaintenanceExecutor(owner, config, () => undefined);
  const git = async (cwd: string, ...args: string[]) => (await executor({ cwd, args: ['-c', 'user.name=Fixture User', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${join(root, 'empty-hooks')}`, '-c', 'core.autocrlf=false', ...args], env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }, timeoutMs: 15000, maxBytes: 4 * 1024 * 1024 })).stdout;
  await git(local, 'init', '-b', 'main'); await git(local, 'config', 'core.autocrlf', 'false');
  await writeFile(join(project, 'file.txt'), 'base committed bytes\n'); await writeFile(join(local, '.gitignore'), 'ignored-*.bin\n');
  await git(local, 'add', '.'); await git(local, 'commit', '-m', 'fixture base');
  const engine = new GitOperations(executor, config), repository = await engine.discover(project), id = randomUUID(), operationId = randomUUID();
  const parent = join(managed, createHash('sha256').update(repository.commonDir).digest('hex').slice(0, 24), id); await mkdir(parent, { recursive: true });
  const created = await engine.create({ id, repository, destination: join(parent, `worktree-${id}`), branchSource: 'local', localBranch: 'main', localOid: repository.head, baseRef: `refs/dsh-worktrees/${id}/base` });
  const recordedAt = Date.now(), now = recordedAt + 20 * 86400000, sourceId = SessionId(randomUUID());
  const record: WorktreeRecord = { id, operationId, repoRoot: repository.root, commonDir: repository.commonDir, projectSubdir: 'project', ...created, remote: 'local', remoteIdentity: 'fixture-local-repository', remoteBranch: 'main', branchSource: 'local', localBranch: 'main', createdAt: recordedAt, sessionIds: [sourceId], workspaceId: randomUUID(), branch: null, protected: false, archived: true, state: 'ready', error: null };
  const branch = `worktree/cleanup-smoke-${id}`; const named = await engine.createBranch(record, branch); record.branch = named.branch;
  await writeFile(join(created.effectiveCwd, 'file.txt'), 'committed isolated advancement\n'); await git(created.checkoutRoot, 'add', 'project/file.txt'); await git(created.checkoutRoot, 'commit', '-m', 'isolated advancement');
  const committedHead = (await git(created.checkoutRoot, 'rev-parse', 'HEAD')).toString().trim(); assert.notEqual(committedHead, record.baseOid);
  await writeFile(join(created.effectiveCwd, 'file.txt'), 'staged isolated unsaved bytes\n'); await git(created.checkoutRoot, 'add', 'project/file.txt');
  await writeFile(join(created.effectiveCwd, 'file.txt'), 'unstaged isolated unsaved bytes\n'); await writeFile(join(created.checkoutRoot, 'untracked.txt'), 'discarded unsaved untracked bytes\n'); await writeFile(join(created.checkoutRoot, 'ignored-cache.bin'), 'discarded ignored bytes\n');
  await writeFile(join(project, 'file.txt'), 'staged Local bytes retained\n'); await git(local, 'add', 'project/file.txt');
  await writeFile(join(project, 'file.txt'), 'unstaged Local bytes retained\n'); await writeFile(join(local, 'untracked-local.txt'), 'Local untracked retained\n'); await writeFile(join(local, 'ignored-local.bin'), 'Local ignored retained\n');
  const localFiles = ['project/file.txt', '.gitignore', 'untracked-local.txt', 'ignored-local.bin'];
  const localBefore = { files: await Promise.all(localFiles.map(file => readFile(join(local, file)))), index: await readFile(join(repository.commonDir, 'index')), branch: await git(local, 'symbolic-ref', 'HEAD'), head: await git(local, 'rev-parse', 'HEAD'), status: await git(local, 'status', '--porcelain=v1', '-z', '--untracked-files=all') };
  const log = { header: { version: SESSION_FORMAT_VERSION, id: sourceId, createdAt: recordedAt, cwd: created.effectiveCwd, isSeeded: false }, events: [
    { type: 'turn/start', seq: 0, time: recordedAt, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: recordedAt, surfaceOp: 'append', data: { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Retained original history' }] } },
    { type: 'turn/end', seq: 2, time: recordedAt + 1, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', seq: 3, time: recordedAt + 2, data: { title: 'Post-turn title retained', messageSeqs: [], source: { kind: 'user' } } },
    { type: 'sandbox/mode', seq: 4, time: recordedAt + 3, data: { mode: 'read-only' } },
  ] };
  const logPath = join(root, 'source-history.json'); await writeFile(logPath, JSON.stringify(log)); const logBytes = await readFile(logPath);
  let observationDisposals = 0, writerCloses = 0; const writers = new Set<string>();
  owner.provide('sessionQuery', {
    async listSessions() { return [{ header: clone(log.header) }]; },
    async observeSession(id: string, options: { projectionMode: string }) { assert.equal(id, sourceId); assert.equal(options.projectionMode, 'all'); return { source: 'prepared', header: clone(log.header), inheritedEventCount: 0, events: clone(log.events), projections: { values: { inbox: { 'next-turn': [], 'next-step': [] }, sessionListMetadata: { blank: false, lastPromptAt: recordedAt } } }, [Symbol.dispose]() { observationDisposals++; } }; },
  });
  owner.provide('sessionPersistence', {
    async stat(id: string) { assert.equal(id, sourceId); return { header: clone(log.header), revision: 'fixture-original-generation' }; },
    async open(id: string, access: 'write') { assert.equal(id, sourceId); assert.equal(access, 'write'); assert.equal(writers.has(id), false); writers.add(id); return { id, header: clone(log.header), inheritedEventCount: 0,
      append() { assert.fail('GC cannot mutate original header or history'); }, async close() { writers.delete(id); writerCloses++; },
    }; },
  });
  new Storage(owner); backend = new JsonStorageBackend(join(root, 'domain-data')); owner.storage.backend.register('fixture-json', backend); facility = new DomainFacility(owner, { backend: 'fixture-json' });
  worktreeUnit = await facility.open(worktreeDomain); cleanupUnit = await facility.open(cleanupDomain);
  const worktrees = { worktrees: worktreeUnit.table('worktrees'), operations: worktreeUnit.table('operations'), close: () => required(worktreeUnit).close() };
  const store = { cleanup: cleanupUnit.table('cleanup'), reopens: cleanupUnit.table('reopens'), close: () => required(cleanupUnit).close() };
  await worktrees.worktrees.put(record.id, record);
  const movedConfig = { ...config, root: join(root, 'new-configured-destination') }; controller = new WorktreeController(owner, movedConfig, worktrees);
  // No deps.git: this exercises the default maintenance executor and real historical-root Git inspection/removal.
  cleanup = new WorktreeCleanup(owner, movedConfig, worktrees, store, controller, { now: () => now }); cleanup.start(false);
  assert.equal(historicalWorktreeRoot(record), managed); const beforeSweep = calls.length; await cleanup.sweep();
  const receipt = required(store.cleanup.get(record.id)); assert.ok(receipt.identity); assert.equal(receipt.phase, 'collected', JSON.stringify(receipt.reason)); assert.equal(receipt.identity.sourceMappingHash, '');
  assert.equal(receipt.identity.checkoutRoot, created.checkoutRoot); assert.equal(receipt.identity.head, committedHead); assert.equal(receipt.identity.branch, branch); assert.equal(receipt.identity.sourceRoot, local); assert.equal(receipt.identity.commonDir, repository.commonDir);
  assert.equal(required(worktrees.worktrees.get(record.id)).state, 'missing'); assert.equal(writers.size, 0); assert.equal(writerCloses, 1); assert.ok(observationDisposals >= 2);
  await assert.rejects(lstat(created.checkoutRoot), hasCode('ENOENT')); await assert.rejects(lstat(receipt.identity.adminDir), hasCode('ENOENT'));
  // Git uses forward slashes on Windows; compare canonical filesystem paths.
  const registrations = await Promise.all((await git(local, 'worktree', 'list', '--porcelain', '-z')).toString().split('\0').filter(value => value.startsWith('worktree ')).map(value => realpath(value.slice(9)))); assert.deepEqual(registrations, [local]);
  assert.deepEqual(await Promise.all(localFiles.map(file => readFile(join(local, file)))), localBefore.files); assert.deepEqual(await readFile(join(repository.commonDir, 'index')), localBefore.index);
  assert.deepEqual(await git(local, 'symbolic-ref', 'HEAD'), localBefore.branch); assert.deepEqual(await git(local, 'rev-parse', 'HEAD'), localBefore.head); assert.deepEqual(await git(local, 'status', '--porcelain=v1', '-z', '--untracked-files=all'), localBefore.status);
  assert.equal((await git(local, 'rev-parse', '--verify', record.baseRef)).toString().trim(), record.baseOid); assert.equal((await git(local, 'rev-parse', '--verify', `refs/heads/${branch}`)).toString().trim(), committedHead);
  assert.equal((await git(local, 'rev-parse', '--verify', required(receipt.recoveryRef))).toString().trim(), committedHead);
  for (const oid of receipt.identity.retainedHeads.filter(oid => oid !== committedHead)) assert.equal((await git(local, 'rev-parse', '--verify', `refs/dsh-worktrees/${id}/gc-retained/${oid}`)).toString().trim(), oid);
  assert.deepEqual(await readFile(logPath), logBytes); assert.deepEqual(log.header.cwd, created.effectiveCwd);
  const sweepCalls = calls.slice(beforeSweep); assert.ok(sweepCalls.some(call => call.argv.includes('remove') && call.argv.includes('--force') && call.argv.includes(created.checkoutRoot)));
  assert.equal(sweepCalls.some(call => call.argv.some(arg => ['reset', 'stash', 'prune', 'fetch', 'ls-remote', 'clone'].includes(arg))), false); assert.ok(sweepCalls.some(call => call.env.GIT_TERMINAL_PROMPT === '0'));
  const info = await cleanup.info(sourceId, new AbortController().signal); assert.ok(info.cleanup); assert.ok(info.repository); assert.ok(info.branches); assert.equal(info.cleanup.phase, 'collected'); assert.equal(info.originalFolder, project); assert.equal(info.repository.root, local); assert.equal(info.repository.branch, 'main'); assert.equal(info.continuationSessionId, null);
  assert.ok(info.branches.some(value => value.name === 'main' && value.oid === record.baseOid)); assert.ok(info.branches.some(value => value.name === branch && value.oid === committedHead));
  assert.equal(creations, 0); assert.equal(resumes, 0); assert.equal(resolves, 0); assert.deepEqual(await readFile(logPath), logBytes);
  await cleanup.close(); await controller.close(); await worktreeUnit.close(); await cleanupUnit.close();
  worktreeUnit = await facility.open(worktreeDomain); cleanupUnit = await facility.open(cleanupDomain);
  assert.equal(required(worktreeUnit.table('worktrees').get(id)).state, 'missing'); assert.deepEqual(cleanupUnit.table('cleanup').get(id), receipt); assert.equal(cleanupUnit.table('reopens').size, 0);
});
