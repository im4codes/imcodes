import { describe, expect, it } from 'vitest';

import { hasSubstantiveTimelineHistory } from '../../src/daemon/command-handler.js';

describe('command-handler OpenCode history fallback gating', () => {
  it('treats state-only timeline as non-substantive so fallback can run', () => {
    expect(hasSubstantiveTimelineHistory([
      { type: 'session.state' },
      { type: 'command.ack' },
      { type: 'agent.status' },
      { type: 'usage.update' },
    ])).toBe(false);
  });

  it('treats assistant/user/tool events as substantive history', () => {
    expect(hasSubstantiveTimelineHistory([
      { type: 'session.state' },
      { type: 'assistant.thinking' },
    ])).toBe(true);

    expect(hasSubstantiveTimelineHistory([
      { type: 'user.message' },
    ])).toBe(true);

    expect(hasSubstantiveTimelineHistory([
      { type: 'tool.call' },
    ])).toBe(true);
  });
});
