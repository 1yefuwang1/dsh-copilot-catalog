/** Bounded durable reviewed plans. No event/message payloads, credentials, or executable authority. */
import { randomUUID } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../sync/canonical.js';
import { parseCloudImportRequest, type ImportDestination } from './protocol.js';
import { ensureImportDirectory, readBoundedFile, sidKey, syncDirectory, SidClaimStore } from './claims.js';
import { importIdentitySchema, importReservationSchema } from './journal.js';

const text = z.string().min(1).max(4096), hash = z.string().regex(/^[0-9a-f]{64}$/u);
const reviewedSchema = z.strictObject({
  version: z.literal(1), operationId: z.string().uuid(), sessionId: text, revision: z.number().int().positive(),
  target: importIdentitySchema, requestJson: z.string().max(32_768), reservation: importReservationSchema,
  localizedHeaderJson: z.string().max(32_768), worktreePlanJson: z.string().max(32_768).optional(),
  settingsKey: hash, gitSelectionKey: z.string().max(16_384).optional(), sourceGitJson: z.string().max(16_384).optional(),
  localGitFingerprint: hash.optional(), localGitJson: z.string().max(16_384).optional(),
  codeMismatch: z.boolean(), warnings: z.array(z.string().max(256)).max(16), expiresAt: z.number().int().nonnegative(),
  cancelledAt: z.number().int().nonnegative().optional(), createdAt: z.number().int().nonnegative(),
});
export type ReviewedImportPlan = z.infer<typeof reviewedSchema>;
export function reviewedDestination(plan: ReviewedImportPlan): ImportDestination {
  const request = parseCloudImportRequest(JSON.parse(plan.requestJson));
  if (request.action !== 'plan-import' || request.operationId !== plan.operationId || request.sessionId !== plan.sessionId || request.generation !== plan.target.generation) throw new Error('Reviewed import identity differs.');
  return request.destination;
}
export class ReviewedPlanStore {
  private constructor(readonly root: string, private readonly claims: SidClaimStore) {}
  static async open(root: string) { await ensureImportDirectory(root); return new ReviewedPlanStore(root, await SidClaimStore.open(join(root, 'review-locks'))); }
  private file(operationId: string) { if (!/^[0-9a-f-]{36}$/iu.test(operationId)) throw new Error('Invalid import operation identity.'); return join(this.root, `${sidKey(operationId)}.json`); }
  async read(operationId: string): Promise<ReviewedImportPlan | undefined> {
    try {
      const value = reviewedSchema.parse(JSON.parse(await readBoundedFile(this.file(operationId), 128 * 1024)));
      if (value.operationId !== operationId || value.reservation.target.sessionId !== value.sessionId || value.reservation.operationId !== operationId || canonicalJson(value.target) !== canonicalJson(value.reservation.target)) throw new Error('Foreign reviewed plan.');
      reviewedDestination(value); return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async publish(plan: ReviewedImportPlan) {
    const bytes = canonicalJson(reviewedSchema.parse(plan));
    if (Buffer.byteLength(bytes) > 128 * 1024) throw new Error('Reviewed plan capacity exceeded.');
    const temporary = join(this.root, `.${randomUUID()}.tmp`), destination = this.file(plan.operationId);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, destination); await syncDirectory(this.root);
  }
  async put(plan: ReviewedImportPlan): Promise<ReviewedImportPlan> {
    // A review-only lock is scoped to this operation, NOT the native target SID.
    const claim = await this.claims.acquire(plan.operationId, plan.operationId);
    try {
      const current = await this.read(plan.operationId);
      if (current) {
        if (current.requestJson !== plan.requestJson || current.reservation.requestHash !== plan.reservation.requestHash) throw new Error('Operation already reviews a different destination.');
        return current;
      }
      await this.publish(plan); return plan;
    } finally { await claim.release(); }
  }
  async cancel(operationId: string, now: number): Promise<void> {
    const claim = await this.claims.acquire(operationId, operationId);
    try {
      const plan = await this.read(operationId); if (!plan) return;
      if (plan.cancelledAt === undefined) await this.publish({ ...plan, revision: plan.revision + 1, cancelledAt: now });
    } finally { await claim.release(); }
  }
}
