import { CONTROLLED_NODE_UPGRADE_HEALTH } from '../../shared/controlled-node-service.js';

/**
 * PowerShell for the authenticated-health wait of a Windows controlled-node
 * self-upgrade. Kept as plain functions so the generated upgrade script and the
 * script-level tests (which run it under PowerShell with stubbed process/lease
 * primitives and a virtual clock) execute the very same text.
 *
 * Verdicts (see CONTROLLED_NODE_UPGRADE_HEALTH for the numbers):
 *  - `healthy`           a lease written after the restart by the node at the new path
 *  - `wait`              keep polling
 *  - `fail_hard_cap`     the absolute ceiling elapsed
 *  - `fail_no_process`   the node process never appeared within the spawn allowance
 *  - `fail_process_gone` past the base window and the node has been absent for N polls
 */
export function windowsUpgradeHealthWaitScript(): string {
  const h = CONTROLLED_NODE_UPGRADE_HEALTH;
  return [
    `function Get-IMCodesUpgradeHealthVerdict {`,
    `  param([int64]$ElapsedMs, $FirstSeenMs, [bool]$AliveNow, [int]$AbsentPolls, [bool]$Healthy)`,
    `  if ($Healthy) { return 'healthy' }`,
    `  if ($ElapsedMs -ge ${h.HARD_CAP_MS}) { return 'fail_hard_cap' }`,
    `  if ($null -eq $FirstSeenMs) {`,
    `    if ($ElapsedMs -ge ${h.SPAWN_ALLOWANCE_MS}) { return 'fail_no_process' }`,
    `    return 'wait'`,
    `  }`,
    `  if (($ElapsedMs - [int64]$FirstSeenMs) -lt ${h.BASE_WINDOW_MS}) { return 'wait' }`,
    `  if ($AliveNow) { return 'wait' }`,
    `  if ($AbsentPolls -ge ${h.ABSENT_POLLS_AFTER_FLOOR}) { return 'fail_process_gone' }`,
    `  return 'wait'`,
    `}`,
    `$script:IMCodesHealthClock = $null`,
    `function Get-IMCodesElapsedMs { if ($null -eq $script:IMCodesHealthClock) { $script:IMCodesHealthClock = [Diagnostics.Stopwatch]::StartNew() }; return [int64]$script:IMCodesHealthClock.ElapsedMilliseconds }`,
    // Get-Process, never Get-CimInstance/WMI: on a loaded machine a WMI query takes minutes (3 minutes for
    // a trivial one was measured on a real node), which stretches every poll far past the window it is
    // meant to measure. Get-Process answers in seconds on the same machine.
    `function Get-IMCodesNodeProcess {`,
    `  param([string]$NodePath)`,
    `  return (Get-Process -Name imcodes-node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals($_.Path, $NodePath, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1)`,
    `}`,
    `function Test-IMCodesHealthLease {`,
    `  param([string]$LeasePath, [string]$NodePath, [int64]$StartedAtMs)`,
    `  try {`,
    `    $lease = Get-Content -LiteralPath $LeasePath -Raw | ConvertFrom-Json`,
    `    if ([int64]$lease.updatedAt -ge $StartedAtMs -and [int]$lease.pid -gt 0) {`,
    `      $leaseProcess = Get-Process -Id ([int]$lease.pid) -ErrorAction SilentlyContinue`,
    `      return [bool]($leaseProcess -and $leaseProcess.Path -and [string]::Equals($leaseProcess.Path, $NodePath, [StringComparison]::OrdinalIgnoreCase))`,
    `    }`,
    `  } catch { }`,
    `  return $false`,
    `}`,
    `function Wait-IMCodesNodeHealthy {`,
    `  param([string]$LeasePath, [string]$NodePath, [int64]$StartedAtMs)`,
    `  $firstSeenMs = $null`,
    `  $absentPolls = 0`,
    `  while ($true) {`,
    `    Start-Sleep -Milliseconds ${h.POLL_MS}`,
    `    $elapsedMs = Get-IMCodesElapsedMs`,
    `    $nodeProcess = Get-IMCodesNodeProcess -NodePath $NodePath`,
    `    if ($nodeProcess) { if ($null -eq $firstSeenMs) { $firstSeenMs = $elapsedMs }; $absentPolls = 0 } else { $absentPolls++ }`,
    `    $isHealthy = Test-IMCodesHealthLease -LeasePath $LeasePath -NodePath $NodePath -StartedAtMs $StartedAtMs`,
    `    $verdict = Get-IMCodesUpgradeHealthVerdict -ElapsedMs $elapsedMs -FirstSeenMs $firstSeenMs -AliveNow ([bool]$nodeProcess) -AbsentPolls $absentPolls -Healthy $isHealthy`,
    `    if ($verdict -ne 'wait') { return [pscustomobject]@{ Healthy = ($verdict -eq 'healthy'); Verdict = $verdict; ElapsedMs = $elapsedMs; FirstSeenMs = $firstSeenMs } }`,
    `  }`,
    `}`,
  ].join('\r\n') + '\r\n';
}
