import {
  normalizeControlledNodeAbiProfile,
  type ControlledNodeAbiProfile,
} from './controlled-node-abi.js';
import { compareImcodesVersions } from './imcodes-version.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from './remote-desktop.js';

export const DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const DESKTOP_RELEASE_MANIFEST_FILENAME = 'desktop-release.manifest.json' as const;

export const DESKTOP_RELEASE_TARGETS = [
  'win32-x64',
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
] as const;

export type DesktopReleaseTarget = (typeof DESKTOP_RELEASE_TARGETS)[number];
export type DesktopReleaseOs = 'win32' | 'darwin' | 'linux';
export type DesktopReleaseArch = 'x64' | 'arm64';
export type DesktopReleaseComponentArch = DesktopReleaseArch | 'universal';

export const DESKTOP_RELEASE_COMPONENTS = [
  'imcodes-node',
  'remote-desktop',
  'open-computer-use',
  'daemon-runtime',
] as const;

export type DesktopReleaseComponentName = (typeof DESKTOP_RELEASE_COMPONENTS)[number];

export type DesktopReleaseInstallerKind = 'deb' | 'sh' | 'pkg' | 'exe' | 'dmg' | 'msi';

const DESKTOP_RELEASE_INSTALLER_KINDS = new Set<string>([
  'deb',
  'sh',
  'pkg',
  'exe',
  'dmg',
  'msi',
]);

export const DESKTOP_RELEASE_BUILD_VERSION_RE =
  /^[0-9]+(?:\.[0-9]+){1,3}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
export const DESKTOP_RELEASE_SHA256_RE = /^[0-9a-f]{64}$/;
export const DESKTOP_RELEASE_GIT_SHA_RE = /^[0-9a-f]{7,64}$/;
const NODE_VERSION_RE = /^v\d+\.\d+\.\d+$/;

export interface DesktopReleaseComponentCompat {
  os: DesktopReleaseOs;
  arch: DesktopReleaseComponentArch;
  abiProfile?: ControlledNodeAbiProfile;
  protocolVersion?: number;
  nodeVersion?: string;
  authenticodeSignerSha256?: string;
  macosSigningIdentitySha1?: string;
}

export interface DesktopReleaseComponentEntry {
  component: DesktopReleaseComponentName;
  version: string;
  fileName: string;
  relativePath?: string;
  sha256: string;
  sizeBytes: number;
  manifestFileName?: string;
  manifestSha256?: string;
  compat: DesktopReleaseComponentCompat;
}

export interface DesktopReleaseInstallerEntry {
  kind: DesktopReleaseInstallerKind;
  fileName: string;
  relativePath?: string;
  sha256: string;
  sizeBytes: number;
  version: string;
  manifestFileName?: string;
}

export interface DesktopReleaseTargetBundle {
  target: DesktopReleaseTarget;
  os: DesktopReleaseOs;
  arch: DesktopReleaseArch;
  components: Record<DesktopReleaseComponentName, DesktopReleaseComponentEntry>;
  installers?: DesktopReleaseInstallerEntry[];
}

export interface DesktopReleaseVersionCompatRule {
  component: DesktopReleaseComponentName;
  target?: DesktopReleaseTarget;
  allowedVersion: string;
  reason: string;
}

export interface DesktopReleaseManifest {
  schemaVersion: typeof DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION;
  releaseVersion: string;
  gitSha: string;
  generatedAt: string;
  compatRules?: DesktopReleaseVersionCompatRule[];
  targets: Partial<Record<DesktopReleaseTarget, DesktopReleaseTargetBundle>>;
}

export function desktopReleaseTargetManifestFilename(target: DesktopReleaseTarget): string {
  return `desktop-release-${target}.manifest.json`;
}

export function isDesktopReleaseTarget(value: unknown): value is DesktopReleaseTarget {
  return typeof value === 'string' && (DESKTOP_RELEASE_TARGETS as readonly string[]).includes(value);
}

export function parseDesktopReleaseTarget(target: string): {
  target: DesktopReleaseTarget;
  os: DesktopReleaseOs;
  arch: DesktopReleaseArch;
} {
  if (!isDesktopReleaseTarget(target)) {
    throw new Error(`unsupported desktop release target: ${target}`);
  }
  const [os, arch] = target.split('-') as [DesktopReleaseOs, DesktopReleaseArch];
  return { target, os, arch };
}

export function controlledNodePairForReleaseTarget(target: DesktopReleaseTarget): {
  os: 'win' | 'mac' | 'linux';
  arch: 'x64' | 'universal';
} | null {
  switch (target) {
    case 'win32-x64':
      return { os: 'win', arch: 'x64' };
    case 'darwin-arm64':
    case 'darwin-x64':
      return { os: 'mac', arch: 'universal' };
    case 'linux-x64':
      return { os: 'linux', arch: 'x64' };
    case 'linux-arm64':
      return null;
  }
}

export function releaseTargetFromRuntime(
  platform: NodeJS.Platform,
  arch: string,
): DesktopReleaseTarget | null {
  const candidate = `${platform}-${arch}`;
  return isDesktopReleaseTarget(candidate) ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSafeManifestFileName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value || value === '.' || value === '..') return false;
  return !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

export function isSafeManifestRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function assertValidBuildVersion(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} must be a string`);
  }
  const trimmed = value.trim();
  if (!DESKTOP_RELEASE_BUILD_VERSION_RE.test(trimmed)) {
    throw new Error(`${context} is not a valid build version: ${value}`);
  }
  return trimmed;
}

export function isDesktopReleaseComponentAligned(
  component: DesktopReleaseComponentName,
  componentVersion: string,
  releaseVersion: string,
  compatRules?: readonly DesktopReleaseVersionCompatRule[],
  target?: DesktopReleaseTarget,
): { aligned: true; viaCompatRule: boolean; rule?: DesktopReleaseVersionCompatRule } | { aligned: false; reason: string } {
  if (!DESKTOP_RELEASE_BUILD_VERSION_RE.test(componentVersion)) {
    return { aligned: false, reason: `invalid version ${componentVersion} for ${component}` };
  }
  if (componentVersion === releaseVersion) {
    return { aligned: true, viaCompatRule: false };
  }
  const matched = compatRules?.find(
    (rule) =>
      rule.component === component
      && (rule.target === undefined || rule.target === target)
      && rule.allowedVersion === componentVersion
      && rule.reason.trim().length > 0,
  );
  if (matched) {
    return { aligned: true, viaCompatRule: true, rule: matched };
  }
  return {
    aligned: false,
    reason: `${component} version ${componentVersion} is not aligned with releaseVersion ${releaseVersion}`,
  };
}

function validateCompatRules(raw: unknown): DesktopReleaseVersionCompatRule[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('compatRules must be an array');
  }
  return raw.map((item, idx) => {
    if (!isRecord(item)) {
      throw new Error(`compatRules[${idx}] must be an object`);
    }
    if (
      typeof item.component !== 'string'
      || !(DESKTOP_RELEASE_COMPONENTS as readonly string[]).includes(item.component)
    ) {
      throw new Error(`compatRules[${idx}].component is invalid`);
    }
    let target: DesktopReleaseTarget | undefined;
    if (item.target !== undefined) {
      if (!isDesktopReleaseTarget(item.target)) {
        throw new Error(`compatRules[${idx}].target is invalid`);
      }
      target = item.target;
    }
    const allowedVersion = assertValidBuildVersion(item.allowedVersion, `compatRules[${idx}].allowedVersion`);
    if (typeof item.reason !== 'string' || !item.reason.trim()) {
      throw new Error(`compatRules[${idx}].reason must be a non-empty string`);
    }
    return {
      component: item.component as DesktopReleaseComponentName,
      ...(target ? { target } : {}),
      allowedVersion,
      reason: item.reason.trim(),
    };
  });
}

function validateComponentEntry(
  raw: unknown,
  expectedComponent: DesktopReleaseComponentName,
  targetInfo: { target: DesktopReleaseTarget; os: DesktopReleaseOs; arch: DesktopReleaseArch },
  releaseVersion: string,
  compatRules: readonly DesktopReleaseVersionCompatRule[] | undefined,
): DesktopReleaseComponentEntry {
  const ctx = `targets.${targetInfo.target}.components.${expectedComponent}`;
  if (!isRecord(raw)) {
    throw new Error(`${ctx} must be an object`);
  }
  if (raw.component !== expectedComponent) {
    throw new Error(`${ctx}.component must equal ${expectedComponent}`);
  }
  const version = assertValidBuildVersion(raw.version, `${ctx}.version`);
  const alignment = isDesktopReleaseComponentAligned(
    expectedComponent,
    version,
    releaseVersion,
    compatRules,
    targetInfo.target,
  );
  if (!alignment.aligned) {
    throw new Error(`${ctx}: ${alignment.reason}`);
  }
  if (!isSafeManifestFileName(raw.fileName)) {
    throw new Error(`${ctx}.fileName must be a safe basename`);
  }
  if (raw.relativePath !== undefined && !isSafeManifestRelativePath(raw.relativePath)) {
    throw new Error(`${ctx}.relativePath must be a clean relative path`);
  }
  if (typeof raw.sha256 !== 'string' || !DESKTOP_RELEASE_SHA256_RE.test(raw.sha256)) {
    throw new Error(`${ctx}.sha256 must be a lowercase 64-char hex digest`);
  }
  if (typeof raw.sizeBytes !== 'number' || !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes <= 0) {
    throw new Error(`${ctx}.sizeBytes must be a positive safe integer`);
  }
  if (raw.manifestFileName !== undefined && !isSafeManifestFileName(raw.manifestFileName)) {
    throw new Error(`${ctx}.manifestFileName must be a safe basename`);
  }
  if (
    raw.manifestSha256 !== undefined
    && (typeof raw.manifestSha256 !== 'string' || !DESKTOP_RELEASE_SHA256_RE.test(raw.manifestSha256))
  ) {
    throw new Error(`${ctx}.manifestSha256 must be a lowercase 64-char hex digest`);
  }

  if (!isRecord(raw.compat)) {
    throw new Error(`${ctx}.compat must be an object`);
  }
  const compat = raw.compat;
  if (compat.os !== targetInfo.os) {
    throw new Error(`${ctx}.compat.os must equal ${targetInfo.os}`);
  }
  const validUniversal =
    targetInfo.os === 'darwin'
    && (expectedComponent === 'imcodes-node' || expectedComponent === 'open-computer-use');
  if (compat.arch !== targetInfo.arch && !(validUniversal && compat.arch === 'universal')) {
    throw new Error(`${ctx}.compat.arch is incompatible with ${targetInfo.target}`);
  }
  if (compat.abiProfile !== undefined) {
    if (typeof compat.abiProfile !== 'string' || normalizeControlledNodeAbiProfile(compat.abiProfile) === null) {
      throw new Error(`${ctx}.compat.abiProfile is invalid`);
    }
  }
  if (compat.protocolVersion !== undefined) {
    if (
      typeof compat.protocolVersion !== 'number'
      || !Number.isSafeInteger(compat.protocolVersion)
      || compat.protocolVersion <= 0
    ) {
      throw new Error(`${ctx}.compat.protocolVersion must be a positive integer`);
    }
    if (expectedComponent === 'remote-desktop' && compat.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION) {
      throw new Error(
        `${ctx}.compat.protocolVersion (${compat.protocolVersion}) mismatches expected ${REMOTE_DESKTOP_PROTOCOL_VERSION}`,
      );
    }
  }
  if (expectedComponent === 'daemon-runtime') {
    if (typeof compat.nodeVersion !== 'string' || !NODE_VERSION_RE.test(compat.nodeVersion)) {
      throw new Error(`${ctx}.compat.nodeVersion must match vMAJOR.MINOR.PATCH`);
    }
  } else if (compat.nodeVersion !== undefined && (typeof compat.nodeVersion !== 'string' || !NODE_VERSION_RE.test(compat.nodeVersion))) {
    throw new Error(`${ctx}.compat.nodeVersion is invalid`);
  }
  if (
    compat.authenticodeSignerSha256 !== undefined
    && (typeof compat.authenticodeSignerSha256 !== 'string' || !DESKTOP_RELEASE_SHA256_RE.test(compat.authenticodeSignerSha256))
  ) {
    throw new Error(`${ctx}.compat.authenticodeSignerSha256 is invalid`);
  }
  if (
    compat.macosSigningIdentitySha1 !== undefined
    && (typeof compat.macosSigningIdentitySha1 !== 'string' || !/^[0-9a-f]{40}$/.test(compat.macosSigningIdentitySha1))
  ) {
    throw new Error(`${ctx}.compat.macosSigningIdentitySha1 is invalid`);
  }

  return {
    component: expectedComponent,
    version,
    fileName: raw.fileName,
    ...(raw.relativePath !== undefined ? { relativePath: raw.relativePath } : {}),
    sha256: raw.sha256,
    sizeBytes: raw.sizeBytes,
    ...(raw.manifestFileName !== undefined ? { manifestFileName: raw.manifestFileName } : {}),
    ...(raw.manifestSha256 !== undefined ? { manifestSha256: raw.manifestSha256 } : {}),
    compat: {
      os: compat.os as DesktopReleaseOs,
      arch: compat.arch as DesktopReleaseComponentArch,
      ...(compat.abiProfile !== undefined ? { abiProfile: compat.abiProfile as ControlledNodeAbiProfile } : {}),
      ...(compat.protocolVersion !== undefined ? { protocolVersion: compat.protocolVersion } : {}),
      ...(compat.nodeVersion !== undefined ? { nodeVersion: compat.nodeVersion } : {}),
      ...(compat.authenticodeSignerSha256 !== undefined
        ? { authenticodeSignerSha256: compat.authenticodeSignerSha256 }
        : {}),
      ...(compat.macosSigningIdentitySha1 !== undefined
        ? { macosSigningIdentitySha1: compat.macosSigningIdentitySha1 }
        : {}),
    },
  };
}

function validateInstallers(
  raw: unknown,
  target: DesktopReleaseTarget,
  releaseVersion: string,
): DesktopReleaseInstallerEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`targets.${target}.installers must be an array`);
  }
  return raw.map((entry, idx) => {
    const ctx = `targets.${target}.installers[${idx}]`;
    if (!isRecord(entry)) throw new Error(`${ctx} must be an object`);
    if (typeof entry.kind !== 'string' || !DESKTOP_RELEASE_INSTALLER_KINDS.has(entry.kind)) {
      throw new Error(`${ctx}.kind is invalid`);
    }
    if (!isSafeManifestFileName(entry.fileName)) {
      throw new Error(`${ctx}.fileName must be a safe basename`);
    }
    if (entry.relativePath !== undefined && !isSafeManifestRelativePath(entry.relativePath)) {
      throw new Error(`${ctx}.relativePath must be a clean relative path`);
    }
    if (typeof entry.sha256 !== 'string' || !DESKTOP_RELEASE_SHA256_RE.test(entry.sha256)) {
      throw new Error(`${ctx}.sha256 must be a lowercase 64-char hex digest`);
    }
    if (typeof entry.sizeBytes !== 'number' || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
      throw new Error(`${ctx}.sizeBytes must be a positive safe integer`);
    }
    const version = assertValidBuildVersion(entry.version, `${ctx}.version`);
    if (version !== releaseVersion) {
      throw new Error(`${ctx}.version (${version}) must match releaseVersion (${releaseVersion})`);
    }
    if (entry.manifestFileName !== undefined && !isSafeManifestFileName(entry.manifestFileName)) {
      throw new Error(`${ctx}.manifestFileName must be a safe basename`);
    }
    return {
      kind: entry.kind as DesktopReleaseInstallerKind,
      fileName: entry.fileName,
      ...(entry.relativePath !== undefined ? { relativePath: entry.relativePath } : {}),
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      version,
      ...(entry.manifestFileName !== undefined ? { manifestFileName: entry.manifestFileName } : {}),
    };
  });
}

export function validateDesktopReleaseManifest(raw: unknown): DesktopReleaseManifest {
  if (!isRecord(raw)) {
    throw new Error('desktop release manifest root must be an object');
  }
  if (raw.schemaVersion !== DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported desktop release manifest schemaVersion: ${String(raw.schemaVersion)}`);
  }
  const releaseVersion = assertValidBuildVersion(raw.releaseVersion, 'releaseVersion');
  if (typeof raw.gitSha !== 'string' || !DESKTOP_RELEASE_GIT_SHA_RE.test(raw.gitSha.trim())) {
    throw new Error('gitSha must be a 7-64 char hex commit SHA');
  }
  const gitSha = raw.gitSha.trim().toLowerCase();
  if (typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt))) {
    throw new Error('generatedAt must be a valid ISO timestamp');
  }
  const compatRules = validateCompatRules(raw.compatRules);

  if (!isRecord(raw.targets)) {
    throw new Error('targets must be a non-empty object');
  }
  const targetKeys = Object.keys(raw.targets);
  if (targetKeys.length === 0) {
    throw new Error('targets must contain at least one release target');
  }

  const targets: Partial<Record<DesktopReleaseTarget, DesktopReleaseTargetBundle>> = {};
  for (const key of targetKeys) {
    const targetInfo = parseDesktopReleaseTarget(key);
    const bundleRaw = raw.targets[key];
    if (!isRecord(bundleRaw)) {
      throw new Error(`targets.${key} must be an object`);
    }
    if (bundleRaw.target !== targetInfo.target || bundleRaw.os !== targetInfo.os || bundleRaw.arch !== targetInfo.arch) {
      throw new Error(`targets.${key} identity fields do not match ${targetInfo.target}`);
    }
    if (!isRecord(bundleRaw.components)) {
      throw new Error(`targets.${key}.components must be an object`);
    }

    const components = {} as Record<DesktopReleaseComponentName, DesktopReleaseComponentEntry>;
    for (const componentName of DESKTOP_RELEASE_COMPONENTS) {
      components[componentName] = validateComponentEntry(
        bundleRaw.components[componentName],
        componentName,
        targetInfo,
        releaseVersion,
        compatRules,
      );
    }

    // Cross-component publisher consistency on Windows: every signed Windows binary present must share one signer.
    if (targetInfo.os === 'win32') {
      const signers = DESKTOP_RELEASE_COMPONENTS
        .map((c) => components[c].compat.authenticodeSignerSha256)
        .filter((s): s is string => typeof s === 'string');
      if (signers.length > 0 && new Set(signers).size > 1) {
        throw new Error(`targets.${key} components have inconsistent Authenticode signers`);
      }
    }

    const installers = validateInstallers(bundleRaw.installers, targetInfo.target, releaseVersion);
    targets[targetInfo.target] = {
      target: targetInfo.target,
      os: targetInfo.os,
      arch: targetInfo.arch,
      components,
      ...(installers && installers.length > 0 ? { installers } : {}),
    };
  }

  return {
    schemaVersion: DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseVersion,
    gitSha,
    generatedAt: raw.generatedAt,
    ...(compatRules && compatRules.length > 0 ? { compatRules } : {}),
    targets,
  };
}

export function safeValidateDesktopReleaseManifest(
  raw: unknown,
): { ok: true; manifest: DesktopReleaseManifest } | { ok: false; error: string } {
  try {
    return { ok: true, manifest: validateDesktopReleaseManifest(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function verifyDesktopReleaseComponentIdentity(
  manifest: DesktopReleaseManifest,
  target: DesktopReleaseTarget,
  component: DesktopReleaseComponentName,
  actual: {
    version?: string;
    sha256?: string;
    sizeBytes?: number;
    fileName?: string;
    authenticodeSignerSha256?: string;
    protocolVersion?: number;
  },
): { ok: true; entry: DesktopReleaseComponentEntry } | { ok: false; reason: string } {
  const bundle = manifest.targets[target];
  if (!bundle) {
    return { ok: false, reason: `missing_target_${target}` };
  }
  const entry = bundle.components[component];
  if (!entry) {
    return { ok: false, reason: `missing_component_${component}` };
  }
  const aligned = isDesktopReleaseComponentAligned(
    component,
    entry.version,
    manifest.releaseVersion,
    manifest.compatRules,
    target,
  );
  if (!aligned.aligned) {
    return { ok: false, reason: aligned.reason };
  }
  if (actual.version !== undefined) {
    const cmp = compareImcodesVersions(actual.version, entry.version);
    if (actual.version !== entry.version && cmp !== 0) {
      return { ok: false, reason: `${component}_version_mismatch:expected_${entry.version}_got_${actual.version}` };
    }
  }
  if (actual.fileName !== undefined && actual.fileName !== entry.fileName) {
    return { ok: false, reason: `${component}_filename_mismatch` };
  }
  if (actual.sha256 !== undefined && actual.sha256.toLowerCase() !== entry.sha256) {
    return { ok: false, reason: `${component}_sha256_mismatch` };
  }
  if (actual.sizeBytes !== undefined && actual.sizeBytes !== entry.sizeBytes) {
    return { ok: false, reason: `${component}_size_mismatch` };
  }
  if (
    actual.authenticodeSignerSha256 !== undefined
    && entry.compat.authenticodeSignerSha256 !== undefined
    && actual.authenticodeSignerSha256.toLowerCase() !== entry.compat.authenticodeSignerSha256
  ) {
    return { ok: false, reason: `${component}_signer_mismatch` };
  }
  if (
    actual.protocolVersion !== undefined
    && entry.compat.protocolVersion !== undefined
    && actual.protocolVersion !== entry.compat.protocolVersion
  ) {
    return { ok: false, reason: `${component}_protocol_version_mismatch` };
  }
  return { ok: true, entry };
}

export function mergeDesktopReleaseManifests(
  manifests: readonly DesktopReleaseManifest[],
  generatedAt = new Date().toISOString(),
): DesktopReleaseManifest {
  if (manifests.length === 0) {
    throw new Error('cannot merge zero desktop release manifests');
  }
  const validated = manifests.map((m) => validateDesktopReleaseManifest(m));
  const releaseVersion = validated[0].releaseVersion;
  const gitSha = validated[0].gitSha;
  const targets: Partial<Record<DesktopReleaseTarget, DesktopReleaseTargetBundle>> = {};
  const compatRules: DesktopReleaseVersionCompatRule[] = [];
  const seenRuleKeys = new Set<string>();

  for (const manifest of validated) {
    if (manifest.releaseVersion !== releaseVersion) {
      throw new Error(`releaseVersion mismatch when merging manifests: ${manifest.releaseVersion} !== ${releaseVersion}`);
    }
    if (manifest.gitSha !== gitSha) {
      throw new Error(`gitSha mismatch when merging manifests: ${manifest.gitSha} !== ${gitSha}`);
    }
    for (const rule of manifest.compatRules ?? []) {
      const ruleKey = `${rule.component}:${rule.target ?? '*'}:${rule.allowedVersion}`;
      if (!seenRuleKeys.has(ruleKey)) {
        seenRuleKeys.add(ruleKey);
        compatRules.push(rule);
      }
    }
    for (const [targetKey, bundle] of Object.entries(manifest.targets)) {
      const target = targetKey as DesktopReleaseTarget;
      if (targets[target]) {
        throw new Error(`duplicate target ${target} when merging desktop release manifests`);
      }
      targets[target] = bundle;
    }
  }

  return validateDesktopReleaseManifest({
    schemaVersion: DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseVersion,
    gitSha,
    generatedAt,
    ...(compatRules.length > 0 ? { compatRules } : {}),
    targets,
  });
}

export const DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION = 1 as const;

export const DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS = [
  'package/package.json',
  'package/config/default.yaml',
  'package/dist/src/index.js',
  'package/dist/src/cli.js',
] as const;

export interface DaemonRuntimeManifestFileEntry {
  path: string;
  size: number;
  sha256: string;
  executable?: boolean;
}

export interface DaemonRuntimeManifest {
  schemaVersion: typeof DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION;
  artifact: {
    fileName: string;
    format: 'tar.gz' | 'zip';
    os: DesktopReleaseOs;
    arch: DesktopReleaseArch;
    size: number;
    sha256: string;
    authenticodeSignerSha256?: string;
    macosSigningIdentitySha1?: string;
  };
  entrypoint: {
    node: 'bin/node' | 'node.exe';
    script: 'package/dist/src/index.js';
  };
  toolchain: {
    nodeProvider: string;
    nodeVersion: string;
    nodeArchive?: string;
    nodeArchiveSha256?: string;
    nodeBinarySha256?: string;
  };
  build: {
    commit: string;
    version: string;
  };
  totalUncompressedBytes: number;
  fileCount: number;
  files: DaemonRuntimeManifestFileEntry[];
}

export function daemonRuntimeManifestFilename(target: DesktopReleaseTarget): string {
  return `daemon-runtime-${target}.manifest.json`;
}

const MACOS_SIGNING_SHA1_RE = /^[a-f0-9]{40}$/u;

/**
 * Authoritative validator for `daemon-runtime-<target>.manifest.json` produced by
 * `scripts/daemon-runtime-artifacts.mjs` (`createDaemonRuntimeManifest`) and served
 * by `server/src/services/controlled-node-artifact-catalog.ts`.
 */
export function validateDaemonRuntimeManifest(
  value: unknown,
  expectedTarget: DesktopReleaseTarget,
): DaemonRuntimeManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('daemon_runtime_manifest_invalid:not_object');
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION) {
    throw new Error('daemon_runtime_manifest_invalid:schemaVersion');
  }
  const { os: expectedOs, arch: expectedArch } = parseDesktopReleaseTarget(expectedTarget);
  const expectedFormat = expectedOs === 'win32' ? 'zip' : 'tar.gz';
  const expectedFileName = `daemon-runtime-${expectedTarget}.${expectedFormat}`;
  const expectedNode = expectedOs === 'win32' ? 'node.exe' : 'bin/node';

  const artifact = obj.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('daemon_runtime_manifest_invalid:missing_artifact');
  }
  const a = artifact as Record<string, unknown>;
  const actualOs = typeof a.os === 'string' ? a.os : '';
  const actualArch = typeof a.arch === 'string' ? a.arch : '';
  if (actualOs !== expectedOs || actualArch !== expectedArch) {
    throw new Error(`daemon_runtime_manifest_target_mismatch:${actualOs}-${actualArch}_vs_${expectedTarget}`);
  }
  if (a.format !== expectedFormat) {
    throw new Error('daemon_runtime_manifest_invalid:archive_format');
  }
  if (
    typeof a.fileName !== 'string'
    || a.fileName !== expectedFileName
    || a.fileName.includes('/')
    || a.fileName.includes('\\')
  ) {
    throw new Error('daemon_runtime_manifest_invalid:archive_fileName');
  }
  if (typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size <= 0) {
    throw new Error('daemon_runtime_manifest_invalid:archive_size');
  }
  if (typeof a.sha256 !== 'string' || !DESKTOP_RELEASE_SHA256_RE.test(a.sha256)) {
    throw new Error('daemon_runtime_manifest_invalid:archive_sha256');
  }
  let authenticodeSignerSha256: string | undefined;
  if (a.authenticodeSignerSha256 !== undefined) {
    if (typeof a.authenticodeSignerSha256 !== 'string' || !DESKTOP_RELEASE_SHA256_RE.test(a.authenticodeSignerSha256)) {
      throw new Error('daemon_runtime_manifest_invalid:authenticodeSignerSha256');
    }
    authenticodeSignerSha256 = a.authenticodeSignerSha256;
  }
  let macosSigningIdentitySha1: string | undefined;
  if (a.macosSigningIdentitySha1 !== undefined) {
    if (typeof a.macosSigningIdentitySha1 !== 'string' || !MACOS_SIGNING_SHA1_RE.test(a.macosSigningIdentitySha1)) {
      throw new Error('daemon_runtime_manifest_invalid:macosSigningIdentitySha1');
    }
    macosSigningIdentitySha1 = a.macosSigningIdentitySha1;
  }

  const entrypoint = obj.entrypoint;
  if (!entrypoint || typeof entrypoint !== 'object' || Array.isArray(entrypoint)) {
    throw new Error('daemon_runtime_manifest_invalid:missing_entrypoint');
  }
  const ep = entrypoint as Record<string, unknown>;
  if (ep.node !== expectedNode || ep.script !== 'package/dist/src/index.js') {
    throw new Error('daemon_runtime_manifest_invalid:entrypoint');
  }

  const toolchain = obj.toolchain;
  if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)) {
    throw new Error('daemon_runtime_manifest_invalid:missing_toolchain');
  }
  const tc = toolchain as Record<string, unknown>;
  if (typeof tc.nodeProvider !== 'string' || !tc.nodeProvider.trim() || typeof tc.nodeVersion !== 'string' || !NODE_VERSION_RE.test(tc.nodeVersion)) {
    throw new Error('daemon_runtime_manifest_invalid:toolchain');
  }

  const build = obj.build;
  if (!build || typeof build !== 'object' || Array.isArray(build)) {
    throw new Error('daemon_runtime_manifest_invalid:missing_build');
  }
  const b = build as Record<string, unknown>;
  if (typeof b.version !== 'string' || !DESKTOP_RELEASE_BUILD_VERSION_RE.test(b.version.trim())) {
    throw new Error('daemon_runtime_manifest_invalid:build_version');
  }
  if (typeof b.commit !== 'string' || !DESKTOP_RELEASE_GIT_SHA_RE.test(b.commit)) {
    throw new Error('daemon_runtime_manifest_invalid:build_commit');
  }

  if (!Array.isArray(obj.files) || obj.files.length === 0) {
    throw new Error('daemon_runtime_manifest_invalid:files');
  }
  if (typeof obj.fileCount === 'number' && obj.fileCount !== obj.files.length) {
    throw new Error('daemon_runtime_manifest_invalid:fileCount');
  }
  let sumBytes = 0;
  const seen = new Set<string>();
  const validatedFiles: DaemonRuntimeManifestFileEntry[] = [];
  for (const rawEntry of obj.files) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error('daemon_runtime_manifest_invalid:file_entry');
    }
    const f = rawEntry as Record<string, unknown>;
    if (!isSafeManifestRelativePath(f.path)) {
      throw new Error('daemon_runtime_manifest_invalid:file_path');
    }
    if (seen.has(f.path)) {
      throw new Error('daemon_runtime_manifest_invalid:duplicate_file');
    }
    if (typeof f.sha256 !== 'string' || !DESKTOP_RELEASE_SHA256_RE.test(f.sha256)) {
      throw new Error('daemon_runtime_manifest_invalid:file_sha256');
    }
    if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0) {
      throw new Error('daemon_runtime_manifest_invalid:file_size');
    }
    seen.add(f.path);
    sumBytes += f.size;
    validatedFiles.push({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      ...(typeof f.executable === 'boolean' ? { executable: f.executable } : {}),
    });
  }
  if (typeof obj.totalUncompressedBytes === 'number' && obj.totalUncompressedBytes !== sumBytes) {
    throw new Error('daemon_runtime_manifest_invalid:totalUncompressedBytes');
  }
  if (!seen.has(expectedNode)) {
    throw new Error('daemon_runtime_manifest_invalid:missing_node_entry');
  }
  for (const reqPath of DAEMON_RUNTIME_CRITICAL_ENTRY_PATHS) {
    if (!seen.has(reqPath)) {
      throw new Error(`daemon_runtime_manifest_invalid:missing_critical_entry:${reqPath}`);
    }
  }

  return {
    schemaVersion: DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION,
    artifact: {
      fileName: a.fileName,
      format: expectedFormat,
      os: expectedOs,
      arch: expectedArch,
      size: a.size,
      sha256: a.sha256,
      ...(authenticodeSignerSha256 ? { authenticodeSignerSha256 } : {}),
      ...(macosSigningIdentitySha1 ? { macosSigningIdentitySha1 } : {}),
    },
    entrypoint: {
      node: expectedNode,
      script: 'package/dist/src/index.js',
    },
    toolchain: {
      nodeProvider: tc.nodeProvider,
      nodeVersion: tc.nodeVersion,
      ...(typeof tc.nodeArchive === 'string' ? { nodeArchive: tc.nodeArchive } : {}),
      ...(typeof tc.nodeArchiveSha256 === 'string' ? { nodeArchiveSha256: tc.nodeArchiveSha256 } : {}),
      ...(typeof tc.nodeBinarySha256 === 'string' ? { nodeBinarySha256: tc.nodeBinarySha256 } : {}),
    },
    build: {
      commit: b.commit,
      version: b.version.trim(),
    },
    totalUncompressedBytes: typeof obj.totalUncompressedBytes === 'number' ? obj.totalUncompressedBytes : sumBytes,
    fileCount: validatedFiles.length,
    files: validatedFiles,
  };
}
