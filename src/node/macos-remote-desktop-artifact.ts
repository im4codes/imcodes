import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_MACOS_TEAM_ID,
  type RemoteDesktopMacosArchitecture,
  type RemoteDesktopMacosCodeIdentity,
  type RemoteDesktopMacosNotarizationEvidence,
  type RemoteDesktopMacosWorkerManifest,
  validateRemoteDesktopWorkerReleaseManifest,
} from '../../shared/remote-desktop-worker.js';
import {
  MACOS_APPLE_TOOLS,
  verifyMacosAppleTrust,
} from './macos-apple-trust.mjs';

// Re-exported from the shared module so there is exactly one table of tool
// paths; a second one would let the two verifiers diverge silently.
export const MACOS_REMOTE_DESKTOP_APPLE_TOOLS = MACOS_APPLE_TOOLS;

export const MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS = Object.freeze({
  current: 'current',
  lastKnownGood: 'last-known-good',
});

const RELEASES_DIRECTORY = 'releases';
const RELEASE_NAME_RE = /^sha256-[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
// The virtual-display helper is part of the ATOMIC component set, not an
// optional extra. Leaving it out here meant the daemon-side selector never
// extracted or verified it, so a release could be selected and activated with
// no display-control component present at all -- and the session would then
// discover that only at route time.
const COMPONENT_KINDS = ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'] as const;

export type MacosRemoteDesktopComponentKind = typeof COMPONENT_KINDS[number];

export interface MacosRemoteDesktopArtifactCommandResult {
  stdout: string;
  stderr: string;
}

export type MacosRemoteDesktopArtifactCommandExecutor = (
  executable: string,
  args: readonly string[],
) => Promise<MacosRemoteDesktopArtifactCommandResult>;

export interface MacosRemoteDesktopArtifactRuntime {
  platform: NodeJS.Platform;
  arch: string;
  /**
   * Effective uid the store must belong to, defaulting to this process.
   *
   * Present so the ownership rule can be exercised without running the suite
   * as root; production callers omit it and get `process.getuid()`.
   */
  uid?: number;
}

export interface MacosRemoteDesktopArtifactDependencies {
  execute?: MacosRemoteDesktopArtifactCommandExecutor;
  /** Test seam. Production callers must omit this so process.platform/arch are authoritative. */
  runtime?: MacosRemoteDesktopArtifactRuntime;
}

export interface VerifiedMacosRemoteDesktopComponent {
  kind: MacosRemoteDesktopComponentKind;
  executablePath: string;
  fileName: string;
  size: number;
  sha256: string;
  bundleIdentifier: string;
  designatedRequirement: string;
}

export interface VerifiedMacosRemoteDesktopArtifact {
  artifactDirectory: string;
  manifestPath: string;
  manifest: RemoteDesktopMacosWorkerManifest;
  components: Readonly<Record<MacosRemoteDesktopComponentKind, VerifiedMacosRemoteDesktopComponent>>;
  setSha256: string;
  releaseName?: string;
}

export interface VerifyMacosRemoteDesktopArtifactInput {
  artifactDirectory: string;
  manifestPath: string;
  expectedWorkerVersion?: string;
}

export interface PromoteMacosRemoteDesktopArtifactInput
  extends VerifyMacosRemoteDesktopArtifactInput {
  storeRoot: string;
}

export interface RollbackMacosRemoteDesktopArtifactInput {
  storeRoot: string;
}

export interface UpgradeMacosRemoteDesktopArtifactInput
  extends PromoteMacosRemoteDesktopArtifactInput {
  lifecycle: MacosRemoteDesktopArtifactUpgradeLifecycle;
}

/**
 * Lifecycle boundary owned by the caller that has the active Aqua session.
 * The artifact transaction never receives daemon credentials or IPC secrets.
 */
export interface MacosRemoteDesktopArtifactUpgradeLifecycle {
  stop: () => Promise<void>;
  start: (artifact: VerifiedMacosRemoteDesktopArtifact) => Promise<void>;
  verifyReadiness: (artifact: VerifiedMacosRemoteDesktopArtifact) => Promise<void>;
}

function defaultExecute(
  executable: string,
  args: readonly string[],
): Promise<MacosRemoteDesktopArtifactCommandResult> {
  return new Promise((resolveResult, reject) => {
    execFile(executable, [...args], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()));
        return;
      }
      resolveResult({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function runtimeTarget(runtime: MacosRemoteDesktopArtifactRuntime): RemoteDesktopMacosArchitecture {
  if (runtime.platform !== 'darwin') {
    throw new Error('macos_remote_desktop_artifact_wrong_os');
  }
  if (runtime.arch === 'arm64') return 'arm64';
  if (runtime.arch === 'x64') return 'x64';
  throw new Error('macos_remote_desktop_artifact_wrong_architecture');
}

async function requireRegularFile(path: string, label: string): Promise<number> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(`macos_remote_desktop_artifact_${label}_not_regular`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`macos_remote_desktop_artifact_${label}_not_regular`);
  }
  return stat.size;
}

async function requireDirectory(path: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(`macos_remote_desktop_artifact_${label}_not_directory`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`macos_remote_desktop_artifact_${label}_not_directory`);
  }
}

/**
 * Ownership and writability of a store path the daemon did not just create.
 *
 * `mkdir(..., { mode })` sets a mode only when it CREATES the directory, and
 * `recursive: true` makes a pre-existing path a silent success. So every guard
 * that ran after it was inspecting a directory whose permissions and owner had
 * been chosen by whoever got there first. For a store the root daemon later
 * executes binaries out of, that is the whole attack: pre-create the path,
 * keep write access, swap a component in afterwards.
 *
 * Root is always allowed because a root daemon's own store is root-owned.
 */
async function requireTrustedStoreDirectory(
  path: string,
  label: string,
  expectedUid: number | undefined,
): Promise<void> {
  await requireDirectory(path, label);
  const stat = await lstat(path);
  // Group- or world-writable is disqualifying regardless of owner: anyone in
  // the group can replace a component between verification and execution.
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`macos_remote_desktop_artifact_${label}_untrusted`);
  }
  if (expectedUid !== undefined && stat.uid !== 0 && stat.uid !== expectedUid) {
    throw new Error(`macos_remote_desktop_artifact_${label}_untrusted`);
  }
}

/**
 * Read-side store trust. NEVER creates anything.
 *
 * `ensureStore` guards the MUTATION flows, but selection -- the path that
 * actually hands an executable to launch -- read the selector and verified a
 * release without ever asking who owned the store or who could write it. So a
 * store that was safe at promote time and chmod 0777 afterwards still resolved
 * a release, which is the whole window that matters: the attacker does not need
 * to win the race before publication, only before launch.
 *
 * Creating on this path would be worse than useless -- it would manufacture an
 * empty store for a caller that asked what was already installed -- so a
 * missing store is ENOENT-shaped and reported as "not a directory", not made.
 */
async function requireTrustedStoreForRead(
  storeRoot: string,
  expectedUid: number | undefined,
): Promise<void> {
  await requireTrustedStoreDirectory(storeRoot, 'store', expectedUid);
  await requireTrustedStoreDirectory(
    join(storeRoot, RELEASES_DIRECTORY), 'releases', expectedUid);
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function commandOutput(result: MacosRemoteDesktopArtifactCommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function lineValue(output: string, prefix: string): string | null {
  const line = output.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

async function verifyAppleTrust(
  executablePath: string,
  identity: RemoteDesktopMacosCodeIdentity['bundles'][MacosRemoteDesktopComponentKind],
  notarization: RemoteDesktopMacosNotarizationEvidence,
  teamId: string,
  expectedArch: RemoteDesktopMacosArchitecture,
  execute: MacosRemoteDesktopArtifactCommandExecutor,
): Promise<void> {
  // One implementation, shared with the packager. Two copies of "what verified
  // means" would drift, and the weaker copy is the one an attacker uses.
  try {
    await verifyMacosAppleTrust(
      executablePath, identity, notarization, teamId, expectedArch, execute,
    );
  } catch (error) {
    // Preserve this module's established error vocabulary; callers and tests
    // match on it.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(
      /^macos_apple_trust_/u, 'macos_remote_desktop_artifact_',
    ));
  }
}

async function exactArtifactEntries(
  artifactDirectory: string,
  manifest: RemoteDesktopMacosWorkerManifest,
): Promise<void> {
  const expected = new Set<string>([
    REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
    ...COMPONENT_KINDS.map((kind) => manifest.components[kind].fileName),
  ]);
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  if (entries.length !== expected.size
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))) {
    throw new Error('macos_remote_desktop_artifact_unexpected_entries');
  }
}

export async function verifyMacosRemoteDesktopArtifact(
  input: VerifyMacosRemoteDesktopArtifactInput,
  dependencies: MacosRemoteDesktopArtifactDependencies = {},
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  const runtime = dependencies.runtime ?? {
    platform: process.platform,
    arch: process.arch,
  };
  const expectedArch = runtimeTarget(runtime);
  const artifactDirectory = resolve(input.artifactDirectory);
  const manifestPath = resolve(input.manifestPath);
  if (dirname(manifestPath) !== artifactDirectory
    || manifestPath !== join(artifactDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME)) {
    throw new Error('macos_remote_desktop_artifact_manifest_invalid');
  }
  await requireDirectory(artifactDirectory, 'directory');
  const manifestSize = await requireRegularFile(manifestPath, 'manifest');
  if (manifestSize > MAX_MANIFEST_BYTES) {
    throw new Error('macos_remote_desktop_artifact_manifest_too_large');
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('macos_remote_desktop_artifact_manifest_invalid');
  }
  const manifest = validateRemoteDesktopWorkerReleaseManifest(rawManifest, {
    os: 'darwin',
    arch: expectedArch,
  });
  if (manifest?.os !== 'darwin'
    || manifest.arch !== expectedArch
    // Restated at the public verification boundary. The shared validator pins
    // this too, but a caller reaching a differently-validated manifest here
    // must not be able to publish a foreign-team set, and Apple trust below is
    // checked AGAINST this field -- so an unpinned value would let the artifact
    // nominate its own signer.
    || manifest.codeSignature.teamId !== REMOTE_DESKTOP_MACOS_TEAM_ID
    || (input.expectedWorkerVersion !== undefined
      && manifest.workerVersion !== input.expectedWorkerVersion)) {
    throw new Error('macos_remote_desktop_artifact_manifest_invalid');
  }
  await exactArtifactEntries(artifactDirectory, manifest);

  const execute = dependencies.execute ?? defaultExecute;
  const verified = {} as Record<MacosRemoteDesktopComponentKind, VerifiedMacosRemoteDesktopComponent>;
  for (const kind of COMPONENT_KINDS) {
    const component = manifest.components[kind];
    const executablePath = join(artifactDirectory, component.fileName);
    const size = await requireRegularFile(executablePath, `${kind}_executable`);
    if (size !== component.size) {
      throw new Error(`macos_remote_desktop_artifact_${kind}_size_mismatch`);
    }
    if (await sha256File(executablePath) !== component.sha256) {
      throw new Error(`macos_remote_desktop_artifact_${kind}_hash_mismatch`);
    }
    const identity = manifest.codeSignature.bundles[kind];
    await verifyAppleTrust(
      executablePath,
      identity,
      component.notarization,
      REMOTE_DESKTOP_MACOS_TEAM_ID,
      expectedArch,
      execute,
    );
    verified[kind] = Object.freeze({
      kind,
      executablePath,
      fileName: component.fileName,
      size,
      sha256: component.sha256,
      bundleIdentifier: identity.bundleIdentifier,
      designatedRequirement: identity.designatedRequirement,
    });
  }

  return Object.freeze({
    artifactDirectory,
    manifestPath,
    manifest,
    components: Object.freeze(verified),
    setSha256: await sha256File(manifestPath),
  });
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryWhereSupported(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    await handle.close();
  }
}

async function ensureStore(
  storeRoot: string,
  expectedUid: number | undefined,
): Promise<string> {
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  await requireTrustedStoreDirectory(storeRoot, 'store', expectedUid);
  const releasesDirectory = join(storeRoot, RELEASES_DIRECTORY);
  await mkdir(releasesDirectory, { recursive: true, mode: 0o700 });
  await requireTrustedStoreDirectory(releasesDirectory, 'releases', expectedUid);
  return releasesDirectory;
}

/**
 * The uid the store must belong to. `process.getuid` is absent on Windows,
 * where the ownership arm cannot be evaluated and is therefore skipped; the
 * mode arm still applies.
 */
function storeOwnerUid(runtime: MacosRemoteDesktopArtifactRuntime | undefined): number | undefined {
  return runtime?.uid ?? process.getuid?.();
}

function selectorPath(storeRoot: string, selector: string): string {
  return join(storeRoot, selector);
}

async function readSelector(storeRoot: string, selector: string): Promise<string | null> {
  const path = selectorPath(storeRoot, selector);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) {
    throw new Error('macos_remote_desktop_artifact_selector_invalid');
  }
  const value = (await readFile(path, 'utf8')).trim();
  if (!RELEASE_NAME_RE.test(value)) {
    throw new Error('macos_remote_desktop_artifact_selector_invalid');
  }
  return value;
}

async function writeSelector(storeRoot: string, selector: string, releaseName: string): Promise<void> {
  if (!RELEASE_NAME_RE.test(releaseName)) {
    throw new Error('macos_remote_desktop_artifact_selector_invalid');
  }
  const destination = selectorPath(storeRoot, selector);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${releaseName}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
    await syncDirectoryWhereSupported(storeRoot);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeSelector(storeRoot: string, selector: string): Promise<void> {
  await rm(selectorPath(storeRoot, selector), { force: true });
  await syncDirectoryWhereSupported(storeRoot);
}

async function restoreSelector(
  storeRoot: string,
  selector: string,
  releaseName: string | null,
): Promise<void> {
  if (releaseName === null) {
    await removeSelector(storeRoot, selector);
    return;
  }
  await writeSelector(storeRoot, selector, releaseName);
}

async function verifyRelease(
  storeRoot: string,
  releaseName: string,
  dependencies: MacosRemoteDesktopArtifactDependencies,
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  if (!RELEASE_NAME_RE.test(releaseName)) {
    throw new Error('macos_remote_desktop_artifact_selector_invalid');
  }
  const expectedUid = storeOwnerUid(dependencies.runtime);
  // Re-checked HERE rather than only at the caller: every path that returns an
  // executable goes through this function, so this is the single choke point
  // that cannot be bypassed by adding a new caller later.
  await requireTrustedStoreForRead(storeRoot, expectedUid);
  const artifactDirectory = join(storeRoot, RELEASES_DIRECTORY, releaseName);
  // The release directory itself, not just its parents. A world-writable
  // release is a swappable component set no matter how safe the store above it.
  await requireTrustedStoreDirectory(artifactDirectory, 'release', expectedUid);
  const verified = await verifyMacosRemoteDesktopArtifact({
    artifactDirectory,
    manifestPath: join(artifactDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME),
  }, dependencies);
  if (releaseName !== `sha256-${verified.setSha256}`) {
    throw new Error('macos_remote_desktop_artifact_release_identity_mismatch');
  }
  return Object.freeze({ ...verified, releaseName });
}

/**
 * Re-assert store trust immediately before the artifact is USED.
 *
 * Selection validates and then returns a path, and everything between that
 * return and the exec is a window in which the store can be made writable and
 * the component swapped. This cannot close the window -- nothing short of an
 * open fd can -- but it narrows it from "any time since boot" to the few
 * instructions before launch, and it makes the common case (a store left
 * world-writable and never repaired) fail at every use rather than only the
 * first. Creates nothing.
 */
export async function assertMacosRemoteDesktopStoreTrusted(
  storeRoot: string,
  releaseName: string | undefined,
  dependencies: MacosRemoteDesktopArtifactDependencies = {},
): Promise<void> {
  const expectedUid = storeOwnerUid(dependencies.runtime);
  await requireTrustedStoreForRead(storeRoot, expectedUid);
  if (releaseName !== undefined) {
    if (!RELEASE_NAME_RE.test(releaseName)) {
      throw new Error('macos_remote_desktop_artifact_selector_invalid');
    }
    await requireTrustedStoreDirectory(
      join(storeRoot, RELEASES_DIRECTORY, releaseName), 'release', expectedUid);
  }
}

export async function selectMacosRemoteDesktopArtifact(
  storeRoot: string,
  selector: keyof typeof MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS = 'current',
  dependencies: MacosRemoteDesktopArtifactDependencies = {},
): Promise<VerifiedMacosRemoteDesktopArtifact | null> {
  const selectorFile = MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS[selector];
  // BEFORE the selector is read, not after. The selector file names which
  // release to launch, so a store anyone can write is one where that choice is
  // already the attacker's -- reading it first and validating later would be
  // trusting the answer to decide whether to trust the source.
  await requireTrustedStoreForRead(storeRoot, storeOwnerUid(dependencies.runtime));
  const releaseName = await readSelector(storeRoot, selectorFile);
  return releaseName === null ? null : verifyRelease(storeRoot, releaseName, dependencies);
}

async function stageRelease(
  input: PromoteMacosRemoteDesktopArtifactInput,
  candidate: VerifiedMacosRemoteDesktopArtifact,
  dependencies: MacosRemoteDesktopArtifactDependencies,
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  const releasesDirectory = await ensureStore(input.storeRoot, storeOwnerUid(dependencies.runtime));
  const releaseName = `sha256-${candidate.setSha256}`;
  const releaseDirectory = join(releasesDirectory, releaseName);
  try {
    await lstat(releaseDirectory);
    return verifyRelease(input.storeRoot, releaseName, dependencies);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const stagingDirectory = await mkdtemp(join(releasesDirectory, '.staging-'));
  try {
    await chmod(stagingDirectory, 0o700);
    for (const kind of COMPONENT_KINDS) {
      const component = candidate.components[kind];
      const stagedPath = join(stagingDirectory, component.fileName);
      await copyFile(component.executablePath, stagedPath);
      await chmod(stagedPath, 0o755);
      await syncFile(stagedPath);
    }
    const stagedManifest = join(stagingDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME);
    await copyFile(candidate.manifestPath, stagedManifest);
    await chmod(stagedManifest, 0o600);
    await syncFile(stagedManifest);
    await syncDirectoryWhereSupported(stagingDirectory);
    const staged = await verifyMacosRemoteDesktopArtifact({
      artifactDirectory: stagingDirectory,
      manifestPath: stagedManifest,
      expectedWorkerVersion: input.expectedWorkerVersion,
    }, dependencies);
    if (staged.setSha256 !== candidate.setSha256) {
      throw new Error('macos_remote_desktop_artifact_release_identity_mismatch');
    }
    await rename(stagingDirectory, releaseDirectory);
    await syncDirectoryWhereSupported(releasesDirectory);
    return verifyRelease(input.storeRoot, releaseName, dependencies);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function promoteMacosRemoteDesktopArtifact(
  input: PromoteMacosRemoteDesktopArtifactInput,
  dependencies: MacosRemoteDesktopArtifactDependencies = {},
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  const candidate = await verifyMacosRemoteDesktopArtifact(input, dependencies);
  await ensureStore(input.storeRoot, storeOwnerUid(dependencies.runtime));
  const previousRelease = await readSelector(
    input.storeRoot,
    MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current,
  );
  if (previousRelease !== null) {
    await verifyRelease(input.storeRoot, previousRelease, dependencies);
  }
  const staged = await stageRelease(input, candidate, dependencies);
  if (previousRelease === staged.releaseName) return staged;
  if (previousRelease !== null) {
    await writeSelector(
      input.storeRoot,
      MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.lastKnownGood,
      previousRelease,
    );
  }
  try {
    await writeSelector(
      input.storeRoot,
      MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current,
      staged.releaseName!,
    );
    return (await selectMacosRemoteDesktopArtifact(input.storeRoot, 'current', dependencies))!;
  } catch (error) {
    if (previousRelease === null) {
      await removeSelector(input.storeRoot, MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current);
    } else {
      await writeSelector(
        input.storeRoot,
        MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current,
        previousRelease,
      );
    }
    throw error;
  }
}

export async function rollbackMacosRemoteDesktopArtifact(
  input: RollbackMacosRemoteDesktopArtifactInput,
  dependencies: MacosRemoteDesktopArtifactDependencies = {},
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  await ensureStore(input.storeRoot, storeOwnerUid(dependencies.runtime));
  const rollbackRelease = await readSelector(
    input.storeRoot,
    MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.lastKnownGood,
  );
  if (rollbackRelease === null) {
    throw new Error('macos_remote_desktop_artifact_rollback_unavailable');
  }
  await verifyRelease(input.storeRoot, rollbackRelease, dependencies);
  const previousRelease = await readSelector(
    input.storeRoot,
    MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current,
  );
  if (previousRelease === rollbackRelease) {
    return verifyRelease(input.storeRoot, rollbackRelease, dependencies);
  }
  let previousVerified = false;
  if (previousRelease !== null) {
    try {
      await verifyRelease(input.storeRoot, previousRelease, dependencies);
      previousVerified = true;
    } catch {
      // A corrupted current release must not prevent a verified complete-set rollback.
    }
  }
  try {
    await writeSelector(
      input.storeRoot,
      MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current,
      rollbackRelease,
    );
    const rolledBack = await selectMacosRemoteDesktopArtifact(input.storeRoot, 'current', dependencies);
    if (rolledBack === null) throw new Error('macos_remote_desktop_artifact_rollback_failed');
    if (previousRelease !== null && previousVerified) {
      await writeSelector(
        input.storeRoot,
        MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.lastKnownGood,
        previousRelease,
      );
    }
    return rolledBack;
  } catch (error) {
    if (previousRelease === null) {
      await removeSelector(input.storeRoot, MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current);
    } else {
      await writeSelector(
        input.storeRoot,
        MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current,
        previousRelease,
      );
    }
    throw error;
  }
}

/**
 * Upgrade one already-packaged, architecture-specific component set as one
 * fail-closed service transaction.
 *
 * Candidate, current and last-known-good sets are verified before the active
 * LaunchAgent is stopped. Promotion publishes immutable files and swaps the
 * selector atomically. The new selector is accepted only after the caller has
 * started the LaunchAgent and observed bounded, authenticated readiness. Any
 * failure restores the exact selector snapshot (including a first install's
 * absent selectors) and restarts the previously verified current set.
 */
export async function upgradeMacosRemoteDesktopArtifact(
  input: UpgradeMacosRemoteDesktopArtifactInput,
  dependencies: MacosRemoteDesktopArtifactDependencies = {},
): Promise<VerifiedMacosRemoteDesktopArtifact> {
  // Do all expensive/fallible qualification before interrupting the current
  // user-session service. promote() re-verifies after staging as a separate
  // publication boundary.
  await verifyMacosRemoteDesktopArtifact(input, dependencies);
  await ensureStore(input.storeRoot, storeOwnerUid(dependencies.runtime));
  const previousCurrentName = await readSelector(
    input.storeRoot,
    MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current,
  );
  const previousLastKnownGoodName = await readSelector(
    input.storeRoot,
    MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.lastKnownGood,
  );
  const previousCurrent = previousCurrentName === null
    ? null
    : await verifyRelease(input.storeRoot, previousCurrentName, dependencies);
  if (previousLastKnownGoodName !== null) {
    await verifyRelease(input.storeRoot, previousLastKnownGoodName, dependencies);
  }

  await input.lifecycle.stop();
  let promoted: VerifiedMacosRemoteDesktopArtifact | null = null;
  try {
    promoted = await promoteMacosRemoteDesktopArtifact(input, dependencies);
    await input.lifecycle.start(promoted);
    await input.lifecycle.verifyReadiness(promoted);
    return promoted;
  } catch (primaryError) {
    const rollbackErrors: unknown[] = [];
    // A partially started new LaunchAgent must not survive selector rollback.
    if (promoted !== null) {
      try {
        await input.lifecycle.stop();
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    try {
      await restoreSelector(
        input.storeRoot,
        MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.current,
        previousCurrentName,
      );
      await restoreSelector(
        input.storeRoot,
        MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS.lastKnownGood,
        previousLastKnownGoodName,
      );
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (previousCurrent !== null) {
      try {
        await input.lifecycle.start(previousCurrent);
        await input.lifecycle.verifyReadiness(previousCurrent);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...rollbackErrors],
        'macos_remote_desktop_artifact_upgrade_rollback_failed',
      );
    }
    throw primaryError;
  }
}
