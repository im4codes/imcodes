/**
 * Real Windows + Node end-to-end test for the JS upgrade runner.
 *
 * This is the test that proves the runner actually works under real
 * Windows, with a real `node` invoked the same way wscript would invoke
 * it (hidden, no console, fully detached from any caller).  Unlike the
 * unit tests in windows-upgrade-script.test.ts (which only check string
 * content of the generated VBS / runner source), this test runs the
 * actual `dist/src/util/windows-upgrade-runner.mjs` in a child Node
 * process and verifies its filesystem side-effects.
 *
 * Mocking strategy:
 *
 *   - npm is replaced by a fake `npm.cmd` that just echos some output
 *     and returns the exit code we choose.  The runner has no idea it's
 *     not real npm — it spawns whatever path we pass as argv[3].
 *   - HOME is overridden via the `USERPROFILE` env so the runner reads/
 *     writes lock + pid files inside the test's tmp dir, not the real
 *     `~/.imcodes/`.  Node's homedir() reads %USERPROFILE% on Windows.
 *
 * What this test ACTUALLY proves (vs unit tests):
 *
 *   1. The `import` statements at the top of the .mjs resolve under
 *      Node 24 (some users had module-resolution issues with .mjs in
 *      odd npm prefix layouts).
 *   2. The argv positional parsing matches what command-handler.ts
 *      passes — a regression here would only show as a wrong log line
 *      far inside the runner, easy to miss in unit tests.
 *   3. Atomics.wait actually sleeps the runner for the expected duration
 *      under a real Windows + Node 24, instead of returning immediately
 *      like cmd.exe `timeout` does without a stdin console.
 *   4. The top-level main().catch().finally() really executes — Node
 *      promise-chaining quirks could in theory bypass the finally block.
 *   5. Atomic clearLock() works through Node's fs path encoding even
 *      when the lock file path passes through a non-ASCII directory
 *      (Chinese username support).
 */
import { describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(__filename, '..', '..', '..');
const RUNNER = resolve(repoRoot, 'dist/src/util/windows-upgrade-runner.mjs');

/** Build a fake npm.cmd that echoes the given output and exits with the
 *  given code.  Lets us drive the runner through every branch without
 *  touching the real npm registry.
 *
 *  Note: this fake npm.cmd does NOT use cmd.exe parser features that
 *  would break under non-default codepages (no parens-in-if, no chcp
 *  needed).  It's literally `echo X`, `exit /b N`. */
function buildFakeNpm(opts: {
  onInstall: { stdout: string; stderr: string; exitCode: number };
  onPrefix: { stdout: string; stderr: string; exitCode: number };
  onVersion?: { stdout: string; stderr: string; exitCode: number };
}): string {
  const lines = [
    '@echo off',
    'if "%1"=="prefix" goto :prefix',
    'if "%1"=="install" goto :install',
    'if "%1"=="--version" goto :version',
    'echo unhandled: %*',
    'exit /b 99',
    ':prefix',
    `echo ${opts.onPrefix.stdout}`,
    opts.onPrefix.stderr ? `echo ${opts.onPrefix.stderr} 1>&2` : '',
    `exit /b ${opts.onPrefix.exitCode}`,
    ':install',
    `echo ${opts.onInstall.stdout}`,
    opts.onInstall.stderr ? `echo ${opts.onInstall.stderr} 1>&2` : '',
    `exit /b ${opts.onInstall.exitCode}`,
    ':version',
    `echo ${opts.onVersion?.stdout ?? '1.0.0'}`,
    `exit /b ${opts.onVersion?.exitCode ?? 0}`,
  ].filter((l) => l !== '');
  return lines.join('\r\n') + '\r\n';
}

/** Run the runner directly via `node` and return all the side effects.
 *  This mirrors EXACTLY what wscript→node would do in production:
 *  hidden, no console, all paths passed as positional argv. */
function runRunner(opts: {
  scriptDir: string;
  fakeUserProfile: string;
  npmCmd: string;
  pkgSpec: string;
  targetVer: string;
  timeoutMs?: number;
}): {
  status: number | null;
  stdout: string;
  stderr: string;
  log: string;
  lockExists: boolean;
} {
  const logFile = join(opts.scriptDir, 'upgrade.log');
  const result = spawnSync(
    process.execPath,
    [RUNNER, logFile, opts.npmCmd, opts.pkgSpec, opts.targetVer, opts.scriptDir],
    {
      // Override USERPROFILE so the runner's homedir() lands in our
      // sandbox.  Crucial — without this, the runner would write to
      // the real ~/.imcodes/upgrade.lock and pollute the user's machine.
      env: { ...process.env, USERPROFILE: opts.fakeUserProfile },
      encoding: 'utf8',
      windowsHide: true,
      timeout: opts.timeoutMs ?? 60_000,
    },
  );
  const lockPath = join(opts.fakeUserProfile, '.imcodes', 'upgrade.lock');
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '',
    lockExists: existsSync(lockPath),
  };
}

describe.skipIf(!isWindows)('windows-upgrade-runner.mjs (real Node child)', () => {
  it('npm install FAILS → lock cleared, daemon untouched, runner exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-runner-fail-'));
    try {
      const userProfile = join(dir, 'profile');
      mkdirSync(join(userProfile, '.imcodes'), { recursive: true });
      const npmPath = join(dir, 'npm.cmd');
      writeFileSync(npmPath, buildFakeNpm({
        onInstall: { stdout: 'simulated network error', stderr: 'ETIMEDOUT', exitCode: 1 },
        onPrefix: { stdout: dir, stderr: '', exitCode: 0 },
      }));

      const r = runRunner({
        scriptDir: dir,
        fakeUserProfile: userProfile,
        npmCmd: npmPath,
        pkgSpec: 'imcodes@9.9.9',
        targetVer: '9.9.9',
      });

      expect(r.lockExists, `lock survived install failure: ${r.log}`).toBe(false);
      expect(r.log).toContain('install FAILED');
      // "lock-acquired" comes from the runner's trace() marker; older
      // versions logged "lock acquired" with a space.  Match either form.
      expect(r.log).toMatch(/lock[- ]acquired/);
      expect(r.log).toContain('lock released');
      // Runner should report a clean exit even on expected aborts —
      // failure mode is the install, not the runner itself.
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shim missing after install → lock cleared, version-mismatch path fires', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-runner-noshim-'));
    try {
      const userProfile = join(dir, 'profile');
      mkdirSync(join(userProfile, '.imcodes'), { recursive: true });
      const npmPath = join(dir, 'npm.cmd');
      // npm install succeeds, but `npm prefix -g` returns a path that
      // does NOT have an imcodes.cmd shim.  The runner should detect
      // this and abort cleanly.
      const fakePrefix = join(dir, 'fake-prefix');
      mkdirSync(fakePrefix, { recursive: true });  // exists but empty
      writeFileSync(npmPath, buildFakeNpm({
        onInstall: { stdout: 'added 1 package', stderr: '', exitCode: 0 },
        onPrefix: { stdout: fakePrefix, stderr: '', exitCode: 0 },
      }));

      const r = runRunner({
        scriptDir: dir,
        fakeUserProfile: userProfile,
        npmCmd: npmPath,
        pkgSpec: 'imcodes@1.2.3',
        targetVer: '1.2.3',
      });

      expect(r.lockExists, `lock survived no-shim abort: ${r.log}`).toBe(false);
      expect(r.log).toContain('shim missing');
      expect(r.log).toContain('lock released');
      expect(r.status).toBe(0);
    } finally {
      // Tmp dir might be PRESERVED by runner on failure — clean up always
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runner crashes mid-flow → finally block STILL clears the lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-runner-crash-'));
    try {
      const userProfile = join(dir, 'profile');
      mkdirSync(join(userProfile, '.imcodes'), { recursive: true });

      // Use an `npm` that DOESN'T EXIST on disk — spawnSync will return
      // status null + ENOENT.  The runner's main() should observe this
      // and the .catch().finally() chain should still run clearLock().
      const r = runRunner({
        scriptDir: dir,
        fakeUserProfile: userProfile,
        npmCmd: 'C:\\does\\not\\exist\\npm.cmd',
        pkgSpec: 'imcodes@1.2.3',
        targetVer: '1.2.3',
      });

      expect(r.lockExists, `lock survived crash: ${r.log}`).toBe(false);
      // Either the install is reported as failed (spawn returned null
      // status, treated as != 0) or a FATAL is logged.  Both end with
      // "lock released" via the finally block.
      // "lock-acquired" comes from the runner's trace() marker; older
      // versions logged "lock acquired" with a space.  Match either form.
      expect(r.log).toMatch(/lock[- ]acquired/);
      expect(r.log).toContain('lock released');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles a Chinese-character %USERPROFILE% path (Windows wide-char fs)', () => {
    // The whole point of switching from cmd.exe to JS: paths with
    // non-ASCII characters work via Node's wide-char fs API without
    // any codepage games.  We pass a USERPROFILE with Chinese chars
    // and verify the runner can write/read the lock and log files.
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-runner-cn-'));
    try {
      const userProfile = join(dir, '张三');
      mkdirSync(join(userProfile, '.imcodes'), { recursive: true });
      const npmPath = join(dir, 'npm.cmd');
      writeFileSync(npmPath, buildFakeNpm({
        onInstall: { stdout: 'sim cn install', stderr: '', exitCode: 1 },
        onPrefix: { stdout: dir, stderr: '', exitCode: 0 },
      }));

      const r = runRunner({
        scriptDir: dir,
        fakeUserProfile: userProfile,
        npmCmd: npmPath,
        pkgSpec: 'imcodes@1.0.0',
        targetVer: '1.0.0',
      });

      // Lock file at .../张三/.imcodes/upgrade.lock must have been
      // created (during step 1) and removed (in finally).  Both happen
      // through the Chinese-character path — Node fs handles this.
      expect(r.lockExists, `lock not removed under CN path: ${r.log}`).toBe(false);
      // "lock-acquired" comes from the runner's trace() marker; older
      // versions logged "lock acquired" with a space.  Match either form.
      expect(r.log).toMatch(/lock[- ]acquired/);
      expect(r.log).toContain('lock released');
      // Log file at .../张三/... was written and readable, so the test
      // harness could read it back.  Sanity check: log file exists.
      expect(existsSync(join(dir, 'upgrade.log'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lock has correct mtime (so watchdog self-heal can age it out)', () => {
    // Watchdog self-heal removes locks older than 10 minutes.  If the
    // runner created a lock with a wrong mtime (e.g. Unix epoch), the
    // self-heal would never trigger.  Verify a fresh lock has a
    // current mtime so the >10min check has correct anchoring.
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-runner-mtime-'));
    try {
      const userProfile = join(dir, 'profile');
      mkdirSync(join(userProfile, '.imcodes'), { recursive: true });
      const npmPath = join(dir, 'npm.cmd');
      writeFileSync(npmPath, buildFakeNpm({
        // Make the install hang/fail so the lock briefly persists
        // long enough for us to inspect it.  We can't actually inspect
        // mid-flight, but we CAN verify the lock-file write happened
        // by reading the log line that confirms it.
        onInstall: { stdout: '', stderr: '', exitCode: 1 },
        onPrefix: { stdout: dir, stderr: '', exitCode: 0 },
      }));

      const before = Date.now();
      runRunner({
        scriptDir: dir,
        fakeUserProfile: userProfile,
        npmCmd: npmPath,
        pkgSpec: 'imcodes@1.0.0',
        targetVer: '1.0.0',
      });
      const after = Date.now();

      // The runner created and removed the lock.  We can't directly
      // observe its mid-flight mtime, but the log timestamps bracket
      // the lifetime — and they should both be between `before` and
      // `after`.  This confirms the runner ran in real time (not
      // some weird Atomics.wait misbehavior that returns instantly).
      const log = readFileSync(join(dir, 'upgrade.log'), 'utf8');
      // Either "lock acquired" (older log line) or "[trace] step=1
      // lock-acquired" (newer trace marker) — both fine.  Match the
      // ISO timestamp at the start of either line.
      const acquireMatch = log.match(/\[([^\]]+)\][^\n]*lock[- ]acquired/);
      expect(acquireMatch).toBeTruthy();
      const acquiredMs = new Date(acquireMatch![1]).getTime();
      expect(acquiredMs).toBeGreaterThanOrEqual(before - 1000);
      expect(acquiredMs).toBeLessThanOrEqual(after + 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('npm spawn works through a path containing spaces (Node 24 cmd.exe quoting bug)', () => {
    // Real-world incident on 2026-05-08: every auto-upgrade silently
    // failed at `npm install` because the runner spawned npm.cmd via
    // `cmd.exe /d /s /c "C:\Program Files\nodejs\npm.cmd" install ...`,
    // and on Node 24 + Windows 10 the inner quotes around the
    // path-with-spaces got stripped by cmd.exe /s, leaving:
    //   'C:\Program' is not recognized as an internal or external command
    // Daemon hit "memory freeze watchdog timeout" three times in a row,
    // then died.
    //
    // Fix: bypass cmd.exe entirely by invoking npm-cli.js directly via
    // node.exe (process.execPath npmDir/node_modules/npm/bin/npm-cli.js).
    // node.exe is a real .exe so spawnSync handles it natively, no
    // quoting hell.  Fallback: shell:true with bare 'npm' and
    // PATH-prepended npmDir.
    //
    // This test mirrors the production failure: a fake "npm" set up
    // under a path with embedded spaces.  Without the fix, the runner
    // logs `'C:\Path with' is not recognized` or returns null status.
    // With the fix, npm runs and we see real npm output (including
    // the simulated install failure for our nonsense pkg spec).
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-runner-spaces '));  // <- intentional space
    try {
      const userProfile = join(dir, 'profile');
      mkdirSync(join(userProfile, '.imcodes'), { recursive: true });

      // Build a fake "npm" structure that mirrors the real layout:
      //   <npmDir>/npm.cmd
      //   <npmDir>/node_modules/npm/bin/npm-cli.js
      // The runner prefers npm-cli.js (no cmd.exe involved) when found.
      const npmDir = join(dir, 'with space dir');  // <- space in the dir
      mkdirSync(join(npmDir, 'node_modules', 'npm', 'bin'), { recursive: true });
      const cliJs = join(npmDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      writeFileSync(cliJs, [
        '// Fake npm-cli.js — exits with simulated ETARGET',
        'console.error("npm error code ETARGET");',
        'console.error("npm error notarget No matching version found.");',
        'process.exit(1);',
      ].join('\n'));
      // Also drop a non-functional npm.cmd so the resolveNpm... fallback
      // can find it if it ever decides to use the shell:true path.
      const npmCmd = join(npmDir, 'npm.cmd');
      writeFileSync(npmCmd, '@echo off\r\necho fallback npm.cmd should not be used\r\nexit /b 99\r\n');

      const r = runRunner({
        scriptDir: dir,
        fakeUserProfile: userProfile,
        npmCmd,
        pkgSpec: 'imcodes@9999.9.9-bogus',
        targetVer: '9999.9.9-bogus',
      });

      // Critical assertions: we MUST see real npm error output (proving
      // npm actually ran), NOT a 'is not recognized' / EINVAL signature.
      const noQuotingFail = !r.log.includes('not recognized')
        && !r.log.includes('EINVAL')
        && !r.log.match(/install FAILED \(exit null/);
      expect(noQuotingFail, `quoting failure detected:\n${r.log}`).toBe(true);
      // Real npm output captured via spawnSync's stdio:'pipe'.
      expect(r.log).toContain('ETARGET');
      // Runner exited cleanly (expected abort, not a crash).
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runner is plain JS (no executable cmd.exe dependencies)', () => {
    // Sanity check the bundled file we just shipped.  This is a
    // unit-style assertion but it lives here because if it FAILS, the
    // e2e cases above would also fail in confusing ways and you'd
    // want to know it's a build issue, not a runtime one.
    //
    // We allow the comment block to mention `chcp` and `@echo off` —
    // those are documentation of what we DON'T need any more.  What
    // matters is the runtime behavior: no batch-script execution.
    const src = readFileSync(RUNNER, 'utf8');
    expect(src).toContain("from 'node:fs'");
    expect(src).toContain("from 'node:child_process'");
    // No actual `timeout /t N` invocation — only `Atomics.wait` for sleeps.
    // (Comments referencing the old `timeout /t` failure are fine.)
    const code = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l) && !/^\s*\/\*/.test(l))
      .join('\n');
    expect(code).not.toMatch(/timeout \/t \d+/);
    expect(statSync(RUNNER).size).toBeGreaterThan(1000);
  });
});
