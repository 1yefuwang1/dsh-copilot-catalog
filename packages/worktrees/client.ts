/// <reference path="./client.types.d.ts" />
/* Persistent browser Client half, strictly typed at build time. Guarded rc.2 submit adapter; no DOM interception.
 * Projects replace only the workspace browsing hole; native views and row
 * extensions remain installed, with owned aliases and a Folder view fallback.
 */
window.__ModuleLoader__.load({
  id: '@1yefuwang1/dsh-worktrees',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'worktrees.ui';
    const PANEL = 'dsh-worktrees';
    const VIEW_SWITCH = PANEL + '-projects-view';
    const en = {
      searchProjects: 'Search projects and sessions', closeSearch: 'Close search', viewOptions: 'View options',
      switchProjectsView: 'Switch to Projects View', switchWorkspaceView: 'Switch to Workspace View',
      'time.now': 'now', 'time.minutes': '{n}min', 'time.hours': '{n}h', 'time.days': '{n}d', 'time.months': '{n}mo', 'time.years': '{n}y', 'date.ymd': '{y}-{m}-{d}', lastActive: 'Last active {time}',
      projects: 'Projects', folderView: 'Folder view', newProject: 'New project', editProject: 'Manage project', projectName: 'Project name', project: 'Project', folders: 'Folders', folder: 'Folder', addFolder: 'Add folder', chooseDirectory: 'Choose a folder…', browse: 'Browse folders', absolutePath: 'Absolute Host directory path', save: 'Save', newThread: 'New thread', threadMode: 'Thread mode', threadActions: 'Thread actions', threadDetails: 'Thread details', unassigned: 'Other threads', showMore: 'Show {n} more sessions', showLess: 'Show less', filterThreads: 'Search threads or projects', allThreads: 'All threads', archivedOnly: 'Archived only', hideArchived: 'Hide archived', untitled: 'Untitled', blankThread: 'New thread', collapse: 'Collapse project', expand: 'Expand project', waiting: 'Waiting for interaction', done: 'Finished, not yet viewed', localThread: 'Local thread', worktreeThread: 'Worktree thread', draftWarning: 'This draft contains text or attachments. Keep it in this thread before choosing another project or folder.', chooseFolder: 'Choose a folder', createFolder: 'Create folder', folderName: 'Folder name', chooseThisFolder: 'Use this folder', noProjects: 'Add a project to organize your threads.',
      repoUnavailable: 'Worktree mode is unavailable or unverified for this folder. Choose Local to continue.', checkingRepository: 'Checking worktree availability…',
      projectChanged: 'The project or selected folder changed. Choose Local or keep the current folder before selecting New worktree again.', keepCurrentFolder: 'Keep current folder',
      removeProject: 'Remove project', removeProjectConfirm: 'Remove this project?', removeProjectHelp: 'Only the project metadata will be removed. All folders, files, conversations and worktrees will be kept. Conversations remain available under Other threads and in Folder view.',
      mainFolder: 'Main folder', main: 'Main', chooseMainFolder: 'Select the main folder', mainFolderRequired: 'Choose a main folder from the project source folders.', mainFolderHelp: 'Default for new conversations. You can choose another folder before sending.', conversationFolder: 'Conversation folder',
      createProject: 'Create project', sourceFolders: 'Source folders', localFolders: 'Browse for folders', enterFolderPath: 'Enter a folder path', checkingFolderOptions: 'Checking available folder options…', browseUnavailable: 'This session cannot list Host folders. Enter an absolute Host folder path instead.', folderPickerUnavailable: 'The native folder chooser is unavailable here. Browse folders or enter an absolute Host folder path instead.', add: 'Add', cancel: 'Cancel', selectedFolders: 'Selected folders', selectFolder: 'Select folder', folderLimit: 'A project can contain at most 32 folders.', invalidFolder: 'Enter a valid absolute Host folder path.', alreadyAdded: 'Already added', multiFolderHelp: 'Select multiple folders using the checkboxes. Selections are kept as you browse.', hostFolderHelp: 'Folders are on the Host computer; adding them does not move files.', noSubfolders: 'No subfolders.', directoryTruncated: 'This listing is truncated. Enter a path to browse other folders.',
      rootFolder: 'Worktree root folder', rootSummary: 'Choose where new worktrees are created.', rootHelp: 'Absolute folder path on the Host, outside your source repositories. Changes apply to new worktrees only; existing directories and in-flight creates are not moved.', rootReset: 'Reset to inherited default', rootSaved: 'Saved. New worktrees will use this location.', rootUnavailable: 'Host-backed settings are unavailable for this entry.', rootInvalid: 'Enter a valid absolute Host folder path.', rootConflict: 'The setting changed or the Host refused the write. Your draft is preserved; reopen this page to read the latest value.',
      cleanupTitle: 'Workspace cleanup', cleanupEnabled: 'Automatically reclaim inactive worktrees', cleanupDays: 'Inactivity days', cleanupHelp: 'Counts user messages only. Opening a thread does not reset the timer. Loaded conversation runtimes, active work, and protected worktrees defer cleanup; retrying may require a server restart.', cleanupDanger: 'Cleanup permanently deletes uncommitted, untracked, and ignored files. Git branches and conversation history are retained. Archive status does not exempt a worktree.', cleanupSaved: 'Cleanup settings saved.', cleanupInvalid: 'Choose a whole number of days from 1 to 3650.', cleanupConflict: 'The setting changed or the Host refused the write. Your draft is preserved.', reclaimed: 'Worktree reclaimed', cleanupDeferred: 'Cleanup deferred', gcWarning: 'This worktree was garbage-collected after inactivity. Unsaved files were discarded; Git branches and conversation history were retained.', gcDate: 'Reclaimed {date}', gcChoose: 'Choose a Local branch to continue this conversation.', gcLocal: 'Continue in Local', gcSwitchWarning: 'Selecting a different branch switches the original Local checkout. It requires Full access and a clean, idle checkout. No worktree changes are applied; no reset, stash, merge, or forced switch.', gcCurrent: 'Current Local branch', gcSelected: 'Local branch chosen: {branch}', gcCancelled: 'History remains available. Choose a branch when you are ready to continue.', gcBlock: 'Sending is paused while this worktree needs cleanup or Local recovery.', gcContinue: 'Continue on selected branch', gcRetry: 'Review Local branches', gcReadOnly: 'Keep viewing history', gcLookup: 'Checking reclaimed-worktree status…',
      gcCollecting: 'Worktree cleanup is in progress. Keep viewing history; sending is paused.', gcRecovery: 'Cleanup needs inspection. The checkout may be partly removed; sending is paused.', gcRetained: 'Retained worktree branch', gcAllBranches: 'Choose a Local branch', gcDraftHeld: 'Draft text, reference chips and file drafts remain in the historical conversation. This runtime cannot safely transfer the structured draft; open its history to review or copy it manually.', gcHistoryDraft: 'View historical draft', gcPermissions: 'Open Local permission controls', gcPending: 'A real Local continuation is staged. Adjust its standard permission controls if needed, then review a branch and retry.', gcReady: 'Local continuation ready', gcBranchChanged: 'The Local branch generation changed. Refresh and explicitly choose again.',
      pinned: 'Pinned', title: 'Worktrees', local: 'Local', new: 'New worktree', remote: 'Remote', branch: 'Starting branch',
      localBranches: 'Local branches', remoteBranches: 'Remote branches', currentBranch: 'Current branch', localBranchHelp: 'Start from a local commit. No remote fetch.', remoteBranchHelp: 'Start from the latest remote commit. Fetches when the worktree is created.', noBranches: 'No matching branches.', noRemotes: 'No remotes configured.', branchSource: 'Branch source',
      setupProgress: 'Preparing worktree', preparingMessage: 'Preparing your first message…', fetchingLatest: 'Fetching latest remote branch…', creatingWorktree: 'Creating worktree…', namingBranch: 'Generating and applying branch name…', openingConversation: 'Opening worktree conversation…', setupReady: 'Worktree ready', stagingAttachments: 'Preparing attachments for this worktree…', startingConversation: 'Starting normal conversation…', setupFailed: 'Worktree preparation failed', cancelSetup: 'Cancel setup', unsupported: 'This native composer version is not supported by the guarded adapter.', filesLost: 'A draft attachment is no longer available.', upload: 'Attachment upload failed', uncertain: 'Prompt admission is uncertain. Open the created conversation before trying again.',
      search: 'Search branches', select: 'Choose branch', refresh: 'Refresh', more: 'Load more', close: 'Close', open: 'Open conversation', remove: 'Remove',
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
      searchProjects: '搜索项目和会话', closeSearch: '关闭搜索', viewOptions: '视图选项',
      switchProjectsView: '切换到项目视图', switchWorkspaceView: '切换到工作区视图',
      'time.now': '刚刚', 'time.minutes': '{n}分钟', 'time.hours': '{n}小时', 'time.days': '{n}天', 'time.months': '{n}个月', 'time.years': '{n}年', 'date.ymd': '{y}年{m}月{d}日', lastActive: '最后活跃于 {time}',
      projects: '项目', folderView: '文件夹视图', newProject: '新建项目', editProject: '管理项目', projectName: '项目名称', project: '项目', folders: '文件夹', folder: '文件夹', addFolder: '添加文件夹', chooseDirectory: '选择文件夹…', browse: '浏览文件夹', absolutePath: '主机绝对目录路径', save: '保存', newThread: '新建对话', threadMode: '对话模式', threadActions: '对话操作', threadDetails: '对话详情', unassigned: '其他对话', showMore: '展开其余 {n} 个会话', showLess: '收起', filterThreads: '搜索对话或项目', allThreads: '所有对话', archivedOnly: '仅已归档', hideArchived: '隐藏已归档', untitled: '未命名', blankThread: '新对话', collapse: '收起项目', expand: '展开项目', waiting: '等待交互', done: '已完成，尚未查看', localThread: '本地对话', worktreeThread: '工作树对话', draftWarning: '此草稿包含文字或附件。请先保留当前对话，再选择其他项目或文件夹。', chooseFolder: '选择文件夹', createFolder: '创建文件夹', folderName: '文件夹名称', chooseThisFolder: '使用此文件夹', noProjects: '添加项目以组织您的对话。',
      repoUnavailable: '此文件夹的工作树模式不可用或尚未验证，请选择本地模式继续。', checkingRepository: '正在检查工作树可用性…',
      projectChanged: '项目或选定文件夹已更改，请先选择本地模式或保留当前文件夹，再重新选择新建工作树。', keepCurrentFolder: '保留当前文件夹',
      removeProject: '移除项目', removeProjectConfirm: '移除此项目？', removeProjectHelp: '仅移除项目元数据，所有文件夹、文件、对话和工作树都会保留。对话仍可在“其他对话”和“文件夹视图”中访问。',
      mainFolder: '主文件夹', main: '主目录', chooseMainFolder: '选择主文件夹', mainFolderRequired: '请从项目源文件夹中选择一个主文件夹。', mainFolderHelp: '新对话默认使用此文件夹，发送前仍可选择其他文件夹。', conversationFolder: '对话文件夹',
      createProject: '创建项目', sourceFolders: '源文件夹', localFolders: '浏览文件夹', enterFolderPath: '输入文件夹路径', checkingFolderOptions: '正在检查可用的文件夹选项…', browseUnavailable: '此会话无法列出主机文件夹。请改为输入主机绝对文件夹路径。', folderPickerUnavailable: '此处无法使用系统文件夹选择器。请改用浏览文件夹或输入主机绝对文件夹路径。', add: '添加', cancel: '取消', selectedFolders: '已选文件夹', selectFolder: '选择文件夹', folderLimit: '一个项目最多可包含 32 个文件夹。', invalidFolder: '请输入有效的主机绝对文件夹路径。', alreadyAdded: '已添加', multiFolderHelp: '使用复选框选择多个文件夹，浏览其他目录时会保留已选项。', hostFolderHelp: '文件夹位于主机计算机上；添加不会移动文件。', noSubfolders: '没有子文件夹。', directoryTruncated: '目录列表已截断，请输入路径浏览其他文件夹。',
      rootFolder: '工作树根目录', rootSummary: '选择新工作树的创建位置。', rootHelp: '主机上的绝对目录路径，需位于源仓库之外。仅影响新工作树，已有目录和进行中的创建不会移动。', rootReset: '恢复继承的默认值', rootSaved: '已保存，新工作树将使用此位置。', rootUnavailable: '此条目的主机设置不可用。', rootInvalid: '请输入有效的主机绝对目录路径。', rootConflict: '设置已更改或主机拒绝了保存，草稿已保留。请重新打开页面读取最新值。',
      cleanupTitle: '工作区清理', cleanupEnabled: '自动回收长期不活跃的工作树', cleanupDays: '不活跃天数', cleanupHelp: '仅统计用户消息；打开对话不会重置计时。仍加载的对话运行实例、进行中的工作和受保护的工作树会推迟清理；可能需在服务器重启后重试。', cleanupDanger: '清理会永久删除未提交、未跟踪和被忽略的文件。Git 分支和对话历史会保留。归档不会豁免清理。', cleanupSaved: '已保存清理设置。', cleanupInvalid: '请输入 1 至 3650 之间的整数天数。', cleanupConflict: '设置已更改或主机拒绝了保存，草稿已保留。', reclaimed: '工作树已回收', cleanupDeferred: '已推迟清理', gcWarning: '此工作树因长期不活跃已被回收。未保存的文件已删除；Git 分支和对话历史仍被保留。', gcDate: '回收时间：{date}', gcChoose: '请选择本地分支以继续此对话。', gcLocal: '在本地继续', gcSwitchWarning: '选择其他分支会切换原始本地检出，需要完整访问权限以及干净、空闲的检出。不会应用工作树改动，也不会重置、暂存、合并或强制切换。', gcCurrent: '当前本地分支', gcSelected: '所选本地分支：{branch}', gcCancelled: '仍可查看历史；准备好继续时再选择分支。', gcBlock: '工作树需要清理或本地续接，发送已暂停。', gcContinue: '在所选分支上继续', gcRetry: '查看本地分支', gcReadOnly: '继续查看历史', gcLookup: '正在检查工作树回收状态…',
      gcCollecting: '工作树正在清理。仍可查看历史；发送已暂停。', gcRecovery: '清理需要检查。检出可能已被部分移除；发送已暂停。', gcRetained: '保留的工作树分支', gcAllBranches: '选择本地分支', gcDraftHeld: '草稿文字、引用标签和文件草稿仍保留在历史对话中。当前运行时无法安全迁移结构化草稿；请打开历史对话查看或手动复制。', gcHistoryDraft: '查看历史草稿', gcPermissions: '打开本地权限设置', gcPending: '已准备真实的本地续接对话。如有需要，请调整其标准权限设置，然后重新选择分支并重试。', gcReady: '本地续接已就绪', gcBranchChanged: '本地分支列表已更改，请刷新并重新明确选择。',
      pinned: '已固定', title: '工作树', local: '本地', new: '新工作树', remote: '远程', branch: '起始分支', search: '搜索分支',
      localBranches: '本地分支', remoteBranches: '远程分支', currentBranch: '当前分支', localBranchHelp: '从本地提交开始，不获取远程更新。', remoteBranchHelp: '从最新远程提交开始，创建工作树时获取更新。', noBranches: '没有匹配的分支。', noRemotes: '未配置远程仓库。', branchSource: '分支来源',
      setupProgress: '正在准备工作树', preparingMessage: '正在准备第一条消息…', fetchingLatest: '正在获取最新远程分支…', creatingWorktree: '正在创建工作树…', namingBranch: '正在生成并应用分支名称…', openingConversation: '正在打开工作树对话…', setupReady: '工作树已就绪', stagingAttachments: '正在为工作树准备附件…', startingConversation: '正在开始正常对话…', setupFailed: '工作树准备失败', cancelSetup: '取消准备', unsupported: '该输入区版本不受受保护适配器支持。', filesLost: '草稿附件已不可用。', upload: '附件上传失败', uncertain: '消息发送结果不确定，请先打开创建的对话检查。',
      select: '选择分支', refresh: '刷新', more: '加载更多', close: '关闭', open: '打开对话', remove: '移除', createBranch: '在此创建分支', branchName: '新分支名称',
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
.dsh-wt-project-dialog{width:min(516px,calc(100vw - 32px));padding:20px;border-radius:16px;border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-wt-project-dialog .dsh-wt-dialog-heading{margin:0 0 16px}.dsh-wt-project-dialog h2{margin:0;font-size:20px;line-height:1.3;font-weight:600}.dsh-wt-project-dialog .dsh-wt-dialog-close{display:inline-flex;align-items:center;justify-content:center;width:28px;min-height:28px;padding:0;border:0;color:var(--dsw-alias-label-secondary)}
.dsh-wt-project-name{display:flex;align-items:center;gap:10px!important;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-secondary)}.dsh-wt-project-name:focus-within{border-color:var(--dsw-alias-brand-primary)}.dsh-wt-project-dialog .dsh-wt-project-name input{flex:1;min-width:0;max-width:none;min-height:38px;padding:8px 0;border:0;border-radius:0;background:transparent;outline:none;color:var(--dsw-alias-label-primary)}
.dsh-wt-source-heading{display:flex;align-items:center;justify-content:space-between;margin:12px 0 8px;font-size:13px;font-weight:600}.dsh-wt-source-count{font-weight:400;color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-wt-source-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden}.dsh-wt-source-add{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:100px;padding:12px;box-sizing:border-box}.dsh-wt-source-card[data-filled=true] .dsh-wt-source-add{min-height:76px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-wt-project-dialog .dsh-wt-source-select{border:0;background:transparent;max-width:100%;font-size:13px;text-align:center;color:var(--dsw-alias-label-secondary);padding:0 6px}.dsh-wt-project-dialog .dsh-wt-add-pill{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:2px 10px;min-height:26px;border:0;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:13px}.dsh-wt-project-dialog .dsh-wt-add-pill:hover:not(:disabled){background:var(--dsw-alias-bg-overlay)}
.dsh-wt-source-list{list-style:none;padding:0!important;margin:0!important;max-height:208px;overflow:auto}.dsh-wt-source-list li{display:flex;align-items:center;gap:10px;padding:10px 12px}.dsh-wt-source-list li+li{border-top:1px solid var(--dsw-alias-border-l1)}.dsh-wt-source-list svg{flex-shrink:0;color:var(--dsw-alias-label-secondary)}.dsh-wt-source-info{display:flex;flex-direction:column;flex:1;min-width:0}.dsh-wt-source-info>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-wt-source-path{color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-wt-project-dialog .dsh-wt-source-remove{border:0;padding:0;width:28px;min-height:28px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.dsh-wt-project-path{width:100%;display:flex;gap:8px!important;flex-wrap:nowrap!important}.dsh-wt-project-path input{flex:1;min-width:0}.dsh-wt-project-footer{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:32px}.dsh-wt-project-dialog .dsh-wt-cancel{border:0;color:var(--dsw-alias-label-secondary)}.dsh-wt-project-dialog .dsh-wt-confirm{border:0;border-radius:10px;padding:6px 18px;min-height:32px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);font-size:13px}.dsh-wt-project-dialog .dsh-wt-confirm:hover:not(:disabled){background:var(--dsw-alias-label-secondary)}
.dsh-wt-project-dialog .dsh-wt-remove-project{margin-right:auto;border:0;color:var(--dsw-alias-state-error-primary);font-size:13px}.dsh-wt-project-dialog .dsh-wt-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-wt-project-dialog .dsh-wt-main-folder{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin-top:12px;font-size:13px}.dsh-wt-main-folder select{width:100%;min-width:0;border-color:var(--dsw-alias-border-l2)}.dsh-wt-main-folder small{color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-wt-create-controls .dsh-wt-conversation-folder{max-width:180px}
.dsh-wt-folder-picker{width:min(640px,calc(100vw - 32px))}.dsh-wt-picker-path{display:flex;gap:8px;align-items:flex-end}.dsh-wt-picker-path label{flex:1;min-width:0}.dsh-wt-picker-crumbs{margin:12px 0;gap:4px}.dsh-wt-picker-entries{list-style:none;padding:0;margin:8px 0;max-height:240px;overflow:auto}.dsh-wt-picker-entries li,.dsh-wt-picker-current{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px}.dsh-wt-picker-entries li:hover{background:var(--dsw-alias-bg-layer-2)}.dsh-wt-picker-check{flex-shrink:0}.dsh-wt-picker-check input{accent-color:var(--dsw-alias-brand-primary)}.dsh-wt-picker-entries .dsh-wt-picker-open{border:0;flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-wt-picker-current{border:1px solid var(--dsw-alias-border-l1)}.dsh-wt-picker-selected{margin-top:12px}.dsh-wt-picker-selected .dsh-wt-source-list{max-height:128px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.dsh-wt-picker-selected h3{font-size:13px}.dsh-wt-picker-create{margin-top:12px}.dsh-wt-picker-create summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px}.dsh-wt-picker-create form{display:flex;align-items:flex-end;gap:8px;margin-top:8px}
.dsh-wt-progress{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px}.dsh-wt-progress ol{margin:8px 0;padding-left:18px;display:flex;flex-direction:column;gap:5px}.dsh-wt-progress li{color:var(--dsw-alias-label-secondary)}.dsh-wt-progress li[data-active=true]{font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-wt-create-controls{position:relative;font-size:13px;gap:4px}.dsh-wt-create-controls select{max-width:160px;min-height:28px}.dsh-wt-create-controls .dsh-wt-control{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:4px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}.dsh-wt-create-controls .dsh-wt-control:hover:not(:disabled),.dsh-wt-create-controls .dsh-wt-control[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}.dsh-wt-control-text{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-wt-control svg{flex:none}.dsh-wt-choice{position:relative;display:inline-flex}.dsh-wt-choice-menu,.dsh-wt-base-options{position:absolute;bottom:calc(100% + 6px);left:0;z-index:100;box-sizing:border-box;padding:4px;border:0;border-radius:10px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent)}.dsh-wt-choice-menu{min-width:168px;max-width:360px}.dsh-wt-create-controls .dsh-wt-choice-item,.dsh-wt-create-controls .dsh-wt-branch-item{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:6px;text-align:left;font-size:13px;line-height:20px;background:transparent;color:var(--dsw-alias-label-primary)}.dsh-wt-create-controls :is(.dsh-wt-choice-item,.dsh-wt-branch-item):is(:hover,:focus-visible):not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}.dsh-wt-choice-check{display:inline-flex;align-items:center;justify-content:center;width:16px;flex:none}.dsh-wt-base-options{width:min(340px,calc(100vw - 32px));padding:10px;display:flex;flex-direction:column;gap:8px}.dsh-wt-branch-heading{font-size:13px;font-weight:600}.dsh-wt-branch-sources{display:flex;gap:4px;padding:3px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover)}.dsh-wt-create-controls .dsh-wt-branch-sources button{flex:1;border:0;min-height:28px;padding:4px 8px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent}.dsh-wt-create-controls .dsh-wt-branch-sources button[aria-checked=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft)}.dsh-wt-create-controls .dsh-wt-branch-search{display:flex;align-items:center;flex-wrap:nowrap;gap:6px;min-height:32px;padding:0 8px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}.dsh-wt-branch-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}.dsh-wt-branch-search svg{flex:none}.dsh-wt-create-controls .dsh-wt-branch-search input[type=search]{flex:1;width:0;min-width:0;max-width:none;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;outline:none;appearance:none;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}.dsh-wt-create-controls .dsh-wt-branch-search input[type=search]::placeholder{color:var(--dsw-alias-label-secondary)}.dsh-wt-branch-list{max-height:240px;overflow:auto}.dsh-wt-branch-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-wt-branch-badge{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}.dsh-wt-branch-help{font-size:12px;color:var(--dsw-alias-label-secondary)}.dsh-wt-create-error{max-width:360px;font-size:12px;color:var(--dsw-alias-state-error-primary)}.dsh-wt-create-controls button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.dsh-wt-create-controls .dsh-wt-branch-search input[type=search]:focus-visible,.dsh-wt-create-controls :is(.dsh-wt-choice-item,.dsh-wt-branch-item):focus-visible{outline:none}
.dsh-wt-projects{min-height:0;display:flex;flex-direction:column;gap:6px;padding:8px;width:100%;box-sizing:border-box;font-size:13px}.dsh-wt-projects-header{display:flex;align-items:center;justify-content:space-between;padding:4px}.dsh-wt-project-list{min-height:0;overflow:auto}.dsh-wt-project-head{display:flex;align-items:center;gap:4px;margin-top:8px}.dsh-wt-project-head>button:first-child{flex:1;min-width:0;text-align:left;display:flex;align-items:center;gap:7px}.dsh-wt-projects button{border:0;padding:4px 6px}.dsh-wt-project-title,.dsh-wt-thread-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.dsh-wt-project-title{font-weight:600}.dsh-wt-thread{border-radius:7px;position:relative}.dsh-wt-thread[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}.dsh-wt-thread-main{display:flex;align-items:center;gap:5px;min-height:32px;padding-left:12px}.dsh-wt-thread-main>button:first-child{display:flex;align-items:center;gap:6px;flex:1;min-width:0;text-align:left}.dsh-wt-thread-title{flex:1}.dsh-wt-thread-main:hover .dsh-wt-thread-title{overflow:auto;text-overflow:clip}.dsh-wt-thread-actions{display:flex;align-items:center;opacity:0}.dsh-wt-thread:is(:hover,:focus-within) .dsh-wt-thread-actions{opacity:1}.dsh-wt-thread-actions button{min-width:24px}.dsh-wt-thread-leading{width:16px;display:inline-flex;flex-shrink:0}.dsh-wt-thread-status{font-size:11px;color:var(--dsw-alias-state-business-primary)}.dsh-wt-thread-pending{color:var(--dsw-alias-state-warning-primary)}.dsh-wt-thread-archived{opacity:.65}.dsh-wt-branch-chip{display:inline-flex;align-items:center;justify-content:center;width:16px;flex-shrink:0;color:var(--dsw-alias-label-secondary)}.dsh-wt-thread-hover{padding:8px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}.dsh-wt-project-menu{display:flex;flex-direction:column;align-items:stretch}.dsh-wt-project-menu button{text-align:left}.dsh-wt-project-picker{display:flex;align-items:center;gap:4px;max-width:100%}.dsh-wt-project-picker select{max-width:190px}.dsh-wt-folder-list{padding:0;list-style:none}.dsh-wt-folder-list li{display:flex;align-items:center;gap:8px;padding:4px 0;overflow-wrap:anywhere}.dsh-wt-folder-list code{flex:1}.dsh-wt-folder-browser{max-height:45vh;overflow:auto}.dsh-wt-folder-browser button{display:block;width:100%;text-align:left}.dsh-wt-dialog::backdrop{background:var(--dsw-alias-bg-mask-1)}.dsh-wt-details{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px}.dsh-wt-details dd{margin:0;overflow-wrap:anywhere}
/* Sidebar cell metrics follow the native Folder view; dialogs keep their own rules. */
.dsh-wt-projects{font-family:inherit;font-size:14px;font-weight:400;line-height:20px;gap:4px}.dsh-wt-projects-header{height:36px;box-sizing:border-box;padding:0 4px;margin:2px 0 4px;color:var(--dsw-alias-label-secondary)}.dsh-wt-projects-header strong{font-weight:inherit}.dsh-wt-projects-header>button{width:28px;height:28px;min-height:28px;padding:0}.dsh-wt-project-list{padding-bottom:16px}.dsh-wt-project-group+.dsh-wt-project-group{margin-top:4px}
.dsh-wt-project-head{height:34px;box-sizing:border-box;padding:0 8px;gap:6px;margin-top:2px;border-radius:8px}.dsh-wt-project-head:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-wt-project-head>button:first-child{height:34px;min-height:34px;gap:6px;padding:0;background:transparent}.dsh-wt-project-title{font-size:14px;line-height:20px;font-weight:inherit}.dsh-wt-project-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;height:20px;flex:none;color:var(--dsw-alias-label-secondary)}.dsh-wt-project-chevron{display:none;font-size:14px}.dsh-wt-project-head:is(:hover,:focus-within) .dsh-wt-project-folder{display:none}.dsh-wt-project-head:is(:hover,:focus-within) .dsh-wt-project-chevron{display:inline-flex}
.dsh-wt-project-head-actions,.dsh-wt-thread-actions{display:inline-flex;align-items:center;gap:10px;max-width:0;height:20px;flex:none;overflow:hidden;opacity:0;pointer-events:none}.dsh-wt-project-head:is(:hover,:focus-within) .dsh-wt-project-head-actions,.dsh-wt-thread:is(:hover,:focus-within) .dsh-wt-thread-actions,.dsh-wt-thread[data-menu-open=true] .dsh-wt-thread-actions{max-width:none;overflow:visible;opacity:1;pointer-events:auto}.dsh-wt-project-head-actions button,.dsh-wt-thread-actions button{min-width:16px;width:16px;min-height:16px;height:16px;padding:0;color:var(--dsw-alias-label-secondary)}
.dsh-wt-thread{margin-top:2px;border-radius:8px}.dsh-wt-thread:hover,.dsh-wt-thread[data-menu-open=true]{background:var(--dsw-alias-interactive-bg-hover)}.dsh-wt-thread-main{height:32px;min-height:32px;padding:0 8px;gap:0;box-sizing:border-box}.dsh-wt-thread-main>button:first-child{height:32px;min-height:32px;padding:0;gap:0;font-size:14px;line-height:20px;font-weight:inherit;background:transparent}.dsh-wt-thread-title{margin:0 6px 0 4px;font-size:14px;line-height:20px}.dsh-wt-thread-leading{height:20px;align-items:center;justify-content:center;flex:none}.dsh-wt-branch-chip{margin-right:6px}.dsh-wt-thread-pin{margin-left:6px}.dsh-wt-thread-time{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}.dsh-wt-thread:is(:hover,:focus-within) .dsh-wt-thread-time,.dsh-wt-thread:is(:hover,:focus-within) .dsh-wt-thread-pin,.dsh-wt-thread[data-menu-open=true] .dsh-wt-thread-time,.dsh-wt-thread[data-menu-open=true] .dsh-wt-thread-pin{display:none}
.dsh-wt-projects .dsh-wt-session-overflow{display:block;width:100%;height:28px;min-height:28px;margin-top:0;padding:0 12px 0 28px;text-align:left;font-family:inherit;font-size:12px;font-weight:inherit;border:0;border-radius:0;color:var(--dsw-alias-label-secondary);background:transparent}.dsh-wt-projects .dsh-wt-session-overflow:hover:not(:disabled){background:transparent;color:var(--dsw-alias-label-primary)}
.dsh-wt-project-toolbar{position:relative;justify-content:flex-end;gap:4px;overflow:visible}.dsh-wt-project-section-label{margin-right:auto;min-width:0;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}.dsh-wt-projects .dsh-wt-toolbar-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;min-height:28px;padding:0;border:0;border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent}.dsh-wt-projects .dsh-wt-toolbar-icon[data-active=true]{color:var(--dsw-alias-label-primary)}
.dsh-wt-project-search{display:flex;align-items:center;flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px}.dsh-wt-project-toolbar .dsh-wt-project-search-input{flex:1;min-width:0;width:100%;max-width:none;height:28px;padding:0 6px;border:0;background:transparent;font-family:inherit;font-size:13px;line-height:20px}.dsh-wt-project-search-input::-webkit-search-cancel-button{display:none}.dsh-wt-view-options{display:flex;align-items:center;flex:none}.dsh-wt-view-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:30;min-width:200px;padding:6px;display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}.dsh-wt-projects .dsh-wt-view-menu button{display:flex;align-items:center;gap:8px;padding:4px 8px;text-align:left;font-size:13px;line-height:20px;white-space:nowrap}.dsh-wt-view-check{width:16px;flex:none}
/* Native StateDot geometry and timing, owned locally rather than imported. */
.dsh-wt-state-dot{position:relative;display:inline-block;flex:none;width:10px;height:10px}.dsh-wt-state-dot::after{content:'';position:absolute;inset:20%;border-radius:50%;background:currentColor}.dsh-wt-state-dot[data-state=warning]{color:var(--dsw-alias-state-warn-primary)}.dsh-wt-state-dot[data-state=done]{color:var(--dsw-alias-state-success-primary)}
.dsh-wt-state-spinner{display:block;flex:none;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}.dsh-wt-state-motion{transform-origin:center;animation:dsh-wt-state-spin 1.5s linear infinite}.dsh-wt-state-track,.dsh-wt-state-arc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}.dsh-wt-state-track{opacity:.25}.dsh-wt-state-arc{stroke-dasharray:12 150;animation:dsh-wt-state-dash 1.5s ease-in-out infinite}
@keyframes dsh-wt-state-spin{to{transform:rotate(360deg)}}@keyframes dsh-wt-state-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}100%{stroke-dasharray:12 150;stroke-dashoffset:0}}
.dsh-wt-recovery{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);margin:8px 0}.dsh-wt-recovery fieldset{border:0;padding:0;margin:8px 0}.dsh-wt-recovery legend{font-weight:600}.dsh-wt-recovery-branches{max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:4px}.dsh-wt-recovery-branches label{padding:4px 6px;border-radius:6px;overflow-wrap:anywhere}.dsh-wt-recovery-branches label:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-wt-recovery input[type=radio]{accent-color:var(--dsw-alias-state-business-primary)}
@media(prefers-reduced-motion:reduce){.dsh-wt-state-motion,.dsh-wt-state-arc{animation:none}.dsh-wt-state-arc{stroke-dasharray:18 150;stroke-dashoffset:-3}}
`;
    class WorktreeError extends Error {
      readonly kind: string;
      readonly code: string;
      constructor(kind: string, code: string, message = '') { super(message); this.kind = kind; this.code = code; }
    }
    function object(value: unknown): value is { [key: string]: unknown } {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
    function string(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
    function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
    function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
    function failure(value: unknown): value is WT.Failure { return object(value) && typeof value.code === 'string' && typeof value.message === 'string'; }
    function errorMessage(error: unknown): string { return object(error) && typeof error.message === 'string' ? error.message : ''; }
    function decodeReply(reply: unknown): unknown {
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
    const cleanupPhases = ['deferred', 'planned', 'preserving', 'removing', 'collected', 'recovery-required'];
    function cleanupData(value: unknown): value is WT.Cleanup {
      const timestamp = (item: unknown) => item === null || (integer(item) && item >= 0 && item <= 8640000000000000);
      return object(value) && typeof value.phase === 'string' && cleanupPhases.includes(value.phase) && integer(value.inactivityDays) && value.inactivityDays >= 1 && value.inactivityDays <= 3650 && ['lastActivityAt', 'eligibleAfter', 'reclaimedAt'].every(key => timestamp(value[key])) && (value.originalFolder === null || absolutePath(value.originalFolder)) && (value.recoveryRef === null || typeof value.recoveryRef === 'string' && value.recoveryRef.startsWith('refs/dsh-worktrees/')) && (value.reason === null || failure(value.reason) && !!value.reason.code);
    }
    function recoveryRequest<R extends WT.RecoveryRequest>(request: R): R {
      const bounded = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
      const keys = request?.action === 'reopen-info' ? ['action', 'sourceSessionId', 'cursor', 'limit', 'after'] : request?.action === 'reopen' ? ['action', 'sourceSessionId', 'localBranch', 'localOid'] : null;
      let valid = !!keys && Object.keys(request).every(key => keys.includes(key)) && bounded(request.sourceSessionId, 256);
      if (request?.action === 'reopen-info') valid = valid && (request.cursor === undefined || bounded(request.cursor, 512)) && (request.limit === undefined || integer(request.limit) && request.limit >= 1 && request.limit <= 100) && (request.after === undefined || integer(request.after) && request.after >= 0 && request.cursor === undefined && request.limit === undefined);
      if (request?.action === 'reopen') valid = valid && bounded(request.localBranch) && !request.localBranch.startsWith('-') && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(request.localOid || '');
      if (!valid) throw new WorktreeError('decode', 'invalid-recovery-request');
      return request;
    }
    function recoveryData<R extends WT.RecoveryRequest>(request: R, data: unknown): WT.RecoveryReply<R> {
      if (!object(data)) throw new WorktreeError('decode', 'invalid-' + request.action + '-data');
      const nullable = (value: unknown) => value === null || string(value);
      const oid = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
      let valid = data.sourceSessionId === request.sourceSessionId && (data.cleanup === null || cleanupData(data.cleanup));
      if (request.action === 'reopen-info') {
        valid = valid && nullable(data.worktreeId) && nullable(data.continuationSessionId) && (data.originalFolder === null || absolutePath(data.originalFolder)) && integer(data.revision) && data.revision >= 0 && (data.pendingSessionId === undefined || string(data.pendingSessionId)) && (data.recoveredBranch === undefined || nullable(data.recoveredBranch));
        const repository = data.repository;
        if (repository !== undefined) valid = valid && object(repository) && absolutePath(repository.root) && absolutePath(repository.commonDir) && oid(repository.head) && nullable(repository.branch);
        if (data.branches !== undefined) valid = valid && object(repository) && Array.isArray(data.branches) && data.branches.length <= 100 && data.branches.every((item: unknown) => object(item) && string(item.name) && oid(item.oid) && (item.name !== 'HEAD' || repository.branch === null)) && integer(data.observedAt) && data.observedAt >= 0;
        if (data.nextCursor !== undefined) valid = valid && string(data.nextCursor) && data.branches !== undefined;
        if (data.continuationSessionId !== null || data.pendingSessionId !== undefined) valid = valid && object(data.cleanup) && data.cleanup.phase === 'collected' && string(data.worktreeId);
      } else valid = valid && string(data.sessionId) && string(data.workspaceId) && string(data.worktreeId) && absolutePath(data.cwd) && nullable(data.branch) && object(data.cleanup) && data.cleanup.phase === 'collected';
      if (!valid) throw new WorktreeError('decode', 'invalid-' + request.action + '-data');
      // The action-specific fields were validated above, including nested records.
      return data as unknown as WT.RecoveryReply<R>;
    }
    async function requestRecovery<const R extends WT.RecoveryRequest>(ctx: WT.Context, request: R, signal?: AbortSignal): Promise<WT.RecoveryReply<R>> {
      recoveryRequest(request);
      const { after, ...hostRequest } = request as WT.RecoveryInfoRequest | (WT.RecoveryResumeRequest & { after?: never });
      return recoveryData(request, await quietRPC(ctx, 'dsh-worktrees/recovery', { v: 1, request: hostRequest, ...(after === undefined ? {} : { after }) }, signal));
    }
    function namingData(value: unknown): value is WT.Naming {
      return object(value) && string(value.title) && string(value.slug) && string(value.directoryName) && string(value.branch) && (value.source === 'model' || value.source === 'fallback') && (value.fallbackReason === undefined || string(value.fallbackReason));
    }
    function worktreeData(value: unknown): value is WT.Record {
      return object(value) && (value.cleanup === undefined || cleanupData(value.cleanup)) && (value.displayName === undefined || string(value.displayName)) && (value.naming === undefined || namingData(value.naming)) && string(value.id) && string(value.operationId) && string(value.effectiveCwd) && string(value.remote) && string(value.remoteBranch) && typeof value.baseOid === 'string' && (value.state !== 'ready' || string(value.baseOid)) && Array.isArray(value.sessionIds) && value.sessionIds.every(string) && (value.branch === null || typeof value.branch === 'string') && typeof value.protected === 'boolean' && typeof value.archived === 'boolean' && typeof value.state === 'string' && ['creating', 'ready', 'recovery-required', 'missing'].includes(value.state);
    }
    function operationData(value: unknown): value is WT.Operation {
      return object(value) && (value.generatedName === undefined || namingData(value.generatedName)) && string(value.id) && string(value.phase) && (value.error === null || failure(value.error) && !!value.error.code);
    }
    function validateData<const R extends WT.WorktreeRequest>(request: R, data: unknown): WT.HostReply<R>;
    function validateData<const R extends WT.RecoveryRequest>(request: R, data: unknown): WT.RecoveryReply<R>;
    function validateData(request: WT.WorktreeRequest | WT.RecoveryRequest, data: unknown): unknown {
      if (request.action === 'reopen-info' || request.action === 'reopen') return recoveryData(request, data);
      let valid = object(data);
      if (!object(data)) throw new WorktreeError('decode', 'invalid-' + request.action + '-data');
      if (request.action === 'status') {
        valid = string(data.settingsHash);
        if (request.operationId) valid = valid && operationData(data.operation) && (!data.sessionId || string(data.sessionId)) && (!data.worktree || worktreeData(data.worktree));
        else if (request.id) valid = valid && worktreeData(data.worktree) && (data.status === null || (object(data.status) && typeof data.status.dirty === 'boolean' && string(data.status.head)));
        else valid = valid && object(data.repository) && string(data.repository.root) && string(data.repository.head) && (data.repository.branch === null || typeof data.repository.branch === 'string') && Array.isArray(data.remotes) && data.remotes.every((item: unknown) => object(item) && string(item.name) && string(item.identity));
      } else if (request.action === 'branches') {
        valid = (request.branchSource === 'local' ? data.branchSource === 'local' && (data.currentBranch === null || string(data.currentBranch)) : data.branchSource !== 'local' && data.remote === request.remote && string(data.remoteIdentity) && (!request.remoteIdentity || data.remoteIdentity === request.remoteIdentity)) && Array.isArray(data.items) && data.items.every((item: unknown) => object(item) && string(item.name) && string(item.oid)) && finite(data.observedAt) && (data.defaultBranch === null || typeof data.defaultBranch === 'string') && (!data.nextCursor || string(data.nextCursor));
      } else if (request.action === 'list') valid = Array.isArray(data.items) && data.items.every(worktreeData) && (!data.nextCursor || string(data.nextCursor));
      else if (['create', 'start', 'handoff'].includes(request.action)) valid = string(data.sessionId) && string(data.workspaceId) && string(data.settingsHash) && worktreeData(data.worktree) && operationData(data.operation);
      else if (request.action === 'preview') valid = string(data.id) && data.worktreeId === request.id && string(data.sourceSessionId) && string(data.targetRoot) && string(data.baseOid) && string(data.patchHash) && string(data.patchPath) && finite(data.bytes) && Array.isArray(data.files) && data.files.every((file: unknown) => object(file) && string(file.path) && typeof file.status === 'string' && typeof file.binary === 'boolean');
      else if (request.action === 'export') valid = string(data.path) && string(data.patchHash) && finite(data.bytes) && (data.patch === undefined || typeof data.patch === 'string');
      if (!valid) throw new WorktreeError('decode', 'invalid-' + request.action + '-data');
      return data;
    }
    async function quietRPC(ctx: WT.Context, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
      let reply: unknown;
      // Use Connection's authenticated/correlated transport, never chat commands.
      try { reply = await ctx.connection.rpc.call('/api', endpoint, payload, signal); }
      catch (error) {
        if (object(error) && error.name === 'AbortError') throw new WorktreeError('cancelled', 'cancelled', errorMessage(error));
        throw new WorktreeError('transport', 'rpc-rejected', errorMessage(error));
      }
      return decodeReply(reply);
    }
    async function requestHost<const R extends WT.WorktreeRequest>(ctx: WT.Context, actorId: string | undefined, request: R, signal?: AbortSignal): Promise<WT.HostReply<R>> {
      if (typeof actorId !== 'string' || !actorId.trim()) throw new WorktreeError('actor', 'no-current-conversation');
      return validateData(request, await quietRPC(ctx, 'dsh-worktrees/execute', { v: 1, actorId, request }, signal));
    }
    function report(t: WT.Translate, error: unknown): string {
      if (error instanceof WorktreeError) return t(error.kind) + (error.code ? ' [' + error.code + ']' : '') + (error.message ? ': ' + error.message : '');
      const message = errorMessage(error);
      return t('unknown') + (message ? ': ' + message : '');
    }
    function currentActor(list: WT.Sessions) {
      const ids = Object.keys(list.byId).filter(id => (list.byId[id]?.retainedBy?.mainView || 0) > 0 && list.byId[id]?.origin !== 'subagent');
      return ids.length === 1 ? ids[0] : undefined;
    }
    function sourceEligible(snapshot: WT.SessionSnapshot) {
      return snapshot.blank === true && snapshot.subagent === null && snapshot.openState === 'open' && !snapshot.removed && !snapshot.running && !snapshot.promptAttempted && !snapshot.awaitingFirstTurn && snapshot.pendingSubmissions.length === 0;
    }
    function inputEmpty(input: WT.InputSnapshot) { return input.phase === 'plain' && input.draft === '' && input.attachmentIds.length === 0 && input.queue.length === 0; }
    function captureDraft(input: WT.InputSnapshot): WT.Draft { return { draft: input.draft, draftRev: input.draftRev, attachmentIds: [...input.attachmentIds], phase: input.phase }; }
    function draftUnchanged(before: WT.Draft, after: WT.InputSnapshot) {
      return before.phase === 'plain' && after.phase === 'plain' && before.draft === after.draft && before.draftRev === after.draftRev && before.attachmentIds.length === after.attachmentIds.length && before.attachmentIds.every((id, i) => id === after.attachmentIds[i]) && after.queue.length === 0;
    }
    function advertisedDefault(data: WT.Branches, preferred = 'main') { return data.items.some(item => item.name === preferred) ? preferred : data.items.some(item => item.name === data.defaultBranch) ? data.defaultBranch : ''; }
    // The block setter compares reasons. Ownership is the *actual stored object*, never just its reason.
    function acquireBlock(blocks: WT.Blocks, sessionId: string, reason: string): WT.BlockHandle {
      const store = blocks.storeFor(sessionId);
      if (store.getSnapshot() !== undefined) throw new WorktreeError('blocked', 'composer-already-blocked');
      const owned = Object.freeze({ reason });
      blocks.set(sessionId, owned);
      if (store.getSnapshot() !== owned) throw new WorktreeError('ownership', 'block-not-acquired');
      return { owned, store, release() { if (store.getSnapshot() === owned) blocks.set(sessionId, undefined); } };
    }
    function releaseAfterMainOwnership(ctx: WT.Context, reference: WT.Reference, committed: boolean) {
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
    const absolutePath = (path: unknown): path is string => typeof path === 'string' && !path.includes('\0') && (/^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path));
    const uuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    function appendProjectFolders(previous: readonly string[], additions: unknown): string[] {
      if (!Array.isArray(additions) || additions.some((path: unknown) => !absolutePath(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path))) throw new WorktreeError('invalidFolder', 'invalid-project-folder');
      // All supplied paths were checked above; Array.isArray alone is not a typed decoder.
      // Exact-string deduplication is only UX; realpath/ownership checks stay on the Host.
      const next = [...new Set([...previous, ...(additions as string[])])];
      if (next.length > 32) throw new WorktreeError('folderLimit', 'project-folder-limit');
      return next;
    }
    function toggleProjectFolder(previous: readonly string[], path: string, capacity = 32) {
      if (previous.includes(path)) return previous.filter(value => value !== path);
      const next = appendProjectFolders(previous, [path]);
      if (next.length > capacity) throw new WorktreeError('folderLimit', 'project-folder-limit');
      return next;
    }
    function projectFolderName(path: string) {
      const separator = /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? /[\\/]/ : /\//;
      return path.split(separator).filter(Boolean).at(-1) || path;
    }
    // Native folder picking is desktop-only: the callable shell bridge
    // `__DSH_DIRECTORY_PICKER__.pick` confirms that capability. The Host-backed
    // `uiWorkspace.pickDirectory` method also exists on web, so it cannot advertise
    // a native option there; on desktop it remains a fallback if the bridge fails.
    // Contract, chosen because asking both at once opens two dialogs when both work:
    // the first source decides. A path wins; null is the operator cancelling *that*
    // dialog and is returned as-is, never handed to the next source; only a failure —
    // including a synchronous throw — falls through to the next source. A first
    // source that never settles cannot be escaped without a deadline or an explicit
    // capability probe, so that case stays with the operator to dismiss.
    function settleFirst(pickers: WT.Picker[]): Promise<string | null> {
      return new Promise((resolve, reject) => {
        if (!pickers.length) { reject(new WorktreeError('folderPickerUnavailable', 'no-directory-picker')); return; }
        let index = 0, firstError: unknown;
        const attempt = () => {
          if (index >= pickers.length) { reject(firstError); return; }
          const pick = pickers[index]!; // index was bounded above
          index += 1;
          let call;
          // A synchronous throw from one source must not abort the next.
          try { call = pick(); }
          catch (error) { firstError = firstError ?? error; attempt(); return; }
          Promise.resolve(call).then(value => {
            // A cancellation is an answer: it must not open a second dialog.
            if (typeof value === 'string' && value) resolve(value); else resolve(null);
          }, error => { firstError = firstError ?? error; attempt(); });
        };
        attempt();
      });
    }
    function nativeFolderPicker(ctx: WT.Context) {
      const bridge = globalThis.__DSH_DIRECTORY_PICKER__;
      if (typeof bridge?.pick !== 'function') return undefined;
      const pickers = [() => bridge.pick()];
      // Capability was checked here; settleFirst still catches a later replacement/removal.
      if (typeof ctx.uiWorkspace?.pickDirectory === 'function') pickers.push(() => ctx.uiWorkspace.pickDirectory!());
      return () => settleFirst(pickers);
    }
    function addModesFor({ picker, browse }: { picker?: WT.Picker; browse: boolean }): WT.AddMode[] {
      return ['path', ...(picker ? ['native' as const] : []), ...(browse ? ['browse' as const] : [])];
    }
    function matchingAddMode(mode: string, modes: readonly string[]) {
      if (!modes.length || modes.includes(mode)) return mode;
      return modes.includes('native') ? 'native' : modes.includes('browse') ? 'browse' : 'path';
    }
    /** Entry to select while nothing has been chosen yet: the least typing for this session. */
    function preferredAddMode(modes: readonly string[]) {
      return modes.includes('native') ? 'native' : modes.includes('browse') ? 'browse' : 'path';
    }
    // The composed picker advertises both verbs, so availability is learned by
    // asking: one bounded probe (no path = the Host home) decides whether this
    // session can serve the in-app browser at all.
    async function browseSupported(uiWorkspace: WT.UIWorkspace) {
      if (typeof uiWorkspace?.listDirectory !== 'function') return false;
      const controller = new AbortController();
      try { await uiWorkspace.listDirectory(undefined, controller.signal); return true; }
      catch { return false; }
      finally { controller.abort(); }
    }
    function createFolderScanner(uiWorkspace: WT.UIWorkspace, publish: (patch: Partial<WT.ScannerState>) => void): WT.Scanner {      let active: AbortController | undefined, generation = 0, disposed = false;
      return {
        async scan(path?: string) {
          if (disposed) return;
          active?.abort(); const controller = new AbortController(); active = controller; const seq = ++generation;
          publish({ busy: true, error: null });
          try { const listing = await uiWorkspace.listDirectory(path, controller.signal); if (!disposed && !controller.signal.aborted && seq === generation) publish({ listing }); }
          catch (error) { if (!disposed && !controller.signal.aborted && seq === generation) publish({ error }); }
          finally { if (!disposed && !controller.signal.aborted && seq === generation) publish({ busy: false }); }
        },
        dispose() { disposed = true; ++generation; active?.abort(); },
      };
    }
    function projectMainFolder(project: WT.Project | null | undefined) {
      return project?.mainFolderId === undefined ? project?.folders[0] : project.folders.find(folder => folder.id === project.mainFolderId);
    }
    function draftMainFolder(folders: readonly string[], selected: string) { return folders.length === 1 ? folders[0] : folders.includes(selected) ? selected : ''; }
    function chooseConversationFolder(ctx: WT.Context, projects: WT.ProjectStore, flow: WT.Flow, sessionId: string, folderId: string) {
      const binding = ctx.sessions.binding(sessionId), context = projects.context(sessionId), state = flow.store.getSnapshot();
      if (!binding || projectActor(ctx.sessions.list.getSnapshot()) !== sessionId || !sourceEligible(binding.session.getSnapshot()) || !inputEmpty(ctx.get('conversation').input.for(binding.ctx).state.getSnapshot()) || (state.sessionId === sessionId && state.busy)) throw new WorktreeError('draftWarning', 'folder-change-blocked');
      const folder = context?.project.folders.find(item => item.id === folderId);
      if (!context || !folder) throw new WorktreeError('decode', 'invalid-project-folder');
      if (folder.id === context.folder.id && context.binding.mode === 'local') return false;
      ctx.uiWorkspace.startSession(folder.id); return true;
    }
    function createProjectSubmitter(projects: WT.ProjectStore, projectId: string | undefined, id: string): WT.ProjectSubmitter {
      let pending: Promise<WT.ProjectMutationResult> | undefined, pendingAction: WT.ProjectRequest['action'] | undefined;
      function commit(request: WT.ProjectRequest) {
        Object.freeze(request.folders); Object.freeze(request);
        const task = Promise.resolve().then(() => projects.mutate(request)); pending = task; pendingAction = request.action;
        const clear = () => { if (pending === task) { pending = undefined; pendingAction = undefined; } }; void task.then(clear, clear);
        return task;
      }
      const conflict = () => { throw new WorktreeError('busy', 'project-operation-pending'); };
      return {
        get pending() { return !!pending; },
        submit(title: string, folders: string[], selectedMain: string) {
          if (pending) return pendingAction === 'remove' ? conflict() : pending;
          const savedFolders = appendProjectFolders([], folders), mainFolder = draftMainFolder(savedFolders, selectedMain);
          if (savedFolders.length && !mainFolder) throw new WorktreeError('mainFolderRequired', 'main-folder-required');
          return commit(projectRequest({ ...(projectId ? { action: 'update', projectId } : { action: 'create', id }), title: title.trim(), folders: savedFolders, ...(mainFolder ? { mainFolder } : {}) }));
        },
        remove() {
          if (!projectId) throw new WorktreeError('decode', 'remove-requires-saved-project');
          if (pending) return pendingAction === 'remove' ? pending : conflict();
          return commit(projectRequest({ action: 'remove', projectId }));
        },
      };
    }
    function projectRequest<R extends WT.ProjectRequest>(request: R): R {
      const allowed: { [key: string]: readonly string[] } = { list: ['action', 'projectId'], create: ['action', 'id', 'title', 'folders', 'mainFolder'], update: ['action', 'projectId', 'title', 'folders', 'mainFolder'], remove: ['action', 'projectId'], bind: ['action', 'projectId', 'folderId', 'sessionId'], start: ['action', 'operationId', 'projectId', 'folderId'] };
      const keys = allowed[request?.action];
      const title = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
      const folders = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(absolutePath);
      const main = (value: unknown) => value === undefined || (absolutePath(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value));
      let valid = !!keys && Object.keys(request).every(key => keys.includes(key));
      if (request?.action === 'list') valid = valid && (request.projectId === undefined || uuid(request.projectId));
      if (request?.action === 'create') valid = valid && uuid(request.id) && title(request.title) && folders(request.folders) && main(request.mainFolder);
      if (request?.action === 'update') valid = valid && uuid(request.projectId) && (request.title !== undefined || request.folders !== undefined || request.mainFolder !== undefined) && (request.title === undefined || title(request.title)) && (request.folders === undefined || folders(request.folders)) && main(request.mainFolder);
      if (request?.action === 'remove') valid = valid && uuid(request.projectId);
      if (request?.action === 'bind') valid = valid && uuid(request.projectId) && string(request.folderId) && string(request.sessionId);
      if (request?.action === 'start') valid = valid && uuid(request.projectId) && uuid(request.operationId) && (request.folderId === undefined || string(request.folderId));
      if (!valid) throw new WorktreeError('decode', 'invalid-project-request');
      return request;
    }
    function projectRecord(value: unknown): value is WT.Project {
      return object(value) && uuid(value.id) && string(value.title) && value.title.length <= 120 && Array.isArray(value.folders) && value.folders.length > 0 && value.folders.length <= 32 && value.folders.every((folder: unknown) => object(folder) && string(folder.id) && absolutePath(folder.path) && typeof folder.title === 'string') && integer(value.createdAt) && value.createdAt >= 0 && !Object.is(value.createdAt, -0) && integer(value.updatedAt) && value.updatedAt >= 0 && !Object.is(value.updatedAt, -0) && (value.imported === undefined || typeof value.imported === 'boolean') && (value.mainFolderId === undefined || (string(value.mainFolderId) && value.folders.some((folder: unknown) => object(folder) && folder.id === value.mainFolderId)));
    }
    function projectBinding(value: unknown): value is WT.ProjectBinding {
      return object(value) && (value.cleanup === undefined || cleanupData(value.cleanup)) && string(value.sessionId) && uuid(value.projectId) && string(value.folderId) && typeof value.mode === 'string' && ['local', 'worktree'].includes(value.mode) && absolutePath(value.effectiveCwd) && (value.mode === 'worktree' ? uuid(value.worktreeId) : value.worktreeId === undefined);
    }
    function projectData<const R extends WT.ProjectRequest>(request: R, data: unknown): WT.ProjectReply<R> {
      let valid = object(data);
      if (!object(data)) throw new WorktreeError('decode', 'invalid-project-' + request.action + '-data');
      if (request.action === 'list') {
        valid = Array.isArray(data.projects) && data.projects.every(projectRecord) && Array.isArray(data.bindings) && data.bindings.every(projectBinding);
        if (valid && data.records !== undefined) validateData({ action: 'list' }, { items: data.records });
      }
      else if (request.action === 'start') valid = string(data.sessionId) && projectBinding(data.binding) && data.workspaceId === data.binding.folderId && data.binding.sessionId === data.sessionId && data.binding.projectId === request.projectId && (request.folderId === undefined || data.binding.folderId === request.folderId) && data.binding.mode === 'local';
      else if (request.action === 'remove') valid = data.removed === true && data.projectId === request.projectId && data.scope === 'project-metadata' && Object.keys(data).every(key => ['removed', 'projectId', 'scope'].includes(key));
      else if (request.action === 'bind') valid = projectBinding(data.binding) && data.binding.sessionId === request.sessionId && data.binding.projectId === request.projectId && data.binding.folderId === request.folderId;
      else valid = projectRecord(data.project) && data.project.id === (request.id || request.projectId);
      if (!valid) throw new WorktreeError('decode', 'invalid-project-' + request.action + '-data');
      return data as unknown as WT.ProjectReply<R>;
    }
    async function requestProjects<const R extends WT.ProjectRequest>(ctx: WT.Context, actorId: string | undefined, request: R, signal?: AbortSignal): Promise<WT.ProjectReply<R>> {
      projectRequest(request);
      if (actorId !== undefined && (typeof actorId !== 'string' || !actorId.trim())) throw new WorktreeError('actor', 'invalid-project-actor');
      return projectData(request, await quietRPC(ctx, 'dsh-worktrees/projects', { v: 1, request, ...(actorId === undefined ? {} : { actorId }) }, signal));
    }
    function workspaceStructure(snapshot: WT.Workspaces) {
      return JSON.stringify([snapshot.phase, snapshot.items.map(item => [item.workspaceId, item.path, item.title, item.sessionIds])]);
    }
    function projectContext(snapshot: WT.ProjectList, workspaces: WT.Workspaces, sessionId: string): WT.ProjectContext | undefined {
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
      return project && folder ? { project, folder, binding: { sessionId, projectId: project.id, folderId: folder.id, mode: 'local', effectiveCwd: folder.path } } : undefined;
    }
    function projectBacking(snapshot: WT.ProjectList, workspaces: WT.Workspaces, sessionId: string): WT.Backing {
      const context = projectContext(snapshot, workspaces, sessionId), workspace = workspaces.items.find(item => item.sessionIds.includes(sessionId));
      // Actual native cwd wins over historical membership/sessionIds, including a Local handoff.
      const effectiveCwd = workspace?.path || context?.binding.effectiveCwd || '';
      const record = (snapshot.records || []).find(item => item.effectiveCwd === effectiveCwd);
      const boundWorktree = context?.binding.mode === 'worktree' && context.binding.effectiveCwd === effectiveCwd;
      return { mode: record || boundWorktree ? 'worktree' : 'local', effectiveCwd, record };
    }
    function captureProject(context: WT.ProjectContext | undefined): Readonly<WT.CapturedProject> | undefined { return context ? Object.freeze({ projectId: context.project.id, folderId: context.folder.id, path: context.folder.path }) : undefined; }
    function sameProject(before: WT.CapturedProject | undefined, after: WT.CapturedProject | undefined) { return before?.projectId === after?.projectId && before?.folderId === after?.folderId && before?.path === after?.path; }
    function projectPath(status: WT.RepositoryReply, captured?: WT.CapturedProject) { return captured?.path || status.projectPath || status.repository.root; }
    function projectRows(metadata: WT.ProjectList, workspaces: WT.Workspaces, sessions: WT.Sessions, statuses: WT.Statuses, { query = '', archived = 'hide', selectedId }: { query?: string; archived?: string; selectedId?: string } = {}): WT.Group[] {
      const archives = new Set(workspaces.archivedSessionIds), pins = new Set(workspaces.pinnedSessionIds);
      const needle = query.trim().toLocaleLowerCase();
      const groups: WT.Group[] = metadata.projects.map(project => ({ project, rows: [] }));
      const unassigned: WT.Group = { project: null, rows: [] };
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
        const row = { id, session, title, context, backing: projectBacking(metadata, workspaces, id), archived: isArchived, pinned: !isArchived && pins.has(id), running: (live?.running ?? session.running ?? false) || childRunning, pending: live?.pendingInteraction, done: live?.completionUnread === true };
        (groups.find(group => group.project?.id === context?.project.id) || unassigned).rows.push(row);
      }
      for (const group of [...groups, unassigned]) group.rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.session.updatedAt || 0) - (a.session.updatedAt || 0) || a.id.localeCompare(b.id));
      return [...groups.filter(group => archived !== 'only' || group.rows.length), ...(unassigned.rows.length ? [unassigned] : [])];
    }
    function projectRowState(row: WT.Row): WT.RowState {
      if (row.archived || row.session.blank) return 'idle';
      return row.pending ? 'warning' : row.running ? 'ongoing' : row.done ? 'done' : 'idle';
    }
    function projectSessionTime(at: number | undefined, now: number, t: WT.Translate) {
      if (!finite(at) || at < 0 || at > 8640000000000000 || !Number.isFinite(now)) return null;
      const minute = 60000, hour = 3600000, day = 86400000, diff = Math.max(0, now - at);
      const [unit, n] = diff < minute ? ['now', 0] : diff < hour ? ['minutes', Math.floor(diff / minute)] : diff < day ? ['hours', Math.floor(diff / hour)] : diff < 30 * day ? ['days', Math.floor(diff / day)] : diff < 365 * day ? ['months', Math.floor(diff / (30 * day))] : ['years', Math.floor(diff / (365 * day))];
      const date = new Date(at), clock = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
      const absolute = t('date.ymd', { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }) + ' ' + clock;
      return { label: unit === 'now' ? t('time.now') : t('time.' + unit, { n }), dateTime: date.toISOString(), title: t('lastActive', { time: absolute }) };
    }
    function visibleProjectRows(rows: WT.Row[], limit: number, selectedId?: string) {
      let idle = 0;
      return rows.filter(row => row.session?.blank || row.running || row.pending || row.id === selectedId || idle++ < limit);
    }
    function projectActor(list: WT.Sessions) {
      const ids = Object.keys(list.byId).filter(id => (list.byId[id]?.retainedBy?.mainView || 0) > 0 && list.byId[id]?.origin !== 'subagent');
      return ids.length === 1 ? ids[0] : undefined;
    }
    function projectReady(reference: WT.Reference, signal: AbortSignal): Promise<WT.Binding> {
      return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new WorktreeError('cancelled', 'cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(reference.ready).then(binding => { signal.removeEventListener('abort', abort); resolve(binding); }, error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
      });
    }
    // One root-owned metadata cache. Reconnect and structural Workspace changes
    // refresh it; token/status updates and component mounts never issue reads.
    function createProjectStore(ctx: WT.Context, t: WT.Translate): WT.ProjectStore {
      let state: WT.Metadata = { projects: [], bindings: [], records: [], loading: false, error: '' }, serialized = '', disposed = false;
      let refreshRequest: AbortController | undefined, sequence = 0, queued = false, structure = workspaceStructure(ctx.workspaces.list.getSnapshot());
      let generation = ctx.connection.generation.getSnapshot()?.id;
      const listeners = new Set<WT.Listener>(), operations = new Set<{ controller: AbortController }>();
      const publish = (patch: Partial<WT.Metadata>) => { if (disposed) return; state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
      const store = { getSnapshot: () => state, subscribe: (listener: WT.Listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
      const context = (id: string) => projectContext(state, ctx.workspaces.list.getSnapshot(), id);
      function install(data: Partial<WT.Metadata>) {
        const next = JSON.stringify(data);
        if (next !== serialized) { serialized = next; publish(data); }
      }
      async function refresh() {
        if (disposed || operations.size || ctx.connection.generation.getSnapshot() === undefined) return;
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
      async function mutate(request: WT.ProjectRequest) {
        if (disposed) throw new WorktreeError('cancelled', 'project-store-closed');
        const controller = new AbortController(), op = { controller }; operations.add(op);
        // A read before or during a mutation cannot publish stale ownership.
        refreshRequest?.abort(); ++sequence;
        try {
          const actorId = request.action === 'remove' ? undefined : projectActor(ctx.sessions.list.getSnapshot());
          const data = await requestProjects(ctx, actorId, request, controller.signal);
          if (disposed || controller.signal.aborted) throw new WorktreeError('cancelled', 'cancelled');
          refreshRequest?.abort(); ++sequence;
          if (request.action === 'remove') install({ projects: state.projects.filter(item => item.id !== data.projectId), bindings: state.bindings.filter(item => item.projectId !== data.projectId) });
          const project = data.project;
          if (project) install({ projects: [...state.projects.filter(item => item.id !== project.id), project], bindings: state.bindings });
          const binding = data.binding;
          if (binding) install({ projects: state.projects, bindings: [...state.bindings.filter(item => item.sessionId !== binding.sessionId), binding] });
          return data;
        } finally { operations.delete(op); if (!operations.size) schedule(); }
      }
      const api = { store, context, refresh, mutate,
        rememberRecords(records: readonly WT.Record[]) { publish({ records: [...state.records.filter(item => !records.some(record => record.id === item.id)), ...records] }); },
        rememberWorktree(result: WT.SessionResult, captured?: WT.CapturedProject) {
          api.rememberRecords([result.worktree]);
          if (captured) install({ projects: state.projects, bindings: [...state.bindings.filter(item => item.sessionId !== result.sessionId), { sessionId: result.sessionId, projectId: captured.projectId, folderId: captured.folderId, mode: 'worktree', effectiveCwd: result.worktree.effectiveCwd, worktreeId: result.worktree.id }] });
          schedule();
        },
        dispose() { disposed = true; ++sequence; refreshRequest?.abort(); unsubscribeWorkspace(); unsubscribeConnection(); for (const op of operations) op.controller.abort(); operations.clear(); listeners.clear(); },
      };
      schedule(); return api;
    }
    const emptyRecoveryStore = Object.freeze({ getSnapshot: () => null, subscribe: () => () => {} });
    const recoveryVerified = (state: WT.RecoveryState | null, id: string) => state === null || state.sessionId === id && state.checked === true && !state.loading && !!state.info && (!recoveryBlocked(state.info.cleanup) || state.info.continuationSessionId === id);
    const recoveryBlocked = (cleanup: WT.Cleanup | null | undefined): cleanup is WT.Cleanup => !!cleanup && ['planned', 'preserving', 'removing', 'collected', 'recovery-required'].includes(cleanup.phase);
    function recoveryLabel(cleanup: WT.Cleanup | null | undefined, t: WT.Translate) {
      if (!cleanup) return '';
      return t(cleanup.phase === 'collected' ? 'reclaimed' : cleanup.phase === 'recovery-required' ? 'recovery' : cleanup.phase === 'deferred' ? 'cleanupDeferred' : 'gcCollecting');
    }
    function recoveryBranches(info: WT.RecoveryInfo | null, records: readonly WT.Record[] = []): WT.RecoveryBranch[] {
      if (!info?.repository) return [];
      const repository = info.repository;
      const current = repository.branch ?? 'HEAD';
      const retained = info.recoveredBranch ?? records.find(record => record.id === info.worktreeId)?.branch;
      const items = [{ name: current, oid: info.repository.head }, ...(info.branches || [])];
      const seen = new Set<string>();
      return items.filter(item => (item.name !== 'HEAD' || repository.branch === null) && !seen.has(item.name) && seen.add(item.name)).map(item => ({ ...item, current: item.name === current, retained: item.name === retained })).sort((a, b) => Number(b.current) - Number(a.current) || Number(b.retained) - Number(a.retained));
    }
    /** One root observer. Reads never resume a historical Host Agent or submit a prompt. */
    function createRecoveryStore(ctx: WT.Context, t: WT.Translate, projects: WT.ProjectStore): WT.RecoveryStore {
      let disposed = false, sequence = 0, queued = false, forceRead = false, active: WT.RecoveryOperation | undefined;
      let state: WT.RecoveryState = { sessionId: undefined, info: null, branches: [], selected: null, query: '', checked: false, loading: false, paging: false, busy: false, error: '', foreignBlock: false, cancelled: false, draftHistoryId: undefined };
      const listeners = new Set<WT.Listener>(), blocks = new Map<string, WT.RecoveryBlock>(), references = new Map<string, WT.Reference>(), targets = new Map<string, string>(), history = new Set<string>();
      const publish = (patch: Partial<WT.RecoveryState>) => { if (disposed) return; state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
      const store = { getSnapshot: () => state, subscribe(listener: WT.Listener) { listeners.add(listener); return () => listeners.delete(listener); } };
      const owns = (op: WT.RecoveryOperation) => !disposed && active === op && !op.controller.signal.aborted && currentActor(ctx.sessions.list.getSnapshot()) === op.id && ctx.connection.generation.getSnapshot()?.id === op.generation;
      function preserveDraft(id: string) {
        if (references.has(id)) return;
        // Public SessionReference keeps the original structured editor, chips and
        // browser File drafts alive. No public atomic structured migration exists.
        const reference = ctx.sessions.retain(id, { source: 'controllerOperation' });
        references.set(id, reference);
        void Promise.resolve(reference.ready).catch(() => { if (!disposed && state.sessionId === id) publish({ error: t('gcDraftHeld') }); });
      }
      function block(id: string, needed: boolean) {
        let entry = blocks.get(id);
        if (!needed) {
          if (entry) { entry.unsubscribe(); entry.handle?.release(); blocks.delete(id); }
          return;
        }
        preserveDraft(id);
        if (!entry) {
          const source = ctx.conversation.blocks.storeFor(id);
          entry = { source, handle: null, acquiring: false, unsubscribe: () => {} };
          blocks.set(id, entry);
          const ownedEntry = entry;
          entry.unsubscribe = source.subscribe(() => syncBlock(id, ownedEntry));
        }
        syncBlock(id, entry);
      }
      function syncBlock(id: string, entry: WT.RecoveryBlock) {
        if (disposed || entry.acquiring || blocks.get(id) !== entry) return;
        entry.acquiring = true;
        try {
          const current = entry.source.getSnapshot();
          if (entry.handle && current !== entry.handle.owned) entry.handle = null;
          if (current === undefined) entry.handle = acquireBlock(ctx.conversation.blocks, id, t('gcBlock'));
          if (state.sessionId === id) publish({ foreignBlock: entry.source.getSnapshot() !== entry.handle?.owned });
        } finally { entry.acquiring = false; }
      }
      function hint(id: string) {
        return projects?.store.getSnapshot().records?.find(record => record.sessionIds.includes(id));
      }
      function draftHistory(id: string) { return [...references.keys()].find(source => source !== id && targets.get(source) === id); }
      // Only explicit recovery actions navigate. rc.2 has no public read-only
      // current navigation signal: even beginNavigation before an initial read
      // could cancel a native Workspace/New Thread choice already in flight.
      async function navigate(op: WT.RecoveryOperation, target?: string | null, capturedNavigation?: AbortSignal) {
        if (!owns(op) || !target) return;
        let navigation: AbortSignal | undefined;
        try {
          preserveDraft(op.id); targets.set(op.id, target);
          navigation = capturedNavigation || ctx.layout.beginNavigation();
          if (!owns(op) || navigation.aborted) return;
          await ctx.uiWorkspace.openSession(target);
        } catch (failure) { if (owns(op) && !navigation?.aborted) publish({ error: report(t, failure) }); }
      }
      function install(op: WT.RecoveryOperation, info: WT.RecoveryInfo, append = false) {
        if (!owns(op)) return;
        op.page?.abort(); op.page = null;
        const old = state.info;
        const sameGeneration = append || old?.observedAt === info.observedAt && old?.repository?.head === info.repository?.head && old?.repository?.branch === info.repository?.branch;
        const branches = recoveryBranches({ ...info, branches: append ? [...(old?.branches || []), ...(info.branches || [])] : info.branches }, projects?.store.getSnapshot().records);
        const previousSelected = state.selected;
        const selected = sameGeneration && previousSelected && branches.some(item => item.name === previousSelected.name && item.oid === previousSelected.oid) ? previousSelected : null;
        const merged = append ? { ...info, branches: branches.map(({ name, oid }) => ({ name, oid })) } : info;
        const readyHere = info.continuationSessionId === op.id;
        block(op.id, recoveryBlocked(info.cleanup) && !readyHere);
        if (info.pendingSessionId && info.pendingSessionId !== op.id) targets.set(op.id, info.pendingSessionId);
        publish({ info: merged, branches, selected, checked: true, loading: false, paging: false, error: '', cancelled: history.has(op.id), draftHistoryId: draftHistory(op.id) });
        // Ready metadata keeps history and its warning visible. The existing
        // Open action can select the exact Local target on a genuine user click;
        // asynchronous facts never acquire or supersede navigation authority.
      }
      async function watch(op: WT.RecoveryOperation, info: WT.RecoveryInfo) {
        op.watch?.abort(); const controller = new AbortController(); op.watch = controller;
        const signal = AbortSignal.any([op.controller.signal, controller.signal]);
        let revision = info.revision;
        try {
          while (owns(op) && !signal.aborted) {
            const next = await requestRecovery(ctx, { action: 'reopen-info', sourceSessionId: op.id, after: revision }, signal);
            if (!owns(op) || signal.aborted) return;
            if (next.revision <= revision) throw new WorktreeError('decode', 'lifecycle-revision-not-advanced');
            revision = next.revision; install(op, next);
          }
        } catch (failure) { if (owns(op) && !signal.aborted) publish({ error: report(t, failure) }); }
      }
      async function read(force = false) {
        if (disposed) return;
        const id = currentActor(ctx.sessions.list.getSnapshot()), generation = ctx.connection.generation.getSnapshot()?.id;
        if (!force && active && active.id === id && active.generation === generation && !active.controller.signal.aborted) return;
        active?.controller.abort(); ++sequence;
        const cached = state.sessionId === id ? state.info : null;
        if (!id || generation === undefined) { active = undefined; publish({ sessionId: id, info: cached, checked: false, loading: false, busy: false, paging: false }); return; }
        const op: WT.RecoveryOperation = { id, generation, sequence, controller: new AbortController(), watch: null, page: null, action: null }; active = op;
        publish({ sessionId: id, info: cached, branches: [], selected: null, query: '', checked: false, loading: true, paging: false, busy: false, error: '', foreignBlock: false, cancelled: history.has(id), draftHistoryId: draftHistory(id) });
        const record = hint(id);
        try {
          if (recoveryBlocked(record?.cleanup)) {
            block(id, true);
            if (!cached) publish({ info: { sourceSessionId: id, worktreeId: record.id, cleanup: record.cleanup, originalFolder: record.cleanup.originalFolder, continuationSessionId: null, revision: 0 } });
          }
          const info = await requestRecovery(ctx, { action: 'reopen-info', sourceSessionId: id, limit: 100 }, op.controller.signal);
          if (!owns(op)) return;
          install(op, info); void watch(op, info);
        } catch (failure) { if (owns(op)) publish({ loading: false, error: report(t, failure) }); }
      }
      function schedule(force = false) {
        forceRead ||= force;
        if (queued || disposed) return;
        queued = true;
        Promise.resolve().then(() => { queued = false; const refresh = forceRead; forceRead = false; if (!disposed) void read(refresh); });
      }
      function changed() {
        const id = currentActor(ctx.sessions.list.getSnapshot()), generation = ctx.connection.generation.getSnapshot()?.id;
        if (active && (id !== active.id || generation !== active.generation)) active.controller.abort();
        schedule();
      }
      const stopSessions = ctx.sessions.list.subscribe(changed), stopConnection = ctx.connection.generation.subscribe(changed);
      async function more() {
        const op = active, initial = state.info;
        if (!op || !owns(op) || !state.checked || state.paging || state.busy || !initial?.nextCursor) return;
        const controller = new AbortController(); op.page?.abort(); op.page = controller;
        const signal = AbortSignal.any([op.controller.signal, controller.signal]); publish({ paging: true, error: '' });
        try {
          const page = await requestRecovery(ctx, { action: 'reopen-info', sourceSessionId: op.id, cursor: initial.nextCursor, limit: 100 }, signal);
          if (!owns(op) || signal.aborted || state.info !== initial) return;
          if (page.revision !== initial.revision || page.observedAt !== initial.observedAt || JSON.stringify(page.repository) !== JSON.stringify(initial.repository)) throw new WorktreeError('gcBranchChanged', 'branch-generation-changed');
          install(op, page, true);
        } catch (failure) { if (owns(op) && !signal.aborted) publish({ paging: false, error: report(t, failure) }); }
      }
      async function resume() {
        const op = active, selected = state.selected;
        if (!op || !owns(op) || !state.checked || state.busy || !selected || state.info?.cleanup?.phase !== 'collected' || state.info.continuationSessionId) return;
        op.watch?.abort(); op.page?.abort(); const controller = new AbortController(); op.action = controller;
        const navigation = ctx.layout.beginNavigation();
        const signal = AbortSignal.any([op.controller.signal, controller.signal, navigation]);
        publish({ busy: true, error: '' });
        try {
          preserveDraft(op.id);
          const result = await requestRecovery(ctx, { action: 'reopen', sourceSessionId: op.id, localBranch: selected.name, localOid: selected.oid }, signal);
          if (!owns(op) || signal.aborted) return;
          targets.set(op.id, result.sessionId);
          if (result.sessionId === op.id) { block(op.id, false); publish({ busy: false, info: { ...state.info, continuationSessionId: result.sessionId, recoveredBranch: result.branch }, selected: null }); }
          else await navigate(op, result.sessionId, navigation);
        } catch (failure) {
          if (owns(op) && !signal.aborted) {
            // A refusal may have staged a REAL Local target for standard permission
            // controls. Refresh facts quietly; never invent a permission actor.
            publish({ busy: false, error: report(t, failure) });
            try { const info = await requestRecovery(ctx, { action: 'reopen-info', sourceSessionId: op.id, limit: 100 }, op.controller.signal); if (owns(op)) { install(op, info); publish({ error: report(t, failure) }); } } catch { /* original refusal and draft remain */ }
          }
        } finally {
          if (owns(op)) {
            op.action = null;
            // A newer native navigation has priority even before mainView counts
            // settle. Later lifecycle facts must not undo that explicit intent.
            if (navigation.aborted) history.add(op.id);
            publish({ busy: false, cancelled: history.has(op.id) });
            if (state.info) void watch(op, state.info);
          }
        }
      }
      const api = { store, refresh: () => read(true), more, resume,
        setQuery(query: string) { publish({ query }); },
        choose(name: string) { if (!active || !owns(active) || !state.checked || state.busy) return false; const item = state.branches.find(branch => branch.name === name); if (!item) return false; history.delete(active.id); publish({ selected: { name: item.name, oid: item.oid }, cancelled: false, error: '' }); return true; },
        cancel() { if (!active) return; active.action?.abort(); history.add(active.id); publish({ selected: null, cancelled: true, busy: false }); },
        retry() { if (!active) return; history.delete(active.id); publish({ cancelled: false }); return read(true); },
        openTarget() { const op = active; if (op && owns(op) && state.checked) return navigate(op, state.info?.continuationSessionId); },
        openPermissions() { const op = active; if (op && owns(op) && state.checked) return navigate(op, state.info?.pendingSessionId); },
        openHistory() { const id = state.draftHistoryId; if (!id || !references.has(id)) return; history.add(id); return ctx.uiWorkspace.openSession(id); },
        dispose() { if (disposed) return; disposed = true; active?.controller.abort(); stopSessions(); stopConnection(); for (const entry of blocks.values()) { entry.unsubscribe(); entry.handle?.release(); } blocks.clear(); for (const reference of references.values()) reference.release(); references.clear(); listeners.clear(); },
      };
      schedule(); return api;
    }
    function rootFolderValue(state: WT.SettingsState | undefined) { return typeof state?.value?.root === 'string' ? state.value.root : ''; }
    async function writeRootFolder(form: WT.SettingsForm | undefined, draft: unknown, expectedRevision: number | undefined, reset = false) {
      const state = form?.state;
      if (!state || state.status !== 'ready' || !state.writable || state.mode !== 'host' || typeof form.mutate !== 'function') throw new WorktreeError('rootUnavailable', 'settings-unavailable');
      if (!integer(expectedRevision) || expectedRevision < 0) throw new WorktreeError('rootUnavailable', 'missing-settings-revision');
      const root = typeof draft === 'string' ? draft.trim() : '';
      if (!reset && (!absolutePath(root) || root.length > 4096 || /[\u0000-\u001f\u007f]/u.test(root))) throw new WorktreeError('rootInvalid', 'invalid-root-path');
      const accepted = await form.mutate([reset ? { op: 'unset', path: ['root'] } : { op: 'set', path: ['root'], value: root }], expectedRevision);
      if (accepted !== true) throw new WorktreeError('rootConflict', 'root-setting-refused');
      return root;
    }
    function cleanupSettingsValue(state: WT.SettingsState | undefined) {
      return { enabled: typeof state?.value?.cleanupEnabled === 'boolean' ? state.value.cleanupEnabled : true, days: integer(state?.value?.cleanupInactivityDays) ? state.value.cleanupInactivityDays : 10 };
    }
    async function writeCleanupSettings(form: WT.SettingsForm | undefined, enabled: boolean, days: number | string, expectedRevision: number | undefined, reset = false) {
      const state = form?.state;
      if (!state || state.status !== 'ready' || !state.writable || state.mode !== 'host' || typeof form.mutate !== 'function') throw new WorktreeError('rootUnavailable', 'settings-unavailable');
      if (!integer(expectedRevision) || expectedRevision < 0) throw new WorktreeError('rootUnavailable', 'missing-settings-revision');
      const value = typeof days === 'string' && /^\d+$/.test(days) ? Number(days) : days;
      if (!reset && (typeof enabled !== 'boolean' || !integer(value) || value < 1 || value > 3650)) throw new WorktreeError('cleanupInvalid', 'invalid-inactivity-days');
      const ops: WT.SettingsOperation[] = reset ? [{ op: 'unset', path: ['cleanupEnabled'] }, { op: 'unset', path: ['cleanupInactivityDays'] }] : [{ op: 'set', path: ['cleanupEnabled'], value: enabled }, { op: 'set', path: ['cleanupInactivityDays'], value }];
      if (await form.mutate(ops, expectedRevision) !== true) throw new WorktreeError('cleanupConflict', 'cleanup-setting-refused');
      return { enabled, days: value };
    }
    const NATIVE_SUBMIT_ABI = '0.2.0-rc.2/default-sink-v1';
    const later = (callback: () => void) => { void Promise.resolve().then(() => Promise.resolve()).then(callback); };
    function interrupted<T>(promise: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
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
    function leaseNativeSink(input: WT.Input, binding: WT.Binding, hooks: WT.SinkHooks): WT.SinkLease {
      // PropertyDescriptor.value and Reflect.get are dynamic platform boundaries.
      // Capture them as unknown, then admit only this exact, callable rc.2 ABI.
      const own = (value: object, key: PropertyKey) => Object.getOwnPropertyDescriptor(value, key);
      const slot = own(input, 'deps'), deps: unknown = slot && 'value' in slot && slot.value;
      const sink = object(deps) ? own(deps, 'defaultSink') : undefined;
      const triggers = object(deps) ? own(deps, 'inputTriggers') : undefined;
      const actor = object(deps) ? own(deps, 'actx') : undefined;
      const sinkValue: unknown = sink?.value, triggerValue: unknown = triggers?.value;
      if (!object(deps) || !actor || !('value' in actor) || actor.value !== binding.ctx || !sink || !('value' in sink) || !sink.writable || typeof sinkValue !== 'function' || sinkValue.length !== 4 || !triggers || !('value' in triggers) || !triggers.writable || typeof triggerValue !== 'function') throw new WorktreeError('unsupported', 'native-submit-abi', NATIVE_SUBMIT_ABI);
      type NativeSink = (text: string, ids: string[], mode: WT.SubmitMode, signal: AbortSignal) => Promise<WT.SubmitResult>;
      // Parameter/return contracts belong to the explicitly versioned native ABI;
      // reflection cannot inspect a function's TypeScript signature at runtime.
      const original = sinkValue as NativeSink, originalTriggers = triggerValue as () => object | null | undefined;
      const tokens = new Map<AbortSignal, WT.SinkToken>(), active = new Set<Promise<unknown>>();
      const shutdown = new AbortController(); let closing = false, closeTask: Promise<void> | undefined;
      const track = <T,>(promise: Promise<T>): Promise<T> => { active.add(promise); void promise.then(() => active.delete(promise), () => active.delete(promise)); return promise; };
      function finish(token: WT.SinkToken, error?: unknown) {
        if (token.finished) return; token.finished = true;
        token.nativeSignal.removeEventListener('abort', token.abort);
        later(() => { hooks.settled(token.choice, error); tokens.delete(token.nativeSignal); token.done(); });
      }
      function tokenFor(nativeSignal: AbortSignal): WT.SinkToken {
        const existing = tokens.get(nativeSignal); if (existing) return existing;
        const controller = new AbortController(); let done: () => void = () => {};
        const token: WT.SinkToken = { nativeSignal, controller, signal: AbortSignal.any([nativeSignal, controller.signal, shutdown.signal]), entered: false, finished: false, donePromise: new Promise<void>(resolve => { done = resolve; }), done: () => done(), choice: { mode: 'local' }, abort: () => {} };
        token.choice = hooks.capture(token.signal, controller);
        token.abort = () => finish(token, new WorktreeError('cancelled', 'native-attempt-cancelled'));
        nativeSignal.addEventListener('abort', token.abort, { once: true }); tokens.set(nativeSignal, token);
        if (nativeSignal.aborted) token.abort();
        return token;
      }
      async function adapter(text: string, ids: string[], mode: WT.SubmitMode, nativeSignal: AbortSignal): Promise<WT.SubmitResult> {
        let token: WT.SinkToken | undefined;
        try {
          token = tokenFor(nativeSignal); token.entered = true;
          if (closing || token.signal.aborted) throw new WorktreeError('cancelled', 'cancelled');
          if (token.choice.mode === 'local') { await hooks.beforeLocal?.(ids, token.signal); return await track(interrupted(original.call(deps, text, ids, mode, token.signal), token.signal)); }
          return await track(hooks.submit(token.choice, text, ids, mode, token.signal));
        } catch (error) { return { kind: 'error', text: hooks.error(error) }; }
        finally { if (token) finish(token); }
      }
      const controllers = new WeakMap<object, object>();
      function triggerAdapter(): object | null | undefined {
        const controller = originalTriggers.call(deps);
        if (!controller) return controller;
        const existing = controllers.get(controller); if (existing) return existing;
        const bound = new Map<PropertyKey, unknown>();
        const proxy = new Proxy(controller, { get(target, key) {
          if (key === 'adjudicate' || key === 'serializeReference') {
            if (!bound.has(key)) bound.set(key, async (...args: unknown[]) => {
              let token: WT.SinkToken | undefined;
              try {
                const signal = args[key === 'adjudicate' ? 1 : 2];
                if (!object(signal) || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') throw new WorktreeError('unsupported', 'native-submit-signal', NATIVE_SUBMIT_ABI);
                token = tokenFor(signal as unknown as AbortSignal);
                const next = [...args]; next[key === 'adjudicate' ? 1 : 2] = token.signal;
                const method: unknown = Reflect.get(target, key, target);
                if (typeof method !== 'function') throw new WorktreeError('unsupported', 'native-trigger-method', NATIVE_SUBMIT_ABI);
                const result = await track(interrupted<unknown>(Reflect.apply(method, target, next), token.signal));
                if (key === 'adjudicate' && result !== undefined) finish(token);
                return result;
              } catch (error) { if (token) { token.controller.abort(); finish(token, error); } throw error; }
            });
            return bound.get(key);
          }
          const value: unknown = Reflect.get(target, key, target);
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
    function setupProgress(data: unknown, operationId: string, previous = 0): WT.Progress {
      const stages = ['fetching', 'creating', 'naming', 'opening', 'ready'];
      if (!object(data) || data.operationId !== operationId || !integer(data.revision) || data.revision <= previous || typeof data.terminal !== 'boolean' || !Array.isArray(data.stages) || data.stages.length > 8 || !data.stages.every((item: unknown) => object(item) && typeof item.stage === 'string' && stages.includes(item.stage) && item.operationId === operationId && (item.worktreeId === undefined || uuid(item.worktreeId)))) throw new WorktreeError('decode', 'invalid-progress');
      return data as unknown as WT.Progress;
    }
    async function prepareWorktree(ctx: WT.Context, actorId: string, request: WT.WorktreeRequest & { action: 'create'; operationId: string }, signal: AbortSignal, onProgress: (steps: WT.ProgressStep[]) => void): Promise<WT.SessionResult> {
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
    function waitForDraftFiles(conversation: WT.Conversation, ids: string[], signal: AbortSignal): Promise<void> {
      const descriptors = conversation.resolveDraftAttachments(ids);
      if (descriptors.length !== ids.length) return Promise.reject(new WorktreeError('filesLost', 'draft-files-unavailable'));
      const files = descriptors.filter(item => item.kind === 'file');
      return new Promise((resolve, reject) => {
        let unsubscribe = () => {}, done = false;
        const finish = (error?: unknown) => { if (done) return; done = true; unsubscribe(); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const abort = () => finish(new WorktreeError('cancelled', 'cancelled'));
        const check = () => {
          const uploads = conversation.fileUploads.getSnapshot();
          const missing = files.find(item => !uploads[item.id]), failed = files.find(item => uploads[item.id]?.status === 'error');
          if (missing) finish(new WorktreeError('filesLost', 'file-upload-unavailable'));
          else if (failed) finish(new WorktreeError('upload', 'file-upload-failed', uploads[failed.id]?.message));
          else if (files.every(item => uploads[item.id]?.status === 'ready')) finish();
        };
        unsubscribe = conversation.fileUploads.subscribe(check); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); else check();
      });
    }
    function createRepositoryAvailability(ctx: WT.Context, projects: WT.ProjectStore): WT.RepositoryAvailability {
      const listeners = new Set<WT.Listener>(); let disposed = false, started = false, observedSession: string | undefined, active: { controller: AbortController; task: Promise<void> | null } | undefined, version = 0, stopBinding = () => {}, queued = false, connectionId = ctx.connection.generation.getSnapshot()?.id;
      let state: WT.RepositoryState = { target: null, phase: 'idle', available: false, status: null };
      const publish = (patch: Partial<WT.RepositoryState>) => { if (disposed) return; state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
      const store = { getSnapshot: () => state, subscribe: (listener: WT.Listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
      function target(sessionId: string | undefined): WT.RepositoryTarget | null {
        if (!sessionId || projectActor(ctx.sessions.list.getSnapshot()) !== sessionId) return null;
        const binding = ctx.sessions.binding(sessionId), connection = ctx.connection.generation.getSnapshot();
        if (!binding || !connection || !sourceEligible(binding.session.getSnapshot())) return null;
        const project = captureProject(projects.context(sessionId));
        return { sessionId, binding, connection: connection.id, project, path: project?.path };
      }
      const same = (left: WT.RepositoryTarget | null, right: WT.RepositoryTarget | null) => !!left && !!right && left.sessionId === right.sessionId && left.binding === right.binding && left.connection === right.connection && sameProject(left.project, right.project);
      function reset() { active?.controller.abort(); active = undefined; ++version; stopBinding(); stopBinding = () => {}; publish({ target: null, phase: 'idle', available: false, status: null }); }
      function schedule() { if (!started || queued || disposed) return; queued = true; void Promise.resolve().then(() => { queued = false; if (!disposed) void ensure(projectActor(ctx.sessions.list.getSnapshot())); }); }
      function changed() { const current = target(projectActor(ctx.sessions.list.getSnapshot())); if (state.target && !same(current, state.target)) reset(); if (current && !state.target) schedule(); }
      function ensure(sessionId?: string) {
        if (disposed) return Promise.resolve(); started = true; observedSession = sessionId;
        const next = target(sessionId);
        if (!next) { if (state.target) reset(); return Promise.resolve(); }
        if (same(next, state.target) && state.phase !== 'idle') return active?.task || Promise.resolve();
        reset(); const controller = new AbortController(), seq = ++version;
        const operation: { controller: AbortController; task: Promise<void> | null } = { controller, task: null }; active = operation;
        stopBinding = next.binding.session.subscribe(changed);
        operation.task = Promise.resolve().then(async () => {
          if (disposed || controller.signal.aborted || seq !== version || !same(target(sessionId), next)) return;
          try {
            // Read-only local discovery through the existing caller-authorized status operation.
            const data = await requestHost(ctx, sessionId, { action: 'status', ...(next.path ? { repoPath: next.path } : {}) }, controller.signal);
            if (next.path && data.projectPath !== next.path) throw new WorktreeError('decode', 'repository-target-mismatch');
            if (!disposed && !controller.signal.aborted && seq === version && same(target(sessionId), next)) publish({ phase: 'ready', available: true, status: data });
          } catch { if (!disposed && !controller.signal.aborted && seq === version && same(target(sessionId), next)) publish({ phase: 'unavailable', available: false }); }
          finally { if (active === operation) active = undefined; }
        });
        publish({ target: next, phase: 'checking', available: false });
        return operation.task;
      }
      const subscriptions = [ctx.sessions.list.subscribe(changed), projects.store.subscribe(changed), ctx.connection.generation.subscribe(() => { const next = ctx.connection.generation.getSnapshot()?.id; if (next === connectionId) return; connectionId = next; reset(); schedule(); })];
      return { store, ensure,
        withdraw(sessionId: string) { if (observedSession === sessionId) { started = false; observedSession = undefined; reset(); } },
        unavailable(sessionId: string, binding: WT.Binding, project?: WT.CapturedProject) { const current = target(sessionId); if (disposed || !current || !same(current, state.target) || current.binding !== binding || !sameProject(current.project, project)) return; active?.controller.abort(); active = undefined; ++version; publish({ phase: 'unavailable', available: false }); },
        enabled(sessionId?: string) { return !disposed && state.phase === 'ready' && state.available && same(target(sessionId), state.target); },
        dispose() { if (disposed) return; active?.controller.abort(); ++version; stopBinding(); subscriptions.forEach(stop => stop()); disposed = true; listeners.clear(); },
      };
    }
    function createWorktreeFlow(ctx: WT.Context, t: WT.Translate, projects: WT.ProjectStore, repositories: WT.RepositoryAvailability): WT.Flow {
      const conversation = ctx.get('conversation'), listeners = new Set<WT.Listener>(), leases = new Map<WT.Binding, WT.SinkLease>(), operations = new Set<WT.WorktreeOperation>(), restaged = new Set<string>();
      let state: WT.FlowState = { sessionId: undefined, mode: 'local', sourceChanged: false, busy: false, loading: false, error: '', status: null, branchSource: 'local', remote: '', branch: '', branchOid: '', branches: null, query: '', steps: [], phase: '', op: null };
      const branchCache = new Map<string, WT.Branches>();
      let query: AbortController | undefined, selectedSource: { sessionId: string; binding?: WT.Binding; project?: WT.CapturedProject } | undefined, generation = 0, disposed = false;
      const publish = (patch: Partial<WT.FlowState>) => { if (disposed) return; state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
      const store = { getSnapshot: () => state, subscribe: (listener: WT.Listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
      const pending = (id: string) => ctx.uiSession.sessionStatus.getSnapshot().get(id)?.pendingInteraction !== undefined;
      const repositoryAllowed = (id: string | undefined) => repositories?.enabled(id) === true;
      function requireRepository(sessionId: string) { if (!repositoryAllowed(sessionId)) throw new WorktreeError('repoUnavailable', 'repository-not-verified'); }
      async function repositoryStatus(sessionId: string, binding: WT.Binding, project: WT.CapturedProject | undefined, signal: AbortSignal) {
        try {
          const data = await requestHost(ctx, sessionId, { action: 'status', ...(project ? { repoPath: project.path } : {}) }, signal);
          if (project && data.projectPath !== project.path) throw new WorktreeError('decode', 'repository-target-mismatch');
          return data;
        } catch (error) { if (!signal.aborted) repositories?.unavailable(sessionId, binding, project); throw error; }
      }
      function source(sessionId: string): WT.Source {
        const binding = ctx.sessions.binding(sessionId), input = binding && conversation.input.for(binding.ctx);
        if (!binding || !input || projectActor(ctx.sessions.list.getSnapshot()) !== sessionId || !sourceEligible(binding.session.getSnapshot()) || pending(sessionId)) throw new WorktreeError('changed', 'source-not-blank-idle');
        return { binding, input, project: captureProject(projects.context(sessionId)) };
      }
      function requireIntent(sessionId: string, current: WT.Source) {
        if (state.sessionId === sessionId && state.mode === 'new' && (state.sourceChanged || !selectedSource || selectedSource.binding !== current.binding || !sameProject(selectedSource.project, current.project))) throw new WorktreeError('projectChanged', 'selected-worktree-source-changed');
      }
      function checkSource(sessionId: string, before: WT.Source) {
        const current = source(sessionId); requireRepository(sessionId); requireIntent(sessionId, current);
        if (current.binding !== before.binding || !sameProject(current.project, before.project)) throw new WorktreeError('changed', 'source-changed');
      }
      function check(op: WT.WorktreeOperation) {
        if (disposed || op.signal.aborted || op.navigation.aborted) throw new WorktreeError('cancelled', 'cancelled');
        const current = source(op.sessionId); requireRepository(op.sessionId);
        if (current.binding !== op.binding || !sameProject(current.project, op.project)) throw new WorktreeError('changed', 'source-changed');
        if (op.block.store.getSnapshot() !== op.block.owned) throw new WorktreeError('ownership', 'block-lost');
      }
      function capture(sessionId: string, binding: WT.Binding, signal: AbortSignal, controller: AbortController): WT.Choice {
        if (state.sessionId !== sessionId || state.mode !== 'new') return { mode: 'local' };
        if (state.busy) throw new WorktreeError('busy', 'first-message-already-preparing');
        requireRepository(sessionId);
        const captured = source(sessionId); requireIntent(sessionId, captured); if (captured.binding !== binding) throw new WorktreeError('changed', 'binding-changed');
        const old = state.op;
        if (old && !old.retryable) throw new WorktreeError('recovery', 'check-created-conversation-before-retry');
        const intent = Object.freeze({ branchSource: state.branchSource, branchOid: state.branchOid, remote: state.remote, branch: state.branch, branches: state.branches && Object.freeze({ ...state.branches, items: Object.freeze(state.branches.items.map(item => Object.freeze({ ...item }))) }) });
        query?.abort(); ++generation; branchCache.clear();
        const navigation = ctx.layout.beginNavigation(), operationId = old?.id || crypto.randomUUID();
        const sourceReference = ctx.sessions.retain(sessionId, { source: 'controllerOperation' });
        let block: WT.BlockHandle;
        try { block = acquireBlock(conversation.blocks, sessionId, t('preparingMessage')); }
        catch (error) { sourceReference.release(); throw error; }
        const op: WT.WorktreeOperation = { ...captured, intent, mode: 'new', id: operationId, sessionId, controller, signal, navigation, result: old?.result || null, request: old?.request || null, retryable: false, admission: 'none', reference: null, sourceReference, block, staged: false, cleanup: () => {} };
        const cancel = () => controller.abort(), changed = () => { if (op.committing) return; try { check(op); } catch { cancel(); } };
        const subscriptions = [ctx.sessions.list, binding.session, projects.store, ctx.uiSession.sessionStatus, op.block.store].map(item => item.subscribe(changed));
        navigation.addEventListener('abort', cancel, { once: true });
        op.cleanup = () => { navigation.removeEventListener('abort', cancel); subscriptions.splice(0).forEach(remove => remove()); op.block.release(); };
        operations.add(op); publish({ op, busy: true, loading: false, error: '', steps: [], phase: 'preparing' }); return op;
      }
      function settled(op: WT.Choice, preflightError?: unknown) {
        if (op?.mode !== 'new') return;
        if (!op.sinkEntered) { op.retryable = true; publish({ busy: false, op: null, phase: '', error: preflightError ? report(t, preflightError) : '' }); }
        op.cleanup(); operations.delete(op);
        if (op.sourceReference) { if (disposed || op.accepted) op.sourceReference.release(); else releaseAfterMainOwnership(ctx, op.sourceReference, true); op.sourceReference = null; }
        if (op.reference) { if (disposed) op.reference.release(); else releaseAfterMainOwnership(ctx, op.reference, !!op.accepted); op.reference = null; }
      }
      async function submit(op: WT.WorktreeOperation, text: string, ids: string[], mode: WT.SubmitMode, signal: AbortSignal): Promise<WT.SubmitResult> {
        op.sinkEntered = true; op.text = text; op.ids = [...ids];
        try {
          check(op);
          if (!text.trim() && !ids.length) { publish({ busy: false, phase: '', op: null }); return { kind: 'success' }; }
          publish({ phase: op.intent.branchSource === 'local' ? 'creating' : 'fetching' });
          if (!op.result) {
            const status = await repositoryStatus(op.sessionId, op.binding, op.project, signal); check(op);
            let startingBranch: { branchSource: 'local'; localBranch: string; localOid: string } | { branchSource: 'remote'; remote: string; remoteIdentity?: string; remoteBranch: string };
            if (op.intent.branchSource === 'local') {
              const branch = op.intent.branchOid ? op.intent.branch : status.repository.branch || 'HEAD';
              startingBranch = { branchSource: 'local', localBranch: branch, localOid: op.intent.branchOid || status.repository.head };
            } else {
              const remote = op.intent.remote || (status.remotes.some(item => item.name === status.defaults?.remote) ? status.defaults?.remote || '' : status.remotes[0]?.name || '');
              if (!remote) throw new WorktreeError('noRemote', 'no-remote');
              const identity = status.remotes.find(item => item.name === remote)?.identity;
              const advertised = op.intent.branches && op.intent.remote === remote ? op.intent.branches : await requestHost(ctx, op.sessionId, { action: 'branches', repoPath: projectPath(status, op.project), remote, remoteIdentity: identity, limit: 100 }, signal); check(op);
              const branch = op.intent.branch || advertisedDefault(advertised, status.repository.branch || status.defaults?.branch); if (!branch) throw new WorktreeError('noRemote', 'select-remote-branch');
              startingBranch = { branchSource: 'remote', remote, remoteIdentity: advertised.remoteIdentity, remoteBranch: branch };
            }
            op.request = Object.freeze({ action: 'create', operationId: op.id, repoPath: projectPath(status, op.project), ...startingBranch, sourceSessionId: op.sessionId, sessionMode: 'new', requireBlankSource: true, settingsHash: status.settingsHash, firstPrompt: text, ...(op.project ? { projectId: op.project.projectId, folderId: op.project.folderId } : {}) });
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
          catch (error) { op.admission = 'unknown'; throw new WorktreeError('uncertain', 'check-destination-before-resending', errorMessage(error)); }
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
      function observe(sessionId: string) {
        const binding = ctx.sessions.binding(sessionId); if (!binding || leases.has(binding)) return;
        const input = conversation.input.for(binding.ctx);
        const lease = leaseNativeSink(input, binding, { capture: (signal, controller) => capture(sessionId, binding, signal, controller), submit, settled, beforeLocal: async (ids, signal) => { if (ids.some(id => restaged.has(id))) { await waitForDraftFiles(conversation, ids, signal); ids.forEach(id => restaged.delete(id)); } }, error: error => report(t, error) });
        leases.set(binding, lease);
        const stop = binding.ctx.effect(() => async () => { try { await lease.close(); } finally { leases.delete(binding); } });
        lease.stopScope = stop;
      }
      function select(sessionId: string, mode: string) {
        if (disposed || !['local', 'new', 'worktree'].includes(mode)) return;
        const latchedNew = state.sessionId === sessionId && state.mode === 'new', keepCurrent = mode === 'worktree';
        try {
          const current = source(sessionId); if (mode === 'new') requireRepository(sessionId); observe(sessionId);
          if (keepCurrent) {
            if (projectBacking(projects.store.getSnapshot(), ctx.workspaces.list.getSnapshot(), sessionId).mode !== 'worktree') throw new WorktreeError('changed', 'current-folder-not-worktree');
            mode = 'local'; // Native sink, same checkout; never navigate to a Local source folder.
          }
          if (mode === 'local' && !keepCurrent && projects.context(sessionId)?.binding.mode === 'worktree') {
            if (!inputEmpty(current.input.state.getSnapshot())) throw new WorktreeError('draftWarning', 'keep-existing-draft');
            for (const lease of leases.values()) lease.cancelNew(); ctx.uiWorkspace.startSession(current.project!.folderId); return;
          }
          if (mode === 'local') { for (const lease of leases.values()) lease.cancelNew(); }
          const changed = state.sessionId !== sessionId || state.sourceChanged || selectedSource?.binding !== current.binding || !sameProject(selectedSource?.project, current.project);
          if (changed) { query?.abort(); ++generation; branchCache.clear(); }
          selectedSource = { sessionId, binding: current.binding, project: current.project };
          const observed = repositories.store.getSnapshot().status;
          publish({ sessionId, mode: mode === 'new' ? 'new' : 'local', sourceChanged: false, error: '', ...(changed ? { status: null, branches: null, branchSource: 'local', branch: observed?.repository.branch || '', branchOid: '', remote: '', query: '', ...(state.sessionId === sessionId ? {} : { op: null, steps: [], phase: '' }) } : {}) });
        } catch (error) { publish({ sessionId, mode: latchedNew ? 'new' : 'local', error: report(t, error) }); }
      }
      async function loadBranches(sessionId: string, refresh = false) {
        if (disposed || state.busy || state.sessionId !== sessionId || !state.status || (state.branchSource === 'remote' && !state.remote)) return;
        let current: WT.Source;
        try { current = source(sessionId); requireRepository(sessionId); requireIntent(sessionId, current); } catch (error) { publish({ error: report(t, error) }); return; }
        query?.abort(); query = new AbortController(); const controller = query, seq = ++generation, remote = state.remote, branchSource = state.branchSource, project = current.project;
        const key = branchSource === 'local' ? 'local' : 'remote:' + remote, cached = !refresh && branchCache.get(key);
        const choose = (branches: WT.Branches) => {
          const status = state.status!; // checked before loading; generation cancellation guards publication
          const preferred = branchSource === 'local' ? status.repository.branch || 'HEAD' : status.repository.branch || status.defaults?.branch;
          const branch = branches.items.some(item => item.name === state.branch) ? state.branch : advertisedDefault(branches, preferred) || '';
          publish({ branches, branch, branchOid: branches.items.find(item => item.name === branch)?.oid || '', loading: false });
        };
        if (cached) { choose(cached); return; }
        publish({ loading: true, error: '', branches: null });
        try {
          // Download one bounded generation, following its cursors. Search only
          // filters these items; it never triggers discovery or remote fetches.
          let branches: WT.Branches | undefined, cursor: string | undefined; const cursors = new Set<string>();
          do {
            const data = await requestHost(ctx, sessionId, { action: 'branches', repoPath: projectPath(state.status, project), ...(branchSource === 'local' ? { branchSource: 'local' } : { remote, remoteIdentity: state.status.remotes.find(item => item.name === remote)?.identity }), ...(cursor ? { cursor } : {}), limit: 100 }, controller.signal);
            if (disposed || controller.signal.aborted || seq !== generation) return; checkSource(sessionId, current);
            if (branches && (data.observedAt !== branches.observedAt || data.defaultBranch !== branches.defaultBranch)) throw new WorktreeError('decode', 'branch-generation-changed');
            const names = new Set(branches?.items.map(item => item.name) || []);
            branches = { ...data, items: [...(branches?.items || []), ...data.items.filter(item => !names.has(item.name))] };
            cursor = data.nextCursor;
            if (cursor && cursors.has(cursor)) throw new WorktreeError('decode', 'repeated-branch-cursor');
            if (cursor) cursors.add(cursor);
          } while (cursor);
          branchCache.set(key, branches); choose(branches);
        } catch (error) { if (!controller.signal.aborted && seq === generation) publish({ loading: false, error: report(t, error) }); }
      }
      async function configure(sessionId: string) {
        if (disposed || state.busy || state.loading) return;
        let current: WT.Source;
        try { current = source(sessionId); requireRepository(sessionId); requireIntent(sessionId, current); } catch (error) { publish({ error: report(t, error) }); return; }
        if (state.sessionId === sessionId && state.status) { await loadBranches(sessionId); return; }
        query?.abort(); query = new AbortController(); const controller = query, seq = ++generation, project = current.project;
        if (state.sessionId !== sessionId || state.mode !== 'new') selectedSource = { sessionId, binding: current.binding, project };
        publish({ sessionId, loading: true, status: null, branches: null, branchSource: 'local', branch: '', branchOid: '', remote: '', query: '', error: '', ...(state.sessionId === sessionId ? {} : { mode: 'local', sourceChanged: false, op: null, steps: [], phase: '' }) });
        try {
          const status = await repositoryStatus(sessionId, current.binding, project, controller.signal);
          if (disposed || controller.signal.aborted || seq !== generation) return; checkSource(sessionId, current);
          const remote = status.remotes.some(item => item.name === status.defaults?.remote) ? status.defaults?.remote || '' : status.remotes[0]?.name || '';
          publish({ status, remote, branch: status.repository.branch || 'HEAD', loading: false }); await loadBranches(sessionId);
        } catch (error) { if (!controller.signal.aborted && seq === generation) publish({ loading: false, error: report(t, error) }); }
      }
      async function reconcile(sessionId: string) {
        const op = state.sessionId === sessionId ? state.op : null; if (!op || state.busy) return;
        try {
          const data = await requestHost(ctx, sessionId, { action: 'status', operationId: op.id });
          if (data.worktree) projects.rememberRecords([data.worktree]);
          if (data.operation.phase === 'ready' && data.sessionId && data.worktree && string(data.operation.workspaceId) && string(data.operation.settingsHash)) { op.result = { ...data, sessionId: data.sessionId, worktree: data.worktree, workspaceId: data.operation.workspaceId, settingsHash: data.operation.settingsHash }; op.retryable = op.admission === 'none' || op.admission === 'refused'; }
          publish({ error: data.operation.error?.message || t('retained') });
        } catch (error) { publish({ error: report(t, error), ...(error instanceof WorktreeError && error.kind === 'host' && error.code === 'NOT_FOUND' ? { op: null } : {}) }); }
      }
      const repositoryChanged = repositories?.store.subscribe(() => {
        if (!state.sessionId || repositoryAllowed(state.sessionId)) return;
        query?.abort(); ++generation; branchCache.clear();
        if (state.mode === 'new') for (const lease of leases.values()) lease.cancelNew();
        // Invalidation (leaving the composer, reconnecting or a new probe) is
        // not a failed Git check. Render that observation separately; never latch
        // it into operation errors or overwrite a real setup/source failure.
        publish({ loading: false, status: null, branches: null, remote: '', branch: '', branchOid: '', query: '' });
      });
      function selectionChanged() {
        if (!selectedSource || state.sessionId !== selectedSource.sessionId || (state.mode === 'new' && state.sourceChanged)) return;
        const binding = ctx.sessions.binding(state.sessionId), project = captureProject(projects.context(state.sessionId));
        if (binding === selectedSource.binding && sameProject(project, selectedSource.project)) return;
        query?.abort(); ++generation; branchCache.clear();
        if (state.mode === 'new') for (const lease of leases.values()) lease.cancelNew();
        else selectedSource = { sessionId: state.sessionId, binding, project };
        publish({ loading: false, status: null, branches: null, query: '', remote: '', branch: '', branchOid: '', ...(state.mode === 'new' ? { sourceChanged: true, error: t('projectChanged') } : {}) });
      }
      const projectChanged = projects.store.subscribe(selectionChanged);
      const unselect = ctx.sessions.list.subscribe(() => { for (const op of operations) if (!op.committing && projectActor(ctx.sessions.list.getSnapshot()) !== op.sessionId) op.controller.abort(); selectionChanged(); });
      const reconnect = ctx.connection.generation.subscribe(() => { query?.abort(); ++generation; branchCache.clear(); for (const lease of leases.values()) lease.cancelNew(); publish({ loading: false, status: null, branches: null, branch: '', branchOid: '', query: '', remote: '' }); });
      return { store, observe, select, configure, loadBranches, reconcile,
        cancel() { for (const lease of leases.values()) lease.cancelNew(); },
        setRemote(sessionId: string, remote: string) { if (!state.busy && !state.sourceChanged && state.sessionId === sessionId && repositoryAllowed(sessionId) && state.status?.remotes.some(item => item.name === remote)) { publish({ remote, query: '', branch: '', branchOid: '', branches: null }); void loadBranches(sessionId); } },
        setBranchSource(sessionId: string, branchSource: string) { if (!state.busy && !state.sourceChanged && state.sessionId === sessionId && repositoryAllowed(sessionId) && (branchSource === 'local' || branchSource === 'remote') && (branchSource === 'local' || state.remote)) { publish({ branchSource, branch: '', branchOid: '', branches: null, query: '' }); void loadBranches(sessionId); } },
        setQuery(query: string) { if (!state.busy) publish({ query }); },
        setBranch(branch: string) { const item = state.branches?.items.find(item => item.name === branch); if (!state.busy && !state.loading && !state.sourceChanged && repositoryAllowed(state.sessionId) && item) { publish({ branch, branchOid: item.oid }); return true; } return false; },
        openTarget(sessionId: string) { const op = state.sessionId === sessionId ? state.op : null; if (op?.result?.sessionId) ctx.uiWorkspace.openSession(op.result.sessionId); },
        async dispose() { disposed = true; query?.abort(); ++generation; branchCache.clear(); repositoryChanged?.(); projectChanged(); unselect(); reconnect(); for (const op of operations) op.controller.abort(); await Promise.allSettled([...leases.values()].map(lease => lease.close())); for (const lease of leases.values()) lease.stopScope?.(); leases.clear(); selectedSource = undefined; },
      };
    }
    const projectSlotName = (key: string) => PANEL + '.projects.' + key;
    const projectSlots = ['sidebar.workspaces.directoryFlow', 'sidebar.workspaces.session.menu.item', 'sidebar.workspaces.session.row.action', 'sidebar.session.row.leading', 'sidebar.session.row.hover'];
    function projectChildren(ctx: WT.Context): WTStringMap<WT.ChildSlotSpec> {
      return Object.fromEntries(projectSlots.map((key): [string, WT.ChildSlotSpec] => [projectSlotName(key), { kind: key.endsWith('directoryFlow') ? 'single' : 'list', scope: 'root', ...(key.endsWith('menu.item') ? { inject: { hooks: { menuOpenState: (_standard: unknown, state: unknown) => () => state, shortcuts: ctx.shortcuts.catalog } } } : {}) }]));
    }
    // SlotRegistry.entriesOfSlot/subscribe/inject are PUBLIC SDK methods. The
    // native browser stays registered, and owns its original child declarations.
    // Only plugin-owned aliases are declared/mirrored; unloading never clears or
    // redeclares installed extension seats. Copy their inject/locale/store faces,
    // not DOM or private components from a Harness module import.
    function mirrorProjectSlot(ctx: WT.Context, source: string, destination = projectSlotName(source), mapKey = projectSlotName): WT.Dispose {
      return ctx.slots.inject(destination, () => ctx.slots.inject(source, () => {
        const copies = new Map<WT.SlotEntry, WT.Dispose>();
        const clear = () => { for (const dispose of copies.values()) dispose(); copies.clear(); };
        const synchronize = () => {
          const entries = ctx.slots.entriesOfSlot(source);
          for (const [entry, dispose] of copies) if (!entries.includes(entry)) { dispose(); copies.delete(entry); }
          for (const entry of entries) {
            if (copies.has(entry)) continue;
            const children = entry.children && Object.fromEntries(Object.entries(entry.children).map(([key, spec]): [string, unknown] => [mapKey(key), spec]));
            const component: WT.Component<WT.SlotProps> = children ? (props: WT.SlotProps) => h(entry.component, { ...props, renderSlot: (key: string, owner?: object, options?: object) => props.renderSlot(mapKey(key), owner, options), ...(props.renderSlotChain ? { renderSlotChain: (key: string, owner?: object, options?: object) => props.renderSlotChain!(mapKey(key), owner, options) } : {}) }) : entry.component;
            const remove = ctx.slots.register({ ...entry.options, name: destination, ...(entry.inject ? { inject: entry.inject } : {}), ...(entry.locale ? { locale: entry.locale } : {}), ...(entry.store ? { store: entry.store } : {}), ...(entry.select ? { select: entry.select } : {}), ...(children ? { children } : {}) }, component);
            const nested = Object.keys(entry.children || {}).map(key => mirrorProjectSlot(ctx, key, mapKey(key), mapKey));
            copies.set(entry, () => { for (const dispose of nested) dispose(); remove(); });
          }
        };
        synchronize(); const unsubscribe = ctx.slots.subscribe(source, synchronize);
        return () => { unsubscribe(); clear(); };
      }));
    }
    function createSidebarMode(register: () => WT.Dispose): WT.SidebarMode {
      const listeners = new Set<WT.Listener>(); let native = false, registration: WT.Dispose | null = register(), disposed = false;
      const store = { getSnapshot: () => native, subscribe: (listener: WT.Listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
      return { store, toggle() { if (disposed) return; if (native) registration = register(); else { registration?.(); registration = null; } native = !native; for (const listener of [...listeners]) listener(); }, dispose() { disposed = true; registration?.(); listeners.clear(); } };
    }
    const sidebarViewLabel = (sidebarMode: WT.SidebarMode, t: WT.Translate) => t(sidebarMode.store.getSnapshot() ? 'switchProjectsView' : 'switchWorkspaceView');
    function registerSidebarViewSwitch(ctx: WT.Context, sidebarMode: WT.SidebarMode, component: WT.Component<{ size?: number }>) {
      const t = ctx.locale.bind(NS);
      return ctx.slots.inject('sidebar', () => ctx.slots.inject('sidebar.panellist', () => {
        let removeRow = () => {};
        const synchronize = () => {
          removeRow();
          removeRow = ctx.slots.register({ name: 'sidebar.panellist', id: VIEW_SWITCH, order: 400, label: () => sidebarViewLabel(sidebarMode, t) }, component);
        };
        synchronize();
        const unsubscribe = sidebarMode.store.subscribe(synchronize);
        // Keep native declarations installed. The renderer authorizes child
        // dispatch per entry, so bridge the native component through owned aliases.
        const native = ctx.slots.entriesOfSlot('sidebar')[0];
        if (!native?.inject || !native.children) return () => { unsubscribe(); removeRow(); };
        const inject = native.inject, nativeChildren = native.children;
        const mapKey = (key: string) => VIEW_SWITCH + '.' + key;
        const children = Object.fromEntries(Object.entries(nativeChildren).map(([key, spec]): [string, unknown] => [mapKey(key), spec]));
        const componentWithActions = (props: WT.SlotProps) => h(native.component, { ...props, renderSlot: (key: string, owner?: object, options?: object) => props.renderSlot(mapKey(key), owner, options) });
        const removeSidebar = ctx.slots.register({ name: 'sidebar', priority: -50, locale: native.locale, children, inject: (...args) => {
          const props = inject(...args), selectPanel = props.selectPanel;
          if (typeof selectPanel !== 'function') throw new WorktreeError('unsupported', 'native-sidebar-select-panel');
          return { ...props, selectPanel(id: string) { if (id === VIEW_SWITCH) sidebarMode.toggle(); else selectPanel.call(props, id); } };
        } }, componentWithActions);
        const mirrors = Object.keys(nativeChildren).map(key => mirrorProjectSlot(ctx, key, mapKey(key), mapKey));
        return () => { for (const stop of mirrors) stop(); removeSidebar(); unsubscribe(); removeRow(); };
      }));
    }
    function syncProjectSpinner(element: SVGSVGElement | null) {
      if (element === null) return;
      for (const animation of element.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0;
    }
    function Icon({ size = 18 }: { size?: number }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('path', { d: 'M6 5v14M6 9h6a6 6 0 0 0 6-6M6 15h6a6 6 0 0 1 6 6' }),
        ...[[6, 3], [6, 21], [18, 3], [18, 21]].map(([cx, cy]) => h('circle', { key: cx + '-' + cy, cx, cy, r: 2 })));
    }
    const Styles = () => h('style', null, css);
    const Button = React.forwardRef<HTMLButtonElement, import('react').ButtonHTMLAttributes<HTMLButtonElement> & { 'data-active'?: boolean }>(({ children, ...props }, ref) => h('button', { type: 'button', ...props, ref }, children));
    function ProjectStateDot({ state }: { state: WT.RowState }) {
      if (state !== 'ongoing') return h('span', { className: 'dsh-wt-state-dot', 'data-state': state, 'aria-hidden': true });
      return h('svg', { ref: syncProjectSpinner, className: 'dsh-wt-state-spinner', 'data-state': 'ongoing', width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('g', { className: 'dsh-wt-state-motion' }, h('circle', { className: 'dsh-wt-state-track', cx: 12, cy: 12, r: 9.5 }), h('circle', { className: 'dsh-wt-state-arc', cx: 12, cy: 12, r: 9.5 })));
    }
    // Native workspace-folder artwork copied locally; React is the only runtime import.
    function WorkspaceFolderIcon({ expanded = false, className, size = 16 }: { expanded?: boolean; className?: string; size?: number }) {
      return h('svg', { width: size, height: size, className, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true }, expanded ? [
        h('path', { key: 'tint', d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z', fill: 'currentColor', opacity: 0.16 }),
        h('path', { key: 'front', d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z', fill: 'currentColor' }),
        h('path', { key: 'back', d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z', fill: 'currentColor' }),
      ] : [
        h('path', { key: 'outline', d: 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z', stroke: 'currentColor' }),
        h('path', { key: 'line', d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor' }),
      ]);
    }
    function SidebarToolbarIcon({ kind, size = 16 }: { kind: string; size?: number }) {
      const svg = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true };
      if (kind === 'search') return h('svg', svg, h('path', { d: 'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z', stroke: 'currentColor' }), h('path', { d: 'M10.2991 10.3933L14.7783 14.8725', stroke: 'currentColor' }));
      if (kind === 'add') return h('svg', svg, h('path', { d: 'M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z', fill: 'currentColor' }), h('path', { d: 'M9.75977 4.50208H14.5509', stroke: 'currentColor' }), h('path', { d: 'M12.1492 6.89758L12.1492 2.10642', stroke: 'currentColor' }));
      return h('svg', { ...svg, stroke: 'currentColor', strokeLinecap: 'round' }, h('path', { d: 'M2.3 5h5.85M12.05 5h1.65' }), h('circle', { cx: 9.95, cy: 5, r: 1.45 }), h('path', { d: 'M2.3 11h1.65M7.85 11h5.85' }), h('circle', { cx: 5.75, cy: 11, r: 1.45 }));
    }
    function FolderIcon({ plus = false, size = 16 }: { plus?: boolean; size?: number }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18' }), plus && h('path', { d: 'M12 11v6m-3-3h6' }));
    }
    function Dialog({ title, close, t, children, className = '', compact = false, dismissible = true, initialFocus, returnFocus, fallbackFocus, descriptionId }: WT.DialogProps) {
      const ref = React.useRef<HTMLDialogElement | null>(null), heading = React.useId();
      React.useEffect(() => {
        const dialog = ref.current; if (!dialog) return; dialog.showModal(); initialFocus?.current?.focus();
        return () => { if (dialog.open) dialog.close(); if (returnFocus?.current?.isConnected) returnFocus.current.focus(); else fallbackFocus?.current?.focus(); };
      }, []);
      return h('dialog', { ref, className: 'dsh-wt dsh-wt-dialog ' + className, 'aria-labelledby': heading, 'aria-describedby': descriptionId, onCancel: (event: import('react').SyntheticEvent<HTMLDialogElement>) => { event.preventDefault(); event.stopPropagation(); if (dismissible) close(); } },
        h(Styles), h('div', { className: 'dsh-wt-row dsh-wt-between dsh-wt-dialog-heading' }, h('h2', { id: heading }, title), h(Button, { className: compact ? 'dsh-wt-dialog-close' : undefined, onClick: close, disabled: !dismissible, autoFocus: !compact, 'aria-label': t('close') }, compact ? '×' : t('close'))), children);
    }
    function FolderRows({ folders, remove, disabled, t }: { folders: string[]; remove(path: string): void; disabled: boolean; t: WT.Translate }) {
      return h('ul', { className: 'dsh-wt-source-list', 'aria-label': t('selectedFolders') }, ...folders.map(folder => h('li', { key: folder }, h(FolderIcon),
        h('span', { className: 'dsh-wt-source-info' }, h('span', { title: folder }, projectFolderName(folder)), h('span', { className: 'dsh-wt-source-path', title: folder }, folder)),
        h(Button, { className: 'dsh-wt-source-remove', disabled, onClick: () => remove(folder), 'aria-label': t('remove') + ' ' + folder }, '×'))));
    }
    function FolderBrowser({ runtime: ctx, t, existing = [], picked, close }: { runtime: WT.Context; t: WT.Translate; existing?: string[]; picked(paths: string[]): void; close(): void }) {
      const [state, setState] = React.useState<WT.ScannerState>({ listing: null, busy: false, error: null });
      const [path, setPath] = React.useState(''), [name, setName] = React.useState(''), [selected, setSelected] = React.useState<string[]>([]), [error, setError] = React.useState(''), [creating, setCreating] = React.useState(false);
      const scanner = React.useRef<WT.Scanner | null>(null), alive = React.useRef(true), creation = React.useRef(false), selection = React.useRef<string[]>([]), pathInput = React.useRef<HTMLInputElement | null>(null);
      React.useEffect(() => {
        alive.current = true;
        const owned = createFolderScanner(ctx.uiWorkspace, patch => { setState(previous => ({ ...previous, ...patch })); if (patch.listing) setPath(patch.listing.path); }); scanner.current = owned; void owned.scan();
        return () => { alive.current = false; owned.dispose(); if (scanner.current === owned) scanner.current = null; };
      }, [ctx]);
      const { listing, busy } = state, added = new Set(existing), capacity = 32 - existing.length;
      const dismiss = () => { if (!creation.current) close(); };
      function toggle(path: string) {
        try { const next = toggleProjectFolder(selection.current, path, capacity); selection.current = next; setSelected(next); setError(''); }
        catch (failure) { setError(report(t, failure)); }
      }
      function checkbox(path: string) {
        const present = added.has(path), checked = present || selected.includes(path);
        return h('label', { className: 'dsh-wt-picker-check', title: present ? t('alreadyAdded') : t('selectFolder') + ' ' + path }, h('input', { type: 'checkbox', checked, disabled: busy || creating || present || (!checked && selected.length >= capacity), 'aria-label': t('selectFolder') + ' ' + path, onChange: () => toggle(path) }));
      }
      async function create(event: import('react').FormEvent<HTMLFormElement>) {
        event.preventDefault(); if (creation.current || busy || !listing || !name.trim()) return;
        creation.current = true; setCreating(true); setError(''); const owned = scanner.current;
        try { const created = await ctx.uiWorkspace.createDirectory(listing.path, name.trim()); if (alive.current && scanner.current === owned) { setName(''); await owned?.scan(created); } }
        catch (failure) { if (alive.current && scanner.current === owned) setError(report(t, failure)); }
        finally { creation.current = false; if (alive.current) setCreating(false); }
      }
      return h(Dialog, { title: t('sourceFolders'), close: dismiss, t, className: 'dsh-wt-project-dialog dsh-wt-folder-picker', compact: true, dismissible: !creating, initialFocus: pathInput },
        h('p', { className: 'dsh-wt-muted' }, t('multiFolderHelp')), h('p', { className: 'dsh-wt-muted' }, t('hostFolderHelp')),
        h('form', { className: 'dsh-wt-picker-path', onSubmit: event => { event.preventDefault(); if (!creating) { setError(''); void scanner.current?.scan(path); } } }, h('label', { className: 'dsh-wt-field' }, t('absolutePath'), h('input', { value: path, ref: pathInput, disabled: creating, onChange: event => setPath(event.target.value) })), h('button', { type: 'submit', disabled: busy || creating || !absolutePath(path) }, t('browse'))),
        listing && h(React.Fragment, null, h('nav', { className: 'dsh-wt-row dsh-wt-picker-crumbs', 'aria-label': t('browse') }, ...listing.crumbs.map(crumb => h(Button, { key: crumb.path, disabled: busy || creating, title: crumb.path, onClick: () => { void scanner.current?.scan(crumb.path); } }, crumb.name))),
          h('div', { className: 'dsh-wt-picker-current' }, checkbox(listing.path), h(FolderIcon), h('span', { className: 'dsh-wt-source-info' }, h('span', null, t('chooseThisFolder')), h('span', { className: 'dsh-wt-source-path', title: listing.path }, listing.path))),
          h('ul', { className: 'dsh-wt-picker-entries', 'aria-label': t('folders') }, ...listing.entries.map(entry => h('li', { key: entry.path }, checkbox(entry.path), h(FolderIcon), h(Button, { className: 'dsh-wt-picker-open', disabled: busy || creating, title: entry.path, onClick: () => { void scanner.current?.scan(entry.path); } }, entry.name), added.has(entry.path) && h('span', { className: 'dsh-wt-muted' }, t('alreadyAdded'))))),
          !listing.entries.length && !busy && h('p', { className: 'dsh-wt-muted' }, t('noSubfolders')), listing.truncated && h('p', { role: 'status', className: 'dsh-wt-muted' }, t('directoryTruncated')),
          h('details', { className: 'dsh-wt-picker-create' }, h('summary', null, t('createFolder')), h('form', { onSubmit: create }, h('label', { className: 'dsh-wt-field' }, t('folderName'), h('input', { value: name, disabled: busy || creating, onChange: event => setName(event.target.value) })), h('button', { type: 'submit', disabled: busy || creating || !name.trim() }, t('createFolder'))))),
        selected.length > 0 && h('section', { className: 'dsh-wt-picker-selected' }, h('h3', { 'aria-live': 'polite' }, t('selectedFolders') + ' · ' + selected.length), h(FolderRows, { folders: selected, remove: toggle, disabled: creating, t })),
        (busy || creating) && h('p', { role: 'status' }, t('loading')), !!(error || state.error) && h('p', { role: 'alert', className: 'dsh-wt-error' }, error || report(t, state.error)),
        h('div', { className: 'dsh-wt-project-footer' }, h(Button, { className: 'dsh-wt-cancel', disabled: creating, onClick: dismiss }, t('cancel')), h(Button, { className: 'dsh-wt-confirm', disabled: busy || creating || !selected.length, onClick: () => picked([...selection.current]) }, t('add') + (selected.length ? ' · ' + selected.length : ''))));
    }
    function ConfirmProjectRemoval({ project, busy, error, t, close, confirm, returnFocus }: { project: WT.Project; busy: boolean; error: string; t: WT.Translate; close(): void; confirm(): void; returnFocus: WT.FocusRef }) {
      const cancel = React.useRef<HTMLButtonElement | null>(null), description = React.useId();
      return h(Dialog, { title: t('removeProject'), close, t, className: 'dsh-wt-project-dialog', compact: true, dismissible: !busy, initialFocus: cancel, returnFocus, descriptionId: description },
        h('p', null, t('removeProjectConfirm'), ' ', h('strong', null, project.title)),
        h('p', { id: description, className: 'dsh-wt-muted' }, t('removeProjectHelp')),
        error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error),
        h('div', { className: 'dsh-wt-project-footer', 'aria-busy': busy }, h(Button, { ref: cancel, className: 'dsh-wt-cancel', disabled: busy, onClick: close }, t('cancel')), h(Button, { className: 'dsh-wt-danger', disabled: busy, onClick: confirm }, t(busy ? 'loading' : 'removeProject'))));
    }
    function ProjectEditor({ project, runtime: ctx, projects, t, close, returnFocus, fallbackFocus }: WT.EditorProps) {
      const [title, setTitle] = React.useState(project?.title || ''), [folders, setFolders] = React.useState(project?.folders.map(folder => folder.path) || []), [path, setPath] = React.useState(''), [mainFolder, setMainFolder] = React.useState(projectMainFolder(project)?.path || '');
      const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [browser, setBrowser] = React.useState(false), [confirmRemoval, setConfirmRemoval] = React.useState(false);
      // Optimistic first paint: path entry works everywhere, so the two optional
      // entries appear only once the session confirms it can serve them.
      const [picker] = React.useState(() => nativeFolderPicker(ctx));
      const [capabilities, setCapabilities] = React.useState({ modes: ['path'], ready: false });
      const [addMode, setAddMode] = React.useState(() => matchingAddMode('path', ['path']));
      const lifetime = React.useRef(true), currentFolders = React.useRef(folders), picking = React.useRef(false), browsing = React.useRef(false), confirming = React.useRef(false), submitter = React.useRef<WT.ProjectSubmitter | null>(null), heading = React.useId(), nameInput = React.useRef<HTMLInputElement | null>(null), removeTrigger = React.useRef<HTMLButtonElement | null>(null);
      if (!submitter.current) submitter.current = createProjectSubmitter(projects, project?.id, project?.id || crypto.randomUUID());
      React.useEffect(() => { lifetime.current = true; return () => { lifetime.current = false; }; }, []);
      React.useEffect(() => {
        let live = true;
        browseSupported(ctx.uiWorkspace).then(browse => { if (live) setCapabilities({ modes: addModesFor({ picker, browse }), ready: true }); });
        return () => { live = false; };
      }, [ctx, picker]);
      // Path entry is the only entry safe before the probe answers, so the probe
      // promotes its own placeholder to this session's picker — but never over a
      // choice the user already made.
      React.useEffect(() => {
        setAddMode(mode => {
          if (capabilities.ready && mode === 'path') return preferredAddMode(capabilities.modes);
          return matchingAddMode(mode, capabilities.modes);
        });
      }, [capabilities]);
      const dismiss = () => { if (!submitter.current!.pending && !picking.current && !confirming.current) close(); };
      const primary = draftMainFolder(folders, mainFolder);
      function closeBrowser() { browsing.current = false; setBrowser(false); }
      function add(paths: string[]) {
        if (!lifetime.current || submitter.current!.pending || confirming.current) return;
        try { const next = appendProjectFolders(currentFolders.current, paths); currentFolders.current = next; setFolders(next); setPath(''); closeBrowser(); setError(''); }
        catch (failure) { setError(report(t, failure)); }
      }
      function remove(path: string) { if (submitter.current!.pending || picking.current || browsing.current || confirming.current) return; currentFolders.current = currentFolders.current.filter(value => value !== path); setFolders(currentFolders.current); if (mainFolder === path) setMainFolder(''); setError(''); }
      async function choose() {
        if (submitter.current!.pending || picking.current || browsing.current || confirming.current || currentFolders.current.length >= 32) return;
        setError('');
        // `void choose()` discards the returned promise, so every refusal a user can
        // trigger has to surface here; a synchronous throw must not vanish.
        try {
          if (addMode === 'path') { add([path.trim()]); return; }
          if (addMode === 'browse') {
            if (!capabilities.modes.includes('browse')) throw new WorktreeError('browseUnavailable', 'no-browse-capability');
            browsing.current = true; setBrowser(true); return;
          }
          if (typeof picker !== 'function') throw new WorktreeError('folderPickerUnavailable', 'no-directory-picker');
          // The native chooser returns one folder or null, never a batch.
          picking.current = true; setBusy(true);
          try { const selected = await picker(); if (lifetime.current && selected) add([selected]); }
          finally { picking.current = false; if (lifetime.current) setBusy(false); }
        }
        catch (failure) { if (lifetime.current) setError(report(t, failure)); }
      }
      async function save(event: import('react').FormEvent<HTMLFormElement>) {
        event.preventDefault(); if (submitter.current!.pending || picking.current || browsing.current || confirming.current || !title.trim() || !currentFolders.current.length) return;
        if (!draftMainFolder(currentFolders.current, mainFolder)) { setError(t('mainFolderRequired')); return; }
        setBusy(true); setError('');
        try { await submitter.current!.submit(title, currentFolders.current, mainFolder); if (lifetime.current) close(); }
        catch (failure) { if (lifetime.current) setError(report(t, failure)); }
        finally { if (lifetime.current) setBusy(false); }
      }
      function beginRemoval() {
        if (!project || submitter.current!.pending || picking.current || browsing.current || confirming.current) return;
        confirming.current = true; setError(''); setConfirmRemoval(true);
      }
      function dismissRemoval() { if (!submitter.current!.pending) { confirming.current = false; setConfirmRemoval(false); setError(''); } }
      async function removeProject() {
        if (!confirming.current || submitter.current!.pending || picking.current || browsing.current) return;
        setBusy(true); setError('');
        try { await submitter.current!.remove(); if (lifetime.current) close(); }
        catch (failure) { if (lifetime.current) setError(report(t, failure)); }
        finally { if (lifetime.current) setBusy(false); }
      }
      return h(Dialog, { title: t(project ? 'editProject' : 'createProject'), close: dismiss, t, className: 'dsh-wt-project-dialog', compact: true, dismissible: !busy, initialFocus: nameInput, returnFocus, fallbackFocus },
        h('form', { onSubmit: save, 'aria-busy': busy }, h('label', { className: 'dsh-wt-project-name' }, h(FolderIcon), h('input', { required: true, ref: nameInput, maxLength: 120, placeholder: t('projectName'), 'aria-label': t('projectName'), value: title, disabled: busy, onChange: event => setTitle(event.target.value) })),
          h('div', { className: 'dsh-wt-source-heading' }, h('span', { id: heading }, t('sourceFolders')), folders.length > 0 && h('span', { className: 'dsh-wt-source-count', 'aria-live': 'polite' }, folders.length + ' / 32')),
          h('section', { className: 'dsh-wt-source-card', 'aria-labelledby': heading, 'data-filled': !!folders.length }, folders.length > 0 && h(FolderRows, { folders, remove, disabled: busy, t }),
            h('div', { className: 'dsh-wt-source-add' }, h('select', { className: 'dsh-wt-source-select', 'aria-label': t('addFolder'), value: addMode, disabled: !capabilities.ready || busy || folders.length >= 32, onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => { setAddMode(event.target.value); setError(''); } }, capabilities.modes.includes('browse') && h('option', { value: 'browse' }, t('localFolders')), capabilities.modes.includes('native') && h('option', { value: 'native' }, t('chooseDirectory')), capabilities.modes.includes('path') && h('option', { value: 'path' }, t('enterFolderPath'))),
              !capabilities.ready && h('p', { role: 'status', className: 'dsh-wt-muted' }, t('checkingFolderOptions')),
              addMode === 'path' && h('label', { className: 'dsh-wt-project-path' }, h('input', { value: path, autoFocus: true, placeholder: t('absolutePath'), 'aria-label': t('absolutePath'), disabled: busy || folders.length >= 32, onChange: event => setPath(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); void choose(); } } })),
              h(Button, { className: 'dsh-wt-add-pill', disabled: busy || folders.length >= 32 || (addMode === 'path' && !absolutePath(path.trim())), onClick: () => { void choose(); } }, h(FolderIcon, { plus: true }), t('add')))),
          folders.length > 1 && h('label', { className: 'dsh-wt-main-folder' }, t('mainFolder'), h('select', { required: true, value: primary, disabled: busy, title: primary, onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => { setMainFolder(event.target.value); setError(''); } }, h('option', { value: '', disabled: true }, t('chooseMainFolder')), ...folders.map(folder => h('option', { key: folder, value: folder }, projectFolderName(folder) + ' · ' + folder))), h('small', null, t('mainFolderHelp'))),
          error && !confirmRemoval && h('p', { role: 'alert', className: 'dsh-wt-error' }, error), h('div', { className: 'dsh-wt-project-footer' }, project && h(Button, { ref: removeTrigger, className: 'dsh-wt-remove-project', disabled: busy || browser || confirmRemoval, onClick: beginRemoval }, t('removeProject')), h(Button, { className: 'dsh-wt-cancel', disabled: busy, onClick: dismiss }, t('cancel')), h('button', { className: 'dsh-wt-confirm', type: 'submit', disabled: busy || !title.trim() || !folders.length || !primary }, t(busy ? 'loading' : project ? 'save' : 'createProject')))),
        browser && h(FolderBrowser, { runtime: ctx, t, existing: folders, picked: add, close: closeBrowser }),
        confirmRemoval && project && h(ConfirmProjectRemoval, { project, busy, error, t, close: dismissRemoval, confirm: removeProject, returnFocus: removeTrigger }));
    }
    function ThreadRow({ row, selected, runtime: ctx, metadata, renderSlot, t, now }: WT.ThreadProps) {
      const [menu, setMenu] = React.useState(false), [hover, setHover] = React.useState(false);
      const activity = row.session.blank ? null : projectSessionTime(row.session.updatedAt, now, t);
      const worktree = (row.backing?.mode || row.context?.binding.mode) === 'worktree';
      const record = worktree ? row.backing?.record || metadata.records.find(item => item.id === row.context?.binding.worktreeId) : undefined;
      const path = row.backing?.effectiveCwd || row.context?.binding.effectiveCwd || row.context?.folder.path || '';
      const title = row.session.blank ? t('blankThread') : row.title || t('untitled');
      const marker = (worktree ? t('worktreeThread') : t('localThread')) + (row.context ? ' · ' + row.context.folder.path : '') + (record?.branch ? ' · ' + record.branch : '') + (record?.cleanup ? ' · ' + recoveryLabel(record.cleanup, t) : '') + (worktree ? ' · ' + path : '');
      const state = projectRowState(row), status = row.pending ? t('waiting') : row.running ? t('busy') : row.done ? t('done') : t('idle');
      const owner = { sessionId: row.id, displayTitle: row.title };
      return h('div', { className: 'dsh-wt-thread' + (row.archived ? ' dsh-wt-thread-archived' : ''), role: 'treeitem', 'aria-selected': selected, 'data-menu-open': menu, 'aria-description': row.archived ? t('archived') : undefined },
        h('div', { className: 'dsh-wt-thread-main' }, h(Button, { disabled: row.archived, title: title + ' · ' + status + (worktree ? ' · ' + marker : ''), onClick: () => ctx.uiWorkspace.openSession(row.id) },
          h('span', { className: 'dsh-wt-thread-leading', role: state !== 'idle' ? 'img' : undefined, 'aria-label': state !== 'idle' ? status : undefined }, !row.archived && !row.session.blank && (state !== 'idle' ? h(ProjectStateDot, { state }) : renderSlot(projectSlotName('sidebar.session.row.leading'), { sessionId: row.id }))),
          h('span', { className: 'dsh-wt-thread-title' }, title)),
          row.pinned && h('span', { className: 'dsh-wt-muted dsh-wt-thread-pin', title: t('pinned'), 'aria-label': t('pinned') }, '⌖'),
          worktree && h('span', { className: 'dsh-wt-branch-chip', title: marker, 'aria-label': marker, role: 'img' }, h(Icon, { size: 13 })),
          activity && h('time', { className: 'dsh-wt-thread-time', dateTime: activity.dateTime, title: activity.title, 'aria-label': activity.title }, activity.label),
          !row.session.blank && h('span', { className: 'dsh-wt-thread-actions' }, h(Button, { 'aria-label': t('threadActions') + ' ' + title, onClick: () => setMenu(true) }, '…'), renderSlot(projectSlotName('sidebar.workspaces.session.row.action'), owner), h(Button, { 'aria-label': t('threadDetails'), onClick: () => setHover(value => !value), 'aria-expanded': hover }, 'ⓘ'))),
        hover && h('div', { className: 'dsh-wt-thread-hover' }, h('div', null, title), h('div', { className: 'dsh-wt-muted' }, status), worktree && record?.branch && h('div', null, h('code', null, record.branch)), h('code', null, path), record?.cleanup && h('div', null, recoveryLabel(record.cleanup, t), record.cleanup.reason && h('p', { className: 'dsh-wt-muted' }, record.cleanup.reason.code + ': ' + record.cleanup.reason.message)), renderSlot(projectSlotName('sidebar.session.row.hover'), { sessionId: row.id })),
        menu && h(Dialog, { title: t('threadActions'), t, close: () => setMenu(false) }, h('div', { role: 'menu', className: 'dsh-wt-project-menu', onKeyDown: event => { if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)')]; if (!items.length) return; event.preventDefault(); const at = items.indexOf(event.target as HTMLElement); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); } }, renderSlot(projectSlotName('sidebar.workspaces.session.menu.item'), owner, { hookContext: [menu, setMenu] }))));
    }
    function ProjectGroup({ group, selectedId, runtime, metadata, renderSlot, t, searching, onManage, now }: WT.GroupProps) {
      const [collapsed, setCollapsed] = React.useState(false), [limit, setLimit] = React.useState(5), [choosingFolder, setChoosingFolder] = React.useState(false);
      const rows = searching ? group.rows : visibleProjectRows(group.rows, limit, selectedId), main = projectMainFolder(group.project), remaining = group.rows.length - rows.length;
      const hasOverflow = group.rows.length > visibleProjectRows(group.rows, 5, selectedId).length;
      function start(folderId: string) { setChoosingFolder(false); runtime.uiWorkspace.startSession(folderId); }
      return h('section', { className: 'dsh-wt-project-group' }, h('div', { className: 'dsh-wt-project-head' }, h(Button, { title: group.project?.folders.map(folder => folder.path).join('\n'), 'aria-expanded': searching || !collapsed, onClick: () => { setCollapsed(value => !value); setLimit(5); }, 'aria-label': t(collapsed ? 'expand' : 'collapse') + ' ' + (group.project?.title || t('unassigned')) },
        h('span', { className: 'dsh-wt-project-glyph', 'aria-hidden': true }, h(WorkspaceFolderIcon, { expanded: searching || !collapsed, className: 'dsh-wt-project-folder' }), h('span', { className: 'dsh-wt-project-chevron' }, collapsed && !searching ? '▸' : '▾')), h('span', { className: 'dsh-wt-project-title' }, group.project?.title || t('unassigned'))),
        group.project && h('span', { className: 'dsh-wt-project-head-actions' }, h(Button, { 'aria-label': t('newThread') + ' ' + group.project.title, title: t('newThread') + (main ? ' · ' + main.path : ''), disabled: !main, onClick: () => main && start(main.id) }, '+'), group.project.folders.length > 1 && h(Button, { 'aria-label': t('chooseFolder') + ' ' + group.project.title, title: t('chooseFolder'), 'aria-expanded': choosingFolder, onClick: () => setChoosingFolder(value => !value) }, '▾'), h(Button, { 'aria-label': t('editProject') + ' ' + group.project.title, title: t('editProject'), onClick: event => onManage(group.project, event.currentTarget) }, '…'))),
        choosingFolder && group.project && h('div', { className: 'dsh-wt-row', 'aria-label': t('chooseFolder') }, ...group.project.folders.map(folder => h(Button, { key: folder.id, title: folder.path, onClick: () => start(folder.id) }, folder.title + (folder.id === main?.id ? ' · ' + t('main') : '')))),
        (searching || !collapsed) && h('div', { role: 'group' }, ...rows.map(row => h(ThreadRow, { key: row.id, row, selected: row.id === selectedId, runtime, metadata, renderSlot, t, now })),
          !searching && hasOverflow && h(Button, { className: 'dsh-wt-session-overflow', 'aria-expanded': remaining === 0, onClick: () => setLimit(value => remaining === 0 ? 5 : remaining <= 5 ? Infinity : value + 5) }, remaining ? t('showMore', { n: remaining }) : t('showLess'))));
    }
    function SidebarToggle({ size }: { size?: number }) {
      return h(WorkspaceFolderIcon, { size });
    }
    function ProjectSidebarToolbar({ query, onQuery, archived, onArchived, onCreate, newProjectTrigger, t }: WT.ToolbarProps) {
      const [searchOpen, setSearchOpen] = React.useState(!!query), [optionsOpen, setOptionsOpen] = React.useState(false);
      const input = React.useRef<HTMLInputElement | null>(null), searchTrigger = React.useRef<HTMLButtonElement | null>(null), optionsTrigger = React.useRef<HTMLButtonElement | null>(null), searchId = React.useId(), menuId = React.useId();
      React.useEffect(() => { if (searchOpen) input.current?.focus(); }, [searchOpen]);
      function closeSearch() { onQuery(''); setSearchOpen(false); searchTrigger.current?.focus(); }
      function closeOptions() { setOptionsOpen(false); optionsTrigger.current?.focus(); }
      function menuKey(event: import('react').KeyboardEvent<HTMLDivElement>) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeOptions(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=menuitemradio]')], index = items.indexOf(event.target as HTMLElement); if (!items.length) return;
        event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
      return h('div', { className: 'dsh-wt-projects-header dsh-wt-project-toolbar' },
        !searchOpen && h('span', { className: 'dsh-wt-project-section-label' }, t('projects')),
        searchOpen && h('div', { className: 'dsh-wt-project-search' }, h('input', { id: searchId, ref: input, type: 'search', maxLength: 256, className: 'dsh-wt-project-search-input', value: query, placeholder: t('filterThreads'), 'aria-label': t('filterThreads'), onChange: event => onQuery(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); } } }), h(Button, { className: 'dsh-wt-toolbar-icon', 'aria-label': t('closeSearch'), title: t('closeSearch'), onClick: closeSearch }, '×')),
        h(Button, { ref: searchTrigger, className: 'dsh-wt-toolbar-icon', 'aria-label': t('searchProjects'), title: t('searchProjects'), 'aria-expanded': searchOpen, 'aria-controls': searchOpen ? searchId : undefined, onClick: () => { setOptionsOpen(false); if (searchOpen) closeSearch(); else setSearchOpen(true); } }, h(SidebarToolbarIcon, { kind: 'search', size: 14 })),
        h('div', { className: 'dsh-wt-view-options', onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setOptionsOpen(false); } },
          h(Button, { ref: optionsTrigger, className: 'dsh-wt-toolbar-icon', 'aria-label': t('viewOptions'), title: t('viewOptions'), 'aria-haspopup': 'menu', 'aria-expanded': optionsOpen, 'aria-controls': optionsOpen ? menuId : undefined, 'data-active': archived !== 'hide', onClick: () => setOptionsOpen(value => !value), onKeyDown: event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOptionsOpen(true); } else if (event.key === 'Escape') { event.preventDefault(); closeOptions(); } } }, h(SidebarToolbarIcon, { kind: 'options' })),
          optionsOpen && h('div', { id: menuId, role: 'menu', 'aria-label': t('viewOptions'), className: 'dsh-wt-view-menu', onKeyDown: menuKey }, ...[['hide', 'hideArchived'], ['all', 'allThreads'], ['only', 'archivedOnly']].map(([value, label]) => h(Button, { key: value, role: 'menuitemradio', 'aria-checked': archived === value, autoFocus: archived === value, onClick: () => { onArchived(value!); closeOptions(); } }, h('span', { 'aria-hidden': true, className: 'dsh-wt-view-check' }, archived === value ? '✓' : ''), t(label!))))),
        h(Button, { ref: newProjectTrigger, className: 'dsh-wt-toolbar-icon', 'aria-label': t('newProject'), title: t('newProject'), onClick: event => { setOptionsOpen(false); onCreate(event); } }, h(SidebarToolbarIcon, { kind: 'add' })));
    }
    function ProjectsSidebar({ runtime: ctx, projects, t, wide, expandSidebar, useWorkspaces, useSessions, usePanelInfo, useSessionStatus, renderSlot }: WT.SidebarProps) {
      const workspaces = useWorkspaces(value => value), sessions = useSessions(value => value), panel = usePanelInfo(value => value.activePanelId), statuses = useSessionStatus(value => value);
      const metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot);
      const [query, setQuery] = React.useState(''), [archived, setArchived] = React.useState('hide'), [editor, setEditor] = React.useState<{ project: WT.Project | null } | null>(null);
      const editorTrigger = React.useRef<HTMLElement | null>(null), newProjectTrigger = React.useRef<HTMLButtonElement | null>(null);
      const selectedId = panel ? undefined : Object.keys(sessions.byId).find(id => (sessions.byId[id]?.retainedBy?.mainView || 0) > 0);
      const groups = projectRows(metadata, workspaces, sessions, statuses, { query, archived, selectedId }), now = Date.now();
      // Own the editor snapshot here: refresh/removal of a row must not discard refused edits.
      function openEditor(project: WT.Project | null, trigger: HTMLElement) { editorTrigger.current = trigger; setEditor({ project }); }
      if (!wide) return h('div', { className: 'dsh-wt dsh-wt-projects' }, h(Styles), h(Button, { title: t('projects'), 'aria-label': t('projects'), onClick: expandSidebar }, h(WorkspaceFolderIcon)));
      return h('section', { className: 'dsh-wt dsh-wt-projects', 'aria-label': t('projects') }, h(Styles),
        h(ProjectSidebarToolbar, { query, onQuery: setQuery, archived, onArchived: setArchived, newProjectTrigger, onCreate: event => openEditor(null, event.currentTarget), t }),
        metadata.loading && h('span', { role: 'status', className: 'dsh-wt-muted' }, t('loading')), metadata.error && h('div', null, h('p', { role: 'alert', className: 'dsh-wt-error' }, metadata.error), h(Button, { onClick: () => { void projects.refresh(); } }, t('refresh'))),
        h('div', { className: 'dsh-wt-project-list', role: 'tree', 'aria-label': t('projects') }, ...groups.map(group => h(ProjectGroup, { key: group.project?.id || 'unassigned', group, selectedId, runtime: ctx, metadata, renderSlot, t, searching: !!query.trim(), onManage: openEditor, now }))),
        !metadata.projects.length && !metadata.loading && h('p', { className: 'dsh-wt-muted' }, t('noProjects')), editor && h(ProjectEditor, { key: editor.project?.id || 'new-project', project: editor.project, projects, runtime: ctx, t, close: () => setEditor(null), returnFocus: editorTrigger, fallbackFocus: newProjectTrigger }));
    }
    function ChevronIcon() { return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true }, h('path', { d: 'm4 6 4 4 4-4' })); }
    function menuKeys(event: import('react').KeyboardEvent<HTMLDivElement>) {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^=menuitem]:not(:disabled)')]; if (!items.length) return;
      event.preventDefault(); const at = items.indexOf(event.target as HTMLElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
    function ChoicePicker({ label, value, items, disabled, onChange, icon }: { label: string; value: string; items: { value: string; label: string; title?: string; disabled?: boolean }[]; disabled?: boolean; onChange(value: string): void; icon?: WT.Node }) {
      const [open, setOpen] = React.useState(false), root = React.useRef<HTMLDivElement | null>(null), trigger = React.useRef<HTMLButtonElement | null>(null), id = React.useId();
      React.useEffect(() => { if (!open) return; const menu = root.current?.querySelector<HTMLElement>('[role=menu]'); (menu?.querySelector<HTMLElement>('[aria-checked=true]:not(:disabled)') || menu?.querySelector<HTMLElement>('[role=menuitemradio]:not(:disabled)'))?.focus(); }, [open]);
      const dismiss = () => { setOpen(false); trigger.current?.focus(); }, current = items.find(item => item.value === value), selectable = items.some(item => !item.disabled && item.value !== value);
      return h('div', { ref: root, className: 'dsh-wt-choice', onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }, onKeyDown: event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); dismiss(); } } },
        h(Button, { ref: trigger, className: 'dsh-wt-control', disabled, 'aria-label': label, 'aria-haspopup': selectable ? 'menu' : undefined, 'aria-expanded': selectable ? open : undefined, 'aria-controls': open ? id : undefined, title: current?.title, onClick: () => selectable ? setOpen(!open) : onChange(value) }, icon, h('span', { className: 'dsh-wt-control-text' }, current?.label || label), selectable && h(ChevronIcon)),
        open && h('div', { id, role: 'menu', 'aria-label': label, className: 'dsh-wt-choice-menu', onKeyDown: menuKeys }, ...items.map(item => h(Button, { key: item.value, role: 'menuitemradio', 'aria-checked': value === item.value, disabled: item.disabled, className: 'dsh-wt-choice-item', title: item.title, onClick: () => { onChange(item.value); dismiss(); } }, h('span', { className: 'dsh-wt-choice-check', 'aria-hidden': true }, value === item.value ? '✓' : ''), item.label))));
    }
    function BranchPicker({ state, sessionId, flow, disabled, t, currentBranch }: { state: WT.FlowState; sessionId: string; flow: WT.Flow; disabled: boolean; t: WT.Translate; currentBranch: string }) {
      const [open, setOpen] = React.useState(false), root = React.useRef<HTMLDivElement | null>(null), trigger = React.useRef<HTMLButtonElement | null>(null), search = React.useRef<HTMLInputElement | null>(null), id = React.useId();
      const selected = state.sessionId === sessionId, local = !selected || state.branchSource === 'local', branch = selected ? state.branch || (local ? currentBranch : '') : currentBranch;
      const label = branch ? (local ? branch : state.remote + '/' + branch) : t('select');
      const dismiss = () => { setOpen(false); trigger.current?.focus(); };
      const matches = (selected && state.branches?.items || []).filter(item => item.name.toLocaleLowerCase().includes((state.query || '').toLocaleLowerCase()));
      React.useEffect(() => { if (open) search.current?.focus(); }, [open]);
      function refreshBranches() {
        if (disabled || state.loading || !selected || !state.status) return;
        // Keep focus on a stable enabled child before Refresh becomes disabled.
        // Otherwise Chromium can emit blur(null), which is not an outside action.
        search.current?.focus(); void flow.loadBranches(sessionId, true);
      }
      return h('div', { ref: root, className: 'dsh-wt-choice', onBlur: event => { if (event.currentTarget.contains(event.relatedTarget)) return; if (!event.relatedTarget && !disabled && flow.store.getSnapshot().loading) { search.current?.focus(); return; } setOpen(false); }, onKeyDown: event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); dismiss(); } } },
        h(Button, { ref: trigger, className: 'dsh-wt-control', disabled, 'aria-expanded': open, 'aria-haspopup': 'dialog', 'aria-controls': open ? id : undefined, 'aria-label': t('branch') + ': ' + label, title: t(local ? 'localBranchHelp' : 'remoteBranchHelp'), onClick: () => { setOpen(!open); if (!open) void flow.configure(sessionId); } }, h(Icon, { size: 14 }), h('span', { className: 'dsh-wt-control-text' }, label), h(ChevronIcon)),
        open && h('div', { id, role: 'dialog', 'aria-label': t('branch'), className: 'dsh-wt-base-options' },
          h('div', { className: 'dsh-wt-row dsh-wt-between' }, h('span', { className: 'dsh-wt-branch-heading' }, t('branch')), h(Button, { className: 'dsh-wt-control', disabled: disabled || state.loading || !selected || !state.status, onClick: refreshBranches }, t('refresh'))),
          h('div', { role: 'radiogroup', 'aria-label': t('branchSource'), className: 'dsh-wt-branch-sources' }, ...['local', 'remote'].map(source => h(Button, { key: source, role: 'radio', 'aria-checked': local === (source === 'local'), disabled: disabled || !state.status || (source === 'remote' && !state.status.remotes.length), onClick: () => flow.setBranchSource(sessionId, source) }, t(source === 'local' ? 'localBranches' : 'remoteBranches')))),
          !local && state.status && state.status.remotes.length > 1 && h(ChoicePicker, { label: t('remote'), value: state.remote, disabled, items: state.status.remotes.map(item => ({ value: item.name, label: item.name })), onChange: remote => flow.setRemote(sessionId, remote) }),
          h('label', { className: 'dsh-wt-branch-search' }, h(SidebarToolbarIcon, { kind: 'search', size: 14 }), h('input', { ref: search, type: 'search', placeholder: t('search'), 'aria-label': t('search'), value: selected ? state.query : '', disabled, onChange: event => flow.setQuery(event.target.value), onKeyDown: event => { if (event.key === 'ArrowDown') { event.preventDefault(); root.current?.querySelector<HTMLElement>('[role=menuitemradio]:not(:disabled)')?.focus(); } } })),
          h('div', { role: 'menu', 'aria-label': t(local ? 'localBranches' : 'remoteBranches'), className: 'dsh-wt-branch-list', 'aria-busy': state.loading, onKeyDown: menuKeys }, state.loading ? h('div', { role: 'status', className: 'dsh-wt-branch-help' }, t('loading')) : matches.length ? matches.map(item => h(Button, { key: item.name, role: 'menuitemradio', 'aria-checked': branch === item.name, disabled, className: 'dsh-wt-branch-item', title: item.name, onClick: () => { if (flow.setBranch(item.name)) dismiss(); } }, h('span', { className: 'dsh-wt-choice-check', 'aria-hidden': true }, branch === item.name ? '✓' : ''), h('span', { className: 'dsh-wt-branch-name' }, item.name === 'HEAD' && local ? t('detached') + ' · HEAD' : item.name), local && item.name === (state.status?.repository.branch || 'HEAD') && h('span', { className: 'dsh-wt-branch-badge' }, t('currentBranch')))) : h('div', { className: 'dsh-wt-branch-help', role: 'status' }, t('noBranches'))),
          h('div', { className: 'dsh-wt-branch-help' }, t(local ? 'localBranchHelp' : 'remoteBranchHelp'))));
    }
    function NewWorktreeControls({ sessionId, flow, projects, repositories, recovery, runtime: ctx, t, useSession, useInput, usePanelInfo, useWorkspaces }: WT.SessionProps) {
      const snapshot = useSession(value => value), empty = useInput(inputEmpty), ready = sourceEligible(snapshot), panel = usePanelInfo(value => value.activePanelId), workspaces = useWorkspaces(value => value);
      const recoverySource = recovery?.store || emptyRecoveryStore, recoveryState = React.useSyncExternalStore(recoverySource.subscribe, recoverySource.getSnapshot), verified = recoveryVerified(recoveryState, sessionId);
      const state = React.useSyncExternalStore(flow.store.subscribe, flow.store.getSnapshot);
      const repository = React.useSyncExternalStore(repositories.store.subscribe, repositories.store.getSnapshot);
      const metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot), context = projects.context(sessionId);
      const [folderError, setFolderError] = React.useState('');
      React.useEffect(() => { if (!verified || panel || !snapshot.blank || snapshot.subagent !== null) return; try { flow.observe(sessionId); } catch { /* New mode reports the guarded ABI refusal. */ } void repositories.ensure(sessionId); return () => repositories.withdraw(sessionId); }, [flow, repositories, sessionId, ready, verified, panel, snapshot.blank, snapshot.subagent, snapshot.openState, snapshot.removed, context?.project.id, context?.folder.id, context?.folder.path]);
      if (!verified || panel || !snapshot.blank || snapshot.subagent !== null) return null;
      const backing = projectBacking(metadata, workspaces, sessionId), worktree = backing.mode === 'worktree', record = backing.record;
      const selected = state.sessionId === sessionId, busy = selected && state.busy, main = projectMainFolder(context?.project), canWorktree = repositories.enabled(sessionId), blockedNew = selected && state.mode === 'new' && (!canWorktree || state.sourceChanged);
      const observingNew = blockedNew && !state.sourceChanged && repository.target?.sessionId === sessionId;
      const repositoryWarning = observingNew && repository.phase === 'unavailable' && !state.error;
      return h('div', { className: 'dsh-wt dsh-wt-row dsh-wt-create-controls' }, h(Styles),
        context && context.project.folders.length > 1 && h('select', { className: 'dsh-wt-conversation-folder', 'aria-label': t('conversationFolder'), value: context.folder.id, disabled: busy || !empty || !sourceEligible(snapshot), title: !empty ? t('draftWarning') : context.folder.path,
          onChange: (event: import('react').ChangeEvent<HTMLSelectElement>) => { setFolderError(''); try { chooseConversationFolder(ctx, projects, flow, sessionId, event.target.value); } catch (failure) { setFolderError(report(t, failure)); } } }, ...context.project.folders.map(folder => h('option', { key: folder.id, value: folder.id, title: folder.path }, folder.title + (folder.id === main?.id ? ' · ' + t('main') : '')))),
        folderError && h('span', { className: 'dsh-wt-create-error', role: 'alert' }, folderError),
        h(ChoicePicker, { key: sessionId + ':' + (blockedNew ? 'blocked' : canWorktree ? 'git' : 'local'), label: t('threadMode'), value: selected && state.mode === 'new' ? 'new' : worktree ? 'worktree' : 'local', disabled: busy || !sourceEligible(snapshot), icon: h(FolderIcon, { size: 14 }), items: [
          { value: 'local', label: t('local'), disabled: worktree && !context?.folder },
          ...(worktree ? [{ value: 'worktree', label: t('worktreeThread') }] : []),
          ...(blockedNew || canWorktree ? [{ value: 'new', label: t('new'), disabled: blockedNew }] : []),
        ], onChange: mode => flow.select(sessionId, mode) }),
        worktree && h('span', { className: 'dsh-wt-muted', title: backing.effectiveCwd }, record?.branch || t('worktreeThread')),
        !blockedNew && canWorktree && !worktree && h(BranchPicker, { key: sessionId + ':' + (context?.folder.id || ''), state, sessionId, flow, disabled: busy || !sourceEligible(snapshot), t, currentBranch: repositories.store.getSnapshot().status?.repository.branch || 'HEAD' }),
        observingNew && repository.phase === 'checking' && h('span', { className: 'dsh-wt-muted', role: 'status' }, t('checkingRepository')),
        repositoryWarning && h('span', { className: 'dsh-wt-create-error', role: 'alert' }, t('repoUnavailable')),
        selected && state.error && h('span', { className: 'dsh-wt-create-error', role: 'alert' }, state.error,
          state.op && h(React.Fragment, null, ' · ', h('code', null, state.op.id), h(Button, { disabled: state.loading, onClick: () => { void flow.reconcile(sessionId); } }, t('reconcile')), state.op.result?.sessionId && h(Button, { onClick: () => flow.openTarget(sessionId) }, t('open')))));
    }
    function SetupProgress({ sessionId, flow, t }: { sessionId: string; flow: WT.Flow; t: WT.Translate }) {
      const state = React.useSyncExternalStore(flow.store.subscribe, flow.store.getSnapshot);
      // Configuration and availability warnings belong in the controls. Setup
      // steps exist only after a native Send has actually begun preparation.
      if (state.sessionId !== sessionId || (!state.busy && !state.phase && !state.steps.length)) return null;
      const labels: { [key: string]: string } = { preparing: 'preparingMessage', fetching: 'fetchingLatest', creating: 'creatingWorktree', naming: 'namingBranch', opening: 'openingConversation', ready: 'setupReady', attachments: 'stagingAttachments', sending: 'startingConversation', complete: 'setupReady', failed: 'setupFailed' };
      const active = state.phase, failed = active === 'failed' ? state.failedAt : undefined;
      const completed = new Set<string>(state.steps.filter(step => step.stage !== failed).map(step => step.stage));
      return h('section', { className: 'dsh-wt dsh-wt-progress', 'aria-label': t('setupProgress'), 'aria-busy': state.busy }, h(Styles),
        h('div', { className: 'dsh-wt-row dsh-wt-between' }, h('strong', { role: 'status', 'aria-live': 'polite' }, t(labels[active] || 'setupProgress')), state.busy && h(Button, { onClick: flow.cancel }, t('cancelSetup'))),
        h('ol', null, ...((state.op?.intent.branchSource || state.branchSource) === 'local' ? ['creating', 'naming'] : ['fetching', 'creating', 'naming']).map(stage => h('li', { key: stage, 'data-active': active === stage, 'aria-current': active === stage ? 'step' : undefined }, h('span', { 'aria-hidden': true }, failed === stage ? '× ' : completed.has(stage) && active !== stage ? '✓ ' : active === stage ? '◌ ' : '○ '), t(labels[stage] || 'setupProgress')))),
        state.error && h('p', { role: 'alert', className: 'dsh-wt-error' }, state.error),
        !state.busy && state.op && h('div', { className: 'dsh-wt-row' }, h('code', null, state.op.id), h(Button, { onClick: () => { void flow.reconcile(sessionId); } }, t('reconcile')), state.op.result?.sessionId && h(Button, { onClick: () => flow.openTarget(sessionId) }, t('open'))));
    }
    function RecoveryNotice({ sessionId, recovery, t }: { sessionId: string; recovery: WT.RecoveryStore; t: WT.Translate }) {
      const state = React.useSyncExternalStore(recovery.store.subscribe, recovery.store.getSnapshot);
      if (state.sessionId !== sessionId || !recoveryBlocked(state.info?.cleanup)) return null;
      const info = state.info, cleanup = info.cleanup!, readyHere = info.continuationSessionId === sessionId;
      const title = cleanup.phase === 'collected' ? 'gcWarning' : cleanup.phase === 'recovery-required' ? 'gcRecovery' : 'gcCollecting';
      const branches = state.branches.filter(item => item.name.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()));
      const choosing = cleanup.phase === 'collected' && !info.continuationSessionId && !state.cancelled;
      return h('section', { className: 'dsh-wt dsh-wt-recovery', 'aria-label': t('gcLocal'), 'aria-busy': state.busy || state.loading }, h(Styles),
        h('p', { role: 'status', 'aria-live': 'polite' }, t(title)), cleanup.reclaimedAt !== null && h('p', { className: 'dsh-wt-muted' }, t('gcDate', { date: new Date(cleanup.reclaimedAt).toLocaleString() })),
        info.originalFolder && h('p', { className: 'dsh-wt-muted' }, t('original'), ': ', h('code', null, info.originalFolder)),
        cleanup.reason && h('p', { className: 'dsh-wt-error' }, cleanup.reason.code + ': ' + cleanup.reason.message),
        readyHere && h('p', null, t('gcSelected', { branch: info.recoveredBranch ?? 'HEAD' })),
        !readyHere && info.continuationSessionId && h(Button, { disabled: state.busy || state.loading || !state.checked, onClick: () => { void recovery.openTarget(); } }, t('open')),
        state.draftHistoryId && h('div', null, h('p', { className: 'dsh-wt-muted' }, t('gcDraftHeld')), h(Button, { onClick: () => { void recovery.openHistory(); } }, t('gcHistoryDraft'))),
        !readyHere && !info.continuationSessionId && h('p', { className: 'dsh-wt-muted' }, t('gcDraftHeld')),
        choosing && h(React.Fragment, null, h('p', null, t('gcChoose')), h('p', { className: 'dsh-wt-muted' }, t('gcSwitchWarning')),
          h('label', { className: 'dsh-wt-field' }, t('search'), h('input', { type: 'search', maxLength: 256, value: state.query, 'aria-label': t('search'), disabled: state.busy, onChange: event => recovery.setQuery(event.target.value) })),
          h('fieldset', { disabled: state.busy || state.loading || !state.checked }, h('legend', null, t('gcAllBranches')), h('div', { className: 'dsh-wt-recovery-branches' }, ...branches.map(item => h('label', { key: item.name }, h('input', { type: 'radio', name: 'recovery-' + sessionId, checked: state.selected?.name === item.name, onChange: () => recovery.choose(item.name) }), h('span', null, item.name === 'HEAD' ? t('detached') + ' · HEAD' : item.name), item.current && h('span', { className: 'dsh-wt-muted' }, t('gcCurrent')), item.retained && h('span', { className: 'dsh-wt-muted' }, t('gcRetained')))))),
          !branches.length && h('p', { role: 'status' }, t('noBranches')), info.nextCursor && h(Button, { disabled: state.busy || state.paging || !state.checked, onClick: () => { void recovery.more(); } }, t('more')),
          h('div', { className: 'dsh-wt-row' }, h(Button, { className: 'dsh-wt-primary', disabled: state.busy || state.loading || !state.checked || !state.selected, onClick: () => { void recovery.resume(); } }, t('gcContinue')), h(Button, { onClick: recovery.cancel }, t('gcReadOnly')))),
        state.cancelled && !readyHere && h('p', { role: 'status' }, t('gcCancelled')),
        info.pendingSessionId && !readyHere && h('div', null, h('p', { className: 'dsh-wt-muted' }, t('gcPending')), info.pendingSessionId !== sessionId && h(Button, { disabled: state.busy || state.loading || !state.checked, onClick: () => { void recovery.openPermissions(); } }, t('gcPermissions'))),
        state.foreignBlock && h('p', { role: 'status', className: 'dsh-wt-muted' }, t('blocked')),
        state.loading && h('p', { role: 'status' }, t('gcLookup')), state.error && h('p', { role: 'alert', className: 'dsh-wt-error' }, state.error),
        !readyHere && h('div', { className: 'dsh-wt-row' }, h(Button, { disabled: state.busy || state.loading, onClick: () => { void recovery.refresh(); } }, t('refresh')), state.cancelled && h(Button, { disabled: state.busy || state.loading, onClick: () => { void recovery.retry(); } }, t('gcRetry'))));
    }
    // Keep the header passive: worktree details are loaded over quiet RPC only
    // after the user opens the manager, never on an ordinary conversation mount.
    function RootFolderSettings({ view, form, t }: { view: string; form?: WT.SettingsForm; t: WT.Translate }) {
      if (view === 'summary') return h('span', null, t('rootSummary') + ' · ' + t('cleanupTitle'));
      return h(React.Fragment, null, h(RootFolderSettingsPage, { form, t }), h(CleanupSettingsPage, { form, t }));
    }
    function CleanupSettingsPage({ form, t }: { form?: WT.SettingsForm; t: WT.Translate }) {
      const state = form?.state, value = cleanupSettingsValue(state);
      const [enabled, setEnabled] = React.useState(value.enabled), [days, setDays] = React.useState(String(value.days)), [revision, setRevision] = React.useState(state?.revision), [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [saved, setSaved] = React.useState(false);
      const pending = React.useRef<{ revision?: number; reset: boolean; enabled: boolean; days: number | string } | null>(null), alive = React.useRef(true), field = React.useId(), help = React.useId();
      React.useEffect(() => () => { alive.current = false; }, []);
      React.useEffect(() => {
        if (!dirty || (pending.current && state?.revision !== pending.current.revision && (pending.current.reset || (value.enabled === pending.current.enabled && value.days === pending.current.days)))) {
          setEnabled(value.enabled); setDays(String(value.days)); setRevision(state?.revision); setDirty(false); pending.current = null;
        }
      }, [value.enabled, value.days, state?.revision, dirty]);
      const writable = state?.status === 'ready' && state.writable && state.mode === 'host';
      function changed() { setDirty(true); setSaved(false); setError(''); }
      async function save(reset = false) {
        if (busy) return; setBusy(true); setError(''); setSaved(false);
        try {
          const next = await writeCleanupSettings(form, enabled, days, revision, reset);
          if (alive.current) { pending.current = { ...next, revision, reset }; if (reset || (next.enabled === value.enabled && next.days === value.days)) setDirty(false); setSaved(true); }
        } catch (failure) { if (alive.current) setError(report(t, failure)); }
        finally { if (alive.current) setBusy(false); }
      }
      return h('section', { className: 'dsh-wt dsh-wt-card', 'aria-label': t('cleanupTitle') }, h(Styles), h('h3', null, t('cleanupTitle')),
        h('form', { onSubmit: event => { event.preventDefault(); void save(); } },
          h('label', null, h('input', { type: 'checkbox', checked: enabled, disabled: !writable || busy, onChange: event => { setEnabled(event.target.checked); changed(); } }), t('cleanupEnabled')),
          h('label', { className: 'dsh-wt-field', htmlFor: field }, t('cleanupDays'), h('input', { id: field, type: 'number', min: 1, max: 3650, step: 1, value: days, disabled: !writable || busy, 'aria-describedby': help, onChange: event => { setDays(event.target.value); changed(); } })),
          h('p', { id: help, className: 'dsh-wt-muted' }, t('cleanupHelp')), h('p', { className: 'dsh-wt-cleanup-danger' }, t('cleanupDanger')),
          h('div', { className: 'dsh-wt-row' }, h('button', { type: 'submit', disabled: !writable || busy || !dirty }, t(busy ? 'loading' : 'save')), h(Button, { disabled: !writable || busy, onClick: () => { void save(true); } }, t('rootReset'))),
          !writable && h('p', { role: 'status' }, t('rootUnavailable')), saved && h('p', { role: 'status', 'aria-live': 'polite' }, t('cleanupSaved')), error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error)));
    }
    function RootFolderSettingsPage({ form, t }: { form?: WT.SettingsForm; t: WT.Translate }) {
      const state = form?.state, value = rootFolderValue(state);
      const [draft, setRootDraft] = React.useState(value), [revision, setRevision] = React.useState(state?.revision), [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [saved, setSaved] = React.useState(false);
      const pendingSave = React.useRef<{ root: string; reset: boolean; revision?: number } | null>(null), alive = React.useRef(true), field = React.useId(), hint = React.useId();
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
    function Header({ projects, sessionId, t, useSession, useWorkspaces }: Pick<WT.SessionProps, 'projects' | 'sessionId' | 't' | 'useSession' | 'useWorkspaces'>) {
      const blank = useSession(value => value.blank), workspaces = useWorkspaces(value => value);
      const metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot), context = projects.context(sessionId), backing = projectBacking(metadata, workspaces, sessionId);
      if (blank || (!context && backing.mode !== 'worktree')) return null;
      const worktree = backing.mode === 'worktree', record = backing.record;
      const label = [context?.project.title, t(worktree ? 'worktreeThread' : 'local'), record?.branch, recoveryLabel(record?.cleanup, t)].filter(Boolean).join(' · ');
      return h('span', { className: 'dsh-wt dsh-wt-muted', title: backing.effectiveCwd }, h(Styles), label);
    }
    function Manager({ runtime: ctx, projects, recovery, t, useSessions, usePanelInfo, useSessionStatus }: WT.ManagerProps) {
      const list = useSessions(value => value);
      const activePanel = usePanelInfo(value => value.activePanelId);
      const sessionStatuses = useSessionStatus(value => value);
      const selectedActor = currentActor(list), recoveryState = React.useSyncExternalStore(recovery.store.subscribe, recovery.store.getSnapshot), metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot);
      const historical = !!selectedActor && !recoveryVerified(recoveryState, selectedActor);
      // Manager reads must not resolve the reclaimed historical Agent as actor.
      const actorId = historical ? undefined : selectedActor;
      const [records, setRecords] = React.useState<WT.Record[]>([]);
      const [cursor, setCursor] = React.useState<string | undefined>(undefined);
      const [archived, setArchived] = React.useState(false);
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);
      const [revision, setRevision] = React.useState(0);
      const [previewRecord, setPreviewRecord] = React.useState<WT.Record | null>(null);
      const lifetime = React.useRef<AbortController | null>(null);
      const generation = React.useRef(0);
      React.useEffect(() => {
        const controller = new AbortController(); lifetime.current = controller;
        const seq = ++generation.current;
        setRecords([]); setCursor(undefined); setError('');
        if (!actorId || activePanel !== PANEL) { setLoading(false); return () => controller.abort(); }
        setLoading(true);
        requestHost(ctx, actorId, { action: 'list', includeArchived: archived, limit: 50 }, controller.signal).then(data => {
          if (seq !== generation.current || controller.signal.aborted) return;
          if (!Array.isArray(data?.items)) throw new WorktreeError('decode', 'invalid-list');
          setRecords(data.items); projects?.rememberRecords(data.items); setCursor(data.nextCursor);
        }).catch(failure => { if (seq === generation.current && !controller.signal.aborted) setError(report(t, failure)); }).finally(() => { if (seq === generation.current && !controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, [ctx, actorId, archived, revision, activePanel]);
      async function more() {
        const controller = lifetime.current; if (!controller) return; const seq = generation.current;
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
        !actorId ? h(React.Fragment, null, h('p', { role: 'status' }, t(historical ? 'gcChoose' : 'actor')), historical && metadata.records.map(record => h(RecordCard, { key: record.id, record, runtime: ctx, t, actorId: undefined, list, sessionStatuses, onChanged: () => {}, onPreview: () => {} }))) : h(React.Fragment, null,
          h('div', { className: 'dsh-wt-row' }, h(Button, { disabled: loading, onClick: () => setRevision(value => value + 1) }, t('refresh')),
            h('label', null, h('input', { type: 'checkbox', checked: archived, onChange: event => setArchived(event.target.checked) }), t('includeArchived'))),
          loading && h('p', { role: 'status' }, t('loading')),
          !loading && records.length === 0 && h('p', null, t('empty')),
          ...records.map(record => h(RecordCard, { key: record.id, record, runtime: ctx, t, actorId, list, sessionStatuses, onChanged: () => setRevision(value => value + 1), onPreview: () => setPreviewRecord(record) })),
          cursor && h(Button, { disabled: loading, onClick: more }, t('more'))),
        error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error),
        previewRecord && h(Handoff, { key: previewRecord.id + ':' + actorId, record: previewRecord, actorId, runtime: ctx, t, close: () => setPreviewRecord(null) }));
    }
    function RecordCard({ record, runtime: ctx, t, actorId, list, sessionStatuses, onChanged, onPreview }: WT.CardProps) {
      const [checkout, setCheckout] = React.useState<WT.Checkout | null>(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [name, setName] = React.useState('');
      const [branchDialog, setBranchDialog] = React.useState(false);
      const [operationStatus, setOperationStatus] = React.useState<WT.OperationReply | null>(null);
      const controller = React.useRef<AbortController | null>(null);
      React.useEffect(() => {
        const abort = new AbortController(); controller.current = abort;
        if (!actorId || record.state === 'missing' || recoveryBlocked(record.cleanup)) { setCheckout(null); return () => abort.abort(); }
        requestHost(ctx, actorId, { action: 'status', id: record.id }, abort.signal).then(data => { if (!abort.signal.aborted) setCheckout(data.status); }).catch(failure => { if (!abort.signal.aborted) setError(t('statusError') + ': ' + report(t, failure)); });
        return () => abort.abort();
      }, [ctx, actorId, record]);
      async function act(request: WT.WorktreeRequest, open = false) {
        if (!actorId) return;
        const signal = controller.current?.signal; if (!signal) return;
        const navigation = open ? ctx.layout.beginNavigation() : null;
        setBusy(true); setError('');
        try {
          const data = await requestHost(ctx, actorId, { ...request, id: record.id }, signal);
          if (signal.aborted) return;
          if (open) {
            if (!data?.sessionId) throw new WorktreeError('invalidSession', 'missing-exact-session');
            if (navigation && !navigation.aborted && currentActor(ctx.sessions.list.getSnapshot()) === actorId) ctx.uiWorkspace.openSession(data.sessionId);
          } else { setBranchDialog(false); onChanged(); }
        } catch (failure) { if (!signal.aborted) setError(report(t, failure)); }
        finally { if (!signal.aborted) setBusy(false); }
      }
      return h('article', { className: 'dsh-wt-card' },
        h('div', { className: 'dsh-wt-row dsh-wt-between' }, h('h3', null, record.branch || t('detached')), h('span', { className: 'dsh-wt-muted' }, t(record.protected ? 'protected' : 'unprotected') + (record.archived ? ' · ' + t('archived') : ''))),
        h('dl', { className: 'dsh-wt-details' },
          h('dt', null, t('base')), h('dd', null, record.remote + '/' + record.remoteBranch + ' · ' + record.baseOid.slice(0, 12)),
          h('dt', null, t('state')), h('dd', null, record.state + (record.cleanup ? ' · ' + recoveryLabel(record.cleanup, t) : '') + (checkout ? ' · ' + t(checkout.dirty ? 'dirty' : 'clean') + ' · ' + checkout.changes + ' / ' + checkout.untracked : '')),
          h('dt', null, t('local')), h('dd', null, h('code', null, record.effectiveCwd)),
          h('dt', null, t('sessions')), h('dd', null, ...record.sessionIds.map(id => h('div', { key: id, className: 'dsh-wt-row' }, h(Button, { onClick: () => ctx.uiWorkspace.openSession(id) }, list.byId[id]?.displayTitle || id), h('span', { className: 'dsh-wt-muted' }, t(sessionStatuses.get(id)?.running ? 'busy' : 'idle')))))),
        record.cleanup && h('div', { className: 'dsh-wt-muted' }, record.cleanup.phase === 'collected' && h('p', null, t('gcWarning')), record.cleanup.reclaimedAt !== null && h('p', null, t('gcDate', { date: new Date(record.cleanup.reclaimedAt).toLocaleString() })), record.cleanup.reason && h('p', null, record.cleanup.reason.code + ': ' + record.cleanup.reason.message)),
        record.error && h('p', { role: 'alert', className: 'dsh-wt-error' }, record.error),
        h('div', { className: 'dsh-wt-row' },
          h(Button, { disabled: busy || !actorId || record.archived || record.state !== 'ready' || recoveryBlocked(record.cleanup), onClick: () => act({ action: 'start', sourceSessionId: actorId, sessionMode: 'continue' }, true) }, t('open')),
          h(Button, { disabled: busy || !actorId || record.archived || record.state !== 'ready' || recoveryBlocked(record.cleanup), onClick: () => setBranchDialog(true) }, t('createBranch')),
          h(Button, { disabled: busy || !actorId, onClick: () => act({ action: 'protect', protected: !record.protected }) }, t(record.protected ? 'unprotect' : 'protect')),
          h(Button, { disabled: busy || !actorId, onClick: () => act({ action: 'archive', archived: !record.archived }) }, t(record.archived ? 'restore' : 'archive')),
          h(Button, { disabled: busy || !actorId || record.state !== 'ready' || recoveryBlocked(record.cleanup) || (!actorId || !record.sessionIds.includes(actorId)), onClick: onPreview }, t('preview'))),
        (!actorId || !record.sessionIds.includes(actorId)) && h('p', { className: 'dsh-wt-muted' }, t('openSource')),
        h('p', { className: 'dsh-wt-muted' }, t('operation') + ': ', h('code', null, record.operationId)),
        h(Button, { disabled: busy || !actorId, onClick: async () => {
          if (!actorId) return;
          const signal = controller.current?.signal; if (!signal) return;
          try { const data = await requestHost(ctx, actorId, { action: 'status', operationId: record.operationId }, signal); if (!signal.aborted) setOperationStatus(data); }
          catch (failure) { if (!signal.aborted) setError(report(t, failure)); }
        } }, t('reconcile')),
        operationStatus && h('p', { role: 'status' }, t('state') + ': ' + operationStatus.operation.phase),
        error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error),
        branchDialog && h(Dialog, { title: t('createBranch'), t, close: () => setBranchDialog(false) }, h('form', { onSubmit: event => { event.preventDefault(); void act({ action: 'branch', name }); } },
          h('label', { className: 'dsh-wt-field' }, t('branchName'), h('input', { value: name, required: true, onChange: event => setName(event.target.value) })),
          h('button', { type: 'submit', disabled: busy || !name.trim() }, t('createBranch')))));
    }
    function Handoff({ record, actorId, runtime: ctx, t, close }: { record: WT.Record; actorId?: string; runtime: WT.Context; t: WT.Translate; close(): void }) {
      const [preview, setPreview] = React.useState<WT.Preview | null>(null);
      const [exported, setExported] = React.useState<WT.Export | null>(null);
      const [targetPath, setTargetPath] = React.useState('');
      const [noWriters, setNoWriters] = React.useState(false);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [operationId, setOperationId] = React.useState<string | null>(null);
      const [operationStatus, setOperationStatus] = React.useState<WT.OperationReply | null>(null);
      const [copied, setCopied] = React.useState(false);
      const lifetime = React.useRef(new AbortController());
      const request = React.useRef<AbortController | null>(null);
      const seq = React.useRef(0);
      React.useEffect(() => () => { lifetime.current.abort(); request.current?.abort(); }, []);
      function changed(value: string) { request.current?.abort(); ++seq.current; setTargetPath(value); setPreview(null); setExported(null); setNoWriters(false); setBusy(false); setOperationId(null); }
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
        const saved = preview; if (!saved) return; const generation = seq.current;
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
        if (!operationId) return;
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
          operationStatus && h('div', null, h('p', null, t('state') + ': ' + operationStatus.operation.phase), operationStatus.operation.error && h('p', { role: 'alert' }, operationStatus.operation.error.code + ': ' + operationStatus.operation.error.message), operationStatus.sessionId && h(Button, { onClick: () => ctx.uiWorkspace.openSession(operationStatus.sessionId!) }, t('open')))));
    }
    return {
      inject: ['slots', 'locale', 'conversation', 'sessions', 'uiSession', 'uiWorkspace', 'layout', 'connection', 'workspaces', 'shortcuts'],
      // Export pure protocol/guard functions for Node tests, not a second renderer or service.
      protocol: Object.freeze({ cleanupSettingsValue, writeCleanupSettings, cleanupData, recoveryRequest, recoveryData, requestRecovery, recoveryBlocked, recoveryLabel, recoveryBranches, createRecoveryStore, createRepositoryAvailability, projectMainFolder, draftMainFolder, chooseConversationFolder, rootFolderValue, writeRootFolder, decodeReply, validateData, currentActor, sourceEligible, inputEmpty, captureDraft, draftUnchanged, advertisedDefault, acquireBlock, NATIVE_SUBMIT_ABI, interrupted, leaseNativeSink, setupProgress, prepareWorktree, waitForDraftFiles, createWorktreeFlow, requestHost, absolutePath, projectRequest, projectData, requestProjects, workspaceStructure, projectContext, captureProject, sameProject, projectPath, projectRows, visibleProjectRows, projectActor, projectReady, createProjectStore, projectSlotName, projectChildren, mirrorProjectSlot, createSidebarMode }),
      apply(ctx: WT.Context) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }));
        const projects = createProjectStore(ctx, ctx.locale.bind(NS));
        ctx.effect(() => () => projects.dispose());
        const recovery = createRecoveryStore(ctx, ctx.locale.bind(NS), projects);
        ctx.effect(() => () => recovery.dispose());
        const repositories = createRepositoryAvailability(ctx, projects);
        ctx.effect(() => () => repositories.dispose());
        const flow = createWorktreeFlow(ctx, ctx.locale.bind(NS), projects, repositories);
        ctx.effect(() => () => flow.dispose());
        let sidebarMode: WT.SidebarMode;
        const seat = <P,>(owner: string, options: WT.SlotOptions, component: WT.Component<P>) => ctx.slots.inject(owner, () => ctx.slots.register({ ...options, locale: NS, inject: () => ({ runtime: ctx, flow, projects, repositories, recovery, sidebarMode }) }, component));
        sidebarMode = createSidebarMode(() => seat('sidebar.workspaces', { name: 'sidebar.workspaces', priority: -50, children: projectChildren(ctx) }, ProjectsSidebar));
        ctx.effect(() => () => sidebarMode.dispose());
        for (const source of projectSlots) mirrorProjectSlot(ctx, source);
        registerSidebarViewSwitch(ctx, sidebarMode, SidebarToggle);
        seat('conversation.input.left', { name: 'conversation.input.left', id: PANEL, order: 15 }, NewWorktreeControls);
        seat('conversation.input.dock', { name: 'conversation.input.dock', id: PANEL + '-setup', order: 5 }, SetupProgress);
        seat('conversation.input.dock', { name: 'conversation.input.dock', id: PANEL + '-recovery', order: 10 }, RecoveryNotice);
        seat('plugins.row.config', { name: 'plugins.row.config', key: '@1yefuwang1/dsh-worktrees#git-worktrees' }, RootFolderSettings);
        seat('conversation.session.header.actions', { name: 'conversation.session.header.actions', id: PANEL, order: 250 }, Header);
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 450, label: () => ctx.locale.bind(NS)('title') }, Icon));
        seat('main', { name: 'main', key: PANEL }, Manager);
      },
    };
  },
});
