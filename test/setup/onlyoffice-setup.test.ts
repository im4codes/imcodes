import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const { execSyncMock, execFileSyncMock, setupState } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  setupState: {
    home: '',
    host: 'setup-host',
    answer: 'y',
  },
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: (...args: unknown[]) => execSyncMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

vi.mock('node:os', () => ({
  homedir: () => setupState.home,
  hostname: () => setupState.host,
  tmpdir: () => process.env.TMPDIR ?? '/tmp',
  userInfo: () => ({ username: 'setup-user' }),
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb(setupState.answer),
    close: vi.fn(),
  }),
}));

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
let testRoot = '';
let projectDir = '';

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
    if (cmd.includes('ps --format json onlyoffice')) {
      return opts?.encoding ? '{"State":"running"}\n' : Buffer.from('{"State":"running"}\n');
    }
    return opts?.encoding ? '' : Buffer.from('');
  });
  execFileSyncMock.mockReturnValue('203.0.113.10\n');
}

function useIsolatedSetupEnvironment(): void {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    testRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-onlyoffice-test-'));
    projectDir = join(testRoot, 'project');
    setupState.home = join(testRoot, 'home');
    vi.stubEnv('HOME', setupState.home);
    vi.stubEnv('USERPROFILE', setupState.home);
    vi.stubEnv('IMCODES_HOME', join(setupState.home, '.imcodes'));
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(setupState.home, { recursive: true });
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
    vi.unstubAllEnvs();
  });
}

describe('ONLYOFFICE shared constants, templates, and repository root deployment files', () => {
  it('exports canonical ONLYOFFICE environment keys and defaults in shared/onlyoffice-service.ts', async () => {
    const {
      ONLYOFFICE_SERVICE_ENV,
      ONLYOFFICE_SERVICE_DEFAULTS,
      defaultOnlyOfficePublicUrl,
      isOnlyOfficeEnabledValue,
    } = await import('../../shared/onlyoffice-service.js');

    expect(ONLYOFFICE_SERVICE_ENV).toEqual({
      ENABLED: 'ONLYOFFICE_ENABLED',
      JWT_SECRET: 'ONLYOFFICE_JWT_SECRET',
      PUBLIC_URL: 'ONLYOFFICE_PUBLIC_URL',
      INTERNAL_URL: 'ONLYOFFICE_INTERNAL_URL',
    });
    expect(ONLYOFFICE_SERVICE_DEFAULTS).toEqual({
      IMAGE: 'onlyoffice/documentserver:latest',
      INTERNAL_URL: 'http://onlyoffice:80',
      SUBPATH: '/onlyoffice',
      JWT_SECRET_BYTES: 32,
    });
    expect(defaultOnlyOfficePublicUrl('imc.example.com')).toBe('https://imc.example.com/onlyoffice');
    expect(defaultOnlyOfficePublicUrl('https://imc.example.com/')).toBe('https://imc.example.com/onlyoffice');
    expect(isOnlyOfficeEnabledValue(undefined)).toBe(true);
    expect(isOnlyOfficeEnabledValue('true')).toBe(true);
    expect(isOnlyOfficeEnabledValue('false')).toBe(false);
    expect(isOnlyOfficeEnabledValue('0')).toBe(false);
  });

  it('renders ONLYOFFICE container, server env vars, volumes, and Caddy /onlyoffice/* subpath by default', async () => {
    const {
      dockerComposeTemplate,
      caddyfileTemplate,
      envTemplate,
      ONLYOFFICE_DATA_VOLUME,
      ONLYOFFICE_LOGS_VOLUME,
    } = await import('../../src/setup/templates.js');

    const compose = dockerComposeTemplate();
    const doc = parse(compose) as {
      services: Record<string, {
        image?: string;
        restart?: string;
        environment?: Record<string, string>;
        volumes?: string[];
        labels?: string[];
      }>;
      volumes: Record<string, unknown>;
    };

    expect(doc.services.onlyoffice).toBeDefined();
    expect(doc.services.onlyoffice.image).toBe('onlyoffice/documentserver:latest');
    expect(doc.services.onlyoffice.restart).toBe('unless-stopped');
    expect(doc.services.onlyoffice.environment).toEqual({
      JWT_ENABLED: 'true',
      JWT_SECRET: '${ONLYOFFICE_JWT_SECRET}',
      JWT_HEADER: 'Authorization',
      JWT_IN_BODY: 'true',
      WOPI_ENABLED: 'false',
    });
    expect(doc.services.onlyoffice.volumes).toEqual([
      `${ONLYOFFICE_DATA_VOLUME}:/var/www/onlyoffice/Data`,
      `${ONLYOFFICE_LOGS_VOLUME}:/var/log/onlyoffice`,
    ]);
    // Infrastructure service: never carries watchtower scope label
    expect(doc.services.onlyoffice.labels).toBeUndefined();

    expect(doc.services.server.environment).toMatchObject({
      ONLYOFFICE_ENABLED: '${ONLYOFFICE_ENABLED:-true}',
      ONLYOFFICE_JWT_SECRET: '${ONLYOFFICE_JWT_SECRET:-}',
      ONLYOFFICE_PUBLIC_URL: '${ONLYOFFICE_PUBLIC_URL:-https://${DOMAIN}/onlyoffice}',
      ONLYOFFICE_INTERNAL_URL: '${ONLYOFFICE_INTERNAL_URL:-http://onlyoffice:80}',
    });
    expect(Object.keys(doc.volumes)).toEqual(
      expect.arrayContaining([ONLYOFFICE_DATA_VOLUME, ONLYOFFICE_LOGS_VOLUME]),
    );

    const caddy = caddyfileTemplate('imc.example.com');
    expect(caddy).toContain('handle_path /onlyoffice/*');
    expect(caddy).toContain('reverse_proxy onlyoffice:80');
    expect(caddy).toContain('header_up X-Forwarded-Proto {scheme}');
    expect(caddy).toContain('header_up X-Forwarded-Host {host}');
    expect(caddy).toContain('header_up X-Forwarded-Prefix /onlyoffice');
    expect(caddy).toContain('reverse_proxy server:19138');

    const env = envTemplate({
      domain: 'imc.example.com',
      postgresPassword: 'pg-pw',
      jwtSigningKey: 'jwt-key',
      adminPassword: 'admin-pw',
      onlyoffice: {
        enabled: true,
        jwtSecret: 'a'.repeat(64),
      },
    });
    expect(env).toContain('ONLYOFFICE_ENABLED=true');
    expect(env).toContain(`ONLYOFFICE_JWT_SECRET=${'a'.repeat(64)}`);
    expect(env).toContain('ONLYOFFICE_PUBLIC_URL=https://imc.example.com/onlyoffice');
    expect(env).toContain('ONLYOFFICE_INTERNAL_URL=http://onlyoffice:80');
  });

  it('omits the onlyoffice container and Caddy route when explicitly disabled while preserving named volumes', async () => {
    const {
      dockerComposeTemplate,
      caddyfileTemplate,
      envTemplate,
      ONLYOFFICE_DATA_VOLUME,
      ONLYOFFICE_LOGS_VOLUME,
    } = await import('../../src/setup/templates.js');

    const doc = parse(dockerComposeTemplate({ onlyoffice: { enabled: false } })) as {
      services: Record<string, unknown>;
      volumes: Record<string, unknown>;
    };
    expect(doc.services.onlyoffice).toBeUndefined();
    expect(Object.keys(doc.volumes)).toEqual(
      expect.arrayContaining([ONLYOFFICE_DATA_VOLUME, ONLYOFFICE_LOGS_VOLUME]),
    );

    const caddy = caddyfileTemplate('imc.example.com', { onlyoffice: false });
    expect(caddy).not.toContain('/onlyoffice');
    expect(caddy).toContain('reverse_proxy server:19138');

    const env = envTemplate({
      domain: 'imc.example.com',
      postgresPassword: 'pg-pw',
      jwtSigningKey: 'jwt-key',
      adminPassword: 'admin-pw',
      onlyoffice: { enabled: false },
    });
    expect(env).toContain('ONLYOFFICE_ENABLED=false');
    expect(env).toContain('ONLYOFFICE_JWT_SECRET=');
  });

  it('aligns repository root docker-compose.yml, Caddyfile, and gen-env.sh with templates', () => {
    const rootCompose = parse(readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8')) as {
      services: Record<string, {
        image?: string;
        environment?: Record<string, string>;
        volumes?: string[];
        labels?: string[];
      }>;
      volumes: Record<string, unknown>;
    };
    expect(rootCompose.services.onlyoffice).toBeDefined();
    expect(rootCompose.services.onlyoffice.image).toBe('onlyoffice/documentserver:latest');
    expect(rootCompose.services.onlyoffice.labels).toBeUndefined();
    expect(rootCompose.services.server.environment).toMatchObject({
      ONLYOFFICE_ENABLED: '${ONLYOFFICE_ENABLED:-true}',
      ONLYOFFICE_JWT_SECRET: '${ONLYOFFICE_JWT_SECRET:-}',
      ONLYOFFICE_PUBLIC_URL: '${ONLYOFFICE_PUBLIC_URL:-https://${DOMAIN}/onlyoffice}',
      ONLYOFFICE_INTERNAL_URL: '${ONLYOFFICE_INTERNAL_URL:-http://onlyoffice:80}',
    });
    expect(Object.keys(rootCompose.volumes)).toEqual(
      expect.arrayContaining(['onlyoffice_data', 'onlyoffice_logs']),
    );

    const rootCaddy = readFileSync(join(repoRoot, 'Caddyfile'), 'utf8');
    expect(rootCaddy).toContain('handle_path /onlyoffice/*');
    expect(rootCaddy).toContain('header_up X-Forwarded-Prefix /onlyoffice');

    const tmpGenDir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-gen-env-'));
    try {
      const res = spawnSync(join(repoRoot, 'gen-env.sh'), ['docs.example.com', 'fixed-admin'], {
        cwd: tmpGenDir,
        encoding: 'utf8',
      });
      expect(res.status, res.stderr).toBe(0);
      const generatedEnv = readFileSync(join(tmpGenDir, '.env'), 'utf8');
      expect(generatedEnv).toContain('DOMAIN=docs.example.com');
      expect(generatedEnv).toContain('DEFAULT_ADMIN_PASSWORD=fixed-admin');
      expect(generatedEnv).toContain('ONLYOFFICE_ENABLED=true');
      expect(generatedEnv).toMatch(/^ONLYOFFICE_JWT_SECRET=[a-f0-9]{64}$/m);
      expect(generatedEnv).toContain('ONLYOFFICE_PUBLIC_URL=https://docs.example.com/onlyoffice');
      expect(generatedEnv).toContain('ONLYOFFICE_INTERNAL_URL=http://onlyoffice:80');
    } finally {
      rmSync(tmpGenDir, { recursive: true, force: true });
    }
  });
});

describe('setupFlow ONLYOFFICE fresh install, --no-onlyoffice, and existing deployment add-on', () => {
  useIsolatedSetupEnvironment();

  it('enables ONLYOFFICE by default on a fresh setupFlow run', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('docs.example.com');

    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    const compose = readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8');
    const caddy = readFileSync(join(projectDir, 'Caddyfile'), 'utf8');
    const secrets = JSON.parse(readFileSync(join(projectDir, '.setup-secrets.json'), 'utf8'));
    const jwtSecret = env.match(/^ONLYOFFICE_JWT_SECRET=([a-f0-9]{64})$/m)?.[1];

    expect(jwtSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(secrets.onlyofficeJwtSecret).toBe(jwtSecret);
    expect(env).toContain('ONLYOFFICE_ENABLED=true');
    expect(env).toContain('ONLYOFFICE_PUBLIC_URL=https://docs.example.com/onlyoffice');
    expect(env).toContain('ONLYOFFICE_INTERNAL_URL=http://onlyoffice:80');
    expect(compose).toContain('\n  onlyoffice:\n');
    expect(caddy).toContain('handle_path /onlyoffice/*');

    const summary = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(summary).toContain('Document server: https://docs.example.com/onlyoffice (ONLYOFFICE enabled)');
  });

  it('disables ONLYOFFICE when setupFlow is called with onlyoffice: false (--no-onlyoffice)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('no-docs.example.com', { onlyoffice: false });

    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    const compose = readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8');
    const caddy = readFileSync(join(projectDir, 'Caddyfile'), 'utf8');

    expect(env).toContain('ONLYOFFICE_ENABLED=false');
    expect(env).toContain('ONLYOFFICE_JWT_SECRET=\n');
    expect(compose).not.toContain('\n  onlyoffice:\n');
    expect(caddy).not.toContain('handle_path /onlyoffice/*');

    const summary = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(summary).not.toContain('ONLYOFFICE enabled');
  });

  it('preserves existing ONLYOFFICE_JWT_SECRET on resume and supports toggling via --no-onlyoffice / --onlyoffice', async () => {
    const { setupFlow } = await import('../../src/setup/setup-flow.js');

    await setupFlow('resume.example.com');
    const firstEnv = readFileSync(join(projectDir, '.env'), 'utf8');
    const firstSecret = firstEnv.match(/^ONLYOFFICE_JWT_SECRET=([a-f0-9]{64})$/m)?.[1];
    expect(firstSecret).toMatch(/^[a-f0-9]{64}$/);

    // Ordinary second run preserves the same secret
    await setupFlow('resume.example.com');
    const secondEnv = readFileSync(join(projectDir, '.env'), 'utf8');
    expect(secondEnv).toContain(`ONLYOFFICE_JWT_SECRET=${firstSecret}`);

    // Disable with --no-onlyoffice
    await setupFlow('resume.example.com', { onlyoffice: false });
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('ONLYOFFICE_ENABLED=false');
    expect(readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8')).not.toContain('\n  onlyoffice:\n');

    // Ordinary run after explicit disable keeps ONLYOFFICE_ENABLED=false
    await setupFlow('resume.example.com');
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('ONLYOFFICE_ENABLED=false');

    // Re-enable with --onlyoffice
    await setupFlow('resume.example.com', { onlyoffice: true });
    const reenabledEnv = readFileSync(join(projectDir, '.env'), 'utf8');
    expect(reenabledEnv).toContain('ONLYOFFICE_ENABLED=true');
    expect(reenabledEnv).toMatch(/^ONLYOFFICE_JWT_SECRET=[a-f0-9]{64}$/m);
    expect(readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8')).toContain('\n  onlyoffice:\n');
  });

  it('supports non-destructive incremental add-on via CLI `imcodes setup --onlyoffice` when .env exists without .setup-secrets.json', async () => {
    // Seed a manual / gen-env.sh deployment directory with custom vars + TURN, no .setup-secrets.json
    writeFileSync(join(projectDir, '.env'), [
      '# Manual deployment config',
      'DOMAIN=manual.example.com',
      'POSTGRES_PASSWORD=existing-pg-pass',
      'JWT_SIGNING_KEY=existing-jwt-key',
      'DEFAULT_ADMIN_PASSWORD=existing-admin-pass',
      'GITHUB_CLIENT_ID=gh-client-123',
      'TURN_ENABLED=true',
      'TURN_HOST=turn.manual.example.com',
      '',
    ].join('\n'), { mode: 0o600 });

    writeFileSync(join(projectDir, 'docker-compose.yml'), [
      'services:',
      '  postgres:',
      '    image: pgvector/pgvector:pg18',
      '  server:',
      '    image: ghcr.io/im4codes/imcodes:latest',
      '    environment:',
      '      DATABASE_URL: "postgresql://imcodes:${POSTGRES_PASSWORD}@postgres:5432/imcodes"',
      '      GITHUB_CLIENT_ID: "${GITHUB_CLIENT_ID:-}"',
      '      TRUSTED_PROXIES: "127.0.0.1"',
      '  turn:',
      '    image: coturn/coturn:4.15.0-alpine',
      '  caddy:',
      '    image: caddy:2-alpine',
      'volumes:',
      '  pgdata:',
      '  caddy_data:',
      '  caddy_config:',
      '',
    ].join('\n'));

    writeFileSync(join(projectDir, 'Caddyfile'), [
      '{$DOMAIN} {',
      '\treverse_proxy server:19138',
      '}',
      '',
    ].join('\n'));

    const { createProgram } = await import('../../src/cli.js');
    const cli = createProgram();
    await cli.parseAsync(['node', 'imcodes', 'setup', '--onlyoffice']);

    const updatedEnv = readFileSync(join(projectDir, '.env'), 'utf8');
    const updatedCompose = readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8');
    const updatedCaddy = readFileSync(join(projectDir, 'Caddyfile'), 'utf8');
    const secret = updatedEnv.match(/^ONLYOFFICE_JWT_SECRET=([a-f0-9]{64})$/m)?.[1];

    // Existing credentials and custom keys are preserved untouched
    expect(updatedEnv).toContain('# Manual deployment config');
    expect(updatedEnv).toContain('DOMAIN=manual.example.com');
    expect(updatedEnv).toContain('POSTGRES_PASSWORD=existing-pg-pass');
    expect(updatedEnv).toContain('JWT_SIGNING_KEY=existing-jwt-key');
    expect(updatedEnv).toContain('DEFAULT_ADMIN_PASSWORD=existing-admin-pass');
    expect(updatedEnv).toContain('GITHUB_CLIENT_ID=gh-client-123');
    expect(updatedEnv).toContain('TURN_ENABLED=true');
    expect(updatedEnv).toContain('ONLYOFFICE_ENABLED=true');
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(updatedEnv).toContain('ONLYOFFICE_PUBLIC_URL=https://manual.example.com/onlyoffice');
    expect(updatedEnv).toContain('ONLYOFFICE_INTERNAL_URL=http://onlyoffice:80');
    expect(statSync(join(projectDir, '.env')).mode & 0o777).toBe(0o600);

    // Existing services (turn) and custom server env vars are preserved in docker-compose.yml
    const composeDoc = parse(updatedCompose) as {
      services: Record<string, { environment?: Record<string, string> }>;
      volumes: Record<string, unknown>;
    };
    expect(composeDoc.services.turn).toBeDefined();
    expect(composeDoc.services.onlyoffice).toBeDefined();
    expect(composeDoc.services.server.environment?.GITHUB_CLIENT_ID).toBe('${GITHUB_CLIENT_ID:-}');
    expect(composeDoc.services.server.environment?.ONLYOFFICE_JWT_SECRET).toBe('${ONLYOFFICE_JWT_SECRET:-}');
    expect(Object.keys(composeDoc.volumes)).toEqual(
      expect.arrayContaining(['pgdata', 'caddy_data', 'caddy_config', 'onlyoffice_data', 'onlyoffice_logs']),
    );

    // Caddyfile preserves {$DOMAIN} header and adds /onlyoffice/* route
    expect(updatedCaddy).toContain('{$DOMAIN} {');
    expect(updatedCaddy).toContain('handle_path /onlyoffice/*');
    expect(updatedCaddy).toContain('header_up X-Forwarded-Prefix /onlyoffice');
    expect(updatedCaddy).toContain('reverse_proxy server:19138');

    // Does NOT write fake .setup-secrets.json, run destructive teardown, or re-bootstrap DB
    expect(existsSync(join(projectDir, '.setup-secrets.json'))).toBe(false);
    expect(existsSync(join(setupState.home, '.imcodes', 'server.json'))).toBe(false);
    const commands = execSyncMock.mock.calls.map(([cmd]) => String(cmd));
    expect(commands.some((cmd) => cmd.includes('down -v'))).toBe(false);
    expect(commands.some((cmd) => cmd.includes('psql -U imcodes'))).toBe(false);
    expect(commands.some((cmd) => cmd.includes('up -d onlyoffice server caddy'))).toBe(true);

    // Second run is strictly idempotent: keeps same secret and identical file contents
    const cli2 = createProgram();
    await cli2.parseAsync(['node', 'imcodes', 'setup', '--onlyoffice']);
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toBe(updatedEnv);
    expect(readFileSync(join(projectDir, 'docker-compose.yml'), 'utf8')).toBe(updatedCompose);
    expect(readFileSync(join(projectDir, 'Caddyfile'), 'utf8')).toBe(updatedCaddy);
  });

  it('fails closed before modifying files in incremental add-on mode if retained artifact staging fails, and recovers cleanly on retry', async () => {
    const initialEnv = [
      'DOMAIN=safe.example.com',
      'POSTGRES_PASSWORD=pg-pass',
      'JWT_SIGNING_KEY=jwt-key',
      'DEFAULT_ADMIN_PASSWORD=admin-pass',
      '',
    ].join('\n');
    writeFileSync(join(projectDir, '.env'), initialEnv, { mode: 0o600 });

    // Inject ambiguous server containers failure during stageRetainedArtifactVersions
    execSyncMock.mockImplementation((cmd: string, opts?: { encoding?: BufferEncoding }) => {
      if (cmd.includes('ps -aq server')) {
        return opts?.encoding ? 'srv-1\nsrv-2\n' : Buffer.from('srv-1\nsrv-2\n');
      }
      return opts?.encoding ? '' : Buffer.from('');
    });

    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    await expect(setupFlow(undefined, { onlyoffice: true }))
      .rejects.toThrow(/Refusing to replace the server container/);

    // .env was NOT mutated and docker-compose.yml was NOT written before the guard tripped
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toBe(initialEnv);
    expect(existsSync(join(projectDir, 'docker-compose.yml'))).toBe(false);

    // Restore healthy command mocks and retry — succeeds cleanly
    installCommandMocks();
    await setupFlow(undefined, { onlyoffice: true });
    expect(readFileSync(join(projectDir, '.env'), 'utf8')).toContain('ONLYOFFICE_ENABLED=true');
    expect(existsSync(join(projectDir, 'docker-compose.yml'))).toBe(true);
  });

  it('preserves valid long mounts, inherited env without equals, and custom Caddy directives/sites', async () => {
    const { ensureComposeHasOnlyOffice, ensureCaddyfileHasOnlyOffice } = await import('../../src/setup/setup-flow.js');
    const mount = { type: 'bind', source: './uploads', target: '/app/uploads', read_only: true };
    const original = {
      services: {
        server: {
          image: 'example/server:fixed',
          environment: ['HOST_INHERITED', 'EXISTING=value'],
          volumes: [mount],
        },
        caddy: { image: 'caddy:2-alpine' },
      },
      volumes: {},
    };
    const next = parse(ensureComposeHasOnlyOffice(JSON.stringify(original), { enabled: true, jwtSecret: 'synthetic' })) as {
      services: {
        server: {
          volumes: unknown[];
          environment: Record<string, unknown>;
        };
      };
    };
    expect(next.services.server.volumes[0]).toEqual(mount);
    expect(next.services.server.environment).toHaveProperty('HOST_INHERITED');
    expect(next.services.server.environment.HOST_INHERITED).toBeNull();
    expect(next.services.server.environment.EXISTING).toBe('value');

    const oldCaddy = 'docs.test {\n encode gzip\n reverse_proxy http://server:19138\n}\nother.test {\n respond "keep-this"\n}\n';
    const patchedCaddy = ensureCaddyfileHasOnlyOffice(oldCaddy, 'docs.test');
    expect(patchedCaddy).toContain('keep-this');
    expect(patchedCaddy).toContain('encode gzip');
    expect(patchedCaddy).toContain('handle_path /onlyoffice/*');
    expect(patchedCaddy).toContain('reverse_proxy http://server:19138');
  });

  it('fails closed when Caddyfile has unknown upstream reverse_proxy or Compose has invalid services', async () => {
    const { ensureComposeHasOnlyOffice, ensureCaddyfileHasOnlyOffice } = await import('../../src/setup/setup-flow.js');
    const unknownCaddy = 'docs.test {\n respond "hello"\n}\n';
    expect(() => ensureCaddyfileHasOnlyOffice(unknownCaddy, 'docs.test')).toThrow(
      /could not locate server upstream reverse_proxy/,
    );

    const invalidCompose = 'version: "3"\nnetworks:\n  test:\n';
    expect(() => ensureComposeHasOnlyOffice(invalidCompose, { enabled: true, jwtSecret: 'sec' })).toThrow(
      /missing services structure/,
    );
  });

  it('keeps custom env variables and additional Caddy sites when setup secrets file already exists', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    await setupFlow('docs.test', { onlyoffice: false });
    const env = join(projectDir, '.env');
    const caddy = join(projectDir, 'Caddyfile');
    writeFileSync(env, readFileSync(env, 'utf8') + 'GITHUB_CLIENT_ID=keep-client\nCUSTOM_SETTING=preserve-this\n');
    writeFileSync(caddy, readFileSync(caddy, 'utf8') + '\nother.test { respond "keep-this" }\n');

    await setupFlow('docs.test', { onlyoffice: true });
    expect(readFileSync(env, 'utf8')).toContain('CUSTOM_SETTING=preserve-this');
    expect(readFileSync(env, 'utf8')).toContain('GITHUB_CLIENT_ID=keep-client');
    expect(readFileSync(caddy, 'utf8')).toContain('keep-this');
    expect(readFileSync(caddy, 'utf8')).toContain('handle_path /onlyoffice/*');
  });

  it('does not commit env/compose before rejecting unsupported Caddy in CLI add-on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    const env = join(projectDir, '.env');
    const compose = join(projectDir, 'docker-compose.yml');
    const caddy = join(projectDir, 'Caddyfile');
    const oldEnv = 'DOMAIN=docs.test\nPOSTGRES_PASSWORD=synthetic-pg\nJWT_SIGNING_KEY=synthetic-jwt\nCUSTOM_SETTING=keep\n';
    const oldCompose = 'services:\n  server:\n    image: example/server:fixed\n  caddy:\n    image: caddy:2-alpine\n';
    writeFileSync(env, oldEnv);
    writeFileSync(compose, oldCompose);
    writeFileSync(caddy, 'docs.test {\n respond "existing business"\n}\n');

    await expect(setupFlow('docs.test', { onlyoffice: true })).rejects.toThrow(/could not locate server upstream/);
    expect(readFileSync(env, 'utf8')).toBe(oldEnv);
    expect(readFileSync(compose, 'utf8')).toBe(oldCompose);
    expect(execSyncMock.mock.calls.some(([cmd]) => String(cmd).includes('up -d onlyoffice server caddy'))).toBe(false);
  });

  it('does not treat commented reverse_proxy text as a live Caddy upstream', async () => {
    const { ensureCaddyfileHasOnlyOffice } = await import('../../src/setup/setup-flow.js');
    const old = 'docs.test {\n # reverse_proxy server:19138 (old deployment example)\n reverse_proxy current-backend:8080\n}\n';
    expect(() => ensureCaddyfileHasOnlyOffice(old, 'docs.test')).toThrow(/could not locate server upstream/);
  });

  it('installs a real route in CLI add-on when existing route mention is only a comment', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    const env = join(projectDir, '.env');
    const compose = join(projectDir, 'docker-compose.yml');
    const caddy = join(projectDir, 'Caddyfile');
    writeFileSync(env, 'DOMAIN=docs.test\nPOSTGRES_PASSWORD=synthetic-pg\nJWT_SIGNING_KEY=synthetic-jwt\n');
    writeFileSync(compose, 'services:\n  server:\n    image: example/server:fixed\n  caddy:\n    image: caddy:2-alpine\n');
    const oldCaddy = 'docs.test {\n # Previously disabled: handle_path /onlyoffice/*\n reverse_proxy server:19138\n}\n';
    writeFileSync(caddy, oldCaddy);

    await setupFlow('docs.test', { onlyoffice: true });
    const result = readFileSync(caddy, 'utf8');
    const activeRouteCount = result.split('\n').filter((line) => /^\s*handle_path\s+\/onlyoffice\/\*/.test(line)).length;
    expect(activeRouteCount).toBe(1);
    expect(result).toContain('# Previously disabled: handle_path /onlyoffice/*');
    expect(execSyncMock.mock.calls.some(([cmd]) => String(cmd).includes('up -d onlyoffice server caddy'))).toBe(true);
  });

  it('keeps exactly one active route and does not duplicate on repeated CLI add-on runs', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    const env = join(projectDir, '.env');
    const compose = join(projectDir, 'docker-compose.yml');
    const caddy = join(projectDir, 'Caddyfile');
    writeFileSync(env, 'DOMAIN=docs.test\nPOSTGRES_PASSWORD=synthetic-pg\nJWT_SIGNING_KEY=synthetic-jwt\n');
    writeFileSync(compose, 'services:\n  server:\n    image: example/server:fixed\n  caddy:\n    image: caddy:2-alpine\n');
    const existingCaddy = 'docs.test {\n\thandle_path /onlyoffice/* {\n\t\treverse_proxy onlyoffice:80\n\t}\n\treverse_proxy server:19138\n}\n';
    writeFileSync(caddy, existingCaddy);

    await setupFlow('docs.test', { onlyoffice: true });
    const result = readFileSync(caddy, 'utf8');
    const activeRouteCount = result.split('\n').filter((line) => /^\s*handle_path\s+\/onlyoffice\/\*/.test(line)).length;
    expect(activeRouteCount).toBe(1);
    expect(result).toBe(existingCaddy);
  });

  it('does not commit env/compose when Caddyfile has only commented route but unsupported server upstream', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { setupFlow } = await import('../../src/setup/setup-flow.js');
    const env = join(projectDir, '.env');
    const compose = join(projectDir, 'docker-compose.yml');
    const caddy = join(projectDir, 'Caddyfile');
    const oldEnv = 'DOMAIN=docs.test\nPOSTGRES_PASSWORD=synthetic-pg\nJWT_SIGNING_KEY=synthetic-jwt\n';
    const oldCompose = 'services:\n  server:\n    image: example/server:fixed\n  caddy:\n    image: caddy:2-alpine\n';
    writeFileSync(env, oldEnv);
    writeFileSync(compose, oldCompose);
    writeFileSync(caddy, 'docs.test {\n # handle_path /onlyoffice/*\n # reverse_proxy server:19138\n respond "fallback"\n}\n');

    await expect(setupFlow('docs.test', { onlyoffice: true })).rejects.toThrow(/could not locate server upstream/);
    expect(readFileSync(env, 'utf8')).toBe(oldEnv);
    expect(readFileSync(compose, 'utf8')).toBe(oldCompose);
    expect(execSyncMock.mock.calls.some(([cmd]) => String(cmd).includes('up -d onlyoffice server caddy'))).toBe(false);
  });
});

describe('scripts/setup-onlyoffice.sh standalone non-destructive add-on script', () => {
  it('adds ONLYOFFICE to an existing deployment directory, preserves credentials, and is idempotent across retries', () => {
    const tmpRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-script-onlyoffice-'));
    const binDir = join(tmpRoot, 'bin');
    const deployDir = join(tmpRoot, 'deploy');
    const dockerLog = join(tmpRoot, 'docker.log');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(deployDir, { recursive: true });

    try {
      // Mock docker CLI to record invocations and support simulated failure on first run if requested
      const mockDocker = join(binDir, 'docker');
      writeFileSync(mockDocker, [
        '#!/usr/bin/env bash',
        'echo "$@" >> "$DOCKER_LOG"',
        'if [ "$1" = "info" ]; then exit 0; fi',
        'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then exit 0; fi',
        'if [ "${FAIL_COMPOSE_UP:-0}" = "1" ] && [[ "$*" == *"up -d onlyoffice server caddy"* ]]; then',
        '  echo "simulated compose up failure" >&2',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(mockDocker, 0o755);

      writeFileSync(join(deployDir, '.env'), [
        '# Existing production env',
        'DOMAIN=office.example.com',
        'POSTGRES_PASSWORD=prod-pg-secret',
        'JWT_SIGNING_KEY=prod-jwt-secret',
        'DEFAULT_ADMIN_PASSWORD=prod-admin-secret',
        'CUSTOM_SETTING=keep-me',
        '',
      ].join('\n'), { mode: 0o600 });

      writeFileSync(join(deployDir, 'docker-compose.yml'), [
        'services:',
        '  postgres:',
        '    image: pgvector/pgvector:pg18',
        '  server:',
        '    image: ghcr.io/im4codes/imcodes:latest',
        '    environment:',
        '      DATABASE_URL: "postgresql://imcodes:${POSTGRES_PASSWORD}@postgres:5432/imcodes"',
        '      TRUSTED_PROXIES: "127.0.0.1,172.16.0.0/12"',
        '  caddy:',
        '    image: caddy:2-alpine',
        'volumes:',
        '  pgdata:',
        '  caddy_data:',
        '  caddy_config:',
        '',
      ].join('\n'));

      writeFileSync(join(deployDir, 'Caddyfile'), [
        '{$DOMAIN} {',
        '\treverse_proxy server:19138',
        '}',
        '',
      ].join('\n'));

      const scriptPath = join(repoRoot, 'scripts/setup-onlyoffice.sh');
      const baseEnv = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        DOCKER_LOG: dockerLog,
      };

      // 1. Simulate a transient failure during `docker compose up -d`
      const failedRun = spawnSync(scriptPath, [deployDir], {
        env: { ...baseEnv, FAIL_COMPOSE_UP: '1' },
        encoding: 'utf8',
      });
      expect(failedRun.status).not.toBe(0);
      const envAfterFail = readFileSync(join(deployDir, '.env'), 'utf8');
      const firstSecret = envAfterFail.match(/^ONLYOFFICE_JWT_SECRET=([a-f0-9]{64})$/m)?.[1];
      expect(firstSecret).toMatch(/^[a-f0-9]{64}$/);

      // 2. Retry after failure — must reuse the generated secret and succeed cleanly
      const retryRun = spawnSync(scriptPath, [deployDir], {
        env: baseEnv,
        encoding: 'utf8',
      });
      expect(retryRun.status, retryRun.stderr).toBe(0);

      const envAfterSuccess = readFileSync(join(deployDir, '.env'), 'utf8');
      const composeAfterSuccess = readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8');
      const caddyAfterSuccess = readFileSync(join(deployDir, 'Caddyfile'), 'utf8');

      expect(envAfterSuccess).toContain('# Existing production env');
      expect(envAfterSuccess).toContain('POSTGRES_PASSWORD=prod-pg-secret');
      expect(envAfterSuccess).toContain('JWT_SIGNING_KEY=prod-jwt-secret');
      expect(envAfterSuccess).toContain('DEFAULT_ADMIN_PASSWORD=prod-admin-secret');
      expect(envAfterSuccess).toContain('CUSTOM_SETTING=keep-me');
      expect(envAfterSuccess).toContain('ONLYOFFICE_ENABLED=true');
      expect(envAfterSuccess).toContain(`ONLYOFFICE_JWT_SECRET=${firstSecret}`);
      expect(envAfterSuccess).toContain('ONLYOFFICE_PUBLIC_URL=https://office.example.com/onlyoffice');
      expect(envAfterSuccess).toContain('ONLYOFFICE_INTERNAL_URL=http://onlyoffice:80');
      expect(envAfterSuccess.match(/^ONLYOFFICE_JWT_SECRET=/gm)?.length).toBe(1);

      const parsedCompose = parse(composeAfterSuccess) as {
        services: Record<string, { environment?: Record<string, string>; labels?: string[] }>;
        volumes: Record<string, unknown>;
      };
      expect(parsedCompose.services.onlyoffice).toBeDefined();
      expect(parsedCompose.services.onlyoffice.labels).toBeUndefined();
      expect(parsedCompose.services.server.environment?.ONLYOFFICE_JWT_SECRET).toBe('${ONLYOFFICE_JWT_SECRET:-}');
      expect(Object.keys(parsedCompose.volumes)).toEqual(
        expect.arrayContaining(['pgdata', 'caddy_data', 'caddy_config', 'onlyoffice_data', 'onlyoffice_logs']),
      );

      expect(caddyAfterSuccess).toContain('handle_path /onlyoffice/*');
      expect(caddyAfterSuccess).toContain('header_up X-Forwarded-Prefix /onlyoffice');
      expect(caddyAfterSuccess.match(/handle_path \/onlyoffice\/\*/g)?.length).toBe(1);

      const loggedDockerCalls = readFileSync(dockerLog, 'utf8');
      expect(loggedDockerCalls).toContain(
        `compose -f ${join(deployDir, 'docker-compose.yml')} --env-file ${join(deployDir, '.env')} up -d onlyoffice server caddy`,
      );

      // 3. Re-running again is strictly idempotent
      const secondSuccessRun = spawnSync(scriptPath, [deployDir], {
        env: baseEnv,
        encoding: 'utf8',
      });
      expect(secondSuccessRun.status, secondSuccessRun.stderr).toBe(0);
      expect(readFileSync(join(deployDir, '.env'), 'utf8')).toBe(envAfterSuccess);
      expect(readFileSync(join(deployDir, 'docker-compose.yml'), 'utf8')).toBe(composeAfterSuccess);
      expect(readFileSync(join(deployDir, 'Caddyfile'), 'utf8')).toBe(caddyAfterSuccess);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('script fills env without TRUSTED_PROXIES, preserves file inodes, and reloads running Caddy', () => {
    const tmpRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-script-audit-'));
    const bin = join(tmpRoot, 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(tmpRoot, 'docker.log');
    const project = join(tmpRoot, 'project');
    mkdirSync(project, { recursive: true });

    try {
      const fake = join(bin, 'docker');
      writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\nexit 0\n');
      chmodSync(fake, 0o755);

      const envPath = join(project, '.env');
      const composePath = join(project, 'docker-compose.yml');
      const caddyPath = join(project, 'Caddyfile');

      writeFileSync(envPath, 'DOMAIN=docs.test\nPOSTGRES_PASSWORD=synthetic-pg\nJWT_SIGNING_KEY=synthetic-jwt\n');
      writeFileSync(composePath, 'services:\n  server:\n    image: example/server:fixed\n    environment:\n      NODE_ENV: production\n  caddy:\n    image: caddy:2-alpine\n    volumes:\n      - ./Caddyfile:/etc/caddy/Caddyfile:ro\nvolumes:\n  pgdata:\n');
      writeFileSync(caddyPath, 'docs.test {\n reverse_proxy server:19138\n}\n');

      const envStatBefore = statSync(envPath);
      const composeStatBefore = statSync(composePath);
      const caddyStatBefore = statSync(caddyPath);

      const scriptPath = join(repoRoot, 'scripts/setup-onlyoffice.sh');
      const res = spawnSync(scriptPath, [project], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log },
      });
      expect(res.status, res.stderr).toBe(0);

      const envStatAfter = statSync(envPath);
      const composeStatAfter = statSync(composePath);
      const caddyStatAfter = statSync(caddyPath);

      // Verify file inodes were preserved (in-place writes)
      expect(envStatAfter.ino).toBe(envStatBefore.ino);
      expect(composeStatAfter.ino).toBe(composeStatBefore.ino);
      expect(caddyStatAfter.ino).toBe(caddyStatBefore.ino);

      const doc = parse(readFileSync(composePath, 'utf8')) as {
        services: {
          server: {
            environment: Record<string, string>;
          };
        };
      };
      const calls = readFileSync(log, 'utf8');
      expect(doc.services.server.environment.ONLYOFFICE_ENABLED).toBeDefined();
      expect(doc.services.server.environment.ONLYOFFICE_JWT_SECRET).toBeDefined();
      expect(doc.services.server.environment.NODE_ENV).toBe('production');
      expect(calls).toMatch(/caddy reload|--force-recreate[^\n]*caddy|restart caddy/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('script stages and restores retained Windows installers, and refuses to upgrade when ambiguous server containers exist', () => {
    const tmpRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-script-retained-'));
    const bin = join(tmpRoot, 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(tmpRoot, 'docker.log');
    const project = join(tmpRoot, 'project');
    mkdirSync(project, { recursive: true });

    try {
      const fake = join(bin, 'docker');
      writeFileSync(fake, [
        '#!/usr/bin/env bash',
        'echo "$@" >> "$DOCKER_LOG"',
        'if [ "$1" = "info" ]; then exit 0; fi',
        'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then exit 0; fi',
        'if [ "$1" = "compose" ] && [[ "$*" == *"ps -aq server"* ]]; then',
        '  if [ "${AMBIGUOUS_CONTAINERS:-0}" = "1" ]; then',
        '    echo "srv-alpha"',
        '    echo "srv-beta"',
        '  else',
        '    echo "srv-single"',
        '  fi',
        '  exit 0',
        'fi',
        'if [ "$1" = "inspect" ] && [[ "$*" == *"range .Mounts"* ]]; then',
        '  echo "/app/data"',
        '  exit 0',
        'fi',
        'if [ "$1" = "inspect" ] && [[ "$*" == *"State.Running"* ]]; then',
        '  echo "true"',
        '  exit 0',
        'fi',
        'if [ "$1" = "exec" ] && [[ "$*" == *"__imcodes_legacy_versions_absent__"* ]]; then',
        '  echo "v1.0.0.exe"',
        '  exit 0',
        'fi',
        'if [ "$1" = "cp" ]; then',
        '  # Emulate copy by writing a sentinel file to destination',
        '  dest="${!#}"',
        '  dest_clean="${dest%/}"',
        '  dest_clean="${dest_clean%/.}"',
        '  if [ -d "$dest_clean" ]; then',
        '    touch "$dest_clean/staged-installer.exe"',
        '  fi',
        '  exit 0',
        'fi',
        'if [ "$1" = "compose" ] && [[ "$*" == *"ps -q server"* ]]; then',
        '  echo "srv-new"',
        '  exit 0',
        'fi',
        'exit 0',
      ].join('\n'));
      chmodSync(fake, 0o755);

      const envPath = join(project, '.env');
      const composePath = join(project, 'docker-compose.yml');
      const caddyPath = join(project, 'Caddyfile');

      writeFileSync(envPath, 'DOMAIN=retained.test\nPOSTGRES_PASSWORD=pass\nJWT_SIGNING_KEY=jwt\n');
      writeFileSync(composePath, 'services:\n  server:\n    image: test/server\n');
      writeFileSync(caddyPath, 'retained.test {\n reverse_proxy server:19138\n}\n');

      const scriptPath = join(repoRoot, 'scripts/setup-onlyoffice.sh');

      // 1. Ambiguous containers -> fail closed without touching files
      const ambigRes = spawnSync(scriptPath, [project], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log, AMBIGUOUS_CONTAINERS: '1' },
      });
      expect(ambigRes.status).not.toBe(0);
      expect(ambigRes.stderr).toContain('ambiguous server containers found');

      // 2. Single container with legacy bytes -> stages and restores into durable volume
      const successRes = spawnSync(scriptPath, [project], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log, AMBIGUOUS_CONTAINERS: '0' },
      });
      expect(successRes.status, successRes.stderr).toBe(0);
      expect(successRes.stdout).toContain('Retained Windows installers migrated into the durable volume');

      const dockerCalls = readFileSync(log, 'utf8');
      expect(dockerCalls).toContain('cp srv-single:/app/controlled-node-executables/versions/.');
      expect(dockerCalls).toContain('srv-new:/var/lib/imcodes/node-exe-versions/');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('script refuses a failed server-container discovery before edits or compose up', () => {
    const tmpRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'imcodes-script-fail-discovery-'));
    const bin = join(tmpRoot, 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(tmpRoot, 'docker.log');
    const project = join(tmpRoot, 'project');
    mkdirSync(project, { recursive: true });

    try {
      const fake = join(bin, 'docker');
      writeFileSync(fake, [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$DOCKER_LOG"',
        'if [[ "$1" == compose && "$*" == *"ps -aq server"* ]]; then',
        '  echo "synthetic Docker API failure" >&2',
        '  exit 42',
        'fi',
        'exit 0',
      ].join('\n'));
      chmodSync(fake, 0o755);

      const envPath = join(project, '.env');
      const composePath = join(project, 'docker-compose.yml');
      const caddyPath = join(project, 'Caddyfile');

      const oldEnv = 'DOMAIN=docs.test\nPOSTGRES_PASSWORD=synthetic-pg\nJWT_SIGNING_KEY=synthetic-jwt\n';
      const oldCompose = 'services:\n  server:\n    image: example/server:fixed\n  caddy:\n    image: caddy:2-alpine\n';
      writeFileSync(envPath, oldEnv);
      writeFileSync(composePath, oldCompose);
      writeFileSync(caddyPath, 'docs.test {\n reverse_proxy server:19138\n}\n');

      const scriptPath = join(repoRoot, 'scripts/setup-onlyoffice.sh');
      const res = spawnSync(scriptPath, [project], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log },
      });

      expect(res.status).not.toBe(0);
      const calls = readFileSync(log, 'utf8');
      expect(calls).not.toContain('up -d onlyoffice server caddy');
      expect(readFileSync(envPath, 'utf8')).toBe(oldEnv);
      expect(readFileSync(composePath, 'utf8')).toBe(oldCompose);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('configures immutable static caching and bootstrap revalidation in fresh and patched Caddyfiles without poisoning dynamic routes', async () => {
    const { ensureCaddyfileHasOnlyOffice } = await import('../../src/setup/setup-flow.js');
    const tmpRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'oo-caddy-cache-'));
    try {
      const bin = join(tmpRoot, 'bin');
      const freshProject = join(tmpRoot, 'fresh');
      const patchedProject = join(tmpRoot, 'patched');
      const log = join(tmpRoot, 'docker.log');
      mkdirSync(bin, { recursive: true });
      mkdirSync(freshProject, { recursive: true });
      mkdirSync(patchedProject, { recursive: true });
      writeFileSync(log, '');

      const dockerStub = join(bin, 'docker');
      writeFileSync(
        dockerStub,
        `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${log}"
case "\${1:-} \${2:-}" in
  "compose version") exit 0 ;;
  "info ") exit 0 ;;
  "ps --format") exit 0 ;;
  "compose up") exit 0 ;;
  *) exit 0 ;;
esac
`,
      );
      chmodSync(dockerStub, 0o755);

      const baseEnv = 'DOMAIN=docs.example.com\nPOSTGRES_PASSWORD=pgpass\nJWT_SIGNING_KEY=jwtkey\n';
      const baseCompose = 'services:\n  server:\n    image: example/server:1\n  caddy:\n    image: caddy:2-alpine\n';
      writeFileSync(join(freshProject, '.env'), baseEnv);
      writeFileSync(join(freshProject, 'docker-compose.yml'), baseCompose);
      // No Caddyfile in freshProject -> exercises fresh-create path

      writeFileSync(join(patchedProject, '.env'), baseEnv);
      writeFileSync(join(patchedProject, 'docker-compose.yml'), baseCompose);
      writeFileSync(
        join(patchedProject, 'Caddyfile'),
        'docs.example.com {\n\treverse_proxy server:19138\n}\n',
      );

      const scriptPath = join(repoRoot, 'scripts/setup-onlyoffice.sh');
      for (const dir of [freshProject, patchedProject]) {
        const res = spawnSync(scriptPath, [dir], {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        expect(res.status).toBe(0);
        const caddy = readFileSync(join(dir, 'Caddyfile'), 'utf8');
        expect(caddy).toContain('@onlyoffice_static {');
        expect(caddy).toContain('path_regexp ^/v?[0-9]+\\.[0-9]+\\.[0-9]+[.-][^/]+/(web-apps|sdkjs|sdkjs-plugins|fonts|dictionaries)/');
        expect(caddy).toContain('not path /web-apps/apps/api/documents/api.js /web-apps/apps/api/documents/preload.html /web-apps/apps/api/documents/cache-scripts.html */api/documents/api.js */api/documents/preload.html */api/documents/cache-scripts.html');
        expect(caddy).toContain('header @onlyoffice_static >Cache-Control "public, max-age=31536000, immutable"');
        expect(caddy).toContain('@onlyoffice_bootstrap {');
        expect(caddy).toContain('header @onlyoffice_bootstrap >Cache-Control "no-cache, must-revalidate"');
        expect(caddy).toContain('handle_path /onlyoffice/* {');
        expect(caddy).not.toContain('header * >Cache-Control');

        // Disabling via ensureCaddyfileHasOnlyOffice removes matchers and handle_path cleanly
        const stripped = ensureCaddyfileHasOnlyOffice(caddy, 'docs.example.com', false);
        expect(stripped).not.toContain('@onlyoffice_static');
        expect(stripped).not.toContain('@onlyoffice_bootstrap');
        expect(stripped).not.toContain('handle_path /onlyoffice/*');
        expect(stripped).toContain('reverse_proxy server:19138');
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
