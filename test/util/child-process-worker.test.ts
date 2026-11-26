import { describe, expect, it } from 'vitest';
import { spawnChildProcessWorker } from '../../src/util/child-process-worker.js';

describe('spawnChildProcessWorker', () => {
  it('runs outside the daemon process and preserves typed arrays over IPC', async () => {
    const child = spawnChildProcessWorker(
      new URL('../fixtures/child-process-worker-echo.mjs', import.meta.url),
    );
    child.unref();
    try {
      const response = new Promise<{
        pid: number;
        message: { bytes: Uint8Array };
        typedArray: Float32Array;
      }>((resolve, reject) => {
        child.on('error', reject);
        child.on('message', resolve);
      });
      child.postMessage({ bytes: new Uint8Array([3, 5, 8]) });

      await expect(response).resolves.toMatchObject({
        pid: child.pid,
        message: { bytes: new Uint8Array([3, 5, 8]) },
        typedArray: new Float32Array([1.25, 2.5]),
      });
      expect(child.pid).not.toBe(process.pid);
    } finally {
      await child.terminate();
    }
  });
});
