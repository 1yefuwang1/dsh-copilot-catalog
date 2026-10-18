/**
 * Quiet-period drain gate. A writer lease is released only after the agent is
 * idle, the inbox is empty, no event arrived for two seconds, the persistence
 * barrier completed, and the final suffix was published.
 * @module @1yefuwang1/dsh-azure-sync/sync/lease-drain
 */
export interface DrainSnapshot {
  readonly inboxSize: number;
  readonly agentIdle: boolean;
}

export class LeaseDrain {
  private lastActivityAt = 0;
  private flushed = false;
  private suffixPublished = false;
  private activityGeneration = 0;

  noteActivity(now: number): void {
    this.activityGeneration += 1;
    this.lastActivityAt = now;
    this.flushed = false;
    this.suffixPublished = false;
  }

  markFlushed(): void {
    this.flushed = true;
  }

  markSuffixPublished(): void {
    this.suffixPublished = true;
  }

  reset(): void {
    this.activityGeneration = 0;
    this.lastActivityAt = 0;
    this.flushed = false;
    this.suffixPublished = false;
  }

  generation(): number {
    return this.activityGeneration;
  }

  ready(now: number, snapshot: DrainSnapshot, quietMs = 2_000): boolean {
    return snapshot.agentIdle && snapshot.inboxSize === 0 && this.flushed && this.suffixPublished &&
      now - this.lastActivityAt >= quietMs;
  }
}
