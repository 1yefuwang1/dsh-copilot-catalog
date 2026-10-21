/** Separate destination-operation journal. Never a legacy LocalSessionRecord. */
import { randomUUID } from 'node:crypto';
import { link, lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../sync/canonical.js';
import { assertSidClaim, ensureImportDirectory, readBoundedFile, sidKey, syncDirectory, withSidClaim, type SidClaim } from './claims.js';

const id = z.string().min(1).max(512);
const path = z.string().min(1).max(4096);
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const natural = z.number().int().nonnegative().safe();
export const importIdentitySchema = z.strictObject({ scope: id, sessionId: id, generation: z.number().int().positive().safe(), headerHash: hash, inheritedEventCount: natural, eventCount: natural, chainHash: hash });
export const importArtifactSchema = z.strictObject({ headerHash: hash, inheritedEventCount: natural, prefixCount: natural, prefixHash: hash });
export const importPlacementSchema = z.strictObject({ version: z.literal(1), operationId: id, requestHash: hash, target: importIdentitySchema,
  intentId: id, actorId: id, worktreeId: id, projectId: id, folderId: id, workspaceId: id.optional(), repoRoot: path, commonDir: path,
  checkoutRoot: path, projectSubdir: z.string().max(4096), effectiveCwd: path, baseOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  baseRef: id, branch: id, revision: z.number().int().positive().safe(), bound: z.literal(true).optional() }).superRefine((receipt, ctx) => {
  if (receipt.bound && !receipt.workspaceId) ctx.addIssue({ code: 'custom', message: 'A bound placement requires its actual native workspace identity.' });
});
export const importPhaseSchema = z.enum(['reserved', 'destination-preparing', 'destination-prepared', 'materializing', 'initial-readable', 'history-importing', 'history-verified', 'destination-bound', 'ready', 'cancelled', 'recovery-required']);
export const importReservationSchema = z.strictObject({
  version: z.literal(1), operationId: id, requestHash: hash, target: importIdentitySchema, intentId: id, intentRevision: natural, revision: natural,
  mode: z.enum(['local', 'worktree']), finalCwd: path, localHeaderHash: hash, codeMismatchAcknowledged: z.literal(true).optional(),
  mapping: z.strictObject({ id, revision: hash, remotePlatform: z.enum(['linux', 'darwin', 'win32']), remotePrefix: path, localRoot: path }),
  sourceFolder: z.strictObject({ projectId: id, folderId: id, path }).optional(),
  phase: importPhaseSchema, cancelledFromPhase: importPhaseSchema.optional(),
  artifact: importArtifactSchema.optional(), historyArtifact: importArtifactSchema.optional(), placement: importPlacementSchema.optional(),
  binding: z.strictObject({ workspaceId: id, projectId: id.optional(), folderId: id.optional(), placementRevision: natural.optional() }).optional(),
  continueReceipt: z.strictObject({ grantId: id, intentId: id, intentRevision: natural, grantedAt: natural }).optional(),
  effects: z.array(z.strictObject({ kind: z.enum(['destination', 'artifact', 'history', 'binding']), receiptHash: hash, at: natural })).max(16),
  createdAt: natural, updatedAt: natural, cancelledAt: natural.optional(), cancellationIntentId: id.optional(), error: z.enum(['cancelled', 'unavailable', 'inconsistent', 'recovery-required']).optional(),
}).superRefine((record, ctx) => {
  if (!isAbsolute(record.finalCwd) || !isAbsolute(record.mapping.localRoot)) ctx.addIssue({ code: 'custom', message: 'Local destination paths must be absolute.' });
  if (record.target.inheritedEventCount > record.target.eventCount) ctx.addIssue({ code: 'custom', message: 'Inherited cut exceeds committed history.' });
  if (record.artifact && (record.artifact.headerHash !== record.localHeaderHash || record.artifact.inheritedEventCount !== record.target.inheritedEventCount || record.artifact.prefixCount > record.target.eventCount)) ctx.addIssue({ code: 'custom', message: 'Initial artifact commitment contradicts the target.' });
  if (record.historyArtifact && (!record.artifact || record.historyArtifact.headerHash !== record.localHeaderHash || record.historyArtifact.inheritedEventCount !== record.target.inheritedEventCount || record.historyArtifact.prefixCount !== record.target.eventCount)) ctx.addIssue({ code: 'custom', message: 'The verified history commitment must cover the exact reviewed target.' });
  if (record.continueReceipt && (record.continueReceipt.intentId !== record.intentId || record.continueReceipt.intentRevision !== record.intentRevision || record.phase !== 'ready')) ctx.addIssue({ code: 'custom', message: 'Continue requires this exact ready intent.' });
  if (record.phase === 'cancelled' && record.cancelledAt === undefined) ctx.addIssue({ code: 'custom', message: 'Cancellation receipt is required.' });
  if (record.phase === 'ready' && (!record.artifact || !record.binding || record.mode === 'worktree' && record.placement?.bound !== true)) ctx.addIssue({ code: 'custom', message: 'Ready requires artifact and destination binding receipts.' });
  if (record.mode === 'worktree' && record.binding && record.binding.workspaceId !== record.placement?.workspaceId) ctx.addIssue({ code: 'custom', message: 'The native binding must match the actual bound placement workspace.' });
  if (record.placement && (record.mode !== 'worktree' || record.placement.operationId !== record.operationId || record.placement.requestHash !== record.requestHash || record.placement.intentId !== record.intentId || record.placement.effectiveCwd !== record.finalCwd || canonicalJson(record.placement.target) !== canonicalJson(record.target))) ctx.addIssue({ code: 'custom', message: 'Placement identity differs from its reservation.' });
});
export type ImportReservation = z.infer<typeof importReservationSchema>;
export type ImportArtifact = z.infer<typeof importArtifactSchema>;
export interface ImportFence { readonly operationId: string; readonly intentId: string; readonly intentRevision: number; readonly revision: number }
export function importFence(record: ImportReservation): ImportFence { return { operationId: record.operationId, intentId: record.intentId, intentRevision: record.intentRevision, revision: record.revision }; }
export class ImportJournalError extends Error {
  constructor(readonly code: 'CONFLICT' | 'STALE_INTENT' | 'UNSUPPORTED' | 'CORRUPT', message: string) { super(message); this.name = 'ImportJournalError'; }
}
const FORMAT = 'format.json';
const MAX_RECORD_BYTES = 128 * 1024;
const formatSchema = z.strictObject({ version: z.literal(1), protocol: z.literal('destination-import-journal') });
function isAbsent(error: unknown) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function immutable(record: ImportReservation) {
  return canonicalJson({ operationId: record.operationId, requestHash: record.requestHash, target: record.target, intentId: record.intentId, intentRevision: record.intentRevision, mode: record.mode,
    finalCwd: record.finalCwd, localHeaderHash: record.localHeaderHash, mapping: record.mapping, sourceFolder: record.sourceFolder, createdAt: record.createdAt });
}
export function assertImportFence(record: ImportReservation, fence: ImportFence): void {
  if (record.operationId !== fence.operationId || record.intentId !== fence.intentId || record.intentRevision !== fence.intentRevision || record.revision !== fence.revision) throw new ImportJournalError('STALE_INTENT', 'The import operation or intent revision changed.');
}

export class ImportJournal {
  private constructor(readonly root: string, private readonly rootIdentity: { dev: number; ino: number }) {}
  static async open(options: { root: string }): Promise<ImportJournal> {
    if (!isAbsolute(options.root)) throw new TypeError('Import journal root must be absolute.');
    await ensureImportDirectory(options.root);
    const root = await realpath(options.root);
    if (root !== resolve(options.root)) throw new ImportJournalError('CORRUPT', 'Import journal root must not traverse a symlink.');
    const formatPath = join(root, FORMAT);
    try { formatSchema.parse(JSON.parse(await readBoundedFile(formatPath, 1024))); }
    catch (error) {
      if (!isAbsent(error)) throw new ImportJournalError('UNSUPPORTED', 'Import journal format is unsupported or unreadable.');
      if ((await readdir(root)).length !== 0) throw new ImportJournalError('CORRUPT', 'Import journal format marker is missing from nonempty storage.');
      try {
        const handle = await open(formatPath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, protocol: 'destination-import-journal' })); await handle.sync(); } finally { await handle.close(); }
        await syncDirectory(root);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        formatSchema.parse(JSON.parse(await readBoundedFile(formatPath, 1024)));
      }
    }
    return new ImportJournal(root, await lstat(root));
  }
  private async checkRoot() {
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.dev !== this.rootIdentity.dev || stat.ino !== this.rootIdentity.ino || await realpath(this.root) !== this.root) throw new ImportJournalError('CORRUPT', 'Import journal root identity changed.');
    formatSchema.parse(JSON.parse(await readBoundedFile(join(this.root, FORMAT), 1024)));
  }
  async read(sessionId: string): Promise<ImportReservation | undefined> {
    await this.checkRoot();
    try {
      const record = importReservationSchema.parse(JSON.parse(await readBoundedFile(join(this.root, `${sidKey(sessionId)}.json`), MAX_RECORD_BYTES)));
      if (record.target.sessionId !== sessionId) throw new Error('foreign SID');
      return record;
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw new ImportJournalError('CORRUPT', 'The destination import reservation is unsupported or unreadable.');
    }
  }
  /** Bounded startup inventory; a malformed/foreign file refuses admission rather than being skipped. */
  async list(): Promise<readonly ImportReservation[]> {
    await this.checkRoot();
    const entries = await readdir(this.root);
    if (entries.length > 10_001) throw new ImportJournalError('CORRUPT', 'Import journal inventory exceeds its bound.');
    const result: ImportReservation[] = [];
    for (const name of entries) {
      if (name === FORMAT || /^\.[0-9a-f-]{36}\.tmp$/iu.test(name)) continue; // Unpublished temp bytes never grant admission; the prior durable veto remains authoritative.
      if (!/^[0-9a-f]{64}\.json$/u.test(name)) throw new ImportJournalError('CORRUPT', 'Unexpected import journal artifact requires recovery.');
      const record = importReservationSchema.parse(JSON.parse(await readBoundedFile(join(this.root, name), MAX_RECORD_BYTES)));
      if (name !== `${sidKey(record.target.sessionId)}.json`) throw new ImportJournalError('CORRUPT', 'Import journal key identity differs.');
      result.push(record);
    }
    return result;
  }
  private async publish(claim: SidClaim, record: ImportReservation, initial: boolean) {
    await assertSidClaim(claim, record.target.sessionId, record.operationId); await this.checkRoot();
    const bytes = canonicalJson(record);
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw new ImportJournalError('CORRUPT', 'Import journal record exceeds its bound.');
    const destination = join(this.root, `${sidKey(record.target.sessionId)}.json`);
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await assertSidClaim(claim, record.target.sessionId, record.operationId); await this.checkRoot();
    // All computed paths are bounded children of the verified plugin-owned root.
    if (initial) { await link(temporary, destination); await syncDirectory(this.root); await unlink(temporary); }
    else await rename(temporary, destination);
    await syncDirectory(this.root);
  }
  reserve(claim: SidClaim, input: ImportReservation): Promise<ImportReservation> { return withSidClaim(claim, () => this.reserveClaimed(claim, input)); }
  private async reserveClaimed(claim: SidClaim, input: ImportReservation): Promise<ImportReservation> {
    const record = importReservationSchema.parse(input);
    await assertSidClaim(claim, record.target.sessionId, record.operationId);
    const current = await this.read(record.target.sessionId);
    if (current) {
      if (immutable(current) !== immutable(record)) throw new ImportJournalError('CONFLICT', 'The session ID is reserved by a different import operation.');
      return current;
    }
    if (record.phase !== 'reserved' || record.revision !== 0 || record.artifact || record.historyArtifact || record.placement || record.binding || record.continueReceipt || record.effects.length > 0) throw new ImportJournalError('CONFLICT', 'A new reservation must precede every effect.');
    await this.publish(claim, record, true); return record;
  }
  update(claim: SidClaim, fence: ImportFence, transform: (current: ImportReservation) => ImportReservation): Promise<ImportReservation> { return withSidClaim(claim, () => this.updateClaimed(claim, fence, transform)); }
  private async updateClaimed(claim: SidClaim, fence: ImportFence, transform: (current: ImportReservation) => ImportReservation): Promise<ImportReservation> {
    await assertSidClaim(claim, claim.sessionId, fence.operationId);
    const current = await this.read(claim.sessionId);
    if (!current) throw new ImportJournalError('CONFLICT', 'The import reservation is missing.');
    assertImportFence(current, fence);
    const next = importReservationSchema.parse(transform(structuredClone(current)));
    if (immutable(next) !== immutable(current) || next.revision !== current.revision + 1 || next.updatedAt < current.updatedAt) throw new ImportJournalError('CONFLICT', 'An import update changed immutable identity or revision.');
    if (current.cancelledAt !== undefined && (next.phase !== 'cancelled' || next.cancelledAt !== current.cancelledAt)) throw new ImportJournalError('STALE_INTENT', 'A cancelled import cannot be resurrected.');
    if (current.codeMismatchAcknowledged && !next.codeMismatchAcknowledged) throw new ImportJournalError('CONFLICT', 'Explicit code-snapshot acknowledgment cannot be erased.');
    if (current.artifact && canonicalJson(next.artifact) !== canonicalJson(current.artifact)) throw new ImportJournalError('CONFLICT', 'The readable initial artifact commitment is immutable.');
    if (current.historyArtifact && canonicalJson(next.historyArtifact) !== canonicalJson(current.historyArtifact)) throw new ImportJournalError('CONFLICT', 'The verified reviewed-history commitment is immutable.');
    if (current.placement) {
      const { bound: _oldBound, revision: _oldRevision, workspaceId: _oldWorkspace, ...oldIdentity } = current.placement;
      const { bound: _newBound, revision: _newRevision, workspaceId: _newWorkspace, ...newIdentity } = next.placement ?? {};
      if (!next.placement || canonicalJson(oldIdentity) !== canonicalJson(newIdentity) || next.placement.revision < current.placement.revision || current.placement.bound && !next.placement.bound || current.placement.workspaceId !== undefined && current.placement.workspaceId !== next.placement.workspaceId) throw new ImportJournalError('CONFLICT', 'A committed placement identity cannot be replaced or unbound.');
    }
    if (current.binding && canonicalJson(current.binding) !== canonicalJson(next.binding)) throw new ImportJournalError('CONFLICT', 'A committed destination membership receipt is immutable.');
    if (current.effects.some((effect, index) => canonicalJson(next.effects[index]) !== canonicalJson(effect))) throw new ImportJournalError('CONFLICT', 'Committed effect receipts cannot be removed or replaced.');
    await this.publish(claim, next, false); return next;
  }
  /** Guarded coordinator only: its live persistence port must first prove absence
   * under this exact claim after ALL in-flight effects/handles have drained. */
  removeCancelledBeforeEffects(claim: SidClaim, fence: ImportFence): Promise<void> {
    return withSidClaim(claim, async () => {
      await assertSidClaim(claim, claim.sessionId, fence.operationId); await this.checkRoot();
      const record = await this.read(claim.sessionId);
      if (!record) return;
      assertImportFence(record, fence);
      if (record.phase !== 'cancelled' || record.artifact || record.placement || record.binding || record.effects.length !== 0 || record.mode === 'worktree' && record.cancelledFromPhase !== 'reserved') throw new ImportJournalError('CONFLICT', 'A committed or uncertain destination cannot be released.');
      const target = join(this.root, `${sidKey(claim.sessionId)}.json`);
      await assertSidClaim(claim, claim.sessionId, record.operationId); await this.checkRoot();
      await unlink(target); await syncDirectory(this.root);
    });
  }
  cancel(claim: SidClaim, fence: ImportFence, nextIntent: { intentId: string; intentRevision: number }, now = Date.now()): Promise<ImportReservation> { return withSidClaim(claim, () => this.cancelClaimed(claim, fence, nextIntent, now)); }
  private async cancelClaimed(claim: SidClaim, fence: ImportFence, nextIntent: { intentId: string; intentRevision: number }, now: number): Promise<ImportReservation> {
    const current = await this.read(claim.sessionId);
    if (!current) throw new ImportJournalError('CONFLICT', 'The import reservation is missing.');
    assertImportFence(current, fence); await assertSidClaim(claim, claim.sessionId, fence.operationId);
    if (nextIntent.intentRevision <= current.intentRevision) throw new ImportJournalError('STALE_INTENT', 'Cancellation requires a newer local intent.');
    const { continueReceipt: _continue, ...rest } = current;
    // intentId remains the immutable operation intent, including inside committed placement
    // receipts. A newer cancellation identity/revision fences it without forging new receipts.
    const next = importReservationSchema.parse({ ...rest, intentRevision: nextIntent.intentRevision, cancellationIntentId: nextIntent.intentId, phase: 'cancelled', cancelledFromPhase: current.cancelledFromPhase ?? current.phase, cancelledAt: current.cancelledAt ?? now, updatedAt: now, revision: current.revision + 1, error: 'cancelled' });
    await this.publish(claim, next, false); return next;
  }
}
