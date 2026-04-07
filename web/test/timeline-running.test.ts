import { describe, expect, it } from 'vitest';
import { isIdleSessionStateTimelineEvent, isRunningTimelineEvent } from '../src/timeline-running.js';

describe('timeline session activity helpers', () => {
  it('treats assistant and tool events as running signals', () => {
    expect(isRunningTimelineEvent({ type: 'assistant.text' } as any)).toBe(true);
    expect(isRunningTimelineEvent({ type: 'tool.call' } as any)).toBe(true);
    expect(isRunningTimelineEvent({ type: 'tool.result' } as any)).toBe(true);
    expect(isRunningTimelineEvent({ type: 'assistant.thinking' } as any)).toBe(false);
  });

  it('treats realtime session.state idle as an idle flash signal', () => {
    expect(isIdleSessionStateTimelineEvent({
      type: 'session.state',
      payload: { state: 'idle' },
    } as any)).toBe(true);
    expect(isIdleSessionStateTimelineEvent({
      type: 'session.state',
      payload: { state: 'running' },
    } as any)).toBe(false);
    expect(isIdleSessionStateTimelineEvent({
      type: 'assistant.text',
      payload: { text: 'done' },
    } as any)).toBe(false);
  });
});
