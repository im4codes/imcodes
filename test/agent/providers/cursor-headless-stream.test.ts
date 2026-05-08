import { describe, expect, it } from 'vitest';
import { parseCursorStreamLine } from '../../../src/agent/providers/cursor-headless-stream.js';

describe('parseCursorStreamLine', () => {
  it('normalizes system init, streamed deltas, tool events, and completion records', () => {
    expect(parseCursorStreamLine(JSON.stringify({
      type: 'system.init',
      session_id: 'cursor-chat-1',
      model: 'GPT-5.2',
      permissionMode: 'default',
    }))).toEqual({
      kind: 'session.init',
      sessionId: 'cursor-chat-1',
      model: 'GPT-5.2',
      permissionMode: 'default',
      raw: {
        type: 'system.init',
        session_id: 'cursor-chat-1',
        model: 'GPT-5.2',
        permissionMode: 'default',
      },
    });

    expect(parseCursorStreamLine(JSON.stringify({
      type: 'stream_event',
      session_id: 'cursor-chat-1',
      event: {
        type: 'content_block_delta',
        delta: {
          type: 'text_delta',
          text: 'Hel',
        },
      },
    }))).toEqual({
      kind: 'assistant.delta',
      sessionId: 'cursor-chat-1',
      text: 'Hel',
      raw: {
        type: 'stream_event',
        session_id: 'cursor-chat-1',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: 'Hel',
          },
        },
      },
    });

    expect(parseCursorStreamLine(JSON.stringify({
      type: 'tool_call.started',
      id: 'tool-1',
      name: 'shell',
      input: { command: 'printf hello' },
    }))).toEqual({
      kind: 'tool.started',
      sessionId: undefined,
      id: 'tool-1',
      name: 'shell',
      input: { command: 'printf hello' },
      raw: {
        type: 'tool_call.started',
        id: 'tool-1',
        name: 'shell',
        input: { command: 'printf hello' },
      },
    });

    expect(parseCursorStreamLine(JSON.stringify({
      type: 'tool_call.completed',
      id: 'tool-1',
      name: 'shell',
      output: 'hello',
    }))).toEqual({
      kind: 'tool.completed',
      sessionId: undefined,
      id: 'tool-1',
      name: 'shell',
      output: 'hello',
      raw: {
        type: 'tool_call.completed',
        id: 'tool-1',
        name: 'shell',
        output: 'hello',
      },
    });

    expect(parseCursorStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'text', text: 'Hello' }],
      },
    }))).toEqual({
      kind: 'assistant.final',
      sessionId: undefined,
      messageId: 'msg-1',
      text: 'Hello',
      raw: {
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: 'Hello' }],
        },
      },
    });

    expect(parseCursorStreamLine(JSON.stringify({
      type: 'result.success',
      session_id: 'cursor-chat-1',
      result: 'Hello',
      usage: { input_tokens: 3, output_tokens: 2 },
    }))).toEqual({
      kind: 'result.success',
      sessionId: 'cursor-chat-1',
      model: undefined,
      text: 'Hello',
      usage: { input_tokens: 3, output_tokens: 2 },
      raw: {
        type: 'result.success',
        session_id: 'cursor-chat-1',
        result: 'Hello',
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    });
  });

  it('normalizes cursor-agent camelCase usage fields without treating cache counters as live context', () => {
    // Real cursor-agent (verified 2026.05.04-08e5280) emits camelCase token
    // fields:
    //   {"usage":{"inputTokens":1227,"outputTokens":13,"cacheReadTokens":10624,"cacheWriteTokens":0}}
    // Transport-relay's context meter treats canonical cache_read_input_tokens
    // as live prompt/window occupancy. Cursor's cacheReadTokens/cacheWriteTokens
    // are cumulative/billing-style counters in long sessions, so mapping them
    // into canonical cache fields makes the UI show impossible ctx values
    // (e.g. 1.3M / 1M). Keep input/output canonical, but preserve cache values
    // only as cursor-specific diagnostics.
    const parsed = parseCursorStreamLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'cursor-chat-real',
      result: '`1 + 1 = 2`',
      usage: {
        inputTokens: 1227,
        outputTokens: 13,
        cacheReadTokens: 10624,
        cacheWriteTokens: 0,
      },
    }));
    expect(parsed?.kind).toBe('result.success');
    if (parsed?.kind !== 'result.success') return;
    expect(parsed.usage).toMatchObject({
      input_tokens: 1227,
      output_tokens: 13,
      cursor_cache_read_tokens: 10624,
      cursor_cache_write_tokens: 0,
    });
    expect(parsed.usage).not.toHaveProperty('cache_read_input_tokens');
    expect(parsed.usage).not.toHaveProperty('cache_creation_input_tokens');
  });

  it('ignores invalid or irrelevant records', () => {
    expect(parseCursorStreamLine('')).toBeNull();
    expect(parseCursorStreamLine('not-json')).toBeNull();
    expect(parseCursorStreamLine(JSON.stringify({ type: 'user', message: { content: [] } }))).toBeNull();
  });
});
