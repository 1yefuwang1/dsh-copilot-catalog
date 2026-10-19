# Azure cloud sync handoff

Last updated: 2026-10-19 UTC

## Current continuation — implement the full remaining plan

The user requested continuing until the entire plan is implemented. T5 remains approved. T6 is
implemented, verified, and approved by BOTH GPT and Grok. T7 is also approved by BOTH at the exact
878-test corrected checkpoint. T8 is implemented, verified, and approved by BOTH on the final 902-test checkpoint.
T1–T9 are implemented, automated-verified and APPROVED by BOTH required reviewers. Parent has
independently verified the final930+10+smoke1 /108files714,510byte checkpoint, audit297 and whitespace.
The code objective is complete under checked/deferred DoD; all16 manual items remain deferred, NOT passes.
Source and packaged documentation stay frozen. Parent alone closes the persisted goal after this ledger audit.
Do not request Gemini approval. If a reviewer finding is disputed, stop and ask the user.

## T9 final checkpoint — BOTH APPROVED and parent verified; T1–T9 DONE

Implementation and packaged documentation are frozen. GPT + Grok final approvals and parent final
verification are complete. Persisted goal state remains exclusively parent-owned; this subagent has
not changed it. No commits/reset/checkout/push/handoff or original-checkout
mutation occurred; temporary Git fixture repositories are the only test setup that makes commits.

- **Whole-root final verify exit 0:** `/tmp/azure-sync-t9-root-final.5FdqA6.log`.
  All units: catalog76/search81/tool-schema14/worktrees602/Azure930; integrations20/4/6/61/Azure10;
  root tooling15 (**1,819 root test executions**), zero failures/skips. All source/test/browser/public
  consumer/tooling types pass; 132 tooling/test and 98 portable sources, five standalone manifests.
- **Azure final verify exit 0:** `/tmp/azure-sync-t9-leaf-final.0aTpdS.log`.
  **930 unit/acceptance + 10 integration** (9 real-Azurite/runtime plus measured cost) + **1 actual
  extracted-tarball import/type smoke**. Credential audit297 passes. Exact pack **108 files /
  714,510 bytes**, below the UNCHANGED720,000 cap. Other leaf caps remain unchanged and all pass.
- T9 closed two acceptance gaps with parent authorization: exact cold30s vs native60s lifetime
  (no cold background renew; fresh-epoch promotion on Agent appearance, including queued-finally
  cleanup; preserve existing native60; failure/foreign-loss/late-cancel cleanup) and the common
  actual-byte image/file transfer cap BEFORE authorization/hash/PUT. No wire/cloud/local schema change.
  Actual SDK acquisition headers verify cold On/sync/takeover/inspection/child30 and native60.
- Optional tiny Git hardening strips platform trailing separators before final-root lstat while
  preserving drive/UNC roots and allowing ancestor aliases. Both URL privacy fixes remain unchanged.
- Tarball smoke validates exact archive contents, extracts the actual package, imports public root/
  protocol/browser factory and compiles a public consumer. It links the existing pinned PUBLIC
  dependency installation; it is NOT a fresh registry install or deployed GUI assertion.
- [Cost evidence](docs/acceptance/azure-sync-cost.md) uses real SDK HTTP attempts through loopback
  proxies to real Azurite, not adapter-call guesses: idle M1/M8/full imported proofs, actual EGTs,
  cold/active leases, conditional/retry/pagination, 10MiB range reads, repeated immutable uploads,
  explicit retire-Off and inspections. Model **580,978 requests / $0.2788641636** under named bounds,
  not an actual Azure bill; first proofs/repeats/750 Off/30 inspections and10%ops contingency included.
  Every enabled descendant counts separately; cheap example has none. Current full logs reproduce it.
- [Acceptance matrix](docs/acceptance/azure-sync.md) maps all plan criteria checked/deferred. Manual
  deployed GUI/two-machine Windows/PowerShell/live Azure RBAC/private DNS/TLS/rotation/real monthly
  billing remain explicitly unrun. No paid resource deployment or profile installation was performed.
- FINAL APPROVE: `github-copilot/gpt-6.1-sol` xhigh, reviewer `1f1a45fc-edd1-4d74-a297-4297a510690f`:
  independent393 tests +15 tooling +6 fresh actual-state/protection probes, all types/audit/pack,
  official-price/EGT/math refetch and byte comparison of all101 generated artifacts; final docs reread.
- FINAL APPROVE: `github-copilot/grok-4.7` xhigh, reviewer `a33407d9-1095-4587-baa1-a8533233d2f7`:
  source/cold/image/privacy/cost/tarball/manual-boundary audit passed; final repository-only status,
  per-copy-poll and legend corrections reread and approved. All accepted findings closed without dispute.
- Parent independently read exact root/leaf results and final document states, ran audit297/diff0 and
  confirmed preserved working status. No current jobs remain. No Gemini, no release/deployment claim,
  and no source/test/packaged-file change after108files714,510bytes. Parent alone changes goal state.

## Approved T6 checkpoint and historical detail

T6 now includes the shared strict protocol/controller, native commands, exact authenticated browser
RPC, write-only credential settings, fail-closed runtime rebuilds, offline detach/off/export,
remote catalog pagination, verified takeover, mapping reconfirmation, and cancellable import repair.
The T6 reviews returned fourteen accepted runtime findings. Original six: priority off/detach and old
intent preemption, canceled queued enable, ownership cancellation, cold manual lease lifetime,
mapping publication freeze, and non-atomic credential/settings visibility. Follow-up three: retired
off cleanup overriding a replacement core's on, stale enable overwriting newer detach, and queued
credential notifications leaving old-account admission active. Later five: stale status writers,
resurrection completion and importer checkpoint snapshots, the child-root-read precommit gap, and
successful transaction rereads adopting a foreign generation. All fourteen are fixed; no disagreements.
All production session writers now use guarded shared-lane transactions or conditional deletion.
Publication responses are validated against the original generation/header/cut/root/epoch and exact
accepted tip before any local checkpoint. No direct production session put/delete calls remain.

Permission changes now use `LocalStore.transactSession` (shared local metadata lane + latest-record
SDK update + guarded creation). On captures its entry nonce/generation before queue admission and
stamps a fresh nonce; off cleanup checks the durable stopped nonce/generation before every CAS,
retry, and checkpoint. Off/detach/fallbacks share this lane. Admission receipt mutation is atomic,
so stale receipts cannot restore old permissions or deleted records. Synchronous pending-optout
predicates fence uploader/service/importer across rebuilds while durable writes are pending.

External credential notifications synchronously suspend old proofs/publication/pollers/renewals and
invalidate core pointers/epoch before serialized cleanup/rebuild. Read-only auth diagnostics cancel
on old-core invalidation without blocking replacement; late ignored SDK probes stay bounded/observed.
Real plugin/CommandRuntime/CredentialProvider/Azurite tests verify no old-account model execution or
publication and successful replacement before a stalled old SDK call completes.

Latest frozen T6 verification: **748 unit/acceptance tests + 9 real-Azurite tests + 14 tooling tests**,
source/test and built-entrypoint consumer typechecks, secret audit, pack **101 files / 556,399 bytes**,
and whitespace checks all pass. Log: `/tmp/azure-sync-t6-frozen.XpEQuk.log` (temporary evidence).
Both required reviewers APPROVED this exact checkpoint. GPT independently passed 434 tests and
re-ran the child-precommit/foreign-generation probes; Grok approved all guarded-writer and publication
boundaries. This is HISTORICAL T6 evidence, not a next-task instruction. T7 was subsequently approved
at its corrected 878-test checkpoint and T8 at902; CURRENT work is the frozen T9 final review gate at
the top. Live Azure/manual platform evidence remains explicitly deferred, never invented.

## HISTORICAL T7 browser/UI implementation — all approved; CURRENT T9 gate is at top

**Historical coordinator assignment:** `18870503-1f4c-4658-aa5b-e1f8f46ab264` owned the then-remaining
T7 integration/source/tests/package/docs and subsequently implemented T8/T9 after their approvals.
The details below preserve T7 implementation/review evidence, NOT an active T7 work queue or a claim
that T7 remains unreviewed. T7 is approved at878 and T8 at902; T9 is now implemented/automated-green.
Parent owns the two final T9 reviews and final verification. No earlier task is awaiting implementation.
All implementation owners are DONE; coordinator owns all T7 integration files. SDK-test owner
`733fe4b0-deda-4439-a2c5-be2cdc0a7395` finished `test/client-sdk.test.ts` +
`test/types/client-consumer.ts`: initially 8 public SDK tests; after correcting the misleading blank
visibility fixture, **14/14 SDK tests** and full test typecheck now pass. Actual public
ModuleLoader factories run real Cordis/SlotRegistry/renderer/LocaleRuntime/conversation.apply and stock
blocks/stores; domain sessions/transport/current binding/forms and unused CSS presentation atoms are
explicit fixtures, not substituted authority. SDK public test-runtime imports private/unshipped source
and vitest; it was NOT patched or used, and the unused dev dependency was removed.
Pinned public SDK runtime/type packages, zustand4.5.7 and immer10.1.1 are installed. All four native
seat owner declarations come from public client entrypoints (plugin-manager owns config-row types).
SDK tests now register in the package test script; source and package ownership is wholly coordinator's.

**Latest frozen T7 blank-visibility correction passes:** `/tmp/azure-sync-t7-blank-frozen.nzB6dq.log`
(exit 0), Node24.14.1, pnpm11.7.0, **878 unit/acceptance + 9 real-Azurite + 15 root tooling tests**,
zero skips/failures. This supersedes the earlier 870-test checkpoint in `/tmp/azure-sync-t7-frozen.87aP5e.log`.
Source/test/browser and built/public-SDK typeconsumer checks, credential audit (289 Git candidates),
root scripts typecheck, and whitespace all pass. Pack: **102 allowlisted files / 643,073 source bytes**,
under the unchanged 720,000-byte Azure-only cap. No jobs remain running. Coordinator sent this exact
878-test checkpoint to parent for BOTH independent GPT xhigh and Grok xhigh re-reviews.
On the earlier 870-test checkpoint, GPT reviewer
`2aac1f09-314c-456a-befb-2624722750c8` returned **APPROVE**: independent 203 tests, browser/test
and public consumer typechecks, 15 tooling, whitespace, and adversarial auth/connection/stale-proof/
secret/foreign-block/malformed-DTO probes passed. No T5/T6 regressions found within the documented
one-Host contract. This approval is now SUPERSEDED pending the accepted blank-visibility fix below.
Grok reviewer `d7620d7a-acd3-42c4-adfe-f80a33a3212a` returned **REVISE**: pinned native blank
chrome does not render header.actions, so the earlier direct-actions SDK fixture did not prove blank
GUI visibility; the panel also lacked On. Finding accepted without disagreement. Coordinator is
finished ONLY this delta: blank hero LIST control, compact blank-only corner SINGLE fallback
that yields to every foreign occupant and unregisters on nonblank, and confirmed On in Thread/panel.
The strengthened **14/14 SDK cases** apply the pinned stock hideChrome/hero visibility paths explicitly,
validate the public stock call sites, and test blank/nonblank exact-id conservative watches, foreign
corner priorities -10/+1000, shared-ref/HMR cleanup, native/list coexistence and panel-only opt-in.
These fixtures are NOT claimed to mount the full stock composer. The new 878-test full verification
passes as above. BOTH required reviewers now **APPROVE** this exact 878-test checkpoint: Grok
`d7620d7a-acd3-42c4-adfe-f80a33a3212a` approved all blank/control/coexistence paths; GPT
`2aac1f09-314c-456a-befb-2624722750c8` approved after 79 independent tests plus foreign-priority -100,
ambiguous-selection, target-switch and unload probes. Prior broad safety/import repair audit retained.
**T7 is complete. Parent authorized T8 implementation; T9 stays gated on both T8 approvals.**
Prior failed audit/SDK fixture type checks are fixed, not waived:
synthetic test credentials are derived, locale uses credentialInput, and no audit exemption was widened.

- UI agent `733fe4b0-deda-4439-a2c5-be2cdc0a7395` completed `packages/azure-sync/client.ts`,
  `client.types.d.ts`, `locale/en.json`, `test/client-ui.test.ts`; these files now belong to the
  integration coordinator; SDK ownership is also released. 18 JSDOM cases initially passed; safe
  off/partial repair, projection-only acknowledgement, blank corner and panel opt-in now bring this
  to **24/24 bundled UI tests**,
  browser + full test tsc and scoped diff all pass. Source is frozen pending T7 review.
  Forms are generation-keyed, password is an uncontrolled ref, cleared on submit/cancel/unmount/
  disconnect. Header watches use layout effects and include blank threads. No backend/model edits.
- Model/block agent `fdd1abc0-fed8-4ab6-81d5-d76f2ceea39e` completed `client-model.ts`,
  `client-blocks.ts`, and matching tests. **39/39 pass** after projection-only Off/ack/On regression,
  test tsc and scoped diff pass. Local readiness
  also requires a complete/degraded-ack import even when `admissionRequired:false` (Host import guard
  is stricter than the cloud lease gate). Off/detach/repair remain reachable for partial copies. Pure browser
  imports only protocol/helper; no Host implementations. Refcount + global Symbol WeakMap handles
  foreign blocks, multiple watchers, synchronous reentrancy, HMR, and unload. Watches reset unknown/
  blocked on re-open, never dispose Host Agents. Fifteen-second polling is LOCAL STATUS only;
  ownership checks are transition/user-driven, avoiding idle Azure lease churn.
- Workflow agent `048171c8-c4e3-4854-8a8c-2eac693bac41` CONFIRMED real Host/JSONL/domain failures:
  A) canceled initial import after durable plan/before artifact create cannot repair (NOT_FOUND);
  B) gen2 initial preflight needs-folder/preset failure stamps default gen1, then repair rejects;
  C) explicit-off partial import is safely stopped but has no retained read-only repair remedy.
  Parent AUTHORIZED T7 host extensions in `src/sync/importer.ts`, `import-service.ts` if needed,
  `service.ts` repair routing ONLY, plus its new `test/repair-flow.test.ts` (no other files).
  Fix A/B with verified initial-target generation/epoch/expected count+chain anchored BEFORE preflight,
  and missing-artifact creation only for never-completed initial imports, after original full-prefix
  anchor/header/cut/generation proof. Existing/native/complete missing artifacts must not be recreated;
  no adoption of unrelated generation/header, no rewriting existing history or ignoring writer claims.
  C is explicitly authorized as READ-ONLY retained disabled snapshot repair for a known initial partial
  copy that is explicitly disabled+detached: `ResumeImportOptions.allowDisabledRead?:boolean` is INTERNAL,
  no wire change; preserve enabled:false/detached:true/CID, no cloud activation/fence/upload. Later genuine
  On is allowed only after full verified repair. Negative newer-stop/gen/header/anchor tests required.
  Agent finished: **41 real Host/JSONL/domain repair-flow tests**, a 217-test strict subset and
  source/test typechecks pass. Schema/public controller request unchanged. Existing T6 atomic authority
  guards, no-live-Agent repair gate, explicit mapping confirmation and collision behavior remain.
  This is a normal browser retry path, not a waiver of import/generation safety.
- Build/manifest/policies/backend integration is now coordinator-owned. Added `scripts/build-client.mjs` (esbuild
  browser IIFE, whitespace minification only, React stays factory-local runtime require),
  `tsconfig.client.json` (strict ES2022/DOM, ESNext/Bundler, types:[], JSON imports), client export +
  dsh.client metadata, build/typecheck/test wiring and exact `dist/client.js` publication extra.
  Installed PINNED dev deps esbuild0.28.2, React/ReactDOM19.3.0 + corresponding types,
  JSDOM30.1.2/types30.0.0. Lock updated. Current browser build and client tsc passed.
- Uploader no-partial guards: explicit enable refuses IMPORT_INCOMPLETE BEFORE mutating permission;
  sync refuses unfinished publication, ensureOwnership returns false, takeover cannot break a lease,
  and a new-generation snapshot cannot read a partial artifact. Undefined/native, complete, or
  degraded+ack are ready. Seven-state matrix and real Host repair regressions cover all guards.
- Parent confirmed using the existing degraded acknowledgement contract for projection-only degraded
  imports after Off, rather than broadening retained repair/create permission. UI now offers the
  explicit localized projection-limitation acknowledgement for known degraded logs even with zero
  missing attachments. It preserves Off/CID; On remains explicit and requires fresh ownership.
  UI/model/real Host tests prove Off→ack→local-only with no cloud/lease/history mutation; a later
  genuine On is separately tested. Remote Open requires degraded acknowledgement.
- Parent added safe remote catalog projection fields `cwd`, `sourceDeviceId`, optional last writer/
  lease owner/until (advisory only, never proof). Model decoder accepts them. No raw header/error/
  credential fields. Controller tests verify both optional advisory hints and their absence, with no
  private payload/lease-authority projection. A controller→browser decoder regression also verifies
  multiline title controls are flattened for bounded display rather than poisoning a catalog page.
  The 8 SDK conformance cases described above are registered; no private registry extraction or
  unshipped test-runtime workaround was used.
- Client runtime contract: `createCloudClient(ctx)` gives `store.subscribe/getSnapshot`,
  `watchSession(id)->release`, `getThread(id)`, typed `request(req,signal?)`, `refresh(sid?)`, `dispose`.
  Actual pinned connection API is `connection.generation` store of `{id:number}|undefined` and
  `connection.rpc.call('/api', endpoint, payload, signal)`. Thread phases loading/local/ready/blocked;
  local permission ONLY when `admissionRequired:false`, not merely `enabled:false`.
- Existing Worktrees client is a reference, NOT an implementation dependency. Public slots include
  `conversation.session.header.actions`, `plugins.row.config`, `sidebar.panellist`, `main`.
  All T7 must remain foreign-slot/block safe, no DOM interception, no model calls/secret persistence.
- Rebuild `pnpm --filter @1yefuwang1/dsh-azure-sync run build` after client/locale edits before UI tests.
  Current package scripts register client-model/client-blocks/client-ui/client-source/client-sdk and
  all **42** repair-flow tests. Source guards assert the
  exact browser dependency graph, no Host/provider/Agent/storage/DOM-interception imports, and fixed
  built module identity. Root tooling checks Azure loader/config/export/patch identity and rejects
  missing/extra browser tarball artifacts, without widening any package byte cap.
- Focused checks also passed: **121 UI/model/controller/real repair cases**, **10 SDK/sourcegraph**,
  and the **103 uploader/repair** subset before the final projection test. Final frozen verification
  above supersedes interim `/tmp/azure-sync-t7-runtime.Z9vo2K.log` (858 tests / 639,366 bytes) and the
  initial in-flight SDK fixture type failure; all findings were fixed and full checks rerun.
- No live GUI installation/refresh evidence yet. Existing GUI URL remains `http://127.0.0.1:3080`;
  no replacement server or dev:web watcher was started, no HMR behavior promised. SDK/JSDOM tests
  do not establish actual deployed GUI/Windows or live Azure evidence.

## T8 final checkpoint — approved by BOTH required reviewers

Parent authorized T8 after BOTH final T7 approvals. Coordinator has finished T8 and STOPPED at its
required gate. Latest corrected frozen evidence: `/tmp/azure-sync-t8-scp-frozen.yIajPp.log`, exit 0,
**902 unit/acceptance + 9 real-Azurite/runtime + 15 root tooling tests**, zero skips/failures.
Source/test/browser/public built consumer and root tooling typechecks, secret audit (293 Git candidates),
and whitespace pass. Pack: **108 exact allowlisted files / 680,104 source bytes**, under the unchanged
Azure 720,000-byte cap; no other leaf bounds widened. Trusted system Git tested: 2.43.0.
All jobs are collected. Prior `/tmp/azure-sync-t8-frozen.CpB9jH.log` (897 tests/679,084 bytes) and
`/tmp/azure-sync-t8-url-frozen.OC0EMa.log` (899 tests/679,365 bytes) are superseded.

GPT reviewer accepted blocker (no disagreement): WHATWG URL parsing could normalize a raw backslash
before authority parsing, unlike Git/libcurl, and reclassify userinfo into a hostname/path that survives
credential stripping. The first accepted production correction rejects ALL raw backslashes BEFORE any URL
parse. HTTP/HTTPS username-only/numeric-password matrices prove strict facts/JSON rejection, actual
Git config→probe→serialized facts with remote omitted/no canary, plus optional publication and
local/catalog DTO omission without credential echo. SCP/normal SSH remain supported; Windows local
remote paths remain rejected. **15 Git cases** now pass. Both reviewers must approve the corrected
899-test checkpoint. GPT (`55ccdc88-bf8e-47d0-918f-ddfea1b94c2e`) now **APPROVES** this exact
checkpoint after 184 independent regressions, types/whitespace, and 5 fresh actual GitProbe→Uploader
(real JSONL/domain/cloud transport)→controller/catalog→browser decoder probes: no canary leakage,
no permission/Agent/model changes, index bytes/mtime preserved. Prior broad read-only audit retained;
all GPT findings on that checkpoint closed. This approval is SUPERSEDED pending the next narrow fix:
Grok (`959605ea-e61f-4024-84dc-6b7a0ea74ede`) returned **REVISE** for secret-bearing SCP ambiguity
(colon before @ becoming a host plus password/PAT path). Accepted without disagreement. The parser
now validates the entire unambiguous pre-query SCP core before dropping benign query/fragment
suffixes; path excludes @/colon/whitespace/backslash, optional user consumes the only permitted @,
and host length remains >1. Normal git@host:path and its benign query suffix keep their prior output;
:// SSH URI literal path @/colon remains intact. Real Git→strict facts→publication JSON→catalog
and uploader/controller/browser omission matrices cover both password and PAT examples.
A tiny optional fresh-probe lstat guard also rejects a final scope-root symlink replacement, while
ancestor aliases remain allowed. This is advisory only; cached metadata may be stale for 30 seconds
and no atomic guarantee against independent filesystem mutators is claimed. New focused **112** tests
and full corrected **902-test** frozen verification pass. **18 Git cases** now cover both URL fixes and
root alias behavior. BOTH required reviewers now **APPROVE** this exact 902-test checkpoint:
GPT (`55ccdc88-bf8e-47d0-918f-ddfea1b94c2e`) passed 187 independent tests plus 9 fresh full
Git/publication/privacy/scope probes and types/whitespace; Grok (`959605ea-e61f-4024-84dc-6b7a0ea74ede`)
verified actual sanitize/probe/index/valid-positive/root-pin/ancestor behavior. Both URL findings
are closed without disagreement. **T8 is complete; parent authorized T9 implementation.**
T9 now owns documentation, real measured-operation cost modeling, package/consumer smoke and full
acceptance checks; the final BOTH-reviewer gate and parent verification have now completed successfully (current checkpoint at top).

- New [probe](packages/azure-sync/src/git/probe.ts), [sanitizer](packages/azure-sync/src/git/sanitize.ts)
  and [guidance](packages/azure-sync/src/git/guidance.ts). Only fixed read-only rev-parse,
  symbolic-ref, config, ls-files/index and ls-tree/object reads. NO status, diff-files, fetch, push,
  checkout, worktree mutation, filters/textconv, external diff, or shell execution by production code.
- Probes pin canonical LOCAL cwd/scope (localized JSONL header or explicit mapping root); reject
  non-Git/foreign/missing/symlink-escaped cwd or a repository root outside that scope. They NEVER
  probe cloud cwd. Default Git comes from trusted system absolute candidates, not PATH/current cwd;
  an explicit executable override must be an administrator-trusted absolute path.
- Environment is an allowlist: no inherited Git dir/worktree/index/config/trace/helper injections,
  global/system config, external diff, prompts, or pager. Optional locks, fsmonitor, untracked cache,
  preload, hooks, auto maintenance, and protocols are disabled. Partial/promisor/sparse/filter/
  attributes/CRLF configuration skips object/content inspection and reports Unknown rather than
  relying on old Git supporting GIT_NO_LAZY_FETCH. No lazy-fetch helpers or ODB writes in probes.
- Dirty is intentionally advisory/conservative, not Git status: bounded raw blob hashes, staged-tree
  comparison and native untracked scan only. Ignored files may count as dirty; attributes, CRLF,
  unsupported entries and limits produce Unknown, never an execution grant. Streaming opendir
  buffers 32 entries; count/depth/per-file/total bytes, stdout+stderr, strict UTF-8 and overall time
  are bounded. Symlinks are never traversed as directories; link blobs compare link text only.
- Git metadata is strictly allowlisted and sanitized BEFORE optional gitJson publication and catalog
  projection. All URL userinfo/query/fragment is removed; helpers/local remotes are omitted. Existing
  upload generation/nonce authority is rechecked after advisory awaits; newer Off wins in regression.
- New git-info RPC is explicit, LOCAL-only, exact-session, bounded (16 retained canceled flights),
  requires no auth boot/Agent/cloud/ownership call, and changes no permission. Fifteen-second client
  STATUS polling does not trigger Git IO. UI shows escaped local/source facts and read-only literal
  POSIX/PowerShell ref inspection guidance; no automatic Git operation or code transfer.
- **18 Git tests** prove index content AND mtime unchanged, clean/dirty/staged/untracked/unborn/
  detached/linked-worktree cases, native bounds, real argv traces, inherited-env attacks, filter/
  fsmonitor canaries and partial-clone object-read avoidance. POSIX quoting is actually executed as
  literal text; PowerShell is covered by mixed-path/string fixtures, NOT a live Windows run.
- Two controller + two uploader + one model + one UI regression and strengthened actual Host/RPC/
  Azurite cases verify no auth/Agent/permission mutation, sanitized cloud/catalog metadata, and old
  opt-out authority. Browser dependency graph includes ONLY the two pure Git modules, never the
  Node probe. Actual deployed GUI/live Azure/Windows/RBAC/billing evidence remains deferred.

Parent owns fresh independent GPT xhigh (`55ccdc88-bf8e-47d0-918f-ddfea1b94c2e`) + Grok xhigh
(`959605ea-e61f-4024-84dc-6b7a0ea74ede`) reviews; both received the exact frozen checkpoint.
That T8 prerequisite was satisfied by BOTH final approvals; T9 is now DONE/BOTH approved and parent verified (current checkpoint at top).
No goal state, original checkout, commits, reset, checkout, push or handoff was changed.

## Previous checkpoint — T5 implemented and reviewed

The original blocker list below is retained as the review checklist, not a description of the
current code. This continuation replaces count-only reconciliation with verified canonical-prefix
classification; wires cold/live catch-up, secure conflict actions and startup polling; adds
resumable root-first deletion with conditional generation cleanup and explicit resurrection; and
bounds/cancels refresh lifetimes. New acceptance uses real AgentLoop/WorkingDirectoryService,
two independent durable JSONL/domain stores, recreated-host catch-up, and real Azurite races.

T5 is **approved by the required reviewers** at the final frozen checkpoint:
- `github-copilot/gpt-6.1-sol` (`xhigh`): **APPROVE**, including independent real AgentLoop
  adversarial probes and a final 138-test rerun.
- `github-copilot/grok-4.7` (`xhigh`): **APPROVE**, including the final permission-stop delta.

The user explicitly revised the gate on 2026-10-19: **GPT and Grok are sufficient; do not ask
Gemini for approval again.** The pending Gemini review was interrupted and is not required.
Historical three-reviewer instructions below describe prior rounds, not the current gate.
If disagreeing with a future review finding, stop and ask the user.

All ten accepted findings were fixed: retained disabled re-enable, terminal admission bypass,
late cancellation/lease leaks, auth-bootstrap fail-open, resurrection checkpoint crashes,
invalid candidate metadata, retryable catch-up starvation, startup repair isolation,
resurrection façade restrictions, and old-detach/corruption recovery admission bypass.
The durable `admissionStopped` marker now gates every stopped recovery outcome; new resurrection
revokes old detach permission, and only a newer explicit off/detach or successful verified recovery
clears it. Real AgentLoop generation/corruption regressions pass.

Final verification passes **307 unit/acceptance tests + 4 real-Azurite tests + 14 tooling tests**,
source/test typechecking, credential checks, package checks (91 files / 406,993 bytes), and
whitespace checks. T6–T9 have not been started; T6 is the next implementation task.

Important evidence boundaries:
- Two-store cloud/lease transports are conditional in-memory adapters; deletion/ETag/transaction
  acceptance separately uses a real local Azurite process.
- Cold warming uses real projection folds via the public registry and a test cache port; it does
  not claim an installed persistent cache service exists in this host build.
- Direct stale-Agent input is rejected/requeued exactly once. Clean native AgentLoop disposal
  records its own queued-input cancellation; durable input history/receipt and conflict survive,
  not a claim that a pending inbox survives native disposal.
- Explicit deleted→new-generation re-upload may establish a freshly canonicalized header/genesis;
  retained disabled history and canonical imported prefixes within a generation remain untouched.
- Blob/Table have no cross-service transaction: an already-accepted old candidate PUT can appear
  after a completed listing. Retry removal collects visible orphans; stale cleanup cannot damage
  a new generation. No claim of zero possible late orphan objects is made.
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
| T5 | **Approved — GPT + Grok** | Ten findings fixed; 307 tests + 4 Azurite + 14 tooling pass; current two-reviewer gate satisfied |
| T6 | **Implemented / both approved** | Fourteen findings fixed; 748 unit/acceptance + 9 real-Azurite + 14 tooling pass; final GPT + Grok APPROVE |
| T7 | **Approved — GPT + Grok** | Blank visibility fix accepted; exact frozen 878 unit/acceptance + 9 real-Azurite + 15 tooling; 102 files / 643,073 bytes; BOTH final approvals |
| T8 | **Approved — GPT + Grok** | Both URL privacy fixes closed; exact frozen 902 unit/acceptance + 9 Azurite/runtime + 15 tooling; 108 files / 680,104 bytes |
| T9 | **DONE — GPT + Grok FINAL APPROVE; parent verified** | Exact930unit+10integration+smoke1; fullrootgreen,15tooling,108files/714,510bytes;16manualitems explicitly deferred, not passes |

T4 approval is recorded by all three reviewers in the session. The real
`AgentLoop`/`WorkingDirectoryService` fixture was **explicitly waived by the user for T4 only**;
real JSONL import/create/append/flush/provenance is covered instead. The waiver does **not** apply
to T5's retained-live/Azurite acceptance requirements.

Historical T5 gate note: T5 passed the user-revised GPT + Grok review gate. Its then-unstarted T6 status is superseded: T1–T8 are now approved and T9 is implemented/automated-green, BOTH finally approved and parent verified. Do not request Gemini again.

## 3. Current verification quick start — existing isolated checkout

Requirements: Node `>=22.19.0`, pnpm `11.7.0`, Git and tar. Use the existing isolated checkout;
preserve all uncommitted changes. Do NOT fetch/switch/reset/commit/push/handoff as part of this task.

```bash
pwd
pnpm --config.ignore-scripts=true install --frozen-lockfile --ignore-scripts
```

Package verification:

```bash
pnpm --filter @1yefuwang1/dsh-azure-sync run verify
```

That runs `check:secrets`, typecheck, the unit suite, real local Azurite, and pack verification.
The CURRENT final T9 automated verification is **930 unit/acceptance + 10 integration + 1 extracted-tarball
smoke**, **108 files / 714,510 bytes**; both full root and Azure verify exit 0 in the exact logs at the top.
All root leaf tests/integrations/types/packs and15 tooling pass; no failure/skip was waived. Final T9
independent GPT + Grok FINAL APPROVE and parent verification are now recorded above, not merely inferred from tests.
Historical T5 reproduction evidence is preserved: **307 unit/acceptance + 4 Azurite + 14 tooling**,
**91 files / 406,993 bytes**. Those are NOT the latest totals.

Useful focused commands:

```bash
pnpm --filter @1yefuwang1/dsh-azure-sync run check
pnpm --filter @1yefuwang1/dsh-azure-sync run test
pnpm --filter @1yefuwang1/dsh-azure-sync run test:azurite
pnpm --filter @1yefuwang1/dsh-azure-sync run test:pack
```

Root `pnpm run verify` includes every leaf, including Worktrees. Its `Local different clean branch
switches safely...` test was historically flaky, but BOTH current full-root T9 runs passed without a
waiver. Full-root verification is required for this final gate; an Azure-only pass is not a substitute.

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
      reconciler.ts          verified canonical-prefix classification/localization
      live-guard.ts          runtime live/cold policy (restart-only live catch-up)
      tombstone.ts           durable tombstone/new-generation primitives
      cleanup.ts             exact generation/key/blob validation
      tombstone-manager.ts   resumable root-first removal/resurrection
      conflict.ts            secure local JSONL export/action dispatch
      poller.ts              cancellable bounded refresh/backoff/auth-stop
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

## 6. HISTORICAL T5 original REVISE checklist — resolved, NOT current work

Everything in this section records the former T5 review/reproduction trail. T5–T8 are now approved;
T9 is implemented and fully automated-green, BOTH finally approved and parent verified. Do not treat old blockers,
future-tense implementation steps, or old test counts here as active status.

All three reviewers returned REVISE on the prior T5 core. The following describes that prior
checkpoint and is retained to check the replacement implementation and acceptance evidence.

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

## 7. HISTORICAL T5 implementation order — superseded, do NOT execute

This old work list/model list preserves provenance only. Current task status is the T9 checkpoint at
the top; GPT + Grok are the only current reviewers and Gemini must not be requested.

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
- Historical T4-only waiver did not apply to later tasks: T5/T7/T9 now exercise actual public
  AgentLoop/WorkingDirectoryService, JSONL and local domain fixtures. Deployed GUI/Windows and the
  optional persistent projection-cache service remain distinct manual/unsupported boundaries.
- Historical T5 limitation (RESOLVED in T6–T7): commands/RPC/settings/browser UI did not exist then.
  They are now implemented and covered by the current 930+10+smoke automated checkpoint. Actual
  deployed GUI installation/use is still deferred; do not confuse implemented code with deployment.

## 9. CURRENT status — T1–T9 DONE, BOTH approved, parent verified

Keep source, tests and packaged documentation frozen at930+10+smoke1 /108files714,510bytes.
Both full-root/leaf pipelines, both final reviews and parent independent verification are complete.
Only the parent performs persisted-goal closure after the final repository-document audit/readback;
this subagent does not mutate goal state. No deployment, publication, commit, reset, switch or handoff
is authorized or performed by this completion. The implemented code objective is achieved under DoD.
Manual GUI/Windows/live Azure/RBAC/private DNS/TLS/billing remain explicitly deferred.

### HISTORICAL T6→T7 handoff — superseded, NOT current instructions

At that checkpoint the instruction was to implement T7 next. Final T6 approval was received from BOTH existing reviewers
`ba5d7df1-f968-4afc-b6b7-23aaa0a6d828` (GPT xhigh; independent 434 tests) and
`fa47b40a-745f-4468-a1e7-441368a960ea` (Grok xhigh) on the exact 748-test checkpoint.
Both are inactive; do not request another T6 approval unless T7 changes invalidate that checkpoint.
Review T7 with GPT + Grok, then continue T8 and T9 without another human continue prompt. Fix accepted
findings until both approve; stop/ask only if disagreeing. The persisted full-plan goal remains active.
Do not request Gemini approval. Preserve all T5/T6 safety and disclosed evidence boundaries.

T6 source is frozen; all implementation agents are inactive. Existing files are uncommitted in this
isolated checkout; preserve them and do not reset/recreate the worktree. Remaining implementation is
client UI/composer blocks/build (T7), read-only Git metadata/guidance (T8), and final docs/integration/
acceptance/cost evidence (T9). Optional live Azure/manual-platform evidence must be explicitly deferred
when unavailable rather than falsely claimed. No replacement GUI server has been started.
