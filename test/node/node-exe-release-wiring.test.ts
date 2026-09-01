import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('controlled-node executable release wiring', () => {
  it('packs the versioned, already-tested npm release before publishing without duplicate lifecycle tests', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const setVersion = workflow.indexOf('npm version ${{ needs.docker.outputs.npm_version }} --no-git-tag-version');
    const build = workflow.indexOf('- run: npm run build', setVersion);
    const pack = workflow.indexOf('npm pack --pack-destination "$RUNNER_TEMP"');
    const publish = workflow.indexOf('npm publish "$PACKAGE_TARBALL" "${PUBLISH_ARGS[@]}" --provenance --ignore-scripts');
    expect([setVersion, build, pack, publish].every((position) => position >= 0)).toBe(true);
    expect(setVersion).toBeLessThan(build);
    expect(build).toBeLessThan(pack);
    expect(pack).toBeLessThan(publish);
  });

  it('gates the production image on all three native artifacts including macOS Universal 2', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('controlled-node-executables:');
    expect(workflow).toContain('controlled-node-${{ matrix.key }}');
    expect(workflow).toContain('pattern: controlled-node-*');
    expect(workflow).toContain('node scripts/node-exe-artifacts.mjs verify-set server/controlled-node-artifacts');
    expect(workflow).toContain('imcodes-node-linux imcodes-node-macos imcodes-node.exe');
    expect(workflow).toContain('dist-node-exe/${{ matrix.artifact }}.manifest.json');
    expect(workflow).toContain('dist-node-exe/computer-use-helper/**');
    expect(workflow).toContain('IMCODES_WINDOWS_SIGNING_PFX_BASE64');
    expect(workflow).toContain('dist-node-exe/remote-desktop-worker/**');
    expect(workflow).toContain('remote-desktop-worker-artifacts.mjs verify');
    expect(workflow).toContain('npx tsx scripts/qualify-windows-self-upgrade.ts');
    expect(workflow).toContain('runner: windows-2022');
    expect(workflow).toContain('node scripts/resolve-libwebrtc-sdk-release.mjs');
    expect(workflow).toContain('resolve-libwebrtc-sdk-release.mjs --wait-seconds 15000');
    expect(workflow).toContain('steps.libwebrtc_sdk_cache.outputs.cache-hit');
    expect(workflow).toContain('steps.libwebrtc_sdk.outputs.sha256');
    expect(workflow).toContain('Verify cached fixed libwebrtc foundation SDK');
    expect(workflow).toContain('gh release download');
    expect(workflow).toContain('node scripts/install-libwebrtc-sdk.mjs');
    expect(workflow).toContain('build-worker-from-sdk.ps1');
    expect(workflow).toContain('RunNativeTests = $true');
    expect(workflow).not.toContain('imcodes-webrtc-checkout-windows-x64-');
    expect(workflow).not.toContain('imcodes-webrtc-build-${{ steps.windows_native_cache.outputs.identity }}');
    const workerBuild = readFileSync('native/windows-remote-desktop/build-worker.ps1', 'utf8');
    const displayBuild = readFileSync('native/windows-virtual-display/build-virtual-display.ps1', 'utf8');
    const driverKitResolver = readFileSync('scripts/resolve-windows-driver-kit.ps1', 'utf8');
    const cacheIdentityResolver = readFileSync('scripts/resolve-windows-native-cache-identity.ps1', 'utf8');
    expect(workerBuild).toContain('tools_webrtc\\libs\\generate_licenses.py');
    expect(workerBuild).toContain('THIRD_PARTY_NOTICES.webrtc.md');
    expect(workerBuild).toContain('Remove-Item -Force -LiteralPath $ThirdPartyNotices');
    expect(workerBuild).toContain("Join-Path $DepotTools 'bootstrap\\win_tools.bat'");
    expect(workerBuild).toContain("Join-Path $DepotTools 'git.bat'");
    expect(workerBuild).toContain('Start-Process -FilePath $env:ComSpec');
    expect(workerBuild).toContain('-RedirectStandardError $BootstrapStderr');
    expect(workerBuild).toContain('$PostBootstrapDepotToolsRevision -ne $DepotToolsRevision');
    expect(workerBuild).toContain('$BootstrapExitCode -ne 0');
    expect(workerBuild).toContain("$env:GIT_CONFIG_COUNT = '4'");
    expect(workerBuild).toContain("url.https://chromium.googlesource.com/external/github.com/llvm/llvm-project/.insteadOf");
    expect(workerBuild).toContain("$env:GIT_CONFIG_VALUE_0 = 'https://chromium.googlesource.com/external/github.com/llvm/llvm-project/'");
    expect(workerBuild).toContain("$env:GIT_CONFIG_KEY_1 = 'url.https://github.com/.insteadOf'");
    expect(workerBuild.indexOf('& $WinToolsBootstrap.FullName'))
      .toBeLessThan(workerBuild.indexOf('$env:DEPOT_TOOLS_UPDATE'));
    expect(workerBuild).toContain("Where-Object { $_.Name -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' }");
    expect(workerBuild.indexOf("scripts\\resolve-windows-driver-kit.ps1"))
      .toBeLessThan(workerBuild.indexOf('gclient sync'));
    expect(workerBuild).toContain('DriverKitBin = $WindowsDriverKitBin');
    expect(workerBuild).toContain("Join-Path $CheckoutRoot 'imcodes_remote_desktop.restored-build-cache'");
    expect(workerBuild.indexOf('Move-Item -LiteralPath $BuildDirectory -Destination $RestoredBuildCache'))
      .toBeLessThan(workerBuild.indexOf('git clone --filter=blob:none --no-checkout https://webrtc.googlesource.com/src.git'));
    expect(workerBuild.indexOf('Move-Item -LiteralPath $RestoredBuildCache -Destination $BuildDirectory'))
      .toBeGreaterThan(workerBuild.indexOf('gclient sync -D'));
    expect(workerBuild).toContain('[System.IO.File]::SetLastWriteTimeUtc($_.FullName, $RestoredAt)');
    expect(workerBuild).toContain('if ($_.Exception.InnerException -isnot [System.IO.FileNotFoundException]) { throw }');
    expect(workerBuild).toContain(
      '$ArtifactRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArtifactRoot)',
    );
    expect(workerBuild.indexOf('GetUnresolvedProviderPathFromPSPath($ArtifactRoot)'))
      .toBeLessThan(workerBuild.indexOf('Push-Location $WebRtcRoot'));
    expect(displayBuild).toContain("scripts\\resolve-windows-driver-kit.ps1");
    expect(driverKitResolver).toContain("Join-Path $_.FullName 'x86\\inf2cat.exe'");
    expect(driverKitResolver).toContain("Join-Path $_.FullName 'x64\\signtool.exe'");
    expect(cacheIdentityResolver).toContain('$env:ImageVersion');
    expect(cacheIdentityResolver).toContain('resolve-windows-driver-kit.ps1');
    expect(displayBuild).toContain("'THIRD_PARTY_NOTICES.webrtc.md'");
    const signDll = displayBuild.indexOf('$Arguments += $DllPath');
    const buildCatalog = displayBuild.indexOf('& $Inf2Cat');
    const signCatalog = displayBuild.indexOf('$Arguments += $Catalog');
    expect(signDll).toBeGreaterThan(-1);
    expect(signDll).toBeLessThan(buildCatalog);
    expect(buildCatalog).toBeLessThan(signCatalog);
    expect(displayBuild).toContain('& $SignTool verify /pa /c $Catalog');
    expect(workflow).toContain("IMCODES_REQUIRE_COMPUTER_USE_HELPER: '1'");
    expect(workflow).toContain('IMCODES_BUILD_VERSION: ${{ needs.release_version.outputs.app_version }}');
    expect(workflow).toContain('APP_VERSION=${{ needs.release_version.outputs.app_version }}');
    expect(workflow).toContain('runner: macos-15');
    const standaloneWorkflow = readFileSync('.github/workflows/build-node-exe.yml', 'utf8');
    expect(standaloneWorkflow).toContain('- os: windows-2022');
    expect(standaloneWorkflow).toContain('node scripts/resolve-libwebrtc-sdk-release.mjs');
    expect(standaloneWorkflow).toContain('resolve-libwebrtc-sdk-release.mjs --wait-seconds 15000');
    expect(standaloneWorkflow).toContain('steps.libwebrtc_sdk_cache.outputs.cache-hit');
    expect(standaloneWorkflow).toContain('Verify cached fixed libwebrtc foundation SDK');
    expect(standaloneWorkflow).toContain('gh release download');
    expect(standaloneWorkflow).toContain('node scripts/install-libwebrtc-sdk.mjs');
    expect(standaloneWorkflow).toContain('build-worker-from-sdk.ps1');
    expect(standaloneWorkflow).not.toContain('imcodes-webrtc-checkout-windows-x64-');
    const sdkConsumer = readFileSync('native/windows-remote-desktop/build-worker-from-sdk.ps1', 'utf8');
    expect(sdkConsumer).toContain("'-fmsc-version=1934'");
    expect(sdkConsumer).toContain('if ($ExtraDefines.Count -ne 0)');
    expect(sdkConsumer).toContain('& $Compiler @SourceArguments');
    expect(sdkConsumer).toContain("Invoke-NativeLogged -Command { & $Executable }");
    expect(sdkConsumer).toContain("'third_party\\googletest\\src\\googletest\\include'");
    expect(sdkConsumer).toContain('$TestSdk,');
    expect(sdkConsumer).toContain('$ProductionSdk,');
    expect(sdkConsumer).toContain("'toolchain\\manifest\\as_invoker.manifest'");
    expect(sdkConsumer).toContain("'toolchain\\manifest\\common_controls.manifest'");
    expect(sdkConsumer).toContain("'toolchain\\manifest\\compatibility.manifest'");
    expect(sdkConsumer).toContain("'/MANIFEST:EMBED'");
    expect(sdkConsumer).toContain("'/MANIFESTUAC:NO'");
    expect(sdkConsumer).toContain('"/MANIFESTINPUT:$_"');
    expect(sdkConsumer).toContain("'display_preferences.cc'");
    expect(workerBuild).toContain("'display_preferences.cc', 'display_preferences.h'");
    const displayPreferences = readFileSync(
      'native/windows-remote-desktop/display_preferences.cc',
      'utf8',
    );
    const peerSession = readFileSync('native/windows-remote-desktop/peer_session.cc', 'utf8');
    const windowsPlatformAdapters = readFileSync(
      'native/windows-remote-desktop/windows_platform_adapters.cc',
      'utf8',
    );
    const virtualDisplayController = readFileSync(
      'native/windows-remote-desktop/virtual_display_controller.cc',
      'utf8',
    );
    expect(displayPreferences).toContain('schema != kPreferenceSchema');
    expect(displayPreferences).toContain('IsAllowedRemoteDisplayMode');
    expect(displayPreferences).toContain('IsAllowedRemoteDisplayScale');
    expect(windowsPlatformAdapters).toContain('CDS_UPDATEREGISTRY');
    expect(windowsPlatformAdapters).toContain('SaveVirtualDisplayPreferences');
    const setDisplayMode = peerSession.slice(
      peerSession.indexOf('bool PeerSession::SetDisplayMode('),
      peerSession.indexOf('bool PeerSession::SetDisplayScale('),
    );
    expect(setDisplayMode).not.toContain('SetDisplayDpiScale(');
    expect(setDisplayMode).toContain('display_adapter_->SetMode(');
    expect(virtualDisplayController).toContain('LoadVirtualDisplayPreferences');
    expect(sdkConsumer.indexOf('$TestSdk,'))
      .toBeLessThan(sdkConsumer.lastIndexOf('$ProductionSdk,'));

    const sdkWorkflow = readFileSync('.github/workflows/build-libwebrtc-sdk.yml', 'utf8');
    expect(sdkWorkflow).toContain('workflow_dispatch:');
    expect(sdkWorkflow).toContain('shared/remote-desktop-native-pins.json');
    expect(sdkWorkflow).toContain('native/windows-remote-desktop/sdk.BUILD.gn');
    expect(sdkWorkflow).toContain('native/windows-remote-desktop/libwebrtc-sdk.gni');
    expect(sdkWorkflow).not.toContain('- native/windows-remote-desktop/BUILD.gn');
    expect(sdkWorkflow).toContain('native/windows-remote-desktop/generate-libwebrtc-sdk-notices.py');
    expect(sdkWorkflow).not.toContain('native/windows-remote-desktop/**');
    expect(sdkWorkflow).toContain('scripts/libwebrtc-sdk-artifacts.mjs');
    expect(sdkWorkflow).toContain('${{ github.sha }}');
    expect(sdkWorkflow).not.toContain('inputs.source_commit');
    expect(sdkWorkflow).toContain('group: build-libwebrtc-sdk-windows-x64');
    expect(sdkWorkflow).toContain('Restore pinned depot_tools and CIPD bootstrap');
    expect(sdkWorkflow).toContain('Restore exported libwebrtc foundation SDK');
    expect(sdkWorkflow).toContain("steps.sdk_foundation_cache.outputs.cache-hit != 'true'");
    expect(sdkWorkflow).toContain("steps.sdk_foundation_cache.outputs.cache-hit == 'true'");
    expect(sdkWorkflow).toContain('native\\windows-remote-desktop\\build-libwebrtc-sdk.ps1');
    const sdkProducer = readFileSync('native/windows-remote-desktop/build-libwebrtc-sdk.ps1', 'utf8');
    const sdkNoticeGenerator = readFileSync(
      'native/windows-remote-desktop/generate-libwebrtc-sdk-notices.py',
      'utf8',
    );
    expect(sdkProducer).toContain("Join-Path $SourceDirectory 'generate-libwebrtc-sdk-notices.py'");
    expect(sdkProducer).toContain("@{ Source = 'sdk.BUILD.gn'; Destination = 'BUILD.gn' }");
    expect(sdkProducer).toContain("@{ Source = 'libwebrtc-sdk.gni'; Destination = 'libwebrtc-sdk.gni' }");
    expect(sdkProducer).toContain("'--root-target=//third_party/imcodes_remote_desktop'");
    expect(sdkProducer).not.toContain('$RootBuildText.Replace');
    expect(sdkProducer).toContain("Sort-Object FullName");
    expect(sdkProducer).toContain("initialize-hermetic-windows-git.ps1') -WorkspaceRoot $CheckoutRoot");
    const hermeticGit = readFileSync(
      'native/windows-remote-desktop/initialize-hermetic-windows-git.ps1',
      'utf8',
    );
    expect(hermeticGit).toContain('$env:GIT_CONFIG_GLOBAL = $GlobalConfig.FullName');
    expect(hermeticGit).toContain('$GlobalConfig.Length -ne 0');
    const nativeLogged = readFileSync(
      'native/windows-remote-desktop/invoke-native-logged.ps1',
      'utf8',
    );
    expect(nativeLogged).toContain('$NativeExitCode -ne 0');
    expect(nativeLogged).toContain("$ErrorActionPreference = 'Continue'");
    expect(sdkProducer).toContain("-Name 'sdk-autoninja'");
    const sdkGni = readFileSync('native/windows-remote-desktop/libwebrtc-sdk.gni', 'utf8');
    const sdkBuild = readFileSync('native/windows-remote-desktop/sdk.BUILD.gn', 'utf8');
    expect(sdkGni).not.toContain('rtc_static_library(');
    expect(sdkBuild).toContain('import("//webrtc.gni")');
    expect(sdkBuild).toContain('rtc_static_library("imcodes_libwebrtc_sdk")');
    expect(sdkProducer).toContain("$HeaderRoot -like '*libc++*'");
    expect(sdkProducer).toContain("'logging', 'media', 'modules'");
    expect(sdkProducer).toContain("'testing\\gmock', 'testing\\gtest'");
    expect(sdkProducer).toContain("'third_party\\googletest'");
    expect(sdkProducer).toContain("'third_party\\libc++\\src\\include\\__config'");
    expect(sdkProducer).toContain("[string]::IsNullOrEmpty($_.Extension)");
    expect(sdkProducer).toContain("'third_party\\llvm-build\\Release+Asserts\\lib\\clang\\23\\include'");
    expect(sdkProducer).toContain("'__stddef_max_align_t.h'");
    expect(sdkProducer).toContain('imcodes_libcxx_runtime_sdk.lib');
    expect(sdkNoticeGenerator).toContain('SDK_TARGETS');
    expect(sdkNoticeGenerator).toContain('imcodes_libwebrtc_test_sdk');
    expect(sdkNoticeGenerator).toContain('REQUIRED_REDISTRIBUTED_LIBRARIES');
    expect(sdkNoticeGenerator).toContain('Redistributed SDK license file is missing');
    expect(sdkNoticeGenerator).toContain('llvm-toolchain');
    expect(sdkNoticeGenerator).toContain('googletest');
    expect(sdkNoticeGenerator).not.toContain('"--format=json"');
    expect(nativeLogged).toContain('$global:LASTEXITCODE = $null');
    expect(hermeticGit).toContain("$env:GIT_CONFIG_NOSYSTEM = '1'");
    expect(hermeticGit).toContain("[version]'2.32.0'");
    expect(sdkWorkflow).not.toContain('IMCODES_WINDOWS_SIGNING_PFX_BASE64');
    expect(sdkWorkflow).toContain('node scripts/publish-libwebrtc-sdk.mjs');
    expect(sdkWorkflow).toContain('node scripts/promote-libwebrtc-sdk.mjs');
    expect(sdkWorkflow).toContain('node scripts/libwebrtc-sdk-artifacts.mjs verify-lock');
    expect(sdkWorkflow).toContain('name: libwebrtc-sdk-candidate-${{ steps.sdk.outputs.release_tag }}');
    expect(sdkWorkflow).toContain('sdk-release/imcodes-libwebrtc-sdk-windows-x64.zip');
    expect(sdkWorkflow).toContain('contents: write');
    expect(sdkWorkflow).not.toContain('build-worker.ps1');
    const sdkArchiveScript = readFileSync('scripts/windows-libwebrtc-sdk-archive.ps1', 'utf8');
    const sdkInstallScript = readFileSync('scripts/install-libwebrtc-sdk.mjs', 'utf8');
    const sdkPublishScript = readFileSync('scripts/publish-libwebrtc-sdk.mjs', 'utf8');
    expect(sdkArchiveScript).toContain("[ValidateSet('Compress', 'Expand')]");
    expect(sdkArchiveScript).toContain("'imcodes-libwebrtc-sdk.manifest.json'");
    expect(sdkArchiveScript).toContain('[IO.Compression.ZipArchiveMode]::Create');
    expect(sdkArchiveScript).toContain(
      'Sort-Object { $_.FullName.Substring($Source.FullName.Length).ToLowerInvariant() }',
    );
    expect(sdkArchiveScript).toContain(
      'New-Object DateTimeOffset(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)',
    );
    expect(sdkArchiveScript).toContain('[IO.FileShare]::Read');
    expect(sdkArchiveScript).toContain('imcodes-libwebrtc-sdk-$MutexDigest.lock');
    expect(sdkArchiveScript).toContain('[IO.FileShare]::None');
    expect(sdkArchiveScript).toContain('catch [IO.IOException]');
    expect(sdkArchiveScript).toContain('$ArchiveLock.Dispose()');
    expect(sdkArchiveScript).toContain('Expand-Archive -LiteralPath $Archive.FullName');
    expect(sdkArchiveScript).toContain('[IO.Compression.ZipFile]::OpenRead($Archive.FullName)');
    expect(sdkArchiveScript).toContain("$_.FullName.Replace('\\', '/')");
    expect(sdkArchiveScript).toContain('$DuplicateArchiveNames.Count -ne 0');
    expect(sdkArchiveScript).toContain('$ReservedWindowsNames');
    expect(sdkArchiveScript).toContain("'lib/imcodes_libwebrtc_sdk.lib'");
    expect(sdkArchiveScript).toContain("'lib/imcodes_libcxx_runtime_sdk.lib'");
    expect(sdkArchiveScript).toContain('$ExpandedSize -gt 4GB');
    expect(sdkInstallScript).toContain("'-Mode', 'Expand'");
    expect(sdkPublishScript).toContain("'-Mode', 'Compress'");
    expect(sdkPublishScript).toContain('process.exitCode = 0');
    expect(sdkInstallScript).not.toContain("'-Command'");
    expect(sdkPublishScript).not.toContain("'-Command'");
  });

  it('exposes the embedded runtime version without bootstrapping or installing', () => {
    const entry = readFileSync('src/node/index.ts', 'utf8');
    expect(entry).toContain("process.argv[2] === '--version'");
    expect(entry).toContain('process.stdout.write(`${DAEMON_VERSION}\\n`)');
  });

  it('keeps first-run installation output user-facing on every platform', () => {
    const entry = readFileSync('src/node/index.ts', 'utf8');
    const installUi = readFileSync('src/node/install-report.ts', 'utf8');
    const buildScript = readFileSync('scripts/build-node-exe.mjs', 'utf8');

    expect(installUi).toContain("'IM.codes 安装中，请稍候...'");
    expect(entry).toContain('isInstallerLaunch(');
    // Neither terminal outcome may be silent.
    expect(entry).toContain('formatInstallSuccess(');
    expect(entry).toContain('formatInstallFailure(');
    expect(buildScript).toContain("'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1')");
    expect(buildScript).toContain("'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('1')");
    expect(buildScript).not.toContain("execArgv: ['--no-warnings']");
  });

  it('raises the UAC level after postject and strictly before signing', () => {
    const buildScript = readFileSync('scripts/build-node-exe.mjs', 'utf8');
    const manifestAt = buildScript.indexOf("runWindowsReleaseSigning('Manifest'");
    const signAt = buildScript.indexOf("runWindowsReleaseSigning('Sign', outPath");
    const injectAt = buildScript.indexOf('await inject(officialNode.nodeBin, outPath)');
    expect(manifestAt).toBeGreaterThan(-1);
    expect(signAt).toBeGreaterThan(-1);
    expect(injectAt).toBeGreaterThan(-1);
    // mt.exe rewrites the resource section and drops the Authenticode
    // certificate table while doing so (measured: 81,471,184 -> 81,463,296
    // bytes, exactly the 7,888-byte table, Valid -> NotSigned). Raising the
    // manifest after signing would therefore ship an unsigned release without
    // failing the build, which is why this ordering is asserted rather than
    // merely commented.
    expect(injectAt).toBeLessThan(manifestAt);
    expect(manifestAt).toBeLessThan(signAt);
  });

  it('accepts the Manifest mode and defaults it to requireAdministrator', () => {
    const signScript = readFileSync('scripts/windows-sign-release-artifact.ps1', 'utf8');
    expect(signScript).toContain("[ValidateSet('Remove', 'Sign', 'Verify', 'Manifest')]");
    expect(signScript).toContain("[string]$RequestedExecutionLevel = 'requireAdministrator'");
    // Signing credentials gate 'Sign' only, so unsigned developer builds still
    // get the same elevation behaviour as CI.
    const build = readFileSync('scripts/build-node-exe.mjs', 'utf8');
    expect(build).toContain("runWindowsReleaseSigning('Manifest', outPath)");
    // Both SDK tools must resolve through one shared discovery path.
    expect(signScript).toContain('function Resolve-WindowsSdkTool');
    expect(signScript).toContain("Resolve-WindowsSdkTool -ToolName 'mt.exe'");
    expect(signScript).toContain("Resolve-WindowsSdkTool -ToolName 'signtool.exe'");
    // The written level is read back out of the artifact, not trusted from the
    // tool's exit code.
    expect(signScript).toContain('Reading back the updated PE application manifest failed.');
  });

  it('copies the artifacts into the image and configures the serving directory', () => {
    const dockerfile = readFileSync('server/Dockerfile', 'utf8');

    expect(dockerfile).toContain('COPY server/controlled-node-artifacts/ ./controlled-node-executables/');
    expect(dockerfile).toContain('COPY scripts/node-exe-artifacts.mjs ./scripts/node-exe-artifacts.mjs');
    expect(dockerfile).toContain('COPY scripts/remote-desktop-worker-artifacts.mjs ./scripts/remote-desktop-worker-artifacts.mjs');

    // DERIVED, not hand-listed. The previous version asserted a fixed set of COPY
    // lines, so when remote-desktop-worker-artifacts.mjs gained an import of
    // shared/remote-desktop-macos-identity.json nothing noticed, and the runtime
    // image failed at startup with ERR_MODULE_NOT_FOUND. Every relative import of
    // a script we copy must itself be copied.
    const copiedScripts = [...dockerfile.matchAll(/^COPY (scripts\/[\w.-]+\.mjs) /gmu)].map((m) => m[1]);
    expect(copiedScripts.length).toBeGreaterThan(0);
    for (const script of copiedScripts) {
      const body = readFileSync(script, 'utf8');
      const relativeImports = [...body.matchAll(/from '(\.\.?\/[^']+)'/gu)].map((m) => m[1]);
      for (const spec of relativeImports) {
        const resolved = spec.replace(/^\.\.\//u, '').replace(/^\.\//u, '');
        expect(dockerfile, `${script} imports ${spec}; the runtime stage must COPY ${resolved}`)
          .toContain(`COPY ${resolved} ./${resolved}`);
      }
    }
    expect(dockerfile).toContain('COPY shared/remote-desktop-native-pins.json ./shared/remote-desktop-native-pins.json');
    expect(dockerfile).toContain('ENV IMCODES_NODE_EXE_DIR=/app/controlled-node-executables');
  });

  it('publishes immutable image metadata bound to the full build commit', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('id: build_push');
    expect(workflow).toContain('COMMIT_SHA: ${{ github.sha }}');
    expect(workflow).toContain('IMAGE_REPOSITORY: ${{ env.IMAGE }}');
    expect(workflow).toContain('IMAGE_DIGEST: ${{ steps.build_push.outputs.digest }}');
    expect(workflow).toContain('name: release-metadata');
    expect(workflow).toContain('path: release-metadata/release.env');
  });

  it('anchors Node bytes to official checksums and uses the pinned postject package', () => {
    const buildScript = readFileSync('scripts/build-node-exe.mjs', 'utf8');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies?: Record<string, string> };

    expect(buildScript).toContain("const OFFICIAL_NODE_DIST = 'https://nodejs.org/dist'");
    expect(buildScript).toContain('verifyOfficialNodeArtifact');
    expect(buildScript).toContain('await downloadFile(`${OFFICIAL_NODE_DIST}/${NODE_VERSION}/SHASUMS256.txt`');
    expect(buildScript).not.toContain("sh('curl'");
    expect(buildScript).toContain("process.env.IMCODES_BUILD_VERSION?.trim() || packageVersion");
    expect(buildScript).toContain("'process.env.IMCODES_BUILD_VERSION': JSON.stringify(buildVersion)");
    expect(buildScript).not.toContain("'process.env.IMCODES_BUILD_VERSION': JSON.stringify(packageVersion)");
    expect(buildScript).not.toContain("sh('npx', ['-y', 'postject'");
    expect(buildScript).toContain("postjectApi.inject(destination, 'NODE_SEA_BLOB'");
    expect(buildScript).toContain('if (isWin) {');
    expect(buildScript).toContain('sh(process.execPath, [postjectBin, ...args]);');
    expect(packageJson.devDependencies?.postject).toBe('1.0.0-alpha.6');
    expect(buildScript).toContain("await Promise.all(['arm64', 'x64'].map");
    expect(buildScript).toContain("sh('lipo', ['-create'");
    expect(buildScript).toContain("const artifactArch = platform === 'darwin' ? 'universal' : arch");
  });

  it('strips the upstream signature before SEA injection and signs all final Windows executables before manifest hashing', () => {
    const buildScript = readFileSync('scripts/build-node-exe.mjs', 'utf8');
    const signingScript = readFileSync('scripts/windows-sign-release-artifact.ps1', 'utf8');

    expect(buildScript).toContain('function runWindowsReleaseSigning(');
    expect(buildScript).toContain('IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT');
    expect(buildScript).toContain('windows-sign-release-artifact.ps1');
    expect(buildScript.indexOf("runWindowsReleaseSigning('Remove', destination);"))
      .toBeLessThan(buildScript.indexOf("postjectApi.inject(destination, 'NODE_SEA_BLOB'"));
    expect(buildScript).toContain("join(buildDir, 'computer-use-helper', 'win32-x64', 'open-computer-use.exe')");
    expect(buildScript.indexOf("runWindowsReleaseSigning('Sign', outPath, windowsReleaseSignerSha256);"))
      .toBeLessThan(buildScript.indexOf('const manifest = await createNodeExeManifest({'));
    expect(signingScript).toContain("'sign', '/s', 'My', '/sha1', $CodeSigningCertificateThumbprint");
    expect(signingScript).toContain('& $SignTool remove /s $ResolvedArtifact');
    expect(signingScript).toContain("'/tr', $TimestampUrl, '/td', 'sha256'");
    expect(signingScript).toContain('Get-AuthenticodeSignature -LiteralPath $ResolvedArtifact');
    expect(signingScript).toContain("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'");
    expect(signingScript).toContain('Import-Module -Name $SecurityModulePath -ErrorAction Stop');
    expect(signingScript).toContain('$Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid');
    expect(signingScript).toContain('$ActualSignerSha256 -cne $ExpectedSignerSha256.ToLowerInvariant()');
    expect(signingScript).toContain('& $SignTool verify /pa /all $ResolvedArtifact');

    for (const workflowPath of ['.github/workflows/build-node-exe.yml', '.github/workflows/ci.yml']) {
      const workflow = readFileSync(workflowPath, 'utf8');
      expect(workflow).toContain('Cert:\\LocalMachine\\TrustedPeople');
      expect(workflow).toContain('Cert:\\LocalMachine\\TrustedPublisher');
      expect(workflow).not.toContain('Cert:\\LocalMachine\\Root');
      expect(workflow).toContain('Remove-Item -LiteralPath $pfxPath -Force');
      expect(workflow).toContain('Windows release-signing material cleanup was incomplete.');
    }
  });

  it('self-hosts the Computer Use helper from a pinned npm package during CI builds', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies?: Record<string, string> };
    const copyScript = readFileSync('scripts/copy-computer-use-helper.mjs', 'utf8');
    const workflow = readFileSync('.github/workflows/build-node-exe.yml', 'utf8');

    expect(packageJson.devDependencies?.['open-computer-use']).toBe('0.2.0');
    expect(copyScript).toContain("require.resolve('open-computer-use/package.json')");
    expect(copyScript).toContain('Open Computer Use.app');
    expect(copyScript).toContain('open-computer-use.app.zip');
    expect(copyScript).toContain("['--verify', '--deep', '--strict', appPath]");
    expect(copyScript).toContain("'-verify_arch'");
    expect(copyScript).toContain("'x86_64'");
    expect(copyScript).toContain("'arm64'");
    expect(copyScript).not.toContain("'--force', '--sign', '-'");
    expect(workflow).toContain("IMCODES_REQUIRE_COMPUTER_USE_HELPER: '1'");
    expect(workflow).toContain('echo "IMCODES_BUILD_VERSION=$VERSION" >> "$GITHUB_ENV"');
  });
});
