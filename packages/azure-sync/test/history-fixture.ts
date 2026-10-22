import { gzipSync } from 'node:zlib';
import type { CloudRepository, StoredManifest } from '../src/sync/cloud-repository.js';
import { candidateBlobName } from '../src/sync/cloud-repository.js';
import { batchRow, cloudSession, event, sessionHeader } from './helpers.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import type { BatchRow } from '../src/schema.js';
import type { HistoryScope } from '../src/sync/history-state.js';
export const scope: HistoryScope = { blobEndpoint: 'https://one.blob.core.windows.net/private', tableEndpoint: 'https://one.table.core.windows.net', container: 'private', table: 'history', partitionKey: 'account' };
export const bounds = { maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576 };
export function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function historyFixture(count = 2, sessionId = 'history-session') {
  const header = sessionHeader({ id: sessionId }); const binding = headerHash(header, 0); const genesis = genesisHash(sessionId, 1, binding);
  const events = Array.from({ length: count }, (_, seq) => event(seq));
  const rows: BatchRow[] = []; const blobs = new Map<string, Buffer>();
  let chain = genesis;
  for (const e of events) {
    const c = chainEvents(chain, [e]); const name = candidateBlobName(sessionId, 1, e.seq, 1, c.payloadHash);
    const row = batchRow(sessionId, 1, e.seq, { blobName: name, ...c, ...(rows.length ? { prevBatchRowKey: rows.at(-1)!.rowKey } : {}) });
    rows.push(row); blobs.set(name, gzipSync(payloadBytes([e]))); chain = c.chainHash;
  }
  const tip = rows.at(-1);
  let manifest: StoredManifest | undefined = { entity: cloudSession({ sessionId, headerJson: JSON.stringify(header), headerHash: binding,
    eventCount: count, headSeq: count - 1, headHash: tip?.headHash ?? genesis, chainHash: chain, batchCount: count,
    lastBatchRowKey: tip?.rowKey, lastBatchGeneration: tip?.generation, lastBatchBlobName: tip?.blobName }), etag: 'etag-1' };
  const calls = { manifest: 0, row: 0, blob: 0, list: 0, active: 0, peak: 0 };
  let beforeBlob: ((name: string, context?: { signal?: AbortSignal; check?: () => void | Promise<void> }) => void | Promise<void>) | undefined;
  let beforeManifest: (() => void | Promise<void>) | undefined;
  const repository = { partitionKey: 'account',
    getManifest: async (id: string) => { calls.manifest += 1; await beforeManifest?.(); return id === sessionId && manifest ? structuredClone(manifest) : undefined; },
    getBatch: async (key: string) => { calls.row += 1; return structuredClone(rows.find(row => row.rowKey === key)); },
    listBatchRows: async () => { calls.list += 1; throw new Error('History must not scan the batch index.'); },
    readCandidate: async (name: string, _bound: number, context?: { signal?: AbortSignal; check?: () => void | Promise<void> }) => {
      calls.blob += 1; calls.active += 1; calls.peak = Math.max(calls.peak, calls.active);
      try { await context?.check?.(); await beforeBlob?.(name, context); await context?.check?.(); const bytes = blobs.get(name); if (!bytes) throw new Error('missing remote blob'); return Buffer.from(bytes); }
      finally { calls.active -= 1; }
    },
  } as unknown as CloudRepository;
  return { sessionId, header, events, rows, blobs, calls, repository,
    get manifest(): StoredManifest { if (!manifest) throw new Error('The fixture manifest was explicitly removed.'); return manifest; },
    set manifest(value: StoredManifest) { manifest = value; },
    clearManifest() { manifest = undefined; },
    set beforeBlob(hook: typeof beforeBlob) { beforeBlob = hook; }, set beforeManifest(hook: typeof beforeManifest) { beforeManifest = hook; },
  };
}
