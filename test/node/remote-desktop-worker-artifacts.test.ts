import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
  REMOTE_DESKTOP_MACOS_TEAM_ID as PACKAGING_REMOTE_DESKTOP_MACOS_TEAM_ID,
  REMOTE_DESKTOP_PROTOCOL_VERSION as PACKAGING_REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_WORKER_IPC_VERSION as PACKAGING_REMOTE_DESKTOP_WORKER_IPC_VERSION,
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
  REMOTE_DESKTOP_LINUX_MAX_GLIBC_VERSION,
  REMOTE_DESKTOP_LINUX_WORKER_FILENAME as PACKAGING_LINUX_WORKER_FILENAME,
  REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR as PACKAGING_LINUX_PLATFORM_DIR,
  REMOTE_DESKTOP_WORKER_SIDECAR_DIR as PACKAGING_SIDECAR_DIR,
  assertLinuxElfGlibcCeiling,
  parseElf64GlibcRequirements,
  verifyLinuxRemoteDesktopWorkerArtifactSet,
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
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
  REMOTE_DESKTOP_LINUX_WORKER_FILENAME,
  REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
  REMOTE_DESKTOP_WORKER_SIDECAR_DIR,
} from '../../shared/remote-desktop-worker.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';

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
  return `identifier "${bundleIdentifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${teamId}`;
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
                + `generic and certificate leaf[subject.OU] = ${foreign}`,
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
    // The packaging module mirrors these because it must be importable from a
    // plain `node scripts/...` run, where the TypeScript originals are not.
    // A drift here would put a protocol version in the manifest that the
    // daemon reading it does not accept.
    expect(PACKAGING_REMOTE_DESKTOP_PROTOCOL_VERSION).toBe(REMOTE_DESKTOP_PROTOCOL_VERSION);
    expect(PACKAGING_REMOTE_DESKTOP_WORKER_IPC_VERSION).toBe(REMOTE_DESKTOP_WORKER_IPC_VERSION);
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

describe('Linux remote desktop worker release gate', () => {
  const VERSION = '2026.10.5516-dev.5968';
  const COMPLIANT_VERNEED = [
    { library: 'libc.so.6', versions: ['GLIBC_2.2.5', 'GLIBC_2.4', 'GLIBC_2.14', 'GLIBC_2.17', 'GLIBC_2.31'] },
    { library: 'libm.so.6', versions: ['GLIBC_2.2.5'] },
    { library: 'libpthread.so.0', versions: ['GLIBC_2.2.5', 'GLIBC_2.12'] },
    { library: 'libdl.so.2', versions: ['GLIBC_2.2.5'] },
    { library: 'libgcc_s.so.1', versions: ['GCC_3.0'] },
  ];

  function buildTestElf64(
    options: { verneed?: Array<{ library: string; versions: string[] }>; machine?: number } = {},
  ): Buffer {
    const verneed = options.verneed ?? COMPLIANT_VERNEED;
    const strChunks: Buffer[] = [Buffer.from([0])];
    let strLen = 1;
    const addString = (value: string) => {
      const offset = strLen;
      const chunk = Buffer.from(`${value}\0`, 'utf8');
      strChunks.push(chunk);
      strLen += chunk.length;
      return offset;
    };

    const verneedEntries: Buffer[] = [];
    for (let entryIdx = 0; entryIdx < verneed.length; entryIdx += 1) {
      const { library, versions } = verneed[entryIdx];
      const libOffset = addString(library);
      const entryBuf = Buffer.alloc(16 + versions.length * 16);
      const isLastEntry = entryIdx + 1 === verneed.length;
      entryBuf.writeUInt16LE(1, 0);
      entryBuf.writeUInt16LE(versions.length, 2);
      entryBuf.writeUInt32LE(libOffset, 4);
      entryBuf.writeUInt32LE(versions.length > 0 ? 16 : 0, 8);
      entryBuf.writeUInt32LE(isLastEntry ? 0 : entryBuf.length, 12);
      for (let verIdx = 0; verIdx < versions.length; verIdx += 1) {
        const verOffset = addString(versions[verIdx]);
        const auxBase = 16 + verIdx * 16;
        const isLastVer = verIdx + 1 === versions.length;
        entryBuf.writeUInt32LE(0, auxBase);
        entryBuf.writeUInt16LE(0, auxBase + 4);
        entryBuf.writeUInt16LE(verIdx + 2, auxBase + 6);
        entryBuf.writeUInt32LE(verOffset, auxBase + 8);
        entryBuf.writeUInt32LE(isLastVer ? 0 : 16, auxBase + 12);
      }
      verneedEntries.push(entryBuf);
    }

    const dynstr = Buffer.concat(strChunks);
    const verneedBuf = Buffer.concat(verneedEntries);
    const headerSize = 64;
    const dynstrOffset = headerSize;
    const verneedOffset = dynstrOffset + dynstr.length;
    const shoff = verneedOffset + verneedBuf.length;
    const sectionHeaders = Buffer.alloc(3 * 64);

    // Section 1: SHT_STRTAB (.dynstr)
    sectionHeaders.writeUInt32LE(3, 64 + 4);
    sectionHeaders.writeBigUInt64LE(BigInt(dynstrOffset), 64 + 24);
    sectionHeaders.writeBigUInt64LE(BigInt(dynstr.length), 64 + 32);

    // Section 2: SHT_GNU_verneed (.gnu.version_r)
    sectionHeaders.writeUInt32LE(0x6ffffffe, 128 + 4);
    sectionHeaders.writeBigUInt64LE(BigInt(verneedOffset), 128 + 24);
    sectionHeaders.writeBigUInt64LE(BigInt(verneedBuf.length), 128 + 32);
    sectionHeaders.writeUInt32LE(1, 128 + 40);
    sectionHeaders.writeUInt32LE(verneed.length, 128 + 44);

    const header = Buffer.alloc(headerSize);
    header[0] = 0x7f;
    header[1] = 0x45;
    header[2] = 0x4c;
    header[3] = 0x46;
    header[4] = 2; // ELFCLASS64
    header[5] = 1; // ELFDATA2LSB
    header[6] = 1; // EV_CURRENT
    header.writeUInt16LE(3, 16); // ET_DYN
    header.writeUInt16LE(options.machine ?? 0x3e, 18); // EM_X86_64
    header.writeUInt32LE(1, 20);
    header.writeBigUInt64LE(BigInt(shoff), 40);
    header.writeUInt16LE(64, 52);
    header.writeUInt16LE(64, 58);
    header.writeUInt16LE(3, 60);

    return Buffer.concat([header, dynstr, verneedBuf, sectionHeaders]);
  }

  it('names the worker and its directories exactly as the shared contract does', () => {
    expect(PACKAGING_LINUX_WORKER_FILENAME).toBe(REMOTE_DESKTOP_LINUX_WORKER_FILENAME);
    expect(PACKAGING_LINUX_PLATFORM_DIR).toBe(REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR);
    expect(PACKAGING_SIDECAR_DIR).toBe(REMOTE_DESKTOP_WORKER_SIDECAR_DIR);
  });

  async function linuxSet(
    options: {
      version?: string;
      executable?: boolean;
      bytes?: Buffer;
      verneed?: Array<{ library: string; versions: string[] }>;
    } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-linux-worker-gate-'));
    dirs.push(root);
    const platformDir = join(root, REMOTE_DESKTOP_WORKER_SIDECAR_DIR, REMOTE_DESKTOP_LINUX_WORKER_PLATFORM_DIR);
    await mkdir(platformDir, { recursive: true });
    const bytes = options.bytes ?? buildTestElf64({ verneed: options.verneed });
    const executable = join(platformDir, REMOTE_DESKTOP_LINUX_WORKER_FILENAME);
    const manifest = `${executable}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
    await writeFile(executable, bytes);
    await chmod(executable, options.executable === false ? 0o644 : 0o755);
    await writeFile(manifest, JSON.stringify({
      schemaVersion: 1,
      artifact: { fileName: REMOTE_DESKTOP_LINUX_WORKER_FILENAME, os: 'linux', arch: 'x64', size: bytes.length, sha256: digest(bytes) },
      build: { source: 'ci', version: options.version ?? VERSION },
    }));
    return { root, platformDir, executable, manifest, bytes };
  }

  it('accepts a complete, matching set', async () => {
    const set = await linuxSet();
    await expect(verifyLinuxRemoteDesktopWorkerArtifactSet(set.root, VERSION)).resolves.toMatchObject({ sha256: digest(set.bytes) });
  });

  it('rejects non-ELF, wrong-machine, and GLIBC > ceiling Linux worker binaries across all linked libraries', async () => {
    const nonElf = await linuxSet({ bytes: Buffer.from('linux worker bytes') });
    await expect(verifyLinuxRemoteDesktopWorkerArtifactSet(nonElf.root, VERSION))
      .rejects.toThrow(/not a little-endian ELF64 binary/);

    const arm64Elf = await linuxSet({ bytes: buildTestElf64({ machine: 0xb7 }) });
    await expect(verifyLinuxRemoteDesktopWorkerArtifactSet(arm64Elf.root, VERSION))
      .rejects.toThrow(/unexpected ELF machine/);

    const libm243 = await linuxSet({
      verneed: [
        ...COMPLIANT_VERNEED,
        { library: 'libm.so.6', versions: ['GLIBC_2.2.5', 'GLIBC_2.43'] },
      ],
    });
    await expect(verifyLinuxRemoteDesktopWorkerArtifactSet(libm243.root, VERSION))
      .rejects.toThrow(new RegExp(`unsupported GLIBC version.*above ${REMOTE_DESKTOP_LINUX_MAX_GLIBC_VERSION}.*libm\\.so\\.6 \\(GLIBC_2\\.43\\)`));

    for (const [library, version] of [
      ['libc.so.6', 'GLIBC_2.34'],
      ['libc.so.6', 'GLIBC_2.39'],
      ['libpthread.so.0', 'GLIBC_2.34'],
      ['libdl.so.2', 'GLIBC_2.34'],
      ['libc.so.6', 'GLIBC_PRIVATE'],
    ] as const) {
      const bad = await linuxSet({ verneed: [{ library, versions: [version] }] });
      await expect(verifyLinuxRemoteDesktopWorkerArtifactSet(bad.root, VERSION))
        .rejects.toThrow(new RegExp(`${library.replaceAll('.', '\\.')} \\(${version}\\)`));
    }

    const parsed = await parseElf64GlibcRequirements(buildTestElf64());
    expect(parsed).toEqual(
      COMPLIANT_VERNEED.flatMap(({ library, versions }) => versions.map((version) => ({ library, version }))),
    );
    expect(() => assertLinuxElfGlibcCeiling(parsed)).not.toThrow();
  });

  it('keeps non-Linux (Windows PE / macOS Mach-O) artifact verification free of ELF false positives', async () => {
    const win = await writeWindowsArtifact();
    await writeFile(win.executable, Buffer.from('MZ\x90\x00not-an-elf-pe-stub'));
    const winStats = await readFile(win.executable);
    await writeFile(
      `${win.executable}.manifest.json`,
      `${JSON.stringify(windowsManifest(winStats, Buffer.from('signed virtual display archive')))}\n`,
    );
    await expect(verifyRemoteDesktopWorkerArtifactSet(win.root, WORKER_VERSION)).resolves.toMatchObject({
      manifest: { os: 'win32', arch: 'x64' },
    });

    const mac = await writeMacosArtifact('arm64');
    await expect(verifyRemoteDesktopWorkerArtifactSet(mac.root, WORKER_VERSION, { os: 'darwin', arch: 'arm64' }))
      .resolves.toMatchObject({ manifest: { os: 'darwin', arch: 'arm64' } });
  });

  it('links both worker and qualification binaries in build-worker-from-sdk.sh against the SDK sysroot', async () => {
    const script = await readFile(join(process.cwd(), 'native/linux-remote-desktop/build-worker-from-sdk.sh'), 'utf8');
    expect(script).toContain('SYSROOT="$SDK_ROOT/toolchain/sysroot"');
    expect(script).toContain('--sysroot="$SYSROOT"');
    expect(script).toContain('link_with_sdk "$WORKER_UNSTRIPPED"');
    expect(script).toContain('link_with_sdk "$QUAL_BIN"');
  });

  it.each([
    ['the worker is missing', async (set: Awaited<ReturnType<typeof linuxSet>>) => { await unlink(set.executable); }, /incomplete: missing imcodes-linux-remote-desktop-worker$/],
    ['the manifest is missing', async (set: Awaited<ReturnType<typeof linuxSet>>) => { await unlink(set.manifest); }, /incomplete: missing .*manifest\.json$/],
    ['the worker is not executable', async (set: Awaited<ReturnType<typeof linuxSet>>) => { await chmod(set.executable, 0o644); }, /not executable/],
    ['the worker bytes differ from the manifest', async (set: Awaited<ReturnType<typeof linuxSet>>) => { const flipped = Buffer.from(set.bytes); flipped[flipped.length - 1] ^= 0xff; await writeFile(set.executable, flipped); await chmod(set.executable, 0o755); }, /sha256 mismatch/],
    ['the worker has another size than the manifest says', async (set: Awaited<ReturnType<typeof linuxSet>>) => { await writeFile(set.executable, Buffer.from('short')); await chmod(set.executable, 0o755); }, /size mismatch/],
    ['the worker is a symlink', async (set: Awaited<ReturnType<typeof linuxSet>>) => { await unlink(set.executable); await writeFile(join(set.root, 'elsewhere'), set.bytes, { mode: 0o755 }); await symlink(join(set.root, 'elsewhere'), set.executable); }, /non-regular/],
    ['the manifest is not the strict shape', async (set: Awaited<ReturnType<typeof linuxSet>>) => { await writeFile(set.manifest, JSON.stringify({ schemaVersion: 1, extra: true })); }, /invalid linux remote desktop worker manifest/],
  ])('rejects a set where %s', async (_name, damage, message) => {
    const set = await linuxSet();
    await damage(set);
    await expect(verifyLinuxRemoteDesktopWorkerArtifactSet(set.root, VERSION)).rejects.toThrow(message);
  });

  it('an extra entry beside the two files is not served and does not fail the gate', async () => {
    const set = await linuxSet();
    await mkdir(join(set.platformDir, 'aidesk-ui'));
    await writeFile(join(set.platformDir, 'stray'), 'x');
    await expect(verifyLinuxRemoteDesktopWorkerArtifactSet(set.root, VERSION)).resolves.toMatchObject({ sha256: digest(set.bytes) });
  });

  it('rejects a set built for another release, and a missing directory', async () => {
    const set = await linuxSet({ version: '2026.10.5000-dev.1' });
    await expect(verifyLinuxRemoteDesktopWorkerArtifactSet(set.root, VERSION)).rejects.toThrow(/version mismatch/);
    const empty = await mkdtemp(join(tmpdir(), 'imcodes-linux-worker-gate-'));
    dirs.push(empty);
    await expect(verifyLinuxRemoteDesktopWorkerArtifactSet(empty, VERSION)).rejects.toThrow(/directory is missing/);
  });

  it('the command line verifies the Linux target too', async () => {
    const set = await linuxSet();
    const { execFile } = await import('node:child_process');
    const run = (root: string, version: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, ['scripts/remote-desktop-worker-artifacts.mjs', 'verify', root, version, 'linux', 'x64'], (error, stdout, stderr) => {
        resolve({ code: error ? (error as NodeJS.ErrnoException & { code?: number }).code as number ?? 1 : 0, stdout, stderr });
      });
    });
    expect((await run(set.root, VERSION)).code).toBe(0);
    const bad = await run(set.root, '2026.1.1');
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/version mismatch/);

    const glibc243 = await linuxSet({
      verneed: [
        ...COMPLIANT_VERNEED,
        { library: 'libm.so.6', versions: ['GLIBC_2.2.5', 'GLIBC_2.43'] },
      ],
    });
    const badGlibc = await run(glibc243.root, VERSION);
    expect(badGlibc.code).not.toBe(0);
    expect(badGlibc.stderr).toMatch(/GLIBC_2\.43/);
  });
});
