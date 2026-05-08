/**
 * End-to-end proof that the watchdog actually removes a stuck upgrade.lock
 * under real cmd.exe parsing — not just string-pattern matching.
 *
 * This is the test that answers "how do you know it works on Windows?".
 *
 * What it does:
 *   1. Generates the watchdog.cmd via writeWatchdogCmd (the production code).
 *   2. Modifies the cmd to:
 *      - Replace `goto loop` (the post-daemon-exit retry) with `exit /b 0`
 *        so we don't actually try to launch the daemon.
 *      - Replace the wait_loop ping with a SHORT ping so the test runs in
 *        ~5s instead of waiting 30s per iteration.
 *      - Replace the 10-minute mtime threshold with 5 SECONDS so we don't
 *        have to fake a 10-min-old file.
 *   3. Creates a real upgrade.lock with mtime 30s in the past (= stale by
 *      the test's 5s threshold).
 *   4. Runs the watchdog.cmd via cmd.exe /c (as the watchdog would be
 *      invoked) and lets it iterate the wait_loop.
 *   5. Asserts the lock file is gone within 30 seconds AND that the
 *      watchdog log records the self-heal message.
 *
 * Skipped on non-Windows.  Run via:
 *   npx vitest run test/util/windows-watchdog-self-heal.e2e.ts
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';
const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(__filename, '..', '..', '..');

describe.skipIf(!isWindows)('watchdog self-heals a real stuck upgrade.lock under cmd.exe', () => {
  it('removes a >5s-old lock and logs the self-heal message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-selfheal-e2e-'));
    try {
      // ── Step 1: generate the production watchdog.cmd ─────────────────
      const watchdogPath = join(dir, 'daemon-watchdog.cmd');
      const stubScriptPath = join(dir, 'fake', 'index.js');
      const moduleUrl = pathToFileURL(
        join(repoRoot, 'dist/src/util/windows-launch-artifacts.js'),
      ).href;

      writeFileSync(
        join(dir, 'driver.mjs'),
        `import { writeWatchdogCmd } from ${JSON.stringify(moduleUrl)};
import { mkdirSync, writeFileSync } from 'fs';
mkdirSync(${JSON.stringify(join(dir, 'fake'))}, { recursive: true });
writeFileSync(${JSON.stringify(stubScriptPath)}, '// stub');
await writeWatchdogCmd({
  nodeExe: process.execPath,
  imcodesScript: ${JSON.stringify(stubScriptPath)},
  watchdogPath: ${JSON.stringify(watchdogPath)},
  vbsPath: ${JSON.stringify(join(dir, 'launcher.vbs'))},
  logPath: ${JSON.stringify(join(dir, 'watchdog.log'))},
});
`,
      );
      const gen = spawnSync(process.execPath, [join(dir, 'driver.mjs')], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (gen.status !== 0) {
        throw new Error(`watchdog generation failed: ${gen.stderr}`);
      }

      // ── Step 2: rewrite the watchdog so the test:
      //   - Uses our test directory's lock + log instead of %USERPROFILE%
      //   - Has a 5-SECOND stale threshold (not 10 minutes) so we don't
      //     have to wait 10 minutes
      //   - Polls every 2 seconds (not 30) so the test runs fast
      //   - Exits after one self-heal (no daemon launch, no infinite loop)
      const original = readFileSync(watchdogPath, 'utf8');
      const lockPath = join(dir, 'upgrade.lock');
      const logPath = join(dir, 'watchdog.log');
      // Use forward slashes converted to backslashes for cmd.exe
      const lockCmd = lockPath.replace(/\//g, '\\');
      const logCmd = logPath.replace(/\//g, '\\');

      const safe = original
        // Redirect lock + log to our test paths everywhere they appear
        .replace(/%USERPROFILE%\\\.imcodes\\upgrade\.lock/g, lockCmd)
        .replace(/%USERPROFILE%\\\.imcodes\\watchdog\.log/g, logCmd)
        // Replace the daemon-launch line so we don't actually try to run
        // imcodes start --foreground (would fail and spam errors)
        .replace(/^call .*$/m, 'echo WATCHDOG_LAUNCH_LINE_HIT')
        // Cut the post-daemon retry tail so the script terminates after
        // the lock_cleared / self-heal block — turn the post-daemon
        // `ping ... \n goto loop` into `exit /b 0`
        .replace(
          /ping -n 6 127\.0\.0\.1 >nul 2>&1\r?\ngoto loop/,
          'exit /b 0',
        )
        // Shrink the wait_loop sleep from 30s to 2s for faster iteration
        .replace(
          /ping -n 31 127\.0\.0\.1 >nul 2>&1/,
          'ping -n 3 127.0.0.1 >nul 2>&1',
        )
        // Lower the stale threshold from 10 minutes to 5 SECONDS so we
        // don't have to fake a >10min mtime in the test fixture
        .replace(/AddMinutes\(-10\)/, 'AddSeconds(-5)');

      const safePath = join(dir, 'safe-watchdog.cmd');
      writeFileSync(safePath, safe);

      // ── Step 3: place a stale upgrade.lock (mtime 30s ago) ────────────
      writeFileSync(lockPath, 'upgrade');
      const thirtySecAgo = (Date.now() - 30_000) / 1000;
      utimesSync(lockPath, thirtySecAgo, thirtySecAgo);
      expect(existsSync(lockPath)).toBe(true);

      // ── Step 4: run the watchdog ──────────────────────────────────────
      // Use cmd.exe /c — same parser the production wscript-spawned
      // watchdog uses.  The script should:
      //   - Hit the if-exist-lock check, goto wait_lock
      //   - Log "Upgrade in progress..."
      //   - Sleep 2s (our shrunk wait)
      //   - Run the PS probe — finds lock is >5s old, removes it
      //   - Detects lock is gone, falls into self-heal block
      //   - Logs "Upgrade lock was stale" and goto loop
      //   - Hits the no-lock branch → echo WATCHDOG_LAUNCH_LINE_HIT
      //   - exit /b 0
      const result = spawnSync('cmd.exe', ['/c', safePath], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      });

      // ── Step 5: assertions ────────────────────────────────────────────
      const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      const combined = `stdout=${result.stdout ?? ''}\nstderr=${result.stderr ?? ''}\nlog=${log}`;

      expect(result.status, `cmd terminated abnormally: ${combined}`).toBe(0);
      expect(existsSync(lockPath), `lock still exists after self-heal: ${combined}`).toBe(false);
      expect(log).toMatch(/Upgrade in progress, waiting for lock to clear/);
      expect(log).toMatch(/Upgrade lock was stale.*removed by watchdog self-heal/);
      // The post-self-heal `goto loop` should have hit the no-lock branch
      // and reached the marker echo.
      expect(combined).toContain('WATCHDOG_LAUNCH_LINE_HIT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('LEAVES a fresh (<threshold) lock alone — does not race a live upgrade', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-selfheal-fresh-'));
    try {
      const watchdogPath = join(dir, 'daemon-watchdog.cmd');
      const stubScriptPath = join(dir, 'fake', 'index.js');
      const moduleUrl = pathToFileURL(
        join(repoRoot, 'dist/src/util/windows-launch-artifacts.js'),
      ).href;
      writeFileSync(
        join(dir, 'driver.mjs'),
        `import { writeWatchdogCmd } from ${JSON.stringify(moduleUrl)};
import { mkdirSync, writeFileSync } from 'fs';
mkdirSync(${JSON.stringify(join(dir, 'fake'))}, { recursive: true });
writeFileSync(${JSON.stringify(stubScriptPath)}, '// stub');
await writeWatchdogCmd({
  nodeExe: process.execPath,
  imcodesScript: ${JSON.stringify(stubScriptPath)},
  watchdogPath: ${JSON.stringify(watchdogPath)},
  vbsPath: ${JSON.stringify(join(dir, 'launcher.vbs'))},
  logPath: ${JSON.stringify(join(dir, 'watchdog.log'))},
});
`,
      );
      const gen = spawnSync(process.execPath, [join(dir, 'driver.mjs')], {
        encoding: 'utf8', windowsHide: true,
      });
      if (gen.status !== 0) throw new Error(`gen failed: ${gen.stderr}`);

      const original = readFileSync(watchdogPath, 'utf8');
      const lockPath = join(dir, 'upgrade.lock');
      const logPath = join(dir, 'watchdog.log');
      const lockCmd = lockPath.replace(/\//g, '\\');
      const logCmd = logPath.replace(/\//g, '\\');

      // Same shrink as above EXCEPT we add an unconditional `exit /b 0`
      // after exactly ONE wait_loop iteration so the test terminates.
      // We do this by replacing `if exist UPGRADE_LOCK goto wait_loop`
      // with `exit /b 0` so after one iteration the script exits regardless
      // of whether the lock was removed or not.
      const safe = original
        .replace(/%USERPROFILE%\\\.imcodes\\upgrade\.lock/g, lockCmd)
        .replace(/%USERPROFILE%\\\.imcodes\\watchdog\.log/g, logCmd)
        .replace(/^call .*$/m, 'echo WATCHDOG_LAUNCH_LINE_HIT')
        .replace(/ping -n 6 127\.0\.0\.1 >nul 2>&1\r?\ngoto loop/, 'exit /b 0')
        .replace(/ping -n 31 127\.0\.0\.1 >nul 2>&1/, 'ping -n 3 127.0.0.1 >nul 2>&1')
        // Use 5-sec threshold same as test 1
        .replace(/AddMinutes\(-10\)/, 'AddSeconds(-5)')
        // Force termination after one wait_loop iteration so the test
        // doesn't spin forever waiting for a fresh lock to age out.
        .replace(
          /if exist "[^"]*upgrade\.lock" goto wait_loop/m,
          'exit /b 99',
        );

      const safePath = join(dir, 'safe-watchdog.cmd');
      writeFileSync(safePath, safe);

      // FRESH lock: mtime = now (well within the 5-sec threshold)
      writeFileSync(lockPath, 'upgrade');
      // Don't backdate — let the file have current mtime.
      expect(existsSync(lockPath)).toBe(true);

      const result = spawnSync('cmd.exe', ['/c', safePath], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000,
      });

      // Exit 99 means the wait_loop ran once (PS probe didn't remove the
      // lock because it was fresh) and then hit our forced exit.
      const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      const combined = `status=${result.status} stdout=${result.stdout ?? ''}\nstderr=${result.stderr ?? ''}\nlog=${log}`;

      expect(result.status, `expected exit 99 (= one wait_loop iter then bail): ${combined}`).toBe(99);
      // Lock must STILL exist because PS probe should not have removed it
      expect(existsSync(lockPath), `PS probe wrongly removed a fresh lock: ${combined}`).toBe(true);
      // No self-heal log line (would indicate false positive)
      expect(log).not.toMatch(/Upgrade lock was stale.*removed by watchdog self-heal/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
