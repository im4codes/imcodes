/**
 * Finds the native aiDesk window on this machine AND proves it is the one that was built and shipped. The window is launched for
 * a user, so nothing is started on the strength of a file name: it has to match the manifest next to it (size and sha256), and on
 * Windows it has to carry the release publisher's Authenticode signature. macOS ships it inside the signed app bundle instead,
 * where the app's own code signature is the proof. A development runtime has no release trust anchor and therefore never uses one.
 * Anything that does not verify simply means "no native window": the panel opens through the browser fallbacks.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AIDESK_LOCAL_UI_ARCHITECTURES,
  AIDESK_LOCAL_UI_MANIFEST_FILENAME,
  AIDESK_LOCAL_UI_VERIFIED_FILENAME,
  AIDESK_LOCAL_UI_VERIFIED_MAX_BYTES,
  AIDESK_LOCAL_UI_VERIFIED_SCHEMA_VERSION,
  aideskLocalUiArtifactRelativeDirectory,
  aideskLocalUiExecutableFileName,
  aideskLocalUiVerifiedRecordCovers,
  validateAideskLocalUiManifest,
  validateAideskLocalUiVerifiedRecord,
  type AideskLocalUiVerifiedRecord,
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
  lstat: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number } | undefined;
  /** sha256 of a (large) file without holding the event loop: the executable is read in chunks, never as one synchronous read. */
  hashFile: (path: string) => Promise<string>;
  /** Leaves the proof of a full verification next to the executable. Best effort: only an administrator can write there. */
  writeVerifiedRecord: (path: string, record: AideskLocalUiVerifiedRecord) => void;
  now: () => number;
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
  hashFile: hashFileStreaming,
  writeVerifiedRecord: (path, record) => { try { writeFileSync(path, JSON.stringify(record), { mode: 0o644 }); } catch { /* cache only: a user process cannot write here */ } },
  now: () => Date.now(),
  macosHelperPath: join(MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_PATH, 'Contents', 'Helpers', AIDESK_LOCAL_UI_EXECUTABLE_NAME),
});

function hashFileStreaming(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', rejectHash);
    stream.once('end', () => resolveHash(hash.digest('hex')));
  });
}

/** macOS: helpers whose code signature verified in this process, as `path|size|mtime`. */
const macosCodesignVerified = new Set<string>();

const isRegularFile = (stat: ReturnType<AideskLocalUiVerifyDeps['lstat']>): stat is NonNullable<typeof stat> => !!stat && stat.isFile() && !stat.isSymbolicLink();

/** A verified native window, and how that was established (for the phase log and the tests). */
export interface VerifiedAideskLocalUi {
  path: string;
  sha256: string;
  size: number;
  /** Whole milliseconds of the executable's last write time (what the proof is tied to). */
  mtimeMs: number;
  /** `record`: the proof of an earlier full verification still covers this very file; `full`: size, sha256 and signer were just checked. */
  source: 'record' | 'full';
}

/**
 * The verified native window, or undefined when there is none (not shipped, tampered, unsigned, wrong platform).
 *
 * Verification is mandatory before a binary is ever started, but it is not repeated per click: a full verification (size, sha256 --
 * read in chunks, never as one synchronous read -- and, on Windows, the Authenticode chain and release signer) leaves a record
 * beside the executable (see AIDESK_LOCAL_UI_VERIFIED_FILENAME) that covers exactly that file, and the next open only compares the
 * file's size and last write time to it. Any change (new build, touched file, other trust anchor) is verified in full again.
 */
export async function resolveVerifiedAideskLocalUiDetailed(overrides: Partial<AideskLocalUiVerifyDeps> = {}): Promise<VerifiedAideskLocalUi | undefined> {
  const deps = { ...defaults(), ...overrides };
  const os = deps.platform as AideskLocalUiPlatform;
  const arch = deps.arch as AideskLocalUiArchitecture;
  try {
    if (deps.platform === 'darwin') {
      const helper = deps.lstat(deps.macosHelperPath);
      if (!isRegularFile(helper)) return undefined;
      const identity = `${deps.macosHelperPath}|${helper.size}|${Math.floor(helper.mtimeMs)}`;
      const base = { path: deps.macosHelperPath, sha256: '', size: helper.size, mtimeMs: Math.floor(helper.mtimeMs) };
      // The code signature of an unchanged helper is not re-checked for every click of a long-running node (a `codesign` process each
      // time); the proof cannot live inside the signed bundle, so it is remembered in memory, tied to the helper's size and write time.
      if (macosCodesignVerified.has(identity)) return { ...base, source: 'record' };
      if (!await deps.codesignVerifies(deps.macosHelperPath)) return undefined;
      macosCodesignVerified.add(identity);
      return { ...base, source: 'full' };
    }
    if ((deps.platform !== 'win32' && deps.platform !== 'linux') || !(AIDESK_LOCAL_UI_ARCHITECTURES as readonly string[]).includes(deps.arch)) return undefined;
    const directory = resolve(dirname(deps.execPath), aideskLocalUiArtifactRelativeDirectory(os, arch));
    const executable = join(directory, aideskLocalUiExecutableFileName(os));
    const executableStat = deps.lstat(executable);
    const manifestPath = join(directory, AIDESK_LOCAL_UI_MANIFEST_FILENAME);
    if (!isRegularFile(executableStat) || !isRegularFile(deps.lstat(manifestPath))) return undefined;
    const manifest = validateAideskLocalUiManifest(JSON.parse(deps.readFile(manifestPath).toString('utf8')), { os, arch });
    if (!manifest || manifest.size !== executableStat.size) return undefined;
    const trusted = deps.trustedWindowsSignerSha256;
    if (os === 'win32' && (!/^[a-f0-9]{64}$/u.test(trusted) || manifest.signerSha256 !== trusted)) return undefined;
    const mtimeMs = Math.floor(executableStat.mtimeMs);
    const covered = (record: AideskLocalUiVerifiedRecord | null): boolean => record !== null && aideskLocalUiVerifiedRecordCovers(record, {
      manifest, size: executableStat.size, mtimeMs: executableStat.mtimeMs, ...(os === 'win32' ? { trustedSignerSha256: trusted } : {}),
    });
    const recordPath = join(directory, AIDESK_LOCAL_UI_VERIFIED_FILENAME);
    const recordStat = deps.lstat(recordPath);
    if (isRegularFile(recordStat) && recordStat.size <= AIDESK_LOCAL_UI_VERIFIED_MAX_BYTES) {
      let record: AideskLocalUiVerifiedRecord | null = null;
      try { record = validateAideskLocalUiVerifiedRecord(JSON.parse(deps.readFile(recordPath).toString('utf8'))); } catch { record = null; }
      if (covered(record)) return { path: executable, sha256: manifest.sha256, size: executableStat.size, mtimeMs, source: 'record' };
    }
    if (await deps.hashFile(executable) !== manifest.sha256) return undefined;
    if (os === 'win32' && !await deps.verifySigners([executable], trusted)) return undefined;
    // The file may have been swapped while it was being checked: the proof is only written for the very file that was looked at.
    const after = deps.lstat(executable);
    if (!isRegularFile(after) || after.size !== executableStat.size || Math.floor(after.mtimeMs) !== mtimeMs) return undefined;
    try {
      deps.writeVerifiedRecord(recordPath, {
        schemaVersion: AIDESK_LOCAL_UI_VERIFIED_SCHEMA_VERSION,
        sha256: manifest.sha256,
        size: executableStat.size,
        mtimeMs,
        ...(os === 'win32' ? { signerSha256: trusted } : {}),
        verifiedAtMs: deps.now(),
      });
    } catch { /* the proof is a cache: failing to leave it only means the next open verifies again */ }
    return { path: executable, sha256: manifest.sha256, size: executableStat.size, mtimeMs, source: 'full' };
  } catch {
    return undefined;
  }
}

/** The verified native window's absolute path, or undefined when there is none. */
export async function resolveVerifiedAideskLocalUi(overrides: Partial<AideskLocalUiVerifyDeps> = {}): Promise<string | undefined> {
  return (await resolveVerifiedAideskLocalUiDetailed(overrides))?.path;
}
