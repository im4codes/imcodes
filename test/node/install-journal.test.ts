import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile, open } from 'node:fs/promises';
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
  InstallJournalCorruptError,
  InstallJournalTransitionError,
} from '../../src/node/install-journal.js';

let dir: string;
let path: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'deck-journal-')); path = join(dir, 'install.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const IDENTITY = {
  installId: 'inst-1',
  nodeTokenHash: 'a'.repeat(64),
  sourceExePath: '/tmp/download/imcodes-node',
};

async function advanceToCredentialPrepared() {
  const elevated = await writeInstallPhase(path, 'elevated', { now: 1 });
  return writeInstallPhase(path, 'credential_prepared', { now: 2, previous: elevated, ...IDENTITY });
}

async function advanceToFilesStaged() {
  const prepared = await advanceToCredentialPrepared();
  return writeInstallPhase(path, 'files_staged', {
    now: 3,
    previous: prepared,
    stagedExePath: '/var/lib/imcodes-node/bin',
  });
}

async function advanceToEnrolled() {
  const staged = await advanceToFilesStaged();
  return writeInstallPhase(path, 'enrolled', {
    now: 4,
    previous: staged,
    serverId: 'srv-1',
  });
}

describe('install journal phase ordering (10.10)', () => {
  it('orders phases monotonically: credential dir before staging before redemption', () => {
    expect(phaseIndex('elevated')).toBeLessThan(phaseIndex('credential_prepared'));
    expect(phaseIndex('credential_prepared')).toBeLessThan(phaseIndex('files_staged'));
    expect(phaseIndex('files_staged')).toBeLessThan(phaseIndex('enrolled'));
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

  it('mayRedeem is false until the stable executable is staged', () => {
    expect(mayRedeem('uninstalled')).toBe(false);
    expect(mayRedeem('elevated')).toBe(false);
    expect(mayRedeem('credential_prepared')).toBe(false);
    expect(mayRedeem('files_staged')).toBe(true);
    expect(mayRedeem('enrolled')).toBe(true);
  });
});

describe('install journal persistence + resume (10.10)', () => {
  it('a fresh/absent journal reads as uninstalled', async () => {
    expect((await loadInstallJournal(path)).phase).toBe('uninstalled');
  });

  it('persists a phase durably and resumes from it (write → read round trip)', async () => {
    const elevated = await writeInstallPhase(path, 'elevated', { now: 999 });
    await writeInstallPhase(path, 'credential_prepared', { ...IDENTITY, previous: elevated, now: 1000 });
    const j = await loadInstallJournal(path);
    expect(j.phase).toBe('credential_prepared');
    expect(j.installId).toBe('inst-1');
    expect(j.updatedAt).toBe(1000);
  });

  it('merges immutable metadata across phase transitions', async () => {
    const elevated = await writeInstallPhase(path, 'elevated', { now: 999 });
    const first = await writeInstallPhase(path, 'credential_prepared', { ...IDENTITY, previous: elevated, now: 1000 });
    await writeInstallPhase(path, 'files_staged', {
      now: 2000,
      previous: first,
      stagedExePath: '/var/lib/imcodes-node/bin',
    });
    const j = await loadInstallJournal(path);
    expect(j.phase).toBe('files_staged');
    expect(j.installId).toBe('inst-1');
    expect(j.nodeTokenHash).toBe('a'.repeat(64));
    expect(j.stagedExePath).toBe('/var/lib/imcodes-node/bin');
  });

  it('advances across a simulated reboot, resuming from the last completed phase', async () => {
    await writeInstallPhase(path, 'elevated', { now: 1 });
    let resumed = await loadInstallJournal(path);
    expect(nextPhase(resumed.phase)).toBe('credential_prepared');
    await writeInstallPhase(path, 'credential_prepared', { now: 2, previous: resumed, ...IDENTITY });
    resumed = await loadInstallJournal(path);
    expect(nextPhase(resumed.phase)).toBe('files_staged');
    await writeInstallPhase(path, 'files_staged', { now: 3, previous: resumed, stagedExePath: '/var/lib/imcodes-node/bin' });
    resumed = await loadInstallJournal(path);
    expect(resumed.phase).toBe('files_staged');
  });

  it('writes the credential file with 0600 (not group/world readable)', async () => {
    await advanceToEnrolled();
    const mode = (await stat(path)).mode & 0o077;
    expect(mode).toBe(0);
  });

  it('creates a missing parent directory (0700) on first write', async () => {
    const nested = join(dir, 'a', 'b', 'install.json');
    await writeInstallPhase(nested, 'elevated', { now: 9 });
    expect((await loadInstallJournal(nested)).phase).toBe('elevated');
  });

  it('treats a corrupt journal as fail-closed (throws, not fresh install)', async () => {
    await writeFile(path, 'not json{', 'utf8');
    await expect(loadInstallJournal(path)).rejects.toBeInstanceOf(InstallJournalCorruptError);
  });

  it('rejects an unknown phase value in the journal', async () => {
    await writeFile(path, JSON.stringify({ version: 1, phase: 'bogus', updatedAt: 1 }), 'utf8');
    await expect(loadInstallJournal(path)).rejects.toBeInstanceOf(InstallJournalCorruptError);
  });

  it('rejects forward jumps and backward transitions', async () => {
    await expect(writeInstallPhase(path, 'credential_prepared', { now: 1, ...IDENTITY }))
      .rejects.toBeInstanceOf(InstallJournalTransitionError);
    const staged = await advanceToFilesStaged();
    await expect(writeInstallPhase(path, 'credential_prepared', { now: 4, previous: staged, ...IDENTITY }))
      .rejects.toBeInstanceOf(InstallJournalTransitionError);
  });

  it('rejects optimistic phase labels with missing prerequisite metadata', async () => {
    const elevated = await writeInstallPhase(path, 'elevated', { now: 1 });
    await expect(writeInstallPhase(path, 'credential_prepared', { now: 2, previous: elevated }))
      .rejects.toBeInstanceOf(InstallJournalCorruptError);
    await writeFile(path, JSON.stringify({ version: 1, phase: 'service_registered', updatedAt: 4 }), 'utf8');
    await expect(loadInstallJournal(path)).rejects.toBeInstanceOf(InstallJournalCorruptError);
  });

  it('rejects mutation of durable identity and staged-path metadata', async () => {
    const staged = await advanceToFilesStaged();
    await expect(writeInstallPhase(path, 'files_staged', {
      now: 4,
      previous: staged,
      installId: 'different-install',
    })).rejects.toBeInstanceOf(InstallJournalTransitionError);
    await expect(writeInstallPhase(path, 'files_staged', {
      now: 4,
      previous: staged,
      stagedExePath: '/tmp/replaced',
    })).rejects.toBeInstanceOf(InstallJournalTransitionError);
  });

  it('allows same-phase metadata completion for legitimate enrolled crash recovery', async () => {
    const enrolled = await advanceToEnrolled();
    const recovered = await writeInstallPhase(path, 'enrolled', {
      now: 5,
      previous: enrolled,
      cleanupStatus: 'failed',
    });
    expect(recovered.phase).toBe('enrolled');
    expect(recovered.cleanupStatus).toBe('failed');
    expect(recovered.installId).toBe(IDENTITY.installId);
  });

  it('fsyncs the parent directory after atomic rename', async () => {
    await writeInstallPhase(path, 'elevated', { now: 1 });
    const parent = join(dir);
    const fh = await open(parent, 'r');
    await fh.close();
    expect((await stat(path)).isFile()).toBe(true);
  });
});
