import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { CONTROLLED_NODE_ARTIFACT_ASSETS, CONTROLLED_NODE_ARTIFACT_HEADERS, CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH } from '../../shared/controlled-node-artifacts.js';
import {
  buildWindowsControlledNodeUpgradeScript,
  controlledNodeArtifactTarget,
  controlledNodeArtifactUpgradeUrl,
  startControlledNodeSelfUpgrade,
} from '../../src/node/self-upgrade.js';

const dirs: string[] = [];
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
});
