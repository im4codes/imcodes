/**
 * The shipped form of the native aiDesk window (`aidesk-local-ui`): where it lives next to the controlled-node executable, and the
 * manifest that lets the node trust it before it launches it for a user. The window is only ever started when this verifies;
 * otherwise the panel opens through the browser fallbacks. Pure validation, shared by the node and by the build scripts' tests.
 *
 *   <execDir>/aidesk-local-ui/<os>-<arch>/aidesk-local-ui(.exe)
 *   <execDir>/aidesk-local-ui/<os>-<arch>/aidesk-local-ui.manifest.json
 *
 * macOS ships it inside the signed app instead (Contents/Helpers/aidesk-local-ui, covered by the app's own signature).
 */
import { AIDESK_LOCAL_UI_EXECUTABLE_NAME } from './aidesk-product.js';

export const AIDESK_LOCAL_UI_ARTIFACT_DIRECTORY = 'aidesk-local-ui' as const;
export const AIDESK_LOCAL_UI_MANIFEST_FILENAME = 'aidesk-local-ui.manifest.json' as const;
export const AIDESK_LOCAL_UI_MANIFEST_SCHEMA_VERSION = 1 as const;
/** The licence/notice text of the third-party code linked into the window host (WebView2 SDK), shipped beside the executable. */
export const AIDESK_LOCAL_UI_NOTICES_FILENAME = 'THIRD-PARTY-NOTICES.txt' as const;
/** The notices are plain text; far above any real file, far below anything a corrupt server reply could make the node keep. */
export const AIDESK_LOCAL_UI_NOTICES_MAX_BYTES = 256 * 1024;
/** The manifest is a few hundred bytes. */
export const AIDESK_LOCAL_UI_MANIFEST_MAX_BYTES = 16 * 1024;
/** The one platform/architecture the window host is built and shipped for (Windows x64; macOS ships it inside the app, Linux uses the browser). */
export const AIDESK_LOCAL_UI_SIDECAR_TARGET = Object.freeze({ os: 'win32', arch: 'x64' } as const);
export const AIDESK_LOCAL_UI_PLATFORMS = ['win32', 'darwin', 'linux'] as const;
export const AIDESK_LOCAL_UI_ARCHITECTURES = ['x64', 'arm64'] as const;
export type AideskLocalUiPlatform = typeof AIDESK_LOCAL_UI_PLATFORMS[number];
export type AideskLocalUiArchitecture = typeof AIDESK_LOCAL_UI_ARCHITECTURES[number];

const SHA256_RE = /^[a-f0-9]{64}$/u;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
/** Far above any real build (the window is a few MB), far below anything a corrupt manifest could make us read. */
export const AIDESK_LOCAL_UI_MAX_BYTES = 256 * 1024 * 1024;

export interface AideskLocalUiManifest {
  schemaVersion: typeof AIDESK_LOCAL_UI_MANIFEST_SCHEMA_VERSION;
  /** File name of the executable this manifest describes. */
  artifact: string;
  os: AideskLocalUiPlatform;
  arch: AideskLocalUiArchitecture;
  version: string;
  size: number;
  sha256: string;
  /** Windows only: the Authenticode signer (sha256 of its certificate) the executable must carry. */
  signerSha256?: string;
}

export function aideskLocalUiExecutableFileName(os: AideskLocalUiPlatform): string {
  return os === 'win32' ? `${AIDESK_LOCAL_UI_EXECUTABLE_NAME}.exe` : AIDESK_LOCAL_UI_EXECUTABLE_NAME;
}

/** `aidesk-local-ui/<os>-<arch>` (relative to the controlled-node executable's directory). */
export function aideskLocalUiArtifactRelativeDirectory(os: AideskLocalUiPlatform, arch: AideskLocalUiArchitecture): string {
  return `${AIDESK_LOCAL_UI_ARTIFACT_DIRECTORY}/${os}-${arch}`;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

/** The manifest for exactly this platform, or null: any extra/missing field, wrong type, bad hash or oversize file is untrusted. */
export function validateAideskLocalUiManifest(
  value: unknown,
  expected: { os: AideskLocalUiPlatform; arch: AideskLocalUiArchitecture },
): AideskLocalUiManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ['schemaVersion', 'artifact', 'os', 'arch', 'version', 'size', 'sha256'], ['signerSha256'])) return null;
  if (candidate.schemaVersion !== AIDESK_LOCAL_UI_MANIFEST_SCHEMA_VERSION) return null;
  if (candidate.os !== expected.os || candidate.arch !== expected.arch) return null;
  if (candidate.artifact !== aideskLocalUiExecutableFileName(expected.os)) return null;
  if (typeof candidate.version !== 'string' || !VERSION_RE.test(candidate.version)) return null;
  if (typeof candidate.size !== 'number' || !Number.isSafeInteger(candidate.size) || candidate.size <= 0 || candidate.size > AIDESK_LOCAL_UI_MAX_BYTES) return null;
  if (typeof candidate.sha256 !== 'string' || !SHA256_RE.test(candidate.sha256)) return null;
  if (candidate.signerSha256 !== undefined && (typeof candidate.signerSha256 !== 'string' || !SHA256_RE.test(candidate.signerSha256))) return null;
  // Windows executables must name the signer they were signed by; the others have no signature of their own to name.
  if (expected.os === 'win32' && candidate.signerSha256 === undefined) return null;
  return candidate as unknown as AideskLocalUiManifest;
}

/**
 * What a full verification (size, sha256, release signer) leaves behind, so a click does not repeat it: hashing the executable and
 * validating its Authenticode chain (a cold PowerShell, with a revocation lookup that waits on the network) took seconds on a slow
 * or offline PC, on EVERY open. It lives in the same directory as the executable and the manifest, which only SYSTEM and
 * Administrators can write: whoever could forge it could replace the executable.
 *
 * It is honoured only while the file it describes is the very file that was verified (same manifest sha256, same size, same last
 * write time) and the release signer it was verified against is still the compiled trust anchor; anything else is verified in full.
 */
export const AIDESK_LOCAL_UI_VERIFIED_FILENAME = 'aidesk-local-ui.verified.json' as const;
export const AIDESK_LOCAL_UI_VERIFIED_SCHEMA_VERSION = 1 as const;
export const AIDESK_LOCAL_UI_VERIFIED_MAX_BYTES = 4 * 1024;

export interface AideskLocalUiVerifiedRecord {
  schemaVersion: typeof AIDESK_LOCAL_UI_VERIFIED_SCHEMA_VERSION;
  sha256: string;
  size: number;
  /** Whole milliseconds of the file's last write time when it was verified. */
  mtimeMs: number;
  /** The Authenticode signer (Windows) it was verified against; absent where there is no signature of its own. */
  signerSha256?: string;
  verifiedAtMs: number;
}

export function validateAideskLocalUiVerifiedRecord(value: unknown): AideskLocalUiVerifiedRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ['schemaVersion', 'sha256', 'size', 'mtimeMs', 'verifiedAtMs'], ['signerSha256'])) return null;
  if (candidate.schemaVersion !== AIDESK_LOCAL_UI_VERIFIED_SCHEMA_VERSION) return null;
  if (typeof candidate.sha256 !== 'string' || !SHA256_RE.test(candidate.sha256)) return null;
  if (typeof candidate.size !== 'number' || !Number.isSafeInteger(candidate.size) || candidate.size <= 0 || candidate.size > AIDESK_LOCAL_UI_MAX_BYTES) return null;
  if (typeof candidate.mtimeMs !== 'number' || !Number.isSafeInteger(candidate.mtimeMs) || candidate.mtimeMs < 0) return null;
  if (typeof candidate.verifiedAtMs !== 'number' || !Number.isSafeInteger(candidate.verifiedAtMs) || candidate.verifiedAtMs < 0) return null;
  if (candidate.signerSha256 !== undefined && (typeof candidate.signerSha256 !== 'string' || !SHA256_RE.test(candidate.signerSha256))) return null;
  return candidate as unknown as AideskLocalUiVerifiedRecord;
}

/** Is `record` the proof for exactly this file, this manifest and this trust anchor? */
export function aideskLocalUiVerifiedRecordCovers(
  record: AideskLocalUiVerifiedRecord,
  current: { manifest: AideskLocalUiManifest; size: number; mtimeMs: number; trustedSignerSha256?: string },
): boolean {
  return record.sha256 === current.manifest.sha256
    && record.size === current.manifest.size
    && record.size === current.size
    && record.mtimeMs === Math.floor(current.mtimeMs)
    && record.signerSha256 === (current.trustedSignerSha256 ?? current.manifest.signerSha256);
}
