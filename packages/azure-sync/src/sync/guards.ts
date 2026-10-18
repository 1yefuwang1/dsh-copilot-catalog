/**
 * Session-class guards that must run before a cloud write or import. They are
 * intentionally small and pure so the uploader/importer can apply them at every
 * boundary, not only at toggle time.
 * @module @1yefuwang1/dsh-azure-sync/sync/guards
 */
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import { AzureSyncError } from '../azure/errors.js';
import type { SyncStatus } from '../schema.js';

export interface GuardEvent {
  readonly type: string;
  readonly data?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Any historical or new schedule/change makes the thread unsyncable in v1. */
export function hasScheduleChange(events: readonly GuardEvent[]): boolean {
  return events.some((event) => event.type === 'schedule/change');
}

/** Latest explicit preset selection wins over the immutable header. */
export function latestAgentPreset(events: readonly GuardEvent[], header: Pick<SessionHeader, 'agentPreset'>): string | undefined {
  let preset = header.agentPreset;
  for (const event of events) {
    if (event.type !== 'agent-preset/selected') continue;
    const data = record(event.data);
    if (typeof data?.['agentPreset'] === 'string' && data['agentPreset'].length > 0) preset = data['agentPreset'];
  }
  return preset;
}

export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** Latest model selection, if one is present. */
export function latestModelSelection(events: readonly GuardEvent[]): ModelSelection | undefined {
  let selection: ModelSelection | undefined;
  for (const event of events) {
    if (event.type !== 'model/selection') continue;
    const data = record(event.data);
    if (typeof data?.['provider'] !== 'string' || typeof data['model'] !== 'string') continue;
    selection = {
      provider: data['provider'],
      model: data['model'],
      ...(typeof data['reasoningEffort'] === 'string' ? { reasoningEffort: data['reasoningEffort'] } : {}),
    };
  }
  return selection;
}

export interface GuardInput {
  readonly header: Pick<SessionHeader, 'cwd' | 'agentPreset'>;
  readonly events: readonly GuardEvent[];
  readonly presetAvailable?: (preset: string) => boolean;
  readonly modelAvailable?: (selection: ModelSelection) => boolean;
}

export interface GuardResult {
  readonly ok: boolean;
  readonly code?: SyncStatus;
  readonly detail?: string;
  readonly warnings?: readonly SyncStatus[];
}

/** Check the v1 session classes: cwd, schedules, and a usable agent preset. */
export function checkGuards(input: GuardInput): GuardResult {
  if (input.header.cwd === undefined) return { ok: false, code: 'no-cwd', detail: 'This session has no working directory; DSH cannot list or resume it cold.' };
  if (hasScheduleChange(input.events)) return { ok: false, code: 'schedule-unsafe', detail: 'This session contains schedule/change events; schedule transfer is unsupported.' };
  const preset = latestAgentPreset(input.events, input.header);
  if (preset !== undefined && input.presetAvailable !== undefined && !input.presetAvailable(preset)) {
    return { ok: false, code: 'preset-missing', detail: `The agent preset "${preset}" is not available on this device.` };
  }
  const model = latestModelSelection(input.events);
  if (model !== undefined && input.modelAvailable !== undefined && !input.modelAvailable(model)) {
    // A missing model is advisory: import/sync may proceed and the user can pick
    // another model before sending. It must not refuse a cold continuation.
    return { ok: true, warnings: ['model-unavailable'], detail: 'The selected model is not available on this device.' };
  }
  return { ok: true };
}

/** Throw the stable guard failure for callers that cannot continue. */
export function assertGuards(input: GuardInput): void {
  const result = checkGuards(input);
  if (result.ok) return;
  const mapping: Partial<Record<SyncStatus, 'NO_CWD' | 'SCHEDULE_UNSAFE' | 'PRESET_MISSING'>> = {
    'no-cwd': 'NO_CWD', 'schedule-unsafe': 'SCHEDULE_UNSAFE', 'preset-missing': 'PRESET_MISSING',
  };
  const code = result.code === undefined ? undefined : mapping[result.code];
  throw new AzureSyncError(code ?? 'INVALID_RECORD', result.detail ?? 'The session cannot be synced.');
}

/** Reject a new schedule event at upload/suffix-import time. */
export function assertNoSchedule(events: readonly GuardEvent[]): void {
  if (hasScheduleChange(events)) throw new AzureSyncError('SCHEDULE_UNSAFE', 'A schedule/change event cannot be transferred to another device.');
}
