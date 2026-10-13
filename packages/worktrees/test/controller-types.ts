import { WorktreeController } from '../dist/service.js';
import type { Invocation } from '../dist/service.js';
import { ProjectController } from '../dist/projects.js';
import type { ProjectInvocation, ProjectRequest, ProjectRecord, ProjectSnapshot, ProjectStartResult, ProjectRemoveResult, ProjectThreadBinding } from '../dist/projects.js';
import type { CheckoutState, LocalBranches, RemoteBranches, OperationRecord, RepositoryInfo, RemoteInfo, SessionResult, WorktreePreview, WorktreeRecord, WorktreeRequest } from '../dist/types.js';
import type { NamingConfig } from '../dist/naming.js';

type Page<T> = { items: T[]; nextCursor?: string };
type BranchPage = Page<LocalBranches['branches'][number]> & Partial<Pick<LocalBranches, 'branchSource' | 'currentBranch'> & Pick<RemoteBranches, 'remote' | 'remoteIdentity'>> & { defaultBranch: string | null; observedAt: number; branches?: never };
type RepositoryStatus = { repository: RepositoryInfo; projectPath: string; remotes: RemoteInfo[]; settingsHash: string; namingConfig: NamingConfig; defaults: { remote: string; branch: string } };
type WorktreeResponse<R extends WorktreeRequest> =
  R['action'] extends 'create' | 'start' | 'handoff' ? SessionResult :
  R['action'] extends 'preview' ? WorktreePreview :
  R['action'] extends 'export' ? { path: string; bytes: number; patchHash: string; patch?: string } :
  R['action'] extends 'list' ? Page<WorktreeRecord> :
  R['action'] extends 'branches' ? BranchPage :
  R['action'] extends 'protect' | 'branch' ? { worktree: WorktreeRecord; status?: CheckoutState } :
  R['action'] extends 'archive' ? { worktree: WorktreeRecord; scope: string; retained: string[] } :
  R['action'] extends 'status' ? R extends { operationId: string } ? { operation: OperationRecord; worktree?: WorktreeRecord; sessionId?: string; settingsHash: string } : R extends { id: string } ? { worktree: WorktreeRecord; status: CheckoutState; settingsHash: string } : RepositoryStatus : unknown;

/** execute deliberately returns unknown publicly. This test-only overload records
 * the action-specific DTO contract being asserted without changing the controller. */
export class TypedWorktreeController extends WorktreeController {
  override execute<const R extends WorktreeRequest>(request: R, invocation: Invocation): Promise<WorktreeResponse<R>>;
  override execute(request: WorktreeRequest, invocation: Invocation): Promise<unknown> {
    return super.execute(request, invocation);
  }
}

type ProjectResponse<R extends ProjectRequest> =
  R['action'] extends 'list' ? ProjectSnapshot & { records: WorktreeRecord[] } :
  R['action'] extends 'create' | 'update' ? { project: ProjectRecord } :
  R['action'] extends 'bind' ? { binding: ProjectThreadBinding } :
  R['action'] extends 'start' ? ProjectStartResult :
  R['action'] extends 'remove' ? ProjectRemoveResult : unknown;
export class TypedProjectController extends ProjectController {
  override execute<const R extends ProjectRequest>(request: R, invocation: ProjectInvocation): Promise<ProjectResponse<R>>;
  override execute(request: ProjectRequest, invocation: ProjectInvocation): Promise<unknown> {
    return super.execute(request, invocation);
  }
}

/** Deliberate malformed-input tests must reach runtime validation unchanged. */
export function malformedWorktreeRequest(value: unknown): WorktreeRequest { return value as WorktreeRequest; }
export function malformedProjectRequest(value: unknown): ProjectRequest { return value as ProjectRequest; }

/** Partial, mutable host capability doubles intentionally omit most Agent/Context
 * methods. Keep this escape hatch at the dynamic host boundary, not API DTOs. */
export type HostDouble = any;
