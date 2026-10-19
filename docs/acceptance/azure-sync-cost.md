# Azure sync — measured-operation cost evidence

**This is a retail-price model, NOT an actual Azure bill.** No paid Azure resources, Cost Management
export, RBAC deployment or month-long meter sample was used. Prices are public East US USD
Consumption retail inputs retrieved by the independent pricing-research pass on **2026-10-19 UTC**;
row effective dates are not retrieval dates. Region, currency, negotiated terms and features can change
these inputs. Manual billing validation remains deferred.

## Reproduce the measured part

```sh
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run measure:cost
```

The [cost test](../../packages/azure-sync/test/cost-profile.test.ts) starts real local Azurite and two
loopback HTTP reverse proxies. Unmodified Azure SDK requests are forwarded to the emulator. Every
HTTP attempt—including conditional failures, retries, range downloads and logical catalog pages—is
counted at the proxy, not guessed from adapter method calls. Reports include **counts only**: no
request URL, header, credential, body, host path or conversation content. The test refuses a non-loopback
upstream. Resources and sockets are closed after each run.

Actual SyncService/Uploader/Importer/RemoteSessionReader/LeaseManager/BlobStore/TableStore classes
run over real JSONL, local JSON storage-domain lanes and retained public AgentLoop instances. Projection
warming uses the actual registry fold with an explicit test cache port, not a claim that the Host ships a
persistent projection-cache service. Attachment bytes come from a controlled 10 MiB source; the actual
AttachmentSync and BlobStore perform the Azure HTTP calls. No prompt or model call is generated.

The source seed is constructed with public persistence APIs. The SDK's real `session/end-seed` marker
on native resume is retained—not fabricated or removed. Eight one-event batches establish the history
size, then the default 1,000-event batch setting coalesces the native incremental suffix into one batch.
The measured steady-sync vector includes eight existing batches plus one publication, an intentionally
conservative vector for a model that retires active threads before the ninth publication.

Current reproducible sample: `/tmp/azure-sync-t9-cost-final.RFSSqa.log`, exit 0, 2026-10-19, Node24.14.1,
Azurite3.37.0, Blob SDK12.34.0, Table SDK13.3.2. Temporary logs are evidence aids, not shipped artifacts.
The final verification log may supersede this sample; the test emits the complete `COST_PROFILE` JSON.

## Observed request vectors

`BW/BR/BL/BO` = Blob Write/Read/List/Other requests. `TR/TQ/TW/TB` = Table entity reads/queries/
standalone writes/entity-group HTTP batch requests. All Standard Table categories below have the same
rate. A Table batch is counted once per HTTP request, **not** once per entity action. Subset counters
(Put Block, lease calls, failed responses) are not added again to request totals.

| Measured action | BW | BR | BL | BO | TR | TQ | TW | TB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Create/check private container + Table | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 |
| First opt-in, one committed batch, cold control release | 2 | 0 | 1 | 2 | 7 | 0 | 3 | 1 |
| Cold takeover of a held foreign transport lease, one batch | 1 | 1 | 0 | 4 | 8 | 1 | 2 | 0 |
| Cold imported-copy inspection, eight batches, immediate release | 1 | 16 | 0 | 18 | 7 | 2 | 2 | 0 |
| Retire a root with Off, no held lease | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 0 |
| Seed eight committed batches, cold release | 9 | 0 | 8 | 2 | 21 | 0 | 3 | 8 |
| Unchanged idle refresh, one batch | 0 | 1 | 0 | 1 | 2 | 1 | 0 | 0 |
| Unchanged idle refresh, eight batches | 0 | 8 | 0 | 8 | 2 | 1 | 0 | 0 |
| Cold import, eight batches | 0 | 8 | 0 | 8 | 1 | 1 | 0 | 0 |
| Unchanged imported-copy idle refresh, eight batches | 0 | 8 | 0 | 8 | 2 | 1 | 0 | 0 |
| Five browser-style local STATUS requests | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Native first per-step proof, eight batches | 1 | 8 | 0 | 9 | 5 | 1 | 1 | 0 |
| Native held-lease per-step proof, eight batches | 0 | 8 | 0 | 9 | 4 | 1 | 1 | 0 |
| Imported first proof, eight batches | 1 | 16 | 0 | 17 | 6 | 2 | 1 | 0 |
| Imported held-lease proof, eight batches | 0 | 16 | 0 | 17 | 5 | 2 | 1 | 0 |
| Release an existing native/imported owner | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 0 |
| One background timer-equivalent renewal | 0 | 0 | 0 | 1 | 2 | 0 | 1 | 0 |
| Incremental sync after eight existing batches, including cold-style release | 2 | 8 | 1 | 10 | 8 | 1 | 2 | 1 |
| Incremental sync after one existing batch | 2 | 1 | 1 | 3 | 8 | 1 | 2 | 1 |
| Child first publication, including acquisition/root touch/release | 2 | 0 | 1 | 2 | 13 | 0 | 0 | 4 |
| Incremental sync with one injected real Table ETag race | 3 | 4 | 2 | 8 | 11 | 1 | 3 | 2 |
| First attachment upload, 10 MiB, with real lease proof callback | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| Repeated immutable attachment upload, with lease proof callback | 1 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| Attachment import, 10 MiB | 0 | 3 | 0 | 2 | 0 | 0 | 0 | 0 |
| Three logical catalog pages, one item per page | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 |

Important interpretations:

- Counter grouping is not a claim that every transport label is a distinct official tariff category:
  the container-create PUT is grouped into `blobWrites` by the proxy, while the official category is
  List/Create Container. Both are **$0.05/10,000** and the formula sums BW+BL, so shifting that one
  setup request between the groups changes neither the operation count nor the exact modeled total.

- Actual SDK acquisition headers prove **30-second cold On/sync/takeover/inspection and child
  publication**, and **60-second native proof**. Cold controls release immediately and have no
  background renewal; native work retains its 30-second renewal cadence. Promotion/late-cancellation
  races are separately tested, not inferred from a lease mirror. Duration counters are subsets,
  not additional billable requests.
- **Idle refresh re-reads the complete selected history.** One→eight batches increases Blob GET and
  property requests one→eight. Imported proof paths read the history twice in this profile. No cached
  client TTL is substituted for execution proof. The local 15-second browser STATUS poll creates no
  Azure calls; unchanged Host refresh creates no idle lease renewals.
- The source BlobStore uses a direct **Put Blob** for upload. The measured production attachment
  upload has **zero Put Block calls**. A separate, explicitly SDK-only sensitivity test forces four
  Put Blocks plus one Put Block List (five Writes); it is NOT represented as plugin behavior or added
  to the monthly plugin model. Range downloading a 10 MiB file really creates **three GETs** plus two
  property reads. Larger files/configured caps must be remeasured, not priced as one GET each.
- The real ETag race causes two Table batch attempts; the model counts both. Outer HTTP failed-response
  counters do not enumerate inner batch failures, but **all batch attempts are still priced**.
- A separate proxy-injected 503 HEAD demonstrates two actual SDK HTTP attempts and one synthetic failed
  response. It is an SDK sensitivity test, not a service-billing claim. Ordinary measured 404/409/412
  conditions are authenticated requests. Retry/pagination costs are not assumed free.
- Child publication has four separate EGT HTTP calls across its lifecycle, **not** a single billable
  call for the entire workflow. Inside each valid EGT, insert/update/root-touch actions are one billed
  transaction. Entity throughput/partition/100-action limits remain separate.

## Official pricing inputs and billing semantics

| East US public USD Consumption input | Rate |
|---|---:|
| General Block Blob v2 / Hot LRS stored data | $0.0208 per GiB-month |
| Blob Write operations | $0.05 per 10,000 |
| Blob List / Create Container operations | $0.05 per 10,000 |
| Blob Read operations | $0.004 per 10,000 |
| Blob Other operations | $0.004 per 10,000 |
| Tables / Standard LRS stored data, default service-scoped key | $0.045 per GB-month |
| Standard Table Write/Batch/Read/List/Scan/Delete transactions | $0.00036 per 10,000 |

References:

1. [Retail Prices API documentation](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices).
2. [Exact Blob retail query](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Storage%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20productName%20eq%20%27General%20Block%20Blob%20v2%27%20and%20skuName%20eq%20%27Hot%20LRS%27).
3. [Exact Standard Table query](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Storage%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20productName%20eq%20%27Tables%27%20and%20skuName%20eq%20%27Standard%20LRS%27).
4. [Blob pricing](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/) and [Table pricing](https://azure.microsoft.com/en-us/pricing/details/storage/tables/).
5. [Table batching explicitly counts one billed transaction](https://learn.microsoft.com/en-us/azure/storage/tables/storage-performance-checklist#batching) and [EGT contract](https://learn.microsoft.com/en-us/rest/api/storageservices/performing-entity-group-transactions).
6. [GPv2 lease billing is Other](https://learn.microsoft.com/en-us/rest/api/storageservices/lease-blob#billing) and [REST transaction-category mapping](https://learn.microsoft.com/en-us/azure/storage/blobs/map-rest-apis-transaction-categories).
7. [Capacity/cost planning](https://learn.microsoft.com/en-us/azure/storage/common/storage-plan-manage-costs): Blob “GB” uses GiB and retained/average capacity and optional retention features matter.
8. [Table encryption-key pricing](https://learn.microsoft.com/en-us/azure/storage/common/account-encryption-key-create#pricing-and-billing).

The API research returned the complete filtered pages (`NextPageLink:null`). Blob SKU
`DZH318Z0BPH7/006M` rows have effective dates in 2016/2017; Table Standard
`DZH318Z0BNZ5/004H` capacity is effective 2019-06-01 and transactions 2016-04-11. Those are row effective
metadata, not a statement that pricing was fetched then.

GPv2 lease acquire/renew/release/break/change and Get Blob Properties are Other. Put Blob, Put Block and
Put Block List are Writes; Blob content GET is Read, listing is List. Container properties are Other.
Standard Table delete is a transaction. Authenticated conditional failures/retries/pagination can be
billed; authentication failures are not billed under the referenced mapping. This model does not rely
on free authentication failures to meet the target.

**Encryption SKU trap:** Table service-scoped keys still provide Microsoft-managed encryption at rest.
Account-scoped Table keys are an immutable-at-creation account choice and use **Account Encrypted LRS**
pricing: capacity $0.045/GB-month, Writes $0.025/10k, Batch Writes $0.075/10k, Reads $0.005/10k,
List/Scan $0.09/10k, Delete $0. This is NOT the Standard Table rate above, even without customer-managed
keys. [Comparison retail query](https://prices.azure.com/api/retail/prices?%24filter=serviceName%20eq%20%27Storage%27%20and%20armRegionName%20eq%20%27eastus%27%20and%20productName%20eq%20%27Tables%27%20and%20skuName%20eq%20%27Account%20Encrypted%20LRS%27).

## Worked monthly model using the observed vectors

This is a **conditional design example**, not a measured month or an automatic spending cap:

- 30 days; two devices; **at most one enabled session record on each, counting every subagent
  descendant separately**. This example has no enabled descendants. At most eight committed batches
  per enabled record, default 3 MiB batch cap, five-minute Host polling: **17,280 TOTAL poll passes
  across TWO copies (8,640 per copy)**.
  One UI root with several enabled children is several polled records, not one budget unit.
- 3,000 batch publications distributed over **at least 375 small thread lifetimes**, not 3,000 additions
  to one unbounded history. Turn Off/retire threads before exceeding eight active batches. The first
  375 publications use the measured first-opt-in vector; the remaining 2,625 use the conservative
  eight-existing-batch incremental vector. Using eight pre-existing batches overestimates a thread
  retired before its ninth publication; it does not assume eight batches can hold unlimited history.
- 3,000 model steps use the more expensive imported-writer vectors: **405 first acquisitions**
  (375 thread lifetimes + 30 imports) and **2,595 held proofs**. Thus first acquisitions are not priced
  as renewals. 60 active writer hours add **7,200 timer renewals**, separately from per-step proofs.
- **750 explicit retire-Off actions** (375 lifetimes × two devices) and **30 cold imported inspections**
  are included. Forced takeover is measured above but this workload assumes **zero**; add its measured
  workflow cost if used. These counts deliberately over-budget copies never imported on device two.
- 30 cold imports; 100 first uploads and imports of 10 MiB attachments; 30 three-page catalog passes;
  30 extra CAS-retry-shaped sync actions on top of the baseline publication budget. These are explicit
  assumptions, not counts from user activity. **730 repeated attachment uploads are included**:
  100 files × up to seven later publications plus 30 extra retry-shaped actions. Uploader scans the
  retained references for each new sync; immutable PUT attempts and hash/property checks are not free.
  First/repeated attachment vectors include the real SessionLeaseManager proof callback used by
  Uploader (one Table read per reference); publication vectors already include their enclosing lease
  acquisition/release, so that fixture setup is not counted again. SDK-only sensitivities remain
  excluded. The 10% contingency is not an unlimited bound.
- **1 GiB average retained Blob data**, mostly attachments/inactive copies; **0.1 GB Table allowance**.
  Include all generations, retained attachments and orphans in actual capacity. No automatic retention
  policy enforces these quantities. Current small synthetic log bodies measure request multiplicity,
  not the bytes or egress of arbitrary real conversations. The 100 × 10 MiB attachments alone occupy
  about 0.977 GiB; keeping the 1 GiB allowance leaves roughly 24 MiB for logs/other objects. That needs
  small compressed batches or explicit removal/retention choices—not 3,000 maximum-sized batches.
  Increasing retained Blob data from 1 to 10 GiB adds $0.1872/month at this rate, but can also change
  transfer/egress substantially; capacity and request counts are not the same quantity.

Weighted HTTP attempts before the 10% operation contingency:

| Category | Monthly modeled requests |
|---|---:|
| Blob Writes | 7,356 |
| Blob Reads | 208,380 |
| Blob Lists | 3,060 |
| Blob Other | 225,391 |
| Table entity reads | 90,140 |
| Table queries | 26,115 |
| Table standalone writes | 17,476 |
| Table batch attempts | 3,060 |
| Total base requests | **580,978** |

```text
Table billable transactions = 90,140 + 26,115 + 17,476 + 3,060 = 136,791
Capacity = 1 * .0208 + .1 * .045                         = $0.0253000000
Operations = (7,356 + 3,060) * .05/10000
           + (208,380 + 225,391) * .004/10000
           + 136,791 * .00036/10000                    = $0.2305128760
10% operation contingency                              = $0.0230512876
Modeled total                                         = $0.2788641636
```

Thus **about $0.279/month under these assumptions, excluding egress/tax/features**. This is NOT an
actual Azure bill, not a blanket “1 GiB costs <$1” promise, and not an enforceable budget cap.

## Sensitivity and exclusions

For an unchanged enabled thread with `M` committed batches fitting one Table query page and one GET
per blob, this measured implementation performs approximately `M` Blob Reads + `M` Blob property
requests + two Table entity reads + one Table query **per copy, per Host poll**. At two copies and
five-minute polls the Blob operation component is `17,280 * M * .0000008`:

- `M=8`: **$0.110592/month** in those Blob polling operations alone (plus about $0.00186624 Table
  polling transactions). The full worked model includes other actions and capacity separately.
- `M=100`: **$1.3824/month** Blob polling alone; **already above US$1** before egress/capacity/proofs.
- Eight batches on each of **100 enabled copies per device**: **$11.0592/month** Blob polling alone.
- Polling every 30 seconds instead of five minutes multiplies polling by ten: eight-batch Blob polling
  alone becomes **$1.10592/month**. The minimum supported interval is not the cheap-model interval.
- One Blob LIST every five minutes on two devices would be $0.0864/month; every 30 seconds $0.864;
  every five seconds $5.184. **The actual measured idle path does not perform Blob LIST**—these are
  sensitivity illustrations, not invented application calls. Five seconds is not a supported Host poll.

Active lease renewal itself is inexpensive (30-second renewal for 60 hours is 7,200 Other requests,
$0.00288 Blob component); a continuous single lease for 30 days has 86,400 renewals, $0.03456 Blob
component. The implementation also reads/updates Table mirrors, as measured above. Never keep leases
alive merely to make a UI appear owned; client status polling is local-only.

Egress can dominate when histories are re-downloaded or attachments are moved between regions/clouds.
Larger caps can add range GETs and SDK retries. Private endpoints, diagnostics/Log Analytics, versions,
soft delete, geo replication, customer-managed keys/Key Vault, taxes and account-encrypted Table pricing
are excluded. Azure Policy may add features. Real Cost Management/Storage metrics and invoice validation
are **deferred manual acceptance**; do not deploy paid resources or claim their results from this test.
