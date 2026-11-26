# Real-machine test kit

This kit is the supported way to create disposable daemon/server fixtures on
211, m3 and Windows test machines. Every command requires an owner name and
records a manifest, so teardown and the checker can only remove resources made
by that owner.

## Safety rules

* Use a unique owner (`deck_sub_...` or a CI run id), never `default`.
* Launchers never touch the machine's real profile. The **scoped daemon's own environment** (and only that:
  its process tree, its tmux server, the exec helper and every agent it spawns) gets `IMCODES_HOME` plus the
  agent-CLI guard below: a scoped `HOME` (Windows: `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`), scoped agent homes
  and a tripwire `PATH`. The default daemon, its scheduled task and the machine-wide environment are never
  changed. `HOME` must be scoped: the daemon keeps its session store under `HOME/.imcodes`, not under
  `IMCODES_HOME`, so an unscoped kit daemon would open the machine's real `sessions.sqlite`.
* Linux/macOS use `launcher.sh`; Windows uses `launcher.ps1`. Paths and task names are
  owner-hashed and default daemon snapshots are checked before and after.
* `stack.sh` uses Docker Compose on 211 and plain Docker on m3. All resources
  have a unique project name, capped resources and health checks. It performs a
  15 GB free-space preflight (override with `IMCODES_MIN_FREE_GB`) and removes
  only its labeled image/build cache on teardown.
* Acquire a lease before an exclusive row (`lease.sh acquire ... --exclusive`).
* Set `IMCODES_TEST_KIT_ROOT` and the canonical account-profile path
  `IMCODES_DEFAULT_HOME` explicitly. Kit scripts never read the process home
  variable or tilde shorthand.

## Commands

```bash
test/real-machine/stack.sh up --owner deck_demo --machine 211 \
  --app-version "$APP_VERSION" --registry "$IMCODES_UPGRADE_REGISTRY"
test/real-machine/stack.sh up --owner deck_demo --machine 211 \
  --bind-host 0.0.0.0 --advertise-host 192.168.2.211 --remote-target 201 \
  --build-context /path/to/exact-head
test/real-machine/stack.sh down --owner deck_demo --machine 211
test/real-machine/stack.sh mint-daemon --owner deck_demo --machine 211 \
  --stack /var/tmp/imc-kit-deck_demo/deck_demo/stack.json \
  --out /var/tmp/imc-kit-deck_demo/deck_demo/imcodes-home/server.json
test/real-machine/lease.sh acquire --owner deck_demo --eta '30m' --ttl 3600
test/real-machine/lease.sh renew --owner deck_demo --ttl 3600
test/real-machine/lease.sh release --owner deck_demo
test/real-machine/launcher.sh install --owner deck_demo --machine 211 \
  --bind-link "$BIND_LINK" --package ./imcodes.tgz
test/real-machine/launcher.ps1 -Action install -Owner deck_demo -Machine 201 \
  -StackManifest C:\\imc-stack\\stack.json -Package C:\\imc-stack\\imcodes.tgz
test/real-machine/launcher.sh teardown --owner deck_demo --machine 211
test/real-machine/checker.sh --owner deck_demo --machine 211
IMCODES_TEST_KIT_ROOT=/var/tmp/imc-kit-deck_demo \
IMCODES_DEFAULT_HOME=/home/runner \
  test/real-machine/launcher.sh install --owner deck_demo --machine 211 \
  --stack-manifest /var/tmp/imc-kit-deck_demo/deck_demo/stack.json --package ./imcodes.tgz
test/real-machine/launcher.ps1 -Action status -Owner deck_demo -Machine 201
node test/real-machine/codex-fixture.mjs <<EOF
{"id":1,"method":"session.send"}
EOF
node test/real-machine/load.mjs --base "$WORKER_URL" \
  --server-id "$SERVER_ID" --token "$TOKEN" --session "$SESSION" --rounds 1
```

`stack.sh up` prints `worker_url`, `registry_url`, `bind_link` and its manifest.
For a Windows row, run the stack on 211 with `--bind-host 0.0.0.0` and
`--remote-target 201`; copy the owner manifest to 201 and pass it as
`-StackManifest`. The launcher then uses the runner's advertised worker and
Verdaccio URLs without touching the Windows default daemon. `--build-context`
builds the server image on the target Docker host, so m3 never pulls an
amd64-only `latest` image and always tests the archived exact head.
Set `IMCODES_UPGRADE_REGISTRY` and `APP_VERSION` for upgrade rows; they are
passed to the server container and never committed.

The stack caps PostgreSQL at 1 CPU/1 GiB and the server at 2 CPU/2 GiB with a
256-process limit. PostgreSQL, server and Verdaccio have health checks. `down`
and `checker` use the manifest only and never glob another owner's resources.
`down` recursively stops the manifest daemon and descendants, verifies no owner
process remains before deleting state directories, and `checker` fails on stale
owner home/prefix directories. Foreign live kit daemons are reported as warnings
and never killed by another owner's run. Built images are removed only when both
owner and project labels match; shared or caller-supplied images remain.

## Known traps

* 211 cannot reach services bound to `192.168.2.x`; use m3 for those rows.
* Do not run a foreground SSH daemon; use the detached launcher.
* Never override `USERPROFILE` machine-wide or for the default daemon; the launcher sets it only inside the scoped daemon's own environment.
* Do not publish through the public npm gate; use the stack's Verdaccio URL.
* Never delete a shared `C:\\core-lane-*`, `/tmp/imc-*`, or another owner's
  Docker project. The checker reports foreign resources and leaves them alone.
* The stack and checker fail fast when the host has less than 15 GB free. Do
  not bypass this on shared machines; prune only the owner-labeled resources.

## Proof record

When packaging a checkout for a machine, use `COPYFILE_DISABLE=1 git archive --format=tar.gz --prefix=repo/ HEAD > exact-head.tar.gz`; this prevents macOS `._*` metadata from entering the Docker build context. `stack.sh` rejects any context that still contains `._*` files.

Run `lease.sh`, `stack.sh up`, the OS launcher, `load.mjs`, `checker.sh`, then the matching teardown in one owner-scoped directory. Capture command output in the pair handoff; teardown leaves an owner-scoped report for checker verification; do not commit generated manifests, logs, ports or credentials. The pinned Codex app-server fixture is used for protocol rows; the tiny JSONL fixture is safe to run offline.

The launcher installs the packed daemon with `npm install --ignore-scripts` so
real-machine rows are bounded and cannot run arbitrary package hooks on a shared
host. This intentionally omits native postinstall repair/prebuild steps; the
launcher therefore requires a live foreground daemon lock and fails immediately
if the daemon cannot start. Native PTY/provider behavior is covered by the
separate protocol fixture rows, not by package installation hooks.

`stack.sh up` performs an authenticated `POST /api/auth/register` with an
owner-scoped idempotency key. The returned user id/API key is stored mode 600
in that owner's manifest and printed only as part of the owner handoff. Pass
`testUser.apiKey` to `load.mjs`; its default endpoints are the real
`POST /api/server/:id/session/send` and authenticated
`GET /api/server/:id/timeline/history?sessionName=...` routes.

`codex-app-server-shim.mjs` is vendored byte-for-byte from fixture commit
`c061c505ba3ef5f29473af066d5fa9b9507a2e39` (the exact source is retained in
the kit); it is used for protocol load/restart rows. `codex-fixture.mjs` remains
a tiny offline smoke fixture.

On Windows, run `powershell -File windows-identity-test.ps1` before a row; it is a no-write counterexample proving a USERPROFILE decoy cannot become the default profile.

## Agent-CLI guard (automatic for every kit daemon)

Rule: no real-machine test may launch a real agent CLI (`codex`, `claude`, `gemini`, `opencode`, `qwen`,
`cursor-agent`, `copilot`, `kimi`, ...) against a machine's default home. On 2026-09-30 a scoped daemon whose session
had no `transportConfig.binaryPath` ran `/usr/local/bin/codex` and wrote `/home/k/.codex` twice. The kit now enforces the
rule itself, so nobody has to remember it. `launcher.sh install` / `launcher.ps1 -Action install` do all of this:

1. **Tripwires first on PATH.** `<state>/agent-guard/bin` holds an executable for every agent CLI (`*.cmd` npm-shaped
   shims + `tripwire-<name>.js` on Windows, so the daemon's own resolver lands on them too). A tripwire writes a marker
   (`<state>/agent-guard/markers/<name>.<pid>.<ts>`: argv with secrets masked, the caller chain, an env summary), prints why,
   never runs the real CLI and exits 97.
2. **Scoped homes.** The scoped daemon starts with `HOME` (Windows: `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`) =
   `<state>/agent-home`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, the `XDG_*` dirs, and (POSIX) a private
   `TMUX_TMPDIR`, so its tmux server and panes inherit them. An absolute real CLI that slips past the tripwire
   (e.g. `/usr/local/bin/claude`) can therefore only touch the scoped home.
3. **Assertion before start.** Every scoped path is checked against the canonical profile (`IMCODES_DEFAULT_HOME`): one
   that equals it, contains it, or sits in a real agent dir (`.codex`, `.claude`, ...) aborts the run; after the export
   the environment is checked again (the tripwire dir must be `PATH[0]`).
4. **Watcher.** `guard-watch.mjs` stops the scoped daemon (process tree, private tmux server) the moment a marker appears
   and writes `<state>/tripwire.fired.json`. `checker.*` then fails the run and prints `TRIPWIRE FIRED: <cli> launched by:` with
   the caller chain and marker path. `launcher.* guard-check` prints the same report at any time.
5. **Real agent dirs.** A size/mtime/sha256 inventory of the real agent dirs is taken before and after. A machine whose
   default daemon has live real agent sessions (211 does) writes there all day, so the verdict is attributed: FAIL when the
   machine had no live real agent process at either snapshot (or `IMCODES_KIT_ASSUME_QUIESCENT=1`), or an added/modified
   file contains the owner's state dir; otherwise the diff is printed as INCONCLUSIVE and the tripwire is the authority.

Using it: nothing to do. Pass real fixtures by ABSOLUTE path only.

```bash
# register a fixture CLI; prints the absolute path to use as transportConfig.binaryPath
test/real-machine/launcher.sh fixture --owner deck_demo --machine 211 --name codex --exec /abs/path/to/fixture-codex
test/real-machine/launcher.ps1 -Action fixture -Owner deck_demo -Machine 201 -Name codex -Exec C:\fixtures\codex.exe
# seed a restorable session BEFORE install (the daemon warm-restores it ~100 s after start; then run the checker)
IMCODES_TEST_KIT_ROOT=/var/tmp/imc-kit-deck_demo node test/real-machine/seed-session.mjs \
  --state /var/tmp/imc-kit-deck_demo/deck_demo --name deck_kit_brain --project kit --agent codex-sdk \
  --project-dir /var/tmp/imc-kit-deck_demo/deck_demo/projects/kit [--binary-path <fixture path>]
# install a built checkout in place (no npm install; ~0 disk) instead of --package/--version
test/real-machine/launcher.sh install --owner deck_demo --machine 211 --prebuilt-tree /path/to/built/checkout --server-json ...
test/real-machine/launcher.sh guard-check --owner deck_demo --machine 211
```

Notes and limits:

* Tripwire names live in `agent-guard-tools.mjs` (`AGENT_CLI_NAMES`); add a new agent CLI there and both platforms pick it up.
  Session names in `seed-session.mjs` must not match `shared/test-session-guard.ts` patterns (the store prunes them).
* The guard covers what the scoped daemon starts itself. A daemon restart done by a service manager (a systemd/launchd unit
  written by `bind`) starts from the unit's environment: `bind` runs under the guard, so `PATH` and `HOME` are baked into the
  unit, but `TMUX_TMPDIR` is not. Foreground kit daemons (`--server-json`, the default) inherit the guard across restarts.
* On the current base the startup warm-restore ignores a session's `transportConfig.binaryPath` (`ensureProviderConnected(id, {})`),
  so a restored codex session trips the wire even with a fixture path set; that is the product bug the guard exists to catch.
* Self-tests: `test/real-machine/self-test.sh` (POSIX, includes a fake daemon that trips a wire, a fixture run, a daemon-initiated
  restart and a tmux pane) and `agent-guard-test.ps1 -Root <scoped dir> [-RepoRoot <checkout with node_modules>]` (Windows, needs no daemon).
