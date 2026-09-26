#!/usr/bin/env bash
set -euo pipefail

# Canonical load-validation runner. Docker is preferred; --host-capped is the
# bounded fallback. Neither mode may leave a container, burner, or test alive.
# User's final rule: “只要有docker 就可以用 如果还有不用docker 也可以限制cpu制造负载也可以”
# English gloss: prefer Docker; CPU-capped host load is allowed when Docker is
# unavailable. Only uncapped, all-core, or unbounded host load is forbidden.

usage() {
  cat <<'EOF'
Usage: scripts/docker-cpu-limited-test.sh [--docker|--host-capped] [--timeout SECONDS] -- COMMAND [ARG...]

Default: prefer Docker; if its daemon is unreachable, use capped host mode.
Authority: “只要有docker 就可以用 如果还有不用docker 也可以限制cpu制造负载也可以”
(Docker preferred; CPU-capped host fallback allowed; uncapped host load banned.)
Docker: node:22, --cpus=2, --memory=4g, --pids-limit=512, --rm, hard timeout.
Host fallback: <=min(2 cores,25%), <=2 nice -n 19 duty-cycled burners, hard
timeout, kill-on-exit trap, and cleanup verification. Never runs all-core load.
EOF
}

mode=auto
timeout_seconds="${LOAD_TEST_TIMEOUT_SECONDS:-1800}"
while (($#)); do
  case "$1" in
    --docker) mode=docker; shift ;;
    --host-capped) mode=host; shift ;;
    --timeout) timeout_seconds="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    --) shift; break ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done
if (($# == 0)); then echo 'validation command required after --' >&2; exit 64; fi
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then echo 'timeout must be a positive integer' >&2; exit 64; fi

docker_bin="${DOCKER_BIN:-docker}"
container_name="imcodes-load-test-$$-${RANDOM:-0}"
command_pid=''
watchdog_pid=''
burner_pids=()

cleanup() {
  local pid
  [[ -z "$watchdog_pid" ]] || kill "$watchdog_pid" 2>/dev/null || true
  [[ -z "$command_pid" ]] || kill -TERM "$command_pid" 2>/dev/null || true
  for pid in "${burner_pids[@]:-}"; do [[ -z "$pid" ]] || kill -TERM "$pid" 2>/dev/null || true; done
  sleep 0.2
  [[ -z "$command_pid" ]] || kill -KILL "$command_pid" 2>/dev/null || true
  for pid in "${burner_pids[@]:-}"; do [[ -z "$pid" ]] || kill -KILL "$pid" 2>/dev/null || true; done
  [[ -z "$command_pid" ]] || wait "$command_pid" 2>/dev/null || true
  for pid in "${burner_pids[@]:-}"; do [[ -z "$pid" ]] || wait "$pid" 2>/dev/null || true; done
  "$docker_bin" rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

run_with_hard_timeout() {
  "$@" & command_pid=$!
  (
    sleep "$timeout_seconds"
    if kill -0 "$command_pid" 2>/dev/null; then
      echo "load validation hard timeout after ${timeout_seconds}s" >&2
      kill -TERM "$command_pid" 2>/dev/null || true
      sleep 5
      kill -KILL "$command_pid" 2>/dev/null || true
    fi
  ) & watchdog_pid=$!
  local status=0
  wait "$command_pid" || status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  command_pid=''; watchdog_pid=''
  return "$status"
}

docker_ready=false
if command -v "$docker_bin" >/dev/null 2>&1 && "$docker_bin" info >/dev/null 2>&1; then docker_ready=true; fi
if [[ "$mode" == docker && "$docker_ready" != true ]]; then
  echo 'docker daemon not running — choose --host-capped or start Docker; no uncapped fallback' >&2
  exit 69
fi

if [[ "$mode" != host && "$docker_ready" == true ]]; then
  echo 'load-validation mode=docker cap=2 CPUs memory=4g pids=512 timeout='"${timeout_seconds}s"
  quoted=(); printf -v quoted_command '%q ' "$@"
  run_with_hard_timeout "$docker_bin" run --name "$container_name" --rm \
    --cpus=2 --memory=4g --pids-limit=512 \
    --mount "type=bind,src=$PWD,dst=/workspace,readonly" \
    -w /tmp/work node:22 sh -lc \
    "cp -a /workspace/. /tmp/work/ && npm ci && exec ${quoted_command}"
  exit $?
fi

cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)"
[[ "$cores" =~ ^[1-9][0-9]*$ ]] || cores=1
# milli-cores: min(2000, 25% of the machine). Split over at most two workers.
cap_milli=$((cores * 250)); ((cap_milli > 2000)) && cap_milli=2000
burners=$(((cap_milli + 999) / 1000)); ((burners < 1)) && burners=1; ((burners > 2)) && burners=2
duty_milli=$(((cap_milli + burners - 1) / burners)); ((duty_milli > 1000)) && duty_milli=1000
echo "load-validation mode=host-capped cap=${cap_milli}mCPU burners=${burners} duty=${duty_milli}/1000 nice=19 timeout=${timeout_seconds}s"

for ((i=0; i<burners; i++)); do
  nice -n 19 node -e '
    const end = Date.now() + Number(process.argv[1]) * 1000;
    const duty = Number(process.argv[2]) / 1000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < end) {
      const cycle = Date.now();
      const busyUntil = cycle + Math.max(1, Math.floor(100 * duty));
      while (Date.now() < busyUntil) Math.sqrt(Math.random());
      Atomics.wait(sleeper, 0, 0, Math.max(0, 100 - (Date.now() - cycle)));
    }
  ' "$timeout_seconds" "$duty_milli" & burner_pids+=("$!")
done

status=0
run_with_hard_timeout "$@" || status=$?
for pid in "${burner_pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
for pid in "${burner_pids[@]}"; do wait "$pid" 2>/dev/null || true; done
for pid in "${burner_pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then echo "host load cleanup failed for pid $pid" >&2; exit 70; fi
done
burner_pids=()
echo 'load-validation cleanup=verified'
exit "$status"
