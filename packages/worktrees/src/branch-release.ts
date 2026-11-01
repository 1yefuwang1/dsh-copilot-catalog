import type { GitOperations, WorktreeBranchHolder } from './git.js';
import { WorktreeError } from './errors.js';
import type { BranchHolder, CheckoutState, ReleasedBranchHolder, RepositoryInfo, WorktreeRecord } from './types.js';

/**
 * Branch ownership is Git's call: one local branch can be checked out in exactly
 * one worktree. This module transfers that ownership away from a checkout this
 * plugin manages, without ever sharing a branch or changing a commit, file or ref.
 */
export interface ReleaseDependencies {
  /** Guarded Git engine bound to the caller's authority and sandbox. */
  git: Pick<GitOperations, 'branchHolders' | 'releaseCheckout' | 'discover'>;
  recordFor(checkoutRoot: string): WorktreeRecord | undefined;
  /** Refuse a holder that is not a ready, unblocked record of this repository. */
  ready(record: WorktreeRecord): void;
  putRecord(record: WorktreeRecord): Promise<void>;
  noteStatus(id: string, state: CheckoutState): void;
  /** Claim the holder roots with the existing Local idle/fence machinery. */
  withClaims<T>(roots: readonly string[], task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

function canonical(holder: WorktreeBranchHolder): string { return holder.canonical ?? holder.root; }

/** Every checkout of this repository other than the primary that holds a branch. */
async function branchOwners(git: ReleaseDependencies['git'], repository: RepositoryInfo, signal: AbortSignal): Promise<WorktreeBranchHolder[]> {
  return (await git.branchHolders(repository.root, signal)).filter(holder => holder.branch !== null && canonical(holder) !== repository.root);
}

function describe(holder: WorktreeBranchHolder, record: WorktreeRecord | undefined): BranchHolder {
  return { branch: holder.branch!, root: canonical(holder), managed: record !== undefined, ...(record === undefined ? {} : { worktreeId: record.id, ...(record.displayName === undefined ? {} : { displayName: record.displayName }) }) };
}

/** Read-only ownership facts for a recovery chooser; never mutates a checkout. */
export async function readBranchHolders(deps: Pick<ReleaseDependencies, 'git' | 'recordFor'>, repository: RepositoryInfo, signal: AbortSignal): Promise<BranchHolder[]> {
  return (await branchOwners(deps.git, repository, signal))
    .map(holder => describe(holder, holder.canonical === null ? undefined : deps.recordFor(holder.canonical)));
}

/**
 * Validate every holder first, claim all holder roots, then transfer each branch
 * binding. A refusal mutates nothing; a verified release never changes a ref,
 * file or commit, so there is nothing to roll back.
 */
export async function releaseManagedBranch(deps: ReleaseDependencies, input: { repository: RepositoryInfo; branch: string; signal: AbortSignal }): Promise<ReleasedBranchHolder[]> {
  const holders = (await branchOwners(deps.git, input.repository, input.signal)).filter(holder => holder.branch === input.branch);
  if (holders.length === 0) return [];
  const selected: { root: string; record: WorktreeRecord; preferred: string | null }[] = [];
  for (const holder of holders) {
    if (holder.canonical === null) throw new WorktreeError('HOLDER_NOT_READY', `A checkout holding this branch is unavailable at ${holder.root}; inspect it before releasing the branch.`);
    const record = deps.recordFor(holder.canonical);
    if (record === undefined) throw new WorktreeError('BRANCH_HELD_OUTSIDE_PLUGIN', `This branch is checked out by a worktree the plugin does not manage: ${holder.canonical}`);
    deps.ready(record);
    selected.push({ root: holder.canonical, record: { ...record }, preferred: record.branch !== null && record.branch !== input.branch ? record.branch : null });
  }
  return deps.withClaims(selected.map(entry => entry.root), async signal => {
    const released: ReleasedBranchHolder[] = [];
    for (const entry of selected) {
      const state = await deps.git.releaseCheckout({ repository: input.repository, checkoutRoot: entry.root, branch: input.branch, preferred: entry.preferred, signal });
      const next: WorktreeRecord = { ...entry.record, branch: state.branch };
      await deps.putRecord(next);
      deps.noteStatus(next.id, state);
      released.push({ worktreeId: next.id, checkoutRoot: next.checkoutRoot, head: state.head, previousBranch: input.branch, branch: state.branch });
    }
    return released;
  });
}
