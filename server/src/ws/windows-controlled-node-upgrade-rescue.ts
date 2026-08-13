import { createHash } from 'node:crypto';
import {
  CONTROLLED_NODE_SERVICE,
  CONTROLLED_NODE_WINDOWS_INSTALL_DIR,
  CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR,
} from '../../../shared/controlled-node-service.js';
import { WINDOWS_POWERSHELL_UTILITY_MODULE_PREFLIGHT } from '../../../shared/windows-powershell-modules.js';

export const LEGACY_WINDOWS_UPGRADE_RESCUE_GRACE_MS = 11 * 60 * 1000;
export const LEGACY_WINDOWS_UPGRADE_RESCUE_EXEC_TIMEOUT_MS = 120_000;
export const LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX = 'IMCODES_UPGRADE_RESCUE_READY' as const;

function psSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function utf8Base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * The rescue task is deliberately independent from the legacy watchdog that the
 * deployed upgrader disables. It waits beyond the legacy task's ten-minute hard
 * limit, then restores the exact pre-upgrade bytes if the replacement has not
 * produced a fresh PID-bound authenticated-health lease.
 */
export function buildLegacyWindowsUpgradeRescueScript(): string {
  return `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_UTILITY_MODULE_PREFLIGHT
    + `$nodeDir = Join-Path $env:ProgramData ${psSingleQuote(CONTROLLED_NODE_WINDOWS_INSTALL_DIR)}\r\n`
    + `$rescueRoot = Join-Path $env:ProgramData ${psSingleQuote(CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR)}\r\n`
    + `$markerPath = Join-Path $rescueRoot 'marker.json'\r\n`
    + `if (-not (Test-Path -LiteralPath $markerPath)) { exit 0 }\r\n`
    + `$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json\r\n`
    + `if ([string]$marker.status -ne 'prepared') { exit 0 }\r\n`
    + `$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()\r\n`
    + `$ageMs = $nowMs - [int64]$marker.preparedAt\r\n`
    + `if ($ageMs -lt ${LEGACY_WINDOWS_UPGRADE_RESCUE_GRACE_MS}) { exit 0 }\r\n`
    + `$nodePath = Join-Path $nodeDir 'imcodes-node.exe'\r\n`
    + `$leasePath = Join-Path $nodeDir 'health-lease.json'\r\n`
    + `$process = Get-CimInstance Win32_Process -Filter \"Name='imcodes-node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $nodePath -and $_.CommandLine -notmatch '--computer-use-helper' } | Select-Object -First 1\r\n`
    + `$healthy = $false\r\n`
    + `if ($process -and (Test-Path -LiteralPath $leasePath)) {\r\n`
    + `  try {\r\n`
    + `    $lease = Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json\r\n`
    + `    $leaseAgeMs = $nowMs - [int64]$lease.updatedAt\r\n`
    + `    $healthy = [int]$lease.version -eq 1 -and [int]$lease.pid -eq [int]$process.ProcessId -and $leaseAgeMs -ge -60000 -and $leaseAgeMs -le 180000\r\n`
    + `  } catch { $healthy = $false }\r\n`
    + `}\r\n`
    + `if ($healthy) { exit 0 }\r\n`
    + `$mainTask = ${psSingleQuote(CONTROLLED_NODE_SERVICE.WINDOWS_TASK)}\r\n`
    + `$watchdogTask = ${psSingleQuote(CONTROLLED_NODE_SERVICE.WINDOWS_WATCHDOG_TASK)}\r\n`
    + `Stop-ScheduledTask -TaskName $mainTask -ErrorAction SilentlyContinue\r\n`
    + `if ($process) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }\r\n`
    + `Start-Sleep -Seconds 2\r\n`
    + `$backupDir = Join-Path $rescueRoot 'backup'\r\n`
    + `$backupMain = Join-Path $backupDir 'imcodes-node.exe'\r\n`
    + `if (-not (Test-Path -LiteralPath $backupMain)) { throw 'legacy upgrade rescue main backup missing' }\r\n`
    + `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupMain).Hash.ToLowerInvariant() -ne [string]$marker.mainSha256) { throw 'legacy upgrade rescue main backup hash mismatch' }\r\n`
    + `Copy-Item -Force -LiteralPath $backupMain -Destination $nodePath\r\n`
    + `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath).Hash.ToLowerInvariant() -ne [string]$marker.mainSha256) { throw 'legacy upgrade rescue restored main hash mismatch' }\r\n`
    + `$manifestPath = Join-Path $nodeDir 'imcodes-node.exe.manifest.json'\r\n`
    + `$backupManifest = Join-Path $backupDir 'imcodes-node.exe.manifest.json'\r\n`
    + `if ([bool]$marker.hadManifest) {\r\n`
    + `  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupManifest).Hash.ToLowerInvariant() -ne [string]$marker.manifestSha256) { throw 'legacy upgrade rescue manifest backup hash mismatch' }\r\n`
    + `  Copy-Item -Force -LiteralPath $backupManifest -Destination $manifestPath\r\n`
    + `} else { Remove-Item -Force -LiteralPath $manifestPath -ErrorAction SilentlyContinue }\r\n`
    + `$helperPath = Join-Path $nodeDir 'computer-use-helper'\r\n`
    + `$backupHelper = Join-Path $backupDir 'computer-use-helper'\r\n`
    + `if ([bool]$marker.hadHelper) {\r\n`
    + `  Remove-Item -Recurse -Force -LiteralPath $helperPath -ErrorAction SilentlyContinue\r\n`
    + `  Copy-Item -Recurse -Force -LiteralPath $backupHelper -Destination $helperPath\r\n`
    + `  $restoredFiles = @(Get-ChildItem -LiteralPath $helperPath -Recurse -File | Sort-Object FullName)\r\n`
    + `  if ($restoredFiles.Count -ne @($marker.helperFiles).Count) { throw 'legacy upgrade rescue helper file count mismatch' }\r\n`
    + `  foreach ($expected in @($marker.helperFiles)) {\r\n`
    + `    $candidate = Join-Path $helperPath ([string]$expected.path)\r\n`
    + `    if (-not (Test-Path -LiteralPath $candidate) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash.ToLowerInvariant() -ne [string]$expected.sha256) { throw 'legacy upgrade rescue helper hash mismatch' }\r\n`
    + `  }\r\n`
    + `} else { Remove-Item -Recurse -Force -LiteralPath $helperPath -ErrorAction SilentlyContinue }\r\n`
    + `$marker.status = 'rolled_back'\r\n`
    + `Add-Member -InputObject $marker -NotePropertyName 'rolledBackAt' -NotePropertyValue ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Force\r\n`
    + `$marker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerPath -Encoding UTF8\r\n`
    + `Enable-ScheduledTask -TaskName $mainTask -ErrorAction SilentlyContinue | Out-Null\r\n`
    + `Enable-ScheduledTask -TaskName $watchdogTask -ErrorAction SilentlyContinue | Out-Null\r\n`
    + `Start-ScheduledTask -TaskName $mainTask\r\n`;
}

export interface LegacyWindowsUpgradeRescueCommand {
  command: string;
  commandSha256: string;
  expectedStdout: string;
}

/** Build the bounded, self-verifying PowerShell setup command sent over legacy MACHINE_EXEC. */
export function buildLegacyWindowsUpgradeRescueCommand(rescueId: string): LegacyWindowsUpgradeRescueCommand {
  if (!/^[0-9a-f-]{36}$/i.test(rescueId)) throw new Error('invalid_legacy_upgrade_rescue_id');
  const rescueScriptBase64 = utf8Base64(buildLegacyWindowsUpgradeRescueScript());
  const expectedStdout = `${LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX}:${rescueId}`;
  const setupScript = `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_UTILITY_MODULE_PREFLIGHT
    + `$rescueId = ${psSingleQuote(rescueId)}\r\n`
    + `$nodeDir = Join-Path $env:ProgramData ${psSingleQuote(CONTROLLED_NODE_WINDOWS_INSTALL_DIR)}\r\n`
    + `$nodePath = Join-Path $nodeDir 'imcodes-node.exe'\r\n`
    + `if (-not (Test-Path -LiteralPath $nodePath)) { throw 'legacy upgrade rescue source main missing' }\r\n`
    + `$rescueRoot = Join-Path $env:ProgramData ${psSingleQuote(CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR)}\r\n`
    + `$rescueTask = ${psSingleQuote(CONTROLLED_NODE_SERVICE.WINDOWS_LEGACY_UPGRADE_RESCUE_TASK)}\r\n`
    + `Stop-ScheduledTask -TaskName $rescueTask -ErrorAction SilentlyContinue\r\n`
    + `Unregister-ScheduledTask -TaskName $rescueTask -Confirm:$false -ErrorAction SilentlyContinue\r\n`
    + `Remove-Item -Recurse -Force -LiteralPath $rescueRoot -ErrorAction SilentlyContinue\r\n`
    + `$backupDir = Join-Path $rescueRoot 'backup'\r\n`
    + `New-Item -ItemType Directory -Force -Path $backupDir | Out-Null\r\n`
    + `$backupMain = Join-Path $backupDir 'imcodes-node.exe'\r\n`
    + `Copy-Item -Force -LiteralPath $nodePath -Destination $backupMain\r\n`
    + `$mainSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath).Hash.ToLowerInvariant()\r\n`
    + `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupMain).Hash.ToLowerInvariant() -ne $mainSha) { throw 'legacy upgrade rescue main backup verification failed' }\r\n`
    + `$manifestPath = Join-Path $nodeDir 'imcodes-node.exe.manifest.json'\r\n`
    + `$hadManifest = Test-Path -LiteralPath $manifestPath\r\n`
    + `$manifestSha = $null\r\n`
    + `if ($hadManifest) {\r\n`
    + `  $backupManifest = Join-Path $backupDir 'imcodes-node.exe.manifest.json'\r\n`
    + `  Copy-Item -Force -LiteralPath $manifestPath -Destination $backupManifest\r\n`
    + `  $manifestSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()\r\n`
    + `  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupManifest).Hash.ToLowerInvariant() -ne $manifestSha) { throw 'legacy upgrade rescue manifest backup verification failed' }\r\n`
    + `}\r\n`
    + `$helperPath = Join-Path $nodeDir 'computer-use-helper'\r\n`
    + `$hadHelper = Test-Path -LiteralPath $helperPath\r\n`
    + `$helperFiles = @()\r\n`
    + `if ($hadHelper) {\r\n`
    + `  $backupHelper = Join-Path $backupDir 'computer-use-helper'\r\n`
    + `  Copy-Item -Recurse -Force -LiteralPath $helperPath -Destination $backupHelper\r\n`
    + `  $helperRoot = (Get-Item -LiteralPath $helperPath).FullName.TrimEnd('\\') + '\\'\r\n`
    + `  foreach ($file in @(Get-ChildItem -LiteralPath $helperPath -Recurse -File | Sort-Object FullName)) {\r\n`
    + `    $relative = $file.FullName.Substring($helperRoot.Length)\r\n`
    + `    $sourceSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()\r\n`
    + `    $backupFile = Join-Path $backupHelper $relative\r\n`
    + `    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupFile).Hash.ToLowerInvariant() -ne $sourceSha) { throw 'legacy upgrade rescue helper backup verification failed' }\r\n`
    + `    $helperFiles += @{ path = $relative; sha256 = $sourceSha }\r\n`
    + `  }\r\n`
    + `}\r\n`
    + `$rescueScriptPath = Join-Path $rescueRoot 'rescue.ps1'\r\n`
    + `[IO.File]::WriteAllBytes($rescueScriptPath, [Convert]::FromBase64String(${psSingleQuote(rescueScriptBase64)}))\r\n`
    + `$icacls = Join-Path $env:SystemRoot 'System32\\icacls.exe'\r\n`
    + `foreach ($aclArguments in @(@('/grant:r','*S-1-5-18:(OI)(CI)F'),@('/grant:r','*S-1-5-32-544:(OI)(CI)F'),@('/inheritance:r'),@('/setowner','*S-1-5-18'))) { & $icacls $rescueRoot @aclArguments | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'legacy upgrade rescue ACL hardening failed' } }\r\n`
    + `$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'\r\n`
    + `$action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $rescueScriptPath)\r\n`
    + `$minuteTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)\r\n`
    + `$bootTrigger = New-ScheduledTaskTrigger -AtStartup\r\n`
    + `$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable\r\n`
    + `Register-ScheduledTask -TaskName $rescueTask -Action $action -Trigger @($minuteTrigger, $bootTrigger) -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null\r\n`
    + `$registered = Get-ScheduledTask -TaskName $rescueTask\r\n`
    + `if (-not $registered -or -not $registered.Settings.Enabled -or @($registered.Actions).Count -ne 1 -or [string]$registered.Actions[0].Execute -ne $powershell -or [string]$registered.Principal.UserId -notin @('SYSTEM','S-1-5-18')) { throw 'legacy upgrade rescue task verification failed' }\r\n`
    + `$marker = @{ version = 1; rescueId = $rescueId; status = 'prepared'; preparedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); mainSha256 = $mainSha; hadManifest = [bool]$hadManifest; manifestSha256 = $manifestSha; hadHelper = [bool]$hadHelper; helperFiles = $helperFiles }\r\n`
    + `$markerTmp = Join-Path $rescueRoot 'marker.json.tmp'\r\n`
    + `$markerPath = Join-Path $rescueRoot 'marker.json'\r\n`
    + `$marker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $markerTmp -Encoding UTF8\r\n`
    + `Move-Item -Force -LiteralPath $markerTmp -Destination $markerPath\r\n`
    + `Write-Output ${psSingleQuote(expectedStdout)}\r\n`;
  const encodedSetup = utf8Base64(setupScript);
  const command = `$script=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedSetup}')); & ([ScriptBlock]::Create($script))`;
  return {
    command,
    commandSha256: createHash('sha256').update(command).digest('hex'),
    expectedStdout,
  };
}
