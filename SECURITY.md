# Security

These host-side plugins run inside DSH with the host user's permissions. Review
each package's source and bundle patch before installation.

- **Catalog:** reads the original provider grant, refreshes only in memory for
  discovery, and updates the shared in-memory model catalog. It does not write
  credential records or change account model policy.
- **Search:** resolves the same scoped Copilot credential per operation through
  public pi-ai APIs. Normal OAuth refresh may persist an existing grant through
  DSH's serialized cross-process lock. Search cannot create/delete records or
  replace API keys; it does not introduce another sign-in flow.
- **Worktrees:** project changes edit only logical metadata. Git worktree setup and
  handoff retain actual-caller permissions and cancellation guards; handoff requires
  idle sessions and stopped external writers. Project removal never deletes source
  directories, sessions or managed checkouts. The Web composer adapter is pinned to
  the supported runtime and fails closed when its private interface changes.
- Both Copilot plugins refuse credential redirects and untrusted direct Copilot origins. Neither
  modifies signed app files or an active profile during automated development.
- Search results and source metadata are external, untrusted content. No generated
  prose URL is accepted as evidence that native search ran.

The search auth bridge checks cancellation before queued mutations, at lock entry,
and after refresh before handing a replacement to storage. DSH's lock wait is not
itself cancellable. Once the mutation callback hands a refreshed grant back to
storage, cancellation cannot guarantee that a subsequent commit is prevented or
rolled back, even if the atomic filesystem write has not started yet.

Search uses a dedicated bounded refresh transport under the public authentication
collection's unchanged lock. The exchange domain comes only from the existing,
host-authorized grant's GitHub/Enterprise metadata; token-response metadata cannot
change it. Newly returned Copilot origins are validated before catalog dispatch
or credential handoff, and exchange/catalog/search redirects are refused. No host
global-fetch mutation or private OAuth module is used. Tests cover malicious
response-derived origins, redirects, late refresh, queued cancellation, concurrent
refresh and logout/account-rotation races. Public helper callbacks and existing
owner-grant metadata are trusted host capabilities, not a plugin sandbox.

Never post OAuth tokens, credential records, raw API responses or profile secrets
in public issues. Report suspected token exposure, endpoint trust failures or
unintended credential writes privately to [the maintainer](https://github.com/1yefuwang1).
Use [GitHub's private vulnerability reporting](https://github.com/1yefuwang1/dsh-copilot-catalog/security/advisories/new)
if enabled; do not open a public issue containing sensitive details.

Supported integration versions are DSH `0.2.0-rc.2` and pi-ai `0.87.1`. Review
lockfile changes and restart the host after upgrading/removing a backend plugin.
Native-search entitlement, API options and account policies are not stable public
contracts; synthetic tests do not prove support for a live account/model. Observe
GitHub's applicable account/usage policies; auxiliary searches may consume usage.

`pnpm run check:secrets` audits Git-candidate files for common provider-token formats,
Copilot session tokens, JWTs, private keys, credential-bearing URLs,
hard-coded credential-like literals and
sensitive filenames. `node scripts/check-secrets.mjs --staged` checks the actual
index. Only specifically reviewed synthetic literals in the known package test
trees are allowed; suspected values are never printed. This is defense in depth,
not a proof that arbitrary secrets are absent. Review source and each tarball.

Release tooling selects one public leaf, verifies its repository identity and
runs the full pnpm verification suite. Staged publication uses short-lived OIDC
and requires maintainer approval with 2FA; no npm token is stored in GitHub.
