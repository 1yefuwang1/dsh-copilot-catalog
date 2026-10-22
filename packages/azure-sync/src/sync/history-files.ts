/** Linux directory-FD capabilities: a swapped pathname can never redirect cache body IO. */
import { constants, existsSync } from 'node:fs';
import { open, mkdir, opendir, lstat, rename, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AzureSyncError } from '../azure/errors.js';
import type { HistoryOwner } from './history-work.js';
export const secureHistoryFiles = process.platform === 'linux' && existsSync('/proc/self/fd');
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
function privateMode(stat: { mode: number; uid: number }, directory: boolean): void {
  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new AzureSyncError('INVALID_CONFIG', `A private cache ${directory ? 'directory' : 'file'} has unsafe ownership or permissions.`);
}
function safeName(name: string): void {
  if (!/^[A-Za-z0-9_.-]{1,256}$/u.test(name) || name === '.' || name === '..') throw new AzureSyncError('INVALID_CONFIG', 'A cache capability name is unsafe.');
}
export class HistoryDirectory {
  private constructor(private readonly handle: FileHandle) {}
  private childPath(name: string): string { safeName(name); return `/proc/self/fd/${this.handle.fd}/${name}`; }
  private get anchor(): string { return `/proc/self/fd/${this.handle.fd}`; }
  static async root(path: string, owner: HistoryOwner, create = false): Promise<HistoryDirectory> {
    if (!secureHistoryFiles || resolve(path) !== path || path === '/') throw new AzureSyncError('INVALID_CONFIG', 'The secure private cache backend is unavailable.');
    await owner.check(); let handle = await open('/', directoryFlags);
    try {
      const parts = path.split('/').filter(Boolean);
      for (let index = 0; index < parts.length; index += 1) {
        const anchored = `/proc/self/fd/${handle.fd}/${parts[index]!}`;
        await owner.check(); let next: FileHandle;
        try { next = await open(anchored, directoryFlags); }
        catch (error) {
          if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await owner.io(() => mkdir(anchored, { mode: 0o700 })); await owner.check(); next = await open(anchored, directoryFlags);
        }
        try {
          await owner.check(); const stat = await owner.io(() => next.stat());
          if (!stat.isDirectory()) throw new AzureSyncError('INVALID_CONFIG', 'A cache ancestor is not a directory.');
          if (index === parts.length - 1) privateMode(stat, true);
        } catch (error) { await next.close(); throw error; }
        await handle.close(); handle = next;
      }
      const result = new HistoryDirectory(handle); handle = undefined as unknown as FileHandle; return result;
    } finally { await handle?.close(); }
  }
  async directory(name: string, owner: HistoryOwner, create = false): Promise<HistoryDirectory> {
    const path = this.childPath(name); await owner.check(); let handle: FileHandle;
    try { handle = await open(path, directoryFlags); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await owner.io(() => mkdir(path, { mode: 0o700 })); await owner.check(); handle = await open(path, directoryFlags);
    }
    try {
      await owner.check(); const stat = await owner.io(() => handle.stat());
      if (!stat.isDirectory()) throw new AzureSyncError('INVALID_CONFIG', 'A cache namespace is not a directory.');
      privateMode(stat, true); return new HistoryDirectory(handle);
    } catch (error) { await handle.close(); throw error; }
  }
  async names(owner: HistoryOwner): Promise<string[]> {
    await owner.check(); const directory = await opendir(this.anchor);
    try {
      const names: string[] = [];
      for (;;) {
        const entry = await owner.io(() => directory.read()); if (!entry) return names;
        if (names.length >= 100_000) throw new AzureSyncError('LIMIT', 'The private cache directory exceeds its traversal bound.');
        names.push(entry.name);
      }
    } finally { await directory.close(); }
  }
  info(owner: HistoryOwner) { return owner.io(() => this.handle.stat()); }
  stat(name: string, owner: HistoryOwner) { return owner.io(() => lstat(this.childPath(name))); }
  async read(name: string, bound: number, owner: HistoryOwner): Promise<Buffer> {
    await owner.check(); const handle = await open(this.childPath(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      await owner.check(); const stat = await owner.io(() => handle.stat());
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.size > bound) throw new AzureSyncError('LIMIT', 'A private cache file has an unsafe type or bounded size.');
      privateMode(stat, false);
      const bytes = Buffer.alloc(stat.size + 1); let length = 0;
      while (length < bytes.length) { const read = await owner.io(() => handle.read(bytes, length, bytes.length - length, length)); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length !== stat.size) throw new AzureSyncError('LIMIT', 'A private cache file changed size while reading.');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }
  async atomic(name: string, bytes: Buffer, owner: HistoryOwner): Promise<void> {
    const temporary = `${randomUUID()}.tmp`, path = this.childPath(temporary);
    await owner.check(); const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let published = false;
    try {
      await owner.check(); const stat = await owner.io(() => handle.stat()); privateMode(stat, false);
      if (!stat.isFile() || stat.nlink !== 1) throw new AzureSyncError('INVALID_CONFIG', 'A temporary cache file has unsafe identity.');
      await owner.io(() => handle.writeFile(bytes)); await owner.io(() => handle.sync());
      await owner.io(() => rename(path, this.childPath(name))); published = true;
    } finally { await handle.close(); if (!published) await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  async remove(name: string, owner: HistoryOwner): Promise<void> {
    try { await owner.io(() => unlink(this.childPath(name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  /** Demote the complete index before removing chunks; never recursively follow a swapped directory. */
  async evict(name: string, owner: HistoryOwner): Promise<void> {
    const directory = await this.directory(name, owner);
    try {
      await directory.remove('index.json', owner);
      for (const file of await directory.names(owner)) await directory.remove(file, owner);
    } finally { await directory.close(); }
    await owner.io(() => rmdir(this.childPath(name)));
  }
  close(): Promise<void> { return this.handle.close(); }
}
