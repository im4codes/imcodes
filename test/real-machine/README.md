# Real-machine test kit

This kit is the supported way to create disposable daemon/server fixtures on
211, m3 and Windows test machines. Every command requires an owner name and
records a manifest, so teardown and the checker can only remove resources made
by that owner.

## Safety rules

* Use a unique owner (`deck_sub_...` or a CI run id), never `default`.
* Launchers set **only** `IMCODES_HOME`; they never override `HOME`,
  `USERPROFILE` or `APPDATA`.
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
* Do not override Windows `USERPROFILE`; use `IMCODES_HOME` only.
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
