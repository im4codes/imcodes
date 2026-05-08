import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordTurnUsage,
  summarizeTurnUsage,
  resetContextStoreForTests,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

/**
 * Regression for round-2 audit finding A1 (discussion 0699ea64-3e6).
 *
 * Before the fix, every daemon restart re-emitted historical `usage.update`
 * events with deterministic stable eventIds (gemini-watcher's
 * `g:${sessionName}:${msgIdx}:` idPrefix), and the jsonl-watcher's
 * "final usage snapshot" emit had no eventId at all (defaulting to
 * `ts=Date.now()` which differed per restart). Both paths blindly INSERTed
 * into context_turn_usage, inflating SUM(input_tokens) by N× per restart
 * for active sessions.
 *
 * The fix: `(session_name, event_id)` partial UNIQUE index +
 * `INSERT OR IGNORE`. This test pins the contract: passing the same
 * eventId twice MUST collapse to a single row, while distinct eventIds
 * (or null event_id from legacy callers) MUST NOT collide.
 */

describe('recordTurnUsage idempotency by eventId', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('turn-usage-idempotent');
  });
  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('collapses duplicate (session, eventId) into one row', () => {
    const fixedEventId = 'evt-stable-replay-1';
    for (let i = 0; i < 5; i++) {
      recordTurnUsage({
        sessionName: 'deck_my_brain',
        agentType: 'codex-sdk',
        model: 'gpt-5-codex',
        inputTokens: 1000,
        outputTokens: 200,
        eventId: fixedEventId,
      });
    }
    expect(summarizeTurnUsage().total).toBe(1);
    expect(summarizeTurnUsage().byAgentModel[0]).toMatchObject({
      turns: 1,
      inputTokens: 1000,
      outputTokens: 200,
    });
  });

  it('keeps distinct eventIds as separate rows', () => {
    for (let i = 0; i < 5; i++) {
      recordTurnUsage({
        sessionName: 'deck_my_brain',
        agentType: 'codex-sdk',
        model: 'gpt-5-codex',
        inputTokens: 1000,
        outputTokens: 200,
        eventId: `evt-distinct-${i}`,
      });
    }
    expect(summarizeTurnUsage().total).toBe(5);
    expect(summarizeTurnUsage().byAgentModel[0]).toMatchObject({
      turns: 5,
      inputTokens: 5000,
      outputTokens: 1000,
    });
  });

  it('legacy callers with no eventId still record (NULL excluded from UNIQUE)', () => {
    // Simulate two legacy callers that pre-date the eventId migration.
    // Both should land as separate rows because the partial UNIQUE index
    // excludes NULL event_id.
    recordTurnUsage({
      sessionName: 'deck_legacy', model: 'm', inputTokens: 1, outputTokens: 1,
    });
    recordTurnUsage({
      sessionName: 'deck_legacy', model: 'm', inputTokens: 1, outputTokens: 1,
    });
    expect(summarizeTurnUsage().total).toBe(2);
  });

  it('same eventId across DIFFERENT sessions does NOT collide', () => {
    // The UNIQUE index is on (session_name, event_id), not eventId alone.
    // Two sessions can independently use the same id without conflict.
    recordTurnUsage({ sessionName: 'A', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'shared-id' });
    recordTurnUsage({ sessionName: 'B', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'shared-id' });
    expect(summarizeTurnUsage().total).toBe(2);
  });

  it('mixing legacy null-eventId rows with new eventId-keyed rows works', () => {
    recordTurnUsage({ sessionName: 'A', model: 'm', inputTokens: 1, outputTokens: 1 }); // legacy
    recordTurnUsage({ sessionName: 'A', model: 'm', inputTokens: 1, outputTokens: 1 }); // legacy
    recordTurnUsage({ sessionName: 'A', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'evt-1' });
    recordTurnUsage({ sessionName: 'A', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'evt-1' }); // dup
    recordTurnUsage({ sessionName: 'A', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'evt-2' });
    // 2 legacy + 1 (evt-1, dedup'd) + 1 (evt-2) = 4 rows
    expect(summarizeTurnUsage().total).toBe(4);
  });
});
