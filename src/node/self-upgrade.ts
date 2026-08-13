import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, win32 as pathWin32 } from 'node:path';
import {
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL,
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH,
  controlledNodeComputerUseHelperFilename,
  CONTROLLED_NODE_OS_LINUX,
  CONTROLLED_NODE_OS_MAC,
  CONTROLLED_NODE_OS_WIN,
  type ControlledNodeArtifactArch,
  type ControlledNodeOs,
} from '../../shared/controlled-node-artifacts.js';
import { DAEMON_UPGRADE_TARGET_LATEST, normalizeDaemonUpgradeTargetVersion } from '../../shared/daemon-upgrade.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
  validateRemoteDesktopWorkerManifest,
} from '../../shared/remote-desktop-worker.js';
import {
  CONTROLLED_NODE_SERVICE,
  encodeWindowsScheduledTaskXml,
  MACOS_PLIST_PATH,
  MACOS_WATCHDOG_PLIST_PATH,
  windowsComputerUseHelperAclCommands,
  windowsCredentialAclCommands,
  windowsExecutableFileAclCommands,
  WINDOWS_UPGRADE_MARKER_NAME,
  windowsPowerShellExecutablePath,
} from './installer.js';
import { defaultCredentialPath, defaultStagedExecutablePath, type ControlledNodeCredential } from './enrollment.js';
import { loadInstallJournal, INSTALL_JOURNAL_VERSION } from './install-journal.js';
import { WINDOWS_COMPILED_RELEASE_SIGNER_SHA256 } from './windows-artifact-trust.js';

export interface ControlledNodeArtifactTarget {
  os: ControlledNodeOs;
  arch: ControlledNodeArtifactArch;
}

export interface ControlledNodeSelfUpgradeDeps {
  fetchImpl?: typeof fetch;
  spawnDetached?: (file: string, args: readonly string[], options: { windowsHide?: boolean }) => void;
  scheduleWindowsUpgrade?: (taskName: string, taskXmlPath: string) => void;
  scheduleLinuxUpgrade?: (unitName: string, scriptPath: string) => void;
  execPath?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  tmpdir?: () => string;
  now?: () => number;
  journalPath?: string;
}

export interface ControlledNodeSelfUpgradeResult {
  ok: boolean;
  reason?: string;
  targetVersion: string;
  artifactSha256?: string;
  scriptPath?: string;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function controlledNodeArtifactTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): ControlledNodeArtifactTarget | null {
  if (platform === 'win32' && arch === 'x64') return { os: CONTROLLED_NODE_OS_WIN, arch: CONTROLLED_NODE_ARCH_X64 };
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return { os: CONTROLLED_NODE_OS_MAC, arch: CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL };
  }
  if (platform === 'linux' && arch === 'x64') return { os: CONTROLLED_NODE_OS_LINUX, arch: CONTROLLED_NODE_ARCH_X64 };
  return null;
}

export function controlledNodeArtifactUpgradeUrl(
  credential: Pick<ControlledNodeCredential, 'serverUrl' | 'serverId'>,
  target: ControlledNodeArtifactTarget,
  asset: typeof CONTROLLED_NODE_ARTIFACT_ASSETS[keyof typeof CONTROLLED_NODE_ARTIFACT_ASSETS] = CONTROLLED_NODE_ARTIFACT_ASSETS.NODE,
): string {
  const url = new URL(CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH, credential.serverUrl);
  url.searchParams.set('serverId', credential.serverId);
  url.searchParams.set('os', target.os);
  url.searchParams.set('arch', target.arch);
  if (asset !== CONTROLLED_NODE_ARTIFACT_ASSETS.NODE) url.searchParams.set('asset', asset);
  return url.toString();
}

function readHeader(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase());
}

async function downloadArtifact(input: {
  credential: ControlledNodeCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
  asset?: typeof CONTROLLED_NODE_ARTIFACT_ASSETS[keyof typeof CONTROLLED_NODE_ARTIFACT_ASSETS];
  expectedFileName?: string;
  expectedVersion?: string;
  fileMode?: number;
}): Promise<{ artifactPath: string; manifestPath: string; sha256: string; sizeBytes: number; filename: string; version?: string }> {
  const asset = input.asset ?? CONTROLLED_NODE_ARTIFACT_ASSETS.NODE;
  const response = await input.fetchImpl(controlledNodeArtifactUpgradeUrl(input.credential, input.target, asset), {
    headers: {
      Authorization: `Bearer ${input.credential.token}`,
      'X-Server-Id': input.credential.serverId,
      [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: String(REMOTE_DESKTOP_PROTOCOL_VERSION),
    },
  });
  if (!response.ok) throw new Error(`download_failed_${response.status}`);
  const expectedSha = readHeader(response.headers, CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256);
  const filename = readHeader(response.headers, CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME) || basename(defaultStagedExecutablePath());
  if (input.expectedFileName && basename(filename) !== input.expectedFileName) throw new Error('artifact_filename_mismatch');
  const sizeHeader = readHeader(response.headers, CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES);
  const versionHeader = readHeader(response.headers, CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION)?.trim();
  if (!expectedSha || !/^[0-9a-f]{64}$/i.test(expectedSha)) throw new Error('missing_artifact_sha256');
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  if (actualSha !== expectedSha.toLowerCase()) throw new Error('artifact_sha256_mismatch');
  const expectedSize = sizeHeader && /^\d+$/.test(sizeHeader) ? Number(sizeHeader) : bytes.length;
  if (!Number.isSafeInteger(expectedSize) || expectedSize !== bytes.length) throw new Error('artifact_size_mismatch');
  if (input.expectedVersion && versionHeader !== input.expectedVersion) throw new Error('artifact_version_mismatch');
  const artifactPath = join(input.dir, basename(filename));
  const manifestPath = `${artifactPath}.manifest.json`;
  const fileMode = input.fileMode ?? 0o755;
  await writeFile(artifactPath, bytes, { mode: fileMode });
  if (process.platform !== 'win32') await chmod(artifactPath, fileMode).catch(() => {});
  // Re-read what actually LANDED. The check above proves the download was
  // intact in memory, not that those bytes survived the write — and the manifest
  // below records `actualSha` as fact, so an unverified write lets a corrupted
  // artifact ship with a manifest that vouches for it.
  const landedSha = createHash('sha256').update(await readFile(artifactPath)).digest('hex');
  if (landedSha !== actualSha) throw new Error('artifact_write_sha256_mismatch');
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    artifact: {
      fileName: basename(filename),
      os: input.target.os === CONTROLLED_NODE_OS_MAC ? 'darwin' : input.target.os === CONTROLLED_NODE_OS_WIN ? 'win32' : input.target.os,
      arch: input.target.arch,
      size: bytes.length,
      sha256: actualSha,
    },
    build: {
      source: 'controlled-node-self-upgrade',
      ...(versionHeader ? { version: versionHeader } : {}),
    },
  }, null, 2)}\n`, { mode: 0o644 });
  return {
    artifactPath,
    manifestPath,
    sha256: actualSha,
    sizeBytes: bytes.length,
    filename: basename(filename),
    ...(versionHeader ? { version: versionHeader } : {}),
  };
}

function controlledNodePlatformArchKey(target: ControlledNodeArtifactTarget): string {
  const platform = target.os === CONTROLLED_NODE_OS_WIN
    ? 'win32'
    : target.os === CONTROLLED_NODE_OS_MAC
      ? 'darwin'
      : 'linux';
  return `${platform}-${target.arch}`;
}

export async function downloadControlledNodeComputerUseHelper(input: {
  credential: ControlledNodeCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
}): Promise<{ helperDir: string; artifactPath: string; sha256: string; sizeBytes: number } | undefined> {
  const helperDir = join(input.dir, 'computer-use-helper', controlledNodePlatformArchKey(input.target));
  await mkdir(helperDir, { recursive: true });
  try {
    const downloaded = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: helperDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER,
      expectedFileName: controlledNodeComputerUseHelperFilename(input.target.os),
      fileMode: input.target.os === CONTROLLED_NODE_OS_MAC ? 0o644 : 0o755,
    });
    return {
      helperDir,
      artifactPath: downloaded.artifactPath,
      sha256: downloaded.sha256,
      sizeBytes: downloaded.sizeBytes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^download_failed_(404|503)$/.test(message) || message === 'artifact_filename_mismatch') return undefined;
    throw error;
  }
}

export async function downloadControlledNodeRemoteDesktopWorker(input: {
  credential: ControlledNodeCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
}): Promise<{ workerDir: string; artifactPath: string; manifestPath: string; sha256: string } | undefined> {
  if (input.target.os !== CONTROLLED_NODE_OS_WIN || input.target.arch !== CONTROLLED_NODE_ARCH_X64) return undefined;
  const workerDir = join(input.dir, 'remote-desktop-worker', 'win32-x64');
  await mkdir(workerDir, { recursive: true });
  try {
    const executable = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: workerDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
      expectedFileName: REMOTE_DESKTOP_WORKER_FILENAME,
      fileMode: 0o755,
    });
    const manifestFilename = `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
    const manifestDownload = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: workerDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST,
      expectedFileName: manifestFilename,
      fileMode: 0o644,
    });
    const manifest = validateRemoteDesktopWorkerManifest(
      JSON.parse(await readFile(manifestDownload.artifactPath, 'utf8')),
    );
    if (!manifest
      || manifest.sha256 !== executable.sha256
      || manifest.size !== executable.sizeBytes
      || manifest.fileName !== executable.filename) {
      throw new Error('remote_desktop_worker_manifest_mismatch');
    }
    const virtualDisplay = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: workerDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY,
      expectedFileName: REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
      fileMode: 0o644,
    });
    if (virtualDisplay.sha256 !== manifest.virtualDisplay.sha256
      || virtualDisplay.sizeBytes !== manifest.virtualDisplay.size
      || virtualDisplay.filename !== manifest.virtualDisplay.archiveFileName) {
      throw new Error('remote_desktop_virtual_display_manifest_mismatch');
    }
    // downloadArtifact writes transport metadata next to every downloaded
    // asset. The virtual-display release manifest lives inside the signed ZIP,
    // so this generated sidecar is not part of the exact platform allowlist
    // consumed by the Windows upgrade script. Leaving it behind makes every
    // real downloaded upgrade fail closed before publication even though
    // hand-assembled qualification directories pass.
    await rm(virtualDisplay.manifestPath, { force: true });
    await rm(manifestDownload.manifestPath, { force: true });
    return {
      workerDir,
      artifactPath: executable.artifactPath,
      manifestPath: manifestDownload.artifactPath,
      sha256: executable.sha256,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The media sidecar is optional for a Node upgrade. A rolling protocol
    // mismatch must never prevent the signed main executable from upgrading to
    // the version that can speak the server's current protocol.
    if (/^download_failed_(404|409|503)$/.test(message) || message === 'artifact_filename_mismatch') return undefined;
    throw error;
  }
}

export function buildWindowsControlledNodeUpgradeScript(input: {
  stagedArtifactPath: string;
  stagedManifestPath: string;
  stagedComputerUseHelperDir?: string;
  stagedRemoteDesktopWorkerDir?: string;
  stagedJournalPath?: string;
  destinationPath: string;
  destinationManifestPath: string;
  destinationJournalPath?: string;
  upgradeTaskName?: string;
}): string {
  const checkedAclCommand = (entry: readonly string[], optional: boolean): string => {
    const [target, ...args] = entry;
    const invoke = `& (Join-Path $env:WINDIR 'System32\\icacls.exe') ${psQuote(target!)} ${args.map(psQuote).join(' ')}; $aclExitCode = $LASTEXITCODE; if ($aclExitCode -ne 0) { throw 'Windows ACL hardening failed' }`;
    return optional ? `if (Test-Path ${psQuote(target!)}) { ${invoke} }` : invoke;
  };
  const helperDir = pathWin32.join(
    pathWin32.dirname(input.destinationPath),
    'computer-use-helper',
  );
  const exeAcl = windowsExecutableFileAclCommands(input.destinationPath)
    .map((entry) => checkedAclCommand(entry, false))
    .join('\r\n');
  const helperAcl = windowsComputerUseHelperAclCommands(helperDir)
    .map((entry) => checkedAclCommand(entry, true))
    .join('\r\n');
  const remoteDesktopWorkerDir = pathWin32.join(
    pathWin32.dirname(input.destinationPath),
    'remote-desktop-worker',
  );
  const remoteDesktopWorkerExe = pathWin32.join(
    remoteDesktopWorkerDir,
    'win32-x64',
    REMOTE_DESKTOP_WORKER_FILENAME,
  );
  const remoteDesktopWorkerManifest = `${remoteDesktopWorkerExe}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
  const remoteDesktopWorkerAcl = [
    ...windowsExecutableFileAclCommands(remoteDesktopWorkerExe),
    ...windowsExecutableFileAclCommands(remoteDesktopWorkerManifest),
  ].map((entry) => checkedAclCommand(entry, true))
    .join('\r\n');
  const pendingRemoteDesktopAcl = windowsCredentialAclCommands(`${remoteDesktopWorkerDir}.new`)
    .map((entry) => checkedAclCommand(entry, false))
    .join('\r\n');
  const upgradeTaskCleanup = input.upgradeTaskName
    ? `Unregister-ScheduledTask -TaskName ${psQuote(input.upgradeTaskName)} -Confirm:$false -ErrorAction SilentlyContinue\r\n`
    : '';
  const powershellSecurityModulePreflight = `$securityModulePath = Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'\r\n`
    + `if (-not (Test-Path -LiteralPath $securityModulePath -PathType Leaf)) { throw 'Windows PowerShell security module was not found' }\r\n`
    + `Import-Module -Name $securityModulePath -ErrorAction Stop\r\n`;
  const releaseArtifactPreflight = `$trustedReleaseSigner = ${psQuote(WINDOWS_COMPILED_RELEASE_SIGNER_SHA256)}\r\n`
    + `if ($trustedReleaseSigner -cnotmatch '^[a-f0-9]{64}$') { throw 'controlled node build has no Windows release trust anchor' }\r\n`
    + `$verifyReleaseArtifact = { param([string]$path)\r\n`
    + `  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'signed Windows release artifact is missing' }\r\n`
    + `  $signature = Get-AuthenticodeSignature -LiteralPath $path; if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { throw 'Windows release artifact Authenticode verification failed' }\r\n`
    + `  $sha256 = [System.Security.Cryptography.SHA256]::Create(); try { $signer = [BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }; if ($signer -cne $trustedReleaseSigner) { throw 'Windows release artifact signer mismatch' }\r\n`
    + `}\r\n`
    + `& $verifyReleaseArtifact $src\r\n`
    + `if (-not (Test-Path -LiteralPath $srcManifest -PathType Leaf)) { throw 'controlled node release manifest is missing' }\r\n`
    + `$srcNodeManifest = Get-Content -LiteralPath $srcManifest -Raw | ConvertFrom-Json\r\n`
    + `$srcHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash.ToLowerInvariant()\r\n`
    + `if ([int]$srcNodeManifest.schemaVersion -ne 1 -or [string]$srcNodeManifest.artifact.fileName -cne 'imcodes-node.exe' -or [string]$srcNodeManifest.artifact.os -cne 'win32' -or [string]$srcNodeManifest.artifact.arch -cne 'x64' -or [int64]$srcNodeManifest.artifact.size -ne (Get-Item -LiteralPath $src).Length -or [string]$srcNodeManifest.artifact.sha256 -cne $srcHash -or [string]$srcNodeManifest.artifact.authenticodeSignerSha256 -cne $trustedReleaseSigner) { throw 'controlled node release manifest does not match the staged executable' }\r\n`
    + `$srcManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcManifest).Hash.ToLowerInvariant()\r\n`
    + (input.stagedComputerUseHelperDir
      ? `$srcHelper = ${psQuote(input.stagedComputerUseHelperDir)}\r\n`
        + `$srcHelperExe = Join-Path $srcHelper 'open-computer-use.exe'\r\n`
        + `& $verifyReleaseArtifact $srcHelperExe\r\n`
      : '');
  const remoteDesktopPreflight = input.stagedRemoteDesktopWorkerDir
    ? `$srcRemoteDesktop = ${psQuote(input.stagedRemoteDesktopWorkerDir)}\r\n`
      + `$srcRemoteDesktopPlatform = Join-Path $srcRemoteDesktop 'win32-x64'\r\n`
      + `$srcRemoteDesktopExe = Join-Path $srcRemoteDesktopPlatform ${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)}\r\n`
      + `$srcRemoteDesktopManifestPath = "$srcRemoteDesktopExe${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}"\r\n`
      + `if (-not (Test-Path -LiteralPath $srcRemoteDesktopExe) -or -not (Test-Path -LiteralPath $srcRemoteDesktopManifestPath)) { throw 'remote desktop worker artifact set is incomplete' }\r\n`
      + `$srcRemoteDesktopManifest = Get-Content -LiteralPath $srcRemoteDesktopManifestPath -Raw | ConvertFrom-Json\r\n`
      + `if ([int]$srcRemoteDesktopManifest.manifestVersion -ne 2 -or $srcRemoteDesktopManifest.fileName -ne ${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)} -or [int64]$srcRemoteDesktopManifest.size -ne (Get-Item -LiteralPath $srcRemoteDesktopExe).Length) { throw 'remote desktop worker manifest identity mismatch' }\r\n`
      + `$srcRemoteDesktopHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcRemoteDesktopExe).Hash.ToLowerInvariant()\r\n`
      + `if ($srcRemoteDesktopHash -ne [string]$srcRemoteDesktopManifest.sha256) { throw 'remote desktop worker hash verification failed' }\r\n`
      + `$srcRemoteDesktopSignature = Get-AuthenticodeSignature -LiteralPath $srcRemoteDesktopExe\r\n`
      + `if ($srcRemoteDesktopSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $srcRemoteDesktopSignature.SignerCertificate) { throw 'remote desktop worker Authenticode verification failed' }\r\n`
      + `$srcRemoteDesktopSha256Algorithm = [System.Security.Cryptography.SHA256]::Create()\r\n`
      + `try { $srcRemoteDesktopSignerSha256 = [BitConverter]::ToString($srcRemoteDesktopSha256Algorithm.ComputeHash($srcRemoteDesktopSignature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $srcRemoteDesktopSha256Algorithm.Dispose() }\r\n`
      + `if ($srcRemoteDesktopSignerSha256 -ne [string]$srcRemoteDesktopManifest.authenticodeSignerSha256) { throw 'remote desktop worker signer mismatch' }\r\n`
      + `if ($srcRemoteDesktopSignerSha256 -cne ${psQuote(WINDOWS_COMPILED_RELEASE_SIGNER_SHA256)}) { throw 'remote desktop worker signer is not trusted by this controlled node build' }\r\n`
      + `$srcVirtualDisplayArchive = Join-Path $srcRemoteDesktopPlatform ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME)}\r\n`
      + `if (-not (Test-Path -LiteralPath $srcVirtualDisplayArchive) -or [int64]$srcRemoteDesktopManifest.virtualDisplay.size -ne (Get-Item -LiteralPath $srcVirtualDisplayArchive).Length) { throw 'virtual display archive identity mismatch' }\r\n`
      + `$srcVirtualDisplayHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcVirtualDisplayArchive).Hash.ToLowerInvariant()\r\n`
      + `if ($srcVirtualDisplayHash -ne [string]$srcRemoteDesktopManifest.virtualDisplay.sha256) { throw 'virtual display archive hash verification failed' }\r\n`
      + `$srcVirtualDisplay = Join-Path $srcRemoteDesktopPlatform 'virtual-display'\r\n`
      + `Remove-Item -Recurse -Force $srcVirtualDisplay -ErrorAction SilentlyContinue\r\n`
      + `Expand-Archive -LiteralPath $srcVirtualDisplayArchive -DestinationPath $srcVirtualDisplay -Force\r\n`
      + `$srcVirtualDisplayManifestPath = Join-Path $srcVirtualDisplay ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME)}\r\n`
      + `if (-not (Test-Path -LiteralPath $srcVirtualDisplayManifestPath)) { throw 'virtual display package manifest missing' }\r\n`
      + `$srcVirtualDisplayManifest = Get-Content -LiteralPath $srcVirtualDisplayManifestPath -Raw | ConvertFrom-Json\r\n`
      + `if ([int]$srcVirtualDisplayManifest.manifestVersion -ne 1 -or [string]$srcVirtualDisplayManifest.hardwareId -ne 'ImcodesVirtualDisplay') { throw 'virtual display package identity mismatch' }\r\n`
      + `$expectedVirtualDisplayFiles = @('imcodes-virtual-display.dll','imcodes-virtual-display.inf','imcodes-virtual-display.cat','LICENSE.microsoft.txt','THIRD_PARTY_NOTICES.webrtc.md')\r\n`
      + `if (@($srcVirtualDisplayManifest.files).Count -ne $expectedVirtualDisplayFiles.Count) { throw 'virtual display package file count mismatch' }\r\n`
      + `foreach ($expectedVirtualDisplayFile in $expectedVirtualDisplayFiles) { $entry = @($srcVirtualDisplayManifest.files | Where-Object { [string]$_.name -ceq $expectedVirtualDisplayFile }); if ($entry.Count -ne 1) { throw 'virtual display package file identity mismatch' }; $path = Join-Path $srcVirtualDisplay $expectedVirtualDisplayFile; if (-not (Test-Path -LiteralPath $path) -or [int64]$entry[0].size -ne (Get-Item -LiteralPath $path).Length -or [string]$entry[0].sha256 -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()) { throw 'virtual display package file verification failed' } }\r\n`
      + `foreach ($signedVirtualDisplayFile in @('imcodes-virtual-display.dll','imcodes-virtual-display.cat')) { $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $srcVirtualDisplay $signedVirtualDisplayFile); if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { throw 'virtual display Authenticode verification failed' }; $sha256Algorithm = [System.Security.Cryptography.SHA256]::Create(); try { $signerSha256 = [BitConverter]::ToString($sha256Algorithm.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $sha256Algorithm.Dispose() }; if ($signerSha256 -ne $srcRemoteDesktopSignerSha256) { throw 'virtual display signer mismatch' } }\r\n`
      + `$srcRemoteDesktopManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcRemoteDesktopManifestPath).Hash.ToLowerInvariant()\r\n`
      + `$verifyRemoteDesktopArtifactSet = { param([string]$root,[string]$workerHash,[string]$manifestHash,[string]$archiveHash,[string]$trustedSigner)\r\n`
      + `  $rootEntries = @(Get-ChildItem -LiteralPath $root -Force); if ($rootEntries.Count -ne 1 -or $rootEntries[0].Name -cne 'win32-x64' -or -not $rootEntries[0].PSIsContainer -or ($rootEntries[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'remote desktop artifact root contains unexpected entries' }\r\n`
      + `  $platform = Join-Path $root 'win32-x64'; $exe = Join-Path $platform ${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)}; $manifestPath = "$exe${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}"; $archive = Join-Path $platform ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME)}; $virtualDisplay = Join-Path $platform 'virtual-display'\r\n`
      + `  $platformEntries = @(Get-ChildItem -LiteralPath $platform -Force); $expectedPlatformEntries = @(${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)},${psQuote(`${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`)},${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME)},'virtual-display'); if ($platformEntries.Count -ne $expectedPlatformEntries.Count) { throw 'remote desktop platform directory contains unexpected entries' }; foreach ($expected in $expectedPlatformEntries) { if (@($platformEntries | Where-Object { $_.Name -ceq $expected }).Count -ne 1) { throw 'remote desktop platform entry mismatch' } }\r\n`
      + `  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant() -cne $workerHash -or (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant() -cne $manifestHash -or (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -cne $archiveHash) { throw 'remote desktop copied artifact hash mismatch' }\r\n`
      + `  $workerSignature = Get-AuthenticodeSignature -LiteralPath $exe; if ($workerSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $workerSignature.SignerCertificate) { throw 'remote desktop copied worker Authenticode verification failed' }; $workerSha256 = [System.Security.Cryptography.SHA256]::Create(); try { $workerSigner = [BitConverter]::ToString($workerSha256.ComputeHash($workerSignature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $workerSha256.Dispose() }; if ($workerSigner -cne $trustedSigner) { throw 'remote desktop copied worker signer mismatch' }\r\n`
      + `  $packageManifestPath = Join-Path $virtualDisplay ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME)}; $packageManifest = Get-Content -LiteralPath $packageManifestPath -Raw | ConvertFrom-Json; if ([int]$packageManifest.manifestVersion -ne 1 -or [string]$packageManifest.hardwareId -cne 'ImcodesVirtualDisplay') { throw 'virtual display copied package identity mismatch' }; $expectedFiles = @('imcodes-virtual-display.dll','imcodes-virtual-display.inf','imcodes-virtual-display.cat','LICENSE.microsoft.txt','THIRD_PARTY_NOTICES.webrtc.md'); if (@($packageManifest.files).Count -ne $expectedFiles.Count) { throw 'virtual display copied package manifest count mismatch' }; $packageEntries = @(Get-ChildItem -LiteralPath $virtualDisplay -Force); if ($packageEntries.Count -ne ($expectedFiles.Count + 1)) { throw 'virtual display package contains unexpected entries' }; foreach ($expected in @($expectedFiles + ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME)})) { $actual = @($packageEntries | Where-Object { $_.Name -ceq $expected }); if ($actual.Count -ne 1 -or $actual[0].PSIsContainer -or ($actual[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'virtual display copied package entry mismatch' } }\r\n`
      + `  foreach ($expected in $expectedFiles) { $entry = @($packageManifest.files | Where-Object { [string]$_.name -ceq $expected }); $path = Join-Path $virtualDisplay $expected; if ($entry.Count -ne 1 -or [int64]$entry[0].size -ne (Get-Item -LiteralPath $path).Length -or [string]$entry[0].sha256 -cne (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()) { throw 'virtual display copied package file verification failed' } }\r\n`
      + `  foreach ($signed in @('imcodes-virtual-display.dll','imcodes-virtual-display.cat')) { $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $virtualDisplay $signed); if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) { throw 'virtual display copied Authenticode verification failed' }; $sha256 = [System.Security.Cryptography.SHA256]::Create(); try { $signer = [BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() } finally { $sha256.Dispose() }; if ($signer -cne $trustedSigner) { throw 'virtual display copied signer mismatch' } }\r\n`
      + `}\r\n`
      + `& $verifyRemoteDesktopArtifactSet $srcRemoteDesktop $srcRemoteDesktopHash $srcRemoteDesktopManifestHash $srcVirtualDisplayHash $srcRemoteDesktopSignerSha256\r\n`
    : '';
  const helperVariables = input.stagedComputerUseHelperDir
    ? `$dstHelper = ${psQuote(helperDir)}\r\n`
      + `$pendingHelper = "$dstHelper.new"\r\n`
      + `$backupHelper = "$dstHelper.upgrade-old"\r\n`
      + `$dstHelperExe = Join-Path $dstHelper 'open-computer-use.exe'\r\n`
      + `$dstHelperManifest = "$dstHelperExe.manifest.json"\r\n`
      + `$currentHelperHash = ''\r\n`
      + `$currentHelperManifestHash = ''\r\n`
    : '';
  const verifyRollbackHelper = input.stagedComputerUseHelperDir
    ? `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dstHelperExe).Hash.ToLowerInvariant() -cne $currentHelperHash) { throw 'computer-use helper rollback hash mismatch' }; if ($currentHelperManifestHash -and (Get-FileHash -Algorithm SHA256 -LiteralPath $dstHelperManifest).Hash.ToLowerInvariant() -cne $currentHelperManifestHash) { throw 'computer-use helper manifest rollback hash mismatch' }`
    : '';
  const helperSwap = input.stagedComputerUseHelperDir
    ? `Remove-Item -Recurse -Force $pendingHelper,$backupHelper -ErrorAction SilentlyContinue\r\n`
      + `New-Item -ItemType Directory -Force $pendingHelper | Out-Null\r\n`
      + `Copy-Item -Recurse -Force -Path (Join-Path $srcHelper '*') -Destination $pendingHelper\r\n`
      + `& $verifyReleaseArtifact (Join-Path $pendingHelper 'open-computer-use.exe')\r\n`
      + `if (Test-Path $dstHelper) { ${verifyRollbackHelper}; Move-Item -Force $dstHelper $backupHelper; $dstHelperExe = Join-Path $backupHelper 'open-computer-use.exe'; $dstHelperManifest = "$dstHelperExe.manifest.json"; ${verifyRollbackHelper}; $dstHelperExe = Join-Path $dstHelper 'open-computer-use.exe'; $dstHelperManifest = "$dstHelperExe.manifest.json"; $helperBackedUp = $true }\r\n`
      + `Move-Item -Force $pendingHelper $dstHelper\r\n`
      + `$helperPublished = $true\r\n`
      + `& $verifyReleaseArtifact (Join-Path $dstHelper 'open-computer-use.exe')\r\n`
    : '';
  const helperRollback = input.stagedComputerUseHelperDir
    ? `if ($helperPublished -and (Test-Path $dstHelper)) { Remove-Item -Recurse -Force $dstHelper }\r\n`
      + `if ($helperBackedUp -and (Test-Path $backupHelper)) { $dstHelperExe = Join-Path $backupHelper 'open-computer-use.exe'; $dstHelperManifest = "$dstHelperExe.manifest.json"; ${verifyRollbackHelper}; Move-Item -Force $backupHelper $dstHelper; $dstHelperExe = Join-Path $dstHelper 'open-computer-use.exe'; $dstHelperManifest = "$dstHelperExe.manifest.json"; ${verifyRollbackHelper} }\r\n`
      + `Remove-Item -Recurse -Force $pendingHelper -ErrorAction SilentlyContinue\r\n`
    : '';
  const helperCleanup = input.stagedComputerUseHelperDir
    ? `Remove-Item -Recurse -Force $backupHelper,$pendingHelper -ErrorAction SilentlyContinue\r\n`
    : '';
  const remoteDesktopVariables = input.stagedRemoteDesktopWorkerDir
    ? `$dstRemoteDesktop = ${psQuote(remoteDesktopWorkerDir)}\r\n`
      + `$pendingRemoteDesktop = "$dstRemoteDesktop.new"\r\n`
      + `$backupRemoteDesktop = "$dstRemoteDesktop.upgrade-old"\r\n`
      + `$rollbackRemoteDesktopWorkerHash = ''\r\n`
      + `$rollbackRemoteDesktopManifestHash = ''\r\n`
      + `$rollbackRemoteDesktopArchiveHash = ''\r\n`
    : '';
  const remoteDesktopSwap = input.stagedRemoteDesktopWorkerDir
    ? `Remove-Item -Recurse -Force $pendingRemoteDesktop,$backupRemoteDesktop -ErrorAction SilentlyContinue\r\n`
      + `New-Item -ItemType Directory -Force $pendingRemoteDesktop | Out-Null\r\n`
      + pendingRemoteDesktopAcl + `\r\n`
      + `Copy-Item -Recurse -Force -Path (Join-Path $srcRemoteDesktop '*') -Destination $pendingRemoteDesktop\r\n`
      + `& $verifyRemoteDesktopArtifactSet $pendingRemoteDesktop $srcRemoteDesktopHash $srcRemoteDesktopManifestHash $srcVirtualDisplayHash $srcRemoteDesktopSignerSha256\r\n`
      + `if (Test-Path $dstRemoteDesktop) { & $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner; Move-Item -Force $dstRemoteDesktop $backupRemoteDesktop; & $verifyRemoteDesktopArtifactSet $backupRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner; $remoteDesktopBackedUp = $true }\r\n`
      + `Move-Item -Force $pendingRemoteDesktop $dstRemoteDesktop\r\n`
      + `$remoteDesktopPublished = $true\r\n`
    : '';
  const remoteDesktopRollback = input.stagedRemoteDesktopWorkerDir
    ? `if ($remoteDesktopPublished -and (Test-Path $dstRemoteDesktop)) { Remove-Item -Recurse -Force $dstRemoteDesktop }\r\n`
      + `if ($remoteDesktopBackedUp -and (Test-Path $backupRemoteDesktop)) { & $verifyRemoteDesktopArtifactSet $backupRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner; Move-Item -Force $backupRemoteDesktop $dstRemoteDesktop; & $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner }\r\n`
      + `Remove-Item -Recurse -Force $pendingRemoteDesktop -ErrorAction SilentlyContinue\r\n`
    : '';
  const remoteDesktopCleanup = input.stagedRemoteDesktopWorkerDir
    ? `Remove-Item -Recurse -Force $backupRemoteDesktop,$pendingRemoteDesktop -ErrorAction SilentlyContinue\r\n`
    : '';
  const virtualDisplayDriverInventory = input.stagedRemoteDesktopWorkerDir
    ? `$driverInventoryAvailable = $false\r\n`
      + `$previousVirtualDisplayDrivers = @()\r\n`
      + `$newVirtualDisplayDrivers = @()\r\n`
      + `try { $previousVirtualDisplayDrivers = @(Get-WindowsDriver -Online -All | Where-Object { [IO.Path]::GetFileName([string]$_.OriginalFileName) -ceq 'imcodes-virtual-display.inf' -and [string]$_.ProviderName -ceq 'IM.codes' -and [string]$_.ClassName -ceq 'Display' }); $driverInventoryAvailable = $true } catch { $driverInventoryAvailable = $false }\r\n`
    : '';
  const installedArtifactPreflight = `$currentMainHash = ''\r\n`
    + `$currentManifestHash = ''\r\n`
    + `if (-not (Test-Path -LiteralPath $dst -PathType Leaf)) { throw 'installed controlled node executable is missing' }\r\n`
    + `$currentMainHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash.ToLowerInvariant()\r\n`
    + `if (Test-Path -LiteralPath $dstManifest) { $currentManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dstManifest).Hash.ToLowerInvariant() }\r\n`
    + (input.stagedComputerUseHelperDir
      ? `if ((Test-Path -LiteralPath $dstHelper) -and -not (Test-Path -LiteralPath $dstHelperExe -PathType Leaf)) { throw 'installed computer-use helper directory is incomplete' }; if (Test-Path -LiteralPath $dstHelperExe) { $currentHelperHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dstHelperExe).Hash.ToLowerInvariant(); if (Test-Path -LiteralPath $dstHelperManifest) { $currentHelperManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dstHelperManifest).Hash.ToLowerInvariant() } }\r\n`
      : '')
    + (input.stagedRemoteDesktopWorkerDir
      ? `if (Test-Path -LiteralPath $dstRemoteDesktop) { $rollbackRemoteDesktopPlatform = Join-Path $dstRemoteDesktop 'win32-x64'; $rollbackRemoteDesktopExe = Join-Path $rollbackRemoteDesktopPlatform ${psQuote(REMOTE_DESKTOP_WORKER_FILENAME)}; $rollbackRemoteDesktopManifest = "$rollbackRemoteDesktopExe${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}"; $rollbackRemoteDesktopArchive = Join-Path $rollbackRemoteDesktopPlatform ${psQuote(REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME)}; $rollbackRemoteDesktopWorkerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $rollbackRemoteDesktopExe).Hash.ToLowerInvariant(); $rollbackRemoteDesktopManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $rollbackRemoteDesktopManifest).Hash.ToLowerInvariant(); $rollbackRemoteDesktopArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $rollbackRemoteDesktopArchive).Hash.ToLowerInvariant(); & $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner }\r\n`
      : '');
  const releasePreflightGuard = `try {\r\n`
      + powershellSecurityModulePreflight
      + releaseArtifactPreflight
      + remoteDesktopPreflight
      + installedArtifactPreflight
      + virtualDisplayDriverInventory
      + `} catch {\r\n`
      + `$failureMessage = [string]$_.Exception.Message\r\n`
      + `if ($failureMessage.Length -gt 240) { $failureMessage = $failureMessage.Substring(0, 240) }\r\n`
      + `try { @{ status = 'preflight_failed'; reason = $failureMessage; completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $upgradeResult -Encoding utf8 } catch { }\r\n`
      + upgradeTaskCleanup
      + `throw\r\n`
      + `}\r\n`
  ;
  const journalVariables = input.stagedJournalPath && input.destinationJournalPath
    ? `$dstJournal = ${psQuote(input.destinationJournalPath)}\r\n`
      + `$srcJournal = ${psQuote(input.stagedJournalPath)}\r\n`
      + `$backupJournal = "$dstJournal.upgrade-old"\r\n`
    : '';
  const journalPublish = input.stagedJournalPath && input.destinationJournalPath
    ? `Remove-Item -Force $backupJournal -ErrorAction SilentlyContinue\r\n`
      + `if (Test-Path $dstJournal) { Copy-Item -Force $dstJournal $backupJournal; $journalBackedUp = $true }\r\n`
      + `if (Test-Path $srcJournal) { Copy-Item -Force $srcJournal $dstJournal; $journalPublished = $true }\r\n`
    : '';
  const journalRollback = input.stagedJournalPath && input.destinationJournalPath
    ? `if ($journalBackedUp -and (Test-Path $backupJournal)) { Copy-Item -Force $backupJournal $dstJournal } elseif ($journalPublished) { Remove-Item -Force $dstJournal -ErrorAction SilentlyContinue }\r\n`
    : '';
  const journalCleanup = input.stagedJournalPath && input.destinationJournalPath
    ? `Remove-Item -Force $backupJournal -ErrorAction SilentlyContinue\r\n`
    : '';
  return `$ErrorActionPreference = 'Stop'\r\n`
    + `Start-Sleep -Seconds 3\r\n`
    + `$task = ${psQuote(CONTROLLED_NODE_SERVICE.WINDOWS_TASK)}\r\n`
    + `$dst = ${psQuote(input.destinationPath)}\r\n`
    + `$src = ${psQuote(input.stagedArtifactPath)}\r\n`
    + `$dstManifest = ${psQuote(input.destinationManifestPath)}\r\n`
    + `$srcManifest = ${psQuote(input.stagedManifestPath)}\r\n`
    + `$upgradeResult = "$src.upgrade-result.json"\r\n`
    + `Remove-Item -Force $upgradeResult -ErrorAction SilentlyContinue\r\n`
    + `$healthLease = Join-Path (Split-Path -Parent $dst) 'health-lease.json'\r\n`
    + `$upgradeMarker = Join-Path (Split-Path -Parent $dst) ${psQuote(WINDOWS_UPGRADE_MARKER_NAME)}\r\n`
    + `$backupDst = "$dst.upgrade-old"\r\n`
    + `$backupManifest = "$dstManifest.upgrade-old"\r\n`
    + `$mainBackedUp = $false\r\n`
    + `$mainPublished = $false\r\n`
    + `$manifestBackedUp = $false\r\n`
    + `$manifestPublished = $false\r\n`
    + `$helperBackedUp = $false\r\n`
    + `$helperPublished = $false\r\n`
    + `$remoteDesktopBackedUp = $false\r\n`
    + `$remoteDesktopPublished = $false\r\n`
    + `$virtualDisplayDriverInstalled = $false\r\n`
    + `$journalBackedUp = $false\r\n`
    + `$journalPublished = $false\r\n`
    + `$healthy = $false\r\n`
    + helperVariables
    + remoteDesktopVariables
    + journalVariables
    + `$recoveryFailures = [System.Collections.Generic.List[string]]::new()\r\n`
    + `$runRecovery = { param([string]$label,[scriptblock]$action) try { & $action } catch { [void]$recoveryFailures.Add(('{0}: {1}' -f $label, [string]$_.Exception.Message)) } }\r\n`
    + releasePreflightGuard
    + `try {\r\n`
    + `@{ version = 1; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $upgradeMarker -Encoding utf8\r\n`
    + `Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue\r\n`
    + `Start-Sleep -Seconds 2\r\n`
    + `Get-CimInstance Win32_Process -Filter 'name="imcodes-node.exe"' | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $dst, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\r\n`
    + `Start-Sleep -Seconds 1\r\n`
    + `Remove-Item -Force $backupDst,$backupManifest -ErrorAction SilentlyContinue\r\n`
    + `if (Test-Path $dst) { Copy-Item -Force $dst $backupDst; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupDst).Hash.ToLowerInvariant() -cne $currentMainHash) { throw 'controlled node backup hash mismatch' }; $mainBackedUp = $true }\r\n`
    + `if (Test-Path $dstManifest) { Copy-Item -Force $dstManifest $backupManifest; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupManifest).Hash.ToLowerInvariant() -cne $currentManifestHash) { throw 'controlled node manifest backup hash mismatch' }; $manifestBackedUp = $true }\r\n`
    + `Copy-Item -Force $src $dst\r\n`
    + `$mainPublished = $true\r\n`
    + `& $verifyReleaseArtifact $dst\r\n`
    + `Copy-Item -Force $srcManifest $dstManifest\r\n`
    + `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dstManifest).Hash.ToLowerInvariant() -cne $srcManifestHash) { throw 'controlled node published manifest hash mismatch' }\r\n`
    + `$manifestPublished = $true\r\n`
    + helperSwap
    + remoteDesktopSwap
    + journalPublish
    + exeAcl + `\r\n`
    + helperAcl + `\r\n`
    + remoteDesktopWorkerAcl + `\r\n`
    + (input.stagedRemoteDesktopWorkerDir
      ? `& $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $srcRemoteDesktopHash $srcRemoteDesktopManifestHash $srcVirtualDisplayHash $srcRemoteDesktopSignerSha256\r\n`
        + `$virtualDisplayInf = Join-Path (Join-Path (Join-Path $dstRemoteDesktop 'win32-x64') 'virtual-display') 'imcodes-virtual-display.inf'\r\n`
        + `& (Join-Path $env:WINDIR 'System32\\pnputil.exe') /add-driver $virtualDisplayInf /install\r\n`
        + `$driverInstallExitCode = $LASTEXITCODE\r\n`
        + `if ($driverInstallExitCode -ne 0 -and $driverInstallExitCode -ne 3010) { throw 'virtual display driver installation failed' }\r\n`
        + `if ($driverInventoryAvailable) { try { $currentVirtualDisplayDrivers = @(Get-WindowsDriver -Online -All | Where-Object { [IO.Path]::GetFileName([string]$_.OriginalFileName) -ceq 'imcodes-virtual-display.inf' -and [string]$_.ProviderName -ceq 'IM.codes' -and [string]$_.ClassName -ceq 'Display' }); $newVirtualDisplayDrivers = @($currentVirtualDisplayDrivers | Where-Object { $previousVirtualDisplayDrivers.Driver -cnotcontains $_.Driver }); if ($newVirtualDisplayDrivers.Count -gt 1) { $newVirtualDisplayDrivers = @(); $driverInventoryAvailable = $false } } catch { $newVirtualDisplayDrivers = @(); $driverInventoryAvailable = $false } }\r\n`
        + `$virtualDisplayDriverInstalled = $newVirtualDisplayDrivers.Count -eq 1\r\n`
      : '')
    + `Remove-Item -Force $healthLease -ErrorAction SilentlyContinue\r\n`
    + `$upgradeStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()\r\n`
    + `Start-ScheduledTask -TaskName $task\r\n`
    + `for ($attempt = 0; $attempt -lt 60 -and -not $healthy; $attempt++) {\r\n`
    + `  Start-Sleep -Seconds 2\r\n`
    + `  try {\r\n`
    + `    $lease = Get-Content -LiteralPath $healthLease -Raw | ConvertFrom-Json\r\n`
    + `    if ([int64]$lease.updatedAt -ge $upgradeStartedAt -and [int]$lease.pid -gt 0) {\r\n`
    + `      $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$lease.pid) -ErrorAction SilentlyContinue\r\n`
    + `      $healthy = $process -and $process.ExecutablePath -and [string]::Equals($process.ExecutablePath, $dst, [StringComparison]::OrdinalIgnoreCase)\r\n`
    + `    }\r\n`
    + `  } catch { $healthy = $false }\r\n`
    + `}\r\n`
    + `if (-not $healthy) { throw 'controlled node upgrade failed authenticated health verification' }\r\n`
    + `Remove-Item -Force $backupDst,$backupManifest -ErrorAction SilentlyContinue\r\n`
    + helperCleanup
    + remoteDesktopCleanup
    + journalCleanup
    + `@{ status = 'success'; completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $upgradeResult -Encoding utf8\r\n`
    + `} catch {\r\n`
    + `$failureMessage = [string]$_.Exception.Message\r\n`
    + `if ($failureMessage.Length -gt 240) { $failureMessage = $failureMessage.Substring(0, 240) }\r\n`
    + `try { @{ status = 'rollback_started'; reason = $failureMessage; recordedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $upgradeResult -Encoding utf8 } catch { }\r\n`
    + `& $runRecovery 'stop_new_node' { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter 'name="imcodes-node.exe"' | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $dst, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 1 }\r\n`
    + `& $runRecovery 'restore_main' { if ($mainBackedUp -and (Test-Path $backupDst)) { if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupDst).Hash.ToLowerInvariant() -cne $currentMainHash) { throw 'controlled node rollback source hash mismatch' }; Copy-Item -Force $backupDst $dst; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash.ToLowerInvariant() -cne $currentMainHash) { throw 'controlled node restored hash mismatch' } } elseif ($mainPublished) { Remove-Item -Force $dst -ErrorAction Stop } }\r\n`
    + `& $runRecovery 'restore_manifest' { if ($manifestBackedUp -and (Test-Path $backupManifest)) { if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupManifest).Hash.ToLowerInvariant() -cne $currentManifestHash) { throw 'controlled node manifest rollback source hash mismatch' }; Copy-Item -Force $backupManifest $dstManifest; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dstManifest).Hash.ToLowerInvariant() -cne $currentManifestHash) { throw 'controlled node restored manifest hash mismatch' } } elseif ($manifestPublished) { Remove-Item -Force $dstManifest -ErrorAction Stop } }\r\n`
    + (helperRollback ? `& $runRecovery 'restore_helper' { ${helperRollback.replaceAll('\r\n', '; ')} }\r\n` : '')
    + (remoteDesktopRollback ? `& $runRecovery 'restore_remote_desktop' { ${remoteDesktopRollback.replaceAll('\r\n', '; ')} }\r\n` : '')
    + (input.stagedRemoteDesktopWorkerDir
      ? `& $runRecovery 'remove_new_driver' { if ($virtualDisplayDriverInstalled) { foreach ($newVirtualDisplayDriver in $newVirtualDisplayDrivers) { if ([string]$newVirtualDisplayDriver.Driver -cmatch '^oem[0-9]+\\.inf$') { & (Join-Path $env:WINDIR 'System32\\pnputil.exe') /delete-driver ([string]$newVirtualDisplayDriver.Driver) /uninstall /force | Out-Null; $driverRemoveExitCode = $LASTEXITCODE; if ($driverRemoveExitCode -ne 0 -and $driverRemoveExitCode -ne 3010) { throw 'virtual display driver rollback removal failed' } } } } }\r\n`
        + `& $runRecovery 'restore_driver' { if ($remoteDesktopBackedUp -and (Test-Path -LiteralPath $dstRemoteDesktop)) { & $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash $rollbackRemoteDesktopManifestHash $rollbackRemoteDesktopArchiveHash $trustedReleaseSigner; $rollbackVirtualDisplayInf = Join-Path (Join-Path (Join-Path $dstRemoteDesktop 'win32-x64') 'virtual-display') 'imcodes-virtual-display.inf'; & (Join-Path $env:WINDIR 'System32\\pnputil.exe') /add-driver $rollbackVirtualDisplayInf /install | Out-Null; $driverRollbackExitCode = $LASTEXITCODE; if ($driverRollbackExitCode -ne 0 -and $driverRollbackExitCode -ne 3010) { throw 'virtual display driver rollback installation failed' } } }\r\n`
      : '')
    + (journalRollback ? `& $runRecovery 'restore_journal' { ${journalRollback.replaceAll('\r\n', '; ')} }\r\n` : '')
    + `$rollbackStatus = if ($recoveryFailures.Count -eq 0) { 'rolled_back' } else { 'rollback_failed' }\r\n`
    + `try { @{ status = $rollbackStatus; reason = $failureMessage; recoveryFailures = @($recoveryFailures); completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $upgradeResult -Encoding utf8 } catch { }\r\n`
    + `throw\r\n`
    + `} finally {\r\n`
    + `Remove-Item -Force -LiteralPath $upgradeMarker -ErrorAction SilentlyContinue\r\n`
    + `Start-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue\r\n`
    + upgradeTaskCleanup
    + `}\r\n`;
}

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Run the replacement from a separate Task Scheduler job. A child PowerShell
 * spawned by the main scheduled task remains in that task's Windows job and is
 * killed when it stops the parent task, before it can replace the locked EXE.
 */
export function windowsControlledNodeUpgradeTaskXml(scriptPath: string): string {
  const argumentsText = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const powershellPath = windowsPowerShellExecutablePath();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>IM.codes controlled node one-shot upgrade</Description></RegistrationInfo>
  <Triggers />
  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="System"><Exec><Command>${escapeXmlText(powershellPath)}</Command><Arguments>${escapeXmlText(argumentsText)}</Arguments></Exec></Actions>
</Task>
`;
}

export function buildPosixControlledNodeUpgradeScript(input: {
  platform: 'darwin' | 'linux';
  stagedArtifactPath: string;
  stagedManifestPath: string;
  stagedComputerUseHelperDir?: string;
  stagedJournalPath?: string;
  destinationPath: string;
  destinationManifestPath: string;
  destinationJournalPath?: string;
}): string {
  const journalCopy = input.stagedJournalPath && input.destinationJournalPath
    ? `cp -f ${shQuote(input.stagedJournalPath)} ${shQuote(input.destinationJournalPath)} 2>/dev/null || true\n`
    : '';
  const helperDir = join(dirname(input.destinationPath), 'computer-use-helper');
  const helperPermissions = input.platform === 'darwin'
    ? `find ${shQuote(helperDir)} -type f -name 'open-computer-use.app.zip' -exec chmod 644 {} \\; 2>/dev/null || true\n`
    : `find ${shQuote(helperDir)} -type f -name 'open-computer-use' -exec chmod 755 {} \\; 2>/dev/null || true\n`;
  const helperCopy = input.stagedComputerUseHelperDir
    ? `rm -rf ${shQuote(helperDir)}\nmkdir -p ${shQuote(helperDir)}\ncp -R ${shQuote(`${input.stagedComputerUseHelperDir}/.`)} ${shQuote(helperDir)}/ 2>/dev/null || true\n${helperPermissions}`
    : '';
  // Publish the new executable through a temp file + rename(2), NEVER `cp -f`
  // straight onto the destination.
  //
  // `cp -f` rewrites the EXISTING inode in place. macOS binds code-signing state
  // to that inode, and the outgoing node's image may still be mapped, so an
  // in-place overwrite leaves a file whose bytes no longer match the signature
  // the kernel validated: every later exec is SIGKILLed with
  // OS_REASON_CODESIGNING and launchd respawns it forever — a bricked node with
  // no rollback (observed: 340 respawns, on-disk sha256 diverged from the
  // manifest the upgrade had just verified). Linux fails the same write with
  // ETXTBSY, which `set +e` then swallows into a silently skipped upgrade.
  //
  // rename(2) publishes a NEW inode atomically: the running image is untouched,
  // and the landed file keeps the exact bytes (and signature) that were verified.
  // It also makes rollback free — every check below runs BEFORE the rename, so
  // any failure leaves the previous working binary in place and we simply
  // restart it.
  const pending = `${input.destinationPath}.new`;
  // Fail-closed: refuse to publish a Mach-O the kernel would SIGKILL on exec.
  // Scoped to actual Mach-O files because `codesign` is meaningless for anything
  // else — on arm64 macOS every executable must carry at least an ad-hoc
  // signature, so a Mach-O that fails this check is guaranteed to be unbootable.
  const verify = input.platform === 'darwin'
    ? `if file -b ${shQuote(pending)} 2>/dev/null | grep -q 'Mach-O'; then\n`
      + `  codesign --verify ${shQuote(pending)} 2>/dev/null || { rm -f ${shQuote(pending)}; SKIP=1; }\n`
      + `fi\n`
    : '';
  const copy = `SKIP=0\n`
    + `cp -f ${shQuote(input.stagedArtifactPath)} ${shQuote(pending)} || SKIP=1\n`
    + `chmod 755 ${shQuote(pending)} 2>/dev/null || true\n`
    + verify
    + `if [ "$SKIP" = "0" ]; then\n`
    + `  mv -f ${shQuote(pending)} ${shQuote(input.destinationPath)} || SKIP=1\n`
    + `fi\n`
    + `if [ "$SKIP" = "0" ]; then\n`
    + `  cp -f ${shQuote(input.stagedManifestPath)} ${shQuote(input.destinationManifestPath)} 2>/dev/null || true\n`
    + `${helperCopy}${journalCopy}`.split('\n').filter(Boolean).map((line) => `  ${line}`).join('\n')
    + (helperCopy || journalCopy ? '\n' : '')
    + `fi\n`
    + `rm -f ${shQuote(pending)} 2>/dev/null || true\n`;
  if (input.platform === 'linux') {
    return `#!/bin/sh\nset +e\nsleep 3\nsystemctl stop ${CONTROLLED_NODE_SERVICE.LINUX_UNIT}\n${copy}systemctl start ${CONTROLLED_NODE_SERVICE.LINUX_UNIT}\n`;
  }
  return `#!/bin/sh\nset +e\nlaunchctl bootout system/${CONTROLLED_NODE_SERVICE.MACOS_WATCHDOG_LABEL}\nsleep 3\nlaunchctl bootout system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}\n${copy}launchctl bootstrap system ${shQuote(MACOS_PLIST_PATH)}\nlaunchctl kickstart -k system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}\nlaunchctl bootstrap system ${shQuote(MACOS_WATCHDOG_PLIST_PATH)}\n`;
}

async function prepareUpgradeJournal(input: {
  currentJournalPath: string;
  outputJournalPath: string;
  destinationPath: string;
  stagedArtifactPath: string;
  artifactSha256: string;
  artifactSizeBytes: number;
  now: number;
}): Promise<string | undefined> {
  const journal = await loadInstallJournal(input.currentJournalPath);
  if (journal.phase === 'uninstalled') return undefined;
  const staged = await stat(input.stagedArtifactPath);
  const identity = {
    size: staged.size,
    mtimeMs: staged.mtimeMs,
    ctimeMs: staged.ctimeMs,
  };
  const next = {
    ...journal,
    version: INSTALL_JOURNAL_VERSION,
    updatedAt: input.now,
    stagedExePath: input.destinationPath,
    stagedReceipt: {
      path: input.destinationPath,
      size: input.artifactSizeBytes,
      sha256: input.artifactSha256,
      sourceIdentity: identity,
      stagedIdentity: identity,
    },
  };
  await writeFile(input.outputJournalPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return input.outputJournalPath;
}

function defaultSpawnDetached(file: string, args: readonly string[], options: { windowsHide?: boolean }): void {
  const child = spawn(file, [...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: options.windowsHide,
  });
  child.unref();
}

export function scheduleWindowsControlledNodeUpgrade(
  taskName: string,
  taskXmlPath: string,
  runCommand: (file: string, args: readonly string[]) => void = (file, args) => {
    execFileSync(file, [...args], { windowsHide: true, stdio: 'ignore' });
  },
): void {
  runCommand('schtasks.exe', ['/Create', '/TN', taskName, '/XML', taskXmlPath, '/F']);
  try {
    runCommand('schtasks.exe', ['/Run', '/TN', taskName]);
  } catch (error) {
    try {
      runCommand('schtasks.exe', ['/Delete', '/TN', taskName, '/F']);
    } catch {
      // Preserve the authoritative /Run failure; the triggerless task is inert.
    }
    throw error;
  }
}

/**
 * Run Linux replacement outside imcodes-node.service's cgroup. A detached
 * child remains owned by the service and is killed by `systemctl stop` before
 * it can copy the new executable or restart the unit.
 */
export function scheduleLinuxControlledNodeUpgrade(
  unitName: string,
  scriptPath: string,
  runCommand: (file: string, args: readonly string[]) => void = (file, args) => {
    execFileSync(file, [...args], { stdio: 'ignore' });
  },
): void {
  runCommand('systemd-run', [
    `--unit=${unitName}`,
    '--collect',
    '--no-block',
    '--property=Type=oneshot',
    '--property=TimeoutStartSec=10min',
    '/bin/sh',
    scriptPath,
  ]);
}

export async function startControlledNodeSelfUpgrade(
  credential: ControlledNodeCredential,
  rawTargetVersion: unknown,
  deps: ControlledNodeSelfUpgradeDeps = {},
): Promise<ControlledNodeSelfUpgradeResult> {
  const targetVersion = normalizeDaemonUpgradeTargetVersion(rawTargetVersion);
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const target = controlledNodeArtifactTarget(platform, arch);
  if (!target) return { ok: false, targetVersion, reason: 'unsupported_platform' };
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!fetchImpl) return { ok: false, targetVersion, reason: 'fetch_unavailable' };

  const tempRoot = deps.tmpdir?.() ?? tmpdir();
  const updateDir = await mkdtemp(join(tempRoot, 'imcodes-node-upgrade-'));
  const downloaded = await downloadArtifact({
    credential,
    target,
    dir: updateDir,
    fetchImpl,
    ...(targetVersion === DAEMON_UPGRADE_TARGET_LATEST ? {} : { expectedVersion: targetVersion }),
  });
  const helper = await downloadControlledNodeComputerUseHelper({ credential, target, dir: updateDir, fetchImpl });
  const remoteDesktopWorker = await downloadControlledNodeRemoteDesktopWorker({ credential, target, dir: updateDir, fetchImpl });
  const destinationPath = deps.execPath ?? defaultStagedExecutablePath(platform);
  const destinationManifestPath = `${destinationPath}.manifest.json`;
  const destinationJournalPath = deps.journalPath ?? join(dirname(defaultCredentialPath(platform)), 'install-journal.json');
  const stagedJournalPath = await prepareUpgradeJournal({
    currentJournalPath: destinationJournalPath,
    outputJournalPath: join(updateDir, 'install-journal.json'),
    destinationPath,
    stagedArtifactPath: downloaded.artifactPath,
    artifactSha256: downloaded.sha256,
    artifactSizeBytes: downloaded.sizeBytes,
    now: deps.now?.() ?? Date.now(),
  });
  const scriptPath = platform === 'win32'
    ? join(updateDir, 'upgrade.ps1')
    : join(updateDir, 'upgrade.sh');
  const windowsUpgradeTaskName = platform === 'win32'
    ? `${CONTROLLED_NODE_SERVICE.WINDOWS_TASK}-upgrade-${randomUUID()}`
    : undefined;
  const script = platform === 'win32'
    ? buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: downloaded.artifactPath,
      stagedManifestPath: downloaded.manifestPath,
      stagedComputerUseHelperDir: helper?.helperDir,
      // Swap the platform-root as one directory so the installed layout stays
      // remote-desktop-worker/win32-x64/<worker+manifest>, matching both the
      // packaged dist layout and the worker resolver.
      stagedRemoteDesktopWorkerDir: remoteDesktopWorker
        ? dirname(remoteDesktopWorker.workerDir)
        : undefined,
      stagedJournalPath,
      destinationPath,
      destinationManifestPath,
      destinationJournalPath,
      upgradeTaskName: windowsUpgradeTaskName,
    })
    : buildPosixControlledNodeUpgradeScript({
      platform: platform === 'darwin' ? 'darwin' : 'linux',
      stagedArtifactPath: downloaded.artifactPath,
      stagedManifestPath: downloaded.manifestPath,
      stagedComputerUseHelperDir: helper?.helperDir,
      stagedJournalPath,
      destinationPath,
      destinationManifestPath,
      destinationJournalPath,
    });
  await writeFile(scriptPath, script, { mode: 0o700 });
  if (platform !== 'win32') await chmod(scriptPath, 0o700).catch(() => {});
  if (platform === 'win32') {
    const taskXmlPath = join(updateDir, 'upgrade-task.xml');
    await writeFile(taskXmlPath, encodeWindowsScheduledTaskXml(windowsControlledNodeUpgradeTaskXml(scriptPath)));
    const scheduleWindowsUpgrade = deps.scheduleWindowsUpgrade ?? scheduleWindowsControlledNodeUpgrade;
    scheduleWindowsUpgrade(windowsUpgradeTaskName!, taskXmlPath);
  } else if (platform === 'linux') {
    const scheduleLinuxUpgrade = deps.scheduleLinuxUpgrade ?? scheduleLinuxControlledNodeUpgrade;
    scheduleLinuxUpgrade(`${CONTROLLED_NODE_SERVICE.LINUX_UNIT.replace(/\.service$/, '')}-upgrade-${randomUUID()}`, scriptPath);
  } else {
    const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
    spawnDetached('/bin/sh', [scriptPath], {});
  }
  return {
    ok: true,
    targetVersion: targetVersion || DAEMON_UPGRADE_TARGET_LATEST,
    artifactSha256: downloaded.sha256,
    scriptPath,
  };
}
