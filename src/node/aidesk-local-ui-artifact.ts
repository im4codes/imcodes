/**
 * Finds the native aiDesk window on this machine AND proves it is the one that was built and shipped. The window is launched for
 * a user, so nothing is started on the strength of a file name: it has to match the manifest next to it (size and sha256), and on
 * Windows it has to carry the release publisher's Authenticode signature. macOS ships it inside the signed app bundle instead,
 * where the app's own code signature is the proof. A development runtime has no release trust anchor and therefore never uses one.
 * Anything that does not verify simply means "no native window": the panel opens through the browser fallbacks.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AIDESK_LOCAL_UI_ARCHITECTURES,
  AIDESK_LOCAL_UI_MANIFEST_FILENAME,
  aideskLocalUiArtifactRelativeDirectory,
  aideskLocalUiExecutableFileName,
  validateAideskLocalUiManifest,
  type AideskLocalUiArchitecture,
  type AideskLocalUiPlatform,
} from '../../shared/aidesk-local-ui-artifact.js';
import { AIDESK_LOCAL_UI_EXECUTABLE_NAME } from '../../shared/aidesk-product.js';
import { MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH } from './macos-remote-desktop-responsible-spawn.js';
import { WINDOWS_COMPILED_RELEASE_SIGNER_SHA256, verifyWindowsAuthenticodeSigners } from './windows-artifact-trust.js';

export interface AideskLocalUiVerifyDeps {
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  trustedWindowsSignerSha256: string;
  verifySigners: (paths: readonly string[], signerSha256: string) => Promise<boolean>;
  /** macOS: does the code signature of this helper (inside the app) verify? */
  codesignVerifies: (path: string) => Promise<boolean>;
  readFile: (path: string) => Buffer;
  lstat: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean; size: number } | undefined;
  macosHelperPath: string;
}

const defaults = (): AideskLocalUiVerifyDeps => ({
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  trustedWindowsSignerSha256: WINDOWS_COMPILED_RELEASE_SIGNER_SHA256,
  verifySigners: verifyWindowsAuthenticodeSigners,
  codesignVerifies: (path) => new Promise((resolveVerified) => {
    execFile('/usr/bin/codesign', ['--verify', '--strict', path], { timeout: 8_000 }, (error) => resolveVerified(!error));
  }),
  readFile: (path) => readFileSync(path),
  lstat: (path) => { try { return lstatSync(path); } catch { return undefined; } },
  macosHelperPath: join(MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH, 'Contents', 'Helpers', AIDESK_LOCAL_UI_EXECUTABLE_NAME),
});

const isRegularFile = (stat: ReturnType<AideskLocalUiVerifyDeps['lstat']>): stat is NonNullable<typeof stat> => !!stat && stat.isFile() && !stat.isSymbolicLink();

/** The verified native window's absolute path, or undefined when there is none (not shipped, tampered, unsigned, wrong platform). */
export async function resolveVerifiedAideskLocalUi(overrides: Partial<AideskLocalUiVerifyDeps> = {}): Promise<string | undefined> {
  const deps = { ...defaults(), ...overrides };
  const os = deps.platform as AideskLocalUiPlatform;
  const arch = deps.arch as AideskLocalUiArchitecture;
  try {
    if (deps.platform === 'darwin') {
      return isRegularFile(deps.lstat(deps.macosHelperPath)) && await deps.codesignVerifies(deps.macosHelperPath) ? deps.macosHelperPath : undefined;
    }
    if ((deps.platform !== 'win32' && deps.platform !== 'linux') || !(AIDESK_LOCAL_UI_ARCHITECTURES as readonly string[]).includes(deps.arch)) return undefined;
    const directory = resolve(dirname(deps.execPath), aideskLocalUiArtifactRelativeDirectory(os, arch));
    const executable = join(directory, aideskLocalUiExecutableFileName(os));
    const executableStat = deps.lstat(executable);
    const manifestPath = join(directory, AIDESK_LOCAL_UI_MANIFEST_FILENAME);
    if (!isRegularFile(executableStat) || !isRegularFile(deps.lstat(manifestPath))) return undefined;
    const manifest = validateAideskLocalUiManifest(JSON.parse(deps.readFile(manifestPath).toString('utf8')), { os, arch });
    if (!manifest || manifest.size !== executableStat.size) return undefined;
    if (createHash('sha256').update(deps.readFile(executable)).digest('hex') !== manifest.sha256) return undefined;
    if (os === 'win32') {
      const trusted = deps.trustedWindowsSignerSha256;
      if (!/^[a-f0-9]{64}$/u.test(trusted) || manifest.signerSha256 !== trusted) return undefined;
      if (!await deps.verifySigners([executable], trusted)) return undefined;
    }
    return executable;
  } catch {
    return undefined;
  }
}

/**
 * The sha256 the manifest next to a verified executable records, read again right before the executable is started: the launch script
 * re-hashes the file against it, which narrows the window between "verified" and "started" to the launch itself (the directory is not
 * writable by ordinary users either, see the sidecar refresh). Undefined when the manifest cannot be read or does not validate.
 */
export function readAideskLocalUiExpectedSha256(executablePath: string, overrides: Partial<Pick<AideskLocalUiVerifyDeps, 'platform' | 'arch' | 'readFile'>> = {}): string | undefined {
  const platform = (overrides.platform ?? process.platform) as AideskLocalUiPlatform;
  const arch = (overrides.arch ?? process.arch) as AideskLocalUiArchitecture;
  const read = overrides.readFile ?? ((path: string) => readFileSync(path));
  try {
    const manifest = validateAideskLocalUiManifest(JSON.parse(read(join(dirname(executablePath), AIDESK_LOCAL_UI_MANIFEST_FILENAME)).toString('utf8')), { os: platform, arch });
    return manifest?.sha256;
  } catch {
    return undefined;
  }
}
