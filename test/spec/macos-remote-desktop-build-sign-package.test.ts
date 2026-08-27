import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER,
  MACOS_REMOTE_DESKTOP_COMPONENT_ENTITLEMENTS,
  MACOS_REMOTE_DESKTOP_BUILD_TOOLS,
  MACOS_REMOTE_DESKTOP_HARDENED_RUNTIME_EXCEPTION_ENTITLEMENTS,
  assertPinnedCheckout,
  buildMacosRemoteDesktopBuildPlan,
  buildMacosRemoteDesktopManifest,
  macosRemoteDesktopBuildPlanSha256,
  macosRemoteDesktopDesignatedRequirement,
  parseMacosRemoteDesktopEntitlements,
  readMacosRemoteDesktopCodeIdentity,
  verifyBuiltMacosRemoteDesktopComponent,
} from '../../scripts/macos-remote-desktop-build.mjs';
import { PINNED_LIBWEBRTC_REVISION } from '../../shared/remote-desktop-native-pins.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS,
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
  validateRemoteDesktopWorkerReleaseManifest,
  REMOTE_DESKTOP_MACOS_TEAM_ID,
} from '../../shared/remote-desktop-worker.js';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NATIVE_DIR = join(REPOSITORY_ROOT, 'native', 'macos-remote-desktop');

const TEAM_ID = REMOTE_DESKTOP_MACOS_TEAM_ID;
const SIGNING_IDENTITY = '0123456789ABCDEF0123456789ABCDEF01234567';
const WORKER_VERSION = '1.2.3';

const PLAN_INPUT = {
  arch: 'arm64' as const,
  teamId: TEAM_ID,
  signingIdentity: SIGNING_IDENTITY,
  workerVersion: WORKER_VERSION,
};

const TOOLCHAIN = Object.freeze({
  xcode: '15.4',
  macosSdk: '14.5',
  clang: '15.0.0',
});

/** Deterministic, distinct payload per component so hashes cannot collide. */
function componentBytes(kind: string): Buffer {
  return Buffer.from(`imcodes-macos-remote-desktop:${kind}`, 'utf8');
}

interface FakeToolOverrides {
  archs?: string;
  minos?: string;
  codeDirectoryFlags?: string;
  identifier?: string;
  teamIdentifier?: string;
  designatedRequirement?: string;
  assessment?: string;
  staple?: string;
  verifyStatus?: number;
}

/**
 * Fake Apple toolchain. Every response is the *shape* the real tools emit, so a
 * counterfactual changes exactly one observable field and nothing else.
 */
function fakeTools(component: { bundleIdentifier: string }, overrides: FakeToolOverrides = {}) {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const run = async (executable: string, args: readonly string[]) => {
    calls.push({ executable, args });
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (executable === MACOS_REMOTE_DESKTOP_BUILD_TOOLS.lipo) {
      return ok(`${overrides.archs ?? 'arm64'}\n`);
    }
    if (executable === MACOS_REMOTE_DESKTOP_BUILD_TOOLS.otool) {
      return ok([
        'Load command 10',
        '      cmd LC_BUILD_VERSION',
        '  platform 1',
        `    minos ${overrides.minos ?? '12.3'}`,
        '      sdk 14.5',
      ].join('\n'));
    }
    if (executable === MACOS_REMOTE_DESKTOP_BUILD_TOOLS.codesign) {
      if (args[0] === '--verify') {
        return { status: overrides.verifyStatus ?? 0, stdout: '', stderr: 'valid on disk\n' };
      }
      if (args.includes('-r-')) {
        return ok(`designated => ${overrides.designatedRequirement
          ?? macosRemoteDesktopDesignatedRequirement(component.bundleIdentifier, TEAM_ID)}\n`);
      }
      return ok([
        'Executable=/tmp/component',
        `Identifier=${overrides.identifier ?? component.bundleIdentifier}`,
        'Format=Mach-O thin (arm64)',
        `CodeDirectory v=20500 size=1234 flags=${overrides.codeDirectoryFlags ?? '0x10000(runtime)'} hashes=1+7`,
        `TeamIdentifier=${overrides.teamIdentifier ?? TEAM_ID}`,
      ].join('\n'));
    }
    if (executable === MACOS_REMOTE_DESKTOP_BUILD_TOOLS.spctl) {
      return ok(overrides.assessment ?? '/tmp/component: accepted\nsource=Notarized Developer ID\n');
    }
    if (executable === MACOS_REMOTE_DESKTOP_BUILD_TOOLS.xcrun) {
      return ok(overrides.staple ?? 'Processing: /tmp/component\nThe validate action worked!\n');
    }
    throw new Error(`unexpected tool: ${executable}`);
  };
  return { run, calls };
}

async function planFixture() {
  return buildMacosRemoteDesktopBuildPlan(PLAN_INPUT, { repositoryRoot: REPOSITORY_ROOT });
}

async function verifyWith(overrides: FakeToolOverrides = {}, bytes?: Buffer) {
  const plan = await planFixture();
  const component = plan.components[0];
  const payload = bytes ?? componentBytes(component.kind);
  return verifyBuiltMacosRemoteDesktopComponent(plan, component, '/tmp/component', {
    ...fakeTools(component, overrides),
    readFile: async () => payload,
  });
}

describe('macOS remote-desktop deterministic build plan', () => {
  it('emits a machine-independent plan so two hosts with one checkout agree', async () => {
    const first = await planFixture();
    const second = await planFixture();
    expect(macosRemoteDesktopBuildPlanSha256(first))
      .toBe(macosRemoteDesktopBuildPlanSha256(second));
    // An absolute path would silently make planSha256 host-specific.
    expect(JSON.stringify(first)).not.toContain(REPOSITORY_ROOT);
    for (const component of first.components) {
      expect(component.entitlementsFile).toMatch(/^entitlements\/[a-z-]+\.entitlements$/);
    }
  });

  it('pins the build to the repository libwebrtc lock and forbids runtime downloads', async () => {
    const plan = await planFixture();
    expect(plan.libwebrtcRevision).toBe(PINNED_LIBWEBRTC_REVISION);
    expect(plan.runtimeDownloadsAllowed).toBe(false);
    const allowed = new Set(Object.values(MACOS_REMOTE_DESKTOP_BUILD_TOOLS));
    for (const component of plan.components) {
      expect(allowed.has(component.codesign[0])).toBe(true);
      for (const check of component.verify) expect(allowed.has(check[0])).toBe(true);
    }
    // No fetcher may appear anywhere in the plan.
    expect(JSON.stringify(plan)).not.toMatch(/\b(curl|wget|npm install|pip install|gclient sync)\b/);
  });

  it('refuses a universal binary because the runtime verifier requires a thin slice', async () => {
    const plan = await planFixture();
    expect(plan.universalBinary).toBe(false);
    await expect(verifyWith({ archs: 'x86_64 arm64' }))
      .rejects.toThrow(/must be thin arm64/);
  });

  it('does not claim byte-reproducible signed binaries', async () => {
    const plan = await planFixture();
    // `codesign --timestamp` embeds an RFC 3161 countersignature, so claiming
    // reproducibility for the signed artifact would be false.
    expect(plan.determinism.signedBinary).toBe('not-byte-reproducible-timestamped');
    expect(plan.determinism.unsignedBinary).toBe('reproducible');
    expect(plan.components[0].codesign).toContain('--timestamp');
  });

  it('builds every declared component exactly once in the declared order', async () => {
    const plan = await planFixture();
    expect(plan.components.map((component) => component.kind))
      .toEqual([...MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER]);
    expect(new Set(plan.ninjaTargets).size).toBe(plan.components.length);
  });
});

describe('macOS remote-desktop build graph honesty', () => {
  it('keeps the declared executable-target state consistent with BUILD.gn', async () => {
    const identity = await readMacosRemoteDesktopCodeIdentity(REPOSITORY_ROOT);
    const buildGn = await readFile(join(NATIVE_DIR, 'BUILD.gn'), 'utf8');
    const defined = new Set(
      [...buildGn.matchAll(/^\s*(?:rtc_executable|executable)\("([A-Za-z0-9_]+)"\)?\s*\{/gmu)]
        .map((match) => match[1]),
    );
    const declared = MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER
      .map((kind) => identity.components[kind].gnTarget.split(':')[1]);
    const allDefined = declared.every((target) => defined.has(target));
    // The point of this assertion is that the JSON cannot claim a buildable
    // pipeline while BUILD.gn has no such executable, and cannot keep claiming
    // "pending" once the targets land.
    expect(identity.executableTargetsDefined).toBe(allDefined);
  });

  it('routes every component through the single pinned libwebrtc sender bridge', async () => {
    const buildGn = await readFile(join(NATIVE_DIR, 'BUILD.gn'), 'utf8');
    expect(buildGn).toContain('source_set("pinned_libwebrtc_h264_sender_bridge")');
    // A second WebRTC stack would show up as an independent PeerConnection or
    // RTP implementation dependency alongside the pinned checkout.
    expect(buildGn).not.toMatch(/third_party\/(?!imcodes)[a-z0-9_]*webrtc/i);
    expect(buildGn).not.toMatch(/\blibdatachannel\b|\bpion\b|\bmediasoup\b|\baiortc\b/i);
  });

  it('exposes the pending build-graph state on the plan itself', async () => {
    const plan = await planFixture();
    const identity = await readMacosRemoteDesktopCodeIdentity(REPOSITORY_ROOT);
    expect(plan.executableTargetsDefined).toBe(identity.executableTargetsDefined);
  });
});

describe('macOS remote-desktop code identity', () => {
  it('uses the same launch-agent bundle identifier as the daemon launch agent', async () => {
    const identity = await readMacosRemoteDesktopCodeIdentity(REPOSITORY_ROOT);
    const userSession = await readFile(
      join(REPOSITORY_ROOT, 'src', 'node', 'macos-user-session.ts'),
      'utf8',
    );
    // Two files must not be allowed to disagree about the identity TCC grants
    // are bound to; an upgrade that changes it silently drops every grant.
    expect(userSession).toContain(`bundleIdentifier: '${identity.components.launchAgent.bundleIdentifier}'`);
  });

  it('gives each component a distinct stable identity', async () => {
    const identity = await readMacosRemoteDesktopCodeIdentity(REPOSITORY_ROOT);
    const ids = MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER
      .map((kind) => identity.components[kind].bundleIdentifier);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('emits the exact designated requirement string the shared validator compares', async () => {
    const plan = await planFixture();
    for (const component of plan.components) {
      expect(component.designatedRequirement).toBe(
        `identifier "${component.bundleIdentifier}" and anchor apple generic `
        + `and certificate leaf[subject.OU] = "${TEAM_ID}"`,
      );
    }
  });

  it('rejects a malformed Team ID before any tool runs', async () => {
    await expect(buildMacosRemoteDesktopBuildPlan(
      { ...PLAN_INPUT, teamId: 'abcde12345' },
      { repositoryRoot: REPOSITORY_ROOT },
    )).rejects.toThrow(/Team ID/);
  });

  it('requires the exact signing certificate fingerprint, not a common name', async () => {
    await expect(buildMacosRemoteDesktopBuildPlan(
      { ...PLAN_INPUT, signingIdentity: 'Developer ID Application: Example' },
      { repositoryRoot: REPOSITORY_ROOT },
    )).rejects.toThrow(/fingerprint/);
  });
});

describe('macOS remote-desktop entitlements', () => {
  it('pins one distinct canonical entitlement file to each component', async () => {
    const identity = await readMacosRemoteDesktopCodeIdentity(REPOSITORY_ROOT);
    const actual = Object.fromEntries(MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER.map(
      (kind) => [kind, identity.components[kind].entitlements],
    ));
    expect(actual).toEqual(MACOS_REMOTE_DESKTOP_COMPONENT_ENTITLEMENTS);
    expect(new Set(Object.values(actual)).size).toBe(MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER.length);
  });

  it('rejects a component that aliases another component entitlement file', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'imcodes-entitlements-alias-'));
    const nativeDir = join(repositoryRoot, 'native', 'macos-remote-desktop');
    try {
      await cp(NATIVE_DIR, nativeDir, { recursive: true });
      const identityPath = join(nativeDir, 'code-identity.json');
      const identity = JSON.parse(await readFile(identityPath, 'utf8'));
      identity.components.launchAgent.entitlements = identity.components.worker.entitlements;
      await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
      await expect(readMacosRemoteDesktopCodeIdentity(repositoryRoot))
        .rejects.toThrow(/invalid macOS remote-desktop code identity component: launchAgent/);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('ships hardened-runtime entitlements with no exception for any component', async () => {
    const identity = await readMacosRemoteDesktopCodeIdentity(REPOSITORY_ROOT);
    for (const kind of MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER) {
      const text = await readFile(join(NATIVE_DIR, identity.components[kind].entitlements), 'utf8');
      const parsed = parseMacosRemoteDesktopEntitlements(text);
      expect(parsed).toEqual({ 'com.apple.security.get-task-allow': false });
    }
  });

  it.each(MACOS_REMOTE_DESKTOP_HARDENED_RUNTIME_EXCEPTION_ENTITLEMENTS.flatMap(
    (exception) => [[exception, true], [exception, false]] as const,
  ))(
    'fails closed when known Hardened Runtime exception %s is %s',
    (exception, value) => {
      const text = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        '<dict>',
        '\t<key>com.apple.security.get-task-allow</key>',
        '\t<false/>',
        `\t<key>${exception}</key>`,
        `\t<${String(value)}/>`,
        '</dict>',
        '</plist>',
      ].join('\n');
      expect(() => parseMacosRemoteDesktopEntitlements(text))
        .toThrow(/unsupported macOS remote-desktop entitlement/);
    },
  );

  it.each([true, false])('fails closed on an unknown boolean entitlement set to %s', async (value) => {
    const text = [
      '<plist version="1.0">',
      '<dict>',
      '\t<key>com.apple.security.get-task-allow</key>',
      '\t<false/>',
      '\t<key>com.apple.security.device.camera</key>',
      `\t<${String(value)}/>`,
      '</dict>',
      '</plist>',
    ].join('\n');
    expect(() => parseMacosRemoteDesktopEntitlements(text))
      .toThrow(/unsupported macOS remote-desktop entitlement/);
  });

  it('fails closed when get-task-allow is not explicitly denied', () => {
    const text = '<plist version="1.0">\n<dict>\n</dict>\n</plist>';
    expect(() => parseMacosRemoteDesktopEntitlements(text))
      .toThrow(/get-task-allow/);
  });

  it('fails closed on an entitlement shape it cannot evaluate', () => {
    const text = [
      '<plist version="1.0">',
      '<dict>',
      '\t<key>com.apple.security.get-task-allow</key>',
      '\t<false/>',
      '\t<key>com.apple.security.temporary-exception.files.absolute-path.read-write</key>',
      '\t<array><string>/</string></array>',
      '</dict>',
      '</plist>',
    ].join('\n');
    // Silently ignoring an unparsed entitlement would let a grant ship unseen.
    expect(() => parseMacosRemoteDesktopEntitlements(text))
      .toThrow(/unsupported entry/);
  });

  it('binds the entitlements bytes into the plan identity', async () => {
    const plan = await planFixture();
    expect(plan.entitlementsPlanSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(macosRemoteDesktopBuildPlanSha256(plan)).toMatch(/^[a-f0-9]{64}$/);
    const identity = await readMacosRemoteDesktopCodeIdentity(REPOSITORY_ROOT);
    for (const component of plan.components) {
      const text = await readFile(
        join(NATIVE_DIR, identity.components[component.kind].entitlements),
        'utf8',
      );
      expect(component.entitlementsSha256)
        .toBe(createHash('sha256').update(text).digest('hex'));
    }
  });
});

describe('macOS remote-desktop post-build guards', () => {
  it('accepts a correctly built, signed, notarized and stapled component', async () => {
    const measured = await verifyWith();
    expect(measured.size).toBe(componentBytes('worker').length);
    expect(measured.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('runs every declared guard against the artifact', async () => {
    const plan = await planFixture();
    const component = plan.components[0];
    const tools = fakeTools(component);
    await verifyBuiltMacosRemoteDesktopComponent(plan, component, '/tmp/component', {
      run: tools.run,
      readFile: async () => componentBytes(component.kind),
    });
    const executed = tools.calls.map((call) => call.executable);
    for (const tool of [
      MACOS_REMOTE_DESKTOP_BUILD_TOOLS.lipo,
      MACOS_REMOTE_DESKTOP_BUILD_TOOLS.otool,
      MACOS_REMOTE_DESKTOP_BUILD_TOOLS.codesign,
      MACOS_REMOTE_DESKTOP_BUILD_TOOLS.spctl,
      MACOS_REMOTE_DESKTOP_BUILD_TOOLS.xcrun,
    ]) {
      expect(executed).toContain(tool);
    }
    // Every tool must be invoked by absolute path, never resolved via PATH.
    for (const call of tools.calls) expect(call.executable.startsWith('/')).toBe(true);
  });

  it('rejects the wrong architecture slice', async () => {
    await expect(verifyWith({ archs: 'x86_64' })).rejects.toThrow(/must be thin arm64/);
  });

  it('rejects a raised minimum OS version', async () => {
    await expect(verifyWith({ minos: '14.0' })).rejects.toThrow(/minimum OS/);
  });

  it('rejects a binary signed without the Hardened Runtime', async () => {
    await expect(verifyWith({ codeDirectoryFlags: '0x0(none)' }))
      .rejects.toThrow(/Hardened Runtime/);
  });

  it('rejects a mismatched signing identifier', async () => {
    await expect(verifyWith({ identifier: 'cc.imcodes.node.something-else' }))
      .rejects.toThrow(/wrong signing identifier/);
  });

  it('rejects a mismatched Team ID', async () => {
    await expect(verifyWith({ teamIdentifier: 'ZZZZZ99999' }))
      .rejects.toThrow(/wrong Team ID/);
  });

  it('rejects a designated requirement that is not identity-bound', async () => {
    await expect(verifyWith({
      designatedRequirement: 'anchor apple generic',
    })).rejects.toThrow(/designated requirement/);
  });

  it('rejects an unnotarized assessment', async () => {
    await expect(verifyWith({
      assessment: '/tmp/component: accepted\nsource=Developer ID\n',
    })).rejects.toThrow(/notarized Developer ID/);
  });

  it('rejects a missing stapled ticket', async () => {
    await expect(verifyWith({
      staple: 'Processing: /tmp/component\nCloudKit query for ... failed\n',
    })).rejects.toThrow(/stapled notarization ticket/);
  });

  it('rejects a failing codesign verification', async () => {
    await expect(verifyWith({ verifyStatus: 1 })).rejects.toThrow(/build tool reported failure/);
  });

  it('rejects an empty component', async () => {
    await expect(verifyWith({}, Buffer.alloc(0))).rejects.toThrow(/out-of-range size/);
  });

  it('rejects a component larger than the shared limit', async () => {
    const oversize = { length: REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS.worker + 1 } as Buffer;
    await expect(verifyWith({}, oversize)).rejects.toThrow(/out-of-range size/);
  });
});

describe('macOS remote-desktop manifest emission', () => {
  it('emits a manifest the shared strict validator accepts', async () => {
    const plan = await planFixture();
    const measured: Record<string, { size: number; sha256: string }> = {};
    const evidence: Record<string, { submissionId: string; ticketSha256: string }> = {};
    for (const component of plan.components) {
      const bytes = componentBytes(component.kind);
      measured[component.kind] = {
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      evidence[component.kind] = {
        submissionId: '3e6a1c2d-9f4b-4a7c-8d1e-5b6c7d8e9f01',
        ticketSha256: createHash('sha256').update(`ticket:${component.kind}`).digest('hex'),
      };
    }
    const manifest = buildMacosRemoteDesktopManifest(plan, measured, evidence, TOOLCHAIN, {
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    });
    const validated = validateRemoteDesktopWorkerReleaseManifest(
      JSON.parse(JSON.stringify(manifest)),
      { os: 'darwin', arch: 'arm64' },
    );
    expect(validated).not.toBeNull();
    expect(validated?.os).toBe('darwin');
  });

  it('refuses to emit a manifest with missing notarization evidence', async () => {
    const plan = await planFixture();
    expect(() => buildMacosRemoteDesktopManifest(plan, {}, {}, TOOLCHAIN, {
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    })).toThrow(/missing measurement or notarization evidence/);
  });
});

describe('macOS remote-desktop pinned checkout gate', () => {
  it('accepts the locked revisions', async () => {
    const revisions = [PINNED_LIBWEBRTC_REVISION, 'a1bda5b6167435ad0666191f0353f242104f5845'];
    let index = 0;
    await expect(assertPinnedCheckout('/webrtc', '/depot_tools', {
      run: async () => ({ status: 0, stdout: `${revisions[index++]}\n`, stderr: '' }),
    })).resolves.toBe(true);
  });

  it('rejects an unpinned WebRTC checkout before any build tool runs', async () => {
    await expect(assertPinnedCheckout('/webrtc', '/depot_tools', {
      run: async () => ({ status: 0, stdout: `${'0'.repeat(40)}\n`, stderr: '' }),
    })).rejects.toThrow(/libwebrtc revision mismatch/);
  });
});
