/**
 * Azure Blob + Table conversation sync for DeepSeek Harness.
 *
 * The plugin performs only local setup at load. Azure clients and the private
 * container/table are materialized on the first explicit sync action.
 * @module @1yefuwang1/dsh-azure-sync
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials';
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
import { registerSyncLifecycle } from './sync/lifecycle.js';

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
  const resolved = resolveConfig(config);
  const local = new LocalStore(ctx.storageDomain);
  await local.open();
  ctx.effect(() => async () => { await local.close(); }, 'azure-sync: local domain');
  const device = await ensureDevice(local, Date.now);
  const earlyClaims = new EarlyImportClaims(ctx.sessionPersistence, local);
  await earlyClaims.claimAll();
  ctx.effect(() => async () => { await earlyClaims.release(); }, 'azure-sync: early import claims');
  const importGuard = new ImportGuard(local);
  const createdGuard = ctx.on('session/created', (session) => { importGuard.assertCreatable(session.id); });
  ctx.effect(() => () => createdGuard(), 'azure-sync: import veto');
  const credentials = ctx.get('credentials') as CredentialProvider | undefined;
  const readCredential = async (reference: string): Promise<string | undefined> => {
    if (credentials !== undefined) {
      try {
        const value = await credentials.resolve(credentialRef(reference));
        if (value !== undefined) return value.value;
      } catch { /* fall through to ambiance */ }
    }
    return process.env[reference];
  };
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  ctx.effect(() => () => {
    disposed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
  }, 'azure-sync: setup retry timer');

  const boot = async (): Promise<void> => {
    try {
      const auth = await resolveAuth(resolved, { readCredential });
      const blob = new BlobStore(createBlobServiceClient(resolved, auth).getContainerClient(resolved.container));
      const table = new TableStore(createTableClient(resolved, auth));
      const repository = new CloudRepository(blob, table);
      const leases = new SessionLeaseManager({ repository, leases: new LeaseManager(blob), deviceId: device.deviceId, now: Date.now });
      const source = new PersistenceSessionSource(ctx.sessionPersistence);
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
        guard: importGuard, projection: new ProjectionWarmer({ query: ctx.get('sessionQuery') as never, cache: ctx.get('sessionProjectionCache') as never }), sessionController: ctx.get('sessionController') as never, ...(presetResolver === undefined ? {} : { presetResolver }), now: Date.now,
      });
      const imports = new ImportService(importer, earlyClaims, new ImportRecovery(importer, local, earlyClaims));
      const tombstones = new TombstoneManager(repository, local, Date.now);
      let service: SyncService;
      const scheduler = new UploadScheduler(async (sessionId) => { await service.sync(sessionId); });
      service = new SyncService({
        uploader: new Uploader({
          config: resolved, source, repository, leases, local,
          deviceId: device.deviceId, platform: device.platform, now: Date.now,
          ...(attachments === undefined ? {} : { attachments }),
          cwdBinding: recordCwdBinding,
        }),
        local,
        agents: ctx.agents,
        ownershipProofMs: resolved.ownershipProofMs,
        imports,
        tombstones,
        ensureInfra: async () => {
          await blob.ensurePrivateContainer();
          await table.ensureTable();
        },
      });
      const lifecycle = registerSyncLifecycle({ ctx, service, scheduler, local, now: Date.now });
      ctx.effect(() => async () => {
      const deadline = Date.now() + 5_000;
      await scheduler.stop(Math.max(1, deadline - Date.now()));
      lifecycle();
      await service.close(Math.max(1, deadline - Date.now()));
    }, 'azure-sync: lifecycle');
      ctx.logger?.debug?.(`azure-sync: loaded (auth=${resolved.auth}, container=${resolved.container}, table=${resolved.table})`);
      void imports.repairAll().catch(() => undefined);
    } catch (error) {
      ctx.logger?.warn?.(`azure-sync: setup needed (${error instanceof Error ? error.name : 'unknown'})`);
      if (!disposed) {
        retryTimer = setTimeout(() => { void boot(); }, 30_000);
        retryTimer.unref?.();
      }
    }
  };
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
export { UploadScheduler } from './sync/scheduler.js';
export { registerSyncLifecycle } from './sync/lifecycle.js';
export type { AuthDependencies, ResolvedAuth } from './auth.js';
export type { AzureSyncConfig } from './config.js';
export type { BlobListing, BlobMetadata } from './azure/blob.js';
export type { EntityKey, StoredEntity } from './azure/table.js';
export type { LeaseHandle } from './azure/lease.js';
export type { UploadSummary } from './sync/uploader.js';
export type { SessionLease } from './sync/lease-manager.js';
