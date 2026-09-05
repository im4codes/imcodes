import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MACOS_AIDESK_APP_NAME,
  macosComputerUseAppBundleForExecutable,
  prepareMacosComputerUseRuntime,
  validateMacosComputerUseArchiveEntries,
  verifyMacosComputerUseExecutable,
  type MacosComputerUseRuntime,
  type MacosConsoleUser,
} from '../../src/node/macos-computer-use.js';
import { macosUserSessionLaunchctlArgs } from '../../src/node/user-session-launcher.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-macos-computer-use-test-'));
  dirs.push(dir);
  return dir;
}

async function writeExtractedApp(destinationRoot: string, executableBytes: string): Promise<void> {
  const app = join(destinationRoot, 'Open Computer Use.app');
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(join(app, 'Contents', '_CodeSignature'), { recursive: true });
  await writeFile(join(app, 'Contents', 'Info.plist'), '<plist>upstream-signed</plist>');
  await writeFile(join(app, 'Contents', '_CodeSignature', 'CodeResources'), 'developer-id-seal');
  await writeFile(join(app, 'Contents', 'MacOS', 'OpenComputerUse'), executableBytes, { mode: 0o755 });
}

async function writeExtractedAiDesk(destinationRoot: string, executableBytes: string): Promise<void> {
  const app = join(destinationRoot, MACOS_AIDESK_APP_NAME);
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(join(app, 'Contents', '_CodeSignature'), { recursive: true });
  await writeFile(join(app, 'Contents', 'Info.plist'), '<plist>aidesk-signed</plist>');
  await writeFile(join(app, 'Contents', '_CodeSignature', 'CodeResources'), 'imcodes-developer-id-seal');
  await writeFile(join(app, 'Contents', 'MacOS', 'aidesk-agent'), executableBytes, { mode: 0o755 });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('macOS Computer Use runtime boundary', () => {
  it('accepts only the exact executable inside a regular verified supported app bundle', async () => {
    const dir = await tempDir();
    await writeExtractedApp(dir, 'ocu-v1');
    const app = join(dir, 'Open Computer Use.app');
    const executable = join(app, 'Contents', 'MacOS', 'OpenComputerUse');
    const other = join(app, 'Contents', 'MacOS', 'other');
    await writeFile(other, 'not-the-authorized-entrypoint', { mode: 0o755 });
    const verify = vi.fn(async () => {});

    expect(macosComputerUseAppBundleForExecutable(executable)).toBe(app);
    await expect(verifyMacosComputerUseExecutable(executable, verify)).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledWith(app);
    await expect(verifyMacosComputerUseExecutable(other, verify))
      .rejects.toThrow('signed_macos_open_computer_use_helper_authenticity_failed');
  });

  it('rejects a missing, corrupt, or symlinked packaged app helper', async () => {
    const dir = await tempDir();
    await writeExtractedApp(dir, 'ocu-v1');
    const app = join(dir, 'Open Computer Use.app');
    const executable = join(app, 'Contents', 'MacOS', 'OpenComputerUse');

    await expect(verifyMacosComputerUseExecutable(executable, async () => {
      throw new Error('bad signature');
    })).rejects.toThrow('signed_macos_open_computer_use_helper_authenticity_failed');
    await rm(executable);
    await expect(verifyMacosComputerUseExecutable(executable, async () => {}))
      .rejects.toThrow('signed_macos_open_computer_use_helper_authenticity_failed');

    await rm(app, { recursive: true, force: true });
    await writeExtractedApp(join(dir, 'real'), 'ocu-v2');
    await symlink(join(dir, 'real', 'Open Computer Use.app'), app);
    await expect(verifyMacosComputerUseExecutable(executable, async () => {}))
      .rejects.toThrow('signed_macos_open_computer_use_helper_authenticity_failed');
  });

  it('migrates the legacy OCU runtime to the unified aiDesk.to application', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceArchive = join(dir, 'open-computer-use.app.zip');
    const runtimeRoot = join(dir, 'runtime');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceArchive, 'aidesk-archive', { mode: 0o644 });
    await writeExtractedApp(runtimeRoot, 'legacy-ocu');
    const runtime = await prepareMacosComputerUseRuntime(sourceNode, sourceArchive, {
      runtimeRoot,
      extractAppArchive: async (_archive, destination) => writeExtractedAiDesk(destination, 'aidesk-v1'),
      verifyCodeSignature: async () => {},
      verifyAppBundle: async () => {},
    });
    expect(runtime.openComputerUseExecutable).toBe(
      join(runtimeRoot, MACOS_AIDESK_APP_NAME, 'Contents', 'MacOS', 'aidesk-agent'),
    );
    expect(await readFile(runtime.openComputerUseExecutable, 'utf8')).toBe('aidesk-v1');
    await expect(lstat(join(runtimeRoot, 'Open Computer Use.app'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes the complete upstream-signed app without rebuilding or re-signing it', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceArchive = join(dir, 'open-computer-use.app.zip');
    const runtimeRoot = join(dir, 'runtime');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceArchive, 'archive-v1', { mode: 0o644 });
    const extractAppArchive = vi.fn(async (_archive: string, destination: string) => {
      await writeExtractedApp(destination, 'ocu-v1');
    });
    const verifyCodeSignature = vi.fn(async () => {});
    const verifyAppBundle = vi.fn(async () => {});

    const runtime = await prepareMacosComputerUseRuntime(sourceNode, sourceArchive, {
      runtimeRoot,
      extractAppArchive,
      verifyCodeSignature,
      verifyAppBundle,
    });

    expect(runtime.helperExecutable).toBe(join(runtimeRoot, 'imcodes-computer-use-helper'));
    expect(runtime.openComputerUseExecutable).toBe(
      join(runtimeRoot, 'Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse'),
    );
    expect(await readFile(runtime.helperExecutable, 'utf8')).toBe('node-v1');
    expect(await readFile(join(runtimeRoot, 'open-computer-use.app.zip'), 'utf8')).toBe('archive-v1');
    expect(await readFile(runtime.openComputerUseExecutable, 'utf8')).toBe('ocu-v1');
    expect(await readFile(
      join(runtimeRoot, 'Open Computer Use.app', 'Contents', '_CodeSignature', 'CodeResources'),
      'utf8',
    )).toBe('developer-id-seal');
    expect((await lstat(runtimeRoot)).mode & 0o777).toBe(0o755);
    expect((await lstat(runtime.helperExecutable)).mode & 0o777).toBe(0o755);
    expect((await lstat(join(runtimeRoot, 'open-computer-use.app.zip'))).mode & 0o777).toBe(0o644);
    expect((await lstat(runtime.openComputerUseExecutable)).mode & 0o777).toBe(0o755);
    expect(extractAppArchive).toHaveBeenCalledWith(sourceArchive, expect.stringContaining('.open-computer-use-extract-'));
    expect(verifyCodeSignature).toHaveBeenCalledWith(runtime.helperExecutable, false);
    expect(verifyAppBundle).toHaveBeenCalledWith(expect.stringMatching(/\.open-computer-use-extract-.+Open Computer Use\.app$/));
    expect(verifyAppBundle).toHaveBeenLastCalledWith(join(runtimeRoot, 'Open Computer Use.app'));
  });

  it('replaces changed node bytes but reuses an unchanged verified app archive', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceArchive = join(dir, 'open-computer-use.app.zip');
    const runtimeRoot = join(dir, 'runtime');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceArchive, 'archive-v1');
    const extractAppArchive = vi.fn(async (_archive: string, destination: string) => {
      await writeExtractedApp(destination, 'ocu-v1');
    });
    const verifyAppBundle = vi.fn(async () => {});
    const options = {
      runtimeRoot,
      extractAppArchive,
      verifyCodeSignature: async () => {},
      verifyAppBundle,
    };
    await prepareMacosComputerUseRuntime(sourceNode, sourceArchive, options);

    await writeFile(sourceNode, 'node-v2', { mode: 0o755 });
    const runtime = await prepareMacosComputerUseRuntime(sourceNode, sourceArchive, options);

    expect(await readFile(runtime.helperExecutable, 'utf8')).toBe('node-v2');
    expect(await readFile(runtime.openComputerUseExecutable, 'utf8')).toBe('ocu-v1');
    expect(extractAppArchive).toHaveBeenCalledOnce();
    expect(verifyAppBundle).toHaveBeenLastCalledWith(join(runtimeRoot, 'Open Computer Use.app'));
  });

  it('replaces the app when the signed archive changes', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceArchive = join(dir, 'open-computer-use.app.zip');
    const runtimeRoot = join(dir, 'runtime');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceArchive, 'archive-v1');
    const extractAppArchive = vi.fn(async (archive: string, destination: string) => {
      const version = await readFile(archive, 'utf8');
      await writeExtractedApp(destination, version === 'archive-v1' ? 'ocu-v1' : 'ocu-v2');
    });
    const options = {
      runtimeRoot,
      extractAppArchive,
      verifyCodeSignature: async () => {},
      verifyAppBundle: async () => {},
    };
    await prepareMacosComputerUseRuntime(sourceNode, sourceArchive, options);

    await writeFile(sourceArchive, 'archive-v2');
    const runtime = await prepareMacosComputerUseRuntime(sourceNode, sourceArchive, options);

    expect(await readFile(runtime.openComputerUseExecutable, 'utf8')).toBe('ocu-v2');
    expect(extractAppArchive).toHaveBeenCalledTimes(2);
  });

  it('rejects archive traversal and extra roots before extraction', () => {
    expect(() => validateMacosComputerUseArchiveEntries([
      'Open Computer Use.app/',
      'Open Computer Use.app/Contents/MacOS/OpenComputerUse',
    ])).not.toThrow();
    expect(() => validateMacosComputerUseArchiveEntries([
      'Open Computer Use.app/../outside',
    ])).toThrow('computer_use_app_archive_unsafe');
    expect(() => validateMacosComputerUseArchiveEntries([
      'another-root/payload',
    ])).toThrow('computer_use_app_archive_unsafe');
  });

  it('rejects symlinks injected into an extracted app tree', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceArchive = join(dir, 'open-computer-use.app.zip');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceArchive, 'archive-v1');

    await expect(prepareMacosComputerUseRuntime(sourceNode, sourceArchive, {
      runtimeRoot: join(dir, 'runtime'),
      extractAppArchive: async (_archive, destination) => {
        await writeExtractedApp(destination, 'ocu-v1');
        await symlink('/tmp', join(destination, 'Open Computer Use.app', 'Contents', 'Resources'));
      },
      verifyCodeSignature: async () => {},
      verifyAppBundle: async () => {},
    })).rejects.toThrow('computer_use_app_archive_unsafe');
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

    const args = macosUserSessionLaunchctlArgs(user, {
      executable: runtime.helperExecutable,
      args: ['--computer-use-helper', '--pipe', '/tmp/private.sock'],
      environment: [['IMCODES_COMPUTER_USE_EXE', runtime.openComputerUseExecutable]],
    });

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
    expect(macosUserSessionLaunchctlArgs(user, {
      executable: runtime.openComputerUseExecutable,
      args: ['doctor'],
    })).toEqual([
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

  it('refuses to reuse a runtime whose app executable is absent', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await chmod(sourceNode, 0o755);

    await expect(prepareMacosComputerUseRuntime(sourceNode, undefined, {
      runtimeRoot: join(dir, 'runtime'),
      verifyCodeSignature: async () => {},
      verifyAppBundle: async () => {},
    })).rejects.toThrow('computer_use_helper_not_installed');
  });

  it('rejects a symlinked public runtime root', async () => {
    const dir = await tempDir();
    const sourceNode = join(dir, 'source-node');
    const sourceArchive = join(dir, 'open-computer-use.app.zip');
    const target = join(dir, 'target');
    const runtimeRoot = join(dir, 'runtime-link');
    await writeFile(sourceNode, 'node-v1', { mode: 0o755 });
    await writeFile(sourceArchive, 'archive-v1');
    await mkdir(target);
    await symlink(target, runtimeRoot);

    await expect(prepareMacosComputerUseRuntime(sourceNode, sourceArchive, {
      runtimeRoot,
      extractAppArchive: async (_archive, destination) => writeExtractedApp(destination, 'ocu-v1'),
      verifyCodeSignature: async () => {},
      verifyAppBundle: async () => {},
    })).rejects.toThrow('computer_use_runtime_root_not_directory');
  });
});
