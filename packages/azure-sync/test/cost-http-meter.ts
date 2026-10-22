import assert from 'node:assert/strict';
import { createServer, request as forwardRequest } from 'node:http';

/** HTTP-attempt and streamed response BODY counters. Never records URLs, headers, payloads or credentials. */
export function emptyCostCounts() {
  return {
    blobWrites: 0, blobReads: 0, blobLists: 0, blobOther: 0,
    tableReads: 0, tableQueries: 0, tableWrites: 0, tableBatches: 0, tableOther: 0,
    putBlocks: 0, putBlockLists: 0, leaseOperations: 0, leaseAcquisitions30: 0, leaseAcquisitions60: 0,
    leaseBlobWrites: 0, historyBlobWrites: 0, failedResponses: 0,
    historyGET: 0, historyHEAD: 0, historyRangeGET: 0,
    batchRowPointReads: 0, batchIndexQueries: 0, manifestPointReads: 0,
    historyResponseBytes: 0, historyGETResponseBytes: 0, historyHEADResponseBytes: 0,
    tablePointResponseBytes: 0, tableQueryResponseBytes: 0,
    batchRowPointResponseBytes: 0, batchIndexQueryResponseBytes: 0,
    leaseResponseBytes: 0, otherResponseBytes: 0, totalResponseBytes: 0,
  };
}
export type CostCounts = ReturnType<typeof emptyCostCounts>;
const requestKeys = ['blobWrites', 'blobReads', 'blobLists', 'blobOther', 'tableReads', 'tableQueries', 'tableWrites', 'tableBatches', 'tableOther'] as const;
export const totalCostRequests = (counts: CostCounts): number => requestKeys.reduce((sum, key) => sum + counts[key], 0);
export function combineCostCounts(parts: readonly [CostCounts, number][]): CostCounts {
  const result = emptyCostCounts();
  for (const [value, times] of parts) for (const key of Object.keys(result) as (keyof CostCounts)[]) result[key] += value[key] * times;
  return result;
}
export function assertByteLedger(counts: CostCounts): void {
  assert.equal(counts.totalResponseBytes, counts.historyResponseBytes + counts.tablePointResponseBytes + counts.tableQueryResponseBytes + counts.leaseResponseBytes + counts.otherResponseBytes, 'disjoint body-byte categories sum exactly once');
  assert.equal(counts.historyResponseBytes, counts.historyGETResponseBytes + counts.historyHEADResponseBytes);
  assert.ok(counts.batchRowPointResponseBytes <= counts.tablePointResponseBytes);
  assert.ok(counts.batchIndexQueryResponseBytes <= counts.tableQueryResponseBytes);
}
export function assertNoHistory(counts: CostCounts): void {
  assert.equal(counts.historyGET, 0); assert.equal(counts.historyHEAD, 0); assert.equal(counts.historyResponseBytes, 0);
  assert.equal(counts.batchRowPointReads, 0); assert.equal(counts.batchIndexQueries, 0);
}
/** Loopback reverse proxy forwards the real SDK transport, including retries, pagination and ranges. */
export class CostHttpMeter {
  private observed?: CostCounts;
  private injectHeadFailure = false;
  private readonly servers: ReturnType<typeof createServer>[] = [];
  readonly profiles: Record<string, CostCounts> = {};
  readonly localMetrics: Record<string, { elapsedMs: number; cpuUserMicros: number; cpuSystemMicros: number; heapBeforeBytes: number; heapAfterBytes: number }> = {};
  peakHeapUsed = process.memoryUsage().heapUsed;
  peakRss = process.memoryUsage().rss;
  sampleMemory(): void { const memory = process.memoryUsage(); this.peakHeapUsed = Math.max(this.peakHeapUsed, memory.heapUsed); this.peakRss = Math.max(this.peakRss, memory.rss); }
  failNextHead(): void { this.injectHeadFailure = true; }
  async measure<T>(name: string, action: () => Promise<T>): Promise<T> {
    assert.equal(this.observed, undefined); assert.equal(this.profiles[name], undefined);
    const counts = emptyCostCounts(); this.observed = counts;
    const started = performance.now(), cpuBefore = process.cpuUsage(), heapBeforeBytes = process.memoryUsage().heapUsed;
    try { return await action(); }
    finally {
      const cpu = process.cpuUsage(cpuBefore);
      this.observed = undefined; assertByteLedger(counts); this.profiles[name] = { ...counts }; this.sampleMemory();
      this.localMetrics[name] = { elapsedMs: performance.now() - started, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system,
        heapBeforeBytes, heapAfterBytes: process.memoryUsage().heapUsed };
    }
  }
  async proxy(target: URL, kind: 'blob' | 'table'): Promise<string> {
    assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1', 'paid/live endpoints are forbidden');
    const server = createServer((incoming, outgoing) => {
      const counts = this.observed;
      const url = new URL(incoming.url ?? '/', target.origin), method = incoming.method ?? 'GET', comp = url.searchParams.get('comp');
      const path = decodeURIComponent(url.pathname);
      const point = kind === 'table' && method === 'GET' && path.includes('PartitionKey=');
      const query = kind === 'table' && method === 'GET' && !point;
      const batchPoint = point && /RowKey='batch:/u.test(path);
      const manifestPoint = point && /RowKey='session:/u.test(path);
      const batchQuery = query && (url.searchParams.get('$filter') ?? '').includes("RowKey ge 'batch:");
      const history = kind === 'blob' && path.includes('/v1/sessions/') && path.endsWith('.jsonl.gz') && (method === 'GET' || method === 'HEAD');
      const lease = kind === 'blob' && (comp === 'lease' || path.includes('/v1/leases/'));
      let ranged = history && method === 'GET' && (incoming.headers.range !== undefined || incoming.headers['x-ms-range'] !== undefined);
      if (counts) {
        if (kind === 'table') {
          if (path.endsWith('/$batch')) counts.tableBatches += 1;
          else if (method === 'GET') { if (point) counts.tableReads += 1; else counts.tableQueries += 1; }
          else if (['POST', 'PUT', 'MERGE', 'PATCH', 'DELETE'].includes(method)) counts.tableWrites += 1;
          else counts.tableOther += 1;
          if (batchPoint) counts.batchRowPointReads += 1;
          if (manifestPoint) counts.manifestPointReads += 1;
          if (batchQuery) counts.batchIndexQueries += 1;
        } else if (comp === 'list') counts.blobLists += 1;
        else if (comp === 'lease') {
          counts.blobOther += 1; counts.leaseOperations += 1;
          if (incoming.headers['x-ms-lease-action'] === 'acquire') {
            if (incoming.headers['x-ms-lease-duration'] === '30') counts.leaseAcquisitions30 += 1;
            if (incoming.headers['x-ms-lease-duration'] === '60') counts.leaseAcquisitions60 += 1;
          }
        } else if (method === 'PUT') {
          counts.blobWrites += 1;
          if (comp === 'block') counts.putBlocks += 1;
          if (comp === 'blocklist') counts.putBlockLists += 1;
          if (path.includes('/v1/leases/')) counts.leaseBlobWrites += 1;
          if (path.includes('/v1/sessions/')) counts.historyBlobWrites += 1;
        } else if (method === 'GET' && !['container', 'service'].includes(url.searchParams.get('restype') ?? '')) counts.blobReads += 1;
        else counts.blobOther += 1;
        if (history && method === 'GET') counts.historyGET += 1;
        if (history && method === 'HEAD') counts.historyHEAD += 1;
        if (ranged) counts.historyRangeGET += 1;
      }
      if (this.injectHeadFailure && kind === 'blob' && method === 'HEAD') {
        this.injectHeadFailure = false; if (counts) counts.failedResponses += 1;
        outgoing.writeHead(503, { 'x-ms-error-code': 'ServerBusy', 'content-length': '0' }); outgoing.end(); return;
      }
      const request = forwardRequest({ hostname: target.hostname, port: target.port, method, path: incoming.url, headers: { ...incoming.headers, host: target.host } }, response => {
        if (counts) {
          if ((response.statusCode ?? 500) >= 400) counts.failedResponses += 1;
          if (history && method === 'GET' && response.statusCode === 206 && !ranged) { ranged = true; counts.historyRangeGET += 1; }
        }
        response.on('data', (chunk: Buffer) => {
          if (!counts) return;
          const bytes = chunk.byteLength; counts.totalResponseBytes += bytes;
          if (history) { counts.historyResponseBytes += bytes; if (method === 'GET') counts.historyGETResponseBytes += bytes; else counts.historyHEADResponseBytes += bytes; }
          else if (point) { counts.tablePointResponseBytes += bytes; if (batchPoint) counts.batchRowPointResponseBytes += bytes; }
          else if (query) { counts.tableQueryResponseBytes += bytes; if (batchQuery) counts.batchIndexQueryResponseBytes += bytes; }
          else if (lease) counts.leaseResponseBytes += bytes;
          else counts.otherResponseBytes += bytes;
          this.sampleMemory();
        });
        outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
      });
      request.on('error', () => { if (counts) counts.failedResponses += 1; if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.on('aborted', () => request.destroy()); incoming.pipe(request);
    });
    this.servers.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
  }
  async close(): Promise<void> {
    for (const server of this.servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  }
}
