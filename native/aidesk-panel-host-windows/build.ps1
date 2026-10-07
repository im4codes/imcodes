<#
Builds aidesk-local-ui.exe (the WebView2 panel window host) with MSVC from the fixed, hash-pinned WebView2 SDK and the official IM.codes logo.
Build time only: the SDK is fetched and sha256-verified by scripts/fetch-webview2-sdk.mjs; nothing is downloaded when the exe runs.

  pwsh native/aidesk-panel-host-windows/build.ps1 -ArtifactRoot dist-node-exe/aidesk-local-ui/win32-x64 [-Arch x64]

Writes <ArtifactRoot>/aidesk-local-ui.exe (unsigned; signing and the manifest are the release action's job).
#>
param(
  [Parameter(Mandatory = $true)][string]$ArtifactRoot,
  [ValidateSet('x64', 'arm64')][string]$Arch = 'x64'
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$work = Join-Path ([IO.Path]::GetTempPath()) ("aidesk-panel-host-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $sdkJson = node (Join-Path $repo 'scripts\fetch-webview2-sdk.mjs') --out (Join-Path $work 'webview2')
  if ($LASTEXITCODE -ne 0) { throw 'fetching the pinned WebView2 SDK failed' }
  $sdkRoot = ($sdkJson | Select-Object -Last 1 | ConvertFrom-Json).root
  $icon = Join-Path $work 'aidesk.ico'
  node (Join-Path $repo 'scripts\aidesk-icon.mjs') ico $icon
  if ($LASTEXITCODE -ne 0) { throw 'building the application icon failed' }
  $build = Join-Path $work 'build'
  $platform = if ($Arch -eq 'arm64') { 'ARM64' } else { 'x64' }
  cmake -S (Join-Path $repo 'native\aidesk-panel-host-windows') -B $build -A $platform "-DAIDESK_WEBVIEW2_ROOT=$sdkRoot" "-DAIDESK_ICON=$icon" "-DAIDESK_WEBVIEW2_ARCH=$Arch"
  if ($LASTEXITCODE -ne 0) { throw 'configuring the panel window host failed' }
  cmake --build $build --config Release
  if ($LASTEXITCODE -ne 0) { throw 'building the panel window host failed' }
  $exe = Get-ChildItem -Path $build -Recurse -Filter 'aidesk-local-ui.exe' | Select-Object -First 1
  if (-not $exe) { throw 'the panel window host was not produced' }
  New-Item -ItemType Directory -Force -Path $ArtifactRoot | Out-Null
  Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $ArtifactRoot 'aidesk-local-ui.exe') -Force
  # The third-party licence text the static loader requires travels with the binary.
  Copy-Item -LiteralPath (Join-Path $sdkRoot 'LICENSE.txt') -Destination (Join-Path $ArtifactRoot 'WEBVIEW2-LICENSE.txt') -Force
  Copy-Item -LiteralPath (Join-Path $sdkRoot 'NOTICE.txt') -Destination (Join-Path $ArtifactRoot 'WEBVIEW2-NOTICE.txt') -Force
  "aidesk-local-ui.exe ($Arch): $((Get-Item (Join-Path $ArtifactRoot 'aidesk-local-ui.exe')).Length) bytes"
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
