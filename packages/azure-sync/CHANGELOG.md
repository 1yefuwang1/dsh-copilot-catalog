# @1yefuwang1/dsh-azure-sync changelog

## Unreleased — destination import extension (implemented; both final reviews approved)

- Add an explicit Local/New worktree wizard retaining the original cloud SID, separate reviewed plans
  and pre-effect reservations, pinned per-thread mappings, required native/project/managed binding,
  and read-only Open distinct from explicit Continue. No helper thread or first model prompt.
- Add an independent public persistence guard/provider with permanent user-profile dependency gates,
  runtime opaque proof/scopes, fresh local Continue activation, and cross-process SID/CWD admission.
  A package bundle/schema failure alone is not a safe downgrade barrier. The profile is not edited
  or installed automatically.
- Add an optional versioned Worktrees port for exact available-commit checkout creation and portable
  creation-base export. No automatic fetch/push/reset, dirty-file transfer or existing-SID relocation.
- Version Git metadata inside gitJson, keeping creation base/current HEAD/upstream separate and
  refreshing with owner/epoch/ETag/root fencing even without new history events. Preserve strict old
  pull/status DTOs; new import/source/admission data uses a separate negotiated v2 channel.
- Preserve cancelled effects/receipts and local disabled retained repair without cloud resurrection;
  unproven seeded/Windows/claim recovery paths refuse rather than invent success or steal stale state.
- Keep existing package byte/security bounds. Compact generated assets while preserving observable
  names; actual artifact/runtime/type/regression evidence remains a release gate.

This section is not a release or deployment claim. I1–I6 and whole-source verification have completed;
both independent GPT + Grok implementation reviews approve the accepted corrections: separate Local/
Worktree unverified-code consent and revalidation, first-On original base preservation after descendant
cwd changes, exact stale Git bytes on read failure, and neutral comparison/recovery UI wording. See the repository's
[destination acceptance ledger](<../../docs/acceptance/cloud-import-destination.md>).

## Historical working-tree checkpoint — 0.1.0 experimental v1

This was a working-tree checkpoint, **not a published release**. T1–T9 subsequently completed
verification and both required independent reviews; that historical approval does not cover the
new destination-import extension above. The repository
[acceptance matrix](<../../docs/acceptance/azure-sync.md>) records tested, pending
and deferred criteria. Live Azure, deployed GUI, Windows and actual billing are
not established by the automated evidence.

### Conversation storage and continuation

- Add the fifth standalone workspace package for DSH `0.2.1-rc.2`, Node
  `>=22.19.0`: Host ESM/declarations, public protocol, browser factory, locale,
  exact publication allowlist and leaf-only release targeting. No core changes.
- Use Azure Blob Hot LRS + Table only; lazy connection-string/Azure CLI/managed
  identity/auto authentication, private container and production TLS defaults.
  No Postgres, Functions, App Service or always-on Azure compute; the browser
  and tools still run on the local devices.
- Keep every new thread Off. Confirmed per-thread On uploads its complete prior
  history once materialized; an unmaterialized blank thread remains pending,
  never falsely synced. Off retains cloud history.
- Add canonical JSONL payload hashes, header/inherited-cut binding, generation-bound
  genesis and raw-32-byte event chains. Immutable candidate blobs precede atomic
  Table batch-row/tip/root-touch publication; linked committed selection ignores
  unchosen siblings and rejects missing/corrupt links.
- Add explicit string-first mixed-OS cwd mappings with realpath-pinned local roots,
  every historical cwd preflight and forward provenance re-read. The canonical
  imported prefix remains immutable; no reverse rewrite or lossy fallback.
- Add verified write-ahead cold import/catch-up, held write claims through flush,
  early startup claims, no synthetic closers, attachment files/aliases and probed
  no-clobber images, projection warming and workspace association. Missing assets
  or unsupported projection caching are honestly degraded; explicit acknowledgement
  is required even for a projection-only complete log with zero missing attachments.

### Ownership, recovery and authority

- Add one-writer lease/epoch fencing and a fresh server proof before **each**
  cloud-enabled model step; cached TTL/advisory mirrors do not authorize execution.
  Native active work uses a 60-second lease/30-second renewal. Idle drain waits
  for empty inbox, quiescence, flush and final suffix publication, not turn-stopping.
- Require explicit takeover with an in-flight-tool warning. Rejection requeues
  input and records a receipt; a remote-advanced suffix becomes conflict, not an
  automatic merge. Keep-local/detach, protected JSONL export and remove are the
  only conflict actions; no cloud overwrite/fork.
- Block a retained stale live Agent without opening a second native writer.
  **Host restart**, not closing/reopening a browser thread, is the supported catch-up.
- Add durable operation-bound resurrection repair, generation-scoped conditional
  cleanup and root-first descendant tombstones. Offline reconnect never silently
  resurrects; explicit deleted→new-generation re-upload is separate from retained
  disabled-history On. Shared attachments are retained after removal; late orphan
  PUTs and separately enabled retention/version features preclude a full-wipe claim.
- Guard local authority/status/progress writes in the shared LocalStore lane with
  current nonce/generation/role checks. Retired Off cleanup cannot undo a newer On;
  stale enable/import/status/resurrection cannot undo newer detach. Supported scope
  is one Host per state store with one shared LocalStore across runtime instances,
  not raw-admin/multiple-private-store or cross-process atomicity.
- Repair a missing artifact only for a verified never-completed initial import,
  anchored to its original header/cut/generation/chain. Known disabled+detached
  initial partial imports may repair retained bytes read-only while preserving Off
  and cancellation identity; no cloud activation, upload or ownership acquisition.
  Native/complete/catch-up/unanchored files are never recreated. Partial imports
  cannot resume, enable, take over or form resurrection snapshots merely after Off.

### Host and existing local Web GUI controls

- Add strict native `/cloud` commands and exact authenticated browser RPC, bounded
  request/response DTOs, cancellation, redaction, settings, mappings, paginated catalog,
  ownership checks, repair, export, removal and explicit degraded acknowledgement.
  Status/catalog/Git inspection does not resolve Agents or send model prompts.
- Keep connection strings write-only through the Host credential provider and an
  uncontrolled password ref; no config/log/model/localStorage copy. Persist a UUID
  pending-auth intent **before** provider secret commit/notification and accepted
  config only afterwards. Uncertain updates block reads/boot without unsafe rollback;
  external credential notifications synchronously suspend old admission/publication
  before bounded runtime rebuild. Local status/Off/detach/export remain available.
- Add confirmed On for blank/nonblank threads and the panel. Blank stock chrome
  uses the public hero options LIST plus a dynamic blank-only corner SINGLE that
  yields to every foreign occupant. Add settings/auth, mappings, remote import,
  conflict/degraded/repair, takeover and removal controls inside the existing GUI.
- Use conservative refcounted public composer blocks with foreign-worktree and
  shared/HMR cleanup safety; no DOM interception/private submit hook. Fifteen-second
  browser status polling is **local only**, with no idle Azure lease churn.
  Native navigation/direct APIs are not globally vetoed; Host pre-step is the backstop.

### Git, cost and verification boundaries

- Add bounded read-only Git facts from canonical local persistence cwd/scope, a
  trusted absolute binary, fixed argv and scrubbed environment. No optional locks,
  fsmonitor/hooks/filters/lazy fetch, status/diff-files, push/fetch/checkout or
  worktree mutation. Preserve Git index bytes and mtime. Unsupported partial/sparse/
  filter/normalization cases report Unknown; metadata never grants execution.
- Strictly sanitize optional published Git facts; reject raw-backslash URL and
  ambiguous SCP credential forms before parsing/publication. Helpers/local remotes
  are omitted. Arbitrary secret text inside an otherwise valid URL path cannot be
  universally recognized: treat all optional Git metadata as a disclosure.
- Add actual Azure SDK HTTP-attempt profiling through loopback proxies to real
  Azurite, distinguishing logical entity actions from one billed valid Table EGT.
  The [cost evidence](<../../docs/acceptance/azure-sync-cost.md>) uses named retained
  capacity/workload assumptions, official prices and retry/range/polling sensitivity,
  not an arbitrary-history under-US$1 guarantee or Cost Management export.
- Add extracted-tarball root/protocol/browser import and public type-consumer smoke
  against the existing pinned dependency installation, not a clean registry install.
  Tests cover real JSONL/AgentLoop/WorkingDirectory, two independent local stores,
  recreated-Host catch-up, crash/authority races, Azurite and public-SDK/JSDOM clients.
  The client bench uses real public renderer/locale/conversation/blocks/stores and
  Cordis with explicit session/config/transport/presentation fixture ports; it is
  **not** a full stock composer, deployed GUI or live Windows/PowerShell execution.
- Complete exact finite 30-second cold controls versus 60-second native leases, with
  no cold background renewal, race-safe promotion through a new epoch, preservation
  of already-held native ownership, and late/failure cleanup. Apply the same actual-byte
  transfer cap to image and file data before authorization, hashing or Azure PUT.
  T9 unit/real-SDK evidence checks these corrections; final reviews remain pending.
  See the acceptance matrix for the final gate rather than stale test totals.

### Limitations and rollback

No-cwd or schedule-bearing histories are unsupported; missing presets block import
and unavailable models require local setup. No global settings, credentials,
profiles, preset definitions, drafts, code, worktree bindings or schedules transfer.
Cloud logs/attachments can contain secrets; authorized writers can rewrite them;
TLS/SSE is not client-side encryption. Turn Off/detach deliberately before unloading
or uninstalling: removing the Host hook/client addon removes enforcement. Local
history and retained cloud data stay intact; no automatic code/Git push or purge.
Live Azure auth/RBAC/private endpoints/TLS/rotation, real two-machine GUI, Windows
and monthly billing remain deferred manual acceptance. No provisioning was executed.
