import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeRuntimes = new Map<string, unknown>();

vi.mock('../../src/agent/session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/session-manager.js')>();
  return {
    ...actual,
    getTransportRuntime: (name: string) => fakeRuntimes.get(name) ?? actual.getTransportRuntime(name),
  };
});

import type { SessionRecord } from '../../src/store/session-store.js';
import { getSession, removeSession, upsertSession } from '../../src/store/session-store.js';
import { supervisionAutomation } from '../../src/daemon/supervision-automation.js';
import { liveSupervisionIdentity } from '../../src/daemon/supervision-participant-delivery.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

/**
 * Semantics of the per-timeline-event implementation-activity projection after
 * it stopped hydrating every task the session ever owned:
 *  - a session with no live implementer assignment does no registry work,
 *  - a live implementer's first event is recorded at once,
 *  - streamed deltas are throttled per session while tool events, final
 *    assistant text and any change of live assignments are never delayed,
 *  - a terminal task is never accounted (the registry refuses it anyway).
 */
const PROJECT = 'actproj';
const BRAIN = 'deck_actproj_brain';
const WORKER = 'deck_sub_actworker';
const LINGERING = 'deck_sub_actlinger';
const T0 = 1_800_000_000_000;

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', runtimeType: 'transport',
    projectDir: `/tmp/${PROJECT}`, state: 'running',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

/** The identity the session store minted for a session (upsert assigns its own instance/epoch ids). */
function liveIdentityOf(name: string) {
  return liveSupervisionIdentity(getSession(name)!)!;
}

function fakeRuntime(name: string) {
  return {
    getDiagnosticSnapshot: () => ({
      activityGeneration: { scope: 'session', sessionName: name, generation: 1 },
      lastProviderOutputAt: 0,
    }),
    activeDispatchEntries: [],
  };
}

let sequence = 0;
function event(sessionId: string, type: TimelineEvent['type'], ts: number, payload: Record<string, unknown>): TimelineEvent {
  sequence += 1;
  return {
    eventId: `evt-${sequence}`, sessionId, ts, epoch: 1, seq: sequence,
    source: 'daemon', confidence: 'high', type, payload,
  } as TimelineEvent;
}

function deliver(e: TimelineEvent): void {
  (supervisionAutomation as unknown as { recordAuthoritativeImplementationActivity(e: TimelineEvent): void })
    .recordAuthoritativeImplementationActivity(e);
}

function seedImplementing(taskId: string, assignmentId: string, sessionName: string, revision: string) {
  const registry = getSupervisionTaskRegistry();
  const identity = liveIdentityOf(sessionName);
  expect(registry.createOrGet({
    taskId, topLevelTaskId: taskId, projectName: PROJECT, classification: 'independent_top_level',
    objective: `work ${taskId}`, currentRevision: revision, now: T0 - 10_000,
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    taskId, assignmentId, role: 'implementer', identity, auditRevision: revision, now: T0 - 9_000,
  })).toMatchObject({ ok: true });
  expect(registry.updateTask({ taskId, status: 'implementing', currentRevision: revision, now: T0 - 8_000 }))
    .toMatchObject({ ok: true });
  expect(registry.updateAssignment({ assignmentId, identity, status: 'implementing', now: T0 - 8_000 }))
    .toMatchObject({ ok: true });
}

describe('implementation activity projection', () => {
  beforeAll(() => {
    resetSupervisionTaskRegistryForTests();
  });
  afterAll(() => {
    resetSupervisionTaskRegistryForTests();
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    for (const [name, role] of [[BRAIN, 'brain'], [WORKER, 'w1'], [LINGERING, 'w2']] as const) {
      upsertSession(session(name, role));
      fakeRuntimes.set(name, fakeRuntime(name));
    }
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const name of [BRAIN, WORKER, LINGERING]) { removeSession(name); fakeRuntimes.delete(name); }
    resetSupervisionTaskRegistryForTests();
  });

  it('does no registry work for a session that owns no live implementer assignment (the Brain, every delta)', () => {
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({
      taskId: 'tsk_actbrain', topLevelTaskId: 'tsk_actbrain', projectName: PROJECT,
      classification: 'independent_top_level', objective: 'brain owns coordinator rows only', now: T0 - 5_000,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId: 'tsk_actbrain', assignmentId: 'asg_actbrain', role: 'coordinator',
      identity: liveIdentityOf(BRAIN), now: T0 - 4_000,
    })).toMatchObject({ ok: true });
    const list = vi.spyOn(registry, 'list');
    const narrow = vi.spyOn(registry, 'listTasksWithActiveImplementerAssignments');
    const record = vi.spyOn(registry, 'recordImplementationRuntimeActivity');
    for (let i = 0; i < 50; i += 1) {
      deliver(event(BRAIN, 'assistant.text', T0 + i, { text: `delta ${i}`, streaming: true }));
      deliver(event(BRAIN, 'tool.call', T0 + i, { tool: 'Read' }));
    }
    expect(list).not.toHaveBeenCalled();
    expect(narrow).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('records a live implementer, throttles streamed deltas per session, and never delays tool events or final text', () => {
    seedImplementing('tsk_actlive', 'asg_actlive', WORKER, 'act-r1');
    const registry = getSupervisionTaskRegistry();
    const record = vi.spyOn(registry, 'recordImplementationRuntimeActivity');
    const cursor = () => registry.getAssignment('asg_actlive')?.implementationActivity;

    // The very first event is recorded at once.
    deliver(event(WORKER, 'assistant.text', T0, { text: 'first', streaming: true }));
    expect(record).toHaveBeenCalledTimes(1);
    expect(cursor()).toMatchObject({ signal: 'provider_assistant_output', observedAt: T0 });

    // Thirty more deltas inside the 2 s window cost nothing.
    for (let i = 1; i <= 30; i += 1) {
      vi.setSystemTime(T0 + i * 60);
      deliver(event(WORKER, 'assistant.text', T0 + i * 60, { text: `d${i}`, streaming: true }));
      deliver(event(WORKER, 'assistant.thinking', T0 + i * 60, { text: `t${i}`, streaming: true }));
    }
    expect(record).toHaveBeenCalledTimes(1);

    // A tool event is substantive: recorded immediately, even inside the window.
    vi.setSystemTime(T0 + 1_950);
    deliver(event(WORKER, 'tool.call', T0 + 1_950, { tool: 'Bash' }));
    expect(record).toHaveBeenCalledTimes(2);
    expect(cursor()).toMatchObject({ signal: 'provider_tool_call', observedAt: T0 + 1_950 });

    // Past the window the next delta refreshes liveness again.
    vi.setSystemTime(T0 + 2_100);
    deliver(event(WORKER, 'assistant.text', T0 + 2_100, { text: 'after window', streaming: true }));
    expect(record).toHaveBeenCalledTimes(3);
    expect(cursor()).toMatchObject({ observedAt: T0 + 2_100 });

    // Final (non-streaming) assistant text is never throttled.
    vi.setSystemTime(T0 + 2_200);
    deliver(event(WORKER, 'assistant.text', T0 + 2_200, { text: 'final answer', streaming: false }));
    expect(record).toHaveBeenCalledTimes(4);
    expect(cursor()).toMatchObject({ observedAt: T0 + 2_200 });
  });

  it('a change of the live assignments restarts the window: the next event is processed, not held for up to 2 s', () => {
    seedImplementing('tsk_actlive2', 'asg_actlive2', WORKER, 'act-r2');
    const registry = getSupervisionTaskRegistry();
    const record = vi.spyOn(registry, 'recordImplementationRuntimeActivity');
    const narrow = vi.spyOn(registry, 'listTasksWithActiveImplementerAssignments');

    deliver(event(WORKER, 'assistant.text', T0, { text: 'a', streaming: true }));
    vi.setSystemTime(T0 + 200);
    deliver(event(WORKER, 'assistant.text', T0 + 200, { text: 'b', streaming: true }));
    expect(narrow).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);

    // A newly delegated assignment for the same worker changes membership.
    expect(registry.createOrGet({
      taskId: 'tsk_actnew', topLevelTaskId: 'tsk_actnew', projectName: PROJECT,
      classification: 'independent_top_level', objective: 'newly delegated', now: T0 + 250,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId: 'tsk_actnew', assignmentId: 'asg_actnew', role: 'implementer',
      identity: liveIdentityOf(WORKER), now: T0 + 260,
    })).toMatchObject({ ok: true });
    vi.setSystemTime(T0 + 300);
    deliver(event(WORKER, 'assistant.text', T0 + 300, { text: 'c', streaming: true }));
    expect(narrow).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('never accounts activity to a terminal task, even for an implementing assignment that lingers under it', () => {
    seedImplementing('tsk_actstale', 'asg_actstale', LINGERING, 'act-r3');
    const registry = getSupervisionTaskRegistry();
    expect(registry.updateTask({ taskId: 'tsk_actstale', status: 'cancelled', now: T0 - 1_000 })).toMatchObject({ ok: true });
    // The assignment lingers as `implementing` (the task ended around it).
    expect(registry.getAssignment('asg_actstale')?.status).toBe('implementing');
    const record = vi.spyOn(registry, 'recordImplementationRuntimeActivity');
    const narrow = vi.spyOn(registry, 'listTasksWithActiveImplementerAssignments');
    deliver(event(LINGERING, 'tool.call', T0, { tool: 'Bash' }));
    deliver(event(LINGERING, 'assistant.text', T0 + 10, { text: 'x', streaming: false }));
    expect(narrow).toHaveBeenCalled();
    expect(narrow.mock.results.every((result) => (result.value as unknown[]).length === 0)).toBe(true);
    expect(record).not.toHaveBeenCalled();
    // The registry would have refused it anyway: excluding it changes nothing.
    expect(registry.recordImplementationRuntimeActivity({
      taskId: 'tsk_actstale', assignmentId: 'asg_actstale',
      identity: liveIdentityOf(LINGERING),
      activityGeneration: { scope: 'session', sessionName: LINGERING, generation: 1 },
      signal: 'provider_tool_call', eventId: 'direct', fingerprint: 'direct-fp', now: T0 + 5_000,
    })).toEqual({ ok: false, reason: 'invalid_transition' });
  });
});
