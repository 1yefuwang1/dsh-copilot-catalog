# dsh-copilot-search

**GitHub Copilot native web search for DeepSeek Harness**, using the existing
`ctx.web` provider seam. This is an experimental host-only ESM/TypeScript plugin.

## What it does

- Registers `github-copilot-search`; keeps DSH's existing `web_search` tool and
  result cards, and does not replace or add an LLM adapter.
- Makes one auxiliary Copilot `/responses` request per query with the native
  `web_search` server tool. The search model is independent of the conversation.
- Preserves structured search sources and URL citations before normalization;
  deduplicates URLs and enriches available titles. It never scrapes prose links
  or uses generated answer spans as source snippets.
- Accepts bounded SSE or JSON Responses output, requires completed native search,
  and rejects failures, incomplete/premature streams and oversized responses.
  Copilot's changing streamed item IDs are handled using stable output indices;
  ambiguous ID-only routing is rejected rather than guessed.
- Reuses the standard `llm-pi-ai/github-copilot` credential record and public
  pi-ai authentication collection/`toAuth()` hook. A search-owned validated refresh
  transport uses the same serialized, cross-process DSH credential lock as inference;
  it does not call the SDK's redirect-following, response-routed refresh transport.
- Reads volatile settings and credentials per operation, honors caller cancellation
  and a provider backstop deadline, rejects credential redirects/untrusted origins,
  and exposes fixed diagnostics rather than raw token-bearing errors.
- Performs **no credential reads, discovery or network calls on import/mount**.
  Availability is a cheap local configuration check, not a live entitlement test.

## Compatibility and prerequisites

DSH/DSH peers `0.2.0-rc.2`, pi-ai `0.87.1`, Node.js `>=22.19.0`. The repository
uses pnpm `11.7.0` for development; installed compiled packages do not run builds
or require a workspace checkout to execute.

You need a Copilot account and an enabled model whose Responses endpoint accepts
native `web_search`. Merely advertising `/responses` is insufficient. GitHub's
[model-native search announcement](https://github.blog/changelog/2026-02-25-improved-web-search-in-copilot-on-github-com/)
identifies the **Copilot can search the web using model native search** setting;
its initial rollout was scoped to selected models on github.com, not a universal
public inference API guarantee. Organization/enterprise policy can restrict it.

The plugin calls **Copilot directly**, not arbitrary local/OpenAI-compatible
proxies or Tavily-emulated search. Direct Copilot gateway contracts may change.
No live native-search compatibility is asserted by the synthetic tests.

## Install

After this package is published, use DSH's Plugins page or:

```sh
dsh plugin --profile <profile> add dsh-copilot-search
```

Or build/link from this monorepo's root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter dsh-copilot-search run build
# This command alters the chosen profile only if you choose to run it:
dsh plugin --profile <profile> add -w packages/search
```

The included bundle overrides the base `web` row to select this provider, keeping
`fetchProvider: http`. It inserts `web-search-copilot` and leaves inference adapters
untouched. If you have a custom fetch provider, preserve it in a higher-priority
profile override. Restart DSH after host-side installation or changing service
selection; there is no browser component or UI rebuild.

**The root Git URL is not an installable plugin:** the root is a private monorepo.
Use a leaf package, its tarball, or its published npm name. Neither this package nor
its tests modifies an active DSH profile or signed application automatically.

## Settings

The settings namespace is the bundle entry ID `web-search-copilot`. Example
higher-priority profile configuration:

```yaml
- id: web-search-copilot
  name: dsh-copilot-search
  config:
    model: gpt-6.1-sol
    timeoutMs: 60000
    maxTokens: 4096
    maxResponseBytes: 2097152
    includeSources: true
    searchMode: default
    forceSearch: false

- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: github-copilot-search
    fetchProvider: http
```

| Field | Default | Meaning |
| --- | --- | --- |
| `model` | `gpt-6.1-sol` | Auxiliary model; choose one verified to support native search for your account |
| `apiKeyEnv` | unset | Optional credential reference; explicitly overrides stored OAuth |
| `baseURL` | unset | Trusted API origin for API-key auth; required for opaque tokens |
| `maxTokens` | `4096` | Output token budget, 16–65,536; respect the selected model's limits |
| `timeoutMs` | `60000` | Entire provider operation including auth, 1–120,000 ms |
| `maxResponseBytes` | `2097152` | Wire-body byte cap, 1 KiB–16 MiB |
| `includeSources` | `true` | Request `web_search_call.action.sources`; disable if the gateway rejects this optional field |
| `searchMode` | `default` | Omit access flags; `live`/`cached` explicitly set `external_web_access` |
| `forceSearch` | `false` | Set `tool_choice: required` when true; only enable if the gateway accepts it |

All provider fields are volatile; each search snapshots them once. The `web`
service's provider selector is nonvolatile, so changing selection requires host
reconfiguration/restart. Explicit YAML selection wins over
`DSH_WEB_SEARCH_PROVIDER`; the environment variable cannot override a configured
base/bundle pin. The existing Web search settings card configures DeepSeek only,
not this provider. No generic provider chooser is added here.

The provider deadline does not lengthen DSH's tool-call timeout. DSH's current
four-query default can cause four concurrent auxiliary model requests. The final
source cap limits context, **not upstream native searches or charges**. Auxiliary
usage is billed by Copilot and is not added to the conversation adapter's token
usage totals by this provider. There is no automatic retry, another-vendor fallback,
or silent downgrade after rejection.

## Authentication and routing

Sign in through DSH's normal Copilot authorization flow. The catalog wrapper is
optional; the standard pi-ai adapter's account record works too.

Precedence matches pi-ai:

1. Explicit `apiKeyEnv` reference, when configured. An unset/invalid reference
   fails; it never falls back to another stored account.
2. Existing provider-owned OAuth or API-key record. Malformed/failed OAuth does
   not fall back silently to an ambient key.
3. Ambient `COPILOT_GITHUB_TOKEN`, including DSH-managed references and the
   launch environment, only when no stored grant owns authentication.

OAuth supplies its account endpoint per request. For API keys, explicit `baseURL`
wins; otherwise the public Copilot hook derives the token's `proxy-ep` origin.
Opaque tokens need an explicit origin. Example:

```yaml
- id: web-search-copilot
  name: dsh-copilot-search
  config:
    apiKeyEnv: COPILOT_ACCESS_TOKEN
    baseURL: https://api.enterprise.githubcopilot.com
    model: gpt-6.1-sol
```

Use the origin belonging to your account. Only plain HTTPS `*.githubcopilot.com`
origins are accepted: no userinfo, custom port, path, query, fragment, ambiguous
backslashes or control characters. A GitHub PAT is not a Copilot access token;
use DSH sign-in rather than inventing another exchange flow.

Search only persists normal refreshes of **existing OAuth grants** through public
`Models.getAuth()` and DSH's lock; it cannot create/delete records, replace API
keys or change the original grant's refresh-token/Enterprise-domain authority.
A search-owned refresh transport performs the existing grant exchange without a
new login flow. Its GitHub/Enterprise exchange domain comes only from trusted
host-owned grant metadata, never from an HTTP response. Every returned Copilot
origin is validated before a `/models` request or credential handoff. Exchange,
catalog and search requests all refuse redirects; auth response bodies have an
independent 1 MiB cap. The SDK's own unvalidated refresh transport is not invoked.

Grants are cloned, undefined optional fields normalized, and cancellation checked
before queuing, at lock entry and before callback handoff. DSH's lock wait is not
cancellable. After the mutation callback hands a refreshed grant back to storage,
cancellation cannot guarantee that a later commit is prevented or rolled back,
even if the atomic write has not begun. Public helper callbacks and existing
owner-grant metadata are trusted host capabilities, not a sandbox for malicious
plugins.

## Results and failures

The normalized result is `{content?, sources, truncated}`. Sources contain a URL
and optional title, explicit snippet or ISO date metadata. No missing metadata is
invented. Opaque provider citation markers are removed without guessing a mapping;
DSH renders the retained structured sources as Markdown links and source cards,
with its external-content trust notice.

The parser requires at least one completed `web_search_call` search action. A
completed search with no sources is a valid empty result; an answer containing only
model-generated links is not. DSH applies `maxResults` and multi-query merge caps.
Byte and structural parser limits also bound malformed or adversarial streams.

Useful controlled codes:

- `WEB_PROVIDER_CREDENTIAL_MISSING` / `WEB_PROVIDER_AUTH_*`: check the reference or
  sign in again; never paste tokens into public issues.
- `WEB_PROVIDER_ENDPOINT_MISSING` / `WEB_PROVIDER_ENDPOINT_UNTRUSTED`: supply the
  account's trusted origin for opaque API keys; do not redirect credentials to a proxy.
- `WEB_PROVIDER_UNSUPPORTED`: check the model, account's native-search setting,
  endpoint and optional request fields.
- `WEB_NO_SEARCH`: the model did not actually execute native search; optionally
  test forced tool choice if supported.
- `WEB_RESPONSE_FAILED`, `WEB_RESPONSE_INCOMPLETE`, `WEB_STREAM_INCOMPLETE`,
  `WEB_INVALID_RESPONSE`: upstream response was not a complete valid native search.
- `WEB_ABORTED`, `WEB_TIMEOUT`, `WEB_RESPONSE_TOO_LARGE`: cancellation or configured
  operation/resource bounds were reached.
- `WEB_HTTP_ERROR` / `WEB_NETWORK_ERROR`: check connection, account/quota and route.

## Development and public API

From the repository root:

```sh
pnpm --filter dsh-copilot-search run typecheck
pnpm --filter dsh-copilot-search run test
pnpm --filter dsh-copilot-search run test:integration
pnpm --filter dsh-copilot-search run test:types
pnpm --filter dsh-copilot-search run test:pack
```

Root exports are DSH `name`, `Config`, `inject`, `apply`, provider identity/class,
and option types. Side-effect-free subpaths expose the provider, pure Responses
parsers and injected authentication helpers. Runtime peer resolution starts from
the adapter's package; no private OAuth module or machine-specific app path is
imported. Every published root/subpath target is checked by packaging tests.

Tests use synthetic credentials, public SDK collections, mocked JSON/SSE and the
actual DSH web registry. They cover account precedence, Enterprise routing,
serialized refresh, logout/rotation/cancellation races, secret-safe errors,
request flags, URL/citation normalization, malformed streams, resource limits,
registration, volatile settings and public type declarations. No real account,
profile, credential file or authenticated network request is used.

## Rollback

Remove/disable the search bundle and restore the `web` row's desired search and
fetch selection (for the shipped defaults: `deepseek-official` and `http`). Remove
later overrides still pointing at `github-copilot-search`, then restart DSH. Do
not delete the Copilot grant or change the inference adapter. The optional catalog
plugin has its own independent rollback instructions.

## License

[MIT](LICENSE). DSH/pi-ai are peer dependencies, not redistributed code. This
package is not affiliated with GitHub, DeepSeek or the pi-ai maintainers.
