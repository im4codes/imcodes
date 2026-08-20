import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CONTROLLED_NODE_SERVICE,
  CONTROLLED_NODE_WINDOWS_INSTALL_DIR,
  CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR,
} from '../shared/controlled-node-service.js';
import { cleanupLegacyWindowsUpgradeRescue } from '../src/node/legacy-upgrade-rescue.js';
import {
  buildLegacyWindowsUpgradeRescueCommand,
  LEGACY_WINDOWS_UPGRADE_RESCUE_GRACE_MS,
} from '../server/src/ws/windows-controlled-node-upgrade-rescue.js';

const signerSha256 = process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256?.trim().toLowerCase() ?? '';
if (process.platform !== 'win32') throw new Error('Windows self-upgrade qualification requires Windows.');
if (!/^[a-f0-9]{64}$/.test(signerSha256)) throw new Error('Windows release signer SHA-256 is required.');

Object.assign(globalThis, {
  __IMCODES_WINDOWS_RELEASE_SIGNER_SHA256__: signerSha256,
});

const { buildWindowsControlledNodeUpgradeScript } = await import('../src/node/self-upgrade.js');

const root = resolve(import.meta.dirname, '..');
const nodeArtifact = join(root, 'dist-node-exe', 'imcodes-node.exe');
const nodeManifest = `${nodeArtifact}.manifest.json`;
const helperArtifact = join(
  root,
  'dist-node-exe',
  'computer-use-helper',
  'win32-x64',
  'open-computer-use.exe',
);
const signingScript = join(root, 'scripts', 'windows-sign-release-artifact.ps1');
const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
for (const path of [nodeArtifact, nodeManifest, helperArtifact]) {
  if (!(await stat(path)).isFile()) throw new Error(`qualification artifact missing: ${path}`);
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function relativeFileHashes(rootDir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? join(prefix, entry.name) : entry.name;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) result.set(relative.replaceAll('\\', '/'), await sha256(absolute));
    }
  };
  await visit(rootDir, '');
  return result;
}

function runPowerShellFile(path: string, timeout = 120_000): string {
  return execFileSync(
    windowsPowerShell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, windowsHide: true },
  );
}

function removeAuthenticodeSignature(path: string): void {
  execFileSync(
    windowsPowerShell,
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', signingScript,
      '-Mode', 'Remove',
      '-ArtifactPath', path,
    ],
    { stdio: 'pipe', timeout: 60_000, windowsHide: true },
  );
}

async function runScenario(mode: 'success' | 'rollback'): Promise<void> {
  const scenario = await mkdtemp(join(tmpdir(), `imcodes-upgrade-${mode}-`));
  try {
    const installed = join(scenario, 'imcodes-node.exe');
    const installedManifest = `${installed}.manifest.json`;
    const staged = join(scenario, 'staged-node.exe');
    const stagedManifest = `${staged}.manifest.json`;
    const installedHelperDir = join(scenario, 'computer-use-helper');
    const installedHelper = join(installedHelperDir, 'open-computer-use.exe');
    const stagedHelperDir = join(scenario, 'staged-helper');
    const stagedHelper = join(stagedHelperDir, 'open-computer-use.exe');
    const publicationEvidence = join(scenario, 'publication-evidence.json');
    await mkdir(installedHelperDir, { recursive: true });
    await mkdir(stagedHelperDir, { recursive: true });
    await copyFile(nodeArtifact, installed);
    removeAuthenticodeSignature(installed);
    await copyFile(nodeArtifact, staged);
    await copyFile(nodeManifest, stagedManifest);
    await copyFile(helperArtifact, installedHelper);
    removeAuthenticodeSignature(installedHelper);
    await copyFile(helperArtifact, stagedHelper);
    const oldHash = await sha256(installed);
    const newHash = await sha256(staged);
    const oldHelperHash = await sha256(installedHelper);
    const newHelperHash = await sha256(stagedHelper);
    if (oldHash === newHash) throw new Error('qualification requires distinct old and new signed bytes');
    if (oldHelperHash === newHelperHash) {
      throw new Error('qualification requires distinct old and new helper bytes');
    }

    const generated = buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: staged,
      stagedManifestPath: stagedManifest,
      destinationPath: installed,
      destinationManifestPath: installedManifest,
      stagedComputerUseHelperDir: stagedHelperDir,
      upgradeTaskName: `imcodes-node-upgrade-qualification-${mode}`,
    });
    const lease = join(dirname(installed), 'health-lease.json');
    const harness = [
      "$ErrorActionPreference = 'Stop'",
      `$qualificationMode = ${psQuote(mode)}`,
      `$qualificationNode = ${psQuote(installed)}`,
      `$qualificationHelper = ${psQuote(installedHelper)}`,
      `$qualificationLease = ${psQuote(lease)}`,
      `$qualificationPublicationEvidence = ${psQuote(publicationEvidence)}`,
      'function Start-Sleep { param([int]$Seconds) }',
      'function Stop-ScheduledTask { param($TaskName, $ErrorAction) }',
      'function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) }',
      'function Stop-Process { param($Id, $Force, $ErrorAction) }',
      'function Get-CimInstance { param($ClassName, $Filter, $ErrorAction); if ([string]$Filter -like "ProcessId=*") { [pscustomobject]@{ ProcessId = 42; ExecutablePath = $qualificationNode } } else { @() } }',
      'function Get-QualificationAclEvidence {',
      '  param([string]$Path)',
      '  $acl = Get-Acl -LiteralPath $Path',
      '  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
      '  $full = [System.Security.AccessControl.FileSystemRights]::FullControl',
      '  $readExecute = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute',
      '  [pscustomobject]@{',
      '    protected = [bool]$acl.AreAccessRulesProtected',
      "    ownerSystem = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-18'",
      "    systemFull = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-18' -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $full) -eq $full }).Count -gt 0",
      "    administratorsFull = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-544' -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $full) -eq $full }).Count -gt 0",
      "    authenticatedUsersReadExecute = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-11' -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $readExecute) -eq $readExecute }).Count -gt 0",
      '  }',
      '}',
      'function Start-ScheduledTask {',
      '  param($TaskName, $ErrorAction)',
      '  if ($TaskName -eq "imcodes-node") {',
      '    if (-not (Test-Path -LiteralPath $qualificationPublicationEvidence)) {',
      '      $mainAcl = Get-QualificationAclEvidence -Path $qualificationNode',
      '      $helperAcl = Get-QualificationAclEvidence -Path (Split-Path -Parent $qualificationHelper)',
      '      @{',
      '        mainSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qualificationNode).Hash.ToLowerInvariant()',
      '        helperSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qualificationHelper).Hash.ToLowerInvariant()',
      '        markerWasPresent = Test-Path -LiteralPath (Join-Path (Split-Path -Parent $qualificationNode) "upgrade-in-progress.json")',
      '        mainAcl = $mainAcl',
      '        helperRootAcl = $helperAcl',
      '      } | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $qualificationPublicationEvidence -Encoding utf8',
      '    }',
      '    if ($qualificationMode -eq "success") {',
      '      @{ version = 1; pid = 42; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $qualificationLease -Encoding utf8',
      '    }',
      '  }',
      '}',
      generated,
    ].join('\r\n');
    const harnessPath = join(scenario, `upgrade-${mode}.ps1`);
    await writeFile(harnessPath, harness, 'utf8');

    let failed = false;
    let failureDetail = '';
    try {
      runPowerShellFile(harnessPath, 60_000);
    } catch (error) {
      failed = true;
      const failure = error as Error & { stderr?: Buffer | string };
      failureDetail = `${failure.message}${failure.stderr ? `\n${String(failure.stderr)}` : ''}`;
    }
    if ((mode === 'success' && failed) || (mode === 'rollback' && !failed)) {
      throw new Error(`${mode} qualification returned an unexpected exit status${failureDetail ? `: ${failureDetail}` : ''}`);
    }

    const publication = JSON.parse((await readFile(publicationEvidence, 'utf8')).replace(/^\uFEFF/, '')) as {
      mainSha256?: string;
      helperSha256?: string;
      markerWasPresent?: boolean;
      mainAcl?: Record<string, boolean>;
      helperRootAcl?: Record<string, boolean>;
    };
    if (publication.mainSha256 !== newHash || publication.helperSha256 !== newHelperHash) {
      throw new Error(`${mode} failure injection occurred before the signed artifacts were published`);
    }
    if (!publication.markerWasPresent) {
      throw new Error(`${mode} did not publish the watchdog suppression marker before restart`);
    }
    for (const [label, acl] of [['main', publication.mainAcl], ['helper root', publication.helperRootAcl]] as const) {
      if (!acl || !acl.protected || !acl.ownerSystem || !acl.systemFull
        || !acl.administratorsFull || !acl.authenticatedUsersReadExecute) {
        throw new Error(`${mode} did not apply the exact protected ${label} ACL`);
      }
    }

    const expectedHash = mode === 'success' ? newHash : oldHash;
    if (await sha256(installed) !== expectedHash) throw new Error(`${mode} landed executable hash mismatch`);
    const expectedHelperHash = mode === 'success' ? newHelperHash : oldHelperHash;
    if (await sha256(installedHelper) !== expectedHelperHash) {
      throw new Error(`${mode} landed computer-use helper hash mismatch`);
    }
    const resultText = (await readFile(`${staged}.upgrade-result.json`, 'utf8')).replace(/^\uFEFF/, '');
    const result = JSON.parse(resultText) as {
      status?: string;
      reason?: string;
      recoveryFailures?: unknown[];
    };
    const expectedStatus = mode === 'success' ? 'success' : 'rolled_back';
    if (result.status !== expectedStatus) {
      throw new Error(`${mode} result was not ${expectedStatus}`);
    }
    if (mode === 'rollback' && (!Array.isArray(result.recoveryFailures) || result.recoveryFailures.length !== 0)) {
      throw new Error('rollback result did not explicitly report an empty recoveryFailures array');
    }
    if (mode === 'success' && result.recoveryFailures !== undefined) {
      throw new Error('success result unexpectedly reported rollback recoveryFailures');
    }
    if (mode === 'rollback' && result.reason !== 'controlled node upgrade failed authenticated health verification') {
      throw new Error(`rollback was not triggered by the authenticated health-verification gate: ${String(result.reason)}`);
    }
    if (await exists(join(scenario, 'upgrade-in-progress.json'))) {
      throw new Error(`${mode} left the watchdog suppression marker behind`);
    }
    if (mode === 'rollback') {
      const backup = `${installed}.upgrade-old`;
      if (await sha256(backup) !== oldHash) throw new Error('rollback did not preserve its verified recovery backup');
    }
  } finally {
    await rm(scenario, { recursive: true, force: true });
  }
}

async function runLegacyRescueRestoreScenario(): Promise<void> {
  const scenarioProgramData = await mkdtemp(join(tmpdir(), 'imcodes-legacy-rescue-'));
  const nodeDir = join(scenarioProgramData, CONTROLLED_NODE_WINDOWS_INSTALL_DIR);
  const rescueRoot = join(scenarioProgramData, CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR);
  const installed = join(nodeDir, 'imcodes-node.exe');
  const installedManifest = `${installed}.manifest.json`;
  const helperDir = join(nodeDir, 'computer-use-helper');
  const installedHelper = join(helperDir, 'open-computer-use.exe');
  const helperManifest = `${installedHelper}.manifest.json`;
  const helperPolicy = join(helperDir, 'policies', 'legacy.json');
  const startEvidence = join(scenarioProgramData, 'rescue-start-evidence.json');
  const rescueId = '11111111-2222-4333-8444-555555555555';
  try {
    await mkdir(dirname(helperPolicy), { recursive: true });
    await copyFile(nodeArtifact, installed);
    removeAuthenticodeSignature(installed);
    await writeFile(installedManifest, '{"legacyUnsigned":true}\n', 'utf8');
    await copyFile(helperArtifact, installedHelper);
    removeAuthenticodeSignature(installedHelper);
    await writeFile(helperManifest, '{"legacyHelper":true}\n', 'utf8');
    await writeFile(helperPolicy, '{"legacyPolicy":true}\n', 'utf8');

    const oldMainHash = await sha256(installed);
    const oldManifestHash = await sha256(installedManifest);
    const oldHelperHashes = await relativeFileHashes(helperDir);
    const built = buildLegacyWindowsUpgradeRescueCommand(rescueId);
    const setupHarness = [
      "$ErrorActionPreference = 'Stop'",
      `$env:ProgramData = ${psQuote(scenarioProgramData)}`,
      '$script:qualificationRegisteredAction = $null',
      'function Stop-ScheduledTask { param($TaskName, $ErrorAction) }',
      'function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) }',
      'function New-ScheduledTaskAction { param($Execute, $Argument); [pscustomobject]@{ Execute = $Execute; Arguments = $Argument } }',
      'function New-ScheduledTaskTrigger { param([switch]$Once, $At, $RepetitionInterval, [switch]$AtStartup); [pscustomobject]@{ Once = $Once; AtStartup = $AtStartup } }',
      'function New-ScheduledTaskSettingsSet { param($MultipleInstances, $ExecutionTimeLimit, [switch]$StartWhenAvailable); [pscustomobject]@{ Enabled = $true } }',
      'function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Settings, $User, $RunLevel, [switch]$Force); $script:qualificationRegisteredAction = $Action; [pscustomobject]@{ TaskName = $TaskName } }',
      'function Get-ScheduledTask { param($TaskName); [pscustomobject]@{ Settings = [pscustomobject]@{ Enabled = $true }; Actions = @($script:qualificationRegisteredAction); Principal = [pscustomobject]@{ UserId = "SYSTEM" } } }',
      built.command,
    ].join('\r\n');
    const setupHarnessPath = join(scenarioProgramData, 'run-rescue-setup.ps1');
    await writeFile(setupHarnessPath, setupHarness, 'utf8');
    const setupStdout = runPowerShellFile(setupHarnessPath).trim();
    if (setupStdout !== built.expectedStdout) {
      throw new Error(`legacy rescue setup stdout mismatch: ${setupStdout}`);
    }

    const markerPath = join(rescueRoot, 'marker.json');
    const markerText = (await readFile(markerPath, 'utf8')).replace(/^\uFEFF/, '');
    const marker = JSON.parse(markerText) as {
      status?: string;
      preparedAt?: number;
      mainSha256?: string;
      manifestSha256?: string;
      helperFiles?: Array<{ path?: string; sha256?: string }>;
    };
    if (marker.status !== 'prepared' || marker.mainSha256 !== oldMainHash
      || marker.manifestSha256 !== oldManifestHash || !Array.isArray(marker.helperFiles)) {
      throw new Error('legacy rescue setup marker did not pin the exact old installation');
    }
    const markerHelperHashes = new Map(marker.helperFiles.map((entry) => [
      String(entry.path).replaceAll('\\', '/'),
      String(entry.sha256),
    ]));
    if (markerHelperHashes.size !== oldHelperHashes.size
      || [...oldHelperHashes].some(([path, hash]) => markerHelperHashes.get(path) !== hash)) {
      throw new Error('legacy rescue setup marker did not pin the exact old helper tree');
    }
    if (await sha256(join(rescueRoot, 'backup', 'imcodes-node.exe')) !== oldMainHash
      || await sha256(join(rescueRoot, 'backup', 'imcodes-node.exe.manifest.json')) !== oldManifestHash) {
      throw new Error('legacy rescue setup backup hashes do not match the old installation');
    }
    const backupHelperHashes = await relativeFileHashes(join(rescueRoot, 'backup', 'computer-use-helper'));
    if (backupHelperHashes.size !== oldHelperHashes.size
      || [...oldHelperHashes].some(([path, hash]) => backupHelperHashes.get(path) !== hash)) {
      throw new Error('legacy rescue setup helper backup is incomplete');
    }

    await copyFile(nodeArtifact, installed);
    await copyFile(nodeManifest, installedManifest);
    await rm(helperDir, { recursive: true, force: true });
    await mkdir(helperDir, { recursive: true });
    await copyFile(helperArtifact, installedHelper);
    await writeFile(join(helperDir, 'replacement-only.txt'), 'failed replacement helper\n', 'utf8');
    marker.preparedAt = Date.now() - LEGACY_WINDOWS_UPGRADE_RESCUE_GRACE_MS - 60_000;
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8');
    await rm(join(nodeDir, 'health-lease.json'), { force: true });

    const rescueHarness = [
      "$ErrorActionPreference = 'Stop'",
      `$env:ProgramData = ${psQuote(scenarioProgramData)}`,
      `$qualificationStartEvidence = ${psQuote(startEvidence)}`,
      'function Get-CimInstance { param($ClassName, $Filter, $ErrorAction); @() }',
      'function Stop-ScheduledTask { param($TaskName, $ErrorAction) }',
      'function Stop-Process { param($Id, $Force, $ErrorAction) }',
      'function Start-Sleep { param([int]$Seconds) }',
      'function Enable-ScheduledTask { param($TaskName, $ErrorAction) }',
      'function Start-ScheduledTask { param($TaskName, $ErrorAction); @{ taskName = $TaskName; mainSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $env:ProgramData "imcodes-node\\imcodes-node.exe")).Hash.ToLowerInvariant() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $qualificationStartEvidence -Encoding utf8 }',
      `& ${psQuote(join(rescueRoot, 'rescue.ps1'))}`,
    ].join('\r\n');
    const rescueHarnessPath = join(scenarioProgramData, 'run-rescue-restore.ps1');
    await writeFile(rescueHarnessPath, rescueHarness, 'utf8');
    runPowerShellFile(rescueHarnessPath);

    if (await sha256(installed) !== oldMainHash || await sha256(installedManifest) !== oldManifestHash) {
      throw new Error('legacy rescue did not restore the exact old main and manifest bytes');
    }
    const restoredHelperHashes = await relativeFileHashes(helperDir);
    if (restoredHelperHashes.size !== oldHelperHashes.size
      || [...oldHelperHashes].some(([path, hash]) => restoredHelperHashes.get(path) !== hash)) {
      throw new Error('legacy rescue did not restore the exact old helper tree');
    }
    const rolledBackMarker = JSON.parse((await readFile(markerPath, 'utf8')).replace(/^\uFEFF/, '')) as {
      status?: string;
      rolledBackAt?: number;
    };
    if (rolledBackMarker.status !== 'rolled_back'
      || !Number.isSafeInteger(rolledBackMarker.rolledBackAt)
      || (rolledBackMarker.rolledBackAt ?? 0) <= 0) {
      throw new Error('legacy rescue did not publish a valid rolled_back marker');
    }
    const start = JSON.parse((await readFile(startEvidence, 'utf8')).replace(/^\uFEFF/, '')) as {
      taskName?: string;
      mainSha256?: string;
    };
    if (start.taskName !== CONTROLLED_NODE_SERVICE.WINDOWS_TASK || start.mainSha256 !== oldMainHash) {
      throw new Error('legacy rescue restarted the main task before exact-byte restoration');
    }

    const cleanupCalls: string[][] = [];
    await cleanupLegacyWindowsUpgradeRescue({
      platform: 'win32',
      env: { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, ProgramData: scenarioProgramData },
      run: async (_file, args) => {
        cleanupCalls.push(args);
        return true;
      },
    });
    if (cleanupCalls.length !== 2 || cleanupCalls[0]?.[0] !== '/End' || cleanupCalls[1]?.[0] !== '/Delete') {
      throw new Error('legacy rescue cleanup did not end and delete the independent task first');
    }
    if (await exists(rescueRoot) || await exists(markerPath)) {
      throw new Error('legacy rescue cleanup left protected rescue state behind');
    }
  } finally {
    await rm(scenarioProgramData, { recursive: true, force: true });
  }
}

await runScenario('success');
await runScenario('rollback');
await runLegacyRescueRestoreScenario();
process.stdout.write('Windows arbitrary legacy-unsigned upgrade, rollback, and hard-kill rescue qualification passed.\n');
