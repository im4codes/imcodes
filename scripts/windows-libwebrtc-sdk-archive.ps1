param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Compress', 'Expand')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$DestinationPath
)

$ErrorActionPreference = 'Stop'

if ($Mode -eq 'Compress') {
  $Source = Get-Item -LiteralPath $SourcePath -ErrorAction Stop
  if (-not $Source.PSIsContainer -or ($Source.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'libwebrtc SDK compression source must be a regular directory.'
  }
  $Entries = @(Get-ChildItem -LiteralPath $Source.FullName -Force)
  $ExpectedEntryNames = @(
    'imcodes-libwebrtc-sdk.manifest.json',
    'imcodes-remote-desktop-worker.exe',
    'imcodes-virtual-display.zip'
  )
  $InvalidEntries = @($Entries | Where-Object {
    $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    $_.Name -cnotin $ExpectedEntryNames
  })
  $MissingEntries = @($ExpectedEntryNames | Where-Object { $_ -cnotin $Entries.Name })
  if ($Entries.Count -ne $ExpectedEntryNames.Count -or $InvalidEntries.Count -ne 0 -or
      $MissingEntries.Count -ne 0) {
    throw 'libwebrtc SDK compression source must contain exactly three regular files.'
  }
  $Destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DestinationPath)
  $DestinationDirectory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
  $TemporaryArchive = Join-Path $DestinationDirectory ".imcodes-libwebrtc-sdk-$([Guid]::NewGuid().ToString('N')).zip"
  try {
    Compress-Archive -LiteralPath @($Entries.FullName) -DestinationPath $TemporaryArchive -CompressionLevel Optimal -Force
    $Archive = Get-Item -LiteralPath $TemporaryArchive -ErrorAction Stop
    if (-not $Archive.Length -or ($Archive.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'libwebrtc SDK archive was not created as a regular non-empty file.'
    }
    Move-Item -LiteralPath $TemporaryArchive -Destination $Destination -Force
  } finally {
    Remove-Item -LiteralPath $TemporaryArchive -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

$Archive = Get-Item -LiteralPath $SourcePath -ErrorAction Stop
if ($Archive.PSIsContainer -or -not $Archive.Length -or
    ($Archive.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'libwebrtc SDK expansion source must be a regular non-empty archive.'
}
$ExpectedArchiveEntries = @{
  'imcodes-libwebrtc-sdk.manifest.json' = 65536
  'imcodes-remote-desktop-worker.exe' = 268435456
  'imcodes-virtual-display.zip' = 134217728
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Zip = [IO.Compression.ZipFile]::OpenRead($Archive.FullName)
try {
  $ArchiveEntries = @($Zip.Entries)
  $InvalidArchiveEntries = @($ArchiveEntries | Where-Object {
    -not $ExpectedArchiveEntries.ContainsKey($_.FullName) -or
    $_.Name -cne $_.FullName -or $_.Length -le 0 -or
    $_.Length -gt $ExpectedArchiveEntries[$_.FullName]
  })
  $MissingArchiveEntries = @($ExpectedArchiveEntries.Keys | Where-Object {
    $_ -cnotin $ArchiveEntries.FullName
  })
  if ($ArchiveEntries.Count -ne $ExpectedArchiveEntries.Count -or
      $InvalidArchiveEntries.Count -ne 0 -or $MissingArchiveEntries.Count -ne 0) {
    throw 'libwebrtc SDK archive must contain exactly the three bounded top-level files.'
  }
} finally {
  $Zip.Dispose()
}
$Destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DestinationPath)
if (Test-Path -LiteralPath $Destination) {
  $Existing = @(Get-ChildItem -LiteralPath $Destination -Force)
  if ($Existing.Count -ne 0) { throw 'libwebrtc SDK expansion destination must be empty.' }
} else {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
}
Expand-Archive -LiteralPath $Archive.FullName -DestinationPath $Destination -Force
