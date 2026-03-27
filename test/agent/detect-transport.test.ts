import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  isTransportAgent,
  isProcessAgent,
  TRANSPORT_AGENTS,
  PROCESS_AGENTS,
  detectStatus,
} from '../../src/agent/detect.js';
import type { AgentType, ProcessAgent, TransportAgent } from '../../src/agent/detect.js';

// ── isTransportAgent ───────────────────────────────────────────────────────────

describe('isTransportAgent()', () => {
  it('returns true for openclaw', () => {
    expect(isTransportAgent('openclaw')).toBe(true);
  });

  it('returns false for claude-code', () => {
    expect(isTransportAgent('claude-code')).toBe(false);
  });

  it('returns false for all process agent types', () => {
    const processTypes = ['claude-code', 'codex', 'opencode', 'shell', 'script', 'gemini'];
    for (const type of processTypes) {
      expect(isTransportAgent(type)).toBe(false);
    }
  });

  it('returns false for unknown strings', () => {
    expect(isTransportAgent('unknown-agent')).toBe(false);
    expect(isTransportAgent('')).toBe(false);
  });

  it('narrows type to TransportAgent (type-level)', () => {
    const agentStr = 'openclaw' as string;
    if (isTransportAgent(agentStr)) {
      expectTypeOf(agentStr).toEqualTypeOf<TransportAgent>();
    }
  });
});

// ── isProcessAgent ─────────────────────────────────────────────────────────────

describe('isProcessAgent()', () => {
  it('returns true for claude-code', () => {
    expect(isProcessAgent('claude-code')).toBe(true);
  });

  it('returns true for all process agent types', () => {
    const processTypes = ['claude-code', 'codex', 'opencode', 'shell', 'script', 'gemini'];
    for (const type of processTypes) {
      expect(isProcessAgent(type)).toBe(true);
    }
  });

  it('returns false for openclaw', () => {
    expect(isProcessAgent('openclaw')).toBe(false);
  });

  it('returns true for unknown strings (non-transport fallthrough)', () => {
    // isProcessAgent is defined as !isTransportAgent, so any non-transport string is "process"
    expect(isProcessAgent('unknown-agent')).toBe(true);
  });

  it('narrows type to ProcessAgent (type-level)', () => {
    const agentStr = 'claude-code' as string;
    if (isProcessAgent(agentStr)) {
      expectTypeOf(agentStr).toEqualTypeOf<ProcessAgent>();
    }
  });
});

// ── TRANSPORT_AGENTS set ───────────────────────────────────────────────────────

describe('TRANSPORT_AGENTS set', () => {
  it('contains openclaw', () => {
    expect(TRANSPORT_AGENTS.has('openclaw')).toBe(true);
  });

  it('has at least 1 entry', () => {
    expect(TRANSPORT_AGENTS.size).toBeGreaterThanOrEqual(1);
  });

  it('every entry passes isTransportAgent()', () => {
    for (const agent of TRANSPORT_AGENTS) {
      expect(isTransportAgent(agent)).toBe(true);
    }
  });
});

// ── PROCESS_AGENTS set ─────────────────────────────────────────────────────────

describe('PROCESS_AGENTS set', () => {
  it('contains all 6 process types', () => {
    const expected: ProcessAgent[] = ['claude-code', 'codex', 'opencode', 'shell', 'script', 'gemini'];
    for (const type of expected) {
      expect(PROCESS_AGENTS.has(type)).toBe(true);
    }
  });

  it('has exactly 6 entries', () => {
    expect(PROCESS_AGENTS.size).toBe(6);
  });

  it('every entry passes isProcessAgent()', () => {
    for (const agent of PROCESS_AGENTS) {
      expect(isProcessAgent(agent)).toBe(true);
    }
  });
});

// ── Disjoint invariant ─────────────────────────────────────────────────────────

describe('TRANSPORT_AGENTS and PROCESS_AGENTS', () => {
  it('have no overlap', () => {
    for (const agent of TRANSPORT_AGENTS) {
      expect(PROCESS_AGENTS.has(agent as ProcessAgent)).toBe(false);
    }
    for (const agent of PROCESS_AGENTS) {
      expect(TRANSPORT_AGENTS.has(agent as TransportAgent)).toBe(false);
    }
  });

  it('union covers AgentType (type-level: all process + all transport = AgentType)', () => {
    // Type-level: ProcessAgent | TransportAgent must equal AgentType
    expectTypeOf<ProcessAgent | TransportAgent>().toEqualTypeOf<AgentType>();
  });
});

// ── detectStatus() with transport agent (graceful fallthrough) ─────────────────

describe('detectStatus() with openclaw agentType', () => {
  it('returns idle for empty lines (default fallthrough)', () => {
    // openclaw has no case in the switch — falls through to default return 'idle'
    const status = detectStatus([], 'openclaw' as AgentType);
    expect(status).toBe('idle');
  });

  it('returns idle for arbitrary lines (no tmux patterns apply)', () => {
    const lines = ['some transport output', 'another line', '{"type":"chat.delta"}'];
    const status = detectStatus(lines, 'openclaw' as AgentType);
    expect(status).toBe('idle');
  });

  it('does not throw for any openclaw input', () => {
    expect(() => detectStatus(['❯'], 'openclaw' as AgentType)).not.toThrow();
    expect(() => detectStatus(['⠋ Thinking'], 'openclaw' as AgentType)).not.toThrow();
    expect(() => detectStatus(['Running Bash('], 'openclaw' as AgentType)).not.toThrow();
  });
});
