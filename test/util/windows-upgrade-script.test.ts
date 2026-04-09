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
    expect(script).toContain('timeout /t 120 /nobreak >nul');
    expect(script).toContain('for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI"');
    expect(script).toContain('rmdir /s /q "%SCRIPT_DIR%"');
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

  // ── Daemon + old watchdog kill ──

  it('finds and tree-kills ALL daemon-watchdog cmd.exe processes by command-line pattern', () => {
    // REGRESSION GUARD — when an old watchdog is in a crash-loop because the
    // OLD watchdog.cmd had a UTF-8 BOM (cmd.exe parses [BOM]@echo as the
    // unknown command "[BOM]@echo"), there is no daemon.pid to walk back
    // from. The upgrade script must enumerate watchdogs by their cmd line.
    expect(batch).toContain('taskkill /f /t /pid !STALE_WD!');
    // Must run BEFORE npm install
    const killByPatternIdx = batch.indexOf('taskkill /f /t /pid !STALE_WD!');
    const installIdx = batch.indexOf(`call "${INPUT.npmCmd}" install`);
    expect(killByPatternIdx).toBeGreaterThan(-1);
    expect(killByPatternIdx).toBeLessThan(installIdx);
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

  it('kills daemon directly via PIDFILE as belt-and-suspenders', () => {
    expect(batch).toContain('taskkill /f /pid !OLD_PID!');
  });

  // ── npm install ──

  it('raises NODE_OPTIONS heap limit before npm install while preserving existing flags', () => {
    const nodeOptionsIdx = batch.indexOf('set "NODE_OPTIONS=%NODE_OPTIONS% --max-old-space-size=16384"');
    const fallbackIdx = batch.indexOf('set "NODE_OPTIONS=--max-old-space-size=16384"');
    const installIdx = batch.indexOf(`call "${INPUT.npmCmd}" install -g ${INPUT.pkgSpec}`);
    expect(nodeOptionsIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(nodeOptionsIdx).toBeLessThan(installIdx);
    expect(fallbackIdx).toBeLessThan(installIdx);
    expect(batch).toContain('echo Using NODE_OPTIONS=%NODE_OPTIONS% >> "%LOG_FILE%"');
  });

  it('installs with quoted npm path', () => {
    expect(batch).toContain(`call "${INPUT.npmCmd}" install -g ${INPUT.pkgSpec}`);
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
