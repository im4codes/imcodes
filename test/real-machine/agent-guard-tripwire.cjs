// Windows tripwire core (plain CommonJS, node builtins only). One tiny tripwire-<name>.js per agent CLI
// requires this file next to it; <name>.cmd is an npm-shaped shim that runs it with node, so both a plain
// `cmd` lookup and the daemon's own resolver (resolveExecutableForSpawn -> parseNpmCmdShim) land here.
// The marker format is the one the POSIX tripwire writes, so the report/watcher code is shared.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const KEYS = /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|CODEX_HOME|CLAUDE_CONFIG_DIR|GEMINI_CLI_HOME|XDG_[A-Z]+_HOME|IMCODES_HOME|IMCODES_KIT_[A-Z_]*|USERNAME)$/i;
const SECRET_FLAG = /(key|token|secret|password|passwd)$/i;
const SECRET_KV = /(key|token|secret|password|passwd)[A-Za-z_-]*=/i;

module.exports = function tripwire(name) {
  const markers = path.join(__dirname, '..', 'markers');
  const base = path.join(markers, `${name}.${process.pid}.${Math.floor(Date.now() / 1000)}`);
  const lines = [`tripwire=${name}`, `pid=${process.pid}`, `ppid=${process.ppid}`, `time=${new Date().toISOString()}`, `cwd=${process.cwd()}`];
  let prev = '';
  process.argv.slice(2).forEach((arg, i) => {
    let val = arg.replace(/[\r\n]+/g, ' ');
    if (SECRET_FLAG.test(prev)) val = '[REDACTED]';
    if (SECRET_KV.test(arg)) val = `${val.split('=')[0]}=[REDACTED]`;
    lines.push(`argv.${i + 1}=${val}`);
    prev = arg;
  });
  for (const [k, v] of Object.entries(process.env)) if (KEYS.test(k)) lines.push(`env.${k}=${v}`);
  lines.push(`env.PATH_FIRST=${String(process.env.Path || process.env.PATH || '').split(';')[0]}`);
  const write = (extra) => {
    fs.mkdirSync(markers, { recursive: true });
    fs.writeFileSync(`${base}.tmp`, `${[...lines, ...extra].join('\n')}\n`);
    fs.renameSync(`${base}.tmp`, base);
  };
  // 1. the marker exists immediately (a daemon may kill this process before step 2 finishes) ...
  write([`caller.1=${process.ppid}`]);
  // 2. ... then it is enriched with the caller chain (PowerShell start-up can take seconds on a busy host).
  try {
    const rows = [].concat(JSON.parse(cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 })));
    const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
    const chain = [];
    for (let pid = process.ppid, n = 0; pid > 4 && byPid.has(pid) && n < 8; n += 1) {
      const r = byPid.get(pid);
      chain.push(`caller.${n + 1}=${pid} ${String(r.CommandLine || '').replace(/[\r\n]+/g, ' ').replace(/((key|token|secret|password)[A-Za-z_-]*[= ])\S+/gi, '$1[REDACTED]').slice(0, 300)}`);
      pid = r.ParentProcessId;
    }
    if (chain.length) write(chain);
  } catch { /* the immediate marker stays */ }
  process.stderr.write(`kit tripwire: refusing to run the real agent CLI '${name}' in a scoped real-machine run; pin transportConfig.binaryPath to a fixture (absolute path) instead. Marker: ${base}\n`);
  process.exit(97);
};
