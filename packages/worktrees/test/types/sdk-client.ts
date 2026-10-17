/**
 * Compile-only conformance between the shipped structural Client contracts and
 * the public client types of the installed DSH SDK. Nothing here runs; it exists
 * so a target upgrade that changes a consumed shape fails the type suite.
 *
 * The persistent browser factory keeps its module-None/Node10 build, so the
 * structural declarations stay import-free; only this NodeNext file imports the
 * real SDK surface.
 */
import type {
  ConversationController, DraftAttachmentId, InputState, SubmitOutcome,
} from '@deepseek-ai/dsh-client-ui-conversation/client';

/** Every comparison below must be true; a false one fails the build. */
type Assert<T extends true> = T;
/** A degraded (any) type would silently satisfy every comparison, so reject it. */
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? false : true;

/** The delivery mode and attachments the plugin forwards, derived from the real sink. */
type SdkSubmitMode = Parameters<ConversationController['sendSession']>[3];
type SdkAttachmentIds = Parameters<ConversationController['sendSession']>[2];

// Each compared type is checked on its own: a union would hide one degradation.
type SdkInputStateIsTyped = Assert<NotAny<InputState>>;
type SdkControllerIsTyped = Assert<NotAny<ConversationController>>;
type SdkAttachmentIdsIsTyped = Assert<NotAny<SdkAttachmentIds>>;
type SdkSubmitModeIsTyped = Assert<NotAny<SdkSubmitMode>>;
type SdkSubmitOutcomeIsTyped = Assert<NotAny<SubmitOutcome>>;
type SdkFileUploadsIsTyped = Assert<NotAny<ConversationController['fileUploads']>>;
type SdkAttachmentIdIsTyped = Assert<NotAny<DraftAttachmentId>>;

declare const sdkInputState: InputState;
declare const sdkAttachmentIds: SdkAttachmentIds;
declare const sdkSubmitMode: SdkSubmitMode;
declare const sdkOutcome: SubmitOutcome;
declare const sdkUploads: ConversationController['fileUploads'];

// SDK -> plugin: the published snapshot satisfies the plugin's read face.
const readFace: WT.InputSnapshot = sdkInputState;
// SDK -> plugin: ids, mode, uploads and outcome cross the lease unchanged.
const forwardedIds: WT.Draft['attachmentIds'] = sdkAttachmentIds;
const forwardedMode: WT.SubmitMode = sdkSubmitMode;
const forwardedUploads: WT.Conversation['fileUploads'] = sdkUploads;
const forwardedOutcome: WT.SubmitResult = sdkOutcome;
// Plugin -> SDK: the plugin's own submit result is a valid SDK outcome.
declare const pluginResult: WT.SubmitResult;
const acceptedOutcome: SubmitOutcome = pluginResult;

// Class-only members the plugin calls: the SDK's arguments must satisfy WT's
// declared parameters (the plugin forwards what the SDK produced).
type Parameters_<T> = T extends (...args: infer A) => unknown ? A : never;
type RebindAcceptsSdk = Assert<Parameters<ConversationController['rebindDraftFiles']> extends Parameters_<WT.Conversation['rebindDraftFiles']> ? true : false>;
type ResolveAcceptsSdk = Assert<Parameters<ConversationController['resolveDraftAttachments']> extends Parameters_<WT.Conversation['resolveDraftAttachments']> ? true : false>;
type SendParams = Parameters<ConversationController['sendSession']>;
type SendAcceptsSdkIds = Assert<SendParams[2] extends WT.Draft['attachmentIds'] ? true : false>;
type SendAcceptsSdkMode = Assert<SendParams[3] extends WT.SubmitMode ? true : false>;

// Forwarding direction: the plugin passes the SDK's own branded ids and exact modes
// back into the sink, never a widened string or an invented mode.
const sdkStateIds: SendParams[2] = sdkInputState.attachmentIds;
// @ts-expect-error a plain string is not a draft attachment id for the sink
const inventedIds: SendParams[2] = ['not-a-draft-id'];
// WT must neither widen nor narrow the mode union.
type WtModeAcceptedBySink = Assert<WT.SubmitMode extends SendParams[3] ? true : false>;
type SdkModeRepresentable = Assert<SendParams[3] extends WT.SubmitMode ? true : false>;
declare const wtModeValue: WT.SubmitMode;
const forwardedModeValue: SendParams[3] = wtModeValue;
type SendReturnsSdkOutcome = Assert<WT.SubmitResult extends SubmitOutcome ? true : false>;
// The SDK's resolved attachment descriptors satisfy WT's consumed result face.
declare const sdkResolved: ReturnType<ConversationController['resolveDraftAttachments']>;
const consumedResolved: ReturnType<WT.Conversation['resolveDraftAttachments']> = sdkResolved;

// The plugin must not silently accept a snapshot missing the queue it narrows on.
// @ts-expect-error a draft without the queue is not an InputSnapshot
const missingQueue: WT.InputSnapshot = { draft: '', draftRev: 0, attachmentIds: [], phase: 'plain' };
// If the brand degraded to any/unknown this directive would be unused and fail.
// @ts-expect-error plain strings are not branded draft attachment ids
const plainIds: SdkAttachmentIds = ['not-a-draft-id'];

void [readFace, forwardedIds, forwardedMode, forwardedUploads, forwardedOutcome, acceptedOutcome, missingQueue, plainIds,
  sdkStateIds, inventedIds, forwardedModeValue, consumedResolved];
void [null as unknown as SdkInputStateIsTyped, null as unknown as SdkControllerIsTyped, null as unknown as SdkAttachmentIdsIsTyped,
  null as unknown as SdkSubmitModeIsTyped, null as unknown as SdkSubmitOutcomeIsTyped, null as unknown as SdkFileUploadsIsTyped,
  null as unknown as SdkAttachmentIdIsTyped, null as unknown as RebindAcceptsSdk, null as unknown as ResolveAcceptsSdk,
  null as unknown as SendAcceptsSdkIds, null as unknown as SendAcceptsSdkMode, null as unknown as SendReturnsSdkOutcome,
  null as unknown as WtModeAcceptedBySink, null as unknown as SdkModeRepresentable];
