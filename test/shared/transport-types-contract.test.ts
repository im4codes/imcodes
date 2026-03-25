import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  AGENT_MESSAGE_KINDS,
  AGENT_MESSAGE_STATUSES,
  AGENT_MESSAGE_TERMINAL_STATUSES,
  type AgentMessageKind,
  type AgentMessageStatus,
} from '../../shared/agent-message.js';
import {
  TRANSPORT_EVENT,
  TRANSPORT_MSG,
  TRANSPORT_RELAY_TYPES,
} from '../../shared/transport-events.js';

// ── TRANSPORT_EVENT ────────────────────────────────────────────────────────────

describe('TRANSPORT_EVENT constant', () => {
  it('has all expected keys', () => {
    const expectedKeys = [
      'CHAT_DELTA',
      'CHAT_COMPLETE',
      'CHAT_ERROR',
      'CHAT_STATUS',
      'CHAT_TOOL',
      'CHAT_APPROVAL',
    ];
    for (const key of expectedKeys) {
      expect(TRANSPORT_EVENT).toHaveProperty(key);
    }
  });

  it('has exactly the expected number of keys', () => {
    expect(Object.keys(TRANSPORT_EVENT)).toHaveLength(6);
  });

  it('has no duplicate values', () => {
    const values = Object.values(TRANSPORT_EVENT);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('values are correctly mapped', () => {
    expect(TRANSPORT_EVENT.CHAT_DELTA).toBe('chat.delta');
    expect(TRANSPORT_EVENT.CHAT_COMPLETE).toBe('chat.complete');
    expect(TRANSPORT_EVENT.CHAT_ERROR).toBe('chat.error');
    expect(TRANSPORT_EVENT.CHAT_STATUS).toBe('chat.status');
    expect(TRANSPORT_EVENT.CHAT_TOOL).toBe('chat.tool');
    expect(TRANSPORT_EVENT.CHAT_APPROVAL).toBe('chat.approval');
  });
});

// ── TRANSPORT_MSG ──────────────────────────────────────────────────────────────

describe('TRANSPORT_MSG constant', () => {
  it('has all expected keys', () => {
    const expectedKeys = ['CHAT_SUBSCRIBE', 'CHAT_UNSUBSCRIBE', 'PROVIDER_STATUS'];
    for (const key of expectedKeys) {
      expect(TRANSPORT_MSG).toHaveProperty(key);
    }
  });

  it('has exactly the expected number of keys', () => {
    expect(Object.keys(TRANSPORT_MSG)).toHaveLength(3);
  });

  it('has no duplicate values', () => {
    const values = Object.values(TRANSPORT_MSG);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('values are correctly mapped', () => {
    expect(TRANSPORT_MSG.CHAT_SUBSCRIBE).toBe('chat.subscribe');
    expect(TRANSPORT_MSG.CHAT_UNSUBSCRIBE).toBe('chat.unsubscribe');
    expect(TRANSPORT_MSG.PROVIDER_STATUS).toBe('provider.status');
  });
});

// ── TRANSPORT_RELAY_TYPES ──────────────────────────────────────────────────────

describe('TRANSPORT_RELAY_TYPES set', () => {
  it('contains all TRANSPORT_EVENT values', () => {
    for (const value of Object.values(TRANSPORT_EVENT)) {
      expect(TRANSPORT_RELAY_TYPES.has(value)).toBe(true);
    }
  });

  it('contains PROVIDER_STATUS from TRANSPORT_MSG', () => {
    expect(TRANSPORT_RELAY_TYPES.has(TRANSPORT_MSG.PROVIDER_STATUS)).toBe(true);
  });

  it('does not contain CHAT_SUBSCRIBE or CHAT_UNSUBSCRIBE (browser-only control msgs)', () => {
    expect(TRANSPORT_RELAY_TYPES.has(TRANSPORT_MSG.CHAT_SUBSCRIBE)).toBe(false);
    expect(TRANSPORT_RELAY_TYPES.has(TRANSPORT_MSG.CHAT_UNSUBSCRIBE)).toBe(false);
  });

  it('contains exactly 7 entries (6 events + PROVIDER_STATUS)', () => {
    expect(TRANSPORT_RELAY_TYPES.size).toBe(7);
  });
});

// ── AGENT_MESSAGE_KINDS ────────────────────────────────────────────────────────

describe('AGENT_MESSAGE_KINDS set', () => {
  it('contains all expected kinds', () => {
    const expectedKinds: AgentMessageKind[] = [
      'text',
      'tool_use',
      'tool_result',
      'system',
      'approval',
    ];
    for (const kind of expectedKinds) {
      expect(AGENT_MESSAGE_KINDS.has(kind)).toBe(true);
    }
  });

  it('has exactly 5 entries', () => {
    expect(AGENT_MESSAGE_KINDS.size).toBe(5);
  });

  it('has no duplicates (Set invariant holds)', () => {
    // A Set by definition cannot contain duplicates; verify via array round-trip
    const arr = Array.from(AGENT_MESSAGE_KINDS);
    expect(new Set(arr).size).toBe(arr.length);
  });
});

// ── AGENT_MESSAGE_STATUSES ─────────────────────────────────────────────────────

describe('AGENT_MESSAGE_STATUSES set', () => {
  it('contains all expected statuses', () => {
    const expectedStatuses: AgentMessageStatus[] = ['streaming', 'complete', 'error'];
    for (const status of expectedStatuses) {
      expect(AGENT_MESSAGE_STATUSES.has(status)).toBe(true);
    }
  });

  it('has exactly 3 entries', () => {
    expect(AGENT_MESSAGE_STATUSES.size).toBe(3);
  });

  it('has no duplicate values (Set invariant)', () => {
    const arr = Array.from(AGENT_MESSAGE_STATUSES);
    expect(new Set(arr).size).toBe(arr.length);
  });
});

// ── AGENT_MESSAGE_TERMINAL_STATUSES ───────────────────────────────────────────

describe('AGENT_MESSAGE_TERMINAL_STATUSES set', () => {
  it('contains complete and error', () => {
    expect(AGENT_MESSAGE_TERMINAL_STATUSES.has('complete')).toBe(true);
    expect(AGENT_MESSAGE_TERMINAL_STATUSES.has('error')).toBe(true);
  });

  it('does not contain streaming', () => {
    expect(AGENT_MESSAGE_TERMINAL_STATUSES.has('streaming')).toBe(false);
  });

  it('is a strict subset of AGENT_MESSAGE_STATUSES', () => {
    for (const status of AGENT_MESSAGE_TERMINAL_STATUSES) {
      expect(AGENT_MESSAGE_STATUSES.has(status)).toBe(true);
    }
    expect(AGENT_MESSAGE_TERMINAL_STATUSES.size).toBeLessThan(AGENT_MESSAGE_STATUSES.size);
  });

  it('type-level: AgentMessageStatus is assignable to the terminal status union', () => {
    // 'complete' and 'error' are valid AgentMessageStatus values
    expectTypeOf<'complete'>().toMatchTypeOf<AgentMessageStatus>();
    expectTypeOf<'error'>().toMatchTypeOf<AgentMessageStatus>();
  });
});
