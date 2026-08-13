import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('controlled-node executable release wiring', () => {
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
    expect(workflow).toContain('gh release download');
    expect(workflow).toContain('node scripts/install-libwebrtc-sdk.mjs');
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
    expect(workerBuild).toContain('& $WinToolsBootstrap.FullName');
    expect(workerBuild).toContain('$PostBootstrapDepotToolsRevision -ne $DepotToolsRevision');
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
    expect(standaloneWorkflow).toContain('gh release download');
    expect(standaloneWorkflow).toContain('node scripts/install-libwebrtc-sdk.mjs');
    expect(standaloneWorkflow).not.toContain('imcodes-webrtc-checkout-windows-x64-');

    const sdkWorkflow = readFileSync('.github/workflows/build-libwebrtc-sdk.yml', 'utf8');
    expect(sdkWorkflow).toContain('workflow_dispatch:');
    expect(sdkWorkflow).toContain('source_commit:');
    expect(sdkWorkflow).toContain("'${{ inputs.source_commit }}'");
    expect(sdkWorkflow).toContain('group: build-libwebrtc-sdk-windows-x64');
    expect(sdkWorkflow).toContain('Restore pinned depot_tools and CIPD bootstrap');
    expect(sdkWorkflow).toContain('native\\windows-remote-desktop\\build-worker.ps1');
    expect(sdkWorkflow).toContain('RequireAuthenticodeSignature = $true');
    expect(sdkWorkflow).toContain("CodeSigningTimestampUrl = 'http://timestamp.digicert.com'");
    expect(sdkWorkflow).toContain('node scripts/publish-libwebrtc-sdk.mjs');
    expect(sdkWorkflow).toContain('node scripts/libwebrtc-sdk-artifacts.mjs verify-lock');
    expect(sdkWorkflow).toContain('name: libwebrtc-sdk-candidate-${{ steps.sdk.outputs.release_tag }}');
    expect(sdkWorkflow).toContain('sdk-release/imcodes-libwebrtc-sdk-windows-x64.zip');
    expect(sdkWorkflow).not.toContain('gh release create');
    expect(sdkWorkflow).toContain('Windows release-signing material cleanup was incomplete.');
    const sdkArchiveScript = readFileSync('scripts/windows-libwebrtc-sdk-archive.ps1', 'utf8');
    const sdkInstallScript = readFileSync('scripts/install-libwebrtc-sdk.mjs', 'utf8');
    const sdkPublishScript = readFileSync('scripts/publish-libwebrtc-sdk.mjs', 'utf8');
    expect(sdkArchiveScript).toContain("[ValidateSet('Compress', 'Expand')]");
    expect(sdkArchiveScript).toContain("'imcodes-libwebrtc-sdk.manifest.json'");
    expect(sdkArchiveScript).toContain('Compress-Archive -LiteralPath @($Entries.FullName)');
    expect(sdkArchiveScript).toContain('Expand-Archive -LiteralPath $Archive.FullName');
    expect(sdkArchiveScript).toContain('[IO.Compression.ZipFile]::OpenRead($Archive.FullName)');
    expect(sdkArchiveScript).toContain("'imcodes-remote-desktop-worker.exe' = 268435456");
    expect(sdkInstallScript).toContain("'-Mode', 'Expand'");
    expect(sdkPublishScript).toContain("'-Mode', 'Compress'");
    expect(sdkInstallScript).not.toContain("'-Command'");
    expect(sdkPublishScript).not.toContain("'-Command'");
  });

  it('exposes the embedded runtime version without bootstrapping or installing', () => {
    const entry = readFileSync('src/node/index.ts', 'utf8');
    expect(entry).toContain("process.argv[2] === '--version'");
    expect(entry).toContain('process.stdout.write(`${DAEMON_VERSION}\\n`)');
  });

  it('copies the artifacts into the image and configures the serving directory', () => {
    const dockerfile = readFileSync('server/Dockerfile', 'utf8');

    expect(dockerfile).toContain('COPY server/controlled-node-artifacts/ ./controlled-node-executables/');
    expect(dockerfile).toContain('COPY scripts/node-exe-artifacts.mjs ./scripts/node-exe-artifacts.mjs');
    expect(dockerfile).toContain('COPY scripts/remote-desktop-worker-artifacts.mjs ./scripts/remote-desktop-worker-artifacts.mjs');
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
