/**
 * The addresses a controlled node may use to reach its server.
 *
 * A node dials the `serverUrl` it was enrolled with. One deployment is often reachable under more than one public origin (a
 * proxy domain next to the direct one), and a network that blocks one of them must not strand the node. The node therefore keeps
 * a short list of ALTERNATE origins -- and never sends its token to an origin that did not come from a trusted source:
 *   - the server itself, in the heartbeat ack of an authenticated connection (`serverUrls`), or
 *   - the machine's root user (`imcodes-node set-server-url`, which writes the same list).
 * An address a local, unprivileged user could influence (another user's daemon config) is never a source.
 */

/** Non-secret state beside the executable: alternate origins, the last origin that authenticated, origins dropped for a while. */
export const CONTROLLED_NODE_ENDPOINTS_FILE = 'server-endpoints.json' as const;
export const CONTROLLED_NODE_ENDPOINTS_FILE_VERSION = 1 as const;
/** Field of the authenticated heartbeat ack that carries the deployment's public origins. */
export const CONTROLLED_NODE_ACK_SERVER_URLS_FIELD = 'serverUrls' as const;
/** Server environment variable: comma-separated public origins of this deployment ("" / unset = advertise nothing). */
export const CONTROLLED_NODE_PUBLIC_URLS_ENV = 'IMCODES_PUBLIC_URLS' as const;

export const CONTROLLED_NODE_ENDPOINTS = {
  /** Alternate origins kept per source (the primary credential origin is extra). */
  MAX_ALTERNATES: 4,
  /** Connection failures in a row on one origin before the node tries the next one. */
  FAILURES_BEFORE_ROTATE: 3,
  /** An origin that failed that many times in a row is left alone for BASE * 2^(rounds-1), up to MAX. */
  COOLDOWN_BASE_MS: 5_000,
  COOLDOWN_MAX_MS: 5 * 60_000,
  /** An origin whose server answered as a different server is not tried again for this long. */
  MISMATCH_DROP_MS: 24 * 60 * 60_000,
  FILE_MAX_BYTES: 16 * 1024,
} as const;

export interface NormalizeEndpointOptions {
  /** Plain http on loopback, for a local development server only. */
  allowLoopbackHttp?: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '127.0.0.1' || normalized === '[::1]';
}

/**
 * The canonical origin of a server address, or null: https only (loopback http for development), no credentials, path, query
 * or fragment. The single definition used by enrollment, the node's endpoint list, the CLI and the server's advertised list.
 */
export function normalizeControlledNodeEndpointOrigin(value: unknown, options: NormalizeEndpointOptions = {}): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  const secure = url.protocol === 'https:';
  const localDev = options.allowLoopbackHttp === true && url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (!secure && !localDev) return null;
  return url.origin;
}

/** A list of origins, each normalized, deduplicated in order, invalid entries dropped, at most `max`. */
export function normalizeControlledNodeEndpointList(
  value: unknown,
  options: NormalizeEndpointOptions & { max?: number } = {},
): string[] {
  if (!Array.isArray(value)) return [];
  const max = options.max ?? CONTROLLED_NODE_ENDPOINTS.MAX_ALTERNATES;
  const out: string[] = [];
  for (const entry of value) {
    const origin = normalizeControlledNodeEndpointOrigin(entry, options);
    if (origin && !out.includes(origin)) out.push(origin);
    if (out.length >= max) break;
  }
  return out;
}

/** The server's advertised origins from its environment value (comma/space separated). */
export function parseControlledNodePublicUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return normalizeControlledNodeEndpointList(raw.split(/[\s,]+/).filter(Boolean));
}

/** Why a controlled node cannot reach its server, as the node itself can tell (no address, no secret). */
export const CONTROLLED_NODE_FAILURE_CLASS = {
  TCP_TIMEOUT: 'tcp_timeout',
  REFUSED: 'refused',
  DNS: 'dns',
  TLS: 'tls',
  RESET: 'reset',
  REJECTED: 'rejected',
  OTHER: 'other',
} as const;
export type ControlledNodeFailureClass = (typeof CONTROLLED_NODE_FAILURE_CLASS)[keyof typeof CONTROLLED_NODE_FAILURE_CLASS];
