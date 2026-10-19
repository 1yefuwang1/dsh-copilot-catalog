/// <reference path="./client.types.d.ts" />
import { createCloudClient, type CloudLocalView } from './client-model.js';
import type { CloudRequest, CloudMapping, CloudAuth } from './src/protocol.js';
import locale from './locale/en.json';
import { gitGuidance } from './src/git/guidance.js';
import type { GitFacts } from './src/git/sanitize.js';

/** Public SDK browser factory. React stays owned by the Host module loader. */
window.__ModuleLoader__.load({
  id: '@1yefuwang1/dsh-azure-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'azureSync.ui';
    const PANEL = 'dsh-azure-sync';
    type Cloud = ReturnType<typeof createCloudClient>;
    type Props = AzureUI.CommonProps;
    const css = `.dsh-az{font:inherit;color:inherit;line-height:1.5}.dsh-az *{box-sizing:border-box}.dsh-az button,.dsh-az input,.dsh-az select{font:inherit;color:inherit}.dsh-az button,.dsh-az input:not([type=checkbox]),.dsh-az select{background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:6px;padding:.4em .65em}.dsh-az button{cursor:pointer}.dsh-az button:disabled{opacity:.5;cursor:default}.dsh-az :focus-visible{outline:2px solid currentColor;outline-offset:2px}.dsh-az-row{display:flex;gap:.6em;align-items:center;flex-wrap:wrap}.dsh-az-field{display:flex;flex-direction:column;gap:.25em;margin:.65em 0}.dsh-az-field input,.dsh-az-field select{width:100%;min-width:0}.dsh-az-check{display:flex;gap:.5em;align-items:baseline}.dsh-az-card{border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;padding:1em;margin:.8em 0}.dsh-az-muted{opacity:.75}.dsh-az-notice{border-inline-start:3px solid currentColor;padding-inline-start:.8em}.dsh-az-panel{padding:1.25em;max-width:70em;margin:auto;overflow-wrap:anywhere}.dsh-az-backdrop{position:fixed;inset:0;background:#0008;z-index:1000;display:grid;place-items:center;padding:1em}.dsh-az-dialog{background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:10px;padding:1.25em;max-width:48em;width:100%;max-height:90vh;overflow:auto;box-shadow:0 10px 40px #0006}.dsh-az dl{display:grid;grid-template-columns:minmax(8em,auto) minmax(0,1fr);gap:.3em 1em}.dsh-az dd{margin:0;overflow-wrap:anywhere}.dsh-az summary{cursor:pointer}.dsh-az ul{padding-inline-start:1.25em}.dsh-az h2,.dsh-az h3{margin-top:.5em}.dsh-az [role=alert]{font-weight:600}`;
    function Styles() { return h('style', null, css); }
    function Button(props: import('react').ButtonHTMLAttributes<HTMLButtonElement>) { return h('button', { ...props, type: props.type ?? 'button' }); }
    function Field({ label, children }: { label: string; children?: AzureUI.Node }) { return h('label', { className: 'dsh-az-field' }, label, children); }
    function Check({ label, ...props }: { label: string } & import('react').InputHTMLAttributes<HTMLInputElement>) { return h('label', { className: 'dsh-az-check' }, h('input', { ...props, type: 'checkbox' }), label); }
    function Details({ entries }: { entries: [string, AzureUI.Node][] }) { return h('dl', null, ...entries.map(([name, value]) => h(React.Fragment, { key: name }, h('dt', null, name), h('dd', null, value)))); }
    function Dialog({ title, close, t, children }: AzureUI.DialogProps) {
      const id = React.useId(), root = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => { const before = document.activeElement; root.current?.focus(); return () => { if (before instanceof HTMLElement && before.isConnected) before.focus(); }; }, []);
      return h('div', { className: 'dsh-az dsh-az-backdrop' }, h(Styles), h('div', { className: 'dsh-az-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': id, tabIndex: -1, ref: root,
        onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } if (event.key === 'Tab') { event.stopPropagation(); const items = root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]'); if (!items?.length) { event.preventDefault(); return; } const first = items[0], last = items[items.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus(); } } } },
        h('div', { className: 'dsh-az-row' }, h('h2', { id }, title), h(Button, { onClick: close, 'aria-label': t('close') }, t('close'))), children));
    }
    interface Confirmation { title: string; warning: string; request: CloudRequest; acknowledge?: string }
    function Confirm({ value, close, accept, t }: { value: Confirmation; close(): void; accept(): void; t: AzureUI.Translate }) {
      const [checked, setChecked] = React.useState(false);
      return h(Dialog, { title: value.title, close, t }, h('p', { className: 'dsh-az-notice' }, value.warning),
        value.acknowledge && h(Check, { label: value.acknowledge, checked, onChange: event => setChecked(event.target.checked) }),
        h('div', { className: 'dsh-az-row' }, h(Button, { onClick: close }, t('cancel')), h(Button, { disabled: !!value.acknowledge && !checked, onClick: accept }, t('confirm'))));
    }
    /** View-scoped cancellation never disposes the runtime or clears composer blocks. */
    function useAction(cloud: Cloud, t: AzureUI.Translate, scope = '') {
      const active = React.useRef(new Map<string, AbortController>()), generation = React.useRef(0), alive = React.useRef(false), currentScope = React.useRef(scope);
      currentScope.current = scope;
      const [pending, setPending] = React.useState<string[]>([]), [error, setError] = React.useState(''), [message, setMessage] = React.useState('');
      const cancel = React.useCallback(() => { generation.current++; for (const controller of active.current.values()) controller.abort(); active.current.clear(); setPending([]); }, []);
      React.useEffect(() => { alive.current = true; generation.current++; setPending([]); setError(''); setMessage(''); return () => { alive.current = false; generation.current++; for (const controller of active.current.values()) controller.abort(); active.current.clear(); }; }, [scope]);
      async function run<R extends CloudRequest>(request: R, after?: (reply: Awaited<ReturnType<Cloud['request']>>) => void, preempt = false) {
        if (preempt) cancel();
        const key = request.action; if (active.current.has(key)) return;
        const controller = new AbortController(), epoch = generation.current;
        active.current.set(key, controller); setPending([...active.current.keys()]); setError(''); setMessage('');
        try { const reply = await cloud.request(request, controller.signal); if (!alive.current || epoch !== generation.current || currentScope.current !== scope || controller.signal.aborted) return; setMessage(t('saved')); after?.(reply); return reply; }
        catch { if (alive.current && epoch === generation.current && currentScope.current === scope && !controller.signal.aborted) setError(t('failed')); }
        finally { if (active.current.get(key) === controller) active.current.delete(key); if (alive.current && epoch === generation.current && currentScope.current === scope) setPending([...active.current.keys()]); }
      }
      return { run, cancel, pending, busy: pending.length > 0, error, message, setError };
    }
    function Feedback({ action, t }: { action: ReturnType<typeof useAction>; t: AzureUI.Translate }) { return h(React.Fragment, null,
      action.busy && h('p', { role: 'status', 'aria-live': 'polite' }, t('loading')),
      action.error && h('p', { role: 'alert' }, action.error), !action.busy && action.message && h('p', { role: 'status' }, action.message)); }
    function useCloud(cloud: Cloud) { return React.useSyncExternalStore(cloud.store.subscribe, cloud.store.getSnapshot); }
    function useThread(cloud: Cloud, sessionId: string) { useCloud(cloud); React.useLayoutEffect(() => cloud.watchSession(sessionId), [cloud, sessionId]); return cloud.getThread(sessionId); }
    function selectedNativeThread(list: AzureUI.Sessions): string | undefined {
      const ids = Object.keys(list.byId).filter(id => (list.byId[id]?.retainedBy?.mainView ?? 0) > 0 && list.byId[id]?.origin !== 'subagent');
      return ids.length === 1 ? ids[0] : undefined;
    }
    function Header(props: AzureUI.HeaderProps) {
      const list = React.useSyncExternalStore(props.runtime.sessions.list.subscribe, props.runtime.sessions.list.getSnapshot);
      return selectedNativeThread(list) === props.sessionId && list.byId[props.sessionId]?.blank !== true ? h(NativeHeader, { ...props, key: props.sessionId }) : null;
    }
    function BlankHero(props: AzureUI.HeaderProps) {
      const list = React.useSyncExternalStore(props.runtime.sessions.list.subscribe, props.runtime.sessions.list.getSnapshot);
      return selectedNativeThread(list) === props.sessionId && list.byId[props.sessionId]?.blank === true ? h(NativeHeader, { ...props, key: props.sessionId }) : null;
    }
    function BlankCorner(props: AzureUI.HeaderProps) {
      const list = React.useSyncExternalStore(props.runtime.sessions.list.subscribe, props.runtime.sessions.list.getSnapshot);
      return selectedNativeThread(list) === props.sessionId && list.byId[props.sessionId]?.blank === true ? h(CornerControl, { ...props, key: props.sessionId }) : null;
    }
    function CornerControl({ runtime, cloud, t, sessionId }: AzureUI.HeaderProps) {
      useThread(cloud, sessionId);
      const [open, setOpen] = React.useState(false);
      return h('span', { className: 'dsh-az' }, h(Styles), h(Button, { onClick: () => setOpen(true), 'aria-label': t('details'), 'aria-haspopup': 'dialog' }, t('cloud')),
        open && h(Dialog, { title: t('details'), close: () => setOpen(false), t }, h(Thread, { key: sessionId, runtime, cloud, t, sessionId })));
    }
    function incompleteImport(status: CloudLocalView | undefined): boolean {
      // Degraded is a fully verified log with an explicitly acknowledgeable
      // attachment/projection limitation, not an unfinished native artifact.
      if (status?.importState === 'degraded' && ['projection-warm-partial', 'projection-warm-failed'].includes(status.status)) return false;
      return !!status && ((status.importState !== undefined && !['complete', 'degraded'].includes(status.importState)) || ['importing', 'import-incomplete', 'import-race', 'projection-warm-partial', 'projection-warm-failed'].includes(status.status));
    }
    function NativeHeader({ runtime, cloud, t, sessionId }: AzureUI.HeaderProps) {
      const thread = useThread(cloud, sessionId), [open, setOpen] = React.useState(false), [confirm, setConfirm] = React.useState(false);
      const action = useAction(cloud, t, sessionId), enabled = thread?.status?.enabled === true && !thread.status.detached;
      const degraded = thread?.status?.importState === 'degraded' && !thread.status.degradedAcknowledged;
      React.useEffect(() => { setOpen(false); setConfirm(false); }, [sessionId]);
      return h('span', { className: 'dsh-az dsh-az-row' }, h(Styles), h(Check, { label: t('enabled'), 'aria-label': t('enabled'), checked: enabled,
        disabled: !enabled && (thread?.loading || action.busy || incompleteImport(thread?.status) || degraded), title: incompleteImport(thread?.status) ? t('incompleteWarning') : degraded ? t(thread?.status?.degradedAttachmentCount === 0 ? 'projectionDegradedWarning' : 'degradedWarning') : undefined, onChange: event => { if (event.target.checked) setConfirm(true); else void action.run({ action: 'toggle', sessionId, enabled: false }, undefined, true); } }),
        h(Button, { onClick: () => setOpen(true), 'aria-label': t('details'), title: t('details') }, t('cloud')),
        h(Button, { onClick: () => runtime.layout.selectPanel(PANEL), 'aria-label': t('settings') }, t('settings')),
        action.error && h('span', { role: 'alert' }, action.error),
        confirm && h(Confirm, { t, value: { title: t('enabled'), warning: t('onWarning'), request: { action: 'toggle', sessionId, enabled: true } }, close: () => setConfirm(false), accept: () => { setConfirm(false); void action.run({ action: 'toggle', sessionId, enabled: true }); } }),
        open && h(Dialog, { title: t('details'), close: () => setOpen(false), t }, h(Thread, { key: sessionId, runtime, cloud, t, sessionId })));
    }
    function GitSummary({ facts, t }: { facts: GitFacts; t: AzureUI.Translate }) {
      return h(Details, { entries: [[t('gitRoot'), facts.root], [t('gitBranch'), facts.branch ?? t(facts.detached ? 'gitDetached' : 'unknown')], [t('gitCommit'), facts.commit ?? t('gitUnborn')], [t('gitDirty'), t('git.' + facts.dirty)], [t('gitWorktree'), t(facts.worktree ? 'yes' : 'no')], ...(facts.remote ? [[t('gitRemote'), facts.remote] as [string, AzureUI.Node]] : [])] });
    }
    function GitAdvice(props: AzureUI.HeaderProps) {
      const { cloud, t, sessionId } = props, action = useAction(cloud, t, 'git:' + sessionId);
      const [facts, setFacts] = React.useState<GitFacts | null | undefined>();
      React.useEffect(() => { setFacts(undefined); }, [sessionId]);
      const advice = gitGuidance(facts ?? null, null);
      return h('details', { className: 'dsh-az-card' }, h('summary', null, t('gitTitle')), h('p', { className: 'dsh-az-notice' }, t('gitWarning')),
        h(Button, { disabled: action.busy, onClick: () => { void action.run({ action: 'git-info', sessionId }, reply => { if (reply.kind === 'git') setFacts(reply.local); }); } }, t('gitInspect')),
        facts === null && h('p', null, t('gitUnavailable')), facts && h(GitSummary, { facts, t }),
        facts && h('p', { className: 'dsh-az-muted' }, t('gitConservative')),
        advice.posix.length > 0 && h(React.Fragment, null, h('h3', null, 'POSIX'), h('pre', null, advice.posix.join('\n')), h('h3', null, 'PowerShell'), h('pre', null, advice.powershell.join('\n'))), h(Feedback, { action, t }));
    }
    function Thread({ runtime, cloud, t, sessionId }: AzureUI.HeaderProps) {
      const thread = useThread(cloud, sessionId), status = thread?.status, action = useAction(cloud, t, sessionId);
      const [confirmation, setConfirmation] = React.useState<Confirmation | null>(null), [exportPath, setExportPath] = React.useState('');
      React.useEffect(() => { setConfirmation(null); setExportPath(''); }, [sessionId]);
      const request = (value: CloudRequest, preempt = false) => { void action.run(value, reply => { if (reply.kind === 'action' && reply.detail && typeof reply.detail === 'object' && !Array.isArray(reply.detail) && typeof reply.detail.exportPath === 'string') setExportPath(reply.detail.exportPath); }, preempt); };
      const confirm = (name: string, warning: string, value: CloudRequest, acknowledge?: string) => setConfirmation({ title: t(name), warning: t(warning), request: value, ...(acknowledge ? { acknowledge: t(acknowledge) } : {}) });
      const busy = action.busy || !!thread?.pending, enabled = status?.enabled === true && !status.detached;
      const state = status?.status ?? 'local', incomplete = incompleteImport(status);
      let warning = '';
      if (status?.restartRequired) warning = 'liveWarning';
      else if (status?.mappingUnstable) warning = 'unstableWarning';
      else if (status?.needsFolder || ['needs-folder', 'unmappable-cwd', 'cwd-unmappable', 'ambiguous-mapping'].includes(state)) warning = 'folderWarning';
      else if (state === 'preset-missing') warning = 'presetWarning';
      else if (state === 'model-unavailable') warning = 'modelWarning';
      else if (state === 'conflict' || state === 'generation-changed') warning = 'conflictWarning';
      else if (incomplete) warning = 'incompleteWarning';
      const degraded = status?.importState === 'degraded' && !status.degradedAcknowledged;
      const projectionDegraded = degraded && status.degradedAttachmentCount === 0;
      return h('section', { className: 'dsh-az', 'aria-label': t('details') }, h(Styles), h(Details, { entries: [[t('thread'), sessionId], [t('state'), status ? state : t('untracked')], ...(status ? [[t('generation'), status.generation] as [string, AzureUI.Node]] : [])] }),
        thread?.loading && h('p', { role: 'status' }, t('loading')),
        thread?.error && h('p', { role: 'alert' }, t('failed')),
        warning && h('p', { role: 'alert', className: 'dsh-az-notice' }, t(warning)),
        incomplete && warning !== 'incompleteWarning' && h('p', { role: 'alert', className: 'dsh-az-notice' }, t('incompleteWarning')),
        degraded && h('p', { role: 'alert' }, projectionDegraded ? t('projectionDegradedWarning') : t('degradedWarning') + ' ' + t('degradedCount') + ': ' + status.degradedAttachmentCount),
        h('div', { className: 'dsh-az-row' },
          h(Check, { label: t('enabled'), 'aria-label': t('enabled'), checked: enabled,
            disabled: !enabled && (thread?.loading || busy || incomplete || degraded),
            title: incomplete ? t('incompleteWarning') : degraded ? t(projectionDegraded ? 'projectionDegradedWarning' : 'degradedWarning') : undefined,
            onChange: event => { if (event.target.checked) confirm('enabled', 'onWarning', { action: 'toggle', sessionId, enabled: true }); else request({ action: 'toggle', sessionId, enabled: false }, true); } }),
          h(Button, { onClick: () => { void cloud.refresh(sessionId); } }, t('refresh')),
          h(Button, { onClick: () => request({ action: 'toggle', sessionId, enabled: false }, true) }, t('off')),
          h(Button, { onClick: () => confirm('detach', incomplete ? 'detachIncompleteWarning' : 'detachWarning', { action: 'detach', sessionId }) }, t('detach')),
          h(Button, { disabled: busy, onClick: () => request({ action: 'sync', sessionId }) }, t('sync')),
          h(Button, { disabled: busy, onClick: () => request({ action: 'pull', sessionId }) }, t('pull')),
          h(Button, { disabled: busy, onClick: () => request({ action: 'check-ownership', sessionId }) }, t('ownership')),
          h(Button, { disabled: busy, onClick: () => confirm('takeover', 'takeoverWarning', { action: 'takeover', sessionId, confirm: true }) }, t('takeover')),
          h(Button, { disabled: busy, onClick: () => request({ action: 'export', sessionId }) }, t('export')),
          h(Button, { disabled: busy, onClick: () => confirm('remove', 'removeWarning', { action: 'remove', sessionId, confirm: true, acknowledgeAttachmentsRetained: true }, 'retainAck') }, t('remove')),
          h(Button, { disabled: busy, onClick: () => confirm('resurrect', 'resurrectWarning', { action: 'resurrect', sessionId, confirm: true }) }, t('resurrect')),
          h(Button, { disabled: busy || !!status?.restartRequired, onClick: () => status?.mappingUnstable || status?.needsFolder ? confirm('mappingRepair', 'mappingRepairWarning', { action: 'repair', sessionId, confirmMapping: true }) : request({ action: 'repair', sessionId }) }, t(status?.mappingUnstable || status?.needsFolder ? 'mappingRepair' : 'repair')),
          degraded && !incomplete && status.importState === 'degraded' && !status.admissionStopped && !status.mappingUnstable && !status.needsFolder && !status.restartRequired && h(Button, { disabled: busy, onClick: () => request({ action: 'acknowledge-degraded', sessionId }) }, t(projectionDegraded ? 'ackProjection' : 'ackDegraded')),
          h(Button, { onClick: () => runtime.layout.selectPanel(PANEL) }, t('settings')),
          action.busy && h(Button, { onClick: action.cancel }, t('stopAction'))),
        h(GitAdvice, { runtime, cloud, t, sessionId }),
        exportPath && h('p', { role: 'status' }, t('exportPath') + ': ', h('code', null, exportPath)), h(Feedback, { action, t }),
        confirmation && h(Confirm, { key: confirmation.request.action, value: confirmation, t, close: () => setConfirmation(null), accept: () => { const value = confirmation.request; setConfirmation(null); request(value, value.action === 'detach'); } }));
    }
    function Auth({ runtime, cloud, t }: Props) {
      const snapshot = useCloud(cloud), settings = snapshot.settings;
      const [auth, setAuth] = React.useState<CloudAuth>('auto'), [account, setAccount] = React.useState(''), [clientId, setClientId] = React.useState(''), [clear, setClear] = React.useState(false), [dirty, setDirty] = React.useState(false);
      const secret = React.useRef<HTMLInputElement>(null), action = useAction(cloud, t, 'auth');
      const erase = React.useCallback(() => { if (secret.current) secret.current.value = ''; }, []);
      React.useEffect(() => { if (!dirty && settings) { setAuth(settings.auth); setAccount(settings.accountName); setClientId(settings.managedIdentityClientId); } }, [settings, dirty]);
      React.useLayoutEffect(() => () => erase(), [erase]);
      React.useLayoutEffect(() => runtime.connection.generation.subscribe(erase), [runtime, erase]);
      const cancel = () => { action.cancel(); erase(); };
      async function save() {
        const request: Extract<CloudRequest, { action: 'set-auth' }> = { action: 'set-auth', auth, accountName: account.trim(), managedIdentityClientId: clientId.trim(), ...(clear ? { clearConnectionString: true } : secret.current?.value ? { connectionString: secret.current.value } : {}) };
        try { const pending = action.run(request, () => { setDirty(false); setClear(false); }); erase(); await pending; }
        finally { erase(); delete request.connectionString; }
      }
      return h('section', { className: 'dsh-az-card', 'aria-label': t('authTitle') }, h('h2', null, t('authTitle')),
        !settings && h('p', { role: 'status' }, t('loading')),
        settings?.authPending && h('p', { role: 'alert' }, t('authPending')),
        settings?.pendingAuth && h('p', { role: 'status' }, t('pendingTarget') + ': ' + settings.pendingAuth.auth + ' · ' + settings.pendingAuth.accountName + ' · ' + settings.pendingAuth.managedIdentityClientId),
        settings?.connection.requiresUpdate && h('p', { role: 'alert' }, t('uncertain')),
        settings && h(Details, { entries: [[t('secretPresence'), t(settings.connection.available === false ? 'unknown' : settings.connection.configured ? 'configured' : 'notConfigured')], [t('source'), settings.connection.source ?? t('unknown')], [t('writable'), t(settings.connection.writable ? 'yes' : 'no')]] }),
        settings && !settings.connection.writable && h('p', null, t('readOnlyCredential')),
        h('form', { autoComplete: 'off', onSubmit: event => { event.preventDefault(); void save(); } },
          h(Field, { label: t('auth') }, h('select', { value: auth, disabled: action.busy || !settings, onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => { setAuth(event.target.value as CloudAuth); setDirty(true); erase(); } }, ...(['auto', 'connection-string', 'azure-cli', 'managed-identity'] as const).map(value => h('option', { key: value, value }, t('auth.' + value))))),
          h(Field, { label: t('account') }, h('input', { value: account, maxLength: 24, pattern: '(?:[a-z0-9]{3,24})?', disabled: action.busy || !settings, onChange: event => { setAccount(event.target.value); setDirty(true); } })),
          h(Field, { label: t('clientId') }, h('input', { value: clientId, maxLength: 256, disabled: action.busy || !settings, onChange: event => { setClientId(event.target.value); setDirty(true); } })),
          h(Field, { label: t('credentialInput') }, h('input', { ref: secret, type: 'password', autoComplete: 'new-password', maxLength: 16384, disabled: action.busy || !settings?.connection.writable || clear, 'aria-label': t('credentialInput') })),
          h('p', { className: 'dsh-az-muted' }, t('secretHelp')),
          h(Check, { label: t('clearSecret'), checked: clear, disabled: action.busy || !settings?.connection.writable, onChange: event => { setClear(event.target.checked); erase(); } }),
          h('div', { className: 'dsh-az-row' }, h(Button, { type: 'submit', disabled: action.busy || !settings }, t('saveAuth')), h(Button, { disabled: action.busy, onClick: () => { erase(); void action.run({ action: 'test-auth' }); } }, t('testAuth')), h(Button, { onClick: cancel }, t('cancel')))),
        settings && h('details', null, h('summary', null, t('admin')), h(Details, { entries: [[t('connectionRef'), settings.connectionRef], [t('container'), settings.container], [t('table'), settings.table], [t('suffix'), settings.endpointSuffix]] })), h(Feedback, { action, t }));
    }
    function Preferences({ cloud, t }: Props) {
      const { settings } = useCloud(cloud), [startup, setStartup] = React.useState(false), [poll, setPoll] = React.useState('60'), [dirty, setDirty] = React.useState(false), action = useAction(cloud, t, 'preferences');
      React.useEffect(() => { if (settings && !dirty) { setStartup(settings.pullOnStartup); setPoll(String(settings.pollSeconds)); } }, [settings, dirty]);
      return h('section', { className: 'dsh-az-card', 'aria-label': t('defaults') }, h('h2', null, t('defaults')),
        h(Check, { label: t('defaultOff'), checked: false, disabled: true }), h('form', { onSubmit: event => { event.preventDefault(); const seconds = Number(poll); if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86400) { action.setError(t('invalid')); return; } void action.run({ action: 'set-defaults', defaultEnabled: false, pullOnStartup: startup, pollSeconds: seconds }, () => setDirty(false)); } },
          h(Check, { label: t('startup'), checked: startup, disabled: action.busy || !settings, onChange: event => { setStartup(event.target.checked); setDirty(true); } }),
          h(Field, { label: t('poll') }, h('input', { type: 'number', min: 30, max: 86400, step: 1, value: poll, disabled: action.busy || !settings, onChange: event => { setPoll(event.target.value); setDirty(true); } })), h(Button, { type: 'submit', disabled: action.busy || !settings }, t('savePrefs'))), h(Feedback, { action, t }));
    }
    function Mappings({ runtime, cloud, t }: Props) {
      const [items, setItems] = React.useState<(CloudMapping & { id: string })[]>([]), [draft, setDraft] = React.useState<CloudMapping>({ remotePrefix: '', localPrefix: '', remotePlatform: 'linux' }), [confirmation, setConfirmation] = React.useState<Confirmation | null>(null);
      const action = useAction(cloud, t, 'mappings'), picker = React.useRef<AbortController | null>(null);
      const load = () => { void action.run({ action: 'mappings' }, reply => { if (reply.kind === 'mappings') setItems([...reply.items]); }); };
      React.useEffect(() => { load(); return () => picker.current?.abort(); }, [cloud]);
      const reset = () => setDraft({ remotePrefix: '', localPrefix: '', remotePlatform: 'linux' });
      async function pick() { const current = new AbortController(); picker.current?.abort(); picker.current = current; try { const path = await runtime.uiWorkspace.pickDirectory?.(); if (!current.signal.aborted && path) setDraft(value => ({ ...value, localPrefix: path })); } catch { if (!current.signal.aborted) action.setError(t('failed')); } }
      return h('section', { className: 'dsh-az-card', 'aria-label': t('mappings') }, h('h2', null, t('mappings')), h('p', { className: 'dsh-az-notice' }, t('mappingWarning')),
        h(Button, { disabled: action.busy, onClick: load }, t('refresh')),
        items.length ? h('ul', null, ...items.map(item => h('li', { key: item.id }, h('code', null, item.remotePrefix + ' → ' + item.localPrefix + ' (' + item.remotePlatform + ')'), h('div', { className: 'dsh-az-row' }, h(Button, { disabled: action.busy, onClick: () => { picker.current?.abort(); setDraft({ id: item.id, remotePrefix: item.remotePrefix, localPrefix: item.localPrefix, remotePlatform: item.remotePlatform }); } }, t('editMapping')), h(Button, { disabled: action.busy, onClick: () => setConfirmation({ title: t('removeMapping'), warning: t('mappingRemoveConfirm') + '. ' + t('mappingWarning'), request: { action: 'unmap', mappingId: item.id } }) }, t('removeMapping')))))) : h('p', null, t('emptyMappings')),
        h('form', { onSubmit: event => { event.preventDefault(); if (!draft.remotePrefix.trim() || !draft.localPrefix.trim()) { action.setError(t('invalid')); return; } setConfirmation({ title: t(draft.id ? 'editMapping' : 'addMapping'), warning: t('mappingConfirm') + '. ' + t('mappingWarning'), request: { action: 'map', mapping: { ...draft, remotePrefix: draft.remotePrefix.trim(), localPrefix: draft.localPrefix.trim() } } }); } },
          h(Field, { label: t('remotePrefix') }, h('input', { required: true, maxLength: 4096, value: draft.remotePrefix, disabled: action.busy, onChange: event => setDraft({ ...draft, remotePrefix: event.target.value }) })),
          h(Field, { label: t('localPrefix') }, h('input', { required: true, maxLength: 4096, value: draft.localPrefix, disabled: action.busy, onChange: event => { picker.current?.abort(); setDraft({ ...draft, localPrefix: event.target.value }); } })),
          typeof runtime.uiWorkspace.pickDirectory === 'function' && h(Button, { disabled: action.busy, onClick: () => { void pick(); } }, t('chooseFolder')),
          h(Field, { label: t('platform') }, h('select', { value: draft.remotePlatform, disabled: action.busy, onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => setDraft({ ...draft, remotePlatform: event.target.value as CloudMapping['remotePlatform'] }) }, ...['linux', 'darwin', 'win32'].map(value => h('option', { key: value, value }, value)))),
          h('div', { className: 'dsh-az-row' }, h(Button, { type: 'submit', disabled: action.busy }, t(draft.id ? 'editMapping' : 'addMapping')), h(Button, { onClick: () => { picker.current?.abort(); reset(); } }, t('cancel')))),
        h(Feedback, { action, t }), confirmation && h(Confirm, { value: confirmation, close: () => setConfirmation(null), t, accept: () => { const request = confirmation.request; setConfirmation(null); void action.run(request, () => { reset(); load(); }); } }));
    }
    function verifiedImport(view: CloudLocalView | undefined): view is CloudLocalView {
      return !!view && !incompleteImport(view) && (view.importState === 'complete' || (view.importState === 'degraded' && view.degradedAcknowledged)) && !view.mappingUnstable && !view.needsFolder && !view.admissionStopped && !view.restartRequired;
    }
    function Remote({ runtime, cloud, t }: Props) {
      type Page = Awaited<ReturnType<Cloud['request']>> & { kind: 'remote' };
      const [page, setPage] = React.useState<Page | null>(null), [confirmation, setConfirmation] = React.useState<Confirmation | null>(null), [imported, setImported] = React.useState<string[]>([]), [inspected, setInspected] = React.useState<string | null>(null);
      const action = useAction(cloud, t, 'catalog');
      async function importOne(request: CloudRequest) {
        const reply = await action.run(request);
        if (reply?.kind !== 'action' || reply.action !== 'pull') return;
        await action.run({ action: 'status', sessionId: reply.sessionId }, result => {
          if (result.kind !== 'status') return;
          const view = result.items.find(item => item.sessionId === reply.sessionId);
          if (verifiedImport(view)) { const key = reply.sessionId + ':' + view.generation; setImported(value => value.includes(key) ? value : [...value, key]); }
        });
      }
      const list = (cursor?: string) => { void action.run({ action: 'pull', ...(cursor ? { cursor } : {}), limit: 25 }, reply => { if (reply.kind === 'remote') setPage(reply); }); };
      function openOne(sessionId: string, generation: number) {
        void action.run({ action: 'status', sessionId }, result => {
          const view = result.kind === 'status' ? result.items.find(item => item.sessionId === sessionId) : undefined;
          if (verifiedImport(view) && view.generation === generation) runtime.uiWorkspace.openSession(sessionId);
          else action.setError(t('incompleteWarning'));
        });
      }
      return h('section', { className: 'dsh-az-card', 'aria-label': t('remote') }, h('h2', null, t('remote')), h('p', null, t('remoteHelp')), h('p', { className: 'dsh-az-muted' }, t('advisory')), h(Button, { disabled: action.busy, onClick: () => list() }, t('listRemote')),
        page && (page.items.length ? h('ul', null, ...page.items.map(item => h('li', { key: item.sessionId + ':' + item.generation, className: 'dsh-az-card' },
          h('h3', null, item.title || item.sessionId), h(Details, { entries: [[t('thread'), item.sessionId], [t('generation'), item.generation], [t('state'), item.state], [t('events'), item.eventCount], [t('platform'), item.sourcePlatform], ...(item.cwd ? [[t('sourceFolder'), item.cwd] as [string, AzureUI.Node]] : []), ...(item.sourceDeviceId ? [[t('sourceDevice'), item.sourceDeviceId] as [string, AzureUI.Node]] : []), ...(item.lastWriterDevice ? [[t('writer'), item.lastWriterDevice] as [string, AzureUI.Node]] : []), ...(item.leaseUntil !== undefined ? [[t('lease'), String(item.leaseUntil)] as [string, AzureUI.Node]] : [])] }),
          item.git && h('details', null, h('summary', null, t('gitSource')), h('p', { className: 'dsh-az-notice' }, t('gitWarning')), h(GitSummary, { facts: item.git, t })),
          h(Button, { disabled: action.busy || item.state === 'deleted', onClick: () => setConfirmation({ title: t('import'), warning: t('importWarning') + '\n' + item.sessionId + ' · ' + t('generation') + ': ' + item.generation + (item.cwd ? '\n' + item.cwd : ''), request: { action: 'pull', sessionId: item.sessionId } }) }, t('import')),
          imported.includes(item.sessionId + ':' + item.generation) && h(Button, { disabled: action.busy, onClick: () => openOne(item.sessionId, item.generation) }, t('open'))))) : h('p', null, t('emptyRemote'))),
        page?.nextCursor && h(Button, { disabled: action.busy, onClick: () => list(page.nextCursor) }, t('more')), h(Feedback, { action, t }),
        inspected && h(Thread, { key: inspected, runtime, cloud, t, sessionId: inspected }),
        confirmation && h(Confirm, { value: confirmation, t, close: () => setConfirmation(null), accept: () => { const request = confirmation.request; setConfirmation(null); if ('sessionId' in request && request.sessionId) setInspected(request.sessionId); void importOne(request); } }));
    }
    function Settings(props: AzureUI.SettingsProps) {
      const snapshot = useCloud(props.cloud);
      React.useEffect(() => { if (props.view !== 'summary') void props.cloud.refresh(); }, [props.cloud, props.view]);
      if (props.view === 'summary') return h('span', null, props.t('summary'));
      return h('div', { className: 'dsh-az' }, h(Styles), h('p', null, props.t('trust')), h(Button, { onClick: () => { void props.cloud.refresh(); } }, props.t('refresh')), snapshot.error && h('p', { role: 'alert' }, props.t('failed')), h(Auth, props), h(Preferences, props), h(Mappings, props), h(Remote, props));
    }
    function Manager(props: Props) {
      const list = React.useSyncExternalStore(props.runtime.sessions.list.subscribe, props.runtime.sessions.list.getSnapshot), id = selectedNativeThread(list);
      return h('main', { className: 'dsh-az dsh-az-panel', 'aria-label': props.t('title') }, h('h1', null, props.t('title')), id ? h(Thread, { ...props, key: id, sessionId: id }) : h('p', null, props.t('noSelection')), h(Settings, props));
    }
    function Icon() { return h('span', { 'aria-hidden': true }, '☁'); }
    return {
      inject: ['slots', 'locale', 'connection', 'conversation', 'sessions', 'uiWorkspace', 'layout'],
      apply(ctx: AzureUI.Context) {
        ctx.effect(() => ctx.locale.register(NS, { en: locale.ui }));
        const cloud = createCloudClient(ctx);
        ctx.effect(() => () => cloud.dispose());
        const connectionScope = <P extends object,>(component: import('react').ComponentType<P>) => {
          // A Host generation switch discards every view draft/confirmation and aborts
          // view flights, without pretending to dispose a retained Host runtime.
          return function ConnectionScope(props: P) {
            const generation = React.useSyncExternalStore(ctx.connection.generation.subscribe, ctx.connection.generation.getSnapshot);
            return h(component, { ...props, key: generation?.id ?? 'disconnected' });
          };
        };
        const seat = <P extends object,>(owner: string, options: AzureUI.SlotOptions, component: import('react').ComponentType<P>) => ctx.slots.inject(owner, () => ctx.slots.register({ ...options, locale: NS, inject: () => ({ runtime: ctx, cloud }) }, connectionScope(component)));
        seat('conversation.session.header.actions', { name: 'conversation.session.header.actions', id: PANEL, order: 260 }, Header);
        seat('conversation.hero.options', { name: 'conversation.hero.options', id: PANEL, order: 260 }, BlankHero);
        const corner = 'conversation.session.header.corner';
        ctx.slots.inject(corner, () => {
          const inject = () => ({ runtime: ctx, cloud }), component = connectionScope(BlankCorner);
          let remove: AzureUI.Dispose | undefined, closed = false, busy = false, dirty = false;
          const reconcile = () => {
            if (closed) return;
            if (busy) { dirty = true; return; }
            busy = true;
            try { do {
              dirty = false;
              const list = ctx.sessions.list.getSnapshot(), id = selectedNativeThread(list);
              // SINGLE seats do not fall through when their winner returns null.
              // Never reserve this cell on nonblank threads or shadow ANY foreign
              // occupant. The hero LIST remains available when the corner is busy.
              const wanted = id !== undefined && list.byId[id]?.blank === true && !ctx.slots.entries(corner).some(entry => entry.inject !== inject);
              if (!wanted && remove) { const release = remove; remove = undefined; release(); }
              else if (wanted && !remove) remove = ctx.slots.register({ name: corner, priority: 260, locale: NS, inject }, component);
            } while (dirty); } finally { busy = false; }
          };
          const stopList = ctx.sessions.list.subscribe(reconcile), stopSlots = ctx.slots.subscribe(corner, reconcile);
          reconcile();
          return () => { closed = true; stopList(); stopSlots(); remove?.(); };
        });
        seat('plugins.row.config', { name: 'plugins.row.config', key: '@1yefuwang1/dsh-azure-sync#azure-sync' }, Settings);
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 460, locale: NS, label: () => ctx.locale.bind(NS)('title') }, Icon));
        seat('main', { name: 'main', key: PANEL }, Manager);
      },
    };
  },
});
