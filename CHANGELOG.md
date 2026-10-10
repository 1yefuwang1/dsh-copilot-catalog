# Monorepo changelog

## Unreleased — Three independent plugin workspaces

- Add the unpublished `dsh-worktrees` `0.2.13` Host/Web Client package: persistent
  multi-folder projects with durable main-folder defaults and agent folder reminders,
  project-bound Local/worktree threads, visible backing
  indicators, native new-conversation worktree choice, lazy first-Send creation
  from a fresh remote base, staged progress and pre-admission fast branch naming, manager/reminders and
  explicitly guarded optimistic Local handoff with retained sources/history.
- Align Projects sidebar with native Folder view icons, regular title typography,
  session last-active times and counted Show X more sessions controls.
- Support metadata-only project removal with confirmation and durable import
  suppression; retain folders, files, conversations, worktrees and start receipts.
- Keep cross-root Git mutations Full-access-only; no privilege fallback, cached
  fetch fallback, continuous synchronization or physical-delete operation.
- Extend release targeting/public declaration checks and exact publication
  allowlists to the third leaf without widening either existing package's files
  or 150,000-byte size bound; worktrees has a separate 525,000-byte bound (44 files; project metadata and native-aligned sidebar controls added without widening the other leaves).
- Include local-Git fixtures and static/pure Client protocols; installed browser
  registration/interaction still requires separate live verification.

### Existing Copilot package migration

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
- [Search changelog](<packages/search/CHANGELOG.md>) — `0.1.2` GHE Cloud endpoint support; `0.1.1` first public native-search release and streaming compatibility fix.
- [Worktrees changelog](<packages/worktrees/CHANGELOG.md>) — `0.2.13` unreleased; not published.
