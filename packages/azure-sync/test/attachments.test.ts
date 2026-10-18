import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AttachmentSync, collectAttachmentReferences } from '../src/sync/attachments.js';
import type { BlobStore } from '../src/azure/blob.js';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';

class MemoryBlob {
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  async putIfAbsent(name: string, bytes: Uint8Array, metadata: Record<string, string>) {
    if (this.objects.has(name)) return 'exists' as const;
    this.objects.set(name, { bytes: Uint8Array.from(bytes), metadata: { ...metadata } });
    return 'created' as const;
  }
  async getMetadata(name: string) { return this.objects.get(name)?.metadata ?? {}; }
  async read(name: string) { return Buffer.from(this.objects.get(name)?.bytes ?? new Uint8Array()); }
}

function fakeStore(root: string, imageBytes: Uint8Array, mode: 'always' | 'path' = 'always') {
  const images = new Map<string, Uint8Array>([['img-1', imageBytes]]);
  const files = new Map<string, Uint8Array>([['file-1', Buffer.from('file-bytes')]]);
  const validImagePaths = new Set<string>();
  const store = {
    async readImage(ref: { attachmentId: string }) {
      const data = images.get(ref.attachmentId);
      if (data === undefined) throw new Error('missing');
      if (mode === 'path') await stat(join(root, `${ref.attachmentId}.png`));
      return { ref, data };
    },
    imageHostPath: (ref: { attachmentId: string }) => validImagePaths.has(ref.attachmentId) ? undefined : join(root, `${ref.attachmentId}.png`),
    async *readFileStream(ref: { attachmentId: string }) { const data = files.get(ref.attachmentId); if (data === undefined) throw new Error('missing'); yield data; },
    async saveFile(input: { data: Uint8Array; name?: string }) { return { attachmentId: 'file-1' as never, name: input.name ?? 'file', bytes: input.data.byteLength }; },
    async saveFileStream(input: { data: AsyncIterable<Uint8Array>; name?: string }) { const chunks: Uint8Array[] = []; for await (const chunk of input.data) chunks.push(chunk); return { attachmentId: 'file-1' as never, name: input.name ?? 'file', bytes: Buffer.concat(chunks).byteLength }; },
  } as unknown as AttachmentStore;
  return { store, images, files };
}

test('attachment references are discovered and round-trip through immutable Blob metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-att-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = Buffer.from('PNGDATA');
  const fake = fakeStore(root, imageBytes);
  const blob = new MemoryBlob();
  const sync = new AttachmentSync({ store: fake.store, blob: blob as unknown as BlobStore, maxBytes: 1024, now: () => 1 });
  const refs = collectAttachmentReferences([
    { type: 'user/message', data: { content: [{ type: 'image', attachmentId: 'img-1', mediaType: 'image/png', name: '资料.png' }] } },
    { type: 'tool/result', data: { file: { attachmentId: 'file-1', name: 'a.txt', bytes: 10 } } },
  ]);
  assert.deepEqual(refs.map((ref) => ref.kind), ['image', 'file']);
  const uploaded = await sync.upload(refs);
  assert.deepEqual(uploaded.uploaded, ['img-1', 'file-1']);
  assert.equal(blob.objects.size, 2);
  const imageMetadata = [...blob.objects.values()].find((value) => value.metadata['kind'] === 'image')?.metadata;
  assert.equal(imageMetadata?.['sha256'], createHash('sha256').update(imageBytes).digest('hex'));
  assert.equal(imageMetadata?.['nameb64'], Buffer.from('资料.png').toString('base64url'));

  const importStore = fakeStore(root, imageBytes, 'path');
  const importer = new AttachmentSync({ store: importStore.store, blob: blob as unknown as BlobStore, maxBytes: 1024, now: () => 1 });
  const imported = await importer.import(refs);
  assert.deepEqual(imported.imported, ['img-1', 'file-1']);
  assert.deepEqual(imported.degraded, []);
  const path = join(root, 'img-1.png');
  assert.equal((await readFile(path)).toString(), imageBytes.toString());
  assert.equal(((await stat(path)).mode & 0o777), 0o400);
  const before = await readFile(path);
  await importer.import([refs[0]!]);
  assert.deepEqual(await readFile(path), before);
});

test('missing attachment data degrades instead of fabricating local objects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-att-miss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeStore(root, Buffer.from('X'));
  const blob = new MemoryBlob();
  const sync = new AttachmentSync({ store: fake.store, blob: blob as unknown as BlobStore, maxBytes: 1024, now: () => 1 });
  const uploaded = await sync.upload([{ id: 'unknown', kind: 'image', mediaType: 'image/png' }]);
  assert.deepEqual(uploaded.missing, ['unknown']);
  const imported = await sync.import([{ id: 'unknown', kind: 'image', mediaType: 'image/png' }]);
  assert.deepEqual(imported.degraded, ['unknown']);
});

test('one attachment with multiple names materializes every file alias', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-att-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeStore(root, Buffer.from('X'));
  const blob = new MemoryBlob();
  const sync = new AttachmentSync({ store: fake.store, blob: blob as unknown as BlobStore, maxBytes: 1024, now: () => 1 });
  const refs = collectAttachmentReferences([
    { data: { file: { attachmentId: 'file-1', name: 'a.txt', bytes: 10 } } },
    { data: { file: { attachmentId: 'file-1', name: 'b.txt', bytes: 10 } } },
  ]);
  assert.deepEqual(refs[0]?.aliases, ['a.txt', 'b.txt']);
  await sync.upload(refs);
  assert.equal(blob.objects.size, 1);
  const imported = await sync.import(refs);
  assert.deepEqual(imported.imported, ['file-1']);
  assert.deepEqual(imported.aliases.map((alias) => alias.name).sort(), ['a.txt', 'b.txt']);
});

test('a valid local image is never downloaded and an unsupported image path degrades', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-att-local-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeStore(root, Buffer.from('IMG'));
  const blob = new MemoryBlob();
  let remoteReads = 0;
  blob.read = async () => { remoteReads += 1; return Buffer.from('IMG'); };
  const sync = new AttachmentSync({ store: fake.store, blob: blob as unknown as BlobStore, maxBytes: 1024, now: () => 1 });
  const refs = [{ id: 'img-1', kind: 'image' as const, mediaType: 'image/png' }];
  assert.deepEqual((await sync.import(refs)).imported, ['img-1']);
  assert.equal(remoteReads, 0);

  const unsupported = { ...fake.store, readImage: async () => { throw new Error('missing'); }, imageHostPath: () => undefined } as unknown as AttachmentStore;
  const degraded = await new AttachmentSync({ store: unsupported, blob: blob as unknown as BlobStore, maxBytes: 1024, now: () => 1 }).import(refs);
  assert.deepEqual(degraded.degraded, ['img-1']);
  assert.equal(remoteReads, 0);
});

test('attachment upload aborts before a PUT when authorization is lost', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-att-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeStore(root, Buffer.from('IMG'));
  const blob = new MemoryBlob();
  const sync = new AttachmentSync({ store: fake.store, blob: blob as unknown as BlobStore, maxBytes: 1024, now: () => 1 });
  await assert.rejects(sync.upload([{ id: 'img-1', kind: 'image', mediaType: 'image/png' }], { authorized: () => { throw new Error('cancelled'); } }));
  assert.equal(blob.objects.size, 0);
});
