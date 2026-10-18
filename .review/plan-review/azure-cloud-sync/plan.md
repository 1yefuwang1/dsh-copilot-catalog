# Azure Cloud Sync Plugin — Plan

Plan version: **v4**
Supersedes: v3 (gemini REVISE: cache signature; gpt REVISE: client admission, lease drain, rejected-input divergence, committed refs; grok REVISE: chain anchor, committed selection, case-insensitive realpath; all at plan level)
Date: 2026-10-18 (Asia/Shanghai)
Repository: `/Volumes/external/dsh-copilot-plugin`
Session: `session-a15fdec5-b9a5-43ad-a288-1d6abe1b6f21`
Target DSH: `0.2.1-rc.2` core peers, Node `>=22.19.0`
Proposed package: `@1yefuwang1/dsh-azure-sync` at `packages/azure-sync`

This file is the only file written before user approval. No source, test, config, or tracked file has changed. `git status` is clean; the plan is under the gitignored `.review/` tree.

**Standalone implementation contract:** this v4 file is self-contained. It does not require a v1/v2/v3 snapshot, and no section refers to “as v3” for required scope, files, verification, or acceptance. Every task in §7 lists its own files, verification, and acceptance criteria; every design rule needed to implement is in §6.

---

## 1. Original user request (verbatim)

> I want to build a plugin that stores all dsh states(chat history, branch, git worktree for example. any state that makes conversation continue seaminglessly on different devices) in the cloud, a postgresdb, azure blob storage, azure table storage etc.
> When I create a new thread, or at anytime of a thread, I can toogle the cloud feature on.
>
> The goal is to be as cheap as possible. The cloud option is Azure only

## 2. Confirmed decisions from the planning dialogue

| Decision | User choice | Consequence |
|---|---|---|
| v1 scope | **Conversation + branch/worktree metadata** | Sync session logs, attachments, workspace grouping, read-only Git facts. Guidance only; never push/rewrite code. |
| Storage | **Blob + Table, no Postgres** | Session/attachment blobs, a Table manifest + linked batch index. No always-on database compute. |
| Auth | **Azure CLI token, connection string, or managed identity** | Explicit connection string, `AzureCliCredential`, `ManagedIdentityCredential`, `DefaultAzureCredential` auto mode. No secrets in config. |
| Device paths | **Mixed OS (macOS/Windows/Linux)** | String-first mapping, realpath inside the local root, explicit invertible bindings, foreign-source replay fixtures. No automatic checkout. |
| Toggle default | **Off for new threads; turning off keeps the cloud copy** | Per-thread opt-in; disabling stops sync but keeps the remote snapshot. Separate “Remove from cloud” tombstones it. |
| Concurrent devices | **One writer at a time, explicit takeover** | Per-step server ownership proof, 60 s lease, epoch fence, explicit takeover, no divergent merge. |

## 3. Revision record (v1 → v4)

### 3.1 v1 blockers

All three v1 reviewers returned REVISE. Their concerns (working-directory replay, last-event-only hashing, ownership/admission, snapshot/retry, partial imports, deletion resurrection, undecided conflict actions) were revised through v2–v4; the final designs are in §6.

### 3.2 v2 blockers

v2 fixed canonicalization, chains, and import recovery, but the v2 panel found: lossy cwd recovery, epoch-invalidated committed history, stale-orphan blocking, offline fail-open, input-consuming rejection, live-agent catch-up, and root/child delete races. v3 addressed them; v4 closes the remaining protocol gaps.

### 3.3 v3 blockers and v4 corrections

| v3 blocker | Reviewer(s) | v4 correction | Required test |
|---|---|---|---|
| `coldSnapshot` 1/2-arg signature was mandated; `0.2.1-rc.2` ships `(meta, inheritedEventCount, events)` | gemini | §6.12: runtime signature check; 3-arg call with durable localized events + settle/verify loop; 2-arg `await (id, signal)`; neither → `projection-warm-partial`. | Fake both signatures; real 0.2.1-rc.2 warm; sidebar metadata. |
| No public pre-send/pre-open veto; composer blocks are the only public API; GUI close does not dispose the host Agent | gpt | §6.6.4: public `ctx.conversation.blocks.set` (inert composer) with conservative default block; native navigation/search/direct API not intercepted; host pre-step backstop; **host restart only** for live catch-up; worktrees block coexistence/fail-closed unload. | Block/unblock, worktrees coexistence, direct API prompt requeue, host-restart catch-up. |
| Cached lease TTL is not proof after an explicit break; release at `agent/turn-stopping` is too early | gpt | §6.6.2–6.6.3: per-step server ownership verification (no cached TTL for execution); drain/release only after idle + empty inbox + quiescence + flush + final upload under the lease; takeover warns in-flight work. | Fresh A step after B break is rejected; delayed final upload handoff imports a complete turn; no synthetic closers. |
| Rejected-turn bookkeeping is a divergent suffix | gpt | §6.6.5: client blocks prevent the normal path; pre-step requeue preserves input; if remote unchanged, bookkeeping may be uploaded and input runs once; if remote advanced, mark conflict and offer keep-local/export/detach — no transparent merge or stale execution. | B advances before/during A rejection; ownership returns; no lost/duplicated prompt, no unapproved merge. |
| Candidate namespace lacks committed references; invalid/divergent siblings inside the watermark | gpt, grok | §6.5: immutable linked batch index in Table; session tip points to the last batch row; publication transaction commits batch row + tip atomically; import follows links, ignores unchosen siblings, missing link corrupt. | Divergent/invalid old-epoch siblings inside watermark; alternate chunk boundaries; valid committed import. |
| Chain anchor unused; empty chain/first batch not bound to genesis | grok | §6.4: `EMPTY_CHAIN = genesisHash`; empty manifest `chainHash=genesisHash`; first batch `prevChainHash=genesisHash`; linked index starts at `genesis`; raw-byte concatenation defined. | Empty manifest/first batch; chain fixture. |
| Strict `realpath === local` rejects case-insensitive remainders | grok | §6.3: accept the canonical path when it stays inside `localPrefixRealpath`; write that canonical path into local events; reject escapes/missing/symlink escapes; decoy preserved. | Case-different remainder on case-insensitive CI; symlink escape rejected; decoy not used. |
| Nits: prepend last-to-first; `SessionAlreadyOwnedError` banner; normalized `remotePrefix`; image never replaces valid local object; forward provenance current range | gpt, grok | §6.6.5/§6.8/§6.11: specify order, error mapping, normalization, read-verify-before-write, re-read local range every time. | Multi-message rejection; import-race banner; valid image untouched; tampered local range fails. |

## 4. Goal and success criteria

Build a fifth standalone DSH plugin that makes an opted-in conversation continue on another device, at the lowest practical Azure cost, without changing DSH core.

Success criteria:

1. **Per-thread opt-in.** Toggle on/off for existing or newly created/blank threads. Enabling uploads complete current history once materialized; disabling stops future uploads and keeps the remote copy.
2. **Cross-device continuation.** On a second device with an explicit mapping, a synced thread appears in the native list with title/activity metadata, loads complete history, resolves attachments through `ctx.attachments`, and resumes with the mapped cwd. A live stale Agent is blocked; **host restart** is the only guaranteed catch-up.
3. **Mixed-OS executable cwd.** String-first remote normalization/mapping; realpath only the local result; accepts canonical case inside the mapped root; historical cwd events localized; new ones canonicalized forward; unmappable/unstable mappings block.
4. **Branch/worktree awareness.** Read-only Git facts and shell-safe guidance; no push/fetch/checkout/worktree mutation.
5. **Single-writer execution.** Per-step server ownership proof or explicit detach; another device is view-only until takeover; every write acquisition advances `writerEpoch`; delayed commits fenced; both suffixes preserved on divergence.
6. **Crash-safe sync.** Exact payload bytes, per-event chain, genesis anchor, committed linked batch index, committed watermark, verified prefix adoption. Crash at any boundary reconciles without duplicates.
7. **No partial continuation.** Write-ahead import, early startup write claims, held handle through flush, `session/created` veto, forward provenance, projection/attachment readiness, startup repair.
8. **Deletion final until explicit re-upload.** Tombstone/generation/epoch, root/child transaction, explicit new-generation re-upload, attachment-retention disclosure.
9. **Cheap.** One Standard_LRS StorageV2 account, private container, one Table; no Functions/App Service/Postgres. Defined 1 GB/~30k-op mix under US$1 excluding egress; egress can exceed it.
10. **Safe defaults.** Private container, TLS, SSE, credential store/ambient identity, no secrets in logs/RPC, no global-config sync, disclosures for log secrets/cloud write trust.
11. **Testable/reversible.** Unit fakes, real JSONL/WorkingDirectory/AgentLoop, attachment probe, Azurite, retained-live + host-restart, client tests, `pnpm run verify`; uninstall leaves local intact.

Explicit v1 limitations:

- No-cwd sessions unsupported.
- Any `schedule/change` in history unsupported; a new one stops sync; no transfer.
- No merge; no remote overwrite/fork; keep-local/export/remove only.
- Live Agent catch-up requires **host restart**; GUI close does not dispose the host Agent.
- Cloud-enabled threads require per-step ownership proof; offline continuation requires explicit detach.
- No local session deletion; failed imports are archived/surfaced.
- Client send gating uses public composer blocks; native navigation/search/direct API cannot be globally vetoed; host pre-step is the backstop.
- No live Windows GUI test; cross-OS fixtures + manual checklist.

## 5. Scope and non-goals

In scope: session logs and subagent descendants; canonical cwd events; attachments via `ctx.attachments`; workspace reconstruction; mappings; read-only Git; toggle/blank; commands/RPC/UI; write-ahead imports/early claims/projection/chain/lease/epoch/tombstone/root-child; Blob+Table/auth; docs/tests/acceptance.

Non-goals: Postgres; raw JSONL replication; working-tree sync/auto-Git; worktrees binding recreation; schedule transfer; credential/profile/global-config sync; no-cwd; browser drafts; CRDT/multi-writer merge; local deletion; multi-tenant/relay; CMK/private endpoints/WORM by default; client E2E encryption; remote fork/overwrite; live-Agent catch-up without restart; Windows GUI live test.

## 6. Architecture

```text
┌──────────────────────────── Device A (DSH host) ────────────────────────────┐
│ ctx.sessionPersistence (any backend)              ctx.workingDirectory      │
│        ▲ create/open/read/append/flush              ▲ effective cwd          │
│  AzureSync controller                                                        │
│  ├─ LocalSyncStore                         ├─ EffectiveCwd (string-first)   │
│  ├─ BatchUploader/Reconciler               ├─ SessionImporter (write-ahead)  │
│  ├─ Admission (blocks + pre-step proof)    ├─ PathMapper/GitProbe/Projection │
│  └─ AzureStore (Blob + Table + Identity)                                     │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ HTTPS, private container
                                ▼
┌──────────────────────── Azure Storage account (Standard_LRS, Hot) ──────────┐
│ Blob `dsh-state` (private)                                                  │
│   v1/sessions/<sid>/gen-<gen>/batches/<start>-<epoch>-<hash>.jsonl.gz        │
│   v1/attachments/<base64url(id)>        v1/leases/<sid>    immutable        │
│ Table `dshstatesync`                                                        │
│   rk `session:<sid>`  manifest: tip row/blob, counts, chain, epoch, state    │
│   rk `batch:<sid>:gen-<generation>:<startSeq>` committed linked batch index │
│   rk `device:<id>` / `meta`                                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

No Azure compute.

### 6.1 Cloud schema

#### 6.1.1 Session entity

PK `account`; RK `session:<base64url(sessionId)>`.

| Property | Type | Meaning |
|---|---|---|
| `schemaVersion` | Int32 | `4`; unknown refuses |
| `sessionId` | String (bounded) | Original id |
| `generation` | Int32 | 1+; increments on resurrect |
| `writerEpoch` | Int64 | Publication fence; advances on every write-lease acquisition, toggle-off, remove, resurrect |
| `state` | String | `active`/`disabled`/`deleted` |
| `enabled` | Boolean | Shared opt-in |
| `headerJson` | String (bounded) | Canonical header |
| `headerHash` | String | Header + inherited cut |
| `inheritedEventCount` | Int64 | Fork prefix |
| `formatVersion` | Int32 | `SESSION_FORMAT_VERSION` |
| `eventCount` | Int64 | Committed events |
| `headSeq` | Int64 | `eventCount-1` |
| `headHash` | String | Last event hash |
| `chainHash` | String | Cumulative chain; `genesisHash` when empty |
| `batchCount` | Int64 | Committed batches |
| `lastBatchRowKey` | String (optional) | Tip of committed linked index; includes generation |
| `lastBatchGeneration` | Int32 (optional) | Generation of the tip row |
| `lastBatchBlobName` | String (optional) | Tip blob (for audit) |
| `cwd` | String (optional, bounded) | Canonical source cwd |
| `sourceDeviceId`/`sourcePlatform` | String | Creator |
| `workspaceTitle`/`title`/`gitJson` | String (bounded) | Display only |
| `rootSessionId`/`rootGeneration` | String/Int32 | Child fencing |
| `enabledBy`/`enabledAt` | String/Int64 | Audit |
| `lastWriterDevice` | String | Last batch |
| `updatedAt` | Int64 | Epoch ms (Int64) |
| `leaseOwner`/`leaseUntil` | String/Int64 | UI mirror |
| `deletedAt`/`deletedBy`/`previousGeneration` | Int64/String/Int32 | Tombstone |

Strings bounded to 32K UTF-16; display fields truncate. Epoch-ms use Int64.

#### 6.1.2 Batch row (linked committed index)

PK `account`; RK `batch:<base64url(sessionId)>:gen-<generation>:<000000000000 startSeq>`. **Generation is part of every batch row key, every `prevBatchRowKey`, and the session tip.** This prevents a retained generation-N start-0 row from colliding with generation-N+1 after remove/interrupted cleanup/resurrect. **Only written in the same transaction that advances the session tip.** An extra candidate blob never has a row; a row always describes committed history.

| Property | Type | Meaning |
|---|---|---|
| `schemaVersion` | Int32 | 4 |
| `sessionId`/`generation` | String/Int32 | Identity |
| `startSeq`/`endSeq`/`eventCount` | Int64 | Range |
| `blobName` | String | Exact immutable blob |
| `payloadHash` | String | Exact payload digest |
| `prevChainHash`/`chainHash`/`headHash` | String | Chain |
| `prevBatchRowKey` | String (optional) | Previous committed row in the same generation; absent = genesis |
| `createdEpoch` | Int64 | Audit only |
| `deviceId`/`createdAt` | String/Int64 | Audit |

#### 6.1.3 Device/meta

- `device:<base64url(deviceId)>` (PK `account`): `name`, `platform`, `appVersion`, `firstSeen` (Int64), `lastSeen` (Int64), `schemaVersion` (Int32).
- `meta` (PK `account`, RK `meta`): `schemaVersion`, `createdAt` (Int64), `container`, `table`, `lastSeenBy`.

#### 6.1.4 Blobs

- Batch candidate path: `v1/sessions/<sid>/gen-<gen>/batches/<startSeq>-<createdEpoch>-<payloadHashPrefix16>.jsonl.gz`.
- Metadata lowercase: `startseq`, `endseq`, `eventcount`, `prevchainhash`, `chainhash`, `headhash`, `headerhash`, `generation`, `createdepoch`, `deviceid`, `schemaversion`, `payloadhash`; read case-insensitively.
- Attachment: `v1/attachments/<base64url(attachmentId)>`; metadata `attachmentid`, `kind`, `bytes`, `mediatype`, `nameb64` (base64url UTF-8), `sha256`; no raw Unicode headers.
- Lease: `v1/leases/<sid>`.

### 6.2 Local sync domain

`dsh_azure_sync` version 4, per-record:

- `sessions`: enabled/generation/writerEpoch/state, synced counts/chain/header/ETag, status/error/timestamps, import state + expected counts/chain/mapping revision/importedThroughSeq, canonical/local cwd, remapped/needsFolder/unmappable/unstable, degraded attachments/ack, conflict path, imported/lastDevice/weArchived/detached/admissionReceipt.
- `mappings`: `remotePrefix` (normalized output), `localPrefix` (realpath), `remotePlatform`, `revision`, timestamps.
- `devices` self, `settings`.

No secrets. Domain version separate from cloud schema.

### 6.3 Effective working directory (string-first, case-safe, invertible)

DSH effective cwd is the `workingDirectory` projection: init header.cwd, apply `working-directory/change`, get state/default, ensure may append recovery.

#### 6.3.1 Binding

```text
binding = { mappingId, revision, remotePlatform,
            remotePrefix,          // normalizeRemote output, exact canonical source string
            localPrefix,           // fs.realpath(localPrefix)
            localPrefixRealpath }
```

- `normalizeRemote(p)`: pure string normalization; collapse separators; uppercase Windows drive; handle UNC; reject relative/control/`..`; preserve source case.
- `remoteToLocal(p)`:
  1. normalize remote; 2. segment-boundary prefix match; 3. substitute `localPrefix`; 4. absolute; 5. `real = await fs.realpath(local)`; 6. **accept `real` when it is inside `localPrefixRealpath`** (boundary) and is an existing directory; write `real` into the local event; 7. reject escapes, missing paths, symlink escapes, and relative paths.
- Do **not** require `real === local` solely because the source case differs from the volume’s canonical case.
- `localToRemote(p)`: realpath local first; require under `localPrefix`; substitute `remotePrefix`; normalize; require `remoteToLocal(result)` equals the canonical local path for new local events.
- Multiple matches: longest prefix; equal-length different remote prefixes → `ambiguous-mapping`; case-insensitive duplicate remote prefixes on Windows → `ambiguous-mapping`.
- Binding immutable per session; editing/removing stops sync until re-confirmed; imported history is never re-mapped in place.

#### 6.3.2 Import

- Resolve/validate the binding for the header; validate every historical `working-directory/change`:
  - map; realpath; canonical path inside `localPrefixRealpath`; existing directory; no escape.
  - missing → `needs-folder`; unmappable → `unmappable-cwd`; escape/symlink escape/ambiguity → `mapping-unstable`/`ambiguous-mapping`; no local session created.
- **No lossy recovery.** The user must create the missing directory or add an exact mapping.
- Localize each historical cwd event forward from its canonical event; keep the canonical event for chain identity; local header cwd is the canonical local path, fixed after create.

#### 6.3.3 Upload

- New local change events: realpath → `localToRemote`; require round-trip/canonical local; outside binding → stop sync `cwd-unmappable`.
- `ensure()` recovery to local header cwd maps to canonical header cwd; if not invertible, pause.
- Canonical header for a locally created session is its local header; imported sessions keep the cloud canonical header.
- Forks use the child’s binding; forward canonicalization.

#### 6.3.4 Forward provenance

After import/incremental append: read the local range, compare to forward-localized canonical events (realpath applied consistently), not reverse mapping. Current range is re-read and verified every time; never substitute “trusted remote history” for a local read.

#### 6.3.5 Tests

Missing subdir → no import; case-different remainder accepted on case-insensitive CI; symlink escape rejected; ambiguous mapping rejected; decoy not used; Windows-source→POSIX resume/tool; exact canonical chain after restart/re-upload; no plugin system reminder.

### 6.4 Canonical events, payload bytes, chain anchor

#### 6.4.1 Canonical JSON/payload

- `read()` returns `{ eventState, events }`; use `{ events }`.
- Preserve every event field. `canonicalJson` strips `undefined` object properties, rejects top-level undefined/functions/symbols/BigInt/NaN/Infinity/cycles/non-plain objects, sorts keys, preserves arrays, UTF-8.
- Payload bytes: `concat(canonicalJson(event) + "\n")` for each event in seq order; no extra trailing newline; `payloadHash = SHA-256(payloadBytes)`. Gzip decompresses exactly to this.

#### 6.4.2 Genesis and empty chain

```text
headerHash = SHA-256("header\0" + canonicalJson(canonicalHeader) + "\0" + inheritedEventCount)
genesisHash = SHA-256("dsh-azure-sync\0" + schemaVersion + "\0" + sessionId + "\0" +
                      generation + "\0" + headerHash)
EMPTY_CHAIN = genesisHash
```

- Empty manifest: `eventCount=0`, `chainHash=EMPTY_CHAIN`, `batchCount=0`, no tip.
- First batch: `prevBatchRowKey` absent, `prevChainHash=EMPTY_CHAIN`.
- Every later batch: `prevChainHash=previous.chainHash`, `prevBatchRowKey=previous row key`.
- `genesisHash` is used, not decorative.

#### 6.4.3 Per-event chain (raw 32-byte digests)

```text
chainBytes = bytes32(prevChainHash)          // storage hex -> 32 raw bytes
for event in batch:
  ensure event.seq == expected
  eventHashBytes = SHA-256("event\0" + canonicalJson(event))   // 32 raw bytes
  chainBytes = SHA-256(chainBytes || eventHashBytes)           // 32 raw bytes
batch.prevChainHash = prevChainHash          // hex storage, unchanged
batch.chainHash = hex(chainBytes)
batch.headHash = hex(eventHashBytes(last))
batch.payloadHash = hex(SHA-256(payloadBytes))
batch.createdEpoch = current writerEpoch (audit only)
```

`rawBytes` means the 32-byte digest, **not** its 64-character hex ASCII. Hex is storage/display only. Concatenation is `chainBytes (32) || eventHashBytes (32)` before SHA-256. History validity checks generation/header/inherited/start/end/chain/payload only. `createdEpoch` is never compared with current epoch.

### 6.5 Publication, committed linked index, epoch fence

#### 6.5.1 History vs fence

- `writerEpoch` is the publication fence; every **write-lease acquisition** advances it atomically. Delayed prior-owner commits fail.
- Committed batch rows/blobs are valid under the same generation/header/chain regardless of current epoch/takeover.
- Import never checks `createdEpoch == writerEpoch`.

#### 6.5.2 Committed linked index

- A session tip points to `lastBatchRowKey`/`lastBatchGeneration`.
- Each batch row points to `prevBatchRowKey` in the **same generation** and its exact `blobName`/`payloadHash`/`prevChainHash`/`chainHash`.
- **Publication is one same-partition Table transaction:**
  - create the `batch` row (`gen-<generation>:<startSeq>`) with a Table **insert-if-absent** operation (`insertEntity`, 409 when the row exists), not blob `If-None-Match` semantics,
  - update the session tip (`lastBatchRowKey`, `lastBatchGeneration`, `lastBatchBlobName`, counts, chain) with `If-Match` ETag, requiring the current `generation`/`writerEpoch` and `state=active`,
  - for a child, include the root row conditional/touch in the same transaction (root active + generation).
- Blob first; transaction second. A crash leaves an uncommitted blob candidate and no row/tip; it is ignored.
- Extra candidate blobs (old epoch, divergent, corrupt, alternate chunking) may sit beside committed blobs; they have no row and are never imported.
- **Generation-scoped cleanup:** delete/resurrect only deletes batch rows/blobs whose row key/property matches the target generation and whose session ETag/tombstone condition matches. A delayed old-generation cleanup can never delete a new-generation row; a retained old-generation row at the same startSeq cannot collide with a new-generation row.
- Delete is idempotent: repeat the generation-scoped sweep after a crash; a resurrect that races cleanup creates new-generation keys, and old-gen cleanup is rejected by the generation/ETag condition.

#### 6.5.3 Import selection

- Read the session tip (`lastBatchRowKey` includes the generation); follow `prevBatchRowKey` links **within that generation** to genesis; collect exactly those committed rows.
- Verify generation/header/chain/row links/payload hashes; fetch the exact `blobName`s.
- A missing row/link/blob or chain mismatch → corrupt.
- **Unchosen siblings are ignored, not corrupt.** A retained old-generation row is not part of the current tip chain and is ignored.
- A committed range is tiled exactly `[0,eventCount)` and ends at manifest `chainHash`.
- Test divergent/invalid old-epoch siblings inside the watermark, a retained old-generation start-0 row, delayed cleanup, and alternate chunk boundaries; valid history still imports.

#### 6.5.4 Upload

1. Make local log durable (`sessionPersistence.flush()` service-wide, not the parallel event), open read, read from manifest `eventCount`.
2. Read manifest/ETag; deleted → stop; generation/header mismatch → reconcile/stop.
3. Reconcile the committed tip: if the session tip already advanced, read the linked rows; if local is a prefix, import/continue; no adoption from unchosen candidates.
4. Read a candidate at the next start; verify full payload/chain/header/generation. It is adoptable only if `prevChainHash == manifest.chainHash`, its row chain is valid, and its events are a prefix of local canonical events. `createdEpoch` is irrelevant. Adopt the **longest** verified prefix by committing the linked row/tip transaction; otherwise ignore it.
5. Build the next batch (max 1,000 events/3 MiB before gzip), canonicalize cwd events, compute chain/payload hash, `putBlobIfAbsent` with lowercase metadata.
6. Commit the batch row + tip transaction (current epoch/generation, ETag). On 412/409, re-read, re-reconcile, retry up to 3; then conflict.
7. Repeat; release upload lease; warm cold projections; mark synced.

#### 6.5.5 Tests

- Committed prefix survives takeover/toggle/expiry; import verifies it.
- Stale/divergent/old-epoch candidate inside watermark ignored; valid committed import succeeds.
- Delayed old-epoch commit rejected.
- Crash after blob/before transaction; after transaction; alternate chunk sizes; concurrent upload/import.
- Empty manifest/first batch bound to genesis.

### 6.6 Ownership, admission, and leases

#### 6.6.1 Server ownership proof (no cached TTL for execution)

- A cloud-enabled model step requires a **fresh server-verified ownership proof**: acquire/renew the lease and read the current manifest epoch immediately before admitting the step.
- No `held TTL` cache is accepted for execution; a cached lease may be invalid after an explicit break.
- If the proof fails because another owner/epoch → reject/requeue; if the network is unavailable → reject `ownership-unverified` (no fail-open); the user may explicitly detach.
- Ordinary non-cloud sessions bypass all checks/network.
- The 60 s lease/30 s renewal is for other devices and long steps; each pre-step still proves freshness.
- Takeover warns that an in-flight step/tool on the old device may finish; the epoch fences publication, not local side effects. The user should ensure the old device is idle; a forced takeover accepts this residual.

#### 6.6.2 Lease lifecycle and epoch

- 60 s lease; renew 30 s during active work; acquisition advances `writerEpoch` atomically with the manifest update.
- Non-live uploads use a 30 s lease and advance the epoch.
- **Do not release at `agent/turn-stopping`.** Release only after:
  1. `agent/status` is idle (the loop has appended `turn/end` and drained);
  2. `inbox.nextTurn`/`nextStep` are empty;
  3. a quiescence window (2 s) with no new `session/event`/append;
  4. `sessionPersistence.flush()` succeeds;
  5. the final suffix is published under the held lease (linked row/tip transaction).
- `drainAndRelease` retries; on upload failure it keeps the lease and marks `drain-failed`; it does not release into an incomplete handoff. After lease expiry, a takeover may proceed; A's unpublished suffix conflicts and is preserved.
- The drain re-checks an **activity/admission generation** after every awaited flush/upload: if a new turn, step, inbox item, or session event appeared while the drain was awaiting, it aborts the release, returns to active renewal, and restarts the quiescence window. A race test covers a new turn arriving during the final upload; its lease must not be released.
- Tests: immediate A→B handoff with a deliberately delayed final upload — B cannot acquire until A's drain/final commit; imported history has a complete turn and no synthetic closers. Forced break while A delays: A's next pre-step proof fails; its suffix conflicts; both preserved.

#### 6.6.3 Takeover

- Explicit takeover breaks/awaits the lease, acquires, advances epoch.
- The old device's next per-step proof fails (no 30 s grace for execution).
- The UI warns about in-flight tools; no merge; both suffixes preserved.

#### 6.6.4 Client admission via public composer blocks

- There is **no public pre-send/pre-open veto**. The supported client mechanism is `ctx.conversation.blocks.set(sessionId, { reason })`, which makes the composer inert.
- Strategy:
  - For every cloud-enabled session, set a conservative block until a fresh ownership/manifest check says this device owns it and the local log is current. Clear only then.
  - Block reasons: `checking-ownership`, `remote-active`, `remote-ahead-live`, `import-incomplete`, `degraded`, `ownership-unverified`.
  - Disabled/detached sessions are unblocked.
- Native sidebar/search/direct API entry is **not intercepted**; history may open. The block applies when the client knows the session; the host `agent/pre-step` is the backstop.
- Worktrees coexistence: use a refcounted block helper; never clear/overwrite another plugin's block. If another block exists, add our reason only through the shared helper; if not possible, leave the foreign block and rely on pre-step.
- Unload: remove our blocks; fail-closed for the remaining process is not possible after unload, so document that unloading is an explicit decision to stop enforcement and the last device releases leases on shutdown.
- A version-pinned internal submit adapter is **not used in v1**; if ever, it must be explicitly version-gated with unsupported/failure fallbacks. Native navigation cannot be assumed intercepted.
- `session/created` veto: synchronous, only for `importState != complete` (partial log); no network; blocks resume.
- Host admission checks **manifest freshness** (per-step proof), not the 5-minute listing cache. The client block is UX; pre-step is security.

#### 6.6.5 Input-preserving rejection and conditional recovery

- Pre-step is after `turn/start`, inbox claim, and prompt assembly. On rejection:
  1. prepend `payload.messages` back to `agent.inbox` `next-turn` **last-to-first** (public `Inbox.prepend`), so the original order is restored;
  2. fallback append + loud status if prepend fails;
  3. record a durable `admissionReceipt` (reason/message ids/turn/step/seq range) and show a UI banner;
  4. return `{kind:'reject'}`.
- Recovery is **conditional**:
  - If the remote manifest has not advanced beyond the common prefix, the local bookkeeping (turn/start, claim, reinsert, turn/end) may be uploaded after ownership returns; the input runs exactly once; the empty turn is recorded.
  - If the remote advanced (B appended from the common seq), A's bookkeeping is a divergent suffix. Mark `conflict` immediately; preserve input + local suffix; offer keep-local/export/detach; do **not** merge or execute stale state. The promised “runs once” applies only to the no-advance case.
- The normal GUI path is blocked by composer blocks; the fallback covers native/API bypass.

### 6.7 Live vs cold catch-up

- Cold: remote-ahead suffix import uses `open('write')` + append + flush + warm.
- Live idle: the Agent retains the write handle; the plugin cannot dispose an Agent it does not own.
  - Never `open('write')`.
  - Mark `remote-ahead-live`; set a composer block; pre-step rejects/requeues.
  - **Restart the DSH host** to load remote updates. Closing the GUI thread does **not** prove host Agent disposal; `SessionReference.release` is client-only. Do not promise close/reopen.
  - After restart, early startup and cold catch-up run.
- Test retained-live block; host-restart catch-up; no stale execution.

### 6.8 Import protocol

State machine: planned → creating → appending → attachments → warming → complete, plus degraded/failed.

1. **Preflight**: schema/format/header/generation; reject no-cwd/schedule/preset; invertible binding; every historical cwd exists and realpath is inside the local root; no lossy recovery; verify committed linked rows/blobs.
2. **Early startup claims**: plugin `apply` loads records and opens/holds a write handle for every existing incomplete import **before** the API/UI can resume. Test/log boot ordering. `SessionAlreadyOwnedError` → `import-race` repair banner; do not append closers.
3. **Write-ahead**: persist planned/expected count/chain/mapping revision.
4. **Create**: `sessionPersistence.create(localizedHeader, { inheritedEventCount })`; persist creating; hold handle.
5. **Append**: append verified linked batches in order; update importAppendedCount; hold handle through flush.
6. **Flush**: `await handle.flush()`.
7. **Forward provenance**: after each batch/flush, read back the current local range and compare to forward-localized canonical events (canonical JSON; realpath consistent). Re-read every time; never substitute remote history. Store importedThroughSeq.
8. **Attachments**: materialize through `ctx.attachments`; image: if a valid local object already exists (`readImage` success), do not replace it; otherwise capability-probe write+verify; files via `saveFileStream` aliases. Missing → degraded; resume blocked until acknowledged.
9. **Warm projections**:
   - `sessionQuery.observeSession(id, { projectionMode: 'all' })`; dispose.
   - Cache `coldSnapshot` runtime check:
     - `length >= 3`: `coldSnapshot(localHeader, inheritedEventCount, durableEvents)`; then poll `cachedSnapshot(localHeader)` (e.g., 20 × 50 ms) because `put` is fire-and-forget.
     - `length <= 2`: `await coldSnapshot(sessionId, signal)`.
     - TypeError → try the other signature.
     - Neither → `projection-warm-partial`.
   - Verify `cachedSnapshot(localHeader)` and `sessionController.list()` metadata; only then complete.
10. **Workspace**: create/attach with the same realpath; warnings only.
11. **Complete**: persist complete/synced counts/chain/header; clear temp; close handle; unarchive if we archived; notify.
12. **Guards**: `session/created` veto for incomplete; pre-step reject for incomplete/degraded.
13. **Repair**: use the held handle (or reacquire early); verify forward provenance; append remainder; flush; close. Failed → archived/failed + repair/export.
14. **Crash tests**: create/append/flush/attachments/warm; resume appends no closer; repair; no duplicates.

### 6.9 Deletion, generations, root/child fencing

- Tombstone: state deleted, enabled false, epoch++, previousGeneration, keep row; delete current-generation batch rows/blobs and the lease; attachments retained. All deletes are generation-scoped and conditional on the tombstone/ETag.
- Child rows carry rootSessionId/rootGeneration.
- Child publication transaction includes root row check/touch (state active, generation match, ETag); a child cannot commit under a tombstoned/old-generation root.
- Root delete: tombstone root, sweep descendants, tombstone each, delete current-generation rows/blobs; no new child after step 1.
- Resurrect: generation++ and epoch++; new generation-scoped chain/tip; explicit user action; old children cannot publish; new children use the new generation.
- Offline device sees tombstone/generation; stops; never auto-resurrects.
- Tests: remove → crash before index cleanup → resurrect; delayed old-generation cleanup concurrent with new-generation publication; root-delete vs new child; no active descendant; offline reconnect; resurrect; old-gen rows never collide/block new-gen rows.

### 6.10 Divergence actions

Keep local; export local JSONL (0600); remove cloud copy (tombstone). No overwrite/fork. Remote copy remains on other devices.

### 6.11 Attachments

- Optional service; absent → attachments-unavailable; logs sync, attachments skipped/disclosed.
- Scan all event shapes for `attachmentId` + mediaType/name; dedupe upload bytes by id; materialize file `(id,name)` aliases.
- Upload image via `readImage`; file via `readFileStream`; stream to Blob.
- Import image only when `imageHostPath(ref)` returns a path:
  - If `readImage(ref)` already succeeds locally, do **not** replace the valid object.
  - Else `mkdir(parent, {recursive:true, mode:0o700})`, temp `0o400`, link/rename, `readImage` verify.
  - `imageHostPath` throwing/undefined/probe failure → `attachment-unsupported` degraded; no raw write.
  - Do not use `saveImage` (re-normalization/id change).
- Import file via `saveFileStream`/`saveFile`; verify returned id/bytes; creates canonical + alias.
- Missing/degraded blocks resume until acknowledged.
- Blob metadata name base64url; no raw Unicode.
- Tests: round-trip, aliases, existing valid image untouched, missing/undefined degrade, mode, Unicode.

### 6.12 Projection cache warming

- `sessionController.list()` reads `sessionProjectionCache.cachedSnapshot(header)`.
- `observeSession` hydrates prepared state but does not write a checkpoint.
- Dual-signature `coldSnapshot` as in §6.8(9): 3-arg (0.2.1-rc.2) with durable localized events + settle/verify; 2-arg await; neither partial.
- Verify `cachedSnapshot` and list metadata; `projection-warm-partial` if no write path.
- Client refreshes on import/warm counter.

### 6.13 Blank/unmaterialized threads

- Header action blank/non-blank; toggle stores pending intent; materialize via service flush; retry read; pending not synced; command events included; no-session-id uses default; tests.

### 6.14 Guarded classes

- No-cwd refused.
- Any schedule/change refused; every upload/suffix import rescans and stops without transfer; descendants not imported; remediation new thread.
- Latest `agent-preset/selected` fallback header; preset-missing blocks.
- Latest model selection; model-unavailable warning.

### 6.15 Git

Read-only probes; `GIT_OPTIONAL_LOCKS=0`/`--no-optional-locks`; sanitized URLs; POSIX/PowerShell quoting; `--`; no mutations; index mtime test; non-Git null.

### 6.16 Lifecycle, polling, failure

- Startup: config/auth, local domain, early incomplete-import claims, device/container/table, background repair/pull, pollers.
- Live: per-step ownership proof; event upload debounce; flush; idle drain/final upload/release; dispose; timers.
- Failure: no fail-open; ownership-unverified rejects/detach; transient backoff; auth stop; conflict/corrupt/schedule/no-cwd/preset stop; lease lost stop; shutdown flush/release 5 s; no synced while pending/degraded/warming.
- Cloud publication never blocks disabled threads; a cloud-enabled step waits for bounded per-step proof (~3 s).

### 6.17 Host surfaces

`/cloud status,on,off,sync,pull,map,unmap,mappings,takeover,detach,remove,export,repair`; RPC status/action (toggle/sync/pull/takeover/detach/remove/resurrect/map/unmap/set-auth/test-auth/export/repair/acknowledge-degraded/check-ownership/set-defaults); browser-peer/bounded/redacted; remove confirmation/attachment disclosure.

### 6.18 Client surfaces

Header action blank/non-blank; composer blocks (refcounted); settings/auth/mappings/remote/import/conflict/degraded/detach; status poll 15 s; `ctx.sessions.refresh()` on counter; locale; no secrets; unload clears our blocks.

### 6.19 Security/trust

Private container/TLS/SSE; credentials store/ambient; redaction; untrusted cloud data validation; mapping restrictions; read-only Git; no global config; disclosures (logs may contain secrets; writers can rewrite history; attachments retained; command/tool bypass pre-step).

### 6.20 Cost

Blob Hot LRS ~$0.0208/GB-month; Table ~$0.045/GB-month + $0.00036/10k; leases other ops. Mix 1 GB/30k ops ~$0.02–0.10 excluding egress; egress can exceed. The linked-index transaction adds one batch-row insert + one tip update per batch (counted in Table ops) and one row read per imported batch (counted in reads); the cost table includes them. Postgres ~$12.41/month rejected. No continuous 20 s loop; 60 s/30 s active; per-step proof adds bounded lease/read ops. Official links: https://azure.microsoft.com/en-us/pricing/details/storage/blobs/ and https://azure.microsoft.com/en-us/pricing/details/storage/tables/. Latency targets; T9 model, not monthly-bill proof.

## 7. Tasks

**Order and dependencies:** implement sequentially in plan order T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9. Hard dependencies: T2←T1; T3←T2; T4←T3; T5←T3,T4; T6←T5; T7←T6; T8←T2,T3,T7; T9←all. Do not start a dependent task before its prerequisite is approved. If the user later authorizes parallel work, these dependencies are still hard gates; only independent verification/docs work may overlap.

### T1 — Scaffold/tooling/config/auth/Azure

**Outcome:** buildable fifth leaf, all repo tooling updated for five packages, strict config/auth/Azure adapters.

**Files:** `packages/azure-sync/{package.json,tsconfig.json,tsconfig.client.json,cordis.patch.yml,README.md,CHANGELOG.md,LICENSE,icon.svg,locale/en.json}`; `src/{index.ts,config.ts,runtime.ts}`, `src/auth.ts`, `src/azure/{blob.ts,table.ts,lease.ts,errors.ts}`; `pnpm-workspace.yaml`, `scripts/{workspaces.ts,check-pack.ts,check.ts,release.ts,check-secrets.ts}`, `scripts/test/workspaces.test.ts`, root `package.json` description, root `README.md`, `pnpm-lock.yaml`.

**Verification:** `pnpm install --frozen-lockfile --ignore-scripts`; build; typecheck; unit tests; `pnpm run check:secrets`; `pnpm --filter @1yefuwang1/dsh-azure-sync run test:pack`; `pnpm run test:tooling`; `pnpm run verify` for existing leaves.

**Acceptance:** config validates auth mode/endpoints/container/table/caps/poll; lazy connection-string/CLI/managed-identity/auto providers with redaction; typed Azure wrappers; five-leaf `workspaces.ts`/release/workspaces.test/check-pack/check; root docs say five; exact pack allowlist/size; required `inject` (`sessions`, `sessionPersistence`, `storageDomain`) and optional capabilities (`attachments`, `sessionQuery`, `workspaceRegistry`, `commands`, `credentials`, `connection`, `agentPresets`, `llm`, `sessionProjectionCache`) documented; no lifecycle scripts.

### T2 — Schema, canonical bytes, chain, cwd, committed index

**Outcome:** validated schemas and pure primitives for cloud/local records, events, chains, committed batch rows, mappings, imports, guards.

**Files:** `src/schema.ts`, `src/sync/{canonical.ts,chain.ts,effective-cwd.ts,committed-index.ts,import-state.ts,guards.ts}`, `src/local/store.ts`; tests for each.

**Verification:** unit tests; typecheck; cross-platform path fixtures.

**Acceptance:** `canonicalJson` strips undefined/rejects non-JSON; exact `canonicalJson(event)+"\n"` payload and `payloadHash`; genesis/EMPTY_CHAIN/first-batch binding; raw 32-byte chain concatenation (hex storage only); linked `batch` rows include generation in key/prev/tip; empty/first/divergent-sibling fixtures; string-first case-insensitive realpath-inside-root with escape/decoy rejection; normalized `remotePrefix`; forward-provenance current-range verification; guards no-cwd/schedule/preset/model; Int64 timestamps, 32K string bounds, lowercase blob metadata, Unicode `nameb64`; local domain v4.

### T3 — Upload, materialize, admission, lease/epoch/drain

**Outcome:** crash-safe incremental upload, blank materialization, server ownership proof, drain-before-release, input-preserving fallback.

**Files:** `src/sync/{uploader.ts,batcher.ts,scheduler.ts,lease-manager.ts,admission.ts,session-source.ts,lease-drain.ts,committed-index.ts}`, hooks in `index.ts`; tests `uploader`, `admission`, `lease`, `blank`, `drain`, `crash-upload`, Azurite.

**Verification:** fake + real JSONL + Azurite.

**Acceptance:** service flush/read result; empty unmaterialized stays pending; candidate namespace `<start>-<epoch>-<hash>`; blob first then Table **insert-if-absent batch row + tip If-Match** transaction; committed history independent of `createdEpoch`; every write acquisition advances epoch; per-step server proof (no cached TTL for execution); 60 s lease/30 s renewal; drain only after idle + empty inbox + 2 s quiescence + flush + final suffix publish; no release at `agent/turn-stopping`; input requeue last-to-first + receipt; blank toggle; schedule/no-cwd guards on upload; delayed handoff/forced-break tests.

### T4 — Import, attachments, provenance, projection, early claims

**Outcome:** complete cross-device materialization with no partial/stale continuation.

**Files:** `src/sync/{importer.ts,attachments.ts,projection-warmer.ts,recovery.ts,workspace.ts}`; tests `import`, `attachments`, `projection`, `recovery`, `working-directory`, `agent-resume`, cross-OS fixtures.

**Verification:** real JSONL + WorkingDirectoryService + AgentLoop; fixture/real attachment store; Windows-source→POSIX CI.

**Acceptance:** preflight rejects no-cwd/schedule/unmappable/unstable/preset; binding validation no lossy recovery; early startup write claims + boot order (no closer on resume); `SessionAlreadyOwnedError` → repair banner; write-ahead states/held handle/flush; forward provenance re-reads current range; dual `coldSnapshot` signature + settle/verify `cachedSnapshot`; image no-replace/valid probe; file aliases `(id,name)`; workspace realpath; subagent depth order; crash injection after create/append/flush/attachments/warm.

### T5 — Reconciliation, generations, tombstones, live block, poller

**Outcome:** convergence/safe stop, generation-safe deletion, retained-live handling.

**Files:** `src/sync/{reconciler.ts,conflict.ts,tombstone.ts,poller.ts,live-guard.ts}`; tests `reconciler`, `prefix`, `tombstone`, `takeover`, `poller`, `live`, `two-store`, Azurite transactions.

**Verification:** table-driven + two-store + retained-live AgentLoop + host-restart + Azurite.

**Acceptance:** linked-index import ignores unchosen siblings; missing link corrupt; committed prefix survives epoch changes; generation in every batch key/tip/cleanup; remove→crash→resurrect and delayed old-gen cleanup; root/child transaction no active descendant; offline no resurrection; explicit resurrect; live `remote-ahead-live` block/no `open('write')`/host restart; conflict actions keep-local/export/remove; cold-append projection warm.

### T6 — Host commands, RPC, settings, credentials

**Outcome:** complete control surface with gates.

**Files:** `src/{commands.ts,rpc.ts,settings.ts,controller.ts}`, `locale/en.json`; tests `commands`, `rpc`, `settings`, `types/consumer`.

**Verification:** unit/RPC security/type-consumer.

**Acceptance:** `/cloud` status/on/off/sync/pull/map/unmap/mappings/takeover/detach/remove/export/repair; RPC browser-peer/bounded/redacted; check-ownership/detach/repair/export/acknowledge; remove confirmation + attachment disclosure; no unsupported conflict actions; secrets write-only; works without optional services.

### T7 — Client UI, blocks, blank, settings, build

**Outcome:** usable GUI with public composer blocks.

**Files:** `client.ts`, `client.types.d.ts`, `tsconfig.client.json`, `dist/client.js`, manifest exports/`dsh.client`, tests `client`, `client-protocol`, `types/sdk-client`; `scripts/check.ts` identity.

**Verification:** build, jsdom/React, protocol, pack, manual GUI.

**Acceptance:** header action blank/non-blank; refcounted `ctx.conversation.blocks` inert composer with conservative default block; worktrees coexistence; unload clears our blocks; restart-only live message; settings/auth/mappings/remote/import/conflict/degraded/detach; refresh on import counter; locale; no secrets; no DOM interception.

### T8 — Git metadata and shell-safe guidance

**Outcome:** read-only Git facts/guidance.

**Files:** `src/git/{probe.ts,sanitize.ts,guidance.ts}`; tests with temp repos.

**Verification:** unit/integration; Windows path fixtures; index mtime.

**Acceptance:** fixed argv/timeout/bounds; sanitized remote; `GIT_OPTIONAL_LOCKS=0`/`--no-optional-locks`; POSIX/PowerShell quoting/`--`; no push/fetch/checkout/worktree mutation; index mtime unchanged; non-Git null.

### T9 — Docs, packaging, integration, acceptance, cost

**Outcome:** installable/documented with evidence.

**Files:** package README; root README/CHANGELOG; `.review` evidence; optional real-Azure acceptance.

**Verification:** full `pnpm run verify`; Azurite; two-store; retained-live + host restart; crash injection; pack; manual checklist (auth, toggle/blank, cross-OS, attachments, takeover, conflict export, remove/tombstone/offline, root/child, cost).

**Acceptance:** zero-to-synced README; cost/security/limitations; all criteria checked/deferred; no core changes; uninstall/rollback; no monthly-bill claim from short meter sample.

Ledger: T1 approved; T2 approved; T3 approved; T4 approved (host AgentLoop/WorkingDirectoryService fixture explicitly waived by user; real JSONL import covered); T5 in progress (core modules/tests only); T6–T9 pending.

## 8. Risks/assumptions/rollback/rejected

Risks: wrong cwd; tampering; concurrent writers; cached proof/in-flight tools; live stale agent; partial import; root/child; attachment contracts; projection cache; schedule/no-cwd/preset; offline; secrets/cloud trust; cost/egress; tooling; Azurite drift. Mitigations per §6 and tests.
Assumptions: one storage account; compatible DSH; sequential use; explicit folders; Git optional; attachments present; schedule unsafe; prices vary.
Rejected: Postgres; raw JSONL; backend replacement; append blobs; CRDT; last-writer-wins; whole-home/tree; Azure compute; auto-Git; remote fork/overwrite; model toggle; client E2E; internal pre-submit ABI.
Rollback: disable/uninstall; local intact; tombstone/remove; exports; unknown schema refuses; revert commit.

## 9. Verification

Unit; real persistence; real cwd/AgentLoop/cross-OS; attachments; cloud/Azurite; two-store/retained-live/restart; crash injection; client; tooling/pack; manual Azure. Definition of done: all tasks approved by all three reviewers and user; verify/Azurite/two-store/retained-live/restart/crash green; criteria checked; residual risks.

## 10. Review record

| Round | Model | Verdict | Plan changes |
|---|---|---|---|
| v1 | all three | REVISE | v2 |
| v2 | gemini APPROVED; gpt/grok REVISE | mixed | v3 |
| v3 | gemini REVISE; gpt/grok REVISE | REVISE | v4 |
| v4 delta | gpt-6.1-sol | APPROVED | B1/B2 fixed; editorial nits applied |
| v4 delta | gemini-4-argon | APPROVED | no blockers/nits |
| v4 delta | grok-4.7 | APPROVED | nits fixed |

**Consolidated plan gate:** all three reviewers APPROVED the v4 design and the final delta. After those approvals, only non-material editorial fixes were applied: explicit device/meta fields (§6.1.3), task dependency/order (§7), and the `hex(prevChainHash)` wording (§6.4.3). No scope, verification, or acceptance rule changed.

User authorized v4 + targeted delta review (2026-10-18). User approval of v4: **pending**.

---

### Appendix A — Package tree

```text
packages/azure-sync/
  package.json  tsconfig.json  tsconfig.client.json  cordis.patch.yml
  client.ts  client.types.d.ts  icon.svg  locale/en.json
  README.md  CHANGELOG.md  LICENSE
  src/
    index.ts config.ts controller.ts commands.ts rpc.ts settings.ts auth.ts
    schema.ts runtime.ts
    local/store.ts
    sync/
      canonical.ts chain.ts effective-cwd.ts import-state.ts guards.ts
      committed-index.ts uploader.ts batcher.ts scheduler.ts lease-manager.ts
      admission.ts session-source.ts lease-drain.ts importer.ts attachments.ts
      projection-warmer.ts recovery.ts workspace.ts reconciler.ts conflict.ts
      tombstone.ts poller.ts live-guard.ts status.ts
    git/probe.ts git/sanitize.ts git/guidance.ts
    azure/blob.ts azure/table.ts azure/lease.ts azure/errors.ts
  test/
    schema.test.ts canonical.test.ts chain.test.ts effective-cwd.test.ts
    committed-index.test.ts uploader.test.ts admission.test.ts lease.test.ts
    drain.test.ts blank.test.ts import.test.ts attachments.test.ts
    projection.test.ts recovery.test.ts working-directory.test.ts
    reconciler.test.ts tombstone.test.ts live.test.ts git-probe.test.ts
    client.test.ts rpc.test.ts commands.test.ts
    integration/*.test.ts e2e/*.test.ts types/*.ts
  dist/                 # generated build output
```

### Appendix B — Azure setup

```sh
az storage account create \
  --name <unique-account> --resource-group <rg> --location <region> \
  --sku Standard_LRS --kind StorageV2 --allow-blob-public-access false \
  --min-tls-version TLS1_2
az storage container create --account-name <unique-account> \
  --name dsh-state --auth-mode login --public-access off
az storage table create --account-name <unique-account> \
  --name dshstatesync --auth-mode login
# Token auth: assign Storage Blob Data Contributor and Storage Table Data Contributor
# at the storage-account scope. Or use a connection string / managed identity.
```

No Blob versioning, soft delete, GRS/RA-GRS, lifecycle tiering, Functions, or Postgres in the default setup. Attachments are retained after thread removal; full purge requires deleting the container/account. Prices vary by region/currency; verify with the official links in §6.20.

### Appendix C — Status codes

`setup-needed`, `auth-error`, `pending-materialization`, `syncing`, `synced`, `retrying`, `ownership-unverified`, `paused-other-device`, `lease-lost`, `needs-folder`, `unmappable-cwd`, `cwd-unmappable`, `mapping-unstable`, `ambiguous-mapping`, `conflict`, `removed-remotely`, `generation-changed`, `remote-missing`, `remote-ahead-live`, `committed-index-corrupt`, `corrupt-remote`, `incompatible-format`, `no-cwd`, `schedule-unsafe`, `preset-missing`, `model-unavailable`, `attachments-unavailable`, `attachment-unsupported`, `degraded`, `importing`, `import-incomplete`, `import-race`, `drain-failed`, `projection-warm-partial`, `projection-warm-failed`, `live-restart-required`, `block-conflict`, `detached`.

### Appendix D — Acceptance
- Cold two-store.
- Retained-live + host restart (no close/reopen claim).
- Immediate A→B handoff with delayed final upload and forced break.
- B advances during A rejection → conflict, input preserved, no merge.
- Linked index with divergent/invalid siblings inside watermark; valid import.
- Empty/first-genesis; case-insensitive remainder; symlink escape/decoy.
- Dual coldSnapshot signatures; sidebar metadata.
- Image valid local untouched; undefined path degrades.
- Blank toggle; command events; exactly-once input.
- Root delete vs new child; offline tombstone; resurrect.
- Cost model/measured requests; no monthly-bill claim.
