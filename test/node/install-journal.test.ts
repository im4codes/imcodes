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
  shouldFsyncInstallJournalParent,
  writeInstallPhase,
  InstallJournalCorruptError,
  InstallJournalTransitionError,
} from '../../src/node/install-journal.js';

let dir: string;
let path: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'deck-journal-')); path = join(dir, 'install.json'); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ARTIFACT = { sha256: 'd'.repeat(64), size: 8192 };
const IDENTITY = {
  installId: 'inst-1',
  nodeTokenHash: 'a'.repeat(64),
  sourceExePath: '/tmp/download/imcodes-node',
  sourceArtifact: ARTIFACT,
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
  it('skips unsupported directory fsync on Windows', () => {
    expect(shouldFsyncInstallJournalParent('win32')).toBe(false);
    expect(shouldFsyncInstallJournalParent('linux')).toBe(true);
    expect(shouldFsyncInstallJournalParent('darwin')).toBe(true);
  });

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

  describe('legacy v1 journal without sourceArtifact (already on disk)', () => {
    // The users in the incident screenshot already have a journal written by a
    // build that predates `sourceArtifact`. It sits at credential_prepared or
    // files_staged with installId/nodeTokenHash/sourceExePath and nothing else.
    // If loading such a journal is refused, the upgrade dies before the new
    // download is ever inspected — strictly worse than the original bug.
    const LEGACY_A = 'C:\\Users\\k\\Downloads\\imcodes-node.exe';
    const LEGACY_B = 'C:\\Users\\k\\Downloads\\imcodes-node (1).exe';

    async function writeLegacyJournal(phase: string, extra: Record<string, unknown> = {}) {
      await writeFile(path, JSON.stringify({
        version: 1,
        phase,
        updatedAt: 1,
        installId: 'inst-legacy',
        nodeTokenHash: 'a'.repeat(64),
        sourceExePath: LEGACY_A,
        ...extra,
      }));
    }

    it('loads a legacy credential_prepared journal instead of refusing it', async () => {
      await writeLegacyJournal('credential_prepared');
      const journal = await loadInstallJournal(path);
      expect(journal.phase).toBe('credential_prepared');
      expect(journal.installId).toBe('inst-legacy');
      expect(journal.sourceArtifact).toBeUndefined();
    });

    it('loads a legacy files_staged journal instead of refusing it', async () => {
      await writeLegacyJournal('files_staged', { stagedExePath: 'C:\\Program Files\\imcodes-node\\bin.exe' });
      const journal = await loadInstallJournal(path);
      expect(journal.phase).toBe('files_staged');
      expect(journal.sourceArtifact).toBeUndefined();
    });

    it('adopts the verified artifact and the new download path in one atomic write', async () => {
      await writeLegacyJournal('credential_prepared');
      const legacy = await loadInstallJournal(path);
      const adopted = await writeInstallPhase(path, 'credential_prepared', {
        now: 2,
        previous: legacy,
        installId: 'inst-legacy',
        nodeTokenHash: 'a'.repeat(64),
        sourceExePath: LEGACY_B,
        sourceArtifact: ARTIFACT,
      });
      expect(adopted.sourceExePath).toBe(LEGACY_B);
      expect(adopted.sourceArtifact).toEqual(ARTIFACT);
      // Persisted, not just returned.
      const reread = await loadInstallJournal(path);
      expect(reread.sourceArtifact).toEqual(ARTIFACT);
      expect(reread.sourceExePath).toBe(LEGACY_B);
    });

    it('refuses adoption when the durable token differs', async () => {
      await writeLegacyJournal('credential_prepared');
      const legacy = await loadInstallJournal(path);
      await expect(writeInstallPhase(path, 'credential_prepared', {
        now: 2,
        previous: legacy,
        nodeTokenHash: 'b'.repeat(64),
        sourceExePath: LEGACY_B,
        sourceArtifact: ARTIFACT,
      })).rejects.toThrow(/immutable field changed: nodeTokenHash/);
    });

    it('refuses adoption after the install is enrolled', async () => {
      await writeLegacyJournal('enrolled', {
        stagedExePath: 'C:\\Program Files\\imcodes-node\\bin.exe',
        serverId: 'srv-1',
      });
      const legacy = await loadInstallJournal(path);
      await expect(writeInstallPhase(path, 'enrolled', {
        now: 2,
        previous: legacy,
        sourceExePath: LEGACY_B,
        sourceArtifact: ARTIFACT,
      })).rejects.toThrow(/may not change after files_staged/);
    });

    it('refuses adoption that also mutates the staged target', async () => {
      const receipt = {
        path: 'C:\\Program Files\\imcodes-node\\bin.exe',
        size: 4096,
        sha256: '1'.repeat(64),
        sourceIdentity: { dev: 1, ino: 2, size: 4096, mtimeMs: 1, ctimeMs: 1 },
        stagedIdentity: { dev: 1, ino: 3, size: 4096, mtimeMs: 2, ctimeMs: 2 },
      };
      await writeLegacyJournal('files_staged', { stagedExePath: receipt.path, stagedReceipt: receipt });
      const legacy = await loadInstallJournal(path);
      await expect(writeInstallPhase(path, 'files_staged', {
        now: 2,
        previous: legacy,
        sourceExePath: LEGACY_B,
        sourceArtifact: ARTIFACT,
        stagedReceipt: { ...receipt, path: 'C:\\Temp\\evil.exe' },
      })).rejects.toThrow(/staged receipt must describe the pinned staged target/);
    });

    it('pins the adopted artifact: a later different package is refused', async () => {
      await writeLegacyJournal('credential_prepared');
      const legacy = await loadInstallJournal(path);
      const adopted = await writeInstallPhase(path, 'credential_prepared', {
        now: 2, previous: legacy, sourceExePath: LEGACY_B, sourceArtifact: ARTIFACT,
      });
      await expect(writeInstallPhase(path, 'credential_prepared', {
        now: 3, previous: adopted, sourceArtifact: { sha256: 'e'.repeat(64), size: ARTIFACT.size },
      })).rejects.toThrow(/immutable field changed: sourceArtifact/);
    });
  });

  describe('source path drift vs tamper resistance', () => {
    // The download LOCATION moves on a legitimate retry; the BYTES do not.
    // `sourceArtifact` is therefore the invariant, and the path may migrate
    // only inside the interrupted-install retry window and only when the new
    // download is byte-for-byte the artifact this install already committed to.
    const DOWNLOAD_A = 'C:\\Users\\k\\Downloads\\imcodes-node.exe';
    const DOWNLOAD_B = 'C:\\Users\\k\\Downloads\\imcodes-node (1).exe';

    async function preparedAt(sourceExePath = DOWNLOAD_A) {
      const elevated = await writeInstallPhase(path, 'elevated', { now: 1 });
      return writeInstallPhase(path, 'credential_prepared', {
        now: 2, previous: elevated, ...IDENTITY, sourceExePath,
      });
    }

    it('fresh install records both the path and the artifact identity', async () => {
      const prepared = await preparedAt();
      expect(prepared.sourceExePath).toBe(DOWNLOAD_A);
      expect(prepared.sourceArtifact).toEqual(ARTIFACT);
    });

    it('same-token retry from the SAME path is accepted', async () => {
      const prepared = await preparedAt();
      const retry = await writeInstallPhase(path, 'credential_prepared', {
        now: 3, previous: prepared, ...IDENTITY, sourceExePath: DOWNLOAD_A,
      });
      expect(retry.sourceExePath).toBe(DOWNLOAD_A);
    });

    it('adopts a " (1).exe" re-download of the identical artifact inside the retry window', async () => {
      const prepared = await preparedAt();
      const retry = await writeInstallPhase(path, 'credential_prepared', {
        now: 3, previous: prepared, ...IDENTITY, sourceExePath: DOWNLOAD_B,
      });
      expect(retry.sourceExePath).toBe(DOWNLOAD_B);
      expect(retry.sourceArtifact).toEqual(ARTIFACT);
      expect(retry.installId).toBe(IDENTITY.installId);
    });

    it('survives a crash between phases and still adopts the re-download on resume', async () => {
      await preparedAt();
      // Simulated crash: nothing in memory, the journal is re-read from disk.
      const resumed = await loadInstallJournal(path);
      expect(resumed.sourceExePath).toBe(DOWNLOAD_A);
      const retry = await writeInstallPhase(path, 'credential_prepared', {
        now: 4, previous: resumed, ...IDENTITY, sourceExePath: DOWNLOAD_B,
      });
      expect(retry.sourceExePath).toBe(DOWNLOAD_B);
    });

    it('refuses a path change once the install is enrolled (late malicious source)', async () => {
      const prepared = await preparedAt();
      const staged = await writeInstallPhase(path, 'files_staged', {
        now: 3, previous: prepared, stagedExePath: 'C:\\Program Files\\imcodes-node\\bin.exe',
      });
      const enrolled = await writeInstallPhase(path, 'enrolled', {
        now: 4, previous: staged, serverId: 'srv-1',
      });
      await expect(writeInstallPhase(path, 'enrolled', {
        now: 5, previous: enrolled, ...IDENTITY, sourceExePath: DOWNLOAD_B,
      })).rejects.toThrow(/may not change after files_staged/);
    });

    it('refuses a re-download whose bytes differ (package/publisher/hash mutation)', async () => {
      const prepared = await preparedAt();
      await expect(writeInstallPhase(path, 'credential_prepared', {
        now: 3,
        previous: prepared,
        ...IDENTITY,
        sourceExePath: DOWNLOAD_B,
        sourceArtifact: { sha256: 'e'.repeat(64), size: 8192 },
      })).rejects.toThrow(/immutable field changed: sourceArtifact/);
    });

    it('refuses a same-size re-download with a different digest', async () => {
      const prepared = await preparedAt();
      await expect(writeInstallPhase(path, 'credential_prepared', {
        now: 3,
        previous: prepared,
        sourceArtifact: { sha256: 'f'.repeat(64), size: ARTIFACT.size },
      })).rejects.toThrow(/immutable field changed: sourceArtifact/);
    });

    it('refuses a path change that arrives without any artifact evidence', async () => {
      const prepared = await preparedAt();
      await expect(writeInstallPhase(path, 'credential_prepared', {
        now: 3, previous: prepared, sourceExePath: DOWNLOAD_B,
      })).rejects.toThrow(/requires an identical verified source artifact/);
    });

    it('refuses a staged-target mutation (swapped service copy)', async () => {
      const prepared = await preparedAt();
      const receipt = {
        path: 'C:\\Program Files\\imcodes-node\\bin.exe',
        size: 4096,
        sha256: '1'.repeat(64),
        sourceIdentity: { dev: 1, ino: 2, size: 4096, mtimeMs: 1, ctimeMs: 1 },
        stagedIdentity: { dev: 1, ino: 3, size: 4096, mtimeMs: 2, ctimeMs: 2 },
      };
      const staged = await writeInstallPhase(path, 'files_staged', {
        now: 3,
        previous: prepared,
        stagedExePath: receipt.path,
        stagedReceipt: receipt,
      });
      // Refreshing the bytes AT the pinned target is a legitimate re-stage.
      const restaged = await writeInstallPhase(path, 'files_staged', {
        now: 4,
        previous: staged,
        stagedReceipt: { ...receipt, sha256: '2'.repeat(64) },
      });
      expect(restaged.stagedReceipt!.sha256).toBe('2'.repeat(64));
      // Redirecting the service somewhere else is not.
      await expect(writeInstallPhase(path, 'files_staged', {
        now: 5,
        previous: restaged,
        stagedReceipt: { ...receipt, path: 'C:\\Temp\\evil.exe' },
      })).rejects.toThrow(/staged receipt must describe the pinned staged target/);
    });

    it('keeps installId and nodeTokenHash immutable through a legitimate migration', async () => {
      const prepared = await preparedAt();
      const migrated = await writeInstallPhase(path, 'credential_prepared', {
        now: 3, previous: prepared, ...IDENTITY, sourceExePath: DOWNLOAD_B,
      });
      await expect(writeInstallPhase(path, 'credential_prepared', {
        now: 4, previous: migrated, installId: 'inst-2',
      })).rejects.toBeInstanceOf(InstallJournalTransitionError);
      await expect(writeInstallPhase(path, 'credential_prepared', {
        now: 5, previous: migrated, nodeTokenHash: 'b'.repeat(64),
      })).rejects.toBeInstanceOf(InstallJournalTransitionError);
    });
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
