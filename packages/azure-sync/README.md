# @1yefuwang1/dsh-azure-sync

Azure Blob + Table conversation sync for DeepSeek Harness. Opt in per thread,
keep working locally, and continue the same conversation on another device
without a database server.

This package is under active implementation against the reviewed plan
(`.review/plan-review/azure-cloud-sync/plan.md`, v4). Tasks T1–T4 provide the package scaffold, strict configuration and authentication,
Azure Blob/Table/lease adapters, canonical event bytes and hash chains, the linked
committed-index reader, effective-cwd mapping, session guards, the
`dsh_azure_sync` v4 local domain, crash-safe incremental upload with atomic
batch/tip commits, lease/epoch ownership, pre-step admission, quiet-period
drain primitives, and verified cold import with attachments, projection warm,
early write claims, and workspace attachment. Reconciliation/UI, commands, and
the browser client follow in the later tasks.

## Design in one paragraph

The plugin stores immutable event batches in a private Blob container and a
committed manifest plus linked batch index in Table Storage. A per-event hash
chain and a session lease/epoch make retries, takeovers, and deletions safe.
Attachments use `ctx.attachments`; working-directory paths are mapped between
devices. There is no Postgres, Functions, App Service, or always-on compute.

## Configuration

The plugin loads without network access. Authentication is resolved on first
sync:

- `connection-string`: read `DSH_AZURE_SYNC_CONNECTION` through the credential
  resolver injected by the sync lifecycle. T1 exposes the resolver; T3/T6 wires
  `ctx.credentials` and its environment fallback before sync is enabled.
- `azure-cli`: use the logged-in `az` account.
- `managed-identity`: use the host's Azure managed identity (optional client id).
- `auto`: use a configured connection string, otherwise
  `DefaultAzureCredential`.

`accountName` is required for token authentication. `container`, `table`, and
`connectionRef` are validated before any request. Set `allowInsecure` only for a
local emulator.

## Host capabilities

Required: `sessions`, `sessionPersistence`, `storageDomain`.

Optional capabilities are resolved lazily and degrade rather than blocking plugin
load: `sessionQuery`, `attachments` (attachments are skipped with a warning when
absent), `workspaceRegistry`, `commands`, `credentials` (resolution is supplied by
the sync lifecycle), `connection`, `agentPresets`, `llm`, and
`sessionProjectionCache`.

The Client half and browser bundle arrive in T7; T1–T4 contain no client files.

## Current verification

```sh
pnpm --filter @1yefuwang1/dsh-azure-sync run typecheck
pnpm --filter @1yefuwang1/dsh-azure-sync run test
pnpm --filter @1yefuwang1/dsh-azure-sync run test:azurite
pnpm --filter @1yefuwang1/dsh-azure-sync run test:pack
```

The default unit suite is offline (in-memory fakes plus a real JSONL persistence
fixture). `test:azurite` starts the local Azurite emulator and exercises the real
private-container, table, and atomic batch/tip transaction contract; it is a
local contract test, not live-Azure RBAC evidence.
