#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS,
  promoteMacosRemoteDesktopArtifact,
  rollbackMacosRemoteDesktopArtifact,
  upgradeMacosRemoteDesktopArtifact,
  verifyMacosRemoteDesktopArtifact,
  type MacosRemoteDesktopArtifactDependencies,
  type MacosRemoteDesktopArtifactUpgradeLifecycle,
  type VerifiedMacosRemoteDesktopArtifact,
} from '../src/node/macos-remote-desktop-artifact.js';
import { PINNED_LIBWEBRTC_REVISION } from '../shared/remote-desktop-native-pins.js';
import {
  REMOTE_DESKTOP_MACOS_ARCHITECTURES,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  type RemoteDesktopMacosArchitecture,
  type RemoteDesktopMacosCodeIdentity,
} from '../shared/remote-desktop-worker.js';
import { validateMacosLibwebrtcNotices } from './libwebrtc-sdk-artifacts.mjs';
import { readMacosRemoteDesktopEntitlementsPlan } from './macos-remote-desktop-build.mjs';
import { verifyRemoteDesktopWorkerArtifactSet } from './remote-desktop-worker-artifacts.mjs';

export const MACOS_REMOTE_DESKTOP_RELEASE_PLAN_VERSION = 1 as const;
export const MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER = Object.freeze([
  'worker',
  'launchAgent',
  'disclosure',
  // Part of the ATOMIC set: a release that qualifies without it would ship a
  // component set that cannot provide display control at all.
  'virtualDisplayHelper',
] as const);
export const MACOS_REMOTE_DESKTOP_RELEASE_NOTICE_FILES = Object.freeze([
  'LICENSE',
  'THIRD_PARTY_NOTICES.webrtc.md',
] as const);
export const MACOS_REMOTE_DESKTOP_ATOMIC_PUBLICATION_STEPS = Object.freeze([
  'verify-source-component-sets',
  'create-same-filesystem-staging-directory',
  'copy-components-and-manifest-in-declared-order',
  'fsync-staged-files-and-directories',
  'verify-staged-component-sets',
  'rename-staging-directory-to-immutable-release',
  'fsync-release-parent-directory',
  'replace-current-selector-with-fsync-and-atomic-rename',
] as const);

const RELEASE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_LICENSE_BYTES = 1024 * 1024;
const MAX_NOTICES_BYTES = 16 * 1024 * 1024;
const ARCHITECTURES = [...REMOTE_DESKTOP_MACOS_ARCHITECTURES] as const;

export interface MacosRemoteDesktopReleaseCandidate {
  arch: RemoteDesktopMacosArchitecture;
  /** Root containing remote-desktop-worker/darwin-<arch>/. */
  releaseRoot: string;
}

export interface MacosRemoteDesktopReleaseGuardInput {
  workerVersion: string;
  candidates: readonly MacosRemoteDesktopReleaseCandidate[];
  repositoryLicensePath: string;
  libwebrtcNoticesPath: string;
  publicationRoot: string;
  expectedCodeIdentity: RemoteDesktopMacosCodeIdentity;
}

export interface MacosRemoteDesktopReleaseGuardDependencies {
  /** Test seam only. Production callers omit this and execute the real Apple tools. */
  artifact?: Omit<MacosRemoteDesktopArtifactDependencies, 'runtime'>;
  /** Test seam for isolated entitlement-byte counterexamples. */
  repositoryRoot?: string;
}

export interface MacosRemoteDesktopReleasePlan {
  planVersion: typeof MACOS_REMOTE_DESKTOP_RELEASE_PLAN_VERSION;
  workerVersion: string;
  libwebrtcRevision: typeof PINNED_LIBWEBRTC_REVISION;
  runtimeDownloadsAllowed: false;
  componentOrder: typeof MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER;
  entitlementsPlanSha256: string;
  notices: ReadonlyArray<{
    fileName: typeof MACOS_REMOTE_DESKTOP_RELEASE_NOTICE_FILES[number];
    size: number;
    sha256: string;
  }>;
  variants: ReadonlyArray<{
    arch: RemoteDesktopMacosArchitecture;
    sourceDirectory: string;
    manifestSha256: string;
    components: ReadonlyArray<{
      kind: typeof MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER[number];
      fileName: string;
      size: number;
      sha256: string;
      bundleIdentifier: string;
      designatedRequirement: string;
    }>;
  }>;
  releaseIdentitySha256: string;
  immutableReleaseName: string;
  publication: {
    root: string;
    selector: typeof MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current;
    atomic: true;
    verifyBeforePublication: true;
    verifyAfterStaging: true;
    steps: typeof MACOS_REMOTE_DESKTOP_ATOMIC_PUBLICATION_STEPS;
  };
}

interface MacosRemoteDesktopReleaseGuardCliConfig {
  workerVersion: string;
  candidates: readonly MacosRemoteDesktopReleaseCandidate[];
  repositoryLicensePath: string;
  libwebrtcNoticesPath: string;
  publicationRoot: string;
  expectedCodeIdentity: RemoteDesktopMacosCodeIdentity;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function boundedRegularFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const resolved = resolve(path);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`macos_remote_desktop_release_${label}_invalid`);
  }
  return readFile(resolved);
}

function sameCodeIdentity(
  actual: RemoteDesktopMacosCodeIdentity,
  expected: unknown,
): boolean {
  if (!record(expected)
    || actual.teamId !== expected.teamId
    || !record(expected.bundles)) return false;
  return MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER.every((kind) => {
    const actualBundle = actual.bundles[kind];
    const expectedBundle = expected.bundles[kind];
    if (!record(expectedBundle)) return false;
    return actualBundle.bundleIdentifier === expectedBundle.bundleIdentifier
      && actualBundle.designatedRequirement === expectedBundle.designatedRequirement
      && actualBundle.hardenedRuntime === true
      && expectedBundle.hardenedRuntime === true;
  });
}

function matchesStableBundleIdentity(
  expected: RemoteDesktopMacosCodeIdentity,
  stable: Awaited<ReturnType<typeof readMacosRemoteDesktopEntitlementsPlan>>['identity'],
): boolean {
  return stable.hardenedRuntime === true
    && MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER.every((kind) => (
      expected.bundles[kind].bundleIdentifier
        === stable.components[kind].bundleIdentifier
    ));
}

function validateCandidates(
  candidates: readonly MacosRemoteDesktopReleaseCandidate[],
): ReadonlyMap<RemoteDesktopMacosArchitecture, MacosRemoteDesktopReleaseCandidate> {
  if (candidates.length !== ARCHITECTURES.length) {
    throw new Error('macos_remote_desktop_release_architecture_set_invalid');
  }
  const byArchitecture = new Map<RemoteDesktopMacosArchitecture, MacosRemoteDesktopReleaseCandidate>();
  for (const candidate of candidates) {
    if (!ARCHITECTURES.includes(candidate.arch) || byArchitecture.has(candidate.arch)) {
      throw new Error('macos_remote_desktop_release_architecture_set_invalid');
    }
    byArchitecture.set(candidate.arch, candidate);
  }
  if (ARCHITECTURES.some((arch) => !byArchitecture.has(arch))) {
    throw new Error('macos_remote_desktop_release_architecture_set_invalid');
  }
  return byArchitecture;
}

async function verifyCandidate(
  candidate: MacosRemoteDesktopReleaseCandidate,
  workerVersion: string,
  expectedCodeIdentity: RemoteDesktopMacosCodeIdentity,
  minimumMacosVersion: string,
  dependencies: MacosRemoteDesktopReleaseGuardDependencies,
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  const releaseRoot = resolve(candidate.releaseRoot);
  const sourceDirectory = join(releaseRoot, 'remote-desktop-worker', `darwin-${candidate.arch}`);
  await verifyRemoteDesktopWorkerArtifactSet(
    releaseRoot,
    workerVersion,
    { os: 'darwin', arch: candidate.arch },
  );
  const verified = await verifyMacosRemoteDesktopArtifact({
    artifactDirectory: sourceDirectory,
    manifestPath: join(sourceDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME),
    expectedWorkerVersion: workerVersion,
  }, {
    ...dependencies.artifact,
    runtime: { platform: 'darwin', arch: candidate.arch },
  });
  if (verified.manifest.libwebrtcRevision !== PINNED_LIBWEBRTC_REVISION) {
    throw new Error('macos_remote_desktop_release_libwebrtc_revision_mismatch');
  }
  if (!sameCodeIdentity(verified.manifest.codeSignature, expectedCodeIdentity)) {
    throw new Error('macos_remote_desktop_release_stable_identity_mismatch');
  }
  if (verified.manifest.minimumOsVersion !== minimumMacosVersion) {
    throw new Error('macos_remote_desktop_release_minimum_os_mismatch');
  }
  return verified;
}

/**
 * Qualifies both native architectures and emits a content-addressed plan. It
 * deliberately performs no publication: a caller cannot publish a partial set
 * before every architecture, signature, notice and protocol guard succeeds.
 */
export async function buildMacosRemoteDesktopReleasePlan(
  input: MacosRemoteDesktopReleaseGuardInput,
  dependencies: MacosRemoteDesktopReleaseGuardDependencies = {},
): Promise<MacosRemoteDesktopReleasePlan> {
  if (!RELEASE_NAME_RE.test(input.workerVersion)) {
    throw new Error('macos_remote_desktop_release_worker_version_invalid');
  }
  const byArchitecture = validateCandidates(input.candidates);
  const [license, notices, entitlementsPlan] = await Promise.all([
    boundedRegularFile(input.repositoryLicensePath, MAX_LICENSE_BYTES, 'license'),
    boundedRegularFile(input.libwebrtcNoticesPath, MAX_NOTICES_BYTES, 'notices'),
    readMacosRemoteDesktopEntitlementsPlan(dependencies.repositoryRoot),
  ]);
  const stableIdentity = entitlementsPlan.identity;
  validateMacosLibwebrtcNotices(notices.toString('utf8'), PINNED_LIBWEBRTC_REVISION);
  if (!matchesStableBundleIdentity(input.expectedCodeIdentity, stableIdentity)) {
    throw new Error('macos_remote_desktop_release_stable_identity_mismatch');
  }

  const variants = [] as MacosRemoteDesktopReleasePlan['variants'][number][];
  let crossArchitectureContract: string | undefined;
  for (const arch of ARCHITECTURES) {
    const verified = await verifyCandidate(
      byArchitecture.get(arch)!,
      input.workerVersion,
      input.expectedCodeIdentity,
      stableIdentity.minimumMacosVersion,
      dependencies,
    );
    const contract = canonicalJson({
      workerVersion: verified.manifest.workerVersion,
      protocolVersion: verified.manifest.protocolVersion,
      ipcVersion: verified.manifest.ipcVersion,
      libwebrtcRevision: verified.manifest.libwebrtcRevision,
      minimumOsVersion: verified.manifest.minimumOsVersion,
      codeSignature: verified.manifest.codeSignature,
      toolchain: verified.manifest.toolchain,
    });
    if (crossArchitectureContract !== undefined && contract !== crossArchitectureContract) {
      throw new Error('macos_remote_desktop_release_mixed_component_sets');
    }
    crossArchitectureContract = contract;
    variants.push(Object.freeze({
      arch,
      sourceDirectory: verified.artifactDirectory,
      manifestSha256: verified.setSha256,
      components: Object.freeze(MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER.map((kind) => {
        const component = verified.components[kind];
        return Object.freeze({
          kind,
          fileName: component.fileName,
          size: component.size,
          sha256: component.sha256,
          bundleIdentifier: component.bundleIdentifier,
          designatedRequirement: component.designatedRequirement,
        });
      })),
    }));
  }

  const noticePlan = Object.freeze([
    Object.freeze({ fileName: MACOS_REMOTE_DESKTOP_RELEASE_NOTICE_FILES[0], size: license.length, sha256: sha256(license) }),
    Object.freeze({ fileName: MACOS_REMOTE_DESKTOP_RELEASE_NOTICE_FILES[1], size: notices.length, sha256: sha256(notices) }),
  ]);
  const releaseIdentityMaterial = {
    planVersion: MACOS_REMOTE_DESKTOP_RELEASE_PLAN_VERSION,
    workerVersion: input.workerVersion,
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    componentOrder: MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER,
    entitlementsPlanSha256: entitlementsPlan.entitlementsPlanSha256,
    notices: noticePlan,
    variants: variants.map(({ arch, manifestSha256, components }) => ({ arch, manifestSha256, components })),
    expectedCodeIdentity: input.expectedCodeIdentity,
  };
  const releaseIdentitySha256 = sha256(canonicalJson(releaseIdentityMaterial));
  return Object.freeze({
    planVersion: MACOS_REMOTE_DESKTOP_RELEASE_PLAN_VERSION,
    workerVersion: input.workerVersion,
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    runtimeDownloadsAllowed: false,
    componentOrder: MACOS_REMOTE_DESKTOP_RELEASE_COMPONENT_ORDER,
    entitlementsPlanSha256: entitlementsPlan.entitlementsPlanSha256,
    notices: noticePlan,
    variants: Object.freeze(variants),
    releaseIdentitySha256,
    immutableReleaseName: `sha256-${releaseIdentitySha256}`,
    publication: Object.freeze({
      root: resolve(input.publicationRoot),
      selector: MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current,
      atomic: true,
      verifyBeforePublication: true,
      verifyAfterStaging: true,
      steps: MACOS_REMOTE_DESKTOP_ATOMIC_PUBLICATION_STEPS,
    }),
  });
}

/**
 * Materialize both qualified thin variants into a controlled-node release
 * root. The staging root is on the destination filesystem and is completely
 * reverified before either darwin directory becomes observable. Existing
 * Windows/Linux siblings are never renamed, copied or removed.
 *
 * A workflow artifact is uploaded only after this function returns, so the
 * two final directory renames form one build publication gate even though the
 * filesystem has no multi-directory rename primitive.
 */
export async function packageQualifiedMacosRemoteDesktopRelease(
  input: MacosRemoteDesktopReleaseGuardInput,
  dependencies: MacosRemoteDesktopReleaseGuardDependencies = {},
): Promise<MacosRemoteDesktopReleasePlan> {
  const plan = await buildMacosRemoteDesktopReleasePlan(input, dependencies);
  const publicationRoot = resolve(input.publicationRoot);
  await mkdir(publicationRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(publicationRoot, '.macos-remote-desktop-staging-'));
  const stagedWorkerRoot = join(stagingRoot, 'remote-desktop-worker');
  const destinationWorkerRoot = join(publicationRoot, 'remote-desktop-worker');
  await mkdir(stagedWorkerRoot, { recursive: true });
  const backups = new Map<RemoteDesktopMacosArchitecture, string>();
  const published: RemoteDesktopMacosArchitecture[] = [];
  try {
    for (const variant of plan.variants) {
      const stagedDirectory = join(stagedWorkerRoot, `darwin-${variant.arch}`);
      await mkdir(stagedDirectory, { recursive: true });
      await Promise.all([
        copyFile(
          join(variant.sourceDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME),
          join(stagedDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME),
        ),
        ...variant.components.map((component) => copyFile(
          join(variant.sourceDirectory, component.fileName),
          join(stagedDirectory, component.fileName),
        )),
      ]);
      await verifyRemoteDesktopWorkerArtifactSet(
        stagingRoot,
        plan.workerVersion,
        { os: 'darwin', arch: variant.arch },
      );
      await verifyMacosRemoteDesktopArtifact({
        artifactDirectory: stagedDirectory,
        manifestPath: join(stagedDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME),
        expectedWorkerVersion: plan.workerVersion,
      }, {
        ...dependencies.artifact,
        runtime: { platform: 'darwin', arch: variant.arch },
      });
    }

    await mkdir(destinationWorkerRoot, { recursive: true });
    for (const arch of ARCHITECTURES) {
      const destination = join(destinationWorkerRoot, `darwin-${arch}`);
      const backup = join(stagingRoot, `previous-darwin-${arch}`);
      try {
        await lstat(destination);
        await rename(destination, backup);
        backups.set(arch, backup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await rename(join(stagedWorkerRoot, `darwin-${arch}`), destination);
        published.push(arch);
      } catch (error) {
        const previous = backups.get(arch);
        if (previous !== undefined) {
          await rename(previous, destination);
          backups.delete(arch);
        }
        throw error;
      }
    }
    await Promise.all([...backups.values()].map((path) => rm(path, { recursive: true, force: true })));
    return plan;
  } catch (error) {
    for (const arch of [...published].reverse()) {
      const destination = join(destinationWorkerRoot, `darwin-${arch}`);
      await rm(destination, { recursive: true, force: true });
      const backup = backups.get(arch);
      if (backup !== undefined) await rename(backup, destination);
    }
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Optional per-architecture installer seam for release automation. The guard
 * must have qualified the complete two-architecture plan first; promotion then
 * re-verifies the selected source and delegates atomic staging, selector swap
 * and last-known-good rollback retention to the existing artifact installer.
 */
export async function installQualifiedMacosRemoteDesktopVariant(
  input: MacosRemoteDesktopReleaseGuardInput,
  arch: RemoteDesktopMacosArchitecture,
  storeRoot: string,
  dependencies: MacosRemoteDesktopReleaseGuardDependencies = {},
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  const plan = await buildMacosRemoteDesktopReleasePlan(input, dependencies);
  const variant = plan.variants.find((entry) => entry.arch === arch);
  if (variant === undefined) {
    throw new Error('macos_remote_desktop_release_architecture_set_invalid');
  }
  return promoteMacosRemoteDesktopArtifact({
    artifactDirectory: variant.sourceDirectory,
    manifestPath: join(variant.sourceDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME),
    expectedWorkerVersion: plan.workerVersion,
    storeRoot,
  }, {
    ...dependencies.artifact,
    runtime: { platform: 'darwin', arch },
  });
}

/**
 * Qualify the complete arm64+x64 release before stopping the active user's
 * LaunchAgent, then accept the selected variant only after authenticated
 * readiness. The artifact-store transaction restores the exact selector
 * snapshot and restarts the previous verified variant on failure.
 */
export async function upgradeQualifiedMacosRemoteDesktopVariant(
  input: MacosRemoteDesktopReleaseGuardInput,
  arch: RemoteDesktopMacosArchitecture,
  storeRoot: string,
  lifecycle: MacosRemoteDesktopArtifactUpgradeLifecycle,
  dependencies: MacosRemoteDesktopReleaseGuardDependencies = {},
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  const plan = await buildMacosRemoteDesktopReleasePlan(input, dependencies);
  const variant = plan.variants.find((entry) => entry.arch === arch);
  if (variant === undefined) {
    throw new Error('macos_remote_desktop_release_architecture_set_invalid');
  }
  return upgradeMacosRemoteDesktopArtifact({
    artifactDirectory: variant.sourceDirectory,
    manifestPath: join(variant.sourceDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME),
    expectedWorkerVersion: plan.workerVersion,
    storeRoot,
    lifecycle,
  }, {
    ...dependencies.artifact,
    runtime: { platform: 'darwin', arch },
  });
}

/**
 * Roll back only to the artifact store's previously verified complete set.
 * LaunchAgent stop/start remains the caller's lifecycle boundary; this helper
 * deliberately does not report a successful service transition merely because
 * the atomic selector swap succeeded.
 */
export async function rollbackQualifiedMacosRemoteDesktopVariant(
  arch: RemoteDesktopMacosArchitecture,
  storeRoot: string,
  dependencies: MacosRemoteDesktopReleaseGuardDependencies = {},
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  return rollbackMacosRemoteDesktopArtifact({ storeRoot }, {
    ...dependencies.artifact,
    runtime: { platform: 'darwin', arch },
  });
}

function validateCliConfig(value: unknown): MacosRemoteDesktopReleaseGuardCliConfig {
  if (!record(value) || !exactKeys(value, [
    'workerVersion', 'candidates', 'repositoryLicensePath', 'libwebrtcNoticesPath',
    'publicationRoot', 'expectedCodeIdentity',
  ])
    || typeof value.workerVersion !== 'string'
    || !Array.isArray(value.candidates)
    || value.candidates.some((candidate) => !record(candidate)
      || !exactKeys(candidate, ['arch', 'releaseRoot'])
      || !ARCHITECTURES.includes(candidate.arch as RemoteDesktopMacosArchitecture)
      || typeof candidate.releaseRoot !== 'string')
    || typeof value.repositoryLicensePath !== 'string'
    || typeof value.libwebrtcNoticesPath !== 'string'
    || typeof value.publicationRoot !== 'string'
    || !record(value.expectedCodeIdentity)) {
    throw new Error('macos_remote_desktop_release_config_invalid');
  }
  return value as unknown as MacosRemoteDesktopReleaseGuardCliConfig;
}

async function main(): Promise<void> {
  const [, , command, configPath] = process.argv;
  if ((command !== 'plan' && command !== 'package') || configPath === undefined) {
    throw new Error('usage: node --import tsx scripts/macos-remote-desktop-release-guard.ts <plan|package> <config.json>');
  }
  const resolvedConfigPath = resolve(configPath);
  const config = validateCliConfig(JSON.parse(await readFile(resolvedConfigPath, 'utf8')));
  const input = {
    ...config,
    candidates: config.candidates.map((candidate) => ({
      ...candidate,
      releaseRoot: resolve(dirname(resolvedConfigPath), candidate.releaseRoot),
    })),
    repositoryLicensePath: resolve(dirname(resolvedConfigPath), config.repositoryLicensePath),
    libwebrtcNoticesPath: resolve(dirname(resolvedConfigPath), config.libwebrtcNoticesPath),
    publicationRoot: resolve(dirname(resolvedConfigPath), config.publicationRoot),
  };
  const plan = command === 'package'
    ? await packageQualifiedMacosRemoteDesktopRelease(input)
    : await buildMacosRemoteDesktopReleasePlan(input);
  process.stdout.write(`${canonicalJson(plan)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
