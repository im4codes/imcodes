import type { TimelineEvent } from './timeline-event.js';
import type { SessionRecord } from '../store/session-store.js';
import type { P2pRun } from './p2p-orchestrator.js';
import { P2P_TERMINAL_RUN_STATUSES } from '../../shared/p2p-status.js';

const MEMORY_RELEVANT_TEAM_EVENT_TYPES = new Set<TimelineEvent['type']>([
  'user.message',
  'assistant.text',
  'tool.result',
]);

export function isP2pParticipantMemoryNoise(
  event: TimelineEvent,
  session: Pick<SessionRecord, 'name' | 'label'>,
  activeRuns: readonly Pick<P2pRun, 'status' | 'initiatorSession' | 'allTargets' | 'activePhase'>[],
): boolean {
  if (!MEMORY_RELEVANT_TEAM_EVENT_TYPES.has(event.type)) return false;

  // Legacy Team Discussion sessions are created as standalone sub-sessions with
  // display labels like "Discussion: Auditor"; they do not have an initiator
  // session to preserve, so all of their turn content is discussion transcript
  // noise from the memory system's perspective.
  if (typeof session.label === 'string' && session.label.startsWith('Discussion:')) {
    return true;
  }

  const matchingRuns = activeRuns.filter((run) => (
    run.initiatorSession === event.sessionId
    || run.allTargets.some((target) => target.session === event.sessionId)
  ));
  if (matchingRuns.length === 0) return false;

  if (event.type === 'user.message') {
    return matchingRuns.some((run) => !P2P_TERMINAL_RUN_STATUSES.has(run.status));
  }

  return matchingRuns.some((run) => {
    if (P2P_TERMINAL_RUN_STATUSES.has(run.status)) return false;
    if (run.allTargets.some((target) => target.session === event.sessionId)) return true;
    if (run.initiatorSession !== event.sessionId) return false;
    return run.activePhase !== 'summary' && run.activePhase !== 'execution';
  });
}
