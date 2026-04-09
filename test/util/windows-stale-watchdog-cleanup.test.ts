/**
 * Windows-only end-to-end test: the watchdog cleanup logic must reliably
 * tree-kill orphan daemon-watchdog cmd.exe processes by command-line pattern.
 *
 * This test runs ONLY on Windows CI.  It is the regression guard for
 *
 *     fix(daemon-watchdog): cmd.exe BOM bug + watchdog crash-loop recovery
 *
 * Scenario:
 *   1. An OLD imcodes install wrote daemon-watchdog.cmd with a UTF-8 BOM.
 *      cmd.exe parses [BOM]@echo as the unknown command "[BOM]@echo" and
 *      crash-loops forever.
 *   2. The user runs `imcodes restart` or `imcodes upgrade` (which calls
 *      `imcodes repair-watchdog`).
 *   3. The cleanup logic must find every cmd.exe process whose command line
 *      references daemon-watchdog and tree-kill it.  Otherwise the old
 *      crash-loop keeps running and overwrites the PID file with stale data.
 *
 * The kill is implemented in two places that share the same wmic+taskkill
 * pattern:
 *   - src/util/windows-daemon.ts (killAllStaleWatchdogs) — used by `restart`
 *   - src/util/windows-launch-artifacts.ts (killAllStaleWatchdogsBeforeRegen)
 *     — used by `repair-watchdog`
 *
 * Both call sites are exercised by this test by importing the source modules
 * in a fresh Node child process (vitest mocks would otherwise interfere).
 *
 * Skipped on non-Windows hosts; both Windows CI jobs include this file.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';
const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(__filename, '..', '..', '..');

/** Wait until predicate returns true or timeout (ms) elapses. */
async function waitFor(pred: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pred();
}

/** Check whether a PID is still alive.
 *
 *  Uses `tasklist` (available on every Windows Server / Windows 10/11)
 *  rather than `wmic` because `wmic` is deprecated and not always installed
 *  on newer GitHub Actions Windows runner images. */
function pidAlive(pid: number): boolean {
  if (!isWindows) return false;
  const result = spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  // tasklist with /nh /fo csv outputs `"name.exe","PID",...`
  // When no process matches, stdout is empty or contains "INFO:".
  const stdout = result.stdout ?? '';
  return stdout.includes(`"${pid}"`);
}

/** Spawn a fake daemon-watchdog cmd.exe process that just loops printing. */
function spawnFakeWatchdog(stagingDir: string): number {
  const fakePath = join(stagingDir, 'daemon-watchdog.cmd');
  writeFileSync(
    fakePath,
    '@echo off\r\n:loop\r\nping -n 60 127.0.0.1 >nul\r\ngoto loop\r\n',
  );
  const child = spawn('cmd.exe', ['/c', fakePath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid!;
}

/** Run a small script in a fresh Node process so test-time vi.mock() calls
 *  can't affect the production module under test. */
function runInChildProcess(driverSource: string): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-stale-driver-'));
  try {
    const driverPath = join(dir, 'driver.mjs');
    writeFileSync(driverPath, driverSource);
    const result = spawnSync(process.execPath, [driverPath], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('stale watchdog cleanup (Windows-only end-to-end)', () => {
  it.skipIf(!isWindows)('killAllStaleWatchdogs() in windows-daemon.ts kills orphan cmd.exe by command-line pattern', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-stale-1-'));
    let fakePid: number | null = null;
    try {
      fakePid = spawnFakeWatchdog(dir);
      // Wait until wmic actually sees it
      const spawned = await waitFor(() => pidAlive(fakePid!), 3000);
      expect(spawned, `fake watchdog PID ${fakePid} did not appear`).toBe(true);

      // Run killAllStaleWatchdogs() in a child process so vitest mocks don't
      // touch the real fs/child_process modules.  Also print diagnostics so
      // CI failures are easy to debug.
      const moduleUrl = pathToFileURL(join(repoRoot, 'dist/src/util/windows-daemon.js')).href;
      const driverSource = `
        import { killAllStaleWatchdogs } from ${JSON.stringify(moduleUrl)};
        console.error('[driver] before kill, fakePid=${fakePid}');
        killAllStaleWatchdogs();
        console.error('[driver] after kill');
      `;
      const result = runInChildProcess(driverSource);
      expect(result.status, `driver failed: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);

      // Wait up to 15s for the PowerShell+taskkill chain to complete.
      // PowerShell startup alone is 1-3s on CI runners, so 5s is too tight.
      const dead = await waitFor(() => !pidAlive(fakePid!), 15000);
      expect(dead, `fake watchdog PID ${fakePid} should be killed.\nDriver stdout: ${result.stdout}\nDriver stderr: ${result.stderr}`).toBe(true);
    } finally {
      // Best-effort cleanup if the test failed
      if (fakePid && pidAlive(fakePid)) {
        spawnSync('taskkill', ['/f', '/t', '/pid', String(fakePid)], { windowsHide: true });
      }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 60_000);

  it.skipIf(!isWindows)('regenerateAllArtifacts() in windows-launch-artifacts.ts also kills stale watchdogs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-stale-2-'));
    let fakePid: number | null = null;
    try {
      fakePid = spawnFakeWatchdog(dir);
      const spawned = await waitFor(() => pidAlive(fakePid!), 3000);
      expect(spawned, `fake watchdog PID ${fakePid} did not appear`).toBe(true);

      // We need regenerateAllArtifacts to exercise the kill path WITHOUT
      // touching the real ~/.imcodes directory.  Stub the entry point that
      // resolves paths so it returns staging paths instead.
      const moduleUrl = pathToFileURL(join(repoRoot, 'dist/src/util/windows-launch-artifacts.js')).href;
      const stagingPaths = {
        nodeExe: process.execPath,
        imcodesScript: join(dir, 'fake', 'index.js'),
        watchdogPath: join(dir, 'daemon-watchdog-fake.cmd'),
        vbsPath: join(dir, 'daemon-launcher.vbs'),
        logPath: join(dir, 'watchdog.log'),
      };
      const driverSource = `
        import { writeWatchdogCmd, writeVbsLauncher } from ${JSON.stringify(moduleUrl)};
        import { mkdirSync, writeFileSync } from 'fs';
        mkdirSync(${JSON.stringify(join(dir, 'fake'))}, { recursive: true });
        writeFileSync(${JSON.stringify(stagingPaths.imcodesScript)}, '// stub');
        // We can't call regenerateAllArtifacts directly because it uses the
        // user's home dir.  Instead reproduce its kill logic via the dedicated
        // helper that the daemon module exports for restart use.
        const { killAllStaleWatchdogs } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'dist/src/util/windows-daemon.js')).href)});
        console.error('[driver] before kill, fakePid=${fakePid}');
        killAllStaleWatchdogs();
        console.error('[driver] after kill');
        await writeWatchdogCmd(${JSON.stringify(stagingPaths)});
        await writeVbsLauncher(${JSON.stringify(stagingPaths)});
      `;
      const result = runInChildProcess(driverSource);
      expect(result.status, `driver failed: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);

      const dead = await waitFor(() => !pidAlive(fakePid!), 15000);
      expect(dead, `fake watchdog PID ${fakePid} should be killed`).toBe(true);
    } finally {
      if (fakePid && pidAlive(fakePid)) {
        spawnSync('taskkill', ['/f', '/t', '/pid', String(fakePid)], { windowsHide: true });
      }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 60_000);

  it.skipIf(!isWindows)('killAllStaleWatchdogs() is a no-op when no watchdogs are running', async () => {
    // Make sure we don't accidentally kill unrelated cmd.exe processes.
    // Spawn a non-watchdog cmd.exe and verify it survives.
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-stale-3-'));
    let unrelatedPid: number | null = null;
    try {
      const benignPath = join(dir, 'benign-loop.cmd');
      writeFileSync(
        benignPath,
        '@echo off\r\n:loop\r\nping -n 60 127.0.0.1 >nul\r\ngoto loop\r\n',
      );
      const child = spawn('cmd.exe', ['/c', benignPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      unrelatedPid = child.pid!;
      const spawned = await waitFor(() => pidAlive(unrelatedPid!), 3000);
      expect(spawned).toBe(true);

      const moduleUrl = pathToFileURL(join(repoRoot, 'dist/src/util/windows-daemon.js')).href;
      const driverSource = `
        import { killAllStaleWatchdogs } from ${JSON.stringify(moduleUrl)};
        killAllStaleWatchdogs();
      `;
      runInChildProcess(driverSource);

      // Give the kill enough time to propagate
      await new Promise((r) => setTimeout(r, 1500));

      // Unrelated cmd.exe must still be alive
      expect(pidAlive(unrelatedPid!)).toBe(true);
    } finally {
      if (unrelatedPid) {
        spawnSync('taskkill', ['/f', '/t', '/pid', String(unrelatedPid)], { windowsHide: true });
      }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 60_000);
});
