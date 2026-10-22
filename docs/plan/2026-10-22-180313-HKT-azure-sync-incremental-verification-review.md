# Incremental cloud-history verification — plan review ledger

Recorded: 2026-10-22, Asia/Hong_Kong.

This ledger records reviews of the [written plan](<2026-10-22-180313-HKT-azure-sync-incremental-verification.md>).
It is not implementation acceptance, a live Azure bill, permission to execute the work, or permission to
commit/push/deploy. The plan stays byte-for-byte unchanged while a review round is in progress.

## Approval rule

Both independent reviewers must explicitly **APPROVE the same content revision and SHA-256**, with no
outstanding required amendments. Conditional approvals do not satisfy this rule. Any plan edit requires
a new revision/digest and review by both models. Final approval is recorded here rather than changing
the already-reviewed plan's bytes.

| Reviewer | Route | Effort | Continuable review session |
| --- | --- | --- | --- |
| GPT | `github-copilot/gpt-6.1-sol` | `xhigh` | `807fd6c4-9399-4f68-90ef-40eb10b49407` |
| Grok | `github-copilot/grok-4.7` | `xhigh` | `d98ffae7-09c7-4c61-95fa-3dc10c645cf9` |

## Pre-document review (conversation proposal; not a written-plan approval)

Both models returned **APPROVE WITH REQUIRED AMENDMENTS**. The substantive requirements carried into R1:

- Separate observation from materialization so payload eviction cannot restart whole-history idle downloads.
- Keep cloud serve eligibility/current metadata separate from immutable bytes; revalidate after awaits,
  return a consistent manifest/events pair and treat normal movement as bounded retry rather than corruption.
- Define complete anchored suffix/junction/empty/tip verification instead of stopping on a cached row key.
- Preserve durable rollback floors independently of evictable payload and recompute canonical restart trust.
- Inject one runtime-scoped component while retaining per-caller import cancellation, read policy and
  subscriber semantics; do not cache raw cleanup/resurrection repository listings.
- Publish immutable complete prefixes atomically; never serve a holey/partial prefix or seed from a sliced view.
- Count actual history GET/HEAD and response bytes, cover over-budget fixtures, and qualify cold/recovery
  promises without removing existing size/provenance/ownership checks.

The parent also ran a small pure in-memory selector probe. It confirmed that the current index selector
alone does not check all declared head/batch-count/blob-tip fields; this is not a claim that every caller
omits them. R1 requires consistent cache admission and preserves normal-concurrency retry handling.

## Written-plan round 1

- Content revision: **R1**.
- SHA-256: `f307be03eb95fdb6f45dc00b9c41fcb4a879bf44e85a6c98151d7a96f5679892`.
- Source baseline: `8457104693a4728ec9f2341efbc2b10fe52c666a`.
- Local document check: 337 lines, 11 local links, no missing link targets.

| Reviewer | Verdict | Required findings |
| --- | --- | --- |
| GPT | **APPROVE WITH REQUIRED AMENDMENT**; earlier approval explicitly withdrawn | P1: distinguish accepted remote H from locally applied L; same-W observation must discover unapplied work even if cancellation prevented the pending marker. |
| Grok | **NOT APPROVED** | P1: stable payload namespace must exclude the moving watermark; scheduled effects must recheck H/rollback and live-Agent gates; data preparation needs an independently bounded lifetime rather than repeated five-second abort/restart. |

GPT initially approved R1, then explicitly withdrew that approval after the H-versus-L cancellation
counterexample. Both reviewers independently confirmed that the unchanged remote watermark must not hide
unapplied native history. R1 is **not approved** and is superseded by R2.

## Written-plan round 2

- Content revision: **R2**.
- SHA-256: `d58c3f689ed5f6735f4f6e4ef51ebcddb503a838257419231233253c572ca320`.
- Source baseline remains `8457104693a4728ec9f2341efbc2b10fe52c666a`.
- Local document check: 396 lines, 22 acceptance cases, valid local links, no trailing whitespace.

Amendments from round 1:

1. Separate local applied/verified L from accepted remote H; independently discover unfinished application
   even when W=H and no pending marker was recorded. Add A20 with cancellation, restart and preview/audit cases.
2. Keep moving tip fields out of batch-object namespace/key; extensions reuse existing immutable batches.
3. Scheduled effects recheck H and fresh W before any publisher/import action; a greater local count cannot
   authorize republishing a rolled-back cloud prefix. Keep the live-Agent catch-up refusal at execution time.
4. Distinguish proof wait-budget expiry from true cancellation. A pre-enrolled, independently guarded,
   data-only preparation owner can outlive the five-second waiter within its finite 120-second deadline;
   it grants no Native/write/model/input authority. Real cancellation and runtime/intent changes still fence IO.
5. Give real scheduled sync/catch-up work an independently bounded lifecycle rather than the poll tick's
   auto-aborted signal; preserve single-flight progress/backoff and existing effect checks. Add A21/A22.

| Reviewer | Verdict | Required findings |
| --- | --- | --- |
| GPT | **APPROVE R2 / exact digest above** | None. Independently read all 396 lines and verified the digest/source baseline; explicitly accepted H/L scheduling, stable keys and guarded preparation-owner lifetimes. |
| Grok | **APPROVE R2 / exact digest above** | None. Explicitly approved the 396-line R2 and exact digest; confirmed all R1 blockers closed. |

Grok offered two explicitly **optional, nonblocking** clarifications: mirror A21's true-cancellation rule
in the preparation-owner prose, and recognize an established matching legacy local checkpoint as L for
observation without treating it as canonical-byte proof. No edit was made to the approved plan for these
suggestions; the existing cancellation, honest observation and no-metadata-as-byte-proof contracts remain
mandatory. They do not create an outstanding required amendment or waive an implementation acceptance case.

## Final outcome

**Both independent reviewers explicitly APPROVED the same unchanged R2**, with no required amendments.

- Approved [plan](<2026-10-22-180313-HKT-azure-sync-incremental-verification.md>) content revision: **R2**.
- Approved SHA-256: `d58c3f689ed5f6735f4f6e4ef51ebcddb503a838257419231233253c572ca320`.
- The plan was not edited after either final R2 approval. This ledger alone records the approval status.
- R1 is not approved; its initially granted GPT approval was explicitly withdrawn, not carried forward.
- Scope: plan approval only, not approval or acceptance of future implementation.
- Documentation checks: valid UTF-8/local links/line anchors/whitespace, stable approved digest, exactly the
  plan and this ledger added; no source/runtime/profile changes. Repository credential audit passed over
  **350 Git-candidate files**, including these documents; no credentials detected.
- No implementation suites or live Azure billing tests were run for this documentation-only task. No
  installation, resource creation, deployment, commit or push was performed. Implementation awaits a
  separate explicit request and must satisfy O1–O6 and A1–A22 before its own final reviews.
