import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient } from '@azure/data-tables';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import * as Worktrees from '@1yefuwang1/dsh-worktrees';
import type { SessionResult, WorktreeSourceContext } from '@1yefuwang1/dsh-worktrees';
import * as AzurePlugin from '../src/index.js';
import { Config } from '../src/config.js';
import { localDomain } from '../src/local/store.js';
import { localSessionRecordSchema } from '../src/schema.js';
import { CloudRepository } from '../src/sync/cloud-repository.js';
import { BlobStore } from '../src/azure/blob.js';
import { TableStore } from '../src/azure/table.js';
import { decodeGitContextJson } from '../src/git/context.js';
import { nativeHost, route } from './import-native-fixture.js';
import { fixtureGit, fixtureGitExecutable, fixtureInside, FixtureGitProcesses, type FixtureProcessCall } from './managed-git-fixture.js';
import { startAzurite } from './azurite-helpers.js';

/** Actual index.apply + normal managed creation + actual first On/SDK HTTP.
 * Azurite is only the storage transport. No injected capture callback, synthetic
 * GitProbe context, previous manifest creationBase, model call or cloud-A rescue.
 */
test('Cloud-Off normal managed creation captures A/upstream; descendant cwd FIRST On publishes original A with current B through production index', { timeout: 120000, skip: process.platform === 'win32' }, async t => {
  const git = await fixtureGitExecutable(); assert.ok(git, 'This real source-capture gate requires installed Git.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-first-on-'))), repository = join(root, 'repository'), managed = join(root, 'managed');
  await mkdir(repository); await mkdir(join(root, 'empty-home')); await mkdir(join(root, 'empty-config')); await mkdir(join(repository, 'nested'));
  const emulator = await startAzurite();
  const host = await nativeHost(join(root, 'host'), repository);
  const scopes: Array<ReturnType<typeof host.ctx.plugin>> = [];
  let actor: AgentHandle | undefined;
  const reference = `FIRST_ON_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  assert.equal(process.env[reference], undefined); process.env[reference] = emulator.connection();
  t.after(async () => {
    for (const scope of scopes.reverse()) await scope.dispose(); delete process.env[reference];
    await actor?.dispose(); await host.close(); await emulator.close();
    assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); assert.ok(root.startsWith(join(await realpath(tmpdir()), 'git-first-on-')));
    await rm(root, { recursive: true, force: false });
  });
  const setup = (...args: string[]) => fixtureGit(root, git, repository, args);
  await setup('init', '-b', 'release'); await writeFile(join(repository, 'file.txt'), 'original creation A\n'); await writeFile(join(repository, 'nested', 'keep.txt'), 'nested tracked directory\n');
  await setup('add', '.'); await setup('commit', '-m', 'A'); const a = await setup('rev-parse', 'HEAD');
  const url = 'https://example.invalid/repository.git';
  await setup('remote', 'add', 'origin', url); await setup('config', 'branch.release.remote', 'origin'); await setup('config', 'branch.release.merge', 'refs/heads/dev'); await setup('update-ref', 'refs/remotes/origin/dev', a);
  // Let the PUBLIC Worktrees plugin own its real project domain; the base native
  // helper's standalone project reader is not the component under test here.
  await host.projectController.close(); await host.projectStore.close();
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-api-session-controller'));
  const sandbox = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-sandbox-policy')).href), approval = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-user-approval')).href);
  const policy = new sandbox.SandboxPolicyService(host.ctx, { mode: 'read-only', workspaceRoot: repository }); new approval.ApprovalService(host.ctx, { policy: 'ask' });
  Object.assign(host.ctx.get('fs')!, { processPathFromHostPath: (path: string) => isAbsolute(path) && fixtureInside(root, resolve(path)) ? resolve(path) : undefined });
  const calls: FixtureProcessCall[] = []; new FixtureGitProcesses(host.ctx, root, git, calls);
  const worktrees = host.ctx.plugin(Worktrees, { root: managed, namingEnabled: false, cleanupEnabled: false, commandTimeoutMs: 15000, operationTimeoutMs: 120000 }); scopes.push(worktrees); await worktrees.await(); assert.equal(worktrees.state, 2);
  const cloud = host.ctx.plugin(AzurePlugin, Config({ auth: 'connection-string', connectionRef: reference, allowInsecure: true, defaultEnabled: false, pullOnStartup: false, pollSeconds: 30, maxRetries: 0, requestTimeoutMs: 5000, maxBatchEvents: 4, gitTimeoutMs: 20000 })); scopes.push(cloud); await cloud.await(); assert.equal(cloud.state, 2);
  const local = host.facility.get(localDomain.name); assert.ok(local);
  const record = (id: string) => { const value = local.table('sessions').get(id); return value === undefined ? undefined : localSessionRecordSchema.parse(value); };
  const blob = BlobServiceClient.fromConnectionString(emulator.connection()).getContainerClient('dsh-state');
  const table = TableClient.fromConnectionString(emulator.connection(), 'dshstatesync', { allowInsecureConnection: true });
  const remote = new CloudRepository(new BlobStore(blob), new TableStore(table));
  actor = await host.ctx.agents.create({ sessionId: SessionId(`permission-${randomUUID()}`), meta: { cwd: repository }, agentOptions: route });
  sandbox.setSandboxMode(actor.agent.session, 'danger-full-access'); await host.ctx.sessions.flush(actor.agent.session);
  assert.equal(policy.defaultMode, 'read-only'); assert.equal(policy.resolve({ session: actor.agent.session }).mode, 'danger-full-access');
  const created = await host.ctx.tools.execute({ name: 'git_worktree', callId: `normal-create-${randomUUID()}` as never, arguments: { action: 'create', operationId: randomUUID(), repoPath: repository, branchSource: 'local', localBranch: 'release', localOid: a, sourceSessionId: actor.agent.id, sessionMode: 'new' }, agent: actor.agent, signal: new AbortController().signal });
  assert.equal(created.isError, false, JSON.stringify(created));
  const result = created.value as unknown as { v: number; ok: boolean; data: SessionResult }; assert.equal(result.ok, true);
  const managedId = result.data.sessionId, worktree = result.data.worktree, agent = host.ctx.agents.get(SessionId(managedId)); assert.ok(agent);
  assert.equal(worktree.baseOid, a); assert.equal(worktree.branchSource, 'local'); assert.equal(agent.session.header.cwd, worktree.effectiveCwd);
  assert.equal(agent.session.snapshotEvents().some(value => value.type === 'turn/start' || value.type === 'user/message'), false, 'normal creation needs no first message or model');
  assert.equal(host.llmCalls, 0); assert.equal(record(managedId), undefined, 'Cloud Off is untracked, not a preseeded opted-in row');
  const original = await host.ctx.worktreeImportPlacement.sourceContext(managedId, worktree.effectiveCwd, new AbortController().signal);
  const expected: NonNullable<WorktreeSourceContext['creationBase']> = { kind: 'local', ref: 'refs/heads/release', oid: a, upstreamAtCreation: { ref: 'refs/heads/dev', remote: { name: 'origin', sanitizedUrl: url } } };
  assert.deepEqual(original?.creationBase, expected, 'actual normal creation kernel/index callback persisted the original source facts while Off');
  // Configuration AFTER capture must never retroactively rewrite the creation
  // upstream. The generated current branch has its OWN actual upstream at B.
  await setup('config', 'branch.release.merge', 'refs/heads/changed-after-creation');
  const inManaged = (...args: string[]) => fixtureGit(root, git, worktree.checkoutRoot, args);
  await writeFile(join(worktree.checkoutRoot, 'file.txt'), 'current checkout B\n'); await inManaged('add', '.'); await inManaged('commit', '-m', 'B'); const b = await inManaged('rev-parse', 'HEAD'); assert.notEqual(a, b);
  assert.ok(worktree.branch); await inManaged('config', `branch.${worktree.branch}.remote`, 'origin'); await inManaged('config', `branch.${worktree.branch}.merge`, 'refs/heads/feature'); await inManaged('update-ref', 'refs/remotes/origin/feature', b);
  await host.ctx.workingDirectory.set(agent, join(worktree.checkoutRoot, 'nested')); await host.ctx.sessions.flush(agent.session);
  assert.equal(agent.session.header.cwd, worktree.effectiveCwd); assert.equal(host.ctx.workingDirectory.get(agent.session), join(worktree.checkoutRoot, 'nested'));
  assert.equal(record(managedId), undefined); assert.equal(host.llmCalls, 0);
  assert.equal(await blob.exists(), false, 'Off + normal creation/cwd edits never publish storage infrastructure');
  assert.equal(await remote.getManifest(managedId), undefined, 'no previous cloud A exists to rescue the first observation');
  const on = await host.ctx.commands.execute(agent, '/cloud on', [], new AbortController().signal); assert.ok(on); assert.equal(on.result.kind, 'success', on.result.text);
  const published = await remote.getManifest(managedId); assert.ok(published, 'FIRST On produced the first manifest, not a preserved previous A');
  const context = decodeGitContextJson(published.entity.gitJson); assert.equal(context?.v, 2, JSON.stringify(published.entity)); if (context?.v !== 2) return;
  assert.equal(published.entity.generation, 1);
  assert.equal(context.current.headOid, b); assert.equal(context.current.branchRef, `refs/heads/${worktree.branch}`);
  assert.deepEqual(context.current.upstream, { kind: 'remote', ref: 'refs/heads/feature', remote: { name: 'origin', sanitizedUrl: url } });
  assert.deepEqual(context.creationBase, expected, 'first publication must receive original A from actual immutable-header source lookup and descendant checkout validation');
  assert.equal(context.observation.headerHash, published.entity.headerHash); assert.equal(context.observation.generation, published.entity.generation);
  assert.equal(context.observation.eventCount, published.entity.eventCount); assert.equal(context.observation.chainHash, published.entity.chainHash);
  assert.equal(record(managedId)?.enabled, true); assert.equal(host.llmCalls, 0);
  assert.equal(calls.some(call => call.argv.includes('fetch') || call.argv.includes('ls-remote')), false, 'normal local creation never contacted the advisory network remote');
  assert.equal(agent.session.snapshotEvents().some(value => value.type === 'user/message'), false);
});
