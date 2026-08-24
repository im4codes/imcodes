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
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $SourceDirectory)
$NativePins = & (Join-Path $SourceDirectory 'load-native-pins.ps1') -RepositoryRoot $RepositoryRoot
$Revision = $NativePins.LibwebrtcRevision
$DepotToolsRevision = $NativePins.DepotToolsRevision
. (Join-Path $SourceDirectory 'initialize-hermetic-windows-git.ps1') -WorkspaceRoot $CheckoutRoot
. (Join-Path $SourceDirectory 'invoke-native-logged.ps1')
$DepotTools = Join-Path $CheckoutRoot 'depot_tools'
$WebRtcRoot = Join-Path $CheckoutRoot 'src'
$TargetDirectory = Join-Path $WebRtcRoot 'third_party\imcodes_remote_desktop'
$BuildDirectory = Join-Path $WebRtcRoot 'out\imcodes_remote_desktop'
$RestoredBuildCache = Join-Path $CheckoutRoot 'imcodes_remote_desktop.restored-build-cache'
$RootBuildPath = Join-Path $WebRtcRoot 'BUILD.gn'
$RootBuildOriginal = $null
$ArtifactRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArtifactRoot)
$ExpectedSources = @(
  'BUILD.gn',
  'libwebrtc-sdk.gni', 'sdk_anchor.cc',
  'load-native-pins.ps1', 'initialize-hermetic-windows-git.ps1',
  'invoke-native-logged.ps1',
  'display_capture.cc', 'display_capture.h', 'display_capture_unittest.cc',
  'display_preferences.cc', 'display_preferences.h',
  'ice_candidate_queue.cc', 'ice_candidate_queue.h',
  'ice_candidate_queue_unittest.cc',
  'input_injector.cc', 'input_injector.h', 'input_injector_unittest.cc',
  'json_protocol.cc', 'json_protocol.h', 'json_protocol_unittest.cc',
  'brand_logo_generated.h',
  'consent_ipc.cc', 'consent_ipc.h',
  'privacy_ipc.cc', 'privacy_ipc.h',
  'privacy_ipc_unittest.cc',
  'consent_prompt.cc', 'consent_prompt.h',
  'local_indicator.cc', 'local_indicator.h',
  'mf_h264_encoder.cc', 'mf_h264_encoder.h', 'mf_h264_encoder_unittest.cc',
  'peer_session.cc', 'peer_session.h',
  'pipe_ipc.cc', 'pipe_ipc.h', 'pipe_ipc_unittest.cc',
  'quality_ladder.cc', 'quality_ladder.h', 'quality_ladder_unittest.cc',
  'unlock_secret.cc', 'unlock_secret.h',
  'worker_policy.cc', 'worker_policy.h', 'worker_policy_unittest.cc',
  'virtual_display_controller.cc', 'virtual_display_controller.h',
  'worker_main.cc'
)

# Qualification builds can be prepared by the SYSTEM node service and then
# resumed by a dedicated SSH build account. Trust only these two explicit,
# pinned checkout roots for this process; never weaken Git's global policy.
$env:GIT_CONFIG_COUNT = '4'
# The pinned DEPS contains standalone Chromium mirrors of LLVM subtrees. They
# are not GitHub repositories, so exempt the longer LLVM prefix from the broad
# canonical-upstream rewrite below. Git chooses the longest insteadOf match.
$env:GIT_CONFIG_KEY_0 = 'url.https://chromium.googlesource.com/external/github.com/llvm/llvm-project/.insteadOf'
$env:GIT_CONFIG_VALUE_0 = 'https://chromium.googlesource.com/external/github.com/llvm/llvm-project/'
$env:GIT_CONFIG_KEY_1 = 'url.https://github.com/.insteadOf'
$env:GIT_CONFIG_VALUE_1 = 'https://chromium.googlesource.com/external/github.com/'
$env:GIT_CONFIG_KEY_2 = 'safe.directory'
$env:GIT_CONFIG_VALUE_2 = $DepotTools
$env:GIT_CONFIG_KEY_3 = 'safe.directory'
$env:GIT_CONFIG_VALUE_3 = $WebRtcRoot

if ([string]::IsNullOrWhiteSpace($CheckoutRoot) -or
    [System.IO.Path]::GetPathRoot($CheckoutRoot) -eq $CheckoutRoot) {
  throw 'CheckoutRoot must be a dedicated non-root directory.'
}

New-Item -ItemType Directory -Force -Path $CheckoutRoot | Out-Null
# actions/cache restores the compact native output before the multi-repository
# WebRTC checkout exists. Move it out of the future clone destination, then put
# it back after gclient has materialized the pinned source tree. This keeps the
# useful ~200 MB object cache independent from the uncacheable ~20 GB checkout.
if (-not (Test-Path (Join-Path $WebRtcRoot '.git')) -and
    (Test-Path -LiteralPath $BuildDirectory -PathType Container)) {
  Remove-Item -Recurse -Force -LiteralPath $RestoredBuildCache -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $BuildDirectory -Destination $RestoredBuildCache
  Remove-Item -Recurse -Force -LiteralPath $WebRtcRoot
}
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
$WinToolsBootstrap = Get-Item -LiteralPath (Join-Path $DepotTools 'bootstrap\win_tools.bat')
if ($WinToolsBootstrap.PSIsContainer -or
    ($WinToolsBootstrap.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw 'Pinned depot_tools Windows bootstrap is not a regular file.'
}
# gclient's pinned git_cache.py invokes git.bat on Windows. Fresh GitHub runner
# images expose git.exe but no git.bat, and DEPOT_TOOLS_UPDATE=0 deliberately
# skips the auto-update path that normally creates depot_tools' wrappers. Run
# the bootstrap from the already-pinned depot_tools checkout, whose pinned CIPD
# manifest supplies Python and generates wrappers for the discovered system Git.
$BootstrapStdout = Join-Path $CheckoutRoot 'depot-tools-bootstrap.stdout.log'
$BootstrapStderr = Join-Path $CheckoutRoot 'depot-tools-bootstrap.stderr.log'
$BootstrapProcess = Start-Process -FilePath $env:ComSpec `
  -ArgumentList @('/d', '/s', '/c', "`"$($WinToolsBootstrap.FullName)`"") `
  -RedirectStandardOutput $BootstrapStdout `
  -RedirectStandardError $BootstrapStderr `
  -NoNewWindow -Wait -PassThru
$BootstrapExitCode = $BootstrapProcess.ExitCode
if ($BootstrapExitCode -ne 0) {
  $BootstrapError = Get-Content -Raw -LiteralPath $BootstrapStderr -ErrorAction SilentlyContinue
  throw "Pinned depot_tools Windows bootstrap failed ($BootstrapExitCode): $BootstrapError"
}
$PostBootstrapDepotToolsRevision = (& git -C $DepotTools rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $PostBootstrapDepotToolsRevision -ne $DepotToolsRevision) {
  throw "Pinned depot_tools revision changed during Windows bootstrap: $PostBootstrapDepotToolsRevision"
}
$DepotGitWrapper = Get-Item -LiteralPath (Join-Path $DepotTools 'git.bat')
if ($DepotGitWrapper.PSIsContainer -or
    ($DepotGitWrapper.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw 'Pinned depot_tools Git wrapper is not a regular file.'
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
$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $SourceDirectory)
$DriverKitResolver = Join-Path $RepositoryRoot 'scripts\resolve-windows-driver-kit.ps1'
# Fail before the multi-gigabyte WebRTC sync/build when the hosted image lacks
# the WDK catalog tool required by the signed virtual-display release package.
$WindowsDriverKitBin = (& $DriverKitResolver).Trim()
$env:PATH = "$DepotTools;$env:PATH"
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:DEPOT_TOOLS_UPDATE = '0'
$env:GYP_MSVS_OVERRIDE_PATH = $VisualStudioRoot
$env:vs2022_install = $VisualStudioRoot
$env:VPYTHON_BYPASS = 'manually managed by the pinned IM.codes worker build'
# Chromium hosts mirrors of many GitHub projects behind one anonymous quota.
# The process-scoped Git configuration above resolves ordinary two-component
# repositories to their canonical upstream while retaining Chromium's
# standalone LLVM subtree mirrors; DEPS still pins every commit.

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

  if (Test-Path -LiteralPath $RestoredBuildCache -PathType Container) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BuildDirectory) | Out-Null
    Remove-Item -Recurse -Force -LiteralPath $BuildDirectory -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $RestoredBuildCache -Destination $BuildDirectory
    $RestoredAt = [DateTime]::UtcNow
    Get-ChildItem -LiteralPath $BuildDirectory -Recurse -File |
      ForEach-Object {
        try {
          [System.IO.File]::SetLastWriteTimeUtc($_.FullName, $RestoredAt)
        } catch [System.Management.Automation.MethodInvocationException] {
          if ($_.Exception.InnerException -isnot [System.IO.FileNotFoundException]) { throw }
        }
      }
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
  # The legacy full-checkout builder shares BUILD.gn with the SDK producer.
  # Supply its dependency-only anchor without making it part of the product
  # source inventory or compiled worker bytes.
  Copy-Item -LiteralPath (Join-Path $SourceDirectory 'sdk_anchor.cc') `
    -Destination (Join-Path $TargetDirectory 'sdk_anchor.cc') -Force

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
  Invoke-NativeLogged -Command { & gn gen $BuildDirectory "--args=$GnArgs" } `
    -LogRoot $CheckoutRoot -Name 'worker-gn-gen'
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
      'third_party/imcodes_remote_desktop:privacy_ipc_unittests',
      'third_party/imcodes_remote_desktop:worker_policy_unittests',
      'third_party/imcodes_remote_desktop:mf_h264_encoder_unittests'
    )
  }
  Invoke-NativeLogged -Command { & autoninja -C $BuildDirectory -j $Jobs @Targets } `
    -LogRoot $CheckoutRoot -Name 'worker-autoninja'
  if ($RunNativeTests) {
    foreach ($TestName in @(
        'display_capture_unittests',
        'quality_ladder_unittests',
        'input_injector_unittests',
        'ice_candidate_queue_unittests',
        'json_protocol_unittests',
        'privacy_ipc_unittests',
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
    DriverKitBin = $WindowsDriverKitBin
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
