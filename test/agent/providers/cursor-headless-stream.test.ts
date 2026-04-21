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

  it('ignores invalid or irrelevant records', () => {
    expect(parseCursorStreamLine('')).toBeNull();
    expect(parseCursorStreamLine('not-json')).toBeNull();
    expect(parseCursorStreamLine(JSON.stringify({ type: 'user', message: { content: [] } }))).toBeNull();
  });
});

