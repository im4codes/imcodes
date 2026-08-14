param(
  [Parameter(Mandatory = $true)][string]$SdkRoot,
  [string]$ArtifactRoot = 'E:\imcodes-build-output',
  [string]$WorkerVersion = '0.1.2',
  [string]$VisualStudioRoot = '',
  [string]$CodeSigningCertificateThumbprint = '',
  [string]$ExpectedSignerSha256 = '',
  [string]$CodeSigningTimestampUrl = 'http://timestamp.digicert.com',
  [switch]$RequireAuthenticodeSignature,
  [switch]$RunNativeTests
)

$ErrorActionPreference = 'Stop'
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $SourceDirectory)
. (Join-Path $SourceDirectory 'invoke-native-logged.ps1')
$SdkRoot = (Resolve-Path -LiteralPath $SdkRoot).Path
$ArtifactRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArtifactRoot)
$BuildRoot = Join-Path $env:TEMP "imcodes-worker-sdk-$([Guid]::NewGuid().ToString('N'))"
$ObjectRoot = Join-Path $BuildRoot 'obj'
$BinRoot = Join-Path $BuildRoot 'bin'
$OverlayRoot = Join-Path $BuildRoot 'include'
$Metadata = Get-Content -Raw -LiteralPath (Join-Path $SdkRoot 'sdk-build.json') | ConvertFrom-Json
$Revision = [string]$Metadata.libwebrtcRevision
$DepotToolsRevision = [string]$Metadata.depotToolsRevision

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
$Msvc = (Get-Content -Raw -LiteralPath (Join-Path $VisualStudioRoot 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt')).Trim()
if ($Msvc -cne [string]$Metadata.toolchain.msvc) {
  throw "SDK MSVC mismatch: expected $($Metadata.toolchain.msvc), found $Msvc"
}
$WindowsSdk = [string]$Metadata.toolchain.windowsSdk
$WindowsSdkRoot = 'C:\Program Files (x86)\Windows Kits\10'
$WindowsSdkLib = Join-Path $WindowsSdkRoot "Lib\$WindowsSdk"
if (-not (Test-Path -LiteralPath $WindowsSdkLib -PathType Container)) {
  throw "SDK Windows Kit is not installed: $WindowsSdk"
}
$DriverKitBin = (& (Join-Path $RepositoryRoot 'scripts\resolve-windows-driver-kit.ps1')).Trim()

$Compiler = Join-Path $SdkRoot 'toolchain\bin\clang-cl.exe'
$Linker = Join-Path $SdkRoot 'toolchain\bin\lld-link.exe'
$IncludeRoot = Join-Path $SdkRoot 'include'
$GeneratedRoot = Join-Path $SdkRoot 'gen'
$ProductionSdk = Join-Path $SdkRoot 'lib\imcodes_libwebrtc_sdk.lib'
$TestSdk = Join-Path $SdkRoot 'lib\imcodes_libwebrtc_test_sdk.lib'
$LibcxxRuntimeSdk = Join-Path $SdkRoot 'lib\imcodes_libcxx_runtime_sdk.lib'
$ExecutableManifests = [string[]]@(
  (Join-Path $SdkRoot 'toolchain\manifest\as_invoker.manifest'),
  (Join-Path $SdkRoot 'toolchain\manifest\common_controls.manifest'),
  (Join-Path $SdkRoot 'toolchain\manifest\compatibility.manifest')
)
foreach ($Required in (@(
    $Compiler,
    $Linker,
    $ProductionSdk,
    $TestSdk,
    $LibcxxRuntimeSdk,
    (Join-Path $IncludeRoot 'buildtools\third_party\libc++\__config_site'),
    (Join-Path $IncludeRoot 'third_party\libc++\src\include\__config'),
    (Join-Path $SdkRoot 'toolchain\lib\clang\23\include\stddef.h'),
    (Join-Path $SdkRoot 'toolchain\lib\clang\23\include\__stddef_max_align_t.h')
  ) + $ExecutableManifests)) {
  if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) { throw "SDK file is missing: $Required" }
}

$Imsvc = @(
  "-imsvc$VisualStudioRoot\VC\Tools\MSVC\$Msvc\include",
  "-imsvc$VisualStudioRoot\VC\Auxiliary\VS\include",
  "-imsvc$WindowsSdkRoot\Include\$WindowsSdk\ucrt",
  "-imsvc$WindowsSdkRoot\Include\$WindowsSdk\um",
  "-imsvc$WindowsSdkRoot\Include\$WindowsSdk\shared",
  "-imsvc$WindowsSdkRoot\Include\$WindowsSdk\winrt",
  "-imsvc$WindowsSdkRoot\Include\$WindowsSdk\cppwinrt"
)
$Defines = @(
  'NOMINMAX', 'WIN32_LEAN_AND_MEAN', 'UNICODE', '_UNICODE', '_HAS_NODISCARD',
  '_CRT_NONSTDC_NO_WARNINGS', '_WINSOCK_DEPRECATED_NO_WARNINGS',
  'CR_CLANG_REVISION=\"llvmorg-23-init-19482-g53d18800-1\"',
  '_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE',
  '_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS', '_LIBCPP_INSTRUMENTED_WITH_ASAN=0',
  'CR_LIBCXX_REVISION=5abc7f839700f0f17338434e1c1c6a8c87c00c11', '__STD_C',
  '_CRT_RAND_S', '_CRT_SECURE_NO_DEPRECATE', '_SCL_SECURE_NO_DEPRECATE',
  '_ATL_NO_OPENGL', '_WINDOWS', 'CERT_CHAIN_PARA_HAS_EXTRA_FIELDS', 'PSAPI_VERSION=2',
  'WIN32', '_SECURE_ATL', 'WINAPI_FAMILY=WINAPI_FAMILY_DESKTOP_APP', 'USE_AURA=1',
  'NTDDI_VERSION=NTDDI_WIN11_GE', '_WIN32_WINNT=0x0A00', 'WINVER=0x0A00',
  'WINCRYPT_USE_SYMBOL_PREFIX', 'NDEBUG', 'NVALGRIND', 'DYNAMIC_ANNOTATIONS_ENABLED=0',
  'WEBRTC_ENABLE_PROTOBUF=0', 'WEBRTC_STRICT_FIELD_TRIALS=0',
  'WEBRTC_INCLUDE_INTERNAL_AUDIO_DEVICE', 'RTC_ENABLE_VP9',
  'RTC_DAV1D_IN_INTERNAL_DECODER_FACTORY', 'WEBRTC_HAVE_SCTP',
  'WEBRTC_ENCODER_PSNR_STATS', 'PROTOBUF_ENABLE_DEBUG_LOGGING_MAY_LEAK_PII=0',
  'WEBRTC_ENABLE_AVX2', 'RTC_ENABLE_WIN_WGC', 'WEBRTC_DEPRECATE_PLAN_B',
  'WEBRTC_NON_STATIC_TRACE_EVENT_HANDLERS=1', 'WEBRTC_WIN', 'ABSL_ALLOCATOR_NOTHROW=1',
  'CHROMIUM', 'LIBYUV_DISABLE_NEON', 'LIBYUV_DISABLE_SVE', 'LIBYUV_DISABLE_SME',
  'LIBYUV_DISABLE_LSX', 'LIBYUV_DISABLE_LASX', 'HAVE_WEBRTC_VIDEO',
  'UNSAFE_BUFFERS_BUILD'
) | ForEach-Object { "-D$_" }
$IncludeArguments = @(
  "-I$OverlayRoot",
  "-I$IncludeRoot",
  "-I$GeneratedRoot",
  "-I$(Join-Path $IncludeRoot 'buildtools\third_party\libc++')",
  "-I$(Join-Path $IncludeRoot 'third_party\abseil-cpp')",
  "-I$(Join-Path $IncludeRoot 'third_party\perfetto\include')",
  "-I$(Join-Path $GeneratedRoot 'third_party\perfetto\build_config')",
  "-I$(Join-Path $GeneratedRoot 'third_party\perfetto')",
  "-I$(Join-Path $IncludeRoot 'third_party\libyuv\include')",
  "-I$(Join-Path $IncludeRoot 'third_party\jsoncpp\source\include')",
  "-I$(Join-Path $IncludeRoot 'third_party\googletest\src\googletest\include')",
  "-I$(Join-Path $IncludeRoot 'third_party\googletest\src\googlemock\include')",
  "-I$(Join-Path $IncludeRoot 'third_party\libc++\src\include')"
)
$CompileArguments = @(
  '/nologo', '/c', '/TP', '/std:c++20', '/GR-', '/MT', '/O2', '/Oy-', '/Gy', '/Gw',
  '/bigobj', '/utf-8', '/Zc:twoPhase', '/Zc:inline', '/Brepro', '/W4', '/WX',
  '-m64', '-msse3', '-fmsc-version=1934', '-fno-delete-null-pointer-checks', '/clang:-fno-strict-overflow',
  '-fno-ident', '/clang:-fno-math-errno', '/clang:-ffp-contract=off', '-fcomplete-member-pointers',
  '-ftrivial-auto-var-init=pattern', '-Wno-missing-field-initializers',
  '-Wno-unused-parameter', '-Wno-psabi', '-Wno-cast-function-type',
  '-Wno-nonportable-include-path', '-Wno-invalid-offsetof',
  '-Wno-nullability-completeness', '-Wno-trigraphs'
) + $Imsvc + $Defines + $IncludeArguments

$ProductionSources = @(
  'display_capture.cc', 'input_injector.cc', 'ice_candidate_queue.cc', 'json_protocol.cc',
  'local_indicator.cc', 'mf_h264_encoder.cc', 'peer_session.cc', 'quality_ladder.cc',
  'worker_policy.cc', 'virtual_display_controller.cc', 'worker_main.cc'
)
$Tests = [ordered]@{
  display_capture_unittests = @('display_capture.cc', 'display_capture_unittest.cc', 'worker_policy.cc')
  quality_ladder_unittests = @('quality_ladder.cc', 'quality_ladder_unittest.cc')
  input_injector_unittests = @('input_injector.cc', 'input_injector_unittest.cc')
  ice_candidate_queue_unittests = @('ice_candidate_queue.cc', 'ice_candidate_queue_unittest.cc')
  json_protocol_unittests = @('json_protocol.cc', 'json_protocol_unittest.cc')
  worker_policy_unittests = @('worker_policy.cc', 'worker_policy_unittest.cc')
  mf_h264_encoder_unittests = @(
    'mf_h264_encoder.cc', 'mf_h264_encoder_unittest.cc', 'quality_ladder.cc', 'worker_policy.cc'
  )
}
$SystemLibraries = @(
  'd3d11.lib', 'dxgi.lib', 'gdi32.lib', 'mf.lib', 'mfplat.lib', 'mfuuid.lib',
  'ole32.lib', 'oleaut32.lib', 'propsys.lib', 'advapi32.lib', 'shcore.lib',
  'shell32.lib', 'user32.lib', 'swdevice.lib', 'wtsapi32.lib', 'wmcodecdspuuid.lib',
  'comdlg32.lib', 'dbghelp.lib', 'dnsapi.lib', 'msimg32.lib', 'odbc32.lib', 'odbccp32.lib',
  'shlwapi.lib', 'usp10.lib', 'uuid.lib', 'version.lib', 'wininet.lib', 'winmm.lib',
  'winspool.lib', 'ws2_32.lib', 'delayimp.lib', 'kernel32.lib', 'crypt32.lib',
  'iphlpapi.lib', 'secur32.lib', 'dmoguids.lib', 'amstrmid.lib', 'msdmo.lib', 'strmiids.lib'
)
$LinkBase = @(
  '/nologo', '/MACHINE:X64', '/WX', '/INCREMENTAL:NO', '/OPT:REF', '/OPT:ICF',
  '/FIXED:NO', '/NXCOMPAT', '/DYNAMICBASE', '/guard:cf', '/ignore:4199', '/ignore:4221',
  '/DEFAULTLIB:libcpmt.lib',
  "-libpath:$VisualStudioRoot\VC\Tools\MSVC\$Msvc\lib\x64",
  "-libpath:$WindowsSdkLib\ucrt\x64",
  "-libpath:$WindowsSdkLib\um\x64",
  "-libpath:$(Join-Path $SdkRoot 'toolchain\lib')"
) + $SystemLibraries + @((Join-Path $SdkRoot 'toolchain\lib\clang_rt.builtins-x86_64.lib'))

function Compile-Sources([string]$Name, [string[]]$Sources, [string[]]$ExtraDefines = @()) {
  $TargetObjectRoot = Join-Path $ObjectRoot $Name
  New-Item -ItemType Directory -Force -Path $TargetObjectRoot | Out-Null
  $Objects = @()
  foreach ($SourceName in $Sources) {
    $Source = Join-Path $SourceDirectory $SourceName
    $Object = Join-Path $TargetObjectRoot "$([IO.Path]::GetFileNameWithoutExtension($SourceName)).obj"
    $SourceArguments = @($CompileArguments)
    if ($ExtraDefines.Count -ne 0) {
      $SourceArguments += @($ExtraDefines | ForEach-Object { "-D$_" })
    }
    $SourceArguments += @("-fmodule-name=imcodes_$Name", $Source, "/Fo$Object")
    & $Compiler @SourceArguments
    if ($LASTEXITCODE -ne 0) { throw "Native SDK compile failed: $Name/$SourceName" }
    $Objects += $Object
  }
  return $Objects
}

function Link-Executable([string]$Name, [string[]]$Objects, [string[]]$Libraries, [switch]$Windowed) {
  New-Item -ItemType Directory -Force -Path $BinRoot | Out-Null
  $Executable = Join-Path $BinRoot "$Name.exe"
  $ResponsePath = Join-Path $BuildRoot "$Name.rsp"
  $Arguments = @($Objects + $Libraries + $LinkBase)
  $Arguments += if ($Windowed) { '/SUBSYSTEM:WINDOWS,10.0' } else { '/SUBSYSTEM:CONSOLE,10.0' }
  # rtc_executable/rtc_test depend on //build/win:default_exe_manifest. Feed
  # the exact three manifest inputs exported from the pinned checkout to
  # lld-link so the SDK-built binaries retain UAC, common-controls, and
  # supportedOS behavior instead of silently falling back to an external or
  # absent manifest.
  $Arguments += @('/MANIFEST:EMBED', '/MANIFESTUAC:NO')
  $Arguments += @($ExecutableManifests | ForEach-Object { "/MANIFESTINPUT:$_" })
  $ResponseLines = $Arguments | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ }
  }
  [IO.File]::WriteAllLines($ResponsePath, $ResponseLines, (New-Object Text.UTF8Encoding($false)))
  & $Linker "/OUT:$Executable" "@$ResponsePath"
  if ($LASTEXITCODE -ne 0) { throw "Native SDK link failed: $Name" }
  return $Executable
}

try {
  New-Item -ItemType Directory -Force -Path $ObjectRoot, $BinRoot | Out-Null
  $OverlaySource = Join-Path $OverlayRoot 'third_party\imcodes_remote_desktop'
  New-Item -ItemType Directory -Force -Path $OverlaySource | Out-Null
  Get-ChildItem -LiteralPath $SourceDirectory -File -Filter '*.h' |
    Copy-Item -Destination $OverlaySource
  $WorkerObjects = Compile-Sources 'worker' $ProductionSources
  $Worker = Link-Executable 'imcodes-remote-desktop-worker' $WorkerObjects @($ProductionSdk, $LibcxxRuntimeSdk) -Windowed

  if ($RunNativeTests) {
    foreach ($Test in $Tests.GetEnumerator()) {
      $ExtraDefines = if ($Test.Key -eq 'mf_h264_encoder_unittests') {
        @('IMCODES_REMOTE_DESKTOP_ENCODER_BENCHMARKS')
      } else { @() }
      $Objects = Compile-Sources $Test.Key $Test.Value $ExtraDefines
      # The test-support archive intentionally keeps the production dependency
      # archive separate. Link both so every test exercises the exact same
      # fixed libwebrtc surface as the worker instead of relying on nested
      # static-library extraction semantics.
      $Executable = Link-Executable $Test.Key $Objects @(
        $TestSdk,
        $ProductionSdk,
        $LibcxxRuntimeSdk
      )
      Invoke-NativeLogged -Command { & $Executable } `
        -LogRoot $BuildRoot -Name $Test.Key
    }
  }

  New-Item -ItemType Directory -Force -Path $ArtifactRoot | Out-Null
  $Artifact = Join-Path $ArtifactRoot 'imcodes-remote-desktop-worker.exe'
  Copy-Item -LiteralPath $Worker -Destination $Artifact -Force
  if (-not [string]::IsNullOrWhiteSpace($CodeSigningCertificateThumbprint)) {
    & (Join-Path $RepositoryRoot 'scripts\windows-sign-release-artifact.ps1') `
      -Mode Sign -ArtifactPath $Artifact `
      -CodeSigningCertificateThumbprint $CodeSigningCertificateThumbprint `
      -ExpectedSignerSha256 $ExpectedSignerSha256 `
      -TimestampUrl $CodeSigningTimestampUrl
    if ($LASTEXITCODE -ne 0) { throw 'Worker Authenticode signing failed.' }
  }
  $Signature = Get-AuthenticodeSignature -LiteralPath $Artifact
  if ($RequireAuthenticodeSignature -and
      ($Signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
       $null -eq $Signature.SignerCertificate)) {
    throw "Worker Authenticode verification failed: $($Signature.Status)"
  }
  if ($null -eq $Signature.SignerCertificate) { throw 'Worker manifest requires a signer certificate.' }
  $SignerHasher = [Security.Cryptography.SHA256]::Create()
  try {
    $SignerSha256 = [BitConverter]::ToString(
      $SignerHasher.ComputeHash($Signature.SignerCertificate.RawData)
    ).Replace('-', '').ToLowerInvariant()
  } finally { $SignerHasher.Dispose() }

  $ThirdPartyNotices = Join-Path $SdkRoot 'THIRD_PARTY_NOTICES.webrtc.md'
  $VirtualDisplayBuild = Join-Path (Split-Path -Parent $SourceDirectory) 'windows-virtual-display\build-virtual-display.ps1'
  $VirtualDisplayPackage = Join-Path $ArtifactRoot 'virtual-display-package'
  $VirtualDisplayArguments = @{
    ArtifactRoot = $VirtualDisplayPackage
    VisualStudioRoot = $VisualStudioRoot
    DriverKitBin = $DriverKitBin
    ThirdPartyNoticesPath = $ThirdPartyNotices
    CodeSigningCertificateThumbprint = $CodeSigningCertificateThumbprint
  }
  if (-not [string]::IsNullOrWhiteSpace($CodeSigningTimestampUrl)) {
    $VirtualDisplayArguments.CodeSigningTimestampUrl = $CodeSigningTimestampUrl
  }
  if ($RequireAuthenticodeSignature) { $VirtualDisplayArguments.RequireAuthenticodeSignature = $true }
  & $VirtualDisplayBuild @VirtualDisplayArguments
  if ($LASTEXITCODE -ne 0) { throw 'Virtual display package build failed.' }
  $VirtualDisplayArchive = Join-Path $ArtifactRoot 'imcodes-virtual-display.zip'
  Remove-Item -Force $VirtualDisplayArchive -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $VirtualDisplayPackage '*') -DestinationPath $VirtualDisplayArchive -CompressionLevel Optimal
  Remove-Item -Recurse -Force -LiteralPath $VirtualDisplayPackage

  $Manifest = [ordered]@{
    manifestVersion = 2
    workerVersion = $WorkerVersion
    protocolVersion = 2
    ipcVersion = 1
    os = 'win32'
    arch = 'x64'
    fileName = 'imcodes-remote-desktop-worker.exe'
    size = (Get-Item -LiteralPath $Artifact).Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Artifact).Hash.ToLowerInvariant()
    authenticodeSignerSha256 = $SignerSha256
    libwebrtcRevision = $Revision
    virtualDisplay = [ordered]@{
      archiveFileName = 'imcodes-virtual-display.zip'
      packageManifestFileName = 'imcodes-virtual-display.manifest.json'
      size = (Get-Item -LiteralPath $VirtualDisplayArchive).Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $VirtualDisplayArchive).Hash.ToLowerInvariant()
    }
    toolchain = [ordered]@{
      msvc = $Msvc
      windowsSdk = $WindowsSdk
      cmake = 'not-used-sdk'
      ninja = 'not-used-sdk'
      depotTools = $DepotToolsRevision
    }
  }
  [IO.File]::WriteAllText(
    "$Artifact.manifest.json",
    ($Manifest | ConvertTo-Json -Depth 4),
    (New-Object Text.UTF8Encoding($false)))
  Write-Output "worker=$Artifact"
} finally {
  Remove-Item -Recurse -Force -LiteralPath $BuildRoot -ErrorAction SilentlyContinue
}
