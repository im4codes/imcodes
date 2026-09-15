param(
  [ValidateSet('Install', 'Remove')]
  [string]$Mode = 'Install',
  [Parameter(Mandatory = $true)]
  [string]$WatchdogPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSignerSha256
)

$ErrorActionPreference = 'Stop'
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $SourceDirectory)
$SigningScript = Join-Path $RepositoryRoot 'scripts\windows-sign-release-artifact.ps1'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'IMcodesClipboardSanitizer'

if ($Mode -eq 'Remove') {
  Remove-ItemProperty -LiteralPath $RunKey -Name $RunName -ErrorAction SilentlyContinue
  exit 0
}

if ($ExpectedSignerSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
  throw 'ExpectedSignerSha256 must be SHA-256 hex.'
}
$ResolvedWatchdog = (Resolve-Path -LiteralPath $WatchdogPath).Path
if ([System.IO.Path]::GetExtension($ResolvedWatchdog) -cne '.exe') {
  throw 'WatchdogPath must name the signed executable.'
}
$WatchdogItem = Get-Item -LiteralPath $ResolvedWatchdog
if (-not $WatchdogItem.Exists -or $WatchdogItem.PSIsContainer -or
    ($WatchdogItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw 'WatchdogPath must be a non-reparse regular file.'
}
$ProtectedRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) |
  Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
  ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\') + '\' }
$ProtectedLocation = $ProtectedRoots | Where-Object {
  $ResolvedWatchdog.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1
if (-not $ProtectedLocation) {
  throw 'Watchdog must be installed beneath a protected Program Files root.'
}

& $SigningScript -Mode Verify -ArtifactPath $ResolvedWatchdog `
  -ExpectedSignerSha256 $ExpectedSignerSha256
if ($LASTEXITCODE -ne 0) { throw 'Clipboard watchdog signer verification failed.' }

# Sanitize a marker left by a crashed prior shell before registering future
# logon recovery. A non-zero result leaves the marker intact and blocks setup;
# it never reports cleanup that was not proven.
$Sanitizer = Start-Process -FilePath $ResolvedWatchdog -ArgumentList '--sanitize' `
  -Wait -PassThru -WindowStyle Hidden
if ($Sanitizer.ExitCode -ne 0) {
  throw "Clipboard sanitizer could not prove cleanup ($($Sanitizer.ExitCode))."
}
New-Item -Path $RunKey -Force | Out-Null
$Command = '"' + $ResolvedWatchdog.Replace('"', '') + '" --sanitize'
New-ItemProperty -LiteralPath $RunKey -Name $RunName -PropertyType String `
  -Value $Command -Force | Out-Null
