/**
 * Tests for the DeepSeek Harness transport provider.
 *
 * The provider drives a long-lived `dsh` child whose mounted bridge plugin
 * speaks NDJSON over stdio. These tests replace that child with a scripted fake
 * so the whole event mapping — deltas, committed text, tools, usage, resume id,
 * cancellation — is asserted without the harness or a model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const { spawnMock, writeDshOverlayMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  writeDshOverlayMock: vi.fn().mockResolvedValue('/tmp/overlay.patch.json'),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('../../src/agent/providers/deepseek-harness/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/providers/deepseek-harness/runtime.js')>();
  return { ...actual, writeDshOverlay: writeDshOverlayMock };
});

import { DeepseekHarnessProvider } from '../../src/agent/providers/deepseek-harness.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { dispatchSharedContextSend } from '../../src/agent/transport-runtime-assembly.js';
import {
  DSH_AGENT_DEFAULT_MODEL_ROW_ID,
  DSH_BRIDGE_COMMAND,
  DSH_BRIDGE_EVENT,
  DSH_BRIDGE_MODEL_ENV,
  DSH_BRIDGE_RESUME_ENV,
  DSH_BRIDGE_TOOL_STATUS,
  DSH_BRIDGE_TURN_REASON,
  DSH_LLM_PI_AI_ROW_ID,
  DSH_PROVIDER_API_KEY_ENV,
  type DshBridgeEvent,
} from '../../shared/deepseek-harness.js';
import {
  buildDshOverlay,
  DSH_DISABLED_ROW_IDS,
  DSH_MCP_CLIENT_PACKAGE,
  DSH_MEMORY_MCP_ROW_ID,
  DSH_NATIVE_AGENT_ROW_IDS,
  DSH_SANDBOX_POLICY_ROW_ID,
} from '../../src/agent/providers/deepseek-harness/runtime.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../shared/session-control-commands.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../shared/agent-message.js';

/** Fake `dsh` child: stdout is the bridge's event stream, stdin captures commands. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly written: string[] = [];
  /** When true, mimic the real bridge exiting on shutdown instead of hanging. */
  exitOnShutdown = true;
  // An EventEmitter because the provider installs an 'error' listener: stdin
  // EPIPE is asynchronous and would be an uncaught exception without one.
  stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: (chunk: string) => {
      this.written.push(chunk);
      if (this.exitOnShutdown && chunk.includes(`"${DSH_BRIDGE_COMMAND.SHUTDOWN}"`)) {
        setImmediate(() => { this.emit('exit', 0, null); this.emit('close', 0, null); });
      }
      return true;
    },
  });
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, null);
    // killProcessTree waits on 'close', which a real child emits after 'exit'.
    this.emit('close', 0, null);
    return true;
  }

  /** Push one bridge frame onto stdout. */
  emitEvent(event: DshBridgeEvent): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  /** Commands the provider wrote, parsed. */
  commands(): Array<Record<string, unknown>> {
    return this.written.map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
  }
}

const HARNESS_SESSION_ID = 'session-abc-123';

function readyFrame(overrides: Partial<Extract<DshBridgeEvent, { type: 'ready' }>> = {}): DshBridgeEvent {
  return {
    type: DSH_BRIDGE_EVENT.READY,
    sessionId: HARNESS_SESSION_ID,
    resumed: false,
    ...overrides,
  } as DshBridgeEvent;
}

/** Let queued stream data and microtasks drain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('DeepseekHarnessProvider', () => {
  let provider: DeepseekHarnessProvider;
  let child: FakeChild;
  let deltas: Array<{ sessionId: string; delta: MessageDelta }>;
  let completions: Array<{ sessionId: string; message: AgentMessage }>;
  let tools: Array<{ sessionId: string; tool: ToolCallEvent }>;
  let errors: Array<{ sessionId: string; error: { code: string; message: string } }>;
  let sessionInfos: Array<Record<string, unknown>>;
  let usages: Array<Record<string, unknown>>;

  beforeEach(() => {
    child = new FakeChild();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      // The provider awaits the ready frame before resolving send(); publish it
      // once the caller has attached its stdout reader.
      setImmediate(() => child.emitEvent(readyFrame()));
      return child;
    });
    writeDshOverlayMock.mockClear();

    provider = new DeepseekHarnessProvider();
    deltas = []; completions = []; tools = []; errors = []; sessionInfos = []; usages = [];
    provider.onDelta((sessionId, delta) => { deltas.push({ sessionId, delta }); });
    provider.onComplete((sessionId, message) => { completions.push({ sessionId, message }); });
    provider.onToolCall((sessionId, tool) => { tools.push({ sessionId, tool }); });
    provider.onError((sessionId, error) => { errors.push({ sessionId, error: error as { code: string; message: string } }); });
    provider.onSessionInfo((_sessionId, info) => { sessionInfos.push(info as Record<string, unknown>); });
    provider.onUsage((_sessionId, update) => { usages.push(update as unknown as Record<string, unknown>); });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function startSession(config: Record<string, unknown> = {}): Promise<string> {
    await provider.connect({});
    const sessionId = await provider.createSession({
      sessionKey: 'sess-1',
      sessionName: 'deck_test_brain',
      projectName: 'test',
      cwd: '/tmp',
      ...config,
    } as never);
    return sessionId;
  }

  it('reports managed memory MCP status once connected', () => {
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'deepseek-harness',
      status: 'unknown',
      connected: false,
    });
  });

  it('passes the session-scoped memory MCP server into the overlay', async () => {
    const sessionId = await startSession({ sessionName: 'deck_proj_brain', serverId: 'srv-1' });
    await provider.send(sessionId, 'hi');
    await flush();

    const overlay = writeDshOverlayMock.mock.calls[0][0] as { memoryMcp?: { env: Record<string, string> } };
    expect(overlay.memoryMcp).toBeDefined();
    // Identity env is what scopes memory writes to this session.
    expect(Object.keys(overlay.memoryMcp!.env).length).toBeGreaterThan(0);
  });

  it('declares a streaming, tool-calling, resumable local-SDK transport', () => {
    expect(provider.id).toBe('deepseek-harness');
    expect(provider.connectionMode).toBe('local-sdk');
    expect(provider.sessionOwnership).toBe('shared');
    expect(provider.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
      approval: false,
    });
  });

  it('resolves the harness binary through the Windows-aware spawn helper', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    await flush();

    // On POSIX this passes the name through; on Windows it rewrites the npm
    // .cmd shim to `node <script>`, which bare spawn() cannot execute.
    const [executable, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(typeof executable).toBe('string');
    expect(args).toEqual(expect.arrayContaining(['--profile', '--patch']));
  });

  it('spawns the harness on first send and reports the durable session id', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hello');
    await flush();

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(sessionInfos).toContainEqual(expect.objectContaining({ resumeId: HARNESS_SESSION_ID }));
    // `model` is the SessionInfoUpdate field session-manager reads; `agentId`
    // is silently dropped by that contract.
    expect(sessionInfos.some((info) => 'agentId' in info)).toBe(false);
    const prompts = child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain('hello');
  });

  it('steers an active turn at the next model boundary without canceling or FIFO follow-up', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'first task');
    await flush();

    await expect(provider.notifyActiveDelegation(sessionId, {
      text: 'append this now',
      sourceSession: 'deck_sub_source',
    })).resolves.toBe('delivered');

    expect(child.commands().filter((command) => command.type === DSH_BRIDGE_COMMAND.STEER)).toEqual([
      { type: DSH_BRIDGE_COMMAND.STEER, text: 'append this now' },
    ]);
    expect(child.commands().some((command) => command.type === DSH_BRIDGE_COMMAND.CANCEL)).toBe(false);
    expect(child.commands().some((command) => command.type === 'follow_up')).toBe(false);
  });

  it('does not acknowledge an append after the active bridge stdin is destroyed', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'first task');
    await flush();
    child.stdin.destroyed = true;

    await expect(provider.notifyActiveDelegation(sessionId, {
      text: 'must remain queued',
      sourceSession: 'deck_sub_source',
    })).resolves.toBe('stale');
    expect(child.commands().filter((command) => command.type === DSH_BRIDGE_COMMAND.STEER)).toEqual([]);
  });

  it('reuses one child across turns instead of respawning', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'first');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();
    await provider.send(sessionId, 'second');
    await flush();

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toHaveLength(2);
  });

  it('streams cumulative text and completes with the committed message', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.DELTA, text: 'Hel' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.DELTA, text: 'lo' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'Hello' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    // The relay renders delta.delta directly, so it must be the running total.
    expect(deltas.map((d) => d.delta.delta)).toEqual(['Hel', 'Hello']);
    expect(deltas[0].delta.messageId).toBe(deltas[1].delta.messageId);
    expect(completions).toHaveLength(1);
    expect(completions[0].message).toMatchObject({ content: 'Hello', status: 'complete', role: 'assistant' });
  });

  it('prefers the committed message over replayed deltas', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    // A retried request can stream text that never became part of the session.
    child.emitEvent({ type: DSH_BRIDGE_EVENT.DELTA, text: 'partial-retry-garbage' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'authoritative' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    expect(completions[0].message.content).toBe('authoritative');
  });

  it('still settles a tool-only turn that commits no assistant text', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'run a tool');
    child.emitEvent({
      type: DSH_BRIDGE_EVENT.TOOL, id: 'call_1', name: 'bash', status: DSH_BRIDGE_TOOL_STATUS.RUNNING,
    });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    // TransportSessionRuntime settles a dispatch ONLY from onComplete/onError.
    // Staying silent here would hold the turn open until the stale-turn
    // watchdog and queue every following message behind it.
    expect(completions).toHaveLength(1);
    expect(completions[0].message.content).toBe('');
  });

  it('joins every committed message of a multi-step turn', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'check then answer');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'Let me check that file.' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TOOL, id: 'c1', name: 'bash', status: DSH_BRIDGE_TOOL_STATUS.RUNNING });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'The answer is 42.' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    // Overwriting instead of accumulating would delete everything the model
    // said before its first tool call, since the relay replaces the streamed
    // bubble in place with this text.
    expect(completions[0].message.content).toBe('Let me check that file.The answer is 42.');
  });

  it('clears the transient status when a turn settles', async () => {
    const sessionId = await startSession();
    const statuses: Array<{ status: string | null }> = [];
    provider.onStatus((_s, st) => { statuses.push(st as { status: string | null }); });
    await provider.send(sessionId, 'hi');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.REASONING });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'done' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    // Without the clear, the dedupe signature stays pinned and the NEXT turn's
    // identical status is swallowed entirely.
    expect(statuses.at(-1)).toMatchObject({ status: null });
  });

  it('does not reuse the previous turn\'s token counts', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'one');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.USAGE, inputTokens: 12_000 });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'a' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    await provider.send(sessionId, 'two');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'b' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    expect(completions[1].message.metadata?.usage).toBeUndefined();
  });

  it('publishes a completed turn even when a cancel lost the race', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'finished answer' });
    await provider.cancel(sessionId);
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    // The harness said the turn completed, so the answer must not be discarded.
    expect(completions[0].message.content).toBe('finished answer');
    expect(errors).toHaveLength(0);
  });

  it('propagates role=tool tool/result frames from the bridge plugin through provider callbacks without duplication', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'run tool');
    child.emitEvent({
      type: DSH_BRIDGE_EVENT.TOOL, id: 'call_1', name: 'bash',
      status: DSH_BRIDGE_TOOL_STATUS.RUNNING, input: { command: 'echo hi' },
    });
    child.emitEvent({
      type: DSH_BRIDGE_EVENT.TOOL, id: 'call_1', name: '',
      status: DSH_BRIDGE_TOOL_STATUS.COMPLETE, output: 'hi\n',
    });
    child.emitEvent({
      type: DSH_BRIDGE_EVENT.TOOL, id: 'call_2', name: 'bash',
      status: DSH_BRIDGE_TOOL_STATUS.RUNNING,
    });
    child.emitEvent({
      type: DSH_BRIDGE_EVENT.TOOL, id: 'call_2', name: '',
      status: DSH_BRIDGE_TOOL_STATUS.ERROR, output: 'denied',
    });
    await flush();

    expect(tools).toHaveLength(4);
    expect(tools[0].tool).toMatchObject({ id: 'call_1', name: 'bash', status: 'running', input: { command: 'echo hi' } });
    expect(tools[1].tool).toMatchObject({ id: 'call_1', name: 'bash', status: 'complete', output: 'hi\n' });
    expect(tools[2].tool).toMatchObject({ id: 'call_2', name: 'bash', status: 'running' });
    expect(tools[3].tool).toMatchObject({ id: 'call_2', name: 'bash', status: 'error', output: 'denied' });
  });

  it('syncs usage model to SessionInfo and echoes the same model onto completion metadata', async () => {
    const sessionInfos: Array<Record<string, unknown>> = [];
    provider.onSessionInfo((_s, info) => { sessionInfos.push(info as Record<string, unknown>); });
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    child.emitEvent({
      type: DSH_BRIDGE_EVENT.USAGE,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 4608,
      cacheWriteTokens: 512,
      contextWindow: 131_072,
      model: 'minimax-m3',
      finalized: true,
    });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'done' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    expect(sessionInfos.some((i) => i.model === 'minimax-m3')).toBe(true);
    expect(usages[0]).toMatchObject({
      model: 'minimax-m3',
      finalized: true,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 4608,
        cache_creation_input_tokens: 512,
        model_context_window: 131_072,
      },
    });
    expect(completions[0].message.metadata).toMatchObject({
      model: 'minimax-m3',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 4608,
        cache_creation_input_tokens: 512,
        model_context_window: 131_072,
      },
    });
    expect(usages[0].messageId).toBe(completions[0].message.id);
  });

  it('re-injects sessionSystemText after committed compaction even if the turn then fails', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, {
      context: { sessionSystemText: 'IDENTITY_CONTRACT' },
      assembledMessage: 'turn 1',
      sessionSystemText: 'IDENTITY_CONTRACT',
    } as never);
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'ok' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    // Turn 2: compaction commits, then the turn fails before completion.
    await provider.send(sessionId, {
      context: { sessionSystemText: 'IDENTITY_CONTRACT' },
      assembledMessage: 'turn 2',
      sessionSystemText: 'IDENTITY_CONTRACT',
    } as never);
    expect(String((child.commands().at(-1) as { text?: string })?.text)).not.toContain('IDENTITY_CONTRACT');
    expect(String((child.commands().at(-1) as { text?: string })?.text)).toContain('turn 2');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: false, committed: true });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.ERROR, message: 'upstream failed' });
    await flush();

    // Turn 3 must re-inject IDENTITY_CONTRACT because Turn 2 compacted cleanly before failing.
    await provider.send(sessionId, {
      context: { sessionSystemText: 'IDENTITY_CONTRACT' },
      assembledMessage: 'turn 3',
      sessionSystemText: 'IDENTITY_CONTRACT',
    } as never);
    expect(String((child.commands().at(-1) as { text?: string })?.text)).toContain('IDENTITY_CONTRACT');
  });

  it('tracks compacting status and clears it on compaction end or child exit', async () => {
    const sessionId = await startSession();
    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    provider.onStatus((_s, st) => { statuses.push(st as { status: string | null; label?: string | null }); });

    await provider.send(sessionId, 'hi');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: false });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
    child.emit('exit', 1, null);
    await flush();

    expect(statuses).toEqual([
      { status: 'working', label: null },
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'failed' },
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null },
    ]);
  });

  it('distinguishes failed summary vs committed compaction across TransportSessionRuntime completion, error, and cancel', async () => {
    const runtime = new TransportSessionRuntime(provider, 'deck_dsh_runtime_compaction');
    const refreshSpy = vi.spyOn(provider, 'refreshSessionSystemText');
    try {
      await runtime.initialize({
        sessionKey: 'deck_dsh_runtime_compaction',
        sessionName: 'deck_dsh_runtime_compaction',
        identityPrompt: 'CONTRACT_SURVIVES',
      });

      // Turn 1: initial turn establishes baseline injected identity.
      runtime.send('turn 1', 'm1');
      await vi.waitFor(() => expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toHaveLength(1), { timeout: 2_000 });
      expect((child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT).at(-1) as { text?: string })?.text).toContain('CONTRACT_SURVIVES');
      child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'ok-1' });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 2_000 });

      // Turn 2: compaction starts, summary fails (committed omitted), then normal reply completes -> MUST NOT refresh!
      runtime.send('turn 2', 'm2');
      await vi.waitFor(() => expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toHaveLength(2), { timeout: 2_000 });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: false });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'ok-2' });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 2_000 });
      expect(refreshSpy).not.toHaveBeenCalled();

      // Turn 3: confirms Turn 2 did NOT invalidate runtime/provider caches (no redundant re-injection),
      // then commits compaction cleanly and completes normally -> reinjectAfterCompaction fires.
      runtime.send('turn 3', 'm3');
      await vi.waitFor(() => expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toHaveLength(3), { timeout: 2_000 });
      expect((child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT).at(-1) as { text?: string })?.text).not.toContain('CONTRACT_SURVIVES');
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: false, committed: true });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'ok-3' });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 2_000 });
      expect(refreshSpy).toHaveBeenCalledTimes(2);

      // Turn 4: receives full re-injection, then compaction commits and the turn FAILS -> runtime caches still invalidate!
      refreshSpy.mockClear();
      runtime.send('turn 4', 'm4');
      await vi.waitFor(() => expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toHaveLength(4), { timeout: 2_000 });
      expect((child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT).at(-1) as { text?: string })?.text).toContain('CONTRACT_SURVIVES');
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: false, committed: true });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.ERROR, message: 'turn failed' });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 2_000 });
      // Called once on committed compaction end + once by runtime.reinjectAfterCompaction in clearActiveDispatchOwner.
      expect(refreshSpy).toHaveBeenCalledTimes(2);

      // Turn 5: receives full re-injection after Turn 4 failure, then commits compaction and gets CANCELLED -> still invalidates!
      refreshSpy.mockClear();
      runtime.send('turn 5', 'm5');
      await vi.waitFor(() => expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toHaveLength(5), { timeout: 2_000 });
      expect((child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT).at(-1) as { text?: string })?.text).toContain('CONTRACT_SURVIVES');
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: false, committed: true });
      await flush();
      await runtime.cancel();
      expect(refreshSpy).toHaveBeenCalledTimes(2);

      // Turn 6: receives full re-injection again after Turn 5 cancel.
      runtime.send('turn 6', 'm6');
      await vi.waitFor(() => expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toHaveLength(6), { timeout: 2_000 });
      expect((child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT).at(-1) as { text?: string })?.text).toContain('CONTRACT_SURVIVES');
    } finally {
      await runtime.kill();
    }
  });

  it('reports a failed turn as a recoverable provider error, not a completion', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    child.emitEvent({
      type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.ERROR,
      message: 'model request failed', code: 'UPSTREAM',
    });
    await flush();

    expect(completions).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatchObject({ code: 'PROVIDER_ERROR', message: 'model request failed' });
  });

  it('waits for the captured harness terminal after the cancel command', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    await flush();
    let settled = false;
    const stopping = provider.cancelAndWait(sessionId).then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.CANCELLED });
    await stopping;

    expect(child.commands().some((c) => c.type === DSH_BRIDGE_COMMAND.CANCEL)).toBe(true);
    expect(completions).toHaveLength(0);
    expect(errors[0].error.code).toBe('CANCELLED');
  });

  it('passes a stored resume id to the child through the environment', async () => {
    const sessionId = await startSession({ resumeId: 'session-previous' });
    await provider.send(sessionId, 'hi');
    await flush();

    const env = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env[DSH_BRIDGE_RESUME_ENV]).toBe('session-previous');
  });

  it('pins a requested model through the bridge environment', async () => {
    const sessionId = await startSession({ agentId: 'deepseek-reasoner' });
    await provider.send(sessionId, 'hi');
    await flush();

    const env = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env[DSH_BRIDGE_MODEL_ENV]).toBe('deepseek-reasoner');
  });

  it('passes a ccPreset credential only through the private child environment', async () => {
    const llm = {
      provider: 'minimax',
      model: 'MiniMax-M3',
      baseUrl: 'https://api.minimax.io/anthropic',
      apiKey: 'sk-child-only',
    };
    const sessionId = await startSession({ agentId: llm.model, llm });
    await provider.send(sessionId, 'hi');
    await flush();

    expect(writeDshOverlayMock).toHaveBeenCalledWith(expect.objectContaining({ llm }));
    const env = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env[DSH_PROVIDER_API_KEY_ENV]).toBe('sk-child-only');
  });

  it('keeps the requested model pinned when the harness reports a different one', async () => {
    const sessionId = await startSession({ agentId: 'deepseek-reasoner' });
    await provider.send(sessionId, 'hi');
    await flush();
    spawnMock.mockClear();

    // A READY that names the harness default must not erase IM.codes' pin.
    provider.setSessionAgentId(sessionId, 'deepseek-reasoner');
    await provider.send(sessionId, 'again');
    await flush();
    const env = (spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> } | undefined)?.env;
    expect(env?.[DSH_BRIDGE_MODEL_ENV] ?? 'deepseek-reasoner').toBe('deepseek-reasoner');
  });

  it('omits the resume variable for a fresh session', async () => {
    const sessionId = await startSession({ fresh: true });
    await provider.send(sessionId, 'hi');
    await flush();

    const env = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env[DSH_BRIDGE_RESUME_ENV]).toBeUndefined();
  });

  it('passes effective child DSH_PERMISSION_MODE to the overlay without leaking full env', async () => {
    vi.stubEnv('DSH_PERMISSION_MODE', 'danger-full-access');
    const sessionId = await startSession({ env: { DSH_PERMISSION_MODE: 'read-only', SECRET_TOKEN: 'keep-out' } });
    await provider.send(sessionId, 'hi');
    await flush();

    expect(writeDshOverlayMock).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'read-only' }));
    const overlayCall = writeDshOverlayMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(overlayCall.env).toBeUndefined();
    const childEnv = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(childEnv.DSH_PERMISSION_MODE).toBe('read-only');

    const overlayRows = buildDshOverlay({ permissionMode: 'read-only' });
    expect(overlayRows).toContainEqual({
      id: DSH_SANDBOX_POLICY_ROW_ID,
      inject: [],
      config: { mode: 'read-only' },
    });
    expect(JSON.stringify(overlayRows)).not.toContain('keep-out');
  });

  it('ignores non-protocol stdout without disturbing the stream', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    child.stdout.write('a stray harness log line\n');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.DELTA, text: 'ok' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'ok' });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    expect(completions).toHaveLength(1);
    expect(completions[0].message.content).toBe('ok');
  });

  it('surfaces an unexpected child exit during a turn as an error', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    await flush();
    child.emit('exit', 1, null);
    await flush();

    expect(errors.some((e) => /dsh (exited|closed)/.test(e.error.message))).toBe(true);
  });

  it('rejects the send when the child dies before becoming ready', async () => {
    // Regression: the exit handler only failed the session when a turn was
    // already active, but turnActive is set AFTER the ready wait — so a dsh
    // that spawned fine and exited at boot left send() pending forever,
    // holding the runtime's dispatch lock with nothing to show the user.
    spawnMock.mockImplementation(() => {
      setImmediate(() => { child.emit('exit', 1, null); child.emit('close', 1, null); });
      return child;
    });
    const sessionId = await startSession();

    await expect(provider.send(sessionId, 'hi')).rejects.toThrow(/dsh (exited|closed)/);
  });

  it('does not cache a failed start — the next send respawns', async () => {
    // `dsh` missing from PATH emits 'error'+'close' and never 'exit', so a
    // cached rejected readyPromise would replay the same ENOENT for the life of
    // the session even after the user installs it.
    spawnMock.mockImplementationOnce(() => {
      setImmediate(() => { child.emit('error', new Error('spawn dsh ENOENT')); });
      return child;
    });
    const sessionId = await startSession();
    await expect(provider.send(sessionId, 'hi')).rejects.toThrow(
      /npm install -g @deepseek-ai\/dsh@0\.2\.2-rc\.5/,
    );

    const healthy = new FakeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => healthy.emitEvent(readyFrame()));
      return healthy;
    });
    await expect(provider.send(sessionId, 'retry')).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('ignores a late exit from a child that was already replaced', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    await flush();
    const stale = child;

    // Detach and swap in a live replacement, as a model switch does.
    const replacement = new FakeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => replacement.emitEvent(readyFrame()));
      return replacement;
    });
    provider.setSessionAgentId(sessionId, 'other-model');
    await provider.send(sessionId, 'after switch');
    await flush();
    errors.length = 0;

    // The predecessor's terminal event must not tear down the replacement.
    stale.emit('exit', 0, null);
    stale.emit('close', 0, null);
    await flush();

    replacement.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'still alive' });
    replacement.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    expect(errors).toHaveLength(0);
    expect(completions.at(-1)?.message.content).toBe('still alive');
  });

  it('asks the bridge to flush before tearing the session down', async () => {
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    await flush();
    await provider.endSession(sessionId);

    // A hard kill would lose the tail of the session log and break the next
    // resume, so SHUTDOWN must be requested before any termination.
    const commands = child.commands();
    expect(commands.some((c) => c.type === DSH_BRIDGE_COMMAND.SHUTDOWN)).toBe(true);
    expect(commands[commands.length - 1]?.type).toBe(DSH_BRIDGE_COMMAND.SHUTDOWN);
  });

  it('escalates to SIGKILL when the child ignores the shutdown request', async () => {
    // Bring the child up on real timers — the ready handshake rides setImmediate,
    // which fake timers would otherwise hold.
    const sessionId = await startSession();
    await provider.send(sessionId, 'hi');
    await flush();
    child.exitOnShutdown = false;

    vi.useFakeTimers();
    try {
      const ending = provider.endSession(sessionId);
      // 3s shutdown grace, then killProcessTree's own graceful window.
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await ending;
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildDshOverlay', () => {
  it('disables the one-shot harness rows, decouples sandbox-policy, and mounts the bridge by absolute path', () => {
    const rows = buildDshOverlay({});
    for (const id of DSH_DISABLED_ROW_IDS) {
      expect(rows).toContainEqual({ id, disabled: true });
    }
    expect(rows).toContainEqual({
      id: DSH_SANDBOX_POLICY_ROW_ID,
      inject: [],
      config: { mode: 'workspace-write' },
    });
    const fencedRows = buildDshOverlay({ nativeAgentsFenced: true });
    expect(DSH_NATIVE_AGENT_ROW_IDS).toContain('tool-agent-team');
    for (const id of DSH_NATIVE_AGENT_ROW_IDS) {
      expect(fencedRows).toContainEqual({ id, disabled: true });
    }
    const insert = rows.find((row) => row.insert)?.insert?.slice(-1)[0];
    expect(insert?.name).toMatch(/deepseek-harness\/bridge\.js$/);
    // MUST be a file: URL, not a bare path. The harness loader passes an
    // unprefixed specifier to `await import(name)`, and on Windows a
    // drive-letter path makes Node parse `C:` as a URL scheme and throw
    // ERR_UNSUPPORTED_ESM_URL_SCHEME.
    expect(insert?.name?.startsWith('file://')).toBe(true);
    expect(() => new URL(insert!.name!)).not.toThrow();
  });

  it('mounts the IM.codes memory MCP ahead of the bridge when one is supplied', () => {
    const rows = buildDshOverlay({
      memoryMcp: { command: 'imcodes', args: ['memory', 'mcp'], env: { IMCODES_DAEMON_SESSION_NAME: 'deck_x_brain' } },
    });
    const insert = rows.find((row) => row.insert)?.insert ?? [];
    expect(insert[0]).toMatchObject({
      id: DSH_MEMORY_MCP_ROW_ID,
      name: DSH_MCP_CLIENT_PACKAGE,
      config: {
        transport: 'stdio',
        serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
        command: 'imcodes',
        args: ['memory', 'mcp'],
      },
    });
    // Explicit, not inherited: a memory-MCP outage must degrade the tool set,
    // never block the agent from starting.
    expect(insert[0]?.config?.failOnStartupError).toBe(false);
  });

  it('omits the MCP row entirely when no server is supplied', () => {
    const insert = buildDshOverlay({}).find((row) => row.insert)?.insert ?? [];
    expect(insert.some((row) => row.id === DSH_MEMORY_MCP_ROW_ID)).toBe(false);
  });

  it('carries no model row: the model rides to the bridge as an env var', () => {
    // `agent-default-model` needs a provider ROUTE as well as a model, and the
    // route is only knowable after a first boot — so pinning here could only
    // ever produce the unroutable half-specified pair.
    const rows = buildDshOverlay({});
    expect(rows.some((row) => row.id === 'agent-default-model')).toBe(false);
  });

  it('registers a ccPreset route without serializing its credential', () => {
    const rows = buildDshOverlay({
      llm: {
        provider: 'minimax',
        model: 'MiniMax-M.27',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKey: 'sk-test-key',
        contextWindow: 1_000_000,
      },
    });
    const adapterRow = rows.find((row) => row.id === DSH_LLM_PI_AI_ROW_ID);
    expect(adapterRow?.config).toEqual({
      providers: {
        minimax: {
          api: 'anthropic-messages',
          baseURL: 'https://api.minimax.io/anthropic',
          apiKeyEnv: DSH_PROVIDER_API_KEY_ENV,
          models: [{ id: 'MiniMax-M.27', contextWindow: 1_000_000 }],
        },
      },
    });
    const modelRow = rows.find((row) => row.id === DSH_AGENT_DEFAULT_MODEL_ROW_ID);
    expect(modelRow?.config).toEqual({
      provider: 'minimax',
      model: 'MiniMax-M.27',
    });
    expect(JSON.stringify(rows)).not.toContain('sk-test-key');
  });

  it('registers all deduped preset availableModels and openai-completions protocol for openai authType', () => {
    const rows = buildDshOverlay({
      llm: {
        provider: 'glm5.3',
        model: 'glm-5.3-flash',
        authType: 'openai',
        availableModels: ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3', 'glm-5.3-flash'],
        baseUrl: 'https://open.example.com/v1',
        apiKey: 'sk-openai-secret',
        contextWindow: 1_000_000,
      },
    });
    const adapterRow = rows.find((row) => row.id === DSH_LLM_PI_AI_ROW_ID);
    expect(adapterRow?.config).toEqual({
      providers: {
        'glm5.3': {
          api: 'openai-completions',
          baseURL: 'https://open.example.com/v1',
          apiKeyEnv: DSH_PROVIDER_API_KEY_ENV,
          models: [
            { id: 'glm-5.3-flash', contextWindow: 1_000_000 },
            { id: 'glm-5.3-flashx', contextWindow: 1_000_000 },
            { id: 'glm-5.3', contextWindow: 1_000_000 },
          ],
        },
      },
    });
    expect(JSON.stringify(rows)).not.toContain('sk-openai-secret');
  });
});

describe('DeepseekHarnessProvider /compact and preset models', () => {
  let provider: DeepseekHarnessProvider;
  let child: FakeChild;
  let completions: Array<{ sessionId: string; message: AgentMessage }>;
  let errors: Array<{ sessionId: string; error: { code: string; message: string; recoverable: boolean } }>;
  let sessionInfos: Array<{ sessionId: string; info: Record<string, unknown> }>;

  beforeEach(async () => {
    spawnMock.mockReset();
    writeDshOverlayMock.mockClear();
    child = new FakeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => child.emitEvent({
        type: DSH_BRIDGE_EVENT.READY,
        sessionId: 'dsh-compact-1',
        provider: 'glm5.3',
        model: 'glm-5.3-flash',
        resumed: false,
      }));
      return child;
    });
    provider = new DeepseekHarnessProvider();
    completions = [];
    errors = [];
    sessionInfos = [];
    provider.onComplete((sessionId, message) => completions.push({ sessionId, message }));
    provider.onError((sessionId, error) => errors.push({ sessionId, error }));
    provider.onSessionInfo((sessionId, info) => sessionInfos.push({ sessionId, info: info as Record<string, unknown> }));
    await provider.connect({});
  });

  afterEach(async () => {
    await provider.disconnect();
  });

  it('resolves /compact immediately on stdin write and settles commit, failure, and cancel asynchronously via events', async () => {
    expect(provider.capabilities.compact).toMatchObject({
      execution: 'sdk-rpc',
      verified: true,
      reassertsSessionSystemText: true,
    });
    const sessionId = await provider.createSession({
      sessionKey: 'dsh-compact-route',
      cwd: '/tmp/project',
      agentId: 'glm-5.3-flash',
      llm: {
        provider: 'glm5.3',
        model: 'glm-5.3-flash',
        availableModels: ['glm-5.3-flash', 'glm-5.3-flashx'],
      },
    });
    expect(await provider.listModels()).toEqual({
      models: [
        { id: 'glm5.3/glm-5.3-flash', name: 'glm5.3 · glm-5.3-flash' },
        { id: 'glm5.3/glm-5.3-flashx', name: 'glm5.3 · glm-5.3-flashx' },
      ],
      isAuthenticated: true,
    });

    await provider.send(sessionId, '/compact');
    expect(child.commands().some((c) => c.type === DSH_BRIDGE_COMMAND.COMPACT)).toBe(true);
    expect(child.commands().some((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toBe(false);
    expect(completions).toHaveLength(0);

    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: false, committed: true });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACT_RESULT, ok: true, committed: true, shadowedCount: 4, shadowedTokenCount: 1200 });
    await flush();
    expect(completions.at(-1)?.message).toMatchObject({
      kind: 'system',
      role: 'system',
      metadata: expect.objectContaining({
        [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
        shadowedCount: 4,
        shadowedTokenCount: 1200,
      }),
    });

    await provider.send(sessionId, '/compact');
    expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.COMPACT)).toHaveLength(2);
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACT_RESULT, ok: false, message: 'No compactable history yet.' });
    await flush();
    expect(errors.at(-1)?.error).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'dsh compact failed: No compactable history yet.',
      recoverable: true,
    });

    await provider.send(sessionId, '/compact');
    expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.COMPACT)).toHaveLength(3);
    const stopPromise = provider.cancelAndWait(sessionId);
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACT_RESULT, ok: false, cancelled: true, message: 'aborted' });
    await expect(stopPromise).resolves.toBeUndefined();
    expect(errors.at(-1)?.error).toMatchObject({
      code: 'CANCELLED',
      message: 'Turn cancelled',
      recoverable: true,
    });
  });

  it('does not trip sendProviderWithTimeout when slow /compact settles after the admission window', async () => {
    const sid = await provider.createSession({
      sessionKey: 'dsh-direct-compact-timeout',
      sessionName: 'deck_dsh_direct_compact',
      cwd: '/tmp/project',
      agentId: 'glm-5.3-flash',
    });
    const dispatched = await dispatchSharedContextSend(provider, sid, {
      userMessage: '/compact',
      namespace: { scope: 'personal', projectId: 'p1' },
    }, { sendTimeoutMs: 40 });
    expect(dispatched.disposition).toBe('sent');
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(errors).toHaveLength(0);
    child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACT_RESULT, ok: true, committed: true });
    await flush();
    expect(completions.at(-1)?.message.metadata?.[SESSION_CONTROL_METADATA_COMMAND_FIELD]).toBe('compact');

    const runtime = new TransportSessionRuntime(provider, 'deck_dsh_slow_compact');
    try {
      await runtime.initialize({
        sessionKey: 'dsh-slow-compact-route',
        sessionName: 'deck_dsh_slow_compact',
        identityPrompt: 'IDENTITY_AFTER_COMPACT',
      });

      runtime.send('turn 1', 'm1');
      await vi.waitFor(() => expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toHaveLength(1), { timeout: 2_000 });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.MESSAGE, text: 'ready' });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 2_000 });

      runtime.send('/compact', 'm-compact');
      await vi.waitFor(() => expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.COMPACT)).toHaveLength(2), { timeout: 2_000 });
      await new Promise((resolve) => setTimeout(resolve, 90));

      expect(runtime.getStatus()).toBe('thinking');
      expect(errors).toHaveLength(0);

      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: true });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACTING, active: false, committed: true });
      child.emitEvent({ type: DSH_BRIDGE_EVENT.COMPACT_RESULT, ok: true, committed: true, shadowedCount: 2, shadowedTokenCount: 400 });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 2_000 });
      expect(completions.at(-1)?.message.metadata?.[SESSION_CONTROL_METADATA_COMMAND_FIELD]).toBe('compact');

      runtime.send('turn 2', 'm2');
      await vi.waitFor(() => expect(child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT)).toHaveLength(2), { timeout: 2_000 });
      const secondPrompt = child.commands().filter((c) => c.type === DSH_BRIDGE_COMMAND.PROMPT).at(-1) as { text?: string } | undefined;
      expect(secondPrompt?.text).toContain('IDENTITY_AFTER_COMPACT');
    } finally {
      await runtime.kill();
    }
  });

  it('switches model in-process via SET_MODEL on idle live child and keeps respawn fallback for active turns', async () => {
    const sessionId = await provider.createSession({
      sessionKey: 'dsh-switch-route',
      cwd: '/tmp/project',
      agentId: 'glm-5.3-flash',
      llm: {
        provider: 'glm5.3',
        model: 'glm-5.3-flash',
        availableModels: ['glm-5.3-flash', 'glm-5.3-flashx'],
      },
    });
    await provider.send(sessionId, 'hi');
    child.emitEvent({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    await flush();

    // Idle live child: sends SET_MODEL in-process on the exact same child without respawn.
    provider.setSessionAgentId(sessionId, 'glm5.3/glm-5.3-flashx');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.killed).toBe(false);
    expect(child.commands().at(-1)).toEqual({
      type: DSH_BRIDGE_COMMAND.SET_MODEL,
      provider: 'glm5.3',
      model: 'glm-5.3-flashx',
    });
    child.emitEvent({ type: DSH_BRIDGE_EVENT.MODEL_SELECTED, provider: 'glm5.3', model: 'glm-5.3-flashx' });
    await flush();
    expect(sessionInfos.at(-1)?.info).toMatchObject({ model: 'glm-5.3-flashx' });
    await provider.send(sessionId, 'next on same child');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Active turn: still falls back to detach + respawn with updated DSH_BRIDGE_MODEL_ENV.
    const replacement = new FakeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => replacement.emitEvent({
        type: DSH_BRIDGE_EVENT.READY,
        sessionId: 'dsh-compact-1',
        provider: 'glm5.3',
        model: 'glm-5.3-flash',
        resumed: true,
      }));
      return replacement;
    });
    provider.setSessionAgentId(sessionId, 'glm5.3/glm-5.3-flash');
    await provider.send(sessionId, 'next after active respawn');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const spawnEnv = spawnMock.mock.calls.at(-1)?.[2]?.env as Record<string, string> | undefined;
    expect(spawnEnv?.[DSH_BRIDGE_MODEL_ENV]).toBe('glm-5.3-flash');
  });
});
