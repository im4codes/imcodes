#!/usr/bin/env bash
set -euo pipefail
ROOT=${IMCODES_TEST_KIT_ROOT:?IMCODES_TEST_KIT_ROOT is required; use an owner-scoped absolute path}; owner=; machine=
while (($#)); do case "$1" in --owner) owner=${2:?}; shift 2;; --machine) machine=${2:?}; shift 2;; *) echo usage >&2; exit 2;; esac; done
[[ -n "$owner" ]] || { echo --owner-required >&2; exit 2; }; state="$ROOT/$owner"; [[ -d "$state" ]] || { echo "no owner state" >&2; exit 1; }; failed=0
min_kb=${IMCODES_MIN_FREE_GB:-15}000000; avail_kb=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}'); if ! [[ "$avail_kb" =~ ^[0-9]+$ && "$avail_kb" -ge "$min_kb" ]]; then echo "insufficient free disk: ${avail_kb:-0}KB < ${min_kb}KB" >&2; failed=1; fi
check_default(){ local b=$1 a=$2; [[ -f "$b" && -f "$a" ]] && diff -u "$b" "$a" >/dev/null || { echo "default snapshot changed or missing" >&2; failed=1; if grep -Eq 'imcodes\\.daemon|imcodes\\.service' "$b" "$a" 2>/dev/null; then echo "launchd/systemd unit changed or missing" >&2; fi; }; }
if [[ -f "$state/stack.json" ]]; then
  python3 - "$state/stack.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); safe=dict(d); safe['testUser']={**d.get('testUser',{}),'apiKey':'[REDACTED]'}; safe['authHeader']='Authorization: Bearer [REDACTED]';
if isinstance(d.get('bindLink'),str): safe['bindLink']=d['bindLink'].rsplit('/',1)[0]+'/[REDACTED]'
print(json.dumps(safe,indent=2)); print('owner=',d['owner'])
PY
  project=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["project"])' "$state/stack.json")
  for n in "$project-server" "$project-verdaccio" "$project-postgres"; do [[ -z "$(docker ps -aq --filter "name=^/${n}$")" ]] || { echo "leftover container $n" >&2; failed=1; }; done
  [[ -z "$(docker network ls -q --filter "name=^${project}-net$")" ]] || { echo "leftover network $project-net" >&2; failed=1; }
  [[ -z "$(docker images -q --filter "label=imcodes.test-kit.owner=$owner")" ]] || { echo "leftover labeled image for $owner" >&2; failed=1; }
elif [[ -f "$state/teardown.json" ]]; then
  echo "teardown report:"; cat "$state/teardown.json"
  project=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("project", ""))' "$state/teardown.json")
  [[ -z "$project" || -z "$(docker ps -aq --filter "name=^/${project}-")" ]] || { echo leftovers >&2; failed=1; }
  [[ -z "$project" || -z "$(docker images -q --filter "label=imcodes.test-kit.owner=$owner")" ]] || { echo "leftover labeled image for $owner" >&2; failed=1; }
fi
if [[ -f "$state/daemon.json" ]]; then
  python3 - "$state/daemon.json" <<'PY'
import json,sys,os; d=json.load(open(sys.argv[1])); print(json.dumps(d,indent=2)); print('home_exists=',os.path.exists(d['home']),'prefix_exists=',os.path.exists(d['prefix']))
PY
  check_default "$state/default.before" "$state/default.after"
  pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid",0))' "$state/daemon.json"); if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then echo "leftover daemon pid=$pid" >&2; failed=1; fi
  home=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("home", ""))' "$state/daemon.json")
  prefix=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("prefix", ""))' "$state/daemon.json")
  [[ ! -e "$home" ]] || { echo "leftover owner home directory: $home" >&2; failed=1; }
  [[ ! -e "$prefix" ]] || { echo "leftover owner prefix directory: $prefix" >&2; failed=1; }
  if [[ -n "$home" ]]; then
    while read -r opid ocmd; do
      [[ "$opid" =~ ^[0-9]+$ && "$opid" != "$$" && "$opid" != "$PPID" ]] || continue
      env_owned=false; if [[ -r "/proc/$opid/environ" ]]; then env_owned=$(tr '\0' '\n' <"/proc/$opid/environ" 2>/dev/null | grep -Fq "IMCODES_HOME=$home" && echo true || echo false); fi
      [[ "$ocmd" == *"$home"* || "$ocmd" == *"$prefix"* || "$env_owned" == true ]] || continue
      echo "leftover owner process pid=$opid home=$home: $ocmd" >&2; failed=1
    done < <(ps -axo pid=,command= 2>/dev/null || true)
  fi
fi
# Agent-CLI guard: a fired tripwire fails the run and names the caller; the real agent dirs must be byte-identical.
KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); source "$KIT_DIR/agent-guard.sh"
if [[ -d "$state/agent-guard/markers" ]]; then
  agent_guard_report "$state" || failed=1
  if [[ -f "$state/daemon.json" ]]; then
    gpid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("guardPid",0))' "$state/daemon.json")
    if [[ "$gpid" =~ ^[1-9][0-9]*$ ]] && ps -o args= -p "$gpid" 2>/dev/null | grep -Fq guard-watch.py && [[ -f "$state/teardown.json" ]]; then echo "leftover guard watcher pid=$gpid" >&2; failed=1; fi
    profile=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("defaultProfile",""))' "$state/daemon.json")
    if [[ -n "$profile" && -f "$state/agent-homes.before" ]]; then
      agent_guard_inventory "$profile" "$state/agent-homes.now"
      if ! diff -u "$state/agent-homes.before" "$state/agent-homes.now" >"$state/agent-homes.diff"; then echo "real agent home changed since the run started (default profile $profile):" >&2; head -40 "$state/agent-homes.diff" >&2; failed=1; fi
    fi
  fi
fi
# Surface aborted runs whose manifests were never written.  These are not
# removed by another owner's checker, but must remain visible for cleanup.
while read -r opid ocmd; do
  [[ "$opid" =~ ^[0-9]+$ && "$opid" != "$$" && "$opid" != "$PPID" ]] || continue
  [[ "$ocmd" == *"imcodes"*" start"* && "$ocmd" == *"/tmp/imc-kit-"* ]] || continue
  echo "WARNING: live imcodes start under an imc-kit state dir pid=$opid: $ocmd" >&2
done < <(ps -axo pid=,command= 2>/dev/null || true)
if [[ -f "$state/teardown.json" ]]; then
  b=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("defaultBefore", ""))' "$state/teardown.json"); a=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("defaultAfter", ""))' "$state/teardown.json"); [[ -z "$b" ]] || check_default "$b" "$a"
fi
(( failed == 0 )) || exit 1; echo "checker PASS: owner=$owner machine=$machine no leftovers and defaults unchanged"
