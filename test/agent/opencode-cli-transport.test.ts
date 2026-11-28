import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  OPENCODE_TRANSPORT_MODES,
  buildOpenCodeCliCommand,
  classifyOpenCodeVersion,
  inspectOpenCodeSqliteSession,
  inspectOpenCodeSqliteSessions,
  isLoopbackHostname,
  isRecoverableFreeLimitOnlyEmbeddedSession,
  probeOpenCodeCli,
  redactSecretText,
  resetOpenCodeCliCache,
  resolveOpenCodeCliBinary,
  resolveOpenCodeCliLaunchPlan,
  resolveOpenCodeTransport,
  startOpenCodeV2CliHost,
} from '../../src/agent/providers/opencode-cli.js';
import { OpenCodeV1CliProvider, openCodeV1RuntimeHooks } from '../../src/agent/providers/opencode-v1-compat.js';
import { OpenCodeSdkProvider, openCodeSdkRuntimeHooks } from '../../src/agent/providers/opencode-sdk.js';
import {
  OPENCODE_NATIVE_AGENT_TOOLS,
  OPENCODE_V1_NATIVE_AGENT_TOOLS,
} from '../../src/agent/native-agent-fence.js';
import { AGENT_DELEGATION_NOTIFICATION_RESULTS } from '../../shared/agent-delegation.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';

function createAsyncQueue<T>() {
  const items: T[] = [];
  const waiters: Array<(value: IteratorResult<T>) => void> = [];
  let closed = false;
  return {
    push(item: T) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else items.push(item);
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()!({ value: undefined as any, done: true });
    },
    stream: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next() {
            if (items.length > 0) return Promise.resolve({ value: items.shift()!, done: false });
            if (closed) return Promise.resolve({ value: undefined as any, done: true });
            return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
          },
          return() {
            closed = true;
            while (waiters.length > 0) waiters.shift()!({ value: undefined as any, done: true });
            return Promise.resolve({ value: undefined as any, done: true });
          },
        };
      },
    },
  };
}

function makeFakeExecutable(dir: string, name: string, script = '#!/bin/sh\necho "1.18.4"\n'): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, script, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

describe('opencode-cli transport discovery, classification, and guards', () => {
  const tempDirs: string[] = [];
  const originalV1Start = openCodeV1RuntimeHooks.start;
  const originalSdkStart = openCodeSdkRuntimeHooks.start;
  const savedEnv: Record<string, string | undefined> = {};

  function mkTemp(prefix = 'oc-cli-test-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    resetOpenCodeCliCache();
    for (const key of ['OPENCODE_BIN', 'IMCODES_OPENCODE_DB_PATH', 'IMCODES_OPENCODE_TRANSPORT', 'IMCODES_HOME', 'XDG_DATA_HOME']) {
      savedEnv[key] = process.env[key];
      if (key !== 'IMCODES_HOME' && key !== 'XDG_DATA_HOME') delete process.env[key];
    }
  });

  afterEach(() => {
    openCodeV1RuntimeHooks.start = originalV1Start;
    openCodeSdkRuntimeHooks.start = originalSdkStart;
    resetOpenCodeCliCache();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves CLI binary in precedence order: binaryPath -> OPENCODE_BIN -> PATH -> per-user fallbacks', () => {
    const root = mkTemp();
    const explicitBin = makeFakeExecutable(join(root, 'explicit'), 'opencode');
    const envBin = makeFakeExecutable(join(root, 'env'), 'opencode');
    const pathDir = join(root, 'path');
    const pathBin = makeFakeExecutable(pathDir, 'opencode');
    const homeDir = join(root, 'home');
    const homeOpencodeBin = makeFakeExecutable(join(homeDir, '.opencode', 'bin'), 'opencode');
    const homeLocalBin = makeFakeExecutable(join(homeDir, '.local', 'bin'), 'opencode');

    expect(resolveOpenCodeCliBinary({
      binaryPath: explicitBin,
      env: { OPENCODE_BIN: envBin, PATH: pathDir, HOME: homeDir },
      platform: 'linux',
      homeDir,
    })).toBe(explicitBin);

    expect(resolveOpenCodeCliBinary({
      env: { OPENCODE_BIN: envBin, PATH: pathDir, HOME: homeDir },
      platform: 'linux',
      homeDir,
    })).toBe(envBin);

    expect(resolveOpenCodeCliBinary({
      env: { PATH: pathDir, HOME: homeDir },
      platform: 'linux',
      homeDir,
    })).toBe(pathBin);

    // Sparse PATH fallback still discovers ~/.opencode/bin/opencode then ~/.local/bin/opencode
    expect(resolveOpenCodeCliBinary({
      env: { PATH: '', HOME: homeDir },
      platform: 'linux',
      homeDir,
    })).toBe(homeOpencodeBin);

    rmSync(homeOpencodeBin);
    expect(resolveOpenCodeCliBinary({
      env: { PATH: '', HOME: homeDir },
      platform: 'linux',
      homeDir,
    })).toBe(homeLocalBin);
  });

  it('ignores non-executable files and directories on POSIX and supports Windows PATHEXT', () => {
    const root = mkTemp();
    const nonExecDir = join(root, 'nonexec');
    mkdirSync(nonExecDir, { recursive: true });
    const nonExecFile = join(nonExecDir, 'opencode');
    writeFileSync(nonExecFile, '#!/bin/sh\n', 'utf8');
    chmodSync(nonExecFile, 0o644);
    const subDirAsFile = join(root, 'dir-named-opencode');
    mkdirSync(join(subDirAsFile, 'opencode'), { recursive: true });

    expect(resolveOpenCodeCliBinary({
      env: { PATH: `${nonExecDir}:${join(subDirAsFile)}`, HOME: join(root, 'empty-home') },
      platform: 'linux',
      homeDir: join(root, 'empty-home'),
      includeSystemFallback: false,
    })).toBeNull();

    const winDir = join(root, 'win-path');
    mkdirSync(winDir, { recursive: true });
    const winCmd = join(winDir, 'opencode.cmd');
    writeFileSync(winCmd, '@echo 2.4.2\r\n', 'utf8');
    expect(resolveOpenCodeCliBinary({
      env: { PATH: winDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: join(root, 'win-home') },
      platform: 'win32',
      homeDir: join(root, 'win-home'),
    })).toBe(winCmd);
  });

  it('gates system fallback paths strictly to the matching host platform and respects includeSystemFallback', () => {
    const candidatesProbed: string[] = [];
    const mockResolveCandidate = (candidate: string) => {
      candidatesProbed.push(candidate);
      if (candidate === '/opt/homebrew/bin/opencode' || candidate === '/usr/local/bin/opencode') {
        return candidate;
      }
      return null;
    };

    // 1. On darwin host with target platform: 'linux', host system paths are never probed even if includeSystemFallback: true is passed
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    try {
      candidatesProbed.length = 0;
      const res1 = resolveOpenCodeCliBinary({
        env: { PATH: '' },
        platform: 'linux',
        homeDir: '/test-home',
        includeSystemFallback: true,
        resolveCandidate: mockResolveCandidate,
      });
      expect(res1).toBeNull();
      expect(candidatesProbed).not.toContain('/opt/homebrew/bin/opencode');
      expect(candidatesProbed).not.toContain('/usr/local/bin/opencode');

      // 2. On linux host with target platform: 'linux' (same platform), default probes /usr/local/bin/opencode but NEVER /opt/homebrew
      platformSpy.mockReturnValue('linux');
      candidatesProbed.length = 0;
      const res2 = resolveOpenCodeCliBinary({
        env: { PATH: '' },
        platform: 'linux',
        homeDir: '/test-home',
        resolveCandidate: mockResolveCandidate,
      });
      expect(res2).toBe('/usr/local/bin/opencode');
      expect(candidatesProbed).toContain('/usr/local/bin/opencode');
      expect(candidatesProbed).not.toContain('/opt/homebrew/bin/opencode');

      // 3. On linux host with target platform: 'linux', includeSystemFallback: false isolates and returns null
      candidatesProbed.length = 0;
      const res3 = resolveOpenCodeCliBinary({
        env: { PATH: '' },
        platform: 'linux',
        homeDir: '/test-home',
        includeSystemFallback: false,
        resolveCandidate: mockResolveCandidate,
      });
      expect(res3).toBeNull();
      expect(candidatesProbed).not.toContain('/usr/local/bin/opencode');
      expect(candidatesProbed).not.toContain('/opt/homebrew/bin/opencode');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('classifies v1 (<2) and v2 (>=2) version strings accurately', () => {
    expect(classifyOpenCodeVersion('1.18.4\n')).toEqual({ version: '1.18.4', major: 1, family: 'v1' });
    expect(classifyOpenCodeVersion('opencode v2.4.2\n')).toEqual({ version: '2.4.2', major: 2, family: 'v2' });
    expect(classifyOpenCodeVersion('v0.9.12')).toEqual({ version: '0.9.12', major: 0, family: 'v1' });
    expect(classifyOpenCodeVersion('2.0.0-beta.1')).toEqual({ version: '2.0.0-beta.1', major: 2, family: 'v2' });
    expect(classifyOpenCodeVersion('not-a-version')).toBeNull();
  });

  it('caches CLI probe by path+mtime and handles timeouts/invalid output gracefully', async () => {
    const root = mkTemp();
    const bin = makeFakeExecutable(root, 'opencode');
    const execProbe = vi.fn(async () => '1.18.4\n');

    const first = await probeOpenCodeCli(bin, { execProbe });
    const second = await probeOpenCodeCli(bin, { execProbe });
    expect(first).toEqual({
      binaryPath: bin,
      launchPlan: { resolvedPath: bin, executable: bin, prependArgs: [] },
      version: '1.18.4',
      major: 1,
      family: 'v1',
    });
    expect(second).toEqual(first);
    expect(execProbe).toHaveBeenCalledTimes(1);

    // Updating mtime invalidates cache entry
    const future = new Date(Date.now() + 10_000);
    utimesSync(bin, future, future);
    const third = await probeOpenCodeCli(bin, { execProbe });
    expect(third).toEqual(first);
    expect(execProbe).toHaveBeenCalledTimes(2);

    // Timeout / rejection returns null safely
    resetOpenCodeCliCache();
    const failingProbe = vi.fn(async () => { throw new Error('ETIMEDOUT'); });
    expect(await probeOpenCodeCli(bin, { execProbe: failingProbe })).toBeNull();
  });

  it('resolves transport precedence across hook override, databasePath, embedded flag, and CLI versions', async () => {
    const root = mkTemp();
    const v1Bin = makeFakeExecutable(join(root, 'v1'), 'opencode', '#!/bin/sh\necho "1.18.4"\n');
    const v2Bin = makeFakeExecutable(join(root, 'v2'), 'opencode', '#!/bin/sh\necho "opencode v2.4.2"\n');
    const emptyHome = join(root, 'no-home');

    expect(await resolveOpenCodeTransport({
      hookOverridden: true,
      config: { binaryPath: v2Bin },
      env: { PATH: '', HOME: emptyHome },
      platform: 'linux',
      homeDir: emptyHome,
    })).toEqual({ mode: OPENCODE_TRANSPORT_MODES.HOOK_OVERRIDE, reason: 'runtime-hook-override' });

    expect(await resolveOpenCodeTransport({
      hookOverridden: false,
      config: { binaryPath: v2Bin, databasePath: '/tmp/test.db' },
      env: { PATH: '', HOME: emptyHome },
      platform: 'linux',
      homeDir: emptyHome,
    })).toEqual({ mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'database-path' });

    expect(await resolveOpenCodeTransport({
      hookOverridden: false,
      config: { binaryPath: v2Bin },
      env: { IMCODES_OPENCODE_TRANSPORT: 'embedded', PATH: '', HOME: emptyHome },
      platform: 'linux',
      homeDir: emptyHome,
    })).toEqual({ mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'explicit-embedded' });

    expect(await resolveOpenCodeTransport({
      hookOverridden: false,
      env: { PATH: '', HOME: emptyHome },
      platform: 'linux',
      homeDir: emptyHome,
      includeSystemFallback: false,
    })).toEqual({ mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'cli-not-found' });

    const v1Res = await resolveOpenCodeTransport({
      hookOverridden: false,
      config: { binaryPath: v1Bin },
      env: { PATH: '', HOME: emptyHome },
      platform: 'linux',
      homeDir: emptyHome,
    });
    expect(v1Res).toMatchObject({ mode: OPENCODE_TRANSPORT_MODES.V1_CLI, cli: { version: '1.18.4', family: 'v1' } });

    const v2Res = await resolveOpenCodeTransport({
      hookOverridden: false,
      config: { binaryPath: v2Bin },
      env: { PATH: '', HOME: emptyHome },
      platform: 'linux',
      homeDir: emptyHome,
    });
    expect(v2Res).toMatchObject({ mode: OPENCODE_TRANSPORT_MODES.V2_CLI, cli: { version: '2.4.2', family: 'v2' } });
  });

  it('validates loopback-only hostnames and redacts basic-auth secrets', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('0.0.0.0')).toBe(false);
    expect(isLoopbackHostname('192.168.1.10')).toBe(false);
    expect(isLoopbackHostname('evil.example.com')).toBe(false);

    const secret = 'super-secret-token-xyz';
    const b64 = Buffer.from(`opencode:${secret}`).toString('base64');
    const redacted = redactSecretText(`auth failed with ${secret} header Basic ${b64}`, [secret]);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(b64);
    expect(redacted).toContain('[REDACTED]');
  });

  it('delegates to v1 CLI, forwards callbacks before/after connect, and enforces fail-closed toolExecutionGuard', async () => {
    const root = mkTemp();
    const v1Bin = makeFakeExecutable(join(root, 'v1bin'), 'opencode', '#!/bin/sh\necho "1.18.4"\n');
    const queue = createAsyncQueue<Record<string, any>>();
    const permissionReplies: Array<Record<string, unknown>> = [];

    const mockClient = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'oc-v1-sess-1', title: 'test' } })),
        get: vi.fn(async () => ({ data: { id: 'oc-v1-sess-1' } })),
        list: vi.fn(async () => ({ data: [] })),
        message: vi.fn(async () => ({ data: null })),
        messages: vi.fn(async () => ({ data: [] })),
        prompt: vi.fn(async () => ({ data: {} })),
        promptAsync: vi.fn(async () => ({ data: undefined })),
        abort: vi.fn(async () => ({ data: true })),
      },
      provider: {
        list: vi.fn(async () => ({
          data: {
            connected: ['opencode'],
            default: { opencode: 'big-pickle' },
            all: [{ id: 'opencode', name: 'OpenCode Zen', models: { 'big-pickle': { id: 'big-pickle', name: 'Big Pickle', limit: { context: 200000 } } } }],
          },
        })),
      },
      event: {
        subscribe: vi.fn(async () => ({ stream: queue.stream })),
      },
      permission: {
        reply: vi.fn(async (opts: Record<string, unknown>) => {
          permissionReplies.push(opts);
          return { data: true };
        }),
      },
      postSessionIdPermissionsPermissionId: vi.fn(async (opts: Record<string, unknown>) => {
        permissionReplies.push(opts);
        return { data: true };
      }),
    };

    openCodeV1RuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', queue.close, { once: true });
      return {
        client: mockClient as any,
        server: { url: 'http://127.0.0.1:41999', close: vi.fn(async () => { queue.close(); }) },
      };
    });

    const provider = new OpenCodeSdkProvider();
    const completions: string[] = [];
    const approvals: string[] = [];
    // Register BEFORE connect() to test pre-connect forwarding
    provider.onComplete((_sid, msg) => completions.push(msg.content));
    provider.onApprovalRequest((_sid, req) => approvals.push(req.id));

    let throwInGuard = false;
    provider.setToolExecutionGuard(async (_sid, ctx) => {
      if (throwInGuard) throw new Error('guard error');
      return { allow: ctx.toolName !== 'bash' };
    });
    let participantThrows = false;
    provider.setParticipantTurnResolver(() => {
      if (participantThrows) throw new Error('resolver failed');
      return true;
    });

    await provider.connect({ binaryPath: v1Bin } as any);
    const routeId = await provider.createSession({ sessionKey: 'route-v1-1', sessionName: 's1', cwd: root });

    // 1. Denied by toolExecutionGuard -> rejected without forwarding approval
    queue.push({
      type: 'permission.asked',
      properties: { id: 'perm-deny', sessionID: 'oc-v1-sess-1', permission: 'bash', patterns: ['rm -rf /'] },
    });
    await vi.waitFor(() => expect(permissionReplies).toHaveLength(1));
    expect(permissionReplies[0]).toMatchObject({ path: { requestID: 'perm-deny' }, body: { reply: 'reject' } });
    expect(approvals).toHaveLength(0);

    // 2. Guard throws + participantTurnResolver throws -> fail-closed rejection
    throwInGuard = true;
    participantThrows = true;
    queue.push({
      type: 'permission.asked',
      properties: { id: 'perm-failclosed', sessionID: 'oc-v1-sess-1', permission: 'edit', patterns: ['foo.ts'] },
    });
    await vi.waitFor(() => expect(permissionReplies).toHaveLength(2));
    expect(permissionReplies[1]).toMatchObject({ path: { requestID: 'perm-failclosed' }, body: { reply: 'reject' } });
    expect(approvals).toHaveLength(0);

    // 3. Normal assistant completion forwards through pre-connect listener
    await provider.send(routeId, 'hello');
    queue.push({
      type: 'message.updated',
      properties: { info: { id: 'msg-1', sessionID: 'oc-v1-sess-1', role: 'assistant', providerID: 'opencode', modelID: 'big-pickle', finish: 'stop' } },
    });
    queue.push({
      type: 'message.part.updated',
      properties: { part: { id: 'part-1', sessionID: 'oc-v1-sess-1', messageID: 'msg-1', type: 'text', text: 'OK' } },
    });
    queue.push({
      type: 'session.status',
      properties: { sessionID: 'oc-v1-sess-1', status: { type: 'idle' } },
    });
    await vi.waitFor(() => expect(completions).toEqual(['OK']));

    await provider.disconnect();
  });

  it('includes actionable CLI-install / provider-key hint on embedded FreeUsageLimitError', async () => {
    const provider = new OpenCodeSdkProvider();
    await provider.connect({ transport: 'embedded', databasePath: ':memory:' } as any);
    try {
      const err = (provider as any).normalizeError(
        { type: 'provider.free-limit', status: 429, message: 'Free usage limit reached.' },
        'step',
      );
      expect(err.code).toBe(PROVIDER_ERROR_CODES.RATE_LIMITED);
      expect(err.recoverable).toBe(true);
      expect(err.message).toContain('Free usage limit reached');
      expect(err.message).toMatch(/opencode/i);
      expect(err.message).toMatch(/API key/i);
    } finally {
      await provider.disconnect();
    }
  });

  it('starts v2 CLI host with Basic Auth, validates loopback-only URL, redacts password on errors, and kills process on close', async () => {
    const root = mkTemp();
    const fakeServerScript = join(root, 'fake-v2.mjs');
    writeFileSync(fakeServerScript, `
      import http from 'node:http';
      const args = process.argv.slice(2);
      if (args.includes('--version')) {
        console.log('opencode v2.4.2');
        process.exit(0);
      }
      if (process.env.FAKE_NON_LOOPBACK === '1') {
        console.log('server listening on http://192.168.1.99:49999');
        setTimeout(() => process.exit(0), 2000);
      } else if (process.env.FAKE_CRASH_WITH_SECRET === '1') {
        console.error('fatal error password=' + process.env.OPENCODE_SERVER_PASSWORD);
        process.exit(2);
      } else {
        const expected = 'Basic ' + Buffer.from((process.env.OPENCODE_SERVER_USERNAME || 'opencode') + ':' + (process.env.OPENCODE_SERVER_PASSWORD || '')).toString('base64');
        const srv = http.createServer((req, res) => {
          if (req.headers.authorization !== expected) {
            res.statusCode = 401;
            res.end('unauthorized');
            return;
          }
          res.setHeader('content-type', 'application/json');
          if (req.url === '/api/info') {
            res.end(JSON.stringify({ version: '2.4.2', pid: process.pid, hostname: '127.0.0.1', urls: [] }));
            return;
          }
          res.end(JSON.stringify({ data: [] }));
        });
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address();
          console.log('server listening on http://127.0.0.1:' + addr.port);
        });
        process.on('SIGTERM', () => { srv.close(() => process.exit(0)); });
      }
    `, 'utf8');
    const wrapper = makeFakeExecutable(
      join(root, 'bin'),
      'opencode',
      `#!/bin/sh\nexec "${process.execPath}" "${fakeServerScript}" "$@"\n`,
    );

    // 1. Happy path + Basic Auth verification + clean close
    const abort1 = new AbortController();
    const started = await startOpenCodeV2CliHost({
      binaryPath: wrapper,
      hostname: '127.0.0.1',
      port: 0,
      timeout: 5_000,
      signal: abort1.signal,
      warmupCatalog: false,
      hostGroupKey: 'unit-happy',
    });
    expect(started.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const models = await started.client.model.list({ location: { directory: root } });
    expect(Array.isArray(models.data)).toBe(true);
    await started.server.close();

    // 2. Rejects non-loopback reported URL
    const abort2 = new AbortController();
    await expect(startOpenCodeV2CliHost({
      binaryPath: wrapper,
      hostname: '127.0.0.1',
      port: 0,
      timeout: 5_000,
      signal: abort2.signal,
      hostGroupKey: 'unit-nonloopback',
      env: { ...process.env, FAKE_NON_LOOPBACK: '1' },
    })).rejects.toThrow(/non-loopback/i);

    // 3. Redacts OPENCODE_SERVER_PASSWORD on startup crash
    const abort3 = new AbortController();
    let crashMsg = '';
    try {
      await startOpenCodeV2CliHost({
        binaryPath: wrapper,
        hostname: '127.0.0.1',
        port: 0,
        timeout: 5_000,
        signal: abort3.signal,
        hostGroupKey: 'unit-crash',
        env: { ...process.env, FAKE_CRASH_WITH_SECRET: '1' },
      });
    } catch (err) {
      crashMsg = err instanceof Error ? err.message : String(err);
    }
    expect(crashMsg).toContain('exited before ready');
    expect(crashMsg).toContain('[REDACTED]');
    expect(crashMsg).not.toMatch(/password=[A-Za-z0-9_-]{12,}/);
  });

  it('F1: unwraps Windows npm .cmd shims into unified launchPlan and fails closed on forced missing/wrong CLI', async () => {
    const root = mkTemp();
    const binDir = join(root, 'npm-bin');
    const jsTarget = join(binDir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.js');
    mkdirSync(join(binDir, 'node_modules', '@opencode', 'cli', 'bin'), { recursive: true });
    writeFileSync(jsTarget, 'console.log("opencode v2.4.2");\n', 'utf8');
    const cmdShim = join(binDir, 'opencode.cmd');
    writeFileSync(cmdShim, '"%_prog%"  "%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.js" %*\r\n', 'utf8');

    const plan = resolveOpenCodeCliLaunchPlan({
      env: { PATH: binDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: join(root, 'h') },
      platform: 'win32',
      homeDir: join(root, 'h'),
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    });
    expect(plan).toEqual({
      resolvedPath: resolve(cmdShim),
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      prependArgs: [resolve(jsTarget)],
    });

    const probeCalls: Array<{ executable: string; args: string[] }> = [];
    const probed = await probeOpenCodeCli(plan!, {
      platform: 'win32',
      execProbe: async (executable, args) => {
        probeCalls.push({ executable, args });
        return 'opencode v2.4.2\n';
      },
    });
    expect(probeCalls).toEqual([{ executable: 'C:\\Program Files\\nodejs\\node.exe', args: [resolve(jsTarget), '--version'] }]);
    expect(probed?.launchPlan).toEqual(plan);

    // Plain .cmd / .bat in a directory with spaces: uses cmd.exe /d /s /c with verbatim quoting (no shell: true)
    const spacedDir = join(root, 'Program Files', 'OpenCode CLI');
    mkdirSync(spacedDir, { recursive: true });
    const plainCmd = join(spacedDir, 'opencode.cmd');
    writeFileSync(plainCmd, '@echo off\r\necho opencode v2.4.2\r\n', 'utf8');
    const plainPlan = resolveOpenCodeCliLaunchPlan({
      binaryPath: plainCmd,
      platform: 'win32',
      env: { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' },
    });
    expect(plainPlan).toEqual({
      resolvedPath: resolve(plainCmd),
      executable: 'C:\\Windows\\system32\\cmd.exe',
      prependArgs: ['/d', '/s', '/c'],
      windowsVerbatimArguments: true,
    });
    const probeCmd = buildOpenCodeCliCommand(plainPlan!, ['--version']);
    expect(probeCmd).toEqual({
      executable: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', `""${resolve(plainCmd)}" --version"`],
      windowsVerbatimArguments: true,
    });
    const serveCmd = buildOpenCodeCliCommand(plainPlan!, ['serve', '--hostname', '127.0.0.1', '--port', '4321']);
    expect(serveCmd).toEqual({
      executable: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', `""${resolve(plainCmd)}" serve --hostname 127.0.0.1 --port 4321"`],
      windowsVerbatimArguments: true,
    });
    const plainProbeCalls: Array<{ executable: string; args: string[]; plan: typeof plainPlan }> = [];
    const plainProbed = await probeOpenCodeCli(plainPlan!, {
      platform: 'win32',
      execProbe: async (executable, args, _timeoutMs, lp) => {
        plainProbeCalls.push({ executable, args, plan: lp });
        return 'opencode v2.4.2\n';
      },
    });
    expect(plainProbeCalls).toEqual([{ executable: probeCmd.executable, args: probeCmd.args, plan: plainPlan }]);
    expect(plainProbed?.family).toBe('v2');

    // Explicit binaryPath missing -> throws CONFIG_ERROR instead of silently falling back to embedded
    await expect(resolveOpenCodeTransport({
      hookOverridden: false,
      config: { binaryPath: join(root, 'does-not-exist') },
      env: { PATH: '' },
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR, recoverable: false });

    // Forced transport mismatch (v1 binary forced as v2-cli) -> throws CONFIG_ERROR
    const v1Bin = makeFakeExecutable(join(root, 'v1only'), 'opencode', '#!/bin/sh\necho "1.18.4"\n');
    await expect(resolveOpenCodeTransport({
      hookOverridden: false,
      config: { binaryPath: v1Bin, transport: 'v2-cli' } as any,
      env: { PATH: '' },
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR, recoverable: false });
  });

  it('F2: enforces startup deadline/abort across server.info() and cancels pre-connected disconnect()', async () => {
    const root = mkTemp();
    const healthFile = join(root, 'health.txt');
    const hangScript = join(root, 'hang-health.mjs');
    writeFileSync(hangScript, `
      import http from 'node:http';
      import { writeFileSync } from 'node:fs';
      if (process.argv.includes('--version')) {
        console.log('opencode v2.4.2');
        process.exit(0);
      }
      const srv = http.createServer((req, res) => {
        const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
        if (pathname === '/api/info') {
          writeFileSync(${JSON.stringify(healthFile)}, '1');
          return;
        }
        res.end('{}');
      });
      srv.listen(0, '127.0.0.1', () => {
        console.log('server listening on http://127.0.0.1:' + srv.address().port);
      });
      process.on('SIGTERM', () => process.exit(0));
    `, 'utf8');
    const wrapper = makeFakeExecutable(join(root, 'bin'), 'opencode', `#!/bin/sh\nexec "${process.execPath}" "${hangScript}" "$@"\n`);

    // Pre-warm dynamic import so cold Vite ESM transform doesn't eat into the 1.5s startup timeout budget under parallel test runs
    await import('@opencode/client/promise');

    // 1. Timeout covers hung server.info() AFTER listening URL is printed
    await expect(startOpenCodeV2CliHost({
      binaryPath: wrapper,
      hostname: '127.0.0.1',
      port: 0,
      timeout: 1_500,
      signal: new AbortController().signal,
      hostGroupKey: 'f2-timeout',
    })).rejects.toThrow(/timed out/i);
    expect(readFileSync(healthFile, 'utf8')).toBe('1');
    rmSync(healthFile);

    // 2. Abort after server.info request is received cancels immediately and kills child
    const abortCtrl = new AbortController();
    const pendingHost = startOpenCodeV2CliHost({
      binaryPath: wrapper,
      hostname: '127.0.0.1',
      port: 0,
      timeout: 5_000,
      signal: abortCtrl.signal,
      hostGroupKey: 'f2-abort',
    });
    await vi.waitFor(() => expect(readFileSync(healthFile, 'utf8')).toBe('1'));
    abortCtrl.abort();
    await expect(pendingHost).rejects.toThrow(/abort/i);

    // 3. OpenCodeSdkProvider.disconnect() during in-flight connect() aborts startup cleanly
    const p = new OpenCodeSdkProvider();
    let seenSignal: AbortSignal | undefined;
    openCodeSdkRuntimeHooks.start = vi.fn(async (opts) => {
      seenSignal = opts.signal;
      return await new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted during connect');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    });
    const connectPromise = p.connect({});
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    await p.disconnect();
    expect(seenSignal?.aborted).toBe(true);
    await expect(connectPromise).rejects.toBeTruthy();

    // 4. Real top-level OpenCodeSdkProvider slow v1 startup cancels immediately on disconnect() (no 5000ms hang or surviving child)
    openCodeSdkRuntimeHooks.start = originalSdkStart;
    const pidFile = join(root, 'v1-slow.pid');
    const slowV1Script = join(root, 'v1-slow.mjs');
    writeFileSync(slowV1Script, `
      import { writeFileSync } from 'node:fs';
      if (process.argv.includes('--version')) {
        console.log('1.18.4');
        process.exit(0);
      }
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `, 'utf8');
    const slowV1Bin = makeFakeExecutable(join(root, 'slow-v1'), 'opencode', `#!/bin/sh\nexec "${process.execPath}" "${slowV1Script}" "$@"\n`);
    const pSlowV1 = new OpenCodeSdkProvider();
    const t0 = Date.now();
    const slowConnect = pSlowV1.connect({ binaryPath: slowV1Bin, startupTimeoutMs: 5_000, cwd: root } as any);
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    const discPromise = pSlowV1.disconnect();
    // Child receives SIGTERM and terminates well before 450ms (unlike before fix when it stayed alive for full timeout)
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 450 });
    await discPromise;
    const elapsedMs = Date.now() - t0;
    await expect(slowConnect).rejects.toBeTruthy();
    expect(elapsedMs).toBeLessThan(2_500);
  });

  it('F3: isolates same-cwd v2 CLI sessions by MCP identity, reuses matching MCP host, and cleans up removed binding', async () => {
    const root = mkTemp();
    const sharedCwd = join(root, 'shared-cwd');
    mkdirSync(sharedCwd, { recursive: true });
    const mcpOpsLog = join(root, 'mcp-ops.jsonl');
    const serverScript = join(root, 'v2-mcp-iso.mjs');
    writeFileSync(serverScript, `
      import http from 'node:http';
      import { appendFileSync } from 'node:fs';
      if (process.argv.includes('--version')) {
        console.log('opencode v2.4.2');
        process.exit(0);
      }
      const mcpState = new Map();
      let seq = 0;
      const pid = process.pid;
      const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = body ? JSON.parse(body) : {};
          const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
          if (pathname === '/api/event') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            res.write('data: ' + JSON.stringify({ type: 'server.connected', properties: {} }) + '\\n\\n');
            return;
          }
          res.setHeader('content-type', 'application/json');
          if (pathname === '/api/info') return res.end(JSON.stringify({ version: '2.4.2', pid, urls: [] }));
          if (pathname === '/api/provider') return res.end(JSON.stringify({ location: {}, data: [{ id: 'opencode', name: 'OpenCode' }] }));
          if (pathname === '/api/model') return res.end(JSON.stringify({ location: {}, data: [{ providerID: 'opencode', modelID: 'big-pickle', name: 'Big Pickle' }] }));
          if (pathname === '/api/model/default') return res.end(JSON.stringify({ location: {}, data: null }));
          if (pathname === '/api/session' && req.method === 'POST') {
            return res.end(JSON.stringify({ data: { id: 'ses-v2-' + (++seq), location: { directory: parsed.location?.directory } } }));
          }
          if (pathname.startsWith('/api/experimental/mcp/')) {
            const serverName = decodeURIComponent(pathname.slice('/api/experimental/mcp/'.length));
            if (req.method === 'PUT') {
              mcpState.set(serverName, parsed.config);
              appendFileSync(${JSON.stringify(mcpOpsLog)}, JSON.stringify({ pid, op: 'add', server: serverName, sessionEnv: parsed.config?.environment?.IMCODES_DAEMON_SESSION_NAME }) + '\\n');
              res.statusCode = 204;
              return res.end();
            }
            if (req.method === 'DELETE') {
              mcpState.delete(serverName);
              appendFileSync(${JSON.stringify(mcpOpsLog)}, JSON.stringify({ pid, op: 'remove', server: serverName, remaining: [...mcpState.keys()] }) + '\\n');
              res.statusCode = 204;
              return res.end();
            }
          }
          if (pathname === '/api/mcp') {
            const list = [...mcpState.entries()].map(([name, cfg]) => ({ name, environment: cfg.environment }));
            return res.end(JSON.stringify({ location: {}, data: list }));
          }
          res.end('{}');
        });
      });
      srv.listen(0, '127.0.0.1', () => {
        console.log('server listening on http://127.0.0.1:' + srv.address().port);
      });
      process.on('SIGTERM', () => srv.close(() => process.exit(0)));
    `, 'utf8');
    const wrapper = makeFakeExecutable(join(root, 'bin'), 'opencode', `#!/bin/sh\nexec "${process.execPath}" "${serverScript}" "$@"\n`);

    const provider = new OpenCodeSdkProvider();
    await provider.connect({ binaryPath: wrapper, cwd: sharedCwd } as any);

    const r1 = await provider.createSession({ sessionKey: 'rA', sessionName: 'deck_proj_a', cwd: sharedCwd });
    const r2 = await provider.createSession({ sessionKey: 'rB', sessionName: 'deck_proj_b', cwd: sharedCwd });
    const s1 = (provider as any).sessions.get(r1);
    const s2 = (provider as any).sessions.get(r2);
    expect(s1.server.url).not.toBe(s2.server.url);

    // Same MCP identity reuses the exact same isolated host
    const r1Same = await provider.createSession({ sessionKey: 'rA2', sessionName: 'deck_proj_a', cwd: sharedCwd });
    const s1Same = (provider as any).sessions.get(r1Same);
    expect(s1Same.server.url).toBe(s1.server.url);

    const mcpA = await s1.client.mcp.list({ location: { directory: sharedCwd } });
    const mcpB = await s2.client.mcp.list({ location: { directory: sharedCwd } });
    expect(mcpA.data[0].environment.IMCODES_DAEMON_SESSION_NAME).toBe('deck_proj_a');
    expect(mcpB.data[0].environment.IMCODES_DAEMON_SESSION_NAME).toBe('deck_proj_b');

    // Closing r1 & r1Same removes r1's MCP binding while r2 remains live and intact
    await provider.endSession(r1);
    await provider.endSession(r1Same);
    const mcpBAfterClose = await s2.client.mcp.list({ location: { directory: sharedCwd } });
    expect(mcpBAfterClose.data).toHaveLength(1);
    expect(mcpBAfterClose.data[0].environment.IMCODES_DAEMON_SESSION_NAME).toBe('deck_proj_b');

    await provider.disconnect();
  });

  it('F4: enforces v1 task+subagent native fence, pre-execution permission ask config, and catches sync guard throws', async () => {
    expect(OPENCODE_NATIVE_AGENT_TOOLS).toEqual(['subagent']);
    expect(OPENCODE_V1_NATIVE_AGENT_TOOLS).toContain('task');
    expect(OPENCODE_V1_NATIVE_AGENT_TOOLS).toContain('subagent');

    const root = mkTemp();
    const v1Bin = makeFakeExecutable(join(root, 'v1bin'), 'opencode', '#!/bin/sh\necho "1.18.4"\n');
    const seenStartConfigs: Array<Record<string, unknown>> = [];
    const seenSessionCreates: Array<Record<string, unknown>> = [];
    const seenPrompts: Array<Record<string, unknown>> = [];
    const permissionRepliesV1: Array<Record<string, unknown>> = [];
    const queue = createAsyncQueue<Record<string, any>>();

    const mockClient = {
      session: {
        create: vi.fn(async (opts: Record<string, unknown>) => {
          seenSessionCreates.push(opts);
          return { data: { id: 'ses-v1-fence' } };
        }),
        get: vi.fn(async () => ({ data: { id: 'ses-v1-fence' } })),
        list: vi.fn(async () => ({ data: [] })),
        message: vi.fn(async () => ({ data: null })),
        messages: vi.fn(async () => ({ data: [] })),
        prompt: vi.fn(async () => ({ data: {} })),
        promptAsync: vi.fn(async (opts: Record<string, unknown>) => {
          seenPrompts.push(opts);
          return { data: undefined };
        }),
        abort: vi.fn(async () => ({ data: true })),
      },
      provider: { list: vi.fn(async () => ({ data: { connected: [], all: [], default: {} } })) },
      event: { subscribe: vi.fn(async () => ({ stream: queue.stream })) },
      permission: {
        reply: vi.fn(async (opts: Record<string, unknown>) => {
          permissionRepliesV1.push(opts);
          return { data: true };
        }),
      },
      postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
    };

    openCodeV1RuntimeHooks.start = vi.fn(async (opts) => {
      if (opts.config) seenStartConfigs.push(opts.config);
      opts.signal.addEventListener('abort', queue.close, { once: true });
      return {
        client: mockClient as any,
        server: { url: 'http://127.0.0.1:42001', close: vi.fn(async () => { queue.close(); }) },
      };
    });

    const provider = new OpenCodeSdkProvider();
    provider.setNativeAgentFenceResolver(() => true);
    // Synchronous throw counterexample!
    provider.setToolExecutionGuard(() => {
      throw new Error('sync guard failure');
    });
    provider.setParticipantTurnResolver(() => true);
    await provider.connect({ binaryPath: v1Bin } as any);

    const r = await provider.createSession({ sessionKey: 'r-v1-fence', sessionName: 's-v1', cwd: root });
    expect(seenStartConfigs[0]).toMatchObject({
      tools: { task: false, subagent: false },
      permission: { '*': 'ask', task: 'deny', subagent: 'deny' },
    });
    expect((seenSessionCreates[0] as any).body.permission).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'subagent', pattern: '*', action: 'deny' },
    ]);

    await provider.send(r, 'hello');
    expect((seenPrompts[0] as any).body.tools).toBeUndefined();

    // Synchronous guard throw must fail closed cleanly (no uncaught synchronous exception)
    queue.push({
      type: 'permission.asked',
      properties: { id: 'perm-sync-v1', sessionID: 'ses-v1-fence', permission: 'bash', patterns: ['ls'] },
    });
    await vi.waitFor(() => expect(permissionRepliesV1).toHaveLength(1));
    expect(permissionRepliesV1[0]).toMatchObject({ path: { requestID: 'perm-sync-v1' }, body: { reply: 'reject' } });
    await provider.disconnect();

    // Counterexample: trailing shadowing rules (`task:explore ask` or `*:explore ask`) must NOT hit fast-path []
    const seenUpdatesV1: Array<Record<string, unknown>> = [];
    let restoredPermRules: Array<{ permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }> = [];
    openCodeV1RuntimeHooks.start = vi.fn(async (opts) => {
      const q = createAsyncQueue<Record<string, any>>();
      opts.signal.addEventListener('abort', q.close, { once: true });
      return {
        client: {
          session: {
            create: vi.fn(async () => ({ data: { id: 'ses-v1-shadow' } })),
            get: vi.fn(async () => ({ data: { id: 'ses-v1-shadow', permission: restoredPermRules } })),
            update: vi.fn(async (arg: Record<string, unknown>) => {
              seenUpdatesV1.push(arg);
              const patched = ((arg.body as any)?.permission ?? []) as typeof restoredPermRules;
              restoredPermRules = [...restoredPermRules, ...patched];
              return { data: { id: 'ses-v1-shadow', permission: restoredPermRules } };
            }),
            list: vi.fn(async () => ({ data: [] })),
            message: vi.fn(async () => ({ data: null })),
            messages: vi.fn(async () => ({ data: [] })),
            prompt: vi.fn(async () => ({ data: {} })),
            promptAsync: vi.fn(async () => ({ data: undefined })),
            abort: vi.fn(async () => ({ data: true })),
          },
          provider: { list: vi.fn(async () => ({ data: { connected: [], all: [], default: {} } })) },
          event: { subscribe: vi.fn(async () => ({ stream: q.stream })) },
          postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
        } as any,
        server: { url: 'http://127.0.0.1:42007', close: vi.fn(async () => { q.close(); }) },
      };
    });
    const pShadow = new OpenCodeSdkProvider();
    pShadow.setNativeAgentFenceResolver(() => true);
    pShadow.setToolExecutionGuard(async () => ({ allow: false }));
    await pShadow.connect({ binaryPath: v1Bin } as any);

    // Case 1: `task:explore ask` after `task:* deny`
    restoredPermRules = [
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'task', pattern: 'explore', action: 'ask' },
      { permission: 'subagent', pattern: '*', action: 'deny' },
    ];
    await pShadow.createSession({ sessionKey: 'r-shadow-1', cwd: root, skipCreate: true, resumeId: 'ses-v1-shadow' });
    expect(seenUpdatesV1).toHaveLength(1);
    expect((seenUpdatesV1[0] as any).body.permission).toEqual([
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'subagent', pattern: '*', action: 'deny' },
    ]);
    // Repeated restore with trailing native deny suffix MUST be idempotent (no duplicate append)
    await pShadow.createSession({ sessionKey: 'r-shadow-2', cwd: root, skipCreate: true, resumeId: 'ses-v1-shadow' });
    expect(seenUpdatesV1).toHaveLength(1);

    // Case 2: wildcard-permission pattern-specific `*:explore ask` after `task:* deny` + `subagent:* deny`
    restoredPermRules = [
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'subagent', pattern: '*', action: 'deny' },
      { permission: '*', pattern: 'explore', action: 'ask' },
    ];
    await pShadow.createSession({ sessionKey: 'r-shadow-3', cwd: root, skipCreate: true, resumeId: 'ses-v1-shadow' });
    expect(seenUpdatesV1).toHaveLength(2);
    expect((seenUpdatesV1[1] as any).body.permission).toEqual([
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'subagent', pattern: '*', action: 'deny' },
    ]);
    await pShadow.createSession({ sessionKey: 'r-shadow-4', cwd: root, skipCreate: true, resumeId: 'ses-v1-shadow' });
    expect(seenUpdatesV1).toHaveLength(2);
    await pShadow.disconnect();

    // Same synchronous guard throw counterexample on v2 path (opencode-sdk.ts)
    const v2Queue = createAsyncQueue<Record<string, any>>();
    const v2PermReplies: any[] = [];
    openCodeSdkRuntimeHooks.start = vi.fn(async (opts) => {
      opts.signal.addEventListener('abort', v2Queue.close, { once: true });
      return {
        client: {
          sessions: {
            create: vi.fn(async () => ({ id: 'ses-v2-sync' })),
            get: vi.fn(async () => ({ id: 'ses-v2-sync' })),
            prompt: vi.fn(async () => ({})),
          },
          session: { list: vi.fn(async () => ({ data: [] })), interrupt: vi.fn(async () => ({})) },
          provider: { list: vi.fn(async () => ({ data: [] })) },
          model: { list: vi.fn(async () => ({ data: [] })), default: vi.fn(async () => ({ data: null })) },
          message: { list: vi.fn(async () => ({ data: [] })) },
          permission: { reply: vi.fn(async (arg) => { v2PermReplies.push(arg); }) },
          events: { subscribe: vi.fn(async () => v2Queue.stream) },
        } as any,
        server: { url: 'http://127.0.0.1:42002', close: vi.fn(async () => { v2Queue.close(); }) },
      };
    });
    const p2 = new OpenCodeSdkProvider();
    p2.setToolExecutionGuard(() => {
      throw new Error('sync v2 boom');
    });
    p2.setParticipantTurnResolver(() => true);
    await p2.connect({});
    await p2.createSession({ sessionKey: 'r-v2-sync', cwd: root });
    v2Queue.push({
      type: 'permission.asked',
      data: { id: 'perm-sync-v2', sessionID: 'ses-v2-sync', action: 'bash', resources: ['ls'] },
    });
    await vi.waitFor(() => expect(v2PermReplies).toHaveLength(1));
    expect(v2PermReplies[0]).toMatchObject({ requestID: 'perm-sync-v2', decision: 'reject' });
    await p2.disconnect();
  });

  it('F5: enforces v1 route ownership lock, source-stream isolation, and blocks stale route send/compact/approval', async () => {
    const root = mkTemp();
    const v1Bin = makeFakeExecutable(join(root, 'v1bin'), 'opencode', '#!/bin/sh\necho "1.18.4"\n');
    const queues: Array<ReturnType<typeof createAsyncQueue<Record<string, any>>>> = [];
    openCodeV1RuntimeHooks.start = vi.fn(async (opts) => {
      const q = createAsyncQueue<Record<string, any>>();
      queues.push(q);
      const isControl = !opts.config;
      opts.signal.addEventListener('abort', q.close, { once: true });
      return {
        client: {
          session: {
            create: vi.fn(async () => ({ data: { id: 'shared-v1-ses' } })),
            get: vi.fn(async () => ({ data: { id: 'shared-v1-ses' } })),
            list: vi.fn(async () => ({ data: [] })),
            message: vi.fn(async () => ({ data: null })),
            messages: vi.fn(async () => ({ data: [] })),
            prompt: vi.fn(async () => ({ data: {} })),
            promptAsync: vi.fn(async () => ({ data: undefined })),
            abort: vi.fn(async () => ({ data: true })),
          },
          provider: { list: vi.fn(async () => ({ data: { connected: [], all: [], default: {} } })) },
          event: { subscribe: vi.fn(async () => ({ stream: q.stream })) },
          postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
          _tag: isControl ? 'ctrl' : `runtime-${queues.length}`,
        } as any,
        server: { url: 'http://127.0.0.1:42003', close: vi.fn(async () => { q.close(); }) },
      };
    });

    const provider = new OpenCodeSdkProvider();
    const deltas: Array<{ sid: string; text: string }> = [];
    const errors: Array<{ sid: string; code: string }> = [];
    provider.onDelta((sid, d) => deltas.push({ sid, text: d.delta }));
    provider.onError((sid, e) => errors.push({ sid, code: e.code }));
    await provider.connect({ binaryPath: v1Bin } as any);

    const routeA = await provider.createSession({ sessionKey: 'v1-routeA', cwd: root });
    await provider.send(routeA, 'first turn');
    // Handoff to routeB while routeA is busy cancels routeA and transfers ownership
    const routeB = await provider.createSession({
      sessionKey: 'v1-routeB',
      cwd: root,
      skipCreate: true,
      resumeId: 'shared-v1-ses',
    });
    expect(errors.some((e) => e.sid === routeA && e.code === PROVIDER_ERROR_CODES.CANCELLED)).toBe(true);

    // Stale routeA is blocked from send, compact, and respondApproval
    await expect(provider.send(routeA, 'stale')).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });
    await expect(provider.send(routeA, '/compact')).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });
    await expect(provider.respondApproval(routeA, 'perm-1', true)).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });

    // Stale events on routeA's old stream (queues[1]) never cross over into routeB
    await provider.send(routeB, 'second turn');
    queues[1]!.push({
      type: 'message.updated',
      properties: { info: { id: 'msg-stale', sessionID: 'shared-v1-ses', role: 'assistant', finish: 'stop' } },
    });
    queues[1]!.push({
      type: 'message.part.updated',
      properties: { part: { id: 'p-stale', sessionID: 'shared-v1-ses', messageID: 'msg-stale', type: 'text', text: 'STALE_LEAK' } },
    });
    await new Promise((res) => setTimeout(res, 40));
    expect(deltas.some((d) => d.text.includes('STALE_LEAK'))).toBe(false);

    // Detaching routeB restores routeA as active owner (and routeB becomes rejected)
    await provider.detachSession(routeB);
    await expect(provider.send(routeB, 'after detach')).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });
    await provider.send(routeA, 'resumed after routeB detach');
    await provider.disconnect();

    // Counterexample B: v1 hung pre-submission GET (session.message) NEVER blocks route handoff or detach
    let releaseLookupA!: () => void;
    const lookupInFlightA = new Promise<void>((res) => { releaseLookupA = res; });
    let lookupStartedResolve!: () => void;
    const lookupStarted = new Promise<void>((res) => { lookupStartedResolve = res; });
    const promptAsyncCalls: Array<string> = [];
    let startCallSeq = 0;
    openCodeV1RuntimeHooks.start = vi.fn(async (opts) => {
      const myIdx = ++startCallSeq;
      const q = createAsyncQueue<Record<string, any>>();
      opts.signal.addEventListener('abort', q.close, { once: true });
      return {
        client: {
          session: {
            create: vi.fn(async () => ({ data: { id: 'shared-inflight-ses' } })),
            get: vi.fn(async () => ({ data: { id: 'shared-inflight-ses' } })),
            list: vi.fn(async () => ({ data: [] })),
            message: vi.fn(async () => {
              if (myIdx === 2 || myIdx === 4) {
                lookupStartedResolve();
                await lookupInFlightA;
              }
              return { data: null };
            }),
            messages: vi.fn(async () => ({ data: [] })),
            prompt: vi.fn(async () => ({ data: {} })),
            promptAsync: vi.fn(async () => {
              promptAsyncCalls.push(`client-${myIdx}`);
              return { data: undefined };
            }),
            abort: vi.fn(async () => ({ data: true })),
          },
          provider: { list: vi.fn(async () => ({ data: { connected: [], all: [], default: {} } })) },
          event: { subscribe: vi.fn(async () => ({ stream: q.stream })) },
          postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
        } as any,
        server: { url: `http://127.0.0.1:${42005 + myIdx}`, close: vi.fn(async () => { q.close(); }) },
      };
    });
    const pInflight = new OpenCodeSdkProvider();
    await pInflight.connect({ binaryPath: v1Bin } as any);
    const rSlowA = await pInflight.createSession({ sessionKey: 'v1-slow-a', cwd: root });
    const inflightSend = pInflight.send(rSlowA, 'in-flight payload');
    await lookupStarted;
    // B takes over & submits BEFORE releasing A's hung pre-submission GET (must complete immediately without deadlock!)
    const takeoverT0 = Date.now();
    const rTakeoverB = await pInflight.createSession({
      sessionKey: 'v1-takeover-b',
      cwd: root,
      skipCreate: true,
      resumeId: 'shared-inflight-ses',
    });
    expect(Date.now() - takeoverT0).toBeLessThan(300);
    expect(rTakeoverB).toBe('v1-takeover-b');
    await pInflight.send(rTakeoverB, 'route B payload');
    // Old route A's promptAsync RPC must NEVER execute, and releasing A later stays inert
    expect(promptAsyncCalls).toEqual(['client-3']);
    // Also verify detachSession completes immediately while a new slow GET is hung
    let lookupStartedResolve2!: () => void;
    const lookupStarted2 = new Promise<void>((res) => { lookupStartedResolve2 = res; });
    lookupStartedResolve = lookupStartedResolve2;
    const slowDetachSend = pInflight.send(rTakeoverB, 'route B slow GET').catch(() => {});
    // Note: client-3 doesn't hang message, detach on fresh slow route client-4
    const rSlowC = await pInflight.createSession({ sessionKey: 'v1-slow-c', cwd: root, skipCreate: true, resumeId: 'shared-inflight-ses' });
    const slowC = pInflight.send(rSlowC, 'slow C GET');
    await lookupStarted2;
    const detachT0 = Date.now();
    await pInflight.detachSession(rSlowC);
    expect(Date.now() - detachT0).toBeLessThan(300);
    releaseLookupA();
    await slowDetachSend;
    await slowC.catch(() => {});
    const inflightOutcome = await inflightSend.catch((err) => err);
    if (inflightOutcome !== undefined) {
      expect([PROVIDER_ERROR_CODES.CANCELLED, PROVIDER_ERROR_CODES.SESSION_NOT_FOUND]).toContain((inflightOutcome as any).code);
    }
    expect(promptAsyncCalls).toEqual(['client-3']);
    await pInflight.disconnect();

    // Counterexample B2/B3/B4: hung `session.abort` HTTP promise never deadlocks handoff or endSession,
    // requires physical child exit proof (server.close returning early without child exit rejects),
    // keeps old route stream intact on close failure so retry succeeds, and direct cancel timeout
    // waits on ProviderStopConfirmation instead of locally faking failOnce.
    const { EventEmitter } = await import('node:events');
    const hungAbortSignals: AbortSignal[] = [];
    const closedServers: string[] = [];
    const hungPromptCalls: string[] = [];
    const hungSummarizeCalls: string[] = [];
    const hungQueues = new Map<number, ReturnType<typeof createAsyncQueue<Record<string, any>>>>();
    const hungChildren = new Map<number, InstanceType<typeof EventEmitter> & { exitCode: number | null; signalCode: string | null }>();
    let hangAbortMode = true;
    let hangSummarizeMode = false;
    let releaseHungSummarize: (() => void) | null = null;
    let closeRejectForIdx: number | null = null;
    let omitChildExitForIdx: number | null = null;
    let hungSeq = 0;
    openCodeV1RuntimeHooks.start = vi.fn(async (opts) => {
      const idx = ++hungSeq;
      const tag = `hung-${idx}`;
      const q = createAsyncQueue<Record<string, any>>();
      hungQueues.set(idx, q);
      const fakeChild = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as string | null,
      });
      hungChildren.set(idx, fakeChild);
      opts.signal.addEventListener('abort', q.close, { once: true });
      return {
        client: {
          session: {
            create: vi.fn(async () => ({ data: { id: 'shared-hung-abort-ses' } })),
            get: vi.fn(async () => ({ data: { id: 'shared-hung-abort-ses' } })),
            list: vi.fn(async () => ({ data: [] })),
            message: vi.fn(async () => ({ data: null })),
            messages: vi.fn(async () => ({ data: [] })),
            prompt: vi.fn(async () => ({ data: {} })),
            promptAsync: vi.fn(async () => {
              hungPromptCalls.push(tag);
              return { data: undefined };
            }),
            summarize: vi.fn(async () => {
              hungSummarizeCalls.push(tag);
              if (hangSummarizeMode) {
                await new Promise<void>((res) => { releaseHungSummarize = res; });
              }
              return { data: true };
            }),
            abort: vi.fn(async (_opts: any, reqOpts?: { signal?: AbortSignal }) => {
              if (reqOpts?.signal) hungAbortSignals.push(reqOpts.signal);
              if (hangAbortMode) {
                return await new Promise<never>(() => {});
              }
              return { data: true };
            }),
          },
          provider: { list: vi.fn(async () => ({ data: { connected: [], all: [], default: {} } })) },
          event: { subscribe: vi.fn(async () => ({ stream: q.stream })) },
          postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
        } as any,
        server: {
          url: `http://127.0.0.1:${42100 + idx}`,
          child: fakeChild,
          close: vi.fn(async () => {
            closedServers.push(tag);
            if (closeRejectForIdx === idx) {
              throw new Error('child close failed');
            }
            if (omitChildExitForIdx === idx) {
              // Simulate killProcessTree returning before kernel child exit arrives
              return;
            }
            fakeChild.exitCode = 0;
            fakeChild.emit('exit', 0, null);
            q.close();
          }),
        } as any,
      };
    });
    const pHungAbort = new OpenCodeSdkProvider();
    const hungDeltas: Array<{ sid: string; text: string }> = [];
    const hungCompletes: string[] = [];
    const hungErrors: Array<{ sid: string; code: string }> = [];
    pHungAbort.onDelta((sid, d) => hungDeltas.push({ sid, text: d.delta }));
    pHungAbort.onComplete((sid) => hungCompletes.push(sid));
    pHungAbort.onError((sid, e) => hungErrors.push({ sid, code: e.code }));
    await pHungAbort.connect({ binaryPath: v1Bin } as any);
    const hungA = await pHungAbort.createSession({ sessionKey: 'v1-hung-a', cwd: root });
    await pHungAbort.send(hungA, 'busy turn A');
    const hungTakeoverT0 = Date.now();
    const hungB = await pHungAbort.createSession({
      sessionKey: 'v1-hung-b',
      cwd: root,
      skipCreate: true,
      resumeId: 'shared-hung-abort-ses',
    });
    expect(Date.now() - hungTakeoverT0).toBeLessThan(300);
    expect(hungB).toBe('v1-hung-b');
    expect(hungAbortSignals.length).toBeGreaterThanOrEqual(1);
    expect(hungAbortSignals[0]!.aborted).toBe(true);
    // Exclusive old route `hung-2` exited, closed, and was reclaimed before publishing `hungB`
    expect(closedServers).toContain('hung-2');
    await expect(pHungAbort.send(hungA, 'after reclaim')).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });
    await pHungAbort.send(hungB, 'turn B succeeds');
    expect(hungPromptCalls).toEqual(['hung-2', 'hung-3']);

    // B4a: When close() fails, incoming runtime (`hung-4`) is closed, retryable error is thrown,
    // AND `hungB` keeps its live SSE subscription & clear busy ownership (not half-torn-down!)
    closeRejectForIdx = 3;
    await expect(pHungAbort.createSession({
      sessionKey: 'v1-unsafe-close-err',
      cwd: root,
      skipCreate: true,
      resumeId: 'shared-hung-abort-ses',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONNECTION_LOST, recoverable: true });
    expect(closedServers).toContain('hung-4');
    hungQueues.get(3)!.push({
      type: 'message.updated',
      properties: { info: { id: 'msg-b-live', sessionID: 'shared-hung-abort-ses', role: 'assistant' } },
    });
    hungQueues.get(3)!.push({
      type: 'message.part.updated',
      properties: { part: { id: 'part-b-live', sessionID: 'shared-hung-abort-ses', messageID: 'msg-b-live', type: 'text', text: 'STILL_ALIVE_B' } },
    });
    await vi.waitFor(() => expect(hungDeltas.some((d) => d.sid === hungB && d.text.includes('STILL_ALIVE_B'))).toBe(true));
    await expect(pHungAbort.send(hungB, 'still busy owner')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: expect.stringContaining('already busy'),
    });

    // B4b: Retry after close failure where server.close() returns IMMEDIATELY without child 'exit' arriving:
    // MUST wait for child exit proof & time out without publishing `v1-no-exit`, keeping `hungB` intact!
    closeRejectForIdx = null;
    omitChildExitForIdx = 3;
    await expect(pHungAbort.createSession({
      sessionKey: 'v1-no-exit',
      cwd: root,
      skipCreate: true,
      resumeId: 'shared-hung-abort-ses',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONNECTION_LOST, recoverable: true });
    expect(closedServers).toContain('hung-5');

    // B4c: Once child exit CAN complete (`omitChildExitForIdx = null`), retrying takeover SUCCEEDS cleanly!
    omitChildExitForIdx = null;
    const hungRetry = await pHungAbort.createSession({
      sessionKey: 'v1-retry-ok',
      cwd: root,
      skipCreate: true,
      resumeId: 'shared-hung-abort-ses',
    });
    expect(hungRetry).toBe('v1-retry-ok');
    await pHungAbort.send(hungRetry, 'after retry');

    // B5a: Early `session.idle` arriving BEFORE 150ms interrupt deadline is captured by pre-armed observer
    // and settles cleanly without hitting ProviderStopConfirmation timeout, once, allowing immediate next send!
    const errCountBeforeEarly = hungErrors.length;
    setTimeout(() => {
      hungQueues.get(6)!.push({
        type: 'session.idle',
        properties: { sessionID: 'shared-hung-abort-ses' },
      });
    }, 20);
    const earlyCancelT0 = Date.now();
    await pHungAbort.cancel(hungRetry);
    expect(Date.now() - earlyCancelT0).toBeLessThan(300);
    expect(hungErrors.slice(errCountBeforeEarly)).toEqual([
      expect.objectContaining({ sid: hungRetry, code: PROVIDER_ERROR_CODES.CANCELLED }),
    ]);
    await pHungAbort.send(hungRetry, 'after early cancel');

    // B5b: Late `session.idle` arriving AFTER 150ms interrupt deadline waits on ProviderStopConfirmation,
    // never fakes local failOnce prematurely, ignores unkeyed `session.compacted`, settles once on idle, and allows next turn send!
    let directCancelSettled = false;
    const errCountBeforeCancel = hungErrors.length;
    const cancelPending = pHungAbort.cancel(hungRetry).then(() => { directCancelSettled = true; });
    hungQueues.get(6)!.push({
      type: 'session.compacted',
      properties: { sessionID: 'shared-hung-abort-ses' },
    });
    await new Promise((res) => setTimeout(res, 220));
    expect(directCancelSettled).toBe(false);
    expect(hungErrors.slice(errCountBeforeCancel)).toEqual([]);
    hungQueues.get(6)!.push({
      type: 'session.idle',
      properties: { sessionID: 'shared-hung-abort-ses' },
    });
    await cancelPending;
    expect(directCancelSettled).toBe(true);
    expect(hungErrors.slice(errCountBeforeCancel)).toEqual([
      expect.objectContaining({ sid: hungRetry, code: PROVIDER_ERROR_CODES.CANCELLED }),
    ]);
    await pHungAbort.send(hungRetry, 'after late cancel');

    // B5c: When NO terminal event arrives, cancel() rejects with terminal confirmation timeout and ZERO fake CANCELLED;
    // once late idle arrives afterward (with assistant reply), busy clears and next turn works cleanly!
    const errCountBeforeTimeout = hungErrors.length;
    await expect(pHungAbort.cancel(hungRetry)).rejects.toThrow('Provider stop terminal confirmation timed out');
    expect(hungErrors.slice(errCountBeforeTimeout)).toEqual([]);
    hungQueues.get(6)!.push({
      type: 'message.updated',
      properties: { info: { id: 'msg-b5c', sessionID: 'shared-hung-abort-ses', role: 'assistant' } },
    });
    hungQueues.get(6)!.push({
      type: 'message.part.updated',
      properties: { part: { id: 'prt-b5c', sessionID: 'shared-hung-abort-ses', messageID: 'msg-b5c', type: 'text', text: 'late response' } },
    });
    hungQueues.get(6)!.push({
      type: 'session.idle',
      properties: { sessionID: 'shared-hung-abort-ses' },
    });
    await vi.waitFor(async () => {
      await pHungAbort.send(hungRetry, 'busy before compact cancel');
    });
    const completesBeforeB5d = hungCompletes.length;
    hungQueues.get(6)!.push({
      type: 'message.updated',
      properties: { info: { id: 'msg-b5d-pre', sessionID: 'shared-hung-abort-ses', role: 'assistant' } },
    });
    hungQueues.get(6)!.push({
      type: 'message.part.updated',
      properties: { part: { id: 'prt-b5d-pre', sessionID: 'shared-hung-abort-ses', messageID: 'msg-b5d-pre', type: 'text', text: 'ready' } },
    });
    hungQueues.get(6)!.push({
      type: 'session.idle',
      properties: { sessionID: 'shared-hung-abort-ses' },
    });
    await vi.waitFor(() => expect(hungCompletes.length).toBeGreaterThan(completesBeforeB5d));

    // B5d: Cancelling manual /compact in v1 while summarize and abort are hung MUST ignore unkeyed
    // `session.compacted` (identical between auto and manual compaction in v1) and settle once on `session.idle`.
    hangSummarizeMode = true;
    const summarizeCallsBefore = hungSummarizeCalls.length;
    const compactTurn = pHungAbort.send(hungRetry, '/compact').catch(() => {});
    await vi.waitFor(() => expect(hungSummarizeCalls.length).toBeGreaterThan(summarizeCallsBefore));
    let compactCancelSettled = false;
    const errCountBeforeCompactCancel = hungErrors.length;
    const compactCancelPending = pHungAbort.cancel(hungRetry).then(() => { compactCancelSettled = true; });
    hungQueues.get(6)!.push({
      type: 'session.compacted',
      properties: { sessionID: 'shared-hung-abort-ses' },
    });
    await new Promise((res) => setTimeout(res, 220));
    expect(compactCancelSettled).toBe(false);
    expect(hungErrors.slice(errCountBeforeCompactCancel)).toEqual([]);
    await expect(pHungAbort.send(hungRetry, 'overlap during v1 compact cancel')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: expect.stringContaining('already busy'),
    });
    hungQueues.get(6)!.push({
      type: 'session.idle',
      properties: { sessionID: 'shared-hung-abort-ses' },
    });
    await compactCancelPending;
    expect(compactCancelSettled).toBe(true);
    expect(hungErrors.slice(errCountBeforeCompactCancel)).toEqual([
      expect.objectContaining({ sid: hungRetry, code: PROVIDER_ERROR_CODES.CANCELLED }),
    ]);
    hangSummarizeMode = false;
    releaseHungSummarize?.();
    await compactTurn;
    await pHungAbort.send(hungRetry, 'after v1 compact cancel');

    // B3: `endSession` on busy route with hung `session.abort` finishes promptly AND still runs child close!
    const endT0 = Date.now();
    await pHungAbort.endSession(hungRetry);
    expect(Date.now() - endT0).toBeLessThan(300);
    expect(closedServers.filter((s) => s === 'hung-6').length).toBeGreaterThanOrEqual(1);
    hangAbortMode = false;
    await pHungAbort.disconnect();

    // Counterexample C: v2 split-host sourceClient verification blocks late clientA frames after clientB owns resumeId
    let v2ClientSeq = 0;
    const v2Listeners = new Map<string, (ev: Record<string, any>) => void>();
    const v2Clients: any[] = [];
    openCodeSdkRuntimeHooks.start = vi.fn(async () => {
      const idx = ++v2ClientSeq;
      const clientObj: any = {
        _idx: idx,
        sessions: {
          create: vi.fn(async () => ({ id: 'shared-v2-ses' })),
          get: vi.fn(async () => ({ id: 'shared-v2-ses' })),
          prompt: vi.fn(async () => ({})),
          update: vi.fn(async () => ({ id: 'shared-v2-ses' })),
        },
        session: {
          switchModel: vi.fn(async () => ({})),
          interrupt: vi.fn(async () => ({})),
          message: { get: vi.fn(async () => { const e: any = new Error('404'); e.status = 404; throw e; }) },
        },
        provider: { list: vi.fn(async () => ({ data: [] })) },
        model: {
          list: vi.fn(async () => ({ data: [] })),
          default: vi.fn(async () => ({ data: null })),
        },
        mcp: { add: vi.fn(async () => ({})), list: vi.fn(async () => ({ data: [] })) },
        permission: { reply: vi.fn(async () => ({})) },
        events: { subscribe: vi.fn(async () => ({ stream: createAsyncQueue<Record<string, any>>().stream })) },
      };
      v2Clients.push(clientObj);
      return {
        client: clientObj,
        server: { url: `http://127.0.0.1:${43000 + idx}`, close: vi.fn(async () => {}) },
        subscribeEvents: async (_cid: symbol, listener: (ev: Record<string, any>) => void) => {
          v2Listeners.set(`sub-${idx}`, listener);
          return async () => { v2Listeners.delete(`sub-${idx}`); };
        },
      };
    });
    const pV2Iso = new OpenCodeSdkProvider();
    const v2Deltas: Array<{ sid: string; delta: string }> = [];
    const v2Approvals: Array<{ sid: string; id: string }> = [];
    pV2Iso.onDelta((sid, d) => v2Deltas.push({ sid, delta: d.delta }));
    pV2Iso.onApprovalRequest((sid, req) => v2Approvals.push({ sid, id: req.id }));
    await pV2Iso.connect({});
    const v2A = await pV2Iso.createSession({ sessionKey: 'v2-routeA', sessionName: 'deck_a', cwd: root });
    await pV2Iso.send(v2A, 'turn A');
    const v2B = await pV2Iso.createSession({
      sessionKey: 'v2-routeB',
      sessionName: 'deck_b',
      cwd: root,
      skipCreate: true,
      resumeId: 'shared-v2-ses',
    });
    await pV2Iso.send(v2B, 'turn B');
    const listenerFromClientA = v2Listeners.get('sub-2');
    const listenerFromClientB = v2Listeners.get('sub-3');
    expect(listenerFromClientA).toBeDefined();
    expect(listenerFromClientB).toBeDefined();
    // Late stale frames arriving from old host clientA must NOT reach v2B!
    listenerFromClientA!({
      id: 'ev-stale-perm',
      type: 'permission.asked',
      properties: { id: 'perm-stale-host', sessionID: 'shared-v2-ses', action: 'bash', resources: ['rm'] },
    });
    listenerFromClientA!({
      id: 'ev-stale-delta',
      type: 'session.text.delta',
      properties: { sessionID: 'shared-v2-ses', delta: 'FROM_STALE_HOST_A' },
    });
    // Live frame with SAME session ID from active owner clientB must be delivered to v2B
    listenerFromClientB!({
      id: 'ev-live-delta',
      type: 'session.text.delta',
      properties: { sessionID: 'shared-v2-ses', delta: 'FROM_LIVE_HOST_B' },
    });
    await new Promise((res) => setTimeout(res, 20));
    expect(v2Approvals).toEqual([]);
    expect(v2Deltas.some((d) => d.delta.includes('FROM_STALE_HOST_A'))).toBe(false);
    expect(v2Deltas.some((d) => d.sid === v2B && d.delta.includes('FROM_LIVE_HOST_B'))).toBe(true);
    await pV2Iso.disconnect();
  }, 20_000);

  it('F6: preserves default embedded opencode-sdk.db session restore across upgrade to v1 CLI or v2 store', async () => {
    const root = mkTemp();
    const stateHome = join(root, 'imcodes-state');
    const xdgData = join(root, 'xdg-data');
    mkdirSync(stateHome, { recursive: true });
    mkdirSync(xdgData, { recursive: true });
    process.env.IMCODES_HOME = stateHome;
    process.env.XDG_DATA_HOME = xdgData;

    // 1. Seed a real session in base embedded IMCODES_HOME/opencode-sdk.db
    const pBase = new OpenCodeSdkProvider();
    let oldSessionId = '';
    pBase.onSessionInfo((_sid, info) => {
      if (info.resumeId) oldSessionId = info.resumeId;
    });
    await pBase.connect({ transport: 'embedded', cwd: root } as any);
    await pBase.createSession({ sessionKey: 'legacy-emb', cwd: root });
    expect(oldSessionId).toMatch(/^ses_/);
    await pBase.disconnect();

    // 2. Restore into a fresh v2 store (simulating fresh v2-cli DB after upgrade)
    const freshV2Db = join(root, 'fresh-v2.db');
    const pV2 = new OpenCodeSdkProvider();
    await pV2.connect({ databasePath: freshV2Db, cwd: root } as any);
    expect(await pV2.restoreSession(oldSessionId)).toBe(true);
    const restoredV2 = await pV2.createSession({
      sessionKey: 'restored-v2',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
    });
    expect(restoredV2).toBe('restored-v2');
    await pV2.disconnect();

    // 3. Upgrade with v1 CLI installed: missing ID in v1 CLI falls back only for known embedded DB sessions
    const v1Bin = makeFakeExecutable(join(root, 'v1bin'), 'opencode', '#!/bin/sh\necho "1.18.4"\n');
    const v1Queue = createAsyncQueue<Record<string, any>>();
    openCodeV1RuntimeHooks.start = vi.fn(async (opts) => {
      opts.signal.addEventListener('abort', v1Queue.close, { once: true });
      return {
        client: {
          session: {
            create: vi.fn(async () => ({ data: { id: 'ses-new-v1' } })),
            get: vi.fn(async () => {
              const err: any = new Error('404 session not found');
              err.status = 404;
              throw err;
            }),
            list: vi.fn(async () => ({ data: [] })),
            message: vi.fn(async () => ({ data: null })),
            messages: vi.fn(async () => ({ data: [] })),
            prompt: vi.fn(async () => ({ data: {} })),
            promptAsync: vi.fn(async () => ({ data: undefined })),
            abort: vi.fn(async () => ({ data: true })),
          },
          provider: { list: vi.fn(async () => ({ data: { connected: [], all: [], default: {} } })) },
          event: { subscribe: vi.fn(async () => ({ stream: v1Queue.stream })) },
          postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
        } as any,
        server: { url: 'http://127.0.0.1:42004', close: vi.fn(async () => { v1Queue.close(); }) },
      };
    });

    const pUpgraded = new OpenCodeSdkProvider();
    await pUpgraded.connect({ binaryPath: v1Bin, cwd: root } as any);
    expect(await pUpgraded.restoreSession(oldSessionId)).toBe(true);
    const restoredViaEmb = await pUpgraded.createSession({
      sessionKey: 'route-old-emb',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
    });
    expect(restoredViaEmb).toBe('route-old-emb');
    // Unknown ID never silently creates an empty session
    await expect(pUpgraded.createSession({
      sessionKey: 'route-unknown',
      cwd: root,
      skipCreate: true,
      resumeId: 'ses_nonexistent_999',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });
    // New session uses v1 CLI normally
    const freshV1Route = await pUpgraded.createSession({ sessionKey: 'route-new-v1', cwd: root });
    expect(freshV1Route).toBe('route-new-v1');
    // 4. Same-ID collision: BOTH v1 DB (older 2 msgs) and default embedded opencode-sdk.db (follow-up 3+ msgs) hold same ID!
    // Unowned legacy restore must choose embedded DB so follow-up history is preserved & new messages append there.
    const { DatabaseSync } = await import('node:sqlite');
    const embeddedDbFile = join(stateHome, 'opencode-sdk.db');
    const embDb = new DatabaseSync(embeddedDbFile);
    const v2MsgsBefore = Number((embDb.prepare('SELECT COUNT(*) AS cnt FROM session_message WHERE session_id = ?').get(oldSessionId) as any).cnt);
    embDb.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('msg_emb_followup', oldSessionId, 'user', v2MsgsBefore + 1, Date.now() + 5000, Date.now() + 5000, JSON.stringify({ type: 'user', text: 'embedded follow-up' }));
    embDb.prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?').run(Date.now() + 5000, oldSessionId);
    embDb.close();

    const collisionGet = vi.fn(async ({ path: reqPath }: any) => {
      if (reqPath?.id === oldSessionId) {
        return { data: { id: oldSessionId, directory: root, time: { created: 1000, updated: 1000 } } };
      }
      if (reqPath?.id === 'ses-only-v1') {
        return { data: { id: 'ses-only-v1', directory: root, time: { created: 2000, updated: 2000 } } };
      }
      const err: any = new Error('404 session not found');
      err.status = 404;
      throw err;
    });
    const collisionMessages = vi.fn(async ({ path: reqPath }: any) => {
      if (reqPath?.id === oldSessionId) return { data: [{ info: { id: 'm1', time: { created: 900 } } }] };
      if (reqPath?.id === 'ses-only-v1') return { data: [{ info: { id: 'm2', time: { created: 2000 } } }] };
      return { data: [] };
    });
    openCodeV1RuntimeHooks.start = vi.fn(async (opts) => {
      opts.signal.addEventListener('abort', v1Queue.close, { once: true });
      return {
        client: {
          session: {
            create: vi.fn(async () => ({ data: { id: 'ses-new-v1-coll' } })),
            get: collisionGet,
            list: vi.fn(async () => ({ data: [] })),
            message: vi.fn(async () => ({ data: null })),
            messages: collisionMessages,
            prompt: vi.fn(async () => ({ data: {} })),
            promptAsync: vi.fn(async () => ({ data: undefined })),
            abort: vi.fn(async () => ({ data: true })),
          },
          provider: { list: vi.fn(async () => ({ data: { connected: [], all: [], default: {} } })) },
          event: { subscribe: vi.fn(async () => ({ stream: v1Queue.stream })) },
          postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
        } as any,
        server: { url: 'http://127.0.0.1:42006', close: vi.fn(async () => { v1Queue.close(); }) },
      };
    });
    const pCollision = new OpenCodeSdkProvider();
    const collisionOwners: Array<string | undefined> = [];
    pCollision.onSessionInfo((_sid, info) => collisionOwners.push(info.openCodeStorageOwner));
    await pCollision.connect({ binaryPath: v1Bin, cwd: root } as any);
    // Unowned legacy restore picks embedded because embedded has newer follow-up state!
    const resumedEmbRoute = await pCollision.createSession({
      sessionKey: 'route-collision-emb',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
    });
    expect(resumedEmbRoute).toBe('route-collision-emb');
    expect(collisionOwners[collisionOwners.length - 1]).toBe('embedded');
    // Session only in v1 DB picks v1-cli!
    const resumedV1Route = await pCollision.createSession({
      sessionKey: 'route-only-v1',
      cwd: root,
      skipCreate: true,
      resumeId: 'ses-only-v1',
    });
    expect(resumedV1Route).toBe('route-only-v1');
    expect(collisionOwners[collisionOwners.length - 1]).toBe('v1-cli');
    // Explicit ownership override forces v1-cli even if same ID is in embedded
    const forcedV1Route = await pCollision.createSession({
      sessionKey: 'route-explicit-v1',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
      openCodeStorageOwner: 'v1-cli',
    });
    expect(forcedV1Route).toBe('route-explicit-v1');
    // Explicit v2-cli owner under v1-cli throws explicit CONFIG_ERROR (never silent cutover)
    await expect(pCollision.createSession({
      sessionKey: 'route-explicit-v2-under-v1',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
      openCodeStorageOwner: 'v2-cli',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    await pCollision.disconnect();

    // 5. v2-cli with SAME ID present in BOTH v2 store (1 stale msg + newer metadata touch time) and embedded DB:
    //    (a) Known openCodeStorageOwner='embedded' goes straight to embedded BEFORE touching v2 CLI & keeps owner='embedded'
    //    (b) Unowned legacy session where embedded has MORE messages than metadata-touched v2 copy also chooses embedded
    //    (c) New sessions still use v2-cli, and missing known-embedded session fails explicitly
    const v2PromptCalls: string[] = [];
    const v2GetCalls: string[] = [];
    const v2HostScript = join(root, 'v2-f6-host.mjs');
    writeFileSync(v2HostScript, `
      import http from 'node:http';
      import { appendFileSync } from 'node:fs';
      if (process.argv.includes('--version')) {
        console.log('opencode v2.4.2');
        process.exit(0);
      }
      const logFile = process.env.V2_F6_LOG;
      const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
          if (pathname === '/api/info') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ version: '2.4.2', urls: [] }));
            return;
          }
          if (pathname === '/api/event') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ type: 'server.connected', properties: {} }) + '\\n\\n');
            return;
          }
          if (pathname === '/api/provider') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: [{ id: 'opencode', name: 'OpenCode', activation: 'ready' }] }));
            return;
          }
          if (pathname === '/api/model') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: [{ id: 'opencode/big-pickle', providerID: 'opencode', modelID: 'big-pickle', enabled: true, type: 'chat' }] }));
            return;
          }
          if (pathname === '/api/model/default') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: { providerID: 'opencode', modelID: 'big-pickle' } }));
            return;
          }
          if (pathname === '/api/session' && req.method === 'POST') {
            appendFileSync(logFile, JSON.stringify({ op: 'create' }) + '\\n');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: { id: 'ses-new-v2-only', location: { directory: ${JSON.stringify(root)} } } }));
            return;
          }
          if (pathname === ${JSON.stringify('/api/session/' + oldSessionId)} && req.method === 'GET') {
            appendFileSync(logFile, JSON.stringify({ op: 'get', id: ${JSON.stringify(oldSessionId)} }) + '\\n');
            res.setHeader('content-type', 'application/json');
            // V2 stale copy has only 1 message, even with newer metadata touch timestamp!
            res.end(JSON.stringify({ data: { id: ${JSON.stringify(oldSessionId)}, time: { created: 1000, updated: 9999999999999 } } }));
            return;
          }
          if (pathname === ${JSON.stringify('/api/session/' + oldSessionId + '/message')} && req.method === 'GET') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: [{ id: 'stale-v2-msg-1', type: 'user', time: { created: 1000 } }] }));
            return;
          }
          if (pathname.startsWith('/api/session/') && req.method === 'GET') {
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ message: 'Not Found' }));
            return;
          }
          if (pathname.startsWith('/api/experimental/session/') && pathname.endsWith('/export') && req.method === 'GET') {
            res.setHeader('content-type', 'application/json');
            if (pathname === ${JSON.stringify('/api/experimental/session/' + oldSessionId + '/export')}) {
              res.end(JSON.stringify({
                data: {
                  info: { id: ${JSON.stringify(oldSessionId)}, time: { created: 1000, updated: 9999999999999 } },
                  messages: [{ id: 'stale-v2-msg-1', type: 'user', time: { created: 1000 } }],
                },
              }));
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ message: 'Not Found' }));
            return;
          }
          if (pathname.endsWith('/prompt')) {
            appendFileSync(logFile, JSON.stringify({ op: 'prompt', path: pathname }) + '\\n');
            res.setHeader('content-type', 'application/json');
            res.end('{}');
            return;
          }
          if (pathname === '/api/experimental/session/import' && req.method === 'POST') {
            const parsed = JSON.parse(body || '{}');
            const importedId = parsed?.info?.id ?? 'ses-imported-v1';
            appendFileSync(logFile, JSON.stringify({ op: 'import', id: importedId }) + '\\n');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: { id: importedId, location: parsed?.location } }));
            return;
          }
          if (pathname.startsWith('/api/experimental/mcp/')) {
            res.statusCode = 204;
            res.end();
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end('{}');
        });
      });
      srv.listen(0, '127.0.0.1', () => {
        console.log('listening on http://127.0.0.1:' + srv.address().port);
      });
      process.on('SIGTERM', () => process.exit(0));
    `, 'utf8');
    const v2F6Log = join(root, 'v2-f6.log');
    writeFileSync(v2F6Log, '', 'utf8');
    process.env.V2_F6_LOG = v2F6Log;
    const v2F6Bin = makeFakeExecutable(join(root, 'v2f6'), 'opencode', `#!/bin/sh\nexec "${process.execPath}" "${v2HostScript}" "$@"\n`);

    const pV2Upgrade = new OpenCodeSdkProvider();
    const v2UpgradeOwners: Array<{ sid: string; owner: string | undefined }> = [];
    pV2Upgrade.onSessionInfo((sid, info) => v2UpgradeOwners.push({ sid, owner: info.openCodeStorageOwner }));
    await pV2Upgrade.connect({ binaryPath: v2F6Bin, cwd: root } as any);

    // (a) Known openCodeStorageOwner='embedded' bypasses v2 CLI GET completely & keeps owner='embedded'
    const knownEmbRoute = await pV2Upgrade.createSession({
      sessionKey: 'v2-known-emb',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
      openCodeStorageOwner: 'embedded',
    });
    expect(knownEmbRoute).toBe('v2-known-emb');
    expect(v2UpgradeOwners.find((x) => x.sid === 'v2-known-emb')?.owner).toBe('embedded');
    expect(readFileSync(v2F6Log, 'utf8')).toBe('');

    // (b) Known openCodeStorageOwner='embedded' for nonexistent ID fails explicitly without switching to v2 CLI
    await expect(pV2Upgrade.createSession({
      sessionKey: 'v2-missing-known-emb',
      cwd: root,
      skipCreate: true,
      resumeId: 'ses_missing_known_emb',
      openCodeStorageOwner: 'embedded',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });

    // (c) Unowned collision: embedded has MORE messages (2+ vs 1 stale v2 msg), even though v2 metadata time.updated is larger
    const unownedV2Collision = await pV2Upgrade.createSession({
      sessionKey: 'v2-unowned-coll',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
    });
    expect(unownedV2Collision).toBe('v2-unowned-coll');
    expect(v2UpgradeOwners.filter((x) => x.sid === 'v2-unowned-coll').at(-1)?.owner).toBe('embedded');

    // (d) New session still defaults to v2-cli
    const freshV2Route = await pV2Upgrade.createSession({ sessionKey: 'v2-fresh-new', cwd: root });
    expect(freshV2Route).toBe('v2-fresh-new');
    expect(v2UpgradeOwners.find((x) => x.sid === 'v2-fresh-new')?.owner).toBe('v2-cli');
    expect(v2GetCalls.length + v2PromptCalls.length).toBe(0);
    expect(readFileSync(v2F6Log, 'utf8')).toContain('"op":"create"');

    // (e) v1-cli owner + V2_CLI mode + missing v1 DB source MUST fail BEFORE touching colliding v2 item or updating owner!
    writeFileSync(v2F6Log, '', 'utf8');
    const ownerCountBeforeG = v2UpgradeOwners.length;
    await expect(pV2Upgrade.createSession({
      sessionKey: 'v2-missing-v1-src',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
      openCodeStorageOwner: 'v1-cli',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    expect(readFileSync(v2F6Log, 'utf8')).toBe('');
    expect(v2UpgradeOwners.length).toBe(ownerCountBeforeG);

    // (f) v1-cli owner + V2_CLI mode:
    //     - divergent v2 copy with same ID (`oldSessionId` has `stale-v2-msg-1`) MUST reject conflict & keep both!
    //     - clean v1 session (`ses_v1_mig_only`) imports via POST /api/experimental/session/import and updates owner='v2-cli'
    const v1DataDir = join(xdgData, 'opencode');
    mkdirSync(v1DataDir, { recursive: true });
    const v1OnlyMigId = 'ses_v1_mig_only';
    const v1SourceDb = new DatabaseSync(join(v1DataDir, 'opencode.db'));
    v1SourceDb.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    v1SourceDb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run(oldSessionId, root, 'v1-divergent', 1000, 2000);
    v1SourceDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('msg_v1_1', oldSessionId, 1100, 1100, JSON.stringify({ role: 'user', agent: 'build' }));
    v1SourceDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run('prt_v1_1', 'msg_v1_1', oldSessionId, 1100, 1100, JSON.stringify({ type: 'text', text: 'from v1' }));
    v1SourceDb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run(v1OnlyMigId, root, 'v1-clean-mig', 1000, 2000);
    v1SourceDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('msg_v1_only_1', v1OnlyMigId, 1100, 1100, JSON.stringify({ role: 'user', agent: 'build' }));
    v1SourceDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run('prt_v1_only_1', 'msg_v1_only_1', v1OnlyMigId, 1100, 1100, JSON.stringify({ type: 'text', text: 'clean migrate' }));
    const pinnedV1Id = 'ses_v1_pinned_mig';
    v1SourceDb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run(pinnedV1Id, root, 'v1-pinned-idempotent', 1500, 2500);
    v1SourceDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('msg_pin_1', pinnedV1Id, 1600, 1600, JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'opencode', modelID: 'big-pickle' } }));
    v1SourceDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run('prt_pin_1', 'msg_pin_1', pinnedV1Id, 1600, 1600, JSON.stringify({ type: 'text', text: 'pinned hello v1' }));
    v1SourceDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('msg_pin_2', pinnedV1Id, 1700, 1800, JSON.stringify({ role: 'assistant', agent: 'build', finish: 'stop', model: { providerID: 'opencode', modelID: 'big-pickle' }, time: { completed: 1800 } }));
    v1SourceDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run('prt_pin_2', 'msg_pin_2', pinnedV1Id, 1700, 1800, JSON.stringify({
      type: 'tool',
      callID: 'call_bash_1',
      tool: 'bash',
      state: { status: 'completed', input: { command: 'pwd' }, output: 'ORIGINAL_TOOL_OUTPUT', time: { start: 1700, end: 1800 } },
    }));
    const toolDiffV1Id = 'ses_v1_tool_diff';
    v1SourceDb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run(toolDiffV1Id, root, 'v1-tool-diff', 1500, 2500);
    v1SourceDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('msg_td_1', toolDiffV1Id, 1600, 1600, JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'opencode', modelID: 'big-pickle' } }));
    v1SourceDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run('prt_td_1', 'msg_td_1', toolDiffV1Id, 1600, 1600, JSON.stringify({ type: 'text', text: 'run pwd' }));
    v1SourceDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('msg_td_2', toolDiffV1Id, 1700, 1800, JSON.stringify({ role: 'assistant', agent: 'build', finish: 'stop', model: { providerID: 'opencode', modelID: 'big-pickle' }, time: { completed: 1800 } }));
    v1SourceDb.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run('prt_td_2', 'msg_td_2', toolDiffV1Id, 1700, 1800, JSON.stringify({
      type: 'tool',
      callID: 'call_bash_diff',
      tool: 'bash',
      state: { status: 'completed', input: { command: 'pwd' }, output: 'ORIGINAL_TOOL_OUTPUT', time: { start: 1700, end: 1800 } },
    }));
    v1SourceDb.close();

    const ownersBeforeConflict = v2UpgradeOwners.length;
    await expect(pV2Upgrade.createSession({
      sessionKey: 'v2-divergent-v1',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
      openCodeStorageOwner: 'v1-cli',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    expect(v2UpgradeOwners.length).toBe(ownersBeforeConflict);

    const migRoute = await pV2Upgrade.createSession({
      sessionKey: 'v2-confirmed-v1-mig',
      cwd: root,
      skipCreate: true,
      resumeId: v1OnlyMigId,
      openCodeStorageOwner: 'v1-cli',
    });
    expect(migRoute).toBe('v2-confirmed-v1-mig');
    expect(readFileSync(v2F6Log, 'utf8')).toContain(`"op":"import","id":"${v1OnlyMigId}"`);
    expect(v2UpgradeOwners.at(-1)?.owner).toBe('v2-cli');

    // (g) Real pinned @opencode/sdk@2.4.2 EMBEDDED runtime:
    //     1) First migration with v1-cli owner imports `pinnedV1Id` cleanly into `embeddedDbFile` & emits 'embedded'.
    //     2) Simulated daemon interruption before persisting new owner: reconnect & retry with stale `openCodeStorageOwner: 'v1-cli'`
    //        MUST detect identical already-imported history (NO ImportConflictError!) & reuse target cleanly!
    //     3) Divergent history (`oldSessionId` in embedded DB != `oldSessionId` in `v1SourceDb`) MUST fail CONFIG_ERROR without modifying either DB.
    const pEmbOnly = new OpenCodeSdkProvider();
    const embOnlyOwners: Array<{ sid: string; owner: string | undefined }> = [];
    pEmbOnly.onSessionInfo((sid, info) => embOnlyOwners.push({ sid, owner: info.openCodeStorageOwner }));
    await pEmbOnly.connect({ embedded: true, databasePath: embeddedDbFile, cwd: root } as any);

    const pinnedFirstRoute = await pEmbOnly.createSession({
      sessionKey: 'emb-pinned-first',
      cwd: root,
      skipCreate: true,
      resumeId: pinnedV1Id,
      openCodeStorageOwner: 'v1-cli',
    });
    expect(pinnedFirstRoute).toBe('emb-pinned-first');
    expect(embOnlyOwners.at(-1)?.owner).toBe('embedded');
    const toolDiffFirstRoute = await pEmbOnly.createSession({
      sessionKey: 'emb-tooldiff-first',
      cwd: root,
      skipCreate: true,
      resumeId: toolDiffV1Id,
      openCodeStorageOwner: 'v1-cli',
    });
    expect(toolDiffFirstRoute).toBe('emb-tooldiff-first');
    await pEmbOnly.disconnect();

    // Simulate v1 compaction replacing `call_bash_diff` output while keeping same session ID, message ID, callID, type, directory!
    const v1CompactDb = new DatabaseSync(join(v1DataDir, 'opencode.db'));
    v1CompactDb.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify({
      type: 'tool',
      callID: 'call_bash_diff',
      tool: 'bash',
      state: { status: 'completed', input: { command: 'pwd' }, output: 'ORIGINAL_TOOL_OUTPUT', time: { start: 1700, end: 1800, compacted: 1900 } },
    }), 'prt_td_2');
    v1CompactDb.close();

    const pEmbRetry = new OpenCodeSdkProvider();
    const embRetryOwners: Array<{ sid: string; owner: string | undefined }> = [];
    pEmbRetry.onSessionInfo((sid, info) => embRetryOwners.push({ sid, owner: info.openCodeStorageOwner }));
    await pEmbRetry.connect({ embedded: true, databasePath: embeddedDbFile, cwd: root } as any);

    // Retry with stale `openCodeStorageOwner: 'v1-cli'` succeeds (no 409 ImportConflictError!)
    const pinnedRetryRoute = await pEmbRetry.createSession({
      sessionKey: 'emb-pinned-retry',
      cwd: root,
      skipCreate: true,
      resumeId: pinnedV1Id,
      openCodeStorageOwner: 'v1-cli',
    });
    expect(pinnedRetryRoute).toBe('emb-pinned-retry');
    expect(embRetryOwners.at(-1)?.owner).toBe('embedded');

    // Same ID/type/directory/callID with DIFFERENT tool result (compacted in v1 vs original in embedded) MUST reject CONFIG_ERROR!
    const ownersBeforeToolDiff = embRetryOwners.length;
    await expect(pEmbRetry.createSession({
      sessionKey: 'emb-rejects-tool-diff',
      cwd: root,
      skipCreate: true,
      resumeId: toolDiffV1Id,
      openCodeStorageOwner: 'v1-cli',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    expect(embRetryOwners.length).toBe(ownersBeforeToolDiff);

    // Divergent history (`oldSessionId` in embedded != `oldSessionId` in v1) fails & preserves both DBs!
    const ownersBeforeDivergentEmb = embRetryOwners.length;
    await expect(pEmbRetry.createSession({
      sessionKey: 'emb-rejects-divergent-v1',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
      openCodeStorageOwner: 'v1-cli',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    expect(embRetryOwners.length).toBe(ownersBeforeDivergentEmb);

    // (h) v2-cli owner + EMBEDDED mode + colliding embedded copy rejects without DB write or owner overwrite;
    //     unavailable v1-cli owner + EMBEDDED mode also rejects; new session fallback still works!
    rmSync(join(v1DataDir, 'opencode.db'), { force: true });
    const embSnapDb = new DatabaseSync(embeddedDbFile);
    const snapBefore = embSnapDb.prepare('SELECT time_updated FROM session_v2 WHERE id = ?').get(oldSessionId) as { time_updated: number };
    const cntBefore = Number((embSnapDb.prepare('SELECT COUNT(*) AS cnt FROM session_message WHERE session_id = ?').get(oldSessionId) as any).cnt);
    embSnapDb.close();

    await expect(pEmbRetry.createSession({
      sessionKey: 'emb-rejects-v2',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
      openCodeStorageOwner: 'v2-cli',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    await expect(pEmbRetry.createSession({
      sessionKey: 'emb-rejects-missing-v1',
      cwd: root,
      skipCreate: true,
      resumeId: oldSessionId,
      openCodeStorageOwner: 'v1-cli',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    expect(embRetryOwners.length).toBe(ownersBeforeDivergentEmb);

    const embAfterDb = new DatabaseSync(embeddedDbFile);
    const snapAfter = embAfterDb.prepare('SELECT time_updated FROM session_v2 WHERE id = ?').get(oldSessionId) as { time_updated: number };
    const cntAfter = Number((embAfterDb.prepare('SELECT COUNT(*) AS cnt FROM session_message WHERE session_id = ?').get(oldSessionId) as any).cnt);
    embAfterDb.close();
    expect(snapAfter.time_updated).toBe(snapBefore.time_updated);
    expect(cntAfter).toBe(cntBefore);

    const embFreshRoute = await pEmbRetry.createSession({ sessionKey: 'emb-fresh-ok', cwd: root });
    expect(embFreshRoute).toBe('emb-fresh-ok');
    expect(embRetryOwners.find((x) => x.sid === 'emb-fresh-ok')?.owner).toBe('embedded');
    await pEmbRetry.disconnect();

    delete process.env.V2_F6_LOG;
    await pV2Upgrade.disconnect();
    await pUpgraded.disconnect();
  }, 30_000);

  it('F7 & F8: v1 uses /api/session/{id}/prompt steer wire contract (or UNSUPPORTED on 404) and handles named expired 401 vs plain auth failures', async () => {
    const requests: Array<{ method?: string; url?: string; body: any }> = [];
    let steerStatus = 200;
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
        requests.push({ method: req.method, url: pathname, body: parsed });
        if (pathname === '/session' && req.method === 'POST') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ id: 'ses-wire-1' }));
          return;
        }
        if (pathname === '/session/ses-wire-1/prompt_async') {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (pathname.startsWith('/session/ses-wire-1/message/')) {
          res.statusCode = 404;
          res.end('{}');
          return;
        }
        if (pathname === '/api/session/ses-wire-1/prompt') {
          res.statusCode = steerStatus;
          res.setHeader('content-type', 'application/json');
          res.end(steerStatus === 200 ? JSON.stringify({ admittedSeq: 1 }) : JSON.stringify({ message: 'Not Found' }));
          return;
        }
        if (pathname.startsWith('/event')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ all: [], connected: [], default: {} }));
      });
    });
    await new Promise<void>((resListen) => srv.listen(0, '127.0.0.1', () => resListen()));
    const port = (srv.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;

    try {
      const [sdk, v2Sdk] = await Promise.all([
        import('@opencode-ai/sdk'),
        import('@opencode-ai/sdk/v2/client'),
      ]);
      const client = sdk.createOpencodeClient({ baseUrl: url });
      const v2Client = v2Sdk.createOpencodeClient({ baseUrl: url });
      Object.assign(client, { notificationSession: (v2Client as any).v2.session });

      openCodeV1RuntimeHooks.start = vi.fn(async () => ({
        client: client as any,
        server: { url, close: vi.fn(async () => {}) },
      }));

      const v1 = new OpenCodeV1CliProvider({ binaryPath: '/fake/v1' });
      await v1.connect({});
      const r = await v1.createSession({ sessionKey: 'r-wire', cwd: '/tmp', agentId: 'opencode/big-pickle' });
      await v1.send(r, 'initial');

      // 1. Supported v1.18+ steer hits POST /api/session/ses-wire-1/prompt with msg_* id and delivery='steer'
      const delivered = await v1.notifyActiveDelegation(r, {
        notificationId: 'notif-abc',
        text: 'child finished',
        agentName: 'sub1',
      } as any);
      expect(delivered).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
      const steerReq = requests.find((req) => req.url === '/api/session/ses-wire-1/prompt');
      expect(steerReq?.method).toBe('POST');
      expect(steerReq?.body.id).toMatch(/^msg_/);
      expect(steerReq?.body.delivery).toBe('steer');
      expect(steerReq?.body.resume).toBe(true);
      expect(steerReq?.body.prompt).toEqual({ text: 'child finished' });

      // 2. Older v1 CLI returning 404 returns UNSUPPORTED (never falsely DELIVERED)
      steerStatus = 404;
      const unsupported = await v1.notifyActiveDelegation(r, {
        notificationId: 'notif-404',
        text: 'child finished 2',
        agentName: 'sub1',
      } as any);
      expect(unsupported).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.UNSUPPORTED);

      // 3. F8: named expired OpenCode 401 vs plain/third-party auth failures
      const expiredOpenCodeErr = (v1 as any).normalizeError(
        { status: 401, code: 'api_key_expired', providerID: 'opencode', message: 'API key expired' },
        'session',
        'opencode',
      );
      expect(expiredOpenCodeErr.code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
      expect(expiredOpenCodeErr.message).toContain('OPENCODE_API_KEY');
      expect(expiredOpenCodeErr.message).toContain('opencode auth login');

      const thirdPartyExpired = (v1 as any).normalizeError(
        { status: 401, code: 'api_key_expired', providerID: 'minimax', message: 'API key expired' },
        'session',
        'minimax',
      );
      expect(thirdPartyExpired.code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
      expect(thirdPartyExpired.message).not.toContain('OPENCODE_API_KEY');

      const plainAuthErr = (v1 as any).normalizeError(
        { status: 401, message: 'unauthorized' },
        'session',
        'opencode',
      );
      expect(plainAuthErr.code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
      expect(plainAuthErr.message).not.toContain('OPENCODE_API_KEY');

      await v1.disconnect();
    } finally {
      await new Promise<void>((resClose) => srv.close(() => resClose()));
    }
  });

  it('F4 real v1.18.4 CLI stock policy vs fenced+guarded session permission policy (zero LLM call)', async () => {
    const realV1Bin = '/home/k/.opencode/bin/opencode';
    if (!existsSync(realV1Bin)) return;
    const root = mkTemp('oc-f4-real-');
    const prevXdg = {
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    };
    process.env.XDG_DATA_HOME = join(root, 'data');
    process.env.XDG_STATE_HOME = join(root, 'state');
    process.env.XDG_CONFIG_HOME = join(root, 'config');
    process.env.XDG_CACHE_HOME = join(root, 'cache');

    try {
      // 1. Stock provider (no fence, no guard)
      const stockProvider = new OpenCodeSdkProvider();
      await stockProvider.connect({ binaryPath: realV1Bin, cwd: root } as any);
      const rStock = await stockProvider.createSession({ sessionKey: 'f4-stock', sessionName: 'f4-stock', cwd: root });
      const stockState = ((stockProvider as any).v1Delegate as any).sessions.get(rStock);
      const stockAgents = await stockState.client.app.agents();
      const stockBuild = (stockAgents.data ?? []).find((a: any) => a.name === 'build');
      const stockWildcard = stockBuild?.permission?.findLast((rule: any) => rule.permission === '*' && rule.pattern === '*');
      expect(stockWildcard?.action).toBe('allow');
      const stockSession = await stockState.client.session.get({ path: { id: stockState.providerSessionId }, query: { directory: root } });
      expect(stockSession.data?.permission ?? []).toEqual([]);
      await stockProvider.disconnect();

      // 2. Fenced + guarded provider
      const guardedProvider = new OpenCodeSdkProvider();
      guardedProvider.setNativeAgentFenceResolver(() => true);
      guardedProvider.setToolExecutionGuard(async () => ({ allow: false, reason: 'blocked' }));
      await guardedProvider.connect({ binaryPath: realV1Bin, cwd: root } as any);
      const rFenced = await guardedProvider.createSession({ sessionKey: 'f4-fenced', sessionName: 'f4-fenced', cwd: root });
      const fencedState = ((guardedProvider as any).v1Delegate as any).sessions.get(rFenced);
      const fencedSession = await fencedState.client.session.get({ path: { id: fencedState.providerSessionId }, query: { directory: root } });
      expect(fencedSession.data?.permission).toEqual([
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'task', pattern: '*', action: 'deny' },
        { permission: 'subagent', pattern: '*', action: 'deny' },
      ]);

      // 3. Create existing session with custom specific deny (webfetch: deny) on stock server,
      //    disconnect, restore with fenced+guarded provider (skipCreate: true), send noReply prompt (ZERO LLM calls),
      //    and verify wildcard ask + webfetch deny + task/subagent deny ALL remain effective!
      const customSession = await fencedState.client.session.create({
        query: { directory: root },
        body: {
          title: 'f4-custom-restore',
          permission: [{ permission: 'webfetch', pattern: '*', action: 'deny' }],
        },
        throwOnError: true,
      });
      const customId = customSession.data.id;
      const rRestored = await guardedProvider.createSession({
        sessionKey: 'f4-restored',
        sessionName: 'f4-restored',
        cwd: root,
        skipCreate: true,
        resumeId: customId,
      });
      const restoredState = ((guardedProvider as any).v1Delegate as any).sessions.get(rRestored);
      // Issue a real noReply prompt WITHOUT tools (matching v1 promptAsync wire payload)
      await restoredState.client.session.prompt({
        path: { id: customId },
        query: { directory: root },
        body: {
          noReply: true,
          parts: [{ type: 'text', text: 'noop-policy-check' }],
        },
        throwOnError: true,
      });
      const afterPromptSession = await restoredState.client.session.get({ path: { id: customId }, query: { directory: root } });
      const perms = (afterPromptSession.data?.permission ?? []) as Array<{ permission: string; pattern: string; action: string }>;
      // Verify .findLast() semantics: * -> ask appears BEFORE webfetch -> deny & task/subagent -> deny
      const evalPerm = (tool: string) => {
        for (let i = perms.length - 1; i >= 0; i--) {
          if (perms[i]!.permission === tool || perms[i]!.permission === '*') return perms[i]!.action;
        }
        return 'allow';
      };
      expect(evalPerm('webfetch')).toBe('deny');
      expect(evalPerm('task')).toBe('deny');
      expect(evalPerm('subagent')).toBe('deny');
      expect(evalPerm('bash')).toBe('ask');

      // 4. Global wildcard `*/* deny` session: guard must preserve `*/* deny` (NOT downgrade to `ask`!),
      //    keep `task`/`subagent` hard `deny`, and remain idempotent across second restore.
      const globalDenyCreated = await fencedState.client.session.create({
        query: { directory: root },
        body: {
          title: 'f4-global-deny',
          permission: [{ permission: '*', pattern: '*', action: 'deny' }],
        },
        throwOnError: true,
      });
      const globalDenyId = globalDenyCreated.data.id;
      await guardedProvider.createSession({
        sessionKey: 'f4-global-deny-1',
        sessionName: 'f4-global-deny-1',
        cwd: root,
        skipCreate: true,
        resumeId: globalDenyId,
      });
      const gdState1 = ((guardedProvider as any).v1Delegate as any).sessions.get('f4-global-deny-1');
      await gdState1.client.session.prompt({
        path: { id: globalDenyId },
        query: { directory: root },
        body: { noReply: true, parts: [{ type: 'text', text: 'noop-global-deny' }] },
        throwOnError: true,
      });
      const gdSession1 = await gdState1.client.session.get({ path: { id: globalDenyId }, query: { directory: root } });
      const gdPerms1 = (gdSession1.data?.permission ?? []) as Array<{ permission: string; pattern: string; action: string }>;
      const evalPatternPerm = (list: typeof gdPerms1, tool: string, targetPattern = '*') => {
        for (let i = list.length - 1; i >= 0; i--) {
          const r = list[i]!;
          const matchTool = r.permission === '*' || r.permission === tool;
          const matchPat = r.pattern === '*' || r.pattern === targetPattern || (r.pattern.endsWith('/*') && targetPattern.startsWith(r.pattern.slice(0, -1)));
          if (matchTool && matchPat) return r.action;
        }
        return 'allow';
      };
      expect(evalPatternPerm(gdPerms1, 'bash')).toBe('deny');
      expect(evalPatternPerm(gdPerms1, 'read', '/any/file')).toBe('deny');
      expect(evalPatternPerm(gdPerms1, 'task')).toBe('deny');
      expect(evalPatternPerm(gdPerms1, 'subagent')).toBe('deny');
      // Second restore is idempotent (no duplicated rules appended)
      await guardedProvider.createSession({
        sessionKey: 'f4-global-deny-2',
        sessionName: 'f4-global-deny-2',
        cwd: root,
        skipCreate: true,
        resumeId: globalDenyId,
      });
      const gdSession2 = await gdState1.client.session.get({ path: { id: globalDenyId }, query: { directory: root } });
      expect((gdSession2.data?.permission ?? []).length).toBe(gdPerms1.length);

      // 5. Wildcard-action scoped directory deny (`* /secret/* deny`) + executable `read * allow`:
      //    `/secret/key` MUST stay `deny`, executable `/pub/file` & `bash` MUST hit guard `ask`, `task/subagent` -> `deny`!
      const scopedCreated = await fencedState.client.session.create({
        query: { directory: root },
        body: {
          title: 'f4-scoped-deny',
          permission: [
            { permission: '*', pattern: '/secret/*', action: 'deny' },
            { permission: 'read', pattern: '*', action: 'allow' },
          ],
        },
        throwOnError: true,
      });
      const scopedId = scopedCreated.data.id;
      await guardedProvider.createSession({
        sessionKey: 'f4-scoped-1',
        sessionName: 'f4-scoped-1',
        cwd: root,
        skipCreate: true,
        resumeId: scopedId,
      });
      const scState1 = ((guardedProvider as any).v1Delegate as any).sessions.get('f4-scoped-1');
      await scState1.client.session.prompt({
        path: { id: scopedId },
        query: { directory: root },
        body: { noReply: true, parts: [{ type: 'text', text: 'noop-scoped-deny' }] },
        throwOnError: true,
      });
      const scSession1 = await scState1.client.session.get({ path: { id: scopedId }, query: { directory: root } });
      const scPerms1 = (scSession1.data?.permission ?? []) as Array<{ permission: string; pattern: string; action: string }>;
      expect(evalPatternPerm(scPerms1, 'bash', '/pub/cmd')).toBe('ask');
      expect(evalPatternPerm(scPerms1, 'task')).toBe('deny');
      expect(evalPatternPerm(scPerms1, 'subagent')).toBe('deny');
      // Verify ordered replay preserves `* /secret/* deny` vs `read * allow->ask` exactly as original:
      // Note original had `* /secret/* deny` BEFORE `read * allow`, so `read` on `/secret/k` matched `read * allow`->`ask`
      // while `bash`/`edit`/`write` on `/secret/k` MUST remain `deny` (and `read` on `/pub/a` is `ask`)!
      expect(evalPatternPerm(scPerms1, 'edit', '/secret/key')).toBe('deny');
      expect(evalPatternPerm(scPerms1, 'bash', '/secret/key')).toBe('deny');
      expect(evalPatternPerm(scPerms1, 'read', '/pub/file')).toBe('ask');
      // Reverse order (`read * allow` BEFORE `* /secret/* deny`): BOTH `read` AND `edit` on `/secret/key` stay `deny`!
      const revCreated = await fencedState.client.session.create({
        query: { directory: root },
        body: {
          title: 'f4-rev-scoped',
          permission: [
            { permission: 'read', pattern: '*', action: 'allow' },
            { permission: '*', pattern: '/secret/*', action: 'deny' },
          ],
        },
        throwOnError: true,
      });
      await guardedProvider.createSession({
        sessionKey: 'f4-rev-1',
        sessionName: 'f4-rev-1',
        cwd: root,
        skipCreate: true,
        resumeId: revCreated.data.id,
      });
      const revSession = await scState1.client.session.get({ path: { id: revCreated.data.id }, query: { directory: root } });
      const revPerms = (revSession.data?.permission ?? []) as Array<{ permission: string; pattern: string; action: string }>;
      expect(evalPatternPerm(revPerms, 'read', '/secret/key')).toBe('deny');
      expect(evalPatternPerm(revPerms, 'edit', '/secret/key')).toBe('deny');
      expect(evalPatternPerm(revPerms, 'read', '/pub/file')).toBe('ask');
      // Idempotent second restore
      await guardedProvider.createSession({
        sessionKey: 'f4-rev-2',
        sessionName: 'f4-rev-2',
        cwd: root,
        skipCreate: true,
        resumeId: revCreated.data.id,
      });
      const revSession2 = await scState1.client.session.get({ path: { id: revCreated.data.id }, query: { directory: root } });
      expect((revSession2.data?.permission ?? []).length).toBe(revPerms.length);
      await guardedProvider.disconnect();

      // 6. Verify v2 mergeOpenCodeFencedPermissions preserves `*/* deny` & `* /secret/* deny` & turns `allow` -> `ask`
      const v2UpdatedPermissions: Array<Array<{ action: string; resource: string; effect: string }>> = [];
      let v2RestoreCase: 'global-deny' | 'scoped-ordered' = 'global-deny';
      openCodeSdkRuntimeHooks.start = vi.fn(async (opts) => {
        const q = createAsyncQueue<Record<string, any>>();
        opts.signal.addEventListener('abort', q.close, { once: true });
        return {
          client: {
            sessions: {
              create: vi.fn(async () => ({ id: 'ses-v2-f4' })),
              get: vi.fn(async () => ({
                id: 'ses-v2-f4',
                permissions: v2RestoreCase === 'global-deny'
                  ? [{ action: '*', resource: '*', effect: 'deny' }]
                  : [{ action: 'read', resource: '*', effect: 'allow' }, { action: '*', resource: '/secret/*', effect: 'deny' }],
              })),
              prompt: vi.fn(async () => ({})),
            },
            session: {
              update: vi.fn(async ({ permissions }: any) => {
                v2UpdatedPermissions.push(permissions);
              }),
              switchModel: vi.fn(async () => ({})),
              interrupt: vi.fn(async () => ({})),
              message: { get: vi.fn(async () => { const e: any = new Error('404'); e.status = 404; throw e; }) },
            },
            provider: { list: vi.fn(async () => ({ data: [] })) },
            model: { list: vi.fn(async () => ({ data: [] })), default: vi.fn(async () => ({ data: null })) },
            mcp: { add: vi.fn(async () => ({})), list: vi.fn(async () => ({ data: [] })) },
            permission: { reply: vi.fn(async () => ({})) },
            events: { subscribe: vi.fn(async () => ({ stream: q.stream })) },
          } as any,
          server: { url: 'http://127.0.0.1:42999', close: vi.fn(async () => { q.close(); }) },
        };
      });
      const pV2F4 = new OpenCodeSdkProvider();
      pV2F4.setNativeAgentFenceResolver(() => true);
      pV2F4.setToolExecutionGuard(async () => ({ allow: false }));
      await pV2F4.connect({});
      await pV2F4.createSession({ sessionKey: 'v2-gd', cwd: root, skipCreate: true, resumeId: 'ses-v2-f4' });
      expect(v2UpdatedPermissions[0]).toEqual([
        { action: '*', resource: '*', effect: 'ask' },
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'subagent', resource: '*', effect: 'deny' },
      ]);
      v2RestoreCase = 'scoped-ordered';
      await pV2F4.createSession({ sessionKey: 'v2-sc', cwd: root, skipCreate: true, resumeId: 'ses-v2-f4' });
      expect(v2UpdatedPermissions[1]).toEqual([
        { action: '*', resource: '*', effect: 'ask' },
        { action: 'read', resource: '*', effect: 'ask' },
        { action: '*', resource: '/secret/*', effect: 'deny' },
        { action: 'subagent', resource: '*', effect: 'deny' },
      ]);
      await pV2F4.disconnect();
    } finally {
      for (const [k, v] of Object.entries(prevXdg)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 45_000);

  it('graduates free-limit-only embedded sessions to installed v1/v2 CLI while keeping completed history and accurate fallback hint', async () => {
    const root = mkTemp('oc-grad-');
    const stateHome = join(root, 'imcodes-state');
    const xdgData = join(root, 'xdg-data');
    mkdirSync(stateHome, { recursive: true });
    mkdirSync(xdgData, { recursive: true });
    process.env.IMCODES_HOME = stateHome;
    process.env.XDG_DATA_HOME = xdgData;

    const { DatabaseSync } = await import('node:sqlite');
    const embDbPath = join(stateHome, 'opencode-sdk.db');

    // Seed real embedded DB via embedded provider first so exact schema (session_v2 / session_message) matches runtime.
    const pSeed = new OpenCodeSdkProvider();
    let freeLimitOnlyId = '';
    let completedWithFreeLimitId = '';
    let userOnlyId = '';
    const seededIds: string[] = [];
    pSeed.onSessionInfo((_sid, info) => {
      if (info.resumeId) seededIds.push(info.resumeId);
    });
    await pSeed.connect({ transport: 'embedded', cwd: root } as any);
    await pSeed.createSession({ sessionKey: 'seed-free-only', cwd: root });
    freeLimitOnlyId = seededIds.at(-1)!;
    await pSeed.createSession({ sessionKey: 'seed-completed', cwd: root });
    completedWithFreeLimitId = seededIds.at(-1)!;
    await pSeed.createSession({ sessionKey: 'seed-user-only', cwd: root });
    userOnlyId = seededIds.at(-1)!;
    await pSeed.disconnect();

    const db = new DatabaseSync(embDbPath);
    const now = Date.now();
    const nextSeq = (sid: string): number => Number(
      (db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM session_message WHERE session_id = ?').get(sid) as { m: number }).m,
    ) + 1;
    // 1a. free-limit-only session_v2: user prompt + failed assistant (provider.free-limit) + failed outcome
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('sm_fl_1', freeLimitOnlyId, 'user', nextSeq(freeLimitOnlyId), now + 10, now + 10, JSON.stringify({ text: 'hi' }));
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('sm_fl_2', freeLimitOnlyId, 'assistant', nextSeq(freeLimitOnlyId), now + 20, now + 20, JSON.stringify({
      finish: 'error',
      content: [],
      error: { type: 'provider.free-limit', message: 'Free usage limit reached.' },
    }));
    // Malformed non-JSON row must not throw or corrupt classification
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('sm_fl_bad', freeLimitOnlyId, 'outcome', nextSeq(freeLimitOnlyId), now + 30, now + 30, '{not-valid-json');
    db.prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?').run(now + 30, freeLimitOnlyId);

    // 1b. completed assistant turn PLUS later free-limit error -> MUST NOT graduate!
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('sm_comp_1', completedWithFreeLimitId, 'user', nextSeq(completedWithFreeLimitId), now + 10, now + 10, JSON.stringify({ text: 'hello' }));
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('sm_comp_2', completedWithFreeLimitId, 'assistant', nextSeq(completedWithFreeLimitId), now + 20, now + 20, JSON.stringify({
      finish: 'stop',
      content: [{ type: 'text', text: 'Working answer' }],
    }));
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('sm_comp_3', completedWithFreeLimitId, 'assistant', nextSeq(completedWithFreeLimitId), now + 30, now + 30, JSON.stringify({
      finish: 'error',
      content: [],
      error: { type: 'provider.free-limit', message: 'Free usage limit reached.' },
    }));
    db.prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?').run(now + 30, completedWithFreeLimitId);

    // 1c. user/malformed-only session with NO free-limit error -> MUST NOT graduate!
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('sm_usr_1', userOnlyId, 'user', nextSeq(userOnlyId), now + 10, now + 10, JSON.stringify({ text: 'draft only' }));
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('sm_usr_bad', userOnlyId, 'assistant', nextSeq(userOnlyId), now + 20, now + 20, 'corrupt-json');
    db.close();

    // Verify legacy `session` + `message` SQLite schema classification too
    const v1ShapeDbPath = join(root, 'legacy-shape.db');
    const v1ShapeDb = new DatabaseSync(v1ShapeDbPath);
    v1ShapeDb.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    v1ShapeDb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run('ses_leg_fl', root, 'leg-fl', now, now + 10);
    v1ShapeDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'm_leg_fl', 'ses_leg_fl', now + 10, now + 10, JSON.stringify({ role: 'assistant', finish: 'error', error: { message: 'Free usage limit reached.' } }),
    );
    v1ShapeDb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run('ses_leg_ok', root, 'leg-ok', now, now + 20);
    v1ShapeDb.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'm_leg_ok', 'ses_leg_ok', now + 15, now + 15, JSON.stringify({ role: 'assistant', finish: 'stop' }),
    );
    v1ShapeDb.close();

    // Acceptance 1 assertions
    const snapFreeOnly = await inspectOpenCodeSqliteSession(freeLimitOnlyId, [embDbPath]);
    expect(snapFreeOnly).toMatchObject({ hasCompletedAssistantTurn: false, hasFreeLimitError: true });
    expect(isRecoverableFreeLimitOnlyEmbeddedSession(snapFreeOnly)).toBe(true);

    const snapCompleted = await inspectOpenCodeSqliteSession(completedWithFreeLimitId, [embDbPath]);
    expect(snapCompleted).toMatchObject({ hasCompletedAssistantTurn: true, hasFreeLimitError: true });
    expect(isRecoverableFreeLimitOnlyEmbeddedSession(snapCompleted)).toBe(false);

    const snapUserOnly = await inspectOpenCodeSqliteSession(userOnlyId, [embDbPath]);
    expect(snapUserOnly).toMatchObject({ hasCompletedAssistantTurn: false, hasFreeLimitError: false });
    expect(isRecoverableFreeLimitOnlyEmbeddedSession(snapUserOnly)).toBe(false);

    expect(await inspectOpenCodeSqliteSession('ses_does_not_exist', [embDbPath])).toBeNull();
    expect(isRecoverableFreeLimitOnlyEmbeddedSession(null)).toBe(false);

    expect(isRecoverableFreeLimitOnlyEmbeddedSession(await inspectOpenCodeSqliteSession('ses_leg_fl', [v1ShapeDbPath]))).toBe(true);
    expect(isRecoverableFreeLimitOnlyEmbeddedSession(await inspectOpenCodeSqliteSession('ses_leg_ok', [v1ShapeDbPath]))).toBe(false);

    // Acceptance 2 + 4 + 5 + stale-route Boundary under v1-cli
    const v1Bin = makeFakeExecutable(join(root, 'v1grad'), 'opencode', '#!/bin/sh\necho "1.18.4"\n');
    const v1Q = createAsyncQueue<Record<string, any>>();
    let v1CreateSeq = 0;
    const v1Prompts: Array<{ sessionID: string; text: string }> = [];
    const v1CreatedIds: string[] = [];
    openCodeV1RuntimeHooks.start = vi.fn(async (opts) => {
      opts.signal.addEventListener('abort', v1Q.close, { once: true });
      return {
        client: {
          session: {
            create: vi.fn(async () => {
              const id = `ses-v1-grad-${++v1CreateSeq}`;
              v1CreatedIds.push(id);
              return { data: { id } };
            }),
            get: vi.fn(async () => {
              const err: any = new Error('404 session not found');
              err.status = 404;
              throw err;
            }),
            list: vi.fn(async () => ({ data: [] })),
            message: vi.fn(async () => ({ data: null })),
            messages: vi.fn(async () => ({ data: [] })),
            prompt: vi.fn(async () => ({ data: {} })),
            promptAsync: vi.fn(async (req: any) => {
              v1Prompts.push({ sessionID: req?.path?.id ?? req?.sessionID, text: req?.body?.parts?.[0]?.text ?? '' });
              return { data: undefined };
            }),
            abort: vi.fn(async () => ({ data: true })),
          },
          provider: { list: vi.fn(async () => ({ data: { connected: [], all: [], default: {} } })) },
          event: { subscribe: vi.fn(async () => ({ stream: v1Q.stream })) },
          postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
        } as any,
        server: { url: 'http://127.0.0.1:42019', close: vi.fn(async () => { v1Q.close(); }) },
      };
    });

    const pV1Grad = new OpenCodeSdkProvider();
    const v1Infos: Array<{ sid: string; resumeId?: string; owner?: string }> = [];
    const v1Errors: Array<{ sid: string; code: string; message: string }> = [];
    pV1Grad.onSessionInfo((sid, info) => v1Infos.push({ sid, resumeId: info.resumeId, owner: info.openCodeStorageOwner }));
    pV1Grad.onError((sid, err) => v1Errors.push({ sid, code: err.code, message: err.message }));
    await pV1Grad.connect({ binaryPath: v1Bin, cwd: root } as any);

    // 2a. Free-limit-only restoreSession + createSession (unowned AND openCodeStorageOwner='embedded') graduate cleanly WITHOUT embeddedFallbackDelegate!
    expect(await pV1Grad.restoreSession(freeLimitOnlyId)).toBe(true);
    expect((pV1Grad as any).embeddedFallbackDelegate).toBeNull();

    await pV1Grad.createSession({
      sessionKey: 'v1-grad-unowned',
      cwd: root,
      skipCreate: true,
      resumeId: freeLimitOnlyId,
    });
    expect(v1Infos.at(-1)).toMatchObject({ sid: 'v1-grad-unowned', resumeId: 'ses-v1-grad-1', owner: 'v1-cli' });
    expect((pV1Grad as any).embeddedFallbackDelegate).toBeNull();

    await pV1Grad.createSession({
      sessionKey: 'v1-grad-owned',
      cwd: root,
      skipCreate: true,
      resumeId: freeLimitOnlyId,
      openCodeStorageOwner: 'embedded',
    });
    expect(v1Infos.at(-1)).toMatchObject({ sid: 'v1-grad-owned', resumeId: 'ses-v1-grad-2', owner: 'v1-cli' });
    expect((pV1Grad as any).embeddedFallbackDelegate).toBeNull();

    // 5. Missing openCodeStorageOwner='embedded' STILL fails with SESSION_NOT_FOUND
    await expect(pV1Grad.createSession({
      sessionKey: 'v1-missing-emb',
      cwd: root,
      skipCreate: true,
      resumeId: 'ses_missing_emb_xyz',
      openCodeStorageOwner: 'embedded',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });

    // 4 & Boundary: Restore completed-history embedded session on route 'v1-sticky-route' -> uses embeddedFallbackDelegate,
    // emits legacy-embedded-session guidance on free-limit error (NOT "Install the official OpenCode CLI"),
    // then re-restoring 'v1-sticky-route' with freeLimitOnlyId clears embeddedFallbackRoutes so send/setSessionAgentId/endSession hit v1Delegate!
    await pV1Grad.createSession({
      sessionKey: 'v1-sticky-route',
      cwd: root,
      skipCreate: true,
      resumeId: completedWithFreeLimitId,
      openCodeStorageOwner: 'embedded',
    });
    expect(v1Infos.at(-1)).toMatchObject({ sid: 'v1-sticky-route', resumeId: completedWithFreeLimitId, owner: 'embedded' });
    const fbDelegate = (pV1Grad as any).embeddedFallbackDelegate as OpenCodeSdkProvider;
    expect(fbDelegate).toBeTruthy();
    expect(((pV1Grad as any).embeddedFallbackRoutes as Set<string>).has('v1-sticky-route')).toBe(true);

    // Trigger free-limit error inside cliEmbeddedFallback delegate via send error path
    const fbState = (fbDelegate as any).sessions.get('v1-sticky-route');
    const origFbPrompt = fbState.client.sessions.prompt;
    fbState.client.sessions.prompt = vi.fn(async () => {
      throw Object.assign(new Error('Free usage limit reached.'), { type: 'provider.free-limit', status: 429 });
    });
    const fbErr = await pV1Grad.send('v1-sticky-route', 'test hint').catch((e) => e);
    expect(fbErr).toMatchObject({
      code: PROVIDER_ERROR_CODES.RATE_LIMITED,
    });
    expect(fbErr.message).toContain('This legacy session is bound to embedded storage.');
    expect(fbErr.message).not.toContain('Install the official OpenCode CLI');
    expect(v1Errors).toEqual([]);
    fbState.client.sessions.prompt = origFbPrompt;

    // Now re-restore the same routeKey with freeLimitOnlyId -> MUST graduate AND clear embeddedFallbackRoutes!
    await pV1Grad.createSession({
      sessionKey: 'v1-sticky-route',
      cwd: root,
      skipCreate: true,
      resumeId: freeLimitOnlyId,
      openCodeStorageOwner: 'embedded',
    });
    expect(v1Infos.at(-1)).toMatchObject({ sid: 'v1-sticky-route', resumeId: 'ses-v1-grad-3', owner: 'v1-cli' });
    expect(((pV1Grad as any).embeddedFallbackRoutes as Set<string>).has('v1-sticky-route')).toBe(false);

    pV1Grad.setSessionAgentId('v1-sticky-route', 'opencode/big-pickle');
    await pV1Grad.send('v1-sticky-route', 'hello graduated v1');
    expect(v1Prompts.some((p) => p.sessionID === 'ses-v1-grad-3' && p.text.includes('hello graduated v1'))).toBe(true);
    await pV1Grad.endSession('v1-sticky-route');
    await pV1Grad.disconnect();

    // Verify pure embedded mode (no active CLI) STILL keeps original "Install the official OpenCode CLI" hint
    const pPureEmb = new OpenCodeSdkProvider();
    const pureErrors: string[] = [];
    pPureEmb.onError((_sid, err) => pureErrors.push(err.message));
    await pPureEmb.connect({ transport: 'embedded', databasePath: embDbPath, cwd: root } as any);
    await pPureEmb.createSession({ sessionKey: 'pure-emb-route', cwd: root });
    const pureState = (pPureEmb as any).sessions.get('pure-emb-route');
    pureState.client.sessions.prompt = vi.fn(async () => {
      throw Object.assign(new Error('Free usage limit reached.'), { type: 'provider.free-limit', status: 429 });
    });
    const pureErr = await pPureEmb.send('pure-emb-route', 'pure prompt').catch((e) => e);
    expect(pureErr).toMatchObject({
      code: PROVIDER_ERROR_CODES.RATE_LIMITED,
    });
    expect(pureErr.message).toContain('Install the official OpenCode CLI (`opencode`)');
    expect(pureErrors).toEqual([]);

    // Boundary: explicit transport='embedded' NEVER graduates freeLimitOnlyId even though it has free-limit-only history!
    const pureInfos: Array<{ sid: string; resumeId?: string; owner?: string }> = [];
    pPureEmb.onSessionInfo((sid, info) => pureInfos.push({ sid, resumeId: info.resumeId, owner: info.openCodeStorageOwner }));
    await pPureEmb.createSession({
      sessionKey: 'pure-emb-stay',
      cwd: root,
      skipCreate: true,
      resumeId: freeLimitOnlyId,
      openCodeStorageOwner: 'embedded',
    });
    expect(pureInfos.at(-1)).toMatchObject({ sid: 'pure-emb-stay', resumeId: freeLimitOnlyId, owner: 'embedded' });
    await pPureEmb.disconnect();

    // Acceptance 3 & 4 under v2-cli (mock v2 HTTP server)
    const v2GradLog = join(root, 'v2-grad.log');
    writeFileSync(v2GradLog, '', 'utf8');
    process.env.V2_GRAD_LOG = v2GradLog;
    const v2GradScript = join(root, 'v2-grad-host.mjs');
    writeFileSync(v2GradScript, `
      import http from 'node:http';
      import { appendFileSync } from 'node:fs';
      if (process.argv.includes('--version')) {
        console.log('opencode v2.4.2');
        process.exit(0);
      }
      let seq = 0;
      const logFile = process.env.V2_GRAD_LOG;
      const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
          if (pathname === '/api/info') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: '2.4.2', urls: [] })); return; }
          if (pathname === '/api/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ type: 'server.connected', properties: {} }) + '\\n\\n'); return; }
          if (pathname === '/api/provider') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'opencode', name: 'OpenCode', activation: 'ready' }] })); return; }
          if (pathname === '/api/model') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'opencode/big-pickle', providerID: 'opencode', modelID: 'big-pickle', enabled: true, type: 'chat' }] })); return; }
          if (pathname === '/api/model/default') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { providerID: 'opencode', modelID: 'big-pickle' } })); return; }
          if (pathname === '/api/session' && req.method === 'POST') {
            const id = 'ses-v2-grad-' + (++seq);
            appendFileSync(logFile, JSON.stringify({ op: 'create', id }) + '\\n');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: { id, location: { directory: ${JSON.stringify(root)} } } }));
            return;
          }
          if (pathname.startsWith('/api/session/') && req.method === 'GET') {
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ message: 'Not Found' }));
            return;
          }
          if (pathname.startsWith('/api/experimental/mcp/')) { res.statusCode = 204; res.end(); return; }
          res.setHeader('content-type', 'application/json');
          res.end('{}');
        });
      });
      srv.listen(0, '127.0.0.1', () => { console.log('listening on http://127.0.0.1:' + srv.address().port); });
      process.on('SIGTERM', () => process.exit(0));
    `, 'utf8');
    const v2GradBin = makeFakeExecutable(join(root, 'v2grad'), 'opencode', `#!/bin/sh\nexec "${process.execPath}" "${v2GradScript}" "$@"\n`);

    const pV2Grad = new OpenCodeSdkProvider();
    const v2Infos: Array<{ sid: string; resumeId?: string; owner?: string }> = [];
    pV2Grad.onSessionInfo((sid, info) => v2Infos.push({ sid, resumeId: info.resumeId, owner: info.openCodeStorageOwner }));
    await pV2Grad.connect({ binaryPath: v2GradBin, cwd: root } as any);

    // Both restoreSession and unowned/owned createSession graduate cleanly under v2-cli without embeddedFallbackDelegate
    expect(await pV2Grad.restoreSession(freeLimitOnlyId)).toBe(true);
    expect((pV2Grad as any).embeddedFallbackDelegate).toBeNull();

    await pV2Grad.createSession({
      sessionKey: 'v2-grad-unowned',
      cwd: root,
      skipCreate: true,
      resumeId: freeLimitOnlyId,
    });
    expect(v2Infos.at(-1)).toMatchObject({ sid: 'v2-grad-unowned', resumeId: 'ses-v2-grad-1', owner: 'v2-cli' });
    expect((pV2Grad as any).embeddedFallbackDelegate).toBeNull();

    await pV2Grad.createSession({
      sessionKey: 'v2-grad-owned',
      cwd: root,
      skipCreate: true,
      resumeId: freeLimitOnlyId,
      openCodeStorageOwner: 'embedded',
    });
    expect(v2Infos.at(-1)).toMatchObject({ sid: 'v2-grad-owned', resumeId: 'ses-v2-grad-2', owner: 'v2-cli' });
    expect((pV2Grad as any).embeddedFallbackDelegate).toBeNull();

    // Missing openCodeStorageOwner='embedded' rejects with SESSION_NOT_FOUND under v2-cli too
    await expect(pV2Grad.createSession({
      sessionKey: 'v2-missing-emb',
      cwd: root,
      skipCreate: true,
      resumeId: 'ses_missing_v2_emb',
      openCodeStorageOwner: 'embedded',
    })).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });

    // Completed-history embedded session still stays on embeddedFallbackDelegate under v2-cli
    await pV2Grad.createSession({
      sessionKey: 'v2-keep-emb',
      cwd: root,
      skipCreate: true,
      resumeId: completedWithFreeLimitId,
      openCodeStorageOwner: 'embedded',
    });
    expect(v2Infos.at(-1)).toMatchObject({ sid: 'v2-keep-emb', resumeId: completedWithFreeLimitId, owner: 'embedded' });

    delete process.env.V2_GRAD_LOG;
    await pV2Grad.disconnect();
  }, 45_000);

  it('preserves competing v1/v2 CLI history on unowned free-limit-only embedded collision while still graduating embedded-only sessions', async () => {
    const root = mkTemp('oc-coll-');
    const stateHome = join(root, 'imcodes-state');
    const xdgData = join(root, 'xdg-data');
    const v1DataDir = join(xdgData, 'opencode');
    mkdirSync(stateHome, { recursive: true });
    mkdirSync(v1DataDir, { recursive: true });
    process.env.IMCODES_HOME = stateHome;
    process.env.XDG_DATA_HOME = xdgData;

    const { DatabaseSync } = await import('node:sqlite');
    const embDbPath = join(stateHome, 'opencode-sdk.db');
    const v1DbPath = join(v1DataDir, 'opencode.db');

    const collV1ImportId = 'ses_coll_v1_import';
    const collV1SmallerId = 'ses_coll_v1_smaller';
    const collV1RestoreId = 'ses_coll_v1_restore';
    const collV2LiveId = 'ses_coll_v2_live';
    const collV1LiveId = 'ses_coll_v1_live';
    const pureEmbFreeId = 'ses_pure_emb_grad';

    // Bootstrap exact embedded SQLite schema + valid session rows via embedded OpenCodeSdkProvider
    const pSeed = new OpenCodeSdkProvider();
    const seededIds: string[] = [];
    pSeed.onSessionInfo((_sid, info) => {
      if (info.resumeId) seededIds.push(info.resumeId);
    });
    await pSeed.connect({ transport: 'embedded', cwd: root } as any);
    const seedTargetIds = [collV1ImportId, collV1SmallerId, collV1RestoreId, collV2LiveId, collV1LiveId, pureEmbFreeId];
    for (const targetId of seedTargetIds) {
      await pSeed.createSession({ sessionKey: `seed-${targetId}`, cwd: root });
    }
    await pSeed.disconnect();

    const now = Date.now();
    const embDb = new DatabaseSync(embDbPath);
    const renameEmbSession = (index: number, targetId: string, updatedAt: number): void => {
      const origId = seededIds[index]!;
      embDb.prepare('DELETE FROM session_message WHERE session_id = ?').run(origId);
      embDb.prepare('UPDATE session_v2 SET id = ?, title = ?, time_created = ?, time_updated = ? WHERE id = ?').run(
        targetId, targetId, now - 10_000, updatedAt, origId,
      );
    };
    const insertEmbFreeLimitFailure = (id: string, seqStart: number, retries: number): void => {
      embDb.prepare(
        'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(`${id}_u`, id, 'user', seqStart, now, now, JSON.stringify({ text: 'hi' }));
      for (let i = 0; i < retries; i++) {
        embDb.prepare(
          'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(`${id}_err_${i}`, id, 'assistant', seqStart + 1 + i, now + 10 + i, now + 10 + i, JSON.stringify({
          finish: 'error',
          content: [],
          error: { type: 'provider.free-limit', message: 'Free usage limit reached.' },
        }));
      }
    };

    // Case 1a: embedded has 2 msgs (free-limit-only), v1 DB has 4 valid msgs
    renameEmbSession(0, collV1ImportId, now + 100);
    insertEmbFreeLimitFailure(collV1ImportId, 0, 1);
    // Case 1b: embedded has MORE msgs (5 rows, free-limit-only), v1 DB has 2 valid msgs
    renameEmbSession(1, collV1SmallerId, now + 5_000);
    insertEmbFreeLimitFailure(collV1SmallerId, 0, 4);
    // Case 1c: restoreSession() collision (v2 404 + v1 4 valid msgs + embedded free-limit-only)
    renameEmbSession(2, collV1RestoreId, now + 100);
    insertEmbFreeLimitFailure(collV1RestoreId, 0, 1);
    // Case 2: embedded has MORE msgs (5 rows, free-limit-only), v2 live server has 2 completed msgs
    renameEmbSession(3, collV2LiveId, now + 5_000);
    insertEmbFreeLimitFailure(collV2LiveId, 0, 4);
    // Case 3: embedded has MORE msgs (5 rows, free-limit-only), v1 live server has 2 completed msgs
    renameEmbSession(4, collV1LiveId, now + 5_000);
    insertEmbFreeLimitFailure(collV1LiveId, 0, 4);
    // Case 4 (positive control): ONLY exists in embedded DB as free-limit-only
    renameEmbSession(5, pureEmbFreeId, now + 100);
    insertEmbFreeLimitFailure(pureEmbFreeId, 0, 1);
    embDb.close();

    // Seed v1 SQLite DB with valid history for collV1ImportId (4 msgs) and collV1SmallerId (2 msgs)
    const v1Db = new DatabaseSync(v1DbPath);
    v1Db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    const seedV1Turns = (sid: string, turns: number): void => {
      v1Db.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run(sid, root, sid, now - 5_000, now - 1_000);
      for (let t = 0; t < turns; t++) {
        const uId = `${sid}_m_u_${t}`;
        const aId = `${sid}_m_a_${t}`;
        v1Db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
          uId, sid, now - 4_000 + t * 100, now - 4_000 + t * 100, JSON.stringify({ role: 'user', agent: 'build' }),
        );
        v1Db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
          `${uId}_p`, uId, sid, now - 4_000 + t * 100, now - 4_000 + t * 100, JSON.stringify({ type: 'text', text: `v1 prompt ${t}` }),
        );
        v1Db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
          aId, sid, now - 3_950 + t * 100, now - 3_950 + t * 100, JSON.stringify({ role: 'assistant', agent: 'build', finish: 'stop', time: { completed: now - 3_950 + t * 100 } }),
        );
        v1Db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
          `${aId}_p`, aId, sid, now - 3_950 + t * 100, now - 3_950 + t * 100, JSON.stringify({ type: 'text', text: `v1 reply ${t}` }),
        );
      }
    };
    seedV1Turns(collV1ImportId, 2); // 4 messages total
    seedV1Turns(collV1SmallerId, 1); // 2 messages total (< 5 failed rows in embedded!)
    seedV1Turns(collV1RestoreId, 2); // 4 messages total for restoreSession() check
    v1Db.close();

    // v2 mock server with collV2LiveId pre-populated + stateful /api/experimental/session/import
    const v2CollLog = join(root, 'v2-coll.log');
    writeFileSync(v2CollLog, '', 'utf8');
    process.env.V2_COLL_LOG = v2CollLog;
    const v2CollScript = join(root, 'v2-coll-host.mjs');
    writeFileSync(v2CollScript, `
      import http from 'node:http';
      import { appendFileSync } from 'node:fs';
      if (process.argv.includes('--version')) {
        console.log('opencode v2.4.2');
        process.exit(0);
      }
      let seq = 0;
      const logFile = process.env.V2_COLL_LOG;
      const sessions = new Map([
        [${JSON.stringify(collV2LiveId)}, { id: ${JSON.stringify(collV2LiveId)}, location: { directory: ${JSON.stringify(root)} }, time: { created: ${now - 5000}, updated: ${now - 1000} } }],
      ]);
      const sessionMessages = new Map([
        [${JSON.stringify(collV2LiveId)}, [
          { id: 'v2_live_u1', type: 'user', time: { created: ${now - 4000} } },
          { id: 'v2_live_a1', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'live v2 answer' }], time: { created: ${now - 3000}, completed: ${now - 3000} } },
        ]],
      ]);
      const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
          if (pathname === '/api/info') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: '2.4.2', urls: [] })); return; }
          if (pathname === '/api/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ type: 'server.connected', properties: {} }) + '\\n\\n'); return; }
          if (pathname === '/api/provider') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'opencode', name: 'OpenCode', activation: 'ready' }] })); return; }
          if (pathname === '/api/model') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'opencode/big-pickle', providerID: 'opencode', modelID: 'big-pickle', enabled: true, type: 'chat' }] })); return; }
          if (pathname === '/api/model/default') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { providerID: 'opencode', modelID: 'big-pickle' } })); return; }
          if (pathname === '/api/session' && req.method === 'POST') {
            const id = 'ses-v2-coll-created-' + (++seq);
            sessions.set(id, { id, location: { directory: ${JSON.stringify(root)} }, time: { created: Date.now(), updated: Date.now() } });
            sessionMessages.set(id, []);
            appendFileSync(logFile, JSON.stringify({ op: 'create', id }) + '\\n');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: sessions.get(id) }));
            return;
          }
          if (pathname === '/api/experimental/session/import' && req.method === 'POST') {
            const parsed = JSON.parse(body || '{}');
            const id = parsed?.info?.id;
            const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
            sessions.set(id, { ...parsed.info, location: parsed.location ?? { directory: ${JSON.stringify(root)} } });
            sessionMessages.set(id, msgs);
            appendFileSync(logFile, JSON.stringify({ op: 'import', id, msgCount: msgs.length }) + '\\n');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: sessions.get(id) }));
            return;
          }
          const msgMatch = pathname.match(/^\\/api\\/session\\/([^/]+)\\/message$/);
          if (msgMatch && req.method === 'GET') {
            const sid = decodeURIComponent(msgMatch[1]);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: sessionMessages.get(sid) ?? [] }));
            return;
          }
          const getMatch = pathname.match(/^\\/api\\/session\\/([^/]+)$/);
          if (getMatch && req.method === 'GET') {
            const sid = decodeURIComponent(getMatch[1]);
            if (sessions.has(sid)) {
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ data: sessions.get(sid) }));
            } else {
              res.statusCode = 404;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ message: 'Not Found' }));
            }
            return;
          }
          if (pathname.startsWith('/api/experimental/mcp/')) { res.statusCode = 204; res.end(); return; }
          res.setHeader('content-type', 'application/json');
          res.end('{}');
        });
      });
      srv.listen(0, '127.0.0.1', () => { console.log('listening on http://127.0.0.1:' + srv.address().port); });
      process.on('SIGTERM', () => process.exit(0));
    `, 'utf8');
    const v2CollBin = makeFakeExecutable(join(root, 'v2coll'), 'opencode', `#!/bin/sh\nexec "${process.execPath}" "${v2CollScript}" "$@"\n`);

    const pV2Coll = new OpenCodeSdkProvider();
    const v2Infos: Array<{ sid: string; resumeId?: string; owner?: string }> = [];
    pV2Coll.onSessionInfo((sid, info) => v2Infos.push({ sid, resumeId: info.resumeId, owner: info.openCodeStorageOwner }));
    await pV2Coll.connect({ binaryPath: v2CollBin, cwd: root } as any);

    // 1a. v2 404 + v1 DB has 4 valid records + embedded DB has free-limit-only -> imports v1 DB, preserves collV1ImportId, NO create!
    await pV2Coll.createSession({ sessionKey: 'v2-coll-1', cwd: root, skipCreate: true, resumeId: collV1ImportId });
    expect(v2Infos.at(-1)).toMatchObject({ sid: 'v2-coll-1', resumeId: collV1ImportId, owner: 'v2-cli' });
    let logLines = readFileSync(v2CollLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(logLines).toContainEqual({ op: 'import', id: collV1ImportId, msgCount: 4 });
    expect(logLines.some((e) => e.op === 'create')).toBe(false);

    // 1b. v2 404 + v1 DB has 2 valid records + embedded DB has MORE failed rows (5) -> STILL imports 2 v1 records, NO create!
    await pV2Coll.createSession({ sessionKey: 'v2-coll-1b', cwd: root, skipCreate: true, resumeId: collV1SmallerId });
    expect(v2Infos.at(-1)).toMatchObject({ sid: 'v2-coll-1b', resumeId: collV1SmallerId, owner: 'v2-cli' });
    logLines = readFileSync(v2CollLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(logLines).toContainEqual({ op: 'import', id: collV1SmallerId, msgCount: 2 });
    expect(logLines.some((e) => e.op === 'create')).toBe(false);

    // 1c. restoreSession() under v2-cli (v2 404 + v1 4 valid msgs + embedded free-limit-only) -> imports v1, NO create!
    expect(await pV2Coll.restoreSession(collV1RestoreId)).toBe(true);
    logLines = readFileSync(v2CollLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(logLines).toContainEqual({ op: 'import', id: collV1RestoreId, msgCount: 4 });
    expect(logLines.some((e) => e.op === 'create')).toBe(false);

    // 2. Live v2 has completed turn + embedded has MORE failed rows (5) -> keeps live collV2LiveId, NO create, NO embeddedFallbackDelegate!
    await pV2Coll.createSession({ sessionKey: 'v2-coll-2', cwd: root, skipCreate: true, resumeId: collV2LiveId });
    expect(v2Infos.at(-1)).toMatchObject({ sid: 'v2-coll-2', resumeId: collV2LiveId, owner: 'v2-cli' });
    expect((pV2Coll as any).embeddedFallbackDelegate).toBeNull();
    logLines = readFileSync(v2CollLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(logLines.some((e) => e.op === 'create')).toBe(false);

    // 4a. Positive control under v2-cli: pure embedded free-limit-only still graduates to new CLI ID
    await pV2Coll.createSession({ sessionKey: 'v2-grad-ctrl', cwd: root, skipCreate: true, resumeId: pureEmbFreeId });
    expect(v2Infos.at(-1)).toMatchObject({ sid: 'v2-grad-ctrl', resumeId: 'ses-v2-coll-created-1', owner: 'v2-cli' });
    logLines = readFileSync(v2CollLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(logLines).toContainEqual({ op: 'create', id: 'ses-v2-coll-created-1' });

    delete process.env.V2_COLL_LOG;
    await pV2Coll.disconnect();

    // 3 + 4b. Unowned collision & positive control under v1-cli
    const v1Bin = makeFakeExecutable(join(root, 'v1coll'), 'opencode', '#!/bin/sh\necho "1.18.4"\n');
    const v1Q = createAsyncQueue<Record<string, any>>();
    let v1CreateSeq = 0;
    openCodeV1RuntimeHooks.start = vi.fn(async (opts) => {
      opts.signal.addEventListener('abort', v1Q.close, { once: true });
      return {
        client: {
          session: {
            create: vi.fn(async () => ({ data: { id: `ses-v1-coll-created-${++v1CreateSeq}` } })),
            get: vi.fn(async (req: any) => {
              if (req?.path?.id === collV1LiveId) {
                return { data: { id: collV1LiveId, time: { created: now - 5000, updated: now - 1000 } } };
              }
              const err: any = new Error('404 session not found');
              err.status = 404;
              throw err;
            }),
            list: vi.fn(async () => ({ data: [] })),
            message: vi.fn(async () => ({ data: null })),
            messages: vi.fn(async (req: any) => {
              if (req?.path?.id === collV1LiveId) {
                return {
                  data: [
                    { info: { id: 'v1_m1', role: 'user', time: { created: now - 4000 } }, parts: [] },
                    { info: { id: 'v1_m2', role: 'assistant', finish: 'stop', time: { created: now - 3000, completed: now - 3000 } }, parts: [] },
                  ],
                };
              }
              return { data: [] };
            }),
            prompt: vi.fn(async () => ({ data: {} })),
            promptAsync: vi.fn(async () => ({ data: undefined })),
            abort: vi.fn(async () => ({ data: true })),
          },
          provider: { list: vi.fn(async () => ({ data: { connected: [], all: [], default: {} } })) },
          event: { subscribe: vi.fn(async () => ({ stream: v1Q.stream })) },
          postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
        } as any,
        server: { url: 'http://127.0.0.1:42029', close: vi.fn(async () => { v1Q.close(); }) },
      };
    });

    const pV1Coll = new OpenCodeSdkProvider();
    const v1Infos: Array<{ sid: string; resumeId?: string; owner?: string }> = [];
    pV1Coll.onSessionInfo((sid, info) => v1Infos.push({ sid, resumeId: info.resumeId, owner: info.openCodeStorageOwner }));
    await pV1Coll.connect({ binaryPath: v1Bin, cwd: root } as any);

    await pV1Coll.createSession({ sessionKey: 'v1-coll-live', cwd: root, skipCreate: true, resumeId: collV1LiveId });
    expect(v1Infos.at(-1)).toMatchObject({ sid: 'v1-coll-live', resumeId: collV1LiveId, owner: 'v1-cli' });
    expect(v1CreateSeq).toBe(0);
    expect((pV1Coll as any).embeddedFallbackDelegate).toBeNull();

    await pV1Coll.createSession({ sessionKey: 'v1-grad-ctrl', cwd: root, skipCreate: true, resumeId: pureEmbFreeId });
    expect(v1Infos.at(-1)).toMatchObject({ sid: 'v1-grad-ctrl', resumeId: 'ses-v1-coll-created-1', owner: 'v1-cli' });
    expect(v1CreateSeq).toBe(1);
    expect((pV1Coll as any).embeddedFallbackDelegate).toBeNull();

    await pV1Coll.disconnect();
  }, 45_000);
});
