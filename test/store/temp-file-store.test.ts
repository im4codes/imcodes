import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'imcodes-temp-files-'));
  vi.stubEnv('HOME', tempHome);
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  // Best-effort shutdown before removing temp HOME to avoid dangling timers/writes
  try {
    const mod = await import('../../src/store/temp-file-store.js');
    mod.shutdownTempFileStore();
  } catch {
    // ignore
  }
  vi.resetModules();
  rmSync(tempHome, { recursive: true, force: true });
});

describe('temp-file-store', () => {
  it('initializes cleanly when temp-files.json does not exist', async () => {
    const mod = await import('../../src/store/temp-file-store.js');
    await expect(mod.initTempFileStore()).resolves.toBeUndefined();

    const filePath = join(tempHome, 'created-after-missing.json');
    writeFileSync(filePath, 'hello');
    const now = Date.now();
    await mod.registerTempFile({
      path: filePath,
      createdAt: now,
      expiresAt: now + 30 * 60_000,
      reason: 'sendKeys',
    });
    await mod.flushTempFileStore();

    const storePath = join(tempHome, '.imcodes', 'temp-files.json');
    expect(existsSync(storePath)).toBe(true);
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { files: Record<string, unknown> };
    expect(raw.files[filePath]).toBeDefined();
  });

  it('initializes cleanly when temp-files.json is empty', async () => {
    const imcodesDir = join(tempHome, '.imcodes');
    const storePath = join(imcodesDir, 'temp-files.json');
    mkdirSync(imcodesDir, { recursive: true });
    writeFileSync(storePath, '', { encoding: 'utf8' });

    const mod = await import('../../src/store/temp-file-store.js');
    await expect(mod.initTempFileStore()).resolves.toBeUndefined();

    const filePath = join(tempHome, 'created-after-empty.txt');
    writeFileSync(filePath, 'hello');
    const now = Date.now();
    await mod.registerTempFile({
      path: filePath,
      createdAt: now,
      expiresAt: now + 30 * 60_000,
      reason: 'sandbox-ref-copy',
    });
    await mod.flushTempFileStore();

    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { files: Record<string, { reason: string }> };
    expect(raw.files[filePath]?.reason).toBe('sandbox-ref-copy');
  });

  it('persists tracked temp files under ~/.imcodes/temp-files.json', async () => {
    const filePath = join(tempHome, 'tracked.txt');
    writeFileSync(filePath, 'hello');

    const mod = await import('../../src/store/temp-file-store.js');
    const now = Date.now();
    await mod.registerTempFile({
      path: filePath,
      createdAt: now,
      expiresAt: now + 30 * 60_000,
      reason: 'sendKeys',
    });
    await mod.flushTempFileStore();

    const storePath = join(tempHome, '.imcodes', 'temp-files.json');
    expect(existsSync(storePath)).toBe(true);
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { files: Record<string, { reason: string }> };
    expect(raw.files[filePath]?.reason).toBe('sendKeys');
  });

  it('restores persisted entries and cleans expired files after module reload', async () => {
    const filePath = join(tempHome, 'expired.txt');
    writeFileSync(filePath, 'bye');

    {
      const mod = await import('../../src/store/temp-file-store.js');
      const now = Date.now();
      await mod.registerTempFile({
        path: filePath,
        createdAt: now - 10_000,
        expiresAt: now - 1_000,
        reason: 'sandbox-ref-copy',
      });
      await mod.flushTempFileStore();
      mod.shutdownTempFileStore();
    }

    vi.resetModules();

    const mod = await import('../../src/store/temp-file-store.js');
    await mod.initTempFileStore();
    await mod.flushTempFileStore();
    mod.shutdownTempFileStore();

    expect(existsSync(filePath)).toBe(false);
    const storePath = join(tempHome, '.imcodes', 'temp-files.json');
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { files: Record<string, unknown> };
    expect(raw.files[filePath]).toBeUndefined();
  });
});
