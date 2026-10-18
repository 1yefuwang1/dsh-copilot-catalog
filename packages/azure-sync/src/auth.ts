/**
 * Authentication selection for Azure Storage. Connection strings are read from
 * the DSH credential store (or its environment fallback); token auth uses the
 * Azure CLI, a managed identity, or DefaultAzureCredential. No secret is logged.
 * @module @1yefuwang1/dsh-azure-sync/auth
 */
import type { TokenCredential } from '@azure/core-auth';
import { AzureCliCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { TableClient } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import { endpointsFor, type AzureSyncConfig, type StorageEndpoints } from './config.js';
import { AzureSyncError, mapAzureError } from './azure/errors.js';

export interface AuthDependencies {
  /** Resolve a credential reference. The sync lifecycle supplies this; T1 makes no host assumption. */
  readonly readCredential?: (reference: string) => Promise<string | undefined>;
  readonly azureCli?: () => TokenCredential;
  readonly managedIdentity?: (clientId?: string) => TokenCredential;
  readonly defaultCredential?: () => TokenCredential;
}

export type ResolvedAuth =
  | { readonly kind: 'connection-string'; readonly connectionString: string }
  | { readonly kind: 'token'; readonly credential: TokenCredential; readonly endpoints: StorageEndpoints };

const credentialRefPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

const developmentAccountKey = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const developmentConnectionString = [
  'DefaultEndpointsProtocol=http',
  'AccountName=devstoreaccount1',
  `AccountKey=${developmentAccountKey}`,
  'BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1',
  'QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1',
  'TableEndpoint=http://127.0.0.1:10002/devstoreaccount1',
].join(';') + ';';

/** Azurite's shorthand works for Blob; expand it so Table gets concrete endpoints too. */
function expandDevelopmentConnectionString(value: string): string {
  return /^UseDevelopmentStorage\s*=\s*true\s*;?$/iu.test(value) ? developmentConnectionString : value;
}


/** Hide account keys, SAS signatures, and token-like query values. */
export function redactConnectionString(connectionString: string): string {
  return connectionString
    .replace(/(AccountKey=)[^;]*/giu, '$1***')
    .replace(/(SharedAccessSignature=)[^;]*/giu, '$1***')
    .replace(/([?&]sig=)[^&;]*/giu, '$1***');
}

function isInsecureConnectionString(connectionString: string): boolean {
  if (/(?:^|;)\s*UseDevelopmentStorage\s*=\s*true\s*(?:;|$)/iu.test(connectionString)) return true;
  if (/(?:^|;)\s*DefaultEndpointsProtocol\s*=\s*http\s*(?:;|$)/iu.test(connectionString)) return true;
  return /(?:^|;)\s*(?:Blob|Table|Queue|File)Endpoint\s*=\s*http:\/\//iu.test(connectionString);
}

function normalizeConnectionString(value: string): string {
  return value.trim();
}

async function connectionStringFor(config: AzureSyncConfig, dependencies: AuthDependencies): Promise<string | undefined> {
  if (!credentialRefPattern.test(config.connectionRef)) throw new AzureSyncError('INVALID_CONFIG', 'The Azure connection credential reference is invalid.');
  const raw = await dependencies.readCredential?.(config.connectionRef);
  if (raw === undefined) return undefined;
  const value = expandDevelopmentConnectionString(normalizeConnectionString(raw));
  return value.length === 0 ? undefined : value;
}

function tokenCredential(config: AzureSyncConfig, dependencies: AuthDependencies): TokenCredential {
  switch (config.auth) {
    case 'azure-cli':
      return dependencies.azureCli?.() ?? new AzureCliCredential();
    case 'managed-identity':
      return config.managedIdentityClientId
        ? dependencies.managedIdentity?.(config.managedIdentityClientId) ?? new ManagedIdentityCredential(config.managedIdentityClientId)
        : dependencies.managedIdentity?.() ?? new ManagedIdentityCredential();
    default:
      return dependencies.defaultCredential?.() ?? new DefaultAzureCredential();
  }
}

/** Resolve one authentication strategy. Missing setup is an explicit failure, never a silent anonymous request. */
export async function resolveAuth(config: AzureSyncConfig, dependencies: AuthDependencies = {}): Promise<ResolvedAuth> {
  let connectionString: string | undefined;
  if (config.auth === 'connection-string' || config.auth === 'auto') {
    connectionString = await connectionStringFor(config, dependencies);
  }

  if (connectionString !== undefined) {
    if (isInsecureConnectionString(connectionString) && !config.allowInsecure) {
      throw new AzureSyncError('INSECURE_ENDPOINT', 'The Azure connection string uses HTTP. Set allowInsecure only for a local emulator.');
    }
    return { kind: 'connection-string', connectionString };
  }

  if (config.auth === 'connection-string') {
    throw new AzureSyncError('AUTH_REQUIRED', `No Azure Storage connection string is configured under ${config.connectionRef}.`);
  }

  const endpoints = endpointsFor(config);
  if (endpoints === undefined) {
    throw new AzureSyncError('ACCOUNT_REQUIRED', 'Token authentication requires accountName (or a connection string).');
  }
  return { kind: 'token', credential: tokenCredential(config, dependencies), endpoints };
}

function blobRetryOptions(config: AzureSyncConfig) {
  return {
    maxTries: config.maxRetries + 1,
    tryTimeoutInMs: config.requestTimeoutMs,
    retryDelayInMs: 500,
    maxRetryDelayInMs: 30_000,
  };
}

function tableRetryOptions(config: AzureSyncConfig) {
  return {
    maxRetries: config.maxRetries,
    retryDelayInMs: 500,
    maxRetryDelayInMs: 30_000,
  };
}

function assertSecureUrl(url: string, allowInsecure: boolean): void {
  if (!allowInsecure && url.startsWith('http://')) {
    throw new AzureSyncError('INSECURE_ENDPOINT', 'The Azure client resolved to HTTP. Set allowInsecure only for a local emulator.');
  }
}

/** Build a blob service client without performing network work. */
export function createBlobServiceClient(config: AzureSyncConfig, auth: ResolvedAuth): BlobServiceClient {
  try {
    const client = auth.kind === 'connection-string'
      ? BlobServiceClient.fromConnectionString(auth.connectionString, { retryOptions: blobRetryOptions(config) })
      : new BlobServiceClient(auth.endpoints.blob, auth.credential, { retryOptions: blobRetryOptions(config) });
    assertSecureUrl(client.url, config.allowInsecure);
    return client;
  } catch (error) {
    throw mapAzureError(error, 'blob client creation');
  }
}

/** Build a table client without performing network work. */
export function createTableClient(config: AzureSyncConfig, auth: ResolvedAuth): TableClient {
  try {
    const options = { retryOptions: tableRetryOptions(config), allowInsecureConnection: config.allowInsecure };
    const client = auth.kind === 'connection-string'
      ? TableClient.fromConnectionString(auth.connectionString, config.table, options)
      : new TableClient(auth.endpoints.table, config.table, auth.credential, options);
    assertSecureUrl(client.url, config.allowInsecure);
    return client;
  } catch (error) {
    throw mapAzureError(error, 'table client creation');
  }
}
