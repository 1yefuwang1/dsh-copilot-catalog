# DSH Copilot plugins

A **pnpm monorepo with two independently installable DeepSeek Harness plugins**.
Both are strict TypeScript packages, published as ESM with declarations.

| Package | Purpose | DSH behavior |
| --- | --- | --- |
| [dsh-copilot-catalog](packages/catalog/README.md) | Account-aware Copilot model discovery | Wraps/replaces the standard pi-ai adapter; preserves its public configuration and credential key |
| [dsh-copilot-search](packages/search/README.md) | Copilot native Responses web search | Registers `github-copilot-search`; does not replace an LLM adapter |

The repository root is **private development tooling**, not a DSH plugin. Install
or link a leaf package, not the root Git URL. The existing catalog npm name and
root/catalog/discovery exports are unchanged.

## Compatibility

- DSH and DSH peer packages: `0.2.0-rc.2`.
- `@earendil-works/pi-ai`: `0.87.1`.
- Node.js: `>=22.19.0`.
- Development package manager: **pnpm `11.7.0`**, pinned in the root manifest.

Both plugins resolve the same public pi-ai runtime the DSH adapter uses, including
nested pnpm layouts. They do not vendor DSH/pi-ai or modify signed applications.
They are experimental third-party integrations, not affiliated with GitHub,
DeepSeek or the pi-ai maintainers.

## Install in DSH

Use DSH's Plugins page or CLI for the intended profile:

```sh
dsh plugin --profile <profile> add dsh-copilot-catalog
dsh plugin --profile <profile> add dsh-copilot-search
```

Either plugin works separately; both can be used together. Search reuses
`llm-pi-ai/github-copilot`, whether inference uses the standard adapter or catalog
wrapper. Sign in through DSH's normal Copilot flow.

**Review each bundle before enabling it:**

- Catalog replaces `llm-pi-ai`. Copy additional provider configuration into the
  replacement; do not enable two adapters for the same route.
- Search explicitly selects `github-copilot-search`, keeping the shipped HTTP
  fetch provider. Preserve custom fetch selection in a higher-priority override.
- Search uses DSH's ordinary `web_search` tool independently of the conversation
  model. The existing Web search settings card is DeepSeek-specific, not a chooser.
- Restart the DSH host after host-plugin installation/removal or changing the
  nonvolatile web-service provider selection. No Web UI rebuild is required.

Package READMEs describe settings, account precedence and rollback. Development
commands do not enable either plugin in an active profile or use real credentials.

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
```

Local linking, **only if you choose to alter a DSH profile**:

```sh
dsh plugin --profile <profile> add -w packages/catalog
dsh plugin --profile <profile> add -w packages/search
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
4. Both packages' synthetic unit tests.
5. Real DSH/pi-ai peer integration with mocked requests.
6. Consumers of each package's public root/subpath declarations.
7. Exact pnpm publication allowlists and every exported file target.

There are **no live Copilot requests or sign-in flows** in the suite. Search tests
validate construction/parsing, not live model/account acceptance.

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
scripts/            validation, credential audit and release targeting
pnpm-workspace.yaml the two plugin workspaces
pnpm-lock.yaml      reproducible root and leaf dependency graph
```

Packages have independent versions, manifests, exports, output and publication
allowlists. Neither depends on a private workspace package or needs the other
plugin installed. Shared development tooling stays at the private root.

## Releases

A release selects **one package**, never the root or both packages at once:

- `dsh-copilot-catalog-vX.Y.Z`
- `dsh-copilot-search-vX.Y.Z`

The tag must match its leaf version and repository identity. Catalog is currently
`0.2.2`, adding GHE Cloud endpoint support; published versions cannot be republished. Search is currently
`0.1.1`, including the verified Copilot stream-ID compatibility fix.

The [release workflow](.github/workflows/publish.yml) installs/verifies with pnpm,
then uses native `pnpm stage publish` to stage **only the selected leaf** through
npm Trusted Publisher/OIDC. The exact package/version/repository release gate
protects the immutable tag checkout; detached-tag staging skips the ordinary
publish-branch checks. A maintainer reviews and approves each staged version with
2FA; the workflow does not directly publish and stores no registry token.

Configure the new search package's Trusted Publisher for this repository,
`publish.yml` and the `npm` environment before its first release. Forks must update
both leaf repository URLs/directories and the root URL before publishing.
See [contributing](CONTRIBUTING.md), [security](SECURITY.md) and
[package changelogs](CHANGELOG.md).

## License

[MIT](LICENSE). Dependencies retain their own licenses and are not redistributed
in either tarball.
