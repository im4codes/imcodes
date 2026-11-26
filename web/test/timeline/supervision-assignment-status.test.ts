import { describe, expect, it } from 'vitest';
import { SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT } from '../../../shared/supervision-assignment-start.js';
import {
  deriveLiveAssignmentStatuses,
  liveAssignmentStatusesKey,
  resolveCardAssignmentStatus,
} from '../../src/timeline/supervision-assignment-status.js';
import type { TimelineEvent } from '../../src/ws-client.js';

const statusEvent = (assignmentId: unknown, status: unknown, ts: number): TimelineEvent => ({
  eventId: `status-${String(assignmentId)}-${String(status)}-${ts}`,
  sessionId: 'deck_alpha_brain',
  ts,
  seq: ts,
  epoch: 1,
  source: 'daemon',
  confidence: 'high',
  type: SUPERVISION_ASSIGNMENT_STATUS_TIMELINE_EVENT,
  hidden: true,
  payload: { taskId: 'tsk_1', assignmentId, status },
} as TimelineEvent);

describe('live assignment statuses', () => {
  it('keeps the newest announced status per assignment and ignores everything else', () => {
    const statuses = deriveLiveAssignmentStatuses([
      statusEvent('asg_a', 'implementing', 20),
      statusEvent('asg_a', 'delegated', 10),
      statusEvent('asg_b', 'implementing', 5),
      statusEvent('asg_b', 'validated', 30),
      statusEvent('', 'implementing', 40),
      statusEvent('asg_c', 42, 40),
      { ...statusEvent('asg_d', 'implementing', 50), type: 'assistant.text' } as TimelineEvent,
    ]);
    expect([...statuses]).toEqual([
      ['asg_a', { status: 'implementing', ts: 20 }],
      ['asg_b', { status: 'validated', ts: 30 }],
    ]);
  });

  it('lets an announcement supersede only a card snapshot it is newer than', () => {
    const live = { status: 'implementing', ts: 1_000 };
    // The dispatch card predates the automatic start: it follows the start.
    expect(resolveCardAssignmentStatus({ sentStatus: 'delegated', live, cardTs: 500 })).toBe('implementing');
    // A later card (a rework continuation) carries a fresher snapshot than the
    // old announcement: the stale announcement must not overwrite it.
    expect(resolveCardAssignmentStatus({ sentStatus: 'rework', live, cardTs: 2_000 })).toBe('rework');
    // Without an announcement, or without a card time, only the snapshot is trusted.
    expect(resolveCardAssignmentStatus({ sentStatus: 'delegated', live: undefined, cardTs: 500 })).toBe('delegated');
    expect(resolveCardAssignmentStatus({ sentStatus: 'delegated', live, cardTs: undefined })).toBe('delegated');
  });

  it('produces a content key that is independent of event order', () => {
    const forward = deriveLiveAssignmentStatuses([statusEvent('asg_a', 'implementing', 1), statusEvent('asg_b', 'implementing', 2)]);
    const reversed = deriveLiveAssignmentStatuses([statusEvent('asg_b', 'implementing', 2), statusEvent('asg_a', 'implementing', 1)]);
    expect(liveAssignmentStatusesKey(forward)).toBe(liveAssignmentStatusesKey(reversed));
    expect(liveAssignmentStatusesKey(new Map())).toBe('[]');
  });
});
