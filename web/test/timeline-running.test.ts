import { describe, expect, it } from 'vitest';

import { hasActiveTimelineTurn, isRunningTimelineEvent } from '../src/timeline-running.js';

describe('isRunningTimelineEvent', () => {
  it('treats assistant.thinking as a running signal', () => {
    expect(isRunningTimelineEvent({ type: 'assistant.thinking' } as any)).toBe(true);
  });

  it('keeps tool.call and assistant.text as running signals', () => {
    expect(isRunningTimelineEvent({ type: 'tool.call' } as any)).toBe(true);
    expect(isRunningTimelineEvent({ type: 'assistant.text' } as any)).toBe(true);
  });

  it('treats assistant output after the latest idle as an active turn', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'assistant.text', payload: { text: 'working', streaming: true } },
      { type: 'command.ack', payload: { ok: true } },
    ] as any)).toBe(true);
  });

  it('stops active turn detection at the latest idle state', () => {
    expect(hasActiveTimelineTurn([
      { type: 'assistant.text', payload: { text: 'done', streaming: false } },
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'command.ack', payload: { ok: true } },
    ] as any)).toBe(false);
  });

  it('does not treat terminal non-running session states as active turns', () => {
    expect(hasActiveTimelineTurn([
      { type: 'assistant.text', payload: { text: 'done', streaming: false } },
      { type: 'session.state', payload: { state: 'stopped' } },
    ] as any)).toBe(false);
  });
});
