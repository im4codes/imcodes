param(
  [string]$KitRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $KitRoot -PathType Container)) {
  throw "Windows Driver Kit bin directory was not found: $KitRoot"
}

$KitBin = Get-ChildItem -LiteralPath $KitRoot -Directory |
  Where-Object {
    $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'x86\inf2cat.exe') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'x64\signtool.exe') -PathType Leaf)
  } |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1

if (-not $KitBin) {
  throw 'A matching WDK with x86 inf2cat.exe and x64 signtool.exe was not found.'
}

Write-Output $KitBin.FullName
