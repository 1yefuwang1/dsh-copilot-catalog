import { isTrustedCopilotUrl } from './identity.js';

/**
 * Remove the empty text turn that Copilot's chat-completions route rejects.
 *
 * The route validates message content before it resolves the model: a `user`,
 * `system` or `developer` message whose `content` is the empty string fails the
 * whole request with `400 {"error":{"message":"invalid request body",
 * "code":"invalid_request_body"}}`, and the error names neither the message nor
 * the role. A harness retry can persist such a turn with no content, and the
 * turn then poisons every later request on that route because it stays in the
 * history.
 *
 * Only the exact failing shape is repaired. The same route accepts a
 * whitespace-only string, an empty content array and an empty assistant or tool
 * message, so none of those are touched: a body that is already valid stays
 * byte-identical.
 *
 * @module dsh-better-copilot/messages
 */

/**
 * The largest serialized request this repair will parse.
 *
 * Unlike the tool-schema guard the defect lives in the history itself, so the
 * bound has to clear ordinary long conversations rather than only declarations.
 * Anything past this bound is left byte-identical instead of copied and
 * re-serialized.
 */
export const MAX_TRIMMABLE_BODY_BYTES = 32 * 1024 * 1024;

/** Roles whose empty string content Copilot refuses to decode. */
const EMPTY_TEXT_ROLES = new Set(['user', 'system', 'developer']);

/** The only Copilot inference surface that carries a `messages` array. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One repaired request body plus the number of messages the repair removed. */
export interface TrimmedBody {
  /** The re-serialized body, or `undefined` when the request stays byte-identical. */
  readonly body: string | undefined;
  /** Messages removed; zero whenever {@link TrimmedBody.body} is `undefined`. */
  readonly dropped: number;
}

/**
 * Whether one message carries the empty string Copilot refuses.
 *
 * The empty string is the whole defect: a content array (even an empty one) and
 * a whitespace-only string both decode, so the rule stays on the exact shape
 * that fails rather than guessing at near misses.
 */
function isEmptyTextTurn(message: unknown): boolean {
  if (!isRecord(message)) return false;
  if (typeof message.role !== 'string' || !EMPTY_TEXT_ROLES.has(message.role)) return false;
  return message.content === '';
}

/**
 * The chat-completions surface, the only one whose body carries `messages`.
 * @param url - the request URL the wire transform was handed.
 * @returns whether the request targets that surface.
 */
export function isChatCompletionsSurface(url: URL): boolean {
  return url.pathname === CHAT_COMPLETIONS_PATH || url.pathname.startsWith(`${CHAT_COMPLETIONS_PATH}/`);
}

/**
 * Remove empty text turns from an already-parsed request.
 *
 * The object-level half of {@link normalizeCopilotMessages}: it mutates the
 * parsed request and reports how many turns it removed, so one parse can serve
 * every wire stage. It never empties the message list, because Copilot rejects
 * that with a different error of its own.
 *
 * @param request - the parsed request body.
 * @returns the number of messages removed.
 */
export function applyEmptyMessageDrop(request: Record<string, unknown>): number {
  if (!Array.isArray(request.messages)) return 0;
  const messages = request.messages;
  const kept = messages.filter((message) => !isEmptyTextTurn(message));
  const dropped = messages.length - kept.length;
  // An all-empty history is a different, separately reported rejection; leave it alone.
  if (dropped === 0 || kept.length === 0) return 0;
  // Assigning an existing key keeps `messages` at its original position.
  request.messages = kept;
  return dropped;
}

/**
 * Normalize empty text turns on one serialized Copilot chat-completions request.
 *
 * Nothing is invented: a body that is not JSON, carries no message array,
 * exceeds the bound, targets another route, or has no empty text turn is
 * returned untouched.
 *
 * Kept for the package surface and its unit tests; the mounted plugin now runs
 * {@link applyEmptyMessageDrop} inside the single-parse wire pass.
 *
 * @param url - the request URL the wire transform was handed.
 * @param body - the serialized request body as the adapter built it.
 * @returns the repaired body and how many turns it dropped.
 */
export function normalizeCopilotMessages(url: URL, body: string): TrimmedBody {
  const unchanged: TrimmedBody = { body: undefined, dropped: 0 };
  if (!isTrustedCopilotUrl(url) || !isChatCompletionsSurface(url)) return unchanged;
  if (body.length === 0 || body.length > MAX_TRIMMABLE_BODY_BYTES) return unchanged;
  // A cheap pre-check keeps every non-message body out of the JSON parser entirely.
  if (!body.includes('"messages"')) return unchanged;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  }
  catch {
    return unchanged;
  }
  if (!isRecord(parsed)) return unchanged;
  const dropped = applyEmptyMessageDrop(parsed);
  return dropped === 0 ? unchanged : { body: JSON.stringify(parsed), dropped };
}
