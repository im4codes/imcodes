import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MACOS_REMOTE_DESKTOP_APPLE_TOOLS,
  type MacosRemoteDesktopArtifactCommandExecutor,
} from '../../src/node/macos-remote-desktop-artifact.js';
import { PINNED_LIBWEBRTC_REVISION } from '../../shared/remote-desktop-native-pins.js';
import {
  REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
  REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
  REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
  type RemoteDesktopMacosArchitecture,
  type RemoteDesktopMacosCodeIdentity,
  type RemoteDesktopMacosWorkerManifest,
  REMOTE_DESKTOP_MACOS_TEAM_ID,
} from '../../shared/remote-desktop-worker.js';
import {
  MACOS_REMOTE_DESKTOP_ATOMIC_PUBLICATION_STEPS,
  MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER,
  buildMacosRemoteDesktopReleasePlan,
  installQualifiedMacosRemoteDesktopVariant,
  packageQualifiedMacosRemoteDesktopRelease,
  rollbackQualifiedMacosRemoteDesktopVariant,
  upgradeQualifiedMacosRemoteDesktopVariant,
  type MacosRemoteDesktopReleaseGuardInput,
} from '../../scripts/macos-remote-desktop-release-guard.js';
import { MACOS_LIBWEBRTC_NOTICE_TARGETS } from '../../scripts/libwebrtc-sdk-artifacts.mjs';

const WORKER_VERSION = '2026.8.2601';
const TEAM_ID = REMOTE_DESKTOP_MACOS_TEAM_ID;
const KINDS = ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'] as const;
const FILES = {
  worker: REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  launchAgent: REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  disclosure: REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  virtualDisplayHelper: REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
} as const;
const IDENTIFIERS = {
  worker: 'cc.imcodes.node.remote-desktop-worker',
  launchAgent: 'cc.imcodes.node.remote-desktop-agent',
  disclosure: 'cc.imcodes.node.remote-desktop-disclosure',
  virtualDisplayHelper: 'cc.imcodes.node.virtual-display-helper',
} as const;
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function macosNotices(libraries = ['webrtc', 'abseil-cpp']): string {
  return [
    '<!-- imcodes-macos-libwebrtc-notices-v1',
    `libwebrtcRevision=${PINNED_LIBWEBRTC_REVISION}`,
    `targets=${MACOS_LIBWEBRTC_NOTICE_TARGETS.join(',')}`,
    `libraries=${libraries.join(',')}`,
    '-->',
    '',
    ...libraries.flatMap((library) => [
      `# ${library}`,
      '```',
      `${library} notice`,
      '```',
      '',
    ]),
  ].join('\n');
}

function designatedRequirement(bundleIdentifier: string, teamId = TEAM_ID): string {
  return `identifier "${bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

function identity(teamId = TEAM_ID): RemoteDesktopMacosCodeIdentity {
  return {
    teamId,
    bundles: Object.fromEntries(KINDS.map((kind) => [kind, {
      bundleIdentifier: IDENTIFIERS[kind],
      designatedRequirement: designatedRequirement(IDENTIFIERS[kind], teamId),
      hardenedRuntime: true,
    }])) as RemoteDesktopMacosCodeIdentity['bundles'],
  };
}

function manifest(
  arch: RemoteDesktopMacosArchitecture,
  bytes: Record<typeof KINDS[number], Buffer>,
  overrides: Record<string, unknown> = {},
): RemoteDesktopMacosWorkerManifest {
  const component = (kind: typeof KINDS[number], seed: string) => ({
    fileName: FILES[kind],
    size: bytes[kind].length,
    sha256: sha256(bytes[kind]),
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
    minimumOsVersion: '12.3',
    codeSignature: identity(),
    toolchain: { xcode: '16.4', macosSdk: '15.5', clang: '17.0.0' },
    ...overrides,
  } as RemoteDesktopMacosWorkerManifest;
}

async function fixture(
  overrides: Partial<Record<RemoteDesktopMacosArchitecture, Record<string, unknown>>> = {},
  payloadSuffix = '',
) {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-release-guard-'));
  roots.push(root);
  const releaseRoots = {} as Record<RemoteDesktopMacosArchitecture, string>;
  for (const arch of ['arm64', 'x64'] as const) {
    const releaseRoot = join(root, arch);
    releaseRoots[arch] = releaseRoot;
    const directory = join(releaseRoot, 'remote-desktop-worker', `darwin-${arch}`);
    await mkdir(directory, { recursive: true });
    const bytes = Object.fromEntries(KINDS.map((kind) => [
      kind,
      Buffer.from(`signed ${arch} ${kind} bytes${payloadSuffix}`),
    ])) as unknown as Record<typeof KINDS[number], Buffer>;
    const value = manifest(arch, bytes, overrides[arch]);
    await Promise.all([
      ...KINDS.map((kind) => writeFile(join(directory, FILES[kind]), bytes[kind])),
      writeFile(join(directory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME), `${JSON.stringify(value)}\n`),
    ]);
  }
  const repositoryLicensePath = join(root, 'LICENSE');
  const libwebrtcNoticesPath = join(root, 'THIRD_PARTY_NOTICES.webrtc.md');
  await writeFile(repositoryLicensePath, 'IM.codes release license\n');
  await writeFile(libwebrtcNoticesPath, macosNotices());
  return {
    root,
    releaseRoots,
    input: {
      workerVersion: WORKER_VERSION,
      candidates: [
        { arch: 'x64' as const, releaseRoot: releaseRoots.x64 },
        { arch: 'arm64' as const, releaseRoot: releaseRoots.arm64 },
      ],
      repositoryLicensePath,
      libwebrtcNoticesPath,
      publicationRoot: join(root, 'publication'),
      expectedCodeIdentity: identity(),
    } satisfies MacosRemoteDesktopReleaseGuardInput,
  };
}

async function signingRepositoryFixture(changedEntitlementBytes = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-signing-plan-'));
  roots.push(root);
  const sourceNative = join(process.cwd(), 'native', 'macos-remote-desktop');
  const destinationNative = join(root, 'native', 'macos-remote-desktop');
  const codeIdentityText = await readFile(join(sourceNative, 'code-identity.json'), 'utf8');
  const codeIdentity = JSON.parse(codeIdentityText) as {
    components: Record<typeof KINDS[number], { entitlements: string }>;
  };
  await mkdir(join(destinationNative, 'entitlements'), { recursive: true });
  await writeFile(join(destinationNative, 'code-identity.json'), codeIdentityText);
  for (const kind of KINDS) {
    const relative = codeIdentity.components[kind].entitlements;
    let bytes = await readFile(join(sourceNative, relative), 'utf8');
    if (changedEntitlementBytes && kind === 'worker') bytes += '\n';
    await writeFile(join(destinationNative, relative), bytes);
  }
  return root;
}

function appleEvidence(
  calls: string[],
  options: { unsigned?: boolean; noRuntime?: boolean; rejected?: boolean; unstapled?: boolean; wrongArch?: boolean } = {},
): MacosRemoteDesktopArtifactCommandExecutor {
  return async (executable, args) => {
    const fileName = args.at(-1) ?? '';
    const kind = Object.entries(FILES).find(([, name]) => fileName.endsWith(name))?.[0] ?? 'unknown';
    const operation = executable === MACOS_REMOTE_DESKTOP_APPLE_TOOLS.lipo
      ? 'lipo'
      : executable === MACOS_REMOTE_DESKTOP_APPLE_TOOLS.spctl
        ? 'spctl'
        : executable === MACOS_REMOTE_DESKTOP_APPLE_TOOLS.xcrun
          ? 'stapler'
          : args.includes('--verify')
            ? 'codesign-verify'
            : args.includes('-r-')
              ? 'codesign-requirement'
              : 'codesign-details';
    calls.push(`${fileName.includes('darwin-x64') ? 'x64' : fileName.includes('darwin-arm64') ? 'arm64' : 'path'}:${kind}:${operation}`);
    if (operation === 'codesign-verify' && options.unsigned) throw new Error('code object is not signed at all');
    if (operation === 'lipo') {
      const arch = fileName.includes('darwin-x64') ? 'x86_64' : 'arm64';
      return { stdout: options.wrongArch ? 'i386\n' : `${arch}\n`, stderr: '' };
    }
    if (operation === 'codesign-details') {
      return {
        stdout: '',
        stderr: `Identifier=${IDENTIFIERS[kind as keyof typeof IDENTIFIERS]}\nTeamIdentifier=${TEAM_ID}\nCodeDirectory v=20500 size=1 flags=${options.noRuntime ? '0x0(none)' : '0x10000(runtime)'} hashes=1\n`,
      };
    }
    if (operation === 'codesign-requirement') {
      return { stdout: '', stderr: `designated => ${designatedRequirement(IDENTIFIERS[kind as keyof typeof IDENTIFIERS])}\n` };
    }
    if (operation === 'spctl') {
      return options.rejected
        ? { stdout: '', stderr: `${fileName}: rejected\nsource=Unnotarized Developer ID\n` }
        : { stdout: '', stderr: `${fileName}: accepted\nsource=Notarized Developer ID\n` };
    }
    if (operation === 'stapler') {
      return { stdout: options.unstapled ? 'The validate action failed.\n' : 'The validate action worked!\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('macOS remote desktop deterministic release guard', () => {
  it('exposes the qualified packager through the repository release command', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['package:macos-remote-desktop'])
      .toBe('node --import tsx scripts/macos-remote-desktop-release-guard.ts package');
  });

  it('qualifies arm64 and x64 in canonical order and emits a deterministic no-download atomic plan', async () => {
    const { input } = await fixture();
    const calls: string[] = [];
    const dependencies = { artifact: { execute: appleEvidence(calls) } };
    const first = await buildMacosRemoteDesktopReleasePlan(input, dependencies);
    const second = await buildMacosRemoteDesktopReleasePlan(input, dependencies);

    expect(first).toEqual(second);
    expect(first.libwebrtcRevision).toBe(PINNED_LIBWEBRTC_REVISION);
    expect(first.runtimeDownloadsAllowed).toBe(false);
    expect(first.componentOrder).toBe(MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER);
    expect(first.entitlementsPlanSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.variants.map(({ arch }) => arch)).toEqual(['arm64', 'x64']);
    expect(first.variants.every(({ components }) => (
      // Derived from the canonical order so growing the atomic set cannot leave
      // this assertion silently checking a stale, shorter list.
      components.map(({ kind }) => kind).join(',')
        === MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER.join(',')
    ))).toBe(true);
    expect(first.notices.map(({ fileName }) => fileName)).toEqual([
      'LICENSE', 'THIRD_PARTY_NOTICES.webrtc.md',
    ]);
    expect(first.immutableReleaseName).toBe(`sha256-${first.releaseIdentitySha256}`);
    expect(first.publication).toMatchObject({
      atomic: true,
      verifyBeforePublication: true,
      verifyAfterStaging: true,
      steps: MACOS_REMOTE_DESKTOP_ATOMIC_PUBLICATION_STEPS,
    });
    expect(first.publication.steps).toContain(
      'copy-components-and-manifest-in-declared-order',
    );

    // Six Apple tool invocations per component, two architectures. Derived so
    // the slice cannot silently keep checking a stale prefix once the atomic
    // component set grows.
    const firstPassCalls = calls
      .slice(0, KINDS.length * 6 * 2)
      .map((call) => call.split(':').slice(-2).join(':'));
    const expectedPerComponent = KINDS.flatMap((kind) => [
      `${kind}:lipo`,
      `${kind}:codesign-verify`,
      `${kind}:codesign-details`,
      `${kind}:codesign-requirement`,
      `${kind}:spctl`,
      `${kind}:stapler`,
    ]);
    expect(firstPassCalls).toEqual([...expectedPerComponent, ...expectedPerComponent]);
  });

  it('changes immutable release identity when an entitlement file byte changes', async () => {
    const { input } = await fixture();
    const baselineRepository = await signingRepositoryFixture();
    const changedRepository = await signingRepositoryFixture(true);
    const artifact = { execute: appleEvidence([]) };
    const baseline = await buildMacosRemoteDesktopReleasePlan(input, {
      artifact,
      repositoryRoot: baselineRepository,
    });
    const changed = await buildMacosRemoteDesktopReleasePlan(input, {
      artifact,
      repositoryRoot: changedRepository,
    });

    expect(changed.entitlementsPlanSha256).not.toBe(baseline.entitlementsPlanSha256);
    expect(changed.releaseIdentitySha256).not.toBe(baseline.releaseIdentitySha256);
    expect(changed.immutableReleaseName).not.toBe(baseline.immutableReleaseName);
  });

  it.each([
    ['unsigned', { unsigned: true }, /not signed/],
    ['wrong architecture', { wrongArch: true }, /architecture_mismatch/],
    ['missing hardened runtime', { noRuntime: true }, /code_identity_mismatch/],
    ['rejected notarization', { rejected: true }, /notarization_rejected/],
    ['invalid staple', { unstapled: true }, /staple_invalid/],
  ] as const)('refuses %s evidence before returning a publication plan', async (_label, options, message) => {
    const { input } = await fixture();
    await expect(buildMacosRemoteDesktopReleasePlan(input, {
      artifact: { execute: appleEvidence([], options) },
    })).rejects.toThrow(message);
  });

  it('refuses hash, protocol, pinned revision and stable identity drift', async () => {
    const badProtocol = await fixture({ arm64: { protocolVersion: 1 } });
    await expect(buildMacosRemoteDesktopReleasePlan(badProtocol.input, {
      artifact: { execute: appleEvidence([]) },
    })).rejects.toThrow(/manifest_invalid|invalid remote desktop worker manifest/);

    const badPin = await fixture({ arm64: { libwebrtcRevision: 'f'.repeat(40) } });
    await expect(buildMacosRemoteDesktopReleasePlan(badPin.input, {
      artifact: { execute: appleEvidence([]) },
    })).rejects.toThrow(/manifest_invalid|invalid remote desktop worker manifest/);

    const badHash = await fixture();
    await writeFile(
      join(badHash.releaseRoots.arm64, 'remote-desktop-worker', 'darwin-arm64', REMOTE_DESKTOP_MACOS_WORKER_FILENAME),
      'tampered worker',
    );
    await expect(buildMacosRemoteDesktopReleasePlan(badHash.input, {
      artifact: { execute: appleEvidence([]) },
    })).rejects.toThrow(/(?:size|sha256|hash)(?: |_)*mismatch/);

    const wrongIdentity = await fixture();
    await expect(buildMacosRemoteDesktopReleasePlan({
      ...wrongIdentity.input,
      expectedCodeIdentity: identity('ZZZZZ99999'),
    }, { artifact: { execute: appleEvidence([]) } })).rejects.toThrow(/stable_identity_mismatch/);

    const driftedIdentifiers = {
      worker: 'cc.imcodes.node.changed-worker',
      launchAgent: 'cc.imcodes.node.changed-agent',
      disclosure: 'cc.imcodes.node.changed-disclosure',
    } as const;
    const driftedIdentity: RemoteDesktopMacosCodeIdentity = {
      teamId: TEAM_ID,
      bundles: Object.fromEntries(KINDS.map((kind) => [kind, {
        bundleIdentifier: driftedIdentifiers[kind],
        designatedRequirement: designatedRequirement(driftedIdentifiers[kind]),
        hardenedRuntime: true,
      }])) as RemoteDesktopMacosCodeIdentity['bundles'],
    };
    const drifted = await fixture({
      arm64: { codeSignature: driftedIdentity },
      x64: { codeSignature: driftedIdentity },
    });
    await expect(buildMacosRemoteDesktopReleasePlan({
      ...drifted.input,
      expectedCodeIdentity: driftedIdentity,
    }, { artifact: { execute: appleEvidence([]) } })).rejects.toThrow(/stable_identity_mismatch/);
  });

  it('requires both architectures and complete bounded third-party notices', async () => {
    const missingArch = await fixture();
    await expect(buildMacosRemoteDesktopReleasePlan({
      ...missingArch.input,
      candidates: missingArch.input.candidates.slice(0, 1),
    }, { artifact: { execute: appleEvidence([]) } })).rejects.toThrow(/architecture_set_invalid/);

    const missingNotice = await fixture();
    await writeFile(
      missingNotice.input.libwebrtcNoticesPath,
      macosNotices(['webrtc']).replace('libraries=webrtc', 'libraries=webrtc,abseil-cpp'),
    );
    await expect(buildMacosRemoteDesktopReleasePlan(missingNotice.input, {
      artifact: { execute: appleEvidence([]) },
    })).rejects.toThrow(/sections do not match/);
  });

  it('rejects cross-architecture toolchain drift as a mixed release', async () => {
    const mixed = await fixture({
      x64: { toolchain: { xcode: '16.3', macosSdk: '15.5', clang: '17.0.0' } },
    });
    await expect(buildMacosRemoteDesktopReleasePlan(mixed.input, {
      artifact: { execute: appleEvidence([]) },
    })).rejects.toThrow('macos_remote_desktop_release_mixed_component_sets');
  });

  it('packages both verified variants without changing the Windows release directory', async () => {
    const { input } = await fixture({}, '-packaged');
    const windowsDirectory = join(input.publicationRoot, 'remote-desktop-worker', 'win32-x64');
    await mkdir(windowsDirectory, { recursive: true });
    await writeFile(join(windowsDirectory, 'windows-release.bin'), 'windows-byte-for-byte');

    const plan = await packageQualifiedMacosRemoteDesktopRelease(input, {
      artifact: { execute: appleEvidence([]) },
    });

    expect(plan.variants.map(({ arch }) => arch)).toEqual(['arm64', 'x64']);
    expect(await readFile(join(windowsDirectory, 'windows-release.bin'), 'utf8'))
      .toBe('windows-byte-for-byte');
    for (const arch of ['arm64', 'x64'] as const) {
      expect((await readdir(
        join(input.publicationRoot, 'remote-desktop-worker', `darwin-${arch}`),
      )).sort()).toEqual([
        REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
        REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
        REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
        REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
        REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
      ].sort());
    }
    expect((await readdir(input.publicationRoot)).some(
      (entry) => entry.startsWith('.macos-remote-desktop-staging-'),
    )).toBe(false);
  });

  it('delegates installation to the existing verified atomic promotion and rollback store', async () => {
    const { input, root } = await fixture();
    const execute = appleEvidence([]);
    const storeRoot = join(root, 'installed-arm64');
    const installed = await installQualifiedMacosRemoteDesktopVariant(
      input,
      'arm64',
      storeRoot,
      { artifact: { execute } },
    );
    expect(installed.releaseName).toBe(`sha256-${installed.setSha256}`);
    expect((await readFile(join(storeRoot, 'current'), 'utf8')).trim()).toBe(installed.releaseName);
    expect(installed.manifest.codeSignature).toEqual(input.expectedCodeIdentity);
  });

  it('upgrades and rolls back only through verified immutable artifact selectors', async () => {
    const first = await fixture({}, '-first');
    const second = await fixture({}, '-second');
    const execute = appleEvidence([]);
    const storeRoot = join(first.root, 'installed-arm64');
    const installedFirst = await installQualifiedMacosRemoteDesktopVariant(
      first.input,
      'arm64',
      storeRoot,
      { artifact: { execute } },
    );
    const installedSecond = await installQualifiedMacosRemoteDesktopVariant(
      second.input,
      'arm64',
      storeRoot,
      { artifact: { execute } },
    );
    expect(installedSecond.setSha256).not.toBe(installedFirst.setSha256);
    expect((await readFile(join(storeRoot, 'last-known-good'), 'utf8')).trim())
      .toBe(installedFirst.releaseName);

    const rolledBack = await rollbackQualifiedMacosRemoteDesktopVariant(
      'arm64',
      storeRoot,
      { artifact: { execute } },
    );
    expect(rolledBack.setSha256).toBe(installedFirst.setSha256);
    expect((await readFile(join(storeRoot, 'current'), 'utf8')).trim())
      .toBe(installedFirst.releaseName);
    expect((await readFile(join(storeRoot, 'last-known-good'), 'utf8')).trim())
      .toBe(installedSecond.releaseName);
  });

  it('qualifies both architectures before stop and restores selectors after post-swap readiness failure', async () => {
    const first = await fixture({}, '-first-transaction');
    const second = await fixture({}, '-second-transaction');
    const execute = appleEvidence([]);
    const storeRoot = join(first.root, 'transaction-store');
    const installedFirst = await installQualifiedMacosRemoteDesktopVariant(
      first.input,
      'arm64',
      storeRoot,
      { artifact: { execute } },
    );
    const beforeCurrent = await readFile(join(storeRoot, 'current'), 'utf8');
    const events: string[] = [];

    await expect(upgradeQualifiedMacosRemoteDesktopVariant(
      second.input,
      'arm64',
      storeRoot,
      {
        stop: async () => { events.push('stop'); },
        start: async (artifact) => { events.push(`start:${artifact.manifest.workerVersion}`); },
        verifyReadiness: async (artifact) => {
          events.push(`ready:${artifact.setSha256}`);
          if (artifact.setSha256 !== (await readFile(join(storeRoot, 'current'), 'utf8')).trim().slice(7)) {
            throw new Error('selector_not_current');
          }
          if (artifact.setSha256 !== installedFirst.setSha256) {
            throw new Error('authenticated_readiness_failed');
          }
        },
      },
      { artifact: { execute } },
    )).rejects.toThrow('authenticated_readiness_failed');

    expect(events.filter((event) => event === 'stop')).toHaveLength(2);
    expect(events.some((event) => event.startsWith('start:'))).toBe(true);
    expect(await readFile(join(storeRoot, 'current'), 'utf8')).toBe(beforeCurrent);

    const incomplete = await fixture({}, '-incomplete');
    await rm(
      join(
        incomplete.releaseRoots.x64,
        'remote-desktop-worker',
        'darwin-x64',
        REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
      ),
    );
    const stop = vi.fn(async () => {});
    await expect(upgradeQualifiedMacosRemoteDesktopVariant(
      incomplete.input,
      'arm64',
      storeRoot,
      { stop, start: async () => {}, verifyReadiness: async () => {} },
      { artifact: { execute } },
    )).rejects.toThrow(/unexpected entries|unexpected_entries/);
    expect(stop).not.toHaveBeenCalled();
  });

  it('pins the guard source against publication-before-verification and runtime downloads', async () => {
    const source = await readFile(
      join(process.cwd(), 'scripts', 'macos-remote-desktop-release-guard.ts'),
      'utf8',
    );
    expect(source).toContain('await verifyRemoteDesktopWorkerArtifactSet(');
    expect(source).toContain('await verifyMacosRemoteDesktopArtifact({');
    expect(source).toContain('return promoteMacosRemoteDesktopArtifact({');
    const installSource = source.slice(
      source.indexOf('export async function installQualifiedMacosRemoteDesktopVariant('),
      source.indexOf('function validateCliConfig('),
    );
    expect(installSource.indexOf('await buildMacosRemoteDesktopReleasePlan('))
      .toBeLessThan(installSource.indexOf('return promoteMacosRemoteDesktopArtifact({'));
    expect(source).not.toMatch(/\b(?:fetch|curl|wget)\s*\(/u);
    expect(source).not.toMatch(/\b(?:npm|pnpm|yarn)\s+(?:install|add)\b/u);
  });
});
