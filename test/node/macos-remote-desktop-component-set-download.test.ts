import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REMOTE_DESKTOP_MACOS_COMPONENT_ORDER,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_MACOS_TEAM_ID,
  encodeRemoteDesktopMacosComponentSetPrefix,
  remoteDesktopMacosComponentSetFilename,
} from '../../shared/remote-desktop-worker.js';
import { CONTROLLED_NODE_ARTIFACT_HEADERS } from '../../shared/controlled-node-artifacts.js';
import { appleDesignatedRequirement } from '../../shared/macos-code-requirement.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from '../../shared/remote-desktop-qualification.js';
import { downloadControlledNodeMacosRemoteDesktopComponentSet } from '../../src/node/self-upgrade.js';

const WORKER_VERSION = '1.2.3';
const BUNDLE_IDENTIFIERS = {
  worker: 'cc.imcodes.node.remote-desktop-worker',
  launchAgent: 'cc.imcodes.node.remote-desktop-agent',
  disclosure: 'cc.imcodes.node.remote-desktop-disclosure',
  virtualDisplayHelper: 'cc.imcodes.node.virtual-display-helper',
} as const;
const FILE_NAMES = {
  worker: 'imcodes-remote-desktop-worker',
  launchAgent: 'imcodes-remote-desktop-launch-agent',
  disclosure: 'imcodes-remote-desktop-disclosure',
  virtualDisplayHelper: 'imcodes-virtual-display-helper',
} as const;

/** Distinct per component, so a mis-sliced boundary cannot look correct. */
function componentBytes(kind: keyof typeof FILE_NAMES, index: number): Buffer {
  return Buffer.alloc(4096 + index * 137, 0x41 + index);
}

function buildSet(arch: 'arm64' | 'x64', overrides: { truncate?: number } = {}) {
  const components = Object.fromEntries(
    REMOTE_DESKTOP_MACOS_COMPONENT_ORDER.map((kind, index) => {
      const bytes = componentBytes(kind, index);
      return [kind, {
        fileName: FILE_NAMES[kind],
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        notarization: {
          status: 'accepted',
          // A real notary submission id: the validator requires a v1-v5
          // UUID with a proper variant nibble, so the nil UUID is refused.
          submissionId: `174c4c13-fbba-4810-a4a5-aa2e6c6d246${index}`,
          ticketSha256: createHash('sha256').update(bytes).digest('hex'),
          stapled: false,
          stapleValidated: false,
          unstapledReason: 'artifact_format_cannot_carry_a_ticket',
        },
      }];
    }),
  );
  const manifest = {
    manifestVersion: 4,
    artifactKind: 'macos-component-set',
    workerVersion: WORKER_VERSION,
    protocolVersion: 2,
    ipcVersion: 1,
    os: 'darwin',
    arch,
    components,
    libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
    minimumOsVersion: '12.3',
    codeSignature: {
      teamId: REMOTE_DESKTOP_MACOS_TEAM_ID,
      bundles: Object.fromEntries(REMOTE_DESKTOP_MACOS_COMPONENT_ORDER.map((kind) => [kind, {
        bundleIdentifier: BUNDLE_IDENTIFIERS[kind],
        designatedRequirement: appleDesignatedRequirement(
          BUNDLE_IDENTIFIERS[kind], REMOTE_DESKTOP_MACOS_TEAM_ID,
        ),
        hardenedRuntime: true,
      }])),
    },
    toolchain: { xcode: '26.6', macosSdk: '26.5', clang: '20.1.0' },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const archive = Buffer.concat([
    Buffer.from(encodeRemoteDesktopMacosComponentSetPrefix(manifestBytes.length)),
    manifestBytes,
    ...REMOTE_DESKTOP_MACOS_COMPONENT_ORDER.map((kind, index) => componentBytes(kind, index)),
  ]);
  return {
    manifest,
    archive: overrides.truncate === undefined ? archive : archive.subarray(0, overrides.truncate),
  };
}

function fakeFetch(archive: Buffer, filename: string, version = WORKER_VERSION): typeof fetch {
  return (async () => new Response(archive, {
    status: 200,
    headers: {
      [CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256]: createHash('sha256').update(archive).digest('hex'),
      [CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES]: String(archive.length),
      [CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME]: filename,
      [CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION]: version,
    },
  })) as unknown as typeof fetch;
}

const CREDENTIAL = { serverId: 'a'.repeat(32), token: 'b'.repeat(32), serverUrl: 'https://example.invalid' };

describe('macOS remote-desktop component set download', () => {
  /**
   * The link that was missing entirely: the server could serve this set and
   * the node could verify and promote one, but nothing ever fetched it. A
   * macOS node therefore advertised no remote-desktop capability, and the web
   * UI -- which is capability-gated -- showed neither an install nor an open
   * button, on a machine where every other piece was already shipping.
   */
  it('unpacks the set the server packs, leaving exactly what the store admits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-set-'));
    try {
      const { archive, manifest } = buildSet('arm64');
      const result = await downloadControlledNodeMacosRemoteDesktopComponentSet({
        credential: CREDENTIAL,
        target: { os: 'mac', arch: 'arm64' },
        dir: directory,
        fetchImpl: fakeFetch(archive, remoteDesktopMacosComponentSetFilename('arm64')),
        expectedVersion: WORKER_VERSION,
      });
      expect(result).toBeDefined();

      // EXACTLY the manifest and the four components. The archive itself and
      // the downloader's sidecar are gone, because a release directory holding
      // anything else is refused by the artifact store.
      expect(readdirSync(result!.componentDirectory).sort())
        .toEqual([REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME, ...Object.values(FILE_NAMES)].sort());

      // Every component must be the bytes the manifest describes -- a
      // mis-sliced boundary would still produce four files of the right names.
      for (const [index, kind] of REMOTE_DESKTOP_MACOS_COMPONENT_ORDER.entries()) {
        const path = join(result!.componentDirectory, FILE_NAMES[kind]);
        const bytes = readFileSync(path);
        expect(createHash('sha256').update(bytes).digest('hex'))
          .toBe(manifest.components[kind].sha256);
        expect(bytes).toEqual(componentBytes(kind, index));
        // Executable, or it verifies perfectly and then cannot be launched.
        expect(statSync(path).mode & 0o111).not.toBe(0);
      }
      expect(JSON.parse(readFileSync(result!.manifestPath, 'utf8')).workerVersion)
        .toBe(WORKER_VERSION);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a truncated set instead of writing a short component', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-set-'));
    try {
      const { archive } = buildSet('arm64');
      await expect(downloadControlledNodeMacosRemoteDesktopComponentSet({
        credential: CREDENTIAL,
        target: { os: 'mac', arch: 'arm64' },
        dir: directory,
        fetchImpl: fakeFetch(archive.subarray(0, archive.length - 64),
          remoteDesktopMacosComponentSetFilename('arm64')),
        expectedVersion: WORKER_VERSION,
      })).rejects.toThrow(/truncated|size_mismatch|sha256/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses trailing bytes the manifest does not describe', async () => {
    // The digest and length headers cover the WHOLE archive, so appending data
    // after the last component passes every transport check: the bytes arrive
    // intact and complete. Only comparing the consumed length against the file
    // catches content the manifest never accounted for.
    const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-set-'));
    try {
      const { archive } = buildSet('arm64');
      const padded = Buffer.concat([archive, Buffer.alloc(512, 0x5a)]);
      await expect(downloadControlledNodeMacosRemoteDesktopComponentSet({
        credential: CREDENTIAL,
        target: { os: 'mac', arch: 'arm64' },
        dir: directory,
        fetchImpl: fakeFetch(padded, remoteDesktopMacosComponentSetFilename('arm64')),
        expectedVersion: WORKER_VERSION,
      })).rejects.toThrow(/size_mismatch/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a set whose manifest describes another architecture', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-set-'));
    try {
      // Served for arm64, but the manifest inside says x64. Accepting it would
      // install binaries that cannot run on the machine that asked.
      const { archive } = buildSet('x64');
      await expect(downloadControlledNodeMacosRemoteDesktopComponentSet({
        credential: CREDENTIAL,
        target: { os: 'mac', arch: 'arm64' },
        dir: directory,
        fetchImpl: fakeFetch(archive, remoteDesktopMacosComponentSetFilename('arm64')),
        expectedVersion: WORKER_VERSION,
      })).rejects.toThrow(/target_mismatch_darwin_x64/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a set built for another release', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-set-'));
    try {
      const { archive } = buildSet('arm64');
      await expect(downloadControlledNodeMacosRemoteDesktopComponentSet({
        credential: CREDENTIAL,
        target: { os: 'mac', arch: 'arm64' },
        dir: directory,
        fetchImpl: fakeFetch(archive, remoteDesktopMacosComponentSetFilename('arm64'), '9.9.9'),
        expectedVersion: WORKER_VERSION,
      })).rejects.toThrow(/version_mismatch/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not claim a target it cannot serve', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'imcodes-macos-set-'));
    try {
      for (const target of [
        { os: 'win', arch: 'x64' },
        { os: 'linux', arch: 'x64' },
        { os: 'mac', arch: 'arm' },
      ] as const) {
        await expect(downloadControlledNodeMacosRemoteDesktopComponentSet({
          credential: CREDENTIAL,
          target: target as never,
          dir: directory,
          fetchImpl: (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch,
        })).resolves.toBeUndefined();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
