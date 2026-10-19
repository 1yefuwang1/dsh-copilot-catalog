import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Azurite's public, non-production emulator key. Never use a real Azure account.
export const emulatorKey = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

export async function temporaryRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeTemporaryRoot(root: string, prefix: string): Promise<void> {
  assert.equal(resolve(root), root);
  assert.equal(dirname(root), await realpath(tmpdir()));
  assert.ok(basename(root).startsWith(prefix));
  assert.equal(await realpath(root), root, 'never recursively remove a replaced/symlinked root');
  await rm(root, { recursive: true, force: false });
}

/** Real managed emulator, separate account namespaces, no shared/default ports or files. */
export async function startAzurite() {
  const prefix = 'azure-control-emulator-';
  const root = await temporaryRoot(prefix);
  // Reserve distinct ports simultaneously, rather than reusing a just-closed port.
  const reserved = await Promise.all(Array.from({ length: 3 }, () => new Promise<{ server: ReturnType<typeof createServer>; port: number }>((done, fail) => {
    const server = createServer(); server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) { server.close(); fail(new Error('No ephemeral address.')); return; }
      done({ server, port: address.port });
    });
  })));
  const [blobPort, tablePort, queuePort] = reserved.map(value => value.port) as [number, number, number];
  await Promise.all(reserved.map(({ server }) => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))));
  const executable = resolve(fileURLToPath(new URL('.', import.meta.url)), '../node_modules/.bin', process.platform === 'win32' ? 'azurite.cmd' : 'azurite');
  const child = spawn(executable, ['--silent', '--location', root, '--blobHost', '127.0.0.1', '--blobPort', String(blobPort), '--tableHost', '127.0.0.1', '--tablePort', String(tablePort), '--queueHost', '127.0.0.1', '--queuePort', String(queuePort), '--skipApiVersionCheck'], {
    stdio: 'ignore', env: { ...process.env, AZURITE_ACCOUNTS: `devstoreaccount1:${emulatorKey};controlalternate:${emulatorKey}` },
  });
  let failure: Error | undefined;
  child.once('error', error => { failure = error; });
  const exited = new Promise<void>(done => { child.once('exit', () => done()); child.once('error', () => done()); });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 3_000); force.unref();
      try { await exited; } finally { clearTimeout(force); }
    }
    await removeTemporaryRoot(root, prefix);
  };
  try {
    const deadline = Date.now() + 20_000;
    for (const port of [blobPort, tablePort, queuePort]) {
      for (;;) {
        if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error('Azurite exited before readiness.', { cause: failure });
        const ready = await new Promise<boolean>(done => {
          const socket = connect(port, '127.0.0.1');
          socket.once('connect', () => { socket.destroy(); done(true); });
          socket.once('error', () => { socket.destroy(); done(false); });
        });
        if (ready) break;
        if (Date.now() > deadline) throw new Error('Azurite did not become ready.');
        await new Promise(done => setTimeout(done, 50));
      }
    }
  } catch (error) { await close(); throw error; }
  return {
    close,
    connection(account = 'devstoreaccount1') {
      assert.ok(account === 'devstoreaccount1' || account === 'controlalternate');
      return `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${emulatorKey};BlobEndpoint=http://127.0.0.1:${blobPort}/${account};TableEndpoint=http://127.0.0.1:${tablePort}/${account};QueueEndpoint=http://127.0.0.1:${queuePort}/${account};`;
    },
  };
}

export async function eventually(predicate: () => Promise<boolean> | boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, description);
    await new Promise(done => setTimeout(done, 25));
  }
}
