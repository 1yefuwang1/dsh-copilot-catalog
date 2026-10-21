# Azure Sync v1 — acceptance matrix and manual checklist

**Historical v1 checkpoint.** The subsequent Local/New worktree implementation and portable Git-context
extension are tracked in the [destination acceptance ledger](<cloud-import-destination.md>). The v1
counts, package sizes and approvals below do not establish acceptance of that later changeset.

**T1–T9 DONE — BOTH FINAL REVIEWS APPROVED / PARENT VERIFIED / AUTOMATED CHECKS GREEN.** Updated 2026-10-19 UTC.
This records evidence for working-tree `@1yefuwang1/dsh-azure-sync@0.1.0`, not a
published release, installed GUI or live Azure deployment. Final implementation approvals and parent verification are recorded below; manual evidence is not inferred.

The [approved v4 plan](<../plan/2026-10-20-200116-HKT-azure-cloud-sync.md>) defines scope. Its current task
ledger/review record and the user-revised **GPT + Grok** gate supersede historical
three-reviewer and stale implementation-status paragraphs. T1–T9 are implemented and approved by
BOTH required reviewers; parent independently verified the final pipeline results and audit/diff status.
This closes the code objective under checked/deferred DoD, not deployment/publication or any of the
16 unchecked manual items. Persisted goal closure remains parent-owned.

## Evidence register and reproducible commands

**Prior approved checkpoint, not the final T9 result:** the corrected T8 run passed
**902 unit/acceptance + 9 real-Azurite/runtime + 15 root tooling tests**, zero
skips/failures, types/audit/whitespace, and an exact pack of **108 files / 680,104
source bytes**, below the unchanged 720,000-byte Azure-only cap. Evidence:
[temporary T8 log](</tmp/azure-sync-t8-scp-frozen.yIajPp.log>); review provenance is
in the [plan review record](<../plan/2026-10-20-200116-HKT-azure-cloud-sync.md#10-review-record>).
Temporary logs may disappear and are not shipped artifacts; the test sources and
commands below are the reproducible evidence. Counts above must not be relabelled T9.

**Final T9 checkpoint — BOTH approved and parent verified:** [whole-repository verification](</tmp/azure-sync-t9-root-final.5FdqA6.log>)
and [Azure package verification](</tmp/azure-sync-t9-leaf-final.0aTpdS.log>) both exited **0**.
Azure: **930 unit/acceptance + 10 integration** (9 Azurite/runtime cases plus measured HTTP cost) +
**1 extracted-tarball import/type smoke**. Root tooling: **15**. All root leaf units
(catalog/search/tool-schema/worktrees/Azure: 76/81/14/602/930) and integrations (20/4/6/61/10)
passed with **zero failures/skips**; all Host/browser/test/public-consumer/tooling types and the
297-file credential audit passed. Exact Azure pack: **108 files / 714,510 bytes**, below the unchanged
720,000-byte cap; no other leaf bounds widened. Root totals are 1,819 executed tests, including
Azure unit/integration tests also rerun by the leaf verification; do not add repeated cases as unique.
All-source scripts/locale, two-store, retained-live/restart/crash and policy regressions remain green.
The [cost report](<azure-sync-cost.md>) records complete HTTP vectors and a conditional model, not a bill.
New exact cold-duration/promotion, common image/file transfer cap and extracted-tarball deltas are
verified in this checkpoint. **Both final implementation reviews APPROVE; parent independent verification is complete.**
GPT (`github-copilot/gpt-6.1-sol`, xhigh), reviewer `1f1a45fc-edd1-4d74-a297-4297a510690f`, independently
passed393 tests,15 tooling,6 fresh actual-state/protection probes, all types/audit/pack, official pricing/math
refetch and comparison of101 generated artifacts; final repository docs reread approved.
Grok (`github-copilot/grok-4.7`, xhigh), reviewer `a33407d9-1095-4587-baa1-a8533233d2f7`, approved source,
exact cold/image/cost/tarball boundaries and the corrected final legend/status/manual wording.
Parent read both full logs/final docs, checked audit297/diff0 and preserved working status. No source,
test or packaged-file change occurred after the108-file/714,510-byte freeze; no original checkout,
commit/reset/checkout/push/handoff or persisted-goal mutation was performed by this subagent.
No installed GUI/live Azure/Windows/billing result is inferred from these automated logs.

Run from the repository root with Node `>=22.19.0` and pnpm `11.7.0`; these are
**verification examples**, not provisioning or installation into a running profile:

```sh
# U: Host/test/browser types, portable source policy and unit/acceptance tests.
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run check
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run test
# A: real local Azurite + actual plugin/Host runtime and measured HTTP cost cases.
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run test:azurite
# P: exact publication allowlist/build + extracted-tarball import/type smoke.
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run test:pack
# C: measured SDK HTTP-attempt profile only; never a real Azure bill.
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run measure:cost
# R: root secret/tooling checks and whitespace; do not widen audit exemptions.
pnpm --config.ignore-scripts=true run check:secrets
pnpm --config.ignore-scripts=true run test:tooling
git diff --check
# Final gates: package and full repository, including all other leaves.
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run verify
pnpm --config.ignore-scripts=true run verify
```

Command definitions live in the [leaf manifest](<../../packages/azure-sync/package.json>)
and [root manifest](<../../package.json>). Tests start ephemeral loopback emulators;
they do not create paid resources, install plugins or send live model prompts. Root
verification covers unrelated packages too: any failure must be investigated and
recorded, not silently waived or represented by an Azure-only pass.

### What “checked” means here

- **Checked / T8**: originating T8 evidence and linked test sources. Those automated
  rows were re-executed by the final frozen T9 root/leaf logs; the label is
  provenance, not an untested delta.
- **Checked / focused T9**: a named T9 result. Where the row also cites the final
  C+A or U+A pipelines, it is covered by those recorded runs, not a separate unrun gate.
- **Pending / T9** was the historical review/parent label, not an unrun automated
  pipeline. Both final approvals and parent verification are now recorded; no T9 gate remains pending.
- **Deferred / manual**: unavailable real service/device/deployed-UI evidence; an
  explicit checklist remains. It is not a pass and is not silently dropped.
- **Boundary / v1**: deliberate supported scope or disclosed limitation, not a claim
  that a missing capability is implemented.

The two-store suite uses real independent durable JSONL/domain roots, public
AgentLoop/WorkingDirectoryService and projection registry folds, with conditional
cloud/lease adapters and an explicit projection-cache test port. Separate Azurite
cases exercise real Azure SDK HTTP/ETag/transactions and the actual plugin entry,
CommandRuntime, CredentialProvider and HostConnectionService. This is not live
Azure auth, RBAC, network, latency or billing evidence.

The browser suite executes the actual public Cordis, renderer, LocaleRuntime,
conversation, blocks and stores, plus bundled React/JSDOM controls. Session,
config-form, transport and unused CSS/presentation ports are explicit fixtures.
Blank fixtures assert pinned stock hideChrome/hero call sites; they do **not** mount
the full stock composer, prove its installed appearance, or establish manual GUI use.

## Plan success criteria (§4)

Every numbered success criterion is mapped below; detailed task acceptance follows.

| Plan criterion | Status and command/evidence | Boundary / remaining acceptance |
|---|---|---|
| 1. Explicit per-thread On/Off, including blank/existing, full history, retain copy | Checked / T8, U+A: [runtime controls](<../../packages/azure-sync/test/control-runtime.test.ts>), [blank/client SDK](<../../packages/azure-sync/test/client-sdk.test.ts>), [uploader](<../../packages/azure-sync/test/uploader.test.ts>) | Deployed blank/nonblank GUI is Deferred / manual. Pending materialization is not synced; default never auto-enables threads. |
| 2. Second-device native history/title/activity/attachments, mapped continuation; stale live restart | Checked / T8, U+A: [two-store retained-live/restart](<../../packages/azure-sync/test/two-store.test.ts>), [JSONL import](<../../packages/azure-sync/test/import-jsonl.test.ts>), [attachments](<../../packages/azure-sync/test/attachments.test.ts>) | Actual second machine/native list/UI and unsupported public cache behavior are Deferred / manual or explicitly degraded, not fake warming. |
| 3. Mixed-OS executable cwd and immutable canonical prefix | Checked / T8, U: [cwd/provenance](<../../packages/azure-sync/test/effective-cwd.test.ts>), [real remapped repair](<../../packages/azure-sync/test/repair-flow.test.ts>), [new-generation re-upload](<../../packages/azure-sync/test/resurrection.test.ts>) | Windows-source→POSIX and UNC/drive fixtures are not a real Windows run; case-insensitive real-volume branch requires that filesystem. |
| 4. Read-only Git/worktree facts and safe guidance | Checked / T8, U: [actual Git/index/quoting](<../../packages/azure-sync/test/git.test.ts>) | PowerShell execution is Deferred / manual; no code synchronization or automatic Git commands. |
| 5. Single writer, fresh step proof, epoch fence, takeover, preserved suffixes | Checked / T8, U+A: [admission](<../../packages/azure-sync/test/admission.test.ts>), [leases](<../../packages/azure-sync/test/lease.test.ts>), [takeover](<../../packages/azure-sync/test/takeover-control.test.ts>), [two-store](<../../packages/azure-sync/test/two-store.test.ts>) | No cached TTL execution grant. Forced takeover cannot cancel old external tool side effects; exact cold/native duration and promotion races are Checked / focused T9; final reviewers approved and parent verified. |
| 6. Crash-safe canonical bytes/genesis/linked committed watermark/prefix adoption | Checked / T8, U+A: [canonical](<../../packages/azure-sync/test/canonical.test.ts>), [chain](<../../packages/azure-sync/test/chain.test.ts>), [index](<../../packages/azure-sync/test/committed-index.test.ts>), [uploader](<../../packages/azure-sync/test/uploader.test.ts>), [Azurite](<../../packages/azure-sync/test/azurite.test.ts>) | No Blob/Table cross-service transaction; uncommitted candidates ignored and visible orphans swept on retry; late old PUTs may leave orphans. |
| 7. No partial continuation, write-ahead/early claims/provenance/readiness/startup repair | Checked / T8, U: [early claims](<../../packages/azure-sync/test/early-claims.test.ts>), [importer](<../../packages/azure-sync/test/importer.test.ts>), [real repair](<../../packages/azure-sync/test/repair-flow.test.ts>), [startup](<../../packages/azure-sync/test/startup.test.ts>) | Off/detach alone cannot make partial history safe. Degraded *verified full logs* require explicit acknowledgement, even projection-only/zero-attachment cases. |
| 8. Root/descendant deletion final until explicit new-generation upload | Checked / T8, U+A: [tombstone manager](<../../packages/azure-sync/test/tombstone-manager.test.ts>), [resurrection](<../../packages/azure-sync/test/resurrection.test.ts>), [Azurite races](<../../packages/azure-sync/test/azurite.test.ts>) | Shared attachments are retained; removing a thread is not an account purge or a guarantee against separately retained versions. |
| 9. Blob Hot LRS + Standard Table only; cheap named workload | Checked / focused T9, C+A: [HTTP cost evidence](<azure-sync-cost.md>), [cost test](<../../packages/azure-sync/test/cost-profile.test.ts>) | Original ~30k-op shorthand is **not** the measured implementation. Named 580,978-base-request workload models $0.2788641636; actual bill/export is Deferred / manual. |
| 10. Private/TLS/SSE, credential store/ambient, no secret echo/global-config transfer | Checked / T8, U+A+R: [auth](<../../packages/azure-sync/test/auth.test.ts>), [settings](<../../packages/azure-sync/test/settings.test.ts>), [RPC](<../../packages/azure-sync/test/rpc.test.ts>), [actual runtime](<../../packages/azure-sync/test/control-runtime.test.ts>) | Connection-string input is a write-only authenticated RPC body, never returned. Live Azure TLS/SSE/RBAC/rotation/private endpoints remain Deferred / manual. Authorized writers/log contents remain trusted disclosures. |
| 11. Testable and reversible; full verify and explicit manual gaps | Checked / T9 automated U+A+P+R and both complete-root/package verification; both final reviews approved and parent completion verification recorded | [Rollback](#rollback-and-uninstall) preserves local data. The recorded frozen root/leaf pipelines passed; both independent final approvals and parent verification are complete. All 16 manual rows below remain explicitly deferred and are not automated passes. |

## Task acceptance matrix (§7) and architectural invariants (§6)

Each row lists its rerun command label and source evidence. “Checked / T8” identifies originating
provenance and its stated evidence boundary; these automated rows were REVALIDATED by the final
frozen T9 root/leaf logs above. Both independent approvals/parent verification are now complete; explicitly deferred
manual work is still unrun. Originating T8 labels are not claims that T9 edits went untested.

### T1–T2 — package, configuration, auth and data model

| Criterion | Status / rerun / evidence | Boundary or remediation |
|---|---|---|
| Fifth independent leaf; required and optional inject services; exact exports, no lifecycle install hooks/core changes | Checked / T8, U+P+R: [entry](<../../packages/azure-sync/src/index.ts>), [manifest](<../../packages/azure-sync/package.json>), [workspace policy tests](<../../scripts/test/workspaces.test.ts>); Checked / T9 extracted-tarball root/protocol/browser import and public consumer type smoke with existing pinned public dependencies | Required: sessions/sessionPersistence/storageDomain. Optional: attachments/sessionQuery/workspaceRegistry/commands/credentials/connection/agentPresets/llm/sessionProjectionCache. Missing optional services must surface limits; no clean registry-install claim. |
| Strict auth modes/account/endpoints/container/Table/caps/poll and side-effect-free lazy setup | Checked / T8, U: [config](<../../packages/azure-sync/test/config.test.ts>), [auth](<../../packages/azure-sync/test/auth.test.ts>), [Azure wrappers](<../../packages/azure-sync/test/azure.test.ts>) | Production allowInsecure stays false. Emulators do not prove live token acquisition or role propagation. |
| Connection-string/CLI/managed identity/auto providers, fixed credential reference and redacted failures | Checked / T8, U+A: [auth](<../../packages/azure-sync/test/auth.test.ts>), [settings](<../../packages/azure-sync/test/settings.test.ts>), [runtime](<../../packages/azure-sync/test/control-runtime.test.ts>) | CLI/MI provider wiring checked; actual identities/service access Deferred / manual. Secrets never belong in commands, prompts or YAML. |
| Local v4 domain; strict cloud/local schemas, Int64 epochs/timestamps, bounded strings and identities | Checked / T8, U: [schema](<../../packages/azure-sync/test/schema.test.ts>), [local store](<../../packages/azure-sync/test/local-store.test.ts>) | Unknown schema/format refuses; not an automatic migration/adoption policy. |
| Canonical JSON preserves fields/arrays, strips undefined object fields, rejects non-JSON; exact UTF-8 canonical event plus newline payload/hash | Checked / T8, U: [canonical fixtures](<../../packages/azure-sync/test/canonical.test.ts>) | Canonical event representation, not raw byte-for-byte replication of arbitrary local JSONL serialization. |
| Header + inherited cut + generation-bound genesis; empty/first batch binding; raw 32-byte chain concatenation | Checked / T8, U: [chain](<../../packages/azure-sync/test/chain.test.ts>), [index](<../../packages/azure-sync/test/committed-index.test.ts>) | Hex is storage/display only. Empty eventCount=0/headSeq=-1; no null genesis. Seeded/full raw-prefix proofs remain part of import/publication. |
| Generation-qualified batch keys/prev/tip; exact linked tiling, divergent/invalid old-epoch siblings ignored; missing link corrupt | Checked / T8, U+A: [index](<../../packages/azure-sync/test/committed-index.test.ts>), [remote reader](<../../packages/azure-sync/test/remote-session.test.ts>), [two-store](<../../packages/azure-sync/test/two-store.test.ts>) | Committed history is independent of current writerEpoch. An arbitrary candidate never substitutes for a missing committed row. |
| Normalized remote strings first; drive/UNC/boundary/longest-prefix ambiguity; only local result realpathed; canonical case inside pinned root | Checked / T8, U: [cwd](<../../packages/azure-sync/test/effective-cwd.test.ts>); actual case-insensitive filesystem coverage Deferred / manual where unavailable | Missing directory → create it or add an exact explicit mapping. Reject escapes, retargeted roots, ambiguity and local decoys; never guess a fallback. |
| Historical cwd forward-localized; new local cwd forward-canonicalized; current local range re-read for provenance; mapping revision freeze/reconfirmation | Checked / T8, U: [cwd](<../../packages/azure-sync/test/effective-cwd.test.ts>), [importer](<../../packages/azure-sync/test/importer.test.ts>), [repair](<../../packages/azure-sync/test/repair-flow.test.ts>), [controller](<../../packages/azure-sync/test/controller.test.ts>) | Immutable imported canonical prefix is never reverse-rewritten. Reconfirm only if the entire retained localized prefix still proves the original binding. |
| Lowercase Blob metadata, Unicode nameb64, strict untrusted row/blob/path validation | Checked / T8, U+A: [Azure wrappers](<../../packages/azure-sync/test/azure.test.ts>), [attachments](<../../packages/azure-sync/test/attachments.test.ts>), [cleanup](<../../packages/azure-sync/test/cleanup.test.ts>) | Hashes detect inconsistency/corruption, not a malicious authorized writer. |
| No-cwd/schedule/preset/model guards | Checked / T8, U: [guards](<../../packages/azure-sync/test/guards.test.ts>), [uploader](<../../packages/azure-sync/test/uploader.test.ts>), [importer](<../../packages/azure-sync/test/importer.test.ts>) | No-cwd: create a supported cwd-backed thread. Any schedule/change: stop; use a new supported thread, never strip history to bypass. Install required preset locally; model availability is separately configured/warned. Definitions/schedules do not transfer. |

### T3 — upload, execution admission and lease lifecycle

| Criterion | Status / rerun / evidence | Boundary or remediation |
|---|---|---|
| Service-wide persistence flush/read; full existing history; blank/unmaterialized intent stays pending; native command events retained | Checked / T8, U+A: [session source](<../../packages/azure-sync/test/session-source.test.ts>), [uploader](<../../packages/azure-sync/test/uploader.test.ts>), [runtime](<../../packages/azure-sync/test/control-runtime.test.ts>) | No synced claim until artifact materializes and the selected tip commits. No model dispatched by a control action. |
| Immutable start/epoch/hash candidate first; insert-if-absent row + If-Match tip (+ root touch) atomic EGT; bounded ETag retries; longest valid prefix adoption | Checked / T8, U+A: [uploader/crash fixtures](<../../packages/azure-sync/test/uploader.test.ts>), [repository](<../../packages/azure-sync/test/cloud-repository.test.ts>), [Azurite](<../../packages/azure-sync/test/azurite.test.ts>) | Crashes before Table commit leave ignored candidates; after commit, retry reconciles without duplicates/epoch-invalidating old history. |
| Every write acquisition advances epoch; fresh server proof **each model step**, no TTL admission; offline fail-closed, explicit detach | Checked / T8, U+A: [lease](<../../packages/azure-sync/test/lease.test.ts>), [admission](<../../packages/azure-sync/test/admission.test.ts>), [startup](<../../packages/azure-sync/test/startup.test.ts>), [takeover](<../../packages/azure-sync/test/takeover-control.test.ts>) | UI mirrors/list cache/Git facts cannot authorize. Ordinary untracked sessions bypass Azure. Actual service latency target is Deferred / manual. |
| Native active 60 s lease / 30 s renewal; non-live/cold 30 s lease and race-safe promotion to native ownership | Checked / T9 automated, U+A: [lease](<../../packages/azure-sync/test/lease.test.ts>), [uploader](<../../packages/azure-sync/test/uploader.test.ts>), [runtime](<../../packages/azure-sync/test/control-runtime.test.ts>) | Actual SDK acquisition headers assert cold On/sync/takeover/inspection and child publication request 30 s; native proof requests 60 s. Known cold handles never auto-renew; native appearance promotes through a fresh 60 s epoch before admission, and older cold hints cannot release a foreground 60 s handle. Failure/cancel/foreign-promotion-loss cleanup is checked; normal drain/close gates remain. |
| Drain only after idle, empty next-turn/next-step, 2 s quiet, flush and final suffix; new admission/activity invalidates drain; no turn-stopping release | Checked / T8, U: [drain](<../../packages/azure-sync/test/drain.test.ts>), [coordinator](<../../packages/azure-sync/test/drain-coordinator.test.ts>), [uploader handoff races](<../../packages/azure-sync/test/uploader.test.ts>), [lifecycle](<../../packages/azure-sync/test/lifecycle.test.ts>) | Upload failure keeps the lease/marks drain-failed until retry/expiry; forced break may leave a preserved conflict, not synthetic completion. |
| Delayed final-upload A→B handoff; forced break fences A's next step/commit; complete turn, no synthetic closers | Checked / T8, U: [uploader](<../../packages/azure-sync/test/uploader.test.ts>), [lease](<../../packages/azure-sync/test/lease.test.ts>), [admission](<../../packages/azure-sync/test/admission.test.ts>) | Epoch fences publication, not external tools already running; user must ensure old writer idle or accept the warning. Real two-machine timing Deferred / manual. |
| Rejection prepends last-to-first, fallback/receipt, exactly-once no-advance recovery; B-advanced bookkeeping conflicts/preserves suffixes | Checked / T8, U: [admission](<../../packages/azure-sync/test/admission.test.ts>), [actual AgentLoop two-store](<../../packages/azure-sync/test/two-store.test.ts>) | Exactly-once pending-inbox preservation is not promised across clean native Agent disposal: native cancellation is durably recorded; input history/receipt and conflict remain. No transparent merge. |

### T4–T5 — import, attachments, convergence, deletion and recovery

| Criterion | Status / rerun / evidence | Boundary or remediation |
|---|---|---|
| Preflight whole target/header/cut/genesis/chain/epoch/count and every cwd/preset before artifact; write-ahead phases; handle held through append/flush/readback | Checked / T8, U: [importer](<../../packages/azure-sync/test/importer.test.ts>), [real JSONL](<../../packages/azure-sync/test/import-jsonl.test.ts>), [repair](<../../packages/azure-sync/test/repair-flow.test.ts>) | No partial/native model resume. T4's historical user waiver was not reused for T5: later real AgentLoop/WorkingDirectory fixtures exist. |
| Early incomplete-import writer claims before resume; synchronous session/created veto; owned-race banner; startup parent-first/subagent ordering | Checked / T8, U: [early claims](<../../packages/azure-sync/test/early-claims.test.ts>), [recovery](<../../packages/azure-sync/test/recovery.test.ts>), [importer](<../../packages/azure-sync/test/importer.test.ts>), [startup](<../../packages/azure-sync/test/startup.test.ts>) | Never append closers to make a failed import appear native-complete. Archive/surface failed import; no local deletion. |
| Crash after create/append/flush/attachments/warm; current-range forward provenance on repair; no duplicate suffix | Checked / T8, U: [importer crash cases](<../../packages/azure-sync/test/importer.test.ts>), [repair](<../../packages/azure-sync/test/repair-flow.test.ts>), [two-store interrupted catch-up](<../../packages/azure-sync/test/two-store.test.ts>) | A changed header/cut/generation or unproven local prefix stops repair; no unrelated-generation adoption. |
| Interrupted planned initial import without artifact can create only after original full anchor proof; no native/complete/catch-up/unanchored recreation | Checked / T8, U: [real repair negative/positive cases](<../../packages/azure-sync/test/repair-flow.test.ts>) | Verified target is anchored before preflight. Missing arbitrary file is not permission to recreate user history. |
| Known disabled+detached initial partial read-only retained repair preserves Off/CID; On refuses incomplete until full repair | Checked / T8, U: [repair](<../../packages/azure-sync/test/repair-flow.test.ts>), [uploader](<../../packages/azure-sync/test/uploader.test.ts>), [client model](<../../packages/azure-sync/test/client-model.test.ts>) | No activation/upload/lease; newer Off cancels stale repair. A later genuine On is explicit. |
| Attachments via ctx.attachments: dedupe, files/aliases, Unicode, valid image untouched, imageHostPath capability + no-clobber/probe/modes, missing/degraded | Checked / T8, U: [attachments](<../../packages/azure-sync/test/attachments.test.ts>), [importer](<../../packages/azure-sync/test/importer.test.ts>); common actual image/file transfer cap Checked / T9 unit and real-Uploader boundary regressions (below/exact/over; no authorization/metadata/PUT or synced tip on over-limit) | No saveImage re-normalization or arbitrary raw path write. Fixture store is not a live OS attachment-store acceptance; Windows ACLs Deferred / manual. |
| Dual coldSnapshot signatures, settle/cachedSnapshot/list readiness; actual projection folds/workspace realpath; unavailable cache honest degraded | Checked / T8, U: [projection](<../../packages/azure-sync/test/projection-warmer.test.ts>), [workspace](<../../packages/azure-sync/test/workspace.test.ts>), [two-store](<../../packages/azure-sync/test/two-store.test.ts>) | Pinned Host public persistent-cache service is unsupported/unavailable in some compositions; test cache port does not establish deployed sidebar warming. Explicit limitation acknowledgement remains required. |
| Degraded verified full log requires acknowledgement even projection-only/zero attachments and after Off; pending partial cannot ack into safety | Checked / T8, U: [real repair](<../../packages/azure-sync/test/repair-flow.test.ts>), [model](<../../packages/azure-sync/test/client-model.test.ts>), [UI](<../../packages/azure-sync/test/client-ui.test.ts>) | Off alone does not make an incomplete artifact safe. Ack preserves Off; it does not activate cloud or silently acknowledge missing data. |
| Canonical-prefix same/local-ahead/remote-ahead/diverged; equal count cannot hide mismatch; cold suffix appends/warms without cloud writer | Checked / T8, U: [reconciler](<../../packages/azure-sync/test/reconciler.test.ts>), [service](<../../packages/azure-sync/test/service.test.ts>), [two-store](<../../packages/azure-sync/test/two-store.test.ts>) | Cold retry marker is separate from initial-import claims; same-count interrupted warming still repairs. Cloud transport in two-store fixture is conditional in-memory. |
| Retained live A after B advances: block, no second open(write), direct pre-step rejects; recreated Host catches up | Checked / T8, U: [live guard](<../../packages/azure-sync/test/live-guard.test.ts>), [real retained Agent/restart](<../../packages/azure-sync/test/two-store.test.ts>) | **Host restart**, never a claim that closing/reopening a view disposes the Agent. Actual two-machine GUI remains Deferred / manual. |
| Conflict keep-local/export/remove only; protected JSONL header/cut/events + backup path; no merge/overwrite/fork | Checked / T8, U: [conflict](<../../packages/azure-sync/test/conflict.test.ts>), [two-store export/mode](<../../packages/azure-sync/test/two-store.test.ts>), [protocol](<../../packages/azure-sync/test/protocol.test.ts>) | 0600 checked on POSIX, not a Windows ACL guarantee. Export alone does not authorize execution. |
| Root-first durable descendant tombstones; root touch blocks new child/commit; no active old-generation descendant | Checked / T8, U+A: [repository](<../../packages/azure-sync/test/cloud-repository.test.ts>), [tombstone manager](<../../packages/azure-sync/test/tombstone-manager.test.ts>), [Azurite races](<../../packages/azure-sync/test/azurite.test.ts>) | Root/child ownership rules also apply to activation and later commits. Removal requires explicit attachment-retention disclosure. |
| Crash-resumable/paginated generation-scoped blob-before-row cleanup, orphan/lease sweep, ETag guards; delayed old cleanup cannot harm new gen | Checked / T8, U+A: [cleanup](<../../packages/azure-sync/test/cleanup.test.ts>), [manager](<../../packages/azure-sync/test/tombstone-manager.test.ts>), [Azurite](<../../packages/azure-sync/test/azurite.test.ts>) | Failures remain pending, not success. Shared attachments untouched; cross-service late old PUTs can leave orphans after a completed listing. |
| Explicit deleted→new-generation/full-history re-upload; retained disabled On preserves history; durable operation-id recovery; no auto-adoption/resurrection | Checked / T8, U+A: [manager](<../../packages/azure-sync/test/tombstone-manager.test.ts>), [resurrection](<../../packages/azure-sync/test/resurrection.test.ts>), [two-store offline](<../../packages/azure-sync/test/two-store.test.ts>) | New generation can establish new canonical header/genesis; old imported prefix stays immutable within its generation. No automatic reconnect activation. |
| Bounded/coalesced polling, backoff/auth stop, close/late success/cancel; no false synced while pending | Checked / T8, U: [poller](<../../packages/azure-sync/test/poller.test.ts>), [service](<../../packages/azure-sync/test/service.test.ts>), [runtime](<../../packages/azure-sync/test/control-runtime.test.ts>) | Five-minute default Host polling verifies whole selected history; not the local browser's 15-second status path. Final shutdown upload is best effort, not guaranteed. |

### T6–T8 — controls, credentials, browser SDK and advisory Git

| Criterion | Status / rerun / evidence | Boundary or remediation |
|---|---|---|
| Native /cloud status/on/off/sync/pull/map/unmap/mappings/takeover/detach/remove/export/repair; no optional-command-service dependency | Checked / T8, U+A: [commands](<../../packages/azure-sync/test/commands.test.ts>), [actual CommandRuntime](<../../packages/azure-sync/test/control-runtime.test.ts>) | Controls use shared strict controller; recordInput:false; credentials are not command arguments. Custom GUI supports auth/resurrection/degraded acknowledgement. |
| Exact browser-peer/auth/Host/Origin RPC routes; bounded streaming bodies/UTF-8/envelopes; redacted DTO/errors; capacity/cancel/dispose | Checked / T8, U+A: [RPC](<../../packages/azure-sync/test/rpc.test.ts>), [protocol](<../../packages/azure-sync/test/protocol.test.ts>), [runtime](<../../packages/azure-sync/test/control-runtime.test.ts>) | Status/catalog/Git do not resolve Agents. Session ids and scope are data, not injected shell/HTTP authority. |
| Write-only provider password body/ref, cleared on submit/cancel/disconnect/unmount; no config/log/model/localStorage secrets | Checked / T8, U+A+R: [settings](<../../packages/azure-sync/test/settings.test.ts>), [UI](<../../packages/azure-sync/test/client-ui.test.ts>), [source graph](<../../packages/azure-sync/test/client-source.test.ts>), [runtime secret scans](<../../packages/azure-sync/test/control-runtime.test.ts>) | Blank means keep, clear is explicit; read-only ambient/provider values must be changed at their source. Log contents may independently contain sensitive data. |
| Durable authPending UUID before provider commit/notify, accepted metadata after; pending reads/boot blocked, no secret rollback | Checked / T8, U+A: [settings crash/cancel cases](<../../packages/azure-sync/test/settings.test.ts>), [actual pending/reopen runtime](<../../packages/azure-sync/test/control-runtime.test.ts>) | Retry/replace/clear or select usable ambient auth explicitly. A late notification does not finalize uncertain config. |
| External credential notify synchronously suspends old admission/publication/polls/renewal before bounded rebuild; local status/Off/detach/export works missing auth | Checked / T8, U+A: [control cancel](<../../packages/azure-sync/test/control-cancel.test.ts>), [runtime](<../../packages/azure-sync/test/control-runtime.test.ts>), [startup](<../../packages/azure-sync/test/startup.test.ts>) | Offline local opt-out does not falsely claim shared cloud disable succeeded. Stalled old SDK work is bounded/observed, not allowed to publish. |
| Every local permission/status/progress writer guarded by shared lane + latest SDK record/nonce/generation/role; stale work cannot undo newer intent | Checked / T8, U: [LocalStore](<../../packages/azure-sync/test/local-store.test.ts>), [publication races](<../../packages/azure-sync/test/publication-races.test.ts>), [control cancel](<../../packages/azure-sync/test/control-cancel.test.ts>), [repair](<../../packages/azure-sync/test/repair-flow.test.ts>) | One Host per local state store; runtime instances share **one LocalStore**. Trusted raw-domain admin writes or multiple private LocalStores bypassing that lane are not claimed atomic. |
| Remote catalog keyset pagination, sanitized cwd/source/writer hints; explicit mappings and freeze/reconfirm; remove requires both confirmations | Checked / T8, U+A: [catalog](<../../packages/azure-sync/test/catalog-page.test.ts>), [controller](<../../packages/azure-sync/test/controller.test.ts>), [protocol](<../../packages/azure-sync/test/protocol.test.ts>) | Advisory lease mirrors never authorize; listing is not Agent creation, bulk import or automatic resume. |
| Existing-GUI blank/nonblank and panel On; settings/auth/mappings/catalog/import/conflict/degraded/detach/takeover; refresh counter/locale | Checked / T8, U+P: [UI](<../../packages/azure-sync/test/client-ui.test.ts>), [actual public SDK](<../../packages/azure-sync/test/client-sdk.test.ts>), [browser build](<../../packages/azure-sync/scripts/build-client.mjs>) | Blank stock hideChrome omits header actions: public hero LIST + dynamic blank-only corner SINGLE, yielding to **every** foreign occupant. Full stock composer/deployed UI remains Deferred / manual. |
| Conservative exact-session public composer blocks, shared refs/foreign-worktree coexistence, reentrancy/HMR cleanup, unload removes only own state | Checked / T8, U: [blocks](<../../packages/azure-sync/test/client-blocks.test.ts>), [SDK](<../../packages/azure-sync/test/client-sdk.test.ts>), [model](<../../packages/azure-sync/test/client-model.test.ts>) | No DOM interception/private submit adapter/global navigation veto. Host pre-step is backstop; after addon/hook removal enforcement no longer exists. Fixtures do not prove an active HMR watcher. |
| Local 15 s status only; connection generation invalidates old proof/flights, bounded/cancelled requests; browser has no Host/provider/Agent authority | Checked / T8, U+C: [model](<../../packages/azure-sync/test/client-model.test.ts>), [source graph](<../../packages/azure-sync/test/client-source.test.ts>), [measured zero-Azure status](<../../packages/azure-sync/test/cost-profile.test.ts>) | No idle ownership/lease churn to keep a badge green. Source build alone does not update a running GUI. |
| Git explicit local-only persistence cwd/scope; realpath pin, ancestor aliases allowed/final root replacement symlink rejected; non-Git null | Checked / T8, U+A: [Git](<../../packages/azure-sync/test/git.test.ts>), [actual runtime](<../../packages/azure-sync/test/control-runtime.test.ts>) | Never probe cloud cwd. Optional cached facts may be stale for 30 s; independent filesystem mutation is not atomic. No Agent/auth/permission/model side effect. |
| Trusted absolute Git/fixed argv, no shell; bounds/timeouts/UTF-8/scrubbed env; no optional locks/fsmonitor/hooks/filters/lazy fetch/status/diff-files | Checked / T8, U: [Git real argv/env/canary/index tests](<../../packages/azure-sync/test/git.test.ts>) | Conservative native hashes/scans; attributes/filter/CRLF/normalization/promisor/sparse/budgets → Unknown, not false clean. Index **bytes and mtime** unchanged. |
| Remote allowlist/credential stripping before publication; raw-backslash and ambiguous SCP reject before URL parsing; literal POSIX/PowerShell guidance | Checked / T8, U: [sanitizer](<../../packages/azure-sync/src/git/sanitize.ts>), [Git](<../../packages/azure-sync/test/git.test.ts>), [uploader](<../../packages/azure-sync/test/uploader.test.ts>), [controller](<../../packages/azure-sync/test/controller.test.ts>) | Helpers/local remotes omitted; arbitrary secrets in URL path text cannot be universally inferred. POSIX quoting actually executed; PowerShell fixtures only. No push/fetch/checkout/worktree/code transfer. |

### T9 — final documentation, packaging, cost and review

| Criterion | Current disposition | Evidence / remaining gate |
|---|---|---|
| Zero-to-synced guide, security/cost/limitations and rollback | Checked / T9 final documentation review: BOTH approve; parent verified | [Package guide](<../../packages/azure-sync/README.md>), [root overview](<../../README.md>), [package changelog](<../../packages/azure-sync/CHANGELOG.md>), [root changelog](<../../CHANGELOG.md>) and this matrix. Setup commands are examples, not executed provisioning. |
| Named cost model backed by actual SDK HTTP attempts, official current prices, EGT billing and sensitivities | Checked / T9 C+A: measured profile and both full integration pipelines pass; both final reviews approved and parent verified | [Cost report](<azure-sync-cost.md>), [test](<../../packages/azure-sync/test/cost-profile.test.ts>). No private SDK hooks; retry/range/failure attempts priced, not adapter-call guesses. |
| Exact pack/build/public root/protocol/browser exports and consumer smoke | Checked / T9 P: 108 files / 714,510 bytes plus extracted-tarball root/protocol/browser import and public consumer types | [Smoke test](<../../packages/azure-sync/test/package-smoke.test.ts>) links existing pinned dependencies to the extracted tarball. Not a fresh registry install, deployed plugin or Windows tar execution. Exact final automated size/count is recorded above; no registry publication or live installation is claimed. |
| Common image/file actual-byte maximum guard | Checked / T9 U (six boundaries + real Uploader no-synced-tip); live OS attachment-store acceptance still manual | [Attachment tests](<../../packages/azure-sync/test/attachments.test.ts>) and [implementation](<../../packages/azure-sync/src/sync/attachments.ts>); common cap verified in T9, not inferred from prior config validation; actual Host image decoding can occur before this transfer cap. |
| Exact plan cold 30 s / native 60 s and promotion race guard | Checked / T9 U+A, raw requested durations and header evidence plus race/failure/cancel regressions | [Lease tests](<../../packages/azure-sync/test/lease.test.ts>), [uploader tests](<../../packages/azure-sync/test/uploader.test.ts>), [runtime tests](<../../packages/azure-sync/test/control-runtime.test.ts>); finite cold controls, new-epoch promotion, no stale cold release of a native lease and late cleanup are verified; both final reviewers approved and parent verified. |
| Full package/root verify, Azurite, two-store, retained-live/restart/crash, types, audit/pack/whitespace | Checked / T9 automated: both full pipelines exit 0; both final approvals and parent verification complete | Exact T9 logs/counts/bytes are registered above. No root-package failure waived; both full root runs passed. T8 counts remain historical, not relabelled. |
| Final independent GPT + Grok reviews and parent verification | **DONE / T9 — GPT + Grok FINAL APPROVE; parent verified** | Coordinator/parent own gate and plan ledger; no final verdict invented here. Historical plan “three reviewers” wording is superseded by the current user rule. |
| Live Azure/manual-platform/cost export evidence | Deferred / manual | Checklist below; no paid provisioning, actual GUI installation/refresh or cloud billing export performed. |

## Cost and security interpretation

The [cost report](<azure-sync-cost.md>) is the detailed source, not a promise that
“1 GiB costs less than US$1 regardless of usage.” Official public East US USD
Consumption inputs were retrieved **2026-10-19 UTC**: Blob Hot LRS $0.0208/GiB-month,
write/list $0.05/10k, read/Other $0.004/10k; Standard Table service-scoped-key
$0.045/GB-month and $0.00036/10k transactions. GPv2 leases/properties are Other;
a valid Table entity-group request is one billable transaction, **not** one charge
per logical entity action. See [Blob pricing](<https://azure.microsoft.com/en-us/pricing/details/storage/blobs/>),
[Table pricing](<https://azure.microsoft.com/en-us/pricing/details/storage/tables/>),
[Table batching billing](<https://learn.microsoft.com/en-us/azure/storage/tables/storage-performance-checklist#batching>)
and [lease billing](<https://learn.microsoft.com/en-us/rest/api/storageservices/lease-blob#billing>).

The actual-SDK→loopback-proxy→real-Azurite profile measures one/eight-batch idle
refresh, native/imported ownership, exact 30/60-second acquisitions, cold import,
EGT/races, retries, pagination, explicit Off/inspection and 10 MiB attachments.
The model assumes **two devices, at most one enabled session record per device
(counting every descendant separately; this example has none), at most eight
active committed batches, five-minute Host polls, 3,000 publications over at least
375 thread lifetimes, 3,000 model steps, 60 active writer hours, 1 GiB average
retained Blob + 0.1 GB Table**. It includes 405 first proofs, 750 retire-Off actions,
30 cold inspections, 730 repeated immutable attachment attempts, named imports and
10% operation contingency; forced takeover is measured but this example assumes zero.
It yields **580,978 base modeled HTTP requests** and **$0.2788641636/month**,
excluding egress/tax/extra features. This is neither the
plan's early ~30k-op shorthand nor an actual invoice, measured month or enforceable cap.

Unchanged Host polling re-verifies/downloads whole enabled history; imported step
proofs can read it again. More enabled threads, batches, larger download ranges,
retries/conditional attempts and retention can exceed US$1. Use explicit
**Standard_LRS** (not the CLI's RA-GRS default) and Table **Service** encryption-key
choice; account-scoped Table encryption is a different, costlier transaction SKU.
[Official CLI setup](<https://learn.microsoft.com/en-us/cli/azure/storage/account?view=azure-cli-latest#az-storage-account-create>)
and [Table key billing](<https://learn.microsoft.com/en-us/azure/storage/common/account-encryption-key-create#pricing-and-billing>)
explain those choices. No provisioning was executed by this documentation pass.

Egress, private endpoints, diagnostics, versions/soft-deleted copies, late orphan
candidates, retained shared attachments, geo replication, taxes and actual usage
must be budgeted separately. No Azure Cost Management export exists here.

The cloud account is a trust boundary: TLS/SSE is not client-side encryption;
logs/attachments may contain private code, secrets, tool output and host paths.
Authorized cloud writers can rewrite history. Git sanitization removes recognized
credential syntax but cannot discover arbitrary secret text in paths. Review
optional metadata and restrict **both Blob and Table data roles**. Management-plane
Contributor is not sufficient. Credentials/settings are device-local; required
presets/models must be installed locally, not copied from cloud definitions.

## Manual two-machine checklist (NOT RUN)

All boxes below are **Deferred / manual**, not successful test claims. Use two
actual machines with separate local state stores, including a real Windows Host
and PowerShell plus a POSIX Host. Obtain authorization before paid setup/role
changes. Record UTC date, OS/Host/plugin build, auth mode, sanitized resource/SKU
and result/evidence path for each; never include secrets or raw private logs.
Follow the [zero-to-synced guide](<../../packages/azure-sync/README.md>) rather than
inventing production credentials or treating emulator settings as deployable config.

- [ ] **Install/build/UI:** inspect the tarball and public exports, install into an
  explicitly chosen profile on both machines, restart Hosts, refresh the existing
  GUI and confirm the actual bundle/version. Check blank hero/corner, nonblank
  header and panel-only confirmed On, locale, light/dark layout, foreign worktree
  controls and block cleanup. The current local URL is <http://127.0.0.1:3080>;
  this work has **not installed/refreshed/verified it**. No replacement server is
  needed. HMR receiver alone is insufficient: verify `pnpm run dev:web` in the
  same implementation checkout before promising client-only automatic updates.
  A package build does not update that GUI automatically; other shell/plain-package
  changes require appropriate artifacts and a page refresh. Standalone Vite lacks
  the Host-injected bootstrap and is not a replacement application.
- [ ] **Minimum paid setup/security:** review/run the guide's Standard_LRS StorageV2,
  Hot/private container/Table Service-key examples; confirm actual SKU, private
  access, HTTPS-only/TLS1.2 minimum, encryption, no compute and no unintended
  versioning/soft-delete/geo/diagnostic features. Record actual policy additions.
- [ ] **Auth modes/rotation:** on permitted identities try CLI, connection-string
  password field, managed identity where available and auto. Test auth creates
  only private container/Table. Rotate/clear credentials while requests run;
  confirm old account publication/steps stop immediately, pending update remains
  blocked across Host restart, explicit retry works, and no secrets appear in
  config/JSONL/UI/logs/browser storage. CLI/MI inability must be recorded, not passed.
- [ ] **RBAC forbidden:** use a reader-only identity and one with management Contributor
  but no data contribution. Writes/leases must fail safely without execution or
  secret echo; restore Blob Data Contributor + Table Data Contributor deliberately
  and allow propagation. Never grant broader roles merely to make a test pass.
- [ ] **Private endpoint/network/TLS:** when available validate both Blob **and Table**
  DNS/private routing, public-network restrictions, minimum TLS and a forbidden/
  unreachable route. Fail closed on timeout/auth errors. If infrastructure is
  unavailable record this row deferred and any endpoint charges outside the model.
- [ ] **New/existing/blank toggle:** verify defaults Off, no Azure ownership call for
  local-only threads, confirmed On includes full pre-opt-in history and native
  command events. Unmaterialized remains pending. Off stops future publication
  while retaining cloud history; disconnected Off is disclosed as unconfirmed.
- [ ] **Cross-OS folders/presets:** create code/checkouts yourself; map Windows drive/
  UNC to POSIX and back, including spaces/case aliases and historical cwd changes.
  Confirm actual tool cwd, native title/activity/list history and workspace attachment.
  Missing folder, decoy, symlink escape, ambiguous/changed mapping and missing preset
  block safely. Add the real directory/preset or exact mapping; do not rewrite history.
  Verify unavailable-model warning and schedule/no-cwd refusal/remediation.
- [ ] **Attachments/degraded:** transfer real images/files/multiple aliases/Unicode
  names on both OSes. A valid local image remains unchanged; missing/unsupported/
  over-limit data or unavailable projection cache yields honest degraded **or failed/blocked status
  as appropriate** (for example, an import read LIMIT can remain import-incomplete/failed rather than
  degraded). No partial import becomes continuable or falsely fully synced.
  Before acknowledgement, including after Off, continuation stays blocked. Explicit
  projection-only/zero-attachment acknowledgement preserves Off; no partial log is
  made safe by acknowledgement. Inspect actual Windows ACLs and POSIX file modes.
- [ ] **Initial repair/crash:** interrupt after planned/create/append/flush/attachments/
  warm. Restart Host; inspect early claim/race banner and explicit repair, no
  duplicate events/closers. Only an original anchored never-completed initial import
  may create a missing artifact. Try disabled+detached retained repair; verify no
  cloud activation/upload/lease and unchanged cancellation identity/Off.
- [ ] **One writer/takeover/drain:** A runs; B is view-only. Delayed final upload prevents
  normal handoff until idle/quiescent/empty/flush/publish completes. Explicit forced
  takeover warns about running tools; A's *next* model step fails fresh proof and
  delayed publication is fenced. Measure native/cold duration and promotion behavior
  against the frozen implementation; do not rely on stale badge/TTL.
- [ ] **Retained live/cold catch-up:** retain live idle A, advance B, return to A: no
  second native writer or stale execution; show restart requirement. Closing the
  view alone must not be advertised as sufficient. Restart **Host**, catch up cold,
  and confirm complete localized prefix/attachments/projection or disclosed degraded
  limitation without a second cloud/native writer.
- [ ] **Divergence/export:** arrange B advance during A rejection/local suffix; verify
  conflict, both suffixes/input history preserved and no transparent merge. Exercise
  keep-local/detach, protected export and explicit removal separately. POSIX export
  mode is 0600; verify Windows ACL yourself. Export alone leaves cloud stop in place.
- [ ] **Offline/detach/uninstall:** disconnect network/credentials, ensure cloud steps
  fail closed; local status/export and explicit Off/detach remain reachable. Complete
  local history can continue only after the explicit local choice. Uninstall per
  rollback below; check data retained and absence of enforcement disclosed.
- [ ] **Remove/root/child/reconnect/resurrect:** confirm attachment retention, remove
  root+descendants, interrupt cleanup/retry and race a new child. Old-generation
  writers/cleanup cannot damage new data. Offline old device stops on tombstone/gen
  change without resurrection. Explicit resurrect creates a new generation and
  uploads verified full history; retained disabled On preserves generation/history.
  Check shared attachments/versions/orphans and never report this as a full wipe.
- [ ] **Read-only Git/real PowerShell:** execute only reviewed literal inspection
  guidance in actual Windows PowerShell and POSIX shells with spaces/quotes/metacharacters.
  Confirm index bytes/mtime and working files unchanged, no fetch/push/checkout,
  safe remote omission and Unknown for unsupported/filter/sparse/promisor cases.
  Advisory branch/commit must not be interpreted as proof code matches another device.
- [ ] **Actual billing/export:** measure real retained average Blob/Table capacity,
  per-service request/lease/EGT/retry/range counts and egress over a representative
  workload; export Cost Management/Storage metrics and compare regional SKU rates,
  feature charges/taxes and invoice timing to the model. Record actual results, not
  “under US$1” from a short meter sample; configure independent budget alerts if desired.

## Rollback and uninstall

1. Stop work on all devices, protect local JSONL/attachments and export a complete
   verified snapshot if needed. Keep only one Host per local state store.
2. Explicitly select **Off** (retains remote history and attempts shared disable) or
   **detach/keep-local** (local-only, remote unchanged). Check whether cloud fencing/
   lease release was confirmed; disconnected cleanup cannot guarantee remote success.
   Complete/acknowledged history is required; finish partial-import repair first.
3. Stop/uninstall the plugin through the existing profile controls/CLI, then restart
   the Host. Removing the Host hook or client addon means **no more pre-step/composer
   enforcement**. Do not assume a stale browser block or removed hook still protects
   another writer. Bounded final flush/release may fail; a held lease can expire.
4. Local history/attachments remain; cloud copies, shared attachments and separately
   retained versions are not silently deleted. Use explicit **Remove from cloud**
   while the plugin is installed to tombstone a root/descendants; only a separate
   administrator-authorized account/container/Table purge can remove shared data.
   Do not purge an account used by other threads/devices without reviewing impact.
5. Reinstalling does not automatically adopt/resurrect a generation or transfer code.
   No automatic Git push/fetch/checkout, code rollback or worktree-binding recreation
   is part of rollback. Choose a compatible known package and review schema limits.

## Definition-of-done disposition

| Plan §9 / T9 requirement | Disposition |
|---|---|
| All ordered implementation tasks and required approvals | T1–T9 implemented/automated-green, **BOTH FINAL REVIEWS APPROVE and parent verified**. The code objective is complete under checked/deferred DoD; no deployment/publication consent is inferred. No final user/release verdict inferred. |
| Verify/Azurite/two-store/retained-live/restart/crash green on final tree | Checked / T9 automated: final whole-root + Azure pipelines exit 0, zero failures/skips; 930 unit/10 integration/1 tarball smoke and 15 tooling, exact 108-file/714,510-byte pack. New cap/lease/finalization and tarball corrections are included. Independent reviews/parent verification remain separate. |
| Every criterion checked or explicitly deferred | This matrix maps §4, §6/§7 task acceptance and Appendix D; real service/GUI/platform/billing gaps are the unchecked manual rows. Pending rows are not passes. |
| Installable/zero-to-synced, no core modification, rollback and security/cost/limits | Source guide and exact build/pack/type tests documented; extracted-tarball smoke passed; both final independent approvals and parent verification complete. No installed GUI, npm publication, paid provisioning or core modification claimed. |
| Residual risks disclosed | Trusted cloud writers; secrets in logs/optional Git path text; external in-flight tool effects; retained-live restart; public composer-only UX boundary; one shared LocalStore/one Host boundary; unsupported projection cache/missing assets; actual Windows/PowerShell/ACLs; full-history polling/egress; retained shared attachments/versions/late orphans. |

Future scope remains out of v1: all-state/global settings or credential sync,
preset definitions, browser drafts, code/working trees/worktree bindings,
schedules, merge/remote overwrite/fork, cloud-hosted GUI/compute and client-side
end-to-end encryption. None is silently implied by “conversation continuation.”
