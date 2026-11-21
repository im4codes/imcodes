#!/usr/bin/env node
/**
 * Build and verify IM.codes PC App V1 distributables (`docs/pc.v1.app.md` Phase D):
 *   - macOS `.app` + `.dmg` bundling `imcodes` SEA + universal `bin/tmux` + `terminfo/` + `licenses/`
 *   - Windows `.exe` (NSIS) bundling `imcodes.exe` SEA
 *
 * Usage:
 *   node scripts/build-pc-app.mjs [--platform darwin|win32] [--arch arm64|x64|universal]
 *     [--version <semver>] [--node-exe <path>] [--tmux-dir <dir>] [--out-dir <dir>]
 *     [--stage-dir <dir>] [--require-sign] [--require-notarize] [--skip-build]
 *   node scripts/build-pc-app.mjs --verify-only --app-path <IM.codes.app> [--require-notarize]
 *   node scripts/build-pc-app.mjs --verify-only --win-dir <win-unpacked> [--installer-exe <setup.exe>]
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
import { createPcAppElectronBuilderConfig, PC_APP_DIR } from '../apps/pc-app/electron-builder.config.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const DEFAULT_NODE_EXE_DIR = join(REPO_ROOT, 'dist-node-exe');
export const DEFAULT_TMUX_DIR = join(DEFAULT_NODE_EXE_DIR, 'bundled-tmux-macos');
export const DEFAULT_SPEECH_SWIFT_SRC = join(PC_APP_DIR, 'native', 'imcodes-speech.swift');
export const DEFAULT_SPEECH_MLX_PKG_DIR = join(PC_APP_DIR, 'native', 'qwen3-asr');
export const DEFAULT_SPEECH_BIN_DIR = join(DEFAULT_NODE_EXE_DIR, 'speech-helper-macos');
export const DEFAULT_STAGE_ROOT = join(REPO_ROOT, '.pc-app-stage');
export const DEFAULT_PC_APP_OUT_DIR = join(PC_APP_DIR, 'release');

export function parseBuildPcAppArgs(argv = process.argv.slice(2)) {
  const platformDefault = process.platform === 'win32' ? 'win32' : 'darwin';
  const opts = {
    platform: platformDefault,
    arch: '',
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
    skipBuild: false,
    verifyOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform' && argv[i + 1]) {
      opts.platform = String(argv[++i]).trim();
    } else if (arg === '--arch' && argv[i + 1]) {
      opts.arch = String(argv[++i]).trim();
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
    opts.arch = opts.platform === 'win32' ? 'x64' : (process.arch === 'arm64' ? 'arm64' : 'x64');
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
  if (targetArchs.length === 1) {
    execFn('swiftc', ['-O', '-target', `${targetArchs[0]}-apple-macosx12.0`, srcPath, '-o', absOut], {
      stdio: 'inherit',
    });
    chmodSync(absOut, 0o755);
    return absOut;
  }
  const workDir = mkdtempSync(join(tmpdir(), 'imcodes-speech-build-'));
  try {
    const thinBins = targetArchs.map((targetArch) => {
      const binPath = join(workDir, `imcodes-speech-${targetArch}`);
      execFn('swiftc', ['-O', '-target', `${targetArch}-apple-macosx12.0`, srcPath, '-o', binPath], {
        stdio: 'inherit',
      });
      return binPath;
    });
    execFn('lipo', ['-create', ...thinBins, '-output', absOut], { stdio: 'inherit' });
    chmodSync(absOut, 0o755);
    return absOut;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
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
      } else if (entry.name === 'mlx.metallib' || entry.name === 'default.metallib') {
        return fullPath;
      }
    }
  }
  return null;
}

/**
 * Compile the macOS Apple Silicon Qwen3-ASR MLX helper (`imcodes-speech-mlx`) via SwiftPM release build
 * and locate any generated `mlx.metallib` / `default.metallib`.
 * Returns `null` on Intel-only (`x64`) builds or when the host lacks MLX build support (system fallback).
 */
export function buildMacosSpeechMlxHelper({
  pkgDir = DEFAULT_SPEECH_MLX_PKG_DIR,
  outDir = DEFAULT_SPEECH_BIN_DIR,
  arch = 'arm64',
  execFn = execFileSync,
  warnFn = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  if (arch === 'x64') {
    return null;
  }
  const manifestPath = join(resolve(pkgDir), 'Package.swift');
  if (!existsSync(manifestPath)) {
    warnFn(`[pc-app build] MLX speech package missing at ${pkgDir}; falling back to system speech`);
    return null;
  }
  const absPkgDir = resolve(pkgDir);
  const absOutDir = resolve(outDir);
  try {
    execFn('swift', ['build', '--package-path', absPkgDir, '--arch', 'arm64', '-c', 'release'], {
      cwd: absPkgDir,
      stdio: 'inherit',
    });
  } catch (err) {
    warnFn(
      `[pc-app build] swift build for Qwen3-ASR MLX failed (${err instanceof Error ? err.message : String(err)}); falling back to system speech`,
    );
    return null;
  }

  const binCandidates = [
    join(absPkgDir, '.build', 'release', 'imcodes-speech-mlx'),
    join(absPkgDir, '.build', 'arm64-apple-macosx', 'release', 'imcodes-speech-mlx'),
  ];
  const builtBin = binCandidates.find((p) => existsSync(p));
  if (!builtBin) {
    warnFn(`[pc-app build] imcodes-speech-mlx binary not produced under ${absPkgDir}/.build; falling back to system speech`);
    return null;
  }

  mkdirSync(absOutDir, { recursive: true });
  const destBin = join(absOutDir, 'imcodes-speech-mlx');
  cpSync(builtBin, destBin);
  chmodSync(destBin, 0o755);

  const builtMetallib =
    findReleaseMetallib(join(absPkgDir, '.build', 'arm64-apple-macosx', 'release'))
    ?? findReleaseMetallib(join(absPkgDir, '.build', 'release'));
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

/**
 * Stage `extraResources` for macOS or Windows prior to `electron-builder` packing/signing.
 * - macOS: `imcodes`, `imcodes-speech` (when provided), optional `imcodes-speech-mlx` (+ `mlx.metallib`), `bin/tmux`, `terminfo/`, `licenses/`
 * - Windows: `imcodes.exe`
 */
export function stagePcAppResources({
  platform,
  nodeExePath,
  tmuxDir,
  speechBinPath,
  mlxSpeechBinPath,
  mlxMetallibPath,
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
    if (mlxSpeechBinPath && existsSync(mlxSpeechBinPath)) {
      accessSync(mlxSpeechBinPath, fsConstants.X_OK);
      destMlxSpeech = join(absStageDir, 'imcodes-speech-mlx');
      cpSync(mlxSpeechBinPath, destMlxSpeech);
      chmodSync(destMlxSpeech, 0o755);
      if (mlxMetallibPath && existsSync(mlxMetallibPath)) {
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
    return {
      stageDir: absStageDir,
      imcodesPath: destExe,
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
  } = {},
) {
  const absApp = resolve(appPath);
  if (!absApp.endsWith('.app') || !existsSync(absApp)) {
    throw new Error(`Packaged macOS .app bundle not found at ${absApp}`);
  }
  const resourcesDir = join(absApp, 'Contents', 'Resources');
  const bundledImcodes = join(resourcesDir, 'imcodes');
  if (!existsSync(bundledImcodes)) {
    throw new Error(`Bundled imcodes daemon missing at ${bundledImcodes}`);
  }
  accessSync(bundledImcodes, fsConstants.X_OK);

  const bundledSpeech = join(resourcesDir, 'imcodes-speech');
  if (!existsSync(bundledSpeech)) {
    throw new Error(`Bundled imcodes-speech helper missing at ${bundledSpeech}`);
  }
  accessSync(bundledSpeech, fsConstants.X_OK);

  const bundledMlxSpeech = join(resourcesDir, 'imcodes-speech-mlx');
  const hasMlxSpeech = existsSync(bundledMlxSpeech);
  if (hasMlxSpeech) {
    accessSync(bundledMlxSpeech, fsConstants.X_OK);
  }
  const bundledMlxMetallib = join(resourcesDir, 'mlx.metallib');
  const hasMlxMetallib = existsSync(bundledMlxMetallib);

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
  const bundledDaemon = join(absWinDir, 'resources', 'imcodes.exe');
  if (!existsSync(bundledDaemon) || statSync(bundledDaemon).size === 0) {
    throw new Error(`Bundled imcodes.exe missing at ${bundledDaemon}`);
  }
  if (installerExePath && !existsSync(resolve(installerExePath))) {
    throw new Error(`Windows NSIS installer missing at ${installerExePath}`);
  }

  let daemonVersion = null;
  if (process.platform === 'win32') {
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
  const stageResourcesFn = deps.stagePcAppResourcesFn ?? stagePcAppResources;
  const verifyMacAppFn = deps.verifyPackagedMacosAppFn ?? verifyPackagedMacosApp;
  const verifyWinDirFn = deps.verifyPackagedWindowsDirFn ?? verifyPackagedWindowsDir;
  const execTscFn = deps.execFn ?? execFileSync;

  if (opts.verifyOnly) {
    if (opts.platform === 'darwin') {
      const appPath = opts.appPath || resolveElectronBuilderMacAppPath(opts.outDir, opts.arch);
      return verifyMacAppFn(appPath, { requireNotarized: opts.requireNotarize });
    }
    const winDir = opts.winDir || join(opts.outDir, 'win-unpacked');
    return verifyWinDirFn(winDir, {
      installerExePath: opts.installerExe || undefined,
      expectedSignerSha256: process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256?.trim() ?? '',
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
  }

  const nodeExePath = ensureNodeExeFn(opts);
  const tmuxDir = opts.platform === 'darwin' ? await ensureTmuxFn(opts) : '';
  const speechBinPath = opts.platform === 'darwin'
    ? buildSpeechFn({ arch: opts.arch })
    : undefined;
  const mlxSpeech = opts.platform === 'darwin'
    ? buildSpeechMlxFn({ arch: opts.arch })
    : null;

  const staged = stageResourcesFn({
    platform: opts.platform,
    nodeExePath,
    tmuxDir,
    speechBinPath,
    mlxSpeechBinPath: mlxSpeech?.binPath,
    mlxMetallibPath: mlxSpeech?.metallibPath ?? undefined,
    stageDir: opts.stageDir,
  });

  const childEnv = buildPcAppNodeExeEnv(process.env);
  if (opts.requireSign) childEnv.IMCODES_PC_APP_REQUIRE_SIGNING = '1';
  if (opts.requireNotarize) childEnv.IMCODES_PC_APP_REQUIRE_NOTARIZE = '1';

  // Propagate strict signing/notary enforcement to hooks running in-process.
  if (opts.requireSign) process.env.IMCODES_PC_APP_REQUIRE_SIGNING = '1';
  if (opts.requireNotarize) process.env.IMCODES_PC_APP_REQUIRE_NOTARIZE = '1';
  delete process.env.IMCODES_REQUIRE_COMPUTER_USE_HELPER;

  const config = createPcAppElectronBuilderConfig({
    macArch: opts.platform === 'darwin' ? opts.arch : 'arm64',
    winArch: opts.platform === 'win32' ? opts.arch : 'x64',
    outDir: opts.outDir,
    macStageDir: opts.platform === 'darwin' ? staged.stageDir : join(DEFAULT_STAGE_ROOT, 'darwin'),
    winStageDir: opts.platform === 'win32' ? staged.stageDir : join(DEFAULT_STAGE_ROOT, 'win32'),
    version: opts.version || undefined,
    env: childEnv,
  });

  const electronBuilderBuildFn = deps.electronBuilderBuildFn ?? (async (buildOpts) => {
    const require = createRequire(join(PC_APP_DIR, 'package.json'));
    const electronBuilder = require('electron-builder');
    const targets = opts.platform === 'darwin'
      ? electronBuilder.Platform.MAC.createTarget(['dmg'], electronBuilder.archFromString(opts.arch))
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
    const verification = verifyMacAppFn(appPath, { requireNotarized: opts.requireNotarize });
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
