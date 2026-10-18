/**
 * Live/cold catch-up policy. A live Agent owns its write handle; the plugin
 * never opens a second writer or pretends the GUI close disposed the host Agent.
 * @module @1yefuwang1/dsh-azure-sync/sync/live-guard
 */
export type LiveBlockReason = 'remote-ahead-live' | 'remote-ahead-cold';

export interface LiveCatchupDecision {
  readonly blocked: boolean;
  readonly reason?: LiveBlockReason;
  readonly openWrite: boolean;
  readonly restartRequired: boolean;
  readonly importAllowed: boolean;
}

export function decideLiveCatchup(live: boolean, remoteEventCount: number, localEventCount: number): LiveCatchupDecision {
  const ahead = remoteEventCount > localEventCount;
  if (!ahead) return { blocked: false, openWrite: false, restartRequired: false, importAllowed: false };
  if (live) return { blocked: true, reason: 'remote-ahead-live', openWrite: false, restartRequired: true, importAllowed: false };
  return { blocked: false, openWrite: true, restartRequired: false, importAllowed: true };
}

export const REMOTE_AHEAD_LIVE_MESSAGE = 'This thread has newer cloud changes. Restart the DSH host to load them; do not continue from stale local state.';
