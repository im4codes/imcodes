# Many-windows browser performance harness

This harness is intentionally test-only. It drives the real web app against the
compose server with an isolated API key and a protocol-faithful fake daemon; it
never connects to a real/production server. The fake daemon owns authoritative
timeline history and answers history/replay/page backfill requests.

## Run locally or on 211

From the repository root (Node 22+, Chromium, and web dependencies installed):

```bash
IMC_PERF_REVISION=$(git rev-parse HEAD) \
IMC_PERF_DURATION_MS=300000 \
node test/perf/browser/run.mjs
```

For an isolated stack, use the dedicated compose file; it creates PostgreSQL, a
server image serving the real web app (the fixture build is only a health-check
asset and is never used for acceptance), and an isolated-home daemon container. The `harness`
service uses the pinned `mcr.microsoft.com/playwright:v1.62.1-noble` image,
installs the pinned `web/@playwright/test` package, and includes Chromium, so
it does not depend on host Playwright packages or browser binaries:

```bash
set -Eeuo pipefail
trap 'docker compose -f test/perf/browser/docker-compose.yml down -v --remove-orphans' EXIT
docker compose -p imc-perf-$$ -f test/perf/browser/docker-compose.yml up -d --build
IMC_PERF_REVISION=$(git rev-parse HEAD) \
  docker compose -p imc-perf-$$ -f test/perf/browser/docker-compose.yml run --rm harness
```

Set `IMC_PERF_PORT_BASE` (server) and `IMC_PERF_WEB_PORT_BASE` (fixture) to free
host ports and use a unique compose project
name (`-p imc-perf-<label>-<pid>`) for parallel revision runs. The server keeps
port 19138 inside its isolated network; only the host mapping changes.

For the requested 211 run, execute those commands through `ssh k@172.16.253.211
bash -lc '...'` and use a fresh `/tmp/imc-perf-harness-$$` checkout/worktree.
The compose services are CPU, memory, and PID capped; the trap removes
containers, volumes, and temporary files even after a failed run.

## Scenarios and output

The runner opens 20 real-app session windows (5 streaming, 10 backgrounded),
uses a companion tab, restores all windows, toggles a streaming window between
hidden and visible, and measures 500/2,000/8,000-message chats. The seeded load
generator emits 25/s streaming deltas, status bursts, 19–59 KB tool bodies,
state changes, and a final assistant event. The 500/2,000/8,000-message cases
are real app sessions backed by daemon history. `results.json` contains Long
Task, input-delay, FPS/dropped-frame, JS heap, and CDP WebSocket counters plus
correctness checks. `summary.md` applies the plan targets (Long Task p95 <50 ms,
input p95 <100 ms, restore <100 ms, and correctness/backfill convergence).
When `IMCODES_PERF_DEBUG=1` (the compose default), the harness also polls the
compose-only `perf.debug.timeline_metrics` socket frame. Its `serverDebug`
array contains the server's live per-socket `bufferedAmount`, outbound queue
bytes/depth, subscriptions, and cumulative timeline delivery counters; this
is separate from the browser's client-to-server `WebSocket.bufferedAmount`.

The fake daemon implements the browser-facing `session_list`, timeline
subscribe/history/replay/page, and P2P status/list/read/config request-response
surfaces. P2P rows are intentionally empty and config writes are acknowledged
without persistence; no model/provider execution, terminal PTY, or external
capability side effects are stubbed into the acceptance path. The compose-only
JWT carries owner role for the test user so the real app's owner-scoped
capabilities probe is authorized; its signing key and API key are test-only.

## Real tmux Shell scenario

The shell P0 uses a separate `shell` compose profile with a real daemon image
(`real-daemon.Dockerfile`) that contains tmux and the built daemon. It seeds one
isolated shell session, drives the real SPA in Chromium, kills that tmux session
through the profile's control endpoint, and verifies the terminal remains
mounted while recovery runs. Run it with:

```bash
docker compose --profile shell -p imc-shell-$$ \
  -f test/perf/browser/docker-compose.yml up --build --abort-on-container-exit shell-harness
docker compose --profile shell -p imc-shell-$$ \
  -f test/perf/browser/docker-compose.yml down -v --remove-orphans
```

The daemon and browser are isolated to the compose project and never use the
developer's `~/.imcodes` or real sessions. Set `IMC_PERF_SHELL_CONTROL_PORT`
when running more than one profile concurrently.

Re-run against another revision with the same command and set
`IMC_PERF_REVISION`; compare the resulting JSON files for base, dev `42fd64837`,
Cx13 `0c5fa904b`, and Cx20's latest head:

```bash
node test/perf/browser/compare.mjs perf-results/base/results.json perf-results/dev/results.json perf-results/part-b/results.json perf-results/part-c/results.json
```

The one-line command for Cx13/Cx20 is:

```bash
IMC_PERF_BASE_URL=http://127.0.0.1:19138 IMC_PERF_REVISION=$(git rev-parse HEAD) node test/perf/browser/run.mjs
```
