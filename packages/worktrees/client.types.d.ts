/** Browser-only structural contracts for the persistent client factory.
 * No server implementation or SDK module is imported at runtime. RPC payloads
 * enter as unknown and are checked in client.ts before these types are returned.
 */
declare namespace WT {
  type React = typeof import('react');
  type Node = import('react').ReactNode;
  type Component<P = SlotProps> = import('react').ComponentType<P>;
  type Dispose = () => void;
  type Listener = () => void;
  interface Store<T> { getSnapshot(): T; subscribe(listener: Listener): Dispose }
  type SelectorHook<T> = <R>(select: (snapshot: T) => R) => R;
  type Translate = (key: string, params?: WTStringMap<string | number>) => string;
  interface Failure { code: string; message: string }
  interface Cleanup {
    phase: 'deferred' | 'planned' | 'preserving' | 'removing' | 'collected' | 'recovery-required';
    inactivityDays: number; lastActivityAt: number | null; eligibleAfter: number | null;
    reclaimedAt: number | null; originalFolder: string | null; recoveryRef: string | null; reason: Failure | null;
  }
  interface Branch { name: string; oid: string }
  interface Repository { root: string; head: string; branch: string | null; commonDir?: string }
  interface RecoveryInfo {
    sourceSessionId: string; worktreeId: string | null; cleanup: Cleanup | null;
    continuationSessionId: string | null; pendingSessionId?: string;
    originalFolder: string | null; repository?: Repository & { commonDir: string };
    branches?: Branch[]; nextCursor?: string; observedAt?: number; revision: number; recoveredBranch?: string | null;
  }
  interface RecoveryResult {
    sourceSessionId: string; sessionId: string; workspaceId: string; worktreeId: string;
    cwd: string; branch: string | null; cleanup: Cleanup;
  }
  interface RecoveryInfoRequest { action: 'reopen-info'; sourceSessionId: string; cursor?: string; limit?: number; after?: number }
  interface RecoveryResumeRequest { action: 'reopen'; sourceSessionId: string; localBranch: string; localOid: string }
  type RecoveryRequest = RecoveryInfoRequest | RecoveryResumeRequest;
  type RecoveryReply<R extends RecoveryRequest> = R extends RecoveryInfoRequest ? RecoveryInfo : RecoveryResult;
  interface Naming { title: string; slug: string; directoryName: string; branch: string; source: 'model' | 'fallback'; fallbackReason?: string }
  interface Record {
    id: string; operationId: string; effectiveCwd: string; remote: string; remoteBranch: string;
    baseOid: string; sessionIds: string[]; branch: string | null; protected: boolean; archived: boolean;
    state: 'creating' | 'ready' | 'recovery-required' | 'missing'; cleanup?: Cleanup;
    displayName?: string; naming?: Naming; error?: string | null;
  }
  interface Operation { id: string; phase: string; error: Failure | null; generatedName?: Naming; workspaceId?: string | null; settingsHash?: string }
  interface Checkout { dirty: boolean; head: string; changes?: number; untracked?: number }
  interface RepositoryReply { settingsHash: string; repository: Repository; remotes: { name: string; identity: string }[]; projectPath?: string; defaults?: { remote?: string; branch?: string } }
  interface OperationReply { settingsHash: string; operation: Operation; sessionId?: string; worktree?: Record }
  interface CheckoutReply { settingsHash: string; worktree: Record; status: Checkout | null }
  interface Branches {
    branchSource?: 'local' | 'remote'; currentBranch?: string | null; remote?: string;
    remoteIdentity?: string; items: readonly Branch[]; observedAt: number; defaultBranch: string | null; nextCursor?: string;
  }
  interface ListReply { items: Record[]; nextCursor?: string }
  interface SessionResult { sessionId: string; workspaceId: string; settingsHash: string; worktree: Record; operation: Operation }
  interface Preview { id: string; worktreeId: string; sourceSessionId: string; targetRoot: string; baseOid: string; patchHash: string; patchPath: string; bytes: number; files: { path: string; status: string; binary: boolean }[] }
  interface Export { path: string; patchHash: string; bytes: number; patch?: string }
  interface WorktreeRequest {
    action: 'list' | 'status' | 'branches' | 'create' | 'start' | 'branch' | 'protect' | 'preview' | 'export' | 'handoff' | 'archive';
    repoPath?: string; id?: string; operationId?: string; branchSource?: 'local' | 'remote'; localBranch?: string;
    localOid?: string; remote?: string; remoteIdentity?: string; remoteBranch?: string; sourceSessionId?: string;
    sessionMode?: 'new' | 'continue'; requireBlankSource?: boolean; settingsHash?: string;
    firstPrompt?: string; projectId?: string; folderId?: string; name?: string; protected?: boolean; archived?: boolean;
    previewId?: string; targetPath?: string; query?: string; cursor?: string; limit?: number; includeArchived?: boolean;
  }
  type HostReply<R extends WorktreeRequest> = R extends { action: 'status'; operationId: string } ? OperationReply
    : R extends { action: 'status'; id: string } ? CheckoutReply
    : R extends { action: 'status' } ? RepositoryReply
    : R extends { action: 'branches' } ? Branches
    : R extends { action: 'list' } ? ListReply
    : R extends { action: 'create' | 'start' | 'handoff' } ? SessionResult
    : R extends { action: 'preview' } ? Preview
    : R extends { action: 'export' } ? Export
    : R extends { action: 'branch' | 'protect' | 'archive' } ? { worktree?: Record; sessionId?: string }
    : SessionResult | { worktree?: Record; sessionId?: string };
  interface ProgressStep { stage: 'fetching' | 'creating' | 'naming' | 'opening' | 'ready'; operationId: string; worktreeId?: string }
  interface Progress { operationId: string; revision: number; terminal: boolean; stages: ProgressStep[] }
  interface Folder { id: string; path: string; title: string }
  interface Project { id: string; title: string; folders: Folder[]; createdAt: number; updatedAt: number; imported?: boolean; mainFolderId?: string }
  interface ProjectBinding { sessionId: string; projectId: string; folderId: string; mode: 'local' | 'worktree'; effectiveCwd: string; worktreeId?: string; cleanup?: Cleanup }
  interface Metadata { projects: Project[]; bindings: ProjectBinding[]; records: Record[]; loading: boolean; error: string }
  interface ProjectList { projects: Project[]; bindings: ProjectBinding[]; records?: Record[] }
  interface ProjectRequest {
    action: 'list' | 'create' | 'update' | 'remove' | 'bind' | 'start'; projectId?: string; id?: string;
    title?: string; folders?: string[]; mainFolder?: string; folderId?: string; sessionId?: string; operationId?: string;
  }
  interface ProjectMutationResult { project?: Project; binding?: ProjectBinding; projectId?: string; sessionId?: string; workspaceId?: string; removed?: true; scope?: 'project-metadata' }
  type ProjectReply<R extends ProjectRequest> = R extends { action: 'list' } ? ProjectList : ProjectMutationResult;
  interface ProjectContext { project: Project; folder: Folder; binding: ProjectBinding }
  interface CapturedProject { projectId: string; folderId: string; path: string }
  interface Workspace { workspaceId: string; path: string; title: string; sessionIds: string[] }
  interface Workspaces { phase: string; items: Workspace[]; archivedSessionIds: string[]; pinnedSessionIds: string[] }
  interface SessionSnapshot {
    blank: boolean; subagent: unknown | null; openState: string; removed: boolean; running: boolean;
    promptAttempted: boolean; awaitingFirstTurn: boolean; pendingSubmissions: readonly unknown[];
    promptError?: { op?: string; error?: { code?: string } };
  }
  interface SessionListEntry { retainedBy?: { mainView?: number }; origin?: string; blank?: boolean; running?: boolean; title?: string; displayTitle?: string; updatedAt?: number }
  interface Sessions { byId: WTStringMap<SessionListEntry>; projectionsBySession?: WTStringMap<{ values: { subagentCatalog?: { id: string }[] } }> }
  interface SessionStatus { running?: boolean; pendingInteraction?: unknown; completionUnread?: boolean }
  type Statuses = ReadonlyMap<string, SessionStatus>;
  interface Draft { draft: string; draftRev: number; attachmentIds: string[]; phase: string }
  interface InputSnapshot extends Draft { queue: readonly unknown[] }
  interface Input { state: Store<InputSnapshot> }
  interface Scope { effect(factory: () => Dispose | (() => Promise<void>)): Dispose }
  interface Binding { ctx: Scope; session: Store<SessionSnapshot> }
  interface Reference { sessionId: string; ready: Binding | PromiseLike<Binding>; release(): void }
  interface Block { reason: string }
  interface Blocks { storeFor(id: string): Store<Block | undefined>; set(id: string, value: Block | undefined): void }
  interface BlockHandle { owned: Readonly<Block>; store: Store<Block | undefined>; release(): void }
  type SubmitResult = { kind: 'success' } | { kind: 'error'; text: string };
  type SubmitMode = string;
  interface Conversation {
    input: { for(scope: Scope): Input }; blocks: Blocks;
    resolveDraftAttachments(ids: string[]): { id: string; kind: string }[];
    fileUploads: Store<WTStringMap<{ status: string; message?: string }>>;
    rebindDraftFiles(sessionId: string, ids: string[]): void;
    sendSession(session: Store<SessionSnapshot>, text: string, ids: string[], mode: SubmitMode, signal: AbortSignal): Promise<SubmitResult>;
  }
  interface Listing { path: string; crumbs: { name: string; path: string }[]; entries: { name: string; path: string }[]; truncated?: boolean }
  interface UIWorkspace {
    pickDirectory?(): Promise<string | null>;
    listDirectory(path?: string, signal?: AbortSignal): Promise<Listing>;
    createDirectory(path: string, name: string): Promise<string>;
    openSession(id: string): Promise<void> | void;
    startSession(folderId: string): void;
  }
  interface ScannerState { listing: Listing | null; busy: boolean; error: unknown }
  interface Scanner { scan(path?: string): Promise<void>; dispose(): void }
  type AddMode = 'path' | 'native' | 'browse';
  type Picker = () => unknown | PromiseLike<unknown>;
  interface ProjectStore {
    store: Store<Metadata>; context(id: string): ProjectContext | undefined; refresh(): Promise<void>;
    mutate(request: ProjectRequest): Promise<ProjectMutationResult>;
    rememberRecords(records: readonly Record[]): void; rememberWorktree(result: SessionResult, captured?: CapturedProject): void;
    dispose(): void;
  }
  interface ProjectSubmitter { readonly pending: boolean; submit(title: string, folders: string[], selectedMain: string): Promise<ProjectMutationResult>; remove(): Promise<ProjectMutationResult> }
  interface Backing { mode: 'local' | 'worktree'; effectiveCwd: string; record?: Record }
  interface Row { id: string; session: SessionListEntry; title: string; context?: ProjectContext; backing: Backing; archived: boolean; pinned: boolean; running: boolean; pending?: unknown; done: boolean }
  interface Group { project: Project | null; rows: Row[] }
  type RowState = 'idle' | 'warning' | 'ongoing' | 'done';
  interface RecoveryState {
    sessionId?: string; info: RecoveryInfo | null; branches: RecoveryBranch[]; selected: Branch | null; query: string;
    checked: boolean; loading: boolean; paging: boolean; busy: boolean; error: string; foreignBlock: boolean;
    cancelled: boolean; draftHistoryId?: string;
  }
  interface RecoveryBranch extends Branch { current: boolean; retained: boolean }
  interface RecoveryOperation { id: string; generation: string | number; sequence: number; controller: AbortController; watch: AbortController | null; page: AbortController | null; action: AbortController | null }
  interface RecoveryBlock { source: Store<Block | undefined>; handle: BlockHandle | null; acquiring: boolean; unsubscribe: Dispose }
  interface RecoveryStore { store: Store<RecoveryState>; refresh(): Promise<void>; more(): Promise<void>; resume(): Promise<void>; setQuery(query: string): void; choose(name: string): boolean; cancel(): void; retry(): Promise<void> | undefined; openTarget(): Promise<void> | undefined; openPermissions(): Promise<void> | undefined; openHistory(): Promise<void> | void; dispose(): void }
  interface SettingsState { status: string; mode?: string; writable?: boolean; revision?: number; value?: { root?: unknown; cleanupEnabled?: unknown; cleanupInactivityDays?: unknown } }
  type SettingsOperation = { op: 'unset'; path: string[] } | { op: 'set'; path: string[]; value: unknown };
  interface SettingsForm { state?: SettingsState; mutate(operations: SettingsOperation[], expectedRevision: number): Promise<boolean> }
  interface RepositoryTarget { sessionId: string; binding: Binding; connection: string | number; project?: CapturedProject; path?: string }
  interface RepositoryState { target: RepositoryTarget | null; phase: 'idle' | 'checking' | 'ready' | 'unavailable'; available: boolean; status: RepositoryReply | null }
  interface RepositoryAvailability { store: Store<RepositoryState>; ensure(id?: string): Promise<void>; withdraw(id: string): void; unavailable(id: string, binding: Binding, project?: CapturedProject): void; enabled(id?: string): boolean; dispose(): void }
  interface Source { binding: Binding; input: Input; project?: CapturedProject }
  interface Intent { branchSource: 'local' | 'remote'; branchOid: string; remote: string; branch: string; branches: Readonly<Branches> | null }
  interface WorktreeOperation extends Source {
    mode: 'new'; id: string; sessionId: string; controller: AbortController; signal: AbortSignal; navigation: AbortSignal;
    intent: Readonly<Intent>; result: SessionResult | null; request: (WorktreeRequest & { action: 'create'; operationId: string }) | null;
    retryable: boolean; admission: 'none' | 'pending' | 'unknown' | 'refused' | 'success';
    reference: Reference | null; sourceReference: Reference | null; staged: boolean; block: BlockHandle;
    cleanup(): void; committing?: boolean; accepted?: boolean; sinkEntered?: boolean; text?: string; ids?: string[];
  }
  type Choice = { mode: 'local' } | WorktreeOperation;
  interface SinkHooks {
    capture(signal: AbortSignal, controller: AbortController): Choice;
    submit(choice: WorktreeOperation, text: string, ids: string[], mode: SubmitMode, signal: AbortSignal): Promise<SubmitResult>;
    settled(choice: Choice, error?: unknown): void;
    beforeLocal?(ids: string[], signal: AbortSignal): Promise<void>;
    error(error: unknown): string;
  }
  interface SinkToken { nativeSignal: AbortSignal; controller: AbortController; signal: AbortSignal; entered: boolean; finished: boolean; donePromise: Promise<void>; done(): void; choice: Choice; abort(): void }
  interface SinkLease { abi: string; cancelNew(): void; close(): Promise<void>; stopScope?: Dispose }
  interface FlowState {
    sessionId?: string; mode: 'local' | 'new'; sourceChanged: boolean; busy: boolean; loading: boolean; error: string;
    status: RepositoryReply | null; branchSource: 'local' | 'remote'; remote: string; branch: string; branchOid: string;
    branches: Branches | null; query: string; steps: ProgressStep[]; phase: string; failedAt?: string; op: WorktreeOperation | null;
  }
  interface Flow {
    store: Store<FlowState>; observe(id: string): void; select(id: string, mode: string): void;
    configure(id: string): Promise<void>; loadBranches(id: string, refresh?: boolean): Promise<void>;
    reconcile(id: string): Promise<void>; cancel(): void; setRemote(id: string, remote: string): void;
    setBranchSource(id: string, branchSource: string): void; setQuery(query: string): void; setBranch(branch: string): boolean;
    openTarget(id: string): Promise<void>; dispose(): Promise<void>;
  }
  interface SidebarMode { store: Store<boolean>; toggle(): void; dispose(): void }

  /** Slots are an open extension registry: foreign plugin props/injectors are
   * runtime-defined. These are the only intentionally dynamic UI contracts.
   * Keep host services, protocol payloads and owned components typed separately.
   */
  type DynamicSlotProps = { [key: string]: unknown };
  type DynamicInjector = (...args: unknown[]) => DynamicSlotProps;
  interface ChildSlotSpec {
    kind: 'single' | 'list'; scope: 'root';
    inject?: { hooks: { menuOpenState(standard: unknown, state: unknown): () => unknown; shortcuts: unknown } };
  }
  interface SlotEntry {
    component: Component<SlotProps>; children?: WTStringMap<unknown>;
    options: SlotOptions; inject?: DynamicInjector; locale?: unknown; store?: unknown; select?: unknown;
  }
  interface SlotOptions { name: string; id?: string; key?: string; priority?: number; order?: number; label?: () => string; locale?: unknown; children?: WTStringMap<unknown>; inject?: DynamicInjector; store?: unknown; select?: unknown }
  type RenderSlot = (key: string, owner?: object, options?: object) => Node;
  interface SlotProps extends DynamicSlotProps { renderSlot: RenderSlot; renderSlotChain?: RenderSlot }
  interface Context extends Scope {
    connection: { rpc: { call(path: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }; generation: Store<{ id: string | number } | undefined> };
    sessions: { list: Store<Sessions>; refresh(): Promise<void>; binding(id: string | undefined): Binding | undefined; retain(id: string, options: { source: 'controllerOperation'; signal?: AbortSignal }): Reference; retainInfo(id: string): Store<{ retainedBy: { mainView?: number } }> };
    conversation: Conversation; get(name: 'conversation'): Conversation;
    workspaces: { list: Store<Workspaces> }; uiWorkspace: UIWorkspace;
    uiSession: { sessionStatus: Store<Statuses> }; layout: { beginNavigation(): AbortSignal; selectPanel(id: string | null): void };
    locale: { bind(namespace: string): Translate; register(namespace: string, dictionaries: WTStringMap<WTStringMap<string>>): Dispose };
    shortcuts: { catalog: unknown };
    slots: { inject(name: string, factory: () => Dispose): Dispose; register<P>(options: SlotOptions, component: Component<P>): Dispose; entriesOfSlot(name: string): SlotEntry[]; subscribe(name: string, listener: Listener): Dispose };
  }
  interface CommonProps { runtime: Context; t: Translate; projects: ProjectStore; flow: Flow; repositories: RepositoryAvailability; recovery: RecoveryStore }
  interface SessionProps extends CommonProps { sessionId: string; useSession: SelectorHook<SessionSnapshot>; useInput: SelectorHook<InputSnapshot>; usePanelInfo: SelectorHook<{ activePanelId: string | null }>; useWorkspaces: SelectorHook<Workspaces> }
  interface SidebarProps extends CommonProps { wide: boolean; expandSidebar(): void; useWorkspaces: SelectorHook<Workspaces>; useSessions: SelectorHook<Sessions>; usePanelInfo: SelectorHook<{ activePanelId: string | null }>; useSessionStatus: SelectorHook<Statuses>; renderSlot: RenderSlot }
  interface ManagerProps extends CommonProps { useSessions: SelectorHook<Sessions>; usePanelInfo: SelectorHook<{ activePanelId: string | null }>; useSessionStatus: SelectorHook<Statuses> }
  type FocusRef = import('react').RefObject<HTMLElement | null>;
  interface DialogProps { title: string; close(): void; t: Translate; children?: Node; className?: string; compact?: boolean; dismissible?: boolean; initialFocus?: FocusRef; returnFocus?: FocusRef; fallbackFocus?: FocusRef; descriptionId?: string }
  interface EditorProps { project?: Project | null; runtime: Context; projects: ProjectStore; t: Translate; close(): void; returnFocus?: FocusRef; fallbackFocus?: FocusRef }
  interface ThreadProps { row: Row; selected: boolean; runtime: Context; metadata: Metadata; renderSlot: RenderSlot; t: Translate; now: number }
  interface GroupProps { group: Group; selectedId?: string; runtime: Context; metadata: Metadata; renderSlot: RenderSlot; t: Translate; searching: boolean; onManage(project: Project | null, trigger: HTMLElement): void; now: number }
  interface ToolbarProps { query: string; onQuery(value: string): void; archived: string; onArchived(value: string): void; onCreate(event: import('react').MouseEvent<HTMLButtonElement>): void; newProjectTrigger: import('react').RefObject<HTMLButtonElement | null>; t: Translate }
  interface CardProps { record: Record; runtime: Context; t: Translate; actorId?: string; list: Sessions; sessionStatuses: Statuses; onChanged(): void; onPreview(): void }
}

interface Window {
  __ModuleLoader__: { load(definition: { id: string; factory(require: (id: 'react') => WT.React): { inject: string[]; protocol: object; apply(ctx: WT.Context): void } }): void };
}
declare var __DSH_DIRECTORY_PICKER__: { pick(): unknown | PromiseLike<unknown> } | undefined;

// The Record domain interface intentionally uses WT.Record; maps use this alias
// to avoid shadowing TypeScript's generic Record utility inside the namespace.
interface WTStringMap<T> { [key: string]: T }
