/** Conformance against the pinned PUBLIC browser entrypoints, not Host Context augmentations. */
import type { ConnectionHandle, ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client';
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ComposerBlocks, IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionStandardProps, SlotMap } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { CloudClientRuntime } from '../../client-model.js';
import type { CloudBlocks, CloudStore } from '../../client-blocks.js';

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
type Equal<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;
export type PublicServices = { connection: ConnectionHandle; sessions: ISessions; conversation: IConversation };
export type PublicRuntimeAccepted = Assert<Extends<PublicServices, CloudClientRuntime>>;
export type PublicBlocksAccepted = Assert<Extends<ComposerBlocks, CloudBlocks>>;
export type PublicGenerationIsNumber = Assert<Equal<ConnectionGeneration['id'], number>>;
export type PublicSnapshotAccepted = Assert<Extends<ObservableSnapshot<ConnectionGeneration | undefined>, CloudStore<{ readonly id: number } | undefined>>>;
export type HeaderSlotIsSessionList = Assert<Equal<Pick<SlotMap['conversation.session.header.actions'], 'kind' | 'scope'>, { kind: 'list'; scope: 'session' }>>;
export type BlankHeroIsSessionList = Assert<Equal<Pick<SlotMap['conversation.hero.options'], 'kind' | 'scope'>, { kind: 'list'; scope: 'session' }>>;
export type BlankCornerIsSessionSingle = Assert<Equal<Pick<SlotMap['conversation.session.header.corner'], 'kind' | 'scope'>, { kind: 'single'; scope: 'session' }>>;
export type NativeHeaderIdentityIsBranded = Assert<Equal<SessionStandardProps['sessionId'], SessionId>>;
export type MainSlotIsRootKeyed = Assert<Equal<Pick<SlotMap['main'], 'kind' | 'scope'>, { kind: 'keyed'; scope: 'root' }>>;
export type SettingsSlotIsRootKeyed = Assert<Equal<Pick<SlotMap['plugins.row.config'], 'kind' | 'scope'>, { kind: 'keyed'; scope: 'root' }>>;
export type PanelSlotIsRootList = Assert<Equal<Pick<SlotMap['sidebar.panellist'], 'kind' | 'scope'>, { kind: 'list'; scope: 'root' }>>;
/** Native slot ids already carry SessionId. Validated RPC ids cross a deliberate
 * browser DTO boundary as strings; this assertion does not brand arbitrary text. */
export type PublicOpenSessionAcceptsExactId = Assert<Extends<SessionId, Parameters<UiWorkspace['openSession']>[0]>>;
export type PublicOpenSessionRejectsUnvalidatedText = Assert<Equal<Extends<string, Parameters<UiWorkspace['openSession']>[0]>, false>>;
export type PublicFolderPicker = Assert<Equal<ReturnType<UiWorkspace['pickDirectory']>, Promise<string | null>>>;
