import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const pkgRoot = '/tmp/imcodes-postinstall-sharp-repair-pkg';
const npmCli = '/tmp/imcodes-postinstall-sharp-repair-npm-cli.js';
const requiredDeps = ['sharp', 'detect-libc', 'semver', '@img/colour'];

function createPkgRoot() {
  rmSync(pkgRoot, { recursive: true, force: true });
  mkdirSync(pkgRoot, { recursive: true });
}

function writeDepPackage(dep: string) {
  const depDir = join(pkgRoot, 'node_modules', dep);
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: dep }));
}

async function importScriptExpectExit() {
  await expect(import('../../src/util/postinstall-sharp-repair.js')).rejects.toThrow('exit:0');
}

describe('postinstall sharp repair contracts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    createPkgRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(pkgRoot);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    delete process.env.npm_execpath;
    delete process.env.IMCODES_POSTINSTALL_DEBUG;
    spawnSyncMock.mockReturnValue({ status: 0, signal: null, error: undefined, stdout: Buffer.from(''), stderr: Buffer.from('') });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(pkgRoot, { recursive: true, force: true });
  });

  it('skips repair inside a development checkout', async () => {
    mkdirSync(join(pkgRoot, '.git'), { recursive: true });
    mkdirSync(join(pkgRoot, 'dist'), { recursive: true });

    await importScriptExpectExit();

    expect(console.log).toHaveBeenCalledWith('[imcodes:postinstall] dev checkout detected — skipping sharp repair');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('skips repair when the published package dist marker is absent', async () => {
    await importScriptExpectExit();

    expect(console.log).toHaveBeenCalledWith(`[imcodes:postinstall] no dist/ at cwd=${pkgRoot} — skipping`);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not spawn npm when every sharp runtime dependency is present', async () => {
    mkdirSync(join(pkgRoot, 'dist'), { recursive: true });
    for (const dep of requiredDeps) writeDepPackage(dep);

    await importScriptExpectExit();

    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('repairs missing sharp dependencies using npm_execpath through the current node binary', async () => {
    mkdirSync(join(pkgRoot, 'dist'), { recursive: true });
    mkdirSync(join(pkgRoot, 'node_modules', 'sharp'), { recursive: true });
    writeDepPackage('semver');
    process.env.npm_execpath = npmCli;

    await importScriptExpectExit();

    expect(existsSync(join(pkgRoot, 'node_modules', 'sharp'))).toBe(false);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      process.execPath,
      [npmCli, 'install', '--no-save', '--ignore-scripts', 'sharp@0.34.5'],
      expect.objectContaining({
        cwd: pkgRoot,
        shell: false,
      }),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('sharp subtree broken'));
    expect(console.error).toHaveBeenCalledWith('[imcodes:postinstall] sharp repair succeeded');
  });

  it('uses shell mode for Windows npm shims and logs non-fatal repair failures', async () => {
    mkdirSync(join(pkgRoot, 'dist'), { recursive: true });
    process.env.npm_execpath = 'C:\\nodejs\\npm.cmd';
    spawnSyncMock.mockReturnValueOnce({ status: 7, signal: null, error: undefined, stdout: Buffer.from(''), stderr: Buffer.from('') });
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    await importScriptExpectExit();

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'C:\\nodejs\\npm.cmd',
      ['install', '--no-save', '--ignore-scripts', 'sharp@0.34.5'],
      expect.objectContaining({ shell: true }),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('sharp repair FAILED'));
    platformSpy.mockRestore();
  });
});
