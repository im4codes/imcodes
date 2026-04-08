import { describe, expect, it } from 'vitest';
import { getSessionRuntimeType, isTransportSessionAgentType } from '../shared/agent-types.js';

describe('shared agent type helpers', () => {
  it('recognizes transport-backed session agent types', () => {
    expect(isTransportSessionAgentType('claude-code-sdk')).toBe(true);
    expect(isTransportSessionAgentType('codex-sdk')).toBe(true);
    expect(isTransportSessionAgentType('qwen')).toBe(true);
    expect(isTransportSessionAgentType('openclaw')).toBe(true);
    expect(isTransportSessionAgentType('claude-code')).toBe(false);
  });

  it('maps session agent types to runtime types', () => {
    expect(getSessionRuntimeType('claude-code-sdk')).toBe('transport');
    expect(getSessionRuntimeType('codex-sdk')).toBe('transport');
    expect(getSessionRuntimeType('claude-code')).toBe('process');
    expect(getSessionRuntimeType('shell')).toBe('process');
  });
});
