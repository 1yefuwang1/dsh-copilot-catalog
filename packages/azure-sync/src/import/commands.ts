/** Native import control shares the strict v2 coordinator; no model or shell path. */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { boundedJson, CLOUD_JSON_MAX_BYTES, CloudControlError, publicCloudError } from '../protocol.js';
import { parseCloudImportRequest, type CloudImportControllerPort } from './protocol.js';

export function registerCloudImportCommands(ctx: Context, coordinator: CloudImportControllerPort): () => void {
  const commands = ctx.get('commands') as CommandRuntime | undefined;
  if (!commands) return () => undefined;
  const shutdown = new AbortController();
  const unregister = commands.register({ name: 'cloud-import', recordInput: false,
    description: 'Import destination control. Supply one literal JSON v2 request with explicit session/operation identity; no shell expansion or credential writes.',
    input: { hint: '{"action":"import-capabilities"} | inspect-import | import-bases | plan-import | commit-import | resume-import | import-operation | cancel-import | continue-import' },
    async handler(invocation) {
      try {
        const signal = AbortSignal.any([invocation.signal, shutdown.signal]); signal.throwIfAborted();
        if (invocation.rawInput.length > CLOUD_JSON_MAX_BYTES) throw new CloudControlError('LIMIT');
        const input = boundedJson(JSON.parse(invocation.rawInput || '{"action":"import-capabilities"}'));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CloudControlError('INVALID_REQUEST');
        // The native command's genuine invoking Agent is its only Git authorizer.
        if (input.action === 'import-bases') input.permissionActorId = invocation.agent.session.id;
        if (input.action === 'plan-import' && input.destination && typeof input.destination === 'object' && !Array.isArray(input.destination) && input.destination.kind === 'worktree') input.destination.permissionActorId = invocation.agent.session.id;
        const request = parseCloudImportRequest(input);
        const result = await coordinator.execute(request, { origin: 'command', sessionId: invocation.agent.session.id, signal });
        signal.throwIfAborted();
        return { kind: 'success', text: result.kind === 'import-operation' ? `Import operation: ${result.phase}.` : result.kind === 'import-plan' ? 'Import destination reviewed; explicitly confirm its operation ID and revision.' : result.kind === 'import-source' ? result.eligible ? 'The cloud thread is eligible for destination review.' : 'The cloud thread is not eligible for destination import.' : 'Import capabilities inspected.' };
      } catch (error) { return { kind: 'error', text: publicCloudError(error).message }; }
    },
  });
  return () => { shutdown.abort(); unregister(); };
}
