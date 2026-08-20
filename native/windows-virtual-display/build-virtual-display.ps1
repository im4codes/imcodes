param(
  [string]$ArtifactRoot = 'E:\imcodes-build-output\virtual-display',
  [string]$VisualStudioRoot = '',
  [string]$DriverKitBin = '',
  [Parameter(Mandatory = $true)][string]$ThirdPartyNoticesPath,
  [string]$CodeSigningCertificateThumbprint = '',
  [string]$CodeSigningTimestampUrl = '',
  [switch]$RequireAuthenticodeSignature
)

$ErrorActionPreference = 'Stop'
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$Project = Join-Path $SourceDirectory 'imcodes-virtual-display.vcxproj'
$BuildOutput = Join-Path $SourceDirectory 'out'

if ([string]::IsNullOrWhiteSpace($ArtifactRoot) -or
    [System.IO.Path]::GetPathRoot($ArtifactRoot) -eq $ArtifactRoot) {
  throw 'ArtifactRoot must be a dedicated non-root directory.'
}
if (-not (Test-Path -LiteralPath $ThirdPartyNoticesPath -PathType Leaf)) {
  throw 'Pinned WebRTC third-party notices are required.'
}
if ([string]::IsNullOrWhiteSpace($VisualStudioRoot)) {
  if (Test-Path 'C:\BuildTools\VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt') {
    $VisualStudioRoot = 'C:\BuildTools'
  } else {
    $VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $VsWhere) {
      $VisualStudioRoot = (& $VsWhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath).Trim()
    }
  }
}
$MsBuild = Join-Path $VisualStudioRoot 'MSBuild\Current\Bin\amd64\MSBuild.exe'
if (-not (Test-Path $MsBuild)) {
  $MsBuild = Join-Path $VisualStudioRoot 'MSBuild\Current\Bin\MSBuild.exe'
}
if (-not (Test-Path $MsBuild)) { throw 'MSBuild was not found.' }
if ([string]::IsNullOrWhiteSpace($DriverKitBin)) {
  $RepositoryRoot = Split-Path -Parent (Split-Path -Parent $SourceDirectory)
  $DriverKitResolver = Join-Path $RepositoryRoot 'scripts\resolve-windows-driver-kit.ps1'
  $DriverKitBin = (& $DriverKitResolver).Trim()
}
$Inf2Cat = Join-Path $DriverKitBin 'x86\inf2cat.exe'
$SignTool = Join-Path $DriverKitBin 'x64\signtool.exe'
if (-not (Test-Path -LiteralPath $Inf2Cat -PathType Leaf) -or
    -not (Test-Path -LiteralPath $SignTool -PathType Leaf)) {
  throw 'Resolved Windows Driver Kit is missing inf2cat.exe or signtool.exe.'
}

& $MsBuild $Project '/t:Clean;Build' '/p:Configuration=Release' `
  '/p:Platform=x64' '/p:SignMode=Off' '/m:2'
if ($LASTEXITCODE -ne 0) { throw 'Virtual display driver build failed.' }

$Dll = Get-ChildItem $BuildOutput -Recurse -Filter 'imcodes-virtual-display.dll' |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $Dll) { throw 'Built virtual display driver DLL was not found.' }
$BuiltInf = Join-Path $BuildOutput 'imcodes-virtual-display.inf'
if (-not (Test-Path $BuiltInf)) { throw 'Stamped virtual display INF was not found.' }
Remove-Item -Recurse -Force $ArtifactRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ArtifactRoot | Out-Null
Copy-Item -LiteralPath $Dll.FullName -Destination (Join-Path $ArtifactRoot $Dll.Name)
Copy-Item -LiteralPath $BuiltInf -Destination $ArtifactRoot
Copy-Item -LiteralPath (Join-Path $SourceDirectory 'LICENSE.microsoft.txt') -Destination $ArtifactRoot
Copy-Item -LiteralPath $ThirdPartyNoticesPath `
  -Destination (Join-Path $ArtifactRoot 'THIRD_PARTY_NOTICES.webrtc.md')

if (-not [string]::IsNullOrWhiteSpace($CodeSigningCertificateThumbprint)) {
  if ($CodeSigningCertificateThumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
    throw 'CodeSigningCertificateThumbprint must be a SHA-1 certificate thumbprint.'
  }
  $DllPath = Join-Path $ArtifactRoot $Dll.Name
  $Arguments = @('sign', '/sha1', $CodeSigningCertificateThumbprint, '/fd', 'sha256')
  if (-not [string]::IsNullOrWhiteSpace($CodeSigningTimestampUrl)) {
    $Arguments += @('/tr', $CodeSigningTimestampUrl, '/td', 'sha256')
  }
  $Arguments += $DllPath
  & $SignTool @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Signing failed: $DllPath" }
}

# The catalog must hash the FINAL signed driver bytes. Signing the DLL after
# Inf2Cat invalidates its catalog membership even though both files have valid
# individual Authenticode signatures.
& $Inf2Cat "/driver:$ArtifactRoot" '/os:10_X64' '/uselocaltime'
if ($LASTEXITCODE -ne 0) { throw 'Virtual display catalog generation failed.' }
$Catalog = Join-Path $ArtifactRoot 'imcodes-virtual-display.cat'
if (-not (Test-Path $Catalog)) { throw 'Virtual display catalog was not created.' }

if (-not [string]::IsNullOrWhiteSpace($CodeSigningCertificateThumbprint)) {
  $Arguments = @('sign', '/sha1', $CodeSigningCertificateThumbprint, '/fd', 'sha256')
  if (-not [string]::IsNullOrWhiteSpace($CodeSigningTimestampUrl)) {
    $Arguments += @('/tr', $CodeSigningTimestampUrl, '/td', 'sha256')
  }
  $Arguments += $Catalog
  & $SignTool @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Signing failed: $Catalog" }
}

$Files = @(
  'imcodes-virtual-display.dll',
  'imcodes-virtual-display.inf',
  'imcodes-virtual-display.cat',
  'LICENSE.microsoft.txt',
  'THIRD_PARTY_NOTICES.webrtc.md'
)
$FileManifest = @()
foreach ($Name in $Files) {
  $Path = Join-Path $ArtifactRoot $Name
  if (-not (Test-Path -LiteralPath $Path)) { throw "Missing driver package file: $Name" }
  $FileManifest += [ordered]@{
    name = $Name
    size = (Get-Item -LiteralPath $Path).Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  }
}
foreach ($SignedFile in @('imcodes-virtual-display.dll', 'imcodes-virtual-display.cat')) {
  $Signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $ArtifactRoot $SignedFile)
  if ($RequireAuthenticodeSignature -and
      $Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Virtual display signature verification failed: $SignedFile ($($Signature.Status))"
  }
}
if ($RequireAuthenticodeSignature) {
  & $SignTool verify /pa /c $Catalog (Join-Path $ArtifactRoot 'imcodes-virtual-display.dll')
  if ($LASTEXITCODE -ne 0) {
    throw 'Virtual display DLL is not a valid member of the signed catalog.'
  }
}
$DllSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $ArtifactRoot 'imcodes-virtual-display.dll')
$CatalogSignature = Get-AuthenticodeSignature -LiteralPath $Catalog
if ($null -eq $DllSignature.SignerCertificate -or $null -eq $CatalogSignature.SignerCertificate) {
  throw 'Virtual display package requires signed DLL and catalog identities.'
}
$SignerHasher = [System.Security.Cryptography.SHA256]::Create()
try {
  $DllSignerSha256 = [BitConverter]::ToString(
    $SignerHasher.ComputeHash($DllSignature.SignerCertificate.RawData)
  ).Replace('-', '').ToLowerInvariant()
  $CatalogSignerSha256 = [BitConverter]::ToString(
    $SignerHasher.ComputeHash($CatalogSignature.SignerCertificate.RawData)
  ).Replace('-', '').ToLowerInvariant()
} finally {
  $SignerHasher.Dispose()
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
  (Join-Path $ArtifactRoot 'imcodes-virtual-display.manifest.json'),
  ([ordered]@{
      manifestVersion = 1
      hardwareId = 'ImcodesVirtualDisplay'
      dllSignerSha256 = $DllSignerSha256
      catalogSignerSha256 = $CatalogSignerSha256
      files = $FileManifest
    } | ConvertTo-Json -Depth 4),
  $Utf8NoBom)
Write-Output "virtualDisplay=$ArtifactRoot"
