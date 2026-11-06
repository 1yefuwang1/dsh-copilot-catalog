/** Browser-only structural contracts for the read-only subagent route badge.
 * No server implementation or SDK module is imported at runtime.
 */
declare namespace BC {
  type React = typeof import('react');
  type Node = import('react').ReactNode;
  type CSSProperties = import('react').CSSProperties;
  type Component<P> = (props: P) => Node;
  type Translate = (key: string, params?: Record<string, string | number>) => string;
  type LocaleDict = Record<string, string>;

  interface Selection { provider: string; model: string; reasoningEffort?: string }
  interface Badge { label: string; title: string; aria: string }
  interface SessionSummary { origin?: string }
  interface SessionsState { byId: Record<string, SessionSummary | undefined> }

  interface BadgeProps {
    sessionId: string;
    useSessions: <T>(select: (state: SessionsState) => T) => T;
    useProjection: (key: string) => unknown;
    t: Translate;
  }

  interface SlotOptions { name: string; id?: string; order?: number; locale?: string }
  interface LocaleService {
    register(namespace: string, dictionaries: Record<string, LocaleDict>): () => void;
  }
  interface SlotsService {
    inject(name: string, callback: () => () => void): () => void;
    register<P>(options: SlotOptions, component: Component<P>): () => void;
  }
  interface Context {
    effect(factory: () => () => void): () => void;
    locale: LocaleService;
    slots: SlotsService;
  }
}

interface Window {
  __ModuleLoader__: {
    load(definition: {
      id: string;
      factory(require: (id: 'react') => BC.React): { inject: string[]; apply(ctx: BC.Context): void };
    }): void;
  };
}
