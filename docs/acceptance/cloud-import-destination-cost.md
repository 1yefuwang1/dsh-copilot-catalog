# Destination import / Git v2 — scoped HTTP-cost evidence

Measured: 2026-10-21. **Real Azure SDK → loopback HTTP proxies → real Azurite**, not a live Azure bill.
The [reproducible cost test](<../../packages/azure-sync/test/cost-profile.test.ts>) meters HTTP attempts
without recording URLs, headers, keys, bodies or conversation contents. Native/SDK integration runs
use controlled model responses; no paid model call or Azure resource was provisioned.

This supplements the [historical v1 model](<azure-sync-cost.md>) and the
[destination acceptance ledger](<cloud-import-destination.md>). It is not full new-wizard monthly-cost
coverage: one wizard operation can reverify the snapshot several times, and bytes/history/retries vary.

## Observed optional-path vectors

| Profile | Blob PUT | Blob GET | Blob LIST | Blob OTHER | Table GET | Table query | Table write | Table EGT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Git v2 seed, one history batch | 2 | 0 | 1 | 2 | 11 | 0 | 3 | 2 |
| Explicit no-new-event Git refresh | 1 | 1 | 0 | 3 | 9 | 1 | 2 | 1 |
| Repeated explicit refresh | 1 | 1 | 0 | 3 | 9 | 1 | 2 | 1 |
| One verified snapshot-reader call, one batch | 0 | 1 | 0 | 1 | 1 | 1 | 0 | 0 |

- No-new-event refresh is **18 HTTP attempts for this profile**, not 18 additional requests for every
  normal turn. Its PUT is lease-object preparation (one expected immutable-existing response), **zero
  history batch writes**. History header/count/hash/batch-tip fields stayed equal before/after.
- That refresh acquires one cold30s lease, uses two lease operations total, and publishes a guarded
  Table metadata transaction. Repeating explicit refresh still records a new observation; it is not
  assumed free/deduplicated. There is no continuous idle Git watcher.
- The verified-reader row is **one read**, not a full destination wizard. It performs no lease
  operations, Agent creation, model/tool execution or Git/network code preparation.
- `leaseBlobWrites` and `historyBlobWrites` in JSON output are **subsets** of Blob PUT counts, never
  added again to request or billing totals. Valid Table EGT is one billed transaction regardless of
  entity actions/conditional root touches. Blob lease requests use the existing GPv2 OTHER assumption.
- The Git facts in the HTTP profile are synthetic bounded data. Actual local Git capture/privacy and
  HEAD/upstream/config races are tested separately in
  [real Git tests](<../../packages/azure-sync/test/git-context-probe.test.ts>) and
  [actual repository/publication tests](<../../packages/azure-sync/test/git-context-publication.test.ts>).
  These facts do not prove any real remote branch contains a commit.

## Worked request pricing, not a guarantee

Using the same explicitly scoped retail assumptions as the historical report:

- Blob write/list: USD0.05 per10,000; Blob read/OTHER: USD0.004 per10,000.
- Table Standard/service-key operations: USD0.00036 per10,000.
- The measured explicit metadata refresh costs approximately **USD0.000007068 in requests** at those
  assumed rates: one Blob PUT, four Blob read/OTHER, thirteen Table read/query/write/EGT operations.
- One measured one-batch reader call costs approximately USD0.000000872 in requests.

These calculations exclude bandwidth, tax, negotiated prices, alternative tiers/key SKUs, retention,
monitoring, private endpoints, unmeasured retry/repair paths, code fetching/pushing and any paid model.
Capacity is separate; larger histories/attachments, extra enabled descendants and repeated verification
increase costs. This does not promise all possible imports or a monthly spend belowUSD1.

The CURRENT reproducible legacy-workload calculation (Git-v2 optional rows **excluded**, unchanged
named workload assumptions) yields **584,038 base-category HTTP attempts**, request cost
USD0.230623036 +10% contingency USD0.0230623036 +capacity USD0.0253 = **USD0.2789853396**.
This supersedes only a new run's arithmetic; historical T9 figures remain labeled historical.
Do not include subset counters such as lease/history PUTs in that total a second time.

Adding3,000 **extra explicit metadata refreshes beyond** that legacy workload would add USD0.021204
request cost, or USD0.0233244 with its same10% contingency. This is an illustrative additive workload,
not a claim about normal turn count or an actual bill. A full deployed/two-device new-wizard workload,
Windows behavior, current-region prices and actual Azure billing remain manual release evidence.
