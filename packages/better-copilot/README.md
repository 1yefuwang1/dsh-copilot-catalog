# dsh-better-copilot

One DeepSeek Harness plugin for GitHub Copilot and OpenCode Go:

- **Account-aware model discovery** — reads the stored Copilot OAuth grant (or an
  explicit API-key reference), lists the account's models, and keeps the bundled
  catalog only as a fallback.
- **Live OpenCode Go catalog** — refreshes and caches the public OpenCode Go chat
  list, so its model picker tracks the provider without a pi-ai upgrade.
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
- **Bounded stream-progress retry** — aborts an attempt that emits only empty
  control events and lets DSH's ordinary retry policy schedule the next one.

The plugin is a replacement for, and superset of, the earlier separate
`dsh-copilot-catalog`, `dsh-copilot-search` and `dsh-copilot-tool-schema`
packages. Their behaviour is consolidated here; see the migration notes below.

## Compatibility

- Better Copilot `0.5.7`: exact DSH and DSH peer packages `0.2.2-rc.5`.
- `@earendil-works/pi-ai`: peer `^1.3.0`, tested baseline `1.3.0`.
- Zod: `4.6.6`.
- DSH CLI/host runtime: Node.js `>=24.9.0`.
- Plugin minimum: the same Node.js `>=24.9.0`; there is no lower library floor.

The repository root development SDK and the independent Worktrees plugin remain
on DSH `0.2.2-rc.1`. They do not establish this leaf's runtime baseline: Better
Copilot's leaf checks use rc.5 peers. Use the exact supported host version, without
compatibility exemptions; this release does not claim rc.1 or rc.3 host support.

The plugin resolves the same public pi-ai runtime the DSH adapter uses, including
nested pnpm layouts. It vendors neither DSH nor pi-ai and does not modify
signed applications. This is an experimental third-party integration, not
affiliated with GitHub, DeepSeek or the pi-ai maintainers.

## Installation

Install or link this leaf package, not the monorepo root. Its package name is
`dsh-better-copilot`. Version `0.5.7` targets exact DSH `0.2.2-rc.5` and is
published through the package-specific staged release workflow; npm availability
requires maintainer 2FA approval. `0.5.7` repairs the empty text turn Copilot's
`chat/completions` route rejects and runs every wire stage over one parse;
synthetic unit and real-DSH integration tests cover the repair, its composition
and each stage's bound, but no live GUI or account testing is claimed. Until the
staged version is approved, use an explicitly built local tarball or workspace
link only if you intend to change a profile. Restart the DSH host after
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
      providers: [opencode-go]  # non-Copilot routes with live discovery
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
    messages:
      dropEmpty: true
      logFixes: false
    autoReview:
      enabled: true
      # Optional: leave unset for Terra on Copilot, current model otherwise
      # model: gpt-6.1-terra
      # reasoningEffort: high
    streamGuard:
      enabled: true
      providers: [github-copilot]
      # noProgressTimeoutMs: 300000  # default: the route's streamIdleTimeoutMs
```

`providers` is the pi-ai adapter's own schema, reused unchanged, so every
provider setting behaves exactly as it does with the stock adapter. `catalog`
controls persistent caching, the demand-refresh interval and which non-Copilot
routes receive live discovery; Copilot discovery is always enabled. `search`
configures the web-search provider; `toolSchema` configures the Gemini guard;
`messages` repairs empty text turns; `autoReview` configures the builtin review
request only; `streamGuard` bounds a model attempt by stream progress.

Loader patches replace a row's `config` wholesale, not key by key: an override
must restate every non-default group it needs together. Omitted `catalog`,
`search`, `toolSchema`, `messages`, `autoReview` and `streamGuard` groups
resolve their defaults.

## Stream guard

`streamGuard` bounds one model attempt by progress instead of by chunk arrival.
The pi-ai adapter's idle watchdog resets whenever any chunk arrives, so a
provider that emits empty reasoning blocks can keep an attempt alive until the
transport fails. The guard counts only chunks that carry output or accounting: non-whitespace
text or reasoning deltas, tool-call deltas with a name or argument bytes, a
completed non-empty text or reasoning block, a completed tool call, and usage.
Block starts and empty block ends do not count.

The timer runs only while a provider read is outstanding, so time the UI spends
rendering between chunks does not count. On expiry the guard aborts the attempt,
closes the inner stream with a time limit, and throws `TIMEOUT`. DSH's retry
policy can then schedule the next attempt and record it in the normal retry
chain. A caller abort remains `ABORTED` and is never retried. A terminal finish
chunk is delivered immediately and is never converted into a retry, so a
completed tool call is not repeated.

`noProgressTimeoutMs` defaults to the route profile's `streamIdleTimeoutMs`,
which is five minutes unless the profile sets it. The guard is therefore not
stricter than the existing idle watchdog by default. Set it lower to retry
chatty empty streams sooner, or set `streamGuard.enabled: false` to disable the
guard. `providers` defaults to `['github-copilot']`.

## Persistent model catalogs

By default, the plugin retains the **last successfully discovered catalog** for
each managed route in DSH's storage domain `dsh_better_copilot_catalog`, table
`catalogs`. OpenCode Go uses the same domain and retention rules with its own
URL-scoped records (see [below](#opencode-go-model-catalog)); the account-scoped
rules in this section describe the Copilot catalog. DSH's
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

`0.5.7` preserves all existing configuration, credential record keys and the
persisted Copilot cache format; the new `messages` group defaults to repairing
the wire. OpenCode Go records keep their `kind` discriminator inside the same
version-1 cache envelope, so no migration or reset is required; the default
`catalog.providers` includes `opencode-go`, and discovery only runs when that
route profile exists.

## OpenCode Go model catalog

When the `opencode-go` route is configured, the plugin keeps its chat catalog in
sync with OpenCode's public listing at
`https://opencode.ai/inference/go/v1/models`. The listing is read without a
credential: discovery never resolves or sends `OPENCODE_API_KEY`. An explicit
`providers['opencode-go'].baseURL` redirects both inference and the listing (a URL
with no version segment gains `/v1/models`); endpoints must be canonical HTTPS
origins, and redirects are refused.

- A persisted selection for the exact listing URL is published first, then the
  live listing replaces it. A failed live request keeps the last successful
  selection, or the installed pi-ai list when nothing was ever cached, and
  reports a controlled diagnostic such as `FETCH_FAILED` or
  `CACHE_FALLBACK:FETCH_FAILED`.
- The live result **replaces** the installed list: ids OpenCode no longer
  advertises disappear, and ids it newly advertises become selectable. Known ids
  keep their installed descriptor, including its richer wire compatibility; new
  ids are described from the listing.
- New descriptors use the advertised protocol (`chat-completions` →
  `openai-completions`, `messages` → `anthropic-messages`, `responses` →
  `openai-responses`, `generate-content` → `google-generative-ai`), capacity,
  image input, cost (including the cheapest advertised cache-write retention and
  context tiers) and reasoning levels. Decision, embedding, unknown-protocol and
  tool-less entries are reported instead of guessed. Audio and video input
  modalities are not advertised because pi-ai chat models take text and images.
- Records carry `kind: 'opencode-go'` and a scope digest of the exact listing URL
  in the same domain/table. The cache format version is unchanged; records from
  before this release have no `kind` and remain readable as Copilot catalogs. The
  same 7-day expiry, 15-minute interval, one-retry missing-model refresh and
  60-second miss cooldown apply.
- `catalog.providers` selects non-Copilot routes that receive discovery. The
  default is `['opencode-go']`; set it to `[]` to keep the installed OpenCode
  list, or omit the `opencode-go` profile to skip the route entirely. The listing
  is public, so it may advertise a model the account's plan does not serve; a
  rejected request stays an ordinary provider error and no entitlement probe is
  attempted.
- Each successful publication emits `llm/models-updated` for the route, so open
  model pickers refresh without restarting the host.

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
native rc.5 search-provider picker and provider directory expose provider
selection, and a search request may name the model route it serves. The bundled
patch pins `github-copilot-search` so rc.5's route preference cannot reselect a
DeepSeek provider; this plugin adds no custom search chooser.

## Guard

The guard is a Copilot wire-body transform. Since `0.2.2-rc.1`, DSH assembles
tool declarations outside the presentation waterfall and treats them as
provider-owned; rc.5 retains this behavior. The supported seam remains the
serialized request the adapter dispatches. Inside the same refcounted, trusted-path-checked interceptor that
carries the wire identity, it adds an empty root `properties` bucket to object
tool schemas that lack one for a configured Copilot route and model family, and
leaves every other byte of the request untouched. It never replaces an adapter or
another plugin's settings.

Every wire stage shares one parse. Responses strictness, temperature omission,
empty-text removal and the tool-schema guard were independent normalizers, each
parsing and re-serializing the whole body; they now mutate one parsed request and
re-serialize at most once. Each stage keeps its own scope and body-size bound, and
a settings group that cannot be read disables only its own stage. On a 2.52 MB
request the pass costs 2.37 ms instead of 5.50 ms.

## Empty-text repair

`messages` repairs one defect that Copilot measures before it resolves a model.
The `chat/completions` route rejects a whole request when a `user`, `system` or
`developer` message carries the **empty string** as its content:

```
400 {"error":{"message":"invalid request body","code":"invalid_request_body"}}
```

The error names neither the message nor the role. The route accepts a
whitespace-only string, an empty content array, and an empty assistant or tool
message, so only the exact failing shape is removed and every other request
stays byte-identical.

The turn gets into the history without typing: a retry that carries no content
is persisted as a message, and because it survives in the durable transcript it
invalidates **every** later request on that route until the model is changed.
`dropEmpty` (default `true`) removes such turns from the serialized body inside
the same wire transform as the guard, so a poisoned conversation recovers
without editing the session file. `logFixes` (default `false`) reports how many
turns were dropped, without logging message content. Set `dropEmpty: false` to
send the request exactly as built.

The repair never empties a message list: a history made only of empty turns is
a different, separately reported rejection, so it is left untouched. It also
applies only to the Copilot route and the `chat/completions` surface — the
Responses surface does not use a `messages` array, and a foreign provider body
is never rewritten.

## Subagent route badge (Web)

The package carries a small browser client half. When a subagent
conversation is open in the Web GUI, the session header shows the child's
effective route as muted text next to the title — for example
`github-copilot/gpt-6.1-sol · high`. The visible label carries the provider,
model and reasoning effort together, so a delegated route can be checked without
opening a tooltip. The label is read-only: the plugin renders no selector and
writes nothing back, because the Host fixes a child's provider, model and
reasoning effort when the subagent is created and reuses the recorded route on
resume. An adapter-defaulted effort appears as `default`, and the tooltip and
accessible name say that the complete route is fixed.

The badge reads the child Session's `modelSelection` projection; it adds no Host
service, configuration field or RPC. Provider and model ids are shown exactly as
the Host records them; the badge reads only the session projection and does not
load the model catalog just to resolve display names. It is sized for the longest
advertised provider/model route; on a narrow window the header clips
title-adjacent actions before they can crowd the utilities. Ordinary
conversations are unchanged, and the subagent catalog dropdown is untouched: DSH
renders those rows in its own client package rather than through an extension
slot. The browser half is published as `./client` and declared through
`dsh.client`; no additional wiring is needed.

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
