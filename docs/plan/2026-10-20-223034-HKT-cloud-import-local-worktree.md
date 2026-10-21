# Cloud import destination: Local / New worktree

Recorded: 2026-10-20; amended: 2026-10-21 (Asia/Hong_Kong). Revision: 4.

**Status: I1–I6 implemented, whole-repository verification passed, BOTH final independent reviews APPROVE after accepted corrections.**
The user approved implementation of this import-time Local/worktree plan and its Git-context amendment
on 2026-10-21. Current scoped evidence is in the [destination acceptance ledger](<../acceptance/cloud-import-destination.md>). Latest instruction:
implement all I1–I6 before spawning final GPT + Grok review subagents; no per-task review panel.
Hard feasibility/safety gates remain required. This is not permission to commit, push, install or deploy.

The user originally requested designing an import-time Local/worktree option. The [portable Git-context amendment](<2026-10-21-125717-HKT-cloud-import-git-context.md>)
adds the user's requirement to sync explicit source/base remote branch refs and pinned/current commits;
its detailed capture, compatibility and import-resolution rules are part of this revision. Earlier
Revision 3 approvals do not by themselves approve this amendment. No runtime behavior, storage protocol, installed GUI or Git checkout has been
changed by this document. This is an additive improvement to the completed
[v4 local-first design](<2026-10-20-200116-HKT-azure-cloud-sync.md>), not a resumption of the
[deferred cloud-primary redesign](<2026-10-20-200116-HKT-azure-cloud-primary-followup.md>).

## 1. Product contract

From the remote cloud-thread catalog, **Import** opens a destination wizard:

- **Local**: import the cloud conversation into an explicitly selected existing local folder.
- **New worktree**: create a new managed Git worktree and import the conversation directly into it.

Both preserve the **original cloud session ID**, history, lineage and inherited-event cut. Neither
sends a message, runs a model, creates a placeholder conversation, forks the cloud conversation or
uses a new thread to claim the checkout. The selected destination is device-local metadata, not an
instruction for another device to reuse its absolute path.

Import restores committed conversation history and supported attachments, **not project files**.
A new worktree contains the selected local Git commit snapshot, not uncommitted files from the source
machine. Unpublished source-machine conversation events also remain unavailable under local-first
replication. Cloud import does not change those durability limits.

### First-release decisions

1. Default to **Local**, with an explicit folder confirmation; never silently create a worktree.
2. Worktree placement is chosen **before the first local persistence creation** of the imported SID.
3. New worktree uses a **locally available commit pinned to an exact OID**, selected directly or via
   a validated local branch/HEAD/ref hint. Synced remote/base/upstream refs prefill the intended
   snapshot, not an arbitrary local default branch. No automatic fetch, clone, pull, reset, stash,
   push, patch application or source-checkout modification occurs.
4. Always create a fresh managed checkout and a unique local worktree branch. Do not attach to a
   different conversation's managed checkout, even if that conversation appears idle.
5. Repeated imports of an already-present SID offer **Open / Sync / Repair** for its recorded
   placement, not another destination. Same-SID relocation of completed history is out of scope.
6. New worktree requires a genuine **existing local permission context** with the current Git-mutation
   permissions. It is an authorizing actor only, not a source of target history/settings or its owner.
7. Import success is not execution permission. Opening history never automatically submits input,
   consumes a restored pending inbox, takes over the writer lease or launches tools.

## 2. User flow

### A. Select a cloud thread

The catalog shows the existing sanitized summary: title, SID, generation, event count, source platform,
source cwd and advisory Git facts. Select **Import…** for one generation. No automatic family import.
The server verifies the committed history, not merely the advertised catalog row.
The new destination wizard supports **ordinary, non-subagent conversations only**. Ordinary forks
retain their original lineage, but seeded forks are eligible only if I1 establishes a crash-safe,
publicly readable initial artifact including their existing seed marker (section 3). Otherwise seeded
selection is disabled/refused before any effect, with a clear unsupported-backend/capacity explanation.
Preview verifies header.origin and seed support before any reservation/Git/native effect. A subagent
SID receives an explicit independent-placement-unsupported result; do not change its origin or parent
to make it bindable. Existing descendant import paths remain unchanged and are not routed through
these new mandatory project-binding rules.

If this SID already exists locally:

- Matching completed import: show its destination and **Open / Sync**.
- Matching unfinished operation: show progress and **Resume / Repair / Cancel** for that exact plan.
- Unrelated native SID, different cloud account/scope, incompatible generation or inconsistent
  provenance: show a conflict; preserve all local data. Never replace, merge or mint an alias SID.

### B. Choose destination

```text
Import cloud thread

Destination       (●) Local      ( ) New worktree

Local
  Project/folder  [ choose an existing local folder ]
  Use files       [ /home/me/project ]

New worktree
  Project/folder  [ choose an existing Git folder ]
  Resume snapshot [ synced branch hint / local branch / HEAD / local commit ] [ exact OID ]
  Worktree name   [ safe default; optional explicit label ]
  Permissions     [ existing local thread used for authorization ]
  Creates         [ generated checkout path and unique branch ]

Source mapping    [ remote project root → local mapping root ]
  Original cwd    remote/project/subdir
  Imported cwd    local-mapping-root/subdir
  Native folder   must equal Imported cwd (not necessarily the mapping root)

[Back]                                    [Review import]
```

The UI uses current local project/folder IDs; cloud project IDs and machine paths are hints only.
The source project folder remains distinct from the worktree execution directory. Do not add a
managed checkout as a new Local project folder. Selecting a registered source folder is the normal
path; an explicit existing-folder picker can register a normal workspace/project using existing
metadata rules, never silently create a different source thread.

**Local:** no Git repository is required. Show current branch/dirty state when available, but do not
switch branches or require a clean checkout for a history-only import. Ordinary Local folders may
be shared under existing Local semantics; this does not promise worktree isolation. A manually
created, unmanaged Git worktree can be used as an existing Local folder and is labeled as such.
If a mounted worktree capability identifies the path as another managed checkout, reject it rather
than mislabel the import Local or bypass its binding. Never offer the current managed execution
folder merely because the wizard was opened from that thread.

**New worktree:** enabled only when a compatible worktree-placement capability, local filesystem,
managed subprocess provider, usable repository and existing authorizing Agent are available. Missing
capability has an explanatory disabled state; do not silently fall back to Local.

The authorizing thread may already be open with no messages. It is never copied, moved or attached
to the new checkout; no first message is required. If no real existing local Agent can be resolved,
ask the user to select/open an existing local permission context; do not auto-create a helper thread,
use the cloud SID prematurely or borrow Host/browser defaults. This is an explicit first-release
availability constraint, not a claim of an actorless Git API.

Read current permission controls on the selected actor. If full access is missing, explain that
cross-root/shared-Git writes require the existing native permission control and offer retry after
the user changes it there. Do not elevate on the wizard's behalf. Actor identity, settings/policy
revision, selected project membership and repository identity are revalidated before effects.
For agent/tool-origin requests, retain the existing plan-mode mutation restrictions.

**Branch and snapshot selection:** sync explicit creation-base remote/full branch ref/OID separately
from current branch/HEAD and its actual upstream. Prefill import with the observed current HEAD OID
and its branch-location hints, not merely a same-named local branch or the older creation base. A
source worktree created from origin/dev@A but now at B must not silently resume A. The receiving device
maps the source remote to a configured local repository/remote, validates the expected commit, and
confirms the exact snapshot. A locally present commit can be selected even without a local branch.
See the [Git-context amendment](<2026-10-21-125717-HKT-cloud-import-git-context.md>) for v1/v2 metadata,
no-event refresh, typed worktree-base export, snapshot fingerprinting and commit-input requirements.

Different/missing source snapshots, legacy metadata and dirty/unknown state receive clear warnings;
a deliberate different-commit choice requires mismatch acknowledgment. Missing local objects/branches
require the user to prepare/fetch the repository separately and refresh; no automatic remote fetch,
execution of cloud-supplied URLs/refs, checkout of an unrelated default branch, or claim that code
was restored. Local mode still never switches the existing folder's branch automatically.

**Naming:** use a deterministic, bounded fallback based on operation/worktree UUID, plus an optional
sanitized user label. Do not call an LLM or arm the first-message namer on imported history. Source
branch names are not reused as the new branch, avoiding checked-out-branch conflicts.

### C. Review, then explicitly confirm

Show SID and cloud generation, committed history watermark, attachment/projection caveats, destination
mode, source folder, exact base OID, new branch/path if applicable, header/current cwd mapping, local
permission context and all code-state mismatch warnings. The final button is **Import here**.

Preview performs bounded verification/reads and may save a local plan, but creates no checkout,
native session, target workspace membership, model input or Azure write/lease. Confirmation is bound
to a short-lived server plan/revision; a client cannot substitute a path/ref/SID at commit time.
Moving selected refs, settings/account, project folder or immutable cloud identity invalidates review.
The Git-selection fingerprint covers selected repository identity/object format/head OID/resolved ref
and metadata schema, not observation timestamps or history count/hash advancement. A later same-
generation suffix is handled as described in section 6, never silently substituted into the reviewed
history watermark or used by itself to invalidate an unchanged Git selection.

### D. Progress and result

Progress is factual, with a stable operation ID:

`Checking → Preparing destination → Importing history → Restoring attachments → Warming views → Binding destination → Ready`

Local skips checkout creation. Display **Cancel** until terminal; cancellation is not a promise to
undo already committed Git/filesystem effects. Closing/reloading the panel does not allocate a new
operation. Reconnecting reattaches to the recorded operation; it never resubmits a first message.

Success shows **Imported · Local** or **Imported · Worktree**, destination path, branch/base where
applicable, and **Open thread**. Opening uses the original SID. An explicit attachment/projection
acknowledgment can retain existing degraded-import semantics, but cannot acknowledge away a failed
required destination binding. A stale catalog generation cannot become an openable success badge.

**Open** is history access. **Continue** is separate: confirm restored pending input if any, verify
local policy/runtime readiness, and pass the existing fresh cloud ownership/catch-up gate before
model execution. No forced takeover is bundled with Import or Open. An active foreign cloud writer
can coexist with a read-only imported snapshot; it cannot authorize execution on this device.
The first release must prove an input hold covering native prompt/queue/pre-step paths before it
claims Open is inert; a browser-only composer disable is insufficient.

## 3. Placement and history invariants

### Session-scoped destination mapping

Global folder-prefix mappings are not sufficient: two cloud threads can have the same remote cwd
but require different managed checkout paths on the same device. Never overwrite a global mapping
to point at one random worktree.

Add an optional, strict **per-session destination binding** to local sync metadata. It contains mode,
operation ID, mapping ID/revision, remote platform/prefix, canonical local root, selected source
project/folder IDs when applicable, and the immutable localized header cwd. Worktree bindings also
contain worktree ID, native workspace ID, checkout root, base ref/OID and placement-receipt revision.
Freeze the mapping for an imported prefix; a global mapping edit must not rebind it.

All resolution paths use this binding consistently: initial import, repair, cold/live catch-up,
ownership proof, uploader reconciliation/canonicalization, Git metadata probing and status/UI.
If a destination binding exists but is invalid/missing, fail closed; never fall back to a global
mapping. Legacy records without a destination field continue using existing pinned global mappings.
Changes to unscoped mapping commands must not freeze or retarget unrelated session-scoped bindings.

Choose a source prefix covering the original header cwd and every historical cwd change, then
preserve relative subdirectories under the selected destination root. For a new worktree, its
immutable localized header cwd must equal the provisioned worktree effectiveCwd (checkout root plus
the chosen project subdirectory). Its replayed current cwd can differ but must stay within the
verified mapping/checkout. Do not confuse that runtime current cwd with native Workspace membership.

**Exact-folder geometry, without changing Projects semantics:**

- Local's selected existing folder is the final immutable localized header cwd and native Workspace
  path. If a logical project/folder is selected, that registered folder must equal this cwd exactly;
  selecting a parent project folder does not grant a descendant-folder binding. A separate mapping
  root may be an ancestor, but must translate the original header to this exact selected folder.
- For example, mapping /remote/repo to /local/repo with header /remote/repo/subdir requires selecting
  /local/repo/subdir as the Local destination/project folder, not /local/repo. Preview blocks a
  mismatch and lets the user correct folder selection or the explicit mapping before effects. A
  custom unregistered folder has no promised membership in a selected parent project; disclose its
  native-only/ordinary folder discovery behavior, or register/select the exact folder explicitly.
- New worktree uses the selected source folder's Git projectSubdir unchanged. The source-prefix to
  header relative suffix must match that projectSubdir, so translation into the generated checkout
  equals its provisioned effectiveCwd exactly. Reject mismatches in preview; offer correcting the
  source folder/mapping, not substituting another subdirectory/project silently.

Do not broaden ProjectController to infer descendant Local membership or overwrite projectSubdir
as a side effect of import. Native Workspace membership and selected logical binding are both
revalidated against the immutable header, not the replayed current cwd.

Validate all path translations with source-platform rules, canonical realpaths and containment;
reject root replacement/symlink escape, missing subdirectories and paths outside the selected root.
Preview can validate the source tree/subdir layout; verify the actual materialized checkout again
before persistence creation. A missing historical directory cannot be fixed by dropping/rewriting
old cwd events or silently choosing a broader root. Explain the conflict and allow correcting the
plan before effects, or preparing a suitable code snapshot separately. Multi-root mapping is deferred.

Keep the existing forward-localization provenance proof for every stored event and canonical prefix.
Do not rewrite message/tool path text, event IDs, sequences, timestamps, parentSession or inherited
cut. New locally authored cwd changes use the same pinned reverse mapping; canonical remote history
is not regenerated by reverse-mapping imported local bytes.

### Identity and admission

One native persistence artifact per SID per local profile remains the rule. The plan captures cloud
storage scope/account (non-secret identity), SID, generation, canonical header hash, inherited cut,
verified event count/chain hash and the current local intent/cancellation revision. The final chosen
localized header is immutable once the artifact is created.

Persist the target reservation and an execution veto before checkout/session effects. This initial
reservation lives in a **separate destination-operation journal**, not a LocalSessionRecord with an
importState such as planned. The existing startup repairAll treats that state as permission to
resume/create; it is not a legacy-readable veto. Before a proven readable initial artifact exists at the final header cwd, there must be no
legacy-repairable LocalSessionRecord for the reserved SID. Initial destination metadata/mapping and
cancellation authority therefore live in the reservation until the transition below. Off/detach
and cancellation must update that journal directly in this phase, not manufacture an incomplete
LocalSessionRecord as a convenient place to store the veto.

The new coordinator validates/provisions the final destination, then uses public persistence.create
with the exact original SID and final localized immutable header. Before publishing its destination-
linked LocalSessionRecord, it must materialize and prove a **readable initial artifact**, including
exact cwd, inherited cut and any required initial event prefix—not merely flush a physical header.

- Unseeded imports can start from a header/empty prefix only if the backend supports reading and
  reopening that artifact safely.
- Seeded ordinary forks require the exact verified/localized inherited prefix **through the existing
  session/end-seed marker at seq == inheritedEventCount**, i.e. the original events slice ending at
  cut + 1. Do not materialize a seeded header-only file, omit the marker, manufacture a replacement
  marker, change the cut or repair raw JSONL. In the inspected physical format the numeric cut is
  recovered from that marker; a cached handle property/header-only stat is not independent proof.
- I1 must establish a public-API crash-safe initial materialization and independent cold-restart
  read/open/header/cut/prefix proof, including create, first append, cancellation/close and flush crash
  windows. A single append call must not be assumed crash-atomic. Never split the required seed
  prefix across partially readable materializations just to meet ordinary batch limits. Check bounded
  prefix capacity before any effect. If the public backend cannot establish this path, seeded import
  is disabled/refused in preview before checkout/session effects; do not claim general fork support.

Refactor the importer's prepared-placement path accordingly: do not call the existing initial import
routine, which writes a planned session record before cwd preflight, as an unchanged wrapper. Reuse
verified reader/preflight/append/provenance helpers without their old early-publication ordering.
Only after a supported readable initial artifact is flushed/proven may its destination-linked record
be published; remaining events append from the proven prefix length, never again from zero. A crash
before that publication stays journal-owned and must have the public recovery path established in
I1; journal ownership does not itself make an unreadable physical artifact recoverable.

Do not resolve or create the target Agent to obtain authority. Exclusive native persistence handles
still protect JSONL creation/append; the coordinator does not replace those ownership claims.
Admission guards load and consult destination reservations even when no LocalSessionRecord exists.
Ordinary repairAll, explicit legacy resume/pull, early claims and catch-up must route or skip every
destination-reserved SID through the new coordinator; they cannot create a missing artifact with a
global mapping, even when the destination journal has not yet acquired a normal session record.
Only SIDs with no destination reservation retain the existing legacy Local pull/repair routing.

Admission depends on both history readiness and destination readiness. Existing guards that regard
importState complete/degraded as sufficient must also require the destination receipt for these
new operations. Install journal-backed startup fences before native resume/repair/polling; do not
assume an old reader understands them (see compatibility below). Expose destination errors without
claiming history was lost. Stop/Off/detach, credential changes and newer local intent cancel old work
and fence all late completions, including after an ignored abort or delayed Git result. No automatic
rollback may re-enable sync or erase a newer opt-out.

Already-imported history is not relocated. Metadata-only completion is allowed solely for the
original operation when immutable header cwd, full provenance and checkout identity already match.
A Local→worktree move otherwise needs a separate future design; never delete/reimport, append a fake
cwd event, create a continuation child or silently change SID to simulate it.

## 4. Architecture and proposed contracts

**Existing seams, not new guarantees:** cloud requests use a shared strict protocol/controller and
cold importer; worktrees exposes a plugin-local controller plus native persistence/workspace/project
primitives. There is no current public same-SID worktree-import API. Add an explicitly exported,
versioned, optional **worktree import-placement port**, owned by the worktree package. Do not cast
its private controller, mutate its domains from Azure, call another plugin's HTTP endpoint internally,
or use the native first-Send/private input-sink adapter.

Conceptual contracts below are **proposed names**, not existing SDK methods:

```ts
// Browser-safe destination intent; all fields are parsed/allowlisted by the Host.
type ImportDestination =
  | { kind: 'local'; folderPath: string; projectId?: string; folderId?: string }
  | { kind: 'worktree'; projectId: string; folderId: string;
      base: { kind: 'local-branch' | 'head' | 'commit'; name?: string; oid: string };
      permissionActorId: string; label?: string };

// Both destination kinds also include a separately validated source-prefix mapping.
// Actor is a genuine server-resolved existing Agent, never an object from request JSON.
interface WorktreeImportPlacementV1 {
  readonly version: 1;
  provision(plan: ValidatedPlacementPlan, authority: LiveActorContext): Promise<PlacementReceipt>;
  bindImported(receipt: PlacementReceipt, proof: VerifiedImportProof): Promise<BoundReceipt>;
  inspect(operationId: string): Promise<PlacementStatus>;
}
```

`ValidatedPlacementPlan` binds operation/target SID, cloud identity commitment, actor, source
project/folder/path, repo commonDir, immutable chosen managed-root/path, selected branch/HEAD and OID,
header project-subdirectory mapping, and request hash. `VerifiedImportProof` is a trusted opaque
same-process proof or a reference independently revalidated against persistence/local reservations;
it must not be forgeable by posting JSON such as verified:true. `bindImported` performs metadata
finalization only; any further Git effects require current live actor authority again.

The worktree implementation reuses/refactors its existing guarded checkout/base-ref kernel without
calling SessionBootstrap.create. It provisions one checkout/workspace identity and returns final cwd;
only the cloud importer calls public persistence.create with the original cloud header ID and
localized cwd. Worktree code then verifies durable history/header and exact native workspace account,
adds SID to worktree.sessionIds and records truthful source-project membership. It does not copy the
authorizing actor's sandbox, approval, model, preset, plan, inbox or prompts into the target.
Cloud history is not itself an authorization grant for Git provisioning.

Cloud control adds strict proposed actions **plan-import / commit-import / import-operation /
resume-import / cancel-import** with explicit SID, operation ID, plan revision/token and generation;
status returns separate history/destination phases and safe actionable errors. V2 Git context is
carried only by a newly negotiated/versioned import-plan DTO; existing pull/catalog items remain
unchanged, with git absent or strict v1 current-local facts and no new sibling keys. Do not expose
source/upstream refs through legacy GitFacts.branch. Exact DTOs are fixed and public-consumer-tested
during implementation. Retain bounded plain JSON, exact authenticated
owner-browser admission, no RPC SID fallback, fixed/redacted errors and cancellation bounds.
Only new worktree requests resolve the explicitly selected authorizing Agent; catalog/Local/cold
status retain their actorless behavior. Do not reuse prepare RPC or resolve the imported target.

Retain `/cloud pull` catalog listing and existing known-thread sync behavior. For a new SID, legacy
`pull <sid>` may only perform the existing explicitly mapped **Local** import, never create Git state.
It must detect a destination-operation reservation and direct the user to resume it, not bypass its
fence. New native commands invoke the same coordinator, with explicit destination/confirmation;
CLI worktree provision uses its genuine invoking Agent. No first-message text is an allocation input.

Feature-negotiate optional port version and mounted readiness before enabling New worktree. Azure
can remain independently installable; Local import must work without the worktree package. Existing
managed worktree mutation requires the port when available; missing/incompatible optional services
produce an explicit unavailable/recovery state, not an internal structural-controller cast.

## 5. Durable operation and recovery protocol

This is a **recoverable local saga**, not an atomic transaction across Git, native JSONL, workspace
registry and the two plugins' domains. Azure owns import intent/history; worktrees owns checkout
placement and lifecycle. Add strict local operation journals, rather than overload the current
worktree create|handoff operation schema with fake source settings or continuation mode.

An import journal stores operation ID, request hash, cloud scope/identity commitment, target SID,
local intent revision, destination/mapping plan, actor identity/policy revision when relevant,
placement receipt, history checkpoint and safe phase/error. The worktree journal independently
stores its reserved IDs/path/base identity and corresponding import commitment. No credentials,
connection strings, prompt text, raw provider errors or absolute paths from other devices become
Git execution arguments through these records.

| Phase | Durable obligation / next safe action |
| --- | --- |
| Reviewed | Bounded plan only; nothing executable or allocated. Revalidate before commit. |
| Reserved | Separate destination journal holds unique target SID/operation claim and execution veto before effects; no legacy-repairable LocalSessionRecord yet. |
| Destination preparing | Worktree journal allocates one ID/path/base ref and cleanup exclusion before Git. Local revalidates its folder. |
| Destination prepared | Exact checkout identity and final header cwd recorded. No target Agent or history yet. |
| Initial artifact materialized | Create original SID at final header cwd; materialize/flush/prove a publicly readable initial artifact with exact cut/prefix, including the existing seed marker for supported seeded forks. Only then publish destination-linked LocalSessionRecord. Journal owns the crash gap; I1 proves recoverability. |
| History importing | Append remaining events from the proven initial prefix, flush/read-back-prove with scoped mapping. Only the destination coordinator resumes these checkpoints. |
| History verified | Attachments/projection results are known, but destination readiness still vetoes execution. |
| Destination bound | Required native workspace membership, worktree SID and project receipts committed and reread. |
| Ready | Azure persists matching final placement receipt under current intent; both readiness predicates hold. Only then expose success. |
| Recovery required / cancelled | Retain exact identities and committed effects; never infer success or allocate another checkout. |

Local import requires exact native workspace attachment for this new wizard flow as well. A chosen
logical project binding is required if project integration was available/selected; absence of that
optional capability is stated explicitly, not confused with a managed worktree. New worktree requires
all managed/project receipts; the current best-effort WorkspaceAttacher is not a sufficient commit.

Serialize by SID and repository; additionally use a **cross-process durable operation/target claim**
before effects. Process-local promise queues alone are insufficient. Reuse a proven storage-domain
conditional create/CAS only if verified to coordinate different Host processes; otherwise use a
bounded filesystem claim under plugin-owned storage with explicit stale-owner recovery and uncertain
process-state refusal. Resolve this in the first implementation proof before enabling effects.
An exclusive native writer handle acquired later cannot undo an already duplicated checkout.

The same operation ID + request hash replays the exact receipt; changed actor/target/scope/base/path
under that ID is rejected. A second operation for a reserved SID returns the existing operation or a
conflict, never another destination. A pending Git result after cancellation still belongs to its
original journal and is observed/drained. Ready receipts are revalidated on retry rather than used
to resurrect a checkout that cleanup has since reclaimed.

### Failure decisions

- **Before effects:** cancel without creating native artifacts or Git resources. Replanning can select
  another destination after the reservation is safely released under the original intent.
- **After Git but before receipt:** inspect the reserved path/ref/worktree admin identity. Adopt only
  an exact match to this operation; uncertainty remains recovery-required. No blind recreate.
- **After checkout, before/during import:** preserve checkout/ref and verified JSONL prefix. Resume
  the same mapping/SID/operation with current authorization. Do not allocate replacements.
- **After history, before binding:** repair attachment/membership/receipts without appending a turn or
  marking success early. A missing plugin keeps binding pending.
- **After binding, before Ready acknowledgment:** revalidate both receipts and finish idempotently.
- **Wrong/moved repo, path replaced, modified base identity, changed cloud generation or header:**
  preserve data and stop for explicit repair. Ordinary user code edits are not rolled back.
- **Off/detach/account change wins a race:** late results cannot publish Ready or re-enable anything.
  Explicit retained-byte repair may remain available under existing Off semantics; never infer consent.
- **Cancel after effects:** retain and expose the checkout/ref/history with a clear recovery entry.
  No automatic Git cleanup, branch deletion or directory removal, even if initially believed empty.
- **Host/plugin restart:** load separate durable reservations and install their SID fences before
  native admission, early claims, general automatic importer repair or cleanup. A reserved SID with
  no proven final artifact header is not a legacy repair candidate; the new coordinator alone can
  finish placement/header creation. A reserved SID with an existing header is still routed through
  that coordinator and checked against the exact final cwd, not a global mapping. Inspect/reconcile
  matching receipts, with no new Git mutation until an existing live actor is reauthorized. Data-only
  repair remains bounded by current intent and proof. An older/mixed plugin startup that could expose
  a session record before proven final header materialization must be refused as unsupported before
  admission, never permitted to repair it under legacy rules.

## 6. Cloud ownership, lifecycle and compatibility

Import is a read of a verified committed snapshot and does not acquire the cloud writer lease merely
to copy history. Preview captures the original header/generation/count/chain commitment. If the
remote tip moves within the generation, accept the reviewed prefix only after proving it is still
on the chosen committed chain; record the extra suffix as catch-up required. Git observation
count/hash/timestamp refresh alone does not reopen that history decision; compare semantic Git
selection facts and use observation anchors for suggestion consistency, not as a second suffix fence.
New Git observations must be captured for the exact known candidate tip of their conditional write,
not restamped from a pre-loop read. Any newly fetched cwd outside the pinned destination fails closed
rather than widening the mapping. Generation/deletion/
disabling/header changes invalidate the operation according to existing import/Off rules. Before
binding readiness is published, reread cloud authority and enforce this target proof. Execution then
uses existing verified catch-up and fresh lease/epoch admission, not the preview result or a stale
catalog leaseUntil field. Import does not promise a quiet source writer or a live owner dashboard.

Pending import-placement journals participate in worktree hasPendingEffects, cleanup exclusions,
startup/session-created/input/pre-step fences, activity and teardown. Do not mark a checkout ready
for generic start/handoff/reclaim while binding is unfinished. Once ready, its original cloud SID
must appear in native workspace membership, worktree manager, project binding and runtime context.
The authorizing actor must not appear as its owning session.

Old source conversation timestamps must not cause immediate collection: new placement time is an
inactivity floor. Existing live-Agent, job, terminal, schedule, inbox, canonical path, writer-claim,
repository-maintenance and protected-worktree checks remain in force. Import reservations are not
user protection preferences; do not flip protected off to release an internal hold.

After ordinary cleanup has reclaimed a ready worktree, existing recovery creates a **new Local
continuation child**, not a relocated same SID. This proposal does not redesign that behavior or
promise indefinite identity-preserving worktree recovery. Stale import retries must report reclaimed
state and offer the existing explicit recovery, not recreate the original worktree automatically.

New code must read existing records unchanged, using explicit versioned local additions and port
checks. This does **not** claim old code can safely read new destination metadata. The Git-context
amendment versions the JSON payload inside gitJson and requires new strict codec/DTO/UI handling;
it does not change the outer Azure Blob/Table history schema, batch layout, writer lease timing,
new-thread opt-in default, global path mapping or cloud-primary storage model. Records without destination reservations retain existing
Local pull/repair behavior; never auto-migrate their immutable cwd.

A pending destination before native creation is a separate journal reservation that old repairAll
cannot enumerate as an incomplete session. Never publish a legacy-shaped planned/importState record
for it before flushing/proving the readable initial artifact and final header cwd/cut/prefix. After that transition, the new coordinator still
owns repair and uses the pinned destination; a legacy-readable incomplete state is **not** a veto.
Merely adding an unknown field to a strict schema, or causing plugin apply to fail, is also not proof
that native session admission stops safely.

A profile using the new destination protocol requires compatible import/placement versions; mixed
versions and downgrade are unsupported until an actual startup/feature-version admission barrier is
proven. I1 must demonstrate that such startup is refused or held in a genuine non-executing recovery
mode **before** any reserved SID can be repaired/resumed through old code, including cold pull and
startup repair. No assumption that older plugins inspect the new journal is permitted. In particular, today's old
controller pull can call importSession when local.getSession returns undefined, so hiding the
reservation from old repairAll alone does not stop an explicit old pull from creating the SID at a
global mapping cwd. The startup/feature barrier must prevent that older cold-import ingress too;
a schema-version bump by itself is not established as such a barrier. If the public Host composition
cannot enforce it, do not enable the feature or expose a resumable old session record before final
header proof; stop for a supported compatibility design/extension rather than silently shipping an
unsafe fallback or a private patch. This is an unproven implementation rollout gate, not a
declaration that current old releases already provide it.

## 7. Implementation tasks and acceptance gates

Implementation was requested on 2026-10-21. The user's latest instruction supersedes the original
per-task review cadence: implement all I1–I6 and test incrementally, then spawn independent
`github-copilot/gpt-6.1-sol` xhigh and `github-copilot/grok-4.7` xhigh review subagents against the full
implementation. No per-task review panel. Fix accepted findings; if a finding is disputed or a hard
feasibility gate has no supported solution, stop and ask the user. No Gemini gate. Preserve T1–T9.

| Task | Deliverable / gate |
| --- | --- |
| I1 — Contract and feasibility | Exported versioned placement port, strict plans/journals/schema compatibility; demonstrate public API same-SID import, readable/crash-safe first artifact (exact existing seed prefix/marker for seeded support), cold-restart header/cut/prefix proof, exact workspace/project binding, cross-process claim and inert Open/input hold. No hidden core/private SDK patch. Block rollout when required proofs fail; disable seeded eligibility before effects if its separate backend/capacity proof fails. |
| I2 — Worktree placement | Refactor guarded provision kernel; no SessionBootstrap.create, no first-message naming. Pinned local commit/branch/HEAD OID, typed portable source-base export, source-project identity, unique checkout/ref, durable recovery and cleanup fencing. |
| I3 — Import coordinator | Per-session mappings through every resolution/admission path; reserved → verified → bound → Ready protocol; required attach and cancellation/Off/account fencing. Preserve legacy Local pull/repair. |
| I4 — UI and commands | Accessible Local/New worktree wizard, capability/actor/permission states, mapping/base review, confirmation, stable progress/reconnect, safe result/open/continue and actionable errors; one controller for all ingress. |
| I5 — Fault and compatibility tests | Real Git/native JSONL/storage-domain/workspace/project integration, crash-point and concurrency matrix below, downgrade/readiness gates, packaged/public consumer tests. |
| I6 — Release evidence/docs | Update guides/acceptance ledger, pack budgets/audits/root verification, then deployed-GUI/two-device manual cases with explicit pass/deferred evidence. No installation/deployment assumed by tests. |

Required cases, in addition to the existing cloud/worktree suites:

- Local ordinary folder and non-Git folder; no Git mutations or model calls; original SID is openable.
- Worktree import on a device with an existing blank authorizing thread; no message, model call or
  extra target SID; actor remains Local; imported SID has correct native/manager/project backing.
- No authorizing Agent; read-only/workspace-write modes; policy change while queued; provider/path
  mismatch; forged actor/proof; incompatible/missing plugin and unload. No Host-default escalation.
- Two cloud SIDs with the same canonical remote cwd get distinct worktree destinations; another
  device chooses Local for the same cloud SID without changing the first device's placement.
- Subagent catalog selections reject before destination effects; ordinary forks preserve lineage;
  existing legacy descendant imports remain unchanged, with no fabricated project binding.
- Nested project/header cwd with exact Local selected-folder/header equality; a selected parent
  project folder rejects until corrected. Worktree source projectSubdir/mapping mismatch rejects
  before Git. Ancestor mapping roots do not alter native/logical membership semantics.
- Cwd changes within root, Windows→POSIX mapping, missing historical subdirectories, out-of-root
  cwd, symlink/root replacement and source project membership changes.
- Pin exact selected local OID; ref movement before creation refuses; source branch already checked
  out is harmless because the new worktree uses a unique branch. No fetch or dirty-file copying.
- A managed checkout owned by another thread cannot be disguised as Local; existing unmanaged Git
  worktree is clearly Local. Existing completed Local import cannot silently relocate.
- Imported authored messages never trigger first-message naming or a hidden LLM request.
- Foreign active writer: import/read allowed, no automatic takeover/execution. Restored pending inbox
  remains held until explicit Continue; direct prompt/queue/pre-step and reconnect cannot bypass it.
- Wrong-generation catalog, same-generation tip advance, orphan candidates, missing attachments,
  projection degradation, required workspace/project bind failure and false early success badges.
- Double click, same-ID request-hash mismatch, two tabs and two Host processes racing for one SID;
  one target/checkout or safe conflict, never two allocations followed by JSONL collision cleanup.
- Pre-header destination reservations never appear as old repairAll candidates. New automatic repair,
  explicit legacy resume/pull and early claims route/skip a reserved SID; no global-mapping fallback.
  Test crashes before create, after unflushed create and after readable initial-artifact flush but
  before session record publication. Off/detach before that transition does not seed an old resumable
  session row. For seeded forks test marker-at-cut inclusion, large inherited prefixes, append/flush/
  close/cancel crashes before/within/after the marker and independent cold public reopen with exact
  header/cut/prefix. Unsupported atomicity/capacity rejects in preview, with no synthetic marker,
  duplicate first-prefix append, altered lineage/cut or raw-file repair.
- Actual older/mixed-version startup and explicit old cold pull cannot create/resume a reserved SID;
  demonstrate the real fail-closed compatibility barrier, including auth/plugin setup failure. Do not
  count importState planned, strict-schema rejection or a version bump as that proof by themselves.
- Fault/cancel/restart before and after every journal/effect boundary; late ignored-abort Git/I/O,
  credential rotation and newer Off/detach win; no erased user files, duplicate checkout or enabled flip.
- Pending placement cannot be reclaimed; old imported timestamps do not trigger immediate cleanup;
  loaded Agent/jobs/terminal/schedule/inbox stay protected; reclaimed-ready replay does not recreate.
- Actual local SQLite search finds a uniquely tagged imported message through the production query
  engine after reconciliation. Cache warming alone is not this proof; cloud-only search is unchanged.
- Existing Local/Worktree first-Send, branch/naming, start, handoff, cleanup/recovery and all Azure
  import/repair/admission/Off behaviors regress unchanged. No weakening of pack/security limits.

Manual release checks must cover the actual refreshed existing GUI URL, a second device, real Azure
and platform-specific Git/path behavior; unit/JSDOM/SDK tests must not be labeled those passes.

## 8. Inspected basis and design review

Repository/API inspection was read-only. These links explain the proposed additions; none implies
that the current methods already implement this design:

- [Cloud catalog import UI](<../../packages/azure-sync/client.ts#L220-L252>) currently confirms a pull
  without a destination selector; [controller pull](<../../packages/azure-sync/src/controller.ts#L298-L319>)
  chooses initial import versus reconcile.
- [Import dependencies](<../../packages/azure-sync/src/sync/importer.ts#L25-L41>) already pass SID to cwd
  resolution, but [runtime mapping wiring](<../../packages/azure-sync/src/index.ts#L155-L181>) ignores
  SID and selects global prefixes. [Forward provenance](<../../packages/azure-sync/src/sync/effective-cwd.ts#L241-L274>)
  must be preserved.
- [Current finalize ordering](<../../packages/azure-sync/src/sync/importer.ts#L388-L433>) marks history
  complete before [best-effort workspace attachment](<../../packages/azure-sync/src/sync/workspace.ts#L35-L58>).
  The new required placement gate must be stronger than that ordering.
- [Existing worktree bootstrap](<../../packages/worktrees/src/sessions.ts#L384-L435>) creates a random
  new SID. [Prepare RPC](<../../packages/worktrees/src/rpc.ts#L259-L281>) is first-Send-specific, not an
  import API. [Actor policy/executor](<../../packages/worktrees/src/runtime.ts#L39-L58>) and
  [managed execution](<../../packages/worktrees/src/runtime.ts#L89-L127>) must not be bypassed.
- [Project binding](<../../packages/worktrees/src/projects.ts#L207-L215>) verifies an existing ordinary
  SID against exact native cwd/backing; [worktree record](<../../packages/worktrees/src/types.ts#L197-L230>)
  tracks its separate checkout/project/session facts.
- [First-message resume scan](<../../packages/worktrees/src/first-message.ts#L85-L91>) explains why an
  imported history must not receive a waiting naming marker. [Cleanup exclusions](<../../packages/worktrees/src/cleanup.ts#L229-L260>)
  need the new pending-operation facts too.

Installed public SDK 0.2.1-rc.2 declarations were also checked: Session header/cwd is immutable;
SessionPersistence offers same-ID create/open/append/flush, not header rewrite; Workspace.attachSession
requires exact stored/live immutable header cwd to match its canonical folder. A mutable runtime
working-directory event does not rehome that membership. No core fork is proposed; public-API proofs
in I1 must establish the remaining hold/claim composition before rollout.

### Design review ledger

All accepted findings were resolved without dispute:

- GPT: reject/correct Local header/folder mapping geometry before effects; preserve the selected
  worktree source projectSubdir instead of broadening Projects semantics.
- GPT: explicitly restrict the new wizard to ordinary non-subagent conversations, keeping ordinary
  fork lineage and legacy descendant behavior unchanged.
- Grok: use a separate pre-header reservation journal, not a legacy-repairable planned session row;
  cover new legacy routing and actual mixed-version/old cold-pull admission as a fail-closed I1 gate.

- GPT: a mandatory seeded header-only flush is not a readable/recoverable initial artifact. Preserve
  the exact existing inherited prefix through its marker; prove public crash/restart behavior or
  refuse unsupported seeded selection before effects. Do not assume one append is crash-atomic.

Historical Revision 3 independent review status (does not cover the new Git-context amendment):

- `github-copilot/gpt-6.1-sol`, xhigh: **APPROVE**, after independently rereading all Revision 3 sections.
- `github-copilot/grok-4.7`, xhigh: **APPROVE**, after independently rereading the written Revision 3 seed and compatibility corrections.

Current Revision 4 adds explicit portable remote/base/upstream refs and current/base OIDs, guarded
no-event metadata refresh and a local-commit provision input. BOTH independent GPT-6.1 Sol xhigh and
Grok-4.7 xhigh reviewers APPROVED the written Amendment Revision 3 and matching main Revision 4 delta;
see the [Git-context amendment review ledger](<2026-10-21-125717-HKT-cloud-import-git-context.md>).
Those scoped approvals supplement the unchanged areas' historical Revision 3 approvals.

Approval means this design is coherent, not that implementation, runtime integration, manual behavior
or user authorization has been established. I1 feasibility/compatibility proofs remain unperformed.

### User approval scope

Approve only this additive Local/New worktree import integration and the stated first-release
constraints. Cloud-primary durability, remote-fetch import bases, existing-checkout reuse, same-SID
relocation, actorless Git authority, multi-root mapping and cleanup recovery redesign remain separate.
No source modification, commit, push or deployment is authorized merely by recording this design.
