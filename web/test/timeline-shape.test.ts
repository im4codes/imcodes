import { describe, it, expect } from 'vitest';
import type { TimelineEvent } from '../src/ws-client.js';

function makeEvent(type: TimelineEvent['type'], payload: Record<string, unknown>): TimelineEvent {
  return {
    eventId: 'evt-1',
    sessionId: 'session-a',
    ts: 1,
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  };
}

describe('shared timeline event shape compatibility', () => {
  it('accepts usage.update events consumed by web timeline code', () => {
    const ev = makeEvent('usage.update', {
      inputTokens: 100,
      cacheTokens: 50,
      contextWindow: 400_000,
      model: 'gpt-5.2-codex',
    });

    expect(ev.type).toBe('usage.update');
    expect(ev.payload.inputTokens).toBe(100);
    expect(ev.payload.model).toBe('gpt-5.2-codex');
  });

  it('accepts assistant.text events consumed by reconnect/db logic', () => {
    const ev = makeEvent('assistant.text', { text: 'hello' });
    expect(ev.type).toBe('assistant.text');
    expect(ev.payload.text).toBe('hello');
  });

  it('accepts file.change events consumed by ChatView', () => {
    const ev = makeEvent('file.change', {
      batch: {
        provider: 'claude-code',
        patches: [{ filePath: 'src/app.ts', operation: 'update', confidence: 'exact', beforeText: 'a', afterText: 'b' }],
      },
    });
    expect(ev.type).toBe('file.change');
    expect((ev.payload.batch as any).patches[0].filePath).toBe('src/app.ts');
  });
});
