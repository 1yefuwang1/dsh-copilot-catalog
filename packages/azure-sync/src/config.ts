/**
 * Plugin configuration. Storage names are validated before any Azure request;
 * authentication is resolved lazily so the plugin can load before setup.
 * @module @1yefuwang1/dsh-azure-sync/config
 */
import z from '@deepseek-ai/schemastery';

export const AUTH_MODES = ['auto', 'connection-string', 'azure-cli', 'managed-identity'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

const accountPattern = /^[a-z0-9]{3,24}$/u;
const endpointSuffixPattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const containerPattern = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u;
const tablePattern = /^[A-Za-z][A-Za-z0-9]{2,62}$/u;

/** Loader schema. Defaults keep installation side-effect free. */
export const Config = z.object({
  auth: z.union(AUTH_MODES).default('auto'),
  connectionRef: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u).default('DSH_AZURE_SYNC_CONNECTION'),
  accountName: z.string().pattern(/^(?:[a-z0-9]{3,24})?$/u).default(''),
  endpointSuffix: z.string().pattern(endpointSuffixPattern).default('core.windows.net'),
  container: z.string().pattern(containerPattern).default('dsh-state'),
  table: z.string().pattern(tablePattern).default('dshstatesync'),
  managedIdentityClientId: z.string().max(256).default(''),
  allowInsecure: z.boolean().default(false),
  requestTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(30_000),
  maxRetries: z.number().step(1).min(0).max(10).default(3),
  defaultEnabled: z.boolean().default(false),
  pullOnStartup: z.boolean().default(true),
  pollSeconds: z.number().step(1).min(30).max(86_400).default(30),
  ownershipProofMs: z.number().step(1).min(1_000).max(60_000).default(5_000),
  historyJobTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(120_000),
  historyMemoryBytes: z.number().step(1).min(0).max(1_073_741_824).default(134_217_728),
  historyDiskBytes: z.number().step(1).min(0).max(4_294_967_296).default(536_870_912),
  maxBatchEvents: z.number().step(1).min(1).max(10_000).default(1_000),
  maxBatchBytes: z.number().step(1).min(65_536).max(16_777_216).default(3_145_728),
  maxAttachmentBytes: z.number().step(1).min(1_024).max(536_870_912).default(104_857_600),
  maxEventsPerSession: z.number().step(1).min(1).max(1_000_000).default(200_000),
  gitExecutable: z.string().min(1).max(4096).default('git'),
  defaultRemote: z.string().min(1).max(256).default('origin'),
  gitTimeoutMs: z.number().step(1).min(1_000).max(60_000).default(5_000),
});

export type AzureSyncConfig = ReturnType<typeof Config>;

export interface StorageEndpoints {
  readonly blob: string;
  readonly table: string;
}

/** Derive token-auth endpoints from the configured storage account. */
export function endpointsFor(config: Pick<AzureSyncConfig, 'accountName' | 'endpointSuffix'>): StorageEndpoints | undefined {
  const account = config.accountName.trim();
  if (!account) return undefined;
  if (!accountPattern.test(account)) throw new Error('Storage account name is invalid.');
  const suffix = config.endpointSuffix.replace(/^\.+/u, '').replace(/\.+$/u, '');
  if (!suffix || !endpointSuffixPattern.test(suffix)) throw new Error('Storage endpoint suffix is invalid.');
  return Object.freeze({
    blob: `https://${account}.blob.${suffix}`,
    table: `https://${account}.table.${suffix}`,
  });
}

/** Resolve defaults and validate an already-created config object. */
export function resolveConfig(input: AzureSyncConfig): AzureSyncConfig {
  return Config(input);
}
