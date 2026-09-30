#!/usr/bin/env bash
# One revision of the stale-window scenario (test-only, isolated compose stack, phone-shaped Chromium).
#   test/perf/browser/run-stale-window.sh <app-ref> <label> [results-dir]
# The app revision is archived; ONLY the harness files are overlaid from this checkout, so the SAME spec/fake daemon
# measure base and head. For a base revision set IMC_PERF_STALE_EXPECT_HEAD=0 (record numbers, no pass/fail on the
# head-only behaviours: peek, marker, hole recording).
set -Eeuo pipefail
APP_REF="${1:?app ref}"; LABEL="${2:?label}"
ROOT="$(git rev-parse --show-toplevel)"
RESULTS="${3:-$ROOT/perf-results/stale-window-$LABEL}"
RUN_ROOT="${IMC_STALE_RUN_ROOT:-$HOME/j2work/run-stale-$LABEL-$$}"
mkdir -p "$RESULTS" "$RUN_ROOT"
APP_SHA="$(git -C "$ROOT" rev-parse "$APP_REF")"
git -C "$ROOT" archive "$APP_REF" | tar -xf - -C "$RUN_ROOT"
mkdir -p "$RUN_ROOT/test/perf/browser"
for f in daemon-client.mjs stale-window-open.spec.mjs stale-timeline.mjs perf-auth.mjs docker-compose.yml Dockerfile; do
  cp "$ROOT/test/perf/browser/$f" "$RUN_ROOT/test/perf/browser/$f"
done
PROJECT="imc-stale-$LABEL-$$"
COMPOSE=(docker compose -p "$PROJECT" -f "$RUN_ROOT/test/perf/browser/docker-compose.yml" --profile stale)
export IMC_PERF_REVISION="$LABEL-${APP_SHA:0:9}"
export IMC_PERF_RESULTS_HOST="$RESULTS"
export IMC_PERF_PORT_BASE="${IMC_PERF_PORT_BASE:-$((20000 + RANDOM % 2000))}"
export IMC_PERF_WEB_PORT_BASE="${IMC_PERF_WEB_PORT_BASE:-$((24000 + RANDOM % 2000))}"
export IMC_PERF_HISTORY_FAITHFUL=1 IMC_PERF_STALE_SESSION=1
# One phone, one chat: the default 20-window load would put a dozen other timelines' history requests in the same
# queue and measure that instead of the stale window.
export IMC_PERF_SESSIONS="${IMC_PERF_SESSIONS:-2}"
export IMC_PERF_HISTORY_LATENCY_MS="${IMC_PERF_HISTORY_LATENCY_MS:-250}"
cleanup() {
  "${COMPOSE[@]}" logs --no-color daemon > "$RESULTS/daemon.log" 2>&1 || true
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker run --rm --user 0:0 -v "$RUN_ROOT:/c" mcr.microsoft.com/playwright:v1.62.1-noble bash -lc 'rm -rf /c/* /c/.[!.]*' >/dev/null 2>&1 || true
  rm -rf "$RUN_ROOT" 2>/dev/null || true
}
trap cleanup EXIT
exec 9>"${IMC_PERF_LOCK_FILE:-/tmp/imc-perf.lock}"
flock -w "${IMC_PERF_LOCK_WAIT_S:-10800}" 9
mkdir -p "$RESULTS/stale-window"
"${COMPOSE[@]}" build server
# The shared `daemon` service runs from the image the server service builds, under the fixed tag `browser-server`.
docker tag "$(docker images -q "${PROJECT}-server" | head -1)" browser-server
"${COMPOSE[@]}" up -d server daemon
for _ in $(seq 1 90); do
  "${COMPOSE[@]}" logs daemon 2>/dev/null | grep -q '"connected":true' && break
  sleep 2
done
set +e
"${COMPOSE[@]}" run --rm stale-harness
STATUS=$?
set -e
echo "results: $RESULTS/stale-window/  status=$STATUS"
exit $STATUS
