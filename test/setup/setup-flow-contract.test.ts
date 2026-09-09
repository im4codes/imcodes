import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { execSyncMock, execFileSyncMock, setupState } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  setupState: {
    home: '',
    host: 'setup-host',
    answer: 'y',
  },
}));

vi.mock('node:child_process', () => ({
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

describe('setupFlow contracts', () => {
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
    expect(env).toContain('TURN_RELAY_MIN_PORT=49160');
    expect(env).toContain('TURN_RELAY_MAX_PORT=49200');
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
