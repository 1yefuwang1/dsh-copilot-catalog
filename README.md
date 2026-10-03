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
- Builds descriptors for **any newly discovered model ID**, without a model-name
  allowlist, sibling template, or vendor-name heuristic. Transport selection uses
  the advertised `supported_endpoints`:

  | Advertised endpoint | pi-ai transport |
  | --- | --- |
  | `/responses` | `openai-responses` |
  | `/v1/messages` | `anthropic-messages` |
  | `/chat/completions` | `openai-completions` |

  When multiple supported endpoints are offered, preference is Responses, native
  Messages, then Chat Completions, independent of array order or model name.
- Uses live positive context/output limits, vision support, advertised reasoning
  efforts, and validated pricing for new models. Only unknown protocols, invalid
  request IDs, non-chat/non-streaming models, or insufficient limits are skipped.
  Missing pricing uses zero-valued **unknown rates**, not another model's prices.
- Keeps **Enterprise routing for discovery and inference**, including known
  bundled models and API-key auth. A validated account endpoint is applied as an
  in-memory provider default even if the model listing later fails. Explicit
  configured API-key endpoints are preserved; no profile setting is rewritten.
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

## Enterprise authentication and endpoint routing

This plugin also works around pi-ai's API-key path: an explicit API key bypasses
OAuth `toAuth()`, so upstream otherwise retains the bundled Individual endpoint.
The wrapper discovers an account endpoint and supplies it to the original adapter
as a **runtime-only `baseURL` default**, covering new and bundled models.

- **Stored Copilot OAuth grant:** use the provider's public `toAuth()` to derive
  the account endpoint. The original adapter still owns persisted refresh and
  derives request auth normally; Enterprise grants do not become Individual keys.
- **Copilot access token supplied as an API key:** use its `proxy-ep` metadata to
  derive the endpoint through the same read-only OAuth hook. This applies to stored
  API-key records, explicit `apiKeyEnv` references, and ambient `COPILOT_GITHUB_TOKEN`.
  An explicit reference wins over a different stored OAuth account, as in pi-ai.
- **Opaque token:** no account endpoint can be inferred safely. Set the existing
  provider `baseURL` field explicitly, or use DSH's normal Copilot OAuth sign-in.
  Discovery reports `MISSING_ENDPOINT` rather than assuming the Individual API.
- **GitHub PAT:** it is not a Copilot access token. The wrapper does not guess the
  Enterprise GitHub domain or implement a second sign-in/exchange flow; use OAuth.

For an explicit Enterprise API-key route, use a credential reference, not a literal
key in your profile:

```yaml
- id: llm-pi-ai-catalog
  name: dsh-copilot-catalog
  config:
    providers:
      github-copilot:
        apiKeyEnv: COPILOT_ACCESS_TOKEN
        baseURL: https://api.enterprise.githubcopilot.com
```

Use the endpoint belonging to **your** account; do not assume Enterprise seats all
share a GitHub Enterprise Server domain. Discovery only trusts HTTPS
`*.githubcopilot.com` origins. Inferred API-key routing is a startup snapshot;
restart after changing accounts or moving a key to a different endpoint. If no
endpoint can be identified, the original adapter remains mounted with its original
configuration, so an opaque Enterprise key still needs an explicit `baseURL`.

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
An inferred endpoint is overlaid only while the adapter reads the configuration;
settings persistence, explicit URLs, and other providers are left untouched.
If your original adapter has a different entry ID, adjust the disabling override
in your profile accordingly.

### Check startup

Successful discovery logs `Copilot catalog synced` with the supported model count
and JSON-escaped unsupported IDs. Failures log one of `TIMEOUT`, `HTTP_ERROR`,
`INVALID_CATALOG`, `UNTRUSTED_ENDPOINT`, `INVALID_AUTH`, `MISSING_ENDPOINT`,
`IMMUTABLE_CATALOG`, or `DISCOVERY_FAILED`; startup still delegates to the original
adapter. Missing Copilot credentials keep the defaults. A validated runtime
endpoint is logged separately without any token or credential value. Sign in through DSH's normal Copilot authorization
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

The tests use synthetic credentials and response/SSE fixtures. They cover arbitrary
new IDs, three advertised protocols, prototype-sensitive IDs, reasoning metadata,
unknown pricing, read-only refresh, endpoint restrictions, deadlines, late responses,
fail-open delegation, and safe diagnostics. Integration tests mount the **actual DSH
adapter** and exercise real SDK request construction for OAuth Enterprise grants,
API-key overrides, stored access tokens, explicit URLs, and failed model listing.
Every mocked discovery/inference request is asserted to target the Enterprise origin.
No live Copilot request or authentication flow is run automatically.

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

4. This repository's npm **Trusted Publisher** is GitHub user `1yefuwang1`,
   repository `dsh-copilot-catalog`, workflow `publish.yml`, environment `npm`,
   allowing `npm stage publish`. No registry token is stored in GitHub.
5. Push a matching `vX.Y.Z` tag and publish a GitHub Release for it. The workflow
   validates tag/version and repository metadata, runs the credential audit,
   tests, peer integration, declarations, and tarball allowlist, then exchanges a
   short-lived GitHub OIDC identity and runs `npm stage publish` with provenance.
6. Review the version in npm's **Staged Packages** page and approve it with 2FA.
   Every release remains private in staging until that explicit approval.

CI runs on Linux, macOS and Windows, on Node 22 and 24. The publish workflow requires
Node 24/npm 11.5.1+ for trusted publishing and only runs for a published GitHub
Release, not for pull requests. The workflow stages rather than directly publishes;
a maintainer approves each release with 2FA. Authentication uses short-lived OIDC
credentials; no npm registry token is stored in GitHub.
Generated `dist/` files stay out of Git; only the
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
  field-by-field. Newly discovered IDs use live metadata and conservative per-protocol
  defaults. Unknown pricing is zero-valued metadata, not a claim that access is free.
- New models require advertised supported endpoints and valid positive context/output
  limits. No endpoint, family, or protocol is guessed from a model name. Optional
  strict tools, developer-role support, long cache retention and advanced features
  are not assumed; correct a model with the original adapter's `modelOverrides` if
  its gateway needs additional compatibility settings.
- Only recognized advertised reasoning-effort values are selectable (`none` maps to
  `off`). Absent/unrecognized effort metadata does not invent reasoning settings;
  native Anthropic `thinking: true` without an effort list uses standard budget
  levels. Native Messages effort lists use adaptive thinking. Endpoint metadata is
  not a guarantee that every optional feature works identically on every gateway.
- Original adapter credential filtering, explicit `models` lists, and
  `modelOverrides` still apply. This plugin neither enables account policies nor
  changes stored `availableModelIds`; an upstream credential allowlist can still
  hide a model until normal refresh/sign-in updates it.
- Enterprise OAuth endpoints outside HTTPS `*.githubcopilot.com` are rejected by
  discovery; normal adapter behavior remains available as fallback.
- Upstream catalog structure, protocol compatibility and Copilot billing metadata
  are not stable public contracts. Re-test protocol defaults and Enterprise routing
  after updates. This package is not affiliated with DeepSeek, GitHub, or the pi-ai
  maintainers.

## License

[MIT](LICENSE). Original DSH and pi-ai packages retain their own licenses; they are
not redistributed in this tarball.
