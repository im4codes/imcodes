import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALL_PHASES,
  nextPhase,
  phaseIndex,
  isInstallComplete,
  mayRedeem,
  loadInstallJournal,
  writeInstallPhase,
} from '../../src/node/install-journal.js';

let dir: string;
let path: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'deck-journal-')); path = join(dir, 'install.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('install journal phase ordering (10.10)', () => {
  it('orders phases with the ordering-fix invariant: elevation + credential dir precede redemption', () => {
    // credential_prepared (protected dir exists) must come BEFORE enrolled (token redeemed).
    expect(phaseIndex('elevated')).toBeLessThan(phaseIndex('credential_prepared'));
    expect(phaseIndex('credential_prepared')).toBeLessThan(phaseIndex('enrolled'));
    expect(INSTALL_PHASES[0]).toBe('uninstalled');
    expect(INSTALL_PHASES[INSTALL_PHASES.length - 1]).toBe('service_healthy');
  });

  it('nextPhase walks the chain and stops at completion', () => {
    let p = INSTALL_PHASES[0];
    const walk: string[] = [p];
    for (let n = nextPhase(p); n; n = nextPhase(p)) { p = n; walk.push(p); }
    expect(walk).toEqual([...INSTALL_PHASES]);
    expect(nextPhase('service_healthy')).toBeNull();
    expect(isInstallComplete('service_healthy')).toBe(true);
    expect(isInstallComplete('enrolled')).toBe(false);
  });

  it('mayRedeem is false until the protected credential dir is prepared (no burn-before-persist)', () => {
    expect(mayRedeem('uninstalled')).toBe(false);
    expect(mayRedeem('elevated')).toBe(false);
    expect(mayRedeem('files_staged')).toBe(false);
    expect(mayRedeem('credential_prepared')).toBe(true);
    expect(mayRedeem('enrolled')).toBe(true);
  });
});

describe('install journal persistence + resume (10.10)', () => {
  it('a fresh/absent journal reads as uninstalled', async () => {
    expect((await loadInstallJournal(path)).phase).toBe('uninstalled');
  });

  it('persists a phase durably and resumes from it (write → read round trip)', async () => {
    await writeInstallPhase(path, 'credential_prepared', { installId: 'inst-1', now: 1000 });
    const j = await loadInstallJournal(path);
    expect(j.phase).toBe('credential_prepared');
    expect(j.installId).toBe('inst-1');
    expect(j.updatedAt).toBe(1000);
  });

  it('advances across a simulated reboot, resuming from the last completed phase', async () => {
    await writeInstallPhase(path, 'elevated', { now: 1 });
    // ...crash/reboot; a new process loads and continues.
    let resumed = await loadInstallJournal(path);
    const next = nextPhase(resumed.phase);
    expect(next).toBe('files_staged');
    await writeInstallPhase(path, next!, { now: 2 });
    resumed = await loadInstallJournal(path);
    expect(resumed.phase).toBe('files_staged');
  });

  it('writes the credential file with 0600 (not group/world readable)', async () => {
    await writeInstallPhase(path, 'enrolled', { now: 5 });
    const mode = (await stat(path)).mode & 0o077;
    expect(mode).toBe(0); // no group/world bits
  });

  it('creates a missing parent directory (0700) on first write', async () => {
    const nested = join(dir, 'a', 'b', 'install.json');
    await writeInstallPhase(nested, 'elevated', { now: 9 });
    expect((await loadInstallJournal(nested)).phase).toBe('elevated');
  });

  it('treats a corrupt journal as a fresh install (fail safe, not throw)', async () => {
    await writeFile(path, 'not json{', 'utf8');
    expect((await loadInstallJournal(path)).phase).toBe('uninstalled');
  });

  it('rejects an unknown phase value in the journal', async () => {
    await writeFile(path, JSON.stringify({ phase: 'bogus', updatedAt: 1 }), 'utf8');
    expect((await loadInstallJournal(path)).phase).toBe('uninstalled');
  });
});
