# @1yefuwang1/dsh-azure-sync

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

Replace example paths/profile names first. Installing changes the chosen profile; verification scripts
do not install into your running profile. Restart the **Host** after installing/removing Host code.
The package builds both Host ESM/declarations and its public browser factory; no replacement web
server or core modification is required. Local source edits are not proof that an already running GUI
has received the new bundle. No HMR behavior is promised by these instructions.

**One Host process per local state store.** Do not point two Host processes at the same JSONL/local
storage-domain directories. Plugin instances in one Host share the LocalStore metadata lane, but this
is not a cross-process lock or an atomicity guarantee for independent raw storage-domain/admin writers.
Different devices use separate local stores and share only the chosen Azure account.

## 2. Create the inexpensive Azure resources

These are **instructions to review and run yourself**, not deployment performed by the plugin/tests.
Use a dedicated StorageV2 account, private container and Table. Set an explicit region and **LRS**:
Azure CLI's storage-account SKU default is not the inexpensive choice assumed here.

Example POSIX setup, after selecting your subscription with `az login` / `az account set`:

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

**Table encryption is still enabled:** `Service` selects the default service-scoped Microsoft-managed
Table key. Account-scoped Table encryption keys are a different, more expensive transaction SKU even
when Microsoft-managed; that choice is made at account creation and is outside the cheap model below.
No customer-managed key, Key Vault, hierarchical namespace or premium/geo-redundant tier is required.
Review any organizational policies that add retention, monitoring or network resources/charges.

For token authentication, assign **Storage Blob Data Contributor** and **Storage Table Data Contributor**
to the Host identity at the storage-account scope. Management-plane Contributor alone is insufficient.
Role assignment requires appropriate administrator permissions; allow RBAC propagation time. Then:

```sh
az storage container create --account-name "$ACCOUNT" --name dsh-state \
  --auth-mode login --public-access off
az storage table create --account-name "$ACCOUNT" --name dshstatesync --auth-mode login
```

Use a current Azure CLI with the selected authentication mode, or create the same private resources
through the portal. Never paste connection strings into these example commands, prompts or Git files.
The plugin's explicit **Test authentication** can create/verify only the configured private container
and Table; it does not create the account, deploy compute, import threads or opt them in.

Default setup does not request Blob versioning, soft delete, lifecycle tiers, GRS, private endpoints,
CMK or diagnostic-log ingestion. Inspect the actual account policies before relying on this cost
model. Private endpoints are optional administration outside v1: both Blob and Table endpoints and
DNS must be reachable, and endpoint/network charges are excluded. Live RBAC/private-network tests
remain deferred, not proven by Azurite.

Official setup references: [account create](https://learn.microsoft.com/en-us/cli/azure/storage/account?view=azure-cli-latest#az-storage-account-create),
[Table key pricing/billing](https://learn.microsoft.com/en-us/azure/storage/common/account-encryption-key-create#pricing-and-billing).

## 3. Configure authentication without putting secrets in config

Open **Cloud settings** from the sidebar/panel, plugin configuration row or conversation control.
Choose one mode and save; new threads remain **OFF** in every mode:

| Mode | Host requirement |
|---|---|
| Azure CLI | Logged-in `az` identity with both data roles; set `accountName`. |
| Managed identity | A Host Azure identity with both data roles; optional managed-identity client id; set `accountName`. |
| Connection string | Enter it only in the custom write-only password field backed by the Host credential provider. |
| Auto | Configured connection string first; otherwise the SDK's `DefaultAzureCredential` chain. |

The credential reference defaults to `DSH_AZURE_SYNC_CONNECTION`. The Host credential provider and its
supported environment sources own the value. The password is sent only in an authenticated browser
RPC body and cleared on submission, cancellation, unmount or disconnect; it is not kept in plugin
settings, browser storage, model prompts or logs. A blank field keeps the credential; clearing it is a
separate explicit choice. Read-only/unavailable credential sources must be changed at their source.
Account metadata is not proof of the endpoint selected by a connection string.

The configuration keeps only non-secret settings: auth mode, account name, endpoint suffix, private
container/Table names, credential reference, polling/caps and trusted Git options. Do not store a
connection string in Cordis YAML, `.env` committed to Git, a `/cloud` command or a conversation.
The administrator-controlled reference/container/Table/suffix are read-only in the custom form.
Keep `allowInsecure:false` in production; it is only for an explicitly selected local emulator.

Auth/credential changes retire old-account proofs, uploaders and pollers before rebuilding. A pending
or uncertain credential update is **fail-closed**: explicitly retry/replace/clear the credential or
select a usable ambient mode. Status, local Off/detach and export remain available without Azure.
They do not claim that a shared cloud opt-out succeeded while disconnected.

Native active leases last 60 seconds and renew every 30 seconds. Cold manual On/sync/takeover/
inspection acquires a finite 30-second lease with no background renewal and releases it at completion.
If a native Agent appears during cold work, known cold ownership is promoted through a fresh 60-second
acquisition/epoch proof before active admission. An older cold hint never downgrades/releases an
already held native capability; normal drain/shutdown cleanup keeps its original gates.

## 4. First device: explicit per-thread opt-in

1. Select a native thread, including a **blank** one. The blank hero has the cloud checkbox; a compact
   blank corner action opens the thread controls when available. Nonblank threads use header actions.
   The Cloud main panel also has the same toggle while the conversation header is not mounted.
2. Select **Enable cloud sync for this thread** and confirm the sensitive-upload warning. This uploads
   the **complete existing history**, not just future messages. Blank/unmaterialized history can remain
   `pending-materialization` until the native persistence flush creates an artifact; pending is not synced.
3. Check status. Ordinary new/untracked threads are local-only and incur no cloud ownership checks.
   `defaultEnabled:true` is not an automatic global opt-in; the GUI default is locked OFF.

Logs and attachments can contain secrets, private code fragments, tool outputs and host paths.
Blob/Table writers can rewrite history: hashes detect corruption and inconsistent selection, **not a
malicious authorized writer**. Azure TLS/SSE is not client-side encryption. Use a private trusted account
and restrict both data roles. Do not enable this for data you cannot place in that account.

A cloud-enabled model step needs a fresh server lease/epoch/history proof. Cached TTL, advisory lease
fields and the five-minute poll cache are not execution authority. Offline cloud execution fails closed;
explicitly detach to choose local continuation instead. A takeover cannot undo tools already running
on the old device: ensure it is idle first. Epoch fencing protects publication, not external side effects.

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

1. Prepare/clone/fetch the receiving code repository separately; conversation sync does not transfer
   project files or unpublished commits. Configure the same Azure account and test authentication.
2. **List cloud conversations** and select one exact thread/generation. Listing creates no Agent.
3. Choose **Local** (default, existing folder) or **New worktree** (fresh managed checkout). Local never
   changes the folder's branch/files. New worktree requires a compatible Worktrees import capability,
   an existing ordinary permission-context thread with current native Full access, a registered source
   folder, and an exact locally available commit. That actor is not copied/bound; no message is sent.
4. Review the original SID, pinned history watermark, exact folder mapping, commit and new branch/path.
   All historical cwd directories must be present inside the selected snapshot/mapping. A selected
   logical Local folder must exactly equal the localized immutable header cwd, not merely its parent.
   Remote/base/upstream refs are location hints; default resume is the observed HEAD, not an older base.
   Missing code/ref requires manual preparation and refresh; different/unverified code needs explicit ack.
5. Confirm **Import here**. The original SID is reserved before Git/history effects, then readable native
   history is proven before legacy session metadata is published. Native/project/worktree binding must
   succeed before Ready; a failed worktree import never becomes a silently successful Local import.
6. **Open history** is read-only before explicit **Continue**. Native write promotion and the composer
   stay blocked. Continue separately confirms any restored pending input and checks current local
   readiness, catch-up and fresh cloud ownership. It does not force takeover. A saved receipt cannot
   reactivate a fresh Host's native writer without a new process-local Continue grant.

Closing/reconnecting inspects the same operation ID; it does not allocate a replacement thread or
checkout. Cancel preserves committed files/history and fences late completion. Known exact retained
history can be repaired under an explicit disabled/cancelled authority, never silently re-enabled.
Unknown/dead/uncertain claims and absent checkouts after possible shared-ref effects remain
**recovery-required**: do not delete lock/claim files, recreate refs, or assume a timeout grants ownership.
Stop competing processes and use explicit offline inspection/reconciliation; no automatic stale stealing
or generic Git cleanup is offered. Ordinary imported code files are not a backup of source-machine dirt.

The native `/cloud-import` literal-JSON command uses this same coordinator; it does not prompt a model.
Its protocol is separate from legacy `/cloud` and old catalog items remain strict v1/absent Git DTOs.

### 5.3 Legacy explicitly mapped Local import

The existing `/cloud pull <session-id>` mapping flow remains available for non-destination-owned SIDs.
It never creates Git state. A destination-owned SID is routed/refused through its recorded operation,
not re-created with a global mapping. Existing global mapping edits do not retarget pinned per-thread
destination bindings. The following describes the legacy Local mapping behavior:

1. Install the same compatible plugin/Host version, configure the same account and test authentication.
2. Recreate the code/folders **yourself**. Add an explicit mapping from the source absolute prefix and
   source platform to an existing local Host directory. For example, Windows `C:\\work\\repo` can map
   to `/home/me/repo`. Remote paths are normalized as strings; only the local result is realpathed.
3. Every historical working-directory change must map to an existing directory inside the pinned local
   root. Create missing directories or add an exact mapping; there is no guessed/lossy fallback or code copy.
4. **List cloud conversations** is a paginated catalog, not a bulk import or Agent/model resume. Confirm
   import for one exact session after inspecting its source folder and generation. Successful import warms
   native projections and refreshes the native list; open only after verified completion/acknowledgement.
5. A second device is view-only until it can obtain ownership or you explicitly confirm takeover. Stop
   the old writer before switching. No divergent merge, remote overwrite or automatic fork is offered.

If the Host already retains a stale live Agent, status becomes `remote-ahead-live` / restart required.
**Restart the Host to catch up. Closing/reopening a browser thread does not dispose that Agent.**
Cold import holds the public write handle through append, flush and forward-provenance verification;
incomplete artifacts cannot resume even after local Off/detach. Repair can create a missing artifact
only for a verified never-completed initial import, never a native/complete/catch-up copy.

Mapping changes freeze affected publication. Explicitly confirm repair only when the whole existing
localized prefix still matches; historical local paths are never rewritten. Known initial partial copies
can repair retained disabled bytes locally while preserving Off, detached state and cancellation id.
Only a later genuine On re-enables cloud publication. Degraded complete logs require explicit
acknowledgement of missing attachments/projection limitations; acknowledgement alone does not turn On.

## 6. Off, detach, conflict and removal are different

| Action | Local effect | Cloud effect |
|---|---|---|
| Off | Stops sync and permits local continuation of a complete/acknowledged log. | Retains history; attempts to disable/fence the shared manifest. Offline status discloses when unconfirmed. |
| Keep local / detach | Explicit local-only choice; releases this device's lease. | Retained remote copy is not overwritten or disabled. |
| Export | Writes a local header/cut/events JSONL snapshot, mode 0600 on tested POSIX. | None; RPC returns the path, not log contents. Protect exports/Windows ACLs yourself. |
| Remove from cloud | Keeps local history. | Tombstones the root and descendants, fences old writers and cleans only the selected generation's batch blobs/rows. |
| Resurrect in cloud | Explicit re-upload from a verified local snapshot. | Deleted→new generation/genesis; not restoration of the deleted generation. Retained disabled history uses On without resetting its generation. |

A newer Off/detach preempts older long operations. It never grants partial-import continuation.
Destination-imported copies also keep their independent destination/Continue gate: local Off cannot
bypass incomplete binding or silently activate a fresh Host's writer. Legacy resurrection remains
unchanged for ordinary legacy records; a destination-bound record cannot adopt a new cloud generation
through the legacy resurrect action until a proof-bound generation-adoption contract exists. It refuses
before Azure effects rather than retaining a stale Ready receipt for another generation.
Divergence preserves both suffixes and input; choose keep-local/export/remove explicitly, not merge.
Tombstones remain until explicit new-generation re-upload, including after an offline device reconnects.
Child publication touches the root conditionally in the same Table transaction, so old children cannot
publish through a deleted or changed-generation root.

**Shared attachments are retained after removal.** They are content/id-addressed across threads and
are not garbage-collected per session. Versioning/soft delete/backups, if separately enabled, can retain
more copies. Full account/container/Table purging is a separate administrator decision affecting every
thread using them; no automatic purge is performed. Use a dedicated account and back up local data.
Blob and Table have no cross-service transaction: visible orphan candidates are swept on retry, but a
late accepted old PUT can leave an orphan after a completed listing. No zero-orphan/zero-retention claim.

## 7. Read-only Git facts, not code synchronization

Inspect local Git facts explicitly in the thread panel; source facts are advisory catalog metadata.
They show branch/commit, detached/unborn/linked-worktree state, sanitized remote and a conservative
raw-content comparison. Unknown is preferred for filters, attributes, CRLF, partial/sparse repositories,
unsafe paths or bounded-read limits. Ignored/untracked files may conservatively mark dirty.

Read-only fact probes and generated POSIX/PowerShell advice never fetch, push, switch/rename branches
or allocate a checkout; their commands inspect local refs only and quote arguments literally. Only an
explicitly confirmed **New worktree** destination delegates fresh checkout/branch creation to the
Worktrees-owned guarded port. It never moves an existing SID, steals another checkout, changes the
source checkout, or automatically fetches/pushes/resets code. Confirm actual code/commit before tools
run; writer ownership is not proof that files match the source device.

The versioned Git context records original creation branch/base OID separately from current local
branch/HEAD and actual upstream, including a local base's upstream captured at creation. Full remote
refs and sanitized repository URLs are synced as advisory facts, not remote-publication proofs.
Import defaults to the observed current HEAD, not the older creation base. It validates a locally
available object (including one with no local branch), matches configured local remotes explicitly,
and never renders a branch/OID as a verified association merely from a matching name. Legacy readers
omit v2 storage context; old pull/catalog DTOs are unchanged. New clients obtain v2 only through the
separate negotiated import channel. Ordinary no-event Sync/drain refreshes are owner/epoch/ETag/
child-root fenced and do not invent conversation events or continuous Git polling.

Git defaults to a trusted absolute system binary, not an executable in the project/PATH. A custom
`gitExecutable` must be an administrator-trusted absolute path. Probes use fixed argv, lockless reads,
scrubbed Git/config/helper/trace environment, no fsmonitor, filters/textconv, external diff, pager,
hooks, lazy-fetch object reads in partial repos or auto maintenance. Native reads are bounded.
Only the canonical local header/mapping root is considered; cloud cwd is never a probe target.
Known original managed-creation context is looked up by the immutable native header cwd even after a
working-directory change into its descendant; current observation must still belong to that same
verified checkout/common directory. An immutable header narrower than its Git root remains explicitly
unavailable under this privacy bound: the probe does not climb to read ancestor project contents just
to recover metadata. Local import treats that unavailable comparison as unverified and requires the
separate code acknowledgment, rather than claiming a matching or restored snapshot.
Final-root aliases fail closed on fresh inspection; ancestor aliases remain allowed after realpath
containment. Cached facts can be stale for 30 seconds and filesystem changes by independent writers
are not globally atomic. Git metadata never grants model execution or cloud writer permission.

## 8. Supported scope and enforcement boundary

- No-cwd sessions, unknown/incompatible formats and any `schedule/change` history are unsupported.
  A later schedule event stops sync; schedules/unsafe descendants are not transferred. Start a new
  supported thread rather than deleting history to bypass a guard.
- Install required presets/models on each Host. Missing presets block import; model availability is
  not transferred or guaranteed. Attachments require the Host attachment capability. Missing/unsupported
  images/files degrade and block continuation until an explicit acknowledgement. The configured
  actual-byte transfer cap applies to **both** image and file data after the Host read, before
  authorization, hashing or Azure PUT; over-limit refs are not fabricated as uploaded/synced.
- Required Host services: `sessions`, `sessionPersistence`, `storageDomain`. Optional public services:
  attachments, session query/projection cache, workspace registry, commands, credentials, connection,
  preset/model availability. Missing optional capabilities are surfaced; not all hosts can warm an
  import or materialize every attachment class without a limitation.
- Composer blocks are public UX guards, refcounted and foreign-plugin-safe. Native navigation/search
  and arbitrary direct APIs cannot be globally intercepted; the Host pre-step check is the backstop.
  Commands/tools outside that model-step boundary are not globally vetoed by this plugin.
- **Unload/uninstall stops enforcement**, not just UI. Once unloaded, neither composer nor pre-step
  guards remain. Shutdown attempts a bounded final flush/release; leases can expire if cleanup fails.
  Keep other writers idle before changing enforcement. Local JSONL/attachments remain; disabling or
  uninstalling does not remove the cloud account/copies or promise a final successful upload.

Native commands (when the optional command service exists) do not send prompts or record credentials:

```text
/cloud status | on | off | sync | pull [session-id]
/cloud map <linux|darwin|win32> <remote-prefix> <local-prefix> [--id <mapping-id>]
/cloud unmap <mapping-id> | mappings | takeover --confirm | detach
/cloud remove --confirm --retain-attachments | export | repair [--confirm-mapping]
/cloud resurrect --confirm | acknowledge-degraded | check-ownership | test-auth
```

Quote literal path arguments with spaces; these commands are not a shell and never evaluate them.
Custom GUI forms also support mappings, resurrection and acknowledgement. Credential updates are
**browser-form only**, never native command arguments.
Removal requires both confirmation and the attachment-retention disclosure. Unsupported merge/fork/
overwrite actions are rejected.

## 9. Cost: a conditional design target, not an actual bill

Use **Standard_LRS StorageV2, Blob Hot and service-scoped Table encryption keys**. East US public USD
retail inputs retrieved 2026-10-19: Blob Hot LRS **$0.0208/GiB-month**, writes/list/create-container
**$0.05/10,000**, reads/Other **$0.004/10,000**; Standard Table LRS **$0.045/GB-month** and
**$0.00036/10,000 transactions**. GPv2 lease acquire/renew/release/break and Get Blob Properties are
Other, not writes. A valid Table entity-group transaction is **one billable transaction**, even when
it inserts the batch row, updates the tip and touches the root; entity throughput limits are separate.

```text
USD = 0.0208 * retainedBlobGiBMonth + 0.045 * retainedTableGBMonth
    + 0.05 / 10000 * (BlobWrites + BlobLists)
    + 0.004 / 10000 * (BlobReads + BlobOther)
    + 0.00036 / 10000 * TableBillableTransactions
```

The source checkout's measured-operation test uses actual Azure SDK HTTP attempts through loopback
proxies to real Azurite, not invented adapter-call counts. It covers unchanged polling at multiple
history sizes, cold import, native/imported ownership proofs, lease renewal, attachments, pagination,
conditional races and SDK retry/block-split sensitivity. This is **not** Azure billing evidence.

The under-US$1/month target requires explicit workload bounds, not arbitrary 1 GiB chat history:
small enabled histories (at most eight committed batches), at most one enabled **session record** per
each of two devices, counting every subagent descendant separately (this example has none), five-minute
Host polls, approximately 3,000 publications distributed over at least 375 small
thread lifetimes, 3,000 model steps and 60 active writer hours; 1 GiB average retained Blob data is mostly
attachments/inactive copies, with 0.1 GB Table allowance. Retire/turn Off old threads before they exceed
the active-history bound. The detailed model includes an operation contingency and excludes egress,
taxes and separately enabled features. Including 405 first proofs, 750 retire-Off actions, 30 cold
inspections and 730 repeated immutable attachment attempts, the current legacy-workload vectors model
**584,038 HTTP requests and about $0.279/month**, excluding the separate optional Git-v2/destination profiles. That workload assumes no forced takeovers or enabled descendant
records; count their extra operations if used. These are modeled inputs, not a guaranteed spending cap.

The separately measured one-batch explicit Git-v2 no-event refresh used **18 HTTP attempts**, including
one expected lease-object PUT and one guarded Table EGT, with **zero history batch writes**. It is not
18 extra operations for every normal turn, and these optional profiles are not folded into the legacy
monthly model. One verified-reader call is not a whole destination wizard; repeated source verification,
repair and varying history sizes add requests. See the [destination/Git-v2 cost supplement](<../../docs/acceptance/cloud-import-destination-cost.md>)
for vectors, assumptions and the deliberately excluded full deployed/two-device billing evidence.

**Unchanged Host polling currently verifies/re-downloads the whole selected history for every enabled
session.** Imported per-step proofs can read it again. More sessions/batches, shorter intervals, failed
conditional attempts, retries, pagination, attachment retention, larger download ranges or egress can
exceed US$1. The browser's 15-second STATUS poll is local-only; it does not itself renew Azure leases.
Do not use a continuously growing large conversation with aggressive polling and assume a tiny bill.

Official references: [Blob prices](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/),
[Table prices](https://azure.microsoft.com/en-us/pricing/details/storage/tables/),
[Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices),
[Table batching billing](https://learn.microsoft.com/en-us/azure/storage/tables/storage-performance-checklist#batching),
[lease billing](https://learn.microsoft.com/en-us/rest/api/storageservices/lease-blob#billing),
[REST operation classes](https://learn.microsoft.com/en-us/azure/storage/blobs/map-rest-apis-transaction-categories),
[capacity/cost planning](https://learn.microsoft.com/en-us/azure/storage/common/storage-plan-manage-costs).

## 10. Verification and manual acceptance still owed

```sh
pnpm --filter @1yefuwang1/dsh-azure-sync --config.ignore-scripts=true run verify
pnpm --config.ignore-scripts=true run verify
```

Package verification runs credential checks, strict Host/test/browser/public-consumer types, offline
unit/real JSONL/AgentLoop/two-store/crash cases, local Azurite, actual SDK client fixtures, and exact
publication checks. Source scripts also exercise extracted-tarball import/type smoke and a reproducible
cost profile. No verification command should create paid Azure resources or alter an installed profile.

The SDK bench uses actual public Cordis/renderer/locale/conversation/block/store implementations;
its blank visibility fixture reproduces pinned stock hideChrome/hero rules. It does **not** mount the
entire stock composer or prove the deployed GUI. Local emulation is not live Azure auth/RBAC/private
endpoint/latency acceptance. Windows path/PowerShell fixtures are not a Windows GUI run.

In the source checkout, the [acceptance ledger](../../docs/acceptance/azure-sync.md) and
[cost evidence](../../docs/acceptance/azure-sync-cost.md) record checked/deferred items and exact test
commands (those repository documents are not part of this tarball). Real Azure Cost Management/billing
export, live GUI/Windows, live RBAC and private-network acceptance remain explicit manual work.
Never claim an actual monthly bill below US$1 from this model or a short emulator run.
