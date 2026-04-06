import { describe, expect, it } from 'vitest';
import { buildWindowsCleanupScript, buildWindowsUpgradeBatch } from '../../src/util/windows-upgrade-script.js';

describe('buildWindowsCleanupScript', () => {
  it('generates a standalone cleanup cmd script', () => {
    const script = buildWindowsCleanupScript('C:\\Temp\\imcodes-upgrade-123');
    expect(script).toContain('@echo off');
    expect(script).toContain('timeout /t 120 /nobreak >nul');
    expect(script).toContain('rmdir /s /q "C:\\Temp\\imcodes-upgrade-123"');
  });
});

describe('buildWindowsUpgradeBatch', () => {
  const batch = buildWindowsUpgradeBatch({
    logFile: 'C:\\Temp\\upgrade.log',
    scriptDir: 'C:\\Temp\\imcodes-upgrade-123',
    cleanupPath: 'C:\\Temp\\imcodes-upgrade-123\\cleanup.cmd',
    npmCmd: 'C:\\Program Files\\nodejs\\npm.cmd',
    pkgSpec: 'imcodes@1.2.3',
    targetVer: '1.2.3',
    vbsLauncherPath: 'C:\\Users\\tester\\.imcodes\\daemon-launcher.vbs',
  });

  it('kills watchdog tree before npm install to prevent MODULE_NOT_FOUND race', () => {
    const installIdx = batch.indexOf('call "C:\\Program Files\\nodejs\\npm.cmd" install');
    const killIdx = batch.indexOf('taskkill /f /t /pid');
    // Kill must come BEFORE the actual install command
    expect(killIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeLessThan(installIdx);
    // Should also read daemon PID and find parent via wmic
    expect(batch).toContain('set /p OLD_PID=');
    expect(batch).toContain('wmic process where');
    expect(batch).toContain('ParentProcessId');
  });

  it('deletes stale PID file after killing watchdog', () => {
    expect(batch).toContain('del "%PIDFILE%" >nul 2>&1');
  });

  it('installs the requested package with a quoted npm path', () => {
    expect(batch).toContain('call "C:\\Program Files\\nodejs\\npm.cmd" install -g imcodes@1.2.3');
  });

  it('restarts old daemon on install failure (does not leave it dead)', () => {
    // Every "Install FAILED" / abort path should restart via VBS before aborting
    expect(batch).toContain('Install FAILED');
    expect(batch).toContain('restarting current daemon');
    // Count VBS restarts in abort paths (each abort block has wscript call)
    const abortBlocks = batch.split('goto :done');
    // At least 4 abort paths (install fail, no prefix, no shim, version mismatch)
    const vbsRestarts = abortBlocks.filter(b => b.includes('wscript'));
    expect(vbsRestarts.length).toBeGreaterThanOrEqual(4);
  });

  it('verifies the installed CLI shim and version before restart', () => {
    expect(batch).toContain('set "NPM_PREFIX="');
    expect(batch).toContain('prefix -g');
    expect(batch).toContain('set "CLI_SHIM=%NPM_PREFIX%\\imcodes.cmd"');
    expect(batch).toContain('if not exist "%CLI_SHIM%"');
    expect(batch).toContain('set "INSTALLED_VER="');
    expect(batch).toContain('call "%CLI_SHIM%" --version');
    expect(batch).toContain('if /I not "%INSTALLED_VER%"=="1.2.3"');
  });

  it('starts fresh watchdog via VBS launcher instead of imcodes restart', () => {
    // After successful install, should use VBS directly (not CLI restart)
    expect(batch).toContain('wscript "C:\\Users\\tester\\.imcodes\\daemon-launcher.vbs"');
    // Should NOT depend on `imcodes restart` for the normal path
    // (only as fallback if VBS missing)
    const afterRepair = batch.split('repair-watchdog')[1] ?? '';
    expect(afterRepair).toContain('Starting fresh watchdog via VBS');
    expect(afterRepair).toContain('wscript');
  });

  it('runs health check after restart', () => {
    expect(batch).toContain('Health check PASSED');
    expect(batch).toContain('Health check FAILED');
    expect(batch).toContain('tasklist /fi "PID eq !DAEMON_PID!"');
  });

  it('uses minimized cleanup windows', () => {
    expect(batch).toContain('start "" /min cmd /c "C:\\Temp\\imcodes-upgrade-123\\cleanup.cmd" >nul 2>&1');
    expect(batch).not.toContain('rmdir /s /q ""');
  });

  it('kills stale watchdog loops not just the active one', () => {
    expect(batch).toContain('daemon-watchdog');
    expect(batch).toContain("Name='cmd.exe'");
  });
});
