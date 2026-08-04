export const TURN_SERVICE_ENV = {
  ENABLED: 'TURN_ENABLED',
  HOST: 'TURN_HOST',
  PORT: 'TURN_PORT',
  EXTERNAL_IP: 'TURN_EXTERNAL_IP',
  SHARED_SECRET: 'TURN_SHARED_SECRET',
  CREDENTIAL_TTL_SECONDS: 'TURN_CREDENTIAL_TTL_SECONDS',
  RELAY_MIN_PORT: 'TURN_RELAY_MIN_PORT',
  RELAY_MAX_PORT: 'TURN_RELAY_MAX_PORT',
} as const;

export const TURN_SERVICE_DEFAULTS = {
  IMAGE: 'coturn/coturn:4.15.0-alpine',
  MIRROR_IMAGE: 'ghcr.nju.edu.cn/coturn/coturn:4.15.0-alpine',
  PORT: 3479,
  RELAY_MIN_PORT: 49_160,
  RELAY_MAX_PORT: 49_200,
  // Keep REST credentials temporary, but longer-lived than the two-hour idle
  // authority window so active transfers can actually extend that window.
  CREDENTIAL_TTL_SECONDS: 24 * 60 * 60,
  LEGACY_CREDENTIAL_TTL_SECONDS: 2 * 60 * 60,
  CREDENTIAL_TTL_MIN_SECONDS: 5 * 60,
  CREDENTIAL_TTL_MAX_SECONDS: 24 * 60 * 60,
  SHARED_SECRET_BYTES: 32,
  SUBJECT_HEX_LENGTH: 24,
  CREDENTIAL_EXPIRY_SAFETY_MS: 60 * 1000,
} as const;

/**
 * TURN is an Internet relay, not a general-purpose UDP bridge into the
 * deployment host's private networks. Keep these ranges out of CreatePermission
 * even when a temporary credential is leaked during its bounded lifetime.
 */
export const TURN_SERVICE_DENIED_PEER_RANGES = [
  '0.0.0.0-0.255.255.255',
  '10.0.0.0-10.255.255.255',
  '100.64.0.0-100.127.255.255',
  '127.0.0.0-127.255.255.255',
  '169.254.0.0-169.254.255.255',
  '172.16.0.0-172.31.255.255',
  '192.168.0.0-192.168.255.255',
  // Do not deny the entire IPv6 address space: coturn normalizes IPv4 peers as
  // ::ffff:a.b.c.d, so a blanket IPv6 range also blocks every IPv4 relay.
  '::1-::1',
  'fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  'fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
] as const;

export interface TurnServiceConfig {
  host: string;
  port: number;
  externalIp: string;
  sharedSecret: string;
  credentialTtlSeconds: number;
  relayMinPort: number;
  relayMaxPort: number;
}

const HOST_RE = /^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isTurnServiceHost(value: unknown): value is string {
  return typeof value === 'string' && HOST_RE.test(value);
}

export function isTurnServiceIpv4(value: unknown): value is string {
  return typeof value === 'string' && IPV4_RE.test(value);
}

export function isTurnServicePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

export function parseTurnServicePort(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return undefined;
  const parsed = Number(value);
  return isTurnServicePort(parsed) ? parsed : undefined;
}
