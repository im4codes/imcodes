#!/usr/bin/env bash
set -euo pipefail

WORKDIR="${1:-.}"
MAX_ATTEMPTS="${CI_NPM_CI_MAX_ATTEMPTS:-3}"

cd "$WORKDIR"

attempt=1
while true; do
  echo "npm ci attempt ${attempt}/${MAX_ATTEMPTS} in ${WORKDIR}"
  if npm ci \
    --fetch-retries=5 \
    --fetch-retry-factor=2 \
    --fetch-retry-mintimeout=2000 \
    --fetch-retry-maxtimeout=30000; then
    break
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "npm ci failed after ${MAX_ATTEMPTS} attempts in ${WORKDIR}" >&2
    exit 1
  fi

  sleep_for=$(( attempt * 5 ))
  echo "npm ci failed in ${WORKDIR}; retrying in ${sleep_for}s..." >&2
  sleep "$sleep_for"
  attempt=$(( attempt + 1 ))
done
