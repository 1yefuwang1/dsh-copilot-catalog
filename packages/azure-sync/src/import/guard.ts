/** Mandatory admission service: independent of Azure credentials, Sessions and optional Worktrees. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { SessionEvent, SessionHeader, SessionStore } from '@deepseek-ai/dsh-session';
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory';
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import { SessionAlreadyExistsError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { canonicalJson, payloadHash } from '../sync/canonical.js';
import { headerHash } from '../sync/chain.js';
import { isInside } from '../sync/effective-cwd.js';
import { canonicalAdmissionCwd, CwdAdmissionMutex, type CwdAdmissionLease } from './cwd-admission.js';
import { assertSidClaim, SidClaimStore, withSidClaim, type SidClaim } from './claims.js';
import { assertImportFence, ImportJournal, importArtifactSchema, importFence, type ImportArtifact, type ImportFence, type ImportReservation } from './journal.js';

export const CLOUD_IMPORT_READINESS = 'cloudImportReadinessV1';
export const IMPORT_GUARD_VERSION = 1;
export class DestinationAdmissionError extends Error {
  constructor(readonly code: 'RESERVED' | 'NOT_READABLE' | 'NOT_READY' | 'CANCELLED' | 'UNAVAILABLE' | 'PROOF_MISMATCH' | 'SEEDED_UNSUPPORTED', message: string) { super(message); this.name = 'DestinationAdmissionError'; }
}
/** Pure preview prerequisite for the currently proven unseeded public JSONL representation. */
export function assertInitialImportHeader(header: SessionHeader, inheritedEventCount: number): void {
  if (header.isSeeded || inheritedEventCount !== 0) throw new DestinationAdmissionError('SEEDED_UNSUPPORTED', 'Seeded initial materialization is unavailable until a crash-safe public backend path is proven.');
  if (header.delegationDepth === undefined) throw new DestinationAdmissionError('PROOF_MISMATCH', 'The localized import header must explicitly bind the native delegation depth before effects.');
}
export interface ImportSnapshot { readonly header: SessionHeader; readonly inheritedEventCount: number; readonly events: readonly SessionEvent[] }
export interface ImportPersistencePort {
  readonly identity: symbol;
  stat(sessionId: string): Promise<SessionPersistenceSnapshot | undefined>;
  list(): Promise<readonly SessionPersistenceSnapshot[]>;
  /** A fresh public backend instance, not a create handle's pending/cached state. */
  coldRead(sessionId: string): Promise<ImportSnapshot>;
}
declare const proofBrand: unique symbol;
export interface VerifiedDestinationImport {
  readonly [proofBrand]: true;
  readonly operationId: string;
  readonly sessionId: string;
  readonly intentId: string;
}
export interface CoordinatorOptions {
  readonly version: 1;
  /** Capability/receipt readiness only. Never resolves the imported Agent or borrows Host Git authority. */
  readonly ready: (record: ImportReservation) => boolean | Promise<boolean>;
  /** Native promotion/execution readiness; not used for coordinator data repair/catch-up. */
  readonly continuationReady?: (record: ImportReservation) => boolean | Promise<boolean>;
}
export interface CoordinatorRegistration {
  reserve(claim: SidClaim, record: ImportReservation, signal?: AbortSignal): Promise<ImportReservation>;
  /** Entire writer lifecycle belongs inside this callback. Scope revocation fences detached late continuations. */
  withWrite<T>(claim: SidClaim, fence: ImportFence, signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  /** Explicit retained-byte repair after Off/cancel; existing artifact only, never creation or execution consent. */
  withRetainedWrite<T>(claim: SidClaim, fence: ImportFence, signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  /** Fresh explicit repair confirmation only; coordinator has independently revalidated the exact existing destination. No Git scope. */
  withRetainedInitial<T>(claim: SidClaim, fence: ImportFence, signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  proveRetainedReadable(claim: SidClaim, fence: ImportFence, expected: ImportArtifact): Promise<VerifiedDestinationImport>;
  /** Caller has drained all effects; physical public-backend absence is checked before releasing a no-effect reservation. */
  releaseCancelledBeforeEffects(claim: SidClaim, fence: ImportFence): Promise<void>;
  proveReadable(claim: SidClaim, fence: ImportFence, expected: ImportArtifact): Promise<VerifiedDestinationImport>;
  /** Call only after explicit user Continue and fresh cloud/input admission; this grants no cloud ownership itself. */
  grantContinue(claim: SidClaim, fence: ImportFence, proof: VerifiedDestinationImport): Promise<ImportReservation>;
  unregister(): void;
}
interface RegistrationState { active: boolean; readonly options: CoordinatorOptions }
interface Scope { active: boolean; readonly retained: boolean; readonly initialRepair: boolean; readonly registration: RegistrationState; readonly claim: SidClaim; readonly fence: ImportFence; readonly signal: AbortSignal }
interface ProofState { readonly retained: boolean; readonly registration: RegistrationState; readonly artifact: ImportArtifact; readonly target: string; readonly fence: ImportFence; readonly sessionId: string }
export interface WriteAdmission { readonly record?: ImportReservation; readonly scope?: Scope; readonly nativeClaim?: SidClaim; readonly nativeCwdClaim?: CwdAdmissionLease }

export class ImportGuardV1 {
  readonly version = IMPORT_GUARD_VERSION;
  private readonly storage = new AsyncLocalStorage<Scope>();
  private readonly proofs = new WeakMap<object, ProofState>();
  /** Durable receipts are not runtime execution consent after this guard/Host restarts. */
  private readonly activatedContinueGrants = new Set<string>();
  private current?: RegistrationState;
  private persistence?: ImportPersistencePort;
  private closed = false;
  private constructor(readonly journal: ImportJournal, readonly claims: SidClaimStore, private readonly cwdAdmission: CwdAdmissionMutex) {}
  static async open(options: { root: string }): Promise<ImportGuardV1> {
    const journal = await ImportJournal.open({ root: join(options.root, 'journal') });
    await journal.list(); // Unsupported/partial journals refuse service publication before native admission.
    return new ImportGuardV1(journal, await SidClaimStore.open(join(options.root, 'claims')), await CwdAdmissionMutex.open(join(options.root, 'cwd-admission')));
  }
  attachPersistence(port: ImportPersistencePort): () => void {
    this.assertAvailable();
    if (this.persistence) throw new DestinationAdmissionError('UNAVAILABLE', 'An import persistence provider is already attached.');
    this.persistence = port;
    return () => { if (this.persistence === port) this.persistence = undefined; };
  }
  /** Public pre-effect admission for the optional placement service. No artifact
   * is required because provisioning necessarily precedes native creation. */
  async assertPlacement(expected: { operationId: string; sessionId: string; intentId: string; finalCwd: string }): Promise<void> {
    const record = await this.currentRecord(expected.sessionId);
    const registration = this.current;
    if (!record || !registration || record.operationId !== expected.operationId || record.intentId !== expected.intentId || record.finalCwd !== expected.finalCwd || record.cancelledAt !== undefined) throw new DestinationAdmissionError('CANCELLED', 'The exact import placement intent is unavailable or stopped.');
    await this.ready(registration, record);
    const latest = await this.currentRecord(expected.sessionId);
    if (!latest || latest.operationId !== record.operationId || latest.intentId !== record.intentId || latest.intentRevision !== record.intentRevision || latest.finalCwd !== expected.finalCwd || latest.cancelledAt !== undefined) throw new DestinationAdmissionError('CANCELLED', 'The import placement intent changed before effects.');
  }
  revokeContinueGrant(grantId: string): void { this.activatedContinueGrants.delete(grantId); }
  isGuardedPersistence(identity: symbol): boolean { return !this.closed && this.persistence?.identity === identity; }
  private assertAvailable() { if (this.closed) throw new DestinationAdmissionError('UNAVAILABLE', 'The mandatory import admission service is unavailable.'); }
  private async ready(registration: RegistrationState, record: ImportReservation) {
    this.assertAvailable();
    if (!registration.active || this.current !== registration || !this.persistence || !await registration.options.ready(record)) throw new DestinationAdmissionError('UNAVAILABLE', 'The compatible import coordinator or destination capability is unavailable.');
  }
  private async scoped(scope: Scope, record: ImportReservation) {
    this.assertAvailable(); scope.signal.throwIfAborted();
    if (!scope.active || record.operationId !== scope.fence.operationId || record.intentId !== scope.fence.intentId || record.intentRevision !== scope.fence.intentRevision || ((!scope.retained || (!record.artifact && !scope.initialRepair)) && (record.cancelledAt !== undefined || record.phase === 'cancelled'))) throw new DestinationAdmissionError('CANCELLED', 'The destination import write authority changed.');
    await assertSidClaim(scope.claim, record.target.sessionId, record.operationId);
    await this.ready(scope.registration, record);
    scope.signal.throwIfAborted();
  }
  private async currentRecord(sessionId: string) { this.assertAvailable(); return this.journal.read(sessionId); }
  async assertNativeCwd(sessionId: string, cwd: string): Promise<void> {
    this.assertAvailable();
    const candidate = await canonicalAdmissionCwd(cwd);
    for (const record of await this.journal.list()) {
      if (record.mode !== 'worktree' || record.phase === 'ready' && record.binding && record.placement?.bound) continue;
      const root = await canonicalAdmissionCwd(record.mapping.localRoot);
      if (!isInside(root, candidate)) continue;
      const scope = this.storage.getStore();
      if (record.target.sessionId === sessionId && scope?.claim.sessionId === sessionId) { await this.scoped(scope, record); continue; }
      throw new DestinationAdmissionError('RESERVED', 'This checkout belongs to an unfinished destination operation.');
    }
  }
  private async assertCheckoutVacant(record: ImportReservation): Promise<void> {
    if (!this.persistence) throw new DestinationAdmissionError('UNAVAILABLE', 'Native persistence admission is unavailable.');
    const root = await canonicalAdmissionCwd(record.mapping.localRoot);
    if (!isInside(root, await canonicalAdmissionCwd(record.finalCwd))) throw new DestinationAdmissionError('PROOF_MISMATCH', 'The final import cwd is outside its exact planned checkout root.');
    for (const other of await this.journal.list()) {
      if (other.mode !== 'worktree' || other.operationId === record.operationId) continue;
      const occupied = await canonicalAdmissionCwd(other.mapping.localRoot);
      if (isInside(root, occupied) || isInside(occupied, root)) throw new DestinationAdmissionError('RESERVED', 'Another managed destination owns this checkout geometry.');
    }
    for (const snapshot of await this.persistence.list()) {
      if (snapshot.header.id === record.target.sessionId || !snapshot.header.cwd) continue;
      if (isInside(root, await canonicalAdmissionCwd(snapshot.header.cwd))) throw new DestinationAdmissionError('RESERVED', 'Another native SID already accounts for this planned checkout.');
    }
  }
  async listVisible(sessionId: string): Promise<boolean> {
    const record = await this.currentRecord(sessionId);
    if (!record || record.phase === 'ready' && record.binding && record.artifact) return true;
    const scope = this.storage.getStore();
    if (scope?.claim.sessionId !== sessionId) return false;
    await this.scoped(scope, record); return true;
  }
  async nativeMaterialized(admission: WriteAdmission, header: SessionHeader, inheritedEventCount: number): Promise<boolean> {
    if (!admission.nativeCwdClaim || !this.persistence) return false;
    await admission.nativeCwdClaim.assertHeld();
    try {
      const snapshot = await this.persistence.coldRead(header.id);
      return snapshot.inheritedEventCount === inheritedEventCount && headerHash(snapshot.header, inheritedEventCount as never) === headerHash({ ...header, delegationDepth: header.delegationDepth ?? 0 }, inheritedEventCount as never);
    } catch { return false; }
  }
  async createAdmission(header: SessionHeader, fallbackCwd = process.cwd()): Promise<WriteAdmission> {
    const record = await this.currentRecord(header.id);
    const scope = this.storage.getStore();
    if (record) {
      if (!scope || scope.claim.sessionId !== header.id) throw new DestinationAdmissionError('RESERVED', 'This session ID belongs to the destination import coordinator.');
      await this.scoped(scope, record);
      if (scope.retained && !scope.initialRepair) throw new DestinationAdmissionError('CANCELLED', 'Retained repair cannot create an absent native artifact.');
      assertInitialImportHeader(header, record.target.inheritedEventCount);
      if (header.cwd !== record.finalCwd || headerHash(header, record.target.inheritedEventCount as never) !== record.localHeaderHash) throw new DestinationAdmissionError('PROOF_MISMATCH', 'The immutable localized import header differs from the reservation.');
      return { record, scope };
    }
    // A global create must participate in the same cross-process claim BEFORE
    // deferred JSONL create; retain this claim until materializing flush or close.
    const nativeCwdClaim = await this.cwdAdmission.acquire();
    let nativeClaim: SidClaim | undefined;
    try {
      await this.assertNativeCwd(header.id, header.cwd ?? fallbackCwd);
      nativeClaim = await this.claims.acquire(header.id, `native-${randomUUID()}`);
      if (await this.currentRecord(header.id)) throw new DestinationAdmissionError('RESERVED', 'The session ID was reserved before native creation.');
      return { nativeClaim, nativeCwdClaim };
    } catch (error) { await nativeClaim?.release(); await nativeCwdClaim.release(); throw error; }
  }
  async writeAdmission(sessionId: string): Promise<WriteAdmission> {
    const record = await this.currentRecord(sessionId);
    if (!record) return {};
    const scope = this.storage.getStore();
    if (scope?.claim.sessionId === sessionId) { await this.scoped(scope, record); return { record, scope }; }
    const registration = this.current;
    if (record.phase !== 'ready' || !record.artifact || !record.continueReceipt || record.continueReceipt.intentId !== record.intentId || record.continueReceipt.intentRevision !== record.intentRevision || !this.activatedContinueGrants.has(record.continueReceipt.grantId)) throw new DestinationAdmissionError('NOT_READY', 'Import/Open does not authorize a native write-resume; explicit Continue is required.');
    if (!registration) throw new DestinationAdmissionError('UNAVAILABLE', 'The compatible import coordinator is unavailable.');
    await this.ready(registration, record);
    if (registration.options.continuationReady && !await registration.options.continuationReady(record)) throw new DestinationAdmissionError('NOT_READY', 'The current history/destination is not ready for native continuation.');
    return { record };
  }
  /** Scoped persistence effects and journal cancellation share one lane under the real process claim. */
  withWriteMutation<T>(admission: WriteAdmission, work: () => Promise<T>): Promise<T> {
    return admission.scope ? withSidClaim(admission.scope.claim, work) : work();
  }
  async recheckWrite(sessionId: string, admission: WriteAdmission): Promise<void> {
    const latest = await this.currentRecord(sessionId);
    if (admission.nativeClaim) {
      await admission.nativeClaim.assertOwned();
      await admission.nativeCwdClaim?.assertHeld();
      if (latest) throw new DestinationAdmissionError('RESERVED', 'Native creation was superseded by a destination reservation.');
    } else if (admission.scope) {
      if (!latest) throw new DestinationAdmissionError('CANCELLED', 'The destination reservation disappeared.');
      await this.scoped(admission.scope, latest);
    } else {
      const current = await this.writeAdmission(sessionId);
      if (admission.record && (!current.record || current.record.operationId !== admission.record.operationId || current.record.intentId !== admission.record.intentId || current.record.intentRevision !== admission.record.intentRevision || current.record.continueReceipt?.grantId !== admission.record.continueReceipt?.grantId)) throw new DestinationAdmissionError('CANCELLED', 'Native continuation authority changed.');
    }
  }
  async readAdmission(sessionId: string): Promise<ImportReservation | undefined> {
    const record = await this.currentRecord(sessionId);
    const scope = this.storage.getStore();
    if (record && scope?.claim.sessionId === sessionId) { await this.scoped(scope, record); return record; }
    if (record && !record.artifact) throw new DestinationAdmissionError('NOT_READABLE', 'The destination import has no proven readable initial artifact.');
    return record;
  }
  validateSnapshot(record: ImportReservation, snapshot: ImportSnapshot, artifact = record.artifact): void {
    if (!artifact || snapshot.header.id !== record.target.sessionId || snapshot.header.cwd !== record.finalCwd || snapshot.inheritedEventCount !== record.target.inheritedEventCount || headerHash(snapshot.header, snapshot.inheritedEventCount as never) !== record.localHeaderHash || artifact.headerHash !== record.localHeaderHash || artifact.inheritedEventCount !== snapshot.inheritedEventCount || snapshot.events.length < artifact.prefixCount || payloadHash(snapshot.events.slice(0, artifact.prefixCount)) !== artifact.prefixHash) throw new DestinationAdmissionError('PROOF_MISMATCH', 'The public persistence artifact differs from its destination commitment.');
    if (snapshot.header.isSeeded && (artifact.prefixCount <= snapshot.inheritedEventCount || snapshot.events[snapshot.inheritedEventCount]?.type !== 'session/end-seed')) throw new DestinationAdmissionError('PROOF_MISMATCH', 'The seeded initial artifact is missing its exact inherited marker.');
  }
  registerCoordinator(options: CoordinatorOptions): CoordinatorRegistration {
    this.assertAvailable();
    if (options.version !== 1 || typeof options.ready !== 'function' || this.current?.active) throw new DestinationAdmissionError('UNAVAILABLE', 'Exactly one compatible import coordinator is required.');
    const state: RegistrationState = { active: true, options };
    this.current = state;
    const check = async (claim: SidClaim, fence: ImportFence, retained = false, initialRepair = false) => {
      const record = await this.currentRecord(claim.sessionId);
      if (!record) throw new DestinationAdmissionError('RESERVED', 'The destination reservation is missing.');
      assertImportFence(record, fence); await assertSidClaim(claim, claim.sessionId, fence.operationId); await this.ready(state, record);
      if (record.cancelledAt !== undefined && (!retained || (!record.artifact && !initialRepair))) throw new DestinationAdmissionError('CANCELLED', 'The import was cancelled.');
      return record;
    };
    const withScope = async <T>(claim: SidClaim, fence: ImportFence, signal: AbortSignal, work: () => Promise<T>, retained: boolean, initialRepair = false): Promise<T> => {
      const record = await check(claim, fence, retained, initialRepair); signal.throwIfAborted();
      if (retained && !record.artifact && !initialRepair) throw new DestinationAdmissionError('NOT_READABLE', 'Retained repair requires the original readable artifact.');
      if (initialRepair && (record.cancelledAt === undefined || record.mode === 'worktree' && !record.placement)) throw new DestinationAdmissionError('RESERVED', 'Explicit retained initial repair requires the current cancellation and exact prepared placement receipt.');
      const scope: Scope = { active: true, retained, initialRepair, registration: state, claim, fence, signal };
      try {
        const result = await this.storage.run(scope, work);
        const latest = await this.currentRecord(claim.sessionId);
        if (!latest) throw new DestinationAdmissionError('CANCELLED', 'The destination reservation disappeared.');
        await this.scoped(scope, latest); return result;
      } finally { scope.active = false; }
    };
    const issueProof = async (claim: SidClaim, fence: ImportFence, expected: ImportArtifact, retained: boolean) => {
      const record = await check(claim, fence, retained, retained);
      const artifact = importArtifactSchema.parse(expected);
      if (artifact.prefixCount > record.target.eventCount) throw new DestinationAdmissionError('PROOF_MISMATCH', 'The initial prefix exceeds the reviewed cloud target.');
      this.validateSnapshot(record, await this.persistence!.coldRead(claim.sessionId), artifact);
      await check(claim, fence, retained, retained);
      const proof = Object.freeze({ operationId: record.operationId, sessionId: record.target.sessionId, intentId: record.intentId }) as VerifiedDestinationImport;
      this.proofs.set(proof, { retained, registration: state, artifact, target: canonicalJson(record.target), fence, sessionId: record.target.sessionId });
      return proof;
    };
    const registration: CoordinatorRegistration = Object.freeze({
      reserve: async (claim: SidClaim, record: ImportReservation, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        await assertSidClaim(claim, record.target.sessionId, record.operationId); await this.ready(state, record); signal?.throwIfAborted();
        const cwdClaim = record.mode === 'worktree' ? await this.cwdAdmission.acquire(signal) : undefined;
        try {
          const current = await this.journal.read(record.target.sessionId);
          if (!current && await this.persistence!.stat(record.target.sessionId)) throw new SessionAlreadyExistsError(record.target.sessionId as never);
          if (!current && record.mode === 'worktree') { await cwdClaim!.assertHeld(); await this.assertCheckoutVacant(record); }
          signal?.throwIfAborted();
          return await this.journal.reserve(claim, record);
        } finally { await cwdClaim?.release(); }
      },
      withWrite: <T>(claim: SidClaim, fence: ImportFence, signal: AbortSignal, work: () => Promise<T>) => withScope(claim, fence, signal, work, false),
      withRetainedWrite: <T>(claim: SidClaim, fence: ImportFence, signal: AbortSignal, work: () => Promise<T>) => withScope(claim, fence, signal, work, true),
      withRetainedInitial: <T>(claim: SidClaim, fence: ImportFence, signal: AbortSignal, work: () => Promise<T>) => withScope(claim, fence, signal, work, true, true),
      proveRetainedReadable: (claim: SidClaim, fence: ImportFence, expected: ImportArtifact) => issueProof(claim, fence, expected, true),
      releaseCancelledBeforeEffects: async (claim: SidClaim, fence: ImportFence) => {
        this.assertAvailable();
        if (!state.active || this.current !== state || !this.persistence) throw new DestinationAdmissionError('UNAVAILABLE', 'The independent persistence guard is unavailable.');
        await assertSidClaim(claim, claim.sessionId, fence.operationId);
        const record = await this.currentRecord(claim.sessionId);
        if (!record) return;
        assertImportFence(record, fence);
        if (record.phase !== 'cancelled' || record.artifact || record.placement || record.binding || record.effects.length || await this.persistence.stat(claim.sessionId)) throw new DestinationAdmissionError('RESERVED', 'Committed or uncertain import effects must be retained.');
        try { await this.persistence.coldRead(claim.sessionId); throw new DestinationAdmissionError('RESERVED', 'The native import artifact must be retained.'); }
        catch (error) { if (!(error instanceof SessionPersistenceNotFoundError)) throw error; }
        await this.journal.removeCancelledBeforeEffects(claim, fence);
      },
      proveReadable: (claim: SidClaim, fence: ImportFence, expected: ImportArtifact) => issueProof(claim, fence, expected, false),
      grantContinue: async (claim: SidClaim, fence: ImportFence, proof: VerifiedDestinationImport) => {
        const latest = await this.currentRecord(claim.sessionId);
        if (latest && state.options.continuationReady && !await state.options.continuationReady(latest)) throw new DestinationAdmissionError('NOT_READY', 'The current history/destination is not ready for native continuation.');
        if (latest?.continueReceipt && this.activatedContinueGrants.has(latest.continueReceipt.grantId) && latest.operationId === fence.operationId && latest.intentId === fence.intentId && latest.intentRevision === fence.intentRevision) {
          await assertSidClaim(claim, claim.sessionId, fence.operationId); await this.ready(state, latest);
          if (!await this.verifyProof(proof, { operationId: latest.operationId, sessionId: claim.sessionId, intentId: latest.intentId }, true)) throw new DestinationAdmissionError('NOT_READY', 'Continue requires a current complete persistence proof.');
          return latest; // Same activated request is idempotent, including its earlier journal revision.
        }
        const record = await check(claim, fence);
        if (record.phase !== 'ready' || !await this.verifyProof(proof, { operationId: record.operationId, sessionId: record.target.sessionId, intentId: record.intentId }, true)) throw new DestinationAdmissionError('NOT_READY', 'Continue requires a current complete persistence proof and destination readiness.');
        if (record.continueReceipt && this.activatedContinueGrants.has(record.continueReceipt.grantId)) return record;
        const continued = await this.journal.update(claim, fence, latest => ({ ...latest, revision: latest.revision + 1, updatedAt: Date.now(), continueReceipt: { grantId: randomUUID(), intentId: latest.intentId, intentRevision: latest.intentRevision, grantedAt: Date.now() } }));
        this.activatedContinueGrants.add(continued.continueReceipt!.grantId);
        return continued;
      },
      unregister: () => { state.active = false; if (this.current === state) this.current = undefined; },
    });
    return registration;
  }
  async verifyProof(proof: unknown, expected: { operationId: string; sessionId: string; intentId: string }, complete = true): Promise<boolean> {
    if (!proof || typeof proof !== 'object') return false;
    const issued = this.proofs.get(proof);
    if (!issued || issued.sessionId !== expected.sessionId || issued.fence.operationId !== expected.operationId || issued.fence.intentId !== expected.intentId) return false;
    try {
      const current = await this.currentRecord(expected.sessionId);
      if (!current || (current.cancelledAt !== undefined && !issued.retained) || current.operationId !== issued.fence.operationId || current.intentId !== issued.fence.intentId || current.intentRevision !== issued.fence.intentRevision || canonicalJson(current.target) !== issued.target || complete && issued.artifact.prefixCount !== current.target.eventCount) return false;
      await this.ready(issued.registration, current);
      this.validateSnapshot(current, await this.persistence!.coldRead(expected.sessionId), issued.artifact);
      return true;
    } catch { return false; }
  }
  close() { this.closed = true; if (this.current) this.current.active = false; this.current = undefined; this.persistence = undefined; this.activatedContinueGrants.clear(); }
}

declare module '@deepseek-ai/cordis' { interface Context { readonly cloudImportReadinessV1: ImportGuardV1 } }
export const name = 'cloud-import-readiness';
export const Config = Schema.object({ root: Schema.string().required() });
/** Compatibility rejection for a cached post-Continue Agent. This is not an input-hold factory. */
export function installDestinationAdmission(ctx: Context, guard: ImportGuardV1): () => void {
  return ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const workingDirectory = ctx.get('workingDirectory') as WorkingDirectoryService | undefined;
      const cwd = workingDirectory?.get(payload.agent.session) ?? payload.agent.session.header.cwd ?? process.cwd();
      await guard.assertNativeCwd(payload.agent.session.id, cwd);
      if (payload.agent.session.header.cwd && payload.agent.session.header.cwd !== cwd) await guard.assertNativeCwd(payload.agent.session.id, payload.agent.session.header.cwd);
      const record = await guard.journal.read(payload.agent.session.id);
      if (!record) return next();
      await guard.writeAdmission(payload.agent.session.id);
      return next();
    } catch {
      // Native has already claimed these messages. Preserve them before rejecting,
      // including when an older Azure lifecycle would otherwise skip admission.
      const queued = new Set([...payload.agent.inbox.nextStep, ...payload.agent.inbox.nextTurn].map(message => message.id));
      for (const message of [...payload.messages].reverse()) {
        if (queued.has(message.id)) continue;
        try { payload.agent.inbox.prepend('next-turn', message); }
        catch { payload.agent.inbox.append('next-turn', message); }
        queued.add(message.id);
      }
      const sessions = ctx.get('sessions') as SessionStore | undefined;
      if (!sessions) throw new DestinationAdmissionError('UNAVAILABLE', 'Native session durability is unavailable during import admission.');
      await sessions.flush(payload.agent.session);
      return { kind: 'reject' };
    }
  });
}
export async function apply(ctx: Context, config: { root: string }): Promise<void> {
  const guard = await ImportGuardV1.open(config);
  // Installed before the dependent Session/Agent profile entries may activate.
  installDestinationAdmission(ctx, guard);
  ctx.provide(CLOUD_IMPORT_READINESS, guard);
  ctx.effect(() => () => guard.close(), 'cloud import readiness');
}
export { importFence };
