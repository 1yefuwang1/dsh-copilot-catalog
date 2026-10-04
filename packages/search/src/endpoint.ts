import { WebError } from '@deepseek-ai/dsh-web';

/** Controlled trust failure; it never carries the rejected URL or credentials. */
export class CopilotEndpointError extends WebError {
  constructor() {
    super('Copilot search requires a trusted HTTPS Copilot API origin', 'WEB_PROVIDER_ENDPOINT_UNTRUSTED');
  }
}

/** Direct Copilot credentials must never leave their HTTPS gateway origins. */
export function trustedCopilotOrigin(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u0020\u007f-\u009f]/u.test(value) ||
      !/^https:\/\//iu.test(value) || value.includes('\\') || /^https:\/\/[^/?#]*@/iu.test(value)) {
    throw new CopilotEndpointError();
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new CopilotEndpointError(); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.githubcopilot.com') ||
      url.username || url.password || (url.port && url.port !== '443') ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new CopilotEndpointError();
  }
  return url.origin;
}
