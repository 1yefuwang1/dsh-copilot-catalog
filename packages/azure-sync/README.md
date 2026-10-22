# @1yefuwang1/dsh-azure-sync

Experimental opt-in continuation using **Blob Hot LRS + Table Storage**, not Azure compute/Postgres.
For SDK **0.2.1-rc.2**, Node **>=22.19.0**, pnpm **11.7.0**; working-tree version0.1.0 is not a published
release, installed GUI or live Azure/Windows/billing acceptance claim. **Code/checkouts, credentials,
profiles, settings, schedules and drafts are not transferred.** Logs/attachments can themselves contain
secrets/code/host paths: upload only to trusted writers permitted to hold them. TLS/SSE is not client-side
encryption; hashes cannot defend against an authorized writer rewriting history.

The [full operator guide](<../../docs/azure-sync-operator-guide.md>) preserves detailed setup, mapping,
Git privacy, recovery and platform procedures in the repository (not part of this tarball).

## 1. Deliberate build/install

From the source repository:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run build
pnpm --dir packages/azure-sync pack --pack-destination /absolute/output/directory --config.ignore-scripts=true
dsh plugin --profile YOUR_PROFILE add /absolute/path/to/generated-package.tgz
# Development alternative: dsh plugin --profile YOUR_PROFILE add -w packages/azure-sync
```

Replace paths/profile and inspect the tarball. Installation changes that profile; tests never install.
Restart the **Host** for Host code. Built ESM/types/browser assets do not deploy or refresh a running GUI;
no replacement server, core patch or HMR is promised. **One Host per local state store**: never share
JSONL/storage directories between processes. Same-Host lanes are not raw-admin/cross-process atomicity;
devices keep separate local stores.

## 2. Private inexpensive Azure resources

Review/run setup yourself after selecting the subscription (`az login` / `az account set`); tests create
no paid resources. Use dedicated StorageV2, explicit region and **Standard_LRS** (CLI defaults cost more):

```sh
RESOURCE_GROUP='YOUR_RESOURCE_GROUP'
ACCOUNT='YOUR_GLOBALLY_UNIQUE_LOWERCASE_ACCOUNT'
LOCATION='eastus'
az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
az storage account create --name "$ACCOUNT" --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" --kind StorageV2 --sku Standard_LRS --access-tier Hot \
  --allow-blob-public-access false --min-tls-version TLS1_2 --https-only true \
  --enable-hierarchical-namespace false --encryption-key-type-for-table Service
```

`Service` still encrypts Table data with a Microsoft-managed service key. Account-scoped keys have a
costlier transaction SKU chosen at creation. No CMK/Key Vault/HNS/premium/GRS is needed; policies can add
retention/versioning/soft-delete/diagnostics/network charges. For token auth give the Host **Storage Blob
Data Contributor** and **Storage Table Data Contributor** at account scope (admin/RBAC propagation);
management Contributor alone is insufficient. Then, with current CLI/auth or equivalent portal setup:

```sh
az storage container create --account-name "$ACCOUNT" --name dsh-state --auth-mode login --public-access off
az storage table create --account-name "$ACCOUNT" --name dshstatesync --auth-mode login
```

Private networking is optional external administration: Blob **and** Table/DNS must be reachable;
network costs and live RBAC are not proven by Azurite. [Table key billing](https://learn.microsoft.com/en-us/azure/storage/common/account-encryption-key-create#pricing-and-billing).

## 3. Authentication and account consent

Use **Cloud settings**: CLI/managed identity (account name; optional identity client id), connection
string, or Auto (configured string then `DefaultAzureCredential`). Enter a string **only** in the Host's
write-only password field, never YAML, committed environment files, chat or native commands. Credentials
are authenticated RPC JSON to the credential provider, not browser/settings/model/log storage; fields
clear on submit/cancel/unmount/disconnect. Blank keeps a secret; clearing is explicit. Change readonly
sources at their origin; uncertain failed writes block safely until retry/replacement/ambient auth.
Account names do not prove a connection string's actual endpoint. Keep `allowInsecure:false` except a
chosen local emulator. **Test authentication** checks/creates only the configured private container/Table,
not an account, model, import or opt-in. Credentials/account changes retire old runtime proofs first.

Threads start **OFF**. Confirm On to upload **all** prior history; unmaterialized blank threads stay
pending, not falsely synced. Upgraded unscoped/current-account-mismatched records require explicit
**Sync now** or **On**; observation/audit never binds publication consent. Local metadata v5 reads v4;
Azure/native format stays v4. Scope changes demote remote checkpoints, not Native files/old-account pins.

## 4. Mandatory destination-import safety profile

Local/New worktree import is unavailable until persistent **USER profile** overrides are verified. A
package install alone is not proof. Stop Host, back up config/data, and deliberately merge into that
profile's own `cordis.patch.yml`, not a file in a versioned plugin:

```yaml
- id: session-persistence-jsonl
  disabled: true
- id: session
  inject: [sessionPersistence, cloudImportReadinessV1]
- id: agent-loop
  inject: [sessionPersistence, cloudImportReadinessV1]
- insert:
  - id: mandatory-cloud-import-guard
    name: '@1yefuwang1/dsh-azure-sync/import-guard'
    config:
      root: !!js dshHomePath('cloud-import')
  - id: mandatory-cloud-import-persistence
    name: '@1yefuwang1/dsh-azure-sync/import-persistence'
    config:
      root: !!js dshHomePath('sessions')
      compression: zstd
```

Keep the **existing root/encoding**; if uncompressed, use `compression: none`, not a format conversion.
The independent guard/composite provider and BOTH session/agent-loop gates must remain even when the
Azure bundle is removed/downgraded. Persistence missing alone permits Native in-memory fallback;
missing/incompatible readiness/provider must instead leave execution unavailable. Never remove gates
to bypass a pending operation refusal. Initial placement needs trusted **local POSIX** claim storage
and public flock: Windows provisioning, network-FS/uncertain durability and unproven seeded imports
refuse before effects. No profile change/restart/install is performed by the wizard/tests.

## 5. Receive history; Continue is separate

Prepare code yourself; choose the same account and exact SID/generation. **Local** is an existing folder;
**New worktree** needs compatible Worktrees, registered source, ordinary Native Full-access actor and exact
available commit. No helper/model/naming prompt, actor settings copy, automatic Git fetch/push/reset,
source dirt, checkout theft or SID relocation. All historical cwd paths must exist inside the mapping;
localized immutable header cwd exactly equals the Local folder. Different/dirty/unknown code needs ack.

Reservation precedes effects; readable history +Native/project/worktree binding precedes Ready.
**Open is read-only. Continue separately checks pending input, model/directory/code/provenance/readiness
and fresh ownership.** A new Host needs process-local activation; receipts alone grant nothing.
Cancellation retains effects; reopen the same operation/checkout. Uncertain claims/missing checkout after
possible refs need offline recovery, not TTL stealing/ref recreation. Live-Agent catch-up needs Host restart.
Legacy pull needs explicit mappings; edits cannot retarget pinned destinations. Partial copies stay blocked.

## 6. Controls and limits

```text
/cloud status | on | off | sync | pull [session-id] | verify [session-id]
/cloud map <linux|darwin|win32> <remote-prefix> <local-prefix> [--id <mapping-id>]
/cloud unmap <mapping-id> | mappings | takeover --confirm | detach
/cloud remove --confirm --retain-attachments | export | repair [--confirm-mapping]
/cloud resurrect --confirm | acknowledge-degraded | check-ownership | test-auth
```

Literal quoted tokens, no shell/model/credential writes. Off attempts shared disable (offline is not
confirmation); detach keeps local without disabling cloud. Export is local0600 on tested POSIX, protect
Windows ACLs. Remove keeps local, tombstones root/descendants, **retains shared attachments**. Explicit
resurrection is a new generation; destination-scoped legacy adoption is refused. No merge/overwrite.
Backups/versions/orphans can retain bytes; Blob/Table aren't one transaction, full purge is manual.

Every step requires fresh server/local proof, not TTL/cache. Native60s leases renew30s; cold controls30s
without idle renewal, promotion needs new epoch. Stop other writers: takeover cannot undo running tools.
Offline fails closed unless detached. Composer is UX, not global direct-API veto. **Unload stops cloud
enforcement**; never remove mandatory import gates. No-cwd/incompatible/schedule-bearing history is
unsupported; missing presets/models/capabilities block/degrade. Ack cannot opt in/bypass partials.

## 7. Cache, observation and explicit audit

Applied unchanged idle threads download **zero history**, even with eviction/over-budget. Content work
verifies missing batches. Remote H and applied L differ: W=H cannot forget unfinished catch-up. No cached
bytes/Git/pin/audit grants writer, Ready or Continue; fresh lease/local/forward provenance still applies.

Disposable cache: normally `~/.dsh/azure-sync/history-cache`. Authoritative rollback/health unit
`azure_sync_history_pins` is separate: **back it up, never delete it to clear a cache**. Eviction removes no
Native/mapping/journal/cloud data. Reload proves canonical bytes, not sidecar flags/localized-log guesses.
Secure disk caching requires Linux `/proc/self/fd`; elsewhere memory/H/gates remain without disk guarantees.
Defaults: `historyMemoryBytes=134217728` serialized weight (NOT heap cap), `historyDiskBytes=536870912`,
`historyJobTimeoutMs=120000` maximum; zero disables a tier. Limits2 materializations/4 payload transports.
Active pressure blocks instead of repeated downloads. Independent120s data preparation can outlive5s proof
waiting, but no step/lease/input is granted/resubmitted. Real cancel/Off/intent/runtime changes revoke owners.

**Verify cloud copy** confirms egress cost, bypasses history/index caches and reports an exact cutoff,
not continuous health. **Attachments are excluded.** No Agent/lease/opt-in/Continue. Known failure survives
hits/restarts/previews; repair then explicitly audit that scope/generation. Other-account/older audits
cannot clear it; missing unknown history is not corruption. Git hints do not prove transferred code or
ownership: trusted bounded local probes never read cloud cwd/climb ancestors or run hooks/filters/lazy
fetch/mutations. Raw dirty/Unknown and30s-old facts need receiving-code review, not matching branch labels.

## 8. Verification and cost

```sh
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run verify
pnpm --config.ignore-scripts=true run verify
```

Synthetic public-SDK/Azurite/client/extracted runtime/type/security/cap tests install no profile, paid
resource or real user-data upload. Built bundles are not deployed GUI/full-composer proof. Live Azure
identity/RBAC/private-network/latency/billing, physical two-device and Windows GUI remain manual.
No bill cap: storage, controls/leases, new/missing bytes, audits/retries/orphans and every enabled descendant
still count. Browser15s STATUS is local-only. Check actual regional rates/shared remaining egress.

Repository-only detail: [full operator guide](<../../docs/azure-sync-operator-guide.md>),
[destination contract](<../../docs/acceptance/cloud-import-destination.md>),
[incremental evidence](<../../docs/acceptance/azure-sync-incremental-verification.md>),
[historical cost](<../../docs/acceptance/azure-sync-cost.md>). Neither is a live invoice/spending guarantee.
