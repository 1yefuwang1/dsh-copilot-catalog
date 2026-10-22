import { createRequire } from 'node:module';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session';
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { LlmRuntime, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import { Storage } from '@deepseek-ai/dsh-storage';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { LocalStore } from '../src/local/store.js';
import { Config } from '../src/config.js';
import { DestinationImportCoordinator, type DestinationImportRuntime } from '../src/import/coordinator.js';
import { DestinationBindings } from '../src/import/bindings.js';
import type { ImportGuardV1 } from '../src/import/guard.js';
import { Importer } from '../src/sync/importer.js';
import { ImportService } from '../src/sync/import-service.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { PersistenceSessionSource } from '../src/sync/session-source.js';
import { ProjectionWarmer } from '../src/sync/projection-warmer.js';
import { Uploader } from '../src/sync/uploader.js';
import { SyncService } from '../src/sync/service.js';
import { registerSyncAdmission } from '../src/sync/lifecycle.js';
import { sha256Hex } from '../src/sync/canonical.js';
import { GitProbe } from '../src/git/probe.js';
import { AcceptanceCloud, route } from './acceptance-helpers.js';

class ExactQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw new Error('No search in fixture.'); }
  async searchEvents(): Promise<never> { throw new Error('No search in fixture.'); }
}
class TextAttachments extends AttachmentStore {
  readonly imageLimits = { maxImageBytes: 1, maxImageDimension: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, mediaTypes: [] };
  async validateImage(): Promise<never> { throw new Error('No image intake.'); }
  async saveImage(): Promise<never> { throw new Error('No image intake.'); }
  async readImage(): Promise<never> { throw new Error('No image intake.'); }
}
export async function coordinatorFixture(root: string, cloud: AcceptanceCloud, options: { workspaceFailure?: boolean; queryFactory?: (ctx: Context) => SessionQueryEngine; afterBoot?: (ctx: Context, guard: ImportGuardV1) => Promise<void> } = {}) {
  await mkdir(root, { recursive: true }); root = await realpath(root);
  const cwd = join(root, 'destination'); await mkdir(cwd); await mkdir(join(cwd, 'nested'));
  const configPath = join(root, 'cordis.json'), patchPath = join(root, 'user-profile.patch.json');
  const logs = join(root, 'logs'), guardRoot = join(root, 'import');
  const baseEntries = [
    { id: 'session-persistence-jsonl', name: import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), config: { root: logs, compression: 'none' } },
    { id: 'session', name: import.meta.resolve('@deepseek-ai/dsh-session') },
    { id: 'agent-loop', name: import.meta.resolve('@deepseek-ai/dsh-agent-loop'), config: { agents: [] } },
    { id: 'working-directory', name: import.meta.resolve('@deepseek-ai/dsh-working-directory'), config: { defaultDirectory: cwd } },
    ...(!options.workspaceFailure ? [{ id: 'workspace', name: import.meta.resolve('@deepseek-ai/dsh-workspace') }] : []),
  ];
  // The public profile preflight composes COMPLETE bundle/user patches over an
  // empty root; a nonempty leaf config is intentionally not profile mode.
  await writeFile(configPath, '[]');
  await writeFile(patchPath, JSON.stringify([
    { id: 'session-persistence-jsonl', disabled: true },
    { id: 'session', inject: ['sessionPersistence', 'cloudImportReadinessV1'] },
    { id: 'agent-loop', inject: ['sessionPersistence', 'cloudImportReadinessV1'] },
    { insert: [
      { id: 'import-guard', name: '@1yefuwang1/dsh-azure-sync/import-guard', config: { root: guardRoot } },
      { id: 'import-persistence', name: '@1yefuwang1/dsh-azure-sync/import-persistence', config: { root: logs, compression: 'none' } },
    ] },
  ]));
  let backend!: JsonStorageBackend, facility!: DomainFacility, llmCalls = 0;
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-api-session-controller'));
  const peer = async (name: string) => import(pathToFileURL(require.resolve(name)).href);
  const prepare = async (ctx: Context) => {
    ctx.provide('profileContext', { name: 'fixture', dir: root, patchPath, installAnchor: root, cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined });
    new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx); new LlmRuntime(ctx);
    class Adapter extends LlmAdapter { async *stream(): AsyncIterable<StreamChunk> { llmCalls++; yield { type: 'finish', reason: { kind: 'stop' } }; } }
    ctx.llm.registerAdapter(['fixture'], new Adapter() as never);
    ctx.provide('fs', {
      async resolve(path: string, opts?: { cwd?: string }) { return { path: await realpath(isAbsolute(path) ? path : resolve(opts?.cwd ?? cwd, path)) }; },
      async stat(value: { path: string }) { const info = await stat(value.path); return { type: info.isDirectory() ? 'directory' : 'file' }; }, processPath: (value: { path: string }) => value.path,
    });
    new Storage(ctx); backend = new JsonStorageBackend(join(root, 'domain')); ctx.storage.backend.register('fixture', backend);
    facility = new DomainFacility(ctx, { backend: 'fixture' }); ctx.provide('storageDomain', facility);
    await ctx.plugin((await peer('@deepseek-ai/dsh-typert-registry')).default);
    await ctx.plugin((await peer('@deepseek-ai/dsh-agent-default-model')).default, route);
    await ctx.plugin((await peer('@deepseek-ai/dsh-commands')).default);
    new TextAttachments(ctx);
    ctx.provide('connection', { fetch: { register: () => () => {} } });
    await ctx.plugin((await peer('@deepseek-ai/dsh-client-file-upload')).default);
  };
  const ctx = await boot('import-integration', configPath, [{ insert: baseEntries }, ...loadOverlayPatches('import-integration', patchPath)], prepare, new URL('../package.json', import.meta.url).href);
  if (!(ctx.get('cloudImportReadinessV1') as ImportGuardV1 | undefined)?.isGuardedPersistence(ctx.sessionPersistence.identity)) {
    const diagnostic = [...ctx.loader.entries()].map(entry => ({ id: entry.id, name: entry.options.name, disabled: entry.disabled, state: entry.fiber?.state }));
    await ctx.fiber.dispose(); await facility.closeAll(); await backend.close();
    throw new Error(`Public profile did not mount guarded persistence: ${JSON.stringify(diagnostic)}`);
  }
  const query = options.queryFactory?.(ctx) ?? new ExactQuery(ctx); const native = new SessionController(ctx, { nativeOpen: false });
  const local = new LocalStore(facility); await local.open();
  const guard = ctx.get('cloudImportReadinessV1') as ImportGuardV1;
  await options.afterBoot?.(ctx, guard);
  let runtime: DestinationImportRuntime | undefined, runtimeCalls = 0;
  const bindings = new DestinationBindings(local, guard, () => runtime?.scope);
  const source = new PersistenceSessionSource(ctx.sessionPersistence), config = Config({ maxBatchEvents: 2 });
  const snapshots = new Map<string, unknown>();
  const projection = new ProjectionWarmer({ query, cache: {
    coldSnapshot(header: SessionHeader, inherited: number, events: readonly SessionEvent[]) { snapshots.set(header.id, ctx.sessionProjections.restore({}, events, 0 as never, header, inherited as never).snapshot); },
    cachedSnapshot(header: SessionHeader) { return snapshots.get(header.id); },
  } as never });
  const reader = new RemoteSessionReader(cloud.asRepository(), { scope: cloud.historyScope, maxCompressedBytes: 1_048_576, maxExpandedBytes: config.maxBatchBytes, maxEvents: config.maxEventsPerSession });
  const importer = new Importer({ config, local, persistence: ctx.sessionPersistence, repository: cloud.asRepository(), reader,
    cwdBinding: (sid) => bindings.binding(sid), projection, now: Date.now });
  const localProbe = new GitProbe({ executable: config.gitExecutable, timeoutMs: config.gitTimeoutMs, defaultRemote: config.defaultRemote });
  const coordinator = await DestinationImportCoordinator.create({ ctx, guard, local, settingsKey: () => sha256Hex('fixture-settings'), current: () => runtime,
    observeLocalGit: (cwd, scopeRoot, anchor, signal) => localProbe.capture(cwd, scopeRoot, 'receiver', anchor, undefined, AbortSignal.any([signal, AbortSignal.timeout(config.gitTimeoutMs)])),
    runtime: async signal => { runtimeCalls++; signal.throwIfAborted(); if (!runtime) throw new Error('No runtime'); return runtime; } });
  const imports = new ImportService(importer, undefined, undefined, coordinator);
  const uploader = new Uploader({ config, source, repository: cloud.asRepository(), reader, local, leases: cloud.leases('receiver'), deviceId: 'receiver', platform: 'linux', cwdBinding: (sid, record) => bindings.binding(sid, record), destinationReady: sid => bindings.ready(sid), now: Date.now });
  const service = new SyncService({ uploader, local, imports, reader, source, repository: cloud.asRepository(), agents: ctx.agents, destinationReady: sid => bindings.ready(sid), now: Date.now });
  const coreAbort = new AbortController();
  runtime = { scope: sha256Hex('fixture-account'), signal: coreAbort.signal, config, importer, reader, service, repository: cloud.asRepository() };
  const admission = registerSyncAdmission({ ctx, local, ownership: sid => service.ensureOwnership(sid), now: Date.now });
  return { ctx, cwd, root, logs, guard, coordinator, local, native, service, source, runtime, query,
    get llmCalls() { return llmCalls; }, get runtimeCalls() { return runtimeCalls; },
    async close() { coreAbort.abort(); admission(); await coordinator.close(); await service.close(); await ctx.fiber.dispose(); await local.close(); await facility.closeAll(); await backend.close(); },
  };
}
