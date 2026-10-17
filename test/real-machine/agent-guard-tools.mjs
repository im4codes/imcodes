#!/usr/bin/env node
// Shared implementation of the agent-CLI guard checks (see agent-guard.sh / agent-guard.ps1).
// One implementation for POSIX and Windows: the shell and PowerShell wrappers only call it.
//
//   node agent-guard-tools.mjs names                       CLI names the guard shadows, one per line
//   node agent-guard-tools.mjs assert  --profile P --state S --bin B --home H --tmux T [--post] [--sep ;|:]
//   node agent-guard-tools.mjs inventory --profile P --out FILE
//   node agent-guard-tools.mjs live --out FILE
//   node agent-guard-tools.mjs compare --before F --after F --profile P --state S   (exit 1 = attributable write)
//   node agent-guard-tools.mjs report --state S                                    (exit 1 = a tripwire fired)
//
// Nothing here reads the process home variable or a tilde: the canonical profile is always an argument.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_CLI_NAMES = ['claude', 'codex', 'gemini', 'opencode', 'qwen', 'cursor-agent', 'agent', 'copilot', 'kimi', 'hermes', 'codebuddy', 'qodercli', 'qoder', 'pi', 'dsh', 'deepseek'];
// Directories under the canonical profile that real agent CLIs write to (forward slashes; joined per platform).
export const REAL_AGENT_DIRS = ['.codex', '.claude', '.gemini', '.qwen', '.cursor', '.copilot', '.kimi', '.hermes', '.codebuddy', '.config/opencode', '.local/share/opencode', '.local/state/opencode', '.cache/opencode', '.config/github-copilot',
  'AppData/Local/opencode', 'AppData/Roaming/opencode'];
const MAX_HASH_BYTES = 8 * 1024 * 1024;
const win = process.platform === 'win32';
const norm = (p) => (win ? p.toLowerCase() : p);

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) { out._.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) out[key] = true; else out[key] = argv[++i];
  }
  return out;
}
const rp = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
const inside = (child, parent) => { const c = norm(child), p = norm(parent); return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep); };
const fail = (lines) => { process.stderr.write(`${Array.isArray(lines) ? lines.join('\n') : lines}\n`); process.exit(1); };

function assertGuard(a) {
  const profile = a.profile;
  const isAbs = (p) => resolve(p) === p || /^([a-zA-Z]:[\\/]|\/)/.test(p);
  if (!profile || !isAbs(profile)) fail(`agent guard: refusing to start: IMCODES_DEFAULT_HOME must be an absolute path (got ${JSON.stringify(profile)})`);
  const prof = rp(profile);
  const realDirs = REAL_AGENT_DIRS.map((d) => rp(join(prof, ...d.split('/'))));
  const state = rp(a.state);
  const home = a.home;
  const planned = {
    HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), GEMINI_CLI_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'),
    TMUX_TMPDIR: a.tmux,
  };
  if (win) { delete planned.TMUX_TMPDIR; Object.assign(planned, { APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') }); } else delete planned.USERPROFILE;
  const problems = [];
  const scoped = { 'agent home': home, 'tripwire bin': a.bin, ...(a.tmux ? { 'tmux tmp': a.tmux } : {}), state: a.state, ...Object.fromEntries(Object.entries(planned).map(([k, v]) => [`planned ${k}`, v])) };
  for (const [label, p] of Object.entries(scoped)) {
    const r = rp(p);
    if (norm(r) === norm(prof)) problems.push(`${label} resolves to the real user home ${prof}`);
    else if (inside(prof, r)) problems.push(`${label} (${r}) contains the real user home ${prof}`);
    for (const d of realDirs) if (inside(r, d)) problems.push(`${label} (${r}) is inside a real agent dir ${d}`);
    const shortTmux = /tmux/i.test(label) && basename(r).startsWith('imc-tmx-') && ['/tmp', rp('/tmp')].includes(dirname(r));
    if (!inside(r, state) && !shortTmux) problems.push(`${label} (${r}) is outside the owner state dir ${state}`);
  }
  if (a.tmux && rp(a.tmux).length + '/tmux-1000/default'.length > 100) problems.push(`TMUX_TMPDIR ${JSON.stringify(a.tmux)} is too long for a unix socket path`);
  if (a.post) {
    for (const [k, v] of Object.entries(planned)) if (!process.env[k] || norm(resolve(process.env[k])) !== norm(resolve(v))) problems.push(`exported ${k}=${JSON.stringify(process.env[k])}, expected the scoped ${JSON.stringify(v)}`);
    const first = (process.env[win ? 'Path' : 'PATH'] ?? process.env.PATH ?? '').split(a.sep || (win ? ';' : ':'))[0];
    if (!first || norm(resolve(first)) !== norm(resolve(a.bin))) problems.push('PATH does not start with the tripwire dir');
  }
  if (problems.length) fail(['agent guard: refusing to start:', ...problems.map((p) => `  - ${p}`)]);
}

function inventory(a0) {
  const a = { ...a0, profile: resolve(a0.profile) }; // normalized: a doubled slash would shift the relative-path slicing below
  const rows = [];
  for (const d of REAL_AGENT_DIRS) {
    const root = join(a.profile, ...d.split('/'));
    if (!existsSync(root)) { rows.push(`${d}\tmissing`); continue; }
    const walk = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { rows.push(`${dir.slice(a.profile.length + 1)}\tunreadable\t${e.code}`); return; }
      for (const ent of entries.sort((x, y) => (x.name < y.name ? -1 : 1))) {
        const p = join(dir, ent.name);
        if (ent.isDirectory() && !ent.isSymbolicLink()) { walk(p); continue; }
        try {
          const st = lstatSync(p);
          let sha = '-';
          if (st.isFile() && st.size <= MAX_HASH_BYTES) sha = createHash('sha256').update(readFileSync(p)).digest('hex');
          rows.push(`${p.slice(a.profile.length + 1).split(sep).join('/')}\t${st.size}\t${st.mtimeNs ?? Math.round(st.mtimeMs * 1e6)}\t${sha}`);
        } catch (e) { rows.push(`${p.slice(a.profile.length + 1)}\tunreadable\t${e.code}`); }
      }
    };
    walk(root);
  }
  writeFileSync(a.out, `${rows.sort().join('\n')}\n`);
}

function liveAgents(a) {
  const names = new Set(['claude', 'codex', 'gemini', 'opencode', 'qwen', 'cursor-agent', 'copilot', 'kimi', 'hermes', 'codebuddy', 'qodercli', 'qoder']);
  const out = [];
  if (win) {
    let rows = [];
    try { rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })); } catch { rows = []; }
    for (const r of [].concat(rows)) {
      const toks = String(r?.CommandLine ?? '').replace(/"/g, '').split(/\s+/).filter(Boolean);
      const exe = basename(toks[0] ?? '').replace(/\.(exe|cmd)$/i, '').toLowerCase();
      const script = ['node', 'python', 'python3'].includes(exe) ? basename(toks[1] ?? '').replace(/\.(js|mjs|cjs|cmd)$/i, '').toLowerCase() : '';
      if (names.has(exe) || names.has(script)) out.push(`${r.ProcessId}\t${String(r.CommandLine).slice(0, 160)}`);
    }
  } else {
    let rows = [];
    try { rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n'); } catch { rows = []; }
    for (const row of rows) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(row);
      if (!m || Number(m[1]) === process.pid || Number(m[1]) === process.ppid) continue;
      const toks = m[2].split(/\s+/);
      const exe = basename(toks[0] ?? '');
      const script = ['node', 'python3', 'python', 'bash', 'sh'].includes(exe) ? basename(toks[1] ?? '') : '';
      if (names.has(exe) || names.has(script)) out.push(`${m[1]}\t${m[2].slice(0, 160)}`);
    }
  }
  writeFileSync(a.out, out.length ? `${out.join('\n')}\n` : '');
}

function load(path) {
  const d = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) { if (!line) continue; const i = line.indexOf('\t'); d.set(line.slice(0, i), line.slice(i + 1)); }
  return d;
}
function procs(path) { try { return readFileSync(`${path}.procs`, 'utf8').split(/\r?\n/).filter((l) => l.trim()); } catch { return []; } }

// Verdict on a before/after inventory pair. FAIL (exit 1) when a change is attributable to the scoped run: the machine had
// no live real agent process at either snapshot (or IMCODES_KIT_ASSUME_QUIESCENT=1), or an added/modified file contains the
// owner's state dir (a rollout/session file whose cwd is the scoped project). Otherwise the diff is printed as inconclusive,
// because a live default daemon legitimately writes there. The tripwire stays the primary detector.
function compare(a0) {
  const a = { ...a0, profile: resolve(a0.profile) };
  const b = load(a.before), c = load(a.after);
  const added = [...c.keys()].filter((k) => !b.has(k)).sort();
  const removed = [...b.keys()].filter((k) => !c.has(k)).sort();
  const modified = [...c.keys()].filter((k) => b.has(k) && b.get(k) !== c.get(k)).sort();
  const live = [...procs(a.before), ...procs(a.after)];
  const quiet = live.length === 0 || process.env.IMCODES_KIT_ASSUME_QUIESCENT === '1';
  const ownerRef = [];
  for (const k of [...added, ...modified]) {
    const p = join(a.profile, ...k.split('/'));
    try { if (lstatSync(p).size <= MAX_HASH_BYTES && readFileSync(p).includes(Buffer.from(a.state))) ownerRef.push(k); } catch { /* gone or unreadable */ }
  }
  const say = (s) => process.stderr.write(`${s}\n`);
  say(`real agent dirs: ${added.length} added, ${modified.length} modified, ${removed.length} removed; live real agent processes: ${live.length}`);
  for (const [label, items] of [['added', added], ['modified', modified], ['removed', removed]]) {
    for (const k of items.slice(0, 15)) say(`  ${label}: ${k}`);
    if (items.length > 15) say(`  ... ${items.length - 15} more ${label}`);
  }
  if (ownerRef.length) { say(`FAIL: these files reference the scoped run (${a.state}): ${ownerRef.slice(0, 10).join(', ')}`); process.exit(1); }
  if ((added.length || modified.length || removed.length) && quiet) { say('FAIL: the machine had no live real agent process, so every change to its agent dirs came from the scoped run'); process.exit(1); }
  if (added.length || modified.length || removed.length) say(`INCONCLUSIVE (not a failure): real agent processes were live on this machine: ${live.slice(0, 8).map((l) => l.split('\t')[0]).join('; ')}; the tripwire is the authoritative detector here`);
}

function report(a) {
  const markers = join(a.state, 'agent-guard', 'markers');
  let fired = 0;
  const files = existsSync(markers) ? readdirSync(markers).filter((f) => !f.endsWith('.tmp')).sort() : [];
  const say = (s) => process.stderr.write(`${s}\n`);
  for (const f of files) {
    fired += 1;
    const lines = readFileSync(join(markers, f), 'utf8').split('\n');
    const get = (re) => lines.filter((l) => re.test(l));
    say(`TRIPWIRE FIRED: ${(get(/^tripwire=/)[0] ?? '').replace('tripwire=', '')} launched by:`);
    for (const l of get(/^cwd=/)) say(`  cwd: ${l.slice(4)}`);
    for (const l of get(/^argv\.\d+=/).slice(0, 8)) say(`  argv: ${l.replace(/^argv\.\d+=/, '')}`);
    for (const l of get(/^caller\.\d+=/).slice(0, 8)) say(`  caller: ${l.replace(/^caller\.\d+=/, '')}`);
    for (const l of get(/^env\.(HOME|USERPROFILE|CODEX_HOME|PATH_FIRST|TMUX)=/)) say(`  env ${l.slice(4).replace('=', '=')}`);
    say(`  marker: ${join(markers, f)}`);
  }
  const firedFile = join(a.state, 'tripwire.fired.json');
  if (existsSync(firedFile)) say(`guard watcher stopped the scoped daemon: ${readFileSync(firedFile, 'utf8')}`);
  process.exit(fired ? 1 : 0);
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  switch (cmd) {
    case 'names': process.stdout.write(`${AGENT_CLI_NAMES.join('\n')}\n`); break;
    case 'assert': assertGuard(a); break;
    case 'inventory': inventory(a); break;
    case 'live': liveAgents(a); break;
    case 'compare': compare(a); break;
    case 'report': report(a); break;
    default: fail('usage: agent-guard-tools.mjs names|assert|inventory|live|compare|report ...');
  }
}
