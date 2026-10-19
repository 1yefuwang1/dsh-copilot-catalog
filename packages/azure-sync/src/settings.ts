/**
 * Local, non-secret settings and write-only credential updates. The credential
 * provider owns secret persistence; ambient environment values are read-only.
 * @module @1yefuwang1/dsh-azure-sync/settings
 */
import { randomUUID } from 'node:crypto';
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { z } from 'zod';
import { AUTH_MODES, resolveConfig, type AuthMode, type AzureSyncConfig } from './config.js';
import { createBlobServiceClient, createTableClient, resolveAuth } from './auth.js';
import { AzureSyncError } from './azure/errors.js';
import type { LocalStore } from './local/store.js';
import { localSettingsSchema, type LocalSettingsRecord } from './schema.js';

export interface AuthUpdate {
  readonly auth: AuthMode;
  readonly accountName?: string;
  readonly managedIdentityClientId?: string;
  readonly connectionString?: string;
  readonly clearConnectionString?: boolean;
}

export interface DefaultsUpdate {
  readonly defaultEnabled?: boolean;
  readonly pullOnStartup?: boolean;
  readonly pollSeconds?: number;
}

export type CredentialSource = 'env' | 'file' | 'project-env' | 'user-env' | 'provider';

/** Deliberately enumerated: no secret or arbitrary provider metadata crosses this view. */
export interface SettingsView {
  readonly auth: AuthMode;
  readonly accountName: string;
  readonly managedIdentityClientId: string;
  readonly connectionRef: string;
  readonly container: string;
  readonly table: string;
  readonly endpointSuffix: string;
  readonly defaultEnabled: false;
  readonly pullOnStartup: boolean;
  readonly pollSeconds: number;
  readonly updatedAt?: number;
  readonly authPending: boolean;
  readonly pendingAuth?: {
    readonly auth: AuthMode;
    readonly accountName: string;
    readonly managedIdentityClientId: string;
  };
  readonly connection: {
    readonly configured: boolean;
    readonly writable: boolean;
    readonly source?: CredentialSource;
    /** Metadata is unknown, rather than unconfigured, when the provider is unavailable. */
    readonly available?: false;
    /** An uncertain dormant secret must be explicitly replaced/cleared before reuse. */
    readonly requiresUpdate?: true;
  };
}

interface SettingsDependencies {
  readonly local: LocalStore;
  readonly config: AzureSyncConfig;
  readonly credentials?: CredentialProvider;
  readonly now?: () => number;
  /** Stop and drain the old runtime before any credential/settings mutation. */
  readonly onBeforeChange?: () => Promise<void>;
  /** Rebuild only after durable settings. Not called on a failed/aborted mutation. */
  readonly onChange?: () => Promise<void>;
}

const authUpdateSchema = z.object({
  auth: z.enum(AUTH_MODES),
  accountName: localSettingsSchema.shape.accountName,
  managedIdentityClientId: localSettingsSchema.shape.managedIdentityClientId,
  connectionString: z.string().min(1).max(16_384).optional(),
  clearConnectionString: z.boolean().optional(),
}).strict();
const defaultsUpdateSchema = z.object({
  defaultEnabled: z.literal(false).optional(),
  pullOnStartup: z.boolean().optional(),
  pollSeconds: z.number().int().min(30).max(86_400).optional(),
}).strict();
const connectionFields = new Set([
  'DefaultEndpointsProtocol', 'AccountName', 'AccountKey', 'SharedAccessSignature',
  'EndpointSuffix', 'BlobEndpoint', 'QueueEndpoint', 'TableEndpoint', 'FileEndpoint',
]);

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AzureSyncError('CANCELLED', 'The settings update was cancelled. Reload settings before retrying.');
}

function invalid(message = 'The settings update is invalid.'): AzureSyncError {
  return new AzureSyncError('INVALID_CONFIG', message);
}

function sourceView(source: unknown): CredentialSource {
  switch (source) {
    case 'env': case 'file': case 'project-env': case 'user-env': return source;
    default: return 'provider';
  }
}

/** Validate structure and both Azure clients without a network request or a write. */
async function validateConnectionString(value: string, config: AzureSyncConfig): Promise<string> {
  const normalized = value.trim();
  if (!normalized || normalized.length > 16_384 || /[\r\n\0]/u.test(value)) throw invalid('The connection string is malformed.');
  const development = /^UseDevelopmentStorage=true;?$/u.test(normalized);
  if (development) {
    if (!config.allowInsecure) throw new AzureSyncError('INSECURE_ENDPOINT', 'Local emulator connections require the administrator to allow insecure endpoints.');
  } else {
    const fields = new Map<string, string>();
    const parts = normalized.replace(/;$/u, '').split(';');
    for (const part of parts) {
      const equals = part.indexOf('=');
      const key = part.slice(0, equals);
      const entry = part.slice(equals + 1);
      if (equals < 1 || !entry || entry !== entry.trim() || !connectionFields.has(key) || fields.has(key)) {
        throw invalid('The connection string has unsupported, empty, or duplicate fields.');
      }
      fields.set(key, entry);
    }
    const key = fields.get('AccountKey');
    const sas = fields.get('SharedAccessSignature');
    if ((key === undefined) === (sas === undefined)) throw invalid('The connection string must contain exactly one account key or shared access signature.');
    const account = fields.get('AccountName');
    if ((account !== undefined && !/^[a-z0-9]{3,24}$/u.test(account)) || (key !== undefined && account === undefined)) {
      throw invalid('The connection string storage account name is invalid.');
    }
    if (key !== undefined && !/^[A-Za-z0-9+/]+={0,2}$/u.test(key)) throw invalid('The connection string account key is malformed.');
    if (sas !== undefined) {
      const params = new URLSearchParams(sas.replace(/^\?/u, ''));
      if (!params.get('sig') || !params.get('sv') || [...params.keys()].some((name) => params.getAll(name).length !== 1)) {
        throw invalid('The connection string shared access signature is malformed.');
      }
    }
    const protocol = fields.get('DefaultEndpointsProtocol');
    if (protocol !== undefined && protocol !== 'https' && protocol !== 'http') throw invalid('The connection string endpoint protocol is invalid.');
    if (protocol === 'http' && !config.allowInsecure) throw new AzureSyncError('INSECURE_ENDPOINT', 'The connection string must use HTTPS.');
    const suffix = fields.get('EndpointSuffix');
    if (suffix !== undefined && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(suffix)) throw invalid('The connection string endpoint suffix is invalid.');
    for (const name of ['BlobEndpoint', 'QueueEndpoint', 'TableEndpoint', 'FileEndpoint']) {
      const endpoint = fields.get(name);
      if (endpoint === undefined) continue;
      let url: URL;
      try { url = new URL(endpoint); } catch { throw invalid('The connection string endpoint is invalid.'); }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.allowInsecure)) {
        throw new AzureSyncError('INSECURE_ENDPOINT', 'The connection string endpoints must use HTTPS.');
      }
      if (url.username || url.password || url.search || url.hash) throw invalid('Connection string endpoints must not contain credentials, queries, or fragments.');
    }
  }
  try {
    const auth = await resolveAuth({ ...config, auth: 'connection-string' }, { readCredential: async () => normalized });
    createBlobServiceClient(config, auth);
    createTableClient(config, auth);
  } catch {
    // SDK exceptions can embed connection strings, SAS URLs, or provider diagnostics.
    throw invalid('The connection string cannot configure both Blob and Table storage.');
  }
  return normalized;
}

type AuthPendingRecord = NonNullable<LocalSettingsRecord['authPending']>;

function authRequired(): AzureSyncError {
  return new AzureSyncError('AUTH_REQUIRED', 'An authentication update is incomplete. Re-enter or clear the connection string, or explicitly choose Azure CLI or managed identity. Sync remains stopped.');
}

export class SettingsService {
  private readonly config: AzureSyncConfig;
  private pending: Promise<unknown> = Promise.resolve();
  // Also block this process if an ambiguous local write cannot be re-marked durably.
  private blockedAuth?: AuthPendingRecord;

  constructor(private readonly dependencies: SettingsDependencies) {
    try {
      // Never let an administrator default silently opt future threads into sync.
      this.config = Object.freeze(resolveConfig({ ...dependencies.config, defaultEnabled: false }));
    } catch {
      throw invalid('The administrator Azure sync configuration is invalid.');
    }
  }

  private stored(): LocalSettingsRecord | undefined {
    let value: LocalSettingsRecord | undefined;
    try { value = this.dependencies.local.getSettings(); } catch {
      throw new AzureSyncError('AZURE_OPERATION_FAILED', 'Local settings are unavailable. Open the local store before using settings.');
    }
    if (value === undefined) return undefined;
    const parsed = localSettingsSchema.safeParse(value);
    if (!parsed.success) throw invalid('The stored local settings are invalid.');
    return parsed.data;
  }

  private activePending(settings = this.stored()): AuthPendingRecord | undefined {
    return this.blockedAuth ?? settings?.authPending;
  }

  private configFor(settings: LocalSettingsRecord | undefined): AzureSyncConfig {
    return {
      ...this.config,
      auth: settings?.auth ?? this.config.auth,
      accountName: settings?.accountName ?? this.config.accountName,
      managedIdentityClientId: settings?.managedIdentityClientId ?? this.config.managedIdentityClientId,
      defaultEnabled: false,
      pullOnStartup: settings?.pullOnStartup ?? this.config.pullOnStartup,
      // Old v4 records allowed larger intervals; accept their bytes without
      // expanding the current runtime/input bounds or blocking local startup.
      pollSeconds: Math.min(settings?.pollSeconds ?? this.config.pollSeconds, 86_400),
    };
  }

  effectiveConfig(): AzureSyncConfig {
    const settings = this.stored();
    const config = this.configFor(settings);
    if (this.activePending(settings) !== undefined ||
        (settings?.connectionUncertain && (config.auth === 'auto' || config.auth === 'connection-string'))) throw authRequired();
    return config;
  }

  private async connectionView(): Promise<SettingsView['connection']> {
    const provider = this.dependencies.credentials;
    if (provider === undefined) {
      const configured = Boolean(process.env[this.config.connectionRef]?.trim());
      return { configured, writable: false, ...(configured ? { source: 'env' as const } : {}) };
    }
    try {
      const info = await provider.describe(credentialRef(this.config.connectionRef));
      const configured = info.configured === true;
      return { configured, writable: info.writable === true, ...(configured ? { source: sourceView(info.source) } : {}) };
    } catch {
      throw new AzureSyncError('AUTH_FAILED', 'Credential status could not be read. Check the credentials provider and retry.');
    }
  }

  private async view(settings: LocalSettingsRecord | undefined, pending: AuthPendingRecord | undefined): Promise<SettingsView> {
    const config = this.configFor(settings);
    const updatedAt = settings?.updatedAt;
    let connection: SettingsView['connection'];
    try { connection = await this.connectionView(); } catch (error) {
      if (pending === undefined && config.auth !== 'azure-cli' && config.auth !== 'managed-identity') throw error;
      connection = { configured: false, writable: false, available: false };
    }
    if (settings?.connectionUncertain) connection = { ...connection, requiresUpdate: true };
    return {
      auth: config.auth,
      accountName: config.accountName,
      managedIdentityClientId: config.managedIdentityClientId,
      connectionRef: config.connectionRef,
      container: config.container,
      table: config.table,
      endpointSuffix: config.endpointSuffix,
      defaultEnabled: false,
      pullOnStartup: config.pullOnStartup,
      pollSeconds: config.pollSeconds,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      authPending: pending !== undefined,
      ...(pending === undefined ? {} : { pendingAuth: {
        auth: pending.auth, accountName: pending.accountName, managedIdentityClientId: pending.managedIdentityClientId,
      } }),
      connection,
    };
  }

  async get(): Promise<SettingsView> {
    const settings = this.stored();
    const pending = this.activePending(settings);
    let view: SettingsView;
    try { view = await this.view(settings, pending); } catch (error) {
      const latest = this.stored();
      const current = this.activePending(latest);
      if (current === undefined) throw error;
      return this.view(latest, current);
    }
    // A concurrent auth write can begin while describe is awaiting provider work.
    const latest = this.stored();
    const current = this.activePending(latest);
    if (pending?.id !== current?.id || settings?.authGeneration !== latest?.authGeneration) return this.view(latest, current);
    return view;
  }

  /** Host-only secret reader. Not an RPC response and never an arbitrary credential oracle. */
  async readCredential(reference: string): Promise<string | undefined> {
    if (reference !== this.config.connectionRef) throw invalid('Only the configured Azure sync credential reference may be read.');
    const before = this.stored();
    if (this.activePending(before) !== undefined || before?.connectionUncertain) throw authRequired();
    let value: string | undefined;
    try {
      const provider = this.dependencies.credentials;
      value = provider === undefined ? process.env[reference] : (await provider.resolve(credentialRef(reference)))?.value;
    } catch {
      throw new AzureSyncError('AUTH_FAILED', 'The Azure sync credential could not be read. Check the credentials provider and retry.');
    }
    const after = this.stored();
    if (this.activePending(after) !== undefined || after?.connectionUncertain || before?.authGeneration !== after?.authGeneration) throw authRequired();
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private record(): LocalSettingsRecord {
    const settings = this.stored();
    const config = this.configFor(settings);
    const pending = this.activePending(settings);
    let at: number;
    try { at = (this.dependencies.now ?? Date.now)(); } catch { throw invalid('The settings clock is unavailable.'); }
    if (!Number.isSafeInteger(at) || at < 0) throw invalid('The settings clock is invalid.');
    return {
      ...settings,
      ...(pending === undefined ? {} : { authPending: pending }),
      defaultEnabled: false,
      pullOnStartup: config.pullOnStartup,
      pollSeconds: config.pollSeconds,
      updatedAt: at,
    };
  }

  private async beforeChange(signal?: AbortSignal): Promise<void> {
    cancelled(signal);
    try { await this.dependencies.onBeforeChange?.(); } catch {
      throw new AzureSyncError('AZURE_OPERATION_FAILED', 'The current sync runtime could not be stopped safely. No settings were changed.');
    }
    cancelled(signal);
  }

  private async save(record: LocalSettingsRecord, signal?: AbortSignal): Promise<void> {
    cancelled(signal);
    try { await this.dependencies.local.putSettings(record); } catch {
      throw new AzureSyncError('AZURE_OPERATION_FAILED', 'Local settings could not be saved. Sync remains stopped; reload settings before retrying.');
    }
    cancelled(signal);
  }

  private async restart(signal?: AbortSignal): Promise<void> {
    cancelled(signal);
    try { await this.dependencies.onChange?.(); } catch {
      try { await this.dependencies.onBeforeChange?.(); } catch { /* Preserve a safe, static failure. */ }
      throw new AzureSyncError('AZURE_OPERATION_FAILED', 'Settings were saved, but sync could not restart. Reload settings and retry setup.');
    }
    if (signal?.aborted) {
      try { await this.dependencies.onBeforeChange?.(); } catch { /* Cancellation must not expose hook errors. */ }
      cancelled(signal);
    }
  }

  private async persist(record: LocalSettingsRecord, signal?: AbortSignal): Promise<SettingsView> {
    await this.save(record, signal);
    const view = await this.get();
    cancelled(signal);
    // Defaults may change while recovery is pending, but never clear its guard
    // or turn an unrelated defaults edit into consent to reuse an unknown key.
    if (this.activePending() === undefined) await this.restart(signal);
    return view;
  }

  private assertIntent(intent: AuthPendingRecord): void {
    if (this.stored()?.authPending?.id !== intent.id) throw authRequired();
  }

  private async restorePending(intent: AuthPendingRecord, previousGeneration: string | undefined): Promise<void> {
    this.blockedAuth = intent;
    try {
      const current = this.stored();
      // Do not overwrite a different operation's newer durable intent/generation.
      if (current?.authPending !== undefined && current.authPending.id !== intent.id) return;
      if (current?.authGeneration !== previousGeneration && current?.authGeneration !== intent.id) return;
      await this.dependencies.local.putSettings({ ...this.record(), authPending: intent });
    } catch { /* The in-process latch remains closed even when storage is unavailable. */ }
  }

  async setAuth(input: AuthUpdate, signal?: AbortSignal): Promise<SettingsView> {
    cancelled(signal);
    const parsed = authUpdateSchema.safeParse(input);
    if (!parsed.success) throw invalid('The authentication update is invalid. Only supported authentication fields are accepted.');
    const update = parsed.data;
    if (update.connectionString !== undefined && update.clearConnectionString === true) throw invalid('Set or clear the connection string, not both.');
    if (update.connectionString !== undefined && update.auth !== 'auto' && update.auth !== 'connection-string') {
      throw invalid('A connection string may only be set for auto or connection-string authentication.');
    }
    return this.enqueue(async () => {
      cancelled(signal);
      const stored = this.stored();
      const previousPending = this.activePending(stored);
      const config = this.configFor(stored);
      const secretWrite = update.connectionString !== undefined || update.clearConnectionString === true;
      if ((previousPending !== undefined || stored?.connectionUncertain) && !secretWrite &&
          (update.auth === 'auto' || update.auth === 'connection-string')) throw authRequired();
      let value: string | undefined;
      if (secretWrite && (this.dependencies.credentials === undefined || !(await this.connectionView()).writable)) {
        throw new AzureSyncError('AUTH_REQUIRED', 'Enable a writable credentials provider to set or clear the connection string. Environment values are read-only.');
      }
      if (update.connectionString !== undefined) value = await validateConnectionString(update.connectionString, config);
      else if (!update.clearConnectionString && (update.auth === 'auto' || update.auth === 'connection-string')) {
        const existing = await this.readCredential(this.config.connectionRef);
        if (existing !== undefined) await validateConnectionString(existing, config);
      }
      const baseline = this.record();
      const intent: AuthPendingRecord = {
        id: randomUUID(), auth: update.auth,
        accountName: update.accountName ?? previousPending?.accountName ?? config.accountName,
        managedIdentityClientId: update.managedIdentityClientId ?? previousPending?.managedIdentityClientId ?? config.managedIdentityClientId,
        startedAt: baseline.updatedAt!,
      };
      if (!localSettingsSchema.safeParse({ ...baseline, authPending: intent }).success) throw invalid('The proposed authentication settings are invalid.');
      // Validation and provider capability checks above have no side effects.
      await this.beforeChange(signal);
      this.blockedAuth = intent;
      try {
        // Credential providers notify observers before set/unset returns. Persist
        // the guard FIRST so every observer/restart sees a closed auth generation.
        await this.save({ ...this.record(), authPending: intent }, signal);
        this.assertIntent(intent);
        if (secretWrite) {
          cancelled(signal);
          try {
            const provider = this.dependencies.credentials!;
            if (value !== undefined) await provider.set(credentialRef(this.config.connectionRef), value);
            else await provider.unset(credentialRef(this.config.connectionRef));
          } catch {
            throw new AzureSyncError('AUTH_FAILED', 'The credential update could not be confirmed. Sync remains stopped; explicitly replace or clear the credential before retrying.');
          }
        }
        cancelled(signal);
        this.assertIntent(intent);
        const accepted: LocalSettingsRecord = { ...this.record(), auth: intent.auth,
          accountName: intent.accountName, managedIdentityClientId: intent.managedIdentityClientId,
          authGeneration: intent.id,
        };
        delete accepted.authPending;
        delete accepted.connectionUncertain;
        if (!secretWrite && (previousPending !== undefined || stored?.connectionUncertain)) accepted.connectionUncertain = true;
        // Metadata failures happen while the durable pending guard is still set.
        const view = await this.view(accepted, undefined);
        cancelled(signal);
        this.assertIntent(intent);
        await this.save(accepted, signal);
        const finalized = this.stored();
        if (finalized?.authGeneration !== intent.id || finalized.authPending !== undefined) throw authRequired();
        this.blockedAuth = undefined;
        await this.restart(signal);
        return view;
      } catch (error) {
        // Even a final put may have committed before throwing. Re-establish the
        // durable guard when possible; never roll a secret back or adopt it blind.
        await this.restorePending(intent, stored?.authGeneration);
        throw error;
      }
    });
  }

  async setDefaults(input: DefaultsUpdate, signal?: AbortSignal): Promise<SettingsView> {
    cancelled(signal);
    const parsed = defaultsUpdateSchema.safeParse(input);
    if (!parsed.success) throw invalid('New threads must remain off until explicitly enabled. Poll seconds must be an integer from 30 to 86400; only supported defaults are accepted.');
    const update = parsed.data;
    return this.enqueue(async () => {
      cancelled(signal);
      const record = { ...this.record(), ...update, defaultEnabled: false as const };
      await this.beforeChange(signal);
      return this.persist(record, signal);
    });
  }
}
