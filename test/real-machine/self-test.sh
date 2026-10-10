#!/usr/bin/env bash
set -euo pipefail
KIT_DIR=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/imc-kit-self.XXXXXX")
# Runs on success AND failure: a failed row must not leak daemons, watchers or tmux servers/dirs.
cleanup_self_test() {
  local o
  for o in self-trip self-fixture self-json; do
    IMCODES_TEST_KIT_ROOT="$root/kit" IMCODES_DEFAULT_HOME="$root/default-profile" "$KIT_DIR/launcher.sh" teardown --owner "$o" --machine 211 >/dev/null 2>&1 || true
  done
  for o in self-guard self-trip self-fixture self-json; do
    if declare -F agent_guard_layout >/dev/null; then agent_guard_layout "$root/kit/$o"; [[ "$AG_TMUX" == /tmp/imc-tmx-* ]] && rm -rf "$AG_TMUX"; fi
  done
  python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)" "$root"
}
trap cleanup_self_test EXIT
export IMCODES_KIT_GUARD_SETTLE_SEC=${IMCODES_KIT_GUARD_SETTLE_SEC:-1}
export IMCODES_TEST_LEASE_FILE="$root/lease.json" IMCODES_TEST_KIT_ROOT="$root/kit"
mkdir -p "$root/default-profile/.imcodes"
timestamp=$(python3 -c 'import time; print(int(time.time()*1000))'); [[ "$timestamp" =~ ^[0-9]+$ ]] || { echo 'timestamp portability check failed' >&2; exit 1; }
env -u HOME IMCODES_DEFAULT_HOME="$root/default-profile" "$KIT_DIR/launcher.sh" snapshot-test --owner self-snapshot --machine 211 >/dev/null
# A remote consumer must never be handed a loopback-only stack.  This check is
# intentionally exercised before Docker is touched so it remains deterministic
# on developer machines without a running engine.
if IMCODES_TEST_KIT_ROOT="$root/kit" "$KIT_DIR/stack.sh" up --owner self-remote --machine 211 --remote-target 201 --bind-host 127.0.0.1 >/dev/null 2>&1; then
  echo 'remote loopback preflight was accepted' >&2
  exit 1
fi
python3 - "$root" <<'PY'
import json,os,sys
root=sys.argv[1]; home=os.path.join(root,'imcodes-home'); os.makedirs(home)
lock=os.path.join(home,'daemon.lock.json'); json.dump({'pid':1234,'socketPath':os.path.join(home,'daemon.sock')},open(lock,'w'))
d=json.load(open(lock)); assert d['socketPath'].startswith(home+os.sep) and 'home' not in d
print('macOS-shaped lock fixture: PASS')
PY
fake_bin="$root/fake-bin"; mkdir -p "$fake_bin"
cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  */api/bind/direct*) printf '%s\n' '{"serverId":"srv-self","token":"secret-daemon-token","serverName":"self"}' ;;
  */api/auth/register*) printf '%s\n' '{"userId":"u-self","apiKey":"self-api-key"}' ;;
  *) exit 1 ;;
esac
EOF
chmod 700 "$fake_bin/curl"
cat >"$fake_bin/npm" <<'EOF'
#!/usr/bin/env bash
prefix=
while (($#)); do [[ "$1" == --prefix ]] && { prefix=$2; shift 2; continue; }; shift; done
mkdir -p "$prefix/bin"
cat >"$prefix/bin/imcodes" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == start ]]; then
  sleep 60 & child=$!
  printf '%s\n' "$child" >"$IMCODES_HOME/child.pid"
  python3 - "$IMCODES_HOME" "$$" <<'PY'
import json,sys
home,pid=sys.argv[1:]; json.dump({'pid':int(pid),'home':home},open(home+'/daemon.lock.json','w'))
PY
  trap 'kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 0' TERM INT
  while :; do sleep 1; done
fi
SH
chmod 700 "$prefix/bin/imcodes"
EOF
chmod 700 "$fake_bin/npm"
cat >"$root/stack.json" <<EOF
{"workerUrl":"http://runner:24000","testUser":{"apiKey":"self-api-key"}}
EOF
env PATH="$fake_bin:$PATH" IMCODES_TEST_KIT_ROOT="$root/kit" "$KIT_DIR/stack.sh" mint-daemon --owner self-mint --machine 211 --stack "$root/stack.json" --out "$root/kit/self-mint/imcodes-home/server.json" >"$root/mint.out"
test "$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$root/kit/self-mint/imcodes-home/server.json")" = 600
! grep -q 'secret-daemon-token' "$root/mint.out"
grep -q 'secret-daemon-token' "$root/kit/self-mint/imcodes-home/server.json"
mkdir -p "$root/kit/self-json/imcodes-home"; printf '%s\n' '{"serverId":"srv-self","token":"token-self","workerUrl":"http://runner:24000"}' >"$root/kit/self-json/imcodes-home/server.json"
: >"$root/pkg.tgz"
env -u HOME PATH="$fake_bin:$PATH" IMCODES_DEFAULT_HOME="$root/default-profile" IMCODES_TEST_KIT_ROOT="$root/kit" "$KIT_DIR/launcher.sh" install --owner self-json --machine 211 --package "$root/pkg.tgz" --server-json "$root/kit/self-json/imcodes-home/server.json" >/dev/null
child_pid=$(cat "$root/kit/self-json/imcodes-home/child.pid")
env -u HOME PATH="$fake_bin:$PATH" IMCODES_DEFAULT_HOME="$root/default-profile" IMCODES_TEST_KIT_ROOT="$root/kit" "$KIT_DIR/launcher.sh" teardown --owner self-json --machine 211 >/dev/null
if kill -0 "$child_pid" 2>/dev/null; then echo 'descendant process survived teardown' >&2; exit 1; fi
env -u HOME PATH="$fake_bin:$PATH" IMCODES_DEFAULT_HOME="$root/default-profile" IMCODES_TEST_KIT_ROOT="$root/kit" "$KIT_DIR/checker.sh" --owner self-json --machine 211 >/dev/null
stale="$root/kit/self-stale"; mkdir -p "$stale/imcodes-home" "$stale/prefix"; : >"$stale/default.before"; : >"$stale/default.after"
python3 - "$stale" <<'PY'
import json,sys,os
s=sys.argv[1]; json.dump({'owner':'self-stale','pid':0,'home':os.path.join(s,'imcodes-home'),'prefix':os.path.join(s,'prefix'),'defaultBefore':os.path.join(s,'default.before'),'defaultAfter':os.path.join(s,'default.after')},open(os.path.join(s,'daemon.json'),'w'))
PY
if env IMCODES_TEST_KIT_ROOT="$root/kit" "$KIT_DIR/checker.sh" --owner self-stale --machine 211 >/dev/null 2>&1; then echo 'checker accepted stale owner directories' >&2; exit 1; fi
rm -rf "$stale/imcodes-home" "$stale/prefix"
env IMCODES_TEST_KIT_ROOT="$root/kit" "$KIT_DIR/checker.sh" --owner self-stale --machine 211 >/dev/null
docker_fake="$root/docker-fake"; mkdir -p "$docker_fake"; docker_log="$root/docker.log"
cat >"$docker_fake/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "${FAKE_DOCKER_OWNER_MATCH:-}" == 1 ]]; then
    [[ "$*" == *"Config.Labels"*owner* ]] && printf '%s\n' "$FAKE_DOCKER_OWNER"
    [[ "$*" == *"Config.Labels"*project* ]] && printf '%s\n' "$FAKE_DOCKER_PROJECT"
  else
    printf '%s\n' foreign-owner
  fi
fi
exit 0
DOCKER
chmod 700 "$docker_fake/docker"
mock_state="$root/kit/self-image"; mkdir -p "$mock_state"; cat >"$mock_state/docker-compose.yml" <<'EOF'
services: {}
EOF
mock_project=$(python3 - <<'PY'
import hashlib
print('imc-kit-'+hashlib.sha256(b'self-image:211').hexdigest()[:10])
PY
)
python3 - "$mock_state" "$mock_project" <<'PY'
import json,sys
s,project=sys.argv[1:]; json.dump({'owner':'self-image','machine':'211','project':project,'mode':'compose','image':'shared-cache:latest','imageBuilt':True},open(s+'/stack.json','w'))
PY
: >"$docker_log"
env PATH="$docker_fake:$PATH" FAKE_DOCKER_LOG="$docker_log" IMCODES_TEST_KIT_ROOT="$root/kit" "$KIT_DIR/stack.sh" down --owner self-image --machine 211 >/dev/null 2>&1
! grep -F -- '--rmi local' "$docker_log"
! grep -F -- 'image rm' "$docker_log"
mock_state="$root/kit/self-image-owned"; mkdir -p "$mock_state"; printf '%s\n' 'services: {}' >"$mock_state/docker-compose.yml"
mock_project_owned=$(python3 - <<'PY'
import hashlib
print('imc-kit-'+hashlib.sha256(b'self-image-owned:211').hexdigest()[:10])
PY
)
python3 - "$mock_state" "$mock_project_owned" <<'PY'
import json,sys
s,project=sys.argv[1:]; json.dump({'owner':'self-image-owned','machine':'211','project':project,'mode':'compose','image':'owner-built:latest','imageBuilt':True},open(s+'/stack.json','w'))
PY
: >"$docker_log"
env PATH="$docker_fake:$PATH" FAKE_DOCKER_LOG="$docker_log" FAKE_DOCKER_OWNER_MATCH=1 FAKE_DOCKER_OWNER=self-image-owned FAKE_DOCKER_PROJECT="$mock_project_owned" IMCODES_TEST_KIT_ROOT="$root/kit" "$KIT_DIR/stack.sh" down --owner self-image-owned --machine 211 >/dev/null 2>&1
grep -Fq 'image rm -f owner-built:latest' "$docker_log"
"$KIT_DIR/lease.sh" acquire --owner self-test --ttl 30 >/dev/null
"$KIT_DIR/lease.sh" acquire --owner self-test-two --ttl 30 >/dev/null
if "$KIT_DIR/lease.sh" acquire --owner self-exclusive --ttl 30 --exclusive >/dev/null 2>&1; then echo 'exclusive lease counterexample not rejected' >&2; exit 1; fi
if "$KIT_DIR/lease.sh" renew --owner foreign-owner --ttl 30 >/dev/null 2>&1; then echo 'foreign renew counterexample not rejected' >&2; exit 1; fi
"$KIT_DIR/lease.sh" renew --owner self-test --ttl 30 >/dev/null
"$KIT_DIR/lease.sh" status | grep -q self-test
"$KIT_DIR/lease.sh" release --owner self-test >/dev/null
"$KIT_DIR/lease.sh" release --owner self-test-two >/dev/null
"$KIT_DIR/lease.sh" acquire --owner self-exclusive --ttl 30 --exclusive >/dev/null
"$KIT_DIR/lease.sh" release --owner self-exclusive >/dev/null
printf '{"id":1,"method":"session.send"}\n' | node "$KIT_DIR/codex-fixture.mjs" | grep -q '"ok":true'
for f in "$KIT_DIR"/*.sh; do bash -n "$f"; done
node --check "$KIT_DIR/load.mjs"
node --check "$KIT_DIR/codex-fixture.mjs"
node --check "$KIT_DIR/codex-app-server-shim.mjs"
node --input-type=module - "$KIT_DIR/load.mjs" <<'NODE'
import http from 'node:http';
import { spawn } from 'node:child_process';
import process from 'node:process';
const load=process.argv[2]; let seen=[];
const server=http.createServer((req,res)=>{req.resume(); seen.push({path:req.url,auth:req.headers.authorization,'server-id':req.headers['x-server-id']}); res.writeHead(200,{'content-type':'application/json','connection':'close'}); res.end('{}');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const run=spawn(process.execPath,[load,'--base',`http://127.0.0.1:${port}`,'--server-id','srv','--session','kit-self','--server-token','server-secret','--token','user-secret','--rounds','1'],{stdio:['ignore','pipe','pipe']});
let stdout='',stderr=''; run.stdout.on('data',d=>stdout+=d); run.stderr.on('data',d=>stderr+=d);
const status=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{run.kill('SIGTERM'); reject(new Error('load auth stub timeout'));},5000); run.on('error',reject); run.on('exit',(code,signal)=>{clearTimeout(timer); resolve({code,signal});});});
server.closeAllConnections?.(); server.close(); if(status.code!==0) throw new Error(`load auth stub failed status=${status.code} signal=${status.signal} stdout=${stdout} stderr=${stderr}`);
if(seen.length!==2 || seen[0].auth!=='Bearer server-secret' || seen[0]['server-id']!=='srv' || seen[1].auth!=='Bearer user-secret' || seen[1]['server-id']!==undefined) throw new Error(`unexpected auth wiring: ${JSON.stringify(seen)}`);
console.log('load auth wiring: PASS');
NODE
# ---- agent-CLI guard (tripwire + scoped homes + watcher + inventory) -------------------------------
# shellcheck source=agent-guard.sh
source "$KIT_DIR/agent-guard.sh"
profile="$root/default-profile"; mkdir -p "$profile/.codex/sessions" "$profile/.claude"
printf 'real rollout\n' >"$profile/.codex/sessions/rollout-real.jsonl"
guard_state="$root/kit/self-guard"; mkdir -p "$guard_state"
agent_guard_prepare "$guard_state"
# 1. every agent CLI name resolves to its tripwire once the guard is on PATH, and a tripwire records a caller,
#    masks secrets, never runs a real CLI, and exits 97.
(
  agent_guard_export
  agent_guard_assert "$profile" post
  agent_guard_assert_path_first
  set +e
  bash -c 'codex --api-key=SUPERSECRET1 --token SUPERSECRET2 --model x "line
two"' >"$root/tw.out" 2>"$root/tw.err"; rc=$?
  [[ $rc -eq 97 ]] || { echo "tripwire exit code $rc, expected 97" >&2; exit 1; }
  for n in claude gemini opencode qwen cursor-agent copilot kimi; do "$n" --version >/dev/null 2>&1; [[ $? -eq 97 ]] || { echo "tripwire $n did not fire" >&2; exit 1; }; done
)
marker=$(ls "$AG_MARKERS"/codex.* | head -1)
grep -q '^tripwire=codex$' "$marker" && grep -q '^argv.1=--api-key=\[REDACTED\]$' "$marker" && grep -q '^argv.2=--token$' "$marker" && grep -q '^argv.3=\[REDACTED\]$' "$marker" && grep -q '^caller.1=' "$marker" && grep -q '^env.HOME=' "$marker" && grep -q '^env.PATH_FIRST=' "$marker" || { echo 'tripwire marker is missing fields' >&2; cat "$marker" >&2; exit 1; }
if grep -q 'SUPERSECRET' "$marker" "$root/tw.err"; then echo 'tripwire leaked a secret' >&2; exit 1; fi
grep -q 'refusing to run the real agent CLI' "$root/tw.err"
[[ $(ls "$AG_MARKERS" | grep -c '^codex\.') -eq 1 ]]
if agent_guard_report "$guard_state" 2>"$root/report.err"; then echo 'report accepted fired tripwires' >&2; exit 1; fi
grep -q 'TRIPWIRE FIRED: codex' "$root/report.err"
rm -rf "$AG_MARKERS"; mkdir -p "$AG_MARKERS"
# 2. home assertion counterexamples: each scoped path that is (or contains, or sits in) the real profile aborts the run.
assert_rejects() {
  local why=$1; shift
  if "$@" >/dev/null 2>"$root/assert.err"; then echo "guard assertion accepted: $why" >&2; exit 1; fi
  grep -q 'agent guard: refusing to start' "$root/assert.err" || { echo "unexpected assertion output for $why: $(cat "$root/assert.err")" >&2; exit 1; }
}
( agent_guard_layout "$guard_state"; agent_guard_assert "$profile" pre ) || { echo 'guard assertion rejected a properly scoped layout' >&2; exit 1; }
assert_rejects 'agent home == real profile' bash -c 'source "$0"; agent_guard_layout "$1"; AG_HOME="$2"; agent_guard_assert "$2"' "$KIT_DIR/agent-guard.sh" "$guard_state" "$profile"
assert_rejects 'agent home == real .codex' bash -c 'source "$0"; agent_guard_layout "$1"; AG_HOME="$2/.codex"; agent_guard_assert "$2"' "$KIT_DIR/agent-guard.sh" "$guard_state" "$profile"
assert_rejects 'agent home inside real .claude' bash -c 'source "$0"; agent_guard_layout "$1"; AG_HOME="$2/.claude/sub"; agent_guard_assert "$2"' "$KIT_DIR/agent-guard.sh" "$guard_state" "$profile"
assert_rejects 'agent home contains the real profile' bash -c 'source "$0"; agent_guard_layout "$1"; AG_HOME="$3"; agent_guard_assert "$2"' "$KIT_DIR/agent-guard.sh" "$guard_state" "$profile" "$root"
ln -sfn "$profile" "$root/link-to-real-profile"
assert_rejects 'agent home is a symlink to the real profile' bash -c 'source "$0"; agent_guard_layout "$1"; AG_HOME="$3"; agent_guard_assert "$2"' "$KIT_DIR/agent-guard.sh" "$guard_state" "$profile" "$root/link-to-real-profile"
assert_rejects 'relative canonical profile' bash -c 'source "$0"; agent_guard_layout "$1"; agent_guard_assert "relative/profile"' "$KIT_DIR/agent-guard.sh" "$guard_state"
assert_rejects 'post-export check without the export' bash -c 'source "$0"; agent_guard_layout "$1"; agent_guard_assert "$2" post' "$KIT_DIR/agent-guard.sh" "$guard_state" "$profile"
assert_rejects 'tripwire dir not first on PATH' bash -c 'source "$0"; agent_guard_layout "$1"; agent_guard_export; PATH="/usr/bin:$PATH"; agent_guard_assert "$2" post' "$KIT_DIR/agent-guard.sh" "$guard_state" "$profile"
# 3. end to end through launcher.sh with a fake daemon.
#    (A) bare `codex`: the tripwire fires, the watcher stops the daemon, install and checker fail naming the caller,
#        and the real agent dir is byte-identical.
#    (B) a fixture by absolute path runs with no tripwire; the scoped env reaches the daemon, its children, a
#        daemon-initiated restart (what an upgrade script does) and the private tmux server.
fixture_bin="$root/fixture-codex"; printf '#!/bin/sh\necho fixture-ran "$@" >>"%s/fixture.log"\n' "$root" >"$fixture_bin"; chmod 755 "$fixture_bin"
cat >"$fake_bin/npm" <<'EOF'
#!/usr/bin/env bash
prefix=
while (($#)); do [[ "$1" == --prefix ]] && { prefix=$2; shift 2; continue; }; shift; done
mkdir -p "$prefix/bin"
cat >"$prefix/bin/imcodes" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == start ]]; then
  { echo "HOME=$HOME"; echo "CODEX_HOME=$CODEX_HOME"; echo "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"; echo "TMUX_TMPDIR=$TMUX_TMPDIR"; echo "PATH_FIRST=${PATH%%:*}"; sh -c 'echo "CHILD_HOME=$HOME"; echo "CHILD_PATH_FIRST=${PATH%%:*}"'; } >>"$IMCODES_HOME/env.dump"
  python3 - "$IMCODES_HOME" "$$" <<'PY'
import json,sys
home,pid=sys.argv[1:]; json.dump({'pid':int(pid),'home':home},open(home+'/daemon.lock.json','w'))
PY
  if [[ -f "$IMCODES_HOME/mode-restart" && ! -f "$IMCODES_HOME/restarted" ]]; then
    : >"$IMCODES_HOME/restarted"; ( nohup "$0" start >/dev/null 2>&1 & )
  fi
  if [[ -f "$IMCODES_HOME/mode-tmux" ]] && command -v tmux >/dev/null; then
    tmux new-session -d -s selfguard "env >'$IMCODES_HOME/pane.env'; command -v codex >'$IMCODES_HOME/pane.codex'; sleep 30"
  fi
  ( sleep 1
    if [[ -f "$IMCODES_HOME/mode-bare" ]]; then codex --version; else "$FIXTURE_CODEX" --version; fi ) &
  trap 'exit 0' TERM INT
  while :; do sleep 1; done
fi
SH
chmod 700 "$prefix/bin/imcodes"
EOF
chmod 700 "$fake_bin/npm"
guard_env=(env -u HOME PATH="$fake_bin:$PATH" IMCODES_DEFAULT_HOME="$profile" IMCODES_TEST_KIT_ROOT="$root/kit" IMCODES_KIT_GUARD_SETTLE_SEC=4 FIXTURE_CODEX="$fixture_bin")
mk_owner() { mkdir -p "$root/kit/$1/imcodes-home"; printf '%s\n' '{"serverId":"srv-self","token":"token-self","workerUrl":"http://runner:24000"}' >"$root/kit/$1/imcodes-home/server.json"; for m in "${@:2}"; do : >"$root/kit/$1/imcodes-home/mode-$m"; done; }
agent_guard_inventory "$profile" "$root/real.before"
# (A)
mk_owner self-trip bare
if "${guard_env[@]}" "$KIT_DIR/launcher.sh" install --owner self-trip --machine 211 --package "$root/pkg.tgz" --server-json "$root/kit/self-trip/imcodes-home/server.json" >"$root/trip.out" 2>"$root/trip.err"; then echo 'install survived a fired tripwire' >&2; exit 1; fi
grep -q 'TRIPWIRE FIRED: codex' "$root/trip.err" || { echo 'install did not name the fired tripwire' >&2; cat "$root/trip.err" >&2; exit 1; }
grep -q 'caller: .*imcodes start' "$root/trip.err" || { echo 'install did not name the caller' >&2; cat "$root/trip.err" >&2; exit 1; }
[[ -f "$root/kit/self-trip/tripwire.fired.json" ]]
trip_pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$root/kit/self-trip/daemon.json")
for _ in {1..30}; do kill -0 "$trip_pid" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$trip_pid" 2>/dev/null; then echo 'the watcher did not stop the daemon after the tripwire fired' >&2; exit 1; fi
if "${guard_env[@]}" "$KIT_DIR/checker.sh" --owner self-trip --machine 211 >/dev/null 2>"$root/trip-check.err"; then echo 'checker passed a run whose tripwire fired' >&2; exit 1; fi
grep -q 'TRIPWIRE FIRED: codex' "$root/trip-check.err"
"${guard_env[@]}" "$KIT_DIR/launcher.sh" teardown --owner self-trip --machine 211 >/dev/null
agent_guard_inventory "$profile" "$root/real.after-a"; diff -q "$root/real.before" "$root/real.after-a" >/dev/null || { echo 'real agent dir changed in run A' >&2; exit 1; }
# (B)
mk_owner self-fixture restart tmux
"${guard_env[@]}" "$KIT_DIR/launcher.sh" install --owner self-fixture --machine 211 --package "$root/pkg.tgz" --server-json "$root/kit/self-fixture/imcodes-home/server.json" >"$root/fix.out" 2>"$root/fix.err" || { echo 'install with a fixture failed' >&2; cat "$root/fix.err" >&2; exit 1; }
"${guard_env[@]}" "$KIT_DIR/launcher.sh" guard-check --owner self-fixture --machine 211 >/dev/null
sleep 2
[[ -f "$root/kit/self-fixture/imcodes-home/restarted" ]] || { echo 'the daemon-initiated restart did not happen' >&2; exit 1; }
scoped_home="$root/kit/self-fixture/agent-home"; guard_bin="$root/kit/self-fixture/agent-guard/bin"; dump="$root/kit/self-fixture/imcodes-home/env.dump"
[[ $(grep -c '^HOME=' "$dump") -ge 2 ]] || { echo 'expected the daemon and its restarted copy to both dump their env' >&2; cat "$dump" >&2; exit 1; }
[[ $(grep '^HOME=' "$dump" | sort -u) == "HOME=$scoped_home" ]] && [[ $(grep '^CODEX_HOME=' "$dump" | sort -u) == "CODEX_HOME=$scoped_home/.codex" ]] && [[ $(grep '^CLAUDE_CONFIG_DIR=' "$dump" | sort -u) == "CLAUDE_CONFIG_DIR=$scoped_home/.claude" ]] && [[ $(grep -E '^(PATH_FIRST|CHILD_PATH_FIRST)=' "$dump" | sed 's/^[A-Z_]*=//' | sort -u) == "$guard_bin" ]] && [[ $(grep '^CHILD_HOME=' "$dump" | sort -u) == "CHILD_HOME=$scoped_home" ]] || { echo 'the scoped env did not survive to the daemon, its children and its restart' >&2; cat "$dump" >&2; exit 1; }
expected_tmx=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tmuxTmp"])' "$root/kit/self-fixture/daemon.json")
grep -qx "TMUX_TMPDIR=$expected_tmx" "$dump"
if command -v tmux >/dev/null; then
  for _ in {1..30}; do [[ -s "$root/kit/self-fixture/imcodes-home/pane.codex" ]] && break; sleep 0.2; done
  grep -q "^HOME=$scoped_home\$" "$root/kit/self-fixture/imcodes-home/pane.env" && grep -q "^CODEX_HOME=$scoped_home/.codex\$" "$root/kit/self-fixture/imcodes-home/pane.env" || { echo 'the tmux pane did not get the scoped home' >&2; cat "$root/kit/self-fixture/imcodes-home/pane.env" >&2; exit 1; }
  [[ $(cat "$root/kit/self-fixture/imcodes-home/pane.codex") == "$guard_bin/codex" ]] || { echo 'codex in the tmux pane does not resolve to the tripwire' >&2; exit 1; }
fi
grep -q 'fixture-ran --version' "$root/fixture.log" || { echo 'the fixture binary did not run by absolute path' >&2; exit 1; }
"${guard_env[@]}" "$KIT_DIR/launcher.sh" teardown --owner self-fixture --machine 211 >/dev/null
"${guard_env[@]}" "$KIT_DIR/checker.sh" --owner self-fixture --machine 211 >/dev/null || { echo 'checker rejected a clean fixture run' >&2; exit 1; }
agent_guard_inventory "$profile" "$root/real.after-b"; diff -q "$root/real.before" "$root/real.after-b" >/dev/null || { echo 'real agent dir changed in run B' >&2; exit 1; }
# A real agent home that changed during a run: attributable changes fail the checker with the file named;
# changes on a machine whose default daemon has live real agent processes are reported as inconclusive.
intruder="$profile/.codex/sessions/rollout-intruder.jsonl"
printf '{"cwd":"%s"}\n' "$root/kit/self-fixture/projects/p" >"$intruder"   # a rollout whose cwd is the scoped project
if "${guard_env[@]}" "$KIT_DIR/checker.sh" --owner self-fixture --machine 211 >/dev/null 2>"$root/inv.err"; then echo 'checker missed a write into the real agent home that references the scoped run' >&2; exit 1; fi
grep -q 'rollout-intruder' "$root/inv.err" || { echo 'checker did not name the changed file' >&2; cat "$root/inv.err" >&2; exit 1; }
printf 'written by something\n' >"$intruder"   # no reference to the run
bash -c 'exec -a codex sleep 30' & live_agent=$!
sleep 0.3
"${guard_env[@]}" "$KIT_DIR/checker.sh" --owner self-fixture --machine 211 >/dev/null 2>"$root/inv2.err" || { echo 'checker failed on an unattributable change while a real agent was live' >&2; cat "$root/inv2.err" >&2; kill "$live_agent" 2>/dev/null; exit 1; }
grep -q 'INCONCLUSIVE' "$root/inv2.err" || { echo 'checker did not report the diff as inconclusive' >&2; cat "$root/inv2.err" >&2; kill "$live_agent" 2>/dev/null; exit 1; }
kill "$live_agent" 2>/dev/null; wait "$live_agent" 2>/dev/null || true
if "${guard_env[@]}" IMCODES_KIT_ASSUME_QUIESCENT=1 "$KIT_DIR/checker.sh" --owner self-fixture --machine 211 >/dev/null 2>"$root/inv3.err"; then echo 'checker missed a change on a machine asserted quiescent' >&2; exit 1; fi
grep -q 'rollout-intruder' "$root/inv3.err"
rm -f "$intruder"
"${guard_env[@]}" "$KIT_DIR/checker.sh" --owner self-fixture --machine 211 >/dev/null || { echo 'checker rejected the run once the intruder file was gone' >&2; exit 1; }
# verdict table of agent_guard_compare on hand-made inventories (no live-process dependence)
cmp_dir="$root/cmp"; mkdir -p "$cmp_dir"
printf 'f/a\t1\t1\tx\n' >"$cmp_dir/b"; : >"$cmp_dir/b.procs"
printf 'f/a\t1\t2\ty\n' >"$cmp_dir/a"; : >"$cmp_dir/a.procs"
if agent_guard_compare "$cmp_dir/b" "$cmp_dir/a" "$profile" "$root/kit/x" 2>"$cmp_dir/e1"; then echo 'quiet machine + changed file must FAIL' >&2; exit 1; fi
grep -q 'no live real agent process' "$cmp_dir/e1"
printf '4242\tcodex app-server\n' >"$cmp_dir/a.procs"
agent_guard_compare "$cmp_dir/b" "$cmp_dir/a" "$profile" "$root/kit/x" 2>"$cmp_dir/e2" || { echo 'live real agent + changed file must be inconclusive, not a failure' >&2; exit 1; }
grep -q 'INCONCLUSIVE' "$cmp_dir/e2"
cp "$cmp_dir/b" "$cmp_dir/a"; : >"$cmp_dir/a.procs"
agent_guard_compare "$cmp_dir/b" "$cmp_dir/a" "$profile" "$root/kit/x" 2>/dev/null || { echo 'identical inventories must pass' >&2; exit 1; }
fixture_path=$(IMCODES_TEST_KIT_ROOT="$root/kit" IMCODES_DEFAULT_HOME="$profile" "$KIT_DIR/launcher.sh" fixture --owner self-fixture --machine 211 --name codex --exec "$fixture_bin")
[[ "$fixture_path" == "$root/kit/self-fixture/agent-guard/fixtures/codex" && -x "$fixture_path" ]]
echo 'agent guard self-test: PASS'
echo 'real-machine kit self-test: PASS'
