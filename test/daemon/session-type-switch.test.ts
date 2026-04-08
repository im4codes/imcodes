import { describe, expect, it } from 'vitest';
import { getCompatibleSessionIds } from '../../src/agent/session-manager.js';

describe('getCompatibleSessionIds', () => {
  it('keeps Claude session ids stable across cli/sdk switches', () => {
    const record = {
      ccSessionId: 'cc-session-123',
      codexSessionId: 'codex-thread-999',
      geminiSessionId: 'gem-1',
      opencodeSessionId: 'oc-1',
    };

    expect(getCompatibleSessionIds(record, 'claude-code')).toEqual({
      ccSessionId: 'cc-session-123',
    });
    expect(getCompatibleSessionIds(record, 'claude-code-sdk')).toEqual({
      ccSessionId: 'cc-session-123',
    });
  });

  it('keeps Codex session ids stable across cli/sdk switches', () => {
    const record = {
      ccSessionId: 'cc-session-123',
      codexSessionId: 'codex-thread-999',
      geminiSessionId: 'gem-1',
      opencodeSessionId: 'oc-1',
    };

    expect(getCompatibleSessionIds(record, 'codex')).toEqual({
      codexSessionId: 'codex-thread-999',
    });
    expect(getCompatibleSessionIds(record, 'codex-sdk')).toEqual({
      codexSessionId: 'codex-thread-999',
    });
  });
});
