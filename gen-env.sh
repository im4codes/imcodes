#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: ./gen-env.sh <domain> [admin-password]"
  echo "Example: ./gen-env.sh imc.example.com"
  exit 1
fi

DOMAIN="$1"
ADMIN_PASSWORD="${2:-$(openssl rand -hex 16)}"
POSTGRES_PASSWORD=$(openssl rand -hex 16)
JWT_SIGNING_KEY=$(openssl rand -hex 32)

cat > .env <<EOF
DOMAIN=${DOMAIN}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SIGNING_KEY=${JWT_SIGNING_KEY}
DEFAULT_ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF

echo "Generated .env for ${DOMAIN}"
echo ""
echo "  Admin login:  admin / ${ADMIN_PASSWORD}"
echo ""
echo "Next: docker compose up -d"
