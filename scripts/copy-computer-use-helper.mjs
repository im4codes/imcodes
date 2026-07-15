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
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const require = createRequire(import.meta.url);
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const platformKey = `${process.platform}-${arch}`;
const isWin = process.platform === 'win32';
const helperBinaryName = isWin ? 'open-computer-use.exe' : 'open-computer-use';
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
      ? join(npmPackageRoot, 'dist', 'Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse')
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
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * macOS: re-sign the copied helper ad-hoc.
 *
 * Upstream ships the darwin helper INSIDE a `Open Computer Use.app` bundle
 * signed with a Developer ID + hardened runtime. That signature covers the
 * bundle's `Info.plist` and `_CodeSignature/CodeResources`, so lifting the bare
 * Mach-O out of the bundle (which is what we want — a flat helper dir) leaves
 * those siblings behind and the signature no longer validates. With the
 * hardened-runtime flag set, the kernel then SIGKILLs the process on exec:
 * exit 137, no stdout, no stderr — the helper was simply DEAD on macOS.
 *
 * Replacing the now-invalid signature ad-hoc costs nothing: the upstream binary
 * carries NO entitlements, and the bundle is not notarized (`spctl` rejects it
 * as "Unnotarized Developer ID"), so there is no entitlement or Gatekeeper
 * benefit to preserve — only a broken signature to drop. Ad-hoc CDHash is
 * content-derived, so identical bytes keep a stable identity across rebuilds.
 */
function adhocResignDarwinBinary(binaryPath) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('codesign', ['--force', '--sign', '-', binaryPath], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`copy-computer-use-helper: ad-hoc codesign failed for ${binaryPath}: ${error.message}`);
  }
}

function copySourceToDest(source, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const stat = statSync(source);
  if (stat.isDirectory()) {
    const rootBinary = join(source, helperBinaryName);
    if (existsSync(rootBinary) && statSync(rootBinary).isFile()) {
      cpSync(rootBinary, join(dest, helperBinaryName));
      adhocResignDarwinBinary(join(dest, helperBinaryName));
      return;
    }
    cpSync(source, dest, { recursive: true });
    return;
  }
  cpSync(source, join(dest, helperBinaryName));
  adhocResignDarwinBinary(join(dest, helperBinaryName));
}

const source = findSource();
if (!source) {
  const message = `copy-computer-use-helper: no helper source for ${platformKey}; set IMCODES_COMPUTER_USE_HELPER_SOURCE or vendor/computer-use/${platformKey}`;
  if (requireHelper) throw new Error(message);
  console.warn(`${message} (skipping)`);
  process.exit(0);
}

const destinations = [];
if (copyDist) destinations.push(join(root, 'dist', 'computer-use-helper', platformKey));
if (copyNodeExe) destinations.push(join(root, 'dist-node-exe', 'computer-use-helper', platformKey));

for (const dest of destinations) copySourceToDest(source, dest);
console.log(`copy-computer-use-helper: copied ${source} -> ${destinations.join(', ')}`);
