#!/usr/bin/env node
/**
 * Build and verify IM.codes PC App V1 distributables (`docs/pc.v1.app.md` Phase D):
 *   - macOS `.app` + `.dmg` bundling `imcodes` SEA + universal `bin/tmux` + `terminfo/` + `licenses/`
 *   - Windows `.exe` (NSIS) bundling `imcodes.exe` SEA
 *
 * Usage:
 *   node scripts/build-pc-app.mjs [--platform darwin|win32] [--arch arm64|x64|universal]
 *     [--version <semver>] [--node-exe <path>] [--tmux-dir <dir>] [--out-dir <dir>]
 *     [--stage-dir <dir>] [--require-sign] [--require-notarize] [--require-mlx] [--require-win-asr] [--skip-build]
 *   node scripts/build-pc-app.mjs --verify-only --app-path <IM.codes.app> [--require-notarize] [--require-mlx]
 *   node scripts/build-pc-app.mjs --verify-only --win-dir <win-unpacked> [--installer-exe <setup.exe>] [--require-win-asr]
 */

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildMacosBundledTmux,
  validateBundledTmuxLayout,
  verifyBundledTmux,
} from './build-macos-bundled-tmux.mjs';
import { createPcAppElectronBuilderConfig, PC_APP_DIR, resolveMacosSigningOptions } from '../apps/pc-app/electron-builder.config.mjs';
import { writePcAppBuildConfig } from '../apps/pc-app/scripts/write-build-config.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const DEFAULT_NODE_EXE_DIR = join(REPO_ROOT, 'dist-node-exe');
export const DEFAULT_TMUX_DIR = join(DEFAULT_NODE_EXE_DIR, 'bundled-tmux-macos');
export const DEFAULT_SPEECH_SWIFT_SRC = join(PC_APP_DIR, 'native', 'imcodes-speech.swift');
export const DEFAULT_SPEECH_MLX_PKG_DIR = join(PC_APP_DIR, 'native', 'qwen3-asr');
export const DEFAULT_SPEECH_BIN_DIR = join(DEFAULT_NODE_EXE_DIR, 'speech-helper-macos');
export const DEFAULT_WIN_SPEECH_SRC_DIR = join(PC_APP_DIR, 'native', 'win');
export const DEFAULT_WIN_SPEECH_BIN_DIR = join(DEFAULT_NODE_EXE_DIR, 'speech-helper-win');
export const DEFAULT_STAGE_ROOT = join(REPO_ROOT, '.pc-app-stage');
export const DEFAULT_PC_APP_OUT_DIR = join(PC_APP_DIR, 'release');

export function parseBuildPcAppArgs(
  argv = process.argv.slice(2),
  { platform = process.platform, hostArch = process.arch } = {},
) {
  const platformDefault = platform === 'win32' ? 'win32' : 'darwin';
  const opts = {
    platform: platformDefault,
    arch: '',
    archExplicit: false,
    version: process.env.IMCODES_BUILD_VERSION?.trim() || '',
    nodeExe: '',
    tmuxDir: '',
    outDir: DEFAULT_PC_APP_OUT_DIR,
    stageDir: '',
    appPath: '',
    winDir: '',
    installerExe: '',
    requireSign: false,
    requireNotarize: false,
    requireMlx: false,
    requireWinAsr: false,
    skipBuild: false,
    verifyOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform' && argv[i + 1]) {
      opts.platform = String(argv[++i]).trim();
    } else if (arg === '--arch' && argv[i + 1]) {
      opts.arch = String(argv[++i]).trim();
      opts.archExplicit = true;
    } else if (arg === '--version' && argv[i + 1]) {
      opts.version = String(argv[++i]).trim();
    } else if (arg === '--node-exe' && argv[i + 1]) {
      opts.nodeExe = resolve(argv[++i]);
    } else if (arg === '--tmux-dir' && argv[i + 1]) {
      opts.tmuxDir = resolve(argv[++i]);
    } else if (arg === '--out-dir' && argv[i + 1]) {
      opts.outDir = resolve(argv[++i]);
    } else if (arg === '--stage-dir' && argv[i + 1]) {
      opts.stageDir = resolve(argv[++i]);
    } else if (arg === '--app-path' && argv[i + 1]) {
      opts.appPath = resolve(argv[++i]);
    } else if (arg === '--win-dir' && argv[i + 1]) {
      opts.winDir = resolve(argv[++i]);
    } else if (arg === '--installer-exe' && argv[i + 1]) {
      opts.installerExe = resolve(argv[++i]);
    } else if (arg === '--require-sign') {
      opts.requireSign = true;
    } else if (arg === '--require-notarize') {
      opts.requireNotarize = true;
      opts.requireSign = true;
    } else if (arg === '--require-mlx') {
      opts.requireMlx = true;
    } else if (arg === '--require-win-asr') {
      opts.requireWinAsr = true;
    } else if (arg === '--skip-build') {
      opts.skipBuild = true;
    } else if (arg === '--verify-only') {
      opts.verifyOnly = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (opts.platform !== 'darwin' && opts.platform !== 'win32') {
    throw new Error(`Unsupported pc-app target platform: ${opts.platform} (expected darwin or win32)`);
  }
  if (!opts.arch) {
    opts.arch = opts.platform === 'win32' ? 'x64' : (hostArch === 'arm64' ? 'arm64' : 'x64');
  }
  if (!opts.stageDir) {
    opts.stageDir = join(DEFAULT_STAGE_ROOT, opts.platform);
  }
  return opts;
}

/**
 * Strip `IMCODES_REQUIRE_COMPUTER_USE_HELPER` per `docs/pc.v1.app.md` §6.2 so
 * PC App V1 builds do not fail when optional OCU helper assets are absent.
 */
export function buildPcAppNodeExeEnv(baseEnv = process.env) {
  const nextEnv = { ...baseEnv };
  delete nextEnv.IMCODES_REQUIRE_COMPUTER_USE_HELPER;
  return nextEnv;
}

/**
 * Resolve the unpacked `.app` directory produced by electron-builder for a macOS arch.
 */
export function resolveElectronBuilderMacAppPath(outDir, arch, productName = 'IM.codes') {
  const subdir = arch === 'x64' ? 'mac' : `mac-${arch}`;
  return join(resolve(outDir), subdir, `${productName}.app`);
}

const MACOS_SPEECH_HELPER_IDENTIFIER = 'codes.im.pc';

function hasDeveloperIdSigningEnv(env = process.env) {
  return resolveMacosSigningOptions(env).mode !== 'ad-hoc'
    || Boolean(env.MACOS_CODESIGN_IDENTITY?.trim());
}

function adHocSignMacosSpeechHelper(execFn, binPath) {
  try {
    execFn('codesign', ['--force', '--sign', '-', '-i', MACOS_SPEECH_HELPER_IDENTIFIER, binPath], {
      stdio: 'pipe',
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

/**
 * Re-sign `Contents/Resources/imcodes-speech` with `Identifier=codes.im.pc` and re-seal the outer
 * ad-hoc `.app` bundle after `electron-builder` overwrites extraResources with a hashed identifier.
 * Skipped when Developer ID signing (`IMCODES_MACOS_SIGNING_IDENTITY`/`CSC_NAME`/`CSC_LINK`/
 * `MACOS_CODESIGN_IDENTITY`) is active.
 */
export function resealMacosAppSpeechHelper(
  appPath,
  {
    env = process.env,
    execFn = execFileSync,
  } = {},
) {
  if (hasDeveloperIdSigningEnv(env)) {
    return { resealed: false, reason: 'developer_id_signing' };
  }
  const absApp = resolve(appPath);
  const speechBin = join(absApp, 'Contents', 'Resources', 'imcodes-speech');
  if (!existsSync(speechBin)) {
    return { resealed: false, reason: 'speech_helper_missing' };
  }
  execFn('codesign', ['--force', '--sign', '-', '-i', MACOS_SPEECH_HELPER_IDENTIFIER, speechBin], {
    stdio: 'pipe',
  });
  execFn('codesign', ['--force', '--sign', '-', absApp], {
    stdio: 'pipe',
  });
  return { resealed: true, speechBin, identifier: MACOS_SPEECH_HELPER_IDENTIFIER };
}

/**
 * Compile `apps/pc-app/native/imcodes-speech.swift` into a macOS binary (`universal`, `arm64`, or `x64`).
 */
export function buildMacosSpeechHelper({
  srcPath = DEFAULT_SPEECH_SWIFT_SRC,
  outPath = join(DEFAULT_SPEECH_BIN_DIR, 'imcodes-speech'),
  arch = 'universal',
  execFn = execFileSync,
} = {}) {
  if (!existsSync(srcPath)) {
    throw new Error(`Swift speech helper source missing at ${srcPath}`);
  }
  const absOut = resolve(outPath);
  mkdirSync(dirname(absOut), { recursive: true });
  const targetArchs = arch === 'universal'
    ? ['arm64', 'x86_64']
    : [arch === 'x64' ? 'x86_64' : 'arm64'];
  const frameworkArgs = ['-framework', 'Cocoa', '-framework', 'CoreGraphics', '-framework', 'ApplicationServices', '-framework', 'IOKit'];
  if (targetArchs.length === 1) {
    execFn('swiftc', ['-O', '-target', `${targetArchs[0]}-apple-macosx12.0`, ...frameworkArgs, srcPath, '-o', absOut], {
      stdio: 'inherit',
    });
    chmodSync(absOut, 0o755);
    adHocSignMacosSpeechHelper(execFn, absOut);
    return absOut;
  }
  const workDir = mkdtempSync(join(tmpdir(), 'imcodes-speech-build-'));
  try {
    const thinBins = targetArchs.map((targetArch) => {
      const binPath = join(workDir, `imcodes-speech-${targetArch}`);
      execFn('swiftc', ['-O', '-target', `${targetArch}-apple-macosx12.0`, ...frameworkArgs, srcPath, '-o', binPath], {
        stdio: 'inherit',
      });
      return binPath;
    });
    execFn('lipo', ['-create', ...thinBins, '-output', absOut], { stdio: 'inherit' });
    chmodSync(absOut, 0o755);
    adHocSignMacosSpeechHelper(execFn, absOut);
    return absOut;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function inspectRegularFile(filePath) {
  if (!existsSync(filePath)) {
    return { exists: false, isFile: false, size: 0 };
  }
  const st = statSync(filePath);
  const isFile = st.isFile();
  return { exists: true, isFile, size: isFile ? st.size : 0 };
}

function findReleaseMetallib(rootDir) {
  if (!existsSync(rootDir)) return null;
  const queue = [rootDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (
        (entry.name === 'mlx.metallib' || entry.name === 'default.metallib')
        && inspectRegularFile(fullPath).isFile
      ) {
        return fullPath;
      }
    }
  }
  return null;
}

/**
 * Compile the macOS Apple Silicon Qwen3-ASR MLX helper (`imcodes-speech-mlx`) via `xcodebuild`
 * (required so `mlx-swift` Metal shaders compile into `mlx.metallib` / `default.metallib`),
 * falling back to `swift build` when `xcodebuild` is unavailable or fails.
 * Returns `null` on Intel-only (`x64`) builds or when the host lacks MLX build support (system fallback)
 * unless `requireMlx` is `true`, in which case missing non-x64 MLX binary or Metal shader library throws.
 */
export function buildMacosSpeechMlxHelper({
  pkgDir = DEFAULT_SPEECH_MLX_PKG_DIR,
  outDir = DEFAULT_SPEECH_BIN_DIR,
  arch = 'arm64',
  requireMlx = false,
  execFn = execFileSync,
  warnFn = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  if (arch === 'x64') {
    return null;
  }
  const failOrFallback = (baseMsg, fallbackNote) => {
    if (requireMlx) {
      throw new Error(`${baseMsg} (--require-mlx)`);
    }
    warnFn(`${baseMsg}; ${fallbackNote}`);
    return null;
  };
  const manifestPath = join(resolve(pkgDir), 'Package.swift');
  if (!existsSync(manifestPath)) {
    return failOrFallback(`[pc-app build] MLX speech package missing at ${pkgDir}`, 'falling back to system speech');
  }
  const absPkgDir = resolve(pkgDir);
  const absOutDir = resolve(outDir);
  const derivedDataDir = join(absPkgDir, '.build', 'xcode-dd');

  let builtBin = null;
  let builtMetallib = null;

  try {
    execFn(
      'xcodebuild',
      [
        '-scheme',
        'ImcodesSpeechMlx',
        '-configuration',
        'Release',
        '-destination',
        'platform=macOS,arch=arm64',
        '-derivedDataPath',
        derivedDataDir,
      ],
      {
        cwd: absPkgDir,
        stdio: 'inherit',
      },
    );
    const xcodeReleaseDir = join(derivedDataDir, 'Build', 'Products', 'Release');
    const xcodeBin = join(xcodeReleaseDir, 'imcodes-speech-mlx');
    if (inspectRegularFile(xcodeBin).isFile) {
      builtBin = xcodeBin;
      builtMetallib = findReleaseMetallib(xcodeReleaseDir);
    } else {
      warnFn(
        `[pc-app build] xcodebuild produced no imcodes-speech-mlx binary under ${xcodeReleaseDir}; falling back to swift build`,
      );
    }
  } catch (err) {
    warnFn(
      `[pc-app build] xcodebuild for Qwen3-ASR MLX failed (${err instanceof Error ? err.message : String(err)}); falling back to swift build`,
    );
  }

  if (!builtBin) {
    try {
      execFn('swift', ['build', '--package-path', absPkgDir, '--arch', 'arm64', '-c', 'release'], {
        cwd: absPkgDir,
        stdio: 'inherit',
      });
    } catch (err) {
      return failOrFallback(
        `[pc-app build] swift build for Qwen3-ASR MLX failed (${err instanceof Error ? err.message : String(err)})`,
        'falling back to system speech',
      );
    }

    const binCandidates = [
      join(absPkgDir, '.build', 'release', 'imcodes-speech-mlx'),
      join(absPkgDir, '.build', 'arm64-apple-macosx', 'release', 'imcodes-speech-mlx'),
    ];
    builtBin = binCandidates.find((p) => inspectRegularFile(p).isFile) ?? null;
    if (!builtBin) {
      return failOrFallback(
        `[pc-app build] imcodes-speech-mlx binary not produced under ${absPkgDir}/.build`,
        'falling back to system speech',
      );
    }
    builtMetallib =
      findReleaseMetallib(join(absPkgDir, '.build', 'arm64-apple-macosx', 'release'))
      ?? findReleaseMetallib(join(absPkgDir, '.build', 'release'));
  }

  if (builtMetallib) {
    const metallibInfo = inspectRegularFile(builtMetallib);
    if (!metallibInfo.isFile || metallibInfo.size === 0) {
      builtMetallib = null;
    }
  }
  if (!builtMetallib && requireMlx) {
    throw new Error('[pc-app build] mlx.metallib/default.metallib not generated (--require-mlx)');
  }

  mkdirSync(absOutDir, { recursive: true });
  const destBin = join(absOutDir, 'imcodes-speech-mlx');
  cpSync(builtBin, destBin);
  chmodSync(destBin, 0o755);

  let destMetallib = null;
  if (builtMetallib) {
    destMetallib = join(absOutDir, 'mlx.metallib');
    cpSync(builtMetallib, destMetallib);
  } else {
    warnFn('[pc-app build] mlx.metallib/default.metallib not generated (MetalToolchain missing?); runtime will fall back to system speech');
  }

  return {
    binPath: destBin,
    metallibPath: destMetallib,
  };
}

const REQUIRED_WIN_ASR_DLLS = ['sherpa-onnx-c-api.dll', 'onnxruntime.dll'];

function collectDllsFromDirs(sourceDirs, destDir) {
  const seen = new Set();
  const copied = [];
  for (const dir of sourceDirs) {
    if (!dir || !existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.toLowerCase().endsWith('.dll')) continue;
      const lower = entry.toLowerCase();
      if (seen.has(lower)) continue;
      const srcPath = join(dir, entry);
      if (!inspectRegularFile(srcPath).isFile) continue;
      seen.add(lower);
      const destDll = join(destDir, entry);
      cpSync(srcPath, destDll);
      copied.push(destDll);
    }
  }
  return copied;
}

function assertRequiredWinAsrDlls(dllPaths, contextLabel) {
  const presentLower = new Set(
    dllPaths
      .filter((p) => p && inspectRegularFile(p).isFile && inspectRegularFile(p).size > 0)
      .map((p) => p.split(/[\\/]/).pop().toLowerCase()),
  );
  const missing = REQUIRED_WIN_ASR_DLLS.filter((name) => !presentLower.has(name));
  if (missing.length > 0) {
    throw new Error(`[pc-app build] Missing required Windows ASR DLL(s) (${missing.join(', ')}) in ${contextLabel} (--require-win-asr)`);
  }
}

function assertValidWinAsrSdk(sherpaSdkDir) {
  const absSdkDir = sherpaSdkDir ? resolve(sherpaSdkDir) : '';
  const headerPath = absSdkDir ? join(absSdkDir, 'include', 'sherpa-onnx', 'c-api', 'c-api.h') : '';
  const importLibPath = absSdkDir ? join(absSdkDir, 'lib', 'sherpa-onnx-c-api.lib') : '';
  if (
    !absSdkDir
    || !inspectRegularFile(headerPath).isFile
    || inspectRegularFile(headerPath).size === 0
    || !inspectRegularFile(importLibPath).isFile
    || inspectRegularFile(importLibPath).size === 0
  ) {
    throw new Error(
      '[pc-app build] sherpa-onnx Windows C API SDK missing or incomplete (set IMCODES_SHERPA_ONNX_WIN_DIR or SHERPA_ONNX_DIR with include/sherpa-onnx/c-api/c-api.h and lib/sherpa-onnx-c-api.lib) (--require-win-asr)',
    );
  }
  return absSdkDir;
}

/**
 * Compile or collect `imcodes-speech-win.exe` (and companion sherpa-onnx / ONNX Runtime DLLs)
 * on Windows hosts (`cmake` when available; returns `null` when native toolchain/SDK is absent
 * unless `requireWinAsr` is `true`, in which case missing SDK, binary, or DLLs throws).
 */
export function buildWindowsSpeechHelper({
  srcDir = DEFAULT_WIN_SPEECH_SRC_DIR,
  outDir = DEFAULT_WIN_SPEECH_BIN_DIR,
  arch = 'x64',
  requireWinAsr = false,
  execFn = execFileSync,
  warnFn = (msg) => process.stderr.write(`${msg}\n`),
  env = process.env,
} = {}) {
  const failOrWarn = (msg) => {
    if (requireWinAsr) {
      throw new Error(`${msg} (--require-win-asr)`);
    }
    warnFn(msg);
    return null;
  };
  const rawSdkDir = env.IMCODES_SHERPA_ONNX_WIN_DIR?.trim() || env.SHERPA_ONNX_DIR?.trim() || '';
  const sherpaSdkDir = requireWinAsr ? assertValidWinAsrSdk(rawSdkDir) : (rawSdkDir ? resolve(rawSdkDir) : '');
  const sdkDllDirs = sherpaSdkDir
    ? [join(sherpaSdkDir, 'lib'), join(sherpaSdkDir, 'bin')]
    : [];
  const prebuiltPath = env.IMCODES_WIN_SPEECH_BIN_PATH?.trim();
  const absOutDir = resolve(outDir);
  if (prebuiltPath && existsSync(prebuiltPath)) {
    mkdirSync(absOutDir, { recursive: true });
    const destBin = join(absOutDir, 'imcodes-speech-win.exe');
    cpSync(prebuiltPath, destBin);
    const runtimeDlls = collectDllsFromDirs([dirname(resolve(prebuiltPath)), ...sdkDllDirs], absOutDir);
    if (requireWinAsr) {
      assertRequiredWinAsrDlls(runtimeDlls, absOutDir);
    }
    return { binPath: destBin, runtimeDlls };
  }

  const cmakeLists = join(resolve(srcDir), 'CMakeLists.txt');
  if (!existsSync(cmakeLists)) {
    return failOrWarn(`[pc-app build] Windows speech CMake source missing at ${srcDir}; skipping imcodes-speech-win.exe`);
  }

  const buildDir = join(resolve(srcDir), 'build');
  try {
    const cmakeArgs = ['-S', resolve(srcDir), '-B', buildDir, '-A', arch === 'arm64' ? 'ARM64' : 'x64'];
    if (sherpaSdkDir) {
      cmakeArgs.push(`-DSHERPA_ONNX_DIR=${sherpaSdkDir}`);
    }
    if (requireWinAsr) {
      cmakeArgs.push('-DIMCODES_REQUIRE_SHERPA_ONNX=ON');
    }
    execFn('cmake', cmakeArgs, { stdio: 'inherit', env });
    execFn('cmake', ['--build', buildDir, '--config', 'Release'], { stdio: 'inherit', env });
  } catch (err) {
    return failOrWarn(
      `[pc-app build] CMake build for imcodes-speech-win.exe failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const builtBin = [
    join(buildDir, 'Release', 'imcodes-speech-win.exe'),
    join(buildDir, 'imcodes-speech-win.exe'),
  ].find((p) => existsSync(p));
  if (!builtBin) {
    return failOrWarn(`[pc-app build] imcodes-speech-win.exe not produced under ${buildDir}`);
  }

  mkdirSync(absOutDir, { recursive: true });
  const destBin = join(absOutDir, 'imcodes-speech-win.exe');
  cpSync(builtBin, destBin);
  const runtimeDlls = collectDllsFromDirs(sdkDllDirs, absOutDir);
  if (requireWinAsr) {
    assertRequiredWinAsrDlls(runtimeDlls, absOutDir);
  }
  return { binPath: destBin, runtimeDlls };
}

/**
 * Stage `extraResources` for macOS or Windows prior to `electron-builder` packing/signing.
 * - macOS: `imcodes`, `imcodes-speech` (when provided), optional `imcodes-speech-mlx` (+ `mlx.metallib`), `bin/tmux`, `terminfo/`, `licenses/`
 * - Windows: `imcodes.exe`, optional `imcodes-speech-win.exe` (+ companion `.dll`s)
 */
export function stagePcAppResources({
  platform,
  nodeExePath,
  tmuxDir,
  speechBinPath,
  mlxSpeechBinPath,
  mlxMetallibPath,
  winSpeechBinPath,
  winSpeechRuntimeDlls,
  requireWinAsr = false,
  stageDir,
}) {
  if (!nodeExePath || !existsSync(nodeExePath)) {
    throw new Error(`Standalone daemon binary missing at ${nodeExePath}`);
  }
  const absStageDir = resolve(stageDir);
  rmSync(absStageDir, { recursive: true, force: true });
  mkdirSync(absStageDir, { recursive: true });

  if (platform === 'darwin') {
    accessSync(nodeExePath, fsConstants.X_OK);
    const destExe = join(absStageDir, 'imcodes');
    cpSync(nodeExePath, destExe);
    chmodSync(destExe, 0o755);

    let destSpeech = null;
    if (speechBinPath) {
      if (!existsSync(speechBinPath)) {
        throw new Error(`Speech helper binary missing at ${speechBinPath}`);
      }
      accessSync(speechBinPath, fsConstants.X_OK);
      destSpeech = join(absStageDir, 'imcodes-speech');
      cpSync(speechBinPath, destSpeech);
      chmodSync(destSpeech, 0o755);
    }

    let destMlxSpeech = null;
    if (mlxSpeechBinPath && inspectRegularFile(mlxSpeechBinPath).isFile) {
      accessSync(mlxSpeechBinPath, fsConstants.X_OK);
      destMlxSpeech = join(absStageDir, 'imcodes-speech-mlx');
      cpSync(mlxSpeechBinPath, destMlxSpeech);
      chmodSync(destMlxSpeech, 0o755);
      const metallibInfo = mlxMetallibPath ? inspectRegularFile(mlxMetallibPath) : null;
      if (metallibInfo?.isFile && metallibInfo.size > 0) {
        cpSync(mlxMetallibPath, join(absStageDir, 'mlx.metallib'));
      }
    }

    const layout = validateBundledTmuxLayout(tmuxDir);
    const destBinDir = join(absStageDir, 'bin');
    const destTmux = join(destBinDir, 'tmux');
    mkdirSync(destBinDir, { recursive: true });
    cpSync(layout.tmuxBin, destTmux);
    chmodSync(destTmux, 0o755);
    cpSync(layout.terminfoDir, join(absStageDir, 'terminfo'), { recursive: true });
    cpSync(layout.licensesDir, join(absStageDir, 'licenses'), { recursive: true });

    return {
      stageDir: absStageDir,
      imcodesPath: destExe,
      ...(destSpeech ? { speechBinPath: destSpeech } : {}),
      ...(destMlxSpeech ? { mlxSpeechBinPath: destMlxSpeech } : {}),
      tmuxBin: destTmux,
      terminfoDir: join(absStageDir, 'terminfo'),
      licensesDir: join(absStageDir, 'licenses'),
    };
  }

  if (platform === 'win32') {
    const destExe = join(absStageDir, 'imcodes.exe');
    cpSync(nodeExePath, destExe);
    if (statSync(destExe).size === 0) {
      throw new Error(`Staged imcodes.exe is empty at ${destExe}`);
    }
    let destWinSpeech = null;
    const stagedDlls = [];
    if (winSpeechBinPath && existsSync(winSpeechBinPath)) {
      destWinSpeech = join(absStageDir, 'imcodes-speech-win.exe');
      cpSync(winSpeechBinPath, destWinSpeech);
      for (const dllPath of winSpeechRuntimeDlls ?? []) {
        if (dllPath && existsSync(dllPath)) {
          const dllName = dllPath.split(/[\\/]/).pop();
          const destDll = join(absStageDir, dllName);
          if (resolve(dllPath) !== resolve(destDll)) {
            cpSync(dllPath, destDll);
          }
          stagedDlls.push(destDll);
        }
      }
    }
    if (requireWinAsr) {
      if (!destWinSpeech) {
        throw new Error(`Bundled imcodes-speech-win.exe missing for Windows staging at ${absStageDir} (--require-win-asr)`);
      }
      assertRequiredWinAsrDlls(stagedDlls, absStageDir);
    }
    return {
      stageDir: absStageDir,
      imcodesPath: destExe,
      ...(destWinSpeech ? { winSpeechBinPath: destWinSpeech, winSpeechRuntimeDlls: stagedDlls } : {}),
    };
  }

  throw new Error(`Unsupported platform for stagePcAppResources: ${platform}`);
}

/**
 * Verify all V1 packaging gates inside a built macOS `.app` bundle:
 *  - Presence & executable bit of `Contents/Resources/imcodes`
 *  - Gates ①, ②, layout (`bin/tmux`, `terminfo/`, `licenses/`), and ④ via `verifyBundledTmux`
 *  - Gate ③ (`codesign --verify --deep --strict <app>` plus nested `bin/tmux` & `imcodes`)
 *  - Optional `xcrun stapler validate <app>` when `requireNotarized` is true
 *  - `Contents/Resources/imcodes --version` execution in an isolated env with no OCU helper (§6.2)
 */
export function verifyPackagedMacosApp(
  appPath,
  {
    execFn = execFileSync,
    requireNotarized = false,
    requireMlx = false,
  } = {},
) {
  const absApp = resolve(appPath);
  if (!absApp.endsWith('.app') || !existsSync(absApp)) {
    throw new Error(`Packaged macOS .app bundle not found at ${absApp}`);
  }
  const resourcesDir = join(absApp, 'Contents', 'Resources');
  const bundledImcodes = join(resourcesDir, 'imcodes');
  const imcodesInfo = inspectRegularFile(bundledImcodes);
  if (!imcodesInfo.exists) {
    throw new Error(`Bundled imcodes daemon missing at ${bundledImcodes}`);
  }
  if (!imcodesInfo.isFile) {
    throw new Error(`Bundled imcodes daemon is not a regular file at ${bundledImcodes}`);
  }
  accessSync(bundledImcodes, fsConstants.X_OK);

  const bundledSpeech = join(resourcesDir, 'imcodes-speech');
  const speechInfo = inspectRegularFile(bundledSpeech);
  if (!speechInfo.exists) {
    throw new Error(`Bundled imcodes-speech helper missing at ${bundledSpeech}`);
  }
  if (!speechInfo.isFile) {
    throw new Error(`Bundled imcodes-speech helper is not a regular file at ${bundledSpeech}`);
  }
  accessSync(bundledSpeech, fsConstants.X_OK);

  const bundledMlxSpeech = join(resourcesDir, 'imcodes-speech-mlx');
  const mlxSpeechInfo = inspectRegularFile(bundledMlxSpeech);
  if (requireMlx && !mlxSpeechInfo.exists) {
    throw new Error(`Bundled imcodes-speech-mlx helper missing at ${bundledMlxSpeech}`);
  }
  if (mlxSpeechInfo.exists && !mlxSpeechInfo.isFile) {
    throw new Error(`Bundled imcodes-speech-mlx helper is not a regular file at ${bundledMlxSpeech}`);
  }
  const hasMlxSpeech = mlxSpeechInfo.isFile;
  if (hasMlxSpeech) {
    accessSync(bundledMlxSpeech, fsConstants.X_OK);
  }
  const bundledMlxMetallib = join(resourcesDir, 'mlx.metallib');
  const metallibInfo = inspectRegularFile(bundledMlxMetallib);
  if (requireMlx) {
    if (!metallibInfo.exists) {
      throw new Error(`Bundled mlx.metallib missing at ${bundledMlxMetallib}`);
    }
    if (!metallibInfo.isFile) {
      throw new Error(`Bundled mlx.metallib is not a regular file at ${bundledMlxMetallib}`);
    }
    if (metallibInfo.size === 0) {
      throw new Error(`Bundled mlx.metallib is empty at ${bundledMlxMetallib}`);
    }
  }
  const hasMlxMetallib = metallibInfo.isFile && metallibInfo.size > 0;

  const tmuxReport = verifyBundledTmux(resourcesDir, { execFn });

  // Gate 3: verify nested Mach-O binaries explicitly, then deep-verify outer .app seal.
  execFn('codesign', ['--verify', '--strict', '--verbose=2', tmuxReport.tmuxBin], { stdio: 'pipe' });
  execFn('codesign', ['--verify', '--strict', '--verbose=2', bundledImcodes], { stdio: 'pipe' });
  execFn('codesign', ['--verify', '--strict', '--verbose=2', bundledSpeech], { stdio: 'pipe' });
  if (hasMlxSpeech) {
    execFn('codesign', ['--verify', '--strict', '--verbose=2', bundledMlxSpeech], { stdio: 'pipe' });
  }
  execFn('codesign', ['--verify', '--deep', '--strict', '--verbose=2', absApp], { stdio: 'pipe' });

  if (requireNotarized) {
    execFn('xcrun', ['stapler', 'validate', absApp], { stdio: 'pipe' });
  }

  // §6.2: prove the packaged daemon runs healthy without OCU helper in a clean isolated environment.
  const isolatedHome = mkdtempSync(join(tmpdir(), 'imcodes-pc-app-daemon-smoke-'));
  let daemonVersion = '';
  try {
    daemonVersion = String(execFn(bundledImcodes, ['--version'], {
      env: {
        HOME: isolatedHome,
        IMCODES_HOME: join(isolatedHome, '.imcodes'),
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
      encoding: 'utf8',
      stdio: 'pipe',
    }) ?? '').trim();
    if (!daemonVersion) {
      throw new Error(`Bundled imcodes returned empty --version output at ${bundledImcodes}`);
    }
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }

  return {
    appPath: absApp,
    resourcesDir,
    imcodesPath: bundledImcodes,
    ...(hasMlxSpeech ? { mlxSpeechPath: bundledMlxSpeech } : {}),
    mlxMetallibPresent: hasMlxMetallib,
    daemonVersion,
    tmuxReport,
    codesignVerified: true,
    stapleValidated: requireNotarized,
  };
}

/**
 * Verify a packaged Windows unpacked app directory (`resources/imcodes.exe` + optional NSIS `.exe`
 * Authenticode signature check).
 */
export function verifyPackagedWindowsDir(
  winUnpackedDir,
  {
    installerExePath,
    expectedSignerSha256 = '',
    requireWinAsr = false,
    platform = process.platform,
    execFn = execFileSync,
    env = process.env,
  } = {},
) {
  const absWinDir = resolve(winUnpackedDir);
  if (!existsSync(absWinDir)) {
    throw new Error(`Packaged Windows unpacked directory not found at ${absWinDir}`);
  }
  const appExe = join(absWinDir, 'IM.codes.exe');
  if (!existsSync(appExe) || statSync(appExe).size === 0) {
    throw new Error(`Packaged Windows shell executable missing at ${appExe}`);
  }
  const resourcesDir = join(absWinDir, 'resources');
  const bundledDaemon = join(resourcesDir, 'imcodes.exe');
  if (!existsSync(bundledDaemon) || statSync(bundledDaemon).size === 0) {
    throw new Error(`Bundled imcodes.exe missing at ${bundledDaemon}`);
  }
  if (installerExePath && !existsSync(resolve(installerExePath))) {
    throw new Error(`Windows NSIS installer missing at ${installerExePath}`);
  }

  const winSpeechExe = join(resourcesDir, 'imcodes-speech-win.exe');
  const winSpeechInfo = inspectRegularFile(winSpeechExe);
  const winSpeechPresent = winSpeechInfo.isFile && winSpeechInfo.size > 0;
  let winAsrProbeVerified = false;
  if (requireWinAsr) {
    if (!winSpeechPresent) {
      throw new Error(`Bundled imcodes-speech-win.exe missing or empty at ${winSpeechExe} (--require-win-asr)`);
    }
    const resourceEntries = readdirSync(resourcesDir).map((name) => join(resourcesDir, name));
    assertRequiredWinAsrDlls(resourceEntries, resourcesDir);
  }

  let daemonVersion = null;
  if (platform === 'win32') {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'imcodes-pc-app-win-smoke-'));
    try {
      daemonVersion = String(execFn(bundledDaemon, ['--version'], {
        env: {
          ...env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          IMCODES_HOME: join(isolatedHome, '.imcodes'),
        },
        encoding: 'utf8',
        stdio: 'pipe',
      }) ?? '').trim();
      if (!daemonVersion) {
        throw new Error(`Bundled imcodes.exe returned empty --version output at ${bundledDaemon}`);
      }
      if (requireWinAsr) {
        const rawProbe = String(execFn(winSpeechExe, ['probe'], {
          env: {
            ...env,
            HOME: isolatedHome,
            USERPROFILE: isolatedHome,
          },
          encoding: 'utf8',
          stdio: 'pipe',
        }) ?? '').trim();
        let parsedProbe;
        try {
          parsedProbe = JSON.parse(rawProbe);
        } catch (err) {
          throw new Error(
            `Packaged imcodes-speech-win.exe probe returned invalid JSON: ${rawProbe} (${err instanceof Error ? err.message : String(err)}) (--require-win-asr)`,
          );
        }
        if (!parsedProbe || parsedProbe.ok !== true || parsedProbe.localAsrSupported !== true) {
          throw new Error(
            `Packaged imcodes-speech-win.exe probe failed localAsrSupported check: ${rawProbe} (--require-win-asr)`,
          );
        }
        winAsrProbeVerified = true;
      }
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }

  if (expectedSignerSha256) {
    const systemRoot = env.SystemRoot?.trim();
    if (!systemRoot) throw new Error('SystemRoot is required for Windows signature verification');
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const signScript = join(REPO_ROOT, 'scripts', 'windows-sign-release-artifact.ps1');
    const toVerify = [appExe, bundledDaemon, ...(installerExePath ? [resolve(installerExePath)] : [])];
    for (const artifact of toVerify) {
      execFn(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        signScript,
        '-Mode',
        'Verify',
        '-ArtifactPath',
        artifact,
        '-ExpectedSignerSha256',
        expectedSignerSha256,
      ], { env, stdio: 'inherit' });
    }
  }

  return {
    winUnpackedDir: absWinDir,
    appExe,
    bundledDaemon,
    ...(winSpeechPresent ? { winSpeechExe } : {}),
    winSpeechPresent,
    winAsrProbeVerified,
    ...(installerExePath ? { installerExePath: resolve(installerExePath) } : {}),
    daemonVersion,
  };
}

function ensureBuiltNodeExe(opts) {
  const defaultPath = opts.platform === 'win32'
    ? join(DEFAULT_NODE_EXE_DIR, 'imcodes-node.exe')
    : join(DEFAULT_NODE_EXE_DIR, 'imcodes-node-macos');
  const candidate = opts.nodeExe || defaultPath;
  if (opts.nodeExe) {
    if (!existsSync(candidate)) {
      throw new Error(`Specified --node-exe does not exist: ${candidate}`);
    }
    return candidate;
  }
  const env = buildPcAppNodeExeEnv(process.env);
  if (opts.version) env.IMCODES_BUILD_VERSION = opts.version;
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'build-node-exe.mjs')], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });
  if (!existsSync(candidate)) {
    throw new Error(`build-node-exe.mjs did not produce expected binary at ${candidate}`);
  }
  return candidate;
}

async function ensureBuiltBundledTmux(opts) {
  const targetDir = opts.tmuxDir || DEFAULT_TMUX_DIR;
  if (opts.tmuxDir) {
    verifyBundledTmux(targetDir);
    return targetDir;
  }
  if (existsSync(join(targetDir, 'bin', 'tmux'))) {
    verifyBundledTmux(targetDir);
    return targetDir;
  }
  await buildMacosBundledTmux({ outDir: targetDir });
  return targetDir;
}

export async function runBuildPcApp(opts, deps = {}) {
  const hostPlatform = deps.platform ?? process.platform;
  const ensureNodeExeFn = deps.ensureBuiltNodeExeFn ?? ensureBuiltNodeExe;
  const ensureTmuxFn = deps.ensureBuiltBundledTmuxFn ?? ensureBuiltBundledTmux;
  const buildSpeechFn = deps.buildMacosSpeechHelperFn ?? buildMacosSpeechHelper;
  const buildSpeechMlxFn = deps.buildMacosSpeechMlxHelperFn ?? buildMacosSpeechMlxHelper;
  const buildWinSpeechFn = deps.buildWindowsSpeechHelperFn ?? buildWindowsSpeechHelper;
  const stageResourcesFn = deps.stagePcAppResourcesFn ?? stagePcAppResources;
  const verifyMacAppFn = deps.verifyPackagedMacosAppFn ?? verifyPackagedMacosApp;
  const verifyWinDirFn = deps.verifyPackagedWindowsDirFn ?? verifyPackagedWindowsDir;
  const execTscFn = deps.execFn ?? execFileSync;

  const isExplicitAppVerify = Boolean(opts.verifyOnly && opts.appPath);
  const isX64Exempt = isExplicitAppVerify
    ? opts.arch === 'x64' && opts.archExplicit === true
    : opts.arch === 'x64';
  const requireMlxForBuild = Boolean(opts.requireMlx) && !isX64Exempt;

  if (opts.verifyOnly) {
    if (opts.platform === 'darwin') {
      const appPath = opts.appPath || resolveElectronBuilderMacAppPath(opts.outDir, opts.arch);
      return verifyMacAppFn(appPath, {
        requireNotarized: opts.requireNotarize,
        requireMlx: requireMlxForBuild,
      });
    }
    const winDir = opts.winDir || join(opts.outDir, 'win-unpacked');
    return verifyWinDirFn(winDir, {
      installerExePath: opts.installerExe || undefined,
      expectedSignerSha256: process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256?.trim() ?? '',
      requireWinAsr: Boolean(opts.requireWinAsr),
    });
  }

  if (hostPlatform !== opts.platform) {
    throw new Error(`Building ${opts.platform} PC App must run on matching host OS (current: ${hostPlatform})`);
  }

  if (!opts.skipBuild) {
    const tscBin = join(PC_APP_DIR, 'node_modules', '.bin', hostPlatform === 'win32' ? 'tsc.cmd' : 'tsc');
    execTscFn(tscBin, ['-p', join(PC_APP_DIR, 'tsconfig.json')], {
      cwd: PC_APP_DIR,
      stdio: 'inherit',
      ...(hostPlatform === 'win32' ? { shell: true } : {}),
    });
    const writeBuildConfigFn = deps.writeBuildConfigFn ?? writePcAppBuildConfig;
    writeBuildConfigFn({ env: process.env });
  }

  const nodeExePath = ensureNodeExeFn(opts);
  const tmuxDir = opts.platform === 'darwin' ? await ensureTmuxFn(opts) : '';
  const speechBinPath = opts.platform === 'darwin'
    ? buildSpeechFn({ arch: opts.arch })
    : undefined;
  const mlxSpeech = opts.platform === 'darwin'
    ? buildSpeechMlxFn({ arch: opts.arch, requireMlx: requireMlxForBuild })
    : null;
  const winSpeech = opts.platform === 'win32'
    ? buildWinSpeechFn({ arch: opts.arch, requireWinAsr: Boolean(opts.requireWinAsr) })
    : null;

  const staged = stageResourcesFn({
    platform: opts.platform,
    nodeExePath,
    tmuxDir,
    speechBinPath,
    mlxSpeechBinPath: mlxSpeech?.binPath,
    mlxMetallibPath: mlxSpeech?.metallibPath ?? undefined,
    winSpeechBinPath: winSpeech?.binPath,
    winSpeechRuntimeDlls: winSpeech?.runtimeDlls,
    requireWinAsr: opts.platform === 'win32' ? Boolean(opts.requireWinAsr) : false,
    stageDir: opts.stageDir,
  });

  const childEnv = buildPcAppNodeExeEnv(process.env);
  childEnv.IMCODES_PC_APP_TARGET_PLATFORM = opts.platform;
  if (opts.requireSign) childEnv.IMCODES_PC_APP_REQUIRE_SIGNING = '1';
  if (opts.requireNotarize) childEnv.IMCODES_PC_APP_REQUIRE_NOTARIZE = '1';

  // Propagate strict signing/notary enforcement to hooks running in-process.
  process.env.IMCODES_PC_APP_TARGET_PLATFORM = opts.platform;
  if (opts.requireSign) process.env.IMCODES_PC_APP_REQUIRE_SIGNING = '1';
  if (opts.requireNotarize) process.env.IMCODES_PC_APP_REQUIRE_NOTARIZE = '1';
  delete process.env.IMCODES_REQUIRE_COMPUTER_USE_HELPER;

  const config = createPcAppElectronBuilderConfig({
    platform: opts.platform,
    macArch: opts.platform === 'darwin' ? opts.arch : 'arm64',
    winArch: opts.platform === 'win32' ? opts.arch : 'x64',
    outDir: opts.outDir,
    macStageDir: opts.platform === 'darwin' ? staged.stageDir : join(DEFAULT_STAGE_ROOT, 'darwin'),
    winStageDir: opts.platform === 'win32' ? staged.stageDir : join(DEFAULT_STAGE_ROOT, 'win32'),
    includeMlxSpeech: opts.platform === 'darwin' ? Boolean(staged.mlxSpeechBinPath) : false,
    version: opts.version || undefined,
    env: childEnv,
  });

  const electronBuilderBuildFn = deps.electronBuilderBuildFn ?? (async (buildOpts) => {
    const require = createRequire(join(PC_APP_DIR, 'package.json'));
    const electronBuilder = require('electron-builder');
    const targets = opts.platform === 'darwin'
      ? electronBuilder.Platform.MAC.createTarget(['dmg', 'zip'], electronBuilder.archFromString(opts.arch))
      : electronBuilder.Platform.WINDOWS.createTarget(['nsis'], electronBuilder.archFromString(opts.arch));
    return electronBuilder.build({
      targets,
      ...buildOpts,
    });
  });

  const artifactPaths = await electronBuilderBuildFn({
    projectDir: PC_APP_DIR,
    config,
    publish: 'never',
  });

  if (opts.platform === 'darwin') {
    const appPath = opts.appPath || resolveElectronBuilderMacAppPath(opts.outDir, opts.arch);
    if (existsSync(join(appPath, 'Contents', 'Info.plist')) || deps.execFn) {
      resealMacosAppSpeechHelper(appPath, { env: childEnv, execFn: execTscFn });
    }
    const verification = verifyMacAppFn(appPath, {
      requireNotarized: opts.requireNotarize,
      requireMlx: requireMlxForBuild,
    });
    return {
      platform: 'darwin',
      arch: opts.arch,
      artifactPaths,
      verification,
    };
  }

  const winUnpackedDir = join(opts.outDir, 'win-unpacked');
  const installerExePath = artifactPaths.find((p) => p.endsWith('.exe'))
    ?? readdirSync(opts.outDir).filter((f) => f.endsWith('.exe')).map((f) => join(opts.outDir, f))[0];
  const verification = verifyWinDirFn(winUnpackedDir, {
    installerExePath,
    expectedSignerSha256: childEnv.IMCODES_WINDOWS_SIGNING_CERT_SHA256?.trim() ?? '',
    requireWinAsr: Boolean(opts.requireWinAsr),
    env: childEnv,
  });
  return {
    platform: 'win32',
    arch: opts.arch,
    artifactPaths,
    verification,
  };
}

async function main() {
  const opts = parseBuildPcAppArgs();
  const report = await runBuildPcApp(opts);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
