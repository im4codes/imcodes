#!/usr/bin/env bash
set -euo pipefail
KIT_DIR=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/imc-kit-self.XXXXXX"); trap 'python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)" "$root"' EXIT
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
echo 'real-machine kit self-test: PASS'
