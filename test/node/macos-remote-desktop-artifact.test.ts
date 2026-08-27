import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from '../../shared/remote-desktop-qualification.js';
import {
  REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
  REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
  REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
  type RemoteDesktopMacosArchitecture,
  type RemoteDesktopMacosWorkerManifest,
  REMOTE_DESKTOP_MACOS_TEAM_ID,
} from '../../shared/remote-desktop-worker.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
import {
  MACOS_REMOTE_DESKTOP_APPLE_TOOLS,
  promoteMacosRemoteDesktopArtifact,
  rollbackMacosRemoteDesktopArtifact,
  selectMacosRemoteDesktopArtifact,
  upgradeMacosRemoteDesktopArtifact,
  verifyMacosRemoteDesktopArtifact,
  type MacosRemoteDesktopArtifactCommandExecutor,
  type MacosRemoteDesktopArtifactDependencies,
  type MacosRemoteDesktopComponentKind,
} from '../../src/node/macos-remote-desktop-artifact.js';

const WORKER_VERSION = '2026.8.4000';
const TEAM_ID = REMOTE_DESKTOP_MACOS_TEAM_ID;
const roots: string[] = [];
const KINDS = ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'] as const;
const FILE_NAMES = {
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
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function designatedRequirement(bundleIdentifier: string, teamId = TEAM_ID): string {
  return `identifier "${bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

function notarization(seed: string) {
  return {
    status: 'accepted' as const,
    submissionId: '123e4567-e89b-42d3-a456-426614174000',
    ticketSha256: seed.repeat(64),
    stapled: true as const,
    stapleValidated: true as const,
  };
}

function manifestFor(
  arch: RemoteDesktopMacosArchitecture,
  bytes: Record<MacosRemoteDesktopComponentKind, Buffer>,
  workerVersion = WORKER_VERSION,
): RemoteDesktopMacosWorkerManifest {
  return {
    manifestVersion: REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
    artifactKind: REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
    workerVersion,
    protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
    ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    os: 'darwin',
    arch,
    components: {
      worker: {
        fileName: FILE_NAMES.worker,
        size: bytes.worker.length,
        sha256: sha256(bytes.worker),
        notarization: notarization('a'),
      },
      launchAgent: {
        fileName: FILE_NAMES.launchAgent,
        size: bytes.launchAgent.length,
        sha256: sha256(bytes.launchAgent),
        notarization: notarization('b'),
      },
      disclosure: {
        fileName: FILE_NAMES.disclosure,
        size: bytes.disclosure.length,
        sha256: sha256(bytes.disclosure),
        notarization: notarization('c'),
      },
      virtualDisplayHelper: {
        fileName: FILE_NAMES.virtualDisplayHelper,
        size: bytes.virtualDisplayHelper.length,
        sha256: sha256(bytes.virtualDisplayHelper),
        notarization: notarization('d'),
      },
    },
    libwebrtcRevision:
      WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
    minimumOsVersion: '12.3',
    codeSignature: {
      teamId: TEAM_ID,
      bundles: Object.fromEntries(KINDS.map((kind) => [kind, {
        bundleIdentifier: IDENTIFIERS[kind],
        designatedRequirement: designatedRequirement(IDENTIFIERS[kind]),
        hardenedRuntime: true,
      }])) as RemoteDesktopMacosWorkerManifest['codeSignature']['bundles'],
    },
    toolchain: {
      xcode: '16.4',
      macosSdk: '15.5',
      clang: '17.0.0',
    },
  };
}

interface Fixture {
  root: string;
  storeRoot: string;
  artifactDirectory: string;
  manifestPath: string;
  manifest: RemoteDesktopMacosWorkerManifest;
  bytes: Record<MacosRemoteDesktopComponentKind, Buffer>;
}

async function fixture(
  arch: RemoteDesktopMacosArchitecture = 'arm64',
  workerVersion = WORKER_VERSION,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-worker-artifact-'));
  roots.push(root);
  const artifactDirectory = join(root, 'candidate');
  await mkdir(artifactDirectory);
  const bytes = Object.fromEntries(KINDS.map((kind) => [
    kind,
    Buffer.from(`signed immutable ${arch} ${kind} ${workerVersion}`),
  ])) as unknown as Record<MacosRemoteDesktopComponentKind, Buffer>;
  const manifest = manifestFor(arch, bytes, workerVersion);
  const manifestPath = join(artifactDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME);
  await Promise.all([
    ...KINDS.map((kind) => writeFile(
      join(artifactDirectory, FILE_NAMES[kind]),
      bytes[kind],
      { mode: 0o755 },
    )),
    writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 }),
  ]);
  return { root, storeRoot: join(root, 'store'), artifactDirectory, manifestPath, manifest, bytes };
}

type CommandOverride = string | Error;

function trustedExecutor(
  arch: RemoteDesktopMacosArchitecture = 'arm64',
  overrides: Record<string, CommandOverride> = {},
): { execute: MacosRemoteDesktopArtifactCommandExecutor; calls: Array<[string, readonly string[]]> } {
  const calls: Array<[string, readonly string[]]> = [];
  const result = async (key: string, fallback: string) => {
    const value = overrides[key] ?? overrides[key.split(':')[1]!] ?? fallback;
    if (value instanceof Error) throw value;
    return { stdout: value, stderr: '' };
  };
  const execute: MacosRemoteDesktopArtifactCommandExecutor = async (executable, args) => {
    calls.push([executable, args]);
    const path = args.at(-1) ?? '';
    const kind = KINDS.find((entry) => basename(path) === FILE_NAMES[entry]);
    if (kind === undefined) throw new Error(`unexpected component path: ${path}`);
    if (executable === MACOS_REMOTE_DESKTOP_APPLE_TOOLS.lipo) {
      return result(`${kind}:lipo`, arch === 'x64' ? 'x86_64\n' : 'arm64\n');
    }
    if (executable === MACOS_REMOTE_DESKTOP_APPLE_TOOLS.codesign
      && args.includes('--verify')) return result(`${kind}:verify`, '');
    if (executable === MACOS_REMOTE_DESKTOP_APPLE_TOOLS.codesign
      && args.includes('-r-')) {
      return result(`${kind}:requirement`, `designated => ${designatedRequirement(IDENTIFIERS[kind])}\n`);
    }
    if (executable === MACOS_REMOTE_DESKTOP_APPLE_TOOLS.codesign) {
      return result(`${kind}:details`, [
        `Identifier=${IDENTIFIERS[kind]}`,
        `TeamIdentifier=${TEAM_ID}`,
        'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=3+7 location=embedded',
      ].join('\n'));
    }
    if (executable === MACOS_REMOTE_DESKTOP_APPLE_TOOLS.spctl) {
      return result(`${kind}:spctl`, `${path}: accepted\nsource=Notarized Developer ID\n`);
    }
    if (executable === MACOS_REMOTE_DESKTOP_APPLE_TOOLS.xcrun) {
      return result(`${kind}:stapler`, 'The validate action worked!\n');
    }
    throw new Error(`unexpected command: ${executable} ${args.join(' ')}`);
  };
  return { execute, calls };
}

function dependencies(
  execute: MacosRemoteDesktopArtifactCommandExecutor,
  arch: RemoteDesktopMacosArchitecture = 'arm64',
  platform: NodeJS.Platform = 'darwin',
  uid?: number,
): MacosRemoteDesktopArtifactDependencies {
  return { execute, runtime: { platform, arch, uid } };
}

describe('macOS remote-desktop multi-component artifact adapter', () => {
  it('verifies each separately signed component and returns distinct executable paths', async () => {
    const candidate = await fixture();
    const command = trustedExecutor();
    const verified = await verifyMacosRemoteDesktopArtifact({
      artifactDirectory: candidate.artifactDirectory,
      manifestPath: candidate.manifestPath,
      expectedWorkerVersion: WORKER_VERSION,
    }, dependencies(command.execute));

    expect(Object.keys(verified.components)).toEqual(KINDS);
    // Derived from KINDS so adding a component to the atomic set cannot leave
    // this assertion silently checking a stale count.
    expect(new Set(KINDS.map((kind) => verified.components[kind].executablePath)).size).toBe(KINDS.length);
    expect(verified.components.launchAgent.executablePath)
      .toBe(join(candidate.artifactDirectory, REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME));
    // Six Apple tool invocations per component. Derived from KINDS so growing
    // the atomic set cannot leave this silently asserting a stale total.
    expect(command.calls).toHaveLength(KINDS.length * 6);
    expect(command.calls.every(([executable]) => executable.startsWith('/'))).toBe(true);
    for (const kind of KINDS) {
      const componentPath = verified.components[kind].executablePath;
      expect(command.calls.filter(([, args]) => args.at(-1) === componentPath)).toHaveLength(6);
    }
  });

  it('rejects wrong OS and architecture before invoking Apple tools', async () => {
    const candidate = await fixture('arm64');
    const command = trustedExecutor();
    await expect(verifyMacosRemoteDesktopArtifact(
      candidate,
      dependencies(command.execute, 'arm64', 'linux'),
    )).rejects.toThrow('wrong_os');
    await expect(verifyMacosRemoteDesktopArtifact(
      candidate,
      dependencies(command.execute, 'x64'),
    )).rejects.toThrow('manifest_invalid');
    expect(command.calls).toHaveLength(0);
  });

  it('rejects missing, partial, extra and symlinked component sets', async () => {
    const missing = await fixture();
    await unlink(join(missing.artifactDirectory, REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME));
    await expect(verifyMacosRemoteDesktopArtifact(missing, dependencies(trustedExecutor().execute)))
      .rejects.toThrow('unexpected_entries');

    const extra = await fixture();
    await writeFile(join(extra.artifactDirectory, 'unexpected.dylib'), 'unsigned');
    await expect(verifyMacosRemoteDesktopArtifact(extra, dependencies(trustedExecutor().execute)))
      .rejects.toThrow('unexpected_entries');

    if (process.platform !== 'win32') {
      const linked = await fixture();
      const disclosurePath = join(linked.artifactDirectory, REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME);
      await unlink(disclosurePath);
      await symlink(join(linked.artifactDirectory, REMOTE_DESKTOP_MACOS_WORKER_FILENAME), disclosurePath);
      await expect(verifyMacosRemoteDesktopArtifact(linked, dependencies(trustedExecutor().execute)))
        .rejects.toThrow('unexpected_entries');
    }
  });

  it('rejects swapped component bytes and a per-component hash mismatch before trust checks', async () => {
    const swapped = await fixture();
    await Promise.all([
      copyFile(
        join(swapped.artifactDirectory, REMOTE_DESKTOP_MACOS_WORKER_FILENAME),
        join(swapped.artifactDirectory, REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME),
      ),
    ]);
    const command = trustedExecutor();
    await expect(verifyMacosRemoteDesktopArtifact(swapped, dependencies(command.execute)))
      .rejects.toThrow(/launchAgent_(?:size|hash)_mismatch/);
    expect(command.calls.filter(([, args]) => args.at(-1)?.endsWith(
      REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
    ))).toHaveLength(0);

    const badHash = await fixture();
    badHash.manifest.components.disclosure.sha256 = 'f'.repeat(64);
    await writeFile(badHash.manifestPath, JSON.stringify(badHash.manifest));
    await expect(verifyMacosRemoteDesktopArtifact(
      badHash,
      dependencies(trustedExecutor().execute),
    )).rejects.toThrow('disclosure_hash_mismatch');
  });

  it('rejects wrong identity, requirement, hardened runtime and architecture on any component', async () => {
    const candidate = await fixture();
    for (const [key, value] of Object.entries({
      'launchAgent:details': `Identifier=${IDENTIFIERS.worker}\nTeamIdentifier=${TEAM_ID}\nCodeDirectory flags=0x10000(runtime)`,
      'disclosure:requirement': `designated => ${designatedRequirement(IDENTIFIERS.disclosure)} or true`,
      'worker:details': `Identifier=${IDENTIFIERS.worker}\nTeamIdentifier=${TEAM_ID}\nCodeDirectory flags=0x0(none)`,
      'launchAgent:lipo': 'x86_64\n',
    })) {
      await expect(verifyMacosRemoteDesktopArtifact(
        candidate,
        dependencies(trustedExecutor('arm64', { [key]: value }).execute),
      )).rejects.toThrow();
    }
  });

  it('rejects invalid notarization or stapling independently for every component', async () => {
    const candidate = await fixture();
    for (const kind of KINDS) {
      await expect(verifyMacosRemoteDesktopArtifact(
        candidate,
        dependencies(trustedExecutor('arm64', {
          [`${kind}:spctl`]: `${FILE_NAMES[kind]}: rejected\nsource=Developer ID\n`,
        }).execute),
      )).rejects.toThrow('notarization_rejected');
      await expect(verifyMacosRemoteDesktopArtifact(
        candidate,
        dependencies(trustedExecutor('arm64', {
          [`${kind}:stapler`]: 'The validate action failed!\n',
        }).execute),
      )).rejects.toThrow('staple_invalid');
    }
  });

  it('atomically promotes complete sets, retains last-known-good and rolls back after re-verification', async () => {
    const first = await fixture('arm64', '2026.8.4000');
    const second = await fixture('arm64', '2026.8.4001');
    const deps = dependencies(trustedExecutor().execute);

    const installedFirst = await promoteMacosRemoteDesktopArtifact({
      ...first,
      storeRoot: first.storeRoot,
      expectedWorkerVersion: first.manifest.workerVersion,
    }, deps);
    expect((await lstat(installedFirst.artifactDirectory)).isSymbolicLink()).toBe(false);
    expect(await selectMacosRemoteDesktopArtifact(first.storeRoot, 'lastKnownGood', deps)).toBeNull();

    const incomplete = await fixture('arm64', '2026.8.4999');
    await unlink(join(incomplete.artifactDirectory, REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME));
    await expect(promoteMacosRemoteDesktopArtifact({
      ...incomplete,
      storeRoot: first.storeRoot,
    }, deps)).rejects.toThrow('unexpected_entries');
    expect((await selectMacosRemoteDesktopArtifact(first.storeRoot, 'current', deps))
      ?.manifest.workerVersion).toBe('2026.8.4000');

    await promoteMacosRemoteDesktopArtifact({
      ...second,
      storeRoot: first.storeRoot,
      expectedWorkerVersion: second.manifest.workerVersion,
    }, deps);
    expect((await selectMacosRemoteDesktopArtifact(first.storeRoot, 'current', deps))
      ?.manifest.workerVersion).toBe('2026.8.4001');
    expect((await selectMacosRemoteDesktopArtifact(first.storeRoot, 'lastKnownGood', deps))
      ?.manifest.workerVersion).toBe('2026.8.4000');

    const current = await selectMacosRemoteDesktopArtifact(first.storeRoot, 'current', deps);
    await writeFile(current!.components.launchAgent.executablePath, 'corrupted current agent');
    const rolledBack = await rollbackMacosRemoteDesktopArtifact({ storeRoot: first.storeRoot }, deps);
    expect(rolledBack.manifest.workerVersion).toBe('2026.8.4000');
    expect(await readFile(rolledBack.components.launchAgent.executablePath, 'utf8'))
      .toBe('signed immutable arm64 launchAgent 2026.8.4000');
  });

  it('does not switch current when any last-known-good component cannot be reverified', async () => {
    const first = await fixture('arm64', '2026.8.4100');
    const second = await fixture('arm64', '2026.8.4101');
    const deps = dependencies(trustedExecutor().execute);
    await promoteMacosRemoteDesktopArtifact({ ...first, storeRoot: first.storeRoot }, deps);
    await promoteMacosRemoteDesktopArtifact({ ...second, storeRoot: first.storeRoot }, deps);
    const lastKnownGood = await selectMacosRemoteDesktopArtifact(
      first.storeRoot,
      'lastKnownGood',
      deps,
    );
    await unlink(lastKnownGood!.components.disclosure.executablePath);
    await expect(rollbackMacosRemoteDesktopArtifact({ storeRoot: first.storeRoot }, deps))
      .rejects.toThrow('unexpected_entries');
    expect((await selectMacosRemoteDesktopArtifact(first.storeRoot, 'current', deps))
      ?.manifest.workerVersion).toBe('2026.8.4101');
  });

  it('stops before selector publication and accepts an upgrade only after readiness', async () => {
    const first = await fixture('arm64', '2026.8.4200');
    const second = await fixture('arm64', '2026.8.4201');
    const deps = dependencies(trustedExecutor().execute);
    await promoteMacosRemoteDesktopArtifact({ ...first, storeRoot: first.storeRoot }, deps);
    const events: string[] = [];

    const upgraded = await upgradeMacosRemoteDesktopArtifact({
      ...second,
      storeRoot: first.storeRoot,
      expectedWorkerVersion: second.manifest.workerVersion,
      lifecycle: {
        stop: async () => { events.push('stop'); },
        start: async (artifact) => { events.push(`start:${artifact.manifest.workerVersion}`); },
        verifyReadiness: async (artifact) => {
          events.push(`ready:${artifact.manifest.workerVersion}`);
          expect((await readFile(join(first.storeRoot, 'current'), 'utf8')).trim())
            .toBe(artifact.releaseName);
        },
      },
    }, deps);

    expect(upgraded.manifest.workerVersion).toBe('2026.8.4201');
    expect(events).toEqual(['stop', 'start:2026.8.4201', 'ready:2026.8.4201']);
    expect((await selectMacosRemoteDesktopArtifact(first.storeRoot, 'lastKnownGood', deps))
      ?.manifest.workerVersion).toBe('2026.8.4200');
  });

  it('restores exact current/LKG selectors and restarts the old LaunchAgent after readiness failure', async () => {
    const oldest = await fixture('arm64', '2026.8.4300');
    const current = await fixture('arm64', '2026.8.4301');
    const rejected = await fixture('arm64', '2026.8.4302');
    const deps = dependencies(trustedExecutor().execute);
    await promoteMacosRemoteDesktopArtifact({ ...oldest, storeRoot: oldest.storeRoot }, deps);
    await promoteMacosRemoteDesktopArtifact({ ...current, storeRoot: oldest.storeRoot }, deps);
    const beforeCurrent = await readFile(join(oldest.storeRoot, 'current'), 'utf8');
    const beforeLastKnownGood = await readFile(join(oldest.storeRoot, 'last-known-good'), 'utf8');
    const events: string[] = [];

    await expect(upgradeMacosRemoteDesktopArtifact({
      ...rejected,
      storeRoot: oldest.storeRoot,
      expectedWorkerVersion: rejected.manifest.workerVersion,
      lifecycle: {
        stop: async () => { events.push('stop'); },
        start: async (artifact) => { events.push(`start:${artifact.manifest.workerVersion}`); },
        verifyReadiness: async (artifact) => {
          events.push(`ready:${artifact.manifest.workerVersion}`);
          if (artifact.manifest.workerVersion === rejected.manifest.workerVersion) {
            throw new Error('authenticated_readiness_timeout');
          }
        },
      },
    }, deps)).rejects.toThrow('authenticated_readiness_timeout');

    expect(events).toEqual([
      'stop',
      'start:2026.8.4302',
      'ready:2026.8.4302',
      'stop',
      'start:2026.8.4301',
      'ready:2026.8.4301',
    ]);
    expect(await readFile(join(oldest.storeRoot, 'current'), 'utf8')).toBe(beforeCurrent);
    expect(await readFile(join(oldest.storeRoot, 'last-known-good'), 'utf8'))
      .toBe(beforeLastKnownGood);
  });

  it('removes a failed first-install selector instead of retaining an unready release', async () => {
    const candidate = await fixture('x64', '2026.8.4400');
    const deps = dependencies(trustedExecutor('x64').execute, 'x64');
    await expect(upgradeMacosRemoteDesktopArtifact({
      ...candidate,
      storeRoot: candidate.storeRoot,
      lifecycle: {
        stop: async () => {},
        start: async () => {},
        verifyReadiness: async () => { throw new Error('launch_never_became_ready'); },
      },
    }, deps)).rejects.toThrow('launch_never_became_ready');

    expect(await selectMacosRemoteDesktopArtifact(candidate.storeRoot, 'current', deps)).toBeNull();
    expect(await selectMacosRemoteDesktopArtifact(candidate.storeRoot, 'lastKnownGood', deps)).toBeNull();
  });

  it('refuses a pre-existing store that anyone but the owner can write', async () => {
    // The daemon that opens this store runs as root. `mkdir` with a mode is a
    // NO-OP on a path that already exists, so a store pre-created by an
    // unprivileged user kept that user's permissions and was accepted -- which
    // is a writable directory from which root later executes binaries.
    for (const mode of [0o777, 0o775, 0o707, 0o702]) {
      const candidate = await fixture();
      await mkdir(candidate.storeRoot, { recursive: true, mode: 0o700 });
      await chmod(candidate.storeRoot, mode);
      await expect(promoteMacosRemoteDesktopArtifact({
        ...candidate,
        storeRoot: candidate.storeRoot,
      }, dependencies(trustedExecutor().execute)), mode.toString(8))
        .rejects.toThrow('macos_remote_desktop_artifact_store_untrusted');
    }
  });

  it('refuses a pre-existing releases directory that anyone but the owner can write', async () => {
    const candidate = await fixture();
    await mkdir(join(candidate.storeRoot, 'releases'), { recursive: true, mode: 0o700 });
    await chmod(join(candidate.storeRoot, 'releases'), 0o777);
    await expect(promoteMacosRemoteDesktopArtifact({
      ...candidate,
      storeRoot: candidate.storeRoot,
    }, dependencies(trustedExecutor().execute)))
      .rejects.toThrow('macos_remote_desktop_artifact_releases_untrusted');
  });

  it('refuses a store owned by anyone but root or the running daemon', async () => {
    const candidate = await fixture();
    await mkdir(candidate.storeRoot, { recursive: true, mode: 0o700 });
    // The directory really is owned by this test's uid; naming a DIFFERENT
    // expected uid is what a root daemon meeting a user-owned store sees.
    await expect(promoteMacosRemoteDesktopArtifact({
      ...candidate,
      storeRoot: candidate.storeRoot,
    }, dependencies(trustedExecutor().execute, 'arm64', 'darwin', process.getuid!() + 1)))
      .rejects.toThrow('macos_remote_desktop_artifact_store_untrusted');
  });

  it('accepts a root-owned store and still creates and reuses its own', async () => {
    // uid 0 is always legitimate: a root daemon's own store is root-owned.
    const rootOwned = await fixture();
    await mkdir(rootOwned.storeRoot, { recursive: true, mode: 0o700 });
    const asRoot = dependencies(trustedExecutor().execute, 'arm64', 'darwin', 0);
    // lstat reports this test's uid, which is not 0 -- so the ONLY way this
    // passes is the expected-uid arm, proving root is accepted on its own.
    await expect(promoteMacosRemoteDesktopArtifact({
      ...rootOwned,
      storeRoot: rootOwned.storeRoot,
    }, asRoot)).rejects.toThrow('macos_remote_desktop_artifact_store_untrusted');

    // Safe creation is retained: no pre-existing directory, and promote works.
    const fresh = await fixture();
    const deps = dependencies(trustedExecutor().execute);
    const promoted = await promoteMacosRemoteDesktopArtifact({
      ...fresh,
      storeRoot: fresh.storeRoot,
    }, deps);
    expect((await lstat(fresh.storeRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(fresh.storeRoot, 'releases'))).mode & 0o777).toBe(0o700);

    // Restart behaviour: a second promote onto the store this code created must
    // still be accepted, or the guard would brick every upgrade after the first.
    const second = await fixture('arm64', '2026.8.4500');
    const again = await promoteMacosRemoteDesktopArtifact({
      ...second,
      storeRoot: fresh.storeRoot,
    }, deps);
    expect(again.releaseName).not.toBe(promoted.releaseName);
    expect(await selectMacosRemoteDesktopArtifact(fresh.storeRoot, 'current', deps))
      .toMatchObject({ releaseName: again.releaseName });
  });

  it('refuses a SELF-CONSISTENT foreign-team set even with valid Apple trust', async () => {
    // Cx6's decisive counterexample. Every field agrees with every other field:
    // the manifest names team ZZZZZ99999, each designated requirement is derived
    // from THAT team, and the mocked Apple tools report exactly that identity --
    // so codesign, spctl and stapler all "pass". Nothing internal to the
    // artifact is inconsistent. It is rejected only because the team is not the
    // one the product ships under.
    const foreign = 'ZZZZZ99999';
    const candidate = await fixture();
    const foreignManifest = {
      ...candidate.manifest,
      codeSignature: {
        teamId: foreign,
        bundles: Object.fromEntries(KINDS.map((kind) => [kind, {
          bundleIdentifier: IDENTIFIERS[kind],
          designatedRequirement: designatedRequirement(IDENTIFIERS[kind], foreign),
          hardenedRuntime: true,
        }])) as RemoteDesktopMacosWorkerManifest['codeSignature']['bundles'],
      },
    };
    await writeFile(candidate.manifestPath, `${JSON.stringify(foreignManifest)}\n`, { mode: 0o600 });
    // Apple trust mocked VALID for the foreign team, so this cannot pass by
    // accident on a signature check.
    const foreignTrust = trustedExecutor('arm64', Object.fromEntries(KINDS.flatMap((kind) => [
      [`${kind}:requirement`, `designated => ${designatedRequirement(IDENTIFIERS[kind], foreign)}\n`],
      [`${kind}:details`, [
        `Identifier=${IDENTIFIERS[kind]}`,
        `TeamIdentifier=${foreign}`,
        'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=3+7 location=embedded',
      ].join('\n')],
    ])));

    // 1. verification must not resolve.
    await expect(verifyMacosRemoteDesktopArtifact({
      artifactDirectory: candidate.artifactDirectory,
      manifestPath: candidate.manifestPath,
    }, dependencies(foreignTrust.execute)))
      .rejects.toThrow('macos_remote_desktop_artifact_manifest_invalid');

    // 2. it must never reach the store, so no path is ever returned.
    await expect(promoteMacosRemoteDesktopArtifact({
      ...candidate,
      storeRoot: candidate.storeRoot,
    }, dependencies(foreignTrust.execute)))
      .rejects.toThrow('macos_remote_desktop_artifact_manifest_invalid');
    expect(await selectMacosRemoteDesktopArtifact(
      candidate.storeRoot, 'current', dependencies(foreignTrust.execute),
    ).catch(() => null)).toBeNull();
  });

  it('fails current and LKG selection when the store is loosened AFTER a safe promote', async () => {
    // The auditor's second counterexample, and the reason ensureStore alone was
    // not enough: the store is legitimate at publish time and made writable
    // afterwards. Selection is the path that hands an executable to launch.
    const first = await fixture();
    const deps = dependencies(trustedExecutor().execute);
    await promoteMacosRemoteDesktopArtifact({ ...first, storeRoot: first.storeRoot }, deps);
    const second = await fixture('arm64', '2026.8.4600');
    const promoted = await promoteMacosRemoteDesktopArtifact({
      ...second, storeRoot: first.storeRoot,
    }, deps);
    // Both selectors resolve while the store is still safe.
    expect(await selectMacosRemoteDesktopArtifact(first.storeRoot, 'current', deps)).not.toBeNull();
    expect(await selectMacosRemoteDesktopArtifact(first.storeRoot, 'lastKnownGood', deps)).not.toBeNull();

    // TWO release directories exist: `current` is the second promote, and
    // `last-known-good` is the first. Loosening one must not be assumed to
    // affect the other -- each selector resolves its own release.
    const currentRelease = join(first.storeRoot, 'releases', promoted.releaseName!);
    const lkgName = (await selectMacosRemoteDesktopArtifact(
      first.storeRoot, 'lastKnownGood', deps))!.releaseName!;
    const lkgRelease = join(first.storeRoot, 'releases', lkgName);
    expect(lkgName).not.toBe(promoted.releaseName);
    const releaseDirs = [currentRelease, lkgRelease];
    const reset = async () => {
      await chmod(first.storeRoot, 0o700);
      await chmod(join(first.storeRoot, 'releases'), 0o700);
      for (const dir of releaseDirs) await chmod(dir, 0o700);
    };
    const loosenings: Array<[string, () => Promise<void>]> = [
      ['store world-writable', () => chmod(first.storeRoot, 0o777)],
      ['releases world-writable', () => chmod(join(first.storeRoot, 'releases'), 0o777)],
      ['each selected release world-writable', async () => {
        for (const dir of releaseDirs) await chmod(dir, 0o777);
      }],
      ['store group-writable', () => chmod(first.storeRoot, 0o770)],
    ];
    for (const [label, loosen] of loosenings) {
      await reset();
      await loosen();
      for (const selector of ['current', 'lastKnownGood'] as const) {
        await expect(
          selectMacosRemoteDesktopArtifact(first.storeRoot, selector, deps),
          `${label}/${selector}`,
        ).rejects.toThrow(/macos_remote_desktop_artifact_(?:store|releases|release)_untrusted/);
      }
    }
    // Restored permissions restore service -- the guard is not a one-way brick.
    await reset();
    expect(await selectMacosRemoteDesktopArtifact(first.storeRoot, 'current', deps)).not.toBeNull();
    expect(await selectMacosRemoteDesktopArtifact(first.storeRoot, 'lastKnownGood', deps)).not.toBeNull();
  });

  it('fails selection when the store is owned by a foreign uid, and never creates one', async () => {
    const candidate = await fixture();
    const deps = dependencies(trustedExecutor().execute);
    await promoteMacosRemoteDesktopArtifact({ ...candidate, storeRoot: candidate.storeRoot }, deps);
    const foreignUid = dependencies(
      trustedExecutor().execute, 'arm64', 'darwin', process.getuid!() + 1,
    );
    for (const selector of ['current', 'lastKnownGood'] as const) {
      await expect(
        selectMacosRemoteDesktopArtifact(candidate.storeRoot, selector, foreignUid), selector,
      ).rejects.toThrow(/macos_remote_desktop_artifact_(?:store|releases|release)_untrusted/);
    }

    // Selection must NEVER manufacture a store. A caller asking what is
    // installed and getting an empty store created for it would turn a missing
    // installation into a silent, writable one.
    const absent = join(candidate.root, 'never-created');
    await expect(selectMacosRemoteDesktopArtifact(absent, 'current', deps))
      .rejects.toThrow('macos_remote_desktop_artifact_store_not_directory');
    await expect(lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a selected release whose directory was replaced by a symlink', async () => {
    if (process.platform === 'win32') return;
    const candidate = await fixture();
    const deps = dependencies(trustedExecutor().execute);
    const promoted = await promoteMacosRemoteDesktopArtifact({
      ...candidate, storeRoot: candidate.storeRoot,
    }, deps);
    const releaseDirectory = join(candidate.storeRoot, 'releases', promoted.releaseName!);
    // Path replacement: same name, now pointing somewhere the attacker controls.
    const elsewhere = join(candidate.root, 'attacker-release');
    await mkdir(elsewhere, { mode: 0o700 });
    await rm(releaseDirectory, { recursive: true, force: true });
    await symlink(elsewhere, releaseDirectory);
    await expect(selectMacosRemoteDesktopArtifact(candidate.storeRoot, 'current', deps))
      .rejects.toThrow(/macos_remote_desktop_artifact_release_(?:not_directory|untrusted)/);
  });

  it('refuses a store or releases path that is a symlink', async () => {
    if (process.platform === 'win32') return;
    const candidate = await fixture();
    const real = join(candidate.root, 'elsewhere');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, candidate.storeRoot);
    await expect(promoteMacosRemoteDesktopArtifact({
      ...candidate,
      storeRoot: candidate.storeRoot,
    }, dependencies(trustedExecutor().execute)))
      .rejects.toThrow(/macos_remote_desktop_artifact_store_(?:not_directory|untrusted)/);

    const linkedReleases = await fixture();
    await mkdir(linkedReleases.storeRoot, { recursive: true, mode: 0o700 });
    const releasesTarget = join(linkedReleases.root, 'releases-elsewhere');
    await mkdir(releasesTarget, { mode: 0o700 });
    await symlink(releasesTarget, join(linkedReleases.storeRoot, 'releases'));
    await expect(promoteMacosRemoteDesktopArtifact({
      ...linkedReleases,
      storeRoot: linkedReleases.storeRoot,
    }, dependencies(trustedExecutor().execute)))
      .rejects.toThrow(/macos_remote_desktop_artifact_releases_(?:not_directory|untrusted)/);
  });
});
