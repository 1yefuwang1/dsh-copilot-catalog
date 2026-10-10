import { Config, apply, GitOperations as RootGitOperations, WorktreeError, ProjectController as RootProjectController, type WorktreeConfig as RootConfig, type CommandEnvelope, type ProjectRecord as RootProjectRecord } from 'dsh-worktrees';
import { ProjectController, parseProjectRequest, projectParameterSchema, resolveMainFolder, type ProjectRequest, type ProjectThreadBinding, type ProjectSnapshot, type ProjectStartResult, type ProjectRemoveResult } from 'dsh-worktrees/projects';
import { GitOperations } from 'dsh-worktrees/git';
import { NAMING_DEFAULTS, namingConfig, safeSlug } from 'dsh-worktrees/naming';
import type { WorktreeConfig, GitExecutor, GitRunSpec, GitRunResult, RepositoryInfo, RemoteBranches, CheckoutState, CreateCheckoutInput, CreatedCheckout, SnapshotInput, WorktreePreview, WorktreeRecord, SessionSettings, SessionResult, WorktreeRequest, WorktreeAction, OperationRecord, OperationPhase } from 'dsh-worktrees/types';
import type { Context } from '@deepseek-ai/cordis';

// Compile-only consumer of the exported declarations, never executed against Git.
declare const config: WorktreeConfig;
declare const repository: RepositoryInfo;
declare const record: WorktreeRecord;
declare const snapshotInput: SnapshotInput;
declare const session: SessionResult;
declare const settings: SessionSettings;
declare const operation: OperationRecord;
const rootConfig: RootConfig = config;
const defaultNamingModel: string = NAMING_DEFAULTS.namingModel;
const configuredNamingModel: string = namingConfig({ ...config, namingProvider: 'github-copilot', namingModel: 'gpt-6-luna', namingEnabled: true }).namingModel;
const generatedSlug: string = safeSlug('Fix parser races');
void [defaultNamingModel, configuredNamingModel, generatedSlug];
const typedApply: (ctx: Context, config: WorktreeConfig) => Promise<void> = apply;
const executor: GitExecutor = async (spec: GitRunSpec): Promise<GitRunResult> => {
  void [spec.cwd, spec.args, spec.signal, spec.timeoutMs, spec.maxBytes, spec.allowedExitCodes];
  return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
};
const git: RootGitOperations = new GitOperations(executor, rootConfig);
const branches: Promise<RemoteBranches> = git.branches(repository.root, 'upstream');
const status: Promise<CheckoutState> = git.status(record.checkoutRoot);
const createInput: CreateCheckoutInput = {
  id: record.id, repository, destination: record.checkoutRoot,
  remote: record.remote, remoteIdentity: record.remoteIdentity,
  remoteBranch: record.remoteBranch, baseRef: record.baseRef,
};
const created: Promise<CreatedCheckout> = git.create(createInput);
const preview: Promise<WorktreePreview> = git.snapshot(snapshotInput);
const phase: OperationPhase = operation.phase;
const action: WorktreeAction = 'create';
const request: WorktreeRequest = {
  action, operationId: operation.id, repoPath: repository.root,
  remote: record.remote, remoteIdentity: record.remoteIdentity,
  remoteBranch: record.remoteBranch, sourceSessionId: operation.sourceSessionId,
  sessionMode: 'new', requireBlankSource: true, settingsHash: settings.hash,
};
declare const projectRecord: RootProjectRecord;
declare const projectBinding: ProjectThreadBinding;
const projectControllerClass: typeof RootProjectController = ProjectController;
const projectQuery: ProjectRequest = { action: 'list', projectId: projectRecord.id };
const projectStart: ProjectRequest = { action: 'start', operationId: operation.id, projectId: projectRecord.id, folderId: projectRecord.folders[0]!.id };
const defaultProjectStart: ProjectRequest = { action: 'start', operationId: operation.id, projectId: projectRecord.id };
const projectRemove: ProjectRequest = { action: 'remove', projectId: projectRecord.id };
const removedProject: ProjectRemoveResult = { removed: true, projectId: projectRecord.id, scope: 'project-metadata' };
const ensuredFolder: ReturnType<ProjectController['ensureFolder']> = Promise.resolve(undefined);
// @ts-expect-error removal never accepts folder deletion flags
const invalidRemoval: ProjectRequest = { action: 'remove', projectId: projectRecord.id, deleteFolders: true };
void [projectRemove, removedProject, ensuredFolder, invalidRemoval];
const projectMainUpdate: ProjectRequest = { action: 'update', projectId: projectRecord.id, mainFolder: projectRecord.folders[0]!.path };
const projectMainCreate: ProjectRequest = { action: 'create', id: projectRecord.id, title: projectRecord.title, folders: projectRecord.folders.map(folder => folder.path), mainFolder: projectRecord.folders[0]!.path };
const legacyProject: RootProjectRecord = { id: projectRecord.id, title: projectRecord.title, folders: projectRecord.folders, createdAt: 1, updatedAt: 1 };
const mainFolderId: string | undefined = projectRecord.mainFolderId;
const resolvedMainId: string = resolveMainFolder(legacyProject).id;
void [defaultProjectStart, projectMainUpdate, projectMainCreate, mainFolderId, resolvedMainId];
const projectSnapshot: ProjectSnapshot = { projects: [projectRecord], bindings: [projectBinding] };
const localStart: ProjectStartResult = { sessionId: session.sessionId, workspaceId: projectBinding.folderId, binding: projectBinding };
void [projectControllerClass, projectQuery, projectStart, projectSnapshot, localStart, parseProjectRequest(projectQuery), projectParameterSchema];
const envelope: CommandEnvelope = { v: 1, ok: true, data: session };
const failure: CommandEnvelope = { v: 1, ok: false, error: { code: 'BUSY', message: 'Finish pending work first.' } };
const error = new WorktreeError('BUSY', 'Finish pending work first.', { phase });
const errorCode: string = error.code;

// @ts-expect-error physical deletion is not an exposed action
const invalidAction: WorktreeAction = 'delete';
// @ts-expect-error continuation modes are explicit
const invalidMode: WorktreeRequest = { action: 'start', sessionMode: 'reuse' };
// @ts-expect-error unknown envelope versions are not accepted
const invalidEnvelope: CommandEnvelope = { v: 2, ok: true, data: {} };
// @ts-expect-error executor results carry bytes and numeric exit codes
const invalidExecutor: GitExecutor = async () => ({ stdout: '', stderr: '', exitCode: '0' });
// @ts-expect-error Git operations require both an executor and the typed config
new GitOperations(executor);
void [Config, typedApply, git, branches, status, created, preview, request, envelope, failure, errorCode, invalidAction, invalidMode, invalidEnvelope, invalidExecutor];
