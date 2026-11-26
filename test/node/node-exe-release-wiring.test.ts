import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
// @ts-expect-error ESM script module
import { generateControlledNodeReleaseManifest } from '../../scripts/generate-controlled-node-manifest.mjs';
// @ts-expect-error ESM script module
import {
  publishControlledNodeR2,
  R2_MUTABLE_CACHE_CONTROL,
} from '../../scripts/publish-controlled-node-r2.mjs';

describe('controlled-node executable release wiring', () => {
  it('packs the versioned, already-tested npm release before publishing without duplicate lifecycle tests', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const setVersion = workflow.indexOf('npm version ${{ needs.release_version.outputs.app_version }} --no-git-tag-version');
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
    expect(workflow).toContain('"runner":"windows-2022"');
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
    expect(workflow).toContain('"runner":"macos-26"');
    const standaloneWorkflow = readFileSync('.github/workflows/build-node-exe.yml', 'utf8');
    expect(standaloneWorkflow).toContain('- os: macos-26');
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

  it('builds the macOS remote-desktop components into the image, and proves they are there', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    // The gap this closes: every remote-desktop build step in this job was
    // guarded `if: runner.os == 'Windows'`, so the image shipped a macOS node
    // that self-upgrades and then finds nothing to fetch -- the server answers
    // `remote_desktop_worker_not_built` and macOS remote desktop is simply
    // unavailable.
    const componentBuild = workflow.indexOf(
      'name: Build, sign and notarize the macOS remote-desktop components',
    );
    expect(componentBuild).toBeGreaterThan(-1);
    // Bounded at the NEXT step, not by a character count. A fixed-length
    // window ran past the end of this step and matched the platform guard of
    // the one after it, so flipping this step back to Windows -- the exact
    // regression being guarded -- still passed.
    const nextStep = workflow.indexOf('\n      - name:', componentBuild);
    expect(nextStep).toBeGreaterThan(componentBuild);
    const buildStep = workflow.slice(componentBuild, nextStep);
    expect(buildStep).toContain("if: runner.os == 'macOS'");
    expect(buildStep).toContain('scripts/build-macos-remote-desktop-release.mjs');
    // Both architectures, from the shell loop that drives them -- not a
    // per-arch assertion, because the workflow spells `$arch` once and lets
    // the loop supply the values.
    expect(buildStep).toContain('for arch in arm64 x64; do');
    expect(buildStep).toContain('native/macos-remote-desktop/libwebrtc-sdk-$arch.lock.json');
    expect(buildStep).toContain('--artifact-root "dist-node-exe/remote-desktop-worker/darwin-$arch"');

    // Built from the PUBLISHED, locked SDK. Rebuilding it here would take
    // hours and would not be the SDK the lock names.
    expect(buildStep).toContain('scripts/install-libwebrtc-sdk.mjs');
    expect(buildStep).toContain('scripts/libwebrtc-sdk-artifacts.mjs verify-sdk-lock');

    // And the image assembly must CHECK for them. This verifier defaults to
    // the Windows target when none is named, so the missing macOS sets were
    // never a failure -- naming every target is what makes their absence one.
    const imageVerify = workflow.indexOf(
      'name: Verify remote-desktop worker artifacts for every target',
    );
    expect(imageVerify).toBeGreaterThan(-1);
    const nextVerifyStep = workflow.indexOf('\n      - name:', imageVerify);
    expect(nextVerifyStep).toBeGreaterThan(imageVerify);
    const verifyStep = workflow.slice(imageVerify, nextVerifyStep);
    expect(verifyStep).toContain('server/controlled-node-artifacts "$IMCODES_BUILD_VERSION" win32 x64');
    expect(verifyStep).toContain('server/controlled-node-artifacts "$IMCODES_BUILD_VERSION" darwin "$arch"');

    // And the image ITSELF must be checked, which is a separate gate from the
    // directory the image is built from -- and the one that actually proves
    // the components shipped. It defaulted to the Windows target too.
    const smoke = workflow.indexOf('/app/controlled-node-executables');
    expect(smoke).toBeGreaterThan(-1);
    const smokeStep = workflow.slice(smoke, workflow.indexOf('\n      - name:', smoke));
    expect(smokeStep).toContain('"${{ needs.release_version.outputs.app_version }}" win32 x64');
    expect(smokeStep).toContain('"${{ needs.release_version.outputs.app_version }}" darwin "$arch"');

    // The upload has to carry them, or the Docker job downloads a set that
    // never left the build runner.
    expect(workflow).toContain('dist-node-exe/remote-desktop-worker/**');
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
    expect(entry).toContain('waitForControlledNodeOnlineLease(');
    expect(entry.indexOf('waitForControlledNodeOnlineLease('))
      .toBeLessThan(entry.indexOf('formatInstallSuccess('));
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
    const runner = readFileSync('src/node/computer-use-runner.ts', 'utf8');
    const workflow = readFileSync('.github/workflows/build-node-exe.yml', 'utf8');

    expect(packageJson.devDependencies?.['open-computer-use']).toBe('1.1.4');
    const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages?: Record<string, { version?: string; integrity?: string }>;
    };
    expect(packageLock.packages?.['node_modules/open-computer-use']).toMatchObject({
      version: '1.1.4',
      integrity: 'sha512-rx2QUxvzb1ZFGKQjtk8J1eBIyUwv4xCSt7Pz7bA4Pq/zBNFGiGRe8Y36e/pxCDpvBXcZK7nZORSTv2P/0pPtWQ==',
    });
    expect(copyScript).toContain("require.resolve('open-computer-use/package.json')");
    expect(copyScript).toContain('open-computer-use must use an exact semver pin');
    expect(copyScript).toContain('npm package manifest must be a regular non-symlink file');
    expect(copyScript).toContain('manifest.version !== pinnedOpenComputerUseVersion');
    expect(runner).not.toContain('fileURLToPath(import.meta.url)');
    expect(runner).toContain('entryFilePath = options.entryFilePath === undefined ? process.argv[1]');
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

  it('signs, notarizes and proves the macOS executable, in that order', () => {
    // The chain used to be half-built: the release workflow imported a signing
    // identity and cleaned it up afterwards, with nothing in between that
    // signed or notarized anything. Every macOS artifact shipped ad-hoc signed
    // and was refused by Gatekeeper on download, and nothing failed to say so.
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const workflow = readFileSync(file, 'utf8');
      const importIdentity = workflow.indexOf('node scripts/macos-release-signing.mjs import');
      const notaryKey = workflow.indexOf('IMCODES_MACOS_NOTARY_KEY_BASE64');
      const build = workflow.indexOf('run: npm run build:node-exe');
      const notarize = workflow.indexOf('macos-release-signing.mjs notarize dist-node-exe/imcodes-node-macos');
      const runs = workflow.indexOf('./dist-node-exe/imcodes-node-macos --version');
      const cleanup = workflow.indexOf('node scripts/macos-release-signing.mjs cleanup');

      expect([importIdentity, notaryKey, build, notarize, runs, cleanup].every((at) => at >= 0), file).toBe(true);
      // The identity has to exist before the build, because the build is what
      // signs; notarizing has to follow the build, for the obvious reason.
      expect(importIdentity, file).toBeLessThan(build);
      expect(notaryKey, file).toBeLessThan(build);
      expect(build, file).toBeLessThan(notarize);
      expect(notarize, file).toBeLessThan(cleanup);
      // Launching the signed binary is the only step that catches a wrong
      // entitlement set: such a binary signs and notarizes perfectly and then
      // dies for the user instead.
      expect(runs, file).toBeLessThan(cleanup);
    }
  });

  it('keeps the signing material out of the artifact and removes it even on failure', () => {
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const workflow = readFileSync(file, 'utf8');
      expect(workflow, file).toContain("if: always() && runner.os == 'macOS'");
      // The private key reaches the runner as a secret and must never be
      // reachable from the published artifact set.
      expect(workflow, file).not.toContain('dist-node-exe/imcodes-macos-notary.p8');
    }
  });

  it('signs with the pinned fingerprint and the entitlements the runtime needs', () => {
    const build = readFileSync('scripts/build-node-exe.mjs', 'utf8');
    expect(build).toContain("'--options', 'runtime'");
    expect(build).toContain("'native', 'macos-node', 'imcodes-node.entitlements'");
    // A common name can match several certificates; a release pins one.
    expect(build).toContain('IMCODES_MACOS_SIGNING_IDENTITY must be a SHA-1 fingerprint');
    // Without an identity the build still has to produce a runnable binary, or
    // every local macOS build breaks.
    expect(build).toContain("sh('codesign', ['--force', '--sign', '-', artifactPath]);");

    const entitlements = readFileSync('native/macos-node/imcodes-node.entitlements', 'utf8');
    expect(entitlements).toContain('com.apple.security.cs.allow-jit');
    expect(entitlements).toContain('com.apple.security.cs.allow-unsigned-executable-memory');
    // Would let the process load a dylib signed by anyone, and the SEA is
    // native-free by construction.
    expect(entitlements).not.toContain('disable-library-validation');
    // codesign's entitlements parser rejects XML comments outright, while
    // `plutil -lint` accepts them -- so the failure lands at signing time.
    expect(entitlements).not.toContain('<!--');
  });

  it('builds, notarizes and staples the aiDesk bundle, and ships it', () => {
    // The bundle is what macOS attributes permissions to, and unlike the bare
    // executable it can carry its own notarization ticket -- so an unstapled
    // one that shipped would silently need the network on first launch.
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const workflow = readFileSync(file, 'utf8');
      const build = workflow.indexOf('run: npm run build:node-exe');
      const notarize = workflow.indexOf('macos-release-signing.mjs notarize "$APP"');
      // Uploaded only inside containers that keep permissions -- see the
      // test below for why the bare directory must not be one of them.
      const upload = workflow.indexOf('dist-node-exe/*.dmg');

      expect([build, notarize, upload].every((at) => at >= 0), file).toBe(true);
      expect(build, file).toBeLessThan(notarize);
      // The notarize command includes stapling AND bounded validation before
      // returning. macos-notarization-workflow.test.ts exercises that gate's
      // normal, transient and permanent failures. Do not require a second raw
      // validate here: it bypasses those retries and repeats the CloudKit call.
      expect(notarize, file).toBeLessThan(upload);
    }
  });

  it('wraps the app in a stapled disk image, built after the app is stapled', () => {
    // Order matters for a reason a user feels: the image is built from the app
    // as it stands, so an app stapled afterwards would ship inside an image
    // holding an unstapled copy -- and dragging it out would need the network.
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const workflow = readFileSync(file, 'utf8');
      const stapleApp = workflow.indexOf('macos-release-signing.mjs notarize "$APP"');
      const buildDmg = workflow.indexOf('node scripts/build-aidesk-app.mjs dmg dist-node-exe');
      const notarizeDmg = workflow.indexOf('macos-release-signing.mjs notarize "$DMG"');
      const upload = workflow.indexOf('dist-node-exe/*.dmg');

      expect([stapleApp, buildDmg, notarizeDmg, upload].every((at) => at >= 0), file).toBe(true);
      expect(stapleApp, file).toBeLessThan(buildDmg);
      expect(buildDmg, file).toBeLessThan(notarizeDmg);
      expect(notarizeDmg, file).toBeLessThan(upload);
    }
  });

  it('never uploads the bundle as a bare directory', () => {
    // Measured on a Mac, not assumed: GitHub artifacts normalise every file to
    // 644, so an app uploaded as a directory comes back with its executables
    // stripped of `+x` and dies with "permission denied". The signature
    // survives, which makes the corpse look healthy. It travels inside the
    // sidecar archive and the disk image instead, both of which keep the
    // permission bits.
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const workflow = readFileSync(file, 'utf8');
      expect(workflow, file).not.toContain('dist-node-exe/aiDesk.to by IM.codes.app/**');
      expect(workflow, file).toContain('dist-node-exe/*.dmg');
      // The archive that carries it is produced by the build, not by a step
      // here -- see the manifest-ordering test below.
      expect(workflow, file).toContain('dist-node-exe/computer-use-helper/**');
    }
  });

  it('builds the helper archive before the manifest records its hash', () => {
    // The manifest records the archive's size and sha256. Replacing the
    // archive afterwards makes every consumer reject the whole artifact set as
    // tampered with -- which is exactly how CI failed, with a message about
    // the helper being "missing or empty" while the file sat there intact.
    const build = readFileSync('scripts/build-node-exe.mjs', 'utf8');
    const publish = build.indexOf('publishAideskHelperSidecar');
    const manifest = build.indexOf('await createNodeExeManifest(');
    expect(publish, 'the bundle is published during the build').toBeGreaterThanOrEqual(0);
    expect(publish).toBeLessThan(manifest);

    // And CI must not put it back afterwards.
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const workflow = readFileSync(file, 'utf8');
      expect(workflow, file).not.toContain('build-aidesk-app.mjs sidecar');
    }
  });

  it('leaves a local build with the upstream archive that actually works', () => {
    // Without a release identity the bundle is ad-hoc signed, and the runtime's
    // own verifier requires a Developer ID authority -- so replacing the
    // archive on a developer machine would hand the daemon a helper it refuses.
    // Better the upstream one, which works.
    const build = readFileSync('scripts/build-node-exe.mjs', 'utf8');
    expect(build).toContain("process.env.IMCODES_MACOS_SIGNING_IDENTITY?.trim()");
    const guard = build.indexOf("if (platform === 'darwin' && process.env.IMCODES_MACOS_SIGNING_IDENTITY");
    const publish = build.indexOf('publishAideskHelperSidecar');
    expect(guard, 'the replacement is guarded').toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(publish);
  });
});

describe('headless compatibility release wiring', () => {
  it('ships a separately pinned artifact without changing modern OS/CPU legs or building GUI', () => {
    const action = readFileSync('.github/actions/build-controlled-node-compat/action.yml', 'utf8');
    const wrapper = readFileSync('scripts/build-node-compat-exe.mjs', 'utf8');
    const parsed = parseYaml(action);
    expect(parsed.runs.using).toBe('composite');
    expect(parsed.runs.steps).toHaveLength(3);
    for (const step of parsed.runs.steps) { expect(step.shell).toBe('bash'); expect(typeof step.run).toBe('string'); }
    expect(parsed.steps).toBeUndefined();
    expect(action).toContain('shared/controlled-node-abi-profiles.json');
    expect(action).toContain('npm run check:node-exe-deps');
    expect(action).toContain('node scripts/build-node-compat-exe.mjs');
    expect(action).not.toContain('build-worker');
    expect(action).not.toContain('signing');
    expect(wrapper).toContain('NODE_EXE_ABI_PROFILE: pin.id');
    expect(wrapper).toContain('verifyNodeExeManifestSet');
    expect(wrapper).toContain('source-commit-${pin.id}.txt');
    for (const path of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const workflow = readFileSync(path, 'utf8');
      expect(workflow).toContain('uses: ./.github/actions/build-controlled-node-compat');
      expect(workflow).toContain('dist-node-exe/${{ steps.compat.outputs.artifact }}.manifest.json');
    }
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('release_version, controlled-node-executables, controlled-node-compat-executable]');
    expect(workflow).toContain('imcodes-node-linux imcodes-node-macos imcodes-node.exe imcodes-node-linux-glibc217');
    expect(workflow).toContain('controlled-node-compat');
  });

  it('wires unified desktop client manifests/runtime into Docker smoke while excluding full installers from the image', () => {
    const workflow = parseYaml(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: {
        docker: {
          steps: Array<{ name?: string; run?: string; with?: Record<string, string> }>;
        };
      };
    };
    const dockerSteps = workflow.jobs.docker.steps;
    const chmodStep = dockerSteps.find((s) => s.name === 'Restore executable bits actions/download-artifact drops');
    expect(chmodStep?.run).toContain("! -name '*.deb'");
    expect(chmodStep?.run).toContain("! -name '*.pkg'");
    expect(chmodStep?.run).toContain("! -name '*.iss'");
    expect(chmodStep?.run).toContain("! -name '*.ps1'");
    expect(chmodStep?.run).toContain("! -name '*.cmd'");
    expect(chmodStep?.run).toContain("! -name '*.txt'");
    expect(chmodStep?.run).not.toContain("! -name '*.sh'");

    const manifestStageStep = dockerSteps.find(
      (s) => s.name === 'Generate controlled-node release artifacts manifest and stage flat release assets',
    );
    expect(manifestStageStep?.run).toContain('desktop-release.manifest.json');
    expect(manifestStageStep?.run).toContain('desktop-release-darwin-arm64.manifest.json');
    expect(manifestStageStep?.run).toContain('desktop-release-darwin-x64.manifest.json');
    expect(manifestStageStep?.run).toContain('imcodes-desktop-${IMCODES_BUILD_VERSION}-linux-amd64.deb');
    expect(manifestStageStep?.run).toContain('imcodes-desktop-${IMCODES_BUILD_VERSION}-linux-x64.sh');
    expect(manifestStageStep?.run).toContain('imcodes-desktop-${IMCODES_BUILD_VERSION}-darwin-arm64.pkg');
    expect(manifestStageStep?.run).toContain('imcodes-desktop-${IMCODES_BUILD_VERSION}-darwin-x64.pkg');
    expect(manifestStageStep?.run).toContain('imcodes-desktop-${IMCODES_BUILD_VERSION}-win32-x64.exe');

    const smokeStep = dockerSteps.find((s) => s.name === 'Container startup smoke test');
    expect(smokeStep?.run).toContain("fs.existsSync(path.join(root, 'installers'))");
    expect(smokeStep?.run).toContain("entry.endsWith('.tar.gz') || entry.endsWith('.zip')");
    expect(smokeStep?.run).toContain('release-artifacts-manifest.json');
    expect(smokeStep?.run).toContain('validateDesktopReleaseManifest');
    expect(smokeStep?.run).toContain('validateDaemonRuntimeManifest');
    expect(smokeStep?.run).toMatch(/validateDaemonRuntimeManifest\([^;]+,\s*t\)/);

    const dockerignore = readFileSync('.dockerignore', 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim());
    expect(dockerignore).toContain('server/controlled-node-artifacts/installers');
    expect(dockerignore).toContain('server/controlled-node-artifacts/daemon-runtime/*.tar.gz');
    expect(dockerignore).toContain('server/controlled-node-artifacts/daemon-runtime/*.zip');
    expect(dockerignore).not.toContain('server/controlled-node-artifacts/daemon-runtime');
    expect(dockerignore).not.toContain('server/controlled-node-artifacts/daemon-runtime/*.manifest.json');
  });

  it('includes Windows controlled-node builds and Windows docker gates across dev, main, and master while preserving dev versioning', () => {
    const workflow = parseYaml(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: {
        release_version: {
          outputs?: Record<string, string>;
          steps: Array<{ id?: string; run?: string }>;
        };
        'controlled-node-executables': {
          strategy?: { matrix?: { include?: string } };
        };
        docker: {
          steps: Array<{ name?: string; run?: string }>;
        };
      };
    };

    expect(workflow.jobs.release_version.outputs?.controlled_node_matrix)
      .toBe('${{ steps.version.outputs.controlled_node_matrix }}');
    expect(workflow.jobs['controlled-node-executables'].strategy?.matrix?.include)
      .toBe('${{ fromJSON(needs.release_version.outputs.controlled_node_matrix) }}');

    const versionStep = workflow.jobs.release_version.steps.find((s) => s.id === 'version');
    expect(versionStep?.run).toBeTruthy();

    const tmpRoot = mkdtempSync(join(tmpdir(), 'imcodes-ci-matrix-'));
    try {
      const runVersionStep = (ref: string) => {
        const outFile = join(tmpRoot, `out-${ref.replaceAll('/', '_')}.txt`);
        writeFileSync(outFile, '');
        execFileSync('bash', ['--noprofile', '--norc', '-c', versionStep!.run!], {
          env: {
            ...process.env,
            GITHUB_REF: ref,
            GITHUB_RUN_NUMBER: '42',
            GITHUB_OUTPUT: outFile,
          },
          stdio: 'pipe',
        });
        const lines = readFileSync(outFile, 'utf8').trim().split('\n');
        const matrixLine = lines.find((l) => l.startsWith('controlled_node_matrix='));
        const appVersionLine = lines.find((l) => l.startsWith('app_version='));
        expect(matrixLine, ref).toBeTruthy();
        expect(appVersionLine, ref).toBeTruthy();
        return {
          appVersion: appVersionLine!.slice('app_version='.length),
          matrix: JSON.parse(matrixLine!.slice('controlled_node_matrix='.length)) as Array<{
            key: string;
            runner: string;
            artifact: string;
          }>,
        };
      };

      const devResult = runVersionStep('refs/heads/dev');
      expect(devResult.appVersion).toMatch(/^\d+\.\d+\.\d+-dev\.42$/);
      expect(devResult.matrix).toEqual([
        { key: 'linux', runner: 'ubuntu-latest', artifact: 'imcodes-node-linux' },
        { key: 'macos', runner: 'macos-26', artifact: 'imcodes-node-macos' },
        { key: 'windows', runner: 'windows-2022', artifact: 'imcodes-node.exe' },
      ]);

      for (const releaseRef of ['refs/heads/main', 'refs/heads/master']) {
        const relResult = runVersionStep(releaseRef);
        expect(relResult.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(relResult.matrix).toEqual([
          { key: 'linux', runner: 'ubuntu-latest', artifact: 'imcodes-node-linux' },
          { key: 'macos', runner: 'macos-26', artifact: 'imcodes-node-macos' },
          { key: 'windows', runner: 'windows-2022', artifact: 'imcodes-node.exe' },
        ]);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }

    const dockerSteps = workflow.jobs.docker.steps;
    const byName = (name: string) => {
      const step = dockerSteps.find((s) => s.name === name);
      expect(step?.run, name).toBeTruthy();
      return step!.run!;
    };

    const verifyExeSet = byName('Verify controlled-node executable set');
    expect(verifyExeSet).not.toContain('refs/heads/dev');
    expect(verifyExeSet).toContain('imcodes-node-linux imcodes-node-macos imcodes-node.exe imcodes-node-linux-glibc217');

    const verifyRevision = byName('Verify native artifacts came from this exact source revision');
    expect(verifyRevision).not.toContain('refs/heads/dev');
    expect(verifyRevision).toContain('platforms=(linux macos windows "$glibc217_id")');

    const verifyWorker = byName('Verify remote-desktop worker artifacts for every target');
    expect(verifyWorker).not.toContain('refs/heads/dev');
    expect(verifyWorker).toContain('server/controlled-node-artifacts "$IMCODES_BUILD_VERSION" win32 x64');
    expect(verifyWorker).toContain('aidesk-local-ui/win32-x64');

    const verifyDaemonRuntime = byName('Verify daemon-runtime bundles for every desktop target');
    expect(verifyDaemonRuntime).not.toContain('refs/heads/dev');
    expect(verifyDaemonRuntime).toContain('targets=(linux-x64 darwin-arm64 darwin-x64 win32-x64)');

    const stageAssets = byName('Generate controlled-node release artifacts manifest and stage flat release assets');
    expect(stageAssets).not.toContain('refs/heads/dev');
    expect(stageAssets).toContain('desktop-release-win32-x64.manifest.json');
    expect(stageAssets).toContain('desktop-release-darwin-x64.manifest.json');
    expect(stageAssets).toContain('imcodes-desktop-${IMCODES_BUILD_VERSION}-win32-x64.exe');
    expect(stageAssets).toContain('imcodes-desktop-${IMCODES_BUILD_VERSION}-darwin-x64.pkg');

    const smoke = byName('Container startup smoke test');
    expect(smoke).not.toContain('refs/heads/dev');
    expect(smoke).toContain('imcodes-node-linux imcodes-node-macos imcodes-node.exe imcodes-node-linux-glibc217');
    expect(smoke).toContain('win32 x64');
    expect(smoke).toContain("const targets = ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64'];");

    for (const rel of ['.github/workflows/ci.yml', '.github/workflows/build-node-exe.yml']) {
      const wfText = readFileSync(rel, 'utf8');
      expect(wfText, rel).toContain('TARGETS=(darwin-arm64 darwin-x64)');
      expect(wfText, rel).toContain('for MAC_ARCH in arm64 x64; do');
    }
  });

  it('generateControlledNodeReleaseManifest succeeds on dev artifacts without Windows binaries or manifests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-dev-manifest-'));
    const stageDir = join(dir, 'stage');
    const artifactsDir = join(dir, 'artifacts');
    try {
      mkdirSync(artifactsDir, { recursive: true });
      const ver = '2026.11.100-dev.1';
      const gitSha = 'a'.repeat(40);

      for (const bin of [
        { filename: 'imcodes-node-linux', os: 'linux', arch: 'x64' },
        { filename: 'imcodes-node-macos', os: 'darwin', arch: 'universal' },
        { filename: 'imcodes-node-linux-glibc217', os: 'linux', arch: 'x64' },
      ]) {
        const bytes = Buffer.from(`bin-${bin.filename}`);
        writeFileSync(join(artifactsDir, bin.filename), bytes);
        writeFileSync(join(artifactsDir, `${bin.filename}.manifest.json`), JSON.stringify({
          schemaVersion: 1,
          build: { version: ver },
          artifact: {
            fileName: bin.filename,
            os: bin.os,
            arch: bin.arch,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
          },
        }));
      }

      for (const target of ['linux-x64', 'darwin-arm64']) {
        writeFileSync(join(artifactsDir, `desktop-release-${target}.manifest.json`), JSON.stringify({
          schemaVersion: 1,
          releaseVersion: ver,
          gitSha,
          targets: {
            [target]: {
              components: {},
              installers: [],
            },
          },
        }));
      }

      const { manifest } = generateControlledNodeReleaseManifest({
        artifactsDir,
        version: ver,
        stageDir,
      });

      expect(manifest.artifacts['node:linux:x64']).toBeDefined();
      expect(manifest.artifacts['node:mac:universal']).toBeDefined();
      expect(manifest.artifacts['node:linux:x64:glibc217']).toBeDefined();
      expect(manifest.artifacts['node:win:x64']).toBeUndefined();
      expect(manifest.artifacts['desktop-release-manifest:linux:x64']).toBeDefined();
      expect(manifest.artifacts['desktop-release-manifest:mac:arm64']).toBeDefined();
      expect(manifest.artifacts['desktop-release-manifest:win:x64']).toBeUndefined();
      expect(manifest.artifacts['desktop-release-manifest']).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes controlled-node artifacts without aws s3 sync --delete and sets no-cache on R2 syncs', () => {
    const workflow = parseYaml(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: {
        docker: {
          steps: Array<{ name?: string; uses?: string; run?: string }>;
        };
        'android-release': {
          steps: Array<{ name?: string; uses?: string; run?: string }>;
        };
      };
    };
    const dockerSteps = workflow.jobs.docker.steps;
    const ghReleaseStep = dockerSteps.find((s) => s.name === 'Publish controlled-node artifacts GitHub Release');
    expect(ghReleaseStep?.uses).toBe('softprops/action-gh-release@v2');

    const r2Step = dockerSteps.find((s) => s.name === 'Sync controlled-node artifacts to R2 (optional)');
    expect(r2Step?.run).toBeTruthy();
    expect(r2Step?.run).toContain('exit 0');
    expect(r2Step?.run).toContain('r2_channel="dev"');
    expect(r2Step?.run).toContain('r2_channel="master"');
    expect(r2Step?.run).toContain('AWS_REQUEST_CHECKSUM_CALCULATION="when_required"');
    expect(r2Step?.run).toContain('AWS_RESPONSE_CHECKSUM_VALIDATION="when_required"');
    expect(r2Step?.run).toContain('aws configure set default.s3.multipart_threshold 100MB');
    expect(r2Step?.run).toContain('aws configure set default.s3.multipart_chunksize 64MB');
    expect(r2Step?.run).toContain('aws configure set default.s3.max_concurrent_requests 4');
    expect(r2Step?.run).not.toMatch(/aws s3 sync[^\n]*dist-controlled-node-release[^\n]*--delete/);
    expect(r2Step?.run).toContain('node scripts/publish-controlled-node-r2.mjs');

    const androidSteps = workflow.jobs['android-release'].steps;
    const androidGhStep = androidSteps.find((s) => s.name === 'Create GitHub Release');
    expect(androidGhStep?.uses).toBe('softprops/action-gh-release@v2');

    const androidR2Step = androidSteps.find((s) => s.name === 'Sync Android APKs to R2 (optional)');
    expect(androidR2Step?.run).toBeTruthy();
    expect(androidR2Step?.run).toContain('imcodes-with-fcm-latest.apk');
    expect(androidR2Step?.run).toContain('imcodes-without-fcm-latest.apk');
    expect(androidR2Step?.run).toContain('latest.json');
    expect(androidR2Step?.run).not.toMatch(/cp\s+[^\n]*\.aab/u);
    expect(androidR2Step?.run).toContain('dest="s3://${R2_BUCKET}${prefix:+/${prefix}}/${r2_channel}/android"');
    expect(androidR2Step?.run).toContain('AWS_REQUEST_CHECKSUM_CALCULATION="when_required"');
    expect(androidR2Step?.run).toContain('AWS_RESPONSE_CHECKSUM_VALIDATION="when_required"');
    expect(androidR2Step?.run).toContain('aws configure set default.s3.multipart_threshold 100MB');
    expect(androidR2Step?.run).toContain('aws configure set default.s3.multipart_chunksize 64MB');
    expect(androidR2Step?.run).toContain('aws configure set default.s3.max_concurrent_requests 4');
    expect(androidR2Step?.run).toContain('for attempt in 1 2 3');
    expect(androidR2Step?.run).toMatch(/aws s3 sync dist-android-release "\$dest"\s+\\\s+--delete\s+\\\s+--cache-control "no-cache, max-age=0, must-revalidate"\s+\\\s+--endpoint-url/);
  });

  it('retries transient InvalidPart failures, preserves prefix siblings, protects subpaths, and verifies head-object parity on R2 publish', async () => {
    const workflow = parseYaml(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: {
        docker: { steps: Array<{ name?: string; run?: string }> };
        'android-release': { steps: Array<{ name?: string; run?: string }> };
      };
    };
    const controlledRun = workflow.jobs.docker.steps.find(
      (s) => s.name === 'Sync controlled-node artifacts to R2 (optional)',
    )?.run;
    const androidRun = workflow.jobs['android-release'].steps.find(
      (s) => s.name === 'Sync Android APKs to R2 (optional)',
    )?.run;
    expect(controlledRun).toBeTruthy();
    expect(androidRun).toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'imcodes-ci-r2-retry-'));
    try {
      const binDir = join(dir, 'bin');
      const awsLog = join(dir, 'aws.log');
      const stateFile = join(dir, 'attempts');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      copyFileSync(resolve('scripts/publish-controlled-node-r2.mjs'), join(dir, 'scripts/publish-controlled-node-r2.mjs'));

      const distDir = join(dir, 'dist-controlled-node-release');
      mkdirSync(distDir, { recursive: true });
      const winWorkerBytes = Buffer.from('win-worker-binary-payload');
      const linuxNodeBytes = Buffer.from('linux-node-binary-payload');
      writeFileSync(join(distDir, 'imcodes-remote-desktop-worker-win32-x64.exe'), winWorkerBytes);
      writeFileSync(join(distDir, 'imcodes-node-linux'), linuxNodeBytes);
      const manifestJson = JSON.stringify({
        schemaVersion: 1,
        version: '2026.11.7132-dev.7022',
        generatedAt: new Date().toISOString(),
        artifacts: {
          'remote-desktop-worker:win:x64': {
            asset: 'remote-desktop-worker',
            assetFilename: 'imcodes-remote-desktop-worker-win32-x64.exe',
            relativePath: 'imcodes-remote-desktop-worker-win32-x64.exe',
            sha256: createHash('sha256').update(winWorkerBytes).digest('hex'),
            sizeBytes: winWorkerBytes.length,
          },
          'node:linux:x64': {
            asset: 'node',
            assetFilename: 'imcodes-node-linux',
            relativePath: 'imcodes-node-linux',
            sha256: createHash('sha256').update(linuxNodeBytes).digest('hex'),
            sizeBytes: linuxNodeBytes.length,
          },
        },
      });
      writeFileSync(join(distDir, 'release-artifacts-manifest.json'), manifestJson);
      const manifestSize = Buffer.byteLength(manifestJson);

      writeFileSync(join(dir, 'imcodes-with-fcm-v1.apk'), 'apk-with-fcm');
      writeFileSync(join(dir, 'imcodes-without-fcm-v1.apk'), 'apk-without-fcm');
      mkdirSync(join(dir, 'web/android/app'), { recursive: true });
      writeFileSync(join(dir, 'web/android/app/build.gradle'), 'versionName "1.0.0"\n');

      writeFileSync(
        join(binDir, 'aws'),
        `#!/usr/bin/env bash
echo "$*" >> "${awsLog}"
if [ "$1" = "configure" ]; then
  exit 0
fi
if [ "$AWS_REQUEST_CHECKSUM_CALCULATION" != "when_required" ] || [ "$AWS_RESPONSE_CHECKSUM_VALIDATION" != "when_required" ]; then
  echo "missing checksum env vars" >&2
  exit 99
fi
if [ "$1" = "s3api" ] && [ "$2" = "list-objects-v2" ]; then
  printf '{"Contents":[{"Key":"releases/dev/imcodes-remote-desktop-worker-win32-x64.exe"},{"Key":"releases/dev/stale-old-desktop.exe"},{"Key":"releases/dev/android/keep.apk"},{"Key":"releases/dev/npm/keep.tgz"}],"IsTruncated":false}\n'
  exit 0
fi
if [ "$1" = "s3api" ] && [ "$2" = "head-object" ]; then
  case "$*" in
    *release-artifacts-manifest.json*) printf '{"ContentLength":%s}\n' "${manifestSize}" ;;
    *imcodes-remote-desktop-worker-win32-x64.exe*) printf '{"ContentLength":%s}\n' "${winWorkerBytes.length}" ;;
    *imcodes-node-linux*) printf '{"ContentLength":%s}\n' "${linuxNodeBytes.length}" ;;
    *) echo "unexpected head-object key: $*" >&2; exit 255 ;;
  esac
  exit 0
fi
if [ "$1" = "s3api" ] && [ "$2" = "delete-object" ]; then
  exit 0
fi
count=0
if [ -f "${stateFile}" ]; then
  count=$(cat "${stateFile}")
fi
count=$((count + 1))
printf '%s' "$count" > "${stateFile}"
if [ "$count" -le "\${FAIL_UNTIL_ATTEMPT:-99}" ]; then
  echo "An error occurred (InvalidPart) when calling the CompleteMultipartUpload operation" >&2
  exit 255
fi
exit 0
`,
        { mode: 0o755 },
      );

      const baseEnv = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        R2_ACCOUNT_ID: 'acct123',
        R2_BUCKET: 'bucket123',
        R2_ACCESS_KEY_ID: 'key123',
        R2_SECRET_ACCESS_KEY: 'secret123',
        R2_PREFIX: 'releases',
        GITHUB_REF: 'refs/heads/dev',
        ANDROID_TAG: 'v1',
        ANDROID_BRANCH: 'dev',
        R2_SYNC_RETRY_DELAY_SECONDS: '0',
      };

      // Controlled-node publish step: transient InvalidPart on first cp attempt recovers cleanly,
      // uploads binaries before manifest, deletes ONLY stale-old-desktop.exe, and verifies all 3 objects.
      writeFileSync(awsLog, '');
      rmSync(stateFile, { force: true });
      const recoverCtrl = spawnSync('bash', ['-c', controlledRun!], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...baseEnv, FAIL_UNTIL_ATTEMPT: '1' },
      });
      expect(recoverCtrl.status, `controlled-node transient InvalidPart should recover: ${recoverCtrl.stderr}`).toBe(0);
      const ctrlLines = readFileSync(awsLog, 'utf8').trim().split('\n');
      expect(ctrlLines).toContain('configure set default.s3.multipart_threshold 100MB');
      expect(ctrlLines).toContain('configure set default.s3.multipart_chunksize 64MB');
      expect(ctrlLines).toContain('configure set default.s3.max_concurrent_requests 4');
      expect(ctrlLines.some((l) => l.includes(`--cache-control ${R2_MUTABLE_CACHE_CONTROL}`))).toBe(true);
      // Manifest uploaded AFTER non-manifest binaries
      const cpLines = ctrlLines.filter((l) => l.startsWith('s3 cp '));
      expect(cpLines.at(-1)).toContain('release-artifacts-manifest.json');
      // Only genuine stale top-level object deleted; uploaded prefix-sibling & android/npm subpaths untouched!
      const deleteLines = ctrlLines.filter((l) => l.startsWith('s3api delete-object '));
      expect(deleteLines).toHaveLength(1);
      expect(deleteLines[0]).toContain('releases/dev/stale-old-desktop.exe');
      expect(deleteLines.join('\n')).not.toContain('imcodes-remote-desktop-worker-win32-x64.exe');
      expect(deleteLines.join('\n')).not.toContain('android/');
      expect(deleteLines.join('\n')).not.toContain('npm/');
      // All 3 objects checked with head-object
      expect(ctrlLines.filter((l) => l.startsWith('s3api head-object '))).toHaveLength(3);

      // Controlled-node fails after 3 attempts on persistent upload error.
      writeFileSync(awsLog, '');
      rmSync(stateFile, { force: true });
      const failCtrl = spawnSync('bash', ['-c', controlledRun!], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...baseEnv, FAIL_UNTIL_ATTEMPT: '99' },
      });
      expect(failCtrl.status).not.toBe(0);
      expect(readFileSync(awsLog, 'utf8').trim().split('\n').filter((l) => l.startsWith('s3 cp '))).toHaveLength(3);

      // Direct unit test: post-publish head-object size mismatch fails closed!
      await expect(publishControlledNodeR2({
        distDir,
        accountId: 'acct123',
        bucket: 'bucket123',
        accessKeyId: 'key123',
        secretAccessKey: 'secret123',
        prefix: 'releases',
        channel: 'dev',
        retryDelaySeconds: 0,
        sleep: async () => {},
        runAws: async (args) => {
          if (args[0] === 's3api' && args[1] === 'list-objects-v2') {
            return { stdout: '{"Contents":[],"IsTruncated":false}', stderr: '' };
          }
          if (args[0] === 's3api' && args[1] === 'head-object') {
            if (args.includes('releases/dev/imcodes-remote-desktop-worker-win32-x64.exe')) {
              return { stdout: '{"ContentLength":999999}', stderr: '' };
            }
            return { stdout: JSON.stringify({ ContentLength: args.join(' ').includes('manifest') ? manifestSize : linuxNodeBytes.length }), stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      })).rejects.toThrow(/r2_verify_size_mismatch:imcodes-remote-desktop-worker-win32-x64\.exe/);

      // Android R2 sync retry & --cache-control contract.
      const androidSyncFrag = 's3 sync dist-android-release s3://bucket123/releases/dev/android --delete';
      writeFileSync(awsLog, '');
      rmSync(stateFile, { force: true });
      const recoverAndroid = spawnSync('bash', ['-c', androidRun!], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...baseEnv, FAIL_UNTIL_ATTEMPT: '1' },
      });
      expect(recoverAndroid.status, `android transient InvalidPart should recover: ${recoverAndroid.stderr}`).toBe(0);
      const recoverAndroidLines = readFileSync(awsLog, 'utf8').trim().split('\n');
      expect(recoverAndroidLines.filter((l) => l.includes(androidSyncFrag))).toHaveLength(2);
      expect(recoverAndroidLines.some((l) => l.includes(`--cache-control ${R2_MUTABLE_CACHE_CONTROL}`))).toBe(true);

      writeFileSync(awsLog, '');
      rmSync(stateFile, { force: true });
      const failAndroid = spawnSync('bash', ['-c', androidRun!], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...baseEnv, FAIL_UNTIL_ATTEMPT: '99' },
      });
      expect(failAndroid.status).not.toBe(0);
      expect(readFileSync(awsLog, 'utf8').trim().split('\n').filter((l) => l.includes(androidSyncFrag))).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stages Linux remote-desktop worker and deterministic macOS component-set archives into release-artifacts-manifest.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-rd-manifest-'));
    const stageDir = join(dir, 'stage');
    const artifactsDir = join(dir, 'artifacts');
    try {
      const ver = '2026.11.7088-dev.6988';
      const linuxDir = join(artifactsDir, 'remote-desktop-worker', 'linux-x64');
      mkdirSync(linuxDir, { recursive: true });
      const linuxBin = Buffer.from('linux-rd-worker-binary');
      writeFileSync(join(linuxDir, 'imcodes-linux-remote-desktop-worker'), linuxBin);
      writeFileSync(join(linuxDir, 'imcodes-linux-remote-desktop-worker.manifest.json'), JSON.stringify({
        schemaVersion: 1,
        build: { version: ver },
        artifact: {
          fileName: 'imcodes-linux-remote-desktop-worker',
          size: linuxBin.length,
          sha256: createHash('sha256').update(linuxBin).digest('hex'),
        },
      }));

      for (const arch of ['arm64', 'x64'] as const) {
        const macDir = join(artifactsDir, 'remote-desktop-worker', `darwin-${arch}`);
        mkdirSync(macDir, { recursive: true });
        const compEntries: Record<string, { fileName: string; size: number; sha256: string }> = {};
        const compSpecs = [
          ['worker', 'imcodes-remote-desktop-worker'],
          ['launchAgent', 'imcodes-remote-desktop-launch-agent'],
          ['disclosure', 'imcodes-remote-desktop-disclosure'],
          ['virtualDisplayHelper', 'imcodes-virtual-display-helper'],
        ] as const;
        for (const [kind, fileName] of compSpecs) {
          const bytes = Buffer.from(`${arch}-${kind}-payload`);
          writeFileSync(join(macDir, fileName), bytes);
          compEntries[kind] = {
            fileName,
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        }
        writeFileSync(join(macDir, 'imcodes-remote-desktop.manifest.json'), JSON.stringify({
          manifestVersion: 4,
          artifactKind: 'macos-component-set',
          workerVersion: ver,
          os: 'darwin',
          arch,
          components: compEntries,
        }));
      }

      const { manifest } = generateControlledNodeReleaseManifest({
        artifactsDir,
        version: ver,
        stageDir,
      });

      const linuxEntry = manifest.artifacts['remote-desktop-worker:linux:x64'];
      expect(linuxEntry).toBeDefined();
      expect(linuxEntry.assetFilename).toBe('imcodes-linux-remote-desktop-worker-linux-x64');
      expect(linuxEntry.version).toBe(ver);
      expect(readFileSync(join(stageDir, linuxEntry.assetFilename))).toEqual(linuxBin);

      const linuxManEntry = manifest.artifacts['remote-desktop-worker-manifest:linux:x64'];
      expect(linuxManEntry).toBeDefined();
      expect(linuxManEntry.assetFilename).toBe('imcodes-linux-remote-desktop-worker-linux-x64.manifest.json');

      for (const arch of ['arm64', 'x64'] as const) {
        const setEntry = manifest.artifacts[`remote-desktop-macos-component-set:mac:${arch}`];
        expect(setEntry).toBeDefined();
        expect(setEntry.assetFilename).toBe(`imcodes-remote-desktop-darwin-${arch}.set`);
        expect(setEntry.version).toBe(ver);
        const stagedBytes = readFileSync(join(stageDir, setEntry.assetFilename));
        expect(stagedBytes.length).toBe(setEntry.sizeBytes);
        expect(createHash('sha256').update(stagedBytes).digest('hex')).toBe(setEntry.sha256);
        expect(stagedBytes.subarray(0, 24).toString('utf8')).toBe('IMCODES-MACOS-RD-SET-V1\n');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
