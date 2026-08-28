param(
  [ValidateSet('Remove', 'Sign', 'Verify', 'Manifest')]
  [string]$Mode = 'Sign',

  [Parameter(Mandatory = $true)]
  [string]$ArtifactPath,

  [string]$CodeSigningCertificateThumbprint = '',

  [string]$ExpectedSignerSha256 = '',

  [string]$TimestampUrl = 'http://timestamp.digicert.com',

  # Manifest mode only. The requested execution level to write into the PE
  # application manifest.
  [ValidateSet('asInvoker', 'requireAdministrator', 'highestAvailable')]
  [string]$RequestedExecutionLevel = 'requireAdministrator'
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
# Newest versioned SDK bin first, then the unversioned fallback. Shared by every
# SDK tool this script drives so signtool.exe and mt.exe can never be resolved
# from two different SDK installs.
function Resolve-WindowsSdkTool {
  param([Parameter(Mandatory = $true)][string]$ToolName)
  $Versioned = @(Get-ChildItem $KitRoot -Directory -ErrorAction Stop |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "x64\$ToolName" } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  $Unversioned = Join-Path $KitRoot "x64\$ToolName"
  return @($Versioned + $(if (Test-Path -LiteralPath $Unversioned -PathType Leaf) { $Unversioned }))[0]
}

if ($Mode -eq 'Manifest') {
  # Raise the UAC requested execution level.
  #
  # Without this the artifact inherits official node.exe's `asInvoker`, so a
  # double-clicked installer runs unelevated, fails its own Administrator
  # precondition, and closes its console before anyone can read why.
  #
  # ORDERING IS LOAD-BEARING: mt.exe rewrites the resource section and drops the
  # Authenticode certificate table while doing so (measured on Windows 10
  # 19045 + SDK 10.0.26100: an 81,471,184-byte signed artifact became
  # 81,463,296 bytes and NotSigned, exactly the 7,888-byte certificate table).
  # This mode must therefore run AFTER postject and BEFORE Sign, or the release
  # ships unsigned.
  $ManifestTool = Resolve-WindowsSdkTool -ToolName 'mt.exe'
  if (-not $ManifestTool) { throw 'Windows SDK mt.exe was not found.' }
  $Work = Join-Path ([System.IO.Path]::GetTempPath()) ("imcodes-manifest-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Work | Out-Null
  try {
    $ManifestFile = Join-Path $Work 'app.manifest'
    & $ManifestTool -nologo -inputresource:"$ResolvedArtifact;#1" -out:$ManifestFile
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ManifestFile -PathType Leaf)) {
      throw 'Reading the existing PE application manifest failed.'
    }
    $Xml = Get-Content -LiteralPath $ManifestFile -Raw
    if ($Xml -notmatch 'requestedExecutionLevel') {
      throw 'The PE application manifest declares no requestedExecutionLevel to raise.'
    }
    # Replace only the level attribute; uiAccess and every other element of the
    # inherited manifest (supportedOS compatibility ids in particular) must
    # survive untouched.
    $Updated = [regex]::Replace(
      $Xml,
      '(<requestedExecutionLevel[^>]*\slevel=")[^"]*(")',
      ('${1}' + $RequestedExecutionLevel + '${2}'))
    if ($Updated -eq $Xml -and $Xml -notmatch ('level="' + [regex]::Escape($RequestedExecutionLevel) + '"')) {
      throw 'Rewriting the requestedExecutionLevel produced no change.'
    }
    Set-Content -LiteralPath $ManifestFile -Value $Updated -Encoding UTF8
    & $ManifestTool -nologo -manifest $ManifestFile -outputresource:"$ResolvedArtifact;#1"
    if ($LASTEXITCODE -ne 0) { throw 'Writing the updated PE application manifest failed.' }

    # Read the level back out of the artifact itself. Trusting mt.exe's exit
    # code alone would let a silently-unchanged binary ship.
    $VerifyFile = Join-Path $Work 'verify.manifest'
    & $ManifestTool -nologo -inputresource:"$ResolvedArtifact;#1" -out:$VerifyFile
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $VerifyFile -PathType Leaf)) {
      throw 'Reading back the updated PE application manifest failed.'
    }
    if ((Get-Content -LiteralPath $VerifyFile -Raw) -notmatch ('level="' + [regex]::Escape($RequestedExecutionLevel) + '"')) {
      throw "The PE application manifest does not declare level=$RequestedExecutionLevel after the update."
    }
  } finally {
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

$SignTool = Resolve-WindowsSdkTool -ToolName 'signtool.exe'
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
if ($null -eq $Signature.SignerCertificate) {
  throw "Windows release-artifact Authenticode verification failed: $($Signature.Status)"
}

# Exact signer pinning below proves which certificate signed the bytes, but it
# says nothing about whether an ordinary customer machine trusts that signer.
# In particular, importing a self-signed release leaf into TrustedPeople on a
# CI runner makes Get-AuthenticodeSignature and SignTool look green while the
# same executable remains an unknown publisher everywhere else. Endpoint
# security products can then deny privileged child operations (for example
# Task Scheduler registration) even though the PE contains a signature.
#
# Reject a self-issued leaf explicitly even if somebody has locally trusted it,
# then build the normal Windows certificate chain without custom trust. NoCheck
# disables only revocation network access; it does not relax root trust.
$Signer = $Signature.SignerCertificate
if ($Signer.Subject -ceq $Signer.Issuer) {
  throw 'Windows release-artifact signer is self-signed; a publicly trusted Authenticode chain is required.'
}
$Chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
try {
  $Chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
  $Chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
  if (-not $Chain.Build($Signer)) {
    $Statuses = @($Chain.ChainStatus | ForEach-Object { $_.Status.ToString() }) -join ','
    throw "Windows release-artifact signer chain is not trusted by the machine: $Statuses"
  }
  $Root = $Chain.ChainElements[$Chain.ChainElements.Count - 1].Certificate
  if ($Chain.ChainElements.Count -lt 2 -or
      $Root.Thumbprint -ceq $Signer.Thumbprint -or
      $Root.Subject -cne $Root.Issuer) {
    throw 'Windows release-artifact signer is peer-trusted without a public root chain.'
  }
} finally {
  $Chain.Dispose()
}
if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Windows release-artifact Authenticode verification failed: $($Signature.Status)"
}

$Sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $ActualSignerSha256 = [BitConverter]::ToString(
    $Sha256.ComputeHash($Signer.RawData)
  ).Replace('-', '').ToLowerInvariant()
} finally {
  $Sha256.Dispose()
}
if ($ActualSignerSha256 -cne $ExpectedSignerSha256.ToLowerInvariant()) {
  throw 'Windows release-artifact signer does not match the compiled release trust anchor.'
}

& $SignTool verify /pa /all $ResolvedArtifact
if ($LASTEXITCODE -ne 0) { throw 'Windows release-artifact WinVerifyTrust policy verification failed.' }
