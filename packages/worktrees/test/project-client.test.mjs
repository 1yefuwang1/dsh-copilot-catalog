import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
// Execute real protocol/coordinator helpers only. There is no React stub,
// DOM, renderer, app double, or screenshot substitute in these tests.
const start = source.indexOf('    class WorktreeError extends Error');
const end = source.indexOf('    function Icon(', start);
const helpers = vm.runInNewContext(`(() => { const NS = 'worktrees.ui', PANEL = 'dsh-worktrees'; ${source.slice(start, end)}; return {
  absolutePath, projectRequest, projectData, requestProjects, workspaceStructure,
  projectContext, captureProject, sameProject, projectPath, projectActor, projectRows,
  visibleProjectRows, createProjectStore, projectSlotName, projectChildren,
  projectSlots, mirrorProjectSlot, createSidebarMode,
  appendProjectFolders, toggleProjectFolder, projectFolderName, createFolderScanner, createProjectSubmitter,
  projectMainFolder, draftMainFolder, chooseConversationFolder,
}; })()`, { AbortController, crypto: webcrypto });
const success = data => ({ ok: true, value: { v: 1, ok: true, data } });
const projectId = '12345678-1234-4234-8234-123456789abc';
const operationId = 'abcdefab-1234-4234-8234-123456789abc';
const project = { id: projectId, title: 'sreagent-workspace', folders: [{ id: 'folder-a', path: '/repo/services/api', title: 'API' }, { id: 'folder-b', path: '/repo/web', title: 'Web' }], createdAt: Date.UTC(2026, 9, 9), updatedAt: Date.UTC(2026, 9, 9) };
const local = { sessionId: 'local', projectId, folderId: 'folder-a', mode: 'local', effectiveCwd: '/repo/services/api' };
const tree = { sessionId: 'tree', projectId, folderId: 'folder-a', mode: 'worktree', effectiveCwd: '/trees/agent-identity/services/api', worktreeId: 'fedcbafe-1234-4234-8234-123456789abc' };
const metadata = { projects: [project], bindings: [local, tree] };
const workspaces = { items: [{ workspaceId: 'folder-a', path: '/repo/services/api', title: 'API', sessionIds: ['local', 'fork', 'fresh'] }, { workspaceId: 'tree-folder', path: tree.effectiveCwd, title: 'agent-identity', sessionIds: ['tree'] }], phase: 'ready', archivedSessionIds: [], pinnedSessionIds: [], state: 'idle' };
const blank = { blank: true, subagent: null, openState: 'open', removed: false, running: false, promptAttempted: false, awaitingFirstTurn: false, pendingSubmissions: [] };
const empty = { phase: 'plain', draft: '', draftRev: 0, attachmentIds: [], queue: [] };
const copy = value => structuredClone(value);
function observable(initial) {
  let value = initial; const listeners = new Set();
  return { getSnapshot: () => value, subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); }, publish(next) { value = next; for (const callback of [...listeners]) callback(); }, listeners };
}
async function settle() { for (let i = 0; i < 20; ++i) await Promise.resolve(); }
function invalid(fn) { assert.throws(fn, error => error.kind === 'decode'); }

test('main-folder DTO validation and legacy fallback keep current conversation ownership separate', () => {
  const selected = { ...project, mainFolderId: 'folder-b' }, data = { ...metadata, projects: [selected] };
  assert.equal(helpers.projectData({ action: 'list' }, data), data);
  assert.equal(helpers.projectMainFolder(selected).id, 'folder-b'); assert.equal(helpers.projectMainFolder(project).id, 'folder-a');
  assert.equal(helpers.projectMainFolder({ ...selected, folders: [...selected.folders].reverse() }).id, 'folder-b');
  assert.equal(helpers.projectContext(data, workspaces, 'local').folder.id, 'folder-a');
  assert.equal(helpers.sameProject(helpers.captureProject(helpers.projectContext(metadata, workspaces, 'local')), helpers.captureProject(helpers.projectContext(data, workspaces, 'local'))), true, 'changing defaults does not retarget a frozen worktree source');
  for (const mainFolderId of [null, '', 'outside', 1, []]) invalid(() => helpers.projectData({ action: 'list' }, { ...data, projects: [{ ...selected, mainFolderId }] }));
  assert.equal(helpers.projectMainFolder({ ...selected, mainFolderId: 'outside' }), undefined);
});

test('new multi-folder drafts require an explicit main choice; sole folders automatically supply it', async () => {
  const calls = [], submitter = helpers.createProjectSubmitter({ async mutate(request) { calls.push(request); return { project }; } }, undefined, operationId);
  assert.equal(helpers.draftMainFolder([], ''), ''); assert.equal(helpers.draftMainFolder(['/repo/a'], ''), '/repo/a');
  assert.equal(helpers.draftMainFolder(['/repo/a', '/repo/b'], ''), '');
  assert.equal(helpers.draftMainFolder(['/repo/a', '/repo/b'], '/repo/b'), '/repo/b');
  assert.equal(helpers.draftMainFolder(['/repo/a', '/repo/c'], '/repo/b'), '', 'removing the main requires a replacement when multiple folders remain');
  for (const main of [undefined, '', '/outside']) assert.throws(() => submitter.submit('Example', ['/repo/a', '/repo/b'], main), error => error.kind === 'mainFolderRequired');
  assert.equal(submitter.pending, false); assert.equal(calls.length, 0);
  await submitter.submit('Example', ['/repo/a', '/repo/b'], '/repo/b'); assert.equal(calls[0].mainFolder, '/repo/b');
  await submitter.submit('Example', ['/repo/sole']); assert.equal(calls[1].mainFolder, '/repo/sole');
});

test('project protocol supports main-only updates and default starts without accepting dangling or malformed main paths', () => {
  for (const request of [{ action: 'create', id: projectId, title: 'Example', folders: ['/repo/a', '/repo/b'], mainFolder: '/repo/b' }, { action: 'update', projectId, mainFolder: '/repo/b' }, { action: 'start', projectId, operationId }]) assert.equal(helpers.projectRequest(request), request);
  for (const mainFolder of [null, '', 'relative', '/repo\0bad', '/repo\ninvalid', '/' + 'x'.repeat(4096)]) invalid(() => helpers.projectRequest({ action: 'update', projectId, mainFolder }));
  const request = { action: 'start', projectId, operationId }, data = { sessionId: 'fresh', workspaceId: 'folder-b', binding: { ...local, sessionId: 'fresh', folderId: 'folder-b', effectiveCwd: '/repo/web' } };
  assert.equal(helpers.projectData(request, data), data);
  invalid(() => helpers.projectData(request, { ...data, workspaceId: 'folder-a' }));
  invalid(() => helpers.projectData({ ...request, folderId: 'folder-a' }, data));
});

test('main-folder metadata edits refresh defaults without rebinding existing local/worktree conversations', async () => {
  const run = projectRuntime(); await run.ready();
  const before = run.store.context('local');
  await run.store.mutate({ action: 'update', projectId, mainFolder: '/repo/web' });
  assert.equal(helpers.projectMainFolder(run.store.store.getSnapshot().projects.find(value => value.id === projectId)).id, 'folder-b');
  assert.deepEqual(copy(run.store.context('local').binding), copy(before.binding));
  assert.equal(run.store.context('tree').binding.effectiveCwd, tree.effectiveCwd);
  assert.equal(run.selected.length, 0); assert.equal(run.opened.length, 0); run.dispose();
});

test('empty new-conversation folder overrides use the native flow and do not change the project main', async () => {
  const run = projectRuntime(); await run.ready(); const flow = { store: observable({ sessionId: 'local', busy: false }) };
  assert.equal(helpers.chooseConversationFolder(run.ctx, run.store, flow, 'local', 'folder-a'), false);
  assert.equal(helpers.chooseConversationFolder(run.ctx, run.store, flow, 'local', 'folder-b'), true);
  assert.deepEqual(run.selected, ['folder-b']); assert.equal(helpers.projectMainFolder(run.store.store.getSnapshot().projects[0]).id, 'folder-a');
  assert.equal(run.srcInput.getSnapshot().draft, ''); assert.deepEqual(run.srcInput.getSnapshot().attachmentIds, []);
  assert.equal(run.calls.filter(call => call.request.action !== 'list').length, 0, 'selecting a folder sends no prompt/Git/project mutation');
  assert.throws(() => helpers.chooseConversationFolder(run.ctx, run.store, flow, 'local', 'alien-folder'), error => error.kind === 'decode'); run.dispose();
});

test('folder overrides fail closed for text, chips, queued work, nonblank/retired/foreign sources and active worktree setup', async () => {
  const run = projectRuntime(); await run.ready(); const flow = { store: observable({ sessionId: 'local', busy: false }) };
  const refused = () => assert.throws(() => helpers.chooseConversationFolder(run.ctx, run.store, flow, 'local', 'folder-b'), error => error.kind === 'draftWarning');
  for (const input of [{ ...empty, draft: 'keep me' }, { ...empty, attachmentIds: ['file'] }, { ...empty, queue: [{}] }, { ...empty, phase: 'confirm' }]) { run.srcInput.publish(input); refused(); assert.equal(run.srcInput.getSnapshot(), input); }
  run.srcInput.publish(copy(empty));
  const source = run.ctx.sessions.binding('local').session;
  for (const snapshot of [{ ...blank, blank: false }, { ...blank, running: true }, { ...blank, openState: 'closed' }, { ...blank, removed: true }]) { source.publish(snapshot); refused(); }
  source.publish(copy(blank)); flow.store.publish({ sessionId: 'local', busy: true }); refused();
  flow.store.publish({ sessionId: 'local', busy: false }); run.list.publish({ byId: { other: { retainedBy: { mainView: 1 } } } }); refused();
  assert.deepEqual(run.selected, []); run.dispose();
});

test('project folder batches support repeated Add, remove and re-add without replacing existing folders', () => {
  const original = ['/repo/api'];
  const first = helpers.appendProjectFolders(original, ['/repo/web', '/repo/api', '/repo/docs']);
  assert.deepEqual(Array.from(first), ['/repo/api', '/repo/web', '/repo/docs']);
  assert.deepEqual(original, ['/repo/api'], 'merging never mutates the editor input');
  const removed = helpers.toggleProjectFolder(first, '/repo/web');
  assert.deepEqual(Array.from(helpers.appendProjectFolders(removed, ['/repo/web', '/repo/jobs'])), ['/repo/api', '/repo/docs', '/repo/web', '/repo/jobs']);
  assert.deepEqual(Array.from(first), ['/repo/api', '/repo/web', '/repo/docs']);
});

test('batch deduplication precedes the 32-folder bound and overflow is atomic, never silently truncated', () => {
  const full = Array.from({ length: 32 }, (_, i) => '/repo/' + i);
  assert.deepEqual(Array.from(helpers.appendProjectFolders(full, full)), full);
  assert.deepEqual(Array.from(helpers.appendProjectFolders(full.slice(0, 31), [full[0], full[31], full[31]])), full);
  assert.throws(() => helpers.appendProjectFolders(full.slice(0, 31), ['/repo/new-a', '/repo/new-b']), error => error.kind === 'folderLimit');
  assert.equal(full.length, 32);
  assert.throws(() => helpers.toggleProjectFolder(['/repo/a'], '/repo/b', 1), error => error.kind === 'folderLimit');
  assert.deepEqual(Array.from(helpers.toggleProjectFolder(['/repo/a'], '/repo/a', 0)), []);
  for (const path of ['relative', '/repo\0bad', '/repo\ninvalid', '/repo\tinvalid', '/repo\u007finvalid', '/' + 'x'.repeat(4096)]) assert.throws(() => helpers.appendProjectFolders([], [path]), error => error.kind === 'invalidFolder');
  assert.deepEqual(Array.from(helpers.appendProjectFolders([], ['/repo', '/repo/../repo', '/link-to-repo'])), ['/repo', '/repo/../repo', '/link-to-repo'], 'canonical aliases are not guessed by the Client; the Host remains authoritative');
});

test('folder row names handle POSIX, drive and UNC paths while retaining truthful full paths', () => {
  for (const [path, name] of [['/repo/api/', 'api'], ['/', '/'], ['C:\\repo\\web', 'web'], ['\\\\server\\share\\docs', 'docs'], ['/repo/a\\b', 'a\\b']]) assert.equal(helpers.projectFolderName(path), name);
});

test('browser selection survives navigation and is only merged on Add; cancelling leaves editor folders unchanged', async () => {
  const editor = ['/repo/existing']; let selected = [], state = {};
  const scanner = helpers.createFolderScanner({ async listDirectory(path) { return { path, entries: [] }; } }, patch => { state = { ...state, ...patch }; });
  await scanner.scan('/repo'); selected = helpers.toggleProjectFolder(selected, '/repo/api', 31);
  await scanner.scan('/another'); selected = helpers.toggleProjectFolder(selected, '/another/web', 31);
  assert.equal(state.listing.path, '/another');
  assert.deepEqual(Array.from(selected), ['/repo/api', '/another/web']);
  assert.deepEqual(Array.from(helpers.appendProjectFolders(editor, selected)), ['/repo/existing', '/repo/api', '/another/web']);
  scanner.dispose(); selected = [];
  assert.deepEqual(editor, ['/repo/existing'], 'discarding browser staging performs no project mutation');
});

test('folder scans cancel superseded reads and ignore stale settlements and disposed callbacks', async () => {
  const pending = [], patches = [];
  const scanner = helpers.createFolderScanner({ listDirectory(path, signal) { return new Promise((resolve, reject) => pending.push({ path, signal, resolve, reject })); } }, patch => patches.push(patch));
  const old = scanner.scan('/old'), current = scanner.scan('/current');
  assert.equal(pending[0].signal.aborted, true); assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve({ path: '/current', entries: [] }); await current;
  const settled = patches.length;
  pending[0].resolve({ path: '/old', entries: [] }); await old;
  assert.equal(patches.length, settled); assert.equal(patches.findLast(patch => patch.listing).listing.path, '/current');
  const last = scanner.scan('/last'); scanner.dispose(); const disposed = patches.length;
  assert.equal(pending[2].signal.aborted, true); pending[2].reject(new Error('late failure')); await last;
  await scanner.scan('/never'); assert.equal(patches.length, disposed); assert.equal(pending.length, 3);
});

test('folder scan failures finish loading explicitly and permit an owned retry', async () => {
  const failure = new Error('listing refused'); let attempts = 0, state = {};
  const scanner = helpers.createFolderScanner({ async listDirectory(path) { if (++attempts === 1) throw failure; return { path, entries: [] }; } }, patch => { state = { ...state, ...patch }; });
  await scanner.scan('/repo'); assert.equal(state.error, failure); assert.equal(state.busy, false);
  await scanner.scan('/repo'); assert.equal(state.error, null); assert.equal(state.listing.path, '/repo'); assert.equal(state.busy, false); scanner.dispose();
});

test('project submission uses a synchronous single flight and freezes the complete multi-folder request', async () => {
  const calls = []; let finish;
  const submitter = helpers.createProjectSubmitter({ mutate(request) { calls.push(request); return new Promise(resolve => { finish = resolve; }); } }, undefined, operationId);
  const folders = ['/repo/api', '/repo/web'];
  const first = submitter.submit(' Example project ', folders, '/repo/web'), second = submitter.submit('Changed while pending', ['/wrong']);
  assert.equal(first, second); assert.equal(submitter.pending, true);
  folders.push('/late-editor-change'); await settle(); assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'create'); assert.equal(calls[0].id, operationId); assert.equal(calls[0].title, 'Example project'); assert.equal(calls[0].mainFolder, '/repo/web');
  assert.deepEqual(Array.from(calls[0].folders), ['/repo/api', '/repo/web']); assert.ok(Object.isFrozen(calls[0]) && Object.isFrozen(calls[0].folders));
  finish({ project }); await first; assert.equal(submitter.pending, false);
});

test('failed project submissions preserve their UUID and draft, and editing sends the full replacement folder array', async () => {
  const calls = [], failure = new Error('Host refused save'); let attempts = 0;
  const submitter = helpers.createProjectSubmitter({ async mutate(request) { calls.push(request); if (++attempts === 1) throw failure; return { project }; } }, undefined, operationId);
  const folders = ['/repo/api', '/repo/web'];
  await assert.rejects(submitter.submit('Example', folders, '/repo/web'), error => error === failure); assert.equal(submitter.pending, false);
  await submitter.submit('Example', folders, '/repo/web'); assert.equal(calls[0].id, calls[1].id); assert.deepEqual(folders, ['/repo/api', '/repo/web']);
  const update = helpers.createProjectSubmitter({ async mutate(request) { calls.push(request); return { project }; } }, projectId, projectId);
  await update.submit('Renamed', folders, '/repo/web'); assert.equal(calls[2].action, 'update'); assert.equal(calls[2].projectId, projectId); assert.ok(!Object.hasOwn(calls[2], 'id'));
  assert.deepEqual(Array.from(calls[2].folders), folders);
  invalid(() => update.submit(' ', folders, '/repo/web')); invalid(() => update.submit('Example', [])); assert.equal(calls.length, 3);
});

test('strict project requests validate ids, absolute folders, bounds and action-specific keys', () => {
  const requests = [{ action: 'list' }, { action: 'list', projectId }, { action: 'create', id: projectId, title: project.title, folders: ['/repo'] }, { action: 'update', projectId, folders: ['/repo', 'C:\\repo'] }, { action: 'update', projectId, title: 'Renamed' }, { action: 'bind', projectId, folderId: 'folder-a', sessionId: 'local' }, { action: 'start', operationId, projectId, folderId: 'folder-a' }];
  for (const request of requests) assert.equal(helpers.projectRequest(request), request);
  for (const path of ['/repo/subdir', 'C:\\repo', '\\\\server\\share\\repo']) assert.equal(helpers.absolutePath(path), true);
  for (const path of ['', 'repo', 'C:repo', '/repo\0unsafe']) assert.equal(helpers.absolutePath(path), false);
  for (const request of [{ action: 'delete', projectId }, { action: 'list', actorId: 'embedded' }, { action: 'list', projectId: 'not-uuid' }, { action: 'create', id: 'not-uuid', title: 'Name', folders: ['/repo'] }, { action: 'create', id: projectId, title: 'x'.repeat(121), folders: ['/repo'] }, { action: 'create', id: projectId, title: ' ', folders: ['/repo'] }, { action: 'create', id: projectId, title: 'Name', folders: [] }, { action: 'create', id: projectId, title: 'Name', folders: Array(33).fill('/repo') }, { action: 'create', id: projectId, title: 'Name', folders: ['relative/path'] }, { action: 'update', projectId }, { action: 'start', operationId, projectId, folderId: 'folder-a', mode: 'worktree' }]) invalid(() => helpers.projectRequest(request));
});

test('project response decoder validates metadata and exact fresh-start binding identity', () => {
  assert.equal(helpers.projectData({ action: 'list' }, metadata), metadata);
  assert.equal(helpers.projectData({ action: 'create', id: projectId }, { project }).project, project);
  assert.equal(helpers.projectData({ action: 'update', projectId }, { project }).project, project);
  const data = { sessionId: 'fresh', workspaceId: 'folder-a', binding: { ...local, sessionId: 'fresh' } };
  const request = { action: 'start', projectId, folderId: 'folder-a' };
  assert.equal(helpers.projectData(request, data), data);
  for (const bad of [{ ...data, sessionId: 'wrong' }, { ...data, workspaceId: 'wrong' }, { ...data, binding: { ...data.binding, projectId: operationId } }, { ...data, binding: { ...data.binding, mode: 'worktree' } }]) invalid(() => helpers.projectData(request, bad));
  for (const bad of [{ projects: [project], bindings: [{ ...tree, effectiveCwd: 'relative' }] }, { projects: [{ ...project, folders: [] }], bindings: [] }, { projects: [], bindings: [{ ...local, mode: 'fork' }] }]) invalid(() => helpers.projectData({ action: 'list' }, bad));
});

test('Host numeric timestamps and mode/worktree-id pairing are strict, never inferred from string dates or lineage', () => {
  for (const timestamp of [0, 123, Number.MAX_SAFE_INTEGER]) assert.equal(helpers.projectData({ action: 'list' }, { projects: [{ ...project, createdAt: timestamp, updatedAt: timestamp }], bindings: [] }).projects[0].createdAt, timestamp);
  for (const timestamp of ['2026-10-09T00:00:00Z', '123', -1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) invalid(() => helpers.projectData({ action: 'list' }, { projects: [{ ...project, createdAt: timestamp }], bindings: [] }));
  for (const binding of [{ ...tree, worktreeId: undefined }, { ...tree, worktreeId: 'tree-1' }, { ...local, worktreeId: tree.worktreeId }]) invalid(() => helpers.projectData({ action: 'list' }, { projects: [project], bindings: [binding] }));
});

test('project RPC uses shared authenticated quiet transport and permits no actor on an empty installation', async () => {
  const calls = [], signal = new AbortController().signal, request = { action: 'list' };
  const ctx = { connection: { rpc: { async call(...args) { calls.push(args); return success(metadata); } } } };
  await helpers.requestProjects(ctx, undefined, request, signal);
  assert.equal(calls[0][0], '/api'); assert.equal(calls[0][1], 'dsh-worktrees/projects');
  assert.deepEqual(Object.keys(calls[0][2]).sort(), ['request', 'v']);
  assert.equal(calls[0][2].request, request); assert.equal(calls[0][3], signal);
  await helpers.requestProjects(ctx, 'actual-current', request);
  assert.equal(calls[1][2].actorId, 'actual-current');
  for (const actor of [null, '', ' ']) await assert.rejects(helpers.requestProjects(ctx, actor, request), error => error.kind === 'actor');
  await assert.rejects(helpers.requestProjects({ connection: { rpc: { call: async () => ({ ok: true, value: { v: 1, ok: false, error: { code: 'project/invalid-folder', message: 'Directory missing' } } }) } } }, undefined, request), error => error.kind === 'host' && error.code === 'project/invalid-folder');
  assert.equal(calls.length, 2, 'invalid requests cannot dispatch or fall back to commands');
  assert.doesNotMatch(source, /remote\.commands|setInterval\(|fetch\(|XMLHttpRequest|document\.(?:body|querySelector)/);
  assert.equal([...source.matchAll(/ctx\.connection\.rpc\.call\(/g)].length, 1);
});

test('native sessions group under original projects, preserve unassigned/archive access, and never equate fork lineage with worktrees', () => {
  const sessions = { byId: { local: { title: 'Local task', updatedAt: 10 }, tree: { title: 'agent identity', updatedAt: 20 }, fork: { title: 'thread automation', parentId: 'local', updatedAt: 30 }, other: { title: 'Outside project', updatedAt: 40 }, child: { title: 'Subagent', origin: 'subagent' }, fresh: { blank: true }, staleBlank: { blank: true } } };
  const statuses = new Map([['tree', { running: true }], ['fork', { pendingInteraction: { kind: 'question' } }]]);
  const grouped = helpers.projectRows(metadata, workspaces, sessions, statuses, { selectedId: 'fresh' });
  assert.equal(grouped.length, 2); assert.equal(grouped[0].project.title, project.title);
  const rows = grouped[0].rows;
  assert.ok(rows.some(row => row.id === 'tree' && row.context.binding.mode === 'worktree' && row.running));
  assert.ok(rows.some(row => row.id === 'fork' && row.context.binding.mode === 'local' && row.pending));
  assert.ok(rows.some(row => row.id === 'fresh'));
  assert.deepEqual(Array.from(grouped[1].rows, row => row.id), ['other']);
  assert.ok(!grouped.some(group => group.rows.some(row => row.id === 'child' || row.id === 'staleBlank')));
  const archived = { ...workspaces, archivedSessionIds: ['tree'], pinnedSessionIds: ['fork'] };
  assert.ok(!helpers.projectRows(metadata, archived, sessions, statuses)[0].rows.some(row => row.id === 'tree'));
  assert.equal(helpers.projectRows(metadata, archived, sessions, statuses, { archived: 'only' })[0].rows[0].id, 'tree');
  assert.equal(helpers.projectRows(metadata, archived, sessions, statuses, { query: 'AUTOMATION', archived: 'all' })[0].rows[0].id, 'fork');
  assert.equal(helpers.projectRows(metadata, archived, sessions, statuses, { archived: 'all' })[0].rows[0].id, 'fork');
  const subagentRunning = { ...sessions, projectionsBySession: { local: { values: { subagentCatalog: [{ id: 'child' }] } } } };
  assert.equal(helpers.projectRows(metadata, workspaces, subagentRunning, new Map([['child', { running: true }]]))[0].rows.find(row => row.id === 'local').running, true);
});

test('project rows use durable native titles rather than displayTitle directory/id fallbacks', () => {
  const sessions = { byId: { local: { title: 'Stored thread title', displayTitle: 'Native display label', updatedAt: 10 }, unnamed: { displayTitle: 'Directory fallback', updatedAt: 20 } } };
  const rows = helpers.projectRows(metadata, workspaces, sessions, new Map()).flatMap(group => group.rows);
  assert.equal(rows.find(row => row.id === 'local').title, 'Stored thread title');
  assert.equal(rows.find(row => row.id === 'unnamed').title, '', 'unnamed rows use the localized Untitled label, never a folder name');
});

test('project navigation recognizes ordinary fork ownership without granting subagent or ambiguous actor fallbacks', () => {
  assert.equal(helpers.projectActor({ byId: { fork: { parentId: 'ordinary-parent', retainedBy: { mainView: 1 } } } }), 'fork');
  assert.equal(helpers.projectActor({ byId: { child: { origin: 'subagent', retainedBy: { mainView: 1 } } } }), undefined);
  assert.equal(helpers.projectActor({ byId: { a: { retainedBy: { mainView: 1 } }, b: { retainedBy: { mainView: 1 } } } }), undefined);
  assert.equal(helpers.projectActor({ byId: {} }), undefined);
});

test('folded rows reserve idle quota only, preserve running/pending/current rows and folder subdirectories', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: String(i), running: i === 7, pending: i === 8 ? {} : undefined }));
  assert.deepEqual(Array.from(helpers.visibleProjectRows(rows, 2, '6'), row => row.id), ['0', '1', '6', '7', '8']);
  const context = helpers.captureProject(helpers.projectContext(metadata, workspaces, 'tree'));
  assert.equal(context.path, '/repo/services/api'); assert.ok(Object.isFrozen(context));
  assert.equal(helpers.projectPath({ projectPath: '/repo/services/api', repository: { root: '/repo' } }), '/repo/services/api');
  assert.equal(helpers.projectPath({ repository: { root: '/repo' } }, context), '/repo/services/api');
  assert.equal(helpers.sameProject(context, { ...context }), true);
  assert.equal(helpers.sameProject(context, { ...context, folderId: 'folder-b' }), false);
});

function projectRuntime({ delayedStart = false, delayedReady = false, delayedOwnership = false, draft = '', targetDraft = '', startId = 'fresh', effectiveCwd = local.effectiveCwd } = {}) {
  const calls = [], opened = [], selected = [], cleanups = new Set(), ownership = observable({ retainedBy: {} });
  const list = observable({ byId: { local: { retainedBy: { mainView: 1 } } } }), workspaceList = observable(copy(workspaces)), generation = observable({ id: 1 });
  const srcInput = observable({ ...copy(empty), draft }), dstInput = observable({ ...copy(empty), draft: targetDraft });
  const srcBinding = { ctx: { id: 'local' }, session: observable({ ...blank }) }, dstBinding = { ctx: { id: 'fresh' }, session: observable({ ...blank }) };
  const references = [], conversation = { input: { for: ctx => ({ state: ctx.id === 'local' ? srcInput : dstInput }) } };
  let navigation, resolveStart, resolveReady;
  const ready = delayedReady ? new Promise(resolve => { resolveReady = resolve; }) : Promise.resolve(dstBinding);
  let serverMetadata = copy(metadata);
  const result = { sessionId: startId, workspaceId: 'folder-a', binding: { ...local, sessionId: startId, effectiveCwd } };
  const ctx = {
    get: name => { assert.equal(name, 'conversation'); return conversation; },
    workspaces: { list: workspaceList }, connection: { generation, rpc: { async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api'); assert.equal(endpoint, 'dsh-worktrees/projects'); calls.push({ request: payload.request, payload, signal, actorId: payload.actorId });
      const request = payload.request;
      if (request.action === 'list') return success(copy(serverMetadata));
      if (request.action === 'start') return delayedStart ? new Promise(resolve => { resolveStart = resolve; }) : success(result);
      if (request.action === 'create') {
        const created = { id: request.id, title: request.title, folders: request.folders.map((path, i) => ({ id: 'new-folder-' + i, path, title: 'New folder' })), createdAt: project.createdAt + 1, updatedAt: project.updatedAt + 1 };
        created.mainFolderId = created.folders.find(folder => folder.path === (request.mainFolder || request.folders[0])).id;
        serverMetadata.projects.push(created); return success({ project: copy(created) });
      }
      if (request.action === 'update') {
        const saved = serverMetadata.projects.find(item => item.id === request.projectId);
        Object.assign(saved, { ...(request.title !== undefined ? { title: request.title } : {}), ...(request.folders ? { folders: request.folders.map(path => saved.folders.find(folder => folder.path === path)) } : {}), updatedAt: saved.updatedAt + 1 });
        saved.mainFolderId = request.mainFolder ? saved.folders.find(folder => folder.path === request.mainFolder).id : helpers.projectMainFolder(saved).id;
        return success({ project: copy(saved) });
      }
      if (request.action === 'bind') {
        const binding = { ...local, sessionId: request.sessionId, projectId: request.projectId, folderId: request.folderId };
        serverMetadata.bindings = [...serverMetadata.bindings.filter(item => item.sessionId !== binding.sessionId), binding]; return success({ binding: copy(binding) });
      }
      assert.fail('Unexpected request');
    } } },
    sessions: { list, binding: id => id === 'local' ? srcBinding : dstBinding,
      retain(id, options) { assert.equal(options.source, 'controllerOperation'); const ref = { sessionId: id, ready: id === 'local' ? Promise.resolve(srcBinding) : ready, releases: 0, release() { ++ref.releases; } }; references.push(ref); return ref; },
      retainInfo: id => id === 'local' ? { getSnapshot: () => ({ retainedBy: list.getSnapshot().byId.local?.retainedBy || {} }), subscribe: list.subscribe } : ownership },
    layout: { beginNavigation() { navigation?.abort(); navigation = new AbortController(); return navigation.signal; } },
    uiWorkspace: { startSession(id) { selected.push(id); }, openSession(id) { opened.push(id); navigation.abort(); if (!delayedOwnership) { ownership.publish({ retainedBy: { mainView: 1 } }); list.publish({ byId: { [id]: { retainedBy: { mainView: 1 } } } }); } } },
    effect(factory) { const cleanup = factory(); let live = true; const dispose = () => { if (live) { live = false; cleanups.delete(dispose); cleanup(); } }; cleanups.add(dispose); return dispose; },
  };
  const store = helpers.createProjectStore(ctx, key => key);
  return { ctx, store, calls, list, workspaceList, generation, srcInput, dstInput, opened, selected, references, ownership, cleanups, ready: settle,
    finishStart() { resolveStart(success(result)); }, finishReady() { resolveReady(dstBinding); }, navigate() { navigation.abort(); },
    own() { ownership.publish({ retainedBy: { mainView: 1 } }); list.publish({ byId: { fresh: { retainedBy: { mainView: 1 } } } }); },
    dispose() { store.dispose(); for (const cleanup of [...cleanups]) cleanup(); } };
}

test('metadata refresh is root-owned and structural/generation driven, never token/retention driven; caches remain stable', async () => {
  const run = projectRuntime(); await run.ready(); assert.equal(run.calls.length, 1);
  assert.equal(Object.hasOwn(run.calls[0].payload, 'actorId'), false, 'pure metadata refresh must not resume or activate the selected conversation');
  const projects = run.store.store.getSnapshot().projects;
  run.list.publish({ byId: { local: { retainedBy: { mainView: 1 }, title: 'streamed title' } } });
  run.workspaceList.publish({ ...run.workspaceList.getSnapshot(), archivedSessionIds: ['local'], pinnedSessionIds: ['tree'] });
  await settle(); assert.equal(run.calls.length, 1);
  run.generation.publish({ id: 2 }); await settle(); assert.equal(run.calls.length, 2);
  assert.equal(run.store.store.getSnapshot().projects, projects, 'unchanged metadata does not churn the cache');
  run.workspaceList.publish({ ...run.workspaceList.getSnapshot(), items: [...run.workspaceList.getSnapshot().items, { workspaceId: 'added', path: '/added', title: 'Added', sessionIds: [] }] });
  await settle(); assert.equal(run.calls.length, 3);
  run.dispose(); assert.equal(run.workspaceList.listeners.size, 0); assert.equal(run.generation.listeners.size, 0);
  run.generation.publish({ id: 3 }); await settle(); assert.equal(run.calls.length, 3);
});

test('successful create/update/bind install actual Host-shaped commits, cancel stale reads, and never use chat commands', async () => {
  const run = projectRuntime(); await run.ready();
  const created = await run.store.mutate({ action: 'create', id: operationId, title: 'Created project', folders: ['/created/folder'] });
  assert.equal(typeof created.project.createdAt, 'number');
  assert.equal(run.store.store.getSnapshot().projects.find(item => item.id === operationId).title, 'Created project');
  await settle(); assert.equal(run.store.store.getSnapshot().projects.find(item => item.id === operationId).folders[0].path, '/created/folder');
  const updated = await run.store.mutate({ action: 'update', projectId, title: 'Renamed project', folders: project.folders.map(folder => folder.path) });
  assert.equal(updated.project.title, 'Renamed project'); assert.equal(run.store.store.getSnapshot().projects.find(item => item.id === projectId).title, 'Renamed project');
  const bound = await run.store.mutate({ action: 'bind', projectId, folderId: 'folder-a', sessionId: 'fresh' });
  assert.equal(bound.binding.sessionId, 'fresh'); assert.equal(run.store.store.getSnapshot().bindings.find(item => item.sessionId === 'fresh').effectiveCwd, '/repo/services/api');
  await settle(); assert.equal(run.store.store.getSnapshot().projects.find(item => item.id === projectId).title, 'Renamed project');
  assert.ok(run.calls.filter(call => call.request.action === 'list').every(call => !Object.hasOwn(call.payload, 'actorId')));
  assert.ok(run.calls.some(call => call.request.action === 'create') && run.calls.some(call => call.request.action === 'update') && run.calls.some(call => call.request.action === 'bind'));
  assert.equal(run.opened.length, 0); assert.equal(run.selected.length, 0); assert.equal(run.references.length, 0);
  assert.doesNotMatch(source, /remote\.commands|commands\.execute|fetch\(|XMLHttpRequest/); run.dispose();
});

// Actual SDK registry semantics. The tiny inject adapter uses the Core's real
// declaration subscriptions, not invented shadow rules or a renderer double.
function coreContext(core) {
  return { shortcuts: { catalog: observable([]) }, slots: {
    entriesOfSlot: key => core.entriesOfSlot(key), subscribe: (key, fn) => core.subscribe(key, fn), register: (opts, component) => core.register(opts, component),
    inject(key, callback) {
      let active, disposed = false;
      const update = () => { if (disposed) return; if (core.specDynamic(key) && !active) active = callback(); else if (!core.specDynamic(key) && active) { active(); active = undefined; } };
      const unsubscribe = core.subscribeDeclaration(key, update); update();
      return () => { disposed = true; unsubscribe(); active?.(); active = undefined; };
    },
  } };
}

test('stale metadata reads cannot replace newer explicit refresh results', async () => {
  const run = projectRuntime(); await run.ready();
  let resolveOld, reads = 0;
  run.ctx.connection.rpc.call = async (_channel, _endpoint, payload) => {
    assert.equal(payload.request.action, 'list');
    if (++reads === 1) return new Promise(resolve => { resolveOld = resolve; });
    return success({ ...metadata, projects: [{ ...project, title: 'Latest title' }] });
  };
  const old = run.store.refresh(); await settle(); await run.store.refresh();
  assert.equal(run.store.store.getSnapshot().projects[0].title, 'Latest title');
  resolveOld(success(metadata)); await old;
  assert.equal(run.store.store.getSnapshot().projects[0].title, 'Latest title'); run.dispose();
});

test('actual SDK lowest-priority shadow + owned aliases preserve installed entries, menu hooks and declaration lifetimes', async () => {
  const core = new SlotCore(), ctx = coreContext(core), catalog = ctx.shortcuts.catalog;
  const root = core.register({ name: 'root', children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } }, () => null);
  const nativeChildren = Object.fromEntries(Array.from(helpers.projectSlots, name => [name, { kind: name.endsWith('directoryFlow') ? 'single' : 'list', scope: 'root', ...(name.endsWith('menu.item') ? { inject: { hooks: { menuOpenState: (_standard, state) => () => state, shortcuts: catalog } } } : {}) }]));
  const native = core.register({ name: 'sidebar.workspaces', children: nativeChildren }, () => null);
  assert.throws(() => core.register({ name: 'sidebar.workspaces', priority: -50, children: nativeChildren }, () => null), /already declared/);
  const nativeEntry = core.entriesOfSlot('sidebar.workspaces')[0];
  const positive = core.register({ name: 'sidebar.workspaces', priority: 50 }, () => null);
  assert.equal(core.entriesOfSlot('sidebar.workspaces')[0], nativeEntry, 'positive priority cannot replace the SDK native zero-priority entry'); positive();
  const mode = helpers.createSidebarMode(() => core.register({ name: 'sidebar.workspaces', priority: -50, children: helpers.projectChildren(ctx) }, () => null));
  assert.notEqual(core.entriesOfSlot('sidebar.workspaces')[0], nativeEntry);
  const sourceSlot = 'sidebar.workspaces.session.menu.item', alias = helpers.projectSlotName(sourceSlot), component = () => null, inject = () => ({ rename: true });
  const registration = core.register({ name: sourceSlot, id: 'rename', order: 200, locale: 'workspace', inject }, component);
  const mirror = helpers.mirrorProjectSlot(ctx, sourceSlot);
  const sourceEntry = core.entriesOfSlot(sourceSlot)[0], copied = core.entriesOfSlot(alias)[0];
  assert.equal(copied.component, component); assert.equal(copied.inject, inject); assert.equal(copied.locale, 'workspace'); assert.equal(copied.options.order, 200);
  const menu = [true, () => {}], hook = core.specDynamic(alias).inject.hooks.menuOpenState;
  assert.equal(hook({}, menu)(), menu, 'native menu receives the exact render occurrence hookContext');
  assert.equal(core.entriesOfSlot(sourceSlot)[0], sourceEntry, 'mirror never changes source registration');
  const other = core.register({ name: sourceSlot, id: 'plugin-export', order: 500 }, () => null); await settle(); assert.equal(core.entriesOfSlot(alias).length, 2);
  registration(); await settle(); assert.equal(core.entriesOfSlot(alias).length, 1);
  mode.toggle(); assert.equal(core.entriesOfSlot('sidebar.workspaces')[0], nativeEntry); assert.equal(core.specDynamic(alias), undefined); assert.equal(core.entriesOfSlot(sourceSlot).length, 1);
  mode.toggle(); await settle(); assert.equal(core.entriesOfSlot(alias).length, 1, 'alias mirror reinstalls on Projects declaration restoration');
  mirror(); mode.dispose(); assert.equal(core.entriesOfSlot(sourceSlot).length, 1); assert.equal(core.entriesOfSlot('sidebar.workspaces')[0], nativeEntry);
  other(); native(); root();
});

test('UI only replaces the browsing hole and uses accessible permanent worktree markers and native Dialog behavior', () => {
  assert.match(source, /name: 'sidebar\.workspaces', priority: -50, children: projectChildren\(ctx\)/);
  assert.match(source, /sidebar\.footer\.action/);
  assert.match(source, /renderSlot\(projectSlotName\('sidebar\.workspaces\.session\.menu\.item'\), owner, \{ hookContext: \[menu, setMenu\] \}\)/);
  assert.match(source, /binding\.mode === 'worktree'/); assert.match(source, /className: 'dsh-wt-branch-chip', title: marker, 'aria-label': marker/);
  assert.match(source, /dialog\.showModal\(\)/); assert.match(source, /onCancel: event => \{ event\.preventDefault\(\); event\.stopPropagation\(\); if \(dismissible\) close\(\); \}/);
  assert.doesNotMatch(source, /name: 'sidebar'[, }]|name: 'root'[, }]|document\.body|@deepseek-ai\/dsh-client-ui-primitives/);
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ['react']);
});


test('native new-session flow replaces custom thread dialogs and picker while project grouping remains', () => {
  assert.doesNotMatch(source, /NewThreadDialog|ProjectHero|ProjectChooser|api.coordinator/);
  assert.match(source, /function start\(folderId\).*runtime.uiWorkspace.startSession\(folderId\)/);
  assert.doesNotMatch(source, /seat\('conversation.hero.workspace'/);
});

test('project metadata validates and installs refreshed branch records without polling', async () => {
  const record = { id: tree.worktreeId, operationId, effectiveCwd: tree.effectiveCwd, remote: 'origin', remoteBranch: 'main', baseOid: 'base', sessionIds: ['tree'], branch: 'worktree/random', protected: false, archived: false, state: 'ready' };
  const data = { ...metadata, records: [record] };
  assert.equal(helpers.projectData({ action: 'list' }, data), data);
  for (const records of [null, {}, [null], [{ ...record, branch: 1 }]]) invalid(() => helpers.projectData({ action: 'list' }, { ...metadata, records }));
  const run = projectRuntime(); await run.ready();
  let current = data;
  run.ctx.connection.rpc.call = async () => success(current);
  await run.store.refresh(); assert.equal(run.store.store.getSnapshot().records[0].branch, 'worktree/random');
  current = { ...data, records: [{ ...record, branch: 'worktree/fix-routing' }] };
  run.workspaceList.publish({ ...workspaces, items: workspaces.items.map(item => item.workspaceId === 'tree-folder' ? { ...item, title: 'Fix routing' } : item) });
  await settle(); assert.equal(run.store.store.getSnapshot().records[0].branch, 'worktree/fix-routing'); run.dispose();
});


test('Projects sidebar rows keep only the worktree icon; branch/path appear in hover and details', () => {
  const row = source.slice(source.indexOf('    function ThreadRow('), source.indexOf('    function ProjectGroup('));
  const marker = row.slice(row.indexOf("worktree ? h('span'"), row.indexOf("!row.session.blank && h('span'"));
  assert.match(marker, /className: 'dsh-wt-branch-chip', title: marker, 'aria-label': marker, role: 'img'/);
  assert.match(marker, /h\(Icon, \{ size: 13 \}\)/);
  assert.doesNotMatch(marker, /record\??\.(?:branch|displayName)|h\('span', null/);
  assert.match(row, /const marker = .*record\.branch/);
  assert.match(row, /title: title \+ ' · ' \+ status \+ \(worktree \? ' · ' \+ marker : ''\)/);
  const details = row.slice(row.indexOf("hover && h('div'"));
  assert.match(details, /worktree && record\?\.branch && h\('div', null, h\('code', null, record\.branch\)\)/);
  assert.match(details, /h\('code', null, path\)/);
  assert.match(source, /\.dsh-wt-branch-chip\{[^}]*width:16px;flex-shrink:0/);
});


test('project dialog declares the compact reference layout and a separately staged multi-folder browser', () => {
  const editor = source.slice(source.indexOf('    function ProjectEditor('), source.indexOf('    function ThreadRow('));
  const browser = source.slice(source.indexOf('    function FolderBrowser('), source.indexOf('    function ProjectEditor('));
  const dialog = source.slice(source.indexOf('    function Dialog('), source.indexOf('    function FolderRows('));
  assert.match(editor, /className: 'dsh-wt-project-dialog', compact: true/);
  assert.ok(editor.includes("'createProject'"));
  for (const key of ['projectName', 'sourceFolders', 'localFolders', 'add', 'cancel']) assert.ok(editor.includes("t('" + key + "')"), key);
  assert.match(editor, /h\(FolderRows, \{ folders, remove, disabled: busy, t \}\)/);
  assert.match(editor, /existing: folders, picked: add, close: \(\) => setBrowser\(false\)/);
  assert.match(editor, /appendProjectFolders\(currentFolders\.current, paths\)/);
  assert.match(editor, /submitter\.current\.pending \|\| picker\.current \|\| browser/);
  assert.match(editor, /const dismiss = \(\) => \{ if \(!submitter\.current\.pending && !picker\.current\) close\(\)/);
  assert.ok(editor.indexOf('picker.current = true;') < editor.indexOf('await ctx.uiWorkspace.pickDirectory()'));
  assert.match(editor, /if \(lifetime\.current && selected\) add\(\[selected\]\)/);
  assert.doesNotMatch(editor, /setFlow|setBrowser\(true\)[^\n]*catch|remote\.commands|fetch\(/);
  assert.match(browser, /type: 'checkbox', checked/); assert.match(browser, /'aria-label': t\('selectFolder'\) \+ ' ' \+ path/);
  assert.match(browser, /toggleProjectFolder\(selection\.current, path, capacity\)/);
  assert.match(browser, /picked\(\[\.\.\.selection\.current\]\)/);
  assert.match(browser, /listing\.truncated/);
  assert.match(dialog, /dialog\.showModal\(\); initialFocus\?\.current\?\.focus\(\)/);
  assert.match(editor, /initialFocus: nameInput/); assert.match(editor, /ref: nameInput/);
  assert.match(browser, /initialFocus: pathInput/); assert.match(browser, /ref: pathInput/);
  const styling = source.slice(source.indexOf('.dsh-wt-project-dialog{'), source.indexOf('.dsh-wt-progress{'));
  const allowed = new Set(['border-l1', 'border-l2', 'bg-layer-1', 'bg-layer-2', 'bg-overlay', 'label-primary', 'label-secondary', 'brand-primary']);
  for (const match of styling.matchAll(/var\(--dsw-alias-([^)]*)\)/g)) assert.ok(allowed.has(match[1]), match[1]);
  assert.doesNotMatch(styling, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test('project UI requires the main for multi-folder creation and preserves per-conversation folder overrides', () => {
  const editor = source.slice(source.indexOf('    function ProjectEditor('), source.indexOf('    function ThreadRow('));
  const group = source.slice(source.indexOf('    function ProjectGroup('), source.indexOf('    function SidebarToggle('));
  const composer = source.slice(source.indexOf('    function NewWorktreeControls('), source.indexOf('    function SetupProgress('));
  assert.match(editor, /projectMainFolder\(project\)\?\.path/);
  assert.match(editor, /folders\.length > 1 && h\('label', \{ className: 'dsh-wt-main-folder' \}/);
  assert.match(editor, /h\('select', \{ required: true, value: primary, disabled: busy/);
  assert.match(editor, /disabled: busy \|\| !title\.trim\(\) \|\| !folders\.length \|\| !primary/);
  assert.match(editor, /submit\(title, currentFolders\.current, mainFolder\)/);
  assert.match(group, /main = projectMainFolder\(group\.project\)/);
  assert.match(group, /onClick: \(\) => main && start\(main\.id\)/);
  assert.match(group, /'aria-expanded': choosingFolder/); assert.match(group, /onClick: \(\) => start\(folder\.id\)/);
  assert.match(composer, /'aria-label': t\('conversationFolder'\)/);
  assert.match(composer, /value: context\.folder\.id, disabled: busy \|\| !empty \|\| !sourceEligible\(snapshot\)/);
  assert.match(composer, /chooseConversationFolder\(ctx, projects, flow, sessionId, event\.target\.value\)/);
});

test('chat header retains passive project metadata without a Worktrees button; sidebar manager stays available', () => {
  const header = source.slice(source.indexOf('    function Header('), source.indexOf('    function Manager('));
  assert.doesNotMatch(header, /h\(Button|h\(Icon|selectPanel|onClick|t\('title'\)/);
  assert.match(header, /if \(blank \|\| !context\) return null/);
  assert.match(header, /context\.project\.title/);
  assert.match(header, /title: context\.binding\.effectiveCwd/);
  assert.match(source, /name: 'sidebar.panellist', id: PANEL/);
  assert.match(source, /name: 'main', key: PANEL.*Manager/);
});
