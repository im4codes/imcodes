#!/usr/bin/env node
/**
 * Build Windows Desktop 3-in-1 Inno Setup `.iss` / `.exe` installer + PowerShell Phase A probe/rollback helper.
 *
 * Uses `scripts/windows-sign-release-artifact.ps1` (`IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT` and
 * `IMCODES_WINDOWS_SIGNING_CERT_SHA256`) when compiling an `.exe` with `ISCC.exe`, and generates deterministic `.iss` + `.ps1` + `.cmd`
 * artifacts even on non-Windows hosts or Windows machines without Inno Setup installed.
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { buildIco } from './aidesk-icon.mjs';
import { parseDaemonRuntimeTarget } from './daemon-runtime-artifacts.mjs';
import {
  loadDesktopCompatibilityModule,
  loadImcodesStateDirName,
  REPO_ROOT,
  resolveDesktopInstallerVersion,
  stageDaemonRuntimePayload,
  writeDesktopInstallerManifest,
} from './desktop-installer-shared.mjs';

export function renderWindowsPhaseAInstallerPs1({ version, cliWrapperContent, minVersion = '', trustedSignerSha256 = '' }) {
  const wrapperB64 = Buffer.from(cliWrapperContent, 'utf8').toString('base64');
  return `param(
  [ValidateSet('Probe', 'Plan', 'PreInstall', 'PostInstall', 'InstallOpenCode', 'CleanupTmp', 'Rollback')]
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
  [string]$TrustedSignerSha256 = ${JSON.stringify(trustedSignerSha256)},
  [string]$ServiceHookScript = '',
  [string]$SchtasksExe = '',
  [string]$ProcessProbeScript = '',
  [string]$OpenCodeInstallHook = '',
  [string]$LogPath = '',
  [int]$TempMaxAgeHours = 24,
  [switch]$ForceTakeover,
  [switch]$AllowSystemRoot,
  [switch]$ApplyServices,
  [switch]$SkipOpenCode
)

$ErrorActionPreference = 'Stop'

$script:InstallerLogFile = ''
function Write-InstallerLog([string]$Message) {
  if ([string]::IsNullOrWhiteSpace($script:InstallerLogFile)) { return }
  try {
    $parentDir = Split-Path -Parent $script:InstallerLogFile
    if (-not [string]::IsNullOrWhiteSpace($parentDir) -and -not (Test-Path -LiteralPath $parentDir -PathType Container)) {
      New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
    }
    $line = ([DateTime]::UtcNow.ToString('o') + ' [' + $Mode + '] ' + $Message + [Environment]::NewLine)
    [System.IO.File]::AppendAllText($script:InstallerLogFile, $line, [System.Text.Encoding]::UTF8)
  } catch {}
}

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
if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
  Assert-SafeTargetPath $LogPath $RealProfile -EntryMode
  $script:InstallerLogFile = $LogPath
} elseif ($Mode -in @('PreInstall', 'PostInstall', 'Rollback')) {
  $defaultLog = Join-Path $NodeRoot ('installer-' + $Mode.ToLowerInvariant() + '.log')
  Assert-SafeTargetPath $defaultLog $RealProfile -EntryMode
  $script:InstallerLogFile = $defaultLog
} elseif ($Mode -eq 'InstallOpenCode') {
  $defaultLog = Join-Path (Join-Path $HomeDir '.imcodes') 'installer-opencode.log'
  Assert-SafeTargetPath $defaultLog $RealProfile -EntryMode
  $script:InstallerLogFile = $defaultLog
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
    if ((Split-Path -Leaf $dir) -ieq 'node_modules') { return $false }
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

function Test-DatabaseFileName([string]$PathValue) {
  $lower = [System.IO.Path]::GetFileName($PathValue).ToLowerInvariant()
  return ($lower.EndsWith('.sqlite') -or $lower.EndsWith('.sqlite-wal') -or $lower.EndsWith('.sqlite-shm') -or $lower.EndsWith('.db') -or $lower.EndsWith('-wal') -or $lower.EndsWith('-shm'))
}

function Get-FileSha256Hex([string]$PathValue) {
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $fs = New-Object System.IO.FileStream($PathValue, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($fs))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $fs.Dispose()
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
            $lblStZh = '' + [char]0x72B6 + [char]0x6001
            $valRunZh = '' + [char]0x6B63 + [char]0x5728 + [char]0x8FD0 + [char]0x884C
            $lblTsZh = '' + [char]0x8BA1 + [char]0x5212 + [char]0x4EFB + [char]0x52A1 + [char]0x72B6 + [char]0x6001
            $valDisZh = '' + [char]0x5DF2 + [char]0x7981 + [char]0x7528
            $valEnZh = '' + [char]0x5DF2 + [char]0x542F + [char]0x7528
            $valEnShortZh = '' + [char]0x542F + [char]0x7528
            if (-not $runningKnown) {
              $entry.running = ($outText -match ("(?im)^\\s*(?:Status|$lblStZh)\\s*:\\s*(?:Running|$valRunZh)\\b"))
              $runningKnown = $true
            }
            if (-not $enabledKnown) {
              if ($outText -match ("(?im)^\\s*(?:Scheduled Task State|$lblTsZh)\\s*:\\s*(?:Disabled|$valDisZh)\\b")) {
                $entry.enabled = $false
                $enabledKnown = $true
              } elseif ($outText -match ("(?im)^\\s*(?:Scheduled Task State|$lblTsZh)\\s*:\\s*(?:Enabled|$valEnZh|$valEnShortZh)\\b")) {
                $entry.enabled = $true
                $enabledKnown = $true
              } elseif ($outText -match ("(?im)^\\s*(?:Status|$lblStZh)\\s*:\\s*(?:Disabled|$valDisZh)\\b")) {
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

function Test-PathUnderManagedRoot([string]$CandidatePath, [string]$RootPath) {
  if ([string]::IsNullOrWhiteSpace($CandidatePath) -or [string]::IsNullOrWhiteSpace($RootPath)) { return $false }
  $prefix = $RootPath.TrimEnd('\\') + '\\'
  return $CandidatePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Stop-ActiveNodeWatchdogProcesses([string]$TargetNodeRoot) {
  if ([string]::IsNullOrWhiteSpace($TargetNodeRoot)) { return $false }
  $rootTrimmed = $TargetNodeRoot.TrimEnd('\\', '/')
  if ([string]::IsNullOrWhiteSpace($rootTrimmed)) { return $false }
  $stoppedWatchdog = $false
  try {
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue)
    foreach ($proc in $candidates) {
      if ([int]$proc.ProcessId -eq $PID) { continue }
      $cmd = [string]$proc.CommandLine
      if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
      if (($cmd.IndexOf('imcodes-node-health-watchdog.ps1', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -and ($cmd.IndexOf($rootTrimmed, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
        Write-InstallerLog ("Stopping active watchdog process pid=" + $proc.ProcessId + " cmd=" + $cmd)
        try { Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue } catch {}
        $stoppedWatchdog = $true
      }
    }
  } catch {
    Write-InstallerLog ("Watchdog process scan note: " + $_.Exception.Message)
  }
  return $stoppedWatchdog
}

function Stop-ControlledNodeAndSidecarsForInstall {
  $stopWatch = [System.Diagnostics.Stopwatch]::StartNew()
  if (Test-Path -LiteralPath $NodeRoot -PathType Container) {
    $markerPath = Join-Path $NodeRoot 'upgrade-in-progress.json'
    $markerJson = ([ordered]@{
      version = 1
      startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      source = 'windows-installer'
    } | ConvertTo-Json -Compress)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    Write-TextAtomic $markerPath $markerJson $utf8NoBom
  }

  $handledStop = Invoke-ServiceAction 'StopControlledNode' @{ nodeRoot = $NodeRoot; runtimeRoot = $RuntimeRoot }
  if ($handledStop -or -not $ApplyServices) { return }

  if (Test-CanControlNativeWindowsTasks) {
    $useCustomSchtasks = Test-UsingCustomSchtasksExe
    $hasGetTaskCmdlet = (-not $useCustomSchtasks) -and ($null -ne (Get-Command -Name 'Get-ScheduledTask' -ErrorAction SilentlyContinue))
    $hasDisableCmdlet = (-not $useCustomSchtasks) -and ($null -ne (Get-Command -Name 'Disable-ScheduledTask' -ErrorAction SilentlyContinue))
    $hasStopCmdlet = (-not $useCustomSchtasks) -and ($null -ne (Get-Command -Name 'Stop-ScheduledTask' -ErrorAction SilentlyContinue))
    foreach ($tn in @('imcodes-node-watchdog', 'imcodes-node')) {
      $taskDisabled = $false
      $taskStopped = $false
      if ($hasGetTaskCmdlet) {
        try {
          $existingTask = Get-ScheduledTask -TaskName $tn -ErrorAction Stop
          if ($null -eq $existingTask) {
            Write-InstallerLog ("Scheduled task not present (skip disable/stop): " + $tn)
            $taskDisabled = $true
            $taskStopped = $true
          }
        } catch {
          if ($_.CategoryInfo -and ($_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound)) {
            Write-InstallerLog ("Scheduled task not present (skip disable/stop): " + $tn)
            $taskDisabled = $true
            $taskStopped = $true
          } else {
            Write-InstallerLog ("Get-ScheduledTask note for " + $tn + ": " + $_.Exception.Message)
          }
        }
      }
      if (-not $taskDisabled -and $hasDisableCmdlet) {
        try {
          Disable-ScheduledTask -TaskName $tn -ErrorAction Stop | Out-Null
          Write-InstallerLog ("Disabled scheduled task via PowerShell cmdlet: " + $tn)
          $taskDisabled = $true
        } catch {
          Write-InstallerLog ("Disable-ScheduledTask failed for " + $tn + ": " + $_.Exception.Message)
        }
      }
      if (-not $taskDisabled) {
        $rDis = Invoke-Schtasks @('/Change', '/TN', $tn, '/DISABLE')
        if ($rDis.exitCode -ne 0) {
          Write-InstallerLog ("schtasks /Change /DISABLE failed for " + $tn + " exit=" + $rDis.exitCode + " out=" + $rDis.output)
        } else {
          Write-InstallerLog ("Disabled scheduled task via schtasks: " + $tn)
          $taskDisabled = $true
        }
      }
      if (-not $taskStopped -and $hasStopCmdlet) {
        try {
          Stop-ScheduledTask -TaskName $tn -ErrorAction Stop | Out-Null
          Write-InstallerLog ("Stopped scheduled task via PowerShell cmdlet: " + $tn)
          $taskStopped = $true
        } catch {
          Write-InstallerLog ("Stop-ScheduledTask failed for " + $tn + ": " + $_.Exception.Message)
        }
      }
      if (-not $taskStopped) {
        $rEnd = Invoke-Schtasks @('/End', '/TN', $tn)
        if ($rEnd.exitCode -ne 0) {
          Write-InstallerLog ("schtasks /End note for " + $tn + " exit=" + $rEnd.exitCode + " out=" + $rEnd.output)
        } else {
          Write-InstallerLog ("Stopped scheduled task via schtasks: " + $tn)
          $taskStopped = $true
        }
      }
    }
  }

  $stoppedAny = $false
  if (Stop-ActiveNodeWatchdogProcesses $NodeRoot) {
    $stoppedAny = $true
  }
  foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
    if ($proc.Id -eq $PID) { continue }
    $procPath = ''
    try { $procPath = [string]$proc.Path } catch { $procPath = '' }
    if ((Test-PathUnderManagedRoot $procPath $NodeRoot) -or (Test-PathUnderManagedRoot $procPath $RuntimeRoot)) {
      Write-InstallerLog ("Stopping managed process pid=" + $proc.Id + " path=" + $procPath)
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
      $stoppedAny = $true
    }
  }

  $lockTargets = @(
    (Join-Path $NodeRoot 'imcodes-node.exe'),
    (Join-Path $NodeRoot 'remote-desktop-worker\\win32-x64\\imcodes-remote-desktop-worker.exe'),
    (Join-Path $NodeRoot 'computer-use-helper\\open-computer-use.exe'),
    (Join-Path $NodeRoot 'computer-use-helper\\win32-x64\\open-computer-use.exe'),
    (Join-Path $NodeRoot 'aidesk-local-ui\\win32-x64\\aidesk-local-ui.exe'),
    (Join-Path $NodeRoot 'aidesk-local-ui\\aidesk-local-ui.exe')
  )
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $stillRunning = @()
    foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
      if ($proc.Id -eq $PID) { continue }
      $procPath = ''
      try { $procPath = [string]$proc.Path } catch { $procPath = '' }
      if ((Test-PathUnderManagedRoot $procPath $NodeRoot) -or (Test-PathUnderManagedRoot $procPath $RuntimeRoot)) {
        $stillRunning += $proc.Id
        if ($attempt -eq 4 -or $attempt -eq 12) {
          try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
      }
    }
    $lockedBin = $null
    if ($stillRunning.Count -eq 0) {
      foreach ($binPath in $lockTargets) {
        if (-not (Test-Path -LiteralPath $binPath -PathType Leaf)) { continue }
        try {
          $lockStream = New-Object System.IO.FileStream($binPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
          $lockStream.Dispose()
        } catch {
          $lockedBin = $binPath
          break
        }
      }
    }
    if ($stillRunning.Count -eq 0 -and $null -eq $lockedBin) {
      $stopWatch.Stop()
      Write-InstallerLog ("Managed node and sidecar locks released stoppedAny=" + $stoppedAny + " elapsedMs=" + $stopWatch.ElapsedMilliseconds)
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "controlled_node_binary_locked: managed process or file lock did not clear under $NodeRoot"
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
  $nodeIconTarget = Join-Path $NodeRoot 'aidesk.ico'
  $wdScriptTarget = Join-Path $NodeRoot 'imcodes-node-health-watchdog.ps1'
  foreach ($tp in @($CliWrapperPath, $AutostartPath, $CurrentDir, $ReleaseDir, $nodeExeTarget, $nodeIconTarget, $wdScriptTarget, $StartMenuShortcutPath, $DesktopShortcutPath)) {
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
  $preservedDatabases = @()
  foreach ($pp in $Plan.preservedCandidatePaths) {
    if (Test-Path -LiteralPath $pp -PathType Leaf) {
      if (Test-DatabaseFileName $pp) {
        $preservedDatabases += $pp
      } else {
        $preserved += [ordered]@{ path = $pp; sha256 = (Get-FileSha256Hex $pp) }
      }
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
    preservedDatabases = $preservedDatabases
    services = [ordered]@{
      applyRecorded = [bool]$ApplyServices
      userDaemonWasRunning = [bool]($ServiceSnapshot -and $ServiceSnapshot.userDaemonWasRunning)
      tasks = $savedTasks
    }
  }
  $json = ($snapshotDoc | ConvertTo-Json -Depth 6)
  Write-TextAtomic $manifestPath $json ([System.Text.Encoding]::UTF8)
}

function Write-WindowsShortcut([string]$ShortcutPath, [string]$TargetExe, [string]$Arguments, [string]$IconLocation = '') {
  if ([string]::IsNullOrWhiteSpace($ShortcutPath)) { return }
  Assert-SafeTargetPath $ShortcutPath $RealProfile -EntryMode
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ShortcutPath) | Out-Null
  try {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($ShortcutPath)
    $sc.TargetPath = $TargetExe
    $sc.Arguments = $Arguments
    $sc.WorkingDirectory = Split-Path -Parent $TargetExe
    if (-not [string]::IsNullOrWhiteSpace($IconLocation)) {
      $sc.IconLocation = $IconLocation
    }
    $sc.Save()
  } catch {}
}

function Sync-WindowsAideskShortcut([string]$ShortcutPath, [string]$TargetExe, [string]$Arguments, [string]$IconLocation, [bool]$CreateIfMissing) {
  if ([string]::IsNullOrWhiteSpace($ShortcutPath)) { return }
  if (-not (Test-Path -LiteralPath $ShortcutPath)) {
    if ($CreateIfMissing) {
      Write-WindowsShortcut $ShortcutPath $TargetExe $Arguments $IconLocation
    }
    return
  }
  if ([string]::IsNullOrWhiteSpace($IconLocation)) { return }
  Assert-SafeTargetPath $ShortcutPath $RealProfile -EntryMode
  try {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($ShortcutPath)
    $curTarget = [string]$sc.TargetPath
    if (-not [string]::IsNullOrWhiteSpace($curTarget) -and ($curTarget.Trim().ToLowerInvariant() -eq $TargetExe.Trim().ToLowerInvariant())) {
      if ([string]$sc.IconLocation -ne $IconLocation) {
        $sc.IconLocation = $IconLocation
        $sc.Save()
      }
    }
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
    $wdScriptPath = Join-Path $NodeRoot 'imcodes-node-health-watchdog.ps1'
    $wdBodyTemplate = @'
$ErrorActionPreference = 'Stop'
$nodePath = '__NODE_EXE_PATH__'
$nodeRoot = Split-Path -Parent $nodePath
$nodeTask = 'imcodes-node'
$credPath = Join-Path $nodeRoot 'credential.json'
$leasePath = Join-Path $nodeRoot 'health-lease.json'
$livenessPath = Join-Path $nodeRoot 'liveness-lease.json'
$statePath = Join-Path $nodeRoot 'health-watchdog-state.json'
$logPath = Join-Path $nodeRoot 'health-watchdog.log'
$upgradeMarkerPath = Join-Path $nodeRoot 'upgrade-in-progress.json'
$keepDisabledMarkerPath = Join-Path $nodeRoot 'watchdog-keep-disabled'
$staleSeconds = 180
$minimumConfirmMs = 45000
function Write-HealthLog([string]$message) {
  if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 2MB) {
    Move-Item -Force -LiteralPath $logPath -Destination ($logPath + '.1')
  }
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value (('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message))
}
function Write-WatchdogState([string]$reason, [int]$processId, [int64]$observedAt) {
  $stateTempPath = $statePath + '.' + $PID + '.tmp'
  @{ version = 1; reason = $reason; pid = $processId; observedAt = $observedAt } | ConvertTo-Json -Compress | Set-Content -LiteralPath $stateTempPath -Encoding UTF8
  Move-Item -Force -LiteralPath $stateTempPath -Destination $statePath
}
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if (Test-Path -LiteralPath $upgradeMarkerPath) {
  try {
    $um = Get-Content -LiteralPath $upgradeMarkerPath -Raw | ConvertFrom-Json
    $uAge = $nowMs - [int64]$um.startedAt
    if ($um.taskName) {
      $ut = Get-ScheduledTask -TaskName ([string]$um.taskName) -ErrorAction SilentlyContinue
      if ($ut) { exit 0 }
    }
    if ([int]$um.version -eq 1 -and $uAge -ge -60000 -and $uAge -le 900000) { exit 0 }
  } catch {}
  Remove-Item -Force -LiteralPath $upgradeMarkerPath -ErrorAction SilentlyContinue
}
$process = Get-Process -Name 'imcodes-node' -ErrorAction SilentlyContinue | Where-Object {
  try { $_.Path -eq $nodePath } catch { $false }
} | Select-Object -First 1
$nodeTaskInfo = Get-ScheduledTask -TaskName $nodeTask -ErrorAction SilentlyContinue
if (-not $nodeTaskInfo) {
  Write-WatchdogState 'task_missing' 0 $nowMs
  exit 0
}
$taskDisabled = ([int]$nodeTaskInfo.State -eq 1 -or $nodeTaskInfo.Settings.Enabled -eq $false)
if ($taskDisabled -and (Test-Path -LiteralPath $keepDisabledMarkerPath)) {
  Write-WatchdogState 'task_disabled_kept' 0 $nowMs
  exit 0
}
if (-not (Test-Path -LiteralPath $credPath -PathType Leaf)) {
  if ($process) {
    Write-WatchdogState 'pending_setup' ([int]$process.Id) $nowMs
    exit 0
  }
  if (-not $taskDisabled) {
    try { Start-ScheduledTask -TaskName $nodeTask -ErrorAction Stop } catch {}
  }
  exit 0
}
$previousState = $null
if (Test-Path -LiteralPath $statePath) {
  try { $previousState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch {
    Remove-Item -Force -LiteralPath $statePath -ErrorAction SilentlyContinue
  }
}
$healthy = $false
$reason = 'process_missing'
if ($process) {
  $reason = 'lease_missing'
  foreach ($candidatePath in @($livenessPath, $leasePath)) {
    if (-not (Test-Path -LiteralPath $candidatePath)) { continue }
    try {
      $lease = Get-Content -LiteralPath $candidatePath -Raw | ConvertFrom-Json
      $ageMs = $nowMs - [int64]$lease.updatedAt
      if ([int]$lease.version -eq 1 -and [int]$lease.pid -eq [int]$process.Id -and $ageMs -ge -60000 -and $ageMs -le ($staleSeconds * 1000)) {
        $healthy = $true
        break
      }
      $reason = 'lease_stale'
    } catch { $reason = 'lease_invalid' }
  }
  if (-not $healthy) {
    $processAgeSeconds = ((Get-Date) - $process.StartTime).TotalSeconds
    if ($processAgeSeconds -lt $staleSeconds) {
      Write-WatchdogState 'process_start_grace' ([int]$process.Id) $nowMs
      exit 0
    }
  }
}
if ($healthy) {
  Write-WatchdogState 'healthy' ([int]$process.Id) $nowMs
  exit 0
}
$previousValid = $previousState -and [int]$previousState.version -eq 1 -and $null -ne $previousState.observedAt
if ($process -and -not ($previousValid -and [string]$previousState.reason -eq $reason -and [int]$previousState.pid -eq [int]$process.Id -and ($nowMs - [int64]$previousState.observedAt) -ge $minimumConfirmMs)) {
  Write-WatchdogState $reason ([int]$process.Id) $nowMs
  Write-HealthLog ('grace_begin reason={0} pid={1}' -f $reason, $process.Id)
  exit 0
}
if ($taskDisabled) {
  try { Enable-ScheduledTask -TaskName $nodeTask -ErrorAction Stop | Out-Null; Write-HealthLog 'task_disabled_reenabled' } catch { exit 0 }
}
Write-HealthLog ('restart_begin reason={0} pid={1}' -f $reason, $(if ($process) { $process.Id } else { 0 }))
Stop-ScheduledTask -TaskName $nodeTask -ErrorAction SilentlyContinue
if ($process) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
try { Start-ScheduledTask -TaskName $nodeTask -ErrorAction Stop } catch { Write-WatchdogState 'start_failed' 0 $nowMs; exit 0 }
Remove-Item -Force -LiteralPath $statePath -ErrorAction SilentlyContinue
Write-HealthLog 'restart_requested'
'@
    $wdScriptBody = $wdBodyTemplate.Replace('__NODE_EXE_PATH__', $nodeExe.Replace("'", "''")) + "\`r\`n"
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
      $markerPath = Join-Path $NodeRoot 'upgrade-in-progress.json'
      Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
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
      Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c call "' + $AutostartPath + '"') -WindowStyle Hidden | Out-Null
    }
  }
}

if ($Mode -eq 'Rollback') {
  try {
    Write-InstallerLog "Starting Rollback snapshotDir=$SnapshotDir"
    $manifestPath = if ($SnapshotDir.EndsWith('.json')) { $SnapshotDir } else { Join-Path $SnapshotDir 'snapshot.json' }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      throw "Rollback snapshot not found: $manifestPath"
    }
    $snap = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $shouldRollbackServices = $ApplyServices -or ($snap.services -and $snap.services.applyRecorded)

    # Step 1: Stop installed/running tasks, managed node/sidecars, and verified daemon process BEFORE restoring files
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
      Stop-ControlledNodeAndSidecarsForInstall
    }

    # Step 2: Restore file/dir/reparse/absent entries and verify preserved checksums/databases
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
      if (Test-DatabaseFileName $chk.path) {
        $verified++
        continue
      }
      $actual = Get-FileSha256Hex $chk.path
      if ($actual -ne $chk.sha256) {
        throw "preserved_state_checksum_mismatch: $($chk.path)"
      }
      $verified++
    }
    if ($snap.PSObject.Properties['preservedDatabases'] -and $snap.preservedDatabases) {
      foreach ($dbp in $snap.preservedDatabases) {
        if (-not (Test-Path -LiteralPath $dbp -PathType Leaf)) {
          throw "preserved_state_missing_during_rollback: $dbp"
        }
        $verified++
      }
    }

    # Step 3: Reconcile task registration/enablement/running state and old user daemon
    Remove-Item -LiteralPath (Join-Path $NodeRoot 'upgrade-in-progress.json') -Force -ErrorAction SilentlyContinue
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
          Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c call "' + $AutostartPath + '"') -WindowStyle Hidden | Out-Null
        }
      }
    }
    Write-InstallerLog "Rollback completed restored=$restored removed=$removed verified=$verified"
    [ordered]@{ restoredCount = $restored; removedCount = $removed; verifiedPreservedCount = $verified } | ConvertTo-Json -Depth 4
    exit 0
  } catch {
    Write-InstallerLog ("FATAL: " + $_.Exception.Message)
    if ($_.ScriptStackTrace) { Write-InstallerLog ([string]$_.ScriptStackTrace) }
    throw
  }
}

$plan = Invoke-PhaseAProbe
if ($Mode -eq 'PreInstall') {
  try {
    Write-InstallerLog "Starting PreInstall version=$Version scenario=$($plan.scenario) nodeRoot=$NodeRoot runtimeRoot=$RuntimeRoot sqliteCount=$($plan.sqliteCount)"
    $preServiceSnap = Get-WindowsServicesSnapshot
    Save-RollbackSnapshot $plan $preServiceSnap
    Write-InstallerLog "Saved rollback snapshot to $SnapshotDir"
    [void](Assert-SingleInstanceLockAndStop $plan)
    Stop-ControlledNodeAndSidecarsForInstall
    Write-InstallerLog "Completed PreInstall"
    $plan | Add-Member -NotePropertyName snapshotDir -NotePropertyValue $SnapshotDir -Force
    $plan | ConvertTo-Json -Depth 6
    exit 0
  } catch {
    Write-InstallerLog ("FATAL: " + $_.Exception.Message)
    if ($_.ScriptStackTrace) { Write-InstallerLog ([string]$_.ScriptStackTrace) }
    throw
  }
}

function Add-UserPathEntry([string]$DirPath) {
  if ([string]::IsNullOrWhiteSpace($DirPath)) { return }
  $curPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrWhiteSpace($curPath)) {
    [Environment]::SetEnvironmentVariable('Path', $DirPath, 'User')
  } elseif (($curPath.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\\').ToLowerInvariant() -eq $DirPath.TrimEnd('\\').ToLowerInvariant()) }).Count -eq 0) {
    [Environment]::SetEnvironmentVariable('Path', "$curPath;$DirPath", 'User')
  }
}

function Test-IsElevatedOrSystemProcess {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -ne $id.User -and $id.User.Value -eq 'S-1-5-18') { return $true }
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $true
  }
}

function Test-PathHasReparsePoint([string]$CandidatePath) {
  if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return $false }
  if (Test-Path -LiteralPath $CandidatePath) {
    try {
      $item = Get-Item -LiteralPath $CandidatePath -Force -ErrorAction Stop
      if ($null -ne $item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { return $true }
    } catch {}
  } else {
    try {
      $attrs = [System.IO.File]::GetAttributes($CandidatePath)
      if ([int]$attrs -ne -1 -and ($attrs -band [System.IO.FileAttributes]::ReparsePoint)) { return $true }
    } catch {}
  }
  return $false
}

function Format-OpenCodeLogDetail([string]$RawOutput) {
  if ([string]::IsNullOrWhiteSpace($RawOutput)) { return '' }
  $clean = (($RawOutput -replace "[\\r\\n]+", ' | ').Trim())
  if ($clean.Length -gt 500) { $clean = $clean.Substring(0, 500) + '...' }
  return $clean
}

function Install-OpenCodeCliBestEffort {
  try {
    if ($SkipOpenCode) {
      Write-InstallerLog 'Skipping OpenCode CLI install (-SkipOpenCode)'
      return
    }
    $skipRaw = [string]$env:IMCODES_SKIP_OPENCODE
    if ($skipRaw -and ($skipRaw.Trim() -imatch '^(1|true|yes)$')) {
      Write-InstallerLog 'Skipping OpenCode CLI install (IMCODES_SKIP_OPENCODE)'
      return
    }
    $hookPath = if (-not [string]::IsNullOrWhiteSpace($OpenCodeInstallHook)) { $OpenCodeInstallHook } else { [string]$env:IMCODES_OPENCODE_INSTALL_HOOK }
    if (-not [string]::IsNullOrWhiteSpace($IsolatedRoot) -and [string]::IsNullOrWhiteSpace($hookPath) -and [string]::IsNullOrWhiteSpace($env:IMCODES_OPENCODE_REGISTRY)) {
      Write-InstallerLog 'Skipping OpenCode CLI install in isolated test mode'
      return
    }
    $ocBaseDir = Join-Path $HomeDir '.opencode'
    $ocBinDir = Join-Path $ocBaseDir 'bin'
    $ocExePath = Join-Path $ocBinDir 'opencode.exe'
    foreach ($ocCheckPath in @($ocBaseDir, $ocBinDir, $ocExePath)) {
      if (Test-PathHasReparsePoint $ocCheckPath) {
        Write-InstallerLog ("WARNING: refusing symlink/reparse OpenCode target $ocCheckPath; skipping OpenCode CLI install (non-blocking)")
        return
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($IsolatedRoot)) {
      Assert-SafeTargetPath $ocBaseDir $RealProfile -EntryMode
      Assert-SafeTargetPath $ocBinDir $RealProfile -EntryMode
      Assert-SafeTargetPath $ocExePath $RealProfile -EntryMode
    }

    if (Test-IsElevatedOrSystemProcess) {
      Write-InstallerLog 'WARNING: unable to confirm non-elevated target user context; skipping OpenCode CLI install (non-blocking)'
      return
    }

    $runtimeBinBase = if (Test-Path -LiteralPath (Join-Path $ReleaseDir 'node.exe') -PathType Leaf) { $ReleaseDir } else { $CurrentDir }
    $nodeExe = Join-Path $runtimeBinBase 'node.exe'
    $ocInstallerJs = Join-Path $runtimeBinBase 'package\\dist\\src\\node\\install-opencode-cli.js'

    $execExe = ''
    $execArgs = @()
    $isHookRun = $false

    if (-not [string]::IsNullOrWhiteSpace($hookPath) -and (Test-Path -LiteralPath $hookPath -PathType Leaf)) {
      $isHookRun = $true
      $execExe = $hookPath
      $execArgs = @('-HomeDir', $HomeDir)
    } elseif ((Test-Path -LiteralPath $nodeExe -PathType Leaf) -and (Test-Path -LiteralPath $ocInstallerJs -PathType Leaf)) {
      $execExe = $nodeExe
      $execArgs = @($ocInstallerJs, '--home', $HomeDir, '--strict')
      if (-not [string]::IsNullOrWhiteSpace($IsolatedRoot)) {
        $execArgs += @('--registry', [string]$env:IMCODES_OPENCODE_REGISTRY, '--no-fallback', '--isolated-test')
      }
    } else {
      return
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $rawOut = (& $execExe @execArgs 2>&1 | Out-String)
      $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
    } finally {
      $ErrorActionPreference = $prevEap
    }

    $detail = Format-OpenCodeLogDetail $rawOut
    if ($exitCode -ne 0) {
      $label = if ($isHookRun) { 'OpenCode CLI install hook' } else { 'OpenCode CLI install' }
      $suffix = if (-not [string]::IsNullOrWhiteSpace($detail)) { ': ' + $detail } else { '' }
      Write-InstallerLog ("WARNING: $label failed exit=$exitCode (non-blocking)" + $suffix)
    } elseif (-not [string]::IsNullOrWhiteSpace($detail)) {
      Write-InstallerLog ("OpenCode CLI: " + $detail)
    }

    if ($AllowSystemRoot -and [string]::IsNullOrWhiteSpace($IsolatedRoot)) {
      if (Test-Path -LiteralPath $ocExePath -PathType Leaf) {
        try { Add-UserPathEntry $ocBinDir } catch { Write-InstallerLog ("WARNING: Failed to add $ocBinDir to User PATH: " + $_.Exception.Message) }
      }
    }
  } catch {
    Write-InstallerLog ("WARNING: OpenCode CLI install failed (non-blocking): " + $_.Exception.Message)
  }
}

if ($Mode -eq 'InstallOpenCode') {
  try {
    Write-InstallerLog "Starting InstallOpenCode version=$Version homeDir=$HomeDir"
    Install-OpenCodeCliBestEffort
    Write-InstallerLog 'Completed InstallOpenCode'
    exit 0
  } catch {
    Write-InstallerLog ("WARNING: InstallOpenCode failed (non-blocking): " + $_.Exception.Message)
    exit 0
  }
}

try {
Write-InstallerLog "Starting PostInstall version=$Version scenario=$($plan.scenario) nodeRoot=$NodeRoot runtimeRoot=$RuntimeRoot"
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
$installedIconFile = Join-Path $NodeRoot 'aidesk.ico'
$shortcutIconLocation = if (Test-Path -LiteralPath $installedIconFile -PathType Leaf) { "$installedIconFile,0" } else { '' }
if (Test-Path -LiteralPath $installedNodeExe -PathType Leaf) {
  $isCleanInstall = ($plan.scenario -eq 'clean')
  Sync-WindowsAideskShortcut $StartMenuShortcutPath $installedNodeExe '--open-local-panel' $shortcutIconLocation $isCleanInstall
  Sync-WindowsAideskShortcut $DesktopShortcutPath $installedNodeExe '--open-local-panel' $shortcutIconLocation $isCleanInstall
}
if ($AllowSystemRoot -and [string]::IsNullOrWhiteSpace($IsolatedRoot)) {
  Add-UserPathEntry (Split-Path -Parent $CliWrapperPath)
}
function Ensure-WindowsReleasePublisherTrust([string]$TargetPath, [string]$ExpectedSha256) {
  if ([string]::IsNullOrWhiteSpace($TargetPath) -or -not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) { return }
  $expected = ([string]$ExpectedSha256).Trim().ToLowerInvariant()
  if ($expected -cnotmatch '^[a-f0-9]{64}$') { return }
  $secMod = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'
  if (Test-Path -LiteralPath $secMod -PathType Leaf) {
    Import-Module $secMod -ErrorAction SilentlyContinue | Out-Null
  }
  $sig = Get-AuthenticodeSignature -LiteralPath $TargetPath
  if ($null -eq $sig.SignerCertificate) { throw 'release signer certificate is missing' }
  $signer = $sig.SignerCertificate
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $actual = [BitConverter]::ToString($sha.ComputeHash($signer.RawData)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  if ($actual -cne $expected) { throw 'release signer does not match expected trust anchor' }
  $hasCodeSigningEku = $false
  foreach ($ext in $signer.Extensions) {
    if ($ext.Oid.Value -eq '2.5.29.37') {
      $eku = New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($ext, $ext.Critical)
      foreach ($oid in $eku.EnhancedKeyUsages) {
        if ($oid.Value -eq '1.3.6.1.5.5.7.3.3') { $hasCodeSigningEku = $true }
      }
    }
  }
  if (-not $hasCodeSigningEku) { throw 'release signer is not valid for code signing' }
  foreach ($storeName in @('TrustedPeople', 'TrustedPublisher')) {
    $present = $false
    foreach ($existingCert in @(Get-ChildItem -LiteralPath ('Cert:\\LocalMachine\\' + $storeName) -ErrorAction SilentlyContinue)) {
      $shaExisting = [System.Security.Cryptography.SHA256]::Create()
      try {
        $existingHex = [BitConverter]::ToString($shaExisting.ComputeHash($existingCert.RawData)).Replace('-', '').ToLowerInvariant()
      } finally {
        $shaExisting.Dispose()
      }
      if ($existingHex -ceq $expected) { $present = $true; break }
    }
    if (-not $present) {
      $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
      $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
      try { $store.Add($signer) } finally { $store.Close() }
    }
  }
  $verified = Get-AuthenticodeSignature -LiteralPath $TargetPath
  if ($verified.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw ("release publisher trust installation did not validate artifact: " + [string]$verified.Status)
  }
}

function Install-RemoteDesktopVirtualDisplay {
  $rdRoot = Join-Path $NodeRoot 'remote-desktop-worker'
  if (-not (Test-Path -LiteralPath $rdRoot -PathType Container)) { return }
  $rdPlatform = Join-Path $rdRoot 'win32-x64'
  $legacyArchive = Join-Path $rdRoot 'imcodes-virtual-display.zip'
  if (-not (Test-Path -LiteralPath $rdPlatform -PathType Container) -and (Test-Path -LiteralPath $legacyArchive -PathType Leaf)) {
    New-Item -ItemType Directory -Force -Path $rdPlatform | Out-Null
    foreach ($fn in @('imcodes-remote-desktop-worker.exe', 'imcodes-remote-desktop-worker.exe.manifest.json', 'imcodes-virtual-display.zip')) {
      $legacyFile = Join-Path $rdRoot $fn
      if (Test-Path -LiteralPath $legacyFile -PathType Leaf) {
        Move-Item -LiteralPath $legacyFile -Destination (Join-Path $rdPlatform $fn) -Force
      }
    }
  }
  $vdArchive = Join-Path $rdPlatform 'imcodes-virtual-display.zip'
  if (-not (Test-Path -LiteralPath $vdArchive -PathType Leaf)) { return }
  $vdDir = Join-Path $rdPlatform 'virtual-display'
  $vdTmp = Join-Path $rdPlatform ('virtual-display.tmp.' + $PID)
  Remove-PathSafely $vdTmp
  New-Item -ItemType Directory -Force -Path $vdTmp | Out-Null
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($vdArchive, $vdTmp)
    Remove-PathSafely $vdDir
    Move-Item -LiteralPath $vdTmp -Destination $vdDir -Force
  } catch {
    Remove-PathSafely $vdTmp
    throw
  }
  if ($ApplyServices -and [string]::IsNullOrWhiteSpace($IsolatedRoot) -and (Test-CanControlNativeWindowsTasks)) {
    if ($TrustedSignerSha256 -cmatch '^[a-f0-9]{64}$') {
      $trustTarget = Join-Path $vdDir 'imcodes-virtual-display.cat'
      if (-not (Test-Path -LiteralPath $trustTarget -PathType Leaf)) {
        $trustTarget = Join-Path $NodeRoot 'imcodes-node.exe'
      }
      Ensure-WindowsReleasePublisherTrust $trustTarget $TrustedSignerSha256
    }
    $vdInf = Join-Path $vdDir 'imcodes-virtual-display.inf'
    if (Test-Path -LiteralPath $vdInf -PathType Leaf) {
      $pnputilExe = Join-Path $env:WINDIR 'System32\\pnputil.exe'
      if (Test-Path -LiteralPath $pnputilExe -PathType Leaf) {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
          & $pnputilExe /add-driver $vdInf /install 2>&1 | Out-Null
          $pnpExit = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $prevEap
        }
        if ($pnpExit -ne 0 -and $pnpExit -ne 3010) {
          throw "virtual_display_driver_install_failed: exit=$pnpExit"
        }
      }
    }
  }
}

function Test-RemoteDesktopWorkerManifestIntegrity {
  $rdPlatform = Join-Path (Join-Path $NodeRoot 'remote-desktop-worker') 'win32-x64'
  $workerExe = Join-Path $rdPlatform 'imcodes-remote-desktop-worker.exe'
  $workerManifest = Join-Path $rdPlatform 'imcodes-remote-desktop-worker.exe.manifest.json'
  if (-not (Test-Path -LiteralPath $workerExe -PathType Leaf)) { return }
  if (-not (Test-Path -LiteralPath $workerManifest -PathType Leaf)) { return }
  try {
    $manifestRaw = Get-Content -LiteralPath $workerManifest -Raw
    $manifestObj = $manifestRaw | ConvertFrom-Json
  } catch {
    $msg = ("remote_desktop_worker_manifest_invalid: unreadable_json manifest=" + $workerManifest + " err=" + $_.Exception.Message)
    Write-InstallerLog ("ERROR: " + $msg)
    throw $msg
  }
  $expectedSha = ''
  if ($null -ne $manifestObj) {
    if ($manifestObj.PSObject.Properties['sha256'] -and $null -ne $manifestObj.sha256) {
      $expectedSha = ([string]$manifestObj.sha256).Trim().ToLowerInvariant()
    } elseif ($manifestObj.PSObject.Properties['artifact'] -and $null -ne $manifestObj.artifact -and $manifestObj.artifact.PSObject.Properties['sha256'] -and $null -ne $manifestObj.artifact.sha256) {
      $expectedSha = ([string]$manifestObj.artifact.sha256).Trim().ToLowerInvariant()
    }
  }
  if ($expectedSha -cnotmatch '^[a-f0-9]{64}$') {
    $msg = ("remote_desktop_worker_manifest_invalid: missing_or_invalid_sha256 manifest=" + $workerManifest)
    Write-InstallerLog ("ERROR: " + $msg)
    throw $msg
  }
  $actualSha = (Get-FileSha256Hex $workerExe).ToLowerInvariant()
  if ($actualSha -cne $expectedSha) {
    $msg = ("remote_desktop_worker_manifest_mismatch: expected=" + $expectedSha + " actual=" + $actualSha + " exe=" + $workerExe + " manifest=" + $workerManifest)
    Write-InstallerLog ("ERROR: " + $msg)
    throw $msg
  }
  Write-InstallerLog ("Verified remote desktop worker SHA-256 matches manifest sha256=" + $actualSha)
}

Install-RemoteDesktopVirtualDisplay
Test-RemoteDesktopWorkerManifestIntegrity
Install-OpenCodeCliBestEffort
Remove-Item -LiteralPath (Join-Path $NodeRoot 'upgrade-in-progress.json') -Force -ErrorAction SilentlyContinue
if ($ApplyServices) {
  Register-WindowsServices $plan $stoppedDaemon
}

Write-InstallerLog "Completed PostInstall"
$plan | Add-Member -NotePropertyName snapshotDir -NotePropertyValue $SnapshotDir -Force
$plan | ConvertTo-Json -Depth 6
} catch {
  Write-InstallerLog ("FATAL: " + $_.Exception.Message)
  if ($_.ScriptStackTrace) { Write-InstallerLog ([string]$_.ScriptStackTrace) }
  throw
}
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
  hasAideskIcon = false,
  signToolCommand,
}) {
  const outName = outputBaseFilename ?? `imcodes-desktop-${version}-win32-${arch}`;
  const filesEntries = [
    `Source: "${stageDirRelative}\\imcodes-windows-installer.ps1"; DestName: "imcodes-windows-installer.ps1"; Flags: dontcopy`,
  ];
  if (hasAideskIcon) {
    filesEntries.push(
      `Source: "${stageDirRelative}\\controlled-node\\aidesk.ico"; DestDir: "{commonappdata}\\imcodes-node"; Flags: ignoreversion`,
    );
  }
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
  filesEntries.push(
    `Source: "${stageDirRelative}\\daemon-runtime\\*"; DestDir: "{commonpf}\\IM.codes\\daemon-runtime\\releases\\${version}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    `Source: "${stageDirRelative}\\imcodes-windows-installer.ps1"; DestDir: "{app}"; Flags: ignoreversion`,
    `Source: "${stageDirRelative}\\imcodes.cmd"; DestDir: "{app}"; DestName: "imcodes.cmd.staged"; Flags: ignoreversion`,
  );

  return `; IM.codes Desktop 3-in-1 Installer (Inno Setup 6)
; Supports interactive UAC install as well as /SILENT and /VERYSILENT unattended installs.

[Setup]
AppId={{B3D77D71-3F7E-498E-B784-410C26C56F1A}
AppName=aiDesk.to by IM.codes
AppVersion=${version}
AppPublisher=IM.codes
DefaultDirName={commonpf}\\IM.codes
DefaultGroupName=aiDesk.to by IM.codes
${hasAideskIcon ? `SetupIconFile=${stageDirRelative}\\controlled-node\\aidesk.ico\nUninstallDisplayIcon={commonappdata}\\imcodes-node\\aidesk.ico\n` : ''}ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
Compression=lzma2/fast
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=4
WizardStyle=modern
OutputDir=output
OutputBaseFilename=${outName}
${signToolCommand ? `SignTool=${signToolCommand}` : '; Code signing runs externally via scripts/windows-sign-release-artifact.ps1 when cert is configured'}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
${filesEntries.join('\n')}

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\\imcodes-windows-installer.ps1"" -Mode InstallOpenCode -AllowSystemRoot -Version ""${version}"" -RuntimeRoot ""{commonpf}\\IM.codes\\daemon-runtime"""; Flags: runhidden waituntilterminated runasoriginaluser
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\\imcodes-windows-installer.ps1"" -Mode PostInstall -AllowSystemRoot -SkipOpenCode -ApplyServices -Version ""${version}"" -RuntimeRoot ""{commonpf}\\IM.codes\\daemon-runtime"" -NodeRoot ""{commonappdata}\\imcodes-node"" -CliWrapperPath ""{localappdata}\\imcodes\\bin\\imcodes.cmd"" -StagedCliWrapper ""{app}\\imcodes.cmd.staged"" -LogPath ""{commonappdata}\\imcodes-node\\installer-postinstall.log"""; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\\imcodes-windows-installer.ps1"" -Mode Rollback -AllowSystemRoot -ApplyServices -SnapshotDir ""{commonappdata}\\imcodes-node\\installer-rollback-${version}"" -LogPath ""{commonappdata}\\imcodes-node\\installer-rollback.log"""; Flags: runhidden waituntilterminated; RunOnceId: "IMCodesDesktopRollback"

[Code]
function ReadInstallerLogTail(const LogFile: String): String;
var
  Lines: TArrayOfString;
  StartIdx, I: Integer;
  Acc: String;
begin
  Result := '';
  if not FileExists(LogFile) then Exit;
  if not LoadStringsFromFile(LogFile, Lines) then Exit;
  StartIdx := GetArrayLength(Lines) - 10;
  if StartIdx < 0 then StartIdx := 0;
  Acc := '';
  for I := StartIdx to GetArrayLength(Lines) - 1 do begin
    if Trim(Lines[I]) <> '' then
      Acc := Acc + #13#10 + Lines[I];
  end;
  Result := Acc;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  PsScriptPath: String;
  LogFilePath: String;
  LogTail: String;
  Args: String;
begin
  if CurStep = ssInstall then begin
    WizardForm.StatusLabel.Caption := 'Stopping background services and preparing upgrade...';
    WizardForm.StatusLabel.Refresh;
    ExtractTemporaryFile('imcodes-windows-installer.ps1');
    PsScriptPath := ExpandConstant('{tmp}\\imcodes-windows-installer.ps1');
    LogFilePath := ExpandConstant('{commonappdata}\\imcodes-node\\installer-preinstall.log');
    ForceDirectories(ExtractFileDir(LogFilePath));
    Args := '-NoProfile -ExecutionPolicy Bypass -File "' + PsScriptPath + '" -Mode PreInstall -AllowSystemRoot -ApplyServices -Version "${version}" -RuntimeRoot "' + ExpandConstant('{commonpf}\\IM.codes\\daemon-runtime') + '" -NodeRoot "' + ExpandConstant('{commonappdata}\\imcodes-node') + '" -CliWrapperPath "' + ExpandConstant('{localappdata}\\imcodes\\bin\\imcodes.cmd') + '" -LogPath "' + LogFilePath + '"';
    if not Exec('powershell.exe', Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then begin
      LogTail := ReadInstallerLogTail(LogFilePath);
      RaiseException('IM.codes PreInstall check failed with exit code ' + IntToStr(ResultCode) + ' (log: ' + LogFilePath + ')' + LogTail);
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

/**
 * Resolve and validate Windows Authenticode signing configuration, failing closed on partial or malformed inputs.
 */
export function resolveWindowsSigningConfig(options = {}) {
  const thumbprint = String(
    options.signingThumbprint ?? process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT ?? '',
  ).trim();
  const expectedSha256 = String(
    options.expectedSignerSha256 ?? process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256 ?? '',
  )
    .trim()
    .toLowerCase();
  const timestampUrl =
    String(options.timestampUrl ?? process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL ?? '').trim() ||
    'http://timestamp.digicert.com';

  if (Boolean(thumbprint) !== Boolean(expectedSha256)) {
    throw new Error(
      'Windows installer signing requires both IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT and IMCODES_WINDOWS_SIGNING_CERT_SHA256',
    );
  }
  if (!thumbprint) {
    return null;
  }
  if (!/^[a-f0-9]{40}$/i.test(thumbprint)) {
    throw new Error('Windows installer signing thumbprint must be 40-char SHA-1 hex');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error('Windows installer expected signer SHA-256 must be 64-char SHA-256 hex');
  }
  return { thumbprint, expectedSha256, timestampUrl };
}

function runWindowsSigningScript(scriptArgs) {
  const signScript = join(REPO_ROOT, 'scripts', 'windows-sign-release-artifact.ps1');
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', signScript, ...scriptArgs],
    { stdio: 'inherit' },
  );
}

function resolveWindowsTrustedSignerSha256(options = {}) {
  const explicit = String(
    options.expectedSignerSha256 ?? process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256 ?? '',
  )
    .trim()
    .toLowerCase();
  if (/^[a-f0-9]{64}$/.test(explicit)) return explicit;
  const manifestCandidates = [];
  if (options.nodeExe) manifestCandidates.push(`${resolve(options.nodeExe)}.manifest.json`);
  if (options.remoteDesktopDir) {
    const rdRoot = resolve(options.remoteDesktopDir);
    manifestCandidates.push(
      join(rdRoot, 'imcodes-remote-desktop-worker.exe.manifest.json'),
      join(rdRoot, 'win32-x64', 'imcodes-remote-desktop-worker.exe.manifest.json'),
    );
  }
  for (const cand of manifestCandidates) {
    if (!existsSync(cand)) continue;
    try {
      const parsed = JSON.parse(readFileSync(cand, 'utf8'));
      const signer = String(
        parsed?.artifact?.authenticodeSignerSha256 ?? parsed?.authenticodeSignerSha256 ?? '',
      )
        .trim()
        .toLowerCase();
      if (/^[a-f0-9]{64}$/.test(signer)) return signer;
    } catch {}
  }
  return '';
}

export async function buildWindowsInstaller(options) {
  const arch = 'x64';
  const targetInfo = parseDaemonRuntimeTarget('win32', arch);
  const version = resolveDesktopInstallerVersion(options.version);
  const outDir = resolve(options.outDir ?? join(REPO_ROOT, 'dist-node-exe', 'installers'));
  mkdirSync(outDir, { recursive: true });

  const compat = await loadDesktopCompatibilityModule();
  const userStateDirName = await loadImcodesStateDirName();
  const cliWrapperContent = compat.renderWindowsImcodesCliWrapper({ userStateDirName });
  const trustedSignerSha256 = resolveWindowsTrustedSignerSha256(options);
  const ps1Content = renderWindowsPhaseAInstallerPs1({
    version,
    cliWrapperContent,
    minVersion: options.minVersion ?? '',
    trustedSignerSha256,
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
    writeFileSync(join(nodeStage, 'aidesk.ico'), await buildIco());
    const hasAideskIcon = true;
    let hasNodeExe = false;
    let hasRemoteDesktop = false;
    let hasComputerUse = false;
    let hasLocalUi = false;

    if (options.nodeExe && existsSync(options.nodeExe)) {
      cpSync(resolve(options.nodeExe), join(nodeStage, 'imcodes-node.exe'));
      hasNodeExe = true;
    }
    if (options.remoteDesktopDir && existsSync(options.remoteDesktopDir)) {
      const resolvedRdDir = resolve(options.remoteDesktopDir);
      const platformRdDir = join(resolvedRdDir, 'win32-x64');
      const sourceRdDir = existsSync(platformRdDir) ? platformRdDir : resolvedRdDir;
      cpSync(sourceRdDir, join(nodeStage, 'remote-desktop-worker', 'win32-x64'), {
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
      const resolvedUiDir = resolve(options.localUiDir);
      const platformUiDir = join(resolvedUiDir, 'win32-x64');
      const sourceUiDir = existsSync(platformUiDir) ? platformUiDir : resolvedUiDir;
      cpSync(sourceUiDir, join(nodeStage, 'aidesk-local-ui', 'win32-x64'), {
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
      hasAideskIcon,
    });
    const workIssPath = join(workDir, issFilename);
    writeFileSync(workIssPath, issContent, 'utf8');
    writeFileSync(issPath, issContent, 'utf8');

    const isccExe = findWindowsIsccExecutable(options.isccPath);
    let exePath;
    let signed = false;
    if (isccExe) {
      const signingConfig = resolveWindowsSigningConfig(options);
      execFileSync(isccExe, [`/O${outDir}`, workIssPath], { stdio: 'inherit' });
      exePath = join(outDir, `imcodes-desktop-${version}-win32-${arch}.exe`);
      if (signingConfig) {
        runWindowsSigningScript([
          '-Mode',
          'Sign',
          '-ArtifactPath',
          exePath,
          '-CodeSigningCertificateThumbprint',
          signingConfig.thumbprint,
          '-ExpectedSignerSha256',
          signingConfig.expectedSha256,
          '-TimestampUrl',
          signingConfig.timestampUrl,
        ]);
        runWindowsSigningScript([
          '-Mode',
          'Verify',
          '-ArtifactPath',
          exePath,
          '-ExpectedSignerSha256',
          signingConfig.expectedSha256,
        ]);
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

export function parseCliArgs(argv) {
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
    else if (token === '--signing-thumbprint') args.signingThumbprint = argv[++i];
    else if (token === '--expected-signer-sha256') args.expectedSignerSha256 = argv[++i];
    else if (token === '--timestamp-url') args.timestampUrl = argv[++i];
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
