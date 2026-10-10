export interface WorktreeConfig {
  root: string;
  gitExecutable: string;
  defaultRemote: string;
  defaultBranch: string;
  commandTimeoutMs: number;
  fetchTimeoutMs: number;
  operationTimeoutMs: number;
  maxSnapshotBytes: number;
  maxFiles: number;
  maxRefBytes: number;
  namingEnabled?: boolean;
  namingProvider?: string;
  namingModel?: string;
  namingTimeoutMs?: number;
  namingMaxTokens?: number;
}

export type NamingFallbackReason = 'disabled' | 'unavailable' | 'timeout' | 'provider-failure' | 'invalid-output' | 'output-limit' | 'incomplete-output';
/** Safe, durable result of one auxiliary call; never stores task text or provider errors. */
export interface GeneratedWorktreeName {
  title: string;
  slug: string;
  directoryName: string;
  branch: string;
  source: 'model' | 'fallback';
  fallbackReason?: NamingFallbackReason;
}

/** Git execution is injected; production uses the managed subprocess/sandbox capabilities. */
export interface GitRunSpec {
  cwd: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /** Git's documented nonzero outcomes must be opted into per command. */
  allowedExitCodes?: readonly number[];
}
export interface GitRunResult { stdout: Buffer; stderr: Buffer; exitCode: number }
export type GitExecutor = (spec: GitRunSpec) => Promise<GitRunResult>;

export interface RepositoryInfo {
  root: string;
  commonDir: string;
  projectSubdir: string;
  head: string;
  branch: string | null;
}
export interface RemoteInfo { name: string; identity: string }
export interface RemoteBranch { name: string; oid: string }
export interface RemoteBranches {
  remote: string;
  remoteIdentity: string;
  defaultBranch: string | null;
  branches: RemoteBranch[];
  observedAt: number;
}
export interface CheckoutState {
  head: string;
  branch: string | null;
  dirty: boolean;
  changes: number;
  untracked: number;
}
/** Internal observation only; progress carries no caller authority or task data. */
export type SetupProgressStage = 'fetching' | 'creating' | 'naming' | 'opening' | 'ready';
export interface WorktreeSetupProgress {
  readonly stage: SetupProgressStage;
  readonly operationId: string;
  readonly worktreeId?: string;
}

export interface CreateCheckoutInput {
  id: string;
  repository: RepositoryInfo;
  destination: string;
  remote: string;
  remoteIdentity: string;
  remoteBranch: string;
  baseRef: string;
  signal?: AbortSignal;
  /** Observer failures are ignored; never used to authorize or change Git effects. */
  onProgress?: (stage: 'fetching' | 'creating') => void;
}
export interface CreatedCheckout {
  checkoutRoot: string;
  effectiveCwd: string;
  baseOid: string;
  baseRef: string;
  fetchedAt: number;
}
export interface PatchFile { path: string; status: string; binary: boolean }
export interface WorktreePreview {
  id: string;
  worktreeId: string;
  sourceSessionId: string;
  sourceHead: string;
  sourceFingerprint: string;
  sourceRoot: string;
  sourceCommonDir: string;
  targetCommonDir: string;
  finalTree: string;
  snapshotRoot: string;
  targetRoot: string;
  targetHead: string;
  baseOid: string;
  patchPath: string;
  patchHash: string;
  bytes: number;
  files: PatchFile[];
  createdAt: number;
}
export interface SnapshotInput {
  worktreeId: string;
  sourceSessionId: string;
  repositoryRoot: string;
  checkoutRoot: string;
  targetRoot: string;
  baseOid: string;
  snapshotRoot: string;
  signal?: AbortSignal;
}

/** One durable, source-log-bound naming opportunity; task text stays only in the session log. */
export interface FirstMessageNaming {
  sessionId: string;
  initialBranch: string;
  phase: 'waiting' | 'generating' | 'generated' | 'renaming' | 'complete' | 'skipped';
  messageSeq?: number;
  messageId?: string;
  messageHash?: string;
  generatedName?: GeneratedWorktreeName;
  reason?: string;
}

export interface WorktreeRecord {
  id: string;
  operationId: string;
  repoRoot: string;
  commonDir: string;
  projectSubdir: string;
  checkoutRoot: string;
  effectiveCwd: string;
  remote: string;
  remoteIdentity: string;
  remoteBranch: string;
  baseOid: string;
  baseRef: string;
  fetchedAt: number;
  createdAt: number;
  sessionIds: string[];
  workspaceId: string | null;
  branch: string | null;
  displayName?: string;
  naming?: GeneratedWorktreeName;
  firstMessageNaming?: FirstMessageNaming;
  /** Logical project membership; execution cwd and native Workspace stay independent. */
  projectId?: string;
  folderId?: string;
  protected: boolean;
  archived: boolean;
  state: 'creating' | 'ready' | 'recovery-required' | 'missing';
  error: string | null;
}
export type OperationPhase = 'planned' | 'fetching' | 'checkout-created' | 'session-created' | 'ready' | 'applying' | 'code-applied' | 'cancel-requested' | 'cancelled-before-effects' | 'recovery-required';
export interface SessionSettings {
  model: { provider: string; model: string; reasoningEffort?: string } | null;
  preset: string | null;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  approval: 'ask' | 'never';
  plan: boolean;
  hash: string;
}
export interface OperationRecord {
  id: string;
  kind: 'create' | 'handoff';
  requestHash: string;
  actorId: string;
  worktreeId: string;
  settingsHash: string;
  sourceSessionId: string;
  sessionMode: 'new' | 'continue';
  workspaceId: string | null;
  settings: SessionSettings;
  targetRoot: string | null;
  previewId: string | null;
  appliedHead: string | null;
  appliedFingerprint: string | null;
  generatedName?: GeneratedWorktreeName;
  /** Durable checkout-first inference intent; interrupted creates never infer again. */
  namingStarted?: boolean;
  phase: OperationPhase;
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  error: { code: string; message: string } | null;
}

export type WorktreeAction = 'list' | 'status' | 'branches' | 'create' | 'start' | 'branch' | 'protect' | 'preview' | 'export' | 'handoff' | 'archive';
export interface WorktreeRequest {
  action: WorktreeAction;
  repoPath?: string;
  id?: string;
  operationId?: string;
  remote?: string;
  remoteIdentity?: string;
  remoteBranch?: string;
  sourceSessionId?: string;
  sessionMode?: 'new' | 'continue';
  requireBlankSource?: boolean;
  settingsHash?: string;
  firstPrompt?: string;
  /** Pair on create; membership does not change execution or permission policy. */
  projectId?: string;
  folderId?: string;
  name?: string;
  protected?: boolean;
  archived?: boolean;
  previewId?: string;
  targetPath?: string;
  query?: string;
  cursor?: string;
  limit?: number;
  includeArchived?: boolean;
}
export type CommandEnvelope = { v: 1; ok: true; data: unknown } | { v: 1; ok: false; error: { code: string; message: string } };

/** Result of create/start/handoff; clients must open this exact session identity. */
export interface SessionResult {
  worktree: WorktreeRecord;
  sessionId: string;
  workspaceId: string;
  settingsHash: string;
  operation: OperationRecord;
}
