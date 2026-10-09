# Changelog

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
