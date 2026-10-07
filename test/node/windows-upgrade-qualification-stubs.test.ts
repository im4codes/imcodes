import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROLLED_NODE_UPGRADE_HEALTH as H } from '../../shared/controlled-node-service.js';
import {
  applyQualificationHealthStubs,
  QUALIFICATION_BASE_STUBS,
} from '../../scripts/windows-upgrade-qualification-stubs.js';
import { windowsUpgradeHealthWaitScript } from '../../src/node/upgrade-health-script.js';
import { findPowerShell, runPowerShell } from './powershell-test-helper.js';

const pwsh = findPowerShell();

/**
 * The CI-only Windows qualification (scripts/qualify-windows-self-upgrade.ts) runs the
 * generated upgrade script against stubbed primitives. It broke when the script's wait
 * moved to primitives the stubs did not cover (a 60 s harness timeout against the real
 * clock). This runs the SAME stubs, composed the same way, around the real health-wait
 * block on any machine with pwsh, so a drift fails on a pull request instead of only
 * on the push-only Windows job.
 */
function qualificationHealthWait(mode: 'success' | 'rollback') {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-qualification-stubs-'));
  try {
    const node = join(dir, 'imcodes-node.exe');
    const lease = join(dir, 'health-lease.json');
    // Same shape as the harness's Start-ScheduledTask stub for the node task.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$qualificationNode = '${node}'`,
      `$qualificationLease = '${lease}'`,
      `$qualificationMode = '${mode}'`,
      ...QUALIFICATION_BASE_STUBS,
      applyQualificationHealthStubs(windowsUpgradeHealthWaitScript()),
      'function Start-ScheduledTask { param($TaskName, $ErrorAction)',
      '  if ($qualificationMode -eq "success") {',
      '    $script:qualificationNodeStarted = $true',
      '    @{ version = 1; pid = 42; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $qualificationLease -Encoding utf8',
      '  }',
      '}',
      '$startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
      'Start-ScheduledTask -TaskName "imcodes-node"',
      '$result = Wait-IMCodesNodeHealthy -LeasePath $qualificationLease -NodePath $qualificationNode -StartedAtMs $startedAt',
      '$result | ConvertTo-Json -Compress',
    ].join('\r\n');
    writeFileSync(join(dir, 'unused'), '');
    const started = Date.now();
    const run = runPowerShell(pwsh!, script);
    const realMs = Date.now() - started;
    expect(run.status, run.stderr).toBe(0);
    return { realMs, result: JSON.parse(run.stdout.trim().split('\n').pop()!) as { Healthy: boolean; Verdict: string; ElapsedMs: number } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Windows upgrade qualification stubs', () => {
  it('refuses to apply to a script that has no health-wait end marker (the seam moved)', () => {
    expect(() => applyQualificationHealthStubs('$ErrorActionPreference = "Stop"\r\n')).toThrow(/health-wait end marker/);
  });

  it('puts the stubs after the health block, so they replace its real-clock defaults', () => {
    const composed = applyQualificationHealthStubs(windowsUpgradeHealthWaitScript());
    expect(composed.indexOf('function Get-IMCodesElapsedMs { if ($null')).toBeGreaterThan(-1);
    expect(composed.indexOf('function Get-IMCodesElapsedMs { return [int64]$script:qualificationClockMs }'))
      .toBeGreaterThan(composed.indexOf('function Get-IMCodesElapsedMs { if ($null'));
  });

  describe.skipIf(!pwsh)('under PowerShell', () => {
    it('success: the stubbed node authenticates and the wait ends healthy within seconds of real time', () => {
      const { realMs, result } = qualificationHealthWait('success');
      expect(result).toMatchObject({ Healthy: true, Verdict: 'healthy' });
      expect(realMs).toBeLessThan(30_000);
    });

    it('rollback: a node that never appears is judged failed on the virtual clock, within seconds of real time', () => {
      const { realMs, result } = qualificationHealthWait('rollback');
      expect(result).toMatchObject({ Healthy: false, Verdict: 'fail_no_process' });
      expect(result.ElapsedMs).toBeGreaterThanOrEqual(H.SPAWN_ALLOWANCE_MS);
      expect(realMs).toBeLessThan(30_000); // not the 180 s real allowance the CI timeout (60 s) cut off
    });
  });
});
