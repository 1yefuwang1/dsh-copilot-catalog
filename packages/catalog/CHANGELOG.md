# Changelog

## 0.2.5 — agent interaction identity

- Normalize normal Copilot inference and search intent headers to
  `Openai-Intent: conversation-agent` and `X-Interaction-Type: conversation-agent`,
  rewriting pi-ai/search's generic `conversation-edits` value. Explicit subagent,
  compaction, and other specialized interaction metadata is still preserved.
- Set `X-GitHub-Api-Version: 2026-08-01` on every matched request, including search
  and model discovery, matching copilot-api; model discovery remains `model-access`.
  Keep the 0.2.4 identity/SDK-fingerprint behavior, modes, Config, credentials,
  routing, and model descriptors unchanged.

## 0.2.4 — Copilot wire identity

- Install a process-wide `fetch` interceptor while the catalog adapter is mounted
  so Copilot inference no longer sends DSH's `deepseek-harness` User-Agent or the
  OpenAI/Anthropic SDK `x-stainless-*` fingerprints.
- Emit the installed official client's identity headers (`GitHubCopilotChat/0.68.0`,
  `vscode/1.140.0`, `copilot-chat/0.68.0`, `vscode-chat`, VS Code device/machine IDs,
  per-mount session and per-request IDs) while preserving auth, Accept, vision,
  initiator, Anthropic version/beta, and nonempty caller interaction metadata.
- Preserve search/discovery behavior pins: `X-GitHub-Api-Version: 2026-06-01` and
  `Openai-Intent: conversation-edits` are not rewritten; model discovery uses
  `model-access` and removes request-only headers.
- Add `DSH_COPILOT_WIRE_IDENTITY=basic|full|0` (`full` default) plus a refcounted
  installer with cached-wrapper pass-through and external-fetch replacement handling.
- Keep `Config`, credentials, routing, and public model descriptors unchanged.

## 0.2.3 — DSH 0.2.1-rc.2 compatibility

- Retarget the exact runtime pins to DSH/`@deepseek-ai/dsh-llm-pi-ai` `0.2.1-rc.2`,
  Cordis `~4.0.5` and Schemastery `~3.18.5`; the pi-ai peer follows the host
  adapter's own `^1.1.0` range and is tested at `1.1.0` and `1.3.0`.
- Keep adapter-relative pi-ai resolution so discovery mutates the catalog the
  installed adapter actually reads, and refresh the stale version diagnostics.
- Cover a nested layout whose plugin-visible pi-ai differs from the adapter's, and
  assert generated Copilot descriptors stay chat models without touching other
  catalogs.

## 0.2.2 — GHE Cloud endpoint support

- Fix GitHub Enterprise Cloud discovery on GHE.com by accepting HTTPS
  `copilot-api.<tenant>.ghe.com` origins with a single valid tenant DNS label,
  alongside existing `*.githubcopilot.com` routing. Preserve upstream OAuth
  endpoint derivation, credential-read-only refresh, redirect rejection, and
  runtime-only routing defaults without changing profiles or stored credentials.
- Document GHE.com tenant authentication hosts versus Copilot API origins and
  explicit API-key routing; arbitrary GHE services and enterprise domains remain
  outside the discovery trust policy.

## 0.2.1 — pnpm monorepo packaging

- Move source, tests and DSH bundle into the independently publishable catalog workspace.
- Preserve the npm name, public exports, runtime behavior, schema and credential key.
- Use pnpm workspace tooling and package-specific tokenless staged release tags.
- Validate both plugins on Windows, macOS and Linux with Node 22/24, including
  cross-platform workspace-file line endings and credential-safe release tooling.
- Release only the catalog package; the independent search plugin is unchanged.

## 0.2.0 — General discovery and Enterprise routing

- Remove the model-ID allowlist and sibling templates. Construct any newly
  discovered chat model from its advertised endpoint, limits, vision, reasoning,
  and billing metadata.
- Support Responses, Chat Completions, and native Anthropic Messages with
  conservative protocol defaults and deterministic endpoint preference.
- Stop guessing another model's pricing or reasoning capabilities. Preserve
  upstream descriptors for IDs the bundled catalog already knows.
- Remove discovery's dependency on a particular model's headers.
- Derive Enterprise endpoints for OAuth grants and API-key access tokens, honor
  explicit API-key URLs/references, and overlay routing defaults in memory for
  new and bundled models even when listing fails.
- Add actual DSH-adapter/SDK discovery and inference regressions with synthetic
  Enterprise credentials and SSE responses; no live account calls or secret writes.

## 0.1.0 — Initial release preparation

- Convert the local Copilot catalog wrapper to strict TypeScript with ESM output
  and generated type declarations.
- Resolve the original adapter and its own pi-ai catalog using installed npm peers,
  without platform-specific application paths or private OAuth imports.
- Preserve upstream configuration, credential ownership, and model descriptors.
- Add two explicit Responses-compatible sibling templates and account filtering.
- Bound discovery end-to-end and prevent late responses from committing.
- Harden catalog lookups, HTTP endpoint/redirect handling, and diagnostics.
- Add DSH bundle metadata, regression tests, peer integration tests, npm package
  allowlist checks, cross-platform CI, and a trusted-publishing release workflow.

Version 0.2.0 was published to npm through staged GitHub Actions publishing with
SLSA provenance on 2026-10-03. The 0.1.0 entry describes preparation history only.
