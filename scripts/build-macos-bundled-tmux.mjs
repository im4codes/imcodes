#!/usr/bin/env node
/**
 * Build, stage, and verify the self-built static-linked universal (arm64 + x86_64)
 * macOS `tmux` binary, minimal bundled `terminfo` database, and open-source
 * license files per `docs/pc.v1.app.md` §4.5 (Phase C).
 *
 * Usage:
 *   node scripts/build-macos-bundled-tmux.mjs [--out-dir <dir>] [--src-cache <dir>] [--keep-work]
 *   node scripts/build-macos-bundled-tmux.mjs --verify-only --out-dir <dir>
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

export const BUNDLED_TMUX_MINIMUM_MACOS_VERSION = '12.0';
export const BUNDLED_TMUX_REQUIRED_ARCHS = Object.freeze(['arm64', 'x86_64']);
export const BUNDLED_TMUX_REQUIRED_TERMS = Object.freeze([
  'screen',
  'tmux-256color',
  'xterm-256color',
]);
export const BUNDLED_TMUX_STAGED_TERMS = Object.freeze([
  'screen',
  'screen-256color',
  'tmux',
  'tmux-256color',
  'xterm',
  'xterm-256color',
]);
export const BUNDLED_TMUX_ALLOWED_DYLIB_PREFIXES = Object.freeze([
  '/usr/lib/',
  '/System/Library/',
]);

export const BUNDLED_TMUX_SOURCES = Object.freeze({
  libevent: Object.freeze({
    name: 'libevent',
    version: '2.1.12-stable',
    filename: 'libevent-2.1.12-stable.tar.gz',
    extractedDir: 'libevent-2.1.12-stable',
    urls: Object.freeze([
      'https://github.com/libevent/libevent/releases/download/release-2.1.12-stable/libevent-2.1.12-stable.tar.gz',
    ]),
    sha256: '92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb',
    licenseEntry: 'LICENSE',
    licenseOutFilename: 'libevent-BSD-3-Clause.txt',
  }),
  ncurses: Object.freeze({
    name: 'ncurses',
    version: '6.5',
    filename: 'ncurses-6.5.tar.gz',
    extractedDir: 'ncurses-6.5',
    urls: Object.freeze([
      'https://ftp.gnu.org/gnu/ncurses/ncurses-6.5.tar.gz',
      'https://ftpmirror.gnu.org/ncurses/ncurses-6.5.tar.gz',
    ]),
    sha256: '136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6',
    licenseEntry: 'COPYING',
    licenseOutFilename: 'ncurses-MIT.txt',
  }),
  tmux: Object.freeze({
    name: 'tmux',
    version: '3.5a',
    filename: 'tmux-3.5a.tar.gz',
    extractedDir: 'tmux-3.5a',
    urls: Object.freeze([
      'https://github.com/tmux/tmux/releases/download/3.5a/tmux-3.5a.tar.gz',
    ]),
    sha256: '16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951',
    licenseEntry: 'COPYING',
    licenseOutFilename: 'tmux-ISC.txt',
  }),
});

export function parseBuildBundledTmuxArgs(argv = process.argv.slice(2)) {
  const opts = {
    outDir: join(REPO_ROOT, 'dist-node-exe', 'bundled-tmux-macos'),
    srcCacheDir: process.env.IMCODES_TMUX_SRC_CACHE?.trim() || join(tmpdir(), 'imcodes-tmux-src-cache'),
    minimumSystemVersion: BUNDLED_TMUX_MINIMUM_MACOS_VERSION,
    verifyOnly: false,
    keepWork: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir' && argv[i + 1]) {
      opts.outDir = resolve(argv[++i]);
    } else if (arg === '--src-cache' && argv[i + 1]) {
      opts.srcCacheDir = resolve(argv[++i]);
    } else if (arg === '--min-macos' && argv[i + 1]) {
      opts.minimumSystemVersion = String(argv[++i]).trim();
    } else if (arg === '--verify-only') {
      opts.verifyOnly = true;
    } else if (arg === '--keep-work') {
      opts.keepWork = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return opts;
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function verifyTarballSha256(filePath, expectedSha256, label = filePath) {
  const actual = sha256Buffer(readFileSync(filePath));
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${label}: expected ${expectedSha256}, got ${actual}`,
    );
  }
  return actual;
}

/**
 * Gate ①: `lipo -archs` must report both `arm64` and `x86_64`.
 */
export function validateLipoArchsOutput(output, requiredArchs = BUNDLED_TMUX_REQUIRED_ARCHS) {
  const archs = String(output ?? '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const missing = requiredArchs.filter((arch) => !archs.includes(arch));
  if (missing.length > 0) {
    throw new Error(
      `Gate 1 (arch) failed: expected architectures [${requiredArchs.join(', ')}], missing [${missing.join(', ')}]; got [${archs.join(', ')}]`,
    );
  }
  return archs;
}

/**
 * Parse `otool -L` (or `otool -arch <arch> -L`) dependency paths for a single arch.
 */
export function parseOtoolDependencyPaths(otoolOutput) {
  const lines = String(otoolOutput ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error('Gate 2 (dylib allowlist) failed: empty otool -L output');
  }
  const deps = [];
  for (const line of lines) {
    if (!line.startsWith('\t') && !line.startsWith('  ') && line.endsWith(':')) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parenIdx = trimmed.indexOf(' (compatibility version');
    const depPath = (parenIdx >= 0 ? trimmed.slice(0, parenIdx) : trimmed).trim();
    if (depPath) deps.push(depPath);
  }
  return deps;
}

/**
 * Gate ②: Strict allowlist for Mach-O dynamic library dependencies.
 * Every dylib must live under `/usr/lib/` or `/System/Library/`; rejects `@rpath`,
 * `@loader_path`, `@executable_path`, `/opt/homebrew`, `/usr/local`, `/nix`, etc.
 */
export function validateOtoolDependencies(
  otoolOutput,
  archLabel = 'universal',
  allowedPrefixes = BUNDLED_TMUX_ALLOWED_DYLIB_PREFIXES,
) {
  const deps = parseOtoolDependencyPaths(otoolOutput);
  if (deps.length === 0) {
    throw new Error(
      `Gate 2 (dylib allowlist, arch=${archLabel}) failed: no dylib entries parsed from otool output`,
    );
  }
  const violations = deps.filter((dep) => {
    if (dep.includes('..')) return true;
    return !allowedPrefixes.some((prefix) => dep.startsWith(prefix));
  });
  if (violations.length > 0) {
    throw new Error(
      `Gate 2 (dylib allowlist, arch=${archLabel}) failed: disallowed dynamic dependencies [${violations.join(', ')}]`,
    );
  }
  return deps;
}

/**
 * Resolve compiled terminfo entry path in either hex-subdir (`73/screen`) or char-subdir (`s/screen`).
 */
export function findCompiledTerminfoEntry(terminfoRoot, termName) {
  const firstCodeHex = termName.charCodeAt(0).toString(16).padStart(2, '0');
  const hexCandidate = join(terminfoRoot, firstCodeHex, termName);
  if (existsSync(hexCandidate)) return hexCandidate;
  const charCandidate = join(terminfoRoot, termName[0], termName);
  if (existsSync(charCandidate)) return charCandidate;
  return null;
}

export function validateBundledTmuxLayout(
  outDir,
  {
    requiredTerms = BUNDLED_TMUX_REQUIRED_TERMS,
    sources = BUNDLED_TMUX_SOURCES,
  } = {},
) {
  const absOut = resolve(outDir);
  const tmuxBin = join(absOut, 'bin', 'tmux');
  if (!existsSync(tmuxBin)) {
    throw new Error(`Bundled tmux binary missing at ${tmuxBin}`);
  }
  accessSync(tmuxBin, fsConstants.X_OK);

  const terminfoDir = join(absOut, 'terminfo');
  if (!existsSync(terminfoDir)) {
    throw new Error(`Bundled terminfo directory missing at ${terminfoDir}`);
  }
  const resolvedTerminfoEntries = {};
  for (const term of requiredTerms) {
    const entryPath = findCompiledTerminfoEntry(terminfoDir, term);
    if (!entryPath || statSync(entryPath).size === 0) {
      throw new Error(`Bundled terminfo missing compiled entry for "${term}" under ${terminfoDir}`);
    }
    resolvedTerminfoEntries[term] = entryPath;
  }

  const licensesDir = join(absOut, 'licenses');
  if (!existsSync(licensesDir)) {
    throw new Error(`Bundled licenses directory missing at ${licensesDir}`);
  }
  const resolvedLicenses = {};
  for (const pkg of Object.values(sources)) {
    const licensePath = join(licensesDir, pkg.licenseOutFilename);
    if (!existsSync(licensePath) || statSync(licensePath).size === 0) {
      throw new Error(`Bundled license file missing or empty at ${licensePath}`);
    }
    resolvedLicenses[pkg.name] = licensePath;
  }

  return {
    outDir: absOut,
    tmuxBin,
    terminfoDir,
    licensesDir,
    resolvedTerminfoEntries,
    resolvedLicenses,
  };
}

function removeDirWithRetry(dirPath, maxAttempts = 10, delayMs = 25) {
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
      if (attempt === maxAttempts || (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM')) {
        throw err;
      }
      Atomics.wait(sleepBuf, 0, 0, delayMs);
    }
  }
}

/**
 * Gate ④: Verify real `tmux -f /dev/null new-session -d` for every target `TERM`
 * against BOTH isolated `<out>/terminfo` (proves zero missing `use=` dependencies)
 * and runtime `<out>/terminfo:/usr/share/terminfo` (plus compiled-in `/usr/share/terminfo`).
 */
export function runTerminfoSessionGate(
  outDir,
  {
    terms = BUNDLED_TMUX_REQUIRED_TERMS,
    execFn = execFileSync,
    terminfoSearchModes,
  } = {},
) {
  const absOut = resolve(outDir);
  const tmuxBin = join(absOut, 'bin', 'tmux');
  const bundledTerminfo = join(absOut, 'terminfo');
  const modes = terminfoSearchModes ?? [
    { name: 'isolated', terminfoDirs: bundledTerminfo },
    { name: 'runtime-fallback', terminfoDirs: `${bundledTerminfo}:/usr/share/terminfo` },
    { name: 'compiled-default', terminfoDirs: null },
  ];

  const results = [];
  for (const mode of modes) {
    for (const term of terms) {
      const tempRoot = mkdtempSync(join(tmpdir(), 'imcodes-tmux-gate4-'));
      const socketPath = join(tempRoot, 'gate4.sock');
      const baseEnv = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: tempRoot,
        TMUX_TMPDIR: tempRoot,
        TERM: term,
        ...(mode.terminfoDirs ? { TERMINFO_DIRS: mode.terminfoDirs } : {}),
      };
      try {
        execFn(tmuxBin, ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d'], {
          env: baseEnv,
          stdio: 'pipe',
        });
        execFn(tmuxBin, ['-S', socketPath, 'has-session'], {
          env: baseEnv,
          stdio: 'pipe',
        });
        results.push({ mode: mode.name, term, terminfoDirs: mode.terminfoDirs, passed: true });
      } catch (err) {
        const stderr = err && typeof err === 'object' && 'stderr' in err && err.stderr
          ? String(err.stderr).trim()
          : '';
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Gate 4 (terminfo) failed for TERM=${term} (${mode.name}, TERMINFO_DIRS=${mode.terminfoDirs ?? '<compiled-default>'}): ${stderr || msg}`,
        );
      } finally {
        try {
          execFn(tmuxBin, ['-S', socketPath, 'kill-server'], {
            env: baseEnv,
            stdio: 'pipe',
          });
        } catch {
          // Session/server already exited or never started.
        }
        removeDirWithRetry(tempRoot);
      }
    }
  }
  return results;
}

/**
 * Run Gates ①, ②, layout/licenses/terminfo checks, and Gate ④ on `<outDir>`.
 */
export function verifyBundledTmux(
  outDir,
  {
    execFn = execFileSync,
    requiredArchs = BUNDLED_TMUX_REQUIRED_ARCHS,
    requiredTerms = BUNDLED_TMUX_REQUIRED_TERMS,
  } = {},
) {
  const layout = validateBundledTmuxLayout(outDir, { requiredTerms });

  // Gate ①: universal architecture verification
  const lipoOut = String(execFn('/usr/bin/lipo', ['-archs', layout.tmuxBin], { encoding: 'utf8' }));
  const archs = validateLipoArchsOutput(lipoOut, requiredArchs);

  // Gate ②: per-architecture strict dylib allowlist verification
  const dylibsByArch = {};
  for (const arch of requiredArchs) {
    const otoolOut = String(
      execFn('/usr/bin/otool', ['-arch', arch, '-L', layout.tmuxBin], { encoding: 'utf8' }),
    );
    dylibsByArch[arch] = validateOtoolDependencies(otoolOut, arch);
  }

  // Gate ④: live `tmux -f /dev/null new-session -d` across every required TERM
  const terminfoGate = runTerminfoSessionGate(layout.outDir, {
    terms: requiredTerms,
    execFn,
  });

  return {
    outDir: layout.outDir,
    tmuxBin: layout.tmuxBin,
    archs,
    dylibsByArch,
    terminfoGate,
    licenses: layout.resolvedLicenses,
    terminfoEntries: layout.resolvedTerminfoEntries,
  };
}

async function downloadWithPinnedSha256(source, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, source.filename);
  if (existsSync(archivePath)) {
    try {
      verifyTarballSha256(archivePath, source.sha256, archivePath);
      return archivePath;
    } catch {
      rmSync(archivePath, { force: true });
    }
  }

  let lastError;
  for (const url of source.urls) {
    const tmpPath = `${archivePath}.${process.pid}.tmp`;
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} downloading ${url}`);
      }
      const buf = Buffer.from(await response.arrayBuffer());
      const actual = sha256Buffer(buf);
      if (actual !== source.sha256) {
        throw new Error(
          `SHA-256 mismatch from ${url}: expected ${source.sha256}, got ${actual}`,
        );
      }
      writeFileSync(tmpPath, buf);
      renameSync(tmpPath, archivePath);
      return archivePath;
    } catch (err) {
      rmSync(tmpPath, { force: true });
      lastError = err;
    }
  }
  throw lastError ?? new Error(`Failed to download ${source.filename}`);
}

function runTool(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function resolveMacosSdkPath() {
  const sdkPath = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
    encoding: 'utf8',
  }).trim();
  if (!sdkPath || !existsSync(sdkPath)) {
    throw new Error(`Failed to resolve macOS SDK via xcrun: "${sdkPath}"`);
  }
  return sdkPath;
}

function makeCleanBuildEnv(extra = {}) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: extra.HOME ?? tmpdir(),
    PKG_CONFIG: '/usr/bin/false',
    PKG_CONFIG_PATH: '',
    PKG_CONFIG_LIBDIR: '',
    LC_ALL: 'C',
    LANG: 'C',
    ...extra,
  };
}

function buildStaticArchSlice({
  arch,
  hostArch,
  sdkPath,
  minimumSystemVersion,
  srcArchives,
  workDir,
  jobs,
}) {
  const sliceRoot = join(workDir, `build-${arch}`);
  const srcRoot = join(sliceRoot, 'src');
  const prefix = join(sliceRoot, 'prefix');
  mkdirSync(srcRoot, { recursive: true });
  mkdirSync(prefix, { recursive: true });

  const hostTriplet = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const archFlags = `-arch ${arch} -isysroot ${sdkPath} -mmacosx-version-min=${minimumSystemVersion}`;
  const cc = '/usr/bin/clang';
  const baseEnv = makeCleanBuildEnv({
    HOME: sliceRoot,
    MACOSX_DEPLOYMENT_TARGET: minimumSystemVersion,
    SDKROOT: sdkPath,
  });

  // Extract tarballs cleanly per-arch so configure caches/build artifacts stay isolated.
  for (const key of ['libevent', 'ncurses', 'tmux']) {
    runTool('/usr/bin/tar', ['-xzf', srcArchives[key], '-C', srcRoot], { env: baseEnv });
  }

  const libeventSrc = join(srcRoot, BUNDLED_TMUX_SOURCES.libevent.extractedDir);
  const ncursesSrc = join(srcRoot, BUNDLED_TMUX_SOURCES.ncurses.extractedDir);
  const tmuxSrc = join(srcRoot, BUNDLED_TMUX_SOURCES.tmux.extractedDir);

  // 1. libevent (static only, no openssl/samples/regress)
  runTool(
    './configure',
    [
      `--prefix=${prefix}`,
      `--host=${hostTriplet}`,
      '--disable-shared',
      '--enable-static',
      '--disable-openssl',
      '--disable-libevent-regress',
      '--disable-samples',
      '--disable-dependency-tracking',
    ],
    {
      cwd: libeventSrc,
      env: {
        ...baseEnv,
        CC: cc,
        CFLAGS: `-O2 ${archFlags}`,
        CPPFLAGS: archFlags,
        LDFLAGS: archFlags,
      },
    },
  );
  runTool('/usr/bin/make', [`-j${jobs}`], { cwd: libeventSrc, env: baseEnv });
  runTool('/usr/bin/make', ['install'], { cwd: libeventSrc, env: baseEnv });

  // 2. ncurses (static widec, hex terminfo dirs matching /usr/share/terminfo)
  const ncursesConfigureArgs = [
    `--prefix=${prefix}`,
    `--host=${hostTriplet}`,
    '--without-shared',
    '--with-normal',
    '--without-debug',
    '--without-ada',
    '--without-manpages',
    '--without-tests',
    '--without-cxx',
    '--without-cxx-binding',
    '--enable-widec',
    '--disable-mixed-case',
    '--with-default-terminfo-dir=/usr/share/terminfo',
    '--with-terminfo-dirs=/usr/share/terminfo',
    '--disable-dependency-tracking',
    `--with-build-cc=${cc}`,
    `--with-build-cflags=-O2 -isysroot ${sdkPath}`,
    `--with-build-cppflags=-isysroot ${sdkPath}`,
    `--with-build-ldflags=-isysroot ${sdkPath}`,
  ];
  if (arch !== hostArch) {
    ncursesConfigureArgs.push('--without-progs');
  }
  runTool('./configure', ncursesConfigureArgs, {
    cwd: ncursesSrc,
    env: {
      ...baseEnv,
      CC: cc,
      CFLAGS: `-O2 ${archFlags}`,
      CPPFLAGS: archFlags,
      LDFLAGS: archFlags,
    },
  });
  runTool('/usr/bin/make', [`-j${jobs}`, 'libs'], { cwd: ncursesSrc, env: baseEnv });
  runTool('/usr/bin/make', ['install.libs', 'install.includes'], { cwd: ncursesSrc, env: baseEnv });

  let ticBin = null;
  if (arch === hostArch) {
    runTool('/usr/bin/make', [`-j${jobs}`, '-C', 'progs', 'tic'], {
      cwd: ncursesSrc,
      env: baseEnv,
    });
    ticBin = join(ncursesSrc, 'progs', 'tic');
  }

  // 3. tmux (statically linked against staged libevent + ncursesw .a archives)
  const libeventCoreStatic = join(prefix, 'lib', 'libevent_core.a');
  const libeventStatic = join(prefix, 'lib', 'libevent.a');
  const libncurseswStatic = join(prefix, 'lib', 'libncursesw.a');
  runTool(
    './configure',
    [
      `--prefix=${prefix}`,
      `--host=${hostTriplet}`,
      '--with-TERM=tmux-256color',
      '--disable-utf8proc',
      '--disable-dependency-tracking',
    ],
    {
      cwd: tmuxSrc,
      env: {
        ...baseEnv,
        CC: cc,
        CFLAGS: `-O2 ${archFlags} -I${join(prefix, 'include')} -I${join(prefix, 'include', 'ncursesw')}`,
        CPPFLAGS: `${archFlags} -I${join(prefix, 'include')} -I${join(prefix, 'include', 'ncursesw')}`,
        LDFLAGS: archFlags,
        LIBEVENT_CORE_CFLAGS: `-I${join(prefix, 'include')}`,
        LIBEVENT_CORE_LIBS: libeventCoreStatic,
        LIBEVENT_CFLAGS: `-I${join(prefix, 'include')}`,
        LIBEVENT_LIBS: libeventStatic,
        LIBNCURSESW_CFLAGS: `-I${join(prefix, 'include', 'ncursesw')} -I${join(prefix, 'include')}`,
        LIBNCURSESW_LIBS: libncurseswStatic,
        LIBNCURSES_CFLAGS: `-I${join(prefix, 'include', 'ncursesw')} -I${join(prefix, 'include')}`,
        LIBNCURSES_LIBS: libncurseswStatic,
      },
    },
  );
  runTool('/usr/bin/make', [`-j${jobs}`], { cwd: tmuxSrc, env: baseEnv });

  return {
    tmuxBin: join(tmuxSrc, 'tmux'),
    ticBin,
    terminfoSrc: join(ncursesSrc, 'misc', 'terminfo.src'),
    licenses: {
      libevent: join(libeventSrc, BUNDLED_TMUX_SOURCES.libevent.licenseEntry),
      ncurses: join(ncursesSrc, BUNDLED_TMUX_SOURCES.ncurses.licenseEntry),
      tmux: join(tmuxSrc, BUNDLED_TMUX_SOURCES.tmux.licenseEntry),
    },
  };
}

export async function buildMacosBundledTmux(options = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('Building universal macOS bundled tmux requires macOS (Xcode CLT / lipo / otool)');
  }
  const outDir = resolve(options.outDir ?? join(REPO_ROOT, 'dist-node-exe', 'bundled-tmux-macos'));
  const srcCacheDir = resolve(
    options.srcCacheDir ?? process.env.IMCODES_TMUX_SRC_CACHE?.trim() ?? join(tmpdir(), 'imcodes-tmux-src-cache'),
  );
  const minimumSystemVersion = options.minimumSystemVersion ?? BUNDLED_TMUX_MINIMUM_MACOS_VERSION;
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const jobs = Math.max(1, cpus().length);
  const sdkPath = resolveMacosSdkPath();

  const srcArchives = {};
  for (const key of ['libevent', 'ncurses', 'tmux']) {
    srcArchives[key] = await downloadWithPinnedSha256(BUNDLED_TMUX_SOURCES[key], srcCacheDir);
  }

  const workDir = mkdtempSync(join(tmpdir(), 'imcodes-tmux-build-'));
  try {
    const slices = {};
    for (const arch of BUNDLED_TMUX_REQUIRED_ARCHS) {
      slices[arch] = buildStaticArchSlice({
        arch,
        hostArch,
        sdkPath,
        minimumSystemVersion,
        srcArchives,
        workDir,
        jobs,
      });
    }

    const binDir = join(outDir, 'bin');
    const terminfoDir = join(outDir, 'terminfo');
    const licensesDir = join(outDir, 'licenses');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(terminfoDir, { recursive: true });
    mkdirSync(licensesDir, { recursive: true });

    const universalTmux = join(binDir, 'tmux');
    runTool('/usr/bin/lipo', [
      '-create',
      slices.arm64.tmuxBin,
      slices.x86_64.tmuxBin,
      '-output',
      universalTmux,
    ]);
    execFileSync('/bin/chmod', ['755', universalTmux]);

    const hostSlice = slices[hostArch];
    if (!hostSlice?.ticBin || !existsSync(hostSlice.ticBin)) {
      throw new Error(`Host tic compiler missing from ${hostArch} ncurses build`);
    }
    runTool(
      hostSlice.ticBin,
      [
        '-x',
        '-e',
        BUNDLED_TMUX_STAGED_TERMS.join(','),
        '-o',
        terminfoDir,
        hostSlice.terminfoSrc,
      ],
      { env: makeCleanBuildEnv({ HOME: workDir }) },
    );

    for (const pkg of Object.values(BUNDLED_TMUX_SOURCES)) {
      const srcLicense = hostSlice.licenses[pkg.name];
      if (!srcLicense || !existsSync(srcLicense)) {
        throw new Error(`Missing upstream license file for ${pkg.name}: ${srcLicense}`);
      }
      copyFileSync(srcLicense, join(licensesDir, pkg.licenseOutFilename));
    }

    return verifyBundledTmux(outDir);
  } finally {
    if (!options.keepWork) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

async function main() {
  const opts = parseBuildBundledTmuxArgs();
  const report = opts.verifyOnly
    ? verifyBundledTmux(opts.outDir)
    : await buildMacosBundledTmux(opts);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
