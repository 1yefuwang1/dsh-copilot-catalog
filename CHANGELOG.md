# Monorepo changelog

## Unreleased — Two Copilot plugins, pnpm workspaces

- Move `dsh-copilot-catalog` into its own publishable workspace without changing
  its runtime source, package identity, exports or credential ownership.
- Add separately installable `dsh-copilot-search` for native Responses web search.
- Introduce a private root, pnpm 11.7.0 workspaces/lockfile and shared TypeScript,
  validation, security-audit and package-content tooling.
- Run both plugins' unit/integration/public-type checks in cross-platform CI.
- Select exactly one leaf for staged OIDC publication using package-specific tags;
  preserve the existing maintainer review and 2FA approval policy.
- Keep active profiles, signed applications and real account credentials outside
  development/testing. Native search acceptance requires a separate live probe.

Package history and versions are independent:

- [Catalog changelog](packages/catalog/CHANGELOG.md) — retained `0.2.0`, previously published.
- [Search changelog](packages/search/CHANGELOG.md) — initial `0.1.0`, not published by this migration.
