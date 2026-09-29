#!/usr/bin/env bash
# One revision of the send-latency scenario (test-only, isolated compose stack).
#   test/perf/browser/run-send-latency.sh <checkout-dir> <label> [results-dir]
# Run it once per revision with the SAME harness files, then compare:
#   node test/perf/browser/send-latency-compare.mjs <base>/send-latency.json <fixed>/send-latency.json
set -Eeuo pipefail
CHECKOUT=$(cd "${1:?checkout dir}" && pwd)
LABEL=${2:?label}
RESULTS=${3:-$CHECKOUT/perf-results/$LABEL}
mkdir -p "$RESULTS"
BLOCK_MS=${IMC_PERF_BLOCK_MS:-8000}
PROJECT="imc-lat-$LABEL-$$"
COMPOSE=(docker compose -p "$PROJECT" -f "$CHECKOUT/test/perf/browser/docker-compose.yml" --profile shell)
export IMC_PERF_REVISION=$LABEL
export IMC_PERF_BLOCK_MS=$BLOCK_MS
export IMC_PERF_CORE_LANE_BLOCK_MS=$BLOCK_MS
export IMC_PERF_RESULTS_HOST=$RESULTS
export IMC_PERF_PORT_BASE=${IMC_PERF_PORT_BASE:-$((20000 + RANDOM % 2000))}
export IMC_PERF_SHELL_CONTROL_PORT=${IMC_PERF_SHELL_CONTROL_PORT:-$((22000 + RANDOM % 2000))}
cleanup() {
  "${COMPOSE[@]}" exec -T shell-daemon sh -c 'tail -n 400 /tmp/imc-shell-home/.imcodes/logs/daemon.log' > "$RESULTS/daemon-tail.log" 2>&1 || true
  "${COMPOSE[@]}" down -v --remove-orphans || true
}
trap cleanup EXIT
"${COMPOSE[@]}" up -d --build server shell-daemon
for _ in $(seq 1 240); do
  if curl -fsS "http://127.0.0.1:$IMC_PERF_SHELL_CONTROL_PORT/ready" >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[ "${READY:-0}" = 1 ] || { echo "daemon never became ready" >&2; exit 1; }
"${COMPOSE[@]}" run --rm latency-harness
"${COMPOSE[@]}" exec -T shell-daemon sh -c 'grep "event loop stall" /tmp/imc-shell-home/.imcodes/logs/daemon.log || true' > "$RESULTS/daemon-stalls.log"
echo "results: $RESULTS/send-latency.json  stalls: $(wc -l < "$RESULTS/daemon-stalls.log")"
