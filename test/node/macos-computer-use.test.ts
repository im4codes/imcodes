import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  macosComputerUseDoctorArgs,
  macosComputerUseInfoPlist,
  macosUserSessionHelperArgs,
  prepareMacosComputerUseRuntime,
  type MacosComputerUseRuntime,
  type MacosConsoleUser,
} from '../../src/node/macos-computer-use.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-macos-computer-use-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('macOS Computer Use runtime boundary', () => {
  it('keeps the GUI runtime separate from protected credentials and publishes executable-only files', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceOcu = join(dir, 'source-ocu');
    const runtimeRoot = join(dir, 'runtime');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceOcu, 'ocu-v1', { mode: 0o755 });
    const signAppBundle = vi.fn(async () => {});
    const verifyCodeSignature = vi.fn(async () => {});

    const runtime = await prepareMacosComputerUseRuntime(sourceNode, sourceOcu, {
      runtimeRoot,
      signAppBundle,
      verifyCodeSignature,
    });

    expect(runtime.helperExecutable).toBe(join(runtimeRoot, 'imcodes-computer-use-helper'));
    expect(runtime.openComputerUseExecutable).toBe(
      join(runtimeRoot, 'Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse'),
    );
    expect(await readFile(runtime.helperExecutable, 'utf8')).toBe('node-v1');
    expect(await readFile(runtime.openComputerUseExecutable, 'utf8')).toBe('ocu-v1');
    expect((await lstat(runtimeRoot)).mode & 0o777).toBe(0o755);
    expect((await lstat(runtime.helperExecutable)).mode & 0o777).toBe(0o755);
    expect((await lstat(runtime.openComputerUseExecutable)).mode & 0o777).toBe(0o755);
    expect(signAppBundle).toHaveBeenCalledOnce();
    expect(verifyCodeSignature).toHaveBeenCalledWith(runtime.helperExecutable, false);
    expect(verifyCodeSignature).toHaveBeenCalledWith(
      expect.stringMatching(/Open Computer Use\.app\..+\.tmp$/),
      true,
    );
  });

  it('replaces changed helper bytes but reuses an unchanged signed app bundle', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceOcu = join(dir, 'source-ocu');
    const runtimeRoot = join(dir, 'runtime');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceOcu, 'ocu-v1', { mode: 0o755 });
    const signAppBundle = vi.fn(async () => {});
    const verifyCodeSignature = vi.fn(async () => {});
    await prepareMacosComputerUseRuntime(sourceNode, sourceOcu, {
      runtimeRoot,
      signAppBundle,
      verifyCodeSignature,
    });

    await writeFile(sourceNode, 'node-v2', { mode: 0o755 });
    const runtime = await prepareMacosComputerUseRuntime(sourceNode, sourceOcu, {
      runtimeRoot,
      signAppBundle,
      verifyCodeSignature,
    });

    expect(await readFile(runtime.helperExecutable, 'utf8')).toBe('node-v2');
    expect(await readFile(runtime.openComputerUseExecutable, 'utf8')).toBe('ocu-v1');
    expect(signAppBundle).toHaveBeenCalledOnce();
    expect(verifyCodeSignature).toHaveBeenLastCalledWith(join(runtimeRoot, 'Open Computer Use.app'), true);
  });

  it('rebuilds the app bundle when the OCU helper changes', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceOcu = join(dir, 'source-ocu');
    const runtimeRoot = join(dir, 'runtime');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceOcu, 'ocu-v1', { mode: 0o755 });
    const signAppBundle = vi.fn(async () => {});
    const verifyCodeSignature = vi.fn(async () => {});
    await prepareMacosComputerUseRuntime(sourceNode, sourceOcu, {
      runtimeRoot,
      signAppBundle,
      verifyCodeSignature,
    });

    await writeFile(sourceOcu, 'ocu-v2', { mode: 0o755 });
    const runtime = await prepareMacosComputerUseRuntime(sourceNode, sourceOcu, {
      runtimeRoot,
      signAppBundle,
      verifyCodeSignature,
    });

    expect(await readFile(runtime.openComputerUseExecutable, 'utf8')).toBe('ocu-v2');
    expect(signAppBundle).toHaveBeenCalledTimes(2);
  });

  it('uses the login GUI bootstrap namespace and drops privileges without exposing credentials', () => {
    const user: MacosConsoleUser = {
      name: 'desktop-user',
      uid: 501,
      gid: 20,
      home: '/Users/desktop-user',
      tempDir: '/private/var/folders/user/T/',
    };
    const runtime: MacosComputerUseRuntime = {
      helperExecutable: '/Library/Application Support/imcodes-node-computer-use/imcodes-computer-use-helper',
      openComputerUseExecutable: '/Library/Application Support/imcodes-node-computer-use/Open Computer Use.app/Contents/MacOS/OpenComputerUse',
    };

    const args = macosUserSessionHelperArgs(user, runtime, '/tmp/private.sock');

    expect(args.slice(0, 7)).toEqual([
      'asuser',
      '501',
      '/usr/bin/sudo',
      '-n',
      '-u',
      'desktop-user',
      '/usr/bin/env',
    ]);
    expect(args).toContain('HOME=/Users/desktop-user');
    expect(args).toContain('TMPDIR=/private/var/folders/user/T/');
    expect(args).toContain(`IMCODES_COMPUTER_USE_EXE=${runtime.openComputerUseExecutable}`);
    expect(args).toContain(runtime.helperExecutable);
    expect(args).not.toContain('/Library/Application Support/imcodes-node/credential.json');
    expect(macosComputerUseDoctorArgs(user, runtime)).toEqual([
      'asuser',
      '501',
      '/usr/bin/sudo',
      '-n',
      '-u',
      'desktop-user',
      '/usr/bin/env',
      'HOME=/Users/desktop-user',
      'TMPDIR=/private/var/folders/user/T/',
      runtime.openComputerUseExecutable,
      'doctor',
    ]);
  });

  it('builds the app-scoped permission bundle identity expected by Open Computer Use', () => {
    const plist = macosComputerUseInfoPlist();
    expect(plist).toContain('<string>com.ifuryst.opencomputeruse</string>');
    expect(plist).toContain('<string>OpenComputerUse</string>');
    expect(plist).toContain('<key>LSUIElement</key><true/>');
  });

  it('refuses to reuse a runtime whose app executable is absent', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await chmod(sourceNode, 0o755);

    await expect(prepareMacosComputerUseRuntime(sourceNode, undefined, {
      runtimeRoot: join(dir, 'runtime'),
      signAppBundle: async () => {},
      verifyCodeSignature: async () => {},
    })).rejects.toThrow('computer_use_helper_not_installed');
  });

  it('rejects a symlinked public runtime root', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceOcu = join(dir, 'source-ocu');
    const target = join(dir, 'target');
    const runtimeRoot = join(dir, 'runtime-link');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceOcu, 'ocu-v1', { mode: 0o755 });
    await mkdir(target);
    await symlink(target, runtimeRoot);

    await expect(prepareMacosComputerUseRuntime(sourceNode, sourceOcu, {
      runtimeRoot,
      signAppBundle: async () => {},
      verifyCodeSignature: async () => {},
    })).rejects.toThrow('computer_use_runtime_root_not_directory');
  });
});
