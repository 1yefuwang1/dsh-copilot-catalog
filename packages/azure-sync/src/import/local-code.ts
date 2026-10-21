/** Local checkout comparison only: no branch switching, file writes or Worktrees dependency. */
import { parseGitContext, type GitContext, type StoredGitContext } from '../git/context.js';
import { canonicalJson, sha256Hex } from '../sync/canonical.js';

export function localGitObservation(value: unknown): GitContext | undefined { return parseGitContext(value); }
/** Pin the actual receiving code state, not observation time/history or remote display hints. */
export function localGitFingerprint(local: GitContext | undefined): string {
  return sha256Hex(canonicalJson(local ? {
    schema: local.v, root: local.repository.root, objectFormat: local.repository.objectFormat, worktree: local.repository.worktree,
    branchRef: local.current.branchRef, headOid: local.current.headOid, detached: local.current.detached,
    unborn: local.current.unborn, dirty: local.current.dirty,
  } : { state: 'unavailable' }));
}
export function compareLocalCode(source: StoredGitContext | undefined, local: GitContext | undefined): { codeMismatch: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const sourceKnown = source?.v === 2 && !source.current.unborn && source.current.headOid !== undefined;
  const localKnown = local !== undefined && !local.current.unborn && local.current.headOid !== undefined;
  let codeMismatch = !sourceKnown || !localKnown;
  if (!sourceKnown) warnings.push('source-code-unverified');
  const sourceDirty = source?.v === 2 ? source.current.dirty : source?.dirty;
  if (sourceDirty === 'dirty') { codeMismatch = true; warnings.push('source-working-tree-dirty'); }
  else if (sourceDirty === 'unknown') { codeMismatch = true; warnings.push('source-working-tree-unknown'); }
  if (!localKnown) warnings.push('local-code-unverified');
  const localDirty = local?.current.dirty ?? 'unknown';
  warnings.push(localDirty === 'clean' ? 'local-working-tree-clean' : localDirty === 'dirty' ? 'local-working-tree-dirty' : 'local-working-tree-unknown');
  if (localDirty !== 'clean') codeMismatch = true;
  if (sourceKnown && localKnown && (source.repository.objectFormat !== local.repository.objectFormat || source.current.headOid !== local.current.headOid)) {
    codeMismatch = true; warnings.push('local-code-snapshot-mismatch');
  }
  const sourceRef = source?.v === 2 ? source.current.branchRef : source?.branch === undefined ? undefined : `refs/heads/${source.branch}`;
  const sourceDetached = source?.v === 2 ? source.current.detached : source?.detached;
  if (source && local && (sourceRef !== local.current.branchRef || sourceDetached !== local.current.detached)) warnings.push('local-branch-hint-differs');
  return { codeMismatch, warnings };
}
