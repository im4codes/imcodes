export interface ImcodesVersionParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parsePart(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value.toLowerCase();
}

export function parseImcodesVersion(version: string): ImcodesVersionParts | null {
  const trimmed = version.trim();
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map((part) => String(parsePart(part))) : [],
  };
}

/** npm dist-tags imcodes publishes to: 'latest' (stable) and 'dev'. */
export type ReleaseChannel = 'latest' | 'dev';

export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['latest', 'dev'];

/**
 * Infer the release channel a version string belongs to. Stable releases are a
 * clean `MAJOR.MINOR.PATCH`; dev builds carry a prerelease segment (published
 * under the `dev` dist-tag, e.g. `2026.5.2059-dev.2036`). Any prerelease is
 * treated as the dev channel — a non-stable build should never be mistaken for
 * `latest`. Unparseable input falls back to `latest`.
 */
export function getReleaseChannel(version: string): ReleaseChannel {
  const parts = parseImcodesVersion(version);
  if (parts && parts.prerelease.length > 0) return 'dev';
  return 'latest';
}

/** Narrow an arbitrary string to a ReleaseChannel, or null if it isn't one. */
export function asReleaseChannel(value: string): ReleaseChannel | null {
  return (RELEASE_CHANNELS as readonly string[]).includes(value) ? (value as ReleaseChannel) : null;
}

function comparePrereleasePart(a: string, b: string): number {
  const aIsNum = /^\d+$/.test(a);
  const bIsNum = /^\d+$/.test(b);
  if (aIsNum && bIsNum) {
    const an = Number(a);
    const bn = Number(b);
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  }
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function compareImcodesVersions(a: string, b: string): number | null {
  const pa = parseImcodesVersion(a);
  const pb = parseImcodesVersion(b);
  if (!pa || !pb) return null;

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (!aPre.length && !bPre.length) return 0;
  if (!aPre.length) return 1;
  if (!bPre.length) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    const av = aPre[i];
    const bv = bPre[i];
    if (av == null) return -1;
    if (bv == null) return 1;
    const cmp = comparePrereleasePart(av, bv);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function isLocalDevImcodesVersion(version: string): boolean {
  return version.trim().startsWith('0.');
}
