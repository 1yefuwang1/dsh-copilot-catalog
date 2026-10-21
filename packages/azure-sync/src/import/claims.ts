/** Plugin-owned, local POSIX filesystem pre-effect SID claims. Never a process-local queue. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const ownerSchema = z.strictObject({ version: z.literal(1), sessionId: z.string().min(1).max(512), operationId: z.string().min(1).max(256), host: z.string().min(1).max(256), pid: z.number().int().positive(), token: z.string().uuid() });
type Owner = z.infer<typeof ownerSchema>;
export class ImportClaimError extends Error {
  constructor(readonly code: 'BUSY' | 'RECOVERY_REQUIRED' | 'UNCERTAIN' | 'LOST' | 'UNSUPPORTED', message: string) { super(message); this.name = 'ImportClaimError'; }
}
export interface SidClaim {
  readonly sessionId: string;
  readonly operationId: string;
  assertOwned(): Promise<void>;
  /** Drain already-started journal/persistence mutation slots before a priority intent write. */
  waitForWrites(): Promise<void>;
  /** Only release after all effects and ignored-abort completions have drained. Never called by an abort listener. */
  release(): Promise<void>;
}
const claims = new WeakMap<object, { sessionId: string; operationId: string; check(): Promise<void>; lane: Promise<void> }>();
/** Process-local ordering supplements, and never replaces, the cross-process exclusive claim. */
export function withSidClaim<T>(claim: SidClaim, work: () => Promise<T>): Promise<T> {
  const state = claims.get(claim);
  if (!state) return Promise.reject(new ImportClaimError('LOST', 'A genuine SID operation claim is required.'));
  const result = state.lane.then(work);
  state.lane = result.then(() => undefined, () => undefined);
  return result;
}
export async function assertSidClaim(value: SidClaim, sessionId: string, operationId: string): Promise<void> {
  const claim = claims.get(value);
  if (!claim || claim.sessionId !== sessionId || claim.operationId !== operationId) throw new ImportClaimError('LOST', 'A genuine exact-SID operation claim is required.');
  await claim.check();
}
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') throw new ImportClaimError('UNSUPPORTED', 'Import claims require a verified durable namespace primitive on this platform.');
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Create only canonical directories, syncing every newly created parent entry before effects. */
export async function ensureImportDirectory(root: string): Promise<void> {
  if (!isAbsolute(root)) throw new TypeError('Import storage root must be absolute.');
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || await realpath(root) !== resolve(root)) throw new ImportClaimError('UNCERTAIN', 'Import storage root must be a canonical directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(root);
    await ensureImportDirectory(parent);
    try { await mkdir(root, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    const info = await lstat(root);
    if (!info.isDirectory() || await realpath(root) !== resolve(root)) throw new ImportClaimError('UNCERTAIN', 'Import storage root identity changed during setup.');
    await syncDirectory(parent);
  }
  await syncDirectory(root);
}
/** Bounded regular-file read; unknown/symlink/partial metadata is never interpreted as absence. */
export async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.size > maxBytes) throw new ImportClaimError('UNCERTAIN', 'Import metadata is not a bounded regular file.');
  const handle = await open(path, 'r');
  try {
    const current = await handle.stat();
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino) throw new ImportClaimError('UNCERTAIN', 'Import metadata identity changed.');
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new ImportClaimError('UNCERTAIN', 'Import metadata exceeded its bound.');
    return bytes.toString('utf8', 0, bytesRead);
  } finally { await handle.close(); }
}
export function sidKey(sessionId: string): string {
  if (sessionId.length === 0 || Buffer.byteLength(sessionId) > 512) throw new TypeError('Invalid bounded import session ID.');
  return createHash('sha256').update(sessionId).digest('hex');
}

/**
 * Supports trusted plugin-owned local POSIX storage. Network filesystems and Windows
 * require a separately verified primitive. No TTL or PID-based automatic takeover.
 * A crash leaves a durable claim; dead/uncertain owners require explicit offline
 * reconciliation. This safe availability restriction is intentional.
 */
export class SidClaimStore {
  private constructor(readonly root: string, private readonly rootIdentity: { dev: number; ino: number }) {}
  static async open(root: string): Promise<SidClaimStore> {
    if (process.platform === 'win32') throw new ImportClaimError('UNSUPPORTED', 'Durable import SID claims are unavailable on this platform.');
    if (!isAbsolute(root)) throw new TypeError('Import claim root must be absolute.');
    await ensureImportDirectory(root);
    const canonical = await realpath(root);
    if (canonical !== resolve(root)) throw new ImportClaimError('UNCERTAIN', 'Import claim root must not traverse a symlink.');
    await syncDirectory(canonical);
    return new SidClaimStore(canonical, await lstat(canonical));
  }
  private async checkRoot() {
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.dev !== this.rootIdentity.dev || info.ino !== this.rootIdentity.ino || await realpath(this.root) !== this.root) throw new ImportClaimError('LOST', 'Import claim root identity changed.');
  }
  /** Diagnostic only. Dead/PID-reused/foreign/uncertain owners NEVER grant takeover. */
  async inspect(sessionId: string): Promise<'free' | 'busy' | 'recovery-required' | 'uncertain'> {
    await this.checkRoot();
    const path = join(this.root, `${sidKey(sessionId)}.claim`);
    try {
      if (!(await lstat(path)).isDirectory()) return 'uncertain';
      const owner = ownerSchema.parse(JSON.parse(await readBoundedFile(join(path, 'owner.json'), 4096)));
      if (owner.sessionId !== sessionId || owner.host !== hostname()) return 'uncertain';
      try { process.kill(owner.pid, 0); return 'busy'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'recovery-required' : 'uncertain'; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await lstat(path); return 'uncertain'; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 'free'; }
      }
      return 'uncertain';
    }
  }
  async acquire(sessionId: string, operationId: string): Promise<SidClaim> {
    await this.checkRoot();
    const owner = ownerSchema.parse({ version: 1, sessionId, operationId, host: hostname(), pid: process.pid, token: randomUUID() });
    const path = join(this.root, `${sidKey(sessionId)}.claim`);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let code: 'BUSY' | 'RECOVERY_REQUIRED' | 'UNCERTAIN' = 'UNCERTAIN';
      try {
        if (!(await lstat(path)).isDirectory()) throw new Error('foreign claim');
        const previous = ownerSchema.parse(JSON.parse(await readBoundedFile(join(path, 'owner.json'), 4096)));
        if (previous.sessionId !== sessionId) throw new Error('foreign SID');
        if (previous.host === hostname()) {
          try { process.kill(previous.pid, 0); code = 'BUSY'; }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') code = 'RECOVERY_REQUIRED'; }
        }
      } catch { /* Every unknown owner stays reserved. */ }
      throw new ImportClaimError(code, code === 'BUSY' ? 'Another process owns this import SID.' : 'The import SID claim requires explicit offline recovery; no takeover was attempted.');
    }
    const identity = await lstat(path);
    const ownerPath = join(path, 'owner.json');
    // Failed setup intentionally leaves an uncertain claim; effects have not started.
    const file = await open(ownerPath, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(owner)); await file.sync(); } finally { await file.close(); }
    await syncDirectory(path); await syncDirectory(this.root);
    let released = false;
    const check = async () => {
      if (released) throw new ImportClaimError('LOST', 'Import SID claim was released.');
      await this.checkRoot();
      const actual = await lstat(path);
      if (!actual.isDirectory() || actual.dev !== identity.dev || actual.ino !== identity.ino) throw new ImportClaimError('LOST', 'Import SID claim identity changed.');
      const latest: Owner = ownerSchema.parse(JSON.parse(await readBoundedFile(ownerPath, 4096)));
      if (latest.token !== owner.token || latest.sessionId !== sessionId || latest.operationId !== operationId) throw new ImportClaimError('LOST', 'Import SID claim ownership changed.');
    };
    const claim: SidClaim = Object.freeze({ sessionId, operationId, assertOwned: check, waitForWrites: () => withSidClaim(claim, async () => undefined),
      release: () => withSidClaim(claim, async () => {
        if (released) return;
        await check(); // Resolve and verify exact absolute targets before removal.
        await unlink(ownerPath);
        await rmdir(path); // No recursive delete; unexpected contents refuse rather than disappear.
        released = true;
        await syncDirectory(this.root);
      }),
    });
    claims.set(claim, { sessionId, operationId, check, lane: Promise.resolve() });
    return claim;
  }
}
