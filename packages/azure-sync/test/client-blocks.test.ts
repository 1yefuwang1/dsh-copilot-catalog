import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComposerBlockOwner, type CloudBlock, type CloudBlocks, type CloudStore } from '../client-blocks.js';

function registry(immediate = false) {
  type State = { value: CloudBlock | undefined; listeners: Set<() => void>; store: CloudStore<CloudBlock | undefined> };
  const states = new Map<string, State>();
  const writes: Array<{ id: string; value: CloudBlock | undefined }> = [];
  function state(id: string): State {
    let entry = states.get(id);
    if (!entry) {
      const listeners = new Set<() => void>();
      entry = { value: undefined, listeners, store: { getSnapshot: () => state(id).value, subscribe(listener) { listeners.add(listener); if (immediate) listener(); return () => { listeners.delete(listener); }; } } };
      states.set(id, entry);
    }
    return entry;
  }
  const force = (id: string, value: CloudBlock | undefined) => {
    const entry = state(id); entry.value = value; writes.push({ id, value });
    assert.ok(writes.length < 1000, 'synchronous notifications must not recurse forever');
    for (const listener of [...entry.listeners]) listener();
  };
  const blocks: CloudBlocks = {
    storeFor(id) { return state(id).store; },
    // Match the pinned public SDK: equal reasons are a no-op, not an ownership transfer.
    set(id, value) { if (state(id).value?.reason !== value?.reason) force(id, value); },
  };
  return { blocks, force, writes, get: (id = 's') => state(id).value, subscriptions: (id = 's') => state(id).listeners.size };
}

test('identical acquisitions refcount per owner/reason; multiple components and HMR owners have no clear gap', () => {
  const f = registry(), a = createComposerBlockOwner(f.blocks), b = createComposerBlockOwner(f.blocks);
  const a1 = a.acquire('s', 'cloud'), marker = f.get();
  const a2 = a.acquire('s', 'cloud'), b1 = b.acquire('s', 'cloud'), b2 = b.acquire('s', 'another cloud safety reason');
  assert.ok(marker); assert.equal(f.get(), marker); assert.equal(f.subscriptions(), 1);
  a1(); a1(); a2(); a.dispose(); assert.equal(f.get(), marker);
  b1(); const surviving = f.get(); assert.equal(surviving?.reason, 'another cloud safety reason'); assert.equal(f.writes.filter(write => write.value === undefined).length, 0);
  b2(); assert.equal(f.get(), undefined); assert.equal(f.subscriptions(), 0);
  assert.deepEqual(f.writes.map(write => write.value), [marker, surviving, undefined]);
  b.dispose(); b2(); assert.equal(f.writes.length, 3);
});

test('foreign block before acquire is never changed; active refs reacquire immediately when foreign clears', () => {
  const f = registry(), foreign = { reason: 'worktrees checkout' }; f.blocks.set('s', foreign);
  const owner = createComposerBlockOwner(f.blocks), release = owner.acquire('s', 'cloud');
  assert.equal(f.get(), foreign); assert.equal(f.writes.length, 1); assert.equal(f.subscriptions(), 1);
  f.blocks.set('s', undefined); assert.equal(f.get()?.reason, 'cloud');
  const marker = f.get(); release(); assert.equal(f.get(), undefined);
  assert.deepEqual(f.writes.map(write => write.value), [foreign, undefined, marker, undefined]);
  assert.equal(f.subscriptions(), 0); owner.dispose();
});

test('foreign replacement after acquire survives all release and plugin-unload cleanup', () => {
  const f = registry(), a = createComposerBlockOwner(f.blocks), b = createComposerBlockOwner(f.blocks);
  const release = a.acquire('s', 'cloud'); b.acquire('s', 'cloud');
  const foreign = { reason: 'worktrees is moving this session' }; f.blocks.set('s', foreign);
  release(); a.dispose(); assert.equal(f.get(), foreign); b.dispose(); assert.equal(f.get(), foreign);
  assert.equal(f.subscriptions(), 0);
  f.blocks.set('s', undefined); assert.equal(f.get(), undefined, 'unloaded owners must not reacquire');
});

test('ownership is object identity, never matching reason text', () => {
  const f = registry(), owner = createComposerBlockOwner(f.blocks);
  owner.acquire('s', 'cloud'); const foreign = { reason: 'cloud' };
  f.force('s', foreign); owner.dispose(); assert.equal(f.get(), foreign); assert.equal(f.subscriptions(), 0);
});

test('foreign replacement and synchronous clear during our set is reacquired without losing refs', () => {
  const f = registry(), foreign = { reason: 'worktrees' };
  let intervened = false;
  const stop = f.blocks.storeFor('s').subscribe(() => {
    if (!intervened && f.get()?.reason === 'cloud') { intervened = true; f.blocks.set('s', foreign); f.blocks.set('s', undefined); }
  });
  const owner = createComposerBlockOwner(f.blocks), release = owner.acquire('s', 'cloud');
  assert.equal(f.get()?.reason, 'cloud'); assert.equal(f.writes.filter(write => write.value?.reason === 'cloud').length, 2);
  release(); stop(); assert.equal(f.get(), undefined); assert.equal(f.subscriptions(), 0);
});

test('unload reentrancy during synchronous set does not leave a permanent block or subscription', () => {
  const f = registry(), owner = createComposerBlockOwner(f.blocks);
  const stop = f.blocks.storeFor('s').subscribe(() => { if (f.get()?.reason === 'cloud') owner.dispose(); });
  const release = owner.acquire('s', 'cloud');
  assert.equal(f.get(), undefined); assert.equal(f.subscriptions(), 1); release(); stop(); assert.equal(f.subscriptions(), 0);
  owner.acquire('s', 'late'); assert.equal(f.get(), undefined); assert.equal(f.subscriptions(), 0);
});

test('eager subscription callbacks are safe and session/service ownership stays isolated', () => {
  const f = registry(true), other = registry(true), a = createComposerBlockOwner(f.blocks), b = createComposerBlockOwner(other.blocks);
  a.acquire('s', 'cloud'); a.acquire('t', 'cloud'); b.acquire('s', 'cloud');
  assert.equal(f.subscriptions('s'), 1); assert.equal(f.subscriptions('t'), 1);
  a.dispose(); assert.equal(f.get('s'), undefined); assert.equal(f.get('t'), undefined); assert.ok(other.get('s'));
  assert.equal(f.subscriptions('s'), 0); assert.equal(f.subscriptions('t'), 0); b.dispose(); assert.equal(other.get('s'), undefined);
});

test('reason replacement while a foreign block is present does not overwrite it; clearing foreign reacquires the surviving reason', () => {
  const f = registry(), owner = createComposerBlockOwner(f.blocks), first = owner.acquire('s', 'first'), second = owner.acquire('s', 'second');
  const foreign = { reason: 'worktrees' }; f.blocks.set('s', foreign); first(); assert.equal(f.get(), foreign);
  f.blocks.set('s', undefined); assert.equal(f.get()?.reason, 'second');
  second(); assert.equal(f.get(), undefined); assert.equal(f.subscriptions(), 0); owner.dispose();
});

test('independently reloaded browser module shares HMR refcounts without a global lexical redeclaration', async () => {
  const f = registry(), before = createComposerBlockOwner(f.blocks), first = before.acquire('s', 'cloud');
  const marker = f.get(), url = new URL('../client-blocks.ts', import.meta.url); url.searchParams.set('reload', 'ownership-test');
  const reloaded = await import(url.href) as typeof import('../client-blocks.js');
  const after = reloaded.createComposerBlockOwner(f.blocks), last = after.acquire('s', 'cloud');
  first(); before.dispose(); assert.equal(f.get(), marker); assert.equal(f.subscriptions(), 1);
  last(); after.dispose(); assert.equal(f.get(), undefined); assert.equal(f.subscriptions(), 0);
});

test('late old releases cannot clear a recreated entry for the same session', () => {
  const f = registry(), a = createComposerBlockOwner(f.blocks), b = createComposerBlockOwner(f.blocks);
  const old = a.acquire('s', 'cloud'); a.dispose(); const current = b.acquire('s', 'cloud'), marker = f.get();
  old(); a.dispose(); assert.equal(f.get(), marker); assert.equal(f.subscriptions(), 1);
  current(); b.dispose(); assert.equal(f.get(), undefined); assert.equal(f.subscriptions(), 0);
});
