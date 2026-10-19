/** Browser-only public SDK structural contracts. No Host implementation imports. */
declare namespace AzureUI {
  type React = typeof import('react');
  type Node = import('react').ReactNode;
  type Dispose = () => void;
  interface Store<T> { getSnapshot(): T; subscribe(listener: () => void): Dispose }
  type Translate = (key: string, params?: Record<string, string | number>) => string;
  interface SessionEntry { origin?: string; retainedBy?: { mainView?: number }; blank?: boolean }
  interface Sessions { byId: Record<string, SessionEntry> }
  interface SlotOptions { name: string; id?: string; key?: string; order?: number; priority?: number; label?: () => string; locale?: string; inject?: () => object }
  interface Context {
    effect(factory: () => Dispose | (() => Promise<void>)): Dispose;
    connection: { rpc: { call(path: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }; generation: Store<{ id: number } | undefined> };
    conversation: { blocks: { storeFor(id: string): Store<{ reason: string } | undefined>; set(id: string, block: { reason: string } | undefined): void } };
    sessions: { list: Store<Sessions>; refresh(): Promise<void> };
    uiWorkspace: { openSession(id: string): void; pickDirectory?(): Promise<string | null> };
    layout: { selectPanel(id: string | null): void };
    locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): Dispose; bind(namespace: string): Translate };
    slots: { inject(name: string, factory: () => Dispose): Dispose; register<P>(options: SlotOptions, component: import('react').ComponentType<P>): Dispose; entries(name: string): readonly { readonly inject?: (...args: never[]) => unknown }[]; subscribe(name: string, listener: () => void): Dispose };
  }
  interface CommonProps { runtime: Context; cloud: import('./client-model.js').CloudClient; t: Translate }
  interface HeaderProps extends CommonProps { sessionId: string }
  interface SettingsProps extends CommonProps { view?: string }
  interface DialogProps { title: string; close(): void; t: Translate; children?: Node }
}
interface Window {
  __ModuleLoader__: { load(definition: { id: string; factory(require: (id: 'react') => AzureUI.React): { inject: string[]; apply(ctx: AzureUI.Context): void } }): void };
}
