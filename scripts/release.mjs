import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { packages, releasePackage } from './workspaces.mjs';

export function releaseIdentity(tag, repository, candidates) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('Release repository must name the actual GitHub owner/repository');
  }
  const selected = releasePackage(tag, candidates);
  const { manifest, path } = selected;
  if (!['dsh-copilot-catalog', 'dsh-copilot-search', 'dsh-worktrees'].includes(manifest.name) ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new Error('Invalid release package identity');
  }
  if (manifest.repository?.url !== `git+https://github.com/${repository}.git` || manifest.repository.directory !== path) {
    throw new Error('Set the package repository URL and directory before publishing');
  }
  return { package: manifest.name, version: manifest.version, directory: path };
}

async function main() {
  const identity = releaseIdentity(process.env.RELEASE_TAG, process.env.RELEASE_REPOSITORY, await packages());
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(identity).map(([key, value]) => `${key}=${value}\n`).join(''), 'utf8');
  }
  console.log(`Validated release: ${identity.package}@${identity.version} from ${identity.directory}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
