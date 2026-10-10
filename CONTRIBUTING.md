# Contributing

Use Node.js 22.19+ and **pnpm 11.7.0**. From the root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
```

The root is private tooling. Runtime source/tests live in
[catalog](packages/catalog/README.md), [search](packages/search/README.md) and
[worktrees](packages/worktrees/README.md), each with its own manifest, bundle,
declarations, output and release version. Keep
[pnpm-lock.yaml](pnpm-lock.yaml) committed. Do not add npm lockfiles, run installs
from a leaf, or add a dependency on an unpublished/private workspace package.

## Runtime boundaries

- Never modify signed app files, active profiles or real credential files during
  build/test/install preparation. Synthetic tests must not make live account calls.
- Resolve DSH/pi-ai public peers from the adapter's installation. Do not use
  machine-specific application paths or import private OAuth modules.
- Preserve catalog's public schema/exports and original credential record key.
  Catalog discovery remains read-only and bounded; it must not enable model policy
  or persist refreshes.
- Treat model IDs as opaque. Catalog protocol mappings use advertised endpoints,
  positive limits and conservative feature metadata, not model-name allowlists.
- Search uses its own provider and native Responses parser, not a replacement
  inference tool adapter. Endpoint advertisement is not proof of native-search
  support; fail explicitly rather than inventing sources or switching vendors.
- Search may persist normal refreshes of existing OAuth grants through the same
  DSH lock. Preserve explicit-reference/stored-account/ambient precedence, clone
  grants and normalize undefined optional JSON values. Never create/delete records,
  replace API keys, or write credentials outside the serialized service.
- Check cancellation before queueing and entering a mutation and after refresh
  before handing a grant to storage. After callback handoff, a subsequent storage
  commit cannot be reliably cancelled or rolled back.
- Keep search's validated refresh transport under public Models locking: derive
  exchange authority only from the existing owner grant, refuse redirects, and
  validate returned Copilot origins before catalog dispatch or grant handoff.
  Do not invoke the SDK's unvalidated refresh route or patch host-global fetch.
- Bound HTTP/SSE bytes and parser structure, honor cancellation throughout, reject
  redirects/untrusted origins, and never expose raw auth/network errors or secrets.

## Checks and packaging

Run peer integration after changing dependency versions; widen compatibility
ranges only after verifying actual runtime identity, account routing and public
exports. Own source is strict-checked; upstream declaration bodies use
`skipLibCheck`.

Update the explicit publication module allowlists in
[check-pack.mjs](scripts/check-pack.mjs) when adding emitted source modules.
Generated package output, tarballs and cache directories are ignored and must not
be committed. Builds are explicit; install with dependency lifecycle scripts off.
A public package's tarball must work independently of the private root.

[check-secrets.mjs](scripts/check-secrets.mjs) scans live Git candidates;
`node scripts/check-secrets.mjs --staged` checks the actual index. Only specific
reviewed synthetic literals under known package test trees are exempt. Never
print suspected values or expand exemptions merely to silence a finding.

CI verifies all three packages and root release targeting. Maintainers release one
package using `<package-name>-v<version>` tags after updating that leaf's changelog
and manifest. Catalog 0.2.0 has already been published; do not republish it.
The workflow stages only the selected leaf and preserves explicit npm review/2FA
approval. See [release instructions](README.md#releases) and [security](SECURITY.md).
