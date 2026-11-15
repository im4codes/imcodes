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

$SourceRoot = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourcePath)).TrimEnd('\', '/')
$DestFull = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DestinationPath))

$DestParent = Split-Path -Parent $DestFull
if ($DestParent) {
  New-Item -ItemType Directory -Force -Path $DestParent | Out-Null
}
$Items = @(Get-ChildItem -LiteralPath $SourceRoot -Force)
if ($Items.Count -eq 0) {
  throw "Cannot compress empty directory: $SourcePath"
}

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $DestFull) {
  Remove-Item -LiteralPath $DestFull -Force
}

$Zip = $null
try {
  $Zip = [System.IO.Compression.ZipFile]::Open($DestFull, [System.IO.Compression.ZipArchiveMode]::Create)
  $Files = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force | Sort-Object FullName)
  foreach ($File in $Files) {
    $RelPath = $File.FullName.Substring($SourceRoot.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $Zip,
      $File.FullName,
      $RelPath,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
  $Dirs = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -Directory -Force | Sort-Object FullName)
  foreach ($Dir in $Dirs) {
    if (@(Get-ChildItem -LiteralPath $Dir.FullName -Force).Count -eq 0) {
      $RelDir = $Dir.FullName.Substring($SourceRoot.Length + 1).Replace('\', '/').TrimEnd('/')
      $Zip.CreateEntry("$RelDir/") | Out-Null
    }
  }
} finally {
  if ($Zip) {
    $Zip.Dispose()
  }
}
