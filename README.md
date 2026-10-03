# dsh-copilot-catalog

Account-aware **GitHub Copilot model discovery for DeepSeek Harness (DSH)**.
Written in strict TypeScript; published as ESM JavaScript with type declarations.

This experimental, third-party plugin wraps `@deepseek-ai/dsh-llm-pi-ai`. Before the
adapter mounts, it reads your existing Copilot OAuth grant, fetches your account's
`/models` catalog, and updates the **same in-memory pi-ai catalog** the adapter uses.
No hard-coded application paths, credential-file edits, or signed-app modifications.

## What it does

- Shows picker-enabled models whose policy is enabled or absent and which do not
  explicitly reject tool calls.
- Preserves upstream descriptors for known IDs, including mixed API protocols.
- Adds two explicitly reviewed Responses-compatible sibling templates:

  | New model | Bundled template |
  | --- | --- |
  | `gpt-6.1-sol` | `gpt-6-sol` |
  | `gpt-5.6-sol-fast` | `gpt-5.6-sol` |

- Uses live positive context/output limits, vision support, reasoning restrictions,
  and validated pricing for those new siblings. Unknown new IDs are logged and
  skipped; protocols are never inferred from arbitrary model names.
- Leaves the current catalog untouched if discovery fails or yields no supported
  models. On first startup this means all bundled defaults remain available.
- Bounds the whole attempt to **10 seconds**, including credential reads, refresh,
  auth resolution, fetch, and body parsing. Timed-out work cannot commit later.
- Makes no credential-store writes. Expiring grants are refreshed only in memory;
  the original adapter owns normal persisted refresh and its cross-process lock.
- Requires HTTPS Copilot subdomains, refuses redirects and unusual ports, and
  logs controlled error codes instead of potentially sensitive exception messages.

## Compatibility

| Component | Supported version |
| --- | --- |
| DSH and `@deepseek-ai/dsh-llm-pi-ai` | `0.2.0-rc.2` |
| `@earendil-works/pi-ai` | `0.87.1` |
| Node.js | `>=22.19.0` |
| Runtime format | ESM only; no CommonJS entry |

DSH and pi-ai are **peer dependencies**, not vendored copies. Runtime resolution
starts from the adapter's location, so nested or pnpm layouts do not cause the
plugin to update a different pi-ai instance. Type-only imports are erased by the
compiler. The public Copilot provider supplies OAuth hooks; private auth modules
are not imported. Version ranges are deliberately conservative: verify a new DSH
or pi-ai version before widening them.

## Installation

> **Adapter replacement, not an add-on adapter.** The included DSH bundle disables
> the standard `llm-pi-ai` entry and inserts `llm-pi-ai-catalog`, configured for
> `github-copilot`. Do not enable another adapter for the same provider route.
>
> **Existing custom routes/settings are not copied automatically.** Before enabling
> the bundle, back up your profile patch and copy every provider and override you
> want to retain to the replacement entry. Its settings namespace is
> `llm-pi-ai-catalog`; your OAuth grant keeps the original `llm-pi-ai/github-copilot`
> key. A later profile/home patch that re-enables the original adapter must be fixed.

### From npm, after publication

Install the bundle through DSH's Plugins page, or use the CLI for your chosen
profile (for example `desktop` or `web`):

```sh
dsh plugin --profile <profile> add dsh-copilot-catalog
```

Restart DSH after installing or changing this host-side plugin. The code has no
browser component and does not modify or rebuild DSH's web UI.

### From GitHub, after pushing this repository

The Git repository includes the TypeScript source and build configuration. Its
`prepare` script builds the ESM output when the package manager installs from Git.
Use your actual repository URL in DSH's Plugins page or the CLI:

```sh
dsh plugin --profile <profile> add 'git+https://github.com/1yefuwang1/dsh-copilot-catalog.git'
```

### Local development

```sh
npm ci --ignore-scripts
npm run build
npm run verify
# Only if you choose to enable it in an actual DSH profile:
dsh plugin --profile <profile> add -w .
```

Local linking affects that profile; it is not part of the automated test suite.
Neither this repository nor its tests automatically edit your active profile.

### Preserve additional provider configuration

Add a higher-priority override to your own profile patch before enabling the bundle.
Copy the **full provider configuration** from your original adapter, including
custom URLs, models, headers and overrides, as needed:

```yaml
- id: llm-pi-ai-catalog
  name: dsh-copilot-catalog
  config:
    providers:
      github-copilot: {}
      openai:
        apiKeyEnv: OPENAI_API_KEY
```

All original adapter configuration fields remain valid. The wrapper exports the
original `Config` schema unchanged; it adds no secret or custom discovery settings.
If your original adapter has a different entry ID, adjust the disabling override
in your profile accordingly.

### Check startup

Successful discovery logs `Copilot catalog synced` with the supported model count
and JSON-escaped unsupported IDs. Failures log one of `TIMEOUT`, `HTTP_ERROR`,
`INVALID_CATALOG`, `UNTRUSTED_ENDPOINT`, `INVALID_AUTH`, `IMMUTABLE_CATALOG`, or
`DISCOVERY_FAILED`; startup still delegates to the original adapter. Missing OAuth
credentials keep the defaults. Sign in through DSH's normal Copilot authorization
flow, then restart to perform account discovery.

### Rollback

Disable or remove this bundle with DSH's Plugins page, remove any profile overrides
that still enable the replacement, and re-enable the standard `llm-pi-ai` entry if
your own profile has disabled it. Restore your backed-up provider configuration and
restart the **whole DSH process** to reset its in-memory catalog. Do not delete the
OAuth grant. The wrapper does not patch the signed application or store a catalog
on disk.

## Development and tests

```sh
npm ci --ignore-scripts
npm run check:secrets   # scan Git candidates; never print suspected secret values
npm run typecheck       # strict TypeScript, no emit
npm run build           # dist/*.js plus dist/*.d.ts
npm test                # synthetic unit/lifecycle/security regression tests
npm run test:integration # real npm peers; no account or network requests
npm run test:types      # a strict TS consumer checks the published declarations
npm run test:pack       # exact npm tarball allowlist, including declarations
npm run verify         # all of the above
npm pack --dry-run
```

The tests use synthetic credentials and response fixtures. They cover filtering,
unknown/prototype-sensitive IDs, mixed APIs, reasoning mappings, billing fallback,
read-only refresh, endpoint restrictions, full-attempt deadlines, late responses,
fail-open delegation, safe diagnostics, and actual peer loading. No live Copilot
request or authentication flow is run automatically.

- [`src/index.ts`](src/index.ts): DSH entry point.
- [`src/runtime.ts`](src/runtime.ts): shared adapter/pi-ai resolution.
- [`src/catalog.ts`](src/catalog.ts): pure selection and pricing.
- [`src/discovery.ts`](src/discovery.ts): bounded read-only discovery.
- [`src/plugin.ts`](src/plugin.ts): adapter lifecycle and safe logging.
- [`src/types.ts`](src/types.ts): public interfaces and upstream type integration.

For scripts that only need model selection, the `dsh-copilot-catalog/catalog`
subpath is side-effect-free. Pass an explicit bundled catalog:

```ts
import { selectAccountModels } from 'dsh-copilot-catalog/catalog';
import { GITHUB_COPILOT_MODELS } from '@earendil-works/pi-ai/providers/github-copilot.models';

const { models, unsupported } = selectAccountModels(response, GITHUB_COPILOT_MODELS);
```

The package root loads the adapter peers but does not read credentials or perform
network I/O until `apply()` or `syncCopilotCatalog()` is called. The
`dsh-copilot-catalog/discovery` helper takes explicit injected dependencies for tests
and tooling.

## Publish to GitHub and npm

The package name is `dsh-copilot-catalog`; availability can change before npm
publication. The GitHub repository is
[`1yefuwang1/dsh-copilot-catalog`](https://github.com/1yefuwang1/dsh-copilot-catalog),
and its repository, homepage, and issue-tracker metadata are configured. Personal
author details remain intentionally unset.

1. If publishing a fork, update its repository metadata before publishing:

   ```sh
   npm pkg set 'repository.type=git' \
     'repository.url=git+https://github.com/OWNER/REPOSITORY.git' \
     'homepage=https://github.com/OWNER/REPOSITORY#readme' \
     'bugs.url=https://github.com/OWNER/REPOSITORY/issues'
   # Optional: npm pkg set 'author=Your Name'
   npm install --package-lock-only --ignore-scripts
   ```

2. Review the MIT license, package name, compatibility pins, bundle replacement,
   and tarball contents. Update the changelog and run `npm run verify`.
3. Commit and push the source and lockfile. If you have not initialized Git yet:

   ```sh
   git init -b main
   git add .
   git commit -m 'Initial TypeScript Copilot catalog plugin'
   git remote add origin https://github.com/1yefuwang1/dsh-copilot-catalog.git
   git push -u origin main
   ```

4. For the **first npm release**, authenticate using your own npm account:

   ```sh
   npm login
   npm publish --access public
   ```

   The `prepublishOnly` gate validates types, tests, peer loading, and the tarball.
   npm publication is an explicit external action; it is never run by `verify`.
5. For later releases, configure an npm **trusted publisher** for this GitHub
   repository, workflow `publish.yml`, and environment `npm`. Create the GitHub
   `npm` environment, preferably with required reviewers. No long-lived npm token
   is required by the included workflow.
6. Bump the version, update the changelog, commit, push a matching `vX.Y.Z` tag, and
   publish a GitHub Release for that tag. The workflow validates tag/version and
   repository metadata, runs all checks, and publishes with npm provenance.

CI runs on Linux, macOS and Windows, on Node 22 and 24. The publish workflow requires
Node 24/npm 11.5.1+ for trusted publishing and only runs for a published GitHub
Release, not for pull requests. Generated `dist/` files stay out of Git; only the
compiled runtime, declarations, DSH bundle patch, README, changelog and license
enter the npm tarball. Review files, tests, dependencies and credentials do not.

## Limitations

- Discovery is a startup/mount snapshot, not continuous sync. Restart after login,
  account changes, upgrades or rollback. Avoid hot-reloading this wrapper: a
  process-wide catalog mutation can outlive its plugin mount.
- Account discovery deliberately uses strict picker semantics. Individual accounts
  that mark every picker flag false fall back to bundled defaults; the wrapper
  does not broaden access using policy-only heuristics.
- A successful sync mutates a shared Copilot catalog in memory. Mount only one
  adapter instance. A failed later mount keeps the current process's catalog, not
  necessarily the original defaults; a full restart resets it.
- Existing upstream model descriptors are intentionally preserved, not refreshed
  field-by-field. Only the two allowlisted new sibling IDs use live metadata.
- Original adapter credential filtering, explicit `models` lists, and
  `modelOverrides` still apply. This plugin neither enables account policies nor
  changes stored `availableModelIds`; an upstream credential allowlist can still
  hide a model until normal refresh/sign-in updates it.
- Enterprise OAuth endpoints outside HTTPS `*.githubcopilot.com` are rejected by
  discovery; normal adapter behavior remains available as fallback.
- Upstream catalog structure, protocol compatibility and Copilot billing metadata
  are not stable public contracts. Re-test templates after updates. This package
  is not affiliated with DeepSeek, GitHub, or the pi-ai maintainers.

## License

[MIT](LICENSE). Original DSH and pi-ai packages retain their own licenses; they are
not redistributed in this tarball.
