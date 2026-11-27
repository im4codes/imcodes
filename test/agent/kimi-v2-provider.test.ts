import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { RequestError } from '@agentclientprotocol/sdk/unstable';
import type { AcpClientConnection, AcpClientHandlers } from '../../src/agent/providers/acp-client-adapter.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import { SESSION_MODEL_APPLIED } from '../../shared/session-model-control.js';

const {
  mockSpawn,
  mockKillProcessTree,
  state,
} = vi.hoisted(() => {
  const state = {
    handlers: null as AcpClientHandlers | null,
    conn: null as Record<string, ReturnType<typeof vi.fn>> | null,
    spawnError: null as (Error & { code?: string }) | null,
    children: [] as Array<EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    }>,
  };
  return {
    mockSpawn: vi.fn(),
    mockKillProcessTree: vi.fn(async (child: { killed?: boolean; exitCode?: number | null; emit?: (ev: string, ...args: unknown[]) => void }) => {
      if (child) {
        child.killed = true;
        child.exitCode = 0;
        child.emit?.('exit', 0, null);
      }
    }),
    state,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    spawn: mockSpawn,
  };
});

vi.mock('../../src/agent/providers/acp-client-adapter.js', () => ({
  createAcpClientConnection: vi.fn((handlers: AcpClientHandlers) => {
    state.handlers = handlers;
    return state.conn as unknown as AcpClientConnection;
  }),
}));

vi.mock('../../src/util/kill-process-tree.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/util/kill-process-tree.js')>();
  return {
    ...orig,
    killProcessTree: mockKillProcessTree,
  };
});

import { KimiV2Provider } from '../../src/agent/providers/kimi-v2.js';
import { resolveKimiPathForSdk } from '../../src/agent/transport-paths.js';

function makeFakeChild() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.pid = 42424;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.killed = false;
  emitter.kill = vi.fn(() => {
    emitter.killed = true;
    return true;
  });
  return emitter;
}

function makeMockConn(overrides: Record<string, unknown> = {}) {
  return {
    initialize: vi.fn(async () => ({
      protocolVersion: 1,
      agentInfo: { name: 'Kimi Code CLI', version: '2.8.1' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    })),
    newSession: vi.fn(async () => ({
      sessionId: 'kimi-sess-1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-k2.5',
          options: [
            { value: 'kimi-k2.5', name: 'Kimi K2.5' },
            { value: 'kimi-for-coding', name: 'Kimi for Coding' },
          ],
        },
      ],
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'yolo', name: 'Yolo' },
        ],
      },
    })),
    loadSession: vi.fn(async () => ({
      models: {
        currentModelId: 'kimi-k1-legacy',
        availableModels: [{ modelId: 'kimi-k1-legacy', name: 'Legacy Model' }],
      },
    })),
    resumeSession: vi.fn(async () => ({
      configOptions: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-k2.5',
          options: [{ value: 'kimi-k2.5', name: 'Kimi K2.5' }],
        },
      ],
    })),
    listSessions: vi.fn(async () => ({
      sessions: [
        { sessionId: 'kimi-sess-1', title: 'Repo work', cwd: '/tmp/repo', updatedAt: '2026-11-28T00:00:00.000Z' },
      ],
    })),
    closeSession: vi.fn(async () => ({})),
    setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
    unstable_setSessionModel: vi.fn(async () => ({})),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('resolveKimiPathForSdk (v2 + legacy fallback)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeExec(dir: string, relPath: string): string {
    const full = path.join(dir, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, '#!/bin/sh\necho ok\n');
    chmodSync(full, 0o755);
    return full;
  }

  it('prefers KIMI_CLI_PATH, then KIMI_CODE_HOME/bin/kimi, then ~/.kimi-code/bin/kimi, before ~/.local/bin/kimi', () => {
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'kimi-path-'));
    tempDirs.push(tmpHome);
    const customHome = path.join(tmpHome, 'custom-kimi-code');
    const overrideBin = makeExec(tmpHome, 'override/kimi-override');
    const customBin = makeExec(customHome, 'bin/kimi');
    const v2Bin = makeExec(tmpHome, '.kimi-code/bin/kimi');
    const legacyBin = makeExec(tmpHome, '.local/bin/kimi');

    expect(resolveKimiPathForSdk('kimi', {
      HOME: tmpHome,
      KIMI_CODE_HOME: customHome,
      KIMI_CLI_PATH: overrideBin,
      PATH: '/usr/bin',
    })).toBe(overrideBin);

    expect(resolveKimiPathForSdk('kimi', {
      HOME: tmpHome,
      KIMI_CODE_HOME: customHome,
      PATH: '/usr/bin',
    })).toBe(customBin);

    expect(resolveKimiPathForSdk('kimi', {
      HOME: tmpHome,
      PATH: '/usr/bin',
    })).toBe(v2Bin);

    rmSync(v2Bin);
    expect(resolveKimiPathForSdk('kimi', {
      HOME: tmpHome,
      PATH: '/usr/bin',
    })).toBe(legacyBin);
  });
});

describe('KimiV2Provider', () => {
  beforeEach(() => {
    state.handlers = null;
    state.spawnError = null;
    state.children = [];
    state.conn = makeMockConn();
    mockSpawn.mockReset();
    mockKillProcessTree.mockClear();
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild();
      state.children.push(child);
      if (state.spawnError) {
        const err = state.spawnError;
        queueMicrotask(() => child.emit('error', err));
      }
      return child;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes kimi-sdk identity, attachment capability, compact capability, and spawns with detached process group', async () => {
    const provider = new KimiV2Provider();
    expect(provider.id).toBe('kimi-sdk');
    expect(provider.capabilities.attachments).toBe(true);
    expect(provider.capabilities.compact?.execution).toBe('slash-command');
    expect(provider.capabilities.compact?.providerCommand).toBe('/compact');
    expect(provider.capabilities.compact?.reassertsSessionSystemText).toBe(false);

    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-1', cwd: os.tmpdir() });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0]!;
    expect(typeof cmd).toBe('string');
    expect(args).toEqual(['acp']);
    expect((opts as { detached?: boolean }).detached).toBe(process.platform !== 'win32');

    await provider.disconnect();
    expect(mockKillProcessTree).toHaveBeenCalledWith(expect.anything(), { ownsProcessGroup: true });
  });

  it('extracts models from v2 configOptions, caches for 30s, refreshes on force, and switches via setSessionConfigOption', async () => {
    const provider = new KimiV2Provider();
    await provider.connect({});

    const infoEvents: Array<{ sessionId: string; info: Record<string, unknown> }> = [];
    provider.onSessionInfo((sid, info) => infoEvents.push({ sessionId: sid, info: info as Record<string, unknown> }));

    await provider.createSession({ sessionKey: 'sess-models', cwd: os.tmpdir() });

    const list1 = await provider.listModels();
    expect(list1.isAuthenticated).toBe(true);
    expect(list1.defaultModel).toBe('kimi-k2.5');
    expect(list1.models).toEqual([
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
      { id: 'kimi-for-coding', name: 'Kimi for Coding' },
    ]);
    // Reused live session catalog without spawning an extra probe
    expect(state.conn!.newSession).toHaveBeenCalledTimes(1);

    // Apply model via v2 setSessionConfigOption when configOptions present
    const applied = await provider.applySessionModel('sess-models', 'kimi-for-coding');
    expect(applied).toBe(SESSION_MODEL_APPLIED.LIVE);
    expect(state.conn!.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'kimi-sess-1',
      configId: 'model',
      value: 'kimi-for-coding',
    });

    // Live config_option_update notification updates session model & cache
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'kimi-k2.6',
            options: [{ value: 'kimi-k2.6', name: 'Kimi K2.6' }],
          },
        ],
      } as never,
    });
    expect(infoEvents.some((e) => e.info.model === 'kimi-k2.6')).toBe(true);

    // Force probe invokes newSession + closeSession
    await provider.listModels(true);
    expect(state.conn!.newSession).toHaveBeenCalledTimes(2);
    expect(state.conn!.closeSession).toHaveBeenCalledWith({ sessionId: 'kimi-sess-1' });

    await provider.disconnect();
  });

  it('supports legacy 1.x model catalog and -32601 fallback from unstable_setSessionModel to setSessionConfigOption', async () => {
    state.conn = makeMockConn({
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'Kimi CLI', version: '1.44.0' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      })),
      newSession: vi.fn(async () => ({
        sessionId: 'legacy-1',
        models: {
          currentModelId: 'kimi-k1',
          availableModels: [{ modelId: 'kimi-k1', name: 'Kimi K1' }],
        },
      })),
      unstable_setSessionModel: vi.fn(async () => {
        throw new RequestError(-32601, 'Method not found');
      }),
    });

    const provider = new KimiV2Provider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-legacy', cwd: os.tmpdir() });

    const list = await provider.listModels();
    expect(list.defaultModel).toBe('kimi-k1');
    expect(list.models).toEqual([{ id: 'kimi-k1', name: 'Kimi K1' }]);

    await provider.applySessionModel('sess-legacy', 'kimi-k2.5');
    expect(state.conn!.unstable_setSessionModel).toHaveBeenCalledOnce();
    expect(state.conn!.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'legacy-1',
      configId: 'model',
      value: 'kimi-k2.5',
    });

    await provider.disconnect();
  });

  it('uses session/resume when resume capability exists, falls back to loadSession with replay suppression, and creates new on session-not-found', async () => {
    const provider = new KimiV2Provider();
    await provider.connect({});

    // 1. v2 resume path
    await provider.createSession({ sessionKey: 'sess-resume', cwd: os.tmpdir(), resumeId: 'prev-v2' });
    expect(state.conn!.resumeSession).toHaveBeenCalledWith({
      sessionId: 'prev-v2',
      cwd: expect.any(String),
      mcpServers: expect.any(Array),
    });
    expect(state.conn!.loadSession).not.toHaveBeenCalled();

    // 2. Resume returns session-not-found -> falls back to newSession
    state.conn!.resumeSession.mockRejectedValueOnce(new RequestError(-32002, 'Session not found'));
    await provider.createSession({ sessionKey: 'sess-missing', cwd: os.tmpdir(), resumeId: 'gone-id' });
    expect(state.conn!.newSession).toHaveBeenCalledTimes(1);

    await provider.disconnect();

    // 3. Legacy loadSession suppresses replayed chunks
    const deltas: string[] = [];
    state.conn = makeMockConn({
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'Kimi CLI', version: '1.44.0' },
        agentCapabilities: { loadSession: true },
      })),
      loadSession: vi.fn(async () => {
        await state.handlers!.sessionUpdate({
          sessionId: 'legacy-prev',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'replayed history chunk' },
          } as never,
        });
        return {};
      }),
    });

    const legacyProvider = new KimiV2Provider();
    legacyProvider.onDelta((_, d) => deltas.push(d.delta));
    await legacyProvider.connect({});
    await legacyProvider.createSession({ sessionKey: 'sess-load', cwd: os.tmpdir(), resumeId: 'legacy-prev' });
    expect(state.conn!.loadSession).toHaveBeenCalledOnce();
    expect(deltas).toEqual([]);

    await legacyProvider.disconnect();
  });

  it('encodes image attachments as image ContentBlocks when supported and resource_link otherwise', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kimi-attach-'));
    try {
      const imgPath = path.join(tmpDir, 'shot.png');
      const txtPath = path.join(tmpDir, 'notes.txt');
      writeFileSync(imgPath, Buffer.from('pngbytes'));
      writeFileSync(txtPath, 'hello notes');

      const provider = new KimiV2Provider();
      await provider.connect({});
      await provider.createSession({ sessionKey: 'sess-img', cwd: tmpDir });

      await provider.send('sess-img', 'look at these', [
        { id: '1', daemonPath: imgPath, originalName: 'shot.png', mime: 'image/png', type: 'image', size: 8 },
        { id: '2', daemonPath: txtPath, originalName: 'notes.txt', mime: 'text/plain', type: 'file', size: 11 },
      ]);

      const promptArg = state.conn!.prompt.mock.calls[0]![0] as { prompt: Array<Record<string, unknown>> };
      expect(promptArg.prompt[0]).toEqual({ type: 'text', text: 'look at these' });
      expect(promptArg.prompt[1]).toEqual({
        type: 'image',
        data: Buffer.from('pngbytes').toString('base64'),
        mimeType: 'image/png',
      });
      expect(promptArg.prompt[2]).toMatchObject({
        type: 'resource_link',
        name: 'notes.txt',
        mimeType: 'text/plain',
      });
      expect(String(promptArg.prompt[2]!.uri)).toMatch(/^file:\/\//);

      await provider.disconnect();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('maps v2 usage_update { used, size } and legacy { tokens } cleanly, and resets stream/identity on tool_call and /compact', async () => {
    const provider = new KimiV2Provider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-stream',
      cwd: os.tmpdir(),
      identityPrompt: 'IDENTITY_CONTRACT_V1',
    });

    const usages: unknown[] = [];
    const deltas: Array<{ messageId: string; delta: string }> = [];
    const completes: Array<{ id: string; content: string }> = [];
    provider.onUsage((_, u) => usages.push(u));
    provider.onDelta((_, d) => deltas.push({ messageId: d.messageId, delta: d.delta }));
    provider.onComplete((_, m) => completes.push({ id: m.id, content: m.content }));

    state.conn!.prompt.mockImplementationOnce(async () => {
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part A' } } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'read_file', kind: 'read', status: 'completed' } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part B' } } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'usage_update', used: 12000, size: 262144 } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'usage_update', tokens: { input: 500, output: 100, cached: 50, limit: 128000 } } as never,
      });
      return { stopReason: 'end_turn' };
    });

    await provider.send('sess-stream', {
      userMessage: 'hi',
      assembledMessage: 'hi',
      sessionSystemText: 'IDENTITY_CONTRACT_V1',
      context: {
        sessionSystemText: 'IDENTITY_CONTRACT_V1',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'p1' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    });

    // Cross-message streaming rotated messageId after tool_call
    expect(deltas).toHaveLength(2);
    expect(deltas[0]!.messageId).not.toBe(deltas[1]!.messageId);
    expect(completes[0]!.content).toBe('Part B');

    expect(usages).toEqual([
      expect.objectContaining({
        model: 'kimi-k2.5',
        usage: { input_tokens: 12000, model_context_window: 262144 },
      }),
      expect.objectContaining({
        model: 'kimi-k2.5',
        usage: {
          input_tokens: 500,
          output_tokens: 100,
          cached_input_tokens: 50,
          cache_read_input_tokens: 50,
          model_context_window: 128000,
        },
      }),
    ]);

    // /compact passes raw '/compact' and clears cached identity so next turn re-injects
    await provider.send('sess-stream', '/compact');
    const compactPrompt = state.conn!.prompt.mock.calls[1]![0] as { prompt: Array<{ text: string }> };
    expect(compactPrompt.prompt[0]!.text).toBe('/compact');

    await provider.send('sess-stream', {
      userMessage: 'after compact',
      assembledMessage: 'after compact',
      sessionSystemText: 'IDENTITY_CONTRACT_V1',
      context: {
        sessionSystemText: 'IDENTITY_CONTRACT_V1',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'p1' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    });
    const postCompactPrompt = state.conn!.prompt.mock.calls[2]![0] as { prompt: Array<{ text: string }> };
    expect(postCompactPrompt.prompt[0]!.text).toContain('IDENTITY_CONTRACT_V1');

    await provider.disconnect();
  });

  it('handles -32000 auth errors in listModels and ENOENT spawn errors cleanly, plus safe getSessionDiagnostics', async () => {
    state.conn = makeMockConn({
      newSession: vi.fn(async () => {
        throw new RequestError(-32000, 'Authentication required');
      }),
    });
    const provider = new KimiV2Provider();
    await provider.connect({});
    const unauth = await provider.listModels();
    expect(unauth.isAuthenticated).toBe(false);
    expect(unauth.models).toEqual([]);
    expect(unauth.error).toContain('/login');
    await provider.disconnect();

    state.conn = makeMockConn({
      initialize: vi.fn(() => new Promise(() => {})),
    });
    state.spawnError = Object.assign(new Error('spawn kimi ENOENT'), { code: 'ENOENT' });
    const missing = new KimiV2Provider();
    await missing.connect({});
    await expect(missing.createSession({ sessionKey: 's-missing', cwd: os.tmpdir() })).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
      message: expect.stringContaining('@moonshot-ai/kimi-code'),
    });

    // Safe diagnostics verification
    state.spawnError = null;
    state.conn = makeMockConn();
    const diagProvider = new KimiV2Provider();
    await diagProvider.connect({ apiKey: 'sk-super-secret-token' });
    await diagProvider.createSession({
      sessionKey: 'sess-diag',
      cwd: os.tmpdir(),
      env: { SECRET_VAR: 'top-secret' },
    });
    const diag = diagProvider.getSessionDiagnostics('sess-diag');
    const serialized = JSON.stringify(diag);
    expect(diag).toMatchObject({
      provider: 'kimi-sdk',
      implementation: 'kimi-v2',
      connected: true,
      providerSessionId: 'kimi-sess-1',
      model: 'kimi-k2.5',
      capabilities: { resume: true, image: true },
    });
    expect(serialized).not.toContain('sk-super-secret-token');
    expect(serialized).not.toContain('top-secret');
    await diagProvider.disconnect();
  });

  it('supports cancelAndWait, requestPermission/respondApproval, listSessions, and detachSession', async () => {
    const provider = new KimiV2Provider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-ctrl', cwd: os.tmpdir() });

    const approvals: Array<{ id: string }> = [];
    provider.onApprovalRequest((_sid, req) => approvals.push({ id: req.id }));

    const permPromise = state.handlers!.requestPermission({
      sessionId: 'kimi-sess-1',
      toolCall: { toolCallId: 'tc-perm', title: 'bash', kind: 'execute', rawInput: { cmd: 'ls' } },
      options: [
        { optionId: 'approve_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    } as never);
    expect(approvals).toHaveLength(1);
    await provider.respondApproval('sess-ctrl', approvals[0]!.id, true);
    expect(await permPromise).toEqual({ outcome: { outcome: 'selected', optionId: 'approve_once' } });

    const listed = await provider.listSessions();
    expect(listed).toEqual([
      expect.objectContaining({ key: 'kimi-sess-1', displayName: 'Repo work' }),
    ]);

    // cancelAndWait waits for original prompt completion, not cancel RPC return
    let resolvePrompt!: (val: { stopReason: string }) => void;
    state.conn!.prompt.mockImplementationOnce(() => new Promise((r) => { resolvePrompt = r; }));
    const sendPromise = provider.send('sess-ctrl', 'long run').catch((e: Error) => e);

    let waitFinished = false;
    const stopPromise = provider.cancelAndWait('sess-ctrl').then(() => { waitFinished = true; });
    await vi.waitFor(() => {
      expect(state.conn!.cancel).toHaveBeenCalledWith({ sessionId: 'kimi-sess-1' });
    });
    expect(waitFinished).toBe(false);

    resolvePrompt({ stopReason: 'cancelled' });
    await stopPromise;
    expect(waitFinished).toBe(true);
    await sendPromise;

    await provider.detachSession('sess-ctrl');
    expect(state.conn!.closeSession).not.toHaveBeenCalled();

    await provider.disconnect();
  });
});
