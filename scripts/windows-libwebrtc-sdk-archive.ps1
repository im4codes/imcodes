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
$RequiredTopLevel = @(
  'THIRD_PARTY_NOTICES.webrtc.md',
  'gen',
  'imcodes-libwebrtc-sdk.manifest.json',
  'include',
  'lib',
  'sdk-build.json',
  'toolchain'
)

if ($Mode -eq 'Compress') {
  # Compress-Archive opens source entries exclusively on Windows. Serialize
  # publishers for the same immutable SDK with an exclusive file handle. A
  # filesystem lock works across Windows sessions (SSH, service and CI), and
  # is released automatically if a producer is killed.
  $MutexSha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $MutexDigest = [BitConverter]::ToString(
      $MutexSha256.ComputeHash([Text.Encoding]::UTF8.GetBytes(
        [IO.Path]::GetFullPath($SourcePath).ToLowerInvariant()
      ))
    ).Replace('-', '').ToLowerInvariant()
  } finally {
    $MutexSha256.Dispose()
  }
  $ArchiveLockPath = Join-Path ([IO.Path]::GetTempPath()) "imcodes-libwebrtc-sdk-$MutexDigest.lock"
  $ArchiveLock = $null
  $LockDeadline = [DateTime]::UtcNow.AddMinutes(30)
  try {
    while ($null -eq $ArchiveLock -and [DateTime]::UtcNow -lt $LockDeadline) {
      try {
        $ArchiveLock = New-Object IO.FileStream(
          $ArchiveLockPath,
          [IO.FileMode]::OpenOrCreate,
          [IO.FileAccess]::ReadWrite,
          [IO.FileShare]::None
        )
      } catch [IO.IOException] {
        Start-Sleep -Seconds 2
      }
    }
    if ($null -eq $ArchiveLock) { throw 'Timed out waiting for the libwebrtc SDK archive lock.' }

    $Source = Get-Item -LiteralPath $SourcePath -ErrorAction Stop
    if (-not $Source.PSIsContainer -or ($Source.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'libwebrtc SDK compression source must be a regular directory.'
    }
    $Entries = @(Get-ChildItem -LiteralPath $Source.FullName -Force)
    $InvalidEntries = @($Entries | Where-Object {
      ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $_.Name -cnotin $RequiredTopLevel
    })
    $MissingEntries = @($RequiredTopLevel | Where-Object { $_ -cnotin $Entries.Name })
    $ReparsePoints = @(Get-ChildItem -LiteralPath $Source.FullName -Force -Recurse |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    if ($Entries.Count -ne $RequiredTopLevel.Count -or $InvalidEntries.Count -ne 0 -or
        $MissingEntries.Count -ne 0 -or $ReparsePoints.Count -ne 0) {
      throw 'libwebrtc SDK compression source has an invalid layout.'
    }
    $Destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DestinationPath)
    $DestinationDirectory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    $TemporaryArchive = Join-Path $DestinationDirectory ".imcodes-libwebrtc-sdk-$([Guid]::NewGuid().ToString('N')).zip"
    try {
      # Compress-Archive records process-dependent directory metadata, so the
      # same immutable SDK can produce a different release digest. Write only
      # sorted regular files and pin every ZIP timestamp to the format epoch.
      Add-Type -AssemblyName System.IO.Compression
      $ArchiveStream = New-Object IO.FileStream(
        $TemporaryArchive,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
      )
      try {
        $Zip = New-Object IO.Compression.ZipArchive(
          $ArchiveStream,
          [IO.Compression.ZipArchiveMode]::Create,
          $false
        )
        try {
          $Files = @(Get-ChildItem -LiteralPath $Source.FullName -Force -Recurse -File |
            Sort-Object { $_.FullName.Substring($Source.FullName.Length).ToLowerInvariant() })
          foreach ($File in $Files) {
            $RelativeName = $File.FullName.Substring($Source.FullName.Length).TrimStart('\').Replace('\', '/')
            $ZipEntry = $Zip.CreateEntry($RelativeName, [IO.Compression.CompressionLevel]::Optimal)
            $ZipEntry.LastWriteTime = New-Object DateTimeOffset(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            $InputStream = New-Object IO.FileStream(
              $File.FullName,
              [IO.FileMode]::Open,
              [IO.FileAccess]::Read,
              [IO.FileShare]::Read
            )
            try {
              $OutputStream = $ZipEntry.Open()
              try { $InputStream.CopyTo($OutputStream) }
              finally { $OutputStream.Dispose() }
            } finally {
              $InputStream.Dispose()
            }
          }
        } finally {
          $Zip.Dispose()
        }
      } finally {
        $ArchiveStream.Dispose()
      }
      $Archive = Get-Item -LiteralPath $TemporaryArchive -ErrorAction Stop
      if (-not $Archive.Length -or ($Archive.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'libwebrtc SDK archive was not created as a regular non-empty file.'
      }
      Move-Item -LiteralPath $TemporaryArchive -Destination $Destination -Force
    } finally {
      Remove-Item -LiteralPath $TemporaryArchive -Force -ErrorAction SilentlyContinue
    }
  } finally {
    if ($null -ne $ArchiveLock) { $ArchiveLock.Dispose() }
    Remove-Item -LiteralPath $ArchiveLockPath -Force -ErrorAction SilentlyContinue
  }
  return
}

$Archive = Get-Item -LiteralPath $SourcePath -ErrorAction Stop
if ($Archive.PSIsContainer -or -not $Archive.Length -or
    ($Archive.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'libwebrtc SDK expansion source must be a regular non-empty archive.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Zip = [IO.Compression.ZipFile]::OpenRead($Archive.FullName)
try {
  $ArchiveEntries = @($Zip.Entries)
  $CanonicalArchiveNames = @($ArchiveEntries | ForEach-Object {
    $_.FullName.Replace('\', '/')
  })
  $ReservedWindowsNames = @('CON', 'PRN', 'AUX', 'NUL') +
    @(1..9 | ForEach-Object { "COM$_" }) + @(1..9 | ForEach-Object { "LPT$_" })
  $InvalidArchiveEntries = @(for ($Index = 0; $Index -lt $ArchiveEntries.Count; $Index += 1) {
    $Entry = $ArchiveEntries[$Index]
    $CanonicalName = $CanonicalArchiveNames[$Index]
    $Segments = @($CanonicalName.Split('/') | Where-Object { $_.Length -ne 0 })
    $InvalidWindowsSegment = @($Segments | Where-Object {
      $_.EndsWith(' ') -or $_.EndsWith('.') -or
      $ReservedWindowsNames -ccontains [IO.Path]::GetFileNameWithoutExtension($_).ToUpperInvariant()
    }).Count -ne 0
    if ([string]::IsNullOrWhiteSpace($CanonicalName) -or $CanonicalName.StartsWith('/') -or
        $CanonicalName.Contains(':') -or $CanonicalName.Contains('//') -or
        $CanonicalName.Split('/') -contains '..' -or $CanonicalName.Split('/') -contains '.' -or
        $InvalidWindowsSegment -or $CanonicalName.Length -gt 1024 -or
        $Entry.Length -gt 1GB) {
      $Entry
    }
  })
  # Windows extraction is case-insensitive; reject case-only collisions too.
  $DuplicateArchiveNames = @($CanonicalArchiveNames | Group-Object |
    Where-Object { $_.Count -ne 1 })
  $RequiredArchiveEntries = @(
    'imcodes-libwebrtc-sdk.manifest.json',
    'lib/imcodes_libwebrtc_sdk.lib',
    'lib/imcodes_libwebrtc_test_sdk.lib',
    'lib/imcodes_libcxx_runtime_sdk.lib',
    'toolchain/bin/clang-cl.exe',
    'toolchain/bin/lld-link.exe'
  )
  $MissingArchiveEntries = @($RequiredArchiveEntries | Where-Object {
    $_ -cnotin $CanonicalArchiveNames
  })
  $ExpandedSize = ($ArchiveEntries | Measure-Object -Property Length -Sum).Sum
  if ($ArchiveEntries.Count -gt 100000 -or $InvalidArchiveEntries.Count -ne 0 -or
      $DuplicateArchiveNames.Count -ne 0 -or $MissingArchiveEntries.Count -ne 0 -or
      $ExpandedSize -le 0 -or $ExpandedSize -gt 4GB) {
    throw 'libwebrtc SDK archive layout is invalid.'
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
