# @1yefuwang1/dsh-worktrees changelog

## 0.2.22 — Unsent draft revalidation and a strict-API-safe tool declaration

- Replace the six-arm `oneOf` project-tool declaration with one flat object schema
  that declares a root `properties` bucket. The failing declaration was isolated to
  the missing bucket, not to `oneOf`: the shipped raw request returned a plain-text
  HTTP 400, the same declaration with `properties: {}` added returned 200 while still
  carrying `oneOf`, and deleting `oneOf` without the bucket still returned 400
  (enterprise account; gemini-3.7-flash and gemini-4-argon). The flattened form was
  measured at 200 for the full tool set on both models.
- Move per-action requirements, UUID meanings and the folder/length limits into the
  action and field descriptions; the strict Zod union, the project parser and the
  fail-closed concurrency classifier are unchanged.
- Project tool-facing parameters onto the registry's supported SDK subset so the
  TypeScript and Python renderers emit typed declarations, not `unknown`; runtime
  validation keeps every constraint.


- Treat composer withdrawal, navigation and reconnect as invalidated Git
  observations, not failed worktree preparation. Successful rechecks leave no
  stale warning and do not overwrite real setup or changed-source failures.
- Keep selected **New worktree** intent visible while checking/unavailable, with
  a neutral checking status and an explicit **Local** escape. Never submit,
  create a checkout or silently send locally on returning to an unsent draft.
- Render creating/naming progress only after native Send starts preparation;
  configuration and actual availability warnings stay in composer controls.
- Cover panel/navigation/reconnect lifecycle, draft/files preservation, negative
  rechecks, explicit Local selection and real failure retention in Client tests.

## 0.2.21 — Desktop-only native folder picker

- Hide **Choose a folder…** in web Create/Manage project dialogs. Require the
  desktop shell's callable picker bridge instead of treating the always-present
  Host picker method as native capability; keep desktop picking/fallback and
  web folder browsing/manual path entry.
- Cover web option visibility, defaults and stale-selection refusal alongside
  existing desktop picking/cancellation/fallback render tests.

## 0.2.20 — Runtime recovery and Local/navigation safety fixes

- Use the runtime factory's existing initialization claim as the staged input hold
  through explicit branch choice and the durable ready journal. Avoid nested
  `runMaintenance` and input-admission gaps; retain the real target for native
  permission controls, exact-ID retry and cold adoption.
- Define ready as the validated chosen Local branch, flushed history/Workspace
  association, and durable ready journal. Preserve that exact continuation/redirect
  if a later live-factory publication listener fails; report observed failures as
  `CONTINUATION_PUBLICATION_FAILED` with native same-ID resume guidance, never a
  downgrade or another branch switch. Pre-commit failures retain pending admission.
- Validate held targets' jobs and terminals independently of their parked inbox;
  exclude them only from acquiring a redundant driver claim.
- Fence new/resumed/replaced Local runtimes throughout branch selection and refresh
  the complete known owner/resource set at each actual managed spawn boundary,
  including after asynchronous executable/sandbox setup.
- Remove metadata-driven navigation. Show the GC warning and explicit Open Local
  action without cancelling pre-existing, newer or not-yet-committed native
  navigation; explicit Continue still opens the requested Local continuation.
- Normalize Git-reported absolute admin-path separators for Windows cleanup checks,
  while retaining exact canonical identity, pointer, backlink and lock validation.
- Add real pinned-runtime create/resume/native-control/queued-input/publication
  failure/shutdown tests, successful production claims/resource races and realistic
  native navigation races. The earlier simplified factory mocks missed a real
  nested-maintenance failure; these regressions now exercise that contract.

## 0.2.19 — Inactive workspace cleanup and Local recovery (unreleased)

- Reclaim verified managed worktrees after configurable messaging-only inactivity:
  enabled by default, 10 elapsed days, live 1–3650-day setting and disable control.
  Archive does not affect eligibility; protection, every loaded runtime, active
  resources, queued work and uncertain operations defer collection.
- Explicitly allow permanent deletion of unsaved/untracked/ignored checkout files;
  preserve branches, bases, final HEAD/private commit recovery refs, and history.
  Use narrowly scoped Host maintenance, cold writer claims, exact identity and
  lock checks, and single-force targeted Git removal—not dummy agents or pruning.
- Journal GC and reopening in a companion domain; retain old records/headers/logs,
  reconcile interrupted effects, refuse partial/replaced identities, and publish
  visible reclaimed/deferred/recovery states.
- Ask for a Local branch when a reclaimed thread opens. Continue once under a
  preallocated new session identity and persistent redirect, with full idle history
  and normal settings/preset/goal semantics. Never silently merge/apply old code,
  switch/reset Local forcefully, or resume the deleted-directory agent.
- Park pending continuation input before turns; enforce actual permission/idle
  claims on branch switches, and make Host-maintenance current-branch selection
  strictly verify-only even if another writer changes the branch during recovery.
- Add localized settings and warning/branch-choice UI with global navigation
  observation and quiet, cancellable lifecycle RPC. Retain historical native drafts
  instead of flattening chips or inventing a private draft migration transaction.
- Cover native Git safety, cold history/adoption, held input, activity/leases,
  storage crash recovery, quiet RPC, public declarations and Client interactions.
  Generic headless fork adoption and arbitrary external-writer atomicity remain
  outside the pinned runtime's supported recovery flow.

## 0.2.18 — Theme-aligned conversation controls and local starting branches

- Replace the native Local/New worktree dropdown and the mismatched Local-only
  button with the same compact, theme-aware menu control.
- Default the starting branch to the current local branch (or the detached HEAD
  commit), display its name, and replace “Base branch” with “Starting branch”.
- Offer Local and Remote branch sources. Local worktrees pin an exact committed
  local branch without fetching, including repositories with no configured remote;
  remote worktrees keep the fresh-fetch creation path.
- Load one bounded branch generation and search it locally. Keystrokes preserve
  selection and never rediscover remote branches; source/remote switching reuses
  loaded lists until explicit Refresh or target/connection invalidation.
- Select and dismiss immediately on branch click, with Escape/focus dismissal and
  keyboard navigation instead of a Close button.
- Preserve source-checkout, permission, cancellation and native-draft guards;
  refuse moved local selections rather than silently substituting another commit.
- Use the native desktop menu fill/elevation rather than the light overlay token;
  match native hover/segment colors and keep the search icon/input on one row.
  Fence the search reset against generic input/focus rules to avoid double borders.
- Keep the branch picker open during Refresh: move focus to the stable search
  field before disabling Refresh, and distinguish loading-related null blur from
  actual outside focus. Preserve search and selection across local/remote reloads.
- Add backend, protocol/cache and real React interaction/style-cascade coverage.

## 0.2.17 — Folder entries follow the composed picker, with a working default

- Stop offering an add interaction the session cannot serve. The Host composes
  either the system chooser (loopback desktop: `pick` only) or the in-app browser
  (remote, SSH or browse-composed sessions: `listDirectory`/`createDirectory`
  only), and the other verb set fails with `directory-picker/unavailable`. The
  dialog now probes listing once and shows **Browse for folders** only when the
  in-app browser can actually list Host folders.
- Keep **Choose a folder…** for a session with any reachable chooser (desktop
  bridge or `uiWorkspace.pickDirectory`) and **Enter a folder path** everywhere, so
  project creation stays possible in every composition, including desktop where
  multi-folder projects are built by repeating the system dialog or pasting paths.
- Fall back deterministically when a selected entry disappears: to the system
  chooser when there is one, otherwise to path entry.
- Ask one dialog source at a time for the native entry: the shell bridge first,
  `uiWorkspace.pickDirectory` only when the bridge is absent or fails. A cancelled
  dialog is an answer and is never handed to the second source, so cancelling opens
  no follow-up dialog, while a broken bridge still falls through to a working Host
  verb. A source that never settles stays with the operator to dismiss — the client
  bundle is timer-free by contract, so no deadline can be imposed.
- Default to the entry that needs no typing: the system chooser where one exists,
  the in-app browser where the Host lists directories, and path entry only when
  neither is reachable. Path entry stays the pre-probe placeholder and is
  promoted once the capability answer arrives, never overriding a user choice.
- Assert executable-bit and unreadable-file behaviour only where the platform carries
  POSIX permission bits; Windows has neither, so those checks reported failures
  instead of uncovered behaviour. Path expectations use the platform separator
  throughout.
- Use portable fixture names (no newline in a filename, which Windows rejects), and
  make the handoff fixture's line endings independent of the runner: the source
  pins `core.autocrlf` before its first add, and the clone's working tree is
  re-materialised under the same pin. A fresh target clone must then read clean with
  the exact status command the engine's cleanliness gate runs — measured, because a
  Windows runner materialised the clone with endings that differed from the blob and
  every handoff preview failed as `TARGET_DIRTY` far from the cause.
- Compare worktree registrations canonically when verifying a checkout: Git reports
  `worktree list` in machine format, so a raw string comparison against the
  canonical root failed on Windows, where separators and short names differ. An
  entry that cannot be resolved now stays unmatched instead of turning a stale
  registration into a failure to enumerate.
- Use the platform separator in fixture ownership assertions and accept CRLF when
  parsing the checked-out client bundle, so the suites can pass on Windows.
- Test fixtures create their owned directories under one canonical temporary root.
  macOS resolves `/var` through a symlink to `/private/var` and Windows can return
  short or differently-cased names, so fixtures that mixed `os.tmpdir()` with
  `realpath(tmpdir())` failed their own containment assertions on both platforms
  while passing on Linux. A filesystem that rejects non-UTF-8 names now reports that
  decoding coverage is not exercisable instead of failing the suite.

- Deferred, not implemented: serving directory listing from this plugin's own Host
  half, which would restore the in-app multi-folder browser on desktop. The design,
  the measured reason DSH's composed picker cannot serve both verb sets, and the
  test matrix to carry over are recorded in
  [docs/host-directory-listing.md](docs/host-directory-listing.md).

## 0.2.16 — Clearer folder-entry labels

- Rename the three Add entries so each states its interaction: **Browse for
  folders** (in-app multi-select), **Choose a folder…** (one folder from the
  system dialog) and **Enter a folder path**, in English and Chinese. The
  resource keys are unchanged, so only the visible text moves.
- Lock the mapping with coverage that reads the rendered options and fails when a
  value is missing, renamed or labelled like another entry.

## 0.2.15 — Capability-aware folder chooser

- Resolve the native add option from the picker that really exists in the current
  session instead of a fixed dropdown entry: the desktop shell's renderer bridge
  first, then the Host directory-picker plugin's `uiWorkspace.pickDirectory`.
  Hide the option entirely when neither is present, and fall back to browsing if
  it disappears while selected.
- Keep the in-app browser and the manual absolute-path entry available in every
  session, including desktop, where the native option previously failed with a
  picker error.
- Add regression coverage for desktop, browser, missing and non-callable picker
  sources plus the unavailable-mode fallback.

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
