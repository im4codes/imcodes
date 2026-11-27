import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  DEFAULT_PC_APP_UPDATE_URL,
  PC_APP_AFTER_SIGN_HOOK,
  PC_APP_MAC_ICON,
  PC_APP_MAC_MLX_BINARY,
  PC_APP_MAC_NESTED_BINARIES,
  PC_APP_PNG_ICON,
  PC_APP_WIN_ICON,
  PC_APP_WIN_SIGN_HOOK,
  resolveMacosSigningOptions,
  resolvePcAppUpdateUrl,
} from '../../apps/pc-app/electron-builder.config.mjs';
// @ts-expect-error ESM script module
import {
  buildLinuxSpeechHelper,
  buildMacosSpeechHelper,
  buildMacosSpeechMlxHelper,
  buildPcAppNodeExeEnv,
  buildWindowsSpeechHelper,
  DEFAULT_SPEECH_MLX_PKG_DIR,
  parseBuildPcAppArgs,
  resealMacosAppSpeechHelper,
  resolveElectronBuilderMacAppPath,
  runBuildPcApp,
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

interface AppBuilderLibModule {
  Packager: new (
    options: { projectDir: string; config: Record<string, unknown> },
    cancellationToken: unknown,
  ) => { validateConfig(): Promise<void> };
  CancellationToken: new () => unknown;
}

function loadOptionalAppBuilderLib(
  loader: (id: string) => unknown = createRequire(resolve('apps/pc-app/package.json')),
): AppBuilderLibModule | null {
  try {
    return loader('app-builder-lib') as AppBuilderLibModule;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'MODULE_NOT_FOUND' && message.includes("'app-builder-lib'")) {
      return null;
    }
    throw err;
  }
}

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
      'Contents/Resources/imcodes-speech',
    ]);
    expect(PC_APP_MAC_NESTED_BINARIES).toEqual(releaseCfg.mac.binaries);
    expect(releaseCfg.mac.extendInfo.NSMicrophoneUsageDescription).toBeTruthy();
    expect(releaseCfg.mac.extendInfo.NSSpeechRecognitionUsageDescription).toBeTruthy();
    const entitlementsMac = readFileSync('apps/pc-app/build/entitlements.mac.plist', 'utf8');
    const entitlementsInherit = readFileSync('apps/pc-app/build/entitlements.mac.inherit.plist', 'utf8');
    expect(entitlementsMac).toContain('com.apple.security.device.audio-input');
    expect(entitlementsInherit).toContain('com.apple.security.device.audio-input');
    expect(releaseCfg.mac.identity).toBe(releaseSha1);
    expect(releaseCfg.mac.hardenedRuntime).toBe(true);
    expect(releaseCfg.publish).toEqual([{ provider: 'generic', url: DEFAULT_PC_APP_UPDATE_URL }]);
    expect(releaseCfg.mac.target).toEqual([
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ]);
    expect((releaseCfg as Record<string, unknown>).zip).toBeUndefined();
    expect(releaseCfg.mac.artifactName).toBe('IM.codes-${version}-${arch}.${ext}');
    expect(releaseCfg.dmg.artifactName).toBe('IM.codes-${version}-${arch}.${ext}');
    expect(releaseCfg.nsis.artifactName).toBe('IM.codes-Setup-${version}-${arch}.${ext}');
    expect(releaseCfg.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(resolvePcAppUpdateUrl({})).toBe('https://dl.im.codes/pc-app');
    expect(() => resolvePcAppUpdateUrl({ IMCODES_PC_APP_UPDATE_URL: 'http://dl.im.codes/pc-app' })).toThrow(/HTTPS/);
    expect(() => resolvePcAppUpdateUrl({ IMCODES_PC_APP_UPDATE_URL: 'https://user:pass@dl.im.codes/pc-app' })).toThrow(/credentials/);
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

  it('validates generated configs (and real electron-builder schema when installed), enforces platform-aware signing, and checks C++ include order', async () => {
    const appBuilder = loadOptionalAppBuilderLib();
    const pcAppDir = resolve('apps/pc-app');
    const releaseSha1 = 'A'.repeat(40);
    const winThumbprint = 'a'.repeat(40);
    const winSha256 = 'b'.repeat(64);

    // 1. Both darwin & win32 configs (with dev + prod update URLs) satisfy structural invariants
    //    and pass real electron-builder schema validation whenever app-builder-lib is installed.
    const darwinCfg = createPcAppElectronBuilderConfig({
      platform: 'darwin',
      macArch: 'universal',
      version: '0.1.0',
      env: {
        IMCODES_MACOS_SIGNING_IDENTITY: releaseSha1,
        IMCODES_PC_APP_UPDATE_URL: 'https://dl.im.codes/dev/pc-app',
      },
    });
    expect('zip' in darwinCfg).toBe(false);
    expect(darwinCfg.mac.artifactName).toBe('IM.codes-${version}-${arch}.${ext}');
    expect(darwinCfg.publish).toEqual([{ provider: 'generic', url: 'https://dl.im.codes/dev/pc-app' }]);

    const winCfg = createPcAppElectronBuilderConfig({
      platform: 'win32',
      winArch: 'x64',
      version: '0.1.0',
      env: {
        IMCODES_PC_APP_REQUIRE_SIGNING: '1',
        IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT: winThumbprint,
        IMCODES_WINDOWS_SIGNING_CERT_SHA256: winSha256,
        IMCODES_PC_APP_UPDATE_URL: 'https://dl.im.codes/pc-app',
      },
    });
    expect('zip' in winCfg).toBe(false);
    expect(winCfg.mac.identity).toBe('-');
    expect(winCfg.mac.hardenedRuntime).toBe(false);
    expect(winCfg.publish).toEqual([{ provider: 'generic', url: 'https://dl.im.codes/pc-app' }]);

    if (appBuilder) {
      await new appBuilder.Packager({ projectDir: pcAppDir, config: darwinCfg }, new appBuilder.CancellationToken()).validateConfig();
      await new appBuilder.Packager({ projectDir: pcAppDir, config: winCfg }, new appBuilder.CancellationToken()).validateConfig();

      // Negative schema proof: unknown top-level zip key must fail real schema validation
      const invalidWithZip = createPcAppElectronBuilderConfig({ platform: 'darwin', version: '0.1.0', env: {} });
      (invalidWithZip as Record<string, unknown>).zip = { artifactName: 'IM.codes-${version}-${arch}.${ext}' };
      await expect(
        new appBuilder.Packager({ projectDir: pcAppDir, config: invalidWithZip }, new appBuilder.CancellationToken()).validateConfig(),
      ).rejects.toThrow(/unknown property 'zip'/);
    }

    // 2. Platform-aware signing enforcement & top-level ESM import safety on Windows
    expect(() =>
      createPcAppElectronBuilderConfig({
        platform: 'win32',
        env: { IMCODES_PC_APP_REQUIRE_SIGNING: '1' },
      }),
    ).toThrow(/IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT/);
    expect(() =>
      createPcAppElectronBuilderConfig({
        platform: 'darwin',
        env: { IMCODES_PC_APP_REQUIRE_SIGNING: '1' },
      }),
    ).toThrow(/IMCODES_MACOS_SIGNING_IDENTITY/);

    const cleanImportEnv: Record<string, string | undefined> = { ...process.env };
    delete cleanImportEnv.IMCODES_MACOS_SIGNING_IDENTITY;
    delete cleanImportEnv.CSC_NAME;
    delete cleanImportEnv.CSC_LINK;
    const winImportRes = spawnSync(
      process.execPath,
      [
        '-e',
        "import('./apps/pc-app/electron-builder.config.mjs').then((m) => { if (!m.default?.win) process.exit(2); })",
      ],
      {
        encoding: 'utf8',
        env: {
          ...cleanImportEnv,
          IMCODES_PC_APP_TARGET_PLATFORM: 'win32',
          IMCODES_PC_APP_REQUIRE_SIGNING: '1',
          IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT: winThumbprint,
          IMCODES_WINDOWS_SIGNING_CERT_SHA256: winSha256,
        },
      },
    );
    expect(winImportRes.status, `top-level import failed: ${winImportRes.stderr}`).toBe(0);

    // End-to-end runBuildPcApp --platform win32 --require-sign without macOS signing vars
    const work = makeTempDir();
    const winExe = join(work, 'imcodes-node.exe');
    const winSpeechExe = join(work, 'imcodes-speech-win.exe');
    const winOut = join(work, 'release');
    const winStage = join(work, 'stage-win');
    writeFileSync(winExe, 'MZ-fake', 'utf8');
    writeFileSync(winSpeechExe, 'MZ-speech-win', 'utf8');
    const origThumb = process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT;
    const origSha = process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256;
    const origReqSign = process.env.IMCODES_PC_APP_REQUIRE_SIGNING;
    const origTargetPlat = process.env.IMCODES_PC_APP_TARGET_PLATFORM;
    process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT = winThumbprint;
    process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256 = winSha256;
    let passedWinConfig: Record<string, unknown> | null = null;
    try {
      await runBuildPcApp(
        {
          platform: 'win32',
          arch: 'x64',
          version: '0.1.0',
          nodeExe: winExe,
          outDir: winOut,
          stageDir: winStage,
          requireSign: true,
          requireNotarize: false,
          skipBuild: true,
          verifyOnly: false,
        },
        {
          platform: 'win32',
          ensureBuiltNodeExeFn: () => winExe,
          buildWindowsSpeechHelperFn: () => ({ binPath: winSpeechExe, runtimeDlls: [] }),
          electronBuilderBuildFn: async ({ config }: { config: Record<string, unknown> }) => {
            passedWinConfig = config;
            return [join(winOut, 'IM.codes-Setup-0.1.0-x64.exe')];
          },
          verifyPackagedWindowsDirFn: () => ({ ok: true }),
        },
      );
    } finally {
      if (origThumb === undefined) delete process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT;
      else process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT = origThumb;
      if (origSha === undefined) delete process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256;
      else process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256 = origSha;
      if (origReqSign === undefined) delete process.env.IMCODES_PC_APP_REQUIRE_SIGNING;
      else process.env.IMCODES_PC_APP_REQUIRE_SIGNING = origReqSign;
      if (origTargetPlat === undefined) delete process.env.IMCODES_PC_APP_TARGET_PLATFORM;
      else process.env.IMCODES_PC_APP_TARGET_PLATFORM = origTargetPlat;
    }
    expect(passedWinConfig).not.toBeNull();
    expect('zip' in passedWinConfig!).toBe(false);
    if (appBuilder) {
      await new appBuilder.Packager({ projectDir: pcAppDir, config: passedWinConfig! }, new appBuilder.CancellationToken()).validateConfig();
    }

    // Verify loadOptionalAppBuilderLib only suppresses MODULE_NOT_FOUND for app-builder-lib itself
    expect(loadOptionalAppBuilderLib(() => {
      const err = new Error("Cannot find module 'app-builder-lib'") as NodeJS.ErrnoException;
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    })).toBeNull();
    expect(() => loadOptionalAppBuilderLib(() => {
      const err = new Error("Cannot find module 'broken-transitive-dep'") as NodeJS.ErrnoException;
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    })).toThrow(/broken-transitive-dep/);
    expect(() => loadOptionalAppBuilderLib(() => {
      throw new SyntaxError('Unexpected token in electron-builder');
    })).toThrow(SyntaxError);

    // 3. Windows C++ speech helper header include order (<initguid.h>, <mmdeviceapi.h>, <propsys.h> before <functiondiscoverykeys_devpkey.h>)
    const winCpp = readFileSync('apps/pc-app/native/win/imcodes-speech-win.cpp', 'utf8');
    const idxWin = winCpp.indexOf('#include <windows.h>');
    const idxInitGuid = winCpp.indexOf('#include <initguid.h>');
    const idxMmDev = winCpp.indexOf('#include <mmdeviceapi.h>');
    const idxPropsys = winCpp.indexOf('#include <propsys.h>');
    const idxFuncKeys = winCpp.indexOf('#include <functiondiscoverykeys_devpkey.h>');
    expect(idxWin).toBeGreaterThan(-1);
    expect(idxInitGuid).toBeGreaterThan(idxWin);
    expect(idxMmDev).toBeGreaterThan(idxInitGuid);
    expect(idxPropsys).toBeGreaterThan(idxInitGuid);
    expect(idxFuncKeys).toBeGreaterThan(idxInitGuid);
    expect(idxFuncKeys).toBeGreaterThan(idxPropsys);
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
    const macSpeech = join(work, 'imcodes-speech');
    writeFileSync(macSpeech, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
    const tmuxSrc = createTmuxFixture(join(work, 'tmux-src'));
    const macStage = join(work, 'stage-mac');

    const stagedMac = stagePcAppResources({
      platform: 'darwin',
      nodeExePath: macExe,
      tmuxDir: tmuxSrc,
      speechBinPath: macSpeech,
      stageDir: macStage,
    });
    expect(existsSync(stagedMac.imcodesPath)).toBe(true);
    expect(existsSync(stagedMac.speechBinPath!)).toBe(true);
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
    const winSpeechExe = join(work, 'win-bin', 'imcodes-speech-win.exe');
    const winSpeechDll = join(work, 'win-bin', 'onnxruntime.dll');
    const winDirectMlDll = join(work, 'win-bin', 'DirectML.dll');
    mkdirSync(join(work, 'win-bin'), { recursive: true });
    writeFileSync(winExe, 'MZ-fake-exe', 'utf8');
    writeFileSync(winSpeechExe, 'MZ-speech-win', 'utf8');
    writeFileSync(winSpeechDll, 'MZ-ort-dll', 'utf8');
    writeFileSync(winDirectMlDll, 'MZ-dml-dll', 'utf8');

    const builtWinSpeech = buildWindowsSpeechHelper({
      outDir: join(work, 'out-win-speech'),
      env: { IMCODES_WIN_SPEECH_BIN_PATH: winSpeechExe },
    });
    expect(builtWinSpeech).not.toBeNull();
    expect(existsSync(builtWinSpeech!.binPath)).toBe(true);
    expect(builtWinSpeech!.runtimeDlls.some((p) => p.endsWith('onnxruntime.dll'))).toBe(true);
    expect(builtWinSpeech!.runtimeDlls.some((p) => p.endsWith('DirectML.dll'))).toBe(true);

    const stagedWin = stagePcAppResources({
      platform: 'win32',
      nodeExePath: winExe,
      winSpeechBinPath: builtWinSpeech!.binPath,
      winSpeechRuntimeDlls: builtWinSpeech!.runtimeDlls,
      stageDir: join(work, 'stage-win'),
    });
    expect(existsSync(stagedWin.imcodesPath)).toBe(true);
    expect(existsSync(join(work, 'stage-win', 'imcodes-speech-win.exe'))).toBe(true);
    expect(existsSync(join(work, 'stage-win', 'onnxruntime.dll'))).toBe(true);
    expect(existsSync(join(work, 'stage-win', 'DirectML.dll'))).toBe(true);
  });

  it('verifyPackagedMacosApp enforces Gate 1-4, nested codesign, optional stapler validate, and clean daemon run', () => {
    const work = makeTempDir();
    const appPath = join(work, 'IM.codes.app');
    const resDir = join(appPath, 'Contents', 'Resources');
    createTmuxFixture(resDir);
    const bundledImcodes = join(resDir, 'imcodes');
    writeFileSync(bundledImcodes, '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });
    const bundledSpeech = join(resDir, 'imcodes-speech');
    writeFileSync(bundledSpeech, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });

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
    expect(calls.some((c) => c.cmd === 'codesign' && c.args.includes(bundledSpeech))).toBe(true);
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

  it('wires build-pc-app.yml shell-only triggers, R2 publish --delete, explicit job timeouts, and CLI parsing', () => {
    const raw = readFileSync('.github/workflows/build-pc-app.yml', 'utf8');
    expect(raw).not.toContain('IMCODES_REQUIRE_COMPUTER_USE_HELPER');
    expect(raw).toContain('scripts/pc-app-shell-hash.mjs');
    expect(raw).toContain('scripts/build-macos-bundled-tmux.mjs');
    expect(raw).toContain('scripts/build-pc-app.mjs');
    expect(raw).toContain('scripts/macos-release-signing.mjs cleanup');
    expect(raw).toContain('--delete');
    expect(raw).toContain('--cache-control "no-cache, max-age=0, must-revalidate"');
    expect(raw).toContain('dev/pc-app');
    expect(raw).toContain('https://dl.im.codes/dev/pc-app');
    expect(raw).toContain('https://dl.im.codes/pc-app');
    expect(raw).toContain('IMCODES_PC_APP_UPDATE_URL');

    const parsed = parseYaml(raw) as {
      on: {
        workflow_dispatch?: { inputs?: { build_version?: { required?: boolean; type?: string } } };
        push?: { branches?: string[]; tags?: string[]; paths?: string[] };
      };
      jobs: Record<string, {
        'timeout-minutes'?: number;
        'runs-on'?: string;
        needs?: string | string[];
        outputs?: Record<string, string>;
        steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
      }>;
    };
    expect(parsed.on.workflow_dispatch?.inputs?.build_version?.required).toBe(false);
    expect(parsed.on.push?.branches).toEqual(['master', 'dev']);
    expect(parsed.on.push?.tags).toEqual(['pc-app-v*']);
    expect(parsed.on.push?.paths).toContain('apps/pc-app/src/**');
    expect(parsed.on.push?.paths).toContain('.github/workflows/build-pc-app.yml');
    expect(parsed.on.push?.paths).not.toContain('web/**');
    expect(parsed.on.push?.paths).not.toContain('server/**');
    expect(parsed.on.push?.paths).not.toContain('src/**');
    expect(parsed.on.push?.paths).not.toContain('apps/pc-app/test/**');

    expect(Object.keys(parsed.jobs).sort()).toEqual(['build-macos', 'build-windows', 'check-shell', 'publish-r2']);
    expect(parsed.jobs['check-shell']['runs-on']).toBe('ubuntu-latest');
    expect(parsed.jobs['check-shell']['timeout-minutes']).toBeGreaterThan(0);
    expect(parsed.jobs['check-shell'].outputs).toMatchObject({
      channel: '${{ steps.check.outputs.channel }}',
      r2_subpath: '${{ steps.check.outputs.r2_subpath }}',
      update_url: '${{ steps.check.outputs.update_url }}',
    });
    const macBuildStep = parsed.jobs['build-macos'].steps?.find((s) => s.name?.includes('package macOS'));
    expect(macBuildStep?.env?.IMCODES_PC_APP_UPDATE_URL).toBe('${{ needs.check-shell.outputs.update_url }}');
    expect(macBuildStep?.run).toContain('--require-mlx');
    const winBuildStep = parsed.jobs['build-windows'].steps?.find((s) => s.name?.includes('Windows PC App .exe'));
    expect(winBuildStep?.env?.IMCODES_PC_APP_UPDATE_URL).toBe('${{ needs.check-shell.outputs.update_url }}');
    expect(parsed.jobs['build-macos']['runs-on']).toBe('macos-26');
    expect(parsed.jobs['build-macos'].steps?.some((s) => s.run?.includes('xcodebuild -version'))).toBe(true);
    expect(parsed.jobs['build-macos'].steps?.some((s) => s.run?.includes('xcodebuild -downloadComponent MetalToolchain'))).toBe(true);
    expect(parsed.jobs['build-macos']['timeout-minutes']).toBeGreaterThan(0);
    expect(parsed.jobs['build-windows']['runs-on']).toBe('windows-2022');
    expect(parsed.jobs['build-windows']['timeout-minutes']).toBeGreaterThan(0);
    expect(parsed.jobs['publish-r2']['runs-on']).toBe('ubuntu-latest');
    expect(parsed.jobs['publish-r2']['timeout-minutes']).toBeGreaterThan(0);
    expect(parsed.jobs['publish-r2'].needs).toEqual(['check-shell', 'build-macos', 'build-windows']);
    expect(raw).toContain('latest-mac.yml');
    expect(raw).toContain('latest.yml');
    expect(raw).toContain('*.blockmap');
    expect(raw).toContain('*.zip');
    expect(raw).toContain('shell-meta.json');

    const publishStep = parsed.jobs['publish-r2'].steps?.find((s) => s.name === 'Generate shell-meta.json and sync latest PC App release to R2');
    expect(publishStep?.env?.R2_SUBPATH).toBe('${{ needs.check-shell.outputs.r2_subpath }}');
    expect(publishStep?.run).toContain('AWS_REQUEST_CHECKSUM_CALCULATION="when_required"');
    expect(publishStep?.run).toContain('AWS_RESPONSE_CHECKSUM_VALIDATION="when_required"');
    expect(publishStep?.run).toContain('aws configure set default.s3.multipart_threshold 100MB');
    expect(publishStep?.run).toContain('aws configure set default.s3.multipart_chunksize 64MB');
    expect(publishStep?.run).toContain('aws configure set default.s3.max_concurrent_requests 4');
    expect(publishStep?.run).toContain('for attempt in 1 2 3');

    const r2Dir = makeTempDir('imcodes-pc-app-r2-');
    const binDir = join(r2Dir, 'bin');
    const awsLog = join(r2Dir, 'aws.log');
    const stateFile = join(r2Dir, 'attempts');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(r2Dir, 'dist-pc-app-r2'), { recursive: true });
    writeFileSync(join(r2Dir, 'dist-pc-app-r2', 'latest-mac.yml'), 'version: 0.1.0\n');
    writeFileSync(join(r2Dir, 'dist-pc-app-r2', 'latest.yml'), 'version: 0.1.0\n');
    writeFileSync(
      join(binDir, 'aws'),
      `#!/usr/bin/env bash
echo "$*" >> "${awsLog}"
if [ "$1" = "configure" ]; then
  exit 0
fi
if [ "$AWS_REQUEST_CHECKSUM_CALCULATION" != "when_required" ] || [ "$AWS_RESPONSE_CHECKSUM_VALIDATION" != "when_required" ]; then
  echo "missing checksum env vars" >&2
  exit 99
fi
count=0
if [ -f "${stateFile}" ]; then
  count=$(cat "${stateFile}")
fi
count=$((count + 1))
printf '%s' "$count" > "${stateFile}"
if [ "$count" -le "\${FAIL_UNTIL_ATTEMPT:-99}" ]; then
  echo "An error occurred (InvalidPart) when calling the CompleteMultipartUpload operation" >&2
  exit 255
fi
exit 0
`,
      { mode: 0o755 },
    );

    const r2Env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      R2_ACCOUNT_ID: 'acct123',
      R2_BUCKET: 'bucket123',
      R2_ACCESS_KEY_ID: 'key123',
      R2_SECRET_ACCESS_KEY: 'secret123',
      R2_PREFIX: '',
      PC_APP_VERSION: '0.1.0',
      PC_APP_SHELL_SHA256: 'abc',
      PC_APP_COMMIT: 'deadbeef',
      R2_SYNC_RETRY_DELAY_SECONDS: '0',
    };
    const recoverRes = spawnSync('bash', ['-c', publishStep!.run!], {
      cwd: r2Dir,
      encoding: 'utf8',
      env: { ...r2Env, FAIL_UNTIL_ATTEMPT: '1' },
    });
    expect(recoverRes.status, `pc-app R2 retry failed: ${recoverRes.stderr}`).toBe(0);
    const recoverLines = readFileSync(awsLog, 'utf8').trim().split('\n');
    expect(recoverLines).toContain('configure set default.s3.multipart_threshold 100MB');
    expect(recoverLines).toContain('configure set default.s3.multipart_chunksize 64MB');
    expect(recoverLines).toContain('configure set default.s3.max_concurrent_requests 4');
    expect(recoverLines.filter((l) => l.includes('s3 sync dist-pc-app-r2 s3://bucket123/pc-app --delete --cache-control no-cache, max-age=0, must-revalidate'))).toHaveLength(2);

    writeFileSync(awsLog, '');
    rmSync(stateFile, { force: true });
    const devRes = spawnSync('bash', ['-c', publishStep!.run!], {
      cwd: r2Dir,
      encoding: 'utf8',
      env: { ...r2Env, R2_SUBPATH: 'dev/pc-app', FAIL_UNTIL_ATTEMPT: '0' },
    });
    expect(devRes.status, `pc-app dev R2 publish failed: ${devRes.stderr}`).toBe(0);
    const devLines = readFileSync(awsLog, 'utf8').trim().split('\n');
    expect(devLines.filter((l) => l.includes('s3 sync dist-pc-app-r2 s3://bucket123/dev/pc-app --delete --cache-control no-cache, max-age=0, must-revalidate'))).toHaveLength(1);

    const badSubpathRes = spawnSync('bash', ['-c', publishStep!.run!], {
      cwd: r2Dir,
      encoding: 'utf8',
      env: { ...r2Env, R2_SUBPATH: 'arbitrary/path', FAIL_UNTIL_ATTEMPT: '0' },
    });
    expect(badSubpathRes.status).not.toBe(0);

    writeFileSync(awsLog, '');
    rmSync(stateFile, { force: true });
    const failRes = spawnSync('bash', ['-c', publishStep!.run!], {
      cwd: r2Dir,
      encoding: 'utf8',
      env: { ...r2Env, FAIL_UNTIL_ATTEMPT: '99' },
    });
    expect(failRes.status).not.toBe(0);
    const failLines = readFileSync(awsLog, 'utf8').trim().split('\n');
    expect(failLines.filter((l) => l.includes('s3 sync dist-pc-app-r2 s3://bucket123/pc-app --delete'))).toHaveLength(3);

    const parsedArgs = parseBuildPcAppArgs([
      '--platform', 'darwin',
      '--arch', 'universal',
      '--version', '0.1.0',
      '--require-notarize',
      '--require-mlx',
    ]);
    expect(parsedArgs.platform).toBe('darwin');
    expect(parsedArgs.arch).toBe('universal');
    expect(parsedArgs.requireSign).toBe(true);
    expect(parsedArgs.requireNotarize).toBe(true);
    expect(parsedArgs.requireMlx).toBe(true);
    expect(parseBuildPcAppArgs(['--platform', 'darwin']).requireMlx).toBe(false);
    expect(resolveElectronBuilderMacAppPath('/tmp/release', 'arm64')).toBe('/tmp/release/mac-arm64/IM.codes.app');
    expect(resolveElectronBuilderMacAppPath('/tmp/release', 'x64')).toBe('/tmp/release/mac/IM.codes.app');
    expect(resolveElectronBuilderMacAppPath('/tmp/release', 'universal')).toBe('/tmp/release/mac-universal/IM.codes.app');
  });

  it('buildMacosSpeechMlxHelper and runBuildPcApp stage imcodes-speech-mlx + mlx.metallib into macOS app Resources and keep fallback when metallib is absent', async () => {
    const work = makeTempDir();
    const fakePkgDir = join(work, 'qwen3-asr');
    mkdirSync(fakePkgDir, { recursive: true });
    writeFileSync(join(fakePkgDir, 'Package.swift'), '// swift-tools-version: 5.9\n');

    const warnings: string[] = [];
    const fallbackCalls: Array<{ cmd: string; args: string[] }> = [];
    const builtNoMetallib = buildMacosSpeechMlxHelper({
      pkgDir: fakePkgDir,
      outDir: join(work, 'out-no-metallib'),
      arch: 'arm64',
      warnFn: (m) => warnings.push(m),
      execFn: vi.fn((cmd, args) => {
        fallbackCalls.push({ cmd, args });
        if (cmd === 'xcodebuild') {
          throw new Error('xcodebuild unavailable');
        }
        expect(cmd).toBe('swift');
        expect(args).toEqual(['build', '--package-path', fakePkgDir, '--arch', 'arm64', '-c', 'release']);
        const relDir = join(fakePkgDir, '.build', 'arm64-apple-macosx', 'release');
        mkdirSync(relDir, { recursive: true });
        writeFileSync(join(relDir, 'imcodes-speech-mlx'), '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
        return '';
      }),
    });
    expect(fallbackCalls.map((c) => c.cmd)).toEqual(['xcodebuild', 'swift']);
    expect(builtNoMetallib?.binPath).toBe(join(work, 'out-no-metallib', 'imcodes-speech-mlx'));
    expect(builtNoMetallib?.metallibPath).toBeNull();
    expect(warnings.some((w) => w.includes('xcodebuild for Qwen3-ASR MLX failed'))).toBe(true);
    expect(warnings.some((w) => w.includes('MetalToolchain'))).toBe(true);

    const x64Exec = vi.fn();
    expect(buildMacosSpeechMlxHelper({ pkgDir: fakePkgDir, outDir: join(work, 'out-x64'), arch: 'x64', execFn: x64Exec })).toBeNull();
    expect(x64Exec).not.toHaveBeenCalled();

    // Primary xcodebuild path: emits imcodes-speech-mlx and default.metallib under .build/xcode-dd/Build/Products/Release
    const outWithMetallib = join(work, 'out-with-metallib');
    const xcodeExec = vi.fn((cmd, args) => {
      expect(cmd).toBe('xcodebuild');
      expect(args).toEqual([
        '-scheme',
        'ImcodesSpeechMlx',
        '-configuration',
        'Release',
        '-destination',
        'platform=macOS,arch=arm64',
        '-derivedDataPath',
        join(fakePkgDir, '.build', 'xcode-dd'),
      ]);
      const releaseDir = join(fakePkgDir, '.build', 'xcode-dd', 'Build', 'Products', 'Release');
      const bundleResDir = join(releaseDir, 'mlx-swift_Cmlx.bundle', 'Contents', 'Resources');
      mkdirSync(bundleResDir, { recursive: true });
      writeFileSync(join(releaseDir, 'imcodes-speech-mlx'), '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
      writeFileSync(join(bundleResDir, 'default.metallib'), 'METALLIB');
      return '';
    });
    const builtFull = buildMacosSpeechMlxHelper({
      pkgDir: fakePkgDir,
      outDir: outWithMetallib,
      arch: 'universal',
      execFn: xcodeExec,
    });
    expect(xcodeExec).toHaveBeenCalledTimes(1);
    expect(builtFull).toEqual({
      binPath: join(outWithMetallib, 'imcodes-speech-mlx'),
      metallibPath: join(outWithMetallib, 'mlx.metallib'),
    });
    expect(existsSync(builtFull!.binPath)).toBe(true);
    expect(existsSync(builtFull!.metallibPath!)).toBe(true);

    // Causal end-to-end runBuildPcApp: verify arm64 build builds/passes MLX helper + metallib into Resources
    expect(DEFAULT_SPEECH_MLX_PKG_DIR).toMatch(/apps\/pc-app\/native\/qwen3-asr$/);
    const macExe = join(work, 'imcodes-node-macos');
    writeFileSync(macExe, '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });
    const macSpeech = join(work, 'imcodes-speech');
    writeFileSync(macSpeech, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
    const tmuxDir = createTmuxFixture(join(work, 'tmux-src'));
    const stageDir = join(work, 'stage-mac');
    const releaseOutDir = join(work, 'release');
    const appPath = resolveElectronBuilderMacAppPath(releaseOutDir, 'arm64');

    const passedStageArgs: Array<Record<string, unknown>> = [];
    const buildReport = await runBuildPcApp(
      {
        platform: 'darwin',
        arch: 'arm64',
        version: '0.1.0',
        nodeExe: macExe,
        tmuxDir,
        outDir: releaseOutDir,
        stageDir,
        appPath,
        requireSign: false,
        requireNotarize: false,
        skipBuild: true,
        verifyOnly: false,
      },
      {
        platform: 'darwin',
        ensureBuiltNodeExeFn: () => macExe,
        ensureBuiltBundledTmuxFn: async () => tmuxDir,
        buildMacosSpeechHelperFn: () => macSpeech,
        buildMacosSpeechMlxHelperFn: () => builtFull,
        stagePcAppResourcesFn: (args: Record<string, unknown>) => {
          passedStageArgs.push(args);
          return stagePcAppResources(args as Parameters<typeof stagePcAppResources>[0]);
        },
        electronBuilderBuildFn: async ({ config }: { config: { mac: { extraResources: Array<{ from: string }> } } }) => {
          const fromDir = config.mac.extraResources[0]!.from;
          const resDir = join(appPath, 'Contents', 'Resources');
          mkdirSync(resDir, { recursive: true });
          cpSync(fromDir, resDir, { recursive: true });
          return [join(releaseOutDir, 'IM.codes-0.1.0-arm64.dmg')];
        },
        verifyPackagedMacosAppFn: (targetApp: string) =>
          verifyPackagedMacosApp(targetApp, {
            execFn: (cmd: string, args: string[]) => {
              if (cmd === '/usr/bin/lipo') return 'arm64 x86_64\n';
              if (cmd === '/usr/bin/otool') {
                return `${join(targetApp, 'Contents', 'Resources', 'bin', 'tmux')}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n`;
              }
              if (args.includes('--version')) return '0.1.0\n';
              return '';
            },
          }),
      },
    );

    expect(passedStageArgs).toHaveLength(1);
    expect(passedStageArgs[0]!.mlxSpeechBinPath).toBe(builtFull!.binPath);
    expect(passedStageArgs[0]!.mlxMetallibPath).toBe(builtFull!.metallibPath);

    const appResourcesDir = join(appPath, 'Contents', 'Resources');
    expect(existsSync(join(appResourcesDir, 'imcodes-speech-mlx'))).toBe(true);
    expect(existsSync(join(appResourcesDir, 'mlx.metallib'))).toBe(true);
    expect((buildReport.verification as { mlxSpeechPath?: string; mlxMetallibPresent?: boolean }).mlxSpeechPath).toBe(
      join(appResourcesDir, 'imcodes-speech-mlx'),
    );
    expect((buildReport.verification as { mlxMetallibPresent?: boolean }).mlxMetallibPresent).toBe(true);
  });

  it('buildMacosSpeechHelper ad-hoc signs imcodes-speech with codes.im.pc identifier and tolerates missing codesign', () => {
    const work = makeTempDir();
    const swiftSrc = join(work, 'imcodes-speech.swift');
    writeFileSync(swiftSrc, '// test swift helper\n', 'utf8');

    // 1. Single-arch signs output with -i codes.im.pc
    const singleCalls: Array<{ cmd: string; args: string[] }> = [];
    const singleOut = join(work, 'single', 'imcodes-speech');
    buildMacosSpeechHelper({
      srcPath: swiftSrc,
      outPath: singleOut,
      arch: 'arm64',
      execFn: (cmd: string, args: string[]) => {
        singleCalls.push({ cmd, args });
        if (cmd === 'swiftc') {
          writeFileSync(args[args.indexOf('-o') + 1]!, '#!/bin/sh\necho ok\n', { mode: 0o755 });
        }
        return Buffer.alloc(0);
      },
    });
    expect(singleCalls).toEqual([
      {
        cmd: 'swiftc',
        args: ['-O', '-target', 'arm64-apple-macosx12.0', '-framework', 'Cocoa', '-framework', 'CoreGraphics', '-framework', 'ApplicationServices', '-framework', 'IOKit', swiftSrc, '-o', singleOut],
      },
      {
        cmd: 'codesign',
        args: ['--force', '--sign', '-', '-i', 'codes.im.pc', singleOut],
      },
    ]);

    // 2. Universal arch creates fat binary with lipo and signs final output with -i codes.im.pc
    const uniCalls: Array<{ cmd: string; args: string[] }> = [];
    const uniOut = join(work, 'uni', 'imcodes-speech');
    buildMacosSpeechHelper({
      srcPath: swiftSrc,
      outPath: uniOut,
      arch: 'universal',
      execFn: (cmd: string, args: string[]) => {
        uniCalls.push({ cmd, args });
        if (cmd === 'swiftc') {
          writeFileSync(args[args.indexOf('-o') + 1]!, '#!/bin/sh\necho ok\n', { mode: 0o755 });
        } else if (cmd === 'lipo') {
          writeFileSync(args[args.indexOf('-output') + 1]!, '#!/bin/sh\necho ok\n', { mode: 0o755 });
        }
        return Buffer.alloc(0);
      },
    });
    expect(uniCalls.at(-1)).toEqual({
      cmd: 'codesign',
      args: ['--force', '--sign', '-', '-i', 'codes.im.pc', uniOut],
    });

    // 3. Soft-ignores only ENOENT when codesign binary is absent; non-ENOENT failures still throw
    const enoentOut = join(work, 'enoent', 'imcodes-speech');
    expect(() =>
      buildMacosSpeechHelper({
        srcPath: swiftSrc,
        outPath: enoentOut,
        arch: 'arm64',
        execFn: (cmd: string, args: string[]) => {
          if (cmd === 'swiftc') {
            writeFileSync(args[args.indexOf('-o') + 1]!, '#!/bin/sh\necho ok\n', { mode: 0o755 });
            return Buffer.alloc(0);
          }
          const err = new Error('spawn codesign ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        },
      }),
    ).not.toThrow();

    expect(() =>
      buildMacosSpeechHelper({
        srcPath: swiftSrc,
        outPath: join(work, 'fail', 'imcodes-speech'),
        arch: 'arm64',
        execFn: (cmd: string, args: string[]) => {
          if (cmd === 'swiftc') {
            writeFileSync(args[args.indexOf('-o') + 1]!, '#!/bin/sh\necho ok\n', { mode: 0o755 });
            return Buffer.alloc(0);
          }
          throw new Error('codesign failed');
        },
      }),
    ).toThrow(/codesign failed/);
  });

  it('resealMacosAppSpeechHelper preserves codes.im.pc on ad-hoc .app bundles and skips Developer ID builds', () => {
    const work = makeTempDir();
    const appPath = join(work, 'IM.codes.app');
    const speechBin = join(appPath, 'Contents', 'Resources', 'imcodes-speech');
    mkdirSync(join(appPath, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(speechBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    const adHocCalls: Array<{ cmd: string; args: string[] }> = [];
    const resAdHoc = resealMacosAppSpeechHelper(appPath, {
      env: {},
      execFn: (cmd: string, args: string[]) => {
        adHocCalls.push({ cmd, args });
        return Buffer.alloc(0);
      },
    });
    expect(resAdHoc).toEqual({
      resealed: true,
      speechBin,
      identifier: 'codes.im.pc',
    });
    expect(adHocCalls).toEqual([
      {
        cmd: 'codesign',
        args: ['--force', '--sign', '-', '-i', 'codes.im.pc', speechBin],
      },
      {
        cmd: 'codesign',
        args: ['--force', '--sign', '-', appPath],
      },
    ]);

    const devIdCalls: Array<{ cmd: string; args: string[] }> = [];
    expect(
      resealMacosAppSpeechHelper(appPath, {
        env: { CSC_NAME: 'Developer ID Application: Example' },
        execFn: (cmd: string, args: string[]) => {
          devIdCalls.push({ cmd, args });
          return Buffer.alloc(0);
        },
      }),
    ).toEqual({ resealed: false, reason: 'developer_id_signing' });
    expect(
      resealMacosAppSpeechHelper(appPath, {
        env: { MACOS_CODESIGN_IDENTITY: 'Developer ID Application: Example' },
        execFn: (cmd: string, args: string[]) => {
          devIdCalls.push({ cmd, args });
          return Buffer.alloc(0);
        },
      }),
    ).toEqual({ resealed: false, reason: 'developer_id_signing' });
    expect(devIdCalls).toHaveLength(0);
  });

  it('includes dist/build-config.json in electron-builder files and invokes writeBuildConfigFn when skipBuild is false', async () => {
    const cfg = createPcAppElectronBuilderConfig({
      platform: 'darwin',
      version: '0.1.0',
      env: {},
    });
    expect(cfg.files).toContain('dist/build-config.json');

    const root = makeTempDir('imcodes-pc-build-cfg-run-');
    const macExe = join(root, 'imcodes-node');
    const tmuxDir = createTmuxFixture(join(root, 'tmux'));
    const macSpeech = join(root, 'imcodes-speech');
    const stageDir = join(root, 'stage');
    const releaseOutDir = join(root, 'release');
    const appPath = resolveElectronBuilderMacAppPath(releaseOutDir, 'arm64');
    writeFileSync(macExe, '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });
    writeFileSync(macSpeech, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const execCalls: string[] = [];
    const writeConfigSpy = vi.fn(() => ({ localeDefaultServers: [] }));

    await runBuildPcApp(
      {
        platform: 'darwin',
        arch: 'arm64',
        version: '0.1.0',
        outDir: releaseOutDir,
        stageDir,
        appPath,
        requireSign: false,
        requireNotarize: false,
        skipBuild: false,
        verifyOnly: false,
      },
      {
        platform: 'darwin',
        execFn: (cmd: string) => {
          execCalls.push(cmd);
          return Buffer.alloc(0);
        },
        writeBuildConfigFn: writeConfigSpy,
        ensureBuiltNodeExeFn: () => macExe,
        ensureBuiltBundledTmuxFn: async () => tmuxDir,
        buildMacosSpeechHelperFn: () => macSpeech,
        buildMacosSpeechMlxHelperFn: () => null,
        electronBuilderBuildFn: async ({ config }: { config: { mac: { extraResources: Array<{ from: string }> } } }) => {
          const fromDir = config.mac.extraResources[0]!.from;
          const resDir = join(appPath, 'Contents', 'Resources');
          mkdirSync(resDir, { recursive: true });
          cpSync(fromDir, resDir, { recursive: true });
          return [join(releaseOutDir, 'IM.codes-0.1.0-arm64.dmg')];
        },
        verifyPackagedMacosAppFn: (targetApp: string) =>
          verifyPackagedMacosApp(targetApp, {
            execFn: (cmd: string, args: string[]) => {
              if (cmd === '/usr/bin/lipo') return 'arm64 x86_64\n';
              if (cmd === '/usr/bin/otool') {
                return `${join(targetApp, 'Contents', 'Resources', 'bin', 'tmux')}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n`;
              }
              if (args.includes('--version')) return '0.1.0\n';
              return '';
            },
          }),
      },
    );

    expect(execCalls.length).toBeGreaterThanOrEqual(1);
    expect(writeConfigSpy).toHaveBeenCalledTimes(1);
  });

  it('configures universal x64ArchFiles and conditional nested signing for imcodes-speech-mlx', async () => {
    const work = makeTempDir('imcodes-pc-mlx-cfg-');
    const stageWithoutMlx = join(work, 'stage-no-mlx');
    mkdirSync(stageWithoutMlx, { recursive: true });
    const cfgWithoutMlx = createPcAppElectronBuilderConfig({
      platform: 'darwin',
      macArch: 'universal',
      macStageDir: stageWithoutMlx,
      version: '0.1.8',
      env: {},
    });
    expect(cfgWithoutMlx.mac.x64ArchFiles).toBe(PC_APP_MAC_MLX_BINARY);
    expect(cfgWithoutMlx.mac.binaries).toEqual([...PC_APP_MAC_NESTED_BINARIES]);
    expect(cfgWithoutMlx.mac.binaries).not.toContain(PC_APP_MAC_MLX_BINARY);

    const stageWithMlx = join(work, 'stage-with-mlx');
    mkdirSync(stageWithMlx, { recursive: true });
    writeFileSync(join(stageWithMlx, 'imcodes-speech-mlx'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const cfgWithMlx = createPcAppElectronBuilderConfig({
      platform: 'darwin',
      macArch: 'universal',
      macStageDir: stageWithMlx,
      version: '0.1.8',
      env: {},
    });
    expect(cfgWithMlx.mac.x64ArchFiles).toBe(PC_APP_MAC_MLX_BINARY);
    expect(cfgWithMlx.mac.binaries).toEqual([...PC_APP_MAC_NESTED_BINARIES, PC_APP_MAC_MLX_BINARY]);

    // Match the exact @electron/universal call: minimatch(relPath, opts.x64ArchFiles, { matchBase: true })
    const pcReq = createRequire(resolve('apps/pc-app/package.json'));
    let minimatchFn: ((path: string, pattern: string, opts: { matchBase: boolean }) => boolean) | null = null;
    try {
      const uniReq = createRequire(pcReq.resolve('@electron/universal'));
      const mmPkg = uniReq(uniReq.resolve('minimatch/package.json')) as { version?: string };
      expect(mmPkg.version).toMatch(/^9\./);
      const mod = uniReq('minimatch') as { minimatch?: typeof minimatchFn };
      minimatchFn = mod.minimatch ?? (mod as unknown as typeof minimatchFn);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'MODULE_NOT_FOUND') throw err;
    }
    if (minimatchFn) {
      expect(minimatchFn('Contents/Resources/imcodes-speech-mlx', cfgWithMlx.mac.x64ArchFiles, { matchBase: true })).toBe(true);
      expect(minimatchFn('Contents/Resources/imcodes', cfgWithMlx.mac.x64ArchFiles, { matchBase: true })).toBe(false);
    }

    const appBuilder = loadOptionalAppBuilderLib();
    if (appBuilder) {
      await new appBuilder.Packager(
        { projectDir: resolve('apps/pc-app'), config: cfgWithMlx },
        new appBuilder.CancellationToken(),
      ).validateConfig();
    }
  });

  it('enforces --require-mlx fail-closed checks across helper build, verification, and runBuildPcApp while keeping x64 exempt', async () => {
    const work = makeTempDir('imcodes-pc-mlx-req-');
    const pkgDir = join(work, 'qwen3-asr');
    mkdirSync(pkgDir, { recursive: true });

    // 1. Missing Package.swift fails closed under requireMlx
    expect(() =>
      buildMacosSpeechMlxHelper({
        pkgDir,
        outDir: join(work, 'out-missing-pkg'),
        arch: 'arm64',
        requireMlx: true,
      }),
    ).toThrow(/MLX speech package missing/);

    writeFileSync(join(pkgDir, 'Package.swift'), '// swift-tools-version: 6.3\n');

    // 2. Build failure fails closed under requireMlx
    expect(() =>
      buildMacosSpeechMlxHelper({
        pkgDir,
        outDir: join(work, 'out-fail'),
        arch: 'universal',
        requireMlx: true,
        warnFn: () => {},
        execFn: () => {
          throw new Error('toolchain missing');
        },
      }),
    ).toThrow(/swift build for Qwen3-ASR MLX failed/);

    // 3. Binary produced without metallib fails closed and leaves no partial outDir binary
    const noMetallibOut = join(work, 'out-no-metallib');
    expect(() =>
      buildMacosSpeechMlxHelper({
        pkgDir,
        outDir: noMetallibOut,
        arch: 'arm64',
        requireMlx: true,
        warnFn: () => {},
        execFn: (cmd) => {
          if (cmd === 'xcodebuild') throw new Error('xcodebuild failed');
          const relDir = join(pkgDir, '.build', 'arm64-apple-macosx', 'release');
          mkdirSync(relDir, { recursive: true });
          writeFileSync(join(relDir, 'imcodes-speech-mlx'), '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
          return '';
        },
      }),
    ).toThrow(/mlx\.metallib\/default\.metallib not generated/);
    expect(existsSync(join(noMetallibOut, 'imcodes-speech-mlx'))).toBe(false);

    // 4. Empty 0-byte metallib fails closed under requireMlx
    rmSync(join(pkgDir, '.build'), { recursive: true, force: true });
    expect(() =>
      buildMacosSpeechMlxHelper({
        pkgDir,
        outDir: join(work, 'out-empty-metallib'),
        arch: 'universal',
        requireMlx: true,
        warnFn: () => {},
        execFn: () => {
          const releaseDir = join(pkgDir, '.build', 'xcode-dd', 'Build', 'Products', 'Release');
          mkdirSync(releaseDir, { recursive: true });
          writeFileSync(join(releaseDir, 'imcodes-speech-mlx'), '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
          writeFileSync(join(releaseDir, 'default.metallib'), Buffer.alloc(0));
          return '';
        },
      }),
    ).toThrow(/mlx\.metallib\/default\.metallib not generated/);

    // 5. Valid binary + non-empty metallib succeeds under requireMlx, and x64 remains exempt
    rmSync(join(pkgDir, '.build'), { recursive: true, force: true });
    const goodOut = join(work, 'out-good');
    const builtGood = buildMacosSpeechMlxHelper({
      pkgDir,
      outDir: goodOut,
      arch: 'universal',
      requireMlx: true,
      execFn: () => {
        const releaseDir = join(pkgDir, '.build', 'xcode-dd', 'Build', 'Products', 'Release');
        mkdirSync(releaseDir, { recursive: true });
        writeFileSync(join(releaseDir, 'imcodes-speech-mlx'), '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
        writeFileSync(join(releaseDir, 'default.metallib'), 'METALLIB');
        return '';
      },
    });
    expect(builtGood).toEqual({
      binPath: join(goodOut, 'imcodes-speech-mlx'),
      metallibPath: join(goodOut, 'mlx.metallib'),
    });
    expect(
      buildMacosSpeechMlxHelper({
        pkgDir,
        outDir: join(work, 'out-x64'),
        arch: 'x64',
        requireMlx: true,
        execFn: () => {
          throw new Error('should not build MLX for x64');
        },
      }),
    ).toBeNull();

    // 6. verifyPackagedMacosApp requireMlx fail-closed behavior
    const appPath = join(work, 'IM.codes.app');
    const resDir = join(appPath, 'Contents', 'Resources');
    createTmuxFixture(resDir);
    const bundledImcodes = join(resDir, 'imcodes');
    const bundledSpeech = join(resDir, 'imcodes-speech');
    writeFileSync(bundledImcodes, '#!/bin/sh\necho 0.1.8\n', { mode: 0o755 });
    writeFileSync(bundledSpeech, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
    const mockVerifyExec = (cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/lipo') return 'arm64 x86_64\n';
      if (cmd === '/usr/bin/otool') {
        return `${join(resDir, 'bin', 'tmux')}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n`;
      }
      if (args.includes('--version')) return '0.1.8\n';
      return '';
    };

    expect(() => verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: true })).toThrow(
      /Bundled imcodes-speech-mlx helper missing/,
    );
    const bundledMlx = join(resDir, 'imcodes-speech-mlx');
    mkdirSync(bundledMlx, { recursive: true });
    expect(() => verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: true })).toThrow(
      /Bundled imcodes-speech-mlx helper is not a regular file/,
    );
    rmSync(bundledMlx, { recursive: true, force: true });

    writeFileSync(bundledMlx, '#!/bin/sh\necho "{}"\n', { mode: 0o644 });
    chmodSync(bundledMlx, 0o644);
    expect(() => verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: true })).toThrow();

    chmodSync(bundledMlx, 0o755);
    expect(() => verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: true })).toThrow(
      /Bundled mlx\.metallib missing/,
    );
    expect(verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: false }).mlxMetallibPresent).toBe(false);

    // Directory named mlx.metallib must fail closed under requireMlx and stay false under optional fallback
    const bundledMetallib = join(resDir, 'mlx.metallib');
    mkdirSync(bundledMetallib, { recursive: true });
    expect(() => verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: true })).toThrow(
      /Bundled mlx\.metallib is not a regular file/,
    );
    expect(verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: false }).mlxMetallibPresent).toBe(false);
    rmSync(bundledMetallib, { recursive: true, force: true });

    writeFileSync(bundledMetallib, Buffer.alloc(0));
    expect(() => verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: true })).toThrow(
      /Bundled mlx\.metallib is empty/,
    );
    expect(verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: false }).mlxMetallibPresent).toBe(false);

    writeFileSync(bundledMetallib, 'METALLIB');
    const verifiedMlx = verifyPackagedMacosApp(appPath, { execFn: mockVerifyExec, requireMlx: true });
    expect(verifiedMlx.mlxSpeechPath).toBe(bundledMlx);
    expect(verifiedMlx.mlxMetallibPresent).toBe(true);

    // 7. runBuildPcApp propagates requireMlx on universal/arm64, verifyOnly, and exempts x64
    const buildMlxCalls: Array<{ arch: string; requireMlx: boolean }> = [];
    const verifyCalls: Array<{ requireMlx: boolean }> = [];
    let capturedUniversalConfig: { mac: { x64ArchFiles: string; binaries: string[]; extraResources: Array<{ from: string }> } } | null = null;
    await runBuildPcApp(
      {
        platform: 'darwin',
        arch: 'universal',
        version: '0.1.8',
        nodeExe: bundledImcodes,
        tmuxDir: resDir,
        outDir: join(work, 'rel-uni'),
        stageDir: join(work, 'stage-uni'),
        appPath,
        requireSign: false,
        requireNotarize: false,
        requireMlx: true,
        skipBuild: true,
        verifyOnly: false,
      },
      {
        platform: 'darwin',
        ensureBuiltNodeExeFn: () => bundledImcodes,
        ensureBuiltBundledTmuxFn: async () => resDir,
        buildMacosSpeechHelperFn: () => bundledSpeech,
        buildMacosSpeechMlxHelperFn: (args: { arch: string; requireMlx: boolean }) => {
          buildMlxCalls.push(args);
          return builtGood;
        },
        electronBuilderBuildFn: async ({ config }: { config: typeof capturedUniversalConfig }) => {
          capturedUniversalConfig = config;
          return [join(work, 'rel-uni', 'IM.codes-0.1.8-universal.dmg')];
        },
        verifyPackagedMacosAppFn: (targetApp: string, vOpts: { requireMlx: boolean }) => {
          verifyCalls.push({ requireMlx: vOpts.requireMlx });
          return verifyPackagedMacosApp(targetApp, { execFn: mockVerifyExec, requireMlx: vOpts.requireMlx });
        },
      },
    );
    expect(buildMlxCalls).toEqual([{ arch: 'universal', requireMlx: true }]);
    expect(verifyCalls).toEqual([{ requireMlx: true }]);
    expect(capturedUniversalConfig!.mac.x64ArchFiles).toBe(PC_APP_MAC_MLX_BINARY);
    expect(capturedUniversalConfig!.mac.binaries).toContain(PC_APP_MAC_MLX_BINARY);

    const verifyOnlyCalls: Array<{ requireMlx: boolean }> = [];
    await runBuildPcApp(
      {
        platform: 'darwin',
        arch: 'universal',
        version: '0.1.8',
        outDir: join(work, 'rel-uni'),
        stageDir: join(work, 'stage-uni'),
        appPath,
        requireSign: false,
        requireNotarize: false,
        requireMlx: true,
        skipBuild: true,
        verifyOnly: true,
      },
      {
        platform: 'darwin',
        verifyPackagedMacosAppFn: (targetApp: string, vOpts: { requireMlx: boolean }) => {
          verifyOnlyCalls.push({ requireMlx: vOpts.requireMlx });
          return verifyPackagedMacosApp(targetApp, { execFn: mockVerifyExec, requireMlx: vOpts.requireMlx });
        },
      },
    );
    expect(verifyOnlyCalls).toEqual([{ requireMlx: true }]);

    // x64 with --require-mlx must not enforce MLX in build or verification
    const x64VerifyCalls: Array<{ requireMlx: boolean }> = [];
    let capturedX64Config: { mac: { binaries: string[] } } | null = null;
    await runBuildPcApp(
      {
        platform: 'darwin',
        arch: 'x64',
        version: '0.1.8',
        nodeExe: bundledImcodes,
        tmuxDir: resDir,
        outDir: join(work, 'rel-x64'),
        stageDir: join(work, 'stage-x64'),
        appPath: join(work, 'x64-app', 'IM.codes.app'),
        requireSign: false,
        requireNotarize: false,
        requireMlx: true,
        skipBuild: true,
        verifyOnly: false,
      },
      {
        platform: 'darwin',
        ensureBuiltNodeExeFn: () => bundledImcodes,
        ensureBuiltBundledTmuxFn: async () => resDir,
        buildMacosSpeechHelperFn: () => bundledSpeech,
        buildMacosSpeechMlxHelperFn: (args: { arch: string; requireMlx: boolean }) => {
          expect(args).toEqual({ arch: 'x64', requireMlx: false });
          return null;
        },
        electronBuilderBuildFn: async ({ config }: { config: { mac: { binaries: string[]; extraResources: Array<{ from: string }> } } }) => {
          capturedX64Config = config;
          const x64ResDir = join(work, 'x64-app', 'IM.codes.app', 'Contents', 'Resources');
          mkdirSync(x64ResDir, { recursive: true });
          cpSync(config.mac.extraResources[0]!.from, x64ResDir, { recursive: true });
          return [join(work, 'rel-x64', 'IM.codes-0.1.8-x64.dmg')];
        },
        verifyPackagedMacosAppFn: (targetApp: string, vOpts: { requireMlx: boolean }) => {
          x64VerifyCalls.push({ requireMlx: vOpts.requireMlx });
          return verifyPackagedMacosApp(targetApp, { execFn: mockVerifyExec, requireMlx: vOpts.requireMlx });
        },
      },
    );
    expect(x64VerifyCalls).toEqual([{ requireMlx: false }]);
    expect(capturedX64Config!.mac.binaries).not.toContain(PC_APP_MAC_MLX_BINARY);

    // 8. Simulated x64 host: --verify-only with explicit --app-path and NO --arch still enforces --require-mlx,
    //    explicit --arch x64 exempts it, and omitted --app-path uses host default arch to locate mac/IM.codes.app.
    const x64HostExplicitAppOpts = parseBuildPcAppArgs(
      ['--platform', 'darwin', '--verify-only', '--app-path', appPath, '--require-mlx'],
      { platform: 'darwin', hostArch: 'x64' },
    );
    expect(x64HostExplicitAppOpts.arch).toBe('x64');
    expect(x64HostExplicitAppOpts.archExplicit).toBe(false);
    const x64HostVerifyCalls: Array<{ app: string; requireMlx: boolean }> = [];
    await runBuildPcApp(x64HostExplicitAppOpts, {
      platform: 'darwin',
      verifyPackagedMacosAppFn: (targetApp: string, vOpts: { requireMlx: boolean }) => {
        x64HostVerifyCalls.push({ app: targetApp, requireMlx: vOpts.requireMlx });
        return verifyPackagedMacosApp(targetApp, { execFn: mockVerifyExec, requireMlx: vOpts.requireMlx });
      },
    });
    expect(x64HostVerifyCalls).toEqual([{ app: appPath, requireMlx: true }]);

    const x64HostExplicitArchOpts = parseBuildPcAppArgs(
      ['--platform', 'darwin', '--verify-only', '--app-path', appPath, '--arch', 'x64', '--require-mlx'],
      { platform: 'darwin', hostArch: 'x64' },
    );
    expect(x64HostExplicitArchOpts.arch).toBe('x64');
    expect(x64HostExplicitArchOpts.archExplicit).toBe(true);
    const x64HostExplicitArchCalls: Array<{ app: string; requireMlx: boolean }> = [];
    await runBuildPcApp(x64HostExplicitArchOpts, {
      platform: 'darwin',
      verifyPackagedMacosAppFn: (targetApp: string, vOpts: { requireMlx: boolean }) => {
        x64HostExplicitArchCalls.push({ app: targetApp, requireMlx: vOpts.requireMlx });
        return verifyPackagedMacosApp(targetApp, { execFn: mockVerifyExec, requireMlx: vOpts.requireMlx });
      },
    });
    expect(x64HostExplicitArchCalls).toEqual([{ app: appPath, requireMlx: false }]);

    const x64HostDefaultPathOpts = parseBuildPcAppArgs(
      ['--platform', 'darwin', '--verify-only', '--out-dir', join(work, 'rel-x64-verify'), '--require-mlx'],
      { platform: 'darwin', hostArch: 'x64' },
    );
    const defaultVerifyCalls: Array<{ app: string; requireMlx: boolean }> = [];
    await runBuildPcApp(x64HostDefaultPathOpts, {
      platform: 'darwin',
      verifyPackagedMacosAppFn: (targetApp: string, vOpts: { requireMlx: boolean }) => {
        defaultVerifyCalls.push({ app: targetApp, requireMlx: vOpts.requireMlx });
        return { ok: true };
      },
    });
    expect(defaultVerifyCalls).toEqual([
      { app: resolveElectronBuilderMacAppPath(join(work, 'rel-x64-verify'), 'x64'), requireMlx: false },
    ]);
  });

  it('enforces --require-win-asr fail-closed gating, stages lib+bin DLLs, and verifies probe localAsrSupported', async () => {
    const {
      parseBuildPcAppArgs,
      buildWindowsSpeechHelper,
      verifyPackagedWindowsDir,
      runBuildPcApp,
    } = await import('../../scripts/build-pc-app.mjs');

    // 1. CLI flag parsing
    const parsedWin = parseBuildPcAppArgs(
      ['--platform', 'win32', '--arch', 'x64', '--require-win-asr'],
      { platform: 'win32', hostArch: 'x64' },
    );
    expect(parsedWin.requireWinAsr).toBe(true);
    const parsedDefault = parseBuildPcAppArgs(['--platform', 'win32'], { platform: 'win32', hostArch: 'x64' });
    expect(parsedDefault.requireWinAsr).toBe(false);

    // 2. buildWindowsSpeechHelper fails closed when requireWinAsr=true and SDK is missing; warns cleanly when false
    const work = makeTempDir();
    const srcDir = join(work, 'win-src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n', 'utf8');

    const warnings: string[] = [];
    const devStubResult = buildWindowsSpeechHelper({
      srcDir,
      outDir: join(work, 'out-dev'),
      requireWinAsr: false,
      warnFn: (msg: string) => warnings.push(msg),
      execFn: () => { throw new Error('cmake unavailable'); },
      env: {},
    });
    expect(devStubResult).toBeNull();
    expect(warnings.some((w) => w.includes('CMake build for imcodes-speech-win.exe failed'))).toBe(true);

    expect(() =>
      buildWindowsSpeechHelper({
        srcDir,
        outDir: join(work, 'out-strict-no-sdk'),
        requireWinAsr: true,
        execFn: () => {},
        env: {},
      }),
    ).toThrow(/--require-win-asr/);

    // 3. buildWindowsSpeechHelper stages DLLs deduplicated across runtimes/win-x64/native and bin/x64-win, excludes DirectML.Debug.dll, passes IMCODES_REQUIRE_ONNXRUNTIME=ON
    const sdkDir = join(work, 'ort-win-sdk');
    mkdirSync(join(sdkDir, 'build', 'native', 'include'), { recursive: true });
    mkdirSync(join(sdkDir, 'runtimes', 'win-x64', 'native'), { recursive: true });
    mkdirSync(join(sdkDir, 'bin', 'x64-win'), { recursive: true });
    writeFileSync(join(sdkDir, 'build', 'native', 'include', 'onnxruntime_cxx_api.h'), '// stub ort\n', 'utf8');
    writeFileSync(join(sdkDir, 'build', 'native', 'include', 'dml_provider_factory.h'), '// stub dml\n', 'utf8');
    writeFileSync(join(sdkDir, 'runtimes', 'win-x64', 'native', 'onnxruntime.lib'), 'LIB-ort', 'utf8');
    writeFileSync(join(sdkDir, 'runtimes', 'win-x64', 'native', 'onnxruntime.dll'), 'MZ-ort-native', 'utf8');
    writeFileSync(join(sdkDir, 'runtimes', 'win-x64', 'native', 'onnxruntime_providers_shared.dll'), 'MZ-shared', 'utf8');
    writeFileSync(join(sdkDir, 'bin', 'x64-win', 'onnxruntime.dll'), 'MZ-ort-bin-dup', 'utf8');
    writeFileSync(join(sdkDir, 'bin', 'x64-win', 'DirectML.dll'), 'MZ-dml-bin', 'utf8');
    writeFileSync(join(sdkDir, 'bin', 'x64-win', 'DirectML.Debug.dll'), 'MZ-dml-debug', 'utf8');

    const cmakeInvocations: string[][] = [];
    const strictBuilt = buildWindowsSpeechHelper({
      srcDir,
      outDir: join(work, 'out-strict'),
      requireWinAsr: true,
      env: { IMCODES_ONNXRUNTIME_WIN_DIR: sdkDir },
      execFn: (_cmd: string, args: string[]) => {
        cmakeInvocations.push(args);
        if (args.includes('--build')) {
          mkdirSync(join(srcDir, 'build', 'Release'), { recursive: true });
          writeFileSync(join(srcDir, 'build', 'Release', 'imcodes-speech-win.exe'), 'MZ-win-asr', 'utf8');
        }
      },
    });
    expect(cmakeInvocations[0]).toContain(`-DONNXRUNTIME_DIR=${sdkDir}`);
    expect(cmakeInvocations[0]).toContain('-DIMCODES_REQUIRE_ONNXRUNTIME=ON');
    expect(strictBuilt).not.toBeNull();
    expect(strictBuilt!.runtimeDlls.map((p: string) => p.split(/[\\/]/).pop()).sort()).toEqual([
      'DirectML.dll',
      'onnxruntime.dll',
      'onnxruntime_providers_shared.dll',
    ]);
    // runtimes/win-x64/native takes precedence over duplicate in bin/x64-win
    expect(readFileSync(join(work, 'out-strict', 'onnxruntime.dll'), 'utf8')).toBe('MZ-ort-native');
    expect(existsSync(join(work, 'out-strict', 'DirectML.Debug.dll'))).toBe(false);

    // Missing required DirectML.dll fails closed under requireWinAsr
    rmSync(join(sdkDir, 'bin', 'x64-win', 'DirectML.dll'));
    expect(() =>
      buildWindowsSpeechHelper({
        srcDir,
        outDir: join(work, 'out-missing-dll'),
        requireWinAsr: true,
        env: { IMCODES_ONNXRUNTIME_WIN_DIR: sdkDir },
        execFn: (_cmd: string, args: string[]) => {
          if (args.includes('--build')) {
            mkdirSync(join(srcDir, 'build', 'Release'), { recursive: true });
            writeFileSync(join(srcDir, 'build', 'Release', 'imcodes-speech-win.exe'), 'MZ-win-asr', 'utf8');
          }
        },
      }),
    ).toThrow(/DirectML\.dll.*--require-win-asr/);

    // 3b. Prebuilt IMCODES_WIN_SPEECH_BIN_PATH + DLLs still validates current SDK when requireWinAsr=true
    const prebuiltDir = join(work, 'prebuilt-win');
    mkdirSync(prebuiltDir, { recursive: true });
    const prebuiltExe = join(prebuiltDir, 'imcodes-speech-win.exe');
    writeFileSync(prebuiltExe, 'MZ-prebuilt-win', 'utf8');
    writeFileSync(join(prebuiltDir, 'onnxruntime.dll'), 'MZ-prebuilt-ort', 'utf8');
    writeFileSync(join(prebuiltDir, 'DirectML.dll'), 'MZ-prebuilt-dml', 'utf8');
    expect(() =>
      buildWindowsSpeechHelper({
        outDir: join(work, 'out-prebuilt-no-sdk'),
        requireWinAsr: true,
        env: { IMCODES_WIN_SPEECH_BIN_PATH: prebuiltExe },
      }),
    ).toThrow(/ONNX Runtime DirectML Windows SDK missing or incomplete.*--require-win-asr/);

    const sdkNoLib = join(work, 'sdk-no-lib');
    mkdirSync(join(sdkNoLib, 'build', 'native', 'include'), { recursive: true });
    writeFileSync(join(sdkNoLib, 'build', 'native', 'include', 'onnxruntime_cxx_api.h'), '// header only\n', 'utf8');
    writeFileSync(join(sdkNoLib, 'build', 'native', 'include', 'dml_provider_factory.h'), '// dml header only\n', 'utf8');
    expect(() =>
      buildWindowsSpeechHelper({
        outDir: join(work, 'out-prebuilt-missing-lib'),
        requireWinAsr: true,
        env: {
          IMCODES_WIN_SPEECH_BIN_PATH: prebuiltExe,
          IMCODES_ONNXRUNTIME_WIN_DIR: sdkNoLib,
        },
      }),
    ).toThrow(/ONNX Runtime DirectML Windows SDK missing or incomplete.*--require-win-asr/);

    writeFileSync(join(sdkDir, 'bin', 'x64-win', 'DirectML.dll'), 'MZ-dml-bin-restored', 'utf8');
    const prebuiltWithValidSdk = buildWindowsSpeechHelper({
      outDir: join(work, 'out-prebuilt-valid'),
      requireWinAsr: true,
      env: {
        IMCODES_WIN_SPEECH_BIN_PATH: prebuiltExe,
        IMCODES_ONNXRUNTIME_WIN_DIR: sdkDir,
      },
    });
    expect(prebuiltWithValidSdk).not.toBeNull();
    expect(prebuiltWithValidSdk!.runtimeDlls.some((p: string) => p.endsWith('onnxruntime.dll'))).toBe(true);
    expect(prebuiltWithValidSdk!.runtimeDlls.some((p: string) => p.endsWith('DirectML.dll'))).toBe(true);

    // 3c. CMakeLists.txt must not reuse cached IMCODES_ORT_LIBRARY from SDK A when reconfiguring to header-only SDK B
    const cmakeProbe = spawnSync('cmake', ['--version'], { encoding: 'utf8' });
    if (cmakeProbe.status === 0) {
      const realWinSrc = resolve('apps/pc-app/native/win');
      const sdkA = join(work, 'cmake-sdk-a');
      const sdkB = join(work, 'cmake-sdk-b');
      const cmakeBuild = join(work, 'cmake-reconfig-build');
      mkdirSync(join(sdkA, 'build', 'native', 'include'), { recursive: true });
      mkdirSync(join(sdkA, 'runtimes', 'win-x64', 'native'), { recursive: true });
      mkdirSync(join(sdkB, 'build', 'native', 'include'), { recursive: true });
      writeFileSync(join(sdkA, 'build', 'native', 'include', 'onnxruntime_cxx_api.h'), '// sdk A\n', 'utf8');
      writeFileSync(join(sdkB, 'build', 'native', 'include', 'onnxruntime_cxx_api.h'), '// sdk B\n', 'utf8');
      const mockLibName = process.platform === 'win32'
        ? 'onnxruntime.lib'
        : process.platform === 'darwin'
          ? 'libonnxruntime.dylib'
          : 'libonnxruntime.so';
      writeFileSync(join(sdkA, 'runtimes', 'win-x64', 'native', mockLibName), 'mock-lib-a', 'utf8');

      const cfgA = spawnSync(
        'cmake',
        ['-S', realWinSrc, '-B', cmakeBuild, `-DONNXRUNTIME_DIR=${sdkA}`, '-DIMCODES_REQUIRE_ONNXRUNTIME=ON'],
        { encoding: 'utf8' },
      );
      expect(cfgA.status, cfgA.stderr).toBe(0);
      const cacheText = readFileSync(join(cmakeBuild, 'CMakeCache.txt'), 'utf8');
      const cachedLibMatch = cacheText.match(/^IMCODES_ORT_LIBRARY:FILEPATH=(.+)$/m);
      expect(cachedLibMatch).not.toBeNull();
      expect(cachedLibMatch![1]!.trim().replaceAll('\\', '/')).toBe(
        join(sdkA, 'runtimes', 'win-x64', 'native', mockLibName).replaceAll('\\', '/'),
      );

      const cfgB = spawnSync(
        'cmake',
        ['-S', realWinSrc, '-B', cmakeBuild, `-DONNXRUNTIME_DIR=${sdkB}`, '-DIMCODES_REQUIRE_ONNXRUNTIME=ON'],
        { encoding: 'utf8' },
      );
      expect(cfgB.status).not.toBe(0);
      expect(`${cfgB.stdout}\n${cfgB.stderr}`).toContain('ONNX Runtime Windows SDK missing or incomplete');
    }

    // 3d. buildLinuxSpeechHelper & Linux stagePcAppResources
    const linuxSrcDir = join(work, 'linux-src');
    mkdirSync(linuxSrcDir, { recursive: true });
    writeFileSync(join(linuxSrcDir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n', 'utf8');
    const linuxSdk = join(work, 'ort-linux-sdk');
    mkdirSync(join(linuxSdk, 'buildTransitive', 'native', 'include'), { recursive: true });
    mkdirSync(join(linuxSdk, 'runtimes', 'linux-x64', 'native'), { recursive: true });
    writeFileSync(join(linuxSdk, 'buildTransitive', 'native', 'include', 'onnxruntime_cxx_api.h'), '// linux ort\n', 'utf8');
    writeFileSync(join(linuxSdk, 'runtimes', 'linux-x64', 'native', 'libonnxruntime.so'), 'ELF-ort', 'utf8');
    writeFileSync(join(linuxSdk, 'runtimes', 'linux-x64', 'native', 'libonnxruntime_providers_cuda.so'), 'ELF-cuda', 'utf8');
    const linuxCmakeCalls: string[][] = [];
    const builtLinux = buildLinuxSpeechHelper({
      srcDir: linuxSrcDir,
      outDir: join(work, 'out-linux'),
      requireLinuxAsr: true,
      env: { IMCODES_ONNXRUNTIME_LINUX_DIR: linuxSdk },
      execFn: (_cmd: string, args: string[]) => {
        linuxCmakeCalls.push(args);
        if (args.includes('--build')) {
          mkdirSync(join(linuxSrcDir, 'build'), { recursive: true });
          writeFileSync(join(linuxSrcDir, 'build', 'imcodes-speech-linux'), '#!/bin/sh\n', { mode: 0o755 });
        }
      },
    });
    expect(linuxCmakeCalls[0]).toContain(`-DONNXRUNTIME_DIR=${linuxSdk}`);
    expect(linuxCmakeCalls[0]).toContain('-DIMCODES_REQUIRE_ONNXRUNTIME=ON');
    expect(builtLinux).not.toBeNull();
    expect(builtLinux!.runtimeLibs.map((p: string) => p.split(/[\\/]/).pop()).sort()).toEqual([
      'libonnxruntime.so',
      'libonnxruntime.so.1',
      'libonnxruntime_providers_cuda.so',
    ]);
    const linuxDaemonExe = join(work, 'imcodes-linux');
    writeFileSync(linuxDaemonExe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const stagedLinux = stagePcAppResources({
      platform: 'linux',
      nodeExePath: linuxDaemonExe,
      linuxSpeechBinPath: builtLinux!.binPath,
      linuxSpeechRuntimeLibs: builtLinux!.runtimeLibs,
      requireLinuxAsr: true,
      stageDir: join(work, 'stage-linux'),
    });
    expect(existsSync(stagedLinux.linuxSpeechBinPath!)).toBe(true);
    expect(existsSync(join(work, 'stage-linux', 'libonnxruntime.so'))).toBe(true);
    expect(existsSync(join(work, 'stage-linux', 'libonnxruntime.so.1'))).toBe(true);

    // 4. verifyPackagedWindowsDir checks helper, DLLs (onnxruntime + DirectML), and probe localAsrSupported: true
    const winUnpacked = join(work, 'win-unpacked');
    mkdirSync(join(winUnpacked, 'resources'), { recursive: true });
    writeFileSync(join(winUnpacked, 'IM.codes.exe'), 'MZ-shell', 'utf8');
    writeFileSync(join(winUnpacked, 'resources', 'imcodes.exe'), 'MZ-daemon', 'utf8');

    expect(() =>
      verifyPackagedWindowsDir(winUnpacked, { requireWinAsr: true }),
    ).toThrow(/imcodes-speech-win\.exe missing/);

    writeFileSync(join(winUnpacked, 'resources', 'imcodes-speech-win.exe'), 'MZ-helper', 'utf8');
    writeFileSync(join(winUnpacked, 'resources', 'onnxruntime.dll'), 'MZ-ort', 'utf8');
    expect(() =>
      verifyPackagedWindowsDir(winUnpacked, { requireWinAsr: true }),
    ).toThrow(/DirectML\.dll/);

    writeFileSync(join(winUnpacked, 'resources', 'DirectML.dll'), 'MZ-dml', 'utf8');
    expect(() =>
      verifyPackagedWindowsDir(winUnpacked, {
        requireWinAsr: true,
        platform: 'win32',
        execFn: (_cmd: string, args: string[]) => {
          if (args[0] === '--version') return '0.1.10\n';
          if (args[0] === 'probe') return JSON.stringify({ ok: true, localAsrSupported: false });
          return '';
        },
      }),
    ).toThrow(/probe failed localAsrSupported/);

    const verified = verifyPackagedWindowsDir(winUnpacked, {
      requireWinAsr: true,
      platform: 'win32',
      execFn: (_cmd: string, args: string[]) => {
        if (args[0] === '--version') return '0.1.10\n';
        if (args[0] === 'probe') return JSON.stringify({ ok: true, localAsrSupported: true });
        return '';
      },
    });
    expect(verified.winSpeechPresent).toBe(true);
    expect(verified.winAsrProbeVerified).toBe(true);

    // 5. runBuildPcApp propagates requireWinAsr to build + verify
    const verifyOnlyStrictCalls: Array<{ requireWinAsr: boolean }> = [];
    await runBuildPcApp(
      {
        platform: 'win32',
        arch: 'x64',
        winDir: winUnpacked,
        requireWinAsr: true,
        verifyOnly: true,
      },
      {
        platform: 'win32',
        verifyPackagedWindowsDirFn: (_dir: string, vOpts: { requireWinAsr: boolean }) => {
          verifyOnlyStrictCalls.push({ requireWinAsr: vOpts.requireWinAsr });
          return { winAsrProbeVerified: true };
        },
      },
    );
    expect(verifyOnlyStrictCalls).toEqual([{ requireWinAsr: true }]);

    // 6. C++/CI contract checks
    const cppSrc = readFileSync('apps/pc-app/native/win/imcodes-speech-win.cpp', 'utf8');
    expect(cppSrc).toContain('#ifdef IMCODES_HAS_ONNXRUNTIME');
    expect(cppSrc).toContain('\\"localAsrSupported\\":true}');
    expect(cppSrc).toContain('\\"localAsrSupported\\":false}');
    const linuxCppSrc = readFileSync('apps/pc-app/native/linux/imcodes-speech-linux.cpp', 'utf8');
    expect(linuxCppSrc).toContain('#ifdef IMCODES_HAS_ONNXRUNTIME');
    expect(linuxCppSrc).toContain('\\"localAsrSupported\\":true}');
    expect(linuxCppSrc).toContain('\\"localAsrSupported\\":false}');
    const wfYml = readFileSync('.github/workflows/build-pc-app.yml', 'utf8');
    expect(wfYml).toContain('IMCODES_ONNXRUNTIME_WIN_DIR');
    expect(wfYml).toContain('Microsoft.ML.OnnxRuntime.DirectML');
    expect(wfYml).toContain('Microsoft.AI.DirectML');
    expect(wfYml).toContain('--require-win-asr');
  });
});
