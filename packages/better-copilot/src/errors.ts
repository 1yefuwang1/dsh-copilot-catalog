import { WebError } from '@deepseek-ai/dsh-web';

const MESSAGES = {
  WEB_INVALID_CONFIG: 'Copilot search configuration is unavailable or invalid',
  WEB_INVALID_REQUEST: 'Copilot search requires a nonempty query',
  WEB_PROVIDER_CREDENTIAL_MISSING: 'Copilot search credentials are missing; sign in or configure a credential reference',
  WEB_PROVIDER_AUTH_INVALID: 'Copilot search credentials are invalid; sign in again',
  WEB_PROVIDER_AUTH_ERROR: 'Copilot search authentication failed; check credentials or sign in again',
  WEB_PROVIDER_AUTH_WRITE_REFUSED: 'Copilot search cannot modify this credential record',
  WEB_PROVIDER_ENDPOINT_MISSING: 'Copilot search requires a trusted API origin',
  WEB_PROVIDER_ENDPOINT_UNTRUSTED: 'Copilot search requires a trusted HTTPS Copilot API origin',
  WEB_PROVIDER_UNSUPPORTED: 'The Copilot model or endpoint does not support this native search request',
  WEB_HTTP_ERROR: 'Copilot search returned an unsuccessful HTTP response',
  WEB_NETWORK_ERROR: 'Copilot search could not complete the network request',
  WEB_INVALID_RESPONSE: 'Copilot search returned an invalid native response',
  WEB_RESPONSE_FAILED: 'Copilot native search failed',
  WEB_RESPONSE_INCOMPLETE: 'Copilot native search did not complete',
  WEB_STREAM_INCOMPLETE: 'Copilot search stream ended before a completed response',
  WEB_NO_SEARCH: 'Copilot response did not execute a completed native search',
  WEB_ABORTED: 'Copilot search was cancelled',
  WEB_TIMEOUT: 'Copilot search exceeded its time limit',
  WEB_RESPONSE_TOO_LARGE: 'Copilot search exceeded its response byte limit',
} as const;
export type CopilotSearchErrorCode = keyof typeof MESSAGES;

/** Owned controlled diagnostics: never attach raw exceptions, bodies, URLs, or credentials. */
export class CopilotSearchError extends WebError {
  constructor(code: CopilotSearchErrorCode) {
    const safeCode = isSearchErrorCode(code) ? code : 'WEB_INVALID_RESPONSE';
    super(MESSAGES[safeCode], safeCode);
  }
}
function isSearchErrorCode(value: unknown): value is CopilotSearchErrorCode {
  return typeof value === 'string' && Object.hasOwn(MESSAGES, value);
}
export function searchError(code: CopilotSearchErrorCode): CopilotSearchError {
  return new CopilotSearchError(code);
}
/** Reconstitute even owned instances: injected dependencies can mutate public Error fields. */
export function responseError(error: unknown): CopilotSearchError {
  try {
    if (error instanceof CopilotSearchError && isSearchErrorCode(error.code)) return searchError(error.code);
  } catch { /* hostile accessors are not diagnostics */ }
  return searchError('WEB_INVALID_RESPONSE');
}
/** Preserve only a small set of credential error codes, never the injected error's message. */
export function authError(error: unknown): CopilotSearchError {
  if (error instanceof WebError && [
    'WEB_PROVIDER_CREDENTIAL_MISSING', 'WEB_PROVIDER_AUTH_INVALID', 'WEB_PROVIDER_AUTH_WRITE_REFUSED',
    'WEB_PROVIDER_ENDPOINT_MISSING', 'WEB_PROVIDER_ENDPOINT_UNTRUSTED',
  ].includes(error.code)) return searchError(error.code as CopilotSearchErrorCode);
  return searchError('WEB_PROVIDER_AUTH_ERROR');
}
