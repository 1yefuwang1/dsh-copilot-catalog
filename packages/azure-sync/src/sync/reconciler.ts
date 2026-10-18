/**
 * Manifest/local reconciliation classification. Import selection itself always
 * follows the committed tip links; this module never adopts sibling candidates.
 * @module @1yefuwang1/dsh-azure-sync/sync/reconciler
 */
import type { CloudSessionEntity } from '../schema.js';

export type ReconcileKind = 'same' | 'local-ahead' | 'remote-ahead' | 'diverged' | 'deleted' | 'generation-changed';

export interface ReconcileDecision {
  readonly kind: ReconcileKind;
  readonly importEvents: boolean;
  readonly uploadEvents: boolean;
  readonly stop: boolean;
}

export function reconcileManifest(input: {
  readonly manifest: Pick<CloudSessionEntity, 'state' | 'generation' | 'eventCount'>;
  readonly localGeneration: number;
  readonly localEventCount: number;
}): ReconcileDecision {
  if (input.manifest.state === 'deleted') return { kind: 'deleted', importEvents: false, uploadEvents: false, stop: true };
  if (input.manifest.generation !== input.localGeneration) return { kind: 'generation-changed', importEvents: false, uploadEvents: false, stop: true };
  if (input.manifest.eventCount === input.localEventCount) return { kind: 'same', importEvents: false, uploadEvents: false, stop: false };
  if (input.manifest.eventCount > input.localEventCount) return { kind: 'remote-ahead', importEvents: true, uploadEvents: false, stop: false };
  return { kind: 'local-ahead', importEvents: false, uploadEvents: true, stop: false };
}

export function isDiverged(decision: ReconcileDecision): boolean {
  return decision.kind === 'diverged';
}
