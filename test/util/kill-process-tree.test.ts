/**
 * killProcessTree integration tests.
 *
 * We spawn a real bash shell that forks a grandchild, then assert that
 * killProcessTree reaps the grandchild as well. Without the tree-walk, a
 * single SIGTERM on the wrapper would leave the grandchild sleeping.
 *
 * Skipped on Windows — the Unix-specific `sleep`/`bash` and the `ps`
 * output format wouldn't apply, and those environments use taskkill /T /F
 * which is already a tree-kill at the OS level.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { collectDescendantPids, killProcessTree } from '../../src/util/kill-process-tree.js';

const isWin = process.platform === 'win32';
const describeOrSkip = isWin ? describe.skip : describe;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawn `bash -c 'sleep 60 & child=$!; echo $child; wait'` so we get:
 *  - bash wrapper (pid returned by spawn)
 *  - sleep grandchild (pid printed on stdout)
 *  This mirrors the codex npm wrapper → musl codex binary topology. */
async function spawnWrapperWithGrandchild(): Promise<{ wrapperPid: number; grandchildPid: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', 'sleep 60 & child=$!; echo $child; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (child.pid == null) { reject(new Error('spawn returned no pid')); return; }
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const m = stdout.match(/^(\d+)\s*$/m);
      if (m) {
        const grandchildPid = Number(m[1]);
        resolve({ wrapperPid: child.pid!, grandchildPid });
      }
    });
    child.once('error', reject);
    setTimeout(() => reject(new Error('timed out waiting for grandchild pid')), 5_000).unref?.();
  });
}

describeOrSkip('killProcessTree (POSIX)', () => {
  it('collectDescendantPids finds the grandchild of a wrapper', async () => {
    const { wrapperPid, grandchildPid } = await spawnWrapperWithGrandchild();
    try {
      // Short wait to let `ps` see the grandchild's ppid after bash forks it.
      await new Promise((r) => setTimeout(r, 200));
      const descendants = await collectDescendantPids(wrapperPid);
      expect(descendants).toContain(grandchildPid);
    } finally {
      await killProcessTree(wrapperPid, { gracefulMs: 100 });
    }
  });

  it('kills both wrapper and grandchild', async () => {
    const { wrapperPid, grandchildPid } = await spawnWrapperWithGrandchild();
    await new Promise((r) => setTimeout(r, 200));

    expect(pidAlive(wrapperPid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);

    await killProcessTree(wrapperPid, { gracefulMs: 200 });

    // Give the kernel a short window to reap — SIGKILL is immediate but the
    // PID lingers until the parent's exit syscall completes.
    await new Promise((r) => setTimeout(r, 300));

    expect(pidAlive(wrapperPid)).toBe(false);
    expect(pidAlive(grandchildPid)).toBe(false);
  });

  it('is a no-op on invalid pids', async () => {
    // Must not throw on undefined / negative / non-integer input.
    await expect(killProcessTree(undefined)).resolves.toBeUndefined();
    await expect(killProcessTree(-1)).resolves.toBeUndefined();
    await expect(killProcessTree(0)).resolves.toBeUndefined();
    await expect(killProcessTree(Number.NaN as unknown as number)).resolves.toBeUndefined();
  });

  it('is idempotent when the pid is already dead', async () => {
    const { wrapperPid } = await spawnWrapperWithGrandchild();
    await killProcessTree(wrapperPid, { gracefulMs: 100 });
    await new Promise((r) => setTimeout(r, 200));
    expect(pidAlive(wrapperPid)).toBe(false);
    // Second call must not throw.
    await expect(killProcessTree(wrapperPid, { gracefulMs: 50 })).resolves.toBeUndefined();
  });
});
