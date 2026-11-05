import { createHash } from 'node:crypto';
import { z } from 'zod';
import { WorktreeError } from './errors.js';
import type { WorktreeAction, WorktreeRequest } from './types.js';

export const ACTIONS = ['list', 'status', 'branches', 'create', 'start', 'branch', 'protect', 'preview', 'export', 'handoff', 'archive', 'reopen-info', 'reopen', 'release'] as const;
const text = z.string().min(1).max(4096);
const id = z.string().uuid();
export const requestSchema = z.object({
  action: z.enum(ACTIONS), repoPath: text.optional(), id: id.optional(), operationId: id.optional(),
  branchSource: z.enum(['local', 'remote']).describe('Branch source; omitted preserves remote behavior.').optional(),
  localBranch: text.describe('Exact local branch, or HEAD for a pinned detached commit. Reopen requires the user-selected branch.').optional(),
  localOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).describe('Expected selected commit; refuse movement. Required for reopen and detached creation.').optional(),
  remote: text.optional(), remoteIdentity: text.optional(), remoteBranch: text.optional(),
  sourceSessionId: z.string().min(1).max(256).optional(), sessionMode: z.enum(['new', 'continue']).optional(),
  requireBlankSource: z.boolean().optional(), settingsHash: z.string().max(128).optional(),
  firstPrompt: z.string().max(65536).describe('Initial task text for automatic naming; only create accepts it. At most 65536 characters.').optional(),
  projectId: id.describe('Logical project ID from workspace_project list; pair with folderId on create.').optional(),
  folderId: z.string().min(1).max(256).describe('Project folder ID from workspace_project list; pair with projectId on create.').optional(),
  name: text.optional(), protected: z.boolean().optional(), archived: z.boolean().optional(),
  previewId: id.optional(), targetPath: text.optional(), query: z.string().max(256).optional(),
  cursor: z.string().max(512).optional(), limit: z.number().int().min(1).max(100).optional(), includeArchived: z.boolean().optional(),
  takeover: z.boolean().describe('Reopen only: transfer a branch held by a plugin-managed checkout before switching.').optional(),
}).strict();
const fields: Record<WorktreeAction, readonly string[]> = {
  list: ['repoPath', 'cursor', 'limit', 'includeArchived'],
  status: ['repoPath', 'id', 'operationId'],
  branches: ['repoPath', 'branchSource', 'remote', 'remoteIdentity', 'query', 'cursor', 'limit'],
  create: ['repoPath', 'operationId', 'branchSource', 'localBranch', 'localOid', 'remote', 'remoteIdentity', 'remoteBranch', 'sourceSessionId', 'sessionMode', 'requireBlankSource', 'settingsHash', 'firstPrompt', 'projectId', 'folderId'],
  start: ['id', 'sourceSessionId', 'sessionMode'],
  branch: ['id', 'name'], protect: ['id', 'protected'],
  preview: ['id', 'sourceSessionId', 'targetPath'], export: ['previewId'],
  handoff: ['id', 'previewId', 'operationId'], archive: ['id', 'archived'],
  'reopen-info': ['sourceSessionId', 'cursor', 'limit'], reopen: ['sourceSessionId', 'localBranch', 'localOid', 'takeover'],
  release: ['id', 'localBranch', 'repoPath'],
};
/**
 * Drop unused optional strings before validation.
 *
 * Some model routes materialize every optional property of a tool declaration as
 * an empty string instead of omitting it. An empty optional carries no intent, so
 * it is treated as absent instead of failing validation for fields the caller
 * never meant to send.
 */
export function withoutEmptyOptionalStrings(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== '') result[key] = item;
  return result;
}
/**
 * Parse one model tool call.
 *
 * Tool arguments are also produced by an LLM, which may enumerate every property
 * of the declaration instead of only the fields the chosen action accepts. Such a
 * call still names its action explicitly, so fields the action does not accept are
 * dropped rather than refused; the strict parser keeps guarding callers that are
 * written by code, such as the authenticated UI RPC and the slash command.
 *
 * @param value - raw tool arguments.
 * @returns the request the chosen action accepts.
 */
export function parseToolRequest(value: unknown): WorktreeRequest {
  const normalized = withoutEmptyOptionalStrings(value);
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) return parseRequest(normalized);
  const action = (normalized as { action?: unknown }).action;
  const accepted = typeof action === 'string' && Object.hasOwn(fields, action) ? fields[action as WorktreeAction] : undefined;
  if (accepted === undefined) return parseRequest(normalized);
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(normalized)) if (key === 'action' || accepted.includes(key)) kept[key] = item;
  return parseRequest(kept);
}
export function parseRequest(value: unknown): WorktreeRequest {
  const parsed = requestSchema.safeParse(withoutEmptyOptionalStrings(value));
  if (!parsed.success) throw new WorktreeError('INVALID_REQUEST', parsed.error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '));
  const request = parsed.data;
  for (const key of Object.keys(request)) if (key !== 'action' && !fields[request.action].includes(key)) throw new WorktreeError('INVALID_REQUEST', `${request.action} does not accept ${key}.`);
  const required: Partial<Record<WorktreeAction, readonly string[]>> = {
    create: ['operationId'], start: ['id'], branch: ['id', 'name'], protect: ['id', 'protected'],
    preview: ['id'], export: ['previewId'], handoff: ['id', 'previewId', 'operationId'], archive: ['id'],
    'reopen-info': ['sourceSessionId'], reopen: ['sourceSessionId', 'localBranch', 'localOid'],
  };
  for (const key of required[request.action] ?? []) if ((request as Record<string, unknown>)[key] === undefined) throw new WorktreeError('INVALID_REQUEST', `${request.action} requires ${key}.`);
  if (request.action === 'create' || request.action === 'branches') {
    const local = request.branchSource === 'local';
    const sourceFields = local ? (request.action === 'create' ? ['localBranch'] : []) : (request.action === 'create' ? ['remote', 'remoteBranch'] : ['remote']);
    for (const key of sourceFields) if ((request as Record<string, unknown>)[key] === undefined) throw new WorktreeError('INVALID_REQUEST', `${request.action} requires ${key}.`);
    for (const key of local ? ['remote', 'remoteIdentity', 'remoteBranch'] : ['localBranch', 'localOid']) if ((request as Record<string, unknown>)[key] !== undefined) throw new WorktreeError('INVALID_REQUEST', `${local ? 'Local' : 'Remote'} source does not accept ${key}.`);
    if (local && request.localBranch === 'HEAD' && request.localOid === undefined) throw new WorktreeError('INVALID_REQUEST', 'Detached HEAD creation requires localOid.');
  }
  if (request.action === 'status' && request.id !== undefined && request.operationId !== undefined) throw new WorktreeError('INVALID_REQUEST', 'Status accepts either id or operationId, not both.');
  if (request.action === 'release') {
    if ((request.id === undefined) === (request.localBranch === undefined)) throw new WorktreeError('INVALID_REQUEST', 'Release accepts exactly one of id or localBranch.');
    if (request.repoPath !== undefined && request.localBranch === undefined) throw new WorktreeError('INVALID_REQUEST', 'Release accepts repoPath only with localBranch.');
  }
  if ((request.projectId === undefined) !== (request.folderId === undefined)) throw new WorktreeError('INVALID_REQUEST', 'Supply projectId and folderId together on create.');
  return request;
}
export function parseCommand(raw: string): WorktreeRequest {
  const line = raw.trim();
  if (line === '') return { action: 'list' };
  try {
    if (line.startsWith('{')) return parseRequest(JSON.parse(line));
    const match = /^([a-z]+(?:-[a-z]+)*)(?:\s+([\s\S]+))?$/u.exec(line);
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
export const mutationActions = new Set<WorktreeAction>(['create', 'start', 'branch', 'protect', 'handoff', 'archive', 'reopen', 'release']);
export const fullAccessActions = new Set<WorktreeAction>(['create', 'start', 'branch', 'preview', 'export', 'handoff', 'release']);
const TOOL_SCHEMA_HINTS = new Set(['$schema', '$id', 'format', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems']);
/** Schema keywords whose value maps names to subschemas. */
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
/** Schema keywords whose value is one subschema. */
const SCHEMA_VALUES = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']);
/** Schema keywords whose value is a list of subschemas. */
const SCHEMA_LISTS = new Set(['oneOf', 'anyOf', 'allOf', 'prefixItems']);

/**
 * Drop dialect markers and non-portable hints from schema positions only, so a property
 * named pattern, format or minimum is never mistaken for a keyword. The Zod parser keeps
 * every constraint; this projection only shapes the model-facing declaration.
 */
export function stripToolSchemaHints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripToolSchemaHints);
  if (value === null || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (TOOL_SCHEMA_HINTS.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      output[key] = Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([name, schema]) => [name, stripToolSchemaHints(schema)]));
    } else if (SCHEMA_VALUES.has(key)) {
      output[key] = stripToolSchemaHints(entry);
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(entry)) {
      output[key] = entry.map(stripToolSchemaHints);
    } else {
      output[key] = entry;
    }
  }
  return output;
}

/** Zod attaches non-JSON ~standard helpers; the tool registry requires a plain lossless JSON snapshot. */
export const parameterSchema: Record<string, unknown> = JSON.parse(JSON.stringify(stripToolSchemaHints(z.toJSONSchema(requestSchema)))) as Record<string, unknown>;
