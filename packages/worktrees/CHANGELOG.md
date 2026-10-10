# @1yefuwang1/dsh-worktrees changelog

## 0.2.14 — Native sidebar view switch

- Move the view switch from the footer into native sidebar navigation, between
  Automation tasks and Worktrees, using the native row styling and icon sizing.
- Label the action by its destination: **Switch to Projects View** or
  **Switch to Workspace View**, with matching Chinese translations.
- Preserve native sidebar declarations and extensions through owned slot aliases;
  switching views leaves the current conversation and other panel actions intact.
- Add regression coverage for navigation order, labels, callback routing and
  native sidebar restoration on plugin unload.

## 0.2.13 — First scoped release preparation

- Package as `@1yefuwang1/dsh-worktrees` to avoid an unrelated unscoped npm name;
  publish only this leaf through the staged trusted-publishing workflow. Preserve
  stable tool/command, UI, RPC and storage identifiers across the identity change.

- Match Projects working-session markers to native Folder view: a neutral 14px
  SVG ring with synchronized 1.5s rotation/breathing and reduced-motion support.
- Use native-sized solid pending/completion dots and preserve pending/activity/
  completion priority, blank/archive suppression and idle extension decorations.
- Keep activity state distinct from permanent worktree backing. No core changes.

## 0.2.12 — Compact sidebar toolbar

- Replace the always-visible search field and archive dropdown with a compact
  Projects toolbar: Search, View options and Add project icons match Folder view.
- Reveal and focus inline search on request; Escape/Close clears the filter and
  restores trigger focus. Keep archive choices in an owned keyboard-accessible
  popover, without changing project management, sessions or native editor state.

## 0.2.11 — Native sidebar alignment

- Match Projects sidebar typography and row spacing to the native Folder view,
  with the same open/closed workspace-folder artwork instead of text glyphs.
- Show localized session last-active times and an absolute-date tooltip using
  the native relative-time buckets, with hover/focus actions replacing the time.
- Use counted Show X more sessions labels and the native 12px overflow style;
  count only actually hidden rows while preserving running/current sessions.
- Retain permanent worktree indicators, native row extensions and metadata-only
  project management. No core changes or background date/Git polling.

## 0.2.10 — Metadata-only project removal

- Add Remove project to Manage project, with a metadata-only confirmation that
  keeps source folders, files, conversations and managed worktrees intact.
- Persist removal receipts before cleanup; prevent folder auto-import from
  recreating removed projects on refresh, restart or ordinary worktree use.
  Explicit re-add uses a fresh project UUID and retains native folder identities.
- Keep removed projects' conversations accessible under Other threads and Folder
  view, with truthful managed-worktree icons, branches and execution paths.
- Share Save/Remove single-flight admission, preserve refused editor drafts, and
  fence stale reads and ownership-sensitive New intents without Local fallback.
- Retain native workspaces, sessions, start receipts and Git data. No core changes.

## 0.2.9 — Git-aware conversation options

- Offer New worktree/remote-branch controls only after the actual blank target
  passes a read-only local Git status check and has a configured remote. Plain
  folders, unsupported/unverified sources and failed checks retain Local chats.
- Coalesce/cache exact binding/folder/connection observations; abort stale checks
  on target changes, panel/unmount, reconnect or disposal without polling rows.
- Gate New selection, native intent capture and setup checks; revoke stale branch
  queries and captured New attempts without silently changing them to Local.
  Unavailable New intent requires explicit Local selection, including worktree-
  backed sources. Fresh configure/Send status failures revoke older positives.
- Preserve read-only caller authorization, fresh Send-time validation, native draft
  restoration and accepted destination navigation. No core or Host API changes.

## 0.2.8 — Main-folder defaults and reminders

- Persist a main folder per project; require an explicit choice for new multi-
  folder GUI drafts and migrate legacy metadata to its first folder. Main-only
  edits and folder reorders never change existing conversation cwd or bindings.
- Default the project's New Thread action to main, with alternate-folder actions
  and a guarded empty-composer folder selector using the native session flow.
- Expose canonical `mainFolder` create/update paths and optional start `folderId`;
  default-start replay retains its original folder/session and caller safeguards.
- Add main/default, actual selection, execution directory and bounded folder IDs
  to the native agent system reminder; always include main/selected folders, with
  full-metadata discovery and explicit permissions/worktree boundaries.
- Reject invalid defaults and unsafe main removal; retain managed-ancestry folder
  protection. Keep DSH core, native editor, log/cwd and permissions unchanged.

## 0.2.7 — Multi-folder project dialog

- Redesign Create/Manage project as a compact name field, Source folders card,
  removable folder rows, Add control and Cancel/Create project footer.
- Support checkbox-based batch folder selection retained across Host directory
  navigation, repeated Add, deduplication and an atomic 32-folder limit. Keep
  manual absolute paths and the optional single-folder native chooser.
- Guard pending saves/pickers synchronously, keep one create UUID per dialog,
  freeze full folder replacements, retain refused drafts and block dismissal
  while non-cancellable operations are pending. Abort superseded browser scans.
- Preserve shared project tools/RPC, Host ownership/removal/path checks, existing
  execution directories and permissions. No core or shell changes.

## 0.2.6 — Worktree root settings

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
