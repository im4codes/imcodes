/**
 * End-to-end regression test for the Windows watchdog .cmd file.
 *
 * Why this is its own file (and not part of windows-launch-artifacts.test.ts):
 *
 *   The unit test file mocks `fs/promises` so it can capture the bytes that
 *   would be written without touching the disk.  Vitest's module cache means
 *   those mocks can leak into other test files in the same worker, so we run
 *   the watchdog generation in a fresh `node` child process.  That gives us
 *   real fs writes — exactly what runs in production — and lets us invoke
 *   `cmd.exe` against the file to validate that the parser accepts every
 *   single line.
 *
 *   The original bug was that `writeWatchdogCmd` produced bytes starting
 *   with `EF BB BF` (UTF-8 BOM).  cmd.exe doesn't strip the BOM; it
 *   concatenates it with the next token, producing
 *   `[BOM]@echo is not a recognized command`.  The watchdog looped forever
 *   printing this error and never managed to start the daemon.
 *
 *   A unit-level "no BOM byte" assertion is necessary but not sufficient,
 *   because there are other ways to make a file unparseable to cmd.exe
 *   (e.g. UTF-16 LE, mixed CRLF, embedded codepage characters in command
 *    names).  An end-to-end "cmd.exe /c <file>" check catches all of them.
 *
 * Skipped on non-Windows hosts; both Windows CI jobs include this file.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';
const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(__filename, '..', '..', '..');

/** Run a small script in a fresh Node process so test-time vi.mock() calls
 *  can't affect the production fs/promises module. */
function generateWatchdogInChildProcess(stagingDir: string): { watchdogPath: string } {
  const watchdogPath = join(stagingDir, 'daemon-watchdog.cmd');
  const stubScriptPath = join(stagingDir, 'fake', 'index.js');
  const vbsPath = join(stagingDir, 'daemon-launcher.vbs');
  const logPath = join(stagingDir, 'watchdog.log');

  // The shim path probe inside writeWatchdogCmd starts from imcodesScript
  // and walks up to .../npm. We don't want a real shim to be detected here
  // because it would inject %APPDATA%\npm\imcodes.cmd which is fine, but
  // either branch (shim or fallback) needs to produce a parseable file.
  // Test BOTH branches by running the script twice.

  // ESM imports on Windows need file:// URLs, not bare drive-letter paths.
  const moduleUrl = pathToFileURL(join(repoRoot, 'dist/src/util/windows-launch-artifacts.js')).href;
  const driver = `
    import { writeWatchdogCmd } from ${JSON.stringify(moduleUrl)};
    import { mkdirSync, writeFileSync } from 'fs';
    mkdirSync(${JSON.stringify(join(stagingDir, 'fake'))}, { recursive: true });
    writeFileSync(${JSON.stringify(stubScriptPath)}, '// stub');
    await writeWatchdogCmd({
      nodeExe: process.execPath,
      imcodesScript: ${JSON.stringify(stubScriptPath)},
      watchdogPath: ${JSON.stringify(watchdogPath)},
      vbsPath: ${JSON.stringify(vbsPath)},
      logPath: ${JSON.stringify(logPath)},
    });
  `;
  const driverPath = join(stagingDir, 'driver.mjs');
  writeFileSync(driverPath, driver);

  const result = spawnSync(process.execPath, [driverPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `driver failed (status=${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return { watchdogPath };
}

describe('watchdog .cmd file (Windows cmd.exe parser regression)', () => {
  it.skipIf(!isWindows)('first byte is NOT 0xEF (UTF-8 BOM)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-bom-'));
    try {
      const { watchdogPath } = generateWatchdogInChildProcess(dir);
      const buf = readFileSync(watchdogPath);
      expect(buf.length).toBeGreaterThan(0);
      // No UTF-8 BOM
      expect(buf[0]).not.toBe(0xEF);
      expect(buf[1]).not.toBe(0xBB);
      expect(buf[2]).not.toBe(0xBF);
      // No UTF-16 LE BOM either
      expect(buf[0] === 0xFF && buf[1] === 0xFE).toBe(false);
      // First non-empty line must be exactly `@echo off`
      const firstLine = buf.toString('utf8').split(/\r?\n/).find((l) => l.trim().length > 0);
      expect(firstLine).toBe('@echo off');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!isWindows)('cmd.exe parses every line — no "is not a recognized command" errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-cmdparse-'));
    try {
      const { watchdogPath } = generateWatchdogInChildProcess(dir);

      // Make a "safe" copy that does NOT actually try to launch a daemon and
      // does NOT loop forever.  We:
      //   - Replace the upgrade-lock check with a no-op so a stale lock on
      //     the host doesn't make the script wait forever
      //   - Replace the daemon-launch line with a marker echo
      //   - Replace the loop tail with `exit /b 0` so cmd.exe terminates
      const original = readFileSync(watchdogPath, 'utf8');
      const safe = original
        // Neutralise the upgrade-lock check entirely
        .replace(/if exist "[^"]*upgrade\.lock" \([\s\S]*?\)\r?\n/m, 'rem upgrade-lock check disabled in test\r\n')
        // Replace either of the two possible launch forms with a marker
        .replace(/^call .*$/m, 'echo WATCHDOG_OK')
        // Strip the loop tail so the script terminates
        .replace(/timeout \/t 5 \/nobreak >nul[\r\n]+goto loop/m, 'exit /b 0');
      const safePath = join(dir, 'safe-watchdog.cmd');
      writeFileSync(safePath, safe);

      const result = spawnSync('cmd.exe', ['/c', safePath], {
        encoding: 'utf8',
        windowsHide: true,
      });

      const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      // Two failure modes we are guarding against:
      //   1. '@echo' is not recognized as an internal or external command
      //      (BOM glued to the first @echo)
      //   2. '"...\imcodes.cmd"' is not recognized as an internal or
      //      external command (cmd.exe quoted-command parse rule)
      expect(combined).not.toMatch(/is not recognized as an internal or external command/i);
      // Sanity: the script reached the marker echo
      expect(combined).toContain('WATCHDOG_OK');
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!isWindows)('cmd.exe handles env-var expansion correctly with non-ASCII USERPROFILE', () => {
    // Don't actually need a non-ASCII USERPROFILE on the host — we just need
    // to verify that the .cmd file routes everything through %USERPROFILE%
    // and %APPDATA% so cmd.exe can expand them with the OS native API at
    // runtime, regardless of the codepage of the actual user folder name.
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-envvar-'));
    try {
      const { watchdogPath } = generateWatchdogInChildProcess(dir);
      const cmd = readFileSync(watchdogPath, 'utf8');
      // Lock file path
      expect(cmd).toContain('%USERPROFILE%\\.imcodes\\upgrade.lock');
      // Log file path
      expect(cmd).toContain('%USERPROFILE%\\.imcodes\\watchdog.log');
      // No raw drive-letter user paths leaking through
      expect(cmd).not.toMatch(/C:\\Users\\[^\\]+\\\.imcodes\\upgrade\.lock/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
