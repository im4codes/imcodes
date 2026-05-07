import { describe, expect, it } from 'vitest';
import { buildWindowsCleanupScript, buildWindowsCleanupVbs, buildWindowsUpgradeBatch, buildWindowsUpgradeVbs } from '../../src/util/windows-upgrade-script.js';

const INPUT = {
  logFile: 'C:\\Temp\\upgrade.log',
  scriptDir: 'C:\\Temp\\imcodes-upgrade-123',
  cleanupPath: 'C:\\Temp\\imcodes-upgrade-123\\cleanup.cmd',
  cleanupVbsPath: 'C:\\Temp\\imcodes-upgrade-123\\cleanup.vbs',
  npmCmd: 'C:\\Program Files\\nodejs\\npm.cmd',
  pkgSpec: 'imcodes@1.2.3',
  targetVer: '1.2.3',
  vbsLauncherPath: 'C:\\Users\\tester\\.imcodes\\daemon-launcher.vbs',
  upgradeLockFile: 'C:\\Users\\tester\\.imcodes\\upgrade.lock',
} as const;

describe('buildWindowsCleanupScript', () => {
  it('generates a standalone cleanup cmd script', () => {
    const script = buildWindowsCleanupScript('C:\\Temp\\imcodes-upgrade-123');
    expect(script).toContain('@echo off');
    expect(script).toContain('chcp 65001 >nul 2>&1');
    // ping-based sleep — `timeout` fails under wscript-spawned cmd
    // because there's no console for stdin.  See the regression test
    // below for the full story.
    expect(script).toContain('ping -n 121 127.0.0.1 >nul 2>&1');
    expect(script).toContain('for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI"');
    expect(script).toContain('rmdir /s /q "%SCRIPT_DIR%"');
  });

  it('NEVER uses `timeout /t` (regression: fails when launched via wscript)', () => {
    // `timeout /t N /nobreak` requires a real console for stdin.  When
    // run under a wscript-spawned cmd there is no console, so timeout
    // aborts with exit code 1 immediately and the cleanup runs without
    // its 120 s grace period — deleting the temp dir while diagnostic
    // logs are still being written there.
    const script = buildWindowsCleanupScript('C:\\Temp\\imcodes-upgrade-123');
    expect(script).not.toMatch(/timeout \/t \d+/);
  });
});

describe('buildWindowsCleanupVbs', () => {
  it('generates a VBS that runs cleanup hidden (window style 0)', () => {
    const vbs = buildWindowsCleanupVbs('C:\\Temp\\cleanup.cmd');
    expect(vbs).toContain('CreateObject("WScript.Shell")');
    expect(vbs).toContain('"C:\\Temp\\cleanup.cmd"');
    expect(vbs).toContain(', 0, False');
  });

  it('uses On Error Resume Next so wscript never pops up an error dialog', () => {
    const vbs = buildWindowsCleanupVbs('C:\\Temp\\cleanup.cmd');
    expect(vbs).toContain('On Error Resume Next');
  });

  it('handles non-ASCII paths in the cleanup target', () => {
    const vbs = buildWindowsCleanupVbs('C:\\Users\\测试用户A\\Temp\\cleanup.cmd');
    expect(vbs).toContain('测试用户A');
  });
});

describe('buildWindowsUpgradeVbs', () => {
  it('runs upgrade.cmd hidden with error suppression', () => {
    const vbs = buildWindowsUpgradeVbs('C:\\Temp\\upgrade.cmd');
    expect(vbs).toContain('CreateObject("WScript.Shell")');
    expect(vbs).toContain('"C:\\Temp\\upgrade.cmd"');
    expect(vbs).toContain(', 0, False');
    expect(vbs).toContain('On Error Resume Next');
  });
});

describe('buildWindowsUpgradeBatch', () => {
  const batch = buildWindowsUpgradeBatch(INPUT);

  // ── Lock file lifecycle ──

  it('creates upgrade lock BEFORE npm install', () => {
    const lockIdx = batch.indexOf('echo upgrade > "%UPGRADE_LOCK%"');
    const installIdx = batch.indexOf(`call "${INPUT.npmCmd}" install`);
    expect(lockIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(installIdx);
  });

  it('switches cmd.exe to UTF-8 before touching path variables', () => {
    expect(batch).toContain('chcp 65001 >nul 2>&1');
    expect(batch).toContain('set "LOG_FILE=%SCRIPT_DIR%\\upgrade.log"');
    expect(batch).toContain('set "CLEANUP_VBS=%SCRIPT_DIR%\\cleanup.vbs"');
    expect(batch).toContain('set "VBS_LAUNCHER=%USERPROFILE%\\.imcodes\\daemon-launcher.vbs"');
    expect(batch).toContain('set "UPGRADE_LOCK=%USERPROFILE%\\.imcodes\\upgrade.lock"');
  });

  it('every abort path deletes lock AND restarts VBS', () => {
    // Split on `goto :done` — each abort block must have both del lock + wscript
    const blocks = batch.split('goto :done');
    // Last block is after :done label — skip it
    const abortBlocks = blocks.slice(0, -1);
    // At least 4 abort paths: install fail, no prefix, no shim, version mismatch
    expect(abortBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of abortBlocks) {
      expect(block).toContain('del "%UPGRADE_LOCK%"');
      expect(block).toContain('wscript');
    }
  });

  it('success path: starts new watchdog via VBS then removes lock', () => {
    const repairIdx = batch.indexOf('call "%CLI_SHIM%" repair-watchdog');
    const afterRepair = batch.slice(repairIdx);
    const vbsIdx = afterRepair.indexOf('Starting new watchdog via VBS');
    const delIdx = afterRepair.indexOf('Removing upgrade lock');
    expect(vbsIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeGreaterThan(-1);
    // VBS start must come BEFORE lock removal — watchdog waits on lock
    expect(vbsIdx).toBeLessThan(delIdx);
  });

  // ── Daemon lifecycle: old daemon MUST survive install failure ──────────

  it('captures the OLD daemon PID before npm install (to kill later, not now)', () => {
    // Regression guard: earlier versions of the upgrade script killed the
    // old daemon BEFORE npm install.  If npm install then crashed (or was
    // killed mid-run), the system was left with no daemon and no installable
    // binary.  The new flow captures OLD_DAEMON_PID and kills it only AFTER
    // install succeeds.
    const capIdx = batch.indexOf('set /p OLD_DAEMON_PID=<"%PIDFILE%"');
    const installIdx = batch.indexOf(`call "${INPUT.npmCmd}" install`);
    expect(capIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeLessThan(installIdx);
  });

  it('runs npm install BEFORE killing the old daemon or stale watchdogs', () => {
    // CRITICAL: npm install must happen while the old daemon is still alive.
    // That way, if install fails, the old daemon is unaffected.
    const installIdx = batch.indexOf(`call "${INPUT.npmCmd}" install -g --ignore-scripts ${INPUT.pkgSpec}`);
    const killWatchdogIdx = batch.indexOf('taskkill /f /t /pid !STALE_WD!');
    const killDaemonIdx = batch.indexOf('taskkill /f /pid !OLD_DAEMON_PID!');
    expect(installIdx).toBeGreaterThan(-1);
    expect(killWatchdogIdx).toBeGreaterThan(-1);
    expect(killDaemonIdx).toBeGreaterThan(-1);
    // Both kills MUST happen AFTER the install command
    expect(installIdx).toBeLessThan(killWatchdogIdx);
    expect(installIdx).toBeLessThan(killDaemonIdx);
  });

  it('every abort path removes the upgrade lock AND leaves the old daemon untouched', () => {
    // All four abort paths (install fail, no npm prefix, no shim, version
    // mismatch) must NOT contain a taskkill against the old daemon — the
    // old daemon should keep running since install didn't succeed.
    //
    // Each abort block is the chunk between "=== upgrade aborted" and
    // "goto :done".  None of those chunks should call taskkill on OLD_DAEMON_PID.
    const abortBlocks = batch.split('=== upgrade aborted').slice(1);
    expect(abortBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of abortBlocks) {
      const beforeGoto = block.split('goto :done')[0];
      expect(beforeGoto).not.toContain('taskkill /f /pid !OLD_DAEMON_PID!');
      expect(beforeGoto).not.toContain('taskkill /f /t /pid !STALE_WD!');
      // Every abort MUST delete the lock so the watchdog can resume
      expect(beforeGoto).toContain('del "%UPGRADE_LOCK%"');
    }
  });

  it('final :done safety-net always removes the lock even if a path forgot', () => {
    // If any abort path is buggy, or the batch is killed externally, the
    // :done label should unconditionally remove the lock so the watchdog
    // loop can resume.  Guards against future regressions.
    const doneIdx = batch.indexOf(':done');
    expect(doneIdx).toBeGreaterThan(-1);
    const afterDone = batch.slice(doneIdx);
    expect(afterDone).toContain('if exist "%UPGRADE_LOCK%"');
    expect(afterDone).toMatch(/del [^\r\n]*"%UPGRADE_LOCK%"/);
  });

  it('final safety-net falls back to PowerShell Remove-Item if del silently fails', () => {
    // Real-world incident on 2026-04-27: `del "%UPGRADE_LOCK%" >nul 2>&1`
    // returned 0 but the file persisted (suspected sharing violation /
    // transient AV scan / weird ACL inheritance).  The watchdog spun
    // forever logging "Upgrade in progress, waiting...".  Belt-and-
    // suspenders: if del fails, retry with PowerShell Remove-Item.
    const doneIdx = batch.indexOf(':done');
    const afterDone = batch.slice(doneIdx);
    expect(afterDone).toContain('Remove-Item -Force');
    expect(afterDone).toContain('-LiteralPath');
    // And log a WARNING if even that fails so the symptom is diagnosable
    // from the upgrade log instead of being silent.
    expect(afterDone).toMatch(/WARNING:.*upgrade\.lock still present/i);
  });

  it('every echo INSIDE an if(...) block has NO literal parens at all (not even ^-escaped)', () => {
    // cmd.exe parses if-blocks `if COND ( ... )` purely by counting
    // parens.  An unescaped `(` or `)` inside an `echo` argument
    // prematurely closes the if-block, so the rest of what looked
    // like the block falls outside as plain commands.  In the wild
    // (kill-daemon.mjs, 2026-05-07) we observed an echo like
    //   echo Watchdog launched (new daemon coming up in ~5s) >> log
    // breaking the parser so badly that BOTH the if-branch's
    // success message AND the else-branch's WARNING message got
    // logged on the same run, leaving the lock un-deleted because
    // the script's later `del "%UPGRADE_LOCK%"` got skipped.
    //
    // FIRST FIX (commit 68947ccf): escape literal parens with ^ inside
    // if-block echoes — `^(` and `^)`.
    //
    // SECOND OBSERVATION (2026-05-07, prod log /tmp/imcodes-upgrade-cdFehr/
    // upgrade.log): even WITH ^-escapes, cmd.exe inside `if exist (...)`
    // ate the closing `^)` of an echo.  Logged line was literally
    //   "Old daemon PID: 777468 (will be killed only after install succeeds"
    // — `(` printed but `)` was missing, even though source had `^(...^)`.
    // Verified via `od -c` on the prod log, not a display artifact.
    //
    // PERMANENT FIX: forbid ALL parens inside if-block echoes — escaped
    // or not.  Use `[...]` or `--...--` instead.  `[` and `]` are not
    // magic to cmd.exe's block parser at any nesting depth.
    //
    // Walk every line, track if-block depth from `(` at end-of-line
    // and `)` at start-of-line, and assert every `echo` line whose
    // depth > 0 has NO parens of any form.
    const lines = batch.split(/\r?\n/);
    let depth = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      // Closing paren on its own line decreases depth FIRST
      if (/^\)/.test(trimmed)) depth = Math.max(0, depth - 1);
      if (depth > 0 && /^\s*echo /.test(line)) {
        expect(line, `paren in if-block echo (use [...] or --...-- instead): ${line}`).not.toMatch(/[()]/);
      }
      // Opening paren at end-of-line increases depth AFTER scanning the line
      if (/\($/.test(trimmed)) depth += 1;
    }
  });

  it('emits trace markers at every major step so silent deaths are localizable', () => {
    // Production log /tmp/imcodes-upgrade-cdFehr/upgrade.log on 2026-05-07
    // showed npm install completing with "60 packages are looking for
    // funding" — and then the script went absolutely silent.  No trace
    // of which subsequent step (sharp-repair, npm prefix -g, version
    // check, taskkill, repair-watchdog, VBS launch) ran or hung.  The
    // resulting upgrade.lock stayed stranded at 19:11:57 and the watchdog
    // could not respawn.
    //
    // Defense: every major step emits a `[trace] step=N <stage>` line
    // BOTH before and after.  When the next silent death happens, the
    // last `[trace]` line in the log pinpoints exactly where it died.
    const expectedTraces = [
      '[trace] step=1 lock-created',
      '[trace] step=2 pre-npm-install',
      '[trace] step=2 post-npm-install',
      '[trace] step=2.1 pre-sharp-repair',
      '[trace] step=2.1 post-sharp-repair',
      '[trace] step=3 pre-npm-prefix',
      '[trace] step=3 post-npm-prefix',
      '[trace] step=3 pre-version-check',
      '[trace] step=3 post-version-check',
      '[trace] step=4 pre-kill-watchdogs',
      '[trace] step=5 pre-repair-watchdog',
      '[trace] step=5 post-repair-watchdog',
      '[trace] step=6 pre-vbs-launch',
      '[trace] step=6 post-vbs-launch',
      '[trace] step=7 lock-removed',
      '[trace] step=8 pre-health-check',
    ];
    for (const trace of expectedTraces) {
      expect(batch, `missing trace marker: ${trace}`).toContain(trace);
    }
  });

  it('trace markers appear in source-order so the log is read top-down', () => {
    // The ordering is what makes the trace log debuggable — each marker
    // must come strictly after the previous one in the generated batch.
    const orderedTraces = [
      '[trace] step=1 lock-created',
      '[trace] step=2 pre-npm-install',
      '[trace] step=2 post-npm-install',
      '[trace] step=2.1 pre-sharp-repair',
      '[trace] step=2.1 post-sharp-repair',
      '[trace] step=3 pre-npm-prefix',
      '[trace] step=3 post-npm-prefix',
      '[trace] step=3 pre-version-check',
      '[trace] step=3 post-version-check',
      '[trace] step=4 pre-kill-watchdogs',
      '[trace] step=5 pre-repair-watchdog',
      '[trace] step=5 post-repair-watchdog',
      '[trace] step=6 pre-vbs-launch',
      '[trace] step=6 post-vbs-launch',
      '[trace] step=7 lock-removed',
      '[trace] step=8 pre-health-check',
    ];
    let prevIdx = -1;
    for (const trace of orderedTraces) {
      const idx = batch.indexOf(trace);
      expect(idx, `out-of-order trace: ${trace}`).toBeGreaterThan(prevIdx);
      prevIdx = idx;
    }
  });

  it('post-npm-install trace captures the exit code so we can tell whether install actually succeeded', () => {
    // The 2026-05-07 prod log left ambiguity: did npm install exit 0 and
    // sharp-repair hang?  Or did npm install crash mid-cleanup?  The
    // post-npm-install trace records `exit=%INSTALL_EXIT%` so the answer
    // is unambiguous in the log.
    expect(batch).toMatch(/\[trace\] step=2 post-npm-install exit=%INSTALL_EXIT%/);
  });

  it('uses brackets (not parens) inside every if-block echo so cmd.exe parser never eats a token', () => {
    // Belt-and-suspenders for the paren-detection test — pin the
    // specific phrasings that previously had paren bugs.
    expect(batch).toContain('Old daemon PID: !OLD_DAEMON_PID! [will be killed only after install succeeds]');
    expect(batch).toMatch(/tree-killing watchdog PID !STALE_WD! \[via powershell\]/);
    expect(batch).toMatch(/tree-killing watchdog PID !STALE_WD! \[via wmic\]/);
    // And forbid the old fragile forms anywhere in the batch
    expect(batch).not.toMatch(/!OLD_DAEMON_PID! \^\(/);
    expect(batch).not.toMatch(/\[via powershell\^\)/);
    expect(batch).not.toMatch(/\[via wmic\^\)/);
  });

  it('NEVER uses `timeout /t` (regression: fails when launched via wscript)', () => {
    // `timeout /t N /nobreak` requires a real console for stdin (it polls
    // keypresses to detect interrupt).  When this batch is launched via
    // wscript → cmd, the spawned cmd has NO console attached, so timeout
    // aborts immediately with "Input redirection is not supported,
    // exiting the process immediately."  No actual sleep happens, which
    // breaks the post-install settle delay, the post-kill settle delay,
    // and the health-check grace period.  Use ping instead.
    expect(batch).not.toMatch(/timeout \/t \d+/);
    // At least one ping-based sleep should be present
    expect(batch).toMatch(/ping -n \d+ 127\.0\.0\.1 >nul 2>&1/);
  });

  it('passes --ignore-scripts to global install (sharp install hook crashes during global install)', () => {
    // strip-onnxruntime-gpu.mjs strips node_modules/sharp/ from the
    // published tarball, forcing npm to re-resolve sharp at install
    // time per platform.  When npm does that during a global install,
    // sharp's install hook (`node install/check.js || npm run build`)
    // fails with MODULE_NOT_FOUND on install/check.js, then falls back
    // to `npm run build` which walks UP into imcodes's package.json
    // and runs imcodes's `tsc` build (not on global PATH) — exit 127.
    // --ignore-scripts skips the hook entirely; sharp's runtime binary
    // (@img/sharp-<platform>-<arch>) is fetched as a regular optional
    // dependency with no install script, so semantic search still works.
    expect(batch).toContain('--ignore-scripts');
    // Specifically on the global install line.
    expect(batch).toMatch(/install -g --ignore-scripts/);
  });

  it('runs sharp repair if global install left an empty placeholder dir', () => {
    // npm 10.x exhibits an empty-dir bug under `npm i -g <tarball>` where
    // a stripped bundled dep (sharp) gets a placeholder created at
    // <global>/imcodes/node_modules/sharp/ but nothing extracted into it.
    // Detect via missing package.json and re-run install scoped to the
    // imcodes package — this works because nested install doesn't trigger
    // the same edge case.
    expect(batch).toContain('node_modules\\sharp\\package.json');
    expect(batch).toMatch(/sharp.*missing.*repairing/i);
    expect(batch).toContain('install --no-save --ignore-scripts sharp@0.34.5');
    // Repair only runs on the success path (don't waste time on aborted installs).
    const installFailIdx = batch.indexOf('Install FAILED');
    const repairIdx = batch.indexOf('install --no-save --ignore-scripts sharp');
    expect(repairIdx).toBeGreaterThan(installFailIdx);
  });

  it('uses BOTH PowerShell and wmic so it works on every Windows version', () => {
    // PowerShell works on Windows 7+; wmic is being removed from Windows 11
    // and Server 2025 images.  Try PowerShell first, fall back to wmic.
    expect(batch).toContain('powershell -NoProfile -NonInteractive');
    expect(batch).toContain('Get-CimInstance Win32_Process');
    expect(batch).toContain('daemon-watchdog');
    expect(batch).toContain('wmic process where');
    // Both branches should resolve to the same taskkill
    const psIdx = batch.indexOf('powershell -NoProfile');
    const wmicIdx = batch.indexOf('wmic process where');
    // PowerShell branch must come first (preferred)
    expect(psIdx).toBeGreaterThan(-1);
    expect(wmicIdx).toBeGreaterThan(psIdx);
  });

  // ── npm install ──

  it('overwrites (not appends) NODE_OPTIONS before npm install to avoid per-upgrade accumulation', () => {
    // Bug history: the script used to do
    //   set "NODE_OPTIONS=%NODE_OPTIONS% --max-old-space-size=16384"
    // which appends one copy per upgrade.  Because the new daemon spawned
    // by the script inherits this modified env, the next upgrade starts
    // with a NODE_OPTIONS already containing the flag, appends another,
    // and so on.  After ~38 upgrades we observed npm install crashing with
    // "MemoryChunk allocation failed during deserialization" because V8
    // tried to reserve a 16 GB heap on a tight VAS budget.
    //
    // Fix: save daemon's original value, OVERWRITE with a fresh single
    // flag, and restore the original immediately after npm install so
    // any spawned process (success-path watchdog OR abort-path relaunch)
    // never inherits our temporary flag.
    const saveIdx = batch.indexOf('set "ORIG_NODE_OPTIONS=%NODE_OPTIONS%"');
    const setFreshIdx = batch.indexOf('set "NODE_OPTIONS=--max-old-space-size=4096"');
    const installIdx = batch.indexOf(`call "${INPUT.npmCmd}" install -g --ignore-scripts ${INPUT.pkgSpec}`);
    const restoreIdx = batch.indexOf('set "NODE_OPTIONS=%ORIG_NODE_OPTIONS%"');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(setFreshIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(setFreshIdx);
    expect(setFreshIdx).toBeLessThan(installIdx);
    // Restore must happen RIGHT AFTER install, before any abort branch
    // that could re-spawn the daemon launcher.
    expect(installIdx).toBeLessThan(restoreIdx);
    // No appending form should remain — that was the bug.
    expect(batch).not.toContain('%NODE_OPTIONS% --max-old-space-size');
    // 16 GB heap was overkill for npm install and contributed to the OOM
    // on tight-RAM systems; we use 4 GB now.
    expect(batch).not.toContain('--max-old-space-size=16384');
  });

  it('restores NODE_OPTIONS before any post-install branch that may relaunch the daemon', () => {
    // Every branch that calls `wscript "%VBS_LAUNCHER%"` (whether on
    // install failure, version mismatch, or success-path step 6) MUST
    // run AFTER NODE_OPTIONS is restored to its original value.
    const restoreIdx = batch.indexOf('set "NODE_OPTIONS=%ORIG_NODE_OPTIONS%"');
    expect(restoreIdx).toBeGreaterThan(-1);
    let searchFrom = 0;
    let found = 0;
    while (true) {
      const idx = batch.indexOf('wscript "%VBS_LAUNCHER%"', searchFrom);
      if (idx === -1) break;
      expect(idx).toBeGreaterThan(restoreIdx);
      searchFrom = idx + 1;
      found += 1;
    }
    // Sanity: at least one daemon-relaunch path must exist.
    expect(found).toBeGreaterThan(0);
  });

  it('installs with quoted npm path', () => {
    expect(batch).toContain(`call "${INPUT.npmCmd}" install -g --ignore-scripts ${INPUT.pkgSpec}`);
  });

  // ── Version verification ──

  it('verifies installed CLI shim exists', () => {
    expect(batch).toContain('set "CLI_SHIM=%NPM_PREFIX%\\imcodes.cmd"');
    expect(batch).toContain('if not exist "%CLI_SHIM%"');
  });

  it('verifies installed version matches target', () => {
    expect(batch).toContain('call "%CLI_SHIM%" --version');
    expect(batch).toContain(`if /I not "%INSTALLED_VER%"=="${INPUT.targetVer}"`);
  });

  // ── repair-watchdog ──

  it('calls repair-watchdog after successful install', () => {
    const installOkIdx = batch.indexOf('Install succeeded');
    const repairIdx = batch.indexOf('call "%CLI_SHIM%" repair-watchdog');
    expect(repairIdx).toBeGreaterThan(installOkIdx);
  });

  // ── Success path does NOT use imcodes restart ──

  it('does not call imcodes restart on success path', () => {
    // After repair-watchdog, should use VBS + lock removal, not CLI restart
    const afterRepair = batch.slice(batch.indexOf('call "%CLI_SHIM%" repair-watchdog'));
    expect(afterRepair).not.toContain('CLI_SHIM%" restart');
  });

  // ── Health check ──

  it('runs health check after daemon restart', () => {
    expect(batch).toContain('Health check PASSED');
    expect(batch).toContain('Health check FAILED');
    expect(batch).toContain('daemon.pid not found');
  });

  // ── No visible windows ──

  it('uses hidden VBS for cleanup (no visible/minimized cmd window)', () => {
    // No `start` command — that always creates a visible window
    expect(batch).not.toContain('start ""');
    // No `start /min` either — flashes briefly in taskbar
    expect(batch).not.toContain('/min cmd /c');
    // Cleanup must be invoked via wscript on the cleanup VBS
    expect(batch).toContain('wscript "%CLEANUP_VBS%"');
    // Should be invoked at least 5 times (4 abort paths + 1 success)
    const wscriptCleanupCalls = batch.match(/wscript "%CLEANUP_VBS%"/g) ?? [];
    expect(wscriptCleanupCalls.length).toBeGreaterThanOrEqual(5);
  });

  // ── Recovery guarantee: daemon is never left dead ──

  it('daemon is always restarted — every code path ends with either VBS launch or lock removal', () => {
    // Count all paths that could leave the function:
    // 1. Each `goto :done` abort block must restart via VBS
    // 2. The success path must start VBS + remove lock
    // 3. The :done label itself just logs — that's fine since abort blocks already restarted

    const abortBlocks = batch.split('goto :done').slice(0, -1);
    for (const block of abortBlocks) {
      // Every abort must restart the daemon via VBS
      expect(block).toContain('wscript "%VBS_LAUNCHER%"');
    }

    // Success path must start new watchdog
    const successPath = batch.slice(batch.indexOf('Regenerating daemon launch chain'));
    expect(successPath).toContain('wscript "%VBS_LAUNCHER%"');
  });

  it('avoids embedding non-ASCII user paths directly in the batch body', () => {
    const nonAscii = buildWindowsUpgradeBatch({
      ...INPUT,
      logFile: 'C:\\Users\\测试用户B\\AppData\\Local\\Temp\\imcodes-upgrade-123\\upgrade.log',
      cleanupVbsPath: 'C:\\Users\\测试用户B\\AppData\\Local\\Temp\\imcodes-upgrade-123\\cleanup.vbs',
      vbsLauncherPath: 'C:\\Users\\测试用户B\\.imcodes\\daemon-launcher.vbs',
      upgradeLockFile: 'C:\\Users\\测试用户B\\.imcodes\\upgrade.lock',
    });
    expect(nonAscii).not.toContain('测试用户B');
    expect(nonAscii).toContain('%USERPROFILE%\\.imcodes\\daemon-launcher.vbs');
    expect(nonAscii).toContain('%SCRIPT_DIR%\\cleanup.vbs');
  });
});

describe('buildWindowsUpgradeBatch with latest target', () => {
  it('skips version comparison when target is "latest"', () => {
    const batch = buildWindowsUpgradeBatch({ ...INPUT, targetVer: 'latest' });
    expect(batch).toContain('if not "latest"=="latest"');
    // The condition `if not "latest"=="latest"` is always false → skip mismatch abort
  });
});
