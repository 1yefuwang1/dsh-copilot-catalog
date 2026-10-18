/**
 * Blob lease lifecycle. Leases are the cross-device writer gate; the manifest
 * epoch fences publication. An already-issued lease can be broken, so callers
 * must still verify ownership before each model step.
 * @module @1yefuwang1/dsh-azure-sync/azure/lease
 */
import type { BlobLeaseClient } from '@azure/storage-blob';
import type { BlobStore } from './blob.js';
import { mapAzureError } from './errors.js';

export interface LeaseHandle {
  readonly client: BlobLeaseClient;
  readonly leaseId: string;
}

export class LeaseManager {
  readonly store: Pick<BlobStore, 'ensureEmptyBlob' | 'lease'>;
  readonly durationSeconds: number;

  constructor(store: Pick<BlobStore, 'ensureEmptyBlob' | 'lease'>, durationSeconds = 60) {
    this.store = store;
    this.durationSeconds = durationSeconds;
  }

  async acquire(name: string, durationSeconds = this.durationSeconds): Promise<LeaseHandle> {
    try {
      await this.store.ensureEmptyBlob(name);
      const acquired = this.store.lease(name);
      const response = await acquired.acquireLease(durationSeconds);
      const leaseId = response.leaseId;
      if (leaseId === undefined) throw new Error('Azure lease acquisition returned no lease id.');
      // Renew/release must use a client bound to the acquired lease id.
      return { client: this.store.lease(name, leaseId), leaseId };
    } catch (error) {
      throw mapAzureError(error, 'lease acquisition');
    }
  }

  async renew(handle: LeaseHandle): Promise<void> {
    try {
      await handle.client.renewLease();
    } catch (error) {
      throw mapAzureError(error, 'lease renewal');
    }
  }

  async release(handle: LeaseHandle): Promise<void> {
    try {
      await handle.client.releaseLease();
    } catch (error) {
      throw mapAzureError(error, 'lease release');
    }
  }

  async break(name: string): Promise<void> {
    try {
      const client = this.store.lease(name);
      await client.breakLease(0);
    } catch (error) {
      throw mapAzureError(error, 'lease break');
    }
  }
}
