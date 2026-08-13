param(
  [string]$CheckoutRoot = 'E:\imcodes-webrtc',
  [string]$ArtifactRoot = 'E:\imcodes-build-output',
  [ValidateRange(1, 16)][int]$Jobs = 2,
  [string]$WorkerVersion = '0.1.2',
  [string]$VisualStudioRoot = '',
  [string]$CodeSigningCertificateThumbprint = '',
  [string]$CodeSigningTimestampUrl = '',
  [switch]$RequireAuthenticodeSignature,
  [switch]$RunNativeTests,
  [switch]$SkipSync
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Revision = 'f20ebb8adbf4fa781830e4384c61f732bd28a217'
$DepotToolsRevision = 'a1bda5b6167435ad0666191f0353f242104f5845'
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$DepotTools = Join-Path $CheckoutRoot 'depot_tools'
$WebRtcRoot = Join-Path $CheckoutRoot 'src'
$TargetDirectory = Join-Path $WebRtcRoot 'third_party\imcodes_remote_desktop'
$BuildDirectory = Join-Path $WebRtcRoot 'out\imcodes_remote_desktop'
$RootBuildPath = Join-Path $WebRtcRoot 'BUILD.gn'
$RootBuildOriginal = $null
$ExpectedSources = @(
  'BUILD.gn',
  'display_capture.cc', 'display_capture.h', 'display_capture_unittest.cc',
  'ice_candidate_queue.cc', 'ice_candidate_queue.h',
  'ice_candidate_queue_unittest.cc',
  'input_injector.cc', 'input_injector.h', 'input_injector_unittest.cc',
  'json_protocol.cc', 'json_protocol.h', 'json_protocol_unittest.cc',
  'local_indicator.cc', 'local_indicator.h',
  'mf_h264_encoder.cc', 'mf_h264_encoder.h', 'mf_h264_encoder_unittest.cc',
  'peer_session.cc', 'peer_session.h',
  'quality_ladder.cc', 'quality_ladder.h', 'quality_ladder_unittest.cc',
  'worker_policy.cc', 'worker_policy.h', 'worker_policy_unittest.cc',
  'virtual_display_controller.cc', 'virtual_display_controller.h',
  'worker_main.cc'
)

# Qualification builds can be prepared by the SYSTEM node service and then
# resumed by a dedicated SSH build account. Trust only these two explicit,
# pinned checkout roots for this process; never weaken Git's global policy.
$env:GIT_CONFIG_COUNT = '3'
$env:GIT_CONFIG_KEY_0 = 'url.https://github.com/.insteadOf'
$env:GIT_CONFIG_VALUE_0 = 'https://chromium.googlesource.com/external/github.com/'
$env:GIT_CONFIG_KEY_1 = 'safe.directory'
$env:GIT_CONFIG_VALUE_1 = $DepotTools
$env:GIT_CONFIG_KEY_2 = 'safe.directory'
$env:GIT_CONFIG_VALUE_2 = $WebRtcRoot

if ([string]::IsNullOrWhiteSpace($CheckoutRoot) -or
    [System.IO.Path]::GetPathRoot($CheckoutRoot) -eq $CheckoutRoot) {
  throw 'CheckoutRoot must be a dedicated non-root directory.'
}

New-Item -ItemType Directory -Force -Path $CheckoutRoot | Out-Null
if (-not (Test-Path (Join-Path $DepotTools '.git'))) {
  & git clone --filter=blob:none --no-checkout https://chromium.googlesource.com/chromium/tools/depot_tools.git $DepotTools
  if ($LASTEXITCODE -ne 0) { throw 'depot_tools clone failed' }
}
$CurrentDepotToolsRevision = (& git -C $DepotTools rev-parse HEAD 2>$null).Trim()
if ($CurrentDepotToolsRevision -ne $DepotToolsRevision) {
  if ($SkipSync) {
    throw "SkipSync depot_tools revision mismatch: $CurrentDepotToolsRevision"
  }
  & git -C $DepotTools fetch origin $DepotToolsRevision --depth=1
  if ($LASTEXITCODE -ne 0) { throw 'Pinned depot_tools revision fetch failed' }
  & git -C $DepotTools checkout --detach $DepotToolsRevision
  if ($LASTEXITCODE -ne 0) { throw 'Pinned depot_tools revision checkout failed' }
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
if ([string]::IsNullOrWhiteSpace($VisualStudioRoot) -or
    -not (Test-Path (Join-Path $VisualStudioRoot 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt'))) {
  throw 'Visual Studio C++ toolchain not found.'
}
$env:PATH = "$DepotTools;$env:PATH"
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:DEPOT_TOOLS_UPDATE = '0'
$env:GYP_MSVS_OVERRIDE_PATH = $VisualStudioRoot
$env:vs2022_install = $VisualStudioRoot
$env:VPYTHON_BYPASS = 'manually managed by the pinned IM.codes worker build'
# Chromium hosts mirrors of many GitHub projects behind one anonymous quota.
# The process-scoped Git configuration above resolves that exact prefix to
# each project's canonical upstream; DEPS still pins every commit.

if (-not $SkipSync -and -not (Test-Path (Join-Path $WebRtcRoot '.git'))) {
  & git clone --filter=blob:none --no-checkout https://webrtc.googlesource.com/src.git $WebRtcRoot
  if ($LASTEXITCODE -ne 0) { throw 'WebRTC checkout failed' }
  Push-Location $CheckoutRoot
  try { & gclient config --name src https://webrtc.googlesource.com/src.git }
  finally { Pop-Location }
}

Push-Location $WebRtcRoot
try {
  if ($SkipSync) {
    if (-not (Test-Path (Join-Path $WebRtcRoot '.git'))) {
      throw 'SkipSync requires an existing WebRTC checkout.'
    }
    $CurrentRevision = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $CurrentRevision -ne $Revision) {
      throw "SkipSync checkout revision mismatch: $CurrentRevision"
    }
  } else {
    & git fetch origin $Revision --depth=1
    if ($LASTEXITCODE -ne 0) { throw 'Pinned WebRTC revision fetch failed' }
    & git checkout --detach $Revision
    if ($LASTEXITCODE -ne 0) { throw 'Pinned WebRTC revision checkout failed' }
    & gclient sync -D -j $Jobs --revision "src@$Revision"
    if ($LASTEXITCODE -ne 0) { throw 'Pinned WebRTC dependency sync failed' }
  }

  New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
  foreach ($Name in $ExpectedSources) {
    $Source = Get-Item -LiteralPath (Join-Path $SourceDirectory $Name)
    if (-not $Source.PSIsContainer -and
        -not ($Source.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      $TargetPath = Join-Path $TargetDirectory $Name
      Copy-Item -LiteralPath $Source.FullName -Destination $TargetPath -Force
      # Controlled uploads/copies can retain a timestamp older than the prior
      # object file even when their bytes changed. Ninja is timestamp-driven,
      # so explicitly mark the trusted overlay current after the byte copy.
      [System.IO.File]::SetLastWriteTimeUtc($TargetPath, [DateTime]::UtcNow)
    } else {
      throw "Invalid native worker source: $Name"
    }
  }

  # GN only loads BUILD files reachable from the root graph. Attach the
  # product target for generation/build, then restore the pinned upstream file
  # byte-for-byte in finally. Keeping the overlay temporary prevents source
  # drift while still producing a normal libwebrtc-linked executable.
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $RootBuildOriginal = [System.IO.File]::ReadAllBytes($RootBuildPath)
  $RootBuildText = [System.Text.Encoding]::UTF8.GetString($RootBuildOriginal)
  $RootNeedle = '    deps = [ ":webrtc" ]'
  $RootReplacement = @'
    deps = [
      ":webrtc",
      "//third_party/imcodes_remote_desktop:imcodes_remote_desktop_worker",
    ]
'@
  $RootReplacement = $RootReplacement.TrimEnd("`r", "`n")
  $NeedleCount = ([regex]::Matches(
      $RootBuildText, [regex]::Escape($RootNeedle))).Count
  $ReplacementCount = ([regex]::Matches(
      $RootBuildText, [regex]::Escape($RootReplacement))).Count
  if ($NeedleCount -eq 0 -and $ReplacementCount -eq 1) {
    # A killed remote shell can prevent finally from restoring the temporary
    # overlay. Accept only our byte-exact prior replacement, reconstruct the
    # pinned upstream content, and retain that as the restoration snapshot.
    $RootBuildText = $RootBuildText.Replace($RootReplacement, $RootNeedle)
    $RootBuildOriginal = $Utf8NoBom.GetBytes($RootBuildText)
    $NeedleCount = 1
    $ReplacementCount = 0
  }
  if ($NeedleCount -ne 1 -or $ReplacementCount -ne 0) {
    throw 'Pinned WebRTC root BUILD.gn attachment point changed.'
  }
  $RootBuildText = $RootBuildText.Replace($RootNeedle, $RootReplacement)
  [System.IO.File]::WriteAllText($RootBuildPath, $RootBuildText, $Utf8NoBom)

  $GnArgs = @(
    # PowerShell removes ordinary embedded quotes when invoking a native
    # executable. The backslashes preserve literal GN string quotes.
    'target_os=\"win\"'
    'target_cpu=\"x64\"'
    'is_debug=false'
    'is_component_build=false'
    "rtc_include_tests=$($RunNativeTests.ToString().ToLowerInvariant())"
    'rtc_build_examples=false'
    'rtc_enable_protobuf=false'
    'use_rtti=false'
  ) -join ' '
  & gn gen $BuildDirectory "--args=$GnArgs"
  if ($LASTEXITCODE -ne 0) { throw 'GN generation failed' }
  $Targets = @(
    'third_party/imcodes_remote_desktop:imcodes_remote_desktop_worker'
  )
  if ($RunNativeTests) {
    $Targets += @(
      'third_party/imcodes_remote_desktop:display_capture_unittests',
      'third_party/imcodes_remote_desktop:quality_ladder_unittests',
      'third_party/imcodes_remote_desktop:input_injector_unittests',
      'third_party/imcodes_remote_desktop:ice_candidate_queue_unittests',
      'third_party/imcodes_remote_desktop:json_protocol_unittests',
      'third_party/imcodes_remote_desktop:worker_policy_unittests',
      'third_party/imcodes_remote_desktop:mf_h264_encoder_unittests'
    )
  }
  & autoninja -C $BuildDirectory -j $Jobs @Targets
  if ($LASTEXITCODE -ne 0) { throw 'Native worker build failed' }
  if ($RunNativeTests) {
    foreach ($TestName in @(
        'display_capture_unittests',
        'quality_ladder_unittests',
        'input_injector_unittests',
        'ice_candidate_queue_unittests',
        'json_protocol_unittests',
        'worker_policy_unittests',
        'mf_h264_encoder_unittests')) {
      & (Join-Path $BuildDirectory "$TestName.exe")
      if ($LASTEXITCODE -ne 0) { throw "Native test failed: $TestName" }
    }
  }

  New-Item -ItemType Directory -Force -Path $ArtifactRoot | Out-Null
  $LicenseGenerator = Join-Path $WebRtcRoot 'tools_webrtc\libs\generate_licenses.py'
  & vpython3 $LicenseGenerator `
    '--target' '//third_party/imcodes_remote_desktop:imcodes_remote_desktop_worker' `
    $ArtifactRoot $BuildDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Pinned WebRTC license generation failed.' }
  $GeneratedLicense = Join-Path $ArtifactRoot 'LICENSE.md'
  $ThirdPartyNotices = Join-Path $ArtifactRoot 'THIRD_PARTY_NOTICES.webrtc.md'
  if (-not (Test-Path -LiteralPath $GeneratedLicense -PathType Leaf)) {
    throw 'Pinned WebRTC license generator produced no output.'
  }
  Move-Item -LiteralPath $GeneratedLicense -Destination $ThirdPartyNotices -Force
  $Executable = Join-Path $BuildDirectory 'imcodes_remote_desktop_worker.exe'
  $Artifact = Join-Path $ArtifactRoot 'imcodes-remote-desktop-worker.exe'
  Copy-Item -LiteralPath $Executable -Destination $Artifact -Force

  if (-not [string]::IsNullOrWhiteSpace($CodeSigningCertificateThumbprint)) {
    if ($CodeSigningCertificateThumbprint -notmatch '^[0-9A-Fa-f]{40}$') {
      throw 'CodeSigningCertificateThumbprint must be a SHA-1 certificate thumbprint.'
    }
    $SignTool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Filter signtool.exe -Recurse |
      Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
      Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $SignTool) { throw 'Windows SDK signtool.exe was not found.' }
    $SignArguments = @(
      'sign', '/sha1', $CodeSigningCertificateThumbprint,
      '/fd', 'sha256'
    )
    if (-not [string]::IsNullOrWhiteSpace($CodeSigningTimestampUrl)) {
      $SignArguments += @('/tr', $CodeSigningTimestampUrl, '/td', 'sha256')
    }
    $SignArguments += $Artifact
    & $SignTool.FullName @SignArguments
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed.' }
  }

  $Signature = Get-AuthenticodeSignature -LiteralPath $Artifact
  if ($RequireAuthenticodeSignature -and
      ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
       $null -eq $Signature.SignerCertificate)) {
    throw "Worker Authenticode verification failed: $($Signature.Status)"
  }
  if ($null -eq $Signature.SignerCertificate) {
    throw 'Worker manifest requires an Authenticode signer certificate.'
  }
  $Sha256Algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $SignerSha256 = [BitConverter]::ToString(
      $Sha256Algorithm.ComputeHash($Signature.SignerCertificate.RawData)
    ).Replace('-', '').ToLowerInvariant()
  } finally {
    $Sha256Algorithm.Dispose()
  }

  $Msvc = (Get-Content -Raw -LiteralPath (Join-Path $VisualStudioRoot 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt')).Trim()
  $WindowsSdkDirectory = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Lib' -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  if (-not $WindowsSdkDirectory) { throw 'Versioned Windows SDK library directory was not found.' }
  $WindowsSdk = $WindowsSdkDirectory.Name
  $NinjaVersion = (& ninja --version).Trim()
  $Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Artifact).Hash.ToLowerInvariant()
  $Size = (Get-Item -LiteralPath $Artifact).Length
  $VirtualDisplayBuild = Join-Path (Split-Path -Parent $SourceDirectory) 'windows-virtual-display\build-virtual-display.ps1'
  $VirtualDisplayPackage = Join-Path $ArtifactRoot 'virtual-display-package'
  $VirtualDisplayArguments = @{
    ArtifactRoot = $VirtualDisplayPackage
    VisualStudioRoot = $VisualStudioRoot
    ThirdPartyNoticesPath = $ThirdPartyNotices
    CodeSigningCertificateThumbprint = $CodeSigningCertificateThumbprint
  }
  if (-not [string]::IsNullOrWhiteSpace($CodeSigningTimestampUrl)) {
    $VirtualDisplayArguments.CodeSigningTimestampUrl = $CodeSigningTimestampUrl
  }
  if ($RequireAuthenticodeSignature) {
    $VirtualDisplayArguments.RequireAuthenticodeSignature = $true
  }
  & $VirtualDisplayBuild @VirtualDisplayArguments
  if ($LASTEXITCODE -ne 0) { throw 'Virtual display package build failed.' }
  $VirtualDisplayArchive = Join-Path $ArtifactRoot 'imcodes-virtual-display.zip'
  Remove-Item -Force $VirtualDisplayArchive -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $VirtualDisplayPackage '*') `
    -DestinationPath $VirtualDisplayArchive -CompressionLevel Optimal
  $VirtualDisplayArchiveSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $VirtualDisplayArchive).Hash.ToLowerInvariant()
  $VirtualDisplayArchiveSize = (Get-Item -LiteralPath $VirtualDisplayArchive).Length
  Remove-Item -Recurse -Force -LiteralPath $VirtualDisplayPackage
  # The WebRTC notice is copied into the signed virtual-display package above.
  # Keep the top-level release set exact (worker, manifest, package archive) so
  # the verifier and upgrade path cannot accept unmanifested sidecars.
  Remove-Item -Force -LiteralPath $ThirdPartyNotices
  $Manifest = [ordered]@{
    manifestVersion = 2
    workerVersion = $WorkerVersion
    protocolVersion = 2
    ipcVersion = 1
    os = 'win32'
    arch = 'x64'
    fileName = 'imcodes-remote-desktop-worker.exe'
    size = $Size
    sha256 = $Sha256
    authenticodeSignerSha256 = $SignerSha256
    libwebrtcRevision = $Revision
    virtualDisplay = [ordered]@{
      archiveFileName = 'imcodes-virtual-display.zip'
      packageManifestFileName = 'imcodes-virtual-display.manifest.json'
      size = $VirtualDisplayArchiveSize
      sha256 = $VirtualDisplayArchiveSha256
    }
    toolchain = [ordered]@{
      msvc = $Msvc
      windowsSdk = $WindowsSdk
      cmake = 'not-used-gn'
      ninja = $NinjaVersion
      depotTools = $DepotToolsRevision
    }
  }
  $ManifestPath = "$Artifact.manifest.json"
  [System.IO.File]::WriteAllText(
    $ManifestPath,
    ($Manifest | ConvertTo-Json -Depth 4),
    $Utf8NoBom)
  Write-Output "worker=$Artifact"
  Write-Output "manifest=$ManifestPath"
  Write-Output "sha256=$Sha256"
} finally {
  if ($null -ne $RootBuildOriginal) {
    [System.IO.File]::WriteAllBytes($RootBuildPath, $RootBuildOriginal)
  }
  Pop-Location
}
