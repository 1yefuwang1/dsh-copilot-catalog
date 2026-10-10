import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { WorktreeRecord, OperationRecord } from './types.js';

const str = z.string().max(4096);
const namingSchema = z.object({
  title: z.string().min(1).max(60), slug: z.string().min(1).max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  directoryName: z.string().min(10).max(49).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/u),
  branch: z.string().min(19).max(58).regex(/^worktree\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/u),
  source: z.enum(['model', 'fallback']),
  fallbackReason: z.enum(['disabled', 'unavailable', 'timeout', 'provider-failure', 'invalid-output', 'output-limit', 'incomplete-output']).optional(),
}).strict();
const worktreeSchema = z.object({
  id: z.string().uuid(), operationId: z.string().uuid(), repoRoot: str, commonDir: str, projectSubdir: str,
  checkoutRoot: str, effectiveCwd: str, remote: str, remoteIdentity: str, remoteBranch: str,
  baseOid: str, baseRef: str, fetchedAt: z.number().int().nonnegative(), createdAt: z.number().int().nonnegative(),
  sessionIds: z.array(str), workspaceId: str.nullable(), branch: str.nullable(), protected: z.boolean(), archived: z.boolean(),
  state: z.enum(['creating', 'ready', 'recovery-required', 'missing']), error: str.nullable(),
  displayName: z.string().min(1).max(60).optional(), naming: namingSchema.optional(),
  projectId: z.string().uuid().optional(), folderId: z.string().min(1).max(256).optional(),
  firstMessageNaming: z.object({
    sessionId: str, initialBranch: str,
    phase: z.enum(['waiting', 'generating', 'generated', 'renaming', 'complete', 'skipped']),
    messageSeq: z.number().int().nonnegative().optional(), messageId: str.optional(),
    messageHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(), generatedName: namingSchema.optional(),
    reason: z.string().max(128).optional(),
  }).strict().optional(),
}).strict();
const settingsSchema = z.object({
  model: z.object({ provider: str, model: str, reasoningEffort: str.optional() }).strict().nullable(),
  preset: str.nullable(), sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  approval: z.enum(['ask', 'never']), plan: z.boolean(), hash: str,
}).strict();
const operationSchema = z.object({
  id: z.string().uuid(), kind: z.enum(['create', 'handoff']), requestHash: str, actorId: str, worktreeId: z.string().uuid(),
  settingsHash: str, sourceSessionId: str, sessionMode: z.enum(['new', 'continue']), workspaceId: str.nullable(),
  settings: settingsSchema, targetRoot: str.nullable(), previewId: str.nullable(), appliedHead: str.nullable(), appliedFingerprint: str.nullable(),
  phase: z.enum(['planned', 'fetching', 'checkout-created', 'session-created', 'ready', 'applying', 'code-applied', 'cancel-requested', 'cancelled-before-effects', 'recovery-required']),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), sessionId: str.nullable(),
  error: z.object({ code: str, message: str }).strict().nullable(),
  generatedName: namingSchema.optional(), namingStarted: z.boolean().optional(),
}).strict();
export const worktreeDomain = defineDomain({
  name: 'dsh_worktrees', version: 1, layout: 'per-record',
  tables: { worktrees: domainTable(worktreeSchema), operations: domainTable(operationSchema) },
});
export interface RecordTable<T> {
  get(key: string): T | undefined;
  entries(): IterableIterator<[string, T]>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export interface WorktreeStore {
  worktrees: RecordTable<WorktreeRecord>;
  operations: RecordTable<OperationRecord>;
  close(): Promise<void>;
}
