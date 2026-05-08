import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ordinary send daemon-receipt ack contract', () => {
  it('keeps receipt ack before every post-1.1 memory/provider blocker in handleSend', () => {
    const source = readFileSync('src/daemon/command-handler.ts', 'utf8');
    const start = source.indexOf('async function handleSend');
    const end = source.indexOf('/** Emit command.ack', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handleSend = source.slice(start, end);

    const ackComment = handleSend.indexOf('For ordinary user turns, command.ack is a daemon-receipt acknowledgement');
    const ackCall = handleSend.indexOf('emitAcceptedReceiptAck();', ackComment);
    expect(ackCall).toBeGreaterThan(ackComment);

    for (const blocker of [
      'await waitForPendingSessionRelaunch',
      'getTransportRuntime(sessionName)',
      "await import('../store/session-store.js')",
      'processPreferenceLines({',
      'isPreferenceFeatureEnabled()',
      'schedulePreferencePersistence({',
      'getMutex(sessionName).acquire()',
      'transportRuntime.send(',
      'sendProcessSessionMessage(',
    ]) {
      const blockerIndex = handleSend.indexOf(blocker);
      expect(blockerIndex, blocker).toBeGreaterThan(ackCall);
    }

    // These post-1.1 subsystems must remain outside the ordinary send pre-ack
    // path entirely; if they are introduced later this test forces the author
    // to prove the ack still happens first.
    expect(source).not.toMatch(/from ['"].*(md-ingest|skill-store|skill-review-scheduler|memory-telemetry)['"]/);
  });
});
