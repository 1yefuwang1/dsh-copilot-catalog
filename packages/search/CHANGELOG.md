# Changelog

## 0.1.1 — Copilot streaming ID compatibility

- Route native Responses stream items by stable `output_index`: Copilot may rewrite
  `item.id` and `item_id` between added, progress, done and terminal events.
- Retain bounded ID aliases only for unambiguous ID-only fallback; keep strict
  indices, slot-type consistency, byte limits and native-search completion checks.
- Add synthetic regressions matching the observed live Copilot event structure.
- Fix `WEB_INVALID_RESPONSE` after a successful HTTP 200 native search response.

## 0.1.0 — Initial implementation

- Add an independently installable host-side Copilot native-search plugin and DSH bundle.
- Register `github-copilot-search` without replacing the existing web tool or inference adapter.
- Use public adapter-resolved pi-ai authentication on the existing scoped Copilot record,
  with serialized OAuth refresh and cancellation guards around queued/late mutations.
- Support Enterprise/API-key routing, trusted HTTPS gateway origins, fixed diagnostics,
  and per-operation volatile settings snapshots.
- Add native Responses JSON/SSE parsing, structured source/citation normalization,
  actual native-search verification, resource limits and cooperative cancellation.
- Harden response-derived refresh routing before catalog requests or persistence,
  with a bounded, redirect-refusing search-owned transport under public Models locking.
- Prevent mutable error/discriminant bypasses and quadratic citation/SSE parsing.
- Add synthetic unit, public-peer/web-registry integration, public-type and exact
  package-content tests. No live account search support has been independently probed.

This package has not been published by this repository migration.
