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
      searchProjects: 'Search projects and sessions', closeSearch: 'Close search', viewOptions: 'View options',
      'time.now': 'now', 'time.minutes': '{n}min', 'time.hours': '{n}h', 'time.days': '{n}d', 'time.months': '{n}mo', 'time.years': '{n}y', 'date.ymd': '{y}-{m}-{d}', lastActive: 'Last active {time}',
      projects: 'Projects', folderView: 'Folder view', newProject: 'New project', editProject: 'Manage project', projectName: 'Project name', project: 'Project', folders: 'Folders', folder: 'Folder', addFolder: 'Add folder', chooseDirectory: 'Choose directory', browse: 'Browse folders', absolutePath: 'Absolute Host directory path', save: 'Save', newThread: 'New thread', threadMode: 'Thread mode', threadActions: 'Thread actions', threadDetails: 'Thread details', unassigned: 'Other threads', showMore: 'Show {n} more sessions', showLess: 'Show less', filterThreads: 'Search threads or projects', allThreads: 'All threads', archivedOnly: 'Archived only', hideArchived: 'Hide archived', untitled: 'Untitled', blankThread: 'New thread', collapse: 'Collapse project', expand: 'Expand project', waiting: 'Waiting for interaction', done: 'Finished, not yet viewed', localThread: 'Local thread', worktreeThread: 'Worktree thread', draftWarning: 'This draft contains text or attachments. Keep it in this thread before choosing another project or folder.', chooseFolder: 'Choose a folder', createFolder: 'Create folder', folderName: 'Folder name', chooseThisFolder: 'Use this folder', noProjects: 'Add a project to organize your threads.',
      repoUnavailable: 'Worktree mode is unavailable or unverified for this folder. Choose Local to continue.',
      projectChanged: 'The project or selected folder changed. Choose Local or keep the current folder before selecting New worktree again.', keepCurrentFolder: 'Keep current folder',
      removeProject: 'Remove project', removeProjectConfirm: 'Remove this project?', removeProjectHelp: 'Only the project metadata will be removed. All folders, files, conversations and worktrees will be kept. Conversations remain available under Other threads and in Folder view.',
      mainFolder: 'Main folder', main: 'Main', chooseMainFolder: 'Select the main folder', mainFolderRequired: 'Choose a main folder from the project source folders.', mainFolderHelp: 'Default for new conversations. You can choose another folder before sending.', conversationFolder: 'Conversation folder',
      createProject: 'Create project', sourceFolders: 'Source folders', localFolders: 'Add a folder on this computer', enterFolderPath: 'Enter a folder path', add: 'Add', cancel: 'Cancel', selectedFolders: 'Selected folders', selectFolder: 'Select folder', folderLimit: 'A project can contain at most 32 folders.', invalidFolder: 'Enter a valid absolute Host folder path.', alreadyAdded: 'Already added', multiFolderHelp: 'Select multiple folders using the checkboxes. Selections are kept as you browse.', hostFolderHelp: 'Folders are on the Host computer; adding them does not move files.', noSubfolders: 'No subfolders.', directoryTruncated: 'This listing is truncated. Enter a path to browse other folders.',
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
      searchProjects: '搜索项目和会话', closeSearch: '关闭搜索', viewOptions: '视图选项',
      'time.now': '刚刚', 'time.minutes': '{n}分钟', 'time.hours': '{n}小时', 'time.days': '{n}天', 'time.months': '{n}个月', 'time.years': '{n}年', 'date.ymd': '{y}年{m}月{d}日', lastActive: '最后活跃于 {time}',
      projects: '项目', folderView: '文件夹视图', newProject: '新建项目', editProject: '管理项目', projectName: '项目名称', project: '项目', folders: '文件夹', folder: '文件夹', addFolder: '添加文件夹', chooseDirectory: '选择目录', browse: '浏览文件夹', absolutePath: '主机绝对目录路径', save: '保存', newThread: '新建对话', threadMode: '对话模式', threadActions: '对话操作', threadDetails: '对话详情', unassigned: '其他对话', showMore: '展开其余 {n} 个会话', showLess: '收起', filterThreads: '搜索对话或项目', allThreads: '所有对话', archivedOnly: '仅已归档', hideArchived: '隐藏已归档', untitled: '未命名', blankThread: '新对话', collapse: '收起项目', expand: '展开项目', waiting: '等待交互', done: '已完成，尚未查看', localThread: '本地对话', worktreeThread: '工作树对话', draftWarning: '此草稿包含文字或附件。请先保留当前对话，再选择其他项目或文件夹。', chooseFolder: '选择文件夹', createFolder: '创建文件夹', folderName: '文件夹名称', chooseThisFolder: '使用此文件夹', noProjects: '添加项目以组织您的对话。',
      repoUnavailable: '此文件夹的工作树模式不可用或尚未验证，请选择本地模式继续。',
      projectChanged: '项目或选定文件夹已更改，请先选择本地模式或保留当前文件夹，再重新选择新建工作树。', keepCurrentFolder: '保留当前文件夹',
      removeProject: '移除项目', removeProjectConfirm: '移除此项目？', removeProjectHelp: '仅移除项目元数据，所有文件夹、文件、对话和工作树都会保留。对话仍可在“其他对话”和“文件夹视图”中访问。',
      mainFolder: '主文件夹', main: '主目录', chooseMainFolder: '选择主文件夹', mainFolderRequired: '请从项目源文件夹中选择一个主文件夹。', mainFolderHelp: '新对话默认使用此文件夹，发送前仍可选择其他文件夹。', conversationFolder: '对话文件夹',
      createProject: '创建项目', sourceFolders: '源文件夹', localFolders: '添加此计算机上的文件夹', enterFolderPath: '输入文件夹路径', add: '添加', cancel: '取消', selectedFolders: '已选文件夹', selectFolder: '选择文件夹', folderLimit: '一个项目最多可包含 32 个文件夹。', invalidFolder: '请输入有效的主机绝对文件夹路径。', alreadyAdded: '已添加', multiFolderHelp: '使用复选框选择多个文件夹，浏览其他目录时会保留已选项。', hostFolderHelp: '文件夹位于主机计算机上；添加不会移动文件。', noSubfolders: '没有子文件夹。', directoryTruncated: '目录列表已截断，请输入路径浏览其他文件夹。',
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
.dsh-wt-create-controls{position:relative;font-size:12px}.dsh-wt-create-controls select{max-width:160px;min-height:28px}.dsh-wt-base-options{position:absolute;bottom:calc(100% + 8px);left:0;z-index:20;min-width:240px;max-width:360px;padding:12px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay)}.dsh-wt-create-error{max-width:360px;font-size:12px;color:var(--dsw-alias-state-error-primary)}
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
@media(prefers-reduced-motion:reduce){.dsh-wt-state-motion,.dsh-wt-state-arc{animation:none}.dsh-wt-state-arc{stroke-dasharray:18 150;stroke-dashoffset:-3}}
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
    function appendProjectFolders(previous, additions) {
      if (!Array.isArray(additions) || additions.some(path => !absolutePath(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path))) throw new WorktreeError('invalidFolder', 'invalid-project-folder');
      // Exact-string deduplication is only UX; realpath/ownership checks stay on the Host.
      const next = [...new Set([...previous, ...additions])];
      if (next.length > 32) throw new WorktreeError('folderLimit', 'project-folder-limit');
      return next;
    }
    function toggleProjectFolder(previous, path, capacity = 32) {
      if (previous.includes(path)) return previous.filter(value => value !== path);
      const next = appendProjectFolders(previous, [path]);
      if (next.length > capacity) throw new WorktreeError('folderLimit', 'project-folder-limit');
      return next;
    }
    function projectFolderName(path) {
      const separator = /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? /[\\/]/ : /\//;
      return path.split(separator).filter(Boolean).at(-1) || path;
    }
    function createFolderScanner(uiWorkspace, publish) {
      let active, generation = 0, disposed = false;
      return {
        async scan(path) {
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
    function projectMainFolder(project) {
      return project?.mainFolderId === undefined ? project?.folders[0] : project.folders.find(folder => folder.id === project.mainFolderId);
    }
    function draftMainFolder(folders, selected) { return folders.length === 1 ? folders[0] : folders.includes(selected) ? selected : ''; }
    function chooseConversationFolder(ctx, projects, flow, sessionId, folderId) {
      const binding = ctx.sessions.binding(sessionId), context = projects.context(sessionId), state = flow.store.getSnapshot();
      if (!binding || projectActor(ctx.sessions.list.getSnapshot()) !== sessionId || !sourceEligible(binding.session.getSnapshot()) || !inputEmpty(ctx.get('conversation').input.for(binding.ctx).state.getSnapshot()) || (state.sessionId === sessionId && state.busy)) throw new WorktreeError('draftWarning', 'folder-change-blocked');
      const folder = context?.project.folders.find(item => item.id === folderId);
      if (!folder) throw new WorktreeError('decode', 'invalid-project-folder');
      if (folder.id === context.folder.id && context.binding.mode === 'local') return false;
      ctx.uiWorkspace.startSession(folder.id); return true;
    }
    function createProjectSubmitter(projects, projectId, id) {
      let pending, pendingAction;
      function commit(request) {
        Object.freeze(request.folders); Object.freeze(request);
        const task = Promise.resolve().then(() => projects.mutate(request)); pending = task; pendingAction = request.action;
        const clear = () => { if (pending === task) { pending = undefined; pendingAction = undefined; } }; void task.then(clear, clear);
        return task;
      }
      const conflict = () => { throw new WorktreeError('busy', 'project-operation-pending'); };
      return {
        get pending() { return !!pending; },
        submit(title, folders, selectedMain) {
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
    function projectRequest(request) {
      const keys = { list: ['action', 'projectId'], create: ['action', 'id', 'title', 'folders', 'mainFolder'], update: ['action', 'projectId', 'title', 'folders', 'mainFolder'], remove: ['action', 'projectId'], bind: ['action', 'projectId', 'folderId', 'sessionId'], start: ['action', 'operationId', 'projectId', 'folderId'] }[request?.action];
      const title = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
      const folders = value => Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(absolutePath);
      const main = value => value === undefined || (absolutePath(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value));
      const folderId = value => typeof value === 'string' && value.length > 0;
      let valid = keys && Object.keys(request).every(key => keys.includes(key));
      if (request?.action === 'list') valid = valid && (request.projectId === undefined || uuid(request.projectId));
      if (request?.action === 'create') valid = valid && uuid(request.id) && title(request.title) && folders(request.folders) && main(request.mainFolder);
      if (request?.action === 'update') valid = valid && uuid(request.projectId) && (request.title !== undefined || request.folders !== undefined || request.mainFolder !== undefined) && (request.title === undefined || title(request.title)) && (request.folders === undefined || folders(request.folders)) && main(request.mainFolder);
      if (request?.action === 'remove') valid = valid && uuid(request.projectId);
      if (request?.action === 'bind') valid = valid && uuid(request.projectId) && folderId(request.folderId) && typeof request.sessionId === 'string' && !!request.sessionId;
      if (request?.action === 'start') valid = valid && uuid(request.projectId) && uuid(request.operationId) && (request.folderId === undefined || folderId(request.folderId));
      if (!valid) throw new WorktreeError('decode', 'invalid-project-request');
      return request;
    }
    function projectData(request, data) {
      const string = value => typeof value === 'string' && value.length > 0;
      const project = value => value && uuid(value.id) && string(value.title) && value.title.length <= 120 && Array.isArray(value.folders) && value.folders.length > 0 && value.folders.length <= 32 && value.folders.every(folder => string(folder?.id) && absolutePath(folder.path) && typeof folder.title === 'string') && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && !Object.is(value.createdAt, -0) && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0 && !Object.is(value.updatedAt, -0) && (value.imported === undefined || typeof value.imported === 'boolean') && (value.mainFolderId === undefined || (string(value.mainFolderId) && value.folders.some(folder => folder.id === value.mainFolderId)));
      const binding = value => value && string(value.sessionId) && uuid(value.projectId) && string(value.folderId) && ['local', 'worktree'].includes(value.mode) && absolutePath(value.effectiveCwd) && (value.mode === 'worktree' ? uuid(value.worktreeId) : value.worktreeId === undefined);
      let valid;
      if (request.action === 'list') {
        valid = data && Array.isArray(data.projects) && data.projects.every(project) && Array.isArray(data.bindings) && data.bindings.every(binding);
        if (valid && data.records !== undefined) validateData({ action: 'list' }, { items: data.records });
      }
      else if (request.action === 'start') valid = data && string(data.sessionId) && binding(data.binding) && data.workspaceId === data.binding.folderId && data.binding.sessionId === data.sessionId && data.binding.projectId === request.projectId && (request.folderId === undefined || data.binding.folderId === request.folderId) && data.binding.mode === 'local';
      else if (request.action === 'remove') valid = data && data.removed === true && data.projectId === request.projectId && data.scope === 'project-metadata' && Object.keys(data).every(key => ['removed', 'projectId', 'scope'].includes(key));
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
    function projectBacking(snapshot, workspaces, sessionId) {
      const context = projectContext(snapshot, workspaces, sessionId), workspace = workspaces.items.find(item => item.sessionIds.includes(sessionId));
      // Actual native cwd wins over historical membership/sessionIds, including a Local handoff.
      const effectiveCwd = workspace?.path || context?.binding.effectiveCwd || '';
      const record = (snapshot.records || []).find(item => item.effectiveCwd === effectiveCwd);
      const boundWorktree = context?.binding.mode === 'worktree' && context.binding.effectiveCwd === effectiveCwd;
      return { mode: record || boundWorktree ? 'worktree' : 'local', effectiveCwd, record };
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
        const row = { id, session, title, context, backing: projectBacking(metadata, workspaces, id), archived: isArchived, pinned: !isArchived && pins.has(id), running: (live?.running ?? session.running ?? false) || childRunning, pending: live?.pendingInteraction, done: live?.completionUnread === true };
        (groups.find(group => group.project.id === context?.project.id) || unassigned).rows.push(row);
      }
      for (const group of [...groups, unassigned]) group.rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.session.updatedAt || 0) - (a.session.updatedAt || 0) || a.id.localeCompare(b.id));
      return [...groups.filter(group => archived !== 'only' || group.rows.length), ...(unassigned.rows.length ? [unassigned] : [])];
    }
    function projectRowState(row) {
      if (row.archived || row.session.blank) return 'idle';
      return row.pending ? 'warning' : row.running ? 'ongoing' : row.done ? 'done' : 'idle';
    }
    function projectSessionTime(at, now, t) {
      if (!Number.isFinite(at) || at < 0 || at > 8640000000000000 || !Number.isFinite(now)) return null;
      const minute = 60000, hour = 3600000, day = 86400000, diff = Math.max(0, now - at);
      const [unit, n] = diff < minute ? ['now', 0] : diff < hour ? ['minutes', Math.floor(diff / minute)] : diff < day ? ['hours', Math.floor(diff / hour)] : diff < 30 * day ? ['days', Math.floor(diff / day)] : diff < 365 * day ? ['months', Math.floor(diff / (30 * day))] : ['years', Math.floor(diff / (365 * day))];
      const date = new Date(at), clock = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
      const absolute = t('date.ymd', { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }) + ' ' + clock;
      return { label: unit === 'now' ? t('time.now') : t('time.' + unit, { n }), dateTime: date.toISOString(), title: t('lastActive', { time: absolute }) };
    }
    function visibleProjectRows(rows, limit, selectedId) {
      let idle = 0;
      return rows.filter(row => row.session?.blank || row.running || row.pending || row.id === selectedId || idle++ < limit);
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
      async function mutate(request) {
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
          if (data.project) install({ projects: [...state.projects.filter(item => item.id !== data.project.id), data.project], bindings: state.bindings });
          if (data.binding) install({ projects: state.projects, bindings: [...state.bindings.filter(item => item.sessionId !== data.binding.sessionId), data.binding] });
          return data;
        } finally { operations.delete(op); if (!operations.size) schedule(); }
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
    function createRepositoryAvailability(ctx, projects) {
      const listeners = new Set(); let disposed = false, started = false, observedSession, active, version = 0, stopBinding = () => {}, queued = false, connectionId = ctx.connection.generation.getSnapshot()?.id;
      let state = { target: null, phase: 'idle', available: false };
      const publish = patch => { if (disposed) return; state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
      const store = { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
      function target(sessionId) {
        if (!sessionId || projectActor(ctx.sessions.list.getSnapshot()) !== sessionId) return null;
        const binding = ctx.sessions.binding(sessionId), connection = ctx.connection.generation.getSnapshot();
        if (!binding || !connection || !sourceEligible(binding.session.getSnapshot())) return null;
        const project = captureProject(projects.context(sessionId));
        return { sessionId, binding, connection: connection.id, project, path: project?.path };
      }
      const same = (left, right) => !!left && !!right && left.sessionId === right.sessionId && left.binding === right.binding && left.connection === right.connection && sameProject(left.project, right.project);
      function reset() { active?.controller.abort(); active = undefined; ++version; stopBinding(); stopBinding = () => {}; publish({ target: null, phase: 'idle', available: false }); }
      function schedule() { if (!started || queued || disposed) return; queued = true; void Promise.resolve().then(() => { queued = false; if (!disposed) void ensure(projectActor(ctx.sessions.list.getSnapshot())); }); }
      function changed() { const current = target(projectActor(ctx.sessions.list.getSnapshot())); if (state.target && !same(current, state.target)) reset(); if (current && !state.target) schedule(); }
      function ensure(sessionId) {
        if (disposed) return Promise.resolve(); started = true; observedSession = sessionId;
        const next = target(sessionId);
        if (!next) { if (state.target) reset(); return Promise.resolve(); }
        if (same(next, state.target) && state.phase !== 'idle') return active?.task || Promise.resolve();
        reset(); const controller = new AbortController(), seq = ++version;
        const operation = { controller, task: null }; active = operation;
        stopBinding = next.binding.session.subscribe(changed);
        operation.task = Promise.resolve().then(async () => {
          if (disposed || controller.signal.aborted || seq !== version || !same(target(sessionId), next)) return;
          try {
            // Read-only local discovery through the existing caller-authorized status operation.
            const data = await requestHost(ctx, sessionId, { action: 'status', ...(next.path ? { repoPath: next.path } : {}) }, controller.signal);
            if (next.path && data.projectPath !== next.path) throw new WorktreeError('decode', 'repository-target-mismatch');
            if (!disposed && !controller.signal.aborted && seq === version && same(target(sessionId), next)) publish({ phase: data.remotes.length ? 'ready' : 'unavailable', available: data.remotes.length > 0 });
          } catch { if (!disposed && !controller.signal.aborted && seq === version && same(target(sessionId), next)) publish({ phase: 'unavailable', available: false }); }
          finally { if (active === operation) active = undefined; }
        });
        publish({ target: next, phase: 'checking', available: false });
        return operation.task;
      }
      const subscriptions = [ctx.sessions.list.subscribe(changed), projects.store.subscribe(changed), ctx.connection.generation.subscribe(() => { const next = ctx.connection.generation.getSnapshot()?.id; if (next === connectionId) return; connectionId = next; reset(); schedule(); })];
      return { store, ensure,
        withdraw(sessionId) { if (observedSession === sessionId) { started = false; observedSession = undefined; reset(); } },
        unavailable(sessionId, binding, project) { const current = target(sessionId); if (disposed || !same(current, state.target) || current.binding !== binding || !sameProject(current.project, project)) return; active?.controller.abort(); active = undefined; ++version; publish({ phase: 'unavailable', available: false }); },
        enabled(sessionId) { return !disposed && state.phase === 'ready' && state.available && same(target(sessionId), state.target); },
        dispose() { if (disposed) return; active?.controller.abort(); ++version; stopBinding(); subscriptions.forEach(stop => stop()); disposed = true; listeners.clear(); },
      };
    }
    function createWorktreeFlow(ctx, t, projects, repositories) {
      const conversation = ctx.get('conversation'), listeners = new Set(), leases = new Map(), operations = new Set(), restaged = new Set();
      let state = { sessionId: undefined, mode: 'local', sourceChanged: false, busy: false, loading: false, error: '', status: null, remote: '', branch: '', branches: null, query: '', steps: [], phase: '', op: null };
      let query, selectedSource, generation = 0, disposed = false;
      const publish = patch => { if (disposed) return; state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
      const store = { getSnapshot: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
      const pending = id => ctx.uiSession.sessionStatus.getSnapshot().get(id)?.pendingInteraction !== undefined;
      const repositoryAllowed = id => repositories?.enabled(id) === true;
      function requireRepository(sessionId) { if (!repositoryAllowed(sessionId)) throw new WorktreeError('repoUnavailable', 'repository-not-verified'); }
      async function repositoryStatus(sessionId, binding, project, signal) {
        try {
          const data = await requestHost(ctx, sessionId, { action: 'status', ...(project ? { repoPath: project.path } : {}) }, signal);
          if (project && data.projectPath !== project.path) throw new WorktreeError('decode', 'repository-target-mismatch');
          if (!data.remotes.length) throw new WorktreeError('noRemote', 'no-remote');
          return data;
        } catch (error) { if (!signal.aborted) repositories?.unavailable(sessionId, binding, project); throw error; }
      }
      function source(sessionId) {
        const binding = ctx.sessions.binding(sessionId), input = binding && conversation.input.for(binding.ctx);
        if (!binding || projectActor(ctx.sessions.list.getSnapshot()) !== sessionId || !sourceEligible(binding.session.getSnapshot()) || pending(sessionId)) throw new WorktreeError('changed', 'source-not-blank-idle');
        return { binding, input, project: captureProject(projects.context(sessionId)) };
      }
      function requireIntent(sessionId, current) {
        if (state.sessionId === sessionId && state.mode === 'new' && (state.sourceChanged || !selectedSource || selectedSource.binding !== current.binding || !sameProject(selectedSource.project, current.project))) throw new WorktreeError('projectChanged', 'selected-worktree-source-changed');
      }
      function checkSource(sessionId, before) {
        const current = source(sessionId); requireRepository(sessionId); requireIntent(sessionId, current);
        if (current.binding !== before.binding || !sameProject(current.project, before.project)) throw new WorktreeError('changed', 'source-changed');
      }
      function check(op) {
        if (disposed || op.signal.aborted || op.navigation.aborted) throw new WorktreeError('cancelled', 'cancelled');
        const current = source(op.sessionId); requireRepository(op.sessionId);
        if (current.binding !== op.binding || !sameProject(current.project, op.project)) throw new WorktreeError('changed', 'source-changed');
        if (op.block.store.getSnapshot() !== op.block.owned) throw new WorktreeError('ownership', 'block-lost');
      }
      function capture(sessionId, binding, signal, controller) {
        if (state.sessionId !== sessionId || state.mode !== 'new') return { mode: 'local' };
        if (state.busy) throw new WorktreeError('busy', 'first-message-already-preparing');
        requireRepository(sessionId);
        const captured = source(sessionId); requireIntent(sessionId, captured); if (captured.binding !== binding) throw new WorktreeError('changed', 'binding-changed');
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
            const status = await repositoryStatus(op.sessionId, op.binding, op.project, signal); check(op);
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
            for (const lease of leases.values()) lease.cancelNew(); ctx.uiWorkspace.startSession(current.project.folderId); return;
          }
          if (mode === 'local') { for (const lease of leases.values()) lease.cancelNew(); }
          const changed = state.sessionId !== sessionId || state.sourceChanged || selectedSource?.binding !== current.binding || !sameProject(selectedSource?.project, current.project);
          if (changed) { query?.abort(); ++generation; }
          selectedSource = { sessionId, binding: current.binding, project: current.project };
          publish({ sessionId, mode, sourceChanged: false, error: '', ...(changed ? { status: null, branches: null, branch: '', remote: '', ...(state.sessionId === sessionId ? {} : { op: null, steps: [], phase: '' }) } : {}) });
        } catch (error) { publish({ sessionId, mode: latchedNew ? 'new' : 'local', error: report(t, error) }); }
      }
      async function loadBranches(sessionId, text = '', more = false) {
        if (disposed || state.busy || state.sessionId !== sessionId || !state.status || !state.remote || (more && !state.branches?.nextCursor)) return;
        let current;
        try { current = source(sessionId); requireRepository(sessionId); requireIntent(sessionId, current); } catch (error) { publish({ error: report(t, error) }); return; }
        query?.abort(); query = new AbortController(); const controller = query, seq = ++generation, before = state.branches, remote = state.remote, project = current.project;
        publish({ loading: true, query: text, ...(more ? {} : { branches: null, branch: '' }) });
        try {
          const data = await requestHost(ctx, sessionId, { action: 'branches', repoPath: projectPath(state.status, project), remote, remoteIdentity: state.status.remotes.find(item => item.name === remote)?.identity, query: text, ...(more ? { cursor: before.nextCursor } : {}), limit: 100 }, controller.signal);
          if (disposed || controller.signal.aborted || seq !== generation) return; checkSource(sessionId, current);
          const names = new Set(more ? before.items.map(item => item.name) : []), branches = { ...data, items: [...(more ? before.items : []), ...data.items.filter(item => !names.has(item.name))] };
          publish({ branches, branch: more ? state.branch : text ? '' : advertisedDefault(branches, state.status.defaults?.branch), loading: false });
        } catch (error) { if (!controller.signal.aborted && seq === generation) publish({ loading: false, error: report(t, error) }); }
      }
      async function configure(sessionId) {
        if (disposed || state.busy) return;
        let current;
        try { current = source(sessionId); requireRepository(sessionId); requireIntent(sessionId, current); } catch (error) { publish({ error: report(t, error) }); return; }
        query?.abort(); query = new AbortController(); const controller = query, seq = ++generation, project = current.project;
        if (state.sessionId !== sessionId || state.mode !== 'new') selectedSource = { sessionId, binding: current.binding, project };
        publish({ sessionId, loading: true, status: null, branches: null, branch: '', remote: '', error: '', ...(state.sessionId === sessionId ? {} : { mode: 'local', sourceChanged: false, op: null, steps: [], phase: '' }) });
        try {
          const status = await repositoryStatus(sessionId, current.binding, project, controller.signal);
          if (disposed || controller.signal.aborted || seq !== generation) return; checkSource(sessionId, current);
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
      const repositoryChanged = repositories?.store.subscribe(() => {
        if (!state.sessionId || repositoryAllowed(state.sessionId)) return;
        query?.abort(); ++generation;
        if (state.mode === 'new') for (const lease of leases.values()) lease.cancelNew();
        publish({ loading: false, status: null, branches: null, remote: '', branch: '', ...(state.mode === 'new' ? { error: t('repoUnavailable') } : {}) });
      });
      function selectionChanged() {
        if (!selectedSource || state.sessionId !== selectedSource.sessionId || (state.mode === 'new' && state.sourceChanged)) return;
        const binding = ctx.sessions.binding(state.sessionId), project = captureProject(projects.context(state.sessionId));
        if (binding === selectedSource.binding && sameProject(project, selectedSource.project)) return;
        query?.abort(); ++generation;
        if (state.mode === 'new') for (const lease of leases.values()) lease.cancelNew();
        else selectedSource = { sessionId: state.sessionId, binding, project };
        publish({ loading: false, status: null, branches: null, query: '', remote: '', branch: '', ...(state.mode === 'new' ? { sourceChanged: true, error: t('projectChanged') } : {}) });
      }
      const projectChanged = projects.store.subscribe(selectionChanged);
      const unselect = ctx.sessions.list.subscribe(() => { for (const op of operations) if (!op.committing && projectActor(ctx.sessions.list.getSnapshot()) !== op.sessionId) op.controller.abort(); selectionChanged(); });
      const reconnect = ctx.connection.generation.subscribe(() => { query?.abort(); ++generation; for (const lease of leases.values()) lease.cancelNew(); publish({ loading: false, status: null, branches: null, branch: '', remote: '' }); });
      return { store, observe, select, configure, loadBranches, reconcile,
        cancel() { for (const lease of leases.values()) lease.cancelNew(); },
        setRemote(sessionId, remote) { if (!state.busy && !state.sourceChanged && state.sessionId === sessionId && repositoryAllowed(sessionId) && state.status?.remotes.some(item => item.name === remote)) { publish({ remote, query: '' }); void loadBranches(sessionId); } },
        setBranch(branch) { if (!state.busy && !state.sourceChanged && repositoryAllowed(state.sessionId) && state.branches?.items.some(item => item.name === branch)) publish({ branch }); },
        openTarget(sessionId) { const op = state.sessionId === sessionId && state.op; if (op?.result?.sessionId) ctx.uiWorkspace.openSession(op.result.sessionId); },
        async dispose() { disposed = true; query?.abort(); ++generation; repositoryChanged?.(); projectChanged(); unselect(); reconnect(); for (const op of operations) op.controller.abort(); await Promise.allSettled([...leases.values()].map(lease => lease.close())); for (const lease of leases.values()) lease.stopScope?.(); leases.clear(); selectedSource = undefined; },
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
    function syncProjectSpinner(element) {
      if (element === null) return;
      for (const animation of element.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0;
    }
    function Icon({ size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('path', { d: 'M6 5v14M6 9h6a6 6 0 0 0 6-6M6 15h6a6 6 0 0 1 6 6' }),
        ...[[6, 3], [6, 21], [18, 3], [18, 21]].map(([cx, cy]) => h('circle', { key: cx + '-' + cy, cx, cy, r: 2 })));
    }
    const Styles = () => h('style', null, css);
    const Button = React.forwardRef(({ children, ...props }, ref) => h('button', { type: 'button', ...props, ref }, children));
    function ProjectStateDot({ state }) {
      if (state !== 'ongoing') return h('span', { className: 'dsh-wt-state-dot', 'data-state': state, 'aria-hidden': true });
      return h('svg', { ref: syncProjectSpinner, className: 'dsh-wt-state-spinner', 'data-state': 'ongoing', width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('g', { className: 'dsh-wt-state-motion' }, h('circle', { className: 'dsh-wt-state-track', cx: 12, cy: 12, r: 9.5 }), h('circle', { className: 'dsh-wt-state-arc', cx: 12, cy: 12, r: 9.5 })));
    }
    // Native workspace-folder artwork copied locally; React is the only runtime import.
    function WorkspaceFolderIcon({ expanded = false, className }) {
      return h('svg', { width: 16, height: 16, className, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true }, expanded ? [
        h('path', { key: 'tint', d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z', fill: 'currentColor', opacity: 0.16 }),
        h('path', { key: 'front', d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z', fill: 'currentColor' }),
        h('path', { key: 'back', d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z', fill: 'currentColor' }),
      ] : [
        h('path', { key: 'outline', d: 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z', stroke: 'currentColor' }),
        h('path', { key: 'line', d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor' }),
      ]);
    }
    function SidebarToolbarIcon({ kind, size = 16 }) {
      const svg = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true };
      if (kind === 'search') return h('svg', svg, h('path', { d: 'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z', stroke: 'currentColor' }), h('path', { d: 'M10.2991 10.3933L14.7783 14.8725', stroke: 'currentColor' }));
      if (kind === 'add') return h('svg', svg, h('path', { d: 'M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z', fill: 'currentColor' }), h('path', { d: 'M9.75977 4.50208H14.5509', stroke: 'currentColor' }), h('path', { d: 'M12.1492 6.89758L12.1492 2.10642', stroke: 'currentColor' }));
      return h('svg', { ...svg, stroke: 'currentColor', strokeLinecap: 'round' }, h('path', { d: 'M2.3 5h5.85M12.05 5h1.65' }), h('circle', { cx: 9.95, cy: 5, r: 1.45 }), h('path', { d: 'M2.3 11h1.65M7.85 11h5.85' }), h('circle', { cx: 5.75, cy: 11, r: 1.45 }));
    }
    function FolderIcon({ plus = false, size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18' }), plus && h('path', { d: 'M12 11v6m-3-3h6' }));
    }
    function Dialog({ title, close, t, children, className = '', compact = false, dismissible = true, initialFocus, returnFocus, fallbackFocus, descriptionId }) {
      const ref = React.useRef(null), heading = React.useId();
      React.useEffect(() => {
        const dialog = ref.current; dialog.showModal(); initialFocus?.current?.focus();
        return () => { if (dialog.open) dialog.close(); if (returnFocus?.current?.isConnected) returnFocus.current.focus(); else fallbackFocus?.current?.focus(); };
      }, []);
      return h('dialog', { ref, className: 'dsh-wt dsh-wt-dialog ' + className, 'aria-labelledby': heading, 'aria-describedby': descriptionId, onCancel: event => { event.preventDefault(); event.stopPropagation(); if (dismissible) close(); } },
        h(Styles), h('div', { className: 'dsh-wt-row dsh-wt-between dsh-wt-dialog-heading' }, h('h2', { id: heading }, title), h(Button, { className: compact ? 'dsh-wt-dialog-close' : undefined, onClick: close, disabled: !dismissible, autoFocus: !compact, 'aria-label': t('close') }, compact ? '×' : t('close'))), children);
    }
    function FolderRows({ folders, remove, disabled, t }) {
      return h('ul', { className: 'dsh-wt-source-list', 'aria-label': t('selectedFolders') }, ...folders.map(folder => h('li', { key: folder }, h(FolderIcon),
        h('span', { className: 'dsh-wt-source-info' }, h('span', { title: folder }, projectFolderName(folder)), h('span', { className: 'dsh-wt-source-path', title: folder }, folder)),
        h(Button, { className: 'dsh-wt-source-remove', disabled, onClick: () => remove(folder), 'aria-label': t('remove') + ' ' + folder }, '×'))));
    }
    function FolderBrowser({ runtime: ctx, t, existing = [], picked, close }) {
      const [state, setState] = React.useState({ listing: null, busy: false, error: null });
      const [path, setPath] = React.useState(''), [name, setName] = React.useState(''), [selected, setSelected] = React.useState([]), [error, setError] = React.useState(''), [creating, setCreating] = React.useState(false);
      const scanner = React.useRef(null), alive = React.useRef(true), creation = React.useRef(false), selection = React.useRef([]), pathInput = React.useRef(null);
      React.useEffect(() => {
        alive.current = true;
        const owned = createFolderScanner(ctx.uiWorkspace, patch => { setState(previous => ({ ...previous, ...patch })); if (patch.listing) setPath(patch.listing.path); }); scanner.current = owned; void owned.scan();
        return () => { alive.current = false; owned.dispose(); if (scanner.current === owned) scanner.current = null; };
      }, [ctx]);
      const { listing, busy } = state, added = new Set(existing), capacity = 32 - existing.length;
      const dismiss = () => { if (!creation.current) close(); };
      function toggle(path) {
        try { const next = toggleProjectFolder(selection.current, path, capacity); selection.current = next; setSelected(next); setError(''); }
        catch (failure) { setError(report(t, failure)); }
      }
      function checkbox(path) {
        const present = added.has(path), checked = present || selected.includes(path);
        return h('label', { className: 'dsh-wt-picker-check', title: present ? t('alreadyAdded') : t('selectFolder') + ' ' + path }, h('input', { type: 'checkbox', checked, disabled: busy || creating || present || (!checked && selected.length >= capacity), 'aria-label': t('selectFolder') + ' ' + path, onChange: () => toggle(path) }));
      }
      async function create(event) {
        event.preventDefault(); if (creation.current || busy || !listing || !name.trim()) return;
        creation.current = true; setCreating(true); setError(''); const owned = scanner.current;
        try { const created = await ctx.uiWorkspace.createDirectory(listing.path, name.trim()); if (alive.current && scanner.current === owned) { setName(''); await owned.scan(created); } }
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
        (busy || creating) && h('p', { role: 'status' }, t('loading')), (error || state.error) && h('p', { role: 'alert', className: 'dsh-wt-error' }, error || report(t, state.error)),
        h('div', { className: 'dsh-wt-project-footer' }, h(Button, { className: 'dsh-wt-cancel', disabled: creating, onClick: dismiss }, t('cancel')), h(Button, { className: 'dsh-wt-confirm', disabled: busy || creating || !selected.length, onClick: () => picked([...selection.current]) }, t('add') + (selected.length ? ' · ' + selected.length : ''))));
    }
    function ConfirmProjectRemoval({ project, busy, error, t, close, confirm, returnFocus }) {
      const cancel = React.useRef(null), description = React.useId();
      return h(Dialog, { title: t('removeProject'), close, t, className: 'dsh-wt-project-dialog', compact: true, dismissible: !busy, initialFocus: cancel, returnFocus, descriptionId: description },
        h('p', null, t('removeProjectConfirm'), ' ', h('strong', null, project.title)),
        h('p', { id: description, className: 'dsh-wt-muted' }, t('removeProjectHelp')),
        error && h('p', { role: 'alert', className: 'dsh-wt-error' }, error),
        h('div', { className: 'dsh-wt-project-footer', 'aria-busy': busy }, h(Button, { ref: cancel, className: 'dsh-wt-cancel', disabled: busy, onClick: close }, t('cancel')), h(Button, { className: 'dsh-wt-danger', disabled: busy, onClick: confirm }, t(busy ? 'loading' : 'removeProject'))));
    }
    function ProjectEditor({ project, runtime: ctx, projects, t, close, returnFocus, fallbackFocus }) {
      const [title, setTitle] = React.useState(project?.title || ''), [folders, setFolders] = React.useState(project?.folders.map(folder => folder.path) || []), [path, setPath] = React.useState(''), [mainFolder, setMainFolder] = React.useState(projectMainFolder(project)?.path || '');
      const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [browser, setBrowser] = React.useState(false), [addMode, setAddMode] = React.useState('browse'), [confirmRemoval, setConfirmRemoval] = React.useState(false);
      const lifetime = React.useRef(true), currentFolders = React.useRef(folders), picker = React.useRef(false), browsing = React.useRef(false), confirming = React.useRef(false), submitter = React.useRef(null), heading = React.useId(), nameInput = React.useRef(null), removeTrigger = React.useRef(null);
      if (!submitter.current) submitter.current = createProjectSubmitter(projects, project?.id, project?.id || crypto.randomUUID());
      React.useEffect(() => { lifetime.current = true; return () => { lifetime.current = false; }; }, []);
      const dismiss = () => { if (!submitter.current.pending && !picker.current && !confirming.current) close(); };
      const primary = draftMainFolder(folders, mainFolder);
      function closeBrowser() { browsing.current = false; setBrowser(false); }
      function add(paths) {
        if (!lifetime.current || submitter.current.pending || confirming.current) return;
        try { const next = appendProjectFolders(currentFolders.current, paths); currentFolders.current = next; setFolders(next); setPath(''); closeBrowser(); setError(''); }
        catch (failure) { setError(report(t, failure)); }
      }
      function remove(path) { if (submitter.current.pending || picker.current || browsing.current || confirming.current) return; currentFolders.current = currentFolders.current.filter(value => value !== path); setFolders(currentFolders.current); if (mainFolder === path) setMainFolder(''); setError(''); }
      async function choose() {
        if (submitter.current.pending || picker.current || browsing.current || confirming.current || currentFolders.current.length >= 32) return;
        setError('');
        if (addMode === 'path') { add([path.trim()]); return; }
        if (addMode === 'browse') { browsing.current = true; setBrowser(true); return; }
        // The optional native chooser returns one folder or null, never a batch.
        picker.current = true; setBusy(true);
        try { const selected = await ctx.uiWorkspace.pickDirectory(); if (lifetime.current && selected) add([selected]); }
        catch (failure) { if (lifetime.current) setError(report(t, failure)); }
        finally { picker.current = false; if (lifetime.current) setBusy(false); }
      }
      async function save(event) {
        event.preventDefault(); if (submitter.current.pending || picker.current || browsing.current || confirming.current || !title.trim() || !currentFolders.current.length) return;
        if (!draftMainFolder(currentFolders.current, mainFolder)) { setError(t('mainFolderRequired')); return; }
        setBusy(true); setError('');
        try { await submitter.current.submit(title, currentFolders.current, mainFolder); if (lifetime.current) close(); }
        catch (failure) { if (lifetime.current) setError(report(t, failure)); }
        finally { if (lifetime.current) setBusy(false); }
      }
      function beginRemoval() {
        if (!project || submitter.current.pending || picker.current || browsing.current || confirming.current) return;
        confirming.current = true; setError(''); setConfirmRemoval(true);
      }
      function dismissRemoval() { if (!submitter.current.pending) { confirming.current = false; setConfirmRemoval(false); setError(''); } }
      async function removeProject() {
        if (!confirming.current || submitter.current.pending || picker.current || browsing.current) return;
        setBusy(true); setError('');
        try { await submitter.current.remove(); if (lifetime.current) close(); }
        catch (failure) { if (lifetime.current) setError(report(t, failure)); }
        finally { if (lifetime.current) setBusy(false); }
      }
      return h(Dialog, { title: t(project ? 'editProject' : 'createProject'), close: dismiss, t, className: 'dsh-wt-project-dialog', compact: true, dismissible: !busy, initialFocus: nameInput, returnFocus, fallbackFocus },
        h('form', { onSubmit: save, 'aria-busy': busy }, h('label', { className: 'dsh-wt-project-name' }, h(FolderIcon), h('input', { required: true, ref: nameInput, maxLength: 120, placeholder: t('projectName'), 'aria-label': t('projectName'), value: title, disabled: busy, onChange: event => setTitle(event.target.value) })),
          h('div', { className: 'dsh-wt-source-heading' }, h('span', { id: heading }, t('sourceFolders')), folders.length > 0 && h('span', { className: 'dsh-wt-source-count', 'aria-live': 'polite' }, folders.length + ' / 32')),
          h('section', { className: 'dsh-wt-source-card', 'aria-labelledby': heading, 'data-filled': !!folders.length }, folders.length > 0 && h(FolderRows, { folders, remove, disabled: busy, t }),
            h('div', { className: 'dsh-wt-source-add' }, h('select', { className: 'dsh-wt-source-select', 'aria-label': t('addFolder'), value: addMode, disabled: busy || folders.length >= 32, onChange: event => { setAddMode(event.target.value); setError(''); } }, h('option', { value: 'browse' }, t('localFolders')), h('option', { value: 'native' }, t('chooseDirectory')), h('option', { value: 'path' }, t('enterFolderPath'))),
              addMode === 'path' && h('label', { className: 'dsh-wt-project-path' }, h('input', { value: path, autoFocus: true, placeholder: t('absolutePath'), 'aria-label': t('absolutePath'), disabled: busy || folders.length >= 32, onChange: event => setPath(event.target.value), onKeyDown: event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); void choose(); } } })),
              h(Button, { className: 'dsh-wt-add-pill', disabled: busy || folders.length >= 32 || (addMode === 'path' && !absolutePath(path.trim())), onClick: () => { void choose(); } }, h(FolderIcon, { plus: true }), t('add')))),
          folders.length > 1 && h('label', { className: 'dsh-wt-main-folder' }, t('mainFolder'), h('select', { required: true, value: primary, disabled: busy, title: primary, onChange: event => { setMainFolder(event.target.value); setError(''); } }, h('option', { value: '', disabled: true }, t('chooseMainFolder')), ...folders.map(folder => h('option', { key: folder, value: folder }, projectFolderName(folder) + ' · ' + folder))), h('small', null, t('mainFolderHelp'))),
          error && !confirmRemoval && h('p', { role: 'alert', className: 'dsh-wt-error' }, error), h('div', { className: 'dsh-wt-project-footer' }, project && h(Button, { ref: removeTrigger, className: 'dsh-wt-remove-project', disabled: busy || browser || confirmRemoval, onClick: beginRemoval }, t('removeProject')), h(Button, { className: 'dsh-wt-cancel', disabled: busy, onClick: dismiss }, t('cancel')), h('button', { className: 'dsh-wt-confirm', type: 'submit', disabled: busy || !title.trim() || !folders.length || !primary }, t(busy ? 'loading' : project ? 'save' : 'createProject')))),
        browser && h(FolderBrowser, { runtime: ctx, t, existing: folders, picked: add, close: closeBrowser }),
        confirmRemoval && project && h(ConfirmProjectRemoval, { project, busy, error, t, close: dismissRemoval, confirm: removeProject, returnFocus: removeTrigger }));
    }
    function ThreadRow({ row, selected, runtime: ctx, metadata, renderSlot, t, now }) {
      const [menu, setMenu] = React.useState(false), [hover, setHover] = React.useState(false);
      const activity = row.session.blank ? null : projectSessionTime(row.session.updatedAt, now, t);
      const worktree = (row.backing?.mode || row.context?.binding.mode) === 'worktree';
      const record = worktree ? row.backing?.record || metadata.records.find(item => item.id === row.context?.binding.worktreeId) : undefined;
      const path = row.backing?.effectiveCwd || row.context?.binding.effectiveCwd || row.context?.folder.path || '';
      const title = row.session.blank ? t('blankThread') : row.title || t('untitled');
      const marker = (worktree ? t('worktreeThread') : t('localThread')) + (row.context ? ' · ' + row.context.folder.path : '') + (record?.branch ? ' · ' + record.branch : '') + (worktree ? ' · ' + path : '');
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
        hover && h('div', { className: 'dsh-wt-thread-hover' }, h('div', null, title), h('div', { className: 'dsh-wt-muted' }, status), worktree && record?.branch && h('div', null, h('code', null, record.branch)), h('code', null, path), renderSlot(projectSlotName('sidebar.session.row.hover'), { sessionId: row.id })),
        menu && h(Dialog, { title: t('threadActions'), t, close: () => setMenu(false) }, h('div', { role: 'menu', className: 'dsh-wt-project-menu', onKeyDown: event => { if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return; const items = [...event.currentTarget.querySelectorAll('[role=menuitem]:not(:disabled)')]; if (!items.length) return; event.preventDefault(); const at = items.indexOf(event.target); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); } }, renderSlot(projectSlotName('sidebar.workspaces.session.menu.item'), owner, { hookContext: [menu, setMenu] }))));
    }
    function ProjectGroup({ group, selectedId, runtime, metadata, renderSlot, t, searching, onManage, now }) {
      const [collapsed, setCollapsed] = React.useState(false), [limit, setLimit] = React.useState(5), [choosingFolder, setChoosingFolder] = React.useState(false);
      const rows = searching ? group.rows : visibleProjectRows(group.rows, limit, selectedId), main = projectMainFolder(group.project), remaining = group.rows.length - rows.length;
      const hasOverflow = group.rows.length > visibleProjectRows(group.rows, 5, selectedId).length;
      function start(folderId) { setChoosingFolder(false); runtime.uiWorkspace.startSession(folderId); }
      return h('section', { className: 'dsh-wt-project-group' }, h('div', { className: 'dsh-wt-project-head' }, h(Button, { title: group.project?.folders.map(folder => folder.path).join('\n'), 'aria-expanded': searching || !collapsed, onClick: () => { setCollapsed(value => !value); setLimit(5); }, 'aria-label': t(collapsed ? 'expand' : 'collapse') + ' ' + (group.project?.title || t('unassigned')) },
        h('span', { className: 'dsh-wt-project-glyph', 'aria-hidden': true }, h(WorkspaceFolderIcon, { expanded: searching || !collapsed, className: 'dsh-wt-project-folder' }), h('span', { className: 'dsh-wt-project-chevron' }, collapsed && !searching ? '▸' : '▾')), h('span', { className: 'dsh-wt-project-title' }, group.project?.title || t('unassigned'))),
        group.project && h('span', { className: 'dsh-wt-project-head-actions' }, h(Button, { 'aria-label': t('newThread') + ' ' + group.project.title, title: t('newThread') + (main ? ' · ' + main.path : ''), disabled: !main, onClick: () => main && start(main.id) }, '+'), group.project.folders.length > 1 && h(Button, { 'aria-label': t('chooseFolder') + ' ' + group.project.title, title: t('chooseFolder'), 'aria-expanded': choosingFolder, onClick: () => setChoosingFolder(value => !value) }, '▾'), h(Button, { 'aria-label': t('editProject') + ' ' + group.project.title, title: t('editProject'), onClick: event => onManage(group.project, event.currentTarget) }, '…'))),
        choosingFolder && group.project && h('div', { className: 'dsh-wt-row', 'aria-label': t('chooseFolder') }, ...group.project.folders.map(folder => h(Button, { key: folder.id, title: folder.path, onClick: () => start(folder.id) }, folder.title + (folder.id === main?.id ? ' · ' + t('main') : '')))),
        (searching || !collapsed) && h('div', { role: 'group' }, ...rows.map(row => h(ThreadRow, { key: row.id, row, selected: row.id === selectedId, runtime, metadata, renderSlot, t, now })),
          !searching && hasOverflow && h(Button, { className: 'dsh-wt-session-overflow', 'aria-expanded': remaining === 0, onClick: () => setLimit(value => remaining === 0 ? 5 : remaining <= 5 ? Infinity : value + 5) }, remaining ? t('showMore', { n: remaining }) : t('showLess'))));
    }
    function SidebarToggle({ sidebarMode, wide, t }) {
      const native = React.useSyncExternalStore(sidebarMode.store.subscribe, sidebarMode.store.getSnapshot);
      return h('span', { className: 'dsh-wt' }, h(Styles), h(Button, { title: t(native ? 'projects' : 'folderView'), 'aria-label': t(native ? 'projects' : 'folderView'), 'aria-pressed': !native, onClick: sidebarMode.toggle }, h(WorkspaceFolderIcon), wide && ' ' + t(native ? 'projects' : 'folderView')));
    }
    function ProjectSidebarToolbar({ query, onQuery, archived, onArchived, onCreate, newProjectTrigger, t }) {
      const [searchOpen, setSearchOpen] = React.useState(!!query), [optionsOpen, setOptionsOpen] = React.useState(false);
      const input = React.useRef(null), searchTrigger = React.useRef(null), optionsTrigger = React.useRef(null), searchId = React.useId(), menuId = React.useId();
      React.useEffect(() => { if (searchOpen) input.current?.focus(); }, [searchOpen]);
      function closeSearch() { onQuery(''); setSearchOpen(false); searchTrigger.current?.focus(); }
      function closeOptions() { setOptionsOpen(false); optionsTrigger.current?.focus(); }
      function menuKey(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeOptions(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = [...event.currentTarget.querySelectorAll('[role=menuitemradio]')], index = items.indexOf(event.target); if (!items.length) return;
        event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
      return h('div', { className: 'dsh-wt-projects-header dsh-wt-project-toolbar' },
        !searchOpen && h('span', { className: 'dsh-wt-project-section-label' }, t('projects')),
        searchOpen && h('div', { className: 'dsh-wt-project-search' }, h('input', { id: searchId, ref: input, type: 'search', maxLength: 256, className: 'dsh-wt-project-search-input', value: query, placeholder: t('filterThreads'), 'aria-label': t('filterThreads'), onChange: event => onQuery(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); } } }), h(Button, { className: 'dsh-wt-toolbar-icon', 'aria-label': t('closeSearch'), title: t('closeSearch'), onClick: closeSearch }, '×')),
        h(Button, { ref: searchTrigger, className: 'dsh-wt-toolbar-icon', 'aria-label': t('searchProjects'), title: t('searchProjects'), 'aria-expanded': searchOpen, 'aria-controls': searchOpen ? searchId : undefined, onClick: () => { setOptionsOpen(false); if (searchOpen) closeSearch(); else setSearchOpen(true); } }, h(SidebarToolbarIcon, { kind: 'search', size: 14 })),
        h('div', { className: 'dsh-wt-view-options', onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setOptionsOpen(false); } },
          h(Button, { ref: optionsTrigger, className: 'dsh-wt-toolbar-icon', 'aria-label': t('viewOptions'), title: t('viewOptions'), 'aria-haspopup': 'menu', 'aria-expanded': optionsOpen, 'aria-controls': optionsOpen ? menuId : undefined, 'data-active': archived !== 'hide', onClick: () => setOptionsOpen(value => !value), onKeyDown: event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOptionsOpen(true); } else if (event.key === 'Escape') { event.preventDefault(); closeOptions(); } } }, h(SidebarToolbarIcon, { kind: 'options' })),
          optionsOpen && h('div', { id: menuId, role: 'menu', 'aria-label': t('viewOptions'), className: 'dsh-wt-view-menu', onKeyDown: menuKey }, ...[['hide', 'hideArchived'], ['all', 'allThreads'], ['only', 'archivedOnly']].map(([value, label]) => h(Button, { key: value, role: 'menuitemradio', 'aria-checked': archived === value, autoFocus: archived === value, onClick: () => { onArchived(value); closeOptions(); } }, h('span', { 'aria-hidden': true, className: 'dsh-wt-view-check' }, archived === value ? '✓' : ''), t(label))))),
        h(Button, { ref: newProjectTrigger, className: 'dsh-wt-toolbar-icon', 'aria-label': t('newProject'), title: t('newProject'), onClick: event => { setOptionsOpen(false); onCreate(event); } }, h(SidebarToolbarIcon, { kind: 'add' })));
    }
    function ProjectsSidebar({ runtime: ctx, projects, t, wide, expandSidebar, useWorkspaces, useSessions, usePanelInfo, useSessionStatus, renderSlot }) {
      const workspaces = useWorkspaces(value => value), sessions = useSessions(value => value), panel = usePanelInfo(value => value.activePanelId), statuses = useSessionStatus(value => value);
      const metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot);
      const [query, setQuery] = React.useState(''), [archived, setArchived] = React.useState('hide'), [editor, setEditor] = React.useState(null);
      const editorTrigger = React.useRef(null), newProjectTrigger = React.useRef(null);
      const selectedId = panel ? undefined : Object.keys(sessions.byId).find(id => (sessions.byId[id].retainedBy?.mainView || 0) > 0);
      const groups = projectRows(metadata, workspaces, sessions, statuses, { query, archived, selectedId }), now = Date.now();
      // Own the editor snapshot here: refresh/removal of a row must not discard refused edits.
      function openEditor(project, trigger) { editorTrigger.current = trigger; setEditor({ project }); }
      if (!wide) return h('div', { className: 'dsh-wt dsh-wt-projects' }, h(Styles), h(Button, { title: t('projects'), 'aria-label': t('projects'), onClick: expandSidebar }, h(WorkspaceFolderIcon)));
      return h('section', { className: 'dsh-wt dsh-wt-projects', 'aria-label': t('projects') }, h(Styles),
        h(ProjectSidebarToolbar, { query, onQuery: setQuery, archived, onArchived: setArchived, newProjectTrigger, onCreate: event => openEditor(null, event.currentTarget), t }),
        metadata.loading && h('span', { role: 'status', className: 'dsh-wt-muted' }, t('loading')), metadata.error && h('div', null, h('p', { role: 'alert', className: 'dsh-wt-error' }, metadata.error), h(Button, { onClick: () => { void projects.refresh(); } }, t('refresh'))),
        h('div', { className: 'dsh-wt-project-list', role: 'tree', 'aria-label': t('projects') }, ...groups.map(group => h(ProjectGroup, { key: group.project?.id || 'unassigned', group, selectedId, runtime: ctx, metadata, renderSlot, t, searching: !!query.trim(), onManage: openEditor, now }))),
        !metadata.projects.length && !metadata.loading && h('p', { className: 'dsh-wt-muted' }, t('noProjects')), editor && h(ProjectEditor, { key: editor.project?.id || 'new-project', project: editor.project, projects, runtime: ctx, t, close: () => setEditor(null), returnFocus: editorTrigger, fallbackFocus: newProjectTrigger }));
    }
    function NewWorktreeControls({ sessionId, flow, projects, repositories, runtime: ctx, t, useSession, useInput, usePanelInfo, useWorkspaces }) {
      const snapshot = useSession(value => value), empty = useInput(inputEmpty), ready = sourceEligible(snapshot), panel = usePanelInfo(value => value.activePanelId), workspaces = useWorkspaces(value => value);
      const state = React.useSyncExternalStore(flow.store.subscribe, flow.store.getSnapshot);
      React.useSyncExternalStore(repositories.store.subscribe, repositories.store.getSnapshot);
      const metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot), context = projects.context(sessionId);
      const [options, setOptions] = React.useState(false), [folderError, setFolderError] = React.useState('');
      React.useEffect(() => { setOptions(false); if (panel || !snapshot.blank || snapshot.subagent !== null) return; try { flow.observe(sessionId); } catch { /* New mode reports the guarded ABI refusal. */ } void repositories.ensure(sessionId); return () => repositories.withdraw(sessionId); }, [flow, repositories, sessionId, ready, panel, snapshot.blank, snapshot.subagent, snapshot.openState, snapshot.removed, context?.project.id, context?.folder.id, context?.folder.path]);
      if (panel || !snapshot.blank || snapshot.subagent !== null) return null;
      const backing = projectBacking(metadata, workspaces, sessionId), worktree = backing.mode === 'worktree', record = backing.record;
      const selected = state.sessionId === sessionId, busy = selected && state.busy, main = projectMainFolder(context?.project), canWorktree = repositories.enabled(sessionId), blockedNew = selected && state.mode === 'new' && (!canWorktree || state.sourceChanged);
      return h('div', { className: 'dsh-wt dsh-wt-row dsh-wt-create-controls' }, h(Styles),
        context?.project.folders.length > 1 && h('select', { className: 'dsh-wt-conversation-folder', 'aria-label': t('conversationFolder'), value: context.folder.id, disabled: busy || !empty || !sourceEligible(snapshot), title: !empty ? t('draftWarning') : context.folder.path,
          onChange: event => { setFolderError(''); try { chooseConversationFolder(ctx, projects, flow, sessionId, event.target.value); } catch (failure) { setFolderError(report(t, failure)); } } }, ...context.project.folders.map(folder => h('option', { key: folder.id, value: folder.id, title: folder.path }, folder.title + (folder.id === main?.id ? ' · ' + t('main') : '')))),
        folderError && h('span', { className: 'dsh-wt-create-error', role: 'alert' }, folderError),
        !blockedNew && (canWorktree || worktree) ? h('select', { 'aria-label': t('threadMode'), value: canWorktree && selected && state.mode === 'new' ? 'new' : worktree ? 'worktree' : 'local', disabled: busy || !sourceEligible(snapshot),
          onChange: event => { setOptions(false); flow.select(sessionId, event.target.value); } },
          h('option', { value: 'local', disabled: worktree && !context?.folder }, t('local')),
          worktree && h('option', { value: 'worktree' }, t('worktreeThread')),
          canWorktree && h('option', { value: 'new' }, t('new'))) : h(Button, { 'aria-label': t(worktree && !context ? 'keepCurrentFolder' : 'local'), 'aria-pressed': !selected || state.mode === 'local', disabled: busy || !sourceEligible(snapshot), onClick: () => flow.select(sessionId, 'local') }, t(worktree && !context ? 'keepCurrentFolder' : 'local')),
        worktree && h('span', { className: 'dsh-wt-muted', title: backing.effectiveCwd }, record?.branch || t('worktreeThread')),
        !blockedNew && canWorktree && !worktree && h(Button, { disabled: busy || !sourceEligible(snapshot), 'aria-expanded': options, 'aria-label': t('branch'), onClick: () => { setOptions(value => !value); if (!options) void flow.configure(sessionId); } }, selected && state.branch ? state.remote + '/' + state.branch : t('select')),
        !blockedNew && canWorktree && !worktree && options && h('fieldset', { className: 'dsh-wt-base-options', onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setOptions(false); } } }, h('legend', null, t('branch')),
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
    function Header({ projects, sessionId, t, useSession, useWorkspaces }) {
      const blank = useSession(value => value.blank), workspaces = useWorkspaces(value => value);
      const metadata = React.useSyncExternalStore(projects.store.subscribe, projects.store.getSnapshot), context = projects.context(sessionId), backing = projectBacking(metadata, workspaces, sessionId);
      if (blank || (!context && backing.mode !== 'worktree')) return null;
      const worktree = backing.mode === 'worktree', record = backing.record;
      const label = [context?.project.title, t(worktree ? 'worktreeThread' : 'local'), record?.branch].filter(Boolean).join(' · ');
      return h('span', { className: 'dsh-wt dsh-wt-muted', title: backing.effectiveCwd }, h(Styles), label);
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
      protocol: Object.freeze({ createRepositoryAvailability, projectMainFolder, draftMainFolder, chooseConversationFolder, rootFolderValue, writeRootFolder, decodeReply, validateData, currentActor, sourceEligible, inputEmpty, captureDraft, draftUnchanged, advertisedDefault, acquireBlock, NATIVE_SUBMIT_ABI, interrupted, leaseNativeSink, setupProgress, prepareWorktree, waitForDraftFiles, createWorktreeFlow, requestHost, absolutePath, projectRequest, projectData, requestProjects, workspaceStructure, projectContext, captureProject, sameProject, projectPath, projectRows, visibleProjectRows, projectActor, projectReady, createProjectStore, projectSlotName, projectChildren, mirrorProjectSlot, createSidebarMode }),
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }));
        const projects = createProjectStore(ctx, ctx.locale.bind(NS));
        ctx.effect(() => () => projects.dispose());
        const repositories = createRepositoryAvailability(ctx, projects);
        ctx.effect(() => () => repositories.dispose());
        const flow = createWorktreeFlow(ctx, ctx.locale.bind(NS), projects, repositories);
        ctx.effect(() => () => flow.dispose());
        let sidebarMode;
        const seat = (owner, options, component) => ctx.slots.inject(owner, () => ctx.slots.register({ ...options, locale: NS, inject: () => ({ runtime: ctx, flow, projects, repositories, sidebarMode }) }, component));
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
