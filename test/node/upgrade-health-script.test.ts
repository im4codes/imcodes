import { describe, expect, it } from 'vitest';
import { CONTROLLED_NODE_UPGRADE_HEALTH as H } from '../../shared/controlled-node-service.js';
import { windowsUpgradeHealthWaitScript } from '../../src/node/upgrade-health-script.js';
import { findPowerShell, runPowerShell } from './powershell-test-helper.js';

const pwsh = findPowerShell();

/**
 * Runs the real generated health-wait functions under PowerShell with a virtual
 * clock and scripted process/lease behaviour, so a node that starts slowly can be
 * "waited for" for 15 minutes in milliseconds.
 *
 * scenario: { aliveFrom, aliveUntil, leaseAt } in virtual milliseconds after Start-ScheduledTask
 *   (alive between aliveFrom and aliveUntil; lease valid from leaseAt; null = never).
 */
function waitFor(scenario: { aliveFrom: number | null; aliveUntil?: number | null; leaseAt?: number | null; gaps?: Array<[number, number]> }) {
  const script = `${windowsUpgradeHealthWaitScript()}
$scn = '${JSON.stringify(scenario)}' | ConvertFrom-Json
$script:t = 0
function Start-Sleep { param([int]$Milliseconds) $script:t += $Milliseconds }
function Get-IMCodesElapsedMs { return [int64]$script:t }
function Test-Alive {
  if ($null -eq $scn.aliveFrom) { return $false }
  if ($script:t -lt $scn.aliveFrom) { return $false }
  if ($null -ne $scn.aliveUntil -and $script:t -ge $scn.aliveUntil) { return $false }
  foreach ($gap in @($scn.gaps)) { if ($gap -and $script:t -ge $gap[0] -and $script:t -lt $gap[1]) { return $false } }
  return $true
}
function Get-IMCodesNodeProcess { param([string]$NodePath) if (Test-Alive) { return [pscustomobject]@{ ProcessId = 1 } } else { return $null } }
function Test-IMCodesHealthLease { param([string]$LeasePath, [string]$NodePath, [int64]$StartedAtMs) return ($null -ne $scn.leaseAt -and $script:t -ge $scn.leaseAt -and (Test-Alive)) }
$result = Wait-IMCodesNodeHealthy -LeasePath 'unused' -NodePath 'unused' -StartedAtMs 0
$result | ConvertTo-Json -Compress
`;
  const run = runPowerShell(pwsh!, script);
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim().split('\n').pop()!) as { Healthy: boolean; Verdict: string; ElapsedMs: number; FirstSeenMs: number | null };
}

describe.skipIf(!pwsh)('Windows self-upgrade authenticated-health wait (PowerShell)', () => {
  it('waits for a node that is slow to start: the real incident needed 119 of the old 120 seconds', () => {
    const result = waitFor({ aliveFrom: 2_000, leaseAt: 119_000 });
    expect(result).toMatchObject({ Healthy: true, Verdict: 'healthy' });
  });

  it('waits past the old fixed window for a node that takes three minutes to connect', () => {
    // Process created almost at once, the first authenticated heartbeat only after 180 s (slow disk /
    // antivirus scan / loaded machine). The fixed 120 s window rolled this back.
    const result = waitFor({ aliveFrom: 4_000, leaseAt: 180_000 });
    expect(result).toMatchObject({ Healthy: true, Verdict: 'healthy' });
    expect(result.ElapsedMs).toBeGreaterThan(H.BASE_WINDOW_MS);
  });

  it('measures the window from the node process, not from Start-ScheduledTask', () => {
    // The process appears 100 s after the start request; it then still gets its full base window.
    const result = waitFor({ aliveFrom: 100_000, leaseAt: 100_000 + H.BASE_WINDOW_MS + 60_000 });
    expect(result).toMatchObject({ Healthy: true });
    expect(result.FirstSeenMs).toBeGreaterThanOrEqual(100_000);
  });

  it('rolls back at the hard cap, and only then, for a node that stays up but never authenticates', () => {
    const result = waitFor({ aliveFrom: 1_000, leaseAt: null });
    expect(result).toMatchObject({ Healthy: false, Verdict: 'fail_hard_cap' });
    expect(result.ElapsedMs).toBeGreaterThanOrEqual(H.HARD_CAP_MS);
    expect(result.ElapsedMs).toBeLessThan(H.HARD_CAP_MS + 2 * H.POLL_MS);
  });

  it('accepts a lease that lands just inside the hard cap and rejects one just outside it', () => {
    expect(waitFor({ aliveFrom: 1_000, leaseAt: H.HARD_CAP_MS - 2 * H.POLL_MS })).toMatchObject({ Healthy: true });
    expect(waitFor({ aliveFrom: 1_000, leaseAt: H.HARD_CAP_MS + 5 * H.POLL_MS })).toMatchObject({ Healthy: false, Verdict: 'fail_hard_cap' });
  });

  it('gives up early on a node that never appears (no point waiting 15 minutes for nothing)', () => {
    const result = waitFor({ aliveFrom: null, leaseAt: null });
    expect(result).toMatchObject({ Healthy: false, Verdict: 'fail_no_process' });
    expect(result.ElapsedMs).toBeGreaterThanOrEqual(H.SPAWN_ALLOWANCE_MS);
    expect(result.ElapsedMs).toBeLessThan(H.SPAWN_ALLOWANCE_MS + 2 * H.POLL_MS);
  });

  it('gives up once a node that started has died and the base window is over', () => {
    const result = waitFor({ aliveFrom: 1_000, aliveUntil: 30_000, leaseAt: null });
    expect(result).toMatchObject({ Healthy: false, Verdict: 'fail_process_gone' });
    // Not before the base window measured from first sight, not at the hard cap.
    expect(result.ElapsedMs).toBeGreaterThanOrEqual(1_000 + H.BASE_WINDOW_MS);
    expect(result.ElapsedMs).toBeLessThan(1_000 + H.BASE_WINDOW_MS + (H.ABSENT_POLLS_AFTER_FLOOR + 2) * H.POLL_MS);
  });

  it('tolerates a restart blip inside the base window and a brief absence after it', () => {
    // crash + Task Scheduler restart 10 s later, well inside the window; then a one-poll blip after it.
    const result = waitFor({
      aliveFrom: 1_000, leaseAt: 200_000,
      gaps: [[10_000, 20_000], [150_000, 150_000 + H.POLL_MS]],
    });
    expect(result).toMatchObject({ Healthy: true });
  });

  it('is healthy the moment the lease is valid, however early', () => {
    expect(waitFor({ aliveFrom: 0, leaseAt: 0 })).toMatchObject({ Healthy: true, Verdict: 'healthy' });
  });
});

describe.skipIf(!pwsh)('Windows self-upgrade health verdict table (PowerShell)', () => {
  const verdict = (elapsed: number, firstSeen: number | null, alive: boolean, absent: number, healthy = false) => {
    const run = runPowerShell(pwsh!, `${windowsUpgradeHealthWaitScript()}
Write-Output (Get-IMCodesUpgradeHealthVerdict -ElapsedMs ${elapsed} -FirstSeenMs ${firstSeen === null ? '$null' : firstSeen} -AliveNow $${alive} -AbsentPolls ${absent} -Healthy $${healthy})`);
    expect(run.status, run.stderr).toBe(0);
    return run.stdout.trim();
  };

  it.each([
    ['healthy wins over everything, even past the cap', [H.HARD_CAP_MS + 1, 1_000, true, 0, true], 'healthy'],
    ['before the spawn allowance with no process', [H.SPAWN_ALLOWANCE_MS - 1, null, false, 5], 'wait'],
    ['at the spawn allowance with no process', [H.SPAWN_ALLOWANCE_MS, null, false, 5], 'fail_no_process'],
    ['inside the base window, even if the process is momentarily absent', [1_000 + H.BASE_WINDOW_MS - 1, 1_000, false, 9], 'wait'],
    ['past the base window while alive', [1_000 + H.BASE_WINDOW_MS + 60_000, 1_000, true, 0], 'wait'],
    ['past the base window, absent below the poll threshold', [1_000 + H.BASE_WINDOW_MS + 1, 1_000, false, H.ABSENT_POLLS_AFTER_FLOOR - 1], 'wait'],
    ['past the base window, absent at the threshold', [1_000 + H.BASE_WINDOW_MS + 1, 1_000, false, H.ABSENT_POLLS_AFTER_FLOOR], 'fail_process_gone'],
    ['alive at the hard cap', [H.HARD_CAP_MS, 1_000, true, 0], 'fail_hard_cap'],
    ['one poll before the hard cap while alive', [H.HARD_CAP_MS - H.POLL_MS, 1_000, true, 0], 'wait'],
  ] as const)('%s', (_name, args, expected) => {
    expect(verdict(...(args as unknown as Parameters<typeof verdict>))).toBe(expected);
  });
});

describe.skipIf(!pwsh)('Windows self-upgrade health probes (PowerShell)', () => {
  it('finds the node by image path with Get-Process and never asks WMI (a WMI query took minutes on a loaded real node)', () => {
    const run = runPowerShell(pwsh!, `${windowsUpgradeHealthWaitScript()}
function Get-CimInstance { throw 'WMI must not be used by the health wait' }
function Get-Process { param($Name, $Id, $ErrorAction)
  @(
    [pscustomobject]@{ Id = 12; Path = 'C:\\Other\\imcodes-node.exe' },
    [pscustomobject]@{ Id = 13; Path = $null },
    [pscustomobject]@{ Id = 14; Path = 'c:\\programdata\\imcodes-node\\IMCODES-NODE.EXE' }
  )
}
$found = Get-IMCodesNodeProcess -NodePath 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe'
$none = Get-IMCodesNodeProcess -NodePath 'C:\\Nowhere\\imcodes-node.exe'
Write-Output ('found=' + $found.Id + ' none=' + [bool]$none)`);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('found=14 none=False');
  });

  it('a lease counts only when written after the restart by a live process at the new path', () => {
    const run = runPowerShell(pwsh!, `${windowsUpgradeHealthWaitScript()}
function Get-CimInstance { throw 'WMI must not be used by the health wait' }
$dir = Join-Path ([IO.Path]::GetTempPath()) ('lease-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $dir | Out-Null
$lease = Join-Path $dir 'health-lease.json'
$script:procPath = '/new/imcodes-node.exe'
$script:alive = $true
function Get-Process { param($Name, $Id, $ErrorAction) if ($script:alive) { [pscustomobject]@{ Id = $Id; Path = $script:procPath } } }
function Probe([string]$json) { Set-Content -LiteralPath $lease -Value $json; return (Test-IMCodesHealthLease -LeasePath $lease -NodePath '/new/imcodes-node.exe' -StartedAtMs 1000) }
$out = [ordered]@{}
$out.fresh = Probe '{"version":1,"pid":7,"updatedAt":2000}'
$out.stale = Probe '{"version":1,"pid":7,"updatedAt":999}'
$out.nopid = Probe '{"version":1,"pid":0,"updatedAt":2000}'
$out.garbage = Probe 'not json'
$script:procPath = '/old/imcodes-node.exe'
$out.wrongpath = Probe '{"version":1,"pid":7,"updatedAt":2000}'
$script:procPath = '/new/imcodes-node.exe'; $script:alive = $false
$out.deadpid = Probe '{"version":1,"pid":7,"updatedAt":2000}'
Remove-Item -Recurse -Force $dir
$out | ConvertTo-Json -Compress`);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim().split('\n').pop()!)).toEqual({
      fresh: true, stale: false, nopid: false, garbage: false, wrongpath: false, deadpid: false,
    });
  });
});
