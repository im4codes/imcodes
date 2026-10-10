/**
 * Real-machine harness for identity-over-lease (phase 2): a REAL built
 * daemon (this file's own container image builds the real dist/src), bound
 * to the real server, with one seeded session carrying a project context so
 * PROJECT-scope resolveSessionIdentityProjectKey has something to resolve.
 *
 * Mirrors real-daemon.mjs's proven seed/spawn/readiness pattern, trimmed:
 * no tmux/shell PTY (identity content is orthogonal to the session's own
 * agent), plus one extra control endpoint (/local-content) that reads the
 * daemon's own on-disk session-identities.json directly, so the Playwright
 * spec can assert the exact bytes the daemon persisted without needing its
 * own DB/filesystem access into this container.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('/repo/server/node_modules/pg');
const home = process.env.HOME ?? '/tmp/imc-identity-home';
const imcodesHome = process.env.IMCODES_HOME ?? `${home}/.imcodes`;
const serverId = process.env.IMC_PERF_SERVER_ID ?? 'imc_identity_real_server';
const token = process.env.IMC_PERF_DAEMON_TOKEN ?? 'imc-identity-real-daemon-token';
const workerUrl = process.env.IMC_PERF_WORKER_URL ?? 'http://server:19138';
const sessionName = process.env.IMC_PERF_IDENTITY_SESSION ?? 'deck_identity_perf_brain';
const projectId = process.env.IMC_PERF_IDENTITY_PROJECT_ID ?? 'identity-perf-org/identity-perf-repo';
const projectDir = '/tmp/imc-identity-browser-project';
const now = Date.now();
const sessionInstanceId = randomUUID();
const runtimeEpoch = randomUUID();

await mkdir(imcodesHome, { recursive: true });
await mkdir(projectDir, { recursive: true });

// The server container applies migrations asynchronously; probe /health
// until the post-migration server is actually ready (see real-daemon.mjs).
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const response = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    if (response.ok) break;
  } catch { /* server is still booting */ }
  if (attempt === 119) throw new Error('test server readiness timeout');
  await new Promise((resolve) => setTimeout(resolve, 500));
}

await writeFile(`${imcodesHome}/server.json`, JSON.stringify({
  serverId, token, workerUrl, serverName: 'real identity browser harness', boundAt: now,
}, null, 2));
await writeFile(`${imcodesHome}/sessions.json`, JSON.stringify({
  version: 2,
  identityPrompts: {},
  sessions: {
    [sessionName]: {
      name: sessionName, projectName: 'identity-perf', role: 'brain', agentType: 'shell', runtimeType: 'process',
      projectDir, state: 'idle', restarts: 0, restartTimestamps: [], createdAt: now, updatedAt: now,
      sessionInstanceId, runtimeEpoch, shellBin: '/bin/bash', userCreated: true,
      contextNamespace: { scope: 'user_private', userId: 'imc_identity_perf_user', projectId },
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
const userId = 'imc_identity_perf_user';
const apiKey = process.env.IMC_PERF_API_KEY ?? 'imc_identity_perf_browser_key';
const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
const tokenHash = createHash('sha256').update(token).digest('hex');
await db.query('INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, now]);
await db.query(`INSERT INTO api_keys (id, user_id, key_hash, label, created_at)
  VALUES ($3, $1, $2, 'real identity browser harness', $4)
  ON CONFLICT (id) DO UPDATE SET key_hash=EXCLUDED.key_hash, revoked_at=NULL`, [userId, apiKeyHash, apiKey, now]);
await db.query(`INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role)
  VALUES ($1, $2, 'real identity browser daemon', $3, 'offline', $4, 'full')
  ON CONFLICT (id) DO UPDATE SET token_hash=EXCLUDED.token_hash, user_id=EXCLUDED.user_id`, [serverId, userId, tokenHash, now]);
await db.query(`INSERT INTO sessions (id, server_id, name, project_name, project_dir, role, agent_type, state, created_at, updated_at)
  VALUES ($1, $2, $3, 'identity-perf', $4, 'brain', 'shell', 'idle', $5, $5)
  ON CONFLICT (id) DO UPDATE SET state='idle', updated_at=EXCLUDED.updated_at`, [`identity-perf-${sessionName}`, serverId, sessionName, projectDir, now]);
await db.end();

let daemonReady = false;
const daemon = spawn('node', ['/repo/dist/src/index.js', 'start', '--foreground'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
const daemonLogPath = `${imcodesHome}/logs/daemon.log`;
const readinessPoll = setInterval(async () => {
  if (daemonReady) return;
  try {
    const log = await readFile(daemonLogPath, 'utf8');
    if (log.includes('ServerLink: connected')) daemonReady = true;
  } catch { /* the daemon creates its log directory asynchronously during startup */ }
}, 250);
for (const stream of [daemon.stdout, daemon.stderr]) {
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    process.stdout.write(chunk);
    if (String(chunk).includes('ServerLink: connected')) daemonReady = true;
  });
}

/** The daemon's own on-disk identity store -- see src/daemon/session-identity-local-store.ts. */
async function readLocalIdentityStore() {
  try {
    return JSON.parse(await readFile(`${imcodesHome}/session-identities.json`, 'utf8'));
  } catch {
    return { version: 1, profiles: {} };
  }
}

const control = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/ready') {
    res.writeHead(daemonReady ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ready: daemonReady, pid: daemon.pid ?? null, sessionName, serverId }));
    return;
  }
  if (req.url?.startsWith('/local-content')) {
    const url = new URL(req.url, 'http://localhost');
    const scope = url.searchParams.get('scope');
    const scopeKey = url.searchParams.get('scopeKey');
    const store = await readLocalIdentityStore();
    const profile = scope && scopeKey ? store.profiles?.[`${scope}\0${scopeKey}`] : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(profile ?? null));
    return;
  }
  res.writeHead(200); res.end(JSON.stringify({ sessionName, pid: daemon.pid, serverId, projectId }));
});
control.listen(19139, '0.0.0.0');
const stop = () => {
  clearInterval(readinessPoll);
  control.close();
  daemon.kill('SIGTERM');
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
