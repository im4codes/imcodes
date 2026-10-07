import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONTROLLED_NODE_WATCHDOG_KEEP_DISABLED_MARKER } from '../../shared/controlled-node-service.js';
import { windowsControlledNodeHealthWatchdogScript } from '../../src/node/installer.js';
import { findPowerShell, runPowerShell } from './powershell-test-helper.js';

const pwsh = findPowerShell();
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

interface Scenario {
  /** Node task as the scheduler reports it: missing, disabled (State 1), ready (3), running (4). */
  task: 'missing' | 'disabled' | 'ready';
  /** Enable-ScheduledTask throws (e.g. access denied). */
  enableThrows?: boolean;
  /** Start-ScheduledTask throws. */
  startThrows?: boolean;
  /** A node process exists, this many seconds old; with a lease of this age (null = no lease). */
  process?: { ageSeconds: number; leaseAgeSeconds: number | null };
  /** The machine owner's `watchdog-keep-disabled` file exists in the install directory. */
  keepDisabledMarker?: boolean;
}

/**
 * Runs the real generated watchdog script `runs` times in one directory (so its
 * state file and log persist between ticks, as they do between scheduler ticks),
 * with the scheduler/CIM cmdlets stubbed. Returns what it logged and which
 * scheduler operations it attempted.
 */
function tick(scenario: Scenario, runs: number, dir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-'))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const paths = {
    nodePath: join(dir, 'imcodes-node.exe'),
    leasePath: join(dir, 'health-lease.json'),
    statePath: join(dir, 'health-watchdog-state.json'),
    logPath: join(dir, 'health-watchdog.log'),
    upgradeMarkerPath: join(dir, 'upgrade-in-progress.json'),
    keepDisabledMarkerPath: join(dir, CONTROLLED_NODE_WATCHDOG_KEEP_DISABLED_MARKER),
    calls: join(dir, 'calls.log'),
    scenario: join(dir, 'scenario.json'),
  };
  writeFileSync(paths.scenario, JSON.stringify(scenario));
  let script = windowsControlledNodeHealthWatchdogScript('C:\\ProgramData\\imcodes-node\\imcodes-node.exe');
  for (const key of ['nodePath', 'leasePath', 'statePath', 'logPath', 'upgradeMarkerPath', 'keepDisabledMarkerPath'] as const) {
    script = script.replace(new RegExp(`^\\$${key} = '.*'\\r$`, 'm'), () => `$${key} = '${paths[key]}'\r`);
  }
  if (scenario.keepDisabledMarker) writeFileSync(paths.keepDisabledMarkerPath, '');
  else rmSync(paths.keepDisabledMarkerPath, { force: true });
  if (scenario.process?.leaseAgeSeconds != null) {
    writeFileSync(paths.leasePath, JSON.stringify({ version: 1, pid: 4242, updatedAt: Date.now() - scenario.process.leaseAgeSeconds * 1000 }));
  }
  const prelude = `
$scn = Get-Content -LiteralPath $env:IMC_SCN -Raw | ConvertFrom-Json
$script:taskState = switch ($scn.task) { 'disabled' { 1 } 'ready' { 3 } default { 0 } }
function Note([string]$name) { Add-Content -LiteralPath $env:IMC_CALLS -Value $name }
function Start-Sleep { param($Seconds, $Milliseconds) }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction)
  if ($scn.process) { [pscustomobject]@{ ProcessId = 4242; ExecutablePath = $nodePath; CommandLine = 'imcodes-node.exe'; CreationDate = (Get-Date).AddSeconds(-[int]$scn.process.ageSeconds) } }
}
function Get-ScheduledTask { param($TaskName, $ErrorAction)
  if ($scn.task -eq 'missing') { return $null }
  [pscustomobject]@{ State = $script:taskState; Settings = [pscustomobject]@{ Enabled = ($script:taskState -ne 1) } }
}
function Enable-ScheduledTask { param($TaskName, $ErrorAction) Note 'enable'; if ($scn.enableThrows) { throw 'Access is denied.' }; $script:taskState = 3 }
function Start-ScheduledTask { param($TaskName, $ErrorAction) Note 'start'; if ($scn.startThrows) { throw 'The task image is corrupt or has been tampered with.' } }
function Stop-ScheduledTask { param($TaskName, $ErrorAction) Note 'stop' }
function Stop-Process { param($Id, $Force, $ErrorAction) Note 'kill' }
`;
  const outcomes: Array<number | null> = [];
  for (let i = 0; i < runs; i += 1) {
    const run = runPowerShell(pwsh!, `${prelude}\n${script}`, { IMC_SCN: paths.scenario, IMC_CALLS: paths.calls });
    expect(run.stderr, `run ${i}`).toBe('');
    outcomes.push(run.status);
  }
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  const calls = read(paths.calls).split('\n').filter(Boolean);
  const log = read(paths.logPath);
  const state = existsSync(paths.statePath) ? JSON.parse(read(paths.statePath)) as { reason: string } : null;
  return { calls, log, logLines: log.split('\n').filter(Boolean), state, outcomes, dir };
}

describe.skipIf(!pwsh)('Windows controlled-node watchdog (PowerShell)', () => {
  it('re-enables a node task that something outside the product disabled, then restarts it', () => {
    const result = tick({ task: 'disabled' }, 1);
    expect(result.outcomes).toEqual([0]);
    expect(result.calls).toEqual(['enable', 'stop', 'start']);
    expect(result.log).toContain('task_disabled_reenabled');
    expect(result.log).toContain('restart_begin reason=process_missing');
    expect(result.log).toContain('restart_requested');
  });

  it('does not restart-spin a task it cannot re-enable: logs the reason once and never calls Start', () => {
    const result = tick({ task: 'disabled', enableThrows: true }, 5);
    expect(result.outcomes).toEqual([0, 0, 0, 0, 0]);
    expect(result.calls.filter((c) => c === 'start')).toEqual([]);
    expect(result.calls.filter((c) => c === 'enable')).toHaveLength(5); // retried every tick, quietly
    expect(result.logLines.filter((l) => l.includes('task_enable_failed'))).toHaveLength(1);
    expect(result.logLines.filter((l) => l.includes('restart_blocked reason=task_disabled'))).toHaveLength(1);
    expect(result.log).not.toContain('restart_begin');
    expect(result.state?.reason).toBe('task_disabled');
  });

  it('honours the owner\'s watchdog-keep-disabled file: no re-enable, no restart, one task_disabled_kept line', () => {
    const result = tick({ task: 'disabled', keepDisabledMarker: true }, 4);
    expect(result.outcomes).toEqual([0, 0, 0, 0]);
    expect(result.calls).toEqual([]); // never enabled, never started, never stopped
    expect(result.logLines.filter((l) => l.includes('task_disabled_kept'))).toHaveLength(1);
    expect(result.log).not.toContain('task_disabled_reenabled');
    expect(result.log).not.toContain('restart_begin');
    expect(result.log).not.toContain('restart_blocked');
    expect(result.state?.reason).toBe('task_disabled_kept');
  });

  it('without the file the disabled task is re-enabled (default), and removing the file later restores that', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-'));
    const kept = tick({ task: 'disabled', keepDisabledMarker: true }, 2, dir);
    expect(kept.calls).toEqual([]);
    expect(kept.state?.reason).toBe('task_disabled_kept');
    // The owner deletes the file: the next tick re-enables and restarts, and the kept-state is gone.
    const released = tick({ task: 'disabled' }, 1, dir);
    expect(released.calls).toEqual(['enable', 'stop', 'start']);
    expect(released.log).toContain('task_disabled_reenabled');
    expect(released.log).toContain('restart_requested');
    expect(released.state).toBeNull();
  });

  it('the file matters only for a Disabled task: an enabled task whose node died is still restarted', () => {
    const result = tick({ task: 'ready', keepDisabledMarker: true }, 1);
    expect(result.calls).toEqual(['stop', 'start']);
    expect(result.log).toContain('restart_requested');
    expect(result.log).not.toContain('task_disabled_kept');
  });

  it('keeps the dedupe when the opt-out is set and a missing task is reported: the two reasons do not mask each other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-'));
    tick({ task: 'disabled', keepDisabledMarker: true }, 2, dir);
    const missing = tick({ task: 'missing', keepDisabledMarker: true }, 2, dir);
    expect(missing.logLines.filter((l) => l.includes('restart_blocked reason=task_missing'))).toHaveLength(1);
    expect(missing.calls).toEqual([]);
  });

  it('a task that no longer exists is reported once, not restarted every tick', () => {
    const result = tick({ task: 'missing' }, 4);
    expect(result.calls.filter((c) => c === 'start')).toEqual([]);
    expect(result.logLines.filter((l) => l.includes('restart_blocked reason=task_missing'))).toHaveLength(1);
    expect(result.state?.reason).toBe('task_missing');
  });

  it('a Start that fails is caught and logged once instead of failing the whole watchdog silently', () => {
    const result = tick({ task: 'ready', startThrows: true }, 4);
    expect(result.outcomes).toEqual([0, 0, 0, 0]);
    expect(result.logLines.filter((l) => l.includes('restart_failed'))).toHaveLength(1);
    expect(result.log).toContain('restart_failed The task image is corrupt');
    expect(result.state?.reason).toBe('start_failed');
    expect(result.log).not.toContain('restart_requested');
  });

  it('recovers: once the task is usable again the next tick restarts it and clears the blocked state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-'));
    const first = tick({ task: 'missing' }, 2, dir);
    expect(first.state?.reason).toBe('task_missing');
    const second = tick({ task: 'ready' }, 1, dir);
    expect(second.calls).toContain('start');
    expect(second.log).toContain('restart_requested');
    expect(second.state).toBeNull();
  });

  it('leaves a healthy node alone and never looks at the task', () => {
    const result = tick({ task: 'disabled', process: { ageSeconds: 3_600, leaseAgeSeconds: 5 } }, 3);
    expect(result.calls).toEqual([]);
    expect(result.log).not.toContain('restart');
    expect(result.state?.reason).toBe('healthy');
  });

  it('a process still inside its start grace is not restarted, whatever the task looks like', () => {
    const result = tick({ task: 'ready', process: { ageSeconds: 30, leaseAgeSeconds: null } }, 2);
    expect(result.calls).toEqual([]);
    expect(result.state?.reason).toBe('process_start_grace');
  });

  it('an unhealthy long-running process still gets the confirmation grace first (behaviour unchanged)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-watchdog-'));
    const first = tick({ task: 'ready', process: { ageSeconds: 3_600, leaseAgeSeconds: 600 } }, 1, dir);
    expect(first.log).toContain('grace_begin reason=lease_stale');
    expect(first.calls).toEqual([]);
  });
});
