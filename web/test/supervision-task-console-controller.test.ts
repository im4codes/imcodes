import { beforeEach, describe, expect, it } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  SUPERVISION_CONSOLE_UNAVAILABLE_REASONS,
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  type SupervisionTaskConsoleScope,
  type SupervisionTaskConsoleDelta,
  type SupervisionTaskConsoleSnapshot,
} from '../../shared/supervision-task-console.js';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '../../shared/supervision-config.js';
import {
  SupervisionTaskConsoleController,
  type SupervisionTaskConsoleSocket,
} from '../src/supervision-task-console-controller.js';
import { SUPERVISION_TASK_CONSOLE_PHASE } from '../src/supervision-task-console-reducer.js';
import {
  clearAllSupervisionTaskConsoleCaches,
  type SupervisionTaskConsoleAuthority,
} from '../src/supervision-task-console-cache.js';

const SCOPE: SupervisionTaskConsoleScope = {
  projectName: 'alpha',
  coordinatorSessionName: 'deck_alpha_brain',
};

const AUTHORITY: SupervisionTaskConsoleAuthority = {
  userId: 'user-1',
  serverId: 'server-1',
  ...SCOPE,
};

class FakeSocket implements SupervisionTaskConsoleSocket {
  sent: object[] = [];
  private handlers = new Set<(message: unknown) => void>();
  send(message: object): void { this.sent.push(message); }
  onMessage(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(message: unknown): void { for (const handler of this.handlers) handler(message); }
}

function latest<T extends { type: string }>(socket: FakeSocket, type: string): T {
  const found = [...socket.sent].reverse().find((message) => (message as { type?: unknown }).type === type);
  if (!found) throw new Error(`Missing ${type}`);
  return found as T;
}

function snapshot(subscriptionId: string): SupervisionTaskConsoleSnapshot {
  return {
    type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT,
    subscriptionId,
    scope: SCOPE,
    schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 7,
    lastDurableEventId: 41,
    projectionEpoch: 'epoch-1',
    generatedAt: 100,
    tasks: [{
      taskId: 'task-1', title: 'Task', status: 'implementing', phase: 'active',
      validationState: 'pending', updatedAt: 100, lastEventId: 41,
    }],
    assignments: [],
    pools: [],
  };
}

function emptySnapshot(subscriptionId: string): SupervisionTaskConsoleSnapshot {
  return {
    ...snapshot(subscriptionId),
    projectionVersion: 0,
    lastDurableEventId: null,
    tasks: [],
    assignments: [],
  };
}

function taskDelta(
  subscriptionId: string,
  overrides: Partial<SupervisionTaskConsoleDelta> = {},
): SupervisionTaskConsoleDelta {
  return {
    type: SUPERVISION_TASK_CONSOLE_MSG.DELTA,
    subscriptionId,
    scope: SCOPE,
    schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 8,
    lastDurableEventId: 42,
    projectionEpoch: 'epoch-1',
    eventId: 42,
    op: 'task_upsert',
    task: {
      taskId: 'task-1', title: 'Task', status: 'validated', phase: 'active',
      validationState: 'passed', updatedAt: 200, lastEventId: 42,
    },
    ...overrides,
  } as SupervisionTaskConsoleDelta;
}

describe('SupervisionTaskConsoleController', () => {
  beforeEach(() => clearAllSupervisionTaskConsoleCaches());
  it('does not leave an initially offline console in IDLE/loading', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();

    controller.setConnected(false);

    expect(controller.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
      error: 'transport_disconnected',
    });
    expect(socket.sent).toEqual([]);
  });

  it('subscribes on the authenticated socket, hydrates, and acks the durable cursor', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const subscribe = latest<{ type: string; subscriptionId: string; afterEventId: number | null }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    expect(subscribe.afterEventId).toBeNull();
    socket.emit(snapshot(subscribe.subscriptionId));
    expect(controller.getState().projectionVersion).toBe(7);
    expect(latest<{ type: string; lastDurableEventId: number | null }>(socket, SUPERVISION_TASK_CONSOLE_MSG.ACK).lastDurableEventId).toBe(41);
  });

  it('treats an authoritative empty first snapshot as READY instead of waiting forever', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const subscribe = latest<{ subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);

    socket.emit(emptySnapshot(subscribe.subscriptionId));

    expect(controller.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
      projectionVersion: 0,
      lastDurableEventId: null,
      tasks: {},
    });
  });

  it('surfaces a strictly correlated projection-unavailable response instead of spinning forever', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const subscribe = latest<{ subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);

    socket.emit({
      type: SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE,
      subscriptionId: subscribe.subscriptionId,
      scope: SCOPE,
      reason: SUPERVISION_CONSOLE_UNAVAILABLE_REASONS.PROJECTION_UNAVAILABLE,
      retryable: true,
    });

    expect(controller.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
      error: SUPERVISION_CONSOLE_UNAVAILABLE_REASONS.PROJECTION_UNAVAILABLE,
    });
  });

  it('ignores stale, cross-scope, and non-canonical unavailable frames', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const subscribe = latest<{ subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    const unavailable = {
      type: SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE,
      subscriptionId: subscribe.subscriptionId,
      scope: SCOPE,
      reason: SUPERVISION_CONSOLE_UNAVAILABLE_REASONS.PROJECTION_UNAVAILABLE,
      retryable: true,
    } as const;

    socket.emit({ ...unavailable, subscriptionId: 'stale-subscription' });
    socket.emit({ ...unavailable, scope: { ...SCOPE, projectName: 'other' } });
    socket.emit({ ...unavailable, extra: true });
    socket.emit({ ...unavailable, retryable: false });

    expect(controller.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.SUBSCRIBING,
      subscriptionId: subscribe.subscriptionId,
      error: null,
    });
  });

  it('surfaces daemon/browser disconnects and recovers only after authority reconnects', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const initial = latest<{ subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);

    socket.emit({ type: DAEMON_MSG.DISCONNECTED });
    expect(controller.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
      error: 'daemon_disconnected',
    });

    socket.emit({ type: DAEMON_MSG.RECONNECTED });
    const retry = latest<{ subscriptionId: string; afterEventId: number | null }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    expect(retry.subscriptionId).not.toBe(initial.subscriptionId);
    expect(retry.afterEventId).toBeNull();
    socket.emit(emptySnapshot(retry.subscriptionId));
    expect(controller.getState().phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.READY);

    controller.setConnected(false);
    expect(controller.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
      hasAuthoritativeSnapshot: true,
      error: 'transport_disconnected',
    });
    const sendsBeforeDisconnectedRetry = socket.sent.length;
    socket.emit({ type: DAEMON_MSG.RECONNECTED });
    expect(socket.sent).toHaveLength(sendsBeforeDisconnectedRetry);
  });

  it('uses the latest cursor for browser reconnect and daemon restart catch-up', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const first = latest<{ type: string; subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    socket.emit(snapshot(first.subscriptionId));
    controller.setConnected(false);
    controller.setConnected(true);
    let resumed = latest<{ type: string; subscriptionId: string; afterEventId: number | null; projectionVersion: number }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    expect(resumed).toMatchObject({ afterEventId: 41, projectionVersion: 7 });
    const ackCountBefore = socket.sent.filter((message) => (
      (message as { type?: unknown }).type === SUPERVISION_TASK_CONSOLE_MSG.ACK
    )).length;
    socket.emit(snapshot(resumed.subscriptionId));
    expect(socket.sent.filter((message) => (
      (message as { type?: unknown }).type === SUPERVISION_TASK_CONSOLE_MSG.ACK
    ))).toHaveLength(ackCountBefore + 1);
    socket.emit({ type: DAEMON_MSG.RECONNECTED });
    resumed = latest(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    expect(resumed).toMatchObject({ afterEventId: 41, projectionVersion: 7 });
  });

  it('keeps cached rows ready while a current-cursor reconnect receives the explicit current snapshot', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const first = latest<{ subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    socket.emit(snapshot(first.subscriptionId));
    controller.setConnected(false);
    controller.setConnected(true);
    const resumed = latest<{ subscriptionId: string; afterEventId: number | null }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    expect(resumed.afterEventId).toBe(41);
    expect(controller.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
      syncing: true,
    });
    socket.emit(snapshot(resumed.subscriptionId));
    expect(controller.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
      syncing: false,
    });
    expect(controller.getState().lastDurableEventId).toBe(41);
  });

  it('requests a full snapshot on a gap and ignores a late stale subscription response', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const first = latest<{ type: string; subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    socket.emit(snapshot(first.subscriptionId));
    socket.emit({
      type: SUPERVISION_TASK_CONSOLE_MSG.DELTA,
      subscriptionId: first.subscriptionId,
      scope: SCOPE,
      schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
      statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
      projectionVersion: 9,
      lastDurableEventId: 43,
      projectionEpoch: 'epoch-1',
      eventId: 43,
      op: 'task_remove',
      removedId: 'task-1',
    });
    const resync = latest<{ type: string; subscriptionId: string; afterEventId: number | null; reason: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    expect(resync).toMatchObject({ afterEventId: null, reason: 'version_gap' });
    expect(resync.subscriptionId).not.toBe(first.subscriptionId);
    socket.emit(snapshot(first.subscriptionId));
    expect(controller.getState().projectionVersion).toBe(7);
    expect(controller.getState().subscriptionId).toBe(resync.subscriptionId);
  });

  it('unsubscribes without polling when the console closes', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const subscribe = latest<{ type: string; subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    controller.stop();
    expect(latest<{ type: string; subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE).subscriptionId)
      .toBe(subscribe.subscriptionId);
  });

  it('ignores buffered projection frames after the authenticated socket disconnects', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const subscribe = latest<{ type: string; subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    controller.setConnected(false);
    socket.emit(snapshot(subscribe.subscriptionId));
    expect(controller.getState().projectionVersion).toBe(0);
    expect(controller.getState().phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.ERROR);
    expect(controller.getState().error).toBe('transport_disconnected');
    expect(socket.sent.some((message) => (
      (message as { type?: unknown }).type === SUPERVISION_TASK_CONSOLE_MSG.ACK
    ))).toBe(false);
  });

  it('renders the last authoritative snapshot immediately after an unmount and revalidates in background', () => {
    const firstSocket = new FakeSocket();
    const first = new SupervisionTaskConsoleController(firstSocket, SCOPE, AUTHORITY);
    first.start();
    first.setConnected(true);
    const initial = latest<{ subscriptionId: string }>(firstSocket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    firstSocket.emit(snapshot(initial.subscriptionId));
    expect(first.getState().tasks).toHaveProperty('task-1');
    first.stop();

    const secondSocket = new FakeSocket();
    const second = new SupervisionTaskConsoleController(secondSocket, SCOPE, AUTHORITY);
    expect(second.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
      projectionVersion: 7,
    });
    expect(second.getState().tasks).toHaveProperty('task-1');

    second.start();
    second.setConnected(true);
    const refresh = latest<{ afterEventId: number | null }>(secondSocket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    expect(refresh.afterEventId).toBe(41);
    expect(second.getState().phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.READY);
    second.stop();
  });

  it('isolates cached projections by user, server, project, and coordinator before A to B to A', () => {
    const firstSocket = new FakeSocket();
    const first = new SupervisionTaskConsoleController(firstSocket, SCOPE, AUTHORITY);
    first.start();
    first.setConnected(true);
    firstSocket.emit(snapshot(latest<{ subscriptionId: string }>(firstSocket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE).subscriptionId));
    first.stop();

    const mismatches: SupervisionTaskConsoleAuthority[] = [
      { ...AUTHORITY, userId: 'user-2' },
      { ...AUTHORITY, serverId: 'server-2' },
      { ...AUTHORITY, projectName: 'beta', coordinatorSessionName: 'deck_beta_brain' },
      { ...AUTHORITY, coordinatorSessionName: 'deck_alpha_other_brain' },
    ];
    for (const authority of mismatches) {
      const scope = { projectName: authority.projectName, coordinatorSessionName: authority.coordinatorSessionName };
      const other = new SupervisionTaskConsoleController(new FakeSocket(), scope, authority);
      expect(other.getState()).toMatchObject({
        phase: SUPERVISION_TASK_CONSOLE_PHASE.IDLE,
        hasAuthoritativeSnapshot: false,
        tasks: {},
      });
    }

    const returned = new SupervisionTaskConsoleController(new FakeSocket(), SCOPE, AUTHORITY);
    expect(returned.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
      projectionVersion: 7,
    });
    expect(returned.getState().tasks).toHaveProperty('task-1');
  });

  it('merges a live event into cached state and never lets a slower snapshot roll it back', () => {
    const seedSocket = new FakeSocket();
    const seed = new SupervisionTaskConsoleController(seedSocket, SCOPE, AUTHORITY);
    seed.start();
    seed.setConnected(true);
    seedSocket.emit(snapshot(latest<{ subscriptionId: string }>(seedSocket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE).subscriptionId));
    seed.stop();

    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE, AUTHORITY);
    controller.start();
    controller.setConnected(true);
    const refresh = latest<{ subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    socket.emit(taskDelta(refresh.subscriptionId));
    expect(controller.getState()).toMatchObject({ projectionVersion: 8, syncing: false });
    expect(controller.getState().tasks['task-1']?.status).toBe('validated');

    socket.emit(snapshot(refresh.subscriptionId));
    expect(controller.getState().projectionVersion).toBe(8);
    expect(controller.getState().tasks['task-1']?.status).toBe('validated');
    controller.stop();

    const remounted = new SupervisionTaskConsoleController(new FakeSocket(), SCOPE, AUTHORITY);
    expect(remounted.getState().projectionVersion).toBe(8);
    expect(remounted.getState().tasks['task-1']?.status).toBe('validated');
  });

  it('coalesces repeated reconnect refreshes while one current subscription is in flight', () => {
    const seedSocket = new FakeSocket();
    const seed = new SupervisionTaskConsoleController(seedSocket, SCOPE, AUTHORITY);
    seed.start();
    seed.setConnected(true);
    seedSocket.emit(snapshot(latest<{ subscriptionId: string }>(seedSocket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE).subscriptionId));
    seed.stop();

    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE, AUTHORITY);
    controller.start();
    controller.setConnected(true);
    socket.emit({ type: DAEMON_MSG.RECONNECTED });
    socket.emit({ type: DAEMON_MSG.RECONNECTED });

    expect(socket.sent.filter((message) => (
      (message as { type?: unknown }).type === SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE
    ))).toHaveLength(1);
    expect(controller.getState()).toMatchObject({ phase: SUPERVISION_TASK_CONSOLE_PHASE.READY, syncing: true });
  });

  it('caches an authoritative empty snapshot without confusing it with a missing key', () => {
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE, AUTHORITY);
    controller.start();
    controller.setConnected(true);
    socket.emit(emptySnapshot(latest<{ subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE).subscriptionId));
    controller.stop();

    expect(new SupervisionTaskConsoleController(new FakeSocket(), SCOPE, AUTHORITY).getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
      hasAuthoritativeSnapshot: true,
      tasks: {},
    });
  });

  it('evicts cached authority on an unavailable response and on an authoritative task removal', () => {
    const seedSocket = new FakeSocket();
    const seed = new SupervisionTaskConsoleController(seedSocket, SCOPE, AUTHORITY);
    seed.start();
    seed.setConnected(true);
    seedSocket.emit(snapshot(latest<{ subscriptionId: string }>(seedSocket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE).subscriptionId));
    seed.stop();

    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE, AUTHORITY);
    controller.start();
    controller.setConnected(true);
    const refresh = latest<{ subscriptionId: string }>(socket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    socket.emit({
      type: SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE,
      subscriptionId: refresh.subscriptionId,
      scope: SCOPE,
      reason: SUPERVISION_CONSOLE_UNAVAILABLE_REASONS.PROJECTION_UNAVAILABLE,
      retryable: true,
    });
    expect(controller.getState()).toMatchObject({
      phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR,
      hasAuthoritativeSnapshot: false,
      tasks: {},
    });
    expect(new SupervisionTaskConsoleController(new FakeSocket(), SCOPE, AUTHORITY).getState().hasAuthoritativeSnapshot).toBe(false);

    const removalSocket = new FakeSocket();
    const removal = new SupervisionTaskConsoleController(removalSocket, SCOPE, AUTHORITY);
    removal.start();
    removal.setConnected(true);
    const initial = latest<{ subscriptionId: string }>(removalSocket, SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    removalSocket.emit(snapshot(initial.subscriptionId));
    removalSocket.emit(taskDelta(initial.subscriptionId, { op: 'task_remove', removedId: 'task-1', task: undefined }));
    removal.stop();
    expect(new SupervisionTaskConsoleController(new FakeSocket(), SCOPE, AUTHORITY).getState().tasks).not.toHaveProperty('task-1');
  });
});
