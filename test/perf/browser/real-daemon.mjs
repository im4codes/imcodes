import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('/repo/server/node_modules/pg');
const home = process.env.HOME ?? '/tmp/imc-shell-home';
const imcodesHome = process.env.IMCODES_HOME ?? `${home}/.imcodes`;
const serverId = process.env.IMC_PERF_SERVER_ID ?? 'imc_shell_real_server';
const token = process.env.IMC_PERF_DAEMON_TOKEN ?? 'imc-shell-real-daemon-token';
const workerUrl = process.env.IMC_PERF_WORKER_URL ?? 'http://server:19138';
const sessionName = process.env.IMC_PERF_SHELL_SESSION ?? 'deck_shell_perf_brain';
const poolSessionName = process.env.IMC_PERF_POOL_SESSION ?? 'deck_pool_roles_brain';
// Chat session backed by test/perf/browser/fake-qwen.mjs (installed as `qwen`):
// gives the real daemon a genuine accept -> echo -> answer path for send-latency.
const latencySessionName = process.env.IMC_PERF_LATENCY_SESSION ?? 'deck_latency_qwen_brain';
// Keep the isolated project outside the daemon's test-session guard patterns;
// otherwise worker-session sync intentionally deletes the harness row.
const projectDir = '/tmp/imc-shell-browser-project';
const now = Date.now();
const sessionInstanceId = randomUUID();
const runtimeEpoch = randomUUID();
const blockControlFile = process.env.IMCODES_CORE_LANE_TEST_BLOCK_CONTROL_FILE
  ?? `${imcodesHome}/core-lane-block.request`;
const blockMarkerFile = process.env.IMCODES_CORE_LANE_TEST_BLOCK_MARKER_FILE
  ?? `${blockControlFile}.marker`;

await mkdir(imcodesHome, { recursive: true });
await mkdir(projectDir, { recursive: true });
for (const staleFile of [blockControlFile, blockMarkerFile]) {
  try { await unlink(staleFile); } catch { /* first run */ }
}

// The server container applies migrations asynchronously.  Waiting only for
// the container to enter `started` races the first INSERT below (notably the
// node_role column), which leaves the real daemon alive but with no browser
// session.  Probe /health until the post-migration server is actually ready.
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const response = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    if (response.ok) break;
  } catch { /* server is still booting */ }
  if (attempt === 119) throw new Error('test server readiness timeout');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
await writeFile(`${imcodesHome}/server.json`, JSON.stringify({ serverId, token, workerUrl, serverName: 'real shell browser harness', boundAt: now }, null, 2));
await writeFile(`${imcodesHome}/sessions.json`, JSON.stringify({
  version: 2,
  identityPrompts: {},
  sessions: {
    [sessionName]: {
      name: sessionName, projectName: 'shell-perf', role: 'brain', agentType: 'shell', runtimeType: 'process',
      projectDir, state: 'idle', restarts: 0, restartTimestamps: [], createdAt: now, updatedAt: now,
      sessionInstanceId, runtimeEpoch, shellBin: '/bin/bash', userCreated: true,
    },
    [poolSessionName]: {
      name: poolSessionName, projectName: 'shell-perf', role: 'brain', agentType: 'codex-sdk', runtimeType: 'transport',
      projectDir, state: 'idle', restarts: 0, restartTimestamps: [], createdAt: now, updatedAt: now,
      sessionInstanceId: randomUUID(), runtimeEpoch: randomUUID(), requestedModel: 'gpt-6-luna', activeModel: 'gpt-6-luna',
      providerSessionId: `pool-${poolSessionName}`, userCreated: true,
    },
    [latencySessionName]: {
      name: latencySessionName, projectName: 'shell-perf', role: 'brain', agentType: 'qwen', runtimeType: 'transport',
      projectDir, state: 'idle', restarts: 0, restartTimestamps: [], createdAt: now, updatedAt: now,
      sessionInstanceId: randomUUID(), runtimeEpoch: randomUUID(), requestedModel: 'perf-model', activeModel: 'perf-model',
      providerSessionId: `latency-${latencySessionName}`, userCreated: true,
    },
  },
}, null, 2));

const db = new Client({ connectionString: process.env.DATABASE_URL });
for (let attempt = 0; attempt < 60; attempt += 1) {
  try { await db.connect(); break; } catch (error) {
    if (attempt === 59) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
const userId = 'imc_shell_perf_user';
const apiKey = 'imc_shell_perf_browser_key';
const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
const tokenHash = createHash('sha256').update(token).digest('hex');
await db.query('INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, now]);
await db.query(`INSERT INTO api_keys (id, user_id, key_hash, label, created_at)
  VALUES ('imc_shell_perf_browser_key', $1, $2, 'real shell browser harness', $3)
  ON CONFLICT (id) DO UPDATE SET key_hash=EXCLUDED.key_hash, revoked_at=NULL`, [userId, apiKeyHash, now]);
await db.query(`INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role)
  VALUES ($1, $2, 'real shell browser daemon', $3, 'offline', $4, 'full')
  ON CONFLICT (id) DO UPDATE SET token_hash=EXCLUDED.token_hash, user_id=EXCLUDED.user_id`, [serverId, userId, tokenHash, now]);
await db.query(`INSERT INTO sessions (id, server_id, name, project_name, project_dir, role, agent_type, state, created_at, updated_at)
  VALUES ($1, $2, $3, 'shell-perf', $4, 'brain', 'shell', 'idle', $5, $5)
  ON CONFLICT (id) DO UPDATE SET state='idle', updated_at=EXCLUDED.updated_at`, [`shell-perf-${sessionName}`, serverId, sessionName, projectDir, now]);
await db.query(`INSERT INTO sessions (id, server_id, name, project_name, project_dir, role, agent_type, state, created_at, updated_at)
  VALUES ($1, $2, $3, 'shell-perf', $4, 'brain', 'codex-sdk', 'idle', $5, $5)
  ON CONFLICT (id) DO UPDATE SET state='idle', updated_at=EXCLUDED.updated_at`, [`pool-session-${poolSessionName}`, serverId, poolSessionName, projectDir, now]);
await db.query(`INSERT INTO sessions (id, server_id, name, project_name, project_dir, role, agent_type, state, created_at, updated_at)
  VALUES ($1, $2, $3, 'shell-perf', $4, 'brain', 'qwen', 'idle', $5, $5)
  ON CONFLICT (id) DO UPDATE SET state='idle', updated_at=EXCLUDED.updated_at`, [`latency-session-${latencySessionName}`, serverId, latencySessionName, projectDir, now]);
await db.end();

// The shell harness must create an interactive PTY.  Without `-i`, bash
// exits/produces no prompt when tmux starts it detached, leaving the browser's
// xterm mounted but blank on every revision (and making fault/input checks
// impossible to run).
const tmux = spawn('tmux', ['new-session', '-d', '-s', sessionName, '/bin/bash', '-i'], { stdio: 'inherit' });
await new Promise((resolve, reject) => { tmux.once('error', reject); tmux.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`tmux exit ${code}`))); });
let daemonReady = false;
const daemon = spawn('node', ['/repo/dist/src/index.js', 'start', '--foreground'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
const daemonLogPath = `${process.env.IMCODES_HOME ?? `${process.env.HOME}/.imcodes`}/logs/daemon.log`;
const readinessPoll = setInterval(async () => {
  if (daemonReady) return;
  try {
    const log = await readFile(daemonLogPath, 'utf8');
    if (log.includes('ServerLink: connected')) daemonReady = true;
  } catch {
    // The daemon creates its log directory asynchronously during startup.
  }
}, 250);
for (const stream of [daemon.stdout, daemon.stderr]) {
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    process.stdout.write(chunk);
    if (String(chunk).includes('ServerLink: connected')) daemonReady = true;
  });
}
const control = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === '/ready') {
    if (!daemonReady) {
      res.writeHead(503);
      res.end(JSON.stringify({ ready: false, reason: 'daemon_not_connected' }));
      return;
    }
    const ready = spawn('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
    const respond = (ok) => {
      if (res.writableEnded) return;
      res.writeHead(ok ? 200 : 503);
      // Keep the readiness contract identical to the Windows control shim.
      // The synchronized fault harness uses these identities to prove that
      // commands were injected into one stable daemon/shim pair rather than a
      // stale or replacement process.
      res.end(JSON.stringify({
        ready: ok,
        pid: daemon.pid ?? null,
        daemonPid: daemon.pid ?? null,
        shimPid: process.pid,
        sessionName,
        serverId,
      }));
    };
    ready.once('exit', (code) => respond(code === 0));
    ready.once('error', () => respond(false));
    return;
  }
  if (req.url === '/kill') {
    spawn('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    res.writeHead(200); res.end('killed\n');
    return;
  }
  if (req.url === '/block' && req.method === 'POST') {
    // The daemon's gated control-file poll performs the synchronous block on
    // its own main thread.  The parent control server remains responsive and
    // returns only after the start marker proves the block is active.
    try {
      await unlink(blockMarkerFile).catch(() => {});
      writeFile(blockControlFile, JSON.stringify({ requestedAt: Date.now() }), 'utf8')
        .then(async () => {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            try {
              const marker = JSON.parse(await readFile(blockMarkerFile, 'utf8'));
              if (marker?.startedAt && !marker?.endedAt) return marker;
            } catch { /* marker is written by the daemon after the poll tick */ }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error('daemon block-start marker timeout');
        })
        .then((marker) => {
          if (res.writableEnded) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...marker, daemonPid: daemon.pid, shimPid: process.pid }));
        })
        .catch((error) => {
          if (res.writableEnded) return;
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        });
    } catch (error) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
    return;
  }
  if (req.url === '/block-status') {
    readFile(blockMarkerFile, 'utf8').then((contents) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...JSON.parse(contents), daemonPid: daemon.pid, shimPid: process.pid }));
    }).catch(() => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: false }));
    });
    return;
  }
  res.writeHead(200); res.end(JSON.stringify({ sessionName, pid: daemon.pid }));
});
control.listen(19139, '0.0.0.0');
const stop = () => {
  clearInterval(readinessPoll);
  control.close();
  spawn('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  daemon.kill('SIGTERM');
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
daemon.once('exit', (code) => process.exit(code ?? 1));
