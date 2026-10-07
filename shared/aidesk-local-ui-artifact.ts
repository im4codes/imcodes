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
