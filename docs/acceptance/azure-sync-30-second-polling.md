# 30-second polling default — requested follow-up

On 2026-10-22 the user requested a 30-second interval after incremental history verification was
implemented. This follow-up changes the source default from300 to30 seconds, not any live profile.
The immutable approved R2 plan and its historical five-minute cost examples are not rewritten.

## Behavior and compatibility

- Loader `pollSeconds` default and SyncService's omitted-interval fallback are30 seconds. The browser
  preference's initial disabled value matches; authoritative returned settings still replace it.
- Explicit config or already-saved polling preferences are preserved. An existing300-second preference
  requires Cloud settings → polling30 → Save on the installed Host; a new default is not forced migration.
- This is fixed-delay polling: roughly0–30s detection plus request/processing/UI time under healthy
  conditions, not push or a strict30s SLA. No overlapping poll attempts. Failures back off up to5minutes;
  authentication failures suspend polling until recovery. Explicit refresh bypasses automatic backoff.
- Idle unchanged/applied threads still fetch only control metadata, not history payloads. Actual missing
  data, ownership, provenance, import readiness, explicit Continue and live-Agent catch-up rules are
  unchanged. Model-step ownership proof and60s/30s lease-renewal timing are independent from polling.
- The15-second browser STATUS interval remains local-only. Code changes are not installation/deployment.

## Request and bandwidth sensitivity, not a live bill

Illustrative30-day, always-online model:12 ordinary +41 enabled descendant records. Each ordinary check
reads one manifest; each descendant also reads its root:94 entity GETs/pass/device. This excludes other
activity, retries and GUI actions; count enabled records, not merely conversation headings.

| Poll interval | Passes/device/month | Entity GETs/device/month | Table transaction USD/device |
|---|---:|---:|---:|
| 300s | 8640 | 812160 | 0.029238 |
| 30s | 86400 | 8121600 | 0.292378 |

Using the earlier illustrative USD0.00036/10000 Table request input, incremental polling transactions are
about **USD0.263/device/month**, or **USD0.526 for two devices**. This is10× polling traffic, NOT10× total
cost: retained storage, ordinary publications, new history bytes and model-step checks do not multiply.
Rates, region, tax, discounts and features must be checked for the actual subscription.

At an assumed4096-byte response body, control bodies rise from3.327 to33.266 decimal GB/device/month:
**29.939 GB additional**, or59.879 GB across two devices. Actual entities vary (especially Git metadata),
and HTTP/TLS headers are extra. If sufficient shared free internet-egress allowance remains, added
internet-egress charge can be zero; it is not100GB separately per device/session. If none remains, the
additional body-only amount is aboutUSD3.59/device at HK0.12/GB orUSD2.60 at East US0.087/GB, before
headers/tax/features. Do not treat the historical USD1–2 five-minute illustration as a30s cost guarantee.

More polls also mean more Host wakeups/local stat/provenance work; backends lacking cheap event counts
can need local history reads. Cloud payload cache hits do not make all local CPU work O(1). For long
histories/many records, use actual response bytes and CPU observations rather than assuming polling free.

## Verification scope

Verification passed (exit0), report `/tmp/azure-sync-poll30-verify.GvFFJu.log`:

- Host build plus strict browser/test TypeScript checks.
- 109 focused config/settings/service/timer/runtime/browser tests:109 passed,0 failures/cancellations/skips.
- Exact archive150 files/719848 bytes under the unchanged720000 cap; extracted runtime/public-type smoke1/1.
- Credential audit374 Git-candidate files passed. The original R2 plan remains unchanged.

New timer regression proves no automatic refresh before30000ms and repeat at30000ms using fake timers;
settings regression proves new30 defaults and preservation of an explicit saved300 override until an
explicit settings update. Existing poll timeout/backoff/nonoverlap/safety tests remain unchanged.
The earlier final review approvals apply to the preceding frozen implementation fingerprint;
they are not automatically approvals of this follow-up. No profiles, credentials, resources, deployment,
commit or push were performed.

See the [full operator guide](<../azure-sync-operator-guide.md>) and the
[previous implementation evidence](<azure-sync-incremental-verification.md>) for safety and manual limits.
