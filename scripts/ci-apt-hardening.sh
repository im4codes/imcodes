#!/usr/bin/env bash
# Bound every network wait apt makes on a CI runner, so a stalled mirror fails
# (and is retried) in seconds instead of hanging the step. Run it before the
# first apt-get/apt-based command of a job (playwright install --with-deps
# drives apt-get too).
set -euo pipefail

APT_CONF_DIR="${CI_APT_CONF_DIR:-/etc/apt/apt.conf.d}"
CONF="${APT_CONF_DIR}/99ci-network-timeouts"
CONTENT='Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "3";
DPkg::Lock::Timeout "120";'

if [ -n "${CI_APT_CONF_DIR:-}" ]; then
  printf '%s\n' "$CONTENT" > "$CONF"
else
  printf '%s\n' "$CONTENT" | sudo tee "$CONF" >/dev/null
fi
echo "apt network timeouts written to ${CONF}"
