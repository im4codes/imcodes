import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONTROLLED_NODE_SERVICE,
  CONTROLLED_NODE_WINDOWS_INSTALL_DIR,
  CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR,
  CONTROLLED_NODE_WINDOWS_RELEASE_SIGNER_ANCHOR_PREFLIGHT_FAILURE,
  CONTROLLED_NODE_WINDOWS_RELEASE_TRUST_PREFLIGHT_FAILURE,
  CONTROLLED_NODE_WINDOWS_UPGRADE_PREFLIGHT_FAILED,
  CONTROLLED_NODE_WINDOWS_UPGRADE_TASK_PREFIX,
} from '../../../shared/controlled-node-service.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
  validateRemoteDesktopWorkerManifest,
} from '../../../shared/remote-desktop-worker.js';
import {
  CONTROLLED_NODE_COMPUTER_USE_HELPER_FILENAMES,
  CONTROLLED_NODE_OS_WIN,
} from '../../../shared/controlled-node-artifacts.js';
import {
  WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT,
  WINDOWS_POWERSHELL_UTILITY_MODULE_PREFLIGHT,
} from '../../../shared/windows-powershell-modules.js';
import { buildWindowsReleasePublisherTrustScriptForVariable } from '../../../shared/windows-release-publisher-trust.js';

export const LEGACY_WINDOWS_UPGRADE_RESCUE_GRACE_MS = 11 * 60 * 1000;
export const LEGACY_WINDOWS_UPGRADE_RESCUE_EXEC_TIMEOUT_MS = 120_000;
export const LEGACY_WINDOWS_UPGRADE_RESCUE_READY_PREFIX = 'IMCODES_UPGRADE_RESCUE_READY' as const;
export const LEGACY_WINDOWS_UPGRADE_RESTART_EXEC_TIMEOUT_MS = 120_000;
export const LEGACY_WINDOWS_UPGRADE_RESTART_READY_PREFIX = 'IMCODES_UPGRADE_RESTART_READY' as const;

function psSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function utf8Base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function utf16leBase64(value: string): string {
  return Buffer.from(value, 'utf16le').toString('base64');
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const RELEASE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export async function resolveLegacyWindowsUpgradePublisherSignerSha256(
  expectedVersion: string,
  artifactDir = process.env.IMCODES_NODE_EXE_DIR,
  read: typeof readFile = readFile,
): Promise<string> {
  if (!artifactDir || !expectedVersion) throw new Error('windows_release_artifact_context_unavailable');
  const workerManifestPath = join(
    artifactDir,
    'remote-desktop-worker',
    'win32-x64',
    `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`,
  );
  const mainManifestPath = join(artifactDir, 'imcodes-node.exe.manifest.json');
  let workerRaw: unknown;
  let mainRaw: unknown;
  try {
    [workerRaw, mainRaw] = await Promise.all([
      read(workerManifestPath, 'utf8').then((value) => JSON.parse(value)),
      read(mainManifestPath, 'utf8').then((value) => JSON.parse(value)),
    ]);
  } catch {
    throw new Error('windows_release_artifact_manifest_unavailable');
  }
  const worker = validateRemoteDesktopWorkerManifest(workerRaw);
  const main = mainRaw as {
    schemaVersion?: unknown;
    artifact?: Record<string, unknown>;
    build?: Record<string, unknown>;
  } | null;
  const signer = worker?.authenticodeSignerSha256;
  if (!worker
    || worker.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION
    || worker.workerVersion !== expectedVersion
    || !signer
    || !SHA256_RE.test(signer)
    || !main
    || typeof main !== 'object'
    || main.schemaVersion !== 1
    || main.artifact?.fileName !== 'imcodes-node.exe'
    || main.artifact?.os !== 'win32'
    || main.artifact?.arch !== 'x64'
    || main.artifact?.authenticodeSignerSha256 !== signer
    || main.build?.version !== expectedVersion) {
    throw new Error('windows_release_artifact_signer_manifest_mismatch');
  }
  return signer;
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

/**
 * Build a one-shot SYSTEM task that restarts a healthy legacy node process only
 * after its prior upgrade task has disappeared. The restart clears the old
 * runtime's process-local `upgradeInFlight` latch; the independent rescue task
 * remains armed while the Server retries the ordinary artifact upgrade.
 */
export function buildLegacyWindowsUpgradeRestartCommand(
  rescueId: string,
  restartId: string,
  expectedSignerSha256: string,
): LegacyWindowsUpgradeRescueCommand {
  if (!/^[0-9a-f-]{36}$/i.test(rescueId)) throw new Error('invalid_legacy_upgrade_rescue_id');
  if (!/^[0-9a-f-]{36}$/i.test(restartId)) throw new Error('invalid_legacy_upgrade_restart_id');
  if (!SHA256_RE.test(expectedSignerSha256)) throw new Error('invalid_legacy_upgrade_release_signer');

  const restartTask = CONTROLLED_NODE_SERVICE.WINDOWS_LEGACY_UPGRADE_RESTART_TASK;
  const restartScript = `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_UTILITY_MODULE_PREFLIGHT
    + `Start-Sleep -Seconds 5\r\n`
    + `$restartTask = ${psSingleQuote(restartTask)}\r\n`
    + `$nodeDir = Join-Path $env:ProgramData ${psSingleQuote(CONTROLLED_NODE_WINDOWS_INSTALL_DIR)}\r\n`
    + `$nodePath = Join-Path $nodeDir 'imcodes-node.exe'\r\n`
    + `$mainTask = ${psSingleQuote(CONTROLLED_NODE_SERVICE.WINDOWS_TASK)}\r\n`
    + `$watchdogTask = ${psSingleQuote(CONTROLLED_NODE_SERVICE.WINDOWS_WATCHDOG_TASK)}\r\n`
    + `Stop-ScheduledTask -TaskName $mainTask -ErrorAction SilentlyContinue\r\n`
    + `Get-CimInstance Win32_Process -Filter \"Name='imcodes-node.exe'\" -ErrorAction SilentlyContinue | Where-Object { [string]::Equals([string]$_.ExecutablePath, $nodePath, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--computer-use-helper' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\r\n`
    + `Start-Sleep -Seconds 2\r\n`
    + `Enable-ScheduledTask -TaskName $mainTask -ErrorAction SilentlyContinue | Out-Null\r\n`
    + `Enable-ScheduledTask -TaskName $watchdogTask -ErrorAction SilentlyContinue | Out-Null\r\n`
    + `Start-ScheduledTask -TaskName $mainTask\r\n`
    + `Unregister-ScheduledTask -TaskName $restartTask -Confirm:$false -ErrorAction SilentlyContinue\r\n`;
  const restartScriptBase64 = utf16leBase64(restartScript);
  const publisherTrustScript = buildWindowsReleasePublisherTrustScriptForVariable(
    'workerPath',
    expectedSignerSha256,
  );
  const expectedStdout = `${LEGACY_WINDOWS_UPGRADE_RESTART_READY_PREFIX}:${restartId}`;
  const setupScript = `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_UTILITY_MODULE_PREFLIGHT
    + WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT
    + `$nodeDir = Join-Path $env:ProgramData ${psSingleQuote(CONTROLLED_NODE_WINDOWS_INSTALL_DIR)}\r\n`
    + `$nodePath = Join-Path $nodeDir 'imcodes-node.exe'\r\n`
    + `$rescueRoot = Join-Path $env:ProgramData ${psSingleQuote(CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR)}\r\n`
    + `$markerPath = Join-Path $rescueRoot 'marker.json'\r\n`
    + `if (-not (Test-Path -LiteralPath $markerPath)) { throw 'legacy upgrade restart rescue marker missing' }\r\n`
    + `$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json\r\n`
    + `if ([string]$marker.status -cne 'prepared' -or [string]$marker.rescueId -cne ${psSingleQuote(rescueId)}) { throw 'legacy upgrade restart rescue marker mismatch' }\r\n`
    + `$process = Get-CimInstance Win32_Process -Filter \"Name='imcodes-node.exe'\" -ErrorAction SilentlyContinue | Where-Object { [string]::Equals([string]$_.ExecutablePath, $nodePath, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--computer-use-helper' } | Select-Object -First 1\r\n`
    + `if (-not $process) { throw 'legacy upgrade restart source process missing' }\r\n`
    + `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $nodePath).Hash.ToLowerInvariant() -cne [string]$marker.mainSha256) { throw 'legacy upgrade restart source main hash mismatch' }\r\n`
    + `$upgradePrefix = ${psSingleQuote(CONTROLLED_NODE_WINDOWS_UPGRADE_TASK_PREFIX)}\r\n`
    + `$rescueTask = ${psSingleQuote(CONTROLLED_NODE_SERVICE.WINDOWS_LEGACY_UPGRADE_RESCUE_TASK)}\r\n`
    + `$restartTask = ${psSingleQuote(restartTask)}\r\n`
    + `$otherUpgradeTasks = @(Get-ScheduledTask -TaskName ($upgradePrefix + '*') -ErrorAction Stop | Where-Object { $_.TaskName.StartsWith($upgradePrefix, [StringComparison]::OrdinalIgnoreCase) -and $_.TaskName -notin @($rescueTask, $restartTask) })\r\n`
    + `if ($otherUpgradeTasks.Count -gt 0) { throw 'legacy upgrade task still registered' }\r\n`
    + `$stagedWorker = $null\r\n`
    + `$scheduledMode = $null\r\n`
    + `$patchedUpgradeTask = $null\r\n`
    + `$patchedUpgradeScriptPath = $null\r\n`
    + `$expectedSigner = ${psSingleQuote(expectedSignerSha256)}\r\n`
    + `$verifySignedArtifact = { param([string]$artifactPath)\r\n`
    + `  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) { throw 'legacy upgrade signed artifact is missing' }\r\n`
    + `  $artifactSignature = Get-AuthenticodeSignature -LiteralPath $artifactPath\r\n`
    + `  if ($artifactSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $artifactSignature.SignerCertificate) { throw 'legacy upgrade artifact Authenticode verification failed' }\r\n`
    + `  $artifactSha256 = [System.Security.Cryptography.SHA256]::Create(); try { $artifactSigner = [BitConverter]::ToString($artifactSha256.ComputeHash($artifactSignature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $artifactSha256.Dispose() }\r\n`
    + `  if ($artifactSigner -cne $expectedSigner) { throw 'legacy upgrade artifact signer mismatch' }\r\n`
    + `}\r\n`
    + `$tempRoots = @($env:TEMP, $env:TMP, [IO.Path]::GetTempPath(), (Join-Path $env:SystemRoot 'Temp')) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | ForEach-Object { (Get-Item -LiteralPath $_ -Force).FullName } | Sort-Object -Unique\r\n`
    + `$upgradeCandidates = @($tempRoots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Directory -Filter ($upgradePrefix + '*') -ErrorAction Stop | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } }) | Sort-Object LastWriteTimeUtc -Descending\r\n`
    + `foreach ($candidate in $upgradeCandidates) {\r\n`
    + `  $resultPath = Join-Path $candidate.FullName 'imcodes-node.exe.upgrade-result.json'\r\n`
    + `  $workerDir = Join-Path $candidate.FullName 'remote-desktop-worker\\win32-x64'\r\n`
    + `  $workerPath = Join-Path $workerDir ${psSingleQuote(REMOTE_DESKTOP_WORKER_FILENAME)}\r\n`
    + `  $workerManifestPath = Join-Path $workerDir ${psSingleQuote(`${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`)}\r\n`
    + `  $mainPath = Join-Path $candidate.FullName 'imcodes-node.exe'\r\n`
    + `  $mainManifestPath = Join-Path $candidate.FullName 'imcodes-node.exe.manifest.json'\r\n`
    + `  $helperPath = Join-Path $candidate.FullName ${psSingleQuote(`computer-use-helper\\win32-x64\\${CONTROLLED_NODE_COMPUTER_USE_HELPER_FILENAMES[CONTROLLED_NODE_OS_WIN]}`)}\r\n`
    + `  $helperManifestPath = "$helperPath.manifest.json"\r\n`
    + `  $upgradeScriptPath = Join-Path $candidate.FullName 'upgrade.ps1'\r\n`
    + `  if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf) -or -not (Test-Path -LiteralPath $workerPath -PathType Leaf) -or -not (Test-Path -LiteralPath $workerManifestPath -PathType Leaf)) { continue }\r\n`
    + `  try {\r\n`
    + `    $candidateItem = Get-Item -LiteralPath $candidate.FullName -Force\r\n`
    + `    $candidateAcl = Get-Acl -LiteralPath $candidateItem.FullName -ErrorAction Stop\r\n`
    + `    $candidateOwnerSid = $candidateAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value\r\n`
    + `    if (-not $candidateItem.PSIsContainer -or ($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $candidateOwnerSid -notin @('S-1-5-18','S-1-5-32-544')) { continue }\r\n`
    + `    $workerDirItem = Get-Item -LiteralPath $workerDir -Force\r\n`
    + `    $resultItem = Get-Item -LiteralPath $resultPath -Force\r\n`
    + `    $workerItem = Get-Item -LiteralPath $workerPath -Force\r\n`
    + `    $workerManifestItem = Get-Item -LiteralPath $workerManifestPath -Force\r\n`
    + `    if (-not $workerDirItem.PSIsContainer -or ($workerDirItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($resultItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($workerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($workerManifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }\r\n`
    + `    $upgradeResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json\r\n`
    + `    $failureReason = [string]$upgradeResult.reason\r\n`
    + `    if ([string]$upgradeResult.status -cne ${psSingleQuote(CONTROLLED_NODE_WINDOWS_UPGRADE_PREFLIGHT_FAILED)} -or $failureReason -cnotin @(${psSingleQuote(CONTROLLED_NODE_WINDOWS_RELEASE_TRUST_PREFLIGHT_FAILURE)},${psSingleQuote(CONTROLLED_NODE_WINDOWS_RELEASE_SIGNER_ANCHOR_PREFLIGHT_FAILURE)})) { continue }\r\n`
    + `    $workerManifest = Get-Content -LiteralPath $workerManifestPath -Raw | ConvertFrom-Json\r\n`
    + `    $candidateVersion = [string]$workerManifest.workerVersion\r\n`
    + `    if ($candidateVersion -notmatch ${psSingleQuote(RELEASE_VERSION_RE.source)} -or [int]$workerManifest.protocolVersion -notin @(${REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION},${REMOTE_DESKTOP_PROTOCOL_VERSION}) -or [string]$workerManifest.os -cne 'win32' -or [string]$workerManifest.arch -cne 'x64' -or [string]$workerManifest.fileName -cne ${psSingleQuote(REMOTE_DESKTOP_WORKER_FILENAME)} -or [string]$workerManifest.authenticodeSignerSha256 -cne $expectedSigner -or [int64]$workerManifest.size -ne [int64]$workerItem.Length -or [string]$workerManifest.sha256 -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $workerPath).Hash.ToLowerInvariant()) { continue }\r\n`
    + publisherTrustScript
    + `    & $verifySignedArtifact $workerPath\r\n`
    + `    if ($failureReason -ceq ${psSingleQuote(CONTROLLED_NODE_WINDOWS_RELEASE_TRUST_PREFLIGHT_FAILURE)}) { $stagedWorker = $workerPath; $scheduledMode = 'restart'; break }\r\n`
    + `    foreach ($requiredPath in @($mainPath,$mainManifestPath,$helperPath,$helperManifestPath,$upgradeScriptPath)) { if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw 'legacy upgrade bridge artifact set is incomplete' } }\r\n`
    + `    $protectedItems = @($mainPath,$mainManifestPath,$helperPath,$helperManifestPath,$upgradeScriptPath) | ForEach-Object { Get-Item -LiteralPath $_ -Force }\r\n`
    + `    foreach ($protectedItem in $protectedItems) { $protectedOwner = (Get-Acl -LiteralPath $protectedItem.FullName -ErrorAction Stop).GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if (($protectedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $protectedOwner -notin @('S-1-5-18','S-1-5-32-544')) { throw 'legacy upgrade bridge artifact ownership mismatch' } }\r\n`
    + `    $mainManifest = Get-Content -LiteralPath $mainManifestPath -Raw | ConvertFrom-Json\r\n`
    + `    if ([int]$mainManifest.schemaVersion -ne 1 -or [string]$mainManifest.artifact.fileName -cne 'imcodes-node.exe' -or [string]$mainManifest.artifact.os -cne 'win32' -or [string]$mainManifest.artifact.arch -cne 'x64' -or [int64]$mainManifest.artifact.size -ne (Get-Item -LiteralPath $mainPath).Length -or [string]$mainManifest.artifact.sha256 -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $mainPath).Hash.ToLowerInvariant() -or [string]$mainManifest.build.version -cne $candidateVersion) { throw 'legacy upgrade bridge main manifest mismatch' }\r\n`
    + `    $helperManifest = Get-Content -LiteralPath $helperManifestPath -Raw | ConvertFrom-Json\r\n`
    + `    if ([int]$helperManifest.schemaVersion -ne 1 -or [string]$helperManifest.artifact.fileName -cne ${psSingleQuote(CONTROLLED_NODE_COMPUTER_USE_HELPER_FILENAMES[CONTROLLED_NODE_OS_WIN])} -or [string]$helperManifest.artifact.os -cne 'win32' -or [string]$helperManifest.artifact.arch -cne 'x64' -or [int64]$helperManifest.artifact.size -ne (Get-Item -LiteralPath $helperPath).Length -or [string]$helperManifest.artifact.sha256 -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $helperPath).Hash.ToLowerInvariant()) { throw 'legacy upgrade bridge helper manifest mismatch' }\r\n`
    + `    & $verifySignedArtifact $mainPath\r\n`
    + `    & $verifySignedArtifact $helperPath\r\n`
    + `    $upgradeScript = Get-Content -LiteralPath $upgradeScriptPath -Raw\r\n`
    + `    $anchorPattern = 'if \\(\\$srcRemoteDesktopSignerSha256 -cne ''([a-f0-9]{64})''\\) \\{ throw ''remote desktop worker signer is not trusted by this controlled node build'' \\}'\r\n`
    + `    $anchorMatches = [regex]::Matches($upgradeScript, $anchorPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)\r\n`
    + `    if ($anchorMatches.Count -ne 1) { throw 'legacy upgrade bridge signer guard shape mismatch' }\r\n`
    + `    $legacySigner = $anchorMatches[0].Groups[1].Value\r\n`
    + `    if ($legacySigner -ceq $expectedSigner -or [regex]::Matches($upgradeScript, [regex]::Escape($legacySigner)).Count -ne 1) { throw 'legacy upgrade bridge signer replacement is ambiguous' }\r\n`
    + `    $replacementGuard = $anchorMatches[0].Value.Replace($legacySigner, $expectedSigner)\r\n`
    + `    $patchedUpgradeScript = $upgradeScript.Remove($anchorMatches[0].Index, $anchorMatches[0].Length).Insert($anchorMatches[0].Index, $replacementGuard)\r\n`
    + `    $taskPattern = 'Unregister-ScheduledTask -TaskName ''(imcodes-node-upgrade-[0-9a-f-]{36})'' -Confirm:\\$false -ErrorAction SilentlyContinue'\r\n`
    + `    $taskNames = @([regex]::Matches($upgradeScript, $taskPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)\r\n`
    + `    if ($taskNames.Count -ne 1 -or $taskNames[0] -in @($rescueTask,$restartTask)) { throw 'legacy upgrade bridge task identity mismatch' }\r\n`
    + `    $patchedUpgradeTask = $taskNames[0]\r\n`
    + `    $patchedUpgradeScriptPath = Join-Path $rescueRoot ('upgrade-bridge-' + ${psSingleQuote(restartId)} + '.ps1')\r\n`
    + `    [IO.File]::WriteAllText($patchedUpgradeScriptPath, $patchedUpgradeScript, (New-Object Text.UTF8Encoding($false)))\r\n`
    + `    $patchedReadback = Get-Content -LiteralPath $patchedUpgradeScriptPath -Raw\r\n`
    + `    $patchedMatches = [regex]::Matches($patchedReadback, $anchorPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)\r\n`
    + `    if ($patchedMatches.Count -ne 1 -or $patchedMatches[0].Groups[1].Value -cne $expectedSigner -or $patchedReadback.Contains($legacySigner)) { throw 'legacy upgrade bridge patched script verification failed' }\r\n`
    + `    $stagedWorker = $workerPath\r\n`
    + `    $scheduledMode = 'upgrade'\r\n`
    + `    break\r\n`
    + `  } catch { continue }\r\n`
    + `}\r\n`
    + `if (-not $stagedWorker -or $scheduledMode -notin @('restart','upgrade')) { throw 'legacy upgrade signed staging evidence missing' }\r\n`
    + `Stop-ScheduledTask -TaskName $restartTask -ErrorAction SilentlyContinue\r\n`
    + `Unregister-ScheduledTask -TaskName $restartTask -Confirm:$false -ErrorAction SilentlyContinue\r\n`
    + `$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'\r\n`
    + `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)\r\n`
    + `if ($scheduledMode -ceq 'upgrade') {\r\n`
    + `  $action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $patchedUpgradeScriptPath)\r\n`
    + `  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable\r\n`
    + `  $settings.AllowHardTerminate = $false\r\n`
    + `  Register-ScheduledTask -TaskName $patchedUpgradeTask -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null\r\n`
    + `  $registered = Get-ScheduledTask -TaskName $patchedUpgradeTask\r\n`
    + `  if (-not $registered -or -not $registered.Settings.Enabled -or [bool]$registered.Settings.AllowHardTerminate -or @($registered.Actions).Count -ne 1 -or [string]$registered.Actions[0].Execute -ne $powershell -or [string]$registered.Principal.UserId -notin @('SYSTEM','S-1-5-18')) { throw 'legacy upgrade bridge task verification failed' }\r\n`
    + `  Start-ScheduledTask -TaskName $patchedUpgradeTask\r\n`
    + `} else {\r\n`
    + `  $action = New-ScheduledTaskAction -Execute $powershell -Argument ${psSingleQuote(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${restartScriptBase64}`)}\r\n`
    + `  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable\r\n`
    + `  Register-ScheduledTask -TaskName $restartTask -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null\r\n`
    + `  $registered = Get-ScheduledTask -TaskName $restartTask\r\n`
    + `  if (-not $registered -or -not $registered.Settings.Enabled -or @($registered.Actions).Count -ne 1 -or [string]$registered.Actions[0].Execute -ne $powershell -or [string]$registered.Principal.UserId -notin @('SYSTEM','S-1-5-18')) { throw 'legacy upgrade restart task verification failed' }\r\n`
    + `  Start-ScheduledTask -TaskName $restartTask\r\n`
    + `}\r\n`
    + `Write-Output ${psSingleQuote(expectedStdout)}\r\n`;
  const encodedSetup = utf8Base64(setupScript);
  const command = `$script=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedSetup}')); & ([ScriptBlock]::Create($script))`;
  return {
    command,
    commandSha256: createHash('sha256').update(command).digest('hex'),
    expectedStdout,
  };
}
