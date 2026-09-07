import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIRECT_FILE_TRANSFER_WORKER_KIND } from '../../shared/direct-file-transfer.js';
import { spawnDirectFileTransferChild } from '../../src/daemon/direct-file-transfer-ipc.js';

describe('P0 direct transfer native crash containment', () => {
  it('loads node-datachannel only behind an OS child-process boundary', async () => {
    const proxy = await readFile(path.join(process.cwd(), 'src/daemon/direct-file-transfer.ts'), 'utf8');
    const runtime = await readFile(path.join(process.cwd(), 'src/daemon/direct-file-transfer-worker.ts'), 'utf8');
    const ipc = await readFile(path.join(process.cwd(), 'src/daemon/direct-file-transfer-ipc.ts'), 'utf8');

    expect(proxy).not.toContain("from 'node:worker_threads'");
    expect(runtime).not.toContain("from 'node:worker_threads'");
    expect(proxy).toContain('spawnDirectFileTransferChild');
    expect(ipc).toContain("from 'node:child_process'");
    expect(ipc).toContain('fork(');
  });

  it.runIf(process.platform !== 'win32')('contains a real child SIGSEGV without terminating the daemon process', async () => {
    const parentPid = process.pid;
    const child = spawnDirectFileTransferChild(
      pathToFileURL(path.join(process.cwd(), 'test/daemon/fixtures/direct-file-transfer-sigsegv-child.mjs')),
      { workerData: { kind: DIRECT_FILE_TRANSFER_WORKER_KIND, generation: 1 } },
    );
    const [ready] = await once(child, 'message') as [{ type: string; pid: number }];
    expect(ready).toMatchObject({ type: 'fixture.ready' });
    expect(ready.pid).not.toBe(parentPid);
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(code).toBeNull();
    expect(signal).toBe('SIGSEGV');
    expect(process.pid).toBe(parentPid);
  });

  it.runIf(process.platform === 'linux')('recycles negotiated native transfers even while their lease remains warm', async () => {
    const parentPid = process.pid;
    for (let generation = 1; generation <= 3; generation += 1) {
      const child = spawnDirectFileTransferChild(
        pathToFileURL(path.join(process.cwd(), 'test/daemon/fixtures/direct-file-transfer-native-retire-child.mjs')),
        { workerData: { kind: DIRECT_FILE_TRANSFER_WORKER_KIND, generation } },
      );
      const [ready] = await once(child, 'message') as [{ type: string; pid: number }];
      expect(ready).toMatchObject({ type: 'fixture.native-peer-negotiated' });
      expect(ready.pid).not.toBe(parentPid);
      const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
      expect(code).toBeNull();
      expect(signal).toBe('SIGKILL');
      expect(process.pid).toBe(parentPid);
    }
  }, 45_000);

  it.runIf(process.platform !== 'win32')('reaps the production child after an orderly shutdown', async () => {
    const direct = await import('../../src/daemon/direct-file-transfer.js');
    direct.__resetDirectFileTransferForTests();
    await direct.initializeDirectFileTransfer();
    const pid = direct.__directFileTransferChildPidForTests();
    expect(pid).toBeTypeOf('number');
    await direct.shutdownDirectFileTransfers();
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
