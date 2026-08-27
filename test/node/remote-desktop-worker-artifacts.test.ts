import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
  REMOTE_DESKTOP_MACOS_TEAM_ID as PACKAGING_REMOTE_DESKTOP_MACOS_TEAM_ID,
  REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
  REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
  REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  validateRemoteDesktopWorkerReleaseManifest,
  verifyRemoteDesktopWorkerArtifactSet,
} from '../../scripts/remote-desktop-worker-artifacts.mjs';
import {
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES,
  validateRemoteDesktopVirtualDisplayPackageManifest,
  validateRemoteDesktopWorkerManifest,
  validateRemoteDesktopWorkerReleaseManifest as validateSharedWorkerReleaseManifest,
  type RemoteDesktopMacosArchitecture,
  type RemoteDesktopMacosWorkerManifest,
  REMOTE_DESKTOP_MACOS_TEAM_ID,
} from '../../shared/remote-desktop-worker.js';

const dirs: string[] = [];
const WORKER_VERSION = '2026.8.1234';
const TEAM_ID = REMOTE_DESKTOP_MACOS_TEAM_ID;
const KINDS = ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'] as const;
const FILES = {
  worker: REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  launchAgent: REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  disclosure: REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  virtualDisplayHelper: REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
} as const;
const IDENTIFIERS = {
  worker: 'work.imcodes.remote-desktop.worker',
  launchAgent: 'work.imcodes.remote-desktop.agent',
  disclosure: 'work.imcodes.remote-desktop.disclosure',
  virtualDisplayHelper: 'work.imcodes.remote-desktop.virtual-display-helper',
} as const;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function windowsManifest(bytes: Buffer, archiveBytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 2,
    workerVersion: WORKER_VERSION,
    protocolVersion: 2,
    ipcVersion: 1,
    os: 'win32',
    arch: 'x64',
    fileName: REMOTE_DESKTOP_WORKER_FILENAME,
    size: bytes.length,
    sha256: digest(bytes),
    authenticodeSignerSha256: 'c'.repeat(64),
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    virtualDisplay: {
      archiveFileName: REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
      packageManifestFileName: 'imcodes-virtual-display.manifest.json',
      size: archiveBytes.length,
      sha256: digest(archiveBytes),
    },
    toolchain: {
      msvc: '14.44.35207', windowsSdk: '10.0.26100.0', cmake: 'not-used-gn',
      ninja: '1.13.1', depotTools: PINNED_DEPOT_TOOLS_REVISION,
    },
    ...overrides,
  };
}

async function writeWindowsArtifact(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-rd-release-artifact-'));
  dirs.push(root);
  const dir = join(root, 'remote-desktop-worker', 'win32-x64');
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from('immutable worker bytes');
  const archiveBytes = Buffer.from('signed virtual display archive');
  const executable = join(dir, REMOTE_DESKTOP_WORKER_FILENAME);
  const manifest = windowsManifest(bytes, archiveBytes, overrides);
  await Promise.all([
    writeFile(join(dir, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME), archiveBytes),
    writeFile(executable, bytes),
    writeFile(`${executable}.manifest.json`, `${JSON.stringify(manifest)}\n`),
  ]);
  return { root, executable, manifest };
}

function designatedRequirement(bundleIdentifier: string, teamId = TEAM_ID): string {
  return `identifier "${bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

function macosManifest(
  arch: RemoteDesktopMacosArchitecture,
  bytes: Record<typeof KINDS[number], Buffer>,
  overrides: Record<string, unknown> = {},
): RemoteDesktopMacosWorkerManifest {
  const component = (kind: typeof KINDS[number], seed: string) => ({
    fileName: FILES[kind],
    size: bytes[kind].length,
    sha256: digest(bytes[kind]),
    notarization: {
      status: 'accepted' as const,
      submissionId: '123e4567-e89b-42d3-a456-426614174000',
      ticketSha256: seed.repeat(64),
      stapled: true as const,
      stapleValidated: true as const,
    },
  });
  return {
    manifestVersion: REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
    artifactKind: REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
    workerVersion: WORKER_VERSION,
    protocolVersion: 2,
    ipcVersion: 1,
    os: 'darwin',
    arch,
    components: {
      worker: component('worker', 'a'),
      launchAgent: component('launchAgent', 'b'),
      disclosure: component('disclosure', 'c'),
      virtualDisplayHelper: component('virtualDisplayHelper', 'd'),
    },
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    minimumOsVersion: '13.0',
    codeSignature: {
      teamId: TEAM_ID,
      bundles: Object.fromEntries(KINDS.map((kind) => [kind, {
        bundleIdentifier: IDENTIFIERS[kind],
        designatedRequirement: designatedRequirement(IDENTIFIERS[kind]),
        hardenedRuntime: true,
      }])) as RemoteDesktopMacosWorkerManifest['codeSignature']['bundles'],
    },
    toolchain: { xcode: '16.4', macosSdk: '15.5', clang: '17.0.0' },
    ...overrides,
  } as RemoteDesktopMacosWorkerManifest;
}

async function writeMacosArtifact(
  directoryArch: RemoteDesktopMacosArchitecture,
  overrides: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-remote-desktop-worker-'));
  dirs.push(root);
  const dir = join(root, 'remote-desktop-worker', `darwin-${directoryArch}`);
  await mkdir(dir, { recursive: true });
  const bytes = Object.fromEntries(KINDS.map((kind) => [
    kind,
    Buffer.from(`immutable macOS ${directoryArch} ${kind} bytes`),
  ])) as unknown as Record<typeof KINDS[number], Buffer>;
  const manifest = macosManifest(directoryArch, bytes, overrides);
  await Promise.all([
    ...KINDS.map((kind) => writeFile(join(dir, FILES[kind]), bytes[kind])),
    writeFile(join(dir, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME), `${JSON.stringify(manifest)}\n`),
  ]);
  return { root, dir, manifest, bytes };
}

describe('remote desktop worker release artifact verifier', () => {
  it('requires both Microsoft and pinned WebRTC notices in the driver package', () => {
    const manifest = {
      manifestVersion: 1,
      hardwareId: 'ImcodesVirtualDisplay',
      dllSignerSha256: 'a'.repeat(64),
      catalogSignerSha256: 'b'.repeat(64),
      files: REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES.map((name) => ({ name, size: 1, sha256: 'c'.repeat(64) })),
    };
    expect(validateRemoteDesktopVirtualDisplayPackageManifest(manifest)).not.toBeNull();
    expect(validateRemoteDesktopVirtualDisplayPackageManifest({
      ...manifest,
      files: manifest.files.filter(({ name }) => name !== 'THIRD_PARTY_NOTICES.webrtc.md'),
    })).toBeNull();
  });

  it('preserves exact Windows v2 manifest bytes and the Windows-only validator contract', async () => {
    const { root, executable, manifest } = await writeWindowsArtifact();
    const originalBytes = await readFile(`${executable}.manifest.json`);
    const parsed = JSON.parse(originalBytes.toString('utf8'));
    expect(validateRemoteDesktopWorkerManifest(parsed)).toEqual(manifest);
    expect(validateSharedWorkerReleaseManifest(parsed, { os: 'win32', arch: 'x64' })).toEqual(manifest);
    expect(`${JSON.stringify(parsed)}\n`).toBe(originalBytes.toString('utf8'));
    await expect(verifyRemoteDesktopWorkerArtifactSet(root, WORKER_VERSION))
      .resolves.toMatchObject({ manifest: { manifestVersion: 2, os: 'win32', arch: 'x64' } });
  });

  it('keeps Windows digest, toolchain and exact-directory guards unchanged', async () => {
    const badDigest = await writeWindowsArtifact({ sha256: '0'.repeat(64) });
    await expect(verifyRemoteDesktopWorkerArtifactSet(badDigest.root, WORKER_VERSION))
      .rejects.toThrow(/sha256 mismatch/);
    const badToolchain = await writeWindowsArtifact({
      toolchain: {
        msvc: '14.44.35207', windowsSdk: '10.0.26100.0', cmake: 'not-used-gn',
        ninja: '1.13.1', depotTools: 'b'.repeat(40),
      },
    });
    await expect(verifyRemoteDesktopWorkerArtifactSet(badToolchain.root, WORKER_VERSION))
      .rejects.toThrow(/invalid remote desktop worker manifest/);
  });

  it.each(['arm64', 'x64'] as const)(
    'validates and hashes every component in the strict macOS %s set',
    async (arch) => {
      const { root, manifest } = await writeMacosArtifact(arch);
      const target = { os: 'darwin' as const, arch };
      expect(validateSharedWorkerReleaseManifest(manifest, target)).toEqual(manifest);
      expect(validateRemoteDesktopWorkerReleaseManifest(manifest, WORKER_VERSION, target)).toEqual(manifest);
      expect(validateRemoteDesktopWorkerManifest(manifest)).toBeNull();
      await expect(verifyRemoteDesktopWorkerArtifactSet(root, WORKER_VERSION, target))
        .resolves.toMatchObject({
          executablePath: undefined,
          archivePath: undefined,
          componentPaths: {
            worker: expect.stringMatching(/imcodes-remote-desktop-worker$/),
            launchAgent: expect.stringMatching(/imcodes-remote-desktop-launch-agent$/),
            disclosure: expect.stringMatching(/imcodes-remote-desktop-disclosure$/),
            virtualDisplayHelper: expect.stringMatching(/imcodes-virtual-display-helper$/),
          },
          manifest: {
            manifestVersion: REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
            artifactKind: 'macos-component-set',
            arch,
          },
        });
    },
  );

  it('fails closed on malformed, incomplete or mixed component identity metadata', () => {
    const bytes = Object.fromEntries(KINDS.map((kind) => [kind, Buffer.from(kind)])) as unknown as Record<typeof KINDS[number], Buffer>;
    const manifest = macosManifest('arm64', bytes);
    const target = { os: 'darwin' as const, arch: 'arm64' as const };
    const { disclosure: _disclosure, ...partialComponents } = manifest.components;
    const malformed = [
      { ...manifest, os: 'win32' },
      { ...manifest, arch: 'universal' },
      { ...manifest, artifactKind: 'macos-worker-executable' },
      { ...manifest, components: partialComponents },
      { ...manifest, unexpected: true },
      {
        ...manifest,
        codeSignature: {
          ...manifest.codeSignature,
          bundles: {
            ...manifest.codeSignature.bundles,
            launchAgent: {
              ...manifest.codeSignature.bundles.launchAgent,
              bundleIdentifier: manifest.codeSignature.bundles.worker.bundleIdentifier,
            },
          },
        },
      },
      {
        ...manifest,
        codeSignature: {
          ...manifest.codeSignature,
          bundles: {
            ...manifest.codeSignature.bundles,
            disclosure: { ...manifest.codeSignature.bundles.disclosure, hardenedRuntime: false },
          },
        },
      },
    ];
    for (const candidate of malformed) {
      expect(validateSharedWorkerReleaseManifest(candidate, target)).toBeNull();
      expect(() => validateRemoteDesktopWorkerReleaseManifest(candidate, WORKER_VERSION, target))
        .toThrow(/invalid remote desktop worker manifest/);
    }
  });

  it('rejects a SELF-CONSISTENT foreign-team manifest at the shared validator', () => {
    // The validator is the FIRST gate every consumer shares -- daemon artifact
    // verification, the launch agent, production readiness and the
    // virtual-display authority all reach a manifest through it. Shape-checking
    // the team here made the manifest the authority on who may sign the
    // product: name a foreign team, derive every designated requirement from
    // that same team, and nothing downstream has an independent value to
    // disagree with. Asserted HERE, not only at a consumer, so the pin cannot
    // be deleted while a restated check elsewhere keeps the suite green.
    const bytes = Object.fromEntries(KINDS.map((kind) => [kind, Buffer.from(kind)])) as unknown as Record<typeof KINDS[number], Buffer>;
    const manifest = macosManifest('arm64', bytes);
    const target = { os: 'darwin' as const, arch: 'arm64' as const };
    for (const foreign of ['ABCDE12345', 'ZZZZZ99999']) {
      const forged = {
        ...manifest,
        codeSignature: {
          teamId: foreign,
          bundles: Object.fromEntries(
            Object.entries(manifest.codeSignature.bundles).map(([kind, bundle]) => [kind, {
              ...bundle,
              designatedRequirement: `identifier "${bundle.bundleIdentifier}" and anchor apple `
                + `generic and certificate leaf[subject.OU] = "${foreign}"`,
            }]),
          ),
        },
      };
      expect(validateSharedWorkerReleaseManifest(forged, target), foreign).toBeNull();
      expect(
        () => validateRemoteDesktopWorkerReleaseManifest(forged, WORKER_VERSION, target),
        foreign,
      ).toThrow(/invalid remote desktop worker manifest/);
    }
    // The canonical team is what makes the SAME manifest valid, so this test
    // cannot pass by rejecting everything.
    expect(validateSharedWorkerReleaseManifest(manifest, target)).not.toBeNull();
    expect(manifest.codeSignature.teamId).toBe(REMOTE_DESKTOP_MACOS_TEAM_ID);
    expect(PACKAGING_REMOTE_DESKTOP_MACOS_TEAM_ID).toBe(REMOTE_DESKTOP_MACOS_TEAM_ID);
  });

  it('moves the runtime and plain-Node packaging trust roots together from one JSON source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-rd-macos-identity-'));
    dirs.push(root);
    const sharedDir = join(root, 'shared');
    const scriptsDir = join(root, 'scripts');
    await Promise.all([
      cp(join(process.cwd(), 'shared'), sharedDir, { recursive: true }),
      mkdir(scriptsDir, { recursive: true }),
    ]);
    await cp(
      join(process.cwd(), 'scripts', 'remote-desktop-worker-artifacts.mjs'),
      join(scriptsDir, 'remote-desktop-worker-artifacts.mjs'),
    );

    const isolatedTeam = 'ZZZZZ99999';
    await writeFile(
      join(sharedDir, 'remote-desktop-macos-identity.json'),
      `${JSON.stringify({ teamId: isolatedTeam })}\n`,
    );
    const packaging = await import(
      `${pathToFileURL(join(scriptsDir, 'remote-desktop-worker-artifacts.mjs')).href}?isolation=${Date.now()}`
    );
    const runtime = await tsImport(
      `${pathToFileURL(join(sharedDir, 'remote-desktop-worker.ts')).href}?isolation=${Date.now()}`,
      import.meta.url,
    );
    expect(packaging.REMOTE_DESKTOP_MACOS_TEAM_ID).toBe(isolatedTeam);
    expect(runtime.REMOTE_DESKTOP_MACOS_TEAM_ID).toBe(isolatedTeam);

    const bytes = Object.fromEntries(KINDS.map((kind) => [kind, Buffer.from(kind)])) as unknown as Record<typeof KINDS[number], Buffer>;
    const canonical = macosManifest('arm64', bytes);
    const moved = {
      ...canonical,
      codeSignature: {
        teamId: isolatedTeam,
        bundles: Object.fromEntries(
          Object.entries(canonical.codeSignature.bundles).map(([kind, bundle]) => [kind, {
            ...bundle,
            designatedRequirement: designatedRequirement(bundle.bundleIdentifier, isolatedTeam),
          }]),
        ),
      },
    };
    const target = { os: 'darwin' as const, arch: 'arm64' as const };
    expect(runtime.validateRemoteDesktopWorkerReleaseManifest(moved, target)).not.toBeNull();
    expect(
      packaging.validateRemoteDesktopWorkerReleaseManifest(moved, WORKER_VERSION, target),
    ).toMatchObject({ codeSignature: { teamId: isolatedTeam } });
  });

  it('keeps the canonical Team ID literal in the JSON trust source only', async () => {
    const [identity, runtimeSource, packagingSource] = await Promise.all([
      readFile(join(process.cwd(), 'shared', 'remote-desktop-macos-identity.json'), 'utf8'),
      readFile(join(process.cwd(), 'shared', 'remote-desktop-worker.ts'), 'utf8'),
      readFile(join(process.cwd(), 'scripts', 'remote-desktop-worker-artifacts.mjs'), 'utf8'),
    ]);
    expect(JSON.parse(identity)).toEqual({ teamId: REMOTE_DESKTOP_MACOS_TEAM_ID });
    expect(runtimeSource).not.toContain(REMOTE_DESKTOP_MACOS_TEAM_ID);
    expect(packagingSource).not.toContain(REMOTE_DESKTOP_MACOS_TEAM_ID);
  });

  it('rejects malformed or non-canonical packaging identity data at module admission', async () => {
    for (const [label, identity] of [
      ['lower-case Team ID', { teamId: REMOTE_DESKTOP_MACOS_TEAM_ID.toLowerCase() }],
      ['extra key', { teamId: REMOTE_DESKTOP_MACOS_TEAM_ID, fallback: 'ZZZZZ99999' }],
      ['missing Team ID', {}],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), 'imcodes-rd-invalid-macos-identity-'));
      dirs.push(root);
      const sharedDir = join(root, 'shared');
      const scriptsDir = join(root, 'scripts');
      await Promise.all([
        mkdir(sharedDir, { recursive: true }),
        mkdir(scriptsDir, { recursive: true }),
      ]);
      await Promise.all([
        cp(
          join(process.cwd(), 'shared', 'remote-desktop-native-pins.json'),
          join(sharedDir, 'remote-desktop-native-pins.json'),
        ),
        cp(
          join(process.cwd(), 'scripts', 'remote-desktop-worker-artifacts.mjs'),
          join(scriptsDir, 'remote-desktop-worker-artifacts.mjs'),
        ),
        writeFile(
          join(sharedDir, 'remote-desktop-macos-identity.json'),
          `${JSON.stringify(identity)}\n`,
        ),
      ]);
      await expect(
        import(`${pathToFileURL(join(scriptsDir, 'remote-desktop-worker-artifacts.mjs')).href}?case=${encodeURIComponent(label)}`),
        label,
      ).rejects.toThrow('invalid remote desktop macos identity');
    }
  });

  it('validates the virtual-display helper descriptor, not just its presence', () => {
    // exactKeys proves the key exists; it proves nothing about the value. The
    // shared validator reached the helper through exactKeys but never ran
    // validateMacosComponent on it, so a manifest could name the wrong file,
    // an out-of-range size, a malformed digest or bogus notarization and still
    // be accepted -- by the very validator the daemon and server both trust.
    const bytes = Object.fromEntries(
      KINDS.map((kind) => [kind, Buffer.from(`component:${kind}`)]),
    ) as Record<typeof KINDS[number], Buffer>;
    const base = macosManifest('arm64', bytes);
    expect(validateSharedWorkerReleaseManifest(
      JSON.parse(JSON.stringify(base)), { os: 'darwin', arch: 'arm64' },
    )).not.toBeNull();

    const mutations: Array<[string, (m: any) => void]> = [
      ['wrong filename', (m) => { m.components.virtualDisplayHelper.fileName = 'imcodes-remote-desktop-worker'; }],
      ['zero size', (m) => { m.components.virtualDisplayHelper.size = 0; }],
      ['oversize', (m) => { m.components.virtualDisplayHelper.size = 512 * 1024 * 1024 + 1; }],
      ['malformed digest', (m) => { m.components.virtualDisplayHelper.sha256 = 'nothex'; }],
      ['short digest', (m) => { m.components.virtualDisplayHelper.sha256 = 'a'.repeat(63); }],
      ['missing notarization', (m) => { delete m.components.virtualDisplayHelper.notarization; }],
      ['unstapled notarization', (m) => { m.components.virtualDisplayHelper.notarization.stapled = false; }],
      ['rejected notarization', (m) => { m.components.virtualDisplayHelper.notarization.status = 'rejected'; }],
    ];
    for (const [label, mutate] of mutations) {
      const candidate = JSON.parse(JSON.stringify(base));
      mutate(candidate);
      expect(
        validateSharedWorkerReleaseManifest(candidate, { os: 'darwin', arch: 'arm64' }),
        `shared validator accepted a helper descriptor with a ${label}`,
      ).toBeNull();
    }
  });

  it('rejects missing or hash-mismatched macOS components and wrong version/architecture', async () => {
    const missing = await writeMacosArtifact('arm64');
    await unlink(join(missing.dir, REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME));
    await expect(verifyRemoteDesktopWorkerArtifactSet(
      missing.root, WORKER_VERSION, { os: 'darwin', arch: 'arm64' },
    )).rejects.toThrow(/unexpected entries/);

    const badHash = await writeMacosArtifact('arm64');
    await writeFile(join(badHash.dir, REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME), 'swapped');
    await expect(verifyRemoteDesktopWorkerArtifactSet(
      badHash.root, WORKER_VERSION, { os: 'darwin', arch: 'arm64' },
    )).rejects.toThrow(/(?:size|sha256) mismatch/);

    const wrongVersion = await writeMacosArtifact('x64', { workerVersion: '2026.8.1235' });
    await expect(verifyRemoteDesktopWorkerArtifactSet(
      wrongVersion.root, WORKER_VERSION, { os: 'darwin', arch: 'x64' },
    )).rejects.toThrow(/invalid remote desktop worker manifest/);

    const wrongArch = await writeMacosArtifact('x64', { arch: 'arm64' });
    await expect(verifyRemoteDesktopWorkerArtifactSet(
      wrongArch.root, WORKER_VERSION, { os: 'darwin', arch: 'x64' },
    )).rejects.toThrow(/invalid remote desktop worker manifest/);
  });
});
