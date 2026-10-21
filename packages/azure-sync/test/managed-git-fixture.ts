import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { SubprocessRuntime, scrubbedParentEnv, type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';

export const fixtureInside = (root: string, value: string) => { const part = relative(root, value); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
export async function fixtureGitExecutable() {
  for (const folder of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) for (const name of process.platform === 'win32' ? ['git.exe', 'git.com'] : ['git']) {
    const path = resolve(folder, name);
    try { await access(path, constants.X_OK); if (!(await lstat(path)).isDirectory()) return realpath(path); } catch { /* Try the next public PATH candidate. */ }
  }
  return undefined;
}
export interface FixtureProcessCall { cwd: string; argv: readonly string[] }
/** Public process implementation seam. Real bounded Git only, owned fixture cwd,
 * no shell/PTY/network fallback and no borrowed Agent or Host sandbox policy.
 */
export class FixtureGitProcesses extends SubprocessRuntime {
  private readonly running = new Set<SubprocessHandle>();
  constructor(ctx: Context, private readonly root: string, private readonly git: string, readonly calls: FixtureProcessCall[]) {
    super(ctx); ctx.effect(() => async () => { for (const process of this.running) process.terminate(); await Promise.allSettled([...this.running].map(process => process.done)); });
  }
  async resolveExecutable(command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal) { signal?.throwIfAborted(); assert.ok(command === 'git' || command === this.git); return this.git; }
  async terminalEnvironment(): Promise<never> { throw new Error('No terminal in this fixture.'); }
  async spawnTerminal(): Promise<never> { throw new Error('No terminal in this fixture.'); }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted(); const cwd = realpathSync(spec.cwd); assert.equal(cwd, spec.cwd); assert.ok(fixtureInside(this.root, cwd)); assert.equal(spec.argv[0], this.git);
    assert.equal(spec.stdio.stdout, 'pipe'); assert.equal(spec.stdio.stderr, 'pipe');
    const env: NodeJS.ProcessEnv = { ...scrubbedParentEnv(), HOME: join(this.root, 'empty-home'), USERPROFILE: join(this.root, 'empty-home'), XDG_CONFIG_HOME: join(this.root, 'empty-config') };
    for (const [key, value] of Object.entries(spec.env ?? {})) { if (value === undefined) delete env[key]; else env[key] = value; }
    this.calls.push({ cwd, argv: [...spec.argv] });
    const child = spawn(this.git, spec.argv.slice(1), { cwd, env, shell: false, stdio: [spec.stdio.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let exited = false, bytes = 0, failure: Error | undefined, kill: NodeJS.Timeout | undefined;
    const terminate = () => { if (!exited) { child.kill('SIGTERM'); kill ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, Math.min(spec.graceMs, 1000)); } };
    const abort = () => terminate(); spec.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { failure = new Error('Fixture Git deadline.'); terminate(); }, 20000);
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', value => { bytes += value.length; if (bytes > 8 * 1024 * 1024) { failure = new Error('Fixture output bound.'); terminate(); } });
    child.on('error', error => { failure = error; });
    const done = new Promise<Awaited<SubprocessHandle['done']>>((fulfill, reject) => child.on('close', (exitCode, signal) => { exited = true; clearTimeout(timer); clearTimeout(kill); spec.signal?.removeEventListener('abort', abort); this.running.delete(handle); if (failure) reject(failure); else fulfill({ exitCode, signal }); }));
    const handle: SubprocessHandle = { stdin: child.stdin ?? undefined, stdout: child.stdout ?? undefined, stderr: child.stderr ?? undefined, control: undefined, collected: {}, done, terminate,
      async waitForExit(signal?: AbortSignal) { if (exited) return true; if (signal?.aborted) return false; let listener!: () => void; const aborted = new Promise<boolean>(resolve => { listener = () => resolve(false); signal?.addEventListener('abort', listener, { once: true }); }); try { return await Promise.race([done.then(() => true), aborted]); } finally { signal?.removeEventListener('abort', listener); } },
    }; this.running.add(handle); if (spec.signal?.aborted) terminate(); return handle;
  }
}
/** Test setup/mutation only; all arguments are literal and cwd fixture-owned. */
export async function fixtureGit(root: string, git: string, cwd: string, args: readonly string[]) {
  assert.ok(fixtureInside(root, await realpath(cwd)));
  return new Promise<string>((fulfill, reject) => {
    const child = spawn(git, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], { cwd, shell: false, env: { ...scrubbedParentEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = []; let bytes = 0; const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    const collect = (target: Buffer[]) => (value: Buffer) => { bytes += value.length; if (bytes > 4 * 1024 * 1024) child.kill('SIGKILL'); else target.push(value); };
    child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err)); child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Fixture setup Git ${code}: ${Buffer.concat(err)}`)); else fulfill(Buffer.concat(out).toString('utf8').trim()); });
  });
}
