import { describe, expect, it } from 'vitest';

import { countSubstantiveTimelineEvents, hasSubstantiveTimelineHistory, getOpenCodeSynthesizedAfterTs } from '../../src/daemon/command-handler.js';

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

  it('scores richer OpenCode synthesized history above partial live timeline', () => {
    expect(countSubstantiveTimelineEvents([
      { type: 'session.state' },
      { type: 'user.message' },
      { type: 'command.ack' },
    ])).toBe(1);

    expect(countSubstantiveTimelineEvents([
      { type: 'user.message' },
      { type: 'assistant.thinking' },
      { type: 'assistant.text' },
    ])).toBe(3);
  });


  it('widens opencode synthesized history afterTs to recover late backfilled assistant messages', () => {
    expect(getOpenCodeSynthesizedAfterTs(undefined)).toBeUndefined();
    expect(getOpenCodeSynthesizedAfterTs(1000)).toBe(0);
    expect(getOpenCodeSynthesizedAfterTs(120000)).toBe(60000);
  });

});
