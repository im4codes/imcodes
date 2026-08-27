#!/usr/bin/env node
/**
 * Deterministic macOS remote-desktop build / sign / package orchestration.
 *
 * This module is the producer counterpart to the existing verifiers:
 *   - src/node/macos-remote-desktop-artifact.ts  (runtime artifact trust)
 *   - scripts/macos-remote-desktop-release-guard.ts (pre-publication guard)
 *   - shared/remote-desktop-worker.ts (strict manifest validator)
 *
 * Everything here is expressed as a *plan* first and executed second, so the
 * entire contract can be asserted with fake tool fixtures on a machine that has
 * no signing identity, no notarization credentials and no pinned checkout.
 *
 * Deliberate non-goals:
 *   - No compiler, SDK or codec is downloaded. The pinned checkout and the
 *     Xcode command line tools must already exist; `assertNoRuntimeDownloads`
 *     is asserted by tests against the emitted plan.
 *   - No universal (fat) binaries. `verifyMacosRemoteDesktopArtifact` requires
 *     `lipo -archs` to report exactly one architecture, so a fat binary would
 *     be rejected at runtime. Thin per-architecture builds are the only shape
 *     the rest of the pipeline accepts.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
  REMOTE_DESKTOP_MACOS_ARCHITECTURES,
  REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS,
  REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
  REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
  REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
} from './remote-desktop-worker-artifacts.mjs';
import { validateMacosLibwebrtcNotices } from './libwebrtc-sdk-artifacts.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');

export const MACOS_REMOTE_DESKTOP_BUILD_PLAN_VERSION = 1;

/** Declared component order. Must match the release guard's component order. */
export const MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER = Object.freeze([
  'worker',
  'launchAgent',
  'disclosure',
  'virtualDisplayHelper',
]);

export const MACOS_REMOTE_DESKTOP_COMPONENT_FILENAMES = Object.freeze({
  worker: REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  launchAgent: REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  disclosure: REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  virtualDisplayHelper: REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
});

/** Canonical one-file-per-component signing policy; aliases fail closed. */
export const MACOS_REMOTE_DESKTOP_COMPONENT_ENTITLEMENTS = Object.freeze({
  worker: 'entitlements/worker.entitlements',
  launchAgent: 'entitlements/launch-agent.entitlements',
  disclosure: 'entitlements/disclosure.entitlements',
  virtualDisplayHelper: 'entitlements/virtual-display-helper.entitlements',
});

/**
 * Absolute tool paths. Pinned rather than PATH-resolved so a poisoned PATH
 * cannot substitute the signing or verification tools during a release build.
 */
export const MACOS_REMOTE_DESKTOP_BUILD_TOOLS = Object.freeze({
  codesign: '/usr/bin/codesign',
  lipo: '/usr/bin/lipo',
  otool: '/usr/bin/otool',
  spctl: '/usr/sbin/spctl',
  xcrun: '/usr/bin/xcrun',
  git: '/usr/bin/git',
});

/** Known Hardened Runtime exceptions used by the negative-test matrix. */
export const MACOS_REMOTE_DESKTOP_HARDENED_RUNTIME_EXCEPTION_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.cs.disable-library-validation',
]);

/**
 * The complete entitlement contract. This is an allowlist, not a denylist:
 * even an unknown key set to false changes the signed identity contract and is
 * therefore rejected until it is reviewed and added here deliberately.
 */
export const MACOS_REMOTE_DESKTOP_ALLOWED_ENTITLEMENTS = Object.freeze({
  'com.apple.security.get-task-allow': false,
});

/** GN arguments, sorted, with no host-specific or time-varying input. */
export const MACOS_REMOTE_DESKTOP_GN_ARGS = Object.freeze([
  'is_component_build=false',
  'is_debug=false',
  'rtc_build_examples=false',
  'rtc_enable_protobuf=false',
  'rtc_include_tests=false',
  'symbol_level=1',
  'use_rtti=false',
]);

const ARCHITECTURE_TARGETS = Object.freeze({
  arm64: Object.freeze({ gnTargetCpu: 'arm64', machoArchitecture: 'arm64', hostUname: 'arm64' }),
  x64: Object.freeze({ gnTargetCpu: 'x64', machoArchitecture: 'x86_64', hostUname: 'x86_64' }),
});

const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^(?=.{3,255}$)(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z0-9][A-Za-z0-9-]*$/;
const MACOS_VERSION_RE = /^(?:1[0-9]|[2-9][0-9])\.[0-9]{1,2}(?:\.[0-9]{1,2})?$/;
const GN_TARGET_RE = /^\/\/[A-Za-z0-9_./-]+:[A-Za-z0-9_-]+$/;
const SIGNING_IDENTITY_RE = /^[A-F0-9]{40}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The designated requirement string is byte-compared by
 * `shared/remote-desktop-worker.ts`. Generating it from one place keeps the
 * producer and the validator from drifting.
 */
export function macosRemoteDesktopDesignatedRequirement(bundleIdentifier, teamId) {
  if (typeof bundleIdentifier !== 'string' || !BUNDLE_ID_RE.test(bundleIdentifier)) {
    throw new Error('invalid bundle identifier');
  }
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new Error('invalid Apple Team ID');
  }
  return `identifier "${bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

/**
 * Parse an entitlements plist and require the exact reviewed allowlist.
 *
 * A deliberately small XML-plist reader: it accepts only the `<key>` /
 * `<true/>` / `<false/>` shape these files are allowed to use, so a file that
 * smuggles in a string, array or dict entitlement fails closed instead of
 * being silently ignored.
 */
export function parseMacosRemoteDesktopEntitlements(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64 * 1024) {
    throw new Error('invalid entitlements document');
  }
  const body = text.match(/<dict>([\s\S]*?)<\/dict>/u);
  if (!body) throw new Error('entitlements document has no dict');
  const entries = new Map();
  // Consume the dict left to right. Anything that is not a recognized boolean
  // entry (a string, array, nested dict, comment, stray text) leaves a
  // non-whitespace residue at the cursor and fails closed, so an entitlement
  // this reader does not understand can never be silently ignored.
  let cursor = 0;
  const token = /^\s*<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/u;
  for (;;) {
    const rest = body[1].slice(cursor);
    if (rest.trim().length === 0) break;
    const match = token.exec(rest);
    if (!match) throw new Error('entitlements document contains an unsupported entry');
    if (entries.has(match[1])) throw new Error(`duplicate entitlement ${match[1]}`);
    entries.set(match[1], match[2] === 'true');
    cursor += match[0].length;
  }
  for (const key of entries.keys()) {
    if (!Object.prototype.hasOwnProperty.call(MACOS_REMOTE_DESKTOP_ALLOWED_ENTITLEMENTS, key)) {
      throw new Error(`unsupported macOS remote-desktop entitlement: ${key}`);
    }
  }
  for (const [key, required] of Object.entries(MACOS_REMOTE_DESKTOP_ALLOWED_ENTITLEMENTS)) {
    if (entries.get(key) !== required) {
      throw new Error(`macOS remote-desktop entitlement must equal ${String(required)}: ${key}`);
    }
  }
  return Object.freeze(Object.fromEntries([...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))));
}

/**
 * Read the reviewed entitlement files and produce their canonical signing-plan
 * digest. Both the build plan and release guard consume this exact field, so
 * the immutable release identity cannot omit entitlement-byte changes.
 */
export async function readMacosRemoteDesktopEntitlementsPlan(repositoryRoot = REPOSITORY_ROOT) {
  const identity = await readMacosRemoteDesktopCodeIdentity(repositoryRoot);
  const nativeDir = join(repositoryRoot, 'native', 'macos-remote-desktop');
  const components = [];
  for (const kind of MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER) {
    const declared = identity.components[kind];
    const entitlementsText = await readFile(join(nativeDir, declared.entitlements), 'utf8');
    components.push(Object.freeze({
      kind,
      entitlementsFile: declared.entitlements,
      entitlementsSha256: sha256(entitlementsText),
      entitlements: parseMacosRemoteDesktopEntitlements(entitlementsText),
    }));
  }
  const digestMaterial = {
    componentOrder: MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER,
    components: components.map(({ kind, entitlementsFile, entitlementsSha256 }) => ({
      kind,
      entitlementsFile,
      entitlementsSha256,
    })),
  };
  return Object.freeze({
    identity,
    components: Object.freeze(components),
    entitlementsPlanSha256: sha256(JSON.stringify(digestMaterial)),
  });
}

/** Load and strictly validate native/macos-remote-desktop/code-identity.json. */
export async function readMacosRemoteDesktopCodeIdentity(repositoryRoot = REPOSITORY_ROOT) {
  const path = join(repositoryRoot, 'native', 'macos-remote-desktop', 'code-identity.json');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(parsed)
    || !exactKeys(parsed, [
      'identityVersion',
      'minimumMacosVersion',
      'hardenedRuntime',
      'executableTargetsDefined',
      'executableTargetsPendingReason',
      'components',
    ])
    || parsed.identityVersion !== 1
    || parsed.hardenedRuntime !== true
    || typeof parsed.minimumMacosVersion !== 'string'
    || !MACOS_VERSION_RE.test(parsed.minimumMacosVersion)
    || typeof parsed.executableTargetsDefined !== 'boolean'
    || typeof parsed.executableTargetsPendingReason !== 'string'
    || !isRecord(parsed.components)
    || !exactKeys(parsed.components, [...MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER])) {
    throw new Error('invalid macOS remote-desktop code identity');
  }
  // A pending declaration must carry its reason, and a target that claims to be
  // buildable must not carry one. Either way the state is explicit rather than
  // inferred from whether `gn gen` happens to fail.
  if (parsed.executableTargetsDefined === (parsed.executableTargetsPendingReason.length > 0)) {
    throw new Error('code identity must state exactly one of defined targets or a pending reason');
  }
  const bundleIdentifiers = new Set();
  for (const kind of MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER) {
    const component = parsed.components[kind];
    if (!isRecord(component)
      || !exactKeys(component, ['bundleIdentifier', 'fileName', 'entitlements', 'gnTarget'])
      || typeof component.bundleIdentifier !== 'string'
      || !BUNDLE_ID_RE.test(component.bundleIdentifier)
      || bundleIdentifiers.has(component.bundleIdentifier)
      || component.fileName !== MACOS_REMOTE_DESKTOP_COMPONENT_FILENAMES[kind]
      || component.entitlements !== MACOS_REMOTE_DESKTOP_COMPONENT_ENTITLEMENTS[kind]
      || typeof component.gnTarget !== 'string'
      || !GN_TARGET_RE.test(component.gnTarget)) {
      throw new Error(`invalid macOS remote-desktop code identity component: ${kind}`);
    }
    bundleIdentifiers.add(component.bundleIdentifier);
  }
  return Object.freeze(parsed);
}

function validateBuildInput(input) {
  if (!isRecord(input)) throw new Error('invalid build input');
  const {
    arch, teamId, signingIdentity, workerVersion,
  } = input;
  if (!REMOTE_DESKTOP_MACOS_ARCHITECTURES.includes(arch)) {
    throw new Error(`unsupported architecture: ${String(arch)}`);
  }
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new Error('invalid Apple Team ID');
  }
  // A Team ID or common-name identity can match more than one keychain item.
  // Requiring the SHA-1 fingerprint makes the signing certificate exact.
  if (typeof signingIdentity !== 'string' || !SIGNING_IDENTITY_RE.test(signingIdentity)) {
    throw new Error('signing identity must be the 40-hex-character certificate fingerprint');
  }
  if (typeof workerVersion !== 'string' || !VERSION_RE.test(workerVersion)) {
    throw new Error('invalid worker version');
  }
}

/**
 * Produce the complete, deterministic build/sign/verify plan.
 *
 * The plan is a pure function of the repository contents plus the four inputs,
 * so two invocations on two machines with the same checkout emit byte-identical
 * plans. The *signed binaries* are not byte-reproducible because `--timestamp`
 * embeds an RFC 3161 countersignature; that is recorded explicitly in
 * `plan.determinism` rather than being claimed away.
 */
export async function buildMacosRemoteDesktopBuildPlan(input, options = {}) {
  validateBuildInput(input);
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const entitlementsPlan = await readMacosRemoteDesktopEntitlementsPlan(repositoryRoot);
  const identity = entitlementsPlan.identity;
  const architecture = ARCHITECTURE_TARGETS[input.arch];

  const components = [];
  for (const entitlementComponent of entitlementsPlan.components) {
    const { kind } = entitlementComponent;
    const declared = identity.components[kind];
    components.push(Object.freeze({
      kind,
      fileName: declared.fileName,
      bundleIdentifier: declared.bundleIdentifier,
      gnTarget: declared.gnTarget,
      // Repository-relative on purpose: an absolute path would make the plan
      // (and therefore planSha256) differ between two machines holding the
      // same checkout, which would contradict `determinism.source`. The
      // executor resolves it against the repository root.
      entitlementsFile: entitlementComponent.entitlementsFile,
      entitlementsSha256: entitlementComponent.entitlementsSha256,
      entitlements: entitlementComponent.entitlements,
      designatedRequirement: macosRemoteDesktopDesignatedRequirement(
        declared.bundleIdentifier,
        input.teamId,
      ),
      codesign: Object.freeze([
        MACOS_REMOTE_DESKTOP_BUILD_TOOLS.codesign,
        '--force',
        '--sign', input.signingIdentity,
        '--identifier', declared.bundleIdentifier,
        '--options', 'runtime',
        '--entitlements', declared.entitlements,
        '--timestamp',
        '--generate-entitlement-der',
      ]),
      verify: Object.freeze([
        Object.freeze([MACOS_REMOTE_DESKTOP_BUILD_TOOLS.lipo, '-archs']),
        Object.freeze([MACOS_REMOTE_DESKTOP_BUILD_TOOLS.otool, '-l']),
        Object.freeze([MACOS_REMOTE_DESKTOP_BUILD_TOOLS.codesign, '--verify', '--strict', '--deep', '--verbose=2']),
        Object.freeze([MACOS_REMOTE_DESKTOP_BUILD_TOOLS.codesign, '--display', '--verbose=4']),
        Object.freeze([MACOS_REMOTE_DESKTOP_BUILD_TOOLS.codesign, '--display', '-r-']),
        Object.freeze([MACOS_REMOTE_DESKTOP_BUILD_TOOLS.spctl, '--assess', '--type', 'execute', '-vv']),
        Object.freeze([MACOS_REMOTE_DESKTOP_BUILD_TOOLS.xcrun, 'stapler', 'validate']),
      ]),
    }));
  }

  const gnArgs = [
    ...MACOS_REMOTE_DESKTOP_GN_ARGS,
    `mac_deployment_target="${identity.minimumMacosVersion}"`,
    `target_cpu="${architecture.gnTargetCpu}"`,
    'target_os="mac"',
  ].sort();

  return Object.freeze({
    planVersion: MACOS_REMOTE_DESKTOP_BUILD_PLAN_VERSION,
    arch: input.arch,
    machoArchitecture: architecture.machoArchitecture,
    requiredHostUname: architecture.hostUname,
    workerVersion: input.workerVersion,
    teamId: input.teamId,
    minimumMacosVersion: identity.minimumMacosVersion,
    hardenedRuntime: true,
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    depotToolsRevision: PINNED_DEPOT_TOOLS_REVISION,
    runtimeDownloadsAllowed: false,
    universalBinary: false,
    componentOrder: MACOS_REMOTE_DESKTOP_BUILD_COMPONENT_ORDER,
    entitlementsPlanSha256: entitlementsPlan.entitlementsPlanSha256,
    components: Object.freeze(components),
    gnArgs: Object.freeze(gnArgs),
    ninjaTargets: Object.freeze(components.map((component) => component.gnTarget).sort()),
    environment: Object.freeze({
      MACOSX_DEPLOYMENT_TARGET: identity.minimumMacosVersion,
      // Strip the archive member mtimes libtool would otherwise embed.
      ZERO_AR_DATE: '1',
      // Neutralize __DATE__/__TIME__ and any path-dependent debug prefix.
      SOURCE_DATE_EPOCH: '0',
    }),
    determinism: Object.freeze({
      source: 'pinned-revision',
      unsignedBinary: 'reproducible',
      // Honest: an RFC 3161 countersignature is time-varying by construction.
      signedBinary: 'not-byte-reproducible-timestamped',
      identityProof: 'designated-requirement-and-manifest-hash',
    }),
    manifestFileName: REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
    // Surfaced in the plan on purpose: a caller must be able to tell a
    // fully-wired pipeline from a declared contract without reading BUILD.gn.
    executableTargetsDefined: identity.executableTargetsDefined,
    planSha256: '',
  });
}

/** Stable identity of a plan; changing an entitlement changes this value. */
export function macosRemoteDesktopBuildPlanSha256(plan) {
  const canonical = JSON.stringify(plan, (key, value) => (key === 'planSha256' ? undefined : value));
  return sha256(canonical);
}

function commandText(result) {
  if (!isRecord(result) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    throw new Error('invalid command result');
  }
  if (result.status !== 0) throw new Error('build tool reported failure');
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * Post-build guards. Each check is the producer-side mirror of a check the
 * runtime verifier performs, so an artifact that would be rejected on a user's
 * Mac is rejected here instead of being published.
 */
export async function verifyBuiltMacosRemoteDesktopComponent(plan, component, executablePath, dependencies) {
  const run = dependencies.run;
  if (typeof run !== 'function') throw new Error('missing command runner');

  const archs = commandText(await run(
    MACOS_REMOTE_DESKTOP_BUILD_TOOLS.lipo,
    ['-archs', executablePath],
  )).trim().split(/\s+/u).filter(Boolean);
  if (archs.length !== 1 || archs[0] !== plan.machoArchitecture) {
    // A fat binary is rejected here because verifyMacosRemoteDesktopArtifact
    // requires exactly one architecture at runtime.
    throw new Error(`component ${component.kind} must be thin ${plan.machoArchitecture}, found: ${archs.join(',') || 'none'}`);
  }

  const loadCommands = commandText(await run(
    MACOS_REMOTE_DESKTOP_BUILD_TOOLS.otool,
    ['-l', executablePath],
  ));
  const minos = new RegExp(`minos\\s+${plan.minimumMacosVersion.replace(/\./gu, '\\.')}(?:\\s|$)`, 'mu');
  if (!minos.test(loadCommands)) {
    throw new Error(`component ${component.kind} does not encode macOS ${plan.minimumMacosVersion} as its minimum OS`);
  }

  commandText(await run(
    MACOS_REMOTE_DESKTOP_BUILD_TOOLS.codesign,
    ['--verify', '--strict', '--deep', '--verbose=2', executablePath],
  ));

  const display = commandText(await run(
    MACOS_REMOTE_DESKTOP_BUILD_TOOLS.codesign,
    ['--display', '--verbose=4', executablePath],
  ));
  if (!/^CodeDirectory .* flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/imu.test(display)) {
    throw new Error(`component ${component.kind} is not signed with the Hardened Runtime`);
  }
  if (!new RegExp(`^Identifier=${component.bundleIdentifier.replace(/[.]/gu, '\\.')}$`, 'mu').test(display)) {
    throw new Error(`component ${component.kind} has the wrong signing identifier`);
  }
  if (!/^TeamIdentifier=/mu.test(display)
    || !new RegExp(`^TeamIdentifier=${plan.teamId}$`, 'mu').test(display)) {
    throw new Error(`component ${component.kind} has the wrong Team ID`);
  }

  const requirement = commandText(await run(
    MACOS_REMOTE_DESKTOP_BUILD_TOOLS.codesign,
    ['--display', '-r-', executablePath],
  ));
  if (!requirement.includes(component.designatedRequirement)) {
    throw new Error(`component ${component.kind} has an unexpected designated requirement`);
  }

  const assessment = commandText(await run(
    MACOS_REMOTE_DESKTOP_BUILD_TOOLS.spctl,
    ['--assess', '--type', 'execute', '-vv', executablePath],
  ));
  if (!/\bsource=Notarized Developer ID\b/u.test(assessment)) {
    throw new Error(`component ${component.kind} is not assessed as a notarized Developer ID binary`);
  }

  const staple = commandText(await run(
    MACOS_REMOTE_DESKTOP_BUILD_TOOLS.xcrun,
    ['stapler', 'validate', executablePath],
  ));
  if (!/The validate action worked!/u.test(staple)) {
    throw new Error(`component ${component.kind} has no stapled notarization ticket`);
  }

  const bytes = await dependencies.readFile(executablePath);
  const size = bytes.length;
  const limit = REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS[component.kind];
  if (!Number.isSafeInteger(size) || size <= 0 || (typeof limit === 'number' && size > limit)) {
    throw new Error(`component ${component.kind} has an out-of-range size`);
  }
  return Object.freeze({ size, sha256: sha256(bytes) });
}

/**
 * Assemble the strict v3 manifest. Returned, never written here, so the caller
 * (and the release guard) decides publication.
 */
export function buildMacosRemoteDesktopManifest(plan, measured, evidence, toolchain, protocol) {
  const components = {};
  for (const component of plan.components) {
    const measurement = measured[component.kind];
    const notarization = evidence[component.kind];
    if (!isRecord(measurement) || !isRecord(notarization)) {
      throw new Error(`missing measurement or notarization evidence for ${component.kind}`);
    }
    if (typeof measurement.sha256 !== 'string' || !SHA256_RE.test(measurement.sha256)) {
      throw new Error(`invalid measurement for ${component.kind}`);
    }
    components[component.kind] = {
      fileName: component.fileName,
      size: measurement.size,
      sha256: measurement.sha256,
      notarization: {
        status: 'accepted',
        submissionId: notarization.submissionId,
        ticketSha256: notarization.ticketSha256,
        stapled: true,
        stapleValidated: true,
      },
    };
  }
  const bundles = {};
  for (const component of plan.components) {
    bundles[component.kind] = {
      bundleIdentifier: component.bundleIdentifier,
      designatedRequirement: component.designatedRequirement,
      hardenedRuntime: true,
    };
  }
  return {
    manifestVersion: REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
    artifactKind: REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
    workerVersion: plan.workerVersion,
    protocolVersion: protocol.protocolVersion,
    ipcVersion: protocol.ipcVersion,
    os: 'darwin',
    arch: plan.arch,
    components,
    libwebrtcRevision: plan.libwebrtcRevision,
    minimumOsVersion: plan.minimumMacosVersion,
    codeSignature: { teamId: plan.teamId, bundles },
    toolchain,
  };
}

/** Notices must be complete before a manifest can be published. */
export async function assertMacosRemoteDesktopNotices(noticesPath, dependencies = {}) {
  const read = dependencies.readFile ?? readFile;
  const text = await read(noticesPath, 'utf8');
  return validateMacosLibwebrtcNotices(
    typeof text === 'string' ? text : String(text),
    PINNED_LIBWEBRTC_REVISION,
  );
}

/** The pinned checkout must be exactly the locked revision before any build. */
export async function assertPinnedCheckout(webrtcRoot, depotToolsRoot, dependencies) {
  const run = dependencies.run;
  const pairs = [
    [webrtcRoot, PINNED_LIBWEBRTC_REVISION, 'libwebrtc'],
    [depotToolsRoot, PINNED_DEPOT_TOOLS_REVISION, 'depot_tools'],
  ];
  for (const [root, expected, label] of pairs) {
    const actual = commandText(await run(
      MACOS_REMOTE_DESKTOP_BUILD_TOOLS.git,
      ['-C', root, 'rev-parse', 'HEAD'],
    )).trim().split(/\s+/u)[0];
    if (actual !== expected) {
      throw new Error(`${label} revision mismatch: ${actual} (expected ${expected})`);
    }
  }
  return true;
}

async function main(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length;) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new Error(`unexpected argument: ${String(token)}`);
    }
    const next = argv[index + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      args.set(token.slice(2), next);
      index += 2;
    } else {
      args.set(token.slice(2), true);
      index += 1;
    }
  }
  if (args.has('print-plan')) {
    const plan = await buildMacosRemoteDesktopBuildPlan({
      arch: args.get('arch'),
      teamId: args.get('team-id'),
      signingIdentity: args.get('signing-identity'),
      workerVersion: args.get('worker-version'),
    });
    process.stdout.write(`${JSON.stringify({
      ...plan,
      planSha256: macosRemoteDesktopBuildPlanSha256(plan),
    }, null, 2)}\n`);
    return;
  }
  throw new Error('usage: macos-remote-desktop-build.mjs --print-plan --arch <arm64|x64> --team-id <id> --signing-identity <sha1> --worker-version <version>');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export async function statSize(path) {
  const info = await stat(path);
  return info.size;
}
