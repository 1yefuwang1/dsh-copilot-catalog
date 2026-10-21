# Cloud import destinations — implementation acceptance ledger

Updated: 2026-10-21 (Asia/Hong_Kong).

**Status: I1–I6 complete, accepted corrections verified, BOTH final independent reviewers APPROVE. No release/deployment claim.**
Both reviewers confirmed accepted P1 receiving-code consent/comparison and P2 first-On creation-base
retention gaps. Both are corrected with real regressions, including old unsafe review/active-agent
rejection and same-B dirty/unknown code consent; prior v1/v2 stale bytes now survive read failure even
without creation base A. The frozen corrected tree passed `pnpm run verify`: **1962 root executions**,
zero failures/skips (units1845/integrations102/tooling15; Azure1061+11), plus strict archive1. After the
final neutral warning/recovery-copy delta, Azure leaf `verify` passed again: **1062 unit/acceptance
+11 real SDK/Azurite integrations +1 extracted-archive runtime/strict type smoke**, zero skips/failures.
Those leaf executions overlap the root run and must not be added as extra unique tests. Final packs:
**Azure136 files/680507 source bytes**, **Worktrees56/782895**, unchanged720000/825000 caps; audit349.
Both corrective reviewers APPROVE; final neutral copy/test delta also inspected with no objection.
Counts farther below are the earlier verified PRE-CORRECTION checkpoint, not the final totals.
This record covers the
[Local/New worktree plan](<../plan/2026-10-20-223034-HKT-cloud-import-local-worktree.md>) and its
[portable Git-context amendment](<../plan/2026-10-21-125717-HKT-cloud-import-git-context.md>).
The existing [Azure v1 ledger](<azure-sync.md>) is historical T1–T9 evidence, not a pass for these changes.

The user changed review cadence: implement all I1–I6 first, then spawn independent
`github-copilot/gpt-6.1-sol` xhigh and `github-copilot/grok-4.7` xhigh final review subagents. No per-task
review panel. Implementation workers/test authors are not independent review approvals.

## Scope and non-goals

- Preserve original cloud SID, canonical history/lineage/cut and explicit per-thread opt-in.
- Local uses an existing exact folder; New worktree creates one fresh managed checkout at an explicitly
  confirmed available commit. No helper thread, first message, naming-model call or source file change.
- Per-session/per-device destination mappings; no global-map retarget or existing-SID relocation.
- No code/Git object transfer, automatic fetch/push/reset/stash, dirty source backup, worktree reuse,
  cloud-primary redesign, arbitrary per-thread folder mirror or synchronized credentials/configuration.
- No commit/push, live profile edit, GUI installation, replacement server or paid Azure deployment.

## Final review record

- **GPT-6.1 Sol**, `github-copilot/gpt-6.1-sol`, xhigh, reviewer
  `2d2d56e2-e323-46da-aef9-5092bbc7c13d`: baseline REQUEST_CHANGES, accepted P1/P2 fixed; corrective
  APPROVE after independent97/97 focused executions and source/pack checks. Neutral branch-copy P3
  fixed, actual comparison regression1/1 independently passed; final APPROVE, no outstanding findings.
- **Grok-4.7**, `github-copilot/grok-4.7`, xhigh, reviewer
  `740b385b-3261-432b-a787-8a0a2d77ef32`: baseline REQUEST_CHANGES, corrective APPROVE after inspecting
  all four written consent/revalidation/provenance/stale-byte constraints. Specific blocked-review
  translation added and minimal copy/test delta inspected with no objection. No outstanding findings.

Both reviews ran **after all I1–I6 implementation**, as the user requested; no per-task review panel.
Implementation workers were not counted as reviewers. Reviews did not authorize release, commit,
installation, deployment or unperformed manual cases. Parent final rebuilt-artifact verification
followed the last locale/test-only delta; no source change was slipped in after approval.

## Earlier whole-repository verification checkpoint

`pnpm run verify` completed exit0 after source freeze, all five plugins: **1,941 executions** =
unit/acceptance1825 (catalog76/search81/tool-schema14/worktrees613/Azure1041) + integration101
(20/4/6/61/10) + root tooling15. Zero failures/skips. Host/browser/test/public-consumer/tooling
checks passed; the credential audit344 and whitespace check passed. Do not sum independent repeated
runs as extra unique tests. The native-command file was registered after this invocation started;
its separate actual runtime test passed. The subsequent FINAL Azure `verify` completed exit0:
**1042 unit/acceptance +10 actual SDK/Azurite integrations +1 extracted-archive runtime/type smoke**,
zero failures/skips, including every new native-command/RPC/E2E/Git/SQLite test. This rerun overlaps
root verification; do not sum it as additional unique tests.

Final minified publication checks: **Azure134 allowlisted files/669735 source bytes**, **Worktrees56/782558**,
below unchanged720000/825000 caps after the documentation updates.
The separate extracted Azure archive runtime/strict public type consumer passed1/1 with
`skipLibCheck:false`, including every new feature entrypoint; pinned dependencies were linked in, not
claimed as a clean registry installation. The exact public config declaration shields a broken concrete
backend SDK edge without any SDK patch or typecheck exemption.

Focused actual cross-package proofs also passed: production pending-CWD/native race9, actual packaged
startup failure/lifetime4, Local coordinator4, Worktree coordinator3, real SQLite FTS1, new RPC5,
real-Git/publication11, native command1. Counts overlap the whole-root run or separate reruns; no additive
unique-total claim. The old nonempty-profile fixture alarm was withdrawn: correct supported boot uses
empty base config + full bundle insertion + permanent USER overrides. Actual packaged failure proofs
verify there is no raw/in-memory native fallback.

The [Git-v2 HTTP supplement](<cloud-import-destination-cost.md>) records optional-path vectors separately
from the legacy scoped monthly model; it is not real Azure/deployed/two-device billing evidence.

## Earlier scoped checkpoints — historical, not current totals

Do not sum repeated executions as unique tests, or relabel a fixture as a deployed-GUI/live-Azure pass.

| Checkpoint | Evidence and boundary |
| --- | --- |
| Native feasibility | 16 direct tests passed at I1: real native Controller/JSONL/Workspace/Projects, independent processes and sampled SIGKILL, exact SID/cut/marker, no-promote read-only Open and original-input wake. See [native tests](<../../packages/azure-sync/test/import-native-feasibility.test.ts>). Production seeded support remains disabled. |
| Compatibility/foundation | 24 direct tests passed before extra CWD-fence work: actual public Loader/app-boot with permanent user overrides, missing-provider in-memory fallback counterexample, native admission refusal, opaque proof/scopes, fresh Continue activation, claimed-input retention and cross-process SID claims. See [foundation tests](<../../packages/azure-sync/test/import-foundation.test.ts>) and [compatibility tests](<../../packages/azure-sync/test/import-compatibility-feasibility.test.ts>). |
| Worktree placement | 11 native/Git tests passed at I2: exact object/ref pin, no bootstrap, required-directory checks before effects, binding/proof/Ready, cancellation and late receipt retention. 161 final core regressions passed; earlier broader235 run predates last refinements. See [placement tests](<../../packages/worktrees/test/import-placement.test.ts>). |
| Browser/model | 85 focused checks passed before last admission/status refinements: actual bundled factory/public SDK registry/blocks plus old model, new transport and wizard JSDOM. This is not a full stock composer/live browser. See [wizard tests](<../../packages/azure-sync/test/client-import-ui.test.ts>), [admission model](<../../packages/azure-sync/test/import-admission-client.test.ts>) and [SDK bench](<../../packages/azure-sync/test/client-sdk.test.ts>). |
| Focused contracts | Latest 25-request/browser-admission tests passed; a subsequent client typecheck found an unused dialog state, which was wired and client typecheck then passed. These are incremental records, not final-source QA. |
| Dependency alignment | Bootstrap helper pins now satisfy declared SDK peers; `pnpm peers check` passed. SDK remains0.2.1-rc.2. Explicit repo installs used ignore-scripts; no user runtime/profile install occurred. |

## Automated implementation matrix

- [x] Public exported contracts and both standalone package/type consumers load correctly.
- [x] Local/non-Git folder import and same-SID nonblank native workspace/project binding.
- [x] Worktree exact local commit/branch/HEAD, no fetch, unique branch/root and no model/helper thread.
- [x] All historical cwd paths checked against the selected Git tree before effects and real filesystem
      afterward; exact native/logical header cwd; source subdir unchanged; symlink/missing/outside refusal.
- [x] Ordinary/subagent/seeded/header/preset eligibility refusal before reservation/Git/native effects.
- [x] Required staged native/workspace/project/Worktree receipt and Ready acknowledgment; no early success
      or silent Local fallback; pending naming/start/handoff/cleanup fenced.
- [x] Fresh per-SID pre-effect claims, shared native-CWD admission mutex and full provider interception.
      Another SID cannot materialize/create/execute in a pending/stopped worktree root, including a deferred
      create racing reservation. Ordinary Local sharing remains unchanged. Kernel mutex owner-death tested.
- [x] Actual persistent **user** profile overrides survive missing/downgraded exports; session AND exact
      agent-loop depend on provider+guard, preventing native memory fallback. Root journal failure is not
      treated as absence. Version/schema/apply failure alone is not the proof.
- [x] Public cold native Open produces no Agent or lifecycle writes; prompt/queue/update/direct create/
      resume refuse before fresh Continue. Cached-Agent loss of compatible capabilities rejects steps
      while preserving claimed messages durably. A saved grant does not activate a fresh guard.
- [x] Original pending messages wake once, in order/target/IDs, only after explicit ack/local readiness/
      fresh cloud ownership/catch-up. No artificial prompt or forced takeover.
- [x] Canonical generation/header/cut/prefix anchored; same-generation suffix does not retarget reviewed
      history or invalidate unchanged semantic Git selection solely for counts/timestamps.
- [x] Per-SID binding used consistently by importer/resume/repair/catch-up/admission/uploader/Git; no global
      fallback when a scoped binding is invalid. Legacy non-destination flow and v1 DTOs preserved.
- [x] Code context separates creation base from current HEAD/upstream; captures local-base upstream at
      creation while Cloud Off stays local-only; no internal baseRef/local sentinel/credentials exported.
- [x] Git v2 stored in bounded versioned gitJson, not new v1 keys; old pull/catalog stays strict v1/absent,
      no sibling fields; new v2 import DTO negotiated separately with outer carrier stillv1.
- [x] Metadata-only Sync/drain uses fresh exact-candidate-tip read + owner/epoch/ETag/child-root authority,
      preserves all history fields and Off/account intent; old writers losing context degrade explicitly.
- [x] Cancel/Off/detach/credential races and ignored-abort effects preserve receipts and latest stop.
      No legacy session record before independently readable artifact. Known retained repair remains
      cancelled/disabled; no Ready/Continue/cloud resurrection from read-only repair.
- [x] Retry/reconnect/duplicate IDs preserve same checkout/SID; dead/uncertain claims and absent checkout
      after possible shared-ref effect refuse automatic recreation/steal and expose recovery-required.
- [x] Complete real-Git/native-JSONL/storage-domain/HTTP/Azurite regression and fault suite.
- [x] Actual production SQLite FTS search finds a uniquely tagged imported message after reconciliation.
      Cache warming alone is not this proof; no remote full-text search claimed.
- [x] Host/browser/test/tooling/public-consumer types, secret audit and source portability checks pass.
- [x] Generated/minified artifacts match build; tarball runtime/type smoke uses actual archive.
- [x] Exact publication allowlists pass with UNCHANGED Azure720000/Worktrees825000 byte limits.
- [x] Existing catalog/search/tool-schema/worktrees/Azure T1–T9 regression remains green.
- [x] Both final independent review agents approve the corrected full implementation; no disputed finding
      bypassed and no earlier design approval mislabeled implementation approval.

## Support limitations and manual release evidence

The current verified claim/materialization experiments target trusted local POSIX storage, sampled
process death and the pinned native JSONL backend. They are not a power-loss or every-syscall proof.
Windows import provisioning and unknown seeded initial paths refuse before effects; generic persistence
append does not promise atomic initial seed materialization. Shared/network filesystem claim safety is
not established. A dead/uncertain durable SID claim requires explicit offline inspection/reconciliation,
not timeout takeover. Locks/temporary files are never cloud-portable state or blindly deleted.

- [ ] Actual existing GUI after rebuilding/refreshing with deliberate supported-profile installation.
- [ ] Two separate devices, valid code preparation and real cloud writer handoff/foreign-owner refusal.
- [ ] Actual Azure identity/RBAC/TLS/private-network/rotation behavior and request/billing measurements.
- [ ] Platform-specific path/Git/durability/permission behavior; Windows refusal verified manually.

These manual cases remain **not performed / explicitly deferred**. No install/deployment/billing result
is inferred from native fixtures, JSDOM, SDK benches, Azurite or package smoke tests. The code objective
is complete under the checked automated and disclosed-refusal scope above; installation/publication
or claiming these manual release results requires separate authorization and evidence.
