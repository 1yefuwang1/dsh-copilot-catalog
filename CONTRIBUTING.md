# Contributing

Use Node.js 22.19+ and npm. Install with `npm ci --ignore-scripts`, then run
`npm run verify`. Source is strict TypeScript under [`src/`](src/); runtime tests
are ESM JavaScript under [`test/`](test/) and exercise the compiled output. No live
OAuth grant or Copilot account is required. Keep the lockfile committed.

Do not add application-specific paths, install-time profile edits, credential
writes, tokens in fixtures, or raw network/auth errors in logs. New model templates
must have an explicitly verified compatible API, valid limits, and tests for
reasoning/vision/pricing behavior. Do not guess protocols for arbitrary new IDs.

Preserve the original adapter's schema and credential record key. Run the peer
integration suite after any dependency upgrade. Widen version ranges only after
checking the shared catalog and actual OAuth/provider export contracts. The
upstream packages' declarations are skipped by `skipLibCheck`; this project's own
source is fully strict-checked.

Changes to publication files must update the exact allowlist in
[`scripts/check-pack.mjs`](scripts/check-pack.mjs). Generated [`dist/`](dist/) output
is not committed; `prepare` builds it for Git installs. Reviewers should verify
that no account data enters the Git history or npm tarball.

Releases are explicit maintainer actions described in [`README.md`](README.md).
