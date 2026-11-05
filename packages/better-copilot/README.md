# dsh-better-copilot

One DeepSeek Harness plugin for GitHub Copilot:

- **Account-aware model discovery** — reads the stored Copilot OAuth grant (or an
  explicit API-key reference), lists the account's models, and keeps the bundled
  catalog only as a fallback.
- **Copilot-compatible wire identity** — installs a refcounted `fetch` header
  interceptor while mounted so the pi-ai adapter presents Copilot client
  identity headers.
- **Native Responses web search** — registers the `github-copilot-search`
  provider for the ordinary `web_search` tool.
- **Gemini tool-declaration guard** — adds a missing root `properties` bucket to
  tool parameter schemas for configured Copilot routes.

The plugin is a replacement for, and superset of, the earlier separate
`dsh-copilot-catalog`, `dsh-copilot-search` and `dsh-copilot-tool-schema`
packages. Their behaviour is consolidated here; see the migration notes below.

## Compatibility

- DSH and DSH peer packages: `0.2.2-rc.1`.
- `@earendil-works/pi-ai`: `^1.1.0` (host-aligned peer range; tested at `1.1.0` and `1.3.0`).
- Node.js: `>=22.19.0`.

The plugin resolves the same public pi-ai runtime the DSH adapter uses, including
nested pnpm layouts. It vendors neither DSH nor pi-ai and does not modify
signed applications. This is an experimental third-party integration, not
affiliated with GitHub, DeepSeek or the pi-ai maintainers.

## Installation

Install or link this leaf package, not the monorepo root. The package is
published as `dsh-better-copilot`; until a registry release exists, install the
packed tarball or link the workspace directory. Restart the DSH host after
installing or removing a host plugin.

The bundle patch:

- disables the stock `llm-pi-ai` row and mounts this plugin in its place (the
  merged plugin is the adapter wrapper), so never enable two adapters for the
  same route;
- selects `github-copilot-search` for the `web` row and keeps the HTTP fetch
  provider;
- inserts one `better-copilot` row whose config names a `github-copilot` provider
  profile (an empty profile, `{}`) plus default `search`/`toolSchema` settings.

## Configuration

```yaml
- id: better-copilot
  name: dsh-better-copilot
  config:
    providers:
      # The pi-ai adapter's own provider profile: baseURL, apiKeyEnv, models, ...
      github-copilot: {}
    search:
      model: gpt-6.1-sol
      maxTokens: 4096
      timeoutMs: 60000
      maxResponseBytes: 2097152
      includeSources: true
      searchMode: default
      forceSearch: false
      # apiKeyEnv / baseURL are optional credential and endpoint overrides
    toolSchema:
      providers: [github-copilot]
      families: [gemini]
      logFixes: false
```

`providers` is the pi-ai adapter's own schema, reused unchanged, so every
provider setting behaves exactly as it does with the stock adapter. `search`
configures the web-search provider; `toolSchema` configures the Gemini guard.

Loader patches replace a row's `config` wholesale, not key by key: an override
must restate `providers`, `search` and `toolSchema` together.

## Wire identity

While mounted, the plugin installs a refcounted `fetch` header interceptor that
rewrites Copilot request headers to a VS Code/`copilot-chat` identity. Set
`DSH_COPILOT_WIRE_IDENTITY=basic` to avoid local VS Code IDs, or `0` to disable
the interceptor entirely.

## Search

Search uses the stored `llm-pi-ai/github-copilot` credential — inference may use
either the stock adapter or this wrapper. Sign in through DSH's normal Copilot
flow. `web_search` is an ordinary tool independent of the conversation model; the
existing Web search settings card is DeepSeek-specific and is not a chooser.

## Guard

The guard is a Copilot wire-body transform. `0.2.2-rc.1` assembles tool
declarations outside the presentation waterfall and treats them as
provider-owned, so the last supported seam is the serialized request the adapter
dispatches. Inside the same refcounted, trusted-path-checked interceptor that
carries the wire identity, it adds an empty root `properties` bucket to object
tool schemas that lack one for a configured Copilot route and model family, and
leaves every other byte of the request untouched. It never replaces an adapter or
another plugin's settings, and a guard failure dispatches the original body.

## Migration from the three predecessor packages

| Was | Now |
| --- | --- |
| package `dsh-copilot-catalog`, row `llm-pi-ai-catalog` | package `dsh-better-copilot`, row `better-copilot` |
| package `dsh-copilot-search`, row `web-search-copilot` | same row `better-copilot`; `model` became `search.model` |
| package `dsh-copilot-tool-schema`, row `copilot-tool-schema` | same row `better-copilot`; guard fields moved under `toolSchema.*` |
| `@deepseek-ai/dsh-llm-pi-ai` disabled by the catalog bundle | still disabled by this bundle |
| `web.searchProvider: github-copilot-search` | still selected by this bundle |

Subpath exports also changed: the predecessor specifiers `…/provider`,
`…/responses`, `…/auth`, `…/plugin`, `…/schema` and `…/types` are gone. Use the
merged package root, `dsh-better-copilot/catalog`, `/discovery`, `/identity`,
`/search` and `/guard` instead. The colliding `CopilotAuthOptions` type is
exported as `CatalogAuthOptions` and `SearchAuthOptions`.

The predecessor npm versions remain published; this repository no longer builds
them and treats them as superseded.

## Limits

- Discovery is one read-only, bounded startup request; failures keep the bundled
  catalog and log only a controlled reason code.
- Search requests never forward credentials to redirects or untrusted origins.
- The guard only supplies a missing `properties` bucket; it does not rewrite
  references, unions or nested schemas.

The full field mapping is: the search plugin's row-level `apiKeyEnv`, `baseURL`,
`model`, `maxTokens`, `timeoutMs`, `maxResponseBytes`, `includeSources`,
`searchMode` and `forceSearch` are now `search.*`; the guard's `providers`,
`families` and `logFixes` are now `toolSchema.*`; and every adapter provider
setting stays under `providers.*` unchanged.
