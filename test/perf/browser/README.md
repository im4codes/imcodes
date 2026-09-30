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
Set `IMC_PERF_SCROLL_JITTER=1` to sample the real `.chat-view` during the
streaming window; the report then fails if `scrollTop` moves backwards or the
bottom gap exceeds 1 px, and records the sample count and maxima in
`results.json`/`summary.md`.
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
## Windows ConPTY shell runs

For a real Windows daemon, run `windows-control-shim.mjs` on the controlled
node and point the browser harness at its HTTP port with
`IMC_PERF_SHELL_CONTROL_URL`. The shim is test-only: `/ready` polls the
authenticated `/api/server/:id/sessions` endpoint, while `/kill` uses
`taskkill /T /F` on the daemon process tree and relaunches the same isolated
daemon. It does not send terminal input or create sessions; those go through
the normal web/server-link/ConPTY path. Set `IMC_PERF_SHELL_PLATFORM=windows`
so command fixtures use `cmd.exe`. Keep the daemon HOME, lock pipe, server
ID/token and ports isolated from the installed controlled node.

## Send-spinner latency and console-sync cost (tsk_cd_send_spinner_console_sync)

Two test-only measurements, each run once per revision with the SAME harness
files so the tables compare like with like.

**Click Send -> the spinner ends (real daemon, real browser).** Uses the `shell`
profile's real daemon and its gated main-thread block hook as a controlled
stall (the owner's "send spins for ~10 s"):

```bash
test/perf/browser/run-send-latency.sh <checkout> <label>   # once per revision
node test/perf/browser/send-latency-compare.mjs <base>/send-latency.json <fixed>/send-latency.json
```

`IMC_PERF_BLOCK_MS` (default 8000) is applied to both the daemon hook and the
spec; the hook is one-shot per daemon lifetime, so several messages are sent
inside that single window. The spec clicks Send in-page so the click and the spinner observer share
one clock, and also records the time of the daemon's `command.ack accepted`.

**Console sync main-thread cost at production scale.** `test/perf/console-sync-bench.mts`
builds a synthetic registry + pair store the size of a real owner machine,
drives the real session registry with the production triggers (pair-activity
resyncs and registry commits) and samples event-loop lag on the same thread:

```bash
BENCH_ROOT=<tree with node_modules> BENCH_SECONDS=60 npx tsx test/perf/console-sync-bench.mts
```

## Stale chat window (tsk_cd_stale_window_newest_first)

`run-stale-window.sh <app-ref> <label> [results-dir]` reopens a chat whose local cache ends long before the live head
on a phone-shaped Chromium (iPhone 13 profile, 4x CPU throttle) against the real server and real SPA. The fake daemon
(`IMC_PERF_HISTORY_FAITHFUL=1`, `IMC_PERF_STALE_SESSION=1`) serves a production-shaped 6,000-event timeline
(`stale-timeline.mjs`; every 9th tool result is 30 KB) exactly as the real daemon serves history (newest `limit` of
`(afterTs, beforeTs)`, text-only on `contentFilter: 'text'`) with `IMC_PERF_HISTORY_LATENCY_MS` (default 250) per request and
logs each request. The spec (`stale-window-open.spec.mjs`) seeds the OLD 150 events into IndexedDB, opens the window and
records: cache paint, newest-message time (`latestAfterCacheMs`, budget 1 s), the daemon's request order (tiny peek first, then
pages walking newest -> oldest), the earlier-messages marker, per-frame layout drift of an on-screen row while pages arrive above
it (reading scenario, <= 1 px) and the bottom gap (pinned scenario, <= 1 px), and whether the local cache ended complete with no
hole recorded. The app revision is archived; only these harness files are overlaid from the current checkout, so the same spec
measures base and head (set `IMC_PERF_STALE_EXPECT_HEAD=0` for a base revision: numbers are recorded, head-only behaviours are
not asserted).
