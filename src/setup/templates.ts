/** Embedded deployment templates for `imcodes setup`. */

import {
  ONLYOFFICE_SERVICE_DEFAULTS,
  ONLYOFFICE_SERVICE_ENV,
  ONLYOFFICE_VOLUME_NAMES,
  defaultOnlyOfficePublicUrl,
} from '../../shared/onlyoffice-service.js';
import {
  TURN_RELAY_CAPACITY,
  TURN_SERVICE_DEFAULTS,
  TURN_SERVICE_DENIED_PEER_RANGES,
  TURN_SERVICE_ENV,
  turnRelayCapacityForRange,
  turnRelayNetworkMode,
  turnRelayPortCount,
  type TurnRelayNetworkMode,
  type TurnRelayRangeOrigin,
} from '../../shared/turn-service.js';

export interface TurnDeploymentTemplateConfig {
  enabled: boolean;
  host?: string;
  port?: number;
  externalIp?: string;
  relayMinPort?: number;
  relayMaxPort?: number;
  sharedSecret?: string;
  credentialTtlSeconds?: number;
  /** Decides the network strategy. See turnRelayNetworkMode. */
  rangeOrigin?: TurnRelayRangeOrigin;
  /**
   * The resolved network strategy for this deployment. Written to .env and
   * rendered into the Compose file from the SAME value, so the record and the
   * container can never describe different shapes.
   */
  networkMode?: TurnRelayNetworkMode;
}

export interface OnlyOfficeDeploymentTemplateConfig {
  enabled: boolean;
  jwtSecret?: string;
  publicUrl?: string;
  internalUrl?: string;
  image?: string;
}

/**
 * One answer per deployment, used by every generated file. `.env` persists it
 * and docker-compose.yml renders it; deriving it twice is how the record and
 * the container drift apart.
 */
function deploymentNetworkMode(turn: TurnDeploymentTemplateConfig | undefined): TurnRelayNetworkMode {
  return turn?.networkMode ?? turnRelayNetworkMode({
    relayMinPort: turn?.relayMinPort,
    relayMaxPort: turn?.relayMaxPort,
    rangeOrigin: turn?.rangeOrigin,
  });
}

/**
 * Durable store for superseded controlled-node artifacts.
 *
 * tsk_jgt resolves its retention directory as IMCODES_NODE_EXE_VERSION_DIR, or
 * `<IMCODES_NODE_EXE_DIR>/versions` when unset. The image sets
 * IMCODES_NODE_EXE_DIR=/app/controlled-node-executables, so the default lands
 * inside the image layer and every retained version — plus every install code
 * minted against one — is destroyed the moment the Server image is replaced.
 * Production confirmed the shape: imcodes-im-server-1 ran with no volumes at all.
 *
 * The mount path is deliberately OUTSIDE /app/controlled-node-executables. That
 * directory is replaced wholesale with each image; keeping retained bytes in a
 * separate tree means a new image cannot ship content over them, and the volume
 * is the only thing that persists across replacement.
 */
export const NODE_EXE_VERSION_VOLUME = 'node_exe_versions';
export const NODE_EXE_VERSION_DIR = '/var/lib/imcodes/node-exe-versions';
export const ONLYOFFICE_DATA_VOLUME = ONLYOFFICE_VOLUME_NAMES.DATA;
export const ONLYOFFICE_LOGS_VOLUME = ONLYOFFICE_VOLUME_NAMES.LOGS;

export function dockerComposeTemplate(opts?: {
  ghcrPrefix?: string;
  turn?: TurnDeploymentTemplateConfig;
  turnImage?: string;
  onlyoffice?: OnlyOfficeDeploymentTemplateConfig;
  onlyofficeImage?: string;
}): string {
  const ghcr = opts?.ghcrPrefix ?? 'ghcr.io';
  const turnImage = opts?.turnImage ?? TURN_SERVICE_DEFAULTS.IMAGE;
  const onlyofficeEnabled = opts?.onlyoffice === undefined || opts.onlyoffice.enabled;
  const onlyofficeImage = opts?.onlyoffice?.image ?? opts?.onlyofficeImage ?? ONLYOFFICE_SERVICE_DEFAULTS.IMAGE;
  // Same relay range either way. Bridge mode publishes it; host mode cannot,
  // because Docker turns a published RANGE into one mapping, one proxy and its
  // own DNAT rules PER PORT. See turnRelayNetworkMode for the measured rule.
  const turnNetworkMode = deploymentNetworkMode(opts?.turn);
  const turnRelayPorts = opts?.turn?.relayMinPort !== undefined && opts?.turn?.relayMaxPort !== undefined
    ? turnRelayPortCount(opts.turn.relayMinPort, opts.turn.relayMaxPort)
    : undefined;
  const turnSharedService = `    image: ${turnImage}
    # The pinned image runs as nobody by default, but the REST secret config is
    # deliberately 0600. Start as root only long enough for coturn to read it;
    # proc-user/proc-group in turnserver.conf drop the daemon back to nobody.
    user: "0:0"
    restart: unless-stopped`;
  const turnBridgeService = `
  turn:
${turnSharedService}
    ports:
      - "\${TURN_PORT}:\${TURN_PORT}/udp"
      - "\${TURN_PORT}:\${TURN_PORT}/tcp"
      - "\${TURN_RELAY_MIN_PORT}-\${TURN_RELAY_MAX_PORT}:\${TURN_RELAY_MIN_PORT}-\${TURN_RELAY_MAX_PORT}/udp"
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
      - ./turn-entrypoint.sh:/usr/local/bin/imcodes-turn-entrypoint:ro
    # Docker DNATs a peer's public relay address back to this container's
    # bridge address. Allow only that exact runtime address so two clients on
    # this TURN instance can communicate without opening private subnets.
    entrypoint: ["/bin/sh", "/usr/local/bin/imcodes-turn-entrypoint"]
    command: ["-c", "/etc/coturn/turnserver.conf"]
    labels:
      - com.centurylinklabs.watchtower.scope=imcodes
`;
  const turnHostService = `
  turn:
${turnSharedService}
    # ${turnRelayPorts ?? 'Many'} relay ports. Docker expands a published range into one host
    # mapping, one userland proxy and its own DNAT rules PER PORT, so publishing
    # this range through the bridge produces a multi-megabyte Compose model and
    # a container that takes minutes to start. coturn's own container
    # documentation recommends host networking for large relay ranges, so the
    # range is not published at all: coturn binds the host's interfaces.
    #
    # Two consequences, both deliberate:
    #  1. Docker does NOT open these ports for you. The host firewall must allow
    #     the UDP range itself — the installer summary says so.
    #  2. There is no bridge address to translate, so the container-IP
    #     allowed-peer exception used in bridge mode is absent here. In host mode
    #     "hostname -i" returns a HOST address, which may be private, and
    #     allowing it would re-open exactly what denied-peer-ip exists to block.
    network_mode: host
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
    command: ["-c", "/etc/coturn/turnserver.conf"]
    labels:
      - com.centurylinklabs.watchtower.scope=imcodes
`;
  const turnService = opts?.turn?.enabled
    ? (turnNetworkMode === 'host' ? turnHostService : turnBridgeService)
    : '';
  const onlyofficeService = onlyofficeEnabled
    ? `
  onlyoffice:
    image: ${onlyofficeImage}
    restart: unless-stopped
    environment:
      JWT_ENABLED: "true"
      JWT_SECRET: "\${${ONLYOFFICE_SERVICE_ENV.JWT_SECRET}}"
      JWT_HEADER: "Authorization"
      JWT_IN_BODY: "true"
      WOPI_ENABLED: "false"
    volumes:
      - ${ONLYOFFICE_DATA_VOLUME}:/var/www/onlyoffice/Data
      - ${ONLYOFFICE_LOGS_VOLUME}:/var/log/onlyoffice
`
    : '';
  return `services:
  postgres:
    image: pgvector/pgvector:pg18
    restart: unless-stopped
    environment:
      POSTGRES_DB: imcodes
      POSTGRES_USER: imcodes
      POSTGRES_PASSWORD: "\${POSTGRES_PASSWORD}"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U imcodes -d imcodes"]
      interval: 5s
      timeout: 5s
      retries: 5

  server:
    image: ${ghcr}/im4codes/imcodes:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:19138:19138"
    environment:
      DATABASE_URL: "postgresql://imcodes:\${POSTGRES_PASSWORD}@postgres:5432/imcodes"
      JWT_SIGNING_KEY: "\${JWT_SIGNING_KEY}"
      NODE_ENV: production
      PORT: "19138"
      SERVER_URL: "https://\${DOMAIN}"
      ALLOWED_ORIGINS: "https://\${DOMAIN}"
      WEBAUTHN_RP_ID: "\${WEBAUTHN_RP_ID:-\${DOMAIN}}"
      DEFAULT_ADMIN_PASSWORD: "\${DEFAULT_ADMIN_PASSWORD:-}"
      TRUSTED_PROXIES: "127.0.0.1,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16"
      TURN_ENABLED: "\${TURN_ENABLED:-false}"
      TURN_HOST: "\${TURN_HOST:-}"
      TURN_PORT: "\${TURN_PORT:-}"
      TURN_EXTERNAL_IP: "\${TURN_EXTERNAL_IP:-}"
      TURN_SHARED_SECRET: "\${TURN_SHARED_SECRET:-}"
      TURN_CREDENTIAL_TTL_SECONDS: "\${TURN_CREDENTIAL_TTL_SECONDS:-}"
      TURN_RELAY_MIN_PORT: "\${TURN_RELAY_MIN_PORT:-}"
      TURN_RELAY_MAX_PORT: "\${TURN_RELAY_MAX_PORT:-}"
      ${ONLYOFFICE_SERVICE_ENV.ENABLED}: "\${${ONLYOFFICE_SERVICE_ENV.ENABLED}:-true}"
      ${ONLYOFFICE_SERVICE_ENV.JWT_SECRET}: "\${${ONLYOFFICE_SERVICE_ENV.JWT_SECRET}:-}"
      ${ONLYOFFICE_SERVICE_ENV.PUBLIC_URL}: "\${${ONLYOFFICE_SERVICE_ENV.PUBLIC_URL}:-https://\${DOMAIN}${ONLYOFFICE_SERVICE_DEFAULTS.SUBPATH}}"
      ${ONLYOFFICE_SERVICE_ENV.INTERNAL_URL}: "\${${ONLYOFFICE_SERVICE_ENV.INTERNAL_URL}:-${ONLYOFFICE_SERVICE_DEFAULTS.INTERNAL_URL}}"
      # Retained superseded artifacts live on a named volume, not in the image.
      IMCODES_NODE_EXE_VERSION_DIR: ${NODE_EXE_VERSION_DIR}
    volumes:
      - ${NODE_EXE_VERSION_VOLUME}:${NODE_EXE_VERSION_DIR}
    labels:
      - com.centurylinklabs.watchtower.scope=imcodes
    depends_on:
      postgres:
        condition: service_healthy
${onlyofficeService}
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - server
${turnService}

  watchtower:
    image: nickfedor/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_POLL_INTERVAL: 300
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_SCOPE: imcodes
    # Deliberately unlabelled: an updater inside its own watched scope has to
    # resolve its own image before it can reach the application's, so a slow or
    # unreachable updater registry starves every application update behind it.
    # Watchtower is infrastructure and is updated on purpose, not on a poll.
    command: --scope imcodes

volumes:
  pgdata:
  caddy_data:
  caddy_config:
  ${ONLYOFFICE_DATA_VOLUME}:
  ${ONLYOFFICE_LOGS_VOLUME}:
  # Declared explicitly so an upgrade neither renames nor drops it; existing
  # named volumes above are untouched.
  ${NODE_EXE_VERSION_VOLUME}:
`;
}

/** @deprecated Use dockerComposeTemplate() instead. */
export const DOCKER_COMPOSE_TEMPLATE = dockerComposeTemplate();

/** Caddy ONLYOFFICE route block with static bundle caching and bootstrap revalidation. */
export function onlyofficeCaddyRouteBlock(): string {
  return (
    `\t@onlyoffice_static {\n` +
    `\t\tpath_regexp ^/v?[0-9]+\\.[0-9]+\\.[0-9]+[.-][^/]+/(web-apps|sdkjs|sdkjs-plugins|fonts|dictionaries)/\n` +
    `\t\tnot path /web-apps/apps/api/documents/api.js /web-apps/apps/api/documents/preload.html /web-apps/apps/api/documents/cache-scripts.html */api/documents/api.js */api/documents/preload.html */api/documents/cache-scripts.html\n` +
    `\t}\n` +
    `\t@onlyoffice_bootstrap {\n` +
    `\t\tpath /web-apps/apps/api/documents/api.js /web-apps/apps/api/documents/preload.html /web-apps/apps/api/documents/cache-scripts.html */api/documents/api.js */api/documents/preload.html */api/documents/cache-scripts.html\n` +
    `\t}\n` +
    `\thandle_path ${ONLYOFFICE_SERVICE_DEFAULTS.SUBPATH}/* {\n` +
    `\t\theader @onlyoffice_static >Cache-Control "public, max-age=31536000, immutable"\n` +
    `\t\theader @onlyoffice_bootstrap >Cache-Control "no-cache, must-revalidate"\n` +
    `\t\treverse_proxy onlyoffice:80 {\n` +
    `\t\t\theader_up X-Forwarded-Proto {scheme}\n` +
    `\t\t\theader_up X-Forwarded-Host {host}\n` +
    `\t\t\theader_up X-Forwarded-Prefix ${ONLYOFFICE_SERVICE_DEFAULTS.SUBPATH}\n` +
    `\t\t}\n` +
    `\t}\n`
  );
}

export function caddyfileTemplate(domain: string, opts?: { onlyoffice?: boolean }): string {
  const onlyofficeEnabled = opts?.onlyoffice !== false;
  if (!onlyofficeEnabled) {
    return `${domain} {
\treverse_proxy server:19138
}
`;
  }
  return `${domain} {
${onlyofficeCaddyRouteBlock()}\treverse_proxy server:19138
}
`;
}

export function envTemplate(vars: {
  domain: string;
  postgresPassword: string;
  jwtSigningKey: string;
  adminPassword: string;
  turn?: TurnDeploymentTemplateConfig;
  onlyoffice?: OnlyOfficeDeploymentTemplateConfig;
}): string {
  const turn = vars.turn?.enabled ? `TURN_ENABLED=true
TURN_HOST=${vars.turn.host}
TURN_PORT=${vars.turn.port}
TURN_EXTERNAL_IP=${vars.turn.externalIp}
TURN_SHARED_SECRET=${vars.turn.sharedSecret}
TURN_CREDENTIAL_TTL_SECONDS=${vars.turn.credentialTtlSeconds}
TURN_RELAY_MIN_PORT=${vars.turn.relayMinPort}
TURN_RELAY_MAX_PORT=${vars.turn.relayMaxPort}
${TURN_SERVICE_ENV.RELAY_NETWORK_MODE}=${deploymentNetworkMode(vars.turn)}
` : 'TURN_ENABLED=false\n';
  const onlyofficeEnabled = vars.onlyoffice === undefined ? true : vars.onlyoffice.enabled;
  const onlyofficeJwtSecret = vars.onlyoffice?.jwtSecret ?? '';
  const onlyofficePublicUrl = vars.onlyoffice?.publicUrl ?? defaultOnlyOfficePublicUrl(vars.domain);
  const onlyofficeInternalUrl = vars.onlyoffice?.internalUrl ?? ONLYOFFICE_SERVICE_DEFAULTS.INTERNAL_URL;
  const onlyoffice = `${ONLYOFFICE_SERVICE_ENV.ENABLED}=${onlyofficeEnabled ? 'true' : 'false'}
${ONLYOFFICE_SERVICE_ENV.JWT_SECRET}=${onlyofficeJwtSecret}
${ONLYOFFICE_SERVICE_ENV.PUBLIC_URL}=${onlyofficePublicUrl}
${ONLYOFFICE_SERVICE_ENV.INTERNAL_URL}=${onlyofficeInternalUrl}
`;
  return `DOMAIN=${vars.domain}
POSTGRES_PASSWORD=${vars.postgresPassword}
JWT_SIGNING_KEY=${vars.jwtSigningKey}
DEFAULT_ADMIN_PASSWORD=${vars.adminPassword}
${turn}${onlyoffice}`;
}

export function turnserverConfigTemplate(
  turn: Required<Omit<TurnDeploymentTemplateConfig, 'enabled' | 'rangeOrigin' | 'networkMode'>>,
): string {
  const deniedPeers = TURN_SERVICE_DENIED_PEER_RANGES
    .map((range) => `denied-peer-ip=${range}`)
    .join('\n');
  // coturn 4.15 keeps its CLI disabled by default. Do not emit the deprecated
  // no-cli alias, which the pinned image logs as an error.
  return `listening-port=${turn.port}
fingerprint
use-auth-secret
static-auth-secret=${turn.sharedSecret}
proc-user=nobody
proc-group=nogroup
realm=${turn.host}
server-name=${turn.host}
external-ip=${turn.externalIp}
min-port=${turn.relayMinPort}
max-port=${turn.relayMaxPort}
stale-nonce=600
# Per-credential safety limit: a distinct question from the deployment total.
user-quota=${TURN_RELAY_CAPACITY.USER_QUOTA_ALLOCATIONS}
# Read back OUT of the configured relay range, so coturn can never be told it
# may hold more concurrent allocations than it has relay ports to bind, nor
# fewer than the ports this deployment published and opened in its firewall.
total-quota=${turnRelayCapacityForRange(turn.relayMinPort, turn.relayMaxPort)}
no-tls
no-dtls
no-tcp-relay
no-multicast-peers
${deniedPeers}
denied-peer-ip=${turn.externalIp}-${turn.externalIp}
# allowed-peer-ip takes precedence over denied-peer-ip. This exact self-host
# exception is required when both WebRTC endpoints use this TURN relay.
allowed-peer-ip=${turn.externalIp}-${turn.externalIp}
`;
}

/**
 * Resolve the coturn container's current bridge IPv4 at each start. Docker may
 * change it after a recreate, so baking the address into turnserver.conf would
 * make relay-to-relay traffic fail again later.
 */
export function turnEntrypointTemplate(): string {
  return `#!/bin/sh
set -eu

turn_container_ipv4="$(hostname -i | awk '
  {
    for (i = 1; i <= NF; i++) {
      count = split($i, octets, ".")
      valid = count == 4
      for (j = 1; valid && j <= 4; j++) {
        valid = octets[j] ~ /^[0-9]+$/ && octets[j] >= 0 && octets[j] <= 255
      }
      if (valid) {
        print $i
        exit
      }
    }
  }
')"

if [ -z "$turn_container_ipv4" ]; then
  echo "Unable to determine coturn container IPv4" >&2
  exit 1
fi

exec docker-entrypoint.sh "$@" \
  --allowed-peer-ip="\${turn_container_ipv4}-\${turn_container_ipv4}"
`;
}
