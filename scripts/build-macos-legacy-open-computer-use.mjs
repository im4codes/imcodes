#!/usr/bin/env node
/**
 * Build the dedicated macOS 12–13 legacy-compat OpenComputerUse helper
 * (`OpenComputerUseLegacy`) from the pinned MIT upstream commit.
 *
 * macOS 14+ continues to use the untouched official upstream OpenComputerUse
 * binary inside `aiDesk.to by IM.codes.app/Contents/Helpers/OpenComputerUse`.
 * Older Macs (Darwin < 23, e.g. macOS 12 Monterey / macOS 13 Ventura) route to
 * `Contents/Helpers/OpenComputerUseLegacy`, compiled with `minos <= 12.0`,
 * weak-linked `ScreenCaptureKit`, and without macOS 14+ AppKit symbols.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');

export const LEGACY_OCU_LOCK_PATH = join(ROOT, 'native', 'macos-open-computer-use', 'upstream.lock.json');
export const LEGACY_OCU_PATCH_PATH = join(ROOT, 'native', 'macos-open-computer-use', 'macos12-compat.patch');
export const LEGACY_OCU_ARCHITECTURES = Object.freeze(['arm64', 'x86_64']);
export const FORBIDDEN_LEGACY_MACOS_SYMBOLS = Object.freeze([
  '_$sSo6CGRectV6AppKitE4fill5usingySo22NSCompositingOperationV_tF',
]);

function defaultRunTool(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  });
}

export function loadUpstreamLock(lockPath = LEGACY_OCU_LOCK_PATH) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (!lock || typeof lock !== 'object') throw new Error('invalid upstream.lock.json');
  if (typeof lock.repository !== 'string' || !lock.repository.startsWith('https://')) {
    throw new Error('upstream.lock.json requires an https repository URL');
  }
  if (typeof lock.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(lock.commit)) {
    throw new Error('upstream.lock.json requires a 40-char lowercase commit SHA');
  }
  if (lock.license !== 'MIT') {
    throw new Error(`upstream.lock.json requires MIT license, got ${String(lock.license)}`);
  }
  if (typeof lock.minMacosVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/u.test(lock.minMacosVersion)) {
    throw new Error('upstream.lock.json requires a numeric minMacosVersion');
  }
  return lock;
}

export function compareMacosVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10));
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = Number.isFinite(pa[i]) ? pa[i] : 0;
    const db = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

export function parseMachoMinOsVersions(otoolOutput) {
  const versions = [];
  const lines = String(otoolOutput).split('\n');
  let currentCmd = '';
  for (const line of lines) {
    const cmdMatch = /^\s*cmd\s+(\S+)/u.exec(line);
    if (cmdMatch) {
      currentCmd = cmdMatch[1];
      continue;
    }
    if (currentCmd === 'LC_BUILD_VERSION') {
      const minosMatch = /^\s*minos\s+(\d+(?:\.\d+)+)\s*$/u.exec(line);
      if (minosMatch) versions.push(minosMatch[1]);
    } else if (currentCmd === 'LC_VERSION_MIN_MACOSX') {
      const verMatch = /^\s*version\s+(\d+(?:\.\d+)+)\s*$/u.exec(line);
      if (verMatch) versions.push(verMatch[1]);
    }
  }
  return versions;
}

export function assertWeakLinkedFramework(otoolDepsOutput, frameworkName) {
  const lines = String(otoolDepsOutput)
    .split('\n')
    .filter((line) => line.includes(`${frameworkName}.framework`));
  for (const line of lines) {
    if (!/\bweak\b/iu.test(line)) {
      throw new Error(`${frameworkName}.framework must be weak-linked (got: ${line.trim()})`);
    }
  }
}

export function assertUniversalBinaryCompat({
  binaryPath,
  maxMinos = '12.0',
  runTool = defaultRunTool,
}) {
  if (!existsSync(binaryPath)) {
    throw new Error(`legacy binary not found: ${binaryPath}`);
  }
  runTool('/usr/bin/lipo', [binaryPath, '-verify_arch', ...LEGACY_OCU_ARCHITECTURES]);

  for (const arch of LEGACY_OCU_ARCHITECTURES) {
    const loadCmds = runTool('/usr/bin/otool', ['-arch', arch, '-l', binaryPath]);
    const minosVersions = parseMachoMinOsVersions(loadCmds);
    if (minosVersions.length === 0) {
      throw new Error(`${binaryPath} (${arch}) has no LC_BUILD_VERSION minos`);
    }
    for (const minos of minosVersions) {
      if (compareMacosVersions(minos, maxMinos) > 0) {
        throw new Error(`${binaryPath} (${arch}) announces minos ${minos}, expected <= ${maxMinos}`);
      }
    }

    const undefSymbols = runTool('/usr/bin/nm', ['-arch', arch, '-u', binaryPath]);
    for (const forbidden of FORBIDDEN_LEGACY_MACOS_SYMBOLS) {
      if (undefSymbols.includes(forbidden)) {
        throw new Error(`${binaryPath} (${arch}) references forbidden macOS 14+ symbol ${forbidden}`);
      }
    }

    const deps = runTool('/usr/bin/otool', ['-arch', arch, '-L', binaryPath]);
    assertWeakLinkedFramework(deps, 'ScreenCaptureKit');
  }
}

export function buildLegacyOpenComputerUseBinary({
  outPath,
  sourceDir,
  lockPath = LEGACY_OCU_LOCK_PATH,
  patchPath = LEGACY_OCU_PATCH_PATH,
  runTool = defaultRunTool,
}) {
  if (process.platform !== 'darwin') {
    throw new Error('build-macos-legacy-open-computer-use requires macOS with Swift toolchain');
  }
  const lock = loadUpstreamLock(lockPath);
  if (!existsSync(patchPath)) {
    throw new Error(`macos12 compat patch not found: ${patchPath}`);
  }

  const workDir = mkdtempSync(join(tmpdir(), 'imcodes-ocu-legacy-'));
  try {
    const checkoutDir = join(workDir, 'src');
    if (sourceDir) {
      const resolvedSource = resolve(sourceDir);
      if (!existsSync(resolvedSource)) {
        throw new Error(`source-dir not found: ${resolvedSource}`);
      }
      // Clone from the local mirror/cache so `--source-dir` stays unmodified and clean.
      runTool('/usr/bin/git', ['clone', '--no-hardlinks', resolvedSource, checkoutDir], { stdio: 'inherit' });
      runTool('/usr/bin/git', ['-C', checkoutDir, 'checkout', '--force', lock.commit], { stdio: 'inherit' });
    } else {
      runTool('/usr/bin/git', ['clone', '--filter=blob:none', lock.repository, checkoutDir], { stdio: 'inherit' });
      runTool('/usr/bin/git', ['-C', checkoutDir, 'checkout', lock.commit], { stdio: 'inherit' });
    }

    const actualHead = runTool('/usr/bin/git', ['-C', checkoutDir, 'rev-parse', 'HEAD']).trim();
    if (actualHead !== lock.commit) {
      throw new Error(`upstream commit mismatch: expected ${lock.commit}, got ${actualHead}`);
    }
    const licensePath = join(checkoutDir, 'LICENSE');
    if (!existsSync(licensePath)) {
      throw new Error(`upstream MIT LICENSE missing at ${licensePath}`);
    }

    runTool('/usr/bin/git', ['-C', checkoutDir, 'apply', '--check', patchPath], { stdio: 'inherit' });
    runTool('/usr/bin/git', ['-C', checkoutDir, 'apply', patchPath], { stdio: 'inherit' });

    const sliceBins = [];
    for (const arch of LEGACY_OCU_ARCHITECTURES) {
      const triple = `${arch}-apple-macosx${lock.minMacosVersion}`;
      const scratchDir = join(workDir, `build-${arch}`);
      runTool('swift', [
        'build',
        '-c', 'release',
        '--product', 'OpenComputerUse',
        '--triple', triple,
        '--scratch-path', scratchDir,
      ], { cwd: checkoutDir, stdio: 'inherit' });
      const binPath = join(scratchDir, 'release', 'OpenComputerUse');
      if (!existsSync(binPath)) {
        throw new Error(`built OpenComputerUse slice missing at ${binPath}`);
      }
      sliceBins.push(binPath);
    }

    const resolvedOut = resolve(outPath);
    mkdirSync(dirname(resolvedOut), { recursive: true });
    rmSync(resolvedOut, { force: true });
    runTool('/usr/bin/lipo', ['-create', ...sliceBins, '-output', resolvedOut], { stdio: 'inherit' });
    chmodSync(resolvedOut, 0o755);

    assertUniversalBinaryCompat({ binaryPath: resolvedOut, maxMinos: lock.minMacosVersion, runTool });
    return resolvedOut;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function parseCliArgs(argv) {
  let outPath = join(ROOT, 'dist-node-exe', 'computer-use-helper', 'darwin-universal', 'OpenComputerUseLegacy');
  let sourceDir = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      outPath = argv[++i];
    } else if (arg === '--source-dir' && argv[i + 1]) {
      sourceDir = argv[++i];
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/build-macos-legacy-open-computer-use.mjs [--out <path>] [--source-dir <path>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { outPath, sourceDir: sourceDir || undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outPath, sourceDir } = parseCliArgs(process.argv.slice(2));
  const built = buildLegacyOpenComputerUseBinary({ outPath, sourceDir });
  process.stdout.write(`${built}\n`);
}
