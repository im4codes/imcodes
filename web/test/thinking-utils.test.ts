import { describe, expect, it } from 'vitest';

import { hasActiveToolCall } from '../src/thinking-utils.js';

describe('hasActiveToolCall', () => {
  it('does not treat trailing agent.status during thinking as a tool call', () => {
    expect(hasActiveToolCall([
      { type: 'assistant.thinking', ts: 1 },
      { type: 'agent.status', payload: { label: 'thinking 4s' } },
      { type: 'session.state', payload: { state: 'running' } },
    ] as any)).toBe(false);
  });

  it('treats a trailing tool.call as active', () => {
    expect(hasActiveToolCall([
      { type: 'assistant.thinking', ts: 1 },
      { type: 'tool.call', payload: { tool: 'Read' } },
      { type: 'agent.status', payload: { label: 'Reading file...' } },
      { type: 'session.state', payload: { state: 'running' } },
    ] as any)).toBe(true);
  });

  it('does not treat a completed tool.result as an active tool call', () => {
    expect(hasActiveToolCall([
      { type: 'tool.call', payload: { tool: 'Read' } },
      { type: 'tool.result', payload: { ok: true } },
      { type: 'agent.status', payload: { label: 'thinking 1s' } },
      { type: 'session.state', payload: { state: 'running' } },
    ] as any)).toBe(false);
  });
});
