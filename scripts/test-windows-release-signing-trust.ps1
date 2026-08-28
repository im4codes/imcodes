param(
  [Parameter(Mandatory = $true)]
  [string]$ConfiguredArtifactPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedSignerSha256
)

$ErrorActionPreference = 'Stop'
$SigningScript = Join-Path $PSScriptRoot 'windows-sign-release-artifact.ps1'
if (-not (Test-Path -LiteralPath $SigningScript -PathType Leaf)) {
  throw 'Windows release-signing implementation was not found.'
}
if ($ExpectedSignerSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
  throw 'ExpectedSignerSha256 must be SHA-256 hex.'
}
$ConfiguredArtifact = (Resolve-Path -LiteralPath $ConfiguredArtifactPath).Path

function Get-CertificateSha256 {
  param([Parameter(Mandatory = $true)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
  $Sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($Sha256.ComputeHash($Certificate.RawData)).Replace('-', '').ToLowerInvariant()
  } finally {
    $Sha256.Dispose()
  }
}

function Assert-LeafNotLocallyTrusted {
  param([Parameter(Mandatory = $true)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
  $ForbiddenStores = @(
    "Cert:\CurrentUser\Root\$($Certificate.Thumbprint)",
    "Cert:\CurrentUser\TrustedPeople\$($Certificate.Thumbprint)",
    "Cert:\CurrentUser\TrustedPublisher\$($Certificate.Thumbprint)",
    "Cert:\LocalMachine\Root\$($Certificate.Thumbprint)",
    "Cert:\LocalMachine\TrustedPeople\$($Certificate.Thumbprint)",
    "Cert:\LocalMachine\TrustedPublisher\$($Certificate.Thumbprint)"
  )
  $Injected = @($ForbiddenStores | Where-Object { Test-Path -LiteralPath $_ })
  if ($Injected.Count -gt 0) {
    throw "Configured release leaf was injected into a machine/user trust store: $($Injected -join ',')"
  }
}

function Get-CngPrivateKeyPath {
  param([Parameter(Mandatory = $true)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
  $PrivateKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
  try {
    if ($PrivateKey -isnot [System.Security.Cryptography.RSACng]) {
      throw 'Disposable negative certificate did not use the required CNG private-key provider.'
    }
    $KeyPath = Join-Path $env:APPDATA ("Microsoft\Crypto\Keys\" + $PrivateKey.Key.UniqueName)
    if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
      throw 'Disposable negative certificate private-key file was not found.'
    }
    return $KeyPath
  } finally {
    if ($null -ne $PrivateKey) { $PrivateKey.Dispose() }
  }
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("imcodes-signing-trust-negative-" + [guid]::NewGuid().ToString('N'))
$NegativeCertificate = $null
$NegativeCertificatePath = $null
$NegativePrivateKeyPath = $null
New-Item -ItemType Directory -Path $Work | Out-Null
try {
  # A disposable copy of an in-box executable gives SignTool valid PE input;
  # only the copy is signed. The negative certificate lives in CurrentUser\My,
  # never in Root/TrustedPeople/TrustedPublisher.
  $NegativeArtifact = Join-Path $Work 'self-signed-negative.exe'
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\where.exe') -Destination $NegativeArtifact
  $NegativeCertificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject ("CN=IM.codes Untrusted Signing Negative " + [guid]::NewGuid().ToString('N')) `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -Provider 'Microsoft Software Key Storage Provider' `
    -KeyExportPolicy NonExportable `
    -NotAfter ([DateTime]::UtcNow.AddDays(1))
  if ($null -eq $NegativeCertificate) {
    throw 'Could not create the disposable self-signed negative certificate.'
  }
  $NegativeCertificatePath = "Cert:\CurrentUser\My\$($NegativeCertificate.Thumbprint)"
  if (-not $NegativeCertificate.HasPrivateKey) {
    throw 'Could not create the disposable self-signed negative certificate.'
  }
  $NegativePrivateKeyPath = Get-CngPrivateKeyPath -Certificate $NegativeCertificate
  Assert-LeafNotLocallyTrusted -Certificate $NegativeCertificate
  $NegativeSignerSha256 = Get-CertificateSha256 -Certificate $NegativeCertificate

  $Rejected = $false
  try {
    & $SigningScript `
      -Mode Sign `
      -ArtifactPath $NegativeArtifact `
      -CodeSigningCertificateThumbprint $NegativeCertificate.Thumbprint `
      -ExpectedSignerSha256 $NegativeSignerSha256 `
      -TimestampUrl ''
  } catch {
    if ($_.Exception.Message -notmatch 'self-signed|not trusted|Authenticode verification failed') {
      throw
    }
    $Rejected = $true
  }
  if (-not $Rejected) {
    throw 'Disposable self-signed Windows binary was incorrectly accepted as a release artifact.'
  }

  # The configured artifact is verified while the release leaf remains absent
  # from all ad-hoc trust stores. This exercises Get-AuthenticodeSignature,
  # X509Chain and `signtool verify /pa /all` through the production verifier.
  $ConfiguredSignature = Get-AuthenticodeSignature -LiteralPath $ConfiguredArtifact
  if ($null -eq $ConfiguredSignature.SignerCertificate) {
    throw "Configured release artifact has no Authenticode signer: $($ConfiguredSignature.Status)"
  }
  Assert-LeafNotLocallyTrusted -Certificate $ConfiguredSignature.SignerCertificate
  & $SigningScript `
    -Mode Verify `
    -ArtifactPath $ConfiguredArtifact `
    -ExpectedSignerSha256 $ExpectedSignerSha256
  if ($ConfiguredSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Configured release artifact is not valid on the unmodified machine trust store: $($ConfiguredSignature.Status)"
  }
} finally {
  $CleanupErrors = @()
  if ($null -ne $NegativeCertificatePath -and (Test-Path -LiteralPath $NegativeCertificatePath)) {
    try { Remove-Item -LiteralPath $NegativeCertificatePath -DeleteKey -Force -ErrorAction Stop }
    catch { $CleanupErrors += "${NegativeCertificatePath}: $($_.Exception.Message)" }
  }
  if ($null -ne $NegativeCertificate) {
    $NegativeCertificate.Dispose()
  }
  if ($null -ne $NegativeCertificatePath -and (Test-Path -LiteralPath $NegativeCertificatePath)) {
    $CleanupErrors += "${NegativeCertificatePath}: certificate still exists after cleanup"
  }
  if ($null -ne $NegativePrivateKeyPath -and (Test-Path -LiteralPath $NegativePrivateKeyPath)) {
    $CleanupErrors += "${NegativePrivateKeyPath}: private key still exists after cleanup"
  }
  if (Test-Path -LiteralPath $Work) {
    try { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction Stop }
    catch { $CleanupErrors += "${Work}: $($_.Exception.Message)" }
  }
  if (Test-Path -LiteralPath $Work) {
    $CleanupErrors += "${Work}: disposable trust-gate directory still exists after cleanup"
  }
  if ($CleanupErrors.Count -gt 0) {
    throw "Windows release-signing negative-gate cleanup failed: $($CleanupErrors -join '; ')"
  }
}

Write-Output 'Windows release-signing trust gate passed.'
