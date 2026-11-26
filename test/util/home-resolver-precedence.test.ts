import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockedHome = vi.hoisted(() => ({ value: '/tmp/mock-os-home' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockedHome.value };
});

import { resolveImcodesHome } from '../../src/util/windows-daemon-lock.js';

describe('resolveImcodesHome precedence', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalImcodesHome = process.env.IMCODES_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalImcodesHome === undefined) delete process.env.IMCODES_HOME;
    else process.env.IMCODES_HOME = originalImcodesHome;
  });

  it('keeps the mocked os.homedir authoritative on POSIX when HOME differs', () => {
    delete process.env.IMCODES_HOME;
    process.env.HOME = '/tmp/unrelated-process-home';
    process.env.USERPROFILE = '/tmp/unrelated-userprofile';
    mockedHome.value = '/tmp/mock-os-home';

    expect(resolveImcodesHome()).toBe('/tmp/mock-os-home/.imcodes');
  });

  it('honors a Windows HOME override when USERPROFILE is the default', () => {
    delete process.env.IMCODES_HOME;
    process.env.HOME = 'C:\\scope\\home';
    process.env.USERPROFILE = 'C:\\Users\\admin';
    mockedHome.value = 'C:\\Users\\admin';

    expect(resolveImcodesHome()).toBe('C:\\scope\\home\\.imcodes');
  });

  it('resolves migrated store paths lazily after IMCODES_HOME changes', async () => {
    const firstHome = mkdtempSync(join(tmpdir(), 'imcodes-home-a-'));
    const secondHome = mkdtempSync(join(tmpdir(), 'imcodes-home-b-'));
    try {
      vi.resetModules();
      // Keep the mocked homedir and HOME aligned so this assertion exercises
      // IMCODES_HOME's production precedence rather than the legacy-test
      // mocked-homedir compatibility branch.
      mockedHome.value = firstHome;
      process.env.HOME = firstHome;
      process.env.USERPROFILE = firstHome;
      process.env.IMCODES_HOME = join(firstHome, '.imcodes');
      const { registerTempFile, flushTempFileStore } = await import('../../src/store/temp-file-store.js');

      process.env.IMCODES_HOME = join(secondHome, '.imcodes');
      process.env.HOME = secondHome;
      process.env.USERPROFILE = secondHome;
      mockedHome.value = secondHome;
      await registerTempFile({
        path: join(secondHome, 'payload.txt'),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        reason: 'sendKeys',
      });
      await flushTempFileStore();

      expect(existsSync(join(secondHome, '.imcodes', 'temp-files.json'))).toBe(true);
      expect(existsSync(join(firstHome, '.imcodes', 'temp-files.json'))).toBe(false);
    } finally {
      rmSync(firstHome, { recursive: true, force: true });
      rmSync(secondHome, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
