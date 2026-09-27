#!/usr/bin/env bash
set -euo pipefail

# Reproducible app/harness split runner. The app revision is archived first,
# then only harness-owned files are overlaid from this checkout.
APP_REF="${IMC_PERF_APP_REF:-HEAD}"
ROOT="$(git rev-parse --show-toplevel)"
PID="$$"
RUN_ROOT="${IMC_PERF_RUN_ROOT:-/tmp/imc-perf-${PID}}"
PROJECT="${IMC_PERF_COMPOSE_PROJECT:-imc-perf-${PID}}"
PORT_BASE="${IMC_PERF_PORT_BASE:-19138}"
WEB_PORT_BASE="${IMC_PERF_WEB_PORT_BASE:-4300}"
STALE_HOURS="${IMC_PERF_STALE_HOURS:-6}"
LOCK_FILE="${IMC_PERF_LOCK_FILE:-/tmp/imc-perf.lock}"
LOCK_TIMEOUT_MS="${IMC_PERF_LOCK_TIMEOUT_MS:-900000}"
ALLOW_DIRTY=0
while (($#)); do
  case "$1" in
    --app) APP_REF="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --port-base) PORT_BASE="$2"; shift 2 ;;
    --web-port-base) WEB_PORT_BASE="$2"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    *) echo "usage: $0 [--app <git-ref>] [--project <name>] [--port-base <port>] [--web-port-base <port>]" >&2; exit 2 ;;
  esac
done
exec 9>"$LOCK_FILE"
lock_started_ms="$(date +%s%3N)"
if ! flock -w "$(( (LOCK_TIMEOUT_MS + 999) / 1000 ))" 9; then
  echo "perf harness lock timeout after ${LOCK_TIMEOUT_MS}ms: ${LOCK_FILE}" >&2
  exit 4
fi
lock_wait_ms="$(( $(date +%s%3N) - lock_started_ms ))"
loadavg_before="$(cat /proc/loadavg 2>/dev/null || echo unknown)"
HARNESS_SHA="$(git -C "$ROOT" rev-parse HEAD)"
if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
  if (( ! ALLOW_DIRTY )); then echo "harness checkout is dirty; commit it or pass --allow-dirty" >&2; exit 3; fi
  HARNESS_DIRTY=1
else
  HARNESS_DIRTY=0
fi
# Reap only clearly stale harness containers; active runs remain untouched.
if command -v docker >/dev/null 2>&1; then
  now="$(date +%s)"
  for container in $(docker ps -aq --filter name=imc-perf- 2>/dev/null || true); do
    created="$(docker inspect -f '{{.Created}}' "$container" 2>/dev/null || true)"
    epoch="$(date -d "$created" +%s 2>/dev/null || echo "$now")"
    if (( now - epoch > STALE_HOURS * 3600 )); then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  done
  docker network prune -f >/dev/null 2>&1 || true
fi
rm -rf "$RUN_ROOT"
mkdir -p "$RUN_ROOT/repo"
cleanup_run_root() {
  IMC_PERF_PORT_BASE="$PORT_BASE" IMC_PERF_WEB_PORT_BASE="$WEB_PORT_BASE" \
    docker compose -p "$PROJECT" -f "$RUN_ROOT/repo/test/perf/browser/docker-compose.yml" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  # npm ci/build runs as root in the containers and can leave root-owned files
  # in the bind-mounted checkout.  Give a disposable container one last chance
  # to remove those entries so every exit path really tears down the run root.
  if [[ -d "$RUN_ROOT" ]] && command -v docker >/dev/null 2>&1; then
    docker run --rm --user 0:0 -v "$RUN_ROOT:/cleanup" \
      "$PROJECT-harness:latest" \
      bash -lc 'shopt -s dotglob nullglob; rm -rf /cleanup/*' >/dev/null 2>&1 || true
  fi
  rm -rf "$RUN_ROOT" 2>/dev/null || true
}
trap cleanup_run_root EXIT INT TERM
git -C "$ROOT" archive "$APP_REF" | tar -xf - -C "$RUN_ROOT/repo"
(cd "$ROOT" && tar -cf - test/perf/browser server/Dockerfile web/vite.config.ts) | tar -xf - -C "$RUN_ROOT/repo"
cd "$RUN_ROOT/repo"
export IMC_PERF_PORT_BASE="$PORT_BASE" IMC_PERF_WEB_PORT_BASE="$WEB_PORT_BASE"
export IMC_PERF_HARNESS_SHA="$HARNESS_SHA" IMC_PERF_HARNESS_DIRTY="$HARNESS_DIRTY"
export IMC_PERF_LOCK_WAIT_MS="$lock_wait_ms" IMC_PERF_LOADAVG_BEFORE="$loadavg_before"
ARTIFACT_DIR="${IMC_PERF_ARTIFACT_DIR:-$ROOT/perf-results/$PROJECT}"
mkdir -p "$ARTIFACT_DIR"
export IMC_PERF_RESULTS_HOST="$ARTIFACT_DIR"
docker compose -p "$PROJECT" -f test/perf/browser/docker-compose.yml up -d --build postgres server web daemon
docker compose -p "$PROJECT" -f test/perf/browser/docker-compose.yml run --rm harness
