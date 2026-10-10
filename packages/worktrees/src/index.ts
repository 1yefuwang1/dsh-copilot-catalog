import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-tools';
import { worktreeDomain, type WorktreeStore } from './store.js';
import { WorktreeController, resolveWorktreeRoot } from './service.js';
import { FirstMessageNamer } from './first-message.js';
import { WorktreeReminders } from './context.js';
import { registerWorktreeRpc, registerWorktreeProgressRpc } from './rpc.js';
import { ProjectController, parseProjectRequest, projectParameterSchema } from './projects.js';
import { projectDomain, type ProjectStore } from './project-store.js';
import { registerProjectRpc } from './project-rpc.js';
import { ProjectReminders } from './project-context.js';
import { parseCommand, parseRequest, parameterSchema } from './schema.js';
import { failureOf, WorktreeError } from './errors.js';
import type { CommandEnvelope, WorktreeConfig } from './types.js';

/** Host-native absolute paths, with bounded length and no controls or trailing whitespace. */
const rootPattern = process.platform === 'win32'
  ? /^(?:[A-Za-z]:[\\/]|\\\\)[^\u0000-\u001f]*[^\s\u0000-\u001f]$(?![\s\S])/u
  : /^\/[^\u0000-\u001f]*[^\s\u0000-\u001f]$(?![\s\S])/u;
export type PluginConfig = Omit<WorktreeConfig, 'root'> & { root: string | Volatile<string> };
interface SettingsPresentation { configure(presentation: { auto?: boolean }, owner: Context['fiber']): () => void }

export const name = 'git-worktrees';
export const inject = ['agents', 'sessions', 'sessionQuery', 'sessionPersistence', 'storageDomain', 'workspaceRegistry', 'commands', 'tools', 'subprocess', 'systemPrompt'];
export const Config = z.object({
  root: z.string().min(1).max(4096).pattern(rootPattern).default(dshHomePath('worktrees')).volatile(),
  gitExecutable: z.string().default('git'), defaultRemote: z.string().default('origin'), defaultBranch: z.string().default('main'),
  commandTimeoutMs: z.number().step(1).min(100).max(300000).default(30000),
  fetchTimeoutMs: z.number().step(1).min(100).max(600000).default(60000),
  operationTimeoutMs: z.number().step(1).min(1000).max(1200000).default(120000),
  maxSnapshotBytes: z.number().step(1).min(1024).max(134217728).default(33554432),
  maxFiles: z.number().step(1).min(1).max(10000).default(1000),
  maxRefBytes: z.number().step(1).min(1024).max(33554432).default(8388608),
  namingEnabled: z.boolean().default(true),
  namingProvider: z.string().min(1).max(256).default('github-copilot'),
  namingModel: z.string().min(1).max(256).default('gpt-6-luna'),
  namingTimeoutMs: z.number().step(1).min(100).max(60000).default(15000),
  namingMaxTokens: z.number().step(1).min(64).max(2048).default(256),
});

function encode(envelope: CommandEnvelope): string {
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text) > 1048576) throw new WorktreeError('RESPONSE_LIMIT', 'The result exceeds its response bound. Narrow the query or inspect the operation by ID.');
  return text;
}
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const configuredRoot = config.root;
  const worktreeRoot = () => {
    let value: unknown;
    try { value = typeof configuredRoot === 'string' ? configuredRoot : configuredRoot.get(); }
    catch { throw new WorktreeError('INVALID_ROOT', 'The live worktree root setting could not be read.'); }
    return resolveWorktreeRoot(value, typeof configuredRoot === 'string');
  };
  // Private snapshots and Git guards keep their initial root for this Host lifetime.
  const resolvedConfig: WorktreeConfig = { ...config, root: worktreeRoot() };
  const facility = ctx.get('storageDomain');
  if (facility === undefined) throw new WorktreeError('MISSING_STORAGE', 'The storage domain capability is required.');
  const domain = await facility.open(worktreeDomain);
  const store: WorktreeStore = { worktrees: domain.table('worktrees'), operations: domain.table('operations'), close: () => domain.close() };
  const projectsDomain = await facility.open(projectDomain).catch(async error => { await domain.close(); throw error; });
  const projectStore: ProjectStore = { projects: projectsDomain.table('projects'), bindings: projectsDomain.table('bindings'), starts: projectsDomain.table('starts'), close: () => projectsDomain.close() };
  let controller: WorktreeController;
  const projects = new ProjectController(ctx, projectStore, { records: () => controller.records() }, { operationTimeoutMs: resolvedConfig.operationTimeoutMs });
  let firstMessageNamer: FirstMessageNamer;
  controller = new WorktreeController(ctx, resolvedConfig, store, { projects, worktreeRoot, onNamingEligible: agent => firstMessageNamer.attach(agent) });
  firstMessageNamer = new FirstMessageNamer(ctx, controller);
  const reminders = new WorktreeReminders(ctx, controller);
  const projectReminders = new ProjectReminders(ctx, { project: id => projectStore.projects.get(id), bindingFor: (id, cwd) => projects.bindingFor(id, cwd) });
  ctx.provide('gitWorktrees', controller);
  ctx.provide('workspaceProjects', projects);
  ctx.inject(['settings'], scope => {
    scope.effect(() => (scope.get('settings') as SettingsPresentation).configure({ auto: false }, ctx.fiber));
  });
  const rpcStops = new Set<() => Promise<void>>();
  ctx.effect(() => async () => {
    // Close UI admission and await lookup/execution before the shared controller/store.
    await Promise.allSettled([...rpcStops].map(stop => stop()));
    reminders.close(); projectReminders.close();
    await firstMessageNamer.close();
    try { await controller.close(); } finally {
      try { await projects.close(); } finally { await Promise.allSettled([store.close(), projectStore.close()]); }
    }
  }, 'worktrees: orderly teardown');
  ctx.inject(['connection', 'sessionController'], scope => {
    for (const stop of [registerWorktreeRpc(scope, controller), registerWorktreeProgressRpc(scope, controller), registerProjectRpc(scope, projects)]) {
      rpcStops.add(stop);
      scope.effect(() => async () => { try { await stop(); } finally { rpcStops.delete(stop); } }, 'worktrees: optional UI capability ownership');
    }
  });
  await projects.synchronize();
  ctx.commands.register({
    name: 'worktree', description: 'Manage isolated Git worktree conversations and review or hand off changes.',
    input: { hint: '<action> [JSON arguments]' },
    handler: async ({ agent, rawInput, signal }) => {
      try {
        const request = parseCommand(rawInput);
        const data = await controller.execute(request, { agent, origin: 'command', signal });
        return { kind: 'success', text: encode({ v: 1, ok: true, data }) };
      } catch (error) { return { kind: 'error', text: encode({ v: 1, ok: false, error: failureOf(error) }) }; }
    },
  });
  ctx.tools.register({
    name: 'git_worktree',
    description: 'List or create isolated Git worktree threads from a freshly fetched remote branch; preview/export or hand off changes to a clean Local checkout. Cross-root Git mutations require existing full access. Handoff refuses running source/target sessions and never resets or deletes checkouts.',
    parameters: parameterSchema,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: args => {
      try { return ['list', 'status', 'branches'].includes(parseRequest(args).action); } catch { return false; }
    },
    execute: async (args, execution) => {
      if (execution.agent === undefined) throw new WorktreeError('NO_CALLER', 'A receiving agent is required; no Host-default authority is used.');
      const data = await controller.execute(parseRequest(args), { agent: execution.agent, origin: 'tool', signal: execution.signal });
      return { v: 1, ok: true, data };
    },
  });
  ctx.commands.register({
    name: 'project', description: 'Manage projects, their folders and blank Local threads without changing existing execution directories.',
    input: { hint: '<JSON action>' },
    handler: async ({ agent, rawInput, signal }) => {
      try {
        let value: unknown;
        try { value = rawInput.trim() === '' ? { action: 'list' } : JSON.parse(rawInput); }
        catch { throw new WorktreeError('INVALID_REQUEST', 'Use /project with one JSON action object.'); }
        const data = await projects.execute(parseProjectRequest(value), { agent, origin: 'command', signal });
        return { kind: 'success', text: encode({ v: 1, ok: true, data }) };
      } catch (error) { return { kind: 'error', text: encode({ v: 1, ok: false, error: failureOf(error) }) }; }
    },
  });
  ctx.tools.register({
    name: 'workspace_project',
    description: 'List and manage projects containing existing folders, bind threads by their actual execution directory, or start a blank Local thread. Membership does not move files, change existing thread directories or grant permissions. Cross-root thread creation requires existing full access.',
    parameters: projectParameterSchema,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: args => { try { return parseProjectRequest(args).action === 'list'; } catch { return false; } },
    execute: async (args, execution) => {
      if (execution.agent === undefined) throw new WorktreeError('NO_CALLER', 'A receiving agent is required; no Host-default authority is used.');
      const data = await projects.execute(parseProjectRequest(args), { agent: execution.agent, origin: 'tool', signal: execution.signal });
      return { v: 1, ok: true, data };
    },
  });
  reminders.start(); projectReminders.start(); firstMessageNamer.start();
}
export { ProjectController, resolveMainFolder } from './projects.js';
export type { ProjectFolder, ProjectRecord, ProjectThreadBinding, ProjectSnapshot, ProjectRequest, ProjectInvocation, ProjectStartResult } from './projects.js';
export { GitOperations } from './git.js';
export { WorktreeError } from './errors.js';
export type * from './types.js';
