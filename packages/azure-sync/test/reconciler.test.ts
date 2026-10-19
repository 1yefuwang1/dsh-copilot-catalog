import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileManifest } from '../src/sync/reconciler.js';
import { cloudSession, event, sessionHeader } from './helpers.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import type { SourceSnapshot } from '../src/sync/session-source.js';

function fixture(localEvents = [event(0), event(1)], remoteEvents = localEvents) {
  const header = sessionHeader();
  const hash = headerHash(header, 0);
  const genesis = genesisHash(header.id, 2, hash);
  const commitment = remoteEvents.length === 0 ? { chainHash: genesis, headHash: genesis } : chainEvents(genesis, remoteEvents);
  return {
    manifest: cloudSession({ sessionId: header.id, generation: 2, headerHash: hash, inheritedEventCount: 0, ...commitment, eventCount: remoteEvents.length, headSeq: remoteEvents.length - 1 }),
    localGeneration: 2, local: { header, inheritedEventCount: 0, events: localEvents } as unknown as SourceSnapshot, remoteEvents: remoteEvents as never,
  };
}

test('only verified common canonical prefixes permit same/local/remote direction', () => {
  for (const [local, remote, kind] of [[2, 2, 'same'], [1, 2, 'remote-ahead'], [3, 2, 'local-ahead'], [0, 0, 'same'], [0, 1, 'remote-ahead'], [1, 0, 'local-ahead']] as const) {
    const events = [event(0), event(1), event(2)];
    const result = reconcileManifest(fixture(events.slice(0, local), events.slice(0, remote)));
    assert.equal(result.kind, kind);
    assert.equal(result.stop, false);
  }
});

test('equal counts and either ahead direction cannot hide divergent events', () => {
  for (const [local, remote] of [[1, 1], [1, 2], [2, 1]]) {
    const first = [event(0, 'user/message', { text: 'local' }), event(1)];
    const second = [event(0, 'user/message', { text: 'remote' }), event(1)];
    assert.deepEqual(reconcileManifest(fixture(first.slice(0, local), second.slice(0, remote))), { kind: 'diverged', importEvents: false, uploadEvents: false, stop: true });
  }
});

test('header, inherited cut and sequence tampering diverge even at equal counts', () => {
  const f = fixture();
  assert.equal(reconcileManifest({ ...f, local: { ...f.local, inheritedEventCount: 1 } }).kind, 'diverged');
  assert.equal(reconcileManifest({ ...f, local: { ...f.local, header: { ...f.local.header, cwd: '/other' } } }).kind, 'diverged');
  assert.equal(reconcileManifest({ ...f, local: { ...f.local, events: [event(1), event(2)] as never } }).kind, 'diverged');
});

test('tombstones, generations and shared opt-out stop before prefix work', () => {
  const f = fixture();
  assert.equal(reconcileManifest({ ...f, manifest: { ...f.manifest, state: 'deleted' } }).kind, 'deleted');
  assert.equal(reconcileManifest({ ...f, localGeneration: 1 }).kind, 'generation-changed');
  assert.equal(reconcileManifest({ ...f, manifest: { ...f.manifest, state: 'disabled' } }).kind, 'disabled');
  assert.equal(reconcileManifest({ ...f, manifest: { ...f.manifest, enabled: false } }).kind, 'disabled');
});

test('remote commitments are verified rather than trusted as count hints', () => {
  const f = fixture();
  assert.throws(() => reconcileManifest({ ...f, manifest: { ...f.manifest, chainHash: 'a'.repeat(64) } }), /manifest commitment/u);
  const empty = fixture([], []);
  assert.throws(() => reconcileManifest({ ...empty, manifest: { ...empty.manifest, headSeq: 0 } }), /manifest commitment/u);
});
