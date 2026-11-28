import { CONTROLLED_NODE_ABI_MODERN, CONTROLLED_NODE_RUNTIME_ABI_PROFILE, normalizeControlledNodeAbiProfile, type ControlledNodeAbiProfile } from '../../shared/controlled-node-abi.js';
// First-run bootstrap for the controlled node — journaled install/enroll flow with
// D-A v2 identity pre-persist, stable trailer-free executable staging, real
// platform installer wiring, and crash-loop backoff (N5).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EnrollmentBlob, EnrollmentTrailerRange } from '../../shared/remote-exec.js';
import {
  assertProductionServerUrl,
  defaultCredentialPath,
  defaultInstallIdentityPath,
  defaultPendingReenrollmentPath,
  defaultStagedExecutablePath,
  generateInstallIdentity,
  hashEnrollmentToken,
  inspectExecutableReceipt,
  loadCredential,
  loadInstallIdentity,
  loadPendingReenrollment,
  openVerifiedEnrollmentSource,
  persistCredential,
  persistInstallIdentity,
  persistPendingReenrollment,
  probeControlledNodeCredentialStatus,
  redeemEnrollmentV2,
  removePendingReenrollment,
  type ControlledNodeCredential,
  type ControlledNodeCredentialProbeStatus,
  type PendingInstallIdentity,
  type PendingReenrollmentRecord,
  type StagedExecutableReceipt,
  type VerifiedEnrollmentSource,
} from './enrollment.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';
import {
  controlledNodeEndpointsPath,
  resetEndpointStateForCredential,
} from './server-endpoints.js';
import {
  assertProcessElevated,
  installDefinition,
  inspectDefinition,
  inspectServiceState,
  secureWindowsCredentialDir,
  startService,
  windowsSchtasksExecutablePath,
} from './installer.js';
import {
  InstallJournalCorruptError,
  loadInstallJournal,
  phaseIndex,
  writeInstallPhase,
  type InstallJournal,
  type InstallPhase,
  type ServiceReceipt,
  type SourceArtifactIdentity,
} from './install-journal.js';
import {
  WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
  installWindowsReleasePublisherTrust,
  verifyWindowsAuthenticodeSigners,
} from './windows-artifact-trust.js';
import {
  finalizeWindowsUpgradeTransaction,
  recoverWindowsUpgradeJournalBackup,
  recoverWindowsUpgradeTransaction,
} from './upgrade-transaction.js';
import {
  computePortForwardIdentityFingerprint,
  loadOrCreatePortForwardIdentity,
} from '../daemon/port-forward-crypto.js';
import {
  applyTrustedPeerPins,
  controlledNodePortForwardStateDir,
  PORT_FORWARD_IDENTITY_BASENAME,
  type TrustedPeerPinInput,
} from '../daemon/port-forward-trust-cli.js';

/** Install journal lives beside the credential in the protected directory. */
export function journalPathFor(credentialPath = defaultCredentialPath()): string {
  return join(dirname(credentialPath), 'install-journal.json');
}

function cleanupWindowsUpgradeTask(taskName: string): void {
  try {
    execFileSync(windowsSchtasksExecutablePath(), ['/Delete', '/TN', taskName, '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // A completed one-shot may already have removed itself.
  }
}

/**
 * Create + lock down the protected credential directory BEFORE any redeem.
 * Windows → SYSTEM/Administrators-only ACL; POSIX → dir `0700`.
 */
export async function prepareCredentialDir(credentialPath = defaultCredentialPath()): Promise<void> {
  const dir = dirname(credentialPath);
  if (process.platform === 'win32') {
    await secureWindowsCredentialDir(dir);
    return;
  }
  const { chmod, mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export interface ControlledNodeBootstrapDeps {
  abiProfile?: ControlledNodeAbiProfile;
  /** Validated enrollment blob supplied via `--enroll-stdin` (no executable trailer required). */
  enrollmentBlob?: EnrollmentBlob;
  loadCredential: () => Promise<ControlledNodeCredential | null>;
  openVerifiedEnrollmentSource: (executablePath?: string) => Promise<VerifiedEnrollmentSource>;
  loadInstallIdentity: () => Promise<PendingInstallIdentity | null>;
  persistInstallIdentity: (identity: PendingInstallIdentity) => Promise<void>;
  generateInstallIdentity: () => PendingInstallIdentity;
  redeemEnrollmentV2: (blob: EnrollmentBlob, identity: PendingInstallIdentity) => Promise<ControlledNodeCredential>;
  persistCredential: (credential: ControlledNodeCredential) => Promise<void>;
  /**
   * Optional authoritative server validity probe used ONLY during non-stable
   * installer re-runs when a fresh enrollment blob is present.
   */
  probeExistingCredential?: (credential: ControlledNodeCredential) => Promise<ControlledNodeCredentialProbeStatus>;
  /** Protected pending re-enrollment record lifecycle for idempotent crash recovery. */
  loadPendingReenrollment?: () => Promise<PendingReenrollmentRecord | null>;
  persistPendingReenrollment?: (record: PendingReenrollmentRecord) => Promise<void>;
  removePendingReenrollment?: () => Promise<void>;
  /** Cross-process exclusive lock wrapping credential/journal state transitions (released before startService). */
  withProcessLock?: <T>(fn: () => Promise<T>, credentialPath?: string) => Promise<T>;
  /** Inspect an already-staged executable receipt from disk during crash recovery. */
  inspectStagedReceipt?: (stagedPath: string) => Promise<StagedExecutableReceipt>;
  /** Isolate/reset server-endpoints cache when rotating credential or target server. */
  resetEndpointState?: (
    next: Pick<ControlledNodeCredential, 'serverId' | 'serverUrl'>,
    previous: Pick<ControlledNodeCredential, 'serverId' | 'serverUrl'>,
  ) => Promise<void>;
  installDefinition: (exePath: string) => Promise<ServiceReceipt>;
  inspectDefinition: (receipt: ServiceReceipt) => Promise<ServiceReceipt>;
  /**
   * Side-effect-free structured service inspection. SIDE-EFFECT-FREE: must NOT
   * call enable / start / bootout / kickstart / daemon-reload. Used both by
   * the stable runtime (as the `markServiceHealthy` gate) and the source path
   * (to decide whether repair is required). The bootstrap may compare the
   * result to the journal and route accordingly.
   */
  inspectServiceState: (receipt: ServiceReceipt) => Promise<import('./installer.js').ServiceInspection>;
  startService: (receipt: ServiceReceipt) => Promise<void>;
  verifyStagedExecutable: (receipt: StagedExecutableReceipt) => Promise<void>;
  isStableRuntime: (journal: InstallJournal) => Promise<boolean>;
  assertElevated: () => void | Promise<void>;
  ensureReleasePublisherTrust: (executablePath: string) => Promise<void>;
  /**
   * Content identity of the installer the human launched. Injected so the
   * bootstrap can be exercised without a real executable on disk; production
   * reads it from the same verified inspection the staging path uses.
   */
  inspectSourceArtifact: (executablePath: string) => Promise<SourceArtifactIdentity>;
  prepareCredentialDir: () => Promise<void>;
  loadInstallJournal: (path: string) => Promise<InstallJournal>;
  writeInstallPhase: typeof writeInstallPhase;
  journalPath: string;
  credentialPath: string;
  stagedExecutablePath: string;
  sourceExecutablePath: string;
  /** Optional owner-supplied relay-independent trusted peers (e.g. `--trust-peer`). */
  trustedPeers?: readonly TrustedPeerPinInput[];
  /** Explicit state directory for persistent port-forward Ed25519 identity & trusted peers. */
  portForwardStateDir?: string;
  now: number;
  warn: (message: string) => void;
  recoverInterruptedUpgrade?: (journal: InstallJournal) => Promise<{
    journal: InstallJournal;
    handoff: boolean;
    outcome: string;
  }>;
  recoverCorruptInstallJournal?: () => Promise<InstallJournal | null>;
}

export type BootstrapDisposition = 'handoff_complete' | 'pending_setup' | 'run_runtime';

export type BootstrapResult =
  | {
      credential: ControlledNodeCredential;
      disposition: 'handoff_complete' | 'run_runtime';
      journal: InstallJournal;
      /**
       * Set when the release publisher certificate could not be installed. The node
       * is enrolled and reachable; the native sidecars that require the trust
       * anchor will refuse to launch until it is.
       */
      publisherTrustError?: string;
      portForwardIdentityPublicKey?: string;
      portForwardIdentityFingerprint?: string;
    }
  | {
      credential: null;
      disposition: 'pending_setup';
      journal: InstallJournal;
      /**
       * Set when the release publisher certificate could not be installed. The node
       * is enrolled and reachable; the native sidecars that require the trust
       * anchor will refuse to launch until it is.
       */
      publisherTrustError?: string;
    };

/** Production deps wired to the real enrollment/installer/journal + fs. */
export function defaultBootstrapDeps(now: number): ControlledNodeBootstrapDeps {
  const credentialPath = defaultCredentialPath();
  const pendingReenrollmentPath = defaultPendingReenrollmentPath(credentialPath);
  const journalPath = journalPathFor(credentialPath);
  const sourceExecutablePath = process.execPath;
  return {
    loadCredential: () => loadCredential(credentialPath),
    openVerifiedEnrollmentSource: (executablePath = sourceExecutablePath) => openVerifiedEnrollmentSource(executablePath),
    loadInstallIdentity: () => loadInstallIdentity(defaultInstallIdentityPath(credentialPath)),
    persistInstallIdentity: (identity) => persistInstallIdentity(identity, defaultInstallIdentityPath(credentialPath)),
    generateInstallIdentity: () => ({ ...generateInstallIdentity(), sourceExePath: sourceExecutablePath }),
    redeemEnrollmentV2: (blob, identity) => redeemEnrollmentV2(blob, identity),
    persistCredential: (credential) => persistCredential(credential, credentialPath),
    probeExistingCredential: (credential) => probeControlledNodeCredentialStatus(credential),
    loadPendingReenrollment: () => loadPendingReenrollment(pendingReenrollmentPath),
    persistPendingReenrollment: (record) => persistPendingReenrollment(record, pendingReenrollmentPath),
    removePendingReenrollment: () => removePendingReenrollment(pendingReenrollmentPath),
    withProcessLock: (fn, lockCredentialPath = credentialPath) => withBootstrapProcessLock(lockCredentialPath, fn),
    inspectStagedReceipt: (stagedPath) => inspectExecutableReceipt(stagedPath, sourceExecutablePath),
    resetEndpointState: (next, previous) => resetEndpointStateForCredential(
      controlledNodeEndpointsPath(journalPath),
      previous,
      next,
      { allowLoopbackHttp: process.env.IMCODES_NODE_ALLOW_HTTP_ENROLL === '1' },
    ),
    installDefinition: (exePath) => installDefinition(exePath),
    inspectDefinition: (receipt) => inspectDefinition(receipt),
    inspectServiceState: (receipt) => inspectServiceState(receipt),
    startService: (receipt) => startService(receipt),
    verifyStagedExecutable: (receipt) => verifyStagedExecutableReceipt(receipt),
    isStableRuntime: (journal) => isCurrentExecutableStable(journal, sourceExecutablePath),
    inspectSourceArtifact: async (executablePath) => {
      const inspected = await inspectVerifiedExecutable(executablePath);
      return { sha256: inspected.sha256, size: inspected.size };
    },
    assertElevated: assertProcessElevated,
    ensureReleasePublisherTrust: async (executablePath) => {
      if (process.platform !== 'win32' || !/^[a-f0-9]{64}$/.test(WINDOWS_COMPILED_RELEASE_SIGNER_SHA256)) return;
      // Carry PowerShell's own reason. The script distinguishes six causes —
      // wrong signer, missing Code Signing EKU, store import refused, and so on
      // — and collapsing them into one sentence leaves the operator, and
      // whoever they forward it to, with nothing to act on.
      const trust = await installWindowsReleasePublisherTrust(executablePath);
      if (!trust.ok) {
        throw new Error(
          `Windows release publisher trust installation failed${trust.detail ? `: ${trust.detail}` : ''}`,
        );
      }
    },
    prepareCredentialDir: () => prepareCredentialDir(credentialPath),
    loadInstallJournal,
    writeInstallPhase,
    journalPath: journalPathFor(credentialPath),
    credentialPath,
    portForwardStateDir: controlledNodePortForwardStateDir(credentialPath),
    stagedExecutablePath: defaultStagedExecutablePath(),
    sourceExecutablePath,
    now,
    warn: (message) => process.stderr.write(`imcodes-node: ${message}\n`),
    recoverInterruptedUpgrade: async (journal) => {
      if (process.platform !== 'win32' || !journal.stagedReceipt) {
        return { journal, handoff: false, outcome: 'none' };
      }
      const schtasks = windowsSchtasksExecutablePath();
      return recoverWindowsUpgradeTransaction({
        journal,
        journalPath: journalPathFor(credentialPath),
        // The transaction governs the installed service image. During an
        // explicit reinstall `process.execPath` is the freshly downloaded
        // installer, not the image whose receipt may be stale.
        executablePath: journal.stagedReceipt.path,
        now,
        verifyTrustedExecutable: (path) => verifyWindowsAuthenticodeSigners(
          [path], WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
        ),
        resumeTask: (taskName) => {
          execFileSync(schtasks, ['/Run', '/TN', taskName], { windowsHide: true, stdio: 'ignore' });
        },
        cleanupTask: (taskName) => {
          cleanupWindowsUpgradeTask(taskName);
        },
      });
    },
    recoverCorruptInstallJournal: () => process.platform === 'win32'
      ? recoverWindowsUpgradeJournalBackup(journalPathFor(credentialPath))
      : Promise.resolve(null),
  };
}

/**
 * The phase label to write for a step that is being re-run as a repair.
 *
 * Phases are monotonic, so an enrolled or healthy machine re-running staging or
 * enrollment must not stamp the journal back down to that earlier label — the
 * journal refuses the backward transition and the repair dies. The step still
 * records its data; the label simply stays at the furthest point the install
 * has actually reached.
 */
function repairPhase(journal: Pick<InstallJournal, 'phase'>, step: InstallPhase): InstallPhase {
  return phaseIndex(journal.phase) > phaseIndex(step) ? journal.phase : step;
}

export async function isCurrentExecutableStable(
  journal: Pick<InstallJournal, 'stagedReceipt'>,
  sourceExecutablePath = process.execPath,
): Promise<boolean> {
  try {
    if (!journal.stagedReceipt) return false;
    const staged = await inspectVerifiedExecutable(journal.stagedReceipt.path);
    assertReceiptMatchesInspection(journal.stagedReceipt, staged);
    const current = await inspectVerifiedExecutable(sourceExecutablePath);
    if (samePosixFile(staged.identity, current.identity)) return true;
    return staged.realPath === current.realPath && current.sha256 === journal.stagedReceipt.sha256 && current.size === journal.stagedReceipt.size;
  } catch {
    return false;
  }
}

interface ExecutableInspection {
  realPath: string;
  size: number;
  sha256: string;
  identity: { dev?: number; ino?: number };
}

function samePosixFile(a: { dev?: number; ino?: number }, b: { dev?: number; ino?: number }): boolean {
  return a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined
    && a.dev === b.dev
    && a.ino === b.ino;
}

async function inspectVerifiedExecutable(path: string): Promise<ExecutableInspection> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('stable executable is not a regular file');
  const nofollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | nofollow);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error('stable executable is not a regular file');
    if (!sameFullIdentity(before, st)) throw new Error('stable executable identity changed');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < st.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, st.size - position), position);
      if (bytesRead <= 0) throw new Error('stable executable read ended early');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return {
      realPath: await realpath(path),
      size: st.size,
      sha256: hash.digest('hex'),
      identity: {
        ...(typeof st.dev === 'number' ? { dev: st.dev } : {}),
        ...(typeof st.ino === 'number' ? { ino: st.ino } : {}),
      },
    };
  } finally {
    await handle.close();
  }
}

function sameFullIdentity(a: { dev?: number; ino?: number; size: number; mtimeMs: number; ctimeMs: number }, b: { dev?: number; ino?: number; size: number; mtimeMs: number; ctimeMs: number }): boolean {
  const metadata = a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  if (a.dev !== undefined && b.dev !== undefined && a.ino !== undefined && b.ino !== undefined) {
    return a.dev === b.dev && a.ino === b.ino && metadata;
  }
  return metadata;
}

function assertReceiptMatchesInspection(receipt: StagedExecutableReceipt, inspected: ExecutableInspection): void {
  if (receipt.size !== inspected.size) throw new Error('stable executable size mismatch');
  if (receipt.sha256 !== inspected.sha256) throw new Error('stable executable hash mismatch');
}

export async function verifyStagedExecutableReceipt(receipt: StagedExecutableReceipt): Promise<void> {
  const inspected = await inspectVerifiedExecutable(receipt.path);
  assertReceiptMatchesInspection(receipt, inspected);
}

/**
 * Install publisher trust, but never let its failure cost the machine.
 *
 * The trust anchor gates native sidecars — the remote-desktop worker and the
 * Computer Use helper both re-verify the signer before launching. It does not
 * gate enrolment, terminal access, exec or file transfer.
 *
 * Refusing to enrol on a trust failure therefore trades a degraded node for an
 * unreachable one: the operator cannot open a session to inspect the group
 * policy or antivirus that blocked the import, and on a machine in another
 * building there is no second channel to fix it from. That is the deadlock this
 * product exists to remove, so the failure is reported and carried instead of
 * thrown. The stable-runtime path already reasoned this way; the install paths
 * now agree with it.
 */
async function tryReleasePublisherTrust(
  deps: ControlledNodeBootstrapDeps,
  context: string,
): Promise<string | undefined> {
  try {
    await deps.ensureReleasePublisherTrust(deps.sourceExecutablePath);
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.warn(`${context}: ${detail}`);
    return detail;
  }
}

async function ensureElevated(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
): Promise<InstallJournal> {
  await deps.assertElevated();
  if (phaseIndex(journal.phase) >= phaseIndex('elevated')) return journal;
  return deps.writeInstallPhase(deps.journalPath, 'elevated', {
    now: deps.now,
    previous: journal,
  });
}

async function loadJournalOrThrow(deps: ControlledNodeBootstrapDeps): Promise<InstallJournal> {
  try {
    return await deps.loadInstallJournal(deps.journalPath);
  } catch (err) {
    if (err instanceof InstallJournalCorruptError) {
      const recovered = await deps.recoverCorruptInstallJournal?.();
      if (recovered) {
        deps.warn('controlled node restored a validated install-journal backup after an interrupted upgrade');
        return recovered;
      }
      throw new Error('controlled node install journal is corrupt; refusing to continue — manual recovery required');
    }
    throw err;
  }
}

interface ResolvedEnrollmentSource {
  blob: EnrollmentBlob;
  trailerStart: number;
  windowsAuthenticode?: EnrollmentTrailerRange['windowsAuthenticode'];
}

async function resolveEnrollmentSource(
  deps: ControlledNodeBootstrapDeps,
  source: VerifiedEnrollmentSource,
): Promise<ResolvedEnrollmentSource | null> {
  const trailerRange = await source.readEnrollmentBlobWithRange();
  if (deps.enrollmentBlob) {
    // Stdin-enrolled installers download an unmodified executable without a trailer;
    // stage [0..statSize) directly, or [0..trailerStart) if a trailer is also present.
    const trailerStart = trailerRange ? trailerRange.trailerStart : await source.statSize();
    return {
      blob: deps.enrollmentBlob,
      trailerStart,
      windowsAuthenticode: trailerRange?.windowsAuthenticode,
    };
  }
  return trailerRange;
}

async function ensureIdentityPrepared(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  blob: EnrollmentBlob,
): Promise<{ journal: InstallJournal; identity: PendingInstallIdentity }> {
  assertProductionServerUrl(blob.serverUrl);
  await deps.prepareCredentialDir();
  let identity = await deps.loadInstallIdentity();
  const identityAlreadyRequired = phaseIndex(journal.phase) >= phaseIndex('credential_prepared');
  if (!identity && identityAlreadyRequired) {
    throw new Error('controlled node install journal requires a durable install identity; manual recovery required');
  }
  if (!identity) {
    identity = deps.generateInstallIdentity();
    identity.sourceExePath = deps.sourceExecutablePath;
    await deps.persistInstallIdentity(identity);
  }
  if (journal.installId !== undefined && journal.installId !== identity.installId) {
    throw new Error('controlled node install identity does not match journal installId');
  }
  if (journal.nodeTokenHash !== undefined && journal.nodeTokenHash !== identity.nodeTokenHash) {
    throw new Error('controlled node install identity does not match journal nodeTokenHash');
  }

  // Identify the installer the human launched by its CONTENT. The path it was
  // downloaded to legitimately differs on a retry; the bytes do not. This exe
  // has already passed release publisher trust and verified-source checks
  // before reaching here, so the digest below is taken from a trusted artifact.
  const sourceArtifact = await deps.inspectSourceArtifact(deps.sourceExecutablePath);

  // P0-1. Compare the running executable against the pinned artifact on EVERY
  // boot, before any phase advances, whether or not the path changed.
  //
  // Checking only when the path moved left the worst case open: drop different
  // bytes at the SAME path the journal already trusts and nothing ever looked.
  // The path is not the identity; these bytes are.
  if (journal.sourceArtifact !== undefined
    && (journal.sourceArtifact.sha256 !== sourceArtifact.sha256
      || journal.sourceArtifact.size !== sourceArtifact.size)) {
    throw new Error('controlled node install source executable does not match the journal source artifact');
  }

  // A journal written before `sourceArtifact` existed carries no content
  // identity yet. Adopt one — but only inside the pre-enrollment retry window,
  // and only here, after publisher trust and the verified enrollment source
  // have already vouched for these bytes. From `enrolled` onwards nothing is
  // adopted: an unpinned journal stays unpinned rather than being pinned to
  // whatever happens to be running now.
  const adoptingLegacyArtifact = journal.sourceArtifact === undefined
    && phaseIndex(journal.phase) >= phaseIndex('credential_prepared')
    && phaseIndex(journal.phase) <= phaseIndex('files_staged');
  const migratingSourcePath = journal.sourceExePath !== undefined
    && journal.sourceExePath !== deps.sourceExecutablePath;

  // P0-2. The JOURNAL is the single authority for the source path.
  //
  // The journal is written and fsynced first; the durable identity is a cache
  // of it. A crash in between used to leave the journal on the new path and the
  // identity on the old one with nothing to reconcile them. Now the next boot
  // simply re-derives the identity from the journal, which is idempotent, can
  // only move forward, and needs no separate recovery mode.
  if (migratingSourcePath || adoptingLegacyArtifact) {
    journal = await deps.writeInstallPhase(deps.journalPath, journal.phase, {
      now: deps.now,
      previous: journal,
      sourceExePath: deps.sourceExecutablePath,
      sourceArtifact,
    });
  }
  if (journal.sourceExePath !== undefined && identity.sourceExePath !== journal.sourceExePath) {
    // Converge the cache onto the authority. Reached both in the same boot as
    // the write above and on any later boot that finds the pair torn.
    identity.sourceExePath = journal.sourceExePath;
    await deps.persistInstallIdentity(identity);
  }

  if (phaseIndex(journal.phase) < phaseIndex('credential_prepared')) {
    journal = await deps.writeInstallPhase(deps.journalPath, 'credential_prepared', {
      now: deps.now,
      previous: journal,
      ...((deps.abiProfile ?? CONTROLLED_NODE_RUNTIME_ABI_PROFILE) !== CONTROLLED_NODE_ABI_MODERN
        ? { abiProfile: deps.abiProfile ?? CONTROLLED_NODE_RUNTIME_ABI_PROFILE } : {}),
      installId: identity.installId,
      nodeTokenHash: identity.nodeTokenHash,
      sourceExePath: identity.sourceExePath,
      sourceArtifact,
    });
  }
  return { journal, identity };
}

async function ensureExecutableStaged(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  resolved: Pick<ResolvedEnrollmentSource, 'trailerStart' | 'windowsAuthenticode'>,
  source: VerifiedEnrollmentSource,
): Promise<InstallJournal> {
  if (phaseIndex(journal.phase) >= phaseIndex('files_staged') && journal.stagedExePath) {
    if (!journal.stagedReceipt) throw new Error('controlled node staged executable receipt is missing; manual recovery required');
    if (journal.stagedReceipt.path !== journal.stagedExePath) {
      throw new Error('controlled node staged executable receipt path mismatch; manual recovery required');
    }
    // The receipt resumes an interrupted staging of THIS package; it is not an
    // upgrade gate. A staged copy that no longer matches it means the receipt is
    // stale -- the node replaced its own image, or an operator swapped the file
    // -- not that the machine is unrecoverable. Re-stage from this installer's
    // signature-verified bytes instead of stranding the operator with a failure
    // that no reinstall can clear, which is exactly the deadlock this product
    // exists to remove.
    try {
      await deps.verifyStagedExecutable(journal.stagedReceipt);
      return journal;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.warn(`staged executable no longer matches its install receipt (${detail}); re-staging from this package`);
    }
  }
  const stagedReceipt: StagedExecutableReceipt = await source.stageTrailerFreeExecutable(
    deps.stagedExecutablePath,
    resolved.trailerStart,
    resolved.windowsAuthenticode,
  );
  // Record the refreshed receipt at the phase the install is ALREADY in.
  //
  // Re-staging is a repair, not a rewind. An enrolled or healthy machine whose
  // service copy drifted still needs a fresh receipt, but forcing the label
  // back to `files_staged` is a backward transition the journal rightly
  // refuses — which left exactly those machines with no way back. The staged
  // target is still pinned, so this refreshes the bytes at that target and
  // nothing else.
  const restagePhase = phaseIndex(journal.phase) > phaseIndex('files_staged')
    ? journal.phase
    : 'files_staged';
  return deps.writeInstallPhase(deps.journalPath, restagePhase, {
    now: deps.now,
    previous: journal,
    stagedExePath: deps.stagedExecutablePath,
    stagedReceipt,
    sourceExePath: deps.sourceExecutablePath,
  });
}

async function ensureEnrolled(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  blob: EnrollmentBlob,
  identity: PendingInstallIdentity,
): Promise<{ journal: InstallJournal; credential: ControlledNodeCredential }> {
  const existing = await deps.loadCredential();
  if (existing) return { journal, credential: existing };

  const recovering = phaseIndex(journal.phase) >= phaseIndex('enrolled');
  if (recovering && !identity) {
    throw new Error('controlled node install journal is enrolled but install identity is missing; manual recovery required');
  }

  const credential = await deps.redeemEnrollmentV2(blob, identity);
  try {
    await deps.persistCredential(credential);
  } catch (err) {
    if (!recovering) {
      await deps.writeInstallPhase(deps.journalPath, repairPhase(journal, 'enrolled'), {
        now: deps.now,
        previous: journal,
        installId: identity.installId,
        nodeTokenHash: identity.nodeTokenHash,
        serverId: credential.serverId,
        stagedExePath: journal.stagedExePath ?? deps.stagedExecutablePath,
        sourceExePath: identity.sourceExePath,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.warn(`enrolled but failed to persist credential (${message}); will retry with same install identity`);
    throw new Error(`controlled node redeemed enrollment but could not persist its credential (${message}); retry with same install identity`);
  }

  // The downloaded package is a permanent multi-use installer. Preserve its
  // reusable trailer after successful enrollment; only the protected stable
  // service copy is trailer-free. Existing journals keep their historical
  // cleanup observation, while new installs record an intentional skip.
  const cleanupStatus = journal.cleanupStatus && journal.cleanupStatus !== 'pending'
    ? journal.cleanupStatus
    : 'skipped';

  journal = await deps.writeInstallPhase(deps.journalPath, repairPhase(journal, 'enrolled'), {
    now: deps.now,
    previous: journal,
    installId: identity.installId,
    nodeTokenHash: identity.nodeTokenHash,
    serverId: credential.serverId,
    stagedExePath: journal.stagedExePath ?? deps.stagedExecutablePath,
    sourceExePath: identity.sourceExePath,
    cleanupStatus,
  });
  return { journal, credential };
}

async function ensureServiceRegistered(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
): Promise<InstallJournal> {
  if (phaseIndex(journal.phase) >= phaseIndex('files_staged')) {
    if (!journal.stagedReceipt) {
      throw new Error('controlled node staged executable receipt is missing; manual recovery required');
    }
    // Report drift, never refuse on it. This runs on the service's own start
    // path too, so throwing here turns a stale receipt into a crash loop on a
    // machine that is otherwise serving fine -- and the installer, the one
    // repair a person has, is re-staged before it ever reaches this point.
    try {
      await deps.verifyStagedExecutable(journal.stagedReceipt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.warn(`staged executable no longer matches its install receipt (${detail}); continuing with the image on disk`);
    }
  }
  const stagedPath = journal.stagedExePath ?? deps.stagedExecutablePath;
  if (phaseIndex(journal.phase) >= phaseIndex('service_registered') && journal.serviceName) {
    let serviceReceipt = journal.serviceReceipt;
    if (serviceReceipt && (!serviceReceipt.action || serviceReceipt.action === stagedPath)) {
      try {
        serviceReceipt = await deps.inspectDefinition(serviceReceipt);
        return journal;
      } catch {
        serviceReceipt = undefined;
      }
    }
    serviceReceipt = await deps.inspectDefinition(await deps.installDefinition(stagedPath));
    return deps.writeInstallPhase(deps.journalPath, journal.phase, {
      now: Math.max(deps.now, journal.updatedAt),
      previous: journal,
      serviceName: serviceReceipt.name,
      serviceReceipt,
      stagedExePath: stagedPath,
    });
  }
  const serviceReceipt = await deps.inspectDefinition(await deps.installDefinition(stagedPath));
  return deps.writeInstallPhase(deps.journalPath, repairPhase(journal, 'service_registered'), {
    now: deps.now,
    previous: journal,
    serviceName: serviceReceipt.name,
    serviceReceipt,
    stagedExePath: stagedPath,
  });
}

function receiptFromJournal(journal: InstallJournal): ServiceReceipt {
  if (journal.serviceReceipt) return journal.serviceReceipt;
  if (!journal.serviceName) throw new Error('controlled node service is not registered');
  return { name: journal.serviceName, platform: process.platform };
}

function isHealthyServiceInspection(
  inspection: import('./installer.js').ServiceInspection,
  receipt: ServiceReceipt,
): boolean {
  const expectedPrincipal = receipt.platform === 'win32' ? 'S-1-5-18' : 'root';
  const expectedRestartPolicy = receipt.platform === 'darwin' ? 'keepalive' : 'on-failure';
  return inspection.installed
    && inspection.definitionMatches
    // The service MANAGER must actually have the receipt's action loaded. A
    // rewritten on-disk definition the manager never reloaded (disk matches the
    // receipt, but the manager still runs the OLD action) is NOT healthy.
    && inspection.loadedActionMatches
    && inspection.loaded
    && inspection.bootEnabled
    && inspection.principal === expectedPrincipal
    && inspection.restartPolicy === expectedRestartPolicy
    && inspection.runState === 'running'
    && inspection.errors.length === 0;
}

/**
 * Stable-owner reconciliation may repair durable persistence but MUST NOT
 * start/restart/bootout/kickstart the service that owns this process.
 */
async function reconcileStableServicePersistence(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
): Promise<InstallJournal> {
  const receipt = receiptFromJournal(journal);
  let inspection = await deps.inspectServiceState(receipt).catch(() => null);
  if (inspection && isHealthyServiceInspection(inspection, receipt)) return journal;

  const stagedPath = journal.stagedExePath ?? deps.stagedExecutablePath;
  const repairedReceipt = await deps.installDefinition(stagedPath);
  inspection = await deps.inspectServiceState(repairedReceipt).catch(() => null);
  journal = await deps.writeInstallPhase(deps.journalPath, journal.phase, {
    now: Math.max(deps.now, journal.updatedAt),
    previous: journal,
    serviceName: repairedReceipt.name,
    serviceReceipt: repairedReceipt,
    stagedExePath: stagedPath,
  });
  if (!inspection || !isHealthyServiceInspection(inspection, repairedReceipt)) {
    deps.warn('stable service persistence remains unverified after durable definition repair; refusing service_healthy until a fresh inspection passes');
  }
  if (repairedReceipt.platform === 'linux') {
    // An already-running process launched by the legacy unit has no
    // NOTIFY_SOCKET, even after daemon-reload. Exit non-zero only after the new
    // definition + receipt are durable; the legacy Restart=on-failure policy
    // then starts this executable under the watchdog-enabled unit.
    throw new Error('controlled node Linux watchdog definition repaired; restarting under systemd supervision');
  }
  return journal;
}

function normalizeServerOriginForCompare(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin.toLowerCase();
  } catch {
    return serverUrl.trim().replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * Stage this installer's own executable over the stable copy, unconditionally.
 *
 * Not the resume shortcut: a person who re-runs the installer is asking for
 * these bytes to be the ones that run, so a receipt that happens to still match
 * is not a reason to keep an older image.
 */
async function restageWithResolvedSource(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  resolved: ResolvedEnrollmentSource,
  source: VerifiedEnrollmentSource,
): Promise<InstallJournal> {
  const stagedReceipt = await source.stageTrailerFreeExecutable(
    deps.stagedExecutablePath,
    resolved.trailerStart,
    resolved.windowsAuthenticode,
  );
  // Re-running the same package restages identical bytes. Rewriting the
  // journal for that would churn the phase log and blur the one-phase-at-a-
  // time crash-recovery reasoning for no gain.
  const previous = journal.stagedReceipt;
  if (previous
    && previous.path === stagedReceipt.path
    && previous.size === stagedReceipt.size
    && previous.sha256 === stagedReceipt.sha256) {
    return journal;
  }
  return deps.writeInstallPhase(deps.journalPath, journal.phase, {
    now: Math.max(deps.now, journal.updatedAt),
    previous: journal,
    stagedExePath: deps.stagedExecutablePath,
    stagedReceipt,
  });
}

function ensureBootstrapPortForwardTrust(
  deps: ControlledNodeBootstrapDeps,
): { portForwardIdentityPublicKey?: string; portForwardIdentityFingerprint?: string } {
  if (!deps.portForwardStateDir) return {};
  try {
    const kp = loadOrCreatePortForwardIdentity(join(deps.portForwardStateDir, PORT_FORWARD_IDENTITY_BASENAME));
    if (deps.trustedPeers && deps.trustedPeers.length > 0) {
      applyTrustedPeerPins(deps.portForwardStateDir, deps.trustedPeers);
    }
    return {
      portForwardIdentityPublicKey: kp.publicKeyB64,
      portForwardIdentityFingerprint: computePortForwardIdentityFingerprint(kp.publicKeyB64),
    };
  } catch (err) {
    if (deps.trustedPeers && deps.trustedPeers.length > 0) throw err;
    return {};
  }
}

interface BootstrapLockedOutcome {
  result: BootstrapResult;
  deferredStartReceipt?: ServiceReceipt;
}

const BOOTSTRAP_LOCK_TIMEOUT_MS = 30_000;

function isSqliteBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  return (code === 'ERR_SQLITE_ERROR' && /database is locked|SQLITE_BUSY/i.test(msg))
    || /database is locked|SQLITE_BUSY/i.test(msg);
}

async function runSqliteLockSqlBounded(
  db: { exec: (sql: string) => void },
  sql: string,
  deadline: number,
  timeoutMessage: string,
): Promise<void> {
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(timeoutMessage);
    }
    try {
      db.exec(sql);
      return;
    } catch (err) {
      if (!isSqliteBusyError(err)) throw err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(timeoutMessage);
      }
      const jitter = 5 + Math.floor(Math.random() * 11);
      await new Promise((resolve) => setTimeout(resolve, Math.min(jitter, remaining)));
    }
  }
}

async function assertLockPathSafe(lockPath: string): Promise<void> {
  try {
    const st = await lstat(lockPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`controlled node bootstrap lock path is unsafe: ${lockPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

async function withExclusivePidLockFile<T>(
  lockFilePath: string,
  deadline: number,
  fn: () => Promise<T>,
): Promise<T> {
  while (true) {
    await assertLockPathSafe(lockFilePath);
    try {
      const handle = await open(lockFilePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } finally {
        await handle.close();
      }
      try {
        return await fn();
      } finally {
        await unlink(lockFilePath).catch(() => {});
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw err;
      try {
        const raw = await readFile(lockFilePath, 'utf8');
        const parsed = JSON.parse(raw) as { pid?: unknown };
        if (typeof parsed.pid === 'number' && !isPidAlive(parsed.pid)) {
          await unlink(lockFilePath).catch(() => {});
          continue;
        }
      } catch {
        // Concurrent creator/unlinker; wait until deadline.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out acquiring controlled node bootstrap lock: ${lockFilePath}`);
      }
      const jitter = 5 + Math.floor(Math.random() * 11);
      await new Promise((resolve) => setTimeout(resolve, Math.min(jitter, remaining)));
    }
  }
}

/**
 * Acquire an OS-kernel exclusive cross-process lock via SQLite `BEGIN IMMEDIATE`
 * on `<stateDir>/install-bootstrap.lock.db` (automatically released by the kernel
 * on crash/SIGKILL), falling back cleanly to `O_CREAT | O_EXCL` only on legacy
 * runtimes lacking `node:sqlite`.
 */
export async function withBootstrapProcessLock<T>(
  credentialPath: string,
  fn: () => Promise<T>,
  options: { lockTimeoutMs?: number } = {},
): Promise<T> {
  const dir = dirname(credentialPath);
  const dirMode = process.platform === 'linux' && dir === '/var/lib/imcodes-node' ? 0o755 : 0o700;
  await mkdir(dir, { recursive: true, mode: dirMode });
  const lockDbPath = join(dir, 'install-bootstrap.lock.db');
  await assertLockPathSafe(lockDbPath);

  const timeoutMs = Math.max(1, Math.floor(options.lockTimeoutMs ?? BOOTSTRAP_LOCK_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;

  let DatabaseSyncCtor: typeof import('node:sqlite')['DatabaseSync'] | null = null;
  try {
    suppressSqliteExperimentalWarning();
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch {
    DatabaseSyncCtor = null;
  }

  if (!DatabaseSyncCtor) {
    return withExclusivePidLockFile(`${lockDbPath}.pid`, deadline, fn);
  }

  const db = new DatabaseSyncCtor(lockDbPath);
  let inTx = false;
  try {
    db.exec('PRAGMA busy_timeout = 0;');
    await runSqliteLockSqlBounded(
      db,
      'BEGIN IMMEDIATE;',
      deadline,
      `Timed out acquiring controlled node bootstrap lock: ${lockDbPath}`,
    );
    inTx = true;
    // Mutex-only transaction: zero SQLite writes occur inside `fn()`, so once
    // `BEGIN IMMEDIATE` succeeds, release in `finally` via `ROLLBACK` without
    // reusing the acquisition deadline against work duration inside `fn()`.
    return await fn();
  } finally {
    if (inTx) {
      try {
        db.exec('ROLLBACK;');
      } catch { /* ignore rollback error */ }
    }
    try {
      db.close();
    } catch { /* ignore close error */ }
  }
}

async function computeCandidateStagedDigest(
  source: VerifiedEnrollmentSource,
  stagedExecutablePath: string,
  trailerStart: number,
): Promise<PendingReenrollmentRecord['candidateStaged'] | undefined> {
  if (trailerStart <= 0) return undefined;
  const hash = createHash('sha256');
  const chunkSize = 64 * 1024;
  let offset = 0;
  while (offset < trailerStart) {
    const len = Math.min(chunkSize, trailerStart - offset);
    const chunk = await source.readExactly(offset, len);
    if (chunk.length !== len) return undefined;
    hash.update(chunk);
    offset += len;
  }
  return {
    path: stagedExecutablePath,
    sha256: hash.digest('hex'),
    size: trailerStart,
  };
}

async function isRunningFromStagedExecutablePath(deps: ControlledNodeBootstrapDeps): Promise<boolean> {
  if (deps.sourceExecutablePath === deps.stagedExecutablePath) return true;
  try {
    const [srcReal, stagedReal] = await Promise.all([
      realpath(deps.sourceExecutablePath),
      realpath(deps.stagedExecutablePath),
    ]);
    return srcReal === stagedReal;
  } catch {
    return false;
  }
}

async function inspectRecoveredStagedReceipt(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  record: PendingReenrollmentRecord,
): Promise<StagedExecutableReceipt | undefined> {
  const inspectFn = deps.inspectStagedReceipt
    ?? ((p: string) => inspectExecutableReceipt(p, deps.sourceExecutablePath));
  try {
    const inspected = await inspectFn(deps.stagedExecutablePath);
    if (record.stagedReceipt || record.candidateStaged) {
      const matchesCandidate = Boolean(
        record.candidateStaged
        && inspected.sha256 === record.candidateStaged.sha256
        && inspected.size === record.candidateStaged.size,
      );
      const matchesPendingReceipt = Boolean(
        record.stagedReceipt
        && inspected.sha256 === record.stagedReceipt.sha256
        && inspected.size === record.stagedReceipt.size,
      );
      const matchesJournal = Boolean(
        journal.stagedReceipt
        && inspected.sha256 === journal.stagedReceipt.sha256
        && inspected.size === journal.stagedReceipt.size,
      );
      if (!matchesCandidate && !matchesPendingReceipt && !matchesJournal) {
        throw new Error('controlled node staged executable does not match pending reenrollment or journal receipt');
      }
    }
    return inspected;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return record.stagedReceipt;
    }
    throw err;
  }
}

async function commitPendingReenrollment(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  existing: ControlledNodeCredential,
  record: PendingReenrollmentRecord,
  newCredential: ControlledNodeCredential,
  resolved: ResolvedEnrollmentSource | null,
  source: VerifiedEnrollmentSource | null,
  publisherTrustError: string | undefined,
  options: { startService?: boolean; disposition?: 'handoff_complete' | 'run_runtime' } = {},
): Promise<BootstrapLockedOutcome> {
  let sourceArtifact: SourceArtifactIdentity | undefined = record.sourceArtifact;
  let stagedReceipt: StagedExecutableReceipt | undefined;
  let updatedRecord = record;
  if (resolved && source) {
    sourceArtifact = sourceArtifact ?? await deps.inspectSourceArtifact(deps.sourceExecutablePath);
    const candidateStaged = !resolved.windowsAuthenticode
      ? await computeCandidateStagedDigest(source, deps.stagedExecutablePath, resolved.trailerStart)
      : undefined;
    updatedRecord = {
      ...updatedRecord,
      ...(sourceArtifact ? { sourceArtifact } : {}),
      ...(candidateStaged ? { candidateStaged } : {}),
    };
    await deps.persistPendingReenrollment?.(updatedRecord);
    stagedReceipt = await source.stageTrailerFreeExecutable(
      deps.stagedExecutablePath,
      resolved.trailerStart,
      resolved.windowsAuthenticode,
    );
    updatedRecord = {
      ...updatedRecord,
      stagedReceipt,
      candidateStaged: {
        path: stagedReceipt.path,
        sha256: stagedReceipt.sha256,
        size: stagedReceipt.size,
      },
    };
    await deps.persistPendingReenrollment?.(updatedRecord);
  } else {
    stagedReceipt = await inspectRecoveredStagedReceipt(deps, journal, updatedRecord);
  }
  const previousEndpointTarget = {
    serverId: updatedRecord.previousServerId ?? existing.serverId,
    serverUrl: updatedRecord.previousServerUrl ?? existing.serverUrl,
  };
  await deps.resetEndpointState?.(newCredential, previousEndpointTarget);
  await deps.prepareCredentialDir();
  await deps.persistInstallIdentity(updatedRecord.identity);
  await deps.persistCredential(newCredential);

  const cleanupStatus = journal.cleanupStatus && journal.cleanupStatus !== 'pending'
    ? journal.cleanupStatus
    : 'skipped';
  journal = await deps.writeInstallPhase(deps.journalPath, repairPhase(journal, 'enrolled'), {
    now: Math.max(deps.now, journal.updatedAt),
    previous: journal,
    installId: updatedRecord.identity.installId,
    nodeTokenHash: updatedRecord.identity.nodeTokenHash,
    serverId: newCredential.serverId,
    stagedExePath: journal.stagedExePath ?? deps.stagedExecutablePath,
    ...(stagedReceipt ? { stagedReceipt } : {}),
    sourceExePath: updatedRecord.identity.sourceExePath,
    ...(sourceArtifact ? { sourceArtifact } : {}),
    cleanupStatus,
    allowIdentityRotation: true,
  });
  await deps.removePendingReenrollment?.();
  const pfTrust = ensureBootstrapPortForwardTrust(deps);
  const serviceStep = await prepareServiceStartRequested(deps, journal, {
    startService: options.startService,
  });
  journal = serviceStep.journal;
  if (options.startService === false && options.disposition === 'run_runtime') {
    journal = await reconcileStableServicePersistence(deps, journal);
  }
  return {
    result: {
      credential: newCredential,
      disposition: options.disposition ?? 'handoff_complete',
      journal,
      publisherTrustError,
      ...pfTrust,
    },
    ...(serviceStep.deferredStartReceipt ? { deferredStartReceipt: serviceStep.deferredStartReceipt } : {}),
  };
}

function isDefinitiveRedeemRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^enrollment_redeem_failed:(\d{3})(?::|$)/.exec(message);
  if (match) {
    const status = Number(match[1]);
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
  return message === 'enrollment_abi_profile_mismatch'
    || message === 'enrollment_server_url_invalid'
    || message === 'enrollment_server_url_must_be_origin'
    || message === 'enrollment_server_url_must_be_https';
}

async function reenrollExistingInstallation(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  existing: ControlledNodeCredential,
  resolved: ResolvedEnrollmentSource,
  source: VerifiedEnrollmentSource,
  abiProfile: ControlledNodeAbiProfile,
  existingPending: PendingReenrollmentRecord | null,
  publisherTrustError: string | undefined,
): Promise<BootstrapLockedOutcome> {
  assertProductionServerUrl(resolved.blob.serverUrl);
  // Read-only source inspection BEFORE redeem; never overwrite the formal
  // staged executable until redeemEnrollmentV2 succeeds so a failed redeem
  // keeps isCurrentExecutableStable === true for the healthy existing service.
  const sourceArtifact = await deps.inspectSourceArtifact(deps.sourceExecutablePath);
  await deps.prepareCredentialDir();

  const targetOrigin = normalizeServerOriginForCompare(resolved.blob.serverUrl);
  const enrollTokenHash = hashEnrollmentToken(resolved.blob.enrollToken);
  const reusePending = Boolean(
    existingPending
    && !existingPending.redeemedCredential
    && existingPending.targetOrigin === targetOrigin
    && existingPending.enrollTokenHash === enrollTokenHash
    && normalizeControlledNodeAbiProfile(existingPending.abiProfile) === abiProfile,
  );
  let record: PendingReenrollmentRecord = reusePending && existingPending
    ? {
      ...existingPending,
      ...(existingPending.sourceArtifact ? {} : { sourceArtifact }),
      ...(existingPending.pendingBlob ? {} : { pendingBlob: resolved.blob }),
    }
    : {
      version: 1,
      targetOrigin,
      enrollTokenHash,
      abiProfile,
      identity: {
        ...deps.generateInstallIdentity(),
        sourceExePath: deps.sourceExecutablePath,
      },
      previousServerId: existing.serverId,
      previousServerUrl: existing.serverUrl,
      pendingBlob: resolved.blob,
      sourceArtifact,
      createdAt: Math.max(deps.now, journal.updatedAt),
    };
  if (!reusePending || !existingPending?.sourceArtifact || !existingPending?.pendingBlob) {
    await deps.persistPendingReenrollment?.(record);
  }

  let newCredential: ControlledNodeCredential;
  try {
    newCredential = await deps.redeemEnrollmentV2(resolved.blob, record.identity);
  } catch (err) {
    if (isDefinitiveRedeemRejection(err)) {
      await deps.removePendingReenrollment?.().catch(() => {});
    }
    throw err;
  }
  record = { ...record, redeemedCredential: newCredential, pendingBlob: undefined, sourceArtifact };
  await deps.persistPendingReenrollment?.(record);

  return commitPendingReenrollment(
    deps,
    journal,
    existing,
    record,
    newCredential,
    resolved,
    source,
    publisherTrustError,
    { startService: true, disposition: 'handoff_complete' },
  );
}

async function prepareServiceStartRequested(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  options: { startService?: boolean } = {},
): Promise<{ journal: InstallJournal; deferredStartReceipt?: ServiceReceipt }> {
  journal = await ensureServiceRegistered(deps, journal);
  const receipt = receiptFromJournal(journal);
  if (phaseIndex(journal.phase) < phaseIndex('service_start_requested')) {
    journal = await deps.writeInstallPhase(deps.journalPath, repairPhase(journal, 'service_start_requested'), {
      now: deps.now,
      previous: journal,
      serviceStartRequestedAt: deps.now,
      serviceName: receipt.name,
      serviceReceipt: receipt,
    });
  }
  return {
    journal,
    ...(options.startService !== false ? { deferredStartReceipt: receipt } : {}),
  };
}

/**
 * Resolve the controlled-node credential through the journaled install flow.
 * Returns the credential to start the runtime with, or throws (caller stops).
 *
 * On the service-registered / service-start-requested paths, the bootstrap
 * calls `inspectServiceState` (SIDE-EFFECT-FREE) to verify the service is
 * actually installed AND running with the same definition the journal pinned.
 * The stable runtime MUST NOT call startService (that would kickstart a
 * second instance or kill the current connection); the source path may
 * repair on drift but must NOT lie about persistence.
 */
function isCredentialAclDriftError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('windows_credential_acl_insecure:') || message === 'credential_permissions_insecure';
}

const bootstrapSerialQueues = new Map<string, Promise<void>>();

async function withBootstrapSerialLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = bootstrapSerialQueues.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const next = prev.then(() => gate, () => gate);
  bootstrapSerialQueues.set(lockKey, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (bootstrapSerialQueues.get(lockKey) === next) {
      bootstrapSerialQueues.delete(lockKey);
    }
  }
}

export async function bootstrapControlledNodeWithDisposition(deps: ControlledNodeBootstrapDeps): Promise<BootstrapResult> {
  const lockKey = `${deps.credentialPath}\0${deps.journalPath}`;
  const runLocked = () => bootstrapControlledNodeWithDispositionLocked(deps);
  const { result, deferredStartReceipt } = await withBootstrapSerialLock(
    lockKey,
    () => (deps.withProcessLock ? deps.withProcessLock(runLocked, deps.credentialPath) : runLocked()),
  );
  if (deferredStartReceipt) {
    await deps.startService(deferredStartReceipt);
  }
  return result;
}

async function bootstrapControlledNodeWithDispositionLocked(deps: ControlledNodeBootstrapDeps): Promise<BootstrapLockedOutcome> {
  const abiProfile = deps.abiProfile ?? CONTROLLED_NODE_RUNTIME_ABI_PROFILE;
  let existing: ControlledNodeCredential | null;
  let preloadedJournal: InstallJournal | null = null;
  try {
    existing = await deps.loadCredential();
  } catch (error) {
    if (!isCredentialAclDriftError(error)) throw error;
    preloadedJournal = await loadJournalOrThrow(deps);
    if (await deps.isStableRuntime(preloadedJournal)) throw error;
    if (deps.enrollmentBlob && normalizeControlledNodeAbiProfile(deps.enrollmentBlob.abiProfile) !== abiProfile) {
      throw new Error('controlled node stdin enrollment ABI profile does not match the executable');
    }
    if (phaseIndex(preloadedJournal.phase) >= phaseIndex('credential_prepared')
      && normalizeControlledNodeAbiProfile(preloadedJournal.abiProfile) !== abiProfile) {
      throw new Error('controlled node persisted ABI profile does not match the executable');
    }
    preloadedJournal = await ensureElevated(deps, preloadedJournal);
    await deps.prepareCredentialDir();
    deps.warn('controlled node repaired credential directory ACL after drift during reinstall');
    existing = await deps.loadCredential();
  }
  let journal = preloadedJournal ?? await loadJournalOrThrow(deps);
  if (deps.enrollmentBlob && normalizeControlledNodeAbiProfile(deps.enrollmentBlob.abiProfile) !== abiProfile) {
    throw new Error('controlled node stdin enrollment ABI profile does not match the executable');
  }
  if ((existing && normalizeControlledNodeAbiProfile(existing.abiProfile) !== abiProfile)
    || (phaseIndex(journal.phase) >= phaseIndex('credential_prepared')
      && normalizeControlledNodeAbiProfile(journal.abiProfile) !== abiProfile)) {
    throw new Error('controlled node persisted ABI profile does not match the executable');
  }
  if (existing && deps.recoverInterruptedUpgrade) {
    const recovery = await deps.recoverInterruptedUpgrade(journal);
    journal = recovery.journal;
    if (recovery.outcome !== 'none') {
      deps.warn(`controlled node interrupted upgrade recovery: ${recovery.outcome}`);
    }
    if (recovery.handoff) {
      return { result: { credential: existing, disposition: 'handoff_complete', journal } };
    }
  }
  const stableRuntime = await deps.isStableRuntime(journal);
  let preloadedPending: PendingReenrollmentRecord | null = null;
  let pendingMatchesExisting = false;
  if (existing) {
    preloadedPending = (await deps.loadPendingReenrollment?.()) ?? null;
    const committedMatch = Boolean(
      preloadedPending?.redeemedCredential
      && existing.serverId === preloadedPending.redeemedCredential.serverId
      && existing.token === preloadedPending.redeemedCredential.token,
    );
    const previousMatch = Boolean(
      preloadedPending?.redeemedCredential
      && preloadedPending.previousServerId !== undefined
      && existing.serverId === preloadedPending.previousServerId
      && (
        preloadedPending.previousServerUrl === undefined
        || normalizeServerOriginForCompare(preloadedPending.previousServerUrl)
          === normalizeServerOriginForCompare(existing.serverUrl)
      ),
    );
    pendingMatchesExisting = committedMatch || previousMatch;
  }

  if (existing && stableRuntime && phaseIndex(journal.phase) >= phaseIndex('service_registered')
    && !(pendingMatchesExisting && preloadedPending?.redeemedCredential)) {
    // A transient maintenance failure on an already healthy stable runtime must
    // not turn the node into a watchdog crash loop; keep serving and retry on
    // the next process start.
    const publisherTrustError = await tryReleasePublisherTrust(
      deps,
      'Windows release publisher trust maintenance failed; continuing stable runtime and retrying later',
    );
    journal = (await prepareServiceStartRequested(deps, journal, { startService: false })).journal;
    journal = await reconcileStableServicePersistence(deps, journal);
    return {
      result: {
        credential: existing,
        disposition: 'run_runtime',
        journal,
        publisherTrustError,
        ...ensureBootstrapPortForwardTrust(deps),
      },
    };
  }

  // Anything left here is the downloaded installer, not the service: the stable
  // runtime returned above. It continues through elevation and staging so that
  // re-running it installs ITS bytes -- previously this returned early, which is
  // how an enrolled machine could never be re-installed at all.
  journal = await ensureElevated(deps, journal);
  const publisherTrustError = await tryReleasePublisherTrust(
    deps,
    'Windows release publisher trust installation failed; enrolling anyway so the machine stays reachable',
  );

  if (existing) {
    if (phaseIndex(journal.phase) < phaseIndex('files_staged')) {
      throw new Error('controlled node credential exists before files_staged journal phase; manual recovery required');
    }
    if (stableRuntime && !(pendingMatchesExisting && preloadedPending?.redeemedCredential)) {
      if (journal.phase === 'files_staged') {
        journal = await deps.writeInstallPhase(deps.journalPath, repairPhase(journal, 'enrolled'), {
          now: deps.now,
          previous: journal,
          serverId: existing.serverId,
        });
      }
      journal = (await prepareServiceStartRequested(deps, journal, { startService: false })).journal;
      return {
        result: {
          credential: existing,
          disposition: 'run_runtime',
          journal,
          publisherTrustError,
          ...ensureBootstrapPortForwardTrust(deps),
        },
      };
    }

    let source: VerifiedEnrollmentSource | null = null;
    try {
      let activePending = preloadedPending ?? (await deps.loadPendingReenrollment?.()) ?? null;
      source = await deps.openVerifiedEnrollmentSource(deps.sourceExecutablePath);
      const resolved = await resolveEnrollmentSource(deps, source);
      const runningFromStagedPath = await isRunningFromStagedExecutablePath(deps);
      const bloblessServiceRecovery = runningFromStagedPath || stableRuntime;
      const targetOrigin = resolved ? normalizeServerOriginForCompare(resolved.blob.serverUrl) : null;
      const enrollTokenHash = resolved ? hashEnrollmentToken(resolved.blob.enrollToken) : null;
      const pendingCommittedMatchesExisting = Boolean(
        activePending?.redeemedCredential
        && existing.serverId === activePending.redeemedCredential.serverId
        && existing.token === activePending.redeemedCredential.token,
      );
      const pendingMatchesPrevious = Boolean(
        activePending?.redeemedCredential
        && activePending.previousServerId !== undefined
        && existing.serverId === activePending.previousServerId
        && (
          activePending.previousServerUrl === undefined
          || normalizeServerOriginForCompare(activePending.previousServerUrl)
            === normalizeServerOriginForCompare(existing.serverUrl)
        ),
      );
      const pendingMatchesResolved = Boolean(
        activePending
        && resolved
        && activePending.targetOrigin === targetOrigin
        && activePending.enrollTokenHash === enrollTokenHash
        && normalizeControlledNodeAbiProfile(activePending.abiProfile) === abiProfile,
      );
      if (activePending?.redeemedCredential && (pendingCommittedMatchesExisting || pendingMatchesPrevious || pendingMatchesResolved)) {
        if (!resolved) {
          return await commitPendingReenrollment(
            deps,
            journal,
            existing,
            activePending,
            activePending.redeemedCredential,
            null,
            null,
            publisherTrustError,
            bloblessServiceRecovery
              ? { startService: false, disposition: 'run_runtime' }
              : { startService: true, disposition: 'handoff_complete' },
          );
        }
        if (targetOrigin === activePending.targetOrigin) {
          return await commitPendingReenrollment(
            deps,
            journal,
            existing,
            activePending,
            activePending.redeemedCredential,
            resolved,
            source,
            publisherTrustError,
            { startService: true, disposition: 'handoff_complete' },
          );
        }
        const finalized = await commitPendingReenrollment(
          deps,
          journal,
          existing,
          activePending,
          activePending.redeemedCredential,
          null,
          null,
          publisherTrustError,
          { startService: false, disposition: 'handoff_complete' },
        );
        existing = finalized.result.credential!;
        journal = finalized.result.journal;
        activePending = null;
      }
      if (!resolved && bloblessServiceRecovery) {
        if (journal.phase === 'files_staged') {
          journal = await deps.writeInstallPhase(deps.journalPath, repairPhase(journal, 'enrolled'), {
            now: deps.now,
            previous: journal,
            serverId: existing.serverId,
          });
        }
        journal = (await prepareServiceStartRequested(deps, journal, { startService: false })).journal;
        return {
          result: {
            credential: existing,
            disposition: 'run_runtime',
            journal,
            publisherTrustError,
            ...ensureBootstrapPortForwardTrust(deps),
          },
        };
      }
      if (resolved
        && activePending
        && !activePending.redeemedCredential
        && activePending.targetOrigin === targetOrigin
        && activePending.enrollTokenHash !== enrollTokenHash
        && normalizeControlledNodeAbiProfile(activePending.abiProfile) === abiProfile
        && activePending.pendingBlob) {
        deps.warn('controlled node resolving prior interrupted re-enrollment request before consuming new enrollment ticket');
        try {
          const recoveredCred = await deps.redeemEnrollmentV2(activePending.pendingBlob, activePending.identity);
          const recoveredPending: PendingReenrollmentRecord = {
            ...activePending,
            redeemedCredential: recoveredCred,
            pendingBlob: undefined,
          };
          await deps.persistPendingReenrollment?.(recoveredPending);
          return await commitPendingReenrollment(
            deps,
            journal,
            existing,
            recoveredPending,
            recoveredCred,
            resolved,
            source,
            publisherTrustError,
            { startService: true, disposition: 'handoff_complete' },
          );
        } catch (err) {
          if (!isDefinitiveRedeemRejection(err)) {
            throw err;
          }
          deps.warn('prior pending enrollment ticket definitively rejected; proceeding with new enrollment ticket');
          await deps.removePendingReenrollment?.();
          activePending = null;
        }
      }
      if (resolved) {
        const serverUrlChanged = normalizeServerOriginForCompare(existing.serverUrl) !== targetOrigin;
        let shouldReenroll = serverUrlChanged || (pendingMatchesResolved && !activePending?.redeemedCredential);
        if (serverUrlChanged) {
          deps.warn('controlled node enrollment serverUrl differs from existing credential; re-enrolling with fresh install identity');
        } else if (shouldReenroll) {
          deps.warn('controlled node resuming pending re-enrollment with durable install identity');
        } else if (deps.probeExistingCredential) {
          const probeStatus = await deps.probeExistingCredential(existing);
          if (probeStatus === 'revoked') {
            shouldReenroll = true;
            deps.warn('controlled node existing credential was revoked on server; re-enrolling with fresh install identity');
          }
        }
        if (shouldReenroll) {
          return await reenrollExistingInstallation(
            deps,
            journal,
            existing,
            resolved,
            source,
            abiProfile,
            activePending,
            publisherTrustError,
          );
        }
      }
      if (journal.phase === 'files_staged') {
        journal = await deps.writeInstallPhase(deps.journalPath, repairPhase(journal, 'enrolled'), {
          now: deps.now,
          previous: journal,
          serverId: existing.serverId,
        });
      }
      if (resolved) {
        journal = await restageWithResolvedSource(deps, journal, resolved, source);
      }
      const serviceStep = await prepareServiceStartRequested(deps, journal, { startService: true });
      journal = serviceStep.journal;
      return {
        result: {
          credential: existing,
          disposition: 'handoff_complete',
          journal,
          publisherTrustError,
          ...ensureBootstrapPortForwardTrust(deps),
        },
        ...(serviceStep.deferredStartReceipt ? { deferredStartReceipt: serviceStep.deferredStartReceipt } : {}),
      };
    } finally {
      if (source) await source.close().catch(() => {});
    }
  }

  let source: VerifiedEnrollmentSource | null = null;
  try {
    source = await deps.openVerifiedEnrollmentSource(deps.sourceExecutablePath);
    const resolved = await resolveEnrollmentSource(deps, source);
    if (!resolved) {
      if (phaseIndex(journal.phase) >= phaseIndex('enrolled')) {
        throw new Error('controlled node is enrolled but enrollment blob is unavailable; manual recovery required');
      }
      return {
        result: {
          credential: null,
          disposition: 'pending_setup',
          journal,
        },
      };
    }

    const identityStep = await ensureIdentityPrepared(deps, journal, resolved.blob);
    journal = identityStep.journal;
    const identity = identityStep.identity;

    journal = await ensureExecutableStaged(deps, journal, resolved, source);

    const enrolled = await ensureEnrolled(deps, journal, resolved.blob, identity);
    journal = enrolled.journal;
    const credential = enrolled.credential;
    const pfTrust = ensureBootstrapPortForwardTrust(deps);

    const serviceStep = await prepareServiceStartRequested(deps, journal, { startService: true });
    journal = serviceStep.journal;

    return {
      result: { credential, disposition: 'handoff_complete', journal, publisherTrustError, ...pfTrust },
      ...(serviceStep.deferredStartReceipt ? { deferredStartReceipt: serviceStep.deferredStartReceipt } : {}),
    };
  } finally {
    if (source) await source.close().catch(() => {});
  }
}

export async function bootstrapControlledNode(deps: ControlledNodeBootstrapDeps): Promise<ControlledNodeCredential> {
  const result = await bootstrapControlledNodeWithDisposition(deps);
  if (result.disposition === 'pending_setup' || !result.credential) {
    throw new Error('controlled node is not enrolled');
  }
  return result.credential;
}

/**
 * Mark service_healthy after the runtime completes its first authenticated
 * relay connection. SIDE-EFFECT-FREE inspection gates the write:
 *
 *   - the process must be the stable runtime (not the source / bootstrap)
 *   - `inspectServiceState(journal.serviceReceipt)` must report
 *     the receipt-pinned disk definition + manager-loaded action, boot loading,
 *     privileged principal, restart policy and running state all match
 *
 * Drift is logged; we DO NOT call `startService` here (that would kickstart
 * a second instance or kill the current connection). The source path is
 * responsible for repair. This is a HARD fail-closed boundary — a drift
 * state at this point refuses to mark healthy.
 */
export async function markServiceHealthy(
  journalPath: string,
  now: number,
  options: {
    isStableRuntime?: (journal: InstallJournal) => boolean | Promise<boolean>;
    inspectServiceState?: (receipt: ServiceReceipt) => Promise<import('./installer.js').ServiceInspection>;
    finalizeInterruptedUpgrade?: (journal: InstallJournal) => Promise<void>;
  } = {},
): Promise<void> {
  const journal = await loadInstallJournal(journalPath);
  const stable = await (options.isStableRuntime?.(journal) ?? isCurrentExecutableStable(journal));
  if (!stable) throw new Error('controlled node service_healthy can only be recorded by the stable runtime');
  if (!journal.serviceReceipt) {
    throw new Error('controlled node journal missing serviceReceipt; cannot mark service_healthy without a pinned definition');
  }
  // FAIL-CLOSED: inspect BEFORE writing healthy. The inspection is
  // side-effect-free; a drift between the journal-pinned definition and
  // the OS service-manager state means we cannot honestly claim healthy.
  const inspect = options.inspectServiceState ?? ((receipt: ServiceReceipt) => inspectServiceState(receipt));
  const insp = await inspect(journal.serviceReceipt);
  if (!isHealthyServiceInspection(insp, journal.serviceReceipt)) {
    throw new Error(
      `controlled node service_healthy refused: inspection reported installed=${insp.installed} loaded=${insp.loaded} bootEnabled=${insp.bootEnabled} principal=${insp.principal ?? 'unknown'} restartPolicy=${insp.restartPolicy ?? 'unknown'} runState=${insp.runState} definitionMatches=${insp.definitionMatches} loadedActionMatches=${insp.loadedActionMatches} errors=${insp.errors.join(',')}`,
    );
  }
  const finalize = options.finalizeInterruptedUpgrade ?? (async (healthyJournal: InstallJournal) => {
    if (process.platform !== 'win32' || !healthyJournal.stagedReceipt) return;
    await finalizeWindowsUpgradeTransaction({
      journal: healthyJournal,
      journalPath,
      executablePath: healthyJournal.stagedReceipt.path,
      cleanupTask: cleanupWindowsUpgradeTask,
    });
  });
  if (journal.phase === 'service_healthy') {
    await finalize(journal);
    return;
  }
  let previous = journal;
  if (journal.phase === 'service_registered') {
    previous = await writeInstallPhase(journalPath, 'service_start_requested', {
      now,
      previous: journal,
      serviceStartRequestedAt: now,
      serviceName: journal.serviceName,
      serviceReceipt: journal.serviceReceipt,
    });
  }
  const healthyJournal = await writeInstallPhase(journalPath, 'service_healthy', {
    now,
    previous,
    healthyAt: now,
  });
  await finalize(healthyJournal);
}

export { InstallJournalCorruptError, type InstallPhase };
