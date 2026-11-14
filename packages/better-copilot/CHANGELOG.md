# Changelog

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
