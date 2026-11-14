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

export function renderWindowsPhaseAInstallerPs1({ version, cliWrapperContent, minVersion = '' }) {
  const wrapperB64 = Buffer.from(cliWrapperContent, 'utf8').toString('base64');
  return `param(
  [ValidateSet('Probe', 'Plan', 'PreInstall', 'PostInstall', 'CleanupTmp', 'Rollback')]
  [string]$Mode = 'Plan',

  [string]$Version = ${JSON.stringify(version)},
  [string]$IsolatedRoot = '',
  [string]$HomeDir = '',
  [string]$RuntimeRoot = '',
  [string]$NodeRoot = '',
  [string]$CliWrapperPath = '',
  [string]$AutostartPath = '',
  [string]$StartMenuShortcutPath = '',
  [string]$DesktopShortcutPath = '',
  [string]$SnapshotDir = '',
  [string]$StagedCliWrapper = '',
  [string]$MinimumRuntimeVersion = ${JSON.stringify(minVersion)},
  [string]$ServiceHookScript = '',
  [string]$SchtasksExe = '',
  [string]$ProcessProbeScript = '',
  [int]$TempMaxAgeHours = 24,
  [switch]$ForceTakeover,
  [switch]$AllowSystemRoot,
  [switch]$ApplyServices
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
  return [System.IO.Path]::GetFullPath($PathValue).TrimEnd('\\').ToLowerInvariant()
}

function Normalize-WindowsReparseTarget([string]$RawTarget, [string]$LinkPath) {
  if ([string]::IsNullOrWhiteSpace($RawTarget)) { return '' }
  $t = $RawTarget.Trim()
  if ($t.StartsWith('\\??\\UNC\\', [System.StringComparison]::OrdinalIgnoreCase) -or $t.StartsWith('\\\\?\\UNC\\', [System.StringComparison]::OrdinalIgnoreCase)) {
    $t = '\\\\' + $t.Substring(8)
  } elseif ($t.StartsWith('\\??\\', [System.StringComparison]::OrdinalIgnoreCase) -or $t.StartsWith('\\\\?\\', [System.StringComparison]::OrdinalIgnoreCase)) {
    $t = $t.Substring(4)
  }
  if (-not [System.IO.Path]::IsPathRooted($t)) {
    $parent = Split-Path -Parent $LinkPath
    if ([string]::IsNullOrWhiteSpace($parent)) { return '' }
    $t = Join-Path $parent $t
  }
  return [System.IO.Path]::GetFullPath($t)
}

function Resolve-CanonicalWindowsPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
  $cur = [System.IO.Path]::GetFullPath($PathValue)
  $maxHops = 32
  $hops = 0
  while ($true) {
    $root = [System.IO.Path]::GetPathRoot($cur)
    if ([string]::IsNullOrWhiteSpace($root)) {
      return [System.IO.Path]::GetFullPath($cur).TrimEnd('\\').ToLowerInvariant()
    }
    $rel = $cur.Substring($root.Length)
    $segs = @($rel -split '[\\\\/]+' | Where-Object { -not [string]::IsNullOrEmpty($_) })
    $built = $root
    $restarted = $false
    for ($i = 0; $i -lt $segs.Length; $i++) {
      $seg = $segs[$i]
      $built = if ($built.EndsWith('\\')) { $built + $seg } else { $built + '\\' + $seg }
      $item = $null
      $isReparse = $false
      $existsEntry = $false
      try {
        $item = Get-Item -LiteralPath $built -Force -ErrorAction Stop
        $existsEntry = $true
        $isReparse = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
      } catch [System.Management.Automation.ItemNotFoundException] {
        try {
          $attrs = [System.IO.File]::GetAttributes($built)
          if ([int]$attrs -ne -1 -and ($attrs -band [System.IO.FileAttributes]::ReparsePoint)) {
            $existsEntry = $true
            $isReparse = $true
          }
        } catch {}
      } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] {
        $existsEntry = $false
      } catch {
        throw "canonical_path_unreadable: $built ($($_.Exception.Message))"
      }
      if (-not $existsEntry) {
        if ($i -lt ($segs.Length - 1)) {
          for ($j = $i + 1; $j -lt $segs.Length; $j++) {
            $built = if ($built.EndsWith('\\')) { $built + $segs[$j] } else { $built + '\\' + $segs[$j] }
          }
        }
        return [System.IO.Path]::GetFullPath($built).TrimEnd('\\').ToLowerInvariant()
      }
      if ($isReparse) {
        $hops++
        if ($hops -gt $maxHops) {
          throw "canonical_path_symlink_loop: $PathValue"
        }
        $rawTarget = ''
        if ($item) {
          try {
            if ($item.PSObject.Methods['ResolveLinkTarget']) {
              $rt = $item.ResolveLinkTarget($false)
              if ($rt) { $rawTarget = [string]$rt.FullName }
            }
          } catch {}
          if ([string]::IsNullOrWhiteSpace($rawTarget) -and $item.Target) {
            $rawTarget = if ($item.Target -is [System.Array]) { [string]$item.Target[0] } else { [string]$item.Target }
          }
        }
        $nextBase = Normalize-WindowsReparseTarget $rawTarget $built
        if ([string]::IsNullOrWhiteSpace($nextBase)) {
          throw "canonical_path_unresolvable_reparse: $built"
        }
        $nextFull = $nextBase
        if ($i -lt ($segs.Length - 1)) {
          for ($j = $i + 1; $j -lt $segs.Length; $j++) {
            $nextFull = Join-Path $nextFull $segs[$j]
          }
        }
        $cur = [System.IO.Path]::GetFullPath($nextFull)
        $restarted = $true
        break
      }
    }
    if (-not $restarted) {
      return [System.IO.Path]::GetFullPath($built).TrimEnd('\\').ToLowerInvariant()
    }
  }
}

function Test-SameOrChildWindowsPath([string]$Candidate, [string]$Parent) {
  if ([string]::IsNullOrWhiteSpace($Parent)) { return $false }
  if ($Candidate -eq $Parent) { return $true }
  return $Candidate.StartsWith($Parent + '\\')
}

function Assert-SafeTargetPath([string]$TargetPath, [string]$RealHome, [switch]$EntryMode) {
  if (-not [string]::IsNullOrWhiteSpace($IsolatedRoot) -and $AllowSystemRoot) {
    throw 'unsafe_allow_system_root_with_isolated_root'
  }
  if ($AllowSystemRoot -and [string]::IsNullOrWhiteSpace($IsolatedRoot)) { return }
  $fullPath = [System.IO.Path]::GetFullPath($TargetPath)
  $canonPath = if ($EntryMode) {
    $parentFull = Split-Path -Parent $fullPath
    $leaf = Split-Path -Leaf $fullPath
    if ([string]::IsNullOrWhiteSpace($parentFull)) {
      $fullPath.TrimEnd('\\').ToLowerInvariant()
    } else {
      $canonParent = Resolve-CanonicalWindowsPath $parentFull
      (Join-Path $canonParent $leaf).TrimEnd('\\').ToLowerInvariant()
    }
  } else {
    Resolve-CanonicalWindowsPath $TargetPath
  }
  $checks = @(
    (Get-NormalizedPath $TargetPath),
    $canonPath
  )
  $forbidden = @(
    'c:\\programdata\\imcodes-node',
    'c:\\program files\\im.codes'
  )
  if (-not [string]::IsNullOrWhiteSpace($RealHome)) {
    $homeNorm = Get-NormalizedPath $RealHome
    $homeCanon = Resolve-CanonicalWindowsPath $RealHome
    foreach ($hn in @($homeNorm, $homeCanon) | Select-Object -Unique) {
      if ([string]::IsNullOrWhiteSpace($hn)) { continue }
      $forbidden += @(
        "$hn\\.imcodes",
        "$hn\\appdata\\local\\imcodes",
        "$hn\\appdata\\roaming\\microsoft\\windows\\start menu",
        "$hn\\desktop"
      )
      foreach ($c in $checks) {
        if ($c -eq $hn) { throw "unsafe_installer_target_inside_system_root: $TargetPath" }
      }
    }
  }
  foreach ($c in $checks) {
    foreach ($f in $forbidden) {
      if (Test-SameOrChildWindowsPath $c $f) {
        throw "unsafe_installer_target_inside_system_root: $TargetPath"
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($IsolatedRoot)) {
      $isoNorm = Get-NormalizedPath $IsolatedRoot
      $isoCanon = Resolve-CanonicalWindowsPath $IsolatedRoot
      $homeNormBound = if (-not [string]::IsNullOrWhiteSpace($HomeDir)) { Get-NormalizedPath $HomeDir } else { '' }
      $homeCanonBound = if (-not [string]::IsNullOrWhiteSpace($HomeDir)) { Resolve-CanonicalWindowsPath $HomeDir } else { '' }
      $inIso = (Test-SameOrChildWindowsPath $c $isoNorm) -and (Test-SameOrChildWindowsPath $c $isoCanon)
      $inHome = (-not [string]::IsNullOrWhiteSpace($homeNormBound)) -and (Test-SameOrChildWindowsPath $c $homeNormBound) -and (Test-SameOrChildWindowsPath $c $homeCanonBound)
      if (-not $inIso -and -not $inHome) {
        throw "unsafe_installer_target_outside_isolated_root: $TargetPath"
      }
    }
  }
}

$RealProfile = $env:USERPROFILE
if (-not [string]::IsNullOrWhiteSpace($IsolatedRoot)) {
  if ($AllowSystemRoot) { throw 'unsafe_allow_system_root_with_isolated_root' }
  if ([string]::IsNullOrWhiteSpace($HomeDir)) {
    $HomeDir = Join-Path $IsolatedRoot 'home'
  }
  Assert-SafeTargetPath $IsolatedRoot $RealProfile
  Assert-SafeTargetPath $HomeDir $RealProfile
  if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { $RuntimeRoot = Join-Path $IsolatedRoot 'daemon-runtime' }
  if ([string]::IsNullOrWhiteSpace($NodeRoot)) { $NodeRoot = Join-Path $IsolatedRoot 'controlled-node' }
  if ([string]::IsNullOrWhiteSpace($CliWrapperPath)) { $CliWrapperPath = Join-Path $IsolatedRoot 'bin\\imcodes.cmd' }
  if ([string]::IsNullOrWhiteSpace($SnapshotDir)) { $SnapshotDir = Join-Path $IsolatedRoot 'rollback-snapshot' }
  if ([string]::IsNullOrWhiteSpace($AutostartPath)) {
    $AutostartPath = Join-Path $HomeDir 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\imcodes-daemon.cmd'
  }
  if ([string]::IsNullOrWhiteSpace($StartMenuShortcutPath)) {
    $StartMenuShortcutPath = Join-Path $HomeDir 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\aiDesk.to by IM.codes.lnk'
  }
  if ([string]::IsNullOrWhiteSpace($DesktopShortcutPath)) {
    $DesktopShortcutPath = Join-Path $HomeDir 'Desktop\\aiDesk.to by IM.codes.lnk'
  }
} else {
  if ([string]::IsNullOrWhiteSpace($HomeDir)) { $HomeDir = $RealProfile }
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
  if ([string]::IsNullOrWhiteSpace($StartMenuShortcutPath)) {
    $StartMenuShortcutPath = Join-Path $HomeDir 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\aiDesk.to by IM.codes.lnk'
  }
  if ([string]::IsNullOrWhiteSpace($DesktopShortcutPath)) {
    $DesktopShortcutPath = Join-Path $HomeDir 'Desktop\\aiDesk.to by IM.codes.lnk'
  }
}

$UserStateDir = Join-Path $HomeDir '.imcodes'
$ReleaseDir = Join-Path (Join-Path $RuntimeRoot 'releases') $Version
$CurrentDir = Join-Path $RuntimeRoot 'current'

foreach ($tp in @($RuntimeRoot, $NodeRoot, $SnapshotDir, $UserStateDir, $ReleaseDir)) {
  Assert-SafeTargetPath $tp $RealProfile
}
foreach ($ep in @($CliWrapperPath, $AutostartPath, $StartMenuShortcutPath, $DesktopShortcutPath, $CurrentDir)) {
  Assert-SafeTargetPath $ep $RealProfile -EntryMode
}

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

function Compare-SimpleVersions([string]$Left, [string]$Right) {
  $la = ($Left.TrimStart('v').Split('-')[0].Split('.') | ForEach-Object { $n = 0; [void][int]::TryParse($_, [ref]$n); $n })
  $ra = ($Right.TrimStart('v').Split('-')[0].Split('.') | ForEach-Object { $n = 0; [void][int]::TryParse($_, [ref]$n); $n })
  $len = [Math]::Max($la.Count, $ra.Count)
  for ($i = 0; $i -lt $len; $i++) {
    $lv = if ($i -lt $la.Count) { $la[$i] } else { 0 }
    $rv = if ($i -lt $ra.Count) { $ra[$i] } else { 0 }
    if ($lv -lt $rv) { return -1 }
    if ($lv -gt $rv) { return 1 }
  }
  return 0
}

function Find-PackageVersionNear([string]$TargetPath) {
  if ([string]::IsNullOrWhiteSpace($TargetPath)) { return $null }
  $dir = $TargetPath
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { $dir = Split-Path -Parent $dir }
  for ($i = 0; $i -lt 6; $i++) {
    if ([string]::IsNullOrWhiteSpace($dir)) { break }
    $pkg = Join-Path $dir 'package.json'
    if (Test-Path -LiteralPath $pkg -PathType Leaf) {
      try {
        $obj = Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json
        if ($obj.name -eq 'imcodes' -and $obj.version) { return [string]$obj.version }
      } catch {}
    }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir) { break }
    $dir = $parent
  }
  return $null
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
  $installedVersion = ''
  if ($hasAutostart) {
    $autoText = Get-Content -LiteralPath $AutostartPath -Raw -ErrorAction SilentlyContinue
    if ($autoText -match '([A-Za-z]:[/\\\\][^\\r\\n"'']+dist[/\\\\]src[/\\\\]index\\.js)') {
      if (Test-InsideGitCheckout $Matches[1]) { $autostartDev = $true }
      $installedVersion = Find-PackageVersionNear $Matches[1]
    }
    if ($autoText -match '-2147020576' -or $autoText -match 'broken') {
      $isLegacyBroken = $true
      $legacyReason = 'windows_legacy_broken_exit_signature'
    }
  }
  if (-not $installedVersion -and $cliExists -and -not $cliDev) {
    try {
      $cliRaw = Get-Content -LiteralPath $CliWrapperPath -Raw -ErrorAction SilentlyContinue
      if ($cliRaw -and -not $cliRaw.Contains('IMCODES_DAEMON_RUNTIME_DIR')) {
        $installedVersion = Find-PackageVersionNear $CliWrapperPath
      }
    } catch {}
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
  if (-not $isLegacyBroken -and -not $autostartDev -and -not $cliDev -and $installedVersion -and -not [string]::IsNullOrWhiteSpace($MinimumRuntimeVersion)) {
    if ((Compare-SimpleVersions $installedVersion $MinimumRuntimeVersion) -lt 0) {
      $isLegacyBroken = $true
      $legacyReason = "stale_npm_version_$installedVersion"
    }
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
  $checkLock = ($scenario -eq 'legacy_broken_takeover') -or $hasLock -or ($scenario -eq 'clean')
  $stopDaemon = (($scenario -eq 'legacy_broken_takeover') -and $hasAutostart) -or (-not $preserveAutostart -and $hasLock)
  $switchToBundled = ($scenario -eq 'clean') -or ($scenario -eq 'legacy_broken_takeover') -or ($scenario -eq 'partial_preserve' -and -not $hasAutostart)

  return [ordered]@{
    platform = 'win32'
    scenario = $scenario
    legacyReason = $legacyReason
    installedVersion = $installedVersion
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
    checkSingleInstanceLock = $checkLock
    stopUserDaemonTask = $stopDaemon
    switchToBundledRuntime = $switchToBundled
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

function Write-TextAtomic([string]$TargetPath, [string]$Content, [System.Text.Encoding]$Encoding) {
  $parent = Split-Path -Parent $TargetPath
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $tmp = "$TargetPath.tmp.$PID." + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  try {
    [System.IO.File]::WriteAllText($tmp, $Content, $Encoding)
    if (Test-Path -LiteralPath $TargetPath) {
      $existingItem = Get-Item -LiteralPath $TargetPath -Force -ErrorAction SilentlyContinue
      if ($existingItem -and ($existingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $TargetPath -Force
      }
    }
    Move-Item -LiteralPath $tmp -Destination $TargetPath -Force
  } catch {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Remove-PathSafely([string]$TargetPath) {
  if ([string]::IsNullOrWhiteSpace($TargetPath) -or -not (Test-Path -LiteralPath $TargetPath)) { return }
  $item = Get-Item -LiteralPath $TargetPath -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    if ($item.PSIsContainer) {
      [System.IO.Directory]::Delete($TargetPath, $false)
    } else {
      [System.IO.File]::Delete($TargetPath)
    }
    return
  }
  Remove-Item -LiteralPath $TargetPath -Recurse -Force -ErrorAction SilentlyContinue
}

function New-WindowsReparsePoint([string]$Kind, [string]$LinkPath, [string]$TargetPath) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Kind -eq 'junction') {
      & cmd.exe /c mklink /J "$LinkPath" "$TargetPath" 2>&1 | Out-Null
    } else {
      & cmd.exe /c mklink "$LinkPath" "$TargetPath" 2>&1 | Out-Null
    }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

function Invoke-ServiceAction([string]$Action, [hashtable]$Payload) {
  if (-not [string]::IsNullOrWhiteSpace($ServiceHookScript)) {
    $jsonArg = ($Payload | ConvertTo-Json -Compress -Depth 6)
    & $ServiceHookScript -Action $Action -PayloadJson $jsonArg | Out-Null
    return $true
  }
  return $false
}

function Get-SchtasksExecutable {
  if (-not [string]::IsNullOrWhiteSpace($SchtasksExe)) { return $SchtasksExe }
  if (-not [string]::IsNullOrWhiteSpace($env:IMCODES_WIN_SCHTASKS_BIN)) { return $env:IMCODES_WIN_SCHTASKS_BIN }
  return 'schtasks.exe'
}

function Test-UsingCustomSchtasksExe {
  return (-not [string]::IsNullOrWhiteSpace($SchtasksExe)) -or (-not [string]::IsNullOrWhiteSpace($env:IMCODES_WIN_SCHTASKS_BIN))
}

function Test-CanControlNativeWindowsTasks {
  if (-not [string]::IsNullOrWhiteSpace($IsolatedRoot)) {
    return (Test-UsingCustomSchtasksExe)
  }
  return $true
}

function Invoke-Schtasks([string[]]$Arguments) {
  $exe = Get-SchtasksExecutable
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $exe @Arguments 2>&1
    $rc = $LASTEXITCODE
    $text = (($out | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
    return [ordered]@{ exitCode = $rc; output = $text }
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

function Get-WindowsProcessLiveness([int]$ProcessId) {
  if ($ProcessId -le 0) {
    return [ordered]@{ status = 'dead'; token = '' }
  }
  if (-not [string]::IsNullOrWhiteSpace($ProcessProbeScript)) {
    try {
      $probeRaw = & $ProcessProbeScript -ProcessId $ProcessId
      if ($LASTEXITCODE -ne 0) {
        return [ordered]@{ status = 'probe_failed'; token = '' }
      }
      $probeObj = ($probeRaw | Out-String) | ConvertFrom-Json
      if (-not $probeObj.alive) {
        return [ordered]@{ status = 'dead'; token = '' }
      }
      if ($probeObj.startToken -is [string] -and -not [string]::IsNullOrWhiteSpace($probeObj.startToken)) {
        return [ordered]@{ status = 'alive'; token = [string]$probeObj.startToken }
      }
      return [ordered]@{ status = 'probe_failed'; token = '' }
    } catch {
      return [ordered]@{ status = 'probe_failed'; token = '' }
    }
  }

  $proc = $null
  try {
    $proc = [System.Diagnostics.Process]::GetProcessById($ProcessId)
  } catch [System.ArgumentException] {
    return [ordered]@{ status = 'dead'; token = '' }
  } catch {
    return [ordered]@{ status = 'probe_failed'; token = '' }
  }

  try {
    if ($proc.HasExited) {
      return [ordered]@{ status = 'dead'; token = '' }
    }
    $ticks = $proc.StartTime.ToUniversalTime().Ticks
    return [ordered]@{ status = 'alive'; token = "windows:$ticks" }
  } catch {
    try {
      if ($proc.HasExited) {
        return [ordered]@{ status = 'dead'; token = '' }
      }
    } catch {}
    return [ordered]@{ status = 'probe_failed'; token = '' }
  }
}

function Get-WindowsLockOwnership([int]$ProcessId, [string]$LockStartToken) {
  $probe = Get-WindowsProcessLiveness $ProcessId
  if ($probe.status -eq 'dead') {
    return [ordered]@{ ownership = 'dead'; status = 'dead'; liveToken = '' }
  }
  if ($probe.status -ne 'alive') {
    return [ordered]@{ ownership = 'unknown'; status = 'probe_failed'; liveToken = '' }
  }
  if ([string]::IsNullOrWhiteSpace($LockStartToken) -or ($LockStartToken -notmatch '^(?<scheme>[a-z]+):(?<val>.+)$')) {
    return [ordered]@{ ownership = 'unknown'; status = 'invalid_token'; liveToken = $probe.token }
  }
  $scheme = $Matches['scheme']
  if ($scheme -notin @('linux', 'ps', 'windows') -or $scheme -ne 'windows') {
    return [ordered]@{ ownership = 'unknown'; status = 'cross_or_unknown_scheme'; liveToken = $probe.token }
  }
  if ($LockStartToken -eq $probe.token) {
    return [ordered]@{ ownership = 'owned'; status = 'alive'; liveToken = $probe.token }
  }
  return [ordered]@{ ownership = 'stale'; status = 'token_mismatch'; liveToken = $probe.token }
}

function Read-DaemonLockInfo {
  $lockPath = Join-Path $UserStateDir 'daemon.lock.json'
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
  $lockPid = $null
  $lockToken = ''
  try {
    $lockObj = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    if ($lockObj.pid -is [int] -or $lockObj.pid -is [long] -or ($lockObj.pid -match '^\\d+$')) {
      $parsedPid = [int]$lockObj.pid
      if ($parsedPid -gt 0) { $lockPid = $parsedPid }
    }
    if ($lockObj.PSObject.Properties['startToken'] -and ($lockObj.startToken -is [string])) {
      $lockToken = [string]$lockObj.startToken
    }
  } catch {
    return [ordered]@{ pid = $null; startToken = ''; invalid = $true }
  }
  if (-not $lockPid) { return $null }
  return [ordered]@{ pid = $lockPid; startToken = $lockToken; invalid = $false }
}

function Get-WindowsServicesSnapshot {
  $userDaemonRunning = $false
  $lockInfo = Read-DaemonLockInfo
  if ($lockInfo -and $lockInfo.pid) {
    $own = Get-WindowsLockOwnership $lockInfo.pid $lockInfo.startToken
    if ($own.ownership -eq 'owned') {
      $userDaemonRunning = $true
    }
  }
  $taskSnapshots = @()
  $canQuery = Test-CanControlNativeWindowsTasks
  foreach ($tn in @('imcodes-node', 'imcodes-node-watchdog', 'imcodes-daemon')) {
    $entry = [ordered]@{
      name = $tn
      exists = $false
      enabled = $false
      running = $false
      xmlContent = ''
    }
    if ($canQuery) {
      $qXml = Invoke-Schtasks @('/Query', '/TN', $tn, '/XML')
      if ($qXml.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($qXml.output)) {
        $entry.exists = $true
        $entry.xmlContent = [string]$qXml.output
        $enabledKnown = $false
        $runningKnown = $false
        if (-not (Test-UsingCustomSchtasksExe)) {
          try {
            $stObj = Get-ScheduledTask -TaskName $tn -ErrorAction Stop
            $stStr = [string]$stObj.State
            $entry.enabled = ($stStr -ne 'Disabled')
            $entry.running = ($stStr -eq 'Running')
            $enabledKnown = $true
            $runningKnown = $true
          } catch {}
        }
        if (-not $enabledKnown -or -not $runningKnown) {
          $qStat = Invoke-Schtasks @('/Query', '/TN', $tn, '/FO', 'LIST', '/V')
          if ($qStat.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($qStat.output)) {
            $outText = [string]$qStat.output
            if (-not $runningKnown) {
              $entry.running = ($outText -match '(?im)^\\s*(?:Status|状态)\\s*:\\s*(?:Running|正在运行)\\b')
              $runningKnown = $true
            }
            if (-not $enabledKnown) {
              if ($outText -match '(?im)^\\s*(?:Scheduled Task State|计划任务状态)\\s*:\\s*(?:Disabled|已禁用)\\b') {
                $entry.enabled = $false
                $enabledKnown = $true
              } elseif ($outText -match '(?im)^\\s*(?:Scheduled Task State|计划任务状态)\\s*:\\s*(?:Enabled|已启用|启用)\\b') {
                $entry.enabled = $true
                $enabledKnown = $true
              } elseif ($outText -match '(?im)^\\s*(?:Status|状态)\\s*:\\s*(?:Disabled|已禁用)\\b') {
                $entry.enabled = $false
                $enabledKnown = $true
              }
            }
          }
          if (-not $enabledKnown) {
            if ($entry.xmlContent -match '<Enabled>\\s*false\\s*</Enabled>') {
              $entry.enabled = $false
            } else {
              $entry.enabled = $true
            }
          }
        }
      }
    }
    $taskSnapshots += $entry
  }
  return [ordered]@{
    userDaemonWasRunning = $userDaemonRunning
    tasks = $taskSnapshots
  }
}

function Stop-VerifiedDaemonProcess([hashtable]$LockInfo, [switch]$FailOnUnverifiable) {
  if (-not $LockInfo -or -not $LockInfo.pid) { return $false }
  $lockPid = [int]$LockInfo.pid
  $lockToken = [string]$LockInfo.startToken
  $own = Get-WindowsLockOwnership $lockPid $lockToken
  if ($own.ownership -eq 'dead' -or $own.ownership -eq 'stale') {
    return $false
  }
  if ($own.ownership -ne 'owned') {
    if ($FailOnUnverifiable) {
      throw "active_daemon_lock_unverifiable_pid: $lockPid ($($own.status))"
    }
    return $false
  }

  $handled = $false
  if (-not [string]::IsNullOrWhiteSpace($ServiceHookScript)) {
    $recheckHook = Get-WindowsLockOwnership $lockPid $lockToken
    if ($recheckHook.ownership -eq 'dead' -or $recheckHook.ownership -eq 'stale') { return $false }
    if ($recheckHook.ownership -ne 'owned') {
      if ($FailOnUnverifiable) { throw "active_daemon_lock_unverifiable_pid: $lockPid" }
      return $false
    }
    $handled = Invoke-ServiceAction 'StopDaemon' @{ pid = $lockPid; autostartPath = $AutostartPath }
  }
  if (-not $handled) {
    if ($ApplyServices -and (Test-CanControlNativeWindowsTasks)) {
      [void](Invoke-Schtasks @('/End', '/TN', 'imcodes-daemon'))
    }
    $recheckSig = Get-WindowsLockOwnership $lockPid $lockToken
    if ($recheckSig.ownership -eq 'dead' -or $recheckSig.ownership -eq 'stale') { return $true }
    if ($recheckSig.ownership -ne 'owned') {
      if ($FailOnUnverifiable) { throw "active_daemon_lock_unverifiable_pid: $lockPid" }
      return $false
    }
    Stop-Process -Id $lockPid -ErrorAction SilentlyContinue
  }
  for ($w = 0; $w -lt 25; $w++) {
    $waitOwn = Get-WindowsLockOwnership $lockPid $lockToken
    if ($waitOwn.ownership -eq 'dead' -or $waitOwn.ownership -eq 'stale') {
      return $true
    }
    if ($waitOwn.ownership -ne 'owned') {
      if ($FailOnUnverifiable) { throw "active_daemon_lock_unverifiable_pid: $lockPid ($($waitOwn.status))" }
      return $false
    }
    Start-Sleep -Milliseconds 200
  }
  $finalOwn = Get-WindowsLockOwnership $lockPid $lockToken
  if ($finalOwn.ownership -eq 'dead' -or $finalOwn.ownership -eq 'stale') {
    return $true
  }
  if ($FailOnUnverifiable) {
    throw "active_daemon_lock_refused_to_stop: $lockPid"
  }
  return $false
}

function Assert-SingleInstanceLockAndStop($Plan) {
  if (-not $Plan.checkSingleInstanceLock -and -not $Plan.stopUserDaemonTask) { return $false }
  $lockInfo = Read-DaemonLockInfo
  if (-not $lockInfo) { return $false }
  if ($lockInfo.invalid) {
    throw 'active_daemon_lock_corrupt_json'
  }
  $shouldTakeover = $Plan.stopUserDaemonTask -or (-not $Plan.preserveUserDaemonAutostart) -or $Plan.switchToBundledRuntime
  if (-not $shouldTakeover) { return $false }
  return (Stop-VerifiedDaemonProcess $lockInfo -FailOnUnverifiable)
}

function Save-RollbackSnapshot($Plan, $ServiceSnapshot) {
  $manifestPath = Join-Path $SnapshotDir 'snapshot.json'
  $filesDir = Join-Path $SnapshotDir 'files'
  $svcDir = Join-Path $SnapshotDir 'services'
  New-Item -ItemType Directory -Force -Path $filesDir | Out-Null
  New-Item -ItemType Directory -Force -Path $svcDir | Out-Null
  $entries = @()
  $idx = 0
  $nodeExeTarget = Join-Path $NodeRoot 'imcodes-node.exe'
  $wdScriptTarget = Join-Path $NodeRoot 'health-watchdog.ps1'
  foreach ($tp in @($CliWrapperPath, $AutostartPath, $CurrentDir, $ReleaseDir, $nodeExeTarget, $wdScriptTarget, $StartMenuShortcutPath, $DesktopShortcutPath)) {
    if ([string]::IsNullOrWhiteSpace($tp)) { continue }
    if ($tp -eq $ReleaseDir) {
      Assert-SafeTargetPath $tp $RealProfile
    } else {
      Assert-SafeTargetPath $tp $RealProfile -EntryMode
    }
    if (-not (Test-Path -LiteralPath $tp)) {
      $entries += [ordered]@{ kind = 'absent'; originalPath = $tp }
      continue
    }
    $item = Get-Item -LiteralPath $tp -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      $target = if ($item.Target) { if ($item.Target -is [System.Array]) { [string]$item.Target[0] } else { [string]$item.Target } } else { '' }
      $reparseKind = if ($item.PSIsContainer) { 'junction' } else { 'symlink' }
      $entries += [ordered]@{ kind = $reparseKind; originalPath = $tp; target = $target }
    } elseif ($item.PSIsContainer) {
      $idx++
      $rel = Join-Path 'files' ("$idx-" + $item.Name)
      $dest = Join-Path $SnapshotDir $rel
      Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
      Copy-Item -LiteralPath $tp -Destination $dest -Recurse -Force
      $entries += [ordered]@{ kind = 'dir'; originalPath = $tp; backupRelPath = $rel }
    } else {
      $idx++
      $rel = Join-Path 'files' ("$idx-" + $item.Name)
      Copy-Item -LiteralPath $tp -Destination (Join-Path $SnapshotDir $rel) -Force
      $entries += [ordered]@{ kind = 'file'; originalPath = $tp; backupRelPath = $rel }
    }
  }
  $preserved = @()
  foreach ($pp in $Plan.preservedCandidatePaths) {
    if (Test-Path -LiteralPath $pp -PathType Leaf) {
      $preserved += [ordered]@{ path = $pp; sha256 = (Get-FileSha256Hex $pp) }
    }
  }
  $savedTasks = @()
  if ($ServiceSnapshot -and $ServiceSnapshot.tasks) {
    foreach ($t in $ServiceSnapshot.tasks) {
      $xmlRelPath = ''
      if ($t.exists -and -not [string]::IsNullOrWhiteSpace($t.xmlContent)) {
        $xmlRelPath = Join-Path 'services' ($t.name + '.task.xml')
        Write-TextAtomic (Join-Path $SnapshotDir $xmlRelPath) $t.xmlContent ([System.Text.Encoding]::Unicode)
      }
      $savedTasks += [ordered]@{
        name = $t.name
        exists = [bool]$t.exists
        enabled = [bool]$t.enabled
        running = [bool]$t.running
        xmlRelPath = $xmlRelPath
      }
    }
  }
  $snapshotDoc = [ordered]@{
    schemaVersion = 1
    createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    platform = 'win32'
    scenario = $Plan.scenario
    snapshotDir = $SnapshotDir
    entries = $entries
    preservedChecksums = $preserved
    services = [ordered]@{
      applyRecorded = [bool]$ApplyServices
      userDaemonWasRunning = [bool]($ServiceSnapshot -and $ServiceSnapshot.userDaemonWasRunning)
      tasks = $savedTasks
    }
  }
  $json = ($snapshotDoc | ConvertTo-Json -Depth 6)
  Write-TextAtomic $manifestPath $json ([System.Text.Encoding]::UTF8)
}

function Write-WindowsShortcut([string]$ShortcutPath, [string]$TargetExe, [string]$Arguments) {
  if ([string]::IsNullOrWhiteSpace($ShortcutPath)) { return }
  Assert-SafeTargetPath $ShortcutPath $RealProfile -EntryMode
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ShortcutPath) | Out-Null
  try {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($ShortcutPath)
    $sc.TargetPath = $TargetExe
    $sc.Arguments = $Arguments
    $sc.WorkingDirectory = Split-Path -Parent $TargetExe
    $sc.Save()
  } catch {}
}

function Register-WindowsServices($Plan, [bool]$RestartDaemon) {
  $nodeExe = Join-Path $NodeRoot 'imcodes-node.exe'
  if (Test-Path -LiteralPath $nodeExe -PathType Leaf) {
    $escapedExe = [System.Security.SecurityElement]::Escape($nodeExe)
    $nodeTaskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>IM.codes controlled node</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="System">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>255</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="System">
    <Exec>
      <Command>$escapedExe</Command>
    </Exec>
  </Actions>
</Task>
"@
    $wdScriptPath = Join-Path $NodeRoot 'health-watchdog.ps1'
    $wdScriptBody = "\$ErrorActionPreference = 'Stop'\r\n& '$($nodeExe.Replace("'", "''"))' --health-watchdog\r\n"
    Write-TextAtomic $wdScriptPath $wdScriptBody ([System.Text.Encoding]::UTF8)
    $wdArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \`"$wdScriptPath\`""
    $escapedPs = [System.Security.SecurityElement]::Escape((Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
    $escapedWdArgs = [System.Security.SecurityElement]::Escape($wdArgs)
    $startBoundary = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $wdTaskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>IM.codes controlled node authenticated-health watchdog</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Repetition><Interval>PT1M</Interval></Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="System"><Exec><Command>$escapedPs</Command><Arguments>$escapedWdArgs</Arguments></Exec></Actions>
</Task>
"@
    $handledNode = Invoke-ServiceAction 'RegisterControlledNode' @{
      nodeTaskName = 'imcodes-node'
      watchdogTaskName = 'imcodes-node-watchdog'
      nodeExe = $nodeExe
      watchdogScriptPath = $wdScriptPath
      nodeTaskXml = $nodeTaskXml
      watchdogTaskXml = $wdTaskXml
    }
    if (-not $handledNode -and (Test-CanControlNativeWindowsTasks)) {
      $nodeXmlPath = Join-Path $SnapshotDir 'imcodes-node.task.xml'
      $wdXmlPath = Join-Path $SnapshotDir 'imcodes-node-watchdog.task.xml'
      Write-TextAtomic $nodeXmlPath $nodeTaskXml ([System.Text.Encoding]::Unicode)
      Write-TextAtomic $wdXmlPath $wdTaskXml ([System.Text.Encoding]::Unicode)
      $r1 = Invoke-Schtasks @('/Create', '/TN', 'imcodes-node', '/XML', $nodeXmlPath, '/F')
      if ($r1.exitCode -ne 0) { throw "schtasks_create_node_failed: $($r1.output)" }
      $r2 = Invoke-Schtasks @('/Create', '/TN', 'imcodes-node-watchdog', '/XML', $wdXmlPath, '/F')
      if ($r2.exitCode -ne 0) { throw "schtasks_create_watchdog_failed: $($r2.output)" }
      [void](Invoke-Schtasks @('/Run', '/TN', 'imcodes-node'))
    }
  }
  if ((-not $Plan.preserveUserDaemonAutostart) -or $RestartDaemon) {
    $handledDaemon = Invoke-ServiceAction 'ActivateUserDaemon' @{ autostartPath = $AutostartPath; currentDir = $CurrentDir }
    if (-not $handledDaemon -and (Test-Path -LiteralPath $AutostartPath -PathType Leaf)) {
      Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $AutostartPath) -WindowStyle Hidden | Out-Null
    }
  }
}

if ($Mode -eq 'Rollback') {
  $manifestPath = if ($SnapshotDir.EndsWith('.json')) { $SnapshotDir } else { Join-Path $SnapshotDir 'snapshot.json' }
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Rollback snapshot not found: $manifestPath"
  }
  $snap = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $shouldRollbackServices = $ApplyServices -or ($snap.services -and $snap.services.applyRecorded)

  # Step 1: Stop installed/running tasks and verified daemon process BEFORE deleting/restoring files
  if ($shouldRollbackServices) {
    $lockInfo = Read-DaemonLockInfo
    if ($lockInfo) {
      [void](Stop-VerifiedDaemonProcess $lockInfo)
    }
    if ([string]::IsNullOrWhiteSpace($ServiceHookScript) -and (Test-CanControlNativeWindowsTasks)) {
      foreach ($tn in @('imcodes-node', 'imcodes-node-watchdog', 'imcodes-daemon')) {
        [void](Invoke-Schtasks @('/End', '/TN', $tn))
      }
    }
  }

  # Step 2: Restore file/dir/reparse/absent entries and verify preserved checksums
  $restored = 0
  $removed = 0
  foreach ($entry in $snap.entries) {
    if ($entry.originalPath -eq $ReleaseDir) {
      Assert-SafeTargetPath $entry.originalPath $RealProfile
    } else {
      Assert-SafeTargetPath $entry.originalPath $RealProfile -EntryMode
    }
    if ($entry.kind -eq 'absent') {
      if (Test-Path -LiteralPath $entry.originalPath) {
        Remove-PathSafely $entry.originalPath
        $removed++
      }
    } elseif ($entry.kind -eq 'file') {
      $parent = Split-Path -Parent $entry.originalPath
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
      $backupAbs = Join-Path $snap.snapshotDir $entry.backupRelPath
      if (Test-Path -LiteralPath $entry.originalPath) {
        $ei = Get-Item -LiteralPath $entry.originalPath -Force -ErrorAction SilentlyContinue
        if ($ei -and ($ei.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
          Remove-PathSafely $entry.originalPath
        }
      }
      Copy-Item -LiteralPath $backupAbs -Destination $entry.originalPath -Force
      $restored++
    } elseif ($entry.kind -eq 'dir') {
      Remove-PathSafely $entry.originalPath
      $backupAbs = Join-Path $snap.snapshotDir $entry.backupRelPath
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.originalPath) | Out-Null
      Copy-Item -LiteralPath $backupAbs -Destination $entry.originalPath -Recurse -Force
      $restored++
    } elseif ($entry.kind -eq 'junction' -or $entry.kind -eq 'symlink') {
      Remove-PathSafely $entry.originalPath
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.originalPath) | Out-Null
      [void](New-WindowsReparsePoint $entry.kind $entry.originalPath $entry.target)
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

  # Step 3: Reconcile task registration/enablement/running state and old user daemon
  if ($shouldRollbackServices) {
    $handledSvc = Invoke-ServiceAction 'RollbackServices' @{ snapshotDir = $SnapshotDir; services = $snap.services }
    if (-not $handledSvc -and (Test-CanControlNativeWindowsTasks)) {
      $daemonTaskStarted = $false
      $taskList = if ($snap.services -and $snap.services.tasks) { @($snap.services.tasks) } else { @() }
      if ($taskList.Count -eq 0) {
        foreach ($tn in @('imcodes-node', 'imcodes-node-watchdog')) {
          [void](Invoke-Schtasks @('/End', '/TN', $tn))
          [void](Invoke-Schtasks @('/Delete', '/TN', $tn, '/F'))
        }
      } else {
        foreach ($t in $taskList) {
          if (-not $t.exists) {
            [void](Invoke-Schtasks @('/End', '/TN', $t.name))
            [void](Invoke-Schtasks @('/Delete', '/TN', $t.name, '/F'))
          } else {
            if (-not [string]::IsNullOrWhiteSpace($t.xmlRelPath)) {
              $xmlAbs = Join-Path $snap.snapshotDir $t.xmlRelPath
              if (Test-Path -LiteralPath $xmlAbs -PathType Leaf) {
                $cr = Invoke-Schtasks @('/Create', '/TN', $t.name, '/XML', $xmlAbs, '/F')
                if ($cr.exitCode -ne 0) {
                  throw "rollback_task_restore_failed: $($t.name): $($cr.output)"
                }
              }
            }
            if ($t.enabled) {
              [void](Invoke-Schtasks @('/Change', '/TN', $t.name, '/ENABLE'))
            } else {
              [void](Invoke-Schtasks @('/Change', '/TN', $t.name, '/DISABLE'))
            }
            if ($t.running) {
              [void](Invoke-Schtasks @('/Run', '/TN', $t.name))
              if ($t.name -eq 'imcodes-daemon') { $daemonTaskStarted = $true }
            } else {
              [void](Invoke-Schtasks @('/End', '/TN', $t.name))
            }
          }
        }
      }
      if ($snap.services -and $snap.services.userDaemonWasRunning -and (-not $daemonTaskStarted) -and (Test-Path -LiteralPath $AutostartPath -PathType Leaf)) {
        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $AutostartPath) -WindowStyle Hidden | Out-Null
      }
    }
  }
  [ordered]@{ restoredCount = $restored; removedCount = $removed; verifiedPreservedCount = $verified } | ConvertTo-Json -Depth 4
  exit 0
}

$plan = Invoke-PhaseAProbe
if ($Mode -eq 'PreInstall') {
  $preServiceSnap = Get-WindowsServicesSnapshot
  [void](Assert-SingleInstanceLockAndStop $plan)
  Save-RollbackSnapshot $plan $preServiceSnap
  $plan | Add-Member -NotePropertyName snapshotDir -NotePropertyValue $SnapshotDir -Force
  $plan | ConvertTo-Json -Depth 6
  exit 0
}

# PostInstall mode: capture pre-stop service state & verify lock BEFORE snapshot or payload writes
$preServiceSnap = Get-WindowsServicesSnapshot
$stoppedDaemon = Assert-SingleInstanceLockAndStop $plan
$snapManifestPath = Join-Path $SnapshotDir 'snapshot.json'
if (-not (Test-Path -LiteralPath $snapManifestPath -PathType Leaf)) {
  Save-RollbackSnapshot $plan $preServiceSnap
} elseif ($ApplyServices) {
  try {
    $existingSnap = Get-Content -LiteralPath $snapManifestPath -Raw | ConvertFrom-Json
    if ($existingSnap.services) {
      $existingSnap.services.applyRecorded = $true
      Write-TextAtomic $snapManifestPath ($existingSnap | ConvertTo-Json -Depth 6) ([System.Text.Encoding]::UTF8)
    }
  } catch {}
}

# 2. Clean expired .tmp artifacts only (never lockfiles or SQLite)
if ($plan.cleanExpiredTempArtifacts) {
  foreach ($p in $plan.expiredTempPaths) {
    Assert-SafeTargetPath $p $RealProfile
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 3. Point daemon-runtime\\current to releases\\<ver> when staged
if (Test-Path -LiteralPath $ReleaseDir -PathType Container) {
  Remove-PathSafely $CurrentDir
  $mkExit = New-WindowsReparsePoint 'junction' $CurrentDir $ReleaseDir
  if ($mkExit -ne 0) {
    Copy-Item -LiteralPath $ReleaseDir -Destination $CurrentDir -Recurse -Force
  }
}

# 4. Install imcodes.cmd thin forwarder atomically (never follows symlink targets) unless dev link exempt
if (-not $plan.preserveDevCliLink) {
  if (-not [string]::IsNullOrWhiteSpace($StagedCliWrapper) -and (Test-Path -LiteralPath $StagedCliWrapper -PathType Leaf)) {
    $wrapperContent = [System.IO.File]::ReadAllText($StagedCliWrapper, [System.Text.Encoding]::UTF8)
  } else {
    $wrapperContent = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${JSON.stringify(wrapperB64)}))
  }
  Write-TextAtomic $CliWrapperPath $wrapperContent ([System.Text.Encoding]::ASCII)
}

# 5. Write user daemon autostart script if not preserved
if (-not $plan.preserveUserDaemonAutostart) {
  $nodeExe = Join-Path $CurrentDir 'node.exe'
  $entryJs = Join-Path $CurrentDir 'package\\dist\\src\\index.js'
  $startupCmd = "@echo off\`r\`nstart \`"\`" /min \`"$nodeExe\`" \`"$entryJs\`" start --foreground\`r\`n"
  Write-TextAtomic $AutostartPath $startupCmd ([System.Text.Encoding]::ASCII)
}

# 6. Shortcuts for local panel + user PATH registration + SYSTEM service tasks
$installedNodeExe = Join-Path $NodeRoot 'imcodes-node.exe'
if (Test-Path -LiteralPath $installedNodeExe -PathType Leaf) {
  if (-not [string]::IsNullOrWhiteSpace($StartMenuShortcutPath) -and -not (Test-Path -LiteralPath $StartMenuShortcutPath)) {
    Write-WindowsShortcut $StartMenuShortcutPath $installedNodeExe '--open-local-panel'
  }
  if (-not [string]::IsNullOrWhiteSpace($DesktopShortcutPath) -and -not (Test-Path -LiteralPath $DesktopShortcutPath)) {
    Write-WindowsShortcut $DesktopShortcutPath $installedNodeExe '--open-local-panel'
  }
}
if ($AllowSystemRoot -and [string]::IsNullOrWhiteSpace($IsolatedRoot)) {
  $cliBinDir = Split-Path -Parent $CliWrapperPath
  $curPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrWhiteSpace($curPath)) {
    [Environment]::SetEnvironmentVariable('Path', $cliBinDir, 'User')
  } elseif (($curPath.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\\').ToLowerInvariant() -eq $cliBinDir.TrimEnd('\\').ToLowerInvariant()) }).Count -eq 0) {
    [Environment]::SetEnvironmentVariable('Path', "$curPath;$cliBinDir", 'User')
  }
}
if ($ApplyServices) {
  Register-WindowsServices $plan $stoppedDaemon
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
    `Source: "${stageDirRelative}\\imcodes-windows-installer.ps1"; DestName: "imcodes-windows-installer.ps1"; Flags: dontcopy`,
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
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\\imcodes-windows-installer.ps1"" -Mode PostInstall -AllowSystemRoot -ApplyServices -Version ""${version}"" -RuntimeRoot ""{commonpf}\\IM.codes\\daemon-runtime"" -NodeRoot ""{commonappdata}\\imcodes-node"" -CliWrapperPath ""{localappdata}\\imcodes\\bin\\imcodes.cmd"" -StagedCliWrapper ""{app}\\imcodes.cmd.staged"""; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\\imcodes-windows-installer.ps1"" -Mode Rollback -AllowSystemRoot -ApplyServices -SnapshotDir ""{commonappdata}\\imcodes-node\\installer-rollback-${version}"""; Flags: runhidden waituntilterminated; RunOnceId: "IMCodesDesktopRollback"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  PsScriptPath: String;
  Args: String;
begin
  if CurStep = ssInstall then begin
    ExtractTemporaryFile('imcodes-windows-installer.ps1');
    PsScriptPath := ExpandConstant('{tmp}\\imcodes-windows-installer.ps1');
    Args := '-NoProfile -ExecutionPolicy Bypass -File "' + PsScriptPath + '" -Mode PreInstall -AllowSystemRoot -ApplyServices -Version "${version}" -RuntimeRoot "' + ExpandConstant('{commonpf}\\IM.codes\\daemon-runtime') + '" -NodeRoot "' + ExpandConstant('{commonappdata}\\imcodes-node') + '" -CliWrapperPath "' + ExpandConstant('{localappdata}\\imcodes\\bin\\imcodes.cmd') + '"';
    if not Exec('powershell.exe', Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then begin
      RaiseException('IM.codes PreInstall compatibility/lock check failed with exit code ' + IntToStr(ResultCode));
    end;
  end;
end;
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
  const ps1Content = renderWindowsPhaseAInstallerPs1({
    version,
    cliWrapperContent,
    minVersion: options.minVersion ?? '',
  });

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
    else if (token === '--min-version') args.minVersion = argv[++i];
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
