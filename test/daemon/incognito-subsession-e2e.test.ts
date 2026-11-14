import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

const sdkHarness = vi.hoisted(() => ({
  calls: [] as Array<{ options: Record<string, unknown> }>,
  turns: [] as string[],
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
        if (cb) queueMicrotask(() => cb(null, 'codex-cli 0.163.0\n', ''));
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
    spawn: vi.fn((_cmd: unknown, _args?: readonly string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: Writable;
        killed: boolean;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
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

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: Record<string, unknown> }) => {
    sdkHarness.calls.push({ options: { ...args.options } });
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'cc-sub-priv-sid', model: 'claude-sonnet-4-6' };
      for await (const userMsg of args.prompt) {
        const text = typeof userMsg.message.content === 'string'
          ? userMsg.message.content
          : JSON.stringify(userMsg.message.content);
        sdkHarness.turns.push(text);
        yield {
          type: 'assistant',
          session_id: 'cc-sub-priv-sid',
          message: { id: `msg-${sdkHarness.turns.length}`, role: 'assistant', content: [{ type: 'text', text: `REPLY:${text}` }], stop_reason: 'end_turn' },
        };
        yield {
          type: 'result',
          session_id: 'cc-sub-priv-sid',
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
import { getTransportRuntime, resetProviderRegistryForTests } from '../../src/agent/session-manager.js';
import { resetSessionStoreAuthorityForTests, loadStore, flushStore, getSession, removeSession } from '../../src/store/session-store.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
import { timelineProjection } from '../../src/daemon/timeline-projection.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { flushTransportHistory, replayTransportHistory } from '../../src/daemon/transport-history.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { stopSubSession } from '../../src/daemon/subsession-manager.js';

async function waitFor(fn: () => boolean, timeoutMs = 4000, describeFailure?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(describeFailure ? describeFailure() : 'Timed out waiting for condition');
}

describe('daemon sub-session incognito lifecycle', () => {
  let tempHome = '';
  let workDir = '';
  let prevHome: string | undefined;
  let prevImcodesHome: string | undefined;

  beforeEach(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'subsession-incog-e2e-'));
    workDir = join(tempHome, 'proj');
    mkdirSync(workDir, { recursive: true });
    prevHome = process.env.HOME;
    prevImcodesHome = process.env.IMCODES_HOME;
    process.env.HOME = tempHome;
    process.env.IMCODES_HOME = join(tempHome, '.imcodes');
    mkdirSync(join(process.env.IMCODES_HOME, 'transport'), { recursive: true });
    sdkHarness.calls.length = 0;
    sdkHarness.turns.length = 0;
    resetProviderRegistryForTests?.();
    resetTransportQueueStoreForTests();
    resetSessionStoreAuthorityForTests();
    await loadStore();
  });

  afterEach(async () => {
    for (const sName of ['deck_sub_subpriv1', 'deck_sub_subsh01', 'deck_sub_subnocap']) {
      timelineEmitter.forgetSession(sName);
      setSessionIncognito(sName, false);
      removeSession(sName);
    }
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
    resetProviderRegistryForTests?.();
    resetTransportQueueStoreForTests();
    await flushStore().catch(() => {});
    process.env.HOME = prevHome;
    if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
    else process.env.IMCODES_HOME = prevImcodesHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('rejects unsupported sub-session runtime or uncapable server fail-closed and keeps stop idempotent', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const linkNoCap = {
      send: (msg: Record<string, unknown>) => sent.push(msg),
      supportsIncognitoSessions: () => false,
    } as unknown as ServerLink;

    handleWebCommand({
      type: 'subsession.start',
      id: 'subnocap',
      sessionType: 'claude-code-sdk',
      cwd: workDir,
      parentSession: 'deck_main_brain',
      incognito: true,
    }, linkNoCap);
    await waitFor(() => sent.some((m) => m.type === 'session.error') && sent.some((m) => m.type === 'subsession.closed'));
    expect(sent.find((m) => m.type === 'session.error')).toMatchObject({
      type: 'session.error',
      message: SESSION_INCOGNITO_UNSUPPORTED,
      id: 'subnocap',
      session: 'deck_sub_subnocap',
      sessionName: 'deck_sub_subnocap',
      project: 'deck_main_brain',
    });
    expect(sent.find((m) => m.type === 'subsession.closed')).toMatchObject({
      type: 'subsession.closed',
      id: 'subnocap',
      sessionName: 'deck_sub_subnocap',
      incognito: true,
    });
    expect(getSession('deck_sub_subnocap')).toBeUndefined();

    // Closing a rejected/non-existent ephemeral sub-session is idempotent and notifies bridge
    sent.length = 0;
    const stopRes = await stopSubSession('deck_sub_subnocap', linkNoCap);
    expect(stopRes.ok).toBe(true);
    expect(sent).toContainEqual({
      type: 'subsession.closed',
      id: 'subnocap',
      sessionName: 'deck_sub_subnocap',
    });

    sent.length = 0;
    const linkCap = {
      send: (msg: Record<string, unknown>) => sent.push(msg),
      supportsIncognitoSessions: () => true,
    } as unknown as ServerLink;

    handleWebCommand({
      type: 'subsession.start',
      id: 'subsh01',
      sessionType: 'shell',
      cwd: workDir,
      incognito: true,
    }, linkCap);
    await waitFor(() => sent.some((m) => m.type === 'session.error') && sent.some((m) => m.type === 'subsession.closed'));
    expect(sent.find((m) => m.type === 'session.error')).toMatchObject({
      type: 'session.error',
      message: SESSION_INCOGNITO_UNSUPPORTED,
      id: 'subsh01',
      session: 'deck_sub_subsh01',
      sessionName: 'deck_sub_subsh01',
    });
    expect(getSession('deck_sub_subsh01')).toBeUndefined();
  });

  it('runs incognito sub-session without subsession.sync, disk writes, MCP memory, or restart resurrection', async () => {
    const sessionName = 'deck_sub_subpriv1';
    const sent: Array<Record<string, unknown>> = [];
    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const off = timelineEmitter.on((ev) => {
      if (ev.sessionId === sessionName) {
        emittedEvents.push({ type: ev.type, payload: ev.payload });
      }
    });

    const link = {
      send: (msg: Record<string, unknown>) => sent.push(msg),
      supportsIncognitoSessions: () => true,
      sendTimelineEvent: vi.fn(),
    } as unknown as ServerLink;

    try {
      handleWebCommand({
        type: 'subsession.start',
        id: 'subpriv1',
        sessionType: 'claude-code-sdk',
        cwd: workDir,
        label: 'Secret Sub',
        parentSession: 'deck_main_brain',
        incognito: true,
      }, link);

      await waitFor(() => Boolean(getTransportRuntime(sessionName)), 4000, () => `sent=${JSON.stringify(sent)}`);
      const rec = getSession(sessionName);
      expect(rec?.incognito).toBe(true);
      expect(sent.some((m) => m.type === 'subsession.sync')).toBe(false);

      handleWebCommand({
        type: 'session.send',
        sessionName,
        text: 'SECRET-SUB-TURN-1',
        commandId: 'cmd-sub-1',
      }, link);
      await waitFor(() => sdkHarness.turns.includes('SECRET-SUB-TURN-1'));
      await waitFor(() => emittedEvents.some((e) => e.type === 'assistant.text' && e.payload.text === 'REPLY:SECRET-SUB-TURN-1' && e.payload.streaming === false));

      expect(sdkHarness.calls).toHaveLength(1);
      expect(sdkHarness.calls[0]?.options.persistSession).toBe(false);
      const mcpServers = (sdkHarness.calls[0]?.options.mcpServers as Record<string, unknown> | undefined) ?? {};
      expect(mcpServers['imcodes-memory']).toBeUndefined();

      const handlers = createMemoryMcpToolHandlers({
        userId: 'u',
        sessionName,
        projectName: 'sub_subpriv1',
        projectRoot: workDir,
      });
      const obsRes = await handlers.save_observation({ content: 'SECRET-SUB-OBS', toolSummary: 'Save' } as any);
      expect(JSON.stringify(obsRes)).toContain(SESSION_INCOGNITO_MEMORY_DISABLED);

      // Flush and verify zero timeline/transport persistence
      await timelineStore.flushSession(sessionName);
      await flushStore();
      expect(existsSync(join(process.env.IMCODES_HOME!, 'transport', `${sessionName}.jsonl`))).toBe(false);
      expect(await replayTransportHistory(sessionName)).toEqual([]);
      expect(timelineStore.read(sessionName)).toEqual([]);

      // Setting model or typechange on incognito sub-session is refused
      sent.length = 0;
      handleWebCommand({
        type: 'subsession.set_model',
        sessionName,
        model: 'claude-opus-4-6',
      }, link);
      await waitFor(() => sent.some((m) => m.type === 'session.error'));
      expect(sent.find((m) => m.type === 'session.error')?.message).toBe(SESSION_INCOGNITO_UNSUPPORTED);

      // Stop/close clears ephemeral store and emits closed/removed
      sent.length = 0;
      await stopSubSession(sessionName, link);
      expect(getSession(sessionName)).toBeUndefined();
      expect(sent.some((m) => m.type === 'subsession.closed' && m.id === 'subpriv1' && m.sessionName === sessionName)).toBe(true);
      const remainingBuffered = timelineEmitter.getBufferedEvents(sessionName);
      expect(remainingBuffered.filter((e) => !(e.type === 'session.state' && e.payload.state === 'stopped'))).toEqual([]);
      expect(JSON.stringify(remainingBuffered)).not.toContain('SECRET-SUB');

      // Rebuild must not resurrect dead incognito sub-session
      sent.length = 0;
      handleWebCommand({
        type: 'subsession.rebuild_all',
        subSessions: [{
          id: 'subpriv1',
          type: 'claude-code-sdk',
          cwd: workDir,
          incognito: true,
        }],
      }, link);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(getSession(sessionName)).toBeUndefined();
      expect(getTransportRuntime(sessionName)).toBeUndefined();
    } finally {
      off();
    }
  });
});
