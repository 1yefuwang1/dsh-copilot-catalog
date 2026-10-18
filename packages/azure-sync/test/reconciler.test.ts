import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileManifest } from '../src/sync/reconciler.js';

test('reconciliation classifies same/local-ahead/remote-ahead and stops on deleted/generation change', () => {
  const base = { state: 'active' as const, generation: 2, eventCount: 5 };
  assert.equal(reconcileManifest({ manifest: base, localGeneration: 2, localEventCount: 5 }).kind, 'same');
  assert.equal(reconcileManifest({ manifest: base, localGeneration: 2, localEventCount: 3 }).kind, 'remote-ahead');
  assert.equal(reconcileManifest({ manifest: base, localGeneration: 2, localEventCount: 8 }).kind, 'local-ahead');
  assert.deepEqual(reconcileManifest({ manifest: { ...base, state: 'deleted' }, localGeneration: 2, localEventCount: 5 }), { kind: 'deleted', importEvents: false, uploadEvents: false, stop: true });
  assert.equal(reconcileManifest({ manifest: base, localGeneration: 1, localEventCount: 5 }).kind, 'generation-changed');
});
