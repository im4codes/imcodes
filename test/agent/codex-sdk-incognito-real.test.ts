import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { CodexSdkProvider } from '../../src/agent/providers/codex-sdk.js';

const REAL_CODEX_BIN = '/usr/local/bin/codex';

async function collectFilesRecursive(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectFilesRecursive(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

describe.skipIf(!existsSync(REAL_CODEX_BIN))('real codex app-server ephemeral disk isolation', () => {
  it('thread/start with ephemeral:true writes zero rollout files and rejects thread/resume in isolated CODEX_HOME', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-real-codex-incog-'));
    const child = spawn(REAL_CODEX_BIN, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: codexHome },
    });

    const rl = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let nextId = 1;

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: any; error?: { code?: number; message?: string } };
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error(`RPC ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown'}`));
          } else {
            entry.resolve(msg.result);
          }
        }
      } catch {
        // ignore non-JSON diagnostic lines
      }
    });

    const rpc = (method: string, params: Record<string, unknown>) =>
      new Promise<any>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }, 10_000);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    try {
      await rpc('initialize', { clientInfo: { name: 'imcodes-incog-test', version: '1.0.0' } });

      const started = await rpc('thread/start', {
        cwd: '/tmp',
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        personality: 'none',
      });
      const threadId = started?.thread?.id;
      expect(typeof threadId).toBe('string');
      expect(started?.thread?.ephemeral).toBe(true);
      expect(started?.thread?.path ?? null).toBeNull();

      // Resuming an ephemeral thread fails because no rollout exists
      await expect(rpc('thread/resume', { threadId })).rejects.toThrow(/no rollout found for thread id/i);

      await rpc('thread/unsubscribe', { threadId });
      await expect(rpc('thread/resume', { threadId })).rejects.toThrow(/no rollout found for thread id/i);

      // Zero rollout .jsonl files created under isolated CODEX_HOME/sessions
      const sessionFiles = await collectFilesRecursive(join(codexHome, 'sessions'));
      expect(sessionFiles).toEqual([]);
    } finally {
      rl.close();
      child.kill('SIGTERM');
      await rm(codexHome, { recursive: true, force: true });
    }
  }, 20_000);
});

async function setupIsolatedCodexMcpSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-real-codex-mcp-'));
  const codexHome = join(root, 'codex-home');
  const imcodesHome = join(root, 'imcodes-home');
  const binDir = join(root, 'bin');
  const projDir = join(root, 'proj');
  const spawnLog = join(root, 'mcp-spawns.log');
  await mkdir(codexHome, { recursive: true });
  await mkdir(imcodesHome, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(projDir, { recursive: true });

  const fakeMcpScript = join(root, 'fake-imcodes-mcp.mjs');
  await writeFile(
    fakeMcpScript,
    `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const mode = process.argv[2] === 'custom' ? 'custom' : 'memory';
if (mode === 'memory') {
  appendFileSync(${JSON.stringify(spawnLog)}, 'SPAWN:' + process.pid + '\\n');
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') {
    respond({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: mode === 'custom' ? 'fake-custom-mcp' : 'fake-imcodes-memory', version: '1.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    respond({
      tools: [{
        name: mode === 'custom' ? 'custom_probe' : 'privacy_probe',
        description: 'Harmless test fixture tool',
        inputSchema: { type: 'object', properties: {} },
      }],
    });
  } else if (msg.method === 'tools/call') {
    respond({ content: [{ type: 'text', text: mode === 'custom' ? 'custom-only-called' : 'fixture-only-called' }] });
  } else if (msg.id !== undefined) {
    respond({});
  }
});
`,
  );

  const fakeImcodesCli = join(binDir, 'imcodes');
  await writeFile(
    fakeImcodesCli,
    `#!/usr/bin/env sh
if [ "$1" = "memory" ] && [ "$2" = "mcp" ]; then
  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeMcpScript)} memory
fi
exit 1
`,
  );
  await chmod(fakeImcodesCli, 0o755);

  const fakeCustomCli = join(binDir, 'custom-mcp-fixture');
  await writeFile(
    fakeCustomCli,
    `#!/usr/bin/env sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeMcpScript)} custom
`,
  );
  await chmod(fakeCustomCli, 0o755);

  // Configure global imcodes-memory, custom non-memory MCP, and trusted project config
  await mkdir(join(projDir, '.codex'), { recursive: true });
  await writeFile(
    join(codexHome, 'config.toml'),
    `[mcp_servers.imcodes-memory]
command = ${JSON.stringify(fakeImcodesCli)}
args = ["memory", "mcp"]

[mcp_servers.custom-other]
command = ${JSON.stringify(fakeCustomCli)}

[projects.${JSON.stringify(projDir)}]
trust_level = "trusted"
`,
  );
  await writeFile(
    join(projDir, '.codex', 'config.toml'),
    `[mcp_servers.proj-imcodes-memory]
command = "imcodes"
args = ["memory", "mcp"]
`,
  );

  const isolatedPath = `${binDir}:${process.env.PATH ?? ''}`;
  vi.stubEnv('HOME', root);
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('IMCODES_HOME', imcodesHome);
  vi.stubEnv('PATH', isolatedPath);

  const env = {
    HOME: root,
    CODEX_HOME: codexHome,
    IMCODES_HOME: imcodesHome,
    PATH: isolatedPath,
  };

  return {
    root,
    codexHome,
    projDir,
    spawnLog,
    env,
    cleanup: async () => {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!existsSync(REAL_CODEX_BIN))('real CodexSdkProvider imcodes-memory MCP isolation', () => {
  it('normal-first then incognito coexistence keeps imcodes-memory excluded/uncallable on incognito while active on normal', async () => {
    const sandbox = await setupIsolatedCodexMcpSandbox();
    const provider = new CodexSdkProvider();
    try {
      await provider.connect({
        binaryPath: REAL_CODEX_BIN,
        env: sandbox.env,
      });

      const internals = provider as unknown as {
        sessions: Map<string, any>;
        normalChannel: any;
        incognitoChannel: any;
        ensureIncognitoChannelStarted: () => Promise<void>;
        ensureThreadLoaded: (sessionId: string, state: any) => Promise<void>;
        requestOnChannel: (channel: any, method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
      };

      // 1. Start normal session first and prove positive control (imcodes-memory listed + callable)
      await provider.createSession({
        sessionKey: 'real-norm-first',
        sessionName: 'deck_real_norm',
        agentType: 'codex-sdk',
        cwd: sandbox.projDir,
        env: sandbox.env,
      });
      const normState = internals.sessions.get('real-norm-first');
      await internals.ensureThreadLoaded('real-norm-first', normState);
      expect(typeof normState.threadId).toBe('string');

      const normStatus = await internals.requestOnChannel(internals.normalChannel, 'mcpServerStatus/list', {});
      const normMem = (normStatus.data as Array<Record<string, any>>).find((s) => s.name === 'imcodes-memory');
      expect(Object.keys(normMem?.tools ?? {})).toContain('privacy_probe');
      const normCall = await internals.requestOnChannel(internals.normalChannel, 'mcpServer/tool/call', {
        threadId: normState.threadId,
        server: 'imcodes-memory',
        tool: 'privacy_probe',
        arguments: {},
      });
      expect(normCall?.content?.[0]?.text).toBe('fixture-only-called');

      // Record spawns after normal thread established, then start incognito concurrently
      const spawnsBeforeIncog = await readFile(sandbox.spawnLog, 'utf8').catch(() => '');

      await provider.createSession({
        sessionKey: 'real-incog-second',
        sessionName: 'deck_real_incog',
        agentType: 'codex-sdk',
        cwd: sandbox.projDir,
        env: sandbox.env,
        incognito: true,
      });
      await internals.ensureIncognitoChannelStarted();
      const incogState = internals.sessions.get('real-incog-second');
      await internals.ensureThreadLoaded('real-incog-second', incogState);
      expect(typeof incogState.threadId).toBe('string');

      // Incognito must NOT have spawned imcodes-memory MCP process
      const spawnsAfterIncog = await readFile(sandbox.spawnLog, 'utf8').catch(() => '');
      expect(spawnsAfterIncog).toBe(spawnsBeforeIncog);

      // Incognito channel lists zero imcodes-memory tools and fails tool call, while preserving custom-other and blocking trusted project alias
      const incogStatus = await internals.requestOnChannel(internals.incognitoChannel, 'mcpServerStatus/list', {});
      const incogMem = (incogStatus.data as Array<Record<string, any>>).find((s) => s.name === 'imcodes-memory');
      expect(Object.keys(incogMem?.tools ?? {})).toEqual([]);
      expect(incogMem?.serverInfo ?? null).toBeNull();
      const incogCustom = (incogStatus.data as Array<Record<string, any>>).find((s) => s.name === 'custom-other');
      expect(Object.keys(incogCustom?.tools ?? {})).toContain('custom_probe');
      const customCall = await internals.requestOnChannel(internals.incognitoChannel, 'mcpServer/tool/call', {
        threadId: incogState.threadId,
        server: 'custom-other',
        tool: 'custom_probe',
        arguments: {},
      });
      expect(customCall?.content?.[0]?.text).toBe('custom-only-called');
      await expect(
        internals.requestOnChannel(internals.incognitoChannel, 'mcpServer/tool/call', {
          threadId: incogState.threadId,
          server: 'imcodes-memory',
          tool: 'privacy_probe',
          arguments: {},
        }),
      ).rejects.toThrow(/unknown MCP server 'imcodes-memory'/i);
      await expect(
        internals.requestOnChannel(internals.incognitoChannel, 'mcpServer/tool/call', {
          threadId: incogState.threadId,
          server: 'proj-imcodes-memory',
          tool: 'privacy_probe',
          arguments: {},
        }),
      ).rejects.toThrow(/unknown MCP server 'proj-imcodes-memory'|disabled/i);

      // Zero rollout files written for ephemeral incognito thread, and thread/resume refuses it
      await expect(
        internals.requestOnChannel(internals.incognitoChannel, 'thread/resume', { threadId: incogState.threadId }),
      ).rejects.toThrow(/no rollout found for thread id/i);
      const rolloutFilesAfterIncog = (await collectFilesRecursive(join(sandbox.codexHome, 'sessions')))
        .filter((f) => f.includes(incogState.threadId));
      expect(rolloutFilesAfterIncog).toEqual([]);

      // Normal thread remains functional concurrently alongside incognito
      const normCallAfter = await internals.requestOnChannel(internals.normalChannel, 'mcpServer/tool/call', {
        threadId: normState.threadId,
        server: 'imcodes-memory',
        tool: 'privacy_probe',
        arguments: {},
      });
      expect(normCallAfter?.content?.[0]?.text).toBe('fixture-only-called');
    } finally {
      await provider.disconnect().catch(() => {});
      await sandbox.cleanup();
    }
  }, 30_000);

  it('incognito-first then normal order excludes/blocks imcodes-memory for incognito before and after normal recovery', async () => {
    const sandbox = await setupIsolatedCodexMcpSandbox();
    const provider = new CodexSdkProvider();
    try {
      await provider.connect({
        binaryPath: REAL_CODEX_BIN,
        env: sandbox.env,
      });

      const internals = provider as unknown as {
        sessions: Map<string, any>;
        normalChannel: any;
        incognitoChannel: any;
        ensureIncognitoChannelStarted: () => Promise<void>;
        ensureThreadLoaded: (sessionId: string, state: any) => Promise<void>;
        requestOnChannel: (channel: any, method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
      };

      // 1. Start incognito session BEFORE any normal session
      await provider.createSession({
        sessionKey: 'real-incog-first',
        sessionName: 'deck_real_incog_first',
        agentType: 'codex-sdk',
        cwd: sandbox.projDir,
        env: sandbox.env,
        incognito: true,
      });
      await internals.ensureIncognitoChannelStarted();
      const incogState = internals.sessions.get('real-incog-first');
      await internals.ensureThreadLoaded('real-incog-first', incogState);
      expect(typeof incogState.threadId).toBe('string');

      expect(existsSync(sandbox.spawnLog)).toBe(false);
      const incogStatus = await internals.requestOnChannel(internals.incognitoChannel, 'mcpServerStatus/list', {});
      const incogMem = (incogStatus.data as Array<Record<string, any>>).find((s) => s.name === 'imcodes-memory');
      expect(Object.keys(incogMem?.tools ?? {})).toEqual([]);
      await expect(
        internals.requestOnChannel(internals.incognitoChannel, 'mcpServer/tool/call', {
          threadId: incogState.threadId,
          server: 'imcodes-memory',
          tool: 'privacy_probe',
          arguments: {},
        }),
      ).rejects.toThrow(/unknown MCP server 'imcodes-memory'/i);

      // 2. Now start normal session on the same provider -> positive control succeeds
      await provider.createSession({
        sessionKey: 'real-norm-second',
        sessionName: 'deck_real_norm_second',
        agentType: 'codex-sdk',
        cwd: sandbox.projDir,
        env: sandbox.env,
      });
      const normState = internals.sessions.get('real-norm-second');
      await internals.ensureThreadLoaded('real-norm-second', normState);
      expect(typeof normState.threadId).toBe('string');

      const normStatus = await internals.requestOnChannel(internals.normalChannel, 'mcpServerStatus/list', {});
      const normMem = (normStatus.data as Array<Record<string, any>>).find((s) => s.name === 'imcodes-memory');
      expect(Object.keys(normMem?.tools ?? {})).toContain('privacy_probe');
      const normCall = await internals.requestOnChannel(internals.normalChannel, 'mcpServer/tool/call', {
        threadId: normState.threadId,
        server: 'imcodes-memory',
        tool: 'privacy_probe',
        arguments: {},
      });
      expect(normCall?.content?.[0]?.text).toBe('fixture-only-called');

      // 3. Re-verify incognito remains isolated even after normal MCP server is active
      await expect(
        internals.requestOnChannel(internals.incognitoChannel, 'mcpServer/tool/call', {
          threadId: incogState.threadId,
          server: 'imcodes-memory',
          tool: 'privacy_probe',
          arguments: {},
        }),
      ).rejects.toThrow(/unknown MCP server 'imcodes-memory'/i);
    } finally {
      await provider.disconnect().catch(() => {});
      await sandbox.cleanup();
    }
  }, 30_000);

  it('F1-R2: single cwd config/read timeout fails closed without creating a thread and recovers on retry', async () => {
    const sandbox = await setupIsolatedCodexMcpSandbox();
    const provider = new CodexSdkProvider();
    try {
      await provider.connect({
        binaryPath: REAL_CODEX_BIN,
        env: sandbox.env,
      });

      const internals = provider as unknown as {
        sessions: Map<string, any>;
        normalChannel: any;
        incognitoChannel: any;
        ensureIncognitoChannelStarted: () => Promise<void>;
        ensureThreadLoaded: (sessionId: string, state: any) => Promise<void>;
        requestOnChannel: (channel: any, method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
      };

      await provider.createSession({
        sessionKey: 'real-incog-r2',
        sessionName: 'deck_real_incog_r2',
        agentType: 'codex-sdk',
        cwd: sandbox.projDir,
        env: sandbox.env,
        incognito: true,
      });
      await internals.ensureIncognitoChannelStarted();
      const incogState = internals.sessions.get('real-incog-r2');

      // Inject ONE timeout rejection on private cwd config/read while leaving everything else on real codex 0.163.0
      const origRequestOnChannel = internals.requestOnChannel.bind(provider);
      let injectedTimeout = false;
      internals.requestOnChannel = (channel: any, method: string, params: Record<string, unknown>, timeoutMs?: number) => {
        if (!injectedTimeout && channel.kind === 'incognito' && method === 'config/read' && params?.cwd === sandbox.projDir) {
          injectedTimeout = true;
          return Promise.reject(new Error(`Codex app-server request timeout: ${method}`));
        }
        return origRequestOnChannel(channel, method, params, timeoutMs);
      };

      await expect(internals.ensureThreadLoaded('real-incog-r2', incogState)).rejects.toThrow(/timeout/i);
      expect(injectedTimeout).toBe(true);
      expect(incogState.threadId).toBeUndefined();
      expect(incogState.loaded).toBe(false);
      expect(existsSync(sandbox.spawnLog)).toBe(false);

      // Next call must retry cwd config/read (not skip permanently) and block both global + proj memory MCP
      await internals.ensureThreadLoaded('real-incog-r2', incogState);
      expect(typeof incogState.threadId).toBe('string');
      expect(existsSync(sandbox.spawnLog)).toBe(false);

      await expect(
        internals.requestOnChannel(internals.incognitoChannel, 'mcpServer/tool/call', {
          threadId: incogState.threadId,
          server: 'imcodes-memory',
          tool: 'privacy_probe',
          arguments: {},
        }),
      ).rejects.toThrow(/unknown MCP server 'imcodes-memory'/i);
      await expect(
        internals.requestOnChannel(internals.incognitoChannel, 'mcpServer/tool/call', {
          threadId: incogState.threadId,
          server: 'proj-imcodes-memory',
          tool: 'privacy_probe',
          arguments: {},
        }),
      ).rejects.toThrow(/unknown MCP server 'proj-imcodes-memory'|disabled/i);

      const customCall = await internals.requestOnChannel(internals.incognitoChannel, 'mcpServer/tool/call', {
        threadId: incogState.threadId,
        server: 'custom-other',
        tool: 'custom_probe',
        arguments: {},
      });
      expect(customCall?.content?.[0]?.text).toBe('custom-only-called');

      // Normal positive control remains active
      await provider.createSession({
        sessionKey: 'real-norm-r2',
        sessionName: 'deck_real_norm_r2',
        agentType: 'codex-sdk',
        cwd: sandbox.projDir,
        env: sandbox.env,
      });
      const normState = internals.sessions.get('real-norm-r2');
      await internals.ensureThreadLoaded('real-norm-r2', normState);
      const normCall = await internals.requestOnChannel(internals.normalChannel, 'mcpServer/tool/call', {
        threadId: normState.threadId,
        server: 'imcodes-memory',
        tool: 'privacy_probe',
        arguments: {},
      });
      expect(normCall?.content?.[0]?.text).toBe('fixture-only-called');
    } finally {
      await provider.disconnect().catch(() => {});
      await sandbox.cleanup();
    }
  }, 30_000);

  it('F2: routes setServiceTier to incognitoChannel for incognito threads and normalChannel for normal threads on real codex', async () => {
    const sandbox = await setupIsolatedCodexMcpSandbox();
    const provider = new CodexSdkProvider();
    try {
      await provider.connect({
        binaryPath: REAL_CODEX_BIN,
        env: sandbox.env,
      });

      const internals = provider as unknown as {
        sessions: Map<string, any>;
        requestOnChannel: (channel: any, method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
      };

      await provider.createSession({
        sessionKey: 'real-norm-tier',
        sessionName: 'deck_real_norm_tier',
        agentType: 'codex-sdk',
        cwd: sandbox.projDir,
        env: sandbox.env,
      });
      await provider.createSession({
        sessionKey: 'real-incog-tier',
        sessionName: 'deck_real_incog_tier',
        agentType: 'codex-sdk',
        cwd: sandbox.projDir,
        env: sandbox.env,
        incognito: true,
      });

      const origRequestOnChannel = internals.requestOnChannel.bind(provider);
      const settingsCalls: Array<{ channel: string; threadId: unknown; serviceTier: unknown }> = [];
      internals.requestOnChannel = (channel: any, method: string, params: Record<string, unknown>, timeoutMs?: number) => {
        if (method === 'thread/settings/update') {
          settingsCalls.push({
            channel: channel.kind,
            threadId: params.threadId,
            serviceTier: params.serviceTier,
          });
          return Promise.resolve({});
        }
        return origRequestOnChannel(channel, method, params, timeoutMs);
      };

      await provider.setServiceTier('real-incog-tier', 'fast');
      await provider.setServiceTier('real-norm-tier', 'standard');

      const incogThreadId = internals.sessions.get('real-incog-tier')?.threadId;
      const normThreadId = internals.sessions.get('real-norm-tier')?.threadId;
      expect(typeof incogThreadId).toBe('string');
      expect(typeof normThreadId).toBe('string');
      expect(settingsCalls).toEqual([
        { channel: 'incognito', threadId: incogThreadId, serviceTier: 'fast' },
        { channel: 'normal', threadId: normThreadId, serviceTier: 'standard' },
      ]);
    } finally {
      await provider.disconnect().catch(() => {});
      await sandbox.cleanup();
    }
  }, 30_000);
});
