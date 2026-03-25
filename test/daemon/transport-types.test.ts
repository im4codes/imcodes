/**
 * Tests for shared transport type constants and validation sets.
 *
 * Verifies that all constant objects and runtime validation sets from the
 * shared transport modules contain the expected values.
 */
import { describe, it, expect } from 'vitest';

import {
  AGENT_MESSAGE_KINDS,
  AGENT_MESSAGE_ROLES,
  AGENT_MESSAGE_STATUSES,
  MESSAGE_DELTA_TYPES,
  AGENT_MESSAGE_TERMINAL_STATUSES,
} from '../../shared/agent-message.js';

import {
  TRANSPORT_EVENT,
  TRANSPORT_MSG,
  TRANSPORT_AGENT_STATUSES,
  TRANSPORT_ACTIVE_STATUSES,
  TRANSPORT_RELAY_TYPES,
} from '../../shared/transport-events.js';

import {
  CONNECTION_MODES,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../../src/agent/transport-provider.js';

import { RUNTIME_TYPES } from '../../src/agent/session-runtime.js';

import {
  isTransportAgent,
  isProcessAgent,
  TRANSPORT_AGENTS,
  PROCESS_AGENTS,
} from '../../src/agent/detect.js';

// ── shared/agent-message.ts ──────────────────────────────────────────────────

describe('shared/agent-message', () => {
  it('AGENT_MESSAGE_KINDS contains all 5 kinds', () => {
    const expected = ['text', 'tool_use', 'tool_result', 'system', 'approval'];
    expect(AGENT_MESSAGE_KINDS.size).toBe(5);
    for (const kind of expected) {
      expect(AGENT_MESSAGE_KINDS.has(kind as any)).toBe(true);
    }
  });

  it('AGENT_MESSAGE_ROLES contains user, assistant, system', () => {
    const expected = ['user', 'assistant', 'system'];
    expect(AGENT_MESSAGE_ROLES.size).toBe(3);
    for (const role of expected) {
      expect(AGENT_MESSAGE_ROLES.has(role as any)).toBe(true);
    }
  });

  it('AGENT_MESSAGE_STATUSES contains streaming, complete, error', () => {
    const expected = ['streaming', 'complete', 'error'];
    expect(AGENT_MESSAGE_STATUSES.size).toBe(3);
    for (const status of expected) {
      expect(AGENT_MESSAGE_STATUSES.has(status as any)).toBe(true);
    }
  });

  it('MESSAGE_DELTA_TYPES contains text, tool_use, tool_result', () => {
    const expected = ['text', 'tool_use', 'tool_result'];
    expect(MESSAGE_DELTA_TYPES.size).toBe(3);
    for (const type of expected) {
      expect(MESSAGE_DELTA_TYPES.has(type as any)).toBe(true);
    }
  });

  it('AGENT_MESSAGE_TERMINAL_STATUSES contains complete and error but NOT streaming', () => {
    expect(AGENT_MESSAGE_TERMINAL_STATUSES.has('complete')).toBe(true);
    expect(AGENT_MESSAGE_TERMINAL_STATUSES.has('error')).toBe(true);
    expect(AGENT_MESSAGE_TERMINAL_STATUSES.has('streaming')).toBe(false);
    expect(AGENT_MESSAGE_TERMINAL_STATUSES.size).toBe(2);
  });
});

// ── shared/transport-events.ts ───────────────────────────────────────────────

describe('shared/transport-events', () => {
  it('TRANSPORT_EVENT has correct values for all 6 event types', () => {
    expect(TRANSPORT_EVENT.CHAT_DELTA).toBe('chat.delta');
    expect(TRANSPORT_EVENT.CHAT_COMPLETE).toBe('chat.complete');
    expect(TRANSPORT_EVENT.CHAT_ERROR).toBe('chat.error');
    expect(TRANSPORT_EVENT.CHAT_STATUS).toBe('chat.status');
    expect(TRANSPORT_EVENT.CHAT_TOOL).toBe('chat.tool');
    expect(TRANSPORT_EVENT.CHAT_APPROVAL).toBe('chat.approval');
    expect(Object.keys(TRANSPORT_EVENT)).toHaveLength(6);
  });

  it('TRANSPORT_MSG has correct values for all 3 message types', () => {
    expect(TRANSPORT_MSG.CHAT_SUBSCRIBE).toBe('chat.subscribe');
    expect(TRANSPORT_MSG.CHAT_UNSUBSCRIBE).toBe('chat.unsubscribe');
    expect(TRANSPORT_MSG.PROVIDER_STATUS).toBe('provider.status');
    expect(Object.keys(TRANSPORT_MSG)).toHaveLength(3);
  });

  it('TRANSPORT_AGENT_STATUSES contains all 7 statuses', () => {
    const expected = ['idle', 'streaming', 'thinking', 'tool_running', 'permission', 'error', 'unknown'];
    expect(TRANSPORT_AGENT_STATUSES.size).toBe(7);
    for (const status of expected) {
      expect(TRANSPORT_AGENT_STATUSES.has(status as any)).toBe(true);
    }
  });

  it('TRANSPORT_ACTIVE_STATUSES contains streaming, thinking, tool_running and NOT idle/permission/unknown', () => {
    expect(TRANSPORT_ACTIVE_STATUSES.has('streaming')).toBe(true);
    expect(TRANSPORT_ACTIVE_STATUSES.has('thinking')).toBe(true);
    expect(TRANSPORT_ACTIVE_STATUSES.has('tool_running')).toBe(true);
    expect(TRANSPORT_ACTIVE_STATUSES.has('idle')).toBe(false);
    expect(TRANSPORT_ACTIVE_STATUSES.has('permission')).toBe(false);
    expect(TRANSPORT_ACTIVE_STATUSES.has('unknown')).toBe(false);
    expect(TRANSPORT_ACTIVE_STATUSES.size).toBe(3);
  });

  it('TRANSPORT_RELAY_TYPES contains all event types plus PROVIDER_STATUS', () => {
    // All 6 TRANSPORT_EVENT values
    for (const key of Object.keys(TRANSPORT_EVENT) as (keyof typeof TRANSPORT_EVENT)[]) {
      expect(TRANSPORT_RELAY_TYPES.has(TRANSPORT_EVENT[key])).toBe(true);
    }
    // Plus PROVIDER_STATUS from TRANSPORT_MSG
    expect(TRANSPORT_RELAY_TYPES.has(TRANSPORT_MSG.PROVIDER_STATUS)).toBe(true);
    // Total: 6 events + 1 provider.status = 7
    expect(TRANSPORT_RELAY_TYPES.size).toBe(7);
  });
});

// ── src/agent/transport-provider.ts ──────────────────────────────────────────

describe('src/agent/transport-provider', () => {
  it('CONNECTION_MODES has persistent, per-request, local-sdk', () => {
    expect(CONNECTION_MODES.PERSISTENT).toBe('persistent');
    expect(CONNECTION_MODES.PER_REQUEST).toBe('per-request');
    expect(CONNECTION_MODES.LOCAL_SDK).toBe('local-sdk');
    expect(Object.keys(CONNECTION_MODES)).toHaveLength(3);
  });

  it('SESSION_OWNERSHIP has provider, local, shared', () => {
    expect(SESSION_OWNERSHIP.PROVIDER).toBe('provider');
    expect(SESSION_OWNERSHIP.LOCAL).toBe('local');
    expect(SESSION_OWNERSHIP.SHARED).toBe('shared');
    expect(Object.keys(SESSION_OWNERSHIP)).toHaveLength(3);
  });

  it('PROVIDER_ERROR_CODES has all 6 codes', () => {
    expect(PROVIDER_ERROR_CODES.AUTH_FAILED).toBe('AUTH_FAILED');
    expect(PROVIDER_ERROR_CODES.CONFIG_ERROR).toBe('CONFIG_ERROR');
    expect(PROVIDER_ERROR_CODES.CONNECTION_LOST).toBe('CONNECTION_LOST');
    expect(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND');
    expect(PROVIDER_ERROR_CODES.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(PROVIDER_ERROR_CODES.PROVIDER_ERROR).toBe('PROVIDER_ERROR');
    expect(Object.keys(PROVIDER_ERROR_CODES)).toHaveLength(6);
  });
});

// ── src/agent/session-runtime.ts ─────────────────────────────────────────────

describe('src/agent/session-runtime', () => {
  it('RUNTIME_TYPES has process and transport', () => {
    expect(RUNTIME_TYPES.PROCESS).toBe('process');
    expect(RUNTIME_TYPES.TRANSPORT).toBe('transport');
    expect(Object.keys(RUNTIME_TYPES)).toHaveLength(2);
  });
});

// ── src/agent/detect.ts ──────────────────────────────────────────────────────

describe('src/agent/detect — transport/process classification', () => {
  it('isTransportAgent returns true for openclaw', () => {
    expect(isTransportAgent('openclaw')).toBe(true);
  });

  it('isTransportAgent returns false for claude-code', () => {
    expect(isTransportAgent('claude-code')).toBe(false);
  });

  it('isProcessAgent returns true for claude-code', () => {
    expect(isProcessAgent('claude-code')).toBe(true);
  });

  it('isProcessAgent returns false for openclaw', () => {
    expect(isProcessAgent('openclaw')).toBe(false);
  });

  it('TRANSPORT_AGENTS contains openclaw', () => {
    expect(TRANSPORT_AGENTS.has('openclaw')).toBe(true);
  });

  it('PROCESS_AGENTS contains all process agent types', () => {
    const expected = ['claude-code', 'codex', 'opencode', 'shell', 'script', 'gemini'];
    expect(PROCESS_AGENTS.size).toBe(6);
    for (const agent of expected) {
      expect(PROCESS_AGENTS.has(agent as any)).toBe(true);
    }
  });

  it('TRANSPORT_AGENTS and PROCESS_AGENTS are disjoint', () => {
    for (const agent of TRANSPORT_AGENTS) {
      expect(PROCESS_AGENTS.has(agent as any)).toBe(false);
    }
    for (const agent of PROCESS_AGENTS) {
      expect(TRANSPORT_AGENTS.has(agent as any)).toBe(false);
    }
  });
});
