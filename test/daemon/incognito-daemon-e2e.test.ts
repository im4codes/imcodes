import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

const sdkHarness = vi.hoisted(() => ({
  calls: [] as Array<{ options: Record<string, unknown> }>,
  turns: [] as string[],
}));

const codexHarness = vi.hoisted(() => ({
  requests: [] as Array<{ id?: number; method?: string; params?: Record<string, any> }>,
  turns: [] as string[],
  threadCounter: 0,
  turnCounter: 0,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const isFakeCodexVersion = (cmd: unknown, args?: readonly string[] | null): boolean => {
    const argList = Array.isArray(args) ? args : [];
    const cmdStr = String(cmd ?? '');
    return argList.includes('--version')
      && (cmdStr === 'codex' || cmdStr.endsWith('/codex') || cmdStr.endsWith('\\codex.exe') || argList.some((a) => String(a).includes('codex')));
  };
  const actualExecFileP = promisify(actual.execFile);
  const execFileMock = Object.assign(
    vi.fn((...callArgs: unknown[]) => {
      const cmd = callArgs[0];
      const args = Array.isArray(callArgs[1]) ? (callArgs[1] as string[]) : undefined;
      const cb = callArgs.find((arg): arg is (...cbArgs: unknown[]) => void => typeof arg === 'function');
      if (isFakeCodexVersion(cmd, args)) {
        if (cb) {
          queueMicrotask(() => cb(null, 'codex-cli 0.163.0\n', ''));
        }
        return {} as never;
      }
      return (actual.execFile as (...fnArgs: unknown[]) => unknown)(...callArgs);
    }),
    {
      [promisify.custom]: (cmd: string, args?: readonly string[] | null, options?: unknown) => {
        if (isFakeCodexVersion(cmd, args)) {
          return Promise.resolve({ stdout: 'codex-cli 0.163.0\n', stderr: '' });
        }
        return (actualExecFileP as (...fnArgs: unknown[]) => Promise<{ stdout: string; stderr: string }>)(cmd, args, options);
      },
    },
  );
  return {
    ...actual,
    execFile: execFileMock,
    spawn: vi.fn((_cmd: unknown, args?: readonly string[]) => {
      if (Array.isArray(args) && args.includes('app-server')) {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const emitMsg = (msg: Record<string, unknown>) => {
          stdout.write(`${JSON.stringify(msg)}\n`);
        };
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdin: Writable;
          killed: boolean;
          kill: () => boolean;
        };
        const stdin = new Writable({
          write(chunk, _encoding, callback) {
            for (const line of chunk.toString().split('\n').filter(Boolean)) {
              const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, any> };
              codexHarness.requests.push(message);
              if (typeof message.id !== 'number') continue;
              if (message.method === 'initialize') {
                emitMsg({ id: message.id, result: { userAgent: 'codex-e2e-test' } });
              } else if (message.method === 'config/read') {
                emitMsg({ id: message.id, result: { config: { mcp_servers: {} } } });
              } else if (message.method === 'thread/start') {
                codexHarness.threadCounter += 1;
                const threadId = `codex-e2e-thread-${codexHarness.threadCounter}`;
                const ephemeral = message.params?.ephemeral === true;
                emitMsg({
                  id: message.id,
                  result: { thread: { id: threadId, ephemeral, path: ephemeral ? null : `/tmp/${threadId}.jsonl` } },
                });
                emitMsg({
                  method: 'thread/started',
                  params: { thread: { id: threadId, ephemeral, path: ephemeral ? null : `/tmp/${threadId}.jsonl` } },
                });
              } else if (message.method === 'thread/resume') {
                const threadId = String(message.params?.threadId ?? 'codex-e2e-thread-1');
                emitMsg({ id: message.id, result: { thread: { id: threadId } } });
              } else if (message.method === 'turn/start') {
                codexHarness.turnCounter += 1;
                const turnId = `codex-e2e-turn-${codexHarness.turnCounter}`;
                const threadId = String(message.params?.threadId ?? 'codex-e2e-thread-1');
                const inputText = String(message.params?.input?.[0]?.text ?? '');
                codexHarness.turns.push(inputText);
                const replyMatch = inputText.match(/(?:SECRET-TURN-[A-Za-z0-9_-]+|ORDINARY-AFTER-PRIVATE)/);
                const replyTag = replyMatch ? replyMatch[0] : inputText.slice(0, 40);
                emitMsg({
                  id: message.id,
                  result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } },
                });
                setImmediate(() => {
                  emitMsg({
                    method: 'item/agentMessage/delta',
                    params: { threadId, turnId, itemId: `msg-${turnId}`, delta: `REPLY:${replyTag}` },
                  });
                  emitMsg({
                    method: 'turn/completed',
                    params: { threadId, turn: { id: turnId, status: 'completed', items: [] } },
                  });
                });
              } else if (message.method === 'mcpServerStatus/list') {
                emitMsg({ id: message.id, result: { data: [] } });
              } else if (message.method === 'config/mcpServer/reload') {
                emitMsg({ id: message.id, result: {} });
              } else if (message.method === 'thread/unsubscribe') {
                emitMsg({ id: message.id, result: { status: 'unsubscribed' } });
              } else if (message.method === 'turn/interrupt' || message.method === 'thread/compact/start') {
                emitMsg({ id: message.id, result: {} });
              }
            }
            callback();
          },
        });
        Object.assign(child, { stdout, stderr, stdin, killed: false });
        child.kill = () => {
          child.killed = true;
          setImmediate(() => child.emit('exit', null, 'SIGTERM'));
          return true;
        };
        return child as never;
      }

      const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: () => boolean };
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        setImmediate(() => child.emit('exit', null, 'SIGTERM'));
        return true;
      };
      return child as never;
    }),
  };
});

vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(async () => ({ availableModels: ['gpt-5.4'], models: [{ id: 'gpt-5.4' }] })),
  getCodexBaseInstructions: vi.fn(async () => '[catalog-prompt]'),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: Record<string, unknown> }) => {
    sdkHarness.calls.push({ options: { ...args.options } });
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'cc-priv-sid', model: 'claude-sonnet-4-6' };
      for await (const userMsg of args.prompt) {
        const text = typeof userMsg.message.content === 'string'
          ? userMsg.message.content
          : JSON.stringify(userMsg.message.content);
        sdkHarness.turns.push(text);
        yield {
          type: 'assistant',
          session_id: 'cc-priv-sid',
          message: { id: `msg-${sdkHarness.turns.length}`, role: 'assistant', content: [{ type: 'text', text: `REPLY:${text}` }], stop_reason: 'end_turn' },
        };
        yield {
          type: 'result',
          session_id: 'cc-priv-sid',
          subtype: 'success',
          is_error: false,
          result: `REPLY:${text}`,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
    })();
    return Object.assign(stream, {
      interrupt: vi.fn(async () => {}),
      close: vi.fn(),
      supportedCommands: vi.fn(async () => []),
      supportedModels: vi.fn(async () => []),
      setPermissionMode: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
    });
  }),
}));

import { SESSION_INCOGNITO_MEMORY_DISABLED, SESSION_INCOGNITO_UNSUPPORTED } from '../../shared/session-incognito-types.js';
import { setSessionIncognito } from '../../shared/session-incognito-context.js';
import { handleWebCommand, type ServerLink } from '../../src/daemon/command-handler.js';
import { stopProject, getTransportRuntime, resetProviderRegistryForTests } from '../../src/agent/session-manager.js';
import { resetSessionStoreAuthorityForTests, loadStore, flushStore, getSession, removeSession } from '../../src/store/session-store.js';
import { getTransportQueueStore, resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
import { timelineProjection } from '../../src/daemon/timeline-projection.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { flushTransportHistory, replayTransportHistory } from '../../src/daemon/transport-history.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';

async function waitFor(fn: () => boolean, timeoutMs = 4000, describeFailure?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(describeFailure ? describeFailure() : 'Timed out waiting for condition');
}

describe('daemon incognito end-to-end lifecycle (F3)', () => {
  let tempHome = '';
  let workDir = '';
  let prevHome: string | undefined;
  let prevImcodesHome: string | undefined;
  let prevCodexHome: string | undefined;

  beforeEach(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'incognito-e2e-'));
    workDir = join(tempHome, 'proj');
    mkdirSync(workDir, { recursive: true });
    prevHome = process.env.HOME;
    prevImcodesHome = process.env.IMCODES_HOME;
    prevCodexHome = process.env.CODEX_HOME;
    process.env.HOME = tempHome;
    process.env.IMCODES_HOME = join(tempHome, '.imcodes');
    mkdirSync(join(process.env.IMCODES_HOME, 'transport'), { recursive: true });
    process.env.CODEX_HOME = join(tempHome, '.codex');
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    writeFileSync(
      join(process.env.CODEX_HOME, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'opaque-test-token', refresh_token: 'opaque-test-refresh' } }),
    );
    sdkHarness.calls.length = 0;
    sdkHarness.turns.length = 0;
    codexHarness.requests.length = 0;
    codexHarness.turns.length = 0;
    codexHarness.threadCounter = 0;
    codexHarness.turnCounter = 0;
    resetProviderRegistryForTests?.();
    resetTransportQueueStoreForTests();
    resetSessionStoreAuthorityForTests();
    await loadStore();
  });

  afterEach(async () => {
    timelineEmitter.forgetSession('deck_privmode_brain');
    await flushTransportHistory();
    await timelineStore.drainAll();
    await timelineProjection.drain(5_000);
    await timelineProjection.shutdown();
    const usageDrain = await timelineEmitter.drainUsageWrites(5_000);
    if (usageDrain.abandoned > 0) {
      throw new Error(`Aborted tempHome cleanup with ${usageDrain.abandoned} pending usage writes`);
    }
    if (timelineStore.getPendingSessionCount() > 0) {
      throw new Error(`Aborted tempHome cleanup with ${timelineStore.getPendingSessionCount()} pending timeline chains`);
    }
    resetContextStoreClientForTests();
    setSessionIncognito('deck_privmode_brain', false);
    removeSession('deck_privmode_brain');
    resetProviderRegistryForTests?.();
    resetTransportQueueStoreForTests();
    await flushStore().catch(() => {});
    process.env.HOME = prevHome;
    if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
    else process.env.IMCODES_HOME = prevImcodesHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('rejects unsupported runtime and uncapable server fail-closed', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const linkNoCap = {
      send: (msg: Record<string, unknown>) => sent.push(msg),
      supportsIncognitoSessions: () => false,
    } as unknown as ServerLink;

    handleWebCommand({
      type: 'session.start',
      project: 'privmode',
      dir: workDir,
      agentType: 'claude-code-sdk',
      incognito: true,
    }, linkNoCap);
    await waitFor(() => sent.some((m) => m.type === 'session.error'));
    expect(sent.find((m) => m.type === 'session.error')?.message).toBe(SESSION_INCOGNITO_UNSUPPORTED);
    expect(getSession('deck_privmode_brain')).toBeUndefined();

    sent.length = 0;
    const linkCap = {
      send: (msg: Record<string, unknown>) => sent.push(msg),
      supportsIncognitoSessions: () => true,
    } as unknown as ServerLink;
    handleWebCommand({
      type: 'session.start',
      project: 'privmode',
      dir: workDir,
      agentType: 'claude-code',
      incognito: true,
    }, linkCap);
    await waitFor(() => sent.some((m) => m.type === 'session.error'));
    expect(sent.find((m) => m.type === 'session.error')?.message).toBe(SESSION_INCOGNITO_UNSUPPORTED);
    expect(getSession('deck_privmode_brain')).toBeUndefined();
  });

  it('runs incognito claude-code-sdk end-to-end with RAM-only queue/timeline, persistSession:false, MCP block, clean teardown, and normal reuse recovery', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const off = timelineEmitter.on((ev) => {
      if (ev.sessionId === 'deck_privmode_brain') {
        emittedEvents.push({ type: ev.type, payload: ev.payload });
      }
    });

    const link = {
      send: (msg: Record<string, unknown>) => sent.push(msg),
      supportsIncognitoSessions: () => true,
      sendTimelineEvent: vi.fn(),
    } as unknown as ServerLink;

    try {
      // 1. Start incognito session via handleWebCommand
      handleWebCommand({
        type: 'session.start',
        project: 'privmode',
        dir: workDir,
        agentType: 'claude-code-sdk',
        incognito: true,
      }, link);

      await waitFor(() => {
        const err = sent.find((m) => m.type === 'session.error');
        if (err) throw new Error(`Unexpected session.error: ${JSON.stringify(err)}`);
        return Boolean(getTransportRuntime('deck_privmode_brain')) && getSession('deck_privmode_brain')?.agentType === 'claude-code-sdk';
      });
      expect(getSession('deck_privmode_brain')?.incognito).toBe(true);

      // 2. RAM-only queue enqueue & cancel for private session must never touch disk transport-queue.sqlite
      const queueStore = getTransportQueueStore();
      const recipient = (getTransportRuntime('deck_privmode_brain') as unknown as { recipientIdentity?: { sessionInstanceId: string; runtimeEpoch: string } })?.recipientIdentity;
      const snap = queueStore.enqueue({
        sessionName: 'deck_privmode_brain',
        recipient,
        clientMessageId: 'priv-q-1',
        text: 'SECRET-QUEUED-PROMPT',
      });
      expect(snap.pendingMessageEntries).toHaveLength(1);
      expect(queueStore.readSnapshotSafely('deck_privmode_brain').pendingMessageEntries).toHaveLength(1);
      const cancelRes = queueStore.cancelQueuedMessage('deck_privmode_brain', 'priv-q-1', recipient);
      expect(cancelRes.status).toBe('accepted');
      expect(queueStore.readSnapshotSafely('deck_privmode_brain').pendingMessageEntries).toHaveLength(0);
      const diskQueuePath = join(process.env.IMCODES_HOME!, 'transport-queue.sqlite');
      if (existsSync(diskQueuePath)) {
        // If disk db was initialized for other calls, verify ZERO rows for deck_privmode_brain
        expect(readFileSync(diskQueuePath).toString('utf8')).not.toContain('SECRET-QUEUED-PROMPT');
      }

      // 3. Drive 2 live turns via handleWebCommand session.send
      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_privmode_brain',
        text: 'SECRET-TURN-ONE',
        commandId: 'cmd-priv-1',
      }, link);
      await waitFor(
        () => sdkHarness.turns.some((t) => t.includes('SECRET-TURN-ONE')),
        4000,
        () => `Missing turn 1; turns=${JSON.stringify(sdkHarness.turns)}`,
      );
      await waitFor(
        () => emittedEvents.some((e) => e.type === 'assistant.text' && String(e.payload.text ?? '').includes('REPLY:') && String(e.payload.text ?? '').includes('SECRET-TURN-ONE') && e.payload.streaming === false),
        4000,
        () => `Missing REPLY 1; events=${JSON.stringify(emittedEvents)}`,
      );

      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_privmode_brain',
        text: 'SECRET-TURN-TWO',
        commandId: 'cmd-priv-2',
      }, link);
      await waitFor(
        () => sdkHarness.turns.some((t) => t.includes('SECRET-TURN-TWO')),
        4000,
        () => `Missing turn 2; turns=${JSON.stringify(sdkHarness.turns)}; events=${JSON.stringify(emittedEvents)}`,
      );
      await waitFor(
        () => emittedEvents.some((e) => e.type === 'assistant.text' && String(e.payload.text ?? '').includes('SECRET-TURN-TWO') && e.payload.streaming === false),
        4000,
        () => `Missing REPLY:SECRET-TURN-TWO; turns=${JSON.stringify(sdkHarness.turns)}; events=${JSON.stringify(emittedEvents)}`,
      );

      // Check Claude Agent SDK received persistSession: false and empty mcpServers
      expect(sdkHarness.calls.length).toBeGreaterThan(0);
      expect(sdkHarness.calls[0]?.options.persistSession).toBe(false);
      expect(sdkHarness.calls[0]?.options.mcpServers).toEqual({});

      // Check memory MCP tools refuse calls for this incognito session
      const handlers = createMemoryMcpToolHandlers({
        userId: 'u',
        sessionName: 'deck_privmode_brain',
        projectName: 'privmode',
        projectRoot: workDir,
      });
      const obsRes = await handlers.save_observation({ content: 'SECRET-OBS', toolSummary: 'Save' } as any);
      expect(JSON.stringify(obsRes)).toContain(SESSION_INCOGNITO_MEMORY_DISABLED);

      // Flush timelineStore and assert zero disk writes in sessions.sqlite / timeline / transport
      await timelineStore.flushSession('deck_privmode_brain');
      await flushStore();
      expect(existsSync(join(process.env.IMCODES_HOME!, 'transport', 'deck_privmode_brain.jsonl'))).toBe(false);
      expect(await replayTransportHistory('deck_privmode_brain')).toEqual([]);
      expect(timelineStore.read('deck_privmode_brain')).toEqual([]);

      // Stop session -> RAM state wiped, non-recoverable after restart
      await stopProject('privmode', link);
      expect(getSession('deck_privmode_brain')).toBeUndefined();
      const remainingBuffered = timelineEmitter.getBufferedEvents('deck_privmode_brain');
      expect(remainingBuffered.filter((e) => !(e.type === 'session.state' && e.payload.state === 'stopped'))).toEqual([]);
      expect(JSON.stringify(remainingBuffered)).not.toContain('SECRET');
      expect(new (timelineEmitter.constructor as any)().replay('deck_privmode_brain', 0).events).toEqual([]);

      // 4. Launch a new ordinary session with the same project name -> recovers normal persistence!
      handleWebCommand({
        type: 'session.start',
        project: 'privmode',
        dir: workDir,
        agentType: 'claude-code-sdk',
      }, link);
      await waitFor(() => {
        const err = sent.find((m) => m.type === 'session.error');
        if (err) throw new Error(`Unexpected session.error: ${JSON.stringify(err)}`);
        return Boolean(getTransportRuntime('deck_privmode_brain')) && getSession('deck_privmode_brain')?.agentType === 'claude-code-sdk';
      });
      expect(getSession('deck_privmode_brain')?.incognito).not.toBe(true);

      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_privmode_brain',
        text: 'ORDINARY-AFTER-PRIVATE',
        commandId: 'cmd-norm-1',
      }, link);
      await waitFor(() => sdkHarness.turns.includes('ORDINARY-AFTER-PRIVATE'));
      await waitFor(() => emittedEvents.some((e) => e.type === 'assistant.text' && e.payload.text === 'REPLY:ORDINARY-AFTER-PRIVATE'));

      await timelineStore.flushSession('deck_privmode_brain');
      const replayedNormal = await replayTransportHistory('deck_privmode_brain');
      expect(replayedNormal.some((e) => e.text === 'REPLY:ORDINARY-AFTER-PRIVATE')).toBe(true);
      expect(JSON.stringify(replayedNormal)).not.toContain('SECRET-TURN');
      await stopProject('privmode', link);
    } finally {
      off();
    }
  });

  it('runs full codex-sdk incognito lifecycle from command-handler through runtime with zero leaks, then normal codex-sdk recovers persistence', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const link = {
      send: (msg: Record<string, unknown>) => sent.push(msg),
      supportsIncognitoSessions: () => true,
    } as unknown as ServerLink;

    const emittedEvents: Array<{ sessionId: string; type: string; payload: Record<string, unknown> }> = [];
    const off = timelineEmitter.on((ev) => {
      if (ev.sessionId === 'deck_privmode_brain') emittedEvents.push(ev);
    });

    try {
      handleWebCommand({
        type: 'session.start',
        project: 'privmode',
        dir: workDir,
        agentType: 'codex-sdk',
        incognito: true,
      }, link);

      await waitFor(() => {
        const err = sent.find((m) => m.type === 'session.error');
        if (err) throw new Error(`Unexpected session.error: ${JSON.stringify(err)}`);
        return Boolean(getTransportRuntime('deck_privmode_brain')) && getSession('deck_privmode_brain')?.agentType === 'codex-sdk';
      });
      const rec = getSession('deck_privmode_brain');
      expect(rec?.incognito).toBe(true);
      expect(rec?.agentType).toBe('codex-sdk');

      handleWebCommand({ type: 'get_sessions' }, link);
      await waitFor(() => sent.some((m) => m.type === 'session_list'));
      const sessionListMsg = [...sent].reverse().find((m) => m.type === 'session_list');
      const listEntry = (sessionListMsg?.sessions as Array<Record<string, unknown>> | undefined)?.find((s) => s.name === 'deck_privmode_brain');
      expect(listEntry?.incognito).toBe(true);

      // Drive 2 live turns via command-handler session.send
      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_privmode_brain',
        text: 'SECRET-TURN-CODEX-1',
        commandId: 'cmd-codex-priv-1',
      }, link);
      await waitFor(
        () => codexHarness.turns.some((t) => t.includes('SECRET-TURN-CODEX-1')),
        4000,
        () => `Missing codex turn 1; turns=${JSON.stringify(codexHarness.turns)}`,
      );
      await waitFor(
        () => emittedEvents.some((e) => e.type === 'assistant.text' && String(e.payload.text ?? '').includes('REPLY:SECRET-TURN-CODEX-1') && e.payload.streaming === false),
        4000,
        () => `Missing codex REPLY 1; events=${JSON.stringify(emittedEvents)}`,
      );

      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_privmode_brain',
        text: 'SECRET-TURN-CODEX-2',
        commandId: 'cmd-codex-priv-2',
      }, link);
      await waitFor(
        () => codexHarness.turns.some((t) => t.includes('SECRET-TURN-CODEX-2')),
        4000,
        () => `Missing codex turn 2; turns=${JSON.stringify(codexHarness.turns)}`,
      );
      await waitFor(
        () => emittedEvents.some((e) => e.type === 'assistant.text' && String(e.payload.text ?? '').includes('REPLY:SECRET-TURN-CODEX-2') && e.payload.streaming === false),
        4000,
        () => `Missing codex REPLY 2; events=${JSON.stringify(emittedEvents)}`,
      );

      // Assert protocol invariants: ephemeral:true, zero mcp_servers, single thread/start, zero thread/resume, zero persisted codexSessionId
      const threadStarts = codexHarness.requests.filter((r) => r.method === 'thread/start');
      expect(threadStarts).toHaveLength(1);
      expect(threadStarts[0]?.params?.ephemeral).toBe(true);
      expect(threadStarts[0]?.params?.config?.mcp_servers).toBeUndefined();
      expect(codexHarness.requests.some((r) => r.method === 'thread/resume')).toBe(false);
      expect(getSession('deck_privmode_brain')?.codexSessionId).toBeUndefined();

      // Check memory MCP tools refuse calls
      const handlers = createMemoryMcpToolHandlers({
        userId: 'u',
        sessionName: 'deck_privmode_brain',
        projectName: 'privmode',
        projectRoot: workDir,
      });
      const obsRes = await handlers.save_observation({ content: 'SECRET-CODEX-OBS', toolSummary: 'Save' } as any);
      expect(JSON.stringify(obsRes)).toContain(SESSION_INCOGNITO_MEMORY_DISABLED);

      // Flush and verify zero disk/timeline/transport persistence
      await timelineStore.flushSession('deck_privmode_brain');
      await flushStore();
      expect(existsSync(join(process.env.IMCODES_HOME!, 'transport', 'deck_privmode_brain.jsonl'))).toBe(false);
      expect(await replayTransportHistory('deck_privmode_brain')).toEqual([]);
      expect(timelineStore.read('deck_privmode_brain')).toEqual([]);

      await stopProject('privmode', link);
      expect(getSession('deck_privmode_brain')).toBeUndefined();
      const remainingBuffered = timelineEmitter.getBufferedEvents('deck_privmode_brain');
      expect(remainingBuffered.filter((e) => !(e.type === 'session.state' && e.payload.state === 'stopped'))).toEqual([]);
      expect(JSON.stringify(remainingBuffered)).not.toContain('SECRET');

      // Launch ordinary codex-sdk session -> recovers normal persistence, mcp_servers, codexSessionId, non-ephemeral thread
      codexHarness.requests.length = 0;
      handleWebCommand({
        type: 'session.start',
        project: 'privmode',
        dir: workDir,
        agentType: 'codex-sdk',
      }, link);
      await waitFor(() => {
        const err = sent.find((m) => m.type === 'session.error');
        if (err) throw new Error(`Unexpected session.error: ${JSON.stringify(err)}`);
        return Boolean(getTransportRuntime('deck_privmode_brain')) && getSession('deck_privmode_brain')?.agentType === 'codex-sdk';
      });
      expect(getSession('deck_privmode_brain')?.incognito).not.toBe(true);

      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_privmode_brain',
        text: 'ORDINARY-AFTER-PRIVATE',
        commandId: 'cmd-codex-norm-1',
      }, link);
      await waitFor(() => codexHarness.turns.includes('ORDINARY-AFTER-PRIVATE'));
      await waitFor(() => emittedEvents.some((e) => e.type === 'assistant.text' && e.payload.text === 'REPLY:ORDINARY-AFTER-PRIVATE' && e.payload.streaming === false));

      const normalStart = codexHarness.requests.find((r) => r.method === 'thread/start');
      expect(normalStart?.params?.ephemeral).toBeUndefined();
      expect(normalStart?.params?.config?.mcp_servers?.['imcodes-memory']).toBeDefined();
      expect(getSession('deck_privmode_brain')?.codexSessionId).toMatch(/^codex-e2e-thread-/);

      await timelineStore.flushSession('deck_privmode_brain');
      const replayedNormal = await replayTransportHistory('deck_privmode_brain');
      expect(replayedNormal.some((e) => e.text === 'REPLY:ORDINARY-AFTER-PRIVATE')).toBe(true);
      expect(JSON.stringify(replayedNormal)).not.toContain('SECRET-TURN');

      await stopProject('privmode', link);
    } finally {
      off();
    }
  });
});
