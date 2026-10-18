/**
 * Per-session quiet-period coordinator. It owns activity/flush/suffix marks and
 * releases a held lease only when the drain gate is satisfied.
 * @module @1yefuwang1/dsh-azure-sync/sync/drain-coordinator
 */
import { LeaseDrain, type DrainSnapshot } from './lease-drain.js';
import type { SessionLease } from './lease-manager.js';

export class DrainCoordinator {
  private readonly drains = new Map<string, LeaseDrain>();
  private readonly leases = new Map<string, SessionLease>();

  private drain(sessionId: string): LeaseDrain {
    let drain = this.drains.get(sessionId);
    if (drain === undefined) {
      drain = new LeaseDrain();
      this.drains.set(sessionId, drain);
    }
    return drain;
  }

  noteActivity(sessionId: string, now: number): void {
    this.drain(sessionId).noteActivity(now);
  }

  generation(sessionId: string): number {
    return this.drain(sessionId).generation();
  }

  markFlushed(sessionId: string): void {
    this.drain(sessionId).markFlushed();
  }

  markSuffix(sessionId: string): void {
    this.drain(sessionId).markSuffixPublished();
  }

  hold(lease: SessionLease): void {
    this.leases.set(lease.sessionId, lease);
  }

  take(sessionId: string): SessionLease | undefined {
    return this.leases.get(sessionId);
  }

  /** Release once ready; returns whether the lease was released. */
  async maybeRelease(sessionId: string, now: number, snapshot: DrainSnapshot, release: (lease: SessionLease) => Promise<void>): Promise<boolean> {
    const lease = this.leases.get(sessionId);
    if (lease === undefined) return false;
    if (!this.drain(sessionId).ready(now, snapshot)) return false;
    this.leases.delete(sessionId);
    this.drains.delete(sessionId);
    await release(lease);
    return true;
  }

  forget(sessionId: string): void {
    this.leases.delete(sessionId);
    this.drains.delete(sessionId);
  }
}
