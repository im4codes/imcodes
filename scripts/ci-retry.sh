#!/usr/bin/env bash
# Run a command with a hard time limit per attempt and a bounded number of attempts.
#
# usage: ci-retry.sh <max-attempts> <attempt-timeout-seconds> <command> [args...]
#
# A step that waits on the network (apt, a browser download) can stall without
# failing, and a stalled step holds the whole run's concurrency group until
# GitHub's 6 h job limit. Here a stalled attempt is killed and tried again, and
# the last failure is the step's exit code.
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: ci-retry.sh <max-attempts> <attempt-timeout-seconds> <command> [args...]" >&2
  exit 2
fi
MAX_ATTEMPTS="$1"
ATTEMPT_TIMEOUT="$2"
shift 2
case "$MAX_ATTEMPTS$ATTEMPT_TIMEOUT" in *[!0-9]*|'') echo "ci-retry.sh: attempts and timeout must be positive integers" >&2; exit 2;; esac
if ! command -v timeout >/dev/null 2>&1; then
  echo "ci-retry.sh: GNU timeout is required" >&2
  exit 2
fi

attempt=1
while true; do
  echo "ci-retry: attempt ${attempt}/${MAX_ATTEMPTS} (limit ${ATTEMPT_TIMEOUT}s): $*"
  status=0
  timeout --kill-after=15 "$ATTEMPT_TIMEOUT" "$@" || status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    echo "ci-retry: attempt ${attempt} timed out after ${ATTEMPT_TIMEOUT}s" >&2
  else
    echo "ci-retry: attempt ${attempt} failed with exit code ${status}" >&2
  fi
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "ci-retry: giving up after ${MAX_ATTEMPTS} attempts" >&2
    exit "$status"
  fi
  # A killed apt/dpkg can leave a half-configured package set; settle it before the retry.
  if [ -n "${CI_RETRY_BETWEEN_ATTEMPTS:-}" ]; then
    eval "$CI_RETRY_BETWEEN_ATTEMPTS" || true
  fi
  sleep "${CI_RETRY_SLEEP_SECONDS:-$(( attempt * 5 ))}"
  attempt=$(( attempt + 1 ))
done
