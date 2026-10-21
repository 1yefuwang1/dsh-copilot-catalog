/** Fixture-only public-API prototypes; neither plugin is a shipped package/contract. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import type { Context } from '@deepseek-ai/cordis';
import { Context as FixtureContext } from '@deepseek-ai/cordis';
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session';
import { SessionPersistence, type SessionAccess, type SessionPersistenceCreateOptions, type SessionPersistenceOpenOptions, type SessionPersistenceStatOptions, type SessionPersistenceListOptions } from '@deepseek-ai/dsh-session-persistence';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Storage } from '@deepseek-ai/dsh-storage';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { LocalStore } from '../src/local/store.js';
import { localSession } from './helpers.js';
import { ImportClaimError, SidClaimStore } from '../src/import/claims.js';

export const GUARD = 'fixtureDestinationAdmissionV1';
export const COORDINATOR = 'fixtureDestinationCoordinatorV1';
export interface Reservation {
  readonly sessionId: string;
  readonly operationId: string;
  readonly finalCwd: string;
  readonly phase: 'reserved' | 'readable' | 'ready';
  /** Fixture stand-in for a server-minted, intent-bound Continue receipt, never a browser DTO. */
  readonly continued?: boolean;
}
export interface Journal { readonly version: 1; readonly reservations: readonly Reservation[] }

/** Deliberately direct durable reads, not a stale storage-domain process cache. */
export async function readJournal(path: string): Promise<Journal> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const journal = value as Journal;
  assert.equal(journal.version, 1, 'unsupported mandatory compatibility journal');
  assert.ok(Array.isArray(journal.reservations));
  for (const item of journal.reservations) {
    assert.equal(typeof item.sessionId, 'string');
    assert.equal(typeof item.operationId, 'string');
    assert.equal(typeof item.finalCwd, 'string');
    assert.ok(['reserved', 'readable', 'ready'].includes(item.phase));
  }
  return journal;
}

interface GuardPort {
  readonly version: 1;
  reservation(id: string): Promise<Reservation | undefined>;
  assertWritable(id: string): Promise<void>;
}

export const GuardPlugin = {
  name: 'fixture-independent-destination-guard',
  async apply(ctx: Context, config: { journal: string; portVersion?: number }) {
    await readJournal(config.journal); // No service is published on missing/unsupported/malformed state.
    const guard: GuardPort = {
      version: (config.portVersion ?? 1) as 1,
      async reservation(id) { return (await readJournal(config.journal)).reservations.find(item => item.sessionId === id); },
      async assertWritable(id) {
        const reservation = await guard.reservation(id);
        if (reservation && (reservation.phase !== 'ready' || reservation.continued !== true)) throw new Error('DESTINATION_RESERVED');
      },
    };
    ctx.provide(GUARD, guard);
  },
};

/** Public supported provider subclass + isolated public JSONL plugin, never a backend cast/patch. */
class CompositePersistence extends SessionPersistence {
  constructor(ctx: Context, private readonly base: SessionPersistence, private readonly guard: GuardPort) { super(ctx); }
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions) {
    await this.guard.assertWritable(header.id);
    const reservation = await this.guard.reservation(header.id);
    if (reservation) throw new Error('DESTINATION_COORDINATOR_ONLY'); // Never legacy-create a reserved SID, including Ready.
    return this.base.create(header, options);
  }
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions) {
    if (access === 'write') await this.guard.assertWritable(id);
    const reservation = await this.guard.reservation(id);
    if (reservation?.phase === 'reserved') throw new Error('DESTINATION_NOT_READABLE');
    const handle = await this.base.open(id, access, options);
    if (reservation && handle.header.cwd !== reservation.finalCwd) {
      await handle.close();
      throw new Error('DESTINATION_HEADER_MISMATCH');
    }
    return handle;
  }
  flush() { return this.base.flush(); }
  stat(id: SessionId, options?: SessionPersistenceStatOptions) { return this.base.stat(id, options); }
  list(options?: SessionPersistenceListOptions) { return this.base.list(options); }
}

export interface FixtureCoordinator {
  /** Only unseeded materialization to demonstrate the composition route, not the separate seeded/crash proof. */
  materialize(header: SessionHeader): Promise<void>;
}
export const CompositePlugin = {
  name: 'fixture-composite-session-persistence',
  inject: [GUARD],
  async apply(ctx: Context, config: { root: string }) {
    const guard = ctx.get(GUARD) as GuardPort;
    assert.equal(guard.version, 1, 'compatible independent destination guard required');
    // Separate fiber disposers otherwise unwind concurrently. A generator resource group
    // retains isolated JSONL until the outer provider and its injecting consumers unload.
    await ctx.effect(async function* () {
      const isolated = ctx.isolate('sessionPersistence');
      const baseScope = isolated.plugin(Jsonl, { root: config.root, compression: 'none' });
      yield baseScope.dispose;
      await baseScope.await();
      assert.equal(baseScope.state, 2);
      const base = isolated.get('sessionPersistence') as SessionPersistence;
      const service = ctx.plugin({ name: 'fixture-composite-provider-service', apply(serviceCtx) {
        new CompositePersistence(serviceCtx, base, guard);
        const coordinator: FixtureCoordinator = {
          async materialize(header) {
            const reservation = await guard.reservation(header.id);
            assert.ok(reservation, 'exact reserved target required');
            assert.equal(header.cwd, reservation.finalCwd);
            assert.equal(header.isSeeded, false, 'this compatibility proof does not establish seeded materialization');
            const handle = await base.create(header);
            try { await handle.flush(); } finally { await handle.close(); }
            const cold = await base.open(header.id, 'read');
            try {
              assert.equal(cold.header.cwd, reservation.finalCwd);
              assert.equal(cold.inheritedEventCount, 0);
              assert.deepEqual((await cold.read(0)).events, []);
            } finally { await cold.close(); }
          },
        };
        serviceCtx.provide(COORDINATOR, coordinator);
      } });
      yield service.dispose;
      await service.await();
    }, 'fixture composite provider resources');
  },
};

export async function openLocal(root: string) {
  const ctx = new FixtureContext();
  new Storage(ctx);
  const backend = new JsonStorageBackend(root);
  ctx.storage.backend.register('fixture-json', backend);
  const facility = new DomainFacility(ctx, { backend: 'fixture-json' });
  const local = new LocalStore(facility);
  await local.open();
  return { local, async close() { await local.close(); await facility.closeAll(); await backend.close(); } };
}

/**
 * Conservative POSIX local-filesystem pre-effect SID claim prototype.
 * Exclusive mkdir is the claim linearization; file+directory fsync completes before effects.
 * No TTL, PID-only takeover, automatic stale cleanup, or unsafe release exists here.
 * An empty/partial claim, dead owner, foreign host, or uncertain process state stays reserved
 * until an explicit design-specific recovery reconciles effects. This intentionally trades
 * availability for safety. It is NOT a shipped multi-platform lock implementation.
 */
export async function exclusiveClaim(root: string, sessionId: string, operationId: string) {
  assert.notEqual(process.platform, 'win32', 'directory-fsync durability needs a verified Windows primitive');
  assert.equal(await realpath(root), resolve(root));
  assert.ok(Buffer.byteLength(sessionId) > 0 && Buffer.byteLength(sessionId) <= 512);
  assert.ok(Buffer.byteLength(operationId) > 0 && Buffer.byteLength(operationId) <= 256);
  const dir = join(root, `${createHash('sha256').update(sessionId).digest('hex')}.claim`);
  try { await mkdir(dir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let state = 'uncertain';
    try {
      assert.ok((await lstat(dir)).isDirectory());
      const ownerPath = join(dir, 'owner.json');
      const info = await lstat(ownerPath);
      assert.ok(info.isFile() && info.size <= 4096);
      const handle = await open(ownerPath, 'r');
      let text: string;
      try {
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        assert.ok(bytesRead <= 4096);
        text = buffer.toString('utf8', 0, bytesRead);
      } finally { await handle.close(); }
      const owner = JSON.parse(text) as { host: string; pid: number };
      if (owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); state = 'live-or-pid-reused'; }
        catch (cause) { state = (cause as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead-owner-recovery-required' : 'uncertain'; }
      }
    } catch { /* empty claim, bad metadata and symlinks never become permission */ }
    return { acquired: false as const, state };
  }
  const owner = await open(join(dir, 'owner.json'), 'wx', 0o600);
  try {
    await owner.writeFile(JSON.stringify({ version: 1, sessionId, operationId, host: hostname(), pid: process.pid, token: randomUUID() }));
    await owner.sync();
  } finally { await owner.close(); }
  for (const path of [dir, root]) {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  return { acquired: true as const, state: 'owned' };
}

async function childMain(mode: string, root: string, sessionId: string, operationId: string) {
  if (mode === 'claim') {
    const result = await exclusiveClaim(root, sessionId, operationId);
    if (result.acquired) await appendFile(join(root, 'effects'), `${operationId}\n`);
    process.send?.(result);
  } else if (mode === 'production-claim') {
    try {
      const claims = await SidClaimStore.open(root);
      await claims.acquire(sessionId, operationId);
      await appendFile(join(root, 'effects'), `${operationId}\n`);
      process.send?.({ acquired: true }); // Intentionally crash/exit without release.
    } catch (error) {
      if (!(error instanceof ImportClaimError)) throw error;
      process.send?.({ acquired: false, code: error.code });
    }
  } else if (mode === 'domain') {
    const fixture = await openLocal(root);
    try {
      assert.equal(fixture.local.getSession(sessionId), undefined);
      process.send?.({ phase: 'ready' });
      await once(process, 'message');
      let accepted = false;
      await fixture.local.transactSession(sessionId, current => {
        if (current !== undefined) return undefined;
        accepted = true;
        return localSession({ sessionId });
      });
      if (accepted) await appendFile(join(root, 'effects'), `${operationId}\n`);
      process.send?.({ acquired: accepted });
    } finally { await fixture.close(); }
  } else throw new Error(`unknown fixture mode ${mode}`);
  process.disconnect?.();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, sid, operation] = process.argv.slice(2);
  assert.ok(mode && root && sid && operation);
  await childMain(mode, root, sid, operation);
}
