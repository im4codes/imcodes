import { mkdir, writeFile } from 'node:fs/promises';
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
// Keep the isolated project outside the daemon's test-session guard patterns;
// otherwise worker-session sync intentionally deletes the harness row.
const projectDir = '/tmp/imc-shell-browser-project';
const now = Date.now();
const sessionInstanceId = randomUUID();
const runtimeEpoch = randomUUID();

await mkdir(imcodesHome, { recursive: true });
await mkdir(projectDir, { recursive: true });
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
await db.end();

const tmux = spawn('tmux', ['new-session', '-d', '-s', sessionName, '/bin/bash'], { stdio: 'inherit' });
await new Promise((resolve, reject) => { tmux.once('error', reject); tmux.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`tmux exit ${code}`))); });
const daemon = spawn('node', ['/repo/dist/src/index.js', 'start', '--foreground'], { stdio: 'inherit', env: process.env });
const control = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/kill') {
    spawn('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    res.writeHead(200); res.end('killed\n');
    return;
  }
  res.writeHead(200); res.end(JSON.stringify({ sessionName, pid: daemon.pid }));
});
control.listen(19139, '0.0.0.0');
const stop = () => {
  control.close();
  spawn('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  daemon.kill('SIGTERM');
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
daemon.once('exit', (code) => process.exit(code ?? 1));
