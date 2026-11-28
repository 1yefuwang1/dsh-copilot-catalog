# Monorepo changelog

## Better Copilot 0.5.8 — Request-carried request bodies reach the wire transform

- The `0.5.7` empty-text repair was unreachable in a real DSH host. DSH's fetch
  observer replaces `globalThis.fetch` and re-dispatches every call as one
  `Request`, and the plugin's transform only read `init.body` when it was a
  string, so `(Request, undefined)` skipped every body stage: empty-text removal,
  the Gemini tool default, temperature omission and Responses strictness.
  Identity headers kept working because they read the Request's headers, which
  hid the gap: requests looked repaired-by-default until a poisoned transcript
  hit the route.
- The wrapper now reads the body from either encoding, cloning a Request-carried
  body so the caller's object stays unread, and dispatches a rewrite as a new
  `Request` built from the caller's one with fresh framing. Streams, `Blob`,
  `FormData`, bodyless and consumed requests stay byte-identical.
- Regression coverage: wrapper tests for both encodings plus an integration test
  that mounts the plugin under an observer-style fetch and asserts a pi-ai stream
  still emits a repaired body. That test fails against `0.5.7`.
- `0.5.8` keeps every runtime baseline, configuration group, cache domain/version
  and credential record key unchanged; no migration or reset is required.

## Better Copilot 0.5.7 — empty-text repair and a single-pass wire

- Repair the `chat/completions` rejection that reports only
  `400 {"error":{"message":"invalid request body","code":"invalid_request_body"}}`
  when a `user`, `system` or `developer` message carries the empty string as its
  content. A retry that carries no content is persisted as a message, so the turn
  invalidated every later request on that route until the model changed.
- Add the `messages` group — `dropEmpty` (default `true`) and `logFixes`
  (default `false`) — plus `normalizeCopilotMessages` and
  `applyEmptyMessageDrop`. Only the exact failing shape is removed: a
  whitespace-only string, an empty content array and empty assistant or tool
  messages all decode, so those stay byte-identical and a repaired body is
  idempotent.
- Run the repair inside the existing single wire transform so no second body
  installer can replace the tool-schema guard, and keep an all-empty history
  untouched rather than trading it for the route's separate
  `Request must contain at least one non-empty message.` rejection.
- Run every wire stage over one parse: Responses strictness, temperature
  omission, empty-text removal and tool-declaration defaults now mutate one
  parsed request and re-serialize at most once. A 2.52 MB request costs 2.37 ms
  instead of 5.50 ms, and each stage keeps its own scope and body-size bound.
- Raise the `dsh-better-copilot` publication allowlist to the two new modules and
  its packed-size bound to 345,000 bytes, measured at 332,712 for 70 files.
- Publish `0.5.7` through the package-specific staged npm release workflow; the
  staged version becomes available only after maintainer 2FA approval.

## Better Copilot 0.5.6 — live OpenCode Go model catalog

- Discover, replace and persist the `opencode-go` chat catalog from OpenCode's
  public `/models` listing. These are the same demand-driven rules as the Copilot
  account catalog: persisted-before-live startup, a 15-minute refresh interval,
  one bounded missing-model retry with a 60-second cooldown, and last-known
  retention when the listing fails.
- Newly released models (for example `kimi-k3.1-pro`) become selectable without a
  pi-ai upgrade; withdrawn ids stop being selectable. Installed descriptors are
  kept for known ids and built from listed protocol/capacity/cost/reasoning
  metadata for new ones.
- Add `catalog.providers` (default `['opencode-go']`); `catalog.cache` and
  `catalog.refreshIntervalMs` now govern both catalogs. Omitting the
  `opencode-go` route profile or an empty list disables its discovery.
- Keep the storage domain, cache format version and credential keys unchanged;
  OpenCode records add a `kind` discriminator and legacy Copilot records remain
  readable. The public listing sends no credential.
- Publish `0.5.6` through the package-specific staged npm release workflow; the
  maintainer's 2FA approval makes the exact package live. No live GUI or account
  testing is claimed for this release.

## Better Copilot 0.5.5 — DSH 0.2.2-rc.5 compatibility

- Target exact DSH and DSH peer packages `0.2.2-rc.5` for Better Copilot only.
  Worktrees and the root development SDK remain on `0.2.2-rc.1`.
- Audit the rc.5 delta: `dsh-web` prefers a route-specific DeepSeek search
  provider while none is configured and carries `llmProvider` on search requests,
  `dsh-llm` adds `CONTENT_REFUSED`, and the base profile no longer pins a search
  provider. The shipped bundle patch still selects `github-copilot-search`
  explicitly, so selection stays deterministic, and a new integration test
  registers a usable `deepseek-search-api` provider to prove the pin outranks
  rc.5's route preference. No runtime shim, configuration change or persisted-data
  migration is needed.
- Keep pi-ai peer `^1.3.0` (tested baseline `1.3.0`), Zod `4.6.6`, the existing
  config shape, the catalog cache domain/format and credential record keys.
- Publish `0.5.5` through the package-specific staged npm release workflow; the
  maintainer's 2FA approval makes the exact package live. No live GUI or account
  testing is claimed for this release.

## Better Copilot 0.5.4 — provider-aware subagent route badge

- Show the subagent's complete route inline in the Web session header:
  `github-copilot/gpt-6.1-sol · high` instead of only `gpt-6.1-sol · high`.
  Provider and model remain the Host's verbatim ids; an adapter-defaulted effort
  still renders as `default`.
- Size the badge for the longest advertised provider/model route and state in the
  tooltip and accessible name that provider, model and effort are fixed for the
  child's lifetime. Render tests cover the label, tooltip, accessible name and
  both locales, and `BC_CLIENT_BUNDLE` points them at an installed
  `dist/client.js`; no live GUI testing is claimed.

## Better Copilot 0.5.3 — explicit non-strict Responses defaults

- Default ordinary function tools to `strict: false` on trusted Copilot Responses
  requests, consistently across bundled, discovered and fallback models. Preserve
  explicit strict settings, custom/grammar tools and native tools.
- Enable explicit strict-field serialization for dynamically discovered OpenAI
  routes. Verify local plugin regression tests and live Copilot tool calls on
  GPT-6.1 Terra, GPT-6.1 Sol and Grok 4.7. No cache-hit benchmark is claimed.

## Better Copilot 0.5.2 — bounded stream-progress retry

- Add `streamGuard` with `enabled`, `providers` and an optional
  `noProgressTimeoutMs`. It defaults to enabled for `github-copilot` and to the
  route's `streamIdleTimeoutMs`, so it is not stricter than the existing idle
  watchdog unless configured.
- Count only content-bearing chunks as progress, so empty reasoning blocks and
  other control-only events cannot keep one attempt alive. On expiry, abort the
  attempt, close the inner iterator with a time limit and throw `TIMEOUT` so
  DSH's retry policy schedules the next attempt.
- Preserve caller cancellation as `ABORTED`, deliver a terminal finish chunk
  before any stall handling, and wrap both the direct and prepared adapter
  stream paths. Add unit and `LlmRuntime` integration coverage.

## Better Copilot 0.5.1 — DSH 0.2.2-rc.3 compatibility (local preparation)

- Target exact DSH and DSH peer packages `0.2.2-rc.3` for Better Copilot only.
  Worktrees and the root development SDK remain on `0.2.2-rc.1`.
- Keep pi-ai peer `^1.3.0` (tested baseline `1.3.0`), Zod `4.6.6`, existing
  configuration, catalog cache domain/format and credential record keys unchanged.
- Verify the existing adapter, search, storage, Auto review and subagent badge
  contracts against rc.3; no runtime API shim or persisted-data migration is needed.
  Update exact-host regression checks and the CI minimum-pi adapter override.
- Prepare `0.5.1` for the package-specific release workflow; no publication,
  profile installation, live GUI testing or account testing is performed.

## Better Copilot 0.5.0 — DSH 0.2.2-rc.2 migration (local preparation)

- Target exact DSH/DSH peers `0.2.2-rc.2`, pi-ai peer `^1.3.0` (tested
  baseline `1.3.0`) and Zod `4.6.6` for Better Copilot only. Root development
  SDK pins and Worktrees remain on `0.2.2-rc.1`; no compatibility exemptions.
- Retain account catalog caching/live refresh, native Responses search, wire
  identity, Gemini schema guarding, temperature normalization, builtin Auto
  review overrides and the read-only subagent badge. The rc.2 audit found the
  search-provider/WebError contracts, bundle IDs, session badge slot and
  `modelSelection` wire shape (`lastUsed`, `next`) compatible.
- Document rc.2's native search-provider picker and provider directory. No new
  custom UI or metadata feature is introduced.
- Preserve configuration, cache domain/format version and credential record
  keys; persisted account caches need no migration.
- Distinguish the DSH CLI/host Node.js minimum (`>=24.9.0`) from the unchanged
  plugin library/helper minimum (`>=22.19.0`).
- Version `0.5.0` is staged for npm under the package-specific release
  workflow. No live GUI or account testing is claimed.

## Better Copilot 0.4.0 — persistent catalogs and live refresh

- Retain the last successful account model list in DSH's optional persistent
  `dsh_better_copilot_catalog` domain, isolated by hashed credential identity and
  validated endpoint. Persist only bounded model metadata, never credentials;
  reject malformed, foreign, future or more-than-seven-day-old cache entries.
- Add volatile `catalog.cache` and `catalog.refreshIntervalMs` settings with a
  15-minute demand-refresh default and a 60-second missing-model cooldown.
  Update the active adapter registry without resetting already-prepared calls.
- Reuse cached metadata on startup/network failure, deduplicate refresh callers,
  guard cancellation/account changes/unload and report unavailable builtin
  reviewers without silently switching models.
- Validate real DSH storage reopen and adapter behavior, preserve independent
  search/guard capabilities, and extend the exact publication allowlist.

## Better Copilot 0.3.0 — builtin review overrides

- Add configurable builtin Auto review model and reasoning effort. GitHub
  Copilot defaults to `gpt-6.1-terra`; DeepSeek Flash stays on Flash. Conversation
  routing and the builtin authorization policy remain unchanged.
- Omit the builtin reviewer's Copilot sampling parameter without positive
  temperature support; ordinary inference omits it only for explicit unsupported
  catalog metadata. Share the existing trusted wire transform with the Gemini
  guard and preserve independent capability containment.

## Better Copilot 0.2.0 — read-only subagent route badge

- `dsh-better-copilot@0.2.0` gains a browser client half that shows an
  addressed subagent's fixed model and reasoning effort in the Web session
  header, beside the title. The badge is text only, reads the existing
  `modelSelection` Session projection, and leaves ordinary conversations and
  the DSH-rendered subagent catalog unchanged. The leaf now ships `./client`
  and a `dsh.client` declaration.

## DSH 0.2.2-rc.1 compatibility

- Retarget both plugin engines, DSH peers, development SDK pins and the Cordis
  and schemastery peers to the `0.2.2-rc.1` host baseline (`cordis` `~4.1.0`,
  `cordis-plugin-include`/`-loader`/`-group` `1.1.0`, `schemastery` `~3.19.0`).
  Release `dsh-better-copilot@0.1.1` and `@1yefuwang1/dsh-worktrees@0.2.28`;
  refresh the pnpm lockfile and the version-specific release-age allowlist.
- Re-home the Gemini tool-declaration guard to the Copilot wire. `0.2.2-rc.1`
  makes `system-prompt/assemble` presentation-only and re-attaches
  provider-owned tool declarations after the waterfall, so a listener can no
  longer rewrite them. The guard now normalizes the serialized request body
  inside the existing refcounted Copilot interceptor, which is installed,
  trusted-path checked and released independently of the header identity. The
  `toolSchema` configuration, route/family matching, controlled reason codes and
  `logFixes` summaries are unchanged, and a guard failure leaves the request
  byte-identical.
- Port worktrees to the `0.2.2-rc.1` native submit ABI
  (`0.2.2-rc.1/default-sink-v3`): the leased sink takes the native acceptance
  callback, replacement bodies drop stale framing headers, and the port keeps
  the shell's own transaction ownership instead of restoring drafts the shell
  never detached. Update the pinned ABI, the native source checks and the
  harness fixtures accordingly.
- Adapt to renamed or moved host APIs: the branded `ModelSelection` effort id,
  the `llm-pi-ai/request-headers` waterfall, the `ToolsService` batch
  execution/`isConcurrencySafe` scheduling surface, `assertSupportedJsonSchema`
  replacing the removed tools-SDK renderers, `SessionProjections.register`
  handles acquired in asynchronous service init, a required selected tool
  executor, and the sprite-based native icon artwork.
- Raise the worktrees publication version and keep the exact 43/52-file
  allowlists; `dsh-better-copilot` gains `guard.ts`'s request-body normalizer
  while `./guard` keeps publishing its classification primitives.

## Better Copilot 0.1.0 — three Copilot plugins merged into one

- Add `dsh-better-copilot@0.1.0`, consolidating `dsh-copilot-catalog@0.2.9`,
  `dsh-copilot-search@0.1.5` and `dsh-copilot-tool-schema@0.1.3` into one package,
  one bundle row (`better-copilot`) and one configuration object:
  `providers` (the pi-ai adapter's own schema), `search` (the former search row
  settings) and `toolSchema` (the former guard settings).
- Preserve behavior: adapter replacement with the discovered Enterprise endpoint as
  a runtime default, the refcounted Copilot `fetch` identity interceptor, the
  `github-copilot-search` provider with its guarded refresh transport and
  cancellation handling, and the additive Gemini tool-declaration guard.
- Contain capability failures: a missing web service, a throwing guard
  registration, a throwing search registration and a throwing identity installer
  each degrade only their capability; the adapter still mounts.
- Pipeline: fold `./catalog`, `./discovery`, `./identity`, `./search` and `./guard`
  into the merged package, keep the root `syncCopilotCatalog()` convenience
  wrapper, and export the colliding `CopilotAuthOptions` type as
  `CatalogAuthOptions`/`SearchAuthOptions`. The predecessor subpaths are removed.
- Remove the three predecessor workspaces, their bundle patches, publish policies,
  release identities and credential-audit exemptions; the merged leaf has its own
  exact 43-file publication allowlist and a 220,000-byte bound.
- Their published npm versions are unchanged and are not deprecated by this
  repository; the migration table lives in the package README.


## Worktrees 0.2.27 — no branch selection in Local mode

- Render the starting-branch picker only for New worktree. A Local thread runs in
  the current checkout and never chooses, switches or creates a branch, so Local
  mode now shows that checkout's actual current branch read-only instead of an
  interactive picker, and switching back to Local no longer displays a previously
  chosen New starting branch as if the Local thread would use it.
- Keep the New worktree picker, its Local/Remote source switch, search, paging and
  refresh behavior unchanged; retain the 0.2.26 branch `release` action and the
  DSH `0.2.1-rc.5` compatibility surface.

## Worktrees 0.2.26 — branch ownership and release

- Add a `release` action to `git_worktree`, `/worktree` and the authenticated UI
  RPC. Git permits one checkout per local branch; release transfers a branch away
  from a plugin-managed checkout, re-homing it to that checkout's own branch or
  detaching it at the same commit, so the original Local checkout can switch to the
  branch again. Files, index state and every ref are verified unchanged.
- Report branch `holders` in `reopen-info` and accept an explicit
  `reopen` `takeover` that performs the same transfer before switching; the manager
  shows the branch Git reports beside the recorded branch and offers release when
  they differ. Requires Full access, a ready record and idle holder runtimes, and
  never touches a worktree the plugin does not manage.
- Raise the worktrees publication size bound to 875000 bytes for the rc.5 client
  bundle; the exact 52-file allowlist still governs the tarball.

## DSH 0.2.1-rc.5 compatibility

- Retarget all four plugin engines, DSH peers and development SDK pins to
  `0.2.1-rc.5`: catalog `0.2.9`, search `0.1.5`, tool schema `0.1.3`, and
  worktrees `0.2.25`.
- Refresh the pnpm lockfile and version-specific release-age allowlist; align
  Cordis include/group development peers with the target host.
- Strengthen the shared SDK baseline checks and test rejection of neighboring
  prereleases without compatibility exemptions.
- Include the existing adapter-relative nested-layout regressions in normal
  catalog/search integration verification.
- Adapt worktrees to rc.5 pre-detachment first-Send capture and synchronous cold
  Agent setup-completion commits before persistence, preserving native submit
  semantics and the existing input holds through later publication.
- Keep the worktrees 50-file publication allowlist unchanged; increase only its
  size cap from 825 kB to 850 kB for the approximately 828 kB compiled package
  and compatibility documentation. Other package limits are unchanged.

## DSH 0.2.1-rc.3 compatibility

- Retarget all four plugins to DSH and DSH peer packages `0.2.1-rc.3`: the root
  development pins, each `engines.dsh`, peer/dev dependency pins, the pnpm
  release-age allowlist and the regenerated lockfile.
- Release catalog `0.2.8`, search `0.1.4`, tool-schema `0.1.2` and worktrees
  `0.2.24`. No runtime behavior changes; worktrees renames its guarded native
  submit ABI to `0.2.1-rc.3/default-sink-v1`.
- rc.3 keeps the Host packages' published API unchanged and adds client-side
  contracts (draft `whenDraftExists`/`appendDraft`, View pin/More rows, the
  submission preset snapshot). The existing structural boundaries need no code
  change.

## dsh-copilot-catalog 0.2.7 — exact pi-ai behavior headers

- Preserve `X-GitHub-Api-Version`, `Openai-Intent`, `X-Interaction-Type`,
  `Content-Type`, and `X-Interaction-Id` exactly, including absence, on every
  matched request; remove the `/models` behavioral exception and API-version fill.
- Keep identity masking and SDK-fingerprint removal unchanged. 0.2.5 and 0.2.6 are
  superseded.

## dsh-copilot-catalog 0.2.6 — restore pi-ai behavior

- Revert 0.2.5's agent/API-version normalization: normal inference/search preserve
  pi-ai/search's `conversation-edits` intent and the `2026-06-01` API-version pins;
  absent headers are still filled and model discovery remains `model-access`.
- Keep identity masking and SDK-fingerprint removal unchanged. 0.2.5 is superseded.

## dsh-copilot-catalog 0.2.5 — agent interaction identity

- Normalize normal inference/search `Openai-Intent` and `X-Interaction-Type` to
  `conversation-agent`, rewriting the generic `conversation-edits` value while
  preserving explicit subagent/compaction (and other specialized) metadata.
- Set `X-GitHub-Api-Version: 2026-08-01` on all matched requests, including search
  and model discovery, matching copilot-api; model discovery remains `model-access`.
  All 0.2.4 identity, installation, and mode behavior is unchanged.

## dsh-copilot-catalog 0.2.4 — Copilot wire identity

- Add a refcounted process-wide `fetch` interceptor that removes DSH's
  `deepseek-harness` User-Agent and the SDK `x-stainless-*` fingerprints from
  Copilot requests while the catalog adapter is mounted.
- Emit the installed official client's identity headers and preserve auth/protocol
  headers, search/discovery API-version and intent pins, and nonempty caller
  interaction metadata.
- Add `DSH_COPILOT_WIRE_IDENTITY=basic|full|0`; `full` is the default and reads the
  local VS Code device/machine IDs, `basic` skips them, and `0` disables the
  interceptor. Config, credentials, routing, and model descriptors are unchanged.
- Cover exact Request/init header replacement, stream/duplex/abort preservation,
  single-invocation downstream failure, install/release ordering, cached wrappers,
  external fetch replacement, native Messages betas, and trust/path boundaries.

## dsh-copilot-catalog 0.2.3 — DSH 0.2.1-rc.2 compatibility

- Retarget runtime pins to DSH/pi-ai `0.2.1-rc.2`, Cordis `~4.0.5`, Schemastery
  `~3.18.5` and pi-ai `^1.1.0`; keep adapter-relative pi-ai resolution.
- Add nested-layout and host-aligned pi-ai coverage without changing catalog exports.

## dsh-copilot-search 0.1.3 — DSH 0.2.1-rc.2 compatibility

- Retarget runtime pins to DSH `0.2.1-rc.2`, Cordis `~4.0.5`, Schemastery
  `~3.18.5` and pi-ai `^1.1.0`.
- Preserve caller cancellation across the installed SDK refresh hook; no grant or
  later catalog page commits after cancellation.

## dsh-copilot-tool-schema 0.1.1 — DSH 0.2.1-rc.2 compatibility

- Retarget runtime pins to DSH `0.2.1-rc.2`, Cordis `~4.0.5` and Schemastery
  `~3.18.5`; the assemble waterfall contract and behavior are unchanged.

## @1yefuwang1/dsh-worktrees 0.2.23 — DSH 0.2.1-rc.2 compatibility, exact-session discovery and thread-switch-safe first Send

- Retarget DSH 0.2.1-rc.2, Cordis/Schemastery, the guarded native submit adapter
  and the Connection browser peer; register the five UI routes with streaming
  bodies so a rejected caller is refused before its payload is read.
- Wait for the exact prepared session to enter the catalog and open its history;
  make manager **Open conversation** reuse an existing attached thread instead of
  forking it.
- Treat switching threads as navigation, not cancellation: keep the captured first
  message and exact source reference, admit it once to the prepared conversation,
  and defer auto-open behind a newer navigation claim.
- Keep progress and recovery source-keyed; restore the captured New intent and
  recovery UUID/result on ordinary navigation; block silent native Local fallback
  until an explicit Local/Worktree choice; add confirmed **Dismiss recovery**.
- Fence deferred status checks by exact operation identity/epoch, revalidate the
  prepared destination immediately before admission, and scope cancellation to the
  affected operation so another thread cannot abort or repaint this Send.

## Unreleased — Copilot Gemini tool declarations

- Worktrees `0.2.22` replaces the six-arm project-tool `oneOf` with one flat object
  schema that declares a root `properties` bucket. Measured on the enterprise account:
  the shipped payload returned a plain-text HTTP 400, the same declaration with
  `properties: {}` returned 200 while still carrying `oneOf`, and deleting `oneOf`
  without the bucket still failed.
- Add `dsh-copilot-tool-schema@0.1.0`: an additive `system-prompt/assemble` guard that
  supplies a missing root `properties` bucket for configured Copilot Gemini routes,
  with skip/fix diagnostics and best-effort logging.
- Register the fourth leaf in the pnpm workspace, pack allowlist, release identity and
  tooling assertions; add parser, scheduler, renderer, real-scope and offline wire
  coverage.

## Unreleased — Complete TypeScript migration

- Port the browser client, repository tooling, test suites and fixtures to strict
  TypeScript; keep the existing Host implementations and public declarations.
- Compile the persistent browser factory into [dist/client.js](<packages/worktrees/dist/client.js>) while retaining
  the public `./client` export and standalone package assets.
- Run TypeScript tests with `tsx`, include tests/tooling/client in type checks,
  and update release validation, publication allowlists and contributor commands.

## @1yefuwang1/dsh-worktrees 0.2.21 — Desktop-only native folder picker

- Hide **Choose a folder…** in web Create/Manage project dialogs; require the
  desktop shell's callable picker bridge instead of the Host picker method.
- Preserve desktop choosing/cancellation/fallback, web folder browsing where
  supported, and manual absolute-path entry. Update unavailable-option guidance
  and add web visibility/default/stale-selection regressions.

## @1yefuwang1/dsh-worktrees 0.2.20 — Runtime recovery and Local/navigation safety fixes

- Stage Local recovery under the actual runtime factory's existing initialization
  claim, avoiding nested maintenance and preserving queued input/native controls.
- Keep terminal/job validation for held targets; fence Local runtime admission and
  revalidate the complete owner/resource set immediately before process spawning.
- Treat the validated chosen Local branch, flushed history/Workspace association
  and ready journal as the durable recovery commit. Later publication errors retain
  ready and the exact continuation, with controlled failure/native same-ID retry
  guidance rather than a recovery-required downgrade or another branch switch.
- Let recovery metadata update warnings and explicit Open Local actions, never
  override newer or pre-existing navigation with an automatic redirect.
- Normalize Git-reported absolute admin-path separators for Windows cleanup checks
  without relaxing canonical path, pointer/backlink, or filesystem identity guards.
- Add actual factory create/resume/publication-failure integration and production
  Local-claim/guard regressions instead of relying only on simplified mocks.

## @1yefuwang1/dsh-worktrees 0.2.19 — Unreleased

- Add configurable 10-day messaging-only worktree cleanup, independent of archive;
  defer every loaded runtime, protected checkout and known active/uncertain work.
- Permanently discard unsaved checkout files while retaining branches, commit
  recovery refs and history; use exact Git identity and cold writer claims.
- Journal GC and one Local continuation per historical thread, ask for a branch,
  preserve full history/settings, show warnings, and never silently apply old code.
- Add live settings, global quiet recovery UI, pre-turn input holds and regression
  coverage for Git, leases, crash recovery, RPC and real Client interactions.

## @1yefuwang1/dsh-worktrees 0.2.18

- Align Local/New worktree controls, native menu colors and the search field with
  the surrounding UI, including non-Git Local-only folders.
- Default to the current local branch; choose local committed branches without
  fetching or retain freshly fetched remote branches, with explicit commit fences.
- Search complete cached branch generations without requests on keystrokes;
  select and dismiss automatically, while Refresh preserves the open picker,
  search and selection. Add real React interaction and CSS-cascade regressions.
- Retain existing permissions, native draft, cancellation and source-checkout
  defenses. Raise only the worktree package's bounded size ceiling to 575,000 bytes.

## @1yefuwang1/dsh-worktrees 0.2.17

- Offer each Add folder entry only where the composed directory picker can serve
  it: **Browse for folders** requires a Host that lists directories, **Choose a
  folder…** requires a reachable system chooser, and path entry always works. The
  desktop composition (system chooser only) no longer shows a browser entry that
  fails with `directory-picker/unavailable`.
- Default the add dropdown to that session share: the system chooser on desktop,
  the in-app browser where the Host lists directories, and path entry only when
  neither exists, so the first thing offered is never a disabled Add button.

## @1yefuwang1/dsh-worktrees 0.2.16

- Relabel the Add folder entries as **Browse for folders**, **Choose a folder…**
  and **Enter a folder path** in both dictionaries, so the multi-select browser and
  the one-folder system dialog no longer read like the same action.

## @1yefuwang1/dsh-worktrees 0.2.15

- Offer the native add option only where the session really has a picker (desktop
  shell bridge or Host `uiWorkspace.pickDirectory`), so the desktop project dialog
  no longer shows a control that fails; browsing and absolute-path entry stay
  available everywhere.

## @1yefuwang1/dsh-worktrees 0.2.14

- Move the Projects/Workspace view switch into native sidebar navigation between
  Automation tasks and Worktrees, with explicit destination labels and native
  styling. Preserve the current conversation, other panels and sidebar extensions.

## Unreleased — Three independent plugin workspaces

- Prepare the `@1yefuwang1/dsh-worktrees` `0.2.13` Host/Web Client release: persistent
  multi-folder projects with durable main-folder defaults and agent folder reminders,
  project-bound Local/worktree threads, visible backing
  indicators, native new-conversation worktree choice, lazy first-Send creation
  from a fresh remote base, staged progress and pre-admission fast branch naming, manager/reminders and
  explicitly guarded optimistic Local handoff with retained sources/history.
- Align Projects sidebar with native Folder view icons, regular title typography,
  session last-active times and counted Show X more sessions controls.
- Support metadata-only project removal with confirmation and durable import
  suppression; retain folders, files, conversations, worktrees and start receipts.
- Keep cross-root Git mutations Full-access-only; no privilege fallback, cached
  fetch fallback, continuous synchronization or physical-delete operation.
- Extend release targeting/public declaration checks and exact publication
  allowlists to the third leaf without widening either existing package's files
  or 150,000-byte size bound; worktrees has a separate 525,000-byte bound (44 files; project metadata and native-aligned sidebar controls added without widening the other leaves).
- Include local-Git fixtures and static/pure Client protocols; installed browser
  registration/interaction still requires separate live verification.

### Existing Copilot package migration

- Move `dsh-copilot-catalog` into its own publishable workspace without changing
  its runtime source, package identity, exports or credential ownership.
- Add separately installable `dsh-copilot-search` for native Responses web search.
- Introduce a private root, pnpm 11.7.0 workspaces/lockfile and shared TypeScript,
  validation, security-audit and package-content tooling.
- Run both plugins' unit/integration/public-type checks in cross-platform CI.
- Support JavaScript and standalone/native pnpm launchers in package verification.
- Select exactly one leaf for staged OIDC publication using package-specific tags;
  preserve the existing maintainer review and 2FA approval policy.
- Keep active profiles, signed applications and real account credentials outside
  development/testing. Native search acceptance requires a separate live probe.

Package history and versions are independent:

- [Better Copilot changelog](<packages/better-copilot/CHANGELOG.md>) — `0.5.1`,
  prepared locally for exact DSH `0.2.2-rc.3`, retaining the `0.4.0` persistent
  catalog/live-refresh behavior and the consolidated catalog `0.2.9`, search
  `0.1.5` and tool schema `0.1.3` capabilities. Staged for npm.
- The predecessor packages no longer exist in this repository; their release notes
  remain readable in Git history at `35ff48e`.
- [Worktrees changelog](<packages/worktrees/CHANGELOG.md>) — `@1yefuwang1/dsh-worktrees@0.2.27`, no branch selection in Local mode on top of the 0.2.26 branch release and DSH 0.2.1-rc.5 compatibility; npm availability still requires staged-release approval.
