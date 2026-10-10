/* Persistent plain-JS Client half. Guarded rc.2 submit adapter; no DOM interception.
 * Projects replace only the workspace browsing hole; native views and row
 * extensions remain installed, with owned aliases and a Folder view fallback.
 */
window.__ModuleLoader__.load({
  id: 'dsh-worktrees',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'worktrees.ui';
    const PANEL = 'dsh-worktrees';
    const en = {
      projects: 'Projects', folderView: 'Folder view', newProject: 'New project', editProject: 'Manage project', projectName: 'Project name', project: 'Project', folders: 'Folders', folder: 'Folder', addFolder: 'Add folder', chooseDirectory: 'Choose directory', browse: 'Browse folders', absolutePath: 'Absolute Host directory path', save: 'Save', newThread: 'New thread', threadMode: 'Thread mode', threadActions: 'Thread actions', threadDetails: 'Thread details', unassigned: 'Other threads', showMore: 'Show more', showLess: 'Show less', filterThreads: 'Search threads or projects', allThreads: 'All threads', archivedOnly: 'Archived only', hideArchived: 'Hide archived', untitled: 'Untitled', blankThread: 'New thread', collapse: 'Collapse project', expand: 'Expand project', waiting: 'Waiting for interaction', done: 'Finished, not yet viewed', localThread: 'Local thread', worktreeThread: 'Worktree thread', draftWarning: 'This draft contains text or attachments. Keep it in this thread before choosing another project or folder.', chooseFolder: 'Choose a folder', createFolder: 'Create folder', folderName: 'Folder name', chooseThisFolder: 'Use this folder', noProjects: 'Add a project to organize your threads.',
      rootFolder: 'Worktree root folder', rootSummary: 'Choose where new worktrees are created.', rootHelp: 'Absolute folder path on the Host, outside your source repositories. Changes apply to new worktrees only; existing directories and in-flight creates are not moved.', rootReset: 'Reset to inherited default', rootSaved: 'Saved. New worktrees will use this location.', rootUnavailable: 'Host-backed settings are unavailable for this entry.', rootInvalid: 'Enter a valid absolute Host folder path.', rootConflict: 'The setting changed or the Host refused the write. Your draft is preserved; reopen this page to read the latest value.',
      pinned: 'Pinned', title: 'Worktrees', local: 'Local', new: 'New worktree', remote: 'Remote', branch: 'Remote base branch',
      setupProgress: 'Preparing worktree', preparingMessage: 'Preparing your first message…', fetchingLatest: 'Fetching latest remote branch…', creatingWorktree: 'Creating worktree…', namingBranch: 'Generating and applying branch name…', openingConversation: 'Opening worktree conversation…', setupReady: 'Worktree ready', stagingAttachments: 'Preparing attachments for this worktree…', startingConversation: 'Starting normal conversation…', setupFailed: 'Worktree preparation failed', cancelSetup: 'Cancel setup', unsupported: 'This native composer version is not supported by the guarded adapter.', filesLost: 'A draft attachment is no longer available.', upload: 'Attachment upload failed', uncertain: 'Prompt admission is uncertain. Open the created conversation before trying again.',
      search: 'Search remote branches', select: 'Base branch', refresh: 'Refresh', more: 'Load more', close: 'Close', open: 'Open conversation', remove: 'Remove', creatingWorktree: 'Creating worktree…',
      createBranch: 'Create branch here', branchName: 'New branch name', protect: 'Protect', unprotect: 'Unprotect',
      archive: 'Archive (retain files)', restore: 'Restore', archived: 'Archived', includeArchived: 'Include archived',
      preview: 'Preview handoff', export: 'Export patch', apply: 'Apply to Local and continue',
      previewTitle: 'Review handoff to Local', original: 'Original Local checkout', target: 'Local target path',
      openSource: 'Open a worktree conversation above before previewing or applying its handoff.',
      noWriters: 'I have stopped all other writers in both checkouts and will keep them stopped during handoff.',
      handoffWarning: 'Requires Full access and idle sessions. Local must be clean at the saved base. No pull, reset or branch switch. This is not a globally atomic operation; external writers must remain stopped. Source files and the patch are retained.',
      loading: 'Loading…', empty: 'No worktrees in this repository.', actor: 'Open a conversation before using the worktree manager.',
      detached: 'Detached', dirty: 'Dirty', clean: 'Clean', protected: 'Protected', unprotected: 'Unprotected',
      base: 'Base', sessions: 'Conversations', state: 'State', retained: 'Archiving retains the directory and conversations; it does not delete files.',
      operation: 'Operation', reconcile: 'Check operation status', cancelled: 'Cancelled; any created checkout is retained.',
      files: 'Files', binary: 'Binary', bytes: 'Bytes', patch: 'Retained patch path', copy: 'Copy path', copied: 'Path copied',
      transport: 'Transport failure',
      decode: 'Invalid or unsupported worktree response', host: 'Host refused the operation',
      blocked: 'Another plugin is using this composer; its state was left unchanged.',
      ownership: 'Composer ownership changed; creation was cancelled.', changed: 'The source, draft, settings or navigation changed; creation was cancelled.',
      targetBusy: 'The exact destination is not an empty, idle composer; the source draft is unchanged.',
      invalidSession: 'The Host did not return an exact destination session.',
      unknown: 'Operation failed', statusError: 'Checkout status unavailable', noRemote: 'No advertised remote branches. Choose a remote and refresh; no cached base will be used.',
      idle: 'Idle', busy: 'Busy', recovery: 'Recovery required', settings: 'Repository settings changed. Check the created worktree before continuing.',
    };
    const zh = { ...en,
      projects: '项目', folderView: '文件夹视图', newProject: '新建项目', editProject: '管理项目', projectName: '项目名称', project: '项目', folders: '文件夹', folder: '文件夹', addFolder: '添加文件夹', chooseDirectory: '选择目录', browse: '浏览文件夹', absolutePath: '主机绝对目录路径', save: '保存', newThread: '新建对话', threadMode: '对话模式', threadActions: '对话操作', threadDetails: '对话详情', unassigned: '其他对话', showMore: '显示更多', showLess: '收起', filterThreads: '搜索对话或项目', allThreads: '所有对话', archivedOnly: '仅已归档', hideArchived: '隐藏已归档', untitled: '未命名', blankThread: '新对话', collapse: '收起项目', expand: '展开项目', waiting: '等待交互', done: '已完成，尚未查看', localThread: '本地对话', worktreeThread: '工作树对话', draftWarning: '此草稿包含文字或附件。请先保留当前对话，再选择其他项目或文件夹。', chooseFolder: '选择文件夹', createFolder: '创建文件夹', folderName: '文件夹名称', chooseThisFolder: '使用此文件夹', noProjects: '添加项目以组织您的对话。',
      rootFolder: '工作树根目录', rootSummary: '选择新工作树的创建位置。', rootHelp: '主机上的绝对目录路径，需位于源仓库之外。仅影响新工作树，已有目录和进行中的创建不会移动。', rootReset: '恢复继承的默认值', rootSaved: '已保存，新工作树将使用此位置。', rootUnavailable: '此条目的主机设置不可用。', rootInvalid: '请输入有效的主机绝对目录路径。', rootConflict: '设置已更改或主机拒绝了保存，草稿已保留。请重新打开页面读取最新值。',
      pinned: '已固定', title: '工作树', local: '本地', new: '新工作树', remote: '远程', branch: '远程基础分支', search: '搜索远程分支',
      setupProgress: '正在准备工作树', preparingMessage: '正在准备第一条消息…', fetchingLatest: '正在获取最新远程分支…', creatingWorktree: '正在创建工作树…', namingBranch: '正在生成并应用分支名称…', openingConversation: '正在打开工作树对话…', setupReady: '工作树已就绪', stagingAttachments: '正在为工作树准备附件…', startingConversation: '正在开始正常对话…', setupFailed: '工作树准备失败', cancelSetup: '取消准备', unsupported: '该输入区版本不受受保护适配器支持。', filesLost: '草稿附件已不可用。', upload: '附件上传失败', uncertain: '消息发送结果不确定，请先打开创建的对话检查。',
      select: '基础分支', refresh: '刷新', more: '加载更多', close: '关闭', open: '打开对话', remove: '移除', creatingWorktree: '正在创建工作树…', createBranch: '在此创建分支', branchName: '新分支名称',
      protect: '保护', unprotect: '取消保护', archive: '归档（保留文件）', restore: '恢复', archived: '已归档',
      includeArchived: '包含已归档', preview: '预览交接', export: '导出补丁', apply: '应用到本地并继续',
      previewTitle: '审阅本地交接', original: '原始本地检出', target: '本地目标路径',
      openSource: '请先打开上方工作树对话，再预览或应用其交接。',
      noWriters: '我已停止两个检出中的所有其他写入者，并会在交接期间保持停止。',
      handoffWarning: '需要完整访问权限和空闲会话。本地必须干净且位于保存的基础提交。不会拉取、重置或切换分支。这不是全局原子操作；外部写入者必须保持停止。源文件和补丁会保留。',
      actor: '请先打开对话，再使用工作树管理器。', detached: '分离检出', dirty: '有修改', clean: '干净',
      protected: '已保护', unprotected: '未保护', base: '基础', sessions: '对话', state: '状态',
      retained: '归档会保留目录和对话，不会删除文件。', operation: '操作', reconcile: '查询操作状态', cancelled: '已取消，已创建的工作树会保留。',
      files: '文件', binary: '二进制', bytes: '字节', patch: '保留的补丁路径', copy: '复制路径', copied: '路径已复制',
      transport: '传输失败', decode: '工作树响应无效或版本不受支持',
      host: '主机拒绝操作', blocked: '输入区正在由其他插件使用，未更改其状态。',
      ownership: '输入区的所有权已更改，已取消创建。', changed: '源会话、草稿、设置或导航已更改，已取消创建。',
      targetBusy: '指定目标的输入区不是空闲且空白的，源草稿保持不变。',
      invalidSession: '主机未返回明确的目标会话。', unknown: '操作失败', statusError: '检出状态不可用',
      noRemote: '没有已公布的远程分支，请选择远程并刷新。不会使用缓存的基础提交。',
      settings: '仓库设置已更改，请检查已创建的工作树。',
      loading: '正在加载…', empty: '该仓库没有工作树。', idle: '空闲', busy: '忙碌', recovery: '需要恢复',
    };
    const css = `
.dsh-wt{color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5;box-sizing:border-box}
.dsh-wt-panel{padding:24px;overflow:auto;height:100%;max-width:1100px;margin:auto}
.dsh-wt-card{padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);margin:8px 0}
.dsh-wt-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-wt-between{justify-content:space-between}
.dsh-wt button{font:inherit;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer}
.dsh-wt button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-wt button:disabled{opacity:.45;cursor:not-allowed}.dsh-wt button[aria-pressed=true],.dsh-wt .dsh-wt-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-wt :is(button,input,select,textarea):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-wt :is(input:not([type=checkbox]),select,textarea){box-sizing:border-box;font:inherit;padding:6px 8px;max-width:100%;border:1px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dsh-wt label{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.dsh-wt-field{flex-direction:column;align-items:stretch!important;min-width:160px;flex:1}
.dsh-wt-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-wt-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsh-wt code,.dsh-wt pre{overflow-wrap:anywhere;white-space:pre-wrap}.dsh-wt h2,.dsh-wt h3,.dsh-wt p{margin:8px 0}
.dsh-wt-dialog{width:min(720px,calc(100% - 48px));max-height:calc(100% - 48px);overflow:auto;padding:20px;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-wt-progress{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px}.dsh-wt-progress ol{margin:8px 0;padding-left:18px;display:flex;flex-direction:column;gap:5px}.dsh-wt-progress li{color:var(--dsw-alias-label-secondary)}.dsh-wt-progress li[data-active=true]{font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-wt-create-controls{position:relative;font-size:12px}.dsh-wt-create-controls select{max-width:160px;min-height:28px}.dsh-wt-base-options{position:absolute;bottom:calc(100% + 8px);left:0;z-index:20;min-width:240px;max-width:360px;padding:12px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay)}.dsh-wt-create-error{max-width:360px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dsh-wt-projects{min-height:0;display:flex;flex-direction:column;gap:6px;padding:8px;width:100%;box-sizing:border-box;font-size:13px}.dsh-wt-projects-header{display:flex;align-items:center;justify-content:space-between;padding:4px}.dsh-wt-project-list{min-height:0;overflow:auto}.dsh-wt-project-head{display:flex;align-items:center;gap:4px;margin-top:8px}.dsh-wt-project-head>button:first-child{flex:1;min-width:0;text-align:left;display:flex;align-items:center;gap:7px}.dsh-wt-projects button{border:0;padding:4px 6px}.dsh-wt-project-title,.dsh-wt-thread-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.dsh-wt-project-title{font-weight:600}.dsh-wt-thread{border-radius:7px;position:relative}.dsh-wt-thread[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}.dsh-wt-thread-main{display:flex;align-items:center;gap:5px;min-height:32px;padding-left:12px}.dsh-wt-thread-main>button:first-child{display:flex;align-items:center;gap:6px;flex:1;min-width:0;text-align:left}.dsh-wt-thread-title{flex:1}.dsh-wt-thread-main:hover .dsh-wt-thread-title{overflow:auto;text-overflow:clip}.dsh-wt-thread-actions{display:flex;align-items:center;opacity:0}.dsh-wt-thread:is(:hover,:focus-within) .dsh-wt-thread-actions{opacity:1}.dsh-wt-thread-actions button{min-width:24px}.dsh-wt-thread-leading{width:16px;display:inline-flex;flex-shrink:0}.dsh-wt-thread-status{font-size:11px;color:var(--dsw-alias-state-business-primary)}.dsh-wt-thread-pending{color:var(--dsw-alias-state-warning-primary)}.dsh-wt-thread-archived{opacity:.65}.dsh-wt-branch-chip{display:inline-flex;align-items:center;justify-content:center;width:16px;flex-shrink:0;color:var(--dsw-alias-label-secondary)}.dsh-wt-thread-hover{padding:8px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}.dsh-wt-project-menu{display:flex;flex-direction:column;align-items:stretch}.dsh-wt-project-menu button{text-align:left}.dsh-wt-project-picker{display:flex;align-items:center;gap:4px;max-width:100%}.dsh-wt-project-picker select{max-width:190px}.dsh-wt-folder-list{padding:0;list-style:none}.dsh-wt-folder-list li{display:flex;align-items:center;gap:8px;padding:4px 0;overflow-wrap:anywhere}.dsh-wt-folder-list code{flex:1}.dsh-wt-folder-browser{max-height:45vh;overflow:auto}.dsh-wt-folder-browser button{display:block;width:100%;text-align:left}.dsh-wt-dialog::backdrop{background:var(--dsw-alias-bg-mask-1)}.dsh-wt-details{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px}.dsh-wt-details dd{margin:0;overflow-wrap:anywhere}
`;
    class WorktreeError extends Error {
      constructor(kind, code, message = '') { super(message); this.kind = kind; this.code = code; }
    }
    function decodeReply(reply) {
      const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
      const failure = value => object(value) && typeof value.code === 'string' && typeof value.message === 'string';
      if (!object(reply) || typeof reply.ok !== 'boolean') throw new WorktreeError('decode', 'invalid-transport');
      if (!reply.ok) {
        if (!failure(reply.error)) throw new WorktreeError('decode', 'invalid-transport-error');
        throw new WorktreeError('transport', reply.error.code, reply.error.message);
      }
      const envelope = reply.value;
      if (!object(envelope) || envelope.v !== 1 || typeof envelope.ok !== 'boolean') throw new WorktreeError('decode', 'unsupported-envelope');
      if (!envelope.ok) {
        if (!failure(envelope.error)) throw new WorktreeError('decode', 'invalid-error');
        throw new WorktreeError('host', envelope.error.code, envelope.error.message);
      }
      if (!Object.hasOwn(envelope, 'data')) throw new WorktreeError('decode', 'missing-data');
      return envelope.data;
    }
    function validateData(request, data) {
      const string = value => typeof value === 'string' && value.length > 0;
      const naming = value => value && string(value.title) && string(value.slug) && string(value.directoryName) && string(value.branch) && ['model', 'fallback'].includes(value.source) && (value.fallbackReason === undefined || string(value.fallbackReason));
      const record = value => value && (value.displayName === undefined || string(value.displayName)) && (value.naming === undefined || naming(value.naming)) && string(value.id) && string(value.operationId) && string(value.effectiveCwd) && string(value.remote) && string(value.remoteBranch) && typeof value.baseOid === 'string' && (value.state !== 'ready' || string(value.baseOid)) && Array.isArray(value.sessionIds) && value.sessionIds.every(string) && (value.branch === null || typeof value.branch === 'string') && typeof value.protected === 'boolean' && typeof value.archived === 'boolean' && ['creating', 'ready', 'recovery-required', 'missing'].includes(value.state);
      const operation = value => value && (value.generatedName === undefined || naming(value.generatedName)) && string(value.id) && string(value.phase) && (value.error === null || (string(value.error?.code) && typeof value.error.message === 'string'));
      let valid = true;
      if (request.action === 'status') {
        valid = data && string(data.settingsHash);
        if (request.operationId) valid = valid && operation(data.operation) && (!data.sessionId || string(data.sessionId)) && (!data.worktree || record(data.worktree));
        else if (request.id) valid = valid && record(data.worktree) && (data.status === null || (typeof data.status?.dirty === 'boolean' && string(data.status.head)));
        else valid = valid && string(data.repository?.root) && string(data.repository.head) && (data.repository.branch === null || typeof data.repository.branch === 'string') && Array.isArray(data.remotes) && data.remotes.every(item => string(item?.name) && string(item.identity));
      } else if (request.action === 'branches') {
        valid = data && data.remote === request.remote && string(data.remoteIdentity) && (!request.remoteIdentity || data.remoteIdentity === request.remoteIdentity) && Array.isArray(data.items) && data.items.every(item => string(item?.name) && string(item.oid)) && Number.isFinite(data.observedAt) && (data.defaultBranch === null || typeof data.defaultBranch === 'string') && (!data.nextCursor || string(data.nextCursor));
      } else if (request.action === 'list') valid = data && Array.isArray(data.items) && data.items.every(record) && (!data.nextCursor || string(data.nextCursor));
      else if (['create', 'start', 'handoff'].includes(request.action)) valid = data && string(data.sessionId) && string(data.workspaceId) && string(data.settingsHash) && record(data.worktree) && operation(data.operation);
      else if (request.action === 'preview') valid = data && string(data.id) && data.worktreeId === request.id && string(data.sourceSessionId) && string(data.targetRoot) && string(data.baseOid) && string(data.patchHash) && string(data.patchPath) && Number.isFinite(data.bytes) && Array.isArray(data.files) && data.files.every(file => string(file?.path) && typeof file.status === 'string' && typeof file.binary === 'boolean');
      else if (request.action === 'export') valid = data && string(data.path) && string(data.patchHash) && Number.isFinite(data.bytes) && (data.patch === undefined || typeof data.patch === 'string');
      if (!valid) throw new WorktreeError('decode', 'invalid-' + request.action + '-data');
      return data;
    }
    async function quietRPC(ctx, endpoint, payload, signal) {
      let reply;
      // Use Connection's authenticated/correlated transport, never chat commands.
      try { reply = await ctx.connection.rpc.call('/api', endpoint, payload, signal); }
      catch (error) {
        if (error?.name === 'AbortError') throw new WorktreeError('cancelled', 'cancelled', error.message || '');
        throw new WorktreeError('transport', 'rpc-rejected', error?.message || '');
      }
      return decodeReply(reply);
    }
    async function requestHost(ctx, actorId, request, signal) {
      if (typeof actorId !== 'string' || !actorId.trim()) throw new WorktreeError('actor', 'no-current-conversation');
      return validateData(request, await quietRPC(ctx, 'dsh-worktrees/execute', { v: 1, actorId, request }, signal));
    }
    function report(t, error) {
      if (error instanceof WorktreeError) return t(error.kind) + (error.code ? ' [' + error.code + ']' : '') + (error.message ? ': ' + error.message : '');
      return t('unknown') + (error?.message ? ': ' + error.message : '');
    }
    function currentActor(list) {
      const ids = Object.keys(list.byId).filter(id => (list.byId[id].retainedBy?.mainView || 0) > 0 && list.byId[id].origin !== 'subagent');
      return ids.length === 1 ? ids[0] : undefined;
    }
    function sourceEligible(snapshot) {
      return snapshot.blank === true && snapshot.subagent === null && snapshot.openState === 'open' && !snapshot.removed && !snapshot.running && !snapshot.promptAttempted && !snapshot.awaitingFirstTurn && snapshot.pendingSubmissions.length === 0;
    }
    function inputEmpty(input) { return input.phase === 'plain' && input.draft === '' && input.attachmentIds.length === 0 && input.queue.length === 0; }
    function captureDraft(input) { return { draft: input.draft, draftRev: input.draftRev, attachmentIds: [...input.attachmentIds], phase: input.phase }; }
    function draftUnchanged(before, after) {
      return before.phase === 'plain' && after.phase === 'plain' && before.draft === after.draft && before.draftRev === after.draftRev && before.attachmentIds.length === after.attachmentIds.length && before.attachmentIds.every((id, i) => id === after.attachmentIds[i]) && after.queue.length === 0;
    }
    function advertisedDefault(data, preferred = 'main') { return data.items.some(item => item.name === preferred) ? preferred : data.items.some(item => item.name === data.defaultBranch) ? data.defaultBranch : ''; }
    // The block setter compares reasons. Ownership is the *actual stored object*, never just its reason.
    function acquireBlock(blocks, sessionId, reason) {
      const store = blocks.storeFor(sessionId);
      if (store.getSnapshot() !== undefined) throw new WorktreeError('blocked', 'composer-already-blocked');
      const owned = Object.freeze({ reason });
      blocks.set(sessionId, owned);
      if (store.getSnapshot() !== owned) throw new WorktreeError('ownership', 'block-not-acquired');
      return { owned, store, release() { if (store.getSnapshot() === owned) blocks.set(sessionId, undefined); } };
    }
    function releaseAfterMainOwnership(ctx, reference, committed) {
      const ownership = ctx.sessions.retainInfo(reference.sessionId);
      const mainOwns = () => (ownership.getSnapshot().retainedBy.mainView || 0) > 0;
      if (!committed || mainOwns()) { reference.release(); return; }
      // A rare openSession failure after the synchronous Client commit must not
      // dispose the only destination generation and silently lose its draft.
      // Park our reference until the user opens this exact session, or plugin unload.
      let unsubscribe = () => {};
      const dispose = ctx.effect(() => () => { unsubscribe(); reference.release(); });
      unsubscribe = ownership.subscribe(() => { if (mainOwns()) dispose(); });
      if (mainOwns()) dispose();
    }
    const absolutePath = path => typeof path === 'string' && !path.includes('\0') && (/^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path));
    const uuid = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    function projectRequest(request) {
      const keys = { list: ['action', 'projectId'], create: ['action', 'id', 'title', 'folders'], update: ['action', 'projectId', 'title', 'folders'], bind: ['action', 'projectId', 'folderId', 'sessionId'], start: ['action', 'operationId', 'projectId', 'folderId'] }[request?.action];
      const title = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
      const folders = value => Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(absolutePath);
      let valid = keys && Object.keys(request).every(key => keys.includes(key));
      if (request?.action === 'list') valid = valid && (request.projectId === undefined || uuid(request.projectId));
      if (request?.action === 'create') valid = valid && uuid(request.id) && title(request.title) && folders(request.folders);
      if (request?.action === 'update') valid = valid && uuid(request.projectId) && (request.title !== undefined || request.folders !== undefined) && (request.title === undefined || title(request.title)) && (request.folders === undefined || folders(request.folders));
      if (request?.action === 'bind' || request?.action === 'start') valid = valid && uuid(request.projectId) && typeof request.folderId === 'string' && !!request.folderId && (request.action === 'bind' ? typeof request.sessionId === 'string' && !!request.sessionId : uuid(request.operationId));
      if (!valid) throw new WorktreeError('decode', 'invalid-project-request');
      return request;
    }
    function projectData(request, data) {
      const string = value => typeof value === 'string' && value.length > 0;
      const project = value => value && uuid(value.id) && string(value.title) && value.title.length <= 120 && Array.isArray(value.folders) && value.folders.length > 0 && value.folders.length <= 32 && value.folders.every(folder => string(folder?.id) && absolutePath(folder.path) && typeof folder.title === 'string') && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && !Object.is(value.createdAt, -0) && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0 && !Object.is(value.updatedAt, -0) && (value.imported === undefined || typeof value.imported === 'boolean');
      const binding = value => value && string(value.sessionId) && uuid(value.projectId) && string(value.folderId) && ['local', 'worktree'].includes(value.mode) && absolutePath(value.effectiveCwd) && (value.mode === 'worktree' ? uuid(value.worktreeId) : value.worktreeId === undefined);
      let valid;
      if (request.action === 'list') {
        valid = data && Array.isArray(data.projects) && data.projects.every(project) && Array.isArray(data.bindings) && data.bindings.every(binding);
        if (valid && data.records !== undefined) validateData({ action: 'list' }, { items: data.records });
      }
      else if (request.action === 'start') valid = data && string(data.sessionId) && data.workspaceId === request.folderId && binding(data.binding) && data.binding.sessionId === data.sessionId && data.binding.projectId === request.projectId && data.binding.folderId === request.folderId && data.binding.mode === 'local';
      else if (request.action === 'bind') valid = data && binding(data.binding) && data.binding.sessionId === request.sessionId && data.binding.projectId === request.projectId && data.binding.folderId === request.folderId;
      else valid = data && project(data.project) && data.project.id === (request.id || request.projectId);
      if (!valid) throw new WorktreeError('decode', 'invalid-project-' + request.action + '-data');
      return data;
    }
    async function requestProjects(ctx, actorId, request, signal) {
      projectRequest(request);
      if (actorId !== undefined && (typeof actorId !== 'string' || !actorId.trim())) throw new WorktreeError('actor', 'invalid-project-actor');
      return projectData(request, await quietRPC(ctx, 'dsh-worktrees/projects', { v: 1, request, ...(actorId === undefined ? {} : { actorId }) }, signal));
    }
    function workspaceStructure(snapshot) {
      return JSON.stringify([snapshot.phase, snapshot.items.map(item => [item.workspaceId, item.path, item.title, item.sessionIds])]);
    }
    function projectContext(snapshot, workspaces, sessionId) {
      const binding = snapshot.bindings.find(item => item.sessionId === sessionId);
      if (binding) {
        const project = snapshot.projects.find(item => item.id === binding.projectId);
        const folder = project?.folders.find(item => item.id === binding.folderId);
        return project && folder ? { project, folder, binding } : undefined;
      }
      // Local membership, not fork lineage, is the only safe fallback. Never
      // classify a fork as a worktree merely because it has a parentId.
      const workspace = workspaces.items.find(item => item.sessionIds.includes(sessionId));
      const project = snapshot.projects.find(item => item.folders.some(folder => folder.id === workspace?.workspaceId));
      const folder = project?.folders.find(item => item.id === workspace?.workspaceId);
      return folder ? { project, folder, binding: { sessionId, projectId: project.id, folderId: folder.id, mode: 'local', effectiveCwd: folder.path } } : undefined;
    }
    function captureProject(context) { return context ? Object.freeze({ projectId: context.project.id, folderId: context.folder.id, path: context.folder.path }) : undefined; }
    function sameProject(before, after) { return before?.projectId === after?.projectId && before?.folderId === after?.folderId && before?.path === after?.path; }
    function projectPath(status, captured) { return captured?.path || status.projectPath || status.repository.root; }
    function projectRows(metadata, workspaces, sessions, statuses, { query = '', archived = 'hide', selectedId } = {}) {
      const archives = new Set(workspaces.archivedSessionIds), pins = new Set(workspaces.pinnedSessionIds);
      const needle = query.trim().toLocaleLowerCase();
      const groups = metadata.projects.map(project => ({ project, rows: [] }));
      const unassigned = { project: null, rows: [] };
      for (const [id, session] of Object.entries(sessions.byId)) {
        if (session.origin === 'subagent' || (session.blank && id !== selectedId)) continue;
        const isArchived = archives.has(id);
        if ((archived === 'hide' && isArchived) || (archived === 'only' && !isArchived)) continue;
        const context = projectContext(metadata, workspaces, id);
        const title = session.title || '';
        if (needle && ![title, context?.project.title, context?.folder.title, context?.folder.path].some(value => value?.toLocaleLowerCase().includes(needle))) continue;
        const live = statuses.get(id);
        const children = sessions.projectionsBySession?.[id]?.values.subagentCatalog || [];
        const childRunning = children.some(child => (statuses.get(child.id)?.running ?? sessions.byId[child.id]?.running) === true);
        const row = { id, session, title, context, archived: isArchived, pinned: !isArchived && pins.has(id), running: (live?.running ?? session.running ?? false) || childRunning, pending: live?.pendingInteraction, done: live?.completionUnread === true };
        (groups.find(group => group.project.id === context?.project.id) || unassigned).rows.push(row);
      }
      for (const group of [...groups, unassigned]) group.rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.session.updatedAt || 0) - (a.session.updatedAt || 0) || a.id.localeCompare(b.id));
      return [...groups.filter(group => archived !== 'only' || group.rows.length), ...(unassigned.rows.length ? [unassigned] : [])];
    }
    function visibleProjectRows(rows, limit, selectedId) {
      let idle = 0;
      return rows.filter(row => row.running || row.pending || row.id === selectedId || idle++ < limit);
    }
    function projectActor(list) {
      const ids = Object.keys(list.byId).filter(id => (list.byId[id].retainedBy?.mainView || 0) > 0 && list.byId[id].origin !== 'subagent');
      return ids.length === 1 ? ids[0] : undefined;
    }
    function projectReady(reference, signal) {
      return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new WorktreeError('cancelled', 'cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(reference.ready).then(binding => { signal.removeEventListener('abort', abort); resolve(binding); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
      });
    }
    // One root-owned metadata cache. Reconnect and structural Workspace changes
    // refresh it; token/status updates and component mounts never issue reads.
    function createProjectStore(ctx, t) {
      let state = { projects: [], bindings: [], records: [], loading: false, error: '' }, serialized = '', disposed = false;
      let refreshRequest, sequence = 0, queued = false, structure = workspaceStructure(ctx.workspaces.list.getSnapshot());
      let generation = ctx.connection.generation.getSnapshot()?.id;
      const listeners = new Set(), operations = new Set();
      const publish = patch => { if (disposed) return; state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
      const store = { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
      const context = id => projectContext(state, ctx.workspaces.list.getSnapshot(), id);
      function install(data) {
        const next = JSON.stringify(data);
        if (next !== serialized) { serialized = next; publish(data); }
      }
      async function refresh() {
        if (disposed || ctx.connection.generation.getSnapshot() === undefined) return;
        refreshRequest?.abort(); refreshRequest = new AbortController(); const controller = refreshRequest, seq = ++sequence;
        publish({ loading: true, error: '' });
        try {
          const data = await requestProjects(ctx, undefined, { action: 'list' }, controller.signal);
          if (!disposed && !controller.signal.aborted && seq === sequence) { install(data); publish({ loading: false }); }
        } catch (failure) { if (!disposed && !controller.signal.aborted && seq === sequence) publish({ loading: false, error: report(t, failure) }); }
      }
      function schedule() {
        if (queued || disposed) return; queued = true;
        Promise.resolve().then(() => { queued = false; if (!disposed) void refresh(); });
      }
      const unsubscribeWorkspace = ctx.workspaces.list.subscribe(() => {
        const next = workspaceStructure(ctx.workspaces.list.getSnapshot());
        if (next !== structure) { structure = next; schedule(); }
      });
      const unsubscribeConnection = ctx.connection.generation.subscribe(() => {
        const next = ctx.connection.generation.getSnapshot()?.id;
        if (next !== generation) { generation = next; refreshRequest?.abort(); ++sequence; for (const op of operations) op.controller.abort(); if (next !== undefined) schedule(); }
      });
      async function mutate(request) {
        const controller = new AbortController(), op = { controller }; operations.add(op);
        try {
          const data = await requestProjects(ctx, projectActor(ctx.sessions.list.getSnapshot()), request, controller.signal);
          if (disposed || controller.signal.aborted) throw new WorktreeError('cancelled', 'cancelled');
          refreshRequest?.abort(); ++sequence;
          if (data.project) install({ projects: [...state.projects.filter(item => item.id !== data.project.id), data.project], bindings: state.bindings });
          if (data.binding) install({ projects: state.projects, bindings: [...state.bindings.filter(item => item.sessionId !== data.binding.sessionId), data.binding] });
          schedule(); return data;
        } finally { operations.delete(op); }
      }
      const api = { store, context, refresh, mutate,
        rememberRecords(records) { publish({ records: [...state.records.filter(item => !records.some(record => record.id === item.id)), ...records] }); },
        rememberWorktree(result, captured) {
          api.rememberRecords([result.worktree]);
          if (captured) install({ projects: state.projects, bindings: [...state.bindings.filter(item => item.sessionId !== result.sessionId), { sessionId: result.sessionId, projectId: captured.projectId, folderId: captured.folderId, mode: 'worktree', effectiveCwd: result.worktree.effectiveCwd, worktreeId: result.worktree.id }] });
          schedule();
        },
        dispose() { disposed = true; ++sequence; refreshRequest?.abort(); unsubscribeWorkspace(); unsubscribeConnection(); for (const op of operations) op.controller.abort(); operations.clear(); listeners.clear(); },
      };
      schedule(); return api;
    }
    function rootFolderValue(state) { return typeof state?.value?.root === 'string' ? state.value.root : ''; }
    async function writeRootFolder(form, draft, expectedRevision, reset = false) {
      const state = form?.state;
      if (!state || state.status !== 'ready' || !state.writable || state.mode !== 'host' || typeof form.mutate !== 'function') throw new WorktreeError('rootUnavailable', 'settings-unavailable');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new WorktreeError('rootUnavailable', 'missing-settings-revision');
      const root = typeof draft === 'string' ? draft.trim() : '';
      if (!reset && (!absolutePath(root) || root.length > 4096 || /[\u0000-\u001f\u007f]/u.test(root))) throw new WorktreeError('rootInvalid', 'invalid-root-path');
      const accepted = await form.mutate([reset ? { op: 'unset', path: ['root'] } : { op: 'set', path: ['root'], value: root }], expectedRevision);
      if (accepted !== true) throw new WorktreeError('rootConflict', 'root-setting-refused');
      return root;
    }
    const NATIVE_SUBMIT_ABI = '0.2.0-rc.2/default-sink-v1';
    const later = callback => { void Promise.resolve().then(() => Promise.resolve()).then(callback); };
    function interrupted(promise, signal) {
      return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(new WorktreeError('cancelled', 'cancelled')); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted) abort();
      });
    }
    // Approved, exact-version compatibility boundary. Only constructor callbacks
    // are leased: editor, submit machine, commands, codecs and rollback stay native.
    // Never replace a service, keyboard handler, DOM node, or native prompt route.
    function leaseNativeSink(input, binding, hooks) {
      const own = (object, key) => Object.getOwnPropertyDescriptor(object, key);
      const slot = own(input, 'deps'), deps = slot && 'value' in slot && slot.value;
      const sink = deps && own(deps, 'defaultSink'), triggers = deps && own(deps, 'inputTriggers'), actor = deps && own(deps, 'actx');
      if (!deps || !actor || !('value' in actor) || actor.value !== binding.ctx || !sink || !('value' in sink) || !sink.writable || typeof sink.value !== 'function' || sink.value.length !== 4 || !triggers || !('value' in triggers) || !triggers.writable || typeof triggers.value !== 'function') throw new WorktreeError('unsupported', 'native-submit-abi', NATIVE_SUBMIT_ABI);
      const original = sink.value, originalTriggers = triggers?.value, tokens = new Map(), active = new Set();
      const shutdown = new AbortController(); let closing = false, closeTask;
      const track = promise => { active.add(promise); void promise.then(() => active.delete(promise), () => active.delete(promise)); return promise; };
      function finish(token, error) {
        if (token.finished) return; token.finished = true;
        token.nativeSignal.removeEventListener('abort', token.abort);
        later(() => { hooks.settled(token.choice, error); tokens.delete(token.nativeSignal); token.done(); });
      }
      function tokenFor(nativeSignal) {
        if (tokens.has(nativeSignal)) return tokens.get(nativeSignal);
        const controller = new AbortController(); let done;
        const token = { nativeSignal, controller, signal: AbortSignal.any([nativeSignal, controller.signal, shutdown.signal]), entered: false, finished: false, donePromise: new Promise(resolve => { done = resolve; }), done: () => done(), choice: undefined, abort: () => {} };
        token.choice = hooks.capture(token.signal, controller);
        token.abort = () => finish(token, new WorktreeError('cancelled', 'native-attempt-cancelled'));
        nativeSignal.addEventListener('abort', token.abort, { once: true }); tokens.set(nativeSignal, token);
        if (nativeSignal.aborted) token.abort();
        return token;
      }
      async function adapter(text, ids, mode, nativeSignal) {
        let token;
        try {
          token = tokenFor(nativeSignal); token.entered = true;
          if (closing || token.signal.aborted) throw new WorktreeError('cancelled', 'cancelled');
          if (token.choice.mode === 'local') { await hooks.beforeLocal?.(ids, token.signal); return await track(interrupted(original.call(deps, text, ids, mode, token.signal), token.signal)); }
          return await track(hooks.submit(token.choice, text, ids, mode, token.signal));
        } catch (error) { return { kind: 'error', text: hooks.error(error) }; }
        finally { if (token) finish(token); }
      }
      const controllers = new WeakMap();
      function triggerAdapter() {
        const controller = originalTriggers?.call(deps);
        if (!controller) return controller;
        if (controllers.has(controller)) return controllers.get(controller);
        const bound = new Map();
        const proxy = new Proxy(controller, { get(target, key) {
          if (key === 'adjudicate' || key === 'serializeReference') {
            if (!bound.has(key)) bound.set(key, async (...args) => {
              let token;
              try {
                const signal = key === 'adjudicate' ? args[1] : args[2]; token = tokenFor(signal);
                const next = [...args]; next[key === 'adjudicate' ? 1 : 2] = token.signal;
                const result = await track(interrupted(Reflect.apply(Reflect.get(target, key, target), target, next), next[key === 'adjudicate' ? 1 : 2]));
                if (key === 'adjudicate' && result !== undefined) finish(token);
                return result;
              } catch (error) { if (token) { token.controller.abort(); finish(token, error); } throw error; }
            });
            return bound.get(key);
          }
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          if (!bound.has(key)) bound.set(key, value.bind(target)); return bound.get(key);
        } });
        controllers.set(controller, proxy); return proxy;
      }
      Object.defineProperty(deps, 'defaultSink', { ...sink, value: adapter });
      if (triggers) Object.defineProperty(deps, 'inputTriggers', { ...triggers, value: triggerAdapter });
      return { abi: NATIVE_SUBMIT_ABI,
        cancelNew() { for (const token of tokens.values()) if (token.choice.mode === 'new') token.controller.abort(); },
        close() {
          if (closeTask) return closeTask; closing = true; shutdown.abort();
          closeTask = (async () => {
            await Promise.allSettled([...active]);
            await Promise.resolve(); await Promise.resolve();
            // A cancelled codec/adjudicator must settle natively before restoring
            // callbacks; otherwise its late sink could accidentally send Local.
            await Promise.allSettled([...tokens.values()].map(token => token.donePromise));
            if (own(input, 'deps')?.value === deps && own(deps, 'defaultSink')?.value === adapter) Object.defineProperty(deps, 'defaultSink', sink);
            if (triggers && own(input, 'deps')?.value === deps && own(deps, 'inputTriggers')?.value === triggerAdapter) Object.defineProperty(deps, 'inputTriggers', triggers);
          })(); return closeTask;
        },
      };
    }
    function setupProgress(data, operationId, previous = 0) {
      const stages = ['fetching', 'creating', 'naming', 'opening', 'ready'];
      if (!data || data.operationId !== operationId || !Number.isSafeInteger(data.revision) || data.revision <= previous || typeof data.terminal !== 'boolean' || !Array.isArray(data.stages) || data.stages.length > 8 || !data.stages.every(item => item && stages.includes(item.stage) && item.operationId === operationId && (item.worktreeId === undefined || uuid(item.worktreeId)))) throw new WorktreeError('decode', 'invalid-progress');
      return data;
    }
    async function prepareWorktree(ctx, actorId, request, signal, onProgress) {
      const watching = new AbortController(), watchSignal = AbortSignal.any([signal, watching.signal]);
      const progress = (async () => {
        let revision = 0;
        for (;;) {
          const data = setupProgress(await quietRPC(ctx, 'dsh-worktrees/progress', { v: 1, actorId, operationId: request.operationId, after: revision }, watchSignal), request.operationId, revision);
          revision = data.revision; onProgress(data.stages);
          if (data.terminal) return;
        }
      })();
      let progressFailure;
      void progress.catch(error => { progressFailure = error; watching.abort(); });
      try {
        const result = validateData(request, await quietRPC(ctx, 'dsh-worktrees/prepare', { v: 1, actorId, request }, signal));
        await progress;
        if (progressFailure) throw progressFailure;
        return result;
      } finally { watching.abort(); await Promise.allSettled([progress]); }
    }
    function waitForDraftFiles(conversation, ids, signal) {
      const descriptors = conversation.resolveDraftAttachments(ids);
      if (descriptors.length !== ids.length) return Promise.reject(new WorktreeError('filesLost', 'draft-files-unavailable'));
      const files = descriptors.filter(item => item.kind === 'file');
      return new Promise((resolve, reject) => {
        let unsubscribe = () => {}, done = false;
        const finish = error => { if (done) return; done = true; unsubscribe(); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const abort = () => finish(new WorktreeError('cancelled', 'cancelled'));
        const check = () => {
          const uploads = conversation.fileUploads.getSnapshot();
          const missing = files.find(item => !uploads[item.id]), failed = files.find(item => uploads[item.id]?.status === 'error');
          if (missing) finish(new WorktreeError('filesLost', 'file-upload-unavailable'));
          else if (failed) finish(new WorktreeError('upload', 'file-upload-failed', uploads[failed.id].message));
          else if (files.every(item => uploads[item.id]?.status === 'ready')) finish();
        };
        unsubscribe = conversation.fileUploads.subscribe(check); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); else check();
      });
    }
    function createWorktreeFlow(ctx, t, projects) {
      const conversation = ctx.get('conversation'), listeners = new Set(), leases = new Map(), operations = new Set(), restaged = new Set();
      let state = { sessionId: undefined, mode: 'local', busy: false, loading: false, error: '', status: null, remote: '', branch: '', branches: null, query: '', steps: [], phase: '', op: null };
      let query, generation = 0, disposed = false;
      const publish = patch => { if (disposed) return; state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
      const store = { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
      const pending = id => ctx.uiSession.sessionStatus.getSnapshot().get(id)?.pendingInteraction !== undefined;
      function source(sessionId) {
        const binding = ctx.sessions.binding(sessionId), input = binding && conversation.input.for(binding.ctx);
        if (!binding || projectActor(ctx.sessions.list.getSnapshot()) !== sessionId || !sourceEligible(binding.session.getSnapshot()) || pending(sessionId)) throw new WorktreeError('changed', 'source-not-blank-idle');
        return { binding, input, project: captureProject(projects.context(sessionId)) };
      }
      function check(op) {
        if (disposed || op.signal.aborted || op.navigation.aborted) throw new WorktreeError('cancelled', 'cancelled');
        const current = source(op.sessionId);
        if (current.binding !== op.binding || !sameProject(current.project, op.project)) throw new WorktreeError('changed', 'source-changed');
        if (op.block.store.getSnapshot() !== op.block.owned) throw new WorktreeError('ownership', 'block-lost');
      }
      function capture(sessionId, binding, signal, controller) {
        if (state.sessionId !== sessionId || state.mode !== 'new') return { mode: 'local' };
        if (state.busy) throw new WorktreeError('busy', 'first-message-already-preparing');
        const captured = source(sessionId); if (captured.binding !== binding) throw new WorktreeError('changed', 'binding-changed');
        const old = state.op;
        if (old && !old.retryable) throw new WorktreeError('recovery', 'check-created-conversation-before-retry');
        const intent = Object.freeze({ remote: state.remote, branch: state.branch, branches: state.branches && Object.freeze({ ...state.branches, items: Object.freeze(state.branches.items.map(item => Object.freeze({ ...item }))) }) });
        query?.abort(); ++generation;
        const navigation = ctx.layout.beginNavigation();
        const op = { ...captured, intent, mode: 'new', id: old?.id || crypto.randomUUID(), sessionId, controller, signal, navigation, result: old?.result || null, request: old?.request || null, retryable: false, admission: 'none', reference: null, sourceReference: null, staged: false, cleanup: () => {} };
        op.sourceReference = ctx.sessions.retain(sessionId, { source: 'controllerOperation' });
        try { op.block = acquireBlock(conversation.blocks, sessionId, t('preparingMessage')); }
        catch (error) { op.sourceReference.release(); throw error; }
        const cancel = () => controller.abort(), changed = () => { if (op.committing) return; try { check(op); } catch { cancel(); } };
        const subscriptions = [ctx.sessions.list, binding.session, projects.store, ctx.uiSession.sessionStatus, op.block.store].map(item => item.subscribe(changed));
        navigation.addEventListener('abort', cancel, { once: true });
        op.cleanup = () => { navigation.removeEventListener('abort', cancel); subscriptions.splice(0).forEach(remove => remove()); op.block.release(); };
        operations.add(op); publish({ op, busy: true, loading: false, error: '', steps: [], phase: 'preparing' }); return op;
      }
      function settled(op, preflightError) {
        if (op?.mode !== 'new') return;
        if (!op.sinkEntered) { op.retryable = true; publish({ busy: false, op: null, phase: '', error: preflightError ? report(t, preflightError) : '' }); }
        op.cleanup(); operations.delete(op);
        if (op.sourceReference) { if (disposed || op.accepted) op.sourceReference.release(); else releaseAfterMainOwnership(ctx, op.sourceReference, true); op.sourceReference = null; }
        if (op.reference) { if (disposed) op.reference.release(); else releaseAfterMainOwnership(ctx, op.reference, !!op.accepted); op.reference = null; }
      }
      async function submit(op, text, ids, mode, signal) {
        op.sinkEntered = true; op.text = text; op.ids = [...ids];
        try {
          check(op);
          if (!text.trim() && !ids.length) { publish({ busy: false, phase: '', op: null }); return { kind: 'success' }; }
          publish({ phase: 'fetching' });
          if (!op.result) {
            const status = await requestHost(ctx, op.sessionId, { action: 'status', ...(op.project ? { repoPath: op.project.path } : {}) }, signal); check(op);
            const remote = op.intent.remote || (status.remotes.some(item => item.name === status.defaults?.remote) ? status.defaults.remote : status.remotes[0]?.name || '');
            if (!remote) throw new WorktreeError('noRemote', 'no-remote');
            const identity = status.remotes.find(item => item.name === remote)?.identity;
            const advertised = op.intent.branches && op.intent.remote === remote ? op.intent.branches : await requestHost(ctx, op.sessionId, { action: 'branches', repoPath: projectPath(status, op.project), remote, remoteIdentity: identity, limit: 100 }, signal); check(op);
            const branch = op.intent.branch || advertisedDefault(advertised, status.defaults?.branch); if (!branch) throw new WorktreeError('noRemote', 'select-remote-base');
            op.request = Object.freeze({ action: 'create', operationId: op.id, repoPath: projectPath(status, op.project), remote, remoteIdentity: advertised.remoteIdentity, remoteBranch: branch, sourceSessionId: op.sessionId, sessionMode: 'new', requireBlankSource: true, settingsHash: status.settingsHash, firstPrompt: text, ...(op.project ? { projectId: op.project.projectId, folderId: op.project.folderId } : {}) });
            op.result = await prepareWorktree(ctx, op.sessionId, op.request, signal, steps => publish({ steps, phase: steps.at(-1)?.stage || 'fetching' })); check(op);
          } else if (op.request?.firstPrompt !== text) throw new WorktreeError('changed', 'retry-message-changed');
          const result = op.result;
          if (result.sessionId === op.sessionId || result.worktree.state !== 'ready' || !result.worktree.branch) throw new WorktreeError('invalidSession', 'invalid-prepared-target');
          projects.rememberWorktree(result, op.project); check(op);
          op.reference = ctx.sessions.retain(result.sessionId, { source: 'controllerOperation' });
          const target = await projectReady(op.reference, signal); check(op);
          if (!sourceEligible(target.session.getSnapshot()) || pending(result.sessionId) || !inputEmpty(conversation.input.for(target.ctx).state.getSnapshot()) || conversation.blocks.storeFor(result.sessionId).getSnapshot() !== undefined) throw new WorktreeError('targetBusy', 'target-not-empty');
          publish({ phase: 'attachments' });
          if (ids.length) { conversation.rebindDraftFiles(result.sessionId, ids); op.staged = true; await waitForDraftFiles(conversation, ids, signal); }
          check(op);
          const settings = await requestHost(ctx, op.sessionId, { action: 'status', operationId: op.id }, signal); check(op);
          if (settings.settingsHash !== result.settingsHash) throw new WorktreeError('settings', 'settings-changed-before-send');
          publish({ phase: 'sending' }); op.admission = 'pending';
          let outcome;
          try { outcome = await conversation.sendSession(target.session, text, ids, mode, signal); }
          catch (error) { op.admission = 'unknown'; throw new WorktreeError('uncertain', 'check-destination-before-resending', error?.message || ''); }
          if (outcome.kind !== 'success') {
            const snapshot = target.session.getSnapshot(), code = snapshot.promptError?.op === 'send' && snapshot.promptError.error?.code;
            op.admission = typeof code === 'string' && !code.startsWith('gateway/') && snapshot.blank && !snapshot.running && !snapshot.pendingSubmissions.length ? 'refused' : 'unknown';
            op.retryable = op.admission === 'refused'; throw new WorktreeError(op.retryable ? 'host' : 'uncertain', 'prompt-' + op.admission, outcome.text || '');
          }
          op.admission = 'success'; op.accepted = true; op.committing = true;
          publish({ busy: false, phase: 'complete', mode: 'local', op: null, error: '' });
          later(() => { if (!disposed && !op.navigation.aborted && projectActor(ctx.sessions.list.getSnapshot()) === op.sessionId) { op.cleanup(); ctx.uiWorkspace.openSession(result.sessionId); } });
          return outcome;
        } catch (error) {
          if (op.staged && !op.accepted) { conversation.rebindDraftFiles(op.sessionId, ids); ids.forEach(id => restaged.add(id)); }
          if (op.admission === 'none' && !op.request) op.retryable = true;
          publish({ busy: false, failedAt: state.phase, phase: 'failed', error: report(t, error), ...(op.retryable && !op.result ? { op: null } : {}) });
          return { kind: 'error', text: report(t, error) };
        }
      }
      function observe(sessionId) {
        const binding = ctx.sessions.binding(sessionId); if (!binding || leases.has(binding)) return;
        const input = conversation.input.for(binding.ctx);
        const lease = leaseNativeSink(input, binding, { capture: (signal, controller) => capture(sessionId, binding, signal, controller), submit, settled, beforeLocal: async (ids, signal) => { if (ids.some(id => restaged.has(id))) { await waitForDraftFiles(conversation, ids, signal); ids.forEach(id => restaged.delete(id)); } }, error: error => report(t, error) });
        leases.set(binding, lease);
        const stop = binding.ctx.effect(() => async () => { try { await lease.close(); } finally { leases.delete(binding); } });
        lease.stopScope = stop;
      }
      function select(sessionId, mode) {
        if (disposed || !['local', 'new'].includes(mode)) return;
        try {
          const current = source(sessionId); observe(sessionId);
          if (mode === 'local' && projects.context(sessionId)?.binding.mode === 'worktree') {
            if (!inputEmpty(current.input.state.getSnapshot())) throw new WorktreeError('draftWarning', 'keep-existing-draft');
            for (const lease of leases.values()) lease.cancelNew(); ctx.uiWorkspace.startSession(current.project.folderId); return;
          }
          if (mode === 'local') { for (const lease of leases.values()) lease.cancelNew(); }
          publish({ sessionId, mode, error: '', ...(state.sessionId === sessionId ? {} : { status: null, branches: null, branch: '', remote: '', op: null, steps: [], phase: '' }) });
        } catch (error) { publish({ sessionId, mode: 'local', error: report(t, error) }); }
      }
      async function loadBranches(sessionId, text = '', more = false) {
        if (disposed || state.busy || state.sessionId !== sessionId || !state.status || !state.remote || (more && !state.branches?.nextCursor)) return;
        try { source(sessionId); } catch (error) { publish({ error: report(t, error) }); return; }
        query?.abort(); query = new AbortController(); const controller = query, seq = ++generation, before = state.branches, remote = state.remote, project = captureProject(projects.context(sessionId));
        publish({ loading: true, query: text, ...(more ? {} : { branches: null, branch: '' }) });
        try {
          const data = await requestHost(ctx, sessionId, { action: 'branches', repoPath: projectPath(state.status, project), remote, remoteIdentity: state.status.remotes.find(item => item.name === remote)?.identity, query: text, ...(more ? { cursor: before.nextCursor } : {}), limit: 100 }, controller.signal);
          if (disposed || controller.signal.aborted || seq !== generation) return;
          const names = new Set(more ? before.items.map(item => item.name) : []), branches = { ...data, items: [...(more ? before.items : []), ...data.items.filter(item => !names.has(item.name))] };
          publish({ branches, branch: more ? state.branch : text ? '' : advertisedDefault(branches, state.status.defaults?.branch), loading: false });
        } catch (error) { if (!controller.signal.aborted && seq === generation) publish({ loading: false, error: report(t, error) }); }
      }
      async function configure(sessionId) {
        if (disposed || state.busy) return;
        try { source(sessionId); } catch (error) { publish({ error: report(t, error) }); return; }
        query?.abort(); query = new AbortController(); const controller = query, seq = ++generation, project = captureProject(projects.context(sessionId));
        publish({ sessionId, loading: true, status: null, branches: null, branch: '', remote: '', error: '' });
        try {
          const status = await requestHost(ctx, sessionId, { action: 'status', ...(project ? { repoPath: project.path } : {}) }, controller.signal);
          if (disposed || controller.signal.aborted || seq !== generation) return;
          const remote = status.remotes.some(item => item.name === status.defaults?.remote) ? status.defaults.remote : status.remotes[0]?.name || '';
          publish({ status, remote, loading: false }); if (remote) await loadBranches(sessionId);
        } catch (error) { if (!controller.signal.aborted && seq === generation) publish({ loading: false, error: report(t, error) }); }
      }
      async function reconcile(sessionId) {
        const op = state.sessionId === sessionId && state.op; if (!op || state.busy) return;
        try {
          const data = await requestHost(ctx, sessionId, { action: 'status', operationId: op.id });
          if (data.worktree) projects.rememberRecords([data.worktree]);
          if (data.operation.phase === 'ready' && data.sessionId && data.worktree) { op.result = { ...data, workspaceId: data.operation.workspaceId, settingsHash: data.operation.settingsHash }; op.retryable = op.admission === 'none' || op.admission === 'refused'; }
          publish({ error: data.operation.error?.message || t('retained') });
        } catch (error) { publish({ error: report(t, error), ...(error?.kind === 'host' && error.code === 'NOT_FOUND' ? { op: null } : {}) }); }
      }
      const unselect = ctx.sessions.list.subscribe(() => { for (const op of operations) if (!op.committing && projectActor(ctx.sessions.list.getSnapshot()) !== op.sessionId) op.controller.abort(); });
      const reconnect = ctx.connection.generation.subscribe(() => { query?.abort(); ++generation; for (const lease of leases.values()) lease.cancelNew(); publish({ loading: false, status: null, branches: null, branch: '', remote: '' }); });
      return { store, observe, select, configure, loadBranches, reconcile,
        cancel() { for (const lease of leases.values()) lease.cancelNew(); },
        setRemote(sessionId, remote) { if (!state.busy && state.sessionId === sessionId && state.status?.remotes.some(item => item.name === remote)) { publish({ remote, query: '' }); void loadBranches(sessionId); } },
        setBranch(branch) { if (!state.busy && state.branches?.items.some(item => item.name === branch)) publish({ branch }); },
        openTarget(sessionId) { const op = state.sessionId === sessionId && state.op; if (op?.result?.sessionId) ctx.uiWorkspace.openSession(op.result.sessionId); },
        async dispose() { disposed = true; query?.abort(); ++generation; unselect(); reconnect(); for (const op of operations) op.controller.abort(); await Promise.allSettled([...leases.values()].map(lease => lease.close())); for (const lease of leases.values()) lease.stopScope?.(); leases.clear(); },
      };
    }
    const projectSlotName = key => PANEL + '.projects.' + key;
    const projectSlots = ['sidebar.workspaces.directoryFlow', 'sidebar.workspaces.session.menu.item', 'sidebar.workspaces.session.row.action', 'sidebar.session.row.leading', 'sidebar.session.row.hover'];
    function projectChildren(ctx) {
      return Object.fromEntries(projectSlots.map(key => [projectSlotName(key), { kind: key.endsWith('directoryFlow') ? 'single' : 'list', scope: 'root', ...(key.endsWith('menu.item') ? { inject: { hooks: { menuOpenState: (_standard, state) => () => state, shortcuts: ctx.shortcuts.catalog } } } : {}) }]));
    }
    // SlotRegistry.entriesOfSlot/subscribe/inject are PUBLIC SDK methods. The
    // native browser stays registered, and owns its original child declarations.
    // Only plugin-owned aliases are declared/mirrored; unloading never clears or
    // redeclares installed extension seats. Copy their inject/locale/store faces,
    // not DOM or private components from a Harness module import.
    function mirrorProjectSlot(ctx, source, destination = projectSlotName(source)) {
      return ctx.slots.inject(destination, () => ctx.slots.inject(source, () => {
        const copies = new Map();
        const clear = () => { for (const dispose of copies.values()) dispose(); copies.clear(); };
        const synchronize = () => {
          const entries = ctx.slots.entriesOfSlot(source);
          for (const [entry, dispose] of copies) if (!entries.includes(entry)) { dispose(); copies.delete(entry); }
          for (const entry of entries) {
            if (copies.has(entry)) continue;
            const children = entry.children && Object.fromEntries(Object.entries(entry.children).map(([key, spec]) => [projectSlotName(key), spec]));
            const component = children ? props => h(entry.component, { ...props, renderSlot: (key, owner, options) => props.renderSlot(projectSlotName(key), owner, options), ...(props.renderSlotChain ? { renderSlotChain: (key, owner, options) => props.renderSlotChain(projectSlotName(key), owner, options) } : {}) }) : entry.component;
            const remove = ctx.slots.register({ ...entry.options, name: destination, ...(entry.inject ? { inject: entry.inject } : {}), ...(entry.locale ? { locale: entry.locale } : {}), ...(entry.store ? { store: entry.store } : {}), ...(entry.select ? { select: entry.select } : {}), ...(children ? { children } : {}) }, component);
            const nested = Object.keys(entry.children || {}).map(key => mirrorProjectSlot(ctx, key));
            copies.set(entry, () => { for (const dispose of nested) dispose(); remove(); });
          }
        };
        synchronize(); const unsubscribe = ctx.slots.subscribe(source, synchronize);
        return () => { unsubscribe(); clear(); };
      }));
    }
    function createSidebarMode(register) {
      const listeners = new Set(); let native = false, registration = register(), disposed = false;
      const store = { getSnapshot: () => native, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
      return { store, toggle() { if (disposed) return; if (native) registration = register(); else { registration(); registration = null; } native = !native; for (const listener of [...listeners]) listener(); }, dispose() { disposed = true; registration?.(); listeners.clear(); } };
    }
    function Icon({ size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('path', { d: 'M6 5v14M6 9h6a6 6 0 0 0 6-6M6 15h6a6 6 0 0 1 6 6' }),
        ...[[6, 3], [6, 21], [18, 3], [18, 21]].map(([cx, cy]) => h('circle', { key: cx + '-' + cy, cx, cy, r: 2 })));
    }
    const Styles = () => h('style', null, css);
    const Button = ({ children, ...props }) => h('button', { type: 'button', ...props }, children);
    function Dialog({ title, close, t, children }) {
      const ref = React.useRef(null);
      const heading = React.useId();
      React.useEffect(() => {
        const dialog = ref.current;
        dialog.showModal();
        return () => { if (dialog.open) dialog.close(); };
      }, []);
      return h('dialog', { ref, className: 'dsh-wt dsh-wt-dialog', 'aria-labelledby': heading, onCancel: event => { event.preventDefault(); close(); } },
        h(Styles), h('div', { className: 'dsh-wt-row dsh-wt-between' }, h('h2', { id: heading }, title), h(Button, { onClick: close, autoFocus: true }, t('close'))), children);
    }
    function FolderBrowser({ runtime: ctx, t, picked, close }) {
      const [listing, setListing] = React.useState(null), [path, setPath] = React.useState(''), [name, setName] = React.useState(''), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false);
      const active = React.useRef(null), generation = React.useRef(0);
      React.useEffect(() => { void scan(); return () => { active.current?.abort(); ++generation.current; }; }, []);
      async function scan(next) {
        active.current?.abort(); const controller = new AbortController(); active.current = controller; const seq = ++generation.current;
        setBusy(true); setError('');
        try { const data = await ctx.uiWorkspace.listDirectory(next, controller.signal); if (!controller.signal.aborted && seq === generation.current) { setListing(data); setPath(data.path); } }
        catch (failure) { if (!controller.signal.aborted && seq === generation.current) setError(report(t, failure)); }
        finally { if (!controller.signal.aborted && seq === generation.current) setBusy(false); }
      }
      return h(Dialog, { title: t('chooseFolder'), close, t },
        h('form', { onSubmit: event => { event.preventDefault(); void scan(path); } }, h('label', { className: 'dsh-wt-field' }, t('absolutePath'), h('input', { value: path, onChange: event => setPath(event.target.value) })), h('button', { type: 'submit', disabled: busy || !absolutePath(path) }, t('browse'))),
        listing && h(React.Fragment, null, h('div', { className: 'dsh-wt-row' }, ...listing.crumbs.map(crumb => h(Button, { key: crumb.path, disabled: busy, onClick: () => { void scan(crumb.path); } }, crumb.name))),
          h('div', { className: 'dsh-wt-folder-browser' }, ...listing.entries.map(entry => h(Button, { key: entry.path, disabled: busy, onClick: () => { void scan(entry.path); } }, '▱ ' + entry.name))),
          h(Button, { disabled: busy, onClick: () => picked(listing.path) }, t('chooseThisFolder')),
          h('form', { onSubmit: async event => { event.preventDefault(); const seq = generation.current; setBusy(true); setError(''); try { const created = await ctx.uiWorkspace.createDirectory(listing.path, name.trim()); if (seq === generation.current) { setName(''); await scan(created); } } catch (failure) { if (seq === generation.current) { setError(report(t, failure)); setBusy(false); } } } },
            h('label', null, t('folderName'), h('input', { value: name, onChange: event => setName(event.target.value) })), h('button', { type: 'submit', disabled: busy || !name.trim() }, t('createFolder')))),
        busy && h('p', { role: 'status' }, t('loading')), error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error));
    }
    function ProjectEditor({ project, runtime: ctx, projects, renderSlot, t, close }) {
      const [title, setTitle] = React.useState(project?.title || ''), [folders, setFolders] = React.useState(project?.folders.map(folder => folder.path) || []), [path, setPath] = React.useState('');
      const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [browser, setBrowser] = React.useState(false), [flow, setFlow] = React.useState(false);
      const lifetime = React.useRef(true), id = React.useRef(project?.id || crypto.randomUUID());
      React.useEffect(() => () => { lifetime.current = false; }, []);
      function add(path) { if (!absolutePath(path)) { setError(t('absolutePath')); return; } setFolders(previous => [...new Set([...previous, path])]); setPath(''); setBrowser(false); setFlow(false); setError(''); }
      async function save(event) {
        event.preventDefault(); setBusy(true); setError('');
        try { await projects.mutate(project ? { action: 'update', projectId: project.id, title: title.trim(), folders } : { action: 'create', id: id.current, title: title.trim(), folders }); if (lifetime.current) close(); }
        catch (failure) { if (lifetime.current) setError(report(t, failure)); }
        finally { if (lifetime.current) setBusy(false); }
      }
      return h(Dialog, { title: t(project ? 'editProject' : 'newProject'), close, t },
        h('form', { onSubmit: save }, h('label', { className: 'dsh-wt-field' }, t('projectName'), h('input', { required: true, maxLength: 120, value: title, disabled: busy, onChange: event => setTitle(event.target.value) })),
          h('h3', null, t('folders')), h('ul', { className: 'dsh-wt-folder-list' }, ...folders.map(folder => h('li', { key: folder }, h('code', null, folder), h(Button, { disabled: busy, onClick: () => setFolders(previous => previous.filter(path => path !== folder)), 'aria-label': t('remove') + ' ' + folder }, '×')))),
          h('label', { className: 'dsh-wt-field' }, t('absolutePath'), h('input', { value: path, disabled: busy, onChange: event => setPath(event.target.value) })),
          h('div', { className: 'dsh-wt-row' }, h(Button, { disabled: busy || !absolutePath(path) || folders.length >= 32, onClick: () => add(path.trim()) }, t('addFolder')),
            h(Button, { disabled: busy || folders.length >= 32, onClick: async () => { setError(''); try { const selected = await ctx.uiWorkspace.pickDirectory(); if (lifetime.current && selected) add(selected); } catch (failure) { if (lifetime.current) { setError(report(t, failure)); setBrowser(true); } } } }, t('chooseDirectory')),
            h(Button, { disabled: busy || folders.length >= 32, onClick: () => setBrowser(true) }, t('browse'))),
          error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error), h('button', { type: 'submit', disabled: busy || !title.trim() || !folders.length || folders.length > 32 }, t(busy ? 'loading' : 'save'))),
        renderSlot(projectSlotName('sidebar.workspaces.directoryFlow'), { open: flow, busy, onPicked: add, onCancel: () => setFlow(false), onError: message => { setError(message); setFlow(false); } }),
        browser && h(FolderBrowser, { runtime: ctx, t, picked: add, close: () => setBrowser(false) }));
    }
    function ThreadRow({ row, selected, runtime: ctx, metadata, renderSlot, t }) {
      const [menu, setMenu] = React.useState(false), [hover, setHover] = React.useState(false);
      const record = metadata.records.find(item => item.id === row.context?.binding.worktreeId);
      const worktree = row.context?.binding.mode === 'worktree';
      const path = row.context?.binding.effectiveCwd || row.context?.folder.path || '';
      const title = row.session.blank ? t('blankThread') : row.title || t('untitled');
      const marker = (worktree ? t('worktreeThread') : t('localThread')) + (row.context ? ' · ' + row.context.folder.path : '') + (record?.branch ? ' · ' + record.branch : '') + (worktree ? ' · ' + path : '');
      const status = row.pending ? t('waiting') : row.running ? t('busy') : row.done ? t('done') : t('idle');
      const owner = { sessionId: row.id, displayTitle: row.title };
      return h('div', { className: 'dsh-wt-thread' + (row.archived ? ' dsh-wt-thread-archived' : ''), role: 'treeitem', 'aria-selected': selected, 'aria-description': row.archived ? t('archived') : undefined },
        h('div', { className: 'dsh-wt-thread-main' }, h(Button, { disabled: row.archived, title: title + ' · ' + status + (worktree ? ' · ' + marker : ''), onClick: () => ctx.uiWorkspace.openSession(row.id) },
          h('span', { className: 'dsh-wt-thread-leading', 'aria-label': !row.archived && (row.pending || row.running || row.done) ? status : undefined }, !row.archived && !row.session.blank && (row.pending || row.running || row.done ? h('span', { className: 'dsh-wt-thread-status' + (row.pending ? ' dsh-wt-thread-pending' : '') }, row.pending ? '●' : row.running ? '◌' : '✓') : renderSlot(projectSlotName('sidebar.session.row.leading'), { sessionId: row.id }))),
          h('span', { className: 'dsh-wt-thread-title' }, title)),
          row.pinned && h('span', { className: 'dsh-wt-muted', title: t('pinned'), 'aria-label': t('pinned') }, '⌖'),
          worktree ? h('span', { className: 'dsh-wt-branch-chip', title: marker, 'aria-label': marker, role: 'img' }, h(Icon, { size: 13 })) : h('span', { className: 'dsh-wt-muted', title: marker, 'aria-label': marker }, '·'),
          !row.session.blank && h('span', { className: 'dsh-wt-thread-actions' }, h(Button, { 'aria-label': t('threadActions') + ' ' + title, onClick: () => setMenu(true) }, '…'), renderSlot(projectSlotName('sidebar.workspaces.session.row.action'), owner), h(Button, { 'aria-label': t('threadDetails'), onClick: () => setHover(value => !value), 'aria-expanded': hover }, 'ⓘ'))),
        hover && h('div', { className: 'dsh-wt-thread-hover' }, h('div', null, title), h('div', { className: 'dsh-wt-muted' }, status), worktree && record?.branch && h('div', null, h('code', null, record.branch)), h('code', null, path), renderSlot(projectSlotName('sidebar.session.row.hover'), { sessionId: row.id })),
        menu && h(Dialog, { title: t('threadActions'), t, close: () => setMenu(false) }, h('div', { role: 'menu', className: 'dsh-wt-project-menu', onKeyDown: event => { if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; const items = [...event.currentTarget.querySelectorAll('[role=menuitem]:not(:disabled)')]; if (!items.length) return; event.preventDefault(); const at = items.indexOf(event.target); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); } }, renderSlot(projectSlotName('sidebar.workspaces.session.menu.item'), owner, { hookContext: [menu, setMenu] }))));
    }
    function ProjectGroup({ group, selectedId, runtime, metadata, projects, renderSlot, t, searching }) {
      const [collapsed, setCollapsed] = React.useState(false), [limit, setLimit] = React.useState(5), [choosingFolder, setChoosingFolder] = React.useState(false), [editing, setEditing] = React.useState(false);
      const rows = searching ? group.rows : visibleProjectRows(group.rows, limit, selectedId);
      function start(folderId) { setChoosingFolder(false); runtime.uiWorkspace.startSession(folderId); }
      return h('section', null, h('div', { className: 'dsh-wt-project-head' }, h(Button, { title: group.project?.folders.map(folder => folder.path).join('\n'), 'aria-expanded': searching || !collapsed, onClick: () => { setCollapsed(value => !value); setLimit(5); }, 'aria-label': t(collapsed ? 'expand' : 'collapse') + ' ' + (group.project?.title || t('unassigned')) }, h('span', { 'aria-hidden': true }, collapsed && !searching ? '▸' : '▾'), h('span', { 'aria-hidden': true }, '▱'), h('span', { className: 'dsh-wt-project-title' }, group.project?.title || t('unassigned'))),
        group.project && h(React.Fragment, null, h(Button, { 'aria-label': t('newThread') + ' ' + group.project.title, title: t('newThread'), onClick: () => group.project.folders.length === 1 ? start(group.project.folders[0].id) : setChoosingFolder(value => !value) }, '+'), h(Button, { 'aria-label': t('editProject') + ' ' + group.project.title, title: t('editProject'), onClick: () => setEditing(true) }, '…'))),
        choosingFolder && h('div', { className: 'dsh-wt-row', 'aria-label': t('chooseFolder') }, ...group.project.folders.map(folder => h(Button, { key: folder.id, title: folder.path, onClick: () => start(folder.id) }, folder.title))),
        (searching || !collapsed) && h('div', { role: 'group' }, ...rows.map(row => h(ThreadRow, { key: row.id, row, selected: row.id === selectedId, runtime, metadata, renderSlot, t })), !searching && group.rows.length > rows.length && h(Button, { onClick: () => setLimit(value => value + 5) }, t('showMore')), !searching && limit > 5 && group.rows.length <= rows.length && h(Button, { onClick: () => setLimit(5) }, t('showLess'))),
        editing && h(ProjectEditor, { project: group.project, runtime, projects, renderSlot, t, close: () => setEditing(false) }));
    }
    function SidebarToggle({ sidebarMode, wide, t }) {
      const native = React.useSyncExternalStore(sidebarMode.store.subscribe, sidebarMode.store.getSnapshot);
      return h('span', { className: 'dsh-wt' }, h(Styles), h(Button, { title: t(native ? 'projects' : 'folderView'), 'aria-label': t(native ? 'projects' : 'folderView'), 'aria-pressed': !native, onClick: sidebarMode.toggle }, '▱', wide && ' ' + t(native ? 'projects' : 'folderView')));
    }
    function ProjectsSidebar({ runtime: ctx, projects, t, wide, expandSidebar, useWorkspaces, useSessions, usePanelInfo, useSessionStatus, renderSlot }) {
      const workspaces = useWorkspaces(value => value), sessions = useSessions(value => value), panel = usePanelInfo(value => value.activePanelId), statuses = useSessionStatus(value => value);
      const metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot);
      const [query, setQuery] = React.useState(''), [archived, setArchived] = React.useState('hide'), [creating, setCreating] = React.useState(false);
      const selectedId = panel ? undefined : Object.keys(sessions.byId).find(id => (sessions.byId[id].retainedBy?.mainView || 0) > 0);
      const groups = projectRows(metadata, workspaces, sessions, statuses, { query, archived, selectedId });
      if (!wide) return h('div', { className: 'dsh-wt dsh-wt-projects' }, h(Styles), h(Button, { title: t('projects'), 'aria-label': t('projects'), onClick: expandSidebar }, '▱'));
      return h('section', { className: 'dsh-wt dsh-wt-projects', 'aria-label': t('projects') }, h(Styles), h('div', { className: 'dsh-wt-projects-header' }, h('strong', null, t('projects')), h(Button, { 'aria-label': t('newProject'), title: t('newProject'), onClick: () => setCreating(true) }, '+')),
        h('input', { type: 'search', value: query, placeholder: t('filterThreads'), 'aria-label': t('filterThreads'), onChange: event => setQuery(event.target.value) }),
        h('select', { 'aria-label': t('archived'), value: archived, onChange: event => setArchived(event.target.value) }, h('option', { value: 'hide' }, t('hideArchived')), h('option', { value: 'all' }, t('allThreads')), h('option', { value: 'only' }, t('archivedOnly'))),
        metadata.loading && h('span', { role: 'status', className: 'dsh-wt-muted' }, t('loading')), metadata.error && h('div', null, h('p', { role: 'alert', className: 'dsh-wt-error' }, metadata.error), h(Button, { onClick: () => { void projects.refresh(); } }, t('refresh'))),
        h('div', { className: 'dsh-wt-project-list', role: 'tree', 'aria-label': t('projects') }, ...groups.map(group => h(ProjectGroup, { key: group.project?.id || 'unassigned', group, selectedId, runtime: ctx, metadata, projects, renderSlot, t, searching: !!query.trim() }))),
        !metadata.projects.length && !metadata.loading && h('p', { className: 'dsh-wt-muted' }, t('noProjects')), creating && h(ProjectEditor, { projects, runtime: ctx, renderSlot, t, close: () => setCreating(false) }));
    }
    function NewWorktreeControls({ sessionId, flow, projects, t, useSession, useInput }) {
      const snapshot = useSession(value => value), empty = useInput(inputEmpty);
      const state = React.useSyncExternalStore(flow.store.subscribe, flow.store.getSnapshot);
      const metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot), context = projects.context(sessionId);
      const [options, setOptions] = React.useState(false);
      React.useEffect(() => { if (!snapshot.blank || snapshot.subagent !== null) return; try { flow.observe(sessionId); } catch { /* New mode reports the guarded ABI refusal. */ } }, [flow, sessionId, snapshot.blank, snapshot.subagent]);
      if (!snapshot.blank || snapshot.subagent !== null) return null;
      const worktree = context?.binding.mode === 'worktree', record = metadata.records.find(item => item.id === context?.binding.worktreeId);
      const selected = state.sessionId === sessionId, busy = selected && state.busy;
      return h('div', { className: 'dsh-wt dsh-wt-row dsh-wt-create-controls' }, h(Styles),
        h('select', { 'aria-label': t('threadMode'), value: selected && state.mode === 'new' ? 'new' : worktree ? 'worktree' : 'local', disabled: busy || !sourceEligible(snapshot),
          onChange: event => { setOptions(false); flow.select(sessionId, event.target.value); } },
          h('option', { value: 'local', disabled: worktree && !context?.folder }, t('local')),
          worktree && h('option', { value: 'worktree' }, t('worktreeThread')),
          h('option', { value: 'new' }, t('new'))),
        worktree && h('span', { className: 'dsh-wt-muted', title: context.binding.effectiveCwd }, record?.branch || t('worktreeThread')),
        !worktree && h(Button, { disabled: busy || !sourceEligible(snapshot), 'aria-expanded': options, 'aria-label': t('branch'), onClick: () => { setOptions(value => !value); if (!options) void flow.configure(sessionId); } }, selected && state.branch ? state.remote + '/' + state.branch : t('select')),
        options && h('fieldset', { className: 'dsh-wt-base-options', onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setOptions(false); } } }, h('legend', null, t('branch')),
          selected && state.status?.remotes.length > 1 && h('select', { 'aria-label': t('remote'), disabled: busy || state.loading, value: state.remote, onChange: event => flow.setRemote(sessionId, event.target.value) }, ...state.status.remotes.map(item => h('option', { key: item.name, value: item.name }, item.name))),
          h('select', { 'aria-label': t('branch'), value: selected ? state.branch : '', disabled: !selected || state.loading || busy, onChange: event => flow.setBranch(event.target.value) }, h('option', { value: '' }, t(state.loading ? 'loading' : 'select')), ...(selected && state.branches?.items || []).map(item => h('option', { key: item.name, value: item.name }, item.name))),
          h('input', { type: 'search', 'aria-label': t('search'), value: selected ? state.query : '', disabled: !selected || busy || !state.remote, onChange: event => { void flow.loadBranches(sessionId, event.target.value); } }),
          selected && state.branches?.nextCursor && h(Button, { disabled: state.loading || busy, onClick: () => { void flow.loadBranches(sessionId, state.query, true); } }, t('more')),
          h(Button, { disabled: busy || state.loading, onClick: () => { void flow.configure(sessionId); } }, t('refresh')), h(Button, { onClick: () => setOptions(false) }, t('close'))),
        selected && state.error && h('span', { className: 'dsh-wt-create-error', role: 'alert' }, state.error,
          state.op && h(React.Fragment, null, ' · ', h('code', null, state.op.id), h(Button, { disabled: state.loading, onClick: () => { void flow.reconcile(sessionId); } }, t('reconcile')), state.op.result?.sessionId && h(Button, { onClick: () => flow.openTarget(sessionId) }, t('open')))));
    }
    function SetupProgress({ sessionId, flow, t }) {
      const state = React.useSyncExternalStore(flow.store.subscribe, flow.store.getSnapshot);
      if (state.sessionId !== sessionId || (!state.busy && !state.error && !state.steps.length)) return null;
      const labels = { preparing: 'preparingMessage', fetching: 'fetchingLatest', creating: 'creatingWorktree', naming: 'namingBranch', opening: 'openingConversation', ready: 'setupReady', attachments: 'stagingAttachments', sending: 'startingConversation', complete: 'setupReady', failed: 'setupFailed' };
      const active = state.phase, failed = active === 'failed' ? state.failedAt : undefined;
      const completed = new Set(state.steps.filter(step => step.stage !== failed).map(step => step.stage));
      return h('section', { className: 'dsh-wt dsh-wt-progress', 'aria-label': t('setupProgress'), 'aria-busy': state.busy }, h(Styles),
        h('div', { className: 'dsh-wt-row dsh-wt-between' }, h('strong', { role: 'status', 'aria-live': 'polite' }, t(labels[active] || 'setupProgress')), state.busy && h(Button, { onClick: flow.cancel }, t('cancelSetup'))),
        h('ol', null, ...['fetching', 'creating', 'naming'].map(stage => h('li', { key: stage, 'data-active': active === stage, 'aria-current': active === stage ? 'step' : undefined }, h('span', { 'aria-hidden': true }, failed === stage ? '× ' : completed.has(stage) && active !== stage ? '✓ ' : active === stage ? '◌ ' : '○ '), t(labels[stage])))),
        state.error && h('p', { role: 'alert', className: 'dsh-wt-error' }, state.error),
        !state.busy && state.op && h('div', { className: 'dsh-wt-row' }, h('code', null, state.op.id), h(Button, { onClick: () => { void flow.reconcile(sessionId); } }, t('reconcile')), state.op.result?.sessionId && h(Button, { onClick: () => flow.openTarget(sessionId) }, t('open'))));
    }
    // Keep the header passive: worktree details are loaded over quiet RPC only
    // after the user opens the manager, never on an ordinary conversation mount.
    function RootFolderSettings({ view, form, t }) {
      if (view === 'summary') return h('span', null, t('rootSummary'));
      return h(RootFolderSettingsPage, { form, t });
    }
    function RootFolderSettingsPage({ form, t }) {
      const state = form?.state, value = rootFolderValue(state);
      const [draft, setRootDraft] = React.useState(value), [revision, setRevision] = React.useState(state?.revision), [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [saved, setSaved] = React.useState(false);
      const pendingSave = React.useRef(null), alive = React.useRef(true), field = React.useId(), hint = React.useId();
      React.useEffect(() => () => { alive.current = false; }, []);
      React.useEffect(() => {
        if (!dirty || (pendingSave.current && state?.revision !== pendingSave.current.revision && (pendingSave.current.reset || value === pendingSave.current.root))) {
          setRootDraft(value); setRevision(state?.revision); setDirty(false); pendingSave.current = null;
        }
      }, [value, state?.revision, dirty]);
      const writable = state?.status === 'ready' && state.writable && state.mode === 'host';
      async function save(reset = false) {
        if (busy) return; setBusy(true); setError(''); setSaved(false);
        try {
          const root = await writeRootFolder(form, draft, revision, reset);
          if (alive.current) { pendingSave.current = { root, reset, revision }; if (reset || root === value) setDirty(false); setSaved(true); }
        } catch (failure) { if (alive.current) setError(report(t, failure)); }
        finally { if (alive.current) setBusy(false); }
      }
      return h('section', { className: 'dsh-wt dsh-wt-card', 'aria-label': t('rootFolder') }, h(Styles),
        h('form', { onSubmit: event => { event.preventDefault(); void save(); } },
          h('label', { className: 'dsh-wt-field', htmlFor: field }, t('rootFolder'), h('input', { id: field, value: draft, maxLength: 4096, disabled: !writable || busy, 'aria-describedby': hint, onChange: event => { setRootDraft(event.target.value); setDirty(true); setSaved(false); setError(''); } })),
          h('p', { id: hint, className: 'dsh-wt-muted' }, t('rootHelp')),
          h('div', { className: 'dsh-wt-row' }, h('button', { type: 'submit', disabled: !writable || busy || !dirty }, t(busy ? 'loading' : 'save')), h(Button, { disabled: !writable || busy, onClick: () => { void save(true); } }, t('rootReset'))),
          !writable && h('p', { role: 'status', className: 'dsh-wt-muted' }, t(state?.status === 'loading' ? 'loading' : 'rootUnavailable')),
          saved && h('p', { role: 'status', 'aria-live': 'polite', className: 'dsh-wt-muted' }, t('rootSaved')),
          error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error)));
    }
    function Header({ projects, sessionId, t, useSession }) {
      const blank = useSession(value => value.blank);
      const metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot), context = projects.context(sessionId);
      if (blank || !context) return null;
      const worktree = context.binding.mode === 'worktree', record = metadata.records.find(item => item.id === context.binding.worktreeId);
      const label = [context.project.title, t(worktree ? 'worktreeThread' : 'local'), record?.branch].filter(Boolean).join(' · ');
      return h('span', { className: 'dsh-wt dsh-wt-muted', title: context.binding.effectiveCwd }, h(Styles), label);
    }
    function Manager({ runtime: ctx, projects, t, useSessions, usePanelInfo, useSessionStatus }) {
      const list = useSessions(value => value);
      const activePanel = usePanelInfo(value => value.activePanelId);
      const sessionStatuses = useSessionStatus(value => value);
      const actorId = currentActor(list);
      const [records, setRecords] = React.useState([]);
      const [cursor, setCursor] = React.useState(undefined);
      const [archived, setArchived] = React.useState(false);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);
      const [revision, setRevision] = React.useState(0);
      const [previewRecord, setPreviewRecord] = React.useState(null);
      const lifetime = React.useRef(null);
      const generation = React.useRef(0);
      React.useEffect(() => {
        const controller = new AbortController(); lifetime.current = controller;
        const seq = ++generation.current;
        setRecords([]); setCursor(undefined); setError('');
        if (!actorId || activePanel !== PANEL) return () => controller.abort();
        setLoading(true);
        requestHost(ctx, actorId, { action: 'list', includeArchived: archived, limit: 50 }, controller.signal).then(data => {
          if (seq !== generation.current || controller.signal.aborted) return;
          if (!Array.isArray(data?.items)) throw new WorktreeError('decode', 'invalid-list');
          setRecords(data.items); projects?.rememberRecords(data.items); setCursor(data.nextCursor);
        }).catch(failure => { if (seq === generation.current && !controller.signal.aborted) setError(report(t, failure)); }).finally(() => { if (seq === generation.current && !controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, [ctx, actorId, archived, revision, activePanel]);
      async function more() {
        const controller = lifetime.current; const seq = generation.current;
        setLoading(true);
        try {
          const data = await requestHost(ctx, actorId, { action: 'list', includeArchived: archived, cursor, limit: 50 }, controller.signal);
          if (controller.signal.aborted || seq !== generation.current) return;
          setRecords(previous => [...previous, ...data.items.filter(item => !previous.some(record => record.id === item.id))]); setCursor(data.nextCursor);
        } catch (failure) { if (!controller.signal.aborted && seq === generation.current) setError(report(t, failure)); }
        finally { if (!controller.signal.aborted && seq === generation.current) setLoading(false); }
      }
      return h('section', { className: 'dsh-wt dsh-wt-panel', 'aria-label': t('title') }, h(Styles),
        h('div', { className: 'dsh-wt-row dsh-wt-between' }, h('h2', null, t('title')), h(Button, { onClick: () => ctx.layout.selectPanel(null) }, t('close'))),
        h('p', { className: 'dsh-wt-muted' }, t('retained')),
        !actorId ? h('p', { role: 'status' }, t('actor')) : h(React.Fragment, null,
          h('div', { className: 'dsh-wt-row' }, h(Button, { disabled: loading, onClick: () => setRevision(value => value + 1) }, t('refresh')),
            h('label', null, h('input', { type: 'checkbox', checked: archived, onChange: event => setArchived(event.target.checked) }), t('includeArchived'))),
          loading && h('p', { role: 'status' }, t('loading')),
          !loading && records.length === 0 && h('p', null, t('empty')),
          ...records.map(record => h(RecordCard, { key: record.id, record, runtime: ctx, t, actorId, list, sessionStatuses, onChanged: () => setRevision(value => value + 1), onPreview: () => setPreviewRecord(record) })),
          cursor && h(Button, { disabled: loading, onClick: more }, t('more'))),
        error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error),
        previewRecord && h(Handoff, { key: previewRecord.id + ':' + actorId, record: previewRecord, actorId, runtime: ctx, t, close: () => setPreviewRecord(null) }));
    }
    function RecordCard({ record, runtime: ctx, t, actorId, list, sessionStatuses, onChanged, onPreview }) {
      const [checkout, setCheckout] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [name, setName] = React.useState('');
      const [branchDialog, setBranchDialog] = React.useState(false);
      const [operationStatus, setOperationStatus] = React.useState(null);
      const controller = React.useRef(null);
      React.useEffect(() => {
        const abort = new AbortController(); controller.current = abort;
        requestHost(ctx, actorId, { action: 'status', id: record.id }, abort.signal).then(data => { if (!abort.signal.aborted) setCheckout(data.status); }).catch(failure => { if (!abort.signal.aborted) setError(t('statusError') + ': ' + report(t, failure)); });
        return () => abort.abort();
      }, [ctx, actorId, record]);
      async function act(request, open) {
        const signal = controller.current.signal;
        const navigation = open ? ctx.layout.beginNavigation() : null;
        setBusy(true); setError('');
        try {
          const data = await requestHost(ctx, actorId, { ...request, id: record.id }, signal);
          if (signal.aborted) return;
          if (open) {
            if (!data?.sessionId) throw new WorktreeError('invalidSession', 'missing-exact-session');
            if (!navigation.aborted && currentActor(ctx.sessions.list.getSnapshot()) === actorId) ctx.uiWorkspace.openSession(data.sessionId);
          } else { setBranchDialog(false); onChanged(); }
        } catch (failure) { if (!signal.aborted) setError(report(t, failure)); }
        finally { if (!signal.aborted) setBusy(false); }
      }
      return h('article', { className: 'dsh-wt-card' },
        h('div', { className: 'dsh-wt-row dsh-wt-between' }, h('h3', null, record.branch || t('detached')), h('span', { className: 'dsh-wt-muted' }, t(record.protected ? 'protected' : 'unprotected') + (record.archived ? ' · ' + t('archived') : ''))),
        h('dl', { className: 'dsh-wt-details' },
          h('dt', null, t('base')), h('dd', null, record.remote + '/' + record.remoteBranch + ' · ' + record.baseOid.slice(0, 12)),
          h('dt', null, t('state')), h('dd', null, record.state + (checkout ? ' · ' + t(checkout.dirty ? 'dirty' : 'clean') + ' · ' + checkout.changes + ' / ' + checkout.untracked : '')),
          h('dt', null, t('local')), h('dd', null, h('code', null, record.effectiveCwd)),
          h('dt', null, t('sessions')), h('dd', null, ...record.sessionIds.map(id => h('div', { key: id, className: 'dsh-wt-row' }, h(Button, { onClick: () => ctx.uiWorkspace.openSession(id) }, list.byId[id]?.displayTitle || id), h('span', { className: 'dsh-wt-muted' }, t(sessionStatuses.get(id)?.running ? 'busy' : 'idle')))))),
        record.error && h('p', { role: 'alert', className: 'dsh-wt-error' }, record.error),
        h('div', { className: 'dsh-wt-row' },
          h(Button, { disabled: busy || record.archived || record.state !== 'ready', onClick: () => act({ action: 'start', sourceSessionId: actorId, sessionMode: 'continue' }, true) }, t('open')),
          h(Button, { disabled: busy || record.archived, onClick: () => setBranchDialog(true) }, t('createBranch')),
          h(Button, { disabled: busy, onClick: () => act({ action: 'protect', protected: !record.protected }) }, t(record.protected ? 'unprotect' : 'protect')),
          h(Button, { disabled: busy, onClick: () => act({ action: 'archive', archived: !record.archived }) }, t(record.archived ? 'restore' : 'archive')),
          h(Button, { disabled: busy || record.state !== 'ready' || !record.sessionIds.includes(actorId), onClick: onPreview }, t('preview'))),
        !record.sessionIds.includes(actorId) && h('p', { className: 'dsh-wt-muted' }, t('openSource')),
        h('p', { className: 'dsh-wt-muted' }, t('operation') + ': ', h('code', null, record.operationId)),
        h(Button, { disabled: busy, onClick: async () => {
          const signal = controller.current.signal;
          try { const data = await requestHost(ctx, actorId, { action: 'status', operationId: record.operationId }, signal); if (!signal.aborted) setOperationStatus(data); }
          catch (failure) { if (!signal.aborted) setError(report(t, failure)); }
        } }, t('reconcile')),
        operationStatus && h('p', { role: 'status' }, t('state') + ': ' + operationStatus.operation.phase),
        error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error),
        branchDialog && h(Dialog, { title: t('createBranch'), t, close: () => setBranchDialog(false) }, h('form', { onSubmit: event => { event.preventDefault(); void act({ action: 'branch', name }); } },
          h('label', { className: 'dsh-wt-field' }, t('branchName'), h('input', { value: name, required: true, onChange: event => setName(event.target.value) })),
          h('button', { type: 'submit', disabled: busy || !name.trim() }, t('createBranch')))));
    }
    function Handoff({ record, actorId, runtime: ctx, t, close }) {
      const [preview, setPreview] = React.useState(null);
      const [exported, setExported] = React.useState(null);
      const [targetPath, setTargetPath] = React.useState('');
      const [noWriters, setNoWriters] = React.useState(false);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [operationId, setOperationId] = React.useState(null);
      const [operationStatus, setOperationStatus] = React.useState(null);
      const [copied, setCopied] = React.useState(false);
      const lifetime = React.useRef(new AbortController());
      const request = React.useRef(null);
      const seq = React.useRef(0);
      React.useEffect(() => () => { lifetime.current.abort(); request.current?.abort(); }, []);
      function changed(value) { request.current?.abort(); ++seq.current; setTargetPath(value); setPreview(null); setExported(null); setNoWriters(false); setBusy(false); setOperationId(null); }
      async function loadPreview() {
        if (!actorId) { setError(t('actor')); return; }
        request.current?.abort(); const controller = new AbortController(); request.current = controller;
        const generation = ++seq.current; setBusy(true); setPreview(null); setExported(null); setError(''); setNoWriters(false); setOperationId(null); setOperationStatus(null);
        try {
          const data = await requestHost(ctx, actorId, { action: 'preview', id: record.id, sourceSessionId: actorId, ...(targetPath.trim() ? { targetPath: targetPath.trim() } : {}) }, controller.signal);
          if (lifetime.current.signal.aborted || controller.signal.aborted || generation !== seq.current) return;
          if (!data?.id || data.worktreeId !== record.id || !Array.isArray(data.files)) throw new WorktreeError('decode', 'invalid-preview');
          setPreview(data);
        } catch (failure) { if (!lifetime.current.signal.aborted && !controller.signal.aborted && generation === seq.current) setError(report(t, failure)); }
        finally { if (!lifetime.current.signal.aborted && !controller.signal.aborted && generation === seq.current) setBusy(false); }
      }
      async function exportPatch() {
        const saved = preview; const generation = seq.current;
        setBusy(true);
        try {
          const data = await requestHost(ctx, actorId, { action: 'export', previewId: saved.id }, lifetime.current.signal);
          if (lifetime.current.signal.aborted || generation !== seq.current) return;
          if (typeof data?.path !== 'string' || data.patchHash !== saved.patchHash) throw new WorktreeError('decode', 'export-preview-mismatch');
          setExported(data);
        } catch (failure) { if (!lifetime.current.signal.aborted && generation === seq.current) setError(report(t, failure)); }
        finally { if (!lifetime.current.signal.aborted && generation === seq.current) setBusy(false); }
      }
      async function apply() {
        if (!noWriters || !preview || busy || currentActor(ctx.sessions.list.getSnapshot()) !== actorId) return;
        const navigation = ctx.layout.beginNavigation();
        const controller = new AbortController(); request.current?.abort(); request.current = controller;
        const generation = ++seq.current;
        const id = operationId || crypto.randomUUID(); setOperationId(id); setBusy(true); setError('');
        const cancel = () => controller.abort(); navigation.addEventListener('abort', cancel, { once: true });
        try {
          const data = await requestHost(ctx, actorId, { action: 'handoff', id: record.id, previewId: preview.id, operationId: id }, controller.signal);
          if (controller.signal.aborted || lifetime.current.signal.aborted || navigation.aborted || generation !== seq.current || currentActor(ctx.sessions.list.getSnapshot()) !== actorId) return;
          if (!data?.sessionId) throw new WorktreeError('invalidSession', 'missing-exact-local-session');
          ctx.uiWorkspace.openSession(data.sessionId);
          close();
        } catch (failure) { if (!lifetime.current.signal.aborted && generation === seq.current) setError(report(t, failure)); }
        finally { navigation.removeEventListener('abort', cancel); if (!lifetime.current.signal.aborted && generation === seq.current) setBusy(false); }
      }
      async function reconcile() {
        try { const data = await requestHost(ctx, actorId, { action: 'status', operationId }, lifetime.current.signal); if (!lifetime.current.signal.aborted) setOperationStatus(data); }
        catch (failure) { if (!lifetime.current.signal.aborted) setError(report(t, failure)); }
      }
      return h(Dialog, { title: t('previewTitle'), t, close: () => { request.current?.abort(); close(); } },
        h('p', { className: 'dsh-wt-muted' }, t('handoffWarning')),
        h('label', { className: 'dsh-wt-field' }, t('target'), h('input', { value: targetPath, disabled: busy, placeholder: t('original'), onChange: event => changed(event.target.value) })),
        h(Button, { disabled: busy || !actorId, onClick: loadPreview }, t('preview')),
        preview && h(React.Fragment, null,
          h('dl', { className: 'dsh-wt-details' }, h('dt', null, t('target')), h('dd', null, h('code', null, preview.targetRoot)), h('dt', null, t('base')), h('dd', null, h('code', null, preview.baseOid)), h('dt', null, t('bytes')), h('dd', null, preview.bytes), h('dt', null, t('patch')), h('dd', null, h('code', null, exported?.path || preview.patchPath))),
          h('h3', null, t('files')), h('ul', null, ...preview.files.map(file => h('li', { key: file.path }, file.status + ' · ' + file.path + (file.binary ? ' · ' + t('binary') : '')))),
          h('div', { className: 'dsh-wt-row' }, h(Button, { disabled: busy, onClick: exportPatch }, t('export')), h(Button, { onClick: async () => { try { await navigator.clipboard.writeText(exported?.path || preview.patchPath); if (!lifetime.current.signal.aborted) setCopied(true); } catch (failure) { if (!lifetime.current.signal.aborted) setError(report(t, failure)); } } }, t(copied ? 'copied' : 'copy'))),
          exported?.patch && h('pre', null, exported.patch),
          h('label', null, h('input', { type: 'checkbox', checked: noWriters, disabled: busy, onChange: event => setNoWriters(event.target.checked) }), t('noWriters')),
          h(Button, { className: 'dsh-wt-primary', disabled: busy || !noWriters, onClick: apply }, t('apply'))),
        busy && h('p', { role: 'status' }, t('loading')),
        error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error),
        operationId && h('div', null, h('p', null, t('operation') + ': ', h('code', null, operationId)), h(Button, { disabled: busy, onClick: reconcile }, t('reconcile')),
          operationStatus && h('div', null, h('p', null, t('state') + ': ' + operationStatus.operation.phase), operationStatus.operation.error && h('p', { role: 'alert' }, operationStatus.operation.error.code + ': ' + operationStatus.operation.error.message), operationStatus.sessionId && h(Button, { onClick: () => ctx.uiWorkspace.openSession(operationStatus.sessionId) }, t('open')))));
    }
    return {
      inject: ['slots', 'locale', 'conversation', 'sessions', 'uiSession', 'uiWorkspace', 'layout', 'connection', 'workspaces', 'shortcuts'],
      // Export pure protocol/guard functions for Node tests, not a second renderer or service.
      protocol: Object.freeze({ rootFolderValue, writeRootFolder, decodeReply, validateData, currentActor, sourceEligible, inputEmpty, captureDraft, draftUnchanged, advertisedDefault, acquireBlock, NATIVE_SUBMIT_ABI, interrupted, leaseNativeSink, setupProgress, prepareWorktree, waitForDraftFiles, createWorktreeFlow, requestHost, absolutePath, projectRequest, projectData, requestProjects, workspaceStructure, projectContext, captureProject, sameProject, projectPath, projectRows, visibleProjectRows, projectActor, projectReady, createProjectStore, projectSlotName, projectChildren, mirrorProjectSlot, createSidebarMode }),
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }));
        const projects = createProjectStore(ctx, ctx.locale.bind(NS));
        ctx.effect(() => () => projects.dispose());
        const flow = createWorktreeFlow(ctx, ctx.locale.bind(NS), projects);
        ctx.effect(() => () => flow.dispose());
        let sidebarMode;
        const seat = (owner, options, component) => ctx.slots.inject(owner, () => ctx.slots.register({ ...options, locale: NS, inject: () => ({ runtime: ctx, flow, projects, sidebarMode }) }, component));
        sidebarMode = createSidebarMode(() => seat('sidebar.workspaces', { name: 'sidebar.workspaces', priority: -50, children: projectChildren(ctx) }, ProjectsSidebar));
        ctx.effect(() => () => sidebarMode.dispose());
        for (const source of projectSlots) mirrorProjectSlot(ctx, source);
        seat('sidebar.footer.action', { name: 'sidebar.footer.action', id: PANEL + '-projects-view', order: 450 }, SidebarToggle);
        seat('conversation.input.left', { name: 'conversation.input.left', id: PANEL, order: 15 }, NewWorktreeControls);
        seat('conversation.input.dock', { name: 'conversation.input.dock', id: PANEL + '-setup', order: 5 }, SetupProgress);
        seat('plugins.row.config', { name: 'plugins.row.config', key: 'dsh-worktrees#git-worktrees' }, RootFolderSettings);
        seat('conversation.session.header.actions', { name: 'conversation.session.header.actions', id: PANEL, order: 250 }, Header);
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 450, label: () => ctx.locale.bind(NS)('title') }, Icon));
        seat('main', { name: 'main', key: PANEL }, Manager);
      },
    };
  },
});
