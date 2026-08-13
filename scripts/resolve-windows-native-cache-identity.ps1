$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:ImageVersion)) {
  throw 'GitHub Windows runner ImageVersion is required for the native build cache.'
}

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$DriverKitResolver = Join-Path $RepositoryRoot 'scripts\resolve-windows-driver-kit.ps1'
$DriverKitBin = (& $DriverKitResolver).Trim()
$DriverKitVersion = Split-Path -Leaf $DriverKitBin

$Identity = "windows-2022-$($env:ImageVersion)-wdk-$DriverKitVersion"
if ($Identity -notmatch '^[A-Za-z0-9._-]+$') {
  throw "Windows native cache identity contains unsupported characters: $Identity"
}

Write-Output $Identity
