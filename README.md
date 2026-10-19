# DSH plugins

A **pnpm monorepo with five independently installable DeepSeek Harness plugins**.
All maintained code—including Host implementations, the Web Client, tests and
repository tooling—uses strict TypeScript. Published Host modules are ESM with
declarations; the worktree and Azure Sync Web Clients compile to persistent
browser factories. The worktree plugin is packaged as
`@1yefuwang1/dsh-worktrees@0.2.23`; npm availability follows maintainer approval
of the staged release.

| Package | Purpose | DSH behavior |
| --- | --- | --- |
| [dsh-copilot-catalog](packages/catalog/README.md) | Account-aware Copilot model discovery and wire identity | Wraps/replaces the standard pi-ai adapter; emits Copilot-compatible headers while mounted; preserves its public configuration and credential key |
| [dsh-copilot-search](<packages/search/README.md>) | Copilot native Responses web search | Registers `github-copilot-search`; does not replace an LLM adapter |
| [dsh-copilot-tool-schema](<packages/tool-schema/README.md>) | Copilot Gemini tool-declaration guard | Adds a missing root `properties` bucket for configured Copilot Gemini routes; additive listener, no adapter replacement |
| [@1yefuwang1/dsh-worktrees](<packages/worktrees/README.md>) | Multi-folder projects with Local/worktree threads | Adds metadata-only project grouping, main-folder defaults/reminders, native first-Send worktree setup and branch naming, configurable inactivity cleanup, explicit branch-choice Local recovery with staged input and exact-ID reuse, and guarded handoff; no core or LLM adapter changes |
| [@1yefuwang1/dsh-azure-sync](<packages/azure-sync/README.md>) | Opt-in Azure Blob + Table conversation continuation | Experimental v1 implementation: default-off thread controls in the existing local Web GUI, verified history/attachments, explicit mixed-OS folder mappings, single-writer admission/takeover, conflict recovery, root/descendant tombstones and read-only Git guidance. Azure stores data only; no cloud-hosted GUI, code sync, Postgres or always-on compute. Final acceptance/review remains pending. |

The repository root is **private development tooling**, not a DSH plugin. Install
or link a leaf package, not the root Git URL. The existing catalog npm name and
root/catalog/discovery exports are unchanged.

## Compatibility

- DSH and DSH peer packages: `0.2.1-rc.2`.
- `@earendil-works/pi-ai`: `^1.1.0` (host-aligned peer range; tested at `1.1.0` and `1.3.0`).
- Node.js: `>=22.19.0`.
- Development package manager: **pnpm `11.7.0`**, pinned in the root manifest.

The two Copilot plugins resolve the same public pi-ai runtime the DSH adapter
uses, including nested pnpm layouts. The worktree plugin uses local Git and needs
no Copilot account or pi-ai runtime. None vendors DSH/pi-ai or modifies signed
applications. These are experimental third-party integrations, not affiliated
with GitHub, DeepSeek or the pi-ai maintainers.

## Install in DSH

Use DSH's Plugins page or CLI for the intended profile:

```sh
dsh plugin --profile <profile> add dsh-copilot-catalog
dsh plugin --profile <profile> add dsh-copilot-search
dsh plugin --profile <profile> add dsh-copilot-tool-schema
```

The Copilot plugins work separately or together. Search reuses
`llm-pi-ai/github-copilot`, whether inference uses the standard adapter or catalog
wrapper. Sign in through DSH's normal Copilot flow. Worktrees is independent;
for its unpublished version, follow the [local leaf/tarball instructions](<packages/worktrees/README.md#install-from-this-repository>)
instead of assuming a registry release exists. Azure Sync `0.1.0` is also
unpublished; use its [source build/local leaf instructions](<packages/azure-sync/README.md#1-build-and-install-deliberately>)
and read the [acceptance ledger](<docs/acceptance/azure-sync.md>) before opting in.
Its Host and browser controls are implemented; a deployed GUI, live Azure account
and real Windows acceptance are not established.

**Review each bundle before enabling it:**

- Catalog replaces `llm-pi-ai`. Copy additional provider configuration into the
  replacement; do not enable two adapters for the same route.
- Catalog also installs a refcounted Copilot `fetch` header interceptor while
  mounted. Set `DSH_COPILOT_WIRE_IDENTITY=basic` to avoid local VS Code IDs or `0`
  to disable it; the catalog README documents the residual-fingerprint and
  account-policy limits.
- Search explicitly selects `github-copilot-search`, keeping the shipped HTTP
  fetch provider. Preserve custom fetch selection in a higher-priority override.
- Search uses DSH's ordinary `web_search` tool independently of the conversation
  model. The existing Web search settings card is DeepSeek-specific, not a chooser.
- Restart the DSH host after host-plugin installation/removal or changing the
  nonvolatile web-service provider selection. These Host-only Copilot plugins do
  not need a Web UI rebuild; browser addons have their own build/refresh requirements.
- Worktrees defaults to the current local branch without a remote fetch, or lets
  you select a freshly fetched remote branch on first native Send. Its themed
  branch picker searches loaded lists without network requests. It creates a
  random checkout and applies a
  fast-model branch name with visible progress, then sends the normal prompt.
  Mode selection performs no setup; the checkout directory stays fixed. Cross-root Git mutations
  require the actual caller's existing Full access. Handoff is guarded but not
  globally atomic; external writers must stop.
  Archive itself retains files/history; enabled inactivity cleanup can later reclaim
  a checkout regardless of archive status. Cleanup defaults to 10 days without user
  messages, discards unsaved files, retains Git branches/history, and defers every
  loaded runtime or known active/protected checkout. Reopening asks for a Local
  branch and shows a persistent warning. Recovery stages the real target under the
  factory's existing initialization claim; held jobs/terminals and fresh Local owners
  are checked at managed process-spawn boundaries. Validated/flushed history and a
  ready journal commit the exact continuation independently of later live publication.
  **Continue/Open Local** are explicit actions: recovery metadata never navigates
  automatically or overrides a newer native selection. Unsupported repositories fail explicitly.

Package READMEs describe settings, account precedence and non-destructive recovery.
Development checks do not enable plugins in an active profile or use real credentials.

## Azure Sync v1: data in Azure, execution stays local

The [Azure Sync guide](<packages/azure-sync/README.md>) covers account setup,
authentication, two-device import and recovery. Each new thread starts **Off**;
confirmed On uploads its full existing history once materialized. Only a private
Blob Hot LRS container and Table are required. Credentials belong to the Host
credential provider or ambient Azure CLI/managed identity, never plugin config,
conversation prompts or browser storage. Logs/tool outputs may themselves contain
secrets; hashes do not defend against a malicious authorized cloud writer.

- Bring the code and required presets/models to each device yourself. Explicit,
  realpath-pinned folder mappings localize historical cwd events without rewriting
  the canonical imported prefix. No global settings, credentials, preset definitions,
  drafts, schedules, code or worktree bindings are transferred.
- A cloud-enabled model step requires a **fresh server ownership proof**. Takeover
  is explicit and cannot undo an old device's already running tools. A retained
  stale live Agent requires a **Host restart**, not just closing a browser tab.
- Off retains cloud history; detach chooses local continuation; removal separately
  tombstones the root and descendants. Shared attachments remain. Partial imports
  cannot resume merely because Off was selected; repair or explicit degraded-log
  acknowledgement is required as appropriate.
- Git facts are bounded, read-only advice, not a checkout or a code-match guarantee.
  One Host per local state store and one shared LocalStore across its plugin/runtime
  instances are the supported boundary. Unloading removes enforcement: turn Off or
  detach deliberately before uninstalling; local and retained cloud data stay intact.

The [cost evidence](<docs/acceptance/azure-sync-cost.md>) measures actual Azure SDK
HTTP requests against local Azurite and models a bounded workload; it is **not an
Azure bill or a spending cap**. Whole-history Host polls and imported ownership
proofs scale with enabled history size. Live Azure/RBAC/network/billing,
two-machine GUI and real Windows/PowerShell checks remain on the
[manual checklist](<docs/acceptance/azure-sync.md#manual-two-machine-checklist-not-run>).
T1–T8 are approved; **T9's final verification and independent reviews are pending**.
Building this package does not automatically update an already running GUI; no
replacement server, deployed refresh or HMR watcher is implied.

## Develop

From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --config.ignore-scripts=true run build
pnpm --config.ignore-scripts=true run verify
```

Install with dependency lifecycle scripts off; builds are explicit. Carry the
explicit `--config.ignore-scripts=true` on run/pack commands when manifests changed:
pnpm 11 can install automatically before a run, and an environment-only flag may
not suppress leaf prepare scripts. Explicitly requested build/test scripts still run.
Commit the pnpm lockfile only. Do not add npm lockfiles or install from a leaf directory.

Target one package:

```sh
pnpm --filter dsh-copilot-catalog run test
pnpm --filter dsh-copilot-search run test
pnpm --filter dsh-copilot-search run test:integration
pnpm --filter @1yefuwang1/dsh-worktrees run test
pnpm --filter @1yefuwang1/dsh-worktrees run test:integration
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run verify
```

Local linking, **only if you choose to alter a DSH profile**:

```sh
dsh plugin --profile <profile> add -w packages/catalog
dsh plugin --profile <profile> add -w packages/search
dsh plugin --profile <profile> add -w packages/tool-schema
dsh plugin --profile <profile> add -w packages/worktrees
```

Build a standalone installable tarball:

```sh
pnpm --filter dsh-copilot-search run build
pnpm --dir packages/search pack --pack-destination ../../artifacts --config.ignore-scripts=true
```

## Verification

`pnpm run verify` checks:

1. Git-candidate credentials; suspected values are never printed.
2. Strict types for implementations, Web Client, tests and tooling; portable source and standalone manifests.
3. Monorepo/release targeting and path isolation.
4. All packages' synthetic unit/protocol tests.
5. Real DSH/pi-ai peer integration with mocked requests and temporary local-Git fixtures.
6. Consumers of each package's public root/subpath declarations.
7. Exact pnpm publication allowlists and every exported file target.

There are **no live Copilot requests or sign-in flows** in the suite. Search tests
validate construction/parsing, not live model/account acceptance. Worktree checks
include Client protocols and real React interaction fixtures, production Local
owner/resource guards, temporary Git repositories, and the pinned AgentLoop/native
Session controller with goals/presets/policies and JSONL persistence. They exercise
staged create/resume, queued input, native permissions, publication-failure retries
and shutdown without reclaiming any user checkout. These fixtures are not a live GUI
probe: installed slot registration, interaction and light/dark appearance require
separate browser verification. Azure Sync additionally exercises real JSONL,
WorkingDirectoryService/AgentLoop, independent local stores, retained-live/recreated-Host
catch-up, crash/authority races and real local Azurite. Its public-SDK/JSDOM client
fixtures are not a full stock composer or deployed GUI run; no live Azure,
RBAC/private-network, Windows GUI or Cost Management export is implied. Its
[acceptance ledger](<docs/acceptance/azure-sync.md>) records exact evidence boundaries.

## Native-search prerequisites

Search requests `tools: [{type: 'web_search'}]` through Copilot `/responses`.
Select an account-enabled model with native-search support: endpoint advertisement
alone is insufficient. Check the model-native search setting and organization policy.

The configurable default auxiliary model is `gpt-6.1-sol`, not an allowlist or an
entitlement guarantee. Optional source/access/tool-choice fields can be disabled
when unsupported. Rejections fail explicitly, without generated-link scraping,
another-vendor fallback or duplicate paid inference retry. Each query consumes
auxiliary Copilot usage; a returned-source cap does not cap backend searches/costs.

## Layout

```text
packages/
  catalog/          dsh-copilot-catalog: source, tests, bundle and package docs
  tool-schema/      dsh-copilot-tool-schema: Copilot Gemini tool-declaration guard
  search/           dsh-copilot-search: source, tests, bundle and package docs
  worktrees/        @1yefuwang1/dsh-worktrees: Host, Client, Git, tests and docs
  azure-sync/       @1yefuwang1/dsh-azure-sync: Azure Blob + Table sync source and tests
scripts/            validation, credential audit and release targeting
pnpm-workspace.yaml the five plugin workspaces
pnpm-lock.yaml      reproducible root and leaf dependency graph
```

Packages have independent versions, manifests, exports, output and publication
allowlists. None depends on a private workspace package or needs another plugin
installed. Shared development tooling stays at the private root.

## Releases

A release selects **one package**, never the root or multiple packages at once:

- `dsh-copilot-catalog-vX.Y.Z`
- `dsh-copilot-search-vX.Y.Z`
- `dsh-copilot-tool-schema-vX.Y.Z`
- `@1yefuwang1/dsh-worktrees-vX.Y.Z`
- `@1yefuwang1/dsh-azure-sync-vX.Y.Z`

The tag must match its leaf version and repository identity. Catalog is currently
`0.2.7`, preserving pi-ai's exact behavior headers while retaining the scoped
Copilot wire-identity interceptor, and Search is `0.1.3`; both target
DSH `0.2.1-rc.2` (adapter-relative pi-ai resolution and cancellation-safe
credential refresh respectively); published versions cannot be republished. Tool schema is `dsh-copilot-tool-schema@0.1.1`, a
DSH `0.2.1-rc.2` retarget with no behavior change. Worktrees is
`@1yefuwang1/dsh-worktrees@0.2.23`, adding DSH `0.2.1-rc.2` compatibility,
exact-session discovery/non-creating Open, and thread-switch-safe first Send with
source-keyed recovery and prepared-target revalidation. It retains factory staging,
held-target resource checks, Local runtime admission/spawn guards, navigation
fixes, ready Local recovery commits, guarded handoff, multi-folder projects and
cleanup semantics. This release uses staged npm publishing; npm availability
requires maintainer review/2FA approval. The unrelated unscoped worktrees npm name
is not an alias for this plugin. Azure Sync is `@1yefuwang1/dsh-azure-sync@0.1.0`
in the working tree, **unreleased**. Its v1 Host, browser controls and read-only Git
implementation have T1–T8 approvals. T9 documentation, measured-operation cost
modeling, extracted-tarball consumer smoke and final acceptance are in progress;
final verification/review and any subsequent publication are separate gates.
See the [Azure changelog](<packages/azure-sync/CHANGELOG.md>) and
[acceptance evidence](<docs/acceptance/azure-sync.md>), including deferred manual work.

The [release workflow](.github/workflows/publish.yml) installs/verifies with pnpm,
then uses native `pnpm stage publish` to stage **only the selected leaf** through
npm Trusted Publisher/OIDC. The exact package/version/repository release gate
protects the immutable tag checkout; detached-tag staging skips the ordinary
publish-branch checks. A maintainer reviews and approves each staged version with
2FA; the workflow does not directly publish and stores no registry token.

Before a package's first release, configure its Trusted Publisher for this
repository, `publish.yml` and the `npm` environment. Forks must update each leaf's
repository URL/directory and the root URL before publishing.
See [contributing](CONTRIBUTING.md), [security](SECURITY.md) and
[package changelogs](CHANGELOG.md).

## License

[MIT](LICENSE). Dependencies retain their own licenses and are not redistributed
in any plugin tarball.
