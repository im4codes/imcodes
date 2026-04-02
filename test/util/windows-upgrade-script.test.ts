import { describe, expect, it } from 'vitest';
import { buildWindowsCleanupScript, buildWindowsUpgradeBatch } from '../../src/util/windows-upgrade-script.js';

describe('buildWindowsCleanupScript', () => {
  it('generates a standalone cleanup cmd script', () => {
    const script = buildWindowsCleanupScript('C:\\Temp\\imcodes-upgrade-123');
    expect(script).toContain('@echo off');
    expect(script).toContain('timeout /t 60 /nobreak >nul');
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

  it('uses the shared CLI restart path through the global shim instead of startup cmd shortcuts', () => {
    expect(batch).toContain('call "%CLI_SHIM%" restart');
    expect(batch).not.toContain('imcodes-daemon.cmd');
    expect(batch).not.toContain('taskkill /f /pid');
  });

  it('uses a standalone cleanup script instead of nested inline cleanup quoting', () => {
    expect(batch).toContain('start "" cmd /c "C:\\Temp\\imcodes-upgrade-123\\cleanup.cmd" >nul 2>&1');
    expect(batch).not.toContain('rmdir /s /q ""');
  });
});
