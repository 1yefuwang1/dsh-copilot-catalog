import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { RecordTable } from './store.js';
import type { RemovalIdentity } from './git.js';
import type { WorktreeCleanupSummary } from './types.js';

const text = z.string().min(1).max(4096);
const path = text.refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value));
const time = z.number().int().nonnegative().safe();
const sessionId = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u);
const error = z.object({ code: z.string().min(1).max(64), message: z.string().max(4096) }).strict().nullable();
const phases = z.enum(['deferred', 'planned', 'preserving', 'removing', 'collected', 'recovery-required']);

export interface CleanupReceipt {
  id: string;
  checkoutRoot: string;
  commonDir: string;
  originalFolder: string | null;
  sourceRoot: string | null;
  projectId?: string;
  folderId?: string;
  sessionIds: string[];
  phase: WorktreeCleanupSummary['phase'];
  inactivityDays: number;
  lastActivityAt: number | null;
  eligibleAfter: number | null;
  reclaimedAt: number | null;
  recoveryRef: string | null;
  identity?: RemovalIdentity;
  createdAt: number;
  updatedAt: number;
  reason: { code: string; message: string } | null;
}
export interface ReopenReceipt {
  id: string;
  worktreeId: string;
  sessionId: string;
  sourceHash: string;
  sourceBoundary: number | null;
  cwd: string;
  sourceRoot: string;
  commonDir: string;
  localBranch: string;
  localOid: string;
  workspaceId: string | null;
  phase: 'planned' | 'session-created' | 'switching' | 'ready' | 'recovery-required';
  createdAt: number;
  updatedAt: number;
  reason: { code: string; message: string } | null;
}

// Identity is engine-owned evidence. Its authoritative validation is a fresh
// Git inspection, never storage data alone; the receipt stays lossless JSON.
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const identity = z.object({
  checkoutRoot: path, sourceRoot: path, commonDir: path, adminDir: path, head: oid, branch: text.nullable(),
  checkoutIdentity: text, sourceIdentity: text, commonIdentity: text, adminIdentity: text,
  pointerIdentity: text, pointerHash: hash, backlinkIdentity: text, backlinkHash: hash,
  commonPointerIdentity: text, commonPointerHash: hash, sourceMappingIdentity: text, sourceMappingHash: z.union([hash, z.literal('')]),
  privateStateHash: hash, retainedHeads: z.array(oid).max(10000),
}).strict();
const cleanupSchema = z.object({
  id: z.string().uuid(), checkoutRoot: path, commonDir: path, originalFolder: path.nullable(), sourceRoot: path.nullable(),
  projectId: z.string().uuid().optional(), folderId: sessionId.optional(), sessionIds: z.array(sessionId), phase: phases,
  inactivityDays: z.number().int().min(1).max(3650), lastActivityAt: time.nullable(), eligibleAfter: time.nullable(),
  reclaimedAt: time.nullable(), recoveryRef: text.nullable(), identity: identity.optional(),
  createdAt: time, updatedAt: time, reason: error,
}).strict();
const reopenSchema = z.object({
  id: sessionId, worktreeId: z.string().uuid(), sessionId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceBoundary: time.nullable(), cwd: path, sourceRoot: path, commonDir: path,
  localBranch: text, localOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u), workspaceId: sessionId.nullable(),
  phase: z.enum(['planned', 'session-created', 'switching', 'ready', 'recovery-required']),
  createdAt: time, updatedAt: time, reason: error,
}).strict();
/** Companion domain: existing worktree/project records and versions are untouched. */
export const cleanupDomain = defineDomain({
  name: 'dsh_worktree_cleanup', version: 1, layout: 'per-record',
  tables: { cleanup: domainTable(cleanupSchema), reopens: domainTable(reopenSchema) },
});
export interface CleanupStore {
  cleanup: RecordTable<CleanupReceipt>;
  reopens: RecordTable<ReopenReceipt>;
  close(): Promise<void>;
}
export function cleanupSummary(receipt: CleanupReceipt): WorktreeCleanupSummary {
  return {
    phase: receipt.phase, inactivityDays: receipt.inactivityDays, lastActivityAt: receipt.lastActivityAt,
    eligibleAfter: receipt.eligibleAfter, reclaimedAt: receipt.reclaimedAt, originalFolder: receipt.originalFolder,
    recoveryRef: receipt.recoveryRef, reason: receipt.reason === null ? null : { ...receipt.reason },
  };
}
