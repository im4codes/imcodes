import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('p2p-config-store', () => {
  let homeDir: string;
  let warnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'p2p-config-store-'));
    warnMock = vi.fn();
    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => homeDir,
    }));
    vi.doMock('../../src/util/logger.js', () => ({
      default: {
        info: vi.fn(),
        warn: warnMock,
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));
  });

  afterEach(async () => {
    vi.doUnmock('node:os');
    vi.doUnmock('../../src/util/logger.js');
    await rm(homeDir, { recursive: true, force: true });
  });

  it('reports a missing store file as a non-corrupt empty cache', async () => {
    const mod = await import('../../src/store/p2p-config-store.js');
    await expect(mod.getSavedP2pConfig('deck_proj_brain')).resolves.toBeUndefined();
    expect(mod.getP2pConfigStoreDiagnostics()).toEqual({
      path: join(homeDir, '.imcodes', 'p2p-config.json'),
      lastLoadIssue: 'missing_file',
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('rejects corrupted store files with diagnostics and an empty cache', async () => {
    const storeDir = join(homeDir, '.imcodes');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'p2p-config.json'), '{not-json', 'utf8');

    const mod = await import('../../src/store/p2p-config-store.js');
    await expect(mod.getSavedP2pConfig('deck_proj_brain')).resolves.toBeUndefined();
    expect(mod.getP2pConfigStoreDiagnostics().lastLoadIssue).toBe('corrupted_file');
    expect(warnMock).toHaveBeenCalledOnce();
  });

  it('rejects schema-invalid store files with diagnostics and an empty cache', async () => {
    const storeDir = join(homeDir, '.imcodes');
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, 'p2p-config.json'), JSON.stringify({ version: 1, configs: { deck_proj_brain: { rounds: 'bad' } } }), 'utf8');

    const mod = await import('../../src/store/p2p-config-store.js');
    await expect(mod.getSavedP2pConfig('deck_proj_brain')).resolves.toBeUndefined();
    expect(mod.getP2pConfigStoreDiagnostics().lastLoadIssue).toBe('validation_failed');
    expect(warnMock).toHaveBeenCalledOnce();
  });

  it('persists versioned config files atomically with updated values', async () => {
    const mod = await import('../../src/store/p2p-config-store.js');
    await mod.upsertSavedP2pConfig('deck_proj_brain', {
      sessions: { deck_proj_worker: { enabled: true, mode: 'audit' } },
      rounds: 2,
      updatedAt: 123,
    });

    const raw = await readFile(join(homeDir, '.imcodes', 'p2p-config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version: number; configs: Record<string, unknown> };
    expect(parsed.version).toBe(1);
    expect(parsed.configs.deck_proj_brain).toEqual({
      sessions: { deck_proj_worker: { enabled: true, mode: 'audit' } },
      rounds: 2,
      updatedAt: 123,
    });
  });
});
