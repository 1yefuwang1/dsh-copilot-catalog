/** Browser-only ownership adapter for the SDK's singleton composer block slot. */
export interface CloudStore<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface CloudBlock { readonly reason: string }
export interface CloudBlocks {
  storeFor(sessionId: string): CloudStore<CloudBlock | undefined>;
  set(sessionId: string, block: CloudBlock | undefined): void;
}
interface Entry {
  readonly store: CloudStore<CloudBlock | undefined>;
  readonly refs: Map<object, Map<string, number>>;
  marker: CloudBlock;
  stop: () => void;
  busy: boolean;
  dirty: boolean;
}
type Registry = WeakMap<CloudBlocks, Map<string, Entry>>;
// A Symbol property, rather than a top-level global lexical binding, survives IIFE HMR.
const registryKey = Symbol.for('azure-sync.composer-owners.v1');
function registry(): Registry {
  const root = globalThis as unknown as Record<symbol, Registry | undefined>;
  return root[registryKey] ??= new WeakMap();
}

export interface CloudBlockOwner {
  /** Each acquisition has an independent, idempotent release (including identical reasons). */
  acquire(sessionId: string, reason: string): () => void;
  dispose(): void;
}
export function createComposerBlockOwner(blocks: CloudBlocks): CloudBlockOwner {
  const owner = {};
  const releases = new Set<() => void>();
  let disposed = false;
  const services = registry();
  let sessions = services.get(blocks);
  if (!sessions) { sessions = new Map(); services.set(blocks, sessions); }
  const entries = sessions;
  function reconcile(sessionId: string, entry: Entry): void {
    if (entry.busy) { entry.dirty = true; return; }
    entry.busy = true;
    try {
      do {
        entry.dirty = false;
        if (entries.get(sessionId) !== entry) return;
        const current = entry.store.getSnapshot();
        if (entry.refs.size === 0) {
          // Unsubscribe BEFORE clearing: synchronous notification cannot reacquire.
          entries.delete(sessionId); entry.stop();
          if (current === entry.marker) blocks.set(sessionId, undefined);
          return;
        }
        // Keep the published reason owned by an actual live reference, without a clear/reacquire gap.
        const reason = entry.refs.values().next().value!.keys().next().value!;
        if (reason !== entry.marker.reason) {
          const previous = entry.marker;
          entry.marker = Object.freeze({ reason });
          if (current === undefined || current === previous) blocks.set(sessionId, entry.marker);
        } else if (current === undefined) {
          // A foreign owner always wins the singleton slot. Observe it until it clears.
          blocks.set(sessionId, entry.marker);
        }
      } while (entry.dirty);
    } finally { entry.busy = false; }
  }
  return {
    acquire(sessionId, reason) {
      if (disposed) return () => undefined;
      let entry = entries.get(sessionId);
      if (!entry) {
        entry = { store: blocks.storeFor(sessionId), refs: new Map(), marker: Object.freeze({ reason }), stop: () => undefined, busy: true, dirty: false };
        entries.set(sessionId, entry);
        const captured = entry;
        entry.stop = entry.store.subscribe(() => reconcile(sessionId, captured));
        entry.busy = false;
      }
      let reasons = entry.refs.get(owner);
      if (!reasons) { reasons = new Map(); entry.refs.set(owner, reasons); }
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      const captured = entry;
      let released = false;
      const release = () => {
        if (released) return;
        released = true; releases.delete(release);
        const owned = captured.refs.get(owner);
        const count = owned?.get(reason) ?? 0;
        if (count <= 1) owned?.delete(reason); else owned!.set(reason, count - 1);
        if (owned?.size === 0) captured.refs.delete(owner);
        reconcile(sessionId, captured);
      };
      releases.add(release);
      reconcile(sessionId, entry);
      return release;
    },
    dispose() { if (disposed) return; disposed = true; for (const release of [...releases]) release(); },
  };
}
