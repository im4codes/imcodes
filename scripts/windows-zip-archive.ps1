param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Expand', 'Compress')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$DestinationPath
)

$ErrorActionPreference = 'Stop'

if ($Mode -eq 'Expand') {
  New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
  Expand-Archive -LiteralPath $SourcePath -DestinationPath $DestinationPath -Force
  exit 0
}

$DestParent = Split-Path -Parent $DestinationPath
if ($DestParent) {
  New-Item -ItemType Directory -Force -Path $DestParent | Out-Null
}
$Items = @(Get-ChildItem -LiteralPath $SourcePath -Force)
if ($Items.Count -eq 0) {
  throw "Cannot compress empty directory: $SourcePath"
}
Compress-Archive -LiteralPath ($Items | ForEach-Object { $_.FullName }) -DestinationPath $DestinationPath -CompressionLevel Optimal -Force
