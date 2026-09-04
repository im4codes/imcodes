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
import { writeFile, readFile, mkdir, chmod, unlink } from 'node:fs/promises';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import {
  dockerComposeTemplate,
  caddyfileTemplate,
  envTemplate,
  turnEntrypointTemplate,
  turnserverConfigTemplate,
  type TurnDeploymentTemplateConfig,
} from './templates.js';
import {
  TURN_SERVICE_DEFAULTS,
  TURN_SERVICE_ENV,
  isTurnServiceHost,
  isTurnServiceIpv4,
  isTurnServicePort,
} from '../../shared/turn-service.js';
import { resolveDaemonLaunchTarget, renderSystemdExecStart } from '../util/launch-target.js';
import { enableSystemdUserLinger, formatSystemdLingerFailureMessage } from '../util/systemd-linger.js';

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
  for (const file of [
    '.env',
    '.setup-secrets.json',
    'docker-compose.yml',
    'Caddyfile',
    'turnserver.conf',
    'turn-entrypoint.sh',
  ]) {
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

// ── Mirror mode detection ───────────────────────────────────────────────────

const DOCKER_HUB_MIRRORS = [
  'https://docker.1ms.run',
  'https://docker.m.daocloud.io',
];
const GHCR_MIRROR_PREFIX = 'ghcr.nju.edu.cn';

/** Detect if Docker Hub is reachable. If not, enable mirror mode. */
function detectMirrorMode(): boolean {
  try {
    execSync('curl -sf --connect-timeout 3 --max-time 5 https://hub.docker.com/ -o /dev/null', { stdio: 'ignore' });
    return false; // reachable → direct mode
  } catch {
    return true;  // blocked → mirror mode
  }
}

/** Check if daemon.json already has registry mirrors configured. */
function hasDaemonMirrors(): boolean {
  const daemonJson = '/etc/docker/daemon.json';
  try {
    if (!existsSync(daemonJson)) return false;
    const content = JSON.parse(readFileSync(daemonJson, 'utf8'));
    const mirrors = content['registry-mirrors'];
    return Array.isArray(mirrors) && mirrors.length > 0;
  } catch {
    return false;
  }
}

/** Configure Docker daemon registry mirrors via daemon.json (skip if already configured). */
function setupDaemonMirrors(enable: boolean): void {
  if (!enable) return;
  if (hasDaemonMirrors()) {
    log('Docker Hub mirrors already configured in daemon.json. Skipping.');
    return;
  }
  const daemonJson = '/etc/docker/daemon.json';
  try {
    const config = JSON.stringify({ 'registry-mirrors': DOCKER_HUB_MIRRORS }, null, 2);
    writeFileSync(daemonJson, config);
    execSync('systemctl restart docker', { stdio: 'ignore' });
    log('Docker Hub mirrors configured (daemon.json).');
  } catch {
    log('Could not configure daemon.json (non-root or systemctl unavailable). Skipping.');
  }
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

function parseIpv4Lines(value: string): string[] {
  return value.split(/\s+/).map((entry) => entry.trim()).filter(isTurnServiceIpv4);
}

function discoverPublicIpv4(): string | undefined {
  try {
    const result = execFileSync('curl', [
      '-4fsS',
      '--connect-timeout',
      '5',
      '--max-time',
      '8',
      'https://api.ipify.org',
    ], { encoding: 'utf8', timeout: 10_000 }).trim();
    return isTurnServiceIpv4(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

interface TurnDnsLookup {
  status: 'resolved' | 'no_record' | 'unavailable';
  addresses: string[];
}

function resolveHostIpv4(host: string): TurnDnsLookup {
  try {
    const addresses = parseIpv4Lines(execFileSync('dig', ['+short', 'A', host], {
      encoding: 'utf8',
      timeout: 5000,
    }));
    return { status: addresses.length > 0 ? 'resolved' : 'no_record', addresses };
  } catch {
    return { status: 'unavailable', addresses: [] };
  }
}

export function validateTurnDnsOnly(
  host: string,
  externalIp: string,
  resolvedIpv4: readonly string[],
): string | undefined {
  if (!isTurnServiceHost(host)) return 'TURN host must be a valid DNS hostname.';
  if (!isTurnServiceIpv4(externalIp)) return 'TURN external IP must be a valid public IPv4 address.';
  if (resolvedIpv4.length === 0) {
    return `TURN hostname ${host} has no directly verifiable IPv4 A record. `
      + 'Use a DNS-only hostname for TURN. If the application hostname is proxied, create a separate TURN hostname '
      + 'instead of disabling protection on the application hostname.';
  }
  if (!resolvedIpv4.includes(externalIp)) {
    return `TURN hostname ${host} resolves to ${resolvedIpv4.join(', ')}, not this server (${externalIp}). `
      + 'Use a DNS-only TURN hostname pointing directly to this server. If the application hostname is proxied, '
      + 'create a separate TURN hostname instead of disabling its protection.';
  }
  return undefined;
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
  turnSharedSecret?: string;
}

interface SetupFlowOptions {
  force?: boolean;
  turn?: boolean;
  turnHost?: string;
  turnPort?: string | number;
  turnExternalIp?: string;
  turnRelayMinPort?: string | number;
  turnRelayMaxPort?: string | number;
  turnDnsOnly?: boolean;
}

type EnabledTurnDeployment = Required<Omit<TurnDeploymentTemplateConfig, 'enabled'>> & { enabled: true };

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
      turnSharedSecret: env[TURN_SERVICE_ENV.SHARED_SECRET],
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
  await chmod(secretsPath, 0o600);
}

function parsePortOption(value: string | number | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return isTurnServicePort(value) ? value : undefined;
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const parsed = Number(value);
  return isTurnServicePort(parsed) ? parsed : undefined;
}

function parseBoundedInteger(
  value: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function recoverTurnDeployment(dir: string): Partial<EnabledTurnDeployment> | undefined {
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) return undefined;
  const env = parseEnvFile(readFileSync(envPath, 'utf8'));
  if (env[TURN_SERVICE_ENV.ENABLED] !== 'true') return undefined;
  return {
    enabled: true,
    host: env[TURN_SERVICE_ENV.HOST],
    port: parsePortOption(env[TURN_SERVICE_ENV.PORT], TURN_SERVICE_DEFAULTS.PORT),
    externalIp: env[TURN_SERVICE_ENV.EXTERNAL_IP],
    relayMinPort: parsePortOption(env[TURN_SERVICE_ENV.RELAY_MIN_PORT], TURN_SERVICE_DEFAULTS.RELAY_MIN_PORT),
    relayMaxPort: parsePortOption(env[TURN_SERVICE_ENV.RELAY_MAX_PORT], TURN_SERVICE_DEFAULTS.RELAY_MAX_PORT),
    sharedSecret: env[TURN_SERVICE_ENV.SHARED_SECRET],
    credentialTtlSeconds: parseBoundedInteger(
      env[TURN_SERVICE_ENV.CREDENTIAL_TTL_SECONDS],
      TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_SECONDS,
      TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_MIN_SECONDS,
      TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_MAX_SECONDS,
    ),
  };
}

async function resolveTurnDeployment(
  domain: string,
  dir: string,
  secrets: SetupSecrets,
  opts: SetupFlowOptions,
): Promise<EnabledTurnDeployment | undefined> {
  const recovered = recoverTurnDeployment(dir);
  const turnConfigRequested = opts.turnHost !== undefined
    || opts.turnPort !== undefined
    || opts.turnExternalIp !== undefined
    || opts.turnRelayMinPort !== undefined
    || opts.turnRelayMaxPort !== undefined;
  let enabled = opts.turn ?? (Boolean(recovered) || turnConfigRequested);
  if (opts.turn === undefined && !recovered && !turnConfigRequested && process.stdin.isTTY) {
    enabled = await confirm('Enable optional authenticated TURN relay for difficult NAT networks?');
  }
  if (!enabled) {
    secrets.turnSharedSecret = undefined;
    return undefined;
  }

  const defaultHost = domain.toLowerCase().startsWith('turn.') ? domain : `turn.${domain}`;
  const host = (opts.turnHost ?? recovered?.host ?? defaultHost).trim().toLowerCase();
  const port = parsePortOption(opts.turnPort, recovered?.port ?? TURN_SERVICE_DEFAULTS.PORT);
  const relayMinPort = parsePortOption(
    opts.turnRelayMinPort,
    recovered?.relayMinPort ?? TURN_SERVICE_DEFAULTS.RELAY_MIN_PORT,
  );
  const relayMaxPort = parsePortOption(
    opts.turnRelayMaxPort,
    recovered?.relayMaxPort ?? TURN_SERVICE_DEFAULTS.RELAY_MAX_PORT,
  );
  const discoveredExternalIp = opts.turnExternalIp === undefined ? discoverPublicIpv4()?.trim() : undefined;
  let externalIp = (opts.turnExternalIp ?? recovered?.externalIp ?? discoveredExternalIp)?.trim();

  if (!isTurnServiceHost(host)) fatal('TURN host must be a valid DNS hostname.');
  if (!port) fatal('TURN listener port must be between 1 and 65535.');
  if (!relayMinPort || !relayMaxPort || relayMinPort > relayMaxPort) {
    fatal('TURN relay port range is invalid.');
  }
  if (relayMaxPort - relayMinPort > 255) {
    fatal('TURN relay port range may contain at most 256 UDP ports.');
  }
  if (port === 80 || port === 443 || (port >= relayMinPort && port <= relayMaxPort)) {
    fatal('TURN listener port must not be 80, 443, or inside the relay UDP port range.');
  }
  if (!externalIp || !isTurnServiceIpv4(externalIp)) {
    fatal('Could not determine the TURN server public IPv4. Pass --turn-external-ip <ipv4>.');
  }

  const dnsLookup = resolveHostIpv4(host);
  let recoveredIpUpdated = false;
  if (opts.turnExternalIp === undefined
    && recovered?.externalIp
    && discoveredExternalIp
    && recovered.externalIp !== discoveredExternalIp
    && dnsLookup.status === 'resolved'
    && dnsLookup.addresses.includes(discoveredExternalIp)) {
    console.warn(`\n  Warning: TURN public IPv4 changed from ${recovered.externalIp} to ${discoveredExternalIp}; `
      + 'the recovered deployment will be updated to match its DNS A record.\n');
    externalIp = discoveredExternalIp;
    recoveredIpUpdated = true;
  }
  if (dnsLookup.status === 'resolved') {
    const dnsError = validateTurnDnsOnly(host, externalIp, dnsLookup.addresses);
    if (dnsError) {
      if (opts.turnExternalIp === undefined
        && recovered?.externalIp
        && discoveredExternalIp
        && recovered.externalIp !== discoveredExternalIp) {
        fatal(`${dnsError} The recovered TURN external IP may be stale; verify the current public IPv4 and re-run `
          + 'with --turn-external-ip <ipv4>.');
      }
      fatal(dnsError);
    }
  } else {
    const reason = dnsLookup.status === 'unavailable'
      ? 'DNS lookup tooling is unavailable or the lookup timed out.'
      : `No IPv4 A record is currently published for ${host}.`;
    console.warn(`\n  Warning: ${reason}`);
    if (opts.turnExternalIp === undefined
      && recovered?.externalIp
      && discoveredExternalIp
      && recovered.externalIp !== discoveredExternalIp) {
      console.warn(`  The recovered TURN external IP (${recovered.externalIp}) differs from the currently detected `
        + `public IPv4 (${discoveredExternalIp}). DNS could not confirm which value is authoritative; re-run with `
        + '--turn-external-ip <ipv4> after verification.');
    }
    console.warn('  TURN DNS could not be verified automatically; setup will continue only with explicit DNS-only acknowledgement.\n');
  }

  const previouslyAcknowledged = Boolean(
    recovered
    && recovered.host === host
    && (recovered.externalIp === externalIp || recoveredIpUpdated),
  );
  if (!opts.turnDnsOnly && !previouslyAcknowledged) {
    if (!process.stdin.isTTY) {
      fatal('TURN requires a DNS-only hostname. If the application hostname is proxied, create a separate one '
        + '(for example turn.example.com) pointing directly to this server; a DNS-only application hostname may '
        + 'reuse the same name on the dedicated TURN port. Then re-run with --turn-dns-only.');
    }
    console.warn('\n  TURN cannot use a Cloudflare-proxied (orange-cloud) hostname or Caddy HTTP proxying.');
    console.warn(`  Use a separate DNS-only hostname such as ${defaultHost}, pointed directly to ${externalIp}.`);
    console.warn('  If the application hostname is already DNS only, the same hostname may use the dedicated TURN port.');
    console.warn('  Otherwise do not disable its Cloudflare protection; create the separate TURN hostname.\n');
    if (!await confirm(`I confirm ${host} is DNS only`)) fatal('TURN DNS-only confirmation was not accepted.');
  }

  const recoveredCredentialTtlSeconds = recovered?.credentialTtlSeconds;
  const upgradeLegacyCredentialTtl = recoveredCredentialTtlSeconds
    === TURN_SERVICE_DEFAULTS.LEGACY_CREDENTIAL_TTL_SECONDS;
  if (upgradeLegacyCredentialTtl) {
    console.warn(`\n  Warning: upgrading the legacy ${recoveredCredentialTtlSeconds}-second TURN credential lifetime `
      + `to ${TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_SECONDS} seconds so active two-hour route renewals remain effective.\n`);
  }
  secrets.turnSharedSecret ??= recovered?.sharedSecret ?? randomHex(TURN_SERVICE_DEFAULTS.SHARED_SECRET_BYTES);
  return {
    enabled: true,
    host,
    port,
    externalIp,
    relayMinPort,
    relayMaxPort,
    sharedSecret: secrets.turnSharedSecret,
    credentialTtlSeconds: recoveredCredentialTtlSeconds === undefined || upgradeLegacyCredentialTtl
      ? TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_SECONDS
      : recoveredCredentialTtlSeconds,
  };
}

async function writeConfigs(
  dir: string,
  domain: string,
  secrets: SetupSecrets,
  mirrorMode: boolean,
  turn: EnabledTurnDeployment | undefined,
): Promise<void> {
  await writeFile(join(dir, '.env'), envTemplate({
    domain,
    postgresPassword: secrets.postgresPassword,
    jwtSigningKey: secrets.jwtSigningKey,
    adminPassword: secrets.adminPassword,
    turn,
  }), { encoding: 'utf8', mode: 0o600 });
  await chmod(join(dir, '.env'), 0o600);

  await writeFile(join(dir, 'docker-compose.yml'), dockerComposeTemplate(
    {
      ...(mirrorMode ? {
        ghcrPrefix: GHCR_MIRROR_PREFIX,
        turnImage: TURN_SERVICE_DEFAULTS.MIRROR_IMAGE,
      } : {}),
      turn,
    },
  ));
  await writeFile(join(dir, 'Caddyfile'), caddyfileTemplate(domain));
  const turnConfigPath = join(dir, 'turnserver.conf');
  const turnEntrypointPath = join(dir, 'turn-entrypoint.sh');
  if (turn) {
    await writeFile(turnConfigPath, turnserverConfigTemplate(turn), { encoding: 'utf8', mode: 0o600 });
    await chmod(turnConfigPath, 0o600);
    await writeFile(turnEntrypointPath, turnEntrypointTemplate(), { encoding: 'utf8', mode: 0o700 });
    await chmod(turnEntrypointPath, 0o700);
  } else if (existsSync(turnConfigPath)) {
    await unlink(turnConfigPath);
    if (existsSync(turnEntrypointPath)) await unlink(turnEntrypointPath);
  } else if (existsSync(turnEntrypointPath)) {
    await unlink(turnEntrypointPath);
  }
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
  const logPath = join(CREDS_DIR, 'daemon.log');

  // Prefer the self-healing launcher when this install ships it. See
  // `src/util/launch-target.ts` for the why — half-finished `npm install`
  // wedges the daemon in a Restart=always crash loop unless the launch
  // chain has a non-Node guardian in front.
  const target = resolveDaemonLaunchTarget();

  const unit = `[Unit]
Description=IM.codes Daemon
After=network.target

[Service]
Type=simple
ExecStart=${renderSystemdExecStart(target)}
Restart=on-failure
RestartSec=5
KillMode=process
Environment=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}
Environment=HOME=${homedir()}
Environment=NODE_ENV=production
# See bind-flow.ts.installSystemdService for rationale on these two.
# Mirrors the flags there so the one-click setup and the manual bind
# install produce equivalent units.
Environment="NODE_OPTIONS=--expose-gc --max-old-space-size=8192"
# Caps glibc malloc arenas — see bind-flow.ts for the full rationale.
# Mirrors that unit so one-click setup and manual bind behave identically.
# Bounds the ~730 MB of off-heap arena RSS that onnxruntime/sharp native
# threads accumulate on multi-core hosts (glibc-only; no-op on macOS).
Environment="MALLOC_ARENA_MAX=2"
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

  execSync(`mkdir -p "${serviceDir}"`);
  writeFileSync(servicePath, unit);
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    execSync('systemctl --user enable imcodes', { stdio: 'ignore' });
    execSync('systemctl --user restart imcodes', { stdio: 'ignore' });
  } catch {
    console.log('  Could not start systemd service automatically. Run: systemctl --user start imcodes');
  }

  const linger = enableSystemdUserLinger();
  if (linger.ok) {
    log(`Systemd user-linger enabled for ${linger.user} (daemon survives logout).`);
  } else {
    log(formatSystemdLingerFailureMessage(linger.user));
    log('The daemon may stop when you log out until this is fixed.');
  }
}

// ── Main flow ───────────────────────────────────────────────────────────────

export async function setupFlow(domain: string, opts: SetupFlowOptions = {}): Promise<void> {
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

  const turn = await resolveTurnDeployment(domain, dir, secrets, opts);

  // 3. Detect mirror mode (hub.docker.com unreachable → use mirrors)
  log('Detecting network...');
  const mirrorMode = detectMirrorMode();
  if (mirrorMode) {
    log('Mirror mode: hub.docker.com unreachable, using registry mirrors.');
    setupDaemonMirrors(true);
  } else {
    log('Direct mode: hub.docker.com reachable.');
  }

  // 4. Write config files (always write to ensure they match current secrets)
  if (!resumed) {
    log('Generating configuration...');
  } else {
    log('Updating configuration files...');
  }
  await writeConfigs(dir, domain, secrets, mirrorMode, turn);
  await persistSecrets(dir, secrets);
  log(`Created .env, docker-compose.yml, Caddyfile${turn ? ', TURN config' : ''}${mirrorMode ? ' (mirror mode)' : ''}`);

  // 4. Start PostgreSQL (skip if already healthy)
  if (isServiceHealthy(compose, dir, 'postgres')) {
    log('PostgreSQL already running.');
  } else {
    log('Starting PostgreSQL...');
    composeCmd(compose, dir, 'up -d postgres');
    await waitForService(compose, dir, 'postgres');
    log('PostgreSQL ready.');
  }

  // 5. Always recreate TURN after rewriting its bind-mounted configuration.
  // Docker Compose does not otherwise notice file-content or REST-secret
  // changes, leaving coturn with stale in-memory credentials and ACLs.
  if (turn) {
    log('Starting TURN with current configuration...');
    composeCmd(compose, dir, 'up -d --force-recreate turn');
    await waitForService(compose, dir, 'turn');
    log('TURN ready.');
  }

  // 6. Start server (skip if already healthy)
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

  // 7. Bootstrap database (idempotent — handles duplicates gracefully)
  log('Bootstrapping database...');
  bootstrapDatabase(compose, dir, secrets);
  log('Database bootstrapped.');

  // 8. Start remaining services
  log(`Starting Caddy${turn ? ', TURN' : ''} and Watchtower...`);
  composeCmd(compose, dir, 'up -d');
  log('All services running.');

  // 9. Self-bind
  log('Binding daemon to local server...');
  await selfBind(secrets);
  installService();
  log('Daemon bound and running.');

  // 10. Print summary
  const bindUrl = `https://${domain}/bind/${secrets.apiKeyRaw}`;
  console.log(`
  ┌──────────────────────────────────────────────────────┐
  │  IM.codes server running at https://${domain}
  │
  │  Admin login:    admin / ${secrets.adminPassword}
  │  Bind URL:       ${bindUrl}
${turn ? `  │  TURN relay:     turn:${turn.host}:${turn.port} (DNS only)\n` : ''}  │
${turn ? `  │  Firewall:       TCP/UDP ${turn.port}; UDP ${turn.relayMinPort}-${turn.relayMaxPort}\n  │\n` : ''}  │  This machine is bound and daemon is running.
  │
  │  To connect another machine:
  │    npm install -g imcodes
  │    imcodes bind ${bindUrl}
  └──────────────────────────────────────────────────────┘
`);
}
