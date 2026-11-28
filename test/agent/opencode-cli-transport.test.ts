import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPENCODE_TRANSPORT_MODES,
  classifyOpenCodeVersion,
  isLoopbackHostname,
  probeOpenCodeCli,
  redactSecretText,
  resetOpenCodeCliCache,
  resolveOpenCodeCliBinary,
  resolveOpenCodeTransport,
  startOpenCodeV2CliHost,
} from '../../src/agent/providers/opencode-cli.js';
import { openCodeV1RuntimeHooks } from '../../src/agent/providers/opencode-v1-compat.js';
import { OpenCodeSdkProvider } from '../../src/agent/providers/opencode-sdk.js';
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
  const savedEnv: Record<string, string | undefined> = {};

  function mkTemp(prefix = 'oc-cli-test-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    resetOpenCodeCliCache();
    for (const key of ['OPENCODE_BIN', 'IMCODES_OPENCODE_DB_PATH', 'IMCODES_OPENCODE_TRANSPORT']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    openCodeV1RuntimeHooks.start = originalV1Start;
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
    expect(first).toEqual({ binaryPath: bin, version: '1.18.4', major: 1, family: 'v1' });
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
          if (req.url === '/server/info') {
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
});
