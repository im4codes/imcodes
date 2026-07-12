// First-run bootstrap for the controlled node — the journaled install/enroll
// flow that fixes the N5 defect (10.10): the protected credential directory is
// prepared BEFORE the one-time enrollment token is redeemed, and a redeem that
// cannot be persisted backs off and STOPS rather than looping to re-redeem an
// already-used token. All IO is injectable so the ordering + crash-loop-backoff
// invariants are unit-testable without a real OS/network.
import { dirname, join } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import type { EnrollmentBlob } from '../../shared/remote-exec.js';
import {
  burnEnrollmentBlob,
  defaultCredentialPath,
  loadCredential,
  persistCredential,
  readEnrollmentBlob,
  redeemEnrollment,
  type ControlledNodeCredential,
} from './enrollment.js';
import { secureWindowsCredentialDir } from './installer.js';
import {
  loadInstallJournal,
  phaseIndex,
  writeInstallPhase,
  type InstallJournal,
  type InstallPhase,
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
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
}

export interface ControlledNodeBootstrapDeps {
  loadCredential: () => Promise<ControlledNodeCredential | null>;
  readEnrollmentBlob: () => Promise<EnrollmentBlob | null>;
  redeemEnrollment: (blob: EnrollmentBlob) => Promise<ControlledNodeCredential>;
  persistCredential: (credential: ControlledNodeCredential) => Promise<void>;
  burnEnrollmentBlob: () => Promise<void>;
  prepareCredentialDir: () => Promise<void>;
  loadInstallJournal: (path: string) => Promise<InstallJournal>;
  writeInstallPhase: (path: string, phase: InstallPhase, extra: { installId?: string; now: number }) => Promise<void>;
  journalPath: string;
  now: number;
  warn: (message: string) => void;
}

/** Production deps wired to the real enrollment/installer/journal + fs. */
export function defaultBootstrapDeps(now: number): ControlledNodeBootstrapDeps {
  const credentialPath = defaultCredentialPath();
  return {
    loadCredential: () => loadCredential(),
    readEnrollmentBlob: () => readEnrollmentBlob(),
    redeemEnrollment: (blob) => redeemEnrollment(blob),
    persistCredential: (credential) => persistCredential(credential),
    burnEnrollmentBlob: () => burnEnrollmentBlob(),
    prepareCredentialDir: () => prepareCredentialDir(credentialPath),
    loadInstallJournal,
    writeInstallPhase,
    journalPath: journalPathFor(credentialPath),
    now,
    warn: (message) => process.stderr.write(`imcodes-node: ${message}\n`),
  };
}

/**
 * Resolve the controlled-node credential, enrolling on first run through the
 * journaled, order-safe flow. Returns the credential to start the runtime with,
 * or throws (caller stops) — never loops re-redeeming a used token.
 */
export async function bootstrapControlledNode(deps: ControlledNodeBootstrapDeps): Promise<ControlledNodeCredential> {
  // Fast path: an already-persisted credential means a normal boot.
  const existing = await deps.loadCredential();
  if (existing) return existing;

  const journal = await deps.loadInstallJournal(deps.journalPath);
  // N5 crash-loop backoff: the journal reached `enrolled` (token redeemed) but no
  // credential is on disk ⇒ a prior persist failed. The token is one-time and now
  // spent — refuse to re-redeem it; a human must re-enroll with a fresh installer.
  if (phaseIndex(journal.phase) >= phaseIndex('enrolled')) {
    throw new Error(
      'controlled node previously redeemed its one-time enrollment token but has no persisted credential; refusing to re-redeem a used token — re-enroll with a fresh installer',
    );
  }

  const blob = await deps.readEnrollmentBlob();
  if (!blob) throw new Error('controlled node is not enrolled');

  // Ordering fix (N5): prepare + secure the protected credential dir BEFORE
  // spending the one-time token, so a redeemed credential always has a home.
  await deps.prepareCredentialDir();
  await deps.writeInstallPhase(deps.journalPath, 'credential_prepared', { now: deps.now });

  const credential = await deps.redeemEnrollment(blob);
  // Record `enrolled` BEFORE the persist attempt so a persist crash is detectable
  // as "used token, no credential" on the next boot (drives the backoff above).
  await deps.writeInstallPhase(deps.journalPath, 'enrolled', { installId: credential.serverId, now: deps.now });

  try {
    await deps.persistCredential(credential);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.warn(`enrolled but failed to persist credential (${message}); backing off — will NOT re-redeem`);
    throw new Error(`controlled node redeemed enrollment but could not persist its credential (${message}); backing off without re-redeeming`);
  }

  await deps.burnEnrollmentBlob().catch(() => {});
  await deps.writeInstallPhase(deps.journalPath, 'service_registered', { now: deps.now });
  return credential;
}
