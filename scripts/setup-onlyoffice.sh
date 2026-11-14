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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || true)"

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

# ── Retained-artifact staging (pre-check before any config or container replace) ─
LEGACY_DIR="/app/controlled-node-executables/versions"
DURABLE_DIR="/var/lib/imcodes/node-exe-versions"
STAGING_DIR=""
HAS_STAGED_ARTIFACTS=0
TMP_ENV=""
TMP_COMPOSE=""
TMP_CADDY=""

cleanup() {
  [ -n "$TMP_ENV" ] && [ -f "$TMP_ENV" ] && rm -f "$TMP_ENV"
  [ -n "$TMP_COMPOSE" ] && [ -f "$TMP_COMPOSE" ] && rm -f "$TMP_COMPOSE"
  [ -n "$TMP_CADDY" ] && [ -f "$TMP_CADDY" ] && rm -f "$TMP_CADDY"
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    echo "Warning: Script terminated early; retained installers copy preserved at $STAGING_DIR" >&2
  fi
}
trap cleanup EXIT

if [ -f "$COMPOSE_FILE" ]; then
  PS_ERR="$(mktemp "${TMPDIR:-/tmp}/imcodes-ps-err.XXXXXX")"
  if ! SERVER_CIDS_RAW="$("${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -aq server 2>"$PS_ERR")"; then
    ERR_MSG="$(cat "$PS_ERR")"
    rm -f "$PS_ERR"
    echo "Error: Failed to query existing server container via docker compose ps: $ERR_MSG" >&2
    exit 1
  fi
  rm -f "$PS_ERR"

  SERVER_CIDS=()
  while IFS= read -r cid; do
    [ -n "$cid" ] && SERVER_CIDS+=("$cid")
  done <<< "$SERVER_CIDS_RAW"

  if [ "${#SERVER_CIDS[@]}" -gt 1 ]; then
    echo "Error: Refusing to replace server container: ambiguous server containers found: ${SERVER_CIDS[*]}" >&2
    exit 1
  elif [ "${#SERVER_CIDS[@]}" -eq 1 ]; then
    SERVER_CID="${SERVER_CIDS[0]}"
    INSPECT_ERR="$(mktemp "${TMPDIR:-/tmp}/imcodes-inspect-err.XXXXXX")"
    if ! MOUNTS="$(docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' "$SERVER_CID" 2>"$INSPECT_ERR")"; then
      ERR_MSG="$(cat "$INSPECT_ERR")"
      rm -f "$INSPECT_ERR"
      echo "Error: Failed to inspect mounts for server container $SERVER_CID: $ERR_MSG" >&2
      exit 1
    fi
    rm -f "$INSPECT_ERR"

    ALREADY_MOUNTED=0
    while IFS= read -r mdest; do
      if [ "$mdest" = "$DURABLE_DIR" ]; then
        ALREADY_MOUNTED=1
        break
      fi
    done <<< "$MOUNTS"

    if [ "$ALREADY_MOUNTED" -eq 0 ]; then
      STATE_ERR="$(mktemp "${TMPDIR:-/tmp}/imcodes-state-err.XXXXXX")"
      if ! IS_RUNNING="$(docker inspect -f '{{.State.Running}}' "$SERVER_CID" 2>"$STATE_ERR")"; then
        ERR_MSG="$(cat "$STATE_ERR")"
        rm -f "$STATE_ERR"
        echo "Error: Failed to inspect running state for server container $SERVER_CID: $ERR_MSG" >&2
        exit 1
      fi
      rm -f "$STATE_ERR"

      CANDIDATE_STAGING="$(mktemp -d "${TMPDIR:-/tmp}/imcodes-node-exe-versions-XXXXXX")"
      if [ "$IS_RUNNING" = "true" ]; then
        PROBE_ERR="$(mktemp "${TMPDIR:-/tmp}/imcodes-probe-err.XXXXXX")"
        if ! PROBE_OUT="$(docker exec "$SERVER_CID" sh -c "if [ ! -d '$LEGACY_DIR' ]; then echo __imcodes_legacy_versions_absent__; exit 0; fi; ls -A '$LEGACY_DIR'" 2>"$PROBE_ERR")"; then
          ERR_MSG="$(cat "$PROBE_ERR")"
          rm -f "$PROBE_ERR"
          rm -rf "$CANDIDATE_STAGING"
          echo "Error: Failed to probe legacy installer directory in running server container: $ERR_MSG" >&2
          exit 1
        fi
        rm -f "$PROBE_ERR"

        if [ "$PROBE_OUT" != "__imcodes_legacy_versions_absent__" ] && [ -n "$(echo "$PROBE_OUT" | tr -d '[:space:]')" ]; then
          CP_RUNNING_ERR="$(mktemp "${TMPDIR:-/tmp}/imcodes-cp-err.XXXXXX")"
          if ! docker cp "$SERVER_CID:$LEGACY_DIR/." "$CANDIDATE_STAGING/" 2>"$CP_RUNNING_ERR"; then
            ERR_MSG="$(cat "$CP_RUNNING_ERR")"
            rm -f "$CP_RUNNING_ERR"
            rm -rf "$CANDIDATE_STAGING"
            echo "Error: Failed to copy retained Windows installers from running server container: $ERR_MSG" >&2
            exit 1
          fi
          rm -f "$CP_RUNNING_ERR"
          STAGING_DIR="$CANDIDATE_STAGING"
          HAS_STAGED_ARTIFACTS=1
        else
          rm -rf "$CANDIDATE_STAGING"
        fi
      else
        # Stopped container: probe via docker cp
        CP_LOG="$(mktemp "${TMPDIR:-/tmp}/imcodes-cp-stopped.XXXXXX")"
        if docker cp "$SERVER_CID:$LEGACY_DIR/." "$CANDIDATE_STAGING/" 2>"$CP_LOG"; then
          rm -f "$CP_LOG"
          if [ -n "$(ls -A "$CANDIDATE_STAGING" 2>/dev/null)" ]; then
            STAGING_DIR="$CANDIDATE_STAGING"
            HAS_STAGED_ARTIFACTS=1
          else
            rm -rf "$CANDIDATE_STAGING"
          fi
        else
          CP_ERR_TEXT="$(cat "$CP_LOG")"
          rm -f "$CP_LOG"
          if echo "$CP_ERR_TEXT" | grep -Eqi 'no such file or directory|could not find the file|no such container:path'; then
            rm -rf "$CANDIDATE_STAGING"
          else
            echo "Error: Failed to copy retained Windows installers from stopped server container: $CP_ERR_TEXT" >&2
            rm -rf "$CANDIDATE_STAGING"
            exit 1
          fi
        fi
      fi
    fi
  fi
fi

# ── Prepare candidate .env (validate before commit) ───────────────────────────
TMP_ENV="$(mktemp "$TARGET_DIR/.env.onlyoffice.XXXXXX")"
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

if ! grep -q '^ONLYOFFICE_ENABLED=' "$TMP_ENV" || \
   ! grep -q '^ONLYOFFICE_JWT_SECRET=' "$TMP_ENV" || \
   ! grep -q '^ONLYOFFICE_PUBLIC_URL=' "$TMP_ENV" || \
   ! grep -q '^ONLYOFFICE_INTERNAL_URL=' "$TMP_ENV"; then
  echo "Error: Failed to safely write ONLYOFFICE variables to .env" >&2
  rm -f "$TMP_ENV"
  TMP_ENV=""
  exit 1
fi
chmod 600 "$TMP_ENV"

# ── Prepare candidate docker-compose.yml (validate before commit) ─────────────
TMP_COMPOSE="$(mktemp "$TARGET_DIR/.compose.onlyoffice.XXXXXX")"
if [ ! -f "$COMPOSE_FILE" ]; then
  cat > "$TMP_COMPOSE" <<'EOF'
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
  COMPOSE_UPDATED=0

  # Strategy 1: Node.js with yaml package (from local, global, or repository node_modules)
  if command -v node >/dev/null 2>&1; then
    if REPO_YAML="$REPO_ROOT/node_modules/yaml" node -e "
      let yaml;
      try { yaml = require('yaml'); } catch {
        try { yaml = require(process.env.REPO_YAML || ''); } catch { process.exit(1); }
      }
      const { parse, stringify } = yaml;
      const fs = require('fs');
      const content = fs.readFileSync(process.argv[1], 'utf8');
      const doc = parse(content);
      if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') {
        process.exit(1);
      }
      const server = doc.services.server || {};
      const rawEnv = server.environment;
      const envObj = {};
      if (Array.isArray(rawEnv)) {
        for (const entry of rawEnv) {
          if (entry === null || entry === undefined) continue;
          const str = String(entry);
          const eq = str.indexOf('=');
          if (eq !== -1) {
            envObj[str.slice(0, eq)] = str.slice(eq + 1);
          } else {
            envObj[str] = null;
          }
        }
      } else if (rawEnv && typeof rawEnv === 'object') {
        for (const [k, v] of Object.entries(rawEnv)) {
          if (v === null || v === undefined) {
            envObj[k] = null;
          } else {
            envObj[k] = String(v);
          }
        }
      }
      envObj['ONLYOFFICE_ENABLED'] = '\${ONLYOFFICE_ENABLED:-true}';
      envObj['ONLYOFFICE_JWT_SECRET'] = '\${ONLYOFFICE_JWT_SECRET:-}';
      envObj['ONLYOFFICE_PUBLIC_URL'] = '\${ONLYOFFICE_PUBLIC_URL:-https://\${DOMAIN}/onlyoffice}';
      envObj['ONLYOFFICE_INTERNAL_URL'] = '\${ONLYOFFICE_INTERNAL_URL:-http://onlyoffice:80}';
      if (!envObj['IMCODES_NODE_EXE_VERSION_DIR']) {
        envObj['IMCODES_NODE_EXE_VERSION_DIR'] = '/var/lib/imcodes/node-exe-versions';
      }
      server.environment = envObj;

      const serverVolumes = Array.isArray(server.volumes) ? [...server.volumes] : [];
      const versionMount = 'node_exe_versions:/var/lib/imcodes/node-exe-versions';
      const hasVersionMount = serverVolumes.some((v) => {
        if (typeof v === 'string') return v === versionMount;
        if (v && typeof v === 'object') {
          return v.source === 'node_exe_versions' && v.target === '/var/lib/imcodes/node-exe-versions';
        }
        return false;
      });
      if (!hasVersionMount) serverVolumes.push(versionMount);
      server.volumes = serverVolumes;
      doc.services.server = server;

      if (!doc.services.onlyoffice) {
        doc.services.onlyoffice = {
          image: 'onlyoffice/documentserver:latest',
          restart: 'unless-stopped',
          environment: {
            JWT_ENABLED: 'true',
            JWT_SECRET: '\${ONLYOFFICE_JWT_SECRET}',
            JWT_HEADER: 'Authorization',
            JWT_IN_BODY: 'true',
            WOPI_ENABLED: 'false',
          },
          volumes: [
            'onlyoffice_data:/var/www/onlyoffice/Data',
            'onlyoffice_logs:/var/log/onlyoffice',
          ],
        };
      }

      doc.volumes = doc.volumes && typeof doc.volumes === 'object' ? doc.volumes : {};
      if (!('onlyoffice_data' in doc.volumes)) doc.volumes.onlyoffice_data = null;
      if (!('onlyoffice_logs' in doc.volumes)) doc.volumes.onlyoffice_logs = null;
      if (!('node_exe_versions' in doc.volumes)) doc.volumes.node_exe_versions = null;

      fs.writeFileSync(process.argv[2], stringify(doc, { lineWidth: 0 }), 'utf8');
    " "$COMPOSE_FILE" "$TMP_COMPOSE" 2>/dev/null; then
      COMPOSE_UPDATED=1
    fi
  fi

  # Strategy 2: Python 3 with PyYAML
  if [ "$COMPOSE_UPDATED" -eq 0 ] && command -v python3 >/dev/null 2>&1; then
    if python3 -c "
import sys, yaml
compose_file = sys.argv[1]
out_file = sys.argv[2]
with open(compose_file, 'r', encoding='utf8') as f:
    doc = yaml.safe_load(f)
if not doc or not isinstance(doc, dict) or 'services' not in doc or not isinstance(doc['services'], dict):
    sys.exit(1)
server = doc['services'].get('server') or {}
raw_env = server.get('environment')
env_obj = {}
if isinstance(raw_env, list):
    for entry in raw_env:
        if entry is None: continue
        s = str(entry)
        if '=' in s:
            k, v = s.split('=', 1)
            env_obj[k] = v
        else:
            env_obj[s] = None
elif isinstance(raw_env, dict):
    for k, v in raw_env.items():
        if v is None:
            env_obj[k] = None
        else:
            env_obj[k] = str(v)
env_obj['ONLYOFFICE_ENABLED'] = '\${ONLYOFFICE_ENABLED:-true}'
env_obj['ONLYOFFICE_JWT_SECRET'] = '\${ONLYOFFICE_JWT_SECRET:-}'
env_obj['ONLYOFFICE_PUBLIC_URL'] = '\${ONLYOFFICE_PUBLIC_URL:-https://\${DOMAIN}/onlyoffice}'
env_obj['ONLYOFFICE_INTERNAL_URL'] = '\${ONLYOFFICE_INTERNAL_URL:-http://onlyoffice:80}'
if 'IMCODES_NODE_EXE_VERSION_DIR' not in env_obj or not env_obj['IMCODES_NODE_EXE_VERSION_DIR']:
    env_obj['IMCODES_NODE_EXE_VERSION_DIR'] = '/var/lib/imcodes/node-exe-versions'
server['environment'] = env_obj

vols = server.get('volumes')
if not isinstance(vols, list):
    vols = []
version_mount = 'node_exe_versions:/var/lib/imcodes/node-exe-versions'
has_mount = False
for v in vols:
    if v == version_mount:
        has_mount = True
        break
    if isinstance(v, dict) and v.get('source') == 'node_exe_versions' and v.get('target') == '/var/lib/imcodes/node-exe-versions':
        has_mount = True
        break
if not has_mount:
    vols.append(version_mount)
server['volumes'] = vols
doc['services']['server'] = server

if 'onlyoffice' not in doc['services']:
    doc['services']['onlyoffice'] = {
        'image': 'onlyoffice/documentserver:latest',
        'restart': 'unless-stopped',
        'environment': {
            'JWT_ENABLED': 'true',
            'JWT_SECRET': '\${ONLYOFFICE_JWT_SECRET}',
            'JWT_HEADER': 'Authorization',
            'JWT_IN_BODY': 'true',
            'WOPI_ENABLED': 'false',
        },
        'volumes': [
            'onlyoffice_data:/var/www/onlyoffice/Data',
            'onlyoffice_logs:/var/log/onlyoffice',
        ],
    }

top_vols = doc.get('volumes')
if not isinstance(top_vols, dict):
    top_vols = {}
    doc['volumes'] = top_vols
for v in ['onlyoffice_data', 'onlyoffice_logs', 'node_exe_versions']:
    if v not in top_vols:
        top_vols[v] = None

with open(out_file, 'w', encoding='utf8') as f:
    yaml.dump(doc, f, sort_keys=False)
" "$COMPOSE_FILE" "$TMP_COMPOSE" 2>/dev/null; then
      COMPOSE_UPDATED=1
    fi
  fi

  if [ "$COMPOSE_UPDATED" -eq 0 ]; then
    echo "Error: Neither Node.js (with yaml) nor Python 3 (with PyYAML) is available to parse docker-compose.yml safely." >&2
    rm -f "$TMP_COMPOSE"
    TMP_COMPOSE=""
    exit 1
  fi
fi

# Validate updated compose file before replacing
if ! grep -q 'ONLYOFFICE_ENABLED' "$TMP_COMPOSE" || \
   ! grep -q 'ONLYOFFICE_JWT_SECRET' "$TMP_COMPOSE" || \
   ! grep -q 'ONLYOFFICE_PUBLIC_URL' "$TMP_COMPOSE" || \
   ! grep -q 'ONLYOFFICE_INTERNAL_URL' "$TMP_COMPOSE" || \
   ! grep -Eq '^[[:space:]]*onlyoffice:' "$TMP_COMPOSE" || \
   ! grep -q 'onlyoffice_data' "$TMP_COMPOSE" || \
   ! grep -q 'onlyoffice_logs' "$TMP_COMPOSE"; then
  echo "Error: Failed to safely inject ONLYOFFICE configuration into docker-compose.yml" >&2
  rm -f "$TMP_COMPOSE"
  TMP_COMPOSE=""
  exit 1
fi

# ── Prepare candidate Caddyfile (validate before commit) ──────────────────────
if [ ! -f "$CADDY_FILE" ]; then
  TMP_CADDY="$(mktemp "$TARGET_DIR/.caddy.onlyoffice.XXXXXX")"
  cat > "$TMP_CADDY" <<EOF
${CLEAN_DOMAIN} {
	@onlyoffice_static {
		path_regexp ^/v?[0-9]+\.[0-9]+\.[0-9]+[.-][^/]+/(web-apps|sdkjs|sdkjs-plugins|fonts|dictionaries)/
		not path /web-apps/apps/api/documents/api.js /web-apps/apps/api/documents/preload.html /web-apps/apps/api/documents/cache-scripts.html */api/documents/api.js */api/documents/preload.html */api/documents/cache-scripts.html
	}
	@onlyoffice_bootstrap {
		path /web-apps/apps/api/documents/api.js /web-apps/apps/api/documents/preload.html /web-apps/apps/api/documents/cache-scripts.html */api/documents/api.js */api/documents/preload.html */api/documents/cache-scripts.html
	}
	handle_path /onlyoffice/* {
		header @onlyoffice_static {
			match status 2xx 304
			>Cache-Control "public, max-age=31536000, immutable"
		}
		header @onlyoffice_bootstrap {
			match status 2xx 304
			>Cache-Control "no-cache, must-revalidate"
		}
		reverse_proxy onlyoffice:80 {
			header_up X-Forwarded-Proto {scheme}
			header_up X-Forwarded-Host {host}
			header_up X-Forwarded-Prefix /onlyoffice
		}
	}
	reverse_proxy server:19138
}
EOF
elif ! grep -Eq '^[[:space:]]*handle_path[[:space:]]+/onlyoffice/\*' "$CADDY_FILE"; then
  TMP_CADDY="$(mktemp "$TARGET_DIR/.caddy.onlyoffice.XXXXXX")"
  if awk '
    {
      line = $0
      trimmed = line
      sub(/^[[:space:]]+/, "", trimmed)
      if (trimmed ~ /^reverse_proxy([[:space:]]|$)/ && trimmed ~ /19138/ && !inserted) {
        print "\t@onlyoffice_static {"
        print "\t\tpath_regexp ^/v?[0-9]+\\.[0-9]+\\.[0-9]+[.-][^/]+/(web-apps|sdkjs|sdkjs-plugins|fonts|dictionaries)/"
        print "\t\tnot path /web-apps/apps/api/documents/api.js /web-apps/apps/api/documents/preload.html /web-apps/apps/api/documents/cache-scripts.html */api/documents/api.js */api/documents/preload.html */api/documents/cache-scripts.html"
        print "\t}"
        print "\t@onlyoffice_bootstrap {"
        print "\t\tpath /web-apps/apps/api/documents/api.js /web-apps/apps/api/documents/preload.html /web-apps/apps/api/documents/cache-scripts.html */api/documents/api.js */api/documents/preload.html */api/documents/cache-scripts.html"
        print "\t}"
        print "\thandle_path /onlyoffice/* {"
        print "\t\theader @onlyoffice_static {"
        print "\t\t\tmatch status 2xx 304"
        print "\t\t\t>Cache-Control \"public, max-age=31536000, immutable\""
        print "\t\t}"
        print "\t\theader @onlyoffice_bootstrap {"
        print "\t\t\tmatch status 2xx 304"
        print "\t\t\t>Cache-Control \"no-cache, must-revalidate\""
        print "\t\t}"
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
    END {
      if (!inserted) exit 2
    }
  ' "$CADDY_FILE" > "$TMP_CADDY"; then
    : # generated successfully
  else
    echo "Error: could not locate server upstream reverse_proxy (:19138) in $CADDY_FILE to inject ONLYOFFICE proxy" >&2
    rm -f "$TMP_CADDY"
    TMP_CADDY=""
    exit 1
  fi
fi

# ── All candidate configurations validated: commit in-place to preserve inodes ─
if [ -n "$TMP_ENV" ] && [ -f "$TMP_ENV" ]; then
  cat "$TMP_ENV" > "$ENV_FILE"
  rm -f "$TMP_ENV"
  TMP_ENV=""
  chmod 600 "$ENV_FILE"
fi

if [ -n "$TMP_COMPOSE" ] && [ -f "$TMP_COMPOSE" ]; then
  cat "$TMP_COMPOSE" > "$COMPOSE_FILE"
  rm -f "$TMP_COMPOSE"
  TMP_COMPOSE=""
fi

if [ -n "$TMP_CADDY" ] && [ -f "$TMP_CADDY" ]; then
  cat "$TMP_CADDY" > "$CADDY_FILE"
  rm -f "$TMP_CADDY"
  TMP_CADDY=""
fi

# ── Start services and reload Caddy ──────────────────────────────────────────
echo "Starting ONLYOFFICE Document Server and updating server + Caddy..."
"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d onlyoffice server caddy

echo "Reloading Caddy configuration..."
if "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  echo "Caddy configuration reloaded successfully."
else
  echo "Restarting Caddy to apply new configuration..."
  "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" restart caddy
fi

# ── Restore retained Windows installer artifacts if staged ───────────────────
if [ "$HAS_STAGED_ARTIFACTS" -eq 1 ] && [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
  NEW_SERVER_CID="$("${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps -q server 2>/dev/null | head -n 1 || true)"
  RESTORED=0
  if [ -n "$NEW_SERVER_CID" ]; then
    if docker exec "$NEW_SERVER_CID" sh -c "mkdir -p '$DURABLE_DIR'" 2>/dev/null && \
       docker cp "$STAGING_DIR/." "$NEW_SERVER_CID:$DURABLE_DIR/" 2>/dev/null; then
      RESTORED=1
      rm -rf "$STAGING_DIR"
      STAGING_DIR=""
      echo "Retained Windows installers migrated into the durable volume."
    fi
  fi
  if [ "$RESTORED" -eq 0 ]; then
    echo "Warning: Could not migrate retained Windows installers. The only copy is preserved at $STAGING_DIR; copy it into the server's $DURABLE_DIR to keep existing install codes resolvable." >&2
  fi
fi

echo ""
echo "ONLYOFFICE Document Server is enabled at: ${ONLYOFFICE_PUBLIC_URL}"
