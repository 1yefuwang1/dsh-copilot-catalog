/** Pure browser-safe read-only inspection guidance; no Git execution here. */
import { parseGitFacts, type GitFacts } from './sanitize.js';
export interface GitGuidance { readonly posix: readonly string[]; readonly powershell: readonly string[]; readonly mismatch: boolean }
export function quotePosix(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Unsafe shell argument.');
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}
export function quotePowerShell(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Unsafe shell argument.');
  return `'${value.replace(/'/gu, "''")}'`;
}
/** Only inspect the verified LOCAL root. Source facts never choose a local cwd. */
export function gitGuidance(localInput: GitFacts | null, remoteInput: GitFacts | null): GitGuidance {
  const local = parseGitFacts(localInput), remote = parseGitFacts(remoteInput);
  const commands: string[][] = [];
  if (local) {
    const base = ['--no-optional-locks', '--no-pager', '-C', local.root, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
    // show-ref and rev-parse inspect refs only: no worktree conversion/filter,
    // object lazy fetch, pager, checkout, fetch, push or worktree mutations.
    commands.push([...base, 'rev-parse', '--verify', 'HEAD']);
    if (remote?.branch && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(remote.branch)) commands.push([...base, 'show-ref', '--verify', '--', `refs/heads/${remote.branch}`]);
  }
  return Object.freeze({ posix: Object.freeze(commands.map(args => `git ${args.map(quotePosix).join(' ')}`)), powershell: Object.freeze(commands.map(args => `& 'git' ${args.map(quotePowerShell).join(' ')}`)),
    mismatch: !!local && !!remote && (local.commit !== remote.commit || local.branch !== remote.branch || local.dirty !== 'clean' || remote.dirty !== 'clean') });
}
