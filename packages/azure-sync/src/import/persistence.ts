/** Public composite provider. Profile must disable the old global JSONL row and gate session + agent-loop. */
import { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';

/** Backend-neutral public configuration; do not leak concrete JSONL declarations. */
export interface ImportPersistenceConfig { root: string; compression?: 'zstd' | 'none'; listConcurrency?: number }
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session';
import { SessionHandleClosedError, SessionPersistence, type SessionAccess, type SessionHandle, type SessionPersistenceCreateOptions, type SessionPersistenceListOptions, type SessionPersistenceOpenOptions, type SessionPersistenceStatOptions } from '@deepseek-ai/dsh-session-persistence';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory';
import { payloadHash } from '../sync/canonical.js';
import { CLOUD_IMPORT_READINESS, DestinationAdmissionError, ImportGuardV1, type ImportSnapshot, type WriteAdmission } from './guard.js';
import type { ImportReservation } from './journal.js';

/** A separate backend/tracker proves physical readability instead of trusting a deferred create handle. */
export async function coldReadJsonl(config: ImportPersistenceConfig, sessionId: string): Promise<ImportSnapshot> {
  const ctx = new Context();
  try {
    await Jsonl.apply(ctx, config);
    const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read');
    try { return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: (await handle.read(0)).events }; }
    finally { await handle.close(); }
  } finally { await ctx.fiber.dispose(); }
}

export class GuardedSessionPersistence extends SessionPersistence {
  private readonly writers = new Set<SessionHandle>();
  private readonly nativePublication = new Map<string, () => Promise<void>>();
  constructor(ctx: Context, private readonly base: SessionPersistence, private readonly guard: ImportGuardV1,
    private readonly coldRead: (sessionId: string) => Promise<ImportSnapshot>) {
    super(ctx);
    // Awaited public publication boundary: an ordinary blank Native Agent needs
    // no first message to release cwd admission. Never flush an unpublished
    // create (rollback must stay residue-free), and never header-flush a seed.
    ctx.on('agent/created', async ({ agent }) => { await this.nativePublication.get(agent.session.id)?.(); });
  }
  private validate(record: ImportReservation, snapshot: ImportSnapshot) {
    this.guard.validateSnapshot(record, snapshot, record.artifact ?? { headerHash: record.localHeaderHash, inheritedEventCount: record.target.inheritedEventCount, prefixCount: 0, prefixHash: payloadHash([]) });
  }
  private wrap(raw: SessionHandle, initial: WriteAdmission = {}): SessionHandle {
    let admission = initial;
    let closing: Promise<void> | undefined;
    const recheck = () => this.guard.recheckWrite(raw.id, admission);
    const releaseNative = async () => {
      if (!admission.nativeClaim && !admission.nativeCwdClaim) return;
      const held = admission; admission = {};
      this.nativePublication.delete(raw.id);
      try { await held.nativeClaim?.release(); } finally { await held.nativeCwdClaim?.release(); }
      // The cold-readable artifact now protects collision checks; JSONL retains its writer lock.
    };
    const handle: SessionHandle = {
      id: raw.id, header: raw.header, access: raw.access, inheritedEventCount: raw.inheritedEventCount,
      read: async (offset, length, options) => {
        const record = await this.guard.readAdmission(raw.id);
        if (record) this.validate(record, { header: raw.header, inheritedEventCount: raw.inheritedEventCount, events: (await raw.read(0, undefined, options)).events });
        return raw.read(offset, length, options);
      },
      append: (events, options) => this.guard.withWriteMutation(admission, async () => {
        await recheck();
        for (const event of events as readonly { type: string; data?: { cwd?: unknown } }[]) if (event.type === 'working-directory/change' && typeof event.data?.cwd === 'string') await this.guard.assertNativeCwd(raw.id, event.data.cwd);
        await raw.append(events, options); await recheck();
        if (await this.guard.nativeMaterialized(admission, raw.header, raw.inheritedEventCount)) await releaseNative();
      }),
      flush: options => this.guard.withWriteMutation(admission, async () => {
        await recheck(); await raw.flush(options); await recheck();
        if (await this.guard.nativeMaterialized(admission, raw.header, raw.inheritedEventCount)) await releaseNative();
      }),
      close: () => closing ??= (async () => {
        try { await raw.close(); await releaseNative(); }
        finally { this.writers.delete(handle); }
      })(),
      [Symbol.asyncDispose]: async () => { await handle.close(); },
    };
    if (admission.nativeCwdClaim) this.nativePublication.set(raw.id, async () => {
      if (raw.header.isSeeded && !await this.guard.nativeMaterialized(admission, raw.header, raw.inheritedEventCount)) throw new DestinationAdmissionError('NOT_READABLE', 'A published seeded Native session must already contain its exact readable seed prefix.');
      await handle.flush();
    });
    if (raw.access === 'write') this.writers.add(handle);
    return handle;
  }
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const workingDirectory = this.ctx.get('workingDirectory') as WorkingDirectoryService | undefined;
    const admission = await this.guard.createAdmission(header, workingDirectory?.defaultDirectory ?? process.cwd());
    let raw: SessionHandle | undefined;
    try {
      if (admission.record && (options?.inheritedEventCount ?? 0) !== admission.record.target.inheritedEventCount) throw new DestinationAdmissionError('PROOF_MISMATCH', 'The inherited cut differs from the import reservation.');
      return await this.guard.withWriteMutation(admission, async () => {
        await this.guard.recheckWrite(header.id, admission); options?.signal?.throwIfAborted();
        const created = await this.base.create(header, options); raw = created;
        await this.guard.recheckWrite(header.id, admission);
        return this.wrap(created, admission);
      });
    } catch (error) {
      if (raw) await raw.close();
      try { await admission.nativeClaim?.release(); } finally { await admission.nativeCwdClaim?.release(); }
      throw error;
    }
  }
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const admission = access === 'write' ? await this.guard.writeAdmission(id) : {};
    return this.guard.withWriteMutation(admission, async () => {
      const record = await this.guard.readAdmission(id);
      if (access === 'write') await this.guard.recheckWrite(id, admission);
      const raw = await this.base.open(id, access, options);
      try {
        if (access === 'write' && !record) {
          const workingDirectory = this.ctx.get('workingDirectory') as WorkingDirectoryService | undefined;
          await this.guard.assertNativeCwd(id, raw.header.cwd ?? workingDirectory?.defaultDirectory ?? process.cwd());
        }
        if (record) this.validate(record, { header: raw.header, inheritedEventCount: raw.inheritedEventCount, events: (await raw.read(0, undefined, options)).events });
        if (access === 'write') await this.guard.recheckWrite(id, admission);
        return this.wrap(raw, admission);
      } catch (error) { await raw.close(); throw error; }
    });
  }
  async flush(): Promise<void> {
    const errors: unknown[] = [];
    for (const handle of [...this.writers]) {
      try { await handle.flush(); }
      catch (error) { if (!(error instanceof SessionHandleClosedError)) errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Guarded session persistence flush was refused or failed.');
  }
  async stat(id: SessionId, options?: SessionPersistenceStatOptions) {
    let record: ImportReservation | undefined;
    try { record = await this.guard.readAdmission(id); }
    catch (error) { if (error instanceof DestinationAdmissionError && error.code === 'NOT_READABLE') return undefined; throw error; }
    if (record) this.validate(record, await this.coldRead(id));
    return this.base.stat(id, options);
  }
  async list(options?: SessionPersistenceListOptions) {
    const snapshots = await this.base.list(options);
    const visible = [];
    for (const snapshot of snapshots) if (await this.guard.listVisible(snapshot.header.id) && await this.stat(snapshot.header.id, options)) visible.push(snapshot);
    return visible;
  }
}

export const name = 'cloud-import-session-persistence';
export const inject = [CLOUD_IMPORT_READINESS];
/** Same public JSONL configuration; select the existing root's encoding, never silently change it. */
export const Config: Schema<ImportPersistenceConfig> = Jsonl.Config;
export async function apply(ctx: Context, config: ImportPersistenceConfig): Promise<void> {
  const guard = ctx.cloudImportReadinessV1;
  if (guard.version !== 1) throw new DestinationAdmissionError('UNAVAILABLE', 'A compatible independent destination readiness guard is required.');
  await ctx.effect(async function* () {
    // A distinct PUBLIC Context has its own reflection store. Loader entry
    // context refreshes cannot accidentally publish its raw backend globally.
    // It hosts only JSONL: no Agent/Session factory, server, or Git authority.
    const backend = new Context();
    yield () => backend.fiber.dispose();
    const baseScope = backend.plugin(Jsonl, config); await baseScope.await();
    const base = backend.sessionPersistence;
    // Bridge documented persistence lifecycle events, retaining the SDK's own
    // JSONL router/batching/close semantics rather than reaching into a tracker.
    yield ctx.effect(function* () {
      yield ctx.on('session/event', (session, event) => { backend.emit('session/event', session, event); });
      yield ctx.on('session/flush', async session => { await backend.parallel('session/flush', session); });
      yield ctx.on('session/disposed', session => { backend.emit('session/disposed', session); });
    }, 'cloud import public persistence lifecycle bridge');
    const coldRead = (sessionId: string) => coldReadJsonl(config, sessionId);
    let publicIdentity = base.identity;
    yield guard.attachPersistence({ get identity() { return publicIdentity; }, stat: sessionId => base.stat(SessionId(sessionId)), list: () => base.list(), coldRead });
    const provider = ctx.plugin({ name: 'cloud-import-session-persistence-service', apply(serviceCtx) {
      publicIdentity = new GuardedSessionPersistence(serviceCtx, base, guard, coldRead).identity;
    } });
    yield provider.dispose;
    await provider.await();
  }, 'cloud import persistence resources');
}
