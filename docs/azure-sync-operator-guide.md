# Azure sync — full repository operator guide

Opt-in conversation continuation between devices using **Azure Blob Hot LRS + Table Storage only**.
No Postgres, Functions, App Service, or always-on Azure compute. Code, Git checkouts, credentials,
profiles, schedules, global configuration and browser drafts are **not** synchronized.

Experimental third-party plugin for **DSH 0.2.1-rc.2**, Node **>=22.19.0**. This working-tree version
is `0.1.0`; registry publication, a deployed GUI installation, live Azure acceptance and Windows GUI
acceptance have not been established. The source acceptance ledger distinguishes tested and deferred
items. Do not infer a published release or a real Azure bill from the automated tests.

## 1. Build and install deliberately

From a source checkout with pnpm **11.7.0**:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run build
pnpm --dir packages/azure-sync pack --pack-destination /absolute/output/directory --config.ignore-scripts=true
```

Inspect the generated tarball before adding it through the Plugins page or CLI:

```sh
dsh plugin --profile YOUR_PROFILE add /absolute/path/to/generated-package.tgz
# Development alternative, from the repository root:
dsh plugin --profile YOUR_PROFILE add -w packages/azure-sync
```

Replace paths/profile first and inspect the tarball. Installation changes that profile; tests never do.
Restart the **Host** for Host-code changes. The build includes ESM/types/browser factory, not deployment:
no replacement server/core patch or automatic GUI refresh/HMR is promised.

**One Host per state store.** Never share JSONL/storage directories between processes. Same-Host metadata
writes share a lane, not cross-process/raw-admin atomicity. Devices keep separate local stores.

## 2. Create the inexpensive Azure resources

Review/run these yourself; no resources are provisioned by tests. Choose a dedicated StorageV2/private
container/Table, explicit region and **LRS** (CLI SKU defaults cost more). After selecting your subscription
with `az login` / `az account set`, example POSIX setup:

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

`Service` still encrypts Table data with the default Microsoft-managed service key. Account-scoped keys
use a different, costlier transaction SKU chosen at account creation. No CMK/Key Vault, hierarchical or
premium/geo-redundant tier is needed; inspect organizational policies for added charges.

Assign the Host **Storage Blob Data Contributor** and **Storage Table Data Contributor** at account scope
(admin permission/RBAC propagation required); management Contributor alone is insufficient. Then:

```sh
az storage container create --account-name "$ACCOUNT" --name dsh-state \
  --auth-mode login --public-access off
az storage table create --account-name "$ACCOUNT" --name dshstatesync --auth-mode login
```

Use current CLI/auth or the portal; never paste connection strings into commands, prompts or Git.
**Test authentication** creates/checks only the configured private container/Table, not accounts/compute,
thread opt-in, imports or models. Versioning, soft delete, lifecycle, GRS, CMK, diagnostics and private
endpoints are not requested by this setup. Policies can add them/cost. Private Blob **and** Table/DNS must
be reachable if enabled; network charges/live RBAC tests are outside emulator evidence.

Official setup references: [account create](https://learn.microsoft.com/en-us/cli/azure/storage/account?view=azure-cli-latest#az-storage-account-create),
[Table key pricing/billing](https://learn.microsoft.com/en-us/azure/storage/common/account-encryption-key-create#pricing-and-billing).

## 3. Configure authentication without putting secrets in config

Open **Cloud settings**. New threads stay OFF. Choose logged-in Azure CLI or managed identity (both data
roles, account name; optional identity client id), a connection string, or Auto (configured string first,
otherwise `DefaultAzureCredential`). Test authentication checks/creates only the private container/Table:
it does not create an account, import, execute or opt in threads.

Enter a connection string **only in the write-only password field**, backed by the Host credential
provider. It travels in authenticated RPC JSON and is cleared on submit/cancel/unmount/disconnect, never
stored in browser/settings/model prompts/logs. Blank keeps it; clearing is explicit. Read-only/unavailable
sources must be changed at their source. Never put credentials in YAML, committed `.env`, chat or native
commands. Config stores nonsecret metadata/reference names only; account name is not proof of an endpoint
chosen by a connection string. Keep `allowInsecure:false` except an explicitly selected local emulator.

Credential/account changes retire old proofs/uploaders/pollers first. Failed/uncertain writes fail closed;
retry/replace/clear explicitly or select ambient auth. Local status/Off/detach/export remain available,
without claiming a disconnected shared opt-out succeeded. Native leases are 60s, renewed every30s; cold
manual controls use finite30s leases without idle renewal and release at completion. Promotion to a Native
writer requires a fresh60s acquisition/epoch proof; a stale cold hint never downgrades/releases that owner.

## 4. First device: explicit per-thread opt-in

Select a native thread and confirm **Enable cloud sync for this thread** in its header, blank controls
or Cloud panel. This uploads **all existing history**, not just future messages. Blank history stays
pending until durable persistence materializes it. New/untracked threads always start OFF; the legacy
`defaultEnabled:true` flag is not global consent or an automatic ownership check.

Logs/attachments can contain secrets, code and host paths. Use a private trusted account: authorized
writers can rewrite history, and hashes are integrity checks, not protection against them. Azure TLS/SSE
is not client-side encryption. Upload only data permitted in that account; code/profiles/credentials are
not synchronized as project state.

Every cloud-enabled model step needs a fresh server lease/epoch/history proof, not a cached TTL or poll
result. Offline execution fails closed; explicitly detach for local continuation. Takeover cannot undo
tools already running on another device: stop other writers first. Epoch fencing protects publication,
not external side effects.

## 5. Second device: choose Local or New worktree

### 5.1 Enable the independent import-safety profile first

The destination wizard is a separate versioned flow. It is unavailable until its persistent **USER
profile** setup is verified; it does not silently fall back to another directory or the legacy importer.
Installing/upgrading a package bundle alone is not this safety proof. Stop the Host before changing
its profile, back up its configuration/data, then deliberately merge the following into that profile's
own `cordis.patch.yml` (not a file inside a versioned plugin package):

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

Use the **existing** session root and encoding. If that root uses uncompressed JSONL, keep
`compression: none`; do not convert or mix formats by changing this example. The independent guard
and public composite provider must remain configured even when another plugin is downgraded/removed.
Both `session` and `agent-loop` dependency gates matter: absent persistence alone permits the native
in-memory fallback. A missing/incompatible guard/provider must instead leave native execution
unavailable. The wizard checks the actual loaded tree and literal persistent profile overrides.
Do not remove these gates from a profile with pending destination operations to bypass a refusal.

This initial path requires trusted **local POSIX** storage and the public native flock helper. Windows
provisioning and unproven durability backends refuse before effects; network filesystems are not a
supported claim domain. Seeded initial imports remain disabled unless the production backend/capacity
path is explicitly proven/enabled; the native crash experiments are not a generic append guarantee.
No profile change, process restart, installation or deployment is performed by the wizard or tests.

### 5.2 Destination wizard

1. Prepare receiving code separately: import transfers no project files or unpublished commits. Configure
   the same Azure account, test authentication, list cloud conversations and select one exact generation.
2. Choose **Local** (default existing folder) or **New worktree**. Local never changes branch/files. New
   worktree needs compatible Worktrees, an existing ordinary permission-context thread with current Native
   Full access, a registered source folder and an exact locally available commit. No actor settings/history
   are copied and no message, helper conversation or naming/model call is created.
3. Review original SID, history watermark, folder mapping, code and branch/path. The localized immutable
   header cwd must exactly equal the selected Local folder; every historical cwd must exist inside the
   mapping. Refs are hints: resume uses observed HEAD, not an older base or a merely matching branch name.
   Missing code requires manual preparation. Dirty, different or unverified code needs separate acknowledgement.
4. Confirm **Import here**. SID reservation precedes effects; readable history and Native/project/worktree
   binding must succeed before Ready. Failure never silently substitutes Local or allocates another SID.
5. **Open history** is read-only. **Continue** separately confirms restored pending input and checks current
   model/directory/provenance/readiness, code consent, catch-up and fresh ownership. It never forces takeover.
   A persisted receipt cannot reactivate a fresh Host's writer without a new process-local Continue grant.

Reopening resumes the same operation ID/checkout; cancellation retains committed effects. Dead/uncertain
claims or an absent checkout after possible shared-ref effects require offline recovery: never delete
locks, steal on timeout or automatically recreate refs. Managed files do not back up source dirt. Same-SID
relocation is unsupported. The literal-JSON `/cloud-import` command uses this coordinator without a model.
See the [full placement/recovery contract](<acceptance/cloud-import-destination.md>) for details.

### 5.3 Legacy explicitly mapped Local import

`/cloud pull <session-id>` remains for non-destination-owned SIDs and creates no Git state. Prepare code
and explicitly map the source platform/absolute prefix to an existing Host directory (for example
`C:\work\repo` to `/home/me/repo`). Every historical cwd must exist inside its mapping; no folder is guessed.
Global edits do not retarget a destination-owned SID or its pinned mapping; use that operation's controls.

Listing creates no Agent; import/ownership/Continue remain separate. **A retained live Agent cannot cold
catch up: restart the Host, not merely the browser.** Divergent suffixes are preserved, never merged.
Incomplete artifacts cannot execute even after Off/detach. Only proven never-completed initial imports
may create a missing artifact; completed/native/uncertain copies require explicit recovery. Mapping changes
freeze publication; repair rechecks the whole forward-localized prefix without rewriting old paths.
Degraded attachments/projections require acknowledgement, which alone never turns cloud sync On.

## 6. Off, detach, conflict and removal are different

| Action | Contract |
|---|---|
| Off | Keeps local/history, attempts shared disable/fencing; offline status cannot claim cloud confirmation. |
| Keep local / detach | Explicit local-only continuation and lease release; retained cloud copy is not disabled. |
| Export | Local 0600 snapshot on tested POSIX; protect exports/Windows ACLs. No cloud change. |
| Remove | Keeps local data; tombstones root/descendants and cleans only that generation's rows/batches. |
| Resurrect | Explicit new generation from verified local data, not restoration of the deleted generation. |

Newer Off/detach vetoes older work but cannot activate partial imports or bypass destination/Continue
requirements. Destination-scoped legacy resurrection remains refused until proof-bound adoption exists.
Ordinary legacy resurrection and same-generation On for retained disabled history remain separate.
Divergence keeps both suffixes/input; choose local/export/remove, never automatic merge or overwrite.

Shared content-addressed attachments are **retained**, not garbage-collected per removed thread. Backups,
versions/soft delete and orphans can retain more bytes. Full account/container purging is a separate
administrator action. Tombstones remain until explicit new-generation upload; child publication uses the
same transaction's conditional root fence. Blob/Table have no cross-service transaction: retry sweeps
visible orphans, but late PUTs can remain after a listing. No zero-orphan/zero-retention guarantee.

### 6.1 Manifest checks, private cache and audit

The source default is now `pollSeconds=30`, as explicitly requested after the original R2 implementation.
Existing saved/configured intervals are not silently overwritten: set30 in Cloud settings and Save on
an installed Host when needed. Healthy detection is roughly0–30s plus processing, not push; failed polls
back off up to5minutes. The [30-second request/bandwidth analysis](<acceptance/azure-sync-30-second-polling.md>)
explains the10× metadata traffic and assumptions; five-minute historical estimates are not30s promises.

Idle applied/unchanged threads use fresh control metadata and **zero history downloads**, even with an
evicted cache. Materialization verifies only missing batches when a valid canonical prefix exists. Fresh
lease/epoch, local provenance, import Ready/code consent and explicit Continue still gate every execution.
Cached bytes, history pins, Git facts and audit results grant no writer permission.

After upgrading unscoped metadata or changing accounts, explicitly **Sync now** or turn **On** to confirm
that thread's current account. Automatic work stays stopped until then. Observation/audit cannot bind
consent; scope changes demote old remote checkpoints, not Native files or old-account history pins. Local
metadata v5 accepts v4; Azure/native format remains v4.

Disposable cache normally lives at `~/.dsh/azure-sync/history-cache` under the configured user-data root.
Rollback floors and scoped health revisions live separately in storage-domain unit `azure_sync_history_pins`:
back up this metadata and **never delete it to clear a cache**. Eviction removes no Native history, mappings,
journals or cloud objects. Disk reload recomputes against the fresh commitment; sidecar flags/localized
JSONL cannot prove canonical bytes. Secure disk caching currently requires Linux `/proc/self/fd`; other
platforms retain memory/pins/gates, without a disk-restart optimization claim.

Host settings: `historyMemoryBytes=134217728` (serialized weight, not heap cap),
`historyDiskBytes=536870912`, `historyJobTimeoutMs=120000` (maximum). Zero disables a cache tier. Limits are
2 materializations/4 payload transports. Increase capacity or retire unused copies when cache pressure
blocks work; it does not repeatedly re-download full history. Preparation can outlive a five-second proof
wait, but that step stays blocked and input is not resubmitted. Off/intent/runtime changes revoke owners;
real cancellation stops unowned work. Catch-up keeps live-Agent and existing authority checks.

**Verify cloud copy** or `/cloud verify [session-id]` explicitly bypasses history/index caches, downloads
committed history and reports an exact cutoff. Review the egress warning. **Attachments are not audited**;
no Agent, lease, opt-in or Continue is granted. Normal hits do not attest remote blob health. A detected
failure stays blocked across hits/restarts, including previews; repair objects and explicitly audit the
same account/generation. A healthy other-account or older concurrent audit cannot clear its failure.

## 7. Read-only Git facts, not code synchronization

Creation base differs from observed HEAD (the import default). Branch/upstream labels and sanitized
remotes are hints, not proof of transferred code, publication or ownership; verify exact available objects.
Dirty is bounded raw-content comparison, not Git status: untracked/ignored files may count, while filters,
CRLF, sparse/partial repos or limits yield Unknown. Facts can be30s old. Different/unverified code needs ack.

Probes use trusted absolute Git, fixed quoted argv and scrubbed environment: no hooks, fsmonitor, filters,
external diff/pager, lazy fetch or maintenance; no mutations/fetch/push/checkout. Cloud cwd is never probed.
Reads stay within the canonical local header/mapping scope, with verified same-checkout descendants but no
ancestor climb to recover private metadata. Unavailable scope stays unknown; final-root aliases fail closed.
Only explicit New worktree confirmation invokes guarded provisioning, never SID relocation/checkout theft.
See the [full privacy/placement contract](<acceptance/cloud-import-destination.md>).

## 8. Supported scope and enforcement boundary

- No-cwd, incompatible formats and **any** `schedule/change` history are unsupported; a later schedule
  stops sync. Do not delete history to bypass guards. Presets/models must be installed on each Host.
- Attachments need Host capability; missing/unsupported files/images degrade and block until acknowledged.
  The actual-byte cap applies to both classes before authorization/hash/PUT; over-limit refs are not uploaded.
- Required services: `sessions`, `sessionPersistence`, `storageDomain`. Missing optional attachment,
  query/projection, workspace, command, credential or model/preset capabilities remain visible limitations.
- Composer blocks are UX, not global API vetoes. The Native pre-step is the cloud backstop; arbitrary
  direct APIs/tools outside it are not globally intercepted. **Unload/uninstall stops cloud enforcement**,
  not just UI. Keep other writers idle; bounded shutdown cannot promise final upload/release. Local data
  and retained cloud copies remain. Never remove mandatory import provider/profile gates to bypass a refusal.

Literal native commands send no model prompt and never accept credentials:

```text
/cloud status | on | off | sync | pull [session-id] | verify [session-id]
/cloud map <linux|darwin|win32> <remote-prefix> <local-prefix> [--id <mapping-id>]
/cloud unmap <mapping-id> | mappings | takeover --confirm | detach
/cloud remove --confirm --retain-attachments | export | repair [--confirm-mapping]
/cloud resurrect --confirm | acknowledge-degraded | check-ownership | test-auth
```

Quote paths with spaces: no shell evaluation. Credential updates are browser-form only. Removal needs
both confirmation and attachment-retention acknowledgement; merge/overwrite actions are not supported.

## 9. Cost: workload evidence, not a bill

Use Standard LRS/Blob Hot/service-scoped Table keys. Price retained storage, write/list, read/Other
(including leases/properties), Table requests and egress separately; an EGT counts once, not per action.
Region, tax, discounts, remaining shared free egress, retention, diagnostics and networking change cost.

[Current evidence](<acceptance/azure-sync-incremental-verification.md>) meters actual SDK/Azurite
attempts, body bytes, restart/pressure and local CPU/memory without logging secrets. Idle/warm history
traffic is zero; control/lease IO remains. Cold/missing data, audits, retries/ranges/orphans are separate.
Every enabled descendant counts. Browser STATUS is local-only. [Historical inputs](<acceptance/azure-sync-cost.md>)
are not a current quote, sub-dollar guarantee or live bill. Consult current
[Blob](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/),
[Table](https://azure.microsoft.com/en-us/pricing/details/storage/tables/) and
[bandwidth](https://azure.microsoft.com/en-us/pricing/details/bandwidth/) rates.

## 10. Verification and manual acceptance still owed

```sh
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run verify
pnpm --config.ignore-scripts=true run verify
```

Verification covers credentials, strict Host/test/browser/extracted-public types, real JSONL/AgentLoop,
two-store/crash safety, loopback SDK/Azurite bytes, bundled public-client fixtures and exact archive caps.
It never installs a profile or creates paid resources. A built package/client fixture is not proof that
the running GUI or complete stock composer received it. Emulation is not live Azure RBAC/identity,
private-network/latency, billing or manual Windows/GUI acceptance.

Repository evidence (not shipped in the tarball): [baseline acceptance](<acceptance/azure-sync.md>),
[historical cost](<acceptance/azure-sync-cost.md>) and
[incremental verification](<acceptance/azure-sync-incremental-verification.md>). Live Cost
Management/invoices, physical two-device deployment and the manual platform/network checks remain owed;
never claim an actual sub-dollar bill from the emulator model.
