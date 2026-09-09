export const TURN_SERVICE_ENV = {
  ENABLED: 'TURN_ENABLED',
  HOST: 'TURN_HOST',
  PORT: 'TURN_PORT',
  EXTERNAL_IP: 'TURN_EXTERNAL_IP',
  SHARED_SECRET: 'TURN_SHARED_SECRET',
  CREDENTIAL_TTL_SECONDS: 'TURN_CREDENTIAL_TTL_SECONDS',
  RELAY_MIN_PORT: 'TURN_RELAY_MIN_PORT',
  RELAY_MAX_PORT: 'TURN_RELAY_MAX_PORT',
  /**
   * The deployment's own record of how its TURN container is attached to the
   * network. Persisted because it CANNOT be re-derived: a wide relay range in
   * .env is equally consistent with a historical bridge deployment and a
   * host-networking one, and guessing wrong either republishes tens of
   * thousands of bridge ports or silently moves a running relay off the bridge.
   */
  RELAY_NETWORK_MODE: 'TURN_RELAY_NETWORK_MODE',
} as const;

/**
 * TURN relay capacity: the maximum number of CONCURRENT coturn allocations this
 * deployment is sized for.
 *
 * Not users, not sessions, not transfers. A client holds an allocation only
 * while a relayed route is actually live, and standard coturn binds ONE UDP
 * relay endpoint per allocation — multiplex-peer is deliberately not enabled,
 * so nothing here may assume several allocations can share a port.
 *
 * That 1:1 mapping is the entire reason the number has an upper bound: every
 * concurrent allocation needs a real UDP port published on this node's single
 * public IPv4, and there are only 65535 of those.
 */
export const TURN_RELAY_CAPACITY = {
  /** Fresh installs, interactive and non-interactive alike. */
  DEFAULT_ALLOCATIONS: 100,
  MIN_ALLOCATIONS: 1,
  /**
   * Above this, one node with one public IPv4 is the wrong shape for the
   * problem — the answer is more TURN nodes or more public addresses, not a
   * bigger number here. Never clamped to: an over-large request is refused with
   * that guidance, because silently serving less capacity than asked for is how
   * a relay deployment looks healthy and drops calls under load.
   */
  MAX_ALLOCATIONS: 30_000,
  UDP_PORTS_PER_ALLOCATION: 1,
  /**
   * The derived range is anchored at the top of the port space and grows
   * downward. This is deterministic, it keeps a larger capacity a strict
   * superset of a smaller one, and it is the only way 30000 allocations fit at
   * all: a fixed low start cannot hold them, since 49160 + 30000 - 1 overruns
   * 65535. coturn's own default relay range also ends at 65535.
   */
  RANGE_END_PORT: 65_535,
  /**
   * Per-credential safety limit, so one leaked short-lived credential cannot
   * take the whole deployment. Deliberately NOT the deployment total: it is a
   * different question with a different answer, and conflating the two is what
   * makes a relay either trivially exhaustible or pointlessly capped.
   */
  USER_QUOTA_ALLOCATIONS: 32,
} as const;

/** Why a requested relay capacity was refused. */
export const TURN_RELAY_CAPACITY_REJECTION = {
  NOT_A_POSITIVE_INTEGER: 'relay_capacity_not_a_positive_integer',
  BELOW_MIN: 'relay_capacity_below_min',
  ABOVE_MAX: 'relay_capacity_above_max',
} as const;

export type TurnRelayCapacityRejection =
  typeof TURN_RELAY_CAPACITY_REJECTION[keyof typeof TURN_RELAY_CAPACITY_REJECTION];

export type TurnRelayCapacityResult =
  | { capacity: number }
  | { rejection: TurnRelayCapacityRejection };

function boundTurnRelayCapacity(value: number): TurnRelayCapacityResult {
  if (value < TURN_RELAY_CAPACITY.MIN_ALLOCATIONS) {
    return { rejection: TURN_RELAY_CAPACITY_REJECTION.BELOW_MIN };
  }
  if (value > TURN_RELAY_CAPACITY.MAX_ALLOCATIONS) {
    return { rejection: TURN_RELAY_CAPACITY_REJECTION.ABOVE_MAX };
  }
  return { capacity: value };
}

/**
 * Parse an answer to the capacity question. An absent answer or an empty line
 * is the documented default; anything else must be an exact integer in range.
 * Never clamps — out-of-range is refused, not quietly reduced.
 */
export function parseTurnRelayCapacity(value: string | number | undefined): TurnRelayCapacityResult {
  if (value === undefined) return { capacity: TURN_RELAY_CAPACITY.DEFAULT_ALLOCATIONS };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { capacity: TURN_RELAY_CAPACITY.DEFAULT_ALLOCATIONS };
    if (!/^\d+$/.test(trimmed)) return { rejection: TURN_RELAY_CAPACITY_REJECTION.NOT_A_POSITIVE_INTEGER };
    return boundTurnRelayCapacity(Number(trimmed));
  }
  if (!Number.isSafeInteger(value)) return { rejection: TURN_RELAY_CAPACITY_REJECTION.NOT_A_POSITIVE_INTEGER };
  return boundTurnRelayCapacity(value);
}

/**
 * What to tell the operator. Shared so the installer, and anything else that
 * ever asks this question, refuse it with the same guidance.
 */
export function turnRelayCapacityRejectionMessage(rejection: TurnRelayCapacityRejection): string {
  const range = `${TURN_RELAY_CAPACITY.MIN_ALLOCATIONS}-${TURN_RELAY_CAPACITY.MAX_ALLOCATIONS}`;
  if (rejection === TURN_RELAY_CAPACITY_REJECTION.ABOVE_MAX) {
    return `TURN relay capacity must be ${range} concurrent relay allocations. `
      + `Standard coturn binds one UDP relay port per allocation, so more than `
      + `${TURN_RELAY_CAPACITY.MAX_ALLOCATIONS} concurrent allocations cannot be published on one node's single `
      + 'public IPv4. Deploy additional TURN nodes, or additional public IPv4 addresses, and let clients pick '
      + 'between them; do not raise this number on one address.';
  }
  return `TURN relay capacity must be a whole number of concurrent relay allocations between ${range}.`;
}

/** The inclusive UDP relay range that serves exactly this many allocations. */
export function turnRelayRangeForCapacity(capacity: number): { relayMinPort: number; relayMaxPort: number } {
  const ports = capacity * TURN_RELAY_CAPACITY.UDP_PORTS_PER_ALLOCATION;
  return {
    relayMinPort: TURN_RELAY_CAPACITY.RANGE_END_PORT - ports + 1,
    relayMaxPort: TURN_RELAY_CAPACITY.RANGE_END_PORT,
  };
}

/**
 * How many concurrent allocations a configured range can actually serve. This
 * is the direction that matters on an upgrade: the range in .env is the
 * deployment's own answer, so the capacity — and coturn's total-quota — are
 * read back OUT of it rather than imposed on it.
 */
export function turnRelayCapacityForRange(relayMinPort: number, relayMaxPort: number): number {
  return Math.floor(
    turnRelayPortCount(relayMinPort, relayMaxPort) / TURN_RELAY_CAPACITY.UDP_PORTS_PER_ALLOCATION,
  );
}

const DEFAULT_TURN_RELAY_RANGE = turnRelayRangeForCapacity(TURN_RELAY_CAPACITY.DEFAULT_ALLOCATIONS);

export const TURN_SERVICE_DEFAULTS = {
  IMAGE: 'coturn/coturn:4.15.0-alpine',
  MIRROR_IMAGE: 'ghcr.nju.edu.cn/coturn/coturn:4.15.0-alpine',
  PORT: 3479,
  // Derived, never a second literal: an .env without an explicit relay range
  // must resolve to exactly the range a fresh install of the same version
  // would have written, or the installer and the runtime are back to
  // describing different ports.
  RELAY_MIN_PORT: DEFAULT_TURN_RELAY_RANGE.relayMinPort,
  RELAY_MAX_PORT: DEFAULT_TURN_RELAY_RANGE.relayMaxPort,
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

/**
 * Why a relay port range was refused. Env var NAMES and shapes only.
 *
 * This exists because the rule had been written twice — once in the installer
 * and once in the server runtime — with different ceilings, so the installer
 * happily wrote a range into .env, coturn and the Docker publish list that the
 * runtime then rejected. One rule, one place, both callers.
 */
export const TURN_RELAY_RANGE_REJECTION = {
  MIN_PORT_INVALID: 'relay_min_port_invalid',
  MAX_PORT_INVALID: 'relay_max_port_invalid',
  INVERTED: 'relay_range_inverted',
  LISTENER_INSIDE_RANGE: 'listener_port_inside_relay_range',
} as const;

export type TurnRelayRangeRejection =
  typeof TURN_RELAY_RANGE_REJECTION[keyof typeof TURN_RELAY_RANGE_REJECTION];

/** How many UDP ports the range covers, inclusive. */
export function turnRelayPortCount(relayMinPort: number, relayMaxPort: number): number {
  return relayMaxPort - relayMinPort + 1;
}

/**
 * The one relay-range rule. `null` means usable.
 *
 * Only PROTOCOL-valid checks reject: a port outside 1-65535, an inverted
 * range, and a listener sitting inside the relay range, which would make coturn
 * fight its own allocations.
 *
 * There is deliberately NO width limit here. The relay range is deployment
 * configuration — the same values that generate coturn's min-port/max-port and
 * the container's published UDP range — and coturn's own default span is 16384
 * ports. A ceiling in application code would be a second source of truth able
 * to refuse a range the TURN service is serving correctly, which is exactly the
 * failure this rule was collapsed into one place to prevent.
 */
export function validateTurnRelayRange(input: {
  port?: number;
  relayMinPort?: number;
  relayMaxPort?: number;
}): TurnRelayRangeRejection | null {
  const { port, relayMinPort, relayMaxPort } = input;
  if (!isTurnServicePort(relayMinPort)) return TURN_RELAY_RANGE_REJECTION.MIN_PORT_INVALID;
  if (!isTurnServicePort(relayMaxPort)) return TURN_RELAY_RANGE_REJECTION.MAX_PORT_INVALID;
  if (relayMinPort > relayMaxPort) return TURN_RELAY_RANGE_REJECTION.INVERTED;
  if (port !== undefined && port >= relayMinPort && port <= relayMaxPort) {
    return TURN_RELAY_RANGE_REJECTION.LISTENER_INSIDE_RANGE;
  }
  return null;
}

/**
 * The same rule, in the shape a caller can use directly: either the validated
 * range or the exact reason it was refused. Returning the numbers is what lets
 * both call sites narrow without re-implementing the presence checks.
 */
export type TurnRelayRangeResult =
  | { relayMinPort: number; relayMaxPort: number }
  | { rejection: TurnRelayRangeRejection };

export function parseTurnRelayRange(input: {
  port?: number;
  relayMinPort?: number;
  relayMaxPort?: number;
}): TurnRelayRangeResult {
  const rejection = validateTurnRelayRange(input);
  if (rejection !== null) return { rejection };
  return { relayMinPort: input.relayMinPort as number, relayMaxPort: input.relayMaxPort as number };
}

/**
 * How the coturn container reaches the network.
 *
 * This is NOT a capacity limit and NOT a validation ceiling. The capacity, the
 * relay range, the published UDP ports and coturn's total-quota are identical
 * either way — this only decides how Docker attaches the container, because
 * bridge mode does not scale to a large relay range:
 *
 * Docker expands a published port RANGE into one host mapping, one proxy and
 * its own DNAT rules PER PORT. A 30000-port relay range resolves to a
 * multi-megabyte Compose model and 30000 mappings, which is why coturn's own
 * container documentation recommends host networking for large relay ranges.
 *
 * The threshold is 1024 for a measured reason: production already runs an
 * explicit 1000-port bridge range successfully, so the known-good shape must
 * stay on the known-good path, and 1024 is the next power of two above it.
 */
export const TURN_RELAY_NETWORK = {
  BRIDGE_PUBLISH_MAX_PORTS: 1_024,
} as const;

export const TURN_RELAY_NETWORK_MODES = ['bridge', 'host'] as const;

export type TurnRelayNetworkMode = typeof TURN_RELAY_NETWORK_MODES[number];

export function isTurnRelayNetworkMode(value: unknown): value is TurnRelayNetworkMode {
  return typeof value === 'string' && (TURN_RELAY_NETWORK_MODES as readonly string[]).includes(value);
}

/**
 * Where a relay range came from, which is what decides whether the network
 * strategy may be chosen for it.
 *
 * `capacity` — the operator answered "how many concurrent allocations", so
 * setup owns the mechanics of delivering them.
 * `configured` — the range is already published to coturn, to Docker and to a
 * firewall, so its shape is preserved exactly, including its network mode.
 */
export type TurnRelayRangeOrigin = 'capacity' | 'configured';

/**
 * The one rule for the network strategy. Both the installer and the generated
 * Compose file call THIS, so they cannot disagree about how the container is
 * attached — the same reason the relay-range rule lives in one place.
 *
 * An unknown range is `bridge`: the legacy shape, and a range that cannot be
 * measured cannot be shown to exceed the threshold.
 */
export function turnRelayNetworkMode(input: {
  relayMinPort?: number;
  relayMaxPort?: number;
  rangeOrigin?: TurnRelayRangeOrigin;
  /**
   * What the deployment previously recorded, from TURN_RELAY_NETWORK_MODE. This
   * is the authority for an existing deployment; absent means legacy, which is
   * bridge by definition because that is the only shape older installers built.
   */
  persistedMode?: TurnRelayNetworkMode;
}): TurnRelayNetworkMode {
  const { relayMinPort, relayMaxPort } = input;
  if (!isTurnServicePort(relayMinPort) || !isTurnServicePort(relayMaxPort)) return 'bridge';
  if (relayMinPort > relayMaxPort) return 'bridge';
  // A range the deployment already publishes keeps the mode it already has.
  // Re-deciding it from the range would be a guess, and both wrong answers are
  // damaging: inferring host from width silently moves a running relay off the
  // bridge (changing who opens the ports — Docker's own DNAT rules today, the
  // host firewall afterwards), while inferring bridge from a host deployment
  // republishes every relay port it was built to avoid publishing.
  if (input.rangeOrigin === 'configured') return input.persistedMode ?? 'bridge';
  return turnRelayPortCount(relayMinPort, relayMaxPort) > TURN_RELAY_NETWORK.BRIDGE_PUBLISH_MAX_PORTS
    ? 'host'
    : 'bridge';
}

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
