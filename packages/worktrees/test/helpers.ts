import { mkdtemp, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Canonical temporary root for owned test directories.
 *
 * `os.tmpdir()` is not canonical on every platform: macOS returns `/var/...` while
 * the same path resolves through a symlink to `/private/var/...`, and Windows can
 * return short (8.3) names or different casing than `fs.realpath`. Fixtures that
 * mixed the two forms failed their own containment assertions — the executor in
 * git.test.ts compares a canonical child against a non-canonical base, and the
 * other fixtures asserted `dirname(directory) === realpath(tmpdir())`.
 *
 * Resolving once here gives every fixture one canonical base, so a created
 * directory is always recognised as owned, on any platform.
 */
export const tmpBase = await realpath(tmpdir());

/** Create one uniquely named directory directly under the canonical temporary root. */
export async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpBase, prefix));
  if (!directory.startsWith(`${tmpBase}${sep}`)) {
    throw new Error(`temporary directory escaped its canonical root: ${directory}`);
  }
  return directory;
}
