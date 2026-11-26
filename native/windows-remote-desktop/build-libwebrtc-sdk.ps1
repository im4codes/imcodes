param(
  [string]$CheckoutRoot = 'E:\imcodes-webrtc',
  [string]$ArtifactRoot = 'E:\imcodes-libwebrtc-sdk',
  [ValidateRange(1, 16)][int]$Jobs = 4,
  [string]$VisualStudioRoot = '',
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
$BuildDirectory = Join-Path $WebRtcRoot 'out\imcodes_remote_desktop_sdk'
$ArtifactRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArtifactRoot)

if ([string]::IsNullOrWhiteSpace($CheckoutRoot) -or
    [System.IO.Path]::GetPathRoot($CheckoutRoot) -eq $CheckoutRoot) {
  throw 'CheckoutRoot must be a dedicated non-root directory.'
}
if ([string]::IsNullOrWhiteSpace($ArtifactRoot) -or
    [System.IO.Path]::GetPathRoot($ArtifactRoot) -eq $ArtifactRoot) {
  throw 'ArtifactRoot must be a dedicated non-root directory.'
}

$env:GIT_CONFIG_COUNT = '4'
$env:GIT_CONFIG_KEY_0 = 'url.https://chromium.googlesource.com/external/github.com/llvm/llvm-project/.insteadOf'
$env:GIT_CONFIG_VALUE_0 = 'https://chromium.googlesource.com/external/github.com/llvm/llvm-project/'
$env:GIT_CONFIG_KEY_1 = 'url.https://github.com/.insteadOf'
$env:GIT_CONFIG_VALUE_1 = 'https://chromium.googlesource.com/external/github.com/'
$env:GIT_CONFIG_KEY_2 = 'safe.directory'
$env:GIT_CONFIG_VALUE_2 = $DepotTools
$env:GIT_CONFIG_KEY_3 = 'safe.directory'
$env:GIT_CONFIG_VALUE_3 = $WebRtcRoot

New-Item -ItemType Directory -Force -Path $CheckoutRoot | Out-Null
if (-not (Test-Path (Join-Path $DepotTools '.git'))) {
  & git clone --filter=blob:none --no-checkout https://chromium.googlesource.com/chromium/tools/depot_tools.git $DepotTools
  if ($LASTEXITCODE -ne 0) { throw 'depot_tools clone failed' }
}
$CurrentDepotToolsRevision = (& git -C $DepotTools rev-parse HEAD 2>$null).Trim()
if ($CurrentDepotToolsRevision -ne $DepotToolsRevision) {
  if ($SkipSync) { throw "SkipSync depot_tools revision mismatch: $CurrentDepotToolsRevision" }
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

$env:PATH = "$DepotTools;$env:PATH"
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:DEPOT_TOOLS_UPDATE = '0'
$env:GYP_MSVS_OVERRIDE_PATH = $VisualStudioRoot
$env:vs2022_install = $VisualStudioRoot
$env:VPYTHON_BYPASS = 'manually managed by the pinned IM.codes SDK build'

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
  foreach ($SourceMapping in @(
      @{ Source = 'sdk.BUILD.gn'; Destination = 'BUILD.gn' },
      @{ Source = 'libwebrtc-sdk.gni'; Destination = 'libwebrtc-sdk.gni' },
      @{ Source = 'sdk_anchor.cc'; Destination = 'sdk_anchor.cc' })) {
    $Source = Get-Item -LiteralPath (Join-Path $SourceDirectory $SourceMapping.Source)
    if ($Source.PSIsContainer -or
        ($Source.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Invalid SDK source: $($SourceMapping.Source)"
    }
    Copy-Item -LiteralPath $Source.FullName `
      -Destination (Join-Path $TargetDirectory $SourceMapping.Destination) -Force
  }

  $GnArgs = @(
    'target_os=\"win\"'
    'target_cpu=\"x64\"'
    'is_debug=false'
    'is_component_build=false'
    'rtc_include_tests=true'
    'rtc_build_examples=false'
    'rtc_enable_protobuf=false'
    'use_rtti=false'
  ) -join ' '
  # Start graph discovery at the dependency-only SDK BUILD.gn. GN's
  # --root-target changes only the initial BUILD file, not the // source root,
  # so all upstream //api/... labels keep their normal meaning. This avoids a
  # transient edit to WebRTC's root BUILD.gn and keeps the SDK targets present
  # after every fresh `gn gen`, including cache restores.
  Invoke-NativeLogged -Command { & gn gen $BuildDirectory "--args=$GnArgs" `
      '--root-target=//third_party/imcodes_remote_desktop' } `
    -LogRoot $CheckoutRoot -Name 'sdk-gn-gen'
  Invoke-NativeLogged -Command { & autoninja -C $BuildDirectory -j $Jobs `
      'third_party/imcodes_remote_desktop:imcodes_libwebrtc_sdk' `
      'third_party/imcodes_remote_desktop:imcodes_libwebrtc_test_sdk' } `
    -LogRoot $CheckoutRoot -Name 'sdk-autoninja'

  Remove-Item -Recurse -Force -LiteralPath $ArtifactRoot -ErrorAction SilentlyContinue
  foreach ($Directory in @(
      $ArtifactRoot,
      (Join-Path $ArtifactRoot 'lib'),
      (Join-Path $ArtifactRoot 'include'),
      (Join-Path $ArtifactRoot 'gen'),
      (Join-Path $ArtifactRoot 'toolchain\bin'),
      (Join-Path $ArtifactRoot 'toolchain\lib'),
      (Join-Path $ArtifactRoot 'toolchain\manifest'))) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  }
  Copy-Item -LiteralPath (Join-Path $BuildDirectory 'obj\third_party\imcodes_remote_desktop\imcodes_libwebrtc_sdk.lib') `
    -Destination (Join-Path $ArtifactRoot 'lib\imcodes_libwebrtc_sdk.lib')
  Copy-Item -LiteralPath (Join-Path $BuildDirectory 'obj\third_party\imcodes_remote_desktop\imcodes_libwebrtc_test_sdk.lib') `
    -Destination (Join-Path $ArtifactRoot 'lib\imcodes_libwebrtc_test_sdk.lib')
  $LibcxxObjects = @(Get-ChildItem -LiteralPath (Join-Path $BuildDirectory 'obj\buildtools\third_party\libc++\libc++') -File -Filter '*.obj' | Sort-Object FullName)
  $AtomicObject = Get-Item -LiteralPath (Join-Path $BuildDirectory 'obj\third_party\compiler-rt\atomic\atomic.obj')
  if ($LibcxxObjects.Count -lt 40 -or $AtomicObject.PSIsContainer) {
    throw 'Pinned libc++ runtime object set is incomplete.'
  }
  $MsvcVersion = (Get-Content -Raw -LiteralPath (Join-Path $VisualStudioRoot 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt')).Trim()
  $MsvcLib = Join-Path $VisualStudioRoot "VC\Tools\MSVC\$MsvcVersion\bin\Hostx64\x64\lib.exe"
  $LibcxxArchive = Join-Path $ArtifactRoot 'lib\imcodes_libcxx_runtime_sdk.lib'
  & $MsvcLib /nologo "/OUT:$LibcxxArchive" @($LibcxxObjects.FullName) $AtomicObject.FullName
  if ($LASTEXITCODE -ne 0) { throw 'Pinned libc++ runtime archive creation failed.' }

  $HeaderExtensions = @('.h', '.hpp', '.inc')
  $HeaderRoots = @(
    'api', 'buildtools\third_party\libc++', 'common_audio', 'common_video',
    'logging', 'media', 'modules', 'net', 'p2p', 'pc', 'rtc_base', 'system_wrappers', 'test',
    'testing\gmock', 'testing\gtest',
    'third_party\abseil-cpp', 'third_party\boringssl', 'third_party\jsoncpp',
    'third_party\googletest',
    'third_party\libc++\src\include', 'third_party\libyuv\include',
    'third_party\perfetto\include'
  )
  foreach ($HeaderRoot in $HeaderRoots) {
    $AbsoluteHeaderRoot = Join-Path $WebRtcRoot $HeaderRoot
    if (-not (Test-Path -LiteralPath $AbsoluteHeaderRoot -PathType Container)) {
      throw "Pinned SDK header root is missing: $HeaderRoot"
    }
    $IncludeExtensionlessHeaders = $HeaderRoot -like '*libc++*'
    foreach ($Header in Get-ChildItem -LiteralPath $AbsoluteHeaderRoot -Recurse -File | Where-Object {
        $HeaderExtensions -contains $_.Extension.ToLowerInvariant() -or
        ($IncludeExtensionlessHeaders -and [string]::IsNullOrEmpty($_.Extension))
      }) {
      $Relative = $Header.FullName.Substring($WebRtcRoot.Length).TrimStart('\')
      $Destination = Join-Path (Join-Path $ArtifactRoot 'include') $Relative
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
      Copy-Item -LiteralPath $Header.FullName -Destination $Destination
    }
  }
  foreach ($GeneratedHeader in Get-ChildItem -LiteralPath (Join-Path $BuildDirectory 'gen') -Recurse -File | Where-Object {
      $HeaderExtensions -contains $_.Extension.ToLowerInvariant()
    }) {
    $Relative = $GeneratedHeader.FullName.Substring((Join-Path $BuildDirectory 'gen').Length).TrimStart('\')
    $Destination = Join-Path (Join-Path $ArtifactRoot 'gen') $Relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $GeneratedHeader.FullName -Destination $Destination
  }

  foreach ($RequiredHeader in @(
      'buildtools\third_party\libc++\__config_site',
      'third_party\libc++\src\include\__config')) {
    $ExportedHeader = Join-Path (Join-Path $ArtifactRoot 'include') $RequiredHeader
    if (-not (Test-Path -LiteralPath $ExportedHeader -PathType Leaf)) {
      throw "Required extensionless SDK header was not exported: $RequiredHeader"
    }
  }

  foreach ($Tool in @('clang-cl.exe', 'lld-link.exe', 'llvm-ml.exe')) {
    Copy-Item -LiteralPath (Join-Path $WebRtcRoot "third_party\llvm-build\Release+Asserts\bin\$Tool") `
      -Destination (Join-Path $ArtifactRoot "toolchain\bin\$Tool")
  }
  foreach ($Manifest in @('as_invoker.manifest', 'common_controls.manifest', 'compatibility.manifest')) {
    $ManifestSource = Get-Item -LiteralPath (Join-Path $WebRtcRoot "build\win\$Manifest")
    if ($ManifestSource.PSIsContainer -or
        ($ManifestSource.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Pinned Windows executable manifest is not a regular file: $Manifest"
    }
    Copy-Item -LiteralPath $ManifestSource.FullName `
      -Destination (Join-Path $ArtifactRoot "toolchain\manifest\$Manifest")
  }
  $ClangResourceInclude = Join-Path $WebRtcRoot 'third_party\llvm-build\Release+Asserts\lib\clang\23\include'
  foreach ($ResourceHeader in Get-ChildItem -LiteralPath $ClangResourceInclude -Recurse -File) {
    if ($ResourceHeader.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "Clang resource header is a reparse point: $($ResourceHeader.FullName)"
    }
    $Relative = $ResourceHeader.FullName.Substring($ClangResourceInclude.Length).TrimStart('\')
    $Destination = Join-Path $ArtifactRoot "toolchain\lib\clang\23\include\$Relative"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $ResourceHeader.FullName -Destination $Destination
  }
  Copy-Item -LiteralPath (Join-Path $WebRtcRoot 'third_party\llvm-build\Release+Asserts\lib\clang\23\lib\windows\clang_rt.builtins-x86_64.lib') `
    -Destination (Join-Path $ArtifactRoot 'toolchain\lib\clang_rt.builtins-x86_64.lib')
  foreach ($RequiredResourceHeader in @('stddef.h', '__stddef_max_align_t.h')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ArtifactRoot "toolchain\lib\clang\23\include\$RequiredResourceHeader") -PathType Leaf)) {
      throw "Required Clang resource header was not exported: $RequiredResourceHeader"
    }
  }

  $LicenseGenerator = Join-Path $SourceDirectory 'generate-libwebrtc-sdk-notices.py'
  & vpython3 $LicenseGenerator `
    '--webrtc-root' $WebRtcRoot `
    '--build-directory' $BuildDirectory `
    '--target' '//third_party/imcodes_remote_desktop:imcodes_libwebrtc_sdk' `
    '--target' '//third_party/imcodes_remote_desktop:imcodes_libwebrtc_test_sdk' `
    '--output-directory' $ArtifactRoot
  if ($LASTEXITCODE -ne 0) { throw 'Pinned libwebrtc SDK license generation failed.' }
  if (-not (Test-Path -LiteralPath (Join-Path $ArtifactRoot 'LICENSE.md') -PathType Leaf)) {
    throw 'Pinned libwebrtc SDK license generator produced no output.'
  }
  Move-Item -LiteralPath (Join-Path $ArtifactRoot 'LICENSE.md') `
    -Destination (Join-Path $ArtifactRoot 'THIRD_PARTY_NOTICES.webrtc.md') -Force

  $WindowsSdkDirectory = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Lib' -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  if (-not $WindowsSdkDirectory) { throw 'Versioned Windows SDK library directory was not found.' }
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $Metadata = [ordered]@{
    manifestVersion = 1
    os = 'win32'
    arch = 'x64'
    libwebrtcRevision = $Revision
    depotToolsRevision = $DepotToolsRevision
    buildArgs = $GnArgs
    toolchain = [ordered]@{
      msvc = $MsvcVersion
      windowsSdk = $WindowsSdkDirectory.Name
      clang = 'llvmorg-23-init-19482-g53d18800-1'
    }
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $ArtifactRoot 'sdk-build.json'),
    ($Metadata | ConvertTo-Json -Depth 4),
    $Utf8NoBom)
  Write-Output "sdk=$ArtifactRoot"
} finally { Pop-Location }
