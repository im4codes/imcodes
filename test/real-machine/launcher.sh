#!/usr/bin/env bash
set -euo pipefail
ROOT=${IMCODES_TEST_KIT_ROOT:?IMCODES_TEST_KIT_ROOT is required; use an owner-scoped absolute path}
DEFAULT_PROFILE=${IMCODES_DEFAULT_HOME:?IMCODES_DEFAULT_HOME is required; pass the canonical account profile explicitly}
DEFAULT_STATE="${DEFAULT_PROFILE%/}/.imcodes"
KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=agent-guard.sh
source "$KIT_DIR/agent-guard.sh"
usage() { echo "usage: $0 {install|teardown|status|snapshot-test|guard-check|fixture} --owner NAME --machine 211|m3 [--bind-link URL|--stack-manifest FILE|--server-json FILE] [--package TAR|--version V|--prebuilt-tree DIR] [--registry URL] [--name FIXTURE_NAME --exec ABS_PATH]" >&2; exit 2; }
cmd=${1:-}; shift || true; owner=; machine=; bind_link=; package=; version=; registry=; stack_manifest=; server_json=; fixture_name=; fixture_exec=; prebuilt_tree=
while (($#)); do case "$1" in --owner) owner=${2:?}; shift 2;; --machine) machine=${2:?}; shift 2;; --bind-link) bind_link=${2:?}; shift 2;; --stack-manifest) stack_manifest=${2:?}; shift 2;; --server-json) server_json=${2:?}; shift 2;; --package) package=${2:?}; shift 2;; --version) version=${2:?}; shift 2;; --registry) registry=${2:?}; shift 2;; --prebuilt-tree) prebuilt_tree=${2:?}; shift 2;; --name) fixture_name=${2:?}; shift 2;; --exec) fixture_exec=${2:?}; shift 2;; *) usage;; esac; done
[[ "$owner" =~ ^[A-Za-z0-9_.:-]{3,96}$ && "$machine" =~ ^(211|m3)$ ]] || usage
if [[ -n "$stack_manifest" ]]; then [[ -f "$stack_manifest" ]] || { echo "stack manifest missing: $stack_manifest" >&2; exit 1; }; bind_link=${bind_link:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bindLink"])' "$stack_manifest")}; registry=${registry:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("registryUrl", ""))' "$stack_manifest")}; fi
state="$ROOT/$owner"; home="$state/imcodes-home"; prefix="$state/prefix"; manifest="$state/daemon.json"; mkdir -p "$state" "$home" "$prefix"
hash_file() { [[ -f "$1" ]] && (command -v sha256sum >/dev/null && sha256sum "$1" || shasum -a 256 "$1") | awk '{print $1}' || echo missing; }
require_disk_space() { local avail_kb min_kb=${IMCODES_MIN_FREE_GB:-15}000000; avail_kb=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}'); [[ "$avail_kb" =~ ^[0-9]+$ && "$avail_kb" -ge "$min_kb" ]] || { echo "insufficient free disk under $ROOT: ${avail_kb:-0}KB < ${min_kb}KB" >&2; return 1; }; }
process_tree() { python3 - "$1" <<'PYTREE'
import collections,subprocess,sys
root=int(sys.argv[1]); children=collections.defaultdict(list)
try:
    rows=subprocess.check_output(['ps','-axo','pid=,ppid='],text=True,stderr=subprocess.DEVNULL).splitlines()
except Exception: rows=[]
for row in rows:
    parts=row.split();
    if len(parts)==2 and parts[0].isdigit() and parts[1].isdigit(): children[int(parts[1])].append(int(parts[0]))
seen={root}; q=collections.deque([root])
while q:
    pid=q.popleft(); print(pid)
    for child in children.get(pid,[]):
        if child not in seen: seen.add(child); q.append(child)
PYTREE
}
owned_processes() {
  python3 - "$1" "$home" "$prefix" "$$" "$PPID" <<'PYOWN'
import collections,os,subprocess,sys
root,home,prefix,me,parent=sys.argv[1:]; root=int(root); excluded={int(me),int(parent),os.getpid()}
try: rows=subprocess.check_output(['ps','-axo','pid=,ppid=,command='],text=True,stderr=subprocess.DEVNULL).splitlines()
except Exception: rows=[]
procs={}; children=collections.defaultdict(list)
for row in rows:
    p=row.strip().split(None,2)
    if len(p)<3 or not p[0].isdigit() or not p[1].isdigit(): continue
    pid,ppid=int(p[0]),int(p[1]); procs[pid]=p[2]; children[ppid].append(pid)
seen=set(); q=collections.deque([root])
while q:
    pid=q.popleft()
    if pid in seen: continue
    seen.add(pid); q.extend(children.get(pid,()))
for pid,cmd in procs.items():
    if pid in excluded: continue
    if any(token in cmd for token in ('ps -axo','sort -n','sort -u','tr \\0','python3 -')): continue
    envmatch=False
    try:
        env=open(f'/proc/{pid}/environ','rb').read().decode(errors='ignore').split('\0')
        envmatch=f'IMCODES_HOME={home}' in env
    except Exception: pass
    if pid in seen or home in cmd or prefix in cmd or envmatch:
        print(pid)
PYOWN
}
stop_owned_processes() {
  local root=${1:-0} remaining pid
  for pid in $(owned_processes "$root" | sort -rn); do kill "$pid" 2>/dev/null || true; done
  for _ in {1..30}; do
    remaining=$(owned_processes "$root" || true)
    [[ -z "$remaining" ]] && return 0
    sleep 0.2
  done
  for pid in $(owned_processes "$root" | sort -rn); do kill -KILL "$pid" 2>/dev/null || true; done
  sleep 0.2
  remaining=$(owned_processes "$root" || true)
  [[ -z "$remaining" ]] || { echo "owned processes remain: $remaining" >&2; return 1; }
}
snapshot() { local out=$1 exclude=${2:-} pid line cmdline owned owned_match; owned=$( [[ "$exclude" =~ ^[0-9]+$ ]] && process_tree "$exclude" | sort -u || true ); { for f in "$DEFAULT_STATE/daemon-watchdog.cmd" "$DEFAULT_STATE/daemon-launcher.vbs" "$DEFAULT_STATE/server.json" "$DEFAULT_STATE/daemon.lock.json" "/Library/LaunchDaemons/imcodes.daemon.plist" "/Library/LaunchAgents/imcodes.daemon.plist" "$DEFAULT_PROFILE/Library/LaunchAgents/imcodes.daemon.plist" "/etc/systemd/system/imcodes.service" "$DEFAULT_PROFILE/.config/systemd/user/imcodes.service"; do printf '%s %s\n' "$f" "$(hash_file "$f")"; done; ps -axo pid=,command= 2>/dev/null | while read -r pid line; do [[ "$line" == *imcodes-daemon* || "$line" == *daemon-watchdog* || "$line" == *windows-daemon* ]] || continue; owned_match=false; while read -r owned_pid; do if [[ "$owned_pid" == "$pid" ]]; then owned_match=true; break; fi; done <<<"$owned"; [[ "$owned_match" == true ]] && continue; cmdline="$line"; [[ "$cmdline" == *"$ROOT"* || "$cmdline" == *"$home"* || "$cmdline" == *"$prefix"* ]] && continue; if [[ -r "/proc/$pid/environ" ]] && tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -Fqx "IMCODES_HOME=$home"; then continue; fi; printf '%s\n' "$cmdline"; done; } | LC_ALL=C sort > "$out"; }
assert_lock() { local lock pid cmdline socket_path; for _ in {1..30}; do lock=$(find "$home" -maxdepth 1 -type f -name 'daemon.lock.json' -print -quit 2>/dev/null || true); [[ -n "$lock" ]] || lock=$(find "$home" -maxdepth 3 -type f \( -name '*.pipe' -o -name '*.lock' \) -print -quit 2>/dev/null || true); if [[ -n "$lock" ]]; then pid=$(python3 - "$lock" <<'PY'
import json,sys
try:
 d=json.load(open(sys.argv[1])); print(d.get('pid') or d.get('processId') or '')
except Exception: print('')
PY
); if [[ "$pid" =~ ^[0-9]+$ ]]; then lock_home=$(python3 - "$lock" <<'PY2'
import json,sys
try: print(json.load(open(sys.argv[1])).get('home',''))
except Exception: print('')
PY2
); socket_path=$(python3 - "$lock" <<'PY3'
import json,sys
try: print(json.load(open(sys.argv[1])).get('socketPath',''))
except Exception: print('')
PY3
); if [[ -r "/proc/$pid/cmdline" ]]; then cmdline=$(tr '\0' ' ' <"/proc/$pid/cmdline"); else cmdline=$(ps -p "$pid" -o command= 2>/dev/null || true); fi; env_home=; if [[ -r "/proc/$pid/environ" ]]; then env_home=$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -F 'IMCODES_HOME=' || true); fi; lock_pid_match=false; [[ -f "$state/daemon.pid" && "$(cat "$state/daemon.pid")" == "$pid" ]] && lock_pid_match=true; socket_home_match=false; [[ "$socket_path" == "$home"/* ]] && socket_home_match=true; if [[ "$lock_home" == "$home" || "$cmdline" == *"$home"* || "$env_home" == "IMCODES_HOME=$home" || ( "$lock_pid_match" == true && "$socket_home_match" == true ) ]]; then printf '%s\n' "$lock" >"$state/scoped-lock"; return 0; fi; fi; fi; sleep 1; done; echo "scoped daemon lock endpoint missing or not owned by its pid" >&2; return 1; }
start_detached() {
  local pid_file=$1 log_file=$2 exe=$3; shift 3
  rm -f "$pid_file"
  python3 - "$pid_file" "$log_file" "$exe" "$@" <<'PYDETACH' &
import os,sys
pid_file,log_file,exe,*args=sys.argv[1:]
if os.fork(): os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
with open(pid_file,'w',encoding='utf-8') as f: f.write(str(os.getpid()))
fd=os.open(log_file,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
os.dup2(fd,1); os.dup2(fd,2); os.close(fd)
os.execvpe(exe,[exe,*args],os.environ)
PYDETACH
  local helper=$!
  for _ in {1..30}; do
    [[ -s "$pid_file" ]] && break
    kill -0 "$helper" 2>/dev/null || true
    sleep 0.1
  done
  [[ -s "$pid_file" ]] || { echo 'detached daemon did not publish pid' >&2; return 1; }
  cat "$pid_file"
}
case "$cmd" in
 snapshot-test)
   state="$ROOT/$owner"; home="$state/self-home"; prefix="$state/self-prefix"; mkdir -p "$home" "$prefix"; snapshot "$state/before"; env IMCODES_HOME="$home" bash -c 'exec -a imcodes-daemon-self-test sleep 8' & test_pid=$!; sleep .2; snapshot "$state/after" "$test_pid"; kill "$test_pid" 2>/dev/null || true; wait "$test_pid" 2>/dev/null || true; diff -u "$state/before" "$state/after" >/dev/null || { echo 'forked scoped daemon leaked into default snapshot' >&2; exit 1; }; echo 'snapshot fork test: PASS';;
install)
   [[ -n "$bind_link" || -n "$server_json" ]] || { echo '--bind-link or --server-json required' >&2; exit 2; }; require_disk_space; snapshot "$state/default.before"
   agent_guard_prepare "$state"; agent_guard_assert "$DEFAULT_PROFILE" || exit 1
   agent_guard_inventory "$DEFAULT_PROFILE" "$state/agent-homes.before"; agent_guard_live_agents "$state/agent-homes.before.procs"
   if [[ -n "$prebuilt_tree" ]]; then
     # A built checkout (dist/ + node_modules) run in place: no npm install, ~0 extra disk. For low-disk hosts and fast iteration.
     [[ "$prebuilt_tree" == /* && -f "$prebuilt_tree/dist/src/index.js" ]] || { echo "--prebuilt-tree must be an absolute built checkout (dist/src/index.js missing): $prebuilt_tree" >&2; exit 2; }
     mkdir -p "$prefix/node_modules"; ln -sfn "$prebuilt_tree" "$prefix/node_modules/imcodes"
   elif [[ -n "$package" ]]; then npm install --ignore-scripts --no-audit --no-fund --prefix "$prefix" "$package" >/dev/null; elif [[ -n "$version" ]]; then npm install --ignore-scripts --no-audit --no-fund --prefix "$prefix" "imcodes@$version" ${registry:+--registry "$registry"} >/dev/null; else echo 'package or version required' >&2; exit 2; fi
   cli="$prefix/bin/imcodes"; [[ -x "$cli" ]] || cli="$prefix/node_modules/.bin/imcodes"; if [[ ! -x "$cli" && -f "$prefix/node_modules/imcodes/dist/src/index.js" ]]; then cli="$state/imcodes-cli"; printf '#!/bin/sh\nexec %q %q "$@"\n' "$(command -v node)" "$prefix/node_modules/imcodes/dist/src/index.js" >"$cli"; chmod 700 "$cli"; fi; [[ -x "$cli" ]] || { echo "imcodes binary missing" >&2; exit 1; }
   # From here on every child (bind, the daemon, its tmux server, the exec helper, the agents) runs under the guard.
   agent_guard_export; agent_guard_assert "$DEFAULT_PROFILE" post || exit 1; agent_guard_assert_path_first || exit 1
   if [[ -n "$server_json" ]]; then
     [[ -f "$server_json" ]] || { echo "server json missing: $server_json" >&2; exit 1; }
     [[ "$server_json" == "$home/server.json" ]] || cp "$server_json" "$home/server.json"; chmod 600 "$home/server.json"
   else
     set +e; env IMCODES_HOME="$home" IMCODES_DEFAULT_HOME="$DEFAULT_PROFILE" "$cli" bind "$bind_link" "$owner" >"$state/daemon.log" 2>&1; bind_rc=$?; set -e
     if (( bind_rc != 0 )); then
       [[ -f "$home/server.json" ]] || { echo "bind failed before writing scoped state" >&2; exit "$bind_rc"; }
       echo "service manager unavailable; using foreground fallback" >>"$state/daemon.log"
     fi
   fi
   export IMCODES_HOME="$home" IMCODES_DEFAULT_HOME="$DEFAULT_PROFILE"; pid=$(start_detached "$state/daemon.pid" "$state/daemon.log" "$cli" start --foreground)
   guard_pid=$(agent_guard_start_watcher "$state")
   AG_GUARD_PID="$guard_pid" AG_DEFAULT_PROFILE="$DEFAULT_PROFILE" AG_TMUX="$AG_TMUX" python3 - "$manifest" "$owner" "$machine" "$home" "$prefix" "$pid" "$state/daemon.log" "$state/scoped-lock" <<'PYMANIFEST'
import json,sys,os
p,owner,machine,home,prefix,pid,log,lock=sys.argv[1:]; d={'owner':owner,'machine':machine,'home':home,'prefix':prefix,'pid':int(pid),'log':log,'lock':lock,'defaultBefore':os.path.join(os.path.dirname(p),'default.before'),'defaultAfter':os.path.join(os.path.dirname(p),'default.after'),
 'defaultProfile':os.environ['AG_DEFAULT_PROFILE'],'guardPid':int(os.environ['AG_GUARD_PID']),'agentHome':os.path.join(os.path.dirname(p),'agent-home'),'guardBin':os.path.join(os.path.dirname(p),'agent-guard','bin'),
 'markers':os.path.join(os.path.dirname(p),'agent-guard','markers'),'tmuxTmp':os.environ['AG_TMUX'],'agentHomesBefore':os.path.join(os.path.dirname(p),'agent-homes.before')}; open(p,'w').write(json.dumps(d,indent=2)+'\n')
PYMANIFEST
   kill -0 "$pid" 2>/dev/null || { echo "detached daemon exited before lock wait (pid=$pid)" >&2; exit 1; }
   sleep 3; snapshot "$state/default.after" "$pid"; diff -u "$state/default.before" "$state/default.after" >/dev/null || { echo 'default daemon changed' >&2; kill "$pid" 2>/dev/null || true; exit 1; }; [[ -d "$home" ]] || { echo 'scoped home was not created' >&2; exit 1; }
   if ! agent_guard_report "$state"; then echo "tripwire fired: the scoped daemon tried to launch a real agent CLI; the run is aborted (see report above)" >&2; exit 1; fi
   assert_lock
   sleep "${IMCODES_KIT_GUARD_SETTLE_SEC:-5}"
   if ! agent_guard_report "$state"; then echo "tripwire fired: the scoped daemon tried to launch a real agent CLI; the run is aborted (see report above)" >&2; exit 1; fi
   agent_guard_inventory "$DEFAULT_PROFILE" "$state/agent-homes.after"; agent_guard_live_agents "$state/agent-homes.after.procs"
   agent_guard_compare "$state/agent-homes.before" "$state/agent-homes.after" "$DEFAULT_PROFILE" "$state" || { echo "real agent home was written by the scoped run" >&2; exit 1; }
   cat "$manifest"
   ;;
 guard-check) agent_guard_report "$state" && echo "no tripwire fired for $owner";;
 fixture) [[ -n "$fixture_name" && -n "$fixture_exec" ]] || usage; agent_guard_fixture "$state" "$fixture_name" "$fixture_exec";;
   teardown)
   [[ -f "$manifest" ]] || { echo 'no manifest' >&2; exit 1; }; pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid",0))' "$manifest"); gpid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("guardPid",0))' "$manifest"); if [[ "$gpid" =~ ^[1-9][0-9]*$ ]] && ps -o args= -p "$gpid" 2>/dev/null | grep -Fq guard-watch.mjs; then kill "$gpid" 2>/dev/null || true; for _ in {1..20}; do kill -0 "$gpid" 2>/dev/null || break; sleep 0.1; done; fi
   tmux_tmp=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("tmuxTmp",""))' "$manifest"); if [[ -n "$tmux_tmp" && -d "$tmux_tmp" ]]; then env -u TMUX TMUX_TMPDIR="$tmux_tmp" tmux kill-server 2>/dev/null || true; fi
   stop_owned_processes "$pid"; python3 - "$manifest" <<'PY'
import json,sys,os,shutil,datetime
p=sys.argv[1]; d=json.load(open(p));
for k in ('prefix','home'):
 path=d.get(k)
 if path and os.path.exists(path): shutil.rmtree(path,ignore_errors=True)
report={'owner':d['owner'],'cleanedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'defaultBefore':d['defaultBefore'],'defaultAfter':d['defaultAfter'],'homeRemoved':not os.path.exists(d.get('home','')),'prefixRemoved':not os.path.exists(d.get('prefix','')),'processesGone':True,'tripwireFired':os.path.exists(os.path.join(os.path.dirname(p),'tripwire.fired.json'))}
open(os.path.join(os.path.dirname(p),'teardown.json'),'w').write(json.dumps(report,indent=2)+'\n')
PY
   if [[ -n "$tmux_tmp" && "$tmux_tmp" == /tmp/imc-tmx-* ]]; then rm -rf "$tmux_tmp"; fi
   echo "removed $owner (manifest retained)";;
 status) [[ -f "$manifest" ]] && cat "$manifest" || { echo 'no manifest' >&2; exit 1; };;
 *) usage;;
esac
