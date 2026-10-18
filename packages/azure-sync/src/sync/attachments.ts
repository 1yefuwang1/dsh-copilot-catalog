/**
 * Attachment sync: immutable Blob objects addressed by the opaque attachment id,
 * lowercase metadata, and host materialization through `ctx.attachments` only.
 * @module @1yefuwang1/dsh-azure-sync/sync/attachments
 */
import { createHash } from 'node:crypto';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { AzureSyncError } from '../azure/errors.js';
import type { BlobStore } from '../azure/blob.js';
import { attachmentMetadataSchema, encodeKeyPart, encodeNameB64, type AttachmentMetadata } from '../schema.js';

export interface AttachmentReference {
  readonly id: string;
  readonly kind: 'image' | 'file';
  readonly mediaType?: string;
  readonly name?: string;
  readonly raw?: Record<string, unknown>;
  readonly aliases?: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Find every attachment-shaped object in a verified event stream, deduped by id. */
export function collectAttachmentReferences(events: readonly unknown[]): AttachmentReference[] {
  const found = new Map<string, AttachmentReference>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const object = record(value);
    if (object === undefined) return;
    const id = object['attachmentId'];
    if (typeof id === 'string') {
      if (typeof object['mediaType'] === 'string') {
        const previous = found.get(id);
        const name = typeof object['name'] === 'string' ? object['name'] : undefined;
        if (previous === undefined) found.set(id, { id, kind: 'image', mediaType: object['mediaType'], ...(name === undefined ? {} : { name }), raw: object });
        else if (name !== undefined) found.set(id, { ...previous, aliases: [...new Set([...(previous.aliases ?? []), name])] });
      } else if (typeof object['name'] === 'string' && typeof object['bytes'] === 'number') {
        const previous = found.get(id);
        const name = object['name'];
        if (previous === undefined) found.set(id, { id, kind: 'file', name, aliases: [name], raw: object });
        else found.set(id, { ...previous, aliases: [...new Set([...(previous.aliases ?? [previous.name ?? ''].filter(Boolean)), name])] });
      }
    }
    for (const child of Object.values(object)) visit(child);
  };
  for (const event of events) visit(event);
  return [...found.values()];
}

export function attachmentBlobName(id: string): string {
  return `v1/attachments/${encodeKeyPart(id)}`;
}

export interface AttachmentSyncOptions {
  readonly store?: AttachmentStore;
  readonly blob: BlobStore;
  readonly maxBytes: number;
  readonly now: () => number;
}

export interface AttachmentImportResult {
  readonly imported: readonly string[];
  readonly degraded: readonly string[];
  readonly aliases: readonly { readonly id: string; readonly name: string }[];
}

export class AttachmentSync {
  private readonly options: AttachmentSyncOptions;

  constructor(options: AttachmentSyncOptions) {
    this.options = options;
  }

  private store(): AttachmentStore {
    if (this.options.store === undefined) throw new AzureSyncError('ATTACHMENT_UNSUPPORTED', 'The host has no attachment store.');
    return this.options.store;
  }

  private async readRemote(ref: AttachmentReference): Promise<Buffer> {
    const metadata = await this.options.blob.getMetadata(attachmentBlobName(ref.id));
    const expected = metadata['sha256'];
    const bytes = await this.options.blob.read(attachmentBlobName(ref.id), Math.min(this.options.maxBytes, 536_870_912));
    if (expected !== undefined) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected) throw new AzureSyncError('CORRUPT_REMOTE', 'A remote attachment failed its integrity check.');
    }
    return bytes;
  }

  private metadata(ref: AttachmentReference, bytes: Uint8Array): AttachmentMetadata {
    return {
      attachmentid: ref.id, kind: ref.kind, bytes: String(bytes.byteLength),
      mediatype: ref.mediaType ?? (ref.kind === 'image' ? 'image/*' : 'application/octet-stream'),
      ...(ref.name === undefined ? {} : { nameb64: encodeNameB64(ref.name) }),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  /** Upload every referenced object; missing refs are reported, never fabricated. */
  async upload(refs: readonly AttachmentReference[], options: { readonly authorized?: () => void | Promise<void> } = {}): Promise<{ readonly uploaded: readonly string[]; readonly missing: readonly string[] }> {
    if (this.options.store === undefined) return { uploaded: [], missing: refs.map((ref) => ref.id) };
    const uploaded: string[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      let bytes: Uint8Array;
      try {
        if (ref.kind === 'image') bytes = (await this.store().readImage((ref.raw ?? { attachmentId: ref.id, mediaType: ref.mediaType ?? 'image/png', bytes: 0, width: 0, height: 0 }) as unknown as ImageAttachmentRef)).data;
        else {
          const chunks: Uint8Array[] = [];
          let total = 0;
          for await (const chunk of this.store().readFileStream((ref.raw ?? { attachmentId: ref.id, name: ref.name ?? 'file', bytes: 0 }) as unknown as FileAttachmentRef)) {
            total += chunk.byteLength;
            if (total > this.options.maxBytes) throw new AzureSyncError('LIMIT', 'An attachment exceeds the configured size limit.');
            chunks.push(chunk);
          }
          bytes = Buffer.concat(chunks);
        }
      } catch {
        missing.push(ref.id);
        continue;
      }
      await options.authorized?.();
      const metadata = this.metadata(ref, bytes);
      const status = await this.options.blob.putIfAbsent(attachmentBlobName(ref.id), bytes, metadata as unknown as Record<string, string>);
      if (status === 'exists') {
        const existing = await this.options.blob.getMetadata(attachmentBlobName(ref.id));
        if (existing['sha256'] !== metadata.sha256) throw new AzureSyncError('CONFLICT', 'An immutable attachment already exists with different bytes.');
      }
      uploaded.push(ref.id);
    }
    return { uploaded, missing };
  }

  /** Materialize remote refs into the host attachment store, never replacing a valid image. */
  async import(refs: readonly AttachmentReference[]): Promise<AttachmentImportResult> {
    const imported: string[] = [];
    const degraded: string[] = [];
    const aliases: { id: string; name: string }[] = [];
    for (const ref of refs) {
      try {
        if (ref.kind === 'image') {
          const imageRef = (ref.raw ?? { attachmentId: ref.id, mediaType: ref.mediaType, bytes: 0, width: 0, height: 0 }) as unknown as ImageAttachmentRef;
          try { await this.store().readImage(imageRef); imported.push(ref.id); continue; } catch { /* materialize below */ }
          const path = this.store().imageHostPath(imageRef);
          if (path === undefined) { degraded.push(ref.id); continue; }
          const bytes = await this.readRemote(ref);
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const temp = `${path}.${process.pid}.${this.options.now()}.sync`;
          await writeFile(temp, bytes, { mode: 0o400 });
          try { await link(temp, path); }
          catch (error) {
            await rm(temp, { force: true });
            if ((error as { code?: string }).code === 'EEXIST') {
              try { await this.store().readImage(imageRef); imported.push(ref.id); }
              catch { degraded.push(ref.id); }
              continue;
            }
            throw error;
          }
          await rm(temp, { force: true });
          await this.store().readImage(imageRef);
          imported.push(ref.id);
        } else {
          const bytes = await this.readRemote(ref);
          const names = new Set<string>([...(ref.aliases ?? []), ...(ref.name === undefined ? [] : [ref.name])]);
          if (names.size === 0) names.add('file');
          let allAliasesOk = true;
          for (const name of names) {
            let result: FileAttachmentRef;
            try {
              result = await this.store().saveFileStream({ data: (async function* () { yield bytes; })(), name });
            } catch {
              result = await this.store().saveFile({ data: bytes, name });
            }
            if (String(result.attachmentId) !== ref.id || result.bytes !== bytes.byteLength) { allAliasesOk = false; continue; }
            aliases.push({ id: String(result.attachmentId), name: result.name });
          }
          if (allAliasesOk) imported.push(ref.id);
          else if (!degraded.includes(ref.id)) degraded.push(ref.id);
        }
      } catch (error) {
        if (error instanceof AzureSyncError && error.code === 'LIMIT') throw error;
        degraded.push(ref.id);
      }
    }
    return { imported, degraded, aliases };
  }
}

/** Validate stored attachment metadata before using it. */
export function parseAttachmentMetadata(value: unknown): AttachmentMetadata {
  const result = attachmentMetadataSchema.safeParse(value);
  if (!result.success) throw new AzureSyncError('INVALID_RECORD', 'Attachment metadata failed validation.');
  return result.data;
}

export type { FileAttachmentRef };
