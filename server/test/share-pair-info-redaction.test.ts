/**
 * Owner decision (audit tsk_854675e1e2, Q3c "names are information"): a share -- viewer OR participant -- never receives a pair's title,
 * models or brief text. The pair console frames and `task_pair.event` timeline events reach a share socket through
 * `filterShareDaemonMessage`; the owner's own sockets carry no share state and are never filtered; a user the share does not cover
 * receives nothing at all.
 */
import { describe, expect, it } from 'vitest';
import { filterShareDaemonMessage } from '../src/ws/share-policy.js';
import { WsBridge } from '../src/ws/bridge.js';
import { SUPERVISION_TASK_CONSOLE_MSG } from '../../shared/supervision-task-console.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { TASK_PAIR_TIMELINE_EVENT } from '../../shared/task-pair.js';
import type { EffectiveCoverage, ShareTarget } from '../../shared/tab-sharing.js';

const serverId = 'srv-pair-redaction';
const now = 1_800_000_000_000;
const SESSION = 'deck_proj_brain';
const target: ShareTarget = { kind: 'main', serverId, sessionName: SESSION };
const TITLE = 'Rotate the production signing key';
const BRIEF = '## Goal\nRotate the production signing key before Friday';
const MODEL = 'secret-model-x1';
const scope = { projectName: 'proj', coordinatorSessionName: SESSION };

function socket(role: EffectiveCoverage['effectiveRole'], covered: ShareTarget = target) {
  const snapshot: EffectiveCoverage = {
    target: covered, effectiveRole: role, historyCutoffAt: 0, nextCoverageRecheckAt: null,
    coveringShareIds: ['share-1'], primaryShareId: 'share-1', authorizedAt: now,
  };
  return { userId: 'shared-user', target: covered, connectedAt: now, ticketId: 'ticket-1', snapshot };
}

const taskRow = {
  taskId: 'task-1', title: TITLE, objective: BRIEF, status: 'implementing', phase: 'active', validationState: 'unknown', updatedAt: 1, lastEventId: 1,
  observedModel: MODEL,
  pair: { status: 'working', flags: [], round: 1, blocking: ['P0'], executor: 'deck_sub_x', executorLabel: 'Exec', executorModel: MODEL, executorThinking: 'high', auditorModel: MODEL, auditorThinking: 'high', brief: BRIEF, briefRevision: 'rev-1' },
};
const frames: Array<[string, Record<string, unknown>]> = [
  [SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT, { type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT, scope, subscriptionId: 's', tasks: [taskRow], assignments: [{ assignmentId: 'a', taskId: 'task-1', observedModel: MODEL, observedThinking: 'high', ownerSessionName: 'deck_sub_x' }], pools: [] }],
  [SUPERVISION_TASK_CONSOLE_MSG.DELTA, { type: SUPERVISION_TASK_CONSOLE_MSG.DELTA, scope, subscriptionId: 's', eventId: 2, op: 'task_upsert', task: taskRow }],
  [SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, { type: SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, scope, subscriptionId: 's', pairRevision: 3, upserts: [{ task: taskRow, assignments: [] }] }],
];
const briefResponse = { type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_RESPONSE, scope, subscriptionId: 's', taskId: 'task-1', briefRevision: 'rev-1', brief: BRIEF };
const pairEvent = {
  type: 'timeline.event',
  event: {
    sessionId: SESSION, type: TASK_PAIR_TIMELINE_EVENT, ts: 1,
    payload: {
      taskId: 'task-1', verb: 'DISPATCH', title: TITLE, executor: 'deck_sub_x', executorLabel: 'Exec', executorModel: MODEL, executorThinking: 'high', auditorModel: MODEL, auditorThinking: 'high', round: 1, blocking: ['P0'], flags: [],
      // service.ts projects a participant's turnText into noticeText/auditDetails and its marker note into blockedNote. Those private
      // pair notices can quote titles, models or the assigned brief just like raw marker attrs; dropping only named title fields leaks.
      noticeText: `${TITLE}: ${MODEL}\n${BRIEF}`, blockedNote: BRIEF, auditDetails: { rawText: `${TITLE}: ${MODEL}\n${BRIEF}` },
    },
  },
};
const ordinaryEvent = { type: 'timeline.event', event: { sessionId: SESSION, type: 'assistant.text', ts: 2, payload: { text: 'the model is secret-model-x1 and the title Rotate the production signing key' } } };

const text = (value: unknown) => JSON.stringify(value);

describe.each([['participant'], ['viewer']] as const)('a %s share', (role) => {
  it.each(frames)('gets %s without any pair title, model or brief, and still renders (ids, statuses, labels stay)', (_type, frame) => {
    const out = filterShareDaemonMessage(frame, socket(role));
    expect(out).not.toBeNull();
    expect(text(out)).not.toContain(TITLE);
    expect(text(out)).not.toContain(BRIEF);
    expect(text(out)).not.toContain(MODEL);
    expect(text(out)).not.toContain('briefRevision');
    expect(text(out)).toContain('task-1');
    expect(text(out)).toContain('"title":"task-1"'); // the row keeps a title: its id
    expect(text(out)).toContain('deck_sub_x');
  });

  it('gets the brief reply as a well-formed "no brief", never the text', () => {
    expect(filterShareDaemonMessage(briefResponse, socket(role))).toMatchObject({ taskId: 'task-1', brief: null, briefRevision: null });
  });

  it('gets a task_pair.event without title and models; every other event is untouched', () => {
    const out = filterShareDaemonMessage(pairEvent, socket(role)) as { event: { payload: Record<string, unknown> } };
    expect(out.event.payload).toMatchObject({ taskId: 'task-1', verb: 'DISPATCH', executor: 'deck_sub_x', executorLabel: 'Exec', round: 1, blocking: ['P0'] });
    for (const key of ['title', 'executorModel', 'auditorModel', 'executorThinking', 'auditorThinking', 'noticeText', 'blockedNote', 'auditDetails']) expect(out.event.payload, key).not.toHaveProperty(key);
    expect(filterShareDaemonMessage(ordinaryEvent, socket(role))).toEqual(ordinaryEvent);
  });

  it('gets chat history with its task_pair.event entries redacted and the rest untouched', () => {
    const history = { type: TRANSPORT_MSG.CHAT_HISTORY, sessionId: SESSION, events: [pairEvent.event, ordinaryEvent.event] };
    const out = filterShareDaemonMessage(history, socket(role)) as { events: Array<Record<string, any>> };
    expect(text(out.events[0])).not.toContain(TITLE);
    expect(text(out.events[0])).not.toContain(MODEL);
    expect(out.events[1]).toEqual(ordinaryEvent.event);
  });
});

describe('everyone else', () => {
  it('a user whose share does not cover the session receives none of it', () => {
    const other: ShareTarget = { kind: 'main', serverId, sessionName: 'deck_other_brain' };
    for (const [, frame] of frames) expect(filterShareDaemonMessage(frame, socket('participant', other))).toBeNull();
    expect(filterShareDaemonMessage(briefResponse, socket('viewer', other))).toBeNull();
    expect(filterShareDaemonMessage(pairEvent, socket('participant', other))).toBeNull();
  });

  it.each(['owner', 'group owner', 'assigned executor', 'assigned auditor'])('%s authorized non-participant access is not redacted by the actual bridge choke point', () => {
    // Membership/role authorization is unchanged. Authorized non-share sockets have no browserShareStates entry; exercise the real
    // relay function rather than just matching its source. Assigned-session participant-origin tools are separately tested through MCP.
    const relay = (WsBridge.prototype as unknown as { filterShareOutgoingJson(ws: unknown, msg: Record<string, unknown>, json: string): string | null }).filterShareOutgoingJson;
    const bridge = { browserShareStates: new Map() };
    for (const frame of [...frames.map(([, msg]) => msg), pairEvent, briefResponse]) {
      const original = text(frame);
      expect(relay.call(bridge, {}, frame, original)).toBe(original);
    }
  });

  it('the redaction does not mutate the daemon frame (the owner\'s copy of the same frame stays whole)', () => {
    const frame = structuredClone(frames[0]![1]);
    filterShareDaemonMessage(frame, socket('participant'));
    expect(frame).toEqual(frames[0]![1]);
    expect(text(frame)).toContain(TITLE);
  });
});
