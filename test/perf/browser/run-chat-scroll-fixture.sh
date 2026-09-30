#!/usr/bin/env bash
# Run the real-ChatView scroll matrix (chat-scroll-fixture.spec.mjs) against an
# app revision, in the pinned Playwright image (no host browser needed).
#
#   run-chat-scroll-fixture.sh <app-ref> <label> [results-dir]
#
# The app revision is archived first; only the harness spec is overlaid from
# this checkout, so the SAME spec measures base and head. IMC_CHAT_SPEC picks
# the spec (default chat-scroll-fixture.spec.mjs; chat-stream-flicker.spec.mjs
# for the streaming-flicker probe, which writes IMC_FLICKER_OUTPUT). Set
# IMC_CHAT_SCROLL_NO_FAIL=1 to record a failing base without a non-zero exit.
set -euo pipefail
APP_REF="${1:?app ref}"; LABEL="${2:?label}"
ROOT="$(git rev-parse --show-toplevel)"
OUT="${3:-$ROOT/perf-results/chat-scroll-$LABEL}"
RUN_ROOT="${IMC_CHAT_SCROLL_RUN_ROOT:-$HOME/j2work/run-$LABEL-$$}"
IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble"
mkdir -p "$OUT" "$RUN_ROOT"
cleanup() { docker run --rm --user 0:0 -v "$RUN_ROOT:/c" "$IMAGE" bash -lc 'rm -rf /c/* /c/.[!.]*' >/dev/null 2>&1 || true; rm -rf "$RUN_ROOT" 2>/dev/null || true; }
trap cleanup EXIT
git -C "$ROOT" archive "$APP_REF" | tar -xf - -C "$RUN_ROOT"
mkdir -p "$RUN_ROOT/test/perf/browser"
cp "$ROOT/test/perf/browser/chat-scroll-fixture.spec.mjs" "$ROOT/test/perf/browser/chat-stream-flicker.spec.mjs" "$RUN_ROOT/test/perf/browser/"
APP_SHA="$(git -C "$ROOT" rev-parse "$APP_REF")"
exec 9>"${IMC_PERF_LOCK_FILE:-/tmp/imc-perf.lock}"
flock -w "${IMC_PERF_LOCK_WAIT_S:-10800}" 9
docker run --rm --ipc=host --cpuset-cpus="${IMC_PERF_CPUSET:-0-3}" --memory=6g \
  -e GIT_HEAD="$APP_SHA" -e IMC_CHAT_SCROLL_OUTPUT=/out/results.json \
  -e IMC_CHAT_SCROLL_NO_FAIL="${IMC_CHAT_SCROLL_NO_FAIL:-0}" -e IMC_CHAT_SCROLL_PINNED_MS="${IMC_CHAT_SCROLL_PINNED_MS:-20000}" \
  -e IMC_CHAT_SCROLL_CPU="${IMC_CHAT_SCROLL_CPU:-0}" -e IMC_CHAT_SCROLL_CPU_REPS="${IMC_CHAT_SCROLL_CPU_REPS:-1}" -e IMC_CHAT_SCROLL_ONLY="${IMC_CHAT_SCROLL_ONLY:-}" -e IMC_CHAT_SCROLL_LONG_ROWS="${IMC_CHAT_SCROLL_LONG_ROWS:-3000}" -e IMC_PERF_FIXTURE_URL=http://127.0.0.1:4300 -e IMC_FLICKER_OUTPUT=/out/flicker.json -e IMC_FLICKER_MS="${IMC_FLICKER_MS:-20000}" -e IMC_FLICKER_ONLY="${IMC_FLICKER_ONLY:-}" -e IMC_FLICKER_NO_FAIL="${IMC_FLICKER_NO_FAIL:-0}" -e IMC_FLICKER_REDUCED_MOTION="${IMC_FLICKER_REDUCED_MOTION:-0}" \
  -v "$RUN_ROOT:/repo" -v "$OUT:/out" -w /repo "$IMAGE" bash -lc '
    set -e
    cd web
    npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
    npm run build:fixtures >/dev/null 2>&1
    (npm run serve:fixtures -- --host 127.0.0.1 >/tmp/serve.log 2>&1 &)
    for i in $(seq 1 60); do curl -sf http://127.0.0.1:4300/src/fixtures/chat-timeline/index.html >/dev/null && break; sleep 1; done
    cd /repo
    node test/perf/browser/${IMC_CHAT_SPEC:-chat-scroll-fixture.spec.mjs}
  ' 2>&1 | tee "$OUT/run.log"
