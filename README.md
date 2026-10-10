# DSH plugins

A **pnpm monorepo with three independently installable DeepSeek Harness plugins**.
Host halves use strict TypeScript/ESM with declarations; the worktree package also
contains a persistent plain-JS Web Client. `dsh-worktrees` is an unreleased `0.2.6`
package, not a promised npm installation target.

| Package | Purpose | DSH behavior |
| --- | --- | --- |
| [dsh-copilot-catalog](packages/catalog/README.md) | Account-aware Copilot model discovery | Wraps/replaces the standard pi-ai adapter; preserves its public configuration and credential key |
| [dsh-copilot-search](<packages/search/README.md>) | Copilot native Responses web search | Registers `github-copilot-search`; does not replace an LLM adapter |
| [dsh-worktrees](<packages/worktrees/README.md>) | Multi-folder projects with Local/worktree threads | Adds project grouping and worktree indicators, native first-Send lazy setup with visible progress and fast branch naming, manager/reminders and guarded Local handoff; no core or LLM adapter changes |

The repository root is **private development tooling**, not a DSH plugin. Install
or link a leaf package, not the root Git URL. The existing catalog npm name and
root/catalog/discovery exports are unchanged.

## Compatibility

- DSH and DSH peer packages: `0.2.0-rc.2`.
- `@earendil-works/pi-ai`: `0.87.1`.
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
```

The Copilot plugins work separately or together. Search reuses
`llm-pi-ai/github-copilot`, whether inference uses the standard adapter or catalog
wrapper. Sign in through DSH's normal Copilot flow. Worktrees is independent;
for its unpublished version, follow the [local leaf/tarball instructions](<packages/worktrees/README.md#install-from-this-repository>)
instead of assuming a registry release exists.

**Review each bundle before enabling it:**

- Catalog replaces `llm-pi-ai`. Copy additional provider configuration into the
  replacement; do not enable two adapters for the same route.
- Search explicitly selects `github-copilot-search`, keeping the shipped HTTP
  fetch provider. Preserve custom fetch selection in a higher-priority override.
- Search uses DSH's ordinary `web_search` tool independently of the conversation
  model. The existing Web search settings card is DeepSeek-specific, not a chooser.
- Restart the DSH host after host-plugin installation/removal or changing the
  nonvolatile web-service provider selection. No Web UI rebuild is required.
- Worktrees freshly fetches a selectable advertised remote branch (`origin/main`
  is only a default) on first native Send, creates a random checkout, applies a
  fast-model branch name with visible progress, then sends the normal prompt.
  Mode selection performs no setup; the checkout directory stays fixed. Cross-root Git mutations
  require the actual caller's existing Full access. Handoff is guarded but not
  globally atomic; external writers must stop.
  Archive retains files/history, and unsupported LFS/filter/sparse/partial/submodule
  repositories fail explicitly.

Package READMEs describe settings, account precedence and non-destructive recovery.
Development checks do not enable plugins in an active profile or use real credentials.

## Develop

From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run verify
```

Install with dependency lifecycle scripts off; builds are explicit. Commit the
pnpm lockfile only. Do not add npm lockfiles or install from a leaf directory.

Target one package:

```sh
pnpm --filter dsh-copilot-catalog run test
pnpm --filter dsh-copilot-search run test
pnpm --filter dsh-copilot-search run test:integration
pnpm --filter dsh-worktrees run test
pnpm --filter dsh-worktrees run test:integration
```

Local linking, **only if you choose to alter a DSH profile**:

```sh
dsh plugin --profile <profile> add -w packages/catalog
dsh plugin --profile <profile> add -w packages/search
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
2. Strict types, portable source, tooling syntax and standalone manifests.
3. Monorepo/release targeting and path isolation.
4. All packages' synthetic unit/protocol tests.
5. Real DSH/pi-ai peer integration with mocked requests and temporary local-Git fixtures.
6. Consumers of each package's public root/subpath declarations.
7. Exact pnpm publication allowlists and every exported file target.

There are **no live Copilot requests or sign-in flows** in the suite. Search tests
validate construction/parsing, not live model/account acceptance. Worktree Client
checks are static/pure protocols, not a fake DOM/screenshot or live GUI probe.
Installed slot registration, interaction and light/dark appearance require
separate browser verification.

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
  search/           dsh-copilot-search: source, tests, bundle and package docs
  worktrees/        dsh-worktrees: Host, Client, Git, tests and package docs
scripts/            validation, credential audit and release targeting
pnpm-workspace.yaml the three plugin workspaces
pnpm-lock.yaml      reproducible root and leaf dependency graph
```

Packages have independent versions, manifests, exports, output and publication
allowlists. None depends on a private workspace package or needs another plugin
installed. Shared development tooling stays at the private root.

## Releases

A release selects **one package**, never the root or multiple packages at once:

- `dsh-copilot-catalog-vX.Y.Z`
- `dsh-copilot-search-vX.Y.Z`
- `dsh-worktrees-vX.Y.Z`

The tag must match its leaf version and repository identity. Catalog is currently
`0.2.2`, adding GHE Cloud endpoint support; published versions cannot be republished. Search is currently
`0.1.2`, adding GHE Cloud endpoint support alongside the Copilot stream-ID compatibility fix.
Worktrees is `0.2.6`, unreleased and not published by this implementation; it adds persistent multi-folder projects, project-bound Local/worktree threads and visible backing indicators, alongside native first-Send lazy creation, staged progress and configurable foreground branch naming and exact authenticated UI RPC routes that coexist with the native gateway.

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
