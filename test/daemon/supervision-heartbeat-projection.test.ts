import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUPERVISION_HEARTBEAT_KIND,
  SUPERVISION_HEARTBEAT_STATE,
} from '../../shared/supervision-heartbeat.js';
import {
  clearSupervisionHeartbeatProjectionsForTests,
  getSupervisionHeartbeatProjection,
  getSupervisionHeartbeatProjectionForWire,
  setSupervisionHeartbeatProjection,
  setSupervisionHeartbeatProjectionListener,
} from '../../src/daemon/supervision-heartbeat-projection.js';

describe('supervision heartbeat projection', () => {
  beforeEach(() => clearSupervisionHeartbeatProjectionsForTests());

  it('publishes arm, re-arm, needs-input pause and off transitions exactly once each', () => {
    const listener = vi.fn();
    setSupervisionHeartbeatProjectionListener(listener);
    const armed = {
      state: SUPERVISION_HEARTBEAT_STATE.ARMED,
      kind: SUPERVISION_HEARTBEAT_KIND.WAITING,
      nextHeartbeatAt: 11_000,
      updatedAt: 1_000,
    } as const;
    expect(setSupervisionHeartbeatProjection('deck_demo_brain', armed)).toBe(true);
    expect(setSupervisionHeartbeatProjection('deck_demo_brain', { ...armed, updatedAt: 2_000 })).toBe(false);
    expect(setSupervisionHeartbeatProjection('deck_demo_brain', { ...armed, nextHeartbeatAt: 21_000 })).toBe(true);
    expect(setSupervisionHeartbeatProjection('deck_demo_brain', {
      state: SUPERVISION_HEARTBEAT_STATE.PAUSED_NEEDS_INPUT,
      updatedAt: 3_000,
    })).toBe(true);
    expect(setSupervisionHeartbeatProjection('deck_demo_brain', {
      state: SUPERVISION_HEARTBEAT_STATE.OFF,
      updatedAt: 4_000,
    })).toBe(true);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(getSupervisionHeartbeatProjection('deck_demo_brain')).toEqual({
      state: SUPERVISION_HEARTBEAT_STATE.OFF,
      updatedAt: 4_000,
    });
    expect(getSupervisionHeartbeatProjectionForWire('deck_demo_brain', 9_000)).toEqual({
      state: SUPERVISION_HEARTBEAT_STATE.OFF,
      updatedAt: 9_000,
    });
  });

  it('rejects invalid session names and incomplete armed snapshots', () => {
    expect(setSupervisionHeartbeatProjection(' ', {
      state: SUPERVISION_HEARTBEAT_STATE.IDLE,
      updatedAt: 1,
    })).toBe(false);
    expect(setSupervisionHeartbeatProjection('deck_demo_brain', {
      state: SUPERVISION_HEARTBEAT_STATE.ARMED,
      updatedAt: 1,
    } as never)).toBe(false);
  });
});
