import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_FILE_TRANSFER_WORKER_KIND } from '../../shared/direct-file-transfer.js';
import { spawnDirectFileTransferChild } from '../../src/daemon/direct-file-transfer-ipc.js';

async function waitForChildMessage(child: ReturnType<typeof spawnDirectFileTransferChild>): Promise<unknown> {
  return await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code, signal]) => {
      throw new Error(`direct transfer fixture exited before ready: code=${String(code)} signal=${String(signal)}`);
    }),
  ]);
}

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
    const ready = await waitForChildMessage(child) as { type: string; pid: number; phase: number };
    expect(ready).toMatchObject({ type: 'fixture.ready', phase: 0 });
    expect(ready.pid).not.toBe(parentPid);

    const armedMessage = waitForChildMessage(child);
    child.postMessage({});
    await expect(armedMessage).resolves.toMatchObject({
      type: 'fixture.ready',
      pid: ready.pid,
      phase: 1,
    });

    const exit = once(child, 'exit');
    child.postMessage({});
    const [code, signal] = await exit as [number | null, NodeJS.Signals | null];
    expect(code).toBeNull();
    expect(signal).toBe('SIGSEGV');
    expect(process.pid).toBe(parentPid);
  });

  it.runIf(process.platform === 'linux')('hard-bounds retired native peers while another negotiated transfer remains active', async () => {
    const parentPid = process.pid;
    const direct = await import('../../src/daemon/direct-file-transfer.js');
    const fixtureUrl = pathToFileURL(path.join(
      process.cwd(), 'test/daemon/fixtures/direct-file-transfer-native-retire-child.mjs',
    ));
    const evidence: Array<{
      type: string;
      pid: number;
      generation: number;
      retired: number;
      limit: number;
      fenced: boolean;
    }> = [];
    let rejectPrematureExit: (error: Error) => void = () => {};
    const prematureExit = new Promise<never>((_resolve, reject) => { rejectPrematureExit = reject; });
    direct.__resetDirectFileTransferForTests();
    direct.__setDirectFileTransferWorkerFactoryForTests((productionUrl, options) => {
      const child = spawnDirectFileTransferChild(
        options.workerData.generation <= 3 ? fixtureUrl : productionUrl,
        options,
      );
      child.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object'
          || (raw as { type?: unknown }).type !== 'fixture.native-retirement-budget') return;
        evidence.push(raw as typeof evidence[number]);
      });
      child.on('exit', (code, signal) => {
        if (evidence.some((entry) => entry.generation === options.workerData.generation)) return;
        rejectPrematureExit(new Error(`native_child_exited_before_retirement_budget:${code ?? signal ?? 'unknown'}`));
      });
      return child;
    });
    try {
      expect(await direct.initializeDirectFileTransfer()).toBe(true);
      await Promise.race([
        vi.waitFor(() => expect(evidence).toHaveLength(3), { timeout: 30_000, interval: 50 }),
        prematureExit,
      ]);
      await vi.waitFor(() => {
        expect(direct.__directFileTransferWorkerGenerationForTests()).toBe(4);
        expect(direct.isDirectFileTransferAvailable()).toBe(true);
      }, { timeout: 10_000, interval: 50 });
      expect(evidence).toEqual([1, 2, 3].map((generation) => expect.objectContaining({
        type: 'fixture.native-retirement-budget',
        generation,
        retired: 16,
        limit: 16,
        fenced: true,
      })));
      expect(evidence.every((entry) => entry.pid !== parentPid && entry.retired <= entry.limit)).toBe(true);
      expect(direct.__directFileTransferChildPidForTests()).not.toBe(parentPid);
      expect(process.pid).toBe(parentPid);
    } finally {
      await direct.shutdownDirectFileTransfers();
      direct.__setDirectFileTransferWorkerFactoryForTests(null);
      direct.__resetDirectFileTransferForTests();
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
