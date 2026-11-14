# Contributing

Use **pnpm 11.7.0**. The DSH CLI/host requires Node.js **24.9.0+**; the
plugin library/helper minimum remains **22.19.0+**, which is not sufficient to
promise a supported DSH CLI environment. Use the host minimum when running DSH
integration or CLI commands. From the root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
```

On macOS, use a standard development Node installation for native-addon tests.
A signed Desktop-bundled Node may refuse separately signed npm addons with a
Team ID mismatch. Do not re-sign app files or disable library validation to work
around that test-environment limitation.

The root is private tooling. Runtime source/tests live in
[better-copilot](<packages/better-copilot/README.md>) and
[worktrees](packages/worktrees/README.md), each with its own manifest, bundle,
declarations, output and release version. `better-copilot` is one plugin for all
Copilot behaviour; keep its capabilities isolated (one failing registration
must not block the adapter) and keep the single config shape (`providers`,
`search`, `toolSchema`, `autoReview`). Keep
[pnpm-lock.yaml](pnpm-lock.yaml) committed. Do not add npm lockfiles, run installs
from a leaf, or add a dependency on an unpublished/private workspace package.

## Runtime boundaries

- Keep runtime baselines separate: Better Copilot `0.5.1` targets exact DSH/DSH
  peers `0.2.2-rc.3`, pi-ai peer `^1.3.0` (tested baseline `1.3.0`) and Zod
  `4.6.6`; the root development SDK and Worktrees remain on `0.2.2-rc.1`.
  Resolve Better Copilot checks against its leaf peers, not the root SDK. Do not
  add compatibility exemptions or widen host support based on root-only checks.
- Preserve existing configuration, cache domain/format version and credential
  keys. This migration requires no persisted account-cache conversion or reset.
  Use rc.3's native search-provider picker/directory, not a new custom UI or
  metadata feature. Retain the existing read-only subagent badge.
- Version `0.5.1` is local preparation, not a published or installed release. Do
  not describe synthetic checks as live GUI or account testing.
- Never modify signed app files, active profiles or real credential files during
  build/test/install preparation. Synthetic tests must not make live account calls.
- Resolve DSH/pi-ai public peers from the adapter's installation. Do not use
  machine-specific application paths or import private OAuth modules.
- Preserve the merged plugin's public schema/exports and the pi-ai adapter's own
  provider schema and credential record key. Discovery remains read-only and
  bounded; it must not enable model policy or persist refreshes.
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
exports. All maintained implementations, the browser client, tests and repository
tooling are strict-checked; upstream declaration bodies use `skipLibCheck`.
Tests run directly from TypeScript with `node --import tsx --test`. Local imports
use `.js` specifiers for ESM compatibility; `tsx` resolves their TypeScript source.
The browser client is compiled separately as a plain script into
[dist/client.js](<packages/worktrees/dist/client.js>) so published packages do not
need a TypeScript loader. Do not edit generated JavaScript.

Update the explicit publication module allowlists in
[check-pack.ts](<scripts/check-pack.ts>) when adding emitted source modules.
Generated package output, tarballs and cache directories are ignored and must not
be committed. Builds are explicit; install with dependency lifecycle scripts off.
A public package's tarball must work independently of the private root.

[check-secrets.ts](<scripts/check-secrets.ts>) scans live Git candidates;
`pnpm exec tsx scripts/check-secrets.ts --staged` checks the actual index. Only specific
reviewed synthetic literals under known package test trees are exempt. Never
print suspected values or expand exemptions merely to silence a finding.

CI verifies both packages and root release targeting. Maintainers release one
package using `<package-name>-v<version>` tags after updating that leaf's changelog
and manifest. Catalog 0.2.0 has already been published; do not republish it.
The workflow stages only the selected leaf and preserves explicit npm review/2FA
approval. See [release instructions](README.md#releases) and [security](SECURITY.md).
