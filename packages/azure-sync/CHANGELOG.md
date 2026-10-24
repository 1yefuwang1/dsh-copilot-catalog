# @1yefuwang1/dsh-azure-sync changelog

## Unreleased — DSH 0.2.1-rc.3 retarget

Retarget `engines.dsh` and every `@deepseek-ai/dsh-*` peer/dev pin to `0.2.1-rc.3`; no behavior change.

## Unreleased — incremental verification

Manifest-only idle checks, shared canonical suffix verification/private cache, durable scoped rollback
and health, guarded data preparation/active retention, explicit account consent and history/index audit.
Fresh ownership/provenance/Ready/Continue stay mandatory; cache grants no execution. Local metadata v5
reads v4; Azure/native remain v4. Own declaration formatting preserves syntax/API under unchanged caps.
[Implementation evidence and final reviews](<../../docs/acceptance/azure-sync-incremental-verification.md>).

## Prior unreleased checkpoints

I1–I6 destination import and accepted corrections passed both independent reviews: original-SID
Local/New worktree, guarded persistence, explicit Continue/code consent, exact available-commit
placement and portable Git facts. [Destination record](<../../docs/acceptance/cloud-import-destination.md>).

Experimental 0.1.0 was not a published release. [T1–T9 baseline](<../../docs/acceptance/azure-sync.md>) and
the [original changelog](https://github.com/1yefuwang1/dsh-copilot-catalog/blob/8457104693a4728ec9f2341efbc2b10fe52c666a/packages/azure-sync/CHANGELOG.md)
retain history/limits. Tests deploy no profiles/resources; live Azure/billing, GUI/two-device/Windows
acceptance remain manual. See the operator guide for sensitive-log, authorized-writer, partial-import,
retention and unload-enforcement warnings.
