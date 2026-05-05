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

  it('normalizes cursor-agent camelCase usage fields into snake_case', () => {
    // Real cursor-agent (verified 2026.05.04-08e5280) emits camelCase token
    // fields:
    //   {"usage":{"inputTokens":1227,"outputTokens":13,"cacheReadTokens":10624,"cacheWriteTokens":0}}
    // Transport-relay's `normalizeUsageUpdatePayload` only knows snake_case;
    // without translation every cursor turn lost ALL token data and the
    // chat header context bar showed "0 / 1M (0.0%)". This test pins the
    // translation contract.
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
      cache_read_input_tokens: 10624,
      cache_creation_input_tokens: 0,
    });
  });

  it('ignores invalid or irrelevant records', () => {
    expect(parseCursorStreamLine('')).toBeNull();
    expect(parseCursorStreamLine('not-json')).toBeNull();
    expect(parseCursorStreamLine(JSON.stringify({ type: 'user', message: { content: [] } }))).toBeNull();
  });
});

