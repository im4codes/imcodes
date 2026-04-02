#!/usr/bin/env bash
# Rebuild, relink, and restart the local imcodes daemon service (dev only).
# Usage: ./scripts/restart-daemon.sh
#
# This upgrades the locally linked CLI/daemon from the current checkout:
#   1. install/update deps
#   2. build the repo
#   3. refresh the global npm link
#   4. restart the daemon service without rebuilding again

set -euo pipefail
cd "$(dirname "$0")/.."

npm install
npm run build
npm link --force

imcodes service restart --no-build
