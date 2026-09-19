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
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync} from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';
import {
  dockerComposeTemplate,
  caddyfileTemplate,
  envTemplate,
  turnEntrypointTemplate,
  turnserverConfigTemplate,
  type TurnDeploymentTemplateConfig,
  NODE_EXE_VERSION_VOLUME,
  NODE_EXE_VERSION_DIR,
} from './templates.js';
import {
  TURN_RELAY_CAPACITY,
  TURN_RELAY_NETWORK,
  TURN_RELAY_NETWORK_MODES,
  TURN_RELAY_RANGE_REJECTION,
  TURN_SERVICE_DEFAULTS,
  TURN_SERVICE_ENV,
  parseTurnRelayCapacity,
  parseTurnRelayRange,
  isTurnServiceHost,
  isTurnServiceIpv4,
  isTurnServicePort,
  isTurnRelayNetworkMode,
  turnRelayCapacityForRange,
  turnRelayCapacityRejectionMessage,
  turnRelayNetworkMode,
  turnRelayPortCount,
  turnRelayRangeForCapacity,
  type TurnRelayNetworkMode,
  type TurnRelayRangeOrigin,
} from '../../shared/turn-service.js';
import { resolveDaemonLaunchTarget, renderSystemdExecStart } from '../util/launch-target.js';
import { enableSystemdUserLinger, formatSystemdLingerFailureMessage } from '../util/systemd-linger.js';
import { renderRecoveryExecStart, renderSystemdStartLimitBlock, renderSystemdTerminalDiagnostics } from '../util/systemd-unit.js';
import { installRecoveryUnits } from '../util/systemd-recovery-install.js';

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

/** Free-text prompt. An empty line means "use the documented default". */
async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${prompt} `, (answer) => {
      rl.close();
      resolve(answer.trim());
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
  turnRelayCapacity?: string | number;
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

function parsePortOption(value: string | number | undefined, fallback?: number): number | undefined {
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

/**
 * A recovered deployment, plus whether it published a relay range of its own.
 * That flag is load-bearing: an existing range must be preserved exactly, so
 * "absent" and "present but unreadable" cannot be collapsed into a default.
 */
type RecoveredTurnDeployment = Partial<EnabledTurnDeployment> & {
  relayRangeConfigured: boolean;
  /** Exactly what TURN_RELAY_NETWORK_MODE said, so an unusable value can fail closed. */
  relayNetworkModeRaw?: string;
};

function recoverTurnDeployment(dir: string): RecoveredTurnDeployment | undefined {
  const envPath = join(dir, '.env');
  if (!existsSync(envPath)) return undefined;
  const env = parseEnvFile(readFileSync(envPath, 'utf8'));
  if (env[TURN_SERVICE_ENV.ENABLED] !== 'true') return undefined;
  const relayNetworkModeRaw = env[TURN_SERVICE_ENV.RELAY_NETWORK_MODE];
  return {
    enabled: true,
    host: env[TURN_SERVICE_ENV.HOST],
    port: parsePortOption(env[TURN_SERVICE_ENV.PORT], TURN_SERVICE_DEFAULTS.PORT),
    externalIp: env[TURN_SERVICE_ENV.EXTERNAL_IP],
    // No default fallback here on purpose. Substituting the current default
    // range for a deployment that already published one is exactly how an
    // upgrade silently moves — and shrinks — the ports coturn is bound to.
    relayRangeConfigured: env[TURN_SERVICE_ENV.RELAY_MIN_PORT] !== undefined
      || env[TURN_SERVICE_ENV.RELAY_MAX_PORT] !== undefined,
    relayMinPort: parsePortOption(env[TURN_SERVICE_ENV.RELAY_MIN_PORT]),
    relayMaxPort: parsePortOption(env[TURN_SERVICE_ENV.RELAY_MAX_PORT]),
    // The deployment's own record of how its container is attached. Absent
    // means legacy, which is bridge — the only shape older installers built.
    relayNetworkModeRaw,
    networkMode: isTurnRelayNetworkMode(relayNetworkModeRaw) ? relayNetworkModeRaw : undefined,
    sharedSecret: env[TURN_SERVICE_ENV.SHARED_SECRET],
    credentialTtlSeconds: parseBoundedInteger(
      env[TURN_SERVICE_ENV.CREDENTIAL_TTL_SECONDS],
      TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_SECONDS,
      TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_MIN_SECONDS,
      TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_MAX_SECONDS,
    ),
  };
}

function requireTurnRelayCapacity(value: string | number | undefined): number {
  const parsed = parseTurnRelayCapacity(value);
  if ('rejection' in parsed) fatal(turnRelayCapacityRejectionMessage(parsed.rejection));
  return parsed.capacity;
}

function describeTurnRelayCapacity(relayMinPort: number, relayMaxPort: number): string {
  const capacity = turnRelayCapacityForRange(relayMinPort, relayMaxPort);
  return `${capacity} concurrent relay allocation${capacity === 1 ? '' : 's'}`;
}

function warnIfTurnRelayRangeMoved(
  recovered: RecoveredTurnDeployment | undefined,
  next: { relayMinPort: number; relayMaxPort: number },
): void {
  const { relayMinPort, relayMaxPort } = recovered ?? {};
  if (relayMinPort === undefined || relayMaxPort === undefined) return;
  if (relayMinPort === next.relayMinPort && relayMaxPort === next.relayMaxPort) return;
  const before = turnRelayCapacityForRange(relayMinPort, relayMaxPort);
  const after = turnRelayCapacityForRange(next.relayMinPort, next.relayMaxPort);
  console.warn(`\n  Warning: the TURN relay range changes from ${relayMinPort}-${relayMaxPort} `
    + `(${before} concurrent allocations) to ${next.relayMinPort}-${next.relayMaxPort} (${after}). `
    + 'Open the new UDP range in the firewall before relying on it.'
    + (after < before
      ? ` This REDUCES capacity: allocations beyond ${after} concurrent relays will be refused.`
      : '')
    + '\n');
}

/**
 * Decide the relay range, from exactly one authority per run.
 *
 * The capacity question is the normal path: "how many concurrent relay
 * allocations" is answerable, and standard coturn turns it into a port count
 * 1:1. The derived range is anchored at the top of the port space precisely so
 * the largest accepted answer still fits — a fixed low start cannot hold 30000
 * ports.
 *
 * An explicit port range stays supported and stays authoritative when given,
 * because a range already published to coturn, to Docker and to a firewall is
 * deployment configuration, not something application code gets to second-guess
 * by width. Only the protocol rule in `parseTurnRelayRange` may refuse it. What
 * IS refused here is ambiguity: a capacity that disagrees with an explicit
 * range, or half a range on a fresh install, fails closed instead of quietly
 * picking a winner.
 */
interface ResolvedTurnRelayRange {
  relayMinPort: number;
  relayMaxPort: number;
  rangeOrigin: TurnRelayRangeOrigin;
}

async function resolveTurnRelayRange(
  opts: SetupFlowOptions,
  recovered: RecoveredTurnDeployment | undefined,
): Promise<ResolvedTurnRelayRange> {
  const explicitMin = opts.turnRelayMinPort !== undefined;
  const explicitMax = opts.turnRelayMaxPort !== undefined;

  if (explicitMin || explicitMax) {
    const relayMinPort = explicitMin
      ? parsePortOption(opts.turnRelayMinPort)
      : recovered?.relayMinPort;
    const relayMaxPort = explicitMax
      ? parsePortOption(opts.turnRelayMaxPort)
      : recovered?.relayMaxPort;
    if (relayMinPort === undefined) {
      fatal(explicitMin
        ? 'TURN relay port range is invalid.'
        : `--turn-relay-max-port was given without --turn-relay-min-port, and no existing `
          + `${TURN_SERVICE_ENV.RELAY_MIN_PORT} was found to pair it with. Pass both ports, or pass `
          + '--turn-relay-capacity instead.');
    }
    if (relayMaxPort === undefined) {
      fatal(explicitMax
        ? 'TURN relay port range is invalid.'
        : `--turn-relay-min-port was given without --turn-relay-max-port, and no existing `
          + `${TURN_SERVICE_ENV.RELAY_MAX_PORT} was found to pair it with. Pass both ports, or pass `
          + '--turn-relay-capacity instead.');
    }
    if (opts.turnRelayCapacity !== undefined) {
      const requested = requireTurnRelayCapacity(opts.turnRelayCapacity);
      const offered = turnRelayCapacityForRange(relayMinPort, relayMaxPort);
      if (requested !== offered) {
        fatal(`--turn-relay-capacity ${requested} conflicts with the explicit relay range `
          + `${relayMinPort}-${relayMaxPort}, which serves ${offered} concurrent relay allocations. `
          + 'Pass one or the other, or make the two agree.');
      }
    }
    warnIfTurnRelayRangeMoved(recovered, { relayMinPort, relayMaxPort });
    // An explicit capacity was stated and agrees with these ports, so setup may
    // still choose the network strategy for it.
    return {
      relayMinPort,
      relayMaxPort,
      rangeOrigin: opts.turnRelayCapacity === undefined ? 'configured' : 'capacity',
    };
  }

  if (opts.turnRelayCapacity !== undefined) {
    const range = turnRelayRangeForCapacity(requireTurnRelayCapacity(opts.turnRelayCapacity));
    warnIfTurnRelayRangeMoved(recovered, range);
    return { ...range, rangeOrigin: 'capacity' };
  }

  if (recovered?.relayRangeConfigured) {
    // The existing deployment's own answer. Preserved verbatim — including
    // 49201-50200, which is not derivable from any capacity anchor — and never
    // re-derived from the current default.
    if (recovered.relayMinPort === undefined || recovered.relayMaxPort === undefined) {
      fatal(`Existing ${TURN_SERVICE_ENV.RELAY_MIN_PORT}/${TURN_SERVICE_ENV.RELAY_MAX_PORT} in .env is not a `
        + 'usable UDP port range. Fix those two values, or pass --turn-relay-min-port and --turn-relay-max-port '
        + 'explicitly; setup will not replace a configured relay range with a default.');
    }
    return {
      relayMinPort: recovered.relayMinPort,
      relayMaxPort: recovered.relayMaxPort,
      rangeOrigin: 'configured',
    };
  }

  if (!process.stdin.isTTY) {
    return { ...turnRelayRangeForCapacity(TURN_RELAY_CAPACITY.DEFAULT_ALLOCATIONS), rangeOrigin: 'capacity' };
  }
  console.log('\n  TURN relay capacity is the maximum number of CONCURRENT relayed connections, not users.');
  console.log('  Standard coturn binds one UDP port per relayed connection, so this many ports are published.');
  const answer = await ask(`Maximum concurrent TURN relay allocations `
    + `(${TURN_RELAY_CAPACITY.MIN_ALLOCATIONS}-${TURN_RELAY_CAPACITY.MAX_ALLOCATIONS}) `
    + `[${TURN_RELAY_CAPACITY.DEFAULT_ALLOCATIONS}]:`);
  return { ...turnRelayRangeForCapacity(requireTurnRelayCapacity(answer)), rangeOrigin: 'capacity' };
}

/**
 * Apply the network strategy the shared rule chose, and refuse the one shape it
 * cannot honestly deliver.
 *
 * Nothing here reduces the capacity or edits the range. Host networking is only
 * ever selected for a capacity the operator asked for, and only where it exists;
 * a range the deployment already publishes keeps publishing it, with the cost
 * stated rather than silently changed.
 */
function resolveTurnRelayNetworkMode(
  range: ResolvedTurnRelayRange,
  recovered: RecoveredTurnDeployment | undefined,
): TurnRelayNetworkMode {
  const raw = recovered?.relayNetworkModeRaw;
  if (raw !== undefined && !isTurnRelayNetworkMode(raw)) {
    // Fail closed. Both guesses are damaging and neither is recoverable from
    // the range alone, so setup will not pick one on the operator's behalf.
    fatal(`${TURN_SERVICE_ENV.RELAY_NETWORK_MODE} in .env is "${raw}", which is not a network mode. `
      + `Set it to one of ${TURN_RELAY_NETWORK_MODES.join(' or ')} to state how this deployment's TURN `
      + 'container is attached; setup will not guess, because guessing either republishes every relay port '
      + 'or moves a running relay off the bridge.');
  }
  const mode = turnRelayNetworkMode({ ...range, persistedMode: recovered?.networkMode });
  if (recovered?.networkMode !== undefined && recovered.networkMode !== mode) {
    console.warn(`\n  Warning: the TURN container moves from ${recovered.networkMode} to ${mode} networking. `
      + (mode === 'host'
        ? 'Docker will no longer publish the relay range; open it in the host firewall.'
        : 'Docker will publish the relay range again; the host firewall rule for it is no longer required.')
      + '\n');
  }
  return mode;
}

function applyTurnRelayNetworkStrategy(
  range: ResolvedTurnRelayRange,
  networkMode: TurnRelayNetworkMode,
  platform: NodeJS.Platform = process.platform,
): void {
  const ports = turnRelayPortCount(range.relayMinPort, range.relayMaxPort);
  const oversizedForBridge = ports > TURN_RELAY_NETWORK.BRIDGE_PUBLISH_MAX_PORTS;
  if (networkMode === 'host') {
    if (platform !== 'linux') {
      // Fail closed instead of publishing 30000 bridge mappings, and instead of
      // quietly serving a smaller relay than the one that was requested.
      fatal(`${ports} concurrent relay allocations need Docker host networking, which only exists on Linux; `
        + `this host is ${platform}. Deploy TURN on a Linux host, or choose a capacity of at most `
        + `${TURN_RELAY_NETWORK.BRIDGE_PUBLISH_MAX_PORTS} allocations, which a bridge deployment publishes `
        + 'safely. Setup will not reduce the requested capacity for you.');
    }
    console.warn(`\n  Note: ${ports} relay ports is past the ${TURN_RELAY_NETWORK.BRIDGE_PUBLISH_MAX_PORTS} `
      + 'a Docker bridge can publish sanely, so the TURN container uses host networking. Docker will NOT open '
      + `the UDP range for you: allow ${range.relayMinPort}-${range.relayMaxPort}/udp in the host firewall.\n`);
    return;
  }
  if (oversizedForBridge) {
    // Reachable only for a range the deployment already configured, which is
    // preserved exactly — ports and network mode. Say what it costs.
    console.warn(`\n  Warning: the configured relay range ${range.relayMinPort}-${range.relayMaxPort} publishes `
      + `${ports} UDP ports through the Docker bridge, and Docker expands that into one mapping, one proxy and `
      + 'its own DNAT rules per port — a slow start and a very large resolved Compose model. The range and its '
      + 'network mode are preserved exactly. To have setup pick host networking instead, re-run with '
      + '--turn-relay-capacity <allocations>.\n');
  }
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
    || opts.turnRelayCapacity !== undefined
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
  const resolvedRelayRange = await resolveTurnRelayRange(opts, recovered);
  const { relayMinPort, relayMaxPort, rangeOrigin } = resolvedRelayRange;
  const discoveredExternalIp = opts.turnExternalIp === undefined ? discoverPublicIpv4()?.trim() : undefined;
  let externalIp = (opts.turnExternalIp ?? recovered?.externalIp ?? discoveredExternalIp)?.trim();

  if (!isTurnServiceHost(host)) fatal('TURN host must be a valid DNS hostname.');
  if (!port) fatal('TURN listener port must be between 1 and 65535.');
  // The SAME rule the server runtime applies. These were two separate
  // implementations with different ceilings, so this installer wrote a relay
  // range into .env, coturn's min-port/max-port and the Docker publish list
  // that the runtime then refused — serving every client a STUN-only ICE list
  // against a healthy coturn.
  const relayRange = parseTurnRelayRange({ port, relayMinPort, relayMaxPort });
  if ('rejection' in relayRange) {
    // `fatal` never returns, which is also what narrows `relayRange` below —
    // no second copy of the rule, and no unchecked non-null assertion either.
    if (relayRange.rejection === TURN_RELAY_RANGE_REJECTION.LISTENER_INSIDE_RANGE) {
      fatal('TURN listener port must not be 80, 443, or inside the relay UDP port range.');
    }
    fatal('TURN relay port range is invalid.');
  }
  if (port === 80 || port === 443) {
    fatal('TURN listener port must not be 80, 443, or inside the relay UDP port range.');
  }
  const networkMode = resolveTurnRelayNetworkMode(resolvedRelayRange, recovered);
  applyTurnRelayNetworkStrategy(resolvedRelayRange, networkMode);
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
    // Narrowed by the shared rule above, not by a second copy of it.
    relayMinPort: relayRange.relayMinPort,
    relayMaxPort: relayRange.relayMaxPort,
    // Carried into the generated Compose file so the installer and the template
    // ask the SAME shared rule which network strategy this range gets.
    rangeOrigin,
    // Persisted into .env, because it cannot be re-derived from the range on
    // the next run: a wide range is equally consistent with a legacy bridge
    // deployment and a host one.
    networkMode,
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
  // The bridge-address entrypoint belongs to bridge mode only. In host mode
  // there is no bridge address to translate, and the address it would discover
  // is a HOST address that denied-peer-ip may deliberately be blocking, so the
  // wrapper is neither mounted nor left lying around.
  const usesBridgeEntrypoint = turn?.networkMode === 'bridge';
  if (turn && usesBridgeEntrypoint) {
    await writeFile(turnConfigPath, turnserverConfigTemplate(turn), { encoding: 'utf8', mode: 0o600 });
    await chmod(turnConfigPath, 0o600);
    await writeFile(turnEntrypointPath, turnEntrypointTemplate(), { encoding: 'utf8', mode: 0o700 });
    await chmod(turnEntrypointPath, 0o700);
  } else if (turn) {
    await writeFile(turnConfigPath, turnserverConfigTemplate(turn), { encoding: 'utf8', mode: 0o600 });
    await chmod(turnConfigPath, 0o600);
    if (existsSync(turnEntrypointPath)) await unlink(turnEntrypointPath);
  } else if (existsSync(turnConfigPath)) {
    await unlink(turnConfigPath);
    if (existsSync(turnEntrypointPath)) await unlink(turnEntrypointPath);
  } else if (existsSync(turnEntrypointPath)) {
    await unlink(turnEntrypointPath);
  }
}


// ── Retained-artifact migration ─────────────────────────────────────────────

/**
 * Where a pre-fix deployment kept superseded controlled-node artifacts.
 *
 * Before the named volume existed, tsk_jgt's store resolved to
 * `<IMCODES_NODE_EXE_DIR>/versions`, and the image sets IMCODES_NODE_EXE_DIR to
 * /app/controlled-node-executables. Those bytes therefore live in the old
 * container's writable layer, which `compose up -d` discards when it recreates
 * the service. Declaring the volume alone does not save them: the new container
 * starts with an empty volume and every install code minted against a
 * superseded digest stops resolving on the first upgrade.
 */
export const LEGACY_NODE_EXE_VERSION_DIR = '/app/controlled-node-executables/versions';

/**
 * Printed when the legacy directory does not exist at all.
 *
 * A sentinel rather than an empty listing, because "not there" and "there but
 * unreadable" must not produce the same output. Chosen to be impossible as a
 * real directory entry produced by `ls -A`.
 */
export const LEGACY_ABSENT_SENTINEL = '__imcodes_legacy_versions_absent__';

/**
 * Copy the pre-fix retained tree OUT of the running container, before anything
 * replaces it.
 *
 * Returns the staging directory, or null when there is nothing to migrate —
 * a fresh install, an already-migrated deployment (the container already has
 * the volume mounted at the new path), or an empty legacy tree. Every failure
 * is non-fatal: an upgrade must not be blocked by a best-effort copy, and the
 * caller logs rather than throws.
 */
/**
 * Outcome of staging, as three states rather than two.
 *
 * `none` and `failed` were previously both `null`, and the caller read that as
 * "nothing to preserve" and went on to replace the container - destroying the
 * only copy of bytes it had just failed to read. Absence and failure demand
 * opposite responses, so they are no longer the same value. (`already` is
 * folded into `none`: the bytes are already in the durable volume.)
 */
export type RetainedArtifactStaging =
  | { kind: 'none' }
  | { kind: 'staged'; dir: string }
  | { kind: 'failed'; step: string; detail: string };

/**
 * True only for docker's "that path is not in the container" error.
 *
 * Used solely on the stopped-container path, where `exec` is unavailable and
 * `cp` is both the probe and the copy. Recognised absence is benign; anything
 * unrecognised is treated as a failure, so a new or reworded docker error can
 * only ever make this stricter, never quieter.
 */
function isMissingContainerPathError(error: unknown): boolean {
  const text = `${error instanceof Error ? error.message : String(error)} `
    + `${(error as { stderr?: unknown } | null)?.stderr ?? ''}`;
  return /no such file or directory|could not find the file/i.test(text);
}

function stagingFailure(step: string, error: unknown): RetainedArtifactStaging {
  return { kind: 'failed', step, detail: error instanceof Error ? error.message : String(error) };
}

/**
 * Copy the pre-fix retained tree OUT of the running container, before anything
 * replaces it.
 *
 * Returns `none` only when there is genuinely nothing to preserve: no server
 * container, a container that already mounts the durable path, or an empty
 * legacy tree. Anything that went wrong while trying to find out returns
 * `failed`, because the caller must not treat an unanswered question as a "no".
 */
export function stageRetainedArtifactVersions(
  compose: string,
  dir: string,
  deps: {
    runQuiet: (cmd: string, cwd: string) => string;
    mkdtemp: () => string;
    readdir?: (path: string) => string[];
  } = {
    runQuiet,
    mkdtemp: () => mkdtempSync(join(tmpdir(), 'imcodes-node-exe-versions-')),
  },
): RetainedArtifactStaging {
  let containerIds: string[];
  try {
    // `-a`: compose ps omits stopped containers by default, so an ordinary
    // exited or operator-stopped legacy Server produced no id and was read as a
    // fresh install -- then recreated, discarding a writable layer that was
    // still perfectly copyable. Stopped containers are exactly the ones an
    // operator is most likely to be upgrading from.
    containerIds = deps.runQuiet(
      `${compose} -f ${join(dir, 'docker-compose.yml')} --env-file ${join(dir, '.env')} ps -aq server`,
      dir,
    ).split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    return stagingFailure('compose-ps', err);
  }
  // No server in any state: a fresh install has nothing to preserve.
  if (containerIds.length === 0) return { kind: 'none' };
  // More than one candidate is ambiguous, and guessing which holds the real
  // retained bytes is exactly the kind of assumption that loses them.
  if (containerIds.length > 1) {
    return { kind: 'failed', step: 'compose-ps', detail: `ambiguous server containers: ${containerIds.join(', ')}` };
  }
  const containerId = containerIds[0]!;

  try {
    const mounts = deps.runQuiet(
      `docker inspect -f '{{range .Mounts}}{{.Destination}}\n{{end}}' ${containerId}`,
      dir,
    );
    // Already migrated: the retained bytes live in the volume and survive on
    // their own, so there is nothing to stage.
    if (mounts.split('\n').some((line) => line.trim() === NODE_EXE_VERSION_DIR)) return { kind: 'none' };
  } catch (err) {
    return stagingFailure('docker-inspect', err);
  }

  let running = false;
  try {
    running = deps.runQuiet(`docker inspect -f '{{.State.Running}}' ${containerId}`, dir).trim() === 'true';
  } catch (err) {
    return stagingFailure('docker-state', err);
  }

  let staging: string;
  try {
    staging = deps.mkdtemp();
  } catch (err) {
    return stagingFailure('staging-dir', err);
  }

  if (running) {
    // Running container: probe with an explicit exit status. No masking -- a
    // missing directory answers with a sentinel and anything else lets `ls`
    // exit non-zero, which becomes a failure rather than an empty listing.
    let listing: string;
    try {
      listing = deps.runQuiet(
        `docker exec ${containerId} sh -c `
        + `'if [ ! -d "${LEGACY_NODE_EXE_VERSION_DIR}" ]; then echo ${LEGACY_ABSENT_SENTINEL}; exit 0; fi; `
        + `ls -A "${LEGACY_NODE_EXE_VERSION_DIR}"'`,
        dir,
      );
    } catch (err) {
      return stagingFailure('legacy-listing', err);
    }
    if (listing.trim() === LEGACY_ABSENT_SENTINEL || !listing.trim()) return { kind: 'none' };
  }

  try {
    // `docker cp` works against stopped containers, which is why the stopped
    // path relies on it rather than on `exec`.
    deps.runQuiet(`docker cp ${containerId}:${LEGACY_NODE_EXE_VERSION_DIR}/. ${staging}/`, dir);
  } catch (err) {
    // A genuinely absent legacy directory is benign and must stay upgradeable.
    // Everything else fails closed: an unrecognised copy error is exactly the
    // case where continuing would destroy bytes we could not read.
    if (!running && isMissingContainerPathError(err)) return { kind: 'none' };
    return stagingFailure('docker-cp', err);
  }
  const listStaged = deps.readdir ?? ((path: string) => readdirSync(path));
  if (!running && listStaged(staging).length === 0) return { kind: 'none' };
  return { kind: 'staged', dir: staging };
}

/**
 * Refuse to continue when migration was attempted and failed.
 *
 * Replacement is irreversible: `compose up -d` discards the old writable layer,
 * and with it the only copy of bytes we just proved we cannot read. Stopping
 * here leaves the deployment exactly as it was, which is recoverable; carrying
 * on is not.
 */
export function assertRetainedArtifactStagingSafe(staging: RetainedArtifactStaging): void {
  if (staging.kind !== 'failed') return;
  throw new Error(
    `Refusing to replace the server container: could not preserve retained Windows installers `
    + `(${staging.step}: ${staging.detail}). The existing deployment is untouched. `
    + `Resolve the Docker error and re-run setup, or remove `
    + `${LEGACY_NODE_EXE_VERSION_DIR} in the running container if those installers are expendable.`,
  );
}

/**
 * Restore staged bytes into the recreated server's durable volume.
 *
 * Must run AFTER the container has actually been replaced; writing into the old
 * container would simply be discarded with it. Copying into the container path
 * lands in the mounted volume, so the bytes outlive every later replacement.
 */
export function restoreRetainedArtifactVersions(
  compose: string,
  dir: string,
  staging: string,
  deps: { runQuiet: (cmd: string, cwd: string) => string } = { runQuiet },
): boolean {
  try {
    const containerId = deps.runQuiet(
      `${compose} -f ${join(dir, 'docker-compose.yml')} --env-file ${join(dir, '.env')} ps -q server`,
      dir,
    ).split('\n')[0]?.trim() ?? '';
    if (!containerId) return false;
    deps.runQuiet(`docker exec ${containerId} sh -c 'mkdir -p ${NODE_EXE_VERSION_DIR}'`, dir);
    deps.runQuiet(`docker cp ${staging}/. ${containerId}:${NODE_EXE_VERSION_DIR}/`, dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore, then delete the staging copy ONLY if the restore actually succeeded.
 *
 * After replacement the staging directory is the sole surviving copy. Deleting
 * it unconditionally turned an ordinary transient failure - a disk hiccup, a
 * permission problem, a container not ready yet - into permanent data loss, so
 * the copy is retained on failure and its path is reported for manual recovery.
 */
export function finalizeRetainedArtifactMigration(
  compose: string,
  dir: string,
  staging: string,
  deps: {
    restore: (compose: string, dir: string, staging: string) => boolean;
    remove: (path: string) => void;
  } = {
    restore: restoreRetainedArtifactVersions,
    remove: (path) => rmSync(path, { recursive: true, force: true }),
  },
): { restored: boolean; retainedStagingDir?: string } {
  const restored = deps.restore(compose, dir, staging);
  if (!restored) return { restored: false, retainedStagingDir: staging };
  deps.remove(staging);
  return { restored: true };
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
${renderSystemdStartLimitBlock()}

[Service]
Type=simple
ExecStart=${renderSystemdExecStart(target)}
Restart=on-failure
RestartSec=5
KillMode=control-group
${renderSystemdTerminalDiagnostics()}
TimeoutStopSec=45s
SendSIGKILL=yes
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

  // External recovery trigger, installed as its own timer/oneshot pair so it can
  // still act when imcodes.service itself is wedged falsely-active. Idempotent:
  // a re-run rewrites nothing and reloads nothing when the units already match.
  installRecoveryUnits(renderRecoveryExecStart(process.execPath, process.argv[1]));

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
  // Stage retained artifacts BEFORE anything recreates the server. A pre-fix
  // container keeps them in its writable layer, which `compose up -d` discards.
  const stagedVersions = stageRetainedArtifactVersions(compose, dir);
  // A failed attempt is not the same as nothing to do: stop before anything is
  // rewritten or recreated, leaving the existing deployment intact.
  assertRetainedArtifactStagingSafe(stagedVersions);
  if (stagedVersions.kind === 'staged') log('Preserving retained Windows installers from the previous container...');
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

  // Restore only now: the server has actually been replaced, so this lands in
  // the durable volume rather than in a container about to be discarded.
  if (stagedVersions.kind === 'staged') {
    const outcome = finalizeRetainedArtifactMigration(compose, dir, stagedVersions.dir);
    log(outcome.restored
      ? 'Retained Windows installers migrated into the durable volume.'
      : `Could not migrate retained Windows installers. The only copy is preserved at ${outcome.retainedStagingDir}; `
        + `copy it into the server's ${NODE_EXE_VERSION_DIR} to keep existing install codes resolvable.`);
  }

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
${turn ? `  │  TURN capacity:   ${describeTurnRelayCapacity(turn.relayMinPort, turn.relayMaxPort)} (${turn.networkMode} networking)\n` : ''}${turn ? `  │  Firewall:       TCP/UDP ${turn.port}; UDP ${turn.relayMinPort}-${turn.relayMaxPort}${turn.networkMode === 'host' ? ' (host networking: Docker does NOT open these, the host firewall must)' : ''}\n  │\n` : ''}  │  Installer retention: docker volume ${NODE_EXE_VERSION_VOLUME} (keeps superseded
  │                        Windows installers; do not prune it or existing
  │                        install codes stop resolving)
  │
  │  This machine is bound and daemon is running.
  │
  │  To connect another machine:
  │    npm install -g imcodes
  │    imcodes bind ${bindUrl}
  └──────────────────────────────────────────────────────┘
`);
}
