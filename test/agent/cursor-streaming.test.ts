import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CursorHeadlessProvider,
  cursorHeadlessRuntimeHooks,
} from '../../src/agent/providers/cursor-headless.js';
import { createCursorHeadlessHarness } from '../cursor-headless-fixture.js';

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('CursorHeadlessProvider streaming accumulator', () => {
  const originalLoadChildProcess = cursorHeadlessRuntimeHooks.loadChildProcess;
  let harness = createCursorHeadlessHarness();

  beforeEach(() => {
    harness = createCursorHeadlessHarness();
    cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
      execFile: harness.execFile,
      spawn: harness.spawn,
    } as typeof import('node:child_process'));
  });

  afterEach(() => {
    cursorHeadlessRuntimeHooks.loadChildProcess = originalLoadChildProcess;
  });

  it('resets the streaming accumulator across messages so a second message is not prefixed with the first', async () => {
    // A single tool-using turn produces TWO assistant messages (m1 → tool →
    // m2), each with its own message_id. The second message's streaming deltas
    // must start fresh — never carrying message 1's full text as a prefix.
    //
    // Regression for the cross-message bleed fixed in cursor-headless.ts: before
    // the fix, currentMessageId/currentText were reset only at turn start, so
    // m2's first delta failed the `chunk.startsWith(state.currentText)` guard
    // (it does not start with m1's "Let me check.") and was concatenated as
    // `currentText + chunk` → "Let me check.The answer", emitted under m1's id.
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sessionId = await provider.createSession({
      sessionKey: 'route-cursor-stream',
      cwd: '/tmp/project',
      resumeId: 'cursor-chat-stream',
    });

    const deltas: Array<{ id: string | undefined; text: string }> = [];
    provider.onDelta((_sid, delta) => deltas.push({ id: delta.messageId, text: delta.delta }));

    await provider.send(sessionId, 'hello');
    const spawned = harness.lastSpawn();
    const write = (record: Record<string, unknown>) => {
      spawned.child.stdout.write(`${JSON.stringify(record)}\n`);
    };

    write({ type: 'system.init', session_id: 'cursor-chat-stream', model: 'gpt-5.2' });
    // ── Message 1 ──
    write({ type: 'assistant.delta', session_id: 'cursor-chat-stream', message_id: 'm1', delta: 'Let me check.' });
    write({ type: 'assistant.final', session_id: 'cursor-chat-stream', message_id: 'm1', text: 'Let me check.' });
    // ── tool round between the two assistant messages ──
    write({ type: 'tool_call.started', session_id: 'cursor-chat-stream', id: 'tool-1', name: 'shell', input: { command: 'date' } });
    write({ type: 'tool_call.completed', session_id: 'cursor-chat-stream', id: 'tool-1', name: 'shell', output: '42' });
    // ── Message 2 (cumulative deltas WITHIN m2) ──
    write({ type: 'assistant.delta', session_id: 'cursor-chat-stream', message_id: 'm2', delta: 'The answer' });
    write({ type: 'assistant.delta', session_id: 'cursor-chat-stream', message_id: 'm2', delta: 'The answer is 42.' });
    write({ type: 'result.success', session_id: 'cursor-chat-stream', result: 'The answer is 42.' });
    spawned.child.emit('close', 0, null);
    await harness.flush();

    // Message 2's deltas must be its OWN text only, never prefixed with m1's text.
    const msg2Deltas = deltas.filter((d) => d.id === 'm2').map((d) => d.text);
    expect(msg2Deltas).toEqual(['The answer', 'The answer is 42.']);
    // No emitted delta should ever concatenate the two messages together.
    expect(deltas.every((d) => !d.text.includes('Let me check.The answer'))).toBe(true);
    // No m2 delta should be prefixed with message 1's text.
    expect(msg2Deltas.every((text) => !text.includes('Let me check.'))).toBe(true);
  });
});
