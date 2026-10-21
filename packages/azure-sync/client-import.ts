/// <reference path="./client.types.d.ts" />
import { createImportClient, importSourceFacts, type ImportClient } from './client-import-model.js';
import type { CloudImportBases, CloudImportCapabilities, CloudImportPlanView, CloudImportRequest, CloudImportSourceView, CloudImportView } from './src/import/protocol.js';

interface Parts {
  Button: import('react').ComponentType<import('react').ButtonHTMLAttributes<HTMLButtonElement>>;
  Field: import('react').ComponentType<{ label: string; children?: AzureUI.Node }>;
  Check: import('react').ComponentType<{ label: string } & import('react').InputHTMLAttributes<HTMLInputElement>>;
  Dialog: import('react').ComponentType<AzureUI.DialogProps>;
  reason(code: string | undefined, t: AzureUI.Translate): string;
}
export interface ImportWizardProps {
  readonly runtime: AzureUI.Context; readonly t: AzureUI.Translate; readonly sessionId: string;
  readonly generation: number; close(): void; completed(sessionId: string, generation: number): void;
}

/** React is supplied by the public module loader, never imported as a separate runtime instance. */
export function createImportWizard(React: typeof import('react'), parts: Parts) {
  const h = React.createElement, { Button, Field, Check, Dialog } = parts;
  return function ImportWizard({ runtime, t, sessionId, generation, close, completed }: ImportWizardProps) {
    const clientRef = React.useRef<ImportClient | undefined>(undefined);
    const sessions = React.useSyncExternalStore(runtime.sessions.list.subscribe, runtime.sessions.list.getSnapshot);
    const [caps, setCaps] = React.useState<CloudImportCapabilities>();
    const [source, setSource] = React.useState<CloudImportSourceView>();
    const [bases, setBases] = React.useState<CloudImportBases>();
    const [plan, setPlan] = React.useState<CloudImportPlanView>();
    const [operation, setOperation] = React.useState<CloudImportView>();
    const [mode, setMode] = React.useState<'local' | 'worktree'>('local');
    const [folder, setFolder] = React.useState(''), [folderPath, setFolderPath] = React.useState('');
    const [actor, setActor] = React.useState(''), [baseKind, setBaseKind] = React.useState<'commit' | 'head' | 'local-branch'>('commit');
    const [baseName, setBaseName] = React.useState(''), [baseOid, setBaseOid] = React.useState('');
    const [remotePrefix, setRemotePrefix] = React.useState(''), [localPrefix, setLocalPrefix] = React.useState('');
    const [label, setLabel] = React.useState(''), [codeAck, setCodeAck] = React.useState(false), [pendingAck, setPendingAck] = React.useState(false);
    const [busy, setBusy] = React.useState(true), [loadingBases, setLoadingBases] = React.useState(false), [error, setError] = React.useState('');
    const [expired, setExpired] = React.useState(false);
    const alive = React.useRef(false), epoch = React.useRef(0), active = React.useRef<AbortController | undefined>(undefined);
    const baseEpoch = React.useRef(0), pickerEpoch = React.useRef(0), editedOid = React.useRef(false);
    const sourceFacts = importSourceFacts(source?.sourceGit);
    const actors = Object.keys(sessions.byId).filter(id => id !== sessionId && sessions.byId[id]?.origin !== 'subagent');
    const chosenFolder = folder === '' ? undefined : caps?.folders[Number(folder)];
    const resetReview = () => { setPlan(undefined); setCodeAck(false); setPendingAck(false); };
    const changeMode = (value: 'local' | 'worktree') => { resetReview(); setMode(value); };
    const failure = () => t('import.requestFailed');

    React.useEffect(() => {
      const client = createImportClient(runtime); clientRef.current = client;
      setBusy(true); setError(''); setCaps(undefined); setSource(undefined); setBases(undefined);
      setPlan(undefined); setOperation(undefined); setMode('local'); setFolder(''); setFolderPath('');
      setActor(''); setBaseKind('commit'); setBaseName(''); setBaseOid(''); setRemotePrefix('');
      setLocalPrefix(''); setLabel(''); setCodeAck(false); setPendingAck(false); editedOid.current = false;
      alive.current = true;
      const controller = new AbortController(), entered = ++epoch.current;
      active.current = controller;
      const load = async () => {
        const capacity = await client.request({ action: 'import-capabilities' }, controller.signal);
        if (!alive.current || entered !== epoch.current || capacity.kind !== 'import-capabilities') return;
        setCaps(capacity);
        if (!capacity.local) { setBusy(false); return; }
        const localAdmission = await client.request({ action: 'import-admission', sessionId }, controller.signal);
        if (!alive.current || entered !== epoch.current) return;
        if (localAdmission.kind === 'import-admission' && localAdmission.reserved && localAdmission.operationId) {
          if (localAdmission.generation !== generation) { setError(t('import.generationChanged')); return; }
          const previous = await client.request({ action: 'import-operation', sessionId, operationId: localAdmission.operationId }, controller.signal);
          if (alive.current && entered === epoch.current && previous.kind === 'import-operation') setOperation(previous);
          return; // Existing recovery/Off history is inspectable without an Azure source read.
        }
        const info = await client.request({ action: 'inspect-import', sessionId, generation, gitContextVersion: 2 }, controller.signal);
        if (!alive.current || entered !== epoch.current || info.kind !== 'import-source') return;
        setSource(info); setRemotePrefix(info.cwd);
        if (info.gitUsable && !editedOid.current) setBaseOid(importSourceFacts(info.sourceGit).head);
        if (info.operationId) {
          const previous = await client.request({ action: 'import-operation', sessionId, operationId: info.operationId }, controller.signal);
          if (alive.current && entered === epoch.current && previous.kind === 'import-operation') setOperation(previous);
        }
      };
      void load().catch(() => { if (alive.current && entered === epoch.current && !controller.signal.aborted) setError(failure()); }).finally(() => { if (alive.current && entered === epoch.current) setBusy(false); });
      return () => { alive.current = false; ++epoch.current; ++pickerEpoch.current; controller.abort(); active.current?.abort(); client.dispose(); };
    }, [runtime, sessionId, generation]);

    React.useEffect(() => {
      const client = clientRef.current;
      setBases(undefined); const entered = ++baseEpoch.current;
      if (!client || mode !== 'worktree' || !actor || !chosenFolder?.projectId || !chosenFolder.folderId) { setLoadingBases(false); return; }
      const controller = new AbortController(); setLoadingBases(true);
      void client.request({ action: 'import-bases', projectId: chosenFolder.projectId, folderId: chosenFolder.folderId, permissionActorId: actor }, controller.signal).then(reply => {
        if (!alive.current || controller.signal.aborted || entered !== baseEpoch.current || reply.kind !== 'import-bases') return;
        setBases(reply);
      }).catch(() => { if (alive.current && !controller.signal.aborted && entered === baseEpoch.current) setError(t('import.actorUnavailable')); }).finally(() => { if (alive.current && entered === baseEpoch.current) setLoadingBases(false); });
      return () => controller.abort();
    }, [runtime, mode, actor, chosenFolder?.projectId, chosenFolder?.folderId]);

    React.useEffect(() => {
      setExpired(false);
      if (!plan) return;
      const remaining = plan.expiresAt - Date.now();
      if (remaining <= 0) { setExpired(true); return; }
      const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647));
      return () => clearTimeout(timer);
    }, [plan]);

    async function run(request: CloudImportRequest) {
      const client = clientRef.current;
      if (!client || !alive.current) return;
      active.current?.abort(); const controller = new AbortController(), entered = ++epoch.current;
      active.current = controller; setBusy(true); setError('');
      try {
        const reply = await client.request(request, controller.signal);
        if (!alive.current || entered !== epoch.current || controller.signal.aborted) return;
        if (reply.kind === 'import-plan') { setPlan(reply); setCodeAck(false); }
        if (reply.kind === 'import-operation') {
          if (reply.generation !== generation) { setError(t('import.generationChanged')); return; }
          if (plan && reply.destination !== plan.destination || operation && reply.operationId === operation.operationId && reply.destination !== operation.destination) { setError(failure()); return; }
          setOperation(reply); setPlan(undefined);
          if (reply.phase === 'ready') completed(reply.sessionId, reply.generation);
        }
        return reply;
      } catch { if (alive.current && entered === epoch.current && !controller.signal.aborted) setError(failure()); }
      finally { if (alive.current && entered === epoch.current) setBusy(false); }
    }
    async function review() {
      if (!source?.eligible || !caps?.local) return;
      const mapped = { remotePlatform: source.platform, remotePrefix: remotePrefix.trim(), ...(mode === 'local' && localPrefix.trim() ? { localPrefix: localPrefix.trim() } : {}) };
      if (!mapped.remotePrefix || mode === 'local' && !folderPath.trim() || mode === 'worktree' && (!actor || !chosenFolder?.projectId || !chosenFolder.folderId || !baseOid || baseKind === 'local-branch' && !baseName)) { setError(t('invalid')); return; }
      if (typeof globalThis.crypto?.randomUUID !== 'function') { setError(t('import.unavailable')); return; }
      const destination = mode === 'local'
        ? { kind: 'local' as const, folderPath: folderPath.trim(), ...(chosenFolder?.projectId && chosenFolder.folderId && chosenFolder.path === folderPath.trim() ? { projectId: chosenFolder.projectId, folderId: chosenFolder.folderId } : {}) }
        : { kind: 'worktree' as const, projectId: chosenFolder!.projectId!, folderId: chosenFolder!.folderId!, permissionActorId: actor,
            base: baseKind === 'local-branch' ? { kind: 'local-branch' as const, name: baseName, oid: baseOid.trim() } : { kind: baseKind, oid: baseOid.trim() }, ...(label.trim() ? { label: label.trim() } : {}) };
      await run({ action: 'plan-import', sessionId, generation, operationId: globalThis.crypto.randomUUID(), gitContextVersion: 2, destination, mapping: mapped });
    }
    function chooseFolder(value: string) {
      resetReview(); setFolder(value); const selected = value ? caps?.folders[Number(value)] : undefined;
      if (selected) setFolderPath(selected.path);
    }
    async function pick() {
      const entered = ++pickerEpoch.current;
      try {
        const selected = await runtime.uiWorkspace.pickDirectory?.();
        if (!alive.current || entered !== pickerEpoch.current || selected === null || selected === undefined) return;
        resetReview(); setFolder(''); setFolderPath(selected);
      } catch { if (alive.current && entered === pickerEpoch.current) setError(t('invalid')); }
    }
    const opRequest = (action: 'import-operation' | 'cancel-import') => operation && run({ action, sessionId, operationId: operation.operationId });
    async function openHistory() {
      if (!operation) return;
      const reply = await run({ action: 'import-operation', sessionId, operationId: operation.operationId });
      if (reply?.kind === 'import-operation' && reply.phase === 'ready' && reply.generation === generation) runtime.uiWorkspace.openSession(sessionId);
    }
    const disabled = busy || !!operation;
    const sourceDisplay = h('section', { className: 'dsh-az-card' }, h('h3', null, t('import.sourceContext')),
      h('p', null, t('import.sourceCommit'), ': ', h('code', null, sourceFacts.head || t('unknown'))),
      h('p', null, t('import.sourceBranch'), ': ', h('code', null, sourceFacts.localBranch || t('unknown'))),
      h('p', null, t('import.upstreamHint'), ': ', h('code', null, [sourceFacts.currentRemote, sourceFacts.currentRef].filter(Boolean).join(' / ') || t('unknown'))),
      h('p', null, t('import.creationCommit'), ': ', h('code', null, sourceFacts.baseOid || t('unknown'))),
      h('p', null, t('import.creationHint'), ': ', h('code', null, [sourceFacts.baseRemote, sourceFacts.baseRef].filter(Boolean).join(' / ') || t('unknown'))),
      h('p', { className: 'dsh-az-muted' }, t('import.hintsUnproven')));
    const progress = operation && h('section', { className: 'dsh-az-card', 'aria-live': 'polite' },
      h('h3', null, t('import.operation')), h('p', null, t('import.operationId'), ': ', h('code', null, operation.operationId)),
      h('p', null, t('state'), ': ', t('import.phase.' + operation.phase)),
      operation.cwd && h('p', null, t('import.destinationFolder'), ': ', h('code', null, operation.cwd)),
      operation.branch && h('p', null, t('gitBranch'), ': ', h('code', null, operation.branch)),
      operation.baseOid && h('p', null, t('gitCommit'), ': ', h('code', null, operation.baseOid)),
      operation.reason && h('p', { role: 'status' }, parts.reason(operation.reason, t)),
      h('div', { className: 'dsh-az-row' }, h(Button, { disabled: busy, onClick: () => { void opRequest('import-operation'); } }, t('refresh')),
        operation.phase !== 'ready' && operation.phase !== 'cancelled' && h(Button, { onClick: () => { void opRequest('cancel-import'); } }, t('import.cancelOperation')),
        (operation.phase === 'recovery-required' || operation.phase === 'cancelled') && h(Button, { disabled: busy, onClick: () => { void run({ action: 'resume-import', sessionId, operationId: operation.operationId, revision: Math.max(1, operation.revision), confirm: true, ...(codeAck ? { acknowledgeCodeMismatch: true } : {}) }); } }, t('import.resume')),
        operation.phase === 'ready' && h(Button, { disabled: busy, onClick: () => { void openHistory(); } }, t('import.openHistory'))),
      operation.phase === 'ready' && h(React.Fragment, null, h('p', { className: 'dsh-az-notice' }, t('import.continueWarning')),
        operation.pendingInput && h(Check, { label: t('import.pendingAck'), checked: pendingAck, disabled: busy, onChange: event => setPendingAck(event.target.checked) }),
        h(Button, { disabled: busy || operation.pendingInput && !pendingAck, onClick: () => { void run({ action: 'continue-import', sessionId, operationId: operation.operationId, revision: Math.max(1, operation.revision), confirm: true, ...(pendingAck ? { acknowledgePendingInput: true } : {}) }).then(reply => { if (reply?.kind === 'import-operation' && reply.continuable) runtime.uiWorkspace.openSession(sessionId); }); } }, t('import.continue'))));
    const confirmation = plan && !operation && h('section', { className: 'dsh-az-card', 'aria-label': t('import.reviewTitle') },
      h('h3', null, t('import.reviewTitle')), h('p', null, t('import.sameIdentity'), ' ', h('code', null, plan.sessionId)),
      h('p', null, t('generation'), ': ', plan.generation, ' · ', t('events'), ': ', plan.eventCount),
      h('p', null, t('import.destination'), ': ', t(plan.destination === 'local' ? 'import.local' : 'import.worktree')),
      h('p', null, t('import.destinationFolder'), ': ', h('code', null, plan.cwd)),
      plan.destination === 'local' ? h('section', { 'aria-label': t('import.localObservedCode') },
        h('h4', null, t('import.localObservedCode')),
        h('p', null, t('import.localObservedBranch'), ': ', h('code', null, plan.branch || t('unknown'))),
        h('p', null, t('import.localObservedCommit'), ': ', h('code', null, plan.baseOid || t('unknown'))),
        h('p', { className: 'dsh-az-muted' }, t('import.localObservedHelp')))
        : h(React.Fragment, null, plan.branch && h('p', null, t('gitBranch'), ': ', h('code', null, plan.branch)), plan.baseOid && h('p', null, t('gitCommit'), ': ', h('code', null, plan.baseOid))),
      ...plan.warnings.map(warning => h('p', { key: warning, className: 'dsh-az-notice' }, parts.reason(warning, t))),
      plan.codeMismatch && h(Check, { label: t('import.codeAck'), checked: codeAck, onChange: event => setCodeAck(event.target.checked) }),
      h('p', { className: 'dsh-az-notice' }, t('import.uploadWarning')),
      expired && h('p', { role: 'status' }, t('import.reason.expired-review')),
      h('div', { className: 'dsh-az-row' }, h(Button, { disabled: busy, onClick: resetReview }, t('import.back')),
        h(Button, { onClick: () => { void run({ action: 'cancel-import', sessionId, operationId: plan.operationId }); } }, t('import.cancelOperation')),
        h(Button, { disabled: busy || expired || plan.codeMismatch && !codeAck || Date.now() >= plan.expiresAt, onClick: () => { void run({ action: 'commit-import', sessionId, operationId: plan.operationId, revision: plan.revision, confirm: true, ...(codeAck ? { acknowledgeCodeMismatch: true } : {}) }); } }, t('import.confirmHere'))));
    return h(Dialog, { title: t('import.title'), close, t },
      h('p', null, t('import.sameIdentity'), ' ', h('code', null, sessionId)),
      h('p', { className: 'dsh-az-notice' }, t('import.codeNotice')),
      caps && !caps.local && h('p', { role: 'alert' }, parts.reason(caps.reason, t)),
      source && !source.eligible && h('p', { role: 'alert' }, parts.reason(source.reason, t)),
      sourceDisplay,
      !operation && !plan && h('form', { onSubmit: event => { event.preventDefault(); void review(); } },
        h('fieldset', { disabled }, h('legend', null, t('import.destination')),
          h('label', { className: 'dsh-az-check' }, h('input', { type: 'radio', name: 'import-destination', checked: mode === 'local', onChange: () => changeMode('local') }), t('import.local')),
          h('label', { className: 'dsh-az-check' }, h('input', { type: 'radio', name: 'import-destination', checked: mode === 'worktree', disabled: !caps?.worktree || actors.length === 0, onChange: () => changeMode('worktree') }), t('import.worktree'))),
        caps?.local && (!caps.worktree || actors.length === 0) && h('p', { role: 'status', className: 'dsh-az-muted' }, actors.length === 0 ? t('import.actorUnavailable') : parts.reason('worktree-unavailable', t)),
        h(Field, { label: t('import.sourceFolder') }, h('select', { value: folder, disabled, onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => chooseFolder(event.target.value) }, h('option', { value: '' }, t(mode === 'local' ? 'import.customFolder' : 'import.chooseProject')), ...(caps?.folders ?? []).map((entry, index) => h('option', { key: entry.path + ':' + index, value: String(index), disabled: mode === 'worktree' && (!entry.projectId || !entry.folderId) }, entry.title + ' · ' + entry.path)))),
        mode === 'local' && h(React.Fragment, null,
          h(Field, { label: t('import.destinationFolder') }, h('input', { value: folderPath, maxLength: 4096, disabled, required: true, onChange: event => { resetReview(); setFolder(''); setFolderPath(event.target.value); } })),
          runtime.uiWorkspace.pickDirectory && h(Button, { disabled, onClick: () => { void pick(); } }, t('chooseFolder')),
          h(Field, { label: t('import.localMappingRoot') }, h('input', { value: localPrefix, maxLength: 4096, disabled, onChange: event => { resetReview(); setLocalPrefix(event.target.value); } }))),
        mode === 'worktree' && h(React.Fragment, null,
          h(Field, { label: t('import.permissionContext') }, h('select', { value: actor, disabled, onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => { resetReview(); setActor(event.target.value); } }, h('option', { value: '' }, t('import.chooseActor')), ...actors.map(id => h('option', { key: id, value: id }, id)))),
          h('p', { className: 'dsh-az-muted' }, t('import.actorHelp')),
          h(Field, { label: t('import.baseKind') }, h('select', { value: baseKind, disabled: disabled || loadingBases, onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => { resetReview(); const kind = event.target.value as typeof baseKind; setBaseKind(kind); if (kind === 'head') setBaseOid(bases?.head ?? ''); } }, h('option', { value: 'commit' }, t('import.exactCommit')), h('option', { value: 'local-branch' }, t('import.localBranch')), h('option', { value: 'head' }, t('import.localHead')))),
          baseKind === 'local-branch' && h(Field, { label: t('import.localBranch') }, h('select', { value: baseName, disabled: disabled || loadingBases, onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => { resetReview(); setBaseName(event.target.value); setBaseOid(bases?.branches.find(branch => branch.name === event.target.value)?.oid ?? ''); } }, h('option', { value: '' }, t('import.chooseBranch')), ...(bases?.branches ?? []).map(branch => h('option', { key: branch.name, value: branch.name }, branch.name)))),
          h(Field, { label: t('import.exactCommit') }, h('input', { value: baseOid, maxLength: 64, disabled: disabled || baseKind !== 'commit', required: true, onChange: event => { resetReview(); editedOid.current = true; setBaseOid(event.target.value); } })),
          h(Field, { label: t('import.label') }, h('input', { value: label, maxLength: 60, disabled, onChange: event => { resetReview(); setLabel(event.target.value); } }))),
        h(Field, { label: t('import.remoteMappingRoot') }, h('input', { value: remotePrefix, maxLength: 4096, disabled, required: true, onChange: event => { resetReview(); setRemotePrefix(event.target.value); } })),
        h('p', { className: 'dsh-az-muted' }, t('import.geometryHelp')),
        h(Button, { type: 'submit', disabled: busy || !caps?.local || !source?.eligible || loadingBases }, t('import.review'))),
      confirmation, progress,
      busy && h('p', { role: 'status', 'aria-live': 'polite' }, t('loading')),
      error && h('p', { role: 'alert' }, error),
      h('p', { className: 'dsh-az-muted' }, t('import.closeHelp')));
  };
}
