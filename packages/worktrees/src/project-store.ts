import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { RecordTable } from './store.js';
import type { ProjectRecord, ProjectThreadBinding } from './projects.js';

const text = z.string().min(1).max(4096);
const path = text.refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value));
export const projectFolderSchema = z.object({ id: text, path, title: z.string().max(4096) }).strict();
export const projectRecordSchema = z.object({
  id: z.string().uuid(), title: z.string().min(1).max(120), folders: z.array(projectFolderSchema).min(1).max(32), mainFolderId: text.optional(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), imported: z.boolean().optional(),
}).strict().refine(value => value.mainFolderId === undefined || value.folders.some(folder => folder.id === value.mainFolderId), { path: ['mainFolderId'], message: 'The main folder must be a member of the project.' });
export const projectBindingSchema = z.object({
  sessionId: z.string().min(1).max(256), projectId: z.string().uuid(), folderId: text,
  mode: z.enum(['local', 'worktree']), effectiveCwd: path, worktreeId: z.string().uuid().optional(),
}).strict().refine(value => value.mode === 'worktree' ? value.worktreeId !== undefined : value.worktreeId === undefined);
export interface ProjectStartRecord {
  id: string; projectId: string; folderId: string; actorId: string | null;
  effectiveCwd: string; requestedSessionId: string;
  phase: 'planned' | 'creating' | 'session-created' | 'ready' | 'recovery-required';
  sessionId: string | null; workspaceId: string | null;
  createdAt: number; updatedAt: number;
}
const startSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), folderId: text, actorId: z.string().min(1).max(256).nullable(),
  effectiveCwd: path, requestedSessionId: z.string().min(1).max(256),
  phase: z.enum(['planned', 'creating', 'session-created', 'ready', 'recovery-required']),
  sessionId: z.string().min(1).max(256).nullable(), workspaceId: text.nullable(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
}).strict();
export interface ProjectRemovalRecord { id: string; folders: { id: string; path: string }[]; removedAt: number }
export const projectRemovalSchema = z.object({
  id: z.string().uuid(), folders: z.array(projectFolderSchema.omit({ title: true })).min(1).max(32), removedAt: z.number().int().nonnegative(),
}).strict();
/** Separate plugin-owned metadata; the existing worktree domain is not migrated or changed.
 * Additive v1 table: storageDomain and the JSON backend load missing tables as empty;
 * existing v1 records retain their schemas and version stamps (no migration needed).
 */
export const projectDomain = defineDomain({
  name: 'dsh_worktree_projects', version: 1, layout: 'per-record',
  tables: { projects: domainTable(projectRecordSchema), bindings: domainTable(projectBindingSchema), starts: domainTable(startSchema), removals: domainTable(projectRemovalSchema) },
});
export interface ProjectStore {
  projects: RecordTable<ProjectRecord>;
  bindings: RecordTable<ProjectThreadBinding>;
  starts: RecordTable<ProjectStartRecord>;
  removals: RecordTable<ProjectRemovalRecord>;
  close(): Promise<void>;
}
