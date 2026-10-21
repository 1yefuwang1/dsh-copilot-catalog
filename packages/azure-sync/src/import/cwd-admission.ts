/** Public kernel mutex for profile-wide creation-CWD admission. No stale-owner stealing. */
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ensureImportDirectory, ImportClaimError, syncDirectory } from './claims.js';

export interface CwdAdmissionLease { assertHeld(): Promise<void>; release(): Promise<void> }
/** Resolve existing ancestor aliases without requiring a future checkout to exist. */
export async function canonicalAdmissionCwd(input: string): Promise<string> {
  if (!isAbsolute(input) || Buffer.byteLength(input) > 4096 || /[\0\r\n]/u.test(input)) throw new ImportClaimError('UNCERTAIN', 'Native creation cwd is not a bounded absolute path.');
  let path = resolve(input); const suffix: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    try { return join(await realpath(path), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(path); if (parent === path) throw error;
      suffix.unshift(path.slice(parent.length).replace(/^\/+/, '')); path = parent;
    }
  }
  throw new ImportClaimError('UNCERTAIN', 'Native creation cwd exceeds the canonical ancestor bound.');
}
export class CwdAdmissionMutex {
  private constructor(readonly root: string, private readonly path: string, private readonly identity: { dev: number; ino: number }, private readonly lock: (fd: number) => Promise<void>) {}
  static async open(root: string): Promise<CwdAdmissionMutex> {
    await ensureImportDirectory(root);
    const canonical = await realpath(root); const path = join(canonical, 'admission.lock');
    // Only feature setup loads this optional public addon. Legacy Azure imports
    // never require it; unsupported guard setup refuses before Native admission.
    const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock');
    const handle = await open(path, 'a+', 0o600);
    try { const info = await handle.stat(); if (!info.isFile()) throw new ImportClaimError('UNCERTAIN', 'Cwd admission lock is not a regular file.'); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirectory(canonical);
    const info = await lstat(path);
    if (!info.isFile() || await realpath(path) !== path) throw new ImportClaimError('UNCERTAIN', 'Cwd admission lock identity is uncertain.');
    const mutex = new CwdAdmissionMutex(canonical, path, info, tryLockExclusive);
    const probe = await mutex.acquire(); await probe.release();
    return mutex;
  }
  async acquire(signal?: AbortSignal): Promise<CwdAdmissionLease> {
    signal?.throwIfAborted();
    if (await realpath(this.root) !== this.root) throw new ImportClaimError('UNCERTAIN', 'Cwd admission storage moved.');
    const file = await open(this.path, 'r+'); let released = false;
    const check = async () => {
      if (released) throw new ImportClaimError('LOST', 'Cwd admission lock was released.');
      const [actual, path] = await Promise.all([file.stat(), lstat(this.path)]);
      if (!path.isFile() || actual.dev !== this.identity.dev || actual.ino !== this.identity.ino || path.dev !== actual.dev || path.ino !== actual.ino) throw new ImportClaimError('UNCERTAIN', 'Cwd admission lock identity changed.');
    };
    try {
      await check();
      // The public native binding requires keeping fd open until this async
      // nonblocking syscall settles, even if cancellation arrives meanwhile.
      await this.lock(file.fd); await check(); signal?.throwIfAborted();
      return Object.freeze({ assertHeld: check, release: async () => { if (released) return; released = true; await file.close(); } });
    } catch (error) {
      released = true; await file.close();
      if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ImportClaimError('BUSY', 'Another Native create or import owns cwd admission.');
      throw error;
    }
  }
}
