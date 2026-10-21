import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { test, type TestContext } from 'node:test';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { GitProbe, gitProbeEnvironment } from '../src/git/probe.js';
import { parseGitContext, type GitContext } from '../src/git/context.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { candidateBlobName } from '../src/sync/cloud-repository.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { publicCloudError } from '../src/protocol.js';
import { sidKey } from '../src/import/claims.js';
import { batchRow, cloudSession, event, sessionHeader } from './helpers.js';
import { AcceptanceCloud } from './acceptance-helpers.js';
import { coordinatorFixture } from './import-coordinator-fixture.js';

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await execute('/usr/bin/git', args, { cwd, env: gitProbeEnvironment(), maxBuffer: 262_144 })).stdout.trim();
}
async function repo(cwd: string) {
  await git(cwd, 'init', '-b', 'receiving'); await git(cwd, 'config', 'user.name', 'Fixture'); await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(cwd, 'tracked.txt'), 'snapshot B\n'); await git(cwd, 'add', 'tracked.txt'); await git(cwd, 'commit', '-m', 'B');
  return git(cwd, 'rev-parse', 'HEAD');
}
async function fixture(t: TestContext, localRepo = true, dirty: 'clean' | 'dirty' | 'unknown' = 'clean') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-code-consent-')));
  let close: (() => Promise<void>) | undefined;
  t.after(async () => { await close?.(); assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: false }); });
  const cloud = new AcceptanceCloud(), host = await coordinatorFixture(join(root, 'host'), cloud); close = () => host.close();
  const oid = localRepo ? await repo(host.cwd) : 'b'.repeat(40);
  const source = join(root, 'remote'); await mkdir(source);
  const sid = SessionId(`session-${randomUUID()}`), operationId = randomUUID();
  const queued = createUserMessage({ content: [{ type: 'text', text: 'Only explicitly consented code may run this original pending prompt.' }], source: { kind: 'user' } });
  const header = sessionHeader({ id: sid, cwd: source, delegationDepth: 0 });
  const events = [event(0, 'session/title', { title: 'Code comparison', messageSeqs: [], source: { kind: 'user' } }),
    event(1, 'working-directory/change', { cwd: source }), { seq: 2, time: 1002, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [queued] } }] as SessionEvent[];
  const binding = headerHash(header, 0), genesis = genesisHash(sid, 1, binding), chain = chainEvents(genesis, events), blobName = candidateBlobName(sid, 1, 0, 1, chain.payloadHash);
  const row = batchRow(sid, 1, 0, { ...chain, blobName });
  const sourceGit: GitContext = { v: 2, observation: { deviceId: 'sender', observedAt: 1, generation: 1, headerHash: binding, eventCount: events.length, chainHash: chain.chainHash },
    repository: { root: source, objectFormat: 'sha1', worktree: false }, current: { branchRef: 'refs/heads/source-generated-hint', headOid: oid, detached: false, unborn: false, dirty } };
  assert.ok(parseGitContext(sourceGit));
  await cloud.putCandidate(blobName, gzipSync(payloadBytes(events)), {});
  await cloud.createManifest(cloudSession({ sessionId: sid, headerJson: JSON.stringify(header), headerHash: binding, cwd: source, eventCount: events.length, headSeq: events.length - 1, headHash: chain.headHash, chainHash: chain.chainHash,
    lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, lastBatchBlobName: blobName, gitJson: JSON.stringify(sourceGit) }));
  cloud.rows.set(row.rowKey, { entity: row, etag: 'fixture-row' });
  const context = () => ({ origin: 'rpc' as const, signal: new AbortController().signal });
  const plan = async () => {
    const result = await host.coordinator.execute({ action: 'plan-import', sessionId: sid, generation: 1, operationId, gitContextVersion: 2,
      destination: { kind: 'local', folderPath: host.cwd }, mapping: { remotePlatform: 'linux', remotePrefix: source } }, context());
    if (result.kind !== 'import-plan') return assert.fail('Expected reviewed plan.');
    return result;
  };
  const noEffects = async () => { assert.equal(await host.guard.journal.read(sid), undefined); assert.equal(host.local.getSession(sid), undefined); assert.equal(await host.ctx.sessionPersistence.stat(sid), undefined); assert.equal(host.ctx.agents.get(sid), undefined); assert.equal(host.llmCalls, 0); assert.equal(cloud.activeLeases.size, 0); };
  return { root, cloud, host, sourceGit, oid, sid, operationId, queued, context, plan, noEffects };
}

test('Local known clean exact B displays receiving branch/HEAD and branch-only source hint difference needs no code acknowledgment', { timeout: 30_000 }, async t => {
  const f = await fixture(t); const before = await readFile(join(f.host.cwd, '.git', 'index'));
  const plan = await f.plan();
  assert.equal(plan.codeMismatch, false); assert.equal(plan.branch, 'refs/heads/receiving'); assert.equal(plan.baseOid, f.oid);
  assert.ok(plan.warnings.includes('local-working-tree-clean')); assert.ok(plan.warnings.includes('local-branch-hint-differs'));
  await f.noEffects();
  const result = await f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true }, f.context());
  assert.equal(result.kind, 'import-operation'); if (result.kind === 'import-operation') assert.equal(result.phase, 'ready', JSON.stringify(result));
  assert.equal((await f.host.guard.journal.read(f.sid))?.codeMismatchAcknowledged, undefined);
  assert.equal(await git(f.host.cwd, 'rev-parse', 'HEAD'), f.oid); assert.equal(await git(f.host.cwd, 'symbolic-ref', 'HEAD'), 'refs/heads/receiving');
  assert.deepEqual(await readFile(join(f.host.cwd, '.git', 'index')), before, 'comparison/import never rewrites the Git index');
  assert.equal(f.host.llmCalls, 0); assert.equal(f.host.ctx.agents.get(f.sid), undefined);
});

for (const localState of ['dirty', 'different-head'] as const) {
  test(`Local receiving ${localState} displays actual current code and requires acknowledgment before effects`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    await writeFile(join(f.host.cwd, 'tracked.txt'), 'receiving differs\n');
    if (localState === 'different-head') { await git(f.host.cwd, 'add', 'tracked.txt'); await git(f.host.cwd, 'commit', '-m', 'C'); }
    const actual = await git(f.host.cwd, 'rev-parse', 'HEAD'), plan = await f.plan();
    assert.equal(plan.codeMismatch, true); assert.equal(plan.baseOid, actual);
    assert.ok(plan.warnings.includes(localState === 'dirty' ? 'local-working-tree-dirty' : 'local-code-snapshot-mismatch'));
    await assert.rejects(f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true }, f.context()), error => publicCloudError(error).code === 'CONFIRM_REQUIRED');
    await f.noEffects();
  });
}

for (const sourceDirty of ['dirty', 'unknown'] as const) {
  test(`Local matching committed B but source ${sourceDirty} is unverified and cannot commit without separate code acknowledgment`, { timeout: 30_000 }, async t => {
    const f = await fixture(t, true, sourceDirty), plan = await f.plan();
    assert.equal(plan.codeMismatch, true); assert.equal(plan.baseOid, f.oid); assert.ok(plan.warnings.includes(`source-working-tree-${sourceDirty}`));
    await assert.rejects(f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true }, f.context()), error => publicCloudError(error).code === 'CONFIRM_REQUIRED');
    await f.noEffects();
  });
}

test('Local non-Git receiving folder reports unknown rather than source B, and code acknowledgment is persisted before Ready/Continue', { timeout: 30_000 }, async t => {
  const f = await fixture(t, false, 'dirty'), plan = await f.plan();
  assert.equal(plan.codeMismatch, true); assert.equal(plan.branch, undefined); assert.equal(plan.baseOid, undefined);
  assert.ok(plan.warnings.includes('local-code-unverified')); assert.ok(plan.warnings.includes('source-working-tree-dirty'));
  await assert.rejects(f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true }, f.context()), error => publicCloudError(error).code === 'CONFIRM_REQUIRED');
  await f.noEffects();
  const result = await f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true, acknowledgeCodeMismatch: true }, f.context());
  if (result.kind !== 'import-operation') return assert.fail('operation');
  assert.equal(result.phase, 'ready'); assert.equal((await f.host.guard.journal.read(f.sid))?.codeMismatchAcknowledged, true); assert.equal(f.host.llmCalls, 0);
  await f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: result.revision, confirm: true, acknowledgePendingInput: true }, f.context());
  const agent = f.host.ctx.agents.get(f.sid); assert.ok(agent); await agent.whenIdle(); assert.equal(f.host.llmCalls, 1);
});

for (const drift of ['head', 'dirty', 'source-dirty', 'source-unknown'] as const) {
  test(`Local clean B review refuses ${drift} drift before reservation/native effects even if old acknowledgment is supplied`, { timeout: 30_000 }, async t => {
    const f = await fixture(t), plan = await f.plan(); assert.equal(plan.codeMismatch, false);
    if (drift === 'head' || drift === 'dirty') {
      await writeFile(join(f.host.cwd, 'tracked.txt'), 'changed after review\n');
      if (drift === 'head') { await git(f.host.cwd, 'add', 'tracked.txt'); await git(f.host.cwd, 'commit', '-m', 'C'); }
    } else {
      const stored = await f.cloud.getManifest(f.sid); assert.ok(stored);
      const fresh = { ...f.sourceGit, observation: { ...f.sourceGit.observation, observedAt: Date.now() }, current: { ...f.sourceGit.current, dirty: drift === 'source-dirty' ? 'dirty' as const : 'unknown' as const } };
      await f.cloud.updateManifest({ ...stored.entity, gitJson: JSON.stringify(fresh) }, stored.etag);
    }
    await assert.rejects(f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true, acknowledgeCodeMismatch: true }, f.context()));
    await f.noEffects();
  });
}

test('pre-fix saved Ready Local review without receiving fingerprint cannot infer consent or reuse a current Native activation', { timeout: 30_000 }, async t => {
  const f = await fixture(t), plan = await f.plan();
  const result = await f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true }, f.context());
  if (result.kind !== 'import-operation') return assert.fail('operation');
  assert.equal(result.phase, 'ready');
  await f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: result.revision, confirm: true, acknowledgePendingInput: true }, f.context());
  const agent = f.host.ctx.agents.get(f.sid); assert.ok(agent); await agent.whenIdle(); assert.equal(f.host.llmCalls, 1);
  const current = await f.host.coordinator.execute({ action: 'import-operation', sessionId: f.sid, operationId: f.operationId }, f.context());
  if (current.kind !== 'import-operation') return assert.fail('current operation');
  const file = join(f.host.root, 'import', 'plans', `${sidKey(f.operationId)}.json`);
  const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  delete saved.localGitFingerprint; delete saved.localGitJson;
  await writeFile(file, JSON.stringify(saved));
  const admission = await f.host.coordinator.execute({ action: 'import-admission', sessionId: f.sid }, f.context());
  if (admission.kind !== 'import-admission') return assert.fail('admission');
  assert.equal(admission.ready, false); assert.equal(admission.continued, false);
  await assert.rejects(f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: current.revision, confirm: true, acknowledgePendingInput: true }, f.context()));
  const message = createUserMessage({ content: [{ type: 'text', text: 'A saved old review cannot authorize this cached Agent.' }], source: { kind: 'user' } });
  agent.send(message, 'next-turn', true); await agent.whenIdle();
  assert.equal(f.host.llmCalls, 1); assert.ok(agent.inbox.nextTurn.some(item => item.id === message.id));
  const status = await f.host.coordinator.execute({ action: 'import-operation', sessionId: f.sid, operationId: f.operationId }, f.context());
  if (status.kind === 'import-operation') { assert.equal(status.phase, 'recovery-required'); assert.equal(status.reason, 'code-review-required'); }
});

test('nested header scope remains safe unavailable rather than scanning its repository ancestor', async t => {
  const f = await fixture(t); const child = join(f.host.cwd, 'nested');
  const captured = await new GitProbe({ timeoutMs: 2_000 }).capture(child, child, 'receiver', f.sourceGit.observation);
  assert.equal(captured, null);
});
