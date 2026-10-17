import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Publishing capability state must not fail because the platform cannot fsync
 * a directory.
 *
 * The write path is: write temp -> fsync temp -> rename into place -> fsync the
 * containing directory. That last step makes the rename itself durable across
 * power loss on POSIX. Windows refuses it: `fsync` on a directory handle is
 * EPERM by design. The error escaped and failed the whole publish — and the
 * caller responds to a failed publish by clearing the authorization keys, so
 * every Windows node wiped its own capability state every 30 seconds,
 * re-requested a full snapshot, failed again, and never advanced its cursor.
 * Measured on a live node: `publish_failed` on capability.sync.snapshot paired
 * with `stale_revision` on capability.sync.authority, every 30s, indefinitely,
 * with the state directory left empty. Linux nodes were unaffected, which is
 * why exactly one node in the fleet stayed online.
 *
 * The bytes were already renamed into place when this fires, so the write had
 * completed; only the extra durability step was unavailable.
 */

const dirFsync = { code: 'EPERM' as string | null };

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    fsyncSync: (fd: number) => {
      // Reproduce the platform behaviour exactly: fsync of a DIRECTORY handle
      // fails, fsync of a file handle keeps working.
      if (real.fstatSync(fd).isDirectory() && dirFsync.code) {
        const error = new Error(`${dirFsync.code}: fsync`) as NodeJS.ErrnoException;
        error.code = dirFsync.code;
        throw error;
      }
      return real.fsyncSync(fd);
    },
  };
});

describe('capability sync survives a platform that cannot fsync a directory', () => {
  let home: string;
  const realPlatform = process.platform;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'imcodes-capsync-'));
    dirFsync.code = 'EPERM';
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    rmSync(home, { recursive: true, force: true });
  });

  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  it('still persists state when directory fsync reports EPERM, as Windows does', async () => {
    setPlatform('win32');
    const { __atomicWriteJsonForTests } = await import('../../src/capability/capability-sync-service.js');
    const target = join(home, 'nested', 'state.json');

    expect(
      () => __atomicWriteJsonForTests(target, { revision: 7, digest: 'abc' }),
      'a publish must not fail because the directory could not be fsynced',
    ).not.toThrow();

    // The whole point: the state is actually on disk and readable.
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ revision: 7, digest: 'abc' });
  });

  it('still surfaces a real fsync failure on a platform that supports it', async () => {
    setPlatform('linux');
    dirFsync.code = 'EIO';
    const { __atomicWriteJsonForTests } = await import('../../src/capability/capability-sync-service.js');
    // Losing durability silently is the bug this call exists to prevent, so on
    // a platform that CAN fsync a directory the failure must still propagate.
    expect(() => __atomicWriteJsonForTests(join(home, 's.json'), { a: 1 })).toThrow(/EIO/);
  });
});
