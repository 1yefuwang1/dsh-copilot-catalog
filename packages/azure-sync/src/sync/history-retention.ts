/** Data-only active working-set reservations. These confer no cloud/native execution authority. */
import { AzureSyncError } from '../azure/errors.js';
import { historyNamespace, sameHistory, type HistoryWatermark } from './history-state.js';
import type { HistoryOwner } from './history-work.js';
export interface HistoryRetention { release(): void; }
export interface RetentionSize { readonly watermark: HistoryWatermark; readonly memory: number; readonly disk: number; }
export interface RetentionReservation { readonly size: RetentionSize; readonly placement: 'memory' | 'disk'; previous?: RetentionReservation; failed?: boolean; committed?: boolean; owners?: Set<HistoryOwner>; }
interface Entry { readonly sessionId: string; readonly owner: HistoryOwner; namespace?: string; watermark?: HistoryWatermark; readonly release: () => void; }
export class HistoryRetentionPool {
  private readonly entries = new Set<Entry>();
  private readonly sizes = new Map<string, RetentionSize>();
  private readonly reservations = new Map<string, RetentionReservation>();
  constructor(private readonly memoryBudget: number, private readonly diskBudget: number) {}
  enroll(sessionId: string, owner: HistoryOwner): HistoryRetention & { bind(w: HistoryWatermark): void } {
    let released = false;
    const entry: Entry = { sessionId, owner, release: () => {
      if (released) return; released = true; this.entries.delete(entry); owner.signal.removeEventListener('abort', entry.release); this.prune();
    } };
    this.entries.add(entry); owner.signal.addEventListener('abort', entry.release, { once: true });
    if (owner.signal.aborted) entry.release();
    return { release: entry.release, bind: w => {
      if (released || !this.matches(entry, w)) return;
      entry.namespace = historyNamespace(w); entry.watermark = w;
    } };
  }
  private matches(entry: Entry, w: HistoryWatermark): boolean {
    const c = entry.owner.context;
    return entry.sessionId === w.sessionId && (c.expectedScope === undefined || c.expectedScope === w.scope) &&
      (c.expectedGeneration === undefined || c.expectedGeneration === w.generation) &&
      (c.expectedRootSessionId === undefined || c.expectedRootSessionId === w.rootSessionId) &&
      (c.expectedRootGeneration === undefined || c.expectedRootGeneration === w.rootGeneration);
  }
  private namespaces(): Set<string> {
    const result = new Set<string>();
    for (const entry of this.entries) {
      if (entry.owner.signal.aborted) continue;
      if (entry.namespace) result.add(entry.namespace);
      else for (const [key, size] of this.sizes) if (this.matches(entry, size.watermark)) result.add(key);
    }
    return result;
  }
  private prune(): void {
    const active = this.namespaces();
    for (const key of this.reservations.keys()) if (!active.has(key)) this.reservations.delete(key);
  }
  private async active(owner: HistoryOwner): Promise<Set<string>> {
    await owner.check();
    for (const entry of [...this.entries]) {
      try { await owner.wait(entry.owner.check()); }
      catch (error) { if (owner.signal.aborted) throw error; entry.release(); }
    }
    await owner.check(); this.prune();
    const active = this.namespaces();
    for (const key of active) if (!this.reservations.has(key)) { const size = this.sizes.get(key); if (size) this.allocate(size); }
    return active;
  }
  remember(size: RetentionSize): void {
    const key = historyNamespace(size.watermark), previous = this.sizes.get(key);
    if (!previous || previous.watermark.eventCount <= size.watermark.eventCount) this.sizes.set(key, size);
  }
  known(w: HistoryWatermark): RetentionSize | undefined {
    const size = this.sizes.get(historyNamespace(w));
    return size && sameHistory(size.watermark, w) ? size : undefined;
  }
  private usage(excluding?: string): { memory: number; disk: number } {
    let memory = 0, disk = 0;
    for (const [key, reservation] of this.reservations) {
      if (key === excluding) continue;
      let m = 0, d = 0;
      for (let current: RetentionReservation | undefined = reservation; current; current = current.previous) {
        if (current.failed) continue;
        if (current.placement === 'memory') m = Math.max(m, current.size.memory); else d = Math.max(d, current.size.disk);
      }
      memory += m; disk += d;
    }
    return { memory, disk };
  }
  private allocate(size: RetentionSize): RetentionReservation | undefined {
    const key = historyNamespace(size.watermark), previous = this.reservations.get(key), used = this.usage(key);
    if (previous && !previous.failed && sameHistory(previous.size.watermark, size.watermark) && previous.size.memory === size.memory && previous.size.disk === size.disk) return previous;
    let placement: RetentionReservation['placement'] | undefined;
    if (size.memory <= this.memoryBudget - used.memory) placement = 'memory';
    else if (this.diskBudget > 0 && size.disk <= this.diskBudget - used.disk) placement = 'disk';
    if (!placement) return undefined;
    const reservation: RetentionReservation = { size, placement, ...(previous ? { previous } : {}) };
    this.reservations.set(key, reservation); return reservation;
  }
  async reserve(size: RetentionSize, owner: HistoryOwner): Promise<RetentionReservation> {
    this.remember(size);
    const active = await this.active(owner);
    // Existing reservations win; enrollments do not steal an active writer's payload capacity.
    for (const key of active) {
      if (this.reservations.has(key)) continue;
      const known = this.sizes.get(key); if (known) this.allocate(known);
    }
    const result = this.allocate(size);
    if (!result) throw new AzureSyncError('LIMIT', 'Active canonical histories exceed the local cache working-set capacity. Release another active writer or increase capacity before retrying.');
    result.owners ??= new Set(); result.owners.add(owner);
    return result;
  }
  commit(reservation: RetentionReservation): void {
    const key = historyNamespace(reservation.size.watermark);
    reservation.committed = true;
    if (this.reservations.get(key) === reservation) reservation.previous = undefined;
  }
  rollback(reservation: RetentionReservation, owner: HistoryOwner): void {
    reservation.owners?.delete(owner);
    for (const other of reservation.owners ?? []) if (other.signal.aborted) reservation.owners?.delete(other);
    if (reservation.committed || (reservation.owners?.size ?? 0) > 0) return;
    reservation.failed = true;
    const key = historyNamespace(reservation.size.watermark);
    if (this.reservations.get(key) !== reservation) return;
    let previous = reservation.previous;
    while (previous?.failed) previous = previous.previous;
    if (previous) this.reservations.set(key, previous); else this.reservations.delete(key);
  }
  private protectedNow(): { memory: Set<string>; disk: Set<string> } {
    const active = this.namespaces(), memory = new Set<string>(), disk = new Set<string>();
    for (const key of active) {
      const reservation = this.reservations.get(key);
      if (!reservation) { disk.add(key); continue; } // A selected disk prefix may still be undergoing its first rehash.
      for (let current: RetentionReservation | undefined = reservation; current; current = current.previous) {
        if (!current.failed) (current.placement === 'memory' ? memory : disk).add(key);
      }
    }
    return { memory, disk };
  }
  memoryProtected(): ReadonlySet<string> { return this.protectedNow().memory; }
  async diskProtected(owner: HistoryOwner): Promise<ReadonlySet<string>> { await this.active(owner); return this.protectedNow().disk; }
  invalidate(sessionId?: string): void {
    for (const entry of [...this.entries]) if (sessionId === undefined || entry.sessionId === sessionId) entry.release();
    for (const [key, size] of this.sizes) if (sessionId === undefined || size.watermark.sessionId === sessionId) this.sizes.delete(key);
    this.prune();
  }
}
