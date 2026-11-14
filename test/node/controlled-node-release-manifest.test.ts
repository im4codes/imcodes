import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  }: {
    version: string;
    overrideNodeShaInReleaseManifest?: string;
    overrideDaemonRuntimeVersion?: string;
    tamperManifestShaHeader?: boolean;
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
      return new Response(nodeBytes, {
        status: 200,
        headers: {
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: sha256(nodeBytes),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(nodeBytes.length),
          [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: 'imcodes-node-linux',
          [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
          [CONTROLLED_NODE_ARTIFACT_HEADERS.RELEASE_MANIFEST_SHA256]: rmSha,
        },
      });
    });

    return { fetchImpl, nodeSha: sha256(nodeBytes) };
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
});
