/** Explicit fixture injection; production consumers never create private readers. */
import type { ImportDependencies } from '../src/sync/importer.js';
import { RemoteSessionReader, type HistoryReadContext } from '../src/sync/remote-session.js';
import { historyScopeId } from '../src/sync/history-state.js';

export const fixtureHistoryScope = { blobEndpoint: 'https://fixture.blob.invalid', tableEndpoint: 'https://fixture.table.invalid',
  container: 'fixture', table: 'Fixture', partitionKey: 'account' };
export const fixturePublicationScope = historyScopeId(fixtureHistoryScope);

export function trackRetentions(reader: RemoteSessionReader, observe?: (active: number) => void) {
  const retain = reader.retain.bind(reader);
  const entries: Array<{ sessionId: string; context: HistoryReadContext; released: boolean }> = [];
  const active = () => entries.filter(entry => !entry.released && !entry.context.signal?.aborted);
  reader.retain = (sessionId, context) => {
    const inner = retain(sessionId, context), entry = { sessionId, context, released: false }; entries.push(entry); observe?.(active().length);
    return { release() { if (!entry.released) { entry.released = true; inner.release(); observe?.(active().length); } } };
  };
  return { entries, active };
}

export function withHistory(deps: ImportDependencies): ImportDependencies {
  // Older explicit transports exposed only their fixture row list. Supply a
  // point-read adapter here, never in production repository/cache code.
  const repository = Object.create(deps.repository) as ImportDependencies['repository'];
  if (typeof repository.getBatch !== 'function') repository.getBatch = async key => {
    const match = /^batch:([^:]+):gen-([0-9]+):/u.exec(key);
    if (!match) return undefined;
    const rows = await deps.repository.listBatchRows(Buffer.from(match[1]!, 'base64url').toString('utf8'), Number(match[2]));
    return rows.find(row => row.rowKey === key);
  };
  return { ...deps, reader: deps.reader ?? new RemoteSessionReader(repository, {
    scope: fixtureHistoryScope,
    maxCompressedBytes: Math.max(deps.config.maxBatchBytes * 4, 1_048_576),
    maxExpandedBytes: deps.config.maxBatchBytes, maxEvents: deps.config.maxEventsPerSession,
  }) };
}
