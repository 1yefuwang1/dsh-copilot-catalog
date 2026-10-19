/**
 * Per-step admission gate. The caller supplies a fresh ownership proof from the
 * lease manager (Blob renew + manifest epoch read); rejection requeues the
 * claimed messages to `next-turn`, last-to-first, with an append fallback and a
 * local receipt.
 * @module @1yefuwang1/dsh-azure-sync/sync/admission
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-session';
import type { LocalStore } from '../local/store.js';
import type { LocalSessionRecord, SyncStatus } from '../schema.js';

const REMOTE_STOP_STATUSES = new Set<SyncStatus>(['removed-remotely', 'generation-changed', 'remote-missing', 'conflict', 'remote-ahead-live']);

/** Publication opt-out is not authorization to execute a stale remote-stopped copy. */
export function requiresCloudAdmission(record: LocalSessionRecord | undefined): boolean {
  const incomplete = record?.importState !== undefined && record.importState !== 'complete' &&
    !(record.importState === 'degraded' && record.degradedAcknowledged);
  return record !== undefined && (record.resurrectionIntent !== undefined ||
    (!record.detached && (record.enabled || record.admissionStopped === true || REMOTE_STOP_STATUSES.has(record.status) || incomplete)));
}

export interface OwnershipProof {
  readonly owned: boolean;
  readonly reason?: 'paused-other-device' | 'ownership-unverified' | 'remote-ahead-live' | 'generation-changed' | 'removed-remotely' | 'remote-missing' | 'conflict';
}

export interface AdmissionInput {
  readonly agent: Agent;
  readonly sessionId: string;
  readonly messages: readonly UserMessage[];
  readonly turn: number;
  readonly step: number;
  readonly local: LocalStore;
  readonly ownership: () => Promise<OwnershipProof>;
  readonly now: () => number;
}

export type AdmissionResult =
  | { readonly kind: 'enter'; readonly messages: UserMessage[] }
  | { readonly kind: 'reject' };

async function requeue(input: AdmissionInput, status: SyncStatus, fallback: boolean): Promise<void> {
  if (!fallback) {
    try {
      for (const message of [...input.messages].reverse()) input.agent.inbox.prepend('next-turn', message);
    } catch {
      // Fall through to the ordered append fallback.
      fallback = true;
    }
  }
  if (fallback) {
    for (const message of input.messages) {
      try { input.agent.inbox.append('next-turn', message); } catch { /* best-effort; receipt records the failure */ }
    }
  }
  const admissionReceipt = {
    reason: status,
    messageIds: input.messages.map((message) => String(message.id)).slice(0, 256),
    turn: input.turn,
    step: input.step,
    at: input.now(),
  };
  await input.local.mutateSession(input.sessionId, (record) => ({
    ...record,
    // A queued off/detach or newer terminal stop wins over this proof's diagnostic.
    // The receipt still records why these claimed messages were rejected.
    status: !record.enabled || record.detached || record.admissionStopped || REMOTE_STOP_STATUSES.has(record.status)
      ? record.status
      : fallback && !REMOTE_STOP_STATUSES.has(status) ? 'ownership-unverified' : status,
    ...(fallback ? { lastError: 'Failed to prepend claimed messages back to next-turn; appended instead.' } : {}),
    admissionReceipt,
  }));
}

/** Admit or reject one pre-step after a fresh server ownership proof. */
export async function admitPreStep(input: AdmissionInput): Promise<AdmissionResult> {
  const record = input.local.getSession(input.sessionId);
  if (!requiresCloudAdmission(record)) return { kind: 'enter', messages: [...input.messages] };
  if (record === undefined) return { kind: 'reject' };
  if (record.admissionStopped || REMOTE_STOP_STATUSES.has(record.status)) {
    await requeue(input, record.status, false);
    return { kind: 'reject' };
  }
  if (record.importState !== undefined && record.importState !== 'complete' &&
      !(record.importState === 'degraded' && record.degradedAcknowledged)) {
    await requeue(input, 'import-incomplete', false);
    return { kind: 'reject' };
  }
  let proof: OwnershipProof;
  try {
    proof = await input.ownership();
  } catch {
    await requeue(input, 'ownership-unverified', false);
    return { kind: 'reject' };
  }
  if (!proof.owned) {
    const status = proof.reason ?? 'paused-other-device';
    await requeue(input, status, false);
    return { kind: 'reject' };
  }
  return { kind: 'enter', messages: [...input.messages] };
}
