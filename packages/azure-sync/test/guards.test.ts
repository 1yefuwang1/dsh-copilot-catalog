import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGuards, assertNoSchedule, checkGuards, hasScheduleChange, latestAgentPreset, latestModelSelection } from '../src/sync/guards.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { event } from './helpers.js';

const header = { cwd: '/project', agentPreset: 'standard' };

test('no-cwd and schedule-bearing sessions are refused', () => {
  assert.equal(checkGuards({ header: { agentPreset: 'standard' }, events: [] }).code, 'no-cwd');
  assert.equal(checkGuards({ header, events: [event(0, 'schedule/change', { tasks: [] })] }).code, 'schedule-unsafe');
  assert.equal(hasScheduleChange([event(0, 'user/message'), event(1, 'schedule/change')]), true);
  assert.equal(hasScheduleChange([event(0, 'user/message')]), false);
  assert.throws(() => assertNoSchedule([event(0, 'schedule/change')]), (error: unknown) => error instanceof AzureSyncError && error.code === 'SCHEDULE_UNSAFE');
});

test('the latest preset and model selection win', () => {
  const events = [
    event(0, 'agent-preset/selected', { agentPreset: 'first' }),
    event(1, 'agent-preset/selected', { agentPreset: 'second' }),
    event(2, 'model/selection', { provider: 'p', model: 'm1' }),
    event(3, 'model/selection', { provider: 'p', model: 'm2', reasoningEffort: 'high' }),
  ];
  assert.equal(latestAgentPreset(events, header), 'second');
  assert.deepEqual(latestModelSelection(events), { provider: 'p', model: 'm2', reasoningEffort: 'high' });
  assert.equal(checkGuards({ header, events, presetAvailable: () => true }).ok, true);
  assert.equal(checkGuards({ header, events, presetAvailable: () => false }).code, 'preset-missing');
  const modelWarning = checkGuards({ header, events, modelAvailable: () => false });
  assert.equal(modelWarning.ok, true);
  assert.deepEqual(modelWarning.warnings, ['model-unavailable']);
  assert.equal(checkGuards({ header, events, modelAvailable: () => true }).ok, true);
});

test('assertGuards throws the stable code for each guard', () => {
  assert.throws(() => assertGuards({ header: {}, events: [] }), (error: unknown) => error instanceof AzureSyncError && error.code === 'NO_CWD');
  assert.throws(() => assertGuards({ header, events: [event(0, 'schedule/change')] }), (error: unknown) => error instanceof AzureSyncError && error.code === 'SCHEDULE_UNSAFE');
  assert.throws(() => assertGuards({ header, events: [], presetAvailable: () => false }), (error: unknown) => error instanceof AzureSyncError && error.code === 'PRESET_MISSING');
  assert.doesNotThrow(() => assertGuards({ header, events: [event(0, 'model/selection', { provider: 'p', model: 'm' })], modelAvailable: () => false }));
  assert.doesNotThrow(() => assertGuards({ header, events: [] }));
});
