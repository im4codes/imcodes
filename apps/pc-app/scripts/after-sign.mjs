import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PC_APP_BUNDLE_ID, resolveMacosSigningOptions } from '../electron-builder.config.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');
export const MACOS_RELEASE_SIGNING_SCRIPT = join(REPO_ROOT, 'scripts', 'macos-release-signing.mjs');

/**
 * Resolve the signed `.app` bundle path from an electron-builder `afterSign` context.
 * Rejects any non-`.app` path (`.zip`, `.dmg`, etc.) per `docs/pc.v1.app.md` §6.1.
 */
export function resolveMacosAppBundlePath(context) {
  const appOutDir = context?.appOutDir;
  const productFilename = context?.packager?.appInfo?.productFilename;
  if (typeof appOutDir !== 'string' || appOutDir.trim().length === 0) {
    throw new Error('afterSign requires context.appOutDir');
  }
  if (typeof productFilename !== 'string' || productFilename.trim().length === 0) {
    throw new Error('afterSign requires context.packager.appInfo.productFilename');
  }
  const appPath = resolve(appOutDir, `${productFilename}.app`);
  if (!appPath.endsWith('.app')) {
    throw new Error(`afterSign target must be a .app bundle, got: ${appPath}`);
  }
  return appPath;
}

/**
 * Resolve notarization readiness from environment variables.
 * Rejects partial credentials so release builds fail closed rather than silently skipping.
 */
export function resolveMacosNotaryState(env = process.env) {
  const keyPath = env.IMCODES_MACOS_NOTARY_KEY_PATH?.trim() ?? '';
  const keyId = env.IMCODES_MACOS_NOTARY_KEY_ID?.trim() ?? '';
  const issuer = env.IMCODES_MACOS_NOTARY_ISSUER?.trim() ?? '';
  const setCount = [keyPath, keyId, issuer].filter(Boolean).length;
  if (setCount > 0 && setCount < 3) {
    throw new Error(
      'Partial macOS notarization config: set all of IMCODES_MACOS_NOTARY_KEY_PATH, IMCODES_MACOS_NOTARY_KEY_ID, and IMCODES_MACOS_NOTARY_ISSUER',
    );
  }
  return {
    configured: setCount === 3,
    requireNotarize: env.IMCODES_PC_APP_REQUIRE_NOTARIZE === '1',
    keyPath,
    keyId,
    issuer,
  };
}

/**
 * Single macOS notarization entrypoint (`docs/pc.v1.app.md` §6.1).
 * Invokes `scripts/macos-release-signing.mjs notarize <appPath>` directly on the
 * signed `.app` bundle (never passing `.zip` or `.dmg`) before dmg creation runs.
 */
export async function runAfterSign(context, deps = {}) {
  if (context?.electronPlatformName !== 'darwin') {
    return { skipped: true, reason: 'non-darwin', notarized: false };
  }
  const env = deps.env ?? process.env;
  const checkExists = deps.existsSync ?? existsSync;
  const execFn = deps.execFileSync ?? execFileSync;
  const nodeExecPath = deps.nodeExecPath ?? process.execPath;
  const signingScriptPath = deps.signingScriptPath ?? MACOS_RELEASE_SIGNING_SCRIPT;

  const appPath = resolveMacosAppBundlePath(context);
  if (!checkExists(appPath)) {
    throw new Error(`afterSign expected signed .app bundle at ${appPath}`);
  }

  // Restore `-i codes.im.pc` on ad-hoc builds before `.dmg` creation (electron-builder overwrites
  // extraResources binary identifiers with a content hash during signing). Never touch Developer ID builds.
  const hasDeveloperIdEnv =
    resolveMacosSigningOptions(env).mode !== 'ad-hoc' || Boolean(env.MACOS_CODESIGN_IDENTITY?.trim());
  const packagedSpeechBin = join(appPath, 'Contents', 'Resources', 'imcodes-speech');
  if (!hasDeveloperIdEnv && checkExists(packagedSpeechBin)) {
    execFn('codesign', ['--force', '--sign', '-', '-i', PC_APP_BUNDLE_ID, packagedSpeechBin], {
      stdio: 'pipe',
    });
    execFn('codesign', ['--force', '--sign', '-', appPath], {
      stdio: 'pipe',
    });
  }

  const notary = resolveMacosNotaryState(env);
  if (!notary.configured) {
    if (notary.requireNotarize) {
      throw new Error(
        'IMCODES_PC_APP_REQUIRE_NOTARIZE=1 requires IMCODES_MACOS_NOTARY_KEY_PATH, IMCODES_MACOS_NOTARY_KEY_ID, and IMCODES_MACOS_NOTARY_ISSUER',
      );
    }
    process.stdout.write(`[pc-app afterSign] skipping notarization for ${appPath} (notary credentials not configured)\n`);
    return { skipped: true, reason: 'missing_notary_credentials', notarized: false, appPath };
  }

  execFn(nodeExecPath, [signingScriptPath, 'notarize', appPath], {
    env,
    stdio: 'inherit',
  });

  return { skipped: false, notarized: true, appPath };
}

export default async function afterSign(context) {
  return runAfterSign(context);
}
