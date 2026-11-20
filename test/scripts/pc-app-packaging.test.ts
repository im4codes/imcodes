import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error ESM hook module
import {
  MACOS_RELEASE_SIGNING_SCRIPT,
  resolveMacosAppBundlePath,
  resolveMacosNotaryState,
  runAfterSign,
} from '../../apps/pc-app/scripts/after-sign.mjs';
// @ts-expect-error ESM hook module
import {
  resolveWindowsSigningConfig,
  runWindowsSign,
  WINDOWS_SIGN_SCRIPT,
} from '../../apps/pc-app/scripts/win-sign.mjs';
// @ts-expect-error ESM config module
import {
  createPcAppElectronBuilderConfig,
  PC_APP_AFTER_SIGN_HOOK,
  PC_APP_MAC_ICON,
  PC_APP_MAC_NESTED_BINARIES,
  PC_APP_PNG_ICON,
  PC_APP_WIN_ICON,
  PC_APP_WIN_SIGN_HOOK,
  resolveMacosSigningOptions,
} from '../../apps/pc-app/electron-builder.config.mjs';
// @ts-expect-error ESM script module
import {
  buildPcAppNodeExeEnv,
  parseBuildPcAppArgs,
  resolveElectronBuilderMacAppPath,
  stagePcAppResources,
  verifyPackagedMacosApp,
  verifyPackagedWindowsDir,
} from '../../scripts/build-pc-app.mjs';
// @ts-expect-error ESM script module
import {
  BUNDLED_TMUX_REQUIRED_TERMS,
  BUNDLED_TMUX_SOURCES,
} from '../../scripts/build-macos-bundled-tmux.mjs';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'imcodes-pc-app-pkg-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTmuxFixture(root: string): string {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'licenses'), { recursive: true });
  writeFileSync(join(root, 'bin', 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const term of BUNDLED_TMUX_REQUIRED_TERMS as readonly string[]) {
    const sub = term.charCodeAt(0).toString(16).padStart(2, '0');
    mkdirSync(join(root, 'terminfo', sub), { recursive: true });
    writeFileSync(join(root, 'terminfo', sub, term), Buffer.from([0x1a, 0x01, 0x00, 0x00]));
  }
  for (const pkg of Object.values(BUNDLED_TMUX_SOURCES) as Array<{ licenseOutFilename: string }>) {
    writeFileSync(join(root, 'licenses', pkg.licenseOutFilename), `${pkg.licenseOutFilename}\n`, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('PC App V1 Phase D packaging, afterSign, and verification', () => {
  it('afterSign invokes macos-release-signing.mjs notarize directly with .app path (never .zip or .dmg)', async () => {
    const work = makeTempDir();
    const appPath = join(work, 'IM.codes.app');
    mkdirSync(join(appPath, 'Contents'), { recursive: true });

    const execMock = vi.fn();
    const result = await runAfterSign(
      {
        electronPlatformName: 'darwin',
        appOutDir: work,
        packager: { appInfo: { productFilename: 'IM.codes' } },
      },
      {
        execFileSync: execMock,
        nodeExecPath: '/usr/local/bin/node',
        env: {
          IMCODES_MACOS_NOTARY_KEY_PATH: '/tmp/notary.p8',
          IMCODES_MACOS_NOTARY_KEY_ID: 'KEY123',
          IMCODES_MACOS_NOTARY_ISSUER: 'ISSUER456',
        },
      },
    );

    expect(result).toEqual({ skipped: false, notarized: true, appPath });
    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execMock.mock.calls[0]!;
    expect(cmd).toBe('/usr/local/bin/node');
    expect(args).toEqual([MACOS_RELEASE_SIGNING_SCRIPT, 'notarize', appPath]);
    expect(args[2]).toMatch(/\.app$/);
    expect(args[2]).not.toMatch(/\.(zip|dmg)$/i);
  });

  it('afterSign skips cleanly when unconfigured, rejects partial config, and fails closed when require-notarize is set', async () => {
    const work = makeTempDir();
    const appPath = join(work, 'IM.codes.app');
    mkdirSync(appPath, { recursive: true });
    const ctx = {
      electronPlatformName: 'darwin',
      appOutDir: work,
      packager: { appInfo: { productFilename: 'IM.codes' } },
    };

    const execMock = vi.fn();
    const skipped = await runAfterSign(ctx, { execFileSync: execMock, env: {} });
    expect(skipped).toMatchObject({ skipped: true, reason: 'missing_notary_credentials', notarized: false });
    expect(execMock).not.toHaveBeenCalled();

    await expect(
      runAfterSign(ctx, {
        execFileSync: execMock,
        env: { IMCODES_MACOS_NOTARY_KEY_ID: 'ONLY_KEY_ID' },
      }),
    ).rejects.toThrow(/Partial macOS notarization config/);

    await expect(
      runAfterSign(ctx, {
        execFileSync: execMock,
        env: { IMCODES_PC_APP_REQUIRE_NOTARIZE: '1' },
      }),
    ).rejects.toThrow(/IMCODES_PC_APP_REQUIRE_NOTARIZE=1/);

    const winSkipped = await runAfterSign(
      { ...ctx, electronPlatformName: 'win32' },
      { execFileSync: execMock, env: { IMCODES_PC_APP_REQUIRE_NOTARIZE: '1' } },
    );
    expect(winSkipped).toEqual({ skipped: true, reason: 'non-darwin', notarized: false });

    const erroringExec = vi.fn(() => {
      throw new Error('notarytool rejected bundle');
    });
    await expect(
      runAfterSign(ctx, {
        execFileSync: erroringExec,
        env: {
          IMCODES_MACOS_NOTARY_KEY_PATH: '/tmp/notary.p8',
          IMCODES_MACOS_NOTARY_KEY_ID: 'KEY123',
          IMCODES_MACOS_NOTARY_ISSUER: 'ISSUER456',
        },
      }),
    ).rejects.toThrow(/notarytool rejected bundle/);

    expect(resolveMacosAppBundlePath(ctx)).toBe(appPath);
    expect(resolveMacosNotaryState({}).configured).toBe(false);
  });

  it('win-sign delegates to windows-sign-release-artifact.ps1 and validates paired thumbprint/sha256', async () => {
    const execMock = vi.fn();
    const exePath = 'C:\\build\\IM.codes-Setup-0.1.0-x64.exe';

    const skipped = await runWindowsSign({ path: exePath }, { execFileSync: execMock, env: {} });
    expect(skipped).toEqual({ skipped: true, signed: false, path: exePath });
    expect(execMock).not.toHaveBeenCalled();

    expect(() =>
      resolveWindowsSigningConfig({ IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT: 'a'.repeat(40) }),
    ).toThrow(/requires both/);

    await expect(
      runWindowsSign({ path: exePath }, { execFileSync: execMock, env: { IMCODES_PC_APP_REQUIRE_SIGNING: '1' } }),
    ).rejects.toThrow(/IMCODES_PC_APP_REQUIRE_SIGNING=1/);

    const thumbprint = '0123456789abcdef0123456789abcdef01234567';
    const sha256 = 'a'.repeat(64);
    const signed = await runWindowsSign(
      { path: exePath },
      {
        execFileSync: execMock,
        env: {
          SystemRoot: 'C:\\Windows',
          IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT: thumbprint,
          IMCODES_WINDOWS_SIGNING_CERT_SHA256: sha256,
        },
      },
    );
    expect(signed).toEqual({ skipped: false, signed: true, path: exePath });
    expect(execMock).toHaveBeenCalledTimes(1);
    const [psExe, psArgs] = execMock.mock.calls[0]!;
    expect(psExe).toContain('powershell.exe');
    expect(psArgs).toContain(WINDOWS_SIGN_SCRIPT);
    expect(psArgs).toContain('-Mode');
    expect(psArgs).toContain('Sign');
    expect(psArgs).toContain(exePath);
    expect(psArgs).toContain(thumbprint);
    expect(psArgs).toContain(sha256);
  });

  it('configures electron-builder with explicit nested binaries, single afterSign notarization, and per-user Windows NSIS', () => {
    const releaseSha1 = 'A'.repeat(40);
    const releaseCfg = createPcAppElectronBuilderConfig({
      macArch: 'universal',
      version: '0.1.0',
      env: { IMCODES_MACOS_SIGNING_IDENTITY: releaseSha1 },
    });

    expect(releaseCfg.mac.notarize).toBe(false);
    expect(releaseCfg.afterSign).toBe(PC_APP_AFTER_SIGN_HOOK);
    expect(releaseCfg.mac.binaries).toEqual([
      'Contents/Resources/bin/tmux',
      'Contents/Resources/imcodes',
    ]);
    expect(PC_APP_MAC_NESTED_BINARIES).toEqual(releaseCfg.mac.binaries);
    expect(releaseCfg.mac.identity).toBe(releaseSha1);
    expect(releaseCfg.mac.hardenedRuntime).toBe(true);
    expect(releaseCfg.mac.target).toEqual([{ target: 'dmg', arch: ['universal'] }]);
    expect(releaseCfg.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(releaseCfg.nsis.perMachine).toBe(false);
    expect(releaseCfg.win.signtoolOptions.sign).toBe(PC_APP_WIN_SIGN_HOOK);
    expect(releaseCfg.mac.icon).toBe(PC_APP_MAC_ICON);
    expect(releaseCfg.win.icon).toBe(PC_APP_WIN_ICON);
    expect(releaseCfg.files).toContain('build/icon.png');

    // Icon assets exist, carry valid magic headers (icns / ICO / PNG), and stay well under 2MB combined
    const icnsBuf = readFileSync(PC_APP_MAC_ICON);
    const icoBuf = readFileSync(PC_APP_WIN_ICON);
    const pngBuf = readFileSync(PC_APP_PNG_ICON);
    expect(icnsBuf.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icoBuf.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));
    expect(pngBuf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(icnsBuf.length + icoBuf.length + pngBuf.length).toBeLessThan(2 * 1024 * 1024);

    const localOpts = resolveMacosSigningOptions({});
    expect(localOpts).toEqual({ identity: '-', hardenedRuntime: false, mode: 'ad-hoc' });
    expect(() => resolveMacosSigningOptions({ IMCODES_MACOS_SIGNING_IDENTITY: 'bad' })).toThrow(/40-character/);
    expect(() => resolveMacosSigningOptions({ IMCODES_PC_APP_REQUIRE_SIGNING: '1' })).toThrow(/REQUIRE_SIGNING=1/);
  });

  it('strips IMCODES_REQUIRE_COMPUTER_USE_HELPER and stages macOS/Windows extraResources cleanly', () => {
    const cleanEnv = buildPcAppNodeExeEnv({
      IMCODES_REQUIRE_COMPUTER_USE_HELPER: '1',
      PATH: '/usr/bin',
    });
    expect(cleanEnv.IMCODES_REQUIRE_COMPUTER_USE_HELPER).toBeUndefined();
    expect(cleanEnv.PATH).toBe('/usr/bin');

    const work = makeTempDir();
    const macExe = join(work, 'imcodes-node-macos');
    writeFileSync(macExe, '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });
    const tmuxSrc = createTmuxFixture(join(work, 'tmux-src'));
    const macStage = join(work, 'stage-mac');

    const stagedMac = stagePcAppResources({
      platform: 'darwin',
      nodeExePath: macExe,
      tmuxDir: tmuxSrc,
      stageDir: macStage,
    });
    expect(existsSync(stagedMac.imcodesPath)).toBe(true);
    expect(existsSync(stagedMac.tmuxBin)).toBe(true);
    expect(existsSync(join(stagedMac.licensesDir, 'tmux-ISC.txt'))).toBe(true);

    // Missing imcodes fails closed
    expect(() =>
      stagePcAppResources({
        platform: 'darwin',
        nodeExePath: join(work, 'missing-imcodes'),
        tmuxDir: tmuxSrc,
        stageDir: macStage,
      }),
    ).toThrow(/Standalone daemon binary missing/);

    // Missing bin/tmux fails closed
    const badTmux = makeTempDir();
    expect(() =>
      stagePcAppResources({
        platform: 'darwin',
        nodeExePath: macExe,
        tmuxDir: badTmux,
        stageDir: macStage,
      }),
    ).toThrow(/Bundled tmux binary missing/);

    const winExe = join(work, 'imcodes-node.exe');
    writeFileSync(winExe, 'MZ-fake-exe', 'utf8');
    const stagedWin = stagePcAppResources({
      platform: 'win32',
      nodeExePath: winExe,
      stageDir: join(work, 'stage-win'),
    });
    expect(existsSync(stagedWin.imcodesPath)).toBe(true);
  });

  it('verifyPackagedMacosApp enforces Gate 1-4, nested codesign, optional stapler validate, and clean daemon run', () => {
    const work = makeTempDir();
    const appPath = join(work, 'IM.codes.app');
    const resDir = join(appPath, 'Contents', 'Resources');
    createTmuxFixture(resDir);
    const bundledImcodes = join(resDir, 'imcodes');
    writeFileSync(bundledImcodes, '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = vi.fn((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === '/usr/bin/lipo') return 'arm64 x86_64\n';
      if (cmd === '/usr/bin/otool') {
        return `${join(resDir, 'bin', 'tmux')}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n`;
      }
      if (cmd === bundledImcodes) return '0.1.0\n';
      return '';
    });

    const report = verifyPackagedMacosApp(appPath, {
      execFn: mockExec,
      requireNotarized: true,
    });
    expect(report.codesignVerified).toBe(true);
    expect(report.stapleValidated).toBe(true);
    expect(report.daemonVersion).toBe('0.1.0');
    expect(calls.some((c) => c.cmd === 'codesign' && c.args.includes(join(resDir, 'bin', 'tmux')))).toBe(true);
    expect(calls.some((c) => c.cmd === 'codesign' && c.args.includes(bundledImcodes))).toBe(true);
    expect(calls.some((c) => c.cmd === 'codesign' && c.args.includes('--deep') && c.args.includes(appPath))).toBe(true);
    expect(calls.some((c) => c.cmd === 'xcrun' && c.args[0] === 'stapler' && c.args[1] === 'validate')).toBe(true);

    // Negative: codesign Gate 3 failure propagates
    const failCodesignExec = vi.fn((cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/lipo') return 'arm64 x86_64\n';
      if (cmd === '/usr/bin/otool') {
        return `${join(resDir, 'bin', 'tmux')}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n`;
      }
      if (cmd === 'codesign' && args.includes('--deep')) {
        throw new Error('code object is not signed at all');
      }
      if (cmd === bundledImcodes) return '0.1.0\n';
      return '';
    });
    expect(() => verifyPackagedMacosApp(appPath, { execFn: failCodesignExec })).toThrow(/not signed/);

    // Negative: missing imcodes fails closed
    rmSync(bundledImcodes);
    expect(() => verifyPackagedMacosApp(appPath, { execFn: mockExec })).toThrow(/Bundled imcodes daemon missing/);

    // Negative: missing execution bit fails closed
    writeFileSync(bundledImcodes, '#!/bin/sh\necho 0.1.0\n', { mode: 0o644 });
    chmodSync(bundledImcodes, 0o644);
    expect(() => verifyPackagedMacosApp(appPath, { execFn: mockExec })).toThrow();
  });

  it('verifyPackagedWindowsDir validates bundled imcodes.exe, installer exe, and Authenticode verification', () => {
    const work = makeTempDir();
    const winDir = join(work, 'win-unpacked');
    mkdirSync(join(winDir, 'resources'), { recursive: true });
    writeFileSync(join(winDir, 'IM.codes.exe'), 'MZ-app', 'utf8');
    writeFileSync(join(winDir, 'resources', 'imcodes.exe'), 'MZ-daemon', 'utf8');
    const installerExe = join(work, 'IM.codes-Setup-0.1.0-x64.exe');
    writeFileSync(installerExe, 'MZ-installer', 'utf8');

    const execMock = vi.fn(() => '0.1.0\n');
    const result = verifyPackagedWindowsDir(winDir, {
      installerExePath: installerExe,
      expectedSignerSha256: 'b'.repeat(64),
      execFn: execMock,
      env: { ...process.env, SystemRoot: 'C:\\Windows' },
    });
    expect(result.appExe).toBe(join(winDir, 'IM.codes.exe'));
    expect(result.bundledDaemon).toBe(join(winDir, 'resources', 'imcodes.exe'));
    expect(result.installerExePath).toBe(installerExe);
    expect(
      execMock.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('Verify')),
    ).toHaveLength(3);

    rmSync(join(winDir, 'resources', 'imcodes.exe'));
    expect(() => verifyPackagedWindowsDir(winDir)).toThrow(/Bundled imcodes\.exe missing/);
  });

  it('wires build-pc-app.yml without IMCODES_REQUIRE_COMPUTER_USE_HELPER=1 and keeps explicit job timeouts & CLI parsing', () => {
    const raw = readFileSync('.github/workflows/build-pc-app.yml', 'utf8');
    expect(raw).not.toContain('IMCODES_REQUIRE_COMPUTER_USE_HELPER');
    expect(raw).toContain('scripts/build-macos-bundled-tmux.mjs');
    expect(raw).toContain('scripts/build-pc-app.mjs');
    expect(raw).toContain('scripts/macos-release-signing.mjs cleanup');

    const parsed = parseYaml(raw) as { jobs: Record<string, { 'timeout-minutes'?: number; 'runs-on'?: string }> };
    expect(Object.keys(parsed.jobs).sort()).toEqual(['build-macos', 'build-windows']);
    expect(parsed.jobs['build-macos']['runs-on']).toBe('macos-15');
    expect(parsed.jobs['build-macos']['timeout-minutes']).toBeGreaterThan(0);
    expect(parsed.jobs['build-windows']['runs-on']).toBe('windows-2022');
    expect(parsed.jobs['build-windows']['timeout-minutes']).toBeGreaterThan(0);

    const parsedArgs = parseBuildPcAppArgs([
      '--platform', 'darwin',
      '--arch', 'universal',
      '--version', '0.1.0',
      '--require-notarize',
    ]);
    expect(parsedArgs.platform).toBe('darwin');
    expect(parsedArgs.arch).toBe('universal');
    expect(parsedArgs.requireSign).toBe(true);
    expect(parsedArgs.requireNotarize).toBe(true);
    expect(resolveElectronBuilderMacAppPath('/tmp/release', 'arm64')).toBe('/tmp/release/mac-arm64/IM.codes.app');
    expect(resolveElectronBuilderMacAppPath('/tmp/release', 'x64')).toBe('/tmp/release/mac/IM.codes.app');
    expect(resolveElectronBuilderMacAppPath('/tmp/release', 'universal')).toBe('/tmp/release/mac-universal/IM.codes.app');
  });
});
