/** Embedded deployment templates for `imcodes setup`. */

import {
  TURN_SERVICE_DEFAULTS,
  TURN_SERVICE_DENIED_PEER_RANGES,
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
}

export function dockerComposeTemplate(opts?: {
  ghcrPrefix?: string;
  turn?: TurnDeploymentTemplateConfig;
  turnImage?: string;
}): string {
  const ghcr = opts?.ghcrPrefix ?? 'ghcr.io';
  const turnImage = opts?.turnImage ?? TURN_SERVICE_DEFAULTS.IMAGE;
  const turnService = opts?.turn?.enabled ? `
  turn:
    image: ${turnImage}
    # The pinned image runs as nobody by default, but the REST secret config is
    # deliberately 0600. Start as root only long enough for coturn to read it;
    # proc-user/proc-group in turnserver.conf drop the daemon back to nobody.
    user: "0:0"
    restart: unless-stopped
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
` : '';
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
    labels:
      - com.centurylinklabs.watchtower.scope=imcodes
    depends_on:
      postgres:
        condition: service_healthy

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
    labels:
      - com.centurylinklabs.watchtower.scope=imcodes
    command: --scope imcodes

volumes:
  pgdata:
  caddy_data:
  caddy_config:
`;
}

/** @deprecated Use dockerComposeTemplate() instead. */
export const DOCKER_COMPOSE_TEMPLATE = dockerComposeTemplate();

export function caddyfileTemplate(domain: string): string {
  return `${domain} {
\treverse_proxy server:19138
}
`;
}

export function envTemplate(vars: {
  domain: string;
  postgresPassword: string;
  jwtSigningKey: string;
  adminPassword: string;
  turn?: TurnDeploymentTemplateConfig;
}): string {
  const turn = vars.turn?.enabled ? `TURN_ENABLED=true
TURN_HOST=${vars.turn.host}
TURN_PORT=${vars.turn.port}
TURN_EXTERNAL_IP=${vars.turn.externalIp}
TURN_SHARED_SECRET=${vars.turn.sharedSecret}
TURN_CREDENTIAL_TTL_SECONDS=${vars.turn.credentialTtlSeconds}
TURN_RELAY_MIN_PORT=${vars.turn.relayMinPort}
TURN_RELAY_MAX_PORT=${vars.turn.relayMaxPort}
` : 'TURN_ENABLED=false\n';
  return `DOMAIN=${vars.domain}
POSTGRES_PASSWORD=${vars.postgresPassword}
JWT_SIGNING_KEY=${vars.jwtSigningKey}
DEFAULT_ADMIN_PASSWORD=${vars.adminPassword}
${turn}
`;
}

export function turnserverConfigTemplate(turn: Required<Omit<TurnDeploymentTemplateConfig, 'enabled'>>): string {
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
user-quota=32
total-quota=64
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
