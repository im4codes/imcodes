export const DEFAULT_DAEMON_R2_BASE_URL = 'https://dl.im.codes' as const;
export const DAEMON_R2_MANIFEST_FILENAME = 'latest.json' as const;
export const DAEMON_R2_TARBALL_FILENAME = 'imcodes-latest.tgz' as const;
export const DAEMON_R2_CHANNEL_MASTER = 'master' as const;
export const DAEMON_R2_CHANNEL_DEV = 'dev' as const;

export type DaemonR2Channel = typeof DAEMON_R2_CHANNEL_MASTER | typeof DAEMON_R2_CHANNEL_DEV;

export interface DaemonR2NpmManifest {
  version: string;
  channel: DaemonR2Channel;
  filename: typeof DAEMON_R2_TARBALL_FILENAME;
  sha256: string;
  sizeBytes: number;
  unpackedSizeBytes?: number;
  updatedAt?: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/i;
const SAFE_PREFIX_RE = /^[A-Za-z0-9._/-]{1,128}$/;

export function isDaemonDevVersion(version?: string | null): boolean {
  return typeof version === 'string' && version.includes('-dev.');
}

export function resolveDaemonR2Channel(input: {
  targetVersion?: string | null;
  currentVersion?: string | null;
  channel?: string | null;
}): DaemonR2Channel {
  const ch = input.channel?.trim().toLowerCase();
  if (ch === DAEMON_R2_CHANNEL_DEV) return DAEMON_R2_CHANNEL_DEV;
  const target = input.targetVersion?.trim();
  if (target === DAEMON_R2_CHANNEL_DEV) return DAEMON_R2_CHANNEL_DEV;
  if (target && target !== 'latest') {
    return isDaemonDevVersion(target) ? DAEMON_R2_CHANNEL_DEV : DAEMON_R2_CHANNEL_MASTER;
  }
  if (ch === DAEMON_R2_CHANNEL_MASTER || ch === 'latest') return DAEMON_R2_CHANNEL_MASTER;
  return isDaemonDevVersion(input.currentVersion) ? DAEMON_R2_CHANNEL_DEV : DAEMON_R2_CHANNEL_MASTER;
}

export function resolveDaemonR2BaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if ((env.USE_R2_ARTIFACT ?? '').trim().toLowerCase() === 'false') return null;
  if ((env.IMCODES_USE_R2 ?? '').trim().toLowerCase() === 'false') return null;
  const raw = env.CONTROLLED_NODE_ARTIFACT_R2_BASE_URL?.trim();
  if (!raw) return DEFAULT_DAEMON_R2_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeR2Prefix(raw?: string): string | null {
  const trimmed = raw?.trim().replace(/^\/+|\/+$/g, '') ?? '';
  if (!trimmed) return '';
  if (!SAFE_PREFIX_RE.test(trimmed) || trimmed.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    return null;
  }
  return `${trimmed}/`;
}

export function daemonR2NpmBaseUrl(
  baseUrl: string,
  channel: DaemonR2Channel,
  envPrefix: string | undefined = process.env.CONTROLLED_NODE_ARTIFACT_R2_PREFIX,
): string | null {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, '');
  const prefix = normalizeR2Prefix(envPrefix);
  if (prefix === null) return null;
  return `${normalizedBase}/${prefix}${channel}/npm`;
}

export function daemonR2ManifestUrl(
  baseUrl: string,
  channel: DaemonR2Channel,
  envPrefix?: string,
): string | null {
  const npmBase = daemonR2NpmBaseUrl(baseUrl, channel, envPrefix);
  return npmBase ? `${npmBase}/${DAEMON_R2_MANIFEST_FILENAME}` : null;
}

export function daemonR2TarballUrl(
  baseUrl: string,
  channel: DaemonR2Channel,
  envPrefix?: string,
): string | null {
  const npmBase = daemonR2NpmBaseUrl(baseUrl, channel, envPrefix);
  return npmBase ? `${npmBase}/${DAEMON_R2_TARBALL_FILENAME}` : null;
}

export function parseDaemonR2Manifest(raw: unknown): DaemonR2NpmManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === 'string' ? obj.version.trim() : '';
  if (!version) return null;
  if (obj.channel !== DAEMON_R2_CHANNEL_MASTER && obj.channel !== DAEMON_R2_CHANNEL_DEV) return null;
  if (obj.filename !== DAEMON_R2_TARBALL_FILENAME) return null;
  if (typeof obj.sha256 !== 'string' || !SHA256_RE.test(obj.sha256)) return null;
  if (typeof obj.sizeBytes !== 'number' || !Number.isSafeInteger(obj.sizeBytes) || obj.sizeBytes <= 0) {
    return null;
  }
  let unpackedSizeBytes: number | undefined;
  if (obj.unpackedSizeBytes !== undefined) {
    if (
      typeof obj.unpackedSizeBytes !== 'number'
      || !Number.isSafeInteger(obj.unpackedSizeBytes)
      || obj.unpackedSizeBytes <= 0
    ) {
      return null;
    }
    unpackedSizeBytes = obj.unpackedSizeBytes;
  }
  return {
    version,
    channel: obj.channel,
    filename: DAEMON_R2_TARBALL_FILENAME,
    sha256: obj.sha256.toLowerCase(),
    sizeBytes: obj.sizeBytes,
    ...(unpackedSizeBytes !== undefined ? { unpackedSizeBytes } : {}),
    ...(typeof obj.updatedAt === 'string' ? { updatedAt: obj.updatedAt } : {}),
  };
}
