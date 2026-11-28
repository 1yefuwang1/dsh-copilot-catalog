# Changelog

## 0.5.8 — Request-carried bodies reach the wire transform

- Fix the defect that made `0.5.7`'s empty-turn repair unreachable in a real DSH
  host. The wire transform only read `init.body` when it was a string, but DSH's
  fetch observer replaces `globalThis.fetch` and re-dispatches every call as a
  single `Request`, so the transform saw `(Request, undefined)` and skipped every
  body stage: empty-text removal, the Gemini tool default, temperature omission
  and Responses strictness. Identity headers still applied, because they read the
  Request's headers, which is why the failure looked like a repair that did not
  work rather than a stage that never ran.
- Read the body from either encoding: `init.body` when it is a string, otherwise
  the body of the caller's `Request`, cloned so the caller's object stays unread
  and reusable. A rewrite of a Request-carried body is dispatched as a new
  `Request` built from the caller's one, preserving method, headers, signal and
  all other init state; `content-length` and `transfer-encoding` are dropped so
  the new body is framed by fetch. Non-string bodies (streams, `Blob`,
  `FormData`), bodyless requests, consumed bodies and untrusted shapes are
  delegated exactly as before.
- Add wrapper tests for the string and Request encodings, unchanged bodies,
  untrusted and bodyless requests, a consumed body, and a throwing transform, plus
  one integration test that reproduces the real order: the plugin mounts first,
  an observer-style fetch replaces `globalThis.fetch`, and a pi-ai stream must
  still emit a wire body without the empty turn. That test fails against 0.5.7.

## 0.5.7 — empty-text turn repair and a single-pass wire

- Repair the Copilot `chat/completions` rejection that reports only
  `400 {"error":{"message":"invalid request body","code":"invalid_request_body"}}`.
  The route refuses a whole request when a `user`, `system` or `developer`
  message carries the empty string as its content, and the error names neither
  the message nor the role.
- Root cause: a retry that carries no content
  is persisted as a message, the pi-ai adapter serializes it as
  `{"role":"user","content":""}` with no empty guard, and because the turn stays
  in the durable transcript every later request on that route fails until the
  model is changed.
- Add `normalizeCopilotMessages` and `MAX_TRIMMABLE_BODY_BYTES` to the package
  surface. Only the exact failing shape is removed: the same route accepts a
  whitespace-only string, an empty content array, and empty assistant or tool
  messages, so a body with no empty text turn stays byte-identical and a
  repaired body is idempotent.
- Run the repair inside the existing single wire transform, next to the tool
  guard and temperature normalization, so no second body installer can replace
  the guard. A repair failure stays contained and never discards a temperature
  or strictness fix; an all-empty history is left untouched rather than traded
  for the route's separate `Request must contain at least one non-empty
  message.` rejection.
- Add `messages.dropEmpty` (default `true`) and `messages.logFixes`
  (default `false`). The log line reports the count and never logs message
  content. `dropEmpty: false` sends the request exactly as built, for
  diagnosis.
- Add `messages: {}` to the bundle patch and cover the new group in the config
  parity tests, the patch contract test and the wire composition tests.
- Run every wire stage over one parse. Responses strictness, temperature
  omission, empty-text removal and tool-declaration defaults were independent
  string-in/string-out normalizers, so a request needing three of them parsed
  and re-serialized the same multi-megabyte body three times. Each stage now
  exposes an object-level half that mutates the parsed request, and
  `normalizeCopilotRequest` composes them in the original order with one parse
  and at most one re-serialization: 5.50 ms → 2.37 ms on a 2.52 MB request
  (57%), measured, not estimated.
- Keep the string-level entry points unchanged for the package surface and
  their unit tests; they are now thin wrappers over the same object-level
  halves, so a caller cannot observe a difference beyond the composition.
- Preserve every per-stage scope and bound in the composed pass: strictness
  stays Responses-only, empty-text removal stays chat-completions-only,
  temperature stays unbounded, and each stage keeps its own body-size bound.
  A settings group that cannot be read still disables only its own stage.

## 0.5.6 — live OpenCode Go model catalog

- Refresh and cache the `opencode-go` route's chat catalog from OpenCode's public
  `/models` listing with the same demand-driven policy as the Copilot account
  catalog: the persisted last-known selection precedes the live request, a
  15-minute interval or one bounded missing-model retry (60-second cooldown)
  bounds the next refresh, and a failed request keeps the last successful list.
- Replace the installed pi-ai OpenCode Go list with the advertised one, so newly
  released ids such as `kimi-k3.1-pro` appear without a pi-ai bump and withdrawn
  ids stop being selectable. Known ids keep their installed descriptor; new ids
  inherit the advertised wire protocol, capacity, image input, cost (including
  context tiers) and reasoning levels.
- Add `catalog.providers` (default `['opencode-go']`) for non-Copilot routes that
  receive live discovery; Copilot discovery remains always-on. Omitting the
  `opencode-go` profile or setting an empty list disables the listing.
- Persist OpenCode metadata in the existing storage domain and table as a
  `kind: 'opencode-go'` record scoped by the exact listing URL. The cache format
  version is unchanged: legacy Copilot records have no `kind` and remain
  readable. The public listing is never requested with a credential.
- Preserve all existing configuration, credential keys, wire behavior and the
  Copilot catalog format. No migration or reset is required.

## 0.5.5 — DSH 0.2.2-rc.5 compatibility

- Target exact DSH and DSH peer packages `0.2.2-rc.5`. Worktrees and the root
  development SDK remain on `0.2.2-rc.1`.
- Audit the rc.5 delta: `dsh-web` prefers a route-specific DeepSeek search
  provider while none is configured and adds `llmProvider` to search requests,
  `dsh-llm` adds `CONTENT_REFUSED`, and the base profile no longer pins a search
  provider. The bundle patch still pins `searchProvider: github-copilot-search`,
  and a new integration test registers a usable `deepseek-search-api` provider
  to prove the pin outranks rc.5's route preference. No runtime shim or
  persisted-data migration is needed.
- Keep pi-ai peer `^1.3.0` (tested baseline `1.3.0`), Zod `4.6.6`, configuration,
  the catalog cache domain/format and credential record keys unchanged.
- Published through the package-specific staged npm release workflow; npm
  availability requires maintainer 2FA approval. No live GUI or account testing
  is claimed.

## 0.5.4 — provider-aware subagent route badge

- Show the subagent's complete route inline in the Web session header:
  `github-copilot/gpt-6.1-sol · high` instead of only `gpt-6.1-sol · high`.
  Provider and model remain the Host's verbatim ids; an adapter-defaulted effort
  still renders as `default`.
- Size the badge for the longest advertised provider/model route and state in the
  tooltip and accessible name that provider, model and effort are fixed for the
  child's lifetime.
- Let the client render test read an installed `dist/client.js` through
  `BC_CLIENT_BUNDLE`, so release verification covers the packaged browser half
  as well as the workspace build.

## 0.5.3 — explicit non-strict Responses defaults

- Default ordinary function tools to explicit `strict: false` on trusted Copilot
  Responses requests, for bundled, discovered and fallback models alike. Preserve
  explicit strict settings, custom/grammar tools and native tools; other API
  surfaces and providers are unaffected by this wire default.

## 0.5.2 — bounded stream-progress retry

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

## 0.5.1 — DSH 0.2.2-rc.3 compatibility (local preparation)

- Target exact DSH and DSH peer packages `0.2.2-rc.3` for Better Copilot only.
  Worktrees and the root development SDK remain on `0.2.2-rc.1`.
- Keep pi-ai peer `^1.3.0` (tested baseline `1.3.0`), Zod `4.6.6`, existing
  configuration, catalog cache domain/format and credential record keys unchanged.
- Verify the existing adapter, search, storage, Auto review and subagent badge
  contracts against rc.3; no runtime API shim or persisted-data migration is needed.
  Update exact-host regression checks and the CI minimum-pi adapter override.
- Prepare `0.5.1` for the package-specific release workflow; no publication,
  profile installation, live GUI testing or account testing is performed.

## 0.5.0 — DSH 0.2.2-rc.2 migration (local preparation)

- Target exact DSH and DSH peer packages `0.2.2-rc.2`, pi-ai peer `^1.3.0`
  (tested baseline `1.3.0`) and Zod `4.6.6`. Root development SDK pins and the
  independent Worktrees plugin remain on `0.2.2-rc.1`. No compatibility
  exemptions are required or recommended.
- Retain persistent account catalogs/live refresh, native Responses search,
  Copilot wire identity, Gemini schema guarding, temperature normalization,
  builtin Auto review overrides and the read-only subagent route badge. The
  rc.2 audit found the search-provider/WebError contracts, bundle IDs, badge
  session slot and `modelSelection` wire shape (`lastUsed`, `next`) compatible.
- Correct search guidance for rc.2's native search-provider picker and provider
  directory; add no custom UI or metadata feature.
- Preserve configuration, the cache domain/format version and credential record
  keys. Existing persisted account caches need no migration or reset.
- Document the DSH CLI/host Node.js minimum of `>=24.9.0` separately from the
  unchanged plugin library/helper minimum of `>=22.19.0`.
- This version is staged for npm under the package-specific release workflow.
  No live GUI or account testing is claimed.

## 0.4.0 — persistent account catalogs and live refresh

- Cache the last successful account model metadata in DSH's optional
  `dsh_better_copilot_catalog` storage domain, isolated by hashed grant/API-key
  identity and validated endpoint. Store no credentials; reject malformed,
  foreign, future, oversized or more-than-seven-day-old entries.
- Load valid cache metadata before startup refresh and preserve it during
  network/OAuth failures. Add volatile `catalog.cache` and
  `catalog.refreshIntervalMs` (15-minute default) settings.
- Refresh before model listing/resolution/preparation on demand, and once for
  missing models with a shared 60-second cooldown. Invalidate the active adapter
  registry while preserving already-prepared calls, explicit model declarations
  and other provider routes.
- Deduplicate concurrent discovery, guard cancellation/unload/account changes,
  and give missing builtin reviewers an actionable failure rather than a silent
  model fallback. Add synthetic and real DSH storage/adapter regressions.

## 0.3.0 — builtin review routing and temperature compatibility

- Add volatile `autoReview.enabled`, `autoReview.model` and
  `autoReview.reasoningEffort` settings. Builtin GitHub Copilot reviews default to
  `gpt-6.1-terra`; DeepSeek Flash and non-Copilot routes retain their current
  model. Omitted effort uses the selected model's adapter default.
- Redispatch detached frozen auxiliary requests through the public LLM
  waterfall, leaving conversation requests, review policy, permission state,
  Session metadata and cancellation unchanged; dispose the listener on unload.
- Remove the builtin Copilot reviewer's sampling parameter unless its model
  positively advertises support. Map boolean account temperature capability
  metadata into known/new catalog descriptors and strip explicitly unsupported
  temperature on ordinary Copilot inference requests without model-name guesses.
- Compose temperature and Gemini normalization in the existing wire transform;
  a Gemini guard failure cannot discard a temperature fix. Add routing, effort
  validation, metadata, protocol, lifecycle and publication regressions.

## 0.2.0 — read-only subagent route badge

- Add a browser client half that shows an addressed subagent's effective model
  and reasoning effort in the Web session header, beside the title. The label is
  text only: no selector, no click target, no Host write, because the child's
  route is fixed at creation and reused on resume.
- Read the route from the existing `modelSelection` session projection and show
  an adapter-defaulted effort as `default`. Provider/model/effort ids render
  verbatim; catalog display names are not available to client plugins.
- Keep ordinary conversations and the DSH-rendered subagent catalog untouched.
  Ship the bundle through `./client` and a `dsh.client` declaration, with render
  tests and the publication allowlist updated.

## 0.1.1 — DSH 0.2.2-rc.1 compatibility

- Retarget the manifest, peer ranges and development pins to DSH `0.2.2-rc.1`
  with `cordis ~4.1.0` and `schemastery ~3.19.0`.
- Move the Gemini tool-declaration guard from the `system-prompt/assemble`
  waterfall to the Copilot wire. `0.2.2-rc.1` assembles tool declarations
  outside the presentation waterfall, so the guard now rewrites the serialized
  request body inside the same refcounted interceptor that carries the wire
  identity. It still adds only a missing root `properties` bucket, still matches
  configured providers and model families, keeps `SKIPPED_*` reason codes and
  `logFixes` summaries, and now runs even when `DSH_COPILOT_WIRE_IDENTITY=off`.
- Export `installCopilotRequestTransform`, `guardCopilotRequestBody`,
  `GuardedBody` and `MAX_GUARDED_BODY_BYTES`; `./guard` keeps exporting
  `matchesRoute`, `normalizeToolSchemas`, `classifyParameters`,
  `TOOL_SCHEMA_SKIPPED` and their types.
- Follow the adapter's `1_000_000`/`128_000` profile defaults, its
  `llm-pi-ai/request-headers` waterfall and the branded reasoning-effort id.

## 0.1.0 — consolidated Copilot plugin

First release of `dsh-better-copilot`, merging three independently installable
plugins into one package with one bundle row (`better-copilot`) and one combined
configuration object:

- `dsh-copilot-catalog@0.2.9` — account-aware model discovery, Copilot wire
  identity and the pi-ai adapter wrapper.
- `dsh-copilot-search@0.1.5` — the `github-copilot-search` Responses web-search
  provider.
- `dsh-copilot-tool-schema@0.1.3` — the Copilot Gemini tool-declaration guard.

Behaviour is preserved:

- the wrapper still disables and replaces `llm-pi-ai`, still preserves the
  adapter's own provider schema, and still installs the wire-identity
  interceptor best-effort;
- search still resolves credentials through the adapter's public pi-ai surface,
  still keeps a search-owned guarded refresh clone, and still refuses untrusted
  origins and redirects;
- the guard still only adds a missing root `properties` bucket for configured
  provider/model families and leaves every other declaration untouched.

Changed:

- one plugin row and one config object: `providers` (unchanged adapter schema),
  `search` (was the search plugin's row config) and `toolSchema` (was the guard's
  row config);
- subpath exports are now `.`, `./catalog`, `./discovery`, `./identity`,
  `./search` and `./guard`; the predecessor subpaths are removed;
- the colliding `CopilotAuthOptions` type is exported as `CatalogAuthOptions`
  and `SearchAuthOptions`;
- a missing `web` service, a throwing guard registration, a throwing search
  registration and a throwing identity installer are contained: they degrade
  only their own capability instead of failing the mount.
