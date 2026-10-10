# dsh-worktrees changelog

## 0.2.6 — Unreleased

- Expose Worktree root folder on the plugin row's native configuration page, with
  persisted Save and field-only reset, validation and revision-conflict handling.
- Make the root a native volatile setting and snapshot it once at new-create
  admission. Live edits affect future creates, never existing/in-flight paths or
  ready-operation replays; snapshots/handoff retain their load-time storage root.
- Keep plain constructor/apply compatibility and existing caller/plan/root safety
  checks. No core changes, custom settings transport, folder migration or grant.

## 0.2.5 — Chat header cleanup

- Remove the Worktrees button beside the project name in the chat header. Keep
  project/backing metadata passive and retain the manager's sidebar entry.
- Leave compact sidebar worktree indicators and lazy first-Send setup unchanged.

## 0.2.4 — Compact sidebar update

- Keep Projects sidebar worktree rows compact: show a permanent worktree icon,
  not inline worktree/branch-name text. Hovering the title or icon reveals the
  branch and execution path; thread details retain both and accessible naming.
- Leave lazy setup, conversation headers, manager and native row actions unchanged.

## 0.2.3 — Lazy native setup update

- Make New worktree selection side-effect-free. First native ordinary Send lazily
  fetches the selected latest remote base, creates a random checkout/branch,
  generates/applies a branch name, and only then admits the normal prompt.
- Add visible Fetching/Creating/Naming progress and cancellation through bounded
  event-driven authenticated wait RPC; no periodic polling or early main LLM call.
- Use the explicitly approved exact-version native submission-sink adapter, not a
  replacement message editor or core modification. Preserve native commands,
  reference codecs, submission gestures and draft/chip/undo rollback.
- Capture intent before async native serialization/adjudication; Local changes,
  unload and navigation cannot accidentally fall through to a Local prompt.
- Re-stage/await exact-session file receipts, retain source through native
  settlement, and guard ambiguous admission against duplicate work/prompts.
- Persist foreground naming intent/result after checkout, retain the random cwd,
  and cap foreground auxiliary naming at 15 seconds with deterministic fallback.

## 0.2.2 — Native eager creation update

- Remove the custom first-message composer and New Thread dialog. Restore the
  native workspace picker, rich editor, attachments and Send behavior; add only
  a Local/New worktree choice to the blank-conversation toolbar. Project New
  Thread uses the native session flow instead of a separate dialog.
- Create a random directory and local branch immediately when New worktree is
  chosen, from a freshly fetched selectable remote base. No prompt, draft/file
  transfer, naming inference or composer replacement occurs during creation.
- Rename only the initial branch from the first committed user message at a safe
  idle maintenance window. Keep cwd, checkout path and session identity stable;
  never overwrite a collision or a manually changed/protected/archived branch.
- Persist exact-message naming receipts/results, honor caller permissions and
  disposal, and reuse results or deterministic fallback after interruption without
  repeating uncertain inference. Leave session titles with the native feature.
- Refresh cached branch records through native Workspace structural updates,
  retaining quiet authenticated RPC, project grouping and non-destructive recovery.

## 0.2.1 — UI transport fix

- Fix sidebar HTTP 404 by owning exact authenticated POST Fetch routes instead
  of attempting to claim the API gateway's exclusive shared `/api` interceptor.
  Project and worktree endpoints coexist with native APIs, without core changes.
- Preserve the public Connection request/response envelope and rpcId correlation,
  existing operator admission, caller authorization, bounded bodies and orderly
  cancellation/disposal. UI traffic remains quiet; no command fallback is used.
- Exercise the real HostConnectionService Fetch router with the native gateway
  installed first, rather than a fake multi-interceptor registry.

## 0.2.0 — Project/thread model update

- Add durable multi-folder projects independent of native Workspace paths. Import
  existing Local workspaces, group their Local and managed-worktree threads, and
  retain membership when imported folders are combined into explicit projects.
- Add a project-grouped sidebar with permanent accessible worktree indicators,
  project/folder-aware New Thread, create/edit dialogs, search, pinned/archived
  access, and an explicit fallback to the original native folder browser.
- Preserve native row extensions through lifecycle-owned, namespaced public slot
  aliases; do not replace the app shell, mutate core, or change existing cwd/logs.
- Bind new worktree threads and Local handoff continuations to their actual
  project folder. Preserve subdirectories, support legacy nested ownership, and
  keep source worktree indicators off Local handoff threads.
- Add quiet project RPC, shared `workspace_project` tool and `/project` command,
  strict numeric DTO validation, cancellation/idempotent blank-thread creation,
  and bounded project runtime context. No permission grant or automatic prompt.

## 0.1.2 — Quiet UI transport update

- Move every generated UI request to authenticated Connection RPC. List/status,
  branch selection, remounts, cancellations and user actions no longer append
  visible slash-command lifecycle rows. Explicit commands and agent tools remain
  available with unchanged caller-bound authorization and operation semantics.
- Preserve existing chat history; no transcript/card hiding or core changes.

## 0.1.1 — Local UI/naming update

- Simplify New Chat to compact Local/New worktree and remote-base-branch choices.
  Worktree creation and automatic directory/display/branch naming occur on its
  first Send, using a plugin-owned first-prompt composer without core changes.
- Add configurable auxiliary naming, defaulting to github-copilot/gpt-6-luna,
  bounded and validated with deterministic fallback and no other-model retry.
- Declare the remote.commands Client namespace and stop passive header/Local
  background commands from producing repeated conversation rows.

## 0.1.0 — Initial local release

- Add a separately installable Host/Web Client bundle for isolated linked Git
  worktree conversations, without replacing an LLM adapter or web-search provider.
- Add blank-conversation Local/New worktree setup, selectable remote and searchable
  advertised branches, a fresh selected-branch fetch and a pinned detached base.
- Guard exact-session draft/file transfer with composer-block ownership, source
  generation/currentness, draft and settings checks, cancellation and navigation
  supersession. Prepare never sends a prompt; rich references flatten to clipboard
  text and runtime-only files must be reviewed/restaged before Send.
- Add manager/header reminders, status, exact conversation opening, branch creation,
  protection and archive/restore of records; archiving never deletes files or logs.
- Add retained preview/export and explicitly acknowledged optimistic Local handoff.
  Full access, idle known sessions, clean target at the saved base and stopped
  external writers are required; no automatic pull/reset/branch switch or claim of
  global atomicity. A running source cannot self-handoff from its own agent tool.
- Journal operation identities and partial outcomes for non-destructive recovery;
  committed same-request replay returns the original session/base. Preserve normal
  original-history, fork and Goal semantics.
- Add bounded managed Git execution, supported-repository checks, public declaration
  consumers, static/pure Client protocols and local-Git fixture tests.
- Add an explicit publication allowlist and package-specific release tag. This
  version has not been published; live installed-GUI verification remains required.

Independent history from the catalog and search packages. Licensed under
[MIT](<LICENSE>).
