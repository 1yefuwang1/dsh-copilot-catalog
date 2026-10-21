# Cloud import amendment: portable Git branch and commit context

Recorded: 2026-10-21 (Asia/Hong_Kong). Revision: 3.

**Status: implemented with I1–I6; whole-repository verification passed, BOTH final independent reviews APPROVE after accepted corrections.** See the [destination acceptance ledger](<../acceptance/cloud-import-destination.md>) for exact scope and deferrals. The user
requires implementing all tasks before final independent GPT + Grok review subagents, without per-task
review panels. No installation, deployment, commit or push is authorized. The user clarified that
remote branch names must sync so an imported cloud thread can identify its intended checkout. This amends
the [Local/New worktree import design](<2026-10-20-223034-HKT-cloud-import-local-worktree.md>).
Its original design-only restriction was superseded by that explicit implementation request; no installation, deployment, commit/push or cloud-primary redesign was authorized.

## 1. Requirement and the distinction that matters

**Yes: sync explicit remote/repository identity, full remote branch ref and pinned commit information.**
Do not infer the original remote/base branch from a generated current worktree branch name.

Keep these concepts separate:

| Fact | Meaning |
| --- | --- |
| Creation base | Branch/ref and exact commit from which the source thread's checkout was created; stable historical context. |
| Current checkout | Last observed local branch (or detached state), HEAD commit and dirty state of the active device. |
| Current upstream | Configured remote and full branch ref tracked by that current local branch, if any. |
| Import destination | Local folder or fresh managed checkout on the receiving device; its IDs/paths remain device-local. |

For example, a source worktree created from origin/dev at commit A can now be on worktree/task-x at
commit B with upstream origin/feature-x. Sync all known facts, but import's default resume snapshot
is **B**, not A. Origin/dev describes the original base, not proof that origin/dev contains B.
If no upstream exists or B was never pushed, say so; syncing the name/hash does not transfer Git
objects, guarantee a remote branch exists or make unpublished work available on another device.

## 2. Proposed portable metadata

Use a bounded, strict **version 2 Git-context envelope within the existing gitJson string**. This is
an advisory metadata-format extension, not a new Azure service, native history event or change to
canonical header/event-chain bytes. Preserve reading legacy v1 GitFacts as incomplete context.
Do not add new keys to v1: its allowlist currently rejects them.

Conceptual fields (exact strict DTOs and limits are fixed/tested in I1):

```text
v: 2
observation:
  deviceId, observedAt
  generation, headerHash, eventCount, chainHash
repository:
  objectFormat: sha1 | sha256
  root, worktree: existing advisory source Git facts (not destination bindings)
  configuredRemote?: { name, sanitizedUrl } (repository hint, not proof of upstream)
creationBase?:
  kind: remote | local | detached
  ref?: fully qualified refs/heads/<name> for the selected source branch
  remote?: { name, sanitizedUrl } (when kind is remote)
  upstreamAtCreation?: { ref, remote: { name, sanitizedUrl } } (known remote upstream of a local base)
  oid: exact selected creation commit
current:
  branchRef?: fully qualified current local refs/heads/<name>
  headOid?: current HEAD (absent for unborn repository)
  detached, unborn, dirty: clean | dirty | unknown
  upstream?:
    kind: remote | local
    ref: actual configured full branch ref
    remote?: { name, sanitizedUrl }
```

A branch name and remote descriptor are distinct fields; never split a concatenated origin/a/b string
by slash or interpret a remote-tracking ref as a local branch. Remote refs such as refs/heads/feature/x
preserve the full branch name. Detached/unborn/no-upstream/non-Git states remain explicit, not invented
origin/main defaults. A local upstream (Git remote '.') is not a network remote. Unknown/multiple
upstream mappings are shown as unavailable, not guessed. Missing source remote URL prevents automatic
cross-device remote matching; the source alias alone is not repository identity.

Creation-base facts come from a new **typed read-only export** owned by the worktree placement port,
validated against exact SID, immutable native cwd and checkout/commonDir identity. Existing worktree
records contain branchSource/localBranch/remote/remoteBranch/baseOid, but Azure must not read private
domains or cast a structural controller. New managed creation captures the selected base and any
known local-base upstream mapping **at creation time**, even if cloud sync is still Off; this is local
metadata only until explicit opt-in. Keep selected local refs/heads/release distinct from its actual
remote upstream refs/heads/dev. Do not derive that historical mapping from later branch config or a
generated worktree branch. Legacy records lacking it remain unknown. For Local/unmanaged checkouts
the historical creation base is unknown unless explicitly recorded; current upstream does not
retroactively establish it. Preserve existing advisory root/worktree/default-remote facts in the new
format; a configured default remote is only a repository hint, never an inferred branch/upstream.
Non-Git/unavailable probes omit Git context with a safe status; do not manufacture an object format.

Within a cloud generation, preserve a known creationBase instead of replacing it with each importing
device's new worktree base. The receiving checkout's chosen base belongs to its local placement
receipt; its current checkout/upstream may be published later by the actual cloud owner. Missing
historical facts remain unknown. New-generation retention/backfill requires matching recorded source
identity and explicit policy; never copy an unrelated generation's context by SID alone.

Derive remote descriptors from local configuration through the existing sanitizer. Never upload raw
remote config, credentials, tokens, local credential paths or the worktree controller's opaque
remoteIdentity as a substitute for portable repository identity. Source aliases are only hints;
a receiving device can map source origin to its configured upstream after verifying/selecting the
sanitized repository URL. Zero or multiple matches require explicit user choice. The typed export
uses the explicit source-kind discriminator: internal WorktreeRecord.baseRef values are retention
refs, never portable source branches; the local-source remote:'local' sentinel is not a network
remote identity. Only a genuinely configured/validated remote may supply a remote descriptor.

## 3. Capture, publication and freshness

- Capture on explicit opt-in, ordinary successful sync/publication, explicit Sync and graceful drain.
  Refresh current Git context even when no new conversation events were appended. The existing
  batch-only gitJson update is insufficient; add a guarded metadata-only update path, not a fake
  conversation event. Do not introduce continuous Git/network polling for idle threads.
- Read HEAD, branch and upstream consistently; reread their identity before accepting the snapshot.
  A racing Git change yields retry/unknown, not a mixture of branch from one checkout and OID from
  another. Observation time means observed, not a real-time dashboard or proof of remote publication.
- Publish only with the existing active opt-in, generation/header/epoch/lease and committed-prefix
  authority, including the existing child/root liveness checks and conditional root touch where
  required. Do not weaken this to an unguarded Table metadata patch. A metadata-only ETag update
  cannot advance history, adopt a foreign generation or reset Off/detach/account intent. Reread/validate the accepted metadata and exact original history binding.
- Capture a new observation only **after the exact candidate manifest tip is known**, and bind its
  Git read to that tip's generation/header/count/chain hash for that same conditional replace/EGT.
  If the conditional write must target a different tip, reread/rebuild Git context. The current
  uploader's pre-loop gitJson string cannot simply be restamped onto each post-batch tip. Alternatively,
  leave the prior observation unchanged; its mismatched anchor is stale and cannot seed a fresh
  automatic suggestion until a guarded refresh. Source Git and Azure are not an atomic snapshot.
- Distinguish a **semantic Git-selection fingerprint** from observation provenance. Pin repository
  identity, object format, selected headOid, any selected resolved ref and Git metadata schema version,
  together with the explicit local repository/ref/OID choice. A change to those Git selection facts
  requires refresh/review. Observation timestamps and history eventCount/chainHash advancement alone
  do not invalidate the selection or replace its reviewed history watermark. Generation/header
  changes still fail under the main plan's immutable history-identity rules, not a second Git fence.
- Validate observation anchors when trusting a new suggestion. A previously verified review snapshot
  remains usable when its unchanged Git facts accompany a proven same-generation history suffix;
  compare semantic Git facts, not the whole observation object. If the old observation is retained
  byte-for-byte while the history tip advances, the already trusted plan may retain its pinned commit
  after proving the reviewed prefix is still chosen; it must not treat that observation as a fresh
  reading of the later tip. New suggestions reject inconsistent/stale anchors. A newer valid
  observation of the same Git selection can be reconciled without asking for review solely for its
  timestamp/count/hash. The main plan alone governs suffix catch-up. Dirty/unknown stays visible;
  absent/downgraded/invalid Git context is handled explicitly as unavailable, not silently trusted.

## 4. Resolve the intended checkout on import

The wizard displays separately:

```text
Resume commit      B (selected exact snapshot)
Current upstream   origin/feature-x (location hint; publication of B not proven)
Creation commit    A
Creation hint      origin/dev (location hint for A, not evidence that it contains B)
Source local name  worktree/task-x
Local remote       upstream → same selected repository
Destination        Local | New worktree
```

Names above are display data; only validated configured local remotes/refs are eligible for Git use.
The default exact snapshot is current.headOid, B when known. Resolve branch-location hints explicitly:

1. Current remote upstream is the first possible location hint for B, **not proof B was pushed**.
2. For creationBase.kind local, upstreamAtCreation is only a recorded remote location hint for
   creation OID A; creationBase.ref names the selected local branch, not that remote branch.
3. For creationBase.kind remote, creationBase.remote/ref is only the historical remote-base location
   hint for A. Detached/local-only/unknown cases supply no invented remote branch.
4. Local branch names can be separately labeled local hints. A may help identify repository/base
   history, but never substitutes for B or proves that any hinted remote branch contains B (or A).

Never render a combined ref @ oid as a currently verified association until the receiving device
has validated a local ref resolving to that exact OID. Otherwise show ref and commit separately with
publication/availability unproven; a creation-time fact is not proof of today's remote tip. A stale
tracking ref is a local observation, not a claim about the current remote server. No branch-name
match alone establishes repository identity or the correct snapshot.

1. Select/validate the receiving repository and map any source remote to a configured local remote.
2. Check whether the expected HEAD commit exists locally and has the right object format/type.
   Validate explicit full refs and compare their resolved commits; no shell interpolation, arbitrary
   cloud URL, remote helper or unvalidated ref is executed.
3. If the expected commit exists, default to that exact commit. A matching local/remote-tracking ref
   can label the selection. A branch that moved after review invalidates a ref-based plan; a commit-
   based plan is pinned to the selected OID and still revalidates its repository/object availability.
4. If the object/ref is missing, explain the needed repository, full branch and OID; let the user fetch
   or otherwise prepare code **outside this first-release import flow**, then refresh. No automatic
   network fetch, clone, pull, push, reset, stash or fallback to an unrelated local default branch.
   A branch may not exist, may have been force-pushed/deleted or may not contain the required OID.
   Do not repeatedly fetch by raw hash or claim the server must serve an unadvertised object.
5. Choosing a different snapshot remains an explicit override with code-state mismatch acknowledgment.
   A creation-base-only or legacy record never silently becomes a verified current checkout.

**New worktree:** extend the proposed placement input with a **validated local commit** selection in
addition to local branch/HEAD. Current kernel support for branch/HEAD alone is not enough when the
correct object is present only under a remote-tracking ref or another local ref. Provision from the
selected exact OID and create a unique local worktree branch; preserve source remote/upstream names
as context, not as instructions to steal a checked-out branch, set an upstream or create/push a remote
branch automatically. This is a proposed guarded kernel extension, not an existing API claim.

**Local:** import still does not switch the existing folder's branch or modify files. Compare its
current branch/OID/dirty state with the suggested snapshot. The user prepares the desired checkout
separately or explicitly acknowledges the mismatch; history import is not proof that code was restored.
A fresh metadata suggestion must never silently retarget an existing completed import's placement.

Original source context is synced; worktree IDs, local paths, native/project bindings, permission
contexts and per-device Local/New worktree choices are still not portable execution settings.

## 5. Compatibility, safety and integration tasks

- Keep the outer Azure manifest/history schema and Blob format unchanged by storing the versioned
  envelope in gitJson. This **does change that JSON payload format** and its parser/DTO/UI contract;
  the earlier no-cloud-schema-change statement is not permission to treat v2 as v1.
- Separate stored gitJson decoding from public RPC compatibility. New storage readers accept strict
  v1/v2; the old storage decoder omits an unknown v2 payload. Legacy/malformed/unknown context supplies
  no remote/base guarantees and requires manual selection. Never infer fields or forward raw JSON.
- The existing pull/catalog response shape stays unchanged: git is **absent or strictly v1**, with
  current local branch/commit/default-remote semantics only. For stored v2 context, omit git from
  this legacy response rather than place v2 or source/upstream fields into it. Do not add sibling
  keys to old pull items. Old public clients reject extra/non-v1 fields; they do not ignore them.
- Carry v2 Git context only on a **new, explicitly versioned import-plan DTO/action** negotiated by
  new clients (for example the proposed plan-import response requesting Git-context version 2).
  Old pull clients are never sent that DTO. The outer existing RPC carrier/envelope remains v1;
  its version does not make changed nested item shapes compatible. Unsupported servers return a
  fixed unavailable/version error, not an attempted v2-in-v1 fallback. Never put creationBase,
  upstream or upstreamAtCreation into legacy GitFacts.branch or feed a full remote ref into its
  current-local-short-branch guidance path. I1 tests actual old client decoding of new-server pull
  pages, old-server v2 omission and new import DTOs independently.
- Older writers may replace v2 with v1 or omit metadata. Do not claim lossless mixed-writer preservation.
  In that case show context unavailable/incomplete and invalidate an existing metadata-based review;
  never guess, silently reconstruct history or permit a cloud name/hash to replace local Git checks.
  Destination reservation/mixed-version execution barriers from the main plan still apply unchanged.
- Do not make optional Git metadata corruption a reason to overwrite history or mark cloud ownership
  proven. Fixed/redacted errors and existing URL privacy safeguards remain required.
- This amendment extends I1 strict codecs/public compatibility and metadata-only authority proof;
  I2 typed source-base export + pinned-local-commit provisioning; I3 owner-fenced metadata publication
  including no-event Sync/drain; I4 default branch/snapshot display and missing-ref/mismatch handling;
  I5 real Git/HTTP/native fault regressions; I6 documentation/request-cost/pack evidence. No automatic
  fetch UI is authorized. Public API and all main-plan safety/seeded/compatibility gates remain.

Required tests include:

- Remote-base dev/A versus current worktree/task-x/B/upstream feature-x; B unpushed or absent;
  local-base release/A with captured upstreamAtCreation dev; changed later local upstream config;
  internal baseRef and local-source sentinel never exported as remote identity. Ref/OID UI association
  stays unproven until actual local resolution equals the displayed OID.
- Source/current branch differences, no upstream, local upstream '.', different remote aliases,
  same alias/different repository, nested names, detached/unborn/non-Git/unavailable context,
  SHA-1/SHA-256 mismatch, stale tracking refs, moving/force-pushed/deleted branches, object without
  a local branch, explicit snapshot override, dirty Local never switched, and importer B never
  rewriting creationBase A with its new placement base.
- Same-generation suffix and observation-only timestamp/count/hash refresh leave semantic Git
  selection/reviewed history watermark unchanged; actual selected HEAD/ref/repository/schema changes
  invalidate. A retained old observation may support only its previously trusted pinned plan, not a
  fresh later-tip suggestion. Pre-loop observations cannot be restamped to a new batch tip; conditional
  write retries reread for their exact candidate or retain old context unchanged/stale.
- Actual old public client decoding of new-server pull pages with git absent/strict v1; no added
  sibling keys or v2 git object; old-server omission of stored v2; new versioned import-plan DTO only
  to negotiated new clients. Never project source/upstream refs into legacy branch/guidance.
- Old writers dropping v2, unknown versions, size/credential attacks, no-event HEAD/branch changes,
  Off/detach/account/generation/lease races and late writes. Assert actual owner lease/ETag, child/root
  authority and exact history tip; metadata-only success cannot adopt a foreign history tip.

## 6. Inspected basis and review

- [Current v1 Git facts](<../../packages/azure-sync/src/git/sanitize.ts#L1-L13>) have current branch/commit
  and sanitized remote URL, not dedicated source/upstream refs; its [strict parser](<../../packages/azure-sync/src/git/sanitize.ts#L43-L64>)
  rejects added v1 keys.
- [Git capture](<../../packages/azure-sync/src/git/probe.ts#L168-L177>) reads symbolic HEAD, HEAD OID and
  a configured default remote URL, not branch upstream/merge configuration.
- [Worktree record](<../../packages/worktrees/src/types.ts#L197-L229>) retains selected source-kind,
  branch and base OID, but its internal baseRef and local-source sentinel are not portable remote
  facts; historical local-base upstream needs the explicit new creation-time capture. [Current create input](<../../packages/worktrees/src/types.ts#L122-L145>)
  only supports local branch/HEAD or fresh remote creation, not the proposed local-object input.
- [Current batch publication](<../../packages/azure-sync/src/sync/uploader.ts#L869-L885>) writes gitJson
  with history batches; the new no-event metadata path needs explicit guarded implementation.

### Amendment review ledger

Three Grok delta findings were accepted without dispute and corrected in Amendment Revision 3:
consume local-base upstreamAtCreation without claiming publication of B/A or exporting internal refs;
separate semantic Git selection from history/observation provenance and require tip-aware capture;
preserve the strict legacy catalog shape and isolate v2 in a negotiated import DTO. The main plan's
matching review/history/DTO rules and the amendment's test matrix were updated together.

Final independent Amendment Revision 3/main Revision 4 delta rereviews:

- `github-copilot/gpt-6.1-sol`, xhigh: **APPROVE**, after rereading the written corrections.
- `github-copilot/grok-4.7`, xhigh: **APPROVE**, all three accepted findings closed in the written text.

These scoped approvals supersede earlier amendment verdicts; prior main-plan Revision 3 approvals
still cover its unchanged design areas. Review approval is design-only, not implementation, completed
I1 proofs, user implementation authorization or deployment.
