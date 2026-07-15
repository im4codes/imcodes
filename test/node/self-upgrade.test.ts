import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { CONTROLLED_NODE_ARTIFACT_ASSETS, CONTROLLED_NODE_ARTIFACT_HEADERS, CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH } from '../../shared/controlled-node-artifacts.js';
import {
  buildPosixControlledNodeUpgradeScript,
  buildWindowsControlledNodeUpgradeScript,
  controlledNodeArtifactTarget,
  controlledNodeArtifactUpgradeUrl,
  startControlledNodeSelfUpgrade,
} from '../../src/node/self-upgrade.js';

const dirs: string[] = [];
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
    expect(controlledNodeArtifactTarget('darwin', 'arm64')).toEqual({ os: 'mac', arch: 'arm64' });
    expect(controlledNodeArtifactTarget('linux', 'x64')).toEqual({ os: 'linux', arch: 'x64' });
    expect(controlledNodeArtifactTarget('win32', 'arm64')).toBeNull();
  });

  it('builds the node-token artifact URL with serverId, os, and arch', () => {
    const url = controlledNodeArtifactUpgradeUrl(credential, { os: 'win', arch: 'x64' });
    expect(url).toBe(`https://im.example${CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH}?serverId=srv-1&os=win&arch=x64`);
    const helperUrl = controlledNodeArtifactUpgradeUrl(credential, { os: 'win', arch: 'x64' }, CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER);
    expect(helperUrl).toBe(`https://im.example${CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH}?serverId=srv-1&os=win&arch=x64&asset=computer-use-helper`);
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
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret-token', 'X-Server-Id': 'srv-1' });
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
        },
      });
    });
    const spawned: Array<{ file: string; args: readonly string[] }> = [];
    const result = await startControlledNodeSelfUpgrade(credential, '2026.7.1', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      journalPath,
      tmpdir: () => dir,
      now: () => 9,
      spawnDetached: (file, args) => { spawned.push({ file, args }); },
    });

    expect(result).toMatchObject({ ok: true, targetVersion: '2026.7.1', artifactSha256: sha256 });
    expect(spawned).toEqual([{ file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', result.scriptPath!] }]);
    const script = await readFile(result.scriptPath!, 'utf8');
    expect(script).toContain('Stop-ScheduledTask');
    expect(script).toContain('Start-ScheduledTask');
    expect(script).toContain('Copy-Item -Force $src $dst');
    expect(script).toContain('computer-use-helper');
    expect(script).toContain('Copy-Item -Recurse -Force -Path (Join-Path $srcHelper');
    expect(script).toContain('install-journal.json');
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

  it.each([
    ['linux', 'systemctl stop imcodes-node.service', 'systemctl start imcodes-node.service'],
    ['darwin', 'launchctl bootout system/cc.imcodes.node', 'launchctl bootstrap system /Library/LaunchDaemons/cc.imcodes.node.plist'],
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
    expect(script).toContain("chmod 755 '/opt/imcodes-node/imcodes-node'");
    expect(script).toContain(start);
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
      expect(serviceLog).toContain('bootout system/cc.imcodes.node');
      expect(serviceLog).toContain('bootstrap system /Library/LaunchDaemons/cc.imcodes.node.plist');
    } else {
      expect(serviceLog).toContain('stop');
      expect(serviceLog).toContain('start');
    }
  });
});
