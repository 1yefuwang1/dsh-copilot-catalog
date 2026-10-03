import { Config, apply, syncCopilotCatalog, type ModelCatalog, type SyncResult } from 'dsh-copilot-catalog';
import { liveCost, selectAccountModels } from 'dsh-copilot-catalog/catalog';
import { syncCopilotCatalog as discover, type DiscoveryError } from 'dsh-copilot-catalog/discovery';
import { Config as OriginalConfig, type apply as OriginalApply } from '@deepseek-ai/dsh-llm-pi-ai';

const preservedSchema: typeof OriginalConfig = Config;
const typedApply: (ctx: Parameters<typeof OriginalApply>[0], config: Parameters<typeof OriginalApply>[1]) => Promise<void> = apply;
const pending: Promise<SyncResult> = syncCopilotCatalog();
const selectFromUnknown = (response: unknown, catalog: ModelCatalog) => selectAccountModels(response, catalog);
const typedFailure = (error: DiscoveryError): string => error.code;

// A consumer must provide a correctly shaped fallback and explicit catalog.
// @ts-expect-error costs cannot be arbitrary strings
liveCost(undefined, 'invalid');
// @ts-expect-error a catalog must be provided explicitly
selectAccountModels({ data: [] });
// @ts-expect-error dependency injection is required for the low-level discovery helper
void discover(undefined);

void [preservedSchema, typedApply, pending, selectFromUnknown, typedFailure];
