import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { execSyncMock, execFileSyncMock, setupState } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  setupState: {
    home: '',
    host: 'setup-host',
    answer: 'y',
  },
}));

// Only the two calls setup makes are mocked. The rest of child_process stays
// real so the Compose assertions below can actually run `docker compose config`
// against a generated file instead of trusting the string we generated.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: (...args: unknown[]) => execSyncMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

vi.mock('node:os', () => ({
  homedir: () => setupState.home,
  hostname: () => setupState.host,
  userInfo: () => ({ username: 'setup-user' }),
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb(setupState.answer),
    close: vi.fn(),
  }),
}));

let testRoot = '';
let projectDir = '';

function createIsolatedTmpDirs() {
  testRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-setup-flow-'));
  projectDir = join(testRoot, 'project');
  setupState.home = join(testRoot, 'home');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(setupState.home, { recursive: true });
}

function installCommandMocks() {
  execSyncMock.mockImplementation((cmd: string, opts?: { encoding?: BufferEncoding }) => {
    const mkdirMatch = cmd.match(/^mkdir -p "(.+)"$/);
    if (mkdirMatch) {
      mkdirSync(mkdirMatch[1], { recursive: true });
      return opts?.encoding ? '' : Buffer.from('');
    }
    const rmMatch = cmd.match(/^rm -f "(.+)"$/);
    if (rmMatch) {
      rmSync(rmMatch[1], { force: true });
      return opts?.encoding ? '' : Buffer.from('');
    }
    if (cmd.includes('ps --format json postgres')) {
      return opts?.encoding ? '{"State":"running"}\n' : Buffer.from('{"State":"running"}\n');
    }
    if (cmd.includes('ps --format json server')) {
      return opts?.encoding ? '{"Health":"healthy"}\n' : Buffer.from('{"Health":"healthy"}\n');
    }
    if (cmd.includes('ps --format json turn')) {
      return opts?.encoding ? '{"State":"running"}\n' : Buffer.from('{"State":"running"}\n');
    }
    return opts?.encoding ? '' : Buffer.from('');
  });
  execFileSyncMock.mockReturnValue('203.0.113.10\n');
}

/** Isolated project dir, mocked child_process/os/readline, per test. */
function useIsolatedSetupEnvironment(): void {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    createIsolatedTmpDirs();
    setupState.answer = 'y';
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    installCommandMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (testRoot) rmSync(testRoot, { recursive: true, force: true });
    testRoot = '';
    projectDir = '';
    setupState.home = '';
  });
}

describe('setupFlow contracts', () => {
  useIsolatedSetupEnvironment();

  it('generates deployment files, bootstraps the database, and self-binds the daemon', async () => {
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('example.com');

    expect(existsSync(join(projectDir, '.env'))).toBe(true);
    expect(existsSync(join(projectDir, '.setup-secrets.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'docker-compose.yml'))).toBe(true);
    expect(existsSync(join(projectDir, 'Caddyfile'))).toBe(true);
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('DOMAIN=example.com');
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_ENABLED=false');
    expect(readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8')).not.toContain('\n  turn:\n');
    expect(existsSync(join(projectDir, 'turnserver.conf'))).toBe(false);
    expect(readFileSync(join(projectDir, 'Caddyfile'), 'utf8')).toContain('example.com');

    const secrets = JSON.parse(readFileSync(join(projectDir, '.setup-secrets.json'), 'utf8'));
    expect(secrets.serverToken).toHaveLength(64);
    expect(secrets.apiKeyRaw).toMatch(/^deck_[a-f0-9]{64}$/);

    const creds = JSON.parse(readFileSync(join(setupState.home, '.imcodes', 'server.json'), 'utf8'));
    expect(creds).toMatchObject({
      serverId: secrets.serverId,
      token: secrets.serverToken,
      workerUrl: 'http://localhost:19138',
      serverName: 'setup-host',
    });

    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).toContain('docker info');
    expect(commands).toContain('docker compose version');
    expect(commands).toContain('curl -sf --connect-timeout 3 --max-time 5 https://hub.docker.com/ -o /dev/null');
    expect(commands.some((cmd) => cmd.includes('exec -T postgres psql -U imcodes -d imcodes'))).toBe(true);
    if (process.platform === 'linux') {
      expect(commands).toContain('systemctl --user daemon-reload');
    } else {
      expect(commands.some((cmd) => cmd.startsWith('systemctl --user'))).toBe(false);
    }

    const bootstrapCall = execSyncMock.mock.calls.find(([cmd]) => String(cmd).includes('exec -T postgres psql'));
    expect(String(bootstrapCall?.[1]?.input)).toContain('INSERT INTO api_keys');
    expect(String(bootstrapCall?.[1]?.input)).toContain('setup-bootstrap');
  });

  it('optionally deploys authenticated coturn with DNS-only validation and protected secrets', async () => {
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
    });

    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    const compose = readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8');
    const caddy = readFileSync(join(projectDir, 'Caddyfile'), 'utf8');
    const turnConfig = readFileSync(join(projectDir, 'turnserver.conf'), 'utf8');
    const turnEntrypoint = readFileSync(join(projectDir, 'turn-entrypoint.sh'), 'utf8');
    const setupSecrets = readFileSync(join(projectDir, '.setup-secrets.json'), 'utf8');
    const sharedSecret = env.match(/^TURN_SHARED_SECRET=([a-f0-9]+)$/m)?.[1];

    expect(env).toContain('TURN_ENABLED=true');
    expect(env).toContain('TURN_HOST=turn.example.com');
    expect(env).toContain('TURN_PORT=3479');
    expect(env).toContain('TURN_CREDENTIAL_TTL_SECONDS=86400');
    expect(env).toContain('TURN_RELAY_MIN_PORT=65436');
    expect(env).toContain('TURN_RELAY_MAX_PORT=65535');
    expect(sharedSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(compose).toContain('\n  turn:\n');
    expect(compose).toContain('coturn/coturn:4.15.0-alpine');
    expect(compose).toContain('user: "0:0"');
    expect(compose).toContain('${TURN_PORT}:${TURN_PORT}/udp');
    expect(compose).toContain('${TURN_PORT}:${TURN_PORT}/tcp');
    expect(compose).toContain('${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}');
    expect(compose).toContain('./turn-entrypoint.sh:/usr/local/bin/imcodes-turn-entrypoint:ro');
    expect(compose).toContain('entrypoint: ["/bin/sh", "/usr/local/bin/imcodes-turn-entrypoint"]');
    expect(compose).not.toContain(String(sharedSecret));
    expect(setupSecrets).not.toContain(String(sharedSecret));
    expect(turnConfig).toContain(`static-auth-secret=${sharedSecret}`);
    expect(turnConfig).toContain('proc-user=nobody');
    expect(turnConfig).toContain('proc-group=nogroup');
    expect(turnConfig).toContain('realm=turn.example.com');
    expect(turnConfig).toContain('external-ip=203.0.113.10');
    expect(turnConfig).toContain('denied-peer-ip=10.0.0.0-10.255.255.255');
    expect(turnConfig).toContain('denied-peer-ip=100.64.0.0-100.127.255.255');
    expect(turnConfig).toContain('denied-peer-ip=127.0.0.0-127.255.255.255');
    expect(turnConfig).toContain('denied-peer-ip=172.16.0.0-172.31.255.255');
    expect(turnConfig).toContain('denied-peer-ip=192.168.0.0-192.168.255.255');
    expect(turnConfig).toContain('denied-peer-ip=::1-::1');
    expect(turnConfig).toContain('denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
    expect(turnConfig).toContain('denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
    expect(turnConfig).not.toContain('denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
    expect(turnConfig).toContain('denied-peer-ip=203.0.113.10-203.0.113.10');
    expect(turnConfig).toContain('allowed-peer-ip=203.0.113.10-203.0.113.10');
    expect(turnEntrypoint).toContain('hostname -i');
    expect(turnEntrypoint).toContain('--allowed-peer-ip="${turn_container_ipv4}-${turn_container_ipv4}"');
    expect(turnEntrypoint).toContain('exec docker-entrypoint.sh "$@"');
    expect(turnConfig).toContain('user-quota=32');
    expect(turnConfig).toContain('total-quota=100');
    expect(turnConfig).not.toContain('\ncli\n');
    expect(turnConfig).not.toContain('no-cli');
    expect(turnConfig).not.toContain('no-loopback-peers');
    expect(caddy).not.toContain('turn.example.com');
    expect(caddy).not.toContain('3479');
    expect(statSync(join(projectDir, '.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(projectDir, '.setup-secrets.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(projectDir, 'turnserver.conf')).mode & 0o777).toBe(0o600);
    expect(statSync(join(projectDir, 'turn-entrypoint.sh')).mode & 0o777).toBe(0o700);
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.some((cmd) => cmd.includes('up -d --force-recreate turn'))).toBe(true);
  });

  it('uses the same reachable registry proxy for coturn in mirror mode', async () => {
    const { dockerComposeTemplate } = await import('../../src/setup/templates.js');

    const compose = dockerComposeTemplate({
      ghcrPrefix: 'ghcr.nju.edu.cn',
      turnImage: 'ghcr.nju.edu.cn/coturn/coturn:4.15.0-alpine',
      turn: { enabled: true },
    });

    expect(compose).toContain('image: ghcr.nju.edu.cn/im4codes/imcodes:latest');
    expect(compose).toContain('image: ghcr.nju.edu.cn/coturn/coturn:4.15.0-alpine');
    expect(compose).not.toContain('\n    image: coturn/coturn:4.15.0-alpine');
  });

  it('defaults TURN to a separate DNS-only hostname instead of the proxied application hostname', async () => {
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('app.example.com', {
      turn: true,
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
    });

    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_HOST=turn.app.example.com');
    const caddy = readFileSync(join(projectDir, 'Caddyfile'), 'utf8');
    expect(caddy).toContain('app.example.com');
    expect(caddy).not.toContain('turn.app.example.com');
  });

  it('rejects a TURN hostname whose A record does not point directly to the deployment IPv4', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, args: string[]) => (
      args.includes('turn.example.com') ? '198.51.100.22\n' : '203.0.113.10\n'
    ));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(join(projectDir, 'turnserver.conf'))).toBe(false);
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
  });

  it('requires explicit DNS-only acknowledgement for non-interactive TURN setup', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('turn.example.com', {
      turn: true,
      turnExternalIp: '203.0.113.10',
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects reserved or overlapping TURN listener ports before writing deployment files', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('turn.example.com', {
      turn: true,
      turnPort: '443',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
  });

  it('resumes from existing environment and setup secrets without regenerating credentials', async () => {
    writeFileSync(join(projectDir, '.env'), [
      'DOMAIN=old.example.com',
      'POSTGRES_PASSWORD=postgres-secret',
      'JWT_SIGNING_KEY=jwt-secret',
      'DEFAULT_ADMIN_PASSWORD=admin-secret',
    ].join('\n'));
    writeFileSync(join(projectDir, '.setup-secrets.json'), JSON.stringify({
      postgresPassword: 'old-postgres',
      jwtSigningKey: 'old-jwt',
      adminPassword: 'old-admin',
      serverToken: 'server-token',
      serverId: 'server-id',
      apiKeyRaw: 'deck_' + 'a'.repeat(64),
      apiKeyId: 'api-key-id',
    }));

    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('new.example.com');

    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('DOMAIN=new.example.com');
    const secrets = JSON.parse(readFileSync(join(projectDir, '.setup-secrets.json'), 'utf8'));
    expect(secrets).toMatchObject({
      postgresPassword: 'postgres-secret',
      jwtSigningKey: 'jwt-secret',
      adminPassword: 'admin-secret',
      serverToken: 'server-token',
      serverId: 'server-id',
      apiKeyRaw: 'deck_' + 'a'.repeat(64),
      apiKeyId: 'api-key-id',
    });
  });

  it('preserves the TURN shared secret and deployment settings when setup resumes', async () => {
    const turnSecret = 'b'.repeat(64);
    writeFileSync(join(projectDir, '.env'), [
      'DOMAIN=turn.example.com',
      'POSTGRES_PASSWORD=postgres-secret',
      'JWT_SIGNING_KEY=jwt-secret',
      'DEFAULT_ADMIN_PASSWORD=admin-secret',
      'TURN_ENABLED=true',
      'TURN_HOST=turn.example.com',
      'TURN_PORT=3479',
      'TURN_EXTERNAL_IP=203.0.113.10',
      `TURN_SHARED_SECRET=${turnSecret}`,
      'TURN_CREDENTIAL_TTL_SECONDS=3600',
      'TURN_RELAY_MIN_PORT=49160',
      'TURN_RELAY_MAX_PORT=49200',
    ].join('\n'));
    writeFileSync(join(projectDir, '.setup-secrets.json'), JSON.stringify({
      serverToken: 'server-token',
      serverId: 'server-id',
      apiKeyRaw: 'deck_' + 'a'.repeat(64),
      apiKeyId: 'api-key-id',
      turnSharedSecret: turnSecret,
    }));

    execFileSyncMock.mockImplementation((command: string) => {
      if (command === 'dig') throw new Error('dig unavailable');
      return '';
    });
    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    await setupFlow('turn.example.com');

    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain(`TURN_SHARED_SECRET=${turnSecret}`);
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_CREDENTIAL_TTL_SECONDS=3600');
    expect(readFileSync(join(projectDir, 'turnserver.conf'), 'utf8')).toContain(`static-auth-secret=${turnSecret}`);
  });

  it('upgrades only the legacy two-hour TURN credential lifetime on resume', async () => {
    const turnSecret = 'e'.repeat(64);
    writeFileSync(join(projectDir, '.env'), [
      'DOMAIN=turn.example.com',
      'POSTGRES_PASSWORD=postgres-secret',
      'JWT_SIGNING_KEY=jwt-secret',
      'DEFAULT_ADMIN_PASSWORD=admin-secret',
      'TURN_ENABLED=true',
      'TURN_HOST=turn.example.com',
      'TURN_PORT=3479',
      'TURN_EXTERNAL_IP=203.0.113.10',
      `TURN_SHARED_SECRET=${turnSecret}`,
      'TURN_CREDENTIAL_TTL_SECONDS=7200',
      'TURN_RELAY_MIN_PORT=49160',
      'TURN_RELAY_MAX_PORT=49200',
    ].join('\n'));
    writeFileSync(join(projectDir, '.setup-secrets.json'), JSON.stringify({
      serverToken: 'server-token',
      serverId: 'server-id',
      apiKeyRaw: 'deck_' + 'a'.repeat(64),
      apiKeyId: 'api-key-id',
      turnSharedSecret: turnSecret,
    }));
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === 'dig') throw new Error('dig unavailable');
      return '';
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('turn.example.com');

    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_CREDENTIAL_TTL_SECONDS=86400');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('upgrading the legacy 7200-second'));
  });

  it('updates a recovered TURN external IP when current discovery and DNS agree', async () => {
    const turnSecret = 'd'.repeat(64);
    writeFileSync(join(projectDir, '.env'), [
      'DOMAIN=app.example.com',
      'POSTGRES_PASSWORD=postgres-secret',
      'JWT_SIGNING_KEY=jwt-secret',
      'DEFAULT_ADMIN_PASSWORD=admin-secret',
      'TURN_ENABLED=true',
      'TURN_HOST=turn.example.com',
      'TURN_PORT=3479',
      'TURN_EXTERNAL_IP=198.51.100.10',
      `TURN_SHARED_SECRET=${turnSecret}`,
      'TURN_CREDENTIAL_TTL_SECONDS=86400',
      'TURN_RELAY_MIN_PORT=49160',
      'TURN_RELAY_MAX_PORT=49200',
    ].join('\n'));
    writeFileSync(join(projectDir, '.setup-secrets.json'), JSON.stringify({
      serverToken: 'server-token',
      serverId: 'server-id',
      apiKeyRaw: 'deck_' + 'a'.repeat(64),
      apiKeyId: 'api-key-id',
      turnSharedSecret: turnSecret,
    }));
    execFileSyncMock.mockImplementation((command: string) => (
      command === 'curl' ? '203.0.113.10\n' : '203.0.113.10\n'
    ));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    await setupFlow('app.example.com');

    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_EXTERNAL_IP=203.0.113.10');
    expect(readFileSync(join(projectDir, 'turnserver.conf'), 'utf8')).toContain('external-ip=203.0.113.10');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('public IPv4 changed'));
  });

  it('runs force teardown before regenerating setup state when confirmed', async () => {
    writeFileSync(join(projectDir, '.env'), 'DOMAIN=old.example.com\n');
    writeFileSync(join(projectDir, '.setup-secrets.json'), '{}');
    writeFileSync(join(projectDir, 'docker-compose.yml'), 'old compose');
    writeFileSync(join(projectDir, 'Caddyfile'), 'old caddy');
    writeFileSync(join(projectDir, 'turnserver.conf'), 'old turn secret');

    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('fresh.example.com', { force: true });

    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.some((cmd) => cmd.includes('down -v --remove-orphans'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes('rm -f'))).toBe(true);
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('DOMAIN=fresh.example.com');
    expect(existsSync(join(projectDir, 'turnserver.conf'))).toBe(false);
  });

  it('rotates the TURN shared secret on a confirmed forced reinstall', async () => {
    const oldSecret = 'c'.repeat(64);
    writeFileSync(join(projectDir, '.env'), [
      'DOMAIN=turn.example.com',
      'TURN_ENABLED=true',
      `TURN_SHARED_SECRET=${oldSecret}`,
    ].join('\n'));
    writeFileSync(join(projectDir, '.setup-secrets.json'), '{}');
    writeFileSync(join(projectDir, 'turnserver.conf'), `static-auth-secret=${oldSecret}\n`);
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('turn.example.com', {
      force: true,
      turn: true,
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
    });

    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    const nextSecret = env.match(/^TURN_SHARED_SECRET=([a-f0-9]+)$/m)?.[1];
    expect(nextSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(nextSecret).not.toBe(oldSecret);
    expect(readFileSync(join(projectDir, 'turnserver.conf'), 'utf8')).toContain(`static-auth-secret=${nextSecret}`);
  });

  it('exits early when force teardown is not confirmed', async () => {
    setupState.answer = 'n';
    writeFileSync(join(projectDir, '.env'), 'DOMAIN=old.example.com\n');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('fresh.example.com', { force: true })).rejects.toThrow('exit:0');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(execSyncMock.mock.calls.map(([cmd]) => String(cmd)).some((cmd) => cmd.includes('down -v'))).toBe(false);
  });
});

/**
 * The installer and the server runtime must agree about what a valid TURN relay
 * range is.
 *
 * They did not. This installer capped the range at 256 UDP ports and the server
 * runtime capped it at 256 independently — then production was configured with
 * 49201-50200 (1000 ports), written into .env, into coturn's min-port/max-port
 * and into the Docker publish list, and the runtime silently refused the whole
 * TURN configuration and served every client a STUN-only ICE list. Mobile
 * direct-file transfer and remote desktop both died at ICE with a healthy
 * coturn sitting there. One rule, one place, or it happens again.
 */
describe('the TURN relay range rule is shared, not copied', () => {
  it('accepts the production range and refuses what is genuinely wrong', async () => {
    const {
      TURN_RELAY_RANGE_REJECTION,
      parseTurnRelayRange,
    } = await import('../../shared/turn-service.js');

    // im.zhinet.work, the range this incident was about.
    expect(parseTurnRelayRange({ port: 3480, relayMinPort: 49_201, relayMaxPort: 50_200 }))
      .toEqual({ relayMinPort: 49_201, relayMaxPort: 50_200 });

    // No width ceiling: the range is deployment configuration, so a wide but
    // protocol-valid span must be accepted exactly as coturn would serve it.
    expect(parseTurnRelayRange({ port: 3480, relayMinPort: 49_152, relayMaxPort: 65_535 }))
      .toEqual({ relayMinPort: 49_152, relayMaxPort: 65_535 });
    expect(parseTurnRelayRange({ port: 3480, relayMinPort: 50_200, relayMaxPort: 49_201 }))
      .toEqual({ rejection: TURN_RELAY_RANGE_REJECTION.INVERTED });
    expect(parseTurnRelayRange({ port: 3480, relayMinPort: 49_201, relayMaxPort: 70_000 }))
      .toEqual({ rejection: TURN_RELAY_RANGE_REJECTION.MAX_PORT_INVALID });
    expect(parseTurnRelayRange({ port: 49_500, relayMinPort: 49_201, relayMaxPort: 50_200 }))
      .toEqual({ rejection: TURN_RELAY_RANGE_REJECTION.LISTENER_INSIDE_RANGE });
  });

  it('leaves neither call site with its own copy of the arithmetic', () => {
    // A drift guard, because the duplicate rule is the actual defect. Both
    // files must delegate; neither may compute the span or hard-code a ceiling.
    const setup = readFileSync(join(import.meta.dirname, '../../src/setup/setup-flow.ts'), 'utf8');
    const runtime = readFileSync(join(import.meta.dirname, '../../server/src/ws/turn-credentials.ts'), 'utf8');
    for (const [name, source] of [['setup-flow.ts', setup], ['turn-credentials.ts', runtime]] as const) {
      expect(source, `${name} must delegate to the shared relay-range rule`)
        .toContain('parseTurnRelayRange');
      expect(source, `${name} recomputes the relay span instead of delegating`)
        .not.toMatch(/relayMaxPort\s*-\s*relayMinPort/);
      expect(source, `${name} hard-codes a relay-range ceiling`)
        .not.toMatch(/>\s*255\b/);
    }
  });
});

/**
 * The relay range has ONE source of truth: the deployment configuration.
 *
 * The original incident was two implementations of the same rule with
 * different ceilings — the installer wrote 49201-50200 into .env, into coturn's
 * min-port/max-port and into the Docker publish range, and the server runtime
 * then refused that exact deployment and served every client a STUN-only ICE
 * list. Collapsing the rule into one shared function fixed the disagreement,
 * but a fixed width in application code reintroduces the same failure shape one
 * size larger: coturn's OWN default relay range is 49152-65535, i.e. 16384
 * ports, and any application-side cap below that rejects a correctly
 * configured TURN service for reasons the TURN service knows nothing about.
 *
 * So this pins the property rather than a number: whatever range the deployment
 * configures, coturn's config, the .env the runtime reads, and the runtime's
 * own validation must all describe the SAME ports. Only protocol-valid checks
 * may reject — port bounds, min <= max, and a listener sitting inside the relay
 * range.
 */
describe('the relay range comes from the deployment config, not from a number in code', () => {
  const RANGES = [
    { label: 'coturn default', relayMinPort: 49_152, relayMaxPort: 65_535 },
    { label: 'production im.zhinet.work', relayMinPort: 49_201, relayMaxPort: 50_200 },
    { label: 'small deployment', relayMinPort: 49_160, relayMaxPort: 49_200 },
    { label: 'single relay port', relayMinPort: 50_000, relayMaxPort: 50_000 },
  ];

  it.each(RANGES.map((r) => [r.label, r] as const))(
    'accepts %s and describes the same ports in coturn, .env and the runtime',
    async (_label, range) => {
      const { parseTurnRelayRange } = await import('../../shared/turn-service.js');
      const { turnserverConfigTemplate, envTemplate } = await import('../../src/setup/templates.js');

      const turn = {
        host: 'turn.example.test',
        port: 3480,
        externalIp: '203.0.113.10',
        sharedSecret: 'x'.repeat(64),
        credentialTtlSeconds: 86_400,
        ...range,
      };

      // 1. What coturn is told.
      const coturn = turnserverConfigTemplate(turn);
      expect(coturn).toContain(`min-port=${range.relayMinPort}`);
      expect(coturn).toContain(`max-port=${range.relayMaxPort}`);

      // 2. What the runtime reads. The compose file publishes exactly these two
      //    env values as its UDP range, so .env is the shared hand-off.
      const env = envTemplate({
        domain: 'example.test',
        postgresPassword: 'p',
        jwtSigningKey: 'j',
        adminPassword: 'a',
        turn: { enabled: true, ...turn },
      });
      expect(env).toContain(`TURN_RELAY_MIN_PORT=${range.relayMinPort}`);
      expect(env).toContain(`TURN_RELAY_MAX_PORT=${range.relayMaxPort}`);

      // 3. What the runtime and the installer both validate through.
      expect(
        parseTurnRelayRange({ port: turn.port, ...range }),
        'the shared rule rejected a range the TURN service is correctly configured with',
      ).toEqual({ relayMinPort: range.relayMinPort, relayMaxPort: range.relayMaxPort });
    },
  );

  it('still fails closed on the protocol-valid checks only', async () => {
    const { TURN_RELAY_RANGE_REJECTION, parseTurnRelayRange } = await import('../../shared/turn-service.js');
    expect(parseTurnRelayRange({ port: 3480, relayMinPort: 0, relayMaxPort: 50_000 }))
      .toEqual({ rejection: TURN_RELAY_RANGE_REJECTION.MIN_PORT_INVALID });
    expect(parseTurnRelayRange({ port: 3480, relayMinPort: 49_201, relayMaxPort: 70_000 }))
      .toEqual({ rejection: TURN_RELAY_RANGE_REJECTION.MAX_PORT_INVALID });
    expect(parseTurnRelayRange({ port: 3480, relayMinPort: 50_200, relayMaxPort: 49_201 }))
      .toEqual({ rejection: TURN_RELAY_RANGE_REJECTION.INVERTED });
    expect(parseTurnRelayRange({ port: 49_500, relayMinPort: 49_201, relayMaxPort: 50_200 }))
      .toEqual({ rejection: TURN_RELAY_RANGE_REJECTION.LISTENER_INSIDE_RANGE });
  });

  it('keeps no width limit of its own in application code', async () => {
    // A width cap in code is a second source of truth by definition: it can
    // refuse a range the TURN service is happily serving, and nothing in the
    // deployment tells it what the limit is.
    const shared = readFileSync(join(import.meta.dirname, '../../shared/turn-service.ts'), 'utf8');
    expect(shared, 'shared/turn-service.ts still caps the relay width in code')
      .not.toMatch(/RELAY_PORT_MAX_COUNT|TOO_MANY_PORTS/);
    for (const rel of ['../../src/setup/setup-flow.ts', '../../server/src/ws/turn-credentials.ts']) {
      const source = readFileSync(join(import.meta.dirname, rel), 'utf8');
      expect(source, `${rel} still references a code-side relay width cap`)
        .not.toMatch(/RELAY_PORT_MAX_COUNT|TOO_MANY_PORTS/);
    }
  });
});

describe('the updater is not inside the scope it watches', () => {
  // Measured on the 43 deployment, 2026-09-09: the watchtower service carried
  // the same com.centurylinklabs.watchtower.scope label as the application, so
  // every update session had to resolve the updater's own image first. That
  // image lives on a different registry than the application's, and when that
  // registry is slow the session burns its whole budget there and never
  // reaches the application container. Last application update was
  // 2026-09-08T22:41:31Z; the 24h that followed contained 48 update sessions
  // that were aborted mid-run and zero that completed, while a newer
  // application image sat available on a registry answering in 70ms.
  const SCOPE_LABEL = 'com.centurylinklabs.watchtower.scope';

  type ComposeService = {
    labels?: string[];
    volumes?: string[];
    environment?: Record<string, unknown>;
    command?: string | string[];
  };

  async function composeServices(turnEnabled: boolean): Promise<Record<string, ComposeService>> {
    const { dockerComposeTemplate } = await import('../../src/setup/templates.js');
    const { parse } = await import('yaml');
    const doc = parse(dockerComposeTemplate({ turn: { enabled: turnEnabled } })) as {
      services: Record<string, ComposeService>;
    };
    return doc.services;
  }

  function scopeLabelOf(service: ComposeService): string | undefined {
    const hit = (service.labels ?? []).find((label) => label.startsWith(`${SCOPE_LABEL}=`));
    return hit === undefined ? undefined : hit.slice(SCOPE_LABEL.length + 1);
  }

  /** The scope the updater actually filters on, taken from the updater itself. */
  function watchedScope(services: Record<string, ComposeService>): string {
    const updater = services.watchtower;
    expect(updater, 'no watchtower service in the generated compose file').toBeDefined();
    const fromEnv = String(updater.environment?.WATCHTOWER_SCOPE ?? '');
    const command = Array.isArray(updater.command) ? updater.command.join(' ') : String(updater.command ?? '');
    const fromFlag = /--scope[= ](\S+)/.exec(command)?.[1] ?? '';
    expect(fromEnv, 'the updater declares no WATCHTOWER_SCOPE').not.toBe('');
    expect(fromFlag, 'the --scope flag and WATCHTOWER_SCOPE disagree').toBe(fromEnv);
    return fromEnv;
  }

  it('never lists the updater among the containers it updates', async () => {
    const services = await composeServices(true);
    const watched = watchedScope(services);

    expect(
      scopeLabelOf(services.watchtower),
      'the updater is labelled with the scope it watches, so it must resolve its own image before the application\'s',
    ).toBeUndefined();

    const inScope = Object.entries(services)
      .filter(([, service]) => scopeLabelOf(service) === watched)
      .map(([name]) => name);
    expect(inScope).not.toContain('watchtower');
  });

  it('keeps every holder of the docker socket out of the watched scope', async () => {
    const services = await composeServices(true);
    const watched = watchedScope(services);

    for (const [name, service] of Object.entries(services)) {
      const drivesDocker = (service.volumes ?? []).some((volume) => String(volume).includes('/var/run/docker.sock'));
      if (!drivesDocker) continue;
      expect(
        scopeLabelOf(service),
        `${name} both performs updates and is subject to them`,
      ).not.toBe(watched);
    }
  });

  it('still updates the application and TURN containers automatically', async () => {
    const services = await composeServices(true);
    const watched = watchedScope(services);

    expect(scopeLabelOf(services.server), 'the application would stop receiving automatic updates').toBe(watched);
    expect(scopeLabelOf(services.turn), 'TURN would stop receiving automatic updates').toBe(watched);
  });

  it('labels exactly the updatable application services, in both TURN modes', async () => {
    for (const turnEnabled of [false, true]) {
      const services = await composeServices(turnEnabled);
      const watched = watchedScope(services);
      const labelled = Object.entries(services).filter(([, service]) => scopeLabelOf(service) !== undefined);

      expect(labelled.map(([name]) => name)).toEqual(turnEnabled ? ['server', 'turn'] : ['server']);
      for (const [name, service] of labelled) {
        expect(scopeLabelOf(service), `${name} is labelled with a scope the updater does not watch`).toBe(watched);
      }
    }
  });
});

/**
 * Relay capacity is the question the installer can actually ask.
 *
 * "How many ports?" is unanswerable by an operator; "how many people can be
 * relaying at the same time?" is. Standard coturn — multiplex-peer deliberately
 * off — binds one UDP relay endpoint per allocation, so the answer converts to
 * ports 1:1, and that conversion is the only place the two ever meet.
 *
 * The failure this replaces was a relay range invented in code: 49160-49200,
 * 41 ports, on a deployment expected to serve real concurrent traffic, with a
 * coturn total-quota of 64 that did not match the 41 ports it had to bind. The
 * numbers disagreed with each other and neither came from the deployment.
 */
describe('TURN relay capacity is asked in allocations and answered in ports', () => {
  useIsolatedSetupEnvironment();

  const exitOnFatal = () => vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  }) as never);

  async function shared() {
    return import('../../shared/turn-service.js');
  }

  it('defaults to 100, accepts 1 and 30000, and refuses 30001 with deployment guidance', async () => {
    const {
      TURN_RELAY_CAPACITY,
      TURN_RELAY_CAPACITY_REJECTION,
      parseTurnRelayCapacity,
      turnRelayCapacityRejectionMessage,
    } = await shared();

    expect(TURN_RELAY_CAPACITY.DEFAULT_ALLOCATIONS).toBe(100);
    expect(parseTurnRelayCapacity(undefined)).toEqual({ capacity: 100 });
    expect(parseTurnRelayCapacity('')).toEqual({ capacity: 100 });
    expect(parseTurnRelayCapacity('   ')).toEqual({ capacity: 100 });
    expect(parseTurnRelayCapacity('1')).toEqual({ capacity: 1 });
    expect(parseTurnRelayCapacity(1)).toEqual({ capacity: 1 });
    expect(parseTurnRelayCapacity('30000')).toEqual({ capacity: 30_000 });
    expect(parseTurnRelayCapacity(30_000)).toEqual({ capacity: 30_000 });

    // Never clamped. A request for more than one node can relay must fail, not
    // quietly become 30000 and look healthy until it drops calls under load.
    expect(parseTurnRelayCapacity('30001'))
      .toEqual({ rejection: TURN_RELAY_CAPACITY_REJECTION.ABOVE_MAX });
    expect(parseTurnRelayCapacity(30_001))
      .toEqual({ rejection: TURN_RELAY_CAPACITY_REJECTION.ABOVE_MAX });
    expect(parseTurnRelayCapacity(100_000))
      .toEqual({ rejection: TURN_RELAY_CAPACITY_REJECTION.ABOVE_MAX });
    expect(parseTurnRelayCapacity('0'))
      .toEqual({ rejection: TURN_RELAY_CAPACITY_REJECTION.BELOW_MIN });

    const guidance = turnRelayCapacityRejectionMessage(TURN_RELAY_CAPACITY_REJECTION.ABOVE_MAX);
    expect(guidance).toContain('30000');
    expect(guidance).toMatch(/additional TURN nodes/);
    expect(guidance).toMatch(/public IPv4 addresses/);
  });

  it('refuses anything that is not a whole number of allocations', async () => {
    const { TURN_RELAY_CAPACITY_REJECTION, parseTurnRelayCapacity } = await shared();
    for (const invalid of ['abc', '1.5', '-5', '1e4', '0x10', '100 users', '١٠٠', '+5', '1,000']) {
      expect(parseTurnRelayCapacity(invalid), `${invalid} was accepted as a capacity`)
        .toEqual({ rejection: TURN_RELAY_CAPACITY_REJECTION.NOT_A_POSITIVE_INTEGER });
    }
    expect(parseTurnRelayCapacity(1.5))
      .toEqual({ rejection: TURN_RELAY_CAPACITY_REJECTION.NOT_A_POSITIVE_INTEGER });
    expect(parseTurnRelayCapacity(Number.NaN))
      .toEqual({ rejection: TURN_RELAY_CAPACITY_REJECTION.NOT_A_POSITIVE_INTEGER });
    expect(parseTurnRelayCapacity(Number.POSITIVE_INFINITY))
      .toEqual({ rejection: TURN_RELAY_CAPACITY_REJECTION.NOT_A_POSITIVE_INTEGER });
  });

  it('turns every accepted capacity into a protocol-valid range that round-trips', async () => {
    const {
      TURN_RELAY_CAPACITY,
      parseTurnRelayRange,
      turnRelayCapacityForRange,
      turnRelayRangeForCapacity,
    } = await shared();

    for (const capacity of [1, 2, 41, 100, 999, 1_000, 16_384, 29_999, 30_000]) {
      const range = turnRelayRangeForCapacity(capacity);
      // The whole reason the range is anchored at the top: a fixed low start
      // cannot hold 30000 ports, and an out-of-range port is not a range.
      expect(parseTurnRelayRange({ port: 3479, ...range }), `capacity ${capacity} produced an invalid range`)
        .toEqual(range);
      expect(range.relayMaxPort).toBe(TURN_RELAY_CAPACITY.RANGE_END_PORT);
      expect(range.relayMinPort).toBeGreaterThan(1_024);
      expect(turnRelayCapacityForRange(range.relayMinPort, range.relayMaxPort)).toBe(capacity);
    }

    expect(turnRelayRangeForCapacity(1)).toEqual({ relayMinPort: 65_535, relayMaxPort: 65_535 });
    expect(turnRelayRangeForCapacity(100)).toEqual({ relayMinPort: 65_436, relayMaxPort: 65_535 });
    expect(turnRelayRangeForCapacity(30_000)).toEqual({ relayMinPort: 35_536, relayMaxPort: 65_535 });

    // Larger capacity is a superset, never a different neighbourhood.
    expect(turnRelayRangeForCapacity(30_000).relayMinPort)
      .toBeLessThan(turnRelayRangeForCapacity(100).relayMinPort);
  });

  it('keeps the deployment total and the per-credential limit as two different numbers', async () => {
    const { TURN_RELAY_CAPACITY } = await shared();
    const { turnserverConfigTemplate } = await import('../../src/setup/templates.js');

    const render = (relayMinPort: number, relayMaxPort: number) => turnserverConfigTemplate({
      host: 'turn.example.test',
      port: 3480,
      externalIp: '203.0.113.10',
      sharedSecret: 'x'.repeat(64),
      credentialTtlSeconds: 86_400,
      relayMinPort,
      relayMaxPort,
    });

    // total-quota is read back out of the range, so coturn can never be told it
    // may hold more concurrent allocations than it has ports to bind.
    expect(render(65_535, 65_535)).toContain('total-quota=1');
    expect(render(65_436, 65_535)).toContain('total-quota=100');
    expect(render(49_201, 50_200)).toContain('total-quota=1000');
    expect(render(35_536, 65_535)).toContain('total-quota=30000');
    for (const config of [render(65_535, 65_535), render(35_536, 65_535)]) {
      expect(config).toContain(`user-quota=${TURN_RELAY_CAPACITY.USER_QUOTA_ALLOCATIONS}`);
      // Standard coturn only: nothing here may assume shared relay ports.
      expect(config).not.toContain('multiplex');
    }
  });

  it('sizes a fresh non-interactive install for the default 100 allocations', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
    });

    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    const turnConfig = readFileSync(join(projectDir, 'turnserver.conf'), 'utf8');
    const compose = readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8');
    expect(env).toContain('TURN_RELAY_MIN_PORT=65436');
    expect(env).toContain('TURN_RELAY_MAX_PORT=65535');
    expect(turnConfig).toContain('min-port=65436');
    expect(turnConfig).toContain('max-port=65535');
    expect(turnConfig).toContain('total-quota=100');
    // The published UDP range is the same two values, by reference.
    expect(compose).toContain('${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}');
    const summary = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(summary).toContain('100 concurrent relay allocations');
    expect(summary).toContain('UDP 65436-65535');
  });

  it.each([
    { capacity: 1, min: 65_535, max: 65_535, quota: 1, summary: '1 concurrent relay allocation' },
    { capacity: 250, min: 65_286, max: 65_535, quota: 250, summary: '250 concurrent relay allocations' },
    { capacity: 1_024, min: 64_512, max: 65_535, quota: 1_024, summary: '1024 concurrent relay allocations' },
  ])('sizes an explicit capacity of $capacity into $min-$max', async ({ capacity, min, max, quota, summary }) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      turnRelayCapacity: capacity,
    });

    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    const turnConfig = readFileSync(join(projectDir, 'turnserver.conf'), 'utf8');
    expect(env).toContain(`TURN_RELAY_MIN_PORT=${min}`);
    expect(env).toContain(`TURN_RELAY_MAX_PORT=${max}`);
    expect(turnConfig).toContain(`min-port=${min}`);
    expect(turnConfig).toContain(`max-port=${max}`);
    expect(turnConfig).toContain(`total-quota=${quota}`);
    const printed = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(printed).toContain(summary);
    expect(printed).toContain(`UDP ${min}-${max}`);
  });

  it('refuses 30001 allocations before writing any deployment file', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = exitOnFatal();
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      turnRelayCapacity: '30001',
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(message).toMatch(/additional TURN nodes/);
    expect(message).toMatch(/public IPv4 addresses/);
    // Not clamped to the maximum behind the operator's back.
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
    expect(existsSync(join(projectDir, 'turnserver.conf'))).toBe(false);
  });

  it.each(['abc', '0', '1.5', '-5'])('refuses the invalid capacity %s before writing anything', async (invalid) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = exitOnFatal();
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      turnRelayCapacity: invalid,
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'))
      .toMatch(/TURN relay capacity must be/);
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
  });

  it('asks interactively and takes an empty answer as the documented default', async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      setupState.answer = '';
      const { setupFlow } = await import('../../src/setup/setup-flow.js');
      await setupFlow('app.example.com', {
        turn: true,
        turnHost: 'turn.example.com',
        turnExternalIp: '203.0.113.10',
        turnDnsOnly: true,
      });
      expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_RELAY_MIN_PORT=65436');
      expect(readFileSync(join(projectDir, 'turnserver.conf'), 'utf8')).toContain('total-quota=100');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });

  it('takes an interactive answer of 500 allocations', async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      setupState.answer = '500';
      const { setupFlow } = await import('../../src/setup/setup-flow.js');
      await setupFlow('app.example.com', {
        turn: true,
        turnHost: 'turn.example.com',
        turnExternalIp: '203.0.113.10',
        turnDnsOnly: true,
      });
      const env = readFileSync(join(projectDir, '.env'), 'utf8');
      expect(env).toContain('TURN_RELAY_MIN_PORT=65036');
      expect(env).toContain('TURN_RELAY_MAX_PORT=65535');
      expect(readFileSync(join(projectDir, 'turnserver.conf'), 'utf8')).toContain('total-quota=500');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });
});

/**
 * Upgrades must not move the ports underneath a running coturn.
 *
 * Production publishes 49201-50200. That range is not derivable from any
 * capacity anchor, it is already in coturn's min-port/max-port, in the Docker
 * publish list and in the firewall, and it is what live allocations are bound
 * to. A capacity default that silently replaced it would shrink the deployment
 * from 1000 concurrent relays to 100 and relocate every port, which is the same
 * class of defect as the width cap that refused it outright.
 */
describe('an existing relay range survives the capacity question', () => {
  useIsolatedSetupEnvironment();

  const TURN_SECRET = 'c'.repeat(64);

  function writeExistingDeployment(relay: { min?: string; max?: string }): void {
    writeFileSync(join(projectDir, '.env'), [
      'DOMAIN=app.example.com',
      'POSTGRES_PASSWORD=postgres-secret',
      'JWT_SIGNING_KEY=jwt-secret',
      'DEFAULT_ADMIN_PASSWORD=admin-secret',
      'TURN_ENABLED=true',
      'TURN_HOST=turn.example.com',
      'TURN_PORT=3480',
      'TURN_EXTERNAL_IP=203.0.113.10',
      `TURN_SHARED_SECRET=${TURN_SECRET}`,
      'TURN_CREDENTIAL_TTL_SECONDS=86400',
      ...(relay.min === undefined ? [] : [`TURN_RELAY_MIN_PORT=${relay.min}`]),
      ...(relay.max === undefined ? [] : [`TURN_RELAY_MAX_PORT=${relay.max}`]),
    ].join('\n'));
    writeFileSync(join(projectDir, '.setup-secrets.json'), JSON.stringify({
      serverToken: 'server-token',
      serverId: 'server-id',
      apiKeyRaw: 'deck_' + 'a'.repeat(64),
      apiKeyId: 'api-key-id',
      turnSharedSecret: TURN_SECRET,
    }));
  }

  it('preserves 49201-50200 and sizes coturn to the 1000 allocations it already serves', async () => {
    writeExistingDeployment({ min: '49201', max: '50200' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('app.example.com', { turnDnsOnly: true });

    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    const turnConfig = readFileSync(join(projectDir, 'turnserver.conf'), 'utf8');
    expect(env).toContain('TURN_RELAY_MIN_PORT=49201');
    expect(env).toContain('TURN_RELAY_MAX_PORT=50200');
    expect(env).not.toContain('TURN_RELAY_MIN_PORT=65436');
    expect(turnConfig).toContain('min-port=49201');
    expect(turnConfig).toContain('max-port=50200');
    expect(turnConfig).toContain('total-quota=1000');
    expect(logSpy.mock.calls.map((call) => call.join(' ')).join('\n'))
      .toContain('1000 concurrent relay allocations');
  });

  it('does not shrink a recovered range even when a TTY is available to ask', async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      writeExistingDeployment({ min: '49201', max: '50200' });
      setupState.answer = '1';
      const { setupFlow } = await import('../../src/setup/setup-flow.js');
      await setupFlow('app.example.com', { turnDnsOnly: true });
      expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_RELAY_MAX_PORT=50200');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });

  it('completes a half-given explicit override from the existing range', async () => {
    writeExistingDeployment({ min: '49201', max: '50200' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('app.example.com', { turnDnsOnly: true, turnRelayMaxPort: '50500' });

    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    expect(env).toContain('TURN_RELAY_MIN_PORT=49201');
    expect(env).toContain('TURN_RELAY_MAX_PORT=50500');
    expect(readFileSync(join(projectDir, 'turnserver.conf'), 'utf8')).toContain('total-quota=1300');
    expect(warnSpy.mock.calls.map((call) => call.join(' ')).join('\n'))
      .toContain('49201-50200');
  });

  it('warns in full when an explicit capacity relocates and reduces an existing range', async () => {
    writeExistingDeployment({ min: '49201', max: '50200' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('app.example.com', { turnDnsOnly: true, turnRelayCapacity: '100' });

    const warning = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warning).toContain('49201-50200');
    expect(warning).toContain('65436-65535');
    expect(warning).toMatch(/REDUCES capacity/);
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_RELAY_MIN_PORT=65436');
  });

  it('fails closed when a requested capacity contradicts an explicit range', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      turnPort: '3480',
      turnRelayCapacity: '100',
      turnRelayMinPort: '49201',
      turnRelayMaxPort: '50200',
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(message).toContain('100');
    expect(message).toContain('49201-50200');
    expect(message).toContain('1000');
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
  });

  it('accepts a capacity that agrees with the explicit range it is paired with', async () => {
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      turnPort: '3480',
      turnRelayCapacity: '1000',
      turnRelayMinPort: '49201',
      turnRelayMaxPort: '50200',
    });

    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_RELAY_MIN_PORT=49201');
    expect(readFileSync(join(projectDir, 'turnserver.conf'), 'utf8')).toContain('total-quota=1000');
  });

  it('fails closed on half an explicit range with nothing to pair it with', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      turnRelayMinPort: '49201',
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'))
      .toContain('--turn-relay-max-port');
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
  });

  it('fails closed on a lone max port that would otherwise pair with a default min', async () => {
    // 65500 sits INSIDE the default derived range, so a silent pairing would be
    // protocol-valid and simply serve 65 allocations instead of the requested
    // ones. Fail closed: half a range is not an answer.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      turnRelayMaxPort: '65500',
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'))
      .toContain('--turn-relay-min-port');
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
  });

  it('refuses to replace an unreadable configured range with a default', async () => {
    writeExistingDeployment({ min: '49201', max: '99999' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('app.example.com', { turnDnsOnly: true })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'))
      .toMatch(/TURN_RELAY_MIN_PORT\/TURN_RELAY_MAX_PORT/);
  });

  it('still refuses a listener sitting inside the capacity-derived range', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await expect(setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      turnPort: '65500',
      turnRelayCapacity: '100',
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(join(projectDir, 'turnserver.conf'))).toBe(false);
  });
});

/**
 * A capacity nobody can deploy is not a capacity.
 *
 * The relay range is published through Docker, and Docker expands a published
 * RANGE into one host mapping, one userland proxy and its own DNAT rules PER
 * PORT. Measured on this change: the 30000-port range that capacity 30000
 * produces resolves to a 2,793,973-byte `docker compose config` model with
 * 30000 mappings — accepted by the parser, undeployable in practice. coturn's
 * own container documentation recommends host networking for large relay
 * ranges for exactly this reason.
 *
 * So the strategy is chosen from the range, by one shared rule both the
 * installer and the template call, with the threshold set from measured
 * evidence: production already runs an explicit 1000-port bridge range, so the
 * known-good shape stays on the known-good path.
 */
describe('a large relay range uses host networking instead of thousands of bridge mappings', () => {
  useIsolatedSetupEnvironment();

  const LINUX_ONLY_CAPACITY = 30_000;

  function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    return run().finally(() => {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    });
  }

  async function runSetup(opts: Record<string, unknown>): Promise<void> {
    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    await setupFlow('app.example.com', {
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      ...opts,
    });
  }

  it('switches at the exact threshold and nowhere else', async () => {
    const { TURN_RELAY_NETWORK, turnRelayNetworkMode, turnRelayRangeForCapacity } =
      await import('../../shared/turn-service.js');

    expect(TURN_RELAY_NETWORK.BRIDGE_PUBLISH_MAX_PORTS).toBe(1_024);
    expect(turnRelayNetworkMode(turnRelayRangeForCapacity(1_024))).toBe('bridge');
    expect(turnRelayNetworkMode(turnRelayRangeForCapacity(1_025))).toBe('host');
    expect(turnRelayNetworkMode(turnRelayRangeForCapacity(100))).toBe('bridge');
    expect(turnRelayNetworkMode(turnRelayRangeForCapacity(30_000))).toBe('host');

    // Production's 1000-port range is the evidence the threshold is set from.
    expect(turnRelayNetworkMode({ relayMinPort: 49_201, relayMaxPort: 50_200 })).toBe('bridge');

    // A range the deployment already publishes keeps publishing it, however
    // wide: changing that would move who opens the ports.
    expect(turnRelayNetworkMode({ relayMinPort: 35_536, relayMaxPort: 65_535, rangeOrigin: 'configured' }))
      .toBe('bridge');
    expect(turnRelayNetworkMode({ relayMinPort: 35_536, relayMaxPort: 65_535, rangeOrigin: 'capacity' }))
      .toBe('host');

    // An unmeasurable range cannot be shown to exceed anything.
    expect(turnRelayNetworkMode({})).toBe('bridge');
    expect(turnRelayNetworkMode({ relayMinPort: 65_535, relayMaxPort: 1 })).toBe('bridge');
  });

  it('keeps the fresh default and the threshold itself on the bridge, publishing the range', async () => {
    await runSetup({ turnRelayCapacity: 1_024 });

    const compose = readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8');
    expect(compose).not.toContain('network_mode: host');
    expect(compose).toContain('${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}');
    expect(compose).toContain('./turn-entrypoint.sh:/usr/local/bin/imcodes-turn-entrypoint:ro');
    expect(existsSync(join(projectDir, 'turn-entrypoint.sh'))).toBe(true);
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_RELAY_MIN_PORT=64512');
  });

  it('renders capacity 30000 as host networking with the range intact and no publication', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withPlatform('linux', () => runSetup({ turnRelayCapacity: LINUX_ONLY_CAPACITY }));

    const compose = readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8');
    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    const turnConfig = readFileSync(join(projectDir, 'turnserver.conf'), 'utf8');

    expect(compose).toContain('network_mode: host');
    // Not one published relay port, and not the placeholder either.
    expect(compose).not.toContain('${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}');
    expect(compose).not.toContain('${TURN_PORT}:${TURN_PORT}/udp');
    // The bridge-address exception must not follow the container into host mode:
    // there `hostname -i` is a HOST address, possibly one denied-peer-ip blocks.
    expect(compose).not.toContain('turn-entrypoint');
    expect(compose).not.toContain('entrypoint:');
    expect(existsSync(join(projectDir, 'turn-entrypoint.sh'))).toBe(false);

    // Everything the capacity determines is unchanged by the network strategy.
    expect(env).toContain('TURN_RELAY_MIN_PORT=35536');
    expect(env).toContain('TURN_RELAY_MAX_PORT=65535');
    expect(turnConfig).toContain('min-port=35536');
    expect(turnConfig).toContain('max-port=65535');
    expect(turnConfig).toContain('total-quota=30000');
    expect(turnConfig).toContain('user-quota=32');
    expect(turnConfig).not.toContain('multiplex');

    const summary = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(summary).toContain('30000 concurrent relay allocations (host networking)');
    expect(summary).toContain('host networking: Docker does NOT open these');
    expect(warnSpy.mock.calls.map((call) => call.join(' ')).join('\n'))
      .toContain('35536-65535/udp in the host firewall');
  });

  it('fails closed where host networking does not exist, without reducing the capacity', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await withPlatform('darwin', async () => {
      await expect(runSetup({ turnRelayCapacity: 1_025 })).rejects.toThrow('exit:1');
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(message).toContain('host networking');
    expect(message).toContain('darwin');
    expect(message).toMatch(/will not reduce the requested capacity/);
    expect(existsSync(join(projectDir, '.env'))).toBe(false);
    expect(existsSync(join(projectDir, 'docker-compose.yml'))).toBe(false);
  });

  it('preserves a configured wide range on the bridge and states what it costs', async () => {
    // A range already published to coturn, Docker and a firewall keeps its
    // shape — ports AND network mode — even above the threshold.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withPlatform('linux', () => runSetup({
      turnPort: '3480',
      turnRelayMinPort: '35536',
      turnRelayMaxPort: '65535',
    }));

    const compose = readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8');
    expect(compose).not.toContain('network_mode: host');
    expect(compose).toContain('${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}');
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_RELAY_MIN_PORT=35536');
    const warning = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warning).toContain('30000 UDP ports through the Docker bridge');
    expect(warning).toContain('--turn-relay-capacity');
    expect(warning).toContain('preserved exactly');
  });

  it('lets an explicit capacity choose host networking for the same wide range', async () => {
    // Same ports, but the operator stated the capacity, so setup owns the
    // mechanics of delivering it.
    await withPlatform('linux', () => runSetup({
      turnPort: '3480',
      turnRelayCapacity: '30000',
      turnRelayMinPort: '35536',
      turnRelayMaxPort: '65535',
    }));

    expect(readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8')).toContain('network_mode: host');
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_RELAY_MAX_PORT=65535');
  });
});

/**
 * The generated Compose file is validated by Docker, not by us reading strings.
 *
 * This is the assertion that would have caught the defect: capacity 30000 in
 * bridge mode resolves to a multi-megabyte model with 30000 port mappings.
 */
describe('docker compose validates both network strategies', () => {
  useIsolatedSetupEnvironment();

  const dockerAvailable = (() => {
    try {
      return spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 60_000 }).status === 0;
    } catch {
      return false;
    }
  })();

  function renderDeployment(relayMinPort: number, relayMaxPort: number, rangeOrigin: 'capacity' | 'configured') {
    return {
      enabled: true as const,
      host: 'turn.example.test',
      port: 3480,
      externalIp: '203.0.113.10',
      sharedSecret: 'x'.repeat(64),
      credentialTtlSeconds: 86_400,
      relayMinPort,
      relayMaxPort,
      rangeOrigin,
    };
  }

  async function writeAndResolve(
    relayMinPort: number,
    relayMaxPort: number,
    rangeOrigin: 'capacity' | 'configured',
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const { dockerComposeTemplate, envTemplate } = await import('../../src/setup/templates.js');
    const turn = renderDeployment(relayMinPort, relayMaxPort, rangeOrigin);
    writeFileSync(join(projectDir, 'docker-compose.yml'), dockerComposeTemplate({ turn }));
    writeFileSync(join(projectDir, '.env'), envTemplate({
      domain: 'example.test',
      postgresPassword: 'p',
      jwtSigningKey: 'j',
      adminPassword: 'a',
      turn,
    }));
    const result = spawnSync(
      'docker',
      ['compose', '-f', join(projectDir, 'docker-compose.yml'), '--env-file', join(projectDir, '.env'), 'config'],
      // The bridge shape for a wide range resolves to megabytes; the default
      // 1 MB maxBuffer would truncate it and kill the child mid-write.
      { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
    );
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it.skipIf(!dockerAvailable)('resolves the default 100-allocation bridge range', async () => {
    const { stdout, stderr, status } = await writeAndResolve(65_436, 65_535, 'capacity');
    expect(stderr).not.toMatch(/error/i);
    expect(status).toBe(0);
    expect(stdout).not.toContain('network_mode: host');
    // Docker expands the published range into one mapping per port.
    const published = stdout.match(/published:/g)?.length ?? 0;
    expect(published).toBeGreaterThanOrEqual(100);
    expect(stdout).toContain('published: "65436"');
    expect(stdout).toContain('published: "65535"');
  }, 300_000);

  it.skipIf(!dockerAvailable)('resolves capacity 30000 to a bounded host-networking model', async () => {
    const { stdout, stderr, status } = await writeAndResolve(35_536, 65_535, 'capacity');
    expect(stderr).not.toMatch(/error/i);
    expect(status).toBe(0);
    expect(stdout).toContain('network_mode: host');
    // No relay mapping at all, and nothing near the 2,793,973-byte model the
    // bridge shape produced for this same range.
    expect(stdout).not.toContain('published: "35536"');
    expect(stdout.length).toBeLessThan(20_000);
  }, 300_000);

  it.skipIf(!dockerAvailable)('shows why: the same range published through the bridge is enormous', async () => {
    // The configured-origin path preserves bridge publication, which is exactly
    // the model size that makes host networking necessary for capacity 30000.
    const { stdout, status } = await writeAndResolve(35_536, 65_535, 'configured');
    expect(status).toBe(0);
    expect(stdout).not.toContain('network_mode: host');
    expect(stdout.length).toBeGreaterThan(1_000_000);
  }, 300_000);
});

/**
 * The network strategy has to survive the next `imcodes setup`.
 *
 * The strategy was decided from the capacity the operator asked for — but the
 * capacity is not written anywhere. Only the resulting ports are. On the next
 * ordinary run the deployment is recovered from those ports, which makes its
 * range 'configured', and a configured range deliberately keeps its existing
 * mode rather than re-deriving one from its width. With nothing persisted,
 * "existing mode" defaulted to bridge, and a host deployment was silently
 * rewritten back into the 30000-port bridge publication it exists to avoid.
 *
 * So the mode is deployment state, persisted in .env, exactly like the range.
 * It cannot be inferred: a wide range is equally consistent with a legacy
 * bridge deployment and a host one, and both wrong guesses are damaging.
 */
describe('the selected network strategy survives recovery', () => {
  useIsolatedSetupEnvironment();

  function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    return run().finally(() => {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    });
  }

  async function setup(opts: Record<string, unknown> = {}): Promise<void> {
    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    await setupFlow('app.example.com', opts);
  }

  function generated() {
    return {
      env: readFileSync(join(projectDir, '.env'), 'utf8'),
      compose: readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8'),
      turnConfig: readFileSync(join(projectDir, 'turnserver.conf'), 'utf8'),
      entrypointExists: existsSync(join(projectDir, 'turn-entrypoint.sh')),
    };
  }

  /** A deployment written by an installer that predates the persisted mode. */
  function writeLegacyDeployment(relayMinPort: number, relayMaxPort: number, extra: string[] = []): void {
    writeFileSync(join(projectDir, '.env'), [
      'DOMAIN=app.example.com',
      'POSTGRES_PASSWORD=postgres-secret',
      'JWT_SIGNING_KEY=jwt-secret',
      'DEFAULT_ADMIN_PASSWORD=admin-secret',
      'TURN_ENABLED=true',
      'TURN_HOST=turn.example.com',
      'TURN_PORT=3480',
      'TURN_EXTERNAL_IP=203.0.113.10',
      `TURN_SHARED_SECRET=${'f'.repeat(64)}`,
      'TURN_CREDENTIAL_TTL_SECONDS=86400',
      `TURN_RELAY_MIN_PORT=${relayMinPort}`,
      `TURN_RELAY_MAX_PORT=${relayMaxPort}`,
      ...extra,
    ].join('\n'));
    writeFileSync(join(projectDir, '.setup-secrets.json'), JSON.stringify({
      serverToken: 'server-token',
      serverId: 'server-id',
      apiKeyRaw: 'deck_' + 'a'.repeat(64),
      apiKeyId: 'api-key-id',
      turnSharedSecret: 'f'.repeat(64),
    }));
  }

  it('keeps 30000 allocations on host networking across an ordinary second run', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await withPlatform('linux', () => setup({
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
      turnRelayCapacity: 30_000,
    }));
    const first = generated();
    const firstSummary = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(first.env).toContain('TURN_RELAY_NETWORK_MODE=host');
    logSpy.mockClear();

    // An ordinary re-run: no capacity, no ports, no flags at all.
    await withPlatform('linux', () => setup());
    const second = generated();
    const secondSummary = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');

    // The exact assertion the audit RED makes.
    expect(second.compose, 'the second run rewrote the deployment back to bridge networking')
      .toContain('network_mode: host');
    expect(second.compose).not.toContain('${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}');
    expect(second.entrypointExists).toBe(false);

    // Range, quota, mode and guidance all survive unchanged.
    expect(second.env).toContain('TURN_RELAY_MIN_PORT=35536');
    expect(second.env).toContain('TURN_RELAY_MAX_PORT=65535');
    expect(second.env).toContain('TURN_RELAY_NETWORK_MODE=host');
    expect(second.turnConfig).toContain('min-port=35536');
    expect(second.turnConfig).toContain('max-port=65535');
    expect(second.turnConfig).toContain('total-quota=30000');
    expect(second.compose).toBe(first.compose);
    expect(second.turnConfig).toBe(first.turnConfig);
    expect(secondSummary).toContain('30000 concurrent relay allocations (host networking)');
    expect(secondSummary).toContain('UDP 35536-65535');
    expect(secondSummary).toContain('host networking: Docker does NOT open these');
    expect(firstSummary).toContain('30000 concurrent relay allocations (host networking)');
  });

  it('keeps the default 100 allocations on bridge networking across a second run', async () => {
    await setup({
      turn: true,
      turnHost: 'turn.example.com',
      turnExternalIp: '203.0.113.10',
      turnDnsOnly: true,
    });
    const first = generated();
    expect(first.env).toContain('TURN_RELAY_NETWORK_MODE=bridge');

    await setup();
    const second = generated();
    expect(second.env).toContain('TURN_RELAY_MIN_PORT=65436');
    expect(second.env).toContain('TURN_RELAY_NETWORK_MODE=bridge');
    expect(second.compose).toContain('${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}');
    expect(second.compose).not.toContain('network_mode: host');
    expect(second.entrypointExists).toBe(true);
    expect(second.compose).toBe(first.compose);
    expect(second.turnConfig).toBe(first.turnConfig);
  });

  it('leaves a legacy wide range on the bridge it was always deployed with', async () => {
    // 30000 ports, no persisted mode: this deployment has been publishing them
    // through the bridge all along. Inferring host from the width would move a
    // running relay off Docker's own port mappings on a routine re-run.
    writeLegacyDeployment(35_536, 65_535);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await withPlatform('linux', () => setup({ turnDnsOnly: true }));

    const { env, compose } = generated();
    expect(compose).not.toContain('network_mode: host');
    expect(compose).toContain('${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}');
    expect(env).toContain('TURN_RELAY_MIN_PORT=35536');
    expect(env).toContain('TURN_RELAY_MAX_PORT=65535');
    // Now recorded, so the shape is no longer a guess on the next run either.
    expect(env).toContain('TURN_RELAY_NETWORK_MODE=bridge');
    expect(warnSpy.mock.calls.map((call) => call.join(' ')).join('\n'))
      .toContain('30000 UDP ports through the Docker bridge');
  });

  it('fails closed on a persisted mode it cannot understand', async () => {
    writeLegacyDeployment(49_201, 50_200, ['TURN_RELAY_NETWORK_MODE=hostt']);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(setup({ turnDnsOnly: true })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(message).toContain('TURN_RELAY_NETWORK_MODE');
    expect(message).toContain('hostt');
    expect(message).toContain('bridge or host');
    expect(message).toMatch(/will not guess/);
    // The existing deployment file is left exactly as it was.
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('TURN_RELAY_NETWORK_MODE=hostt');
    expect(existsSync(join(projectDir, 'docker-compose.yml'))).toBe(false);
  });

  it('keeps a recovered host deployment on host when its range is widened', async () => {
    writeLegacyDeployment(35_536, 65_535, ['TURN_RELAY_NETWORK_MODE=host']);

    await withPlatform('linux', () => setup({ turnDnsOnly: true, turnRelayMinPort: '30000' }));

    const { env, compose } = generated();
    expect(compose).toContain('network_mode: host');
    expect(env).toContain('TURN_RELAY_MIN_PORT=30000');
    expect(env).toContain('TURN_RELAY_MAX_PORT=65535');
    expect(env).toContain('TURN_RELAY_NETWORK_MODE=host');
    expect(readFileSync(join(projectDir, 'turnserver.conf'), 'utf8')).toContain('total-quota=35536');
  });

  it('refuses to recover a host deployment where host networking does not exist', async () => {
    writeLegacyDeployment(35_536, 65_535, ['TURN_RELAY_NETWORK_MODE=host']);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await withPlatform('darwin', async () => {
      await expect(setup({ turnDnsOnly: true })).rejects.toThrow('exit:1');
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('lets a deliberate capacity change move the deployment back to bridge, loudly', async () => {
    writeLegacyDeployment(35_536, 65_535, ['TURN_RELAY_NETWORK_MODE=host']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await withPlatform('linux', () => setup({ turnDnsOnly: true, turnRelayCapacity: '100' }));

    const { env, compose } = generated();
    expect(compose).not.toContain('network_mode: host');
    expect(compose).toContain('${TURN_RELAY_MIN_PORT}-${TURN_RELAY_MAX_PORT}');
    expect(env).toContain('TURN_RELAY_MIN_PORT=65436');
    expect(env).toContain('TURN_RELAY_NETWORK_MODE=bridge');
    expect(readFileSync(join(projectDir, 'turnserver.conf'), 'utf8')).toContain('total-quota=100');
    const warning = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warning).toContain('from host to bridge networking');
    expect(warning).toContain('REDUCES capacity');
    expect(warning).toContain('35536-65535');
  });

  it('still refuses a capacity that contradicts an explicit range on a recovered deployment', async () => {
    writeLegacyDeployment(35_536, 65_535, ['TURN_RELAY_NETWORK_MODE=host']);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await withPlatform('linux', async () => {
      await expect(setup({
        turnDnsOnly: true,
        turnRelayCapacity: '100',
        turnRelayMinPort: '35536',
        turnRelayMaxPort: '65535',
      })).rejects.toThrow('exit:1');
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n'))
      .toContain('conflicts with the explicit relay range');
  });
});

/**
 * Retention of superseded Windows artifacts is content-addressed on disk, and
 * tsk_jgt resolves its store as `IMCODES_NODE_EXE_VERSION_DIR` or, unset,
 * `<IMCODES_NODE_EXE_DIR>/versions`. The image sets
 * IMCODES_NODE_EXE_DIR=/app/controlled-node-executables, so the default lands
 * INSIDE the image layer: replacing the Server image discards every retained
 * version and every install code minted against one. Production evidence showed
 * imcodes-im-server-1 with no volumes at all, so the source fix was inert.
 */
describe('retained Windows artifact versions survive Server image replacement', () => {
  useIsolatedSetupEnvironment();

  const dockerAvailable = (() => {
    try {
      return spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 60_000 }).status === 0;
    } catch {
      return false;
    }
  })();

  async function templates() {
    return await import('../../src/setup/templates.js');
  }

  async function parseYaml(text: string): Promise<Record<string, never>> {
    const { parse } = await import('yaml');
    return parse(text) as Record<string, never>;
  }

  it('declares the durable version volume and points the env at its mount, in generated Compose', async () => {
    const { dockerComposeTemplate, NODE_EXE_VERSION_VOLUME, NODE_EXE_VERSION_DIR } = await templates();
    const doc = await parseYaml(dockerComposeTemplate({})) as {
      services: Record<string, { environment?: Record<string, string>; volumes?: string[] }>;
      volumes: Record<string, unknown>;
    };

    // Declared explicitly and deterministically, not implied by a bind.
    expect(Object.keys(doc.volumes)).toContain(NODE_EXE_VERSION_VOLUME);
    expect(doc.services.server?.volumes ?? [])
      .toContain(`${NODE_EXE_VERSION_VOLUME}:${NODE_EXE_VERSION_DIR}`);
    expect(doc.services.server?.environment?.IMCODES_NODE_EXE_VERSION_DIR).toBe(NODE_EXE_VERSION_DIR);
  });

  it('keeps the retained store outside the mutable current-artifact directory', async () => {
    // The current artifact directory is replaced wholesale with the image. If
    // the retained store lived beneath it, a new image would be free to ship
    // bytes over the top of retained versions, which is the failure this whole
    // slice exists to prevent.
    const { NODE_EXE_VERSION_DIR } = await templates();
    const imageArtifactDir = '/app/controlled-node-executables';
    expect(NODE_EXE_VERSION_DIR.startsWith(`${imageArtifactDir}/`)).toBe(false);
    expect(NODE_EXE_VERSION_DIR).not.toBe(imageArtifactDir);
  });

  it('ships the same volume, mount and env in the repository Compose file', async () => {
    // The generated file covers new installs; the checked-in file is what an
    // existing deployment is upgraded against. Both must carry the contract or
    // the fix reaches only half the fleet.
    const { NODE_EXE_VERSION_VOLUME, NODE_EXE_VERSION_DIR } = await templates();
    const shipped = await parseYaml(readFileSync(fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)), 'utf8')) as {
      services: Record<string, { environment?: Record<string, string>; volumes?: string[] }>;
      volumes: Record<string, unknown>;
    };
    expect(Object.keys(shipped.volumes)).toContain(NODE_EXE_VERSION_VOLUME);
    expect(shipped.services.server?.volumes ?? [])
      .toContain(`${NODE_EXE_VERSION_VOLUME}:${NODE_EXE_VERSION_DIR}`);
    expect(shipped.services.server?.environment?.IMCODES_NODE_EXE_VERSION_DIR).toBe(NODE_EXE_VERSION_DIR);
  });

  it('leaves unrelated volumes and TURN modes untouched', async () => {
    // An upgrade must not renumber or drop existing named volumes, or an
    // operator loses their database and certificates to a retention fix.
    const { dockerComposeTemplate, NODE_EXE_VERSION_VOLUME } = await templates();
    for (const turn of [undefined, { enabled: true, networkMode: 'host' as const }]) {
      const doc = await parseYaml(dockerComposeTemplate(turn ? { turn } : {})) as {
        services: Record<string, { volumes?: string[] }>;
        volumes: Record<string, unknown>;
      };
      expect(Object.keys(doc.volumes)).toEqual(
        expect.arrayContaining(['pgdata', 'caddy_data', 'caddy_config', NODE_EXE_VERSION_VOLUME]),
      );
      // The retention volume belongs to the server only.
      expect(doc.services.caddy?.volumes ?? []).not.toContain(NODE_EXE_VERSION_VOLUME);
      expect((doc.services.postgres?.volumes ?? []).join(' ')).not.toContain(NODE_EXE_VERSION_VOLUME);
    }
  });

  it.skipIf(!dockerAvailable)('resolves the env and mount through real docker compose config', async () => {
    const { dockerComposeTemplate, envTemplate, NODE_EXE_VERSION_VOLUME, NODE_EXE_VERSION_DIR } = await templates();
    const projectDir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-version-volume-'));
    try {
      writeFileSync(join(projectDir, 'docker-compose.yml'), dockerComposeTemplate({}));
      writeFileSync(join(projectDir, '.env'), envTemplate({
        domain: 'example.test', postgresPassword: 'p', jwtSigningKey: 'j', adminPassword: 'a',
      }));
      const result = spawnSync('docker', [
        'compose', '-f', join(projectDir, 'docker-compose.yml'),
        '--env-file', join(projectDir, '.env'), 'config',
      ], { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
      expect(result.stderr ?? '').not.toMatch(/error/i);
      expect(result.status).toBe(0);
      const model = await parseYaml(result.stdout ?? '') as {
        services: Record<string, { environment?: Record<string, string>; volumes?: { source?: string; target?: string; type?: string }[] }>;
        volumes: Record<string, unknown>;
      };
      expect(model.services.server?.environment?.IMCODES_NODE_EXE_VERSION_DIR).toBe(NODE_EXE_VERSION_DIR);
      const mount = (model.services.server?.volumes ?? [])
        .find((entry) => entry.target === NODE_EXE_VERSION_DIR);
      expect(mount, 'server must mount the retained-version volume').toBeTruthy();
      expect(mount?.type).toBe('volume');
      expect(mount?.source).toContain(NODE_EXE_VERSION_VOLUME);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 300_000);

  it.skipIf(!dockerAvailable)('migrates a pre-fix container\'s retained tree into the durable volume', async () => {
    // The production shape the previous version of this test missed. A pre-fix
    // deployment has NO volume: its retained versions sit in the container's
    // writable layer at <IMCODES_NODE_EXE_DIR>/versions, and `compose up -d`
    // discards that layer when it recreates the service. Declaring the volume
    // alone therefore does not preserve anything -- the new container simply
    // starts with an empty one. Starting the "old" container already mounting
    // the new volume, as the earlier test did, proved only ordinary volume
    // reuse and would have passed with no migration at all.
    const { stageRetainedArtifactVersions, restoreRetainedArtifactVersions, LEGACY_NODE_EXE_VERSION_DIR } =
      await import('../../src/setup/setup-flow.js');
    const { NODE_EXE_VERSION_DIR } = await templates();

    const suffix = `${Date.now()}`;
    const oldName = `imcodes-legacy-server-${suffix}`;
    const newName = `imcodes-new-server-${suffix}`;
    const volume = `imcodes-versions-${suffix}`;
    const digest = 'c'.repeat(64);
    const legacyPinned = `${LEGACY_NODE_EXE_VERSION_DIR}/win-x64/${digest}.bin`;
    const durablePinned = `${NODE_EXE_VERSION_DIR}/win-x64/${digest}.bin`;
    const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000 });

    // The helpers locate the service through `compose ps -aq server`; that one
    // lookup is stubbed so the test does not need a full compose project, while
    // every docker inspect/exec/cp below runs for real against real containers.
    const withContainer = (id: string) => ({
      // spawnSync, not execSync: this file mocks execSync, and the point of the
      // test is that the real docker inspect/exec/cp calls run.
      runQuiet: (cmd: string, cwd: string) => {
        if (cmd.includes('ps -aq server') || cmd.includes('ps -q server')) return id;
        const out = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true, timeout: 300_000 });
        if (out.status !== 0) throw new Error(out.stderr || `command failed: ${cmd}`);
        return (out.stdout ?? '').trim();
      },
    });

    try {
      // 1. Pre-fix container: no volume, retained bytes in the writable layer.
      expect(docker(['run', '-d', '--name', oldName, 'busybox:1.36', 'sleep', '300']).status).toBe(0);
      expect(docker(['exec', oldName, 'sh', '-c',
        `mkdir -p ${LEGACY_NODE_EXE_VERSION_DIR}/win-x64 && printf pinned-legacy-bytes > ${legacyPinned}`,
      ]).status).toBe(0);

      // 2. Stage before replacement.
      const staged = stageRetainedArtifactVersions('docker compose', process.cwd(), {
        ...withContainer(oldName),
        mkdtemp: () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-migrate-')),
      });
      expect(staged.kind, 'a pre-fix container with retained bytes must stage them').toBe('staged');
      const stagedDir = (staged as { kind: 'staged'; dir: string }).dir;
      expect(readFileSync(join(stagedDir, 'win-x64', `${digest}.bin`), 'utf8')).toBe('pinned-legacy-bytes');

      // 3. Replacement: old container gone, new one starts on an EMPTY volume.
      expect(docker(['rm', '-f', oldName]).status).toBe(0);
      expect(docker(['run', '-d', '--name', newName, '-v', `${volume}:${NODE_EXE_VERSION_DIR}`,
        'busybox:1.36', 'sleep', '300']).status).toBe(0);
      const beforeRestore = docker(['exec', newName, 'sh', '-c', `cat ${durablePinned} 2>/dev/null || true`]);
      expect(beforeRestore.stdout.trim(), 'the replacement starts with nothing; migration is what saves it').toBe('');

      // 4. Restore into the durable volume.
      expect(restoreRetainedArtifactVersions('docker compose', process.cwd(), stagedDir, withContainer(newName)))
        .toBe(true);
      const afterRestore = docker(['exec', newName, 'sh', '-c', `cat ${durablePinned}`]);
      expect(afterRestore.status, afterRestore.stderr).toBe(0);
      expect(afterRestore.stdout.trim()).toBe('pinned-legacy-bytes');

      // 5. And they now survive every FURTHER replacement, from a different image.
      expect(docker(['rm', '-f', newName]).status).toBe(0);
      const afterSecondReplacement = docker(['run', '--rm', '-v', `${volume}:${NODE_EXE_VERSION_DIR}`,
        'alpine:3.20', 'cat', durablePinned]);
      expect(afterSecondReplacement.status, afterSecondReplacement.stderr).toBe(0);
      expect(afterSecondReplacement.stdout.trim()).toBe('pinned-legacy-bytes');
      rmSync(stagedDir, { recursive: true, force: true });
    } finally {
      docker(['rm', '-f', oldName]);
      docker(['rm', '-f', newName]);
      docker(['volume', 'rm', '-f', volume]);
    }
  }, 600_000);
});

describe('retained-artifact migration fails closed instead of losing data', () => {
  useIsolatedSetupEnvironment();

  async function flow() {
    return await import('../../src/setup/setup-flow.js');
  }

  it('never reports a failed attempt as "nothing to migrate"', async () => {
    // These were both null before, so the caller could not tell "there is
    // nothing to preserve" from "I could not find out". It then replaced the
    // container, destroying the only copy of the bytes it had just failed to
    // read. Each failing step must be distinguishable from absence.
    const { stageRetainedArtifactVersions } = await flow();
    const boom = (marker: string) => () => { throw new Error(marker); };

    const failing: Array<[string, { runQuiet: (c: string, d: string) => string; mkdtemp: () => string }]> = [
      ['compose-ps', { runQuiet: boom('ps exploded'), mkdtemp: () => '/tmp/unused' }],
      ['docker-inspect', {
        runQuiet: (cmd: string) => {
          if (cmd.includes('ps -aq server')) return 'container-1';
          throw new Error('inspect exploded');
        },
        mkdtemp: () => '/tmp/unused',
      }],
      ['legacy-listing', {
        runQuiet: (cmd: string) => {
          if (cmd.includes('ps -aq server')) return 'container-1';
          if (cmd.includes('State.Running')) return 'true';
          if (cmd.includes('inspect')) return '/some/other/mount';
          throw new Error('exec exploded');
        },
        mkdtemp: () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-listing-fail-')),
      }],
      ['staging-dir', {
        runQuiet: (cmd: string) => {
          if (cmd.includes('ps -aq server')) return 'container-1';
          if (cmd.includes('State.Running')) return 'true';
          if (cmd.includes('inspect')) return '/some/other/mount';
          return 'win-x64';
        },
        mkdtemp: boom('no temp space'),
      }],
      ['docker-cp', {
        runQuiet: (cmd: string) => {
          if (cmd.includes('ps -aq server')) return 'container-1';
          if (cmd.includes('State.Running')) return 'true';
          if (cmd.includes('inspect')) return '/some/other/mount';
          if (cmd.includes('docker cp')) throw new Error('cp exploded');
          return 'win-x64';
        },
        mkdtemp: () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-stage-fail-')),
      }],
    ];

    for (const [step, deps] of failing) {
      const result = stageRetainedArtifactVersions('docker compose', process.cwd(), deps);
      expect(result.kind, `${step} must be reported as a failure`).toBe('failed');
      expect((result as { step: string }).step).toBe(step);
    }
  });

  it('fails closed when the service resolves to more than one container', async () => {
    // Two candidates and no way to know which holds the real retained bytes.
    // Picking the first is a guess, and guessing here loses data silently, so
    // ambiguity is a failure that blocks replacement.
    const { stageRetainedArtifactVersions, assertRetainedArtifactStagingSafe } = await flow();
    const result = stageRetainedArtifactVersions('docker compose', process.cwd(), {
      runQuiet: () => 'container-a\ncontainer-b',
      mkdtemp: () => '/tmp/unused',
    });
    expect(result.kind).toBe('failed');
    expect((result as { step: string }).step).toBe('compose-ps');
    expect((result as { detail: string }).detail).toContain('container-a');
    expect(() => assertRetainedArtifactStagingSafe(result))
      .toThrow(/Refusing to replace the server container/);
  });

  it('only treats a recognised missing-path copy error as absence', async () => {
    // On a stopped container `cp` is both probe and copy, so its error is the
    // only signal. A genuinely missing directory is benign; anything else -
    // permissions, I/O, a daemon error we have never seen - must fail closed,
    // because continuing destroys bytes we could not read.
    const { stageRetainedArtifactVersions, assertRetainedArtifactStagingSafe } = await flow();
    const stoppedDeps = (cpError: Error) => ({
      runQuiet: (cmd: string) => {
        if (cmd.includes('ps -aq server')) return 'container-1';
        if (cmd.includes('State.Running')) return 'false';
        if (cmd.includes('inspect')) return '/some/other/mount';
        if (cmd.includes('docker cp')) throw cpError;
        return '';
      },
      mkdtemp: () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-cp-class-')),
      readdir: () => [] as string[],
    });

    const missing = stageRetainedArtifactVersions('docker compose', process.cwd(),
      stoppedDeps(new Error('Error response from daemon: lstat /app/...: no such file or directory')));
    expect(missing.kind, 'a genuinely missing legacy directory stays upgradeable').toBe('none');
    expect(() => assertRetainedArtifactStagingSafe(missing)).not.toThrow();

    for (const unknown of [
      new Error('Error response from daemon: permission denied'),
      new Error('unexpected EOF from daemon'),
    ]) {
      const result = stageRetainedArtifactVersions('docker compose', process.cwd(), stoppedDeps(unknown));
      expect(result.kind, `unrecognised copy error must fail closed: ${unknown.message}`).toBe('failed');
      expect((result as { step: string }).step).toBe('docker-cp');
      expect(() => assertRetainedArtifactStagingSafe(result))
        .toThrow(/Refusing to replace the server container/);
    }
  });

  it('blocks container replacement when staging failed, and only then', async () => {
    // The guard is what makes the distinction matter: a failed attempt must
    // stop the upgrade before `compose up -d` discards the old writable layer,
    // while genuine absence must not block anything.
    const { assertRetainedArtifactStagingSafe } = await flow();
    expect(() => assertRetainedArtifactStagingSafe({ kind: 'failed', step: 'docker-cp', detail: 'cp exploded' }))
      .toThrow(/Refusing to replace the server container/);
    expect(() => assertRetainedArtifactStagingSafe({ kind: 'none' })).not.toThrow();
    expect(() => assertRetainedArtifactStagingSafe({ kind: 'staged', dir: '/tmp/x' })).not.toThrow();
  });

  it('keeps the staged bytes when the restore fails', async () => {
    // After replacement the staging directory is the only surviving copy.
    // Deleting it unconditionally turned a transient failure into permanent
    // loss, so a failed restore must leave it on disk and say where it is.
    const { finalizeRetainedArtifactMigration } = await flow();
    const staging = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-restore-fail-'));
    writeFileSync(join(staging, 'pinned.bin'), 'only-copy');
    try {
      const removed: string[] = [];
      const outcome = finalizeRetainedArtifactMigration('docker compose', process.cwd(), staging, {
        restore: () => false,
        remove: (path: string) => { removed.push(path); },
      });
      expect(outcome.restored).toBe(false);
      expect(outcome.retainedStagingDir).toBe(staging);
      expect(removed, 'a failed restore must not delete the only copy').toEqual([]);
      expect(existsSync(join(staging, 'pinned.bin'))).toBe(true);
      expect(readFileSync(join(staging, 'pinned.bin'), 'utf8')).toBe('only-copy');

      // And a successful restore still cleans up, so the fix does not leak.
      const removedOnSuccess: string[] = [];
      const good = finalizeRetainedArtifactMigration('docker compose', process.cwd(), staging, {
        restore: () => true,
        remove: (path: string) => { removedOnSuccess.push(path); },
      });
      expect(good).toEqual({ restored: true });
      expect(removedOnSuccess).toEqual([staging]);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

describe('legacy discovery distinguishes unreadable from absent, against real containers', () => {
  useIsolatedSetupEnvironment();

  const dockerAvailable = (() => {
    try {
      return spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 60_000 }).status === 0;
    } catch {
      return false;
    }
  })();

  it.skipIf(!dockerAvailable)('blocks replacement when the legacy directory cannot be listed', async () => {
    // The masked form (`ls ... 2>/dev/null || true`) turned EACCES into exit 0
    // with empty stdout, so the failure state was unreachable for precisely the
    // errors that matter and the caller replaced the container anyway. Mocking
    // runQuiet to throw could never have caught that, because the real shell
    // never failed. This drives real containers and a really unreadable
    // directory instead.
    const { stageRetainedArtifactVersions, assertRetainedArtifactStagingSafe, LEGACY_NODE_EXE_VERSION_DIR } =
      await import('../../src/setup/setup-flow.js');
    const suffix = `${Date.now()}`;
    const volume = `imcodes-unreadable-${suffix}`;
    const prep = `imcodes-prep-${suffix}`;
    const legacy = `imcodes-legacy-unreadable-${suffix}`;
    const emptyBox = `imcodes-legacy-empty-${suffix}`;
    const missingBox = `imcodes-legacy-missing-${suffix}`;
    const artifactRoot = LEGACY_NODE_EXE_VERSION_DIR.replace(/\/versions$/, '');
    const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000 });
    const realRunQuiet = (id: string) => ({
      runQuiet: (cmd: string, cwd: string) => {
        if (cmd.includes('ps -aq server') || cmd.includes('ps -q server')) return id;
        const out = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true, timeout: 300_000 });
        if (out.status !== 0) throw new Error(out.stderr || `command failed: ${cmd}`);
        return (out.stdout ?? '').trim();
      },
      mkdtemp: () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-unreadable-')),
    });

    try {
      // Root prepares a versions directory that a non-root user cannot read.
      expect(docker(['run', '--rm', '-v', `${volume}:${artifactRoot}`, '--name', prep, 'busybox:1.36',
        'sh', '-c', `mkdir -p ${LEGACY_NODE_EXE_VERSION_DIR} && chmod 000 ${LEGACY_NODE_EXE_VERSION_DIR}`,
      ]).status).toBe(0);
      // The "legacy server" runs as that non-root user, so `ls` genuinely fails.
      expect(docker(['run', '-d', '--name', legacy, '--user', '1000:1000',
        '-v', `${volume}:${artifactRoot}`, 'busybox:1.36', 'sleep', '300']).status).toBe(0);

      const unreadable = stageRetainedArtifactVersions('docker compose', process.cwd(), realRunQuiet(legacy));
      expect(unreadable.kind, 'an unreadable legacy directory is a failure, not an absence').toBe('failed');
      expect((unreadable as { step: string }).step).toBe('legacy-listing');
      // And that failure must stop the upgrade before anything is replaced.
      expect(() => assertRetainedArtifactStagingSafe(unreadable))
        .toThrow(/Refusing to replace the server container/);

      // Missing directory: benign, must NOT block.
      expect(docker(['run', '-d', '--name', missingBox, 'busybox:1.36', 'sleep', '300']).status).toBe(0);
      const missing = stageRetainedArtifactVersions('docker compose', process.cwd(), realRunQuiet(missingBox));
      expect(missing.kind, 'a missing legacy directory is nothing to migrate').toBe('none');
      expect(() => assertRetainedArtifactStagingSafe(missing)).not.toThrow();

      // Present but empty and readable: also benign, must NOT block.
      expect(docker(['run', '-d', '--name', emptyBox, 'busybox:1.36', 'sleep', '300']).status).toBe(0);
      expect(docker(['exec', emptyBox, 'mkdir', '-p', LEGACY_NODE_EXE_VERSION_DIR]).status).toBe(0);
      const empty = stageRetainedArtifactVersions('docker compose', process.cwd(), realRunQuiet(emptyBox));
      expect(empty.kind, 'an empty readable legacy directory is nothing to migrate').toBe('none');
      expect(() => assertRetainedArtifactStagingSafe(empty)).not.toThrow();
    } finally {
      for (const name of [legacy, emptyBox, missingBox]) docker(['rm', '-f', name]);
      docker(['volume', 'rm', '-f', volume]);
    }
  }, 600_000);
});

describe('a stopped pre-fix Server still gets migrated', () => {
  useIsolatedSetupEnvironment();

  const dockerAvailable = (() => {
    try {
      return spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 60_000 }).status === 0;
    } catch {
      return false;
    }
  })();

  it.skipIf(!dockerAvailable)('stages pinned bytes from an exited legacy container and survives replacement', async () => {
    // `compose ps -q` hides stopped containers, so an exited or
    // operator-stopped legacy Server produced no id, was read as a fresh
    // install, and was recreated -- discarding a writable layer that was still
    // perfectly copyable. A stopped container is the state an operator is most
    // likely to upgrade from, and `docker exec` cannot probe it, so discovery
    // and the probe both had to change.
    const { stageRetainedArtifactVersions, restoreRetainedArtifactVersions, assertRetainedArtifactStagingSafe,
      LEGACY_NODE_EXE_VERSION_DIR } = await import('../../src/setup/setup-flow.js');
    const { NODE_EXE_VERSION_DIR } = await import('../../src/setup/templates.js');

    const suffix = `${Date.now()}`;
    const stopped = `imcodes-stopped-legacy-${suffix}`;
    const replacement = `imcodes-stopped-new-${suffix}`;
    const emptyStopped = `imcodes-stopped-empty-${suffix}`;
    const volume = `imcodes-stopped-vol-${suffix}`;
    const digest = 'd'.repeat(64);
    const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000 });
    const withContainer = (id: string, running = false) => ({
      runQuiet: (cmd: string, cwd: string) => {
        // Faithful to docker: the running-only query cannot see a stopped
        // container, which is the whole defect this test exists for.
        if (cmd.includes('ps -aq server')) return id;
        if (cmd.includes('ps -q server')) return running ? id : '';
        const out = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true, timeout: 300_000 });
        if (out.status !== 0) {
          const error = new Error(out.stderr || `command failed: ${cmd}`);
          (error as { stderr?: string }).stderr = out.stderr ?? '';
          throw error;
        }
        return (out.stdout ?? '').trim();
      },
      mkdtemp: () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-stopped-')),
    });

    try {
      // A legacy container that has since exited, with retained bytes on its layer.
      expect(docker(['run', '-d', '--name', stopped, 'busybox:1.36', 'sleep', '300']).status).toBe(0);
      expect(docker(['exec', stopped, 'sh', '-c',
        `mkdir -p ${LEGACY_NODE_EXE_VERSION_DIR}/win-x64 && printf stopped-pinned-bytes > ${LEGACY_NODE_EXE_VERSION_DIR}/win-x64/${digest}.bin`,
      ]).status).toBe(0);
      expect(docker(['stop', stopped]).status).toBe(0);

      const staged = stageRetainedArtifactVersions('docker compose', process.cwd(), withContainer(stopped));
      expect(staged.kind, 'a stopped legacy container must still be migrated').toBe('staged');
      const stagedDir = (staged as { kind: 'staged'; dir: string }).dir;
      expect(readFileSync(join(stagedDir, 'win-x64', `${digest}.bin`), 'utf8')).toBe('stopped-pinned-bytes');
      expect(() => assertRetainedArtifactStagingSafe(staged)).not.toThrow();

      // Replacement, then restore into the durable volume.
      expect(docker(['rm', '-f', stopped]).status).toBe(0);
      expect(docker(['run', '-d', '--name', replacement, '-v', `${volume}:${NODE_EXE_VERSION_DIR}`,
        'busybox:1.36', 'sleep', '300']).status).toBe(0);
      expect(restoreRetainedArtifactVersions('docker compose', process.cwd(), stagedDir, withContainer(replacement, true)))
        .toBe(true);
      const after = docker(['exec', replacement, 'cat', `${NODE_EXE_VERSION_DIR}/win-x64/${digest}.bin`]);
      expect(after.status, after.stderr).toBe(0);
      expect(after.stdout.trim()).toBe('stopped-pinned-bytes');
      rmSync(stagedDir, { recursive: true, force: true });

      // A stopped container with no legacy directory stays benign and upgradeable.
      expect(docker(['run', '-d', '--name', emptyStopped, 'busybox:1.36', 'sleep', '300']).status).toBe(0);
      expect(docker(['stop', emptyStopped]).status).toBe(0);
      const none = stageRetainedArtifactVersions('docker compose', process.cwd(), withContainer(emptyStopped));
      expect(none.kind, 'a stopped container with no legacy tree has nothing to migrate').toBe('none');
      expect(() => assertRetainedArtifactStagingSafe(none)).not.toThrow();
    } finally {
      for (const name of [stopped, replacement, emptyStopped]) docker(['rm', '-f', name]);
      docker(['volume', 'rm', '-f', volume]);
    }
  }, 600_000);
});
