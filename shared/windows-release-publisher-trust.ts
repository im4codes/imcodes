import { WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT } from './windows-powershell-modules.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const POWERSHELL_VARIABLE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * LocalMachine stores the release signer must end up in.
 *
 * Named once and reused for both the presence probe and the write, so the two
 * can never drift apart. `Root` is deliberately absent: the signer is trusted
 * for our own artifacts, never promoted to a machine-wide certificate authority.
 */
const ANCHOR_STORE_NAMES = ['TrustedPeople', 'TrustedPublisher'] as const;

/**
 * Why the stores are written through X509Store rather than Import-Certificate.
 *
 * Import-Certificate cannot create a LocalMachine physical certificate store
 * that does not exist yet. On a machine that has never trusted a publisher --
 * which is every fresh Windows install -- Cert:\LocalMachine\TrustedPublisher
 * has no registry key, and the cmdlet fails with E_ACCESSDENIED even from an
 * elevated process. That aborted the trust step on first install, and with it
 * enrolment, so the node never registered. X509Store.Open(ReadWrite) creates
 * the store when missing, so it works on the first install and every later one.
 *
 * It also drops the only PKI cmdlet, so the script no longer requires the PKI
 * module (slimmed Windows images ship without it) and no longer writes a
 * temporary certificate file to disk.
 *
 * The rationale lives here rather than inside the emitted PowerShell because
 * the script travels as a command string through a size-bounded exec envelope.
 */
function publisherTrustBody(expectedSignerSha256: string): string {
  if (!SHA256_RE.test(expectedSignerSha256)) throw new Error('invalid_windows_release_signer_sha256');
  const storeList = ANCHOR_STORE_NAMES.map((name) => `'${name}'`).join(', ');
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
$anchorStoreNames = @(__STORE_NAMES__)
function Test-AnchoredCertificateInStore([string]$storeName) {
  foreach ($certificate in @(Get-ChildItem -LiteralPath ('Cert:\LocalMachine\' + $storeName) -ErrorAction Stop)) {
    if ((Get-CertificateSha256 $certificate) -ceq $expected) { return $true }
  }
  return $false
}
function Add-AnchoredCertificateToStore([string]$storeName, [System.Security.Cryptography.X509Certificates.X509Certificate2]$certificate) {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try { $store.Add($certificate) } finally { $store.Close() }
}
$storeFailures = @()
foreach ($storeName in $anchorStoreNames) {
  if (Test-AnchoredCertificateInStore $storeName) { continue }
  try { Add-AnchoredCertificateToStore $storeName $signer }
  catch { $storeFailures += ($storeName + ': ' + $_.Exception.Message) }
}
$trusted = Get-AuthenticodeSignature -LiteralPath $path
if ($trusted.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $trusted.SignerCertificate) {
  $reason = 'release publisher trust installation did not validate the executable'
  if ($storeFailures.Count -gt 0) { $reason = $reason + ' (' + ($storeFailures -join '; ') + ')' }
  throw $reason
}
$trustedActual = Get-CertificateSha256 $trusted.SignerCertificate
if ($trustedActual -cne $expected) { throw 'trusted release signer changed during installation' }
`.replace('__SIGNER_SHA256__', expectedSignerSha256)
    .replace('__STORE_NAMES__', storeList);
}

export function buildWindowsReleasePublisherTrustScript(
  executablePath: string,
  expectedSignerSha256: string,
): string {
  const executableBase64 = Buffer.from(executablePath, 'utf8').toString('base64');
  return `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT
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
    + `$path = [string]$${powershellVariableName}\r\n`
    + publisherTrustBody(expectedSignerSha256);
}
