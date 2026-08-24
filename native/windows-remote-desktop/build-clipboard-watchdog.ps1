param(
  [string]$ArtifactRoot = (Join-Path $env:TEMP 'imcodes-clipboard-watchdog'),
  [string]$VisualStudioRoot = '',
  [Parameter(Mandatory = $true)]
  [string]$CodeSigningCertificateThumbprint,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSignerSha256,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [switch]$RunNativeTests
)

$ErrorActionPreference = 'Stop'
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $SourceDirectory)
$SigningScript = Join-Path $RepositoryRoot 'scripts\windows-sign-release-artifact.ps1'

if ($CodeSigningCertificateThumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
  throw 'A release Authenticode certificate thumbprint is required.'
}
if ($ExpectedSignerSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
  throw 'ExpectedSignerSha256 must be SHA-256 hex.'
}
if ([string]::IsNullOrWhiteSpace($VisualStudioRoot)) {
  $VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path -LiteralPath $VsWhere -PathType Leaf) {
    $VisualStudioRoot = (& $VsWhere -latest -products * `
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -property installationPath).Trim()
  }
}
$VsDevCmd = Join-Path $VisualStudioRoot 'Common7\Tools\VsDevCmd.bat'
if ([string]::IsNullOrWhiteSpace($VisualStudioRoot) -or
    -not (Test-Path -LiteralPath $VsDevCmd -PathType Leaf)) {
  throw 'Visual Studio C++ toolchain not found.'
}

$ArtifactRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArtifactRoot)
$BuildRoot = Join-Path $ArtifactRoot 'build'
$Overlay = Join-Path $BuildRoot 'third_party\imcodes_remote_desktop'
$ReleaseRoot = Join-Path $ArtifactRoot 'release'
Remove-Item -Recurse -Force -LiteralPath $BuildRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Overlay, $ReleaseRoot | Out-Null

$ProductionSources = @(
  'clipboard_watchdog.h',
  'clipboard_watchdog.cc',
  'clipboard_watchdog_main.cc',
  'clipboard_watchdog_policy.h',
  'clipboard_watchdog_policy.cc'
)
foreach ($Name in $ProductionSources) {
  $Source = Get-Item -LiteralPath (Join-Path $SourceDirectory $Name)
  if ($Source.PSIsContainer -or
      ($Source.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "Invalid clipboard watchdog source: $Name"
  }
  Copy-Item -LiteralPath $Source.FullName -Destination (Join-Path $Overlay $Name)
}

$Watchdog = Join-Path $ReleaseRoot 'imcodes-clipboard-watchdog.exe'
$ObjectRoot = Join-Path $BuildRoot 'obj'
New-Item -ItemType Directory -Force -Path $ObjectRoot | Out-Null
$CompileSources = @(
  (Join-Path $Overlay 'clipboard_watchdog.cc'),
  (Join-Path $Overlay 'clipboard_watchdog_main.cc'),
  (Join-Path $Overlay 'clipboard_watchdog_policy.cc')
)
$QuotedSources = ($CompileSources | ForEach-Object { '"' + $_ + '"' }) -join ' '
$CompileCommand = 'call "' + $VsDevCmd + '" -arch=amd64 -host_arch=amd64 && ' +
  'cl.exe /nologo /std:c++20 /permissive- /W4 /WX /O2 /MT /EHsc ' +
  '/DUNICODE /D_UNICODE /I"' + $BuildRoot + '" /Fo"' + $ObjectRoot + '\\" ' +
  $QuotedSources + ' /Fe:"' + $Watchdog + '" /link /SUBSYSTEM:WINDOWS ' +
  '/PDB:"' + (Join-Path $BuildRoot 'clipboard-watchdog.pdb') + '" ' +
  'bcrypt.lib crypt32.lib ole32.lib shell32.lib user32.lib uuid.lib'
& $env:ComSpec /d /s /c $CompileCommand
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Watchdog -PathType Leaf)) {
  throw 'Clipboard watchdog compilation failed.'
}

if ($RunNativeTests) {
  $SelfTest = Join-Path $BuildRoot 'clipboard-watchdog-policy-selftest.exe'
  $SelfTestSource = Join-Path $SourceDirectory 'clipboard_watchdog_policy_selftest.cc'
  $SelfTestCommand = 'call "' + $VsDevCmd + '" -arch=amd64 -host_arch=amd64 && ' +
    'cl.exe /nologo /std:c++20 /permissive- /W4 /WX /O2 /MT /EHsc ' +
    '/I"' + $BuildRoot + '" /Fo"' + $ObjectRoot + '\\" "' + $SelfTestSource + '" "' +
    (Join-Path $Overlay 'clipboard_watchdog_policy.cc') + '" /Fe:"' + $SelfTest + '"'
  & $env:ComSpec /d /s /c $SelfTestCommand
  if ($LASTEXITCODE -ne 0) { throw 'Clipboard watchdog policy test compilation failed.' }
  & $SelfTest
  if ($LASTEXITCODE -ne 0) { throw 'Clipboard watchdog policy tests failed.' }
}

# The watchdog is a separate signed account artifact. It is intentionally not
# copied into the Worker package and therefore cannot inherit capture/input or
# node credentials from that process.
try {
  & $SigningScript -Mode Sign -ArtifactPath $Watchdog `
    -CodeSigningCertificateThumbprint $CodeSigningCertificateThumbprint `
    -ExpectedSignerSha256 $ExpectedSignerSha256 -TimestampUrl $TimestampUrl
  if ($LASTEXITCODE -ne 0) { throw 'Clipboard watchdog signing failed.' }
} catch {
  Remove-Item -Force -LiteralPath $Watchdog -ErrorAction SilentlyContinue
  throw
}

$Digest = (Get-FileHash -LiteralPath $Watchdog -Algorithm SHA256).Hash.ToLowerInvariant()
$File = Get-Item -LiteralPath $Watchdog
$Manifest = [ordered]@{
  schemaVersion = 1
  artifact = $File.Name
  size = $File.Length
  sha256 = $Digest
  signerSha256 = $ExpectedSignerSha256.ToLowerInvariant()
}
$Manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath `
  (Join-Path $ReleaseRoot 'clipboard-watchdog-manifest.json') -Encoding utf8NoBOM
Write-Host "Signed clipboard watchdog: $Watchdog"
