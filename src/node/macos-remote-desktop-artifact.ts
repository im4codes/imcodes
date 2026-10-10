import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
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
  REMOTE_DESKTOP_WORKER_ENTRY_KIND,
  REMOTE_DESKTOP_WORKER_RETENTION,
  planRemoteDesktopWorkerPrune,
  type RemoteDesktopWorkerStoreEntry,
} from '../../shared/remote-desktop-worker-retention.js';
import { MACOS_REMOTE_DESKTOP_GLOBAL_LAUNCH_AGENT_PATH } from './macos-user-session.js';
import {
  MACOS_APPLE_TOOLS,
  macosAppleCommandFailed,
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
      // A non-zero exit from spctl or stapler is the verdict the caller asked
      // for, so its output is returned rather than thrown. Rejecting it threw
      // before the notarization check could read it -- with spctl's own text
      // as the error -- and every correctly notarized component was refused on
      // the user's Mac.
      if (macosAppleCommandFailed(error, executable, args)) {
        reject(new Error(String(stderr || stdout || (error?.message ?? 'command failed')).trim()));
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
/**
 * Bring an ALREADY-TRUSTED directory to the traversable mode, and say nothing
 * if it cannot.
 *
 * Only ever called after `requireTrustedStoreDirectory`, so this never widens
 * a directory whose owner or writability was rejected. A failure is swallowed
 * because it is not fatal to the read in progress: a store on a read-only
 * volume, or one owned by root while this daemon is not, still serves what it
 * already holds.
 */
async function normalizeTrustedStoreDirectoryMode(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if ((stat.mode & 0o777) === STORE_DIRECTORY_MODE) return;
    await chmod(path, STORE_DIRECTORY_MODE);
  } catch {
    // Left as found.
  }
}

/**
 * How many directories above the store belong to the product. The store lives
 * at `<node state>/remote-desktop-worker/darwin-<arch>`; both of those parents
 * are created by the root daemon, and both came out 0700.
 */
const STORE_OWNED_ANCESTOR_DEPTH = 2;

/**
 * Let the console user WALK through the directories above the store -- search
 * permission only, never read or write.
 *
 * Making the store itself 0755 fixed nothing on a real Mac: the two directories
 * above it were still root-only, so the agent launchd started for the console
 * user died with exit 126 before running a line, and the permission prompt never
 * appeared. The node state directory also holds the server credential, so this
 * adds execute bits alone (0700 -> 0711): a path can be traversed, but nothing
 * in it can be listed, and the credential file keeps its own 0600.
 *
 * A directory whose owner or writability would fail the store's trust check is
 * left untouched, as is anything that cannot be inspected.
 */
async function ensureStoreAncestorsTraversable(
  storeRoot: string,
  expectedUid: number | undefined,
): Promise<void> {
  let path = resolve(storeRoot);
  for (let depth = 0; depth < STORE_OWNED_ANCESTOR_DEPTH; depth += 1) {
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      if ((stat.mode & 0o022) !== 0) return;
      if (expectedUid !== undefined && stat.uid !== 0 && stat.uid !== expectedUid) return;
      const mode = stat.mode & 0o7777;
      if ((mode & 0o011) === 0o011) continue;
      await chmod(path, mode | 0o011);
    } catch {
      return;
    }
  }
}

async function requireTrustedStoreForRead(
  storeRoot: string,
  expectedUid: number | undefined,
): Promise<void> {
  await requireTrustedStoreDirectory(storeRoot, 'store', expectedUid);
  await requireTrustedStoreDirectory(
    join(storeRoot, RELEASES_DIRECTORY), 'releases', expectedUid);
  // Both parents, not only the release below them. A traversable release
  // inside a root-only store is still unreachable by the console user, so
  // repairing one without the others fixes nothing.
  await normalizeTrustedStoreDirectoryMode(storeRoot);
  await normalizeTrustedStoreDirectoryMode(join(storeRoot, RELEASES_DIRECTORY));
  await ensureStoreAncestorsTraversable(storeRoot, expectedUid);
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

/**
 * Root-owned and unwritable by anyone else, but TRAVERSABLE.
 *
 * These directories were created 0700, which is stricter than the trust
 * invariant needs and broke the one thing the store exists for: the components
 * must be executed AS THE CONSOLE USER, because that is the only principal
 * macOS attributes a TCC grant to. A root-only directory made every component
 * unrunnable by that user -- the worker could not be launched and the
 * permission prompt could not be raised, both failing with a bare
 * "Permission denied" from a path nobody was looking at.
 *
 * 0755 keeps exactly what `requireTrustedStoreDirectory` enforces: not
 * group- or world-writable, and root-owned. Nothing about tamper resistance
 * changes; only the ability to walk in and run what is already verified.
 *
 * chmod is explicit because `mkdir(..., { mode })` sets a mode only when it
 * CREATES the directory -- a store that already exists at 0700 would otherwise
 * stay broken forever. It runs after the trust check, so a directory this
 * daemon should not touch is rejected before its mode is changed.
 */
const STORE_DIRECTORY_MODE = 0o755;


async function ensureStore(
  storeRoot: string,
  expectedUid: number | undefined,
): Promise<string> {
  await mkdir(storeRoot, { recursive: true, mode: STORE_DIRECTORY_MODE });
  await requireTrustedStoreDirectory(storeRoot, 'store', expectedUid);
  await normalizeTrustedStoreDirectoryMode(storeRoot);
  await ensureStoreAncestorsTraversable(storeRoot, expectedUid);
  const releasesDirectory = join(storeRoot, RELEASES_DIRECTORY);
  await mkdir(releasesDirectory, { recursive: true, mode: STORE_DIRECTORY_MODE });
  await requireTrustedStoreDirectory(releasesDirectory, 'releases', expectedUid);
  await normalizeTrustedStoreDirectoryMode(releasesDirectory);
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
  // Repaired in place, every time a release is read.
  //
  // A release published before this mode was corrected sits at 0700 forever:
  // promotion returns early when the directory already exists, so nothing ever
  // revisits it, and the components inside stay unrunnable by the console user
  // -- the only principal allowed to run them. Machines already installed
  // would have needed a manual fix or a reinstall. Doing it here means every
  // path that hands out an executable normalises what it is about to hand out.
  await normalizeTrustedStoreDirectoryMode(artifactDirectory);
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
    // Published at the same mode the store uses: this directory BECOMES the
    // release, and a 0700 release is one the console user cannot execute out
    // of. `mkdtemp` creates it 0700, so this is not cosmetic.
    await chmod(stagingDirectory, STORE_DIRECTORY_MODE);
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

// ---------------------------------------------------------------------------------------------------------------------------
// Retention. Every distinct worker build publishes a new `releases/sha256-*` directory (15-17 MB) and nothing ever removed one:
// a Mac that updates often held 334 of them (4.9 GB) while only `current` and `last-known-good` are ever read. The decision of what
// may go is the shared policy (shared/remote-desktop-worker-retention.ts); this is the macOS half that lists the store, says what
// is in use, and removes safely.
// ---------------------------------------------------------------------------------------------------------------------------

/** A release is renamed to this before it is deleted: a crash mid-delete can then never leave a half-removed `sha256-*` that a
 * later promotion of the same set would find, fail to verify, and keep failing on. */
const PRUNING_PREFIX = '.pruning-';
const STAGING_PREFIX = '.staging-';
const RELEASE_NAME_ANYWHERE_RE = /sha256-[a-f0-9]{64}/gu;
const MAX_INUSE_PLIST_BYTES = 256 * 1024;
const MAX_PROCESS_LIST_BYTES = 16 * 1024 * 1024;

export type MacosRemoteDesktopPruneSkip =
  | 'no_store'
  | 'busy'
  | 'already_running'
  | 'untrusted_store'
  | 'selector_invalid'
  | 'in_use_probe_failed';

export interface MacosRemoteDesktopPruneResult {
  removed: number;
  failed: number;
  /** More removable entries exist than this pass may remove (or the pass had to wait): run another. */
  moreWork: boolean;
  skipped?: MacosRemoteDesktopPruneSkip;
}

export interface MacosRemoteDesktopPruneDependencies extends MacosRemoteDesktopArtifactDependencies {
  now?: () => number;
  /**
   * Names of the releases a running worker or an installed launchd job still points at. If it throws the pass changes nothing: an
   * unknown is treated as in use.
   */
  releasesInUse?: (storeRoot: string) => Promise<ReadonlySet<string>>;
  /** True while a promotion or upgrade of this process is in flight; the pass then waits. */
  isBusy?: () => boolean;
  /** Test seams for a locked or failing entry. */
  renameEntry?: (from: string, to: string) => Promise<void>;
  removeEntry?: (path: string) => Promise<void>;
  limits?: Partial<typeof REMOTE_DESKTOP_WORKER_RETENTION>;
}

const pruneRunning = new Set<string>();
/** store root -> entry name -> passes left to leave it alone after it could not be removed. */
const pruneSkips = new Map<string, Map<string, number>>();

/** Releases named by the installed launchd plist and by running processes' command lines. Deliberately generous: any release hash
 * that appears is kept, because keeping one too many costs 15 MB and removing one in use costs the remote desktop. */
export async function defaultMacosRemoteDesktopReleasesInUse(): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  const collect = (text: string): void => {
    for (const match of text.matchAll(RELEASE_NAME_ANYWHERE_RE)) names.add(match[0]);
  };
  try {
    const info = await lstat(MACOS_REMOTE_DESKTOP_GLOBAL_LAUNCH_AGENT_PATH);
    if (info.isFile() && info.size <= MAX_INUSE_PLIST_BYTES) {
      collect(await readFile(MACOS_REMOTE_DESKTOP_GLOBAL_LAUNCH_AGENT_PATH, 'utf8'));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const processList = await new Promise<string>((resolveOutput, reject) => {
    execFile('/bin/ps', ['-axo', 'command='], {
      encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_PROCESS_LIST_BYTES,
    }, (error, stdout) => (error ? reject(error) : resolveOutput(String(stdout))));
  });
  collect(processList);
  return names;
}

function takeSkippedNames(storeRoot: string): Set<string> {
  const skips = pruneSkips.get(storeRoot);
  const active = new Set<string>();
  if (!skips) return active;
  for (const [name, left] of skips) {
    if (left <= 0) { skips.delete(name); continue; }
    active.add(name);
    skips.set(name, left - 1);
  }
  return active;
}

function rememberFailure(storeRoot: string, name: string, passes: number): void {
  let skips = pruneSkips.get(storeRoot);
  if (!skips) { skips = new Map(); pruneSkips.set(storeRoot, skips); }
  skips.set(name, passes);
}

async function readSelectorsForPrune(storeRoot: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const selector of Object.values(MACOS_REMOTE_DESKTOP_ARTIFACT_SELECTORS)) {
    const name = await readSelector(storeRoot, selector);
    if (name !== null) names.add(name);
  }
  return names;
}

/**
 * One bounded pass over the release store. Costs: names are read without a stat (up to the scan cap), only names shaped like ours
 * are examined (candidate cap), at most `MAX_REMOVALS_PER_PASS` directories are removed. Never removed: the selected releases (read
 * again right before each removal), anything a running worker or the launchd plist names, the newest few releases, anything younger
 * than the minimum age, and anything that is not a plain directory owned by the daemon's user or root. Nothing outside the
 * `releases` directory is touched, and nothing is created.
 */
export async function pruneMacosRemoteDesktopArtifactStore(
  storeRoot: string,
  dependencies: MacosRemoteDesktopPruneDependencies = {},
): Promise<MacosRemoteDesktopPruneResult> {
  runtimeTarget(dependencies.runtime ?? { platform: process.platform, arch: process.arch });
  const root = resolve(storeRoot);
  const limits = { ...REMOTE_DESKTOP_WORKER_RETENTION, ...dependencies.limits };
  if (pruneRunning.has(root)) return { removed: 0, failed: 0, moreWork: false, skipped: 'already_running' };
  if (dependencies.isBusy?.()) return { removed: 0, failed: 0, moreWork: true, skipped: 'busy' };
  pruneRunning.add(root);
  try {
    const expectedUid = storeOwnerUid(dependencies.runtime);
    const releasesDirectory = join(root, RELEASES_DIRECTORY);
    try {
      await lstat(releasesDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, failed: 0, moreWork: false, skipped: 'no_store' };
      return { removed: 0, failed: 0, moreWork: false, skipped: 'untrusted_store' };
    }
    try {
      // Read-only trust: unlike `requireTrustedStoreForRead` this never chmods anything.
      await requireTrustedStoreDirectory(root, 'store', expectedUid);
      await requireTrustedStoreDirectory(releasesDirectory, 'releases', expectedUid);
    } catch {
      return { removed: 0, failed: 0, moreWork: false, skipped: 'untrusted_store' };
    }

    let selected: Set<string>;
    try {
      selected = await readSelectorsForPrune(root);
    } catch {
      return { removed: 0, failed: 0, moreWork: false, skipped: 'selector_invalid' };
    }
    let inUse: ReadonlySet<string>;
    try {
      inUse = await (dependencies.releasesInUse ?? defaultMacosRemoteDesktopReleasesInUse)(root);
    } catch {
      return { removed: 0, failed: 0, moreWork: false, skipped: 'in_use_probe_failed' };
    }

    // Names only: a store that grew a backlog is exactly the case where a stat per entry would be the cost.
    const names: string[] = [];
    let scanned = 0;
    const directory = await opendir(releasesDirectory);
    try {
      for await (const entry of directory) {
        scanned += 1;
        if (RELEASE_NAME_RE.test(entry.name)
          || entry.name.startsWith(STAGING_PREFIX) || entry.name.startsWith(PRUNING_PREFIX)) {
          names.push(entry.name);
          if (names.length >= limits.MAX_CANDIDATES_PER_PASS) break;
        }
        if (scanned >= limits.MAX_ENTRIES_SCANNED) break;
      }
    } finally {
      await directory.close().catch(() => {});
    }

    const identities = new Map<string, { dev: number; ino: number; mtimeMs: number }>();
    const entries: RemoteDesktopWorkerStoreEntry[] = [];
    for (const name of names) {
      let info;
      try {
        info = await lstat(join(releasesDirectory, name));
      } catch {
        continue; // gone since the listing
      }
      if (!info.isDirectory() || info.isSymbolicLink()) continue; // never follow or remove what is not a plain directory
      if (expectedUid !== undefined && info.uid !== 0 && info.uid !== expectedUid) continue;
      identities.set(name, { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs });
      entries.push({
        name,
        kind: RELEASE_NAME_RE.test(name)
          ? REMOTE_DESKTOP_WORKER_ENTRY_KIND.RELEASE
          : REMOTE_DESKTOP_WORKER_ENTRY_KIND.TEMPORARY,
        mtimeMs: info.mtimeMs,
      });
    }

    const plan = planRemoteDesktopWorkerPrune({
      entries,
      protectedNames: new Set([...selected, ...inUse]),
      skipNames: takeSkippedNames(root),
      nowMs: (dependencies.now ?? Date.now)(),
      keepNewest: limits.KEEP_NEWEST_RELEASES,
      minReleaseAgeMs: limits.MIN_RELEASE_AGE_MS,
      minTemporaryAgeMs: limits.MIN_TEMPORARY_AGE_MS,
      maxRemovals: limits.MAX_REMOVALS_PER_PASS,
    });

    const renameEntry = dependencies.renameEntry ?? ((from: string, to: string) => rename(from, to));
    const removeEntry = dependencies.removeEntry ?? ((path: string) => rm(path, { recursive: true, force: true }));
    let removed = 0;
    let failed = 0;
    for (const entry of plan.remove) {
      const path = join(releasesDirectory, entry.name);
      try {
        if (entry.kind === REMOTE_DESKTOP_WORKER_ENTRY_KIND.RELEASE) {
          // The selectors are read AGAIN for every removal: a promotion that selected this release since the plan was made wins.
          const current = await readSelectorsForPrune(root);
          if (current.has(entry.name)) continue;
        }
        const info = await lstat(path);
        const identity = identities.get(entry.name);
        if (!identity || !info.isDirectory() || info.isSymbolicLink()
          || info.dev !== identity.dev || info.ino !== identity.ino || info.mtimeMs !== identity.mtimeMs) continue;
        if (entry.kind === REMOTE_DESKTOP_WORKER_ENTRY_KIND.RELEASE) {
          const doomed = join(releasesDirectory, `${PRUNING_PREFIX}${randomUUID()}`);
          await renameEntry(path, doomed);
          removed += 1;
          try {
            await removeEntry(doomed);
          } catch {
            // Already invisible as a release; a later pass removes the leftover `.pruning-*` directory.
          }
        } else {
          await removeEntry(path);
          removed += 1;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        failed += 1;
        rememberFailure(root, entry.name, limits.FAILED_ENTRY_SKIP_PASSES);
      }
    }
    return { removed, failed, moreWork: plan.moreWork };
  } finally {
    pruneRunning.delete(root);
  }
}

export interface MacosRemoteDesktopPruneBacklogSummary {
  passes: number;
  removed: number;
  failed: number;
  moreWork: boolean;
  lastSkipped?: MacosRemoteDesktopPruneSkip;
}

/**
 * Drain a backlog as short passes with a pause between them (each pass is bounded; together they empty a store of any size), and
 * stop after a bounded number of passes whatever is left: the next start continues.
 */
export async function pruneMacosRemoteDesktopArtifactStoreBacklog(
  storeRoot: string,
  dependencies: MacosRemoteDesktopPruneDependencies = {},
  options: {
    delayMs?: number;
    maxPasses?: number;
    sleep?: (ms: number) => Promise<void>;
    onPass?: (result: MacosRemoteDesktopPruneResult, pass: number) => void;
  } = {},
): Promise<MacosRemoteDesktopPruneBacklogSummary> {
  const delayMs = options.delayMs ?? REMOTE_DESKTOP_WORKER_RETENTION.BACKLOG_PASS_DELAY_MS;
  const maxPasses = options.maxPasses ?? REMOTE_DESKTOP_WORKER_RETENTION.BACKLOG_MAX_PASSES;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms).unref?.();
  }));
  const summary: MacosRemoteDesktopPruneBacklogSummary = { passes: 0, removed: 0, failed: 0, moreWork: false };
  while (summary.passes < maxPasses) {
    const result = await pruneMacosRemoteDesktopArtifactStore(storeRoot, dependencies);
    summary.passes += 1;
    summary.removed += result.removed;
    summary.failed += result.failed;
    summary.moreWork = result.moreWork;
    if (result.skipped) summary.lastSkipped = result.skipped;
    options.onPass?.(result, summary.passes);
    if (!result.moreWork) break;
    if (summary.passes < maxPasses) await sleep(delayMs);
  }
  return summary;
}
