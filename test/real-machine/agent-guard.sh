#!/usr/bin/env bash
# Agent-CLI guard for scoped real-machine daemons. Sourced by launcher.sh and self-test.sh.
#
# Why: a scoped daemon that falls back to a bare `codex`/`claude`/... found on PATH runs the
# machine's REAL agent CLI against the machine's REAL agent home (2026-09-30, twice, on 211:
# /home/k/.codex was written by a scoped daemon whose session had no transportConfig.binaryPath).
# The guard makes that impossible to do silently, for every pair, without anyone remembering it:
#   1. tripwires  - a scoped bin dir FIRST on PATH holds an executable for every agent CLI the
#                   daemon can launch. It records who called it (argv with secrets masked, parent
#                   chain, env summary), never runs the real CLI, and exits 97.
#   2. scoped homes - the daemon (and its tmux server, and everything they spawn, including the exec
#                   helper) gets HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, GEMINI_CLI_HOME and the XDG
#                   dirs under the owner's state dir, so even a CLI that slips past the tripwire
#                   (an absolute /usr/local/bin/claude) cannot touch the real home.
#   3. assertion  - before anything starts, every scoped path is checked against the canonical
#                   profile (IMCODES_DEFAULT_HOME); a scoped path that equals or contains it, or a
#                   real agent dir, aborts the run.
#   4. watcher    - guard-watch.py stops the scoped daemon the moment a marker appears; checker.sh
#                   fails the run and names the caller. An inventory (size, mtime, sha) of the real
#                   agent dirs before/after proves nothing was written.
# Real fixture CLIs are referenced by ABSOLUTE path only (transportConfig.binaryPath, or a path
# printed by `launcher.sh fixture`), never through PATH.
# This file never expands the process home variable or a tilde: the canonical profile is passed in.

AGENT_GUARD_CLI_NAMES=(claude codex gemini opencode qwen cursor-agent agent copilot kimi hermes codebuddy qodercli qoder pi dsh deepseek)
# Directories under the canonical profile that real agent CLIs write to. Inventory + assertion targets.
AGENT_GUARD_REAL_DIRS=(.codex .claude .gemini .qwen .cursor .copilot .kimi .hermes .codebuddy .config/opencode .local/share/opencode .local/state/opencode .cache/opencode .config/github-copilot)
AGENT_GUARD_KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# agent_guard_layout STATE -> sets AG_* path variables (no side effects).
agent_guard_layout() {
  AG_STATE=$1
  AG_ROOT="$AG_STATE/agent-guard"
  AG_BIN="$AG_ROOT/bin"
  AG_MARKERS="$AG_ROOT/markers"
  AG_FIXTURES="$AG_ROOT/fixtures"
  AG_HOME="$AG_STATE/agent-home"
  # tmux sockets live in $TMUX_TMPDIR/tmux-UID/default; a unix socket path is limited to ~104 bytes, so a long
  # owner state dir (macOS $TMPDIR) gets a short owner-hashed directory under /tmp instead.
  AG_TMUX="$AG_STATE/tmx"
  if (( ${#AG_TMUX} > 78 )); then AG_TMUX="/tmp/imc-tmx-$(printf '%s' "$AG_STATE" | (command -v sha256sum >/dev/null && sha256sum || shasum -a 256) | cut -c1-10)"; fi
  AG_FIRED="$AG_STATE/tripwire.fired.json"
}

agent_guard_prepare() {
  agent_guard_layout "$1"
  mkdir -p "$AG_BIN" "$AG_MARKERS" "$AG_FIXTURES" "$AG_HOME/.codex" "$AG_HOME/.claude" "$AG_HOME/.gemini" \
    "$AG_HOME/.config" "$AG_HOME/.local/share" "$AG_HOME/.local/state" "$AG_HOME/.cache" "$AG_TMUX"
  chmod 700 "$AG_TMUX"
  # Agents and git run under this HOME; give git an identity so worktree provisioning still commits.
  printf '[user]\n\tname = imcodes kit\n\temail = kit@example.invalid\n[safe]\n\tdirectory = *\n' >"$AG_HOME/.gitconfig"
  local name
  for name in "${AGENT_GUARD_CLI_NAMES[@]}"; do
    cat >"$AG_BIN/$name" <<TRIPWIRE
#!/bin/sh
# imcodes real-machine kit tripwire for the agent CLI "$name". It never runs the real CLI.
marks='$AG_MARKERS'
f="\$marks/$name.\$\$.\$(date +%s)"
{
  echo "tripwire=$name"
  echo "pid=\$\$"
  echo "ppid=\$PPID"
  echo "time=\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "cwd=\$(pwd)"
  i=0; prev=
  for a in "\$@"; do
    i=\$((i+1)); low=\$(printf '%s' "\$a" | tr 'A-Z' 'a-z' | tr '\\n\\r' '  ')
    case "\$prev" in *key|*token|*secret|*password|*passwd) val='[REDACTED]';; *) val=\$(printf '%s' "\$a" | tr '\\n\\r' '  ');; esac
    case "\$low" in *key=*|*token=*|*secret=*|*password=*|*passwd=*) val="\${val%%=*}=[REDACTED]";; esac
    printf 'argv.%s=%s\n' "\$i" "\$val"; prev=\$low
  done
  p=\$PPID; n=0
  while [ "\$n" -lt 8 ] && [ -n "\$p" ] && [ "\$p" -gt 1 ] 2>/dev/null; do
    n=\$((n+1)); printf 'caller.%s=%s %s\n' "\$n" "\$p" "\$(ps -o args= -p "\$p" 2>/dev/null | cut -c1-300 | sed -E 's/((key|token|secret|password)[A-Za-z_-]*[= ])[^ ]+/\1[REDACTED]/g')"
    p=\$(ps -o ppid= -p "\$p" 2>/dev/null | tr -d ' ')
  done
  env | grep -E '^(HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|GEMINI_CLI_HOME|XDG_[A-Z]+_HOME|TMUX|TMUX_TMPDIR|IMCODES_HOME|IMCODES_KIT_[A-Z_]*|USER)=' | sed 's/^/env./'
  echo "env.PATH_FIRST=\$(printf '%s' "\$PATH" | cut -d: -f1)"
} >"\$f.tmp" 2>/dev/null
mv "\$f.tmp" "\$f" 2>/dev/null
echo "kit tripwire: refusing to run the real agent CLI '$name' in a scoped real-machine run; pin transportConfig.binaryPath to a fixture (absolute path) instead. Marker: \$f" >&2
exit 97
TRIPWIRE
    chmod 755 "$AG_BIN/$name"
  done
}

# agent_guard_export: put the guard into the CURRENT shell's environment. Call it in the
# launcher's own process so every child (bind, the daemon, its tmux server) inherits it.
agent_guard_export() {
  [[ -n "${AG_HOME:-}" ]] || { echo 'agent_guard_export before agent_guard_prepare' >&2; return 1; }
  export PATH="$AG_BIN:$PATH"
  export HOME="$AG_HOME"
  export CODEX_HOME="$AG_HOME/.codex" CLAUDE_CONFIG_DIR="$AG_HOME/.claude" GEMINI_CLI_HOME="$AG_HOME"
  export XDG_CONFIG_HOME="$AG_HOME/.config" XDG_DATA_HOME="$AG_HOME/.local/share" XDG_STATE_HOME="$AG_HOME/.local/state" XDG_CACHE_HOME="$AG_HOME/.cache"
  export TMUX_TMPDIR="$AG_TMUX"
  export IMCODES_KIT_GUARD=1 IMCODES_KIT_TRIPWIRE_DIR="$AG_MARKERS"
  unset TMUX
}

# agent_guard_assert DEFAULT_PROFILE [pre|post]: fails (non-zero, message on stderr) when the guard is not
# what it claims to be. Pure path checks; run it BEFORE starting anything.
agent_guard_assert() {
  local default_profile=$1 phase=${2:-pre}
  python3 - "$default_profile" "$AG_STATE" "$AG_BIN" "$AG_HOME" "$AG_TMUX" "${AGENT_GUARD_REAL_DIRS[*]}" "$phase" <<'PYASSERT'
import os,sys
profile,state,binp,home,tmux,real_dirs,phase=sys.argv[1:8]
def rp(p): return os.path.realpath(p)
if not profile or not os.path.isabs(profile): sys.exit('agent guard: refusing to start: IMCODES_DEFAULT_HOME must be an absolute path (got %r)' % profile)
prof=rp(profile)
real={rp(os.path.join(prof,d)) for d in real_dirs.split()}
scoped={'agent home':home,'tripwire bin':binp,'tmux tmp':tmux}
env_expect={'HOME':home,'CODEX_HOME':home+'/.codex','CLAUDE_CONFIG_DIR':home+'/.claude','GEMINI_CLI_HOME':home,
 'XDG_CONFIG_HOME':home+'/.config','XDG_DATA_HOME':home+'/.local/share','XDG_STATE_HOME':home+'/.local/state','XDG_CACHE_HOME':home+'/.cache','TMUX_TMPDIR':tmux}
problems=[]
for label,p in list(scoped.items())+[('state',state)]+[('planned '+k,v) for k,v in env_expect.items()]:
    r=rp(p)
    if r==prof: problems.append('%s resolves to the real user home %s' % (label,prof))
    elif prof.startswith(r.rstrip('/')+'/'): problems.append('%s (%s) contains the real user home %s' % (label,r,prof))
    for d in real:
        if r==d or r.startswith(d+'/'): problems.append('%s (%s) is inside a real agent dir %s' % (label,r,d))
    short_tmux=(label in ('tmux tmp','planned TMUX_TMPDIR') and os.path.basename(r).startswith('imc-tmx-') and os.path.dirname(r) in ('/tmp',rp('/tmp')))
    if not (r==rp(state) or r.startswith(rp(state)+'/') or short_tmux): problems.append('%s (%s) is outside the owner state dir %s' % (label,r,rp(state)))
# After agent_guard_export the environment IS the guard: every variable must be the scoped value.
if phase=='post':
    for k,v in env_expect.items():
        got=os.environ.get(k)
        if got!=v: problems.append('exported %s=%r, expected the scoped %r' % (k,got,v))
    if os.environ.get('PATH','').split(':')[0]!=binp: problems.append('PATH does not start with the tripwire dir')
if len(rp(tmux))+len('/tmux-1000/default')>100: problems.append('TMUX_TMPDIR %r is too long for a unix socket path' % tmux)
if problems: sys.exit('agent guard: refusing to start:\n  - '+'\n  - '.join(problems))
PYASSERT
}

# agent_guard_assert_path_first: after agent_guard_export, the tripwire dir must be PATH[0] and shadow every name.
agent_guard_assert_path_first() {
  local first=${PATH%%:*} name resolved
  [[ "$first" == "$AG_BIN" ]] || { echo "agent guard: tripwire dir is not first on PATH (first=$first)" >&2; return 1; }
  for name in "${AGENT_GUARD_CLI_NAMES[@]}"; do
    resolved=$(command -v "$name" || true)
    [[ "$resolved" == "$AG_BIN/$name" ]] || { echo "agent guard: '$name' resolves to '$resolved', not its tripwire" >&2; return 1; }
  done
}

# agent_guard_inventory DEFAULT_PROFILE OUT: size, mtime (ns) and sha256 (files <= 8 MB) of every file
# in the real agent dirs. Missing dirs are recorded as missing. Deterministic, sorted.
agent_guard_inventory() {
  python3 - "$1" "$2" "${AGENT_GUARD_REAL_DIRS[*]}" <<'PYINV'
import hashlib,os,sys
profile,out,dirs=sys.argv[1:4]; rows=[]
for d in dirs.split():
    root=os.path.join(profile,d)
    if not os.path.exists(root): rows.append('%s\tmissing' % d); continue
    for cur,subs,files in os.walk(root, followlinks=False):
        subs.sort()
        for f in sorted(files):
            p=os.path.join(cur,f); rel=os.path.relpath(p,profile)
            try:
                st=os.lstat(p)
                sha='-'
                if os.path.isfile(p) and not os.path.islink(p) and st.st_size<=8*1024*1024:
                    h=hashlib.sha256()
                    with open(p,'rb') as fh:
                        for chunk in iter(lambda: fh.read(1<<20), b''): h.update(chunk)
                    sha=h.hexdigest()
                rows.append('%s\t%d\t%d\t%s' % (rel,st.st_size,st.st_mtime_ns,sha))
            except OSError as e:
                rows.append('%s\tunreadable\t%s' % (rel,e.errno))
open(out,'w').write('\n'.join(sorted(rows))+'\n')
PYINV
}

# agent_guard_live_agents OUT: real agent CLI processes alive on the machine right now (pid<TAB>command).
# A machine whose default daemon has live real sessions (211 does) writes its own agent dirs all day, so a
# before/after inventory diff there cannot by itself be blamed on the scoped run; see agent_guard_compare.
agent_guard_live_agents() {
  python3 - "$1" <<'PYLIVE'
import os,re,subprocess,sys
names={'claude','codex','gemini','opencode','qwen','cursor-agent','copilot','kimi','hermes','codebuddy','qodercli','qoder'}
rows=subprocess.check_output(['ps','-axo','pid=,command='],text=True,stderr=subprocess.DEVNULL).splitlines()
me={os.getpid(),os.getppid()}; out=[]
for row in rows:
    p=row.strip().split(None,1)
    if len(p)<2 or not p[0].isdigit() or int(p[0]) in me: continue
    toks=p[1].split()
    if not toks: continue
    exe=os.path.basename(toks[0]); script=os.path.basename(toks[1]) if exe in ('node','python3','python','bash','sh') and len(toks)>1 else ''
    if exe in names or script in names: out.append('%s\t%s' % (p[0],p[1][:160]))
open(sys.argv[1],'w').write('\n'.join(out)+('\n' if out else ''))
PYLIVE
}

# agent_guard_compare BEFORE AFTER DEFAULT_PROFILE STATE: verdict on a before/after inventory pair.
# FAIL (return 1) when a change is attributable to the scoped run: the machine had no live real agent process at
# either snapshot (or the operator set IMCODES_KIT_ASSUME_QUIESCENT=1), or an added/modified file contains the
# owner's state dir (a rollout/session file whose cwd is the scoped project). Otherwise the diff is printed as
# inconclusive, because a live default daemon legitimately writes there. The tripwire stays the primary detector.
agent_guard_compare() {
  python3 - "$1" "$2" "$3" "$4" "${IMCODES_KIT_ASSUME_QUIESCENT:-}" <<'PYCMP'
import os,sys
before,after,profile,state,assume=sys.argv[1:6]
def load(p):
    d={}
    for line in open(p).read().splitlines():
        if not line: continue
        k,_,rest=line.partition('\t'); d[k]=rest
    return d
def procs(p):
    try: return [l for l in open(p+'.procs').read().splitlines() if l]
    except OSError: return []
b,a=load(before),load(after)
added=sorted(k for k in a if k not in b); removed=sorted(k for k in b if k not in a); modified=sorted(k for k in a if k in b and a[k]!=b[k])
live=procs(before)+procs(after)
quiet=(not live) or assume=='1'
owner_ref=[]
for k in added+modified:
    path=os.path.join(profile,k)
    try:
        if os.path.getsize(path)<=8*1024*1024 and state.encode() in open(path,'rb').read(): owner_ref.append(k)
    except OSError: pass
print('real agent dirs: %d added, %d modified, %d removed; live real agent processes: %d' % (len(added),len(modified),len(removed),len(live)), file=sys.stderr)
for label,items in (('added',added),('modified',modified),('removed',removed)):
    for k in items[:15]: print('  %s: %s' % (label,k), file=sys.stderr)
    if len(items)>15: print('  ... %d more %s' % (len(items)-15,label), file=sys.stderr)
if owner_ref:
    print('FAIL: these files reference the scoped run (%s): %s' % (state,', '.join(owner_ref[:10])), file=sys.stderr); sys.exit(1)
if (added or modified or removed) and quiet:
    print('FAIL: the machine had no live real agent process, so every change to its agent dirs came from the scoped run', file=sys.stderr); sys.exit(1)
if added or modified or removed:
    print('INCONCLUSIVE (not a failure): real agent processes were live on this machine: '+'; '.join(l.split('\t')[0] for l in live[:8])+'; the tripwire is the authoritative detector here', file=sys.stderr)
PYCMP
}

# agent_guard_report STATE: prints every fired tripwire (caller named) and returns 1 if any fired.
agent_guard_report() {
  agent_guard_layout "$1"
  local m fired=0
  for m in "$AG_MARKERS"/*; do
    [[ -f "$m" && "$m" != *.tmp ]] || continue
    fired=1
    echo "TRIPWIRE FIRED: $(sed -n 's/^tripwire=//p' "$m") launched by:" >&2
    sed -n -e 's/^caller\.[0-9]*=/  caller: /p' -e 's/^argv\.[0-9]*=/  argv: /p' -e 's/^cwd=/  cwd: /p' -e 's/^env\.\(HOME\|CODEX_HOME\|PATH_FIRST\|TMUX\)=/  env \1=/p' "$m" | head -20 >&2
    echo "  marker: $m" >&2
  done
  [[ -f "$AG_FIRED" ]] && echo "guard watcher stopped the scoped daemon: $(cat "$AG_FIRED")" >&2
  return $((fired))
}

# agent_guard_start_watcher STATE HOME: detached watcher that stops the scoped daemon on a marker.
agent_guard_start_watcher() {
  agent_guard_layout "$1"
  local wfile="$1/guard.pid"
  rm -f "$AG_FIRED" "$wfile"
  python3 - "$wfile" "$1/guard-watch.log" python3 "$AGENT_GUARD_KIT_DIR/guard-watch.py" "$AG_MARKERS" "$AG_FIRED" "$1/daemon.json" "$AG_TMUX" <<'PYSTART' &
import os,sys
pid_file,log,exe,*args=sys.argv[1:]
if os.fork(): os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
open(pid_file,'w').write(str(os.getpid()))
fd=os.open(log,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600); os.dup2(fd,1); os.dup2(fd,2); os.close(fd)
os.execvp(exe,[exe,*args])
PYSTART
  local _
  for _ in {1..30}; do [[ -s "$wfile" ]] && break; sleep 0.1; done
  [[ -s "$wfile" ]] || { echo 'guard watcher did not start' >&2; return 1; }
  cat "$wfile"
}

# agent_guard_fixture STATE NAME ABS_EXEC: register a real fixture binary under a scoped name and
# print the ABSOLUTE path to use as transportConfig.binaryPath. The wrapper is only ever reached by
# absolute path, never through PATH.
agent_guard_fixture() {
  agent_guard_layout "$1"
  local name=$2 target=$3
  [[ "$name" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "fixture name must match [A-Za-z0-9._-]{1,40}" >&2; return 2; }
  [[ "$target" == /* && -x "$target" ]] || { echo "fixture target must be an absolute executable path: $target" >&2; return 2; }
  mkdir -p "$AG_FIXTURES"
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$target" >"$AG_FIXTURES/$name"
  chmod 755 "$AG_FIXTURES/$name"
  echo "$AG_FIXTURES/$name"
}
