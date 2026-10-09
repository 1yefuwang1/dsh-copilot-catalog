# Monorepo changelog

## Unreleased — Two Copilot plugins, pnpm workspaces

- Move `dsh-copilot-catalog` into its own publishable workspace without changing
  its runtime source, package identity, exports or credential ownership.
- Add separately installable `dsh-copilot-search` for native Responses web search.
- Introduce a private root, pnpm 11.7.0 workspaces/lockfile and shared TypeScript,
  validation, security-audit and package-content tooling.
- Run both plugins' unit/integration/public-type checks in cross-platform CI.
- Support JavaScript and standalone/native pnpm launchers in package verification.
- Select exactly one leaf for staged OIDC publication using package-specific tags;
  preserve the existing maintainer review and 2FA approval policy.
- Keep active profiles, signed applications and real account credentials outside
  development/testing. Native search acceptance requires a separate live probe.

Package history and versions are independent:

- [Catalog changelog](packages/catalog/CHANGELOG.md) — `0.2.2` GHE Cloud endpoint support; earlier versions previously published.
- [Search changelog](packages/search/CHANGELOG.md) — `0.1.1` first public native-search release and streaming compatibility fix.
