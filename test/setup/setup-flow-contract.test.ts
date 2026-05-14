import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { execSyncMock, execFileSyncMock, setupState } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  setupState: {
    home: '/tmp/imcodes-setup-flow-home',
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
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb(setupState.answer),
    close: vi.fn(),
  }),
}));

const projectDir = '/tmp/imcodes-setup-flow-project';

function resetTmpDirs() {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(setupState.home, { recursive: true, force: true });
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
    if (cmd.includes('ps --format json postgres')) {
      return opts?.encoding ? '{"State":"running"}\n' : Buffer.from('{"State":"running"}\n');
    }
    if (cmd.includes('ps --format json server')) {
      return opts?.encoding ? '{"Health":"healthy"}\n' : Buffer.from('{"Health":"healthy"}\n');
    }
    return opts?.encoding ? '' : Buffer.from('');
  });
  execFileSyncMock.mockReturnValue('203.0.113.10\n');
}

describe('setupFlow contracts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resetTmpDirs();
    setupState.answer = 'y';
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    installCommandMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTmpDirs();
  });

  it('generates deployment files, bootstraps the database, and self-binds the daemon', async () => {
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('example.com');

    expect(existsSync(join(projectDir, '.env'))).toBe(true);
    expect(existsSync(join(projectDir, '.setup-secrets.json'))).toBe(true);
    expect(existsSync(join(projectDir, 'docker-compose.yml'))).toBe(true);
    expect(existsSync(join(projectDir, 'Caddyfile'))).toBe(true);
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('DOMAIN=example.com');
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

  it('runs force teardown before regenerating setup state when confirmed', async () => {
    writeFileSync(join(projectDir, '.env'), 'DOMAIN=old.example.com\n');
    writeFileSync(join(projectDir, '.setup-secrets.json'), '{}');
    writeFileSync(join(projectDir, 'docker-compose.yml'), 'old compose');
    writeFileSync(join(projectDir, 'Caddyfile'), 'old caddy');

    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('fresh.example.com', { force: true });

    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.some((cmd) => cmd.includes('down -v --remove-orphans'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes('rm -f'))).toBe(true);
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('DOMAIN=fresh.example.com');
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
