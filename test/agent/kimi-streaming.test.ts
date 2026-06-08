import { describe, expect, it } from 'vitest';
import { KimiSdkProvider } from '../../src/agent/providers/kimi-sdk.js';

// Regression lock for the cross-message streaming text-bleed bug class.
//
// SDK providers accumulate streaming text in `state.currentText` and emit the
// CUMULATIVE text as a MessageDelta `{ messageId, delta }`. The downstream relay
// replaces the chat bubble by messageId. If `currentText` is NOT reset when a
// new assistant message (new messageId) begins mid-turn, message 2's deltas
// render prefixed with message 1's full text — visible bleed.
//
// kimi-sdk.ts handleAgentChunk resets `state.currentText = ''` when the
// incoming messageId differs from the current one. This test locks that reset
// so a future edit that removes it fails CI.

function attachRoute(provider: KimiSdkProvider, routeId = 'kimi-route') {
  const acpSessionId = `acp-${routeId}`;
  const state = {
    routeId,
    cwd: '/tmp/project',
    model: 'kimi-k2',
    acpSessionId,
    loaded: true,
    modeApplied: true,
    promptInFlight: true,
    replaying: false,
    cancelled: false,
    currentMessageId: null,
    currentText: '',
    toolCalls: new Map(),
    emittedToolSignatures: new Map(),
    lastStatusSignature: null,
  };
  (provider as any).sessions.set(routeId, state);
  (provider as any).acpToRoute.set(acpSessionId, routeId);
  return { state, acpSessionId };
}

function driveChunk(provider: KimiSdkProvider, acpSessionId: string, messageId: string, text: string) {
  (provider as any).handleSessionUpdate({
    sessionId: acpSessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text },
    },
  });
}

describe('KimiSdkProvider cross-message streaming', () => {
  it('resets the streaming accumulator across messages so a second message is not prefixed with the first', () => {
    const provider = new KimiSdkProvider();
    const { acpSessionId } = attachRoute(provider);

    const deltas: Array<{ id: string; text: string }> = [];
    provider.onDelta((_sid, delta) => deltas.push({ id: delta.messageId, text: delta.delta }));

    // First assistant message in the turn.
    driveChunk(provider, acpSessionId, 'm1', 'Let me check.');
    // ── tool round happens here; the model then continues in a NEW message ──
    driveChunk(provider, acpSessionId, 'm2', 'The answer');
    driveChunk(provider, acpSessionId, 'm2', ' is 42.');

    // Message 1 emitted its own cumulative text.
    const m1Deltas = deltas.filter((d) => d.id === 'm1').map((d) => d.text);
    expect(m1Deltas).toEqual(['Let me check.']);

    // Message 2's deltas must be its OWN text only, never prefixed with m1.
    const m2Deltas = deltas.filter((d) => d.id === 'm2').map((d) => d.text);
    expect(m2Deltas).toEqual(['The answer', 'The answer is 42.']);

    // Guard: no delta should ever contain both messages concatenated (the bleed).
    expect(deltas.every((d) => !d.text.includes('Let me check.The answer'))).toBe(true);
  });
});
