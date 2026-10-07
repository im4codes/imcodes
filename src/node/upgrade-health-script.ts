import { CONTROLLED_NODE_UPGRADE_HEALTH } from '../../shared/controlled-node-service.js';

/**
 * Comment line that ends the health-wait block inside the generated upgrade
 * script. The qualification harness (scripts/windows-upgrade-qualification-stubs.ts)
 * injects its virtual clock and stubbed process primitives right after it, so the
 * stubs replace this block's own defaults without editing the script under test.
 */
export const WINDOWS_UPGRADE_HEALTH_WAIT_END_MARKER = '# imcodes-health-wait-end';

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
    WINDOWS_UPGRADE_HEALTH_WAIT_END_MARKER,
  ].join('\r\n') + '\r\n';
}

/**
 * POSIX `sh` for the authenticated-health wait of a macOS/Linux controlled-node
 * self-upgrade: the same rules as {@link windowsUpgradeHealthWaitScript}, from the
 * same numbers (CONTROLLED_NODE_UPGRADE_HEALTH), plus the two things a service
 * manager adds: it respawns a dying node (a crash loop must not look "alive"
 * between restarts), and a stop request must abort the wait.
 *
 * The verdict is a pure function; the wait loop talks to the machine only through
 * the `imcodes_*` primitives (sleep, clock, service pid, lease), which the script
 * tests replace with a virtual clock and a scripted node.
 *
 * Verdicts: `healthy`, `wait`, `fail_hard_cap`, `fail_no_process`,
 * `fail_process_gone`, `fail_crash_loop`, `fail_interrupted`.
 * Healthy argument: 1 = a lease written after the restart by the service's own
 * pid; 2 = Linux only, a lease-less (older) target that survived the unit's
 * watchdog window under one pid (the watchdog only stays fed by an authenticated
 * node).
 */
export function posixUpgradeHealthWaitScript(): string {
  const h = CONTROLLED_NODE_UPGRADE_HEALTH;
  return [
    `imcodes_upgrade_health_verdict() {`,
    `  # $1 elapsed_ms  $2 first_seen_ms ('' = never seen)  $3 alive_now  $4 absent_polls  $5 healthy  $6 restarts  $7 interrupted`,
    `  if [ "$5" != "0" ]; then echo healthy; return 0; fi`,
    `  if [ -n "$7" ]; then echo fail_interrupted; return 0; fi`,
    `  if [ "$1" -ge ${h.HARD_CAP_MS} ]; then echo fail_hard_cap; return 0; fi`,
    `  if [ "$6" -ge ${h.CRASH_LOOP_RESTARTS} ]; then echo fail_crash_loop; return 0; fi`,
    `  if [ -z "$2" ]; then`,
    `    if [ "$1" -ge ${h.SPAWN_ALLOWANCE_MS} ]; then echo fail_no_process; else echo wait; fi`,
    `    return 0`,
    `  fi`,
    `  if [ $(( $1 - $2 )) -lt ${h.BASE_WINDOW_MS} ]; then echo wait; return 0; fi`,
    `  if [ "$3" = "1" ]; then echo wait; return 0; fi`,
    `  if [ "$4" -ge ${h.ABSENT_POLLS_AFTER_FLOOR} ]; then echo fail_process_gone; return 0; fi`,
    `  echo wait`,
    `}`,
    `imcodes_wait_node_healthy() {`,
    `  IMCODES_CLOCK_START=$(imcodes_now_s)`,
    `  first_seen=''; absent=0; last_pid=''; pid_changes=0; pid_since=0`,
    `  while :; do`,
    `    imcodes_sleep_poll`,
    `    elapsed=$(imcodes_elapsed_ms)`,
    `    pid=$(imcodes_service_pid)`,
    `    if imcodes_pid_alive "$pid"; then`,
    `      alive=1; absent=0`,
    `      if [ -z "$first_seen" ]; then first_seen=$elapsed; fi`,
    `      if [ "$pid" != "$last_pid" ]; then`,
    `        if [ -n "$last_pid" ]; then pid_changes=$(( pid_changes + 1 )); fi`,
    `        last_pid=$pid; pid_since=$elapsed`,
    `      fi`,
    `    else`,
    `      alive=0; absent=$(( absent + 1 ))`,
    `    fi`,
    `    restarts=$(imcodes_restart_count)`,
    `    case "$restarts" in ''|*[!0-9]*) restarts=0;; esac`,
    `    if [ "$restarts" -lt "$pid_changes" ]; then restarts=$pid_changes; fi`,
    `    healthy=0`,
    `    if imcodes_lease_healthy; then healthy=1`,
    `    elif [ "$IMCODES_LEGACY_SURVIVAL_MS" -gt 0 ] && [ "$alive" = "1" ] && [ ! -e "$IMCODES_LEASE" ] && [ $(( elapsed - pid_since )) -ge "$IMCODES_LEGACY_SURVIVAL_MS" ]; then healthy=2`,
    `    fi`,
    `    IMCODES_HEALTH_VERDICT=$(imcodes_upgrade_health_verdict "$elapsed" "$first_seen" "$alive" "$absent" "$healthy" "$restarts" "$IMCODES_INTERRUPTED")`,
    `    if [ "$IMCODES_HEALTH_VERDICT" != "wait" ]; then`,
    `      IMCODES_HEALTH_ELAPSED_MS=$elapsed`,
    `      [ "$IMCODES_HEALTH_VERDICT" = "healthy" ]`,
    `      return $?`,
    `    fi`,
    `  done`,
    `}`,
  ].join('\n') + '\n';
}

/**
 * The machine-facing primitives of the POSIX health wait. Defined as functions so
 * a test can shadow any of them (or put stub `date`/`sleep`/`systemctl` on PATH).
 * The service's OWN pid is the identity check: a lease only counts when it names
 * the pid the service manager runs (which is, by definition, the installed
 * executable), so no `/proc` or `ps` path matching is needed.
 */
export function posixUpgradePrimitivesScript(input: { platform: 'darwin' | 'linux'; linuxUnit: string; macosLabel: string }): string {
  const pollSeconds = Math.max(1, Math.round(CONTROLLED_NODE_UPGRADE_HEALTH.POLL_MS / 1000));
  const servicePid = input.platform === 'linux'
    ? `systemctl show -p MainPID ${input.linuxUnit} 2>/dev/null | sed -n 's/^MainPID=//p' | head -n 1`
    : `launchctl print system/${input.macosLabel} 2>/dev/null | sed -n 's/^[[:space:]]*pid = \\([0-9][0-9]*\\).*/\\1/p' | head -n 1`;
  const restartCount = input.platform === 'linux'
    ? `systemctl show -p NRestarts ${input.linuxUnit} 2>/dev/null | sed -n 's/^NRestarts=//p' | head -n 1`
    : `echo 0`;
  return [
    `imcodes_now_s() { date +%s; }`,
    `imcodes_wall_ms() { echo $(( $(imcodes_now_s) * 1000 )); }`,
    `imcodes_elapsed_ms() { echo $(( ( $(imcodes_now_s) - IMCODES_CLOCK_START ) * 1000 )); }`,
    `imcodes_sleep_poll() { sleep ${pollSeconds}; }`,
    `imcodes_service_pid() { ${servicePid}; }`,
    `imcodes_restart_count() { ${restartCount}; }`,
    `imcodes_pid_alive() {`,
    `  case "$1" in ''|*[!0-9]*|0) return 1;; esac`,
    `  kill -0 "$1" 2>/dev/null`,
    `}`,
    `imcodes_lease_healthy() {`,
    `  [ -f "$IMCODES_LEASE" ] || return 1`,
    `  lease_pid=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$IMCODES_LEASE" 2>/dev/null | head -n 1)`,
    `  lease_at=$(sed -n 's/.*"updatedAt":\\([0-9][0-9]*\\).*/\\1/p' "$IMCODES_LEASE" 2>/dev/null | head -n 1)`,
    `  [ -n "$lease_pid" ] && [ -n "$lease_at" ] || return 1`,
    `  [ "$lease_at" -ge "$IMCODES_STARTED_AT_MS" ] || return 1`,
    `  [ "$lease_pid" = "$(imcodes_service_pid)" ] || return 1`,
    `  imcodes_pid_alive "$lease_pid"`,
    `}`,
  ].join('\n') + '\n';
}
