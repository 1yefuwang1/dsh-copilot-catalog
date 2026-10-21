/** Crash-recoverable initial artifact through PUBLIC persistence only; unseeded v4 first release. */
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session';
import { SessionPersistenceNotFoundError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { payloadHash, sha256Hex, canonicalJson } from '../sync/canonical.js';
import { assertInitialImportHeader, type CoordinatorRegistration, type ImportGuardV1, type VerifiedDestinationImport } from './guard.js';
import { importFence, type ImportReservation } from './journal.js';
import type { SidClaim } from './claims.js';

export async function materializeInitial(input: {
  record: ImportReservation; header: SessionHeader; claim: SidClaim; registration: CoordinatorRegistration;
  guard: ImportGuardV1; persistence: SessionPersistence; signal: AbortSignal; now: () => number; retained?: boolean;
}): Promise<{ record: ImportReservation; proof: VerifiedDestinationImport }> {
  const { header, claim, registration, guard, persistence, signal } = input;
  assertInitialImportHeader(header, input.record.target.inheritedEventCount);
  let record = input.record;
  const artifact = record.artifact ?? { headerHash: record.localHeaderHash, inheritedEventCount: 0, prefixCount: 0, prefixHash: payloadHash([]) };
  if (!record.artifact) {
    if (!input.retained && record.phase !== 'materializing') record = await guard.journal.update(claim, importFence(record), current => ({ ...current, phase: 'materializing', revision: current.revision + 1, updatedAt: input.now() }));
    const write = input.retained ? registration.withRetainedInitial : registration.withWrite;
    await write(claim, importFence(record), signal, async () => {
      let handle;
      try { handle = await persistence.open(SessionId(record.target.sessionId), 'write', { signal }); }
      catch (error) {
        if (!(error instanceof SessionPersistenceNotFoundError)) throw error;
        handle = await persistence.create(header, { signal });
      }
      try {
        if ((await handle.read(0, undefined, { signal })).events.length !== 0) throw new Error('An unproven initial artifact unexpectedly contains history.');
        await handle.flush({ signal });
      } finally { await handle.close(); }
    });
  }
  // Fresh native backend instance, not the cached create header/cut. A crash in
  // this gap stays journal-owned; no legacy-repairable local session row exists.
  const prove = input.retained ? registration.proveRetainedReadable : registration.proveReadable;
  const proof = await prove(claim, importFence(record), artifact);
  if (!record.artifact) record = await guard.journal.update(claim, importFence(record), current => ({ ...current, phase: input.retained ? 'cancelled' : 'initial-readable', artifact,
    effects: [...current.effects, { kind: 'artifact', receiptHash: sha256Hex(canonicalJson(artifact)), at: input.now() }], revision: current.revision + 1, updatedAt: input.now() }));
  return { record, proof };
}
