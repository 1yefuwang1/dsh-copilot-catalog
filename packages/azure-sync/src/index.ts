/**
 * Azure Blob + Table conversation sync for DeepSeek Harness.
 *
 * The plugin performs only local setup at load. Azure clients and the private
 * container/table are materialized on the first explicit sync action.
 * @module @1yefuwang1/dsh-azure-sync
 */
import { randomUUID } from 'node:crypto';
import { GitProbe, type GitObservationAnchor } from './git/probe.js';
import type { WorktreeImportPlacementV1, WorktreeSourceContext } from '@1yefuwang1/dsh-worktrees/import-contract';
import { hostname } from 'node:os';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { RemoteSessionReader } from './sync/remote-session.js';
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { CloudController, type CloudCore } from './controller.js';
import { SettingsService } from './settings.js';
import { CloudControlError } from './protocol.js';
import { registerCloudRpc } from './rpc.js';
import { registerCloudCommands } from './commands.js';
import { Config as ConfigSchema, resolveConfig, type AzureSyncConfig } from './config.js';
import { createBlobServiceClient, createTableClient, resolveAuth } from './auth.js';
import { BlobStore } from './azure/blob.js';
import { AzureSyncError } from './azure/errors.js';
import { LeaseManager } from './azure/lease.js';
import { TableStore } from './azure/table.js';
import { LocalStore } from './local/store.js';
import { EarlyImportClaims, ImportGuard, Importer } from './sync/importer.js';
import { ImportService } from './sync/import-service.js';
import { ImportRecovery } from './sync/recovery.js';
import { TombstoneManager } from './sync/tombstone-manager.js';
import { ProjectionWarmer } from './sync/projection-warmer.js';
import { WorkspaceAttacher } from './sync/workspace.js';
import { normalizeMapping, nodeCwdFs, selectMapping } from './sync/effective-cwd.js';
import { AttachmentSync } from './sync/attachments.js';
import type { Platform } from './schema.js';
import { PersistenceSessionSource, type SourceSnapshot } from './sync/session-source.js';
import { CloudRepository } from './sync/cloud-repository.js';
import { SessionLeaseManager } from './sync/lease-manager.js';
import { Uploader } from './sync/uploader.js';
import { SyncService } from './sync/service.js';
import { UploadScheduler } from './sync/scheduler.js';
import { registerSyncAdmission, registerSyncLifecycle } from './sync/lifecycle.js';
import { DestinationImportCoordinator, type DestinationImportRuntime } from './import/coordinator.js';
import { DestinationBindings } from './import/bindings.js';
import type { ImportGuardV1 } from './import/guard.js';
import { registerCloudImportCommands } from './import/commands.js';
import { canonicalJson, sha256Hex } from './sync/canonical.js';

export const name = 'azure-sync';

/** Required host services. Optional capabilities are resolved lazily with `ctx.get`. */
export const inject = ['sessions', 'sessionPersistence', 'storageDomain'];

export const Config = ConfigSchema;

function hostPlatform(): Platform {
  const value = process.platform;
  return value === 'darwin' || value === 'win32' || value === 'linux' ? value : 'linux';
}

async function ensureDevice(local: LocalStore, now: () => number) {
  const existing = local.getDevice();
  if (existing !== undefined) return existing;
  const device = { deviceId: randomUUID(), name: hostname(), platform: hostPlatform(), firstSeen: now() };
  await local.putDevice(device);
  return device;
}

/**
 * Mount the plugin. Configuration and the local domain are initialized at load;
 * network setup (container/table checks) happens only when a sync action runs.
 */
export async function apply(ctx: Context, config: AzureSyncConfig): Promise<void> {
  const baseConfig = resolveConfig(config);
  const local = new LocalStore(ctx.storageDomain);
  await local.open();
  ctx.effect(() => async () => { await local.close(); }, 'azure-sync: local domain');
  let activeService: SyncService | undefined;
  let activeCore: CloudCore | undefined;
  let activeImportRuntime: DestinationImportRuntime | undefined;
  let destinations: DestinationImportCoordinator | undefined;
  const destinationGuard = ctx.get('cloudImportReadinessV1') as ImportGuardV1 | undefined;
  const destinationBindings = new DestinationBindings(local, destinationGuard, () => activeImportRuntime?.scope);
  let coreAbort: AbortController | undefined;
  let stopCore: (() => Promise<void>) | undefined;
  let booting: Promise<void> | undefined;
  let setupEpoch = 0;
  // Persisted opt-in must remain enforced even if credentials/auth/setup fails.
  const admission = registerSyncAdmission({
    ctx, local, now: Date.now,
    ownership: (sessionId) => activeService?.ensureOwnership(sessionId, activeCore?.signal) ?? Promise.resolve({ owned: false, reason: 'ownership-unverified' }),
    noteActivity: (sessionId) => activeService?.noteActivity(sessionId),
  });
  ctx.effect(() => () => { activeService = undefined; admission(); }, 'azure-sync: startup admission');
  const device = await ensureDevice(local, Date.now);
  const earlyClaims = new EarlyImportClaims(ctx.sessionPersistence, local, sessionId => destinationBindings.reserved(sessionId));
  await earlyClaims.claimAll();
  ctx.effect(() => async () => { await earlyClaims.release(); }, 'azure-sync: early import claims');
  const importGuard = new ImportGuard(local);
  const createdGuard = ctx.on('session/created', (session) => { importGuard.assertCreatable(session.id); });
  ctx.effect(() => () => createdGuard(), 'azure-sync: import veto');
  const credentials = ctx.get('credentials') as CredentialProvider | undefined;
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const source = new PersistenceSessionSource(ctx.sessionPersistence);
  const gitProbe = new GitProbe({ executable: baseConfig.gitExecutable, timeoutMs: baseConfig.gitTimeoutMs, defaultRemote: baseConfig.defaultRemote });
  const gitMetadata = async (sessionId: string, signal?: AbortSignal) => {
    try {
      signal?.throwIfAborted(); const snapshot = await source.read(sessionId); signal?.throwIfAborted();
      if (!snapshot?.header.cwd) return null;
      const record = local.getSession(sessionId);
      const scoped = await destinationBindings.binding(sessionId, record);
      const mapping = scoped?.mapping ?? (record?.importMappingId ? local.getMapping(record.importMappingId) : undefined);
      const root = mapping?.localPrefix ?? snapshot.header.cwd;
      let cwd = snapshot.header.cwd;
      for (const event of snapshot.events as readonly { type: string; data?: { cwd?: unknown } }[]) {
        if (event.type === 'working-directory/change') { if (typeof event.data?.cwd !== 'string') return null; cwd = event.data.cwd; }
      }
      return gitProbe.inspect(cwd, root, signal);
    } catch { return null; }
  };
  const sourceContextFlights = new Set<Promise<WorktreeSourceContext | undefined>>();
  const gitContext = async (sessionId: string, anchor: GitObservationAnchor, snapshot: SourceSnapshot, signal?: AbortSignal) => {
    const budget = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(baseConfig.gitTimeoutMs, 60_000))), ...(signal ? [signal] : [])]);
    try {
      if (!snapshot.header.cwd || budget.aborted) return null;
      const record = local.getSession(sessionId); const scoped = await destinationBindings.binding(sessionId, record);
      const root = scoped?.mapping.localPrefix ?? snapshot.header.cwd;
      let cwd = snapshot.header.cwd;
      for (let index = snapshot.events.length - 1; index >= 0; index--) {
        const event = snapshot.events[index] as { type: string; data?: { cwd?: unknown } };
        if (event.type === 'working-directory/change') { if (typeof event.data?.cwd !== 'string') return null; cwd = event.data.cwd; break; }
      }
      let sourceContext: WorktreeSourceContext | undefined;
      const port = ctx.get('worktreeImportPlacement') as WorktreeImportPlacementV1 | undefined;
      if (port?.version === 1 && typeof port.sourceContext === 'function' && sourceContextFlights.size < 16) {
        const work = Promise.resolve().then(() => port.sourceContext(sessionId, snapshot.header.cwd!, budget));
        sourceContextFlights.add(work); void work.then(() => sourceContextFlights.delete(work), () => sourceContextFlights.delete(work));
        let stop: () => void = () => undefined;
        const expired = new Promise<undefined>(resolve => { stop = () => resolve(undefined); budget.addEventListener('abort', stop, { once: true }); if (budget.aborted) stop(); });
        try { sourceContext = await Promise.race([work, expired]); } finally { budget.removeEventListener('abort', stop); }
      }
      return await gitProbe.capture(cwd, root, device.deviceId, anchor, sourceContext, budget);
    } catch { return null; }
  };
  const stopRuntime = async () => {
    setupEpoch++;
    booting = undefined;
    coreAbort?.abort(); coreAbort = undefined;
    activeCore = undefined; activeService = undefined; activeImportRuntime = undefined;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    const stop = stopCore; stopCore = undefined;
    await destinations?.invalidate();
    await stop?.();
  };
  const settings = new SettingsService({ local, config: baseConfig, credentials,
    onBeforeChange: stopRuntime,
    onChange: async () => { await boot(); if (activeCore === undefined) throw new CloudControlError('SETUP_NEEDED'); },
  });
  destinations = await DestinationImportCoordinator.create({ ctx, guard: destinationGuard, local,
    current: () => activeImportRuntime,
    runtime: async signal => {
      signal.throwIfAborted();
      if (!activeImportRuntime) await boot();
      signal.throwIfAborted();
      if (!activeImportRuntime || activeImportRuntime.signal.aborted) throw new CloudControlError('SETUP_NEEDED');
      return activeImportRuntime;
    },
    settingsKey: () => sha256Hex(canonicalJson({ config: baseConfig, settings: local.getSettings(), epoch: setupEpoch })),
    observeLocalGit: (cwd, scopeRoot, anchor, signal) => gitProbe.capture(cwd, scopeRoot, device.deviceId, anchor, undefined,
      AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(baseConfig.gitTimeoutMs, 60_000)))])),
  });
  const controller = new CloudController({ local, settings, source, gitMetadata, destinations,
    exportDirectory: dshHomePath('azure-sync', 'conflicts'), current: () => activeCore,
    core: async (signal) => {
      signal.throwIfAborted();
      if (activeCore === undefined) await boot();
      signal.throwIfAborted();
      if (activeCore === undefined) throw new CloudControlError('SETUP_NEEDED');
      return activeCore;
    },
  });
  const commandDisposer = registerCloudCommands(ctx, controller);
  const importCommandDisposer = registerCloudImportCommands(ctx, destinations);
  const rpcDisposer = registerCloudRpc(ctx, controller, destinations);
  ctx.effect(() => async () => { controller.close(); commandDisposer(); importCommandDisposer(); await rpcDisposer(); await destinations?.close(); await stopRuntime(); }, 'azure-sync: control plane');
  ctx.effect(() => () => {
    disposed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
  }, 'azure-sync: setup retry timer');

  const bootImpl = async (epoch: number): Promise<void> => {
    try {
      const resolved = settings.effectiveConfig();
      const auth = await resolveAuth(resolved, { readCredential: (reference) => settings.readCredential(reference) });
      if (disposed || epoch !== setupEpoch) return;
      const blobClient = createBlobServiceClient(resolved, auth).getContainerClient(resolved.container);
      const tableClient = createTableClient(resolved, auth);
      const endpointIdentity = (value: string) => { const url = new URL(value); return `${url.origin}${url.pathname}`; };
      const importScope = sha256Hex(canonicalJson({ blob: endpointIdentity(blobClient.url), table: endpointIdentity(tableClient.url), container: resolved.container, tableName: resolved.table }));
      const blob = new BlobStore(blobClient);
      const table = new TableStore(tableClient);
      const repository = new CloudRepository(blob, table);
      const leases = new SessionLeaseManager({ repository, leases: new LeaseManager(blob), deviceId: device.deviceId, now: Date.now });
      const attachmentStore = ctx.get('attachments') as import('@deepseek-ai/dsh-attachment').AttachmentStore | undefined;
      const attachments = attachmentStore === undefined ? undefined : new AttachmentSync({ store: attachmentStore, blob, maxBytes: resolved.maxAttachmentBytes, now: Date.now });
      const workspace = new WorkspaceAttacher(ctx.get('workspaceRegistry') as never);
      const bindingForCwd = async (cwd: string | undefined) => {
        if (cwd === undefined) return undefined;
        const mappings = [...local.listMappings()].map(([, mapping]) => mapping);
        const platforms = [...new Set(mappings.map((mapping) => mapping.remotePlatform))];
        for (const platform of platforms) {
          try {
            const selected = selectMapping(mappings, cwd, platform);
            if (selected !== undefined) return { mapping: await normalizeMapping(selected, nodeCwdFs), fs: nodeCwdFs };
          } catch { /* ambiguous or malformed mapping; try another platform */ }
        }
        return undefined;
      };
      const headerCwdBinding = async (sessionId: string, header: { cwd?: string }) => {
        if (await destinationBindings.reserved(sessionId) || local.getSession(sessionId)?.destination) return destinationBindings.binding(sessionId);
        return bindingForCwd(header.cwd);
      };
      const recordCwdBinding = async (sessionId: string, record: import('./schema.js').LocalSessionRecord) => {
        if (record.destination || await destinationBindings.reserved(sessionId)) return destinationBindings.binding(sessionId, record);
        const binding = await bindingForCwd(record.canonicalCwd ?? record.localCwd);
        if (binding === undefined && record.imported && record.canonicalCwd !== undefined) {
          throw new AzureSyncError('MAPPING_UNSTABLE', 'The imported canonical cwd no longer resolves to a configured mapping.');
        }
        return binding;
      };
      const presets = ctx.get('agentPresets') as { resolve?: (id?: string) => Promise<unknown> } | undefined;
      const presetResolver = presets?.resolve === undefined ? undefined : async (id: string) => { try { await presets.resolve?.(id); return true; } catch { return false; } };
      const importer = new Importer({
        config: resolved, persistence: ctx.sessionPersistence, repository, local, cwdBinding: headerCwdBinding, attachments, workspace,
        isOptingOut: (sessionId) => controller.isOptingOut(sessionId),
        guard: importGuard, projection: new ProjectionWarmer({ query: ctx.get('sessionQuery') as never, cache: ctx.get('sessionProjectionCache') as never }), sessionController: ctx.get('sessionController') as never, ...(presetResolver === undefined ? {} : { presetResolver }), now: Date.now,
      });
      const imports = new ImportService(importer, earlyClaims, new ImportRecovery(importer, local, earlyClaims, sessionId => destinationBindings.reserved(sessionId)), destinations);
      const reader = new RemoteSessionReader(repository, { maxCompressedBytes: Math.max(resolved.maxBatchBytes * 4, 1_048_576), maxExpandedBytes: resolved.maxBatchBytes, maxEvents: resolved.maxEventsPerSession });
      const tombstones = new TombstoneManager(repository, local, Date.now, device.deviceId);
      let service: SyncService;
      const scheduler = new UploadScheduler(async (sessionId) => { await service.sync(sessionId); });
      service = new SyncService({
        uploader: new Uploader({
          config: resolved, source, repository, leases, local,
          deviceId: device.deviceId, platform: device.platform, now: Date.now,
          isOptingOut: (sessionId) => controller.isOptingOut(sessionId),
          ...(attachments === undefined ? {} : { attachments }),
          cwdBinding: recordCwdBinding, gitMetadata, gitContext, destinationReady: sessionId => destinationBindings.ready(sessionId),
        }),
        local,
        agents: ctx.get('agents') as import('@deepseek-ai/dsh-agent').AgentRegistry | undefined,
        ownershipProofMs: resolved.ownershipProofMs,
        isOptingOut: (sessionId) => controller.isOptingOut(sessionId),
        imports,
        tombstones,
        repository, source,
        reader, destinationReady: sessionId => destinationBindings.ready(sessionId), refreshGitOnSync: true,
        conflictDirectory: dshHomePath('azure-sync', 'conflicts'),
        pollIntervalMs: resolved.pollSeconds * 1_000,
        refreshTimeoutMs: resolved.requestTimeoutMs,
        now: Date.now,
        ensureInfra: async () => {
          await blob.ensurePrivateContainer();
          await table.ensureTable();
        },
      });
      const running = new AbortController();
      coreAbort = running;
      activeService = service;
      activeImportRuntime = { scope: importScope, signal: running.signal, config: resolved, repository, reader, importer, service };
      activeCore = { service, repository, signal: running.signal, testAuth: async (signal) => {
        const combined = AbortSignal.any([signal, running.signal]); combined.throwIfAborted();
        await blob.ensurePrivateContainer(); combined.throwIfAborted();
        await table.ensureTable(); combined.throwIfAborted();
      } };
      const lifecycle = registerSyncLifecycle({ ctx, service, scheduler, local, now: Date.now, admissionInstalled: true });
      let disposal: Promise<void> | undefined;
      const dispose = () => disposal ??= (async () => {
        running.abort();
        if (activeService === service) { activeService = undefined; activeCore = undefined; activeImportRuntime = undefined; }
        const deadline = Date.now() + 5_000;
        await scheduler.stop(Math.max(1, deadline - Date.now()));
        lifecycle();
        await service.close(Math.max(1, deadline - Date.now()));
      })();
      const stopEffect = ctx.effect(() => dispose, 'azure-sync: lifecycle');
      stopCore = async () => { await stopEffect(); await dispose(); };
      ctx.logger?.debug?.(`azure-sync: loaded (auth=${resolved.auth}, container=${resolved.container}, table=${resolved.table})`);
      void service.repairResurrections().catch(() => {
        ctx.logger?.warn?.('azure-sync: resurrection repair is incomplete; affected records remain blocked.');
      }).then(() => imports.repairAll()).catch(() => {
        ctx.logger?.warn?.('azure-sync: import repair is incomplete; affected records remain blocked.');
      }).then(() => {
        // One failed record must not disable polling for unrelated opted-in threads.
        if (!disposed && !running.signal.aborted) service.start(resolved.pullOnStartup);
      });
    } catch {
      if (disposed || epoch !== setupEpoch) return;
      ctx.logger?.warn?.('azure-sync: setup needed; update cloud settings or credentials.');
      if (!disposed) {
        retryTimer = setTimeout(() => { void boot(); }, 30_000);
        retryTimer.unref?.();
      }
    }
  };
  const boot = (): Promise<void> => {
    if (disposed || activeCore !== undefined) return Promise.resolve();
    if (booting !== undefined) return booting;
    const task = bootImpl(setupEpoch);
    booting = task;
    void task.finally(() => { if (booting === task) booting = undefined; }).catch(() => undefined);
    return task;
  };
  const credentialChanged = ctx.on('credentials/reference-updated', (reference) => {
    if (reference !== baseConfig.connectionRef || disposed) return;
    // The provider already committed this generation. Do not wait behind an
    // unrelated control request before stopping old-account admission/publication.
    activeService?.suspend();
    const stopping = stopRuntime();
    void stopping.catch(() => undefined);
    void controller.maintenance(async () => { await stopping; await boot(); }).catch(() => {
      ctx.logger?.warn?.('azure-sync: credential reload failed; cloud admission remains conservative.');
    });
  });
  ctx.effect(() => () => credentialChanged(), 'azure-sync: credential updates');
  await boot();
}

export {
  createBlobServiceClient,
  createTableClient,
  redactConnectionString,
  resolveAuth,
} from './auth.js';
export { BlobStore } from './azure/blob.js';
export { LeaseManager } from './azure/lease.js';
export { TableStore } from './azure/table.js';
export { AzureSyncError } from './azure/errors.js';
export { endpointsFor } from './config.js';
export { LocalStore, localDomain } from './local/store.js';
export { PersistenceSessionSource } from './sync/session-source.js';
export { CloudRepository } from './sync/cloud-repository.js';
export { SessionLeaseManager } from './sync/lease-manager.js';
export { Uploader } from './sync/uploader.js';
export { SyncService } from './sync/service.js';
export { CloudController } from './controller.js';
export { SettingsService } from './settings.js';
export { registerCloudCommands, parseCloudCommand } from './commands.js';
export { registerCloudRpc, CLOUD_STATUS_ENDPOINT, CLOUD_ACTION_ENDPOINT } from './rpc.js';
export { parseCloudRequest, CloudControlError } from './protocol.js';
export type { CloudCore, ControllerDependencies } from './controller.js';
export type { SettingsView, AuthUpdate, DefaultsUpdate } from './settings.js';
export type { CloudRequest, CloudResponse, CloudEnvelope, CloudControllerPort } from './protocol.js';
export { UploadScheduler } from './sync/scheduler.js';
export { registerSyncLifecycle } from './sync/lifecycle.js';
export type { AuthDependencies, ResolvedAuth } from './auth.js';
export type { AzureSyncConfig } from './config.js';
export type { BlobListing, BlobMetadata } from './azure/blob.js';
export type { EntityKey, StoredEntity } from './azure/table.js';
export type { LeaseHandle } from './azure/lease.js';
export type { UploadSummary } from './sync/uploader.js';
export type { SessionLease } from './sync/lease-manager.js';
export { GitProbe } from './git/probe.js';
export { sanitizeGitRemote, parseGitFacts } from './git/sanitize.js';
export { gitGuidance, quotePosix, quotePowerShell } from './git/guidance.js';
export type { GitFacts } from './git/sanitize.js';
