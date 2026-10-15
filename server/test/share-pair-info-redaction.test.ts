import { projectPairScheduling } from '../../shared/task-pair-suspension.js';
/** Covered Pair participants have owner-equivalent access. Viewer redaction
 * and outside-session/server filtering are unchanged. */
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
      cancelReason: BRIEF, checklistAutoTickNotice: BRIEF, futurePrivateNotice: { title: TITLE, model: MODEL, brief: BRIEF },
    },
  },
};
const ordinaryEvent = { type: 'timeline.event', event: { sessionId: SESSION, type: 'assistant.text', ts: 2, payload: { text: 'the model is secret-model-x1 and the title Rotate the production signing key' } } };

const text = (value: unknown) => JSON.stringify(value);

describe.each([['participant'], ['viewer']] as const)('a %s share', (role) => {
  it.each(frames)('gets owner-equivalent %s as a participant; viewers retain redaction', (_type, frame) => {
    const out = filterShareDaemonMessage(frame, socket(role));
    expect(out).not.toBeNull();
    expect(text(out).includes(TITLE)).toBe(role === 'participant');
    expect(text(out).includes(JSON.stringify(BRIEF).slice(1, -1))).toBe(role === 'participant');
    expect(text(out).includes(MODEL)).toBe(role === 'participant');
    expect(text(out).includes('briefRevision')).toBe(role === 'participant');
    expect(text(out)).toContain('task-1');
    expect(text(out)).toContain(JSON.stringify(role === 'participant' ? TITLE : 'task-1'));
    expect(text(out)).toContain('deck_sub_x');
  });

  it('gets the full brief as participant, or a well-formed "no brief" as viewer', () => {
    expect(filterShareDaemonMessage(briefResponse, socket(role))).toEqual(role === 'participant' ? briefResponse : { ...briefResponse, brief: null, briefRevision: null });
  });

  it('keeps full participant event fields, with viewer-only redaction', () => {
    const out = filterShareDaemonMessage(pairEvent, socket(role)) as { event: { payload: Record<string, unknown> } };
    expect(out.event.payload).toMatchObject({ taskId: 'task-1', verb: 'DISPATCH', executor: 'deck_sub_x', executorLabel: 'Exec', round: 1, blocking: ['P0'] });
    expect(out.event.payload.title).toBe(role === 'participant' ? TITLE : undefined);
    if (role === 'participant') expect(out.event).toEqual(pairEvent.event);
    else for (const key of ['executorModel', 'auditorModel', 'executorThinking', 'auditorThinking', 'noticeText', 'blockedNote', 'auditDetails', 'cancelReason', 'checklistAutoTickNotice', 'futurePrivateNotice']) expect(out.event.payload, key).not.toHaveProperty(key);
    expect(filterShareDaemonMessage(ordinaryEvent, socket(role))).toEqual(ordinaryEvent);
  });

  it('applies the same participant/viewer rule to chat history', () => {
    const history = { type: TRANSPORT_MSG.CHAT_HISTORY, sessionId: SESSION, events: [pairEvent.event, ordinaryEvent.event] };
    const out = filterShareDaemonMessage(history, socket(role)) as { events: Array<Record<string, any>> };
    expect(text(out.events[0]).includes(TITLE)).toBe(role === 'participant');
    expect(text(out.events[0]).includes(MODEL)).toBe(role === 'participant');
    if (role === 'participant') expect(out.events[0]).toEqual(pairEvent.event);
    expect(out.events[1]).toEqual(ordinaryEvent.event);
  });
});

describe('everyone else', () => {
  it.each(['participant', 'viewer'] as const)('uses the same role rule through the real bridge relay (%s)', (role) => {
    const relay = (WsBridge.prototype as unknown as { filterShareOutgoingJson(ws: unknown, msg: Record<string, unknown>, json: string): string | null }).filterShareOutgoingJson;
    const ws = {};
    const bridge = { browserShareStates: new Map([[ws, socket(role)]]) };
    for (const frame of [...frames.map(([, msg]) => msg), pairEvent, briefResponse]) {
      const result = relay.call(bridge, ws, frame, text(frame));
      expect(result).not.toBeNull();
      if (role === 'participant') expect(JSON.parse(result!)).toEqual(frame);
      else {
        expect(result).not.toContain(MODEL);
        expect(result).not.toContain(TITLE);
      }
    }
  });

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

describe('task title visibility follows admitted participant coverage, not legacy grants', () => {
  const titleAccess = { brief: { version: 1, serverId, userIds: ['shared-user'] } };
  it.each(frames)('preserves an authorized title on %s, including models/brief, but never obsolete grant identities', (_name, frame) => {
    const input = structuredClone(frame) as any;
    if (input.tasks) input.tasks[0].titleAccess = titleAccess;
    if (input.task) input.task.titleAccess = titleAccess;
    if (input.upserts) input.upserts[0].task.titleAccess = titleAccess;
    const original = structuredClone(input);
    const out = filterShareDaemonMessage(input, socket('participant'));
    expect(text(out)).toContain(TITLE);
    expect(text(out)).toContain(BRIEF.replaceAll('\n', '\\n'));
    expect(text(out)).toContain(MODEL);
    for (const secret of ['titleAccess', 'shared-user']) expect(text(out)).not.toContain(secret);
    expect(input).toEqual(original);
    expect(text(filterShareDaemonMessage(input, socket('viewer')))).not.toContain(TITLE);
    expect(text(filterShareDaemonMessage(input, { ...socket('participant'), userId: 'different-user' }))).toContain(TITLE);
  });
  it('keeps grant identities protected by older servers that drop only known private keys', () => {
    const oldProjection = JSON.stringify({ titleAccess }, (key, value) => key === 'brief' ? undefined : value);
    expect(oldProjection).not.toContain('shared-user');
    expect(oldProjection).not.toContain(serverId);
  });
  it('names every admitted task in the covered Brain console without requiring a backfill', () => {
    const input = { ...frames[0]![1], tasks: [{ ...taskRow, titleAccess }, { ...taskRow, taskId: 'private-task', title: 'Another user private title' }] };
    const out = filterShareDaemonMessage(input, socket('participant'));
    expect(text(out)).toContain(TITLE);
    expect(text(out)).toContain('Another user private title');
  });
  it('applies the same participant access to live and stored events, including free text, not just the former allowlist', () => {
    const event = { ...pairEvent.event, payload: { ...pairEvent.event.payload, titleAccess } };
    const live = filterShareDaemonMessage({ ...pairEvent, event }, socket('participant'));
    const history = filterShareDaemonMessage({ type: TRANSPORT_MSG.CHAT_HISTORY, sessionId: SESSION, events: [event] }, socket('participant'));
    for (const out of [live, history]) {
      expect(text(out)).toContain(TITLE);
      for (const value of [MODEL, 'noticeText', 'auditDetails']) expect(text(out)).toContain(value);
      for (const secret of ['titleAccess', 'shared-user']) expect(text(out)).not.toContain(secret);
    }
  });
  it.each([undefined, { brief: { ...titleAccess.brief, serverId: 'foreign' } }, { brief: { ...titleAccess.brief, version: 99 } }, { brief: { ...titleAccess.brief, userIds: ['other'] } }])('shows legacy participant names even with absent/stale grant %j', (grant) => {
    const input = { ...frames[0]![1], tasks: [{ ...taskRow, titleAccess: grant }] };
    expect(text(filterShareDaemonMessage(input, socket('participant')))).toContain(TITLE);
    expect(text(filterShareDaemonMessage(input, socket('viewer')))).not.toContain(TITLE);
  });
});


describe('suspension details do not widen viewer or old-server visibility', () => {
  const scheduling = projectPairScheduling({ epoch: 1, manual: false, since: now, writer: SESSION, dependsOn: ['private-dependency-id'], note: 'private suspension reason' });
  it.each(frames)('preserves participant details but strips them for viewers (%s)', (_name, frame) => {
    const input = structuredClone(frame) as any;
    const task = input.tasks?.[0] ?? input.task ?? input.upserts?.[0]?.task;
    task.pair.scheduling = scheduling;
    const participant = text(filterShareDaemonMessage(input, socket('participant')));
    const viewer = text(filterShareDaemonMessage(input, socket('viewer')));
    expect(participant).toContain('private-dependency-id'); expect(participant).toContain('private suspension reason');
    expect(viewer).not.toContain('private-dependency-id'); expect(viewer).not.toContain('private suspension reason');
    const oldRedactor = JSON.stringify(input, (key, value) => key === 'brief' ? undefined : value);
    expect(oldRedactor).not.toContain('private-dependency-id'); expect(oldRedactor).not.toContain('private suspension reason');
  });
});
