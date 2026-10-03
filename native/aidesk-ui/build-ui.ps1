param(
  [Parameter(Mandatory=$true)][string]$FltkRoot,
  [Parameter(Mandatory=$true)][string]$JsoncppRoot,
  [Parameter(Mandatory=$true)][string]$ArtifactRoot,
  [int]$Jobs = 2
)
$ErrorActionPreference = 'Stop'
$BuildRoot = Join-Path ([IO.Path]::GetTempPath()) ("aidesk-ui-build-" + [guid]::NewGuid().ToString('N'))
try {
  cmake -S $PSScriptRoot -B $BuildRoot -G Ninja -DCMAKE_BUILD_TYPE=Release `
    "-DAIDESK_FLTK_ROOT=$FltkRoot" "-DAIDESK_JSONCPP_ROOT=$JsoncppRoot"
  if ($LASTEXITCODE -ne 0) { throw 'aiDesk UI configure failed' }
  cmake --build $BuildRoot --target aidesk-local-ui aidesk-ui-unit-tests --parallel $Jobs
  if ($LASTEXITCODE -ne 0) { throw 'aiDesk UI build failed' }
  ctest --test-dir $BuildRoot --output-on-failure
  if ($LASTEXITCODE -ne 0) { throw 'aiDesk UI tests failed' }
  Remove-Item -Recurse -Force $ArtifactRoot -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $ArtifactRoot | Out-Null
  Copy-Item (Join-Path $BuildRoot 'aidesk-local-ui.exe') $ArtifactRoot
  Copy-Item (Join-Path $PSScriptRoot 'FLTK-LICENSE.txt') $ArtifactRoot
  Write-Output "aidesk-ui=$ArtifactRoot"
} finally {
  Remove-Item -Recurse -Force $BuildRoot -ErrorAction SilentlyContinue
}
