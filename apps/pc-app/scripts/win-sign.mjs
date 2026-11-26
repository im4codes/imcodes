import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');
export const WINDOWS_SIGN_SCRIPT = join(REPO_ROOT, 'scripts', 'windows-sign-release-artifact.ps1');

/**
 * Resolve Windows release signing configuration from environment variables.
 * Enforces paired thumbprint + SHA-256 certificate pin (`windows-sign-release-artifact.ps1`).
 */
export function resolveWindowsSigningConfig(env = process.env) {
  const thumbprint = env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT?.trim() ?? '';
  const sha256 = env.IMCODES_WINDOWS_SIGNING_CERT_SHA256?.trim() ?? '';
  const timestampUrl = env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL?.trim() || 'http://timestamp.digicert.com';
  const requireSigning = env.IMCODES_PC_APP_REQUIRE_SIGNING === '1';

  if (Boolean(thumbprint) !== Boolean(sha256)) {
    throw new Error(
      'Windows pc-app signing requires both IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT and IMCODES_WINDOWS_SIGNING_CERT_SHA256',
    );
  }
  if (!thumbprint) {
    if (requireSigning) {
      throw new Error(
        'IMCODES_PC_APP_REQUIRE_SIGNING=1 requires IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT and IMCODES_WINDOWS_SIGNING_CERT_SHA256',
      );
    }
    return { configured: false, thumbprint: '', sha256: '', timestampUrl };
  }
  if (!/^[a-f0-9]{40}$/i.test(thumbprint)) {
    throw new Error('IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT must be a 40-character SHA-1 hex string');
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('IMCODES_WINDOWS_SIGNING_CERT_SHA256 must be a 64-character SHA-256 hex string');
  }
  return {
    configured: true,
    thumbprint,
    sha256: sha256.toLowerCase(),
    timestampUrl,
  };
}

/**
 * Custom electron-builder Windows signing hook delegating to `scripts/windows-sign-release-artifact.ps1`.
 */
export async function runWindowsSign(configuration, deps = {}) {
  const env = deps.env ?? process.env;
  const execFn = deps.execFileSync ?? execFileSync;
  const signScriptPath = deps.signScriptPath ?? WINDOWS_SIGN_SCRIPT;
  const artifactPath = configuration?.path;
  if (typeof artifactPath !== 'string' || artifactPath.trim().length === 0) {
    throw new Error('Windows signing configuration requires configuration.path');
  }

  const signing = resolveWindowsSigningConfig(env);
  if (!signing.configured) {
    process.stdout.write(`[pc-app winSign] skipping Authenticode signing for ${artifactPath} (signing env not configured)\n`);
    return { skipped: true, signed: false, path: artifactPath };
  }

  const systemRoot = env.SystemRoot?.trim();
  if (!systemRoot) {
    throw new Error('SystemRoot is required to locate Windows PowerShell');
  }
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFn(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      signScriptPath,
      '-Mode',
      'Sign',
      '-ArtifactPath',
      artifactPath,
      '-CodeSigningCertificateThumbprint',
      signing.thumbprint,
      '-ExpectedSignerSha256',
      signing.sha256,
      '-TimestampUrl',
      signing.timestampUrl,
    ],
    { env, stdio: 'inherit' },
  );
  return { skipped: false, signed: true, path: artifactPath };
}

export default async function winSign(configuration) {
  return runWindowsSign(configuration);
}
