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
$ProgressPreference = 'SilentlyContinue'

function Resolve-SevenZipExecutable {
  $override = $env:IMCODES_WINDOWS_7Z_PATH
  if (-not [string]::IsNullOrWhiteSpace($override)) {
    if ($override -eq 'none' -or $override -eq 'disabled') {
      return $null
    }
    if (Test-Path -LiteralPath $override -PathType Leaf) {
      return $override
    }
    return $null
  }
  $cmd = Get-Command '7z.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and -not [string]::IsNullOrWhiteSpace($cmd.Source) -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) {
    return $cmd.Source
  }
  foreach ($candidate in @(
    'C:\Program Files\7-Zip\7z.exe',
    'C:\Program Files (x86)\7-Zip\7z.exe'
  )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  return $null
}

$SevenZip = Resolve-SevenZipExecutable

if ($Mode -eq 'Expand') {
  $SourceFull = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourcePath))
  $DestFull = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DestinationPath))
  if (-not (Test-Path -LiteralPath $SourceFull -PathType Leaf)) {
    throw "Source archive not found: $SourcePath"
  }
  New-Item -ItemType Directory -Force -Path $DestFull | Out-Null

  if ($SevenZip) {
    & $SevenZip x -tzip -y -aoa -bd "-o$DestFull" -- $SourceFull | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "7z.exe failed to extract '$SourceFull' with exit code $LASTEXITCODE"
    }
    exit 0
  }

  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $DestWithSep = $DestFull.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $HasExisting = $false
  foreach ($Existing in [System.IO.Directory]::EnumerateFileSystemEntries($DestFull)) {
    $HasExisting = $true
    break
  }
  if (-not $HasExisting) {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($SourceFull, $DestFull)
    exit 0
  }

  $Zip = $null
  try {
    $Zip = [System.IO.Compression.ZipFile]::OpenRead($SourceFull)
    foreach ($Entry in $Zip.Entries) {
      $Rel = $Entry.FullName.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      if ([string]::IsNullOrEmpty($Rel)) {
        continue
      }
      $TargetPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($DestFull, $Rel))
      if (-not $TargetPath.StartsWith($DestWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Zip entry escapes destination directory: $($Entry.FullName)"
      }
      if ($Entry.FullName.EndsWith('/') -or $Entry.FullName.EndsWith('\')) {
        [System.IO.Directory]::CreateDirectory($TargetPath) | Out-Null
        continue
      }
      $ParentDir = [System.IO.Path]::GetDirectoryName($TargetPath)
      if ($ParentDir) {
        [System.IO.Directory]::CreateDirectory($ParentDir) | Out-Null
      }
      if ([System.IO.File]::Exists($TargetPath)) {
        $Attrs = [System.IO.File]::GetAttributes($TargetPath)
        if ($Attrs -band [System.IO.FileAttributes]::ReadOnly) {
          [System.IO.File]::SetAttributes($TargetPath, $Attrs -band (-bnot [System.IO.FileAttributes]::ReadOnly))
        }
      }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $TargetPath, $true)
    }
  } finally {
    if ($Zip) {
      $Zip.Dispose()
    }
  }
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
if (Test-Path -LiteralPath $DestFull) {
  Remove-Item -LiteralPath $DestFull -Force
}

if ($SevenZip) {
  Push-Location -LiteralPath $SourceRoot
  try {
    & $SevenZip a -tzip -mm=Deflate -mx=5 -mmt=on -bd -y -- $DestFull * | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "7z.exe failed to compress '$SourceRoot' into '$DestFull' with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
  exit 0
}

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
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
      [System.IO.Compression.CompressionLevel]::Fastest
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
