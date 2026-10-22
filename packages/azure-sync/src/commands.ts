import type { Context } from '@deepseek-ai/cordis';
import type { CommandDefinition, CommandRuntime } from '@deepseek-ai/dsh-commands';
import { syncStatusSchema } from './schema.js';
import { cloudSuccess, CloudControlError, parseCloudAuditResult, parseCloudRequest, publicCloudError, type CloudControllerPort, type CloudRequest } from './protocol.js';

/**
 * Literal token grammar, not a shell: whitespace separates tokens; single/double
 * quotes group path tokens and are removed. Backslashes are literal, including
 * in Windows paths. There are no escapes, substitutions, expansions, or shell
 * execution. Different quote styles can quote each other; segments concatenate.
 *
 * /cloud status|on|off|sync|pull|mappings|detach|export|acknowledge-degraded|check-ownership|test-auth
 * /cloud verify [session-id]   (downloads the complete committed cloud copy; no writer permission)
 * /cloud map <linux|darwin|win32> <remotePrefix> <localPrefix> [--id <UUID>]
 * /cloud unmap <UUID>
 * /cloud repair [--confirm-mapping]
 * /cloud takeover --confirm   (acknowledges already-running tools may finish)
 * /cloud resurrect --confirm
 * /cloud remove --confirm --retain-attachments   (attachments are not deleted)
 *
 * Authentication writes are deliberately RPC-only; this command never accepts
 * credentials. All input recording is disabled, even for malformed secret args.
 */
export const CLOUD_COMMAND_GRAMMAR = 'Literal quoted tokens; pull [session-id] or pull [--cursor token] [--limit 1..100]; verify [session-id] downloads and audits the full cloud history without writer permission; map <linux|darwin|win32> <remotePrefix> <localPrefix> [--id UUID]; unmap UUID; repair [--confirm-mapping]; takeover/resurrect --confirm; remove --confirm --retain-attachments. Takeover acknowledges in-flight tools; removal retains attachments. No shell expansion or credential writes.';

function invalid(): never { throw new CloudControlError('INVALID_REQUEST'); }
function tokens(rawInput: string): string[] {
  if (rawInput.length > 16384 || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(rawInput)) invalid();
  const result: string[] = [];
  let quote: '"' | "'" | undefined; let token = ''; let started = false;
  for (const character of rawInput) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; }
    else if (/\s/u.test(character)) {
      if (started) { result.push(token); token = ''; started = false; }
    } else { token += character; started = true; }
    if (result.length > 16) invalid();
  }
  if (quote !== undefined) invalid();
  if (started) result.push(token);
  return result;
}

/** Parse only literal arguments; no native command can write a credential. */
export function parseCloudCommand(rawInput: string): CloudRequest {
  const [action = 'status', ...args] = tokens(rawInput);
  let request: unknown;
  switch (action) {
    case 'on': case 'off':
      if (args.length !== 0) invalid();
      request = { action: 'toggle', enabled: action === 'on' }; break;
    case 'pull': {
      if (args.length === 0) { request = { action }; break; }
      if (args.length === 1 && !args[0]!.startsWith('--')) { request = { action, sessionId: args[0] }; break; }
      const page: { action: 'pull'; cursor?: string; limit?: number } = { action: 'pull' };
      const used = new Set<string>();
      if (args.length % 2 !== 0) invalid();
      for (let index = 0; index < args.length; index += 2) {
        const flag = args[index]!; const value = args[index + 1]!;
        if (used.has(flag)) invalid(); used.add(flag);
        if (flag === '--cursor') page.cursor = value;
        else if (flag === '--limit' && /^\d+$/u.test(value)) page.limit = Number(value);
        else invalid();
      }
      request = page; break;
    }
    case 'verify':
      if (args.length > 1 || args[0]?.startsWith('--')) invalid();
      request = { action, ...(args.length === 1 ? { sessionId: args[0] } : {}) }; break;
    case 'status': case 'sync': case 'mappings': case 'detach': case 'export': case 'acknowledge-degraded': case 'check-ownership': case 'test-auth':
      if (args.length !== 0) invalid();
      request = { action }; break;
    case 'repair':
      if (args.length > 1 || (args.length === 1 && args[0] !== '--confirm-mapping')) invalid();
      request = { action, ...(args.length === 1 ? { confirmMapping: true } : {}) }; break;
    case 'map': {
      if (args.length !== 3 && !(args.length === 5 && args[3] === '--id')) invalid();
      const [remotePlatform, remotePrefix, localPrefix] = args;
      request = { action, mapping: { remotePlatform, remotePrefix, localPrefix, ...(args.length === 5 ? { id: args[4] } : {}) } }; break;
    }
    case 'unmap':
      if (args.length !== 1) invalid();
      request = { action, mappingId: args[0] }; break;
    case 'takeover': case 'resurrect':
      if (args.some(argument => argument !== '--confirm') || args.length > 1) invalid();
      request = { action, ...(args.length === 1 ? { confirm: true } : {}) }; break;
    case 'remove':
      if (args.length > 2 || new Set(args).size !== args.length || args.some(argument => argument !== '--confirm' && argument !== '--retain-attachments')) invalid();
      request = { action, ...(args.includes('--confirm') ? { confirm: true } : {}), ...(args.includes('--retain-attachments') ? { acknowledgeAttachmentsRetained: true } : {}) }; break;
    default: return invalid();
  }
  return parseCloudRequest(request);
}

const SUCCESS: Record<CloudRequest['action'], string> = {
  status: 'Cloud sync status checked.', toggle: 'Cloud sync preference updated.', sync: 'Cloud sync requested.',
  pull: 'Cloud pull completed; without a selected thread, only the remote list is requested.',
  map: 'Cloud folder mapping saved.', unmap: 'Cloud folder mapping removed.', mappings: 'Cloud folder mappings checked.',
  takeover: 'Cloud ownership takeover requested; in-flight tools may finish.', detach: 'Cloud thread detached.',
  remove: 'Cloud thread removed; attachments are retained.', export: 'Cloud thread export completed.', repair: 'Cloud thread repair requested.',
  resurrect: 'Cloud thread resurrection requested.', 'acknowledge-degraded': 'Degraded cloud sync state acknowledged.',
  'check-ownership': 'Cloud ownership checked.', 'set-auth': 'Cloud authentication updated.', 'test-auth': 'Cloud authentication checked.',
  'set-defaults': 'Cloud defaults updated.', 'git-info': 'Read-only local Git facts inspected.',
  verify: 'Cloud copy verified at the audited history cutoff; this does not grant writer permission.',
};

/** Native result events contain only finite vocabulary or generated session ids, never arbitrary DTO text. */
function commandText(request: CloudRequest, data: unknown): string {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return SUCCESS[request.action];
  const value = data as Record<string, unknown>;
  if (request.action === 'status' && value.kind === 'status') {
    if (Array.isArray(value.items) && value.items.length > 0) {
      const first = value.items[0] as { status?: unknown; enabled?: unknown };
      const status = syncStatusSchema.safeParse(first?.status);
      if (status.success && typeof first.enabled === 'boolean') return `Cloud sync: ${first.enabled ? 'on' : 'off'}; status: ${status.data}.`;
    }
    if (value.untracked !== undefined) return 'Cloud sync is off; this thread is not tracked.';
  }
  if (request.action === 'verify' && typeof value.sessionId === 'string') {
    const audit = parseCloudAuditResult(value.detail, value.sessionId);
    return `Cloud copy verified: generation ${audit.watermark.generation}, ${audit.watermark.eventCount} events, ${audit.watermark.batchCount} batches. ${audit.current ? 'Current at the final audit observation.' : 'The cloud advanced beyond this audited cutoff.'} No writer permission was granted.`;
  }
  if (request.action === 'check-ownership' && value.detail !== null && typeof value.detail === 'object') {
    const owned = (value.detail as { owned?: unknown }).owned;
    if (typeof owned === 'boolean') return owned ? 'Cloud ownership confirmed for this step.' : 'Cloud ownership is not confirmed; continuation is blocked.';
  }
  if (request.action === 'pull' && request.sessionId === undefined && Array.isArray(value.items)) {
    const ids = value.items.flatMap(item => {
      if (item === null || typeof item !== 'object') return [];
      const id = (item as { sessionId?: unknown }).sessionId;
      return typeof id === 'string' && /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id) ? [id] : [];
    }).slice(0, 100);
    return `Remote threads in this page: ${value.items.length}.${ids.length === 0 ? '' : '\n' + ids.join('\n')}\nUse /cloud pull <session-id> to import, or cloud settings to browse other ids/pages.`;
  }
  return SUCCESS[request.action];
}

/** Direct native command execution: no model dispatch, raw logs, or provider text. */
export function registerCloudCommands(ctx: Context, controller: CloudControllerPort): () => void {
  const commands = ctx.get('commands') as Pick<CommandRuntime, 'register'> | undefined;
  if (commands === undefined) return () => undefined;
  const shutdown = new AbortController();
  let closed = false;
  const stop = ctx.effect(() => {
    const definition: CommandDefinition = {
      name: 'cloud', description: 'Control cloud thread sync. ' + CLOUD_COMMAND_GRAMMAR,
      input: { hint: 'status | on | off | sync | pull | verify [session-id] | map | unmap | mappings | takeover | detach | remove | export | repair | resurrect | acknowledge-degraded' },
      recordInput: false,
      async handler(invocation) {
        try {
          const signal = AbortSignal.any([invocation.signal, shutdown.signal]);
          if (closed || signal.aborted) throw new CloudControlError('CANCELLED');
          const request = parseCloudCommand(invocation.rawInput);
          let abort!: () => void;
          const cancelled = new Promise<never>((_resolve, reject) => {
            abort = () => reject(new CloudControlError('CANCELLED'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
          const work = Promise.resolve().then(() => {
            if (signal.aborted) throw new CloudControlError('CANCELLED');
            return controller.execute(request, { sessionId: invocation.agent.session.id, origin: 'command', signal });
          });
          try {
            const data = await Promise.race([work, cancelled]);
            if (signal.aborted) throw new CloudControlError('CANCELLED');
            const snapshot = cloudSuccess(data);
            if (!snapshot.ok) throw new CloudControlError('OPERATION_FAILED');
            // The registry durably records result text. Project only finite status
            // vocabulary/generated ids; never stringify arbitrary DTOs or paths.
            return { kind: 'success', text: commandText(request, snapshot.data) };
          } finally { signal.removeEventListener('abort', abort); }
        } catch (error) { return { kind: 'error', text: publicCloudError(error).message }; }
      },
    };
    const unregister = commands.register(definition);
    return () => { closed = true; shutdown.abort(); unregister(); };
  }, 'azure-sync: native cloud command');
  return () => { stop(); };
}
