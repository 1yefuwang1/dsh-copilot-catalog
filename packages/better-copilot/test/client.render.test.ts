import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent';

interface LocaleDict { [key: string]: string }
interface Selection { provider: string; model: string; reasoningEffort?: string }
interface SessionsState { byId: Record<string, { origin?: string } | undefined> }
interface BadgeProps {
  sessionId: string;
  useSessions: <T>(select: (state: SessionsState) => T) => T;
  useProjection: (key: string) => unknown;
  t: (key: string, params?: Record<string, string | number>) => string;
}
interface ClientModule { id: string; factory: (require: (id: string) => unknown) => unknown }
interface ClientFactoryResult {
  inject: string[];
  apply(ctx: {
    effect(factory: () => () => void): () => void;
    locale: { register(namespace: string, dictionaries: Record<string, LocaleDict>): () => void };
    slots: {
      inject(name: string, callback: () => () => void): () => void;
      register(options: { name: string; id?: string; order?: number; locale?: string }, component: unknown): () => void;
    };
  }): void;
  renderTest: {
    SubagentModelBadge: React.ComponentType<BadgeProps>;
    subagentBadge(selection: Selection, t: BadgeProps['t']): { label: string; title: string; aria: string };
    readSelection(value: unknown): Selection | null;
    selectedOf(view: unknown): Selection | null;
    en: LocaleDict;
    zh: LocaleDict;
  };
}

const high: Selection = { provider: 'github-copilot', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
const marker = /^[ \t]*inject:/gm;
assert.equal([...source.matchAll(marker)].length, 1, 'the client factory has exactly one export seam');
let loaded: ClientModule | undefined;
vm.runInNewContext(
  source.replace(marker, 'renderTest: { SubagentModelBadge, subagentBadge, readSelection, selectedOf, en, zh },\n$&'),
  { window: { __ModuleLoader__: { load(value: ClientModule) { loaded = value; } } } },
  { filename: 'client.js' },
);
assert.ok(loaded !== undefined);
const definition: ClientModule = loaded;
assert.equal(definition.id, 'dsh-better-copilot');
const factory = definition.factory((name: string) => {
  assert.equal(name, 'react');
  return React;
}) as ClientFactoryResult;
const real = factory.renderTest;

/** Detach a value created inside the VM realm before strict structural comparison. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function translate(dict: LocaleDict): BadgeProps['t'] {
  return (key, params) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''));
}

const t = translate(real.en);

function props(overrides: Partial<BadgeProps> = {}): BadgeProps {
  return {
    sessionId: 'child',
    useSessions: (select) => select({ byId: { child: { origin: 'subagent' } } }),
    useProjection: () => ({ lastUsed: null, next: high }),
    t,
    ...overrides,
  };
}

function render(overrides: Partial<BadgeProps> = {}): string {
  return renderToStaticMarkup(React.createElement(real.SubagentModelBadge, props(overrides)));
}

test('a subagent route renders as read-only muted text with a fixed-route explanation', () => {
  const markup = render();
  assert.match(markup, /^<span /u);
  assert.match(markup, /gpt-6\.1-sol · high/u);
  assert.match(markup, /title="github-copilot\/gpt-6\.1-sol · high — Model and effort are fixed/u);
  assert.match(markup, /aria-label="Subagent model gpt-6\.1-sol from github-copilot, reasoning effort high\./u);
  assert.doesNotMatch(markup, /<button|<a |tabindex|role=|onclick/iu);
});

test('ordinary sessions keep their editable composer route and render no badge', () => {
  assert.equal(render({ useSessions: (select) => select({ byId: { parent: { origin: 'session' } } }) }), '');
});

test('a child without a completed request renders nothing', () => {
  assert.equal(render({ useProjection: () => undefined }), '');
  assert.equal(render({ useProjection: () => ({ lastUsed: null, next: null }) }), '');
});

test('a malformed projection never reaches the header', () => {
  assert.equal(render({ useProjection: () => ({ next: { provider: '', model: 42 } }) }), '');
  assert.equal(render({ useProjection: () => 'selection' }), '');
  assert.equal(real.readSelection({ provider: 'github-copilot' }), null);
  assert.deepEqual(plain(real.readSelection(high)), high);
});

test('an adapter-defaulted effort renders as default without inventing a level', () => {
  const markup = render({ useProjection: () => ({ next: { provider: 'github-copilot', model: 'gpt-6.1-sol' } }) });
  assert.match(markup, /gpt-6\.1-sol · default/u);
  assert.match(markup, /title="github-copilot\/gpt-6\.1-sol — /u);
  assert.match(markup, /reasoning effort default\./u);
});

test('the settled selection is used when the projection carries no pending route', () => {
  const markup = render({ useProjection: () => ({ lastUsed: high, next: null }) });
  assert.match(markup, /gpt-6\.1-sol · high/u);
  assert.deepEqual(plain(real.selectedOf({ lastUsed: high, next: { provider: 'deepseek-account', model: 'deepseek-flash' } })), { provider: 'deepseek-account', model: 'deepseek-flash' });
});

test('the rc.3 host projection retains the next wire field for pending and settled child routes', () => {
  const projection = modelSelectionProjectionDefinition;
  for (const raw of [{ lastUsed: null, pending: high }, { lastUsed: high, pending: null }]) {
    const state = projection.stateSchema.parse(raw);
    const view = projection.wire.viewSchema.parse(projection.wire.view(state));
    assert.deepEqual(view.next, high);
    assert.equal(Object.hasOwn(view, 'pending'), false, 'internal state must not become the client contract');
    assert.match(render({ useProjection: (key) => {
      assert.equal(key, 'modelSelection');
      return view;
    } }), /gpt-6\.1-sol · high/u);
  }
  const empty = projection.stateSchema.parse({ lastUsed: null, pending: null });
  assert.equal(render({ useProjection: () => projection.wire.view(empty) }), '');
});

test('a nested child reads only its own projected route', () => {
  const child = { provider: 'github-copilot', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
  const view = modelSelectionProjectionDefinition.wire.view(
    modelSelectionProjectionDefinition.stateSchema.parse({ lastUsed: null, pending: child }),
  );
  const markup = render({
    sessionId: 'grandchild',
    useSessions: (select) => select({ byId: {
      parent: { origin: 'session' }, child: { origin: 'subagent' }, grandchild: { origin: 'subagent' },
    } }),
    useProjection: () => view,
  });
  assert.match(markup, /gpt-6\.1-sol · high/u);
});

test('the badge formatter keeps the provider in the tooltip, not the inline label', () => {
  assert.deepEqual(plain(real.subagentBadge(high, t)), {
    label: 'gpt-6.1-sol · high',
    title: "github-copilot/gpt-6.1-sol · high — Model and effort are fixed for this subagent's lifetime.",
    aria: "Subagent model gpt-6.1-sol from github-copilot, reasoning effort high. Model and effort are fixed for this subagent's lifetime.",
  });
  assert.deepEqual(real.subagentBadge({ provider: 'deepseek-account', model: 'deepseek-flash' }, t).title.split(' — ')[0], 'deepseek-account/deepseek-flash');
});

test('apply registers one read-only header cell under the declared namespace', () => {
  const registrations: { options: { name: string; id?: string; order?: number; locale?: string }; component: unknown }[] = [];
  let dictionaries: { namespace: string; dictionaries: Record<string, LocaleDict> } | undefined;
  const ctx: Parameters<ClientFactoryResult['apply']>[0] = {
    effect: (effect) => {
      const dispose = effect();
      assert.equal(typeof dispose, 'function');
      return dispose;
    },
    locale: {
      register(namespace, value) {
        dictionaries = { namespace, dictionaries: value };
        return () => {};
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'conversation.session.header.actions');
        return callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  factory.apply(ctx);
  assert.deepEqual(plain(factory.inject), ['slots', 'locale']);
  assert.equal(registrations.length, 1);
  assert.deepEqual(plain(registrations[0]!.options), {
    name: 'conversation.session.header.actions',
    id: 'better-copilot-subagent-model',
    order: 15,
    locale: 'better-copilot.subagent',
  });
  assert.equal(registrations[0]!.component, real.SubagentModelBadge);
  assert.ok(dictionaries !== undefined);
  assert.equal(dictionaries.namespace, 'better-copilot.subagent');
  assert.deepEqual(Object.keys(dictionaries.dictionaries.en ?? {}).sort(), Object.keys(dictionaries.dictionaries.zh ?? {}).sort());
});

test('both registered locales carry a fixed-route explanation', () => {
  for (const dict of [real.en, real.zh]) {
    assert.equal(typeof dict['badge.defaultEffort'], 'string');
    assert.equal(typeof dict['badge.fixed'], 'string');
    assert.match(dict['badge.aria'] ?? '', /\{model\}/u);
    assert.match(dict['badge.aria'] ?? '', /\{provider\}/u);
    assert.match(dict['badge.aria'] ?? '', /\{effort\}/u);
  }
  assert.match(real.zh['badge.fixed'] ?? '', /固定/u);
});
