import { describe, expect, it } from 'vitest';
import { isP2pParticipantMemoryNoise } from '../../src/daemon/p2p-memory-filter.js';
import type { P2pRun } from '../../src/daemon/p2p-orchestrator.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

describe('p2p memory filter', () => {
  const run = {
    status: 'running',
    initiatorSession: 'deck_repo_brain',
    activePhase: 'initial',
    allTargets: [
      { session: 'deck_repo_w1', mode: 'audit' },
      { session: 'deck_repo_w2', mode: 'review' },
    ],
  } satisfies Pick<P2pRun, 'status' | 'initiatorSession' | 'activePhase' | 'allTargets'>;

  it('filters active P2P participants and initiator initial-analysis turns', () => {
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_w1', 'assistant.text'),
      { name: 'deck_repo_w1' },
      [run],
    )).toBe(true);
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_w1', 'user.message'),
      { name: 'deck_repo_w1' },
      [run],
    )).toBe(true);
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_brain', 'assistant.text'),
      { name: 'deck_repo_brain' },
      [run],
    )).toBe(true);
  });

  it('allows only initiator summary and final execution assistant output', () => {
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_brain', 'assistant.text'),
      { name: 'deck_repo_brain' },
      [{ ...run, activePhase: 'summary' }],
    )).toBe(false);
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_brain', 'assistant.text'),
      { name: 'deck_repo_brain' },
      [{ ...run, activePhase: 'execution' }],
    )).toBe(false);
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_w1', 'assistant.text'),
      { name: 'deck_repo_w1' },
      [{ ...run, activePhase: 'summary' }],
    )).toBe(true);
  });

  it('filters P2P prompt user messages even during summary and execution phases', () => {
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_brain', 'user.message'),
      { name: 'deck_repo_brain' },
      [{ ...run, activePhase: 'summary' }],
    )).toBe(true);
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_brain', 'user.message'),
      { name: 'deck_repo_brain' },
      [{ ...run, activePhase: 'execution' }],
    )).toBe(true);
  });

  it('does not filter terminal P2P runs or non-memory event types', () => {
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_w1', 'assistant.text'),
      { name: 'deck_repo_w1' },
      [{ ...run, status: 'completed' }],
    )).toBe(false);
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_repo_w1', 'session.state'),
      { name: 'deck_repo_w1' },
      [run],
    )).toBe(false);
  });

  it('filters legacy standalone Team Discussion participant sessions by label', () => {
    expect(isP2pParticipantMemoryNoise(
      makeEvent('deck_sub_discuss_abc_0', 'assistant.text'),
      { name: 'deck_sub_discuss_abc_0', label: 'Discussion: Auditor' },
      [],
    )).toBe(true);
  });
});

function makeEvent(sessionId: string, type: TimelineEvent['type']): TimelineEvent {
  return {
    eventId: `${sessionId}:${type}`,
    sessionId,
    type,
    payload: { text: 'content' },
    ts: 1,
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
  };
}
