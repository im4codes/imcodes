import { describe, expect, it } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  type SupervisionTaskConsoleScope,
  type SupervisionTaskConsoleSnapshot,
} from '../../shared/supervision-task-console.js';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '../../shared/supervision-config.js';
import {
  SupervisionTaskConsoleController,
  type SupervisionTaskConsoleSocket,
} from '../src/supervision-task-console-controller.js';
import { SUPERVISION_TASK_CONSOLE_PHASE } from '../src/supervision-task-console-reducer.js';

const SCOPE: SupervisionTaskConsoleScope = {
  projectName: 'alpha',
  coordinatorSessionName: 'deck_alpha_brain',
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

describe('SupervisionTaskConsoleController', () => {
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

  it('leaves SUBSCRIBING when a current-cursor reconnect receives the explicit current snapshot', () => {
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
    expect(controller.getState().phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.SUBSCRIBING);
    socket.emit(snapshot(resumed.subscriptionId));
    expect(controller.getState().phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.READY);
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
    expect(controller.getState().phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.SUBSCRIBING);
    expect(socket.sent.some((message) => (
      (message as { type?: unknown }).type === SUPERVISION_TASK_CONSOLE_MSG.ACK
    ))).toBe(false);
  });
});
