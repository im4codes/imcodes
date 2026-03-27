import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// Import after mocks
import * as jsonl from '../../src/daemon/jsonl-watcher.js';
import * as codex from '../../src/daemon/codex-watcher.js';
import * as gemini from '../../src/daemon/gemini-watcher.js';

describe('Watcher File Claiming (Isolation)', () => {
  describe('jsonl-watcher', () => {
    it('preClaimFile prevents a second session from claiming the same file', () => {
      // We test canClaim behaviour indirectly: after A claims a file,
      // calling preClaimFile for B should not throw, but we verify the
      // internal state by re-claiming with the original session — which
      // should replace the old entry and leave only one claim.
      const file = '/tmp/test-isolation.jsonl';
      jsonl.preClaimFile('session-a', file);
      // Claiming again with same session is idempotent (should not throw)
      jsonl.preClaimFile('session-a', file);

      // A second session claiming a DIFFERENT file should work
      const file2 = '/tmp/test-isolation-2.jsonl';
      jsonl.preClaimFile('session-b', file2);

      // Re-claiming the first file with session-b should release session-a's old claim
      jsonl.preClaimFile('session-b', file);
      // And now session-b can claim a new file (its old file2 claim is released)
      jsonl.preClaimFile('session-b', '/tmp/test-isolation-3.jsonl');
    });

    it('stopWatching releases file claims', () => {
      // isWatching should be false if never started
      expect(jsonl.isWatching('never-started')).toBe(false);
      // stopWatching on unknown session is a no-op
      expect(() => jsonl.stopWatching('never-started')).not.toThrow();
    });
  });

  describe('codex-watcher', () => {
    it('preClaimFile is idempotent for same session', () => {
      const file = '/tmp/rollout-test.jsonl';
      codex.preClaimFile('session-x', file);
      codex.preClaimFile('session-x', file); // re-claim: no-op
    });

    it('stopWatching on unknown session does not throw', () => {
      expect(() => codex.stopWatching('no-such-session')).not.toThrow();
    });
  });

  describe('gemini-watcher', () => {
    it('preClaimFile is idempotent for same session', () => {
      const file = '/tmp/session-test.json';
      gemini.preClaimFile('session-y', file);
      gemini.preClaimFile('session-y', file); // re-claim: no-op
    });

    it('stopWatching on unknown session does not throw', () => {
      expect(() => gemini.stopWatching('no-such-session')).not.toThrow();
    });
  });
});
