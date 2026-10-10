export class WorktreeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(redact(message));
    this.name = 'WorktreeError';
    this.code = code;
    this.details = details;
  }
}

/** Never put credential-bearing URLs or helper output into the command/model log. */
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu, '[redacted]')
    .replace(/([?&](?:access_token|token|password|secret)=)[^\s&#]+/giu, '$1[redacted]')
    .replace(/(authorization\s*:\s*)(?:bearer|basic)\s+\S+/giu, '$1[redacted]')
    .slice(0, 4096);
}

export function failureOf(error: unknown): { code: string; message: string } {
  if (error instanceof WorktreeError) return { code: error.code, message: redact(error.message) };
  if (error instanceof Error && error.name === 'AbortError') return { code: 'CANCELLED', message: 'The operation was cancelled; committed effects may remain.' };
  return { code: 'OPERATION_FAILED', message: redact(error instanceof Error ? error.message : String(error)) };
}

export function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorktreeError('CANCELLED', 'The operation was cancelled; committed effects may remain.');
}
