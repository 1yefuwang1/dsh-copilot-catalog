export { createCopilotAuthResolver, createCopilotCredentialStore, callerSignal, CopilotAuthError } from './auth.js';
export { CopilotEndpointError, trustedCopilotOrigin } from './endpoint.js';
export { CopilotSearchError, authError, responseError, searchError } from './errors.js';
export { COPILOT_SEARCH_PROVIDER_ID, CopilotSearchProvider } from './provider.js';
export { createSafeCopilotRefresh } from './refresh.js';
export { normalizeResponsesResponse, parseResponsesJSON, parseResponsesSSE, ResponsesSSEParser, safeSourceUrl } from './responses.js';
export type { CopilotCredentialService } from './auth.js';
export type { CopilotSearchErrorCode } from './errors.js';
export type { NativeSearchResult } from './responses.js';
export type {
  CopilotAuthOptions,
  CopilotSearchOptions,
  ResolvedCopilotAuth,
  SearchContext,
  SearchMode,
  SearchRuntime,
} from './search-types.js';
