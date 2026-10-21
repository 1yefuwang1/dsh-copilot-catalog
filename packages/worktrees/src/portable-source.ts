import type { PortableCreationBase, PortableRemote } from './import-contract.js';

/** Identical privacy policy to the cloud codec, without a runtime package cycle. */
export function sanitizePortableRemote(input: unknown): string | undefined {
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!text(input) || input.includes('\\')) return undefined;
  let candidate = input;
  if (!candidate.includes('://')) {
    if (/^(?:file|ext|javascript|data|mailto|https?|ssh|git|ftp):/iu.test(candidate)) return undefined;
    const core = candidate.split(/[?#]/u, 1)[0]!;
    if (candidate.slice(core.length).includes('@')) return undefined;
    const scp = /^(?:[^@/:?#\s]+@)?([A-Za-z0-9][A-Za-z0-9.-]*):([^@:\s?#]+)$/u.exec(core);
    if (!scp || scp[1]!.length === 1 || !scp[2] || scp[2]!.startsWith(':')) return undefined;
    candidate = `ssh://${scp[1]}/${scp[2]!.replace(/^\//u, '')}`;
  }
  try {
    const url = new URL(candidate);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || url.hostname.includes('%') || url.pathname.includes('\\')) return undefined;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return text(url.href) ? url.href : undefined;
  } catch { return undefined; }
}
export function portableRemote(name: string, urls: readonly string[]): PortableRemote | undefined {
  if (!name || name === '.' || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name) || urls.length !== 1) return undefined;
  const sanitizedUrl = sanitizePortableRemote(urls[0]);
  return sanitizedUrl === undefined ? undefined : { name, sanitizedUrl };
}
export function sameCreationBase(a: PortableCreationBase | undefined, b: PortableCreationBase | undefined): boolean { return JSON.stringify(a) === JSON.stringify(b); }
