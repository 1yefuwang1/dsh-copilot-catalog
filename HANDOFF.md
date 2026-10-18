# Azure cloud sync handoff

Last updated: 2026-10-19 (Asia/Shanghai)
Repository: `dsh-copilot-plugin`
Package: `@1yefuwang1/dsh-azure-sync` `0.1.0`
Branch: `dev` (commit before this handoff: `3e93858`)
Remote: `origin` = `https://github.com/1yefuwang1/dsh-copilot-catalog.git`

This document is for continuing the work on another machine. The approved plan is
[`docs/plan/azure-cloud-sync.md`](docs/plan/azure-cloud-sync.md); its ledger is authoritative for
task status.

## 1. Goal and fixed constraints

Store DSH conversation state in Azure so a thread can continue on another device, with a
per-thread opt-in toggle.

Fixed user constraints:

- **Azure only** for cloud infrastructure.
- **As cheap as possible.** No Postgres, Functions, App Service, or always-on compute.
- Blob Storage + Table Storage only.
- New threads default **off**; enabling is explicit per thread.
- Turning sync off keeps the cloud copy; a separate remove action tombstones it.
- Mixed OS (macOS/Windows/Linux), one writer at a time, explicit takeover.
- No automatic Git push or working-tree sync; Git information is read-only guidance.
- Do not add credentials to config; auth is connection string, Azure CLI, or managed identity.

Cost intent: Blob Hot LRS (~$0.0208/GB-month) + Table (~$0.045/GB-month + per-op). Design target
is under $1/month excluding egress; no Azure compute.

## 2. Status

| Task | Status | Notes |
|---|---|---|
| T1 | Approved | Config, auth, Blob/Table/lease adapters |
| T2 | Approved | Schema, canonical JSON/chains, committed index, cwd mapping, guards, local store |
| T3 | Approved | Upload, atomic batch/tip commit, lease/epoch ownership, admission, drain |
| T4 | Approved | Verified cold import, attachments, projection warm, early claims, recovery |
| T5 | **In progress / REVISE** | Core helpers only; all three reviewers require runtime integration and acceptance tests |
| T6 | Not started | Commands, RPC, settings, credentials |
| T7 | Not started | Client UI/browser build |
| T8 | Not started | Read-only Git metadata/guidance |
| T9 | Not started | Docs, Azurite/two-store/crash/real-Azure/cost evidence |

T4 approval is recorded by all three reviewers in the session. The real
`AgentLoop`/`WorkingDirectoryService` fixture was **explicitly waived by the user for T4 only**;
real JSONL import/create/append/flush/provenance is covered instead. The waiver does **not** apply
to T5's retained-live/Azurite acceptance requirements.

T5 is not approved. Do not claim T5 complete or start T6 until T5 passes the three-reviewer gate.

## 3. Quick start on a new machine

Requirements: Node `>=22.19.0`, pnpm `11.7.0`, Git.

```bash
git fetch origin
git switch dev
pnpm install --frozen-lockfile
```

Package verification:

```bash
pnpm --filter @1yefuwang1/dsh-azure-sync run verify
```

That runs `check:secrets`, typecheck, the unit suite, real local Azurite, and pack verification.
The azure package currently has **139 unit tests**; the last package verification passed with
**91 allowlisted files / 301,367 source bytes** before the plan was moved to `docs/plan/`.

Useful focused commands:

```bash
pnpm --filter @1yefuwang1/dsh-azure-sync run check
pnpm --filter @1yefuwang1/dsh-azure-sync run test
pnpm --filter @1yefuwang1/dsh-azure-sync run test:azurite
pnpm --filter @1yefuwang1/dsh-azure-sync run test:pack
```

Root `pnpm run verify` includes the unrelated `worktrees` suite; its
`Local different clean branch switches safely...` test has been flaky in this environment. Prefer
the azure package verification unless you are changing root tooling.

## 4. Repository layout

```
packages/azure-sync/
  src/
    index.ts                 plugin apply/boot/lifecycle wiring
    config.ts                schemastery config
    auth.ts                  connection string / CLI / managed identity / auto
    schema.ts                cloud + local records, Int64 codec, keys
    azure/
      blob.ts                private container, conditional put, bounded read
      table.ts               CRUD, ETags, transactions
      lease.ts               60 s Blob lease adapter
      errors.ts              AzureSyncError codes
    local/store.ts           local v4 storage domain tables
    sync/
      canonical.ts           deterministic JSON, JSONL payload/hash
      chain.ts               header/genesis/raw-32 chain
      committed-index.ts     linked committed tip selection
      effective-cwd.ts       POSIX/Windows/UNC mapping, provenance
      import-state.ts        write-ahead transition rules
      guards.ts              no-cwd/schedule/preset guards
      uploader.ts            crash-safe upload, ownership, disable fencing
      cloud-repository.ts    manifest/batch rows, atomic commit
      lease-manager.ts       epoch acquisition/renewal/proof/release
      batcher.ts             batch planning
      blob-metadata.ts       lowercase metadata
      session-source.ts       real persistence read/flush
      scheduler.ts           debounce/pending
      service.ts             enable/sync/disable/status/remove/resurrect
      lifecycle.ts           host event hooks
      admission.ts           pre-step reject/requeue with receipt
      drain.ts               quiet-period/suffix drain
      drain-coordinator.ts   drain state
      importer.ts            verified import, claims, guard, phases
      remote-session.ts      verified remote reader
      attachments.ts         Blob attachment upload/materialization
      projection-warmer.ts   dual-signature projection warm
      workspace.ts           workspace attach
      recovery.ts            parent-first repair
      import-service.ts      import façade
      reconciler.ts          T5 classification (needs work)
      live-guard.ts          T5 live/cold decision (needs wiring)
      tombstone.ts           T5 tombstone/resurrect primitives
      cleanup.ts             T5 generation cleanup planning
      tombstone-manager.ts   T5 removal/resurrection (needs work)
      conflict.ts            T5 action enum/dispatcher (needs workflow)
      poller.ts              T5 poller (needs cancellation)
  test/                      node:test + tsx, real JSONL/Azurite helpers
  dist/                      ignored build output
scripts/
  check-pack.ts              package allowlist
  test/workspaces.test.ts    five-package policy/allowlist tests
  release.ts                 publish allowlist
docs/plan/azure-cloud-sync.md approved v4 plan (ledger at the end)
```

The package is one of five workspace packages; root `scripts/workspaces.ts`,
`scripts/check-pack.ts`, `scripts/release.ts`, and `scripts/test/workspaces.test.ts` must be kept in
sync when adding package modules or files.

## 5. Architecture invariants to preserve

1. **Canonical data**: payloads are `canonicalJson(event) + "\n"` JSONL; hashes are SHA-256.
   Chains are per-event cumulative raw 32-byte hashes. Genesis is the empty chain; never a null.
2. **Commit order**: write immutable candidate Blob first, then atomically create the committed
   batch row and CAS the tip (`If-Match`) in one Table transaction. A crash leaves an uncommitted
   Blob, which is ignored. Unchosen candidates/siblings must never be imported.
3. **Linked index**: follow `prevBatchRowKey` from the tip within the generation back to genesis.
   Row keys are generation-qualified: `batch:<b64 sid>:gen-<n>:<12-digit start>`.
4. **Ownership**: one writer. 60 s Blob lease, 30 s renewal, manifest `writerEpoch`. A step needs a
   fresh server proof. Disable must CAS-fence the shared manifest even without the lease.
   No release at turn-stopping.
5. **Ownership tokens**: user intent (enable/disable/close) is separate from IO operation tokens.
   Routine background sync must not invalidate a foreground proof; disable/close must.
6. **Import**: planned → creating → appending → attachments → warming → complete/degraded/failed.
   Hold the write handle through flush. Re-read local events and verify **forward** provenance
   after each batch. Never reverse-map imported history; preserve exact canonical imported prefix.
7. **Mixed OS**: remote paths are normalized as strings first; local result uses realpath inside the
   pinned root. Case-insensitive remainder on Windows, escape/symlink resistance, forward-only
   provenance.
8. **Attachments**: only through `ctx.attachments`; images use `imageHostPath` + probe + no-clobber
   hard link; files use `saveFileStream`/`saveFile` and `(id,name)` aliases; missing objects degrade.
9. **Live vs cold**: a live Agent owns its write handle. For remote-ahead live, mark
   `remote-ahead-live`, block/restart; never `open('write')`. Cold may append/import. GUI close does
   not dispose the host Agent.
10. **Deletion**: tombstone state, keep rows/attachments until generation-scoped cleanup; root
    deletion fences children; resurrect is explicit; offline reconnect never resurrects.

## 6. T5 — exactly what remains

All three reviewers returned REVISE on the T5 core. The modules are useful primitives, not an
approved task.

### Blocker 1 — reconciliation is count-only

`src/sync/reconciler.ts` compares only `eventCount`. It never returns `diverged`, ignores
disabled/tombstoned state, and cannot prove local/remote share a prefix.

Required:

- Verify header/cut/generation and canonical chain prefixes, not just counts.
- `deleted` → local `removed-remotely`, `enabled: false`, stop; never resurrect automatically.
- generation mismatch → `generation-changed`, stop.
- equal counts + different chain/header → `diverged` (`status: conflict`), stop.
- remote-ahead: verify local is an exact prefix; if not → diverged.
  - live → `remote-ahead-live`, no writer, restart required.
  - cold → open write, guard the suffix, append localized suffix, flush, forward provenance,
    attachments, projection warm, mark synced.
- local-ahead: verify remote is an exact prefix; if not → diverged; else upload the suffix,
  including adopting the longest verified candidate prefix at the next start if applicable.

### Blocker 2 — tombstone removal is incomplete/non-resumable

`src/sync/tombstone-manager.ts` currently returns early for an existing tombstone, swallows delete
failures, deletes rows before blobs, and only sweeps the named session.

Required:

- Root-first durable deletion; tombstone root first, then sweep descendants
  (`rootSessionId`/`rootGeneration`), and tombstone each descendant; refuse/flag failure.
- Resumable/paginated generation-prefix cleanup even when already tombstoned (crash after manifest
  update must be repairable).
- Blob-before-row deletion so a failed blob delete does not lose the row reference; checked
  failures/pending status, not silently swallowed.
- Generation/ETag-conditioned deletes; validate `blobName` belongs to the target session/generation.
- Include orphan candidate blobs and delete/break `v1/leases/<sid>`; never touch attachments.
- Set `deletedAt`/`deletedBy`, clear lease mirror fields, update local record.
- Add root-delete vs new-child and delayed old-generation cleanup tests.

### Blocker 3 — resurrection semantics

Current manager resets disabled history and uses `headSeq: 0` for empty history.

Required:

- Empty manifest convention is `headSeq: -1`.
- Explicit resurrect only for `deleted` → new generation; re-enable `disabled` without resetting
  retained history.
- Advance `rootGeneration` for a resurrected root; new children must satisfy the root fence.
- Reset generation-scoped local sync checkpoints; reject child actions that need a root.
- Tests: disabled re-enable, root resurrection + new child upload, generation transitions, child
  action rejection.

### Blocker 4 — runtime wiring/conflict workflow

`live-guard`, `reconciler`, `poller`, and `tombstone-manager` are not used by the runtime.
`conflict.ts` only dispatches callbacks.

Required:

- Wire into `SyncService`/`index.ts`/startup and `close()`.
- Cold verified-prefix catch-up appends/imports; live remote-ahead blocks without a writer.
- Divergence persists `status: conflict`, preserves local copy, and supports:
  - `keep-local`: detach (`enabled:false, detached:true, status:detached`), release held lease,
    leave remote untouched.
  - `export-local`: write header + inherited cut + events as JSONL mode `0o600`, record
    `conflictBackupPath` on the local record.
  - `remove-cloud`: tombstone then detach locally.
- Commands/UI can stay T6/T7, but runtime behavior cannot be deferred.

### Blocker 5 — poller shutdown

The poller neither cancels nor invalidates in-flight refresh and silently drops overlapping manual
ticks. Add bounded lifetime/cancellation, a coalesced/trailing manual refresh, stable
error/backoff/auth-stop behavior, and tests with never-settling/late-success refreshes.

### Blocker 6 — required T5 acceptance tests

- Two-store convergence: A upload → B cold import → B append/upload → A catches up cold (including
  projection warm) → both synced.
- Divergence → `conflict` and each conflict action; verify export is `0o600` and
  `conflictBackupPath`.
- Retained-live: live Agent present, B advances remote → A marked `remote-ahead-live`, no
  `open('write')`, pre-step rejects/requeues; after simulated host restart, cold catch-up works.
- Root/child tombstone: root delete tombstones descendants; child commit under tombstoned/old-gen
  root rejected; remove → crash before cleanup → retry/resurrect; delayed old-gen cleanup cannot
  delete new-gen rows; old-gen `startSeq=0` does not block new-gen upload.
- Offline reconnect to tombstone/generation change stops without auto-resurrect.
- Takeover/committed prefix survives epoch changes; unchosen sibling candidate blobs ignored.
- Real Azurite root/child delete and ETag/transaction races.

Do not use the T4 host-fixture waiver for these T5 tests.

## 7. Recommended implementation order

1. Fix pure reconciler/tombstone/resurrection/poller semantics with unit tests.
2. Add repository listing/conditional delete APIs and root/child tombstone sweeping.
3. Implement conflict export/detach/remove and wire `SyncService`.
4. Wire reconciler + live guard + poller into startup/lifecycle; stop in `close`.
5. Add two-store and retained-live tests; then Azurite races.
6. Run `pnpm --filter @1yefuwang1/dsh-azure-sync run verify`.
7. Send T5 to three independent reviewers; require three approvals before T6.

Reviewer standard used so far: concrete file:line blockers, adversarial probes, no overclaiming
evidence. Model routes used: `github-copilot` with `gpt-6.1-sol`, `gemini-4-argon`, `grok-4.7`.

## 8. Known gotchas

- `packages/azure-sync/package.json` `test` script lists test files manually. Add every new test.
- `scripts/check-pack.ts` and `scripts/test/workspaces.test.ts` contain the package allowlist and
  byte cap. New `src` modules must be listed or pack verification fails.
- The plan used to live under `.review/`, which is gitignored and rejected by `check:secrets` when
  committed. It now lives at `docs/plan/azure-cloud-sync.md`; do not move it back.
- Do not add real credentials or credential-like literals to tests. `check:secrets` scans tracked
  candidates; use synthetic values only.
- Azurite is a devDependency and `test:azurite` spawns `node_modules/.bin/azurite` on free ports.
- Root `pnpm run verify` includes unrelated packages; the worktrees Git-switch test can flake.
- No live Azure acceptance, RBAC/private endpoint test, real Windows GUI test, or cost export has
  been run yet (T9).
- `T4` host AgentLoop/WorkingDirectoryService test is a documented residual risk/waiver.
- No host commands (`/cloud`), RPC, settings UI, or browser client exists yet. The plugin cannot be
  used end-to-end from the GUI.

## 9. Immediate next action

Continue at **T5 blocker 1**: replace count-only reconciliation with verified
header/generation/chain-prefix classification and tests. Then proceed in the order above. Do not
start T6 until T5 has three approvals.
