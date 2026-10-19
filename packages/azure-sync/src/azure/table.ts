/**
 * Narrow Table Storage adapter for manifests, committed batch rows, devices,
 * and meta records. Entity operations preserve ETags for conditional updates.
 * @module @1yefuwang1/dsh-azure-sync/azure/table
 */
import type { TableClient, TableEntity, TableEntityResult, TableTransactionResponse, TransactionAction } from '@azure/data-tables';
import { AzureSyncError, isAlreadyExists, isNotFound, mapAzureError } from './errors.js';

export interface EntityKey {
  readonly partitionKey: string;
  readonly rowKey: string;
}

export interface StoredEntity<T extends object> {
  readonly value: TableEntityResult<T>;
  readonly etag?: string;
}

export class TableStore {
  readonly client: TableClient;
  readonly requestTimeoutMs: number;

  constructor(client: TableClient, requestTimeoutMs = 30_000) {
    this.client = client;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private requestOptions() {
    return { requestOptions: { timeout: this.requestTimeoutMs } };
  }

  /** Create the table if absent; this call is a no-op when it already exists. */
  async ensureTable(): Promise<void> {
    try {
      await this.client.createTable(this.requestOptions());
    } catch (error) {
      if (isAlreadyExists(error)) return;
      throw mapAzureError(error, 'table verification');
    }
  }

  async get<T extends object>(partitionKey: string, rowKey: string): Promise<StoredEntity<T> | undefined> {
    try {
      const value = await this.client.getEntity<T>(partitionKey, rowKey, this.requestOptions());
      return { value, ...(value.etag === undefined ? {} : { etag: value.etag }) };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw mapAzureError(error, 'table read');
    }
  }

  /** Insert only; returns false when the row already exists. */
  async insert<T extends object>(entity: TableEntity<T>): Promise<boolean> {
    try {
      await this.client.createEntity(entity, this.requestOptions());
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw mapAzureError(error, 'table insert');
    }
  }

  async upsert<T extends object>(entity: TableEntity<T>): Promise<void> {
    try {
      await this.client.upsertEntity(entity, 'Replace', this.requestOptions());
    } catch (error) {
      throw mapAzureError(error, 'table upsert');
    }
  }

  async update<T extends object>(entity: TableEntity<T>, etag: string): Promise<void> {
    try {
      await this.client.updateEntity(entity, 'Replace', { etag, ...this.requestOptions() });
    } catch (error) {
      throw mapAzureError(error, 'table update');
    }
  }

  async delete(partitionKey: string, rowKey: string, etag?: string): Promise<void> {
    try {
      await this.client.deleteEntity(partitionKey, rowKey, etag === undefined ? this.requestOptions() : { etag, ...this.requestOptions() });
    } catch (error) {
      throw mapAzureError(error, 'table delete');
    }
  }

  async submitTransaction(actions: TransactionAction[]): Promise<TableTransactionResponse> {
    try {
      return await this.client.submitTransaction(actions, this.requestOptions());
    } catch (error) {
      throw mapAzureError(error, 'table transaction');
    }
  }

  async *list<T extends object>(filter?: string, signal?: AbortSignal): AsyncGenerator<StoredEntity<T>> {
    try {
      signal?.throwIfAborted();
      const options = { ...this.requestOptions(), ...(filter === undefined ? {} : { queryOptions: { filter } }), ...(signal === undefined ? {} : { abortSignal: signal }) };
      for await (const value of this.client.listEntities<T>(options)) {
        signal?.throwIfAborted();
        yield { value, ...(value.etag === undefined ? {} : { etag: value.etag }) };
      }
    } catch (error) {
      throw mapAzureError(error, 'table listing');
    }
  }

  /** A stable key for one entity, used by logs and tests (never a secret). */
  static keyOf(partitionKey: string, rowKey: string): string {
    return `${partitionKey}/${rowKey}`;
  }
}

/** Throw when a caller expected a row but the table returned none. */
export function requireEntity<T extends object>(entity: StoredEntity<T> | undefined, key: EntityKey): StoredEntity<T> {
  if (entity === undefined) throw new AzureSyncError('NOT_FOUND', `Azure table row ${TableStore.keyOf(key.partitionKey, key.rowKey)} was not found.`);
  return entity;
}
