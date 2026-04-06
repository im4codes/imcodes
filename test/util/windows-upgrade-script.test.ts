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
    upgradeLockFile: 'C:\\Users\\tester\\.imcodes\\upgrade.lock',
  });

  it('creates upgrade lock before npm install', () => {
    const lockIdx = batch.indexOf('echo upgrade > "C:\\Users\\tester\\.imcodes\\upgrade.lock"');
    const installIdx = batch.indexOf('call "C:\\Program Files\\nodejs\\npm.cmd" install');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(installIdx);
  });

  it('removes lock on every abort path so watchdog resumes', () => {
    const abortBlocks = batch.split('goto :done');
    // At least 4 abort paths (install fail, no prefix, no shim, version mismatch)
    const lockDeletes = abortBlocks.filter(b => b.includes('del "C:\\Users\\tester\\.imcodes\\upgrade.lock"'));
    expect(lockDeletes.length).toBeGreaterThanOrEqual(4);
  });

  it('starts new watchdog via VBS then removes lock after successful install', () => {
    // After the actual repair-watchdog CLI call, batch should start VBS then remove lock
    const repairCallIdx = batch.indexOf('call "%CLI_SHIM%" repair-watchdog');
    const afterRepair = batch.slice(repairCallIdx);
    const vbsIdx = afterRepair.indexOf('Starting new watchdog via VBS');
    const delIdx = afterRepair.indexOf('Removing upgrade lock');
    expect(vbsIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeGreaterThan(vbsIdx);
    expect(afterRepair).toContain('del "C:\\Users\\tester\\.imcodes\\upgrade.lock"');
  });

  it('kills daemon before npm install', () => {
    expect(batch).toContain('taskkill /f /pid !OLD_PID!');
  });

  it('installs the requested package with a quoted npm path', () => {
    expect(batch).toContain('call "C:\\Program Files\\nodejs\\npm.cmd" install -g imcodes@1.2.3');
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

  it('lets watchdog restart daemon after lock removal (no manual restart)', () => {
    // After successful upgrade, should NOT call `imcodes restart`
    // — the watchdog loop will detect lock removal and restart automatically
    const afterLockRemoval = batch.split('Removing upgrade lock')[1] ?? '';
    expect(afterLockRemoval).not.toContain('imcodes restart');
    expect(afterLockRemoval).not.toContain('CLI_SHIM%" restart');
  });

  it('runs health check after watchdog restarts daemon', () => {
    expect(batch).toContain('Health check PASSED');
    expect(batch).toContain('Health check FAILED');
    expect(batch).toContain('tasklist /fi "PID eq !DAEMON_PID!"');
  });

  it('uses minimized cleanup windows', () => {
    expect(batch).toContain('start "" /min cmd /c "C:\\Temp\\imcodes-upgrade-123\\cleanup.cmd" >nul 2>&1');
  });
});
