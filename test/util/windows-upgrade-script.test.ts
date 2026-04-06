import { describe, expect, it } from 'vitest';
import { buildWindowsCleanupScript, buildWindowsUpgradeBatch } from '../../src/util/windows-upgrade-script.js';

const INPUT = {
  logFile: 'C:\\Temp\\upgrade.log',
  scriptDir: 'C:\\Temp\\imcodes-upgrade-123',
  cleanupPath: 'C:\\Temp\\imcodes-upgrade-123\\cleanup.cmd',
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
    expect(script).toContain('timeout /t 120 /nobreak >nul');
    expect(script).toContain('rmdir /s /q "C:\\Temp\\imcodes-upgrade-123"');
  });
});

describe('buildWindowsUpgradeBatch', () => {
  const batch = buildWindowsUpgradeBatch(INPUT);

  // ── Lock file lifecycle ──

  it('creates upgrade lock BEFORE npm install', () => {
    const lockIdx = batch.indexOf(`echo upgrade > "${INPUT.upgradeLockFile}"`);
    const installIdx = batch.indexOf(`call "${INPUT.npmCmd}" install`);
    expect(lockIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(installIdx);
  });

  it('every abort path deletes lock AND restarts VBS', () => {
    // Split on `goto :done` — each abort block must have both del lock + wscript
    const blocks = batch.split('goto :done');
    // Last block is after :done label — skip it
    const abortBlocks = blocks.slice(0, -1);
    // At least 4 abort paths: install fail, no prefix, no shim, version mismatch
    expect(abortBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of abortBlocks) {
      expect(block).toContain(`del "${INPUT.upgradeLockFile}"`);
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

  it('kills old watchdog tree before npm install', () => {
    const killTreeIdx = batch.indexOf('taskkill /f /t /pid !WD_PID!');
    const installIdx = batch.indexOf(`call "${INPUT.npmCmd}" install`);
    expect(killTreeIdx).toBeGreaterThan(-1);
    expect(killTreeIdx).toBeLessThan(installIdx);
  });

  it('kills daemon directly as belt-and-suspenders', () => {
    expect(batch).toContain('taskkill /f /pid !OLD_PID!');
  });

  it('finds watchdog parent via wmic', () => {
    expect(batch).toContain('wmic process where');
    expect(batch).toContain('ParentProcessId');
  });

  // ── npm install ──

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

  it('uses minimized cleanup windows', () => {
    const cleanupCalls = batch.match(/start.*cmd.*cleanup/g) ?? [];
    for (const call of cleanupCalls) {
      expect(call).toContain('/min');
    }
    expect(cleanupCalls.length).toBeGreaterThan(0);
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
      expect(block).toContain(`wscript "${INPUT.vbsLauncherPath}"`);
    }

    // Success path must start new watchdog
    const successPath = batch.slice(batch.indexOf('Regenerating daemon launch chain'));
    expect(successPath).toContain(`wscript "${INPUT.vbsLauncherPath}"`);
  });
});

describe('buildWindowsUpgradeBatch with latest target', () => {
  it('skips version comparison when target is "latest"', () => {
    const batch = buildWindowsUpgradeBatch({ ...INPUT, targetVer: 'latest' });
    expect(batch).toContain('if not "latest"=="latest"');
    // The condition `if not "latest"=="latest"` is always false → skip mismatch abort
  });
});
