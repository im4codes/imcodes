/**
 * Tests for the Cordis plugin mounted inside the DeepSeek Harness process.
 *
 * The bridge is the only place that understands the harness's internal
 * `session/event` vocabulary, which is a developer-preview surface rather than
 * a declared API. These tests pin the exact payload shapes captured from
 * dsh 0.1.0-rc.7 so a harness change shows up here instead of as silent
 * streaming loss in a live session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DSH_BRIDGE_COMMAND,
  DSH_BRIDGE_EVENT,
  DSH_BRIDGE_CWD_ENV,
  DSH_BRIDGE_RESUME_ENV,
  DSH_BRIDGE_TOOL_STATUS,
  DSH_BRIDGE_TURN_REASON,
  DSH_SESSION_EVENT,
  type DshBridgeEvent,
} from '../../shared/deepseek-harness.js';
import { apply, inject, name } from '../../src/agent/providers/deepseek-harness/bridge.js';

type SessionEventListener = (session: { id: string }, event: { type: string; data?: Record<string, unknown> }) => void;

const OWN_SESSION = { id: 'session-own' };
const OTHER_SESSION = { id: 'session-other' };

function makeAgent() {
  const followups: unknown[] = [];
  let cancelled = 0;
  return {
    followups,
    cancelCount: () => cancelled,
    agent: {
      session: OWN_SESSION,
      whenIdle: vi.fn().mockResolvedValue(undefined),
      followup: (message: unknown) => { followups.push(message); },
      cancel: () => { cancelled += 1; },
    },
  };
}

function makeCtx(agent: unknown, overrides: Record<string, unknown> = {}) {
  const listeners: SessionEventListener[] = [];
  const created: Array<Record<string, unknown>> = [];
  const resumed: Array<Record<string, unknown>> = [];
  const flushed: unknown[] = [];
  const services: Record<string, unknown> = {
    loader: { await: vi.fn().mockResolvedValue(undefined) },
    agents: {
      create: vi.fn(async (options: Record<string, unknown>) => { created.push(options); return { agent }; }),
      resume: vi.fn(async (options: Record<string, unknown>) => { resumed.push(options); return { agent }; }),
    },
    sessions: { flush: vi.fn(async (session: unknown) => { flushed.push(session); }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) },
    ...overrides,
  };
  return {
    created, resumed, flushed, listeners,
    emit(event: { type: string; data?: Record<string, unknown> }, session = OWN_SESSION) {
      for (const listener of listeners) listener(session, event);
    },
    ctx: {
      get: (key: string) => services[key],
      on: (channel: string, listener: SessionEventListener) => {
        if (channel === 'session/event') listeners.push(listener);
        return () => {};
      },
    },
  };
}

describe('deepseek-harness bridge', () => {
  let frames: DshBridgeEvent[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    frames = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) frames.push(JSON.parse(line) as DshBridgeEvent);
      }
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function boot(overrides: Record<string, unknown> = {}) {
    const agentBits = makeAgent();
    const harness = makeCtx(agentBits.agent, overrides);
    apply(harness.ctx as never);
    // apply() kicks off an async start(); let it settle.
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return { ...harness, ...agentBits };
  }

  it('declares the plugin contract the harness loader expects', () => {
    expect(name).toBe('imcodes-dsh-bridge');
    expect(inject).toEqual(expect.arrayContaining(['agents', 'agentDefaultModel', 'sessions']));
  });

  it('creates a fresh agent and announces its durable session id', async () => {
    vi.stubEnv(DSH_BRIDGE_CWD_ENV, '/work/dir');
    const harness = await boot();

    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]).toMatchObject({ meta: { cwd: '/work/dir' } });
    expect(frames[0]).toMatchObject({
      type: DSH_BRIDGE_EVENT.READY,
      sessionId: OWN_SESSION.id,
      resumed: false,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    });
  });

  it('resumes a persisted session when the daemon supplies one', async () => {
    vi.stubEnv(DSH_BRIDGE_RESUME_ENV, 'session-previous');
    const harness = await boot();

    expect(harness.resumed).toHaveLength(1);
    expect(harness.resumed[0]).toMatchObject({ sessionId: 'session-previous' });
    expect(harness.created).toHaveLength(0);
    expect(frames[0]).toMatchObject({ resumed: true });
  });

  it('falls back to a fresh agent when the resume target is gone', async () => {
    vi.stubEnv(DSH_BRIDGE_RESUME_ENV, 'session-pruned');
    const agentBits = makeAgent();
    const harness = makeCtx(agentBits.agent, {
      agents: {
        create: vi.fn(async () => ({ agent: agentBits.agent })),
        resume: vi.fn(async () => { throw new Error('no such session'); }),
      },
    });
    apply(harness.ctx as never);
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));

    // The daemon repoints its resume record from the ready frame, so a pruned
    // session must degrade to a usable conversation rather than a dead one.
    expect(frames[0]).toMatchObject({ type: DSH_BRIDGE_EVENT.READY, resumed: false });
  });

  it('republishes text deltas and suppresses empty committed messages', async () => {
    const harness = await boot();
    frames.length = 0;

    harness.emit({ type: DSH_SESSION_EVENT.ASSISTANT_CHUNK, data: { chunk: { type: 'text-delta', text: 'Hel' } } });
    harness.emit({ type: DSH_SESSION_EVENT.ASSISTANT_CHUNK, data: { chunk: { type: 'text-delta', text: 'lo' } } });
    // A tool-call-only assistant message carries no text blocks.
    harness.emit({
      type: DSH_SESSION_EVENT.ASSISTANT_MESSAGE,
      data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash' }] } },
    });
    harness.emit({
      type: DSH_SESSION_EVENT.ASSISTANT_MESSAGE,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
    });

    expect(frames).toEqual([
      { type: DSH_BRIDGE_EVENT.DELTA, text: 'Hel' },
      { type: DSH_BRIDGE_EVENT.DELTA, text: 'lo' },
      { type: DSH_BRIDGE_EVENT.MESSAGE, text: 'Hello' },
    ]);
  });

  it('reports reasoning without leaking its content', async () => {
    const harness = await boot();
    frames.length = 0;

    for (let i = 0; i < 500; i += 1) {
      harness.emit({
        type: DSH_SESSION_EVENT.ASSISTANT_CHUNK,
        data: { chunk: { type: 'reasoning-delta', text: 'private chain of thought' } },
      });
    }

    // Once per turn, not once per token: the daemon only needs to know THAT the
    // model is reasoning, and its status dedupe discards the rest anyway.
    expect(frames).toEqual([{ type: DSH_BRIDGE_EVENT.REASONING }]);
    expect(JSON.stringify(frames)).not.toContain('private chain');

    // ...and it re-arms for the next turn.
    harness.emit({ type: DSH_SESSION_EVENT.TURN_END, data: { reason: { kind: 'completed' } } });
    harness.emit({
      type: DSH_SESSION_EVENT.ASSISTANT_CHUNK,
      data: { chunk: { type: 'reasoning-delta', text: 'more thought' } },
    });
    expect(frames.filter((f) => f.type === DSH_BRIDGE_EVENT.REASONING)).toHaveLength(2);
  });

  it('maps tool call and tool result payloads, parsing the JSON arguments string', async () => {
    const harness = await boot();
    frames.length = 0;

    harness.emit({
      type: DSH_SESSION_EVENT.TOOL_CALL,
      data: { turn: 1, step: 1, callId: 'call_a', name: 'bash', arguments: '{"command":"echo hi"}' },
    });
    harness.emit({
      type: DSH_SESSION_EVENT.TOOL_RESULT,
      data: {
        message: {
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_a',
            content: [{ type: 'text', text: 'hi\n' }],
            isError: false,
          }],
        },
      },
    });

    expect(frames[0]).toEqual({
      type: DSH_BRIDGE_EVENT.TOOL,
      id: 'call_a',
      name: 'bash',
      status: DSH_BRIDGE_TOOL_STATUS.RUNNING,
      input: { command: 'echo hi' },
    });
    expect(frames[1]).toMatchObject({
      type: DSH_BRIDGE_EVENT.TOOL,
      id: 'call_a',
      status: DSH_BRIDGE_TOOL_STATUS.COMPLETE,
      output: 'hi\n',
    });
  });

  it('marks a failed tool result as an error', async () => {
    const harness = await boot();
    frames.length = 0;

    harness.emit({
      type: DSH_SESSION_EVENT.TOOL_RESULT,
      data: {
        message: {
          content: [{
            type: 'tool-result', toolCallId: 'call_b',
            content: [{ type: 'text', text: 'denied' }], isError: true,
          }],
        },
      },
    });

    expect(frames[0]).toMatchObject({ status: DSH_BRIDGE_TOOL_STATUS.ERROR, output: 'denied' });
  });

  it('forwards usage counters', async () => {
    const harness = await boot();
    frames.length = 0;

    harness.emit({
      type: DSH_SESSION_EVENT.ASSISTANT_CHUNK,
      data: { chunk: { type: 'usage', usage: { inputTokens: 7351, outputTokens: 20, cacheReadTokens: 128 } } },
    });

    expect(frames[0]).toEqual({
      type: DSH_BRIDGE_EVENT.USAGE, inputTokens: 7351, outputTokens: 20, cacheReadTokens: 128,
    });
  });

  it('translates turn outcomes, including the error payload', async () => {
    const harness = await boot();
    frames.length = 0;

    harness.emit({ type: DSH_SESSION_EVENT.TURN_END, data: { turn: 1, reason: { kind: 'completed' } } });
    harness.emit({ type: DSH_SESSION_EVENT.TURN_END, data: { turn: 2, reason: { kind: 'cancelled' } } });
    harness.emit({
      type: DSH_SESSION_EVENT.TURN_END,
      data: { turn: 3, reason: { kind: 'error', error: { code: 'UPSTREAM', message: 'boom' } } },
    });

    expect(frames[0]).toEqual({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.COMPLETED });
    expect(frames[1]).toEqual({ type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.CANCELLED });
    expect(frames[2]).toEqual({
      type: DSH_BRIDGE_EVENT.TURN_END, reason: DSH_BRIDGE_TURN_REASON.ERROR, message: 'boom', code: 'UPSTREAM',
    });
  });

  it('ignores events belonging to another session', async () => {
    const harness = await boot();
    frames.length = 0;

    // Subagents publish on their own sessions through the same channel.
    harness.emit(
      { type: DSH_SESSION_EVENT.ASSISTANT_CHUNK, data: { chunk: { type: 'text-delta', text: 'subagent noise' } } },
      OTHER_SESSION,
    );

    expect(frames).toEqual([]);
  });

  it('reports missing core services instead of throwing', async () => {
    const agentBits = makeAgent();
    const harness = makeCtx(agentBits.agent, { agents: undefined });
    apply(harness.ctx as never);
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(frames[0]).toMatchObject({ type: DSH_BRIDGE_EVENT.ERROR });
  });

  it('keeps stdout free of anything that is not a protocol frame', async () => {
    const harness = await boot();
    harness.emit({ type: DSH_SESSION_EVENT.ASSISTANT_CHUNK, data: { chunk: { type: 'block-start', index: 0 } } });
    harness.emit({ type: 'some/unmodelled-event', data: {} });

    // Every write must have parsed as JSON in the spy; assert nothing extra was
    // produced for events the protocol does not model.
    const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
    for (const line of written.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(frames.filter((f) => f.type === DSH_BRIDGE_EVENT.READY)).toHaveLength(1);
    expect(frames).toHaveLength(1);
  });
});

describe('deepseek-harness bridge command handling', () => {
  it('models the command vocabulary the daemon writes', () => {
    // The daemon writes these verbatim; a rename on either side breaks the child.
    expect(Object.values(DSH_BRIDGE_COMMAND)).toEqual(['prompt', 'cancel', 'shutdown']);
  });
});
