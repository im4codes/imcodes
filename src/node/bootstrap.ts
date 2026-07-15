// First-run bootstrap for the controlled node — journaled install/enroll flow with
// D-A v2 identity pre-persist, stable trailer-free executable staging, real
// platform installer wiring, and crash-loop backoff (N5).
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EnrollmentBlob, EnrollmentTrailerRange } from '../../shared/remote-exec.js';
import {
  assertProductionServerUrl,
  defaultCredentialPath,
  defaultInstallIdentityPath,
  defaultStagedExecutablePath,
  generateInstallIdentity,
  loadCredential,
  loadInstallIdentity,
  openVerifiedEnrollmentSource,
  persistCredential,
  persistInstallIdentity,
  redeemEnrollmentV2,
  type ControlledNodeCredential,
  type PendingInstallIdentity,
  type StagedExecutableReceipt,
  type VerifiedEnrollmentSource,
} from './enrollment.js';
import {
  assertProcessElevated,
  installDefinition,
  inspectDefinition,
  inspectServiceState,
  secureWindowsCredentialDir,
  startService,
} from './installer.js';
import {
  InstallJournalCorruptError,
  loadInstallJournal,
  phaseIndex,
  writeInstallPhase,
  type InstallJournal,
  type InstallPhase,
  type ServiceReceipt,
} from './install-journal.js';

/** Install journal lives beside the credential in the protected directory. */
export function journalPathFor(credentialPath = defaultCredentialPath()): string {
  return join(dirname(credentialPath), 'install-journal.json');
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
  loadCredential: () => Promise<ControlledNodeCredential | null>;
  openVerifiedEnrollmentSource: (executablePath?: string) => Promise<VerifiedEnrollmentSource>;
  loadInstallIdentity: () => Promise<PendingInstallIdentity | null>;
  persistInstallIdentity: (identity: PendingInstallIdentity) => Promise<void>;
  generateInstallIdentity: () => PendingInstallIdentity;
  redeemEnrollmentV2: (blob: EnrollmentBlob, identity: PendingInstallIdentity) => Promise<ControlledNodeCredential>;
  persistCredential: (credential: ControlledNodeCredential) => Promise<void>;
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
  prepareCredentialDir: () => Promise<void>;
  loadInstallJournal: (path: string) => Promise<InstallJournal>;
  writeInstallPhase: typeof writeInstallPhase;
  journalPath: string;
  credentialPath: string;
  stagedExecutablePath: string;
  sourceExecutablePath: string;
  now: number;
  warn: (message: string) => void;
}

export type BootstrapDisposition = 'handoff_complete' | 'run_runtime';

export interface BootstrapResult {
  credential: ControlledNodeCredential;
  disposition: BootstrapDisposition;
  journal: InstallJournal;
}

/** Production deps wired to the real enrollment/installer/journal + fs. */
export function defaultBootstrapDeps(now: number): ControlledNodeBootstrapDeps {
  const credentialPath = defaultCredentialPath();
  const sourceExecutablePath = process.execPath;
  return {
    loadCredential: () => loadCredential(credentialPath),
    openVerifiedEnrollmentSource: (executablePath = sourceExecutablePath) => openVerifiedEnrollmentSource(executablePath),
    loadInstallIdentity: () => loadInstallIdentity(defaultInstallIdentityPath(credentialPath)),
    persistInstallIdentity: (identity) => persistInstallIdentity(identity, defaultInstallIdentityPath(credentialPath)),
    generateInstallIdentity: () => ({ ...generateInstallIdentity(), sourceExePath: sourceExecutablePath }),
    redeemEnrollmentV2: (blob, identity) => redeemEnrollmentV2(blob, identity),
    persistCredential: (credential) => persistCredential(credential, credentialPath),
    installDefinition: (exePath) => installDefinition(exePath),
    inspectDefinition: (receipt) => inspectDefinition(receipt),
    inspectServiceState: (receipt) => inspectServiceState(receipt),
    startService: (receipt) => startService(receipt),
    verifyStagedExecutable: (receipt) => verifyStagedExecutableReceipt(receipt),
    isStableRuntime: (journal) => isCurrentExecutableStable(journal, sourceExecutablePath),
    assertElevated: assertProcessElevated,
    prepareCredentialDir: () => prepareCredentialDir(credentialPath),
    loadInstallJournal,
    writeInstallPhase,
    journalPath: journalPathFor(credentialPath),
    credentialPath,
    stagedExecutablePath: defaultStagedExecutablePath(),
    sourceExecutablePath,
    now,
    warn: (message) => process.stderr.write(`imcodes-node: ${message}\n`),
  };
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
  if (receipt.stagedIdentity.dev !== undefined && receipt.stagedIdentity.ino !== undefined) {
    if (!samePosixFile(receipt.stagedIdentity, inspected.identity)) throw new Error('stable executable identity mismatch');
  }
}

export async function verifyStagedExecutableReceipt(receipt: StagedExecutableReceipt): Promise<void> {
  const inspected = await inspectVerifiedExecutable(receipt.path);
  assertReceiptMatchesInspection(receipt, inspected);
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
      throw new Error('controlled node install journal is corrupt; refusing to continue — manual recovery required');
    }
    throw err;
  }
}

async function ensureIdentityPrepared(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  trailerRange: EnrollmentTrailerRange,
): Promise<{ journal: InstallJournal; identity: PendingInstallIdentity }> {
  assertProductionServerUrl(trailerRange.blob.serverUrl);
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
  if (journal.sourceExePath !== undefined && journal.sourceExePath !== identity.sourceExePath) {
    throw new Error('controlled node install identity does not match journal sourceExePath');
  }
  if (phaseIndex(journal.phase) < phaseIndex('credential_prepared')) {
    journal = await deps.writeInstallPhase(deps.journalPath, 'credential_prepared', {
      now: deps.now,
      previous: journal,
      installId: identity.installId,
      nodeTokenHash: identity.nodeTokenHash,
      sourceExePath: identity.sourceExePath,
    });
  }
  return { journal, identity };
}

async function ensureExecutableStaged(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  trailerRange: EnrollmentTrailerRange,
  source: VerifiedEnrollmentSource,
): Promise<InstallJournal> {
  if (phaseIndex(journal.phase) >= phaseIndex('files_staged') && journal.stagedExePath) {
    if (!journal.stagedReceipt) throw new Error('controlled node staged executable receipt is missing; manual recovery required');
    if (journal.stagedReceipt.path !== journal.stagedExePath) {
      throw new Error('controlled node staged executable receipt path mismatch; manual recovery required');
    }
    await deps.verifyStagedExecutable(journal.stagedReceipt);
    return journal;
  }
  const stagedReceipt: StagedExecutableReceipt = await source.stageTrailerFreeExecutable(
    deps.stagedExecutablePath,
    trailerRange.trailerStart,
  );
  return deps.writeInstallPhase(deps.journalPath, 'files_staged', {
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
  trailerRange: EnrollmentTrailerRange,
  identity: PendingInstallIdentity,
  source: VerifiedEnrollmentSource,
): Promise<{ journal: InstallJournal; credential: ControlledNodeCredential }> {
  const existing = await deps.loadCredential();
  if (existing) return { journal, credential: existing };

  const recovering = phaseIndex(journal.phase) >= phaseIndex('enrolled');
  if (recovering && !identity) {
    throw new Error('controlled node install journal is enrolled but install identity is missing; manual recovery required');
  }

  const credential = await deps.redeemEnrollmentV2(trailerRange.blob, identity);
  try {
    await deps.persistCredential(credential);
  } catch (err) {
    if (!recovering) {
      await deps.writeInstallPhase(deps.journalPath, 'enrolled', {
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

  let cleanupStatus = journal.cleanupStatus;
  if (!recovering || !cleanupStatus || cleanupStatus === 'pending') {
    cleanupStatus = await source.cleanupEnrollmentSource(
      trailerRange.trailerStart,
      trailerRange.trailerLength,
    );
    if (cleanupStatus === 'failed') deps.warn('source enrollment trailer cleanup failed (best-effort privacy only)');
  }

  journal = await deps.writeInstallPhase(deps.journalPath, 'enrolled', {
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
    if (!journal.stagedReceipt) throw new Error('controlled node staged executable receipt is missing; manual recovery required');
    await deps.verifyStagedExecutable(journal.stagedReceipt);
  }
  const stagedPath = journal.stagedExePath ?? deps.stagedExecutablePath;
  if (phaseIndex(journal.phase) >= phaseIndex('service_registered') && journal.serviceName) {
    let serviceReceipt = journal.serviceReceipt;
    if (serviceReceipt) {
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
  return deps.writeInstallPhase(deps.journalPath, 'service_registered', {
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
  return journal;
}

async function ensureServiceStartRequested(
  deps: ControlledNodeBootstrapDeps,
  journal: InstallJournal,
  options: { startService?: boolean } = {},
): Promise<InstallJournal> {
  journal = await ensureServiceRegistered(deps, journal);
  const receipt = receiptFromJournal(journal);
  if (phaseIndex(journal.phase) < phaseIndex('service_start_requested')) {
    journal = await deps.writeInstallPhase(deps.journalPath, 'service_start_requested', {
      now: deps.now,
      previous: journal,
      serviceStartRequestedAt: deps.now,
      serviceName: receipt.name,
      serviceReceipt: receipt,
    });
  }
  if (options.startService !== false) await deps.startService(receipt);
  return journal;
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
export async function bootstrapControlledNodeWithDisposition(deps: ControlledNodeBootstrapDeps): Promise<BootstrapResult> {
  const existing = await deps.loadCredential();
  let journal = await loadJournalOrThrow(deps);
  const stableRuntime = await deps.isStableRuntime(journal);

  if (existing && stableRuntime && phaseIndex(journal.phase) >= phaseIndex('service_registered')) {
    journal = await ensureServiceStartRequested(deps, journal, { startService: false });
    journal = await reconcileStableServicePersistence(deps, journal);
    return { credential: existing, disposition: 'run_runtime', journal };
  }

  if (existing && phaseIndex(journal.phase) >= phaseIndex('service_registered')) {
    journal = await ensureServiceStartRequested(deps, journal, { startService: !stableRuntime });
    return { credential: existing, disposition: stableRuntime ? 'run_runtime' : 'handoff_complete', journal };
  }

  journal = await ensureElevated(deps, journal);

  if (existing) {
    if (phaseIndex(journal.phase) < phaseIndex('files_staged')) {
      throw new Error('controlled node credential exists before files_staged journal phase; manual recovery required');
    }
    // Legitimate crash window: the credential fsync completed, but the enrolled
    // journal write did not. Reconcile exactly one phase before service install.
    if (journal.phase === 'files_staged') {
      journal = await deps.writeInstallPhase(deps.journalPath, 'enrolled', {
        now: deps.now,
        previous: journal,
        serverId: existing.serverId,
      });
    }
    journal = await ensureServiceStartRequested(deps, journal);
    return { credential: existing, disposition: stableRuntime ? 'run_runtime' : 'handoff_complete', journal };
  }

  let source: VerifiedEnrollmentSource | null = null;
  try {
    source = await deps.openVerifiedEnrollmentSource(deps.sourceExecutablePath);
    const trailerRange = await source.readEnrollmentBlobWithRange();
    if (!trailerRange) {
      if (phaseIndex(journal.phase) >= phaseIndex('enrolled')) {
        throw new Error('controlled node is enrolled but enrollment blob is unavailable; manual recovery required');
      }
      throw new Error('controlled node is not enrolled');
    }

    const identityStep = await ensureIdentityPrepared(deps, journal, trailerRange);
    journal = identityStep.journal;
    const identity = identityStep.identity;

    journal = await ensureExecutableStaged(deps, journal, trailerRange, source);

    const enrolled = await ensureEnrolled(deps, journal, trailerRange, identity, source);
    journal = enrolled.journal;
    const credential = enrolled.credential;

    journal = await ensureServiceStartRequested(deps, journal);

    return { credential, disposition: 'handoff_complete', journal };
  } finally {
    if (source) await source.close().catch(() => {});
  }
}

export async function bootstrapControlledNode(deps: ControlledNodeBootstrapDeps): Promise<ControlledNodeCredential> {
  return (await bootstrapControlledNodeWithDisposition(deps)).credential;
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
  if (journal.phase === 'service_healthy') return;
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
  await writeInstallPhase(journalPath, 'service_healthy', {
    now,
    previous,
    healthyAt: now,
  });
}

export { InstallJournalCorruptError, type InstallPhase };
