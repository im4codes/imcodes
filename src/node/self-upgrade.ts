import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  CONTROLLED_NODE_ARCH_ARM64,
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH,
  CONTROLLED_NODE_OS_LINUX,
  CONTROLLED_NODE_OS_MAC,
  CONTROLLED_NODE_OS_WIN,
  type ControlledNodeArch,
  type ControlledNodeOs,
} from '../../shared/controlled-node-artifacts.js';
import { DAEMON_UPGRADE_TARGET_LATEST, normalizeDaemonUpgradeTargetVersion } from '../../shared/daemon-upgrade.js';
import {
  CONTROLLED_NODE_SERVICE,
  encodeWindowsScheduledTaskXml,
  windowsComputerUseHelperAclCommands,
  windowsExecutableFileAclCommands,
} from './installer.js';
import { defaultCredentialPath, defaultStagedExecutablePath, type ControlledNodeCredential } from './enrollment.js';
import { loadInstallJournal, INSTALL_JOURNAL_VERSION } from './install-journal.js';

export interface ControlledNodeArtifactTarget {
  os: ControlledNodeOs;
  arch: ControlledNodeArch;
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
  if (platform === 'darwin' && arch === 'arm64') return { os: CONTROLLED_NODE_OS_MAC, arch: CONTROLLED_NODE_ARCH_ARM64 };
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
}): Promise<{ artifactPath: string; manifestPath: string; sha256: string; sizeBytes: number; filename: string; version?: string }> {
  const asset = input.asset ?? CONTROLLED_NODE_ARTIFACT_ASSETS.NODE;
  const response = await input.fetchImpl(controlledNodeArtifactUpgradeUrl(input.credential, input.target, asset), {
    headers: {
      Authorization: `Bearer ${input.credential.token}`,
      'X-Server-Id': input.credential.serverId,
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
  await writeFile(artifactPath, bytes, { mode: 0o755 });
  if (process.platform !== 'win32') await chmod(artifactPath, 0o755).catch(() => {});
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

function controlledNodeComputerUseHelperFilename(target: ControlledNodeArtifactTarget): string {
  return target.os === CONTROLLED_NODE_OS_WIN ? 'open-computer-use.exe' : 'open-computer-use';
}

async function downloadComputerUseHelper(input: {
  credential: ControlledNodeCredential;
  target: ControlledNodeArtifactTarget;
  dir: string;
  fetchImpl: typeof fetch;
}): Promise<{ helperDir: string; sha256: string; sizeBytes: number } | undefined> {
  const helperDir = join(input.dir, 'computer-use-helper', controlledNodePlatformArchKey(input.target));
  await mkdir(helperDir, { recursive: true });
  try {
    const downloaded = await downloadArtifact({
      credential: input.credential,
      target: input.target,
      dir: helperDir,
      fetchImpl: input.fetchImpl,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER,
      expectedFileName: controlledNodeComputerUseHelperFilename(input.target),
    });
    return { helperDir, sha256: downloaded.sha256, sizeBytes: downloaded.sizeBytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^download_failed_(404|503)$/.test(message) || message === 'artifact_filename_mismatch') return undefined;
    throw error;
  }
}

export function buildWindowsControlledNodeUpgradeScript(input: {
  stagedArtifactPath: string;
  stagedManifestPath: string;
  stagedComputerUseHelperDir?: string;
  stagedJournalPath?: string;
  destinationPath: string;
  destinationManifestPath: string;
  destinationJournalPath?: string;
  upgradeTaskName?: string;
}): string {
  const helperDir = join(dirname(input.destinationPath), 'computer-use-helper');
  const exeAcl = windowsExecutableFileAclCommands(input.destinationPath)
    .map(([path, ...args]) => `& icacls ${psQuote(path)} ${args.map(psQuote).join(' ')}`)
    .join('\r\n');
  const helperAcl = windowsComputerUseHelperAclCommands(helperDir)
    .map(([path, ...args]) => `if (Test-Path ${psQuote(path)}) { & icacls ${psQuote(path)} ${args.map(psQuote).join(' ')} }`)
    .join('\r\n');
  const upgradeTaskCleanup = input.upgradeTaskName
    ? `Unregister-ScheduledTask -TaskName ${psQuote(input.upgradeTaskName)} -Confirm:$false -ErrorAction SilentlyContinue\r\n`
    : '';
  return `$ErrorActionPreference = 'Stop'\r\n`
    + `Start-Sleep -Seconds 3\r\n`
    + `$task = ${psQuote(CONTROLLED_NODE_SERVICE.WINDOWS_TASK)}\r\n`
    + `$dst = ${psQuote(input.destinationPath)}\r\n`
    + `$src = ${psQuote(input.stagedArtifactPath)}\r\n`
    + `$dstManifest = ${psQuote(input.destinationManifestPath)}\r\n`
    + `$srcManifest = ${psQuote(input.stagedManifestPath)}\r\n`
    + `try {\r\n`
    + `Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue\r\n`
    + `Start-Sleep -Seconds 2\r\n`
    + `Get-CimInstance Win32_Process -Filter 'name="imcodes-node.exe"' | Where-Object { $_.CommandLine -like '*ProgramData*imcodes-node.exe*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\r\n`
    + `Start-Sleep -Seconds 1\r\n`
    + `Copy-Item -Force $src $dst\r\n`
    + `if (Test-Path $srcManifest) { Copy-Item -Force $srcManifest $dstManifest }\r\n`
    + (input.stagedComputerUseHelperDir
      ? `$srcHelper = ${psQuote(input.stagedComputerUseHelperDir)}\r\n`
        + `$dstHelper = ${psQuote(helperDir)}\r\n`
        + `if (Test-Path $srcHelper) { Remove-Item -Recurse -Force $dstHelper -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $dstHelper | Out-Null; Copy-Item -Recurse -Force -Path (Join-Path $srcHelper '*') -Destination $dstHelper }\r\n`
      : '')
    + (input.stagedJournalPath && input.destinationJournalPath
      ? `if (Test-Path ${psQuote(input.stagedJournalPath)}) { Copy-Item -Force ${psQuote(input.stagedJournalPath)} ${psQuote(input.destinationJournalPath)} }\r\n`
      : '')
    + exeAcl + `\r\n`
    + helperAcl + `\r\n`
    + `} finally {\r\n`
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
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>IM.codes controlled node one-shot upgrade</Description></RegistrationInfo>
  <Triggers />
  <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="System"><Exec><Command>powershell.exe</Command><Arguments>${escapeXmlText(argumentsText)}</Arguments></Exec></Actions>
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
  const helperCopy = input.stagedComputerUseHelperDir
    ? `rm -rf ${shQuote(helperDir)}\nmkdir -p ${shQuote(helperDir)}\ncp -R ${shQuote(`${input.stagedComputerUseHelperDir}/.`)} ${shQuote(helperDir)}/ 2>/dev/null || true\nfind ${shQuote(helperDir)} -type f -name 'open-computer-use*' -exec chmod 755 {} \\; 2>/dev/null || true\n`
    : '';
  const copy = `cp -f ${shQuote(input.stagedArtifactPath)} ${shQuote(input.destinationPath)}\ncp -f ${shQuote(input.stagedManifestPath)} ${shQuote(input.destinationManifestPath)} 2>/dev/null || true\n${helperCopy}${journalCopy}chmod 755 ${shQuote(input.destinationPath)}\n`;
  if (input.platform === 'linux') {
    return `#!/bin/sh\nset +e\nsleep 3\nsystemctl stop ${CONTROLLED_NODE_SERVICE.LINUX_UNIT}\n${copy}systemctl start ${CONTROLLED_NODE_SERVICE.LINUX_UNIT}\n`;
  }
  return `#!/bin/sh\nset +e\nsleep 3\nlaunchctl bootout system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}\n${copy}launchctl bootstrap system /Library/LaunchDaemons/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}.plist\nlaunchctl kickstart -k system/${CONTROLLED_NODE_SERVICE.MACOS_LABEL}\n`;
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
  const helper = await downloadComputerUseHelper({ credential, target, dir: updateDir, fetchImpl });
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
