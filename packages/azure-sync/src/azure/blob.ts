/**
 * Narrow Blob Storage adapter. Every write is conditional/idempotent where the
 * sync protocol needs it; reads are bounded; errors are redacted.
 * @module @1yefuwang1/dsh-azure-sync/azure/blob
 */
import type { BlobLeaseClient, ContainerClient } from '@azure/storage-blob';
import { AzureSyncError, isAlreadyExists, isNotFound, mapAzureError } from './errors.js';

export interface BlobListing {
  readonly name: string;
  readonly sizeBytes: number;
}

export interface BlobMetadata {
  readonly [key: string]: string;
}

export class BlobStore {
  readonly container: ContainerClient;

  constructor(container: ContainerClient) {
    this.container = container;
  }

  /** Create the container if absent and refuse a publicly readable container. */
  async ensurePrivateContainer(): Promise<void> {
    try {
      await this.container.createIfNotExists();
      const properties = await this.container.getProperties();
      if (properties.blobPublicAccess !== undefined && properties.blobPublicAccess !== null) {
        throw new AzureSyncError('CONTAINER_PUBLIC', 'The Azure Blob container must not allow public access.');
      }
    } catch (error) {
      throw mapAzureError(error, 'container verification');
    }
  }

  async putIfAbsent(name: string, data: Uint8Array, metadata: BlobMetadata = {}): Promise<'created' | 'exists'> {
    try {
      await this.container.getBlockBlobClient(name).upload(data, data.byteLength, {
        conditions: { ifNoneMatch: '*' },
        metadata,
      });
      return 'created';
    } catch (error) {
      if (isAlreadyExists(error)) return 'exists';
      throw mapAzureError(error, 'blob upload');
    }
  }

  /** Read a whole blob after checking its actual size, refusing anything above `maxBytes`. */
  async read(name: string, maxBytes: number): Promise<Buffer> {
    try {
      const blob = this.container.getBlobClient(name);
      const properties = await blob.getProperties();
      const length = properties.contentLength;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
        throw new AzureSyncError('AZURE_OPERATION_FAILED', 'Azure Blob metadata did not report a valid content length.');
      }
      if (length > maxBytes) {
        throw new AzureSyncError('LIMIT', 'The Azure Blob is larger than the configured read limit.');
      }
      if (length === 0) return Buffer.alloc(0);
      // The SDK allocates the requested count, not the blob's actual size, so
      // pass the exact content length instead of maxBytes + 1.
      const data = await blob.downloadToBuffer(0, length);
      if (data.byteLength !== length) {
        throw new AzureSyncError('AZURE_OPERATION_FAILED', 'Azure Blob read returned an unexpected byte count.');
      }
      return data;
    } catch (error) {
      throw mapAzureError(error, 'blob read');
    }
  }

  /** Read lowercase metadata without downloading the blob. */
  async getMetadata(name: string): Promise<Record<string, string>> {
    try {
      const properties = await this.container.getBlobClient(name).getProperties();
      return { ...(properties.metadata ?? {}) };
    } catch (error) {
      throw mapAzureError(error, 'blob metadata read');
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.container.getBlobClient(name).getProperties();
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw mapAzureError(error, 'blob metadata read');
    }
  }

  async deleteIfExists(name: string): Promise<void> {
    try {
      await this.container.getBlobClient(name).deleteIfExists();
    } catch (error) {
      throw mapAzureError(error, 'blob delete');
    }
  }

  async *list(prefix: string): AsyncGenerator<BlobListing> {
    try {
      for await (const blob of this.container.listBlobsFlat({ prefix })) {
        yield { name: blob.name, sizeBytes: blob.properties.contentLength ?? 0 };
      }
    } catch (error) {
      throw mapAzureError(error, 'blob listing');
    }
  }

  /** Obtain a lease client without taking the lease. */
  lease(name: string, leaseId?: string): BlobLeaseClient {
    return this.container.getBlobClient(name).getBlobLeaseClient(leaseId);
  }

  /** Materialize an empty lease blob; an existing blob is left untouched. */
  async ensureEmptyBlob(name: string): Promise<void> {
    try {
      await this.container.getBlockBlobClient(name).upload(new Uint8Array(0), 0, {
        conditions: { ifNoneMatch: '*' },
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw mapAzureError(error, 'lease blob creation');
    }
  }
}
