// Test-only Windows ConPTY control shim for shell-stream.spec.mjs.
// It never injects input into the daemon: readiness is read from the
// authenticated server session list, and recovery kills/relaunches the real
// daemon process tree.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const nodeExe = process.env.IMC_WIN_NODE ?? 'C:\\Program Files\\nodejs\\node.exe';
const daemonEntry = process.env.IMC_WIN_DAEMON_ENTRY ?? 'C:\\core-lane-f27\\dist\\src\\index.js';
const daemonCwd = process.env.IMC_WIN_DAEMON_CWD ?? 'C:\\core-lane-f27';
const home = process.env.IMC_WIN_HOME ?? 'C:\\core-lane-f27-home';
// IMCODES_HOME is a state-directory path, not a parent HOME. Keep the
// harness HOME (used for shim lock/marker files) separate so a scoped daemon
// reads credentials produced by `imcodes bind` from the exact directory.
const stateHome = process.env.IM_WIN_IMCODES_HOME ?? home;
const serverUrl = (process.env.IMC_WIN_SERVER_URL ?? 'http://172.16.253.211:21480').replace(/\/$/, '');
const serverId = process.env.IMC_WIN_SERVER_ID ?? 'imc_shell_real_server';
const sessionName = process.env.IMC_WIN_SESSION ?? 'deck_shell_perf_brain';
const token = process.env.IMC_WIN_JWT_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const apiKey = process.env.IMC_WIN_API_KEY?.trim();
const port = Number(process.env.IMC_WIN_CONTROL_PORT ?? 19139);
const shimLockPath = `${home}\\.imcodes\\windows-control-shim-${port}.lock`;
const blockControlFile = process.env.IMC_WIN_BLOCK_CONTROL_FILE ?? `${home}\\.imcodes\\core-lane-block.request`;
const blockMarkerFile = process.env.IMC_WIN_BLOCK_MARKER_FILE ?? `${blockControlFile}.marker`;
const shimLogPath = process.env.IMC_WIN_SHIM_LOG ?? `${home}\\.imcodes\\windows-control-shim-${port}.log`;
let daemon;
let daemonSpawnedAt = 0;

function clearBlockFiles() {
  for (const path of [blockControlFile, blockMarkerFile]) {
    try { fs.unlinkSync(path); } catch { /* absent or already consumed */ }
  }
}

function shimLog(message, fields = {}) {
  try { fs.appendFileSync(shimLogPath, `${new Date().toISOString()} ${message} ${JSON.stringify(fields)}\\n`, 'utf8'); } catch { /* diagnostics only */ }
}

function acquireShimLock() {
  fs.mkdirSync(`${home}\\.imcodes`, { recursive: true });
  try {
    const fd = fs.openSync(shimLockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port, home }), 'utf8');
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      const owner = JSON.parse(fs.readFileSync(shimLockPath, 'utf8'));
      try { process.kill(Number(owner.pid), 0); return false; } catch { /* stale owner */ }
    } catch { /* stale/corrupt marker */ }
    try { fs.unlinkSync(shimLockPath); } catch { return false; }
    const fd = fs.openSync(shimLockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port, home }), 'utf8');
    fs.closeSync(fd);
    return true;
  }
}

if (!acquireShimLock()) {
  process.stderr.write(`windows-control-shim already owns home=${home} port=${port}\\n`);
  process.exit(2);
}

function jwt() {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const input = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ sub: 'imc_shell_perf_user', role: 'owner', type: 'web', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }))}`;
  return `${input}.${crypto.createHmac('sha256', token).update(input).digest('base64url')}`;
}

function spawnDaemon() {
  // A request left by a previous browser process must never be consumed by
  // the daemon's first ServerLink connection.  The harness only issues a
  // request after /ready confirms that connection is live.
  clearBlockFiles();
  daemonSpawnedAt = Date.now();
  daemon = spawn(nodeExe, [daemonEntry, 'start', '--foreground'], {
    cwd: daemonCwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      IMCODES_HOME: stateHome,
      IMCODES_TEST_DAEMON_LOCK_PIPE: process.env.IMCODES_TEST_DAEMON_LOCK_PIPE ?? '\\\\.\\pipe\\imc-core-lane-f27',
      IMCODES_CORE_LANE_TEST_BLOCK_CONTROL_FILE: blockControlFile,
      IMCODES_CORE_LANE_TEST_BLOCK_MARKER_FILE: blockMarkerFile,
    },
    stdio: ['ignore', fs.openSync(shimLogPath, 'a'), fs.openSync(shimLogPath, 'a')],
    windowsHide: true,
  });
  shimLog('daemon_spawned', { pid: daemon.pid, nodeExe, daemonEntry });
  daemon.once('exit', (code, signal) => {
    shimLog('daemon_exit', { pid: daemon?.pid, code, signal });
    daemon = undefined;
  });
}

export function serverLinkReadyFromLog(contents, spawnedAt) {
  return contents.split(/\r?\n/).slice(-200).some((line) => {
    if (!line.includes('"msg":"ServerLink: connected"')) return false;
    try {
      const record = JSON.parse(line);
      return Number(record.time) >= spawnedAt;
    } catch {
      return false;
    }
  });
}

function serverLinkReady() {
  const logPath = process.env.IMC_WIN_DAEMON_LOG ?? `${stateHome}\\logs\\daemon.log`;
  try {
    return serverLinkReadyFromLog(fs.readFileSync(logPath, 'utf8'), daemonSpawnedAt);
  } catch {
    return false;
  }
}

function readBlockMarker() {
  try { return JSON.parse(fs.readFileSync(blockMarkerFile, 'utf8')); } catch { return null; }
}

async function waitForBlockStart(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const marker = readBlockMarker();
    if (marker?.startedAt && marker.pid === pid && !marker.endedAt) return marker;
    if (!daemon?.pid || daemon.pid !== pid) throw new Error(`daemon PID changed during block request (${pid} -> ${daemon?.pid ?? 'none'})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for daemon block-start marker');
}

async function sessionReady() {
  if (!daemon?.pid || !serverLinkReady()) return false;
  try {
    const response = await fetch(`${serverUrl}/api/server/${encodeURIComponent(serverId)}/sessions`, {
      headers: apiKey
        ? { authorization: `Bearer ${apiKey}` }
        : { cookie: `rcc_session=${jwt()}; rcc_csrf=imc-shell-perf-csrf-token` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return Array.isArray(payload?.sessions) && payload.sessions.some((item) => item.name === sessionName);
  } catch { return false; }
}

function startShim() {
spawnDaemon();
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.url === '/ready') {
    const ready = await sessionReady();
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready, pid: daemon?.pid ?? null, shimPid: process.pid, port, serverId, sessionName }));
    return;
  }
  if (request.url === '/block') {
    const pid = daemon?.pid;
    if (!pid) { response.writeHead(503); response.end(JSON.stringify({ error: 'daemon_not_running' })); return; }
    try {
      try { fs.unlinkSync(blockMarkerFile); } catch { /* stale marker */ }
      fs.writeFileSync(blockControlFile, JSON.stringify({ requestedAt: Date.now(), pid }), { encoding: 'utf8', flag: 'wx' });
      const marker = await waitForBlockStart(pid);
      shimLog('block_started', marker);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...marker, daemonPid: pid, shimPid: process.pid, port }));
    } catch (error) {
      shimLog('block_failed', { error: String(error), pid, currentPid: daemon?.pid ?? null });
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error), daemonPid: daemon?.pid ?? null, shimPid: process.pid, port }));
    }
    return;
  }
  if (request.url === '/block-status') {
    const marker = readBlockMarker();
    response.writeHead(marker ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ...marker, daemonPid: daemon?.pid ?? null, shimPid: process.pid, port }));
    return;
  }
  if (request.url === '/kill') {
    const pid = daemon?.pid;
    if (pid) {
      shimLog('daemon_kill_requested', { pid });
      spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      daemon = undefined;
      setTimeout(spawnDaemon, 1_000).unref?.();
    }
    response.writeHead(200);
    response.end('relaunch scheduled\n');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ pid: daemon?.pid ?? null }));
});
server.listen(port, '0.0.0.0');
const stop = () => {
  shimLog('shim_stop', { daemonPid: daemon?.pid ?? null });
  server.close();
  if (daemon?.pid) spawn('taskkill.exe', ['/PID', String(daemon.pid), '/T', '/F'], { windowsHide: true });
  try { fs.unlinkSync(shimLockPath); } catch { /* already cleaned */ }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', () => { try { fs.unlinkSync(shimLockPath); } catch { /* already cleaned */ } });
}

// Importing this module in a focused unit test must not spawn a daemon or bind
// a control port.  The production/test harness path executes the normal
// startup when run as a script.
if (process.env.IMC_WIN_SHIM_UNIT_TEST !== '1') startShim();
