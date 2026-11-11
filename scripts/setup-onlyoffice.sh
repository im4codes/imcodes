#!/usr/bin/env bash
# Non-destructive incremental ONLYOFFICE Document Server add-on installer
# for existing IM.codes deployments (`docker-compose.yml` + `.env`).
set -euo pipefail

TARGET_ARG="${1:-.}"
if [ ! -d "$TARGET_ARG" ]; then
  echo "Error: target directory not found: $TARGET_ARG" >&2
  exit 1
fi
TARGET_DIR="$(cd "$TARGET_ARG" && pwd)"
ENV_FILE="$TARGET_DIR/.env"
COMPOSE_FILE="$TARGET_DIR/docker-compose.yml"
CADDY_FILE="$TARGET_DIR/Caddyfile"

if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is not running or not accessible." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif docker-compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Error: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env not found in $TARGET_DIR. Run ./gen-env.sh <domain> or imcodes setup --domain <domain> first." >&2
  exit 1
fi

read_env_key() {
  local key="$1"
  local file="$2"
  awk -F'=' -v k="$key" '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      eq = index(line, "=")
      if (eq > 0) {
        lhs = substr(line, 1, eq - 1)
        gsub(/[[:space:]]/, "", lhs)
        if (lhs == k) {
          val = substr(line, eq + 1)
          sub(/^[[:space:]]+/, "", val)
          sub(/[[:space:]]+$/, "", val)
          sub(/^["'"'"']/, "", val)
          sub(/["'"'"']$/, "", val)
          print val
        }
      }
    }
  ' "$file" | tail -n 1
}

generate_hex_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

RAW_DOMAIN="$(read_env_key "DOMAIN" "$ENV_FILE")"
CLEAN_DOMAIN="$(printf '%s' "$RAW_DOMAIN" | sed -E 's#^https?://##I; s#/+$##')"
if [ -z "$CLEAN_DOMAIN" ]; then
  echo "Error: DOMAIN is missing or empty in $ENV_FILE." >&2
  exit 1
fi

EXISTING_JWT_SECRET="$(read_env_key "ONLYOFFICE_JWT_SECRET" "$ENV_FILE")"
if [ -n "$EXISTING_JWT_SECRET" ]; then
  ONLYOFFICE_JWT_SECRET="$EXISTING_JWT_SECRET"
else
  ONLYOFFICE_JWT_SECRET="$(generate_hex_32)"
fi

EXISTING_PUBLIC_URL="$(read_env_key "ONLYOFFICE_PUBLIC_URL" "$ENV_FILE")"
if [ -n "$EXISTING_PUBLIC_URL" ]; then
  ONLYOFFICE_PUBLIC_URL="$EXISTING_PUBLIC_URL"
else
  ONLYOFFICE_PUBLIC_URL="https://${CLEAN_DOMAIN}/onlyoffice"
fi

EXISTING_INTERNAL_URL="$(read_env_key "ONLYOFFICE_INTERNAL_URL" "$ENV_FILE")"
if [ -n "$EXISTING_INTERNAL_URL" ]; then
  ONLYOFFICE_INTERNAL_URL="$EXISTING_INTERNAL_URL"
else
  ONLYOFFICE_INTERNAL_URL="http://onlyoffice:80"
fi

TMP_ENV="$(mktemp "$TARGET_DIR/.env.onlyoffice.XXXXXX")"
trap 'rm -f "$TMP_ENV"' EXIT

awk \
  -v enabled="true" \
  -v secret="$ONLYOFFICE_JWT_SECRET" \
  -v pub="$ONLYOFFICE_PUBLIC_URL" \
  -v internal="$ONLYOFFICE_INTERNAL_URL" '
  BEGIN {
    seen_enabled = 0
    seen_secret = 0
    seen_pub = 0
    seen_internal = 0
  }
  {
    line = $0
    trimmed = line
    sub(/^[[:space:]]+/, "", trimmed)
    if (trimmed ~ /^#/ || index(trimmed, "=") == 0) {
      print line
      next
    }
    eq = index(trimmed, "=")
    key = substr(trimmed, 1, eq - 1)
    gsub(/[[:space:]]/, "", key)
    if (key == "ONLYOFFICE_ENABLED") {
      if (!seen_enabled) {
        print "ONLYOFFICE_ENABLED=" enabled
        seen_enabled = 1
      }
      next
    }
    if (key == "ONLYOFFICE_JWT_SECRET") {
      if (!seen_secret) {
        print "ONLYOFFICE_JWT_SECRET=" secret
        seen_secret = 1
      }
      next
    }
    if (key == "ONLYOFFICE_PUBLIC_URL") {
      if (!seen_pub) {
        print "ONLYOFFICE_PUBLIC_URL=" pub
        seen_pub = 1
      }
      next
    }
    if (key == "ONLYOFFICE_INTERNAL_URL") {
      if (!seen_internal) {
        print "ONLYOFFICE_INTERNAL_URL=" internal
        seen_internal = 1
      }
      next
    }
    print line
  }
  END {
    if (!seen_enabled) print "ONLYOFFICE_ENABLED=" enabled
    if (!seen_secret) print "ONLYOFFICE_JWT_SECRET=" secret
    if (!seen_pub) print "ONLYOFFICE_PUBLIC_URL=" pub
    if (!seen_internal) print "ONLYOFFICE_INTERNAL_URL=" internal
  }
' "$ENV_FILE" > "$TMP_ENV"

chmod 600 "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"

if [ ! -f "$COMPOSE_FILE" ]; then
  cat > "$COMPOSE_FILE" <<'EOF'
services:
  postgres:
    image: pgvector/pgvector:pg18
    restart: unless-stopped
    environment:
      POSTGRES_DB: imcodes
      POSTGRES_USER: imcodes
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U imcodes -d imcodes"]
      interval: 5s
      timeout: 5s
      retries: 5

  server:
    image: ghcr.io/im4codes/imcodes:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:19138:19138"
    environment:
      DATABASE_URL: "postgresql://imcodes:${POSTGRES_PASSWORD}@postgres:5432/imcodes"
      JWT_SIGNING_KEY: "${JWT_SIGNING_KEY}"
      NODE_ENV: production
      PORT: "19138"
      SERVER_URL: "https://${DOMAIN}"
      ALLOWED_ORIGINS: "https://${DOMAIN}"
      WEBAUTHN_RP_ID: "${WEBAUTHN_RP_ID:-${DOMAIN}}"
      DEFAULT_ADMIN_PASSWORD: "${DEFAULT_ADMIN_PASSWORD:-}"
      TRUSTED_PROXIES: "127.0.0.1,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16"
      ONLYOFFICE_ENABLED: "${ONLYOFFICE_ENABLED:-true}"
      ONLYOFFICE_JWT_SECRET: "${ONLYOFFICE_JWT_SECRET:-}"
      ONLYOFFICE_PUBLIC_URL: "${ONLYOFFICE_PUBLIC_URL:-https://${DOMAIN}/onlyoffice}"
      ONLYOFFICE_INTERNAL_URL: "${ONLYOFFICE_INTERNAL_URL:-http://onlyoffice:80}"
      IMCODES_NODE_EXE_VERSION_DIR: /var/lib/imcodes/node-exe-versions
    volumes:
      - node_exe_versions:/var/lib/imcodes/node-exe-versions
    labels:
      - com.centurylinklabs.watchtower.scope=imcodes
    depends_on:
      postgres:
        condition: service_healthy

  onlyoffice:
    image: onlyoffice/documentserver:latest
    restart: unless-stopped
    environment:
      JWT_ENABLED: "true"
      JWT_SECRET: "${ONLYOFFICE_JWT_SECRET}"
      JWT_HEADER: "Authorization"
      JWT_IN_BODY: "true"
      WOPI_ENABLED: "false"
    volumes:
      - onlyoffice_data:/var/www/onlyoffice/Data
      - onlyoffice_logs:/var/log/onlyoffice

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
    image: nickfedor/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_POLL_INTERVAL: 300
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_SCOPE: imcodes
    command: --scope imcodes

volumes:
  pgdata:
  caddy_data:
  caddy_config:
  onlyoffice_data:
  onlyoffice_logs:
  node_exe_versions:
EOF
else
  # Ensure server environment has ONLYOFFICE_* variables
  if ! grep -q 'ONLYOFFICE_JWT_SECRET:' "$COMPOSE_FILE"; then
    TMP_COMPOSE="$(mktemp "$TARGET_DIR/.compose.onlyoffice.XXXXXX")"
    awk '
      {
        print $0
        if ($0 ~ /^[[:space:]]*TRUSTED_PROXIES:/ && !inserted_env) {
          print "      ONLYOFFICE_ENABLED: \"${ONLYOFFICE_ENABLED:-true}\""
          print "      ONLYOFFICE_JWT_SECRET: \"${ONLYOFFICE_JWT_SECRET:-}\""
          print "      ONLYOFFICE_PUBLIC_URL: \"${ONLYOFFICE_PUBLIC_URL:-https://${DOMAIN}/onlyoffice}\""
          print "      ONLYOFFICE_INTERNAL_URL: \"${ONLYOFFICE_INTERNAL_URL:-http://onlyoffice:80}\""
          inserted_env = 1
        }
      }
    ' "$COMPOSE_FILE" > "$TMP_COMPOSE"
    mv "$TMP_COMPOSE" "$COMPOSE_FILE"
  fi

  # Ensure onlyoffice service exists
  if ! grep -Eq '^[[:space:]]{2}onlyoffice:[[:space:]]*$' "$COMPOSE_FILE"; then
    TMP_COMPOSE="$(mktemp "$TARGET_DIR/.compose.onlyoffice.XXXXXX")"
    awk '
      {
        if ($0 ~ /^[[:space:]]{2}caddy:[[:space:]]*$/ && !inserted_svc) {
          print "  onlyoffice:"
          print "    image: onlyoffice/documentserver:latest"
          print "    restart: unless-stopped"
          print "    environment:"
          print "      JWT_ENABLED: \"true\""
          print "      JWT_SECRET: \"${ONLYOFFICE_JWT_SECRET}\""
          print "      JWT_HEADER: \"Authorization\""
          print "      JWT_IN_BODY: \"true\""
          print "      WOPI_ENABLED: \"false\""
          print "    volumes:"
          print "      - onlyoffice_data:/var/www/onlyoffice/Data"
          print "      - onlyoffice_logs:/var/log/onlyoffice"
          print ""
          inserted_svc = 1
        }
        print $0
      }
    ' "$COMPOSE_FILE" > "$TMP_COMPOSE"
    mv "$TMP_COMPOSE" "$COMPOSE_FILE"
  fi

  # Ensure onlyoffice_data and onlyoffice_logs volumes exist
  if ! grep -Eq '^[[:space:]]{2}onlyoffice_data:[[:space:]]*$' "$COMPOSE_FILE"; then
    TMP_COMPOSE="$(mktemp "$TARGET_DIR/.compose.onlyoffice.XXXXXX")"
    awk '
      {
        print $0
        if ($0 ~ /^volumes:[[:space:]]*$/ && !inserted_vols) {
          print "  onlyoffice_data:"
          print "  onlyoffice_logs:"
          inserted_vols = 1
        }
      }
    ' "$COMPOSE_FILE" > "$TMP_COMPOSE"
    mv "$TMP_COMPOSE" "$COMPOSE_FILE"
  fi
fi

if [ ! -f "$CADDY_FILE" ]; then
  cat > "$CADDY_FILE" <<EOF
${CLEAN_DOMAIN} {
	handle_path /onlyoffice/* {
		reverse_proxy onlyoffice:80 {
			header_up X-Forwarded-Proto {scheme}
			header_up X-Forwarded-Host {host}
			header_up X-Forwarded-Prefix /onlyoffice
		}
	}
	reverse_proxy server:19138
}
EOF
elif ! grep -q 'handle_path /onlyoffice/\*' "$CADDY_FILE"; then
  TMP_CADDY="$(mktemp "$TARGET_DIR/.caddy.onlyoffice.XXXXXX")"
  awk '
    {
      if ($0 ~ /reverse_proxy[[:space:]]+server:19138/ && !inserted) {
        print "\thandle_path /onlyoffice/* {"
        print "\t\treverse_proxy onlyoffice:80 {"
        print "\t\t\theader_up X-Forwarded-Proto {scheme}"
        print "\t\t\theader_up X-Forwarded-Host {host}"
        print "\t\t\theader_up X-Forwarded-Prefix /onlyoffice"
        print "\t\t}"
        print "\t}"
        inserted = 1
      }
      print $0
    }
  ' "$CADDY_FILE" > "$TMP_CADDY"
  mv "$TMP_CADDY" "$CADDY_FILE"
fi

echo "Starting ONLYOFFICE Document Server and updating server + Caddy..."
"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d onlyoffice server caddy

echo ""
echo "ONLYOFFICE Document Server is enabled at: ${ONLYOFFICE_PUBLIC_URL}"
