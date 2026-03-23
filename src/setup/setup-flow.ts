/**
 * `imcodes setup --domain <domain>` — one-click server + daemon deployment.
 *
 * 1. Check prerequisites (docker, docker compose, ports)
 * 2. Generate .env, docker-compose.yml, Caddyfile
 * 3. Two-phase Docker startup (postgres → server → bootstrap DB → caddy)
 * 4. Self-bind daemon (write server.json, install service)
 * 5. Print credentials
 */

import { randomBytes, createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { DOCKER_COMPOSE_TEMPLATE, caddyfileTemplate, envTemplate } from './templates.js';

const CREDS_DIR = join(homedir(), '.imcodes');
const CREDS_PATH = join(CREDS_DIR, 'server.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function fatal(msg: string): never {
  console.error(`\n  Error: ${msg}`);
  process.exit(1);
}

/** Try `docker compose` (v2 plugin) then `docker-compose` (v1 standalone). */
function detectDockerCompose(): string {
  try {
    execSync('docker compose version', { stdio: 'ignore' });
    return 'docker compose';
  } catch { /* try v1 */ }
  try {
    execSync('docker-compose version', { stdio: 'ignore' });
    return 'docker-compose';
  } catch { /* not found */ }
  fatal('docker compose not found. Install Docker: https://docs.docker.com/get-docker/');
}

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function runQuiet(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// ── Prerequisite checks ──────────────────────────────────────────────────────

function checkPrerequisites(): string {
  // Docker
  try {
    execSync('docker info', { stdio: 'ignore' });
  } catch {
    fatal('Docker is not running. Start Docker and try again.');
  }

  // Docker Compose
  const compose = detectDockerCompose();

  return compose;
}

function checkExistingSetup(dir: string, force: boolean): void {
  if (existsSync(join(dir, '.env')) && !force) {
    fatal('Setup already exists in this directory. Use --force to overwrite.');
  }
}

function checkDns(domain: string): void {
  try {
    const result = execFileSync('dig', ['+short', domain], { encoding: 'utf8', timeout: 5000 }).trim();
    if (!result) {
      console.warn(`\n  Warning: DNS for ${domain} does not resolve. Make sure your A record is configured.`);
    }
  } catch {
    // dig not available, skip check
  }
}

// ── Config generation ────────────────────────────────────────────────────────

interface SetupSecrets {
  postgresPassword: string;
  jwtSigningKey: string;
  adminPassword: string;
  serverToken: string;
  serverId: string;
  apiKeyRaw: string;
  apiKeyId: string;
}

function generateSecrets(): SetupSecrets {
  return {
    postgresPassword: randomHex(16),
    jwtSigningKey: randomHex(32),
    adminPassword: randomHex(16),
    serverToken: randomHex(32),
    serverId: randomHex(16),
    apiKeyRaw: `deck_${randomHex(32)}`,
    apiKeyId: randomHex(16),
  };
}

async function writeConfigs(dir: string, domain: string, secrets: SetupSecrets): Promise<void> {
  await writeFile(join(dir, '.env'), envTemplate({
    domain,
    postgresPassword: secrets.postgresPassword,
    jwtSigningKey: secrets.jwtSigningKey,
    adminPassword: secrets.adminPassword,
  }));

  await writeFile(join(dir, 'docker-compose.yml'), DOCKER_COMPOSE_TEMPLATE);
  await writeFile(join(dir, 'Caddyfile'), caddyfileTemplate(domain));
}

// ── Docker lifecycle ────────────────────────────────────────────────────────

function composeCmd(compose: string, dir: string, args: string): void {
  run(`${compose} -f ${join(dir, 'docker-compose.yml')} --env-file ${join(dir, '.env')} ${args}`, dir);
}

function composeCmdQuiet(compose: string, dir: string, args: string): string {
  return runQuiet(`${compose} -f ${join(dir, 'docker-compose.yml')} --env-file ${join(dir, '.env')} ${args}`, dir);
}

async function waitForService(compose: string, dir: string, service: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const health = composeCmdQuiet(compose, dir, `ps --format json ${service}`);
      // docker compose ps --format json outputs one JSON object per line
      for (const line of health.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.Health === 'healthy' || obj.State === 'running') return;
        } catch { /* not JSON */ }
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  fatal(`Timed out waiting for ${service} to be ready.`);
}

// ── Database bootstrap ──────────────────────────────────────────────────────

function buildBootstrapSQL(secrets: SetupSecrets): string {
  const now = Date.now();
  const keyHash = sha256Hex(secrets.apiKeyRaw);
  const tokenHash = sha256Hex(secrets.serverToken);
  const serverName = hostname();

  return `
-- Bootstrap: create API key and server record for setup self-bind.
-- Admin user is created by the server's ensureDefaultAdmin on startup.

INSERT INTO api_keys (id, user_id, key_hash, label, created_at)
VALUES (
  $$${secrets.apiKeyId}$$,
  (SELECT id FROM users WHERE username = 'admin'),
  $$${keyHash}$$,
  $$setup-bootstrap$$,
  ${now}
);

INSERT INTO servers (id, user_id, name, token_hash, bound_with_key_id, status, created_at)
VALUES (
  $$${secrets.serverId}$$,
  (SELECT id FROM users WHERE username = 'admin'),
  $$${serverName}$$,
  $$${tokenHash}$$,
  $$${secrets.apiKeyId}$$,
  'online',
  ${now}
);
`;
}

function bootstrapDatabase(compose: string, dir: string, secrets: SetupSecrets): void {
  const sql = buildBootstrapSQL(secrets);
  try {
    execSync(
      `${compose} -f ${join(dir, 'docker-compose.yml')} --env-file ${join(dir, '.env')} exec -T postgres psql -U imcodes -d imcodes`,
      { input: sql, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err: any) {
    const stderr = err?.stderr?.toString() || '';
    if (stderr.includes('duplicate key') || stderr.includes('already exists')) {
      log('Database records already exist (re-setup). Continuing.');
    } else {
      fatal(`Database bootstrap failed: ${stderr || err.message}`);
    }
  }
}

// ── Self-binding ────────────────────────────────────────────────────────────

async function selfBind(secrets: SetupSecrets): Promise<void> {
  await mkdir(CREDS_DIR, { recursive: true });
  const creds = {
    serverId: secrets.serverId,
    token: secrets.serverToken,
    workerUrl: 'http://localhost:19138',
    serverName: hostname(),
    boundAt: Date.now(),
  };
  await writeFile(CREDS_PATH, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function installService(): void {
  if (process.platform === 'linux') {
    installSystemdService();
  } else if (process.platform === 'darwin') {
    console.log('  Run "imcodes start" to start the daemon on macOS.');
  } else {
    console.log('  Run "imcodes start" to start the daemon.');
  }
}

function installSystemdService(): void {
  const serviceDir = join(homedir(), '.config', 'systemd', 'user');
  const servicePath = join(serviceDir, 'imcodes.service');
  const nodeExec = process.execPath;
  const imcodesPath = process.argv[1];
  const logPath = join(CREDS_DIR, 'daemon.log');

  const unit = `[Unit]
Description=IM.codes Daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodeExec} ${imcodesPath} start --foreground
Restart=on-failure
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;

  execSync(`mkdir -p "${serviceDir}"`);
  writeFileSync(servicePath, unit);
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    execSync('systemctl --user enable imcodes', { stdio: 'ignore' });
    execSync('systemctl --user restart imcodes', { stdio: 'ignore' });
    // Enable lingering so the service runs without active login session
    execSync('loginctl enable-linger', { stdio: 'ignore' });
  } catch {
    console.log('  Could not start systemd service automatically. Run: systemctl --user start imcodes');
  }
}

// ── Main flow ───────────────────────────────────────────────────────────────

export async function setupFlow(domain: string, opts: { force?: boolean } = {}): Promise<void> {
  const dir = process.cwd();

  console.log('\n  IM.codes Setup\n');

  // 1. Prerequisites
  log('Checking prerequisites...');
  const compose = checkPrerequisites();
  checkExistingSetup(dir, opts.force ?? false);
  checkDns(domain);

  // 2. Generate config
  log('Generating configuration...');
  const secrets = generateSecrets();
  await writeConfigs(dir, domain, secrets);
  log('Created .env, docker-compose.yml, Caddyfile');

  // 3. Phase 1: Start PostgreSQL
  log('Starting PostgreSQL...');
  composeCmd(compose, dir, 'up -d postgres');
  await waitForService(compose, dir, 'postgres');
  log('PostgreSQL ready.');

  // 4. Phase 2: Start server (runs migrations + creates admin)
  log('Starting server...');
  composeCmd(compose, dir, 'up -d server');
  // Wait a bit for migrations + admin creation
  await new Promise(r => setTimeout(r, 5000));
  await waitForService(compose, dir, 'server');
  log('Server ready.');

  // 5. Phase 3: Bootstrap database (api_keys + servers)
  log('Bootstrapping database...');
  bootstrapDatabase(compose, dir, secrets);
  log('Database bootstrapped.');

  // 6. Phase 4: Start remaining services
  log('Starting Caddy and Watchtower...');
  composeCmd(compose, dir, 'up -d');
  log('All services running.');

  // 7. Self-bind
  log('Binding daemon to local server...');
  await selfBind(secrets);
  installService();
  log('Daemon bound and running.');

  // 8. Print summary
  const bindUrl = `https://${domain}/bind/${secrets.apiKeyRaw}`;
  console.log(`
  ┌──────────────────────────────────────────────────────┐
  │  IM.codes server running at https://${domain}
  │
  │  Admin login:    admin / ${secrets.adminPassword}
  │  Bind URL:       ${bindUrl}
  │
  │  This machine is bound and daemon is running.
  │
  │  To connect another machine:
  │    npm install -g imcodes
  │    imcodes bind ${bindUrl}
  └──────────────────────────────────────────────────────┘
`);
}
