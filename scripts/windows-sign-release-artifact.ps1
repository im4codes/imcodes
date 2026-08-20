param(
  [ValidateSet('Remove', 'Sign', 'Verify')]
  [string]$Mode = 'Sign',

  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath,

  [string]$CodeSigningCertificateThumbprint = '',

  [string]$ExpectedSignerSha256 = '',

  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$SecurityModulePath = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
if (-not (Test-Path -LiteralPath $SecurityModulePath -PathType Leaf)) {
  throw 'Windows PowerShell security module was not found.'
}
# The Node build can be launched by PowerShell 7. Its inherited PSModulePath
# points at PowerShell 7 modules, which Windows PowerShell 5.1 cannot load.
# Pin the in-box module belonging to this interpreter before using
# Get-AuthenticodeSignature so hosted runners and deployed Windows hosts use
# the same Authenticode implementation.
Import-Module -Name $SecurityModulePath -ErrorAction Stop
$ResolvedArtifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
$KitRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
$VersionedSignTools = @(Get-ChildItem $KitRoot -Directory -ErrorAction Stop |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
  Sort-Object { [version]$_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
$UnversionedSignTool = Join-Path $KitRoot 'x64\signtool.exe'
$SignTool = @($VersionedSignTools + $(if (Test-Path -LiteralPath $UnversionedSignTool -PathType Leaf) { $UnversionedSignTool }))[0]
if (-not $SignTool) { throw 'Windows SDK signtool.exe was not found.' }

if ($Mode -eq 'Remove') {
  & $SignTool remove /s $ResolvedArtifact
  if ($LASTEXITCODE -ne 0) { throw 'Base Node Authenticode signature removal failed.' }
  $RemovedSignature = Get-AuthenticodeSignature -LiteralPath $ResolvedArtifact
  if ($RemovedSignature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
    throw "Base Node Authenticode signature removal was incomplete: $($RemovedSignature.Status)"
  }
  exit 0
}

if ($ExpectedSignerSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
  throw 'ExpectedSignerSha256 must be SHA-256 hex.'
}

if ($Mode -eq 'Sign') {
  if ($CodeSigningCertificateThumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
    throw 'CodeSigningCertificateThumbprint must be a SHA-1 certificate thumbprint.'
  }
  $SignArguments = @(
    'sign', '/s', 'My', '/sha1', $CodeSigningCertificateThumbprint,
    '/fd', 'sha256'
  )
  if (-not [string]::IsNullOrWhiteSpace($TimestampUrl)) {
    $SignArguments += @('/tr', $TimestampUrl, '/td', 'sha256')
  }
  $SignArguments += $ResolvedArtifact

  & $SignTool @SignArguments
  if ($LASTEXITCODE -ne 0) { throw 'Windows release-artifact Authenticode signing failed.' }
}

$Signature = Get-AuthenticodeSignature -LiteralPath $ResolvedArtifact
if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    $null -eq $Signature.SignerCertificate) {
  throw "Windows release-artifact Authenticode verification failed: $($Signature.Status)"
}

$Sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $ActualSignerSha256 = [BitConverter]::ToString(
    $Sha256.ComputeHash($Signature.SignerCertificate.RawData)
  ).Replace('-', '').ToLowerInvariant()
} finally {
  $Sha256.Dispose()
}
if ($ActualSignerSha256 -cne $ExpectedSignerSha256.ToLowerInvariant()) {
  throw 'Windows release-artifact signer does not match the compiled release trust anchor.'
}

& $SignTool verify /pa /all $ResolvedArtifact
if ($LASTEXITCODE -ne 0) { throw 'Windows release-artifact WinVerifyTrust policy verification failed.' }
