// Single source of truth for the installer / daemon-auto-upgrade contract.
//
// The bash (landing/install.sh) and PowerShell (landing/install.ps1) installers
// cannot import this module at runtime — they MUST mirror the constant values
// below verbatim, with a comment pointing back here. The daemon (src/) and the
// vitest golden tests DO import it, so the parse/registry semantics have exactly
// one authoritative implementation that the scripts are validated against.

// ── Source endpoints (keep in sync with landing/install.{sh,ps1}) ─────────────
export const INSTALLER_OFFICIAL_NODE_DIST = 'https://nodejs.org/dist';
export const INSTALLER_OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/';
// Mirror vendor: a pass-through proxy used in restricted-network regions. Keeping
// the value here (not a region label) preserves the neutral wording requirement.
export const INSTALLER_MIRROR_NODE_BASE = 'https://mirrors.cloud.tencent.com/nodejs-release';
export const INSTALLER_MIRROR_NPM_REGISTRY = 'https://mirrors.cloud.tencent.com/npm/';

// ── Node version policy (keep in sync with package.json engines.node) ─────────
export const INSTALLER_NODE_MIN_MAJOR = 22;
export const INSTALLER_NODE_DEFAULT_MAJOR = 24;

// Connectivity probe endpoint — returns exactly 204 on an unrestricted network.
export const INSTALLER_PROBE_URL = 'https://www.google.com/generate_204';

// Name of the imcodes-owned config file that records which npm registry the
// daemon's own auto-upgrade should resolve through. Lives under ~/.imcodes so it
// does NOT pollute the user's global ~/.npmrc (unlike the legacy approach).
export const INSTALLER_CONFIG_BASENAME = 'install.json';

export interface InstallerConfig {
  /** npm registry the daemon should pass to `npm install -g` / `npm view`. */
  npmRegistry?: string;
}

/**
 * Normalize a registry URL to a base with a single trailing slash, so callers
 * can safely concatenate `imcodes/latest`. Returns null for anything that isn't
 * a syntactically valid http(s) URL.
 */
export function normalizeRegistryBase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    // Validate it parses; reject things like "https://" with no host.
    const u = new URL(trimmed);
    if (!u.host) return null;
  } catch {
    return null;
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/**
 * Decide which registry the daemon auto-upgrade should use, in priority order:
 *   1. imcodes' own install.json `npmRegistry` (written by the installer)
 *   2. the ambient npm registry (`npm config get registry`) — covers users who
 *      installed via the legacy script that persisted the mirror to ~/.npmrc
 *   3. the official registry (default)
 *
 * Returns a normalized base URL (trailing slash). Pure: callers supply the
 * already-read config value and ambient value.
 */
export function pickUpgradeRegistry(opts: {
  configRegistry?: unknown;
  ambientRegistry?: unknown;
}): string {
  return (
    normalizeRegistryBase(opts.configRegistry) ??
    normalizeRegistryBase(opts.ambientRegistry) ??
    INSTALLER_OFFICIAL_NPM_REGISTRY
  );
}

/**
 * Parse a Node SHASUMS256.txt body and return the lowercase SHA-256 for the
 * named artifact, matching the filename as a WHOLE field (column 2) — never a
 * regex suffix. Mirrors the awk / PowerShell logic in the installer scripts.
 * Returns null when the artifact is absent.
 */
export function parseShasumsLine(shasumsText: string, artifactName: string): string | null {
  for (const raw of shasumsText.split(/\r?\n/)) {
    const fields = raw.split(/\s+/).filter((f) => f !== '');
    if (fields.length >= 2 && fields[1] === artifactName && /^[0-9a-fA-F]{64}$/.test(fields[0])) {
      return fields[0].toLowerCase();
    }
  }
  return null;
}

/**
 * From a list of Node version strings (e.g. "v24.4.0"), pick the highest patch
 * for the requested major. Order-independent (does not rely on index.json
 * ordering). Mirrors the explicit semver sort in the installer scripts.
 */
export function pickLatestNodeVersion(versions: string[], major: number): string | null {
  const re = new RegExp(`^v${major}\\.(\\d+)\\.(\\d+)`);
  let best: { v: string; minor: number; patch: number } | null = null;
  for (const v of versions) {
    const m = re.exec(v);
    if (!m) continue;
    const minor = parseInt(m[1], 10);
    const patch = parseInt(m[2], 10);
    if (
      best === null ||
      minor > best.minor ||
      (minor === best.minor && patch > best.patch)
    ) {
      best = { v, minor, patch };
    }
  }
  return best ? best.v : null;
}
