/** Public Host contract for same-session import placement; no session bootstrap or input submission. */
import type { Agent } from '@deepseek-ai/dsh-agent';

export const WORKTREE_IMPORT_CAPABILITY = 'worktreeImportPlacement';
export const WORKTREE_IMPORT_VERSION = 1;

export interface ImportCloudIdentity {
  readonly scope: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly headerHash: string;
  readonly inheritedEventCount: number;
  readonly eventCount: number;
  readonly chainHash: string;
}
export type ImportBaseSelection =
  | { readonly kind: 'local-branch'; readonly name: string; readonly oid: string }
  | { readonly kind: 'head'; readonly oid: string }
  | { readonly kind: 'commit'; readonly oid: string };
export interface ImportActorContext {
  /** Genuine current server-resolved ordinary Agent. Never constructed from request JSON. */
  readonly actor: Agent;
  readonly origin: 'ui' | 'command' | 'tool';
  readonly signal: AbortSignal;
}
export interface WorktreeImportRequest {
  readonly operationId: string;
  readonly target: ImportCloudIdentity;
  readonly intentId: string;
  readonly projectId: string;
  readonly folderId: string;
  readonly base: ImportBaseSelection;
  /** Unique bounded literal directories relative to checkout root; '' names root.
   * Header/current historical cwd geometry must be validated before Git effects.
   */
  readonly requiredDirectories?: readonly string[];
  readonly label?: string;
}
export interface WorktreeImportPlan extends WorktreeImportRequest {
  readonly requestHash: string;
  readonly actorId: string;
  readonly settingsHash: string;
  readonly worktreeId: string;
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly projectSubdir: string;
  readonly checkoutRoot: string;
  /** Must equal the immutable localized header cwd, not the replayed runtime cwd. */
  readonly effectiveCwd: string;
  readonly branch: string;
  readonly baseRef: string;
}
export interface WorktreeImportReceipt {
  readonly version: 1;
  readonly operationId: string;
  readonly requestHash: string;
  readonly target: ImportCloudIdentity;
  readonly intentId: string;
  readonly actorId: string;
  readonly worktreeId: string;
  readonly projectId: string;
  readonly folderId: string;
  /** Absent while only Git is prepared; created truthfully during verified binding. */
  readonly workspaceId?: string;
  readonly repoRoot: string;
  readonly commonDir: string;
  readonly checkoutRoot: string;
  readonly projectSubdir: string;
  readonly effectiveCwd: string;
  readonly baseOid: string;
  readonly baseRef: string;
  readonly branch: string;
  readonly revision: number;
}
/** A process-local proof. Public identity fields are NOT authority: implementations
 * MUST verify exact object issuer identity with the mandatory opaque runtime registry.
 * No package-private nominal brand is shared across independently compiled consumers.
 */
export interface VerifiedImportProof {
  readonly operationId: string;
  readonly sessionId: string;
  readonly intentId: string;
}
export interface BoundImportReceipt extends WorktreeImportReceipt {
  readonly workspaceId: string;
  readonly bound: true;
}
export type WorktreeImportPhase = 'reserved' | 'preparing' | 'prepared' | 'bound' | 'ready' | 'cancelled' | 'recovery-required' | 'reclaimed';
export interface WorktreeImportStatus {
  readonly operationId: string;
  readonly sessionId: string;
  readonly phase: WorktreeImportPhase;
  readonly receipt?: WorktreeImportReceipt;
  readonly reason?: string;
}
export interface PortableRemote { readonly name: string; readonly sanitizedUrl: string }
export type PortableCreationBase =
  | { readonly kind: 'remote'; readonly ref: string; readonly remote: PortableRemote; readonly oid: string }
  | { readonly kind: 'local'; readonly ref: string; readonly oid: string;
      readonly upstreamAtCreation?: { readonly ref: string; readonly remote: PortableRemote } }
  | { readonly kind: 'detached'; readonly oid: string };
export interface WorktreeSourceContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly commonDir: string;
  readonly provenance: 'original-checkout' | 'import-placement';
  readonly creationBase?: PortableCreationBase;
}

export interface ImportSourceFolder {
  readonly projectId: string; readonly folderId: string; readonly title: string; readonly path: string;
}
export interface ImportBaseChoices {
  readonly repoRoot: string; readonly commonDir: string; readonly projectSubdir: string;
  readonly objectFormat: 'sha1' | 'sha256'; readonly head: string;
  readonly branches: readonly { readonly name: string; readonly oid: string }[];
}
export interface LocalImportBinding {
  readonly operationId: string; readonly sessionId: string; readonly intentId: string;
  readonly projectId: string; readonly folderId: string; readonly cwd: string; readonly workspaceId: string;
}

/**
 * Optional service. Version negotiation precedes effects; unavailable never means fall back to Local.
 * Metadata commits revalidate durable reservations, native header/provenance and current local intent.
 */
export interface WorktreeImportPlacementV1 {
  readonly version: 1;
  folders(signal: AbortSignal): Promise<readonly ImportSourceFolder[]>;
  bases(projectId: string, folderId: string, context: ImportActorContext): Promise<ImportBaseChoices>;
  /** Canonical path classification must not disguise another managed checkout as Local. */
  classifyPath(path: string, sessionId: string, signal: AbortSignal): Promise<'local' | 'managed-self' | 'managed-other'>;
  bindLocalImported(binding: LocalImportBinding, proof: VerifiedImportProof, signal: AbortSignal): Promise<void>;
  /** Pure/local reads plus ephemeral ID planning only; no checkout, workspace or Session creation. */
  plan(request: WorktreeImportRequest, context: ImportActorContext): Promise<WorktreeImportPlan>;
  /** Checkout only: never SessionBootstrap.create, Agent creation, naming inference or a first prompt. */
  provision(plan: WorktreeImportPlan, context: ImportActorContext): Promise<WorktreeImportReceipt>;
  /** Native/project/sessionIds membership is mandatory; a boolean supplied by a client is not proof. */
  bindImported(receipt: WorktreeImportReceipt, proof: VerifiedImportProof, signal: AbortSignal): Promise<BoundImportReceipt>;
  /** Finish the cross-domain readiness handshake; no Git mutation or actor-settings copy. */
  acknowledgeReady(receipt: BoundImportReceipt, proof: VerifiedImportProof, signal: AbortSignal): Promise<void>;
  /** Metadata-only veto, accepted only after the independent guard durably stopped this exact intent. */
  suspend(operationId: string, sessionId: string, intentId: string, signal: AbortSignal): Promise<void>;
  inspect(operationId: string, signal: AbortSignal): Promise<WorktreeImportStatus | undefined>;
  /** Exact SID/header/commonDir selection, never private domain access or inferred current upstream. */
  sourceContext(sessionId: string, cwd: string, signal: AbortSignal): Promise<WorktreeSourceContext | undefined>;
}

declare module '@deepseek-ai/cordis' {
  interface Context { readonly worktreeImportPlacement: WorktreeImportPlacementV1 }
}
