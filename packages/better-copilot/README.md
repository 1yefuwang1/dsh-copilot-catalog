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
- **Builtin Auto review overrides** — selects the review model and effort without
  changing the conversation model or the builtin authorization policy.
- **Temperature compatibility** — omits unsupported sampling controls on the
  Copilot wire, including the builtin reviewer's hard-coded zero.

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
    catalog:
      cache: true
      refreshIntervalMs: 900000 # refresh on use after 15 minutes
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
    autoReview:
      enabled: true
      # Optional: leave unset for Terra on Copilot, current model otherwise
      # model: gpt-6.1-terra
      # reasoningEffort: high
```

`providers` is the pi-ai adapter's own schema, reused unchanged, so every
provider setting behaves exactly as it does with the stock adapter. `search`
configures the web-search provider; `toolSchema` configures the Gemini guard;
`autoReview` configures the builtin review request only.

Loader patches replace a row's `config` wholesale, not key by key: an override
must restate every non-default group it needs together. Omitted `catalog`,
`search`, `toolSchema` and `autoReview` groups resolve their defaults.

## Persistent model catalog

By default, the plugin retains the **last successfully discovered account catalog**
in DSH's storage domain `dsh_better_copilot_catalog`, table `catalogs`. DSH's
configured storage backend determines the physical location; nothing is written
into this repository or the profile's plugin configuration. The optional
`storageDomain` service is required for persistence. If it is absent or cannot
open, discovery and inference still work without a disk cache.

- Records are keyed by a digest of the credential identity, record context and
  validated account endpoint. OAuth access-token rotation reuses the cache; a
  different grant/API key or endpoint does not. Re-signing in with a new grant
  creates a separate entry, even for the same GitHub user.
- Only bounded, allowlisted model metadata and its fetch timestamp are persisted.
  OAuth grants, API keys, Authorization headers and arbitrary response fields are
  never written. Unsupported versions, malformed/foreign records, future dates
  and entries older than **7 days** are ignored.
- Startup loads a matching valid cache before attempting a live `/models` fetch,
  including before an expired OAuth grant is refreshed. Network/refresh failure
  preserves that cached list; success replaces it. This is the latest **known**
  list, not a guarantee of present account entitlement.
- Model listing, resolution and call preparation refresh on demand after
  `catalog.refreshIntervalMs` (default **15 minutes**). A missing model triggers
  one bounded refresh before lookup fails, with a shared **60-second** miss
  cooldown to prevent request storms. There is no idle polling timer and no
  retry of a paid inference request.
- Concurrent callers share discovery. Canceling one waiter does not cancel other
  waiters; canceling them all or unloading the plugin blocks late registry
  publication. DSH storage writes already submitted cannot be canceled, but are
  account-scoped; subsequent writes and publication remain guarded.
- Successful refresh invalidates the adapter's live profile/model snapshot and
  notifies model pickers. Already-prepared calls retain their original snapshot.
  Credential and provider-profile changes clear account-specific runtime state;
  other providers and explicitly configured models remain supported.

Set `catalog.cache: false` to disable cache reads/writes without disabling live
discovery. Cache and interval settings are volatile and affect the next refresh;
disabling persistence does not delete previously saved records. A host restart
is needed to load an updated plugin implementation, not to adopt a live catalog.

## Builtin Auto review

`autoReview` applies only to requests marked `purpose: auto-review` by the builtin
experimental Auto review plugin. It does not enable Auto review, select a
permission preset, replace its policy or change normal conversation/subagent
requests.

- With no `autoReview.model`, GitHub Copilot reviews use `gpt-6.1-terra`.
  DeepSeek Flash (`deepseek-v4-flash`) stays on Flash; other non-Copilot providers
  retain their current model.
- `autoReview.model` selects an exact model id on the current provider;
  `autoReview.reasoningEffort` selects that model's exact effort id. Explicit
  settings win over defaults, including on DeepSeek. Omitted effort uses the
  selected model's adapter default, not the main agent's effort. A model change
  drops any prior model's effort. Unsupported explicit efforts fail normally
  before provider I/O, without clamping or silently switching models.
- Settings are volatile: edits apply to the next review, not an in-flight review.
  `autoReview.enabled: false` restores the builtin request's model and effort.

The builtin reviewer hard-codes `temperature: 0`. Copilot review requests omit
this parameter unless the selected catalog model positively advertises
`compat.supportsTemperature: true`, so older GPT metadata lacking a temperature
flag does not cause an unsupported-parameter error. This conservative rule is
limited to the reviewer-owned control; it does not discard explicit sampling
settings on ordinary requests with unknown support.

For ordinary Copilot inference, account discovery maps boolean
`capabilities.supports.temperature` into `compat.supportsTemperature`. The
existing trusted wire transform strips `temperature` only for exact catalog
models declaring `false`; supported and unknown metadata preserve the original
body. No model-name or reasoning-capability heuristics are used. Temperature
normalization remains active with wire identity disabled, and a Gemini guard
failure cannot undo a successful temperature fix.

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
another plugin's settings, and a guard failure preserves the body after any
successful temperature normalization.

## Subagent model badge (Web)

The package now carries a small browser client half. When a subagent
conversation is open in the Web GUI, the session header shows the child's
effective route as muted text next to the title — for example
`gpt-6.1-sol · high`. The label is read-only: the plugin renders no selector and
writes nothing back, because the Host fixes a child's provider, model and
reasoning effort when the subagent is created and reuses the recorded route on
resume. An adapter-defaulted effort appears as `default`, and the tooltip and
accessible name say that the route is fixed.

The badge reads the child Session's `modelSelection` projection; it adds no Host
service, configuration field or RPC. Ids are shown exactly as the Host records
them, because catalog display names are not exposed to third-party client
plugins. Ordinary conversations are unchanged, and the subagent catalog
dropdown is untouched: DSH renders those rows in its own client package rather
than through an extension slot. The browser half is published as `./client`
and declared through `dsh.client`; no additional wiring is needed.

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

- Discovery requests are bounded and read-only with respect to credentials. A
  failed refresh retains a valid matching cache/current catalog, or bundled
  defaults when none exists; logs contain only controlled reason codes.
- Search requests never forward credentials to redirects or untrusted origins.
- The guard only supplies a missing `properties` bucket; it does not rewrite
  references, unions or nested schemas.

The full field mapping is: the search plugin's row-level `apiKeyEnv`, `baseURL`,
`model`, `maxTokens`, `timeoutMs`, `maxResponseBytes`, `includeSources`,
`searchMode` and `forceSearch` are now `search.*`; the guard's `providers`,
`families` and `logFixes` are now `toolSchema.*`; and every adapter provider
setting stays under `providers.*` unchanged.
