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

  it('keeps an active turn visible through pending optimistic user messages', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'assistant.text', payload: { text: 'still working', streaming: true } },
      { type: 'user.message', payload: { text: 'queued first', pending: true, commandId: 'cmd-1' } },
      { type: 'command.ack', payload: { ok: true, commandId: 'cmd-1' } },
    ] as any)).toBe(true);
  });

  it('keeps a running transport turn visible through the confirmed user message echo', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'session.state', payload: { state: 'running' } },
      { type: 'user.message', payload: { text: 'sent first', pending: false, commandId: 'cmd-1' } },
      { type: 'command.ack', payload: { ok: true, commandId: 'cmd-1' } },
    ] as any)).toBe(true);
  });

  it('lets a confirmed user message end active-turn inference when no newer running signal exists', () => {
    expect(hasActiveTimelineTurn([
      { type: 'session.state', payload: { state: 'idle' } },
      { type: 'assistant.text', payload: { text: 'old assistant text', streaming: false } },
      { type: 'user.message', payload: { text: 'already confirmed', pending: false, commandId: 'cmd-1' } },
      { type: 'command.ack', payload: { ok: true, commandId: 'cmd-1' } },
    ] as any)).toBe(false);
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
