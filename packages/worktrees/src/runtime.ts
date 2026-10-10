import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Readable, Writable } from 'node:stream';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { WorktreeError, redact } from './errors.js';
import type { GitExecutor, WorktreeConfig } from './types.js';

export interface ExecutionPolicy { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string; sessionId?: string }
interface SandboxPolicyCapability { resolve(request: { session: Agent['session'] }): ExecutionPolicy }
interface SandboxCapability { confine(argv: readonly string[], policy: ExecutionPolicy, signal?: AbortSignal): Promise<{ argv: string[]; enforcement: string }> }
interface FsCapability {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
  processPath(target: unknown): string;
  processPathFromHostPath(path: string): string | undefined;
}
interface ProcessHandle {
  stdin: Writable | undefined;
  stdout: Readable | undefined;
  stderr: Readable | undefined;
  done: Promise<{ exitCode: number | null; signal: string | null }>;
  terminate(): void;
  waitForExit(signal?: AbortSignal): Promise<boolean>;
}
interface SubprocessCapability {
  resolveExecutable(command: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string>;
  spawn(spec: { argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; graceMs: number; stdio: { stdin: 'ignore' | 'pipe'; stdout: 'pipe'; stderr: 'pipe' } }): ProcessHandle;
}
export interface PlanCapability { get(agent: Agent): { active: boolean; pending?: boolean } }

export function capability<T>(ctx: Context, name: string): T | undefined {
  return ctx.get(name) as T | undefined;
}
export function required<T>(ctx: Context, name: string): T {
  const result = capability<T>(ctx, name);
  if (result === undefined) throw new WorktreeError('MISSING_CAPABILITY', `The ${name} capability is not mounted in the caller's composition.`);
  return result;
}
export function policyOf(agent: Agent): ExecutionPolicy {
  return required<SandboxPolicyCapability>(agent.ctx, 'sandboxPolicy').resolve({ session: agent.session });
}
export function requireFullAccess(agent: Agent): void {
  if (policyOf(agent).mode !== 'danger-full-access') throw new WorktreeError('FULL_ACCESS_REQUIRED', 'This operation writes across the worktree and shared Git metadata. Select full access through the existing permission control, then retry; no permission is expanded automatically.');
}
export function planBlocksMutation(agent: Agent): boolean {
  const plan = capability<PlanCapability>(agent.ctx, 'planMode')?.get(agent);
  return plan?.active === true || plan?.pending === true;
}

export async function localProjectPath(agent: Agent, requested?: string, signal?: AbortSignal): Promise<string> {
  const cwd = agent.session.header.cwd;
  if (cwd === undefined) throw new WorktreeError('NO_WORKSPACE', 'Select a project before using worktrees.');
  const path = requested === undefined ? cwd : isAbsolute(requested) ? requested : resolve(cwd, requested);
  const fs = required<FsCapability>(agent.ctx, 'fs');
  const target = await fs.resolve(path, { cwd, signal });
  const mapped = fs.processPathFromHostPath(path);
  if (mapped === undefined || resolve(mapped) !== resolve(fs.processPath(target))) throw new WorktreeError('UNSUPPORTED_PROVIDER', 'Worktree management currently requires a local filesystem and subprocess execution world.');
  return realpath(path);
}

function collect(stream: Readable | undefined, limit: number, controller: AbortController): Promise<Buffer> {
  if (stream === undefined) return Promise.reject(new WorktreeError('PROCESS_PROTOCOL', 'The subprocess provider did not expose the requested output pipe.'));
  return new Promise((fulfill, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const data = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > limit) {
        if (!failed) {
          failed = true;
          const error = new WorktreeError('OUTPUT_LIMIT', 'Git output exceeded its bound; no truncated result is accepted.');
          controller.abort(error);
          reject(error);
        }
      } else if (!failed) chunks.push(value);
    };
    const finish = () => { cleanup(); if (!failed) fulfill(Buffer.concat(chunks)); };
    const error = (reason: Error) => { cleanup(); if (!failed) reject(reason); };
    const cleanup = () => { stream.off('data', data); stream.off('end', finish); stream.off('close', finish); stream.off('error', error); };
    stream.on('data', data);
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', error);
  });
}

/** No native spawn fallback: every production Git command uses the caller's managed capabilities. */
export function createExecutor(agent: Agent, config: WorktreeConfig, shutdown?: AbortSignal): GitExecutor {
  const subprocess = required<SubprocessCapability>(agent.ctx, 'subprocess');
  return async spec => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new WorktreeError('TIMEOUT', 'The Git command exceeded its deadline.')); }, spec.timeoutMs ?? config.commandTimeoutMs);
    const signals = [controller.signal, spec.signal, shutdown].filter((s): s is AbortSignal => s !== undefined);
    const signal = AbortSignal.any(signals);
    let handle: ProcessHandle | undefined;
    try {
      const executable = await subprocess.resolveExecutable(config.gitExecutable, spec.env, signal);
      let argv = [executable, ...spec.args];
      const policy = policyOf(agent);
      if (policy.mode !== 'danger-full-access') {
        const sandbox = required<SandboxCapability>(agent.ctx, 'sandbox');
        const confined = await sandbox.confine(argv, policy, signal);
        if (confined.enforcement !== 'full') throw new WorktreeError('INCOMPLETE_SANDBOX', 'The available sandbox cannot fully enforce this operation.');
        argv = confined.argv;
      }
      handle = subprocess.spawn({ argv, cwd: spec.cwd, env: spec.env, signal, graceMs: 1500, stdio: { stdin: spec.stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' } });
      const stdout = collect(handle.stdout, spec.maxBytes ?? 65536, controller);
      const stderr = collect(handle.stderr, 65536, controller);
      if (spec.stdin !== undefined) {
        if (handle.stdin === undefined) throw new WorktreeError('PROCESS_PROTOCOL', 'The subprocess provider did not expose its input pipe.');
        handle.stdin.on('error', () => undefined);
        handle.stdin.end(typeof spec.stdin === 'string' ? spec.stdin : Buffer.from(spec.stdin));
      }
      const [out, err, outcome] = await Promise.all([stdout, stderr, handle.done]);
      if (signal.aborted) throw timedOut ? new WorktreeError('TIMEOUT', 'The Git command exceeded its deadline.') : new WorktreeError('CANCELLED', 'Git was cancelled; committed effects may remain.');
      if (!await handle.waitForExit(signal)) throw new WorktreeError('PROCESS_NOT_QUIESCENT', 'The provider could not confirm that the Git process range exited.');
      if (outcome.exitCode === null || !(spec.allowedExitCodes ?? [0]).includes(outcome.exitCode)) throw new WorktreeError('GIT_FAILED', `Git failed${outcome.exitCode === null ? '' : ` (${outcome.exitCode})`}: ${redact(err.toString('utf8')) || 'no diagnostic'}`);
      return { stdout: out, stderr: err, exitCode: outcome.exitCode };
    } catch (error) {
      handle?.terminate();
      if (handle !== undefined) {
        await handle.waitForExit(AbortSignal.timeout(5000)).catch(() => false);
        handle.stdout?.destroy(); handle.stderr?.destroy(); handle.stdin?.destroy();
      }
      if (timedOut) throw new WorktreeError('TIMEOUT', 'The Git command exceeded its deadline.');
      throw error;
    } finally { clearTimeout(timeout); }
  };
}
