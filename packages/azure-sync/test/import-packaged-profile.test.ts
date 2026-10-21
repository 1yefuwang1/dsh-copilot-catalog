import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { auditStartupEntries, loadOverlayPatches, mountRootInclude, StartupError } from '@deepseek-ai/dsh-app-boot';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { headerHash } from '../src/sync/chain.js';
import type { ImportGuardV1 } from '../src/import/guard.js';
import type { SidClaim } from '../src/import/claims.js';
import type { ImportReservation } from '../src/import/journal.js';
import { coldReadJsonl, Config as JsonlConfig } from '../src/import/persistence.js';
import { sessionHeader } from './helpers.js';

async function profile(t: TestContext, mode: 'healthy' | 'missing-provider' | 'partial-backend-failure' | 'unsupported-journal') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'packaged-import-profile-')));
  const claims: SidClaim[] = []; let ctx: Context | undefined;
  t.after(async () => { for (const claim of claims) await claim.release(); await ctx?.fiber.dispose(); assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: false }); });
  const logs = join(root, 'logs'), cwd = join(root, 'destination'), guardRoot = join(root, 'import'); await mkdir(cwd);
  const config = join(root, 'cordis.json'), patchPath = join(root, 'persistent-user.patch.json'); await writeFile(config, '[]');
  if (mode === 'partial-backend-failure') await writeFile(logs, 'A file, not a native session directory.');
  if (mode === 'unsupported-journal') { await mkdir(join(guardRoot, 'journal'), { recursive: true }); await writeFile(join(guardRoot, 'journal', 'format.json'), JSON.stringify({ version: 2, protocol: 'destination-import-journal' })); }
  const base = [{ id: 'session-persistence-jsonl', name: import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), config: { root: logs, compression: 'none' } },
    { id: 'session', name: import.meta.resolve('@deepseek-ai/dsh-session') }, { id: 'agent-loop', name: import.meta.resolve('@deepseek-ai/dsh-agent-loop'), config: { agents: [] } }];
  await writeFile(patchPath, JSON.stringify([{ id: 'session-persistence-jsonl', disabled: true },
    { id: 'session', inject: ['sessionPersistence', 'cloudImportReadinessV1'] }, { id: 'agent-loop', inject: ['sessionPersistence', 'cloudImportReadinessV1'] },
    { insert: [{ id: 'import-guard', name: '@1yefuwang1/dsh-azure-sync/import-guard', config: { root: guardRoot } },
      { id: 'import-provider', name: mode === 'missing-provider' ? '@1yefuwang1/dsh-azure-sync/missing-import-export' : '@1yefuwang1/dsh-azure-sync/import-persistence', config: { root: logs, compression: 'none' } }] }]));
  ctx = new Context(); await ctx.plugin(Loader);
  ctx.baseUrl = new URL('../package.json', import.meta.url).href;
  ctx.provide('profileContext', { name: 'fixture', dir: root, patchPath, installAnchor: root, cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined });
  new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx); new LlmRuntime(ctx);
  await mountRootInclude(ctx, config, [{ insert: base }, ...loadOverlayPatches('packaged-test', patchPath)], new URL('../package.json', import.meta.url).href, 'packaged-test');
  await ctx.loader.await();
  return { ctx, root, logs, cwd, claims };
}

for (const mode of ['missing-provider', 'partial-backend-failure', 'unsupported-journal'] as const) {
  test(`ACTUAL package export + persistent complete profile fails before any Native raw/in-memory admission: ${mode}`, async t => {
    const f = await profile(t, mode);
    assert.equal([...f.ctx.loader.entries()].find(entry => entry.options.id === 'session-persistence-jsonl')?.disabled, true);
    assert.equal(f.ctx.get('sessionPersistence'), undefined, 'a partially mounted JSONL backend never leaks into outer reflection');
    assert.equal(f.ctx.get('sessions'), undefined); assert.equal(f.ctx.get('agentLoop'), undefined);
    await assert.rejects(f.ctx.agents.create({ sessionId: SessionId(`blocked-${randomUUID()}`), meta: { cwd: f.cwd } }), /factory/);
    assert.deepEqual(f.ctx.agents.list(), []);
    await assert.rejects(auditStartupEntries(f.ctx, 'packaged-test', () => undefined), StartupError);
  });
}

test('ACTUAL packaged provider fences journal-only SID and preserves ordinary buffered Native events through ordered guard unload', async t => {
  const f = await profile(t, 'healthy'); await auditStartupEntries(f.ctx, 'packaged-test');
  const guard = f.ctx.get('cloudImportReadinessV1') as ImportGuardV1;
  assert.equal(guard.isGuardedPersistence(f.ctx.sessionPersistence.identity), true);
  const sid = SessionId(`reserved-${randomUUID()}`), operationId = randomUUID(), header = sessionHeader({ id: sid, cwd: f.cwd, delegationDepth: 0 });
  const record: ImportReservation = { version: 1, operationId, requestHash: 'a'.repeat(64), target: { scope: 'fixture', sessionId: sid, generation: 1, headerHash: headerHash(header, 0), inheritedEventCount: 0, eventCount: 0, chainHash: 'b'.repeat(64) },
    intentId: randomUUID(), intentRevision: 0, revision: 0, mode: 'local', finalCwd: f.cwd, localHeaderHash: headerHash(header, 0), mapping: { id: randomUUID(), revision: 'c'.repeat(64), remotePlatform: 'linux', remotePrefix: '/remote', localRoot: f.cwd }, phase: 'reserved', effects: [], createdAt: 1, updatedAt: 1 };
  const coordinator = guard.registerCoordinator({ version: 1, ready: () => true });
  const claim = await guard.claims.acquire(sid, operationId); f.claims.push(claim); await coordinator.reserve(claim, record);
  await assert.rejects(f.ctx.agents.create({ sessionId: sid, meta: { cwd: f.root } }), /coordinator/);
  await assert.rejects(f.ctx.agents.resume({ resumeSessionId: sid }), /Continue/);
  assert.equal(await f.ctx.sessionPersistence.stat(sid), undefined); assert.equal(f.ctx.sessions.get(sid), undefined);
  const ordinaryId = SessionId(`ordinary-${randomUUID()}`);
  const ordinary = await f.ctx.agents.create({ sessionId: ordinaryId, meta: { cwd: f.cwd } });
  ordinary.agent.session.append('session/title', { title: 'Retained public bridge buffer', messageSeqs: [], source: { kind: 'user' } });
  const guardEntry = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'import-guard'); assert.ok(guardEntry);
  await guardEntry.update({ disabled: true }); await f.ctx.loader.await();
  assert.equal(f.ctx.get('sessions'), undefined); assert.equal(f.ctx.get('sessionPersistence'), undefined); assert.deepEqual(f.ctx.agents.list(), []);
  const cold = await coldReadJsonl(JsonlConfig({ root: f.logs, compression: 'none' }), ordinaryId);
  assert.ok(cold.events.some(event => event.type === 'session/title' && event.data.title === 'Retained public bridge buffer'));
  await ordinary.dispose(); coordinator.unregister();
});
