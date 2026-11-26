import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
} from '../../shared/controlled-node-artifacts.js';
import { REMOTE_DESKTOP_LINUX_WORKER_FILENAME, REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX } from '../../shared/remote-desktop-worker.js';
import { startControlledNodeSelfUpgrade } from '../../src/node/self-upgrade.js';

const dirs: string[] = [];

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('controlled-node self-upgrade release manifest verification', () => {
  function setupLinuxReleaseFetch({
    version,
    overrideNodeShaInReleaseManifest,
    overrideDaemonRuntimeVersion,
    tamperManifestShaHeader,
    computerUseHelperMode = 'ok',
    remoteDesktopMode = 'ok',
    omitReleaseManifestHeader = false,
  }: {
    version: string;
    overrideNodeShaInReleaseManifest?: string;
    overrideDaemonRuntimeVersion?: string;
    tamperManifestShaHeader?: boolean;
    computerUseHelperMode?: 'ok' | 'missing_404' | 'filename_mismatch';
    remoteDesktopMode?: 'ok' | 'missing_404';
    omitReleaseManifestHeader?: boolean;
  }) {
    const nodeBytes = Buffer.from(`node-bin-${version}`, 'utf8');
    const helperBytes = Buffer.from(`helper-bin-${version}`, 'utf8');
    const rdBytes = Buffer.from(`rd-bin-${version}`, 'utf8');
    const rdManifest = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      artifact: {
        fileName: REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
        os: 'linux',
        arch: 'x64',
        size: rdBytes.length,
        sha256: sha256(rdBytes),
      },
      build: { source: 'test', version },
    }), 'utf8');

    const releaseManifest = {
      schemaVersion: 1,
      releaseVersion: version,
      gitSha: 'abcdef1234567',
      generatedAt: new Date().toISOString(),
      targets: {
        'linux-x64': {
          target: 'linux-x64',
          os: 'linux',
          arch: 'x64',
          components: {
            'imcodes-node': {
              component: 'imcodes-node',
              version,
              fileName: 'imcodes-node-linux',
              sha256: overrideNodeShaInReleaseManifest ?? sha256(nodeBytes),
              sizeBytes: nodeBytes.length,
              compat: { os: 'linux', arch: 'x64' },
            },
            'remote-desktop': {
              component: 'remote-desktop',
              version,
              fileName: REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
              sha256: sha256(rdBytes),
              sizeBytes: rdBytes.length,
              compat: { os: 'linux', arch: 'x64', protocolVersion: 2 },
            },
            'open-computer-use': {
              component: 'open-computer-use',
              version,
              fileName: 'open-computer-use',
              sha256: sha256(helperBytes),
              sizeBytes: helperBytes.length,
              compat: { os: 'linux', arch: 'x64' },
            },
            'daemon-runtime': {
              component: 'daemon-runtime',
              version: overrideDaemonRuntimeVersion ?? version,
              fileName: 'daemon-runtime-linux-x64.tar.gz',
              sha256: 'f'.repeat(64),
              sizeBytes: 999,
              compat: { os: 'linux', arch: 'x64', nodeVersion: 'v24.16.0' },
            },
          },
        },
      },
    };
    const rmBytes = Buffer.from(JSON.stringify(releaseManifest), 'utf8');
    const rmSha = sha256(rmBytes);

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DESKTOP_RELEASE_MANIFEST}`)) {
        return new Response(rmBytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: tamperManifestShaHeader ? '0'.repeat(64) : rmSha,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(rmBytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'desktop-release-linux-x64.manifest.json',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
          },
        });
      }
      if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER}`)) {
        if (computerUseHelperMode === 'missing_404') {
          return new Response('not found', { status: 404 });
        }
        if (computerUseHelperMode === 'filename_mismatch') {
          return new Response(helperBytes, {
            status: 200,
            headers: {
              [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(helperBytes),
              [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(helperBytes.length),
              [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'wrong-helper-name',
            },
          });
        }
        return new Response(helperBytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(helperBytes),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(helperBytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'open-computer-use',
          },
        });
      }
      if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST}`)) {
        if (remoteDesktopMode === 'missing_404') {
          return new Response('not found', { status: 404 });
        }
        return new Response(rdManifest, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(rdManifest),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(rdManifest.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: `${REMOTE_DESKTOP_LINUX_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
          },
        });
      }
      if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER}`)) {
        if (remoteDesktopMode === 'missing_404') {
          return new Response('not found', { status: 404 });
        }
        return new Response(rdBytes, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(rdBytes),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(rdBytes.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
          },
        });
      }
      const nodeHeaders: Record<string, string> = {
        [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(nodeBytes),
        [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(nodeBytes.length),
        [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node-linux',
        [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
      };
      if (!omitReleaseManifestHeader) {
        nodeHeaders[CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256] = rmSha;
      }
      return new Response(nodeBytes, {
        status: 200,
        headers: nodeHeaders,
      });
    });

    return { fetchImpl, nodeSha: sha256(nodeBytes), helperBytes };
  }

  it('verifies all controlled components and 4-component release manifest alignment before scheduling upgrade', async () => {
    const dir = makeTempDir('cn-rm-ok-');
    const journalPath = join(dir, 'install-journal.json');
    const version = '2026.5.3200';
    const { fetchImpl, nodeSha } = setupLinuxReleaseFetch({ version });
    const scheduled: string[] = [];

    const res = await startControlledNodeSelfUpgrade(
      { serverUrl: 'https://im.example', serverId: 'srv-1', token: 'tok', nodeId: '1234567890' } as never,
      version,
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        platform: 'linux',
        arch: 'x64',
        execPath: '/usr/local/bin/imcodes-node',
        journalPath,
        tmpdir: () => dir,
        scheduleLinuxUpgrade: (_unit, scriptPath) => { scheduled.push(scriptPath); },
        sleep: async () => {},
      },
    );

    expect(res).toMatchObject({ ok: true, targetVersion: version, artifactSha256: nodeSha });
    expect(scheduled).toHaveLength(1);
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('asset=desktop-release-manifest'))).toBe(true);
  });

  it('aborts upgrade before scheduling when release manifest sha256, component sha256, or 4-component version fails alignment', async () => {
    const dir = makeTempDir('cn-rm-fail-');
    const journalPath = join(dir, 'install-journal.json');
    const version = '2026.5.3200';

    const credential = { serverUrl: 'https://im.example', serverId: 'srv-1', token: 'tok', nodeId: '1234567890' } as never;
    const baseOpts = {
      platform: 'linux' as const,
      arch: 'x64' as const,
      execPath: '/usr/local/bin/imcodes-node',
      journalPath,
      tmpdir: () => dir,
      scheduleLinuxUpgrade: vi.fn(),
      sleep: async () => {},
    };

    await expect(startControlledNodeSelfUpgrade(credential, version, {
      ...baseOpts,
      fetchImpl: setupLinuxReleaseFetch({ version, overrideNodeShaInReleaseManifest: 'e'.repeat(64) }).fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/release_manifest_imcodes-node_sha256_mismatch/);

    await expect(startControlledNodeSelfUpgrade(credential, version, {
      ...baseOpts,
      fetchImpl: setupLinuxReleaseFetch({ version, overrideDaemonRuntimeVersion: '2026.5.3199' }).fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/is not aligned with releaseVersion/);

    await expect(startControlledNodeSelfUpgrade(credential, version, {
      ...baseOpts,
      fetchImpl: setupLinuxReleaseFetch({ version, tamperManifestShaHeader: true }).fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/release_manifest_sha256_mismatch/);

    expect(baseOpts.scheduleLinuxUpgrade).not.toHaveBeenCalled();
  });

  it('[F7] rejects missing or mismatched open-computer-use and remote-desktop under unified release manifest, while allowing verified on-disk helper match and legacy non-manifest fallback', async () => {
    const version = '2026.5.3200';
    const credential = { serverUrl: 'https://im.example', serverId: 'srv-1', token: 'tok', nodeId: '1234567890' } as never;

    // 1. OCU returns 404 and no matching helper on disk -> fails cleanly, nothing scheduled
    const dirMissingOcu = makeTempDir('cn-rm-f7-noocu-');
    const scheduled1: string[] = [];
    await expect(startControlledNodeSelfUpgrade(credential, version, {
      platform: 'linux',
      arch: 'x64',
      execPath: join(dirMissingOcu, 'imcodes-node'),
      journalPath: join(dirMissingOcu, 'install-journal.json'),
      tmpdir: () => dirMissingOcu,
      scheduleLinuxUpgrade: (_u, s) => { scheduled1.push(s); },
      sleep: async () => {},
      fetchImpl: setupLinuxReleaseFetch({ version, computerUseHelperMode: 'missing_404' }).fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/release_manifest_missing_required_component:open-computer-use/);
    expect(scheduled1).toHaveLength(0);

    // 2. OCU filename mismatch MUST fail even when matching helper exists on disk
    const dirMismatch = makeTempDir('cn-rm-f7-mismatch-');
    const scheduled2: string[] = [];
    const { fetchImpl: mismatchFetch, helperBytes } = setupLinuxReleaseFetch({
      version,
      computerUseHelperMode: 'filename_mismatch',
    });
    const onDiskHelperDir2 = join(dirMismatch, 'computer-use-helper', 'linux-x64');
    mkdirSync(onDiskHelperDir2, { recursive: true });
    writeFileSync(join(onDiskHelperDir2, 'open-computer-use'), helperBytes);
    await expect(startControlledNodeSelfUpgrade(credential, version, {
      platform: 'linux',
      arch: 'x64',
      execPath: join(dirMismatch, 'imcodes-node'),
      journalPath: join(dirMismatch, 'install-journal.json'),
      tmpdir: () => dirMismatch,
      scheduleLinuxUpgrade: (_u, s) => { scheduled2.push(s); },
      sleep: async () => {},
      fetchImpl: mismatchFetch as unknown as typeof fetch,
    })).rejects.toThrow(/artifact_filename_mismatch/);
    expect(scheduled2).toHaveLength(0);

    // 3. OCU returns 404 while matching on-disk helper bytes match release manifest -> allowed; tampered on-disk helper -> refused
    const dirDiskOk = makeTempDir('cn-rm-f7-diskok-');
    const scheduled3: string[] = [];
    const onDiskHelperDir3 = join(dirDiskOk, 'computer-use-helper', 'linux-x64');
    mkdirSync(onDiskHelperDir3, { recursive: true });
    const onDiskHelperPath = join(onDiskHelperDir3, 'open-computer-use');
    writeFileSync(onDiskHelperPath, helperBytes);
    const okDiskRes = await startControlledNodeSelfUpgrade(credential, version, {
      platform: 'linux',
      arch: 'x64',
      execPath: join(dirDiskOk, 'imcodes-node'),
      journalPath: join(dirDiskOk, 'install-journal.json'),
      tmpdir: () => dirDiskOk,
      scheduleLinuxUpgrade: (_u, s) => { scheduled3.push(s); },
      sleep: async () => {},
      fetchImpl: setupLinuxReleaseFetch({ version, computerUseHelperMode: 'missing_404' }).fetchImpl as unknown as typeof fetch,
    });
    expect(okDiskRes).toMatchObject({ ok: true, targetVersion: version });
    expect(scheduled3).toHaveLength(1);

    // Tampered on-disk helper hash fails under same 404 condition
    writeFileSync(onDiskHelperPath, Buffer.from('tampered-helper', 'utf8'));
    const scheduled3b: string[] = [];
    await expect(startControlledNodeSelfUpgrade(credential, version, {
      platform: 'linux',
      arch: 'x64',
      execPath: join(dirDiskOk, 'imcodes-node'),
      journalPath: join(dirDiskOk, 'install-journal2.json'),
      tmpdir: () => dirDiskOk,
      scheduleLinuxUpgrade: (_u, s) => { scheduled3b.push(s); },
      sleep: async () => {},
      fetchImpl: setupLinuxReleaseFetch({ version, computerUseHelperMode: 'missing_404' }).fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/release_manifest_missing_required_component:open-computer-use/);
    expect(scheduled3b).toHaveLength(0);

    // 4. Missing remote-desktop under unified release manifest fails cleanly (both Linux x64 404 and unsupported/404-returning undefined path)
    const dirNoRd = makeTempDir('cn-rm-f7-nord-');
    const scheduled4: string[] = [];
    await expect(startControlledNodeSelfUpgrade(credential, version, {
      platform: 'linux',
      arch: 'x64',
      execPath: join(dirNoRd, 'imcodes-node'),
      journalPath: join(dirNoRd, 'install-journal.json'),
      tmpdir: () => dirNoRd,
      scheduleLinuxUpgrade: (_u, s) => { scheduled4.push(s); },
      sleep: async () => {},
      fetchImpl: setupLinuxReleaseFetch({ version, remoteDesktopMode: 'missing_404' }).fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/download_failed_404|release_manifest_missing_required_component:remote-desktop/);
    expect(scheduled4).toHaveLength(0);

    // Explicitly verify the release_manifest_missing_required_component:remote-desktop guard when Windows remote-desktop returns 404/undefined
    const nodeBytesWin = Buffer.from(`node-win64-${version}`, 'utf8');
    const ocuBytesWin = Buffer.from(`ocu-win64-${version}`, 'utf8');
    const rmWin = {
      schemaVersion: 1,
      releaseVersion: version,
      gitSha: 'abcdef1234567',
      generatedAt: new Date().toISOString(),
      targets: {
        'win32-x64': {
          target: 'win32-x64',
          os: 'win32',
          arch: 'x64',
          components: {
            'imcodes-node': {
              component: 'imcodes-node',
              version,
              fileName: 'imcodes-node.exe',
              sha256: sha256(nodeBytesWin),
              sizeBytes: nodeBytesWin.length,
              compat: { os: 'win32', arch: 'x64' },
            },
            'open-computer-use': {
              component: 'open-computer-use',
              version,
              fileName: 'open-computer-use.exe',
              sha256: sha256(ocuBytesWin),
              sizeBytes: ocuBytesWin.length,
              compat: { os: 'win32', arch: 'x64' },
            },
            'remote-desktop': {
              component: 'remote-desktop',
              version,
              fileName: 'imcodes-remote-desktop-worker.exe',
              sha256: 'd'.repeat(64),
              sizeBytes: 100,
              compat: { os: 'win32', arch: 'x64', protocolVersion: 2 },
            },
            'daemon-runtime': {
              component: 'daemon-runtime',
              version,
              fileName: 'daemon-runtime-win32-x64.zip',
              sha256: 'f'.repeat(64),
              sizeBytes: 999,
              compat: { os: 'win32', arch: 'x64', nodeVersion: 'v24.16.0' },
            },
          },
        },
      },
    };
    const rmWinBytes = Buffer.from(JSON.stringify(rmWin), 'utf8');
    const rmWinSha = sha256(rmWinBytes);
    const dirNoRdWin = makeTempDir('cn-rm-f7-nord-win-');
    const scheduled4b: string[] = [];
    await expect(startControlledNodeSelfUpgrade(credential, version, {
      platform: 'win32',
      arch: 'x64',
      execPath: join(dirNoRdWin, 'imcodes-node.exe'),
      journalPath: join(dirNoRdWin, 'install-journal.json'),
      tmpdir: () => dirNoRdWin,
      scheduleWindowsUpgrade: async () => { scheduled4b.push('win'); },
      sleep: async () => {},
      fetchImpl: (async (url: string) => {
        if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.DESKTOP_RELEASE_MANIFEST}`)) {
          return new Response(rmWinBytes, {
            status: 200,
            headers: {
              [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: rmWinSha,
              [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(rmWinBytes.length),
              [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'desktop-release-win32-x64.manifest.json',
              [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
            },
          });
        }
        if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER}`)) {
          return new Response(ocuBytesWin, {
            status: 200,
            headers: {
              [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(ocuBytesWin),
              [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(ocuBytesWin.length),
              [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'open-computer-use.exe',
              [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: 'c'.repeat(64),
            },
          });
        }
        if (url.includes(`asset=${CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER}`)) {
          return new Response('not found', { status: 404 });
        }
        return new Response(nodeBytesWin, {
          status: 200,
          headers: {
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(nodeBytesWin),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(nodeBytesWin.length),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node.exe',
            [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
            [CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256]: 'c'.repeat(64),
            [CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256]: rmWinSha,
          },
        });
      }) as unknown as typeof fetch,
    })).rejects.toThrow(/download_failed_404|release_manifest_missing_required_component:remote-desktop/);
    expect(scheduled4b).toHaveLength(0);

    // 5. Legacy non-manifest endpoint (no RELEASE_MANIFEST_SHA256 header) still allows missing OCU 404
    const dirLegacy = makeTempDir('cn-rm-f7-legacy-');
    const scheduled5: string[] = [];
    const legacyRes = await startControlledNodeSelfUpgrade(credential, version, {
      platform: 'linux',
      arch: 'x64',
      execPath: join(dirLegacy, 'imcodes-node'),
      journalPath: join(dirLegacy, 'install-journal.json'),
      tmpdir: () => dirLegacy,
      scheduleLinuxUpgrade: (_u, s) => { scheduled5.push(s); },
      sleep: async () => {},
      fetchImpl: setupLinuxReleaseFetch({
        version,
        computerUseHelperMode: 'missing_404',
        omitReleaseManifestHeader: true,
      }).fetchImpl as unknown as typeof fetch,
    });
    expect(legacyRes).toMatchObject({ ok: true, targetVersion: version });
    expect(scheduled5).toHaveLength(1);
  });
});
