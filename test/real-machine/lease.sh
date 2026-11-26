#!/usr/bin/env bash
set -euo pipefail
LEASE_FILE=${IMCODES_TEST_LEASE_FILE:-/tmp/imc-slot.json}
usage(){ echo "usage: $0 {acquire|renew|release|status} [--owner NAME] [--eta TEXT] [--ttl SEC] [--exclusive]" >&2; exit 2; }
cmd=${1:-}; shift || true; owner=; eta=; ttl=3600; exclusive=false
while (($#)); do case "$1" in --owner) owner=${2:?}; shift 2;; --eta) eta=${2:?}; shift 2;; --ttl) ttl=${2:?}; shift 2;; --exclusive) exclusive=true; shift;; *) usage;; esac; done
[[ -n "$cmd" ]] || usage; [[ "$cmd" == status || -n "$owner" ]] || usage
[[ -z "$owner" || "$owner" =~ ^[A-Za-z0-9_.:-]{3,96}$ ]] || { echo invalid-owner >&2; exit 2; }
[[ "$ttl" =~ ^[0-9]+$ && "$ttl" -gt 0 ]] || { echo invalid-ttl >&2; exit 2; }
mkdir -p "$(dirname "$LEASE_FILE")"; lock="$LEASE_FILE.lock"
for _ in {1..200}; do if mkdir "$lock" 2>/dev/null; then trap 'rmdir "$lock" 2>/dev/null || true' EXIT; break; fi; sleep .05; done
[[ -d "$lock" ]] || { echo lease-lock-busy >&2; exit 1; }
python3 - "$LEASE_FILE" "$cmd" "$owner" "$eta" "$ttl" "$exclusive" <<'PY'
import json,os,sys,tempfile,time
path,cmd,owner,eta,ttl,exclusive=sys.argv[1:]; now=int(time.time())
try: data=json.load(open(path))
except Exception: data={}
holders=data.get('holders',{}) if isinstance(data,dict) else {}
holders={k:v for k,v in holders.items() if int(v.get('expiresAt',0))>now}
def save():
 d={'holders':holders}; fd,tmp=tempfile.mkstemp(prefix='.lease-',dir=os.path.dirname(path)); os.close(fd)
 with open(tmp,'w') as f: json.dump(d,f,indent=2); f.write('\n')
 os.replace(tmp,path); print(json.dumps(d,indent=2))
if cmd=='status': print(json.dumps({'holders':holders},indent=2)); raise SystemExit
if cmd=='release':
 if owner not in holders: raise SystemExit(f'owner {owner} does not hold a lease')
 del holders[owner]; save(); raise SystemExit
if cmd=='renew':
 if owner not in holders: raise SystemExit(f'owner {owner} does not hold a lease')
 holders[owner].update(eta=eta,expiresAt=now+int(ttl)); save(); raise SystemExit
if cmd=='acquire':
 other=[(k,v) for k,v in holders.items() if k!=owner]
 if any(bool(v.get('exclusive')) for _,v in other): raise SystemExit('exclusive lease already held')
 if exclusive=='true' and other: raise SystemExit('cannot acquire exclusive lease while holders exist')
 holders[owner]={'eta':eta,'expiresAt':now+int(ttl),'exclusive':exclusive=='true'}; save(); raise SystemExit
raise SystemExit('unknown command')
PY
