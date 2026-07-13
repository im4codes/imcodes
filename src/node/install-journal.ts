// Recoverable install journal for the controlled node (10.10). Each phase is
// persisted with fsync + atomic rename so a reboot resumes from the last
// completed phase. The critical ordering fix: elevation + protected-dir creation
// happen BEFORE redemption/persistence, so a non-root first run never burns a
// token it cannot store (which would otherwise loop forever re-redeeming).
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isEnrollmentNodeTokenHash } from '../../shared/remote-exec.js';
import type { FileIdentity, StagedExecutableReceipt } from './enrollment.js';

/** Ordered install phases; a resume continues from the last persisted one. */
export const INSTALL_PHASES = [
  'uninstalled',
  'elevated',
  'credential_prepared',
  'files_staged',
  'enrolled',
  'service_registered',
  'service_start_requested',
  'service_healthy', // = an actual authenticated relay connection, not a zero exit
] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];

export const INSTALL_JOURNAL_VERSION = 1 as const;

export class InstallJournalCorruptError extends Error {
  constructor(message = 'install journal is corrupt') {
    super(message);
    this.name = 'InstallJournalCorruptError';
  }
}

export class InstallJournalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallJournalTransitionError';
  }
}

export function phaseIndex(phase: InstallPhase): number {
  return INSTALL_PHASES.indexOf(phase);
}

/** The next phase to attempt, or null when installation is complete. */
export function nextPhase(current: InstallPhase): InstallPhase | null {
  const i = phaseIndex(current);
  return i >= 0 && i < INSTALL_PHASES.length - 1 ? INSTALL_PHASES[i + 1] : null;
}

export function isInstallComplete(phase: InstallPhase): boolean {
  return phase === 'service_healthy';
}

export type SourceCleanupStatus = 'pending' | 'cleaned' | 'skipped' | 'failed';

export interface ServiceReceipt {
  name: string;
  platform: NodeJS.Platform;
  definitionPath?: string;
  definitionSha256?: string;
  action?: string;
}

export interface InstallJournal {
  version?: typeof INSTALL_JOURNAL_VERSION;
  phase: InstallPhase;
  updatedAt: number;
  /** Client-generated durable install identity (NOT serverId). */
  installId?: string;
  nodeTokenHash?: string;
  sourceExePath?: string;
  stagedExePath?: string;
  stagedReceipt?: StagedExecutableReceipt;
  serverId?: string;
  serviceName?: string;
  serviceReceipt?: ServiceReceipt;
  serviceStartRequestedAt?: number;
  cleanupStatus?: SourceCleanupStatus;
  healthyAt?: number;
}

function isInstallPhase(value: unknown): value is InstallPhase {
  return typeof value === 'string' && (INSTALL_PHASES as readonly string[]).includes(value);
}

const SOURCE_CLEANUP_STATUSES = new Set<SourceCleanupStatus>(['pending', 'cleaned', 'skipped', 'failed']);

function isNonEmptyString(value: unknown, maxLength = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isFileIdentity(value: unknown): value is FileIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.size === 'number'
    && Number.isFinite(record.size)
    && typeof record.mtimeMs === 'number'
    && Number.isFinite(record.mtimeMs)
    && typeof record.ctimeMs === 'number'
    && Number.isFinite(record.ctimeMs);
}

function isStagedReceipt(value: unknown): value is StagedExecutableReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isNonEmptyString(record.path)
    && typeof record.size === 'number'
    && Number.isSafeInteger(record.size)
    && record.size > 0
    && isNonEmptyString(record.sha256, 256)
    && isFileIdentity(record.sourceIdentity)
    && isFileIdentity(record.stagedIdentity);
}

function isServiceReceipt(value: unknown): value is ServiceReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isNonEmptyString(record.name, 512)
    && isNonEmptyString(record.platform, 32)
    && (record.definitionPath === undefined || isNonEmptyString(record.definitionPath))
    && (record.definitionSha256 === undefined || isNonEmptyString(record.definitionSha256, 256))
    && (record.action === undefined || isNonEmptyString(record.action, 4096));
}

function invalidJournal(message: string): never {
  throw new InstallJournalCorruptError(message);
}

/** Validate phase prerequisites so labels cannot get ahead of durable work. */
function validateJournalMetadata(journal: InstallJournal): void {
  const index = phaseIndex(journal.phase);
  const isFreshDefault = journal.version === undefined
    && journal.phase === 'uninstalled'
    && journal.updatedAt === 0;
  if (journal.version !== INSTALL_JOURNAL_VERSION && !isFreshDefault) invalidJournal('install journal version is invalid');
  if (!Number.isSafeInteger(journal.updatedAt) || journal.updatedAt < 0) invalidJournal('install journal updatedAt is invalid');
  if (journal.installId !== undefined && !isNonEmptyString(journal.installId, 512)) invalidJournal('install journal installId is invalid');
  if (journal.nodeTokenHash !== undefined && !isEnrollmentNodeTokenHash(journal.nodeTokenHash)) invalidJournal('install journal nodeTokenHash is invalid');
  if (journal.sourceExePath !== undefined && !isNonEmptyString(journal.sourceExePath)) invalidJournal('install journal sourceExePath is invalid');
  if (journal.stagedExePath !== undefined && !isNonEmptyString(journal.stagedExePath)) invalidJournal('install journal stagedExePath is invalid');
  if (journal.stagedReceipt !== undefined && !isStagedReceipt(journal.stagedReceipt)) invalidJournal('install journal stagedReceipt is invalid');
  if (journal.serverId !== undefined && !isNonEmptyString(journal.serverId, 512)) invalidJournal('install journal serverId is invalid');
  if (journal.serviceName !== undefined && !isNonEmptyString(journal.serviceName, 512)) invalidJournal('install journal serviceName is invalid');
  if (journal.serviceReceipt !== undefined && !isServiceReceipt(journal.serviceReceipt)) invalidJournal('install journal serviceReceipt is invalid');
  if (journal.serviceStartRequestedAt !== undefined && (!Number.isSafeInteger(journal.serviceStartRequestedAt) || journal.serviceStartRequestedAt < 0)) {
    invalidJournal('install journal serviceStartRequestedAt is invalid');
  }
  if (journal.cleanupStatus !== undefined && !SOURCE_CLEANUP_STATUSES.has(journal.cleanupStatus)) invalidJournal('install journal cleanupStatus is invalid');
  if (journal.healthyAt !== undefined && (!Number.isSafeInteger(journal.healthyAt) || journal.healthyAt < 0)) invalidJournal('install journal healthyAt is invalid');

  const credentialIndex = phaseIndex('credential_prepared');
  const stagedIndex = phaseIndex('files_staged');
  const enrolledIndex = phaseIndex('enrolled');
  const registeredIndex = phaseIndex('service_registered');
  const startRequestedIndex = phaseIndex('service_start_requested');
  const healthyIndex = phaseIndex('service_healthy');

  const hasIdentityMetadata = journal.installId !== undefined
    || journal.nodeTokenHash !== undefined
    || journal.sourceExePath !== undefined;
  if (index < credentialIndex && hasIdentityMetadata) invalidJournal('install identity metadata precedes credential_prepared');
  if (index >= credentialIndex && (!journal.installId || !journal.nodeTokenHash || !journal.sourceExePath)) {
    invalidJournal('credential_prepared requires durable install identity metadata');
  }
  if (index < stagedIndex && journal.stagedExePath !== undefined) invalidJournal('staged executable metadata precedes files_staged');
  if (index < stagedIndex && journal.stagedReceipt !== undefined) invalidJournal('staged receipt metadata precedes files_staged');
  if (index >= stagedIndex && !journal.stagedExePath) invalidJournal('files_staged requires stagedExePath');
  if (index < enrolledIndex && (journal.serverId !== undefined || journal.cleanupStatus !== undefined)) {
    invalidJournal('enrollment metadata precedes enrolled');
  }
  if (index >= enrolledIndex && !journal.serverId) invalidJournal('enrolled requires serverId');
  if (index < registeredIndex && (journal.serviceName !== undefined || journal.serviceReceipt !== undefined)) invalidJournal('service metadata precedes service_registered');
  if (index >= registeredIndex && !journal.serviceName) invalidJournal('service_registered requires serviceName');
  if (index < startRequestedIndex && journal.serviceStartRequestedAt !== undefined) invalidJournal('service start intent precedes service_start_requested');
  if (journal.phase === 'service_start_requested' && journal.serviceStartRequestedAt === undefined) {
    invalidJournal('service_start_requested requires serviceStartRequestedAt');
  }
  if (index < healthyIndex && journal.healthyAt !== undefined) invalidJournal('healthy metadata precedes service_healthy');
  if (index >= healthyIndex && journal.healthyAt === undefined) invalidJournal('service_healthy requires healthyAt');
}

const IMMUTABLE_JOURNAL_FIELDS = [
  'installId',
  'nodeTokenHash',
  'sourceExePath',
  'stagedExePath',
  'serverId',
  'serviceName',
] as const satisfies readonly (keyof InstallJournal)[];

function assertImmutableMetadata(existing: InstallJournal, patch: Partial<InstallJournal>): void {
  for (const field of IMMUTABLE_JOURNAL_FIELDS) {
    const current = existing[field];
    const next = patch[field];
    if (current !== undefined && next !== undefined && current !== next) {
      throw new InstallJournalTransitionError(`install journal immutable field changed: ${field}`);
    }
  }
}

function mergeJournal(existing: InstallJournal | null, patch: Partial<InstallJournal>): InstallJournal {
  const base = existing ?? { phase: 'uninstalled' as InstallPhase, updatedAt: 0 };
  return {
    ...base,
    ...patch,
    version: INSTALL_JOURNAL_VERSION,
    installId: patch.installId ?? base.installId,
    nodeTokenHash: patch.nodeTokenHash ?? base.nodeTokenHash,
    sourceExePath: patch.sourceExePath ?? base.sourceExePath,
    stagedExePath: patch.stagedExePath ?? base.stagedExePath,
    stagedReceipt: patch.stagedReceipt ?? base.stagedReceipt,
    serverId: patch.serverId ?? base.serverId,
    serviceName: patch.serviceName ?? base.serviceName,
    serviceReceipt: patch.serviceReceipt ?? base.serviceReceipt,
    serviceStartRequestedAt: patch.serviceStartRequestedAt ?? base.serviceStartRequestedAt,
    cleanupStatus: patch.cleanupStatus ?? base.cleanupStatus,
    healthyAt: patch.healthyAt ?? base.healthyAt,
  };
}

export function shouldFsyncInstallJournalParent(platform: NodeJS.Platform = process.platform): boolean {
  // Windows can open a directory handle through Node, but fsync on that handle
  // fails with EPERM. The journal file itself is already fsynced before rename.
  return platform !== 'win32';
}

async function fsyncParentDir(path: string): Promise<void> {
  if (!shouldFsyncInstallJournalParent()) return;
  const dir = dirname(path);
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Read the journal, or `uninstalled` when absent. Corrupt journals fail closed. */
export async function loadInstallJournal(path: string): Promise<InstallJournal> {
  try {
    const raw = await readFile(path, 'utf8');
    let parsed: Partial<InstallJournal>;
    try {
      parsed = JSON.parse(raw) as Partial<InstallJournal>;
    } catch {
      throw new InstallJournalCorruptError('install journal JSON is invalid');
    }
    if (!isInstallPhase(parsed.phase)) {
      throw new InstallJournalCorruptError('install journal phase is invalid');
    }
    if (parsed.version !== INSTALL_JOURNAL_VERSION) {
      throw new InstallJournalCorruptError('install journal version is invalid');
    }
    const journal = mergeJournal(null, {
      version: parsed.version,
      phase: parsed.phase,
      updatedAt: parsed.updatedAt ?? 0,
      installId: parsed.installId,
      nodeTokenHash: parsed.nodeTokenHash,
      sourceExePath: parsed.sourceExePath,
      stagedExePath: parsed.stagedExePath,
      stagedReceipt: parsed.stagedReceipt,
      serverId: parsed.serverId,
      serviceName: parsed.serviceName,
      serviceReceipt: parsed.serviceReceipt,
      serviceStartRequestedAt: parsed.serviceStartRequestedAt,
      cleanupStatus: parsed.cleanupStatus,
      healthyAt: parsed.healthyAt,
    });
    validateJournalMetadata(journal);
    return journal;
  } catch (err) {
    if (err instanceof InstallJournalCorruptError) throw err;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { phase: 'uninstalled', updatedAt: 0 };
    throw err;
  }
}

/** Persist a phase durably: merge metadata, write temp + fsync + atomic rename + supported parent fsync. */
export async function writeInstallPhase(
  path: string,
  phase: InstallPhase,
  extra: {
    installId?: string;
    nodeTokenHash?: string;
    sourceExePath?: string;
    stagedExePath?: string;
    stagedReceipt?: StagedExecutableReceipt;
    serverId?: string;
    serviceName?: string;
    serviceReceipt?: ServiceReceipt;
    serviceStartRequestedAt?: number;
    cleanupStatus?: SourceCleanupStatus;
    healthyAt?: number;
    now: number;
    previous?: InstallJournal | null;
  },
): Promise<InstallJournal> {
  const onDisk = await loadInstallJournal(path);
  if (extra.previous) {
    validateJournalMetadata(extra.previous);
    if (extra.previous.phase !== onDisk.phase || extra.previous.updatedAt !== onDisk.updatedAt) {
      throw new InstallJournalTransitionError('install journal previous state is stale');
    }
  }
  const previous = onDisk;
  const previousIndex = phaseIndex(previous.phase);
  const nextIndex = phaseIndex(phase);
  if (nextIndex < previousIndex) {
    throw new InstallJournalTransitionError(`install journal backward transition: ${previous.phase} -> ${phase}`);
  }
  if (nextIndex > previousIndex + 1) {
    throw new InstallJournalTransitionError(`install journal phase jump: ${previous.phase} -> ${phase}`);
  }
  if (!Number.isSafeInteger(extra.now) || extra.now < previous.updatedAt) {
    throw new InstallJournalTransitionError('install journal timestamp moved backward or is invalid');
  }
  const patch: Partial<InstallJournal> = {
    phase,
    updatedAt: extra.now,
    installId: extra.installId,
    nodeTokenHash: extra.nodeTokenHash,
    sourceExePath: extra.sourceExePath,
    stagedExePath: extra.stagedExePath,
    stagedReceipt: extra.stagedReceipt,
    serverId: extra.serverId,
    serviceName: extra.serviceName,
    serviceReceipt: extra.serviceReceipt,
    serviceStartRequestedAt: extra.serviceStartRequestedAt,
    cleanupStatus: extra.cleanupStatus,
    healthyAt: extra.healthyAt,
  };
  assertImmutableMetadata(previous, patch);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload = mergeJournal(previous, patch);
  validateJournalMetadata(payload);
  const temp = `${path}.${process.pid}.tmp`;
  const fh = await open(temp, 'w', 0o600);
  try {
    await fh.writeFile(JSON.stringify(payload));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(temp, path);
  await fsyncParentDir(path);
  return payload;
}

/**
 * Whether a first run may attempt redemption. Redemption MUST come AFTER
 * elevation + the protected credential dir exists, so a used token is never
 * burned without a place to persist the resulting credential (10.10 / N5).
 */
export function mayRedeem(phase: InstallPhase): boolean {
  return phaseIndex(phase) >= phaseIndex('files_staged');
}
