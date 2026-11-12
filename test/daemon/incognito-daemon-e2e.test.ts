import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const sdkHarness = vi.hoisted(() => ({
  calls: [] as Array<{ options: Record<string, unknown> }>,
  turns: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
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
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { replayTransportHistory } from '../../src/daemon/transport-history.js';
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

  beforeEach(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'incognito-e2e-'));
    workDir = join(tempHome, 'proj');
    mkdirSync(workDir, { recursive: true });
    prevHome = process.env.HOME;
    prevImcodesHome = process.env.IMCODES_HOME;
    process.env.HOME = tempHome;
    process.env.IMCODES_HOME = join(tempHome, '.imcodes');
    sdkHarness.calls.length = 0;
    sdkHarness.turns.length = 0;
    resetProviderRegistryForTests?.();
    resetTransportQueueStoreForTests();
    resetSessionStoreAuthorityForTests();
    await loadStore();
  });

  afterEach(async () => {
    setSessionIncognito('deck_privmode_brain', false);
    removeSession('deck_privmode_brain');
    timelineEmitter.forgetSession('deck_privmode_brain');
    resetTransportQueueStoreForTests();
    await flushStore().catch(() => {});
    process.env.HOME = prevHome;
    if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
    else process.env.IMCODES_HOME = prevImcodesHome;
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
        return Boolean(getTransportRuntime('deck_privmode_brain'));
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
        return Boolean(getTransportRuntime('deck_privmode_brain'));
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
    } finally {
      off();
    }
  });
});
