import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Windows controlled-node read-only diagnostics', () => {
  it('collects the required offline/sleep evidence without changing state or reading credentials', () => {
    const script = readFileSync('scripts/diagnose-windows-controlled-node.ps1', 'utf8');
    for (const required of [
      'Get-ScheduledTaskInfo',
      'LastTaskResult',
      'health-watchdog.log',
      'health-lease.json',
      'daemon.log',
      'powercfg /lastwake',
      'Microsoft-Windows-Kernel-Power',
      'Microsoft-Windows-Power-Troubleshooter',
      'MSPower_DeviceEnable',
      '--version',
      'imcodes-node-upgrade-*',
      'ExecutableMatchesReceipt',
      'ExecutableSha256',
      'ReceiptSha256',
      'upgrade-in-progress.json',
      'BackupExecutablePresent',
    ]) expect(script).toContain(required);

    expect(script).not.toMatch(/Get-Content[^\n]+credential\.json/i);
    expect(script).not.toMatch(/\b(?:Set|Stop|Start|Restart|Remove|Unregister)-ScheduledTask\b/i);
    expect(script).not.toMatch(/\b(?:Stop|Start|Restart)-Process\b/i);
    expect(script).not.toMatch(/Invoke-(?:WebRequest|RestMethod)|curl|wget/i);
    expect(script).toContain('No settings were changed and no data was uploaded.');
  });
});
