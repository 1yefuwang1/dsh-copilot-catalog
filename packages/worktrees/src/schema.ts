import { createHash } from 'node:crypto';
import { z } from 'zod';
import { WorktreeError } from './errors.js';
import type { WorktreeAction, WorktreeRequest } from './types.js';

export const ACTIONS = ['list', 'status', 'branches', 'create', 'start', 'branch', 'protect', 'preview', 'export', 'handoff', 'archive'] as const;
const text = z.string().min(1).max(4096);
const id = z.string().uuid();
export const requestSchema = z.object({
  action: z.enum(ACTIONS), repoPath: text.optional(), id: id.optional(), operationId: id.optional(),
  remote: text.optional(), remoteIdentity: text.optional(), remoteBranch: text.optional(),
  sourceSessionId: z.string().min(1).max(256).optional(), sessionMode: z.enum(['new', 'continue']).optional(),
  requireBlankSource: z.boolean().optional(), settingsHash: z.string().max(128).optional(),
  firstPrompt: z.string().max(65536).describe('Initial task text for automatic naming; only create accepts it.').optional(),
  projectId: id.describe('Logical project ID from workspace_project list; pair with folderId on create.').optional(),
  folderId: z.string().min(1).max(256).describe('Project folder ID from workspace_project list; pair with projectId on create.').optional(),
  name: text.optional(), protected: z.boolean().optional(), archived: z.boolean().optional(),
  previewId: id.optional(), targetPath: text.optional(), query: z.string().max(256).optional(),
  cursor: z.string().max(512).optional(), limit: z.number().int().min(1).max(100).optional(), includeArchived: z.boolean().optional(),
}).strict();
const fields: Record<WorktreeAction, readonly string[]> = {
  list: ['repoPath', 'cursor', 'limit', 'includeArchived'],
  status: ['repoPath', 'id', 'operationId'],
  branches: ['repoPath', 'remote', 'remoteIdentity', 'query', 'cursor', 'limit'],
  create: ['repoPath', 'operationId', 'remote', 'remoteIdentity', 'remoteBranch', 'sourceSessionId', 'sessionMode', 'requireBlankSource', 'settingsHash', 'firstPrompt', 'projectId', 'folderId'],
  start: ['id', 'sourceSessionId', 'sessionMode'],
  branch: ['id', 'name'], protect: ['id', 'protected'],
  preview: ['id', 'sourceSessionId', 'targetPath'], export: ['previewId'],
  handoff: ['id', 'previewId', 'operationId'], archive: ['id', 'archived'],
};
export function parseRequest(value: unknown): WorktreeRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new WorktreeError('INVALID_REQUEST', parsed.error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '));
  const request = parsed.data;
  for (const key of Object.keys(request)) if (key !== 'action' && !fields[request.action].includes(key)) throw new WorktreeError('INVALID_REQUEST', `${request.action} does not accept ${key}.`);
  const required: Partial<Record<WorktreeAction, readonly string[]>> = {
    create: ['operationId', 'remote', 'remoteBranch'], start: ['id'], branch: ['id', 'name'], protect: ['id', 'protected'],
    preview: ['id'], export: ['previewId'], handoff: ['id', 'previewId', 'operationId'], archive: ['id'], branches: ['remote'],
  };
  for (const key of required[request.action] ?? []) if ((request as Record<string, unknown>)[key] === undefined) throw new WorktreeError('INVALID_REQUEST', `${request.action} requires ${key}.`);
  if (request.action === 'status' && request.id !== undefined && request.operationId !== undefined) throw new WorktreeError('INVALID_REQUEST', 'Status accepts either id or operationId, not both.');
  if ((request.projectId === undefined) !== (request.folderId === undefined)) throw new WorktreeError('INVALID_REQUEST', 'Supply projectId and folderId together on create.');
  return request;
}
export function parseCommand(raw: string): WorktreeRequest {
  const line = raw.trim();
  if (line === '') return { action: 'list' };
  try {
    if (line.startsWith('{')) return parseRequest(JSON.parse(line));
    const match = /^([a-z]+)(?:\s+([\s\S]+))?$/u.exec(line);
    if (match === null) throw new WorktreeError('INVALID_REQUEST', 'Use /worktree <action> [JSON arguments].');
    const args: unknown = match[2] === undefined ? {} : JSON.parse(match[2]);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new WorktreeError('INVALID_REQUEST', 'Arguments must be a JSON object.');
    if ('action' in args) throw new WorktreeError('INVALID_REQUEST', 'Supply action once, before the JSON arguments.');
    return parseRequest({ ...args, action: match[1] });
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    throw new WorktreeError('INVALID_REQUEST', 'Arguments must be valid JSON.');
  }
}
export function hashValue(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export const mutationActions = new Set<WorktreeAction>(['create', 'start', 'branch', 'protect', 'handoff', 'archive']);
export const fullAccessActions = new Set<WorktreeAction>(['create', 'start', 'branch', 'preview', 'export', 'handoff']);
/** Zod attaches non-JSON ~standard helpers; the tool registry requires a plain lossless JSON snapshot. */
export const parameterSchema: Record<string, unknown> = JSON.parse(JSON.stringify(z.toJSONSchema(requestSchema))) as Record<string, unknown>;
