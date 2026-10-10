# @1yefuwang1/dsh-worktrees

Multi-folder projects with Local and isolated Git worktree threads for DeepSeek
Harness. This experimental Host + Web Client package is **`0.2.14`**; new releases
use staged npm publishing with maintainer review/2FA. It does not require Copilot, the
catalog plugin, or the search plugin. The scoped name avoids collision with the
unrelated npm package `dsh-worktrees`; stable tool, command and metadata names are
unchanged.

## Projects and threads

A **project** is a durable logical group containing one or more existing folders.
A **thread** belongs to that project and executes in one selected folder: either
its Local directory or a managed linked Git checkout. Project membership is not
native Workspace membership, a working-directory change or a permission grant.

- The native sidebar navigation places the view switch between **Automation tasks**
  and **Worktrees**. Its destination label is **Switch to Projects View** or
  **Switch to Workspace View**; switching leaves the current conversation intact.
- The compact **Projects** header uses Search, View options and Add project icon
  controls. Search appears only when opened; Escape/Close clears it and restores
  focus. Archive filters are in View options, not an always-visible dropdown.
- The **Projects** sidebar lists project headers and their Local/worktree threads
  together, using the native Folder view's open/closed workspace icons, regular
  14px session titles, compact last-active times and 12px **Show X more sessions**
  controls. Dates use session activity, not project edits; counts reflect only
  hidden sessions. Hover/focus reveals row actions without permanently reserving
  their width. Activity uses the native neutral 14px animated ring (including
  reduced-motion behavior); pending/completion use solid state dots. A permanent
  branch/worktree icon separately identifies managed worktree backing,
  independent of whether a row is hovered. Worktree/branch names are not shown
  inline; hover the thread title or worktree icon to see them, or open thread
  details. The accessible label and details retain the original folder and actual
  execution directory; branch names are cached
  last-known values, not a background Git status poll.
- Existing Local native workspaces are imported as one-folder projects. Managed
  checkout workspaces are grouped under their source project, not promoted into
  separate projects. **Edit project** can combine imported folders into an
  explicitly named multi-folder project without moving files, sessions or logs.
- **Create project** uses a compact project-name field and **Source folders** card.
  Click **Add** to browse Host folders, check several folders (including folders
  from different directories), then add the batch. Selections survive directory
  navigation. Repeat Add to extend the list; each selected folder shows its name,
  full path and a remove action. A project supports **1–32 folders**; duplicate
  picks are ignored and over-limit batches are refused without dropping entries.
  The source dropdown also offers manual absolute paths and the optional native
  system chooser (one folder per pick). Use **Cancel** to discard unsaved edits;
  saving/native picking blocks dismissal until it settles, and Host refusals preserve the
  draft. The same folder-list design is used by **Manage project**. Removal edits
  membership only, never deletes files; ownership/use restrictions remain Host-
  authoritative. Canonical aliases are checked by the Host, not guessed in the UI.
- **Main folder** is required when creating a new multi-folder project in the GUI.
  Choose it in Create/Manage project; a one-folder project uses its only folder.
  The choice is saved by stable folder ID, so reordering folders does not change
  it. Existing projects without a choice adopt their first folder on upgrade.
  Changing main never moves or rebinds existing conversations or worktrees.
- The project's **+ / New Thread** uses the normal new-conversation flow in its
  main folder. Use the adjacent folder arrow to start in another project folder,
  or change **Conversation folder** in an empty blank composer before typing or
  attaching files. An override is per conversation and never changes main. Drafts,
  attachments, queued work and active setup block folder switching. The native
  workspace picker/editor stay installed; there is no first-message dialog.
  Choose **New worktree** before the first Send; mode selection only changes
  intent and leaves the native draft/chips/files intact.
- Search, pinned order, running/pending indicators, archived-thread access and
  native row actions remain available. Installed row extensions are mirrored into
  plugin-owned aliases through public slot APIs; native entries and declarations
  are never changed. The footer **Folder view** switch restores the original
  native browser; **Projects** switches back. Plugin unload restores native UI.
- **Manage project → Remove project** asks for confirmation and removes only the
  logical project and its folder/thread associations. Source folders, files,
  native workspaces, conversations, managed worktrees and start receipts are kept,
  even if threads are running. Conversations remain available under **Other
  threads** and **Folder view**, with permanent worktree icons and path/branch
  details. Cancel keeps all unsaved edits; failures preserve the editor draft.
- Removal remains effective after refresh/restart: a minimal durable removal
  receipt suppresses automatic folder import and repairs interrupted metadata
  cleanup. The project storage domain remains additive v1. To group the retained
  folders again, explicitly create a project with a fresh UUID; existing native
  folder identities and conversations are reused. Removed UUIDs are not recycled.
- A folder has one project owner. Explicit custom-project conflicts are refused;
  imported ownership can be adopted. Removing individual folders from a retained
  project is still refused if they have threads, worktrees or start receipts;
  removing the project itself is metadata-only and has no such restriction.
  Existing cwd values and history stay immutable.

For a multi-folder project, only the **selected Git folder** is isolated in a new
worktree. Other folders still refer to Local directories; the plugin does not
clone/synchronize every repository or loosen filesystem policy. The agent's
native **system reminder** states the project, main/default folder, actual selected
source folder, execution directory and truthful thread backing. Its bounded
folder list includes IDs and Local paths (first eight plus main/selected when
needed, at most ten); omitted folders/truncated values are marked, and an exact
`workspace_project` list request retrieves full metadata. Main/folder edits appear
on the next prompt assembly from cached metadata, without scanning repositories
or injecting user messages. Membership and defaults do not grant permissions.

All these changes are plugin-only. Native Workspace records retain their exact
canonical execution paths; DSH core and the application shell are not modified.

## New Conversation: Local or New worktree

Start a new conversation through the default UI. Its **normal composer** offers
**New worktree** only after its actual selected folder passes local Git validation
and has a configured remote. Ordinary non-Git folders, unverified/unsupported
sources and failed checks show **Local** only, with no remote-branch controls.
Git repository subfolders remain eligible; no `.git`-directory heuristic is used.
The workspace picker, rich editor, attachments, native Enter/Send and rollback
stay installed; there is no separate first-message dialog.

A ready blank target performs one coalesced authenticated read-only status request
(several bounded local Git commands), not fetch/remote advertising, naming,
checkout or session creation. Observations are cached for the exact actor binding,
selected folder and connection generation. Target/view/panel changes, reconnect
and disposal abort stale reads. Main/title/token changes do not poll Git; failed
checks leave Local usable. Fresh configure/Send discovery remains authoritative
and can revoke an earlier positive. If New was already selected, revocation
preserves that intent and refuses Send safely until you explicitly choose Local.
A positive observation is not a permission grant or guarantee of remote/fetched-
tree support; normal creation checks still apply.

1. Choose **New worktree**. This only selects the mode: no Git work, checkout,
   branch, setup request or naming inference is performed on selection. Existing
   draft text, reference chips and attachment objects stay in their native editor.
2. Write your first ordinary message and press the **native Send** button (or its
   native keyboard gesture). Native command adjudication and chip serialization
   run first; claimed/handled commands keep their original command path and do
   not provision a checkout.
3. A full-width progress panel shows **Fetching latest remote branch → Creating
   worktree → Generating and applying branch name**. The Host freshly fetches the
   chosen base, creates a random directory/initial local branch, then runs the
   configured fast auxiliary naming model and renames only that branch. Naming
   completes before the new conversation receives the prompt.
4. After the named checkout and exact blank session are ready, generic file drafts
   are re-uploaded for that exact session (receipts cannot cross sessions). The
   original, natively serialized prompt and ordered attachments are admitted once
   to the **normal conversation LLM**, then that conversation opens.

The checkout directory, execution cwd, pinned base and session identity do not
move during naming. Naming uses `github-copilot/gpt-6-luna` by default, independent
of the normal conversation model. The foreground naming deadline is at most
15 seconds (or a shorter configured deadline); unavailable or invalid output
uses a deterministic safe fallback, never another-model retry.

The optional **Base branch** control explicitly reads advertised branches so you
can choose any configured remote/base before Send. Selecting the worktree mode
itself does not query Git. `origin`/`main` are preferences, not restrictions. The
actual checkout always uses a fresh selected-branch fetch; failed fetches never
substitute cached commits. Only the selected project folder is isolated.

Progress uses bounded, event-driven wait requests over authenticated Connection
RPC, not periodic status polling. Preparation holds message admission and shows a
Cancel action; it does not freeze navigation or invoke the normal LLM early.
Failures return through native draft/chip restoration rather than a replacement
editor. A created checkout is retained if preparation or admission is cancelled.
Unknown admission is never blindly resent: inspect/open the exact created session.

### Guarded native submission adapter

The installed runtime has no public ordinary-message target-resolution hook.
This version uses the **explicitly approved version-pinned adapter**: it leases
only the per-session native submit sink plus the trigger-controller thunk needed
to capture Send-time intent before asynchronous codecs/adjudication. The editor,
command machine, serialization, undo/rollback and normal prompt transport remain
native. No core file, global business service, native endpoint, keyboard handler
or other plugin's DOM is replaced.

Compatibility is the exact manifest/peer pin to DSH `0.2.0-rc.2` **plus structural
callback/owner checks**, not a runtime-source fingerprint or an upgrade-stability
claim. Missing/changed shapes fail closed rather than sending a worktree-selected
prompt to Local. Descriptor ownership is identity-checked on teardown; pending
attempts settle before restoration. Future runtime upgrades require reviewing this
adapter. Do not grant a version exemption to bypass that compatibility boundary.

### Configurable automatic naming

Naming uses a small auxiliary call independent of the conversation model. Defaults:

```yaml
namingEnabled: true
namingProvider: github-copilot
namingModel: gpt-6-luna
namingTimeoutMs: 15000
namingMaxTokens: 256
```

These are plugin Config fields, not another New Chat form. The first ordinary
prompt is bounded before branch naming. Inference happens only after successful
fresh fetch and checkout creation, and the exact generated result is persisted
before rename; ready same-operation replay does no fetch, inference or creation.
The foreground deadline is `min(namingTimeoutMs, 15000)`. Disabled/unavailable,
timed-out or malformed naming yields a safe deterministic branch name and can
consume no more than the bounded configured auxiliary call.

The directory remains the random `worktree-<UUID>` name; the record's
`naming.directoryName` is suggestion metadata, not its actual basename. Session
titles stay with the native title feature. A branch collision or changed initial
branch is not forced; preparation fails and retains its receipts/files.

Explicit command/tool `create` with `firstPrompt` uses the same checkout-first
foreground naming order. Legacy no-`firstPrompt` tool creates may still use the
previous post-first-message naming path (with its idle/maintenance checks); the
new lazy UI supplies `firstPrompt` and never schedules that background rename.

## Manager, reminders and guarded Local handoff

The advanced **Worktrees** sidebar panel shows recorded checkouts, fetched bases,
current/last-known branch and dirty state, conversations, protection, archive
state and errors. The started-conversation header reads cached project/backing
metadata only; there is no Worktrees button beside the project name in the chat
header. Open the manager from its sidebar entry, with no background Git query.
A ready blank conversation checks only its actual target's local Git availability;
Local mode sends no setup/fetch and remains usable if discovery fails. There is no
sidebar-wide or per-token Git polling. Project metadata refreshes on connection
generation, explicit edits and structural native Workspace changes, not per render/token or timer.
UI requests use the existing authenticated Connection RPC transport, not the
slash-command registry. The plugin owns exact POST routes
`/api/dsh-worktrees/projects`, `/api/dsh-worktrees/execute`,
`/api/dsh-worktrees/prepare` and `/api/dsh-worktrees/progress`, preserving the
public RPC envelope/correlation. It does not claim the shared `/api` interceptor,
which is exclusive and already belongs to the native API gateway. Selecting New worktree, opening or refreshing the manager,
reading checkout status and cancelling a UI request therefore create no
`command/run` or `command/done` conversation rows. Explicit user-entered
`/worktree` commands and agent `git_worktree` calls remain visible normally.
There is no periodic polling; actor identity and filesystem authorization are
unchanged, and UI errors are shown inline. Existing historical rows are not erased.
Agent runtime-context reminders are separate from these UI queries.
Open an exact conversation, create a branch in the worktree, protect/unprotect it,
or archive/restore its plugin record. **Archive is not deletion**: checkout files,
pinned base refs, sessions and logs remain. Protection prevents branch creation,
handoff and archiving until explicitly removed; it is not an OS write lock.

For handoff, open a conversation belonging to the chosen worktree first:

1. Stop all writers in both checkouts, including external editors, processes,
   terminals, jobs and other sessions.
2. Preview the patch relative to the saved fetched base. The default target is
   the original Local checkout; an optional explicit Local path must pass the
   same repository and identity checks.
3. Review changed files, binary markers, byte count, base identity and retained
   patch path. Export can return bounded inline text; for a large patch, copy the
   retained path. No unauthenticated download endpoint is invented.
4. Explicitly confirm that other writers are stopped, then apply and continue in
   the exact Local continuation returned by the Host.

Handoff requires Full access, idle known source/target sessions and a clean
Local checkout at the saved base. It checks repository identities, source/target
fingerprints, patch integrity and optimistic preconditions, and obtains Host
maintenance claims for known sessions. It never pulls, resets or switches the
Local branch to make a mismatch fit. **It is not globally atomic**: outside
writers must remain stopped through completion. Applying from an agent tool in
its own running source turn is unsupported and returns `BUSY`, rather than
waiting for that turn to become idle. Use the idle GUI command path instead.

Sources, original history and retained patch files are not deleted. Continuation
uses the normal fork seed through the last completed turn, not a log rewrite;
older paths in inherited history may refer to the original checkout. Normal
preset/model/permission/approval/plan and Goal semantics remain authoritative;
the plugin does not reinterpret Goal state or grant permission through a copied
history or a confirmation checkbox.

## Permissions, supported repositories and limits

**Cross-root Git mutations are Full-access-only.** Creation, starting a session
in a recorded checkout, branch creation, preview/export (which write snapshots),
and handoff require the receiving ordinary session's existing `danger-full-access`
policy. Shared Git administration cannot be honestly confined to a single
workspace-write checkout. List/status/branch discovery use the caller's managed
filesystem/subprocess capabilities and may still be refused by its sandbox.
Protect/archive change plugin metadata rather than deleting repository data.
Agent mutation tools are refused while plan mode is active or pending enabled.

The GUI never creates a more-privileged blank actor to bypass the current
conversation's policy. Without a usable current ordinary conversation, the root
manager asks you to open one. An acknowledgement confirms user intent only;
change permissions through the existing permission control if needed. No
privilege flags or automatic escalation are supplied.

Supported: ordinary non-bare, non-shallow local Git repositories with a committed
HEAD, canonical local filesystem/subprocess execution, and HTTPS, SSH or local
file remotes. Repository files must fit the configured count/byte bounds and
supported UTF-8 paths/mappings. Git authentication uses existing noninteractive
Git transport configuration; the plugin does not add a sign-in or password prompt.

Unsupported cases fail explicitly, including:

- Git LFS and clean/smudge filters or working-tree encoding attributes;
- sparse checkouts, partial/promisor clones, shallow clones, submodules and
  unsupported/custom Git worktree or ref-storage mappings;
- unborn/bare repositories, executable remote helpers, unsafe/escaping paths or
  symlinks, unmerged files, and unavailable project subdirectories;
- remote filesystem execution providers without the required local capability
  mapping, stale previews/cursors, changed remote identities, or over-limit output.

Hooks, external diff/fsmonitor and recursive submodule behavior are suppressed
for plugin Git operations. This is not a claim that arbitrary configured Git
transports or external writers are globally sandboxed in Full access.

## Cancellation and recovery

Cancellation is not destructive rollback. A fetch, checkout, registered session,
or applied patch may already be committed when cancellation arrives. Inspect
**operation status** and the manager before retrying; recovery-required records
are retained with errors. A successfully committed operation replay with the
**same immutable request and operation UUID** returns its original session and
fetched commit, rather than allocating another blank session or fetching again.
Changed settings, changed request or a new fresh preparation require a new UUID.

The adapter never writes/clears the source draft; native submit machinery owns
its optimistic commit and exact chip-aware rollback. Its temporary message block
is released after preparation/admission settlement, cancellation or disposal. If creation has an
uncertain outcome, **Check operation status** uses the same UUID before another
creation is allowed; an exact created conversation can be opened without sending
a message. Progress/transport receipts are scope-local and bounded to the latest
128 terminal operations; durable controller receipts own recovery after reload. Re-preview after Host restart: preview registrations and page cursors
are transient, even though snapshot files and durable operation/worktree records
are retained. Deferred naming receipts are durable and tied to the exact original
first message, not later messages or inherited/replaced history.

There is no physical worktree-delete operation. Disabling/removing the plugin
does not remove checkout files or rewrite original session logs. Any manual Git
cleanup is a separate user-owned task after inspecting identities and retained
records; do not infer cleanup authority from an archive flag.

## Install from this repository

Requires DSH/DSH peers `0.2.0-rc.2`, Node.js `>=22.19.0`, a suitable local Git
executable, and the ordinary session/filesystem/subprocess/sandbox/preset/plan
capabilities. The manifest names `@deepseek-ai/dsh-agent-preset-registry` and
`@deepseek-ai/dsh-plan-mode`; the Web Client mounts beside the existing
conversation/workspace UI. Development uses pnpm `11.7.0`.

After the staged release is approved and appears on npm, install the scoped
package (the similarly named unscoped package is unrelated):

```sh
dsh plugin --profile <profile> add @1yefuwang1/dsh-worktrees@0.2.14
```

For local development or while release approval is pending, build explicitly from
the private monorepo root, then opt into a local leaf installation:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @1yefuwang1/dsh-worktrees run build
# Alters the chosen profile only if you choose to run it:
dsh plugin --profile <profile> add -w packages/worktrees
```

Or build a standalone tarball:

```sh
pnpm --dir packages/worktrees pack --pack-destination ../../artifacts --config.ignore-scripts=true
```

The root Git URL is not an installable plugin. The package contains compiled ESM,
declarations, its plain-JS Client factory, bundle patch, metadata, docs and license;
there are no required `prepare` or install-time build scripts. Follow the plugin
manager's activation/restart result and refresh the existing GUI when needed;
no automatic Client updates without the normal development watcher are promised.
Development checks never install/configure an active profile or start a server.

## Configurable worktree root folder

Open the **Plugins** page, choose **Projects and worktrees**, then configure its
**git-worktrees** entry. The **Worktree root folder** field edits the active
profile's existing `root` setting through native Host-backed settings. Enter an
absolute Host folder path outside your source repositories and choose **Save**.
**Reset to inherited default** removes only the root override. The default is
`worktrees/` under the harness home (normally `~/.dsh/worktrees`).

After this version is activated, saved root changes apply to **new creates live**;
there is no directory migration. An operation captures its root once at admission,
so a save during fetch/naming or a repository queue does not relocate that create.
Existing threads, working directories, retained files and same-operation replays
keep their original paths and identities. Saving this setting does not create a
folder, fetch Git, or grant filesystem permission.

The form uses native revision fences; conflicting/refused writes preserve the
path draft. Non-Host-backed/remote-browser forms are unavailable rather than
pretending to persist locally. Private snapshot/export/handoff storage remains
pinned to the root resolved at this plugin load, preserving existing previews;
the next normal Host/plugin load adopts the persisted root for those snapshots.

## Configuration and command/tool surface

The bundle inserts the `git-worktrees` Host entry. Change its supported config
through normal profile composition/settings, not the plugin's package files.

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | Harness home `worktrees/` | Persisted native settings field for new worktree directories; absolute Host path, outside source repositories; snapshots retain their load-time root |
| `gitExecutable` | `git` | Executable resolved by the managed subprocess provider |
| `defaultRemote` / `defaultBranch` | `origin` / `main` | Initial preferences, never an allowlist |
| `commandTimeoutMs` | `30000` | Git command deadline |
| `fetchTimeoutMs` | `60000` | Advertisement/fetch deadline |
| `operationTimeoutMs` | `120000` | Overall operation deadline |
| `maxSnapshotBytes` | `33554432` | Snapshot byte limit (32 MiB) |
| `maxFiles` | `1000` | Repository/snapshot and advertised-branch count limit |
| `maxRefBytes` | `8388608` | Bounded Git output (8 MiB) |

The `/worktree` command and `git_worktree` agent tool share the Host controller.
Commands accept `<action> [JSON arguments]` or one JSON request object; no input
means `list`. IDs and operation/preview IDs are UUIDs. Example read operations:

```text
/worktree status
/worktree list {"includeArchived":true,"limit":50}
/worktree branches {"remote":"upstream","query":"feature","limit":50}
```

Actions: `list`, `status`, `branches`, `create`, `start`, `branch`, `protect`,
`archive`, `preview`, `export`, `handoff`. `repoPath` defaults to the caller's
execution directory where supported. `create` requires a new `operationId`,
remote and remote branch; the UI also captures remote identity/settings hash and
requires an unchanged blank source. `sessionMode: "new"` starts empty history;
`"continue"` inherits through a completed turn. `status` can inspect a worktree
`id` or an `operationId`, not both. `export` consumes a retained `previewId`;
`handoff` requires that preview and its own operation UUID.

The Client uses authenticated quiet Connection RPC, not commands. Git requests
resolve the actual selected ordinary session; metadata-only project reads omit an
actor and never resume a conversation. UI Local creation delegates to the native
new-session service; it is never a fallback actor for Git operations. The explicit
project `start` operation remains available to commands and tools.
Versioned results are `{v:1,ok:true,data:...}` or
`{v:1,ok:false,error:{code,message}}`; transport and decode failures are shown inline.
Explicit commands remain normally logged.

`/project` (one JSON action object) and `workspace_project` share the project
controller: `list` (optional `projectId` filter), `create`, `update`, `remove`,
`bind`, and `start`. `remove` takes only `projectId` and returns
`{removed:true,projectId,scope:"project-metadata"}`. Repeating a committed removal
is safe; it never deletes directories, sessions or Git data. UI removal uses the
actual authenticated operator without activating an unrelated conversation;
commands/tools retain their genuine caller and normal mutation policy.
`create` takes a fresh UUID `id`, title and absolute existing `folders`.
Optional `mainFolder` is an absolute path matching a resulting source folder
canonically; omitted create uses first for API compatibility. `update.folders`
replaces the complete list; `update.mainFolder` can change only the default.
Omitted update preserves main across reordering; removing it with multiple folders
remaining requires a replacement (a sole remaining folder becomes main).
Snapshots expose `mainFolderId`. `bind` validates actual ordinary cwd/backing;
it cannot move a session. `start` takes a unique `operationId`, `projectId` and
optional native `folderId`: omitted uses main, explicit selects another folder.
It returns an exact blank session and never sends a prompt. Ready replay uses
its original receipt folder/session even after main changes; ambiguous partial
starts refuse duplication. `git_worktree create` accepts paired
`projectId`/`folderId`; the selected original folder must match its creation path.
Project metadata never grants Full access; cross-root thread starts retain caller
checks and tool mutations respect active/pending plan mode.

Public ESM exports are the root plugin/config/types, `./git`, `./naming`,
`./projects`, `./types`, `./client`, `./package.json` and `./locale/en.json`.

## Verification and release status

```sh
pnpm --filter @1yefuwang1/dsh-worktrees run test
pnpm --filter @1yefuwang1/dsh-worktrees run test:integration
pnpm --filter @1yefuwang1/dsh-worktrees run test:types
pnpm --filter @1yefuwang1/dsh-worktrees run test:pack
```

Unit/protocol tests and temporary local-Git fixtures are not a live GUI, remote
credential or transport-compatibility probe. Client tests are static/pure protocol
checks, not a fake DOM or screenshot renderer. Browser interaction, visible slot
registration and light/dark appearance still require verification in the installed
GUI; they were unavailable during initial Client implementation.

Release tags use `@1yefuwang1/dsh-worktrees-vX.Y.Z`, matching this leaf's full scoped
name and version. The shared release gate/staged OIDC workflow never publishes the
private root or all leaves together. The workflow stages the release; a maintainer
reviews and approves it with npm 2FA before the version becomes publicly available.
See [the package changelog](<CHANGELOG.md>) and [MIT license](<LICENSE>).
