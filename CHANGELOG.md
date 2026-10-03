# Changelog

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
