#!/usr/bin/env bash
set -euo pipefail

OWNER=${1:-m3-proof-f064a10c}
ARCHIVE=${2:?usage: m3-proof.sh OWNER ARCHIVE}
[[ "$OWNER" =~ ^[A-Za-z0-9_.:-]{3,96}$ ]] || { echo "invalid owner" >&2; exit 2; }
ROOT="/tmp/imc-kit-${OWNER}"
SRC="$ROOT/repo"
RESULTS="$ROOT/RESULTS.txt"
KIT="$SRC/test/real-machine"
STACK_ROOT="$ROOT/state"

if [[ "${IMCODES_M3_CHILD:-}" != 1 ]]; then
  rm -rf "$ROOT"
  mkdir -p "$ROOT"
  RELAY_LOG="$ROOT/relay.log"
  IMCODES_M3_CHILD=1 python3 - "$0" "$@" >"$RELAY_LOG" 2>&1 </dev/null <<'PY' &
import os, sys
script, *args = sys.argv[1:]
if os.fork():
    os._exit(0)
os.setsid()
if os.fork():
    os._exit(0)
os.execv('/bin/bash', ['/bin/bash', script, *args])
PY
  echo "started pid=$! log=$RELAY_LOG"
  exit 0
fi

mkdir -p "$ROOT" "$STACK_ROOT"
trap '' HUP
exec </dev/null >>"$RESULTS" 2>&1
echo "m3 real-machine kit proof owner=$OWNER started=$(date -u +%FT%TZ)"
echo "archive=$ARCHIVE"

cleanup() {
  set +e
  if [[ -f "$STACK_ROOT/$OWNER/daemon.json" ]]; then
    IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/launcher.sh" teardown --owner "$OWNER" --machine m3
  fi
  if [[ -f "$STACK_ROOT/$OWNER/stack.json" ]]; then
    IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/stack.sh" down --owner "$OWNER" --machine m3
  fi
  if [[ -x "$KIT/stack.sh" ]]; then
    IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/stack.sh" cleanup --owner "$OWNER" --machine m3
  fi
}
trap cleanup EXIT

tar -xzf "$ARCHIVE" -C "$ROOT"
cd "$SRC"
npm ci --ignore-scripts --no-audit --no-fund
npm run build
PACKAGE=$(npm pack --ignore-scripts --silent)
export IMCODES_DEFAULT_HOME="$(node -e "process.stdout.write(require('node:os').userInfo().homedir)")"

# Remove resources left by an interrupted relay before creating this owner.
IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/stack.sh" cleanup --owner "$OWNER" --machine m3

IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/stack.sh" up \
  --owner "$OWNER" --machine m3 --build-context "$SRC" \
  --image "imc-kit/$OWNER:head" --port 24479 --registry-port 24480 \
  --advertise-host 127.0.0.1
MANIFEST="$STACK_ROOT/$OWNER/stack.json"
IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/stack.sh" mint-daemon --owner "$OWNER" --machine m3 \
  --stack "$MANIFEST" --out "$STACK_ROOT/$OWNER/imcodes-home/server.json"
IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/launcher.sh" install \
  --owner "$OWNER" --machine m3 --package "$SRC/$PACKAGE" \
  --server-json "$STACK_ROOT/$OWNER/imcodes-home/server.json"

SID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["serverId"])' "$STACK_ROOT/$OWNER/imcodes-home/server.json")
TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$STACK_ROOT/$OWNER/imcodes-home/server.json")
API_KEY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["testUser"]["apiKey"])' "$MANIFEST")
BASE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["workerUrl"])' "$STACK_ROOT/$OWNER/imcodes-home/server.json")
load_ok=0
for _ in {1..30}; do
  if node "$KIT/load.mjs" --base "$BASE" --server-id "$SID" \
    --session "kit-$OWNER" --server-token "$TOKEN" --token "$API_KEY" --rounds 1; then
    load_ok=1; break
  fi
  sleep 2
done
(( load_ok == 1 )) || { echo 'scoped send/history did not become ready'; exit 1; }
IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/launcher.sh" teardown --owner "$OWNER" --machine m3
IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/stack.sh" down --owner "$OWNER" --machine m3
IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/stack.sh" cleanup --owner "$OWNER" --machine m3
IMCODES_TEST_KIT_ROOT="$STACK_ROOT" "$KIT/checker.sh" --owner "$OWNER" --machine m3
echo "m3 real-machine kit proof PASS owner=$OWNER finished=$(date -u +%FT%TZ)"
