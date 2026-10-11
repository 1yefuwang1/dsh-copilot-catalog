# Monorepo changelog

## @1yefuwang1/dsh-worktrees 0.2.18

- Align Local/New worktree controls, native menu colors and the search field with
  the surrounding UI, including non-Git Local-only folders.
- Default to the current local branch; choose local committed branches without
  fetching or retain freshly fetched remote branches, with explicit commit fences.
- Search complete cached branch generations without requests on keystrokes;
  select and dismiss automatically, while Refresh preserves the open picker,
  search and selection. Add real React interaction and CSS-cascade regressions.
- Retain existing permissions, native draft, cancellation and source-checkout
  defenses. Raise only the worktree package's bounded size ceiling to 575,000 bytes.

## @1yefuwang1/dsh-worktrees 0.2.17

- Offer each Add folder entry only where the composed directory picker can serve
  it: **Browse for folders** requires a Host that lists directories, **Choose a
  folder…** requires a reachable system chooser, and path entry always works. The
  desktop composition (system chooser only) no longer shows a browser entry that
  fails with `directory-picker/unavailable`.
- Default the add dropdown to that session share: the system chooser on desktop,
  the in-app browser where the Host lists directories, and path entry only when
  neither exists, so the first thing offered is never a disabled Add button.

## @1yefuwang1/dsh-worktrees 0.2.16

- Relabel the Add folder entries as **Browse for folders**, **Choose a folder…**
  and **Enter a folder path** in both dictionaries, so the multi-select browser and
  the one-folder system dialog no longer read like the same action.

## @1yefuwang1/dsh-worktrees 0.2.15

- Offer the native add option only where the session really has a picker (desktop
  shell bridge or Host `uiWorkspace.pickDirectory`), so the desktop project dialog
  no longer shows a control that fails; browsing and absolute-path entry stay
  available everywhere.

## @1yefuwang1/dsh-worktrees 0.2.14

- Move the Projects/Workspace view switch into native sidebar navigation between
  Automation tasks and Worktrees, with explicit destination labels and native
  styling. Preserve the current conversation, other panels and sidebar extensions.

## Unreleased — Three independent plugin workspaces

- Prepare the `@1yefuwang1/dsh-worktrees` `0.2.13` Host/Web Client release: persistent
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
- [Worktrees changelog](<packages/worktrees/CHANGELOG.md>) — `@1yefuwang1/dsh-worktrees@0.2.18`; staged release requires maintainer approval before npm availability.
