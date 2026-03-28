/** Embedded deployment templates for `imcodes setup`. */

export function dockerComposeTemplate(opts?: { ghcrPrefix?: string }): string {
  const ghcr = opts?.ghcrPrefix ?? 'ghcr.io';
  return `services:
  postgres:
    image: postgres:16-alpine
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

  watchtower:
    image: containrrr/watchtower
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
}): string {
  return `DOMAIN=${vars.domain}
POSTGRES_PASSWORD=${vars.postgresPassword}
JWT_SIGNING_KEY=${vars.jwtSigningKey}
DEFAULT_ADMIN_PASSWORD=${vars.adminPassword}
`;
}
