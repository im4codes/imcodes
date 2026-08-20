import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH,
  controlledNodeComputerUseHelperFilename,
  isControlledNodeArtifactCompatibleWithRuntime,
  normalizeControlledNodeArtifactPair,
} from '../../shared/controlled-node-artifacts.js';
import {
  buildPosixControlledNodeUpgradeScript,
  buildWindowsControlledNodeUpgradeScript,
  controlledNodeArtifactTarget,
  controlledNodeArtifactUpgradeUrl,
  downloadControlledNodeRemoteDesktopWorker,
  scheduleLinuxControlledNodeUpgrade,
  scheduleWindowsControlledNodeUpgrade,
  startControlledNodeSelfUpgrade,
  windowsControlledNodeUpgradeTaskXml,
} from '../../src/node/self-upgrade.js';
import {
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
} from '../../shared/remote-desktop-worker.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from '../../shared/remote-desktop-qualification.js';

const dirs: string[] = [];
const WINDOWS_SIGNER_SHA256 = 'c'.repeat(64);
const execFileAsync = promisify(execFile);
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const credential = {
  serverUrl: 'https://im.example',
  serverId: 'srv-1',
  token: 'secret-token',
  nodeRole: NODE_ROLE.CONTROLLED,
} as const;

describe('controlled-node self-upgrade', () => {
  it('maps only canonical platform artifacts', () => {
    expect(controlledNodeArtifactTarget('win32', 'x64')).toEqual({ os: 'win', arch: 'x64' });
    expect(controlledNodeArtifactTarget('darwin', 'arm64')).toEqual({ os: 'mac', arch: 'universal' });
    expect(controlledNodeArtifactTarget('darwin', 'x64')).toEqual({ os: 'mac', arch: 'universal' });
    expect(controlledNodeArtifactTarget('linux', 'x64')).toEqual({ os: 'linux', arch: 'x64' });
    expect(controlledNodeArtifactTarget('win32', 'arm64')).toBeNull();
    expect(normalizeControlledNodeArtifactPair('mac', 'arm64')).toEqual({ os: 'mac', arch: 'universal' });
    expect(isControlledNodeArtifactCompatibleWithRuntime('mac', 'arm64', 'mac', 'arm64')).toBe(true);
    expect(isControlledNodeArtifactCompatibleWithRuntime('mac', 'universal', 'mac', 'x64')).toBe(true);
    expect(controlledNodeComputerUseHelperFilename('win')).toBe('open-computer-use.exe');
    expect(controlledNodeComputerUseHelperFilename('mac')).toBe('open-computer-use.app.zip');
    expect(controlledNodeComputerUseHelperFilename('linux')).toBe('open-computer-use');
  });

  it('builds the node-token artifact URL with serverId, os, and arch', () => {
    const url = controlledNodeArtifactUpgradeUrl(credential, { os: 'win', arch: 'x64' });
    expect(url).toBe(`https://im.example${CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH}?serverId=srv-1&os=win&arch=x64`);
    const helperUrl = controlledNodeArtifactUpgradeUrl(credential, { os: 'win', arch: 'x64' }, CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER);
    expect(helperUrl).toBe(`https://im.example${CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH}?serverId=srv-1&os=win&arch=x64&asset=computer-use-helper`);
  });

  it('downloads the Windows remote-desktop worker only with its matching pinned manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-worker-upgrade-test-'));
    dirs.push(dir);
    const bytes = Buffer.from('pinned libwebrtc worker');
    const virtualDisplayBytes = Buffer.from('signed virtual display archive');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const manifest = Buffer.from(JSON.stringify({
      manifestVersion: 2,
      workerVersion: '0.1.2',
      protocolVersion: 2,
      ipcVersion: 1,
      os: 'win32',
      arch: 'x64',
      fileName: REMOTE_DESKTOP_WORKER_FILENAME,
      size: bytes.length,
      sha256: digest,
      authenticodeSignerSha256: 'c'.repeat(64),
      libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
      virtualDisplay: {
        archiveFileName: 'imcodes-virtual-display.zip',
        packageManifestFileName: 'imcodes-virtual-display.manifest.json',
        size: virtualDisplayBytes.length,
        sha256: createHash('sha256').update(virtualDisplayBytes).digest('hex'),
      },
      toolchain: {
        msvc: '14.44',
        windowsSdk: '10.0.26100.0',
        cmake: 'not-used-gn',
        ninja: '1.13.1',
        depotTools: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.depotToolsRevision,
      },
    }));
    const result = await downloadControlledNodeRemoteDesktopWorker({
      credential,
      target: { os: 'win', arch: 'x64' },
      dir,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: String(REMOTE_DESKTOP_PROTOCOL_VERSION),
        });
        const isManifest = url.includes('asset=remote-desktop-worker-manifest');
        const isVirtualDisplay = url.includes('asset=remote-desktop-virtual-display');
        const body = isManifest ? manifest : isVirtualDisplay ? virtualDisplayBytes : bytes;
        return new Response(body, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(body).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(body.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: isManifest
              ? `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`
              : isVirtualDisplay ? 'imcodes-virtual-display.zip' : REMOTE_DESKTOP_WORKER_FILENAME,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '0.1.2',
          },
        });
      }) as unknown as typeof fetch,
    });
    expect(result).toBeDefined();
    expect(await readFile(result!.artifactPath)).toEqual(bytes);
    expect(await readFile(result!.manifestPath)).toEqual(manifest);
    expect((await readdir(join(dir, 'remote-desktop-worker', 'win32-x64'))).sort()).toEqual([
      'imcodes-remote-desktop-worker.exe',
      'imcodes-remote-desktop-worker.exe.manifest.json',
      'imcodes-virtual-display.zip',
    ]);
  });

  it('treats a remote-desktop protocol skew as an optional sidecar miss', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-rd-worker-skew-test-'));
    dirs.push(dir);
    const result = await downloadControlledNodeRemoteDesktopWorker({
      credential,
      target: { os: 'win', arch: 'x64' },
      dir,
      fetchImpl: (async () => new Response(null, { status: 409 })) as unknown as typeof fetch,
    });
    expect(result).toBeUndefined();
  });

  it('downloads, verifies sha256, writes a staged artifact, and spawns a detached Windows upgrader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-test-'));
    dirs.push(dir);
    const bytes = Buffer.from('new controlled node exe');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const helperBytes = Buffer.from('new open computer use helper');
    const helperSha256 = createHash('sha256').update(helperBytes).digest('hex');
    const journalPath = join(dir, 'install-journal.json');
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      phase: 'service_healthy',
      updatedAt: 1,
      installId: 'install-1',
      nodeTokenHash: 'a'.repeat(64),
      sourceExePath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      stagedExePath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      stagedReceipt: {
        path: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
        size: 3,
        sha256: 'b'.repeat(64),
        sourceIdentity: { size: 3, mtimeMs: 1, ctimeMs: 1 },
        stagedIdentity: { size: 3, mtimeMs: 1, ctimeMs: 1 },
      },
      serverId: 'srv-1',
      serviceName: 'imcodes-node',
      serviceReceipt: { name: 'imcodes-node', platform: 'win32', action: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe' },
      serviceStartRequestedAt: 1,
      healthyAt: 1,
    }), 'utf8');
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain(CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH);
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer secret-token',
        'X-Server-Id': 'srv-1',
        [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: String(REMOTE_DESKTOP_PROTOCOL_VERSION),
      });
      if (url.includes('asset=computer-use-helper')) {
        return new Response(helperBytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: helperSha256,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(helperBytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'open-computer-use.exe',
          },
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256,
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: WINDOWS_SIGNER_SHA256,
        },
      });
    });
    const scheduled: Array<{ taskName: string; taskXmlPath: string }> = [];
    const result = await startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      journalPath,
      tmpdir: () => dir,
      now: () => 9,
      scheduleWindowsUpgrade: (taskName, taskXmlPath) => { scheduled.push({ taskName, taskXmlPath }); },
    });

    expect(result).toMatchObject({ ok: true, targetVersion: '2026.7.1', artifactSha256: sha256 });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].taskName).toMatch(/^imcodes-node-upgrade-/);
    expect(scheduled[0].taskXmlPath).toBe(join(dirname(result.scriptPath!), 'upgrade-task.xml'));
    const stagedManifest = JSON.parse(
      await readFile(join(dirname(result.scriptPath!), 'imcodes-node.exe.manifest.json'), 'utf8'),
    ) as { artifact: { authenticodeSignerSha256?: string } };
    expect(stagedManifest.artifact.authenticodeSignerSha256).toBe(WINDOWS_SIGNER_SHA256);
    const script = await readFile(result.scriptPath!, 'utf8');
    expect(script).toContain('Stop-ScheduledTask');
    expect(script).toContain('Start-ScheduledTask');
    expect(script).toContain("$upgradeMarker = Join-Path (Split-Path -Parent $dst) 'upgrade-in-progress.json'");
    expect(script).not.toContain('Disable-ScheduledTask -TaskName $watchdogTask');
    expect(script).not.toContain('Stop-ScheduledTask -TaskName $watchdogTask');
    expect(script).toContain('Copy-Item -Force $src $dst');
    expect(script).toContain('computer-use-helper');
    expect(script.match(/Remove-Item -Force \$backupJournal -ErrorAction SilentlyContinue/g)).toHaveLength(2);
    expect(script).toContain('Copy-Item -Recurse -Force -Path (Join-Path $srcHelper');
    expect(script).toContain('install-journal.json');
    expect(script).toContain(`Unregister-ScheduledTask -TaskName '${scheduled[0].taskName}'`);
    const taskXml = (await readFile(scheduled[0].taskXmlPath)).subarray(2).toString('utf16le');
    expect(taskXml).toContain('<UserId>S-1-5-18</UserId>');
    expect(taskXml).toContain('<Triggers />');
    expect(taskXml).toContain('powershell.exe');
    expect(taskXml).toContain(result.scriptPath!);
    const helperPath = join(dirname(result.scriptPath!), 'computer-use-helper', 'win32-x64', 'open-computer-use.exe');
    expect(await readFile(helperPath, 'utf8')).toBe('new open computer use helper');
    const nextJournal = JSON.parse(await readFile(join(dirname(result.scriptPath!), 'install-journal.json'), 'utf8')) as {
      updatedAt: number;
      stagedReceipt: { path: string; size: number; sha256: string; stagedIdentity: { size: number } };
    };
    expect(nextJournal.updatedAt).toBe(9);
    expect(nextJournal.stagedReceipt).toMatchObject({
      path: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      size: bytes.length,
      sha256,
    });
    expect(nextJournal.stagedReceipt.stagedIdentity.size).toBe(bytes.length);
  });

  it('rejects artifact checksum mismatches before spawning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-bad-'));
    dirs.push(dir);
    const spawned = vi.fn();
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: (async () => new Response(Buffer.from('bad'), {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: 'a'.repeat(64),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: '3',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
        },
      })) as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => dir,
      spawnDetached: spawned,
    })).rejects.toThrow(/artifact_sha256_mismatch/);
    expect(spawned).not.toHaveBeenCalled();
  });

  it('rejects an artifact whose embedded version cannot satisfy the requested upgrade', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-version-'));
    dirs.push(dir);
    const bytes = Buffer.from('wrong-version-artifact');
    const spawned = vi.fn();
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.2', {
      fetchImpl: (async (url: string) => {
        if (url.includes('asset=computer-use-helper')) return new Response(null, { status: 404 });
        return new Response(bytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(bytes).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
          },
        });
      }) as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => dir,
      spawnDetached: spawned,
    })).rejects.toThrow(/artifact_version_mismatch/);
    expect(spawned).not.toHaveBeenCalled();
  });

  it('rejects a Windows upgrade when the server omits the release signer binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-self-upgrade-signer-test-'));
    dirs.push(dir);
    const bytes = Buffer.from('signed artifact without signer metadata');
    const scheduleWindowsUpgrade = vi.fn();
    await expect(startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: (async (url: string) => {
        if (url.includes('asset=computer-use-helper')) return new Response(null, { status: 404 });
        return new Response(bytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(bytes).digest('hex'),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(bytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: '2026.7.1',
          },
        });
      }) as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      tmpdir: () => dir,
      scheduleWindowsUpgrade,
    })).rejects.toThrow('missing_artifact_authenticode_signer_sha256');
    expect(scheduleWindowsUpgrade).not.toHaveBeenCalled();
  });

  it('quotes PowerShell paths and applies executable/helper ACLs', () => {
    const script = buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: "C:\\tmp\\it's\\imcodes-node.exe",
      stagedManifestPath: 'C:\\tmp\\imcodes-node.exe.manifest.json',
      stagedJournalPath: 'C:\\tmp\\install-journal.json',
      destinationPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      destinationManifestPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe.manifest.json',
      destinationJournalPath: 'C:\\ProgramData\\imcodes-node\\install-journal.json',
    });
    expect(script).toContain("'C:\\tmp\\it''s\\imcodes-node.exe'");
    expect(script).toContain('*S-1-5-18:F');
    expect(script).toContain('*S-1-5-11:RX');
    expect(script).toContain('computer-use-helper');
  });

  it('atomically installs the remote desktop worker in its win32-x64 platform directory', () => {
    const script = buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: 'C:\\tmp\\imcodes-node.exe',
      stagedManifestPath: 'C:\\tmp\\imcodes-node.exe.manifest.json',
      stagedRemoteDesktopWorkerDir: 'C:\\tmp\\remote-desktop-worker',
      destinationPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      destinationManifestPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe.manifest.json',
      upgradeTaskName: 'imcodes-node-upgrade-test',
    });
    expect(script).toContain("$srcRemoteDesktop = 'C:\\tmp\\remote-desktop-worker'");
    expect(script).toContain("$dstRemoteDesktop = 'C:\\ProgramData\\imcodes-node\\remote-desktop-worker'");
    expect(script).toContain('remote-desktop-worker\\win32-x64\\imcodes-remote-desktop-worker.exe');
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $srcRemoteDesktopExe');
    expect(script).toContain("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'");
    expect(script).toContain('Import-Module -Name $securityModulePath -ErrorAction Stop');
    expect(script).toContain("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1'");
    expect(script).toContain('Import-Module -Name $utilityModulePath -ErrorAction Stop');
    expect(script.indexOf('Import-Module -Name $utilityModulePath -ErrorAction Stop'))
      .toBeLessThan(script.indexOf('$srcHash = (Get-FileHash'));
    expect(script.indexOf('Import-Module -Name $securityModulePath -ErrorAction Stop'))
      .toBeLessThan(script.indexOf('Get-AuthenticodeSignature -LiteralPath $srcRemoteDesktopExe'));
    expect(script).toContain('[System.Management.Automation.SignatureStatus]::Valid');
    expect(script).toContain('remote desktop worker signer mismatch');
    expect(script).toContain('authenticodeSignerSha256');
    expect(script).toContain('THIRD_PARTY_NOTICES.webrtc.md');
    expect(script.indexOf('remote desktop worker Authenticode verification failed'))
      .toBeLessThan(script.indexOf('Stop-ScheduledTask -TaskName $task'));
    expect(script).toContain('remote desktop copied artifact hash mismatch');
    expect(script).toContain('remote desktop worker signer is not trusted by this controlled node build');
    expect(script).toContain('remote desktop artifact root contains unexpected entries');
    expect(script).toContain('virtual display package contains unexpected entries');
    expect(script).toContain('& $verifyRemoteDesktopArtifactSet $pendingRemoteDesktop');
    expect(script).toContain('& $verifyRemoteDesktopArtifactSet $dstRemoteDesktop');
    expect(script.indexOf('& $verifyRemoteDesktopArtifactSet $pendingRemoteDesktop'))
      .toBeLessThan(script.indexOf('Move-Item -Force $pendingRemoteDesktop $dstRemoteDesktop'));
    expect(script.indexOf('& $verifyRemoteDesktopArtifactSet $dstRemoteDesktop'))
      .toBeLessThan(script.indexOf('/add-driver $virtualDisplayInf /install'));
    expect(script.indexOf("'System32\\icacls.exe') 'C:\\ProgramData\\imcodes-node\\remote-desktop-worker.new' '/inheritance:r'"))
      .toBeLessThan(script.indexOf("Copy-Item -Recurse -Force -Path (Join-Path $srcRemoteDesktop '*')"));
    expect(script).toContain("if ($aclExitCode -ne 0) { throw 'Windows ACL hardening failed' }");
    expect(script).toContain('controlled node release manifest does not match the staged executable');
    expect(script).toContain('controlled node published manifest hash mismatch');
    expect(script).toContain('$dstRemoteDesktop.upgrade-old');
    expect(script).toContain('controlled node upgrade failed authenticated health verification');
    expect(script).toContain("status = 'success'");
    expect(script).toContain("{ 'rolled_back' } else { 'rollback_failed' }");
    expect(script).toContain("status = 'preflight_failed'");
    expect(script).not.toContain('$verifyLegacyUnsignedArtifact');
    expect(script).toContain("$currentMainHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dst).Hash.ToLowerInvariant()");
    expect(script).toContain('controlled node rollback source hash mismatch');
    expect(script.indexOf('& $verifyReleaseArtifact $src'))
      .toBeLessThan(script.indexOf('Stop-ScheduledTask -TaskName $task'));
    expect(script.indexOf("Unregister-ScheduledTask -TaskName 'imcodes-node-upgrade-test'"))
      .toBeLessThan(script.indexOf('Stop-ScheduledTask -TaskName $task'));
    expect(script).toContain('if ($failureMessage.Length -gt 240)');
    expect(script).toContain('[int64]$lease.updatedAt -ge $upgradeStartedAt');
    expect(script).toContain('if ($remoteDesktopPublished -and (Test-Path $dstRemoteDesktop))');
    expect(script).toContain('Move-Item -Force $backupRemoteDesktop $dstRemoteDesktop');
    expect(script).toContain("Get-WindowsDriver -Online -All | Where-Object { [IO.Path]::GetFileName([string]$_.OriginalFileName) -ceq 'imcodes-virtual-display.inf'");
    expect(script).toContain("[string]$_.ProviderName -ceq 'IM.codes'");
    expect(script).toContain('$newVirtualDisplayDrivers.Count -gt 1');
    expect(script).toContain('$driverInstallExitCode -ne 3010');
    expect(script).toContain("& $runRecovery 'restore_main'");
    expect(script).toContain("& $runRecovery 'restore_driver'");
    expect(script).toContain('controlled node backup hash mismatch');
    expect(script).toContain('& $verifyRemoteDesktopArtifactSet $dstRemoteDesktop $rollbackRemoteDesktopWorkerHash');
    expect(script).toContain("status = $rollbackStatus");
    expect(script).toContain("'rollback_failed'");
    expect(script).toContain("-cmatch '^oem[0-9]+\\.inf$'");
    expect(script).toContain('/delete-driver ([string]$newVirtualDisplayDriver.Driver) /uninstall /force');
    expect(script.indexOf('/delete-driver ([string]$newVirtualDisplayDriver.Driver)'))
      .toBeLessThan(script.indexOf('/add-driver $rollbackVirtualDisplayInf /install'));
  });

  it('escapes the one-shot upgrade script path in Task Scheduler XML', () => {
    const xml = windowsControlledNodeUpgradeTaskXml('C:\\Windows\\Temp\\a&b<1>\\upgrade.ps1');
    expect(xml).toContain('a&amp;b&lt;1&gt;');
    expect(xml).toContain('<Triggers />');
    expect(xml).toContain('<AllowHardTerminate>false</AllowHardTerminate>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<Command>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>');
  });

  it('registers and starts the one-shot task, deleting it if start fails', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    scheduleWindowsControlledNodeUpgrade('upgrade-ok', 'C:\\tmp\\upgrade.xml', (file, args) => {
      calls.push({ file, args });
    });
    expect(calls).toEqual([
      { file: 'schtasks.exe', args: ['/Create', '/TN', 'upgrade-ok', '/XML', 'C:\\tmp\\upgrade.xml', '/F'] },
      { file: 'schtasks.exe', args: ['/Run', '/TN', 'upgrade-ok'] },
    ]);

    const failedCalls: Array<{ file: string; args: readonly string[] }> = [];
    expect(() => scheduleWindowsControlledNodeUpgrade('upgrade-fail', 'C:\\tmp\\upgrade.xml', (file, args) => {
      failedCalls.push({ file, args });
      if (args[0] === '/Run') throw new Error('run failed');
    })).toThrow('run failed');
    expect(failedCalls.at(-1)).toEqual({
      file: 'schtasks.exe',
      args: ['/Delete', '/TN', 'upgrade-fail', '/F'],
    });
  });

  it('starts Linux replacement in a transient unit outside the node service cgroup', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    scheduleLinuxControlledNodeUpgrade('imcodes-node-upgrade-test', '/tmp/upgrade.sh', (file, args) => {
      calls.push({ file, args });
    });
    expect(calls).toEqual([{
      file: 'systemd-run',
      args: [
        '--unit=imcodes-node-upgrade-test',
        '--collect',
        '--no-block',
        '--property=Type=oneshot',
        '--property=TimeoutStartSec=10min',
        '/bin/sh',
        '/tmp/upgrade.sh',
      ],
    }]);
  });

  it.each([
    ['linux', 'systemctl stop imcodes-node.service', 'systemctl start imcodes-node.service'],
    ['darwin', 'launchctl bootout system/cc.imcodes.node', "launchctl bootstrap system '/Library/LaunchDaemons/cc.imcodes.node.plist'"],
  ] as const)('builds a detached %s upgrader that replaces the binary before restarting the boot service', (platform, stop, start) => {
    const script = buildPosixControlledNodeUpgradeScript({
      platform,
      stagedArtifactPath: `/tmp/update-${platform}/imcodes-node`,
      stagedManifestPath: `/tmp/update-${platform}/imcodes-node.manifest.json`,
      stagedJournalPath: `/tmp/update-${platform}/install-journal.json`,
      destinationPath: '/opt/imcodes-node/imcodes-node',
      destinationManifestPath: '/opt/imcodes-node/imcodes-node.manifest.json',
      destinationJournalPath: '/opt/imcodes-node/install-journal.json',
    });
    expect(script).toContain(stop);
    expect(script).toContain("cp -f '/tmp/update-");
    expect(script).toContain(start);

    // The destination MUST be published by rename(2), never overwritten in
    // place: `cp -f` rewrites the existing inode, and macOS binds code-signing
    // state to it, so an in-place overwrite of the still-mapped running node
    // leaves bytes that no longer match the validated signature — every exec is
    // then SIGKILLed (OS_REASON_CODESIGNING) and launchd respawns forever.
    expect(script).toContain("mv -f '/opt/imcodes-node/imcodes-node.new' '/opt/imcodes-node/imcodes-node'");
    expect(script).toContain("cp -f '/tmp/update-" + platform + "/imcodes-node' '/opt/imcodes-node/imcodes-node.new'");
    // The live binary is never a `cp` target.
    expect(script).not.toContain("cp -f '/tmp/update-" + platform + "/imcodes-node' '/opt/imcodes-node/imcodes-node'");
    // chmod applies to the pending file, before it is published.
    expect(script).toContain("chmod 755 '/opt/imcodes-node/imcodes-node.new'");
    // The manifest must not vouch for a binary that never got published.
    expect(script.indexOf('mv -f')).toBeLessThan(script.indexOf('imcodes-node.manifest.json'));
    if (platform === 'darwin') {
      expect(script).toContain('launchctl bootout system/cc.imcodes.node.watchdog');
      expect(script).toContain("launchctl bootstrap system '/Library/LaunchDaemons/cc.imcodes.node.watchdog.plist'");
      expect(script.indexOf('bootout system/cc.imcodes.node.watchdog'))
        .toBeLessThan(script.indexOf('bootout system/cc.imcodes.node\n'));
    }
  });

  it('refuses to publish a macOS binary the kernel would kill, and leaves the old one intact', () => {
    const script = buildPosixControlledNodeUpgradeScript({
      platform: 'darwin',
      stagedArtifactPath: '/tmp/stage/imcodes-node-macos',
      stagedManifestPath: '/tmp/stage/imcodes-node-macos.manifest.json',
      destinationPath: '/opt/imcodes-node/imcodes-node-macos',
      destinationManifestPath: '/opt/imcodes-node/imcodes-node-macos.manifest.json',
    });
    // Verify BEFORE the rename, so a bad artifact never becomes the live binary.
    expect(script).toContain("codesign --verify '/opt/imcodes-node/imcodes-node-macos.new'");
    expect(script).toContain("grep -q 'Mach-O'");
    expect(script.indexOf('codesign --verify')).toBeLessThan(script.indexOf('mv -f'));
    // A failed verify drops the pending file and skips publishing; the untouched
    // previous binary is then simply bootstrapped back = free rollback.
    expect(script).toContain("rm -f '/opt/imcodes-node/imcodes-node-macos.new'; SKIP=1");
    expect(script).toContain('launchctl bootstrap system');
  });

  it('does not gate the linux upgrade on codesign (macOS-only tool)', () => {
    const script = buildPosixControlledNodeUpgradeScript({
      platform: 'linux',
      stagedArtifactPath: '/tmp/stage/imcodes-node-linux',
      stagedManifestPath: '/tmp/stage/imcodes-node-linux.manifest.json',
      destinationPath: '/opt/imcodes-node/imcodes-node-linux',
      destinationManifestPath: '/opt/imcodes-node/imcodes-node-linux.manifest.json',
    });
    expect(script).not.toContain('codesign');
    // rename(2) still matters on linux: writing a running binary fails ETXTBSY,
    // which `set +e` would otherwise swallow into a silently skipped upgrade.
    expect(script).toContain("mv -f '/opt/imcodes-node/imcodes-node-linux.new' '/opt/imcodes-node/imcodes-node-linux'");
  });

  it.runIf(['win32', 'darwin', 'linux'].includes(process.platform))('executes the native replacement script against an isolated destination and service-manager stub', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-native-upgrade-script-'));
    dirs.push(dir);
    const stagedArtifactPath = join(dir, process.platform === 'win32' ? 'staged-node.exe' : 'staged-node');
    const stagedManifestPath = `${stagedArtifactPath}.manifest.json`;
    const destinationPath = join(dir, process.platform === 'win32' ? 'installed-node.exe' : 'installed-node');
    const destinationManifestPath = `${destinationPath}.manifest.json`;
    const logPath = join(dir, 'service.log');
    await writeFile(stagedArtifactPath, 'new-native-artifact', { mode: 0o755 });
    await writeFile(stagedManifestPath, JSON.stringify({ build: { version: '2026.7.9999-dev.42' } }));
    await writeFile(destinationPath, 'old-native-artifact', { mode: 0o755 });

    if (process.platform === 'win32') {
      const generated = buildWindowsControlledNodeUpgradeScript({
        stagedArtifactPath,
        stagedManifestPath,
        destinationPath,
        destinationManifestPath,
      });
      const harnessPath = join(dir, 'upgrade-harness.ps1');
      const quotedLog = logPath.replaceAll("'", "''");
      await writeFile(harnessPath, [
        `function Start-Sleep { param([int]$Seconds) }`,
        `function Stop-ScheduledTask { param($TaskName, $ErrorAction); Add-Content -LiteralPath '${quotedLog}' -Value "stop:$TaskName" }`,
        `function Enable-ScheduledTask { param($TaskName, $ErrorAction); Add-Content -LiteralPath '${quotedLog}' -Value "enable:$TaskName" }`,
        `function Start-ScheduledTask { param($TaskName); Add-Content -LiteralPath '${quotedLog}' -Value "start:$TaskName" }`,
        'function Get-CimInstance { param($ClassName, $Filter); @() }',
        generated,
      ].join('\r\n'));
      await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath], { timeout: 30_000 });
    } else {
      const binDir = join(dir, 'bin');
      await mkdir(binDir);
      await writeFile(join(binDir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const manager = process.platform === 'darwin' ? 'launchctl' : 'systemctl';
      await writeFile(join(binDir, manager), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$IMCODES_UPGRADE_TEST_LOG"\n', { mode: 0o755 });
      await chmod(join(binDir, 'sleep'), 0o755);
      await chmod(join(binDir, manager), 0o755);
      const scriptPath = join(dir, 'upgrade.sh');
      await writeFile(scriptPath, buildPosixControlledNodeUpgradeScript({
        platform: process.platform,
        stagedArtifactPath,
        stagedManifestPath,
        destinationPath,
        destinationManifestPath,
      }), { mode: 0o755 });
      await execFileAsync('/bin/sh', [scriptPath], {
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          IMCODES_UPGRADE_TEST_LOG: logPath,
        },
      });
    }

    expect(await readFile(destinationPath, 'utf8')).toBe('new-native-artifact');
    expect(JSON.parse(await readFile(destinationManifestPath, 'utf8'))).toMatchObject({
      build: { version: '2026.7.9999-dev.42' },
    });
    const serviceLog = await readFile(logPath, 'utf8');
    if (process.platform === 'darwin') {
      expect(serviceLog).toContain('bootout system/cc.imcodes.node.watchdog');
      expect(serviceLog).toContain('bootout system/cc.imcodes.node');
      expect(serviceLog).toContain('bootstrap system /Library/LaunchDaemons/cc.imcodes.node.plist');
      expect(serviceLog).toContain('bootstrap system /Library/LaunchDaemons/cc.imcodes.node.watchdog.plist');
    } else {
      expect(serviceLog).toContain('stop');
      expect(serviceLog).toContain('start');
    }
  });
});
