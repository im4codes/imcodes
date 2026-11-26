#!/usr/bin/env bash
set -euo pipefail

ROOT=${IMCODES_TEST_KIT_ROOT:?IMCODES_TEST_KIT_ROOT is required; use an owner-scoped absolute path}
usage() { echo "usage: $0 {up|down|cleanup|mint-daemon|status} --owner NAME --machine 211|m3 [--app-version V] [--registry URL] [--port N] [--registry-port N] [--bind-host HOST] [--advertise-host HOST] [--build-context DIR] [--image NAME] [--stack FILE|HOST:PORT] [--out FILE]" >&2; exit 2; }
cmd=${1:-}; shift || true; owner=; machine=; app_version=${APP_VERSION:-}; registry=${IMCODES_UPGRADE_REGISTRY:-}; port=; registry_port=; bind_host=127.0.0.1; advertise_host=127.0.0.1; build_context=; requested_image=${IMCODES_TEST_SERVER_IMAGE:-}
remote_target=; stack_ref=; out_file=; api_key=; server_name=; while (($#)); do case "$1" in
  --owner) owner=${2:?}; shift 2;; --machine) machine=${2:?}; shift 2;; --app-version) app_version=${2:?}; shift 2;; --registry) registry=${2:?}; shift 2;; --port) port=${2:?}; shift 2;; --registry-port) registry_port=${2:?}; shift 2;; --bind-host) bind_host=${2:?}; shift 2;; --advertise-host) advertise_host=${2:?}; shift 2;; --remote-target) remote_target=${2:?}; bind_host=0.0.0.0; shift 2;; --build-context) build_context=${2:?}; shift 2;; --image) requested_image=${2:?}; shift 2;; --stack) stack_ref=${2:?}; shift 2;; --out) out_file=${2:?}; shift 2;; --api-key) api_key=${2:?}; shift 2;; --server-name) server_name=${2:?}; shift 2;; *) usage;; esac; done
[[ "$owner" =~ ^[A-Za-z0-9_.:-]{3,96}$ ]] || { echo "invalid owner" >&2; exit 2; }
[[ "$machine" == 211 || "$machine" == m3 ]] || { echo "machine must be 211 or m3" >&2; exit 2; }
# A stack consumed by a different machine must never publish loopback-only
# endpoints.  --remote-target is intentionally the single source of truth for
# this mode; callers may still pass an explicit advertise host, while the
# runner derives its non-loopback address when omitted.
if [[ -n "$remote_target" ]]; then
  if [[ "$bind_host" == 127.* || "$bind_host" == ::1 || "$bind_host" == localhost ]]; then
    echo "remote target $remote_target requires a non-loopback --bind-host (use 0.0.0.0)" >&2
    exit 2
  fi
  if [[ "$advertise_host" == 127.* || "$advertise_host" == ::1 || "$advertise_host" == localhost ]]; then
    advertise_host=${IMCODES_STACK_ADVERTISE_HOST:-}
    if [[ -z "$advertise_host" ]]; then
      advertise_host=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+(\.[0-9]+){3}$/ && $0 !~ /^127\./ {print; exit}')
    fi
    if [[ -z "$advertise_host" ]]; then
      advertise_host=$(ipconfig getifaddr en0 2>/dev/null || true)
    fi
    [[ -n "$advertise_host" && "$advertise_host" != 127.* && "$advertise_host" != ::1 ]] || {
      echo "remote target $remote_target requires --advertise-host or IMCODES_STACK_ADVERTISE_HOST" >&2
      exit 2
    }
  fi
fi
state="$ROOT/$owner"; manifest="$state/stack.json"; mkdir -p "$state"
evidence_dir="$state/failure-evidence"
key=$(printf '%s:%s' "$owner" "$machine" | shasum -a 256 | cut -c1-10)
project="imc-kit-$key"; port=${port:-$((19000 + 10#$((0x${key:0:4} % 1000))))}; registry_port=${registry_port:-$((18000 + 10#$((0x${key:4:4} % 1000))))}
server_image=${requested_image:-ghcr.io/im4codes/imcodes:latest}; image_built=false; image_label="imcodes.test-kit.owner=$owner"; jwt_key=$(openssl rand -hex 32); bot_key=$(openssl rand -hex 32)
require_disk_space() { local avail_kb min_kb=${IMCODES_MIN_FREE_GB:-15}000000; avail_kb=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}'); [[ "$avail_kb" =~ ^[0-9]+$ && "$avail_kb" -ge "$min_kb" ]] || { echo "insufficient free disk under $ROOT: ${avail_kb:-0}KB < ${min_kb}KB" >&2; return 1; }; }
write_manifest() { python3 - "$manifest" "$owner" "$machine" "$project" "$port" "$registry_port" "$mode" "$network" "$pg" "$verdaccio" "$server" "$registry" "$app_version" "$user_id" "$api_key" "$server_image" "$image_built" "$bind_host" "$advertise_host" "$image_label" "$remote_target" <<'PY'
import json,sys,os
p,owner,machine,project,port,rport,mode,network,pg,verdaccio,server,registry,version,user_id,api_key,image,image_built,bind_host,advertise_host,image_label,remote_target=sys.argv[1:]
d={'owner':owner,'machine':machine,'project':project,'workerUrl':f'http://{advertise_host}:{port}','registryUrl':f'http://{advertise_host}:{rport}','bindLink':f'http://{advertise_host}:{port}/bind/'+api_key,'mode':mode,'network':network,'containers':{'postgres':pg,'verdaccio':verdaccio,'server':server},'registry':registry,'appVersion':version,'testUser':{'userId':user_id,'apiKey':api_key},'authHeader':'Authorization: Bearer '+api_key,'image':image,'imageBuilt':image_built=='true','imageLabel':image_label,'bindHost':bind_host,'advertiseHost':advertise_host,'remoteTarget':remote_target or None}
os.makedirs(os.path.dirname(p),exist_ok=True); open(p,'w').write(json.dumps(d,indent=2)+'\n')
safe=dict(d); safe['testUser']={**d['testUser'],'apiKey':'[REDACTED]'}; safe['authHeader']='Authorization: Bearer [REDACTED]'; safe['bindLink']=d['bindLink'].rsplit('/',1)[0]+'/[REDACTED]'; print(json.dumps(safe,indent=2))
PY
}
capture_failure() {
  local reason=${1:-stack-failure}
  mkdir -p "$evidence_dir"
  printf 'reason=%s\nowner=%s\nproject=%s\ntime=%s\n' "$reason" "$owner" "$project" "$(date -u +%FT%TZ)" >"$evidence_dir/summary.txt"
  docker ps -a --no-trunc >"$evidence_dir/docker-ps.txt" 2>&1 || true
  for c in "$project-server" "$project-postgres" "$project-verdaccio"; do
    docker logs "$c" >"$evidence_dir/${c}.log" 2>&1 || true
    docker inspect "$c" >"$evidence_dir/${c}.inspect.json" 2>&1 || true
  done
}
health() { local c=$1; for _ in {1..90}; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || true)" == healthy ]] && return 0; sleep 2; done; echo "container $c did not become healthy" >&2; capture_failure "unhealthy:$c"; return 1; }
case "$cmd" in
  up)
    command -v docker >/dev/null || { echo docker required >&2; exit 1; }
    require_disk_space
    cleanup_on_error() { docker rm -f "$project-server" "$project-verdaccio" "$project-postgres" >/dev/null 2>&1 || true; docker network rm "$project-net" >/dev/null 2>&1 || true; [[ "$image_built" == true ]] && docker image rm -f "$server_image" >/dev/null 2>&1 || true; }
    trap 'rc=$?; capture_failure "command-failed:$rc"; cleanup_on_error; exit "$rc"' ERR
    if [[ -n "$build_context" ]]; then
      [[ -f "$build_context/server/Dockerfile" ]] || { echo "build context must contain server/Dockerfile: $build_context" >&2; exit 1; }
      if find "$build_context" -type f -name '._*' -print -quit | grep -q .; then
        echo "build context contains macOS archive metadata (._*); repack with COPYFILE_DISABLE=1 git archive" >&2
        exit 1
      fi
      server_image=${requested_image:-"imc-kit/$owner:$key"}; docker build --label "$image_label" --label "imcodes.test-kit.project=$project" --build-arg APP_VERSION="$app_version" -t "$server_image" -f "$build_context/server/Dockerfile" "$build_context"; image_built=true
    fi
    if [[ "$machine" == 211 ]]; then command -v docker >/dev/null; command -v docker compose >/dev/null || { echo 'docker compose required on 211' >&2; exit 1; }; mode=compose; network="$project-net"; pg="$project-postgres"; verdaccio="$project-verdaccio"; server="$project-server"; compose="$state/docker-compose.yml"
      cat > "$compose" <<YAML
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: $pg
    environment: {POSTGRES_PASSWORD: test, POSTGRES_USER: imcodes, POSTGRES_DB: imcodes}
    ports: ["127.0.0.1::5432"]
    cpus: 1.0
    mem_limit: 1g
    pids_limit: 256
    healthcheck: {test: [CMD-SHELL, "pg_isready -U imcodes -d imcodes"], interval: 2s, timeout: 2s, retries: 30}
  verdaccio:
    image: verdaccio/verdaccio:5
    container_name: $verdaccio
    ports: ["$bind_host:$registry_port:4873"]
    cpus: 0.5
    mem_limit: 512m
    pids_limit: 128
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          node -e 'require("http").get("http://127.0.0.1:4873/-/ping",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))'
      interval: 2s
      timeout: 3s
      retries: 30
  server:
    image: $server_image
    container_name: $server
    environment: {APP_VERSION: "$app_version", IMCODES_UPGRADE_REGISTRY: "$registry", DATABASE_URL: "postgresql://imcodes:test@postgres:5432/imcodes", JWT_SIGNING_KEY: "$jwt_key", BOT_ENCRYPTION_KEY: "$bot_key", PORT: "19138", ALLOWED_ORIGINS: "http://$advertise_host:$port", NODE_ENV: test}
    labels: ["$image_label", "imcodes.test-kit.project=$project"]
    depends_on: {postgres: {condition: service_healthy}, verdaccio: {condition: service_healthy}}
    ports: ["$bind_host:$port:19138"]
    cpus: 2.0
    mem_limit: 2g
    pids_limit: 256
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          node -e 'require("http").get("http://127.0.0.1:19138/health",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))'
      interval: 3s
      timeout: 2s
      retries: 40
networks:
  default:
    name: $network
YAML
      docker compose -p "$project" -f "$compose" up -d
      health "$server"
    else
      mode=plain; network="$project-net"; pg="$project-postgres"; verdaccio="$project-verdaccio"; server="$project-server"
      docker network create "$network" >/dev/null 2>&1 || true
      docker run -d --name "$pg" --network "$network" --network-alias postgres --cpus 1 --memory 1g --pids-limit 256 -e POSTGRES_PASSWORD=test -e POSTGRES_USER=imcodes -e POSTGRES_DB=imcodes --health-cmd 'pg_isready -U imcodes -d imcodes' --health-interval 2s --health-timeout 2s --health-retries 30 pgvector/pgvector:pg16 >/dev/null
      health "$pg"
      docker run -d --name "$verdaccio" --network "$network" --cpus .5 --memory 512m --pids-limit 128 -p "$bind_host:$registry_port:4873" --label "$image_label" --label "imcodes.test-kit.project=$project" --health-cmd "node -e 'require(\"http\").get(\"http://127.0.0.1:4873/-/ping\",r=>process.exit(r.statusCode===200?0:1)).on(\"error\",()=>process.exit(1))'" --health-interval 2s --health-timeout 2s --health-retries 30 verdaccio/verdaccio:5 >/dev/null
      docker run -d --name "$server" --network "$network" --cpus 2 --memory 2g --pids-limit 256 -e "APP_VERSION=$app_version" -e "IMCODES_UPGRADE_REGISTRY=$registry" -e DATABASE_URL=postgresql://imcodes:test@postgres:5432/imcodes -e "JWT_SIGNING_KEY=$jwt_key" -e "BOT_ENCRYPTION_KEY=$bot_key" -e PORT=19138 -e "ALLOWED_ORIGINS=http://$advertise_host:$port" -p "$bind_host:$port:19138" --label "$image_label" --label "imcodes.test-kit.project=$project" --health-cmd "node -e 'require(\"http\").get(\"http://127.0.0.1:19138/health\",r=>process.exit(r.statusCode===200?0:1)).on(\"error\",()=>process.exit(1))'" --health-interval 3s --health-timeout 2s --health-retries 40 "$server_image" >/dev/null
      health "$server"
    fi
    if ! auth=$(curl -fsS -X POST "http://127.0.0.1:$port/api/auth/register" -H "Content-Type: application/json" -d '{}'); then cleanup_on_error; echo "server registration failed" >&2; exit 1; fi; user_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["userId"])' <<<"$auth"); api_key=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])' <<<"$auth"); chmod 700 "$state"; write_manifest; chmod 600 "$manifest"
    echo "worker_url=http://$advertise_host:$port registry_url=http://$advertise_host:$registry_port bind_link=[REDACTED] manifest=$manifest";;
  down)
    [[ -f "$manifest" ]] || { echo "no manifest for $owner" >&2; exit 1; }
    mode=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["mode"])' "$manifest")
    if [[ "$mode" == compose ]]; then compose="$state/docker-compose.yml"; docker compose -p "$project" -f "$compose" down --volumes --remove-orphans; else
      for c in "$project-server" "$project-verdaccio" "$project-postgres"; do docker rm -f "$c" >/dev/null 2>&1 || true; done; docker network rm "$project-net" >/dev/null 2>&1 || true
    fi
    image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("image", ""))' "$manifest"); built=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("imageBuilt", False))' "$manifest");
    if [[ "$built" == True && -n "$image" ]]; then
      owner_label=$(docker image inspect "$image" --format '{{index .Config.Labels "imcodes.test-kit.owner"}}' 2>/dev/null || true)
      project_label=$(docker image inspect "$image" --format '{{index .Config.Labels "imcodes.test-kit.project"}}' 2>/dev/null || true)
      if [[ "$owner_label" == "$owner" && "$project_label" == "$project" ]]; then docker image rm -f "$image" >/dev/null 2>&1 || true; else echo "preserving image $image (owner/project label mismatch)" >&2; fi
    fi
    docker builder prune -f --filter "label=imcodes.test-kit.owner=$owner" >/dev/null 2>&1 || true
    python3 - "$manifest" <<'PY2'
import json,sys,os,datetime
p=sys.argv[1]; d=json.load(open(p)); safe=dict(d)
if isinstance(d.get('testUser'),dict): safe['testUser']={**d['testUser'],'apiKey':'[REDACTED]'}
safe['authHeader']='Authorization: Bearer [REDACTED]'
if isinstance(d.get('bindLink'),str): safe['bindLink']='[REDACTED]'
for key in ('token','apiKey'): safe.pop(key,None)
safe['cleanedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat(); safe['resourcesGone']=True
open(os.path.join(os.path.dirname(p),'teardown.json'),'w').write(json.dumps(safe,indent=2)+'\n')
PY2
    rm -f "$manifest" "$state/docker-compose.yml"; echo "removed $owner (teardown manifest retained)";;
  cleanup)
    # Label-scoped recovery for interrupted runs whose manifest was never written.
    for id in $(docker ps -aq --filter "label=imcodes.test-kit.owner=$owner"); do docker rm -f "$id" >/dev/null 2>&1 || true; done
    docker network rm "$project-net" >/dev/null 2>&1 || true
    for id in $(docker images -q --filter "label=imcodes.test-kit.owner=$owner"); do docker image rm -f "$id" >/dev/null 2>&1 || true; done
    docker builder prune -f --filter "label=imcodes.test-kit.owner=$owner" >/dev/null 2>&1 || true
    echo "cleaned owner-labeled resources for $owner";;
  mint-daemon)
    [[ -n "$stack_ref" && -n "$out_file" ]] || { echo 'mint-daemon requires --stack and --out' >&2; exit 2; }
    [[ "$out_file" = /* ]] || { echo '--out must be an absolute path' >&2; exit 2; }
    if [[ -f "$stack_ref" ]]; then
      worker_url=$(python3 - "$stack_ref" <<'PY2'
import json,sys
print(json.load(open(sys.argv[1]))['workerUrl'])
PY2
      )
      api_key=${api_key:-$(python3 - "$stack_ref" <<'PY2'
import json,sys
print(json.load(open(sys.argv[1]))['testUser']['apiKey'])
PY2
      )}
    else
      worker_url="$stack_ref"; [[ "$worker_url" == http://* || "$worker_url" == https://* ]] || worker_url="http://$worker_url"
      api_key=${api_key:-${IMCODES_TEST_USER_API_KEY:-}}
    fi
    if [[ -z "$api_key" ]]; then
      register=$(curl -fsS -X POST "$worker_url/api/auth/register" -H 'content-type: application/json' -d '{}') || { echo 'stack user registration failed' >&2; exit 1; }
      api_key=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])' <<<"$register")
    fi
    server_name=${server_name:-"imcodes test-kit $owner"}
    body=$(python3 -c 'import json,sys; print(json.dumps({"serverName":sys.argv[1]}))' "$server_name")
    direct=$(curl -fsS -X POST "$worker_url/api/bind/direct" -H 'content-type: application/json' -H "authorization: Bearer $api_key" -d "$body") || { echo 'stack daemon bind failed' >&2; exit 1; }
    parent=$(dirname "$out_file"); mkdir -p "$parent"; tmp=$(mktemp "$out_file.tmp.XXXXXX")
    python3 - "$tmp" "$direct" "$worker_url" "$server_name" "$owner" <<'PY2'
import json,os,sys,time
out,raw,worker,name,owner=sys.argv[1:]; d=json.loads(raw)
if any(not isinstance(d.get(k),str) or not d[k] for k in ('serverId','token')): raise SystemExit('bind response missing credentials')
payload={'serverId':d['serverId'],'token':d['token'],'workerUrl':worker,'serverName':d.get('serverName') or name,'boundAt':int(time.time()*1000),'sessionName':f'kit-{owner}'}
with open(out,'w') as f: json.dump(payload,f,indent=2); f.write('\n')
os.chmod(out,0o600)
print(json.dumps({k:payload[k] for k in ('serverId','workerUrl','serverName','boundAt')}))
PY2
    mv "$tmp" "$out_file"
    # Seed one owner-scoped session row so the authenticated history route has
    # a real target; this does not start a provider or daemon session.
    if [[ -f "$stack_ref" ]]; then
      pg_container=$(python3 - "$stack_ref" <<'PY3'
import json,sys
print(json.load(open(sys.argv[1])).get('containers',{}).get('postgres',''))
PY3
      )
      uid=$(python3 - "$stack_ref" <<'PY3'
import json,sys
print(json.load(open(sys.argv[1])).get('testUser',{}).get('userId',''))
PY3
      )
      sid=$(python3 - "$out_file" <<'PY3'
import json,sys
print(json.load(open(sys.argv[1]))['serverId'])
PY3
      )
      session_name="kit-$owner"; now_ms=$(python3 -c 'import time; print(int(time.time()*1000))'); [[ "$now_ms" =~ ^[0-9]+$ ]] || { echo 'portable timestamp is not numeric' >&2; exit 1; }
      sql=$(python3 - "$sid" "$uid" "$session_name" "$now_ms" <<'PY3'
import sys
sid,uid,name,now=sys.argv[1:]
def q(v): return "'" + v.replace("'", "''") + "'"
print("INSERT INTO sessions (id,server_id,name,project_name,project_dir,role,agent_type,state,created_at,updated_at) VALUES (" + ",".join([q('kit-'+name),q(sid),q(name),q('real-machine-kit'),q('/tmp'),q('brain'),q('codex-sdk'),q('idle'),now,now]) + ") ON CONFLICT (server_id,name) DO UPDATE SET state='idle',updated_at=EXCLUDED.updated_at;")
PY3
      )
      if [[ -n "$pg_container" && -n "$uid" ]]; then
        docker exec "$pg_container" psql -U imcodes -d imcodes -v ON_ERROR_STOP=1 -c "$sql" >/dev/null
      fi
    fi
    ;;
  status) [[ -f "$manifest" ]] && cat "$manifest" || { echo "no manifest"; exit 1; };;
  *) usage;;
esac
