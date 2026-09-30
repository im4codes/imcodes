#!/usr/bin/env python3
"""Tripwire watcher for a scoped real-machine daemon (see agent-guard.sh).

usage: guard-watch.py MARKERS_DIR FIRED_FILE DAEMON_MANIFEST TMUX_TMPDIR

Polls MARKERS_DIR. The moment a tripwire marker appears it records FIRED_FILE (which marker, its
caller chain) and stops the scoped daemon: SIGTERM to the daemon's process tree (pid from the
owner manifest), SIGKILL after a grace period, then the owner's private tmux server. It only ever
signals processes below the manifest pid; it never matches by name.
"""
import collections, json, os, signal, subprocess, sys, time

markers, fired, manifest, tmux_tmp = sys.argv[1:5]
POLL = 0.25


def tree(root):
    try:
        rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid='], text=True, stderr=subprocess.DEVNULL).splitlines()
    except Exception:
        return []
    kids = collections.defaultdict(list)
    for row in rows:
        p = row.split()
        if len(p) == 2 and p[0].isdigit() and p[1].isdigit():
            kids[int(p[1])].append(int(p[0]))
    seen, order, q = {root}, [], collections.deque([root])
    while q:
        pid = q.popleft()
        order.append(pid)
        for c in kids.get(pid, []):
            if c not in seen:
                seen.add(c)
                q.append(c)
    return order


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop(pids):
    for pid in sorted(pids, reverse=True):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.time() + 4
    while time.time() < deadline and any(alive(p) for p in pids):
        time.sleep(0.2)
    for pid in sorted(pids, reverse=True):
        if alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


def pending():
    try:
        return sorted(f for f in os.listdir(markers) if not f.endswith('.tmp'))
    except OSError:
        return []


while True:
    found = pending()
    if found:
        break
    time.sleep(POLL)

daemon_pid = 0
for _ in range(20):  # the manifest is written right after the daemon starts; wait briefly for it
    try:
        daemon_pid = int(json.load(open(manifest)).get('pid', 0))
        if daemon_pid > 0:
            break
    except Exception:
        pass
    time.sleep(0.25)
victims = tree(daemon_pid) if daemon_pid > 0 else []
first = os.path.join(markers, found[0])
try:
    detail = open(first).read()
except OSError:
    detail = ''
record = {
    'firedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'markers': found,
    'daemonPid': daemon_pid,
    'stopped': victims,
    'first': {k: v for k, v in (line.split('=', 1) for line in detail.splitlines() if '=' in line)
              if k in ('tripwire', 'time', 'cwd') or k.startswith('caller.') or k.startswith('argv.')},
}
tmp = fired + '.tmp'
with open(tmp, 'w') as fh:
    json.dump(record, fh, indent=2)
os.replace(tmp, fired)
stop(victims)
if tmux_tmp and os.path.isdir(tmux_tmp):
    env = dict(os.environ, TMUX_TMPDIR=tmux_tmp)
    env.pop('TMUX', None)
    try:
        subprocess.run(['tmux', 'kill-server'], env=env, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass
