#!/usr/bin/env node
/**
 * Build Windows Desktop 3-in-1 Inno Setup `.iss` / `.exe` installer + PowerShell Phase A probe/rollback helper.
 *
 * Uses `scripts/windows-sign-release-artifact.ps1` (`IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT`)
 * when compiling an `.exe` with `ISCC.exe`, and generates deterministic `.iss` + `.ps1` + `.cmd`
 * artifacts even on non-Windows hosts or Windows machines without Inno Setup installed.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parseDaemonRuntimeTarget } from './daemon-runtime-artifacts.mjs';
import {
  loadDesktopCompatibilityModule,
  REPO_ROOT,
  resolveDesktopInstallerVersion,
  stageDaemonRuntimePayload,
  writeDesktopInstallerManifest,
} from './desktop-installer-shared.mjs';

export function renderWindowsPhaseAInstallerPs1({ version, cliWrapperContent }) {
  const wrapperB64 = Buffer.from(cliWrapperContent, 'utf8').toString('base64');
  return `param(
  [ValidateSet('Probe', 'Plan', 'PostInstall', 'CleanupTmp', 'Rollback')]
  [string]$Mode = 'Plan',

  [string]$Version = ${JSON.stringify(version)},
  [string]$IsolatedRoot = '',
  [string]$HomeDir = '',
  [string]$RuntimeRoot = '',
  [string]$NodeRoot = '',
  [string]$CliWrapperPath = '',
  [string]$AutostartPath = '',
  [string]$SnapshotDir = '',
  [string]$StagedCliWrapper = '',
  [string]$MinimumRuntimeVersion = '',
  [int]$TempMaxAgeHours = 24,
  [switch]$ForceTakeover,
  [switch]$AllowSystemRoot
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
  return [System.IO.Path]::GetFullPath($PathValue).TrimEnd('\\').ToLowerInvariant()
}

function Assert-SafeTargetPath([string]$TargetPath, [string]$RealHome) {
  if ($AllowSystemRoot) { return }
  $norm = Get-NormalizedPath $TargetPath
  $forbidden = @(
    'c:\\programdata\\imcodes-node',
    'c:\\program files\\im.codes'
  )
  if (-not [string]::IsNullOrWhiteSpace($RealHome)) {
    $homeNorm = Get-NormalizedPath $RealHome
    $forbidden += @(
      "$homeNorm\\.imcodes",
      "$homeNorm\\appdata\\local\\imcodes",
      "$homeNorm\\appdata\\roaming\\microsoft\\windows\\start menu"
    )
    if ($norm -eq $homeNorm) {
      throw "unsafe_installer_target_inside_system_root: $TargetPath"
    }
  }
  foreach ($f in $forbidden) {
    if ($norm -eq $f -or $norm.StartsWith($f + '\\')) {
      throw "unsafe_installer_target_inside_system_root: $TargetPath"
    }
  }
}

$RealProfile = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($HomeDir)) {
  $HomeDir = $RealProfile
}

if (-not [string]::IsNullOrWhiteSpace($IsolatedRoot)) {
  Assert-SafeTargetPath $IsolatedRoot $RealProfile
  if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = Join-Path $IsolatedRoot 'daemon-runtime' }
  if ([string]::IsNullOrWhiteSpace($NodeRoot)) { $NodeRoot = Join-Path $IsolatedRoot 'controlled-node' }
  if ([string]::IsNullOrWhiteSpace($CliWrapperPath)) { $CliWrapperPath = Join-Path $IsolatedRoot 'bin\\imcodes.cmd' }
  if ([string]::IsNullOrWhiteSpace($SnapshotDir)) { $SnapshotDir = Join-Path $IsolatedRoot 'rollback-snapshot' }
  if ([string]::IsNullOrWhiteSpace($AutostartPath)) {
    $AutostartPath = Join-Path $HomeDir 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\imcodes-daemon.cmd'
  }
} else {
  if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = 'C:\\Program Files\\IM.codes\\daemon-runtime' }
  if ([string]::IsNullOrWhiteSpace($NodeRoot)) { $NodeRoot = 'C:\\ProgramData\\imcodes-node' }
  if ([string]::IsNullOrWhiteSpace($CliWrapperPath)) {
    $localApp = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HomeDir 'AppData\\Local' }
    $CliWrapperPath = Join-Path $localApp 'imcodes\\bin\\imcodes.cmd'
  }
  if ([string]::IsNullOrWhiteSpace($SnapshotDir)) { $SnapshotDir = Join-Path $NodeRoot ("installer-rollback-" + $Version) }
  if ([string]::IsNullOrWhiteSpace($AutostartPath)) {
    $AutostartPath = Join-Path $HomeDir 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\imcodes-daemon.cmd'
  }
}

$UserStateDir = Join-Path $HomeDir '.imcodes'
$ReleaseDir = Join-Path (Join-Path $RuntimeRoot 'releases') $Version
$CurrentDir = Join-Path $RuntimeRoot 'current'

function Test-PathLooksFilesystem([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.StartsWith('-')) { return $false }
  return ($Value -match '^[A-Za-z]:[/\\\\]' -or $Value.StartsWith('\\\\') -or $Value.StartsWith('/') -or $Value.StartsWith('.\\') -or $Value.StartsWith('..\\'))
}

function Test-InsideGitCheckout([string]$CandidatePath) {
  if (-not (Test-PathLooksFilesystem $CandidatePath)) { return $false }
  $resolved = $CandidatePath
  try {
    $item = Get-Item -LiteralPath $CandidatePath -Force -ErrorAction SilentlyContinue
    if ($item -and $item.Target) {
      $resolved = [string]$item.Target[0]
    }
  } catch {}
  $dir = $resolved
  try {
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
      $dir = Split-Path -Parent $resolved
    }
  } catch {
    $dir = Split-Path -Parent $resolved
  }
  for ($i = 0; $i -lt 12; $i++) {
    if ([string]::IsNullOrWhiteSpace($dir)) { break }
    if (Test-Path -LiteralPath (Join-Path $dir '.git')) { return $true }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir) { break }
    $dir = $parent
  }
  return $false
}

function Test-SafeExpiredTempName([string]$FileName) {
  $lower = $FileName.ToLowerInvariant()
  if (@('server.json', 'credential.json', 'install-identity.json', 'daemon.lock.json', 'daemon.pid') -contains $lower) {
    return $false
  }
  if ($lower.Contains('.sqlite') -or $lower.EndsWith('.db') -or $lower.EndsWith('-wal') -or $lower.EndsWith('-shm')) {
    return $false
  }
  return ($lower.EndsWith('.tmp') -or $lower.Contains('.tmp.') -or $lower.StartsWith('.staging-') -or $lower.StartsWith('.partial-') -or $lower.EndsWith('.partial'))
}

function Get-FileSha256Hex([string]$PathValue) {
  $bytes = [System.IO.File]::ReadAllBytes($PathValue)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Invoke-PhaseAProbe {
  $credPath = Join-Path $NodeRoot 'credential.json'
  $hasCred = Test-Path -LiteralPath $credPath -PathType Leaf
  $validCred = $false
  if ($hasCred) {
    try {
      $credObj = Get-Content -LiteralPath $credPath -Raw | ConvertFrom-Json
      if ($credObj.nodeId -and $credObj.token) { $validCred = $true }
    } catch {}
  }

  $serverJsonPath = Join-Path $UserStateDir 'server.json'
  $hasServerJson = Test-Path -LiteralPath $serverJsonPath -PathType Leaf
  $validServerJson = $false
  if ($hasServerJson) {
    try {
      $srvObj = Get-Content -LiteralPath $serverJsonPath -Raw | ConvertFrom-Json
      if ($srvObj.serverId -and $srvObj.workerUrl -and $srvObj.token) { $validServerJson = $true }
    } catch {}
  }

  $sqliteFiles = @()
  if (Test-Path -LiteralPath $UserStateDir -PathType Container) {
    $sqliteFiles = @(Get-ChildItem -LiteralPath $UserStateDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '\\.(sqlite|sqlite3|db)$' } |
      ForEach-Object { $_.FullName })
  }

  $lockPath = Join-Path $UserStateDir 'daemon.lock.json'
  $hasLock = Test-Path -LiteralPath $lockPath -PathType Leaf

  $cliExists = Test-Path -LiteralPath $CliWrapperPath
  $cliDev = $false
  if ($cliExists) {
    if (Test-InsideGitCheckout $CliWrapperPath) { $cliDev = $true }
    try {
      $cliText = Get-Content -LiteralPath $CliWrapperPath -Raw -ErrorAction SilentlyContinue
      if ($cliText -match '([A-Za-z]:[/\\\\][^\\r\\n"'']+dist[/\\\\]src[/\\\\]index\\.js)') {
        if (Test-InsideGitCheckout $Matches[1]) { $cliDev = $true }
      }
    } catch {}
  }

  $hasAutostart = Test-Path -LiteralPath $AutostartPath -PathType Leaf
  $autostartDev = $false
  $isLegacyBroken = $false
  $legacyReason = ''
  if ($hasAutostart) {
    $autoText = Get-Content -LiteralPath $AutostartPath -Raw -ErrorAction SilentlyContinue
    if ($autoText -match '([A-Za-z]:[/\\\\][^\\r\\n"'']+dist[/\\\\]src[/\\\\]index\\.js)') {
      if (Test-InsideGitCheckout $Matches[1]) { $autostartDev = $true }
    }
    if ($autoText -match '-2147020576' -or $autoText -match 'broken') {
      $isLegacyBroken = $true
      $legacyReason = 'windows_legacy_broken_exit_signature'
    }
  }

  $errMarker = Join-Path $UserStateDir 'last-upgrade-error.json'
  if ((Test-Path -LiteralPath $errMarker -PathType Leaf) -and -not $autostartDev) {
    try {
      $errObj = Get-Content -LiteralPath $errMarker -Raw | ConvertFrom-Json
      if ($errObj.exitCode -eq -2147020576 -or ([string]$errObj.message).Contains('-2147020576')) {
        $isLegacyBroken = $true
        $legacyReason = 'legacy_npm_upgrade_exit_-2147020576'
      }
    } catch {}
  }

  $cutoff = (Get-Date).AddHours(-1 * [Math]::Abs($TempMaxAgeHours))
  $expiredTmp = @()
  $activeTmp = @()
  foreach ($scanRoot in @($UserStateDir, $NodeRoot, $RuntimeRoot)) {
    if (-not (Test-Path -LiteralPath $scanRoot -PathType Container)) { continue }
    foreach ($item in (Get-ChildItem -LiteralPath $scanRoot -Force -ErrorAction SilentlyContinue)) {
      if (-not (Test-SafeExpiredTempName $item.Name)) { continue }
      if ($item.LastWriteTime -lt $cutoff) {
        $expiredTmp += $item.FullName
      } else {
        $activeTmp += $item.FullName
      }
    }
  }

  $scenario = 'clean'
  if (($cliDev -or $autostartDev) -and -not $ForceTakeover) {
    $scenario = 'dev_symlink_exempt'
  } elseif ($isLegacyBroken -or ($expiredTmp.Count -gt 0 -and -not (Test-Path -LiteralPath $CurrentDir))) {
    $scenario = 'legacy_broken_takeover'
  } elseif ($hasCred -or $hasServerJson -or $sqliteFiles.Count -gt 0 -or $hasAutostart) {
    $scenario = 'partial_preserve'
  }

  $preserveCli = ($scenario -eq 'dev_symlink_exempt' -and $cliDev)
  $preserveAutostart = ($scenario -eq 'dev_symlink_exempt') -or ($scenario -eq 'partial_preserve' -and $hasAutostart)

  return [ordered]@{
    platform = 'win32'
    scenario = $scenario
    legacyReason = $legacyReason
    controlledNodeRoot = $NodeRoot
    runtimeRoot = $RuntimeRoot
    userStateDir = $UserStateDir
    cliWrapperPath = $CliWrapperPath
    autostartPath = $AutostartPath
    hasValidCredential = $validCred
    hasValidServerJson = $validServerJson
    sqliteCount = $sqliteFiles.Count
    hasDaemonLock = $hasLock
    preserveDevCliLink = $preserveCli
    preserveUserDaemonAutostart = $preserveAutostart
    skipNodeReEnroll = $validCred
    expectsPendingSetupWizard = (-not $validCred)
    cleanExpiredTempArtifacts = ($expiredTmp.Count -gt 0 -and ($scenario -eq 'legacy_broken_takeover' -or $scenario -eq 'partial_preserve'))
    expiredTempPaths = $expiredTmp
    activeTempPaths = $activeTmp
    preservedCandidatePaths = @($credPath, $serverJsonPath) + $sqliteFiles
  }
}

if ($Mode -eq 'Probe' -or $Mode -eq 'Plan') {
  $res = Invoke-PhaseAProbe
  $res | ConvertTo-Json -Depth 6
  exit 0
}

if ($Mode -eq 'CleanupTmp') {
  $probe = Invoke-PhaseAProbe
  $removed = @()
  foreach ($p in $probe.expiredTempPaths) {
    Assert-SafeTargetPath $p $RealProfile
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    $removed += $p
  }
  [ordered]@{ removed = $removed; preservedActive = $probe.activeTempPaths } | ConvertTo-Json -Depth 4
  exit 0
}

if ($Mode -eq 'Rollback') {
  $manifestPath = if ($SnapshotDir.EndsWith('.json')) { $SnapshotDir } else { Join-Path $SnapshotDir 'snapshot.json' }
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Rollback snapshot not found: $manifestPath"
  }
  $snap = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $restored = 0
  $removed = 0
  foreach ($entry in $snap.entries) {
    Assert-SafeTargetPath $entry.originalPath $RealProfile
    if ($entry.kind -eq 'absent') {
      if (Test-Path -LiteralPath $entry.originalPath) {
        Remove-Item -LiteralPath $entry.originalPath -Recurse -Force
        $removed++
      }
    } elseif ($entry.kind -eq 'file') {
      $parent = Split-Path -Parent $entry.originalPath
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
      $backupAbs = Join-Path $snap.snapshotDir $entry.backupRelPath
      Copy-Item -LiteralPath $backupAbs -Destination $entry.originalPath -Force
      $restored++
    } elseif ($entry.kind -eq 'junction') {
      if (Test-Path -LiteralPath $entry.originalPath) {
        cmd /c rmdir "$($entry.originalPath)" 2>$null | Out-Null
        Remove-Item -LiteralPath $entry.originalPath -Recurse -Force -ErrorAction SilentlyContinue
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.originalPath) | Out-Null
      cmd /c mklink /J "$($entry.originalPath)" "$($entry.target)" | Out-Null
      $restored++
    }
  }
  $verified = 0
  foreach ($chk in $snap.preservedChecksums) {
    if (-not (Test-Path -LiteralPath $chk.path -PathType Leaf)) {
      throw "preserved_state_missing_during_rollback: $($chk.path)"
    }
    $actual = Get-FileSha256Hex $chk.path
    if ($actual -ne $chk.sha256) {
      throw "preserved_state_checksum_mismatch: $($chk.path)"
    }
    $verified++
  }
  [ordered]@{ restoredCount = $restored; removedCount = $removed; verifiedPreservedCount = $verified } | ConvertTo-Json -Depth 4
  exit 0
}

# PostInstall mode
$plan = Invoke-PhaseAProbe
Assert-SafeTargetPath $RuntimeRoot $RealProfile
Assert-SafeTargetPath $NodeRoot $RealProfile
Assert-SafeTargetPath $CliWrapperPath $RealProfile
Assert-SafeTargetPath $SnapshotDir $RealProfile

# 1. Snapshot before mutation
$filesDir = Join-Path $SnapshotDir 'files'
New-Item -ItemType Directory -Force -Path $filesDir | Out-Null
$entries = @()
$idx = 0
foreach ($tp in @($CliWrapperPath, $AutostartPath, $CurrentDir)) {
  if (-not (Test-Path -LiteralPath $tp)) {
    $entries += [ordered]@{ kind = 'absent'; originalPath = $tp }
    continue
  }
  $item = Get-Item -LiteralPath $tp -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    $target = if ($item.Target) { [string]$item.Target[0] } else { '' }
    $entries += [ordered]@{ kind = 'junction'; originalPath = $tp; target = $target }
  } elseif (-not $item.PSIsContainer) {
    $idx++
    $rel = Join-Path 'files' ("$idx-" + $item.Name)
    Copy-Item -LiteralPath $tp -Destination (Join-Path $SnapshotDir $rel) -Force
    $entries += [ordered]@{ kind = 'file'; originalPath = $tp; backupRelPath = $rel }
  }
}
$preserved = @()
foreach ($pp in $plan.preservedCandidatePaths) {
  if (Test-Path -LiteralPath $pp -PathType Leaf) {
    $preserved += [ordered]@{ path = $pp; sha256 = (Get-FileSha256Hex $pp) }
  }
}
$snapshotDoc = [ordered]@{
  schemaVersion = 1
  createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  platform = 'win32'
  scenario = $plan.scenario
  snapshotDir = $SnapshotDir
  entries = $entries
  preservedChecksums = $preserved
}
$snapshotDoc | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $SnapshotDir 'snapshot.json') -Encoding UTF8

# 2. Clean expired .tmp artifacts only (never lockfiles or SQLite)
if ($plan.cleanExpiredTempArtifacts) {
  foreach ($p in $plan.expiredTempPaths) {
    Assert-SafeTargetPath $p $RealProfile
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 3. Point daemon-runtime\\current to releases\\<ver> when staged
if (Test-Path -LiteralPath $ReleaseDir -PathType Container) {
  if (Test-Path -LiteralPath $CurrentDir) {
    cmd /c rmdir "$CurrentDir" 2>$null | Out-Null
    Remove-Item -LiteralPath $CurrentDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  cmd /c mklink /J "$CurrentDir" "$ReleaseDir" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Copy-Item -LiteralPath $ReleaseDir -Destination $CurrentDir -Recurse -Force
  }
}

# 4. Install imcodes.cmd thin forwarder unless dev link exempt
if (-not $plan.preserveDevCliLink) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $CliWrapperPath) | Out-Null
  if (-not [string]::IsNullOrWhiteSpace($StagedCliWrapper) -and (Test-Path -LiteralPath $StagedCliWrapper -PathType Leaf)) {
    Copy-Item -LiteralPath $StagedCliWrapper -Destination $CliWrapperPath -Force
  } else {
    $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${JSON.stringify(wrapperB64)}))
    [System.IO.File]::WriteAllText($CliWrapperPath, $decoded, [System.Text.Encoding]::ASCII)
  }
}

# 5. Write user daemon autostart script if not preserved
if (-not $plan.preserveUserDaemonAutostart) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AutostartPath) | Out-Null
  $nodeExe = Join-Path $CurrentDir 'node.exe'
  $entryJs = Join-Path $CurrentDir 'package\\dist\\src\\index.js'
  $startupCmd = "@echo off\`r\`nstart \`"\`" /min \`"$nodeExe\`" \`"$entryJs\`" start --foreground\`r\`n"
  [System.IO.File]::WriteAllText($AutostartPath, $startupCmd, [System.Text.Encoding]::ASCII)
}

$plan | Add-Member -NotePropertyName snapshotDir -NotePropertyValue $SnapshotDir -Force
$plan | ConvertTo-Json -Depth 6
`;
}

export function renderWindowsInnoSetupIss({
  version,
  arch = 'x64',
  stageDirRelative = 'stage',
  outputBaseFilename,
  hasNodeExe = false,
  hasRemoteDesktop = false,
  hasComputerUse = false,
  hasLocalUi = false,
  signToolCommand,
}) {
  const outName = outputBaseFilename ?? `imcodes-desktop-${version}-win32-${arch}`;
  const filesEntries = [
    `Source: "${stageDirRelative}\\daemon-runtime\\*"; DestDir: "{commonpf}\\IM.codes\\daemon-runtime\\releases\\${version}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    `Source: "${stageDirRelative}\\imcodes-windows-installer.ps1"; DestDir: "{app}"; Flags: ignoreversion`,
    `Source: "${stageDirRelative}\\imcodes.cmd"; DestDir: "{app}"; DestName: "imcodes.cmd.staged"; Flags: ignoreversion`,
  ];
  if (hasNodeExe) {
    filesEntries.push(
      `Source: "${stageDirRelative}\\controlled-node\\imcodes-node.exe"; DestDir: "{commonappdata}\\imcodes-node"; Flags: ignoreversion`,
    );
  }
  if (hasRemoteDesktop) {
    filesEntries.push(
      `Source: "${stageDirRelative}\\controlled-node\\remote-desktop-worker\\*"; DestDir: "{commonappdata}\\imcodes-node\\remote-desktop-worker"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    );
  }
  if (hasComputerUse) {
    filesEntries.push(
      `Source: "${stageDirRelative}\\controlled-node\\computer-use-helper\\*"; DestDir: "{commonappdata}\\imcodes-node\\computer-use-helper"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    );
  }
  if (hasLocalUi) {
    filesEntries.push(
      `Source: "${stageDirRelative}\\controlled-node\\aidesk-local-ui\\*"; DestDir: "{commonappdata}\\imcodes-node\\aidesk-local-ui"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    );
  }

  return `; IM.codes Desktop 3-in-1 Installer (Inno Setup 6)
; Supports interactive UAC install as well as /SILENT and /VERYSILENT unattended installs.

[Setup]
AppId={{B3D77D71-3F7E-498E-B784-410C26C56F1A}
AppName=aiDesk.to by IM.codes
AppVersion=${version}
AppPublisher=IM.codes
DefaultDirName={commonpf}\\IM.codes
DefaultGroupName=aiDesk.to by IM.codes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
OutputDir=output
OutputBaseFilename=${outName}
${signToolCommand ? `SignTool=${signToolCommand}` : '; Code signing runs externally via scripts/windows-sign-release-artifact.ps1 when cert is configured'}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
${filesEntries.join('\n')}

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\\imcodes-windows-installer.ps1"" -Mode PostInstall -AllowSystemRoot -Version ""${version}"" -RuntimeRoot ""{commonpf}\\IM.codes\\daemon-runtime"" -NodeRoot ""{commonappdata}\\imcodes-node"" -CliWrapperPath ""{localappdata}\\imcodes\\bin\\imcodes.cmd"" -StagedCliWrapper ""{app}\\imcodes.cmd.staged"""; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\\imcodes-windows-installer.ps1"" -Mode Rollback -AllowSystemRoot -SnapshotDir ""{commonappdata}\\imcodes-node\\installer-rollback-${version}"""; Flags: runhidden waituntilterminated; RunOnceId: "IMCodesDesktopRollback"
`;
}

export function findWindowsIsccExecutable(explicitPath) {
  if (explicitPath && existsSync(explicitPath)) return resolve(explicitPath);
  if (process.platform !== 'win32') return null;
  const candidates = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ];
  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

export async function buildWindowsInstaller(options) {
  const arch = 'x64';
  const targetInfo = parseDaemonRuntimeTarget('win32', arch);
  const version = resolveDesktopInstallerVersion(options.version);
  const outDir = resolve(options.outDir ?? join(REPO_ROOT, 'dist-node-exe', 'installers'));
  mkdirSync(outDir, { recursive: true });

  const compat = await loadDesktopCompatibilityModule();
  const cliWrapperContent = compat.renderWindowsImcodesCliWrapper();
  const ps1Content = renderWindowsPhaseAInstallerPs1({ version, cliWrapperContent });

  const workDir = options.workDir
    ? resolve(options.workDir)
    : mkdtempSync(join(tmpdir(), 'imcodes-win-installer-'));
  const cleanupWorkDir = !options.workDir && !options.keepWorkDir;

  try {
    const stageDir = join(workDir, 'stage');
    const stageRuntimeDir = join(stageDir, 'daemon-runtime');
    stageDaemonRuntimePayload({
      runtimeDir: options.runtimeDir,
      runtimeArchive: options.runtimeArchive,
      target: targetInfo.target,
      destReleaseDir: stageRuntimeDir,
    });

    const nodeStage = join(stageDir, 'controlled-node');
    mkdirSync(nodeStage, { recursive: true });
    let hasNodeExe = false;
    let hasRemoteDesktop = false;
    let hasComputerUse = false;
    let hasLocalUi = false;

    if (options.nodeExe && existsSync(options.nodeExe)) {
      cpSync(resolve(options.nodeExe), join(nodeStage, 'imcodes-node.exe'));
      hasNodeExe = true;
    }
    if (options.remoteDesktopDir && existsSync(options.remoteDesktopDir)) {
      cpSync(resolve(options.remoteDesktopDir), join(nodeStage, 'remote-desktop-worker'), {
        recursive: true,
      });
      hasRemoteDesktop = true;
    }
    if (options.computerUseDir && existsSync(options.computerUseDir)) {
      cpSync(resolve(options.computerUseDir), join(nodeStage, 'computer-use-helper'), {
        recursive: true,
      });
      hasComputerUse = true;
    }
    if (options.localUiDir && existsSync(options.localUiDir)) {
      cpSync(resolve(options.localUiDir), join(nodeStage, 'aidesk-local-ui'), {
        recursive: true,
      });
      hasLocalUi = true;
    }

    const ps1Path = join(outDir, 'imcodes-windows-installer.ps1');
    const cmdPath = join(outDir, 'imcodes.cmd');
    const issFilename = `imcodes-desktop-${version}-win32-${arch}.iss`;
    const issPath = join(outDir, issFilename);
    const stagePs1 = join(stageDir, 'imcodes-windows-installer.ps1');
    const stageCmd = join(stageDir, 'imcodes.cmd');

    writeFileSync(ps1Path, ps1Content, 'utf8');
    writeFileSync(cmdPath, cliWrapperContent, 'utf8');
    writeFileSync(stagePs1, ps1Content, 'utf8');
    writeFileSync(stageCmd, cliWrapperContent, 'utf8');

    const issContent = renderWindowsInnoSetupIss({
      version,
      arch,
      stageDirRelative: 'stage',
      outputBaseFilename: `imcodes-desktop-${version}-win32-${arch}`,
      hasNodeExe,
      hasRemoteDesktop,
      hasComputerUse,
      hasLocalUi,
    });
    const workIssPath = join(workDir, issFilename);
    writeFileSync(workIssPath, issContent, 'utf8');
    writeFileSync(issPath, issContent, 'utf8');

    const isccExe = findWindowsIsccExecutable(options.isccPath);
    let exePath;
    let signed = false;
    if (isccExe) {
      execFileSync(isccExe, [`/O${outDir}`, workIssPath], { stdio: 'inherit' });
      exePath = join(outDir, `imcodes-desktop-${version}-win32-${arch}.exe`);
      const thumbprint = options.signingThumbprint ?? process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT;
      const expectedSha256 = options.expectedSignerSha256 ?? process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256;
      if (thumbprint) {
        const signScript = join(REPO_ROOT, 'scripts', 'windows-sign-release-artifact.ps1');
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            signScript,
            '-Mode',
            'Sign',
            '-ArtifactPath',
            exePath,
            '-CodeSigningCertificateThumbprint',
            thumbprint,
          ],
          { stdio: 'inherit' },
        );
        if (expectedSha256) {
          execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              signScript,
              '-Mode',
              'Verify',
              '-ArtifactPath',
              exePath,
              '-ExpectedSignerSha256',
              expectedSha256,
            ],
            { stdio: 'inherit' },
          );
        }
        signed = true;
      }
      await writeDesktopInstallerManifest(exePath, {
        platform: 'win32',
        arch,
        format: 'exe',
        version,
        signed,
        issFilename,
      });
    } else if (options.requireIscc) {
      throw new Error('ISCC.exe not found while --require-iscc was specified');
    }

    await writeDesktopInstallerManifest(issPath, {
      platform: 'win32',
      arch,
      format: 'iss',
      version,
      hasNodeExe,
      compiledExeBuilt: Boolean(exePath),
    });

    return {
      version,
      arch,
      outDir,
      issPath,
      ps1Path,
      cmdPath,
      ...(exePath ? { exePath, signed } : {}),
    };
  } finally {
    if (cleanupWorkDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function parseCliArgs(argv) {
  const args = {
    outDir: join(REPO_ROOT, 'dist-node-exe', 'installers'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--version') args.version = argv[++i];
    else if (token === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (token === '--runtime-archive') args.runtimeArchive = argv[++i];
    else if (token === '--node-exe') args.nodeExe = argv[++i];
    else if (token === '--remote-desktop-dir') args.remoteDesktopDir = argv[++i];
    else if (token === '--computer-use-dir') args.computerUseDir = argv[++i];
    else if (token === '--local-ui-dir') args.localUiDir = argv[++i];
    else if (token === '--out-dir') args.outDir = resolve(argv[++i]);
    else if (token === '--iscc-path') args.isccPath = argv[++i];
    else if (token === '--require-iscc') args.requireIscc = true;
    else if (token === '--keep-work-dir') args.keepWorkDir = true;
    else throw new Error(`Unknown flag: ${token}`);
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('build-windows-installer.mjs');
if (isMain) {
  buildWindowsInstaller(parseCliArgs(process.argv.slice(2)))
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
