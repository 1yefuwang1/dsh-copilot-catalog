# Manifest-first, incremental cloud-history verification

Recorded: 2026-10-22 18:03:13, Asia/Hong_Kong. Content revision: **R2**.
Baseline: `8457104693a4728ec9f2341efbc2b10fe52c666a`.

**Planning only.** This document does not authorize implementation, installation, Azure resource creation,
profile changes, deployment, commit or push. Approval of this exact content revision is recorded separately
in the companion review ledger; a conditional review is not approval of a later revision.

## 1. Objective and scope

Replace repeated whole-history downloads with two distinct operations:

1. **Observe:** read fresh cloud control metadata and detect changes/rollback without materializing history.
2. **Materialize:** obtain and verify canonical history only when an operation actually needs its contents.

An idle, unchanged background observation must download **zero history bytes**, even when the payload
cache is cold, evicted, or smaller than the total tracked-history working set. A cache alone is not the fix.
A byte-requiring operation should fetch only missing committed batches when a valid prefix is available.

Preserve the current local-first v4 storage protocol, immutable candidate batches, original session IDs,
lineage/inherited cut, generation fencing, public SDK usage, and per-thread opt-in. Preserve mandatory
import guard/persistence gates, destination bindings/Ready, explicit Continue, pending-input acknowledgement,
code consent, forward-localization provenance and the refusal of automatic generation adoption. Cached
history is never permission to execute, publish, import effects or take over another device.

Non-goals: slower polling as a workaround; relaxed ownership/provenance checks; changed upload batching;
cloud-primary persistence; new Azure services; code/Git transfer; automatic family imports; new supported
platforms; unrelated SDK/core changes. Keep the five-minute default and existing public SDK/package caps.

The measured recent workload (~195 MB compressed canonical history across 53 active session records)
informs cache-pressure tests, not a fixed retention bound or a promised monthly bill. See the historical
[cost evidence](<../acceptance/azure-sync-cost.md>) and [optional-path supplement](<../acceptance/cloud-import-destination-cost.md>).

## 2. Confirmed current read paths

- [Reconciliation](<../../packages/azure-sync/src/sync/service.ts#L172-L238>) fetches a manifest, then always
  calls the full reader before comparing local/remote prefixes; pre-step admission calls reconciliation too.
- [Full reader](<../../packages/azure-sync/src/sync/remote-session.ts#L39-L74>) lists all batch rows and
  reads every selected Blob. Its captured manifest can become old across awaited work.
- [Imported upload canonicalization](<../../packages/azure-sync/src/sync/uploader.ts#L669-L685>) constructs
  another reader; [import repair](<../../packages/azure-sync/src/sync/importer.ts#L207-L220>) constructs a
  reader over operation-specific IO wrappers. The runtime owns a third reader.
- [Point batch reads](<../../packages/azure-sync/src/sync/cloud-repository.ts#L238-L242>) already exist;
  [committed rows](<../../packages/azure-sync/src/sync/committed-index.ts#L23-L81>) already link backward.
- [Blob reads](<../../packages/azure-sync/src/azure/blob.ts#L51-L73>) perform a size-check HEAD before GET.
  Do not delete that bound simply to make a request counter smaller.
- [Resurrection verification](<../../packages/azure-sync/src/sync/tombstone-manager.ts#L315-L330>) deliberately
  reads real cloud rows and checks complete tip fields. Cleanup/repair is not a cacheable observation.

## 3. Four kinds of state; do not conflate them

### 3.1 Fresh control envelope

A just-read, strictly decoded manifest plus its ETag, fresh root state where required, actual endpoint
namespace and the caller's operation context. Apply existing reader gates on every materializing read,
including cache hits: identity/partition/key, tombstone, enabled/disabled policy, expected generation,
header binding, inherited cut, supported schema/format, and expected root identity/generation.

Lease owner/expiry/epoch, enabled/state, Git observation, timestamps and ETag are not cached execution
proofs. Metadata-only changes must be returned from the newest eligible envelope without history IO.
An observation may report a disabled/deleted target; it cannot serve those bytes to an ordinary materializer.
The existing explicit retained-disabled repair policy is checked per caller, never inherited from a shared job.

### 3.2 History watermark W

Bind the actual storage namespace/partition, session/row identity, cloud schema and session format version,
generation, canonical header hash and inherited cut, root session/generation, event count, head sequence/hash,
chain hash, batch count, last batch generation/row/blob identity. Validate canonical header JSON against its
hash. The current source platform and mapping interpretation must also pass provenance checks when used.

ETag, lease fields, writer epoch, Git facts and update timestamps are not history identity. Historical batch
`createdEpoch` need not equal the current writer epoch. History remains valid through legitimate takeovers.

### 3.3 Accepted-history pin H (small, durable, not evictable with payload)

H records a complete accepted W, advanced only after full canonical verification or an exact confirmed
publication receipt. Keep H in a separate versioned, metadata-only local storage domain using public
storage-domain APIs and the existing one-Host-per-store contract. Do not alter the Azure schema or turn
this metadata into a second native session store. Serialize monotonic compare-and-update per scope/SID.

H is a change/rollback floor, **not proof that canonical bytes remain present or that execution is allowed**.
Never create H from local event count alone, an attempted upload, a catalog row, an arbitrary caller DTO,
a wizard's sliced view, or a persisted `verified:true` flag. Existing `lastSynced*` metadata is at most a
conservative legacy hint, not a canonical-byte witness. A legacy record with ambiguous account/scope
provenance requires explicit reconciliation before automatic write activation; do not invent its scope or
copy a pin into another account. Cold verification/local-prefix comparison must not silently reset a known
accepted floor. Preserve H through payload eviction/corruption and credential reload for the same namespace.

H is separate from **L**, the last confirmed locally applied/verified native checkpoint and durable
import/catch-up progress. L advances only through the existing successful local persistence, readback,
forward-provenance and checkpoint rules. A materializing read, preview or audit may advance H without
advancing L. Neither H equality nor a persisted L/count alone proves the current local bytes or permits
append; they are independent scheduling/recovery hints until guarded verification is performed.

If accepted 100 events become a fresh 50-event tip, or the same count has a different commitment, reject
rollback/fork instead of interpreting the missing old events as a new local suffix to republish. Missing or
malformed required pin metadata must not silently reset established provenance. New-generation activation
still requires the existing explicit resurrection/adoption contracts; a new cache slot grants nothing.

### 3.4 Verified history and disposable payload cache

A complete in-process verified prefix is based on exact canonical remote batch bytes and strict chain/index
validation, with its W. It is immutable; return frozen data or owned copies so localization/wizard slicing
cannot mutate cached arrays. The component, not arbitrary callers, owns prefix admission.

A private disk cache holds compressed batches plus a versioned prefix index. On reload, rehash canonical
payloads and recompute the event chain from the correct genesis; hashes/watermarks stored next to a file
are not its proof. Validate the complete stored-event contract with public validation APIs. Compare the
recomputed result against the freshly read manifest, or against a verified suffix that reaches that manifest.
A localized native JSONL file and `lastSynced*` alone must never seed canonical remote history.

An exception is an upload's **exact canonical batch bytes already validated by this operation**: they may
be admitted only after `commitBatch` returns an eligible receipt containing the exact committed row/tip,
matching payload and history identity. An immutable PUT success or uncommitted candidate is insufficient.

## 4. Observe-only background path (independent of payload-cache capacity)

Introduce a separate observation entry point; do not satisfy idle polling by asking for a full
`RemoteSession.events` object through a cache. The observation path:

1. Checks current local intent/cancellation and fetches fresh manifest/control/root metadata as required.
2. Handles disabled/deleted/missing/incompatible generation or root through existing stop/recovery behavior.
3. Compares W to H as a change/rollback hint, and **independently** compares the current remote target
   with L, durable recovery intent and fresh public local persistence metadata. W=H means no newly observed
   remote history, not that W was applied locally. If W is ahead of, incompatible with, or not known applied
   at L, schedule guarded reconciliation/catch-up even when W=H and no `catchUpPending` marker exists.
   Cancellation before that write-ahead marker must not lose unapplied work. A missing/unknown count uses
   the existing local read/recovery path. Pins/counts are scheduling hints, not permission to append or
   substitutes for canonical-prefix/provenance verification; never blindly append based only on L<W.
4. When remote history is unchanged, local application is established and no local publication/catch-up
   work is pending, performs **no** history Blob GET/HEAD, batch-row point walk or batch-index query.
   Payload eviction alone is not a reason to load, rebuild or download history in this idle path.
5. Preserves the last genuinely verified checkpoint. Do not newly stamp `lastSyncedAt`, clear conflict,
   degraded, import, mapping or catch-up state, declare local provenance reverified, or grant execution
   from watermark equality. A separate last-remote-check observation may be recorded/labeled honestly.
6. Detects local dirty work using lifecycle notifications plus fresh public persistence metadata. Event
   count can be absent: fall back to a local durable read when needed, not an Azure history download just
   to check dirtiness. Startup/missed notifications and a local suffix must still schedule the guarded
   byte-requiring sync path. Same-count local mutation is caught before a write by full local/provenance
   verification; observation alone must not clear a previously detected problem.
7. Schedules materialization for actual remote advance/catch-up, local dirty upload/drain, or explicitly
   requested bootstrap/recovery. Unknown pins mean unverified/change-unknown, not synced. Failed bootstrap
   uses bounded retries/backoff and preserves its error; do not turn each idle poll into a full bootstrap.

Before any scheduled local-ahead upload or catch-up/import effect, the worker loads H and a fresh eligible
manifest again. A shorter W than H, or a same-count fork, takes the existing conflict path: do not call the
suffix publisher, erase H, or treat a greater local count as permission to republish the old cloud suffix.
Preserve `decideLiveCatchup` at execution time, not only at scheduling: a live Agent becomes
`remote-ahead-live` and is not appended into. Use existing error/recovery categories, not a new terminal
status. Read-only preview/audit must never advance L or stamp local sync completion.

Registration of actual sync/catch-up work creates a separately guarded service job; do not hand it the
poll tick's signal, which is aborted when a tick completes or times out. Section 6 defines its bounded
lifetime and intent/runtime cancellation. An already registered worker must not be restarted from zero
by every subsequent observation; preserve single-flight progress, errors and backoff.

A post-upgrade cold read may be needed when contents are first required. Merely polling unchanged metadata
does not need to download all opted-in histories at startup. Keep local/browser STATUS calls local-only.

## 5. Materialization and strict incremental verification

### 5.1 API and freshness boundary

The materialization entry point accepts SID and a guarded operation context, not a caller-supplied trusted
manifest. It obtains its own fresh envelope; an earlier observation is only a hint. The caller context
carries cancellation and authority-check hooks plus expected scope/generation/root/read policy. These hooks
are invoked before starting every next raw cloud or disk IO and after awaits. Do not replace captured
importer IO guards with only an outer `Promise.race`.

An in-process byte hit is legal only after fresh gates pass and W equals the prefix this process actually
verified. Disk rehydration and suffix fetching are awaited work: re-read eligible cloud control/root state
before publishing/returning an active verified prefix. Return fresh manifest/ETag/Git metadata together with
exactly the events for that same W; never splice newer counts onto older events or replay a cached envelope.

If only ETag/lease/Git metadata changed, reuse bytes and attach the newest eligible envelope. If history
advanced, boundedly extend/retry (at most three restarts within the operation deadline). Normal advancement
is transient contention, not `CORRUPT_REMOTE`, `COMMITTED_INDEX_CORRUPT` or fork. On exhaustion report an
existing transient/retry outcome; do not terminalize or discard the last good prefix. Deletion, disabled
read eligibility, incompatible identity and genuine same-generation rollback/fork remain fail-closed.

This final observation is the read's freshness boundary, not a distributed transaction with future effects.
Consumers that await more work must retain/recheck their own reservation/intent/provenance authority before
checkpoint, Native, Ready or write effects. Each model step still obtains its separate fresh server-side
lease/epoch proof; no cached envelope, TTL, H, prefix, or disk receipt substitutes for it.

### 5.2 Exact prefix anchor and suffix walk

A prefix anchor includes W, its exact boundary row key, end sequence/count, head/chain, and cumulative batch
count, derived from canonical bytes verified in this process. Walk backward from the fresh committed tip
with point `getBatch` calls, following only chosen previous-row links. Do not scan unlinked siblings or
use `listBatchRows` on a warm extension.

For every fetched row, verify requested key equals returned key; correct partition/session/generation and
canonical row key; bounded integer fields; nonempty valid range/count; no cycle; exact previous-row link;
sequence contiguity; and `prevChainHash` continuity. Stop only at the exact boundary key **and** commitment,
with the first new row starting at the next sequence and referencing the accepted boundary. A matching
row key alone, chain hash alone, or an interior cached row past a hole is insufficient.

Fetch each missing batch with existing compressed-size and expansion bounds. Verify raw payload hash,
canonical event payload, recomputed per-event chain/head, sequence/count and stored-event validity. The
assembled prefix must match manifest event count, head sequence/hash, chain, batch count, tip generation,
row and blob pointer. Empty history must match genesis, zero batches and absent tip fields. Apply these
checks in cold, extension and zero-suffix/cache-hit cases. The current index helper omits some final fields;
reuse the complete activation checks where useful rather than assuming the old helper already checks them.

Strict cache admission does not introduce a new terminal status. Re-read when a mismatch can be a moving
tip; only a stable malformed committed history takes the existing corruption/recovery path. Valid existing
v4 writer output remains compatible. Correct malformed test fixtures instead of weakening the contract.

Cold reconstruction follows the same chosen-chain rules from genesis, with existing bounded index/query
mechanics or point walking as appropriate; it is an explicit cold path, not a warm fallback scan. Enforce
max events/batch bounds, safe counts, visited-row/traversal limits and the caller deadline before unbounded
work. Partial downloads are not a published prefix. Preserve the previous good prefix if extension fails.

## 6. Component lifetime, cancellation and cache publication

Create one history component beside the repository in runtime boot. Inject it into service, uploader,
importer and destination coordinator; remove private reader constructions. Stop/invalidate it with the
existing runtime `setupEpoch`/credential/account teardown. In-memory state is not process-global.

Namespace payload objects, prefix indexes and H using actual SDK Blob/Table endpoint origins and paths,
container, table, partition, SID and generation. Bind stable schema/format version, header hash, inherited
cut and expected root identity/generation as well. **Do not include moving tip fields** (event count,
head sequence/hash, chain hash, batch count, last-batch identity), ETag, lease or Git metadata in the object
namespace/key. Those belong in H and the prefix index so a strict extension can reuse older batch objects.
Within that stable namespace, address each batch by its immutable Blob identity and full expected payload
hash; always validate the caller's row commitment/limits. Strip query/userinfo; never store connection
strings, keys, SAS tokens or credential values in keys, filenames or logs. An auth refresh at the same
actual namespace can reuse validated content after fresh eligibility checks, never old execution authority.

Coalesce immutable byte fetches with subscriber/refcount ownership; one caller cannot cancel another.
Cancellation releases that caller promptly even if transport ignores abort. With no valid waiter **or
explicitly enrolled preparation owner**, abort transport where supported and begin no further row/blob/disk
work. Off/detach or runtime revocation fences active prefix/checkpoint publication. Already-running immutable
byte IO may finish into a content-only/quarantine store in a still-valid namespace; it cannot gain prefix,
Ready or permission authority from a canceled waiter. A valid second owner must pass its own gates and
publish under its own fresh context. Mixed ordinary versus retained-disabled readers do not share eligibility.

Distinguish an internal **proof wait-budget expiry** from explicit caller/operation cancellation. An eligible
byte-requiring pre-step can enroll a data-only preparation owner under the current durable enabled intent,
expected namespace/generation and runtime epoch **before** starting work. This is an explicit service-owned
single flight, not a subscription invented after cancellation and not something an idle observation starts
because payloads were evicted. Its own finite preparation deadline defaults to **120 seconds**; it continuously
checks current read eligibility, local intent and runtime revocation before further IO/prefix/H publication.

The existing five-second `ownershipProofMs` deadline still makes that pre-step return ownership-unverified
and admit no model step. That internal timeout detaches its waiter, not the independently valid preparation
owner, so a slow disk rehash/suffix verification can finish and a later request can memory-hit. Do not raise
the proof deadline, reuse its old lease proof, automatically resubmit input, or execute a step when preparation
finishes. Each later admission still gets a new server lease/epoch proof. Retained bytes here mean canonical
payloads in memory or on disk, not H, L or `lastSynced*`.

Explicit import/audit/request cancellation with no independent valid owner must still stop next IO as in the
existing cancellation tests; a canceled ad-hoc reader cannot manufacture an enabled background owner. An
Off/detach, changed expected generation/account/intent, or runtime teardown cancels preparation owners too.
A service worker scheduled for real catch-up/local dirty publication likewise has an independent bounded
120-second lifetime, not the poll tick's auto-aborted signal, and retains existing guarded Native/write
checks throughout. Only the data-preparation owner is read-only; it cannot append Native history, set L or
Ready, acquire a writer lease or consume input. Never detach Native/write effects from their own authority.

Keep completed hash-checked chunks only as content-only recovery data until the whole prefix is verified.
On finite job failure/deadline use bounded retry/backoff and preserve progress; do not start fresh full-history
jobs on each idle tick or each pre-step. Cache pressure uses section 7 rather than an unbounded rehydration
loop. All owners/jobs are runtime-tracked and canceled/settled on teardown; this is not an always-running watcher.

Write batch objects before their disk prefix index; publish that index atomically, and swap the in-process
immutable prefix only after complete verification and guarded monotonic H update. Recovery must tolerate
crashes at either boundary: no index/file presence or H equality alone is a verified-byte receipt. A stale
runtime/completion cannot overwrite a newer prefix/H. Failed/canceled extension keeps the last good one.

Do not place the cache below the generic repository/blob/table adapters. Raw listing/cleanup/resurrection
verification must keep seeing Azure, not cached rows or a cached empty generation. Wizard reviewed/sliced
snapshots are views and must not be written back as complete cloud prefixes.

## 7. Storage, eviction, limits and recovery

Proposed defaults: **128 MiB retained in-memory payload weight** (canonical serialized-byte accounting),
**512 MiB compressed disk payloads**, at most **two concurrent materializations**, and at most **four cloud
payload fetches** concurrently. Metadata/pins have separate per-record bounds. These are cache-retention
budgets, not claims that JavaScript heap or a caller-owned full snapshot uses only that much memory. Keep
existing event/batch/expansion caps and report actual peak memory in large-fixture verification. Do not
silently increase proof deadlines or payload limits to hide a regression.

Use a private user-data directory, not the repository or a world-readable temporary directory. Require
owner-only directories/files where supported (POSIX 0700/0600), safe bounded names, atomic index replacement,
and no symlink/path-escape acceptance. Preserve existing platform admission rules; an unsupported private
persistent-cache backend must disable that optimization honestly rather than weaken import gates or claim
a healthy disk-cache restart. H durability uses the public metadata facility, not disposable cache files.

Evict whole complete session/generation payload prefixes in the first implementation, or demote payload
availability atomically before removing objects. Never advertise a holey prefix as complete. Memory eviction
loads retained disk data, not Azure. Disk eviction never removes H, native logs, mappings, destination
journals, opt-in or cloud objects. Pin an in-flight prefix against eviction while a valid caller needs it;
keep a running writer/drain's needed working set stable rather than oscillating it between steps.

If an active working set cannot fit a hard budget, queue within the deadline or return an actionable local
cache-pressure/limit outcome before a repeated re-download loop; do not repeatedly spend full-history
bandwidth on every pre-step. An explicit retry, capacity change or available space can retry recovery.
Do not hold/renew a cloud lease merely to keep a cache entry resident.

On disk reload, recompute genesis-to-boundary canonical validity. Corrupt/missing chunks can be repaired
individually only when the retained/recomputed lower prefix and new verified links prove the result;
otherwise perform one guarded cold reconstruction of the expected generation. Do not erase H or adopt a
replacement generation to recover a cache. A mapping change invalidates localized proof/consent, not
canonical remote bytes, and never permits reverse-mapping guessed canonical history from imported logs.

## 8. Explicit audit and intentional assurance tradeoff

Provide an explicit **Verify cloud copy** operation through the existing validated control surfaces. It is
read-only, creates no Agent/model prompt or writer lease, does not opt in or grant Continue, and requires
normal authenticated read authority and per-operation cancellation. It bypasses both payload cache and
cached index proofs, reads the real committed chain and objects, and reports the exact audited watermark.
If the tip moves, boundedly retry or report the verified cutoff as not current; do not pair old bytes with a
newer tip or loop forever. Show that it downloads retained history; never call it implicitly from polling,
reconcile, pre-step admission or cache-pressure handling.

Normal hits prove retained canonical bytes match a fresh eligible manifest commitment. They do not prove
already-cached Azure blobs still exist or remain undamaged. Audit checks actual remote health. A detected
remote integrity failure is not cleared by a later cache hit; preserve the existing error/recovery state
until explicitly reconciled. Hashes still do not defend against a malicious authorized cloud writer.

Candidate-orphan recovery, conditional PUT-exists verification and cleanup may legitimately LIST/HEAD/GET.
Keep their integrity fences and count them separately from committed-history steady state. Reusing an
operation-local verified candidate can be a follow-up; a staged candidate is never a confirmed prefix.

## 9. Implementation work packages (after separate implementation approval)

| ID | Work and completion requirement |
| --- | --- |
| O1 | Add observation/materialization interfaces, stable object namespace, distinct W/H/L semantics and durable monotonic metadata-only pins; write legacy/bootstrap/rollback/unapplied-target tests first. |
| O2 | Implement bounded private payload storage, restart recomputation, atomic immutable publication, cancellation/subscriber and eviction/pressure rules. No native/cloud authority in cache receipts. |
| O3 | Implement strict anchored suffix verification with point reads and complete cold/empty/tip checks; preserve the last good prefix on races/failures. |
| O4 | Split background observation from materialization; preserve H-versus-L catch-up, dirty/startup publication, live-Agent refusal and honest checkpoints. Add explicitly owned bounded preparation/work lifetimes independent of proof wait and poll tick expiry; route all consumers through the shared component without detaching write authority. |
| O5 | Add explicit cache-bypassing audit and scoped status/error handling; ensure raw cleanup/resurrection paths remain uncached. Document cache locations, limits, data privacy and assurance changes. |
| O6 | Extend real HTTP byte/request metering; run the acceptance matrix, whole repository verification and extracted-package/runtime/type/size/security checks. Update cost evidence with measured results, not a live-bill claim. |

Keep existing tests/acceptance constraints unless an assertion explicitly encoded the old wasteful read
count; replace those with stronger byte/freshness assertions, not weaker safety behavior. Use public SDK
APIs; no SDK patch or package-cap increase. After all implementation tasks, run independent final reviews
rather than per-task panels, address findings, and recalculate the user's workload model. This document's
panel approval does not substitute for implementation review, authorize a push or prove live Azure billing.

## 10. Acceptance matrix

All network expectations refer to actual SDK HTTP attempts through the production component. Zero-history
expectations exclude the separate lease object and are not satisfied by omitting size checks on new blobs.

| ID | Scenario | Required behavior |
| --- | --- | --- |
| A1 | Repeated idle observations, unchanged remote and no local dirty work | O(1) control reads per tracked record; zero history GET/HEAD/bytes, batch point walks and index queries. |
| A2 | A1 with cold/evicted payloads and many histories above both cache budgets | Same zero-history behavior; no LRU-triggered hydration and no new `lastSyncedAt`/provenance/Ready claim. |
| A3 | Local suffix while remote W is unchanged; missed notifications/restart; stat without count | Schedule guarded sync and publish actual new events; do not lose poll-driven local publication. |
| A4 | Lease-only/Git-only ETag drift | No history download; use current control/Git metadata for materializing consumers and code-review gates. |
| A5 | Tombstone/disable with unchanged W; ordinary and retained-disabled callers | Existing read policy enforced per caller before a hit; no stale active state, forced ownership or unwanted repair. |
| A6 | Warm extension of K new batches | K selected new-row point reads and only missing new content; no full index scan or old content GET/HEAD, excluding bounded retries. Keep at most one ordinary size-check HEAD per uncached small blob; meter real retry/range splitting. |
| A7 | Cold/zero-suffix/empty/extension corruption matrix | Wrong key/partition/scope, boundary row/hash, gaps/overlaps/cycles, counts/head/tip/blob mismatch rejected; no partial replacement. |
| A8 | Manifest advances during delayed disk/suffix work | Consistent snapshot/envelope pair or bounded transient retry, never permanent corruption caused solely by normal movement. |
| A9 | Off/delete/resurrection/root/account change during IO or checkpoint | No stale prefix/H/checkpoint/Ready/admission publication; no automatic new-generation adoption. |
| A10 | Accepted 100 -> payload evicted -> cloud 50 or same-count fork | Retained rollback floor rejects; do not reupload old suffix or erase H. Include restart and late older-runtime completion. |
| A11 | Restart with intact canonical disk cache; corrupted file and updated sidecar | Recompute against fresh commitment; intact cache uses zero history IO, forged sidecar cannot make corrupt bytes valid. |
| A12 | Missing/interior chunk, partial index/crash, over-budget active materialization | No false complete prefix; last good snapshot preserved; bounded repair/pressure outcome without recurring idle/step full downloads. |
| A13 | Native and imported memory-warm pre-step, upload and drain | Shared production component, fresh server lease proof and fresh local/provenance gates, zero unchanged history bytes. Disk-retained preparation/deadline behavior is covered by A21. |
| A14 | Canceled importer plus valid reader sharing one fetch; sole explicitly canceled reader | Prompt per-caller cancellation, valid waiter unaffected, no next raw IO after last valid waiter/preparation owner, no canceled active checkpoint. |
| A15 | Exact local upload receipt; orphan/adopted candidate; wizard sliced view | Seed only exact committed canonical bytes; never promote an uncommitted candidate or partial view. Meter recovery separately. |
| A16 | Mapping or source Git/code changes; fresh Host process | No bypass of forward provenance, code acknowledgement, mandatory guard/persistence, bindings/Ready or explicit process-local Continue. |
| A17 | Audit after payload/index cache warm; remote blob removed/altered | Fetch actual cloud rows/objects; detect damage; no later hit silently clears failure; report exact cutoff and no execution effects. |
| A18 | Warm cache during cleanup/resurrection verification | Real cloud listings remain visible; no cached empty rows or old generation used as sweep completion. |
| A19 | Namespace/privacy/package/limits | Distinct actual accounts/partitions isolate data; moving tips reuse old batch objects within stable identity; no query/token/userinfo/credential leakage; private safe files, bounded traversal/decompression, SDK/public-archive/type/security/byte caps intact. |
| A20 | H advances to 100, L stays 50, cancel/fail before `catchUpPending`; next W still 100 | Same-W observation schedules guarded reconciliation despite the absent marker; cold catch-up succeeds or honestly retains live/error/recovery block. Repeat after restart and preview/audit; Off/detach stays stopped. Once L reaches 100, unchanged idle observations do zero history IO. |
| A21 | Sole pre-step waits on disk revalidation longer than five seconds but within preparation budget | Step returns ownership-unverified with no model execution; a pre-enrolled valid data-only owner completes verification without repeated restart. Later admission memory-hits and obtains a new lease proof. True sole-request cancellation still stops IO; Off/runtime change cancels every owner. |
| A22 | Poll completes/times out after registering real catch-up/dirty work | Independently owned bounded worker retains progress/backoff rather than inheriting the tick's abort or spawning duplicate full reads; effects still recheck H/W, current intent and live Agent. Off/disposal cancels it and prevents late Native/write/checkpoint effects. |

Extend the [HTTP meter](<../../packages/azure-sync/test/cost-profile.test.ts#L61-L94>) with streamed response
body bytes and distinct history GET, history HEAD, Table point/query, lease and other categories. Count
failed attempts, pagination, retries and ranges without double-counting subset counters. Never record
URLs, headers, bodies, conversation text or credentials. Add small deterministic race fixtures plus
multi-session large synthetic fixtures around the selected cache budgets; do not upload real user logs.

Report cold/warm/over-budget/bootstrap/audit vectors separately, actual transferred history versus control
bytes, and local disk/CPU/peak-memory effects. O(1) means cloud observation IO, not local proof CPU or full
snapshot memory. Re-estimate one/two-device costs using current regional rates and a shared remaining
egress allowance. Do not claim a blanket sub-dollar bill or live billing evidence.

## 11. Plan review and completion protocol

The required plan reviewers are `github-copilot/gpt-6.1-sol` at `xhigh` and
`github-copilot/grok-4.7` at `xhigh`, working independently and read-only. For each round, record content
revision and SHA-256, each verdict and actionable findings in a separate companion review ledger. Revise
this document for accepted findings, increment R, and send the exact new content/digest to both reviewers.

Completion requires both reviewers to explicitly **APPROVE the same unchanged content revision/digest**
with no outstanding required amendments. Optional suggestions may remain only if explicitly nonblocking.
Never carry approval forward across edits, count a conditional verdict as full approval, or edit plan
content after final approvals just to change its status. Record approval and the stable plan digest in the
separate ledger, verify documentation-only changes, and stop before implementation.
