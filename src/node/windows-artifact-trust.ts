import { execFile } from 'node:child_process';
import { WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT } from '../../shared/windows-powershell-modules.js';

// Replaced by scripts/build-node-exe.mjs when producing the Windows SEA. An
// ordinary source/dev runtime deliberately has no release trust anchor and
// therefore cannot advertise or execute production native sidecars.
declare const __IMCODES_WINDOWS_RELEASE_SIGNER_SHA256__: string | undefined;

export const WINDOWS_COMPILED_RELEASE_SIGNER_SHA256 =
  typeof __IMCODES_WINDOWS_RELEASE_SIGNER_SHA256__ === 'string'
    ? __IMCODES_WINDOWS_RELEASE_SIGNER_SHA256__
    : '';

const SHA256_RE = /^[a-f0-9]{64}$/;
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function powershellBase64(value: string): string {
  return Buffer.from(value, 'utf16le').toString('base64');
}

function runWindowsTrustScript(
  script: string,
  run: typeof execFile = execFile,
  timeout = 30_000,
): Promise<boolean> {
  return new Promise((resolveVerified) => {
    run(
      WINDOWS_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', powershellBase64(script)],
      { windowsHide: true, timeout, maxBuffer: 64 * 1024 },
      (error) => resolveVerified(!error),
    );
  });
}

/** Re-establish Windows trust-chain and exact release-signer identity. */
export function verifyWindowsAuthenticodeSigners(
  paths: readonly string[],
  expectedSignerSha256: string,
  run: typeof execFile = execFile,
): Promise<boolean> {
  if (!SHA256_RE.test(expectedSignerSha256) || paths.length === 0) {
    return Promise.resolve(false);
  }
  const pathsBase64 = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT
    + String.raw`
$paths = @((ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PATHS64__')))))
$expected = '__SIGNER_SHA256__'
foreach ($path in $paths) {
  $signature = Get-AuthenticodeSignature -LiteralPath ([string]$path)
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { throw 'invalid Authenticode signature' }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }
  if ($actual -cne $expected) { throw 'unexpected Authenticode signer' }
}
`.replace('__PATHS64__', pathsBase64).replace('__SIGNER_SHA256__', expectedSignerSha256);
  return runWindowsTrustScript(script, run);
}

/**
 * Trust the public leaf embedded in the signed installer after elevation.
 * The private key is never exported or installed. The exact compiled DER hash
 * and Code Signing EKU are checked before the leaf reaches either trust store.
 */
export function installWindowsReleasePublisherTrust(
  executablePath: string,
  expectedSignerSha256 = WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
  run: typeof execFile = execFile,
): Promise<boolean> {
  if (!SHA256_RE.test(expectedSignerSha256)) return Promise.resolve(false);
  const executableBase64 = Buffer.from(executablePath, 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'\r\n`
    + WINDOWS_POWERSHELL_SECURITY_MODULE_PREFLIGHT
    + String.raw`
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PATH64__'))
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
if ($trustedPeoplePresent -and $trustedPublisherPresent -and $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) {
  exit 0
}
$temporaryCertificate = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('imcodes-publisher-' + [Guid]::NewGuid().ToString('N') + '.cer'))
try {
  [IO.File]::WriteAllBytes($temporaryCertificate, $signer.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  Import-Certificate -FilePath $temporaryCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
  Import-Certificate -FilePath $temporaryCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPublisher' | Out-Null
  $trusted = Get-AuthenticodeSignature -LiteralPath $path
  if ($trusted.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $trusted.SignerCertificate) { throw 'release publisher trust installation did not validate the executable' }
  $trustedActual = Get-CertificateSha256 $trusted.SignerCertificate
  if ($trustedActual -cne $expected) { throw 'trusted release signer changed during installation' }
} finally {
  Remove-Item -LiteralPath $temporaryCertificate -Force -ErrorAction SilentlyContinue
}
`.replace('__PATH64__', executableBase64).replace('__SIGNER_SHA256__', expectedSignerSha256);
  return runWindowsTrustScript(script, run, 60_000);
}
