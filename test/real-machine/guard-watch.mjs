#!/usr/bin/env node
// Tripwire watcher for a scoped real-machine daemon (see agent-guard.sh / agent-guard.ps1).
//
//   node guard-watch.mjs MARKERS_DIR FIRED_FILE DAEMON_MANIFEST TMUX_TMPDIR
//
// Polls MARKERS_DIR. The moment a tripwire marker appears it records FIRED_FILE (which marker, its caller
// chain) and stops the scoped daemon: its process tree (pid from the owner manifest) gets SIGTERM (Windows:
// taskkill /T /F), SIGKILL after a grace period, then the owner's private tmux server. It only ever signals
// processes below the manifest pid; it never matches by name. Same code on POSIX and Windows.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const [markers, fired, manifest, tmuxTmp] = process.argv.slice(2);
const win = process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tree(root) {
  if (win) return [root];
  let rows = [];
  try { rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).split('\n'); } catch { return [root]; }
  const kids = new Map();
  for (const row of rows) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
    if (m) kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), Number(m[1])]);
  }
  const seen = new Set([root]); const order = []; const queue = [root];
  while (queue.length) { const pid = queue.shift(); order.push(pid); for (const c of kids.get(pid) ?? []) if (!seen.has(c)) { seen.add(c); queue.push(c); } }
  return order;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function stop(pids) {
  if (win) { for (const pid of pids) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ } } return; }
  for (const pid of [...pids].reverse()) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && pids.some(alive)) await sleep(200);
  for (const pid of [...pids].reverse()) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
const pending = () => { try { return readdirSync(markers).filter((f) => !f.endsWith('.tmp')).sort(); } catch { return []; } };

let found = pending();
while (found.length === 0) { await sleep(250); found = pending(); }
let daemonPid = 0;
for (let i = 0; i < 20 && daemonPid <= 0; i += 1) {
  try { daemonPid = Number(JSON.parse(readFileSync(manifest, 'utf8')).pid) || 0; } catch { /* manifest not written yet */ }
  if (daemonPid <= 0) await sleep(250);
}
const victims = daemonPid > 0 ? tree(daemonPid) : [];
let detail = '';
try { detail = readFileSync(`${markers}/${found[0]}`, 'utf8'); } catch { /* raced with cleanup */ }
const first = {};
for (const line of detail.split('\n')) {
  const i = line.indexOf('=');
  if (i > 0) { const k = line.slice(0, i); if (['tripwire', 'time', 'cwd'].includes(k) || k.startsWith('caller.') || k.startsWith('argv.')) first[k] = line.slice(i + 1); }
}
writeFileSync(`${fired}.tmp`, JSON.stringify({ firedAt: new Date().toISOString(), markers: found, daemonPid, stopped: victims, first }, null, 2));
renameSync(`${fired}.tmp`, fired);
await stop(victims);
if (!win && tmuxTmp && existsSync(tmuxTmp)) {
  try { const env = { ...process.env, TMUX_TMPDIR: tmuxTmp }; delete env.TMUX; execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore', timeout: 10_000 }); } catch { /* no server */ }
}
