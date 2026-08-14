import {
  WINDOWS_POWERSHELL_PKI_MODULE_PREFLIGHT,
  WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT,
} from './windows-powershell-modules.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const POWERSHELL_VARIABLE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function publisherTrustBody(expectedSignerSha256: string): string {
  if (!SHA256_RE.test(expectedSignerSha256)) throw new Error('invalid_windows_release_signer_sha256');
  return String.raw`
$expected = '__SIGNER_SHA256__'
$signature = Get-AuthenticodeSignature -LiteralPath $path
if ($null -eq $signature.SignerCertificate) { throw 'release signer certificate is missing' }
$signer = $signature.SignerCertificate
function Get-CertificateSha256([System.Security.Cryptography.X509Certificates.X509Certificate2]$certificate) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha256.ComputeHash($certificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }
}
$actual = Get-CertificateSha256 $signer
if ($actual -cne $expected) { throw 'release signer does not match the compiled trust anchor' }
$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$hasCodeSigningEku = $false
foreach ($extension in $signer.Extensions) {
  if ($extension.Oid.Value -eq '2.5.29.37') {
    $eku = New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($extension, $extension.Critical)
    foreach ($oid in $eku.EnhancedKeyUsages) { if ($oid.Value -eq $codeSigningOid) { $hasCodeSigningEku = $true } }
  }
}
if (-not $hasCodeSigningEku) { throw 'release signer is not valid for code signing' }
function Test-AnchoredCertificateInStore([string]$storePath) {
  foreach ($certificate in @(Get-ChildItem -LiteralPath $storePath -ErrorAction Stop)) {
    if ((Get-CertificateSha256 $certificate) -ceq $expected) { return $true }
  }
  return $false
}
$trustedPeoplePresent = Test-AnchoredCertificateInStore 'Cert:\LocalMachine\TrustedPeople'
$trustedPublisherPresent = Test-AnchoredCertificateInStore 'Cert:\LocalMachine\TrustedPublisher'
if (-not ($trustedPeoplePresent -and $trustedPublisherPresent -and $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid)) {
  $temporaryCertificate = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('imcodes-publisher-' + [Guid]::NewGuid().ToString('N') + '.cer'))
  try {
    [IO.File]::WriteAllBytes($temporaryCertificate, $signer.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    Import-Certificate -FilePath $temporaryCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
    Import-Certificate -FilePath $temporaryCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPublisher' | Out-Null
  } finally {
    Remove-Item -LiteralPath $temporaryCertificate -Force -ErrorAction SilentlyContinue
  }
}
$trusted = Get-AuthenticodeSignature -LiteralPath $path
if ($trusted.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $trusted.SignerCertificate) { throw 'release publisher trust installation did not validate the executable' }
$trustedActual = Get-CertificateSha256 $trusted.SignerCertificate
if ($trustedActual -cne $expected) { throw 'trusted release signer changed during installation' }
`.replace('__SIGNER_SHA256__', expectedSignerSha256);
}

export function buildWindowsReleasePublisherTrustScript(
  executablePath: string,
  expectedSignerSha256: string,
): string {
  const executableBase64 = Buffer.from(executablePath, 'utf8').toString('base64');
  return `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT
    + WINDOWS_POWERSHELL_PKI_MODULE_PREFLIGHT
    + `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${executableBase64}'))\r\n`
    + publisherTrustBody(expectedSignerSha256);
}

export function buildWindowsReleasePublisherTrustScriptForVariable(
  powershellVariableName: string,
  expectedSignerSha256: string,
): string {
  if (!POWERSHELL_VARIABLE_RE.test(powershellVariableName)) {
    throw new Error('invalid_windows_release_publisher_path_variable');
  }
  return `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT
    + WINDOWS_POWERSHELL_PKI_MODULE_PREFLIGHT
    + `$path = [string]$${powershellVariableName}\r\n`
    + publisherTrustBody(expectedSignerSha256);
}
