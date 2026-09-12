// Assemble the signed aiDesk.to application bundle.
//
// Why a bundle at all: macOS grants Screen Recording and Accessibility to a
// *responsible application*, and a helper started by a root daemon is
// otherwise attributed to whatever launched it. Putting every helper inside
// one signed app whose main executable execs into them makes that responsible
// application this app -- so the person authorises once, not once per helper,
// and the grant survives daemon upgrades because the daemon is not in here.
//
// The daemon is deliberately absent. It replaces its own executable on every
// self-upgrade, and rewriting a file inside a signed bundle breaks the seal:
// the app would fail verification and the permissions granted to it could go
// with it. Upgrades of this bundle replace the whole directory instead.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Must match `MACOS_AIDESK_APP_NAME` / `MACOS_AIDESK_BUNDLE_ID` in src/node/macos-computer-use.ts. */
export const AIDESK_APP_NAME = 'aiDesk.to by IM.codes.app';
export const AIDESK_BUNDLE_ID = 'to.aidesk.app';
export const AIDESK_MAIN_EXECUTABLE = 'aidesk-agent';
export const AIDESK_COMPUTER_USE_EXECUTABLE = 'OpenComputerUse';

/**
 * Where the bundle's helpers live.
 *
 * `Contents/Helpers`, not `Contents/MacOS`, because that is the path
 * `ExecAiDeskProductHelper` builds and no other. Putting them beside the main
 * executable produces a bundle that signs, notarizes and installs perfectly
 * and then answers every dispatch with `aidesk_product_helper_exec_failed`.
 */
export const AIDESK_HELPERS_DIR = 'Helpers';

/**
 * Where the licence of the bundled third-party helper is kept.
 *
 * Open Computer Use is MIT, which permits everything done here -- copying,
 * modifying, redistributing, re-signing under our own certificate -- on one
 * condition: its copyright and permission notice travel with every copy. The
 * upstream .app carries no licence file of its own, so shipping only the
 * executable would drop the notice entirely. This puts it back, inside the
 * bundle that contains the binary rather than in a document somewhere else.
 */
export const AIDESK_THIRD_PARTY_LICENSE = 'LICENSE-open-computer-use.txt';

/** Architectures the shipped app must run on, as one Universal 2 binary. */
export const AIDESK_ARCHITECTURES = Object.freeze(['arm64', 'x86_64']);

function sh(file, args, options = {}) {
  return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });
}

/**
 * The Info.plist for the bundle.
 *
 * `LSUIElement` keeps it out of the Dock and the app switcher: this is a
 * permission-owning container that the daemon drives, not something to alt-tab
 * to. `LSMinimumSystemVersion` matches the remote-desktop components' declared
 * floor so one bundle cannot claim support the helpers inside it lack.
 */
export function buildAideskInfoPlist(input) {
  const { version, minimumSystemVersion } = input;
  if (!/^[0-9][0-9A-Za-z.\-+]*$/u.test(String(version ?? ''))) {
    throw new Error('aiDesk Info.plist requires a version string');
  }
  if (!/^\d+(\.\d+)*$/u.test(String(minimumSystemVersion ?? ''))) {
    throw new Error('aiDesk Info.plist requires a numeric minimum system version');
  }
  const entries = [
    ['CFBundleIdentifier', AIDESK_BUNDLE_ID],
    ['CFBundleName', 'aiDesk.to'],
    ['CFBundleDisplayName', 'aiDesk.to by IM.codes'],
    ['CFBundleExecutable', AIDESK_MAIN_EXECUTABLE],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', String(version)],
    ['CFBundleVersion', String(version)],
    ['LSMinimumSystemVersion', String(minimumSystemVersion)],
  ];
  const body = entries
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * The order helpers and the bundle must be signed in.
 *
 * Inside out, always. A signature covers everything nested beneath it, so
 * signing the bundle before a helper inside it leaves a seal describing a file
 * that has since changed -- `codesign --verify --deep` then rejects the app,
 * and the failure appears at notarization or on a user's machine rather than
 * here.
 */
export function aideskSigningOrder(bundlePath) {
  return Object.freeze([
    join(bundlePath, 'Contents', AIDESK_HELPERS_DIR, AIDESK_COMPUTER_USE_EXECUTABLE),
    join(bundlePath, 'Contents', 'MacOS', AIDESK_MAIN_EXECUTABLE),
    bundlePath,
  ]);
}

/**
 * Copy the bundled helper's licence in beside it.
 *
 * Read from the pinned package rather than transcribed here, so the notice is
 * always the one that belongs to the exact version being shipped.
 */
export function copyComputerUseLicense(outPath) {
  const source = join(root, 'node_modules', 'open-computer-use', 'LICENSE');
  if (!existsSync(source)) {
    throw new Error(
      `open-computer-use LICENSE not found at ${source}; its MIT notice must ship with the binary`,
    );
  }
  mkdirSync(dirname(outPath), { recursive: true });
  cpSync(source, outPath);
}

/** Compile the agent for one architecture. */
function compileAgentSlice(arch, outPath) {
  const source = join(root, 'native', 'macos-remote-desktop');
  sh('clang++', [
    '-std=c++20',
    '-fobjc-arc',
    '-O2',
    '-arch', arch,
    `-I${source}`,
    join(source, 'aidesk_agent_main.mm'),
    join(source, 'macos_permission_onboarding.mm'),
    '-framework', 'AppKit',
    '-framework', 'ApplicationServices',
    '-framework', 'CoreGraphics',
    '-framework', 'Foundation',
    '-o', outPath,
  ]);
}

/** Build the Universal 2 `aidesk-agent`. */
export function buildAideskAgent(outPath) {
  const work = mkdtempSync(join(tmpdir(), 'imcodes-aidesk-agent-'));
  try {
    const slices = AIDESK_ARCHITECTURES.map((arch) => {
      const slicePath = join(work, `aidesk-agent-${arch}`);
      compileAgentSlice(arch, slicePath);
      return slicePath;
    });
    mkdirSync(dirname(outPath), { recursive: true });
    sh('lipo', ['-create', ...slices, '-output', outPath]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Take the Open Computer Use executable out of the upstream app.
 *
 * Only the executable is carried over. Bringing the whole upstream bundle
 * would nest a second application -- with its own identifier and its own
 * permission grants -- inside ours, which is the thing this design exists to
 * stop.
 */
export function extractComputerUseExecutable(archivePath, outPath) {
  if (!existsSync(archivePath)) throw new Error(`computer-use archive not found: ${archivePath}`);
  const work = mkdtempSync(join(tmpdir(), 'imcodes-aidesk-ocu-'));
  try {
    sh('/usr/bin/ditto', ['-x', '-k', archivePath, work]);
    const roots = readdirSync(work).filter((entry) => entry.endsWith('.app'));
    if (roots.length !== 1) {
      throw new Error(`expected exactly one .app in ${archivePath}, found ${roots.length}`);
    }
    const executable = join(work, roots[0], 'Contents', 'MacOS', AIDESK_COMPUTER_USE_EXECUTABLE);
    if (!existsSync(executable)) {
      throw new Error(`${roots[0]} has no Contents/MacOS/${AIDESK_COMPUTER_USE_EXECUTABLE}`);
    }
    mkdirSync(dirname(outPath), { recursive: true });
    cpSync(executable, outPath);
    sh('/bin/chmod', ['755', outPath]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Sign every nested executable and then the bundle.
 *
 * Ad-hoc when no release identity is present, so a developer can build and run
 * the app locally; Developer ID under the hardened runtime in CI, which is
 * what notarization requires.
 */
export function signAideskApp(bundlePath, options = {}) {
  const identity = options.identity ?? process.env.IMCODES_MACOS_SIGNING_IDENTITY?.trim() ?? '';
  const entitlements = join(root, 'native', 'macos-node', 'imcodes-node.entitlements');
  for (const target of aideskSigningOrder(bundlePath)) {
    const args = ['--force'];
    if (identity) {
      if (!/^[A-F0-9]{40}$/iu.test(identity)) {
        throw new Error('IMCODES_MACOS_SIGNING_IDENTITY must be a SHA-1 fingerprint');
      }
      args.push('--timestamp', '--options', 'runtime', '--entitlements', entitlements, '--sign', identity);
    } else {
      args.push('--sign', '-');
    }
    sh('/usr/bin/codesign', [...args, target]);
  }
  // `--deep` because the point of the order above is that the nested
  // signatures still describe what is there; verifying only the outer seal
  // would not notice if they did not.
  sh('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundlePath]);
}

/**
 * The disk image the download button hands out.
 *
 * A .dmg rather than a .pkg: both can carry a notarization ticket, but a
 * package runs an installer wizard and a disk image is the drag-to-Applications
 * gesture every Mac user already knows. And rather than the bare executable,
 * because Apple documents that a standalone binary cannot be stapled -- this
 * can, so a first launch needs no network.
 *
 * The symlink is what makes the window a drag target instead of a puzzle.
 */
/**
 * Publish the bundle as the helper sidecar the daemon already downloads.
 *
 * This is what turns the bundle from a build artifact into the thing that
 * actually holds the permissions. The daemon fetches this archive, extracts it
 * into its runtime root, and launches `Contents/MacOS/aidesk-agent` from it --
 * so from then on macOS attributes Screen Recording and Accessibility to
 * `to.aidesk.app` rather than to the upstream Open Computer Use bundle signed
 * by someone else entirely.
 *
 * Written over the same path the upstream archive used, because every consumer
 * -- the artifact catalogue, the upgrade download, the runtime's archive
 * validator -- already accepts either bundle by name.
 */
export function publishAideskHelperSidecar(input) {
  const { appPath, sidecarPath } = input;
  if (!existsSync(appPath)) throw new Error(`app bundle not found: ${appPath}`);
  mkdirSync(dirname(sidecarPath), { recursive: true });
  rmSync(sidecarPath, { force: true });
  // `--keepParent` so the archive root is the bundle itself, which is what the
  // runtime's entry validator requires.
  sh('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, sidecarPath]);
  return sidecarPath;
}

export function buildAideskDmg(input) {
  const { appPath, outPath, volumeName = 'aiDesk.to by IM.codes' } = input;
  if (!existsSync(appPath)) throw new Error(`app bundle not found: ${appPath}`);
  const staging = mkdtempSync(join(tmpdir(), 'imcodes-aidesk-dmg-'));
  try {
    cpSync(appPath, join(staging, AIDESK_APP_NAME), { recursive: true, verbatimSymlinks: true });
    sh('/bin/ln', ['-s', '/Applications', join(staging, 'Applications')]);
    rmSync(outPath, { force: true });
    mkdirSync(dirname(outPath), { recursive: true });
    // UDZO is a UDIF image, which is the format `stapler` accepts; a raw or
    // sparse image would notarize and then refuse the ticket.
    sh('/usr/bin/hdiutil', [
      'create',
      '-volname', volumeName,
      '-srcfolder', staging,
      '-ov',
      '-format', 'UDZO',
      outPath,
    ]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return outPath;
}

/**
 * Sign the disk image itself.
 *
 * Signing the image as well as the app it carries means a tampered download is
 * rejected before anything is mounted, rather than at the moment the app is
 * launched.
 */
export function signAideskDmg(dmgPath, options = {}) {
  const identity = options.identity ?? process.env.IMCODES_MACOS_SIGNING_IDENTITY?.trim() ?? '';
  if (!identity) {
    sh('/usr/bin/codesign', ['--force', '--sign', '-', dmgPath]);
    return;
  }
  if (!/^[A-F0-9]{40}$/iu.test(identity)) {
    throw new Error('IMCODES_MACOS_SIGNING_IDENTITY must be a SHA-1 fingerprint');
  }
  sh('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, dmgPath]);
  sh('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmgPath]);
}

export function buildAideskApp(input) {
  const { outDir, computerUseArchive, version, minimumSystemVersion = '12.3' } = input;
  const bundlePath = join(outDir, AIDESK_APP_NAME);
  rmSync(bundlePath, { recursive: true, force: true });
  const macos = join(bundlePath, 'Contents', 'MacOS');
  const helpers = join(bundlePath, 'Contents', AIDESK_HELPERS_DIR);
  mkdirSync(macos, { recursive: true });
  mkdirSync(helpers, { recursive: true });
  writeFileSync(
    join(bundlePath, 'Contents', 'Info.plist'),
    buildAideskInfoPlist({ version, minimumSystemVersion }),
  );
  buildAideskAgent(join(macos, AIDESK_MAIN_EXECUTABLE));
  // Into Helpers, which is where the dispatcher looks.
  extractComputerUseExecutable(computerUseArchive, join(helpers, AIDESK_COMPUTER_USE_EXECUTABLE));
  copyComputerUseLicense(join(bundlePath, 'Contents', 'Resources', AIDESK_THIRD_PARTY_LICENSE));
  signAideskApp(bundlePath);
  return bundlePath;
}

if (process.argv[1] && process.argv[1].endsWith('build-aidesk-app.mjs')) {
  const known = new Set(['dmg', 'sidecar']);
  const mode = known.has(process.argv[2]) ? process.argv[2] : 'app';
  const args = process.argv.slice(mode === 'app' ? 2 : 3);
  const outDir = args[0] ?? join(root, 'dist-node-exe');
  const version = process.env.IMCODES_BUILD_VERSION ?? '0.0.0';
  if (mode === 'sidecar') {
    // Run after the app is stapled, so the archived copy carries its ticket.
    const written = publishAideskHelperSidecar({
      appPath: join(outDir, AIDESK_APP_NAME),
      sidecarPath: join(outDir, 'computer-use-helper', 'darwin-universal', 'open-computer-use.app.zip'),
    });
    process.stdout.write(`${written}\n`);
  } else if (mode === 'dmg') {
    // Built from the app as it stands, which by this point carries its own
    // stapled ticket -- so the app keeps verifying offline after being dragged
    // out of the image.
    const appPath = join(outDir, AIDESK_APP_NAME);
    const dmgPath = join(outDir, `aiDesk.to-${version}.dmg`);
    buildAideskDmg({ appPath, outPath: dmgPath });
    signAideskDmg(dmgPath);
    process.stdout.write(`${dmgPath}\n`);
  } else {
    const archive = args[1]
      ?? join(root, 'dist-node-exe', 'computer-use-helper', 'darwin-universal', 'open-computer-use.app.zip');
    const built = buildAideskApp({ outDir, computerUseArchive: archive, version });
    process.stdout.write(`${built}\n`);
  }
}
