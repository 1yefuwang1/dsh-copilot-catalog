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
import type { SyncStatus } from '../schema.js';

export interface OwnershipProof {
  readonly owned: boolean;
  readonly reason?: 'paused-other-device' | 'ownership-unverified' | 'remote-ahead-live' | 'generation-changed' | 'removed-remotely';
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
  const record = input.local.getSession(input.sessionId);
  if (record === undefined) return;
  await input.local.putSession({
    ...record,
    status: fallback ? 'ownership-unverified' : status,
    ...(fallback ? { lastError: 'Failed to prepend claimed messages back to next-turn; appended instead.' } : {}),
    admissionReceipt: {
      reason: status,
      messageIds: input.messages.map((message) => String(message.id)).slice(0, 256),
      turn: input.turn,
      step: input.step,
      at: input.now(),
    },
  });
}

/** Admit or reject one pre-step after a fresh server ownership proof. */
export async function admitPreStep(input: AdmissionInput): Promise<AdmissionResult> {
  const record = input.local.getSession(input.sessionId);
  if (record === undefined || !record.enabled) return { kind: 'enter', messages: [...input.messages] };
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
