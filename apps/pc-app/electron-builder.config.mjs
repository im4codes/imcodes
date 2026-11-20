import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
export const PC_APP_DIR = THIS_DIR;
export const REPO_ROOT = resolve(THIS_DIR, '..', '..');

export const PC_APP_BUNDLE_ID = 'codes.im.pc';
export const PC_APP_PRODUCT_NAME = 'IM.codes';
export const PC_APP_AFTER_SIGN_HOOK = resolve(PC_APP_DIR, 'scripts', 'after-sign.mjs');
export const PC_APP_WIN_SIGN_HOOK = resolve(PC_APP_DIR, 'scripts', 'win-sign.mjs');
export const PC_APP_MAC_ENTITLEMENTS = resolve(PC_APP_DIR, 'build', 'entitlements.mac.plist');
export const PC_APP_MAC_ENTITLEMENTS_INHERIT = resolve(PC_APP_DIR, 'build', 'entitlements.mac.inherit.plist');
export const PC_APP_MAC_ICON = resolve(PC_APP_DIR, 'build', 'icon.icns');
export const PC_APP_WIN_ICON = resolve(PC_APP_DIR, 'build', 'icon.ico');
export const PC_APP_PNG_ICON = resolve(PC_APP_DIR, 'build', 'icon.png');
export const PC_APP_MAC_NESTED_BINARIES = Object.freeze([
  'Contents/Resources/bin/tmux',
  'Contents/Resources/imcodes',
  'Contents/Resources/imcodes-speech',
]);

/**
 * Resolve macOS code-signing options for electron-builder.
 * - Release CI sets `IMCODES_MACOS_SIGNING_IDENTITY` (40-hex SHA-1) or `CSC_NAME`/`CSC_LINK`,
 *   enabling Developer ID signing with Hardened Runtime.
 * - Local unsigned/dev builds fall back to ad-hoc signing (`identity: "-"`,
 *   `hardenedRuntime: false`) so nested binaries and the `.app` still execute and pass
 *   `codesign --verify --deep --strict` (Gate ③) without a keychain identity.
 */
export function resolveMacosSigningOptions(env = process.env) {
  const sha1Identity = env.IMCODES_MACOS_SIGNING_IDENTITY?.trim() ?? '';
  if (sha1Identity) {
    if (!/^[a-f0-9]{40}$/i.test(sha1Identity)) {
      throw new Error('IMCODES_MACOS_SIGNING_IDENTITY must be a 40-character SHA-1 hex fingerprint');
    }
    return {
      identity: sha1Identity,
      hardenedRuntime: true,
      mode: 'release',
    };
  }
  const cscName = env.CSC_NAME?.trim() ?? '';
  const cscLink = env.CSC_LINK?.trim() ?? '';
  if (cscName || cscLink) {
    return {
      identity: cscName || undefined,
      hardenedRuntime: true,
      mode: 'release',
    };
  }
  if (env.IMCODES_PC_APP_REQUIRE_SIGNING === '1') {
    throw new Error(
      'IMCODES_PC_APP_REQUIRE_SIGNING=1 requires IMCODES_MACOS_SIGNING_IDENTITY, CSC_NAME, or CSC_LINK',
    );
  }
  return {
    identity: '-',
    hardenedRuntime: false,
    mode: 'ad-hoc',
  };
}

/**
 * Build the electron-builder configuration object for `apps/pc-app/`.
 * Kept pure so unit tests can assert nested binaries, `extraResources`, single
 * `afterSign` notarization (`mac.notarize: false`), and Windows NSIS/sign wiring.
 */
export function createPcAppElectronBuilderConfig({
  macArch = process.arch === 'arm64' ? 'arm64' : 'x64',
  winArch = 'x64',
  outDir = 'release',
  macStageDir = resolve(REPO_ROOT, '.pc-app-stage', 'darwin'),
  winStageDir = resolve(REPO_ROOT, '.pc-app-stage', 'win32'),
  version,
  env = process.env,
  afterSignHook = PC_APP_AFTER_SIGN_HOOK,
  winSignHook = PC_APP_WIN_SIGN_HOOK,
} = {}) {
  const macSigning = resolveMacosSigningOptions(env);
  return {
    appId: PC_APP_BUNDLE_ID,
    productName: PC_APP_PRODUCT_NAME,
    asar: true,
    npmRebuild: false,
    buildDependenciesFromSource: false,
    ...(version ? { extraMetadata: { version } } : {}),
    directories: {
      output: outDir,
      buildResources: resolve(PC_APP_DIR, 'build'),
    },
    files: [
      'dist/src/**/*',
      'build/icon.png',
      'package.json',
    ],
    afterSign: afterSignHook,
    mac: {
      icon: PC_APP_MAC_ICON,
      category: 'public.app-category.developer-tools',
      target: [{ target: 'dmg', arch: [macArch] }],
      binaries: [...PC_APP_MAC_NESTED_BINARIES],
      entitlements: PC_APP_MAC_ENTITLEMENTS,
      entitlementsInherit: PC_APP_MAC_ENTITLEMENTS_INHERIT,
      extendInfo: {
        NSMicrophoneUsageDescription: 'IM.codes needs microphone access for voice dictation and audio input.',
        NSSpeechRecognitionUsageDescription: 'IM.codes needs speech recognition access to transcribe your voice in chat.',
      },
      hardenedRuntime: macSigning.hardenedRuntime,
      ...(macSigning.identity !== undefined ? { identity: macSigning.identity } : {}),
      gatekeeperAssess: false,
      strictVerify: true,
      // Single notarization point lives in `afterSign` -> `macos-release-signing.mjs notarize <app>`.
      // Never enable electron-builder's @electron/notarize or duplicate dmg notarization.
      notarize: false,
      extraResources: [
        {
          from: macStageDir,
          to: '.',
        },
      ],
    },
    dmg: {
      artifactName: 'IM.codes-${version}-${arch}.${ext}',
    },
    win: {
      icon: PC_APP_WIN_ICON,
      target: [{ target: 'nsis', arch: [winArch] }],
      executableName: 'IM.codes',
      signtoolOptions: {
        signingHashAlgorithms: ['sha256'],
        sign: winSignHook,
      },
      extraResources: [
        {
          from: winStageDir,
          to: '.',
        },
      ],
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      artifactName: 'IM.codes-Setup-${version}-${arch}.${ext}',
    },
  };
}

export default createPcAppElectronBuilderConfig();
