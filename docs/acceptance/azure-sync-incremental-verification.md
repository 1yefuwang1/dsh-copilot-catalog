# Incremental cloud-history verification — implementation and cost evidence

Recorded: 2026-10-22 (Asia/Hong_Kong). **O1–O6 and accepted corrections complete. Final root verification
and extracted archive/runtime/strict-type gates passed; both independent implementation reviews APPROVE
the same frozen candidate.** This is source/emulator evidence, not deployment, a live invoice or a spending cap.

The user authorized implementation of the [approved R2 plan](<../plan/2026-10-22-180313-HKT-azure-sync-incremental-verification.md>)
after both [plan reviews](<../plan/2026-10-22-180313-HKT-azure-sync-incremental-verification-review.md>) approved
SHA-256 `d58c3f689ed5f6735f4f6e4ef51ebcddb503a838257419231233253c572ca320`.
That plan remains unchanged; implementation approval is a separate gate. Source baseline is `8457104`.

## Implemented contracts

- Observation is fresh metadata/control only. Unchanged applied histories do not hydrate payloads merely
  because memory/disk retention is zero or the enabled working set exceeds both budgets. Native L and
  accepted remote H are independent; W=H cannot hide unapplied/canceled catch-up.
- One runtime-owned canonical reader is injected into upload/import/pre-step/drain/destination paths.
  Stable endpoint/container/Table/partition/SID/generation/header namespace excludes moving tips and secrets.
- Authoritative public storage-domain pins retain monotonic rollback knowledge outside disposable cache.
  Strict chosen tip/previous-row verification checks exact boundary, sequence, hashes, count and complete
  empty/head/batch/tip/blob fields. Disk restart recomputes canonical bytes against fresh cloud commitment.
- Local metadata v5 accepts v4. Publication consent is explicitly bound to actual storage scope; older
  ambiguous records/new accounts require explicit On/Sync, never a readonly H/audit shortcut. Scoped L is
  reject-only floor information if required H metadata is missing; it is not a canonical-byte witness.
- Five-second proof waiting and finite 120-second data preparation are distinct. Only pre-enrolled eligible
  owners survive an internal wait-budget expiry. Explicit cancellation, intent/account/runtime revocation
  and teardown remain fences; jobs cannot invent Native/Ready/lease/input authority. Actual sync/catch-up
  owns bounded guarded work rather than borrowing an auto-aborted poll tick.
- Memory retention defaults to128 MiB serialized weight; disk to512 MiB compressed data, with2 materializations
  and4 actual payload transports. Pressure reports a limit instead of recurring full downloads. Private
  Linux descriptor-anchored cache rejects aliases/hardlinks/unsafe paths; persistent caching requires
  `/proc/self/fd`. Other platforms retain memory/pins/safety without a persistent-cache guarantee.
- Explicit **Verify cloud copy** / `/cloud verify [session-id]` audits actual committed history/index, not
  attachments. It does not enable/import, allocate an Agent, lease a writer or grant Continue. Tracked audit
  scope/generation remains bound; unknown/untracked reads confer no publication consent.
- Scoped remote-health failures persist even for untracked preview-only data and across component/pin
  restart. Healthy cached bytes cannot clear them. A successful raw audit clears only its observed matching
  namespace/revision; an older concurrent successful read cannot erase a newer failure. Local health markers
  preserve protected conflict/mapping/import/degraded status and never advance L or Ready.
- Generic cleanup/resurrection listings remain raw. Explicit generation activation is bound to durable
  operation intent and fresh receipt before clearing that intent, never automatic generation adoption.
- SDK/public types and caps remain release gates. Own declaration whitespace compaction checks identical
  TypeScript-printer syntax before/after, preserves literals/references/symbol names, and never patches SDKs.

## Focused evidence before whole-repository verification

| Area | Scoped result |
|---|---|
| Foundations/cache/pins/index/owners | 28 tests passed in the foundation handoff |
| Runtime/import/publication/repair/activation/cancellation | 422 focused tests passed in the runtime handoff |
| Parent audit/protocol/browser-model/adapter regressions | 65 tests passed |
| Latest foundation + durable untracked health + declaration compaction + audit controls | 45 tests passed |

These runs overlap and must not be summed as unique tests. The final verification section below will
supersede focused counts. No actual private session history was sent to the emulator or a paid model.

## Real SDK HTTP/body-byte meter

The [meter](<../../packages/azure-sync/test/cost-http-meter.ts>) forwards unmodified public Azure SDK HTTP
through loopback-only proxies to real Azurite. It counts attempts (including failures/retries/ranges) and
streamed response **body** chunks, not adapter invocations or Content-Length estimates. History GET/HEAD,
selected row points, index queries, leases and other categories are separate. Subsets are not added again
for billing. Category byte totals are asserted equal to the total; URLs, headers, bodies and credentials
are not retained in reports. Headers/TLS/TCP/request bytes are excluded, not claimed unbillable.

The [reproducible profile](<../../packages/azure-sync/test/cost-profile.test.ts>) uses one production reader,
public durable pins and private cache per device across uploader/importer/service variants; dummy helper
readers cannot bind the actual account. Explicit On supplies real scope consent. Synthetic Native/model
adapters never contact a paid model. Run:

```sh
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run measure:cost
```

Focused final O6 run before parent integration:1 test passed,0 failures/skips, about10.52s test/11.74s runner.
Safe local report: `/tmp/azure-sync-cost-safe-4ZqRIu.log`; the final integrated rerun is authoritative.

| Profile | History GET / HEAD | Batch-row points / index queries | History body bytes | Other observations |
|---|---:|---:|---:|---|
| Per-record idle, including imported copy | 0 / 0 | 0 / 0 | 0 | 1 fresh manifest GET |
| Warm Native first/held proof | 0 / 0 | 0 / 0 | 0 | Fresh lease operation;11/10 manifest points |
| Warm imported first/held proof | 0 / 0 | 0 / 0 | 0 | Fresh lease operation;14/13 manifest points |
| Exactly2 new batches | 2 / 2 | 2 / 0 | 256 | No old batch scan/download |
| Public pins reopened + fresh reader/disk reload | 0 / 0 | 0 / 0 | 0 | 3 fresh manifest points, no L change |
| Warm quiet Native/imported drains | 0 / 0 | 0 / 0 | 0 | Lease release/proof retained;4/7 manifest points |
| Explicit raw history/index audit | 2 / 2 | 2 / 0 | 222 | 0 lease operations |
| Known damaged audit then ordinary cached read | 0 / 0 on refused hit | 0 / 0 on hit | 0 on hit | Audit actually read damage; no L/epoch grant |
| Raw cleanup after cache warm | 0 / 2 | 0 / 1 | 0 | 1 real Blob LIST/deletion |
| Raw resurrection verification after cache warm | 0 / 0 | 0 / 1 | 0 | 1 real Blob LIST, explicit empty-generation activation |
| Candidate/orphan/CAS recovery exception | 2 / 4 | Named recovery path | 256 | Retained verification, not steady polling |

The10 MiB attachment download separately transferred10485760 body bytes and actual SDK ranges. SDK retry
sensitivity counted2 HEAD attempts/1 injected failed response. Size-check HEADs for uncached data remain.

### Cache-pressure and local-resource evidence

Three deterministic histories each contain131072 text bytes; compressed sizes were99061,99061 and99058
bytes (297180 total). With65536-byte memory and131072-byte disk budgets, explicit materialization fetched
three GET/HEAD pairs and297180 bytes; whole-prefix eviction retained one99058-byte prefix. Both a zero-cache
variant and an over-budget variant then performed3 passes over3 histories:9 manifest GETs, **zero** history
GET/HEAD/bytes/points/index queries, and unchanged L. A byte-requiring zero-cache attempt returned LIMIT
once after99061 bytes; the next attempt returned LIMIT with zero history traffic instead of repeating it.

This is a scaled algorithm/retention test, not195 MiB of real private logs. Sampled process peak heap was
152815872 bytes; sampled RSS373227520 bytes, OS peak RSS373489664 bytes. These include SDK/Native/test state,
proxy/measurement overhead and no forced GC; they are not a128 MiB heap guarantee. Emulator CPU is separate.
Disk/pin restart measured29.10ms wall /25.718ms user +3.248ms system; three-prefix materialization/eviction
131.84ms wall /67.683ms user +31.368ms system. Over-budget9-idle checks76.33ms wall /51.387ms user +29.982ms
system. Repeated full local persistence/provenance work remains O(history); O(1) refers to cloud observation.

## Scoped post-optimization workload illustration

This is **not a bill or an enforced upper bound**. Reuse the earlier seven-day aggregates only:53 active
records (12 ordinary,41 descendants),7195 model steps and an estimated9255 publication groups. The latter
was reconstructed from750ms event gaps, not an actual deployed SDK trace. About195 MB was the complete
compressed history of those active sessions, including older content; attachment use was small.

For an explicit30-day illustration, assume:

- 39665 publications and30836 steps (ceil of seven-day rates ×30/7),200 writer-session hours and24000
  timer renewals, **53 enabled records per device held constant**, no indefinite inactive accumulation.
- Child observation also reads its root:12+2×41=94 entity reads per pass/device,812160 per30-day device.
- Conservatively price every publication like the measured cold-style vector:2 Blob PUT +1 LIST +2 Other;
  allow100 Table transactions/publication across sender/receiver,40/step,10/renewal. These are explicit
  allowances, not measured upper bounds. AddUSD0.05 miscellaneous control requests and30% request contingency.
- One receiving peer downloads each newly published batch once (1 GET+1 size HEAD+1 row point); no peer
  history traffic for the single-device case. Retain0.6 GiB average Blob data and0.1 GB Table allowance.
- Use public USD assumptions confirmed in the2026-10-22 pricing pass: write/list0.05/10000, read/Other
  0.004/10000, Standard service-key Table0.00036/10000 and0.045/GB-month; Hong Kong Blob0.024/GiB-month
  (East US0.0208). Default internet egress beyond available free tier:HK0.12/GB, East US0.087/GB.
- Assume4 KiB average Table response body; roughly25.8/30.1 decimal GB monthly bodies for one/two devices,
  including one195 MB audit and the two-device new-history transfer. Headers, retries, attachments,
  wizard fan-out, additional audits and changing metadata sizes require separate allowance.

| Case | Requests | 30% request contingency | HK capacity | Total before egress/tax/features |
|---|---:|---:|---:|---:|
| One always-on device | USD0.923717 | USD0.277115 | USD0.018900 | **USD1.219732** |
| Two always-on devices | USD0.986115 | USD0.295834 | USD0.018900 | **USD1.300849** |

Thus **roughly USD1–2/month under this illustration**, rather than multiplying195 MB by every idle poll.
If enough of the shared100 GB monthly internet-egress allowance remains, this modeled traffic adds no
internet-egress charge. If none remains, the body-only illustration adds approximatelyUSD3.10/3.62 in HK
orUSD2.24/2.62 in East US; actual billed bytes, headers and terms matter. The allowance is not multiplied
per session/device/container; its exact billing-account aggregation was not independently established.
Bandwidth GB is modeled decimal; binary-unit sensitivity is about7% lower. No region was inferred from
browser timezone and no subscription/invoice was accessed.

Rate references: [HK Blob retail API](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Storage%27%20and%20armRegionName%20eq%20%27eastasia%27%20and%20productName%20eq%20%27General%20Block%20Blob%20v2%27%20and%20skuName%20eq%20%27Hot%20LRS%27),
[HK default bandwidth API](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Bandwidth%27%20and%20armRegionName%20eq%20%27eastasia%27%20and%20productName%20eq%20%27Rtn%20Preference%3A%20MGN%27%20and%20meterName%20eq%20%27Standard%20Data%20Transfer%20Out%27),
[Table billing](https://azure.microsoft.com/en-us/pricing/details/storage/tables/),
[Blob capacity units](https://learn.microsoft.com/en-us/azure/storage/common/storage-plan-manage-costs).
The test also retains the old bounded workload assumptions for comparison, using optimized measured
vectors and historical rates:USD0.0962155656 before egress/tax/features, **not** this53-record workload.

## Final verification and reviews

Integrated root run `/tmp/azure-incremental-root-final.j3n0yY.log` passed **1932 unit +102 integration +15
tooling executions =2049**, with zero failures/cancellations/skips, and all five package type checks.
Its sole final command failure was archive size720882>720000. A documentation-only repetition reduction
then passed `pnpm --dir packages/azure-sync run test:pack`: **146 files /719750 bytes**, plus the actual
extracted root/protocol/browser/public strict-type smoke (1 test, no failures/skips). Report:
`/tmp/azure-incremental-pack-final.bBGYR2.log`. Caps were not raised; no SDK or public property names were
mangled. Source credential audit passed369 Git-candidate files. The final root command is being repeated
to record a single clean end-to-end exit after this cap correction.

The clean root command subsequently passed end-to-end with exit0:
`/tmp/azure-incremental-root-clean.dY1ZOr.log` (2049 executions, no failures/cancellations/skips). This is the
**pre-review-correction baseline**; corrected code will be verified again. Historical changelog repetition
was condensed with an immutable link to the full baseline record to reserve archive headroom for fixes;
no cap, SDK or runtime/public property semantics were weakened.

Final independent reviewers were started together only after O1–O6 and individual gates completed:
`github-copilot/gpt-6.1-sol` xhigh (`22ae85af-2a52-4188-859d-3d937d6404a3`) and
`github-copilot/grok-4.7` xhigh (`fb96c9bb-f068-42f0-8d13-f08c885860c7`). No per-task panels were used.
The first GPT implementation verdict is **REQUEST CHANGES**, with three reproduced P2 findings:

1. Semantic initial-envelope audit failures (header JSON/binding/count/head/tip) were outside durable
   health recording, allowing an untracked restored-control cache hit without a successful raw audit.
2. A concurrent newly accepted shorter H was not checked atomically for exact ancestry when a previously
   verified larger candidate was later accepted; count/namespace alone could admit an incompatible branch.
3. Individually fitting prefixes could evict another active writer's data and oscillate downloads when
   the aggregate active working set exceeded retention budgets. Idle observations remained zero-byte.

These findings are accepted. Safe initial-envelope health capture, serialized current-H ancestry, and
explicit data-only preparation/request/held-writer retention with aggregate pressure are being corrected
and regression-tested. Grok's independent first verdict also requested changes: guarded compensation
for H/health writes that lose authority during the durable put, and descriptor-relative cache IO preventing
parent-directory symlink swaps or chmod outside the private root. Its P3 is narrowed to avoiding corruption
poison for a missing unknown/no-floor manifest; referenced missing data and payload-bound refusal remain
quarantined. A suggested ban on legitimate preparation-owner H publication was explicitly **withdrawn**
after checking R2's H-versus-L distinction; verified remote floors are not execution authority.

The subsequent frozen 66-file batch `9ab8cab1600f4907c8a45c21aaa8d294cda37984454336ca546ee783c9250bf3`
received Grok approval, but GPT reproduced two remaining P2 edges: malformed/missing binding fields and
strict public pre-control decoding could still bypass safe initial-audit attribution, and an initial stale
manifest response arriving after a concurrent legitimate H advance could persist a false conflict.
Those approvals were not carried forward while this narrow reader/service delta was corrected.

The final candidate fingerprint is **`ed080b0cf2cd44a19c8b77aef6892147a98695fc25ac1b40ccf0be14ade47b7d`**
over 66 changed/new code, test and script files (sorted paths, excluding docs/README/CHANGELOG; SHA-256 of
`path + NUL + content + NUL`). It adds route-first established-H attribution, known-versus-unknown absence
handling, Host-internal auditControl for guarded pre-byte L checking, and bounded metadata reread when H
advanced during an initial control await. Stable rollback and unrelated identity refusals remain intact.
Actual strict-Repository/Edm-wire regressions and real service movement cases cover the public path.
The one final test-only tuple spread correction preserves arguments/assertions and passes strict typing.

Both independent final reviewers recomputed and **APPROVED this exact final implementation fingerprint**,
with no required findings: GPT-6.1 Sol xhigh and Grok-4.7 xhigh. GPT additionally proved the final test-only
syntax correction was the only change from its already inspected narrow source batch and reran all20
final review regressions successfully. Its56 history/runtime and163 audit/control/service/uploader tests
also passed; these overlap the main suite and are not summed as unique tests. Neither reviewer edited
implementation or ran the global build. Final verification is complete:

- `pnpm run verify` followed sequentially by `pnpm --dir packages/azure-sync run test:pack`: **exit0**,
  report `/tmp/azure-incremental-final-gates.VOxOPJ.log`.
- Root execution counts: **1959 unit +102 integration +15 tooling =2076**, zero failures/cancellations/skips.
  Azure accounts for1175 unit and11 real SDK/Azurite integration executions; counts overlap leaf reruns.
- Extracted archive/public strict-type/browser-factory/runtime smoke: **1/1 passed**, no skips. This is
  separate evidence, not added repeatedly as unique root tests.
- Azure archive: **150 exact allowlisted files /719849 bytes <720000**; Worktrees remains56 files/782895
  bytes <825000. No cap was raised, SDK patched, public property mangled or type safety relaxed.
- Final approved 66-file implementation fingerprint and R2 plan digest remained unchanged after reviews.
  Final credential audit passed **373 Git-candidate files**, with no credentials detected; documentation
  links/whitespace and `git diff --check` passed. No implementation/background jobs remain running.
- The full real HTTP/CPU/pressure profile reran in the final integration command. Known-size zero-cache
  pressure now refuses even its first futile GET/HEAD; the former one-download exception expectation
  was strengthened to zero traffic. Other steady zero-history contracts and raw audit/recovery checks pass.

The complete
operator manual is preserved in the [repository guide](<../azure-sync-operator-guide.md>); the tarball
quickstart/changelog are concise to keep the unchanged 720000-byte cap, not to drop safety requirements.
No conditional, stale-fingerprint or pre-fix verdict is carried forward.
No profiles, running GUI, original checkout or paid Azure resources have been installed/altered by this work.
Live identity/RBAC/private endpoints, physical two-device/Windows GUI, production latency/power-loss and
actual billing remain manual acceptance; emulator/path/private-cache tests do not establish them.
