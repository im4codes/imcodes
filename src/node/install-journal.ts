// Recoverable install journal for the controlled node (10.10). Each phase is
// persisted with fsync + atomic rename so a reboot resumes from the last
// completed phase. The critical ordering fix: elevation + protected-dir creation
// happen BEFORE redemption/persistence, so a non-root first run never burns a
// token it cannot store (which would otherwise loop forever re-redeeming).
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Ordered install phases; a resume continues from the last persisted one. */
export const INSTALL_PHASES = [
  'uninstalled',
  'elevated',
  'files_staged',
  'credential_prepared',
  'enrolled',
  'service_registered',
  'service_healthy', // = an actual authenticated relay connection, not a zero exit
] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];

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

export interface InstallJournal {
  phase: InstallPhase;
  updatedAt: number;
  installId?: string;
}

/** Read the journal, or `uninstalled` when absent/corrupt (fresh install). */
export async function loadInstallJournal(path: string): Promise<InstallJournal> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<InstallJournal>;
    if (typeof parsed.phase === 'string' && (INSTALL_PHASES as readonly string[]).includes(parsed.phase)) {
      return { phase: parsed.phase as InstallPhase, updatedAt: parsed.updatedAt ?? 0, ...(parsed.installId ? { installId: parsed.installId } : {}) };
    }
  } catch {
    // absent or corrupt → treat as a fresh install
  }
  return { phase: 'uninstalled', updatedAt: 0 };
}

/** Persist a phase durably: write temp + fsync + atomic rename (crash-safe). */
export async function writeInstallPhase(path: string, phase: InstallPhase, extra: { installId?: string; now: number }): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload: InstallJournal = { phase, updatedAt: extra.now, ...(extra.installId ? { installId: extra.installId } : {}) };
  const temp = `${path}.${process.pid}.tmp`;
  const fh = await open(temp, 'w', 0o600);
  try {
    await fh.writeFile(JSON.stringify(payload));
    await fh.sync(); // fsync — survive power loss mid-install
  } finally {
    await fh.close();
  }
  await rename(temp, path);
}

/**
 * Whether a first run may attempt redemption. Redemption MUST come AFTER
 * elevation + the protected credential dir exists, so a used token is never
 * burned without a place to persist the resulting credential (10.10 / N5).
 */
export function mayRedeem(phase: InstallPhase): boolean {
  return phaseIndex(phase) >= phaseIndex('credential_prepared');
}
