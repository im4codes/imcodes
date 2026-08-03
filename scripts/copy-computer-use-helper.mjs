#!/usr/bin/env node
/**
 * Copy the platform Computer Use helper into build outputs.
 *
 * Source precedence:
 *   1. IMCODES_COMPUTER_USE_HELPER_SOURCE (file or directory)
 *   2. vendor/computer-use/<platform>-<arch>/
 *
 * The source is intentionally external/vendorable: release CI can inject a
 * signed Open Computer Use helper without making application code depend on a
 * mutable PATH install. Missing helper is a warning for local dev unless
 * IMCODES_REQUIRE_COMPUTER_USE_HELPER=1.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const require = createRequire(import.meta.url);
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const targetArch = process.env.IMCODES_COMPUTER_USE_HELPER_TARGET_ARCH?.trim() || arch;
if (targetArch !== 'x64' && targetArch !== 'arm64' && !(process.platform === 'darwin' && targetArch === 'universal')) {
  throw new Error(`copy-computer-use-helper: unsupported target architecture ${targetArch}`);
}
const platformKey = `${process.platform}-${targetArch}`;
const isWin = process.platform === 'win32';
const helperBinaryName = isWin ? 'open-computer-use.exe' : 'open-computer-use';
const macosAppName = 'Open Computer Use.app';
const macosArchiveName = 'open-computer-use.app.zip';
const macosBundleId = 'com.ifuryst.opencomputeruse';
const macosTeamId = 'J9P29FA5BX';
const args = new Set(process.argv.slice(2));
const copyDist = args.size === 0 || args.has('--dist');
const copyNodeExe = args.size === 0 || args.has('--node-exe');
const requireHelper = process.env.IMCODES_REQUIRE_COMPUTER_USE_HELPER === '1'
  || process.env.IMCODES_REQUIRE_COMPUTER_USE_HELPER === 'true';

function sourceCandidates() {
  const npmPackageRoot = (() => {
    try {
      return dirname(require.resolve('open-computer-use/package.json'));
    } catch {
      return null;
    }
  })();
  const npmPackagedBinary = npmPackageRoot
    ? process.platform === 'darwin'
      ? join(npmPackageRoot, 'dist', macosAppName)
      : join(npmPackageRoot, 'dist', process.platform === 'win32' ? 'windows' : 'linux', arch === 'x64' ? 'amd64' : 'arm64', helperBinaryName)
    : null;
  return [
    process.env.IMCODES_COMPUTER_USE_HELPER_SOURCE?.trim(),
    join(root, 'vendor', 'computer-use', platformKey),
    npmPackagedBinary,
  ].filter(Boolean);
}

function findSource() {
  for (const candidate of sourceCandidates()) {
    const full = resolve(candidate);
    if (!existsSync(full)) continue;
    if (process.platform !== 'darwin') return full;
    const app = basename(full) === macosAppName ? full : join(full, macosAppName);
    if (existsSync(app) && lstatSync(app).isDirectory() && !lstatSync(app).isSymbolicLink()) return app;
  }
  return null;
}

function verifyMacosAppBundle(appPath) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    if (targetArch === 'universal') {
      execFileSync('/usr/bin/lipo', [
        join(appPath, 'Contents', 'MacOS', 'OpenComputerUse'),
        '-verify_arch',
        'x86_64',
        'arm64',
      ], { stdio: 'pipe' });
    }
    const inspected = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (inspected.error || inspected.status !== 0) {
      throw inspected.error ?? new Error(String(inspected.stderr || 'codesign inspection failed').trim());
    }
    const details = `${inspected.stdout ?? ''}\n${inspected.stderr ?? ''}`;
    if (!details.includes(`Identifier=${macosBundleId}`)
      || !details.includes(`TeamIdentifier=${macosTeamId}`)
      || !details.includes('Authority=Developer ID Application:')) {
      throw new Error('unexpected Developer ID identity');
    }
  } catch (error) {
    throw new Error(`copy-computer-use-helper: invalid signed macOS app ${appPath}: ${error.message}`);
  }
}

function archiveMacosAppBundle(source, archivePath) {
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', source, archivePath], { stdio: 'pipe' });
  const verificationRoot = mkdtempSync(join(tmpdir(), 'imcodes-ocu-archive-verify-'));
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archivePath, verificationRoot], { stdio: 'pipe' });
    verifyMacosAppBundle(join(verificationRoot, macosAppName));
  } finally {
    rmSync(verificationRoot, { recursive: true, force: true });
  }
}

function copySourceToDest(source, dest, includeMacosAppBundle) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (process.platform === 'darwin') {
    verifyMacosAppBundle(source);
    if (includeMacosAppBundle) {
      const copiedApp = join(dest, macosAppName);
      cpSync(source, copiedApp, { recursive: true });
      verifyMacosAppBundle(copiedApp);
    }
    archiveMacosAppBundle(source, join(dest, macosArchiveName));
    return;
  }
  const stat = statSync(source);
  if (stat.isDirectory()) {
    const rootBinary = join(source, helperBinaryName);
    if (existsSync(rootBinary) && statSync(rootBinary).isFile()) {
      cpSync(rootBinary, join(dest, helperBinaryName));
      return;
    }
    cpSync(source, dest, { recursive: true });
    return;
  }
  cpSync(source, join(dest, helperBinaryName));
}

const source = findSource();
if (!source) {
  const message = `copy-computer-use-helper: no helper source for ${platformKey}; set IMCODES_COMPUTER_USE_HELPER_SOURCE or vendor/computer-use/${platformKey}`;
  if (requireHelper) throw new Error(message);
  console.warn(`${message} (skipping)`);
  process.exit(0);
}

const destinations = [];
if (copyDist) destinations.push({
  path: join(root, 'dist', 'computer-use-helper', platformKey),
  includeMacosAppBundle: true,
});
if (copyNodeExe) destinations.push({
  path: join(root, 'dist-node-exe', 'computer-use-helper', platformKey),
  includeMacosAppBundle: false,
});

for (const destination of destinations) {
  copySourceToDest(source, destination.path, destination.includeMacosAppBundle);
}
console.log(`copy-computer-use-helper: copied ${source} -> ${destinations.map(({ path }) => path).join(', ')}`);
