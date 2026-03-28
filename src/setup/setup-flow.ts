/**
 * `imcodes setup --domain <domain>` — one-click server + daemon deployment.
 *
 * 1. Check prerequisites (docker, docker compose, ports)
 * 2. Generate .env, docker-compose.yml, Caddyfile (or reuse existing)
 * 3. Two-phase Docker startup (postgres → server → bootstrap DB → caddy)
 * 4. Self-bind daemon (write server.json, install service)
 * 5. Print credentials
 *
 * Supports resumable execution: if .env already exists, secrets are read from
 * it and only missing steps are executed. Use --force to regenerate everything.
 */

import { randomBytes, createHash } from 'node:crypto';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
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

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/** Stop and remove all containers, volumes, and config files for a clean reinstall. */
function teardown(compose: string, dir: string): void {
  log('Stopping and removing all containers and volumes...');
  try {
    execSync(
      `${compose} -f ${join(dir, 'docker-compose.yml')} --env-file ${join(dir, '.env')} down -v --remove-orphans`,
      { cwd: dir, stdio: 'inherit' },
    );
  } catch {
    // compose down may fail if services never started — that's fine
  }
  // Remove generated config files
  for (const file of ['.env', '.setup-secrets.json', 'docker-compose.yml', 'Caddyfile']) {
    const p = join(dir, file);
    if (existsSync(p)) {
      execSync(`rm -f "${p}"`);
    }
  }
  log('Previous setup removed.');
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

/** Parse existing .env to recover secrets that were generated in a previous run. */
function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return env;
}

/** Read existing .env + setup-secrets.json to recover all secrets for resume. */
async function recoverSecrets(dir: string): Promise<SetupSecrets | null> {
  const envPath = join(dir, '.env');
  const secretsPath = join(dir, '.setup-secrets.json');

  if (!existsSync(envPath)) return null;

  const envContent = await readFile(envPath, 'utf8');
  const env = parseEnvFile(envContent);

  // .setup-secrets.json stores the non-env secrets (serverToken, serverId, apiKey*)
  if (!existsSync(secretsPath)) return null;

  try {
    const raw = JSON.parse(await readFile(secretsPath, 'utf8'));
    return {
      postgresPassword: env['POSTGRES_PASSWORD'] ?? raw.postgresPassword,
      jwtSigningKey: env['JWT_SIGNING_KEY'] ?? raw.jwtSigningKey,
      adminPassword: env['DEFAULT_ADMIN_PASSWORD'] ?? raw.adminPassword,
      serverToken: raw.serverToken,
      serverId: raw.serverId,
      apiKeyRaw: raw.apiKeyRaw,
      apiKeyId: raw.apiKeyId,
    };
  } catch {
    return null;
  }
}

/** Persist non-env secrets so we can recover them on resume. */
async function persistSecrets(dir: string, secrets: SetupSecrets): Promise<void> {
  const secretsPath = join(dir, '.setup-secrets.json');
  await writeFile(secretsPath, JSON.stringify({
    postgresPassword: secrets.postgresPassword,
    jwtSigningKey: secrets.jwtSigningKey,
    adminPassword: secrets.adminPassword,
    serverToken: secrets.serverToken,
    serverId: secrets.serverId,
    apiKeyRaw: secrets.apiKeyRaw,
    apiKeyId: secrets.apiKeyId,
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
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

/** Check if a service is already running and healthy. */
function isServiceHealthy(compose: string, dir: string, service: string): boolean {
  try {
    const health = composeCmdQuiet(compose, dir, `ps --format json ${service}`);
    for (const line of health.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.Health === 'healthy' || obj.State === 'running') return true;
      } catch { /* not JSON */ }
    }
  } catch { /* not running */ }
  return false;
}

async function waitForService(compose: string, dir: string, service: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isServiceHealthy(compose, dir, service)) return;
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

  // 1. Prerequisites (check before touching any files)
  log('Checking prerequisites...');
  const compose = checkPrerequisites();
  checkDns(domain);

  // 2. Recover or generate secrets
  let secrets: SetupSecrets;
  let resumed = false;

  if (opts.force && existsSync(join(dir, '.env'))) {
    console.warn('\n  ⚠  --force will destroy the existing setup:');
    console.warn('     • Stop and remove all Docker containers');
    console.warn('     • Delete all data volumes (PostgreSQL data, Caddy certs)');
    console.warn('     • Regenerate all secrets and credentials');
    console.warn('     • All existing users, sessions, and API keys will be lost\n');
    const ok = await confirm('Are you sure you want to start fresh?');
    if (!ok) {
      log('Aborted.');
      process.exit(0);
    }
    teardown(compose, dir);
  }

  if (!opts.force) {
    const existing = await recoverSecrets(dir);
    if (existing) {
      secrets = existing;
      resumed = true;
      log('Resuming previous setup (existing .env + secrets found).');
    } else if (existsSync(join(dir, '.env'))) {
      // .env exists but no .setup-secrets.json — can't safely resume
      fatal('Incomplete setup state: .env exists but secrets file is missing. Use --force to start fresh.');
    } else {
      secrets = generateSecrets();
    }
  } else {
    secrets = generateSecrets();
  }

  // 3. Write config files (always write to ensure they match current secrets)
  if (!resumed) {
    log('Generating configuration...');
  } else {
    log('Updating configuration files...');
  }
  await writeConfigs(dir, domain, secrets);
  await persistSecrets(dir, secrets);
  log('Created .env, docker-compose.yml, Caddyfile');

  // 4. Start PostgreSQL (skip if already healthy)
  if (isServiceHealthy(compose, dir, 'postgres')) {
    log('PostgreSQL already running.');
  } else {
    log('Starting PostgreSQL...');
    composeCmd(compose, dir, 'up -d postgres');
    await waitForService(compose, dir, 'postgres');
    log('PostgreSQL ready.');
  }

  // 5. Start server (skip if already healthy)
  if (isServiceHealthy(compose, dir, 'server')) {
    log('Server already running.');
  } else {
    log('Starting server...');
    composeCmd(compose, dir, 'up -d server');
    // Wait a bit for migrations + admin creation
    await new Promise(r => setTimeout(r, 5000));
    await waitForService(compose, dir, 'server');
    log('Server ready.');
  }

  // 6. Bootstrap database (idempotent — handles duplicates gracefully)
  log('Bootstrapping database...');
  bootstrapDatabase(compose, dir, secrets);
  log('Database bootstrapped.');

  // 7. Start remaining services
  log('Starting Caddy and Watchtower...');
  composeCmd(compose, dir, 'up -d');
  log('All services running.');

  // 8. Self-bind
  log('Binding daemon to local server...');
  await selfBind(secrets);
  installService();
  log('Daemon bound and running.');

  // 9. Print summary
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
