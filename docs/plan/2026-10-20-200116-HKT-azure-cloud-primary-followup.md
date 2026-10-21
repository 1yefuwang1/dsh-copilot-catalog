# Deferred follow-up: opt-in Azure-authoritative conversations

Recorded: 2026-10-20 (Asia/Hong_Kong).

**Status: deferred design follow-up, not an implementation task or an approved replacement plan.**
The user explicitly chose to keep using the current design: "record this as a followup. I'll live
with the current design." Do not resume this proposal or change storage behavior without a new
request. The existing [v4 plan](<2026-10-20-200116-HKT-azure-cloud-sync.md>) and
[current implementation guide](<../../packages/azure-sync/README.md>) remain authoritative.

## Current design stays unchanged

The implementation committed and pushed as `212f59b23b1c15a3f9bd2d9941e0a6f550e18dee` is local-first:
local native history and attachments are retained; opted-in threads replicate immutable compressed
Block Blob batches asynchronously; Table Storage identifies committed batches; Blob leases and
fresh Host checks enforce one cloud writer. It does not use Append Blobs or make every visible
message synchronously durable in Azure. Normal handoff drains the local tail before release, but
lease expiry after a crash cannot recover an unpublished local tail.

The completed T1–T9 reviews and automated acceptance apply to that implementation, not to this
proposal. Its [acceptance ledger](<../acceptance/azure-sync.md>) still distinguishes automated
results from deferred live Azure, deployed GUI, Windows/PowerShell, RBAC/network and billing checks.
No cloud-primary code, deployment, core fork, or SDK patch was created during this discussion.

## Preferences agreed during the design discussion

These are recorded requirements for a possible future design, not implemented guarantees:

1. **Per-thread opt-in (choice B).** New threads stay local. Azure-authoritative storage applies only
   after explicit opt-in. Existing history and attachments must be durably stored and verified before
   cutover; a preparing/migrating state must not be reported as successfully cloud-primary.
2. **Azure is authoritative for opted-in conversation data.** Local copies are caches, not independent
   writable histories that will later be merged. This does not mean storing running processes,
   arbitrary project directories, credentials or all machine settings in Azure.
3. **Fail closed while offline.** Cached history can be read and an unsent draft composed, but cloud
   model/tool execution cannot proceed without Azure availability, durability and writer ownership.
   Offline work requires an explicit separate local-only fork; no silent fallback or automatic merge.
4. **Commit before visible assistant content (streaming choice B).** Persist each small group of
   streaming chunks before displaying it. Do not equate a native in-memory append or accepted inbox
   request with an Azure durability receipt.
5. **Persistent, rebuildable local caches (choice A).** Local history/attachments and SQLite search
   indexes may persist for performance and cached offline reading. They can be rebuilt from Azure;
   losing a cache must not lose acknowledged cloud history. Cache/index maintenance is not a second
   source of truth and its failure must not undo an already confirmed Azure commit.
6. **Publication rule.** Visible cloud-thread history is Azure-committed history. User text remains
   recoverable in a pending/sending state until durable acceptance, rather than being presented as a
   saved message prematurely. Final completion/Stop must distinguish execution quiescence, saved
   history and safe lease handoff. Transient progress indicators are not durable history.

Retain one writer per thread, finite leases, explicit takeover warnings, explicit opt-in privacy
consent, and no assumption that storage can cancel external tools already running. Recording tool
intent before dispatch does not make arbitrary external effects exactly-once after a crash.

## Public SDK feasibility findings: inspected 0.2.1-rc.2 only

Read-only inspection covered the pinned public packages and the installed runtime. A temporary
public-API-only synthetic adapter probe confirmed the streaming gate for direct and prepared model
calls: a pending commit yielded no content to the accumulator/assembler; successful commits released
chunks; a rejected commit propagated without publishing the refused chunk. This was not an Azure,
live-model or complete cloud-primary implementation test. Do not generalize these findings to another
SDK release without rechecking its declarations and call order.

### Supported public building blocks

- `llm/stream` is a waterfall returning an `AsyncIterable<StreamChunk>`. Middleware can await a
  journal write before yielding each detached chunk. Both direct calls and `PreparedLlmCall.stream`
  traverse it. `GenerateOptions.sessionId` permits explicit per-thread filtering.
- The native loop consumes a yielded chunk before updating its assembler and publishing content, so
  a correctly ordered outermost middleware can gate content, not merely a post-render notification.
  Cover every relevant chunk type, not text deltas alone, and prevent offline adapter dispatch before
  calling downstream `next()`.
- Published `session-checkpoint-policy` awaits `sessions.flush` before native model dispatch,
  top-level registered tool execution and the next step. Public `tools/pre-execute`, `tools/execute`
  and `agent/pre-step` provide awaited execution boundaries, subject to their identity/nesting scope.
- A third-party/composite `SessionPersistence` can route local versus cloud thread IDs. Its
  `SessionHandle.flush()` is a public durability barrier. Native creation does not offer a simple
  per-thread backend option; opt-in routing must be designed before a handle is selected.
- Public custom ingress, UI contributions and `AgentFactory` composition are possible design tools.
  A private core fork is **not established as necessary**.

### Missing complete native guarantees / unresolved composition

- The stock composer optimistically commits its draft; native prompt/queue APIs acknowledge
  synchronous Agent/inbox mutation without awaiting Azure persistence. Generic HTTP interception
  does not universally cover direct in-process calls or reverse an earlier client-side clear.
- `Session.append` updates memory and emits observers synchronously. An asynchronous storage
  backend or post-event observer alone cannot retroactively delay those native publications.
- `llm/stream` does not expose the future native event ID, sequence, timestamp or full final envelope.
  Native start/end frames are not a universal awaited publication boundary. A separate authoritative
  chunk journal needs its own identity and an explicit reconciliation/projection design.
- `agent/turn-stopping` is awaited for normal stopping paths, but final `turn/end` is appended later;
  error/cancel/rejected paths do not all pass through that hook. Native idle/completion is not itself
  an Azure flush receipt. Teardown success and failure-aware lease release are separate concerns.
- Standalone commands, nested/agentless operations, native reconnect snapshots, search, previews and
  other clients must not bypass the committed-data boundary. All trusted-plugin assumptions and
  unsupported entry points need an explicit policy.
- A cloud-aware asynchronous submission/presentation layer may enforce the agreed visible-history
  rule without changing the stock runtime. Complete public-interface coverage has **not** been
  established. Do not claim that swapping the persistence provider alone is sufficient, or that the
  entire cloud-primary design is already proven plugin-only.

## Open design decisions — not approved by the discussion

- **Storage protocol:** Append Blob log segments are a candidate, not a selected implementation.
  Compare them with immutable chunks; design segment rollover, compression, generation/deletion
  fencing and Table metadata/index recovery. Blob and Table are not one cross-service transaction.
- **Durability receipts and retries:** stable submission/attempt/chunk IDs, expected append positions,
  hashes, lost-response recovery, duplicate prevention and the exact committed watermark.
- **Streaming cadence:** buffering for approximately one second was proposed, with immediate flush
  at response/tool/Stop boundaries. The user did **not** select a cadence or approve that cost/latency
  trade-off. Do not record one second as an agreed requirement.
- **Native presentation integration:** how to supply committed-only chat, reconnect, sidebar preview,
  SQLite search and API results using supported interfaces, without a private dependency-shape patch.
  Decide whether any upstream public API extension is needed after a focused feasibility prototype.
- **Migration and mode changes:** quiescence/cutover for existing local threads, failure/cancellation,
  already-published v1 data, turning cloud-primary off, explicit local forks, retention and rollback.
  Do not silently reinterpret the current v1 Off/detach semantics.
- **Search/cache scope:** index all cloud histories proactively or only fetched histories; attachment
  download policy, cache eviction and local data protection. Table Storage is not full-text search;
  do not synchronize SQLite/WAL files between devices. The earlier import work did not include a
  dedicated imported-thread-to-actual-SQLite-FTS search proof.
- **New cost model:** the existing [measured v1 cost model](<../acceptance/azure-sync-cost.md>) is not
  a cloud-primary forecast. Measure new append cadence, indexing/downloads, retries, leases,
  metadata maintenance and enabled-session scaling before making cost claims.

## Preconditions for reopening implementation

- [ ] User requests resuming the follow-up and reviews a complete standalone design.
- [ ] Public-interface prototype proves or explicitly rejects the committed-only presentation path;
      any needed core change is disclosed, not hidden in a private patch.
- [ ] Fault tests cover pending/rejected/accepted-but-response-lost Azure writes, queue admission,
      streaming/terminal publication, Stop, model/tool execution and writer takeover.
- [ ] Cache loss/rebuild and actual SQLite indexing/search are tested; no uncommitted read surface
      bypasses the cloud boundary.
- [ ] Migration, rollback, offline fork and schema/version compatibility are specified and tested.
- [ ] New request-cost/latency evidence is measured with explicit workload and platform limitations.
- [ ] Obtain the user's current required independent GPT + Grok reviews; do not request Gemini approval.

Until then, keep using the existing local-first implementation and its existing documentation.
