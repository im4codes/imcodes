import { describe, expect, it } from 'vitest';

import { isRunningTimelineEvent } from '../src/timeline-running.js';

describe('isRunningTimelineEvent', () => {
  it('treats assistant.thinking as a running signal', () => {
    expect(isRunningTimelineEvent({ type: 'assistant.thinking' } as any)).toBe(true);
  });

  it('keeps tool.call and assistant.text as running signals', () => {
    expect(isRunningTimelineEvent({ type: 'tool.call' } as any)).toBe(true);
    expect(isRunningTimelineEvent({ type: 'assistant.text' } as any)).toBe(true);
  });
});
