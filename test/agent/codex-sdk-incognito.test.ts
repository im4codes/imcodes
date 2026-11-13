import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

interface FakeChild {
  args: string[];
  child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; killed: boolean; kill: () => boolean };
  requests: Array<{ id?: number; method?: string; params?: Record<string, any> }>;
  emits: (message: Record<string, unknown>) => void;
}

const appServer = vi.hoisted(() => {
  const children: FakeChild[] = [];
  let threadCounter = 0;
  let turnCounter = 0;
  let mcpStatusListCalls = 0;
  let configReadHandler:
    | ((params: Record<string, any> | undefined, spawnArgs: readonly string[]) => Record<string, any> | Promise<Record<string, any>>)
    | undefined;
  let threadStartIdOverride: ((spawnArgs: readonly string[], params: Record<string, any> | undefined) => string | undefined) | undefined;
  let turnStartErrorHandler:
    | ((spawnArgs: readonly string[], params: Record<string, any> | undefined, record: FakeChild) => { code?: number; message: string } | undefined)
    | undefined;
  const spawn = vi.fn((_cmd: unknown, spawnArgs: readonly string[] = []) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let record!: FakeChild;
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as FakeChild['requests'][number];
          record.requests.push(message);
          if (typeof message.id !== 'number') continue;
          if (message.method === 'initialize') {
            record.emits({ id: message.id, result: { userAgent: 'codex-test' } });
          } else if (message.method === 'config/read') {
            Promise.resolve(configReadHandler ? configReadHandler(message.params, spawnArgs) : { mcp_servers: {} })
              .then((payload) => {
                if (payload && '__rawResult' in payload) {
                  record.emits({ id: message.id, result: (payload as { __rawResult: unknown }).__rawResult });
                } else if (payload && '__rpcError' in payload) {
                  record.emits({ id: message.id, error: (payload as { __rpcError: unknown }).__rpcError });
                } else if (payload && '__dropNoReply' in payload) {
                  // simulate hang/timeout
                } else {
                  record.emits({ id: message.id, result: { config: payload } });
                }
              })
              .catch((err) => {
                record.emits({ id: message.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
              });
          } else if (message.method === 'thread/start') {
            threadCounter += 1;
            const threadId = threadStartIdOverride?.(spawnArgs, message.params) ?? `thread-${threadCounter}`;
            const ephemeral = message.params?.ephemeral === true;
            record.emits({
              id: message.id,
              result: { thread: { id: threadId, ephemeral, path: ephemeral ? null : `/tmp/${threadId}.jsonl` } },
            });
            record.emits({
              method: 'thread/started',
              params: { thread: { id: threadId, ephemeral, path: ephemeral ? null : `/tmp/${threadId}.jsonl` } },
            });
          } else if (message.method === 'thread/resume') {
            const threadId = String(message.params?.threadId ?? 'thread-1');
            record.emits({ id: message.id, result: { thread: { id: threadId } } });
          } else if (message.method === 'turn/start') {
            const customErr = turnStartErrorHandler?.(spawnArgs, message.params, record);
            if (customErr) {
              record.emits({ id: message.id, error: customErr });
              continue;
            }
            turnCounter += 1;
            record.emits({
              id: message.id,
              result: { turn: { id: `turn-${turnCounter}`, status: 'inProgress', items: [], error: null } },
            });
          } else if (message.method === 'thread/settings/update') {
            record.emits({ id: message.id, result: {} });
          } else if (message.method === 'mcpServerStatus/list') {
            mcpStatusListCalls += 1;
            record.emits({ id: message.id, error: { message: 'no mcp in test' } });
          } else if (message.method === 'config/mcpServer/reload') {
            record.emits({ id: message.id, result: {} });
          } else if (message.method === 'thread/unsubscribe') {
            record.emits({ id: message.id, result: { status: 'unsubscribed' } });
          } else if (message.method === 'turn/interrupt' || message.method === 'thread/compact/start') {
            record.emits({ id: message.id, result: {} });
          }
        }
        callback();
      },
    });
    const child = new EventEmitter() as FakeChild['child'];
    Object.assign(child, { stdout, stderr, stdin, killed: false });
    child.kill = () => {
      child.killed = true;
      child.emit('exit', 0);
      return true;
    };
    record = {
      args: [...spawnArgs],
      child,
      requests: [],
      emits: (message) => {
        stdout.write(`${JSON.stringify(message)}\n`);
      },
    };
    children.push(record);
    return child;
  });
  const execFile = vi.fn((...args: unknown[]) => {
    const callback = (typeof args[2] === 'function' ? args[2] : args[3]) as
      | ((e: Error | null, out: string, err: string) => void)
      | undefined;
    callback?.(null, 'ok\n', '');
    return {} as never;
  });
  return {
    children,
    spawn,
    execFile,
    getMcpStatusListCalls: () => mcpStatusListCalls,
    setConfigReadHandler: (fn: typeof configReadHandler) => {
      configReadHandler = fn;
    },
    setThreadStartIdOverride: (fn: typeof threadStartIdOverride) => {
      threadStartIdOverride = fn;
    },
    setTurnStartErrorHandler: (fn: typeof turnStartErrorHandler) => {
      turnStartErrorHandler = fn;
    },
    reset: () => {
      children.length = 0;
      threadCounter = 0;
      turnCounter = 0;
      mcpStatusListCalls = 0;
      configReadHandler = undefined;
      threadStartIdOverride = undefined;
      turnStartErrorHandler = undefined;
    },
  };
});

vi.mock('node:child_process', () => ({ spawn: appServer.spawn, execFile: appServer.execFile }));
vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(async () => ({ availableModels: ['gpt-5.4'], models: [{ id: 'gpt-5.4' }] })),
  getCodexBaseInstructions: vi.fn(async () => '[catalog-prompt]'),
}));

import { CodexSdkProvider, buildCodexMcpThreadConfig } from '../../src/agent/providers/codex-sdk.js';
import {
  collectCodexTomlMcpServerKeysForIncognito,
  findEnabledImcodesMcpKeysFromConfig,
  getCodexIncognitoAppServerArgs,
} from '../../src/agent/providers/getDefaultCodexMcpArgs.js';
import { supportsSessionIncognito, SESSION_INCOGNITO_AGENT_TYPE, SESSION_INCOGNITO_UNSUPPORTED } from '../../shared/session-incognito-types.js';
import { inIncognitoContext, isIncognitoSessionName, setSessionIncognito } from '../../shared/session-incognito-context.js';

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('codex-sdk incognito support', () => {
  const createdCodexHomes: string[] = [];

  beforeEach(() => {
    appServer.reset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    setSessionIncognito('incog-route', false);
    setSessionIncognito('deck_incog_brain', false);
    setSessionIncognito('norm-route', false);
    setSessionIncognito('deck_norm_brain', false);
    for (const dir of createdCodexHomes.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supportsSessionIncognito includes codex-sdk and claude-code-sdk while keeping backwards-compat constants', () => {
    expect(supportsSessionIncognito('claude-code-sdk')).toBe(true);
    expect(supportsSessionIncognito('codex-sdk')).toBe(true);
    expect(supportsSessionIncognito('codex')).toBe(false);
    expect(supportsSessionIncognito('claude-code')).toBe(false);
    expect(supportsSessionIncognito('opencode')).toBe(false);
    expect(SESSION_INCOGNITO_AGENT_TYPE).toBe('claude-code-sdk');
    expect(SESSION_INCOGNITO_UNSUPPORTED).toContain('codex-sdk');
  });

  it('buildCodexMcpThreadConfig excludes imcodes-memory MCP when incognito=true while preserving shell identity', () => {
    const incog = buildCodexMcpThreadConfig({
      sessionKey: 'incog-1',
      sessionName: 'deck_incog_brain',
      sessionRole: 'brain',
      cwd: '/tmp/project',
      agentType: 'codex-sdk',
      incognito: true,
    });
    expect(incog?.mcp_servers).toBeUndefined();
    expect((incog as any)?.shell_environment_policy?.set?.IMCODES_SESSION).toBe('deck_incog_brain');

    const normal = buildCodexMcpThreadConfig({
      sessionKey: 'norm-1',
      sessionName: 'deck_norm_brain',
      sessionRole: 'brain',
      cwd: '/tmp/project',
      agentType: 'codex-sdk',
    });
    expect((normal?.mcp_servers as Record<string, unknown>)?.['imcodes-memory']).toBeDefined();
  });

  it('enforces ephemeral thread/start, strips MCP, omits resumeId, preserves multi-turn memory, and propagates privacy context', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-incog-unit-'));
    createdCodexHomes.push(codexHome);
    vi.stubEnv('CODEX_HOME', codexHome);

    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });

    const privacyObservations: Array<{ event: string; inPrivacy: boolean }> = [];
    const sessionInfos: Array<Record<string, unknown>> = [];
    const completes: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
    const deltas: string[] = [];
    const tools: string[] = [];

    provider.onDelta((_sid, delta) => {
      privacyObservations.push({ event: 'delta', inPrivacy: inIncognitoContext() });
      deltas.push(delta.delta);
    });
    provider.onComplete((_sid, msg) => {
      privacyObservations.push({ event: 'complete', inPrivacy: inIncognitoContext() });
      completes.push({ content: msg.content, metadata: msg.metadata });
    });
    provider.onToolCall((_sid, tool) => {
      privacyObservations.push({ event: 'tool', inPrivacy: inIncognitoContext() });
      tools.push(tool.name);
    });
    provider.onSessionInfo((_sid, info) => {
      privacyObservations.push({ event: 'session_info', inPrivacy: inIncognitoContext() });
      sessionInfos.push(info as Record<string, unknown>);
    });
    provider.onStatus((_sid) => {
      privacyObservations.push({ event: 'status', inPrivacy: inIncognitoContext() });
    });
    provider.onUsage((_sid) => {
      privacyObservations.push({ event: 'usage', inPrivacy: inIncognitoContext() });
    });

    await provider.createSession({
      sessionKey: 'incog-route',
      sessionName: 'deck_incog_brain',
      sessionRole: 'brain',
      agentType: 'codex-sdk',
      cwd: '/tmp/project',
      incognito: true,
    });
    expect(isIncognitoSessionName('incog-route')).toBe(true);
    expect(isIncognitoSessionName('deck_incog_brain')).toBe(true);

    // Turn 1: ephemeral thread/start, no mcp_servers, brain delegation check bypassed, isolated incognito app-server
    await provider.send('incog-route', 'SECRET PROMPT TURN 1');
    expect(appServer.children).toHaveLength(2);
    const normalChild = appServer.children[0];
    expect(normalChild.args.join(' ')).toContain('mcp_servers.imcodes-memory.command=');
    const child = appServer.children[1];
    expect(child.args.join(' ')).not.toContain('mcp_servers.imcodes-memory.command=');
    expect(child.args.join(' ')).not.toContain('mcp_servers.imcodes-memory.args=');
    expect(child.args.join(' ')).not.toContain('IMCODES_MCP_TOOL_CATALOG_MODE');
    const startReq = child.requests.find((r) => r.method === 'thread/start');
    expect(startReq?.params?.ephemeral).toBe(true);
    expect(startReq?.params?.config?.mcp_servers).toBeUndefined();
    expect(child.requests.some((r) => r.method === 'thread/resume')).toBe(false);
    expect(appServer.getMcpStatusListCalls()).toBe(0);
    expect(sessionInfos.some((info) => 'resumeId' in info)).toBe(false);

    // Emit turn 1 activity & completion
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd' } },
    });
    child.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'SECRET ANSWER 1' },
    });
    child.emits({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-1', tokenUsage: { last: { inputTokens: 5, outputTokens: 2 }, modelContextWindow: 1000 } },
    });
    child.emits({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
    });

    await waitFor(() => completes.length === 1);
    expect(completes[0].content).toBe('SECRET ANSWER 1');
    expect(completes[0].metadata?.resumeId).toBeUndefined();
    expect(deltas).toEqual(['SECRET ANSWER 1']);
    expect(tools).toContain('Bash');
    expect(privacyObservations.length).toBeGreaterThan(0);
    expect(privacyObservations.every((p) => p.inPrivacy === true)).toBe(true);

    // Model switch & system text refresh keep ephemeral thread in-memory without thread/resume
    provider.setSessionAgentId('incog-route', 'gpt-5.4-mini');
    provider.refreshSessionSystemText('incog-route');
    await provider.send('incog-route', 'SECRET PROMPT TURN 2');
    expect(child.requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
    expect(child.requests.some((r) => r.method === 'thread/resume')).toBe(false);
    const turn2Req = child.requests.filter((r) => r.method === 'turn/start')[1];
    expect(turn2Req?.params?.threadId).toBe('thread-1');
    expect(turn2Req?.params?.model).toBe('gpt-5.4-mini');

    child.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-2', itemId: 'msg-2', delta: 'SECRET ANSWER 2' },
    });
    child.emits({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [] } },
    });
    await waitFor(() => completes.length === 2);
    expect(completes[1].content).toBe('SECRET ANSWER 2');

    // End session unsubscribes ephemeral thread cleanly
    await provider.endSession('incog-route');
    expect(child.requests.some((r) => r.method === 'thread/unsubscribe')).toBe(true);

    await provider.disconnect();
  });

  it('forbids thread/resume, skipCreate, resumeId, and post-disconnect silent replacement for incognito sessions', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-incog-noresume-'));
    createdCodexHomes.push(codexHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ version: 1, pad: 'a' }));

    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });

    await expect(
      provider.createSession({
        sessionKey: 'incog-resume-rej',
        agentType: 'codex-sdk',
        cwd: '/tmp/project',
        incognito: true,
        resumeId: 'thread-old',
      }),
    ).rejects.toThrow('Incognito conversation ended; start a new session instead of resuming history.');

    await expect(
      provider.createSession({
        sessionKey: 'incog-skip-rej',
        agentType: 'codex-sdk',
        cwd: '/tmp/project',
        incognito: true,
        skipCreate: true,
      }),
    ).rejects.toThrow('Incognito conversation ended; start a new session instead of resuming history.');

    await provider.createSession({
      sessionKey: 'incog-route',
      agentType: 'codex-sdk',
      cwd: '/tmp/project',
      incognito: true,
    });
    await provider.send('incog-route', 'first turn');
    const firstChild = appServer.children[1];
    firstChild.emits({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    await waitFor(() => provider.getSessionDiagnostics('incog-route')?.runningTurnId === null);

    // Re-attaching createSession without fresh when an ephemeral threadId already existed must also reject
    await expect(
      provider.createSession({
        sessionKey: 'incog-route',
        agentType: 'codex-sdk',
        cwd: '/tmp/project',
        incognito: true,
      }),
    ).rejects.toThrow('Incognito conversation ended; start a new session instead of resuming history.');

    const errors: Array<{ message: string; inPrivacy: boolean }> = [];
    provider.onError((_sid, err) => {
      errors.push({ message: err.message, inPrivacy: inIncognitoContext() });
    });

    // Simulate app-server restart (e.g. auth refresh) unloading the in-memory ephemeral thread
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ version: 2, pad: 'bb' }));
    await provider.send('incog-route', 'cannot resume after exit');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Incognito conversation ended; start a new session instead of resuming history.');
    expect(errors[0].inPrivacy).toBe(true);
    const secondChild = appServer.children[2];
    expect(secondChild).toBeDefined();
    expect(secondChild.args.join(' ')).not.toContain('mcp_servers.imcodes-memory.command=');
    expect(secondChild.requests.some((r) => r.method === 'thread/resume')).toBe(false);
    expect(secondChild.requests.some((r) => r.method === 'thread/start')).toBe(false);
    expect(secondChild.requests.some((r) => r.method === 'turn/start')).toBe(false);

    await provider.disconnect();
  });

  it('never reads or settles from $CODEX_HOME/sessions rollout files for incognito sessions', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-incog-rollout-'));
    createdCodexHomes.push(codexHome);
    vi.stubEnv('CODEX_HOME', codexHome);

    const now = new Date();
    const rolloutDir = join(
      codexHome,
      'sessions',
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
    );
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(
      join(rolloutDir, 'rollout-test-thread-1.jsonl'),
      `${JSON.stringify({
        timestamp: now.toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'FORGED ROLLOUT DONE' },
      })}\n`,
    );

    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({
      sessionKey: 'incog-route',
      agentType: 'codex-sdk',
      cwd: '/tmp/project',
      incognito: true,
    });

    const completes: string[] = [];
    provider.onComplete((_sid, msg) => completes.push(msg.content));

    await provider.send('incog-route', 'hello');
    // Explicit backstop call must return false and not settle from rollout disk
    await expect(provider.settleCompletedTurnFromRolloutBackstop('incog-route', { graceMs: 0 })).resolves.toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(completes).toEqual([]);
    expect(provider.getSessionDiagnostics('incog-route')?.runningTurnId).toBe('turn-1');

    // Only explicit app-server turn/completed completes the incognito turn
    appServer.children[1].emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'LIVE SERVER ANSWER' },
    });
    appServer.children[1].emits({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    await waitFor(() => completes.length === 1);
    expect(completes).toEqual(['LIVE SERVER ANSWER']);

    await provider.disconnect();
  });

  it('normal non-incognito codex-sdk sessions keep mcp_servers, omit ephemeral, emit resumeId, and allow resume', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });

    const infos: Array<Record<string, unknown>> = [];
    const infoPrivacy: boolean[] = [];
    provider.onSessionInfo((_sid, info) => {
      infos.push(info as Record<string, unknown>);
      infoPrivacy.push(inIncognitoContext());
    });

    await provider.createSession({
      sessionKey: 'norm-route',
      sessionName: 'deck_norm_brain',
      sessionRole: 'brain',
      agentType: 'codex-sdk',
      cwd: '/tmp/project',
    });
    await provider.send('norm-route', 'hello normal');
    const child = appServer.children[0];
    const startReq = child.requests.find((r) => r.method === 'thread/start');
    expect(startReq?.params?.ephemeral).toBeUndefined();
    expect(startReq?.params?.config?.mcp_servers?.['imcodes-memory']).toBeDefined();
    expect(infos.some((i) => i.resumeId === 'thread-1')).toBe(true);
    expect(infoPrivacy.every((p) => p === false)).toBe(true);

    child.emits({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    await waitFor(() => provider.getSessionDiagnostics('norm-route')?.runningTurnId === null);

    // Simulate reload via refreshSessionSystemText -> normal session resumes via thread/resume
    provider.refreshSessionSystemText('norm-route');
    await provider.send('norm-route', 'turn after refresh');
    expect(child.requests.some((r) => r.method === 'thread/resume' && r.params?.threadId === 'thread-1')).toBe(true);

    await provider.disconnect();
  });

  it('disables user config.toml imcodes-memory entries on incognito app-server while preserving normal coexistence in both orders', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-incog-coexist-'));
    createdCodexHomes.push(codexHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    await writeFile(join(codexHome, 'config.toml'), `
[mcp_servers.imcodes-memory]
command = "imcodes"
args = ["memory", "mcp"]

[mcp_servers.aliased-mem]
command = "imcodes"
args = ["memory", "mcp"]

[mcp_servers.custom-user]
command = "custom-mcp"
`);

    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    const completes: Array<{ sid: string; text: string }> = [];
    provider.onComplete((sid, msg) => completes.push({ sid, text: msg.content }));

    // Coexistence order A: normal first, then incognito concurrently
    await provider.createSession({ sessionKey: 'norm-route', agentType: 'codex-sdk', cwd: '/tmp/project' });
    await provider.createSession({ sessionKey: 'incog-route', agentType: 'codex-sdk', cwd: '/tmp/project', incognito: true });

    await provider.send('norm-route', 'normal-first');
    await provider.send('incog-route', 'incog-second');

    expect(appServer.children).toHaveLength(2);
    const normProc = appServer.children[0];
    const incogProc = appServer.children[1];

    expect(normProc.args.join(' ')).toContain('mcp_servers.imcodes-memory.command=');
    expect(incogProc.args.join(' ')).not.toContain('mcp_servers.imcodes-memory.command=');
    expect(incogProc.args).toContain('mcp_servers.imcodes-memory.enabled=false');
    expect(incogProc.args).toContain('mcp_servers.aliased-mem.enabled=false');
    expect(incogProc.args.join(' ')).not.toContain('mcp_servers.custom-user.enabled=false');

    const normThread = normProc.requests.find((r) => r.method === 'thread/start')?.params;
    const incogThread = incogProc.requests.find((r) => r.method === 'thread/start')?.params;
    expect(normThread?.ephemeral).toBeUndefined();
    expect(normThread?.config?.mcp_servers?.['imcodes-memory']).toBeDefined();
    expect(incogThread?.ephemeral).toBe(true);
    expect(incogThread?.config?.mcp_servers).toBeUndefined();

    normProc.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'm1', delta: 'NORMAL_OK' },
    });
    normProc.emits({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
    });
    incogProc.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-2', turnId: 'turn-2', itemId: 'm2', delta: 'INCOG_OK' },
    });
    incogProc.emits({
      method: 'turn/completed',
      params: { threadId: 'thread-2', turn: { id: 'turn-2', status: 'completed', items: [] } },
    });

    await waitFor(() => completes.length === 2);
    expect(completes).toEqual([
      { sid: 'norm-route', text: 'NORMAL_OK' },
      { sid: 'incog-route', text: 'INCOG_OK' },
    ]);

    await provider.disconnect();
  });

  it('parses quoted, dotted, URL, and wrapped imcodes-memory TOML keys and formats incognito disable args', () => {
    const keys = collectCodexTomlMcpServerKeysForIncognito(`
# comment [mcp_servers.ignored]
mcp_servers.imcodes-memory.url = "http://127.0.0.1:9999/mcp"

[mcp_servers."imcodes.mem"]
command = "sh"
args = ["-c", "IMCODES_MCP_PARENT_PID=$PPID exec \\"$0\\" \\"$@\\"", "imcodes", "memory", "mcp"]

[mcp_servers.custom-user]
command = "custom-mcp"
args = ["--stdio"]
`);
    expect(keys.sort()).toEqual(['imcodes-memory', 'imcodes.mem']);

    const args = getCodexIncognitoAppServerArgs(['imcodes-memory', 'imcodes.mem', 'imcodes-memory']);
    expect(args).toEqual([
      '-c',
      'mcp_servers.imcodes-memory.enabled=false',
      '-c',
      'mcp_servers."imcodes.mem".enabled=false',
      '-c',
      'features.default_mode_request_user_input=true',
      'app-server',
    ]);

    expect(findEnabledImcodesMcpKeysFromConfig({
      'imcodes-memory': { url: 'http://127.0.0.1:9999/mcp', enabled: true },
      'already-off': { command: 'imcodes', args: ['memory', 'mcp'], enabled: false },
      'custom-other': { command: 'custom-mcp', args: [], enabled: true },
      'alias-mem': { command: 'imcodes', args: ['memory', 'mcp'] },
    }).sort()).toEqual(['alias-mem', 'imcodes-memory']);
  });

  it('retries incognito app-server once when config/read reveals hidden enabled imcodes-memory, and fails closed if still enabled', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-incog-guard-'));
    createdCodexHomes.push(codexHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    await writeFile(join(codexHome, 'config.toml'), '');

    // Case 1: config/read reveals an entry not present in pre-scan; retry disables it cleanly.
    appServer.setConfigReadHandler((params, spawnArgs) => {
      if (spawnArgs.includes('mcp_servers.late-mem.enabled=false')) {
        if (params?.cwd === '/tmp/proj-with-cwd') {
          return {
            mcp_servers: {
              'late-mem': { command: 'imcodes', args: ['memory', 'mcp'], enabled: false },
              'cwd-mem': { command: 'imcodes', args: ['memory', 'mcp'], enabled: true },
            },
          };
        }
        return { mcp_servers: { 'late-mem': { command: 'imcodes', args: ['memory', 'mcp'], enabled: false } } };
      }
      return { mcp_servers: { 'late-mem': { command: 'imcodes', args: ['memory', 'mcp'], enabled: true } } };
    });

    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({
      sessionKey: 'incog-route',
      agentType: 'codex-sdk',
      cwd: '/tmp/proj-with-cwd',
      incognito: true,
    });
    await provider.send('incog-route', 'check guard');

    // children[0] = normal, children[1] = initial incognito, children[2] = retried incognito with -c disable
    expect(appServer.children).toHaveLength(3);
    expect(appServer.children[2].args).toContain('mcp_servers.late-mem.enabled=false');
    const threadStart = appServer.children[2].requests.find((r) => r.method === 'thread/start');
    expect(threadStart?.params?.config?.mcp_servers).toEqual({
      'late-mem': { enabled: false },
      'cwd-mem': { enabled: false },
    });
    await provider.disconnect();

    // Case 2: if config/read keeps reporting enabled even after retry, fail closed (reject)
    appServer.reset();
    appServer.setConfigReadHandler(() => ({
      mcp_servers: { 'imcodes-memory': { url: 'http://127.0.0.1:9999/mcp', enabled: true } },
    }));
    const provider2 = new CodexSdkProvider();
    await provider2.connect({ binaryPath: 'codex' });
    await provider2.createSession({
      sessionKey: 'incog-route',
      agentType: 'codex-sdk',
      cwd: '/tmp/proj-with-cwd',
      incognito: true,
    });
    await expect(
      provider2.send('incog-route', 'should fail closed'),
    ).rejects.toThrow(/could not be disabled at Codex app-server boundary/i);
    await provider2.disconnect();
  });

  it('F1-R2: fails closed on startup/cwd config/read RPC error, malformed response, or timeout and recovers cleanly next attempt', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-incog-r2-'));
    createdCodexHomes.push(codexHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    await writeFile(join(codexHome, 'config.toml'), '');

    // 1. Startup config/read RPC error (-32601 unsupported) -> send rejects, never creates thread, next call retries config/read and succeeds
    let startupReads = 0;
    appServer.setConfigReadHandler((params) => {
      if (!params?.cwd) {
        startupReads += 1;
        if (startupReads === 1) {
          return { __rpcError: { code: -32601, message: 'Method not found' } };
        }
      }
      return { mcp_servers: {} };
    });

    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'incog-route', agentType: 'codex-sdk', cwd: '/tmp/proj', incognito: true });
    await expect(provider.send('incog-route', 'blocked on unsupported startup config/read')).rejects.toThrow(/Method not found/i);
    // Retries cleanly instead of caching configReadSupported=false
    await provider.send('incog-route', 'recovers on retry');
    expect(startupReads).toBe(2);
    const incogProc = appServer.children[2];
    expect(incogProc?.requests.some((r) => r.method === 'thread/start')).toBe(true);
    await provider.disconnect();

    // 2. Malformed startup & cwd config/read responses -> fail closed with invalid config/read error and zero thread/start
    for (const rawResult of [null, { config: null }, { config: { mcp_servers: null } }, { config: {} }]) {
      appServer.reset();
      appServer.setConfigReadHandler(() => ({ __rawResult: rawResult }));
      const pMalformed = new CodexSdkProvider();
      await pMalformed.connect({ binaryPath: 'codex' });
      await pMalformed.createSession({ sessionKey: 'incog-route', agentType: 'codex-sdk', cwd: '/tmp/proj', incognito: true });
      await expect(pMalformed.send('incog-route', 'malformed startup')).rejects.toThrow(/invalid Codex config\/read response/i);
      expect(appServer.children[1]?.requests.some((r) => r.method === 'thread/start')).toBe(false);
      await pMalformed.disconnect();
    }

    // 3. CWD config/read error + malformed -> never calls thread/start, emits error, next send recovers cleanly
    appServer.reset();
    let cwdAttempts = 0;
    appServer.setConfigReadHandler((params) => {
      if (!params?.cwd) return { mcp_servers: {} };
      cwdAttempts += 1;
      if (cwdAttempts === 1) return { __rpcError: { code: -32000, message: 'cwd timeout failure' } };
      if (cwdAttempts === 2) return { __rawResult: { config: { mcp_servers: 'bad' } } };
      return { mcp_servers: { 'proj-mem': { command: 'imcodes', args: ['memory', 'mcp'], enabled: true } } };
    });
    const pCwd = new CodexSdkProvider();
    await pCwd.connect({ binaryPath: 'codex' });
    const errors: Error[] = [];
    pCwd.onError((_sid, err) => errors.push(err));
    await pCwd.createSession({ sessionKey: 'incog-route', agentType: 'codex-sdk', cwd: '/tmp/proj', incognito: true });

    await pCwd.send('incog-route', 'cwd attempt 1 (rpc error)');
    await pCwd.send('incog-route', 'cwd attempt 2 (malformed)');
    const incogChannelChild = appServer.children[1];
    expect(incogChannelChild.requests.some((r) => r.method === 'thread/start')).toBe(false);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toMatch(/cwd timeout failure/i);
    expect(errors[1]?.message).toMatch(/invalid Codex config\/read response/i);

    await pCwd.send('incog-route', 'cwd attempt 3 (recovers)');
    expect(cwdAttempts).toBe(3);
    const recoveredStart = incogChannelChild.requests.find((r) => r.method === 'thread/start');
    expect(recoveredStart?.params?.config?.mcp_servers).toEqual({ 'proj-mem': { enabled: false } });
    await pCwd.disconnect();
  });

  it('F2: routes setServiceTier and both unsafe-replay auth restarts strictly per-channel under threadId collisions', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-incog-f2-'));
    createdCodexHomes.push(codexHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    await writeFile(join(codexHome, 'config.toml'), '');

    // Force identical colliding threadId across BOTH normalChannel and incognitoChannel
    appServer.setThreadStartIdOverride(() => 'colliding-thread-1');

    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'norm-route', agentType: 'codex-sdk', cwd: '/tmp/project' });
    await provider.createSession({ sessionKey: 'incog-route', agentType: 'codex-sdk', cwd: '/tmp/project', incognito: true });

    // Trigger setServiceTier before any send() so ensureThreadLoaded + channel routing both execute cleanly
    await provider.setServiceTier('incog-route', 'fast');
    await provider.setServiceTier('norm-route', 'standard');

    expect(appServer.children).toHaveLength(2);
    const incogProc = appServer.children[1];
    const normProc = appServer.children[0];
    expect(incogProc.args.join(' ')).not.toContain('mcp_servers.imcodes-memory.command=');
    expect(normProc.args.join(' ')).toContain('mcp_servers.imcodes-memory.command=');

    expect(incogProc.requests.filter((r) => r.method === 'thread/settings/update').map((r) => r.params)).toEqual([
      { threadId: 'colliding-thread-1', serviceTier: 'fast' },
    ]);
    expect(normProc.requests.filter((r) => r.method === 'thread/settings/update').map((r) => r.params)).toEqual([
      { threadId: 'colliding-thread-1', serviceTier: 'standard' },
    ]);

    // Case A: turn-failed-unsafe-replay after partial streamed delta on incognito restarts ONLY incognitoChannel, not normalChannel, with zero turn replay
    const errors: Array<{ sid: string; message: string }> = [];
    provider.onError((sid, err) => errors.push({ sid, message: err.message }));

    await provider.send('incog-route', 'secret turn-failed input');
    const incogTurnStartsBefore = incogProc.requests.filter((r) => r.method === 'turn/start').length;
    incogProc.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'colliding-thread-1', turnId: 'turn-1', itemId: 'm1', delta: 'partial output' },
    });
    incogProc.emits({
      method: 'turn/completed',
      params: {
        threadId: 'colliding-thread-1',
        turn: { id: 'turn-1', status: 'failed', items: [], error: { message: '401 Unauthorized' } },
      },
    });

    await waitFor(() => appServer.children.length === 3);
    expect(normProc.child.killed).toBe(false);
    expect(incogProc.child.killed).toBe(true);
    const incogRestarted = appServer.children[2];
    expect(incogRestarted.args.join(' ')).not.toContain('mcp_servers.imcodes-memory.command=');
    // Must not silently replay user input
    expect(incogProc.requests.filter((r) => r.method === 'turn/start')).toHaveLength(incogTurnStartsBefore);
    expect(incogRestarted.requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
    await waitFor(() => errors.some((e) => e.sid === 'incog-route' && /not replayed/i.test(e.message)));

    // Case B: start-turn-unsafe-replay on incognito when turn/start fails with 401 after partial output arrived
    await provider.createSession({ sessionKey: 'incog-route-2', agentType: 'codex-sdk', cwd: '/tmp/project', incognito: true });
    await provider.send('incog-route-2', 'warmup turn');
    const internals = provider as unknown as { sessions: Map<string, any> };
    const incog2State = internals.sessions.get('incog-route-2');
    incogRestarted.emits({
      method: 'turn/completed',
      params: { threadId: 'colliding-thread-1', turn: { id: 'turn-2', status: 'completed', items: [] } },
    });
    await waitFor(() => incog2State.runningTurnId === undefined);

    appServer.setTurnStartErrorHandler((spawnArgs, params, record) => {
      if (!spawnArgs.join(' ').includes('mcp_servers.imcodes-memory.command=')) {
        // Stream a delta before rejecting turn/start so startTurn enters the unsafe-replay auth restart branch (line 4246)
        record.emits({
          method: 'item/agentMessage/delta',
          params: { threadId: String(params?.threadId ?? 'colliding-thread-1'), turnId: 'turn-partial', itemId: 'm-partial', delta: 'partial before 401' },
        });
        return { code: -32000, message: '401 Unauthorized' };
      }
      return undefined;
    });
    await provider.send('incog-route-2', 'start-turn unsafe replay');

    await waitFor(() => appServer.children.length === 4);
    expect(normProc.child.killed).toBe(false);
    expect(incogRestarted.child.killed).toBe(true);
    expect(appServer.children[3].args.join(' ')).not.toContain('mcp_servers.imcodes-memory.command=');
    expect(appServer.children[3].requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
    await waitFor(() => errors.some((e) => e.sid === 'incog-route-2' && /not replayed/i.test(e.message)));

    await provider.disconnect();
  });
});
