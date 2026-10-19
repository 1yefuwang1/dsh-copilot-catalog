/**
 * Azure Blob + Table conversation sync for DeepSeek Harness.
 *
 * The plugin performs only local setup at load. Azure clients and the private
 * container/table are materialized on the first explicit sync action.
 * @module @1yefuwang1/dsh-azure-sync
 */
import { randomUUID } from 'node:crypto';
import { GitProbe } from './git/probe.js';
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
import { PersistenceSessionSource } from './sync/session-source.js';
import { CloudRepository } from './sync/cloud-repository.js';
import { SessionLeaseManager } from './sync/lease-manager.js';
import { Uploader } from './sync/uploader.js';
import { SyncService } from './sync/service.js';
import { UploadScheduler } from './sync/scheduler.js';
import { registerSyncAdmission, registerSyncLifecycle } from './sync/lifecycle.js';

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
  const earlyClaims = new EarlyImportClaims(ctx.sessionPersistence, local);
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
      const mapping = record?.importMappingId ? local.getMapping(record.importMappingId) : undefined;
      const root = mapping?.localPrefix ?? snapshot.header.cwd;
      let cwd = snapshot.header.cwd;
      for (const event of snapshot.events as readonly { type: string; data?: { cwd?: unknown } }[]) {
        if (event.type === 'working-directory/change') { if (typeof event.data?.cwd !== 'string') return null; cwd = event.data.cwd; }
      }
      return gitProbe.inspect(cwd, root, signal);
    } catch { return null; }
  };
  const stopRuntime = async () => {
    setupEpoch++;
    booting = undefined;
    coreAbort?.abort(); coreAbort = undefined;
    activeCore = undefined; activeService = undefined;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    const stop = stopCore; stopCore = undefined;
    await stop?.();
  };
  const settings = new SettingsService({ local, config: baseConfig, credentials,
    onBeforeChange: stopRuntime,
    onChange: async () => { await boot(); if (activeCore === undefined) throw new CloudControlError('SETUP_NEEDED'); },
  });
  const controller = new CloudController({ local, settings, source, gitMetadata,
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
  const rpcDisposer = registerCloudRpc(ctx, controller);
  ctx.effect(() => async () => { controller.close(); commandDisposer(); await rpcDisposer(); await stopRuntime(); }, 'azure-sync: control plane');
  ctx.effect(() => () => {
    disposed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
  }, 'azure-sync: setup retry timer');

  const bootImpl = async (epoch: number): Promise<void> => {
    try {
      const resolved = settings.effectiveConfig();
      const auth = await resolveAuth(resolved, { readCredential: (reference) => settings.readCredential(reference) });
      if (disposed || epoch !== setupEpoch) return;
      const blob = new BlobStore(createBlobServiceClient(resolved, auth).getContainerClient(resolved.container));
      const table = new TableStore(createTableClient(resolved, auth));
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
      const headerCwdBinding = async (_sessionId: string, header: { cwd?: string }) => bindingForCwd(header.cwd);
      const recordCwdBinding = async (_sessionId: string, record: import('./schema.js').LocalSessionRecord) => {
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
      const imports = new ImportService(importer, earlyClaims, new ImportRecovery(importer, local, earlyClaims));
      const tombstones = new TombstoneManager(repository, local, Date.now, device.deviceId);
      let service: SyncService;
      const scheduler = new UploadScheduler(async (sessionId) => { await service.sync(sessionId); });
      service = new SyncService({
        uploader: new Uploader({
          config: resolved, source, repository, leases, local,
          deviceId: device.deviceId, platform: device.platform, now: Date.now,
          isOptingOut: (sessionId) => controller.isOptingOut(sessionId),
          ...(attachments === undefined ? {} : { attachments }),
          cwdBinding: recordCwdBinding, gitMetadata,
        }),
        local,
        agents: ctx.agents,
        ownershipProofMs: resolved.ownershipProofMs,
        isOptingOut: (sessionId) => controller.isOptingOut(sessionId),
        imports,
        tombstones,
        repository, source,
        reader: new RemoteSessionReader(repository, {
          maxCompressedBytes: Math.max(resolved.maxBatchBytes * 4, 1_048_576),
          maxExpandedBytes: resolved.maxBatchBytes, maxEvents: resolved.maxEventsPerSession,
        }),
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
      activeCore = { service, repository, signal: running.signal, testAuth: async (signal) => {
        const combined = AbortSignal.any([signal, running.signal]); combined.throwIfAborted();
        await blob.ensurePrivateContainer(); combined.throwIfAborted();
        await table.ensureTable(); combined.throwIfAborted();
      } };
      const lifecycle = registerSyncLifecycle({ ctx, service, scheduler, local, now: Date.now, admissionInstalled: true });
      let disposal: Promise<void> | undefined;
      const dispose = () => disposal ??= (async () => {
        running.abort();
        if (activeService === service) { activeService = undefined; activeCore = undefined; }
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
