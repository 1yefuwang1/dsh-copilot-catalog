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
  // GHE Cloud routes Copilot through a tenant-specific API, not the tenant apex
  // or api.<tenant> authentication service. Tenant slugs are single DNS labels.
  const trustedHost = url.hostname.endsWith('.githubcopilot.com') ||
    /^copilot-api\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/u.test(url.hostname);
  if (url.protocol !== 'https:' || !trustedHost ||
      url.username || url.password || (url.port && url.port !== '443') ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new CopilotEndpointError();
  }
  return url.origin;
}
