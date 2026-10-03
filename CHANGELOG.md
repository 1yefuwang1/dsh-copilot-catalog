# Changelog

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

This entry describes prepared source, not a claim that the package has already
been published to npm or GitHub.
