import { describe, expect, it } from 'vitest';
import { REMOTE_EXEC_MAX_COMMAND_BYTES, utf8ByteLength } from '../../shared/remote-exec.js';
import {
  CONTROLLED_NODE_SERVICE,
  CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR,
} from '../../shared/controlled-node-service.js';
import {
  buildLegacyWindowsUpgradeRescueCommand,
  buildLegacyWindowsUpgradeRescueScript,
  LEGACY_WINDOWS_UPGRADE_RESCUE_GRACE_MS,
  LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX,
} from '../src/ws/windows-controlled-node-upgrade-rescue.js';

const RESCUE_ID = '12345678-1234-4abc-8def-1234567890ab';

function decodeSetup(command: string): string {
  const encoded = command.match(/FromBase64String\('([^']+)'\)/)?.[1];
  if (!encoded) throw new Error('setup payload missing');
  return Buffer.from(encoded, 'base64').toString('utf8');
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
});
