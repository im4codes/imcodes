import { describe, expect, it } from 'vitest';
import { REMOTE_EXEC_MAX_COMMAND_BYTES, utf8ByteLength } from '../../shared/remote-exec.js';
import {
  CONTROLLED_NODE_SERVICE,
  CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR,
  CONTROLLED_NODE_WINDOWS_UPGRADE_TASK_PREFIX,
} from '../../shared/controlled-node-service.js';
import {
  buildLegacyWindowsUpgradeRescueCommand,
  buildLegacyWindowsUpgradeRescueScript,
  buildLegacyWindowsUpgradeRestartCommand,
  LEGACY_WINDOWS_UPGRADE_RESCUE_GRACE_MS,
  LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX,
  LEGACY_WINDOWS_UPGRADE_RESTART_READY_PREFIX,
} from '../src/ws/windows-controlled-node-upgrade-rescue.js';

const RESCUE_ID = '12345678-1234-4abc-8def-1234567890ab';
const RESTART_ID = 'abcdef12-3456-4abc-8def-1234567890ab';

function decodeSetup(command: string): string {
  const encoded = command.match(/FromBase64String\('([^']+)'\)/)?.[1];
  if (!encoded) throw new Error('setup payload missing');
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function decodeRestartScript(setup: string): string {
  const encoded = setup.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
  if (!encoded) throw new Error('restart payload missing');
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('legacy Windows controlled-node upgrade rescue', () => {
  it('fits the legacy exec envelope and does not depend on the old daemon version', () => {
    const built = buildLegacyWindowsUpgradeRescueCommand(RESCUE_ID);
    expect(utf8ByteLength(built.command)).toBeLessThanOrEqual(REMOTE_EXEC_MAX_COMMAND_BYTES);
    expect(built.expectedStdout).toBe(`${LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX}:${RESCUE_ID}`);
    expect(built.commandSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.command).not.toMatch(/daemonVersion|0\.1\.2|v94/);
  });

  it('backs up and verifies old bytes, hardens ACLs, verifies the independent task, then publishes the marker last', () => {
    const setup = decodeSetup(buildLegacyWindowsUpgradeRescueCommand(RESCUE_ID).command);
    expect(setup).toContain("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'");
    expect(setup).toContain('Import-Module -Name $utilityModulePath -ErrorAction Stop');
    expect(setup.indexOf('Import-Module -Name $utilityModulePath -ErrorAction Stop'))
      .toBeLessThan(setup.indexOf('$mainSha = (Get-FileHash'));
    const backupAt = setup.indexOf("Copy-Item -Force -LiteralPath $nodePath -Destination $backupMain");
    const backupVerifyAt = setup.indexOf('legacy upgrade rescue main backup verification failed');
    const aclAt = setup.indexOf("'/inheritance:r'");
    const registerAt = setup.indexOf('Register-ScheduledTask');
    const taskVerifyAt = setup.indexOf('legacy upgrade rescue task verification failed');
    const markerAt = setup.indexOf("Move-Item -Force -LiteralPath $markerTmp -Destination $markerPath");
    expect([backupAt, backupVerifyAt, aclAt, registerAt, taskVerifyAt, markerAt].every((value) => value >= 0)).toBe(true);
    expect(backupAt).toBeLessThan(backupVerifyAt);
    expect(backupVerifyAt).toBeLessThan(aclAt);
    expect(aclAt).toBeLessThan(registerAt);
    expect(registerAt).toBeLessThan(taskVerifyAt);
    expect(taskVerifyAt).toBeLessThan(markerAt);
    expect(setup).toContain(`$rescueTask = '${CONTROLLED_NODE_SERVICE.WINDOWS_LEGACY_UPGRADE_RESCUE_TASK}'`);
    expect(setup).toContain(`$rescueRoot = Join-Path $env:ProgramData '${CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR}'`);
    expect(setup).toContain("'*S-1-5-18:(OI)(CI)F'");
    expect(setup).toContain("'*S-1-5-32-544:(OI)(CI)F'");
    expect(setup).toContain("@('/setowner','*S-1-5-18')");
    expect(setup).toContain("if ($LASTEXITCODE -ne 0) { throw 'legacy upgrade rescue ACL hardening failed' }");
  });

  it('waits beyond the legacy ten-minute hard limit and restores exact main/helper state only when authenticated health is absent', () => {
    const rescue = buildLegacyWindowsUpgradeRescueScript();
    expect(rescue.indexOf('Import-Module -Name $utilityModulePath -ErrorAction Stop'))
      .toBeLessThan(rescue.indexOf('(Get-FileHash -Algorithm SHA256'));
    expect(LEGACY_WINDOWS_UPGRADE_RESCUE_GRACE_MS).toBeGreaterThan(10 * 60 * 1000);
    expect(rescue).toContain(`if ($ageMs -lt ${LEGACY_WINDOWS_UPGRADE_RESCUE_GRACE_MS}) { exit 0 }`);
    expect(rescue).toContain("[int]$lease.pid -eq [int]$process.ProcessId");
    expect(rescue).toContain('legacy upgrade rescue restored main hash mismatch');
    expect(rescue).toContain('legacy upgrade rescue helper file count mismatch');
    expect(rescue).toContain("$marker.status = 'rolled_back'");
    expect(rescue).toContain("Add-Member -InputObject $marker -NotePropertyName 'rolledBackAt'");
    expect(rescue).toContain(`Start-ScheduledTask -TaskName $mainTask`);
    expect(rescue.indexOf("$marker.status = 'rolled_back'"))
      .toBeLessThan(rescue.indexOf('Start-ScheduledTask -TaskName $mainTask'));
  });

  it('builds a verified one-shot SYSTEM restart only after the matching rescue and old upgrade task are clear', () => {
    const built = buildLegacyWindowsUpgradeRestartCommand(RESCUE_ID, RESTART_ID);
    expect(utf8ByteLength(built.command)).toBeLessThanOrEqual(REMOTE_EXEC_MAX_COMMAND_BYTES);
    expect(built.expectedStdout).toBe(`${LEGACY_WINDOWS_UPGRADE_RESTART_READY_PREFIX}:${RESTART_ID}`);
    expect(built.commandSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.command).not.toMatch(/daemonVersion|0\.1\.2|v94/);

    const setup = decodeSetup(built.command);
    expect(setup).toContain(`$upgradePrefix = '${CONTROLLED_NODE_WINDOWS_UPGRADE_TASK_PREFIX}'`);
    expect(setup).toContain(`$rescueTask = '${CONTROLLED_NODE_SERVICE.WINDOWS_LEGACY_UPGRADE_RESCUE_TASK}'`);
    expect(setup).toContain(`$restartTask = '${CONTROLLED_NODE_SERVICE.WINDOWS_LEGACY_UPGRADE_RESTART_TASK}'`);
    expect(setup).toContain(`[string]$marker.rescueId -cne '${RESCUE_ID}'`);
    expect(setup).toContain('legacy upgrade restart source main hash mismatch');
    expect(setup).toContain("Get-ScheduledTask -TaskName ($upgradePrefix + '*') -ErrorAction Stop");
    expect(setup).toContain('-notin @($rescueTask, $restartTask)');
    expect(setup).toContain("throw 'legacy upgrade task still registered'");
    expect(setup.indexOf("throw 'legacy upgrade task still registered'"))
      .toBeLessThan(setup.indexOf('Register-ScheduledTask -TaskName $restartTask'));
    expect(setup).toContain("-User 'SYSTEM' -RunLevel Highest -Force");
    expect(setup).toContain('legacy upgrade restart task verification failed');
    expect(setup.indexOf('legacy upgrade restart task verification failed'))
      .toBeLessThan(setup.indexOf('Start-ScheduledTask -TaskName $restartTask'));

    const restart = decodeRestartScript(setup);
    expect(restart).toContain(`$mainTask = '${CONTROLLED_NODE_SERVICE.WINDOWS_TASK}'`);
    expect(restart).toContain(`$watchdogTask = '${CONTROLLED_NODE_SERVICE.WINDOWS_WATCHDOG_TASK}'`);
    expect(restart).toContain('Import-Module -Name $utilityModulePath -ErrorAction Stop');
    expect(restart).toContain('Start-Sleep -Seconds 5');
    expect(restart).toContain('[StringComparison]::OrdinalIgnoreCase');
    expect(restart).toContain('Stop-ScheduledTask -TaskName $mainTask');
    expect(restart).toContain('Stop-Process -Id $_.ProcessId');
    expect(restart).toContain('Start-ScheduledTask -TaskName $mainTask');
    expect(restart).toContain('Unregister-ScheduledTask -TaskName $restartTask');
    expect(restart.indexOf('Stop-ScheduledTask -TaskName $mainTask'))
      .toBeLessThan(restart.indexOf('Stop-Process -Id $_.ProcessId'));
    expect(restart.indexOf('Stop-Process -Id $_.ProcessId'))
      .toBeLessThan(restart.indexOf('Start-ScheduledTask -TaskName $mainTask'));
    expect(restart.indexOf('Start-ScheduledTask -TaskName $mainTask'))
      .toBeLessThan(restart.indexOf('Unregister-ScheduledTask -TaskName $restartTask'));
  });

  it('rejects malformed rescue or restart correlation ids', () => {
    expect(() => buildLegacyWindowsUpgradeRestartCommand('not-an-id', RESTART_ID))
      .toThrow('invalid_legacy_upgrade_rescue_id');
    expect(() => buildLegacyWindowsUpgradeRestartCommand(RESCUE_ID, 'not-an-id'))
      .toThrow('invalid_legacy_upgrade_restart_id');
  });
});
