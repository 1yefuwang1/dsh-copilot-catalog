/// <reference path="./client.types.d.ts" />
/* Read-only subagent route badge for the Web conversation header.
 * The Host fixes a subagent's provider, model and reasoning effort when the
 * child is created, so this client half only presents them. It never renders a
 * selection control and writes nothing back to the Session.
 */
window.__ModuleLoader__.load({
  id: 'dsh-better-copilot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'better-copilot.subagent';
    const SLOT = 'conversation.session.header.actions';
    const ID = 'better-copilot-subagent-model';

    const en: BC.LocaleDict = {
      'badge.defaultEffort': 'default',
      'badge.fixed': "Model and effort are fixed for this subagent's lifetime.",
      'badge.aria': 'Subagent model {model} from {provider}, reasoning effort {effort}. {fixed}',
    };
    const zh: BC.LocaleDict = {
      'badge.defaultEffort': '默认',
      'badge.fixed': '该子智能体的模型与推理强度在创建时已固定。',
      'badge.aria': '子智能体模型 {model}（{provider}），推理强度 {effort}。{fixed}',
    };

    /** Validate one projected selection; anything malformed is not rendered. */
    function readSelection(value: unknown): BC.Selection | null {
      if (typeof value !== 'object' || value === null) return null;
      const candidate = value as Record<string, unknown>;
      const provider = typeof candidate.provider === 'string' ? candidate.provider : '';
      const model = typeof candidate.model === 'string' ? candidate.model : '';
      if (provider === '' || model === '') return null;
      const reasoningEffort = typeof candidate.reasoningEffort === 'string' && candidate.reasoningEffort !== ''
        ? candidate.reasoningEffort
        : undefined;
      return reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort };
    }

    /** Read the effective selection from the modelSelection wire view. */
    function selectedOf(view: unknown): BC.Selection | null {
      if (typeof view !== 'object' || view === null) return null;
      const projected = view as { lastUsed?: unknown; next?: unknown };
      return readSelection(projected.next) ?? readSelection(projected.lastUsed);
    }

    /** Compose the visible label, tooltip and accessible name for one route. */
    function subagentBadge(selection: BC.Selection, t: BC.Translate): BC.Badge {
      const explicit = selection.reasoningEffort;
      const effort = explicit === undefined ? t('badge.defaultEffort') : explicit;
      const route = explicit === undefined
        ? `${selection.provider}/${selection.model}`
        : `${selection.provider}/${selection.model} · ${explicit}`;
      return {
        label: `${selection.model} · ${effort}`,
        title: `${route} — ${t('badge.fixed')}`,
        aria: t('badge.aria', {
          provider: selection.provider,
          model: selection.model,
          effort,
          fixed: t('badge.fixed'),
        }),
      };
    }

    const badgeStyle: BC.CSSProperties = {
      display: 'inline-block',
      maxWidth: '26ch',
      overflow: 'hidden',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '12px',
      lineHeight: '18px',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
      verticalAlign: 'middle',
      cursor: 'default',
    };

    /** Read-only header cell: visible only for an addressed subagent's own route. */
    function SubagentModelBadge({ sessionId, useSessions, useProjection, t }: BC.BadgeProps): BC.Node {
      const subagent = useSessions((state) => state.byId[sessionId]?.origin === 'subagent');
      const view = useProjection('modelSelection');
      if (!subagent) return null;
      const selection = selectedOf(view);
      if (selection === null) return null;
      const badge = subagentBadge(selection, t);
      return h('span', { style: badgeStyle, title: badge.title, 'aria-label': badge.aria }, badge.label);
    }

    function apply(ctx: BC.Context): void {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }));
      ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: ID, order: 15, locale: NS }, SubagentModelBadge));
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
